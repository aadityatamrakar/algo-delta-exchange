/**
 * The payoff SURFACE: what the book is worth at every price, on every date.
 *
 * A port of `build_surface` (`sensibull_tools/sim/optimizer/surface.py`) — the
 * function that scores every repair candidate the Python optimizer considers —
 * enriched with the per-date cell grid from `sensibull_tools/basket/surface.py`
 * so the cockpit can DRAW the thing the optimizer only summarises. Deliberately
 * NOT a port of the basket module's arithmetic: that one prices on spot-BS and
 * carries its own POP; both are superseded here by Black-76 off the future
 * (`legs.ts`) and by the optimizer's own zero-drift lognormal.
 *
 * TWO CLOCKS, AND ONLY ONE OF THEM BELONGS HERE. `yearsToExpiry` in
 * `@algomaker/greeks` runs an INTRADAY clock — it knows that at 09:20 on expiry
 * day a contract still has six hours of life, which is exactly right for
 * marking a live book. The Python surface does not have a clock at all: it walks
 * named DATES, and its `year_frac` is calendar days over 365, floored at zero.
 * Feeding the intraday clock into a date grid would shift every column by a
 * fraction of a day and put the whole surface out of parity with the desk that
 * is already running. So this file carries its own `yearFrac`, and it is the
 * only time source in it.
 *
 * WHAT THE SURFACE IS NOT: it prices the OPEN LEGS, against their own entries.
 * P&L already banked by closes does not appear at any price or on any date.
 * That question — "where does the RUN break even" — is `expiryBreakevens`'s,
 * and shifting the whole grid by realised money would claim the surviving legs
 * are worth something they can never earn again. The view layer owns that
 * offset; see `expiry.ts`.
 *
 * FAIL-SOFT THROUGHOUT, and stricter than the Python: every bail-out that the
 * Python answers with a silent zeroed summary is answered here with the same
 * zeroed summary PLUS a warning naming what went wrong, because a surface that
 * reads flat zero is indistinguishable from a book that is genuinely flat.
 * Nothing in this file throws, and nothing NaN leaves it.
 */
import { legGreeks, legPnl, DEFAULT_RATE, type PayoffLeg } from './legs.ts'
import { normCdf, type B76Greeks } from '@algomaker/greeks'

export interface SurfaceInputs {
  readonly legs: readonly PayoffLeg[]
  /**
   * The FUTURE price (`F`), per the Black-76 convention this package prices
   * on — not cash spot. The ladder is centred on it and the shocks are
   * multiples of it.
   */
  readonly spot: number
  /**
   * Valuation dates, ISO `YYYY-MM-DD`, in order: `dates[0]` is the day being
   * valued ("today") and the LAST is the expiry the summary reduces to.
   */
  readonly dates: readonly string[]
  /** Risk-free rate. Discounts only — carry is already in `spot`. */
  readonly rate?: number
  /** Half-width of the price ladder as a fraction of spot. Default ±10%. */
  readonly band?: number
  /** Rungs per side. Default 10, i.e. a 21-point ladder. */
  readonly steps?: number
}

export interface Surface {
  /**
   * The price ladder, ascending: `2·steps + 1` points centred on spot, LESS any
   * duplicates — a `band` of 0 collapses every rung onto spot and leaves one.
   * Read `prices.length`; never assume 21.
   */
  readonly prices: readonly number[]
  /** Date → book P&L at each price, index-aligned with `prices`. */
  readonly cells: Readonly<Record<string, readonly number[]>>
  /** Premium collected on the option legs at entry. Positive = net credit. */
  readonly netCredit: number
  /** Book greeks at the ladder point nearest spot, on `dates[0]`. */
  readonly greeks: B76Greeks
  /** Best outcome over the EXPIRY column. */
  readonly maxProfit: number
  /** Worst outcome over the EXPIRY column. */
  readonly maxLoss: number
  /** Zero crossings of the expiry column, interpolated between ladder points. */
  readonly breakevens: readonly number[]
  /** Worst book P&L TODAY at spot × {0.90, 0.95, 1.05, 1.10}. */
  readonly worstShock: number
  /**
   * The shocked PRICE that worst reading happens at — one of the four spot
   * multiples, ties to the LOWER (a symmetric book must not have its worst
   * case depend on scan direction). `0` only from `empty()`, where there was
   * nothing to shock.
   */
  readonly worstShockAt: number
  /** Probability the expiry column finishes in profit. Zero-drift lognormal. */
  readonly pop: number
  /** Everything that degraded, named. Empty on a clean book. */
  readonly warnings: readonly string[]
}

