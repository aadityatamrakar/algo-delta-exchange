/**
 * Volatility metrics for one stock, end of day: IV rank and percentile, HV10/HV20, the volatility risk premium
 * (ex-ante, its percentile, and realized), the near/next term structure and the 25-delta skew. Pure.
 * Spec: docs/superpowers/specs/2026-10-23-traders-vol-addendum.md.
 *
 * Inputs are the daily bars (data/nse/history, Lane 2's HistoryStore: closes and the bhavcopy-solved ATM IV) and
 * the chain snapshots (data/nse/vol, VolStore, each reduced by `summarizeChain`). A day's IV is its snapshot's
 * near-expiry ATM IV (the first expiry a week or more out) when there is one, else its bar's. Every figure needs the data under it; when it is short the
 * figure is null and a warning says what is missing. Nothing is rounded here.
 */

import { FNO_CLOSE_MIN } from '@algomaker/core'
import { b76Greeks, b76ImpliedVol, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import { atmIvOf } from '../market/history.ts'
import type { DailyBar, IvSource, RealizedVrp, VolMetrics } from './context-wire.ts'
import { IV_RANK_MIN_DAYS, YEAR_BARS, hv, ivStatsOf } from './levels.ts'

export const RV_DAYS = 20
/** NSE's and the bhavcopy's ATM IV for the same day and expiry further apart than this get a warning. */
export const IV_SOURCE_GAP = 0.02
/** A 25-delta pick must land within this of ±0.25 (17 to 33 delta). */
const DELTA_SLACK = 0.08
const ATM_TRIES = 3

// ------------------------------------------------------------------ chain snapshot → one day

/** `[strike, CE close, PE close, CE IV, PE IV]`: closes only of contracts that traded that day; IVs NSE's, decimal. */
export type StrikeRow = readonly [number, number | null, number | null, number | null, number | null]
export interface RawSide {
  readonly expiry: string
  readonly rolled: boolean
  readonly future: number | null
  readonly strikes: readonly StrikeRow[]
}
/** One stock in data/nse/vol/<date>.json, as scripts/nse_vol_job.py writes it. */
export interface RawVolStock {
  readonly spot: number | null
  readonly sources: readonly string[]
  readonly near: RawSide | null
  readonly next: RawSide | null
  readonly errors: readonly string[]
}

/** One stock's chain snapshot for one day, reduced to what the metrics read. */
export interface VolDay {
  readonly date: string
  readonly nearExpiry: string | null
  readonly nextExpiry: string | null
  readonly rolled: boolean
  readonly atmStrike: number | null
  readonly nearIv: number | null
  readonly nearIvSource: IvSource | null
  readonly nextIv: number | null
  readonly skew25: number | null
  readonly spot: number | null
  readonly future: number | null
  /** NSE CMVOLT annualised volatility, decimal. */
  readonly nseHv: number | null
  /** Short fixed sentences; never text from a file. */
  readonly notes: readonly string[]
}

const pos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

/** 15:40 IST on `date`, the F&O close (core's `FNO_CLOSE_MIN`): the snapshot's prices are the session's closes. */
function closeMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) - 330 * 60_000 + FNO_CLOSE_MIN * 60_000
}

interface Atm { readonly strike: number; readonly iv: number; readonly source: IvSource }

/**
 * The strike nearest the forward with a usable pair: NSE's two IVs first, else the two closes solved exactly as the
 * history solves its ATM IV (`atmIvOf`: off the month's future close, else put-call parity), so both series agree.
 */
function atmOf(date: string, side: RawSide, ref: number): Atm | null {
  const near = [...side.strikes].sort((a, b) => Math.abs(a[0] - ref) - Math.abs(b[0] - ref) || a[0] - b[0]).slice(0, ATM_TRIES)
  const fut = pos(side.future) ? { expiry: side.expiry, close: side.future } : null
  for (const [k, ce, pe, civ, piv] of near) {
    if (pos(civ) && pos(piv)) return { strike: k, iv: (civ + piv) / 2, source: 'nse' }
    if (pos(ce) && pos(pe)) {
      const iv = atmIvOf(date, fut, { expiry: side.expiry, atm: { strike: k, ce, pe } })
      if (iv !== null) return { strike: k, iv, source: 'bhavcopy' }
    }
  }
  return null
}

