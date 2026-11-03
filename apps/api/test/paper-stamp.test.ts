/**
 * THE PAPER RAIL FORGOT WHOSE BET IT WAS (plan Task 10A).
 *
 * The delta-lean controller finds "the legs of the bet I am currently running"
 * by matching `BridgeLeg.leanId` against the lean id in its own state. It adds
 * size when that bet makes a new peak and cuts when it draws down from one, so
 * a leg that lost the stamp belongs to no lean: the lean holds nothing, never
 * adds, never cuts, and NOTHING THROWS.
 *
 * On the LIVE rail the leg is written inside the request by `applyActions`,
 * which has the open action in hand and carries the stamp. On the PAPER rail —
 * the rail the four books being shipped actually run on — the engine route
 * answers `WORKING`, the order is queued for the gateway, and the leg is
 * created LATER by `paper-fold.ts` out of a view rebuilt from the instrument
 * master, which knows the contract and nothing about the lean that asked for
 * it. So the stamp stopped at the order document and every paper lean read as
 * flat, with every existing test green.
 *
 * ASSERTED THROUGH THE REAL TWO PROCESSES, as `engine-paper-lifecycle.test.ts`
 * is: the endpoint on one side, the gateway's own placer, simulator and fill
 * watcher on the other, over one Mongo. A unit test over the fold alone would
 * prove the last hop and leave the three before it — the fill, the order
 * document, the decision's plan — exactly where the bug was.
 *
 * Skips itself when no Mongo is reachable; `DESK_REQUIRE_MONGO=1` turns that
 * skip into a failure (see `require-mongo.ts`).
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OptionMaster, FreezeLimits, type InstrumentRow } from '@algomaker/instruments'
import { SimulatorAdapter } from '@algomaker/brokers'
import { ENGINE_DECISIONS_PATH } from '@algomaker/desk-engine'
import type { DecisionRequest, DecisionResponse } from '@algomaker/desk-engine'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import { createBridgeServer } from '../src/server.ts'
import { engineRoutes } from '../src/routes/engine.ts'
import { createPaperFillFolder } from '../src/paper-fold.ts'
import type { AuthGate } from '../src/authgate.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
// The GATEWAY's own production modules, across the app boundary — the same
// import this suite's sibling (`engine-paper-lifecycle.test.ts`) makes, for the
// same reason: a test that re-implemented the placer would prove the shape of a
// copy rather than the behaviour of the process that works these orders.
import { createOrderPlacer, tickFanout } from '../../order-gateway/src/main.ts'
import { OrderQueue, createSweeper } from '../../order-gateway/src/queue.ts'
import { FillWatcher, FILLS_COLLECTION } from '../../order-gateway/src/fills.ts'
import { OrderJournal, ORDER_EVENTS_COLLECTION } from '../../order-gateway/src/journal.ts'
import { createQuoteMap } from '../../order-gateway/src/quote-map.ts'
import type { ResolvedContract } from '../../order-gateway/src/gateway.ts'

const URL_MONGO =
  process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_paper_stamp_test'
const TOKEN = 'paper-stamp-token'
const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'
const TAG = 'DESK_BHEL'
const LOT = 2625
const CONTRACT_SYMBOL = 'BHEL26AUG415CE'
const CONTRACT_TOKEN = 41501
/** The one instant desk-api is fixed at. The gateway runs on the same one. */
const NOW = Date.UTC(2026, 7, 21, 5, 0)
/** The limit the decision rests at, and the print that must cross it to fill. */
const LIMIT = 12
const CROSSING_PRINT = 12.4
/** The engine's own id shape — `dl-<side>-<epoch ms>`. */
const LEAN = 'dl-up-1755752400000'

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false
/**
 * `foldOne` (`../src/paper-fold.ts`) nudges the supervisor with kind fill
 * once a fold is durable. Without pointing `DESK_SUPERVISOR_PORT` at a
 * harmless loopback server, every one of the folds `folder().run()` performs
 * below reached the live desk-supervisor. See `./nudge-sink.ts`.
 */
