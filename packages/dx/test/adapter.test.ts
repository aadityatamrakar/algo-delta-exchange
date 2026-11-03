import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrokerOrderError, type PlacedOrder } from '@algomaker/brokers'
import type { OrderIntent } from '@algomaker/order-bus'
import {
  DxAdapter,
  DxApiError,
  DxOrderError,
  dxClientOrderId,
  type DxOrder,
  type DxOrderRequest,
  type DxTradingClient,
} from '../src/index.ts'

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  clientOrderId: 'bs-d1-L3-ce-sell',
  ts: 1793690000000,
  strategyTag: 'BULL-S',
  mode: 'live',
  destinations: ['xts'],
  instrument: { tradingsymbol: 'C-BTC-76600-041126', instrumentToken: 161669, lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA' },
  side: 'SELL',
  orderType: 'LIMIT',
  quantity: 0.15,
  lots: 150,
  limitPrice: 808.04,
  ...over,
})

const orderOf = (req: DxOrderRequest, over: Partial<DxOrder> = {}): DxOrder => ({
  id: 9001,
  product_id: req.product_id ?? 0,
  product_symbol: 'C-BTC-76600-041126',
  size: req.size,
  unfilled_size: req.size,
  side: req.side,
  order_type: req.order_type,
  limit_price: req.limit_price ?? null,
  average_fill_price: null,
  state: 'open',
  client_order_id: req.client_order_id ?? null,
  reduce_only: req.reduce_only ?? false,
  ...over,
})

interface Fake extends DxTradingClient {
  placed: DxOrderRequest[]
  edits: { id: number; productId: number; limitPrice: string }[]
  cancels: { id: number; productId: number }[]
  placeQueue: (Error | ((r: DxOrderRequest) => DxOrder))[]
}

function fakeRest(over: Partial<DxTradingClient> = {}): Fake {
  const f: Fake = {
    placed: [],
    edits: [],
    cancels: [],
    placeQueue: [],
    async placeOrder(o) {
      f.placed.push(o)
      const next = f.placeQueue.shift()
      if (next instanceof Error) throw next
      return next ? next(o) : orderOf(o)
    },
    async cancelOrder(id, productId) {
      f.cancels.push({ id, productId })
      return { ...orderOf({ product_id: productId, size: 150, side: 'sell', order_type: 'limit_order' }), id, state: 'cancelled' }
    },
    async editOrder(o) {
      f.edits.push(o)
      return { ...orderOf({ product_id: o.productId, size: 150, side: 'sell', order_type: 'limit_order' }), id: o.id, limit_price: o.limitPrice }
    },
    async openOrders() { return [] },
    async orderHistory() { return [] },
    async positions() { return [] },
    ...over,
  }
  return f
}

const sleeps: number[] = []
const adapter = (rest: DxTradingClient) => new DxAdapter({ rest, sleep: async (ms) => { sleeps.push(ms) } })

test('a 0.15 BTC sell goes out as size 150, limit only, price a string on the tick (sell rounds up)', async () => {
  const rest = fakeRest()
  const placed = await adapter(rest).placeOrder(intent())
  assert.deepEqual(rest.placed[0], {
    product_id: 161669,
    size: 150,
    side: 'sell',
    order_type: 'limit_order',
    limit_price: '808.1',
    time_in_force: 'gtc',
    reduce_only: false,
    client_order_id: 'bs-d1-L3-ce-sell',
  })
  assert.equal(placed.brokerOrderId, '9001')
  assert.equal(placed.clientOrderId, 'bs-d1-L3-ce-sell')
  assert.equal(placed.status, 'WORKING')
  assert.equal(placed.filledQty, 0)
  assert.equal(placed.tradingsymbol, 'C-BTC-76600-041126')
  assert.equal(placed.exchangeToken, 161669)
})

test('a buy rounds its limit down (never pays more than asked); tick decimals are kept', async () => {
  const rest = fakeRest()
  await adapter(rest).placeOrder(intent({ side: 'BUY', limitPrice: 812.96 }))
  assert.equal(rest.placed[0]?.side, 'buy')
  assert.equal(rest.placed[0]?.limit_price, '812.9')
  await adapter(rest).placeOrder(intent({ side: 'BUY', limitPrice: 813 }))
  assert.equal(rest.placed[1]?.limit_price, '813.0')
})

test('closes go out reduce_only', async () => {
  const rest = fakeRest()
  await adapter(rest).placeOrder(intent({ side: 'BUY', meta: { reduceOnly: true } }))
  await adapter(rest).placeOrder(intent({ side: 'BUY', meta: { desk_op: 'close' } }))
  assert.equal(rest.placed[0]?.reduce_only, true)
  assert.equal(rest.placed[1]?.reduce_only, true)
})

