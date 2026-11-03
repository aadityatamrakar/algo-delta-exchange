/**
 * THE DEMO RAIL — a paper book's orders worked on Delta's India testnet.
 *
 * Three things are pinned here, and each is a way the rail could lie:
 *
 *   PRODUCT IDS. Testnet ids are not production's. The desk's instrument
 *   token IS the production id, so an order sent with it names some other
 *   contract on testnet, or none. The rail maps by `tradingsymbol` through
 *   testnet's own `/v2/products`, cached, and REFUSES a symbol testnet does
 *   not list — with the reason in the error the placer journals.
 *
 *   TOKENS BACK. What comes back from testnet carries testnet's id; the fill
 *   watcher compares tokens against the document's production token. So every
 *   update is translated back before it leaves the rail.
 *
 *   NO RAIL, NO ORDER. Unconfigured demo credentials refuse the order — they
 *   never fall through to the simulator, and never to production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrokerOrderError, type PlacedOrder } from '@algomaker/brokers'
import type { OrderIntent } from '@algomaker/order-bus'
import type { DxOrder, DxOrderRequest, DxProduct } from '@algomaker/dx'
import { DemoRail, createAdapterRouter, type DemoRest } from '../src/dx-demo.ts'
import type { DxConfig } from '../src/dx-config.ts'

const PROD_TOKEN = 161669
const TESTNET_ID = 52001
const SYMBOL = 'C-BTC-77000-041126'
const T0 = 1_793_690_000_000

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  clientOrderId: 'bs-d1-L3-ce-sell',
  ts: T0,
  strategyTag: 'BULL-S',
  mode: 'sim',
  destinations: ['xts'],
  instrument: { tradingsymbol: SYMBOL, instrumentToken: PROD_TOKEN, lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA' },
  side: 'SELL',
  orderType: 'LIMIT',
  quantity: 0.002,
  lots: 2,
  limitPrice: 805,
  ...over,
})

const product = (symbol: string, id: number): DxProduct => ({
  id,
  symbol,
  contract_type: 'call_options',
  contract_value: '0.001',
  tick_size: '0.1',
})

const CFG: DxConfig = {
  baseUrl: 'https://cdn-ind.testnet.deltaex.org',
  wsUrl: 'wss://socket-ind.testnet.deltaex.org',
  apiKey: 'DK',
  apiSecret: 'DS',
  source: 'broker-store',
}

interface Fake extends DemoRest {
  placed: DxOrderRequest[]
  productCalls: number
  listing: DxProduct[]
}

function fakeRest(): Fake {
  const orderOf = (req: DxOrderRequest): DxOrder => ({
    id: 7001,
    product_id: req.product_id ?? 0,
    product_symbol: SYMBOL,
    size: req.size,
    unfilled_size: req.size,
    side: req.side,
    order_type: req.order_type,
    limit_price: req.limit_price ?? null,
    average_fill_price: null,
    state: 'open',
    client_order_id: req.client_order_id ?? null,
  })
  const f: Fake = {
    placed: [],
    productCalls: 0,
    listing: [product(SYMBOL, TESTNET_ID), product('P-BTC-70000-041126', 52002)],
    async placeOrder(o) {
      f.placed.push(o)
      return orderOf(o)
    },
    async cancelOrder(id, productId) {
      return { ...orderOf({ product_id: productId, size: 2, side: 'sell', order_type: 'limit_order' }), id, state: 'cancelled' }
    },
    async editOrder(o) {
      return { ...orderOf({ product_id: o.productId, size: 2, side: 'sell', order_type: 'limit_order' }), id: o.id }
    },
    async openOrders() {
      return [{ ...orderOf({ product_id: TESTNET_ID, size: 2, side: 'sell', order_type: 'limit_order' }), unfilled_size: 1 }]
    },
    async orderHistory() {
      return []
    },
    async positions() {
      return []
    },
    async products() {
      f.productCalls++
      return f.listing
    },
    async fills() {
      return { fills: [] }
    },
    async heartbeat() {},
  }
  return f
}

function rail(opts: { rest?: Fake; load?: () => Promise<DxConfig>; now?: () => number } = {}) {
  const rest = opts.rest ?? fakeRest()
  const built: DxConfig[] = []
  const r = new DemoRail({
    loadConfig: opts.load ?? (async () => CFG),
    makeRest: (cfg) => {
      built.push(cfg)
      return rest
    },
    now: opts.now ?? (() => T0),
    log: () => {},
  })
  return { r, rest, built }
}

test('a listed symbol is placed under its TESTNET product id, not the production token', async () => {
  const { r, rest, built } = rail()
  const placed = await r.placeOrder(intent())
  assert.equal(rest.placed.length, 1)
  assert.equal(rest.placed[0]?.product_id, TESTNET_ID)
  assert.equal(rest.placed[0]?.size, 2)
  // The rail was built from the demo config, once.
  assert.deepEqual(built, [CFG])
  // And what comes back names the PRODUCTION token again, for the fill watcher.
  assert.equal(placed.exchangeToken, PROD_TOKEN)
  assert.equal(placed.clientOrderId, 'bs-d1-L3-ce-sell')
})

test('the testnet listing is cached — one products call for many orders', async () => {
  const { r, rest } = rail()
  await r.placeOrder(intent())
  await r.placeOrder(intent({ clientOrderId: 'x2' }))
  await r.placeOrder(intent({ clientOrderId: 'x3' }))
  assert.equal(rest.productCalls, 1)
})

test('a symbol testnet does not list is REFUSED, fatal, with the reason — nothing is sent', async () => {
  let now = T0
  const { r, rest } = rail({ now: () => now })
  await assert.rejects(
    () => r.placeOrder(intent({ instrument: { ...intent().instrument, tradingsymbol: 'C-BTC-99000-041126' } })),
    (err: unknown) => {
      assert.ok(err instanceof BrokerOrderError)
      assert.equal(err.klass, 'fatal')
      assert.match(err.message, /C-BTC-99000-041126 is not listed on the Delta testnet/)
      return true
    },
  )
  assert.equal(rest.placed.length, 0)
  // A miss re-reads the listing (a new listing may have appeared), but not
  // on every order: at most once a minute.
  const calls = rest.productCalls
  await assert.rejects(() => r.placeOrder(intent({ instrument: { ...intent().instrument, tradingsymbol: 'C-BTC-99000-041126' } })))
  assert.equal(rest.productCalls, calls)
  now += 61_000
  rest.listing = [...rest.listing, product('C-BTC-99000-041126', 52099)]
  await r.placeOrder(intent({ instrument: { ...intent().instrument, tradingsymbol: 'C-BTC-99000-041126' } }))
  assert.equal(rest.placed.at(-1)?.product_id, 52099)
})

test('unconfigured demo credentials refuse the order, fatal — never the simulator, never production', async () => {
  let attempts = 0
  let now = T0
  const { r, rest } = rail({
    now: () => now,
    load: async () => {
      attempts++
      throw new Error('Delta demo is not configured: apiKey/DX_DEMO_API_KEY')
    },
  })
  await assert.rejects(
    () => r.placeOrder(intent()),
    (err: unknown) => {
      assert.ok(err instanceof BrokerOrderError)
      assert.equal(err.klass, 'fatal')
      assert.match(err.message, /demo rail is not available.*not configured/)
      return true
    },
  )
  assert.equal(rest.placed.length, 0)
  assert.equal(r.ready, false)
  // Not re-tried on every order...
  await assert.rejects(() => r.placeOrder(intent()))
  assert.equal(attempts, 1)
  // ...but again after the back-off, so saving the credentials needs no restart.
  now += 31_000
  await assert.rejects(() => r.placeOrder(intent()))
  assert.equal(attempts, 2)
})

test('order updates from the demo socket come back as PlacedOrders with the production token', async () => {
  const { r } = rail()
  const seen: PlacedOrder[] = []
  r.onOrderUpdate((u) => seen.push(u))
  await r.placeOrder(intent())
  r.onPrivateFrame({
    type: 'orders',
    action: 'update',
    order_id: 7001,
    product_id: TESTNET_ID,
    product_symbol: SYMBOL,
    size: 2,
    unfilled_size: 0,
    state: 'closed',
    average_fill_price: '806.5',
    client_order_id: 'bs-d1-L3-ce-sell',
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.status, 'FILLED')
  assert.equal(seen[0]?.filledQty, 0.002)
  assert.equal(seen[0]?.exchangeToken, PROD_TOKEN)
})

test('a testnet id this rail never placed is dropped from the update rather than passed as a production token', async () => {
  const { r } = rail()
  await r.placeOrder(intent())
  const book = await r.orderBook()
  assert.equal(book[0]?.exchangeToken, PROD_TOKEN)
  const seen: PlacedOrder[] = []
  r.onOrderUpdate((u) => seen.push(u))
  r.onPrivateFrame({ type: 'orders', action: 'update', order_id: 7999, product_id: 55555, product_symbol: 'X', size: 1, unfilled_size: 1, state: 'open' })
  assert.equal(seen[0]?.exchangeToken, undefined)
})

test('the order book builds the rail on demand; with no rail it THROWS — an empty book would un-book ambiguous orders', async () => {
  const { r } = rail()
  assert.equal(r.ready, false)
  assert.equal((await r.orderBook()).length, 1)
  assert.equal(r.ready, true)
  const down = rail({ load: async () => { throw new Error('not configured') } })
  await assert.rejects(() => down.r.orderBook(), /demo rail is not available/)
})

test('onBuilt runs once, with the REST client and the config, so the socket and sweep start with the rail', async () => {
  const rest = fakeRest()
  const calls: DxConfig[] = []
  const r = new DemoRail({
    loadConfig: async () => CFG,
    makeRest: () => rest,
    onBuilt: (b) => { calls.push(b.cfg); assert.equal(b.rest, rest) },
    now: () => T0,
    log: () => {},
  })
  await Promise.all([r.ensure(), r.ensure(), r.placeOrder(intent())])
  assert.deepEqual(calls, [CFG])
  assert.equal(r.rest, rest)
})

// ------------------------------------------------------- the per-order router

const LIVE_ENV = { DESK_BROKER: 'delta', DESK_DX_LIVE: '1' }

function router(over: { env?: Record<string, string>; book?: (tag: string) => Promise<'sim' | 'demo'>; stamp?: (doc: Record<string, unknown>, rail: 'sim' | 'demo') => Promise<void>; demo?: boolean; live?: boolean } = {}) {
  const sim = { name: 'sim', placeOrder: async () => { throw new Error('sim') } }
  const live = { name: 'live', placeOrder: async () => { throw new Error('live') } }
  const demo = { name: 'demo', placeOrder: async () => { throw new Error('demo') } }
  const reads: string[] = []
  const stamps: [unknown, string][] = []
  const route = createAdapterRouter({
    env: over.env ?? {},
    simulator: sim,
    live: over.live === false ? null : live,
    demo: over.demo === false ? null : demo,
    bookRail: async (tag) => {
      reads.push(tag)
      return over.book === undefined ? 'sim' : await over.book(tag)
    },
    stamp: async (doc, rail) => {
      stamps.push([doc['clientOrderId'], rail])
      if (over.stamp !== undefined) await over.stamp(doc, rail)
    },
  })
  return { route, sim, live, demo, reads, stamps }
}

test('router: a paper order on a demo book goes to the demo rail, and the document is stamped demo', async () => {
  const r = router({ book: async () => 'demo' })
  assert.equal(await r.route({ clientOrderId: 'o1', tag: 'BK', mode: 'paper' }), r.demo)
  assert.deepEqual(r.reads, ['BK'])
  assert.deepEqual(r.stamps, [['o1', 'demo']])
})

test('router: a paper order on a sim book goes to the simulator, stamped sim', async () => {
  const r = router()
  assert.equal(await r.route({ clientOrderId: 'o1', tag: 'BK', mode: 'paper' }), r.sim)
  assert.deepEqual(r.stamps, [['o1', 'sim']])
})

test('router: a stamped document keeps its rail — the book is not read, nothing is re-stamped', async () => {
  const r = router({ book: async () => 'sim' })
  assert.equal(await r.route({ clientOrderId: 'o1', tag: 'BK', mode: 'paper', dx_paper_rail: 'demo' }), r.demo)
  assert.deepEqual(r.reads, [])
  assert.deepEqual(r.stamps, [])
})

test('router: a LIVE order goes to production with the live rail on, the simulator without — never demo, book never read', async () => {
  const on = router({ env: LIVE_ENV, book: async () => 'demo' })
  assert.equal(await on.route({ clientOrderId: 'o1', tag: 'BK', mode: 'live', dx_paper_rail: 'demo' }), on.live)
  const off = router({ book: async () => 'demo' })
  assert.equal(await off.route({ clientOrderId: 'o1', tag: 'BK', mode: 'live' }), off.sim)
  assert.deepEqual([...on.reads, ...off.reads], [])
  assert.deepEqual([...on.stamps, ...off.stamps], [])
})

test('router: with no demo rail (not the Delta venue) nothing is read or stamped', async () => {
  const r = router({ demo: false, book: async () => 'demo' })
  assert.equal(await r.route({ clientOrderId: 'o1', tag: 'BK', mode: 'paper' }), r.sim)
  assert.deepEqual(r.reads, [])
  assert.deepEqual(r.stamps, [])
})

test('router: an unreadable book rail or a failed stamp REFUSES the order, fatal, with the reason', async () => {
  for (const r of [
    router({ book: async () => { throw new Error('mongo down') } }),
    router({ book: async () => 'demo', stamp: async () => { throw new Error('write refused') } }),
  ]) {
    const a = await r.route({ clientOrderId: 'o1', tag: 'BK', mode: 'paper' })
    assert.notEqual(a, r.sim)
    assert.notEqual(a, r.demo)
    await assert.rejects(
      () => a.placeOrder(intent()),
      (err: unknown) => {
        assert.ok(err instanceof BrokerOrderError)
        assert.equal(err.klass, 'fatal')
        assert.match(err.message, /paper rail .*(mongo down|write refused)/)
        return true
      },
    )
  }
})
