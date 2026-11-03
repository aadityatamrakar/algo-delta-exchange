/**
 * Flattening a HOSTED strategy's position — audit finding C4.
 *
 * THE BUG THIS FILE PINS DOWN. The strategy switch deliberately blocks exits as
 * well as entries ("off means off"), and the documented escape hatch is
 * `close-all`, which runs as the OPERATOR and is exempt from both switches. That
 * hatch read `desk-books`, and `/v1/desk/submit` never writes one — hosted
 * strategies submit single orders and own their positions internally. So an
 * operator disabling `ORB_SCALP_BN` at 12:00 holding 5 lots blocked the
 * strategy's own exit, the runner dropped the tag and its square-off never
 * fired, and `close-all` found nothing to close. The position was trapped.
 *
 * Everything here runs against an in-memory `Database` fake rather than Mongo,
 * for the reason `submit.test.ts` gives: a safety path that can only be tested
 * against a running database is a safety path that stops being tested. The fake
 * models the two behaviours the correctness argument actually rests on — the
 * UNIQUE index on `decisionId` (idempotency is a lock, not a read-then-write)
 * and range-filtered, sorted reads (average cost is path-dependent, so fill
 * ORDER is part of the answer).
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { BridgeService } from '../src/service.ts'
import { StaticMarks } from '../src/marks.ts'
import type { MarketableConfig } from '../src/marketable.ts'
import { DeskStore, COLLECTIONS, type Collection, type Database, type FindCursor, type UpdateOutcome } from '../src/store.ts'
import type { ActionsRequest, BridgeLeg, DeskMode, DeskSide, Fill } from '../src/contract.ts'
import type { OrderRail, RouteContext } from '../src/rail.ts'
import { LiveRailBlocked } from '../src/rail.ts'
import { deskRoutes } from '../src/routes/desk.ts'
import { booksRoutes } from '../src/routes/books.ts'
import type { ApiDeps, RouteCtx } from '../src/routes/kit.ts'
import type { AuthGate } from '../src/authgate.ts'

// ------------------------------------------------------------------ fixtures

const TAG = 'ORB_SCALP_BN'
const MODE: DeskMode = 'paper'
const EXPIRY = '2026-07-30'
const LOT = 35
const CE = 'BANKNIFTY26JUL57000CE'
const PE = 'BANKNIFTY26JUL56000PE'

/** 12:00 IST on 2026-07-27 — the audit's "operator disables at 12:00". */
const NOW = Date.UTC(2026, 6, 27, 6, 30)
/** 09:30 IST the same morning: when the strategy opened its position. */
const OPENED = Date.UTC(2026, 6, 27, 4, 0)

/**
 * `NIFTYNXT50` is in the fixture on purpose, not for coverage.
 *
 * `flattenTag` has no caller-supplied underlying — it flattens by TAG across
 * whatever symbols the fills mention — so it DERIVES one per leg, and the
 * derivation used to be the leading non-digit run. That read this contract as
 * `NIFTYNXT`, which is not an NSE key: it filed the flatten's decision under a
 * book that does not exist and wrote a wrong `underlying` onto the order. The
 * gateway prefers the instrument master over that value, but the master is
 * exactly what is unavailable for a contract listed this morning.
 */
const NXT = 'NIFTYNXT5026JUL30000CE'

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of [56_000, 56_500, 57_000]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: strike + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BANKNIFTY26JUL${strike}${type}`,
        name: 'BANKNIFTY',
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
  rows.push({
    instrument_token: 30_001,
    tradingsymbol: NXT,
    name: 'NIFTYNXT50',
    expiry: EXPIRY,
    strike: 30_000,
    tick_size: 0.05,
    lot_size: 25,
    instrument_type: 'CE',
    segment: 'NFO-OPT',
    exchange: 'NFO',
  })
  return new OptionMaster(rows)
}

const MARKS = new StaticMarks(
  { [CE]: 120, [PE]: 95, [NXT]: 40 },
  { BANKNIFTY: 56_480, NIFTYNXT50: 30_100 },
)

// ------------------------------------------------------------- the db fake

/**
 * Order two values the way Mongo does: strings against strings, numbers against
 * numbers. `Number()` on both sides is fine for the `createdAt` ranges this fake
 * was written for and silently WRONG for a `'YYYY-MM-DD'` range — NaN compares
 * false against everything, so the query returns nothing and the test passes for
 * having asked a question the fake could not answer.
 */
/**
 * NULL MEANS "DIFFERENT BSON TYPES", and a range operator on it is FALSE — real
 * Mongo only ever compares a value against operands of its own type.
 *
 * `loadFills` reads its window as TWO typed range queries, numeric and `Date`,
 * and merges them (see `pnlstore.ts`). A `cmp` that coerces answers BOTH
 * queries with the same numeric decision, and the flatten report then sees
 * every open twice — a position of double the size, from a fake nobody would
 * think to suspect.
 */
function cmp(a: unknown, b: unknown): number | null {
  if (bracketOf(a) !== bracketOf(b)) return null
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  const x = Number(a)
  const y = Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Mongo's comparison bracket for a value. Different brackets never compare. */
function bracketOf(v: unknown): string {
  if (v instanceof Date) return 'date'
  if (v === null) return 'null'
  return typeof v
}

/**
 * Range and equality filters, plus `$in` and `$or`. `loadFills` queries the
 * decisions with a `createdAt` range whose TYPE is part of the query (F-53, see
 * `pnlstore.ts`), so an equality-only fake would return every decision ever
 * written and the window under test would prove nothing.
 */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, want]) => {
    if (k === '$or') {
      return (
        Array.isArray(want) &&
        want.some((sub) => matches(doc, sub as Record<string, unknown>))
      )
    }
    const got = doc[k]
    if (want instanceof Date) return got instanceof Date && got.getTime() === want.getTime()
    if (typeof want !== 'object' || want === null || Array.isArray(want)) return got === want
    return Object.entries(want as Record<string, unknown>).every(([op, v]) => {
      const c = cmp(got, v)
      switch (op) {
        case '$gte':
          return c !== null && c >= 0
        case '$gt':
          return c !== null && c > 0
        case '$lt':
          return c !== null && c < 0
        case '$lte':
          return c !== null && c <= 0
        case '$in':
          return Array.isArray(v) && v.includes(got)
        default:
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
    // A STABLE sort, because `loadFills` relies on it: two decisions stamped in
    // the same millisecond must keep insertion order or the average cost of a
    // rolled position changes between runs.
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

  /**
   * Runs INSIDE `updateOne`, before the filter is matched — i.e. exactly in the
   * window a concurrent writer lands in. It is the only way to reproduce the
   * lost update the compare-and-set exists to catch: everything else here is
   * single-threaded by construction, so a race has to be injected.
   */
  beforeUpdate: (() => void) | null = null

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
    this.beforeUpdate?.()
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
  async createIndex(
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean },
  ): Promise<unknown> {
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
 * Records what reached a rail, and can be made to fail per symbol.
 *
 * It WRITES the order document as well as recording it, exactly as the real
 * rails do. `route` succeeding means "a document with this clientOrderId is in
 * the order collection", and that document is the only witness a stale-ROUTING
 * reconcile has after the process that claimed a decision dies — a rail that
 * only recorded in memory would let a reconcile test pass while the real
 * reconcile found nothing.
 */
class RecordingRail implements OrderRail {
  readonly routed: { fill: Fill; ctx: RouteContext }[] = []
  readonly failFor = new Set<string>()
  readonly mode: 'paper' | 'live'
  readonly collection: string
  constructor(mode: 'paper' | 'live') {
    this.mode = mode
    this.collection = mode === 'live' ? COLLECTIONS.gatewayOrders : COLLECTIONS.paperTrade
  }
  async route(fill: Fill, ctx: RouteContext): Promise<void> {
    if (this.failFor.has(fill.tradingsymbol)) {
      throw new LiveRailBlocked(`rail refused ${fill.tradingsymbol}`)
    }
    await db.collection(this.collection).insertOne({
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
let paper: RecordingRail
let live: RecordingRail
let clockMs: number
let svc: BridgeService

/**
 * `marketable` is OPTIONAL here exactly as it is in production wiring: absent
 * means "leave the order MARKET", which is what every test written before the
 * broker started refusing MARKET orders still asserts. The one test that pins
 * the crossing limit passes a config, so the default fixture keeps proving the
 * historical shape.
 */
function service(marks = MARKS, marketable?: MarketableConfig): BridgeService {
  return new BridgeService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks,
    ...(marketable === undefined ? {} : { marketable }),
    clock: { now: () => clockMs },
  })
}

/**
 * A `/v1/desk/submit` P&L journal record, shaped exactly as `submit.ts`'s
 * `#journalFills` writes it. This is the ONLY trace a hosted strategy leaves of
 * its position, which is the entire premise of the fix.
 */
async function journalSubmit(opts: {
  clientOrderId: string
  side: DeskSide
  tradingsymbol: string
  qty: number
  price: number
  createdAt?: number
  tag?: string
  mode?: DeskMode
  reducesExposure?: boolean
}): Promise<void> {
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: opts.clientOrderId,
    symbol: 'BANKNIFTY',
    expiry: '',
    mode: opts.mode ?? MODE,
    tag: opts.tag ?? TAG,
    fills: [
      {
        op: opts.reducesExposure === true ? 'close' : 'open',
        deskTag: `${opts.clientOrderId}#0`,
        tradingsymbol: opts.tradingsymbol,
        side: opts.side,
        qty: opts.qty,
        price: opts.price,
        ts: opts.createdAt ?? OPENED,
      },
    ],
    skips: [],
    createdAt: opts.createdAt ?? OPENED,
    status: 'DONE',
    source: 'submit',
  })
}

beforeEach(async () => {
  db = new FakeDb()
  store = new DeskStore(db)
  await store.ensureIndexes()
  paper = new RecordingRail('paper')
  live = new RecordingRail('live')
  clockMs = NOW
  svc = service()
  // The registry row a real deployment seeds for a hosted strategy.
  await store.registerStrategy(
    { tag: TAG, kind: 'hosted', label: 'ORB scalp BN', modes: { paper: { enabled: true } } },
    OPENED,
  )
})

/** 5 lots short the 57000CE — the audit's trapped position. */
async function seedTrappedPosition(): Promise<void> {
  await journalSubmit({
    clientOrderId: 'orb-open-1',
    side: 'Sell',
    tradingsymbol: CE,
    qty: 5 * LOT,
    price: 130,
  })
}

// ------------------------------------------------------- the trapped position

