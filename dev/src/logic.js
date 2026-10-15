// All state lives in owner-scoped host storage. No guest globals act as locks.
export class SweepError extends Error {}
export const MAX_SOURCES = 50
const MAX_SAT = Math.floor(Number.MAX_SAFE_INTEGER / 1000)
const QUOTE_LIFETIME = 15 * 60

export function createWalletSweep(host) {
  return {
    getWallets() {
      return {wallets: host.wallets.list(), maxSources: MAX_SOURCES}
    },
    getBalance(input) {
      return host.wallets.balance(identifier(input.walletId, 'Wallet'))
    },
    createQuote(input) {
      const sourceId = identifier(input.sourceId, 'Source wallet')
      const destinationId = identifier(
        input.destinationId,
        'Destination wallet'
      )
      insist(sourceId !== destinationId, 'The destination cannot be a source.')
      const leaveSat = sats(input.leaveSat ?? 0, 'Leave-behind amount')
      const source = host.wallets.balance(sourceId)
      const destination = host.wallets.balance(destinationId)
      const balanceMsat = integer(source.balanceMsat, 'Wallet balance')
      const amountSat = Math.max(0, Math.floor(balanceMsat / 1000) - leaveSat)
      const quote = {
        id: host.system.id('quote_'),
        createdAt: host.system.now(),
        sourceId,
        sourceName: source.name,
        destinationId,
        destinationName: destination.name,
        balanceMsat,
        leaveSat,
        amountSat,
        retainedMsat: balanceMsat - amountSat * 1000,
        expiresAt: host.system.now() + QUOTE_LIFETIME,
        invoice: null,
        paymentHash: null,
        skippedReason: null
      }
      if (!source.canSendPayments) {
        quote.skippedReason =
          'This wallet is unavailable for Lightning spending.'
        quote.amountSat = 0
      } else if (amountSat === 0) {
        quote.skippedReason =
          'No whole sats available above the retained amount.'
      } else {
        const invoice = host.wallets.createInvoice({
          walletId: destinationId,
          amount: amountSat,
          memo: 'Wallet Sweep internal transfer',
          extra: {quote_id: quote.id, source_wallet: sourceId}
        })
        quote.invoice = invoice.paymentRequest
        quote.paymentHash = invoice.paymentHash
        insist(
          quote.invoice && quote.paymentHash,
          'Could not prepare the internal invoice.'
        )
      }
      quote.retainedMsat = balanceMsat - quote.amountSat * 1000
      save('quotes', quote)
      return publicSource(quote)
    },
    createPlan(input) {
      insist(
        Array.isArray(input.quoteIds) &&
          input.quoteIds.length > 0 &&
          input.quoteIds.length <= MAX_SOURCES,
        `Select between 1 and ${MAX_SOURCES} source wallets.`
      )
      const sources = input.quoteIds.map(id =>
        load('quotes', identifier(id, 'Quote'))
      )
      insist(
        new Set(sources.map(s => s.sourceId)).size === sources.length,
        'A source wallet was selected twice.'
      )
      insist(
        sources.every(s => s.destinationId === sources[0].destinationId),
        'All sources must use the same destination.'
      )
      insist(
        sources.every(s => s.expiresAt > host.system.now()),
        'The preview expired. Create a new preview.'
      )
      const totalSat = sources.reduce(
        (sum, s) => sats(sum + s.amountSat, 'Total'),
        0
      )
      insist(totalSat > 0, 'There are no funds available to consolidate.')
      const address = input.address ? lightningAddress(input.address) : ''
      if (address) host.wallets.resolve(address)
      const plan = {
        id: host.system.id('sweep_'),
        createdAt: host.system.now(),
        destinationId: sources[0].destinationId,
        destinationName: sources[0].destinationName,
        address,
        sources,
        totalSat,
        expiresAt: Math.min(...sources.map(s => s.expiresAt))
      }
      save('plans', plan)
      return view(plan)
    },
    getPlan(input) {
      return view(load('plans', identifier(input.planId, 'Sweep')))
    },
    getHistory(input) {
      const offset = sats(
        typeof input.offset === 'string' && /^\d{1,8}$/.test(input.offset)
          ? Number(input.offset)
          : (input.offset ?? 0),
        'Offset'
      )
      const page = host.storage.list(
        'plans',
        {},
        {limit: 20, offset, sortBy: 'created_at', descending: true}
      )
      return {
        total: page.total,
        plans: page.rows.map(row => {
          const plan = JSON.parse(row.data_json)
          return {
            id: plan.id,
            createdAt: plan.createdAt,
            destinationName: plan.destinationName,
            address: plan.address,
            totalSat: plan.totalSat,
            sourceCount: plan.sources.length
          }
        })
      }
    },
    consolidate(input) {
      confirmed(input)
      const plan = load('plans', identifier(input.planId, 'Sweep'))
      const sourceId = identifier(input.sourceId, 'Source wallet')
      const source = plan.sources.find(s => s.sourceId === sourceId)
      insist(source, 'This source does not belong to the sweep.')
      const current = view(plan)
      const state = current.sources.find(s => s.sourceId === sourceId)
      if (state.status !== 'ready') return current
      insist(
        plan.expiresAt > host.system.now(),
        'This sweep expired. Review balances in a new sweep.'
      )
      insist(
        current.payoutCount === 0,
        'This sweep already has an external payment prepared.'
      )
      const attempt = start(plan, `source:${sourceId}`)
      try {
        const balance = host.wallets.balance(sourceId)
        if (
          !balance.canSendPayments ||
          balance.balanceMsat < (source.amountSat + source.leaveSat) * 1000
        ) {
          finish(attempt, {
            status: 'failed',
            error:
              'The balance or wallet permissions changed. No transfer was started.'
          })
        } else {
          const result = host.wallets.payInvoice({
            walletId: sourceId,
            paymentRequest: source.invoice,
            maxSat: source.amountSat,
            description: `Wallet Sweep to ${plan.destinationName}`,
            extra: {sweep_id: plan.id, phase: 'internal', quote_id: source.id}
          })
          finish(attempt, paymentResult(result, source.amountSat))
        }
      } catch (_) {
        // A missing response is not proof that a payment failed. Never replace its invoice.
        finish(attempt, {
          status: 'uncertain',
          error:
            'Outcome unknown. Check the wallet payment history before taking further action.'
        })
      }
      return view(plan)
    },
    preparePayout(input) {
      const plan = load('plans', identifier(input.planId, 'Sweep'))
      insist(plan.address, 'This sweep has no external destination.')
      const current = view(plan)
      insist(
        current.sources.every(s =>
          ['success', 'failed', 'skipped'].includes(s.status)
        ),
        'Finish consolidation and resolve uncertain outcomes before preparing an external payment.'
      )
      insist(current.movedSat > 0, 'No confirmed funds were consolidated.')
      const existing = payoutRows(plan.id)
      insist(
        existing.length <= 1,
        'Concurrent payment preparation detected. Keep the funds in the wallet and review its history.'
      )
      if (existing.length === 1) return view(plan)
      const extraReserveSat = sats(
        input.extraReserveSat ?? 0,
        'Additional fee reserve'
      )
      const balance = host.wallets.balance(plan.destinationId)
      insist(
        balance.canSendPayments && balance.withdrawableMsat > 0,
        'The destination wallet cannot send this payment.'
      )
      const feeReserveSat =
        Math.ceil(integer(balance.feeReserveMsat, 'Fee reserve') / 1000) +
        extraReserveSat
      const availableSat = Math.min(
        current.movedSat,
        Math.floor(balance.balanceMsat / 1000)
      )
      const amountSat = sats(availableSat - feeReserveSat, 'Payment amount')
      insist(
        amountSat > 0,
        'The consolidated funds cannot cover the fee reserve. Funds remain in the destination wallet.'
      )
      const resolved = host.wallets.resolve(plan.address)
      insist(
        amountSat * 1000 >= resolved.minSendableMsat &&
          amountSat * 1000 <= resolved.maxSendableMsat,
        'The amount is outside the Lightning Address payment limits. Funds remain in the destination wallet.'
      )
      const invoice = host.wallets.fetchLnurl({
        walletId: plan.destinationId,
        lnurl: plan.address,
        amount: amountSat
      })
      insist(
        invoice.ok && invoice.paymentRequest,
        'Could not obtain a payment invoice. Funds remain in the destination wallet.'
      )
      // Immutable tickets are registered before they can be sent. If concurrent preparation
      // creates two tickets, sendPayout fails closed rather than choosing a second invoice.
      const payout = {
        id: host.system.id('payout_'),
        planId: plan.id,
        createdAt: host.system.now(),
        address: plan.address,
        amountSat,
        feeReserveSat,
        extraReserveSat,
        destinationBalanceMsat: balance.balanceMsat,
        movedSat: current.movedSat,
        invoice: invoice.paymentRequest,
        expiresAt: host.system.now() + 5 * 60
      }
      save('payouts', payout, {plan_id: plan.id})
      return view(plan)
    },
    sendPayout(input) {
      confirmed(input)
      const plan = load('plans', identifier(input.planId, 'Sweep'))
      insist(
        lightningAddress(input.address) === plan.address,
        'Re-enter the Lightning Address exactly as shown.'
      )
      const current = view(plan)
      insist(
        current.sources.every(s =>
          ['success', 'failed', 'skipped'].includes(s.status)
        ),
        'Consolidation is incomplete or has an uncertain outcome.'
      )
      insist(
        !current.partial || input.confirmPartial === true,
        'Acknowledge the failed source wallets before sending.'
      )
      const tickets = payoutRows(plan.id)
      insist(
        tickets.length === 1,
        'There must be exactly one prepared external payment. Keep funds in the wallet and review its history.'
      )
      const payout = tickets[0]
      insist(
        payout.id === identifier(input.payoutId, 'Payment'),
        'This payment does not belong to the sweep.'
      )
      const step = `payout:${payout.id}`
      if (status(receipts(plan.id).filter(r => r.step === step)) !== 'ready')
        return current
      insist(
        payout.expiresAt > host.system.now(),
        'The prepared payment expired. Funds remain in the wallet; use its payment screen to send them.'
      )
      const balance = host.wallets.balance(plan.destinationId)
      insist(
        balance.canSendPayments &&
          balance.balanceMsat >=
            (payout.amountSat + payout.feeReserveSat) * 1000,
        'The destination balance or permissions changed. Funds remain in the wallet.'
      )
      const attempt = start(plan, step)
      try {
        const result = host.wallets.payInvoice({
          walletId: plan.destinationId,
          paymentRequest: payout.invoice,
          maxSat: payout.amountSat,
          description: `Wallet Sweep to ${payout.address}`,
          extra: {
            sweep_id: plan.id,
            phase: 'external',
            lightning_address: payout.address
          }
        })
        finish(attempt, paymentResult(result, payout.amountSat))
      } catch (_) {
        finish(attempt, {
          status: 'uncertain',
          error:
            'Outcome unknown. Check the destination wallet payment history. Do not create another payment until it is resolved.'
        })
      }
      return view(plan)
    }
  }

  function save(table, value, fields = {}) {
    host.storage.set(table, {
      id: value.id,
      created_at: value.createdAt,
      ...fields,
      data_json: JSON.stringify(value)
    })
  }
  function load(table, id) {
    const row = host.storage.get(table, id)
    insist(row, 'The requested record was not found in your account.')
    return JSON.parse(row.data_json)
  }
  function receipts(planId) {
    const page = host.storage.list('receipts', {plan_id: planId}, {limit: 1000})
    insist(
      page.total <= 1000,
      'This sweep requires manual review in the wallet payment history.'
    )
    return page.rows.map(row => ({
      ...JSON.parse(row.data_json),
      step: row.step
    }))
  }
  function payoutRows(planId) {
    const page = host.storage.list('payouts', {plan_id: planId}, {limit: 2})
    insist(
      page.total <= 1,
      'Concurrent payment preparation detected. Keep funds in the wallet and review its history.'
    )
    return page.rows.map(row => JSON.parse(row.data_json))
  }
  function start(plan, step) {
    const attempt = {
      id: host.system.id('attempt_'),
      createdAt: host.system.now(),
      status: 'uncertain',
      error: 'Payment started; settlement is not confirmed.',
      planId: plan.id,
      step
    }
    finish(attempt, {})
    return attempt
  }
  function finish(attempt, result) {
    save(
      'receipts',
      {...attempt, ...result},
      {plan_id: attempt.planId, step: attempt.step}
    )
  }
  function view(plan) {
    const attempts = receipts(plan.id)
    const sources = plan.sources.map(source => {
      const rows = attempts.filter(r => r.step === `source:${source.sourceId}`)
      const sourceStatus = source.skippedReason ? 'skipped' : status(rows)
      const receipt = bestReceipt(rows)
      return {...publicSource(source), status: sourceStatus, receipt}
    })
    const payouts = payoutRows(plan.id)
    const payout = payouts[0]
    const payoutReceipts = payout
      ? attempts.filter(r => r.step === `payout:${payout.id}`)
      : []
    return {
      id: plan.id,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      destinationId: plan.destinationId,
      destinationName: plan.destinationName,
      address: plan.address,
      sources,
      totalSat: plan.totalSat,
      movedSat: sources
        .filter(s => s.status === 'success')
        .reduce((sum, s) => sum + s.amountSat, 0),
      partial: sources.some(s => s.amountSat > 0 && s.status === 'failed'),
      payoutCount: payouts.length,
      payout: payout
        ? {
            ...withoutInvoice(payout),
            status: status(payoutReceipts),
            receipt: bestReceipt(payoutReceipts)
          }
        : null
    }
  }
}

