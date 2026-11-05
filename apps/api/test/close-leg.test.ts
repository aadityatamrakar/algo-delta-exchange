/**
 * Closing ONE STRIKE out of a book, leaving the structure around it standing.
 *
 * THE OPERATOR'S CASE. A short option whose delta has decayed to ~0.10 does no
 * work in the structure any more, but it still consumes margin and still
 * carries the tail. `close-all` is the only exit that existed and it is
 * all-or-nothing, so getting rid of that one strike meant dismantling the whole
 * position and rebuilding it.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE NEGATIVE ONE: every OTHER leg must
 * still be in the book, and no order may go out for it. A "close one leg" that
 * quietly flattens the book is strictly worse than not having the button.
 *
 * The fakes are the ones `flatten.test.ts` built, for the reason it gives: a
 * safety path that can only be tested against a running database is a safety
 * path that stops being tested. The unique index on `decisionId` is modelled,
 * because idempotency here is a lock rather than a read-then-write.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { BridgeService } from '../src/service.ts'
import { StaticMarks } from '../src/marks.ts'
import {
  DeskStore,
  COLLECTIONS,
  type Collection,
  type Database,
  type FindCursor,
  type UpdateOutcome,
} from '../src/store.ts'
import type { BridgeLeg, DeskMode, Fill } from '../src/contract.ts'
import type { OrderRail, RouteContext } from '../src/rail.ts'
import { LiveRailBlocked, withOrderContext } from '../src/rail.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { DEFAULT_BOOK } from '../src/books-registry.ts'
import type { ApiDeps, RouteCtx } from '../src/routes/kit.ts'
import type { AuthGate } from '../src/authgate.ts'

// ------------------------------------------------------------------ fixtures

const TAG = 'TCS-2026-08-25-recenter-relief-r'
const MODE: DeskMode = 'paper'
const SYMBOL = 'TCS'
const EXPIRY = '2026-08-25'
const LOT = 225

/** The dead strike: 2660CE at 1.10, the ~0.10-delta leg this feature is for. */
const DEAD = 'TCS26AUG2660CE'
/** The two legs that must survive it, untouched. */
const LIVE_CE = 'TCS26AUG2460CE'
const LIVE_PE = 'TCS26AUG2440PE'

const NOW = Date.UTC(2026, 7, 14, 5, 15)

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of [2440, 2460, 2660]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: strike * 10 + (type === 'CE' ? 1 : 2),
        tradingsymbol: `TCS26AUG${strike}${type}`,
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
  { [DEAD]: 1.1, [LIVE_CE]: 10.75, [LIVE_PE]: 86.4 },
  { TCS: 2366.2 },
)

// ------------------------------------------------------------- the db fake

/**
 * TYPE-BRACKETED, exactly as `flatten.test.ts`'s fake is and for the same
 * reason: `loadFills` queries the decisions with a `createdAt` range whose
 * TYPE is part of the query (F-53, see `pnlstore.ts`), and a fake that
 * coerces a Date to its epoch number would match every numeric decision on
 * the DATED pass too — double-counting each fill and "realising" money twice.
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

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, want]) => {
    const got = doc[k]
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
        case '$ne':
          return got !== v
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
    this.#rows = this.#rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const av = a.r[key]
        const bv = b.r[key]
        const c = cmp(av, bv)
        // Cross-bracket values keep insertion order — the fake never has to
        // reproduce Mongo's bracket ORDER, only its refusal to compare across.
        return c === 0 || c === null ? a.i - b.i : c * (dir === -1 ? -1 : 1)
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
 * A book leg as `applyActions` stores it. `deskTag` IS THE PYTHON DRIVER'S OWN
 * LEG ID — the driver mints `open-<date>-<cp>-<i>` and posts it as the action's
 * `ts`, and `book.ts` stores that verbatim. That identity is the whole reason
 * the driver can later recognise which of its legs this close removed.
 */
function leg(deskTag: string, tradingsymbol: string, strike: number, type: 'CE' | 'PE', qty: number): BridgeLeg {
  const instrument = master().resolve(SYMBOL, EXPIRY, strike, type)
  assert.ok(instrument !== null, `fixture: ${tradingsymbol} must resolve`)
  return {
    deskTag,
    instrument,
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike,
    type,
    side: qty > 0 ? 'Buy' : 'Sell',
    qty,
    entryPrice: 7.7,
    openedTs: NOW - 86_400_000,
  }
}

