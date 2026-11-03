/**
 * D14 — A PAPER ORDER LIVES THE LIVE ORDER'S LIFE, end to end, through the real
 * two processes: `POST /v1/desk/engine/decisions` on one side and the gateway's
 * own placer, simulator and fill watcher on the other, over ONE Mongo.
 *
 * WHAT THIS PREVENTS, and why it is worth a suite that spans two apps.
 *
 * Until now an engine paper decision was booked SYNCHRONOUSLY: `PaperRail`
 * wrote a `COMPLETE` row to `desk-paper-trade` and `applyDecision` folded the
 * leg into `desk-books` in the same request, at the decision-time mark. So the
 * paper rehearsal exercised none of the machinery that a live order's outcome
 * actually depends on — no queue, no claim, no gates, no peg, no tranche
 * cursor, no fill correlation, no book fold on a fill event. Every one of those
 * would have been met for the first time in a live session, which is the exact
 * shape of failure the paper session exists to find.
 *
 * The lifecycle asserted here is one straight line, and every hop is a place
 * the old path skipped:
 *
 *   engine decision (paper) -> `desk-gateway-orders` doc, `mode: 'paper'`,
 *   PENDING, and the response says WORKING with NO fills and NO book
 *     -> the gateway claims it, refuses it nothing (the LIVE allowlist is not
 *        its gate), places it on the SIMULATOR, and the order rests
 *     -> a tick crosses the limit through the same fan-out the QuoteMap is fed
 *        from, and the simulator fills it
 *     -> `FillWatcher` writes a `desk-fills` row carrying `mode: 'paper'`
 *     -> desk-api's paper fold pass books that fill onto `desk-decisions`,
 *        folds the leg into `desk-books` and NUDGES THE SUPERVISOR.
 *
 * THE NUDGE IS ASSERTED AGAINST A REAL LOOPBACK SERVER rather than a spy,
 * because `notifySupervisor` is one HTTP call to a port and everything that can
 * go wrong with it (the token, the path, the body) is invisible to a fake.
 *
 * Skips itself when no Mongo is reachable; `DESK_REQUIRE_MONGO=1` turns that
 * skip into a failure (see `require-mongo.ts`).
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OptionMaster, FreezeLimits, type InstrumentRow } from '@algomaker/instruments'
import { SimulatorAdapter } from '@algomaker/brokers'
import { ENGINE_DECISIONS_PATH } from '@algomaker/desk-engine'
import type { DecisionRequest, DecisionResponse } from '@algomaker/desk-engine'
import { skipUnlessMongo } from './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import { createBridgeServer } from '../src/server.ts'
import { engineRoutes } from '../src/routes/engine.ts'
import { createPaperFillFolder } from '../src/paper-fold.ts'
import { resetNudgeLog, NUDGE_PATH } from '../src/engine-notify.ts'
import type { AuthGate } from '../src/authgate.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
// The GATEWAY's own production modules, imported across the app boundary the
// way `apps/order-gateway` already imports this app's Mongo helper. A test that
// re-implemented the placer would prove the shape of a copy.
import { createOrderPlacer, tickFanout } from '../../order-gateway/src/main.ts'
import { OrderQueue, createSweeper } from '../../order-gateway/src/queue.ts'
import { FillWatcher, FILLS_COLLECTION } from '../../order-gateway/src/fills.ts'
import { OrderJournal, ORDER_EVENTS_COLLECTION } from '../../order-gateway/src/journal.ts'
import { createQuoteMap } from '../../order-gateway/src/quote-map.ts'
import type { ResolvedContract } from '../../order-gateway/src/gateway.ts'

const URL_MONGO =
  process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_paper_lifecycle_test'
const TOKEN = 'paper-lifecycle-token'
const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'
const TAG = 'DESK_BHEL'
const LOT = 2625
const CONTRACT_SYMBOL = 'BHEL26AUG415CE'
const CONTRACT_TOKEN = 41501
/** The one instant desk-api is fixed at. The gateway runs on its own clock. */
const NOW = Date.UTC(2026, 7, 21, 5, 0)
/** The limit the decision rests at, and the print that must cross it to fill. */
const LIMIT = 12
const CROSSING_PRINT = 12.4
/**
 * What that SELL actually fills at. The gateway's `tick` helper quotes the book
 * a nickel either side of the print, and the simulator now fills a marketable
 * limit ON THE TOUCH (`packages/brokers/src/simulator.ts`, spec 2026-10-16 F2):
 * a sell takes the bid, as a real resting sell under the bid would. The print
 * that crossed the limit is no longer the fill price — the bid beside it is.
 */
