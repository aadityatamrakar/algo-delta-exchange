/**
 * `POST /v1/desk/engine/decisions` end to end — a real server, real Mongo.
 *
 * WHY AT THIS LEVEL. The endpoint's whole value is that it is NOT a second
 * order path: it translates the supervisor's instrument-and-quantity wire into
 * the desk actions `applyDecision` already knows, and everything that matters
 * afterwards — the strategy switch, the `decisionId` claim, the rail split, the
 * book fold — is enforced by the database and by code this file does not touch.
 * A unit test with a fake service would prove the translation and nothing else,
 * which is the half that was never in doubt.
 *
 * Skips itself when no Mongo is reachable; `DESK_REQUIRE_MONGO=1` turns that
 * skip into a failure (see `require-mongo.ts`).
 */

import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import type { DecisionRequest, DecisionResponse } from '@algomaker/desk-engine'
import { ENGINE_DECISIONS_PATH } from '@algomaker/desk-engine'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import { createBridgeServer } from '../src/server.ts'
import type { AuthGate } from '../src/authgate.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import { engineRoutes, ENGINE_DECISIONS_COLLECTION } from '../src/routes/engine.ts'
import { notifySupervisor, resetNudgeLog, NUDGE_PATH } from '../src/engine-notify.ts'
import { liveAllowlistFromStrategies } from '../src/strategies.ts'

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_engine_test'
/** The supervisor's credential: a `machine` principal. */
const TOKEN = 'engine-test-token'
/** A browser session. It must not be able to post a decision package at all. */
const USER_TOKEN = 'engine-test-operator'
const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'
const TAG = 'DESK_BHEL'
const LOT = 2625
/** The one instant the whole server is fixed at, service and routes alike. */
const NOW = Date.UTC(2026, 7, 21, 5, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false
/** Every line the routes logged, for the one test that is about the log. */
const logged: { msg: string; ctx?: Record<string, unknown> }[] = []
/**
 * The very service the endpoint is mounted on, held so one test can call
 * `applyDecision` DIRECTLY. The reduce-only claim is downgraded inside that
 * method, against a book it reads after the caller read its own — a window an
 * HTTP test cannot open on purpose, and a guarantee too load-bearing to leave
 * unpinned.
 */
let svc: BridgeService

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  // BHEL's real grid is 2.5 wide — which is why the step is inferred, not set.
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
  /**
   * A SECOND EXPIRY ON THE SAME STRIKES, and it is the point of one test below.
   * The wire names a contract; the request names an expiry. If the endpoint
   * takes the strike off the contract and re-resolves it against the request's
   * expiry, it books a leg on a DIFFERENT contract than the one the supervisor
   * asked for — silently, because both exist.
   */
  for (const strike of [415, 420]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: 9_000_000 + Math.round(strike * 100) + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BHEL26SEP${strike}${type}`,
        name: SYMBOL,
        expiry: '2026-09-29',
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

/**
 * Two credentials, two principal kinds, one gate. The machine-only refusal
 * cannot be proved with `bearerGate`, which only ever mints a machine.
 */
const gate: AuthGate = {
  authenticate: async (req) => {
    const header = req.headers.authorization ?? ''
    if (header === `Bearer ${TOKEN}`) return { kind: 'machine', name: 'supervisor' }
    if (header === `Bearer ${USER_TOKEN}`) return { kind: 'user', name: 'operator' }
    return null
  },
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
  const service = (svc = new BridgeService({
    store,
    rails: {
      paper: new PaperRail(handle.db),
      // The REAL allowlist resolver, not a fixed set: the live rail's own gate
      // reads the strategy row, and a fixture that hard-coded the tag would
      // pass a test the deployment fails.
      live: new LiveRail(handle.db, liveAllowlistFromStrategies(
        handle.db.collection(COLLECTIONS.strategies),
        new Set<string>(),
      )),
    },
    master: { current: master },
    marks: MARKS,
    clock: { now: () => NOW },
  }))
  const apiDeps: ApiDeps = {
    db: handle.db,
    store,
    service,
    master: { current: master },
    log: () => {},
    now: () => NOW,
  }
  server = createBridgeServer({
    gate,
    routes: [engineRoutes({ ...apiDeps, gate })],
    log: (msg, ctx) => logged.push({ msg, ...(ctx === undefined ? {} : { ctx }) }),
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  await handle!.db.collection(ENGINE_DECISIONS_COLLECTION).deleteMany({})
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

interface Posted {
  readonly status: number
  readonly body: DecisionResponse & { readonly error?: string }
}

async function post(body: unknown, token = TOKEN): Promise<Posted> {
  const res = await fetch(`${base}${ENGINE_DECISIONS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Posted['body'] }
}

let seq = 0
function request(over: Partial<DecisionRequest> = {}): DecisionRequest {
  const mode = over.mode ?? 'paper'
  const tag = over.tag ?? TAG
  seq++
  return {
    tag,
    mode,
    // The contract's own shape, `${tag}:${mode}:${seq}` — the mode is in the id
    // because paper and live are two ledgers on one tag.
    decisionId: `${tag}:${mode}:${seq}`,
    symbol: SYMBOL,
    expiry: EXPIRY,
    trigger: 'shift',
    reason: 'band breached on the upside',
    actions: [{ op: 'open', instrument: 'BHEL26AUG415CE', side: 'Sell', qty: LOT }],
    ...over,
  }
}

/**
 * WHERE AN ENGINE PAPER ORDER NOW LANDS (D14, plan Task 18).
 *
 * `desk-gateway-orders`, not `desk-paper-trade`. The engine's paper packages
 * are worked by the gateway exactly as live ones are — claimed, gated, pegged,
 * tranche-worked, filled by a tick — so the document this suite pins is the one
 * the gateway claims, and `desk-paper-trade` is asserted EMPTY wherever the old
 * instant-fill path would have written to it.
 */
async function routedOrders(): Promise<Record<string, unknown>[]> {
  return (await handle!.db.collection(COLLECTIONS.gatewayOrders).find({}).toArray()) as Record<
    string,
    unknown
  >[]
}

/**
 * A leg on the paper book, written DIRECTLY.
 *
 * Seeding through a decision used to work because a paper decision folded its
 * own book in the same request. It no longer does — the fill arrives later, on
 * its own event (`paper-fold.ts`) — and the tests below are about TRANSLATION
 * and GATES rather than about how a leg comes to exist, so they state the book
 * they mean instead of manufacturing it out of a lifecycle they are not
 * testing. `apps/api/test/engine-paper-lifecycle.test.ts` is where the leg
 * arriving by fill is proved.
 */
async function seedLeg(opts: { deskTag?: string; strike?: number; qty?: number } = {}): Promise<void> {
  const strike = opts.strike ?? 415
  const instrument = master().resolve(SYMBOL, EXPIRY, strike, 'CE')
  assert.notEqual(instrument, null)
  await store.saveBook(
    { tag: TAG, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY },
    [
      {
        deskTag: opts.deskTag ?? instrument!.tradingsymbol,
        instrument: instrument!,
        underlying: SYMBOL,
        expiry: EXPIRY,
        strike,
        type: 'CE',
        side: 'Sell',
        qty: opts.qty ?? -LOT,
        entryPrice: 12,
        openedTs: NOW - 86_400_000,
      },
    ],
    NOW,
    null,
  )
}

// ---------------------------------------------------------------- (a) open

itMongo('a valid paper open answers WORKING, queues the order, and books NOTHING yet', async () => {
  const req = request()
  const { status, body } = await post(req)

  assert.equal(status, 200)
  /**
   * `WORKING`, NOT `DONE` (D14). The orders are out and nothing has traded: a
   * maker quote is resting and its fills arrive on their own event. A
   * supervisor told DONE would form its next package against a book it already
   * has working.
   */
  assert.equal(body.status, 'WORKING')
  assert.equal(body.replayed, false)
  assert.equal(body.decisionId, req.decisionId)
  assert.deepEqual(body.skips, [])
  assert.deepEqual(body.routeErrors, [])
  assert.deepEqual(body.fills, [], 'nothing has traded at the moment of the request')

  // The order is queued for the gateway, marked paper, and carries the full
  // contract identity the supervisor named.
  const orders = await routedOrders()
  assert.equal(orders.length, 1)
  assert.equal(orders[0]?.['mode'], 'paper')
  assert.equal(orders[0]?.['state'], 'PENDING')
  assert.equal(orders[0]?.['tradingsymbol'], 'BHEL26AUG415CE')
  assert.equal(orders[0]?.['transaction_type'], 'SELL')
  assert.equal(orders[0]?.['quantity'], LOT)
  // The OLD instant-fill rail wrote here. Nothing does, on this path, any more.
  assert.equal(await handle!.db.collection(COLLECTIONS.paperTrade).countDocuments({}), 0)

  // And the book is untouched: a leg with no fill behind it is a phantom
  // position, and `close-all` over one sends a real order the other way.
  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])
})

