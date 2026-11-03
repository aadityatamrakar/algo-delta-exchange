/**
 * The results-event risk of one held book (`EventRiskRow`, risk spec R10–R12), pure: the stock's past results
 * reactions measured from its daily bars, the move the market implies to the series that carries the next results,
 * and what the book would change by on the first morning after them.
 *
 * - Past reactions (R10): for each past results date d inside the bars, pre = the last bar before d and post = the
 *   first bar after d (so a weekend, a holiday or a missing day between them is spanned, and an announcement in or
 *   after d's session is inside the move). move = post.close ÷ pre.close − 1; crush = (post.atmIv − pre.atmIv) × 100
 *   vol points when both IVs are known.
 * - Implied move (R11): (ATM CE + ATM PE) ÷ the future of the series, read by the caller; ratio = implied ÷ the past
 *   mean |move|; rich ≥ 1.25, cheap ≤ 0.8, else fair. The straddle covers the whole time to its expiry, not just the
 *   event, so a far expiry reads rich (the page says so).
 * - Outcomes (R12), only when the book holds through the date: the stock moving ±mean |move| and ±1.5 × it, and the
 *   vol crush alone, each with the mean crush (−5 points when under 2 reactions have one), valued at 09:15 IST on the
 *   first NSE trading day after d, against the book's value now (`shockBook`, a full reprice).
 *
 * "Near" (`inNear`, the vol cue of R13) is the tenor the Vol page ranks: the first listed expiry at least
 * IV_TENOR_DAYS out. Its IV includes the event when the results fall on or before that expiry, which is what
 * inNear says (a result in a series shorter than the tenor is inside the ranked IV too).
 */

import type { ValuationPoint } from '@algomaker/payoff'
import type { DailyBar } from './context-wire.ts'
import type { EventDate } from '../market/events-store.ts'
import { nextTradingDay } from './calendar.ts'
import { IV_TENOR_DAYS, daysTo, shortDate } from './levels.ts'
import type { EventOutcome, EventRiskRow, PastReaction } from './risk-wire.ts'
import { shockBook } from './shock.ts'
import type { BookSnapshot } from './snapshot.ts'
import type { TraderLeg } from '../types.ts'

/** NSE's purpose text for a results meeting ("Financial Results", "Financial Results/Dividend", …). */
export const RESULTS_RE = /financial results/i
export const RICH_AT = 1.25
export const CHEAP_AT = 0.8
/** Under this many past reactions a row is provisional. */
export const MIN_REACTIONS = 3
/** The mean crush is used from this many reactions that have one; else DEFAULT_CRUSH_PTS. */
export const MIN_CRUSH = 2
export const DEFAULT_CRUSH_PTS = -5
/** The "big" outcomes move this many times the mean |move|. */
export const BIG = 1.5
/** 09:15 IST as a UTC clock (IST is UTC+05:30). */
const OPEN_UTC = '03:45:00Z'

export const PROVISIONAL_FEW = (n: number): string => `${n} past ${n === 1 ? 'reaction' : 'reactions'}: provisional (${MIN_REACTIONS} are wanted)`

const isResults = (purpose: string): boolean => RESULTS_RE.test(purpose)
const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x)
const r2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100)
const r6 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e6) / 1e6)
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

/** Each past results date with a bar before and a bar after it, oldest first; a date given twice counts once. */
export function pastReactions(bars: readonly DailyBar[], dates: readonly string[]): PastReaction[] {
  const out: PastReaction[] = []
  for (const d of [...new Set(dates)].sort()) {
    let pre: DailyBar | undefined
    let post: DailyBar | undefined
    for (const b of bars) {
      if (b.date < d) pre = b
      else if (b.date > d) { post = b; break }
    }
    if (pre === undefined || post === undefined || !(pre.close > 0) || !(post.close > 0)) continue
    const ivBefore = finite(pre.atmIv) ? pre.atmIv : null
    const ivAfter = finite(post.atmIv) ? post.atmIv : null
    out.push({
      date: d, move: r6(post.close / pre.close - 1) as number, ivBefore, ivAfter,
      crushPts: ivBefore !== null && ivAfter !== null ? r2((ivAfter - ivBefore) * 100) : null,
    })
  }
  return out
}

export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] as number : ((s[m - 1] as number) + (s[m] as number)) / 2
}

export function verdictOf(ratio: number | null): EventRiskRow['verdict'] {
  if (ratio === null) return 'unknown'
  return ratio >= RICH_AT ? 'rich' : ratio <= CHEAP_AT ? 'cheap' : 'fair'
}

/** (CE + PE) ÷ future, decimal; null unless all three are positive. */
export function impliedMoveOf(ce: number | null, pe: number | null, future: number | null): number | null {
  return finite(ce) && finite(pe) && finite(future) && ce > 0 && pe > 0 && future > 0 ? (ce + pe) / future : null
}

