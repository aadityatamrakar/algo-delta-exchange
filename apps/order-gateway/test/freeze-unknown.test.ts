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

/**
 * AN ORDER WHOSE UNDERLYING HAS NO FREEZE LIMIT (spec D5).
 *
 * The order still goes out — whole, unsplit — and that fact is what the
 * journal has to tell the truth about. Until 2026-09-21 `placeOne` wrote TWO
 * PLANNED rows for such an order: the ordinary `ok: true` one, then a second
 * `ok: false, errorClass: 'fatal'` carrying the explanation. The web groups an
 * order's events and paints the group by its first `!ok` event, so every
 * SENSEX paper order on 2026-09-16/17 (34 of 34, every one FILLED) rendered
 * as REJECTED on the book page, in red, under a paragraph of prose.
 *
 * The caveat is real and must stay visible — on live an oversize order is
 * refused at the exchange — but it is a WARNING on an order that succeeded,
 * not a failure. So: ONE PLANNED row, `ok: true`, with a `warning` field the
 * web renders as a badge; the sentence itself said once per (book,
 * underlying) in the log, the same discipline as `warnedNoTouch` in the
 * chaser, and a one-liner after that.
 *
 * Exercised through the real claim → plan → place loop, as tranche-gating is:
 * the row shape is what the Orders page reads, and the `desk()` builder is
 * what `main()` hands the sweeper.
 */

const LOT = 20
const SYMBOL = 'SENSEX26SEP81000CE'
const TOKEN = 54321
const TAG = 'SENSEX-delta-lean-conservative-2026-09-22'
const BASE = 'ord-1'
const NOW = 1_700_000_000_000

const CONTRACT: ResolvedContract = {
  tradingsymbol: SYMBOL,
  instrumentToken: TOKEN,
  lotSize: LOT,
  tickSize: 0.05,
  exchange: 'BFO',
  underlying: 'SENSEX',
}

/** `freezeQty` is in CONTRACTS, so this is the lot count the exchange allows. */
const freezeOf = (lots: number): FreezeLimits =>
  new FreezeLimits([{ symbol: 'SENSEX', freezeQty: lots * LOT }])

/** The simulator, with every intent that reached the wire kept for the suite. */
class Broker {
  readonly sim = new SimulatorAdapter({ runId: 'test' })
  readonly placed: OrderIntent[] = []
  readonly name = 'test'
  readonly capabilities = { orders: true, marketData: false, modify: true }
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

interface Desk {
  readonly broker: Broker
  readonly orders: FakeCollection
  readonly events: FakeJournal
  readonly logs: string[]
  sweep(): Promise<void>
  settle(): Promise<void>
  /** Queue a second order on the same book. */
  enqueue(clientOrderId: string): void
}

function desk(opts: { readonly freeze?: FreezeLimits } = {}): Desk {
  const orders = new FakeCollection()
  const docOf = (clientOrderId: string): Record<string, unknown> => ({
    clientOrderId,
    state: 'PENDING',
    createdAt: NOW,
    tradingsymbol: SYMBOL,
    transaction_type: 'SELL',
    order_type: 'LIMIT',
    limitPrice: 100,
    quantity: 9 * LOT,
    tag: TAG,
    desk_op: 'open',
    desk_tag: 'CE81000#0',
    underlying: 'SENSEX',
  })
  orders.docs.push(docOf(BASE))
  const fillRows = new FakeFills()
  const events = new FakeJournal()
  const broker = new Broker()
  const logs: string[] = []
  const now = (): number => NOW
  const queue = new OrderQueue({ collection: orders, workerId: 'w1', now })
  const journal = new OrderJournal({ collection: events, now })
  const inflight: Promise<unknown>[] = []

  const watcher = new FillWatcher({
    fills: fillRows,
    queue,
    journal,
    now,
    log: () => {},
    wake: () => void inflight.push(sweeper.sweep()),
  })
  const placer = createOrderPlacer({
    queue,
    journal,
    fills: watcher,
    adapterFor: () => broker,
    resolveContract: (symbol) => (symbol === SYMBOL ? CONTRACT : null),
    // The table the gateway loaded: by default one that has never heard of
    // SENSEX, which is what `desk-freeze-limits` looked like until the BSE
    // sync existed.
    freeze: () => opts.freeze ?? new FreezeLimits([]),
    allowsLive: async () => true,
    readHalt: async () => ({ state: 'off' as const, reason: '' }),
    linkRefusal: () => null,
    orderMaxAgeMs: 300_000,
    sweepArmed: () => false,
    now,
    log: (m) => void logs.push(m),
  })
  const sweeper = createSweeper({
    claimNext: () => queue.claimNext(),
    handle: (d) => placer.processOne(d),
    log: () => {},
    now,
  })
  broker.onOrderUpdate((u) => void inflight.push(watcher.handle(u)))

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50 && inflight.length > 0; i++) await Promise.all(inflight.splice(0))
  }
  return {
    broker,
    orders,
    events,
    logs,
    sweep: () => sweeper.sweep(),
    settle,
    enqueue: (clientOrderId) => void orders.docs.push(docOf(clientOrderId)),
  }
}

