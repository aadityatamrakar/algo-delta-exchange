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
 * FILL-GATED TRANCHES, exercised through the REAL claim → place → fill →
 * advance loop: `createOrderPlacer` is what `main()` hands the sweeper, the
 * `FillWatcher` is what the broker's updates are handed to, and the adapter is
 * the simulator that fills a resting limit when a tick trades through it.
 *
 * Testing the pure planner alone would repeat the mistake `fills.ts`'s header
 * describes — a green suite for a property the running gateway did not have.
 * The property here is worth that care, because both ways of getting it wrong
 * are expensive:
 *
 *   PLACING THE WHOLE SIZE AT ONCE shows the market the entire order. A 30-lot
 *   passive sell that walks the book down is the reason a tranche dial exists.
 *
 *   PLACING THE NEXT TRANCHE WITHOUT WAITING is worse: two slices live at one
 *   price double the size the desk chose to show, and if the first is rejected
 *   (margin, freeze, a bad strike) the second is rejected too — or, worse, is
 *   not, and the book ends up holding a size nobody decided on.
 *
 * The advance is a COMPARE-AND-SET on the cursor for the F-10 reason: a doc
 * re-read by a second watcher (or re-claimed after a stale claim) must not be
 * able to place tranche i+1 twice.
 */

const LOT = 75
const SYMBOL = 'NIFTY26AUG25000CE'
const TOKEN = 12345
const TAG = 'DESK_NIFTY'
const BASE = 'ord-1'
const NOW = 1_700_000_000_000
/** What `BrokerLink.refusal()` says — the placer only relays it. */
const RELEASED =
  'XTS session released by operator (need the key elsewhere); the gateway is logged out and live ' +
  'orders cannot be placed until it is reconnected from Controls'

const CONTRACT: ResolvedContract = {
  tradingsymbol: SYMBOL,
  instrumentToken: TOKEN,
  lotSize: LOT,
  tickSize: 0.05,
  exchange: 'NFO',
  underlying: 'NIFTY',
}

/** `freezeQty` is in CONTRACTS, so this is the lot count the exchange allows. */
const freezeOf = (lots: number): FreezeLimits =>
  new FreezeLimits([{ symbol: 'NIFTY', freezeQty: lots * LOT }])

/**
 * The broker, wrapping the simulator so the suite can watch two things it
 * cannot otherwise see: every intent that reached the wire, and HOW MANY of
 * them were live at once — which is the property this whole ticket is about.
 */
class Broker {
  /**
   * A PINNED runId, so the ids this suite names stay reproducible.
   *
   * Production takes the default, which is fresh per construction: a restart
   * that reissued `sim-1` let `FillWatcher` adopt a previous run's fill row as
   * this order's (see `fills.ts:#fillsFor`). A test that asserts on a literal
   * id has to pin the token rather than rely on counting from one.
   */
  readonly sim = new SimulatorAdapter({ runId: 'test' })
  readonly placed: OrderIntent[] = []
  readonly name = 'test'
  readonly capabilities = { orders: true, marketData: false, modify: true }
  /** Placement number to answer with a broker REJECTION (1-based). */
  rejectAt: number | null = null
  /**
   * Placement number to ACCEPT and never fill (1-based).
   *
   * The simulator fills every resting order a crossing tick reaches, so this is
   * the only way to leave ONE sub-order of a freeze-split tranche working while
   * its sibling fills — which is the state the cursor must not advance on.
   */
  holdAt: number | null = null
  live = 0
  maxLive = 0
  readonly #handlers: ((o: PlacedOrder) => void)[] = []

  constructor() {
    this.sim.onOrderUpdate((o) => this.#observe(o))
  }

  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    this.placed.push(intent)
    if (this.placed.length === this.rejectAt) {
      const refused: PlacedOrder = {
        brokerOrderId: `rej-${this.placed.length}`,
        clientOrderId: intent.clientOrderId,
        status: 'REJECTED',
        filledQty: 0,
        avgPrice: null,
        rejectReason: 'RMS: margin shortfall',
      }
      this.#observe(refused)
      return refused
    }
    if (this.placed.length === this.holdAt) {
      // Accepted by the broker and left working: never handed to the simulator,
      // so no tick can fill it.
      const held: PlacedOrder = {
        brokerOrderId: `held-${this.placed.length}`,
        clientOrderId: intent.clientOrderId,
        status: 'WORKING',
        filledQty: 0,
        avgPrice: null,
      }
      this.#observe(held)
      return held
    }
    return await this.sim.placeOrder(intent)
  }

