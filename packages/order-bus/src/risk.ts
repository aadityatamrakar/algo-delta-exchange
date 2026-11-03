/**
 * The desk's exposure limits — the loss stop and the capacity caps.
 *
 * Pure function of (order, limits, snapshot), so every decision is
 * reproducible in a test. The desk API gates BOTH of its live rails on
 * `checkExposureLimits`, through `apps/api/src/submit-plan.ts:screenRiskGate`
 * and `apps/api/src/decision-plan.ts:splitByRisk` (audit F-28). The kill switch
 * and the live allowlist are the API's own gates (`safety.ts`, the strategy
 * switch), not this module's.
 */

import type { ExposureLimits, ExposureState, RiskRejection, RiskSnapshot } from './types.ts'

export type RiskVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly rejection: RiskRejection }

const allow: RiskVerdict = { allowed: true }
const deny = (code: RiskRejection['code'], detail: string): RiskVerdict => ({
  allowed: false,
  rejection: { code, detail } as RiskRejection,
})

/**
 * The part of an order the capacity limits are about. A strict subset of
 * `OrderIntent`, so an intent passes straight in.
 */
export interface ExposureOrder {
  readonly lots: number
  /** Contract quantity, already multiplied out from lots. */
  readonly quantity: number
  readonly limitPrice?: number
}

/**
 * THE LOSS STOP AND THE CAPACITY CAPS, as the desk API gates its live rails
 * (audit F-28) — no `OrderIntent`, no allowlist, no kill switch.
 *
 * **IT NEVER BLOCKS AN EXIT.** One rule, stated once, for every limit here —
 * the same asymmetry the kill switch has in `safety.ts` and in
 * `submit-plan.ts`: a position keeps moving whether or not you can act on it,
 * so a control that traps one is worse than whatever it was protecting against.
 * The lot caps already carried the exemption; the rate limit and the notional
 * cap did not, and an exit refused for being the 61st order of the minute is
 * the same trap wearing a different code.
 *
 * `Infinity` on a limit disables it, which is what makes the whole thing opt-in
 * — see `NO_EXPOSURE_LIMITS`.
 */
export function checkExposureLimits(
  order: ExposureOrder,
  limits: ExposureLimits,
  snap: RiskSnapshot,
): RiskVerdict {
  if (snap.isReducingExposure) return allow

  /**
   * A COUNT THAT MISSED PART OF THE BOOK IS NOT A COUNT.
   *
   * `unmeasuredSymbols` lists held legs whose lots could not be derived — the
   * instrument master no longer resolves them (an expired-but-still-held
   * contract, the MIRROR/SENSEX shape). Their lots are therefore ABSENT from
   * `openLotsTotal`, so every cap below would be judged against an under-count
   * and would admit exposure the desk does not have room for. The measurement
   * fails OPEN unless this refuses.
   *
   * Same rule, same asymmetry as a `null` measurement in the API's
   * `screenRiskGate`/`splitByRisk`: refuse NEW exposure, never an exit — which
   * the return above has already granted. The symbols are NAMED so the operator
   * can fix the one thing that will clear it.
   */
  const unmeasured = snap.unmeasuredSymbols ?? []
  if (unmeasured.length > 0) {
    return deny(
      'UNMEASURED_EXPOSURE',
      `exposure could not be fully measured — ${unmeasured.join(', ')} ` +
        `${unmeasured.length === 1 ? 'is' : 'are'} not in the instrument master`,
    )
  }

  // Stop opening, keep closing.
  if (snap.dayLoss >= limits.maxDailyLoss) {
    return deny(
      'DAILY_LOSS',
      `day loss ${snap.dayLoss} >= limit ${limits.maxDailyLoss}; only exits allowed`,
    )
  }

  const windowStart = snap.nowMs - 60_000
  const recent = snap.recentOrderTs.filter((t) => t > windowStart).length
  if (recent >= limits.maxOrdersPerMinute) {
    return deny(
      'RATE_LIMIT',
      `${recent} orders in the last 60s >= limit ${limits.maxOrdersPerMinute}`,
    )
  }

  const perUnderlying = snap.openLotsByUnderlying[snap.underlying] ?? 0
  if (perUnderlying + order.lots > limits.maxOpenLotsPerUnderlying) {
    return deny(
      'MAX_LOTS_UNDERLYING',
      `${snap.underlying}: ${perUnderlying} + ${order.lots} > ${limits.maxOpenLotsPerUnderlying}`,
    )
  }
  if (snap.openLotsTotal + order.lots > limits.maxOpenLotsTotal) {
    return deny(
      'MAX_LOTS_TOTAL',
      `total ${snap.openLotsTotal} + ${order.lots} > ${limits.maxOpenLotsTotal}`,
    )
  }

  // Notional is only checkable with a price. An unpriced MARKET order is
  // allowed through rather than blocked on missing data — the lots caps above
  // already bound exposure.
  const price = order.limitPrice ?? snap.price
  if (price !== null && price !== undefined && Number.isFinite(price)) {
    const notional = price * order.quantity
    if (notional > limits.maxNotionalPerOrder) {
      return deny(
        'MAX_NOTIONAL',
        `notional ${notional.toFixed(0)} > limit ${limits.maxNotionalPerOrder}`,
      )
    }
  }

  return allow
}

