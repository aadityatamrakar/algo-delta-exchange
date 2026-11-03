/**
 * Price levels, trend and volatility from the bars the app holds — pure, no
 * clock, no I/O. `analytics/context.ts` feeds it the daily history
 * (`market/history.ts`) and today's 5-minute bars (`market/intraday.ts`).
 *
 * WHY a fixed, written-down rule for every number: the assistant explains these
 * levels to a trader (spec §5, R2), so each one must be reproducible by hand
 * from the bars, and a level that the bars cannot support is left out — never
 * filled in. The rules:
 *
 *   SMA n        mean of the last n daily closes; null under n.
 *   ATR14        Wilder: the mean of the first 14 true ranges, then (prev × 13 + TR) / 14 over the rest.
 *   HV n         sample stdev of the last n close-to-close log returns × √252 (decimal); null under n + 1 closes.
 *   pivots       classic, off the last daily bar: P = (H+L+C)/3, R1 = 2P−L, S1 = 2P−H, R2 = P+(H−L),
 *                S2 = P−(H−L), R3 = H+2(P−L), S3 = L−2(H−P).
 *   swings       fractal: a high above the highs of the 2 bars either side (a low below the lows), within the
 *                last 60 bars; the 3 most recent of each.
 *   52 weeks     the high / low of the last 252 bars, only with ≥ 250 bars.
 *   round        a 1-2-5 step at or below price / 40 (2,505 → 50; 22,711 → 500; 357 → 5); the two round prices
 *                either side of the reference; one on a multiple of 10 steps is a major round (strength 2).
 *   OI           the near expiry's three largest call / put OI strikes (strength 3, 2, 1) and max pain.
 *   intraday     today's high, low, VWAP (Σ typical price × volume / Σ volume, typical = (h+l+c)/3) and the
 *                opening range (09:15–09:30) from 5-minute bars; open and opening range only when the bars
 *                start at the open.
 *   trend        up when close > SMA20 > SMA50 and the 20-day return > 0; down mirrored; else range; unknown
 *                under 50 bars.
 *   IV rank      (IV − min) / (max − min) × 100 over the year's daily ATM IVs; percentile = % of those days
 *                below today's IV; both need ≥ 60 days with an IV.
 *
 * Strength: each kind's base (`BASE_STRENGTH`); levels within 0.25% of the reference price of each other fold
 * into the stronger (ties: the kind listed first in `LevelKind`), their bases joined (a folded level at another
 * price named with it, "today's high at 3402"), and a level that absorbed
 * another gains 1, at most 3. Then the 24 nearest the reference are kept, sorted by price.
 */

import type { Bar, DailyBar, Level, LevelKind, MarketContext } from './context-wire.ts'

export const MAX_LEVELS = 24
/** Levels closer than this fraction of the reference price are one level. */
export const MERGE_WITHIN = 0.0025
export const IV_RANK_MIN_DAYS = 60
/**
 * The tenor every ranked IV is of: the ATM of the first expiry at least this many calendar days out (span_job's
 * `ivAtm`, the vol job's near expiry, the context's live IV), so neither an expiry-eve option nor an index's 1-day
 * weekly enters the series (vol addendum).
 */
export const IV_TENOR_DAYS = 7

/** Calendar days from `day` to `expiry`, both YYYY-MM-DD. */
export const daysTo = (day: string, expiry: string): number => Math.round((Date.parse(expiry) - Date.parse(day)) / 86_400_000)
/** A trading year of daily IVs behind the rank, and of bars behind the 52-week high/low. */
export const YEAR_BARS = 252
export const WEEKS52_MIN_BARS = 250
export const TREND_MIN_BARS = 50
export const SWING_WINDOW = 2
export const SWING_LOOKBACK = 60
export const SWINGS_KEPT = 3
export const ATR_DAYS = 14
const OPENING_RANGE_MS = 15 * 60_000

