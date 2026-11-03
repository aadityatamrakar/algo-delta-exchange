/**
 * Black-Scholes greeks for NSE options.
 *
 * WHY algomaker computes these rather than trusting the decider: the Python desk
 * marks its book off its own chain source, so its delta is a view of what it
 * BELIEVES it holds. The bridge's job is to answer "what is actually open, and
 * what is its delta right now" from the executed book and the live feed. When the
 * two disagree, that difference is the signal — which only works if the two are
 * computed independently.
 *
 * European exercise throughout: NSE moved both index and single-stock options to
 * European style, so there is no early-exercise premium to model. Dividend yield
 * is a parameter rather than assumed zero — it is materially non-zero for the
 * stock names this desk trades, and omitting it biases every call delta up.
 *
 * Pure and dependency-free. `server/lib/scholes.js` and `option_greeks.js` are
 * the legacy equivalents; they are untested, disagree with each other on theta's
 * sign convention, and neither exposes vega. Not reused deliberately.
 */

/**
 * Black-76 off the traded future — `b76Price`, `b76Greeks`, `b76ImpliedVol`.
 * Same package, different input: pass `F` when the future IS the mark, rather
 * than bending spot-BS around it with `carryYield`.
 */
export * from './black76.ts'

export type OptionType = 'CE' | 'PE'

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

/**
 * Standard normal CDF, Abramowitz & Stegun 7.1.26 on erf.
 * Max absolute error 1.5e-7 — well inside the noise on any real option quote.
 */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * z)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z)
  return 0.5 * (1 + sign * y)
}

export interface BsInputs {
  /** Spot price of the underlying. */
  readonly spot: number
  readonly strike: number
  /** Time to expiry in YEARS. */
  readonly t: number
  /** Annualised volatility as a decimal (0.32 = 32%). */
  readonly vol: number
  /** Risk-free rate as a decimal. */
  readonly rate: number
  /** Continuous dividend yield as a decimal. Non-zero matters for stocks. */
  readonly dividendYield?: number
  readonly type: OptionType
}

export interface Greeks {
  readonly price: number
  /** Per 1 unit of underlying move. */
  readonly delta: number
  readonly gamma: number
  /** Per 1 point of vol (i.e. per 1%), not per 1.0 of vol. */
  readonly vega: number
  /** Per CALENDAR DAY, negative for a long option. */
  readonly theta: number
  /** Per 1% rate move. */
  readonly rho: number
  /** Δdelta per 1 vol point. */
  readonly vanna: number
  /** Δvega per 1 vol point. */
  readonly volga: number
}

interface D12 {
  readonly d1: number
  readonly d2: number
  readonly sqrtT: number
  readonly discount: number
  readonly carry: number
}

function d12(i: BsInputs): D12 | null {
  const q = i.dividendYield ?? 0
  if (!(i.spot > 0) || !(i.strike > 0)) return null
  if (!(i.t > 0) || !(i.vol > 0)) return null
  const sqrtT = Math.sqrt(i.t)
  const d1 =
    (Math.log(i.spot / i.strike) + (i.rate - q + 0.5 * i.vol * i.vol) * i.t) / (i.vol * sqrtT)
  return {
    d1,
    d2: d1 - i.vol * sqrtT,
    sqrtT,
    discount: Math.exp(-i.rate * i.t),
    carry: Math.exp(-q * i.t),
  }
}

/**
 * Intrinsic value. Used at (and past) expiry, where the BS formula degenerates.
 *
 * Returning intrinsic instead of NaN matters operationally: a book held into
 * expiry day must still mark and still report a delta, and a NaN there
 * propagates into the net-delta figure a human is about to act on.
 */
function intrinsic(spot: number, strike: number, type: OptionType): number {
  return type === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot)
}

