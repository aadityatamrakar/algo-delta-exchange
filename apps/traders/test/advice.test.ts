import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_RULE_STATE, MARK_STEP_MIN, PRESETS, SESSION_OPEN_MIN, decide, markOf, resolveDials, type EngineAction,
} from '@algomaker/desk-engine'
import { P4_NOTE, SHIFT_NOTE, actionLines, adviceOf, historyNote } from '../src/analytics/advice.ts'
import { TRADER_DIALS, bandOf } from '../src/analytics/band.ts'
import { bookView } from '../src/analytics/book-view.ts'
import { MEASURED_NOTE, OFFSET_INSTRUMENT, chainSnapOf, engineBookOf, nearFutureOf, type EngineBook } from '../src/analytics/engine-book.ts'
import { BookRisk, engineBookFor, readingOf } from '../src/analytics/risk.ts'
import { whatIfOfActions } from '../src/analytics/what-if.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { legKey, type BookView, type Instrument, type LegView, type OptType } from '../src/types.ts'
import { NIFTY_W1, NIFTY_W2, NOV, OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'

const NOW = Date.parse('2026-10-19T11:00:00+05:30')
const M = r3Master()
type Row = readonly [Instrument, string, number | null, OptType | null, number]
type Quotes = ReturnType<typeof fakeQuotes>

/** Short 10 lots of the TCS OCT 3300 PE (lot 175): long delta, past its band; relief-r sells 2 lots of the 3500 CE. */
const SHORT_PUT: readonly Row[] = [['option', OCT, 3300, 'PE', -1750]]

/** TCS spot 3395, its OCT future 3400 and OCT chain; NIFTY 25000, its W2 future, and the W1 and W2 chains; all quoted at `at`. */
function priced(at = NOW, o: { feedAlive?: boolean } = {}): Quotes {
  const q = fakeQuotes(o)
  q.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: at })
  q.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: at })
  priceChain(q, M, 'TCS', OCT, 3400, 0.25, at)
  q.set(spotTokenOf(M, 'NIFTY') as number, { price: 25000, asOf: at })
  q.set(M.options.future('NIFTY', NIFTY_W2)?.instrumentToken as number, { price: 25020, bid: 25019, ask: 25021, asOf: at })
  priceChain(q, M, 'NIFTY', NIFTY_W2, 25020, 0.15, at)
  priceChain(q, M, 'NIFTY', NIFTY_W1, 25010, 0.15, at)
  return q
}

function viewOf(stock: string, rows: readonly Row[], q: Quotes, asOf = NOW, historyFrom: string | null = null): BookView {
  const legs = rows.map(([instrument, expiry, strike, optType, qty]) => {
    const base = { trader: 'ravi', stock, instrument, expiry, strike, optType, qty, avgPrice: 50, clientCode: 'C1', source: 'odin' as const, token: null, note: '', updatedAt: 0 }
    return { ...base, key: legKey(base) }
  })
  return bookView({ stock, legs, master: M, quotes: q, asOf, watcher: null, files: [], historyFrom, payoff: () => null })
}

function bookOf(stock: string, rows: readonly Row[], at = NOW, o: { feedAlive?: boolean } = {}): { book: EngineBook; view: BookView; q: Quotes } {
  const q = priced(at, o)
  const view = viewOf(stock, rows, q, at)
  const book = engineBookFor(M, q, view, 'ravi', at)
  if ('blocked' in book) throw new Error(book.blocked)
  return { book, view, q }
}