export function lightningAddress(value) {
  insist(
    typeof value === 'string' && value.length <= 254,
    'Enter a valid Lightning Address.'
  )
  const match =
    /^([a-zA-Z0-9._%+\-]+)@([a-zA-Z0-9](?:[a-zA-Z0-9.\-]*[a-zA-Z0-9])?)$/.exec(
      value.trim()
    )
  insist(
    match &&
      match[2].includes('.') &&
      match[2]
        .split('.')
        .every(
          label =>
            label.length > 0 &&
            label.length <= 63 &&
            !label.startsWith('-') &&
            !label.endsWith('-')
        ),
    'Enter a Lightning Address such as name@example.com.'
  )
  return `${match[1]}@${match[2].toLowerCase()}`
}
function insist(condition, message) {
  if (!condition) throw new SweepError(message)
}
function identifier(value, name) {
  insist(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      /^[a-zA-Z0-9_-]+$/.test(value),
    `${name} is invalid.`
  )
  return value
}
function integer(value, name) {
  insist(Number.isSafeInteger(value), `${name} exceeds supported precision.`)
  return value
}
function sats(value, name) {
  insist(
    Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAT,
    `${name} must be a non-negative whole number of sats.`
  )
  return value
}
function confirmed(input) {
  insist(input.confirm === true, 'Explicit confirmation is required.')
}
function withoutInvoice(value) {
  const {invoice, ...rest} = value
  return rest
}
function publicSource(value) {
  return withoutInvoice(value)
}
function status(rows) {
  if (rows.some(r => r.status === 'success')) return 'success'
  if (rows.some(r => r.status === 'uncertain')) return 'uncertain'
  if (rows.length) return 'failed'
  return 'ready'
}
function bestReceipt(rows) {
  const state = status(rows)
  return rows.find(r => r.status === state) || null
}
function paymentResult(result, amountSat) {
  const base = {
    paymentHash: result.paymentHash || null,
    checkingId: result.checkingId || null,
    amountMsat: result.amountMsat || 0,
    feeMsat: result.feeMsat || 0
  }
  if (
    result.ok &&
    result.success &&
    !result.pending &&
    result.amountMsat === amountSat * 1000
  )
    return {...base, status: 'success', error: null}
  if (
    result.ok ||
    /already|pending|timeout|timed out/i.test(result.error || '')
  )
    return {
      ...base,
      status: 'uncertain',
      error:
        'Settlement is not confirmed. Review the wallet payment history before taking further action.'
    }
  const error = /insufficient|reserve/i.test(result.error || '')
    ? 'Insufficient balance for the amount and fees. Funds remain in the wallet.'
    : /expired/i.test(result.error || '')
      ? 'The invoice expired. Funds remain in the wallet.'
      : 'Payment failed. Review the wallet payment history for details.'
  return {...base, status: 'failed', error}
}
