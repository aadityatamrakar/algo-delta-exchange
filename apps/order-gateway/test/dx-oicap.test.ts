import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter, type PlacedOrder } from '@algomaker/brokers'
import { FreezeLimits } from '@algomaker/instruments'
import type { OrderIntent } from '@algomaker/order-bus'
import type { DxProduct, DxTicker } from '@algomaker/dx'
import { FakeCollection, FakeFills, FakeJournal } from './mongo-harness.ts'
import { createOrderPlacer } from '../src/main.ts'
import { OrderQueue, createSweeper } from '../src/queue.ts'
import { FillWatcher } from '../src/fills.ts'
import { OrderJournal } from '../src/journal.ts'
import type { ResolvedContract } from '../src/gateway.ts'
import { OiCapGate, decisionIdOf, type OiCapVenue, type PackageLeg } from '../src/dx-oicap.ts'

/**
 * Delta's per-product OI cap, checked for the WHOLE opening package before
 * its first leg is sent. The 3 Nov 2026 testnet case: the straddle's put was
 * under its cap and filled, the call was over (OI $4.23M, cap $2M,
 * `oi_reduce_only_mode`) and was rejected — a half straddle.
 */

const PE = 'P-BTC-77200-041126'
const CE = 'C-BTC-77200-041126'
const NOW = 1_793_696_000_000

const product = (symbol: string, cap: number, mode: boolean): DxProduct => ({
  id: symbol === CE ? 207610 : 207607, symbol, contract_type: symbol.startsWith('C') ? 'call_options' : 'put_options',
  contract_value: '0.001', tick_size: '0.1',
  product_specs: { max_oi_usd: cap, ...(mode ? { oi_reduce_only_mode: true } : {}) },
})
const ticker = (symbol: string, oiUsd: number, mode: boolean): DxTicker => ({
  symbol, product_id: 1, oi_value_usd: String(oiUsd), oi_reduce_only_mode: mode, spot_price: '76800',
})

/** A venue with the testnet's figures; counts its reads. */
function venue(capped: ReadonlySet<string>): OiCapVenue & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async product(s) {
      reads.push(`product ${s}`)
      return capped.has(s) ? product(s, 2_000_000, true) : product(s, 2_000_000, false)
    },
    async ticker(s) {
      reads.push(`ticker ${s}`)
      return capped.has(s) ? ticker(s, 4_233_771.86, true) : ticker(s, 108_096.96, false)
    },
  }
}

const straddle: readonly PackageLeg[] = [
  { tradingsymbol: PE, op: 'open', qty: 0.005 },
  { tradingsymbol: CE, op: 'open', qty: 0.005 },
]

function gate(v: OiCapVenue | null, opts: { pkg?: readonly PackageLeg[] | null; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: NOW }
  const logs: string[] = []
  const loads: string[] = []
  const g = new OiCapGate({
    venueFor: (rail) => (rail === 'demo' || rail === 'live' ? v : null),
    loadPackage: async (id) => {
      loads.push(id)
      return opts.pkg === undefined ? straddle : opts.pkg
    },
    index: () => 76_800,
    now: () => clock.t,
    log: (m) => void logs.push(m),
  })
  return { g, logs, loads, clock }
}

const openOrder = (symbol: string) => ({ tradingsymbol: symbol, quantity: 0.005, desk_op: 'open' })

test('decisionIdOf: <decisionId>#<leg>, tranche suffix stripped', () => {
  assert.equal(decisionIdOf('dec-abc#1'), 'dec-abc')
  assert.equal(decisionIdOf('dec-abc#1.2'), 'dec-abc')
  assert.equal(decisionIdOf('manual-1'), null)
})

test('a capped leg refuses EVERY leg of the package — the uncapped first leg included', async () => {
  const v = venue(new Set([CE]))
  const { g } = gate(v)
  const pe = await g.refusal(openOrder(PE), 'dec-1#0', 'demo')
  const ce = await g.refusal(openOrder(CE), 'dec-1#1', 'demo')
  assert.match(String(pe), /^oi-cap: C-BTC-77200-041126 OI \$4,233,772 ≥ cap \$2,000,000 — Delta accepts reduce-only only/)
  assert.match(String(pe), /P-BTC-77200-041126 is refused with it/)
  assert.match(String(ce), /^oi-cap: C-BTC-77200-041126 OI \$4,233,772 ≥ cap \$2,000,000/)
  assert.match(String(ce), /no leg sent/)
})

