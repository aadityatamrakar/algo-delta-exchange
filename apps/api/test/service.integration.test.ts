/**
 * Integration tests against a REAL MongoDB.
 *
 * These exist because the properties that matter most here are database
 * properties, not application ones: idempotency is enforced by a unique index,
 * and the paper/live split is enforced by writing to different collections. A
 * fake store would assert that the code I wrote does what I wrote it to do,
 * which is not the question.
 *
 * Skips itself when no Mongo is reachable, so `npm test` stays green on a
 * machine without docker. Set DESK_TEST_MONGO to point elsewhere.
 */

import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { isOn } from '../src/strategies.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import { UnknownStrategy } from '../src/strategies.ts'
import type { ActionsRequest, DeskAction } from '../src/contract.ts'
import {
  exposureLimitsFromEnv,
  ReservationLedger,
  type ExposureState,
} from '@algomaker/order-bus'

const URL = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_bridge_test'

let handle: MongoHandle | null = null
let store: DeskStore
let available = false

const EXPIRY = '2026-07-28'
const SYMBOL = 'KALYANKJIL'
const TAG = 'DESK_KALYANKJIL'

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of [495, 500, 505, 510, 530, 535, 540, 545]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: 900000 + strike * 10 + (type === 'CE' ? 1 : 2),
        tradingsymbol: `KALYANKJIL26JUL${strike}${type}`,
        name: SYMBOL,
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: 1350,
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
    [495, 500, 505, 510, 530, 535, 540, 545].flatMap((k) => [
      [`KALYANKJIL26JUL${k}CE`, 12],
      [`KALYANKJIL26JUL${k}PE`, 11],
    ]),
  ),
  { KALYANKJIL: 521 },
)

let clockMs = Date.UTC(2026, 6, 14, 5, 0)

function service(liveAllowlist: string[] = []): BridgeService {
  const db = handle!.db
  return new BridgeService({
    store,
    rails: { paper: new PaperRail(db), live: new LiveRail(db, liveAllowlist) },
    master: { current: () => master() },
    marks: MARKS,
    clock: { now: () => clockMs },
  })
}

const openAct = (ts: string, strike: number, type: 'CE' | 'PE', qty = 6750): DeskAction => ({
  op: 'open', ts, strike, type, side: 'Sell', qty,
})

const req = (over: Partial<ActionsRequest> = {}): ActionsRequest => ({
  symbol: SYMBOL,
  expiry: EXPIRY,
  mode: 'paper',
  tag: TAG,
  decisionId: `d-${Math.random().toString(36).slice(2)}`,
  actions: [openAct('CE530#0', 530, 'CE')],
  ...over,
})

/**
 * ONLY THE CONNECT IS CAUGHT.
 *
 * `available = false` skips this whole file, and node:test renders a skipped
 * file green. Wrapping `ensureIndexes()` in the same catch therefore meant that
 * an index which CANNOT BE BUILT — precisely what pre-existing duplicate
 * `decisionId`s cause — silently disabled every test here, including the ones
 * whose entire purpose is to prove those indexes hold. The absence of a
 * database is a legitimate reason to skip; a database that refuses our schema
 * is a failure and has to read as one.
 */
before(async () => {
  try {
    handle = await connectMongo(URL, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  available = true
})

after(async () => {
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) {
    await handle!.db.collection(c).deleteMany({})
  }
  // Indexes survive deleteMany, but re-assert in case a prior run dropped them.
  await store.ensureIndexes()
  // Every decision is gated on a registry row now, and an unregistered tag is
  // refused outright — so the fixture has to register its own tag, exactly as a
  // real deployment seeds one per book.
  await store.registerStrategy(
    // On for BOTH modes: the Python desk runs one tag across both rails, and
    // the gate is per mode now, so a paper-only fixture would refuse every live
    // decision below for the wrong reason.
    { tag: TAG, kind: 'external', label: 'Kalyan strangle', modes: { paper: { enabled: true }, live: { enabled: true } } },
    clockMs,
  )
})

/**
 * `available` is only known once `before()` has run, which is AFTER every
 * `test()` call has been registered. Passing `{skip}` at registration time
 * therefore always reads the initial `false` and skips the whole file even when
 * Mongo is up — so the check has to happen inside the test body.
 */
function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

itMongo('a paper decision books the leg and persists it', async () => {
  const svc = service()
  const r = await svc.applyDecision(req())
  assert.equal(r.status, 'DONE')
  assert.equal(r.replayed, false)
  assert.equal(r.fills.length, 1)
  assert.equal(r.routeErrors.length, 0)

  const reloaded = await store.loadBook(TAG, 'paper')
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0]?.instrument.tradingsymbol, 'KALYANKJIL26JUL530CE')
  assert.equal(reloaded[0]?.qty, -6750)
})

itMongo('PAPER NEVER writes to the collection xtsOrder.js watches', async () => {
  const svc = service()
  await svc.applyDecision(req())

  const paper = await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()
  const live = await handle!.db.collection(COLLECTIONS.live).find({}).toArray()
  assert.equal(paper.length, 1, 'the paper fill must be recorded')
  assert.equal(
    live.length,
    0,
    'a paper order in `positional` would be forwarded to a real broker by xtsOrder.js:314',
  )
})

itMongo('replaying a decisionId returns the original result and routes nothing', async () => {
  const svc = service()
  const request = req()
  const first = await svc.applyDecision(request)
  const second = await svc.applyDecision(request)

  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.deepEqual(second.fills.map((f) => f.tradingsymbol), first.fills.map((f) => f.tradingsymbol))

  const orders = await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()
  assert.equal(orders.length, 1, 'a replay must not produce a second order')
  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 1, 'a replay must not double the position')
})

itMongo('CONCURRENT identical decisions produce exactly one set of orders', async () => {
  // The real scenario: N pm2 processes retrying the same decision at once. A
  // read-then-write idempotency check would let both through; the unique index
  // is what actually holds.
  const svc = service()
  const request = req()
  const results = await Promise.all([
    svc.applyDecision(request),
    svc.applyDecision(request),
    svc.applyDecision(request),
  ])
  const applied = results.filter((r) => !r.replayed)
  assert.equal(applied.length, 1, `exactly one should apply, got ${applied.length}`)

  const orders = await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()
  assert.equal(orders.length, 1)
})

