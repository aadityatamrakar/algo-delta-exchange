/** The results-event risk (risk spec R10–R13), pure: reactions, implied move, verdict, outcomes, and the vol cue. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import type { DailyBar } from '../src/analytics/context-wire.ts'
import {
  DEFAULT_CRUSH_PTS, eventRiskRow, holdsThrough, impliedMoveOf, median, outcomeInstant, pastReactions, rankedNear, resultsCue, sortRows,
  verdictOf, type EventRowInput,
} from '../src/analytics/event-risk.ts'
import type { EventRiskRow } from '../src/analytics/risk-wire.ts'
import { priceBook } from '../src/analytics/snapshot.ts'
import { straddleMove } from '../src/routes/events.ts'
import { volRowOf } from '../src/routes/vol.ts'
import type { TraderLeg } from '../src/types.ts'
import { NOV, OCT, DEC, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'

const bar = (date: string, close: number, atmIv: number | null = 0.3): DailyBar =>
  ({ date, open: close, high: close, low: close, close, volume: 0, futClose: null, futOi: null, ceOi: null, peOi: null, atmIv, maxPain: null })
const near = (a: number | null, b: number, eps = 1e-9): void => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('a reaction runs from the last bar before the date to the first after it: across a weekend, a holiday and a missing day', () => {
  const bars = [
    bar('2026-09-09', 100), bar('2026-09-10', 101), /* 09-11 missing */ bar('2026-09-14', 95.95, 0.25),
    bar('2026-10-15', 200, 0.4), bar('2026-10-16', 210, null), /* weekend */ bar('2026-10-19', 189, 0.3),
    /* 10-20 Dussehra */ bar('2026-10-21', 180, 0.2),
  ]
  const r = pastReactions(bars, ['2026-09-10', '2026-10-16', '2026-10-20', '2026-10-20', '2026-10-21', '2026-08-01'])
  assert.deepEqual(r.map((x) => x.date), ['2026-09-10', '2026-10-16', '2026-10-20'], 'no bar after 10-21, none before 08-01; a date twice counts once')
  // results on Thu 10 Sep: Wed's close → Mon's (Friday's file is missing); its own day's bar is inside the move
  near(r[0]!.move, 95.95 / 100 - 1, 1e-6)
  assert.deepEqual([r[0]!.ivBefore, r[0]!.ivAfter, r[0]!.crushPts], [0.3, 0.25, -5])
  // results on Fri 16 Oct: Thu → Mon across the weekend; Friday's IV unknown does not matter, Thursday's and Monday's do
  near(r[1]!.move, 189 / 200 - 1, 1e-6)
  assert.deepEqual([r[1]!.ivBefore, r[1]!.ivAfter, r[1]!.crushPts], [0.4, 0.3, -10])
  // on the Dussehra holiday: Mon → Wed
  near(r[2]!.move, 180 / 189 - 1, 1e-6)
  assert.equal(r[2]!.crushPts, -10)
})

test('crush only when both IVs are known', () => {
  const r = pastReactions([bar('2026-10-15', 100, null), bar('2026-10-19', 104, 0.2), bar('2026-10-21', 100, 0.3), bar('2026-10-22', 100, null)], ['2026-10-16', '2026-10-21'])
  assert.deepEqual(r.map((x) => [x.ivBefore, x.ivAfter, x.crushPts]), [[null, 0.2, null], [0.2, null, null]])
})

test('verdict: rich at 1.25 and above, cheap at 0.8 and below, else fair; unknown with no ratio', () => {
  assert.deepEqual([1.25, 1.2499, 0.8001, 0.8, 0.5, 3].map(verdictOf), ['rich', 'fair', 'fair', 'cheap', 'cheap', 'rich'])
  assert.equal(verdictOf(null), 'unknown')
  assert.equal(impliedMoveOf(60, 40, 2000), 0.05)
  assert.equal(impliedMoveOf(60, null, 2000), null)
  assert.equal(impliedMoveOf(60, 40, 0), null)
  assert.deepEqual([median([3, 1, 2]), median([4, 1, 3, 2]), median([])], [2, 2.5, null])
})

test('the outcome instant is 09:15 IST on the first trading day after the results: Monday after a Friday, past a holiday', () => {
  assert.deepEqual(outcomeInstant('2026-10-23'), { date: '2026-10-26', ms: Date.parse('2026-10-26T09:15:00+05:30') })
  assert.deepEqual(outcomeInstant('2026-10-24'), { date: '2026-10-26', ms: Date.parse('2026-10-26T09:15:00+05:30') }, 'a Saturday meeting')
  assert.equal(outcomeInstant('2026-10-19')?.date, '2026-10-21', 'Monday 19 Oct: Tuesday is Dussehra')
  assert.equal(outcomeInstant('nope'), null)
})

