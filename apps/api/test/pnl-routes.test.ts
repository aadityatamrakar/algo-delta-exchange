/**
 * The P&L and reports endpoints, against an in-memory stand-in for the Mongo
 * port.
 *
 * A fake rather than a real database here on purpose: what these tests are
 * about is the SHAPE the frontend is being built against (API contract §3/§4)
 * and the null-not-zero discipline, neither of which is a database property.
 * The database properties this app relies on — the unique index, the paper/live
 * collection split — are covered in `service.integration.test.ts` against real
 * Mongo.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OptionMaster } from '@algomaker/instruments'
import { BridgeService } from '../src/service.ts'
import { LiveRail, PaperRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import type { DailyReport } from '../src/rollup.ts'
import { DeskStore, type Collection, type Database, type FindCursor, type UpdateOutcome } from '../src/store.ts'
import type { ApiDeps, RouteCtx } from '../src/routes/kit.ts'
import { istDayRange } from '../src/routes/kit.ts'
import { pnlRoutes } from '../src/routes/pnl.ts'
import { reportRoutes } from '../src/routes/reports.ts'
import { livePnl, snapshotOnce, writeRollups, type PnlOptions } from '../src/pnl-jobs.ts'
import { PnlStore } from '../src/pnlstore.ts'

// ------------------------------------------------------------- the fake port

type Doc = Record<string, unknown>

/**
 * Order two values the way Mongo does: strings against strings, numbers against
 * numbers.
 *
 * These operators used to coerce both sides with `Number()`, which is fine for
 * the timestamp ranges this fake was written for and silently WRONG for date
 * strings — `Number('2026-05-04')` is NaN, every comparison is false, and a
 * range query returns an empty array rather than failing. A fake that answers
 * "no rows" to a query real Mongo would answer is worse than one that throws:
 * the test goes green in the wrong direction.
 */
function cmp(a: unknown, b: unknown): number | null {
  /**
   * NULL MEANS "DIFFERENT BSON TYPES", and a range operator on it is FALSE.
   *
   * That is real Mongo's behaviour and the fake used to hide it: `Number(a)`
   * turns a `Date` into epoch ms, so a Date-typed `createdAt` matched a numeric
   * `{$gte, $lt}` range here while matching NOTHING in the database (type
   * bracketing — a comparison operator only ever considers values of the
   * operand's own type). That is exactly the defect F-53 records for
   * `loadFills`, so a fake that coerces cannot be used to test the fix.
   */
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
 * Read a possibly-DOTTED key, the way Mongo does: `detail.mode` reaches into
 * the nested object rather than looking for a literal key with a dot in it.
 *
 * Needed because the order log filters on `detail.mode` to tell a paper refusal
 * from a live one. A fake that returned `undefined` for it would answer "no
 * rows" to a query real Mongo answers — a test going green in the wrong
 * direction, which is worse than one that throws.
 */
function at(doc: Doc, key: string): unknown {
  if (!key.includes('.')) return doc[key]
  let cur: unknown = doc
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Doc)[part]
  }
  return cur
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, want]) => {
    // `$or` is a top-level operator, not a field: its operand is a list of
    // whole filters and the document need satisfy only one of them.
    if (key === '$or') {
      return Array.isArray(want) && want.some((sub) => matches(doc, sub as Doc))
    }
    const actual = at(doc, key)
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
          case '$in':
            return Array.isArray(operand) && operand.includes(actual)
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
        const less = typeof x === 'string' || typeof y === 'string' ? String(x) < String(y) : Number(x) < Number(y)
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
  async findOne(filter: Doc): Promise<T | null> {
    return (this.docs.find((d) => matches(d, filter)) as T | undefined) ?? null
  }
  find(filter: Doc): FindCursor<T> {
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
  /** Recorded, so a test can assert the index a hot query depends on exists. */
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
}

// ------------------------------------------------------------------ fixture

const DAY = '2026-07-27'
const { from: DAY_START } = istDayRange(DAY)
/** 10:00 IST on a Monday. Inside the session, so marks are meaningful. */
const NOW = DAY_START + (10 * 60 + 0) * 60_000
const T = (minutes: number): number => DAY_START + minutes * 60_000

const CE = 'BHEL26AUG420CE'
const PE = 'BHEL26AUG400PE'

function master(): OptionMaster {
  return new OptionMaster([
    {
      instrument_token: 4201,
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
      instrument_token: 4002,
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

interface Harness {
  db: FakeDb
  deps: ApiDeps
  opts: PnlOptions
  store: PnlStore
}

function harness(marks: Record<string, number>, now = NOW): Harness {
  const db = new FakeDb()
  const store = new DeskStore(db)
  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(db), live: new LiveRail(db, []) },
    master: { current: master },
    marks: new StaticMarks(),
    clock: { now: () => now },
  })
  const deps: ApiDeps = {
    db,
    store,
    service,
    master: { current: master },
    log: () => {},
    now: () => now,
  }
  return {
    db,
    deps,
    store: new PnlStore(db),
    // Injected rather than driven off a QuoteCache: a test that had to fake a
    // live feed to assert a JSON shape would be testing the feed.
    opts: { marks: (symbols) => pick(marks, symbols), lookbackDays: 30 },
  }
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
  mode: 'paper' | 'live'
  /** A `Date` here is not hypothetical — see the type-bracketing test below. */
  createdAt: number | Date
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

interface Sent {
  status: number
  body: Doc
}

async function call(
  route: ReturnType<typeof pnlRoutes>,
  method: string,
  target: string,
  body: unknown = {},
): Promise<Sent> {
  const url = new URL(`http://desk${target}`)
  const sent: Sent = { status: 0, body: {} }
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method,
    principal: { kind: 'user', name: 'tester' },
    log: () => {},
    readJson: async () => body,
    send: (status, payload) => {
      sent.status = status
      sent.body = payload as Doc
    },
  }
  const handled = await route(ctx)
  assert.equal(handled, true, `${method} ${target} was not handled`)
  return sent
}

// --------------------------------------------------------------- /desk/pnl

test('GET /v1/desk/pnl returns the contract shape with a fully marked book', async () => {
  const h = harness({ [CE]: 12, [PE]: 9 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL', label: 'BHEL strangle' }, NOW)
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 13125, 15, T(5)), sell(PE, 13125, 11, T(5))],
  })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(60), fills: [buy(PE, 13125, 9, T(60))] })

  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  assert.equal(res.status, 200)
  assert.equal(res.body['asOf'], NOW)
  assert.equal(res.body['mode'], 'paper')

  const rows = res.body['strategies'] as Doc[]
  const row = rows.find((r) => r['tag'] === 'DESK_BHEL')
  assert.equal(row?.['label'], 'BHEL strangle')
  assert.equal(row?.['realised'], 13125 * 2)
  assert.equal(row?.['unrealised'], 13125 * 3)
  assert.equal(row?.['total'], 13125 * 5)
  assert.equal(row?.['openLegs'], 1)
  assert.deepEqual(row?.['unpriced'], [])
  assert.equal(row?.['complete'], true)

  const totals = res.body['totals'] as Doc
  assert.equal(totals['total'], 13125 * 5)
  assert.equal(totals['complete'], true)
})

