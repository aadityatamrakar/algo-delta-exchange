/**
 * WS2 — a durable SERIES name for dated books, and the strategy rollup.
 *
 * The tag stays the key (`NIFTY-delta-lean-aggressive-2026-10-01`); a book
 * lives one trading day and is erased two sessions later. What survives the
 * erase is one `desk-book-series` row per `{tag, mode}`, written when the book
 * is created and never deleted — the only thing that lets the Reports page
 * group three weeks of daily tags under one name without parsing any of them.
 *
 * OWN DATABASE NAME: `algomaker_dx_book_series_test`, distinct from every other
 * Mongo suite here, because each suite wipes its collections between tests.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { reportRoutes } from '../src/routes/reports.ts'
import { PnlStore, DAILY_REPORTS, aggregateReportDays } from '../src/pnlstore.ts'
import { AUDIT_COLLECTION } from '../src/audit.ts'
import type { DailyReport } from '../src/rollup.ts'
import {
  listSeriesRows,
  recordSeries,
  summariseSeries,
  type SeriesRow,
} from '../src/book-series.ts'
import { backfillSeriesFromAudit } from '../src/migrate.ts'

// ------------------------------------------------------------- pure logic

const row = (over: Partial<SeriesRow>): SeriesRow => ({
  tag: 'NIFTY-delta-lean-aggressive-2026-10-01',
  mode: 'paper',
  series: 'NIFTY-delta-lean-aggressive',
  symbol: 'NIFTY',
  variant: 'delta-lean-aggressive',
  expiry: '2026-10-06',
  createdAt: 1,
  ...over,
})

test('summariseSeries groups tags by series and lists the distinct variants', () => {
  const rows = [
    row({ tag: 'N-A-1', createdAt: 1 }),
    row({ tag: 'N-A-2', createdAt: 2, expiry: '2026-10-13' }),
    row({ tag: 'S-A-1', series: 'SENSEX-delta-lean-aggressive', symbol: 'SENSEX', expiry: '2026-10-01' }),
    row({ tag: 'S-C-1', series: 'SENSEX-delta-lean-conservative', symbol: 'SENSEX', variant: 'delta-lean-conservative' }),
  ]
  const spans = new Map([
    ['N-A-1', { first: '2026-09-22', last: '2026-09-22' }],
    ['N-A-2', { first: '2026-09-23', last: '2026-09-24' }],
  ])
  const out = summariseSeries(rows, spans)
  assert.deepEqual(out.variants, ['delta-lean-aggressive', 'delta-lean-conservative'])
  const nifty = out.series.find((s) => s.series === 'NIFTY-delta-lean-aggressive')
  assert.ok(nifty)
  assert.deepEqual(nifty.tags, ['N-A-1', 'N-A-2'])
  assert.equal(nifty.symbol, 'NIFTY')
  assert.equal(nifty.variant, 'delta-lean-aggressive')
  assert.deepEqual(nifty.expiries, { 'N-A-1': '2026-10-06', 'N-A-2': '2026-10-13' })
  assert.equal(nifty.firstDate, '2026-09-22')
  assert.equal(nifty.lastDate, '2026-09-24')
  // A series none of whose tags has reported yet is still listed — a book
  // registered this morning — with no dates rather than invented ones.
  const fresh = out.series.find((s) => s.series === 'SENSEX-delta-lean-conservative')
  assert.equal(fresh?.firstDate, null)
  assert.equal(fresh?.lastDate, null)
  assert.deepEqual(
    out.series.map((s) => s.series),
    ['NIFTY-delta-lean-aggressive', 'SENSEX-delta-lean-aggressive', 'SENSEX-delta-lean-conservative'],
  )
})

// -------------------------------------------------------------- over Mongo

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_book_series_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
/** Thu 2026-10-01 10:30 IST. Never `Date.now()`. */
let NOW = Date.UTC(2026, 9, 1, 5, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let pnl: PnlStore
let server: Server | null = null
let base = ''
let available = false
let sink: NudgeSink | null = null

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  pnl = new PnlStore(handle.db)
  await store.ensureIndexes()
  await pnl.ensureIndexes()
  const apiDeps = {
    db: handle.db,
    store,
    log: () => {},
    now: () => NOW,
    gate: bearerGate(TOKEN),
  } as unknown as Parameters<typeof booksRoutes>[0]
  server = createBridgeServer({
    gate: bearerGate(TOKEN),
    routes: [booksRoutes(apiDeps), reportRoutes(apiDeps)],
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
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
  await handle!.db.collection(DAILY_REPORTS).deleteMany({})
  await handle!.db.collection(AUDIT_COLLECTION).deleteMany({})
  await store.ensureIndexes()
  NOW = Date.UTC(2026, 9, 1, 5, 0)
  if (sink !== null) sink.nudges.length = 0
})

const CREATE = {
  tag: 'NIFTY-delta-lean-aggressive-2026-10-01',
  symbol: 'NIFTY',
  expiry: '2026-10-06',
  mode: 'paper',
  variant: 'delta-lean-aggressive',
  dials: {},
}

async function seriesDocs(): Promise<Record<string, unknown>[]> {
  const docs = await handle!.db.collection(COLLECTIONS.bookSeries).find({}).toArray()
  return docs.map(({ _id, ...rest }) => rest)
}

itMongo('creating a book records its series row, derived from symbol and variant', async () => {
  const res = await call('POST', '/v1/desk/books/registry', CREATE)
  assert.equal(res.status, 201, JSON.stringify(res.body))
  assert.equal(res.body['series'], 'NIFTY-delta-lean-aggressive')
  assert.deepEqual(await seriesDocs(), [
    {
      tag: CREATE.tag,
      mode: 'paper',
      series: 'NIFTY-delta-lean-aggressive',
      symbol: 'NIFTY',
      variant: 'delta-lean-aggressive',
      expiry: '2026-10-06',
      createdAt: NOW,
    },
  ])
  // The registry GET carries it too.
  const list = await call('GET', '/v1/desk/books/registry?mode=paper')
  const books = list.body['books'] as Record<string, unknown>[]
  assert.equal(books[0]?.['series'], 'NIFTY-delta-lean-aggressive')
})

itMongo('an upsert that states no series lands with the derived one', async () => {
  // Callers written before WS2 (and other branches' fixtures) build a row
  // without `series`; the stored row must still carry one.
  await store.upsertBook({
    tag: 'NO-SERIES-1',
    symbol: 'NIFTY',
    expiry: '2026-10-06',
    mode: 'paper',
    variant: 'delta-lean-aggressive',
    dials: {},
    desired: 'stopped',
    actual: 'stopped',
    dx_paper_rail: 'demo',
    dx_rail_used: null,
    dx_rail_note: '',
    lastMarkAt: 0,
    lastDecision: '',
    createdAt: 1,
    updatedAt: 1,
  })
  const raw = await store.getBookRaw('NO-SERIES-1', 'paper')
  assert.equal(raw?.['series'], 'NIFTY-delta-lean-aggressive', 'stored, not only derived on read')
  assert.equal((await store.getBook('NO-SERIES-1', 'paper'))?.series, 'NIFTY-delta-lean-aggressive')
})

itMongo('a stated series is recorded as stated', async () => {
  await call('POST', '/v1/desk/books/registry', { ...CREATE, series: 'NIFTY-dl-agg' })
  const docs = await seriesDocs()
  assert.equal(docs[0]?.['series'], 'NIFTY-dl-agg')
})

itMongo('the series row survives the erase, and the purge, that remove the book', async () => {
  // Plain erase.
  await call('POST', '/v1/desk/books/registry', CREATE)
  const erased = await call('DELETE', `/v1/desk/books/registry/${CREATE.tag}?mode=paper`)
  assert.equal(erased.status, 200, JSON.stringify(erased.body))
  assert.equal(await store.getBook(CREATE.tag, 'paper'), null, 'the registry row is gone')
  // Erase with purge, on a second book.
  const other = { ...CREATE, tag: 'NIFTY-delta-lean-aggressive-2026-10-02' }
  await call('POST', '/v1/desk/books/registry', other)
  const purged = await call('DELETE', `/v1/desk/books/registry/${other.tag}?mode=paper&purge=1`)
  assert.equal(purged.status, 200, JSON.stringify(purged.body))

  const rows = await listSeriesRows(handle!.db, 'paper')
  assert.deepEqual(rows.map((r) => r.tag).sort(), [CREATE.tag, other.tag].sort())
})

itMongo('recordSeries never overwrites — the first statement of a tag\'s series stands', async () => {
  const first = row({ tag: 'T1', series: 'FIRST' })
  assert.equal(await recordSeries(handle!.db, first), 'recorded')
  assert.equal(await recordSeries(handle!.db, { ...first, series: 'SECOND' }), 'exists')
  const rows = await listSeriesRows(handle!.db, 'paper')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.series, 'FIRST')
  // Keyed by {tag, mode}: the same tag on the other rail is its own row.
  assert.equal(await recordSeries(handle!.db, { ...first, mode: 'live' }), 'recorded')
  assert.equal((await listSeriesRows(handle!.db, 'live')).length, 1)
})