/** Put IV at the strike nearest −25Δ less call IV nearest +25Δ, each solved from its traded close. */
function skewOf(side: RawSide, t: number): { skew: number | null; note: string | null } {
  const f = side.future
  if (!pos(f)) return { skew: null, note: 'skew needs the near future\'s close' }
  if (!(t > 0)) return { skew: null, note: 'skew needs time to expiry' }
  let put: { iv: number; gap: number } | null = null
  let call: { iv: number; gap: number } | null = null
  for (const [k, ce, pe] of side.strikes) {
    const type = k < f ? 'PE' : k > f ? 'CE' : null
    const px = type === 'PE' ? pe : type === 'CE' ? ce : null
    if (type === null || !pos(px)) continue
    const iv = b76ImpliedVol(px, { future: f, strike: k, t, rate: DEFAULT_RATE, type })
    if (iv === null) continue
    const delta = b76Greeks({ future: f, strike: k, t, vol: iv, rate: DEFAULT_RATE, type }).delta
    const gap = Math.abs(Math.abs(delta) - 0.25)
    if (type === 'PE' && (put === null || gap < put.gap)) put = { iv, gap }
    if (type === 'CE' && (call === null || gap < call.gap)) call = { iv, gap }
  }
  if (put === null || call === null || put.gap > DELTA_SLACK || call.gap > DELTA_SLACK) {
    return { skew: null, note: 'skew: no traded strike near 25 delta on both sides' }
  }
  return { skew: put.iv - call.iv, note: null }
}

/**
 * One stock's snapshot for `date` reduced to a VolDay. `s` null = the stock is only in CMVOLT that day.
 * `full: false` works out the near ATM IV only (an older day's IV feeds the series; its term and skew are never read).
 */
export function summarizeChain(date: string, s: RawVolStock | null, nseHv: number | null, opts: { readonly full?: boolean } = {}): VolDay {
  const full = opts.full ?? true
  const notes: string[] = []
  const at = closeMs(date)
  const spot = s !== null && pos(s.spot) ? s.spot : null
  const sideIv = (side: RawSide | null, label: string): Atm | null => {
    if (side === null) return null
    const ref = pos(side.future) ? side.future : spot
    if (ref === null) { notes.push(`${label} expiry: no future or spot to find the ATM strike`); return null }
    const atm = atmOf(date, side, ref)
    if (atm === null) notes.push(`${label} expiry: no ATM strike with both IVs or both traded closes`)
    else if (!pos(side.future) && atm.source === 'bhavcopy') notes.push(`${label} expiry: ATM IV off put-call parity (no future close)`)
    return atm
  }
  const near = sideIv(s?.near ?? null, 'near')
  const next = full ? sideIv(s?.next ?? null, 'next') : null
  let skew25: number | null = null
  if (full && s?.near != null) {
    const k = skewOf(s.near, yearsToExpiry(s.near.expiry, at))
    skew25 = k.skew
    if (k.note !== null) notes.push(k.note)
  }
  return {
    date,
    nearExpiry: s?.near?.expiry ?? null,
    nextExpiry: s?.next?.expiry ?? null,
    rolled: s?.near?.rolled ?? false,
    atmStrike: near?.strike ?? null,
    nearIv: near?.iv ?? null,
    nearIvSource: near?.source ?? null,
    nextIv: next?.iv ?? null,
    skew25,
    spot,
    future: s !== null && s.near !== null && pos(s.near.future) ? s.near.future : null,
    nseHv: pos(nseHv) ? nseHv : null,
    notes,
  }
}

// ------------------------------------------------------------------ the metrics

interface Pt {
  readonly date: string
  close: number | null
  barIv: number | null
  day: VolDay | null
  iv: number | null
  ivSource: IvSource | null
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

/** % of `xs` strictly below `x` — ivStatsOf's percentile, for a series that may be negative. */
const below = (xs: readonly number[], x: number): number => (xs.filter((v) => v < x).length / xs.length) * 100

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}

const EMPTY: VolMetrics = {
  asOf: null, iv: null, ivSource: null, ivRank: null, ivPercentile: null, ivDays: 0, hv10: null, hv20: null, nseHv: null,
  vrp: null, vrpRatio: null, vrpPercentile: null, vrpDays: 0, realizedVrp: null, nearExpiry: null, nearIv: null,
  nextExpiry: null, nextIv: null, skew25: null, warnings: ['no end-of-day history or chain snapshot'],
}

/**
 * Every figure as of the latest day ≤ `today` in `bars` ∪ `days` (both oldest → newest).
 * IV rank and percentile are levels.ts' `ivStatsOf` over the last 252 days' IVs, today's included (rank =
 * (IV − min) / (max − min) × 100, percentile = % of those days with a lower IV; 60 days needed). HV is levels.ts'
 * `hv`. VRP = IV − HV20; its percentile counts the same way. Realized VRP = IV(t) − HV of t → t+20.
 */