// -------------------------------------------------------------- (b) replay

itMongo('the same decisionId re-posted replays — same answer, no second order', async () => {
  const req = request()
  const first = await post(req)
  const second = await post(req)

  assert.equal(second.status, 200)
  assert.equal(second.body.replayed, true)
  assert.equal(second.body.status, first.body.status)
  assert.equal(second.body.status, 'WORKING')
  assert.deepEqual(second.body.fills, first.body.fills)

  // The only witness that matters: exactly one order document exists.
  assert.equal((await routedOrders()).length, 1)
})

itMongo('a replay storm logs `engine decision applied` once, not once per re-post', async () => {
  // The weekend of 2026-10-03: three wedged packages re-posted ~1/sec each,
  // 35,904 identical lines in one rotated log. See `replay-log.ts`.
  const req = request()
  logged.length = 0
  await post(req) // fresh
  for (let i = 0; i < 20; i++) await post(req) // replays, within one interval
  const applied = logged.filter((l) => l.msg === 'engine decision applied')
  assert.deepEqual(
    applied.map((l) => l.ctx?.['replayed']),
    [false, true],
    'the fresh decision and the first replay are logged; the other 19 replays are not',
  )
})

// ------------------------------------------------------- (c) strategy gate

itMongo('a switched-off LIVE tag: the open is SKIPPED, and the exit GOES', async () => {
  // Seeded through the LIVE rail while the switch is on, so there is a real
  // position to exit from.
  const seeded = await post(request({ mode: 'live' }))
  assert.equal(seeded.body.status, 'DONE')
  assert.equal(seeded.body.fills.length, 1)

  await store.patchStrategy(TAG, { modes: { live: { enabled: false } } }, NOW + 1)

  const opened = await post(
    request({
      mode: 'live',
      actions: [{ op: 'open', instrument: 'BHEL26AUG420CE', side: 'Sell', qty: LOT }],
    }),
  )
  assert.equal(opened.status, 200)
  assert.equal(opened.body.fills.length, 0)
  assert.equal(opened.body.skips.length, 1)
  assert.equal(opened.body.skips[0]?.instrument, 'BHEL26AUG420CE')
  assert.match(opened.body.skips[0]?.reason ?? '', /switched off for live/)

  /**
   * THE EXIT PASSES BOTH GATES, AND REACHES THE WIRE.
   *
   * "Off" stops new exposure and must never refuse an exit (spec §9) — the
   * 2026-08-04 failure `gateStrategy`'s header describes. That gate has granted
   * the exemption for a long time; `LiveRail` did not, so a switched-off live
   * book's close passed the first gate and was refused by the second and landed
   * in `routeErrors`. This test used to pin exactly that, and named it "the
   * operational trap": switching a live tag off trapped the position it held.
   *
   * The rail runs its own version of the rule now, DERIVED from the stored legs
   * rather than claimed by the caller (`rail.ts:#exits`) — so the close routes,
   * folds, and the book comes back flat. The second gate is still a real gate:
   * the open above is refused by the FIRST one, and an order that grew the leg
   * would be refused by the rail even with the package claiming reduce-only.
   */
  const closed = await post(
    request({ mode: 'live', actions: [{ op: 'close', instrument: 'BHEL26AUG415CE' }] }),
  )
  assert.equal(closed.status, 200)
  assert.deepEqual(closed.body.skips, [])
  assert.deepEqual(closed.body.routeErrors, [], 'the rail no longer traps the exit')
  assert.equal(closed.body.status, 'DONE')
  assert.equal(closed.body.fills.length, 1)

  // And it is BOOKED closed, because the order really went out.
  const live = await store.loadBook(TAG, 'live')
  assert.equal(live.length, 0, 'the switched-off book got flat')
})