// ------------------------------------------------ per-day aggregation (pure)

const report = (over: Partial<DailyReport>): DailyReport => ({
  date: '2026-09-23',
  tag: 'N1',
  mode: 'paper',
  realised: 0,
  gross: 0,
  fees: 0,
  total: 0,
  maxProfit: 0,
  maxLoss: 0,
  orderCount: 0,
  closingPositions: 0,
  snapshots: 10,
  closingSource: 'marks',
  writtenAt: 1,
  ...over,
})

test('days are summed across the tags that reported them, oldest first, each naming its tags', () => {
  const days = aggregateReportDays(
    [
      report({ date: '2026-09-24', tag: 'S1', realised: -100, total: -150, maxProfit: 20, maxLoss: -300, orderCount: 4 }),
      report({ date: '2026-09-23', tag: 'N1', realised: 500, total: 500, maxProfit: 900, maxLoss: -50, orderCount: 6 }),
      report({ date: '2026-09-23', tag: 'S1', realised: 200, total: 250, maxProfit: 300, maxLoss: -10, orderCount: 2, closingPositions: 1 }),
    ],
    { N1: '2026-09-30', S1: '2026-09-24' },
  )
  assert.deepEqual(days.map((d) => d.date), ['2026-09-23', '2026-09-24'])
  const first = days[0]!
  assert.equal(first.realised, 700)
  assert.equal(first.total, 750)
  assert.equal(first.maxProfit, 1200)
  assert.equal(first.maxLoss, -60)
  assert.equal(first.orderCount, 8)
  assert.equal(first.closingPositions, 1)
  assert.deepEqual(first.tags, ['N1', 'S1'])
  assert.equal(first.expiryDay, false)
  assert.deepEqual(first.expiryTags, [])
})

