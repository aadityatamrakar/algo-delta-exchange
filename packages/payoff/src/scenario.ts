/**
 * The scenario function: what a set of legs is worth at any (spot, instant,
 * vol shift), every leg on its OWN month's future and tenor, with vanna/volga.
 *
 * Pure: no clock (`market.now` is the one instant), no feed, no IO. The scenario
 * grid, gap rows, breakevens and the Sensibull curve are built on this.
 *
 * CONVENTIONS, fixed here:
 *   - A `future` leg with `expiry: ''` is a share: it prices at spot.
 *   - Spot moves every month's future proportionally (`F_e x spot / market.spot`).
 *     Options price against `optionFutures ?? futures` (the vol basis), futures
 *     legs against `futures`.
 *   - Tenor is `yearsToExpiry(leg.expiry, point.ms)` — the INTRADAY clock,
 *     deliberately not `surface.ts`'s calendar clock, so the scenario's "today"
 *     column agrees with Analysis's live greeks.
 *   - Later dates keep today's time of day (clamped into 09:15-15:40), so the
 *     'time' columns are exactly one day apart and the expiry DATE column still
 *     has time value; the separate `Expiry` column is valued at the close
 *     (mode 'close'). VolHedge v50 shows both.
 *   - Delta is per point of the leg's own month future. Futures and shares:
 *     delta 1 per share, every other greek 0.
 *   - Nothing NaN leaves: a junk spot or date gives empty cells plus a warning;
 *     an option with no IV contributes nothing and is named in the warnings.
 */
import { b76Price, b76Greeks, b76SecondOrder, yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE, type PayoffLeg } from './legs.ts'

export interface ScenarioMarket {
  /** Live CASH price of the stock. */
  readonly spot: number
  /** expiry -> live future; a missing month prices off spot (warned). */
  readonly futures: Readonly<Record<string, number>>
  /** The vol basis options price against; default `futures`. */
  readonly optionFutures?: Readonly<Record<string, number>>
  /** Epoch ms: the valuation instant for today's IST date. */
  readonly now: number
  /** Default `DEFAULT_RATE`. */
  readonly rate?: number
}

export interface VolShifts {
  /** Vol points added to every CE. */
  readonly callVolShift?: number
  /** Vol points added to every PE. */
  readonly putVolShift?: number
  /** Vol points added to every option, on top. */
  readonly volShift?: number
  /** Leg id -> IV decimal; REPLACES `leg.iv` before the shifts. */
  readonly ivOverrides?: Readonly<Record<string, number>>
}

export interface ScenarioGreeks {
  readonly delta: number
  readonly gamma: number
  readonly vega: number
  readonly theta: number
  readonly vanna: number
  readonly volga: number
}
/** Position: sum of qty x per-share. */
export interface ScenarioCell extends ScenarioGreeks {
  readonly pnl: number
}
/** Greeks PER SHARE; `pnl = qty x (price - entry)`. */
export interface LegPoint extends ScenarioGreeks {
  readonly id: string
  readonly price: number
  readonly pnl: number
  readonly iv: number | null
}
/** A column: its IST date and the instant it is valued at. */
export interface ValuationPoint {
  readonly date: string
  readonly ms: number
}
export interface ScenarioResult {
  readonly spots: readonly number[]
  readonly at: readonly ValuationPoint[]
  /** `cells[spotIdx][pointIdx]`. */
  readonly cells: readonly (readonly ScenarioCell[])[]
  readonly warnings: readonly string[]
}

/** The lowest IV an option is priced at: `ivUsed` floors a shifted IV here. */
export const IV_FLOOR = 0.0001
const IST_OFFSET_MS = 330 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const OPEN_MS = (9 * 60 + 15) * 60 * 1000 // 09:15 as ms into the IST day
/** 15:40 IST, the F&O close and the expiry instant `yearsToExpiry` prices to
 * (core's `FNO_CLOSE_MIN`; pinned by packages/payoff/test/fno-close.test.ts). */
const CLOSE_MS = (15 * 60 + 40) * 60 * 1000

const ZERO: ScenarioGreeks = { delta: 0, gamma: 0, vega: 0, theta: 0, vanna: 0, volga: 0 }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPos = (v: unknown): v is number => isNum(v) && v > 0

