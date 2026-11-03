/**
 * Retention (Phase B §6), where the whole design lives in one rule: never
 * delete a day whose rollup has not been written.
 *
 * This is why the job exists instead of a Mongo TTL index, which is the obvious
 * mechanism and the wrong one — a TTL index deletes on a timestamp and cannot
 * express "only if summarised", so it would happily delete the intraday detail
 * of a day the rollup job missed while the process was down. These tests are
 * the executable version of that argument.
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
import { istDate, istDayRange } from '../src/routes/kit.ts'
import { reportRoutes } from '../src/routes/reports.ts'
import { repairRollups, runPrune, startPnlJobs, writeRollups, type PnlOptions } from '../src/pnl-jobs.ts'
import { PnlStore, PNL_SNAPSHOTS, DAILY_REPORTS } from '../src/pnlstore.ts'

// ------------------------------------------------------------- the fake port

type Doc = Record<string, unknown>

/**
 * Order two values the way Mongo does: strings against strings, numbers against
 * numbers.
 *
 * These operators used to coerce both sides with `Number()`, which is fine for
 * the timestamp ranges this fake was written for and silently WRONG for date
 * strings — `Number('2026-05-04')` is NaN, every comparison is false, and
 * `reportHistory`'s `{date: {$gte, $lte}}` range returns an empty array rather
 * than failing. A fake that answers "no rows" to a query real Mongo would answer
 * is worse than one that throws: the test goes green in the wrong direction.
 * Copied verbatim from `pnl-routes.test.ts`, where it was already repaired.
 *
 * AND IT BRACKETS BY BSON TYPE, from the same source and for a second reason:
 * `loadFills` reads its window as TWO typed range queries — numeric and `Date`
 * — and merges them (see `pnlstore.ts`). A `cmp` that coerces answers BOTH
 * queries with the same numeric decision, so every fill in the rollup arrives
 * twice and the day's realised P&L doubles inside the fake.
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
    // `$or` IS implemented rather than thrown on (see the note below): it is a
    // top-level operator and the order log still uses one.
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
            // THROW, never `return false`. Answering "no rows" to an operator the
            // fake does not implement ($in, $exists) is indistinguishable
            // from a real empty result, so the day production starts using one
            // the tests keep passing while the query returns nothing.
            throw new Error(`fake db: unsupported operator ${op}`)
        }
      })
    }
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
  async createIndex(): Promise<unknown> {
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

const DAY_MS = 24 * 60 * 60 * 1000
const CE = 'BHEL26AUG420CE'
/** 02:00 IST — when the nightly prune actually runs. */
const NOW = istDayRange('2026-07-27').from + 2 * 60 * 60 * 1000
const SUMMARISED = istDate(NOW - 40 * DAY_MS)
const UNSUMMARISED = istDate(NOW - 39 * DAY_MS)
const RECENT = istDate(NOW - 3 * DAY_MS)

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
  ])
}

interface Harness {
  db: FakeDb
  deps: ApiDeps
  store: PnlStore
  opts: PnlOptions
}

function harness(): Harness {
  const db = new FakeDb()
  const store = new DeskStore(db)
  const deps: ApiDeps = {
    db,
    store,
    service: new BridgeService({
      store,
      rails: { paper: new PaperRail(db), live: new LiveRail(db, []) },
      master: { current: master },
      marks: new StaticMarks(),
      clock: { now: () => NOW },
    }),
    master: { current: master },
    log: () => {},
    now: () => NOW,
  }
  return {
    db,
    deps,
    store: new PnlStore(db),
    opts: { marks: () => ({ [CE]: 12 }), lookbackDays: 5, keepDays: 30, repairDays: 45 },
  }
}

