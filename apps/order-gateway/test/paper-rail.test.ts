/**
 * THE GATEWAY WORKS A PAPER ORDER LIKE A LIVE ONE — and sends it somewhere else
 * entirely (D14, plan Task 18).
 *
 * `desk-gateway-orders` now carries two rails. That is the whole point: an
 * engine paper order gets the same queue, the same claim, the same plan, the
 * same freeze split, the same tranche cursor and the same fill correlation as a
 * live one, because a rehearsal that skipped any of them would be rehearsing
 * something else. The only differences are which BROKER it reaches and which
 * gate it is asked to pass.
 *
 * Both of those are worth a suite, and for opposite reasons:
 *
 *   THE ADAPTER CHOICE IS THE MONEY QUESTION. A paper document routed to the
 *   real adapter places a REAL order out of a rehearsal, which is not
 *   recoverable. So the predicate is fail-closed — only an explicit
 *   `mode: 'paper'` is paper — and both directions are pinned here.
 *
 *   THE ALLOWLIST SKIP IS THE ONE GATE THAT MUST NOT APPLY. It answers "may
 *   this tag spend real money", and asking it of a simulated order would mean
 *   every paper book needed its password-gated LIVE switch turned on to
 *   rehearse — which is precisely the switch nobody should flip to run one.
 *   Everything else (kill switch, staleness) still applies, and that is pinned
 *   too.
 *
 * Mongo-free: the fakes are the same ones the tranche suite drives.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter, type PlacedOrder } from '@algomaker/brokers'
import { FreezeLimits } from '@algomaker/instruments'
import type { OrderIntent } from '@algomaker/order-bus'
import { FakeCollection, FakeFills, FakeJournal } from './mongo-harness.ts'
import { createOrderPlacer, isPaperOrder, tickFanout } from '../src/main.ts'
import { DemoRail, createAdapterRouter } from '../src/dx-demo.ts'
import { createPaperSweep, DEFAULT_PAPER_ORPHAN_MS } from '../src/paper-sweep.ts'
import { OrderQueue, createSweeper } from '../src/queue.ts'
import { FillWatcher } from '../src/fills.ts'
import { OrderJournal } from '../src/journal.ts'
import { createQuoteMap } from '../src/quote-map.ts'
import type { ResolvedContract } from '../src/gateway.ts'

const LOT = 75
const SYMBOL = 'NIFTY26AUG25000CE'
const TOKEN = 12345
const TAG = 'DESK_NIFTY'
const BASE = 'ord-1'
/** What `BrokerLink.refusal()` says — the placer only relays it. */
const RELEASED =
  'XTS session released by operator (need the key elsewhere); the gateway is logged out and live ' +
  'orders cannot be placed until it is reconnected from Controls'
const NOW = 1_700_000_000_000

const CONTRACT: ResolvedContract = {
  tradingsymbol: SYMBOL,
  instrumentToken: TOKEN,
  lotSize: LOT,
  tickSize: 0.05,
  exchange: 'NFO',
  underlying: 'NIFTY',
}

// ------------------------------------------------------- the mode predicate

test('ONLY an exact mode:live is live — everything else is PAPER (Delta desk)', () => {
  assert.equal(isPaperOrder({ mode: 'live' }), false)
  assert.equal(isPaperOrder({ mode: 'paper' }), true)
  /**
   * The one that matters on this desk: a document with no mode at all is a
   * rehearsal, never real money. A live order must say so, exactly.
   */
  assert.equal(isPaperOrder({}), true)
  // And nothing loose counts: a stray truthy value is not a rail.
  assert.equal(isPaperOrder({ mode: 'LIVE' }), true)
  assert.equal(isPaperOrder({ mode: 'Live' }), true)
  assert.equal(isPaperOrder({ mode: true }), true)
  assert.equal(isPaperOrder({ live: true }), true)
})

// ------------------------------------------------------------ the fan-out

test('one tick reaches the quote map AND every simulator, off the same frame', () => {
  const quotes = createQuoteMap({ now: () => NOW })
  const fed: [number, number][] = []
  const fanout = tickFanout({
    quotes,
    sims: [{ feedTick: (token, price) => void fed.push([token, price]) }],
  })

  fanout({ token: TOKEN, price: 101.5, bid: 101, ask: 102, ts: NOW })

  assert.deepEqual(quotes.touch(TOKEN), { bid: 101, ask: 102, ts: NOW })
  // THE SAME FRAME. A peg that followed one book while the fill model crossed
  // off another would be rehearsing two different markets.
  assert.deepEqual(fed, [[TOKEN, 101.5]])
})