test('an unmarked open leg reports null, not zero, and names the contract', async () => {
  // The feed has the CE but nothing for the PE — the exact case Phase B §8 is
  // about. A ₹0 here and a ₹0 on a genuinely flat book must not be the same
  // JSON.
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 13125, 15, T(5)), sell(PE, 13125, 11, T(5))],
  })

  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  const row = (res.body['strategies'] as Doc[]).find((r) => r['tag'] === 'DESK_BHEL')
  assert.equal(row?.['unrealised'], null)
  assert.equal(row?.['total'], null)
  assert.equal(row?.['complete'], false)
  assert.deepEqual(row?.['unpriced'], [PE])
  assert.equal(row?.['realised'], 0, 'realised is booked and no mark can change it')
  assert.equal(row?.['openLegs'], 2, 'the unmarked leg is still an open leg')

  const totals = res.body['totals'] as Doc
  assert.equal(totals['unrealised'], null, 'one unmarked book makes the DESK total unknown')
  assert.equal(totals['total'], null)
  assert.equal(totals['complete'], false)
})

test('a fill we cannot read is reported as unpriced, never silently dropped', async () => {
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [
      sell(CE, 13125, 15, T(5)),
      // Price corrupted upstream. `@algomaker/pnl` would throw on this; the
      // store drops it, and the row has to admit that it did.
      { op: 'open', deskTag: 'y', tradingsymbol: PE, side: 'Sell', qty: 13125, price: 'NaN', ts: T(5) },
    ],
  })

  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  const row = (res.body['strategies'] as Doc[]).find((r) => r['tag'] === 'DESK_BHEL')
  assert.equal(row?.['complete'], false)
  assert.equal(row?.['total'], null)
  assert.deepEqual(row?.['unpriced'], [PE])
})

test('paper and live are separate books for the same tag', async () => {
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  decision(h, { tag: 'DESK_BHEL', mode: 'live', createdAt: T(6), fills: [sell(CE, 50, 20, T(6))] })

  const paper = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  const live = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=live')
  const of = (r: Sent): Doc | undefined =>
    (r.body['strategies'] as Doc[]).find((s) => s['tag'] === 'DESK_BHEL')
  assert.equal(of(paper)?.['unrealised'], 100 * 3)
  assert.equal(of(live)?.['unrealised'], 50 * 8)
})

test('a tag that trades without a registry row is still reported', async () => {
  const h = harness({ [CE]: 12 })
  decision(h, { tag: 'GHOST', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  const row = (res.body['strategies'] as Doc[]).find((r) => r['tag'] === 'GHOST')
  assert.equal(row?.['label'], 'GHOST', 'a book that is trading must never be invisible')
  assert.equal(row?.['openLegs'], 1)
})

// -------------------------------------------------------- /desk/pnl/series

test('the series endpoint refuses to guess a tag', async () => {
  const h = harness({})
  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl/series?mode=paper')
  assert.equal(res.status, 400)
  assert.match(String(res.body['error']), /tag is required/)
})

test('snapshots persist and come back oldest-first, scoped to the day', async () => {
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })

  await snapshotOnce(h.deps, h.store, h.opts, T(10))
  await snapshotOnce(h.deps, h.store, h.opts, T(20))
  // Yesterday's point must not leak into today's default window.
  await h.store.writeSnapshots([
    { tag: 'DESK_BHEL', mode: 'paper', ts: DAY_START - 3_600_000, realised: 99, unrealised: 0, total: 99 },
  ])

  const res = await call(
    pnlRoutes(h.deps, h.opts),
    'GET',
    '/v1/desk/pnl/series?tag=DESK_BHEL&mode=paper',
  )
  const points = res.body['points'] as Doc[]
  assert.equal(points.length, 2)
  assert.equal(points[0]?.['ts'], T(10))
  assert.equal(points[1]?.['ts'], T(20))
  assert.equal(points[0]?.['total'], 300)
  assert.deepEqual(Object.keys(points[0] ?? {}).sort(), ['realised', 'total', 'ts', 'unrealised'])
})

test('the snapshot tick records a null total rather than a confident zero', async () => {
  const h = harness({})
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  const rows = await snapshotOnce(h.deps, h.store, h.opts, T(10))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.total, null)
  assert.equal(rows[0]?.unrealised, null)
  assert.equal(rows[0]?.realised, 0)
})

test('an idle strategy contributes no snapshot rows at all', async () => {
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_IDLE' }, NOW)
  const rows = await snapshotOnce(h.deps, h.store, h.opts, T(10))
  assert.deepEqual(rows, [], '1,500 zero rows a day for a strategy that never traded')
})

// ----------------------------------------------------------- /desk/reports