/** Every kind in the wire's order: the tie-break when two equally strong levels fold into one. */
export const KIND_ORDER: readonly LevelKind[] = [
  'prev-high', 'prev-low', 'prev-close', 'pivot', 'r1', 'r2', 'r3', 's1', 's2', 's3', 'swing-high', 'swing-low',
  '52w-high', '52w-low', 'sma20', 'sma50', 'sma200', 'round', 'oi-call-wall', 'oi-put-wall', 'max-pain',
  'day-high', 'day-low', 'vwap', 'or-high', 'or-low',
]

/** A kind's strength before any fold. A round number on a major step and the 2nd/3rd OI wall are set where made. */
export const BASE_STRENGTH: Readonly<Record<LevelKind, 1 | 2 | 3>> = {
  'prev-high': 2, 'prev-low': 2, 'prev-close': 1, pivot: 2, r1: 2, s1: 2, r2: 1, s2: 1, r3: 1, s3: 1,
  'swing-high': 2, 'swing-low': 2, '52w-high': 3, '52w-low': 3, sma20: 1, sma50: 2, sma200: 3, round: 1,
  'oi-call-wall': 3, 'oi-put-wall': 3, 'max-pain': 2, 'day-high': 2, 'day-low': 2, vwap: 2, 'or-high': 1, 'or-low': 1,
}

