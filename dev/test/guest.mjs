import {component} from './component.mjs'

// Adapt the fixture's wallet and storage services to the component interface.
export function createWalletSweep(host) {
  function payment(result) {
    return {...result, ok: !!result.ok, success: !!result.success, pending: !!result.pending,
      amountMsat: BigInt(result.amountMsat || 0), feeMsat: BigInt(result.feeMsat || 0)}
  }
  const interfaces = {
    'lnbits:extension/host': {
      randomId: ({prefix}) => ({id: host.system.id(prefix)}),
      now: () => ({timestamp: BigInt(host.system.now())}),
      storageGet: ({table, id}) => ({dataJson: JSON.stringify(host.storage.get(table, id))}),
      storageSet({table, dataJson}) {
        try { host.storage.set(table, JSON.parse(dataJson)); return {ok: true} }
        catch { return {ok: false} }
      },
      storageGetPaginated({table, filtersJson, ...options}) {
        const page = host.storage.list(table, JSON.parse(filtersJson), options)
        return {rowsJson: JSON.stringify(page.rows), total: BigInt(page.total)}
      },
      listUserWallets: () => ({wallets: host.wallets.list()}),
      walletBalance({walletId}) {
        const b = host.wallets.balance(walletId)
        return {...b, balanceMsat: BigInt(b.balanceMsat), balanceSat: BigInt(Math.floor(b.balanceMsat / 1000)),
          withdrawableMsat: BigInt(b.withdrawableMsat), withdrawableSat: BigInt(Math.floor(b.withdrawableMsat / 1000)),
          feeReserveMsat: BigInt(b.feeReserveMsat), feeReserveSat: BigInt(Math.ceil(b.feeReserveMsat / 1000))}
      },
      createInvoice(req) {return {checkingId: 'checking', ...host.wallets.createInvoice({...req, extra: Object.fromEntries(req.extra)})}},
      payInvoice(req) {
        return payment(host.wallets.payInvoice({...req, maxSat: Number(req.maxSat), extra: Object.fromEntries(req.extra)}))
      },
      payLnurl(req) {if (!req.fetchOnly) throw new Error('External invoice must be fetch-only');return payment(host.wallets.fetchLnurl(req))}
    },
    'lnbits:extension/utils-lnurl': {
      resolve({lnurl}) {
        const p = host.wallets.resolve(lnurl)
        return {lnurl, description: '', commentAllowed: 0n, fixed: false, metadataJson: '[]',
          minSendableMsat: BigInt(p.minSendableMsat), maxSendableMsat: BigInt(p.maxSendableMsat)}
      }
    }
  }
  return new Proxy({}, {get(_, method) {
    return (request = {}) => {
      const response = JSON.parse(component(interfaces)[method](JSON.stringify(request)))
      if (!response.ok) throw new Error(response.error)
      return response.data
    }
  }})
}