test('GET /v1/desk/reports marks a stored row rollup and a rebuilt one computed', async () => {
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  await h.deps.store.registerStrategy({ tag: 'DESK_NIFTY' }, NOW)
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5)), buy(CE, 100, 12, T(6))] })
  decision(h, { tag: 'DESK_NIFTY', mode: 'paper', createdAt: T(7), fills: [sell(PE, 100, 20, T(7)), buy(PE, 100, 15, T(8))] })

  // Only one of the two was rolled up — the other is the day the job missed.
  const written = await writeRollups(h.deps, h.store, h.opts, DAY, NOW)
  assert.equal(written.length, 2)
  h.db.rows('desk-daily-reports').splice(
    h.db.rows('desk-daily-reports').findIndex((r) => r['tag'] === 'DESK_NIFTY'),
    1,
  )

  const res = await call(reportRoutes(h.deps, h.opts), 'GET', `/v1/desk/reports?date=${DAY}`)
  const rows = res.body['rows'] as Doc[]
  assert.equal(rows.length, 2)
  assert.equal(rows.find((r) => r['tag'] === 'DESK_BHEL')?.['source'], 'rollup')
  const repaired = rows.find((r) => r['tag'] === 'DESK_NIFTY')
  assert.equal(repaired?.['source'], 'computed', 'a missing rollup is rebuilt, not shown blank')
  assert.equal(repaired?.['realised'], 500)

  const totals = res.body['totals'] as Doc
  assert.equal(totals['realised'], 300 + 500)
  assert.equal(totals['orderCount'], 4)
})

test('a rejected date is a 400, not a silent default', async () => {
  const h = harness({})
  const res = await call(reportRoutes(h.deps, h.opts), 'GET', '/v1/desk/reports?date=yesterday')
  assert.equal(res.status, 400)
})

test('the day report totals go null when one strategy could not be priced', async () => {
  const h = harness({})
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 100, 15, T(5))] })
  const res = await call(reportRoutes(h.deps, h.opts), 'GET', `/v1/desk/reports?date=${DAY}`)
  const rows = res.body['rows'] as Doc[]
  assert.equal(rows[0]?.['total'], null)
  assert.equal(rows[0]?.['closingSource'], 'none')
  assert.equal((res.body['totals'] as Doc)['total'], null)
})

test('the order log is scoped to the IST day and can be filtered to failures', async () => {
  const h = harness({})
  const events = h.db.rows('desk-order-events')
  events.push({ clientOrderId: 'a', tag: 'DESK_BHEL', ok: true, ts: T(30), phase: 'ACK' })
  events.push({ clientOrderId: 'b', tag: 'DESK_BHEL', ok: false, ts: T(40), phase: 'FAILED' })
  events.push({ clientOrderId: 'c', tag: 'DESK_NIFTY', ok: false, ts: T(50), phase: 'FAILED' })
  // 23:30 IST the previous day — a UTC-based day boundary would swallow this.
  events.push({ clientOrderId: 'd', tag: 'DESK_BHEL', ok: false, ts: DAY_START - 30 * 60_000, phase: 'FAILED' })

  // `mode=live` because these are gateway-shaped rows: the gateway is the LIVE
  // rail and stamps no `detail.mode`, which is exactly how the log tells them
  // from a paper refusal. The mode split itself is asserted separately below.
  const all = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=live`,
  )
  assert.equal((all.body['events'] as Doc[]).length, 3)

  const failures = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=live&tag=DESK_BHEL&failures=1`,
  )
  const ids = (failures.body['events'] as Doc[]).map((e) => e['clientOrderId'])
  assert.deepEqual(ids, ['b'])
})

/**
 * WHY EACH ORDER WENT OUT rides the order log (2026-10-05).
 *
 * The journal says what happened to an order and never why it was placed, so
 * the reports log could not tell the day's open from an adjustment or the EOD
 * flatten. The supervisor's own journal holds the trigger and reason per
 * decision, and every engine order id is `<decisionId>#<leg>` — so both are
 * stamped on the read, ADDITIVELY: an order with no journal row (a manual
 * close) comes back exactly as it was.
 */
