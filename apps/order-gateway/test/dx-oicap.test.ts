import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter, type PlacedOrder } from '@algomaker/brokers'
import { FreezeLimits } from '@algomaker/instruments'
import type { OrderIntent } from '@algomaker/order-bus'
import type { DxOrder, DxProduct, DxTicker } from '@algomaker/dx'
import { FakeCollection, FakeFills, FakeJournal } from './mongo-harness.ts'
import { createOrderPlacer } from '../src/main.ts'
import { OrderQueue, createSweeper } from '../src/queue.ts'
import { FillWatcher } from '../src/fills.ts'
import { OrderJournal } from '../src/journal.ts'
import type { ResolvedContract } from '../src/gateway.ts'
import { DemoRail, type DemoRest } from '../src/dx-demo.ts'
import type { DxConfig } from '../src/dx-config.ts'
import {
  OiCapGate,
  decisionIdOf,
  demoOiCapSource,
  liveOiCapSource,
  type MasterCap,
  type OiCapSource,
  type PackageLeg,
} from '../src/dx-oicap.ts'

/**
 * Delta's per-product OI cap, checked for the WHOLE opening package before
 * its first leg is sent. OI value = oi contracts × 0.001 × index. The 3 Nov
 * 2026 testnet case: the straddle's put was under its cap and filled; the call
* (55,371 contracts × 0.001 × 76,462 ≈ $4.23M, cap $2,000,000) was
 * rejected — a half straddle.
 */

const PE = 'P-BTC-77200-041126'
const CE = 'C-BTC-77200-041126'
const CE_TOKEN = 161400
const PE_TOKEN = 161401
const NOW = 1_793_696_000_000
const INDEX = 76_462

/** The live source over a master and a tick map, as main wires it: no IO at all. */
function live(capped: ReadonlySet<string>, opts: { flag?: boolean } = {}) {
  const caps = new Map<string, MasterCap>([
    [CE, { token: CE_TOKEN, lotSize: 0.001, capUsd: 2_000_000, reduceOnly: capped.has(CE) && opts.flag !== false }],
    [PE, { token: PE_TOKEN, lotSize: 0.001, capUsd: 2_000_000, reduceOnly: capped.has(PE) && opts.flag !== false }],
  ])
  // capped: 55,371 contracts (≈ $4.23M at the index); else 1,401 (≈ $107k)
  const oi = new Map<number, number>([
    [CE_TOKEN, capped.has(CE) ? 55_371 : 1_401],
    [PE_TOKEN, capped.has(PE) ? 55_371 : 1_401],
  ])
  return liveOiCapSource({ capOf: (s) => caps.get(s) ?? null, oiContractsOf: (t) => oi.get(t) ?? null, index: () => INDEX })
}

const straddle: readonly PackageLeg[] = [
  { tradingsymbol: PE, op: 'open', qty: 0.005 },
  { tradingsymbol: CE, op: 'open', qty: 0.005 },
]

function gate(
  src: OiCapSource | null,
  opts: { pkg?: readonly PackageLeg[] | null | Error; clock?: { t: number }; failClosed?: (rail: string) => boolean } = {},
) {
  const clock = opts.clock ?? { t: NOW }
  const logs: { m: string; ctx?: Record<string, unknown> }[] = []
  const loads: string[] = []
  const g = new OiCapGate({
    sourceFor: (rail) => (rail === 'demo' || rail === 'live' ? src : null),
    loadPackage: async (id) => {
      loads.push(id)
      if (opts.pkg instanceof Error) throw opts.pkg
      return opts.pkg === undefined ? straddle : opts.pkg
    },
    index: () => INDEX,
    // As main wires it: live fails closed, demo open.
    failClosed: opts.failClosed ?? ((rail) => rail === 'live'),
    now: () => clock.t,
    log: (m, ctx) => void logs.push({ m, ...(ctx === undefined ? {} : { ctx }) }),
  })
  return { g, logs, loads, clock }
}

const openOrder = (symbol: string) => ({ tradingsymbol: symbol, quantity: 0.005, desk_op: 'open' })

