/**
 * `applyDecision`'s replay contract — the crash window, and the race into it.
 *
 * THE ARGUMENT THIS FILE DEFENDS. A decision record is written BEFORE anything
 * routes, because losing an order loudly beats duplicating one silently. The
 * price of that choice is a window in which a claim exists and its outcome does
 * not, and every caller that retries under the same decisionId lands in it. So
 * the replay has to be honest in three states, not two:
 *
 *   - `DONE`    — the stored fills reached a rail.
 *   - `FAILED`  — some or all of them did not.
 *   - `ROUTING` — we do not know yet, and we say so.
 *
 * Two defects lived here, both answering the third state with the first:
 *
 *   A1. The duplicate-key branch — the loser of an insert race — hard-coded
 *       `status: 'DONE'` beside the winner's fields. Process A claims a decision
 *       and dies mid-route; process B loses the race and answered
 *       `{status: 'DONE', fills: [...]}`. The desk booked legs of which zero had
 *       routed.
 *   A2. The plain replay returned the record's fills with no `indeterminate`
 *       flag, no reconciliation and no staleness window, so a `ROUTING` record
 *       read as a completed decision for as long as it sat there.
 *
 * `/v1/desk/submit` had already been fixed for exactly this and the two paths
 * share the same crash window, so this uses the same mechanism: a fresh claim
 * answers INDETERMINATE, and a stale one is reconciled against the rail's own
 * order collection, which is the only witness a dead process leaves behind.
 *
 * Everything runs against an in-memory `Database` fake. The fake models the two
 * behaviours the argument rests on — the UNIQUE index on `decisionId` (the
 * idempotency lock is a lock, not a read-then-write) and the fact that
 * `rail.route` succeeding means a document exists in the order collection.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { BridgeService } from '../src/service.ts'
import { StaticMarks } from '../src/marks.ts'
import { ROUTING_STALE_MS } from '../src/submit.ts'
import {
  COLLECTIONS,
  DeskStore,
  type Collection,
  type Database,
  type FindCursor,
  type UpdateOutcome,
} from '../src/store.ts'
import type { ActionsRequest, DeskMode, Fill } from '../src/contract.ts'
import type { OrderRail, RouteContext } from '../src/rail.ts'

// ------------------------------------------------------------------ fixtures

const SYMBOL = 'BANKNIFTY'
const EXPIRY = '2026-07-30'
const TAG = 'DESK_BANKNIFTY'
const MODE: DeskMode = 'paper'
const LOT = 35
const T0 = Date.UTC(2026, 6, 27, 6, 30)

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of [56_000, 56_500, 57_000]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: strike + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BANKNIFTY26JUL${strike}${type}`,
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
  {
    BANKNIFTY26JUL57000CE: 120,
    BANKNIFTY26JUL56000PE: 95,
    BANKNIFTY26JUL56500CE: 180,
  },
  { BANKNIFTY: 56_480 },
)

// ------------------------------------------------------------- the db fake

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, want]) => {
    const got = doc[k]
    if (typeof want !== 'object' || want === null || Array.isArray(want)) return got === want
    return Object.entries(want as Record<string, unknown>).every(([op, v]) => {
      switch (op) {
        case '$gte':
          return Number(got) >= Number(v)
        case '$lt':
          return Number(got) < Number(v)
        default:
          // Never `return false`: answering "no rows" to an operator the fake
          // does not implement is indistinguishable from a real empty result.
          throw new Error(`fake db: unsupported operator ${op}`)
      }
    })
  })
}

class FakeCursor<T extends Record<string, unknown>> implements FindCursor<T> {
  #rows: T[]
  constructor(rows: T[]) {
    this.#rows = rows
  }
  sort(spec: Record<string, 1 | -1>): FindCursor<T> {
    const [key, dir] = Object.entries(spec)[0] ?? ['', 1 as const]
    this.#rows = this.#rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const av = Number(a.r[key] ?? 0)
        const bv = Number(b.r[key] ?? 0)
        return av === bv ? a.i - b.i : (av < bv ? -1 : 1) * (dir === -1 ? -1 : 1)
      })
      .map((x) => x.r)
    return this
  }
  limit(n: number): FindCursor<T> {
    this.#rows = this.#rows.slice(0, n)
    return this
  }
  skip(n: number): FindCursor<T> {
    this.#rows = this.#rows.slice(n)
    return this
  }
  async toArray(): Promise<T[]> {
    return this.#rows
  }
}

class FakeCollection<T extends Record<string, unknown>> implements Collection<T> {
  readonly docs: T[] = []
  #unique: string | null = null

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.docs.find((d) => matches(d, filter)) ?? null
  }
  find(filter: Record<string, unknown>): FindCursor<T> {
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)))
  }
  async insertOne(doc: T): Promise<unknown> {
    // The unique index IS the idempotency lock; the fake throws 11000 exactly
    // as the driver does, or every concurrency claim here would be vacuous.
    if (this.#unique !== null) {
      const key = this.#unique
      if (this.docs.some((d) => d[key] === doc[key])) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
      }
    }
    this.docs.push(structuredClone(doc))
    return {}
  }
  async insertMany(docs: readonly T[]): Promise<unknown> {
    for (const d of docs) await this.insertOne(d)
    return {}
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<UpdateOutcome> {
    const i = this.docs.findIndex((d) => matches(d, filter))
    const set = (update['$set'] ?? {}) as Record<string, unknown>
    if (i < 0) {
      if (options?.upsert === true) this.docs.push(structuredClone({ ...filter, ...set }) as T)
      return { matchedCount: 0 }
    }
    this.docs[i] = structuredClone({ ...this.docs[i], ...set }) as T
    return { matchedCount: 1 }
  }
  async deleteOne(filter: Record<string, unknown>): Promise<unknown> {
    const i = this.docs.findIndex((d) => matches(d, filter))
    if (i >= 0) this.docs.splice(i, 1)
    return {}
  }
  async deleteMany(): Promise<unknown> {
    this.docs.length = 0
    return {}
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length
  }
  async createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown> {
    if (options?.unique === true) this.#unique = Object.keys(spec)[0] ?? null
    return {}
  }

  async dropIndex(): Promise<unknown> {
    return {}
  }
}

class FakeDb implements Database {
  readonly collections = new Map<string, FakeCollection<Record<string, unknown>>>()
  collection<T = Record<string, unknown>>(name: string): Collection<T> {
    let c = this.collections.get(name)
    if (c === undefined) {
      c = new FakeCollection()
      this.collections.set(name, c)
    }
    return c as unknown as Collection<T>
  }
  docs(name: string): Record<string, unknown>[] {
    return this.collections.get(name)?.docs ?? []
  }
}

/**
 * A rail that WRITES its order document, exactly as the real ones do, and that
 * can be held open mid-route.
 *
 * The write is what makes the reconcile tests mean anything: `route` succeeding
 * means "a document with this clientOrderId is in the order collection", and
 * that document is the only evidence a replay has after the process that
 * claimed the decision dies. The hold is what makes the RACE deterministic
 * instead of a matter of how the microtask queue happened to interleave.
 */