test('the order log carries the deciding trigger and reason, and leaves an unjournalled order alone', async () => {
  const h = harness({})
  h.db.rows('desk-engine-decisions').push({
    decisionId: 'BK:live:1', tag: 'DESK_BHEL', trigger: 'dl-open',
    reason: 'trend-up: opening up, 2 leg(s) at 2 lot(s) a leg, hedge included',
  })
  const events = h.db.rows('desk-order-events')
  events.push({ clientOrderId: 'BK:live:1#0', tag: 'DESK_BHEL', ok: true, ts: T(30), phase: 'ACK' })
  // A split tranche of the same decision's second leg.
  events.push({ clientOrderId: 'BK:live:1#1.2', tag: 'DESK_BHEL', ok: true, ts: T(31), phase: 'STATUS' })
  events.push({ clientOrderId: 'opclose:DESK_BHEL:live:X:1#0', tag: 'DESK_BHEL', ok: true, ts: T(32), phase: 'ACK' })

  const res = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=live&tag=DESK_BHEL`,
  )
  const byId = new Map((res.body['events'] as Doc[]).map((e) => [e['clientOrderId'], e]))
  assert.equal(byId.get('BK:live:1#0')?.['trigger'], 'dl-open')
  assert.equal(byId.get('BK:live:1#1.2')?.['trigger'], 'dl-open', 'a tranche joins on its decision')
  assert.match(String(byId.get('BK:live:1#0')?.['reason']), /opening up/)
  assert.equal('trigger' in (byId.get('opclose:DESK_BHEL:live:X:1#0') ?? {}), false)
})

/**
 * A POSITIONAL BOOK'S LOG DOES NOT START THIS MORNING.
 *
 * `desk-books-registry` rows are held for weeks, so the trade that OPENED the
 * book — the one an operator most often comes looking for — falls outside every
 * day but the first, and a log bounded to `date` could never show it. `from`
 * widens the window backwards and nothing else about the endpoint moves: the
 * default is still exactly one IST day, which is a hosted strategy's whole life.
 */
test('the order log can be asked for a RANGE of days, and defaults to one', async () => {
  const h = harness({})
  const events = h.db.rows('desk-order-events')
  const DAYS = 24 * 60 * 60_000
  // The opening trade, three days before the day being asked about.
  events.push({ clientOrderId: 'open', tag: 'DESK_BHEL', ok: true, ts: DAY_START - 3 * DAYS, phase: 'ACK' })
  events.push({ clientOrderId: 'roll', tag: 'DESK_BHEL', ok: true, ts: DAY_START - 1 * DAYS, phase: 'ACK' })
  events.push({ clientOrderId: 'today', tag: 'DESK_BHEL', ok: true, ts: T(30), phase: 'ACK' })

  const oneDay = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=live&tag=DESK_BHEL`,
  )
  assert.deepEqual(
    (oneDay.body['events'] as Doc[]).map((e) => e['clientOrderId']),
    ['today'],
    'unchanged for every caller that sends no `from`',
  )
  assert.equal(oneDay.body['from'], undefined, 'a window nobody asked for is not echoed')

  const since = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&from=2026-07-24&mode=live&tag=DESK_BHEL`,
  )
  assert.deepEqual(
    (since.body['events'] as Doc[]).map((e) => e['clientOrderId']),
    ['today', 'roll', 'open'],
    'newest first, back to the day the book was opened',
  )
  assert.equal(since.body['from'], '2026-07-24')
})

test('a from that is not a day, or is after the day, is a 400 rather than a silent window', async () => {
  const h = harness({})
  const bad = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&from=last-month`,
  )
  assert.equal(bad.status, 400)
  // Inverted, which would otherwise read as an empty log rather than a mistake.
  const inverted = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&from=2026-08-01`,
  )
  assert.equal(inverted.status, 400)
})

test('the date picker lists days that traded even when they were never rolled up', async () => {
  const h = harness({})
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [sell(CE, 1, 1, T(5))] })
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: DAY_START - 20 * 60 * 60 * 1000,
    fills: [sell(CE, 1, 1, DAY_START - 20 * 60 * 60 * 1000)],
  })
  const res = await call(reportRoutes(h.deps, h.opts), 'GET', '/v1/desk/reports/dates')
  const dates = res.body['dates'] as string[]
  assert.equal(dates[0], DAY, 'newest first')
  assert.equal(dates[1], '2026-07-26')
})

// ------------------------------------------------- one strategy over a range

/** A stored rollup, with only the fields these tests care about varied. */
function report(over: {
  date: string; tag: string; mode: 'paper' | 'live'; realised: number; total: number | null
}): DailyReport {
  return {
    date: over.date,
    tag: over.tag,
    mode: over.mode,
    realised: over.realised,
    gross: over.realised,
    fees: 0,
    total: over.total,
    maxProfit: null,
    maxLoss: null,
    orderCount: 1,
    closingPositions: 0,
    snapshots: 0,
    closingSource: 'marks',
    writtenAt: NOW,
  }
}

/**
 * The reports page's main view: how has THIS strategy been doing, over months.
 *
 * The two things worth asserting are what the old whole-day summary could not
 * express — that a day with no stored rollup is ABSENT rather than a zero, and
 * that a single unmarked day makes the range total unknown instead of quietly
 * smaller.
 */
test('report history returns one tag over a range, oldest first', async () => {
  const { store } = harness({})
  await store.writeReport(report({ date: '2026-05-04', tag: 'A', mode: 'paper', realised: 100, total: 100 }))
  await store.writeReport(report({ date: '2026-05-06', tag: 'A', mode: 'paper', realised: 50, total: 50 }))
  await store.writeReport(report({ date: '2026-05-05', tag: 'B', mode: 'paper', realised: 999, total: 999 }))
  await store.writeReport(report({ date: '2026-05-05', tag: 'A', mode: 'live', realised: 777, total: 777 }))

  const rows = await store.reportHistory({ tag: 'A', mode: 'paper', from: '2026-05-01', to: '2026-05-31' })
  assert.deepEqual(rows.map((r) => r.date), ['2026-05-04', '2026-05-06'], 'oldest first')
  assert.equal(rows.length, 2, "another tag's and another mode's rows must not leak in")
})

test('a range excludes days outside it, on both bounds inclusively', async () => {
  const { store } = harness({})
  for (const date of ['2026-04-30', '2026-05-01', '2026-05-31', '2026-06-01']) {
    await store.writeReport(report({ date, tag: 'A', mode: 'paper', realised: 1, total: 1 }))
  }
  const rows = await store.reportHistory({ tag: 'A', mode: 'paper', from: '2026-05-01', to: '2026-05-31' })
  assert.deepEqual(rows.map((r) => r.date), ['2026-05-01', '2026-05-31'], 'both bounds are inclusive')
})

test('reportedTags lists each tag once, sorted, for the picker', async () => {
  const { store } = harness({})
  await store.writeReport(report({ date: '2026-05-04', tag: 'ZED', mode: 'paper', realised: 1, total: 1 }))
  await store.writeReport(report({ date: '2026-05-05', tag: 'ZED', mode: 'live', realised: 1, total: 1 }))
  await store.writeReport(report({ date: '2026-05-04', tag: 'ABE', mode: 'paper', realised: 1, total: 1 }))
  assert.deepEqual(await store.reportedTags(), ['ABE', 'ZED'])
})

// ------------------------------------------------- the fill read itself (A4)

/**
 * WHICH END OF THE WINDOW THE CAP CUTS.
 *
 * `loadFills` reads a MONTH of decisions, unscoped by tag, twice every fifteen
 * seconds, and it caps the read so 09:15 is not an OOM. The cap was applied
 * after an ASCENDING sort, so it kept the OLDEST 50,000 and silently discarded
 * everything after them — which on any desk that reaches the cap inside the
 * lookback means it discards TODAY. Nothing errors: P&L and positions simply
 * read flat.
 *
 * These use a tiny `limit` rather than 50,000 rows, because the property under
 * test is which end is dropped, not the size of the number.
 */
test('loadFills keeps the NEWEST decisions when it hits its cap, never the oldest', async () => {
  const h = harness({})
  for (let i = 0; i < 5; i++) {
    decision(h, {
      tag: 'DESK_BHEL',
      mode: 'paper',
      createdAt: T(i),
      fills: [sell(CE, 100 + i, 15, T(i))],
    })
  }
  const load = await h.store.loadFills({ from: DAY_START, to: NOW, limit: 2 })
  const fills = load.byKey.get('DESK_BHEL|paper') ?? []
  assert.equal(fills.length, 2)
  assert.deepEqual(
    fills.map((f) => f.qty),
    [103, 104],
    'the two most recent decisions, and still in ascending order',
  )
})

/**
 * BSON TYPE BRACKETING (audit F-53).
 *
 * `desk-decisions` is not written by this process alone: the Python desk and
 * every hand-repair through the shell stamp `createdAt` with whatever their
 * driver serialises, and a `Date` is the natural one. Mongo's comparison
 * operators bracket by type — `{$gte: <number>}` never matches a `Date`, no
 * error, just no row — so those decisions were INVISIBLE to P&L, to positions
 * and to every report built on `loadFills`. A leg that exists reads as flat,
 * which is the failure mode this whole file is written against.
 */
test('loadFills sees a Date-typed createdAt as well as a numeric one', async () => {
  const h = harness({})
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(1),
    fills: [sell(CE, 10, 15, T(1))],
  })
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: new Date(T(2)),
    fills: [sell(CE, 7, 16, T(2))],
  })

  const load = await h.store.loadFills({ from: DAY_START, to: NOW })
  const fills = load.byKey.get('DESK_BHEL|paper') ?? []
  assert.deepEqual(
    fills.map((f) => f.qty),
    [10, 7],
    'both decisions are in the window; the Date-typed one is not silently dropped',
  )
  // And it is filed under the right instant, not under NaN or 0: the fill's own
  // `ts` is used when present, but `createdAt` is the fallback for a fill
  // without one, and a Date must reduce to the same epoch a number would.
  assert.equal(fills[1]?.ts, T(2))
})

/**
 * AND THEY COME BACK IN ONE CHRONOLOGICAL STREAM, not two type-bracketed runs.
 *
 * Mongo sorts a mixed-type field BY TYPE first, so the single `$or` query this
 * read used to make returned every numeric decision and then every Date one —
 * `1,3,5` then `2,4`, an order that never happened. Average cost is
 * path-dependent, so that is a different realised P&L and a different average
 * on what remains. `pnlstore.test.ts` proves the ordering against the real
 * driver, where the type bracketing is the database's own; this proves the
 * merge, on the fake, so the property is checked on a laptop with no Mongo too.
 */
test('numeric and Date decisions interleave into ONE chronological stream', async () => {
  const h = harness({})
  const fill = (n: number): Doc => sell(CE, n, 15, T(n))
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(1), fills: [fill(1)] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: new Date(T(2)), fills: [fill(2)] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(3), fills: [fill(3)] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: new Date(T(4)), fills: [fill(4)] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(5), fills: [fill(5)] })

  const load = await h.store.loadFills({ from: DAY_START, to: NOW })
  assert.deepEqual(
    (load.byKey.get('DESK_BHEL|paper') ?? []).map((f) => f.qty),
    [1, 2, 3, 4, 5],
  )
  assert.equal(load.truncated, false)
})

test('the cap keeps the newest decisions ACROSS both stampings', async () => {
  const h = harness({})
  const fill = (n: number): Doc => sell(CE, n, 15, T(n))
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(1), fills: [fill(1)] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: new Date(T(2)), fills: [fill(2)] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(3), fills: [fill(3)] })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: new Date(T(4)), fills: [fill(4)] })

  const load = await h.store.loadFills({ from: DAY_START, to: NOW, limit: 2 })
  // A per-type cap would keep the newest two NUMBERS and throw the afternoon's
  // Date rows away — a partial read that renders as a smaller book.
  assert.deepEqual(
    (load.byKey.get('DESK_BHEL|paper') ?? []).map((f) => f.qty),
    [3, 4],
  )
  assert.equal(load.truncated, true)
})

test('a Date-typed decision OUTSIDE the window is still excluded', async () => {
  const h = harness({})
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: new Date(DAY_START - 60 * 60_000),
    fills: [sell(CE, 99, 15, DAY_START - 60 * 60_000)],
  })
  const load = await h.store.loadFills({ from: DAY_START, to: NOW })
  assert.equal(load.byKey.size, 0, 'tolerating the type must not widen the window')
})

test('a capped read SAYS it was capped — "we stopped reading" is not "nothing to read"', async () => {
  const h = harness({})
  for (let i = 0; i < 3; i++) {
    decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(i), fills: [sell(CE, 100, 15, T(i))] })
  }
  assert.equal((await h.store.loadFills({ from: DAY_START, to: NOW, limit: 3 })).truncated, true)
  assert.equal((await h.store.loadFills({ from: DAY_START, to: NOW, limit: 4 })).truncated, false)
  assert.equal((await h.store.loadFills({ from: DAY_START, to: NOW })).truncated, false)
})

test('a truncated read makes the desk P&L total UNKNOWN rather than understated', async () => {
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  for (let i = 0; i < 3; i++) {
    decision(h, {
      tag: 'DESK_BHEL',
      mode: 'paper',
      createdAt: T(i),
      fills: [sell(CE, 100, 15, T(i)), buy(CE, 100, 12, T(i))],
    })
  }
  const whole = await livePnl(h.deps, h.store, h.opts, 'paper', NOW)
  assert.equal(whole.truncated, false)
  assert.equal(whole.totals.complete, true)
  assert.equal(whole.totals.total, 900, 'three round trips at 3 a contract')

  const capped = await livePnl(h.deps, h.store, { ...h.opts, fillLimit: 2 }, 'paper', NOW)
  assert.equal(capped.truncated, true, 'the figure below is built from a SUBSET')
  assert.equal(capped.totals.complete, false)
  assert.equal(capped.totals.total, null, 'a partial read must not present a confident number')
})

// ------------------------------------------------ per-mode report totals (A8)

/**
 * A MODE WITH NO ROWS HAS NO TOTAL — it does not have a total of zero.
 *
 * `totalsByMode` seeded `total: 0` per mode, so a day on which the live rail did
 * not trade (or on which the rollup job never ran) reported a confident `₹0` for
 * live, sitting next to a real paper figure as though the two were comparable
 * measurements. It is the same "0 is not a number we computed" failure that
 * `numberOrNull`, `PnlRow.total` and `DailyReport.total` all exist to prevent,
 * arriving one layer higher up.
 */
test('a mode with no rows reports total null and strategies 0, never ₹0', async () => {
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 100, 15, T(5)), buy(CE, 100, 12, T(6))],
  })

  const res = await call(reportRoutes(h.deps, h.opts), 'GET', `/v1/desk/reports?date=${DAY}`)
  const byMode = res.body['totalsByMode'] as Record<string, Doc>
  assert.equal(byMode['paper']?.['total'], 300, 'paper traded and its total is a number')
  assert.equal(byMode['paper']?.['strategies'], 1)
  assert.equal(byMode['live']?.['total'], null, 'live has no data — that is not a flat day')
  assert.equal(byMode['live']?.['strategies'], 0)
  assert.equal(byMode['live']?.['realised'], 0, 'a sum of nothing is 0; `strategies` says what that is worth')
})

test('a mode whose rows genuinely net to zero still reports 0, not null', async () => {
  // The other side of the same coin: "no data" and "flat" must not collapse
  // into one another in EITHER direction.
  const h = harness({ [CE]: 15 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL' }, NOW)
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 100, 15, T(5)), buy(CE, 100, 15, T(6))],
  })
  const res = await call(reportRoutes(h.deps, h.opts), 'GET', `/v1/desk/reports?date=${DAY}`)
  const byMode = res.body['totalsByMode'] as Record<string, Doc>
  assert.equal(byMode['paper']?.['total'], 0)
  assert.equal(byMode['paper']?.['strategies'], 1)
})

/**
 * THE INDEX THE 15-SECOND SNAPSHOT ACTUALLY QUERIES ON.
 *
 * `livePnl` reads a month of decisions filtered by `{createdAt: range, mode}`
 * with NO tag, twice per tick. The only index that existed was
 * `(tag, mode, createdAt)`, whose leading field is absent from that filter — so
 * it cannot serve the query at all and every tick was a full collection scan of
 * the busiest collection in the system, four times a minute, forever. Nothing
 * fails; it just gets slower until it does.
 *
 * Asserted as an ORDERED key list because the order is the whole point:
 * equality first, then the field the range and the sort share.
 */
test('ensureIndexes creates the (mode, createdAt) index the snapshot query needs', async () => {
  const h = harness({})
  await h.store.ensureIndexes()
  const specs = (h.db.collection('desk-decisions') as unknown as FakeCollection<unknown>).indexes
  const keyLists = specs.map((s) => Object.keys(s).join(','))
  assert.ok(
    keyLists.includes('mode,createdAt'),
    `no index can serve {createdAt, mode}; got ${JSON.stringify(keyLists)}`,
  )
  // The tag-scoped read (`flattenTag`) keeps its own, which this must not replace.
  assert.ok(keyLists.includes('tag,mode,createdAt'), JSON.stringify(keyLists))
})

// ------------------------------------------------- hosted positions & orders

/**
 * THE 2026-07-28 DEFECT, in two halves.
 *
 * The dashboard read three different collections for three panels and hosted
 * strategies only ever wrote to one of them:
 *
 *  - P&L cards      <- `desk-decisions`     written by /v1/desk/submit  -> worked
 *  - Net positions  <- `desk-books`         written only by the Python desk's
 *                                           `declare` -> ALWAYS EMPTY
 *  - Order log      <- `desk-order-events`  written only by the LIVE gateway
 *                                           and by refusals -> EMPTY IN PAPER
 *
 * So a strategy holding six legs rendered "P&L reports 6 open legs for this tag
 * but none are recorded in a book — the desk and the bridge disagree", which is
 * the UI correctly alarming on a condition that is NORMAL for every hosted tag.
 *
 * The legs were never missing: `computeWindowPnl` nets them on every 15s tick
 * and `rowFor` threw everything but the COUNT away. These tests pin them to the
 * row that already carries the count, because a second reconstruction of "what
 * do we hold" is a second thing to keep in sync and the one that drifts is the
 * one that leaves a position open (`service.ts:802`).
 */
test('a P&L row carries the open legs it counted, so positions need no second source', async () => {
  const h = harness({ [CE]: 12, [PE]: 9 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL', label: 'BHEL strangle' }, NOW)
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 13125, 15, T(5)), sell(PE, 13125, 11, T(5))],
  })
  decision(h, { tag: 'DESK_BHEL', mode: 'paper', createdAt: T(60), fills: [buy(PE, 13125, 9, T(60))] })

  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  const rows = res.body['strategies'] as Doc[]
  const row = rows.find((r) => r['tag'] === 'DESK_BHEL')
  const legs = row?.['legs'] as Doc[] | undefined
  assert.ok(legs !== undefined, 'the row must carry its legs, not just a count of them')

  // BOTH contracts: the CE still open, and the PE bought back flat. A round
  // trip that opened and closed intraday is the most common thing a scalper
  // does, and hiding it left the table reading "no open legs" for a tag that
  // had traded all morning and booked real money.
  assert.equal(legs.length, 2, `the open CE and the closed PE; got ${JSON.stringify(legs)}`)

  const ce = legs.find((l) => l['tradingsymbol'] === CE)
  assert.equal(ce?.['qty'], -13125, 'short is negative — the same sign convention as apps/api')
  assert.equal(ce?.['avgCost'], 15)
  assert.equal(ce?.['mark'], 12)
  assert.equal(ce?.['unrealised'], 13125 * 3)

  const pe = legs.find((l) => l['tradingsymbol'] === PE)
  assert.equal(pe?.['qty'], 0, 'closed — and it says so with a zero, not by being absent')
  assert.equal(pe?.['realised'], 13125 * 2, 'the round trip it actually booked')
  /**
   * A CLOSED CONTRACT STILL CARRIES ITS LTP.
   *
   * `markOpenLegs` skips flat positions, so this used to come back null. But
   * after a round trip "where is it trading now?" is how you judge whether the
   * exit was early or late, and an em-dash answers nothing. `unrealised` stays
   * null regardless — there is no open quantity for a price to be unrealised
   * against, and a number there would imply exposure closed hours ago.
   */
  assert.equal(pe?.['mark'], 9, 'the closed contract reports the live mark')
  assert.equal(pe?.['unrealised'], null, 'but nothing is unrealised against it')
  assert.equal(pe?.['mtm'], 13125 * 2, 'a closed contract MTM is exactly what it booked')

  /**
   * THE TWO SIDES, AND THE IDENTITY THAT MAKES THEM CHECKABLE.
   *
   * The PE was sold 13125 @ 11 and bought back 13125 @ 9. A position book
   * whose net does not reconcile against its own buy and sell columns cannot
   * be verified by eye, which is the entire reason an operator opens it.
   */
  assert.equal(pe?.['sellQty'], 13125)
  assert.equal(pe?.['sellValue'], 13125 * 11)
  assert.equal(pe?.['buyQty'], 13125)
  assert.equal(pe?.['buyValue'], 13125 * 9)
  for (const l of legs) {
    assert.equal(
      l['qty'],
      Number(l['buyQty']) - Number(l['sellQty']),
      `${String(l['tradingsymbol'])}: net qty must equal buy - sell`,
    )
  }

  // The open CE was sold and never bought back: one side only.
  assert.equal(ce?.['sellQty'], 13125)
  assert.equal(ce?.['buyQty'], 0)
  assert.equal(ce?.['mtm'], 13125 * 3, 'open and marked: booked plus open')

  /**
   * `openLegs` COUNTS ONLY THE OPEN ONE. It feeds the snapshot's
   * idle-strategy filter and the rollup's `closingPositions`, both of which
   * mean OPEN — if it started counting closed round trips, an idle strategy
   * would look like it was holding and a day-end report would claim it closed
   * positions it never had.
   */
  assert.equal(row?.['openLegs'], 1)
})

test('an open leg with no mark is still listed, with a null mark rather than a zero', async () => {
  // Only the CE is marked. The PE leg is real, open, and carrying risk; it must
  // appear on the positions table saying its mark is UNKNOWN. Dropping it is
  // the Phase B §8 defect in a new place — a book that renders as smaller than
  // it is reads as "less exposure" and is the calmest-looking dangerous state.
  const h = harness({ [CE]: 12 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL', label: 'BHEL strangle' }, NOW)
  decision(h, {
    tag: 'DESK_BHEL',
    mode: 'paper',
    createdAt: T(5),
    fills: [sell(CE, 13125, 15, T(5)), sell(PE, 13125, 11, T(5))],
  })

  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  const rows = res.body['strategies'] as Doc[]
  const legs = (rows.find((r) => r['tag'] === 'DESK_BHEL')?.['legs'] ?? []) as Doc[]
  assert.equal(legs.length, 2, `both open legs must be listed; got ${JSON.stringify(legs)}`)

  const pe = legs.find((l) => l['tradingsymbol'] === PE)
  assert.equal(pe?.['qty'], -13125)
  assert.equal(pe?.['avgCost'], 11)
  assert.equal(pe?.['mark'], null, 'no mark is null, never 0 — see `unpriced`')
  assert.equal(pe?.['unrealised'], null, 'an unmarked leg contributes an UNKNOWN, not a ₹0')
})

/** A paper fill exactly as `PaperRail.route` writes it (`rail.ts:132`). */
function paperFill(h: Harness, f: {
  tag: string
  tradingsymbol: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  ts: number
  clientOrderId?: string
}): void {
  h.db.rows('desk-paper-trade').push({
    status: 'COMPLETE',
    order_timestamp: new Date(f.ts),
    exchange: 'NFO',
    tradingsymbol: f.tradingsymbol,
    instrument_token: 4201,
    order_type: 'MARKET',
    transaction_type: f.side,
    quantity: f.qty,
    filled_quantity: f.qty,
    tag: f.tag,
    underlying: 'BHEL',
    desk_tag: f.tag,
    desk_op: f.side === 'SELL' ? 'open' : 'close',
    price: f.price,
    clientOrderId: f.clientOrderId ?? `${f.tag}-1`,
    mode: 'paper',
  })
}

test('the paper order log reports the fills the paper rail wrote, with price and time', async () => {
  const h = harness({})
  paperFill(h, { tag: 'DESK_BHEL', tradingsymbol: CE, side: 'SELL', qty: 13125, price: 15, ts: T(5) })
  paperFill(h, { tag: 'OTHER', tradingsymbol: PE, side: 'SELL', qty: 2625, price: 4, ts: T(6) })

  const res = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=paper&tag=DESK_BHEL`,
  )
  assert.equal(res.status, 200)
  const events = res.body['events'] as Doc[]
  assert.equal(events.length, 1, `scoped to the tag asked for; got ${JSON.stringify(events)}`)

  const e = events[0] as Doc
  assert.equal(e['tradingsymbol'], CE)
  assert.equal(e['ts'], T(5), 'the time it executed')
  assert.equal(e['avgPrice'], 15, 'the price it executed at')
  assert.equal(e['filledQty'], 13125)
  assert.equal(e['side'], 'SELL')
  assert.equal(e['ok'], true)
  assert.equal(e['phase'], 'FILL')
})

