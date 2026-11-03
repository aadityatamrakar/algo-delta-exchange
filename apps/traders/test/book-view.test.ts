import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76ImpliedVol, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE, buildMultiMonthView, legGreeks, type MultiMonthInputs, type PayoffView } from '@algomaker/payoff'
import { bookView, type BookViewInputs } from '../src/analytics/book-view.ts'
import { SEED_RATES } from '../src/analytics/charges.ts'
import { forwardFor, monthQuotes } from '../src/analytics/month-chain.ts'
import type { TraderQuote, TradersQuotes } from '../src/market/quotes.ts'
import { legKey } from '../src/types.ts'
import type { OptType, StoredFile, TraderLeg, WatcherStatus } from '../src/types.ts'
import {
  DEC, NIFTY_SPOT, NIFTY_WK, NOV, OCT, TCS_NOV_FUT, TCS_OCT_FUT, TCS_SPOT,
  niftyWkCE, niftyWkPE, novCE, octCE, octPE, testMaster,
} from './fixtures/master.ts'

const MASTER = testMaster()
const asOf = Date.UTC(2026, 9, 19, 5, 0)          // Mon 10:30 IST
const SUNDAY = Date.UTC(2026, 9, 18, 5, 0)        // Sun 10:30 IST

const PRICES: ReadonlyMap<number, number> = new Map([
  [TCS_SPOT, 3490], [TCS_OCT_FUT, 3500], [TCS_NOV_FUT, 3520],
  [octCE(3400), 130], [octPE(3400), 30], [octCE(3500), 45], [octPE(3500), 45], [octCE(3600), 12], [octPE(3600), 110],
  [novCE(3500), 70],
  [NIFTY_SPOT, 25510], [niftyWkCE(25500), 120], [niftyWkPE(25500), 105],
])

function fakeQuotes(
  prices: ReadonlyMap<number, number>, o: { alive?: boolean; ageMs?: number; at?: number; stale?: ReadonlySet<number> } = {},
): TradersQuotes {
  const ageMs = o.ageMs ?? 0
  return {
    quote(token: number): TraderQuote | null {
      const price = prices.get(token)
      if (price === undefined) return null
      return { price, bid: null, ask: null, oi: null, volume: null, asOf: (o.at ?? asOf) - ageMs, ageMs, ...(o.stale === undefined ? {} : { stale: o.stale.has(token) }) }
    },
    feedAlive: () => o.alive ?? true,
  }
}

function odinLeg(stock: string, instrument: TraderLeg['instrument'], expiry: string, strike: number | null, optType: OptType | null, qty: number, avgPrice: number): TraderLeg {
  const c = { clientCode: 'C1', instrument, stock, expiry, strike, optType }
  // token null: a leg stored before its contract was in the master; the view matches it at read time
  return { trader: 'ravi', ...c, qty, avgPrice, source: 'odin', key: legKey(c), token: null, note: '', updatedAt: 0 }
}
const odinOpt = (stock: string, expiry: string, strike: number, optType: OptType, qty: number, avg: number) => odinLeg(stock, 'option', expiry, strike, optType, qty, avg)
const odinCE = (expiry: string, strike: number, qty: number, avg: number) => odinOpt('TCS', expiry, strike, 'CE', qty, avg)
const odinFut = (expiry: string, qty: number, avg: number) => odinLeg('TCS', 'future', expiry, null, null, qty, avg)
const manualShares = (qty: number, avg: number, stock = 'TCS'): TraderLeg => ({
  trader: 'ravi', stock, instrument: 'share', expiry: '', strike: null, optType: null, qty, avgPrice: avg,
  clientCode: '', source: 'manual', key: `manual:${stock}-${qty}`, token: null, note: '', updatedAt: 0,
})

function storedFile(path: string, o: Partial<StoredFile> = {}): StoredFile {
  return { trader: 'ravi', path, sha256: 'x', size: 1, mtime: 0, receivedAt: asOf, parser: 'odin-nse-fo-trades', parseError: null, ...o }
}

interface Opts {
  stock?: string; feedAlive?: boolean; asOf?: number; watcher?: WatcherStatus | null; files?: StoredFile[]; historyFrom?: string | null
  quotes?: TradersQuotes; payoff?: (i: MultiMonthInputs) => PayoffView | null; problemFiles?: number
}
function inputs(legs: readonly TraderLeg[], o: Opts = {}): BookViewInputs {
  const at = o.asOf ?? asOf
  return {
    stock: o.stock ?? 'TCS', legs, master: MASTER, quotes: o.quotes ?? fakeQuotes(PRICES, { alive: o.feedAlive ?? true, at }), asOf: at,
    watcher: 'watcher' in o ? (o.watcher ?? null) : { lastHeartbeatAt: at - 10_000, lastUploadAt: null, version: '1', folder: 'C:\\ODIN\\OnLineBackup', fileCount: 2 },
    files: o.files ?? [], historyFrom: o.historyFrom ?? null, payoff: o.payoff ?? buildMultiMonthView,
    ...(o.problemFiles === undefined ? {} : { problemFiles: o.problemFiles }),
  }
}