itMongo("live mode is refused unless the tag's LIVE switch is on", async () => {
  const svc = service([]) // nothing switched on for live
  const request = req({ mode: 'live' })
  const r = await svc.applyDecision(request)
  assert.equal(r.status, 'FAILED')
  assert.equal(r.routeErrors.length, 1)
  // The refusal names the control that grants live, because that is the only
  // useful thing it can say: the allowlist IS the password-gated `modes.live`
  // switch on the Strategies page now, not an env pin somebody has to redeploy.
  assert.match(r.routeErrors[0]!.error, /switch it on for LIVE on the Strategies page/)

  const live = await handle!.db.collection(COLLECTIONS.live).find({}).toArray()
  assert.equal(live.length, 0)
  const gateway = await handle!.db.collection(COLLECTIONS.gatewayOrders).find({}).toArray()
  assert.equal(gateway.length, 0, 'nor to the gateway the live rail actually writes to')

  /**
   * AND NOTHING WAS BOOKED. This test asserted only that no ORDER exists, which
   * both the correct behaviour and the bug it was written against satisfy: the
   * leg was still written into the book and into the decision's fills, so every
   * later reader believed in a live short that had no order behind it anywhere.
   * The concrete cost is not a wrong report — `close-all` over that phantom leg
   * places a REAL order in the opposite direction and opens a position nobody
   * asked for.
   */
  assert.deepEqual(await store.loadBook(TAG, 'live'), [], 'a leg that never routed is not a position')
  assert.deepEqual(r.book, [], 'and the response must not show one either')
  const stored = await store.getDecision(request.decisionId)
  assert.equal(stored?.fills.length, 0, 'the P&L journal must record no fill')
})

itMongo('live mode routes to the NEW GATEWAY by default, not the legacy path', async () => {
  // Full cutover: apps/order-gateway is the executor. The legacy `positional`
  // path is deprecated and must not receive anything unless explicitly asked.
  const svc = service([TAG])
  const r = await svc.applyDecision(req({ mode: 'live' }))
  assert.equal(r.status, 'DONE')

  const gateway = await handle!.db.collection(COLLECTIONS.gatewayOrders).find({}).toArray()
  const legacy = await handle!.db.collection(COLLECTIONS.live).find({}).toArray()
  assert.equal(gateway.length, 1, 'the new gateway is the default executor')
  assert.equal(legacy.length, 0, 'nothing may reach the retired xtsOrder.js path')

  const doc = gateway[0] as Record<string, unknown>
  assert.equal(doc['tag'], TAG)
  assert.equal(doc['tradingsymbol'], 'KALYANKJIL26JUL530CE')
  assert.equal(doc['transaction_type'], 'SELL', "broker side must be uppercase, not Python's 'Sell'")
  assert.equal(doc['order_type'], 'MARKET')
  assert.equal(doc['quantity'], 6750)
  assert.equal(doc['exchange'], 'NFO')
  /**
   * THE EXACT TOKEN, not merely "a token is present".
   *
   * `assert.ok(!== undefined)` was satisfied by ANY token, so a CE/PE
   * disambiguation inversion in the master would place a LIVE order in the PUT
   * at the same strike — with `tradingsymbol` still reading `...530CE` in every
   * assertion above it, because the symbol is echoed from the request while the
   * token is what the broker actually trades. The fixture's tokens encode the
   * type deliberately (`+1` for CE, `+2` for PE) so the two cannot be confused.
   */
  assert.equal(doc['instrument_token'], 900000 + 530 * 10 + 1, 'the CE token, never the PE at the same strike')
})

itMongo('the two live executors write to DIFFERENT collections', async () => {
  // If both xtsOrder.js and a new gateway consumed one collection, every desk
  // order would be placed twice. The target must therefore be an explicit
  // choice, and the two must never coincide.
  const legacy = new BridgeService({
    store,
    rails: {
      paper: new PaperRail(handle!.db),
      live: new LiveRail(handle!.db, [TAG], 'legacy-positional'),
    },
    master: { current: () => master() },
    marks: MARKS,
    clock: { now: () => clockMs },
  })
  await legacy.applyDecision(req({ mode: 'live', decisionId: 'legacy-1' }))

  const gateway = new BridgeService({
    store,
    rails: {
      paper: new PaperRail(handle!.db),
      live: new LiveRail(handle!.db, [TAG], 'desk-gateway'),
    },
    master: { current: () => master() },
    marks: MARKS,
    clock: { now: () => clockMs },
  })
  // A DIFFERENT leg: both rails share the one live book, so reusing the same
  // desk tag would be correctly skipped as a duplicate open and route nothing.
  await gateway.applyDecision(
    req({ mode: 'live', decisionId: 'gateway-1', actions: [openAct('PE510#1', 510, 'PE')] }),
  )

  const onPositional = await handle!.db.collection(COLLECTIONS.live).find({}).toArray()
  const onGateway = await handle!.db.collection(COLLECTIONS.gatewayOrders).find({}).toArray()
  assert.equal(onPositional.length, 1, 'the legacy executor sees exactly its own order')
  assert.equal(onGateway.length, 1, 'the new executor sees exactly its own order')
  assert.notEqual(COLLECTIONS.live, COLLECTIONS.gatewayOrders)
})

itMongo('paper and live keep SEPARATE books for the same symbol', async () => {
  const svc = service([TAG])
  await svc.applyDecision(req({ mode: 'paper', actions: [openAct('CE530#0', 530, 'CE')] }))
  await svc.applyDecision(req({ mode: 'live', actions: [openAct('PE510#0', 510, 'PE')] }))

  const paper = await store.loadBook(TAG, 'paper')
  const live = await store.loadBook(TAG, 'live')
  assert.equal(paper.length, 1)
  assert.equal(live.length, 1)
  assert.equal(paper[0]?.type, 'CE')
  assert.equal(live[0]?.type, 'PE')
})

itMongo('positions returns per-leg greeks and a net delta', async () => {
  const svc = service()
  const ladder: DeskAction[] = [
    openAct('CE530#0', 530, 'CE'), openAct('CE535#1', 535, 'CE'),
    openAct('PE510#2', 510, 'PE'), openAct('PE505#3', 505, 'PE'),
  ]
  await svc.applyDecision(req({ actions: ladder }))

  const pos = await svc.positions(TAG, 'paper')
  assert.equal(pos.legs.length, 4)
  assert.equal(pos.greeks.legs.length, 4)
  assert.equal(pos.greeks.unpriced.length, 0)
  assert.equal(pos.spot, 521)
  // A short strangle collects theta and is short vol.
  assert.ok(pos.greeks.netTheta > 0, `expected positive theta, got ${pos.greeks.netTheta}`)
  assert.ok(pos.greeks.netVega < 0, `expected negative vega, got ${pos.greeks.netVega}`)
  assert.ok(Number.isFinite(pos.greeks.netDelta))
})