const CROSSING_BID = Math.round((CROSSING_PRINT - 0.05) * 100) / 100

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let nudgeServer: Server | null = null
let base = ''
let available = false
/** Every nudge body the supervisor's port received, in order. */
let nudges: Record<string, unknown>[] = []
let nudgePort = 0

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (let strike = 380; strike <= 470; strike += 2.5) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: Math.round(strike * 100) + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BHEL26AUG${strike}${type}`,
        name: SYMBOL,
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: LOT,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  return new OptionMaster(rows)
}

const MARKS = new StaticMarks(
  Object.fromEntries(
    Array.from({ length: 37 }, (_, i) => 380 + i * 2.5).flatMap((k) => [
      [`BHEL26AUG${k}CE`, 12],
      [`BHEL26AUG${k}PE`, 11],
    ]),
  ),
  { BHEL: 417 },
)

const gate: AuthGate = {
  authenticate: async (req) =>
    req.headers.authorization === `Bearer ${TOKEN}` ? { kind: 'machine', name: 'supervisor' } : null,
  reauth: async () => 'this deployment has no user accounts',
}

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  const service = new BridgeService({
    store,
    rails: {
      paper: new PaperRail(handle.db),
      live: new LiveRail(handle.db, []),
    },
    master: { current: master },
    marks: MARKS,
    clock: { now: () => NOW },
  })
  const apiDeps: ApiDeps = {
    db: handle.db,
    store,
    service,
    master: { current: master },
    log: () => {},
    now: () => NOW,
  }
  server = createBridgeServer({ gate, routes: [engineRoutes({ ...apiDeps, gate })] })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`

  // The supervisor's nudge endpoint, as a real loopback server.
  nudgeServer = createServer((req, res) => {
    if (req.url !== NUDGE_PATH) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += String(c)))
    req.on('end', () => {
      nudges.push({
        ...(JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>),
        authorization: req.headers.authorization ?? '',
      })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((resolve) => nudgeServer!.listen(0, '127.0.0.1', resolve))
  nudgePort = (nudgeServer!.address() as AddressInfo).port
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (nudgeServer !== null) await new Promise<void>((r) => nudgeServer!.close(() => r()))
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  for (const c of [FILLS_COLLECTION, ORDER_EVENTS_COLLECTION]) {
    await handle!.db.collection(c).deleteMany({})
  }
  await store.ensureIndexes()
  await store.registerStrategy(
    {
      tag: TAG,
      kind: 'external',
      label: 'BHEL relief',
      modes: { paper: { enabled: true }, live: { enabled: true } },
    },
    NOW,
  )
  nudges = []
  resetNudgeLog()
})

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

// --------------------------------------------------------------- the desk

const CONTRACT: ResolvedContract = {
  tradingsymbol: CONTRACT_SYMBOL,
  instrumentToken: CONTRACT_TOKEN,
  lotSize: LOT,
  tickSize: 0.05,
  exchange: 'NFO',
  underlying: SYMBOL,
}

/**
 * The gateway half, wired exactly as `main()` wires it — the same placer, the
 * same queue, the same watcher, the same simulator — against the same Mongo the
 * API is writing its orders to.
 *
 * `allowsLive` answers FALSE for everything, which is the point: a paper order
 * must not be subject to the LIVE allowlist, and a fixture that allowed the tag
 * would pass whether the gate was skipped or not.
 */
