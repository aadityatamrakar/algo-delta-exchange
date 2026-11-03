/**
 * `LiveBook` — the in-memory positions book (design doc §Phase 2).
 *
 * THE TWO PROPERTIES THIS FILE EXISTS FOR, because everything else about the
 * class is a performance detail and these are not:
 *
 *  1. **The load bound is enforced, not assumed.** The agreed cadence is
 *     unthrottled — every tick on a held instrument re-marks and pushes — and
 *     that is only affordable because ticks on the ~86 subscribed tokens the
 *     desk does NOT hold are discarded before any work happens. `stats.ticks`
 *     against `stats.recomputes` is that bound, and a test that watches the gap
 *     is what catches the check being deleted by someone who reads it as an
 *     optimisation.
 *
 *  2. **Divergence is detected and shouted about.** An in-memory book that
 *     silently drifts shows a position nobody holds, or hides one that is real.
 *     Both directions are injected here and both must be logged and corrected.
 *
 * The arithmetic is NOT re-asserted from first principles — it is asserted to be
 * IDENTICAL to what `livePnl` produces from Mongo, which is the only claim worth
 * making about it. `rollup.test.ts` and `pnl-routes.test.ts` own the figures
 * themselves, including the carried-realised subtraction that cost a live bug
 * (`439fa6f5`); this file pins that the second reader of them agrees.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OptionMaster } from '@algomaker/instruments'
import { BridgeService } from '../src/service.ts'
import { LiveRail, PaperRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import { DeskStore, type Collection, type Database, type FindCursor, type UpdateOutcome } from '../src/store.ts'
import type { ApiDeps, RouteCtx } from '../src/routes/kit.ts'
import { istDayRange } from '../src/routes/kit.ts'
import { pnlRoutes } from '../src/routes/pnl.ts'
import { livePnl, type PnlOptions, type PnlRow } from '../src/pnl-jobs.ts'
import { PnlStore } from '../src/pnlstore.ts'
import { LiveBook, type JournalEntry, type LiveBookStream } from '../src/livebook.ts'
import type { DeskMode } from '../src/contract.ts'

// ------------------------------------------------------------- the fake port

type Doc = Record<string, unknown>

/**
 * Copied from `pnl-routes.test.ts`, where the type bracketing was repaired.
 *
 * NULL MEANS "DIFFERENT BSON TYPES", and a range operator on it is FALSE —
 * real Mongo only ever compares a value against operands of its OWN type. It
 * matters here and is not pedantry: `loadFills` reads its window as TWO typed
 * range queries (numeric and `Date`, see `pnlstore.ts`) and merges them, so a
 * fake that coerces returns every numeric decision to BOTH queries and the
 * merged stream carries every fill twice — a book with double the position it
 * has, from a fake nobody would suspect.
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

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, want]) => {
    // `$or` is a top-level operator, not a field: the document need satisfy
    // only one of the whole filters in its list.
    if (key === '$or') return Array.isArray(want) && want.some((sub) => matches(doc, sub as Doc))
    const actual = doc[key]
    if (want !== null && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) {
      return Object.entries(want as Doc).every(([op, operand]) => {
        const c = cmp(actual, operand)
        switch (op) {
          case '$gte':
            return c !== null && c >= 0
          case '$gt':
            return c !== null && c > 0
          case '$lt':
            return c !== null && c < 0
          case '$lte':
            return c !== null && c <= 0
          case '$ne':
            return actual !== operand
          default:
            return false
        }
      })
    }
    if (want instanceof Date) return actual instanceof Date && actual.getTime() === want.getTime()
    return actual === want
  })
}

class FakeCursor<T> implements FindCursor<T> {
  #rows: T[]
  constructor(rows: T[]) {
    this.#rows = rows
  }
  sort(spec: Record<string, 1 | -1>): FindCursor<T> {
    const entries = Object.entries(spec)
    this.#rows = [...this.#rows].sort((a, b) => {
      for (const [key, dir] of entries) {
        const x = (a as Doc)[key]
        const y = (b as Doc)[key]
        if (x === y) continue
        const less =
          typeof x === 'string' || typeof y === 'string' ? String(x) < String(y) : Number(x) < Number(y)
        return less ? -dir : dir
      }
      return 0
    })
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

class FakeCollection<T> implements Collection<T> {
  readonly docs: Doc[] = []
  /** Every `find` on this collection. What the "no scan per poll" claim is measured with. */
  finds = 0
  async findOne(filter: Doc): Promise<T | null> {
    return (this.docs.find((d) => matches(d, filter)) as T | undefined) ?? null
  }
  find(filter: Doc): FindCursor<T> {
    this.finds++
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)) as T[])
  }
  async insertOne(doc: T): Promise<unknown> {
    this.docs.push({ ...(doc as Doc) })
    return {}
  }
  async insertMany(docs: readonly T[]): Promise<unknown> {
    for (const d of docs) this.docs.push({ ...(d as Doc) })
    return {}
  }
  async updateOne(filter: Doc, update: Doc, options?: { upsert?: boolean }): Promise<UpdateOutcome> {
    const set = (update['$set'] as Doc) ?? {}
    const hit = this.docs.find((d) => matches(d, filter))
    if (hit !== undefined) Object.assign(hit, set)
    else if (options?.upsert === true) this.docs.push({ ...filter, ...set })
    return {}
  }
  async deleteOne(filter: Doc): Promise<unknown> {
    const i = this.docs.findIndex((d) => matches(d, filter))
    if (i >= 0) this.docs.splice(i, 1)
    return {}
  }
  async deleteMany(filter: Doc): Promise<unknown> {
    for (let i = this.docs.length - 1; i >= 0; i--) {
      if (matches(this.docs[i] as Doc, filter)) this.docs.splice(i, 1)
    }
    return {}
  }
  async countDocuments(filter: Doc): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length
  }
  readonly indexes: Doc[] = []
  async createIndex(spec: Record<string, 1 | -1>): Promise<unknown> {
    this.indexes.push(spec)
    return {}
  }
  async dropIndex(): Promise<unknown> {
    return {}
  }
}