itMongo('a full lifecycle — open, roll, close — leaves an empty book and 4 orders', async () => {
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'd1', actions: [openAct('CE530#0', 530, 'CE')] }))
  await svc.applyDecision(
    req({ decisionId: 'd2', actions: [{ op: 'roll', ts: 'CE530#0', to_ts: 'CE540#0', to_strike: 540 }] }),
  )
  const afterRoll = await store.loadBook(TAG, 'paper')
  assert.equal(afterRoll[0]?.strike, 540)

  await svc.applyDecision(req({ decisionId: 'd3', actions: [{ op: 'close', ts: 'CE540#0' }] }))
  assert.equal((await store.loadBook(TAG, 'paper')).length, 0)

  // open(1) + roll(2) + close(1)
  const orders = await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()
  assert.equal(orders.length, 4)
})

itMongo('the D2 diff reports what the desk claims against what we hold', async () => {
  const svc = service()
  await svc.applyDecision(req({ actions: [openAct('CE530#0', 530, 'CE')] }))

  await svc.declare(TAG, SYMBOL, [{ strike: 530, type: 'CE', qty: -6750 }])
  const inSync = await svc.diff(TAG, 'paper')
  assert.equal(inSync.inSync, true)

  // The desk believes it also holds a PE we never booked.
  await svc.declare(TAG, SYMBOL, [
    { strike: 530, type: 'CE', qty: -6750 },
    { strike: 510, type: 'PE', qty: -6750 },
  ])
  const drifted = await svc.diff(TAG, 'paper')
  assert.equal(drifted.inSync, false)
  assert.equal(drifted.deskOnly.length, 1)
  assert.equal(drifted.deskOnly[0]?.strike, 510)
  assert.ok(drifted.declaredAt !== null)
})

itMongo('an UNMARKED book reports incomplete — never a net delta of zero', async () => {
  // The dangerous failure: a dead feed makes every leg unpriceable, and if those
  // legs are silently dropped the book reports netDelta 0 with nothing flagged.
  // On a delta dashboard that reads as "flat, no action" while real risk is open.
  const svc = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle!.db), live: new LiveRail(handle!.db, []) },
    master: { current: () => master() },
    marks: MARKS,
    clock: { now: () => clockMs },
  })
  await svc.applyDecision(req({ actions: [openAct('CE530#0', 530, 'CE'), openAct('PE510#1', 510, 'PE')] }))

  // Now serve the same book with a mark source that knows nothing.
  const blind = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle!.db), live: new LiveRail(handle!.db, []) },
    master: { current: () => master() },
    marks: new StaticMarks({}, {}),
    clock: { now: () => clockMs },
  })
  const pos = await blind.positions(TAG, 'paper')
  assert.equal(pos.legs.length, 2, 'the legs are still held')
  assert.equal(pos.complete, false, 'the totals must NOT be presented as authoritative')
  assert.equal(pos.greeks.unpriced.length, 2, 'every dropped leg must be named')
  assert.equal(pos.greeks.netDelta, 0)
})

/**
 * A PARTIALLY marked book is MODELLED, not holed — and it says which legs.
 *
 * This test asserted the pre-model-pass contract (`complete: false`, the
 * quoteless leg in `unpriced`) and had been red ever since `positions()` grew
 * one. The behaviour it was guarding is intact and now lives in the test above
 * it: with NOTHING marked, nothing solves, there is no reference IV, and the
 * book stays incomplete with every leg named. What changed is the case where
 * SOME leg solved — its IV is a defensible reference, the quoteless leg is
 * priced theoretically off it, and the totals include it. `positions()` says so
 * in its own words: "True only when EVERY leg priced — market or model … a
 * model-priced leg is included (and named in `fallbackPriced`), so it does not
 * break completeness, it qualifies it."
 *
 * WHICH IS THE POINT WORTH PINNING. The dashboard's danger was never "a
 * modelled figure" — it was a net delta that silently OMITTED legs and read as
 * flat. A modelled leg is in the total and named as an estimate, so both the
 * number and its qualification are on screen.
 */
itMongo('a PARTIALLY marked book models the missing leg and NAMES it as an estimate', async () => {
  const svc = service()
  await svc.applyDecision(req({ actions: [openAct('CE530#0', 530, 'CE'), openAct('PE510#1', 510, 'PE')] }))

  const partial = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle!.db), live: new LiveRail(handle!.db, []) },
    master: { current: () => master() },
    marks: new StaticMarks({ KALYANKJIL26JUL530CE: 12 }, { KALYANKJIL: 521 }),
    clock: { now: () => clockMs },
  })
  const pos = await partial.positions(TAG, 'paper')
  assert.equal(pos.complete, true, 'every leg priced — one off the market, one off the model')
  assert.deepEqual(pos.greeks.unpriced, [], 'nothing was dropped from the totals')
  assert.deepEqual(
    pos.greeks.fallbackPriced,
    ['KALYANKJIL26JUL510PE'],
    'and the modelled leg is named, so the page can label it an estimate',
  )
  assert.equal(pos.greeks.legs.length, 2, 'both legs are in the per-leg table')
  assert.notEqual(pos.greeks.netDelta, 0, 'the marked leg still contributes')
})

itMongo('a fully marked book reports complete', async () => {
  const svc = service()
  await svc.applyDecision(req({ actions: [openAct('CE530#0', 530, 'CE')] }))
  const pos = await svc.positions(TAG, 'paper')
  assert.equal(pos.complete, true)
  assert.equal(pos.greeks.unpriced.length, 0)
})

itMongo('the kill switch blocks NEW exposure but never an exit', async () => {
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'ks-seed', actions: [openAct('CE530#0', 530, 'CE')] }))

  await svc.setKillSwitch(true, 'manual halt', 'test')
  assert.equal((await svc.killSwitch()).enabled, true)

  // An open is refused...
  const blocked = await svc.applyDecision(
    req({ decisionId: 'ks-open', actions: [openAct('PE510#1', 510, 'PE')] }),
  )
  assert.equal(blocked.fills.length, 0)
  assert.match(blocked.skips[0]!.reason, /kill switch engaged \(manual halt\)/)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1, 'no new leg')

  // ...but the exit still works. Trapping a position is worse than the halt.
  const exit = await svc.applyDecision(
    req({ decisionId: 'ks-close', actions: [{ op: 'close', ts: 'CE530#0' }] }),
  )
  assert.equal(exit.fills.length, 1, 'an exit must ALWAYS be permitted')
  assert.equal((await store.loadBook(TAG, 'paper')).length, 0)
})