function gateway(): {
  sweep(): Promise<void>
  settle(): Promise<void>
  tick(price: number): Promise<void>
  readonly quoteSize: () => number
} {
  const orders = handle!.db.collection('desk-gateway-orders')
  // THE SAME CLOCK THE API IS FIXED AT. Two processes on one box share a wall
  // clock; a suite whose api is pinned to a date in 2026 and whose gateway runs
  // on the real one would have every order refused by the staleness gate — a
  // fixture artefact that says nothing about the code.
  const now = (): number => NOW
  const queue = new OrderQueue({ collection: orders as never, workerId: 'gw-test', now })
  const journal = new OrderJournal({
    collection: handle!.db.collection(ORDER_EVENTS_COLLECTION) as never,
    now,
  })
  const sim = new SimulatorAdapter()
  const quotes = createQuoteMap({ now })
  const inflight: Promise<unknown>[] = []
  const watcher = new FillWatcher({
    fills: handle!.db.collection(FILLS_COLLECTION) as never,
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
    adapterFor: () => sim,
    resolveContract: (s) => (s === CONTRACT_SYMBOL ? CONTRACT : null),
    freeze: () => new FreezeLimits([{ symbol: SYMBOL, freezeQty: 100 * LOT }]),
    allowsLive: async () => false,
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
  sim.onOrderUpdate((u) => void inflight.push(watcher.handle(u)))
  const fanout = tickFanout({ quotes, sims: [sim] })

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50 && inflight.length > 0; i++) await Promise.all(inflight.splice(0))
  }
  return {
    sweep: () => sweeper.sweep(),
    settle,
    quoteSize: () => quotes.size,
    tick: async (price: number) => {
      fanout({ token: CONTRACT_TOKEN, price, bid: price - 0.05, ask: price + 0.05, ts: NOW })
      await settle()
    },
  }
}

/** The desk-api pass that books a paper fill back onto the ledger. */
function folder(): { run(): Promise<{ folded: number }> } {
  return createPaperFillFolder({
    store,
    master: () => master(),
    notify: (mode, event) => published.push({ mode, event }),
    nudge: { port: nudgePort, token: TOKEN },
    now: () => NOW,
    log: () => {},
  })
}

let published: { mode: string; event: Record<string, unknown> }[] = []

