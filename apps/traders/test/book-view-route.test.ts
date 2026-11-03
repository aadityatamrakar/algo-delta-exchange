import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { buildBookView, type BookViewDeps } from '../src/analytics/book-view.ts'
import { ChargeSettingsStore } from '../src/analytics/charges.ts'
import { PayoffCache } from '../src/analytics/payoff-cache.ts'
import { seriesReader } from '../src/analytics/series-pnl.ts'
import { LegStore } from '../src/books/legs.ts'
import { sha256hex } from '../src/hash.ts'
import { FileStore } from '../src/ingest/files.ts'
import { LedgerStore } from '../src/ingest/ledger-store.ts'
import type { ParsedPosition } from '../src/ingest/parsers.ts'
import { matchLeg } from '../src/market/master.ts'
import type { TraderQuote, TradersQuotes } from '../src/market/quotes.ts'
import { authRoutes } from '../src/routes/auth.ts'
import { bookViewRoutes } from '../src/routes/book-view.ts'
import { booksRoutes } from '../src/routes/books.ts'
import type { TraderTrade } from '../src/types.ts'
import { WatcherStatusStore } from '../src/watcher-status.ts'
import { MM_SPOT, OCT, TCS_OCT_FUT, TCS_SPOT, octCE, octPE, testMaster } from './fixtures/master.ts'
import { startHarness, type Harness } from './harness.ts'

const MASTER = testMaster()
const prices = new Map<number, number>()
let now: () => number = () => 0
const quotes: TradersQuotes = {
  quote(token: number): TraderQuote | null {
    const price = prices.get(token)
    return price === undefined ? null : { price, bid: null, ask: null, oi: null, volume: null, asOf: now(), ageMs: 0 }
  },
  feedAlive: () => true,
}

let deps: BookViewDeps
const h: Harness | null = await startHarness('book_view', (d) => {
  now = d.now
  const legs = new LegStore(d.db, d.now)
  const files = new FileStore(d.db, d.now)
  deps = { legs, ledger: new LedgerStore(d.db), files, status: new WatcherStatusStore(d.db), master: () => MASTER, quotes, payoffCache: new PayoffCache(d.now) }
  return [
    authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }),
    booksRoutes({ users: d.users, legs, files, master: () => MASTER, now: d.now, log: d.log }),
    // the cache is replaced per test, so it is read through `deps` on every request
    bookViewRoutes({ users: d.users, bookView: (trader, stock, nowMs) => buildBookView(deps, trader, stock, nowMs), now: d.now }),
  ]
})
after(async () => { await h?.close() })

const B = '/v1/traders/books'
let ravi = ''
let sita = ''
let boss = ''
const get = (path: string, cookie = ravi) => h!.call('GET', path, { cookie })
const post = (path: string, json: unknown, cookie = ravi) => h!.call('POST', path, { cookie, json })

const pos = (p: Omit<ParsedPosition, 'clientCode'>): ParsedPosition => ({ clientCode: 'C0001', ...p })
const TCS_BOOK: readonly ParsedPosition[] = [
  pos({ stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, avgPrice: 40 }),
  pos({ stock: 'TCS', instrument: 'future', expiry: OCT, strike: null, optType: null, qty: 175, avgPrice: 3480 }),
]

beforeEach(async () => {
  if (h === null) return
  await h.reset()
  h.clock.now = Date.parse('2026-10-19T10:30:00+05:30')
  deps = { ...deps, payoffCache: new PayoffCache(() => h.clock.now) }
  prices.clear()
  for (const [t, p] of [[TCS_SPOT, 3490], [TCS_OCT_FUT, 3500], [octCE(3500), 45], [octPE(3500), 45], [MM_SPOT, 3150]] as const) prices.set(t, p)
  await h.addUser('boss', 'admin'); await h.addUser('ravi'); await h.addUser('sita')
  ravi = await h.login('ravi'); sita = await h.login('sita'); boss = await h.login('boss')
  await deps.legs.replaceOdin('ravi', TCS_BOOK, (c) => matchLeg(MASTER, c))
})