test('a frame with no usable price feeds no simulator, and never NaN', () => {
  const fed: unknown[] = []
  const fanout = tickFanout({
    quotes: { onTick: () => {} },
    sims: [{ feedTick: (t, p) => void fed.push([t, p]) }],
  })
  // Every comparison against NaN is false, so a NaN price would silently mean
  // "this order never fills" rather than failing loudly.
  for (const junk of [
    null,
    'tick',
    { token: TOKEN },
    { token: TOKEN, price: 0 },
    { token: TOKEN, price: -1 },
    { token: TOKEN, price: 'ten' },
    { price: 10 },
  ]) {
    fanout(junk)
  }
  assert.deepEqual(fed, [])
})

test('a simulator that THROWS does not cost the quote map its frame', () => {
  const quotes = createQuoteMap({ now: () => NOW })
  const fanout = tickFanout({
    quotes,
    sims: [
      {
        feedTick: () => {
          throw new Error('fill handler exploded')
        },
      },
    ],
  })
  // The map is fed FIRST and the throw is swallowed: this runs inside a bus
  // subscriber on the only process that can place orders.
  fanout({ token: TOKEN, price: 10, bid: 9.9, ask: 10.1, ts: NOW })
  assert.notEqual(quotes.touch(TOKEN), null)
})

// ------------------------------------------- the book rides with the print

test('the frame’s book rides to every simulator beside its print, when both sides are real', () => {
  const quotes = createQuoteMap({ now: () => NOW })
  const fed: unknown[][] = []
  const fanout = tickFanout({
    quotes,
    sims: [{ feedTick: (...args) => void fed.push(args) }],
  })

  fanout({ token: TOKEN, price: 101.5, bid: 101, ask: 102, ts: NOW })

  // THE SAME BOOK. The peg reads it off the quote map and the fill model takes it as the simulator's
  // third argument, both off the one frame — so a limit the peg sees as marketable is one the paper
  // rail fills, and the frame's `ts` stays the quote map's business.
  assert.deepEqual(quotes.touch(TOKEN), { bid: 101, ask: 102, ts: NOW })
  assert.deepEqual(fed, [[TOKEN, 101.5, { bid: 101, ask: 102 }]])
})

test('a frame whose book is not two real sides feeds the print alone — no quote argument at all', () => {
  const fed: unknown[][] = []
  const fanout = tickFanout({
    quotes: { onTick: () => {} },
    sims: [{ feedTick: (...args) => void fed.push(args) }],
  })
  // A fill at a side the book does not have is a fill at a price nobody offered. One side alone, a
  // zero, a negative, a NaN, an Infinity, a string and a null are all "no book" — never a half-book.
  const books: Record<string, unknown>[] = [
    {},
    { bid: 101 },
    { ask: 102 },
    { bid: 0, ask: 102 },
    { bid: 101, ask: 0 },
    { bid: -1, ask: 102 },
    { bid: 101, ask: -1 },
    { bid: Number.NaN, ask: 102 },
    { bid: 101, ask: Number.POSITIVE_INFINITY },
    { bid: '101', ask: '102' },
    { bid: null, ask: null },
  ]
  for (const book of books) fanout({ token: TOKEN, price: 101.5, ts: NOW, ...book })
  // `[token, price]` exactly: `[token, price, undefined]` would be a third argument.
  assert.deepEqual(
    fed,
    books.map(() => [TOKEN, 101.5]),
  )
})

/** A paper LIMIT on this file's contract, as the placer hands it to the simulator. */
function paperLimit(clientOrderId: string, side: 'BUY' | 'SELL', limitPrice: number): OrderIntent {
  return {
    clientOrderId,
    ts: NOW,
    strategyTag: TAG,
    mode: 'sim',
    destinations: ['sim'],
    instrument: { tradingsymbol: SYMBOL, instrumentToken: TOKEN, lotSize: LOT, tickSize: 0.05, exchange: 'NFO' },
    side,
    orderType: 'LIMIT',
    limitPrice,
    quantity: LOT,
    lots: 1,
  }
}

test('a resting paper LIMIT the frame’s book crosses fills at the touch — the 1 Oct close, end to end', async () => {
  const quotes = createQuoteMap({ now: () => NOW })
  const sim = new SimulatorAdapter()
  const fanout = tickFanout({ quotes, sims: [sim] })
  const fills: [string, number | null][] = []
  sim.onFill((o) => {
    if (o.status === 'FILLED') fills.push([o.clientOrderId, o.avgPrice])
  })

  fanout({ token: TOKEN, price: 140, bid: 139.5, ask: 140.5, ts: NOW })
  await sim.placeOrder(paperLimit('close', 'SELL', 136.65))
  // The put is falling: the last print (136.2) is under the limit, so the old rule waited for a print
  // above it for ever — while the book still bids 137.35.
  fanout({ token: TOKEN, price: 136.2, bid: 137.35, ask: 137.7, ts: NOW })

  assert.deepEqual(fills, [['close', 137.35]])
  assert.deepEqual(quotes.touch(TOKEN), { bid: 137.35, ask: 137.7, ts: NOW }, 'the peg read that very book')
})