class FakeDb implements Database {
  readonly named = new Map<string, FakeCollection<unknown>>()
  collection<T = Doc>(name: string): Collection<T> {
    let c = this.named.get(name)
    if (c === undefined) {
      c = new FakeCollection<unknown>()
      this.named.set(name, c)
    }
    return c as unknown as Collection<T>
  }
  rows(name: string): Doc[] {
    return (this.collection(name) as unknown as FakeCollection<unknown>).docs
  }
  finds(name: string): number {
    return (this.collection(name) as unknown as FakeCollection<unknown>).finds
  }
}

// ------------------------------------------------------------------ fixture

const DAY = '2026-07-27'
const { from: DAY_START } = istDayRange(DAY)
/** 10:00 IST on a Monday. Inside the session, so marks are meaningful. */
const NOW = DAY_START + 10 * 60 * 60_000
const T = (minutes: number): number => DAY_START + minutes * 60_000

const CE = 'BHEL26AUG420CE'
const PE = 'BHEL26AUG400PE'
const CE_TOKEN = 4201
const PE_TOKEN = 4002
/** Subscribed, never held. The tick that must cost one map lookup and nothing else. */
const OTHER_TOKEN = 9999

function master(): OptionMaster {
  return new OptionMaster([
    {
      instrument_token: CE_TOKEN,
      tradingsymbol: CE,
      name: 'BHEL',
      expiry: '2026-08-25',
      strike: 420,
      tick_size: 0.05,
      lot_size: 2625,
      instrument_type: 'CE',
      segment: 'NFO-OPT',
      exchange: 'NFO',
    },
    {
      instrument_token: PE_TOKEN,
      tradingsymbol: PE,
      name: 'BHEL',
      expiry: '2026-08-25',
      strike: 400,
      tick_size: 0.05,
      lot_size: 2625,
      instrument_type: 'PE',
      segment: 'NFO-OPT',
      exchange: 'NFO',
    },
  ])
}

/** Records everything pushed, and how many tabs are watching each rail. */
class FakeStream implements LiveBookStream {
  readonly pushed: { mode: DeskMode; row: PnlRow }[] = []
  subscribers: Record<DeskMode, number> = { paper: 1, live: 1 }
  publishPnl(mode: DeskMode, row: PnlRow): void {
    this.pushed.push({ mode, row })
  }
  subscriberCount(mode: DeskMode): number {
    return this.subscribers[mode]
  }
}

interface Harness {
  db: FakeDb
  deps: ApiDeps
  opts: PnlOptions
  store: PnlStore
  stream: FakeStream
  book: LiveBook
  marks: Record<string, number>
  logs: { msg: string; ctx?: Record<string, unknown> }[]
  /** Everything the service journals also reaches the book, as in production. */
  journalled: JournalEntry[]
}

function harness(marks: Record<string, number>, now = NOW): Harness {
  const db = new FakeDb()
  const store = new DeskStore(db)
  const logs: Harness['logs'] = []
  const log = (msg: string, ctx?: Record<string, unknown>): void => {
    logs.push(ctx === undefined ? { msg } : { msg, ctx })
  }
  const journalled: JournalEntry[] = []
  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(db), live: new LiveRail(db, []) },
    master: { current: master },
    marks: new StaticMarks(),
    journal: (e) => {
      journalled.push(e)
      book.onJournal(e)
    },
    clock: { now: () => now },
  })
  const deps: ApiDeps = {
    db,
    store,
    service,
    master: { current: master },
    log,
    now: () => now,
  }
  // Injected rather than driven off a QuoteCache: a test that had to fake a live
  // feed to assert a push would be testing the feed. The object is MUTABLE so a
  // price can move between ticks.
  const opts: PnlOptions = { marks: (symbols) => pick(marks, symbols), lookbackDays: 30 }
  const stream = new FakeStream()
  const pnlStore = new PnlStore(db)
  const book = new LiveBook({ deps, store: pnlStore, opts, stream, log, now: () => now })
  return { db, deps, opts, store: pnlStore, stream, book, marks, logs, journalled }
}