test('a day is an expiry day when a contributing book expires on it', () => {
  const days = aggregateReportDays(
    [report({ date: '2026-09-24', tag: 'S1' }), report({ date: '2026-09-24', tag: 'N1' })],
    { N1: '2026-09-30', S1: '2026-09-24' },
  )
  assert.equal(days[0]?.expiryDay, true)
  assert.deepEqual(days[0]?.expiryTags, ['S1'])
})

test('ONE unmarked tag makes the aggregated day total null — never a partial sum (review focus 3)', () => {
  const days = aggregateReportDays(
    [
      report({ tag: 'N1', realised: 500, total: 500 }),
      report({ tag: 'S1', realised: -40_024, total: null, maxProfit: null, maxLoss: null, closingSource: 'none' }),
    ],
    {},
  )
  const d = days[0]!
  assert.equal(d.total, null, 'a partial sum would read as a real figure')
  assert.equal(d.maxProfit, null)
  assert.equal(d.maxLoss, null)
  // Realised is a sum of fills and is always known.
  assert.equal(d.realised, 500 - 40_024)
  assert.equal(d.closingSource, 'none', 'the worst closing source of the day speaks for it')
  // Order does not matter: the null arriving first must not be overwritten.
  const reversed = aggregateReportDays(
    [report({ tag: 'S1', total: null }), report({ tag: 'N1', total: 500 })],
    {},
  )
  assert.equal(reversed[0]?.total, null)
})

test('a snapshot-marked tag makes the day snapshot-marked, unless another is unmarked', () => {
  const days = aggregateReportDays(
    [report({ tag: 'N1', closingSource: 'snapshot' }), report({ tag: 'S1', closingSource: 'marks' })],
    {},
  )
  assert.equal(days[0]?.closingSource, 'snapshot')
})

// ------------------------------------------------ per-symbol split (variant view)

test('bySymbol splits a variant day per symbol: two symbols, and a day one of them did not report', () => {
  const days = aggregateReportDays(
    [
      report({ date: '2026-09-23', tag: 'N1', realised: 1000, total: 1000 }),
      report({ date: '2026-09-23', tag: 'S1', realised: 300, total: 250 }),
      report({ date: '2026-09-25', tag: 'N2', realised: -70, total: -90 }),
    ],
    {},
    { N1: 'NIFTY', N2: 'NIFTY', S1: 'SENSEX' },
  )
  assert.deepEqual(days[0]?.bySymbol, {
    NIFTY: { realised: 1000, total: 1000, tags: ['N1'] },
    SENSEX: { realised: 300, total: 250, tags: ['S1'] },
  })
  // The combined figures are what they always were.
  assert.equal(days[0]?.realised, 1300)
  assert.equal(days[0]?.total, 1250)
  // SENSEX did not report on the 25th: it is ABSENT, not a zero.
  assert.deepEqual(days[1]?.bySymbol, { NIFTY: { realised: -70, total: -90, tags: ['N2'] } })
})