test('a crossed frame fills nothing: the simulator and the quote map refuse the same bad book', async () => {
  const quotes = createQuoteMap({ now: () => NOW })
  const sim = new SimulatorAdapter()
  const fanout = tickFanout({ quotes, sims: [sim] })
  const fills: unknown[] = []
  sim.onFill((o) => {
    if (o.status === 'FILLED') fills.push(o.clientOrderId)
  })

  fanout({ token: TOKEN, price: 106, ts: NOW })
  await sim.placeOrder(paperLimit('buy', 'BUY', 105))
  // Ask 101 under bid 102 is a bad frame, not a market. Taken at face value it would fill the buy at 101.
  fanout({ token: TOKEN, price: 106, bid: 102, ask: 101, ts: NOW })

  assert.deepEqual(fills, [])
  assert.equal(quotes.touch(TOKEN), null)
})

// -------------------------------------------------------- the placement path

/** A broker that records what reached it, so "which adapter" is observable. */
class Broker {
  readonly sim = new SimulatorAdapter()
  readonly placed: OrderIntent[] = []
  readonly name: string
  readonly capabilities = { orders: true, marketData: false, modify: true }
  constructor(name: string) {
    this.name = name
  }
  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    this.placed.push(intent)
    return await this.sim.placeOrder(intent)
  }
  onOrderUpdate(h: (o: PlacedOrder) => void): () => void {
    return this.sim.onOrderUpdate(h)
  }
}

function desk(
  order: Record<string, unknown> = {},
  opts: {
    readonly live?: boolean
    readonly halt?: boolean
    /** The operator's "turn the live broker off" switch (the placer's link gate). */
    readonly link?: { readonly released: boolean }
    /**
     * Route through the gateway's real per-order router (`createAdapterRouter`)
     * with this as the book's `dx_paper_rail`, and `demo` as the demo rail.
     */
    readonly bookRail?: 'sim' | 'demo'
    /** Is the stored demo key usable? Default yes. */
    readonly demoReady?: { ok: true } | { ok: false; why: string }
    readonly demo?: Pick<Broker, 'placeOrder' | 'onOrderUpdate'>
  } = {},
): {
  readonly live: Broker
  readonly paper: Broker
  readonly demo: Broker
  readonly orders: FakeCollection
  readonly events: FakeJournal
  readonly fills: FakeFills
  readonly allowlistAsked: string[]
  sweep(): Promise<void>
  settle(): Promise<void>
  doc(): Record<string, unknown>
} {
  const orders = new FakeCollection()
  orders.docs.push({
    clientOrderId: BASE,
    state: 'PENDING',
    createdAt: NOW,
    tradingsymbol: SYMBOL,
    transaction_type: 'SELL',
    order_type: 'LIMIT',
    limitPrice: 100,
    quantity: LOT,
    tag: TAG,
    desk_op: 'open',
    desk_tag: 'CE25000#0',
    underlying: 'NIFTY',
    ...order,
  })
  const fills = new FakeFills()
  const events = new FakeJournal()
  const live = new Broker('live')
  const paper = new Broker('paper')
  const demo = new Broker('demo')
  const allowlistAsked: string[] = []
  const now = (): number => NOW
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
    adapterFor:
      opts.bookRail === undefined
        ? (doc) => (isPaperOrder(doc) ? paper : live)
        : createAdapterRouter({
            env: opts.live === true ? { DESK_BROKER: 'delta', DESK_DX_LIVE: '1' } : {},
            simulator: paper as Pick<Broker, 'placeOrder'>,
            live: live as Pick<Broker, 'placeOrder'>,
            demo: (opts.demo ?? demo) as Pick<Broker, 'placeOrder'>,
            bookState: async () => ({ setting: opts.bookRail ?? 'demo', held: false, lastUsed: null }),
            demoReady: async () => opts.demoReady ?? { ok: true },
            stamp: async (doc, rail, note) => {
              await orders.updateOne({ clientOrderId: doc['clientOrderId'] }, { $set: { dx_paper_rail: rail, dx_rail_note: note } })
            },
          }),
    resolveContract: (s) => (s === SYMBOL ? CONTRACT : null),
    freeze: () => new FreezeLimits([{ symbol: 'NIFTY', freezeQty: 100 * LOT }]),
    allowsLive: async (tag) => {
      allowlistAsked.push(tag)
      return opts.live === true
    },
    readHalt: async () =>
      opts.halt === true
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
  for (const b of [live, paper, demo]) b.onOrderUpdate((u) => void inflight.push(watcher.handle(u)))

  return {
    live,
    paper,
    demo,
    orders,
    events,
    fills,
    allowlistAsked,
    sweep: () => sweeper.sweep(),
    settle: async () => {
      for (let i = 0; i < 50 && inflight.length > 0; i++) await Promise.all(inflight.splice(0))
    },
    doc: () => orders.docs[0] as Record<string, unknown>,
  }
}