beforeEach(async () => {
  db = new FakeDb()
  store = new DeskStore(db)
  await store.ensureIndexes()
  paper = new RecordingRail('paper')
  live = new RecordingRail('live')
  clockMs = NOW
  svc = new BridgeService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    clock: { now: () => clockMs },
  })
  await store.registerStrategy(
    { tag: TAG, kind: 'external', label: 'TCS relief', modes: { paper: { enabled: true } } },
    NOW,
  )
})

/** Three legs: the dead 2660CE and the two that must survive it. */
async function seedBook(): Promise<void> {
  await store.saveBook(
    { tag: TAG, mode: MODE, symbol: SYMBOL, expiry: EXPIRY },
    [
      leg('open-2026-08-04-12:30-0', DEAD, 2660, 'CE', -5 * LOT),
      leg('open-2026-08-11-10:50-0', LIVE_CE, 2460, 'CE', -5 * LOT),
      leg('open-2026-08-11-10:50-1', LIVE_PE, 2440, 'PE', -5 * LOT),
    ],
    NOW,
  )
}

/** The registry row, `actual: running` unless a test says otherwise. */
async function registerBook(over: Record<string, unknown> = {}): Promise<void> {
  await store.upsertBook({
    ...DEFAULT_BOOK,
    tag: TAG,
    mode: MODE,
    symbol: SYMBOL,
    expiry: EXPIRY,
    variant: 'recenter-relief-r',
    desired: 'running',
    actual: 'running',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW,
    ...over,
  } as Parameters<DeskStore['upsertBook']>[0])
}

// ------------------------------------------------------------ the service

test('closes ONLY the named contract and leaves every other leg in the book', async () => {
  await seedBook()
  const r = await svc.closeLeg({
    tag: TAG,
    mode: MODE,
    tradingsymbol: DEAD,
    decisionId: 'cl-1',
    style: 'fast',
  })

  assert.equal(r.ok, true)
  assert.ok(r.ok)
  assert.deepEqual([...r.closed], ['open-2026-08-04-12:30-0'])

  // ONE order, for the dead strike only. This is the assertion the whole
  // feature rests on — a "close one leg" that flattens the book is worse than
  // no button at all.
  assert.equal(paper.routed.length, 1)
  assert.equal(paper.routed[0]!.fill.tradingsymbol, DEAD)
  assert.equal(paper.routed[0]!.fill.side, 'Buy', 'closing a short means buying it back')
  assert.equal(paper.routed[0]!.fill.qty, 5 * LOT)
  assert.equal(live.routed.length, 0, 'a paper close must never touch the live rail')

  // ...and the book still holds the other two.
  const after = await store.loadBook(TAG, MODE)
  assert.deepEqual(
    after.map((l) => l.instrument.tradingsymbol).sort(),
    [LIVE_PE, LIVE_CE].sort(),
  )
})

test('EVERY leg on the contract goes, not just the first — a strike can be sold twice', async () => {
  // `recenter-relief` sells a strike, then sells more of it at a later mark
  // under a fresh leg id. The net-positions table an operator clicks from shows
  // the NETTED contract, so closing one of two while the table says the
  // contract is gone is the worst available outcome.
  await store.saveBook(
    { tag: TAG, mode: MODE, symbol: SYMBOL, expiry: EXPIRY },
    [
      leg('open-2026-08-04-12:30-0', DEAD, 2660, 'CE', -5 * LOT),
      leg('open-2026-08-12-14:00-0', DEAD, 2660, 'CE', -1 * LOT),
      leg('open-2026-08-11-10:50-0', LIVE_CE, 2460, 'CE', -5 * LOT),
    ],
    NOW,
  )

  const r = await svc.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: DEAD, decisionId: 'cl-2', style: 'fast',
  })
  assert.ok(r.ok)
  assert.equal(r.closed.length, 2)
  assert.equal(paper.routed.length, 2)
  assert.deepEqual(paper.routed.map((x) => x.fill.qty).sort((a, b) => a - b), [1 * LOT, 5 * LOT])

  const after = await store.loadBook(TAG, MODE)
  assert.deepEqual(after.map((l) => l.instrument.tradingsymbol), [LIVE_CE])
})

test('a contract the book does not hold is REFUSED, and names what it does hold', async () => {
  await seedBook()
  const r = await svc.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: 'TCS26AUG2200PE', decisionId: 'cl-3', style: 'fast',
  })
  assert.equal(r.ok, false)
  assert.ok(!r.ok)
  assert.equal(r.reason, 'no-leg')
  assert.deepEqual([...r.held].sort(), [DEAD, LIVE_CE, LIVE_PE].sort())
  assert.equal(paper.routed.length, 0, 'NOTHING was closed')
})