function pick(all: Record<string, number>, symbols: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of symbols) {
    const v = all[s]
    if (v !== undefined) out[s] = v
  }
  return out
}

function decision(h: Harness, d: {
  tag: string
  mode: DeskMode
  createdAt: number
  fills: readonly Doc[]
}): void {
  h.db.rows('desk-decisions').push({
    decisionId: `d-${h.db.rows('desk-decisions').length}`,
    symbol: 'BHEL',
    expiry: '2026-08-25',
    tag: d.tag,
    mode: d.mode,
    createdAt: d.createdAt,
    fills: d.fills,
    skips: [],
  })
}

const sell = (tradingsymbol: string, qty: number, price: number, ts: number): Doc => ({
  op: 'open', deskTag: 'x', tradingsymbol, side: 'Sell', qty, price, ts,
})
const buy = (tradingsymbol: string, qty: number, price: number, ts: number): Doc => ({
  op: 'close', deskTag: 'x', tradingsymbol, side: 'Buy', qty, price, ts,
})

async function callPnl(deps: ApiDeps, opts: PnlOptions, target: string): Promise<Doc> {
  const url = new URL(`http://desk${target}`)
  let body: Doc = {}
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method: 'GET',
    principal: { kind: 'user', name: 'tester' },
    log: () => {},
    readJson: async () => ({}),
    send: (_status, payload) => {
      body = payload as Doc
    },
  }
  assert.equal(await pnlRoutes(deps, opts)(ctx), true)
  return body
}

// ------------------------------------------------------------ the load bound

/**
 * THE ASSERTION THE DESIGN DOC ASKS FOR IN SO MANY WORDS.
 *
 * "This bound must be enforced in code, not assumed. The tick handler checks
 * membership in the held set FIRST and returns." A thousand ticks on an
 * instrument the desk does not hold must cost a thousand map lookups and
 * nothing else — no recompute, no frame. Removing the check would put thousands
 * of recomputes a second into the process that also routes orders.
 */
test('a tick for an instrument we do NOT hold causes no recompute and no push', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  for (let i = 0; i < 1000; i++) h.book.onTick(OTHER_TOKEN)

  const s = h.book.stats
  assert.equal(s.ticks, 1000, 'every tick was offered')
  assert.equal(s.ticksHeld, 0, 'none of them was for a held instrument')
  assert.equal(s.recomputes, 0, 'the held-set check must return BEFORE any arithmetic')
  assert.equal(s.pushes, 0)
  assert.deepEqual(h.stream.pushed, [], 'nothing may reach a socket for an unheld token')
})

/**
 * The other half of the same claim: without this the test above is satisfied by
 * a tick handler that does nothing at all.
 */
test('a tick for a HELD instrument recomputes once and pushes the updated mark', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  h.book.onTick(CE_TOKEN)
  assert.equal(h.book.stats.recomputes, 1)
  assert.equal(h.stream.pushed.length, 1)
  const first = h.stream.pushed[0]
  assert.equal(first?.mode, 'paper')
  assert.equal(first?.row.tag, 'DESK_BHEL')
  // Short 100 at 15, marked 12.
  assert.equal(first?.row.unrealised, 300)
  assert.equal(first?.row.legs[0]?.mark, 12)

  // THE MARK MOVED. The push has to carry the new one, or it is a live socket
  // pushing a stale number, which is worse than not pushing at all.
  h.marks[CE] = 10
  h.book.onTick(CE_TOKEN)
  assert.equal(h.stream.pushed.length, 2)
  assert.equal(h.stream.pushed[1]?.row.legs[0]?.mark, 10)
  assert.equal(h.stream.pushed[1]?.row.unrealised, 500)
})

test('a CLOSED contract is not in the held set — a tick on it costs nothing', async () => {
  const h = harness({ [CE]: 12, [PE]: 9 })
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 100, 15, T(5)), sell(PE, 100, 11, T(5))],
  })
  await h.book.reconcile(NOW)
  h.book.onTick(PE_TOKEN)
  assert.equal(h.book.stats.recomputes, 1, 'held while it was open')

  // Bought back flat. The leg still appears on the positions table at qty 0 —
  // but it carries no exposure, so no tick on it can move a mark-to-market.
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(60), fills: [buy(PE, 100, 9, T(60))] })
  await h.book.reconcile(NOW)
  h.book.onTick(PE_TOKEN)
  assert.equal(h.book.stats.recomputes, 1, 'a flat leg must not cost a recompute')
  h.book.onTick(CE_TOKEN)
  assert.equal(h.book.stats.recomputes, 2, 'the still-open leg does')
})

test('with no tab open on a rail, a tick on a held instrument does no arithmetic', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  h.stream.subscribers.paper = 0
  h.book.onTick(CE_TOKEN)
  assert.equal(h.book.stats.ticksHeld, 1, 'the tick was for a held instrument')
  assert.equal(h.book.stats.recomputes, 0, 'but nothing is watching, so nothing is computed')
  assert.deepEqual(h.stream.pushed, [])
})

