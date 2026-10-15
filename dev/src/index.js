import {
  storageGet,
  storageSet,
  storageGetPaginated,
  listUserWallets,
  walletBalance,
  createInvoice,
  payInvoice,
  payLnurl,
  randomId,
  now
} from 'lnbits:extension/host'
import {resolve} from 'lnbits:extension/utils-lnurl'
import {createWalletSweep, SweepError} from './logic.js'

function safe(value) {
  return JSON.parse(
    JSON.stringify(value, (_, item) => {
      if (typeof item !== 'bigint') return item
      const number = Number(item)
      if (!Number.isSafeInteger(number))
        throw new Error('Amount exceeds supported precision.')
      return number
    })
  )
}
const sweep = createWalletSweep({
  storage: {
    get(table, id) {
      const row = storageGet({table, id}).dataJson
      return row ? JSON.parse(row) : null
    },
    set(table, data) {
      if (!storageSet({table, dataJson: JSON.stringify(data)}).ok)
        throw new Error('Storage failed.')
    },
    list(table, filters = {}, options = {}) {
      const page = storageGetPaginated({
        table,
        filtersJson: JSON.stringify(filters),
        search: '',
        searchFields: [],
        sortBy: options.sortBy || '',
        descending: options.descending === true,
        limit: options.limit || 100,
        offset: options.offset || 0
      })
      return {rows: JSON.parse(page.rowsJson), total: Number(page.total)}
    }
  },
  wallets: {
    list() {
      return listUserWallets().wallets
    },
    balance(walletId) {
      return safe(walletBalance({walletId}))
    },
    createInvoice(request) {
      return createInvoice({
        ...request,
        currency: 'sat',
        tag: 'wallet_sweep',
        extra: Object.entries(request.extra)
      })
    },
    payInvoice(request) {
      return safe(
        payInvoice({
          ...request,
          maxSat: BigInt(request.maxSat),
          extra: Object.entries(request.extra)
        })
      )
    },
    resolve(address) {
      return safe(resolve({lnurl: address}))
    },
    fetchLnurl(request) {
      return safe(
        payLnurl({
          ...request,
          currency: 'sat',
          comment: undefined,
          description: 'Wallet Sweep external payment',
          maxSat: BigInt(request.amount),
          extra: [],
          fetchOnly: true
        })
      )
    }
  },
  system: {
    id(prefix) {
      return randomId({prefix}).id
    },
    now() {
      return Number(now().timestamp)
    }
  }
})
function invoke(method, value) {
  try {
    const input = JSON.parse(value || '{}')
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new SweepError('Expected an object.')
    return JSON.stringify({ok: true, data: sweep[method](input)})
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error:
        error instanceof SweepError
          ? error.message
          : 'The request could not complete. Reload the sweep history and review any payment in progress.'
    })
  }
}
export function getWallets(value) {
  return invoke('getWallets', value)
}
export function getBalance(value) {
  return invoke('getBalance', value)
}
export function createQuote(value) {
  return invoke('createQuote', value)
}
export function createPlan(value) {
  return invoke('createPlan', value)
}
export function getPlan(value) {
  return invoke('getPlan', value)
}
export function getHistory(value) {
  return invoke('getHistory', value)
}
export function consolidate(value) {
  return invoke('consolidate', value)
}
export function preparePayout(value) {
  return invoke('preparePayout', value)
}
export function sendPayout(value) {
  return invoke('sendPayout', value)
}