test('the trapped position: close-all by TAG flattens a hosted strategy that is DISABLED', async () => {
  await seedTrappedPosition()
  // The operator switches it off at 12:00. "Off means off" — the strategy's own
  // exit is now blocked and the runner has dropped the tag, so nothing else will
  // ever close this.
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } }, disabledReason: 'stopped for the day' })

  const r = await svc.flattenTag({
    tag: TAG,
    mode: MODE,
    decisionId: 'flat-1',
    style: 'fast',
  })

  assert.equal(r.flat, true, 'the position must actually be flattened')
  assert.equal(r.status, 'DONE')
  assert.equal(r.legs.length, 1)
  const leg = r.legs[0]!
  assert.equal(leg.tradingsymbol, CE)
  assert.equal(leg.positionQty, -5 * LOT, 'short 5 lots, derived from the submit fills')
  assert.equal(leg.side, 'Buy', 'closing a short means BUYING it back')
  assert.equal(leg.qty, 5 * LOT)
  assert.equal(leg.routed, true)

  // ...and a real order went out, on the paper rail, for the whole position.
  assert.equal(paper.routed.length, 1)
  assert.equal(paper.routed[0]!.fill.side, 'Buy')
  assert.equal(paper.routed[0]!.fill.qty, 5 * LOT)
  assert.equal(paper.routed[0]!.ctx.tag, TAG)
  assert.equal(paper.routed[0]!.ctx.underlying, 'BANKNIFTY')
  assert.equal(live.routed.length, 0, 'a paper flatten must never touch the live rail')
})

test('the flatten is exempt from the STRATEGY switch — it runs as the operator', async () => {
  await seedTrappedPosition()
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } }, disabledReason: 'margin call' })

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-sw', style: 'fast' })
  assert.equal(r.flat, true)
  // `flat` alone is vacuously true over an empty leg list, which is precisely
  // the "reports success while the position is still open" failure this whole
  // path exists to remove. The order actually going out is the real assertion.
  assert.equal(paper.routed.length, 1)
  // Nothing was journalled as a refusal, and the switch was not stamped as
  // "seen" — a flatten is the operator acting, not the strategy waking up.
  assert.equal(db.docs(COLLECTIONS.orderEvents).length, 0)
  const row = await store.loadStrategy(TAG)
  assert.equal(row?.lastSeenAt ?? 0, 0, 'flattening must not fake strategy liveness')
})

test('the flatten is exempt from the KILL SWITCH, like close-all', async () => {
  await seedTrappedPosition()
  await svc.setKillSwitch(true, 'emergency', 'operator')

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-ks', style: 'fast' })
  assert.equal(r.flat, true, 'closing is the halt’s purpose, not something it obstructs')
  assert.equal(paper.routed.length, 1)
})

test('an UNREGISTERED tag is still flattenable — a deleted row must not trap a position', async () => {
  await seedTrappedPosition()
  await db.collection(COLLECTIONS.strategies).deleteOne({ tag: TAG })
  assert.equal(await store.loadStrategy(TAG), null)

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-nr', style: 'fast' })
  assert.equal(r.flat, true)
  assert.equal(paper.routed.length, 1)
})

// ------------------------------------------------------------- idempotency

test('a retried flatten replays and cannot double-sell', async () => {
  await seedTrappedPosition()
  const first = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-2', style: 'fast' })
  const second = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-2', style: 'fast' })

  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(second.flat, true, 'the replay reports the ORIGINAL outcome')
  assert.deepEqual(
    second.legs.map((l) => [l.tradingsymbol, l.routed]),
    first.legs.map((l) => [l.tradingsymbol, l.routed]),
  )
  assert.equal(paper.routed.length, 1, 'a retry must not place a second exit')
})

test('CONCURRENT flattens of the same decisionId place exactly one set of exits', async () => {
  await seedTrappedPosition()
  const results = await Promise.all([
    svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-3', style: 'fast' }),
    svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-3', style: 'fast' }),
    svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-3', style: 'fast' }),
  ])
  assert.equal(results.filter((r) => !r.replayed).length, 1)
  assert.equal(paper.routed.length, 1)
})