export type Trend = MarketContext['trend']
export type DayStats = MarketContext['day'] & {
  /** The bars do not start at the open (the app began sampling later): no open, no opening range. */
  readonly partial: boolean
}
export interface IvStats { readonly ivRank: number | null; readonly ivPercentile: number | null; readonly ivDays: number }
export interface Pivots { readonly p: number; readonly r1: number; readonly s1: number; readonly r2: number; readonly s2: number; readonly r3: number; readonly s3: number }
export interface Swing { readonly price: number; readonly date: string }
/** A level before folding: no distance yet. */
export interface Candidate { readonly price: number; readonly kind: LevelKind; readonly strength: 1 | 2 | 3; readonly basis: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
/** '2026-10-22' → '22 Oct'. */
export function shortDate(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? '?'}`
}

const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x)
export const round2 = (x: number): number => Math.round(x * 100) / 100
/** Clear of float dust (0.1 + 0.2), for prices made by arithmetic on steps. */
const clean = (x: number): number => Math.round(x * 1e6) / 1e6

export function sma(closes: readonly number[], n: number): number | null {
  if (n < 1 || closes.length < n) return null
  let sum = 0
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i] as number
  return sum / n
}

export function atr(bars: readonly Pick<DailyBar, 'high' | 'low' | 'close'>[], n: number = ATR_DAYS): number | null {
  if (n < 1 || bars.length < n + 1) return null
  const tr: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i] as DailyBar
    const prev = (bars[i - 1] as DailyBar).close
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev)))
  }
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + (tr[i] as number)) / n
  return a
}

export function hv(closes: readonly number[], n: number): number | null {
  if (n < 2 || closes.length < n + 1) return null
  const r: number[] = []
  for (let i = closes.length - n; i < closes.length; i++) {
    const a = closes[i - 1] as number
    const b = closes[i] as number
    if (!(a > 0 && b > 0)) return null
    r.push(Math.log(b / a))
  }
  const mean = r.reduce((x, y) => x + y, 0) / n
  const variance = r.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)
  return Math.sqrt(variance) * Math.sqrt(252)
}

export function pivotsOf(prev: { readonly high: number; readonly low: number; readonly close: number }): Pivots {
  const { high: h, low: l, close: c } = prev
  const p = (h + l + c) / 3
  return { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l), r3: h + 2 * (p - l), s3: l - 2 * (h - p) }
}

export function swingsOf(
  bars: readonly DailyBar[], window: number = SWING_WINDOW, lookback: number = SWING_LOOKBACK,
): { readonly highs: readonly Swing[]; readonly lows: readonly Swing[] } {
  const xs = bars.slice(-lookback)
  const highs: Swing[] = []
  const lows: Swing[] = []
  for (let i = xs.length - 1 - window; i >= window; i--) {
    const b = xs[i] as DailyBar
    let high = true
    let low = true
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue
      const o = xs[j] as DailyBar
      if (o.high >= b.high) high = false
      if (o.low <= b.low) low = false
    }
    if (high && highs.length < SWINGS_KEPT) highs.push({ price: b.high, date: b.date })
    if (low && lows.length < SWINGS_KEPT) lows.push({ price: b.low, date: b.date })
  }
  return { highs, lows }
}

/** The 1-2-5 step at or below price / 40. */
export function roundStepOf(price: number): number {
  const target = price / 40
  if (!(target > 0)) return 1
  const mag = 10 ** Math.floor(Math.log10(target))
  for (const m of [5, 2, 1]) if (m * mag <= target * (1 + 1e-9)) return clean(m * mag)
  return clean(mag)
}

export function trendOf(daily: readonly DailyBar[]): Trend {
  const c = daily.map((b) => b.close)
  const last = c.at(-1) ?? null
  const ret = (k: number): number | null => (c.length > k ? (last as number) / (c[c.length - 1 - k] as number) - 1 : null)
  const sma20 = sma(c, 20)
  const sma50 = sma(c, 50)
  const sma200 = sma(c, 200)
  const ret5d = ret(5)
  const ret20d = ret(20)
  const to = daily.at(-1)?.date
  if (c.length < TREND_MIN_BARS || last === null || sma20 === null || sma50 === null || ret20d === null) {
    return { label: 'unknown', sma20, sma50, sma200, ret5d, ret20d, basis: `${c.length} daily bars; a trend needs ${TREND_MIN_BARS}` }
  }
  const label = last > sma20 && sma20 > sma50 && ret20d > 0 ? 'up' : last < sma20 && sma20 < sma50 && ret20d < 0 ? 'down' : 'range'
  const pct = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
  return {
    label, sma20, sma50, sma200, ret5d, ret20d,
    basis: `close ${last.toFixed(2)}, SMA20 ${sma20.toFixed(2)}, SMA50 ${sma50.toFixed(2)}, 20-day return ${pct(ret20d)}`
      + ` (${c.length} daily bars to ${shortDate(to as string)}); up = close > SMA20 > SMA50 with a positive 20-day return`,
  }
}

/** `ivs`: the daily ATM IVs, oldest → newest (nulls skipped); only the last year's count. */
export function ivStatsOf(ivs: readonly (number | null)[], current: number | null): IvStats {
  const year = ivs.slice(-YEAR_BARS).filter((x): x is number => finite(x) && x > 0)
  const ivDays = year.length
  if (ivDays < IV_RANK_MIN_DAYS || !finite(current)) return { ivRank: null, ivPercentile: null, ivDays }
  const lo = Math.min(...year)
  const hi = Math.max(...year)
  const ivRank = hi > lo ? Math.min(100, Math.max(0, ((current - lo) / (hi - lo)) * 100)) : null
  const ivPercentile = (year.filter((x) => x < current).length / ivDays) * 100
  return { ivRank, ivPercentile, ivDays }
}

/**
 * Today's figures from 5-minute bars. `coveredFrom` is when the sampler began
 * today (null = never): bars that start after the open have no open and no
 * opening range. The opening range is only said once 09:30 has passed.
 */
export function dayStatsOf(bars: readonly Bar[], o: { readonly openMs: number; readonly coveredFrom: number | null; readonly nowMs: number }): DayStats {
  const partial = o.coveredFrom === null || o.coveredFrom > o.openMs
  if (bars.length === 0) return { open: null, high: null, low: null, vwap: null, orHigh: null, orLow: null, partial: true }
  let high = -Infinity
  let low = Infinity
  let pv = 0
  let vol = 0
  for (const b of bars) {
    high = Math.max(high, b.h)
    low = Math.min(low, b.l)
    if (b.v > 0) { pv += ((b.h + b.l + b.c) / 3) * b.v; vol += b.v }
  }
  const first = bars[0] as Bar
  const opening = bars.filter((b) => b.t >= o.openMs && b.t < o.openMs + OPENING_RANGE_MS)
  const orDone = !partial && o.nowMs >= o.openMs + OPENING_RANGE_MS && opening.length > 0
  return {
    open: !partial && first.t === o.openMs ? first.o : null,
    high, low,
    vwap: vol > 0 ? pv / vol : null,
    orHigh: orDone ? Math.max(...opening.map((b) => b.h)) : null,
    orLow: orDone ? Math.min(...opening.map((b) => b.l)) : null,
    partial,
  }
}

export interface LevelInput {
  /** The price distances are measured from: the spot, or the near future for an underlying whose bars are the future's. */
  readonly ref: number
  readonly daily: readonly DailyBar[]
  /** Today's figures; null when there are none or the daily history already holds today. */
  readonly day: DayStats | null
  readonly oi: {
    readonly expiry: string
    /** The end-of-day file the OI is from. */
    readonly day: string
    readonly callWalls: readonly (readonly [number, number])[]
    readonly putWalls: readonly (readonly [number, number])[]
    readonly maxPain: number | null
  } | null
}

function candidates(i: LevelInput): Candidate[] {
  const out: Candidate[] = []
  const add = (price: number | null | undefined, kind: LevelKind, basis: string, strength: 1 | 2 | 3 = BASE_STRENGTH[kind]): void => {
    if (finite(price) && price > 0) out.push({ price, kind, strength, basis })
  }
  const prev = i.daily.at(-1)
  if (prev !== undefined) {
    const on = shortDate(prev.date)
    add(prev.high, 'prev-high', `high of ${on}`)
    add(prev.low, 'prev-low', `low of ${on}`)
    add(prev.close, 'prev-close', `close of ${on}`)
    const p = pivotsOf(prev)
    add(p.p, 'pivot', `classic pivot off ${on}`)
    add(p.r1, 'r1', `classic R1 off ${on}`)
    add(p.r2, 'r2', `classic R2 off ${on}`)
    add(p.r3, 'r3', `classic R3 off ${on}`)
    add(p.s1, 's1', `classic S1 off ${on}`)
    add(p.s2, 's2', `classic S2 off ${on}`)
    add(p.s3, 's3', `classic S3 off ${on}`)
  }
  const sw = swingsOf(i.daily)
  for (const s of sw.highs) add(s.price, 'swing-high', `swing high on ${shortDate(s.date)} (beats ${SWING_WINDOW} bars either side, last ${SWING_LOOKBACK} bars)`)
  for (const s of sw.lows) add(s.price, 'swing-low', `swing low on ${shortDate(s.date)} (beats ${SWING_WINDOW} bars either side, last ${SWING_LOOKBACK} bars)`)
  if (i.daily.length >= WEEKS52_MIN_BARS) {
    const year = i.daily.slice(-YEAR_BARS)
    const hi = year.reduce((a, b) => (b.high > a.high ? b : a))
    const lo = year.reduce((a, b) => (b.low < a.low ? b : a))
    add(hi.high, '52w-high', `52-week high, ${shortDate(hi.date)}`)
    add(lo.low, '52w-low', `52-week low, ${shortDate(lo.date)}`)
  }
  const c = i.daily.map((b) => b.close)
  add(sma(c, 20), 'sma20', '20-day SMA of closes')
  add(sma(c, 50), 'sma50', '50-day SMA of closes')
  add(sma(c, 200), 'sma200', '200-day SMA of closes')
  const step = roundStepOf(i.ref)
  const k0 = Math.floor(i.ref / step + 1e-9)
  for (const k of [k0 - 1, k0, k0 + 1, k0 + 2]) {
    const price = clean(k * step)
    const major = Math.abs(price / (10 * step) - Math.round(price / (10 * step))) < 1e-9
    add(price, 'round', `round number (step ${step}${major ? ', major' : ''})`, major ? 2 : 1)
  }
  if (i.oi !== null) {
    const on = `${shortDate(i.oi.expiry)} expiry, ${shortDate(i.oi.day)} file`
    const rank = ['largest', '2nd largest', '3rd largest'] as const
    const strengthOf = [3, 2, 1] as const
    i.oi.callWalls.slice(0, 3).forEach(([k, oi], n) => add(k, 'oi-call-wall', `${rank[n]} call OI (${oi.toLocaleString('en-IN')}), ${on}`, strengthOf[n]))
    i.oi.putWalls.slice(0, 3).forEach(([k, oi], n) => add(k, 'oi-put-wall', `${rank[n]} put OI (${oi.toLocaleString('en-IN')}), ${on}`, strengthOf[n]))
    add(i.oi.maxPain, 'max-pain', `max pain, ${on}`)
  }
  if (i.day !== null) {
    const since = i.day.partial ? ' since the app began sampling' : ''
    add(i.day.high, 'day-high', `today's high${since}`)
    add(i.day.low, 'day-low', `today's low${since}`)
    add(i.day.vwap, 'vwap', `today's VWAP from 5-minute bars${since}`)
    add(i.day.orHigh, 'or-high', 'opening range high (09:15–09:30)')
    add(i.day.orLow, 'or-low', 'opening range low (09:15–09:30)')
  }
  return out
}