test('decisionIdOf: <decisionId>#<leg>, tranche suffix stripped', () => {
  assert.equal(decisionIdOf('dec-abc#1'), 'dec-abc')
  assert.equal(decisionIdOf('dec-abc#1.2'), 'dec-abc')
  assert.equal(decisionIdOf('manual-1'), null)
})

test('live: a capped CE refuses EVERY leg of the package, from master + md.tick + md.spot alone', async () => {
  const { g } = gate(live(new Set([CE])))
  const pe = await g.refusal(openOrder(PE), 'dec-1#0', 'live')
  const ce = await g.refusal(openOrder(CE), 'dec-1#1', 'live')
  assert.match(String(pe), /^oi-cap: C-BTC-77200-041126 OI \$4,233,777 ≥ cap \$2,000,000 — Delta accepts reduce-only only/)
  assert.match(String(pe), /P-BTC-77200-041126 is refused with it/)
  assert.match(String(ce), /^oi-cap: C-BTC-77200-041126 OI \$4,233,777 ≥ cap \$2,000,000/)
  assert.match(String(ce), /no leg sent/)
})

test('live: an uncapped package passes', async () => {
  const { g } = gate(live(new Set()))
  assert.equal(await g.refusal(openOrder(PE), 'dec-2#0', 'live'), null)
  assert.equal(await g.refusal(openOrder(CE), 'dec-2#1', 'live'), null)
})

test('a listed cap with NO reduce-only flag is still enforced, and the log says which rule applied', async () => {
  const { g, logs } = gate(live(new Set([CE]), { flag: false }))
  assert.match(String(await g.refusal(openOrder(CE), 'dec-3#1', 'live')), /^oi-cap: C-BTC-77200-041126/)
  const refused = logs.find((l) => l.m === 'oi-cap: package refused')
  assert.equal(refused?.ctx?.['basis'], 'cap')
  const flagged = gate(live(new Set([CE])))
  await flagged.g.refusal(openOrder(CE), 'dec-3b#1', 'live')
  assert.equal(flagged.logs.find((l) => l.m === 'oi-cap: package refused')?.ctx?.['basis'], 'flag')
})

test('the flag on its own refuses when the OI is not on hand (no tick yet)', async () => {
  const caps = new Map<string, MasterCap>([[CE, { token: CE_TOKEN, lotSize: 0.001, capUsd: 2_000_000, reduceOnly: true }]])
  const src = liveOiCapSource({ capOf: (s) => caps.get(s) ?? null, oiContractsOf: () => null, index: () => INDEX })
  const { g, logs } = gate(src, { pkg: null })
  assert.match(String(await g.refusal(openOrder(CE), 'm-1', 'live')), /oi-cap: C-BTC-77200-041126 OI over its cap \(figures not on hand\)/)
  assert.equal(logs.find((l) => l.m === 'oi-cap: package refused')?.ctx?.['basis'], 'flag-no-figures')
})

test('closes and other reducing ops are never blocked, and read nothing', async () => {
  let reads = 0
  const src: OiCapSource = { async figures() { reads++; return new Map() } }
  const { g, loads } = gate(src)
  for (const op of ['close', 'roll', 'resize']) {
    assert.equal(await g.refusal({ tradingsymbol: CE, quantity: 0.005, desk_op: op }, 'dec-4#0', 'live'), null)
  }
  assert.equal(reads, 0)
  assert.deepEqual(loads, [])
})

test('a closing leg in the package is not checked against its (capped) product', async () => {
  const { g } = gate(live(new Set([CE])), {
    pkg: [{ tradingsymbol: CE, op: 'close', qty: 0.005 }, { tradingsymbol: PE, op: 'open', qty: 0.005 }],
  })
  assert.equal(await g.refusal(openOrder(PE), 'dec-5#1', 'live'), null)
})

test('the simulator rail and a rail with no source are not checked', async () => {
  const { g } = gate(live(new Set([CE])))
  assert.equal(await g.refusal(openOrder(CE), 'dec-6#0', 'sim'), null)
  assert.equal(await g.refusal(openOrder(CE), 'dec-6#0', null), null)
  assert.equal(await gate(null).g.refusal(openOrder(CE), 'dec-6#0', 'demo'), null)
})