/** The instant an outcome is valued at: 09:15 IST on the first NSE trading day after `date`; null for a bad date. */
export function outcomeInstant(date: string): ValuationPoint | null {
  const day = nextTradingDay(date)
  return day === '' ? null : { date: day, ms: Date.parse(`${day}T${OPEN_UTC}`) }
}

/** The tenor the Vol page ranks: the first listed expiry at least IV_TENOR_DAYS calendar days after `today`. */
export function rankedNear(expiries: readonly string[], today: string): string | null {
  return [...expiries].sort().find((e) => daysTo(today, e) >= IV_TENOR_DAYS) ?? null
}

/** The first board meeting on or after `today`; null = none known. */
export function nextEvent(upcoming: readonly EventDate[], today: string): EventDate | null {
  return [...upcoming].sort((a, b) => a.date.localeCompare(b.date)).find((e) => e.date >= today) ?? null
}

/**
 * The next results of a stock as the vol cue reads it (`VolRow.results`, `MarketContext.results`): its date, the first
 * listed expiry on or after it (the series that carries it), and whether the ranked near IV includes it.
 * `near` = the near expiry the IV is ranked on (null = unknown: then never inNear).
 */
export function resultsCue(
  upcoming: readonly EventDate[], today: string, expiries: readonly string[], near: string | null,
): { readonly date: string; readonly expiry: string | null; readonly inNear: boolean } | null {
  const next = nextEvent(upcoming.filter((e) => isResults(e.purpose)), today)
  if (next === null) return null
  return { date: next.date, expiry: [...expiries].sort().find((e) => e >= next.date) ?? null, inNear: near !== null && near >= today && next.date <= near }
}

/** A leg that is still open on `date`: a share, or an option or future of an expiry on or after it. */
export function holdsThrough(legs: readonly Pick<TraderLeg, 'instrument' | 'expiry' | 'qty'>[], date: string): boolean {
  return legs.some((l) => l.qty !== 0 && (l.instrument === 'share' || l.expiry >= date))
}

const LABELS: readonly { readonly label: EventOutcome['label']; readonly k: number }[] = [
  { label: 'down-big', k: -BIG }, { label: 'down', k: -1 }, { label: 'crush-only', k: 0 }, { label: 'up', k: 1 }, { label: 'up-big', k: BIG },
]

/**
 * The five outcomes of a results date on a book (R12). `move` = the past mean |move|, else the implied move (warned);
 * with neither there are none. `crush` = the mean crush and how many reactions had one.
 */
export function eventOutcomes(
  s: BookSnapshot, date: string, o: { readonly pastAbsMean: number | null; readonly impliedMove: number | null; readonly crushMeanPts: number | null; readonly crushCount: number },
): { readonly outcomes: readonly EventOutcome[]; readonly warnings: readonly string[] } {
  const warnings: string[] = []
  let m = o.pastAbsMean
  if (m === null) {
    if (o.impliedMove === null) return { outcomes: [], warnings: ['no past reaction and no implied move: no outcomes'] }
    m = o.impliedMove
    warnings.push(`no past reaction: the outcomes move the implied ${pct(m)}`)
  }
  let volPts = DEFAULT_CRUSH_PTS
  if (o.crushCount >= MIN_CRUSH && o.crushMeanPts !== null) volPts = o.crushMeanPts
  else warnings.push(`${o.crushCount} past ${o.crushCount === 1 ? 'reaction has' : 'reactions have'} an IV on both days: the outcomes take a ${DEFAULT_CRUSH_PTS}-point crush`)
  const at = outcomeInstant(date)
  if (at === null) return { outcomes: [], warnings: [...warnings, `${date} is not a date: no outcomes`] }
  const move = m
  // a leg of an expiry on or before the results date settles before the outcome instant: the results never move it
  // (on an expiry-day result an in-session announcement would, which the warning says), so it is left out
  const settled = [...new Set(s.legs.filter((l) => l.leg.instrument !== 'share' && l.leg.expiry <= date).map((l) => l.leg.expiry))].sort()
  if (settled.length > 0) {
    const on = settled.includes(date)
    warnings.push(`legs of ${settled.map((e) => shortDate(e)).join(', ')} expire ${on ? 'on or ' : ''}before the results: left out of the outcomes${on ? ' (an announcement in the session would move them)' : ''}`)
  }
  const after: BookSnapshot = settled.length === 0 ? s : { ...s, legs: s.legs.filter((l) => l.leg.instrument === 'share' || l.leg.expiry > date) }
  if (after.legs.length === 0) return { outcomes: [], warnings: [...warnings, 'no leg is open after the results: no outcomes'] }
  const shocked = shockBook(after, LABELS.map(({ k }) => ({ spotFactor: 1 + k * move, volPts, at })))
  warnings.push(...shocked.warnings)
  const outcomes = LABELS.map(({ label, k }, i): EventOutcome => ({
    label, move: r6(k * move) as number, volPts: r2(volPts) as number, change: r2(shocked.changes[i] ?? null),
  }))
  return { outcomes, warnings }
}