const markCtx = (book: EngineBook) => ({ isNewMark: true, markIndexToday: (markOf(book.inputs.minuteOfDay) - SESSION_OPEN_MIN) / MARK_STEP_MIN })
const engineBand = (book: EngineBook, stock = 'TCS', override: number | null = null, open = true) => bandOf(book, stock, override, true, open)
const card = (book: EngineBook, o: { stock?: string; historyFrom?: string | null; nowMs?: number; override?: number | null; open?: boolean } = {}) => {
  const stock = o.stock ?? 'TCS'
  return adviceOf(book, engineBand(book, stock, o.override ?? null, o.open ?? true), stock, o.historyFrom ?? null, o.nowMs ?? NOW, true)
}
const mid = (book: EngineBook, strike: number, t: OptType): number => {
  const row = book.inputs.chain.strikes.find((s) => s.strike === strike)
  const q = t === 'CE' ? row?.ce : row?.pe
  return ((q?.bid as number) + (q?.ask as number)) / 2
}

test("relief-r's own lock cannot fire from a clean state in one pass", () => {
  const { book } = bookOf('TCS', SHORT_PUT)
  const rich: EngineBook = { ...book, inputs: { ...book.inputs, legs: book.inputs.legs.map((l) => ({ ...l, mtm: 300_000 })) } }
  const reliefR = PRESETS.find((p) => p.key === 'recenter-relief-r')
  assert.ok(reliefR !== undefined)
  const d = decide(rich.inputs, resolveDials(reliefR.dials).dials, EMPTY_RULE_STATE, markCtx(rich))
  assert.deepEqual([d.action, d.trigger, d.actions], ['hold', 'lock', []])
  assert.match(d.reason, /confirming 1\/3/)
})

test('under trader the same book gets corridor advice', () => {
  const { book } = bookOf('TCS', SHORT_PUT)
  const rich: EngineBook = { ...book, inputs: { ...book.inputs, legs: book.inputs.legs.map((l) => ({ ...l, mtm: 300_000 })) } }
  const c = card(rich)
  assert.notEqual(c.trigger, 'lock')
  assert.deepEqual([c.status, c.trigger], ['advice', 'shed'])
})

test('a book out of band gets sells on the shed side', () => {
  const { book } = bookOf('TCS', SHORT_PUT)
  const band = engineBand(book)
  assert.ok((band.netDelta as number) > 0)
  assert.equal(band.state, 'out')
  const c = adviceOf(book, band, 'TCS', null, NOW, true)
  assert.equal(c.status, 'advice')
  assert.ok(c.lines.length > 0)
  for (const line of c.lines) assert.ok(line.startsWith('Sell '), line)
  assert.deepEqual(c.lines, ['Sell 2 lots TCS OCT 3500 CE'])
  assert.equal(c.headline, c.lines[0])
  assert.ok(c.whatIf.length > 0)
  for (const l of c.whatIf) assert.deepEqual([l.instrument, l.optType, l.expiry, Math.sign(l.qty)], ['option', 'CE', OCT, -1])
  const d = decide(book.inputs, TRADER_DIALS, EMPTY_RULE_STATE, markCtx(book))
  assert.equal(c.reason, d.reason)
  assert.equal(c.trigger, d.trigger)
  assert.equal(c.band, band)
  assert.deepEqual([c.stock, c.asOf, c.computedAt], ['TCS', book.inputs.chain.asOf, NOW])
})

test('nothing is carried between passes', () => {
  const before = structuredClone(EMPTY_RULE_STATE)
  const { book } = bookOf('TCS', SHORT_PUT)
  const other = bookOf('TCS', [['option', OCT, 3300, 'CE', -1750]]).book
  const a = card(book)
  const between = card(other, { nowMs: NOW + 10_000 })
  assert.equal(between.status, 'advice')
  const b = card(book, { nowMs: NOW + 30_000 })
  assert.equal(b.computedAt, NOW + 30_000)
  assert.deepEqual({ ...b, computedAt: 0 }, { ...a, computedAt: 0 })
  assert.deepEqual(EMPTY_RULE_STATE, before)
})