let sink: NudgeSink | null = null

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
      // A FIXED allowlist holding this tag, so the live control below routes
      // for the reason it is there — to prove the rail that already worked was
      // not disturbed — rather than being refused by a switch.
      live: new LiveRail(handle.db, [TAG]),
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
  sink = await startNudgeSink()
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  for (const c of [FILLS_COLLECTION, ORDER_EVENTS_COLLECTION]) {
    await handle!.db.collection(c).deleteMany({})
  }
  await store.ensureIndexes()
  if (sink !== null) sink.nudges.length = 0
  await store.registerStrategy(
    {
      tag: TAG,
      kind: 'external',
      label: 'BHEL delta-lean',
      modes: { paper: { enabled: true }, live: { enabled: true } },
    },
    NOW,
  )
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

// --------------------------------------------------------------- the rails

const CONTRACT: ResolvedContract = {
  tradingsymbol: CONTRACT_SYMBOL,
  instrumentToken: CONTRACT_TOKEN,
  lotSize: LOT,
  tickSize: 0.05,
  exchange: 'NFO',
  underlying: SYMBOL,
}

/**
 * The gateway half, wired as `main()` wires it, against the same Mongo the API
 * writes its orders to. `allowsLive` answers FALSE for everything: a paper
 * order is not subject to the live allowlist, and a fixture that allowed the
 * tag would pass whether that held or not.
 */
function gateway(): {
  sweep(): Promise<void>
  settle(): Promise<void>
  tick(price: number): Promise<void>
} {
  const orders = handle!.db.collection('desk-gateway-orders')
  // THE SAME CLOCK THE API IS FIXED AT — two processes on one box share a wall
  // clock, and a gateway on the real one would refuse every order as stale.
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
    now: () => NOW,
    log: () => {},
  })
}

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
  const mode = over.mode ?? 'paper'
  return {
    tag: TAG,
    mode,
    decisionId: `${TAG}:${mode}:${seq}`,
    symbol: SYMBOL,
    expiry: EXPIRY,
    trigger: 'shift',
    reason: 'the lean made a new peak; add a unit',
    actions: [
      {
        op: 'open',
        instrument: CONTRACT_SYMBOL,
        side: 'Sell',
        qty: LOT,
        limitPrice: LIMIT,
        workMode: 'passive',
        leanId: LEAN,
      },
    ],
    ...over,
  }
}

/** The desk order document the gateway works, read back from Mongo. */
async function orderDoc(decisionId: string): Promise<Record<string, unknown>> {
  const doc = await handle!.db
    .collection('desk-gateway-orders')
    .findOne({ clientOrderId: `${decisionId}#0` })
  assert.notEqual(doc, null, `no gateway order for ${decisionId}#0`)
  return doc as Record<string, unknown>
}

// ------------------------------------------------------------- the paper rail

itMongo('a paper fill lands a leg carrying the lean id its action had', async () => {
  const req = request()
  assert.equal((await post(req)).body.status, 'WORKING')

  const gw = gateway()
  await gw.sweep()
  await gw.settle()
  await gw.tick(CROSSING_PRINT)
  assert.equal((await folder().run()).folded, 1)

  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 1)
  assert.equal(book[0]?.instrument.tradingsymbol, CONTRACT_SYMBOL)
  // THE ASSERTION THIS FILE EXISTS FOR. Without it the lean holds nothing and
  // the whole add/cut/flip rule is inert on the rail being shipped.
  assert.equal(book[0]?.leanId, LEAN)

  // Load-bearing, not just a silencer (see ./nudge-sink.ts): a fold nudges
  // the supervisor with kind fill and this decision's own id.
  assert.ok(sink !== null)
  assert.equal(sink.nudges.length, 1, 'the fold did not nudge the supervisor')
  assert.equal(sink.nudges[0]?.['kind'], 'fill')
  assert.equal(sink.nudges[0]?.['decisionId'], req.decisionId)
})

itMongo('the queued paper order carries the stamp before anything has filled', async () => {
  /**
   * THE HOP THE FOLD READS BACK. The fold runs in a different pass, minutes
   * later, from documents — so the stamp has to be DURABLE between the decision
   * and the fill, not merely present in the request that decided it.
   */
  const req = request()
  await post(req)
  assert.equal((await orderDoc(req.decisionId))['leanId'], LEAN)
})