/**
 * EVERY LIMIT DISABLED. The state a desk that has configured nothing runs in,
 * and therefore the state this module ships in: wiring the gate onto the live
 * rails changes nothing at all until an operator sets a value.
 *
 * `Infinity` rather than `null`-per-field so every comparison above stays one
 * comparison. `x > Infinity` and `x >= Infinity` are both false for any finite
 * x, so a disabled limit cannot refuse anything.
 */
export const NO_EXPOSURE_LIMITS: ExposureLimits = {
  maxOrdersPerMinute: Number.POSITIVE_INFINITY,
  maxOpenLotsPerUnderlying: Number.POSITIVE_INFINITY,
  maxOpenLotsTotal: Number.POSITIVE_INFINITY,
  maxNotionalPerOrder: Number.POSITIVE_INFINITY,
  maxDailyLoss: Number.POSITIVE_INFINITY,
}

/** True when at least one limit is configured, i.e. the gate can refuse at all. */
export function anyExposureLimitSet(limits: ExposureLimits): boolean {
  return Object.values(limits).some((v) => Number.isFinite(v))
}

const LIMIT_ENV: readonly (readonly [keyof ExposureLimits, string])[] = [
  ['maxDailyLoss', 'DESK_RISK_MAX_DAY_LOSS'],
  ['maxOpenLotsTotal', 'DESK_RISK_MAX_TOTAL_LOTS'],
  ['maxOpenLotsPerUnderlying', 'DESK_RISK_MAX_UNDERLYING_LOTS'],
  ['maxNotionalPerOrder', 'DESK_RISK_MAX_NOTIONAL'],
  ['maxOrdersPerMinute', 'DESK_RISK_MAX_ORDERS_PER_MIN'],
]

/** Which variable configures which refusal, so a refusal can name its own knob. */
const ENV_BY_CODE: Partial<Record<RiskRejection['code'], string>> = {
  DAILY_LOSS: 'DESK_RISK_MAX_DAY_LOSS',
  MAX_LOTS_TOTAL: 'DESK_RISK_MAX_TOTAL_LOTS',
  MAX_LOTS_UNDERLYING: 'DESK_RISK_MAX_UNDERLYING_LOTS',
  MAX_NOTIONAL: 'DESK_RISK_MAX_NOTIONAL',
  RATE_LIMIT: 'DESK_RISK_MAX_ORDERS_PER_MIN',
}

/**
 * ONE WORDING FOR A RISK REFUSAL, on every rail that has this gate.
 *
 * The operator's question is "which limit stopped this, and by how much" and
 * the only place it can be answered is the order log — so the code, the
 * MEASURED value, the limit (both already inside `detail`) and the variable
 * that sets it all go into the one string both rails journal. Two rails
 * formatting their own would be two things to grep for.
 */
export function riskRefusalReason(rejection: RiskRejection): string {
  const env = ENV_BY_CODE[rejection.code]
  const knob = env === undefined ? '' : ` (limit set by ${env})`
  return `risk limit ${rejection.code}: ${rejection.detail}${knob}`
}