test('whatIf mirrors the actions', () => {
  const { book } = bookOf('TCS', SHORT_PUT)
  const sell: EngineAction = { op: 'open', strike: 3500, optType: 'CE', side: 'Sell', lots: 2 }
  assert.deepEqual(whatIfOfActions([sell], book), [{ instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, price: mid(book, 3500, 'CE') }])
  const key = book.inputs.legs[0]?.instrument as string
  const moves: EngineAction[] = [
    { op: 'open', strike: 3300, optType: 'PE', side: 'Buy', lots: 1 },
    { op: 'close', instrument: key },
    { op: 'resize', instrument: key, targetLots: 4 },
    { op: 'resize', instrument: key, targetLots: 12 },
    { op: 'resize', instrument: key, targetLots: 10 },   // nothing between held and target: no row
  ]
  const put = mid(book, 3300, 'PE')
  assert.deepEqual(whatIfOfActions(moves, book).map((l) => [l.strike, l.optType, l.qty, l.price]), [
    [3300, 'PE', 175, put], [3300, 'PE', 1750, put], [3300, 'PE', 1050, put], [3300, 'PE', -350, put],
  ])
  assert.deepEqual(whatIfOfActions([{ op: 'close', instrument: 'no such leg' }], book), [])
})

test('the action words: Sell, Buy, Buy back, Sell out, and a resize by the lots between', () => {
  const { book } = bookOf('TCS', [['option', OCT, 3300, 'PE', -1750], ['option', OCT, 3450, 'CE', 350]])
  const [short, long] = [book.inputs.legs.find((l) => l.side === 'Sell'), book.inputs.legs.find((l) => l.side === 'Buy')]
  assert.ok(short !== undefined && long !== undefined)
  assert.deepEqual(actionLines([
    { op: 'open', strike: 3500, optType: 'CE', side: 'Sell', lots: 2 },
    { op: 'open', strike: 3350, optType: 'PE', side: 'Buy', lots: 1 },
    { op: 'close', instrument: short.instrument },
    { op: 'close', instrument: long.instrument },
    { op: 'resize', instrument: short.instrument, targetLots: 9 },
    { op: 'resize', instrument: short.instrument, targetLots: 13 },
    { op: 'resize', instrument: long.instrument, targetLots: 1 },
    { op: 'resize', instrument: long.instrument, targetLots: 5 },
  ], book, 'TCS'), [
    'Sell 2 lots TCS OCT 3500 CE',
    'Buy 1 lot TCS OCT 3350 PE',
    'Buy back 10 lots TCS OCT 3300 PE',
    'Sell out 2 lots TCS OCT 3450 CE',
    'Buy back 1 lot TCS OCT 3300 PE',
    'Sell 3 lots TCS OCT 3300 PE',
    'Sell out 1 lot TCS OCT 3450 CE',
    'Buy 3 lots TCS OCT 3450 CE',
  ])
})

test('notes start with the history line', () => {
  const { book } = bookOf('TCS', SHORT_PUT)
  const dated = card(book, { historyFrom: '2026-10-01' })
  assert.equal(dated.historyFrom, '2026-10-01')
  assert.equal(historyNote('2026-10-01'),
    'Built from trades since 2026-10-01. Positions opened before then, and shares delivered at expiry, count only if added as manual legs.')
  assert.equal(historyNote(null),
    'The start of the trade history is not known. Positions opened before it, and shares delivered at expiry, count only if added as manual legs.')
  assert.equal(P4_NOTE, 'From where the book stands now: the engine starts clean each time and does not remember earlier suggestions.')
  assert.equal(SHIFT_NOTE, "relief-r's margin-gated shift needs a broker margin figure, which a trader book does not have, so this card never suggests a shift.")
  assert.deepEqual(dated.notes, [historyNote('2026-10-01'), P4_NOTE, SHIFT_NOTE, 'Advises on the 27 Oct expiry only.'])
  const unknown = card(book)
  assert.equal(unknown.historyFrom, null)
  assert.equal(unknown.notes[0], historyNote(null))

  // an override: the card names both bands, since relief-r acts on its own
  const own = engineBand(book).bandLots as number
  const over = card(book, { override: 2 })
  assert.equal(over.notes.length, 5)
  assert.equal(over.notes[4], `Your band is overridden to 2 lots; relief-r acts on its own band of ${own} lots.`)
  assert.equal(card(book, { override: 1 }).notes[4], `Your band is overridden to 1 lot; relief-r acts on its own band of ${own} lots.`)
  assert.deepEqual(over.lines, card(book).lines, 'the override does not change what relief-r advises')
})