test('a paper tab never receives a live row, and vice versa', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'live', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  h.stream.subscribers.live = 0
  h.book.onTick(CE_TOKEN)
  assert.equal(
    h.stream.pushed.length,
    0,
    'the only holder of this token is a LIVE book and no live tab is open',
  )

  h.stream.subscribers.live = 1
  h.book.onTick(CE_TOKEN)
  assert.equal(h.stream.pushed.length, 1)
  assert.equal(h.stream.pushed[0]?.mode, 'live', 'published for the rail that holds it, only')
})

/**
 * A FILL RE-MARKS IMMEDIATELY, not on the next tick.
 *
 * The socket omits `qty`, `avgCost`, `realised` and the buy/sell figures from a
 * tick delta because a tick cannot move them (`stream.ts`), so the fresh row
 * pushed here is what makes them arrive at all. Waiting for the next tick would
 * be almost right and wrong in the worst case: a fill that CLOSES the last open
 * leg takes the contract out of the held set, so no further tick for it ever
 * arrives and the page would show the position as still open until the 15s REST
 * poll.
 */
test('a FILL pushes a fresh row straight away, with the new quantity on it', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)
  const before = h.stream.pushed.length

  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(60),
    fills: [buy(CE, 40, 13, T(60))],
  })

  assert.equal(h.stream.pushed.length, before + 1, 'the fill itself pushed')
  const row = h.stream.pushed.at(-1)?.row
  assert.equal(row?.tag, 'DESK_BHEL')
  // The three things only a fill can change, all present on the pushed row.
  assert.equal(row?.legs[0]?.qty, -60)
  assert.equal(row?.legs[0]?.buyQty, 40)
  assert.equal(row?.legs[0]?.realised, 80, 'sold 100 at 15, bought 40 back at 13')
})

test('a fill on a rail nobody is watching pushes nothing', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)
  h.stream.subscribers.paper = 0
  const before = h.stream.pushed.length

  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(60),
    fills: [buy(CE, 40, 13, T(60))],
  })

  // Same rule as the tick path: with no dashboard attached the book does
  // exactly the work it did before any of this existed.
  assert.equal(h.stream.pushed.length, before)
})

// ------------------------------------------------------- null on the wire

/**
 * The null discipline survives the transport. An unmarked open leg is `null`,
 * never `0`, and the total goes null the moment any open leg is unmarked rather
 * than summing the priced ones into a confident understatement.
 */
test('an unmarked open leg is pushed as null, never 0, and nulls the row total', async () => {
  // The feed has the CE but nothing for the PE.
  const h = harness({ [CE]: 12 })
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 100, 15, T(5)), sell(PE, 100, 11, T(5))],
  })
  await h.book.reconcile(NOW)
  h.book.onTick(CE_TOKEN)

  const row = h.stream.pushed[0]?.row
  assert.ok(row !== undefined)
  const pe = row.legs.find((l) => l.tradingsymbol === PE)
  assert.equal(pe?.mark, null, 'no mark is null on the wire, never 0')
  assert.equal(pe?.unrealised, null)
  assert.equal(pe?.mtm, null, 'open and unmarked: UNKNOWN — a 0 here reads as flat')
  assert.equal(row.unrealised, null, 'one unmarked leg makes the row unknown')
  assert.equal(row.total, null)
  assert.equal(row.complete, false)
  assert.deepEqual(row.unpriced, [PE])
  assert.equal(row.realised, 0, 'realised is booked and no mark can change it')
  assert.equal(row.openLegs, 2, 'the unmarked leg is still an open leg')
})

// ------------------------------------------------- the arithmetic, unchanged

/**
 * THE ONLY CLAIM WORTH MAKING ABOUT THE FIGURES: the book's answer and the
 * 30-day-scan answer are the SAME OBJECT.
 *
 * Both go through `pnlFromFills`, so this is a structural guarantee rather than
 * a coincidence — but it is exactly the guarantee that would be lost the day
 * someone "optimises" the book by netting positions itself. The scenario is the
 * one from `439fa6f5`: a book that CARRIES, where `positions` is netted over the
 * whole 30-day lookback while the card reports only this window.
 */
test('the in-memory book reproduces livePnl exactly, for a book that carries', async () => {
  const h = harness({ [CE]: 25 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL', label: 'BHEL' }, NOW)

  // YESTERDAY: a PE round trip booked +1000, and a CE half-covered for +250
  // leaving 25 short. Both were reported on yesterday's card.
  decision(h, {
    tag: 'DESK_BHEL', mode: 'paper', createdAt: T(-600),
    fills: [sell(PE, 100, 20, T(-600)), sell(CE, 50, 30, T(-600))],
  })
  decision(h, {
    tag: 'DESK_BHEL', mode: 'paper', createdAt: T(-590),
    fills: [buy(PE, 100, 10, T(-590)), buy(CE, 25, 20, T(-590))],
  })
  // TODAY: one more sale, so the window is not empty.
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(30), fills: [sell(CE, 10, 28, T(30))] })

  await h.book.reconcile(NOW)
  const fromMongo = await livePnl(h.deps, h.store, h.opts, 'paper', NOW)
  const fromMemory = await h.book.summary('paper', NOW)
  assert.deepEqual(fromMemory, fromMongo, 'two screens must not report one tag differently')

  const row = fromMemory.strategies.find((r) => r.tag === 'DESK_BHEL')
  assert.ok(row !== undefined)
  // The load-bearing invariants, restated here so a change to `pnlFromFills`
  // that broke them could not be waved through by the deepEqual above.
  assert.equal(
    row.legs.reduce((n, l) => n + Number(l.mtm), 0),
    row.total,
    'summing the legs must reproduce the card total',
  )
  assert.equal(
    row.openLegs,
    row.legs.filter((l) => l.qty !== 0).length,
    'openLegs counts qty != 0 only',
  )
  assert.equal(
    row.legs.find((l) => l.tradingsymbol === PE),
    undefined,
    'a qty-0 contract closed on a PREVIOUS day is not in this window',
  )
})