test('GET /books/TCS answers a BookView; another trader\'s stock is 404', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await deps.legs.addManual('sita', { stock: 'INFY', instrument: 'share', expiry: '', strike: null, optType: null, qty: 10, avgPrice: 1500, note: '' }, null)
  const r = await get(`${B}/TCS`)
  assert.equal(r.status, 200)
  assert.equal(r.body.stock, 'TCS'); assert.equal(r.body.asOf, h.clock.now); assert.equal(r.body.closed, false); assert.equal(r.body.spot, 3490)
  assert.deepEqual(r.body.legs.map((l: { instrument: string; ltp: number; matched: boolean }) => [l.instrument, l.ltp, l.matched]), [['future', 3500, true], ['option', 45, true]])
  assert.deepEqual(r.body.futures, { [OCT]: 3500 }); assert.deepEqual(r.body.forwards, { [OCT]: 3500 })
  assert.equal(r.body.totals.mtm, (45 - 40) * -350 + (3500 - 3480) * 175)
  assert.ok(r.body.payoff.curve.length > 0); assert.equal(r.body.mismatch, null); assert.equal(r.body.historyFrom, null); assert.deepEqual(r.body.unmatched, [])
  assert.deepEqual(r.body.warnings, ['no watcher has reported for this trader yet — positions come only from manual uploads'])
  assert.equal((await get(`${B}/tcs`)).body.stock, 'TCS')

  assert.deepEqual([(await get(`${B}/INFY`)).status, (await get(`${B}/INFY`)).body], [404, { error: 'no open book INFY' }])
  assert.deepEqual((await get(`${B}/TCS`, sita)).body, { error: 'no open book TCS' })
  assert.equal((await get(`${B}/INFY`, sita)).status, 200)
  assert.equal((await get(`${B}/TCS?as=sita`, sita)).status, 404)   // a trader's ?as= is ignored
  assert.equal((await get(`${B}/TCS?as=ravi`, boss)).body.stock, 'TCS')
  assert.deepEqual((await get(`${B}/TCS`, boss)).body, { error: 'pick a trader: ?as=<username>' })
  assert.equal((await get(`${B}/TCS.NS`)).status, 400)
  assert.equal((await h.call('GET', `${B}/TCS`)).status, 401)
})

test('the book reads the watcher, the files and the trade history', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await deps.status.record('ravi', { version: '1', folder: 'C:\\ODIN', lastUploadAt: null, fileCount: 1 }, h.clock.now - 5_000)
  await deps.ledger.noteHistory('ravi', '2026-10-15')
  await deps.files.put('ravi', { path: 'Nse Derivatives/Trades/1019TRD.TXT', body: Buffer.from('x'), sha256: sha256hex('x'), mtime: 1, offset: null })
  await deps.files.setParse('ravi', 'Nse Derivatives/Trades/1019TRD.TXT', 'odin-nse-fo-trades', 'line 1: too few fields')
  const r = await get(`${B}/TCS`)
  assert.equal(r.body.historyFrom, '2026-10-15')
  assert.deepEqual(r.body.warnings, ['Nse Derivatives/Trades/1019TRD.TXT did not parse at 10:30: line 1: too few fields — showing the last good one'])
  h.clock.now += 200_000
  assert.ok((await get(`${B}/TCS`)).body.warnings.includes('the watcher has not reported since 10:29 — positions may be out of date'))
})

