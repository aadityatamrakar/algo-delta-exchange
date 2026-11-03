/**
 * What the book is worth if it is simply carried to expiry — exactly.
 *
 * A port of `expiry_pnl_at` and `expiry_breakevens`
 * (`sensibull_tools/sim/book.py`), the two figures a short-premium desk defends
 * a position with. No model lives in this file: at expiry an option is worth
 * its intrinsic value and nothing else, so this is multiply-and-add on
 * `max(±(S−K), 0)`. No Black-76, no IV, no surface, and therefore no way for a
 * vol assumption to flatter the payoff a trader is reading at 15:15.
 *
 * KINKS, NOT A LADDER. The expiry payoff is piecewise-linear in the underlying
 * with kinks ONLY at the strikes. Evaluating at every strike plus two outer
 * endpoints and interpolating linearly between adjacent points therefore cannot
 * miss a crossing or misplace one — it is both cheaper (O(strikes x legs)) and
 * strictly more accurate than walking a price grid, which can only ever bracket
 * a breakeven to within its own step size.
 */
import type { PayoffLeg } from './legs.ts'
import type { OptionType } from '@algomaker/greeks'

function intrinsic(price: number, strike: number, type: OptionType): number {
  return type === 'CE' ? Math.max(price - strike, 0) : Math.max(strike - price, 0)
}

/**
 * P&L of the legs AS HELD if carried to expiry and settled at `price`, measured
 * against each leg's own entry. Rupees.
 *
 * OPEN LEGS ONLY — this deliberately knows nothing about P&L already banked by
 * closes. `expiryBreakevens` is where realised money enters, because that is
 * the question ("where does the RUN break even") that needs it; a payoff curve
 * shifted by realised P&L would claim the surviving legs are worth more than
 * they are. The golden fixture encodes exactly this asymmetry.
 *
 * Fail-soft, and slightly STRICTER than the Python it ports: a leg this cannot
 * value is skipped, contributing nothing, rather than poisoning the whole sum
 * with a NaN. The Python's try/except catches a missing strike but still lets a
 * NaN entry (or a NaN `price`) through into the total, and it treats any
 * instrument that is not `"future"` as an option; here both degrade to zero.
 * No fixture leg is affected — the divergence is only over input the desk
 * should never produce.
 */
export function expiryPnlAt(legs: readonly PayoffLeg[], price: number): number {
  if (!Number.isFinite(price)) return 0
  let total = 0
  for (const leg of legs ?? []) {
    if (leg === null || typeof leg !== 'object') continue
    const { qty, entry } = leg
    if (!Number.isFinite(qty) || !Number.isFinite(entry)) continue
    if (leg.instrument === 'future') {
      total += qty * (price - entry)
      continue
    }
    if (leg.instrument !== 'option') continue
    const { strike, type } = leg
    if (strike === null || !Number.isFinite(strike) || type === null) continue
    total += qty * (intrinsic(price, strike, type) - entry)
  }
  return total
}

/**
 * The prices at which carrying this book to expiry breaks even — the crossing
 * NEAREST spot on each side.
 *
 * `null` on a side means UNBOUNDED SAFETY there, not missing data: the payoff
 * never crosses zero in that direction. A naked short call has `down: null`,
 * because no price on the way to zero can take the credit away.
 *
 * `realized` shifts the whole curve by P&L already banked, turning "where do
 * the surviving legs break even" into "where does the RUN break even". Without
 * it the measure is blind to every loss a close has crystallised — worse, a
 * close-and-re-sell launders its own breach out of the reading. Default 0
 * keeps the open-legs-only answer.
 */
export interface ExpiryBreakevens {
  /** Nearest crossing at or below spot, or null if the book never crosses down. */
  readonly down: number | null
  /** Nearest crossing above spot, or null if the book never crosses up. */
  readonly up: number | null
}

const NO_BREAKEVENS: ExpiryBreakevens = { down: null, up: null }

export function expiryBreakevens(
  legs: readonly PayoffLeg[],
  spot: number,
  realized: number = 0,
): ExpiryBreakevens {
  if (!Number.isFinite(spot)) return { ...NO_BREAKEVENS }
  const banked = Number.isFinite(realized) ? realized : 0

  const strikes = new Set<number>()
  for (const leg of legs ?? []) {
    if (leg === null || typeof leg !== 'object') continue
    if (leg.strike !== null && Number.isFinite(leg.strike)) strikes.add(leg.strike)
  }
  // No strikes means no kinks: a futures-only book is a straight line whose
  // "breakeven" is just its own entry, which the P&L already says. Reporting a
  // crossing here would invent a level the desk does not defend.
  if (strikes.size === 0 || spot <= 0) return { ...NO_BREAKEVENS }

  // The kinks, plus endpoints far enough out that both outer linear arms are
  // covered by a segment. 3x the widest strike is the Python's own choice.
  const outer = Math.max(Math.max(...strikes), spot) * 3
  const xs = [...new Set([...strikes, 0, spot, outer])].sort((a, b) => a - b)
  const ys = xs.map((x) => expiryPnlAt(legs, x) + banked)

  const below: number[] = []
  const above: number[] = []
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i]
    const x1 = xs[i + 1]
    const y0 = ys[i]
    const y1 = ys[i + 1]
    if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) continue
    let cross: number | null = null
    // A kink sitting exactly on zero IS a breakeven, and is taken as the point
    // itself — checked BEFORE the sign change, so a segment that both starts at
    // zero and crosses reports the kink rather than an interpolated twin.
    if (y0 === 0) cross = x0
    else if ((y0 < 0 && y1 > 0) || (y1 < 0 && y0 > 0)) {
      cross = x0 + (-y0 / (y1 - y0)) * (x1 - x0)
    }
    if (cross === null) continue
    if (cross <= spot) below.push(cross)
    else above.push(cross)
  }
  // The loop above reads each segment by its LEFT end, so a payoff that is
  // exactly zero at the final point would otherwise be missed. Ported as-is
  // from book.py:134 — note this can report the synthetic 3x endpoint as a
  // breakeven when the payoff is flat at zero out there. That is an artefact of
  // the endpoint, kept because parity with the desk already running beats a
  // cleaner answer only one side computes.
  const lastX = xs[xs.length - 1]
  const lastY = ys[ys.length - 1]
  if (lastX !== undefined && lastY === 0) {
    if (lastX <= spot) below.push(lastX)
    else above.push(lastX)
  }

  return {
    down: below.length > 0 ? Math.max(...below) : null,
    up: above.length > 0 ? Math.min(...above) : null,
  }
}