test('bySymbol keeps the null discipline per symbol: one unmarked SENSEX tag nulls SENSEX, not NIFTY', () => {
  const days = aggregateReportDays(
    [
      report({ tag: 'S1', realised: -2000, total: null, closingSource: 'none' }),
      report({ tag: 'N1', realised: 500, total: 500 }),
      report({ tag: 'S2', realised: 100, total: 100 }),
    ],
    {},
    { N1: 'NIFTY', S1: 'SENSEX', S2: 'SENSEX' },
  )
  const d = days[0]!
  assert.equal(d.total, null, 'the day total is unchanged by the split')
  assert.deepEqual(d.bySymbol?.['NIFTY'], { realised: 500, total: 500, tags: ['N1'] })
  assert.deepEqual(d.bySymbol?.['SENSEX'], { realised: -1900, total: null, tags: ['S1', 'S2'] })
})

test('a tag with no series row is grouped under its own tag name — never parsed', () => {
  const days = aggregateReportDays(
    [report({ tag: 'N1', realised: 5, total: 5 }), report({ tag: 'NIFTY-orphan-2026-09-23', realised: 7, total: 7 })],
    {},
    { N1: 'NIFTY' },
  )
  assert.deepEqual(Object.keys(days[0]!.bySymbol!).sort(), ['NIFTY', 'NIFTY-orphan-2026-09-23'])
  assert.equal(days[0]!.bySymbol!['NIFTY']!.realised, 5)
})

test('no symbol map, no split — the series and tag views keep their shape', () => {
  const days = aggregateReportDays([report({ tag: 'N1' })], {})
  assert.equal('bySymbol' in days[0]!, false)
})

// ----------------------------------------------------- reports over Mongo

async function seedReports(rows: readonly Partial<DailyReport>[]): Promise<void> {
  for (const r of rows) await pnl.writeReport(report(r))
}

/** NIFTY and SENSEX aggressive, two days each, plus a conservative and a live row. */
async function seedTwoSeries(): Promise<void> {
  const rows: SeriesRow[] = [
    row({ tag: 'NIFTY-delta-lean-aggressive-2026-09-23', expiry: '2026-09-30', createdAt: 1 }),
    row({ tag: 'NIFTY-delta-lean-aggressive-2026-09-24', expiry: '2026-09-30', createdAt: 2 }),
    // A LEGACY tag shape: grouped by its row, never by its text.
    row({
      tag: 'SENSEX-2026-09-17-delta-lean-aggressive',
      series: 'SENSEX-delta-lean-aggressive',
      symbol: 'SENSEX',
      expiry: '2026-09-23',
      createdAt: 0,
    }),
    row({
      tag: 'SENSEX-delta-lean-aggressive-2026-09-24',
      series: 'SENSEX-delta-lean-aggressive',
      symbol: 'SENSEX',
      expiry: '2026-09-24',
      createdAt: 3,
    }),
    row({
      tag: 'NIFTY-delta-lean-conservative-2026-09-23',
      series: 'NIFTY-delta-lean-conservative',
      variant: 'delta-lean-conservative',
      createdAt: 4,
    }),
    row({ tag: 'LIVE-ONLY', series: 'NIFTY-live-thing', variant: 'live-thing', mode: 'live', createdAt: 5 }),
  ]
  for (const r of rows) await recordSeries(handle!.db, r)
  await seedReports([
    { date: '2026-09-23', tag: 'NIFTY-delta-lean-aggressive-2026-09-23', realised: 1000, total: 1000, orderCount: 3 },
    { date: '2026-09-24', tag: 'NIFTY-delta-lean-aggressive-2026-09-24', realised: -400, total: -400, orderCount: 5 },
    { date: '2026-09-23', tag: 'SENSEX-2026-09-17-delta-lean-aggressive', realised: 300, total: 250, orderCount: 2 },
    { date: '2026-09-24', tag: 'SENSEX-delta-lean-aggressive-2026-09-24', realised: -2000, total: null, closingSource: 'none', orderCount: 9 },
    { date: '2026-09-23', tag: 'NIFTY-delta-lean-conservative-2026-09-23', realised: 50, total: 50 },
    { date: '2026-09-23', tag: 'LIVE-ONLY', mode: 'live', realised: 7, total: 7 },
    // An unlabelled tag: has reports, has no series row.
    { date: '2026-09-23', tag: 'ORB_FUT_NIFTY', realised: 11, total: 11 },
  ])
}