test('a row the master does not know is left out, and said', () => {
  const q = priced()
  const view = viewOf('TCS', [...SHORT_PUT, ['option', OCT, 9999, 'CE', -175]], q)
  const book = engineBookFor(M, q, view, 'ravi', NOW)
  assert.ok(!('blocked' in book))
  assert.equal(card(book).notes.at(-1), '1 row not understood is left out')
})

test('a NIFTY weekly book advises on its weekly', () => {
  // the day before the weekly's expiry relief-r sells nothing (min_sell_dte), and says so
  const late = card(bookOf('NIFTY', [['option', NIFTY_W1, 25200, 'PE', -1500]]).book, { stock: 'NIFTY' })
  assert.ok(late.notes.includes('Advises on the 20 Oct expiry only.'), JSON.stringify(late.notes))
  assert.equal(late.status, 'hold')
  assert.match(late.reason, /no fresh sells/)
  for (const l of late.whatIf) assert.ok(l.expiry === NIFTY_W1 && l.qty % 75 === 0, JSON.stringify(l))

  // four days out it sells, on the weekly, in its lots of 75
  const FRI = Date.parse('2026-10-16T11:00:00+05:30')
  const { book } = bookOf('NIFTY', [['option', NIFTY_W1, 25200, 'PE', -1500]], FRI)
  assert.equal(book.expiry, NIFTY_W1)
  const c = card(book, { stock: 'NIFTY', nowMs: FRI })
  assert.equal(c.status, 'advice')
  assert.ok(c.notes.includes('Advises on the 20 Oct expiry only.'))
  assert.ok(c.whatIf.length > 0)
  for (const l of c.whatIf) assert.ok(l.expiry === NIFTY_W1 && l.qty % 75 === 0 && l.qty !== 0, JSON.stringify(l))
  // a weekly is named by its day, so it is not read as the month's last expiry
  for (const line of c.lines) assert.match(line, /^Sell \d+ lots? NIFTY 20OCT \d+ CE$/)
})

test('Saturday', () => {
  const SAT = Date.parse('2026-10-24T11:00:00+05:30')
  const { book, view } = bookOf('TCS', SHORT_PUT, SAT)
  assert.equal(view.closed, true)
  const c = card(book, { nowMs: SAT, open: false })
  assert.deepEqual([c.status, c.headline, c.lines, c.whatIf], ['hold', 'Market closed', [], []])
  assert.match(c.reason, /not an NSE trading day/)
})

test('a weekday NSE holiday with no ticks: Market closed, not a dead feed (R3 final fix I1)', () => {
  const HOLIDAY = Date.parse('2026-10-20T11:00:00+05:30')   // Tuesday, Dussehra
  const { book, view } = bookOf('TCS', SHORT_PUT, HOLIDAY, { feedAlive: false })
  assert.equal(view.closed, true)
  const r = readingOf(book, view, null, false, HOLIDAY)
  assert.deepEqual([r.advice.status, r.advice.headline, r.advice.lines, r.advice.whatIf], ['hold', 'Market closed', [], []])
  assert.equal(r.advice.reason, '2026-10-20 is not an NSE trading day')
  assert.match(r.band.sentence, / \(market closed\)$/)
})