test('the vol cue: the series that carries the results, and inNear when the ranked near IV includes them', () => {
  const listed = [OCT, NOV, DEC]
  const today = '2026-10-24'
  assert.equal(rankedNear(listed, today), NOV, '27 Oct is 3 days out: the ranked tenor is November')
  const cue = (date: string, purpose = 'Financial Results') => resultsCue([{ date: '2026-07-10', purpose }, { date, purpose }], today, listed, NOV)
  // MARUTI on 24 Oct: results on the 27 Oct expiry — the October series carries them, and November's ranked IV includes them
  assert.deepEqual(cue('2026-10-27'), { date: '2026-10-27', expiry: OCT, inNear: true })
  assert.deepEqual(cue('2026-10-28'), { date: '2026-10-28', expiry: NOV, inNear: true })
  assert.deepEqual(cue('2026-11-25'), { date: '2026-11-25', expiry: DEC, inNear: false })
  assert.deepEqual(cue('2027-01-15'), { date: '2027-01-15', expiry: null, inNear: false })
  assert.equal(cue('2026-10-27', 'Fund Raising'), null, 'only results meetings')
  assert.equal(resultsCue([{ date: '2026-10-27', purpose: 'Financial Results' }], today, listed, null)?.inNear, false, 'no near expiry known')
  assert.equal(holdsThrough([{ instrument: 'option', expiry: OCT, qty: -175 }], '2026-10-28'), false)
  assert.equal(holdsThrough([{ instrument: 'option', expiry: OCT, qty: 0 }, { instrument: 'share', expiry: '', qty: 10 }], '2026-10-28'), true)
  assert.equal(holdsThrough([{ instrument: 'future', expiry: NOV, qty: 175 }], '2026-10-28'), true)
})

test('the vol row carries the results, against its own near expiry', () => {
  const d = {
    vol: { days: () => [], status: () => ({ files: 0, latest: null, problems: [] }) }, bars: () => [], calendar: { upcoming: () => [{ date: '2026-10-27', purpose: 'Financial Results/Dividend' }] },
    expiries: () => [OCT, NOV, DEC],
  }
  assert.deepEqual(volRowOf(d, 'MARUTI', '2026-10-24').results, { date: '2026-10-27', expiry: OCT, inNear: true })
  assert.equal(volRowOf({ vol: d.vol, bars: d.bars }, 'MARUTI', '2026-10-24').results, undefined, 'no calendar wired: no field')
  assert.equal(volRowOf({ ...d, calendar: { upcoming: () => [] } }, 'MARUTI', '2026-10-24').results, null)
})

// ---- a priced book --------------------------------------------------------------------------

const NOW = Date.parse('2026-10-23T11:00:00+05:30')   // Friday, in session
const TCS_SPOT = 2953217
const leg = (strike: number, optType: 'CE' | 'PE', qty: number, avgPrice: number, expiry = NOV): TraderLeg => ({
  trader: 'ravi', stock: 'TCS', instrument: 'option', expiry, strike, optType, qty, avgPrice, clientCode: 'C1', source: 'odin',
  key: `C1|option|TCS|${expiry}|${strike}|${optType}`, token: null, note: '', updatedAt: 0,
})

function market() {
  const m = r3Master()
  const q = fakeQuotes()
  q.set(TCS_SPOT, { price: 3400, asOf: NOW })
  q.set(1002, { price: 3410, asOf: NOW })   // the November future
  priceChain(q, m, 'TCS', NOV, 3410, 0.3, NOW)
  priceChain(q, m, 'TCS', OCT, 3405, 0.32, NOW)
  return { m, q }
}

/** A short November straddle at 3400. */
function book(legs: readonly TraderLeg[] = [leg(3400, 'CE', -175, 150), leg(3400, 'PE', -175, 140)]) {
  const { m, q } = market()
  const s = priceBook('ravi', 'TCS', legs, { master: () => m, quotes: q, now: () => NOW })
  return { m, q, s, legs }
}