itMongo('a switched-off PAPER tag is refused new exposure and DOES exit', async () => {
  // The same gate, on the rail that has no second allowlist behind it — so this
  // is the exemption end to end: off stops new exposure, and lets go of what it
  // holds.
  await seedLeg()
  await store.patchStrategy(TAG, { modes: { paper: { enabled: false } } }, NOW + 1)

  const opened = await post(
    request({ actions: [{ op: 'open', instrument: 'BHEL26AUG420CE', side: 'Sell', qty: LOT }] }),
  )
  assert.equal(opened.body.fills.length, 0)
  assert.match(opened.body.skips[0]?.reason ?? '', /switched off for paper/)
  assert.equal((await routedOrders()).length, 0, 'the refused open reached no queue')

  /**
   * THE EXIT GOES OUT. "Off" stops new exposure and must never trap what the
   * book holds — and the evidence is now the ORDER, not a fill: it is WORKING,
   * with a BUY queued against the short leg. The leg leaves the book when that
   * order fills, which is the whole of D14.
   */
  const closed = await post(request({ actions: [{ op: 'close', instrument: 'BHEL26AUG415CE' }] }))
  assert.equal(closed.body.status, 'WORKING')
  assert.deepEqual(closed.body.skips, [])
  const orders = await routedOrders()
  assert.equal(orders.length, 1)
  assert.equal(orders[0]?.['transaction_type'], 'BUY')
  assert.equal(orders[0]?.['desk_op'], 'close')
})

itMongo('a STALE reduce-only claim is downgraded against the book applyDecision reads', async () => {
  /**
   * THE RACE THIS CLOSES. A caller derives "this package is purely an exit"
   * from a book it read, and `applyDecision` then reads its own, later. Between
   * them a leg can appear — a concurrent decision, a manual order, a repair
   * Apply — and a `resize` that was an exit against the caller's book is NEW
   * EXPOSURE against the one that actually exists.
   *
   * Simulated by simply LYING: the claim is passed as `true` for a package that
   * grows the position. If the flag were taken at face value it would carry
   * that growth straight past the switched-off row.
   *
   * Called on `applyDecision` DIRECTLY and with no `via`, so this exercises the
   * ORIGINAL synchronous path — which is exactly right: the reduce-only
   * downgrade is a gate, and D14 changed the lifecycle, not the gates.
   */
  await seedLeg()
  const book = await store.loadBook(TAG, 'paper')
  const tag = book[0]?.deskTag as string
  await store.patchStrategy(TAG, { modes: { paper: { enabled: false } } }, NOW + 1)

  const grown = await svc.applyDecision(
    {
      symbol: SYMBOL,
      expiry: EXPIRY,
      mode: 'paper',
      tag: TAG,
      decisionId: `${TAG}:paper:stale-claim`,
      // Absolute quantity, so this TRIPLES the leg.
      actions: [{ op: 'resize', ts: tag, qty: LOT * 3 }],
    },
    undefined,
    false,
    // The stale claim.
    true,
  )

  assert.equal(grown.fills.length, 0, 'a grow must not ride a reduce-only claim')
  assert.equal(grown.skips.length, 1)
  assert.match(grown.skips[0]?.reason ?? '', /switched off for paper/)
  assert.equal((await store.loadBook(TAG, 'paper'))[0]?.qty, -LOT)

  // AND THE EXEMPTION STILL WORKS when the claim is true of the real book —
  // the fix must downgrade a lie, not disable the feature.
  const shrunk = await svc.applyDecision(
    {
      symbol: SYMBOL,
      expiry: EXPIRY,
      mode: 'paper',
      tag: TAG,
      decisionId: `${TAG}:paper:honest-claim`,
      actions: [{ op: 'close', ts: tag }],
    },
    undefined,
    false,
    true,
  )
  assert.equal(shrunk.status, 'DONE')
  assert.equal(shrunk.fills.length, 1)
  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])
})