test('a tag with no book document at all is REFUSED rather than reported flat', async () => {
  const r = await svc.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: DEAD, decisionId: 'cl-4', style: 'fast',
  })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'no-book')
  assert.equal(paper.routed.length, 0)
})

test('a retried close replays and cannot double-sell', async () => {
  await seedBook()
  const first = await svc.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: DEAD, decisionId: 'cl-dup', style: 'fast',
  })
  assert.ok(first.ok)
  assert.equal(first.replayed, false)
  assert.equal(paper.routed.length, 1)

  // The book no longer holds the leg, so a genuine retry now refuses on
  // `no-leg` BEFORE it can reach the rail — which is the outcome that matters:
  // exactly one exit went out.
  const second = await svc.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: DEAD, decisionId: 'cl-dup', style: 'fast',
  })
  assert.equal(second.ok, false)
  assert.equal(paper.routed.length, 1, 'a retry must not place a second exit')
})

test('the book keeps its own expiry — a close must not blank it', async () => {
  // `saveBook` treats `''` as "leave what you have", but a close that passed a
  // leg-derived or empty expiry would still be one refactor from the Task 6
  // defect: an unsubscribable book that can never open another leg.
  await seedBook()
  await svc.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: DEAD, decisionId: 'cl-exp', style: 'fast',
  })
  const doc = await store.bookDoc(TAG, MODE)
  assert.equal(doc?.expiry, EXPIRY)
  assert.equal(doc?.symbol, SYMBOL)
})

test('it runs as the OPERATOR — a switched-off strategy cannot trap the leg', async () => {
  await seedBook()
  await svc.patchStrategy(TAG, {
    modes: { paper: { enabled: false } },
    disabledReason: 'stopped for the day',
  })
  const r = await svc.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: DEAD, decisionId: 'cl-sw', style: 'fast',
  })
  assert.ok(r.ok)
  assert.equal(paper.routed.length, 1, '"off means off" must not block an exit')
})

test('a leg with no mark still closes, as MARKET, and is named in unpriceable', async () => {
  await seedBook()
  const blind = new BridgeService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: new StaticMarks({}, { TCS: 2366.2 }),
    clock: { now: () => clockMs },
  })
  const r = await blind.closeLeg({
    tag: TAG, mode: MODE, tradingsymbol: DEAD, decisionId: 'cl-nm', style: 'limit',
  })
  assert.ok(r.ok)
  // Refusing to close because we cannot price it is the trap this whole area
  // exists to avoid: an uncontrolled exit price is bad, no exit is worse.
  assert.deepEqual([...r.unpriceable], [DEAD])
})

// -------------------------------------------------------------- the route

function routeCall(body: Record<string, unknown>, tag = TAG): {
  ctx: RouteCtx
  sent: { status: number; body: unknown }[]
} {
  const path = `/v1/desk/books/registry/${tag}/close-leg`
  const sent: { status: number; body: unknown }[] = []
  const ctx = {
    req: {} as RouteCtx['req'],
    res: {} as RouteCtx['res'],
    url: new URL(`http://x${path}`),
    path,
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

function routes(): ReturnType<typeof booksRoutes> {
  const deps: ApiDeps & { gate: AuthGate } = {
    db,
    store,
    service: svc,
    master: { current: master },
    log: () => {},
    now: () => clockMs,
    gate: { reauth: async () => null } as unknown as AuthGate,
  }
  return booksRoutes(deps)
}

const OK = { mode: MODE, tradingsymbol: DEAD, style: 'fast', decisionId: 'http-ok' }

test('POST close-leg closes the one strike on a running book', async () => {
  await seedBook()
  await registerBook()
  const { ctx, sent } = routeCall(OK)
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 200)
  assert.equal(paper.routed.length, 1)
  assert.equal(paper.routed[0]!.fill.tradingsymbol, DEAD)
})

/**
 * THE GATE THAT MAKES THIS SAFE.
 *
 * The Python driver owns `state["book"]` and learns about a close initiated
 * here only through its own book-vs-bridge absorb pass, which runs each tick.
 * A driver that is not running never runs it — and reloads the same state file
 * on restart, so the strategy would go on recentring and sizing against a leg
 * that no longer exists, indefinitely.
 */
test('a book the supervisor is NOT running refuses, and nothing is closed', async () => {
  await seedBook()
  await registerBook({ desired: 'running', actual: 'stopped' })
  const { ctx, sent } = routeCall(OK)
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 409)
  assert.match(String((sent[0]?.body as { error: string }).error), /not running/)
  assert.equal(paper.routed.length, 0, 'NOTHING WAS CLOSED')
})