test('a paper refusal appears in the paper log beside the fills, and survives the failures filter', async () => {
  // Refusals are journalled for BOTH modes (`submit.ts:#journal` stamps the
  // mode inside `detail`), so "show failures only" in paper must still answer
  // "what did the desk turn down today" — that is the whole question the
  // filter exists for.
  const h = harness({})
  paperFill(h, { tag: 'DESK_BHEL', tradingsymbol: CE, side: 'SELL', qty: 13125, price: 15, ts: T(5) })
  h.db.rows('desk-order-events').push({
    clientOrderId: 'c-1#0', phase: 'INVALID', ok: false, tag: 'DESK_BHEL',
    tradingsymbol: PE, ts: T(7), error: 'strategy is switched off in paper',
    detail: { source: 'submit', mode: 'paper' },
  })

  const all = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=paper&tag=DESK_BHEL`,
  )
  const events = all.body['events'] as Doc[]
  assert.equal(events.length, 2, `fill and refusal both; got ${JSON.stringify(events)}`)
  assert.equal(events[0]?.['ts'], T(7), 'newest first, across both sources')

  const failures = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=paper&tag=DESK_BHEL&failures=1`,
  )
  const only = failures.body['events'] as Doc[]
  assert.equal(only.length, 1)
  assert.equal(only[0]?.['ok'], false)
})