itMongo('a MIXED package is not an exit — one open in it refuses the whole thing', async () => {
  await seedLeg()
  await store.patchStrategy(TAG, { modes: { paper: { enabled: false } } }, NOW + 1)

  // All-or-nothing, because the gate is: `gateStrategy` judges the decision,
  // not the action, and a package carrying new exposure is not a flatten.
  const mixed = await post(
    request({
      actions: [
        { op: 'close', instrument: 'BHEL26AUG415CE' },
        { op: 'open', instrument: 'BHEL26AUG420CE', side: 'Sell', qty: LOT },
      ],
    }),
  )
  assert.equal(mixed.body.fills.length, 0)
  assert.equal(mixed.body.skips.length, 2)
  for (const s of mixed.body.skips) assert.match(s.reason, /switched off for paper/)
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1)
})

// ------------------------------------------------- (c2) execution dials (§8)

itMongo('the book’s execution dials reach the ORDER DOCUMENT the gateway reads', async () => {
  /**
   * The whole point of the field: `work_tranche_lots` decides how much of a
   * large order the market is shown at a time, and `chase_max_ms` /
   * `chase_cross_buffer_pct` are what the gateway's peg chaser works to. Until
   * this threading existed those dials were resolved by the supervisor, stored
   * on the book, displayed on the dials panel — and read by nobody on the order
   * path, which fell back to the gateway's env defaults on every order.
   */
  const { status, body } = await post(
    request({
      work: { trancheLots: 3, chaseMaxMs: 20_000, chaseCrossBufferPct: 0.004 },
      actions: [
        { op: 'open', instrument: 'BHEL26AUG415CE', side: 'Sell', qty: LOT, workMode: 'passive' },
      ],
    }),
  )
  assert.equal(status, 200)
  assert.equal(body.status, 'WORKING')

  const orders = await routedOrders()
  assert.equal(orders.length, 1)
  const doc = orders[0] as Record<string, unknown>
  assert.equal(doc['trancheLots'], 3)
  assert.equal(doc['chaseMaxMs'], 20_000)
  assert.equal(doc['chaseCrossBufferPct'], 0.004)
  assert.equal(doc['workMode'], 'passive')
})

itMongo('a package with NO dials writes none of them — absent is not zero', async () => {
  // Every order this desk has routed until now carries no dials, and a zero
  // would be read as a decision: "slice into nothing", "cross immediately".
  const { status } = await post(request())
  assert.equal(status, 200)
  const doc = (await routedOrders())[0] as Record<string, unknown>
  assert.equal('trancheLots' in doc, false)
  assert.equal('chaseMaxMs' in doc, false)
  assert.equal('chaseCrossBufferPct' in doc, false)
})

for (const [what, work] of [
  ['a zero tranche size', { trancheLots: 0 }],
  ['a fractional lot count', { trancheLots: 2.5 }],
  ['a zero chase deadline', { chaseMaxMs: 0 }],
  // 0.5 meaning "0.5 percent" is the mistake this bound is for: as a fraction
  // it reaches 50% through the touch. 5 would price an order at five times the
  // market.
  ['a cross buffer stated as a percentage', { chaseCrossBufferPct: 5 }],
  ['dials that are not an object', 'aggressive'],
] as const) {
  itMongo(`${what} is refused at the door, and nothing is written`, async () => {
    const { status, body } = await post({ ...request(), work })
    assert.equal(status, 400)
    assert.match(body.error ?? '', /work/)
    assert.equal((await routedOrders()).length, 0)
    assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({}), 0)
  })
}

// ------------------------------------------------------------ (d) refusals

itMongo('a malformed action is refused with a 400 and writes NOTHING', async () => {
  const { status, body } = await post({
    ...request(),
    actions: [{ op: 'open', instrument: 'BHEL26AUG415CE', side: 'Short', qty: LOT }],
  })

  assert.equal(status, 400)
  assert.match(body.error ?? '', /side/)

  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({}), 0)
  assert.equal(await handle!.db.collection(ENGINE_DECISIONS_COLLECTION).countDocuments({}), 0)
  assert.equal((await routedOrders()).length, 0)
  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])
})