itMongo('a halt permits a roll and a shrink, refuses a grow', async () => {
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'k2-seed', actions: [openAct('CE530#0', 530, 'CE')] }))
  await svc.setKillSwitch(true, '', 'test')

  const rolled = await svc.applyDecision(
    req({ decisionId: 'k2-roll', actions: [{ op: 'roll', ts: 'CE530#0', to_ts: 'CE540#0', to_strike: 540 }] }),
  )
  assert.equal(rolled.fills.length, 2, 'a roll strands a tested short if blocked')

  const shrunk = await svc.applyDecision(
    req({ decisionId: 'k2-shrink', actions: [{ op: 'resize', ts: 'CE540#0', qty: 2700 }] }),
  )
  assert.equal(shrunk.fills.length, 1, 'shrinking is an exit')

  const grown = await svc.applyDecision(
    req({ decisionId: 'k2-grow', actions: [{ op: 'resize', ts: 'CE540#0', qty: 13500 }] }),
  )
  assert.equal(grown.fills.length, 0, 'growing adds exposure')
  assert.match(grown.skips[0]!.reason, /kill switch/)
})

itMongo('the kill switch SURVIVES a restart', async () => {
  // A safety control that forgets itself on redeploy is not a safety control.
  const svc = service()
  await svc.setKillSwitch(true, 'overnight halt', 'operator')
  const fresh = new DeskStore(handle!.db)
  const reloaded = await fresh.loadKillSwitch()
  assert.equal(reloaded.enabled, true)
  assert.equal(reloaded.reason, 'overnight halt')
  assert.equal(reloaded.setBy, 'operator')
})

itMongo('close-all flattens every leg in ONE idempotent decision', async () => {
  const svc = service()
  await svc.applyDecision(req({
    decisionId: 'ca-seed',
    actions: [openAct('CE530#0', 530, 'CE'), openAct('PE510#1', 510, 'PE'), openAct('CE535#2', 535, 'CE')],
  }))
  assert.equal((await store.loadBook(TAG, 'paper')).length, 3)

  const closed = await svc.closeAll({
    symbol: SYMBOL, mode: 'paper', tag: TAG, decisionId: 'ca-1', style: 'fast',
  })
  assert.equal(closed.fills.length, 3)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 0)

  // A retried close-all must not sell anything a second time.
  const again = await svc.closeAll({
    symbol: SYMBOL, mode: 'paper', tag: TAG, decisionId: 'ca-1', style: 'fast',
  })
  assert.equal(again.replayed, true)
  const orders = await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()
  assert.equal(orders.length, 6, '3 opens + 3 closes, not 9')
})

itMongo('close-all WORKS while the kill switch is engaged', async () => {
  // Closing is the halt's purpose, not something it obstructs.
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'cak-seed', actions: [openAct('CE530#0', 530, 'CE')] }))
  await svc.setKillSwitch(true, 'emergency', 'operator')

  const closed = await svc.closeAll({
    symbol: SYMBOL, mode: 'paper', tag: TAG, decisionId: 'cak-1', style: 'fast',
  })
  assert.equal(closed.fills.length, 1)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 0)
})

itMongo('close-all with limit style prices THROUGH the mark', async () => {
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'cal-seed', actions: [openAct('CE530#0', 530, 'CE')] }))
  const closed = await svc.closeAll({
    symbol: SYMBOL, mode: 'paper', tag: TAG, decisionId: 'cal-1', style: 'limit', aggressionPct: 0.02,
  })
  const fill = closed.fills[0]!
  assert.equal(fill.orderType, 'LIMIT')
  // Closing a short buys, so the limit sits above the 12 mark.
  assert.ok((fill.limitPrice ?? 0) > 12, `expected a bid through the mark, got ${String(fill.limitPrice)}`)

  const order = (await handle!.db.collection(COLLECTIONS.paperTrade).find({ desk_op: 'close' }).toArray())[0]
  assert.equal(order?.['order_type'], 'LIMIT', 'the rail must emit the LIMIT type')
  assert.equal(order?.['limitPrice'], fill.limitPrice)
})

// ------------------------------------------------------- the strategy switch

itMongo('a DISABLED strategy blocks every action and journals the refusal', async () => {
  const svc = service()
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } }, disabledReason: 'margin call' })

  const r = await svc.applyDecision(req({ decisionId: 'sw-1', actions: [openAct('CE530#0', 530, 'CE')] }))
  assert.equal(r.fills.length, 0)
  assert.equal(r.skips.length, 1)
  assert.match(r.skips[0]!.reason, /strategy DESK_KALYANKJIL is switched off for paper \(margin call\)/)

  // Nothing queued, nothing routed, no book written.
  assert.equal((await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()).length, 0)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 0)

  // The skip is durable, in both journals: the decision record is what the desk
  // reads back, the order feed is what the portal renders.
  assert.equal((await store.getDecision('sw-1'))?.skips.length, 1)
  const events = await handle!.db.collection(COLLECTIONS.orderEvents).find({ ok: false }).toArray()
  assert.equal(events.length, 1, 'the portal must show what was blocked while it was off')
  assert.equal(events[0]?.['tag'], TAG)
  assert.match(String(events[0]?.['error']), /is switched off/)
})

itMongo('a disabled strategy cannot EXIT either — off means off', async () => {
  // The deliberate asymmetry with the kill switch, at the database level.
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'sw2-seed', actions: [openAct('CE530#0', 530, 'CE')] }))
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } } })

  for (const [id, action] of [
    ['sw2-close', { op: 'close', ts: 'CE530#0' }],
    ['sw2-roll', { op: 'roll', ts: 'CE530#0', to_ts: 'CE540#0', to_strike: 540 }],
    ['sw2-shrink', { op: 'resize', ts: 'CE530#0', qty: 1350 }],
  ] as [string, DeskAction][]) {
    const r = await svc.applyDecision(req({ decisionId: id, actions: [action] }))
    assert.equal(r.fills.length, 0, `${action.op} must be blocked`)
    assert.match(r.skips[0]!.reason, /is switched off/)
  }
  const book = await store.loadBook(TAG, 'paper')
  assert.equal(book.length, 1, 'the leg is untouched')
  assert.equal(book[0]?.strike, 530, 'and unrolled')
})

