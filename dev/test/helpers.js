import {createWalletSweep} from '../src/logic.js'

export function fixture() {
  const tables = new Map()
  let sequence = 0
  let clock = 1_800_000_000
  let owner = 'alice'
  const payments = [],
    invoices = new Map(),
    failures = new Map()
  const wallets = new Map([
    [
      'source_a',
      {id: 'source_a', owner: 'alice', name: 'Shop', balanceMsat: 100_500}
    ],
    [
      'source_b',
      {id: 'source_b', owner: 'alice', name: 'Tips', balanceMsat: 50_000}
    ],
    [
      'destination',
      {
        id: 'destination',
        owner: 'alice',
        name: 'Savings',
        balanceMsat: 1_000_000
      }
    ],
    [
      'foreign',
      {id: 'foreign', owner: 'bob', name: 'Private', balanceMsat: 9_000_000}
    ]
  ])
  function wallet(id) {
    const value = wallets.get(id)
    if (!value || value.owner !== owner)
      throw new Error('Not your wallet. secret-backend-value')
    return value
  }
  const host = {
    storage: {
      get(table, id) {
        const row = tables.get(`${table}:${id}`)
        return row?.owner === owner ? structuredClone(row.value) : null
      },
      set(table, value) {
        const key = `${table}:${value.id}`
        if (tables.has(key) && tables.get(key).owner !== owner)
          throw new Error('Owner collision')
        tables.set(key, {owner, value: structuredClone(value)})
      },
      list(table, filters = {}, options = {}) {
        let rows = [...tables]
          .filter(
            ([key, row]) => key.startsWith(`${table}:`) && row.owner === owner
          )
          .map(([, row]) => structuredClone(row.value))
          .filter(row =>
            Object.entries(filters).every(([key, value]) => row[key] === value)
          )
        if (options.sortBy)
          rows.sort(
            (a, b) =>
              (a[options.sortBy] - b[options.sortBy]) *
              (options.descending ? -1 : 1)
          )
        return {
          total: rows.length,
          rows: rows.slice(
            options.offset || 0,
            (options.offset || 0) + (options.limit || 100)
          )
        }
      }
    },
    wallets: {
      list() {
        return [...wallets.values()]
          .filter(w => w.owner === owner)
          .map(w => ({id: w.id, name: w.name}))
      },
      balance(id) {
        const value = wallet(id)
        return {
          ...value,
          walletId: id,
          canSendPayments: value.canSendPayments !== false,
          feeReserveMsat: 2000,
          withdrawableMsat: Math.max(0, value.balanceMsat - 2000)
        }
      },
      createInvoice(request) {
        wallet(request.walletId)
        const id = `invoice_${++sequence}`
        invoices.set(id, {walletId: request.walletId, amount: request.amount})
        return {paymentRequest: id, paymentHash: id.padEnd(64, 'a')}
      },
      payInvoice(request) {
        const from = wallet(request.walletId)
        const invoice = invoices.get(request.paymentRequest)
        if (!invoice) throw new Error('Unknown invoice')
        if (invoice.paid) return {ok: false, error: 'Invoice already paid.'}
        if (failures.get(from.id) === 'failed')
          return {ok: false, error: 'Insufficient balance.'}
        if (failures.get(from.id) === 'pending')
          return {ok: true, pending: true, success: false}
        payments.push(structuredClone(request))
        from.balanceMsat -= invoice.amount * 1000
        if (invoice.walletId)
          wallets.get(invoice.walletId).balanceMsat += invoice.amount * 1000
        invoice.paid = true
        if (failures.get(from.id) === 'throw')
          throw new Error('Connection lost after payment')
        return {
          ok: true,
          success: true,
          pending: false,
          amountMsat: invoice.amount * 1000,
          feeMsat: 0,
          paymentHash: request.paymentRequest.padEnd(64, 'a'),
          checkingId: 'checking'
        }
      },
      resolve() {
        return {minSendableMsat: 1000, maxSendableMsat: 1_000_000_000}
      },
      fetchLnurl(request) {
        const id = `external_${++sequence}`
        invoices.set(id, {amount: request.amount})
        return {ok: true, paymentRequest: id}
      }
    },
    system: {
      id(prefix) {
        return `${prefix}${++sequence}`
      },
      now() {
        return clock
      }
    }
  }
  const sweep = createWalletSweep(host)
  function plan(options = {}) {
    const quotes = ['source_a', 'source_b'].map(sourceId =>
      sweep.createQuote({
        sourceId,
        destinationId: 'destination',
        leaveSat: options.leaveSat || 0
      })
    )
    return sweep.createPlan({
      quoteIds: quotes.map(q => q.id),
      address: options.address || ''
    })
  }
  function consolidate(p) {
    for (const source of p.sources)
      sweep.consolidate({
        planId: p.id,
        sourceId: source.sourceId,
        confirm: true
      })
    return sweep.getPlan({planId: p.id})
  }
  return {
    host,
    sweep,
    plan,
    consolidate,
    tables,
    wallets,
    failures,
    payments,
    invoices,
    advance(seconds) {
      clock += seconds
    },
    owner(value) {
      owner = value
    }
  }
}
