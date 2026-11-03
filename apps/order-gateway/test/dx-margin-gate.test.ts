import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter, type PlacedOrder } from '@algomaker/brokers'
import { FreezeLimits } from '@algomaker/instruments'
import type { OrderIntent } from '@algomaker/order-bus'
import { FakeCollection, FakeFills, FakeJournal } from './mongo-harness.ts'
import { createOrderPlacer } from '../src/main.ts'
import { OrderQueue, createSweeper } from '../src/queue.ts'
import { FillWatcher } from '../src/fills.ts'
import { OrderJournal } from '../src/journal.ts'
import type { ResolvedContract } from '../src/gateway.ts'
import type { Alert } from '../src/alert-sink.ts'
import {
  MarginGate,
  estimatePackageMargin,
  freshBalance,
  type MarginLeg,
} from '../src/dx-margin-gate.ts'

/**
 * THE PRE-TRADE MARGIN GATE: an opening package is refused WHOLE, before any
 * leg is sent, when its estimated initial margin is over the account's
 * available balance.
 *
 *   short leg: mark × qty + qty × index ÷ leverage   (qty in BTC)
 *   long leg:  mark × qty                            (the premium it pays)
 */

const PE = 'P-BTC-77200-041126'
const CE = 'C-BTC-77200-041126'
const NOW = 1_793_696_000_000
const INDEX = 77_460

// 5 contracts short at mark 1,350, leverage 100: 1350 × 0.005 + 0.005 × 77460 / 100 = 6.75 + 3.873 = 10.623
const straddle: readonly MarginLeg[] = [
  { tradingsymbol: PE, op: 'open', side: 'SELL', qty: 0.005, price: 1_350 },
  { tradingsymbol: CE, op: 'open', side: 'SELL', qty: 0.005, price: 1_350 },
]

const lev = new Map([
  [PE, 100],
  [CE, 100],
])

test('estimate: a short leg is mark × qty + qty × index ÷ leverage; a long leg is its premium', () => {
  const one = estimatePackageMargin([straddle[0] as MarginLeg], { markOf: () => null, leverageOf: (s) => lev.get(s) ?? null, index: INDEX })
  assert.deepEqual(one, { usd: 10.623, missing: null })
  const both = estimatePackageMargin(straddle, { markOf: () => null, leverageOf: (s) => lev.get(s) ?? null, index: INDEX })
  assert.equal(both.usd, 21.246)
  const long = estimatePackageMargin([{ tradingsymbol: CE, side: 'BUY', qty: 0.01, price: 200 }], {
    markOf: () => null,
    leverageOf: () => null,
    index: null,
  })
  assert.deepEqual(long, { usd: 2, missing: null }, 'a long leg needs neither leverage nor the index')
})

test('estimate: the HIGHER of the live mid and the planned price is used — the safe side', () => {
  const e = estimatePackageMargin([straddle[0] as MarginLeg], { markOf: () => 1_500, leverageOf: () => 100, index: INDEX })
  assert.equal(e.usd, 11.373)
})

test('estimate: closes are not counted; a missing mark, leverage or index is named', () => {
  assert.deepEqual(
    estimatePackageMargin([{ tradingsymbol: PE, op: 'close', side: 'BUY', qty: 0.005, price: 9 }], { markOf: () => null, leverageOf: () => null, index: null }),
    { usd: 0, missing: null },
  )
  assert.match(String(estimatePackageMargin([{ tradingsymbol: PE, side: 'SELL', qty: 0.005 }], { markOf: () => null, leverageOf: () => 100, index: INDEX }).missing), /no mark for P-BTC/)
  assert.match(String(estimatePackageMargin(straddle, { markOf: () => null, leverageOf: () => null, index: INDEX }).missing), /no leverage for P-BTC/)
  assert.match(String(estimatePackageMargin(straddle, { markOf: () => null, leverageOf: () => 100, index: null }).missing), /no BTC index/)
})

test('freshBalance: ok, numeric, and no older than the max age — else null', () => {
  assert.equal(freshBalance({ ok: true, available: 50, asOf: NOW - 60_000 }, NOW, 60_000), 50)
  assert.equal(freshBalance({ ok: true, available: 50, asOf: NOW - 60_001 }, NOW, 60_000), null)
  assert.equal(freshBalance({ ok: false, available: null, asOf: NOW }, NOW, 60_000), null)
  assert.equal(freshBalance({ ok: true, available: null, asOf: NOW }, NOW, 60_000), null)
  assert.equal(freshBalance(null, NOW, 60_000), null)
})

function gate(o: {
  available?: number | null | Error
  pkg?: readonly MarginLeg[] | null
  leverage?: ReadonlyMap<string, number>
  index?: number | null
  failClosed?: (rail: string) => boolean
} = {}) {
  const alerts: Alert[] = []
  const logs: string[] = []
  const reads: string[] = []
  const g = new MarginGate({
    loadPackage: async () => (o.pkg === undefined ? straddle : o.pkg),
    markOf: () => null,
    leverageOf: (s) => (o.leverage ?? lev).get(s) ?? null,
    index: () => (o.index === undefined ? INDEX : o.index),
    available: async (rail) => {
      reads.push(rail)
      if (o.available instanceof Error) throw o.available
      return o.available === undefined ? 1_000 : o.available
    },
    failClosed: o.failClosed ?? ((rail) => rail === 'live'),
    alerts: { raise: (a) => void alerts.push(a) },
    now: () => NOW,
    log: (m) => void logs.push(m),
  })
  return { g, alerts, logs, reads }
}

const openOrder = (symbol: string) => ({ tradingsymbol: symbol, quantity: 0.005, desk_op: 'open', transaction_type: 'SELL' as const, limitPrice: 1_350 })