class HoldableRail implements OrderRail {
  readonly routed: { fill: Fill; ctx: RouteContext }[] = []
  readonly failFor = new Set<string>()
  readonly mode: 'paper' | 'live'
  readonly collection: string
  /** Resolved by the test to let a held route proceed. */
  hold: Promise<void> | null = null
  /** Resolves the first time a route is entered. */
  readonly entered: Promise<void>
  #enter!: () => void
  readonly #db: FakeDb

  constructor(mode: 'paper' | 'live', db: FakeDb) {
    this.mode = mode
    this.#db = db
    this.collection = mode === 'live' ? COLLECTIONS.gatewayOrders : COLLECTIONS.paperTrade
    this.entered = new Promise<void>((r) => {
      this.#enter = r
    })
  }

  async route(fill: Fill, ctx: RouteContext): Promise<void> {
    this.#enter()
    if (this.hold !== null) await this.hold
    if (this.failFor.has(fill.tradingsymbol)) throw new Error(`rail refused ${fill.tradingsymbol}`)
    await this.#db.collection(this.collection).insertOne({
      clientOrderId: ctx.clientOrderId,
      tradingsymbol: fill.tradingsymbol,
      quantity: fill.qty,
      price: fill.price,
    })
    this.routed.push({ fill, ctx })
  }
}

// ------------------------------------------------------------------ harness

let db: FakeDb
let store: DeskStore
let paper: HoldableRail
let live: HoldableRail
let clockMs: number
let svc: BridgeService