test('after the 15:40 close: Market closed, on expiry day too', () => {
  const late = Date.parse('2026-10-19T15:41:00+05:30')
  const c = card(bookOf('TCS', SHORT_PUT, late).book, { nowMs: late, open: false })
  assert.deepEqual([c.status, c.headline], ['hold', 'Market closed'])
  assert.equal(c.reason, 'the market closed at 15:40')
  // on expiry day the settled expiry is no longer the one read (final fix M3): the book is on the next listed chain, and there is nothing left to trade
  const expiry = Date.parse('2026-10-27T15:45:00+05:30')
  const { book } = bookOf('TCS', SHORT_PUT, expiry)
  assert.deepEqual([book.expiry, book.inputs.legs], [NOV, []])
  const e = card(book, { nowMs: expiry, open: false })
  assert.deepEqual([e.status, e.headline, e.trigger, e.lines, e.whatIf], ['hold', 'Market closed', 'none', [], []])
  assert.equal(e.reason, 'the market closed at 15:40')
})

test('from 15:30 the desk\'s rules have stopped though F&O trades to 15:40: no advice at the engine\'s last mark, and never its expiry settle (R3 final fix M2)', () => {
  const close = Date.parse('2026-10-19T15:30:00+05:30')
  const { book, view } = bookOf('TCS', SHORT_PUT, close)
  assert.equal(view.closed, false)
  const atClose = decide(book.inputs, TRADER_DIALS, EMPTY_RULE_STATE, markCtx(book))
  assert.deepEqual([atClose.action, atClose.trigger], ['adjust', 'shed'], 'the engine still acts at 15:30')
  const c = card(book, { nowMs: close })
  assert.doesNotMatch(c.band.sentence, /market closed/)
  const stopped = "the desk's rules stop at 15:30 — F&O trades until 15:40"
  assert.deepEqual([c.status, c.headline, c.trigger, c.lines, c.whatIf], ['hold', 'Advice ends at 15:30', 'none', [], []])
  assert.equal(c.reason, stopped)
  const later = Date.parse('2026-10-19T15:39:00+05:30')
  assert.deepEqual([card(bookOf('TCS', SHORT_PUT, later).book, { nowMs: later }).headline], ['Advice ends at 15:30'])
  // on an expiry day the engine settles every leg at 15:30, before its session gate: the card shows none of it
  const settle: EngineBook = { ...book, inputs: { ...book.inputs, dateIst: OCT, dte: 0 } }
  const d = decide(settle.inputs, TRADER_DIALS, EMPTY_RULE_STATE, markCtx(settle))
  assert.deepEqual([d.action, d.trigger], ['flatten', 'expiry'])
  const e = card(settle, { nowMs: Date.parse(`${OCT}T15:30:00+05:30`) })
  assert.deepEqual([e.status, e.headline, e.trigger, e.lines, e.whatIf], ['hold', 'Advice ends at 15:30', 'none', [], []])
  assert.equal(e.reason, stopped)
  // a minute earlier the session is still on
  const before = Date.parse('2026-10-19T15:29:00+05:30')
  assert.equal(card(bookOf('TCS', SHORT_PUT, before).book, { nowMs: before }).status, 'advice')
})

test('09:16', () => {
  const early = Date.parse('2026-10-19T09:16:00+05:30')
  const c = card(bookOf('TCS', SHORT_PUT, early).book, { nowMs: early })
  assert.deepEqual([c.status, c.headline, c.lines], ['hold', 'Advice starts at 09:20', []])
  assert.match(c.reason, /the rules start at 09:20/)
})

test('a hold in session says Hold; a book with no option leg has nothing to adjust', () => {
  const { book } = bookOf('TCS', [['option', OCT, 3450, 'CE', -1750], ['option', OCT, 3350, 'PE', -1750]])
  const c = card(book)
  assert.deepEqual([c.status, c.headline, c.trigger, c.lines, c.whatIf], ['hold', 'Hold', 'none', [], []])
  assert.match(c.reason, /inside allowed/)
  const bare: EngineBook = { ...book, inputs: { ...book.inputs, legs: [] } }
  assert.deepEqual([card(bare).status, card(bare).headline], ['hold', 'Nothing to adjust in options'])
  // a book of futures alone has engine legs, and still no option to adjust
  const futures = bookOf('TCS', [['future', OCT, null, null, 175]]).book
  assert.equal(futures.inputs.legs.length, 1)
  assert.deepEqual([card(futures).status, card(futures).headline], ['hold', 'Nothing to adjust in options'])
})