itMongo('GET /reports/series lists this rail\'s series with their tags, expiries and dates, and the variants', async () => {
  await seedTwoSeries()
  const res = await call('GET', '/v1/desk/reports/series?mode=paper')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body['variants'], ['delta-lean-aggressive', 'delta-lean-conservative'])
  const series = res.body['series'] as Record<string, unknown>[]
  assert.deepEqual(
    series.map((s) => s['series']),
    ['NIFTY-delta-lean-aggressive', 'NIFTY-delta-lean-conservative', 'SENSEX-delta-lean-aggressive'],
    'the live-only series is not on the paper list',
  )
  const sensex = series.find((s) => s['series'] === 'SENSEX-delta-lean-aggressive')!
  assert.deepEqual(sensex['tags'], ['SENSEX-2026-09-17-delta-lean-aggressive', 'SENSEX-delta-lean-aggressive-2026-09-24'])
  assert.deepEqual(sensex['expiries'], {
    'SENSEX-2026-09-17-delta-lean-aggressive': '2026-09-23',
    'SENSEX-delta-lean-aggressive-2026-09-24': '2026-09-24',
  })
  assert.equal(sensex['firstDate'], '2026-09-23')
  assert.equal(sensex['lastDate'], '2026-09-24')
  assert.equal(sensex['symbol'], 'SENSEX')
  assert.equal(sensex['variant'], 'delta-lean-aggressive')
})

itMongo('GET /reports/series states its mode or is refused', async () => {
  assert.equal((await call('GET', '/v1/desk/reports/series')).status, 400)
  assert.equal((await call('GET', '/v1/desk/reports/series?mode=both')).status, 400)
})

itMongo('history by series sums its tags per day and marks expiry days', async () => {
  await seedTwoSeries()
  const res = await call(
    'GET',
    '/v1/desk/reports/history?series=SENSEX-delta-lean-aggressive&mode=paper&from=2026-09-01&to=2026-09-30',
  )
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body['series'], 'SENSEX-delta-lean-aggressive')
  assert.equal(res.body['mode'], 'paper')
  const rows = res.body['rows'] as Record<string, unknown>[]
  assert.deepEqual(rows.map((r) => r['date']), ['2026-09-23', '2026-09-24'])
  assert.deepEqual(rows[0]?.['tags'], ['SENSEX-2026-09-17-delta-lean-aggressive'])
  assert.equal(rows[0]?.['expiryDay'], true, 'the legacy book expired on the 23rd')
  assert.equal(rows[1]?.['expiryDay'], true)
  assert.equal(rows[1]?.['total'], null)
  const totals = res.body['totals'] as Record<string, unknown>
  assert.equal(totals['realised'], 300 - 2000)
  assert.equal(totals['total'], null, 'one unmarked day makes the range total unknown')
  assert.equal(totals['days'], 2)
})

itMongo('history by variant sums NIFTY and SENSEX per day, naming every contributing tag', async () => {
  await seedTwoSeries()
  const res = await call(
    'GET',
    '/v1/desk/reports/history?variant=delta-lean-aggressive&mode=paper&from=2026-09-01&to=2026-09-30',
  )
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body['variant'], 'delta-lean-aggressive')
  const rows = res.body['rows'] as Record<string, unknown>[]
  const d23 = rows.find((r) => r['date'] === '2026-09-23')!
  assert.equal(d23['realised'], 1000 + 300)
  assert.equal(d23['total'], 1000 + 250)
  assert.equal(d23['orderCount'], 5)
  assert.deepEqual(d23['tags'], ['NIFTY-delta-lean-aggressive-2026-09-23', 'SENSEX-2026-09-17-delta-lean-aggressive'])
  assert.deepEqual(d23['expiryTags'], ['SENSEX-2026-09-17-delta-lean-aggressive'])
  const d24 = rows.find((r) => r['date'] === '2026-09-24')!
  assert.equal(d24['realised'], -400 - 2000)
  assert.equal(d24['total'], null, 'review focus 3, end to end')
  // The conservative and the unlabelled rows never leak in.
  assert.equal(rows.length, 2)
})

