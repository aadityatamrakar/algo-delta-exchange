/**
 * THE TRIPLE PRODUCT: a PAPER order, worked PASSIVELY, in TRANCHES (I-3).
 *
 * Each of those three has its own suite — `paper-rail.test.ts` for the rail
 * split, `order-chaser-peg.test.ts` for the peg, `tranche-gating.test.ts` for
 * the cursor — and every one of them holds the other two fixed. Nothing drove
 * all three at once, and the three interact in exactly the place none of them
 * looks:
 *
 *   THE DWELL IS PER SLICE, and it is per slice only because `markPlaced`'s
 *   append path RESTAMPS `placedAt`. The chaser's gate is
 *   `now - max(placedAt, chasedAt) <= pegDwellMs`. A cursor advance that
 *   appended ids without restamping would leave slice 2 measuring its dwell
 *   from slice 1's placement — so slice 2 would be repriced the instant it
 *   reached the broker, before it had ever been shown to the market at the
 *   price the desk chose. That is precisely the thing the tranche dial exists
 *   to prevent, arrived at through the chaser instead of through the planner.
 *
 *   THE PEG MUST FOLLOW THE LIVE SLICE, not the doc's whole id list. Later
 *   slices APPEND (`markPlaced({append: true})`), so by slice 3 the document
 *   names three broker ids of which two are long dead. `liveBrokerIds`
 *   narrows against our OWN `desk-fills` rows, and if it did not, every peg
 *   pass would send a modify for a filled order — noise at best, and at worst
 *   a broker that answers a modify on a dead id with something a human has to
 *   go and interpret.
 *
 * DRIVEN THROUGH THE REAL PLACER AND THE REAL CHASER, on ONE shared orders
 * collection and ONE shared fills collection, for the reason `fills.ts`'s
 * header gives: a suite built on hand-rolled stand-ins for either of them is a
 * green suite for a property the running gateway does not have. The only fakes
 * are Mongo and the broker, and the broker is the simulator — its
 * `modifyOrder` really moves the resting trigger, so a peg that lands changes
 * which ticks fill.
 *
 * The harnesses are the shared ones: `FakeCollection`/`FakeFills`/`FakeJournal`
 * from `mongo-harness.ts` (the tranche suite's), and the real `QuoteMap` the
 * peg suite insists on rather than a `touch()` stub.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter, type PlacedOrder } from '@algomaker/brokers'
import { FreezeLimits } from '@algomaker/instruments'
import { FakeCollection, FakeFills, FakeJournal } from './mongo-harness.ts'
import { createOrderPlacer } from '../src/main.ts'
import { OrderQueue, createSweeper } from '../src/queue.ts'
import { FillWatcher } from '../src/fills.ts'
import { OrderJournal } from '../src/journal.ts'
import { createOrderChaser } from '../src/order-chaser.ts'
import { createQuoteMap } from '../src/quote-map.ts'
import type { ResolvedContract } from '../src/gateway.ts'

const LOT = 75
const SYMBOL = 'NIFTY26AUG25000CE'
const TOKEN = 12345
const TAG = 'DESK_NIFTY'
const BASE = 'ord-1'
/** The gateway booted an hour before the first placement, so nothing is pre-deploy. */
const BOOTED = 1_700_000_000_000
const NOW = BOOTED + 3_600_000
const DWELL = 15_000
const LIMIT = 100

const CONTRACT: ResolvedContract = {
  tradingsymbol: SYMBOL,
  instrumentToken: TOKEN,
  lotSize: LOT,
  tickSize: 0.05,
  exchange: 'NFO',
  underlying: 'NIFTY',
}

interface Desk {
  readonly sim: SimulatorAdapter
  readonly orders: FakeCollection
  readonly fills: FakeFills
  readonly clock: { now: number }
  /** Every modify the chaser sent, in order — id and price. */
  readonly modifies: { brokerOrderId: string; price: number }[]
  sweep(): Promise<void>
  settle(): Promise<void>
  chase(): Promise<void>
  /** Wind the clock forward past one dwell, so the next peg pass is allowed. */
  wait(): void
  doc(): Record<string, unknown>
  /** The broker ids on the doc, in append order. */
  ids(): string[]
  /** A print at `price`, filling whatever the simulator holds through it. */
  tick(price: number): Promise<void>
  /** A two-sided book, for the peg to join. */
  quote(bid: number, ask: number): void
}