test('only problem files are read: the newest five are named, and the rest counted', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const start = h.clock.now
  const put = async (path: string) => {
    h!.clock.now += 60_000
    await deps.files.put('ravi', { path, body: Buffer.from(path), sha256: sha256hex(path), mtime: 1, offset: null })
  }
  for (let k = 0; k < 7; k++) {
    await put(`clean${k}.TXT`)
    await deps.files.setParse('ravi', `clean${k}.TXT`, 'odin-nse-fo-trades', null, [])
    await put(`bad${k}.TXT`)
    if (k % 2 === 0) await deps.files.setParse('ravi', `bad${k}.TXT`, 'odin-nse-fo-trades', `line ${k}: bad`)
    else await deps.files.setParse('ravi', `bad${k}.TXT`, 'odin-nse-fo-trades', null, [{ lineNo: k, reason: 'odd' }])
  }
  await put('latest.TXT')     // ravi's newest file is clean; sita's problems are not ravi's
  await deps.files.put('sita', { path: 'x.TXT', body: Buffer.from('x'), sha256: sha256hex('x'), mtime: 1, offset: null })
  await deps.files.setParse('sita', 'x.TXT', 'odin-nse-fo-trades', 'line 1: nope')
  await deps.status.record('ravi', { version: '1', folder: 'C:\\ODIN', lastUploadAt: null, fileCount: 15 }, h.clock.now)
  const at = (k: number) => new Date(start + 60_000 * (2 * k + 2) + 5.5 * 3_600_000).toISOString().slice(11, 16)
  assert.deepEqual((await get(`${B}/TCS`)).body.warnings, [
    `bad6.TXT did not parse at ${at(6)}: line 6: bad — showing the last good one`,
    '1 line of bad5.TXT was skipped: line 5: odd',
    `bad4.TXT did not parse at ${at(4)}: line 4: bad — showing the last good one`,
    '1 line of bad3.TXT was skipped: line 3: odd',
    `bad2.TXT did not parse at ${at(2)}: line 2: bad — showing the last good one`,
    'and 2 more files with problems — /v1/traders/files lists every file',
  ])
  const p = await deps.files.problems('ravi', 6)
  assert.deepEqual([p.files.map((f) => f.path), p.total], [['bad6.TXT', 'bad5.TXT', 'bad4.TXT', 'bad3.TXT', 'bad2.TXT', 'bad1.TXT'], 7])
  assert.equal(p.files.some((f) => 'content' in f || '_id' in f), false)
  assert.deepEqual(await deps.files.problems('sita', 6), { files: [await deps.files.list('sita').then((l) => l[0])], total: 1 })
})

test('GET /books/M%26M works', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await post(`${B}/M%26M/legs`, { instrument: 'share', qty: 50, avgPrice: 3100 })).status, 201)
  const r = await get(`${B}/M%26M`)
  assert.equal(r.status, 200); assert.equal(r.body.stock, 'M&M')
  assert.deepEqual(r.body.legs.map((l: { instrument: string; qty: number; ltp: number; mtm: number; delta: number }) => [l.instrument, l.qty, l.ltp, l.mtm, l.delta]),
    [['share', 50, 3150, 2500, 50]])
  assert.equal(r.body.spot, 3150)
})

test('the payoff is rebuilt at most once a minute, and at once on a leg write', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const a = (await get(`${B}/TCS`)).body.payoff
  prices.set(TCS_OCT_FUT, 3600); h.clock.now += 10_000
  const cached = (await get(`${B}/TCS`)).body
  assert.deepEqual(cached.payoff, a)
  assert.equal(cached.legs[0].ltp, 3600)                 // the legs are always live; only the payoff waits
  await post(`${B}/TCS/legs`, { instrument: 'share', qty: 10, avgPrice: 3000 })
  const b = (await get(`${B}/TCS`)).body.payoff
  assert.notDeepEqual(b, a)
  prices.set(TCS_OCT_FUT, 3700); h.clock.now += 59_000
  assert.deepEqual((await get(`${B}/TCS`)).body.payoff, b)
  h.clock.now += 1_000
  assert.notDeepEqual((await get(`${B}/TCS`)).body.payoff, b)
})