itMongo('history by variant splits each day per symbol and lists the symbols', async () => {
  await seedTwoSeries()
  // A NIFTY-only day: SENSEX has no book on the 25th.
  await recordSeries(handle!.db, row({ tag: 'NIFTY-delta-lean-aggressive-2026-09-25', createdAt: 6 }))
  await seedReports([
    { date: '2026-09-25', tag: 'NIFTY-delta-lean-aggressive-2026-09-25', realised: 120, total: 110, orderCount: 2 },
  ])
  const res = await call(
    'GET',
    '/v1/desk/reports/history?variant=delta-lean-aggressive&mode=paper&from=2026-09-01&to=2026-09-30',
  )
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body['symbols'], ['NIFTY', 'SENSEX'])
  const rows = res.body['rows'] as Record<string, unknown>[]
  const by = (date: string): unknown => rows.find((r) => r['date'] === date)!['bySymbol']
  assert.deepEqual(by('2026-09-23'), {
    NIFTY: { realised: 1000, total: 1000, tags: ['NIFTY-delta-lean-aggressive-2026-09-23'] },
    // The legacy tag is filed by its row's symbol, never by its text.
    SENSEX: { realised: 300, total: 250, tags: ['SENSEX-2026-09-17-delta-lean-aggressive'] },
  })
  assert.deepEqual(by('2026-09-24'), {
    NIFTY: { realised: -400, total: -400, tags: ['NIFTY-delta-lean-aggressive-2026-09-24'] },
    SENSEX: { realised: -2000, total: null, tags: ['SENSEX-delta-lean-aggressive-2026-09-24'] },
  })
  assert.equal(rows.find((r) => r['date'] === '2026-09-24')!['total'], null, 'the day total is unchanged')
  assert.deepEqual(by('2026-09-25'), {
    NIFTY: { realised: 120, total: 110, tags: ['NIFTY-delta-lean-aggressive-2026-09-25'] },
  })
})

itMongo('history by series carries no per-symbol split', async () => {
  await seedTwoSeries()
  const res = await call(
    'GET',
    '/v1/desk/reports/history?series=NIFTY-delta-lean-aggressive&mode=paper&from=2026-09-01&to=2026-09-30',
  )
  assert.equal(res.status, 200)
  assert.equal('symbols' in res.body, false)
  for (const r of res.body['rows'] as Record<string, unknown>[]) assert.equal('bySymbol' in r, false)
})

itMongo('a LIVE book of the same variant never reaches the paper variant view', async () => {
  await seedTwoSeries()
  await recordSeries(
    handle!.db,
    row({ tag: 'NIFTY-delta-lean-aggressive-LIVE', mode: 'live', createdAt: 9 }),
  )
  await seedReports([
    { date: '2026-09-23', tag: 'NIFTY-delta-lean-aggressive-LIVE', mode: 'live', realised: 99_999, total: 99_999, orderCount: 7 },
  ])
  const res = await call(
    'GET',
    '/v1/desk/reports/history?variant=delta-lean-aggressive&mode=paper&from=2026-09-01&to=2026-09-30',
  )
  assert.equal(res.status, 200)
  assert.equal((res.body['tags'] as string[]).includes('NIFTY-delta-lean-aggressive-LIVE'), false)
  const d23 = (res.body['rows'] as Record<string, unknown>[]).find((r) => r['date'] === '2026-09-23')!
  assert.equal(d23['realised'], 1000 + 300, 'paper money only')
  assert.equal(d23['total'], 1000 + 250)
  assert.equal(d23['orderCount'], 5)
  assert.deepEqual(d23['tags'], ['NIFTY-delta-lean-aggressive-2026-09-23', 'SENSEX-2026-09-17-delta-lean-aggressive'])
  // And the live rail's own view has it, alone.
  const live = await call(
    'GET',
    '/v1/desk/reports/history?variant=delta-lean-aggressive&mode=live&from=2026-09-01&to=2026-09-30',
  )
  const liveRows = live.body['rows'] as Record<string, unknown>[]
  assert.deepEqual(liveRows.map((r) => [r['date'], r['realised']]), [['2026-09-23', 99_999]])
})

itMongo('history takes EXACTLY one of tag, series, variant', async () => {
  const two = await call('GET', '/v1/desk/reports/history?tag=A&series=B&mode=paper')
  assert.equal(two.status, 400)
  assert.match(String(two.body['error']), /exactly one/)
  assert.equal((await call('GET', '/v1/desk/reports/history?series=A&variant=B&mode=paper')).status, 400)
  assert.equal((await call('GET', '/v1/desk/reports/history?mode=paper')).status, 400)
  // Blank counts as absent, not as a second selector.
  assert.equal((await call('GET', '/v1/desk/reports/history?tag=A&series=&mode=paper')).status, 200)
})

