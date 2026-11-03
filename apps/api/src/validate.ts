/**
 * Request validation.
 *
 * Hand-written rather than zod: this is the only untrusted boundary in the app,
 * the shapes are small and fixed, and every rejection message here names the
 * exact field — which is what makes a failing pm2 client debuggable from its own
 * log instead of from ours.
 *
 * Strictness is deliberate. A malformed action that slips through does not fail
 * loudly; it books a position at the wrong size or against the wrong contract.
 * So every numeric field is checked for finiteness (not just type: `NaN` and
 * `Infinity` are both `number`), and every enum is checked against its literal
 * set rather than cast.
 *
 * `validateActionsRequest` USED TO LIVE HERE, and went with `POST
 * /v1/desk/actions` in the D9 cutover. The desk's decisions now arrive at
 * `POST /v1/desk/engine/decisions`, whose wire addresses real INSTRUMENTS
 * rather than the Python engine's `CE530#3` leg ids — and `routes/engine.ts`
 * owns its validation, beside the request shape it validates. The primitives
 * below (`isObject`, `isFiniteNumber`, `isIsoDate`, `fail`/`ok`) are shared
 * with it and with `books-registry.ts`, which is why they stay exported here
 * rather than being re-derived, possibly more loosely, in three places.
 */

import type { DeskMode } from './contract.ts'
import type { DeclaredLeg } from './book.ts'

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