test('refuses a non-step quantity, a lots/contracts mismatch, zero, and non-limit orders — nothing is sent', async () => {
  const rest = fakeRest()
  const a = adapter(rest)
  const fatal = (e: unknown) => e instanceof DxOrderError && e.klass === 'fatal'
  await assert.rejects(a.placeOrder(intent({ quantity: 0.0005, lots: 0 })), fatal)
  await assert.rejects(a.placeOrder(intent({ quantity: 0.15, lots: 15 })), fatal)
  await assert.rejects(a.placeOrder(intent({ quantity: 0, lots: 0 })), fatal)
  await assert.rejects(a.placeOrder(intent({ orderType: 'MARKET' })), fatal)
  const { limitPrice: _drop, ...noPrice } = intent()
  await assert.rejects(a.placeOrder(noPrice as OrderIntent), fatal)
  await assert.rejects(a.placeOrder(intent({ side: 'BUY', limitPrice: 0.04 })), fatal, 'a buy below one tick rounds to 0')
  assert.equal(rest.placed.length, 0)
})

test('a 45-char client id maps to a stable 32-char Delta id; the desk still sees its own id', async () => {
  const long = 'bulls-btc-daily-jump1-L12-ce-sell-1793690000x'
  assert.equal(long.length, 45)
  const dx = dxClientOrderId(long)
  assert.equal(dx.length, 32)
  assert.match(dx, /^[A-Za-z0-9_-]+$/)
  assert.equal(dxClientOrderId(long), dx, 'stable')
  assert.notEqual(dxClientOrderId(long.replace('ce', 'pe')), dx)
  assert.equal(dxClientOrderId('short-id_1'), 'short-id_1', 'a short clean id passes through')
  assert.equal(dxClientOrderId('has space').length, 32, 'an id with a foreign char is hashed')

  const rest = fakeRest()
  const placed = await adapter(rest).placeOrder(intent({ clientOrderId: long }))
  assert.equal(rest.placed[0]?.client_order_id, dx)
  assert.equal(placed.clientOrderId, long)
})

test('a 429 backs off for X-RATE-LIMIT-RESET and retries (a 429 proves nothing was placed)', async () => {
  sleeps.length = 0
  const rest = fakeRest()
  rest.placeQueue.push(new DxApiError({ status: 429, code: 'rate_limited', message: 'slow down', retryAfterMs: 1800 }))
  const placed = await adapter(rest).placeOrder(intent())
  assert.equal(rest.placed.length, 2)
  assert.deepEqual(sleeps, [1800])
  assert.equal(placed.status, 'WORKING')
})

test('429 on every attempt ends transient, not unknown', async () => {
  const rest = fakeRest()
  for (let i = 0; i < 5; i++) rest.placeQueue.push(new DxApiError({ status: 429, code: 'rate_limited', message: 'x' }))
  await assert.rejects(adapter(rest).placeOrder(intent()), (e: unknown) => e instanceof DxOrderError && e.klass === 'transient')
  assert.equal(rest.placed.length, 3)
})

test('a transport failure or 5xx is UNKNOWN and is never retried; a 400 is fatal', async () => {
  for (const [err, klass] of [
    [new DxApiError({ status: 0, code: 'network', message: 'fetch failed' }), 'unknown'],
    [new DxApiError({ status: 503, code: 'http_503', message: 'maintenance' }), 'unknown'],
    [new DxApiError({ status: 400, code: 'insufficient_margin', message: 'insufficient_margin' }), 'fatal'],
  ] as const) {
    const rest = fakeRest()
    rest.placeQueue.push(err)
    await assert.rejects(adapter(rest).placeOrder(intent()), (e: unknown) => {
      assert.ok(e instanceof DxOrderError)
      assert.equal(e.klass, klass)
      // The gateway reads the class off BrokerOrderError; DxOrderError must be one.
      assert.ok(e instanceof BrokerOrderError)
      return true
    })
    assert.equal(rest.placed.length, 1)
  }
})