test('buildBookView with keys builds a view of that subset only', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const manual = await deps.legs.addManual('ravi', { stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null, qty: 1000, avgPrice: 3000, note: '' }, TCS_SPOT)
  const whole = await buildBookView(deps, 'ravi', 'TCS', h.clock.now)
  const sub = await buildBookView(deps, 'ravi', 'TCS', h.clock.now, { keys: new Set([manual.key]) })
  assert.equal(whole?.legs.length, 3)
  assert.deepEqual(sub?.legs.map((l) => l.key), [manual.key])
  assert.equal(sub?.payoff?.greeks.delta, 1000)           // its own payoff, not the whole book's cached one
  assert.notEqual(whole?.payoff?.greeks.delta, 1000)
  assert.deepEqual(sub?.totals, { delta: 1000, gamma: 0, vega: 0, theta: 0, mtm: 490_000 })
  assert.equal(await buildBookView(deps, 'ravi', 'TCS', h.clock.now, { keys: new Set(['manual:nope']) }), null)
  assert.equal(await buildBookView(deps, 'ravi', 'INFY', h.clock.now), null)
})

test('a book whose legs have all expired is not open', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await deps.legs.replaceOdin('ravi', [pos({ stock: 'TCS', instrument: 'option', expiry: '2026-10-18', strike: 3500, optType: 'CE', qty: -175, avgPrice: 9 })], () => 7)
  assert.equal(await buildBookView(deps, 'ravi', 'TCS', h.clock.now), null)
  assert.equal((await get(`${B}/TCS`)).status, 404)
})

test('the book carries its live series: what its closed contracts booked beside the open legs, from the stored trades', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const at = (day: string) => Date.parse(`${day}T10:00:00+05:30`)
  const trade = (tradeNo: string, side: 'Buy' | 'Sell', price: number, day: string, o: Partial<TraderTrade> = {}): TraderTrade => ({
    trader: 'ravi', tradeNo, orderNo: `o${tradeNo}`, clientCode: 'c0001', stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3400, optType: 'PE',
    side, qty: 175, price, time: at(day), day, seq: Number(tradeNo), ...o,
  })
  // a 3400 PE sold on 14 Oct and bought back on 15 Oct is on no leg; an expired contract and sita's trades are not ravi's series
  for (const doc of [
    trade('1', 'Sell', 30, '2026-10-14'), trade('2', 'Buy', 22, '2026-10-15'),
    trade('3', 'Sell', 30, '2026-09-20', { expiry: '2026-09-29' }), trade('4', 'Buy', 2, '2026-09-25', { expiry: '2026-09-29' }),
    trade('5', 'Sell', 30, '2026-10-14', { trader: 'sita' }),
  ]) await h.db.collection<TraderTrade>('traders-trades').insertOne(doc)
  await deps.ledger.noteHistory('ravi', '2026-10-14')
  deps = { ...deps, series: seriesReader({ db: h.db, ledger: deps.ledger, charges: new ChargeSettingsStore(h.db, () => h.clock.now) }) }
  const r = await get(`${B}/TCS`)
  const open = (45 - 40) * -350 + (3500 - 3480) * 175
  assert.deepEqual(r.body.series.map((s: { expiry: string; open: number; booked: number; closedContracts: number; openLegs: number; from: string; since: string }) =>
    [s.expiry, s.open, s.booked, s.closedContracts, s.openLegs, s.from, s.since]), [[OCT, open, 175 * 8, 1, 2, '2026-10-14', '2026-10-14']])
  assert.ok(r.body.series[0].charges > 40)
  assert.deepEqual([r.body.seriesTotal.booked, r.body.seriesTotal.ratesConfirmed], [1400, false])
  assert.equal(r.body.seriesTotal.net, open + 1400 - r.body.series[0].charges)
  // a group's subset of the legs has no series of its own
  assert.equal('series' in (await buildBookView(deps, 'ravi', 'TCS', h.clock.now, { keys: new Set([r.body.legs[0].key]) }))!, false)
})