const book = [odinCE(OCT, 3500, -350, 40), odinFut(OCT, 175, 3480), odinFut(NOV, 175, 3500), manualShares(1000, 3000)]

test('legs carry LTP, IV off their own month, position greeks and MTM', () => {
  const v = bookView(inputs(book))
  assert.deepEqual(v.legs.map((l) => l.key), [book[1]!.key, book[0]!.key, book[2]!.key, book[3]!.key])
  const ce = v.legs[1]!
  const t = yearsToExpiry(OCT, asOf)
  const iv = b76ImpliedVol(45, { future: 3500, strike: 3500, t, rate: DEFAULT_RATE, type: 'CE' })!
  assert.ok(Math.abs(ce.iv! - iv) < 1e-6)
  const g = legGreeks({ id: '', instrument: 'option', qty: -350, strike: 3500, type: 'CE', expiry: OCT, entry: 40, iv: ce.iv }, 3500, t)
  assert.deepEqual([ce.delta, ce.gamma, ce.vega, ce.theta], [g.delta, g.gamma, g.vega, g.theta])
  assert.equal(ce.ltp, 45); assert.equal(ce.mtm, (45 - 40) * -350); assert.equal(ce.lotSize, 175); assert.equal(ce.matched, true)
  assert.equal(v.legs[0]!.mtm, (3500 - 3480) * 175); assert.equal(v.legs[2]!.mtm, (3520 - 3500) * 175)
  assert.deepEqual([v.legs[0]!.delta, v.legs[0]!.gamma, v.legs[0]!.vega, v.legs[0]!.theta], [175, 0, 0, 0])
  assert.equal(v.legs[3]!.delta, 1000); assert.equal(v.legs[3]!.mtm, (3490 - 3000) * 1000); assert.equal(v.legs[3]!.lotSize, 1)
  assert.deepEqual(v.futures, { [OCT]: 3500, [NOV]: 3520 }); assert.deepEqual(v.forwards, { [OCT]: 3500, [NOV]: 3520 }); assert.equal(v.spot, 3490)
  assert.ok(Math.abs(v.totals.delta - (175 + 175 + 1000 + ce.delta)) < 1e-9)
  assert.equal(v.totals.mtm, (45 - 40) * -350 + 20 * 175 + 20 * 175 + 490 * 1000)
  assert.deepEqual([v.totals.gamma, v.totals.vega, v.totals.theta], [ce.gamma, ce.vega, ce.theta])
  assert.ok(v.payoff !== null && v.payoff.curve.length > 0)
  assert.equal(v.mismatch, null); assert.deepEqual(v.unmatched, []); assert.deepEqual(v.warnings, [])
  assert.equal(v.stock, 'TCS'); assert.equal(v.asOf, asOf); assert.equal(v.closed, false)
})

test('the payoff is handed every priced leg, a share as an undated future, and the forwards', () => {
  let seen: MultiMonthInputs | null = null
  bookView(inputs(book, { payoff: (i) => { seen = i; return buildMultiMonthView(i) } }))
  const got = seen as MultiMonthInputs | null
  assert.ok(got !== null)
  assert.deepEqual(got.futures, { [OCT]: 3500, [NOV]: 3520 })
  assert.equal(got.spot, 3490); assert.equal(got.today, '2026-10-19'); assert.equal(got.realised, 0); assert.equal(got.targetPnl, null)
  const share = got.legs.find((l) => l.id === book[3]!.key)
  assert.deepEqual(share, { id: book[3]!.key, instrument: 'future', qty: 1000, strike: null, type: null, expiry: '', entry: 3000, iv: null })
  assert.equal(got.legs.length, 4)
})

test('a far-month option is solved against the far month', () => {
  const v = bookView(inputs([odinCE(NOV, 3500, -175, 60), odinFut(OCT, 175, 3480)]))
  const nov = v.legs.find((l) => l.expiry === NOV)!
  const iv = b76ImpliedVol(70, { future: 3520, strike: 3500, t: yearsToExpiry(NOV, asOf), rate: DEFAULT_RATE, type: 'CE' })!
  assert.ok(Math.abs(nov.iv! - iv) < 1e-6)
  const offNear = b76ImpliedVol(70, { future: 3500, strike: 3500, t: yearsToExpiry(OCT, asOf), rate: DEFAULT_RATE, type: 'CE' })!
  assert.ok(Math.abs(nov.iv! - offNear) > 1e-3)
})

