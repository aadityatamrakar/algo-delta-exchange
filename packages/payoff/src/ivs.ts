/**
 * The vol the price scan holds still — one IV per (strike, type), solved from
 * the live chain.
 *
 * STICKY-STRIKE, and that is a modelling decision, not a shortcut. When the
 * payoff view walks the future from −10% to +10%, each leg keeps the vol that
 * was solved at ITS OWN STRIKE from today's quotes; the surface does not rotate
 * with the underlying. The alternative (sticky-delta / sticky-moneyness) would
 * re-read the skew at every scan price and is defensible for a multi-day view,
 * but it makes the intraday chart move for reasons the desk cannot verify
 * against a screen. Sticky-strike is what a trader reads off a chain and what
 * the Python desk's stored per-leg IV already means.
 *
 * WHY THE CHAIN AND NOT THE LEG'S OWN QUOTE: a book's legs are two or three
 * strikes out of forty, and the ones that hurt are the wings — precisely the
 * contracts whose last trade is oldest and whose quote is least trustworthy. A
 * whole-chain solve turns the neighbours into evidence: a wing that will not
 * solve is rebuilt from strikes that did, in the same expiry, on the same side.
 *
 * THREE WAYS TO NOT HAVE AN IV, and they are deliberately distinguishable in
 * the output rather than collapsed into a number:
 *
 *   `quote`   solved from a fresh quote. The only measured value.
 *   `interp`  rebuilt from solved same-type neighbours. An estimate, and the
 *             consumer is entitled to know it is one before sizing on the vega.
 *   `none`    nothing to build from. `iv: null` — which `legPnl` marks as ZERO
 *             rather than guessing, and which the view then warns about.
 *
 * A single `null` here is far safer than a plausible default: 20% stamped on a
 * wing that is really trading at 60% understates the loss on the exact leg that
 * causes it.
 *
 * Pure and fail-soft, like the rest of the package: no clock (freshness arrives
 * as `ageMs`, computed by the caller that owns the clock), no feed, no throw.
 */
import { b76ImpliedVol, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE } from './legs.ts'

/**
 * One chain row, reduced to what an IV solve needs.
 *
 * `price` is the mark the desk would trade against (mid, or LTP when there is
 * no book) — this module does not care which, only that the caller picked one
 * and applied it consistently across the chain, because the skew that comes out
 * is only meaningful if every strike was measured the same way.
 *
 * `ageMs` rather than a timestamp: the caller owns the clock (see the header),
 * and an age is comparable across a snapshot taken at one instant where two
 * timestamps read against `Date.now()` at solve time are not.
 */
export interface ChainQuoteLite {
  readonly strike: number
  readonly type: OptionType
  /** Per-share option price, rupees. */
  readonly price: number
  /** Milliseconds since this quote was live. Negative (clock skew) counts as fresh. */
  readonly ageMs: number
}

export interface SolvedIv {
  readonly strike: number
  readonly type: OptionType
  /** Decimal (0.28 = 28%). `null` only alongside `source: 'none'`. */
  readonly iv: number | null
  readonly source: 'quote' | 'interp' | 'none'
}

/** Older than this and a quote is evidence about a market that has moved on. */
const DEFAULT_MAX_AGE_MS = 120_000

/** A measured point on one side's skew, used to rebuild the strikes that failed. */
interface Measured {
  readonly strike: number
  readonly iv: number
}

function isType(v: unknown): v is OptionType {
  return v === 'CE' || v === 'PE'
}

/**
 * Linear interpolation in STRIKE across `measured` (ascending, same type).
 *
 * Between two quoted strikes: the straight line through them. Outside the
 * quoted range: the nearest measured value, carried FLAT. Extrapolating the
 * skew's slope past the last strike it was measured on is how a far wing
 * acquires a negative vol — the flat carry is wrong by less and cannot be
 * wrong in a direction that has no meaning.
 *
 * `null` when there is nothing measured at all on this side.
 */
function interpolate(measured: readonly Measured[], strike: number): number | null {
  if (measured.length === 0) return null
  const first = measured[0] as Measured
  const last = measured[measured.length - 1] as Measured
  if (strike <= first.strike) return first.iv
  if (strike >= last.strike) return last.iv
  for (let i = 0; i < measured.length - 1; i++) {
    const lo = measured[i] as Measured
    const hi = measured[i + 1] as Measured
    if (strike < lo.strike || strike > hi.strike) continue
    const span = hi.strike - lo.strike
    // Guarded, though the dedupe upstream means it cannot fire: two rows at one
    // strike would divide by zero and hand a NaN vol to every leg downstream.
    if (!(span > 0)) return lo.iv
    return lo.iv + ((hi.iv - lo.iv) * (strike - lo.strike)) / span
  }
  return null
}