test('ONE decisionId covers EVERY leg of a multi-leg position', async () => {
  await seedTrappedPosition()
  await journalSubmit({
    clientOrderId: 'orb-open-2',
    side: 'Buy',
    tradingsymbol: PE,
    qty: 2 * LOT,
    price: 90,
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-4', style: 'fast' })
  assert.equal(r.legs.length, 2)
  assert.equal(r.flat, true)
  assert.equal(paper.routed.length, 2)
  // Distinct, DERIVED order ids: a replay must reproduce them exactly, or the
  // gateway's unique index would let a retry place a second broker order.
  assert.deepEqual(
    paper.routed.map((o) => o.ctx.clientOrderId),
    ['flat-4#0', 'flat-4#1'],
  )
  // ...and the long PE is SOLD while the short CE is BOUGHT.
  const bySymbol = new Map(r.legs.map((l) => [l.tradingsymbol, l]))
  assert.equal(bySymbol.get(CE)?.side, 'Buy')
  assert.equal(bySymbol.get(PE)?.side, 'Sell')
})

test('a SECOND flatten under a NEW id finds nothing left — the exits are journalled', async () => {
  // The guarantee beyond decisionId: the closing fills land in `desk-decisions`,
  // so the next reconstruction nets to flat. Without it, a fresh id would sell
  // the position a second time and open a naked short.
  await seedTrappedPosition()
  await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-5a', style: 'fast' })
  const again = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-5b', style: 'fast' })

  assert.equal(again.legs.length, 0, 'nothing is open any more')
  assert.equal(again.flat, true)
  assert.equal(paper.routed.length, 1, 'no second exit')
})

test('a partially closed position is flattened for the REMAINDER only', async () => {
  await seedTrappedPosition() // short 5 lots
  await journalSubmit({
    clientOrderId: 'orb-part',
    side: 'Buy',
    tradingsymbol: CE,
    qty: 2 * LOT,
    price: 118,
    createdAt: OPENED + 60_000,
    reducesExposure: true,
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-6', style: 'fast' })
  assert.equal(r.legs[0]?.positionQty, -3 * LOT, 'the strategy already covered 2 of the 5 lots')
  assert.equal(r.legs[0]?.qty, 3 * LOT)
  assert.equal(paper.routed[0]?.fill.qty, 3 * LOT)
})

// --------------------------------------------------- reporting what failed

test('a PARTIAL flatten reports, per leg, what it could not close', async () => {
  await seedTrappedPosition()
  await journalSubmit({
    clientOrderId: 'orb-open-3',
    side: 'Sell',
    tradingsymbol: PE,
    qty: 3 * LOT,
    price: 90,
  })
  paper.failFor.add(PE)

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-7', style: 'fast' })
  assert.equal(r.flat, false, 'a flatten that only half worked must NOT report success')
  assert.equal(r.status, 'FAILED')
  const failed = r.legs.filter((l) => !l.routed)
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.tradingsymbol, PE, 'the leg still open is NAMED')
  assert.match(failed[0]?.error ?? '', /rail refused/)
  assert.equal(r.routeErrors.length, 1)
  assert.equal(r.legs.find((l) => l.tradingsymbol === CE)?.routed, true)
})

test('a leg that did not route is NOT journalled, so a retry still closes it', async () => {
  // The trap inside the fix: `desk-decisions` is both the idempotency lock and
  // the P&L journal this method reads. Journalling an exit that never routed
  // would net the position flat and hide the leg that is genuinely still open.
  await seedTrappedPosition()
  paper.failFor.add(CE)
  const failedRun = await svc.flattenTag({
    tag: TAG, mode: MODE, decisionId: 'flat-8a', style: 'fast',
  })
  assert.equal(failedRun.flat, false)
  assert.equal(failedRun.fills.length, 0, 'nothing routed, so nothing may be journalled')

  paper.failFor.delete(CE)
  const retry = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-8b', style: 'fast' })
  assert.equal(retry.flat, true)
  assert.equal(retry.legs[0]?.positionQty, -5 * LOT, 'the full position is still there to close')
  assert.equal(paper.routed.length, 1)
})

test('a contract the instrument master does not know is NAMED, never silently skipped', async () => {
  await journalSubmit({
    clientOrderId: 'orb-ghost',
    side: 'Sell',
    tradingsymbol: 'BANKNIFTY26JUL99000CE', // delisted / never listed
    qty: LOT,
    price: 4,
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-9', style: 'fast' })
  assert.equal(r.flat, false)
  assert.deepEqual(r.unresolved, ['BANKNIFTY26JUL99000CE'])
  assert.equal(r.legs.length, 1)
  assert.equal(r.legs[0]?.routed, false)
  assert.match(r.legs[0]?.error ?? '', /not in the instrument master/)
  assert.equal(paper.routed.length, 0, 'a fabricated contract must never be routed')
  // And it is durable, in the same skip shape every other refusal uses.
  const doc = db.docs(COLLECTIONS.decisions).find((d) => d['decisionId'] === 'flat-9')
  assert.equal((doc?.['skips'] as unknown[]).length, 1)
})

test('a malformed stored fill is reported — the derived position may be wrong', async () => {
  await seedTrappedPosition()
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'orb-corrupt',
    symbol: 'BANKNIFTY',
    expiry: '',
    mode: MODE,
    tag: TAG,
    fills: [{ op: 'open', deskTag: 'x', tradingsymbol: PE, side: 'Sell', qty: 35, price: 'oops' }],
    skips: [],
    createdAt: OPENED + 1000,
    status: 'DONE',
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-10', style: 'fast' })
  assert.deepEqual(r.malformedFills, [`${TAG}:${PE}`])
  // The CE it COULD reconstruct is still closed — one bad row must not discard
  // the legs we can see, which is the same fail-soft contract as `applyActions`.
  assert.equal(r.legs.length, 1)
  assert.equal(r.legs[0]?.tradingsymbol, CE)
  assert.equal(r.legs[0]?.routed, true)
  /**
   * ...AND `flat` SAYS SO. This is the assertion the test was missing, and its
   * absence hid the contradiction: `malformedFills` is documented as "non-empty
   * means the reconstructed position may be WRONG" while `flat` is "the one
   * field an operator acts on", and `flat` was computed from the legs alone.
   * Every leg it could see routed, so it answered `true` — telling the operator
   * the book was closed on the strength of a read that had just dropped a fill.
   */
  assert.equal(r.flat, false, 'a position rebuilt from unreadable fills is not a flat one')
})

test('a malformed fill with NO surviving legs is the worst case — flat must still be false', async () => {
  /**
   * The reproduction from the audit, in its pure form: the ONLY record of a
   * real 5-lot short is corrupt. `legs` comes back empty, `legs.every(...)` is
   * vacuously true over nothing, and the old answer was
   * `{flat: true, legs: 0, malformedFills: [...]}` with zero orders routed —
   * a "yes, you are flat" for an operator who is short 5 lots.
   */
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'orb-only-corrupt',
    symbol: 'BANKNIFTY',
    expiry: '',
    mode: MODE,
    tag: TAG,
    fills: [{ op: 'open', deskTag: 'x', tradingsymbol: CE, side: 'Sell', qty: 5 * LOT, price: 'oops' }],
    skips: [],
    createdAt: OPENED,
    status: 'DONE',
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-10b', style: 'fast' })
  assert.equal(r.legs.length, 0)
  assert.deepEqual(r.malformedFills, [`${TAG}:${CE}`])
  assert.equal(r.flat, false, 'vacuously-true over an empty list is the bug, not the answer')
  assert.equal(paper.routed.length, 0)
})

// ------------------------------------------------------------------ pricing

test('style fast sends MARKET', async () => {
  await seedTrappedPosition()
  const fast = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'p-1', style: 'fast' })
  assert.equal(fast.legs[0]?.orderType, 'MARKET')
  assert.equal(fast.legs[0]?.limitPrice, undefined)
  assert.equal(paper.routed[0]?.fill.orderType, 'MARKET')
})

/**
 * THE BROKER REJECTS MARKET ORDERS, and `flattenTag` is the dashboard's Flatten
 * button.
 *
 * `priceFillsForRoute` was taught to convert MARKET into a crossing limit, but
 * this method never went through it: it builds its fills with
 * `plannedFlattenFills` and routes them directly. So `fast` — the EMERGENCY
 * style, the one an operator reaches for when a book has to go now — was the
 * single path still emitting raw MARKET, XTS refused every leg, and the flatten
 * reported its legs as routed.
 *
 * The assertion that matters is on the ROUTED fill: the response could be
 * decorated and still be a lie about what reached the rail.
 */
test("a 'fast' flatten goes out as a marketable LIMIT, not MARKET", async () => {
  await seedTrappedPosition()
  const priced = service(MARKS, { bufferPct: 0.02, minTicks: 2, tickSize: 0.05 })

  const r = await priced.flattenTag({
    tag: TAG, mode: MODE, decisionId: 'fast-cross-1', style: 'fast',
  })

  assert.equal(paper.routed.length, 1)
  assert.equal(paper.routed[0]?.fill.orderType, 'LIMIT', 'a MARKET order would be refused outright')
  // Closing a SHORT buys, so the limit sits ABOVE the 120 mark to cross it.
  assert.equal(paper.routed[0]?.fill.limitPrice, 122.4)
  // ...and what the operator is shown, and what is journalled, is that same
  // order — not the MARKET intent it was planned as.
  assert.equal(r.legs[0]?.orderType, 'LIMIT')
  assert.equal(r.legs[0]?.limitPrice, 122.4)
  assert.equal(r.fills[0]?.orderType, 'LIMIT')
  assert.equal(r.fills[0]?.limitPrice, 122.4)
})

test('style limit prices THROUGH the mark, and the rail sees the price', async () => {
  await seedTrappedPosition()
  const lim = await svc.flattenTag({
    tag: TAG, mode: MODE, decisionId: 'p-2', style: 'limit', aggressionPct: 0.02,
  })
  // Closing a SHORT buys, so the bid must sit above the 120 mark to cross.
  assert.equal(lim.legs[0]?.orderType, 'LIMIT')
  assert.equal(lim.legs[0]?.limitPrice, 122.4)
  assert.equal(paper.routed[0]?.fill.orderType, 'LIMIT')
  assert.equal(paper.routed[0]?.fill.limitPrice, 122.4)
})

test('an UNMARKED leg degrades to MARKET, is NAMED, and books at avg cost not zero', async () => {
  await seedTrappedPosition()
  const blind = service(new StaticMarks({}, {}))
  const r = await blind.flattenTag({ tag: TAG, mode: MODE, decisionId: 'p-3', style: 'limit' })

  assert.equal(r.legs[0]?.routed, true, 'it must still be CLOSED — no exit is worse than a bad one')
  assert.equal(r.legs[0]?.orderType, 'MARKET')
  assert.deepEqual(r.unpriceable, [CE])
  assert.match(r.legs[0]?.degraded ?? '', /no mark/)
  // A fill journalled at 0 does not fail — it reports the whole premium as
  // profit. The average cost books it at no gain and no loss instead.
  assert.equal(paper.routed[0]?.fill.price, 130)
  assert.equal(r.fills[0]?.price, 130)
})

// ----------------------------- the decision path's expiry-day buffer (F3)

/**
 * THE BUFFER AN ENGINE DECISION PAYS ON ITS CONTRACT'S LAST DAY.
 *
 * `/v1/desk/submit` has always priced a contract that expires today with the
 * wide buffer. The decision path never did: a delta-lean exit on an expiry day
 * went out 2% through an LTP on a tape that had already moved past it, and sat
 * unfilled — the 1 Oct stranded hedge. `applyDecision` now asserts expiry day
 * for the one family that needs it: an ENGINE decision whose trigger starts
 * `dl-`, on a book whose contract expires today (IST). The recenter triggers
 * are the control — their pricing must not move.
 *
 * EVERY ASSERTION IS ON THE ROUTED FILL, the order that reached the rail. An
 * engine paper decision answers WORKING with no fills, so the response cannot
 * carry the price, and the response is the wrong witness anyway.
 *
 * Mark 120 on the 57000 CE: 2% is 122.40 / 117.60, 10% is 132.00 / 108.00.
 */
const PRICED: MarketableConfig = { bufferPct: 0.02, minTicks: 2, tickSize: 0.05, expiryBufferPct: 0.1 }
const ENGINE_TAG = 'NIFTY-delta-lean-buffer'
/** 10:30 IST on an IST date — mid-session, and the same calendar date in UTC. */
const sessionOn = (istDay: string): number => Date.parse(`${istDay}T05:00:00.000Z`)
const DAY_MS = 24 * 60 * 60 * 1000

async function registerEngineBook(): Promise<void> {
  await store.registerStrategy(
    { tag: ENGINE_TAG, kind: 'external', modes: { paper: { enabled: true } } },
    OPENED,
  )
}

/** The book is short one 57000 CE, so an engine `close` is a BUY at the mark. */
async function seedEngineBook(): Promise<void> {
  await registerEngineBook()
  // No `via`, so it books at once and leaves the leg an engine exit can close.
  const seeded = await svc.applyDecision({
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: MODE,
    tag: ENGINE_TAG,
    decisionId: 'buffer-seed',
    actions: [{ op: 'open', ts: 'CE57000#0', strike: 57_000, type: 'CE', side: 'Sell', qty: LOT }],
  })
  assert.equal(seeded.fills.length, 1, 'the fixture must actually open a leg')
}

let bufferSeq = 0

/**
 * One decision through a service that has the production marketable dials,
 * returning the order that reached the rail.
 *
 * An ENGINE decision (the default) is shaped as `routes/engine.ts` forms it:
 * `via: 'engine'`, the trigger as `action`, and a pricing map with a MARKET
 * entry for the one action — which is what an unpriced engine action is. With
 * `engine: false` it is a plain decision (`routes/desk.ts`): no `via` and no
 * pricing map. `action` omitted sends no trigger text at all.
 */
async function decide(
  at: number,
  what: { action?: string; engine?: boolean; op?: 'close' | 'open' },
): Promise<Fill | undefined> {
  const { action, engine = true, op = 'close' } = what
  clockMs = at
  const routedBefore = paper.routed.length
  const deskTag = 'CE57000#0'
  const act: ActionsRequest['actions'][number] =
    op === 'close'
      ? { op: 'close', ts: deskTag }
      : { op: 'open', ts: deskTag, strike: 57_000, type: 'CE', side: 'Sell', qty: LOT }
  const res = await service(MARKS, PRICED).applyDecision(
    {
      symbol: 'BANKNIFTY',
      expiry: EXPIRY,
      mode: MODE,
      tag: ENGINE_TAG,
      decisionId: `buffer-${++bufferSeq}`,
      actions: [act],
      ...(action === undefined ? {} : { action }),
      ...(engine ? { via: 'engine' as const } : {}),
    },
    engine
      ? new Map([[deskTag, { orderType: 'MARKET' as const, workMode: 'passive' as const }]])
      : undefined,
  )
  assert.equal(res.routeErrors.length, 0, JSON.stringify(res.routeErrors))
  assert.equal(paper.routed.length, routedBefore + 1, 'the decision must route exactly one order')
  return paper.routed[routedBefore]?.fill
}

test("an engine dl-exit on the contract's expiry day is priced 10% through the mark", async () => {
  await seedEngineBook()
  const fill = await decide(sessionOn(EXPIRY), { action: 'dl-exit' })
  assert.equal(fill?.orderType, 'LIMIT')
  // Closing a SHORT buys: 120 + 10% = 132, where the base buffer said 122.40.
  assert.equal(fill?.limitPrice, 132)
})

test('an engine RECENTER trigger on the same day is priced exactly as before — 2%', async () => {
  await seedEngineBook()
  const fill = await decide(sessionOn(EXPIRY), { action: 'shed' })
  assert.equal(fill?.orderType, 'LIMIT')
  assert.equal(fill?.limitPrice, 122.4)
})

test('every recenter trigger stays on the base buffer on an expiry day', async () => {
  // The family is picked by the `dl-` PREFIX, so the control is the whole list
  // that does not carry it. Each decision is its own order on the same leg: an
  // engine paper decision does not fold the book, so the leg is still there.
  // `eod` is NOT here: it is shared with the delta-lean flatten windows and
  // takes the wide buffer on an expiry day — see the test below.
  const recenter = [
    'shift', 'shed', 'scrap', 'lock', 'margin', 'expiry', 'recycle', 'unwind', 'balance', 'none',
  ]
  await seedEngineBook()
  for (const action of recenter) {
    const fill = await decide(sessionOn(EXPIRY), { action })
    assert.equal(fill?.limitPrice, 122.4, `${action} must not move`)
  }
})

test('an engine eod flatten on the expiry day takes the wide buffer — the 14:50-15:00 exit of a 0-DTE book', async () => {
  // `eod` is the delta-lean family's flatten window (and the recenter sweep's
  // name too): on a contract that expires today it must fill, so it pays 10%.
  await seedEngineBook()
  const fill = await decide(sessionOn(EXPIRY), { action: 'eod' })
  assert.equal(fill?.orderType, 'LIMIT')
  assert.equal(fill?.limitPrice, 132)
})

test("an engine eod flatten against TOMORROW's expiry stays on the base buffer", async () => {
  await seedEngineBook()
  const fill = await decide(sessionOn(EXPIRY) - DAY_MS, { action: 'eod' })
  assert.equal(fill?.limitPrice, 122.4)
})

test("an engine dl-open against TOMORROW's expiry stays on the base buffer", async () => {
  // Decided the day before the contract expires: nothing about today applies.
  await registerEngineBook()
  const fill = await decide(sessionOn(EXPIRY) - DAY_MS, { action: 'dl-open', op: 'open' })
  assert.equal(fill?.orderType, 'LIMIT')
  // A SELL open: 120 - 2% = 117.60.
  assert.equal(fill?.limitPrice, 117.6)
})

test('an engine dl-open ON the expiry day takes the wide buffer too — opens are not exempt', async () => {
  // The 0-DTE books open on their last day, and an unfilled open leaves a
  // package half built: the family is the trigger prefix, not the direction.
  await registerEngineBook()
  const fill = await decide(sessionOn(EXPIRY), { action: 'dl-open', op: 'open' })
  assert.equal(fill?.limitPrice, 108)
})

test('every dl- trigger on the expiry day takes the wide buffer', async () => {
  await seedEngineBook()
  const family = ['dl-stop', 'dl-open', 'dl-add', 'dl-neutral', 'dl-target', 'dl-stuck', 'dl-exit']
  for (const action of family) {
    const fill = await decide(sessionOn(EXPIRY), { action })
    assert.equal(fill?.limitPrice, 132, `${action} must take the wide buffer`)
  }
})

test('a dl- action WITHOUT the engine lifecycle is not an engine decision — base buffer', async () => {
  // `via` is set in code by the engine route and nowhere else; `action` is
  // free text from any caller, so on its own it must not move a price.
  await seedEngineBook()
  const fill = await decide(sessionOn(EXPIRY), { action: 'dl-exit', engine: false })
  assert.equal(fill?.limitPrice, 122.4)
})

test('an engine decision with NO trigger text stays on the base buffer', async () => {
  await seedEngineBook()
  const fill = await decide(sessionOn(EXPIRY), {})
  assert.equal(fill?.limitPrice, 122.4)
})

test('a dl- trigger is matched by prefix, case and all — not by substring', async () => {
  await seedEngineBook()
  for (const action of ['DL-exit', 'shed-dl-', 'dl', 'xdl-exit']) {
    const fill = await decide(sessionOn(EXPIRY), { action })
    assert.equal(fill?.limitPrice, 122.4, `'${action}' is not in the family`)
  }
})

test('expiry day is judged in IST, not UTC', async () => {
  await seedEngineBook()
  // 00:30 IST on the expiry date is still the 29th in UTC: it IS the expiry day.
  const earlyIst = Date.parse(`${EXPIRY}T00:30:00.000+05:30`)
  assert.equal(new Date(earlyIst).toISOString().slice(0, 10), '2026-07-29', 'the fixture is the UTC day before')
  assert.equal((await decide(earlyIst, { action: 'dl-exit' }))?.limitPrice, 132)

  // 00:30 IST the day AFTER is still the 30th in UTC, and is NOT the expiry day.
  const nextIst = Date.parse('2026-07-31T00:30:00.000+05:30')
  assert.equal(new Date(nextIst).toISOString().slice(0, 10), EXPIRY, 'the fixture is the UTC expiry date')
  assert.equal((await decide(nextIst, { action: 'dl-exit' }))?.limitPrice, 122.4)
})

// ----------------------------------------------------- the live-rail gate

test('the live allowlist is NOT bypassed — a refusal surfaces per leg', async () => {
  await journalSubmit({
    clientOrderId: 'orb-live',
    side: 'Sell',
    tradingsymbol: CE,
    qty: LOT,
    price: 130,
    mode: 'live',
  })
  live.failFor.add(CE) // stands in for LiveRail's allowlist throw
  const r = await svc.flattenTag({ tag: TAG, mode: 'live', decisionId: 'flat-live', style: 'fast' })
  assert.equal(r.flat, false)
  assert.equal(r.legs[0]?.routed, false)
  assert.equal(paper.routed.length, 0, 'a live flatten must never fall back to paper')
})

test('paper and live positions for one tag are kept SEPARATE', async () => {
  await journalSubmit({ clientOrderId: 'sep-p', side: 'Sell', tradingsymbol: CE, qty: LOT, price: 130 })
  await journalSubmit({
    clientOrderId: 'sep-l', side: 'Sell', tradingsymbol: PE, qty: LOT, price: 95, mode: 'live',
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-sep', style: 'fast' })
  assert.deepEqual(r.legs.map((l) => l.tradingsymbol), [CE], 'the live leg is a different book')
  assert.equal(live.routed.length, 0)
})

test('another tag’s position is never touched', async () => {
  await seedTrappedPosition()
  await journalSubmit({
    clientOrderId: 'other-1', side: 'Sell', tradingsymbol: PE, qty: LOT, price: 95, tag: 'OTHER_TAG',
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-tag', style: 'fast' })
  assert.deepEqual(r.legs.map((l) => l.tradingsymbol), [CE])
})

// ------------------------------------------------------------- the window

test('the default window is the IST trading day, and it is reported', async () => {
  await seedTrappedPosition()
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'w-1', style: 'fast' })
  // 2026-07-27 00:00 IST == 2026-07-26 18:30 UTC.
  assert.equal(r.window.from, Date.UTC(2026, 6, 26, 18, 30))
  assert.equal(r.window.to, NOW + 1, 'a fill stamped at exactly now must be inside the window')
})

test('a fill from a PREVIOUS day is invisible by default and reachable via sinceMs', async () => {
  await journalSubmit({
    clientOrderId: 'orb-yesterday',
    side: 'Sell',
    tradingsymbol: CE,
    qty: LOT,
    price: 130,
    createdAt: OPENED - 24 * 60 * 60 * 1000,
  })
  const today = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'w-2', style: 'fast' })
  assert.equal(today.legs.length, 0, 'a hosted strategy is intraday; the day is the default')

  const widened = await svc.flattenTag({
    tag: TAG,
    mode: MODE,
    decisionId: 'w-3',
    style: 'fast',
    sinceMs: OPENED - 3 * 24 * 60 * 60 * 1000,
  })
  assert.equal(widened.legs.length, 1, 'widening the window reaches an overnight position')
  assert.equal(widened.flat, true)
})

/**
 * A POSITIONAL BOOK IS READ WHOLE — the TCS shape, 2026-10-19.
 *
 * The book shorted a put on an earlier session, shorted one more lot this
 * morning, then bought all of it back this morning. Read from today alone the
 * first fill is the morning's OPEN, so the truncation guard passes it, and the
 * buy-back nets it to a LONG that was never held: the Strategies page's Flatten
 * SOLD 675 TCS 2400PE "to close" a leg that was already flat.
 */
test('a tag that has a DESK BOOK is flattened from every fill, not from today', async () => {
  const bookTag = 'BANKNIFTY-2026-07-30-recenter-relief-r'
  const DAY = 24 * 60 * 60 * 1000
  await store.saveBook({ tag: bookTag, mode: MODE, symbol: 'BANKNIFTY', expiry: EXPIRY }, [], OPENED - DAY)
  await journalSubmit({
    clientOrderId: 'shed-yesterday', tag: bookTag, side: 'Sell', tradingsymbol: PE, qty: 2 * LOT, price: 90,
    createdAt: OPENED - DAY,
  })
  await journalSubmit({
    clientOrderId: 'shed-today', tag: bookTag, side: 'Sell', tradingsymbol: PE, qty: LOT, price: 95,
  })
  await journalSubmit({
    clientOrderId: 'repair-today', tag: bookTag, side: 'Buy', tradingsymbol: PE, qty: 3 * LOT, price: 96,
    createdAt: OPENED + 60_000, reducesExposure: true,
  })

  const r = await svc.flattenTag({ tag: bookTag, mode: MODE, decisionId: 'ui-flatten-book', style: 'limit' })

  assert.equal(r.window.from, 0, 'a positional book carries legs across sessions')
  assert.equal(paper.routed.length, 0, 'flat is flat — nothing may be sold to "close" it')
  assert.equal(r.legs.length, 0)
  assert.equal(r.flat, true)
})

test('an explicit sinceMs still wins on a desk book', async () => {
  const bookTag = 'BANKNIFTY-2026-07-30-recenter-relief-r'
  await store.saveBook({ tag: bookTag, mode: MODE, symbol: 'BANKNIFTY', expiry: EXPIRY }, [], OPENED)
  const r = await svc.flattenTag({
    tag: bookTag, mode: MODE, decisionId: 'ui-flatten-book-2', style: 'limit', sinceMs: OPENED,
  })
  assert.equal(r.window.from, OPENED)
})

test('an EMPTY window answers flat:false and says so — it read nothing, it proved nothing', async () => {
  // The NIFTY-2026-08-03 shape: the position is real, the default one-day
  // window simply does not reach the fills that describe it. Zero legs over
  // zero fills must never read as "there is nothing left open".
  await journalSubmit({
    clientOrderId: 'orb-last-week',
    side: 'Sell',
    tradingsymbol: CE,
    qty: 5 * LOT,
    price: 130,
    createdAt: OPENED - 7 * 24 * 60 * 60 * 1000,
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'empty-1', style: 'fast' })
  assert.equal(r.legs.length, 0)
  assert.equal(r.flat, false, 'a window that read nothing cannot report a flat book')
  assert.equal(r.emptyWindow, true, 'the caller is told to widen sinceMs and retry')
  assert.equal(paper.routed.length, 0)

  // ...and the widened retry is the one that may say flat.
  const widened = await svc.flattenTag({
    tag: TAG, mode: MODE, decisionId: 'empty-2', style: 'fast', sinceMs: 0,
  })
  assert.equal(widened.flat, true)
  assert.equal(widened.emptyWindow, undefined)
})

test('a window WITH fills that netted to zero is flat, and not an empty window', async () => {
  await seedTrappedPosition()
  await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'netted-1', style: 'fast' })
  const again = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'netted-2', style: 'fast' })
  assert.equal(again.legs.length, 0)
  assert.equal(again.flat, true)
  assert.equal(again.emptyWindow, undefined)
})

