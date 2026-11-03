/**
 * One leg of a book, and what it is worth.
 *
 * A port of `sensibull_tools/sim/optimizer/legs.py`, with ONE deliberate change
 * of shape: `qty` is SIGNED SHARES.
 *
 * The Python carries `lots`, `lot_size` and a `side` string, and every consumer
 * multiplies them back together itself — `shares(leg) * _sign(leg)` appears in
 * the P&L, in the greeks, in the expiry payoff, in the margin scenario grid and
 * in the book roll-up. Five reconstructions of the same number is five chances
 * to drop the sign, and the one that matters (a short strangle read as long)
 * inverts the delta the desk hedges on. Here the sign is applied ONCE, at the
 * boundary (`fromPyLeg`), and everything downstream is a plain multiplication.
 * Nothing in this package ever asks "was it a buy or a sell".
 *
 * Options are priced BLACK-76 off `F`, the future — never Black-Scholes on
 * spot. Feeding a future into spot-BS double-counts carry, and the desk marks,
 * hedges and margins against the near-month future. Futures legs are linear and
 * need no model at all.
 *
 * FAIL-SOFT IS A REQUIREMENT, not politeness. These functions are called inside
 * a payoff surface that walks hundreds of futures prices x a book of legs; a
 * leg with no IV must cost that walk a zero, not a stack trace, and must never
 * emit a NaN that then propagates silently through every sum downstream. (The
 * Python is fail-soft by try/except and DOES let a NaN entry through; we close
 * that hole — see `finite` below.)
 */
import { b76Price, b76Greeks, type B76Greeks, type OptionType } from '@algomaker/greeks'

/**
 * The desk-wide risk-free rate, matching `sensibull_tools.pricing.RISK_FREE`
 * and `bookGreeks` in `@algomaker/greeks`. In Black-76 it only discounts — the
 * carry is already inside `F`.
 */
export const DEFAULT_RATE = 0.065

const ZERO_GREEKS: B76Greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 }

/**
 * A position or candidate leg, normalised.
 *
 * `strike`, `type` and `iv` are `null` rather than absent because a futures leg
 * genuinely HAS no strike and an option we could not back a vol out of is a
 * real, common state (deep wings on the near expiry) — an absent key would make
 * "unpriceable" indistinguishable from "the caller forgot".
 */
export interface PayoffLeg {
  readonly id: string
  readonly instrument: 'option' | 'future'
  /** SIGNED shares (contracts x lot size). Negative is short. Never lots. */
  readonly qty: number
  /** `null` for futures. */
  readonly strike: number | null
  /** `null` for futures. */
  readonly type: OptionType | null
  /** ISO `YYYY-MM-DD`. Carried for display and grouping; pricing takes `t`. */
  readonly expiry: string
  /** PER-SHARE entry price, in rupees. */
  readonly entry: number
  /** Per-leg vol as a decimal (0.28 = 28%). `null` = unpriceable, worth 0. */
  readonly iv: number | null
}

/** A finite number, or null. Accepts Python's numeric strings; rejects NaN. */
function finite(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Convert one Python leg dict — `{instrument, side, lots, lot_size, strike,
 * opt_type, series, expiry, entry, iv, id}` — into a `PayoffLeg`.
 *
 * EXISTS FOR THE PARITY SUITES. Nothing in the running system speaks the Python
 * dict shape; the bridge builds `PayoffLeg`s directly. It lives in `src/` and
 * not in `test/` only because the golden fixtures are the contract between the
 * two desks, and a converter that drifts from the shipped type is how a parity
 * suite starts proving something other than the code.
 *
 * SIGN: the Python's own rule is `+1` iff `side` is `"buy"` (trimmed,
 * case-insensitive) and `-1` for everything else, INCLUDING a missing side —
 * `legs.py:_sign`. That is the rule applied here, because the input is a Python
 * dict and its meaning is the Python's to define. It agrees with "Sell → −1,
 * otherwise +1" on every value that actually occurs in a book.
 *
 * Fail-soft: anything unparseable degrades to a leg worth zero (`qty: 0`,
 * `entry: 0`) rather than throwing, mirroring `shares()`'s except-return-0.
 */
