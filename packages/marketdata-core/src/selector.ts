/**
 * Instrument selection — "which contract do I trade?" as a pure function.
 *
 * WHY this exists: it replaces `otmSelector`, whose measured defect was
 * returning `0` at 87 of its 93 call sites. Every one of those call sites then
 * added 0 to the ATM strike, so strategies documented and named as OTM sellers
 * were in fact selling ATM — for years, silently, because a plausible number
 * came back instead of a refusal.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *   1. NEVER return an answer that was not asked for. There is no ATM fallback
 *      anywhere in this file. If the requested contract cannot be identified the
 *      answer is `null`, which a caller must handle and which shows up in a log
 *      instead of in a fill.
 *   2. ALWAYS walk the LISTED grid, never an arithmetic one. BHEL's real strike
 *      step is 2.5; `round(spot / 5) * 5` produces strikes that do not exist,
 *      and chains carry gaps where a strike was never listed. Offsets are counted
 *      in listed strikes, so a gap is stepped OVER rather than fallen into.
 *
 * Pure over (chain, marks, spot): no network, no clock beyond the `nowMs` it is
 * handed. Delta needs no new data source — the chain is already subscribed and
 * `@algomaker/greeks` backs IV out of the marks.
 */

import type { InstrumentRef } from '@algomaker/order-bus'
import type { OptionMaster, OptionType } from '@algomaker/instruments'
import { greeks, impliedVol, yearsToExpiry } from '@algomaker/greeks'

export type { OptionType }

/**
 * Mark prices by INSTRUMENT TOKEN.
 *
 * Token-keyed because that is already the shape of the live quote cache — the
 * legacy `ticksCache[token]`, and `SubscriptionRegistry`'s unit. Keying by
 * `strike|type` would mean restringing on every lookup and would lose the link
 * to the contract that was actually subscribed.
 */
export type Marks = ReadonlyMap<number, number>

export type SelectCriteria =
  /**
   * Nearest LISTED strike to spot. `type` is optional here only because the ATM
   * *strike* is a typeless question; `selectOption` still needs a type to name a
   * contract, and refuses rather than defaulting to CE.
   */
  | { readonly by: 'atm'; readonly type?: OptionType }
  /**
   * `steps` listed strikes away from ATM along the ASCENDING grid: positive is
   * higher strikes, negative is lower, regardless of CE/PE.
   *
   * Signed-along-the-grid rather than "N strikes OTM" deliberately. An OTM
   * convention silently flips direction with the option type, which is precisely
   * the kind of implicit rule that made `otmSelector` wrong without looking
   * wrong. A caller wanting an OTM put writes `steps: -2` and can see it.
   */
  | { readonly by: 'offset'; readonly steps: number; readonly type: OptionType }
  /** Listed strike whose |delta| is closest to `target` (target given as 0..1). */
  | { readonly by: 'delta'; readonly target: number; readonly type: OptionType }
  /** Listed strike whose mark is closest to `target` rupees of premium. */
  | { readonly by: 'premium'; readonly target: number; readonly type: OptionType }

export interface SelectInput {
  readonly master: OptionMaster
  readonly underlying: string
  readonly expiry: string
  /** Spot of the underlying. ATM and offset are anchored on it. */
  readonly spot: number
  /** Live marks; required for `delta` and `premium`, unused otherwise. */
  readonly marks?: Marks
  /** Injected, never `Date.now()` — time to expiry drives delta. */
  readonly nowMs: number
  readonly rate?: number
  readonly dividendYield?: number
}

export interface Selection {
  readonly instrument: InstrumentRef
  readonly strike: number
  readonly type: OptionType
  readonly expiry: string
  /** Achieved |delta| for a delta selection — logged so a fill can be explained. */
  readonly delta?: number
  /** Achieved mark for a delta/premium selection. */
  readonly premium?: number
}

/**
 * The listed strike a criteria resolves to, or null.
 *
 * Split out from `selectOption` because "which strike" is a legitimate question
 * on its own — a straddle wants one strike and both legs — and because it keeps
 * the grid-walking logic in one place.
 */