test('the verdict is decided once per package: the second leg reads nothing and gets the same answer', async () => {
  let reads = 0
  const inner = live(new Set())
  const src: OiCapSource = { figures: (s) => { reads++; return inner.figures(s) } }
  const { g, loads } = gate(src)
  assert.equal(await g.refusal(openOrder(PE), 'dec-7#0', 'live'), null)
  assert.equal(await g.refusal(openOrder(CE), 'dec-7#1', 'live'), null)
  assert.equal(reads, 1)
  assert.deepEqual(loads, ['dec-7'])
})

test('a manual order with no plan is a package of one', async () => {
  const { g } = gate(live(new Set([CE])), { pkg: null })
  assert.match(String(await g.refusal(openOrder(CE), 'manual-ce', 'live')), /^oi-cap: C-BTC-77200-041126/)
  assert.equal(await g.refusal(openOrder(PE), 'manual-pe', 'live'), null)
})

test('DEMO: a failed read lets the order through and says so', async () => {
  const src: OiCapSource = { async figures() { throw new Error('fetch failed') } }
  const { g, logs } = gate(src)
  assert.equal(await g.refusal(openOrder(PE), 'dec-8#0', 'demo'), null)
  assert.ok(logs.some((l) => /lookup failed, not blocking/.test(l.m)))
})

test('LIVE fails closed: a read that throws refuses every leg of the opening package', async () => {
  const src: OiCapSource = { async figures() { throw new Error('master not loaded') } }
  const { g } = gate(src)
  const pe = await g.refusal(openOrder(PE), 'dec-20#0', 'live')
  const ce = await g.refusal(openOrder(CE), 'dec-20#1', 'live')
  assert.match(String(pe), /^oi-cap: lookup failed — cap figures could not be read: master not loaded/)
  assert.match(String(pe), /no leg sent/)
  assert.match(String(ce), /^oi-cap: lookup failed/)
})

test('LIVE fails closed: a leg with no cap on record refuses the package', async () => {
  const caps = new Map<string, MasterCap>([[PE, { token: PE_TOKEN, lotSize: 0.001, capUsd: 2_000_000, reduceOnly: false }]])
  const src = liveOiCapSource({ capOf: (s) => caps.get(s) ?? null, oiContractsOf: () => 1_401, index: () => INDEX })
  const { g } = gate(src)
  assert.match(String(await g.refusal(openOrder(PE), 'dec-21#0', 'live')), /^oi-cap: lookup failed — C-BTC-77200-041126 has no cap on record/)
})

test('LIVE fails closed: a listed cap with no OI on hand (no tick yet) refuses', async () => {
  const caps = new Map<string, MasterCap>([
    [CE, { token: CE_TOKEN, lotSize: 0.001, capUsd: 2_000_000, reduceOnly: false }],
    [PE, { token: PE_TOKEN, lotSize: 0.001, capUsd: 2_000_000, reduceOnly: false }],
  ])
  const src = liveOiCapSource({ capOf: (s) => caps.get(s) ?? null, oiContractsOf: (t) => (t === PE_TOKEN ? 1_401 : null), index: () => INDEX })
  const { g } = gate(src)
  assert.match(String(await g.refusal(openOrder(PE), 'dec-22#0', 'live')), /^oi-cap: lookup failed — C-BTC-77200-041126: OI not on hand to check against its \$2,000,000 cap/)
})

test('LIVE fails closed: an unreadable package plan refuses rather than checking one leg', async () => {
  const { g } = gate(live(new Set()), { pkg: new Error('mongo down') })
  assert.match(String(await g.refusal(openOrder(PE), 'dec-23#0', 'live')), /^oi-cap: lookup failed — the package plan for dec-23 could not be read: mongo down/)
})