test('feed dead → advice unavailable', () => {
  const { book } = bookOf('TCS', SHORT_PUT, NOW, { feedAlive: false })
  const band = bandOf(book, 'TCS', null, false, true)
  const c = adviceOf(book, band, 'TCS', '2026-10-01', NOW, false)
  assert.deepEqual([c.status, c.headline, c.lines, c.whatIf], ['unavailable', 'No advice: the market data feed is dead', [], []])
  assert.equal(c.band.state, 'unknown')
  assert.equal(c.notes[0], historyNote('2026-10-01'))
  assert.equal(adviceOf(book, bandOf(book, 'TCS', 1.5, false, true), 'TCS', null, NOW, false).notes[4],
    'Your band is overridden to 1.5 lots; relief-r acts on its own band.')
  // outside the session a quiet feed is not a dead one: the card says the market is closed
  const SAT = Date.parse('2026-10-24T11:00:00+05:30')
  const sat = bookOf('TCS', SHORT_PUT, SAT, { feedAlive: false }).book
  const closed = adviceOf(sat, bandOf(sat, 'TCS', null, false, false), 'TCS', null, SAT, false)
  assert.deepEqual([closed.status, closed.headline], ['hold', 'Market closed'])
})

test('a near leg with no IV: the band is unknown, so the card has no advice either, in the band\'s words (R3 final fix I3)', async () => {
  // TCS spot and its OCT future tick, its chain does not: the month has a forward and no vol
  const q = fakeQuotes()
  q.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: NOW })
  q.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: NOW })
  const view = viewOf('TCS', SHORT_PUT, q)
  assert.deepEqual(view.legs.map((l) => l.iv), [null])
  const book = engineBookFor(M, q, view, 'ravi', NOW)
  assert.ok(!('blocked' in book))
  const band = bandOf(book, 'TCS', null, true, true)
  assert.deepEqual([band.state, band.sentence], ['unknown', 'Band unknown: a leg has no IV (3300 PE 2026-10-27)'])
  const c = adviceOf(book, band, 'TCS', null, NOW, true)
  assert.deepEqual([c.status, c.headline, c.lines, c.whatIf, c.trigger], ['unavailable', 'No advice: a leg has no IV (3300 PE 2026-10-27)', [], [], 'none'])
  assert.equal(c.band, band)
  // BookRisk gives the same pair
  const r = await riskOver(view, q).risk.advice('ravi', 'TCS', NOW)
  assert.deepEqual([r?.status, r?.headline, r?.band.state], ['unavailable', 'No advice: a leg has no IV (3300 PE 2026-10-27)', 'unknown'])
})

test('blocked → unavailable with the blocking sentence', () => {
  // a stale spot in session blocks the band, and the advice with it, in the view's own words (R3-12)
  const stale = priced()
  stale.set(spotTokenOf(M, 'TCS') as number, { stale: true, asOf: NOW - 5 * 60_000 })
  const sv = viewOf('TCS', [...SHORT_PUT, ['future', OCT, null, null, 175]], stale)
  const sb = engineBookFor(M, stale, sv, 'ravi', NOW)
  assert.ok('blocked' in sb)
  const why = 'Band unknown: TCS spot price is stale — last tick 10:55'
  const s = adviceOf(sb, bandOf(sb, 'TCS', null, true, true), 'TCS', null, NOW, true)
  assert.deepEqual([s.status, s.headline, s.lines, s.whatIf, s.asOf, s.computedAt], ['unavailable', why, [], [], NOW, NOW])
  assert.equal(s.band.sentence, why)
  assert.deepEqual(s.notes, [historyNote(null), P4_NOTE, SHIFT_NOTE], 'no expiry is advised on')
  // an override is still named; relief-r's own band cannot be measured on a blocked book
  assert.deepEqual(adviceOf(sb, bandOf(sb, 'TCS', 2, true, true), 'TCS', null, NOW, true).notes.slice(3),
    ['Your band is overridden to 2 lots; relief-r acts on its own band.'])
})