function desk(): Desk {
  const orders = new FakeCollection()
  orders.docs.push({
    clientOrderId: BASE,
    state: 'PENDING',
    createdAt: NOW,
    tradingsymbol: SYMBOL,
    // The peg reads BOTH of these off the document — no token means no touch
    // and no tick size means no grid, and either one silently disables it.
    instrument_token: TOKEN,
    tickSize: 0.05,
    transaction_type: 'SELL',
    order_type: 'LIMIT',
    limitPrice: LIMIT,
    quantity: 9 * LOT,
    tag: TAG,
    desk_op: 'open',
    desk_tag: 'CE25000#0',
    underlying: 'NIFTY',
    // THE TRIPLE PRODUCT ITSELF.
    mode: 'paper',
    workMode: 'passive',
    trancheLots: 3,
  })

  const fills = new FakeFills()
  const events = new FakeJournal()
  const sim = new SimulatorAdapter()
  const clock = { now: BOOTED }
  const now = (): number => clock.now
  const modifies: { brokerOrderId: string; price: number }[] = []

  const queue = new OrderQueue({ collection: orders, workerId: 'w1', now })
  const journal = new OrderJournal({ collection: events, now })
  const inflight: Promise<unknown>[] = []

  const watcher = new FillWatcher({
    fills,
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
    // Paper document, paper adapter — `isPaperOrder` is exercised in
    // `paper-rail.test.ts`; here the simulator is simply the only broker.
    adapterFor: () => sim,
    resolveContract: (s) => (s === SYMBOL ? CONTRACT : null),
    // Well above the 3-lot tranche, so every slice is ONE broker order and the
    // ids on the doc map one-to-one onto slices. The freeze split inside a
    // tranche has its own test.
    freeze: () => new FreezeLimits([{ symbol: 'NIFTY', freezeQty: 100 * LOT }]),
    allowsLive: async () => true,
    readHalt: async () => ({ state: 'off' as const, reason: '' }),
    linkRefusal: () => null,
    orderMaxAgeMs: 300_000,
    sweepArmed: () => false,
    now,
    log: () => {},
  })
  const sweeper = createSweeper({
    claimNext: () => queue.claimNext(),
    handle: (d) => placer.processOne(d),
    log: () => {},
    now,
  })
  sim.onOrderUpdate((u: PlacedOrder) => void inflight.push(watcher.handle(u)))

  // Built while the clock still reads BOOTED: the chaser stamps `bootedAt`
  // from the clock it is handed, and one built at NOW would declare every
  // order here pre-deploy and chase nothing.
  const quotes = createQuoteMap({ now })
  const chaser = createOrderChaser(
    {
      adapter: {
        capabilities: { orders: true, marketData: false, modify: true },
        modifyOrder: async (brokerOrderId: string, price: number) => {
          modifies.push({ brokerOrderId, price })
          // Through to the REAL simulator, so a peg that lands actually moves
          // the resting trigger and changes which ticks fill.
          return await sim.modifyOrder(brokerOrderId, price)
        },
      },
      orders: orders as never,
      cancels: { find: () => ({ toArray: async () => [] }) },
      fills,
      journal: { record: async () => {} },
      // The paper rail's own chaser, filtered exactly as `main()` filters it.
      ordersFilter: { mode: 'paper' },
      quotes,
      now,
      log: () => {},
    },
    { chaseAfterMs: DWELL, stepPct: 0.03, minTicks: 2, maxAttempts: 3, pegDwellMs: DWELL },
  )
  clock.now = NOW

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50 && inflight.length > 0; i++) await Promise.all(inflight.splice(0))
  }
  return {
    sim,
    orders,
    fills,
    clock,
    modifies,
    sweep: () => sweeper.sweep(),
    settle,
    chase: () => chaser.run(),
    wait: () => void (clock.now += DWELL + 1),
    doc: () => orders.docs[0] as Record<string, unknown>,
    ids: () => (orders.docs[0]?.['brokerOrderIds'] as string[] | undefined) ?? [],
    tick: async (price: number) => {
      sim.feedTick(TOKEN, price)
      await settle()
    },
    quote: (bid: number, ask: number) => {
      quotes.onTick({ token: TOKEN, price: (bid + ask) / 2, bid, ask, ts: clock.now })
    },
  }
}