test('an uncapped package passes', async () => {
  const { g } = gate(venue(new Set()))
  assert.equal(await g.refusal(openOrder(PE), 'dec-2#0', 'demo'), null)
  assert.equal(await g.refusal(openOrder(CE), 'dec-2#1', 'live'), null)
})

test('closes and other reducing ops are never blocked, and read nothing', async () => {
  const v = venue(new Set([CE, PE]))
  const { g, loads } = gate(v)
  for (const op of ['close', 'roll', 'resize']) {
    assert.equal(await g.refusal({ tradingsymbol: CE, quantity: 0.005, desk_op: op }, 'dec-3#0', 'demo'), null)
  }
  assert.deepEqual(v.reads, [])
  assert.deepEqual(loads, [])
})

test('a package that mixes a close with a capped-product close is not blocked by it', async () => {
  // The CE leg here CLOSES (buys back) on a capped product — Delta takes that.
  const v = venue(new Set([CE]))
  const { g } = gate(v, { pkg: [{ tradingsymbol: CE, op: 'close', qty: 0.005 }, { tradingsymbol: PE, op: 'open', qty: 0.005 }] })
  assert.equal(await g.refusal(openOrder(PE), 'dec-4#1', 'demo'), null)
  assert.ok(!v.reads.includes(`ticker ${CE}`), 'the closing leg was not checked')
})

test('the simulator rail and a rail with no venue are not checked', async () => {
  const v = venue(new Set([CE]))
  const { g } = gate(v)
  assert.equal(await g.refusal(openOrder(CE), 'dec-5#0', 'sim'), null)
  assert.equal(await g.refusal(openOrder(CE), 'dec-5#0', null), null)
  assert.equal(await gate(null).g.refusal(openOrder(CE), 'dec-5#0', 'demo'), null)
  assert.deepEqual(v.reads, [])
})

test('products and tickers are cached for 20 s per symbol', async () => {
  const v = venue(new Set())
  const clock = { t: NOW }
  const { g } = gate(v, { clock })
  await g.refusal(openOrder(PE), 'dec-6#0', 'demo')
  assert.equal(v.reads.length, 4, 'two legs, a product and a ticker each')
  clock.t += 19_000
  await g.refusal(openOrder(PE), 'dec-7#0', 'demo') // a new package, same symbols
  assert.equal(v.reads.length, 4, 'inside 20 s: from the cache')
  clock.t += 2_000
  await g.refusal(openOrder(PE), 'dec-8#0', 'demo')
  assert.equal(v.reads.length, 8, 'after 20 s: read again')
})

test('the verdict is decided once per package: the second leg is not re-read and gets the same answer', async () => {
  const v = venue(new Set())
  const { g, loads } = gate(v)
  assert.equal(await g.refusal(openOrder(PE), 'dec-9#0', 'demo'), null)
  const reads = v.reads.length
  assert.equal(await g.refusal(openOrder(CE), 'dec-9#1', 'demo'), null)
  assert.equal(v.reads.length, reads)
  assert.deepEqual(loads, ['dec-9'])
})

test('a manual order with no plan is a package of one', async () => {
  const v = venue(new Set([CE]))
  const { g } = gate(v, { pkg: null })
  assert.match(String(await g.refusal(openOrder(CE), 'manual-ce', 'live')), /^oi-cap: C-BTC-77200-041126/)
  assert.equal(await g.refusal(openOrder(PE), 'manual-pe', 'live'), null)
})

test('a failed venue read lets the order through and says so', async () => {
  const broken: OiCapVenue = {
    async product() { throw new Error('fetch failed') },
    async ticker() { throw new Error('fetch failed') },
  }
  const { g, logs } = gate(broken)
  assert.equal(await g.refusal(openOrder(PE), 'dec-10#0', 'demo'), null)
  assert.ok(logs.some((l) => /read failed, not blocking/.test(l)))
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
  const v = venue(capped)
  const { g } = gate(v, { pkg: [{ tradingsymbol: PE, op: ops.pe, qty: 0.005 }, { tradingsymbol: CE, op: ops.ce, qty: 0.005 }] })
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
    assert.match(String(r['error'] ?? r['reason'] ?? ''), /oi-cap: C-BTC-77200-041126 OI \$4,233,772 ≥ cap \$2,000,000/)
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