/** A day that traded, was snapshotted, and closed flat. */
async function tradingDay(h: Harness, date: string, tag: string): Promise<void> {
  const { from } = istDayRange(date)
  const at = from + 10 * 60 * 60 * 1000
  h.db.rows('desk-decisions').push({
    decisionId: `d-${date}-${tag}`,
    symbol: 'BHEL',
    expiry: '2026-08-25',
    tag,
    mode: 'paper',
    createdAt: at,
    fills: [
      { op: 'open', deskTag: 'x', tradingsymbol: CE, side: 'Sell', qty: 100, price: 15, ts: at },
      { op: 'close', deskTag: 'x', tradingsymbol: CE, side: 'Buy', qty: 100, price: 12, ts: at + 60_000 },
    ],
    skips: [],
  })
  await h.store.writeSnapshots([
    { tag, mode: 'paper', ts: at, realised: 0, unrealised: 0, total: 0 },
    { tag, mode: 'paper', ts: at + 60_000, realised: 300, unrealised: 0, total: 300 },
  ])
}

// ------------------------------------------------------------------- tests

test('a day whose rollup was never written is skipped, and the reason names the strategy', async () => {
  const h = harness()
  await tradingDay(h, SUMMARISED, 'DESK_BHEL')
  await tradingDay(h, UNSUMMARISED, 'DESK_BHEL')
  await writeRollups(h.deps, h.store, h.opts, SUMMARISED, NOW)

  const result = await runPrune(h.store, { nowMs: NOW, keepDays: 30, dryRun: false })
  const byDate = new Map(result.days.map((d) => [d.date, d]))

  assert.equal(byDate.get(SUMMARISED)?.action, 'delete')
  assert.equal(byDate.get(UNSUMMARISED)?.action, 'skip')
  assert.match(byDate.get(UNSUMMARISED)?.reason ?? '', /DESK_BHEL\|paper/)
  assert.match(byDate.get(UNSUMMARISED)?.reason ?? '', /never summarised/)

  const left = h.db.rows(PNL_SNAPSHOTS)
  const { from, to } = istDayRange(UNSUMMARISED)
  assert.equal(
    left.filter((r) => Number(r['ts']) >= from && Number(r['ts']) < to).length,
    2,
    'the unsummarised day keeps every snapshot',
  )
  assert.equal(left.length, 2, 'and only the summarised day was deleted')
})

test('dry run mutates nothing', async () => {
  const h = harness()
  await tradingDay(h, SUMMARISED, 'DESK_BHEL')
  await writeRollups(h.deps, h.store, h.opts, SUMMARISED, NOW)

  const before = h.db.rows(PNL_SNAPSHOTS).length
  const reportsBefore = h.db.rows(DAILY_REPORTS).length
  assert.ok(before > 0)

  const preview = await runPrune(h.store, { nowMs: NOW, keepDays: 30, dryRun: true })
  assert.equal(preview.deleted, before, 'the preview still says exactly what would go')
  assert.equal(preview.days[0]?.action, 'delete')
  assert.equal(h.db.rows(PNL_SNAPSHOTS).length, before, 'a preview must delete nothing')
  assert.equal(h.db.rows(DAILY_REPORTS).length, reportsBefore)
})

test('days inside the retention window are not candidates at all', async () => {
  const h = harness()
  await tradingDay(h, RECENT, 'DESK_BHEL')
  const result = await runPrune(h.store, { nowMs: NOW, keepDays: 30, dryRun: false })
  assert.deepEqual(result.days, [])
  assert.equal(h.db.rows(PNL_SNAPSHOTS).length, 2)
})

test('rollups are kept forever; only the intraday detail is pruned', async () => {
  const h = harness()
  await tradingDay(h, SUMMARISED, 'DESK_BHEL')
  await writeRollups(h.deps, h.store, h.opts, SUMMARISED, NOW)
  await runPrune(h.store, { nowMs: NOW, keepDays: 30, dryRun: false })

  assert.equal(h.db.rows(PNL_SNAPSHOTS).length, 0)
  const kept = h.db.rows(DAILY_REPORTS)
  assert.equal(kept.length, 1)
  assert.equal(kept[0]?.['realised'], 300, 'the summary of the deleted day is still there')
  assert.equal(kept[0]?.['maxProfit'], 300)
  assert.equal(kept[0]?.['maxLoss'], 0)
})