/** The IST calendar date (`YYYY-MM-DD`) of an epoch-ms instant; `''` when `ms` is not a usable instant. */
export function istDay(ms: number): string {
  if (!isNum(ms)) return ''
  try {
    return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10)
  } catch {
    return '' // beyond Date's range
  }
}

/** Epoch ms of `date` at `msIntoDay` IST; null when `date` is not a real date. */
function istInstant(date: string, msIntoDay: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (m === null) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number]
  const midnight = Date.UTC(y, mo - 1, d)
  if (new Date(midnight).toISOString().slice(0, 10) !== date) return null
  return midnight + msIntoDay - IST_OFFSET_MS
}

/**
 * 'time': today (IST) is `now`; a later date is that date at `now`'s IST time of
 * day, clamped into 09:15-15:40. 'open' / 'close': 09:15 / 15:40 IST.
 * A date before today, or unreadable, is null.
 */
export function valuationAt(
  date: string,
  now: number,
  mode: 'time' | 'open' | 'close',
): ValuationPoint | null {
  if (!isNum(now)) return null
  const today = istDay(now)
  if (today === '') return null
  if (istInstant(date, 0) === null || date < today) return null
  if (mode === 'open') return { date, ms: istInstant(date, OPEN_MS)! }
  if (mode === 'close') return { date, ms: istInstant(date, CLOSE_MS)! }
  if (date === today) return { date, ms: now }
  const tod = (((now + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS
  return { date, ms: istInstant(date, Math.min(CLOSE_MS, Math.max(OPEN_MS, tod)))! }
}

function futureFor(market: ScenarioMarket, expiry: string, instrument: 'option' | 'future'): number | null {
  if (expiry === '') return null
  const map = instrument === 'option' ? (market.optionFutures ?? market.futures) : market.futures
  const f = map[expiry]
  return isPos(f) ? f : null
}

/** The future a leg of `expiry` prices against when spot is `spot`. */
export function forwardAt(
  market: ScenarioMarket,
  expiry: string,
  spot: number,
  instrument: 'option' | 'future',
): number {
  const f = futureFor(market, expiry, instrument)
  return f === null ? spot : (f * spot) / market.spot
}

/** The IV before the floor: override-or-leg IV plus the side and global shifts; null for a non-option or no IV. Below `IV_FLOOR`, `ivUsed` floors it (the caller warns). */
export function rawIv(leg: PayoffLeg, shifts: VolShifts): number | null {
  if (leg.instrument !== 'option') return null
  const base = shifts.ivOverrides?.[leg.id] ?? leg.iv
  if (!isNum(base)) return null
  const side = leg.type === 'CE' ? shifts.callVolShift : leg.type === 'PE' ? shifts.putVolShift : 0
  const shift = (isNum(side) ? side : 0) + (isNum(shifts.volShift) ? shifts.volShift : 0)
  return base + shift / 100
}

/** Options only; floored at 0.0001 (the caller warns). */
export function ivUsed(leg: PayoffLeg, shifts: VolShifts): number | null {
  const iv = rawIv(leg, shifts)
  return iv === null ? null : Math.max(IV_FLOOR, iv)
}

/** The point a leg gets when it cannot be valued: worth nothing, no greeks. */
function inert(leg: PayoffLeg): LegPoint {
  return { id: leg.id, price: isNum(leg.entry) ? leg.entry : 0, pnl: 0, iv: null, ...ZERO }
}

/**
 * Each leg at one (spot, instant): per-share price and greeks, and its P&L.
 *
 * Never returns a non-finite number. A leg it cannot value — junk `at.spot` or
 * `market.spot`, a NaN qty or entry, a future that comes out non-finite, an
 * option with no IV / type / strike, or non-finite output — gets the inert
 * point: `price` = its entry (0 if that is junk), `pnl` 0, greeks 0, `iv` null. It does not warn; `scenario()` names such legs.
 */
export function legPoints(
  legs: readonly PayoffLeg[],
  market: ScenarioMarket,
  at: { readonly spot: number; readonly point: ValuationPoint },
  shifts: VolShifts,
): readonly LegPoint[] {
  const rate = isNum(market.rate) ? market.rate : DEFAULT_RATE
  const sane = isPos(market.spot) && isPos(at.spot) && isNum(at.point.ms)
  return legs.map((leg): LegPoint => {
    if (!sane || !isNum(leg.qty) || !isNum(leg.entry)) return inert(leg)
    if (leg.instrument === 'future') {
      const F = forwardAt(market, leg.expiry, at.spot, 'future')
      const pnl = leg.qty * (F - leg.entry)
      if (!isNum(F) || !isNum(pnl)) return inert(leg)
      return { id: leg.id, price: F, pnl, iv: null, ...ZERO, delta: 1 }
    }
    const vol = ivUsed(leg, shifts)
    if (vol === null || !isNum(vol) || leg.type === null || !isPos(leg.strike)) return inert(leg)
    const i = {
      future: forwardAt(market, leg.expiry, at.spot, 'option'),
      strike: leg.strike,
      t: yearsToExpiry(leg.expiry, at.point.ms),
      vol,
      rate,
      type: leg.type,
    }
    if (!isPos(i.future)) return inert(leg)
    const price = b76Price(i)
    const g = b76Greeks(i)
    const so = b76SecondOrder(i)
    const out = { delta: g.delta, gamma: g.gamma, vega: g.vega, theta: g.theta, vanna: so.vanna, volga: so.volga }
    const pnl = leg.qty * (price - leg.entry)
    if (!isNum(price) || !isNum(pnl) || !Object.values(out).every(isNum)) return inert(leg)
    return { id: leg.id, price, pnl, iv: vol, ...out }
  })
}

/** Warnings that depend on the book and the shifts, not on the grid point. */
function bookWarnings(legs: readonly PayoffLeg[], market: ScenarioMarket, shifts: VolShifts): string[] {
  const out: string[] = []
  const missing = new Set<string>()
  for (const leg of legs) {
    if (leg.expiry !== '' && futureFor(market, leg.expiry, leg.instrument) === null) missing.add(leg.expiry)
    if (!isNum(leg.qty) || !isNum(leg.entry)) out.push(`leg ${leg.id}: qty or entry is not a number — left out`)
    if (leg.instrument !== 'option') continue
    const raw = rawIv(leg, shifts)
    if (raw === null) out.push(`leg ${leg.id}: no IV — left out of the scenario`)
    else if (raw < IV_FLOOR) out.push(`leg ${leg.id}: IV shifted to ${raw.toFixed(4)}, floored at ${IV_FLOOR}`)
  }
  for (const e of [...missing].sort()) out.push(`no future for ${e}: its legs price off spot`)
  return out
}

/** The grid: `legPoints` per (spot, point), summed x qty. */
export function scenario(
  legs: readonly PayoffLeg[],
  market: ScenarioMarket,
  spots: readonly number[],
  at: readonly ValuationPoint[],
  shifts: VolShifts,
): ScenarioResult {
  const junk: string[] = []
  if (!isPos(market.spot)) junk.push(`market spot ${String(market.spot)} is not a positive number`)
  if (!spots.every(isPos)) junk.push('a scenario spot is not a positive number')
  if (!at.every((p) => isNum(p.ms))) junk.push('a valuation instant is not a number')
  if (junk.length > 0) return { spots, at, cells: [], warnings: junk }

  const unpriced = new Set<string>()
  let overflowed = false
  const cells = spots.map((spot) =>
    at.map((point): ScenarioCell => {
      const pts = legPoints(legs, market, { spot, point }, shifts)
      const sum = { pnl: 0, ...ZERO } as { -readonly [K in keyof ScenarioCell]: number }
      pts.forEach((p, k) => {
        const l = legs[k]!
        if (!isNum(l.qty) || !isNum(l.entry)) return // already warned by bookWarnings
        if ((l.instrument === 'future' && p.delta === 0) || (l.instrument === 'option' && p.iv === null && rawIv(l, shifts) !== null)) {
          unpriced.add(l.id)
        }
        sum.pnl += p.pnl
        sum.delta += l.qty * p.delta
        sum.gamma += l.qty * p.gamma
        sum.vega += l.qty * p.vega
        sum.theta += l.qty * p.theta
        sum.vanna += l.qty * p.vanna
        sum.volga += l.qty * p.volga
      })
      if (Object.values(sum).every(isNum)) return sum
      overflowed = true
      return { pnl: 0, ...ZERO }
    }),
  )
  const warnings = bookWarnings(legs, market, shifts)
  for (const id of [...unpriced].sort()) warnings.push(`leg ${id}: cannot be priced — left out`)
  if (overflowed) warnings.push('a scenario point overflowed and was left at 0')
  return { spots, at, cells, warnings }
}