itMongo('history by series or variant states its mode — paper is never assumed', async () => {
  assert.equal((await call('GET', '/v1/desk/reports/history?series=NIFTY-delta-lean-aggressive')).status, 400)
  assert.equal((await call('GET', '/v1/desk/reports/history?variant=delta-lean-aggressive&mode=x')).status, 400)
})

itMongo('history by tag keeps its existing shape', async () => {
  await seedTwoSeries()
  const res = await call(
    'GET',
    '/v1/desk/reports/history?tag=NIFTY-delta-lean-aggressive-2026-09-23&mode=paper&from=2026-09-01&to=2026-09-30',
  )
  assert.equal(res.status, 200)
  assert.equal(res.body['tag'], 'NIFTY-delta-lean-aggressive-2026-09-23')
  const rows = res.body['rows'] as Record<string, unknown>[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.['tag'], 'NIFTY-delta-lean-aggressive-2026-09-23')
})

itMongo('a series with no row in the range answers with no rows, not an error', async () => {
  await seedTwoSeries()
  const res = await call('GET', '/v1/desk/reports/history?series=NOPE&mode=paper&from=2026-09-01&to=2026-09-30')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body['rows'], [])
  assert.deepEqual(res.body['tags'], [])
})

itMongo('/reports/tags honours mode when it is given', async () => {
  await seedTwoSeries()
  const live = await call('GET', '/v1/desk/reports/tags?mode=live')
  assert.deepEqual(live.body['tags'], ['LIVE-ONLY'])
  const paper = (await call('GET', '/v1/desk/reports/tags?mode=paper')).body['tags'] as string[]
  assert.equal(paper.includes('LIVE-ONLY'), false)
  assert.equal(paper.includes('ORB_FUT_NIFTY'), true)
  // No mode: every tag on either rail, as before.
  const all = (await call('GET', '/v1/desk/reports/tags')).body['tags'] as string[]
  assert.equal(all.includes('LIVE-ONLY') && all.includes('ORB_FUT_NIFTY'), true)
  assert.equal((await call('GET', '/v1/desk/reports/tags?mode=nonsense')).status, 400)
})

// ------------------------------------------------- the backfill (migrate.ts)

/** An audit line exactly as `POST /v1/desk/books/registry` writes it. */
function registered(tag: string, at: number, detail: Record<string, unknown>, mode = 'paper'): Record<string, unknown> {
  return {
    at,
    principal: 'bearer',
    principalKind: 'machine',
    source: '/v1/desk/books/registry',
    action: 'registered a book (stopped)',
    tag,
    mode,
    detail,
  }
}

async function seedBackfillWorld(): Promise<void> {
  const audit = handle!.db.collection(AUDIT_COLLECTION)
  // Both tag shapes the box holds — the legacy weekly and the current daily.
  await audit.insertOne(
    registered('SENSEX-2026-09-17-delta-lean-conservative', 1_000, {
      symbol: 'SENSEX', expiry: '2026-09-17', variant: 'delta-lean-conservative', dials: {},
    }),
  )
  await audit.insertOne(
    registered('NIFTY-delta-lean-aggressive-2026-10-01', 2_000, {
      symbol: 'NIFTY', expiry: '2026-10-06', variant: 'delta-lean-aggressive', dials: {},
    }),
  )
  // Some other audit action on the same tag must not be read as a registration.
  await audit.insertOne({ ...registered('NIFTY-delta-lean-aggressive-2026-10-01', 3_000, {}), action: 'started a book' })
  await seedReports([
    { date: '2026-09-16', tag: 'SENSEX-2026-09-17-delta-lean-conservative' },
    { date: '2026-10-01', tag: 'NIFTY-delta-lean-aggressive-2026-10-01' },
    // Registry only: no audit line survives for it.
    { date: '2026-08-04', tag: 'TCS-2026-08-25-recenter-relief-r', mode: 'live' },
    // Neither: a hosted strategy. Stays unlabelled.
    { date: '2026-09-23', tag: 'ORB_FUT_NIFTY' },
  ])
  await store.upsertBook({
    tag: 'TCS-2026-08-25-recenter-relief-r',
    symbol: 'TCS',
    expiry: '2026-08-25',
    mode: 'live',
    variant: 'recenter-relief-r',
    series: 'TCS-recenter-relief-r',
    dials: {},
    desired: 'stopped',
    actual: 'stopped',
    dx_paper_rail: 'demo',
    dx_rail_used: null,
    dx_rail_note: '',
    lastMarkAt: 0,
    lastDecision: '',
    createdAt: 500,
    updatedAt: 500,
  })
}

