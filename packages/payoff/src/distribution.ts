/**
 * WHAT THE BOOK IS EXPECTED TO MAKE, UNDER A VIEW THE TRADER STATED.
 *
 * Every other figure in this package is a property of the BOOK: its floor on the
 * ±10% ladder, its worst shock, its greeks, its zero-drift POP. None of them can
 * answer "will this make money", because that needs a belief about where the
 * price goes and how far — and a desk that ranks plans on expected value without
 * saying which belief it used has quietly made the bet for the trader. So this
 * file takes the belief as an argument (`MarketView`) and returns nothing at all
 * without one: no default view, no house vol.
 *
 * ─ THE DISTRIBUTION ─────────────────────────────────────────────────────────
 *
 * Lognormal at the HORIZON (the view's date, else the book's expiry, never
 * after it), with drift `μ` and vol `σ`:
 *
 *   ln S_h ~ N( ln F + (μ − σ²/2)·T ,  σ²·T )        T = calendar days / 365
 *
 * so `E[S_h] = F·e^{μT}` — zero drift means the future is the expected price,
 * the same no-view assumption `surface.ts`' POP makes. T is read on the
 * surface's own clock (`yearFrac`), so a view's horizon and the surface beside
 * it agree on how long is left.
 *
 * It is drawn on ±4σ in 241 points — NOT the ±10% display ladder. A display
 * ladder is about what a chart can show; a distribution is about where the
 * probability is, and on a 30-day, 45-vol stock ±10% cuts off a fifth of it.
 * Each point carries the probability of its own bin (the normal CDF between the
 * midpoints to its neighbours), the two end bins run out to ±∞, and the weights
 * telescope to exactly one: nothing is lost off the edges, it is lumped onto
 * them.
 *
 * ─ WHICH VOL, AND WHERE ─────────────────────────────────────────────────────
 *
 * Two different vols are in play and the view kinds say which is which:
 *
 *   implied   the distribution at the ATM vol (`atmIv`, the chain's, when the
 *             caller has it — else the mean of the book's option IVs), and each
 *             leg repriced at its OWN IV. The market's own forecast: EV is then
 *             roughly what the spread and the skew cost, which is the honest
 *             baseline every other view is measured against.
 *   shift     both moved by `points` vol points: "vol is going up 3".
 *   flat      the distribution at ONE vol — typically HV20, the trader's view of
 *             how far the stock will actually move — while the legs keep their
 *             own IVs, because that is what the MARKET will still price them at.
 *             "IV is 32 and it realises 22" is precisely the bet a premium
 *             seller makes, and this is the only kind that can express it.
 *
 * Legs only need a vol when time remains at the horizon; at the book's expiry
 * every option is intrinsic and the leg vols drop out.
 *
 * ─ WHAT COMES BACK ──────────────────────────────────────────────────────────
 *
 * RUN-level, realised INCLUDED, like every floor in `goals.ts`: `pop` (0–100,
 * the chance the run finishes the horizon ≥ 0), `ev` (rupees), `cvar5` (the mean
 * of the worst 5% of outcomes, negative = loss, with the bin the 5% line falls
 * in split pro rata), and `sigma` (σ√T, the log-price spread drawn). A leg with
 * no usable IV contributes zero, exactly as it does in `buildSurface` — one
 * convention for "unpriceable" across the package.
 *
 * Pure and fail-soft: no clock, nothing thrown, `null` for anything it cannot
 * draw (an unusable future, a date that is not ISO, a view with no usable vol).
 */
import { normCdf } from '@algomaker/greeks'
import { DEFAULT_RATE, legPnl, type PayoffLeg } from './legs.ts'
import { IV_FLOOR } from './scenario.ts'
import { isoDayMs, yearFrac } from './surface.ts'
import type { MarketView, ViewStats } from './objective-types.ts'

/** Points on the grid: ±4σ in steps of σ/30. */
export const VIEW_POINTS = 241
/** Half-width of the grid, in standard deviations of log price. */
export const VIEW_SIGMAS = 4
/** The tail CVaR averages over. */
const TAIL = 0.05

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `-0` folded: a stored value, and it survives `deepStrictEqual`. */
function fold(v: number): number {
  return v === 0 ? 0 : v
}