test('a REPLAYED empty-window flatten still reports emptyWindow', async () => {
  const first = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'empty-r', style: 'fast' })
  assert.equal(first.emptyWindow, true)
  const replay = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'empty-r', style: 'fast' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.flat, false)
  assert.equal(replay.emptyWindow, true, 'a replay must report the ORIGINAL outcome')
})

// ---------------------------------------- the existing symbol path, unchanged

test('the SYMBOL-based close-all still flattens a desk book exactly as before', async () => {
  const deskTag = 'DESK_BANKNIFTY'
  await store.registerStrategy(
    { tag: deskTag, kind: 'external', modes: { paper: { enabled: true } } },
    OPENED,
  )
  await svc.applyDecision({
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: MODE,
    tag: deskTag,
    decisionId: 'book-seed',
    actions: [
      { op: 'open', ts: 'CE57000#0', strike: 57_000, type: 'CE', side: 'Sell', qty: LOT },
      { op: 'open', ts: 'PE56000#1', strike: 56_000, type: 'PE', side: 'Sell', qty: LOT },
    ],
  })
  assert.equal((await store.loadBook(deskTag, MODE)).length, 2)

  const closed = await svc.closeAll({
    symbol: 'BANKNIFTY', mode: MODE, tag: deskTag, decisionId: 'book-close', style: 'fast',
  })
  assert.equal(closed.fills.length, 2)
  assert.equal(closed.unpriceable.length, 0)
  assert.equal((await store.loadBook(deskTag, MODE)).length, 0, 'the book is emptied')

  const replay = await svc.closeAll({
    symbol: 'BANKNIFTY', mode: MODE, tag: deskTag, decisionId: 'book-close', style: 'fast',
  })
  assert.equal(replay.replayed, true)
  assert.equal(paper.routed.length, 4, '2 opens + 2 closes, not 6')
})