test('the same is true for every mode, and one rail never leaks into the other', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  decision(h, { tag: 'ONLY_LIVE', mode: 'live', createdAt: T(6), fills: [sell(CE, 50, 20, T(6))] })
  await h.book.reconcile(NOW)

  for (const mode of ['paper', 'live'] as const) {
    assert.deepEqual(
      await h.book.summary(mode, NOW),
      await livePnl(h.deps, h.store, h.opts, mode, NOW),
      `${mode} must match the REST path`,
    )
  }
  const paper = await h.book.summary('paper', NOW)
  assert.equal(
    paper.strategies.find((r) => r.tag === 'ONLY_LIVE'),
    undefined,
    'a tag that has only ever traded LIVE must not appear as a flat ₹0 row under PAPER',
  )
})

// ----------------------------------------------- the reads it actually saves

/**
 * THE POINT OF PHASE 2, MEASURED.
 *
 * Before: every `/v1/desk/pnl` ran a 30-day scan of `desk-decisions`. After: the
 * only read left on that path is the strategy registry, which is a handful of
 * rows and is deliberately NOT cached — a strategy registered a moment ago must
 * not be invisible on the page someone opened to check it.
 */
test('a P&L poll served from the book reads desk-decisions ZERO times', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  const deps: ApiDeps = { ...h.deps, book: h.book }
  const before = h.db.finds('desk-decisions')
  for (let i = 0; i < 10; i++) await callPnl(deps, h.opts, '/v1/desk/pnl?mode=paper')
  assert.equal(
    h.db.finds('desk-decisions') - before,
    0,
    'ten polls used to be ten 30-day scans of the busiest collection in the system',
  )
  assert.equal(h.db.finds('desk-strategies') > 0, true, 'the registry is still read live')
})

test('with no book attached, every poll still scans Mongo and answers identically', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })

  const before = h.db.finds('desk-decisions')
  const body = await callPnl(h.deps, h.opts, '/v1/desk/pnl?mode=paper')
  // TWO reads, not one: `loadFills` asks the numeric `createdAt` range and the
  // `Date` one separately and merges them in chronological order, because Mongo
  // sorts a mixed-type field by TYPE first (see `pnlstore.ts`). The number is
  // asserted rather than "> 0" precisely so a third read cannot appear here
  // unnoticed — the point of the test above is that this path is the expensive
  // one and the attached book is what avoids it.
  assert.equal(h.db.finds('desk-decisions') - before, 2, 'the fallback is not optional')
  const rows = body['strategies'] as Doc[]
  assert.equal(rows.find((r) => r['tag'] === 'DESK_BHEL')?.['unrealised'], 300)
})

/**
 * `ready` IS THE GATE, and an unloaded book must never be served.
 *
 * An empty in-memory book rendered as "no positions" is the same class of defect
 * as a confident ₹0 for an unmarked leg: a wrong answer that looks like a right
 * one. Until the first journal read lands, the route takes the path it always
 * took.
 */
test('a book that has not loaded is not used — the route falls back to Mongo', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })

  assert.equal(h.book.ready, false)
  const deps: ApiDeps = { ...h.deps, book: h.book }
  const body = await callPnl(deps, h.opts, '/v1/desk/pnl?mode=paper')
  const rows = body['strategies'] as Doc[]
  assert.equal(
    rows.find((r) => r['tag'] === 'DESK_BHEL')?.['openLegs'],
    1,
    'the position must not vanish because a cache is still warming up',
  )
})

// -------------------------------------------------------------- fill events

test('a journalled fill mutates the book with no database read', async () => {
  const h = harness({ [CE]: 12, [PE]: 9 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)
  const before = h.db.finds('desk-decisions')

  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(40),
    fills: [sell(PE, 50, 11, T(40))],
  })
  assert.equal(h.db.finds('desk-decisions') - before, 0, 'a fill is a mutation, not a reload')

  const positions = h.book.positions('DESK_BHEL', 'paper')
  assert.equal(positions.find((p) => p.tradingsymbol === PE)?.qty, -50)
  // And the new leg is now HELD, so its ticks reach the socket.
  h.book.onTick(PE_TOKEN)
  assert.equal(h.book.stats.recomputes, 1)
})