// ------------------------------------------------------------ the demo rail

test("a PAPER order on a 'demo' book reaches the demo rail and is stamped demo; the simulator and live see nothing", async () => {
  const d = desk({ mode: 'paper' }, { live: true, bookRail: 'demo' })
  await d.sweep()
  await d.settle()
  assert.equal(d.demo.placed.length, 1)
  assert.equal(d.paper.placed.length, 0)
  assert.equal(d.live.placed.length, 0)
  assert.equal(d.doc()['dx_paper_rail'], 'demo')
  assert.equal(d.doc()['state'], 'PLACED')
  assert.deepEqual(d.allowlistAsked, [])
  // The journal says which rail was used.
  const planned = d.events.rows.find((e) => e['phase'] === 'PLANNED')
  const detail = planned?.['detail'] as Record<string, unknown> | undefined
  assert.equal(detail?.['rail'], 'demo')
  assert.match(String(detail?.['railNote']), /Delta testnet/)
})

test('no verified demo key: a PAPER order falls back to the SIMULATOR, and the journal says why', async () => {
  const d = desk({ mode: 'paper' }, { bookRail: 'demo', demoReady: { ok: false, why: 'no Delta Demo key stored' } })
  await d.sweep()
  await d.settle()
  assert.equal(d.paper.placed.length, 1)
  assert.equal(d.demo.placed.length, 0)
  assert.equal(d.doc()['dx_paper_rail'], 'sim')
  const detail = d.events.rows.find((e) => e['phase'] === 'PLANNED')?.['detail'] as Record<string, unknown> | undefined
  assert.equal(detail?.['rail'], 'sim')
  assert.equal(detail?.['railNote'], 'simulator — no Delta Demo key stored')
})

test("a LIVE order on a book whose paper rail is 'demo' still goes to the live adapter, unstamped", async () => {
  const d = desk({ mode: 'live' }, { live: true, bookRail: 'demo' })
  await d.sweep()
  await d.settle()
  assert.equal(d.live.placed.length, 1)
  assert.equal(d.demo.placed.length, 0)
  assert.equal(d.doc()['dx_paper_rail'], undefined)
})

test('a symbol the testnet does not list is refused, and the JOURNAL carries the reason', async () => {
  const rail = new DemoRail({
    loadConfig: async () => ({
      baseUrl: 'https://cdn-ind.testnet.deltaex.org',
      wsUrl: 'wss://socket-ind.testnet.deltaex.org',
      apiKey: 'DK',
      apiSecret: 'DS',
      source: 'broker-store',
    }),
    makeRest: () =>
      ({
        products: async () => [{ id: 1, symbol: 'C-BTC-77000-041126', contract_type: 'call_options', contract_value: '0.001', tick_size: '0.1' }],
        placeOrder: async () => {
          throw new Error('must not be sent')
        },
      }) as never,
    now: () => NOW,
    log: () => {},
  })
  const d = desk({ mode: 'paper' }, { bookRail: 'demo', demo: rail as never })
  await d.sweep()
  await d.settle()
  assert.equal(d.paper.placed.length, 0, 'never the simulator instead')
  const failed = d.events.rows.find((e) => e['phase'] === 'FAILED')
  assert.ok(failed !== undefined, 'a FAILED row is journalled')
  assert.match(String(failed['error']), new RegExp(`${SYMBOL} is not listed on the Delta testnet`))
  assert.equal(failed['errorClass'], 'fatal')
  assert.equal(d.doc()['dx_paper_rail'], 'demo')
})

test('a PAPER order reaches the simulator, and the live allowlist is never asked', async () => {
  // The allowlist answers NO for everything, so a paper order that were asked
  // would be refused — which is exactly how this used to fail.
  const d = desk({ mode: 'paper' }, { live: false })
  await d.sweep()
  await d.settle()

  assert.equal(d.paper.placed.length, 1)
  assert.equal(d.live.placed.length, 0, 'nothing reached the real broker')
  assert.deepEqual(d.allowlistAsked, [], 'the LIVE switch is not a paper order’s gate')
  assert.equal(d.doc()['state'], 'PLACED')
})

