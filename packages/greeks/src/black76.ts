/**
 * Black-76 — options priced off the traded FUTURE, not off cash.
 *
 * WHY a second model next to `index.ts`: this desk marks and hedges against the
 * near-month future, which is a forward. Feeding a future into plain
 * Black-Scholes-on-spot double-counts carry — the drift term `r` is already in
 * the future's own price, so BS charges it twice. Black-76 takes `F` directly
 * and discounts once, which is the arithmetic the hedge actually obeys.
 * (`carryYield` in `index.ts` is the other way to get here: back out the `q`
 * that lands BS's forward on the future. Same answer, one model — use that when
 * you need rho or a dividend yield, use this when the future IS the input.)
 *
 * A direct port of the pure-Python pricer the Python desk runs
 * (`sensibull_tools/gfdl/greeks.py`), so the two sides of the bridge can be
 * compared number-for-number rather than argued about.
 *
 * Fixed output convention, matching the rest of this package: theta per
 * CALENDAR DAY, vega per 1 VOL POINT (1%). Fail-soft: bad input gives zeros or
 * null, never NaN. Nothing is rounded — the Python rounds for display, and
 * rounding inside a pricer that feeds a surface engine just adds a second,
 * invisible tolerance.
 */

// One normal distribution for the package, not two — a Black-76 IV that
// disagreed with a Black-Scholes IV in the seventh decimal for no stated reason
// is exactly the kind of thing nobody chases down. `index.ts` re-exports this
// file in turn, so this is a module CYCLE: it resolves only because normCdf and
// normPdf are hoisted `function` declarations. Rewriting either as a `const fn =
// () => …` breaks the package at import time with no type error to warn you;
// `black76.test.ts` guards that.
import { normCdf, normPdf, type OptionType } from './index.ts'

export interface B76Inputs {
  /** Price of the FUTURE the option is priced against (the forward, `F`). */
  readonly future: number
  readonly strike: number
  /** Time to expiry in YEARS. */
  readonly t: number
  /** Annualised volatility as a decimal (0.32 = 32%). */
  readonly vol: number
  /** Risk-free rate as a decimal. Discounts only — carry is already in `F`. */
  readonly rate: number
  readonly type: OptionType
}

export interface B76Greeks {
  /** Per 1 unit of FUTURE move (not of spot). */
  readonly delta: number
  readonly gamma: number
  /** Per CALENDAR DAY, negative for a long option. */
  readonly theta: number
  /** Per 1 point of vol (i.e. per 1%), not per 1.0 of vol. */
  readonly vega: number
}

interface D12 {
  readonly d1: number
  readonly d2: number
  readonly sqrtT: number
  /** `σ√t` — the total vol over the option's remaining life. */
  readonly totalVol: number
  readonly discount: number
}

/** Null exactly when the formula degenerates: expired, zero vol, or junk input. */
function d12(i: B76Inputs): D12 | null {
  if (!(i.t > 0) || !(i.vol > 0) || !(i.future > 0) || !(i.strike > 0)) return null
  const sqrtT = Math.sqrt(i.t)
  const totalVol = i.vol * sqrtT
  const d1 = (Math.log(i.future / i.strike) + 0.5 * i.vol * i.vol * i.t) / totalVol
  return { d1, d2: d1 - totalVol, sqrtT, totalVol, discount: Math.exp(-i.rate * i.t) }
}

/**
 * DISCOUNTED intrinsic — what the degenerate cases are worth.
 *
 * Discounted, not raw: a Black-76 payoff settles at expiry, so its floor is
 * `e^{-rt}·max(±(F−K), 0)`. At `t = 0` the discount is 1 and this is the plain
 * payoff, which is what an expiring leg must still mark at.
 */
function discountedIntrinsic(i: Omit<B76Inputs, 'vol'>): number {
  const intr =
    i.type === 'CE' ? Math.max(i.future - i.strike, 0) : Math.max(i.strike - i.future, 0)
  return Math.exp(-i.rate * i.t) * intr
}

export function b76Price(i: B76Inputs): number {
  const d = d12(i)
  if (d === null) return discountedIntrinsic(i)
  const { d1, d2, discount } = d
  if (i.type === 'CE') {
    return discount * (i.future * normCdf(d1) - i.strike * normCdf(d2))
  }
  return discount * (i.strike * normCdf(-d2) - i.future * normCdf(-d1))
}

/**
 * Delta, gamma, theta and vega off the future.
 *
 * Degenerate inputs return ALL ZEROS — deliberately NOT the step delta that
 * spot-BS `greeks()` hands back at expiry. The surface engine leans on this:
 * it walks a grid of futures prices, and a leg that has already expired must
 * contribute a flat, unmoving mark to every point on that walk. A step delta
 * there tilts the whole payoff line by a position that no longer exists.
 */