/** Folds levels within 0.25% of `ref` into the stronger, keeps the 24 nearest `ref`, sorted by price. */
export function mergeLevels(cands: readonly Candidate[], ref: number): readonly Level[] {
  const order = (k: LevelKind): number => KIND_ORDER.indexOf(k)
  const sorted = [...cands].sort((a, b) => b.strength - a.strength || order(a.kind) - order(b.kind) || a.price - b.price)
  const kept: { c: Candidate; bases: string[]; folded: number }[] = []
  const within = MERGE_WITHIN * ref
  for (const c of sorted) {
    const into = kept.find((k) => Math.abs(k.c.price - c.price) <= within)
    if (into === undefined) kept.push({ c, bases: [c.basis], folded: 0 })
    else {
      // a folded level at another price says its own, so the joined basis never blurs two prices into one
      into.bases.push(round2(c.price) === round2(into.c.price) ? c.basis : `${c.basis} at ${round2(c.price)}`)
      into.folded++
    }
  }
  const levels: Level[] = kept.map(({ c, bases, folded }) => ({
    price: round2(c.price),
    kind: c.kind,
    strength: (folded > 0 ? Math.min(3, c.strength + 1) : c.strength) as 1 | 2 | 3,
    distancePct: round2(((c.price - ref) / ref) * 100),
    basis: bases.join('; '),
  }))
  return levels
    .sort((a, b) => Math.abs(a.price - ref) - Math.abs(b.price - ref) || a.price - b.price)
    .slice(0, MAX_LEVELS)
    .sort((a, b) => a.price - b.price)
}

export function levelsOf(i: LevelInput): readonly Level[] {
  if (!(i.ref > 0)) return []
  return mergeLevels(candidates(i), i.ref)
}

/** The highest level below `ref` and the lowest above it. */
export function nearestOf(levels: readonly Level[], ref: number): { readonly support: Level | null; readonly resistance: Level | null } {
  let support: Level | null = null
  let resistance: Level | null = null
  for (const l of levels) {
    if (l.price < ref && (support === null || l.price > support.price)) support = l
    if (l.price > ref && (resistance === null || l.price < resistance.price)) resistance = l
  }
  return { support, resistance }
}