itMongo('a decisionId that does not carry its own mode is refused', async () => {
  // The mode is in the id so a paper replay can never suppress a live order.
  const { status, body } = await post({ ...request(), decisionId: 'DESK_BHEL:7' })
  assert.equal(status, 400)
  assert.match(body.error ?? '', /decisionId/)
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({}), 0)
})

itMongo('an UNREGISTERED tag fails loudly with a 403, not a 200 that looks like a pause', async () => {
  // A tag with no strategy row has no switch in the portal, so it cannot be
  // fixed from the page an operator is looking at — it must not come back
  // looking like "switched off, will resume later".
  const { status, body } = await post(
    request({ tag: 'DESK_NOT_A_BOOK', mode: 'paper' }),
  )
  assert.equal(status, 403)
  assert.match(body.error ?? '', /not registered/)
  assert.equal((await routedOrders()).length, 0)
})

itMongo('an open on a contract the book already holds is REFUSED, never doubled', async () => {
  await seedLeg()
  const again = await post(request())

  assert.equal(again.body.fills.length, 0)
  assert.equal(again.body.skips.length, 1)
  assert.equal(again.body.skips[0]?.instrument, 'BHEL26AUG415CE')
  assert.match(again.body.skips[0]?.reason ?? '', /already open/)
  // ONE leg, at its original size. A second leg on the same contract is the
  // state the engine wire — which addresses contracts — could never name again.
  const bk = await store.loadBook(TAG, 'paper')
  assert.equal(bk.length, 1)
  assert.equal(bk[0]?.qty, -LOT)
})

/**
 * THE ADD FLAG, END TO END — wire request through to the stored leg.
 *
 * The sibling above pins the never-doubled rule: an UNMARKED open on a held
 * contract must never grow the book. This is the one exception, and it exists
 * because `phaseShed` accumulates — it re-picks the best strike and sells more
 * of it, held or not, exactly as the legacy did.
 *
 * IT IS TESTED HERE, AT THE WIRE, on purpose. The flag crosses two shapes on
 * its way in — the parsed wire action and the `DeskAction` `applyActions`
 * actually reads — and the first cut of this fix carried it onto the first and
 * not the second. Everything passed: the shed set the flag, the wire carried
 * it, `book.ts` merged when handed one, and production changed nothing at all,
 * because the field was dropped in between. Only a test that spans the whole
 * hop can catch that.
 */
itMongo('an open MARKED as an add grows the held leg, all the way from the wire', async () => {
  // LIVE, because that is the rail where `applyActions` writes the leg at route
  // time. On paper the engine route only answers WORKING and `paper-fold.ts`
  // builds the leg when the gateway's fill lands, so a paper assertion here
  // would pass on an empty book and prove nothing about the merge.
  const first = await post(
    request({
      mode: 'live',
      actions: [{ op: 'open', instrument: 'BHEL26AUG420CE', side: 'Sell', qty: LOT }],
    }),
  )
  assert.equal(first.body.status, 'DONE')

  const again = await post(
    request({
      mode: 'live',
      actions: [{ op: 'open', instrument: 'BHEL26AUG420CE', side: 'Sell', qty: LOT, add: true }],
    }),
  )

  assert.deepEqual(again.body.skips, [], 'a marked add must not be skipped')
  const legs = await store.loadBook(TAG, 'live')
  assert.equal(legs.length, 1, 'still ONE leg for the tag')
  assert.equal(legs[0]?.qty, -2 * LOT, 'the leg GREW by the added quantity')
})

/**
 * BOTH ORDERINGS, because they fail differently and only one of them is
 * obvious. `[open X, close X]` merely swaps the two actions' prices; the
 * dangerous one is `[close X, open X]`, where `applyActions` mutates its book
 * as it walks the list, so the open no longer sees the leg the close removed —
 * the duplicate-tag refusal never fires and the contract is re-derived from a
 * leg that was deleted a step earlier.
 */
for (const [name, dupes] of [
  [
    'close-then-open',
    [
      { op: 'close', instrument: 'BHEL26AUG415CE' },
      { op: 'open', instrument: 'BHEL26AUG415CE', side: 'Sell', qty: LOT, limitPrice: 9.9 },
    ],
  ],
  [
    'open-then-close',
    [
      { op: 'open', instrument: 'BHEL26AUG415CE', side: 'Sell', qty: LOT, limitPrice: 9.9 },
      { op: 'close', instrument: 'BHEL26AUG415CE' },
    ],
  ],
] as const) {
  itMongo(`a package naming one contract twice (${name}) is REFUSED whole`, async () => {
    // A real leg to collapse onto: the failure needs the book to hold it.
    await seedLeg()
    const before = await store.loadBook(TAG, 'paper')
    assert.equal(before.length, 1)

    const { status, body } = await post({ ...request(), actions: dupes })

    assert.equal(status, 400)
    assert.match(body.error ?? '', /more than once/)
    assert.match(body.error ?? '', /BHEL26AUG415CE/)

    // Nothing written, anywhere: no order queued, no decision claimed, no
    // engine journal row, and the book untouched.
    assert.equal((await routedOrders()).length, 0)
    assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({}), 0)
    assert.equal(await handle!.db.collection(ENGINE_DECISIONS_COLLECTION).countDocuments({}), 0)
    assert.deepEqual(await store.loadBook(TAG, 'paper'), before)
  })
}