/** The book's expiry: the EARLIEST readable leg expiry — the first date a leg settles. */
function bookExpiryOf(legs: readonly PayoffLeg[]): string | null {
  let best: string | null = null
  let bestMs = Infinity
  for (const l of legs) {
    const ms = typeof l.expiry === 'string' ? isoDayMs(l.expiry) : null
    if (ms !== null && ms < bestMs) {
      bestMs = ms
      best = l.expiry
    }
  }
  return best
}

/** Mean IV across the option legs that carry one; null when none do. */
function meanIv(legs: readonly PayoffLeg[]): number | null {
  const ivs = legs
    .filter((l) => l.instrument === 'option')
    .map((l) => finite(l.iv))
    .filter((v): v is number => v !== null && v > 0)
  return ivs.length === 0 ? null : ivs.reduce((a, b) => a + b, 0) / ivs.length
}

/** A prepared distribution: prices and their probabilities, plus what drew it. */
export interface Distribution {
  readonly prices: readonly number[]
  readonly weights: readonly number[]
  /** σ√T, the log-price standard deviation at the horizon. */
  readonly sigma: number
  /** The horizon, ISO. */
  readonly horizon: string
  /** How each option leg is repriced at the horizon: its IV → the vol used. `null` = its own IV. */
  readonly legVol: (iv: number | null) => number | null
}

/**
 * The distribution a view draws over a book, or null when it cannot be drawn.
 *
 * Split from `statsOf` so the objective search draws ONE distribution from the
 * do-nothing book and scores every plan against it: a plan that buys a 45-vol
 * wing must not widen the distribution its own EV is judged on.
 */
export function drawDistribution(
  legs: readonly PayoffLeg[],
  future: number,
  today: string,
  view: MarketView,
  atmIv?: number,
): Distribution | null {
  try {
    const F = finite(future)
    if (F === null || !(F > 0)) return null
    if (typeof today !== 'string' || isoDayMs(today) === null) return null
    if (view === null || typeof view !== 'object' || view.vol === null || typeof view.vol !== 'object') return null
    const book = (Array.isArray(legs) ? legs : []).filter((l): l is PayoffLeg => l !== null && typeof l === 'object')

    // The horizon: the view's, never after the book's expiry and never before today.
    const expiry = bookExpiryOf(book) ?? today
    let horizon = expiry
    if (view.horizon !== undefined) {
      if (typeof view.horizon !== 'string' || isoDayMs(view.horizon) === null) return null
      horizon = view.horizon
      if ((isoDayMs(horizon) as number) > (isoDayMs(expiry) as number)) horizon = expiry
      if ((isoDayMs(horizon) as number) < (isoDayMs(today) as number)) horizon = today
    }
    const T = yearFrac(today, horizon)
    if (T === null) return null

    const drift = finite(view.driftAnnual ?? 0)
    if (drift === null) return null
    const atm = finite(atmIv)
    const base = atm !== null && atm > 0 ? atm : meanIv(book)
    let vol: number | null
    let legVol: (iv: number | null) => number | null
    switch (view.vol.kind) {
      case 'implied':
        vol = base
        legVol = (iv) => iv
        break
      case 'shift': {
        const pts = finite(view.vol.points)
        if (pts === null) return null
        vol = base === null ? null : Math.max(IV_FLOOR, base + pts / 100)
        legVol = (iv) => (iv === null ? null : Math.max(IV_FLOOR, iv + pts / 100))
        break
      }
      case 'flat': {
        const annual = finite(view.vol.annual)
        vol = annual !== null && annual > 0 ? annual : null
        legVol = (iv) => iv
        break
      }
      default:
        return null
    }
    // An empty book needs no vol: its run is flat at what it banked.
    if (vol === null && book.length > 0) return null
    const s = vol === null ? 0 : vol * Math.sqrt(T)
    const mu = (drift - 0.5 * (vol ?? 0) * (vol ?? 0)) * T

    if (!(s > 0)) {
      return { prices: [F * Math.exp(drift * T)], weights: [1], sigma: 0, horizon, legVol }
    }
    // Bin edges halfway between points; each weight is its bin's probability,
    // the end bins open to ±∞, so the weights telescope to one.
    const h = (2 * VIEW_SIGMAS) / (VIEW_POINTS - 1)
    const z = Array.from({ length: VIEW_POINTS }, (_, i) => -VIEW_SIGMAS + i * h)
    const edges = Array.from({ length: VIEW_POINTS - 1 }, (_, j) => normCdf(-VIEW_SIGMAS + (j + 0.5) * h))
    const weights = z.map((_, i) => {
      const lo = i === 0 ? 0 : (edges[i - 1] as number)
      const hi = i === VIEW_POINTS - 1 ? 1 : (edges[i] as number)
      return Math.max(0, hi - lo)
    })
    const prices = z.map((zi) => F * Math.exp(mu + s * zi))
    return { prices, weights, sigma: s, horizon, legVol }
  } catch {
    return null
  }
}