test('a weekly with no future is valued off the parity forward', () => {
  const v = bookView(inputs([odinOpt('NIFTY', NIFTY_WK, 25500, 'PE', -65, 110)], { stock: 'NIFTY' }))
  const t = yearsToExpiry(NIFTY_WK, asOf), fwd = 25500 + (120 - 105) * Math.exp(DEFAULT_RATE * t)
  assert.equal(v.futures[NIFTY_WK], null); assert.ok(Math.abs(v.forwards[NIFTY_WK]! - fwd) < 1e-9)
  assert.ok(v.legs[0]!.iv !== null); assert.equal(v.warnings.some((w) => w.includes('carried to expiry')), false)
  assert.ok(v.legs[0]!.delta !== 0)
  assert.ok(v.payoff !== null && v.payoff.curve.length > 0)
  assert.equal(v.payoff.warnings.some((w) => w.includes('no future price')), false)
})

test('1,000 manual shares move delta by exactly 1,000', () => {
  assert.ok(Math.abs(bookView(inputs(book)).totals.delta - bookView(inputs(book.slice(0, 3))).totals.delta - 1000) < 1e-9)
})

test('an unmatched row is listed and kept out of the numbers', () => {
  // 3510 is not on the 25-point TCS grid (the fixture lists 3550, so 3550 would match)
  const v = bookView(inputs([...book, odinCE(OCT, 3510, -175, 10)]))
  assert.deepEqual(v.unmatched, ['not understood: TCS 3510 CE 2026-10-27 (client C1) — no such contract in the instrument master'])
  const row = v.legs.find((l) => l.strike === 3510)!
  assert.equal(row.matched, false); assert.equal(row.ltp, null); assert.equal(row.iv, null); assert.equal(row.mtm, null)
  assert.deepEqual([row.delta, row.gamma, row.vega, row.theta], [0, 0, 0, 0])
  assert.deepEqual(v.totals, bookView(inputs(book)).totals)
  const manual = bookView(inputs([{ ...manualShares(10, 1), stock: 'NOSUCH' }], { stock: 'NOSUCH' }))
  assert.deepEqual(manual.unmatched, ['not understood: NOSUCH shares (client manual) — no such contract in the instrument master'])
})

test('a leg stored without a token is matched against the current master; a stored token is used as is', () => {
  const v = bookView(inputs([odinCE(OCT, 3500, -175, 40), { ...odinCE(OCT, 3600, -175, 10), token: octCE(3500) }]))
  assert.deepEqual(v.legs.map((l) => [l.strike, l.matched, l.ltp]), [[3500, true, 45], [3600, true, 45]])
})

test('legs order by expiry (shares last), futures first, then strike, CE before PE', () => {
  const legs = [manualShares(5, 1), odinOpt('TCS', OCT, 3500, 'PE', 1, 1), odinOpt('TCS', OCT, 3500, 'CE', 1, 1), odinOpt('TCS', OCT, 3400, 'PE', 1, 1), odinFut(OCT, 1, 1), odinCE(NOV, 3500, 1, 1)]
  const v = bookView(inputs(legs))
  assert.deepEqual(v.legs.map((l) => `${l.expiry}|${l.instrument}|${l.strike ?? ''}|${l.optType ?? ''}`), [
    `${OCT}|future||`, `${OCT}|option|3400|PE`, `${OCT}|option|3500|CE`, `${OCT}|option|3500|PE`, `${NOV}|option|3500|CE`, '|share||',
  ])
})

test('a dead feed in session says so first; a closed market does not', () => {
  assert.equal(bookView(inputs(book, { feedAlive: false })).warnings[0], 'the price feed is not ticking: every price below is the last one seen, not a live one')
  const sunday = bookView(inputs(book, { feedAlive: false, asOf: SUNDAY }))
  assert.equal(sunday.closed, true); assert.equal(sunday.warnings.some((w) => w.startsWith('the price feed')), false)
  // the page header says the market is closed, from `closed`; it is not repeated as a warning
  assert.equal(sunday.warnings.some((w) => w.startsWith('market closed')), false)
  assert.deepEqual(sunday.warnings, [])
})