itMongo('the backfill labels every reported tag it can, from the audit log first, then the registry', async () => {
  await seedBackfillWorld()
  const result = await backfillSeriesFromAudit(handle!.db)
  assert.deepEqual(
    result.recorded.map((r) => [r.tag, r.mode, r.series, r.source]).sort(),
    [
      ['NIFTY-delta-lean-aggressive-2026-10-01', 'paper', 'NIFTY-delta-lean-aggressive', 'audit'],
      ['SENSEX-2026-09-17-delta-lean-conservative', 'paper', 'SENSEX-delta-lean-conservative', 'audit'],
      ['TCS-2026-08-25-recenter-relief-r', 'live', 'TCS-recenter-relief-r', 'registry'],
    ].sort(),
  )
  assert.deepEqual(result.unresolved, [{ tag: 'ORB_FUT_NIFTY', mode: 'paper' }])
  const legacy = (await listSeriesRows(handle!.db, 'paper')).find(
    (r) => r.tag === 'SENSEX-2026-09-17-delta-lean-conservative',
  )
  assert.deepEqual(legacy, {
    tag: 'SENSEX-2026-09-17-delta-lean-conservative',
    mode: 'paper',
    series: 'SENSEX-delta-lean-conservative',
    symbol: 'SENSEX',
    variant: 'delta-lean-conservative',
    expiry: '2026-09-17',
    createdAt: 1_000,
  })
})

itMongo('the backfill is idempotent — a second run records nothing and rewrites nothing', async () => {
  await seedBackfillWorld()
  await backfillSeriesFromAudit(handle!.db)
  const before = await seriesDocs()
  const again = await backfillSeriesFromAudit(handle!.db)
  assert.deepEqual(again.recorded, [])
  assert.equal(again.already, 3)
  assert.deepEqual(await seriesDocs(), before)
})

itMongo('the backfill never overwrites a series row a create already wrote', async () => {
  await seedBackfillWorld()
  await recordSeries(handle!.db, row({ tag: 'NIFTY-delta-lean-aggressive-2026-10-01', series: 'NIFTY-dl-agg' }))
  await backfillSeriesFromAudit(handle!.db)
  const nifty = (await listSeriesRows(handle!.db, 'paper')).find((r) => r.tag === 'NIFTY-delta-lean-aggressive-2026-10-01')
  assert.equal(nifty?.series, 'NIFTY-dl-agg')
})

itMongo('a dry run reports what it would record and writes nothing', async () => {
  await seedBackfillWorld()
  const result = await backfillSeriesFromAudit(handle!.db, { dryRun: true })
  assert.equal(result.recorded.length, 3)
  assert.deepEqual(await seriesDocs(), [])
})

itMongo('the latest registration of a tag is the one the backfill takes', async () => {
  const audit = handle!.db.collection(AUDIT_COLLECTION)
  await audit.insertOne(registered('X-1', 10, { symbol: 'NIFTY', expiry: '2026-09-30', variant: 'old-variant' }))
  await audit.insertOne(registered('X-1', 20, { symbol: 'NIFTY', expiry: '2026-10-06', variant: 'delta-lean-aggressive' }))
  await seedReports([{ date: '2026-10-01', tag: 'X-1' }])
  await backfillSeriesFromAudit(handle!.db)
  const got = (await listSeriesRows(handle!.db, 'paper'))[0]
  assert.equal(got?.series, 'NIFTY-delta-lean-aggressive')
  assert.equal(got?.expiry, '2026-10-06')
})

itMongo('a series stated at registration is the one the audit log gives back', async () => {
  await handle!.db.collection(AUDIT_COLLECTION).insertOne(
    registered('X-1', 10, { symbol: 'NIFTY', expiry: '2026-10-06', variant: 'delta-lean-aggressive', series: 'NIFTY-dl-agg' }),
  )
  await seedReports([{ date: '2026-10-01', tag: 'X-1' }])
  await backfillSeriesFromAudit(handle!.db)
  assert.equal((await listSeriesRows(handle!.db, 'paper'))[0]?.series, 'NIFTY-dl-agg')
})

itMongo('a create writes the series into its audit line, so the log alone can rebuild it', async () => {
  await call('POST', '/v1/desk/books/registry', { ...CREATE, series: 'NIFTY-dl-agg' })
  const line = await handle!.db.collection(AUDIT_COLLECTION).findOne({ action: 'registered a book (stopped)' })
  assert.equal((line?.['detail'] as Record<string, unknown>)['series'], 'NIFTY-dl-agg')
})