async function post(body: unknown): Promise<{ status: number; body: DecisionResponse }> {
  const res = await fetch(`${base}${ENGINE_DECISIONS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as DecisionResponse }
}

let seq = 0
function request(over: Partial<DecisionRequest> = {}): DecisionRequest {
  seq++
  return {
    tag: TAG,
    mode: 'paper',
    decisionId: `${TAG}:paper:${seq}`,
    symbol: SYMBOL,
    expiry: EXPIRY,
    trigger: 'shift',
    reason: 'band breached on the upside',
    actions: [
      {
        op: 'open',
        instrument: CONTRACT_SYMBOL,
        side: 'Sell',
        qty: LOT,
        limitPrice: LIMIT,
        workMode: 'passive',
      },
    ],
    ...over,
  }
}

// ------------------------------------------------------- the whole lifecycle

itMongo('an engine paper decision answers WORKING, books nothing, and queues a paper order', async () => {
  published = []
  const { status, body } = await post(request())

  assert.equal(status, 200)
  // NOT `DONE`. A maker quote is resting and its fills arrive later; a
  // supervisor told DONE forms its next package against a book it has working.
  assert.equal(body.status, 'WORKING')
  assert.deepEqual(body.fills, [], 'nothing has traded yet')
  assert.deepEqual(body.routeErrors, [])

  // The book is UNTOUCHED. Folding at route time is what made the paper book
  // disagree with every order the gateway had not yet placed.
  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])

  // The order is in the LIVE ORDER'S OWN QUEUE, marked paper.
  const queued = await handle!.db.collection('desk-gateway-orders').find({}).toArray()
  assert.equal(queued.length, 1)
  assert.equal(queued[0]?.['mode'], 'paper')
  assert.equal(queued[0]?.['state'], 'PENDING')
  assert.equal(queued[0]?.['tradingsymbol'], CONTRACT_SYMBOL)
  assert.equal(queued[0]?.['order_type'], 'LIMIT')
  assert.equal(queued[0]?.['limitPrice'], LIMIT)
  assert.equal(queued[0]?.['workMode'], 'passive')

  // And NOTHING was instant-filled onto the old paper rail.
  assert.equal(await handle!.db.collection(COLLECTIONS.paperTrade).countDocuments({}), 0)
})

itMongo('a crossing tick fills the paper order, folds the book and nudges the supervisor', async () => {
  published = []
  const req = request()
  await post(req)

  const gw = gateway()
  await gw.sweep()
  await gw.settle()

  // Placed and RESTING: the simulator answers WORKING for a limit nothing has
  // traded through, and the desk order is not terminal.
  const placed = await handle!.db
    .collection('desk-gateway-orders')
    .findOne({ clientOrderId: `${req.decisionId}#0` })
  assert.equal(placed?.['state'], 'PLACED')
  assert.equal(await store.loadBook(TAG, 'paper').then((b) => b.length), 0)

  // A print through the limit — the same fan-out that feeds the QuoteMap.
  await gw.tick(CROSSING_PRINT)
  assert.equal(gw.quoteSize(), 1, 'the quote map saw the same frame')

  const fills = await handle!.db.collection(FILLS_COLLECTION).find({ status: 'FILLED' }).toArray()
  assert.equal(fills.length, 1)
  assert.equal(fills[0]?.['mode'], 'paper', 'the fill is stamped PAPER, not live')
  assert.equal(fills[0]?.['tradingsymbol'], CONTRACT_SYMBOL)
  assert.equal(fills[0]?.['filledQty'], LOT)
  assert.equal(fills[0]?.['avgPrice'], CROSSING_BID)

  // ... and the desk order itself is terminal.
  const done = await handle!.db
    .collection('desk-gateway-orders')
    .findOne({ clientOrderId: `${req.decisionId}#0` })
  assert.equal(done?.['state'], 'FILLED')

  // THE FOLD. Nothing has booked this leg until this pass runs.
  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])
  const pass = await folder().run()
  assert.equal(pass.folded, 1)

  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 1)
  assert.equal(book[0]?.instrument.tradingsymbol, CONTRACT_SYMBOL)
  assert.equal(book[0]?.qty, -LOT, 'a Sell is a short leg')
  // THE BROKER'S PRICE, not the decision-time mark of 12.
  assert.equal(book[0]?.entryPrice, CROSSING_BID)

  // The ledger the P&L reads.
  const decision = await handle!.db
    .collection(COLLECTIONS.decisions)
    .findOne({ decisionId: req.decisionId })
  assert.equal(decision?.['status'], 'DONE', 'every planned fill is accounted for')
  const booked = decision?.['fills'] as Record<string, unknown>[]
  assert.equal(booked.length, 1)
  assert.equal(booked[0]?.['qty'], LOT)
  assert.equal(booked[0]?.['price'], CROSSING_BID)

  // THE NUDGE — one HTTP call to the supervisor's own port, authenticated.
  assert.equal(nudges.length, 1)
  assert.equal(nudges[0]?.['kind'], 'fill')
  assert.equal(nudges[0]?.['tag'], TAG)
  assert.equal(nudges[0]?.['mode'], 'paper')
  assert.equal(nudges[0]?.['authorization'], `Bearer ${TOKEN}`)

  // The dashboard's paper order feed still gets its frame.
  const frame = published.find((p) => p.event['phase'] === 'FILL')
  assert.equal(frame?.mode, 'paper')
  assert.equal(frame?.event['tradingsymbol'], CONTRACT_SYMBOL)
  assert.equal(frame?.event['avgPrice'], CROSSING_BID)
})