test('a matched leg with no price is named and left out of Today and Leg P&L', () => {
  const v = bookView(inputs([odinCE(OCT, 3500, -350, 40), odinCE(OCT, 3450, -1750, 30)]))
  assert.deepEqual(v.warnings, ['3450 CE 2026-10-27: no price yet — left out of Today and Leg P&L'])
  const unq = v.legs.find((l) => l.strike === 3450)!
  assert.equal(unq.ltp, null); assert.equal(unq.mtm, null); assert.ok(unq.iv !== null)   // its vol is read off the solved neighbours
  assert.equal(v.totals.mtm, (45 - 40) * -350)
})

test('a future with no quote of its own, on a month valued off parity, is named', () => {
  const noNovFut = fakeQuotes(new Map([...PRICES].filter(([t]) => t !== TCS_NOV_FUT).concat([[novCE(3500) + 1, 50]])))
  const v = bookView(inputs([odinFut(NOV, 175, 3500), odinFut(OCT, 175, 3480)], { quotes: noNovFut }))
  const t = yearsToExpiry(NOV, asOf)
  assert.equal(v.futures[NOV], null); assert.ok(Math.abs(v.forwards[NOV]! - (3500 + 20 * Math.exp(DEFAULT_RATE * t))) < 1e-9)
  assert.deepEqual(v.warnings, ['FUT 2026-11-24: no price yet — left out of Today and Leg P&L'])
  const nov = v.legs.find((l) => l.expiry === NOV)!
  assert.equal(nov.mtm, null); assert.equal(nov.delta, 175)
  assert.equal(v.totals.mtm, (3500 - 3480) * 175)
})

test('on expiry day after the close a leg is named as expired, not as unsolved', () => {
  const evening = Date.UTC(2026, 9, 20, 11, 0)       // Tue 16:30 IST, NIFTY_WK's expiry day
  const v = bookView(inputs([odinOpt('NIFTY', NIFTY_WK, 25500, 'PE', -65, 110)], { stock: 'NIFTY', asOf: evening }))
  assert.equal(v.closed, true); assert.equal(v.legs.length, 1)
  assert.equal(v.legs[0]!.iv, null); assert.equal(v.legs[0]!.delta, 0)
  assert.deepEqual(v.warnings, ['25500 PE 2026-10-20: expired at today\'s close — left out of the greeks'])
})

test('in session a stale spot or held month future is named with its last tick', () => {
  const stale = new Set([TCS_SPOT, TCS_NOV_FUT])
  const v = bookView(inputs(book, { quotes: fakeQuotes(PRICES, { stale, ageMs: 300_000 }) }))
  assert.ok(v.warnings.includes('TCS spot price is stale — last tick 10:25'))
  assert.ok(v.warnings.includes('TCS FUT 2026-11-24 price is stale — last tick 10:25'))
  assert.equal(v.warnings.filter((w) => w.includes('is stale')).length, 2)   // the Oct future and the options are not named
  const closed = bookView(inputs(book, { asOf: SUNDAY, quotes: fakeQuotes(PRICES, { stale, at: SUNDAY }) }))
  assert.equal(closed.warnings.some((w) => w.includes('is stale')), false)    // a closed market's prices are all old
  const dead = bookView(inputs(book, { quotes: fakeQuotes(PRICES, { stale, alive: false }) }))
  assert.equal(dead.warnings.some((w) => w.includes('is stale')), false)      // the feed line already says every price is old
  assert.ok(dead.warnings[0]!.startsWith('the price feed is not ticking'))
})

test('from 15:15 the closing auction stops the spot, so only a stale future is named', () => {
  const stale = new Set([TCS_SPOT, TCS_NOV_FUT])
  const at = (h: number, m: number) => Date.UTC(2026, 9, 19, h, m)   // Mon, UTC
  const named = (t: number) => bookView(inputs(book, { asOf: t, quotes: fakeQuotes(PRICES, { stale, ageMs: 300_000, at: t }) }))
    .warnings.filter((w) => w.includes('is stale'))
  assert.deepEqual(named(at(9, 44)), ['TCS spot price is stale — last tick 15:09', 'TCS FUT 2026-11-24 price is stale — last tick 15:09'])   // 15:14 IST
  assert.deepEqual(named(at(9, 45)), ['TCS FUT 2026-11-24 price is stale — last tick 15:10'])                                               // 15:15 IST
  assert.deepEqual(named(at(9, 59)), ['TCS FUT 2026-11-24 price is stale — last tick 15:24'])                                               // 15:29 IST
  assert.deepEqual(named(at(10, 9)), ['TCS FUT 2026-11-24 price is stale — last tick 15:34'])                                              // 15:39 IST, F&O still open
  assert.deepEqual(named(at(10, 10)), [])                                                                                                   // 15:40 IST, closed
})