test('an unregistered tag is a 404, not a silent success', async () => {
  await seedBook()
  const { ctx, sent } = routeCall(OK)
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 404)
  assert.equal(paper.routed.length, 0)
})

test('mode, tradingsymbol, style and decisionId are all required, never guessed', async () => {
  await seedBook()
  await registerBook()

  const cases: [Record<string, unknown>, RegExp][] = [
    [{ tradingsymbol: DEAD, style: 'fast', decisionId: 'a' }, /mode must be stated/],
    [{ mode: MODE, style: 'fast', decisionId: 'a' }, /tradingsymbol is required/],
    [{ mode: MODE, tradingsymbol: DEAD, decisionId: 'a' }, /style must be stated/],
    [{ mode: MODE, tradingsymbol: DEAD, style: 'fast' }, /decisionId is required/],
  ]
  for (const [body, expected] of cases) {
    const { ctx, sent } = routeCall(body)
    assert.equal(await routes()(ctx), true)
    assert.equal(sent[0]?.status, 400, `${JSON.stringify(body)} must be refused`)
    assert.match(String((sent[0]?.body as { error: string }).error), expected)
  }
  assert.equal(paper.routed.length, 0)
})

test('a contract the book no longer holds answers 409 saying NOTHING WAS CLOSED', async () => {
  // The realistic cause: a stale dashboard, where the strategy closed the
  // contract itself between the render and the click. The operator must be able
  // to tell that from "we closed it for you".
  await seedBook()
  await registerBook()
  const { ctx, sent } = routeCall({ ...OK, tradingsymbol: 'TCS26AUG2200PE' })
  assert.equal(await routes()(ctx), true)
  assert.equal(sent[0]?.status, 409)
  const body = sent[0]?.body as { error: string; held: string[] }
  assert.match(body.error, /NOTHING WAS CLOSED/)
  assert.equal(body.held.length, 3)
  assert.equal(paper.routed.length, 0)
})

// ---------------------------------------------------------- order context

/**
 * THE SIDE COLUMN WAS EMPTY ON EVERY LIVE ROW, EVER.
 *
 * Nothing on the live rail journals a direction: the gateway records PLANNED /
 * SUBMITTED / ACK / STATUS without one, and STATUS — the only phase carrying a
 * fill — is built from the broker's update, which does not echo it either. So
 * the Orders page and every per-book log showed `—` under Side for live, while
 * paper was correct because `paperFillEvent` reads it off the stored fill.
 *
 * Fixed on the READ so it applies to rows already written: a positional book's
 * log runs back weeks, and a write-side fix would leave all of it blank.
 *
 * The order's INTENT figures — `limitPrice`, `orderQty` — ride the same join
 * (2026-08-18): only a fill carries a qty and a price, so every routing row in
 * the "every step" dialog read as an order for nothing. They are stamped under
 * their own names, never as `filledQty`/`avgPrice`.
 */
test('a live order event is stamped with the side from its order document', async () => {
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: 'ord-1',
    tradingsymbol: DEAD,
    transaction_type: 'SELL',
  })
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ord-1', phase: 'STATUS', tradingsymbol: DEAD, ts: NOW },
  ])
  assert.equal(out[0]?.['side'], 'SELL')
})

test('a SPLIT order stamps every tranche from the one desk order', async () => {
  // `desk-gateway-orders` is keyed by the DESK order, while the events carry
  // `<base>.1` / `<base>.2`. Joining on the raw id would find nothing.
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: 'ord-2',
    tradingsymbol: DEAD,
    transaction_type: 'BUY',
  })
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ord-2.1', phase: 'STATUS', ts: NOW },
    { clientOrderId: 'ord-2.2', phase: 'STATUS', ts: NOW },
  ])
  assert.deepEqual(out.map((e) => e['side']), ['BUY', 'BUY'])
})

test('an event that already carries a side keeps its own', async () => {
  // Paper fills arrive with one, and the stored order document is not a better
  // authority on them than the fill itself.
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: 'ord-3', transaction_type: 'SELL',
  })
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ord-3', phase: 'FILL', side: 'BUY', ts: NOW },
  ])
  assert.equal(out[0]?.['side'], 'BUY')
})

test('an order we have no document for is left alone, not blanked', async () => {
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'unknown-9', phase: 'STATUS', ts: NOW },
  ])
  assert.equal(out[0]?.['side'], undefined)
  assert.equal(out.length, 1, 'the event still renders')
})