/** The vol POP falls back to when not one option leg carries an IV. */
const DEFAULT_ATM_IV = 0.2
const DEFAULT_BAND = 0.1
const DEFAULT_STEPS = 10
/** The four moves the desk stress-tests a book against, same day. */
const SHOCKS = [0.9, 0.95, 1.05, 1.1] as const
const MS_PER_DAY = 24 * 60 * 60 * 1000

const ZERO_GREEKS: B76Greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 }

function empty(warnings: readonly string[]): Surface {
  return {
    prices: [],
    cells: {},
    netCredit: 0,
    greeks: { ...ZERO_GREEKS },
    maxProfit: 0,
    maxLoss: 0,
    breakevens: [],
    worstShock: 0,
    worstShockAt: 0,
    pop: 0,
    warnings,
  }
}

/**
 * UTC midnight of the DATE PART of an ISO string, or null if there is none.
 *
 * The date part specifically: callers routinely hold `str(pandas.Timestamp)`
 * ("2026-08-25 00:00:00") or a full offset datetime, and the Python's own
 * `_iso_date` takes the leading date off both rather than failing.
 *
 * ANCHORED, and that is the whole point of the `[T ]` in the pattern. The
 * Python splits on the first space (having turned `T` into one) and hands the
 * REST to `date.fromisoformat`, so a date is only accepted when the leading
 * token is exactly `YYYY-MM-DD` — "2026-08-25 00:00:00" and
 * "2026-08-25T09:45:00+00:00" parse, "2026-08-25garbage" RAISES. A bare prefix
 * match would swallow that last one, and a truncated feed date is exactly the
 * kind of corruption that must reach the warning path rather than price as a
 * valid day.
 *
 * Rolled-over dates ("2026-02-31") are rejected too — `Date.UTC` would silently
 * accept them as March 3rd, where `date.fromisoformat` raises, and a book that
 * quietly prices three days late is worse than one that says it could not read
 * the date.
 */
export function isoDayMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(String(value ?? '').trim())
  if (m === null) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null
  }
  return ms
}

/**
 * Calendar days from `from` to `to`, over 365, floored at zero — the Python
 * `pricing.year_frac`, and the ONLY clock in this file (see the header).
 *
 * `null`, not zero, when either date is unreadable: zero is a real answer
 * (expiry day) and conflating the two would price an unparseable leg as an
 * expiring one, which is the single most dangerous mark in a book.
 */
export function yearFrac(from: string, to: string): number | null {
  const a = isoDayMs(from)
  const b = isoDayMs(to)
  if (a === null || b === null) return null
  return Math.max(0, (b - a) / MS_PER_DAY / 365)
}

/** A leg's own expiry, falling back to the surface's last date. */
function expiryOf(leg: PayoffLeg, fallback: string): string {
  return typeof leg.expiry === 'string' && leg.expiry !== '' ? leg.expiry : fallback
}

/**
 * `(leg, t)` for ONE valuation date.
 *
 * `t` does not vary along the price ladder, so it is resolved once per date
 * rather than 21 times — the whole reason the Python hoisted it out of the
 * inner loop. `t === null` marks a leg whose expiry would not parse; it is
 * skipped at every price, contributing nothing rather than a NaN.
 */
interface LegTime {
  readonly leg: PayoffLeg
  readonly t: number | null
}

function legTimes(
  legs: readonly PayoffLeg[],
  date: string,
  fallbackExpiry: string,
): readonly LegTime[] {
  return legs.map((leg) => ({ leg, t: yearFrac(date, expiryOf(leg, fallbackExpiry)) }))
}

/** Book P&L at future price `F` from pre-resolved times. Legs sum in order. */
function bookPnlAt(times: readonly LegTime[], F: number, rate: number): number {
  let total = 0
  for (const { leg, t } of times) {
    if (t === null) continue
    const p = legPnl(leg, F, t, rate)
    if (Number.isFinite(p)) total += p
  }
  return total
}

