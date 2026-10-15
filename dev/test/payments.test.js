import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './helpers.js'
import {lightningAddress, MAX_SOURCES} from '../src/logic.js'

test('preview creates fixed invoices without moving funds and retains fractional sats', () => {
  const f = fixture(),
    p = f.plan({leaveSat: 10})
  assert.equal(p.totalSat, 130)
  assert.equal(p.sources[0].retainedMsat, 10_500)
  assert.equal(f.payments.length, 0)
  assert.equal(f.invoices.size, 2)
  assert.equal('invoice' in p.sources[0], false)
  assert.equal(p.sources[0].status, 'ready')
})

test('retained amount, source eligibility, and supported precision are validated', () => {
  const f = fixture()
  for (const leaveSat of [-1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() =>
      f.sweep.createQuote({
        sourceId: 'source_a',
        destinationId: 'destination',
        leaveSat
      })
    )
  f.wallets.get('source_a').canSendPayments = false
  const quote = f.sweep.createQuote({
    sourceId: 'source_a',
    destinationId: 'destination'
  })
  assert.equal(quote.amountSat, 0)
  assert.equal(quote.retainedMsat, 100_500)
  assert.ok(quote.skippedReason)
  f.wallets.get('source_a').balanceMsat = Number.MAX_SAFE_INTEGER + 1
  assert.throws(
    () =>
      f.sweep.createQuote({sourceId: 'source_a', destinationId: 'destination'}),
    /precision/
  )
})

test('cannot select the destination as a source or use another account wallet', () => {
  const f = fixture()
  assert.throws(
    () =>
      f.sweep.createQuote({sourceId: 'source_a', destinationId: 'source_a'}),
    /destination/
  )
  assert.throws(() =>
    f.sweep.createQuote({sourceId: 'foreign', destinationId: 'destination'})
  )
  assert.throws(() =>
    f.sweep.createQuote({sourceId: 'source_a', destinationId: 'foreign'})
  )
  assert.equal(f.invoices.size, 0)
})

test('private plans, quotes, history and receipts remain scoped to the owner', () => {
  const f = fixture(),
    p = f.plan()
  f.owner('bob')
  assert.throws(() => f.sweep.getPlan({planId: p.id}), /not found/)
  assert.throws(
    () =>
      f.sweep.consolidate({planId: p.id, sourceId: 'source_a', confirm: true}),
    /not found/
  )
  assert.equal(f.sweep.getHistory({}).total, 0)
  assert.equal(f.payments.length, 0)
})

test('duplicate, oversized and expired quote selections cannot become a plan', () => {
  const f = fixture(),
    q = f.sweep.createQuote({
      sourceId: 'source_a',
      destinationId: 'destination'
    })
  assert.throws(() => f.sweep.createPlan({quoteIds: [q.id, q.id]}), /twice/)
  assert.throws(
    () => f.sweep.createPlan({quoteIds: Array(MAX_SOURCES + 1).fill(q.id)}),
    /Select/
  )
  f.advance(901)
  assert.throws(() => f.sweep.createPlan({quoteIds: [q.id]}), /expired/)
})

test('both phases require literal true and reject an arbitrary source', () => {
  const f = fixture(),
    p = f.plan({address: 'me@example.com'})
  for (const confirm of [false, undefined, 'true', 1])
    assert.throws(
      () => f.sweep.consolidate({planId: p.id, sourceId: 'source_a', confirm}),
      /confirmation/
    )
  assert.throws(
    () =>
      f.sweep.consolidate({planId: p.id, sourceId: 'foreign', confirm: true}),
    /belong/
  )
  assert.equal(f.payments.length, 0)
})

test('internal transfers use their stored invoices and repeated calls do not send again', () => {
  const f = fixture(),
    p = f.plan({leaveSat: 10})
  const done = f.consolidate(p)
  assert.equal(done.movedSat, 130)
  assert.ok(done.sources.every(s => s.status === 'success'))
  assert.equal(f.wallets.get('source_a').balanceMsat, 10_500)
  f.consolidate(p)
  assert.equal(f.payments.length, 2)
  assert.equal(f.payments[0].extra.sweep_id, p.id)
  assert.equal(f.payments[0].extra.phase, 'internal')
  assert.equal(f.payments[0].maxSat, 90)
})

test('individual failures allow other transfers and external sending requires partial acknowledgement', () => {
  const f = fixture(),
    p = f.plan({address: 'me@example.com'})
  f.failures.set('source_a', 'failed')
  const done = f.consolidate(p)
  assert.equal(done.partial, true)
  assert.equal(done.movedSat, 50)
  assert.equal(done.sources[0].status, 'failed')
  assert.equal(done.sources[1].status, 'success')
  const prepared = f.sweep.preparePayout({planId: p.id})
  const request = {
    planId: p.id,
    payoutId: prepared.payout.id,
    address: p.address,
    confirm: true
  }
  assert.throws(() => f.sweep.sendPayout(request), /Acknowledge/)
  assert.equal(
    f.sweep.sendPayout({...request, confirmPartial: true}).payout.status,
    'success'
  )
})

test('a changed balance preserves the requested retained amount before fees', () => {
  const f = fixture(),
    p = f.plan({leaveSat: 10})
  f.wallets.get('source_a').balanceMsat = 95_000
  const done = f.consolidate(p)
  assert.equal(done.sources[0].status, 'failed')
  assert.equal(f.wallets.get('source_a').balanceMsat, 95_000)
  assert.equal(f.payments.length, 1)
})

for (const failure of ['pending', 'throw'])
  test(`${failure} outcome blocks external sending and automatic retries`, () => {
    const f = fixture(),
      p = f.plan({address: 'me@example.com'})
    f.failures.set('source_a', failure)
    const done = f.consolidate(p)
    assert.equal(done.sources[0].status, 'uncertain')
    assert.throws(() => f.sweep.preparePayout({planId: p.id}), /uncertain/)
    const count = f.payments.length
    f.consolidate(p)
    assert.equal(f.payments.length, count)
  })

test('a storage failure before recording intent cannot initiate a payment', () => {
  const f = fixture(),
    p = f.plan()
  f.host.storage.set = () => {
    throw new Error('database unavailable')
  }
  assert.throws(() =>
    f.sweep.consolidate({planId: p.id, sourceId: 'source_a', confirm: true})
  )
  assert.equal(f.payments.length, 0)
})

test('a lost receipt after settlement remains uncertain and is never retried', () => {
  const f = fixture(),
    p = f.plan()
  const write = f.host.storage.set
  f.host.storage.set = (table, row) => {
    if (
      table === 'receipts' &&
      JSON.parse(row.data_json).status !== 'uncertain'
    )
      throw new Error('storage lost after debit')
    write(table, row)
  }
  const result = f.sweep.consolidate({
    planId: p.id,
    sourceId: 'source_a',
    confirm: true
  })
  assert.equal(result.sources[0].status, 'uncertain')
  f.sweep.consolidate({planId: p.id, sourceId: 'source_a', confirm: true})
  assert.equal(f.payments.length, 1)
})

test('an independent failed receipt cannot overwrite a successful receipt', () => {
  const f = fixture(),
    p = f.plan()
  f.consolidate(p)
  f.host.storage.set('receipts', {
    id: 'late_failure',
    plan_id: p.id,
    step: 'source:source_a',
    created_at: 0,
    data_json: JSON.stringify({status: 'failed', error: 'late duplicate'})
  })
  assert.equal(f.sweep.getPlan({planId: p.id}).sources[0].status, 'success')
})

test('external preparation reserves fees, limits invoice amount to moved funds, and does not pay', () => {
  const f = fixture(),
    p = f.plan({address: 'me@example.com'})
  assert.throws(() => f.sweep.preparePayout({planId: p.id}), /Finish/)
  f.consolidate(p)
  const result = f.sweep.preparePayout({planId: p.id, extraReserveSat: 5})
  assert.equal(result.payout.amountSat, 143)
  assert.equal(result.payout.feeReserveSat, 7)
  assert.equal(result.payout.destinationBalanceMsat, 1_150_000)
  assert.equal(f.payments.length, 2)
  const count = f.invoices.size
  const again = f.sweep.preparePayout({planId: p.id, extraReserveSat: 99})
  assert.equal(again.payout.id, result.payout.id)
  assert.equal(again.payout.amountSat, 143)
  assert.equal(f.invoices.size, count)
})

test('external confirmation binds the address and fixed invoice, and is not chained from consolidation', () => {
  const f = fixture(),
    p = f.plan({address: 'me@EXAMPLE.com'})
  f.consolidate(p)
  assert.equal(f.payments.length, 2)
  const prepared = f.sweep.preparePayout({planId: p.id})
  const request = {
    planId: p.id,
    payoutId: prepared.payout.id,
    address: 'me@example.com',
    confirm: true
  }
  assert.throws(
    () => f.sweep.sendPayout({...request, confirm: 'true'}),
    /confirmation/
  )
  assert.throws(
    () => f.sweep.sendPayout({...request, address: 'attacker@example.com'}),
    /Re-enter/
  )
  assert.throws(
    () => f.sweep.sendPayout({...request, payoutId: 'other'}),
    /belong/
  )
  const result = f.sweep.sendPayout(request)
  assert.equal(result.payout.status, 'success')
  f.sweep.sendPayout(request)
  assert.equal(f.payments.length, 3)
  assert.equal(f.payments[2].paymentRequest.startsWith('external_'), true)
  assert.equal(f.payments[2].extra.lightning_address, p.address)
})

test('insufficient reserve, receiver limits and changed destination balance fail without sending', () => {
  const f = fixture(),
    p = f.plan({address: 'me@example.com'})
  f.consolidate(p)
  assert.throws(() =>
    f.sweep.preparePayout({planId: p.id, extraReserveSat: 149})
  )
  f.host.wallets.resolve = () => ({
    minSendableMsat: 1_000_000,
    maxSendableMsat: 9_000_000
  })
  assert.throws(() => f.sweep.preparePayout({planId: p.id}), /limits/)
  f.host.wallets.resolve = () => ({
    minSendableMsat: 1000,
    maxSendableMsat: 9_000_000
  })
  const prepared = f.sweep.preparePayout({planId: p.id})
  f.wallets.get('destination').balanceMsat = 10_000
  assert.throws(
    () =>
      f.sweep.sendPayout({
        planId: p.id,
        payoutId: prepared.payout.id,
        address: p.address,
        confirm: true
      }),
    /balance/
  )
  assert.equal(f.payments.length, 2)
})

test('expired plans and external invoices cannot initiate payments or be silently replaced', () => {
  const f = fixture(),
    p = f.plan({address: 'me@example.com'})
  f.advance(901)
  assert.throws(
    () =>
      f.sweep.consolidate({planId: p.id, sourceId: 'source_a', confirm: true}),
    /expired/
  )
  const g = fixture(),
    other = g.plan({address: 'me@example.com'})
  g.consolidate(other)
  const prepared = g.sweep.preparePayout({planId: other.id})
  g.advance(301)
  assert.throws(
    () =>
      g.sweep.sendPayout({
        planId: other.id,
        payoutId: prepared.payout.id,
        address: other.address,
        confirm: true
      }),
    /expired/
  )
  assert.equal(
    g.sweep.preparePayout({planId: other.id}).payout.id,
    prepared.payout.id
  )
  assert.equal(g.payments.length, 2)
})

test('concurrent external invoice preparation fails closed', () => {
  const f = fixture(),
    p = f.plan({address: 'me@example.com'})
  f.consolidate(p)
  const prepared = f.sweep.preparePayout({planId: p.id})
  const row = f.host.storage.get('payouts', prepared.payout.id)
  f.host.storage.set('payouts', {
    ...row,
    id: 'concurrent_ticket',
    data_json: JSON.stringify({
      ...JSON.parse(row.data_json),
      id: 'concurrent_ticket'
    })
  })
  assert.throws(
    () =>
      f.sweep.sendPayout({
        planId: p.id,
        payoutId: prepared.payout.id,
        address: p.address,
        confirm: true
      }),
    /Concurrent/
  )
  assert.equal(f.payments.length, 2)
})

test('Lightning Addresses reject URLs, credentials, control characters and malformed hosts', () => {
  assert.equal(lightningAddress(' Name@EXAMPLE.com '), 'Name@example.com')
  for (const value of [
    '',
    null,
    'https://example.com',
    'me@localhost',
    'me@-example.com',
    'me@example..com',
    'me@example.com/path',
    'me@user:pass@example.com',
    'me\n@example.com'
  ])
    assert.throws(() => lightningAddress(value))
})

test('history accepts numeric query strings while rejecting malformed offsets', () => {
  const f = fixture()
  f.plan()
  assert.equal(f.sweep.getHistory({offset: '0'}).plans.length, 1)
  assert.equal(f.sweep.getHistory({offset: '20'}).plans.length, 0)
  for (const offset of ['-1', '1.5', '1e2', 'true', ''])
    assert.throws(() => f.sweep.getHistory({offset}))
})

test('a single sat can be consolidated internally without a routing reserve', () => {
  const f = fixture()
  f.wallets.get('source_a').balanceMsat = 1500
  const quote = f.sweep.createQuote({
    sourceId: 'source_a',
    destinationId: 'destination'
  })
  assert.equal(quote.amountSat, 1)
  const plan = f.sweep.createPlan({quoteIds: [quote.id]})
  const result = f.consolidate(plan)
  assert.equal(result.movedSat, 1)
  assert.equal(f.wallets.get('source_a').balanceMsat, 500)
})