test('a garbled transaction_type is ignored rather than rendered', async () => {
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: 'ord-4', transaction_type: 'sideways',
  })
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ord-4', phase: 'STATUS', ts: NOW },
  ])
  assert.equal(out[0]?.['side'], undefined)
})

test('routing events are stamped with the order\'s OWN limit price and quantity', async () => {
  // The desk order carries what was ASKED — the marketable limit and the
  // contract quantity — and the journal's PLANNED/SUBMITTED rows carry
  // neither, so the dialog showed an order for nothing at no price.
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: 'ord-5', tradingsymbol: DEAD, transaction_type: 'BUY',
    quantity: 5 * LOT, limitPrice: 1.15,
  })
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ord-5', phase: 'PLANNED', tradingsymbol: DEAD, ts: NOW },
    { clientOrderId: 'ord-5.1', phase: 'SUBMITTED', tradingsymbol: DEAD, ts: NOW },
  ])
  assert.equal(out[0]?.['limitPrice'], 1.15)
  assert.equal(out[0]?.['orderQty'], 5 * LOT)
  // The tranche joins on the BASE id, same as the side does.
  assert.equal(out[1]?.['limitPrice'], 1.15)
})

test('intent figures land under their own names, NEVER as filledQty/avgPrice', async () => {
  // What was asked and what traded must stay two different fields — conflating
  // them is how a refused order reads as a fill.
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: 'ord-6', transaction_type: 'BUY', quantity: 5 * LOT, limitPrice: 1.15,
  })
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ord-6', phase: 'SUBMITTED', ts: NOW },
  ])
  assert.equal(out[0]?.['filledQty'], undefined)
  assert.equal(out[0]?.['avgPrice'], undefined)
})

test('a MARKET order document (no limitPrice) stamps the quantity alone', async () => {
  // An absent limit is a real state, not a zero — the dash stays honest.
  await db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: 'ord-7', transaction_type: 'SELL', quantity: 5 * LOT,
  })
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ord-7', phase: 'SUBMITTED', ts: NOW },
  ])
  assert.equal(out[0]?.['orderQty'], 5 * LOT)
  assert.equal(out[0]?.['limitPrice'], undefined)
})

// ------------------------------------------------------- whose greeks these are

/**
 * ONE ENGINE FOR THE WHOLE RESPONSE.
 *
 * The headline greeks were briefly served from the strategy's published set
 * while `greeks.legs` stayed this engine's, and that broke the invariant the
 * page is actually read on: the `Pos delta` column sums to the `Net delta`
 * tile. The strategy prices off the FUTURE and this engine off cash spot, so
 * the headline came out -47 over a column totalling +174 — roughly
 * `netGamma x (future - spot)` apart — and no amount of looking could
 * reconcile them.
 *
 * Mixing was the mistake, not either model. The genuinely different number,
 * what the RULES steer by, is served separately as `steering` and labelled.
 */
describe('the greeks a book reports', () => {
  const declare = async (over: Record<string, unknown> = {}): Promise<void> => {
    await db.collection(COLLECTIONS.declarations).updateOne(
      { tag: TAG },
      {
        $set: {
          tag: TAG, symbol: SYMBOL, legs: [], declaredAt: NOW, greeksAt: NOW,
          greeks: { delta: -1878, gamma: -317, theta: 4513, vega: -3309, spot: 426.6, dte: 11 },
          ...over,
        },
      },
      { upsert: true },
    )
  }

  test('the per-leg deltas SUM to the headline, whatever the strategy published', async () => {
    await seedBook()
    await declare()
    const p = await svc.positions(TAG, MODE)

    const summed = p.greeks.legs.reduce((n, l) => n + l.positionDelta, 0)
    assert.ok(Math.abs(summed - p.greeks.netDelta) < 1e-6, `${summed} vs ${p.greeks.netDelta}`)
    // Emphatically NOT the strategy's -1878, which would not sum to anything
    // on screen.
    assert.notEqual(p.greeks.netDelta, -1878)
  })

  test('a book with no declaration at all still reports its own greeks', async () => {
    await seedBook()
    const p = await svc.positions(TAG, MODE)
    assert.ok(Number.isFinite(p.greeks.netDelta))
    assert.equal(p.steering, null)
  })
})

/**
 * THE TWO NUMBERS THAT LOOKED LIKE A CONTRADICTION.
 *
 * Under `delta_shorts_only` the rules read their SHORT legs only. On BHEL
 * 2026-08-14 the book carried +408 delta while the shorts alone were -1836 —
 * opposite signs, the two long hedge legs holding the positive delta. The
 * tiles printed the book's and the Strategy panel the rules', and to anyone
 * who did not know the dial was set they read as a disagreement.
 *
 * Both are correct and they answer different questions, so both are served.
 */