test('a reconciler-zeroed fill is a no-op, NOT a malformed row', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(40),
    // The reconciler undid a REJECTED booking: qty 0 with the corrected stamp.
    // Filing this under malformed blocked `flat` for the tag's whole window.
    fills: [{ tradingsymbol: CE, side: 'Sell', qty: 0, price: 15, ts: T(40),
              corrected: { at: T(40), fromQty: 100, fromPrice: 15, state: 'REJECTED' } }],
  })
  const row = (await h.book.summary('paper', NOW)).strategies.find((r) => r.tag === 'DESK_BHEL')
  assert.equal(row?.complete, true, 'a corrected no-op must not make the row incomplete')
  assert.notEqual(row?.total, null)
})

test('a malformed fill is named, never absorbed, and makes the row incomplete', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(40),
    // Price corrupted upstream. `@algomaker/pnl` would throw on this.
    fills: [{ tradingsymbol: PE, side: 'Sell', qty: 50, price: 'NaN', ts: T(40) }],
  })
  const row = (await h.book.summary('paper', NOW)).strategies.find((r) => r.tag === 'DESK_BHEL')
  assert.equal(row?.complete, false)
  assert.equal(row?.total, null, 'a book with a fill we could not read is not a confident number')
  assert.deepEqual(row?.unpriced, [PE])
})

/**
 * A CORRUPT PAPER FILL MUST NOT NULL THE LIVE TOTAL (audit F-53).
 *
 * The book holds both rails in ONE object, and the malformed list was a flat
 * `tag:symbol` array with no rail on it. So a paper simulation that journalled
 * an unreadable price marked the LIVE row for the same tag incomplete: the
 * money row went to `total: null` and reported an unpriced leg it does not
 * hold, because of a fill on the rail that cannot lose money. The rails are
 * separate everywhere else in this class — the fills map is keyed `tag|mode`
 * — and this was the one place they were not.
 */
test('a malformed PAPER fill leaves the LIVE row of the same tag intact', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'live', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(40),
    fills: [{ tradingsymbol: PE, side: 'Sell', qty: 50, price: 'NaN', ts: T(40) }],
  })

  const live = (await h.book.summary('live', NOW)).strategies.find((r) => r.tag === 'DESK_BHEL')
  assert.equal(live?.complete, true, "the live rail never saw the corrupt fill")
  assert.notEqual(live?.total, null)
  assert.deepEqual(live?.unpriced, [])

  // And the rail that DID see it is still told, in full.
  const paper = (await h.book.summary('paper', NOW)).strategies.find((r) => r.tag === 'DESK_BHEL')
  assert.equal(paper?.complete, false)
  assert.deepEqual(paper?.unpriced, [PE])
})

/**
 * The same, on the push path — which is where it was actually observed. The
 * pushed row is built by `#rowFor`, not by `summary`.
 */
test('the pushed LIVE row is not marked incomplete by a corrupt paper fill', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'live', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(40),
    fills: [{ tradingsymbol: PE, side: 'Sell', qty: 50, price: 'NaN', ts: T(40) }],
  })
  h.book.onTick(CE_TOKEN)

  const pushed = h.stream.pushed.filter((p) => p.mode === 'live').at(-1)
  assert.ok(pushed !== undefined, 'the live tab got a row')
  assert.equal(pushed.row.complete, true)
  assert.deepEqual(pushed.row.unpriced, [])
})

/**
 * NOTHING HERE MAY FAIL AN ORDER. `onJournal` runs on the order path, after the
 * write that made the fill real. An exception escaping it would report an order
 * that went out perfectly as a failed request.
 */
test('a fill the book cannot apply does not throw into the order path', async () => {
  const h = harness({ [CE]: 12 })
  await h.book.reconcile(NOW)
  assert.doesNotThrow(() => {
    h.book.onJournal({
      tag: 'DESK_BHEL',
      mode: 'paper',
      createdAt: T(40),
      fills: [null, undefined, 42, 'nonsense'],
    })
  })
})

/**
 * THE WIRING, not the arithmetic. A flatten's exits are fills like any other,
 * and if the book does not hear about them it keeps the closed leg in its held
 * set — re-marking and pushing a position nobody holds until the next reconcile.
 */
test('a flatten tells the book, and the closed leg leaves the held set at once', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)
  h.book.onTick(CE_TOKEN)
  assert.equal(h.book.stats.recomputes, 1, 'held while it was open')

  const r = await h.deps.service.flattenTag({
    tag: 'DESK_BHEL',
    mode: 'paper',
    decisionId: 'flat-1',
    style: 'fast',
  })
  assert.equal(r.flat, true, 'the position must actually be flattened')

  assert.equal(h.journalled.length, 1, 'the book was told, in-process, at the write')
  assert.equal(h.journalled[0]?.fills.length, 1)
  assert.equal(
    h.book.positions('DESK_BHEL', 'paper').find((p) => p.tradingsymbol === CE)?.qty,
    0,
    'and it netted the buy-back without a reconcile',
  )
  h.book.onTick(CE_TOKEN)
  assert.equal(h.book.stats.recomputes, 1, 'a leg that was just closed costs no more ticks')
})