itMongo('the switch is PER MODE on the decision path too', async () => {
  // The Python desk's path, not just `/submit`. A tag switched off for live
  // must be refused a live decision while its paper book keeps trading — and
  // the refusal must say which switch it read, or an operator goes hunting for
  // a fault that is not there.
  const svc = service()
  await svc.patchStrategy(TAG, { modes: { live: { enabled: false } } })

  const live = await svc.applyDecision(
    req({ decisionId: 'pm-live', mode: 'live', actions: [openAct('CE530#0', 530, 'CE')] }),
  )
  assert.equal(live.fills.length, 0)
  assert.match(live.skips[0]!.reason, /switched off for live/)
  assert.equal((await store.loadBook(TAG, 'live')).length, 0)

  const paper = await svc.applyDecision(
    req({ decisionId: 'pm-paper', actions: [openAct('CE530#0', 530, 'CE')] }),
  )
  assert.equal(paper.fills.length, 1, 'the paper book is untouched by the live refusal')
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1)
})

itMongo('close-all still flattens a DISABLED strategy — it runs as the operator', async () => {
  // The escape hatch that makes "off means off" safe: switching a book off must
  // not leave its position both unmanaged and unclosable.
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'sw3-seed', actions: [openAct('CE530#0', 530, 'CE')] }))
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } }, disabledReason: 'stopped for the day' })

  const closed = await svc.closeAll({
    symbol: SYMBOL, mode: 'paper', tag: TAG, decisionId: 'sw3-close', style: 'fast',
  })
  assert.equal(closed.fills.length, 1)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 0)
})

itMongo('enabling a strategy then acting works, and the switch survives a reload', async () => {
  const svc = service()
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } }, disabledReason: 'not started yet' })
  const blocked = await svc.applyDecision(req({ decisionId: 'sw4-a', actions: [openAct('CE530#0', 530, 'CE')] }))
  assert.equal(blocked.fills.length, 0)

  const on = await svc.patchStrategy(TAG, { modes: { paper: { enabled: true } } })
  assert.notEqual(on, 'conflict')
  assert.equal(on !== 'conflict' ? isOn(on?.modes ?? {}, 'paper') : null, true)
  assert.equal(
    on !== 'conflict' ? on?.disabledReason : null,
    '',
    'a running strategy must not still claim to be disabled',
  )

  const r = await svc.applyDecision(req({ decisionId: 'sw4-b', actions: [openAct('CE530#0', 530, 'CE')] }))
  assert.equal(r.fills.length, 1)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1)

  // A fresh store, as after a redeploy: a switch that forgets itself is not one.
  const reloaded = await new DeskStore(handle!.db).loadStrategy(TAG)
  assert.equal(isOn(reloaded?.modes ?? {}, 'paper'), true)
  assert.ok((reloaded?.lastSeenAt ?? 0) > 0, 'acting stamps liveness for the portal')
})

itMongo('an UNKNOWN tag is REFUSED, never implicitly allowed', async () => {
  // A Python client with a typo in its tag has no switch anywhere in the portal.
  const svc = service()
  await assert.rejects(
    () => svc.applyDecision(req({ tag: 'DESK_KALYANKJILL', decisionId: 'sw5' })),
    (err: unknown) => err instanceof UnknownStrategy && /is not registered/.test(err.message),
  )
  assert.equal((await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()).length, 0)
  // Refused loudly AND recorded — but the decisionId is not consumed, so the
  // same decision can be replayed once the tag is actually registered.
  const events = await handle!.db.collection(COLLECTIONS.orderEvents).find({}).toArray()
  assert.equal(events.length, 1)
  assert.equal(events[0]?.['tag'], 'DESK_KALYANKJILL')
  assert.equal(await store.getDecision('sw5'), null)
})

itMongo('the strategy switch and the kill switch are INDEPENDENT', async () => {
  const svc = service()
  await svc.applyDecision(req({ decisionId: 'ind-seed', actions: [openAct('CE530#0', 530, 'CE')] }))

  // Kill switch alone: the exit goes through, because a halt must never trap.
  await svc.setKillSwitch(true, 'halt', 'test')
  const haltedOpen = await svc.applyDecision(req({ decisionId: 'ind-1', actions: [openAct('PE510#1', 510, 'PE')] }))
  assert.match(haltedOpen.skips[0]!.reason, /kill switch/)
  const haltedExit = await svc.applyDecision(req({ decisionId: 'ind-2', actions: [{ op: 'close', ts: 'CE530#0' }] }))
  assert.equal(haltedExit.fills.length, 1, 'the halt never blocks an exit')

  // Strategy switch alone: the exit is blocked, because off means off.
  await svc.setKillSwitch(false, '', 'test')
  await svc.applyDecision(req({ decisionId: 'ind-3', actions: [openAct('CE535#2', 535, 'CE')] }))
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } } })
  const offExit = await svc.applyDecision(req({ decisionId: 'ind-4', actions: [{ op: 'close', ts: 'CE535#2' }] }))
  assert.equal(offExit.fills.length, 0)
  assert.match(offExit.skips[0]!.reason, /is switched off/)
  assert.doesNotMatch(offExit.skips[0]!.reason, /kill switch/, 'each gate answers for itself')

  // Both on: the strategy switch is checked first and is the reason reported.
  await svc.setKillSwitch(true, 'halt', 'test')
  const both = await svc.applyDecision(req({ decisionId: 'ind-5', actions: [openAct('PE505#3', 505, 'PE')] }))
  assert.equal(both.fills.length, 0)
  assert.match(both.skips[0]!.reason, /is switched off/)
})

itMongo('disabling does NOT retroactively affect an already-routed order', async () => {
  const svc = service()
  const request = req({ decisionId: 'retro-1', actions: [openAct('CE530#0', 530, 'CE')] })
  const first = await svc.applyDecision(request)
  assert.equal(first.fills.length, 1)

  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } }, disabledReason: 'switched off after the fill' })

  // The order that already went out stays out, and the book still holds the leg.
  const orders = await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()
  assert.equal(orders.length, 1, 'a routed order is not unwound by a later switch flip')
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1)

  // And a retry of that decisionId still replays the ORIGINAL result rather
  // than turning into a refusal — the desk's retry loop is safe across a flip.
  const replay = await svc.applyDecision(request)
  assert.equal(replay.replayed, true)
  assert.equal(replay.fills.length, 1)
  assert.equal(replay.skips.length, 0)
  assert.equal((await handle!.db.collection(COLLECTIONS.paperTrade).find({}).toArray()).length, 1)
})

itMongo('the registry rejects a duplicate tag at the database', async () => {
  // Two rows for one tag would make "is this strategy enabled?" depend on which
  // one Mongo happened to return first.
  await assert.rejects(() =>
    handle!.db.collection(COLLECTIONS.strategies).insertOne({ tag: TAG, modes: { paper: { enabled: true } } }),
  )
  const listed = await store.listStrategies()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.tag, TAG)
})