itMongo('the fold is idempotent — a second pass books nothing twice', async () => {
  published = []
  const req = request()
  await post(req)
  const gw = gateway()
  await gw.sweep()
  await gw.settle()
  await gw.tick(CROSSING_PRINT)

  assert.equal((await folder().run()).folded, 1)
  const first = await store.loadBook(TAG, 'paper')

  // Re-run with the gateway document's mark cleared — the crash window between
  // the fold and the mark. The BOOK's own receipt is what must stop it.
  await handle!.db
    .collection('desk-gateway-orders')
    .updateOne(
      { clientOrderId: `${req.decisionId}#0` },
      { $unset: { deskFolded: '', deskFoldedAt: '' } },
    )
  await folder().run()

  const second = await store.loadBook(TAG, 'paper')
  assert.equal(second.length, 1)
  assert.equal(second[0]?.qty, first[0]?.qty, 'the leg is the same size, not doubled')
})

/**
 * A PACKAGE IS NOT SETTLED UNTIL EVERY ORDER IN IT IS — INCLUDING THE ONES THAT
 * TRADED NOTHING (review C-1).
 *
 * An order that is rejected books no fill, so the fold pass had nothing to
 * record for it and wrote no receipt at all — while still marking the document
 * `deskFolded`, which takes it out of every future pass. Its sibling then asked
 * "is every id accounted for?", read a list that had never heard of the
 * rejected order, and answered no. Both documents marked, no pass able to
 * revisit either, and the decision stuck at `WORKING` for the rest of the
 * session — the supervisor holding it `inFlight` and forming no further package
 * for that book.
 *
 * BOTH ORDERINGS ARE RUN, because only one of them used to fail and it is the
 * one production produces: a rejection is terminal the instant the order is
 * placed, while a fill waits for a tick, so the zero-trade order is normally
 * folded FIRST. The reversed order passed the whole time.
 *
 * It is not a corner case either. The simulator REJECTS a MARKET order on a
 * token it has seen no tick for, and the engine routes MARKET whenever an
 * action carries no `limitPrice` — which is the shape of the first package of
 * a paper session.
 */
for (const rejectedFirst of [true, false]) {
  itMongo(
    `a package settles when one leg trades nothing (${rejectedFirst ? 'rejected first' : 'filled first'})`,
    async () => {
      published = []
      // The 420 strike has no tick fed to the simulator, so its MARKET order is
      // REJECTED outright — the desk's own "no tick received yet" refusal.
      const dead = {
        op: 'open' as const,
        instrument: 'BHEL26AUG420CE',
        side: 'Sell' as const,
        qty: LOT,
      }
      const alive = {
        op: 'open' as const,
        instrument: CONTRACT_SYMBOL,
        side: 'Sell' as const,
        qty: LOT,
        limitPrice: LIMIT,
        workMode: 'passive' as const,
      }
      const req = request({ actions: rejectedFirst ? [dead, alive] : [alive, dead] })
      const posted = await post(req)
      assert.equal(posted.body.status, 'WORKING')

      const gw = gateway()
      await gw.sweep()
      await gw.sweep()
      await gw.settle()
      await gw.tick(CROSSING_PRINT)

      const pass = await folder().run()
      assert.equal(pass.folded, 1, 'one leg traded, one did not')

      const decision = await handle!.db
        .collection(COLLECTIONS.decisions)
        .findOne({ decisionId: req.decisionId })
      // THE ASSERTION THIS TEST EXISTS FOR. A supervisor left holding a WORKING
      // decision stops steering the book entirely.
      assert.equal(decision?.['status'], 'DONE', 'the package is finished, whichever leg went first')
      // The receipt names BOTH orders — the fill list names only the one that
      // traded. They are different questions and must stay different fields.
      assert.deepEqual(
        [...(decision?.['foldedOrders'] as string[])].sort(),
        [`${req.decisionId}#0`, `${req.decisionId}#1`],
      )
      assert.equal((decision?.['fills'] as unknown[]).length, 1)

      const book = await store.loadBook(TAG, 'paper')
      assert.equal(book.length, 1, 'only the leg that actually traded is on the book')
      assert.equal(book[0]?.instrument.tradingsymbol, CONTRACT_SYMBOL)
    },
  )
}