/**
 * Zero crossings of a payoff column, ported crossing-for-crossing from
 * `surface.py:_breakevens` — including its two quirks, which are load-bearing
 * for parity: a ladder point sitting EXACTLY on zero is itself a breakeven
 * (reported before any interpolation, and de-duplicated), and the final point
 * is checked separately because the loop reads each segment by its left end.
 *
 * Unlike `expiryBreakevens` this is grid-resolution: it can only ever bracket a
 * crossing to within one ladder step and then interpolate linearly across it.
 * That is the Python's answer and the one the fixtures encode. When the exact
 * crossing is what matters, `expiry.ts` walks the kinks instead.
 */
function breakevensOf(prices: readonly number[], vals: readonly number[]): number[] {
  const bes: number[] = []
  for (let i = 0; i < prices.length - 1; i++) {
    const x0 = prices[i]
    const x1 = prices[i + 1]
    const y0 = vals[i]
    const y1 = vals[i + 1]
    if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) continue
    if (y0 === 0) {
      if (!bes.includes(x0)) bes.push(x0)
    } else if ((y0 < 0 && y1 > 0) || (y1 < 0 && y0 > 0)) {
      bes.push(x0 + (-y0 / (y1 - y0)) * (x1 - x0))
    }
  }
  const lastX = prices[prices.length - 1]
  const lastY = vals[vals.length - 1]
  if (lastX !== undefined && lastY === 0 && !bes.includes(lastX)) bes.push(lastX)
  return bes
}

/** Index of the ladder point nearest `x`; ties go to the LOWER price, as Python's `min` does. */
function nearestIndex(prices: readonly number[], x: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i]
    if (p === undefined) continue
    const d = Math.abs(p - x)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

function clip01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

/**
 * P(lo ≤ S_T ≤ hi) under a ZERO-DRIFT lognormal — `pricing.lognormal_prob_between`.
 *
 * Zero drift means `E[S_T] = S`: no risk-free growth, no view. That is the
 * honest assumption for a probability shown next to a trade the desk is about
 * to put on, and it is what makes this POP comparable across candidates rather
 * than a bet on direction. `null` bounds are open ends (0 and +∞).
 *
 * Degenerate input (no time, no vol, no price) collapses to the INDICATOR — is
 * the price already inside the band — which is the correct limit and is what
 * makes an expiry-day POP read 1 or 0 rather than NaN.
 */
export function lognormalProbBetween(
  S: number,
  lo: number | null,
  hi: number | null,
  sigma: number,
  T: number,
): number {
  if (!Number.isFinite(S) || !Number.isFinite(sigma) || !Number.isFinite(T)) return 0
  const loV = lo === null || !Number.isFinite(lo) ? 0 : lo
  const hiV = hi === null || !Number.isFinite(hi) ? Infinity : hi
  if (T <= 0 || sigma <= 0 || S <= 0) return loV <= S && S <= hiV ? 1 : 0
  const vol = sigma * Math.sqrt(T)
  // `normCdf` is the greeks package's own (Abramowitz & Stegun 7.1.26, max
  // 1.5e-7 absolute), imported rather than re-derived: this probability sits
  // beside prices computed with that same CDF, and two normal CDFs in one
  // answer is one of them waiting to drift.
  const cdf = (x: number): number => {
    if (x <= 0) return 0
    if (!Number.isFinite(x)) return 1
    // P(S_T ≤ x) with the median shifted so the MEAN is S.
    return normCdf((Math.log(x / S) + 0.5 * vol * vol) / vol)
  }
  return Math.max(0, cdf(hiV) - cdf(loV))
}

/**
 * Probability of profit — `surface.py:_pop`, branch for branch.
 *
 * The shape of the expiry payoff decides which probability is even the right
 * one to ask for, which is why this is a case analysis and not a formula:
 *
 *   no crossing    the whole ladder is one sign — certainty, 1 or 0
 *   one crossing   profit is one open half-line; which half is read off the
 *                  ladder's far end
 *   two or more    profit is the band BETWEEN the outer crossings if the middle
 *                  is green (a short strangle), and the two TAILS outside them
 *                  if it is red (a long strangle) — read off the ladder point
 *                  nearest the midpoint, never assumed
 *
 * Advisory, never fatal: anything it cannot answer is 0.
 */