test('a LIVE order log never shows a paper refusal', async () => {
  // The mode switch has to mean something on this page too. A paper refusal
  // rendered under LIVE is a rejection an operator would go hunting for on a
  // rail that never saw it.
  const h = harness({})
  h.db.rows('desk-order-events').push({
    clientOrderId: 'c-1#0', phase: 'INVALID', ok: false, tag: 'DESK_BHEL',
    tradingsymbol: PE, ts: T(7), error: 'switched off in paper',
    detail: { source: 'submit', mode: 'paper' },
  })
  h.db.rows('desk-order-events').push({
    clientOrderId: 'c-2#0', phase: 'ACK', ok: true, tag: 'DESK_BHEL',
    tradingsymbol: CE, ts: T(8), brokerOrderId: 'X1',
  })

  const res = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=live&tag=DESK_BHEL`,
  )
  const events = res.body['events'] as Doc[]
  assert.equal(events.length, 1, `only the live event; got ${JSON.stringify(events)}`)
  assert.equal(events[0]?.['clientOrderId'], 'c-2#0')
})

/**
 * THE GATEWAY'S OWN ROWS SPLIT BY RAIL TOO, which they did not until D9.
 *
 * The filter has always been "paper iff the row says so", and it was correct
 * for every writer INSIDE desk-api. `apps/order-gateway` stamped nothing —
 * true while it only ever saw live orders, and false the moment D14 gave it the
 * engine's paper orders through the same queue. Its PLANNED / SUBMITTED / ACK /
 * STATUS rows for a rehearsal all fell on the LIVE side of this filter, so a
 * paper book's routing rendered on the live tab and was missing from its own.
 *
 * The gateway supplies `OrderEvent.mode` per event now and the journal writer
 * folds it into `detail.mode`, which is exactly what these two queries read.
 */
test('a gateway row stamped PAPER is on the paper log and off the live one', async () => {
  const h = harness({})
  // Three rows of one rehearsal, shaped as `OrderJournal.record` writes them.
  for (const [id, phase] of [['e-1#0', 'PLANNED'], ['e-1#0', 'SUBMITTED'], ['e-1#0', 'ACK']] as const) {
    h.db.rows('desk-order-events').push({
      clientOrderId: id, phase, ok: true, tag: 'DESK_BHEL',
      tradingsymbol: CE, ts: T(9), detail: { mode: 'paper' },
    })
  }
  // And one real live ACK on the same tag, the same day.
  h.db.rows('desk-order-events').push({
    clientOrderId: 'g-1#0', phase: 'ACK', ok: true, tag: 'DESK_BHEL',
    tradingsymbol: CE, ts: T(10), brokerOrderId: 'X9', detail: { mode: 'live' },
  })

  const live = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=live&tag=DESK_BHEL`,
  )
  assert.deepEqual(
    (live.body['events'] as Doc[]).map((e) => e['clientOrderId']),
    ['g-1#0'],
    'the rehearsal is not on the live tab',
  )

  const paper = await call(
    reportRoutes(h.deps, h.opts),
    'GET',
    `/v1/desk/reports/orders?date=${DAY}&mode=paper&tag=DESK_BHEL`,
  )
  const ids = (paper.body['events'] as Doc[]).map((e) => e['clientOrderId'])
  assert.equal(ids.filter((i) => i === 'e-1#0').length, 3, 'all three steps are on the paper tab')
  assert.ok(!ids.includes('g-1#0'), 'and the live ACK is not')
})