test('a book whose ATM window was narrowed to fit the feed cap says so', () => {
  const v = bookView({ ...inputs(book), feedCap: 2000 })
  assert.ok(v.warnings.includes('price coverage reduced — the traders feed cap (2000 tokens) is reached'))
  assert.equal(bookView({ ...inputs(book), feedCap: null }).warnings.some((w) => w.startsWith('price coverage')), false)
})

test('watcher offline and a file that did not parse are named', () => {
  const v = bookView(inputs(book, { watcher: { lastHeartbeatAt: asOf - 240_000, lastUploadAt: null, version: '1', folder: 'C:\\ODIN\\OnLineBackup', fileCount: 2 },
    files: [storedFile('Nse Derivatives/Trades/1019TRD.TXT', { parseError: 'line 2: side "3" must be 1 (buy) or 2 (sell)', receivedAt: asOf - 60_000 })] }))
  assert.ok(v.warnings.includes('the watcher has not reported since 10:26 — positions may be out of date'))
  assert.ok(v.warnings.includes('Nse Derivatives/Trades/1019TRD.TXT did not parse at 10:29: line 2: side "3" must be 1 (buy) or 2 (sell) — showing the last good one'))
  const fresh = bookView(inputs(book, { watcher: { lastHeartbeatAt: asOf - 180_000, lastUploadAt: null, version: '1', folder: 'x', fileCount: 0 } }))
  assert.equal(fresh.warnings.some((w) => w.startsWith('the watcher')), false)
  assert.deepEqual(bookView(inputs(book, { watcher: null })).warnings, ['no watcher has reported for this trader yet — positions come only from manual uploads'])
})

test('an internal failure is not shown raw; skipped lines are counted with the first reason', () => {
  const v = bookView(inputs(book, { files: [
    storedFile('d/1019TRD.TXT', { skipped: Array.from({ length: 20 }, (_, k) => ({ lineNo: k + 1, reason: 'odd' })), receivedAt: asOf - 4_000 }),
    storedFile('a/1019TRD.TXT', { parseError: 'internal: Cannot read properties of undefined', receivedAt: asOf - 61_000 }),
    storedFile('b/1019TRD.TXT', { skipped: [{ lineNo: 4, reason: 'trade status "9" is not 11' }, { lineNo: 9, reason: 'x' }], receivedAt: asOf - 2_000 }),
    storedFile('c/1019TRD.TXT', { skipped: [{ lineNo: 2, reason: 'bad side' }], receivedAt: asOf - 3_000 }),
    storedFile('e/1019TRD.TXT', { skipped: [], receivedAt: asOf }),
  ] }))
  assert.deepEqual(v.warnings, [                       // newest first
    '2 lines of b/1019TRD.TXT were skipped: line 4: trade status "9" is not 11',
    '1 line of c/1019TRD.TXT was skipped: line 2: bad side',
    '20 or more lines of d/1019TRD.TXT were skipped: line 1: odd',
    'a/1019TRD.TXT did not parse at 10:28: internal error — the server will retry — showing the last good one',
  ])
})

test('a file from an earlier day shows its date; old problems do not age out', () => {
  const v = bookView(inputs(book, { files: [
    storedFile('Nse Derivatives/Trades/1018TRD.TXT', { parseError: 'line 7: bad side', receivedAt: asOf - 24 * 60 * 60 * 1000 }),
    storedFile('Nse Derivatives/Trades/1005TRD.TXT', { parseError: 'line 1: too few fields', receivedAt: Date.UTC(2026, 9, 5, 4, 0) }),
  ] }))
  assert.deepEqual(v.warnings, [
    'Nse Derivatives/Trades/1018TRD.TXT did not parse at 18 Oct 10:30: line 7: bad side — showing the last good one',
    'Nse Derivatives/Trades/1005TRD.TXT did not parse at 05 Oct 09:30: line 1: too few fields — showing the last good one',
  ])
})