function popOf(
  spot: number,
  prices: readonly number[],
  expiryCol: readonly number[],
  bes: readonly number[],
  atmIv: number,
  tExp: number | null,
): number {
  if (prices.length === 0) return 0
  if (bes.length === 0) {
    const anyVal = expiryCol[Math.floor(prices.length / 2)] ?? 0
    return anyVal >= 0 ? 1 : 0
  }
  if (tExp === null || tExp <= 0 || atmIv <= 0 || spot <= 0) return 0
  if (bes.length === 1) {
    const be = bes[0] as number
    const hiPositive = (expiryCol[expiryCol.length - 1] ?? 0) >= 0
    return clip01(
      hiPositive
        ? lognormalProbBetween(spot, be, null, atmIv, tExp)
        : lognormalProbBetween(spot, null, be, atmIv, tExp),
    )
  }
  const loBe = Math.min(...bes)
  const hiBe = Math.max(...bes)
  const midPositive = (expiryCol[nearestIndex(prices, (loBe + hiBe) / 2)] ?? 0) >= 0
  if (midPositive) return clip01(lognormalProbBetween(spot, loBe, hiBe, atmIv, tExp))
  return clip01(
    lognormalProbBetween(spot, null, loBe, atmIv, tExp) +
      lognormalProbBetween(spot, hiBe, null, atmIv, tExp),
  )
}

/** Mean IV across the option legs that have one; the desk default when none do. */
function avgIv(legs: readonly PayoffLeg[]): number {
  const ivs = legs
    .filter((l) => l.instrument === 'option' && l.iv !== null && Number.isFinite(l.iv))
    .map((l) => l.iv as number)
  if (ivs.length === 0) return DEFAULT_ATM_IV
  return ivs.reduce((a, b) => a + b, 0) / ivs.length
}

/**
 * Build the price × date P&L grid for `legs` and reduce it to the summary a
 * desk acts on.
 *
 * NOTHING IS ROUNDED, where the Python rounds every field it returns (₹ 2dp,
 * greeks 4-6dp). The parity tolerances absorb the difference. Rounding here
 * would throw away precision the margin engine and the chart both want, to
 * match a display convention that belongs at the display.
 */