test('orders frames from the private socket become PlacedOrder updates in BTC, under the desk id', async () => {
  const long = 'bulls-btc-daily-jump1-L12-ce-sell-1793690000x'
  const rest = fakeRest()
  const a = adapter(rest)
  const seen: PlacedOrder[] = []
  a.onOrderUpdate((o) => seen.push(o))
  await a.placeOrder(intent({ clientOrderId: long }))
  const base = {
    type: 'orders', symbol: 'C-BTC-76600-041126', order_id: 9001, id: 9001, client_order_id: dxClientOrderId(long),
    product_id: 161669, product_symbol: 'C-BTC-76600-041126', size: 150, side: 'sell', limit_price: '808.1',
  }
  a.onPrivateFrame({ ...base, action: 'update', reason: 'fill', unfilled_size: 100, average_fill_price: '808.1', state: 'open' })
  a.onPrivateFrame({ ...base, action: 'update', reason: 'fill', unfilled_size: 0, average_fill_price: '808.1', state: 'closed' })
  assert.equal(seen.length, 2)
  assert.equal(seen[0]?.status, 'PARTIALLY_FILLED')
  assert.equal(seen[0]?.filledQty, 0.05)
  assert.equal(seen[1]?.status, 'FILLED')
  assert.equal(seen[1]?.filledQty, 0.15)
  assert.equal(seen[1]?.avgPrice, 808.1)
  assert.equal(seen[1]?.clientOrderId, long)
  assert.equal(seen[1]?.brokerOrderId, '9001')
  // snapshot frames carry a result array
  a.onPrivateFrame({ type: 'orders', action: 'snapshot', result: [{ ...base, unfilled_size: 150, state: 'cancelled' }] })
  assert.equal(seen[2]?.status, 'CANCELLED')
  // other channels are ignored here
  a.onPrivateFrame({ type: 'positions', action: 'update', size: -150 })
  assert.equal(seen.length, 3)
})

test('positions are signed BTC on the 0.001 grid', async () => {
  const rest = fakeRest({
    async positions() {
      return [
        { product_id: 161669, product_symbol: 'C-BTC-76600-041126', size: -150, entry_price: '808.1' },
        { product_id: 161668, product_symbol: 'P-BTC-76600-041126', size: 3, entry_price: '793' },
      ]
    },
  })
  assert.deepEqual(await adapter(rest).positions(), [
    { tradingsymbol: 'C-BTC-76600-041126', netQty: -0.15, avgPrice: 808.1 },
    { tradingsymbol: 'P-BTC-76600-041126', netQty: 0.003, avgPrice: 793 },
  ])
})

test('modify reprices on the tick with the remembered product; cancel likewise; unknown ids look up the open book', async () => {
  const rest = fakeRest({
    async openOrders() {
      return [{ ...orderOf({ product_id: 161668, size: 10, side: 'buy', order_type: 'limit_order', limit_price: '790.0' }), id: 77, product_symbol: 'P-BTC-76600-041126' }]
    },
  })
  const a = adapter(rest)
  await a.placeOrder(intent())
  assert.equal(await a.modifyOrder('9001', 807.97), true)
  assert.deepEqual(rest.edits[0], { id: 9001, productId: 161669, limitPrice: '808.0' })
  assert.equal(await a.cancelOrder('9001'), true)
  assert.deepEqual(rest.cancels[0], { id: 9001, productId: 161669 })
  // not placed by this process (e.g. after a restart): found in the open book
  assert.equal(await a.modifyOrder('77', 791.04), true)
  assert.deepEqual(rest.edits[1], { id: 77, productId: 161668, limitPrice: '791.0' })
  assert.equal(await a.cancelOrder('12345'), false, 'an order nowhere in the open book is not cancellable')
})

test('a refused modify is false, not a throw; a transport failure throws', async () => {
  const rest = fakeRest({
    async editOrder() { throw new DxApiError({ status: 400, code: 'open_order_not_found', message: 'gone' }) },
    async cancelOrder() { throw new DxApiError({ status: 0, code: 'network', message: 'down' }) },
  })
  const a = adapter(rest)
  await a.placeOrder(intent())
  assert.equal(await a.modifyOrder('9001', 808), false)
  await assert.rejects(a.cancelOrder('9001'), DxApiError)
})

test('orderBook lists open and recent orders with BTC fills and the desk id where known', async () => {
  const rest = fakeRest({
    async orderHistory() {
      return [{ ...orderOf({ product_id: 161669, size: 150, side: 'sell', order_type: 'limit_order', client_order_id: 'bs-d1-L3-ce-sell' }), id: 5, unfilled_size: 0, state: 'closed', average_fill_price: '808.1' }]
    },
  })
  const book = await adapter(rest).orderBook()
  assert.deepEqual(book, [{
    brokerOrderId: '5', clientOrderId: 'bs-d1-L3-ce-sell', tradingsymbol: 'C-BTC-76600-041126',
    status: 'FILLED', filledQty: 0.15, avgPrice: 808.1, exchangeToken: 161669,
  }])
})