test('at most five files are named, newest first, then how many more', () => {
  const files = Array.from({ length: 7 }, (_, k) => storedFile(`f${k}.TXT`, { parseError: `line ${k}: bad`, receivedAt: asOf - 60_000 * (k + 1) }))
  const v = bookView(inputs(book, { files: [storedFile('clean.TXT'), ...[...files].reverse()] }))
  assert.deepEqual(v.warnings, [
    'f0.TXT did not parse at 10:29: line 0: bad — showing the last good one',
    'f1.TXT did not parse at 10:28: line 1: bad — showing the last good one',
    'f2.TXT did not parse at 10:27: line 2: bad — showing the last good one',
    'f3.TXT did not parse at 10:26: line 3: bad — showing the last good one',
    'f4.TXT did not parse at 10:25: line 4: bad — showing the last good one',
    'and 2 more files with problems — /v1/traders/files lists every file',
  ])
  // the store hands over only the newest six and the total
  const counted = bookView(inputs(book, { files: files.slice(0, 6), problemFiles: 12 }))
  assert.equal(counted.warnings.at(-1), 'and 7 more files with problems — /v1/traders/files lists every file')
})

test('expired legs are hidden with a warning', () => {
  const v = bookView(inputs([...book, odinCE('2026-10-18', 3500, -175, 12)]))
  assert.equal(v.legs.some((l) => l.expiry === '2026-10-18'), false)
  assert.equal(v.legs.length, 4)
  assert.deepEqual(v.warnings, ['1 expired leg(s) hidden — not settled yet: the ledger settles them when it next reads the NSE history'])
  assert.deepEqual(v.totals, bookView(inputs(book)).totals)
})

test('an expired leg the settlement could not price says why, one line per reason; a manual one is never settled', () => {
  const jul = odinCE('2025-07-31', 3500, -175, 12)
  const jul2 = odinOpt('TCS', '2025-07-31', 3400, 'PE', 175, 9)
  const aug = odinCE('2025-08-28', 3500, 175, 10)
  const manualOpt: TraderLeg = { ...odinCE('2026-09-29', 3500, 175, 10), source: 'manual', key: 'manual:x', clientCode: '' }
  const unsettled = [jul, jul2, aug].map((l) => ({
    key: l.key, stock: 'TCS', expiry: l.expiry, qty: l.qty,
    reason: l.expiry === '2025-07-31' ? 'no NSE history for 2025-07-31 (it starts 2025-10-01)' : 'not in the NSE history of 2025-08-28',
  }))
  const v = bookView({ ...inputs([...book, jul, jul2, aug, manualOpt]), settlement: { fills: [], unsettled, deliveries: [] } })
  assert.deepEqual(v.warnings, [
    '2 expired leg(s) hidden — not settled: no NSE history for 2025-07-31 (it starts 2025-10-01)',
    '1 expired leg(s) hidden — not settled: not in the NSE history of 2025-08-28',
    '1 expired leg(s) hidden — manual legs are never settled: delete them, and add a manual share leg for any delivery',
  ])
})

test('delivered shares still in the share leg are named with their expiry and price; a manual share leg beside them is a warning', () => {
  const shares = odinLeg('TCS', 'share', '', null, null, 350, 2032.4)
  const delivery = (expiry: string, n: number, price: number) =>
    ({ key: shares.key, stock: 'TCS', expiry, shares: n, price, from: `C1|option|TCS|${expiry}|2000|CE` })
  const settlement = { fills: [], unsettled: [], deliveries: [delivery('2026-08-25', -175, 1990), delivery('2026-09-29', 175, 2032.4), delivery('2026-09-29', 175, 2032.4)] }
  const odinOnly = book.filter((l) => l.source === 'odin')
  const v = bookView({ ...inputs([...odinOnly, shares]), settlement })
  assert.deepEqual(v.warnings, [
    'delivered shares from the 2026-09-29 expiry are in the book at ₹2,032.40 (+350 shares)',
    'delivered shares from the 2026-08-25 expiry are in the book at ₹1,990.00 (-175 shares)',
    'settlement takes every ITM stock option as exercised, and charges no exercise STT or stamp duty on delivery',
  ])
  // sold since: the share leg is flat, nothing of the delivery is in the book
  assert.deepEqual(bookView({ ...inputs(odinOnly), settlement }).warnings, [])
  // another stock's delivery is not this book's
  assert.deepEqual(bookView({ ...inputs([...odinOnly, shares]), settlement: { ...settlement, deliveries: settlement.deliveries.map((d) => ({ ...d, stock: 'INFY' })) } }).warnings, [])
  // a manual share leg beside a delivery may be the same shares typed in by hand
  const w = bookView({ ...inputs([...book, shares]), settlement }).warnings
  assert.equal(w.at(-1), 'a manual share leg is in this book beside delivered shares the settlement booked — if it stands for that delivery, the shares are counted twice: delete it')
})

test('historyFrom passes through', () => {
  assert.equal(bookView(inputs(book, { historyFrom: '2026-08-25' })).historyFrom, '2026-08-25')
  assert.equal(bookView(inputs(book)).historyFrom, null)
})