export function buildSurface(i: SurfaceInputs): Surface {
  const warnings: string[] = []
  try {
    // Both filters exist for JS callers the types cannot reach — the bridge
    // hands these arrays straight out of Mongo. Anything dropped is COUNTED in
    // a warning: a surface quietly built from three of five legs is the one
    // failure mode a zeroed row would not have caught.
    const rawLegs = i?.legs ?? []
    const legs = rawLegs.filter((l): l is PayoffLeg => l !== null && typeof l === 'object')
    if (legs.length !== rawLegs.length) {
      warnings.push(`${rawLegs.length - legs.length} leg(s) were not objects and were dropped`)
    }
    const rawDates = i?.dates ?? []
    const dates = rawDates.filter((d) => typeof d === 'string' && d !== '')
    if (dates.length !== rawDates.length) {
      warnings.push(`${rawDates.length - dates.length} valuation date(s) were unusable and dropped`)
    }
    const band = i?.band ?? DEFAULT_BAND
    const steps = i?.steps ?? DEFAULT_STEPS
    let rate = i?.rate ?? DEFAULT_RATE
    const spot = i?.spot

    if (legs.length === 0) return empty([...warnings, 'no legs: nothing to price'])
    if (dates.length === 0) return empty([...warnings, 'no valuation dates'])
    if (!Number.isFinite(spot) || spot <= 0) return empty([...warnings, `unusable spot: ${spot}`])
    if (!Number.isInteger(steps) || steps <= 0) {
      return empty([...warnings, `unusable steps: ${steps}`])
    }
    if (!Number.isFinite(band)) return empty([...warnings, `unusable band: ${band}`])
    if (!Number.isFinite(rate)) {
      warnings.push(`unusable rate ${rate}: priced at ${DEFAULT_RATE}`)
      rate = DEFAULT_RATE
    }

    const today = dates[0] as string
    const lastDate = dates[dates.length - 1] as string
    // THE TWO DATES THAT ARE NOT OPTIONAL. Every summary field hangs off one of
    // them — the greeks and the shocks off `today`, the max/min, breakevens and
    // POP off the expiry column — and an unreadable date resolves every leg's
    // `t` to null, which prices the whole column at a flat zero. A flat zero is
    // not a degraded answer, it is a WRONG one that looks like a real book: the
    // expiry column reads 0 at every rung, so `breakevensOf`'s `y0 === 0` branch
    // fires at all 21 of them and the surface reports a book that breaks even
    // everywhere and can neither profit nor lose. The Python never gets there —
    // `year_frac` raises through `build_surface`'s outer except and it returns
    // `_empty()` (surface.py:197). So do we, with the cause named.
    if (isoDayMs(today) === null) {
      return empty([...warnings, `valuation date "${today}" is not an ISO date`])
    }
    if (isoDayMs(lastDate) === null) {
      return empty([...warnings, `expiry date "${lastDate}" is not an ISO date`])
    }
    // An INTERMEDIATE date is survivable: it costs its own column, and every
    // summary field is read off the two dates checked above.
    for (const d of dates) {
      if (isoDayMs(d) === null) {
        warnings.push(`date "${d}" is not an ISO date: its column is all zeros`)
      }
    }
    for (const leg of legs) {
      if (isoDayMs(expiryOf(leg, lastDate)) === null) {
        warnings.push(`leg "${leg.id}": expiry "${leg.expiry}" is not an ISO date; leg skipped`)
      }
    }

    // The ladder. Sorted and de-duplicated because the Python keys its columns
    // by PRICE in a dict: a band of 0 collapses 21 rungs onto one there, and a
    // grid of 21 identical columns here would be a different object entirely.
    const prices = [
      ...new Set(
        Array.from({ length: 2 * steps + 1 }, (_, k) => spot * (1 + band * ((k - steps) / steps))),
      ),
    ].sort((a, b) => a - b)

    const cells: Record<string, readonly number[]> = {}
    for (const d of dates) {
      const times = legTimes(legs, d, lastDate)
      cells[d] = prices.map((p) => bookPnlAt(times, p, rate))
    }

    const expiryCol = cells[lastDate] ?? []
    const maxProfit = expiryCol.length > 0 ? Math.max(...expiryCol) : 0
    const maxLoss = expiryCol.length > 0 ? Math.min(...expiryCol) : 0
    const breakevens = breakevensOf(prices, expiryCol)

    // Greeks are read at the ladder point NEAREST spot rather than at spot
    // itself — the Python's choice, and with an odd ladder centred on spot the
    // two are the same point anyway.
    const nearSpot = prices[nearestIndex(prices, spot)] ?? spot
    const todayTimes = legTimes(legs, today, lastDate)
    const greeks = { ...ZERO_GREEKS }
    for (const { leg, t } of todayTimes) {
      if (t === null) continue
      const g = legGreeks(leg, nearSpot, t, rate)
      greeks.delta += g.delta
      greeks.gamma += g.gamma
      greeks.theta += g.theta
      greeks.vega += g.vega
    }

    // The shocks are EXACT multiples of spot, not the nearest ladder rungs: a
    // ±10% move is a real number the desk quotes, and snapping it to a rung
    // would make the worst case depend on the chart's resolution. The PRICE it
    // lands at rides along — "worst shock −₹2.1L" is only actionable once you
    // know which side of the book it is. Strict `<` keeps the FIRST (lowest)
    // price on a tie, same rule as the expiry floor's.
    let worstShock = Infinity
    let worstShockAt = spot
    for (const m of SHOCKS) {
      const v = bookPnlAt(todayTimes, spot * m, rate)
      if (v < worstShock) {
        worstShock = v
        worstShockAt = spot * m
      }
    }

    let netCredit = 0
    for (const leg of legs) {
      if (leg.instrument !== 'option') continue
      if (!Number.isFinite(leg.entry) || !Number.isFinite(leg.qty)) {
        warnings.push(`leg "${leg.id}": entry/qty unusable; not counted in the credit`)
        continue
      }
      // Signed qty does the work the Python needs a `side` string for: SHORT
      // (qty < 0) collects premium, LONG pays it away.
      netCredit += leg.entry * -leg.qty
    }

    const pop = popOf(spot, prices, expiryCol, breakevens, avgIv(legs), yearFrac(today, lastDate))

    return {
      prices,
      cells,
      netCredit,
      greeks,
      maxProfit,
      maxLoss,
      breakevens,
      worstShock: Number.isFinite(worstShock) ? worstShock : 0,
      worstShockAt: Number.isFinite(worstShock) ? worstShockAt : 0,
      pop,
      warnings,
    }
  } catch (err) {
    // Unreachable by design — every branch above is guarded — and kept anyway
    // because this runs inside a ranking loop over hundreds of candidates, and
    // one bad book must cost that loop a zeroed row, not the whole ranking.
    return empty([...warnings, `surface failed: ${err instanceof Error ? err.message : err}`])
  }
}