test('a decision that routes nothing announces nothing', async () => {
  // An empty entry is a mutation the book would count and the journal would
  // not — which the reconcile would then have to explain as drift.
  const h = harness({ [CE]: 12 })
  await h.book.reconcile(NOW)
  await h.deps.store.registerStrategy(
    { tag: 'DESK_BHEL', modes: { paper: { enabled: true } } },
    NOW,
  )
  await h.deps.service.applyDecision({
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    tag: 'DESK_BHEL',
    decisionId: 'dec-1',
    actions: [],
  })
  assert.equal(h.journalled.length, 0)
})

// -------------------------------------------------------------- reconcile

/**
 * DIVERGENCE, DIRECTION ONE: the book holds a position the journal does not.
 *
 * This is the dangerous one — the screen shows exposure nobody has, and an
 * operator acting on it flattens a leg that does not exist, which OPENS one in
 * the opposite direction.
 */
test('reconcile detects a position the journal does not have, logs it, and drops it', async () => {
  const h = harness({ [CE]: 12, [PE]: 9 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  // A fill announced to the book that never reached `desk-decisions`.
  h.book.onJournal({
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(40),
    fills: [sell(PE, 50, 11, T(40))],
  })
  assert.equal(h.book.positions('DESK_BHEL', 'paper').length, 2)

  const result = await h.book.reconcile(NOW)
  assert.equal(result.status, 'ok')
  const drift = result.divergences.find((d) => d.tradingsymbol === PE)
  assert.equal(drift?.field, 'extra', 'memory held a leg the journal has never heard of')
  assert.equal(drift?.book, -50)
  assert.equal(drift?.journal, null)

  const shouted = h.logs.find((l) => l.msg.includes('DIVERGED'))
  assert.ok(shouted !== undefined, `the divergence must be LOUD; got ${JSON.stringify(h.logs)}`)
  assert.equal(
    String((shouted.ctx?.['detail'] as string[])[0]).includes(PE),
    true,
    'and it must name the leg, not just count it',
  )

  // ADOPTED. The journal is the only durable record of what filled, so it wins.
  assert.deepEqual(
    h.book.positions('DESK_BHEL', 'paper').map((p) => p.tradingsymbol),
    [CE],
    'the phantom leg is gone',
  )
  h.book.onTick(PE_TOKEN)
  assert.equal(h.book.stats.recomputes, 0, 'and it is out of the held set too')
})

/**
 * DIVERGENCE, DIRECTION TWO: the journal holds a position the book does not —
 * a fill that landed while the announcement was lost. The book HIDES real risk,
 * which is the calmest-looking dangerous state there is.
 */
test('reconcile detects a position the book is missing, logs it, and adopts it', async () => {
  const h = harness({ [CE]: 12, [PE]: 9 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  // Written straight to Mongo — the notification the book would normally get
  // never arrived.
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(40), fills: [sell(PE, 50, 11, T(40))] })

  const result = await h.book.reconcile(NOW)
  const drift = result.divergences.find((d) => d.tradingsymbol === PE)
  assert.equal(drift?.field, 'missing')
  assert.equal(drift?.journal, -50)
  assert.ok(h.logs.some((l) => l.msg.includes('DIVERGED')))
  assert.equal(h.book.positions('DESK_BHEL', 'paper').length, 2, "the journal's answer is adopted")
})

test('a divergence in qty alone is caught — a book that is merely the wrong SIZE', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)
  h.book.onJournal({
    tag: 'DESK_BHEL', mode: 'paper', createdAt: T(40), fills: [sell(CE, 25, 16, T(40))],
  })

  const result = await h.book.reconcile(NOW)
  const fields = result.divergences.filter((d) => d.tradingsymbol === CE).map((d) => d.field)
  assert.ok(fields.includes('qty'), JSON.stringify(result.divergences))
  assert.ok(fields.includes('avgCost'), 'and the average it was carrying it at')
  assert.equal(h.book.positions('DESK_BHEL', 'paper')[0]?.qty, -100)
})

test('an agreeing book reconciles silently — no divergence, no alarm', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)
  const result = await h.book.reconcile(NOW)
  assert.deepEqual(result.divergences, [])
  assert.equal(
    h.logs.some((l) => l.msg.includes('DIVERGED')),
    false,
    'an alarm that fires when nothing is wrong is one an operator learns to ignore',
  )
})

/**
 * A fill that lands WHILE the reconcile read is in flight is not drift — memory
 * legitimately holds something the read predates. Reporting it as a divergence
 * would fire the alarm on a normal Tuesday and train the operator to ignore the
 * one log line that matters.
 */