export function bsPrice(i: BsInputs): number {
  const d = d12(i)
  if (d === null) return intrinsic(i.spot, i.strike, i.type)
  const { d1, d2, discount, carry } = d
  if (i.type === 'CE') {
    return i.spot * carry * normCdf(d1) - i.strike * discount * normCdf(d2)
  }
  return i.strike * discount * normCdf(-d2) - i.spot * carry * normCdf(-d1)
}

/**
 * Full greeks. Degenerate inputs (expired, zero vol) return the intrinsic price
 * with a step delta rather than NaN — see `intrinsic`.
 */
export function greeks(i: BsInputs): Greeks {
  const d = d12(i)
  if (d === null) {
    const itm =
      i.type === 'CE' ? i.spot > i.strike : i.spot < i.strike
    return {
      price: intrinsic(i.spot, i.strike, i.type),
      delta: itm ? (i.type === 'CE' ? 1 : -1) : 0,
      gamma: 0,
      vega: 0,
      theta: 0,
      rho: 0,
      vanna: 0,
      volga: 0,
    }
  }
  const q = i.dividendYield ?? 0
  const { d1, d2, sqrtT, discount, carry } = d
  const pdf1 = normPdf(d1)
  const price = bsPrice(i)
  const gamma = (carry * pdf1) / (i.spot * i.vol * sqrtT)
  // Vega is per 1.0 of vol analytically; /100 converts to "per 1 vol point",
  // which is the unit every trader and every risk report actually uses.
  const vega = (i.spot * carry * pdf1 * sqrtT) / 100
  // Second order, per vol point (vanna /100, volga /1e4); same for CE and PE.
  const vanna = (-carry * pdf1 * d2) / i.vol / 100
  const volga = (i.spot * carry * pdf1 * sqrtT * d1 * d2) / i.vol / 1e4

  if (i.type === 'CE') {
    const thetaYear =
      (-(i.spot * carry * pdf1 * i.vol) / (2 * sqrtT) -
        i.rate * i.strike * discount * normCdf(d2) +
        q * i.spot * carry * normCdf(d1))
    return {
      price,
      delta: carry * normCdf(d1),
      gamma,
      vega,
      theta: thetaYear / 365,
      rho: (i.strike * i.t * discount * normCdf(d2)) / 100,
      vanna,
      volga,
    }
  }
  const thetaYear =
    (-(i.spot * carry * pdf1 * i.vol) / (2 * sqrtT) +
      i.rate * i.strike * discount * normCdf(-d2) -
      q * i.spot * carry * normCdf(-d1))
  return {
    price,
    delta: -carry * normCdf(-d1),
    gamma,
    vega,
    theta: thetaYear / 365,
    rho: (-i.strike * i.t * discount * normCdf(-d2)) / 100,
    vanna,
    volga,
  }
}

export interface ImpliedVolInputs extends Omit<BsInputs, 'vol'> {
  /** Observed market price of the option. */
  readonly price: number
}

/**
 * Implied volatility by bisection.
 *
 * Bisection, not Newton-Raphson, deliberately. Newton divides by vega, and vega
 * collapses toward zero for deep-ITM/OTM and near-expiry contracts — exactly the
 * legs a short-premium book accumulates. There it diverges or returns a wild
 * root. Bisection cannot: it is slower per call and completely reliable, and at
 * ~60 iterations over a few hundred legs the cost is irrelevant.
 *
 * Returns null when the price is outside the no-arbitrage bounds the model can
 * produce — a stale or crossed quote, which must be reported as "unknown" rather
 * than silently marked at a fabricated vol.
 */