describe('what the strategy steers by', () => {
  const declareWith = async (extra: Record<string, unknown>): Promise<void> => {
    await db.collection(COLLECTIONS.declarations).updateOne(
      { tag: TAG },
      {
        $set: {
          tag: TAG, symbol: SYMBOL, legs: [], declaredAt: NOW, greeksAt: NOW,
          greeks: {
            delta: 408, gamma: -189, theta: 4513, vega: -3309, spot: 426.6, dte: 11,
            ...extra,
          },
        },
      },
      { upsert: true },
    )
  }

  test('the steering pair is served ALONGSIDE the book, never instead of it', async () => {
    await seedBook()
    await declareWith({ steeringDelta: -1836, steeringGamma: -314.9 })
    const p = await svc.positions(TAG, MODE)

    // `greeks` still means THIS engine's figure for the whole book — the risk
    // the desk carries, and the one the Pos delta column sums to.
    assert.ok(Number.isFinite(p.greeks.netDelta))
    assert.deepEqual(p.steering, { delta: -1836, gamma: -314.9 })
  })

  test('a strategy that reports none serves null, not zero', async () => {
    await seedBook()
    await declareWith({})
    const p = await svc.positions(TAG, MODE)
    assert.equal(p.steering, null)
    assert.ok(Number.isFinite(p.greeks.netDelta), 'the book greeks are unaffected')
  })

  test('a STALE set withholds the steering pair too', async () => {
    // A steering figure from an hour ago is as misleading as a stale delta,
    // and worse for looking like a live comparison against a fresh one.
    await seedBook()
    await db.collection(COLLECTIONS.declarations).updateOne(
      { tag: TAG },
      { $set: { greeksAt: NOW - 30 * 60 * 1000 } },
    )
    const p = await svc.positions(TAG, MODE)
    assert.equal(p.steering, null)
  })
})

// ----------------------------------------------------------- realised to date

/**
 * THE +95k THAT WAS A LOSS (2026-08-18). The positions table's Total sums the
 * OPEN legs against their entries; a closed tranche leaves the book and takes
 * its P&L to the journal. The live BHEL book closed a leg realising −95,524
 * and the Total read +95,419 — the surviving legs' gain since entry — which
 * the operator read as profit while the book's true lifetime P&L was ≈ −105.
 * `realised` on the positions payload is what lets the page show the net.
 *
 * These pin the CONTRACT of the field: cumulative over the lookback from the
 * corrected fills, opt-in, mode-scoped, and null — never 0, never a smaller
 * confident number — whenever the sum would be understated.
 */