test('a tag flatten writes NO book — a hosted strategy never had one', async () => {
  // `desk-books` is now keyed by (tag, mode), so writing a hosted tag's legs
  // into it would not merely sit beside the desk's books — it would CREATE one
  // under that tag, and a position that lives only in the fills journal would
  // start being read back as a book too. A hosted strategy has no book; the
  // flatten leaves the collection untouched.
  await seedTrappedPosition()
  await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'nb-1', style: 'fast' })
  assert.equal(db.docs(COLLECTIONS.books).length, 0)
})

// --------------------------------------------------------------- the route

function routeCall(body: Record<string, unknown>): {
  ctx: RouteCtx
  sent: { status: number; body: unknown }[]
} {
  const sent: { status: number; body: unknown }[] = []
  const ctx = {
    req: {} as RouteCtx['req'],
    res: {} as RouteCtx['res'],
    url: new URL('http://x/v1/desk/close-all'),
    path: '/v1/desk/close-all',
    method: 'POST',
    principal: { kind: 'user', name: 'operator' } as const,
    log: () => {},
    readJson: async () => body,
    send: (status: number, b: unknown) => {
      sent.push({ status, body: b })
    },
  } satisfies RouteCtx
  return { ctx, sent }
}

function routes(): ReturnType<typeof deskRoutes> {
  const deps: ApiDeps & { gate: AuthGate } = {
    db,
    store,
    service: svc,
    master: { current: master },
    log: () => {},
    now: () => clockMs,
    gate: { reauth: async () => null } as unknown as AuthGate,
  }
  return deskRoutes(deps)
}

test('POST /v1/desk/close-all with a TAG flattens the hosted position', async () => {
  await seedTrappedPosition()
  await svc.patchStrategy(TAG, { modes: { paper: { enabled: false } } })
  const { ctx, sent } = routeCall({
    tag: TAG, mode: MODE, style: 'fast', decisionId: 'http-1',
  })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 200)
  const body = sent[0]?.body as { flat: boolean; legs: unknown[] }
  assert.equal(body.flat, true)
  assert.equal(body.legs.length, 1)
  assert.equal(paper.routed.length, 1)
})

test('a body with NEITHER symbol nor tag is refused rather than guessed at', async () => {
  const { ctx, sent } = routeCall({ mode: MODE, style: 'fast', decisionId: 'http-2' })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 400)
  assert.match(String((sent[0]?.body as { error: string }).error), /symbol.*tag|tag.*symbol/)
})

test('style must still be stated explicitly on the tag path', async () => {
  const { ctx, sent } = routeCall({ tag: TAG, mode: MODE, decisionId: 'http-3' })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 400)
  assert.match(String((sent[0]?.body as { error: string }).error), /style must be stated/)
})

test('mode and decisionId are still required on the tag path', async () => {
  const noMode = routeCall({ tag: TAG, style: 'fast', decisionId: 'http-4' })
  assert.equal(await routes()(noMode.ctx), true)
  assert.equal(noMode.sent[0]?.status, 400)

  const noId = routeCall({ tag: TAG, mode: MODE, style: 'fast' })
  assert.equal(await routes()(noId.ctx), true)
  assert.equal(noId.sent[0]?.status, 400)
  assert.match(String((noId.sent[0]?.body as { error: string }).error), /decisionId is required/)
})

test('a body with a SYMBOL takes the book path, and `tag` keeps its old meaning', async () => {
  const deskTag = 'DESK_BANKNIFTY'
  await store.registerStrategy(
    { tag: deskTag, kind: 'external', modes: { paper: { enabled: true } } },
    OPENED,
  )
  await svc.applyDecision({
    symbol: 'BANKNIFTY', expiry: EXPIRY, mode: MODE, tag: deskTag, decisionId: 'http-seed',
    actions: [{ op: 'open', ts: 'CE57000#0', strike: 57_000, type: 'CE', side: 'Sell', qty: LOT }],
  })
  const { ctx, sent } = routeCall({
    symbol: 'BANKNIFTY', tag: deskTag, mode: MODE, style: 'fast', decisionId: 'http-5',
  })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 200)
  const body = sent[0]?.body as { fills: unknown[]; book: unknown[] }
  assert.equal(body.fills.length, 1)
  assert.equal(body.book.length, 0, 'the symbol path still returns the emptied book')
})

// ------------------------------- the body the dashboard actually sends (B1)

/**
 * WHAT THE DASHBOARD SENDS IS `{symbol, mode, style, decisionId}` — NO TAG.
 *
 * `apps/web/src/api.ts`'s `closeAll` has never sent one, and no test here ever
 * sent a symbol-only body either, which is why this shipped: the route filled
 * the gap with a synthesised `DESK_${symbol}`, and once books were re-keyed by
 * tag that string was the BOOK KEY. It named a book that does not exist, so
 * `loadBook` answered `[]`, `planCloseAll` planned nothing, and the endpoint
 * returned `200 {"status":"DONE","fills":[],"book":[]}` — which `closeAllFailed`
 * reads as success — over a book still holding a leg. It also left a phantom
 * `{tag:'DESK_BHEL', legs:[]}` document behind.
 *
 * The three cases below are the whole of what a symbol can mean now.
 */
async function seedSymbolBook(
  tag: string,
  decisionId: string,
  // Only the two contracts `MARKS` prices are usable: an unmarked strike is
  // SKIPPED, which would leave a book document with no legs and quietly turn a
  // two-book test into a one-book one.
  leg: { strike: number; type: 'CE' | 'PE' } = { strike: 57_000, type: 'CE' },
): Promise<void> {
  await store.registerStrategy(
    { tag, kind: 'external', modes: { paper: { enabled: true } } },
    OPENED,
  )
  const res = await svc.applyDecision({
    symbol: 'BANKNIFTY', expiry: EXPIRY, mode: MODE, tag, decisionId,
    actions: [
      { op: 'open', ts: `${leg.type}${leg.strike}#0`, strike: leg.strike, type: leg.type, side: 'Sell', qty: LOT },
    ],
  })
  assert.equal(res.fills.length, 1, 'the fixture must actually open a leg')
}

test('a SYMBOL-ONLY close-all resolves the one book on that symbol and flattens it', async () => {
  const tag = 'BANKNIFTY-2026-07-30-orb-v1'
  await seedSymbolBook(tag, 'sym-seed-1')
  assert.equal((await store.loadBook(tag, MODE)).length, 1)

  // Exactly the body `api.closeAll(symbol, mode, style)` posts.
  const { ctx, sent } = routeCall({
    symbol: 'BANKNIFTY', mode: MODE, style: 'fast', decisionId: 'ui-close-BANKNIFTY-1',
  })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 200)
  const body = sent[0]?.body as { fills: unknown[]; book: unknown[] }
  assert.equal(body.fills.length, 1, 'the leg was actually closed')
  assert.equal(body.book.length, 0)
  assert.equal((await store.loadBook(tag, MODE)).length, 0, 'the REAL book is the one emptied')
  assert.equal(paper.routed.length, 2, 'the open, then the close')
  // The synthesised key must be gone for good: no book was invented under it.
  assert.equal(await db.collection(COLLECTIONS.books).countDocuments({ tag: 'DESK_BANKNIFTY' }), 0)
})

test('a SYMBOL-ONLY close-all with NO book is refused — never a DONE with no fills', async () => {
  const { ctx, sent } = routeCall({
    symbol: 'BANKNIFTY', mode: MODE, style: 'fast', decisionId: 'ui-close-BANKNIFTY-2',
  })
  assert.equal(await routes()(ctx), true)
  // 409, not 404 and above all not 200: an operator reading this must not be
  // able to take it as "already flat".
  assert.equal(sent[0]?.status, 409)
  const body = sent[0]?.body as { error: string; candidates: string[] }
  assert.match(body.error, /BANKNIFTY/, 'the refusal names the symbol')
  assert.match(body.error, /NOTHING WAS CLOSED/)
  assert.deepEqual(body.candidates, [])
  assert.equal(paper.routed.length, 0)
  // No phantom document: the old path upserted `{tag:'DESK_BANKNIFTY', legs:[]}`
  // as a side effect of "closing" a book it never found.
  assert.equal(db.docs(COLLECTIONS.books).length, 0)
})

test('a SYMBOL-ONLY close-all over TWO books on one symbol is refused, naming both', async () => {
  const a = 'BANKNIFTY-2026-07-30-orb-v1'
  const b = 'BANKNIFTY-2026-07-30-orb-v2'
  await seedSymbolBook(a, 'sym-seed-a', { strike: 57_000, type: 'CE' })
  await seedSymbolBook(b, 'sym-seed-b', { strike: 56_000, type: 'PE' })

  const { ctx, sent } = routeCall({
    symbol: 'BANKNIFTY', mode: MODE, style: 'fast', decisionId: 'ui-close-BANKNIFTY-3',
  })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 409)
  const body = sent[0]?.body as { error: string; candidates: string[] }
  assert.deepEqual(body.candidates, [a, b], 'the operator is given the tags to choose between')
  assert.match(body.error, new RegExp(a))
  assert.match(body.error, new RegExp(b))
  // Neither book may be touched: picking one for the operator is how the wrong
  // book gets flattened.
  assert.equal((await store.loadBook(a, MODE)).length, 1)
  assert.equal((await store.loadBook(b, MODE)).length, 1)
  assert.equal(paper.routed.length, 2, 'the two opens, and nothing else')
})