const results = (n: number): DailyBar[] => {
  // n quarters of reactions: −4%, +6%, −5%, … with a 4-point crush each
  const out: DailyBar[] = []
  const days = [['2026-01-12', '2026-01-14'], ['2026-04-09', '2026-04-13'], ['2026-07-08', '2026-07-10'], ['2026-09-08', '2026-09-10']]
  const moves = [-0.04, 0.06, -0.05, 0.05]
  for (let i = 0; i < n; i++) {
    const [pre, post] = days[i] as [string, string]
    out.push(bar(pre, 100, 0.3), bar(post, 100 * (1 + (moves[i] as number)), 0.26))
  }
  return out
}
const MEETINGS = ['2026-01-13', '2026-04-10', '2026-07-09', '2026-09-09'].map((date) => ({ date, purpose: 'Financial Results' }))

function row(o: Partial<EventRowInput> & { readonly n?: number } = {}): EventRiskRow {
  const b = book()
  const n = o.n ?? 4
  return eventRiskRow({
    stock: 'TCS', today: '2026-10-23', upcoming: [{ date: '2026-11-06', purpose: 'Financial Results' }], past: MEETINGS.slice(0, n),
    bars: results(n), expiries: [OCT, NOV, DEC], legs: b.legs,
    implied: (e) => straddleMove(b.m, b.q, b.s, 'TCS', e, NOW), snapshot: b.s, ...o,
  })
}

test('a results row: past reactions, implied move off the held month\'s straddle, ratio and verdict, five outcomes', () => {
  const r = row()
  assert.deepEqual(r.next, { date: '2026-11-06', purpose: 'Financial Results', days: 14, expiry: NOV, inNear: true, heldThrough: true })
  assert.deepEqual(r.past.map((p) => p.move), [-0.04, 0.06, -0.05, 0.05])
  near(r.pastAbsMean, 0.05, 1e-6)
  near(r.pastAbsMedian, 0.05, 1e-6)
  assert.equal(r.crushMeanPts, -4)
  // the November ATM straddle at the strike nearest the 3410 future (3400): its mid ÷ the future
  const t = yearsToExpiry(NOV, NOW)
  const leg1 = (type: 'CE' | 'PE') => b76Price({ future: 3410, strike: 3400, t, vol: 0.3, rate: DEFAULT_RATE, type })
  near(r.impliedMove, (leg1('CE') + leg1('PE')) / 3410, 1e-6)
  near(r.ratio, Math.round(((leg1('CE') + leg1('PE')) / 3410 / 0.05) * 100) / 100, 1e-9)
  assert.equal(r.verdict, verdictOf(r.ratio))
  assert.equal(r.provisional, false)
  assert.deepEqual(r.outcomes.map((o) => [o.label, o.move, o.volPts]),
    [['down-big', -0.075, -4], ['down', -0.05, -4], ['crush-only', 0, -4], ['up', 0.05, -4], ['up-big', 0.075, -4]])
  const ch = Object.fromEntries(r.outcomes.map((o) => [o.label, o.change as number]))  // a short straddle: the crush alone (and the decay to the morning after) gains; a big move either way loses more than a mean one
  assert.ok(ch['crush-only']! > 0, JSON.stringify(ch))
  assert.ok(ch['down-big']! < ch['down']! && ch['up-big']! < ch['up']!, JSON.stringify(ch))
  assert.ok(ch['down']! < ch['crush-only']! && ch['up']! < ch['crush-only']!, JSON.stringify(ch))
})

test('provisional with 2 reactions; the default crush when under 2 have one; no outcomes when the book expires before the date', () => {
  const two = row({ n: 2 })
  assert.equal(two.past.length, 2)
  assert.equal(two.provisional, true)
  assert.ok(two.warnings.includes('2 past reactions: provisional (3 are wanted)'), two.warnings.join(' | '))
  assert.equal(two.outcomes.length, 5)
  assert.equal(two.outcomes[0]!.volPts, -4, 'two reactions with a crush: their mean')

  const oneIv = row({ n: 2, bars: [...results(2).slice(0, 3), bar('2026-04-13', 106, null)] })
  assert.deepEqual(oneIv.outcomes.map((o) => o.volPts), Array(5).fill(DEFAULT_CRUSH_PTS))
  assert.equal(oneIv.crushMeanPts, -4)

  const notResults = row({ upcoming: [{ date: '2026-11-06', purpose: 'Fund Raising' }] })
  assert.equal(notResults.provisional, true)

  // October legs only: the book is gone by 6 Nov
  const b = book([leg(3400, 'CE', -175, 120, OCT)])
  const oct = row({ legs: b.legs, snapshot: b.s })
  assert.equal(oct.next?.heldThrough, false)
  assert.deepEqual(oct.outcomes, [])
})

