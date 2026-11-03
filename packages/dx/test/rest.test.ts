import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DxApiError, DxRest, signRequest } from '../src/index.ts'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

interface FakeResponse {
  status?: number
  body: unknown
  headers?: Record<string, string>
}

/** Records every request so the wire format is assertable without Delta. */
function fakeFetch(responses: (FakeResponse | Error)[]): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
    })
    const r = responses.shift() ?? { body: { success: true, result: {} } }
    if (r instanceof Error) throw r
    const status = r.status ?? 200
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(text, { status, headers: r.headers ?? {} })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const NOW_MS = 1793690000_500
const TS = '1793690000'

const rest = (fn: typeof fetch, over: Record<string, unknown> = {}) =>
  new DxRest({
    baseUrl: 'https://dx.test',
    apiKey: 'KEY',
    apiSecret: 'test-secret',
    userAgent: 'algomaker-dx/1',
    fetch: fn,
    nowMs: () => NOW_MS,
    ...over,
  })

test('a signed GET carries api-key, seconds timestamp, the signature over path + ?query, and User-Agent', async () => {
  const { fn, calls } = fakeFetch([{ body: { success: true, result: [] } }])
  await rest(fn).openOrders()
  const c = calls[0]
  assert.ok(c)
  const u = new URL(c.url)
  assert.equal(u.origin + u.pathname, 'https://dx.test/v2/orders')
  assert.equal(c.method, 'GET')
  assert.equal(c.headers['api-key'], 'KEY')
  assert.equal(c.headers['timestamp'], TS)
  assert.equal(c.headers['User-Agent'], 'algomaker-dx/1')
  assert.equal(c.headers['signature'], signRequest('test-secret', 'GET', '/v2/orders', u.search, '', Number(TS)))
  assert.ok(u.search.startsWith('?'), 'query is signed with its ?')
  assert.equal(c.body, undefined)
})

test('placeOrder POSTs compact JSON and signs exactly the bytes it sends', async () => {
  const order = { id: 9, product_id: 161669, product_symbol: 'C-BTC-76600-041126', size: 150, unfilled_size: 150, side: 'sell', state: 'open', limit_price: '808.0', average_fill_price: null, client_order_id: 'abc' }
  const { fn, calls } = fakeFetch([{ body: { success: true, result: order } }])
  const out = await rest(fn).placeOrder({
    product_id: 161669, size: 150, side: 'sell', order_type: 'limit_order', limit_price: '808.0',
    time_in_force: 'gtc', reduce_only: false, client_order_id: 'abc',
  })
  assert.equal(out.id, 9)
  const c = calls[0]
  assert.ok(c)
  assert.equal(c.method, 'POST')
  assert.equal(c.url, 'https://dx.test/v2/orders')
  assert.equal(c.body, '{"product_id":161669,"size":150,"side":"sell","order_type":"limit_order","limit_price":"808.0","time_in_force":"gtc","reduce_only":false,"client_order_id":"abc"}')
  assert.equal(c.headers['Content-Type'], 'application/json')
  assert.equal(c.headers['signature'], signRequest('test-secret', 'POST', '/v2/orders', '', c.body, Number(TS)))
})

test('cancel and edit send the product id with the order id', async () => {
  const { fn, calls } = fakeFetch([
    { body: { success: true, result: { id: 9, state: 'cancelled' } } },
    { body: { success: true, result: { id: 9, state: 'open' } } },
  ])
  const r = rest(fn)
  await r.cancelOrder(9, 161669)
  await r.editOrder({ id: 9, productId: 161669, limitPrice: '807.5' })
  assert.equal(calls[0]?.method, 'DELETE')
  assert.equal(calls[0]?.body, '{"id":9,"product_id":161669}')
  assert.equal(calls[1]?.method, 'PUT')
  assert.equal(calls[1]?.body, '{"id":9,"product_id":161669,"limit_price":"807.5"}')
})

test('a 429 surfaces retryAfterMs from X-RATE-LIMIT-RESET', async () => {
  const { fn } = fakeFetch([
    { status: 429, body: { success: false, error: { code: 'too_many_requests' } }, headers: { 'X-RATE-LIMIT-RESET': '2500' } },
  ])
  await assert.rejects(rest(fn).walletBalances(), (e: unknown) => {
    assert.ok(e instanceof DxApiError)
    assert.equal(e.status, 429)
    assert.equal(e.retryAfterMs, 2500)
    return true
  })
})