itMongo('a CLOSE whose leg vanished while it worked never opens one the other way', async () => {
  /**
   * THE WINDOW THE DEFERRED FOLD OPENS, and the only new hazard in D14.
   *
   * The old synchronous path booked the close in the same request that decided
   * it, so nothing could move underneath it. Now there is real time between the
   * two, and an operator's Close-leg or a flatten can empty the book inside it.
   * A fold allowed to CREATE would then meet a book holding nothing and open a
   * long leg out of a close — a phantom position invented by the pass whose job
   * is booking reality.
   */
  published = []
  await store.saveBook(
    { tag: TAG, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY },
    [
      {
        deskTag: CONTRACT_SYMBOL,
        instrument: master().resolveSymbol(CONTRACT_SYMBOL)!,
        underlying: SYMBOL,
        expiry: EXPIRY,
        strike: 415,
        type: 'CE',
        side: 'Sell',
        qty: -LOT,
        entryPrice: 12,
        openedTs: NOW - 86_400_000,
      },
    ],
    NOW,
    null,
  )
  // A close, resting at a limit a print will cross.
  await post(
    request({
      actions: [
        { op: 'close', instrument: CONTRACT_SYMBOL, limitPrice: LIMIT, workMode: 'passive' },
      ],
    }),
  )
  const gw = gateway()
  await gw.sweep()
  await gw.settle()

  // The operator flattens the paper book while the close is still working.
  await store.saveBook({ tag: TAG, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY }, [], NOW + 1)

  // A print BELOW the limit crosses a BUY.
  await gw.tick(LIMIT - 1)
  await folder().run()

  assert.deepEqual(await store.loadBook(TAG, 'paper'), [], 'no leg was invented')
  // And it is LOUD: a divergence you can see beats one that looks like a trade.
  const said = published.find((p) => String(p.event['error'] ?? '').includes('NOT folded'))
  assert.notEqual(said, undefined, 'the drop is journalled, not silent')
})

// ----------------------------------------------- the duplicate-open guard

/**
 * THE WINDOW THE UNFOLDED BOOK OPENS, closed at the door (review IMP-2).
 *
 * Everywhere else the BOOK refuses a duplicate open: `applyActions` answers
 * "tag is already open", and it can, because the decision that opened the leg
 * folded at route time. An engine paper decision folds when its fill lands, so
 * for as long as the order works the book says nothing — and a second decision
 * on the same contract would route a second order and put TWO legs on one
 * instrument, which the wire could never name again.
 */
itMongo('an open on a contract that already has an order WORKING is refused at the door', async () => {
  published = []
  const first = await post(request())
  assert.equal(first.body.status, 'WORKING')
  // The book is still empty — which is exactly why the book cannot be the guard.
  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])

  const second = await post(request())
  assert.equal(second.status, 400)
  assert.match(String((second.body as unknown as { error?: string }).error), /already has an order working/)

  // NOTHING WRITTEN: one order, one decision, one engine journal row.
  assert.equal(await handle!.db.collection('desk-gateway-orders').countDocuments({}), 1)
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({}), 1)
})