test('DEMO stays fail-open on the same failures; closes are never checked on either rail', async () => {
  const src: OiCapSource = { async figures() { throw new Error('fetch failed') } }
  assert.equal(await gate(src).g.refusal(openOrder(PE), 'dec-24#0', 'demo'), null)
  assert.equal(await gate(src, { pkg: new Error('mongo down') }).g.refusal(openOrder(PE), 'dec-25#0', 'demo'), null)
  assert.equal(await gate(src).g.refusal({ tradingsymbol: CE, quantity: 0.005, desk_op: 'close' }, 'dec-26#0', 'live'), null)
})

// ------------------------------------------------- the demo path, on a real DemoRail

const CFG: DxConfig = {
  baseUrl: 'https://cdn-ind.testnet.deltaex.org',
  wsUrl: 'wss://socket-ind.testnet.deltaex.org',
  apiKey: 'DK',
  apiSecret: 'DS',
  source: 'broker-store',
}

/** A testnet REST that counts every call by name. */
function testnet(capped: ReadonlySet<string>) {
  const calls: string[] = []
  const prod = (symbol: string, id: number): DxProduct => ({
    id, symbol, contract_type: symbol.startsWith('C') ? 'call_options' : 'put_options', contract_value: '0.001', tick_size: '0.1',
    product_specs: { max_oi_usd: 2_000_000, ...(capped.has(symbol) ? { oi_reduce_only_mode: true } : {}) },
  })
  const never = async (): Promise<never> => { throw new Error('not on this path') }
  const rest: DemoRest = {
    async products() { calls.push('products'); return [prod(CE, 207610), prod(PE, 207607)] },
    async ticker(s) {
      calls.push(`ticker ${s}`)
      const t: DxTicker = { symbol: s, product_id: 1, oi_contracts: capped.has(s) ? '55371' : '1401', spot_price: '76462' }
      return t
    },
    async product(s) { calls.push(`product ${s}`); return never() },
    placeOrder: never as () => Promise<DxOrder>,
    cancelOrder: never as () => Promise<DxOrder>,
    editOrder: never as () => Promise<DxOrder>,
    async openOrders() { return [] },
    async orderHistory() { return [] },
    async positions() { return [] },
    async fills() { return { fills: [] } },
    async heartbeat() {},
    walletBalances: never,
  }
  return { rest, calls }
}

test('demo: a straddle check is exactly two REST calls (one ticker per leg), specs from the cached listing', async () => {
  const { rest, calls } = testnet(new Set([CE]))
  const rail = new DemoRail({ loadConfig: async () => CFG, makeRest: () => rest, now: () => NOW, log: () => {} })
  await rail.ensure()
  await rail.testnetProduct(CE) // the listing, as the first demo order loads it anyway
  calls.length = 0
  const src = demoOiCapSource({ ticker: (s) => rest.ticker(s), productOf: (s) => rail.testnetProduct(s), index: () => INDEX })
  const { g } = gate(src)
  const pe = await g.refusal(openOrder(PE), 'dec-9#0', 'demo')
  const ce = await g.refusal(openOrder(CE), 'dec-9#1', 'demo')
  assert.deepEqual(calls.sort(), [`ticker ${CE}`, `ticker ${PE}`])
  assert.match(String(pe), /^oi-cap: C-BTC-77200-041126 OI \$4,233,777 ≥ cap \$2,000,000/)
  assert.match(String(ce), /no leg sent/)
})

test('no timer polling: with no orders, time passing reads nothing on either rail', async () => {
  const { rest, calls } = testnet(new Set())
  const rail = new DemoRail({ loadConfig: async () => CFG, makeRest: () => rest, now: () => NOW, log: () => {} })
  const clock = { t: NOW }
  const src = demoOiCapSource({ ticker: (s) => rest.ticker(s), productOf: (s) => rail.testnetProduct(s), index: () => INDEX })
  gate(src, { clock })
  gate(live(new Set()), { clock })
  clock.t += 3_600_000
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(calls, [])
})

// ------------------------------------------------- through the real placer

const contract = (symbol: string): ResolvedContract => ({
  tradingsymbol: symbol, instrumentToken: symbol === CE ? 161400 : 161401, lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA', underlying: 'BTC',
})