itMongo('patching an unregistered tag creates nothing', async () => {
  const svc = service()
  assert.equal(await svc.patchStrategy('DESK_NOBODY', { modes: { paper: { enabled: true } } }), null)
  assert.equal((await store.listStrategies()).length, 1, 'no phantom row')
})

itMongo('two tags on one symbol keep independent books through applyDecision', async () => {
  const svc = service()
  await store.registerStrategy({ tag: 'BHEL-A', kind: 'external', modes: { paper: { enabled: true } } }, clockMs)
  await store.registerStrategy({ tag: 'BHEL-B', kind: 'external', modes: { paper: { enabled: true } } }, clockMs)

  await svc.applyDecision(
    req({ tag: 'BHEL-A', decisionId: 'a-1', actions: [openAct('CE500#1', 500, 'CE', 1350)] }),
  )
  await svc.applyDecision(
    req({ tag: 'BHEL-B', decisionId: 'b-1', actions: [openAct('CE505#1', 505, 'CE', 2700)] }),
  )

  const a = await svc.positions('BHEL-A', 'paper')
  const b = await svc.positions('BHEL-B', 'paper')
  assert.equal(a.legs.length, 1)
  assert.equal(b.legs.length, 1)
  assert.equal(a.legs[0]?.strike, 500)
  assert.equal(b.legs[0]?.strike, 505)
})

itMongo('a decision with an unlisted strike partially applies and reports the skip', async () => {
  const svc = service()
  const r = await svc.applyDecision(
    req({
      actions: [
        openAct('CE530#0', 530, 'CE'),
        openAct('CE525#1', 525, 'CE'), // not listed
        openAct('PE510#2', 510, 'PE'),
      ],
    }),
  )
  assert.equal(r.fills.length, 2)
  assert.equal(r.skips.length, 1)
  assert.match(r.skips[0]!.reason, /not a listed contract/)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 2)

  // The skip must be durable — the desk may read it back later.
  const stored = await store.getDecision(r.decisionId)
  assert.equal(stored?.skips.length, 1)
})

// ------------------------------------------------------- per-tag trade query

itMongo('paperTrades(tag) returns only that book, not the sibling on the same symbol', async () => {
  const svc = service()
  await store.registerStrategy({ tag: 'BHEL-A', kind: 'external', modes: { paper: { enabled: true } } }, clockMs)
  await store.registerStrategy({ tag: 'BHEL-B', kind: 'external', modes: { paper: { enabled: true } } }, clockMs)

  await svc.applyDecision(
    req({ tag: 'BHEL-A', decisionId: 'trades-a-1', actions: [openAct('CE500#1', 500, 'CE', 1350)] }),
  )
  await svc.applyDecision(
    req({ tag: 'BHEL-B', decisionId: 'trades-b-1', actions: [openAct('CE505#1', 505, 'CE', 2700)] }),
  )

  const a = await svc.paperTrades({ tag: 'BHEL-A' })
  assert.equal(a.length, 1)
  assert.equal(a[0]?.['tag'], 'BHEL-A')

  const b = await svc.paperTrades({ tag: 'BHEL-B' })
  assert.equal(b.length, 1)
  assert.equal(b[0]?.['tag'], 'BHEL-B')

  // No tag at all still returns both, unfiltered — the untagged default.
  const both = await svc.paperTrades()
  assert.equal(both.length, 2)
})

/**
 * PAPER HAS TWO WRITERS SINCE D14, and the Trades tab was reading one.
 *
 * The synchronous rail writes `desk-paper-trade`; an ENGINE paper order is
 * worked through the gateway queue and its simulated fill lands in
 * `desk-fills` stamped `mode: 'paper'`. Serving only the first meant a
 * rehearsal traded all morning and this answer was empty — on the one surface
 * that exists to say whether the engine actually filled.
 */
itMongo('paper trades include the ENGINE fills, and never a live one', async () => {
  const svc = service()
  await handle!.db.collection('desk-fills').deleteMany({})
  await store.registerStrategy({ tag: TAG, kind: 'external', modes: { paper: { enabled: true } } }, clockMs)
  // One trade on the synchronous rail...
  await svc.applyDecision(req({ decisionId: 'union-1', actions: [openAct('CE530#0', 530, 'CE', 1350)] }))
  // ...and the gateway's own two rows, as its writer shapes them.
  await handle!.db.collection('desk-fills').insertMany([
    { clientOrderId: 'e-1#0', tradingsymbol: 'KALYANKJIL26JUL510PE', status: 'FILLED', filledQty: 1350, avgPrice: 11.2, ts: clockMs + 5_000, tag: TAG, mode: 'paper' },
    // The one that must NOT appear: a real broker fill on the same tag.
    { clientOrderId: 'e-2#0', tradingsymbol: 'KALYANKJIL26JUL505PE', status: 'FILLED', filledQty: 1350, avgPrice: 9.9, ts: clockMs + 6_000, tag: TAG, mode: 'live' },
  ])

  const rows = await svc.paperTrades({ tag: TAG })
  assert.equal(rows.length, 2, 'both paper writers are represented')
  const symbols = rows.map((r) => String(r['tradingsymbol'])).sort()
  assert.deepEqual(symbols, ['KALYANKJIL26JUL510PE', 'KALYANKJIL26JUL530CE'].sort())
  // NEWEST FIRST, across both shapes: the rail stamps `order_timestamp` and the
  // gateway `ts`, so a comparator reading one key would bury half the list.
  assert.equal(rows[0]?.['tradingsymbol'], 'KALYANKJIL26JUL510PE', 'the later engine fill leads')

  // A row with no mode at all is a LIVE broker fill from before the field
  // existed. `$ne 'live'` would have swept it onto the paper tab.
  await handle!.db.collection('desk-fills').insertOne({
    clientOrderId: 'e-3#0', tradingsymbol: 'KALYANKJIL26JUL495PE', status: 'FILLED',
    filledQty: 1350, avgPrice: 3.3, ts: clockMs + 7_000, tag: TAG,
  })
  const again = await svc.paperTrades({ tag: TAG })
  assert.equal(again.length, 2, 'an unstamped fill is live, and stays off this list')
})