test('a month with nothing quoted is carried off spot; a book with no prices says so and has no payoff', () => {
  const dec = bookView(inputs([odinCE(DEC, 3500, -175, 80)]))
  const t = yearsToExpiry(DEC, asOf)
  assert.equal(dec.futures[DEC], null); assert.ok(Math.abs(dec.forwards[DEC]! - 3490 * Math.exp(DEFAULT_RATE * t)) < 1e-9)
  assert.deepEqual(dec.warnings, [
    '2026-12-29 is valued off spot carried to expiry — no future and no two-sided quote at the money',
    '3500 CE 2026-12-29: no price yet — left out of Today and Leg P&L',
    '3500 CE 2026-12-29: no vol solved from the 2026-12-29 chain — left out of the greeks',
  ])
  assert.equal(dec.legs[0]!.iv, null); assert.equal(dec.legs[0]!.delta, 0)

  const dark = bookView(inputs([odinLeg('JINDALSTEL', 'option', OCT, 1000, 'CE', -625, 20)], { stock: 'JINDALSTEL' }))
  assert.equal(dark.spot, null); assert.deepEqual(dark.forwards, { [OCT]: null }); assert.deepEqual(dark.futures, { [OCT]: null })
  assert.deepEqual(dark.warnings, ['no spot price for JINDALSTEL yet', 'no price for 2026-10-27 yet — that month\'s legs are not priced'])
  assert.equal(dark.payoff, null); assert.equal(dark.legs[0]!.ltp, null); assert.equal(dark.legs[0]!.mtm, null); assert.equal(dark.totals.mtm, 0)
})

test('forwardFor answers for any listed month, held or not', () => {
  const q = fakeQuotes(PRICES)
  assert.deepEqual(forwardFor(MASTER, q, 'TCS', OCT, 3490, asOf), { price: 3500, source: 'future' })
  const tDec = yearsToExpiry(DEC, asOf)
  assert.deepEqual(forwardFor(MASTER, q, 'TCS', DEC, 3490, asOf), { price: 3490 * Math.exp(DEFAULT_RATE * tDec), source: 'carry' })
  assert.equal(forwardFor(MASTER, q, 'TCS', DEC, null, asOf), null)
  // no spot and no quoted future: the reference is the chain's middle strike, 25500
  const tWk = yearsToExpiry(NIFTY_WK, asOf)
  assert.deepEqual(forwardFor(MASTER, q, 'NIFTY', NIFTY_WK, null, asOf), { price: 25500 + 15 * Math.exp(DEFAULT_RATE * tWk), source: 'parity' })
  // the two-sided strike nearest the reference wins
  const two = fakeQuotes(new Map([...PRICES, [niftyWkCE(25700), 40], [niftyWkPE(25700), 220], [niftyWkCE(25600), 70]]))
  assert.deepEqual(forwardFor(MASTER, two, 'NIFTY', NIFTY_WK, 25690, asOf), { price: 25700 + (40 - 220) * Math.exp(DEFAULT_RATE * tWk), source: 'parity' })
  assert.deepEqual(forwardFor(MASTER, two, 'NIFTY', NIFTY_WK, 25510, asOf), { price: 25500 + 15 * Math.exp(DEFAULT_RATE * tWk), source: 'parity' })
  // with no spot the nearest listed future's price is the reference: OCT at 3100 picks the 3000 pair, not the middle strike's 3500
  const noNov = fakeQuotes(new Map([[TCS_OCT_FUT, 3100], [novCE(3500), 70], [novCE(3500) + 1, 50], [novCE(3000), 520], [novCE(3000) + 1, 1]]))
  const tNov = yearsToExpiry(NOV, asOf)
  assert.deepEqual(forwardFor(MASTER, noNov, 'TCS', NOV, null, asOf), { price: 3000 + 519 * Math.exp(DEFAULT_RATE * tNov), source: 'parity' })
  assert.deepEqual(forwardFor(MASTER, fakeQuotes(new Map([[novCE(3500), 70], [novCE(3500) + 1, 50], [novCE(3000), 520], [novCE(3000) + 1, 1]])), 'TCS', NOV, null, asOf),
    { price: 3500 + 20 * Math.exp(DEFAULT_RATE * tNov), source: 'parity' })
})