test('repairing a missed rollup makes the day prunable, which is the point of the repair', async () => {
  const h = harness()
  await tradingDay(h, UNSUMMARISED, 'DESK_BHEL')

  const blocked = await runPrune(h.store, { nowMs: NOW, keepDays: 30, dryRun: true })
  assert.equal(blocked.days[0]?.action, 'skip')

  // The process was down at 15:40 that day. It comes back up and repairs.
  const repaired = await repairRollups(h.deps, h.store, h.opts, NOW)
  assert.ok(repaired.some((d) => d.startsWith(UNSUMMARISED)), `expected ${UNSUMMARISED} in ${repaired.join()}`)

  const after = await runPrune(h.store, { nowMs: NOW, keepDays: 30, dryRun: false })
  assert.equal(after.days[0]?.action, 'delete')
  assert.equal(h.db.rows(PNL_SNAPSHOTS).length, 0)
  // Recomputed from fills days later and still the same number.
  assert.equal(h.db.rows(DAILY_REPORTS)[0]?.['realised'], 300)
})

test('the repair never restamps a rollup that already exists', async () => {
  const h = harness()
  await tradingDay(h, SUMMARISED, 'DESK_BHEL')
  await writeRollups(h.deps, h.store, h.opts, SUMMARISED, NOW - 1_000)
  const stamped = h.db.rows(DAILY_REPORTS)[0]?.['writtenAt']

  await repairRollups(h.deps, h.store, h.opts, NOW)
  assert.equal(h.db.rows(DAILY_REPORTS).length, 1)
  assert.equal(h.db.rows(DAILY_REPORTS)[0]?.['writtenAt'], stamped)
})

// ------------------------------------------------------- the HTTP endpoint

interface Sent {
  status: number
  body: Doc
}

async function call(
  route: ReturnType<typeof reportRoutes>,
  method: string,
  target: string,
  body: unknown,
): Promise<Sent> {
  const url = new URL(`http://desk${target}`)
  const sent: Sent = { status: 0, body: {} }
  const handled = await route({
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
  } satisfies RouteCtx)
  assert.equal(handled, true)
  return sent
}

test('POST /v1/desk/reports/prune defaults to a preview when dryRun is not stated', async () => {
  const h = harness()
  await tradingDay(h, SUMMARISED, 'DESK_BHEL')
  await writeRollups(h.deps, h.store, h.opts, SUMMARISED, NOW)

  const res = await call(reportRoutes(h.deps, h.opts), 'POST', '/v1/desk/reports/prune', {})
  assert.equal(res.status, 200)
  assert.equal(res.body['dryRun'], true)
  assert.equal(res.body['wouldDelete'], 2)
  assert.equal(res.body['deleted'], undefined, 'a preview must never report a deletion')
  assert.equal(h.db.rows(PNL_SNAPSHOTS).length, 2)
})

test('POST /v1/desk/reports/prune with dryRun false deletes and reports every skipped day', async () => {
  const h = harness()
  await tradingDay(h, SUMMARISED, 'DESK_BHEL')
  await tradingDay(h, UNSUMMARISED, 'DESK_NIFTY')
  await writeRollups(h.deps, h.store, h.opts, SUMMARISED, NOW)

  const res = await call(reportRoutes(h.deps, h.opts), 'POST', '/v1/desk/reports/prune', {
    dryRun: false,
    keepDays: 30,
  })
  assert.equal(res.body['deleted'], 2)
  assert.equal(res.body['wouldDelete'], undefined)
  const days = res.body['days'] as Doc[]
  const skipped = days.find((d) => d['action'] === 'skip')
  assert.equal(skipped?.['date'], UNSUMMARISED)
  assert.match(String(skipped?.['reason']), /DESK_NIFTY\|paper/)
  assert.equal(h.db.rows(PNL_SNAPSHOTS).length, 2, 'the skipped day survives')
})

test('a nonsense keepDays is refused rather than treated as "keep nothing"', async () => {
  const h = harness()
  const res = await call(reportRoutes(h.deps, h.opts), 'POST', '/v1/desk/reports/prune', {
    dryRun: false,
    keepDays: 0,
  })
  assert.equal(res.status, 400)
})

// ------------------------------------------------------------- the runner