export interface EventRowInput {
  readonly stock: string
  readonly today: string
  /** The calendar's coming and past board meetings of the stock (any purpose; reactions read the results ones). */
  readonly upcoming: readonly EventDate[]
  readonly past: readonly EventDate[]
  /** Daily bars, oldest → newest. */
  readonly bars: readonly DailyBar[]
  /** The stock's listed option expiries. */
  readonly expiries: readonly string[]
  /** The book's open legs (every trader's of the stock, for an admin's view). */
  readonly legs: readonly Pick<TraderLeg, 'instrument' | 'expiry' | 'qty'>[]
  /** The implied move of an expiry's ATM straddle, and why when null (the caller reads the quotes). */
  readonly implied: (expiry: string) => { readonly move: number | null; readonly warning: string | null }
  /** The book's minute snapshot; null = not priced (no outcomes). */
  readonly snapshot: BookSnapshot | null
}

export function eventRiskRow(i: EventRowInput): EventRiskRow {
  const warnings: string[] = []
  const ev = nextEvent(i.upcoming, i.today)
  const expiries = [...i.expiries].sort()
  const near = rankedNear(expiries, i.today)
  const series = ev === null ? null : expiries.find((e) => e >= ev.date) ?? null
  const heldThrough = ev !== null && holdsThrough(i.legs, ev.date)
  const next: EventRiskRow['next'] = ev === null ? null : {
    date: ev.date, purpose: ev.purpose, days: daysTo(i.today, ev.date), expiry: series,
    inNear: near !== null && ev.date <= near, heldThrough,
  }
  if (ev === null) warnings.push(`no coming board meeting of ${i.stock} in NSE's calendar`)
  else if (series === null) warnings.push(`no listed expiry on or after ${shortDate(ev.date)}: no implied move`)

  // reactions: every results date before today (a coming one the calendar has since passed counts too)
  const dates = [...i.past, ...i.upcoming].filter((e) => e.date < i.today && isResults(e.purpose)).map((e) => e.date)
  const past = pastReactions(i.bars, dates)
  const abs = past.map((r) => Math.abs(r.move))
  const crushes = past.flatMap((r) => (r.crushPts === null ? [] : [r.crushPts]))
  const pastAbsMean = mean(abs)
  const crushMeanPts = mean(crushes)
  if (dates.length > 0 && past.length < new Set(dates).size) {
    const n = new Set(dates).size - past.length
    warnings.push(`${n} past results ${n === 1 ? 'date has' : 'dates have'} no daily bar before or after it: left out`)
  }

  let impliedMove: number | null = null
  if (series !== null) {
    const im = i.implied(series)
    impliedMove = im.move
    if (im.warning !== null) warnings.push(im.warning)
  }
  const ratio = impliedMove !== null && pastAbsMean !== null && pastAbsMean > 0 ? impliedMove / pastAbsMean : null

  const notResults = ev !== null && !isResults(ev.purpose)
  const provisional = past.length < MIN_REACTIONS || notResults
  if (past.length < MIN_REACTIONS) warnings.push(PROVISIONAL_FEW(past.length))
  if (notResults) warnings.push(`the coming meeting's purpose is not plainly results ("${ev.purpose}"): provisional`)

  let outcomes: readonly EventOutcome[] = []
  if (ev !== null && heldThrough) {
    if (i.snapshot === null) warnings.push('the book is not priced: no outcomes')
    else {
      const o = eventOutcomes(i.snapshot, ev.date, { pastAbsMean, impliedMove, crushMeanPts, crushCount: crushes.length })
      outcomes = o.outcomes
      warnings.push(...o.warnings)
    }
  }

  return {
    stock: i.stock, next, impliedMove: r6(impliedMove), past,
    pastAbsMean: r6(pastAbsMean), pastAbsMedian: r6(median(abs)), crushMeanPts: r2(crushMeanPts),
    ratio: r2(ratio), verdict: verdictOf(ratio), provisional, outcomes, warnings: [...new Set(warnings)],
  }
}

/** Rows with a `next` first, soonest first (then by stock), then the rest by stock. */
export function sortRows(rows: readonly EventRiskRow[]): EventRiskRow[] {
  return [...rows].sort((a, b) => {
    if ((a.next === null) !== (b.next === null)) return a.next === null ? 1 : -1
    const d = a.next !== null && b.next !== null ? a.next.date.localeCompare(b.next.date) : 0
    return d !== 0 ? d : a.stock.localeCompare(b.stock)
  })
}