// Exported so other validators over this boundary (books-registry.ts) reuse
// these instead of re-deriving their own, possibly looser, copy.
export const fail = (error: string): Validated<never> => ({ ok: false, error })
export const ok = <T>(value: T): Validated<T> => ({ ok: true, value })

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * 'YYYY-MM-DD', and a real date — '2026-13-45' matches a loose regex but is not one.
 *
 * EXPORTED for `migrate.ts`, which has to hold a one-shot irreversible write to
 * the same standard the HTTP surface holds a request to. It used to coerce with
 * `String(leg.expiry)`, which turns a missing expiry into the literal
 * `'undefined'` — a non-empty string that passed every "is it set?" check and
 * would have been written into a live options book before the source was
 * deleted.
 */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * The most aggression an exit may be priced with: 25% through the mark.
 *
 * A CEILING, not a preference. `safety.ts:priceExit` computes
 * `mark × (1 + aggression)` for a closing buy with no bound of its own, so
 * `aggressionPct: 5` — the natural way to mistype "5%" — buys a ₹40 short back
 * at a ₹240 limit. 25% is already far past anything the desk uses (0.02 is the
 * dashboard's default) and still leaves a violent-but-deliberate exit possible.
 */
export const MAX_AGGRESSION_PCT = 0.25

/**
 * Why aggression is refused, or null when it is absent or usable.
 *
 * ABSENT IS FINE and means "no aggression": every caller spreads it in only
 * when present, and the exit planner has its own default. What is not fine is
 * a number that reaches the money path unchecked — F-34 found all three flatten
 * call sites doing exactly that, on the one control an operator uses to get out
 * of a position.
 */
export function aggressionPctError(raw: unknown): string | null {
  if (raw === undefined) return null
  if (!isFiniteNumber(raw)) {
    return `aggressionPct must be a finite number between 0 and ${MAX_AGGRESSION_PCT} (a FRACTION, so 2% is 0.02)`
  }
  if (raw < 0 || raw > MAX_AGGRESSION_PCT) {
    return (
      `aggressionPct ${raw} is outside [0, ${MAX_AGGRESSION_PCT}] — it is a FRACTION of the mark, ` +
      `so 2% is 0.02. At ${raw} a ₹40 short would be bought back at ₹${(40 * (1 + raw)).toFixed(2)}.`
    )
  }
  return null
}

export interface SeedRequestBody {
  /** The book's identity. Books are keyed by tag; see store.ts. */
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly replace: boolean
  readonly legs: readonly { strike: number; type: 'CE' | 'PE'; qty: number; rate: number }[]
}

/**
 * Seeding writes a book directly, with no orders routed — it records positions
 * already held at the broker. That makes it the one endpoint that can invent a
 * position out of nothing, so it validates at least as strictly as `actions`,
 * and `replace` must be stated rather than inferred.
 */
export function validateSeedRequest(raw: unknown): Validated<SeedRequestBody> {
  if (!isObject(raw)) return fail('body must be a JSON object')
  if (!isNonEmptyString(raw['symbol'])) return fail('symbol is required')
  if (!isIsoDate(raw['expiry'])) return fail("expiry is required as 'YYYY-MM-DD'")
  if (!isNonEmptyString(raw['tag'])) return fail('tag is required')
  if (raw['mode'] !== 'paper' && raw['mode'] !== 'live') {
    return fail("mode must be stated explicitly as 'paper' or 'live'")
  }
  if (raw['replace'] !== undefined && typeof raw['replace'] !== 'boolean') {
    return fail('replace must be a boolean when present')
  }
  const rawLegs = raw['legs']
  if (!Array.isArray(rawLegs) || rawLegs.length === 0) {
    return fail('legs must be a non-empty array')
  }

  const legs: { strike: number; type: 'CE' | 'PE'; qty: number; rate: number }[] = []
  for (let i = 0; i < rawLegs.length; i++) {
    const l = rawLegs[i]
    if (!isObject(l)) return fail(`legs[${i}] is not an object`)
    if (!isFiniteNumber(l['strike'])) return fail(`legs[${i}].strike must be a finite number`)
    if (l['type'] !== 'CE' && l['type'] !== 'PE') return fail(`legs[${i}].type must be 'CE' or 'PE'`)
    if (!isFiniteNumber(l['qty']) || !Number.isInteger(l['qty']) || l['qty'] === 0) {
      return fail(`legs[${i}].qty must be a non-zero integer (short is negative)`)
    }
    // Rate is the price actually PAID, so zero is meaningless and negative is
    // impossible. Seeding at 0 would silently erase the position's cost basis.
    if (!isFiniteNumber(l['rate']) || l['rate'] <= 0) {
      return fail(`legs[${i}].rate must be a positive entry price`)
    }
    legs.push({ strike: l['strike'], type: l['type'], qty: l['qty'], rate: l['rate'] })
  }
  return ok({
    tag: raw['tag'],
    symbol: raw['symbol'],
    expiry: raw['expiry'],
    mode: raw['mode'] as DeskMode,
    replace: raw['replace'] === true,
    legs,
  })
}

/**
 * The STRATEGY'S OWN greeks, as the Python desk computed them.
 *
 * `spot` is the reference they were computed AGAINST — the future, not cash —
 * and is carried so the dashboard can say so rather than leave a reader to
 * assume it matches the cash spot printed elsewhere on the page.
 */
export interface DeclaredGreeks {
  readonly delta: number
  readonly gamma: number
  readonly theta: number
  readonly vega: number
  readonly spot: number
  readonly dte: number
  /**
   * WHAT THE RULES STEER BY, when that is not the whole book.
   *
   * Under `delta_shorts_only` / `gamma_shorts_only` — set on every live
   * recenter-relief-r book — the strategy reads its SHORT legs only, and the
   * gap is not cosmetic: on BHEL 2026-08-14 the book was +408 delta while the
   * shorts alone were -1836, opposite signs, because the long hedge legs carry
   * most of the positive delta. The tiles showed the first and the Strategy
   * panel the second, which read as a contradiction.
   *
   * Both are correct and they answer different questions. Absent when the
   * decider reports none, so "not measured" stays distinct from zero.
   */
  readonly steeringDelta?: number
  readonly steeringGamma?: number
}

export interface DeclareRequest {
  /** The book's identity. Books are keyed by tag; see store.ts. */
  readonly tag: string
  readonly symbol: string
  readonly legs: readonly DeclaredLeg[]
  /** Absent when the strategy had no usable mark — never zeroed. */
  readonly greeks?: DeclaredGreeks
}

export function validateDeclareRequest(raw: unknown): Validated<DeclareRequest> {
  if (!isObject(raw)) return fail('body must be a JSON object')
  if (!isNonEmptyString(raw['symbol'])) return fail('symbol is required')
  if (!isNonEmptyString(raw['tag'])) return fail('tag is required')
  const rawLegs = raw['legs']
  if (!Array.isArray(rawLegs)) return fail('legs must be an array')

  const legs: DeclaredLeg[] = []
  for (let i = 0; i < rawLegs.length; i++) {
    const l = rawLegs[i]
    if (!isObject(l)) return fail(`legs[${i}] is not an object`)
    if (!isFiniteNumber(l['strike'])) return fail(`legs[${i}].strike must be a finite number`)
    if (l['type'] !== 'CE' && l['type'] !== 'PE') return fail(`legs[${i}].type must be 'CE' or 'PE'`)
    if (!isFiniteNumber(l['qty']) || !Number.isInteger(l['qty'])) {
      return fail(`legs[${i}].qty must be an integer SIGNED contract quantity (short is negative)`)
    }
    legs.push({ strike: l['strike'], type: l['type'], qty: l['qty'] })
  }
  /**
   * GREEKS ARE OPTIONAL, AND ALL-OR-NOTHING.
   *
   * A declaration from before this field existed, or a mark that failed, sends
   * none — and that must keep working rather than 400, because refusing the
   * declaration would also lose the LEGS, which is the thing D2's diff is for.
   *
   * When they ARE sent, a partial or unparseable set is refused rather than
   * half-stored: the dashboard renders these as the authoritative delta, and
   * half a greek set rendered as though it were whole is worse than none.
   */
  const rawGreeks = raw['greeks']
  if (rawGreeks === undefined || rawGreeks === null) {
    return ok({ tag: raw['tag'], symbol: raw['symbol'], legs })
  }
  if (!isObject(rawGreeks)) return fail('greeks must be an object when present')
  const keys = ['delta', 'gamma', 'theta', 'vega', 'spot', 'dte'] as const
  const g: Record<string, number> = {}
  for (const k of keys) {
    if (!isFiniteNumber(rawGreeks[k])) return fail(`greeks.${k} must be a finite number`)
    g[k] = rawGreeks[k]
  }
  // A zero reference price is `mark_book`'s fail-soft return, not a measurement.
  if ((g['spot'] as number) <= 0) return fail('greeks.spot must be the price they were computed against')
  /*
    THE STEERING PAIR IS OPTIONAL AND ALL-OR-NOTHING, like the set it rides on.
    A decider without the seam sends neither, and one that sends half of it is
    refused rather than half-stored — a lone steering delta rendered beside the
    book's would be read as a comparison when it is not one.
  */
  const sd = rawGreeks['steeringDelta']
  const sgm = rawGreeks['steeringGamma']
  const hasSteering = sd !== undefined || sgm !== undefined
  if (hasSteering && (!isFiniteNumber(sd) || !isFiniteNumber(sgm))) {
    return fail('steeringDelta and steeringGamma must both be finite numbers when either is sent')
  }
  return ok({
    tag: raw['tag'],
    symbol: raw['symbol'],
    legs,
    greeks: {
      delta: g['delta'] as number, gamma: g['gamma'] as number,
      theta: g['theta'] as number, vega: g['vega'] as number,
      spot: g['spot'] as number, dte: g['dte'] as number,
      ...(hasSteering ? { steeringDelta: sd as number, steeringGamma: sgm as number } : {}),
    },
  })
}