/**
 * The limits an operator actually asked for. UNSET MEANS DISABLED — each
 * variable is independent, so a desk can run a daily loss stop and nothing else.
 *
 * A value that cannot be used THROWS at boot rather than falling back to the
 * default (`positiveEnvMs`'s rule, inverted, and deliberately): a typo'd
 * duration costs a cadence, but a typo'd risk limit would leave the operator
 * believing in a stop that is not there — which is precisely the "green tests
 * imply protection that isn't there" defect this wiring exists to close.
 */
export function exposureLimitsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ExposureLimits {
  const out: Record<string, number> = { ...NO_EXPOSURE_LIMITS }
  for (const [field, name] of LIMIT_ENV) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${name}='${raw}' is not a positive number — unset it to disable the limit`)
    }
    out[field] = n
  }
  return out as unknown as ExposureLimits
}

/** Rolling window of accepted-order timestamps, for the rate check. */
export class OrderRateWindow {
  #ts: number[] = []

  record(nowMs: number): void {
    this.#ts.push(nowMs)
    this.prune(nowMs)
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - 60_000
    // Timestamps arrive in order, so drop from the front.
    let i = 0
    while (i < this.#ts.length && (this.#ts[i] as number) <= cutoff) i++
    if (i > 0) this.#ts.splice(0, i)
  }

  snapshot(): readonly number[] {
    return this.#ts
  }

  get size(): number {
    return this.#ts.length
  }
}

/** One admitted-but-not-yet-visible open. */
interface Reservation {
  readonly at: number
  readonly lots: number
  readonly underlying: string
}

/**
 * LOTS THIS PROCESS HAS ALREADY ADMITTED, held until the measurement can see
 * them — the thing that stops N concurrent decisions from spending one cap N
 * times.
 *
 * WHY IT IS NEEDED AT ALL, given the book updates at journal time. It does:
 * fills reach `LiveBook.onJournal` SYNCHRONOUSLY, in this process, before the
 * request returns, so a later decision's measurement does include them. What it
 * does not cover is the window between two decisions that read the SAME
 * measurement — the API caches the exposure read for `DESK_RISK_EXPOSURE_TTL_MS`
 * because it costs a full P&L re-mark, and three decisions inside those two
 * seconds each see the same pre-fill snapshot. 40 open + 10 <= 50 then passes
 * three times and the desk ends at 70. This ledger is what the second and third
 * see the first through. Belt and braces over the journal-time update, never a
 * replacement for it.
 *
 * THE TTL IS DELIBERATELY LONGER THAN THE CACHE'S (the API uses ~3x): a
 * reservation must outlive the cached measurement that cannot see it, and it
 * must expire on its own so a route that failed, or a fill that never came
 * back, cannot hold capacity for the rest of the session. Over-counting for a
 * few seconds refuses an order the desk had room for; under-counting places one
 * it did not.
 *
 * PER PROCESS, and that is honest about what it can do — two API processes
 * would still race. The cap is a desk-wide control with a per-process ledger in
 * front of it, exactly like `OrderRateWindow` above.
 */
export class ReservationLedger {
  readonly #ttlMs: number
  #rows: Reservation[] = []

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs
  }

  /** Hold `lots` against the caps until the measurement can see them. */
  reserve(lots: number, underlying: string, nowMs: number): void {
    if (!(lots > 0)) return
    this.prune(nowMs)
    this.#rows.push({ at: nowMs, lots, underlying })
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.#ttlMs
    this.#rows = this.#rows.filter((r) => r.at > cutoff)
  }

  /**
   * The measurement with everything in flight folded in. Returns a NEW state —
   * the caller's cached value must not gain lots every time it is read.
   */
  applyTo(state: ExposureState, nowMs: number): ExposureState {
    this.prune(nowMs)
    if (this.#rows.length === 0) return state
    const byUnderlying: Record<string, number> = { ...state.openLotsByUnderlying }
    let total = state.openLotsTotal
    for (const r of this.#rows) {
      total += r.lots
      byUnderlying[r.underlying] = (byUnderlying[r.underlying] ?? 0) + r.lots
    }
    return { ...state, openLotsTotal: total, openLotsByUnderlying: byUnderlying }
  }

  get size(): number {
    return this.#rows.length
  }
}