itMongo('only a machine principal may post a decision package', async () => {
  const { status } = await post(request(), USER_TOKEN)
  assert.equal(status, 403)
  assert.equal((await routedOrders()).length, 0)
})

// ------------------------------------------------- (e) workMode/limitPrice

itMongo('workMode and limitPrice reach the ROUTED ORDER DOCUMENT', async () => {
  const { body } = await post(
    request({
      actions: [
        {
          op: 'open',
          instrument: 'BHEL26AUG415CE',
          side: 'Sell',
          qty: LOT,
          limitPrice: 12.45,
          workMode: 'passive',
        },
      ],
    }),
  )
  assert.equal(body.status, 'WORKING')

  const orders = await routedOrders()
  assert.equal(orders.length, 1)
  const doc = orders[0] as Record<string, unknown>
  // Decorating the RESPONSE is not enough — the rail writes this document
  // during the routing loop, so the price has to be on the fill before it goes.
  assert.equal(doc['order_type'], 'LIMIT')
  assert.equal(doc['limitPrice'], 12.45)
  // Read by the gateway's peg chaser: a passive order joins the touch instead
  // of crossing it.
  assert.equal(doc['workMode'], 'passive')
})

itMongo('an action with NO workMode is PASSIVE — the wire says absent means passive-first', async () => {
  const { body } = await post(request())
  assert.equal(body.status, 'WORKING')
  const doc = (await routedOrders())[0] as Record<string, unknown>
  // Still priced to fill — the marketable-limit fallback is untouched by the
  // label, and with no `limitPrice` this is the MARKET branch as before.
  assert.equal(doc['order_type'], 'MARKET')
  /**
   * PASSIVE, NOT ABSENT. Dropping it inverted the contract: an unlabelled fill
   * reaches the gateway looking like every order this desk has ever placed and
   * gets chased across the spread — the opposite of what the supervisor asked
   * for by saying nothing.
   */
  assert.equal(doc['workMode'], 'passive')
})

itMongo('an urgent action keeps URGENT — the default never overwrites a choice', async () => {
  await post(
    request({
      actions: [
        { op: 'open', instrument: 'BHEL26AUG415CE', side: 'Sell', qty: LOT, workMode: 'urgent' },
      ],
    }),
  )
  const doc = (await routedOrders())[0] as Record<string, unknown>
  assert.equal(doc['workMode'], 'urgent')
})

// ------------------------------------------------ translation, by contract

itMongo('an instrument the master cannot name is skipped BY NAME, and nothing routes', async () => {
  const { status, body } = await post(
    request({ actions: [{ op: 'open', instrument: 'BHEL26AUG999CE', side: 'Sell', qty: LOT }] }),
  )
  assert.equal(status, 200)
  assert.equal(body.fills.length, 0)
  assert.equal(body.skips.length, 1)
  assert.equal(body.skips[0]?.instrument, 'BHEL26AUG999CE')
  assert.equal((await routedOrders()).length, 0)
})

itMongo('a contract from ANOTHER expiry is refused, never re-resolved onto this book', async () => {
  const { body } = await post(
    request({ actions: [{ op: 'open', instrument: 'BHEL26SEP415CE', side: 'Sell', qty: LOT }] }),
  )
  assert.equal(body.fills.length, 0)
  assert.equal(body.skips.length, 1)
  assert.equal(body.skips[0]?.instrument, 'BHEL26SEP415CE')
  assert.match(body.skips[0]?.reason ?? '', /2026-09-29/)
  assert.deepEqual(await store.loadBook(TAG, 'paper'), [])
})

itMongo('a close finds the BOOK\'S OWN leg tag for the named instrument', async () => {
  // A leg tagged the way the Python desk tagged them — the shape every carried
  // book on this desk still holds.
  await store.saveBook(
    { tag: TAG, mode: 'paper', symbol: SYMBOL, expiry: EXPIRY },
    [
      {
        deskTag: 'CE415#0',
        instrument: master().resolve(SYMBOL, EXPIRY, 415, 'CE')!,
        underlying: SYMBOL,
        expiry: EXPIRY,
        strike: 415,
        type: 'CE',
        side: 'Sell',
        qty: -LOT,
        entryPrice: 14,
        openedTs: NOW - 86_400_000,
      },
    ],
    NOW,
    null,
  )

  const { body } = await post(
    request({ actions: [{ op: 'close', instrument: 'BHEL26AUG415CE' }] }),
  )
  assert.equal(body.status, 'WORKING')
  /**
   * THE LEG TAG IS ON THE ROUTED ORDER, which is where it has to be right: the
   * Python desk's `translate.reconcile` keys every fill on `desk_tag`, and the
   * whole point of looking it up in the book is that a carried leg is still
   * called `CE415#0` and not by its tradingsymbol.
   */
  const orders = await routedOrders()
  assert.equal(orders.length, 1)
  assert.equal(orders[0]?.['tradingsymbol'], 'BHEL26AUG415CE')
  assert.equal(orders[0]?.['desk_tag'], 'CE415#0')
  assert.equal(orders[0]?.['transaction_type'], 'BUY')
  // The leg is still there. It leaves when the close FILLS, not when it routes.
  assert.equal((await store.loadBook(TAG, 'paper')).length, 1)
})