const planned = (d: Desk): Record<string, unknown>[] => d.events.rows.filter((r) => r['phase'] === 'PLANNED')

test('an order with no freeze limit journals ONE PLANNED row, ok:true, carrying the warning', async () => {
  const d = desk()
  await d.sweep()
  await d.settle()

  const rows = planned(d)
  assert.equal(rows.length, 1, `one PLANNED row, not two: ${JSON.stringify(rows)}`)
  const row = rows[0] as Record<string, unknown>
  assert.equal(row['ok'], true)
  assert.match(String(row['warning']), /no freeze limit for underlying/)
  const detail = row['detail'] as Record<string, unknown>
  assert.equal(detail['freezeUnknown'], true)
  assert.deepEqual(detail['tranches'], [9])

  // Nothing about this order is a failure: it went out, whole.
  assert.equal(d.events.rows.find((r) => r['ok'] === false), undefined, 'no row in the failures feed')
  assert.ok(d.events.rows.some((r) => r['phase'] === 'SUBMITTED'), 'and it was submitted')
  assert.equal(d.broker.placed.length, 1, 'as ONE broker order')
  assert.equal(d.broker.placed[0]?.quantity, 9 * LOT)
})

test('the freeze-unknown sentence is logged once per (tag, underlying); later orders get a one-liner', async () => {
  const d = desk()
  d.enqueue('ord-2')
  await d.sweep()
  await d.sweep()
  await d.settle()

  assert.equal(d.broker.placed.length, 2)
  const full = d.logs.filter((l) => /FREEZE LIMIT UNKNOWN .*sending 9 lots as ONE order/.test(l))
  const brief = d.logs.filter((l) => /unsplit \(freeze unknown, see first warning\)/.test(l))
  assert.equal(full.length, 1, `the sentence once:\n${d.logs.join('\n')}`)
  assert.equal(brief.length, 1, `the one-liner for the second order:\n${d.logs.join('\n')}`)
  // Both orders still carry the full warning on their own row: the log is
  // rate-limited, the journal is not.
  assert.equal(planned(d).filter((r) => /no freeze limit/.test(String(r['warning']))).length, 2)
})

test('a KNOWN freeze limit writes no warning', async () => {
  const d = desk({ freeze: freezeOf(24) })
  await d.sweep()
  await d.settle()

  const rows = planned(d)
  assert.equal(rows.length, 1)
  const row = rows[0] as Record<string, unknown>
  assert.equal(row['ok'], true)
  assert.equal(row['warning'], undefined)
  // Absent, not false: a NIFTY row today is byte-identical to a NIFTY row
  // yesterday, and nothing downstream has to learn a new field it does not need.
  assert.ok(!('freezeUnknown' in (row['detail'] as Record<string, unknown>)))
  assert.equal(d.logs.filter((l) => /FREEZE LIMIT UNKNOWN/.test(l)).length, 0)
})
