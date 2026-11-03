/**
 * The REST surface the exchange-resident backstop, the watchdog and the
 * flatten runbook need: every open order (paged), stop orders, an edit that
 * resizes, a heartbeat ack that says whether the switch is enabled, cancel-all
 * with Delta's own filters, and close-all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DxRest } from '../src/index.ts'

interface Call {
  url: string
  method: string
  body: string | undefined
}

function fakeFetch(responses: unknown[]): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
    })
    const r = responses.shift() ?? { success: true, result: {} }
    return new Response(JSON.stringify(r), { status: 200 })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const rest = (fn: typeof fetch) =>
  new DxRest({ baseUrl: 'https://dx.test', apiKey: 'K', apiSecret: 'S', userAgent: 'ua', fetch: fn, nowMs: () => 1_793_690_000_000 })

const order = (id: number) => ({ id, product_id: 1, size: 1, unfilled_size: 1, side: 'buy', state: 'pending' })

test('openOrders follows the cursor: a 51st open order (a backstop) is never invisible', async () => {
  const { fn, calls } = fakeFetch([
    { success: true, result: [order(1), order(2)], meta: { after: 'c1' } },
    { success: true, result: [order(3)], meta: { after: null } },
  ])
  const all = await rest(fn).openOrders()
  assert.deepEqual(all.map((o) => o.id), [1, 2, 3])
  assert.equal(calls.length, 2)
  assert.match(calls[1]?.url ?? '', /after=c1/)
  assert.match(calls[0]?.url ?? '', /states=open%2Cpending/)
})

test('placeOrder carries the stop fields as given', async () => {
  const { fn, calls } = fakeFetch([{ success: true, result: order(9) }])
  await rest(fn).placeOrder({
    product_id: 7,
    size: 3,
    side: 'buy',
    order_type: 'limit_order',
    limit_price: '150.0',
    stop_order_type: 'stop_loss_order',
    stop_price: '100.0',
    stop_trigger_method: 'mark_price',
    reduce_only: true,
    time_in_force: 'gtc',
    client_order_id: 'bkstpX',
  })
  const body = JSON.parse(calls[0]?.body ?? '{}')
  assert.equal(body.stop_order_type, 'stop_loss_order')
  assert.equal(body.stop_price, '100.0')
  assert.equal(body.stop_trigger_method, 'mark_price')
  assert.equal(body.reduce_only, true)
})

test('editOrder resizes and moves the stop when asked; a plain reprice sends only the limit', async () => {
  const { fn, calls } = fakeFetch([{ success: true, result: order(1) }, { success: true, result: order(1) }])
  const r = rest(fn)
  await r.editOrder({ id: 1, productId: 7, limitPrice: '150.0', size: 4, stopPrice: '100.0' })
  await r.editOrder({ id: 1, productId: 7, limitPrice: '151.0' })
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), { id: 1, product_id: 7, limit_price: '150.0', size: 4, stop_price: '100.0' })
  assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), { id: 1, product_id: 7, limit_price: '151.0' })
  assert.equal(calls[0]?.method, 'PUT')
})

test('heartbeatAck answers whether Delta still has the switch enabled', async () => {
  const { fn, calls } = fakeFetch([{ success: true, result: { process_enabled: false } }])
  const r = new DxRest({ baseUrl: 'https://dx.test', apiKey: 'K', apiSecret: 'S', userAgent: 'ua', fetch: fn, heartbeatId: 'hb-1' })
  const ack = await r.heartbeatAck(0)
  assert.equal(ack.process_enabled, false)
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), { heartbeat_id: 'hb-1', ttl: 0 })
})

test('cancelAllOrders sends Delta its filters verbatim; closeAllPositions posts close_all', async () => {
  const { fn, calls } = fakeFetch([{ success: true }, { success: true, result: {} }])
  const r = rest(fn)
  await r.cancelAllOrders({ contract_types: 'call_options,put_options', cancel_limit_orders: true, cancel_stop_orders: false, cancel_reduce_only_orders: false })
  await r.closeAllPositions()
  assert.equal(calls[0]?.method, 'DELETE')
  assert.equal(new URL(calls[0]?.url ?? '').pathname, '/v2/orders/all')
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), {
    contract_types: 'call_options,put_options', cancel_limit_orders: true, cancel_stop_orders: false, cancel_reduce_only_orders: false,
  })
  assert.equal(calls[1]?.method, 'POST')
  assert.equal(new URL(calls[1]?.url ?? '').pathname, '/v2/positions/close_all')
  assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), { close_all_portfolio: true, close_all_isolated: true })
})
