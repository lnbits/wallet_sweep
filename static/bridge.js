// Communicate through LNbits' authenticated iframe bridge; keys stay in the parent.
window.walletSweepBridge = (() => {
  let connection
  function connect() {
    if (connection) return connection
    connection = new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const channel = new MessageChannel()
      const timeout = setTimeout(() => {
        channel.port1.close()
        connection = null
        reject(new Error('Open Wallet Sweep inside LNbits to connect.'))
      }, 15000)
      channel.port1.onmessage = event => {
        if (
          event.data?.type !== 'lnbits-extension:connected' ||
          event.data.id !== id
        )
          return
        clearTimeout(timeout)
        channel.port1.onmessage = null
        resolve(channel.port1)
      }
      channel.port1.start()
      window.parent.postMessage(
        {type: 'lnbits-extension:connect', id},
        new URL(window.location.href).origin,
        [channel.port2]
      )
    })
    return connection
  }
  async function call(path, method = 'GET', body = null) {
    const port = await connect()
    const id = crypto.randomUUID()
    // Vue form values are reactive proxies; send plain JSON through the port.
    const payload = body == null ? null : JSON.parse(JSON.stringify(body))
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        port.removeEventListener('message', receive)
        reject(
          new Error(
            'Request timed out. Reload the sweep history before attempting another payment.'
          )
        )
      }, 30000)
      function receive(event) {
        const value = event.data
        if (value?.type !== 'lnbits-extension:response' || value.id !== id)
          return
        clearTimeout(timeout)
        port.removeEventListener('message', receive)
        if (!value.ok) reject(new Error(value.error || 'Request failed.'))
        else resolve(value.data)
      }
      port.addEventListener('message', receive)
      port.postMessage({
        type: 'lnbits-extension:request',
        id,
        action: 'api',
        path: `/api/v1/ext/wallet_sweep${path}`,
        method,
        body: payload
      })
    })
    let value = response
    // Core wraps the JSON returned by the component.
    while (value?.ok === true && 'data' in value) value = value.data
    if (value?.ok === false) throw new Error(value.error || 'Request failed.')
    return value
  }
  return {call}
})()