itMongo('a resize is the ABSOLUTE new quantity, in contracts', async () => {
  await seedLeg({ qty: -LOT * 3 })
  const { body } = await post(
    request({ actions: [{ op: 'resize', instrument: 'BHEL26AUG415CE', targetQty: LOT }] }),
  )
  assert.equal(body.status, 'WORKING')
  // A DELTA on the wire to the broker — buy back two of the three lots — even
  // though the wire's own `targetQty` is absolute. Getting this backwards is
  // how a resize to 1 lot buys back one and leaves two.
  const orders = await routedOrders()
  assert.equal(orders.length, 1)
  assert.equal(orders[0]?.['quantity'], LOT * 2)
  assert.equal(orders[0]?.['transaction_type'], 'BUY')
  assert.equal(orders[0]?.['desk_op'], 'resize')
})

// ------------------------------------------------ (e2) the delta-lean stamp

/**
 * THE LEAN ID HAS TO CROSS THIS BOUNDARY.
 *
 * The delta-lean controller selects the legs of its current bet by the stamp it
 * put on them. This module is the hop where a `WireAction`'s `leanId` becomes an
 * `OpenAction`'s and then a stored leg's; a translation that dropped it would
 * leave every lean reading as flat — never adding on a winner, never cutting on
 * a loser — with no error anywhere to say so.
 *
 * Proved on the LIVE rail because that is the rail that books the leg inside the
 * request. The paper rail answers WORKING and folds when the gateway's fill
 * lands (`paper-fold.ts`), which is a different writer and a different ticket.
 */
itMongo('a live open carrying a lean id books a leg that carries it', async () => {
  const { body } = await post(
    request({
      mode: 'live',
      actions: [{ op: 'open', instrument: 'BHEL26AUG420CE', side: 'Buy', qty: LOT, leanId: 'dl-up-123' }],
    }),
  )
  assert.equal(body.status, 'DONE')
  const legs = await store.loadBook(TAG, 'live')
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.leanId, 'dl-up-123')
})

itMongo('a live open with no lean id books a leg with NO such key', async () => {
  // Every recenter open looks like this. An explicit `undefined` would be stored
  // as null and read back as a value, so the key must not be written at all.
  const { body } = await post(
    request({ mode: 'live', actions: [{ op: 'open', instrument: 'BHEL26AUG420CE', side: 'Buy', qty: LOT }] }),
  )
  assert.equal(body.status, 'DONE')
  const legs = await store.loadBook(TAG, 'live')
  assert.equal(legs.length, 1)
  assert.equal('leanId' in (legs[0] as object), false)
})

itMongo('a lean id that is not a usable string is REFUSED at the door', async () => {
  // It is persisted verbatim and read back as the identity of a bet, so it is
  // validated like every other field here rather than trusted. '' is refused as
  // a VALUE: "no lean" is spelled by omitting the key.
  for (const leanId of [7, '', 'x'.repeat(129)]) {
    const bad = await post(
      request({
        actions: [{ op: 'open', instrument: 'BHEL26AUG415CE', side: 'Sell', qty: LOT, leanId } as never],
      }),
    )
    assert.equal(bad.status, 400, `leanId ${JSON.stringify(leanId)} must not be accepted`)
    assert.match(bad.body.error ?? '', /leanId/)
  }
})

// -------------------------------------------------------- (f) the journals

itMongo('both journals are written — the desk ledger AND the engine\'s own words', async () => {
  const req = request()
  await post(req)

  // `desk-decisions` is what P&L reads; it speaks desk actions.
  const decision = await handle!.db
    .collection(COLLECTIONS.decisions)
    .findOne({ decisionId: req.decisionId })
  assert.notEqual(decision, null)
  assert.equal(decision?.['tag'], TAG)

  // `desk-engine-decisions` keeps the REQUEST as the supervisor phrased it —
  // instruments and share quantities — which the translation above discards.
  const engine = await handle!.db
    .collection(ENGINE_DECISIONS_COLLECTION)
    .findOne({ decisionId: req.decisionId })
  assert.notEqual(engine, null)
  assert.equal(engine?.['trigger'], 'shift')
  assert.equal(engine?.['reason'], 'band breached on the upside')
  assert.deepEqual(engine?.['actions'], req.actions)
  assert.equal((engine?.['response'] as DecisionResponse | undefined)?.status, 'WORKING')
})

itMongo('a replay adds no second engine journal row, only a retry count', async () => {
  const req = request()
  await post(req)
  await post(req)
  await post(req)

  const rows = await handle!.db
    .collection(ENGINE_DECISIONS_COLLECTION)
    .find({ decisionId: req.decisionId })
    .toArray()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.['posts'], 3)
  // The stored response is the ORIGINAL outcome, not a replay's echo.
  assert.equal((rows[0]?.['response'] as DecisionResponse | undefined)?.replayed, false)
})