test('a LIVE order still goes to the live adapter, and is still refused by the allowlist', async () => {
  const d = desk({ mode: 'live' }, { live: false })
  await d.sweep()
  await d.settle()

  assert.deepEqual(d.allowlistAsked, [TAG])
  assert.equal(d.live.placed.length, 0)
  assert.equal(d.paper.placed.length, 0)
  assert.equal(d.doc()['state'], 'INVALID')
  assert.match(String(d.doc()['reason']), /not switched on for LIVE/)
})

test('a RELEASED broker link refuses a live order — the exit too — and never a paper one', async () => {
  /**
   * Released means LOGGED OUT: there is no session to place with, and placing
   * would first re-log in, which is the one thing the release forbids. So this
   * is the one gate that stops an exit as well — not a policy about exposure,
   * the absence of a broker. It is asked BEFORE the allowlist: the operator
   * turned the broker off, and the reason must say that, not "not switched on".
   */
  const open = desk({ mode: 'live' }, { live: true, link: { released: true } })
  await open.sweep()
  await open.settle()
  assert.equal(open.live.placed.length, 0, 'nothing reached the real broker')
  assert.equal(open.doc()['state'], 'INVALID')
  assert.match(String(open.doc()['reason']), /XTS session released by operator/)
  assert.match(String(open.doc()['reason']), /need the key elsewhere/)
  assert.deepEqual(open.allowlistAsked, [], 'the link is asked first — the switch is not the story')
  const alert = open.events.rows.find((e) => e['ok'] === false && /released/.test(String(e['error'])))
  assert.ok(alert !== undefined, 'and it is in the failures feed')
  assert.equal((alert['detail'] as Record<string, unknown> | undefined)?.['mode'], 'live')

  const exit = desk({ mode: 'live', desk_op: 'close', transaction_type: 'BUY' }, { live: true, link: { released: true } })
  await exit.sweep()
  await exit.settle()
  assert.equal(exit.live.placed.length, 0, 'an exit cannot be placed without a session either')
  assert.match(String(exit.doc()['reason']), /released by operator/)

  // Paper never spoke to XTS: the rehearsal carries on while the key is elsewhere.
  const paper = desk({ mode: 'paper' }, { live: false, link: { released: true } })
  await paper.sweep()
  await paper.settle()
  assert.equal(paper.paper.placed.length, 1)
  assert.equal(paper.doc()['state'], 'PLACED')
})

test('a live order with the switch ON reaches the LIVE adapter, never the simulator', async () => {
  const d = desk({ mode: 'live' }, { live: true })
  await d.sweep()
  await d.settle()

  assert.equal(d.live.placed.length, 1)
  assert.equal(d.paper.placed.length, 0)
})

/**
 * THE ALLOWLIST IS NEVER ASKED OF AN EXIT (C-1, spec §9).
 *
 * The defect these pin. `LiveRail.#exits` lets a switched-off live tag's close
 * through the FIRST gate, so desk-api counts it routed, folds the book as
 * closed and writes the legs back, and the supervisor settles DONE — and then
 * THIS gate refused it. Nothing un-books a gateway refusal, so the desk read
 * flat against a position still live at the broker, with the supervisor's
 * cumRealized and rcStack permanently wrong.
 *
 * The pass list has to be EXACTLY the rail's: `close` and `resize`. Looser
 * (`reducesExposure`, which adds `roll`) and this gate stops being the second
 * independent gate; tighter (`close` alone) and the same false fold happens for
 * every shrinking resize.
 */
test('C-1: a live CLOSE reaches the adapter with the switch OFF — an exit is never gated', async () => {
  const d = desk({ mode: 'live', desk_op: 'close', transaction_type: 'BUY' }, { live: false })
  await d.sweep()
  await d.settle()

  assert.equal(d.live.placed.length, 1, 'the exit went out')
  assert.equal(d.paper.placed.length, 0, 'and it went to the REAL broker, not the simulator')
  assert.deepEqual(d.allowlistAsked, [], 'the switch is not even consulted for an exit')
  assert.notEqual(d.doc()['state'], 'INVALID')
})

test('C-1: a live SHRINKING RESIZE reaches the adapter with the switch OFF', async () => {
  /**
   * A `resize` that gets this far on a switched-off tag is shrinking BY
   * CONSTRUCTION — `LiveRail.#exits` refused the growing ones, using the book
   * this process cannot see. Refusing it here would re-create C-1 for resizes.
   */
  const d = desk({ mode: 'live', desk_op: 'resize', transaction_type: 'BUY' }, { live: false })
  await d.sweep()
  await d.settle()

  assert.equal(d.live.placed.length, 1)
  assert.deepEqual(d.allowlistAsked, [])
  assert.notEqual(d.doc()['state'], 'INVALID')
})