itMongo('a symbol-only paper query answers from the rail alone rather than guessing', async () => {
  // `desk-fills` carries the contract and the tag, never the underlying, so
  // there is no honest way to answer "this symbol" from it. Returning the lot
  // regardless would put another book's trades under a symbol that never
  // traded them.
  const svc = service()
  await handle!.db.collection('desk-fills').deleteMany({})
  await svc.applyDecision(req({ decisionId: 'sym-1', actions: [openAct('CE530#0', 530, 'CE', 1350)] }))
  await handle!.db.collection('desk-fills').insertOne({
    clientOrderId: 'e-9#0', tradingsymbol: 'SOMETHINGELSE26AUG100CE', status: 'FILLED',
    filledQty: 1350, avgPrice: 4.4, ts: clockMs + 5_000, tag: 'ANOTHER_BOOK', mode: 'paper',
  })

  const rows = await svc.paperTrades({ symbol: SYMBOL })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.['tradingsymbol'], 'KALYANKJIL26JUL530CE')
})

itMongo('fills(tag) filters desk-fills, so a two-variant symbol reconciles the right legs', async () => {
  const svc = service()
  // `desk-fills` is NOT in `COLLECTIONS` (the gateway owns it, not this app —
  // see `service.fills`'s docstring), so the shared `beforeEach` above never
  // clears it between tests. Clear it here, or a prior run's rows leak in.
  await handle!.db.collection('desk-fills').deleteMany({})
  // Inserted directly here the way the gateway's own writer would.
  await handle!.db.collection('desk-fills').insertMany([
    { clientOrderId: 'g-1#0', baseClientOrderId: 'g-1#0', brokerOrderId: 'B1', tradingsymbol: 'BHEL26AUG420CE', status: 'FILLED', filledQty: 2625, avgPrice: 15.4, ts: clockMs, tag: 'BHEL-hold-recycle-r', mode: 'live' },
    { clientOrderId: 'g-2#0', baseClientOrderId: 'g-2#0', brokerOrderId: 'B2', tradingsymbol: 'BHEL26AUG420CE', status: 'FILLED', filledQty: 2625, avgPrice: 15.6, ts: clockMs + 1, tag: 'BHEL-scalp', mode: 'live' },
  ])

  const recycle = await svc.fills({ tag: 'BHEL-hold-recycle-r' })
  assert.equal(recycle.length, 1)
  assert.equal(recycle[0]?.['brokerOrderId'], 'B1')

  const scalp = await svc.fills({ tag: 'BHEL-scalp' })
  assert.equal(scalp.length, 1)
  assert.equal(scalp[0]?.['brokerOrderId'], 'B2')

  const all = await svc.fills()
  assert.equal(all.length, 2, 'no tag filter falls back to the full stream')
})

// ------------------------------------------------- the partial-route recompute

/**
 * `applyDecision` recomputes the book from the actions that FULLY routed when
 * some of them did not. That recompute is BOOKKEEPING — it records what went
 * out — and it used to re-run every pricing gate, on the wall clock.
 *
 * `QuoteCache.markAge` reads `Date.now()`, so a mark that was fresh when the
 * decision was priced can age past `DESK_MAX_OPEN_MARK_AGE_MS` during the
 * network round trips of routing. The recompute then SKIPPED the open, the
 * recomputed book came back without it, and a leg with a real order behind it
 * silently vanished — and tomorrow's `close-all` sends a real order against a
 * position the book says is not there.
 */
itMongo('an open that ROUTED is re-folded even when its mark has since gone stale', async () => {
  let ages = 0
  const aging = {
    price: (i: { tradingsymbol: string }) => MARKS.price(i as never),
    spot: (u: string) => MARKS.spot(u),
    // Fresh for the pricing pass, stale by the time routing has finished — the
    // wall clock moving under a job that takes network round trips.
    markAge: (): number => (ages++ < 2 ? 1_000 : 900_000),
  }
  const svc = new BridgeService({
    store,
    rails: {
      paper: {
        mode: 'paper',
        collection: COLLECTIONS.paperTrade,
        route: async (fill) => {
          // One leg's route fails, which is what makes the recompute run at all.
          if (fill.tradingsymbol === 'KALYANKJIL26JUL535CE') throw new Error('rail refused')
        },
      },
      live: new LiveRail(handle!.db, []),
    },
    master: { current: () => master() },
    marks: aging as never,
    maxOpenMarkAgeMs: 600_000,
    clock: { now: () => clockMs },
  })

  const r = await svc.applyDecision(
    req({
      decisionId: 'stale-recompute-1',
      actions: [openAct('CE530#0', 530, 'CE'), openAct('CE535#0', 535, 'CE')],
    }),
  )

  assert.equal(r.status, 'FAILED', 'one leg really did fail to route')
  assert.equal(r.fills.length, 1)
  assert.equal(r.fills[0]?.tradingsymbol, 'KALYANKJIL26JUL530CE')

  const stored = await store.loadBook(TAG, 'paper')
  assert.equal(stored.length, 1, 'the leg that ROUTED must be on the book')
  assert.equal(stored[0]?.instrument.tradingsymbol, 'KALYANKJIL26JUL530CE')
  assert.equal(stored[0]?.qty, -6750)
})

// ------------------------------- a book CREATED inside the routing window

/**
 * The compare-and-set had a hole exactly where there was no row to pin: a first
 * decision on a fresh tag read `undefined` and fell back to a blind upsert. An
 * operator creating that book from the Build screen during the routing window
 * was `$set`-overwritten with no conflict — the same lost update F-27 exists to
 * prevent, at the one moment the guard was absent.
 */
itMongo('a book created DURING the routing window is not overwritten by the decision', async () => {
  const tag = 'DESK_KALYAN_CREATE'
  await store.registerStrategy(
    { tag, kind: 'external', modes: { paper: { enabled: true } } },
    clockMs,
  )
  const m = master()
  const operatorLeg = {
    deskTag: 'OPERATOR#1',
    instrument: m.resolveSymbol('KALYANKJIL26JUL500PE')!,
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike: 500,
    type: 'PE' as const,
    side: 'Sell' as const,
    qty: -1350,
    entryPrice: 11,
    openedTs: clockMs,
  }

  let created = false
  const inner = new PaperRail(handle!.db)
  const svc = new BridgeService({
    store,
    rails: {
      paper: {
        mode: 'paper',
        collection: inner.collection,
        route: async (fill, ctx) => {
          if (!created) {
            created = true
            // The Build screen's Place lands INSIDE the window.
            await store.saveBook(
              { tag, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY },
              [operatorLeg],
              clockMs,
            )
          }
          await inner.route(fill, ctx)
        },
      },
      live: new LiveRail(handle!.db, []),
    },
    master: { current: () => m },
    marks: MARKS,
    clock: { now: () => clockMs },
  })

  await svc.applyDecision(req({ tag, decisionId: 'create-race-1' }))

  const stored = await store.loadBook(tag, 'paper')
  assert.equal(stored.length, 2, "the operator's leg survives, and ours is folded onto it")
  assert.deepEqual(
    stored.map((l) => l.instrument.tradingsymbol).sort(),
    ['KALYANKJIL26JUL500PE', 'KALYANKJIL26JUL530CE'],
  )
})