beforeEach(async () => {
  db = new FakeDb()
  store = new DeskStore(db)
  await store.ensureIndexes()
  paper = new HoldableRail('paper', db)
  live = new HoldableRail('live', db)
  clockMs = T0
  svc = new BridgeService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    clock: { now: () => clockMs },
  })
  await store.registerStrategy(
    { tag: TAG, kind: 'external', modes: { paper: { enabled: true }, live: { enabled: true } } },
    T0,
  )
})

const request = (over: Partial<ActionsRequest> = {}): ActionsRequest => ({
  symbol: SYMBOL,
  expiry: EXPIRY,
  mode: MODE,
  tag: TAG,
  decisionId: 'd-1',
  actions: [
    { op: 'open', ts: 'CE57000#0', strike: 57_000, type: 'CE', side: 'Sell', qty: 5 * LOT },
  ],
  ...over,
})

const threeLegs: ActionsRequest['actions'] = [
  { op: 'open', ts: 'CE57000#0', strike: 57_000, type: 'CE', side: 'Sell', qty: 5 * LOT },
  { op: 'open', ts: 'PE56000#1', strike: 56_000, type: 'PE', side: 'Sell', qty: 5 * LOT },
  { op: 'open', ts: 'CE56500#2', strike: 56_500, type: 'CE', side: 'Buy', qty: 5 * LOT },
]

/** The record as it sits on disk, for assertions about the claim itself. */
function stored(decisionId = 'd-1'): Record<string, unknown> | undefined {
  return db.docs(COLLECTIONS.decisions).find((d) => d['decisionId'] === decisionId)
}

// ------------------------------------------------------- A1: the insert race

/**
 * Force the caller down the DUPLICATE-KEY branch specifically.
 *
 * That branch is only reachable when a process reads "not seen" and another
 * process inserts before it does — a window a test cannot open by simply
 * racing two calls, because the loser's own opening read usually finds the
 * winner's record and takes the ordinary replay path instead. Blinding exactly
 * one `getDecision` reproduces the race deterministically, and it is the real
 * shape of it: the read genuinely happened before the insert.
 */
function blindTheNextRead(): void {
  const real = store.getDecision.bind(store)
  let blind = true
  ;(store as unknown as { getDecision: typeof real }).getDecision = async (id: string) => {
    if (blind) {
      blind = false
      return null
    }
    return await real(id)
  }
}

test('the LOSER of an insert race reports the winner’s REAL status, not DONE', async () => {
  /**
   * Process A has claimed `d-1` and is inside its routing loop — the claim on
   * disk, `fills: []`, status ROUTING. Process B loses the race.
   *
   * The old branch hard-coded `status: 'DONE'` beside the winner's fields, so B
   * answered `{status: 'DONE', fills: [...]}` for a decision of which nothing
   * had routed. The desk books those legs; a `close-all` over them then places
   * REAL orders in the opposite direction and opens a position nobody asked for.
   */
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-1',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    fills: [],
    plannedFills: [
      { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
      { op: 'open', deskTag: 'PE56000#1', tradingsymbol: 'BANKNIFTY26JUL56000PE', side: 'Sell', qty: 5 * LOT, price: 95, ts: T0 },
      { op: 'open', deskTag: 'CE56500#2', tradingsymbol: 'BANKNIFTY26JUL56500CE', side: 'Buy', qty: 5 * LOT, price: 180, ts: T0 },
    ],
    skips: [],
    createdAt: T0,
    status: 'ROUTING',
  })
  blindTheNextRead()

  const loser = await svc.applyDecision(request({ actions: threeLegs }))

  assert.equal(loser.replayed, true)
  assert.equal(loser.status, 'ROUTING', 'the claim exists and its outcome is not known')
  assert.equal(loser.indeterminate, true)
  assert.deepEqual(loser.fills, [], 'nothing may be booked from a decision that has not reported')
  assert.match(String(loser.reason), /UNKNOWN/)
  assert.match(String(loser.reason), /Retry the SAME decisionId/)
  // The plan is carried, but under a name nothing books from.
  assert.equal(loser.plannedFills?.length, 3)
  assert.equal(paper.routed.length, 0, 'and the loser routed nothing — that is the whole point')
  assert.equal(db.docs(COLLECTIONS.decisions).length, 1, 'one claim, not two')
})