/** SHORT_PUT's view with two NOV calls of position delta +900 and +350 (priced), and `extra` rows. */
function withNov(extra: readonly Row[] = []): { book: EngineBook; view: BookView } {
  const q = priced()
  const view = viewOf('TCS', [...SHORT_PUT, ...extra], q)
  const nov = (strike: number, delta: number): LegView => ({
    key: `C1|option|TCS|${NOV}|${strike}|CE`, source: 'odin', clientCode: 'C1', note: '', lotSize: 175, instrument: 'option', expiry: NOV, strike, optType: 'CE',
    qty: 1750, avgPrice: 60, ltp: 70, iv: 0.25, delta, gamma: 1, vega: 500, theta: -400, mtm: 17_500, matched: true,
  })
  const legs = [...view.legs, nov(3400, 900), nov(3500, 350)]
  const withLegs: BookView = { ...view, legs, forwards: { ...view.forwards, [NOV]: 3420 } }
  const chain = chainSnapOf(M, q, withLegs, OCT, NOW)
  assert.ok(chain)
  return { book: engineBookOf(withLegs, chain, nearFutureOf(M, 'TCS', '2026-10-19'), NOW, 'ravi'), view: withLegs }
}

test('the card says what it carries besides the near options (P5)', () => {
  const { book } = withNov()
  assert.equal(book.offsetShares, 1250)
  const c = card(book)
  assert.deepEqual(c.notes, [historyNote(null), P4_NOTE, SHIFT_NOTE,
    "Advises on the 27 Oct expiry only; other expiries' options are carried as a fixed delta of +1,250 shares (spec P5)."])
  // net short, and with a future held: the sign, and the measured note after it
  const short: EngineBook = { ...book, offsetShares: -1250.4, notes: [MEASURED_NOTE] }
  assert.deepEqual(card(short).notes.slice(3), [
    "Advises on the 27 Oct expiry only; other expiries' options are carried as a fixed delta of -1,250 shares (spec P5).", MEASURED_NOTE,
  ])
  const shares = bookOf('TCS', [...SHORT_PUT, ['share', '', null, null, 100]]).book
  assert.deepEqual(card(shares).notes.slice(3), ['Advises on the 27 Oct expiry only.', MEASURED_NOTE])
})

test('advice never names a future, a share or the offset', () => {
  const books = [
    bookOf('TCS', [...SHORT_PUT, ['future', OCT, null, null, 175]]).book,
    withNov().book,
    bookOf('TCS', [['share', '', null, null, 1000]]).book,
  ]
  const cards = books.map((b) => card(b))
  assert.deepEqual(cards.map((c) => c.status), ['advice', 'advice', 'hold'], JSON.stringify(cards.map((c) => c.reason)))
  for (const c of cards) {
    for (const line of [c.headline, ...c.lines]) assert.doesNotMatch(line, /FUT|shares|offset/i, line)
    for (const l of c.whatIf) assert.deepEqual([l.instrument, l.expiry, l.strike === null], ['option', OCT, false], JSON.stringify(l))
  }
  // an action the engine never sends, on a measured leg, gives no line and no row
  for (const book of books.slice(0, 2)) {
    const measured = book.inputs.legs.filter((l) => l.kind === 'future').map((l) => l.instrument)
    assert.ok(measured.length > 0)
    const moves: EngineAction[] = measured.flatMap((instrument) => [{ op: 'close', instrument }, { op: 'resize', instrument, targetLots: 1 }] as const)
    assert.deepEqual([actionLines(moves, book, 'TCS'), whatIfOfActions(moves, book)], [[], []])
  }
  assert.ok(books[1]?.inputs.legs.some((l) => l.instrument === OFFSET_INSTRUMENT))
})