/**
 * A NAMED TAG MUST NAME A REAL BOOK (audit F-22).
 *
 * The dashboard sends `tag` alongside `symbol`, so the branch that trusted it
 * outright was the hot path — and it skipped every one of the refusals the
 * tagless branch earned. A mistyped tag loaded an empty book, closed nothing,
 * answered 200 DONE, and left a phantom row with a blank expiry behind.
 */
test('a SYMBOL close-all naming an UNKNOWN tag is refused, and closes nothing', async () => {
  const tag = 'BANKNIFTY-2026-07-30-orb-v1'
  await seedSymbolBook(tag, 'unknown-tag-seed')

  const { ctx, sent } = routeCall({
    symbol: 'BANKNIFTY',
    tag: 'BANKNIFTY-2026-07-30-orb-v11',
    mode: MODE,
    style: 'fast',
    decisionId: 'ui-close-typo-1',
  })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 409)
  const body = sent[0]?.body as { error: string; candidates: string[] }
  assert.match(body.error, /NOTHING WAS CLOSED/)
  assert.deepEqual(body.candidates, [tag], 'the operator is given the real tags')
  assert.equal(paper.routed.length, 1, 'only the seeding open — no exit went out')
  // The real book is untouched, and no phantom document was minted under the typo.
  assert.equal((await store.loadBook(tag, MODE)).length, 1)
  assert.equal(
    await db.collection(COLLECTIONS.books).countDocuments({
      tag: 'BANKNIFTY-2026-07-30-orb-v11',
    }),
    0,
  )
})

test('a SYMBOL close-all naming a KNOWN tag still flattens it', async () => {
  const tag = 'BANKNIFTY-2026-07-30-orb-v1'
  await seedSymbolBook(tag, 'known-tag-seed')
  const { ctx, sent } = routeCall({
    symbol: 'BANKNIFTY', tag, mode: MODE, style: 'fast', decisionId: 'ui-close-known-1',
  })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 200)
  assert.equal((await store.loadBook(tag, MODE)).length, 0)
})

test('closeAll on a tag with NO book document refuses rather than minting one', async () => {
  // Belt and braces under the route's 409: `saveBook` upserts, so proceeding
  // with a null book writes a row with a blank expiry.
  await assert.rejects(
    svc.closeAll({
      symbol: 'BANKNIFTY', mode: MODE, tag: 'NO_SUCH_BOOK', decisionId: 'no-book-1', style: 'fast',
    }),
    /no paper book stored under tag 'NO_SUCH_BOOK'/,
  )
  assert.equal(db.docs(COLLECTIONS.books).length, 0)
})

// ------------------------------------------ the flat book's expiry (B3)

/**
 * A CLOSE-ALL OVER AN ALREADY-FLAT BOOK MUST NOT BLANK THE EXPIRY.
 *
 * `closeAll` derived the expiry from `book[0]`, so a book with no legs gave
 * `''` — which is not nullish, so it beats marketdata's
 * `book.expiry ?? legs[0]?.expiry`, and `planSubscriptions` gates on
 * `expiry !== undefined`, so `''` passes and `strikes(underlying, '')` returns
 * nothing. No chain subscribed, no marks, and the book can never open its next
 * leg — the Task 6 defect, reached through close-all instead.
 */
test('flattening an already-flat book leaves the stored expiry intact', async () => {
  const tag = 'BANKNIFTY-2026-07-30-orb-v1'
  await seedSymbolBook(tag, 'exp-seed')
  await svc.closeAll({ symbol: 'BANKNIFTY', mode: MODE, tag, decisionId: 'exp-close-1', style: 'fast' })
  assert.equal((await store.loadBook(tag, MODE)).length, 0, 'the book is flat now')
  assert.equal((await store.bookDoc(tag, MODE))?.expiry, EXPIRY)

  // The second close-all is the dangerous one: nothing to derive an expiry from.
  const again = await svc.closeAll({
    symbol: 'BANKNIFTY', mode: MODE, tag, decisionId: 'exp-close-2', style: 'fast',
  })
  assert.equal(again.fills.length, 0)
  assert.equal(
    (await store.bookDoc(tag, MODE))?.expiry,
    EXPIRY,
    'the flat book keeps its expiry, or it can never subscribe a chain again',
  )
})

test('saveBook refuses to overwrite a stored expiry with an empty one', async () => {
  const tag = 'BANKNIFTY-2026-07-30-orb-v1'
  await store.saveBook({ tag, mode: MODE, symbol: 'BANKNIFTY', expiry: EXPIRY }, [], 1)
  // The last line of defence: any caller that loses the expiry on the way here
  // leaves the stored one alone rather than erasing it.
  await store.saveBook({ tag, mode: MODE, symbol: 'BANKNIFTY', expiry: '' }, [], 2)
  assert.equal((await store.bookDoc(tag, MODE))?.expiry, EXPIRY)
})

// ------------------------------------------------- the truncation guard

/**
 * A WINDOW THAT MISSES THE OPENS MUST NOT PRODUCE AN ORDER.
 *
 * The position is reconstructed from fills. A window starting after the opens
 * but before the closes sees only buy-backs, which net to a LONG that was never
 * held — and "flattening" that sends a SELL, opening a naked short while trying
 * to close nothing. That is strictly worse than leaving the leg open: it creates
 * exposure the operator did not ask for and does not know about.
 *
 * `StampedFill.op` is the only thing in the reconstructed data that can reveal
 * this, which is why it is carried through `loadFills`.
 */
test('a window that misses the opens routes NOTHING and names the leg', async () => {
  // The open is BEFORE the window; only the buy-back falls inside it.
  await journalSubmit({
    clientOrderId: 'trunc-open', side: 'Sell', tradingsymbol: CE,
    qty: 5 * LOT, price: 130, createdAt: OPENED - 60_000,
  })
  await journalSubmit({
    clientOrderId: 'trunc-close', side: 'Buy', tradingsymbol: CE,
    qty: 5 * LOT, price: 120, createdAt: OPENED, reducesExposure: true,
  })

  const res = await svc.flattenTag({
    tag: TAG, mode: MODE, decisionId: 'flat-trunc', style: 'fast',
    // Starts after the open, so the rebuild sees a buy with no sell to net it.
    sinceMs: OPENED - 1_000,
  })

  assert.deepEqual(res.truncated, [CE], 'the leg must be named, not silently dropped')
  assert.equal(res.legs.length, 0, 'and no order may be planned for it')
  assert.equal(paper.routed.length, 0, 'above all: nothing reaches a rail')
  assert.equal(res.flat, false, 'a held-back leg is not a flat book')
})

test('the same position with a window covering the opens flattens normally', async () => {
  await journalSubmit({
    clientOrderId: 'ok-open', side: 'Sell', tradingsymbol: CE,
    qty: 5 * LOT, price: 130, createdAt: OPENED - 60_000,
  })
  const res = await svc.flattenTag({
    tag: TAG, mode: MODE, decisionId: 'flat-ok', style: 'fast',
    sinceMs: OPENED - 120_000,
  })
  assert.deepEqual(res.truncated, [])
  assert.equal(paper.routed.length, 1)
  assert.equal(res.flat, true)
})

// -------------------------------------------- the truncation guard's ops (A8)

/**
 * WHICH OPS CAN OPEN A POSITION — and why `op === 'open'` alone was both too
 * strict and not the whole answer.
 *
 * The guard exists because a window that starts after the opens sees only
 * buy-backs, nets to a position that was never held, and "flattening" that
 * opens fresh exposure in the opposite direction. Its evidence is the first
 * fill's `op`. Demanding literally `'open'` held back forever a leg that had
 * never BEEN opened by an `open` — a strike a `roll` moved into is established
 * by a fill stamped `roll`, and no width of window ever turns it into an
 * `open`. That is the trapped position this whole path exists to undo,
 * reintroduced by the guard meant to make it safe.
 *
 * `roll` cannot be waved through wholesale either: `applyActions` stamps BOTH
 * halves `roll` — the buy-back of the old strike and the sale of the new one —
 * and they are indistinguishable by op, by side, and by the sign of the
 * position they net to. They are distinguishable by ORDER: the close is pushed
 * first, always in the same document, so within a run of same-instant roll
 * fills the odd ones are the openers.
 */
async function journalRoll(opts: {
  clientOrderId: string
  from: string
  to: string
  qty: number
  side: DeskSide
  createdAt: number
}): Promise<void> {
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: opts.clientOrderId,
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    // Exactly the pair `applyActions` emits: the OLD leg's buy-back first, then
    // the NEW leg opened on the original side.
    fills: [
      {
        op: 'roll',
        deskTag: 'old',
        tradingsymbol: opts.from,
        side: opts.side === 'Sell' ? 'Buy' : 'Sell',
        qty: opts.qty,
        price: 100,
        ts: opts.createdAt,
      },
      {
        op: 'roll',
        deskTag: 'new',
        tradingsymbol: opts.to,
        side: opts.side,
        qty: opts.qty,
        price: 90,
        ts: opts.createdAt,
      },
    ],
    skips: [],
    createdAt: opts.createdAt,
    status: 'DONE',
  })
}

test('a strike a ROLL opened is flattenable — it is not held back forever', async () => {
  // The window contains the roll and nothing before it. `PE56000` is short 5
  // lots, established by the roll's second fill, and there is no wider window
  // that would ever show an `open` for it.
  await journalRoll({
    clientOrderId: 'roll-1',
    from: CE,
    to: PE,
    qty: 5 * LOT,
    side: 'Sell',
    createdAt: OPENED,
  })

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-roll', style: 'fast' })

  const rolledInto = r.legs.find((l) => l.tradingsymbol === PE)
  assert.equal(rolledInto?.positionQty, -5 * LOT, 'short the strike the roll moved into')
  assert.equal(rolledInto?.side, 'Buy')
  assert.equal(rolledInto?.routed, true, 'a rolled-into leg must be closable')
  assert.ok(paper.routed.some((o) => o.fill.tradingsymbol === PE))
})