test('C-1: a live OPEN with the switch OFF is still refused — the gate still gates', async () => {
  // The half that must NOT move. The exemption is for exits, and an `open` is
  // the new exposure the switch exists to stop.
  const d = desk({ mode: 'live', desk_op: 'open' }, { live: false })
  await d.sweep()
  await d.settle()

  assert.deepEqual(d.allowlistAsked, [TAG], 'the switch IS consulted for an open')
  assert.equal(d.live.placed.length, 0)
  assert.equal(d.doc()['state'], 'INVALID')
  assert.match(String(d.doc()['reason']), /not switched on for LIVE/)
})

test('C-1: an UNKNOWN or absent desk_op is still gated — the exemption is a pass list', async () => {
  /**
   * Fail closed, the rule every other gate on this path follows. An op this
   * process does not recognise is unknown in BOTH directions, and `roll` is
   * named here because the rail refuses a roll whole — this gate must never be
   * looser than the rail's `#exits`.
   */
  for (const op of ['roll', 'rebalance', undefined]) {
    const d = desk({ mode: 'live', desk_op: op }, { live: false })
    await d.sweep()
    await d.settle()

    assert.deepEqual(d.allowlistAsked, [TAG], `desk_op '${String(op)}' is asked`)
    assert.equal(d.live.placed.length, 0, `desk_op '${String(op)}' did not place`)
    assert.equal(d.doc()['state'], 'INVALID')
  }
})

test('the kill switch DOES stop a paper open — it is a statement about the desk', async () => {
  /**
   * D14 says the ACTION PATH must match live, and the halt is part of that
   * path. Exempting paper would mean the one control an operator reaches for
   * mid-incident behaves differently in the rehearsal than in the session, and
   * the rehearsal is where that difference would never be noticed.
   */
  const d = desk({ mode: 'paper' }, { halt: true })
  await d.sweep()
  await d.settle()

  assert.equal(d.paper.placed.length, 0)
  assert.equal(d.doc()['state'], 'INVALID')
  assert.match(String(d.doc()['reason']), /kill switch engaged/)
})

test('a paper fill is stamped PAPER in desk-fills, and a live one is not', async () => {
  const paperDesk = desk({ mode: 'paper' }, { live: false })
  await paperDesk.sweep()
  await paperDesk.settle()
  // A print through the resting sell limit.
  paperDesk.paper.sim.feedTick(TOKEN, 101)
  await paperDesk.settle()

  const filled = paperDesk.fills.rows.filter((r) => r['status'] === 'FILLED')
  assert.equal(filled.length, 1)
  /**
   * The field the whole downstream split turns on: desk-api's live reconciler
   * scans by it, `/v1/desk/trades?mode=live` filters by it, and the Python
   * desk's own reconcile books against it. A paper fill labelled live would be
   * booked against the LIVE book.
   */
  assert.equal(filled[0]?.['mode'], 'paper')

  const liveDesk = desk({ mode: 'live' }, { live: true })
  await liveDesk.sweep()
  await liveDesk.settle()
  liveDesk.live.sim.feedTick(TOKEN, 101)
  await liveDesk.settle()

  const liveFills = liveDesk.fills.rows.filter((r) => r['status'] === 'FILLED')
  assert.equal(liveFills.length, 1)
  assert.equal(liveFills[0]?.['mode'], 'live')
})

/**
 * THE JOURNAL SAYS WHICH RAIL TOO (D9's removal ticket).
 *
 * `desk-fills` was stamped when the paper lifecycle landed; the ORDER JOURNAL
 * was not, and it is what the Orders page reads. Its filter is "paper iff the
 * row says so", so every unstamped PLANNED / SUBMITTED / ACK / STATUS row a
 * rehearsal wrote fell on the LIVE side of it — a paper book's routing on the
 * live tab, and a paper tab that showed none of it.
 *
 * EVERY row, not a sample: one unstamped site is one step of a rehearsal
 * rendering under the wrong rail, which is exactly the state this ends.
 */
test('every journal row of a paper placement says paper, and a live one says live', async () => {
  const p = desk({ mode: 'paper' }, { live: false })
  await p.sweep()
  await p.settle()
  p.paper.sim.feedTick(TOKEN, 101)
  await p.settle()

  assert.ok(p.events.rows.length > 0, 'the placement journalled something')
  for (const row of p.events.rows) {
    const detail = row['detail'] as Record<string, unknown> | undefined
    assert.equal(detail?.['mode'], 'paper', `${String(row['phase'])} row is unstamped`)
  }

  const l = desk({ mode: 'live' }, { live: true })
  await l.sweep()
  await l.settle()
  l.live.sim.feedTick(TOKEN, 101)
  await l.settle()

  assert.ok(l.events.rows.length > 0)
  for (const row of l.events.rows) {
    const detail = row['detail'] as Record<string, unknown> | undefined
    assert.equal(detail?.['mode'], 'live', `${String(row['phase'])} row is unstamped`)
  }
})