itMongo('a paper fill with no lean id lands a leg with NO such key', async () => {
  /**
   * Every recenter open looks like this, and so does a delta-lean book that is
   * flat. `leanId: undefined` is stored by Mongo as NULL and read back as a
   * VALUE — the supervisor's mapper would then hold a null where it expects a
   * string or no key at all — so the key must not be written at all.
   */
  const req = request({
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
  })
  await post(req)
  // Not a null on the order document either — the fold reads it from here.
  assert.equal('leanId' in (await orderDoc(req.decisionId)), false)

  const gw = gateway()
  await gw.sweep()
  await gw.settle()
  await gw.tick(CROSSING_PRINT)
  assert.equal((await folder().run()).folded, 1)

  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 1)
  assert.equal('leanId' in (book[0] as object), false)
})

itMongo('a PARTIAL fill lands a part-sized leg that still carries the stamp', async () => {
  /**
   * A tranche-gated order stopped part way is TERMINAL and its `filledQty` is a
   * real position (`reconcile-live.ts:IS_TERMINAL`). The desk books what
   * traded — and what traded belongs to the same bet as the whole order did. A
   * stamp carried only on the all-or-nothing path would leave exactly the legs
   * a stressed market produces unattributable.
   */
  const req = request({
    actions: [
      {
        op: 'open',
        instrument: CONTRACT_SYMBOL,
        side: 'Sell',
        qty: 2 * LOT,
        limitPrice: LIMIT,
        workMode: 'passive',
        leanId: LEAN,
      },
    ],
  })
  await post(req)
  const gw = gateway()
  await gw.sweep()
  await gw.settle()

  // The shape `markTerminal` writes when the gateway halts a gated order after
  // one slice has traded: terminal, with the part that filled on the document.
  await handle!.db
    .collection('desk-gateway-orders')
    .updateOne(
      { clientOrderId: `${req.decisionId}#0` },
      { $set: { state: 'PARTIAL', filledQty: LOT, avgPrice: CROSSING_PRINT } },
    )
  assert.equal((await folder().run()).folded, 1)

  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 1)
  assert.equal(book[0]?.qty, -LOT, 'only what traded is booked')
  assert.equal(book[0]?.leanId, LEAN)
})

itMongo('a multi-tranche order lands ONE leg, stamped, whatever the slicing', async () => {
  /**
   * `work.trancheLots` makes the gateway show one lot at a time and release the
   * next only when the last is terminal, so this order reaches the broker as
   * three placements under `<id>.1`, `.2`, `.3`. There is still ONE desk order
   * document and ONE fold, and the stamp has to survive the whole sequence —
   * the size the desk shows the market must not decide whose bet a leg is.
   */
  const req = request({
    actions: [
      {
        op: 'open',
        instrument: CONTRACT_SYMBOL,
        side: 'Sell',
        qty: 3 * LOT,
        limitPrice: LIMIT,
        workMode: 'passive',
        leanId: LEAN,
      },
    ],
    work: { trancheLots: 1 },
  })
  await post(req)

  const gw = gateway()
  // One round per slice, plus one to settle the last: a tranche is placed, a
  // print crosses it, its fill releases the next.
  for (let i = 0; i < 4; i++) {
    await gw.sweep()
    await gw.settle()
    await gw.tick(CROSSING_PRINT)
  }

  const doc = await orderDoc(req.decisionId)
  assert.equal(doc['state'], 'FILLED', 'every slice went out and traded')
  assert.equal(doc['filled_quantity'] ?? doc['filledQty'], 3 * LOT)
  assert.equal((await folder().run()).folded, 1)

  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 1, 'three tranches are one leg, not three')
  assert.equal(book[0]?.qty, -3 * LOT)
  assert.equal(book[0]?.leanId, LEAN)
})

// -------------------------------------------------------------- the control

itMongo('the live rail is unchanged by this', async () => {
  /**
   * THE CONTROL, and it passes before this change as well as after. The live
   * leg is written inside the request by `applyActions`, which has carried the
   * stamp since the lean id reached desk-api. It is here to prove the paper fix
   * did not disturb the rail that already worked — a regression on it would be
   * a real position mis-attributed, not a rehearsal.
   */
  const req = request({ mode: 'live' })
  const { body } = await post(req)
  assert.equal(body.status, 'DONE', 'live books inside the request')

  const book = await store.loadBook(TAG, 'live')
  assert.equal(book.length, 1)
  assert.equal(book[0]?.leanId, LEAN)
  // And nothing on the live rail reaches the paper fold: it scans `mode:
  // 'paper'` only, so a live order can never be folded in a second time.
  assert.equal((await folder().run()).folded, 0)
})