/**
 * A CARRIED BOOK'S LEGS MUST REPORT THIS WINDOW, NOT THE WHOLE LOOKBACK.
 *
 * `positions` is netted over `carried + during` — 30 days of it — so a leg's
 * `realised` is CUMULATIVE, while the card's `realised` subtracts
 * `carriedRealised` and reports only today. Both feed the same page: the strategy
 * view sums the legs into its Total row, the Positions pill shows the card. So a
 * short-premium book that carries — which is the NORMAL state for this desk, not
 * an edge case — showed two different totals for the same tag on two screens.
 *
 * A contract closed on a previous day also stayed in "Net positions" at qty 0
 * for the rest of the lookback, re-marked with today's LTP every day.
 */
test('a leg carried from a previous day reports TODAY, not the whole lookback', async () => {
  const h = harness({ [CE]: 25 })
  await h.deps.store.registerStrategy({ tag: 'DESK_BHEL', label: 'BHEL' }, NOW)

  // YESTERDAY. A PE round trip closed for +1000, and a CE half-covered for
  // +250 leaving 25 short. Both were reported on yesterday's card.
  decision(h, {
    tag: 'DESK_BHEL', mode: 'paper', createdAt: T(-600),
    fills: [sell(PE, 100, 20, T(-600)), sell(CE, 50, 30, T(-600))],
  })
  decision(h, {
    tag: 'DESK_BHEL', mode: 'paper', createdAt: T(-590),
    fills: [buy(PE, 100, 10, T(-590)), buy(CE, 25, 20, T(-590))],
  })

  // TODAY: nothing traded at all.
  const res = await call(pnlRoutes(h.deps, h.opts), 'GET', '/v1/desk/pnl?mode=paper')
  const row = (res.body['strategies'] as Doc[]).find((r) => r['tag'] === 'DESK_BHEL')

  assert.equal(row?.['realised'], 0, 'nothing was booked today')

  const legs = (row?.['legs'] ?? []) as Doc[]
  // The PE closed YESTERDAY. It is not a position and it is not today's work.
  assert.equal(
    legs.find((l) => l['tradingsymbol'] === PE),
    undefined,
    `a round trip closed on a previous day is not in today's book; got ${JSON.stringify(legs)}`,
  )

  const ce = legs.find((l) => l['tradingsymbol'] === CE)
  assert.equal(ce?.['qty'], -25, 'still short 25 — genuinely carried, so it belongs here')
  assert.equal(ce?.['realised'], 0, "yesterday's +250 was reported yesterday")
  // Short 25 at avg 30, marked 25 => -25 * (25 - 30) = +125.
  assert.equal(ce?.['unrealised'], 125)
  assert.equal(ce?.['mtm'], 125, 'MTM must not carry a prior day booked profit')

  // THE WHOLE POINT: the legs must sum to the card, or one screen lies.
  const summed = legs.reduce((n, l) => n + Number(l['mtm']), 0)
  assert.equal(summed, row?.['total'], 'the legs table and the P&L card must agree')
})