export function b76Greeks(i: B76Inputs): B76Greeks {
  const d = d12(i)
  if (d === null) return { delta: 0, gamma: 0, theta: 0, vega: 0 }
  const { d1, d2, sqrtT, totalVol, discount } = d
  const pdf1 = normPdf(d1)
  const gamma = (discount * pdf1) / (i.future * totalVol)
  // Analytically vega is per 1.0 of vol; /100 converts to "per 1 vol point",
  // the unit every trader and every risk report actually uses.
  const vega = (i.future * discount * pdf1 * sqrtT) / 100
  // Common to both wings: the pure decay term. What differs is the sign of the
  // carry-on-discounting pair, which follows the wing's own N(·) arguments.
  const decay = (-i.future * discount * pdf1 * i.vol) / (2 * sqrtT)

  if (i.type === 'CE') {
    const thetaYear =
      decay -
      i.rate * i.strike * discount * normCdf(d2) +
      i.rate * i.future * discount * normCdf(d1)
    return { delta: discount * normCdf(d1), gamma, theta: thetaYear / 365, vega }
  }
  const thetaYear =
    decay +
    i.rate * i.strike * discount * normCdf(-d2) -
    i.rate * i.future * discount * normCdf(-d1)
  return { delta: -discount * normCdf(-d1), gamma, theta: thetaYear / 365, vega }
}

/**
 * True iff `vol` is a REAL root: strictly inside the search bracket, and
 * repricing back onto the quote.
 *
 * A quote richer than the model price at the `hi` bound has no implied vol at
 * all — but bisection "converges" onto the bound anyway and hands back ~5.0,
 * i.e. a 500% IV that then silently feeds every downstream vega and gamma (and
 * marks a garbage quote as a tradeable one). The repricing residual is what
 * actually separates the two cases: a genuine root reprices to the quote, a
 * pinned bound is off by the whole excess.
 */
function solves(
  vol: number,
  price: number,
  i: Omit<B76Inputs, 'vol'>,
  hi: number,
  tol: number,
): boolean {
  if (!(vol > 0) || !(vol < hi)) return false
  if (vol >= hi * (1 - 1e-9)) return false // pinned at the bound to within float noise
  return Math.abs(b76Price({ ...i, vol }) - price) <= Math.max(tol, tol * Math.abs(price))
}

/**
 * Implied volatility of `price` under Black-76, or null when there is none.
 *
 * Bisection, not Newton-Raphson — same reasoning as `impliedVol` in
 * `index.ts`: Newton divides by a vega that collapses on the deep and
 * near-dated legs a short-premium book accumulates.
 *
 * Null covers every case the bracket `[loVol, hiVol]` cannot answer: a
 * degenerate input, a quote at or below discounted intrinsic, and — the case
 * worth naming — a quote ABOVE the model price at `hiVol`. That last one used
 * to come back as ~5.0 in the Python, which reads as a perfectly ordinary 500%
 * IV downstream. See `solves`.
 */
export function b76ImpliedVol(
  price: number,
  i: Omit<B76Inputs, 'vol'>,
  opts: { loVol?: number; hiVol?: number; tolerance?: number; maxIter?: number } = {},
): number | null {
  const hiBound = opts.hiVol ?? 5
  const tol = opts.tolerance ?? 1e-6
  const maxIter = opts.maxIter ?? 80

  if (!(i.t > 0) || !(i.future > 0) || !(i.strike > 0)) return null
  if (!(price > discountedIntrinsic(i) + 1e-9)) return null

  let lo = opts.loVol ?? 1e-4
  let hi = hiBound
  for (let n = 0; n < maxIter; n++) {
    const mid = 0.5 * (lo + hi)
    const p = b76Price({ ...i, vol: mid })
    if (Math.abs(p - price) < tol) return mid
    if (p < price) lo = mid
    else hi = mid
  }
  // The loop never priced within `tol` of the quote: the bracket holds no root
  // and bisection has simply walked onto one of its bounds.
  const mid = 0.5 * (lo + hi)
  return solves(mid, price, i, hiBound, tol) ? mid : null
}

export interface B76SecondOrder {
  /** Δdelta per 1 vol point. Same for CE and PE. */
  readonly vanna: number
  /** Δvega per 1 vol point (vega itself being per vol point). Same for CE and PE. */
  readonly volga: number
}

/**
 * Vanna and volga off the future. Kept apart from `b76Greeks` so that function's
 * exact four-field shape (deepEqual'd in the desk's tests) does not move.
 * Degenerate input gives zeros, like `b76Greeks`.
 */
export function b76SecondOrder(i: B76Inputs): B76SecondOrder {
  const d = d12(i)
  if (d === null) return { vanna: 0, volga: 0 }
  const { d1, d2, sqrtT, discount } = d
  const pdf1 = normPdf(d1)
  // Raw derivatives are per 1.0 of vol: /100 for one vol point (vanna), /1e4
  // for volga, which differentiates a per-point vega by a further point.
  return {
    vanna: (-discount * pdf1 * d2) / i.vol / 100,
    volga: (i.future * discount * pdf1 * sqrtT * d1 * d2) / i.vol / 1e4,
  }
}