/** The RUN's P&L at each price of a distribution, realised included. */
function outcomes(legs: readonly PayoffLeg[], d: Distribution, realised: number): number[] {
  const times = legs.map((leg) => {
    const exp = typeof leg.expiry === 'string' && leg.expiry !== '' ? leg.expiry : d.horizon
    return { leg, t: yearFrac(d.horizon, exp) }
  })
  return d.prices.map((S) => {
    let total = realised
    for (const { leg, t } of times) {
      if (t === null) continue
      const iv = leg.instrument === 'option' ? d.legVol(finite(leg.iv)) : null
      const p = leg.instrument === 'option' && iv !== null ? legPnl(leg, S, t, DEFAULT_RATE, iv) : legPnl(leg, S, t, DEFAULT_RATE)
      if (Number.isFinite(p)) total += p
    }
    return total
  })
}

/** POP, EV and the worst-5% mean of a book against an already drawn distribution. */
export function statsOf(legs: readonly PayoffLeg[], d: Distribution, realised: number): ViewStats | null {
  try {
    const book = (Array.isArray(legs) ? legs : []).filter((l): l is PayoffLeg => l !== null && typeof l === 'object')
    const banked = finite(realised) ?? 0
    const pnl = outcomes(book, d, banked)
    let ev = 0
    let green = 0
    for (let i = 0; i < pnl.length; i++) {
      const w = d.weights[i] as number
      const v = pnl[i] as number
      ev += w * v
      if (v >= 0) green += w
    }
    // The worst 5%: outcomes ascending (ties by index, so the order is total),
    // weights taken until they reach 5%, the last bin pro rata.
    const order = pnl.map((_, i) => i).sort((a, b) => (pnl[a] as number) - (pnl[b] as number) || a - b)
    let need = TAIL
    let tail = 0
    for (const i of order) {
      if (need <= 0) break
      const take = Math.min(need, d.weights[i] as number)
      tail += take * (pnl[i] as number)
      need -= take
    }
    const cvar5 = need < TAIL ? tail / (TAIL - need) : banked
    return {
      pop: fold(Math.max(0, Math.min(100, 100 * green))),
      ev: fold(ev),
      cvar5: fold(cvar5),
      sigma: fold(d.sigma),
    }
  } catch {
    return null
  }
}

/**
 * The book's RUN P&L at the horizon under `view`: POP (0–100), EV and CVaR 5%
 * in rupees, realised included, and the σ drawn.
 *
 * `atmIv`, when given, is the vol 'implied' and 'shift' draw the distribution
 * at (the chain's ATM IV); otherwise the mean of the book's option IVs. Null
 * when the view cannot be drawn — see the header.
 */
export function evaluateUnderView(
  legs: readonly PayoffLeg[],
  future: number,
  today: string,
  realised: number,
  view: MarketView,
  atmIv?: number,
): ViewStats | null {
  const d = drawDistribution(legs, future, today, view, atmIv)
  return d === null ? null : statsOf(legs, d, realised)
}