export function volMetrics(bars: readonly DailyBar[], days: readonly VolDay[], today: string): VolMetrics {
  const by = new Map<string, Pt>()
  const pt = (date: string): Pt => {
    let p = by.get(date)
    if (p === undefined) { p = { date, close: null, barIv: null, day: null, iv: null, ivSource: null }; by.set(date, p) }
    return p
  }
  for (const b of bars) {
    if (b.date > today) continue
    const p = pt(b.date)
    p.close = pos(b.close) ? b.close : null
    p.barIv = pos(b.atmIv) ? b.atmIv : null   // the fixed tenor's (history.ts), the snapshot's near expiry
  }
  for (const d of days) {
    if (d.date > today) continue
    const p = pt(d.date)
    p.day = d
    if (p.close === null && pos(d.spot)) p.close = d.spot
  }
  const pts = [...by.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (pts.length === 0) return EMPTY
  for (const p of pts) {
    if (p.day !== null && pos(p.day.nearIv)) { p.iv = p.day.nearIv; p.ivSource = p.day.nearIvSource }
    else if (p.barIv !== null) { p.iv = p.barIv; p.ivSource = 'bhavcopy' }
  }

  const warnings: string[] = []
  const L = pts.length - 1
  const now = pts[L] as Pt
  // closes in order, and how many of them fall on or before each point
  const closes: number[] = []
  const upTo: number[] = []
  const closeDate: string[] = []
  for (const p of pts) {
    if (p.close !== null) { closes.push(p.close); closeDate.push(p.date) }
    upTo.push(closes.length)
  }
  const hvAt = (i: number, n: number): number | null => hv(closes.slice(0, upTo[i]), n)

  const iv = now.iv
  if (iv === null) warnings.push(`no ATM IV for ${now.date}`)
  if (now.close === null) warnings.push(closes.length === 0 ? 'no closes' : `no close for ${now.date}: HV ends ${closeDate[closeDate.length - 1]}`)
  const hv10 = hvAt(L, 10)
  const hv20 = hvAt(L, 20)
  if (hv20 === null) warnings.push(`HV20 needs ${RV_DAYS + 1} closes; ${upTo[L]} held`)

  // IV rank and percentile over the window
  const from = Math.max(0, pts.length - YEAR_BARS)
  const st = ivStatsOf(pts.map((p) => p.iv), iv)
  if (iv !== null) {
    if (st.ivDays < IV_RANK_MIN_DAYS) warnings.push(`IV rank needs ${IV_RANK_MIN_DAYS} days of IV; ${st.ivDays} held`)
    else if (st.ivRank === null) warnings.push(`IV flat over ${st.ivDays} days: no rank`)
  }

  // ex-ante VRP and its percentile
  const vrp = iv !== null && hv20 !== null ? iv - hv20 : null
  const vrpRatio = iv !== null && hv20 !== null && hv20 > 0 ? iv / hv20 : null
  const vrps: number[] = []
  for (let i = from; i <= L; i++) {
    const v = (pts[i] as Pt).iv
    const h = v === null ? null : hvAt(i, RV_DAYS)
    if (v !== null && h !== null) vrps.push(v - h)
  }
  let vrpPercentile: number | null = null
  if (vrp !== null) {
    if (vrps.length < IV_RANK_MIN_DAYS) warnings.push(`VRP percentile needs ${IV_RANK_MIN_DAYS} days; ${vrps.length} held`)
    else vrpPercentile = below(vrps, vrp)
  }

  // realized VRP: IV(t) against the close-to-close vol of the 20 trading days after t
  const pairs: number[] = []
  for (let i = from; i <= L; i++) {
    const p = pts[i] as Pt
    if (p.iv === null || p.close === null) continue
    const c = (upTo[i] as number) - 1   // p's own close
    if (c + RV_DAYS > closes.length - 1) break
    const rv = hv(closes.slice(c, c + RV_DAYS + 1), RV_DAYS)
    if (rv !== null) pairs.push(p.iv - rv)
  }
  let realizedVrp: RealizedVrp | null = null
  if (pairs.length < IV_RANK_MIN_DAYS) warnings.push(`realized VRP needs ${IV_RANK_MIN_DAYS} days; ${pairs.length} held`)
  else {
    realizedVrp = {
      mean: pairs.reduce((a, b) => a + b, 0) / pairs.length,
      median: median(pairs),
      positivePct: (pairs.filter((x) => x > 0).length / pairs.length) * 100,
      days: pairs.length,
    }
  }

  const d = now.day
  if (d !== null && d.nearIvSource === 'nse' && pos(d.nearIv) && now.barIv !== null && Math.abs(d.nearIv - now.barIv) > IV_SOURCE_GAP) {
    warnings.push(`NSE ATM IV ${pct(d.nearIv)} vs bhavcopy ${pct(now.barIv)}`)
  }
  if (d !== null) warnings.push(...d.notes)

  return {
    asOf: now.date, iv, ivSource: iv === null ? null : now.ivSource, ivRank: st.ivRank, ivPercentile: st.ivPercentile, ivDays: st.ivDays,
    hv10, hv20, nseHv: d?.nseHv ?? null, vrp, vrpRatio, vrpPercentile, vrpDays: vrps.length, realizedVrp,
    nearExpiry: d?.nearExpiry ?? null, nearIv: d?.nearIv ?? null, nextExpiry: d?.nextExpiry ?? null, nextIv: d?.nextIv ?? null,
    skew25: d?.skew25 ?? null, warnings,
  }
}