describe('realised-to-date on the positions payload', () => {
  /** One stored decision with its fills, the shape `applyDecision` writes. */
  const decide = async (over: {
    decisionId: string
    createdAt: number
    fills: Record<string, unknown>[]
    mode?: DeskMode
  }): Promise<void> => {
    await db.collection(COLLECTIONS.decisions).insertOne({
      decisionId: over.decisionId,
      tag: TAG,
      mode: over.mode ?? MODE,
      createdAt: over.createdAt,
      fills: over.fills,
    })
  }

  /** A round trip on the dead strike: sold at 30.9, bought back at 40. */
  const roundTrip = async (): Promise<void> => {
    await decide({
      decisionId: 'rt-open', createdAt: NOW - 3 * 86_400_000,
      fills: [{ tradingsymbol: DEAD, side: 'Sell', qty: 5 * LOT, price: 30.9,
                ts: NOW - 3 * 86_400_000, op: 'open' }],
    })
    await decide({
      decisionId: 'rt-close', createdAt: NOW - 3_600_000,
      fills: [{ tradingsymbol: DEAD, side: 'Buy', qty: 5 * LOT, price: 40,
                ts: NOW - 3_600_000, op: 'close' }],
    })
  }

  test('a closed round trip is the booked figure — a loss stays a loss', async () => {
    await seedBook()
    await roundTrip()
    const p = await svc.positions(TAG, MODE, { realised: true })
    // 1,125 x (30.90 − 40.00): the money the close BOOKED, which no surviving
    // leg's mark-vs-entry can ever show.
    assert.equal(p.realised, 5 * LOT * (30.9 - 40))
  })

  test('realised is NET of the fees on the fills (sinceEntry builds on it)', async () => {
    await seedBook()
    await decide({
      decisionId: 'fee-open', createdAt: NOW - 3 * 86_400_000,
      fills: [{ tradingsymbol: DEAD, side: 'Sell', qty: 5 * LOT, price: 30.9,
                ts: NOW - 3 * 86_400_000, op: 'open', fee: 2.5 }],
    })
    await decide({
      decisionId: 'fee-close', createdAt: NOW - 3_600_000,
      fills: [{ tradingsymbol: DEAD, side: 'Buy', qty: 5 * LOT, price: 40,
                ts: NOW - 3_600_000, op: 'close', fee: 1.5 }],
    })
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.ok(Math.abs((p.realised ?? NaN) - (5 * LOT * (30.9 - 40) - 4)) < 1e-9)
  })

  test('it is OPT-IN: the plain call carries no field at all', async () => {
    // The Books page calls positions() once per book on a 5s poll; the fill
    // journal must not be scanned for a payload that never renders the figure.
    await seedBook()
    await roundTrip()
    const p = await svc.positions(TAG, MODE)
    assert.equal('realised' in p, false)
  })

  test('an open position with its OPEN in the window adds nothing to realised', async () => {
    await seedBook()
    await roundTrip()
    await decide({
      decisionId: 'still-open', createdAt: NOW - 2 * 86_400_000,
      fills: [{ tradingsymbol: LIVE_CE, side: 'Sell', qty: 5 * LOT, price: 10.75,
                ts: NOW - 2 * 86_400_000, op: 'open' }],
    })
    const p = await svc.positions(TAG, MODE, { realised: true })
    // Cumulative realised, not the day's: the open leg contributes 0 booked,
    // and nothing subtracts the round trip back out for being "carried".
    assert.equal(p.realised, 5 * LOT * (30.9 - 40))
  })

  test('a book with no fills at all realised exactly nothing — 0, not null', async () => {
    // "Nothing has been booked" is a knowable answer, unlike the nulls below.
    await seedBook()
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.equal(p.realised, 0)
  })

  test('a close whose OPEN is outside the window is NULL, not a confident number', async () => {
    // The seeded-book trap: the buy-back of a leg no journalled fill opened
    // looks like OPENING a long, realises nothing, and the "total" would
    // quietly omit the one figure this field exists to carry.
    await seedBook()
    await decide({
      decisionId: 'orphan-close', createdAt: NOW - 3_600_000,
      fills: [{ tradingsymbol: DEAD, side: 'Buy', qty: 5 * LOT, price: 40,
                ts: NOW - 3_600_000, op: 'close' }],
    })
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.equal(p.realised, null)
  })

  test('a fill nobody can read makes the figure NULL — money is missing, amount unknown', async () => {
    await seedBook()
    await roundTrip()
    await decide({
      decisionId: 'mangled', createdAt: NOW - 1_800_000,
      fills: [{ tradingsymbol: DEAD, side: 'Buy', qty: 'five lots', price: 40 }],
    })
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.equal(p.realised, null)
  })

  test('the OTHER rail\'s fills never leak in — a live loss is not a paper loss', async () => {
    await seedBook()
    await decide({
      decisionId: 'live-open', createdAt: NOW - 3 * 86_400_000, mode: 'live',
      fills: [{ tradingsymbol: DEAD, side: 'Sell', qty: 5 * LOT, price: 30.9,
                ts: NOW - 3 * 86_400_000, op: 'open' }],
    })
    await decide({
      decisionId: 'live-close', createdAt: NOW - 3_600_000, mode: 'live',
      fills: [{ tradingsymbol: DEAD, side: 'Buy', qty: 5 * LOT, price: 40,
                ts: NOW - 3_600_000, op: 'close' }],
    })
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.equal(p.realised, 0)
  })
})

// ------------------------------------------------- what closing would cost

/**
 * NET IF CLOSED NOW (operator, 5 Nov: "we just want to see actual net pnl
 * which if we close book now, we will get in account").
 *
 * Two figures ride the realised one. `feesPaid` is the venue fees on every
 * fill so far — already inside `realised`, which stays net, but now said out
 * loud so the page can show it as its own line. `closeFees` is what the venue
 * would charge to close every open leg NOW, and exists only where a venue
 * charges one: the `closeFeeOf` seam is wired on Delta alone.
 */