// ---- BookRisk: band and advice are one reading a minute ---------------------------------

function riskOver(view: BookView | null, q: Quotes) {
  const seen = { views: 0, version: 0, override: null as number | null }
  const risk = new BookRisk({
    bookView: async () => { seen.views++; return view },
    legs: { version: () => seen.version },
    bands: { get: async () => seen.override },
    master: () => M, quotes: q,
  })
  return { risk, seen }
}

test('BookRisk: the band and the advice are one reading, once a minute per book', async () => {
  const q = priced()
  const view = viewOf('TCS', SHORT_PUT, q, NOW, '2026-10-01')
  const { risk, seen } = riskOver(view, q)
  const band = await risk.band('ravi', 'TCS', NOW)
  const [a, b] = await Promise.all([risk.advice('ravi', 'TCS', NOW + 30_000), risk.advice('ravi', 'TCS', NOW + 59_999)])
  assert.equal(seen.views, 1, 'the board\'s band read warmed the advice')
  assert.equal(a, b)
  assert.equal(a?.band, band)
  assert.deepEqual([a?.status, a?.historyFrom, a?.computedAt, a?.lines], ['advice', '2026-10-01', NOW, ['Sell 2 lots TCS OCT 3500 CE']])
  seen.version = 1
  const c = await risk.advice('ravi', 'TCS', NOW + 59_999)
  assert.equal(seen.views, 2)
  assert.equal(c?.computedAt, NOW + 59_999)
  seen.override = 2
  const o = await risk.advice('ravi', 'TCS', NOW + 59_999)
  assert.equal(seen.views, 3)
  assert.equal(o?.band.source, 'override')
  assert.match(o?.notes[4] ?? '', /^Your band is overridden to 2 lots;/)
  await risk.advice('ravi', 'TCS', NOW + 120_000)
  assert.equal(seen.views, 4)
})

test('BookRisk.advice: no open book is null', async () => {
  const q = priced()
  assert.equal(await riskOver(null, q).risk.advice('ravi', 'TCS', NOW), null)
  const dead = priced(NOW, { feedAlive: false })
  const c = await riskOver(viewOf('TCS', SHORT_PUT, dead), dead).risk.advice('ravi', 'TCS', NOW)
  assert.deepEqual([c?.status, c?.headline, c?.band.state], ['unavailable', 'No advice: the market data feed is dead', 'unknown'])
})

test('a throw in the advice step costs the card, never the band beside it', () => {
  const q = priced()
  const view = viewOf('TCS', SHORT_PUT, q, NOW, '2026-10-01')
  const book = engineBookFor(M, q, view, 'ravi', NOW)
  assert.ok(!('blocked' in book))
  // decide() reads the repair hold once in session; the corridor never does
  const inputs = { ...book.inputs }
  Object.defineProperty(inputs, 'repairHold', { get: () => { throw new Error('boom') } })
  const r = readingOf({ ...book, inputs }, view, null, true, NOW)
  assert.deepEqual([r.band.state, r.band.netDelta], [bandOf(book, 'TCS', null, true, true).state, bandOf(book, 'TCS', null, true, true).netDelta])
  assert.equal(r.band.state, 'out')
  assert.deepEqual([r.advice.status, r.advice.headline, r.advice.lines, r.advice.whatIf, r.advice.band, r.advice.historyFrom],
    ['unavailable', 'No advice: boom', [], [], r.band, '2026-10-01'])
  assert.deepEqual(r.advice.notes, card(book, { historyFrom: '2026-10-01' }).notes)
  // untouched, the same reading is the card BookRisk gives
  assert.equal(readingOf(book, view, null, true, NOW).advice.status, 'advice')
})