itMongo('once the working order is terminal, the same contract may be opened again', async () => {
  /**
   * The guard is about orders that are STILL OUT, never about history. A book
   * that closed a leg this morning and wants it back this afternoon must not be
   * refused by an order that finished hours ago.
   */
  published = []
  const first = await post(request())
  const gw = gateway()
  await gw.sweep()
  await gw.settle()
  await gw.tick(CROSSING_PRINT)
  await folder().run()
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1)

  // Now the BOOK is the guard again, in its own words — which is the point:
  // one refusal, from whichever authority actually knows.
  const second = await post(request())
  assert.equal(second.status, 200)
  assert.equal(second.body.skips.length, 1)
  assert.match(second.body.skips[0]?.reason ?? '', /already open/)
  assert.notEqual(first.body.decisionId, second.body.decisionId)
})

itMongo('a REPLAY of the working package is answered, never refused by the guard', async () => {
  /**
   * IDEMPOTENCY BEATS THE GUARD, and getting this backwards is worse than not
   * having the guard at all.
   *
   * A supervisor restart, a retried POST, a socket that died after the order
   * went out — all of them re-post the identical package under the identical
   * id, and `applyDecision` answers with the ORIGINAL outcome and routes
   * nothing. A guard that counted the package's OWN working orders against it
   * would 400 every one of those, telling the supervisor its decision failed
   * while its orders were live at the (simulated) broker. Caught by the
   * existing replay suite the moment the guard was written.
   */
  published = []
  const req = request()
  const first = await post(req)
  assert.equal(first.body.status, 'WORKING')

  const replayed = await post(req)
  assert.equal(replayed.status, 200)
  assert.equal(replayed.body.replayed, true)
  assert.equal(replayed.body.status, 'WORKING')
  // And still exactly ONE order, which is what the idempotency is for.
  assert.equal(await handle!.db.collection('desk-gateway-orders').countDocuments({}), 1)
})

itMongo('a REPLAY of a package the venue REFUSED answers 200 and names the refusal', async () => {
  /**
   * 3 Nov, demo: both legs of a BULL-S entry were refused (strike not listed
   * on the testnet). `paper-fold.ts:claimOrder` pushed `{instrument, reason}`
   * onto the decision's `skips`, and every replay then threw reading
   * `s.action.ts` — HTTP 500 once a second for hours, the supervisor holding
   * the id `inFlight` and the book frozen (no stop, no entry).
   */
  published = []
  const req = request()
  const first = await post(req)
  assert.equal(first.body.status, 'WORKING')
  await handle!.db.collection(COLLECTIONS.decisions).updateOne(
    { decisionId: req.decisionId },
    {
      $set: { status: 'DONE', completedAt: NOW },
      $push: { skips: { instrument: CONTRACT_SYMBOL, reason: 'not listed on the Delta testnet' } },
    } as never,
  )

  const replayed = await post(req)
  assert.equal(replayed.status, 200)
  assert.equal(replayed.body.replayed, true)
  assert.equal(replayed.body.status, 'DONE')
  assert.deepEqual(replayed.body.skips, [{ instrument: CONTRACT_SYMBOL, reason: 'not listed on the Delta testnet' }])
})

itMongo('a CLOSE is never refused by the guard — it is opens that duplicate', async () => {
  published = []
  await post(request())
  // A close on the very contract that has an order working: not an open, so it
  // is none of the guard's business. Refusing exits is how a switched-off book
  // gets trapped, and this must not become a second way to do that.
  const closed = await post(
    request({ actions: [{ op: 'close', instrument: CONTRACT_SYMBOL }] }),
  )
  assert.equal(closed.status, 200)
})

itMongo('a paper order the tick never reaches stays WORKING and books nothing', async () => {
  published = []
  const req = request()
  await post(req)
  const gw = gateway()
  await gw.sweep()
  await gw.settle()

  // A print BELOW a resting sell limit: the market never traded through it.
  await gw.tick(LIMIT - 1)

  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])
  assert.equal((await folder().run()).folded, 0)
  const decision = await handle!.db
    .collection(COLLECTIONS.decisions)
    .findOne({ decisionId: req.decisionId })
  assert.equal(decision?.['status'], 'WORKING')
  assert.equal(nudges.length, 0, 'nothing happened, so nothing was announced')
})