describe('fees paid and the cost of closing, on the positions payload', () => {
  const decide = async (decisionId: string, createdAt: number, fills: Record<string, unknown>[]): Promise<void> => {
    await db.collection(COLLECTIONS.decisions).insertOne({ decisionId, tag: TAG, mode: MODE, createdAt, fills })
  }

  /** A service with the closing-fee seam, recording what it was asked. */
  const withSeam = (marks: StaticMarks = MARKS): {
    svc: BridgeService
    calls: { qty: number; price: number; index: number }[]
  } => {
    const calls: { qty: number; price: number; index: number }[] = []
    const s = new BridgeService({
      store,
      rails: { paper, live },
      master: { current: master },
      marks,
      clock: { now: () => clockMs },
      closeFeeOf: (a) => {
        calls.push(a)
        return a.qty * 0.01
      },
    })
    return { svc: s, calls }
  }

  test('feesPaid is the fees on every fill so far; realised stays net of them', async () => {
    await seedBook()
    await decide('fp-open', NOW - 3 * 86_400_000, [
      { tradingsymbol: DEAD, side: 'Sell', qty: 5 * LOT, price: 30.9, ts: NOW - 3 * 86_400_000, op: 'open', fee: 2.5 },
    ])
    await decide('fp-close', NOW - 3_600_000, [
      { tradingsymbol: DEAD, side: 'Buy', qty: 5 * LOT, price: 40, ts: NOW - 3_600_000, op: 'close', fee: 1.5 },
    ])
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.equal(p.feesPaid, 4)
    assert.ok(Math.abs((p.realised ?? NaN) - (5 * LOT * (30.9 - 40) - 4)) < 1e-9)
  })

  test('feesPaid is null whenever realised is — the same fills, the same doubt', async () => {
    await seedBook()
    await decide('fp-orphan', NOW - 3_600_000, [
      { tradingsymbol: DEAD, side: 'Buy', qty: 5 * LOT, price: 40, ts: NOW - 3_600_000, op: 'close', fee: 1.5 },
    ])
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.equal(p.realised, null)
    assert.equal(p.feesPaid, null)
  })

  test('no closing-fee seam (NSE): no closeFees field at all, and feesPaid is 0', async () => {
    await seedBook()
    const p = await svc.positions(TAG, MODE, { realised: true })
    assert.equal('closeFees' in p, false)
    assert.equal(p.feesPaid, 0)
  })

  test('closeFees sums the seam over every open leg: its size, its closing price, the spot', async () => {
    await seedBook()
    const { svc: s, calls } = withSeam()
    const p = await s.positions(TAG, MODE, { realised: true })
    assert.ok(Math.abs((p.closeFees ?? NaN) - 3 * 5 * LOT * 0.01) < 1e-9)
    // Each leg's price is the one its P&L is marked at (`greeks.legs[].price`),
    // which is the quote round-tripped through its solved IV — equal to the
    // mark to a few millionths, not bit-for-bit.
    const seen = [...calls].sort((a, b) => a.price - b.price)
    assert.deepEqual(seen.map((c) => [c.qty, c.index]), [[5 * LOT, 2366.2], [5 * LOT, 2366.2], [5 * LOT, 2366.2]])
    const marks = [1.1, 10.75, 86.4]
    seen.forEach((c, i) => assert.ok(Math.abs(c.price - (marks[i] ?? NaN)) < 1e-4, `${c.price} vs ${marks[i]}`))
  })

  test('a flat book costs nothing to close: 0, not null', async () => {
    const { svc: s } = withSeam()
    const p = await s.positions(TAG, MODE, { realised: true })
    assert.equal(p.closeFees, 0)
  })

  test('an open leg nothing can price makes closeFees NULL, never a smaller number', async () => {
    await seedBook()
    // No quote anywhere, so no IV for the model pass either: every leg stays
    // unpriced. (One quoted leg would let the model price the other two.)
    const { svc: s } = withSeam(new StaticMarks({}, { TCS: 2366.2 }))
    const p = await s.positions(TAG, MODE, { realised: true })
    assert.ok(p.greeks.unpriced.length > 0, 'fixture: some leg must be unpriced')
    assert.equal(p.closeFees, null)
  })

  test('a seam that throws makes closeFees NULL rather than failing the page', async () => {
    await seedBook()
    const s = new BridgeService({
      store,
      rails: { paper, live },
      master: { current: master },
      marks: MARKS,
      clock: { now: () => clockMs },
      closeFeeOf: () => {
        throw new RangeError('bad input')
      },
    })
    const p = await s.positions(TAG, MODE, { realised: true })
    assert.equal(p.closeFees, null)
    assert.equal(p.legs.length, 3)
  })

  test('both are OPT-IN with realised: the plain call carries neither', async () => {
    await seedBook()
    const { svc: s, calls } = withSeam()
    const p = await s.positions(TAG, MODE)
    assert.equal('feesPaid' in p, false)
    assert.equal('closeFees' in p, false)
    assert.equal(calls.length, 0)
  })
})