test('monthQuotes lists the quoted chain and solves it against its own forward', () => {
  const mq = monthQuotes(MASTER, fakeQuotes(PRICES), 'TCS', OCT, 3490, asOf, false)
  assert.equal(mq.expiry, OCT); assert.equal(mq.future, 3500); assert.equal(mq.forward, 3500); assert.equal(mq.source, 'future')
  assert.equal(mq.tYears, yearsToExpiry(OCT, asOf))
  assert.deepEqual(mq.quotes.map((x) => [x.strike, x.type, x.price]), [[3400, 'CE', 130], [3400, 'PE', 30], [3500, 'CE', 45], [3500, 'PE', 45], [3600, 'CE', 12], [3600, 'PE', 110]])
  assert.deepEqual(mq.ivs.map((x) => [x.strike, x.type, x.source]), [[3400, 'CE', 'quote'], [3400, 'PE', 'quote'], [3500, 'CE', 'quote'], [3500, 'PE', 'quote'], [3600, 'CE', 'quote'], [3600, 'PE', 'quote']])
  const wk = monthQuotes(MASTER, fakeQuotes(PRICES), 'NIFTY', NIFTY_WK, 25510, asOf, false)
  assert.equal(wk.future, null); assert.equal(wk.source, 'parity')
  const none = monthQuotes(MASTER, fakeQuotes(new Map()), 'TCS', OCT, null, asOf, false)
  assert.deepEqual([none.forward, none.source, none.ivs.length, none.quotes.length], [null, null, 0, 0])
})

test('quotes days old solve when the market is closed, not in session', () => {
  const old = fakeQuotes(PRICES, { ageMs: 3 * 24 * 60 * 60 * 1000 })
  assert.equal(monthQuotes(MASTER, old, 'TCS', OCT, 3490, asOf, false).ivs.every((x) => x.iv === null), true)
  assert.equal(monthQuotes(MASTER, old, 'TCS', OCT, 3490, SUNDAY, true).ivs.every((x) => x.source === 'quote'), true)
  const sunday = bookView(inputs(book, { asOf: SUNDAY, quotes: fakeQuotes(PRICES, { ageMs: 3 * 24 * 60 * 60 * 1000, at: SUNDAY }) }))
  assert.ok(sunday.legs.find((l) => l.instrument === 'option')!.iv !== null)
  const stale = fakeQuotes(PRICES, { ageMs: 5 * 24 * 60 * 60 * 1000 })
  assert.equal(monthQuotes(MASTER, stale, 'TCS', OCT, 3490, SUNDAY, true).ivs.every((x) => x.iv === null), true)
})

test('the series ride along when their inputs are given: open is the legs\' own MTM, booked the cycles closed, the payoff untouched', () => {
  const at = (day: string) => Date.parse(`${day}T10:00:00+05:30`)
  const closed = (strike: number, sell: number, buy: number, seq: number) => [
    { clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: OCT, strike, optType: 'PE' as const, side: 'Sell' as const, qty: 175, price: sell, day: '2026-10-14', time: at('2026-10-14'), seq, orderNo: `s${seq}` },
    { clientCode: 'C1', stock: 'TCS', instrument: 'option' as const, expiry: OCT, strike, optType: 'PE' as const, side: 'Buy' as const, qty: 175, price: buy, day: '2026-10-15', time: at('2026-10-15'), seq, orderNo: `b${seq}` },
  ]
  let realised: number | null = null
  const plain = bookView(inputs(book))
  assert.equal('series' in plain, false)
  const v = bookView({
    ...inputs(book, { payoff: (i) => { realised = i.realised; return buildMultiMonthView(i) } }),
    series: { trader: 'ravi', trades: [...closed(3300, 20, 26, 1), ...closed(3200, 10, 4, 2)], balance: null, historyFrom: '2026-09-01', rates: SEED_RATES },
  })
  assert.equal(realised, 0)
  assert.deepEqual(v.series?.map((s) => [s.expiry, s.open, s.booked, s.closedContracts, s.openLegs]), [
    [OCT, (45 - 40) * -350 + (3500 - 3480) * 175, 175 * -6 + 175 * 6, 2, 2],
    [NOV, (3520 - 3500) * 175, 0, 0, 1],
  ])
  const oct = v.series![0]!
  assert.ok(oct.charges > 80 && oct.net === (oct.gross as number) - oct.charges)
  assert.equal(v.seriesTotal?.open, (45 - 40) * -350 + 20 * 175 + 20 * 175)   // the shares' MTM is not in a series
  assert.deepEqual(v.seriesTotal?.notes, ['shares are left out of P&L: they have no expiry'])
  assert.equal(v.seriesTotal?.ratesConfirmed, false)
  assert.deepEqual({ ...v, series: undefined, seriesTotal: undefined }, { ...plain, series: undefined, seriesTotal: undefined })
})