class Broker {
  readonly sim = new SimulatorAdapter({ runId: 'test' })
  readonly placed: OrderIntent[] = []
  readonly #handlers: ((o: PlacedOrder) => void)[] = []
  constructor() {
    this.sim.onOrderUpdate((o) => {
      for (const h of this.#handlers) h(o)
    })
  }
  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    this.placed.push(intent)
    return await this.sim.placeOrder(intent)
  }
  onOrderUpdate(h: (o: PlacedOrder) => void): void {
    this.#handlers.push(h)
  }
}

async function runPackage(capped: ReadonlySet<string>, ops: { pe: string; ce: string } = { pe: 'open', ce: 'open' }) {
  const orders = new FakeCollection()
  const doc = (clientOrderId: string, symbol: string, op: string): Record<string, unknown> => ({
    clientOrderId, state: 'PENDING', createdAt: NOW, tradingsymbol: symbol, transaction_type: op === 'close' ? 'BUY' : 'SELL',
    order_type: 'LIMIT', limitPrice: 790, quantity: 0.005, tag: 'BULLS-BTC-D1', desk_op: op, desk_tag: `${symbol}#0`,
    underlying: 'BTC', mode: 'paper',
  })
  orders.docs.push(doc('dec-P#0', PE, ops.pe), doc('dec-P#1', CE, ops.ce))
  const events = new FakeJournal()
  const broker = new Broker()
  const now = (): number => NOW
  const queue = new OrderQueue({ collection: orders, workerId: 'w1', now })
  const journal = new OrderJournal({ collection: events, now })
  const inflight: Promise<unknown>[] = []
  const watcher = new FillWatcher({ fills: new FakeFills(), queue, journal, now, log: () => {}, wake: () => {} })
  const { g } = gate(live(capped), { pkg: [{ tradingsymbol: PE, op: ops.pe, qty: 0.005 }, { tradingsymbol: CE, op: ops.ce, qty: 0.005 }] })
  const placer = createOrderPlacer({
    queue,
    journal,
    fills: watcher,
    adapterFor: () => ({ adapter: broker, rail: 'demo', note: '' }),
    resolveContract: (s) => (s === PE || s === CE ? contract(s) : null),
    freeze: () => new FreezeLimits([]),
    oiCapRefusal: (order, id, rail) => g.refusal(order, id, rail),
    allowsLive: async () => true,
    readHalt: async () => ({ state: 'off' as const, reason: '' }),
    linkRefusal: () => null,
    orderMaxAgeMs: 300_000,
    sweepArmed: () => false,
    now,
    log: () => {},
  })
  const sweeper = createSweeper({ claimNext: () => queue.claimNext(), handle: (d) => placer.processOne(d), log: () => {}, now })
  broker.onOrderUpdate((u) => void inflight.push(watcher.handle(u)))
  await sweeper.sweep()
  await sweeper.sweep()
  for (let i = 0; i < 50 && inflight.length > 0; i++) await Promise.all(inflight.splice(0))
  return { broker, events }
}

test('placer: a capped CE refuses the straddle with NOTHING sent, journalled oi-cap on both legs', async () => {
  const { broker, events } = await runPackage(new Set([CE]))
  assert.equal(broker.placed.length, 0, 'neither leg reached the broker')
  const failed = events.rows.filter((r) => r['phase'] === 'FAILED')
  assert.deepEqual(failed.map((r) => r['tradingsymbol']).sort(), [CE, PE])
  for (const r of failed) {
    assert.match(String(r['error'] ?? r['reason'] ?? ''), /oi-cap: C-BTC-77200-041126 OI \$4,233,777 ≥ cap \$2,000,000/)
    assert.equal(r['errorClass'], 'fatal')
  }
  assert.equal(events.rows.some((r) => r['phase'] === 'SUBMITTED'), false)
})

test('placer: an uncapped straddle sends both legs', async () => {
  const { broker } = await runPackage(new Set())
  assert.deepEqual(broker.placed.map((i) => i.instrument.tradingsymbol).sort(), [CE, PE])
})

test('placer: closes go out even when their products are capped', async () => {
  const { broker } = await runPackage(new Set([CE, PE]), { pe: 'close', ce: 'close' })
  assert.equal(broker.placed.length, 2)
})