export function selectStrike(input: SelectInput, criteria: SelectCriteria): number | null {
  const strikes = input.master.strikes(input.underlying, input.expiry)
  if (strikes.length === 0) return null

  switch (criteria.by) {
    case 'atm':
      return input.master.atmStrike(input.underlying, input.expiry, input.spot)

    case 'offset': {
      const atm = input.master.atmStrike(input.underlying, input.expiry, input.spot)
      if (atm === null) return null
      const at = strikes.indexOf(atm)
      if (at < 0) return null
      const idx = at + criteria.steps
      // Off the end of the chain: NOT clamped to the last listed strike. A clamp
      // would answer a different question than the one asked and would quietly
      // put on a much closer strike than the caller believes.
      if (idx < 0 || idx >= strikes.length) return null
      return strikes[idx] ?? null
    }

    case 'delta':
      return bestByScore(input, strikes, criteria.type, (strike, mark) => {
        const d = deltaOf(input, strike, criteria.type, mark)
        return d === null ? null : Math.abs(Math.abs(d) - Math.abs(criteria.target))
      })

    case 'premium':
      return bestByScore(input, strikes, criteria.type, (_strike, mark) =>
        Math.abs(mark - criteria.target),
      )
  }
}

/**
 * The listed CONTRACT a criteria resolves to, or null.
 *
 * Null covers every "cannot answer" case: no chain, no listed strike at that
 * offset, no mark to back a delta out of, and no contract listed for the strike
 * that was chosen. None of them fall back to ATM.
 */
export function selectOption(input: SelectInput, criteria: SelectCriteria): Selection | null {
  const type = criteria.type
  // An ATM *contract* is still either a call or a put. Guessing CE here would be
  // the exact otmSelector failure in a new costume; ask `selectStrike` if the
  // typeless answer is what you wanted.
  if (type === undefined) return null

  const strike = selectStrike(input, criteria)
  if (strike === null) return null

  const instrument = input.master.resolve(input.underlying, input.expiry, strike, type)
  // The strike lists but this LEG does not — real chains are asymmetric, and
  // fabricating the symbol from underlying+strike+type is how the C4 phantom PE
  // got an order.
  if (instrument === null) return null

  const mark = markOf(input.marks, instrument)
  const base = { instrument, strike, type, expiry: input.expiry }
  if (mark === null) return base
  const delta = deltaOf(input, strike, type, mark)
  if (delta === null) return { ...base, premium: mark }
  return { ...base, premium: mark, delta: Math.abs(delta) }
}

// ------------------------------------------------------------------ internals

/**
 * Lowest-scoring listed strike, where `null` means "cannot score this one".
 *
 * Unscoreable strikes are SKIPPED, not scored as infinitely bad — the difference
 * matters when every strike is unscoreable, because then the answer is `null`
 * rather than an arbitrary strike that happened to be first.
 *
 * Ties keep the FIRST match scanning ascending, so selection is deterministic
 * across runs and a golden test cannot flap.
 */
function bestByScore(
  input: SelectInput,
  strikes: readonly number[],
  type: OptionType,
  score: (strike: number, mark: number) => number | null,
): number | null {
  let best: number | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const strike of strikes) {
    const instrument = input.master.resolve(input.underlying, input.expiry, strike, type)
    if (instrument === null) continue
    const mark = markOf(input.marks, instrument)
    if (mark === null) continue
    const s = score(strike, mark)
    if (s === null || !Number.isFinite(s)) continue
    if (s < bestScore) {
      bestScore = s
      best = strike
    }
  }
  return best
}

/** A mark of 0 or below is a missing quote, not a free option. */
function markOf(marks: Marks | undefined, instrument: InstrumentRef): number | null {
  if (marks === undefined) return null
  const token = instrument.instrumentToken
  if (token === undefined) return null
  const mark = marks.get(token)
  if (mark === undefined || !Number.isFinite(mark) || mark <= 0) return null
  return mark
}

/**
 * Delta from the mark, via implied vol.
 *
 * IV first rather than a fixed vol assumption: the whole point of delta selection
 * is to reflect what the market is actually pricing, and a fixed vol would make
 * the selection a deterministic function of moneyness — i.e. an offset selection
 * wearing a delta label. `impliedVol` returns null on a crossed or stale quote,
 * and that null is propagated rather than patched with a fallback vol.
 */
function deltaOf(
  input: SelectInput,
  strike: number,
  type: OptionType,
  mark: number,
): number | null {
  const t = yearsToExpiry(input.expiry, input.nowMs)
  if (!(t > 0) || !(input.spot > 0)) return null
  const base = {
    spot: input.spot,
    strike,
    t,
    rate: input.rate ?? 0.065,
    dividendYield: input.dividendYield ?? 0,
    type,
  }
  const iv = impliedVol({ ...base, price: mark })
  if (iv === null) return null
  return greeks({ ...base, vol: iv }).delta
}