test('a paper + passive + tranched order: each slice pegs on its OWN dwell, off its OWN id', async () => {
  const d = desk()

  // ---- slice 1 -----------------------------------------------------------
  await d.sweep()
  const placed1 = Number(d.doc()['placedAt'])
  assert.equal(placed1, NOW)
  assert.deepEqual(d.doc()['tranchePlan'], [{ qty: 3 * LOT }, { qty: 3 * LOT }, { qty: 3 * LOT }])
  assert.equal(d.doc()['trancheCursor'], 0)
  assert.equal(d.ids().length, 1, 'one slice at the broker, not the whole nine lots')
  const [id1] = d.ids()

  /**
   * SLICE 1 IS DELIBERATELY NEVER PEGGED, and that is what makes the next
   * assertion discriminating. `chasedAt` is doc-wide, so leaving it unset
   * means the dwell gate reads `placedAt` alone — and `placedAt` is the field
   * the restamp is about.
   */

  // ---- the advance, one full dwell later ---------------------------------
  d.wait()
  await d.tick(101) // trades through the resting sell at 100
  const placed2 = Number(d.doc()['placedAt'])

  assert.equal(d.doc()['trancheCursor'], 1, 'the fill advanced the cursor')
  assert.deepEqual(d.ids(), [id1, d.ids()[1]], 'slice 2 APPENDED — slice 1’s id survives')
  assert.equal(d.ids().length, 2)
  /**
   * THE RESTAMP. Without it `placedAt` would still read `placed1`, and the
   * pass below would peg a slice that had existed for zero milliseconds.
   */
  assert.equal(placed2, d.clock.now, 'slice 2 restamped placedAt to its own placement')
  assert.ok(placed2 > placed1)

  // ---- the discriminating pass -------------------------------------------
  d.quote(100.5, 101)
  await d.chase()
  // `.length`, not `deepEqual(…, [])`: node's assert types narrow the actual
  // to the expected, and comparing against a bare `[]` would type the array as
  // `never[]` for the rest of the test.
  assert.equal(
    d.modifies.length,
    0,
    'slice 2 is inside its OWN dwell — un-restamped, this pass would have pegged it',
  )

  // ---- slice 2 pegs, on its own id alone ---------------------------------
  d.wait()
  d.quote(100.5, 101)
  await d.chase()

  assert.equal(d.modifies.length, 1, 'one modify, for the one live slice')
  assert.equal(
    d.modifies[0]?.brokerOrderId,
    d.ids()[1],
    'the LIVE slice — slice 1 is FILLED in desk-fills and narrowed out',
  )
  assert.notEqual(d.modifies[0]?.brokerOrderId, id1)
  // Joined the ask, which is where a passive sell rests.
  assert.equal(d.modifies[0]?.price, 101)

  // ---- slice 3 -----------------------------------------------------------
  await d.tick(102) // through the pegged 101
  const placed3 = Number(d.doc()['placedAt'])

  assert.equal(d.doc()['trancheCursor'], 2)
  assert.equal(d.ids().length, 3, 'three ids on the doc, of which only one is live')
  assert.ok(placed3 > placed2, 'restamped again')

  d.wait()
  d.quote(101.5, 102)
  await d.chase()

  assert.equal(d.modifies.length, 2, 'exactly one more modify')
  assert.equal(
    d.modifies[1]?.brokerOrderId,
    d.ids()[2],
    'still narrowed to the live slice, with TWO dead ids on the doc',
  )
  assert.equal(d.modifies[1]?.price, 102)

  // ---- the package completes ---------------------------------------------
  await d.tick(103)

  assert.equal(d.ids().length, 3, 'nothing was re-armed past the plan')
  assert.equal(d.doc()['state'], 'FILLED')
  assert.equal(
    d.doc()['filledQty'],
    9 * LOT,
    'the denominator was the whole order, not the last slice',
  )
})

test('the chaser never pegs a slice that has already filled, however many ids the doc names', async () => {
  /**
   * The same run, asked the narrow question: over the WHOLE life of a
   * three-slice package, no modify is ever addressed to an id our own
   * `desk-fills` rows say is terminal. A `liveBrokerIds` that returned the
   * doc's list unchanged would pass every other assertion in this file and
   * fail this one.
   */
  const d = desk()
  await d.sweep()

  const dead: string[] = []
  for (let slice = 0; slice < 3; slice++) {
    const live = d.ids()[slice] as string
    d.wait()
    d.quote(100 + slice, 101 + slice)
    await d.chase()

    for (const m of d.modifies) {
      assert.ok(!dead.includes(m.brokerOrderId), `modify sent to dead id ${m.brokerOrderId}`)
      assert.equal(m.brokerOrderId, live, 'every modify addressed the live slice')
    }
    d.modifies.length = 0

    await d.tick(102 + slice)
    dead.push(live)
  }

  assert.equal(d.doc()['state'], 'FILLED')
  assert.equal(dead.length, 3)
})