test('both error envelopes surface a code', async () => {
  const { fn } = fakeFetch([
    { status: 400, body: { success: false, error: { code: 'insufficient_margin', context: { additional_margin_required: '1.2' } } } },
    { status: 401, body: { error: 'SignatureExpired', message: 'your signature has expired' } },
    { status: 403, body: '<html>blocked</html>' },
  ])
  const r = rest(fn)
  await assert.rejects(r.positions(), (e: unknown) => e instanceof DxApiError && e.status === 400 && e.code === 'insufficient_margin')
  await assert.rejects(r.positions(), (e: unknown) => e instanceof DxApiError && e.status === 401 && e.code === 'SignatureExpired')
  await assert.rejects(r.positions(), (e: unknown) => e instanceof DxApiError && e.status === 403 && e.code === 'http_403')
})

test('a transport failure is status 0, code network — distinguishable from a refusal', async () => {
  const { fn } = fakeFetch([new TypeError('fetch failed')])
  await assert.rejects(rest(fn).openOrders(), (e: unknown) => e instanceof DxApiError && e.status === 0 && e.code === 'network')
})

test('a signed call without credentials throws before any request', async () => {
  const { fn, calls } = fakeFetch([])
  const r = new DxRest({ baseUrl: 'https://dx.test', userAgent: 'ua', fetch: fn })
  await assert.rejects(r.openOrders(), /credentials/)
  assert.equal(calls.length, 0)
})

test('products: public, filtered, and follows the after cursor to the last page', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/products-btc.json', import.meta.url), 'utf8'))
  const [a, b, ...rest2] = fx.result
  const { fn, calls } = fakeFetch([
    { body: { success: true, result: [a, b], meta: { after: 'CUR1', before: null } } },
    { body: { success: true, result: rest2, meta: { after: null, before: 'X' } } },
  ])
  const out = await rest(fn).products({ contractTypes: ['call_options', 'put_options'], states: ['live'], underlying: ['BTC'] })
  assert.equal(out.length, fx.result.length)
  assert.equal(calls.length, 2)
  const u0 = new URL(calls[0]?.url ?? '')
  assert.equal(u0.pathname, '/v2/products')
  assert.equal(u0.searchParams.get('contract_types'), 'call_options,put_options')
  assert.equal(u0.searchParams.get('states'), 'live')
  assert.equal(u0.searchParams.get('underlying_asset_symbols'), 'BTC')
  assert.equal(u0.searchParams.get('after'), null)
  assert.equal(new URL(calls[1]?.url ?? '').searchParams.get('after'), 'CUR1')
  assert.equal(calls[0]?.headers['api-key'], undefined, 'public endpoint is not signed')
  assert.equal(calls[0]?.headers['User-Agent'], 'algomaker-dx/1')
})

test('tickers: expiryDate YYYY-MM-DD is sent as Delta\'s DD-MM-YYYY', async () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/tickers-btc-041126.json', import.meta.url), 'utf8'))
  const { fn, calls } = fakeFetch([{ body: fx }])
  const out = await rest(fn).tickers({ contractTypes: ['call_options', 'put_options'], underlying: ['BTC'], expiryDate: '2026-11-04' })
  assert.equal(out.length, 3)
  const u = new URL(calls[0]?.url ?? '')
  assert.equal(u.searchParams.get('expiry_date'), '04-11-2026')
  assert.equal(u.searchParams.get('underlying_asset_symbols'), 'BTC')
})

test('fills return the page and the next cursor', async () => {
  const { fn, calls } = fakeFetch([{ body: { success: true, result: [{ id: 'u-1', size: '10' }], meta: { after: 'NEXT' } } }])
  const out = await rest(fn).fills({ after: 'PREV' })
  assert.equal(out.fills.length, 1)
  assert.equal(out.after, 'NEXT')
  assert.equal(new URL(calls[0]?.url ?? '').searchParams.get('after'), 'PREV')
})

test('heartbeat create registers a cancel-orders switch on BTC options; ack sends the ttl', async () => {
  const { fn, calls } = fakeFetch([{ body: { success: true, result: {} } }, { body: { success: true, result: {} } }])
  const r = rest(fn, { heartbeatId: 'dx-desk' })
  await r.heartbeat('create', 30000)
  await r.heartbeat('ack', 30000)
  assert.equal(calls[0]?.url, 'https://dx.test/v2/heartbeat/create')
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), {
    heartbeat_id: 'dx-desk', impact: 'contracts', contract_types: ['call_options', 'put_options'],
    underlying_assets: ['BTC'], config: [{ action: 'cancel_orders', unhealthy_count: 1 }], default_ttl: 30000,
  })
  assert.equal(calls[1]?.url, 'https://dx.test/v2/heartbeat')
  assert.deepEqual(JSON.parse(calls[1]?.body ?? ''), { heartbeat_id: 'dx-desk', ttl: 30000 })
})