test('the loser of a race against a FINISHED winner reports the winner’s DONE result', async () => {
  // The same branch, on the other side of the window: by the time the loser
  // reads back, the winner has routed and resolved. `DONE` is then the TRUTH
  // rather than an assumption, and the fills it carries are real.
  const winner = await svc.applyDecision(request())
  assert.equal(winner.status, 'DONE')

  blindTheNextRead()
  const loser = await svc.applyDecision(request())
  assert.equal(loser.replayed, true)
  assert.equal(loser.status, 'DONE')
  assert.equal(loser.indeterminate, undefined)
  assert.equal(loser.fills.length, 1)
  assert.equal(paper.routed.length, 1, 'the race produced exactly ONE order')
})

test('a genuinely concurrent pair produces one set of orders and no invented status', async () => {
  // No blinding: whichever way the two interleave, neither may answer with a
  // status it did not observe.
  let release = (): void => {}
  paper.hold = new Promise<void>((r) => {
    release = r
  })
  const a = svc.applyDecision(request({ actions: threeLegs }))
  const b = svc.applyDecision(request({ actions: threeLegs }))
  // The loser never routes, so it settles while the winner is still held.
  const first = await Promise.race([a, b])
  assert.equal(first.replayed, true)
  assert.equal(first.status, 'ROUTING')
  assert.deepEqual(first.fills, [])

  release()
  const both = await Promise.all([a, b])
  assert.equal(both.filter((r) => !r.replayed).length, 1, 'exactly one applied')
  assert.equal(paper.routed.length, 3, 'and exactly one set of orders reached the rail')
})

test('once the winner finishes, the same replay reports DONE with its fills', async () => {
  const first = await svc.applyDecision(request())
  assert.equal(first.status, 'DONE')
  const second = await svc.applyDecision(request())
  assert.equal(second.replayed, true)
  assert.equal(second.status, 'DONE')
  assert.equal(second.indeterminate, undefined)
  assert.deepEqual(
    second.fills.map((f) => f.tradingsymbol),
    ['BANKNIFTY26JUL57000CE'],
  )
  assert.equal(paper.routed.length, 1, 'a replay routes nothing')
})

test('a replay of a FAILED decision reports FAILED and carries its routeErrors', async () => {
  paper.failFor.add('BANKNIFTY26JUL57000CE')
  const first = await svc.applyDecision(request())
  assert.equal(first.status, 'FAILED')

  const replay = await svc.applyDecision(request())
  assert.equal(replay.status, 'FAILED', 'a replay must not launder a failure into a success')
  assert.deepEqual(replay.fills, [], 'nothing routed, so nothing is a position')
  assert.equal(replay.routeErrors.length, 1, 'and the caller can still see WHY')
})

// -------------------------------------------------- A2: the ROUTING window

test('a FRESH ROUTING record is indeterminate — reconciling mid-flight would lie', async () => {
  /**
   * Below `ROUTING_STALE_MS` the record most likely belongs to a request that is
   * alive and mid-loop right now. Reading the order collection here would see
   * leg 0 routed and leg 1 missing microseconds before leg 1 routes, and report
   * a partial that is about to become whole — a worse answer than "unknown",
   * because the caller books half a position and strands the rest.
   */
  let release = (): void => {}
  paper.hold = new Promise<void>((r) => {
    release = r
  })
  const inflight = svc.applyDecision(request({ actions: threeLegs }))
  await paper.entered

  clockMs = T0 + ROUTING_STALE_MS - 1
  const replay = await svc.applyDecision(request({ actions: threeLegs }))
  assert.equal(replay.status, 'ROUTING')
  assert.equal(replay.indeterminate, true)
  assert.deepEqual(replay.fills, [])
  // The record was NOT rewritten by the replay: the owner still owns it.
  assert.equal(stored()?.['status'], 'ROUTING')

  release()
  await inflight
})

test('a STALE ROUTING record is RESOLVED against the rail’s own collection', async () => {
  // The claim, exactly as a process that then died would have left it: the plan
  // parked in `plannedFills`, `fills: []`, status ROUTING.
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-crash',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    fills: [],
    plannedFills: [
      { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
    ],
    skips: [],
    createdAt: T0,
    status: 'ROUTING',
  })
  // ...but the order DID reach the rail before it died. That document is the
  // only remaining witness, and its id is derived from the decisionId.
  await db.collection(COLLECTIONS.paperTrade).insertOne({
    clientOrderId: 'd-crash#0',
    tradingsymbol: 'BANKNIFTY26JUL57000CE',
    quantity: 5 * LOT,
    price: 120,
  })

  clockMs = T0 + ROUTING_STALE_MS
  const r = await svc.applyDecision(request({ decisionId: 'd-crash' }))
  assert.equal(r.replayed, true)
  assert.equal(r.status, 'DONE')
  assert.equal(r.indeterminate, undefined)
  assert.equal(r.fills.length, 1, 'the order exists, so the fill is real')
  assert.equal(r.fills[0]?.price, 120, 'at the price the CLAIM recorded, never today’s mark')
  assert.equal(paper.routed.length, 0, 'a reconcile must never route')

  // The record is repaired, so P&L stops under-reporting a real position.
  const doc = stored('d-crash')
  assert.equal(doc?.['status'], 'DONE')
  assert.equal((doc?.['fills'] as unknown[]).length, 1)
})