  feedTick(price: number): void {
    this.sim.feedTick(TOKEN, price)
  }

  onOrderUpdate(h: (o: PlacedOrder) => void): void {
    this.#handlers.push(h)
  }

  #observe(o: PlacedOrder): void {
    if (o.status === 'WORKING') this.live += 1
    else if (o.status === 'FILLED' || o.status === 'REJECTED' || o.status === 'CANCELLED') {
      this.live = Math.max(0, this.live - 1)
    }
    this.maxLive = Math.max(this.maxLive, this.live)
    for (const h of this.#handlers) h(o)
  }
}

interface Desk {
  readonly broker: Broker
  readonly orders: FakeCollection
  readonly events: FakeJournal
  readonly queue: OrderQueue
  readonly watcher: FillWatcher
  sweep(): Promise<void>
  settle(): Promise<void>
  doc(): Record<string, unknown>
  /** Fill whatever is resting, then let the advance and the next placement run. */
  step(price: number): Promise<void>
}

function desk(
  order: Record<string, unknown> = {},
  opts: {
    readonly freezeLots?: number
    /** Flip a gate on between tranches, the way an operator would. */
    readonly halt?: { readonly on: boolean }
    readonly live?: { readonly on: boolean }
    /** The operator's "turn the live broker off" switch (the placer's link gate). */
    readonly link?: { readonly released: boolean }
  } = {},
): Desk {
  const orders = new FakeCollection()
  orders.docs.push({
    clientOrderId: BASE,
    state: 'PENDING',
    createdAt: NOW,
    tradingsymbol: SYMBOL,
    transaction_type: 'SELL',
    order_type: 'LIMIT',
    limitPrice: 100,
    quantity: 9 * LOT,
    tag: TAG,
    desk_op: 'open',
    desk_tag: 'CE25000#0',
    underlying: 'NIFTY',
    ...order,
  })
  const fillRows = new FakeFills()
  const events = new FakeJournal()
  const broker = new Broker()
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
    // `main()` fires the sweep and forgets it; the suite keeps the promise so
    // it can await the placement the advance triggers.
    wake: () => void inflight.push(sweeper.sweep()),
  })
  const placer = createOrderPlacer({
    queue,
    journal,
    fills: watcher,
    // One broker for every document here: these suites are about the tranche
    // cursor, not about which rail an order is on.
    adapterFor: () => broker,
    resolveContract: (symbol) => (symbol === SYMBOL ? CONTRACT : null),
    freeze: () => freezeOf(opts.freezeLots ?? 24),
    allowsLive: async () => opts.live?.on !== false,
    readHalt: async () =>
      opts.halt?.on === true
        ? { state: 'on' as const, reason: 'operator engaged it' }
        : { state: 'off' as const, reason: '' },
    linkRefusal: () => (opts.link?.released === true ? RELEASED : null),
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
  broker.onOrderUpdate((u) => void inflight.push(watcher.handle(u)))

  const settle = async (): Promise<void> => {
    // Draining rather than one `Promise.all`: handling a fill schedules a sweep,
    // which places a tranche, which schedules another handler.
    for (let i = 0; i < 50 && inflight.length > 0; i++) await Promise.all(inflight.splice(0))
  }
  return {
    broker,
    orders,
    events,
    queue,
    watcher,
    sweep: () => sweeper.sweep(),
    settle,
    doc: () => orders.docs[0] as Record<string, unknown>,
    step: async (price: number) => {
      broker.feedTick(price)
      await settle()
    },
  }
}

const qtysPlaced = (d: Desk): number[] => d.broker.placed.map((i) => i.quantity)
const idsPlaced = (d: Desk): string[] => d.broker.placed.map((i) => i.clientOrderId)

// ------------------------------------------------------------ the plan itself

test('a 9-lot order with a 3-lot tranche dial shows the market THREE lots', async () => {
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  await d.sweep()

  assert.deepEqual(qtysPlaced(d), [3 * LOT], 'one broker order, of one tranche')
  assert.deepEqual(d.doc()['tranchePlan'], [{ qty: 3 * LOT }, { qty: 3 * LOT }, { qty: 3 * LOT }])
  assert.equal(d.doc()['trancheCursor'], 0)
  assert.equal(d.doc()['state'], 'PLACED')
  assert.deepEqual(d.doc()['trancheIds'], [`${BASE}.1`])
  // The DENOMINATOR stays the whole order: the fill watcher decides completion
  // against what the desk asked for, not against the slice in flight.
  assert.equal(d.doc()['expectedQty'], 9 * LOT)
})

test('an order with no tranche dial is placed exactly as it always was', async () => {
  // The regression that matters most: every order this desk has routed until
  // now carries no `trancheLots` and no `workMode`, and gating them silently
  // would turn one freeze-split placement into a sequence spread over minutes.
  const d = desk({}, { freezeLots: 5 })
  await d.sweep()

  assert.deepEqual(qtysPlaced(d), [5 * LOT, 4 * LOT], 'both freeze tranches, at once')
  assert.equal(d.doc()['tranchePlan'], undefined, 'no plan is written for an ungated order')
  assert.equal(d.doc()['trancheCursor'], undefined)
})

test('urgent works in FREEZE-sized tranches: 9 lots under a 5-lot freeze is 5 then 4', async () => {
  const d = desk({ workMode: 'urgent' }, { freezeLots: 5 })
  await d.sweep()

  assert.deepEqual(d.doc()['tranchePlan'], [{ qty: 5 * LOT }, { qty: 4 * LOT }])
  assert.deepEqual(qtysPlaced(d), [5 * LOT], 'the biggest slice the exchange allows, and only one')
})

test('the freeze split still applies INSIDE a tranche', async () => {
  // A 6-lot tranche under a 5-lot freeze is TWO broker orders — the exchange
  // rejects anything over the freeze outright, and the tranche dial is a
  // choice about what to show the market, not a licence to ignore it.
  const d = desk({ trancheLots: 6, workMode: 'passive' }, { freezeLots: 5 })
  await d.sweep()

  assert.deepEqual(d.doc()['tranchePlan'], [{ qty: 6 * LOT }, { qty: 3 * LOT }])
  assert.deepEqual(qtysPlaced(d), [5 * LOT, 1 * LOT])
  assert.deepEqual(idsPlaced(d), [`${BASE}.1`, `${BASE}.2`])
})

// --------------------------------------------------------------- the gating

test('the next tranche waits for the last one, and then goes', async () => {
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  await d.sweep()
  assert.deepEqual(qtysPlaced(d), [3 * LOT])

  // A tick trades through the sell limit: tranche 1 fills, and only then does
  // tranche 2 exist at the broker.
  await d.step(101)
  assert.deepEqual(qtysPlaced(d), [3 * LOT, 3 * LOT])
  assert.deepEqual(idsPlaced(d), [`${BASE}.1`, `${BASE}.2`], 'tranche ids never collide')
  assert.equal(d.doc()['trancheCursor'], 1)
  assert.equal(d.doc()['state'], 'PLACED')
  assert.deepEqual(d.doc()['trancheIds'], [`${BASE}.1`, `${BASE}.2`], 'appended, not replaced')
})

test('one tranche at a time, all the way to a FILLED order', async () => {
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  await d.sweep()
  await d.step(101)
  await d.step(102)
  await d.step(103)

  assert.deepEqual(qtysPlaced(d), [3 * LOT, 3 * LOT, 3 * LOT])
  assert.equal(d.broker.maxLive, 1, 'never more than ONE tranche live at the broker')
  assert.equal(d.doc()['state'], 'FILLED')
  assert.equal(d.doc()['filledQty'], 9 * LOT)
  assert.equal(d.doc()['trancheCursor'], 2)
})

test('a further sweep after the last tranche places NOTHING', async () => {
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  await d.sweep()
  await d.step(101)
  await d.step(102)
  await d.step(103)
  await d.sweep()
  await d.sweep()

  assert.equal(d.broker.placed.length, 3, 'a finished order is not re-claimed')
})

// ---------------------------------------------------------------- the reject

test('the broker link released BETWEEN tranches stops the rest — HALTED, and it says why', async () => {
  /**
   * The same per-slice re-check the kill switch gets: an operator who turns
   * XTS off while a nine-lot order is being worked three at a time must see
   * the rest stop — and what already traded stay on the document.
   */
  const link = { released: false }
  const d = desk({ mode: 'live', trancheLots: 3, workMode: 'passive' }, { link })
  await d.sweep()
  assert.equal(d.broker.placed.length, 1)
  link.released = true
  await d.step(101)

  assert.equal(d.doc()['state'], 'HALTED')
  assert.equal(d.broker.placed.length, 1, 'the remaining tranches are not placed')
  assert.match(String(d.doc()['reason']), /XTS session released by operator/)
  assert.equal(d.doc()['filledQty'], 3 * LOT, 'what traded before the release is still recorded')
  const alert = d.events.rows.find(
    (e) => e['ok'] === false && /released by operator/.test(String(e['error'] ?? '')),
  )
  assert.ok(alert !== undefined, 'and it is in the failures feed')
  assert.equal(alert?.['status'], 'HALTED')

  // Reconnecting does not resurrect a halted order: the desk re-plans.
  link.released = false
  await d.sweep()
  assert.equal(d.broker.placed.length, 1)
})

test('a REJECTED tranche HALTS the order, loudly, and nothing further is placed', async () => {
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  d.broker.rejectAt = 2
  await d.sweep()
  await d.step(101)
  await d.settle()

  assert.equal(d.doc()['state'], 'HALTED', 'D11: a refused tranche stops the sequence')
  assert.equal(d.broker.placed.length, 2, 'tranche 3 is NEVER placed')
  // What actually filled is still on the document: the desk holds three lots
  // and must not be told it holds nine or nothing.
  assert.equal(d.doc()['filledQty'], 3 * LOT)

  const alert = d.events.rows.find(
    (e) => e['ok'] === false && String(e['error'] ?? '').includes('HALTED'),
  )
  assert.ok(alert !== undefined, 'the halt is in the failures feed, not only in a log line')
  assert.match(String(alert?.['error']), /margin shortfall/, 'and it says why')
  assert.equal(alert?.['clientOrderId'], BASE)

  // Sweeping again must not resurrect it.
  await d.sweep()
  assert.equal(d.broker.placed.length, 2)
  assert.equal(d.doc()['state'], 'HALTED')
})

test('ONE sub-order of a freeze-split tranche filling does NOT release the next', async () => {
  /**
   * The tranche is the unit, not the broker order. A 6-lot slice under a 5-lot
   * freeze is two orders; releasing the next slice when the 5-lot half fills
   * would put THREE broker orders on the market at once for an order the desk
   * asked to be worked six lots at a time — the gate defeated by its own
   * freeze split.
   */
  const d = desk({ trancheLots: 6, workMode: 'passive' }, { freezeLots: 5 })
  d.broker.holdAt = 2 // the 1-lot half is accepted and left working
  await d.sweep()
  assert.deepEqual(qtysPlaced(d), [5 * LOT, 1 * LOT])

  await d.step(101) // fills the 5-lot half only

  assert.equal(d.doc()['trancheCursor'], 0, 'the tranche is not done until BOTH halves are')
  assert.equal(d.broker.placed.length, 2, 'and nothing new is placed')
  assert.equal(d.doc()['state'], 'PLACED')
})

test('a tranche of an OPEN that goes terminal SHORT halts too', async () => {
  // Not only a rejection: a terminal slice of an ENTRY that did not fill in
  // full means the desk's next decision was made against a size it does not
  // hold. Adding more on top of that is the one thing that must not happen
  // automatically.
  const d = desk({ trancheLots: 3, workMode: 'passive', desk_op: 'open' })
  await d.sweep()
  // The broker cancels the resting tranche (an exchange-side cancel, a session
  // drop, a human on the Broker page).
  await d.broker.sim.cancelOrder('sim-test-1')
  await d.settle()

  assert.equal(d.doc()['state'], 'HALTED')
  assert.equal(d.broker.placed.length, 1)
})

test('a tranche of an EXIT that goes terminal SHORT carries on — loudly', async () => {
  /**
   * THE OPEN/EXIT ASYMMETRY, the same one every other gate on this path makes.
   * Halting a close after one short tranche abandons the rest of an exit the
   * desk decided on with NOTHING retrying it: the position stays open and
   * unworked while the book says it is going away. Continuing cannot over-close
   * — the plan sums to the order's own quantity.
   */
  const d = desk({ trancheLots: 3, workMode: 'passive', desk_op: 'close' })
  await d.sweep()
  await d.broker.sim.cancelOrder('sim-test-1')
  await d.settle()

  assert.equal(d.doc()['state'], 'PLACED', 'not halted')
  assert.equal(d.doc()['trancheCursor'], 1)
  assert.equal(d.broker.placed.length, 2, 'the rest of the exit still goes out')

  // Carried on is NOT the same fact as filled, and the line that reports it
  // must not say the second when it means the first.
  const loud = d.events.rows.find(
    (e) => e['ok'] === false && String(e['error'] ?? '').includes('SHORT'),
  )
  assert.ok(loud !== undefined, 'a short tranche is in the failures feed even when it continues')
  assert.match(String(loud?.['error']), /reduces exposure/)
})

test('a REJECTED tranche of an EXIT also carries on, rather than stranding the close', async () => {
  const d = desk({ trancheLots: 3, workMode: 'passive', desk_op: 'close' })
  d.broker.rejectAt = 1
  await d.sweep()
  await d.settle()

  assert.notEqual(d.doc()['state'], 'HALTED')
  assert.equal(d.broker.placed.length, 2)
})

test('a gate engaged BETWEEN tranches stops the rest — HALTED, never INVALID', async () => {
  /**
   * The gates re-run per slice on purpose: a kill switch thrown mid-sequence
   * must stop what has not gone out. But the refusal cannot be the ordinary
   * one — INVALID reads as "this order could not be planned at all", and here
   * a third of it is a real position at a real price. An operator reading that
   * next to "queued order not placed" would re-submit the whole nine lots.
   */
  const gate = { on: false }
  const d = desk({ trancheLots: 3, workMode: 'passive' }, { halt: gate })
  await d.sweep()
  gate.on = true
  await d.step(101)

  assert.equal(d.doc()['state'], 'HALTED')
  assert.equal(d.broker.placed.length, 1, 'the remaining tranches are not placed')
  assert.match(String(d.doc()['reason']), /kill switch/)
  const alert = d.events.rows.find(
    (e) => e['ok'] === false && String(e['error'] ?? '').includes('kill switch'),
  )
  assert.ok(alert !== undefined, 'and it is in the failures feed')
  assert.match(String(alert?.['error']), /^HALTED: /)
  /**
   * AND IT SAYS HALTED IN THE STATUS COLUMN, not just in the message.
   *
   * The Orders page renders `status` and falls back to the phase when there is
   * none, so this row read REJECTED — the one word meaning "nothing traded"
   * about an order that had just put three lots on at 101. `FillWatcher.#halt`
   * (the OTHER way an order halts) has always stamped it; this site did not,
   * and the same incident rendered two different ways depending on which of
   * them got there first.
   */
  assert.equal(alert?.['status'], 'HALTED')

  /**
   * AND WHAT ALREADY TRADED IS ON THE DOCUMENT. Three lots really filled at
   * 101; `service.ts:#actualEntries` prices legs off these two fields and skips
   * a document without them, and `reconcile-live.ts` folds the shortfall back
   * off the same two. A halt that recorded only its reason would leave the leg
   * marked at the seed price and the book carrying nine lots for three.
   */
  assert.equal(d.doc()['filledQty'], 3 * LOT)
  assert.equal(d.doc()['avgPrice'], 101)
})

// ------------------------------------------------------------------ the CAS

test('two watchers observing one terminal tranche advance the cursor ONCE', async () => {
  // F-10. Both read cursor 0 and both conclude "advance"; the compare-and-set
  // is what stops the second from placing tranche 2 a second time.
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  await d.sweep()
  d.broker.feedTick(101)

  await Promise.all([d.watcher.reconcile(BASE), d.watcher.reconcile(BASE)])
  await d.settle()

  assert.equal(d.doc()['trancheCursor'], 1, 'one advance, not two')
  assert.equal(d.broker.placed.length, 2, 'and therefore one new tranche, not two')
})

test('a STALE cursor cannot advance the order — the CAS refuses it', async () => {
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  await d.sweep()
  await d.step(101)
  assert.equal(d.doc()['trancheCursor'], 1)

  // A worker that read the document before the advance, and acts on it after.
  assert.equal(await d.queue.advanceTranche(BASE, 0), false)
  assert.equal(d.doc()['trancheCursor'], 1, 'the stale advance moved nothing')
  assert.equal(d.doc()['state'], 'PLACED', 'and did not re-arm the document either')
})

test('the advance clears the CHASER’s per-slice state', async () => {
  // Otherwise a slice whose chase exhausted would leave `chaseExhaustedAt` on
  // the document, and every later tranche would be invisible to the chaser —
  // resting at a price nothing re-pegs, on a passive order, in silence.
  const d = desk({ trancheLots: 3, workMode: 'passive' })
  await d.sweep()
  Object.assign(d.doc(), {
    chaseAttempts: 3,
    chasedAt: NOW,
    lastChasePrice: 99.5,
    chaseExhaustedAt: NOW,
    pegCrossedAt: NOW,
  })
  await d.step(101)

  for (const k of ['chaseAttempts', 'chasedAt', 'lastChasePrice', 'chaseExhaustedAt', 'pegCrossedAt']) {
    assert.equal(d.doc()[k], undefined, `${k} must not survive into the next tranche`)
  }
  // And the new slice's own placement clock is the one the peg deadline reads.
  assert.equal(d.doc()['placedAt'], NOW)
})