/**
 * Solve every quoted (strike, type) in one expiry's chain.
 *
 * Returned ASCENDING BY STRIKE (calls before puts at the same strike),
 * regardless of the order the quotes arrived in: this array is rendered as a
 * chain and handed across the wire, and a caller should not have to sort it to
 * read it. Duplicated (strike, type) rows keep the FIRST — a chain that quotes
 * one contract twice is a feed defect, and picking arbitrarily between the two
 * would make the whole surface depend on iteration order.
 *
 * `expiryYears` is the tenor of the CHAIN, not of any leg — every row in one
 * expiry is solved against the same `t`, which is what makes the resulting
 * skew a skew.
 */
export function solveChainIvs(
  quotes: readonly ChainQuoteLite[],
  future: number,
  expiryYears: number,
  rate: number = DEFAULT_RATE,
  opts: { maxAgeMs?: number } = {},
): readonly SolvedIv[] {
  const maxAge = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const r = Number.isFinite(rate) ? rate : DEFAULT_RATE

  // Pass 1: key the chain, dropping anything that cannot be keyed at all. A row
  // with no readable strike or side has no identity, so it can be neither
  // reported nor looked up — there is nothing to say about it.
  const keyed = new Map<string, { strike: number; type: OptionType; iv: number | null }>()
  for (const q of quotes ?? []) {
    if (q === null || typeof q !== 'object') continue
    const { strike, type } = q
    if (!Number.isFinite(strike) || strike <= 0 || !isType(type)) continue
    const key = `${strike}|${type}`
    if (keyed.has(key)) continue

    // A stale quote is not a weaker quote, it is a quote about a different
    // market: it will solve perfectly well, to the wrong number. Discarded
    // BEFORE the solver sees it, so the fallback path treats it exactly like a
    // missing one.
    const fresh = Number.isFinite(q.ageMs) && q.ageMs <= maxAge
    const iv = fresh
      ? b76ImpliedVol(q.price, { future, strike, t: expiryYears, rate: r, type })
      : null
    keyed.set(key, { strike, type, iv })
  }

  // Pass 2: the measured skew, per side, ascending. Only `quote`-sourced values
  // are evidence — interpolating from an interpolated point would let one good
  // strike propagate across a whole chain as if it had been observed everywhere.
  const measured: Record<OptionType, Measured[]> = { CE: [], PE: [] }
  for (const row of keyed.values()) {
    if (row.iv !== null) measured[row.type].push({ strike: row.strike, iv: row.iv })
  }
  for (const side of ['CE', 'PE'] as const) measured[side].sort((a, b) => a.strike - b.strike)

  // Pass 3: fill the gaps from the same side only. A put's vol is not evidence
  // about a call's at the same strike on this chain, and pooling them would
  // quietly average the skew away.
  const out: SolvedIv[] = []
  for (const row of keyed.values()) {
    if (row.iv !== null) {
      out.push({ strike: row.strike, type: row.type, iv: row.iv, source: 'quote' })
      continue
    }
    const filled = interpolate(measured[row.type], row.strike)
    out.push(
      filled === null
        ? { strike: row.strike, type: row.type, iv: null, source: 'none' }
        : { strike: row.strike, type: row.type, iv: filled, source: 'interp' },
    )
  }
  return out.sort((a, b) => a.strike - b.strike || (a.type === b.type ? 0 : a.type === 'CE' ? -1 : 1))
}

/**
 * The vol to stamp on a leg at `strike`.
 *
 * Exact row first; otherwise INTERPOLATED from the measured rows of the same
 * type, exactly as `solveChainIvs` fills its own gaps. The second branch is not
 * theoretical: a rolled-in position, or a strike the chain snapshot did not
 * cover, is a leg the book genuinely holds and must still be marked. Returning
 * null there would price it at zero and understate the book's risk on the one
 * leg nobody was watching.
 *
 * `null` means exactly one thing: this chain contains no measured vol on that
 * side at all.
 */
export function ivFor(
  solved: readonly SolvedIv[],
  strike: number,
  type: OptionType,
): number | null {
  if (!Number.isFinite(strike) || !isType(type)) return null
  const rows = (solved ?? []).filter((s) => s !== null && typeof s === 'object' && s.type === type)
  const exact = rows.find((s) => s.strike === strike)
  if (exact !== undefined && exact.iv !== null && Number.isFinite(exact.iv)) return exact.iv
  const measured = rows
    .filter((s): s is SolvedIv & { iv: number } =>
      s.source === 'quote' && s.iv !== null && Number.isFinite(s.iv),
    )
    .map((s) => ({ strike: s.strike, iv: s.iv }))
    .sort((a, b) => a.strike - b.strike)
  return interpolate(measured, strike)
}