test('a stale reconcile that finds NOTHING says nothing routed — the order was lost', async () => {
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-lost',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    fills: [],
    plannedFills: [
      { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
    ],
    skips: [],
    createdAt: T0,
    status: 'ROUTING',
  })

  clockMs = T0 + ROUTING_STALE_MS
  const r = await svc.applyDecision(request({ decisionId: 'd-lost' }))
  assert.equal(r.status, 'FAILED')
  assert.deepEqual(r.fills, [])
  assert.equal(r.routeErrors.length, 1)
  assert.match(r.routeErrors[0]!.error, /no order in desk-paper-trade/)
  assert.equal(stored('d-lost')?.['status'], 'FAILED')
})

test('a stale reconcile reports a PARTIAL as partial, naming the leg that is missing', async () => {
  const plannedFills = threeLegs.map((a, i) => ({
    op: 'open',
    deskTag: a.ts,
    tradingsymbol: `BANKNIFTY26JUL${(a as { strike: number }).strike}${(a as { type: string }).type}`,
    side: (a as { side: string }).side,
    qty: 5 * LOT,
    price: 100,
    ts: T0,
  }))
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-partial',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    fills: [],
    plannedFills,
    skips: [],
    createdAt: T0,
    status: 'ROUTING',
  })
  // Only the first two of three tranche ids exist.
  for (const i of [0, 1]) {
    await db.collection(COLLECTIONS.paperTrade).insertOne({ clientOrderId: `d-partial#${i}` })
  }

  clockMs = T0 + ROUTING_STALE_MS
  const r = await svc.applyDecision(request({ decisionId: 'd-partial', actions: threeLegs }))
  assert.equal(r.status, 'FAILED', 'a partial is not a success')
  assert.equal(r.fills.length, 2, 'exactly the two that can be evidenced')
  assert.equal(r.routeErrors.length, 1)
  assert.match(r.routeErrors[0]!.error, /d-partial#2/)
})

test('a LIVE decision reconciles against the LIVE collection, never the paper one', async () => {
  /**
   * Probing the wrong collection would report a routed LIVE order as lost,
   * which is the one error that talks a caller into placing it again.
   */
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-live',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'live',
    tag: TAG,
    fills: [],
    plannedFills: [
      { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
    ],
    skips: [],
    createdAt: T0,
    status: 'ROUTING',
  })
  // The same tranche id, in the PAPER collection. A reconcile that probed there
  // would call this live order routed on the strength of a paper document.
  await db.collection(COLLECTIONS.paperTrade).insertOne({ clientOrderId: 'd-live#0' })

  clockMs = T0 + ROUTING_STALE_MS
  const wrong = await svc.applyDecision(request({ decisionId: 'd-live', mode: 'live' }))
  assert.equal(wrong.status, 'FAILED')
  assert.match(wrong.routeErrors[0]!.error, /no order in desk-gateway-orders/)

  // Put it where the live rail actually writes and the answer flips.
  await db.collection(COLLECTIONS.decisions).deleteOne({ decisionId: 'd-live' })
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-live',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'live',
    tag: TAG,
    fills: [],
    plannedFills: [
      { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
    ],
    skips: [],
    createdAt: T0,
    status: 'ROUTING',
  })
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({ clientOrderId: 'd-live#0' })
  const right = await svc.applyDecision(request({ decisionId: 'd-live', mode: 'live' }))
  assert.equal(right.status, 'DONE')
  assert.equal(right.fills.length, 1)
})