test('a REFUSAL is stamped with the rail it was refused on', async () => {
  // The rows an operator asking "why did nothing trade this morning?" is
  // looking for — and the ones most likely to be read under the wrong tab,
  // because a refused order leaves nothing else behind.
  const d = desk({ mode: 'paper' }, { halt: true })
  await d.sweep()
  await d.settle()

  const refusal = d.events.rows.find((e) => e['ok'] === false)
  assert.ok(refusal !== undefined, 'the halt is journalled')
  assert.equal((refusal['detail'] as Record<string, unknown> | undefined)?.['mode'], 'paper')
})

// ------------------------------------------------- the restart orphan sweep

/**
 * THE ONE THING A RESTART TAKES FROM A PAPER ORDER AND NOT FROM A LIVE ONE.
 *
 * A live resting order survives this process dying — it is at the exchange, and
 * the socket replay, the broker sweep and the boot reconcile all go and find it
 * again. A paper one lives in the simulator's memory, which a restart empties:
 * no tick can fill it, the broker sweep is scoped away from it, the chaser's
 * modify against a `sim-N` the new simulator never issued answers false
 * forever, and the fold pass scans TERMINAL states only. The document sits
 * PLACED and the decision that owns it stays WORKING for the whole session.
 *
 * The verdict is a FACT rather than a timeout: an order placed before this
 * process booted cannot be in this process's simulator, because the simulator's
 * book is created empty. That is what makes it impossible for this to race a
 * fill — an order this process placed is never eligible, whatever its age.
 */
function orphanDesk(
  docs: Record<string, unknown>[],
  opts: { readonly bootedAt?: number; readonly now?: number; readonly resting?: string[] } = {},
): {
  readonly orders: FakeCollection
  readonly events: FakeJournal
  run(): Promise<{ scanned: number; orphaned: number }>
  doc(id: string): Record<string, unknown> | undefined
} {
  const orders = new FakeCollection()
  for (const d of docs) orders.docs.push(d)
  const events = new FakeJournal()
  const bootedAt = opts.bootedAt ?? NOW
  const now = opts.now ?? NOW + DEFAULT_PAPER_ORPHAN_MS
  const queue = new OrderQueue({ collection: orders, workerId: 'w1', now: () => now })
  const sweep = createPaperSweep({
    adapter: {
      orderBook: async () =>
        (opts.resting ?? []).map((brokerOrderId) => ({
          brokerOrderId,
          clientOrderId: '',
          tradingsymbol: SYMBOL,
          status: 'WORKING',
          filledQty: 0,
          avgPrice: null,
        })),
    },
    queue,
    journal: new OrderJournal({ collection: events, now: () => now }),
    orders,
    bootedAt,
    now: () => now,
    log: () => {},
  })
  return {
    orders,
    events,
    run: () => sweep.run(),
    doc: (id) => orders.docs.find((d) => d['clientOrderId'] === id),
  }
}

const placedPaperDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientOrderId: BASE,
  mode: 'paper',
  state: 'PLACED',
  tag: TAG,
  tradingsymbol: SYMBOL,
  placedAt: NOW - 60_000,
  brokerOrderIds: ['sim-1'],
  trancheIds: [BASE],
  expectedQty: LOT,
  ...over,
})

test('a paper order stranded by a restart is marked REJECTED, loudly', async () => {
  // Placed a minute before this process booted: no simulator in this process
  // has ever heard of `sim-1`.
  const d = orphanDesk([placedPaperDoc()])
  const pass = await d.run()

  assert.equal(pass.orphaned, 1)
  assert.equal(d.doc(BASE)?.['state'], 'REJECTED')
  assert.equal(d.doc(BASE)?.['filledQty'], 0, 'nothing traded, and the record must say so')
  assert.match(String(d.doc(BASE)?.['reason']), /orphaned by a gateway restart/)
  // The journal line is the point: `paper-fold.ts` settles the package off the
  // state, but only a human reading this knows why the rehearsal stopped.
  const said = d.events.rows.find((e) => e['phase'] === 'FAILED')
  assert.equal(said?.['ok'], false)
  assert.match(String(said?.['error']), /no tick can ever fill it/)
})