// ------------------------------------------------------ risk limits (F-28)
//
// The WIRING of the desk-wide caps onto `applyDecision`, against the real
// store — the verdicts themselves belong to `decision-plan.test.ts` and
// `order-bus/test/risk.test.ts`. What matters here is that a refused action
// reaches no rail, is reported as a skip, lands in the order log, and that an
// EXIT in the same decision goes out anyway.

function riskService(
  env: Record<string, string>,
  exposure: Partial<ExposureState>,
  ledger = new ReservationLedger(6_000),
): BridgeService {
  const db = handle!.db
  return new BridgeService({
    store,
    rails: { paper: new PaperRail(db), live: new LiveRail(db, [TAG]) },
    master: { current: () => master() },
    marks: MARKS,
    clock: { now: () => clockMs },
    risk: {
      limits: exposureLimitsFromEnv(env),
      // FROZEN, exactly as main.ts's 2s TTL cache freezes it — the reservation
      // ledger is the only thing that moves inside the window.
      exposure: async () =>
        ledger.applyTo(
          {
            nowMs: clockMs,
            recentOrderTs: [],
            openLotsByUnderlying: {},
            openLotsTotal: 0,
            dayLoss: 0,
            ...exposure,
          },
          clockMs,
        ),
      record: () => {},
      reserve: (lots, underlying, at) => ledger.reserve(lots, underlying, at),
    },
  })
}

itMongo('a configured cap skips the live OPEN, routes the CLOSE, and says which limit', async () => {
  // A leg to close, so the decision carries one action of each kind.
  const seed = service([TAG])
  await seed.applyDecision(
    req({ mode: 'live', decisionId: 'risk-seed', actions: [openAct('PE500#0', 500, 'PE')] }),
  )
  const before = (await store.loadBook(TAG, 'live')).length
  assert.equal(before, 1)

  const svc = riskService({ DESK_RISK_MAX_TOTAL_LOTS: '4' }, { openLotsTotal: 4 })
  const res = await svc.applyDecision(
    req({
      mode: 'live',
      decisionId: 'risk-1',
      actions: [openAct('CE530#0', 530, 'CE'), { op: 'close', ts: 'PE500#0' }],
    }),
  )

  const skipped = res.skips.filter((s) => /risk limit/.test(s.reason))
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0]?.action.ts, 'CE530#0')
  assert.match(skipped[0]?.reason ?? '', /MAX_LOTS_TOTAL/)
  assert.match(skipped[0]?.reason ?? '', /DESK_RISK_MAX_TOTAL_LOTS/)
  // The exit went out; the entry did not.
  assert.deepEqual(res.book, [])
  assert.equal(res.fills.length, 1)
  assert.equal(res.fills[0]?.op, 'close')

  const events = await handle!.db
    .collection(COLLECTIONS.orderEvents)
    .find({ 'detail.decisionId': 'risk-1' })
    .toArray()
  assert.equal(events.length, 1, 'the refusal is in the order log, as submit journals its own')
  assert.match(String(events[0]?.['error']), /risk limit MAX_LOTS_TOTAL/)
  assert.equal(events[0]?.['tag'], TAG)
})

itMongo('a refusal never takes the id of an order that DID route in the same decision', async () => {
  const seed = service([TAG])
  await seed.applyDecision(
    req({ mode: 'live', decisionId: 'risk-id-seed', actions: [openAct('PE500#0', 500, 'PE')] }),
  )

  const svc = riskService({ DESK_RISK_MAX_TOTAL_LOTS: '4' }, { openLotsTotal: 4 })
  await svc.applyDecision(
    req({
      mode: 'live',
      decisionId: 'risk-id-1',
      // The refused OPEN is action 0; the CLOSE that follows it routes as
      // FILL 0, so both would be '#0' under one id shape.
      actions: [openAct('CE530#0', 530, 'CE'), { op: 'close', ts: 'PE500#0' }],
    }),
  )

  const events = await handle!.db
    .collection(COLLECTIONS.orderEvents)
    .find({ 'detail.decisionId': 'risk-id-1' })
    .toArray()
  assert.equal(events.length, 1)
  const refusalId = String(events[0]?.['clientOrderId'])
  assert.equal(refusalId, 'risk-id-1#skip-0', 'a refusal is not an order and must not look like one')

  const routed = await handle!.db
    .collection(COLLECTIONS.gatewayOrders)
    .find({ clientOrderId: { $regex: '^risk-id-1' } })
    .toArray()
  assert.deepEqual(
    routed.map((d) => String(d['clientOrderId'])),
    ['risk-id-1#0'],
    'the routed id derivation is unchanged — replay determinism depends on it',
  )
  assert.notEqual(refusalId, routed[0]?.['clientOrderId'])
})

itMongo('two decisions inside ONE measurement window cannot jointly exceed the cap', async () => {
  // 4 open, cap 5, one lot per decision: the first fits, the second must not —
  // and both read the SAME frozen measurement, as the 2s TTL cache serves it.
  const svc = riskService({ DESK_RISK_MAX_TOTAL_LOTS: '5' }, { openLotsTotal: 4 })

  const first = await svc.applyDecision(
    req({ mode: 'live', decisionId: 'risk-race-1', actions: [openAct('CE530#0', 530, 'CE', 1350)] }),
  )
  assert.equal(first.fills.length, 1, 'the first open fits under the cap')

  const second = await svc.applyDecision(
    req({ mode: 'live', decisionId: 'risk-race-2', actions: [openAct('CE535#0', 535, 'CE', 1350)] }),
  )
  assert.deepEqual(second.fills, [], 'the first decision is in flight and holds the last lot')
  assert.match(second.skips[0]?.reason ?? '', /MAX_LOTS_TOTAL/)
})

itMongo('the same decision on PAPER is not risk-gated at all', async () => {
  const svc = riskService({ DESK_RISK_MAX_TOTAL_LOTS: '1' }, { openLotsTotal: 900 })
  const res = await svc.applyDecision(req({ decisionId: 'risk-paper-1' }))
  assert.deepEqual(res.skips, [])
  assert.equal(res.fills.length, 1)
})