test('the strike a ROLL left is HELD BACK — its buy-back is not an open', async () => {
  /**
   * The other half of the same document. `CE57000` was bought back, so within
   * this window it nets to a LONG that was never held; flattening it would SELL
   * and open a naked short. It is named, and no order is planned for it.
   */
  await journalRoll({
    clientOrderId: 'roll-2',
    from: CE,
    to: PE,
    qty: 5 * LOT,
    side: 'Sell',
    createdAt: OPENED,
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-roll-2', style: 'fast' })

  assert.deepEqual(r.truncated, [CE], 'the leg the roll left is named, never traded')
  assert.equal(r.flat, false, 'a held-back leg is not a flat book')
  assert.equal(
    paper.routed.filter((o) => o.fill.tradingsymbol === CE).length,
    0,
    'above all: no SELL for a long that was never held',
  )
})

test('a first fill of RESIZE is suspect — a resize proves an open we cannot see', async () => {
  // `resize` cannot establish a position by definition: it resizes a leg that
  // already exists. Seeing one first therefore proves the opens fell outside
  // the window, which is exactly the condition the guard is for.
  await db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'resize-1',
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: MODE,
    tag: TAG,
    fills: [
      { op: 'resize', deskTag: 'r', tradingsymbol: CE, side: 'Buy', qty: 2 * LOT, price: 118, ts: OPENED },
    ],
    skips: [],
    createdAt: OPENED,
    status: 'DONE',
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-resize', style: 'fast' })
  assert.deepEqual(r.truncated, [CE])
  assert.equal(r.legs.length, 0)
  assert.equal(paper.routed.length, 0)
})

test('a roll AFTER a visible open still flattens — the open is what decides', async () => {
  // The ordinary case, and the one the guard must not break: the position was
  // opened inside the window and later rolled. Both strikes are reconstructed
  // from an `open` or a roll-in, and the net is whatever survived.
  await seedTrappedPosition() // sells 5 lots of CE at 09:30
  await journalRoll({
    clientOrderId: 'roll-3',
    from: CE,
    to: PE,
    qty: 5 * LOT,
    side: 'Sell',
    createdAt: OPENED + 60_000,
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-roll-3', style: 'fast' })
  assert.deepEqual(r.truncated, [], 'nothing is suspect: the CE was opened in-window')
  assert.deepEqual(
    r.legs.map((l) => l.tradingsymbol),
    [PE],
    'the CE netted flat when it was rolled out of; only the new strike is open',
  )
  assert.equal(r.flat, true)
})

// ------------------------------------------------- a malformed request body

test('a JSON null body is a 400, not a 500 — on close-all', async () => {
  /**
   * `server.ts:readBody` substitutes `{}` only for an EMPTY body, so a literal
   * `null` arrives as itself and the first `body['symbol']` read throws a
   * TypeError the dispatcher can only turn into a 500. On this endpoint and the
   * kill switch above all: a caller cannot tell a 500 from "the desk is broken",
   * and both are reachable without a password.
   */
  for (const body of [null, 'a string', [1, 2, 3], 42] as unknown[]) {
    const { ctx, sent } = routeCall(body as Record<string, unknown>)
    assert.equal(await routes()(ctx), true, JSON.stringify(body))
    assert.equal(sent[0]?.status, 400, `body ${JSON.stringify(body)} must be a 400`)
    assert.match(String((sent[0]?.body as { error: string }).error), /symbol.*tag|tag.*symbol/)
  }
})

test('a JSON null body is a 400, not a 500 — on the kill switch', async () => {
  for (const body of [null, 'a string', [1, 2, 3]] as unknown[]) {
    const sent: { status: number; body: unknown }[] = []
    const ctx = {
      req: {} as RouteCtx['req'],
      res: {} as RouteCtx['res'],
      url: new URL('http://x/v1/desk/killswitch'),
      path: '/v1/desk/killswitch',
      method: 'POST',
      principal: { kind: 'user', name: 'operator' } as const,
      log: () => {},
      readJson: async () => body,
      send: (status: number, b: unknown) => {
        sent.push({ status, body: b })
      },
    } satisfies RouteCtx
    assert.equal(await routes()(ctx), true, JSON.stringify(body))
    assert.equal(sent[0]?.status, 400, `body ${JSON.stringify(body)} must be a 400`)
    assert.match(String((sent[0]?.body as { error: string }).error), /enabled must be a boolean/)
  }
  // ...and the halt was NOT engaged by a malformed request.
  assert.equal((await svc.killSwitch()).enabled, false)
})

// ------------------------------------------------- the derived underlying

test('the underlying a flatten routes under is the REAL key, not the leading letters', async () => {
  /**
   * `flattenTag` derives the underlying per leg — it has no caller-supplied one,
   * because it flattens by tag across whatever symbols the fills mention. That
   * value becomes the order's `underlying`, which is what the gateway falls back
   * to for the FREEZE-TABLE lookup whenever the instrument master cannot resolve
   * the contract (a weekly listed this morning, a stale master). `NIFTYNXT` is
   * not a key in `qtyfreeze.csv`, so the lookup missed the table entirely and
   * the order went out unsplit — which the exchange rejects outright.
   *
   * It is also `desk-decisions.symbol`, the filter `/v1/desk/decisions?symbol=`
   * uses, so a wrong value files the record under a book nobody can find.
   */
  await journalSubmit({
    clientOrderId: 'nxt-open',
    side: 'Sell',
    tradingsymbol: NXT,
    qty: 25,
    price: 40,
  })
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-nxt', style: 'fast' })

  assert.equal(r.legs.length, 1)
  assert.equal(r.legs[0]?.routed, true)
  assert.equal(paper.routed[0]?.ctx.underlying, 'NIFTYNXT50', 'the NSE key, never the letter prefix')
  const doc = db.docs(COLLECTIONS.decisions).find((d) => d['decisionId'] === 'flat-nxt')
  assert.equal(doc?.['symbol'], 'NIFTYNXT50')
})

test('a flatten spanning two underlyings files under NEITHER rather than misfiling one', async () => {
  // `desk-decisions.symbol` is a single filter key. Naming one underlying for a
  // mixed flatten would misfile the rest, so the field is left empty and the
  // per-leg orders carry their own.
  await seedTrappedPosition()
  await journalSubmit({ clientOrderId: 'nxt-2', side: 'Sell', tradingsymbol: NXT, qty: 25, price: 40 })
  await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-mixed', style: 'fast' })

  const doc = db.docs(COLLECTIONS.decisions).find((d) => d['decisionId'] === 'flat-mixed')
  assert.equal(doc?.['symbol'], '')
  assert.deepEqual(
    paper.routed.map((o) => o.ctx.underlying).sort(),
    ['BANKNIFTY', 'NIFTYNXT50'],
  )
})

// ------------------------------------------- the book a flatten leaves behind

/**
 * BAJFINANCE, 2026-07-31. The flatten worked — all four legs netted to zero in
 * the trade log — and `desk-books` still recorded all four opens. The Positions
 * page drew a position that no longer existed, delta and P&L were computed off
 * it, and the book could not be deleted because the delete guard reads the same
 * record.
 *
 * `submit` grew this maintenance first, and it could never reach here: this
 * method routes on `rail.route` directly rather than going through `submit`.
 * Verified on prod — the flatten ran 23 seconds AFTER the process carrying the
 * submit fix started, and the book was still stale. Hence a test on THIS path.
 *
 * The method's own header says "NO BOOK IS WRITTEN. A hosted strategy never had
 * one", which is true of a hosted strategy and false of an EXTERNAL book built
 * through the Build screen — flattened by the same button.
 */
async function seedBookHolding(qty: number): Promise<void> {
  await store.saveBook(
    { tag: TAG, mode: MODE, symbol: 'BANKNIFTY', expiry: EXPIRY },
    [
      {
        deskTag: 'CE57000#seed',
        instrument: { tradingsymbol: CE, instrumentToken: 57_001, lotSize: LOT, tickSize: 0.05, exchange: 'NFO' },
        underlying: 'BANKNIFTY',
        expiry: EXPIRY,
        strike: 57_000,
        type: 'CE',
        side: qty > 0 ? 'Buy' : 'Sell',
        qty,
        entryPrice: 130,
        openedTs: OPENED,
      },
    ],
    OPENED,
  )
}

test('flattening an EXTERNAL book removes the closed leg from desk-books', async () => {
  await seedTrappedPosition()
  await seedBookHolding(-5 * LOT)

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-book-1', style: 'fast' })
  assert.equal(r.flat, true)

  const doc = await store.bookDoc(TAG, MODE)
  assert.deepEqual(doc?.legs, [], 'the book must not keep describing a position that was just closed')
})

test('a book holding the SAME contract twice is emptied by the one netted close', async () => {
  /**
   * F-26 end to end. `planFlatten` nets a position into ONE order per contract,
   * and a book legally holds that contract on several legs (`recenter-relief`
   * buys one back on one leg while another still carries it). The fold used to
   * put the whole netted quantity through the FIRST matching leg and flip its
   * side: `Sell 3 lots` + `Sell 2 lots` closed by `Buy 5 lots` left
   * `[Buy 2 lots, Sell 2 lots]` — two positions the desk does not hold, and
   * "Close leg" over them routes two more REAL orders.
   */
  await journalSubmit({ clientOrderId: 'split-open', side: 'Sell', tradingsymbol: CE, qty: 5 * LOT, price: 120 })
  const leg = (deskTag: string, qty: number): BridgeLeg => ({
    deskTag,
    instrument: { tradingsymbol: CE, instrumentToken: 57_001, lotSize: LOT, tickSize: 0.05, exchange: 'NFO' },
    underlying: 'BANKNIFTY',
    expiry: EXPIRY,
    strike: 57_000,
    type: 'CE',
    side: 'Sell',
    qty,
    entryPrice: 130,
    openedTs: OPENED,
  })
  await store.saveBook(
    { tag: TAG, mode: MODE, symbol: 'BANKNIFTY', expiry: EXPIRY },
    [leg('CE57000#a', -3 * LOT), leg('CE57000#b', -2 * LOT)],
    OPENED,
  )

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-split', style: 'fast' })
  assert.equal(r.flat, true)
  assert.equal(paper.routed.length, 1, 'one netted order per contract, as before')
  assert.deepEqual((await store.bookDoc(TAG, MODE))?.legs, [], 'both legs go — neither flips')
})

test('the book survives with its identity — only the legs go', async () => {
  await seedTrappedPosition()
  await seedBookHolding(-5 * LOT)
  await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-book-2', style: 'fast' })
  const doc = await store.bookDoc(TAG, MODE)
  // Blanking symbol or expiry here is the Task 6 defect reached through a
  // different door: an empty expiry subscribes no chain at all.
  assert.equal(doc?.symbol, 'BANKNIFTY')
  assert.equal(doc?.expiry, EXPIRY)
})

test('a tag with NO book is still flattened, and none is invented for it', async () => {
  // The hosted case the header describes, which must keep working untouched.
  await seedTrappedPosition()
  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-book-3', style: 'fast' })
  assert.equal(r.flat, true)
  assert.equal(await store.bookDoc(TAG, MODE), null)
})

// ------------------------------------ losing the race for desk-books (F-27)

/**
 * THE ITC DESYNC SHAPE (2026-08-03). `desk-books` is a whole-document
 * read-modify-write: read at `service.ts:353`, gated, N orders routed, written
 * back at `:554`. An operator's "Close leg" — or a flatten, or a Build-screen
 * Place — landing inside that window was silently discarded by whichever writer
 * finished last, and the leg it had just closed came back.
 *
 * The write is now a compare-and-set on `updatedAt`, and a conflict is not an
 * error: the losing writer re-reads the book, folds ITS OWN routed fills onto
 * the winner's legs, and writes once more. Both writers' effects survive,
 * because both of them describe orders that really went out.
 */
const OPERATOR_LEG_SYMBOL = 'BANKNIFTY26JUL56500CE'

function operatorLeg(deskTag: string): BridgeLeg {
  return {
    deskTag,
    instrument: {
      tradingsymbol: OPERATOR_LEG_SYMBOL,
      instrumentToken: 56_501,
      lotSize: LOT,
      tickSize: 0.05,
      exchange: 'NFO',
    },
    underlying: 'BANKNIFTY',
    expiry: EXPIRY,
    strike: 56_500,
    type: 'CE',
    side: 'Sell',
    qty: -LOT,
    entryPrice: 90,
    openedTs: OPENED,
  }
}

function booksCollection(): FakeCollection<Record<string, unknown>> {
  db.collection(COLLECTIONS.books)
  return db.collections.get(COLLECTIONS.books) as FakeCollection<Record<string, unknown>>
}

/** Another writer lands ONCE, in the window before our next book write. */
function landConcurrentWrite(extra: BridgeLeg): void {
  const books = booksCollection()
  books.beforeUpdate = (): void => {
    books.beforeUpdate = null
    for (const doc of books.docs) {
      doc['legs'] = [...(doc['legs'] as BridgeLeg[]), extra]
      doc['updatedAt'] = (doc['updatedAt'] as number) + 500
    }
  }
}

async function seedDeskBook(deskTag: string, decisionId: string): Promise<void> {
  await store.registerStrategy(
    { tag: deskTag, kind: 'external', modes: { paper: { enabled: true } } },
    OPENED,
  )
  await svc.applyDecision({
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: MODE,
    tag: deskTag,
    decisionId,
    actions: [{ op: 'open', ts: 'CE57000#0', strike: 57_000, type: 'CE', side: 'Sell', qty: LOT }],
  })
}

test('an applyDecision that LOSES the book write re-folds onto the fresh legs', async () => {
  const deskTag = 'DESK_BANKNIFTY'
  await seedDeskBook(deskTag, 'race-seed')
  landConcurrentWrite(operatorLeg('OPERATOR#9'))

  const res = await svc.applyDecision({
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: MODE,
    tag: deskTag,
    decisionId: 'race-open',
    actions: [{ op: 'open', ts: 'PE56000#1', strike: 56_000, type: 'PE', side: 'Sell', qty: LOT }],
  })

  assert.equal(res.status, 'DONE')
  const legs = await store.loadBook(deskTag, MODE)
  assert.deepEqual(
    legs.map((l) => l.deskTag).sort(),
    ['CE57000#0', 'OPERATOR#9', 'PE56000#1'],
    'the winner’s leg and ours both survive',
  )
})

test('a CLOSE that loses the book write still removes the leg from the winner’s book', async () => {
  const deskTag = 'DESK_BANKNIFTY'
  await seedDeskBook(deskTag, 'race-seed-2')
  landConcurrentWrite(operatorLeg('OPERATOR#9'))

  await svc.applyDecision({
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: MODE,
    tag: deskTag,
    decisionId: 'race-close',
    actions: [{ op: 'close', ts: 'CE57000#0' }],
  })

  const legs = await store.loadBook(deskTag, MODE)
  assert.deepEqual(legs.map((l) => l.deskTag), ['OPERATOR#9'], 'the close is not undone by the retry')
})

test('a flatten fold that loses the book write re-folds onto the fresh book', async () => {
  await seedTrappedPosition()
  await seedBookHolding(-5 * LOT)
  landConcurrentWrite(operatorLeg('OPERATOR#9'))

  const r = await svc.flattenTag({ tag: TAG, mode: MODE, decisionId: 'flat-race', style: 'fast' })
  assert.equal(r.flat, true)
  const doc = await store.bookDoc(TAG, MODE)
  assert.deepEqual(doc?.legs.map((l) => l.deskTag), ['OPERATOR#9'])
})

test('a book write that loses TWICE is loud, and the DECISION record stands', async () => {
  const deskTag = 'DESK_BANKNIFTY'
  await seedDeskBook(deskTag, 'race-seed-3')
  // A writer that never stops winning: both the write and its one retry lose.
  const books = booksCollection()
  books.beforeUpdate = (): void => {
    for (const doc of books.docs) doc['updatedAt'] = (doc['updatedAt'] as number) + 500
  }
  const errors: string[] = []
  const realError = console.error
  console.error = (...args: unknown[]): void => {
    errors.push(args.map((a) => String(a)).join(' '))
  }
  let res
  try {
    res = await svc.applyDecision({
      symbol: 'BANKNIFTY',
      expiry: EXPIRY,
      mode: MODE,
      tag: deskTag,
      decisionId: 'race-lost',
      actions: [{ op: 'open', ts: 'PE56000#1', strike: 56_000, type: 'PE', side: 'Sell', qty: LOT }],
    })
  } finally {
    console.error = realError
    books.beforeUpdate = null
  }

  // The order routed, so the decision record — which every P&L reader loads —
  // must say so. Losing the BOOK write may not un-book a real order.
  assert.equal(res.status, 'DONE')
  assert.equal(res.fills.length, 1)
  assert.equal(paper.routed.length, 2, 'the open still went out')
  const stored = db.docs(COLLECTIONS.decisions).find((d) => d['decisionId'] === 'race-lost')
  assert.equal(stored?.['status'], 'DONE')
  assert.match(errors.join('\n'), /lost two races/)
})

// ------------------------------------- delete?flatten=1 on a positional book

/**
 * THE NIFTY BOOK THAT COULD NOT BE DELETED (2026-08-03). "Delete + clear
 * history" sends `?flatten=1`, whose promise is close-then-delete in one act.
 * The route's own guard reads EVERY fill that exists, but the flatten it
 * triggers used `flattenTag`'s default one-trading-day window — so a
 * positional book whose opens were journalled on an earlier day flattened
 * NOTHING, and the unbounded re-read then refused the delete. The two reads
 * must cover the same window, or they disagree about the same position.
 */

const BOOK_TAG = 'BANKNIFTY-2026-07-30-recenter-r'

function bookRouteCall(method: string, pathAndQuery: string, body?: Record<string, unknown>): {
  ctx: RouteCtx
  sent: { status: number; body: unknown }[]
} {
  const sent: { status: number; body: unknown }[] = []
  const url = new URL(`http://x${pathAndQuery}`)
  const ctx = {
    req: {} as RouteCtx['req'],
    res: {} as RouteCtx['res'],
    url,
    path: url.pathname,
    method,
    principal: { kind: 'user', name: 'operator' } as const,
    log: () => {},
    readJson: async () => body ?? {},
    send: (status: number, b: unknown) => {
      sent.push({ status, body: b })
    },
  } satisfies RouteCtx
  return { ctx, sent }
}

function bookRoutes(): ReturnType<typeof booksRoutes> {
  const deps = {
    db: db as unknown as ApiDeps['db'],
    store,
    service: svc,
    master: { current: master },
    log: () => {},
    now: () => clockMs,
    /*
      The password gate `booksRoutes` re-authenticates a LIVE dials patch
      against (F-29). Nothing in THIS file patches dials, and every book here
      is paper, so it is never consulted — it refuses by default rather than
      passing, so a future test that does reach it fails loudly instead of
      quietly proving nothing.
    */
    gate: {
      authenticate: async () => ({ kind: 'user' as const, name: 'operator' }),
      reauth: async () => 'this fixture cannot re-authenticate',
    },
  } as unknown as Parameters<typeof booksRoutes>[0]
  return booksRoutes(deps)
}

async function registerPositionalBook(): Promise<void> {
  const { ctx, sent } = bookRouteCall('POST', '/v1/desk/books/registry', {
    tag: BOOK_TAG,
    symbol: 'BANKNIFTY',
    expiry: EXPIRY,
    mode: 'paper',
    variant: 'recenter-r',
    dials: { target_pnl: 150000, margin_cap: 10000000 },
  })
  assert.equal(await bookRoutes()(ctx), true)
  assert.equal(sent[0]?.status, 201, JSON.stringify(sent[0]?.body))
}

test('delete?flatten=1 closes a position opened on an EARLIER day, then deletes', async () => {
  await registerPositionalBook()
  // The book's one open is three days old — a positional book held across
  // sessions, exactly what the registry exists for.
  await journalSubmit({
    clientOrderId: 'pos-open-1',
    side: 'Sell',
    tradingsymbol: CE,
    qty: 5 * LOT,
    price: 130,
    createdAt: NOW - 3 * 86_400_000,
    tag: BOOK_TAG,
  })

  const { ctx, sent } = bookRouteCall(
    'DELETE',
    `/v1/desk/books/registry/${BOOK_TAG}?mode=paper&flatten=1`,
  )
  assert.equal(await bookRoutes()(ctx), true)
  assert.equal(sent[0]?.status, 200, JSON.stringify(sent[0]?.body))
  assert.equal(paper.routed.length, 1, 'the flatten must actually route the close')
  assert.equal(await store.getBook(BOOK_TAG, 'paper'), null, 'the book must be gone')
})

test('delete WITHOUT flatten still refuses the same prior-day position', async () => {
  // The guard's window was always right — this pins that widening the flatten
  // did not widen anything else.
  await registerPositionalBook()
  await journalSubmit({
    clientOrderId: 'pos-open-2',
    side: 'Sell',
    tradingsymbol: CE,
    qty: 5 * LOT,
    price: 130,
    createdAt: NOW - 3 * 86_400_000,
    tag: BOOK_TAG,
  })

  const { ctx, sent } = bookRouteCall(
    'DELETE',
    `/v1/desk/books/registry/${BOOK_TAG}?mode=paper`,
  )
  assert.equal(await bookRoutes()(ctx), true)
  assert.equal(sent[0]?.status, 409)
  assert.equal(paper.routed.length, 0, 'no flatten was asked for, so nothing may trade')
  assert.ok(await store.getBook(BOOK_TAG, 'paper'), 'the book survives the refusal')
})
