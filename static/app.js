/* All API calls use the parent bridge. Text is rendered with textContent. */
;(() => {
  const state = {
    wallets: [],
    balances: {},
    selected: new Set(),
    destinationId: '',
    leaveSat: 0,
    external: false,
    address: '',
    plan: null,
    history: [],
    historyTotal: 0,
    historyOffset: 0,
    busy: false,
    message: '',
    error: '',
    progress: '',
    extraReserveSat: 0,
    confirmAddress: '',
    confirmPartial: false
  }
  const root = document.getElementById('app')
  const api = (path, method = 'GET', body = null) =>
    window.walletSweepBridge.call(path, method, body)
  const format = value => Number(value).toLocaleString('en-US')
  const when = timestamp => new Date(timestamp * 1000).toLocaleString()
  const node = (tag, className, text) => {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }
  const append = (parent, ...children) => {
    for (const child of children) if (child) parent.append(child)
    return parent
  }
  const button = (text, action, className = 'button', disabled = false) => {
    const element = node('button', className, text)
    element.type = 'button'
    element.disabled = state.busy || disabled
    element.addEventListener('click', action)
    return element
  }
  const message = (text, type = 'info') => {
    const element = node('p', `notice ${type}`, text)
    element.setAttribute('role', type === 'error' ? 'alert' : 'status')
    return element
  }
  const input = (label, value, change, options = {}) => {
    const wrapper = node('label', 'field')
    const control = document.createElement('input')
    Object.assign(control, {
      type: 'text',
      value,
      disabled: state.busy,
      ...options
    })
    control.addEventListener('input', event => change(event.target.value))
    return append(wrapper, node('span', 'field-label', label), control)
  }
  const checkbox = (label, checked, change, disabled = false) => {
    const wrapper = node('label', 'checkbox')
    const control = document.createElement('input')
    Object.assign(control, {
      type: 'checkbox',
      checked,
      disabled: state.busy || disabled
    })
    control.addEventListener('change', event => {
      change(event.target.checked)
      render()
    })
    return append(wrapper, control, node('span', '', label))
  }
  async function run(action) {
    if (state.busy) return
    state.busy = true
    state.error = ''
    state.message = ''
    render()
    try {
      await action()
    } catch (error) {
      state.error =
        error.message || 'Request failed. Reload history to check its outcome.'
    } finally {
      state.busy = false
      state.progress = ''
      render()
    }
  }
  async function history() {
    const result = await api(`/history?offset=${state.historyOffset}`)
    state.history = result.plans
    state.historyTotal = result.total
  }
  async function refresh() {
    const result = await api('/wallets')
    state.wallets = result.wallets
    state.selected = new Set(
      [...state.selected].filter(id => state.wallets.some(w => w.id === id))
    )
    for (const wallet of state.wallets) {
      try {
        state.balances[wallet.id] = await api('/balance', 'POST', {
          walletId: wallet.id
        })
      } catch (_) {
        state.balances[wallet.id] = null
      }
    }
    await history()
  }
  async function review() {
    const sourceIds = [...state.selected].filter(
      id => id !== state.destinationId
    )
    if (!state.destinationId || !sourceIds.length)
      throw new Error(
        'Choose a destination and at least one different source wallet.'
      )
    if (sourceIds.length > 50)
      throw new Error('Select up to 50 source wallets for one sweep.')
    if (!Number.isSafeInteger(state.leaveSat) || state.leaveSat < 0)
      throw new Error('Enter a non-negative whole number of sats to retain.')
    if (state.external && !state.address.trim())
      throw new Error('Enter a Lightning Address.')
    const quotes = []
    for (let index = 0; index < sourceIds.length; index++) {
      state.progress = `Preparing preview ${index + 1} of ${sourceIds.length}. No funds are moving.`
      render()
      quotes.push(
        await api('/quotes', 'POST', {
          sourceId: sourceIds[index],
          destinationId: state.destinationId,
          leaveSat: state.leaveSat
        })
      )
    }
    state.plan = await api('/plans', 'POST', {
      quoteIds: quotes.map(q => q.id),
      address: state.external ? state.address.trim() : ''
    })
    resetConfirmation()
    await history()
  }
  async function consolidate() {
    const plan = state.plan
    for (let index = 0; index < plan.sources.length; index++) {
      const source = plan.sources[index]
      if (source.status !== 'ready') continue
      state.progress = `Consolidating ${index + 1} of ${plan.sources.length}: ${source.sourceName}`
      render()
      try {
        state.plan = await api('/consolidate', 'POST', {
          planId: plan.id,
          sourceId: source.sourceId,
          confirm: true
        })
      } catch (_) {
        // A timed-out payment is never submitted again automatically.
        state.plan = await api(`/plan?planId=${encodeURIComponent(plan.id)}`)
        state.error =
          'A transfer could not be confirmed. Review the results and the wallet payment history.'
      }
    }
    state.plan = await api(`/plan?planId=${encodeURIComponent(plan.id)}`)
    state.message = 'Consolidation finished. Review each wallet below.'
    await history()
  }
  function resetConfirmation() {
    state.confirmAddress = ''
    state.confirmPartial = false
    state.extraReserveSat = 0
  }
  function openPlan(planId) {
    return run(async () => {
      state.plan = await api(`/plan?planId=${encodeURIComponent(planId)}`)
      resetConfirmation()
    })
  }
  function render() {
    root.replaceChildren()
    append(
      root,
      append(
        node('header', 'header'),
        append(
          node('div'),
          node('p', 'eyebrow', 'LNBITS / YOUR FUNDS, TOGETHER'),
          node('h1', '', 'Wallet Sweep'),
          node('p', 'muted', 'Gather your balances. Choose what happens next.')
        ),
        button(
          'Refresh',
          () =>
            run(async () => {
              await refresh()
              if (state.plan)
                state.plan = await api(
                  `/plan?planId=${encodeURIComponent(state.plan.id)}`
                )
            }),
          'button secondary'
        )
      )
    )
    if (state.error) append(root, message(state.error, 'error'))
    if (state.message) append(root, message(state.message, 'success'))
    if (state.progress) append(root, message(state.progress))
    if (state.plan) renderPlan()
    else renderChoose()
    renderHistory()
  }
  function renderChoose() {
    const layout = node('div', 'layout')
    const list = append(
      node('section', 'panel'),
      node('p', 'eyebrow', '01 / CHOOSE SOURCES'),
      node('h2', '', 'Your wallets')
    )
    const selectable = state.wallets.filter(
      w =>
        w.id !== state.destinationId &&
        state.balances[w.id]?.canSendPayments &&
        state.balances[w.id]?.balanceMsat >= 1000
    )
    append(
      list,
      checkbox(
        'Select all available wallets',
        selectable.length > 0 &&
          selectable.every(w => state.selected.has(w.id)),
        checked => {
          state.selected = checked
            ? new Set(selectable.map(w => w.id))
            : new Set()
        }
      )
    )
    if (!state.wallets.length)
      append(
        list,
        node(
          'p',
          'muted',
          'No wallets found. Create a Lightning wallet in LNbits to get started.'
        )
      )
    for (const wallet of state.wallets) {
      const balance = state.balances[wallet.id]
      const isDestination = wallet.id === state.destinationId
      const disabled =
        isDestination || !balance?.canSendPayments || balance.balanceMsat < 1000
      const row = append(
        node('div', `wallet-row${isDestination ? ' destination' : ''}`),
        checkbox(
          wallet.name,
          state.selected.has(wallet.id),
          checked => {
            if (checked) state.selected.add(wallet.id)
            else state.selected.delete(wallet.id)
          },
          disabled
        ),
        append(
          node('div', 'wallet-amount'),
          node(
            'strong',
            '',
            balance
              ? `${format(Math.floor(balance.balanceMsat / 1000))} sats`
              : 'Balance unavailable'
          ),
          node(
            'span',
            'muted small',
            isDestination
              ? 'Destination'
              : disabled
                ? 'Unavailable for Lightning spending'
                : ''
          )
        )
      )
      append(list, row)
    }
    const settings = append(
      node('section', 'panel'),
      node('p', 'eyebrow', '02 / SET DESTINATION'),
      node('h2', '', 'Gather into one wallet')
    )
    const select = document.createElement('select')
    select.disabled = state.busy
    append(select, new Option('Choose an existing wallet', ''))
    for (const wallet of state.wallets)
      append(select, new Option(wallet.name, wallet.id))
    select.value = state.destinationId
    select.addEventListener('change', () => {
      state.destinationId = select.value
      state.selected.delete(select.value)
      render()
    })
    append(
      settings,
      append(
        node('label', 'field'),
        node('span', 'field-label', 'Destination wallet'),
        select
      ),
      input(
        'Leave in each source (sats, before service fees)',
        state.leaveSat,
        value => {
          state.leaveSat = Number(value)
        },
        {type: 'number', min: '0', step: '1'}
      ),
      checkbox('Then send to a Lightning Address', state.external, checked => {
        state.external = checked
      })
    )
    if (state.external)
      append(
        settings,
        input(
          'Lightning Address',
          state.address,
          value => {
            state.address = value
          },
          {
            placeholder: 'name@example.com',
            autoComplete: 'off',
            spellcheck: false
          }
        )
      )
    append(
      settings,
      node(
        'p',
        'muted small',
        state.external
          ? 'First consolidate internally. You will confirm the address and external payment separately after consolidation.'
          : 'Transfers between these wallets settle internally without Lightning routing fees.'
      ),
      message(
        'Instance service fees may apply. Retained amounts are shown before those fees. Whole sats are transferred; fractional sats stay behind.'
      ),
      button(
        'Review sweep',
        () => run(review),
        'button primary full',
        !state.destinationId || state.selected.size === 0
      )
    )
    append(layout, list, settings)
    append(root, layout)
  }
  function renderPlan() {
    const plan = state.plan
    const ready = plan.sources.some(s => s.status === 'ready')
    const uncertain = plan.sources.some(s => s.status === 'uncertain')
    const panel = append(
      node('section', 'panel'),
      node(
        'p',
        'eyebrow',
        ready ? '03 / REVIEW & CONFIRM' : 'CONSOLIDATION RESULTS'
      ),
      node(
        'h2',
        '',
        `${format(ready ? plan.totalSat : plan.movedSat)} sats ${ready ? 'to gather' : 'confirmed moved'}`
      ),
      node(
        'p',
        '',
        `${plan.sources.length} source wallets → ${plan.destinationName}`
      ),
      node('p', 'muted small', `Sweep ${plan.id} · ${when(plan.createdAt)}`)
    )
    if (plan.address)
      append(
        panel,
        message(
          `Two steps: gather funds in “${plan.destinationName}”, then review a separate payment to ${plan.address}. Nothing is sent externally until you confirm again.`
        )
      )
    const table = node('table', 'breakdown')
    append(
      table,
      append(
        node('thead'),
        append(
          node('tr'),
          ...[
            'Wallet',
            'Balance at preview',
            'Transfer',
            'Retained before fees',
            'Result'
          ].map(text => node('th', '', text))
        )
      )
    )
    const tbody = node('tbody')
    for (const source of plan.sources) {
      append(
        tbody,
        append(
          node('tr'),
          append(
            node('td'),
            node('strong', '', source.sourceName),
            node(
              'div',
              'muted small',
              source.receipt?.error || source.skippedReason || ''
            )
          ),
          node('td', '', `${format(source.balanceMsat / 1000)} sats`),
          node('td', '', `${format(source.amountSat)} sats`),
          node('td', '', `${format(source.retainedMsat / 1000)} sats`),
          append(
            node('td'),
            node(
              'span',
              `badge ${source.status}`,
              {
                ready: 'Ready',
                success: 'Transferred',
                failed: 'Failed',
                skipped: 'Skipped',
                uncertain: 'Needs review'
              }[source.status]
            ),
            source.receipt?.paymentHash
              ? node('div', 'hash small', source.receipt.paymentHash)
              : null
          )
        )
      )
    }
    append(table, tbody)
    append(
      panel,
      append(node('div', 'table-scroll'), table),
      node(
        'p',
        'muted small',
        'No Lightning routing fees for internal transfers. Instance service fees may apply in addition. Balances may change after this preview.'
      )
    )
    if (ready)
      append(
        panel,
        message(
          'Confirmation authorizes the listed internal transfers. If an individual wallet fails, the other wallets will still be processed.'
        ),
        append(
          node('div', 'actions'),
          button(
            'Back to wallets',
            () => {
              state.plan = null
              render()
            },
            'button secondary'
          ),
          button(
            'Confirm internal consolidation',
            () => run(consolidate),
            'button primary'
          )
        )
      )
    else
      append(
        panel,
        button(
          'New sweep',
          () =>
            run(async () => {
              state.plan = null
              await refresh()
            }),
          'button secondary'
        )
      )
    if (uncertain)
      append(
        panel,
        message(
          'An outcome is uncertain. Check the wallet payment history. Automatic retries and external sending are blocked for this sweep.',
          'error'
        )
      )
    append(root, panel)
    if (!ready && !uncertain && plan.address && plan.movedSat > 0)
      renderPayout(plan)
  }
  function renderPayout(plan) {
    const panel = append(
      node('section', 'panel payout-panel'),
      node('p', 'eyebrow', '04 / SEPARATE EXTERNAL CONFIRMATION'),
      node('h2', '', 'Send outside this instance')
    )
    const payout = plan.payout
    if (!payout) {
      append(
        panel,
        node(
          'p',
          '',
          `${format(plan.movedSat)} sats confirmed in “${plan.destinationName}”.`
        ),
        input(
          'Additional fee reserve (sats)',
          state.extraReserveSat,
          value => {
            state.extraReserveSat = Number(value)
          },
          {type: 'number', min: '0', step: '1'}
        ),
        node(
          'p',
          'muted small',
          'The send amount is limited to confirmed consolidated funds, less the LNbits fee reserve and any additional reserve. Instance service fees are additional. Unused funds remain in the wallet.'
        ),
        button(
          'Review external payment',
          () =>
            run(async () => {
              state.plan = await api('/payout/prepare', 'POST', {
                planId: plan.id,
                extraReserveSat: state.extraReserveSat
              })
              resetConfirmation()
            }),
          'button primary'
        )
      )
    } else {
      append(
        panel,
        node('p', 'address', payout.address),
        append(
          node('div', 'payout-grid'),
          metric('Amount to send', `${format(payout.amountSat)} sats`),
          metric(
            'Fee reserve (not a quote)',
            `${format(payout.feeReserveSat)} sats`
          ),
          metric(
            'Wallet balance at preparation',
            `${format(payout.destinationBalanceMsat / 1000)} sats`
          )
        ),
        node(
          'p',
          'muted small',
          'Actual routing fees are known after settlement. Instance service fees may also apply. The prepared invoice is fixed; retrying a request does not obtain a replacement invoice.'
        )
      )
      if (payout.status === 'ready') {
        append(
          panel,
          input(
            'Re-enter the Lightning Address to confirm',
            state.confirmAddress,
            value => {
              state.confirmAddress = value
              updateSendButton()
            },
            {autoComplete: 'off', spellcheck: false}
          )
        )
        if (plan.partial)
          append(
            panel,
            checkbox(
              'I reviewed the failed wallets and want to send only the confirmed consolidated amount.',
              state.confirmPartial,
              checked => {
                state.confirmPartial = checked
              }
            )
          )
        const send = button(
          'Confirm external payment',
          () =>
            run(async () => {
              state.plan = await api('/payout/send', 'POST', {
                planId: plan.id,
                payoutId: payout.id,
                address: state.confirmAddress,
                confirm: true,
                confirmPartial: state.confirmPartial
              })
              state.message =
                state.plan.payout.status === 'success'
                  ? 'External payment settled.'
                  : 'Review the payment result below.'
            }),
          'button danger',
          !canSend()
        )
        send.id = 'confirm-send'
        append(
          panel,
          append(
            node('div', 'actions'),
            button(
              'Keep funds in this wallet',
              () => {
                state.plan = null
                state.message =
                  'Funds remain in your consolidation wallet. No external payment was started.'
                render()
              },
              'button secondary'
            ),
            send
          )
        )
      } else {
        append(
          panel,
          message(
            payout.status === 'success'
              ? `Payment settled. Actual fee: ${format((payout.receipt?.feeMsat || 0) / 1000)} sats.`
              : payout.receipt?.error ||
                  'Review the destination wallet payment history.',
            payout.status === 'success' ? 'success' : 'error'
          )
        )
        if (payout.receipt?.paymentHash)
          append(
            panel,
            node(
              'p',
              'hash small',
              `Payment hash: ${payout.receipt.paymentHash}`
            )
          )
      }
    }
    append(root, panel)
  }
  function canSend() {
    const address = state.confirmAddress.trim()
    const parts = address.split('@')
    const normalized =
      parts.length === 2 ? `${parts[0]}@${parts[1].toLowerCase()}` : address
    return (
      normalized === state.plan?.address &&
      (!state.plan.partial || state.confirmPartial)
    )
  }
  function updateSendButton() {
    const button = document.getElementById('confirm-send')
    if (button) button.disabled = state.busy || !canSend()
  }
  function metric(label, value) {
    return append(
      node('div', 'metric'),
      node('span', 'muted small', label),
      node('strong', '', value)
    )
  }
  function renderHistory() {
    const panel = append(
      node('section', 'panel history'),
      node('p', 'eyebrow', 'PRIVATE AUDIT HISTORY'),
      node('h2', '', 'Recent sweeps')
    )
    if (!state.history.length)
      append(
        panel,
        node('p', 'muted', 'Your sweep previews and results will appear here.')
      )
    for (const plan of state.history)
      append(
        panel,
        append(
          node('div', 'history-row'),
          append(
            node('div'),
            node(
              'strong',
              '',
              `${format(plan.totalSat)} sats → ${plan.destinationName}`
            ),
            node(
              'p',
              'muted small',
              `${when(plan.createdAt)} · ${plan.sourceCount} wallets${plan.address ? ` · ${plan.address}` : ''}`
            )
          ),
          button('Open', () => openPlan(plan.id), 'button secondary')
        )
      )
    if (
      state.historyOffset > 0 ||
      state.historyTotal > state.historyOffset + 20
    )
      append(
        panel,
        append(
          node('div', 'actions'),
          button(
            'Newer',
            () =>
              run(async () => {
                state.historyOffset = Math.max(0, state.historyOffset - 20)
                await history()
              }),
            'button secondary',
            state.historyOffset === 0
          ),
          button(
            'Older',
            () =>
              run(async () => {
                state.historyOffset += 20
                await history()
              }),
            'button secondary',
            state.historyOffset + 20 >= state.historyTotal
          )
        )
      )
    append(root, panel)
  }
  render()
  run(refresh)
})()