test('a reconcile cannot overwrite a record its own owner has already finished', async () => {
  /**
   * The owner may have been merely WEDGED, not dead. Its own unfiltered write
   * lands second and must win — it watched the routing happen and we only
   * inferred it. The reconcile's update is filtered on `status: 'ROUTING'`, so
   * against a record that has already resolved it matches nothing.
   */
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-late',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    fills: [
      { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
    ],
    plannedFills: [
      { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
    ],
    routeErrors: [],
    skips: [],
    createdAt: T0,
    status: 'DONE',
  })
  clockMs = T0 + ROUTING_STALE_MS * 10
  const r = await svc.applyDecision(request({ decisionId: 'd-late' }))
  assert.equal(r.status, 'DONE')
  assert.equal(r.fills.length, 1, 'the owner’s own record stands; nothing is reconciled')
  assert.equal(stored('d-late')?.['status'], 'DONE')
})

test('a wedged owner that finishes DURING a reconcile still wins the write', async () => {
  /**
   * The narrow race the `status: 'ROUTING'` filter on the reconcile's update
   * exists for, and the only way to observe it: the owner was not dead, only
   * slow. It finishes between our read of the claim and our write of the
   * inference — and its write must stand, because it WATCHED the routing happen
   * and we only inferred it from the order collection.
   *
   * Without the filter the reconcile lands second and overwrites two real,
   * routed fills with its own "nothing routed", which reports a live position
   * as flat: the exact failure a reconcile exists to repair, caused by the
   * repair.
   */
  const twoFills = [
    { op: 'open', deskTag: 'CE57000#0', tradingsymbol: 'BANKNIFTY26JUL57000CE', side: 'Sell', qty: 5 * LOT, price: 120, ts: T0 },
    { op: 'open', deskTag: 'PE56000#1', tradingsymbol: 'BANKNIFTY26JUL56000PE', side: 'Sell', qty: 5 * LOT, price: 95, ts: T0 },
  ]
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'd-wedged',
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    fills: [],
    plannedFills: twoFills,
    skips: [],
    createdAt: T0,
    status: 'ROUTING',
  })

  // The owner completes while the reconcile is mid-probe. Hooked onto the order
  // lookup because that is precisely the gap between the two writes.
  const orders = db.collection(COLLECTIONS.paperTrade)
  const realFindOne = orders.findOne.bind(orders)
  let once = true
  ;(orders as unknown as { findOne: typeof realFindOne }).findOne = async (filter) => {
    if (once) {
      once = false
      await db
        .collection(COLLECTIONS.decisions)
        .updateOne({ decisionId: 'd-wedged' }, { $set: { status: 'DONE', fills: twoFills, routeErrors: [] } })
    }
    return await realFindOne(filter)
  }

  clockMs = T0 + ROUTING_STALE_MS
  await svc.applyDecision(request({ decisionId: 'd-wedged', actions: threeLegs }))

  const doc = stored('d-wedged')
  assert.equal(doc?.['status'], 'DONE', 'the owner’s status survives')
  assert.equal(
    (doc?.['fills'] as unknown[]).length,
    2,
    'two REAL fills must not be overwritten by an inference that saw no orders',
  )
})

// ------------------------------------- the response agrees with what routed

test('a decision whose route FAILED returns neither the fill nor the leg', async () => {
  /**
   * The journal and the stored book were already narrowed to what routed, but
   * the RESPONSE still handed back the plan — so a desk that books its position
   * from the response (which is the point of returning one) carried a leg with
   * no order behind it anywhere, beside a `desk-books` that was correctly empty.
   */
  paper.failFor.add('BANKNIFTY26JUL57000CE')
  const r = await svc.applyDecision(request({ actions: threeLegs }))

  assert.equal(r.status, 'FAILED')
  assert.equal(r.routeErrors.length, 1)
  assert.deepEqual(
    r.fills.map((f) => f.tradingsymbol),
    ['BANKNIFTY26JUL56000PE', 'BANKNIFTY26JUL56500CE'],
    'only the legs that reached a rail',
  )
  assert.deepEqual(
    r.book.map((l) => l.instrument.tradingsymbol),
    ['BANKNIFTY26JUL56000PE', 'BANKNIFTY26JUL56500CE'],
  )
  // ...and the response agrees with the store, which is the whole point.
  assert.deepEqual(
    (await store.loadBook(TAG, MODE)).map((l) => l.instrument.tradingsymbol),
    r.book.map((l) => l.instrument.tradingsymbol),
  )
  assert.equal((stored()?.['fills'] as unknown[]).length, 2)
})