export function fromPyLeg(py: Record<string, unknown>): PayoffLeg {
  const src: Record<string, unknown> = py !== null && typeof py === 'object' ? py : {}
  const sign = String(src['side'] ?? '').trim().toLowerCase() === 'buy' ? 1 : -1
  // `Math.trunc` is `int()`: the Python truncates lots and lot size before
  // multiplying, so a fractional lot cannot smuggle a fractional share count in.
  const lots = Math.trunc(finite(src['lots']) ?? 0)
  const lotSize = Math.trunc(finite(src['lot_size']) ?? 0)
  const optType = src['opt_type']
  // `0 * n * -1` is NEGATIVE zero, which is a stored value here rather than an
  // intermediate: it survives into JSON, into `Object.is`/`deepStrictEqual`, and
  // into any consumer that keys on the leg record. `=== 0 ? 0` folds it away.
  const qty = lots * lotSize * sign
  return {
    id: typeof src['id'] === 'string' ? src['id'] : '',
    instrument: src['instrument'] === 'future' ? 'future' : 'option',
    qty: qty === 0 ? 0 : qty,
    strike: finite(src['strike']),
    type: optType === 'CE' || optType === 'PE' ? optType : null,
    expiry: typeof src['expiry'] === 'string' ? src['expiry'] : '',
    entry: finite(src['entry']) ?? 0,
    iv: finite(src['iv']),
  }
}

/**
 * Mark-to-market P&L of one leg at future price `F` and time-to-expiry `t`
 * (YEARS), measured against the leg's own entry. Rupees, already qty-scaled.
 *
 * `ivOverride` reprices the leg at a different vol without the caller cloning
 * it. The SPAN-lite scenario grid (Task 6) walks ±vol shocks over every leg of
 * every book; without this it would allocate a copy of each option leg per grid
 * point, per margin call.
 */
export function legPnl(
  leg: PayoffLeg,
  F: number,
  t: number,
  rate: number = DEFAULT_RATE,
  ivOverride?: number,
): number {
  if (leg === null || typeof leg !== 'object') return 0
  const future = finite(F)
  const time = finite(t)
  const r = finite(rate)
  const qty = finite(leg.qty)
  const entry = finite(leg.entry)
  if (future === null || time === null || r === null || qty === null || entry === null) return 0

  if (leg.instrument === 'future') return qty * (future - entry)
  if (leg.instrument !== 'option') return 0

  const strike = finite(leg.strike)
  const vol = finite(ivOverride ?? leg.iv)
  if (strike === null || vol === null || leg.type === null) return 0
  const mark = b76Price({ future, strike, t: time, vol, rate: r, type: leg.type })
  if (!Number.isFinite(mark)) return 0
  return qty * (mark - entry)
}

/**
 * Greeks of one leg, ALREADY SCALED by the signed qty — so a book's net greeks
 * are a plain sum, with no per-caller sign or lot arithmetic left to get wrong.
 *
 * Units follow `@algomaker/greeks`: delta per 1 point of FUTURE, theta per
 * calendar day, vega per 1 vol point. A futures leg is pure delta (= its qty)
 * with no convexity, no decay and no vega.
 *
 * No `ivOverride` here, matching the Python: the shocked-vol path needs P&L,
 * not greeks, and an override on both would invite the two to be shocked
 * inconsistently within one scenario.
 */
export function legGreeks(
  leg: PayoffLeg,
  F: number,
  t: number,
  rate: number = DEFAULT_RATE,
): B76Greeks {
  if (leg === null || typeof leg !== 'object') return { ...ZERO_GREEKS }
  const future = finite(F)
  const time = finite(t)
  const r = finite(rate)
  const qty = finite(leg.qty)
  if (future === null || time === null || r === null || qty === null) return { ...ZERO_GREEKS }

  if (leg.instrument === 'future') return { delta: qty, gamma: 0, theta: 0, vega: 0 }
  if (leg.instrument !== 'option') return { ...ZERO_GREEKS }

  const strike = finite(leg.strike)
  const vol = finite(leg.iv)
  if (strike === null || vol === null || leg.type === null) return { ...ZERO_GREEKS }
  const g = b76Greeks({ future, strike, t: time, vol, rate: r, type: leg.type })
  const scaled = {
    delta: g.delta * qty,
    gamma: g.gamma * qty,
    theta: g.theta * qty,
    vega: g.vega * qty,
  }
  // b76Greeks is itself fail-soft (zeros on a degenerate input), so this only
  // catches an infinite qty times a zero greek. Cheap, and it keeps the promise
  // that nothing NaN ever leaves this package.
  return Object.values(scaled).every(Number.isFinite) ? scaled : { ...ZERO_GREEKS }
}