test('an order THIS process placed is never condemned, however old', async () => {
  /**
   * The rule that makes this incapable of racing a fill. An order placed after
   * boot belongs to the live simulator; it may be seconds from filling, and
   * marking it REJECTED would un-book a position the very next tick creates.
   */
  const d = orphanDesk([placedPaperDoc({ placedAt: NOW + 1 })], { now: NOW + 86_400_000 })
  const pass = await d.run()
  assert.equal(pass.orphaned, 0)
  assert.equal(d.doc(BASE)?.['state'], 'PLACED')
})

test('nothing is condemned during the grace period after boot', async () => {
  // Boot does the reconcile of PLACED documents, the socket wiring and the
  // first bus frames concurrently. Declaring an order dead inside that would be
  // right for the wrong reason.
  const d = orphanDesk([placedPaperDoc()], { now: NOW + 1_000 })
  assert.deepEqual(await d.run(), { scanned: 0, orphaned: 0 })
  assert.equal(d.doc(BASE)?.['state'], 'PLACED')
})

test('an order the simulator IS still holding is left alone', async () => {
  // Belt and braces over the boot rule: if a future simulator ever recovered
  // its book, this stops condemning what it recovered rather than needing
  // somebody to remember this file exists.
  const d = orphanDesk([placedPaperDoc()], { resting: ['sim-1'] })
  const pass = await d.run()
  assert.equal(pass.orphaned, 0)
  assert.equal(d.doc(BASE)?.['state'], 'PLACED')
})

test('a LIVE document is never touched — the broker owns its outcome', async () => {
  const d = orphanDesk([placedPaperDoc({ clientOrderId: 'live-1', mode: 'live' })])
  const pass = await d.run()
  assert.equal(pass.scanned, 0)
  assert.equal(d.doc('live-1')?.['state'], 'PLACED')
})

test('an unreadable simulator book condemns NOTHING', async () => {
  // Unreadable is not "empty". Ending a rehearsal because one call threw is the
  // wrong direction to fail in.
  const orders = new FakeCollection()
  orders.docs.push(placedPaperDoc())
  const now = NOW + DEFAULT_PAPER_ORPHAN_MS
  const sweep = createPaperSweep({
    adapter: {
      orderBook: async () => {
        throw new Error('simulator unavailable')
      },
    },
    queue: new OrderQueue({ collection: orders, workerId: 'w1', now: () => now }),
    journal: new OrderJournal({ collection: new FakeJournal(), now: () => now }),
    orders,
    bootedAt: NOW,
    now: () => now,
    log: () => {},
  })
  const pass = await sweep.run()
  assert.equal(pass.orphaned, 0)
  assert.equal(orders.docs[0]?.['state'], 'PLACED')
})

// ------------------------------------------------------- the paper cancel

/**
 * A DASHBOARD CANCEL OF A PAPER ORDER ENDS THE PACKAGE (review M-3).
 *
 * The cancel row is keyed by the BROKER order id, and paper orders now have
 * one (`sim-3`). What the gateway does with it is asserted here at the level
 * that matters: the simulator stops holding the order, the watcher sees a
 * terminal update with nothing filled, and the desk order goes REJECTED — which
 * is what `paper-fold.ts` needs to settle the decision that owns it. Without a
 * terminal state the operator's cancel would leave the supervisor holding the
 * package `inFlight` forever, which is worse than not offering a cancel at all.
 */
test('cancelling a resting paper order makes the desk order TERMINAL', async () => {
  const d = desk({ mode: 'paper' }, { live: false })
  await d.sweep()
  await d.settle()
  assert.equal(d.doc()['state'], 'PLACED')
  const brokerId = (d.doc()['brokerOrderIds'] as string[])[0] as string

  // What `drainPaperCancels` does with a pending row, on the same adapter.
  assert.equal(await d.paper.sim.cancelOrder(brokerId), true)
  await d.settle()

  assert.equal(d.doc()['state'], 'REJECTED', 'terminal, so the fold pass can settle its package')
  assert.equal(d.doc()['filledQty'], 0, 'nothing traded — the book must not gain a leg')
  // And it is on the record as CANCELLED, not invented as a rejection.
  const cancelled = d.fills.rows.filter((r) => r['status'] === 'CANCELLED')
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0]?.['mode'], 'paper')
})

test('cancelling an order the simulator no longer holds answers FALSE, not a lie', async () => {
  // The row the drain marks `failed`: already filled, already cancelled, or
  // orphaned by a restart. Reporting DONE would tell an operator a working
  // order was stopped.
  const d = desk({ mode: 'paper' }, { live: false })
  await d.sweep()
  await d.settle()
  d.paper.sim.feedTick(TOKEN, 101)
  await d.settle()

  const brokerId = (d.doc()['brokerOrderIds'] as string[])[0] as string
  assert.equal(await d.paper.sim.cancelOrder(brokerId), false)
})