test('a fill landing mid-read skips the round rather than crying divergence', async () => {
  const h = harness({ [CE]: 12, [PE]: 9 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  const real = h.store
  let inFlight: (() => void) | null = null
  const slow = {
    loadFills: async (q: Parameters<PnlStore['loadFills']>[0]) => {
      await new Promise<void>((resolve) => {
        inFlight = resolve
      })
      return await real.loadFills(q)
    },
  } as unknown as PnlStore
  const racing = new LiveBook({
    deps: h.deps, store: slow, opts: h.opts, stream: h.stream, log: (m, c) => h.logs.push({ msg: m, ...(c === undefined ? {} : { ctx: c }) }), now: () => NOW,
  })

  const pending = racing.reconcile(NOW)
  // The read is parked. A fill arrives now, exactly as one would from the order
  // path — and the load about to come back cannot possibly contain it.
  racing.onJournal({ tag: 'DESK_BHEL', mode: 'paper', createdAt: T(40), fills: [sell(PE, 50, 11, T(40))] })
  ;(inFlight as unknown as () => void)()
  const result = await pending

  assert.equal(result.status, 'skipped')
  assert.deepEqual(result.divergences, [])
  assert.equal(
    h.logs.some((l) => l.msg.includes('DIVERGED')),
    false,
    'a race is not drift',
  )
  assert.ok(h.logs.some((l) => l.msg.includes('skipped')))
})

/**
 * Mongo is not always there. The book keeps serving what it has rather than
 * emptying itself — this is the one place that would ever notice the outage,
 * and "no positions" would be a far worse answer than a minute of staleness.
 */
test('a reconcile that cannot read Mongo keeps the book it already has', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  await h.book.reconcile(NOW)

  const broken = {
    loadFills: async () => {
      throw new Error('connection refused')
    },
  } as unknown as PnlStore
  const book = new LiveBook({ deps: h.deps, store: broken, opts: h.opts, log: () => {}, now: () => NOW })
  const result = await book.reconcile(NOW)
  assert.equal(result.status, 'failed')
  assert.equal(book.ready, false, 'and a book that never loaded stays unusable')

  // The already-loaded one is untouched by the same failure.
  assert.equal(h.book.ready, true)
  assert.equal(h.book.positions('DESK_BHEL', 'paper').length, 1)
})

/**
 * A CAPPED READ IS STILL A SUBSET, in memory exactly as it is over the wire.
 *
 * The book reads with the same `fillLimit` policy the REST path uses, and the
 * flag has to survive into the summary — the missing fills are missing money, so
 * the total is UNKNOWN rather than optimistic. A book that absorbed its own
 * truncation would be a confident understatement that nothing downstream could
 * detect.
 */
test('a truncated boot read makes the desk total unknown, not understated', async () => {
  const h = harness({ [CE]: 12 })
  for (let i = 0; i < 3; i++) {
    decision(h, {
      tag: 'DESK_BHEL', mode: 'paper', createdAt: T(i),
      fills: [sell(CE, 100, 15, T(i)), buy(CE, 100, 12, T(i))],
    })
  }
  const opts: PnlOptions = { ...h.opts, fillLimit: 2 }
  const capped = new LiveBook({ deps: h.deps, store: h.store, opts, log: () => {}, now: () => NOW })
  await capped.reconcile(NOW)

  const summary = await capped.summary('paper', NOW)
  assert.equal(summary.truncated, true, 'the figures below were built from a SUBSET')
  assert.equal(summary.totals.complete, false)
  assert.equal(summary.totals.total, null, 'a partial read must not present a confident number')
  assert.deepEqual(
    summary,
    await livePnl(h.deps, h.store, opts, 'paper', NOW),
    'and it degrades exactly the way the REST path does',
  )
})

test('start() loads the book, and the returned stop() clears the reconcile timer', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  const stop = await h.book.start()
  assert.equal(h.book.ready, true)
  assert.equal(h.book.stats.heldTokens, 1)
  stop()
})

/**
 * THE INTERVAL'S PROMISE IS CAUGHT (audit F-41).
 *
 * `setInterval(() => void this.reconcile(...))` had no `.catch`. `reconcile`
 * handles its own journal-read failure, but everything after it — `#adopt`,
 * which re-indexes every held leg through the instrument master — does not, and
 * Node treats an unhandled rejection as FATAL. So a throw anywhere in the adopt
 * path did not degrade the book: it killed the bridge, once a minute, for as
 * long as the condition lasted. The reconcile is a repair job; a round of it
 * failing must cost that round and nothing else.
 */
test('a reconcile that throws mid-adopt is logged, never an unhandled rejection', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })

  let explode = false
  const logs: { msg: string; ctx?: Record<string, unknown> }[] = []
  const book = new LiveBook({
    deps: {
      ...h.deps,
      // The master is read INSIDE `#adopt`'s re-index, well past the point
      // `reconcile` guards with a try/catch of its own.
      master: {
        current: () => {
          if (explode) throw new Error('instrument master rebuilt under us')
          return master()
        },
      },
    },
    store: h.store,
    opts: h.opts,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
    now: () => NOW,
    reconcileMs: 5,
  })

  const stop = await book.start()
  assert.equal(book.ready, true, 'the boot load must have succeeded before the fault is injected')
  explode = true
  await new Promise((r) => setTimeout(r, 40))
  stop()

  // RED before the fix: the rejection escapes and node --test fails the file.
  assert.ok(
    logs.some((l) => /reconcile threw/i.test(l.msg)),
    `the failed round must say so; got ${JSON.stringify(logs.map((l) => l.msg))}`,
  )
  assert.equal(book.ready, true, 'and the book keeps serving what it already had')
})