test('legs that settle on or before the results date are left out of the outcomes (review: Oct shorts, Nov longs, results 28 Oct)', () => {
  const nov = [leg(3400, 'CE', 175, 150), leg(3400, 'PE', 175, 140)]
  const both = book([leg(3400, 'CE', -350, 120, OCT), leg(3400, 'PE', -350, 110, OCT), ...nov])
  const novOnly = book(nov)
  const upcoming = [{ date: '2026-10-28', purpose: 'Financial Results' }]
  const r = row({ upcoming, legs: both.legs, snapshot: both.s })
  const ref = row({ upcoming, legs: novOnly.legs, snapshot: novOnly.s })
  assert.equal(r.next?.heldThrough, true)
  assert.equal(r.outcomes.length, 5)
  assert.deepEqual(r.outcomes.map((o) => o.change), ref.outcomes.map((o) => o.change))
  assert.ok(r.warnings.some((w) => w.startsWith('legs of ') && w.includes('left out of the outcomes')), r.warnings.join(' | '))
  // a result on the October expiry day: those legs settle that afternoon, so they are out too, and the warning says why
  const onExpiry = row({ upcoming: [{ date: OCT, purpose: 'Financial Results' }], legs: both.legs, snapshot: both.s })
  assert.deepEqual(onExpiry.outcomes.map((o) => o.change), row({ upcoming: [{ date: OCT, purpose: 'Financial Results' }], legs: novOnly.legs, snapshot: novOnly.s }).outcomes.map((o) => o.change))
  assert.ok(onExpiry.warnings.some((w) => w.includes('on or before the results') && w.includes('in the session')), onExpiry.warnings.join(' | '))
})

test('with no past reaction the implied move is the outcome move; with neither there are none; no date, no next', () => {
  const r = row({ n: 0, bars: [], past: [] })
  assert.equal(r.pastAbsMean, null)
  assert.equal(r.ratio, null)
  assert.equal(r.verdict, 'unknown')
  near(r.outcomes.find((o) => o.label === 'up')!.move, r.impliedMove as number, 1e-6)
  assert.ok(r.warnings.some((w) => w.startsWith('no past reaction: the outcomes move the implied')), r.warnings.join(' | '))

  const none = row({ n: 0, bars: [], past: [], implied: () => ({ move: null, warning: 'no quote' }) })
  assert.deepEqual(none.outcomes, [])
  assert.ok(none.warnings.includes('no past reaction and no implied move: no outcomes'))

  const nothing = row({ upcoming: [] })
  assert.equal(nothing.next, null)
  assert.deepEqual(nothing.outcomes, [])
  assert.equal(nothing.past.length, 4, 'the past reactions are still read')
})

test('the implied move off live quotes for a month the book does not hold: mid when both sides are quoted, else LTP', () => {
  const { m, q, s } = book()
  const t = yearsToExpiry(OCT, NOW)
  const at = (type: 'CE' | 'PE') => b76Price({ future: 3405, strike: 3400, t, vol: 0.32, rate: DEFAULT_RATE, type })
  // October's own future is not quoted in the fixture: the parity forward, said
  const live = straddleMove(m, q, s, 'TCS', OCT, NOW)
  assert.ok(live.move !== null && Math.abs(live.move - (at('CE') + at('PE')) / 3405) < 2e-3, JSON.stringify(live))
  assert.match(live.warning ?? '', /future is not quoted/)
  q.set(1001, { price: 3405, asOf: NOW })
  const ce = m.options.resolve('TCS', OCT, 3400, 'CE')!.instrumentToken as number
  q.set(ce, { price: 99, bid: 0, ask: 101 })   // one side missing: the LTP
  const ltp = straddleMove(m, q, s, 'TCS', OCT, NOW)
  near(ltp.move, (99 + at('PE')) / 3405, 1e-9)
  assert.equal(ltp.warning, null)
  q.set(ce, { price: 0, bid: null, ask: null })
  assert.match(straddleMove(m, q, s, 'TCS', OCT, NOW).warning ?? '', /no quote for the 27 Oct 3400 CE/)
})

test('rows with a date come first, soonest first, then the rest by stock', () => {
  const r = (stock: string, date: string | null) => ({ stock, next: date === null ? null : { date } }) as unknown as EventRiskRow
  assert.deepEqual(sortRows([r('A', null), r('Z', '2026-11-01'), r('B', '2026-10-27'), r('C', '2026-10-27'), r('AA', null)]).map((x) => x.stock),
    ['B', 'C', 'Z', 'A', 'AA'])
})