test('live: a package over the available balance is refused on EVERY leg, prefixed margin:', async () => {
  const { g, alerts } = gate({ available: 20 })
  const a = await g.refusal(openOrder(PE), 'dec-1#0', 'live')
  const b = await g.refusal(openOrder(CE), 'dec-1#1', 'live')
  assert.match(String(a), /^margin: est initial margin \$21\.25 > available \$20\.00 on live/)
  assert.match(String(a), /whole opening package is refused, no leg sent/)
  assert.match(String(b), /^margin: /)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]?.severity, 'warn')
  assert.equal(alerts[0]?.mode, 'live')
})

test('live: a package within the balance passes; the verdict is decided ONCE — the second leg reads nothing', async () => {
  const { g, reads } = gate({ available: 22 })
  assert.equal(await g.refusal(openOrder(PE), 'dec-2#0', 'live'), null)
  // Leg 1's fill would now drop the balance — but the package was judged whole.
  assert.equal(await g.refusal(openOrder(CE), 'dec-2#1', 'live'), null)
  assert.deepEqual(reads, ['live'])
})

test('LIVE fails CLOSED: no fresh balance refuses the package, critical alert', async () => {
  for (const available of [null, new Error('wallet read 503')]) {
    const { g, alerts } = gate({ available })
    const r = await g.refusal(openOrder(PE), 'dec-3#0', 'live')
    assert.match(String(r), /^margin: lookup failed — /)
    assert.equal(alerts[0]?.severity, 'critical')
  }
  const { g } = gate({ leverage: new Map() })
  assert.match(String(await g.refusal(openOrder(PE), 'dec-4#0', 'live')), /^margin: lookup failed — no leverage for P-BTC/)
})

test('DEMO fails OPEN with a warn: no balance lets the order through and says so', async () => {
  const { g, alerts, logs } = gate({ available: null })
  assert.equal(await g.refusal(openOrder(PE), 'dec-5#0', 'demo'), null)
  assert.equal(alerts[0]?.severity, 'warn')
  assert.equal(alerts[0]?.mode, 'paper')
  assert.ok(logs.some((l) => /not blocking/.test(l)))
  // …but a balance it CAN read still refuses an oversized package on demo.
  const over = gate({ available: 5 })
  assert.match(String(await over.g.refusal(openOrder(PE), 'dec-6#0', 'demo')), /^margin: est initial margin/)
})

test('closes, the simulator rail and unrouted orders are never checked and read nothing', async () => {
  const { g, reads } = gate({ available: 0 })
  assert.equal(await g.refusal({ ...openOrder(PE), desk_op: 'close' }, 'dec-7#0', 'live'), null)
  assert.equal(await g.refusal(openOrder(PE), 'dec-7#0', 'sim'), null)
  assert.equal(await g.refusal(openOrder(PE), 'dec-7#0', null), null)
  assert.deepEqual(reads, [])
})

test('a manual order with no plan is a package of one, priced off its own limit', async () => {
  const { g } = gate({ pkg: null, available: 10.62 })
  // 10.623 > 10.62
  assert.match(String(await g.refusal(openOrder(PE), 'manual-1', 'live')), /^margin: est initial margin \$10\.62 > available \$10\.62/)
  const ok = gate({ pkg: null, available: 10.63 })
  assert.equal(await ok.g.refusal(openOrder(PE), 'manual-2', 'live'), null)
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

async function runPackage(available: number) {
  const orders = new FakeCollection()
  const doc = (clientOrderId: string, symbol: string): Record<string, unknown> => ({
    clientOrderId, state: 'PENDING', createdAt: NOW, tradingsymbol: symbol, transaction_type: 'SELL',
    order_type: 'LIMIT', limitPrice: 1_350, quantity: 0.005, tag: 'BULLS-BTC-D1', desk_op: 'open', desk_tag: `${symbol}#0`,
    underlying: 'BTC', mode: 'paper',
  })
  orders.docs.push(doc('dec-M#0', PE), doc('dec-M#1', CE))
  const events = new FakeJournal()
  const broker = new Broker()
  const now = (): number => NOW
  const queue = new OrderQueue({ collection: orders, workerId: 'w1', now })
  const journal = new OrderJournal({ collection: events, now })
  const inflight: Promise<unknown>[] = []
  const watcher = new FillWatcher({ fills: new FakeFills(), queue, journal, now, log: () => {}, wake: () => {} })
  const { g } = gate({ available })
  const placer = createOrderPlacer({
    queue,
    journal,
    fills: watcher,
    adapterFor: () => ({ adapter: broker, rail: 'demo', note: '' }),
    resolveContract: (s) => (s === PE || s === CE ? contract(s) : null),
    freeze: () => new FreezeLimits([]),
    marginRefusal: (order, id, rail) => g.refusal(order, id, rail),
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

test('placer: a straddle over the balance sends NOTHING, journalled margin: on both legs', async () => {
  const { broker, events } = await runPackage(20)
  assert.equal(broker.placed.length, 0)
  const failed = events.rows.filter((r) => r['phase'] === 'FAILED')
  assert.deepEqual(failed.map((r) => r['tradingsymbol']).sort(), [CE, PE])
  for (const r of failed) {
    assert.match(String(r['error'] ?? ''), /margin: est initial margin \$21\.25 > available \$20\.00/)
    assert.equal(r['errorClass'], 'fatal')
  }
})

test('placer: a straddle within the balance sends both legs', async () => {
  const { broker } = await runPackage(100)
  assert.deepEqual(broker.placed.map((i) => i.instrument.tradingsymbol).sort(), [CE, PE])
})