// ---------------------------------------------------- the supervisor nudge

/**
 * NO MONGO NEEDED, and these run even on a laptop with none — which is the
 * point. `notifySupervisor` is the one thing in this ticket whose whole
 * contract is "it cannot fail its caller", and that promise has to be provable
 * without a database standing between the test and the assertion.
 */

interface Captured {
  readonly url: string
  readonly body: unknown
  readonly auth: string | undefined
}

function captureFetch(answer: () => Promise<Response>): {
  calls: Captured[]
  fetch: typeof globalThis.fetch
} {
  const calls: Captured[] = []
  const fetch = (async (url: unknown, init: unknown) => {
    const opts = (init ?? {}) as { body?: string; headers?: Record<string, string> }
    calls.push({
      url: String(url),
      body: opts.body === undefined ? undefined : JSON.parse(opts.body),
      auth: opts.headers?.['authorization'],
    })
    return await answer()
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const okResponse = async (): Promise<Response> => new Response('', { status: 204 })

test('the nudge names the kind and the book, on loopback, at the given port', async () => {
  resetNudgeLog()
  const { calls, fetch } = captureFetch(okResponse)
  await notifySupervisor(
    'dials',
    { tag: 'DESK_BHEL', mode: 'live' },
    { log: () => {}, fetch, port: 8899, token: 'machine-bearer' },
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, `http://127.0.0.1:8899${NUDGE_PATH}`)
  // The kind and the book, and NOTHING that could be mistaken for an
  // instruction: the supervisor re-reads the truth from Mongo.
  assert.deepEqual(calls[0]?.body, { kind: 'dials', tag: 'DESK_BHEL', mode: 'live' })
  assert.equal(calls[0]?.auth, 'Bearer machine-bearer')
})

test('a call site that passes NO token still presents DESK_API_TOKEN', async () => {
  /**
   * The credential is defaulted in the notifier, not at each call site, so a
   * future nudge (fills, registry) cannot ship unauthenticated because someone
   * forgot an argument. `routes/books.ts` passes none and is authenticated.
   */
  resetNudgeLog()
  const saved = process.env['DESK_API_TOKEN']
  process.env['DESK_API_TOKEN'] = 'desk-api-machine-token'
  try {
    const { calls, fetch } = captureFetch(okResponse)
    await notifySupervisor('registry', { tag: 'DESK_BHEL' }, { log: () => {}, fetch, port: 8899 })
    assert.equal(calls[0]?.auth, 'Bearer desk-api-machine-token')
  } finally {
    if (saved === undefined) delete process.env['DESK_API_TOKEN']
    else process.env['DESK_API_TOKEN'] = saved
  }
})

test('an EMPTY token sends no authorization header, not an empty one', async () => {
  // The honest state for a deployment that never set the variable: the nudge
  // carries no instructions and the port is loopback, so unauthenticated is
  // degraded rather than dangerous.
  resetNudgeLog()
  const { calls, fetch } = captureFetch(okResponse)
  await notifySupervisor(
    'registry',
    { tag: 'DESK_BHEL' },
    { log: () => {}, fetch, port: 8899, token: '' },
  )
  assert.equal(calls[0]?.auth, undefined)
})

test('a supervisor that is DOWN cannot fail the write that prompted the nudge', async () => {
  resetNudgeLog()
  const logged: string[] = []
  const { fetch } = captureFetch(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:8893')
  })
  // Resolves. It does not reject, and it does not throw synchronously.
  await notifySupervisor(
    'dials',
    { tag: 'DESK_BHEL' },
    { log: (m) => logged.push(m), fetch, port: 8899 },
  )
  assert.equal(logged.length, 1)
  assert.match(logged[0] ?? '', /the change is saved/)
})

test('an HTTP error is complained about, once a minute and no more', async () => {
  resetNudgeLog()
  const logged: string[] = []
  const { fetch } = captureFetch(async () => new Response('nope', { status: 500 }))
  let clock = 1_000_000
  const deps = { log: (m: string) => logged.push(m), fetch, port: 8899, now: () => clock }

  await notifySupervisor('fill', { tag: 'A' }, deps)
  await notifySupervisor('fill', { tag: 'A' }, deps)
  // A supervisor that is down produces one event per write; a line per failure
  // would bury the errors that actually matter.
  assert.equal(logged.length, 1)

  clock += 61_000
  await notifySupervisor('fill', { tag: 'A' }, deps)
  assert.equal(logged.length, 2)
})

test('a supervisor that accepts and then HANGS is abandoned, not waited on', async () => {
  resetNudgeLog()
  const logged: string[] = []
  const fetch = (async (_url: unknown, init: unknown) => {
    const signal = (init as { signal?: AbortSignal }).signal
    // Never resolves on its own — only the abort ends this.
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }) as typeof globalThis.fetch

  const started = Date.now()
  await notifySupervisor(
    'dials',
    { tag: 'A' },
    { log: (m) => logged.push(m), fetch, port: 8899, timeoutMs: 30 },
  )
  assert.ok(Date.now() - started < 2000, 'the timeout, not the supervisor, decides when this ends')
  assert.equal(logged.length, 1)
})