/**
 * A timer this test can actually SEE.
 *
 * The globals are swapped for recorders that still return real (immediately
 * unref'd) timers, so `startPnlJobs` behaves exactly as it does in production
 * while every scheduling call it makes is observable. Asserting
 * `typeof stop === 'function'` proved nothing — the return type guarantees it,
 * and both defects this test is named after would sail past: a `startPnlJobs`
 * that scheduled NOTHING outside market hours, and one whose timers were left
 * referenced (a ten-second stall on every `pm2 restart`, and a shutdown that
 * looks hung).
 */
interface RecordedTimer {
  readonly kind: 'interval' | 'timeout'
  readonly ms: number
  unrefs: number
  cleared: number
}

function recordTimers(): { created: RecordedTimer[]; restore: () => void } {
  const created: RecordedTimer[] = []
  const byHandle = new Map<unknown, RecordedTimer>()
  const real = {
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout,
  }
  const wrap = (kind: 'interval' | 'timeout') =>
    ((fn: () => void, ms?: number, ...rest: unknown[]): unknown => {
      const handle = (kind === 'interval' ? real.setInterval : real.setTimeout)(
        fn as never,
        ms as never,
        ...(rest as never[]),
      )
      const rec: RecordedTimer = { kind, ms: ms ?? 0, unrefs: 0, cleared: 0 }
      created.push(rec)
      byHandle.set(handle, rec)
      const t = handle as unknown as { unref: () => unknown }
      const realUnref = t.unref.bind(t)
      t.unref = (): unknown => {
        rec.unrefs++
        return realUnref()
      }
      // Never let a recorded timer hold the test process open, however the
      // subject under test behaves — the point is to OBSERVE the unref, not to
      // depend on it.
      realUnref()
      return handle
    }) as unknown
  const unwrapClear = (kind: 'interval' | 'timeout') =>
    ((handle: unknown): void => {
      const rec = byHandle.get(handle)
      if (rec !== undefined && rec.kind === kind) rec.cleared++
      ;(kind === 'interval' ? real.clearInterval : real.clearTimeout)(handle as never)
    }) as unknown

  globalThis.setInterval = wrap('interval') as typeof globalThis.setInterval
  globalThis.setTimeout = wrap('timeout') as typeof globalThis.setTimeout
  globalThis.clearInterval = unwrapClear('interval') as typeof globalThis.clearInterval
  globalThis.clearTimeout = unwrapClear('timeout') as typeof globalThis.clearTimeout
  return {
    created,
    restore: () => {
      globalThis.setInterval = real.setInterval
      globalThis.setTimeout = real.setTimeout
      globalThis.clearInterval = real.clearInterval
      globalThis.clearTimeout = real.clearTimeout
    },
  }
}

test('startPnlJobs SCHEDULES outside market hours, unrefs every timer, and stop() clears them', () => {
  const h = harness()
  const rec = recordTimers()
  try {
    // NOW is 02:00 IST — outside market hours. The job must still START: gating
    // boot on a time window is the 2026-07-06 defect, where a restart at
    // 09:15:30 came up asleep for the session. This is the assertion that would
    // fail if that gate came back, because a gated boot schedules nothing.
    const stop = startPnlJobs(h.deps, h.opts)
    assert.equal(rec.created.length, 3, 'the snapshot tick, the daily job, and the boot repair')
    assert.deepEqual(
      rec.created.map((t) => t.kind).sort(),
      ['interval', 'interval', 'timeout'],
    )
    // EVERY ONE UNREF'D. A referenced interval keeps the event loop alive, so
    // `pm2 restart` waits out its own timeout and kills the process instead —
    // a stall on every deploy and a shutdown that looks hung.
    for (const t of rec.created) {
      assert.ok(t.unrefs > 0, `a ${t.kind} of ${t.ms}ms was left referenced`)
    }

    stop()
    for (const t of rec.created) {
      assert.equal(t.cleared, 1, `a ${t.kind} of ${t.ms}ms survived stop()`)
    }
    // Idempotent: pm2 can deliver SIGTERM and SIGINT in the same shutdown, and
    // clearing twice must neither throw nor schedule anything new.
    stop()
    assert.equal(rec.created.length, 3, 'stopping must not schedule')
  } finally {
    rec.restore()
  }
})