export function impliedVol(
  i: ImpliedVolInputs,
  opts: { loVol?: number; hiVol?: number; tolerance?: number; maxIter?: number } = {},
): number | null {
  const lo0 = opts.loVol ?? 0.001
  const hi0 = opts.hiVol ?? 5
  const tol = opts.tolerance ?? 1e-6
  const maxIter = opts.maxIter ?? 100

  if (!(i.price > 0) || !(i.t > 0) || !(i.spot > 0) || !(i.strike > 0)) return null

  const at = (vol: number): number => bsPrice({ ...i, vol })
  let lo = lo0
  let hi = hi0
  const pLo = at(lo)
  const pHi = at(hi)
  // Price below the zero-vol floor or above the max-vol ceiling: no root exists.
  if (i.price < pLo - tol || i.price > pHi + tol) return null

  for (let n = 0; n < maxIter; n++) {
    const mid = 0.5 * (lo + hi)
    const p = at(mid)
    if (Math.abs(p - i.price) < tol || hi - lo < tol) return mid
    if (p < i.price) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

// ---------------------------------------------------------------- book level

export interface PositionLeg {
  readonly tradingsymbol: string
  readonly underlying: string
  readonly strike: number
  readonly type: OptionType
  readonly expiry: string
  /**
   * SIGNED contract quantity: negative is short. Not lots — the lot multiplier
   * is applied before this point, because lot sizes differ per underlying and a
   * book that mixes names cannot sum lots.
   */
  readonly qty: number
  readonly spot: number
  /** Market price of the option, used to back out IV. */
  readonly markPrice: number
}

export interface LegGreeks extends Greeks {
  readonly tradingsymbol: string
  readonly qty: number
  /** Back-solved from `markPrice`; null when the quote admits no solution. */
  readonly iv: number | null
  /** Greeks multiplied by signed qty — what actually aggregates. */
  readonly positionDelta: number
  readonly positionGamma: number
  readonly positionVega: number
  readonly positionTheta: number
  readonly positionVanna: number
  readonly positionVolga: number
}

export interface BookGreeks {
  readonly legs: readonly LegGreeks[]
  readonly netDelta: number
  readonly netGamma: number
  readonly netVega: number
  readonly netTheta: number
  readonly netVanna: number
  readonly netVolga: number
  /** Legs whose IV could not be solved, so their greeks are not in the totals. */
  readonly unpriced: readonly string[]
  /**
   * Legs priced at `fallbackVol` because their own quote admitted no IV —
   * their greeks and model price ARE in the totals, as estimates. Deep-ITM
   * stock options live here routinely: they price off the future, so their
   * LTP sits below the cash-spot no-arbitrage floor and no vol solves it.
   * Always empty when `fallbackVol` was not passed.
   */
  readonly fallbackPriced: readonly string[]
}

export interface BookGreeksOptions {
  readonly rate?: number
  readonly dividendYield?: number
  /** Fallback vol when IV cannot be solved. Omit to EXCLUDE such legs instead. */
  readonly fallbackVol?: number
}

/**
 * Per-leg and net greeks for a book.
 *
 * A leg whose IV will not solve is excluded from the totals and named in
 * `unpriced`, rather than being marked at a guessed vol. A net delta that
 * silently omits nothing looks the same as one that silently omitted three legs;
 * naming them is what makes the number safe to act on. Pass `fallbackVol` to opt
 * into the other behaviour explicitly.
 */
export function bookGreeks(
  legs: readonly PositionLeg[],
  nowMs: number,
  opts: BookGreeksOptions = {},
): BookGreeks {
  const rate = opts.rate ?? 0.065
  const q = opts.dividendYield ?? 0
  const out: LegGreeks[] = []
  const unpriced: string[] = []
  const fallbackPriced: string[] = []
  let netDelta = 0
  let netGamma = 0
  let netVega = 0
  let netTheta = 0
  let netVanna = 0
  let netVolga = 0

  for (const leg of legs) {
    const t = yearsToExpiry(leg.expiry, nowMs)
    const base = {
      spot: leg.spot,
      strike: leg.strike,
      t,
      rate,
      dividendYield: q,
      type: leg.type,
    }
    // `iv` stays what it claims to be — BACK-SOLVED from the quote, null when
    // the quote admits no solution. A fallback-priced leg keeps iv null and is
    // named in `fallbackPriced`; reporting the fallback vol as the leg's IV
    // dressed an assumption up as a measurement.
    const iv = impliedVol({ ...base, price: leg.markPrice })
    const vol = iv ?? opts.fallbackVol
    if (vol === undefined) {
      unpriced.push(leg.tradingsymbol)
      continue
    }
    if (iv === null) fallbackPriced.push(leg.tradingsymbol)
    const g = greeks({ ...base, vol })
    const lg: LegGreeks = {
      ...g,
      tradingsymbol: leg.tradingsymbol,
      qty: leg.qty,
      iv,
      positionDelta: g.delta * leg.qty,
      positionGamma: g.gamma * leg.qty,
      positionVega: g.vega * leg.qty,
      positionTheta: g.theta * leg.qty,
      positionVanna: g.vanna * leg.qty,
      positionVolga: g.volga * leg.qty,
    }
    out.push(lg)
    netDelta += lg.positionDelta
    netGamma += lg.positionGamma
    netVega += lg.positionVega
    netTheta += lg.positionTheta
    netVanna += lg.positionVanna
    netVolga += lg.positionVolga
  }

  return {
    legs: out,
    netDelta,
    netGamma,
    netVega,
    netTheta,
    netVanna,
    netVolga,
    unpriced,
    fallbackPriced,
  }
}

/**
 * The dividend yield that makes Black-Scholes price off a FORWARD of `future`
 * instead of `spot * e^(rt)` — i.e., Black-76 against the traded future,
 * without a second model. BS with continuous yield q has forward
 * `S·e^((r−q)t)`; solving for the q that lands it on the future's own mark
 * gives `q = r − ln(F/S)/t`. Pass the result as `dividendYield` to
 * `impliedVol`/`greeks`/`bookGreeks` and every price, IV and greek is
 * computed against where the hedge actually trades.
 *
 * WHY THIS MATTERS (TCS 2440PE, 2026-08-17): the future carried 10 points
 * over cash, so the deep put's 116.30 mid sat BELOW the cash-spot
 * no-arbitrage floor of 117.93 — no vol solves that, and the leg dropped out
 * of every net figure. Against the future the same quote solves at 26.4%,
 * dead in line with the neighbouring strikes.
 *
 * Null rather than a guess when the inputs cannot support a carry: a
 * non-positive spot/future/tenor, or a future so far from spot (>20%) that it
 * is a bad mark, not a carry — pricing every leg off a phantom forward is
 * worse than pricing off cash.
 */
export function carryYield(
  spot: number,
  future: number,
  tYears: number,
  rate: number,
): number | null {
  if (!(spot > 0) || !(future > 0) || !(tYears > 0) || !Number.isFinite(rate)) return null
  const ratio = future / spot
  if (ratio < 0.8 || ratio > 1.2) return null
  return rate - Math.log(ratio) / tYears
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000
const IST_OFFSET_MS = 330 * 60 * 1000

/**
 * Years from `nowMs` to the 15:40 IST F&O close on `expiry` ('YYYY-MM-DD').
 *
 * Expiry is a TIME, not a date: on expiry morning a contract has ~6 hours of
 * life, and treating that as either a full day or zero misprices every gamma
 * decision on the day they matter most. Never negative.
 *
 * 15:40 because NSE F&O trades to 15:40 since 3 Aug 2026, so an expiring
 * contract is still priced, and still has greeks, until then. It is core's
 * `FNO_CLOSE_MIN`; this package depends on nothing, so the literal is
 * repeated here and packages/payoff/test/fno-close.test.ts pins the two.
 */
export function yearsToExpiry(expiry: string, nowMs: number): number {
  const [y, m, d] = expiry.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) return 0
  // 15:40 IST == 10:10 UTC on the expiry date.
  const closeMs = Date.UTC(y, m - 1, d, 15, 40) - IST_OFFSET_MS
  return Math.max(0, (closeMs - nowMs) / MS_PER_YEAR)
}
