/**
 * One expiry's chain, priced: the forward that month is valued off, and the
 * vols solved against it. A book spans months, and each month is solved
 * against ITS OWN forward, never the near month's.
 *
 * The forward is the expiry's own future when it is listed and quoted; else
 * put-call parity at the two-sided strike nearest the money (an index weekly
 * lists no future); else spot carried to expiry at the desk rate. Every price
 * is a display read (`TradersQuotes.quote`): the book view says when the feed
 * is not live.
 */

import { yearsToExpiry } from '@algomaker/greeks'
import { DEFAULT_RATE, DEFAULT_REPAIR_DIALS, solveChainIvs } from '@algomaker/payoff'
import type { ChainQuoteLite, SolvedIv } from '@algomaker/payoff'
import { nearestFuture, type TradersMaster } from '../market/master.ts'
import type { TradersQuotes } from '../market/quotes.ts'
import { istDate } from '../routes/kit.ts'

export type ForwardSource = 'future' | 'parity' | 'carry'

export interface MonthQuotes {
  readonly expiry: string
  /** That expiry's own future mark; null when it lists none (an index weekly) or it is unquoted. */
  readonly future: number | null
  readonly forward: number | null
  readonly source: ForwardSource | null
  /** Every quoted CE/PE on the expiry: exactly what the solve was given. */
  readonly quotes: readonly ChainQuoteLite[]
  readonly ivs: readonly SolvedIv[]
  readonly tYears: number
}

/** Outside the session the last session's quotes are the only ones there are; a long weekend is four days. */
export const CLOSED_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

function priceOf(q: TradersQuotes, token: number | undefined): number | null {
  if (token === undefined) return null
  const p = q.quote(token)?.price
  return positive(p) ? p : null
}

/**
 * The forward for (stock, expiry), held or not; null when there is no price at
 * all. Parity reads the strike nearest the reference (spot, else the nearest
 * listed future's price, else the chain's middle strike) among those with both
 * sides quoted: `K + (C - P)·e^{r·t}`.
 */
export function forwardFor(
  m: TradersMaster, q: TradersQuotes, stock: string, expiry: string, spot: number | null, asOf: number,
): { price: number; source: ForwardSource } | null {
  const own = priceOf(q, m.options.future(stock, expiry)?.instrumentToken)
  if (own !== null) return { price: own, source: 'future' }

  const s = positive(spot) ? spot : null
  const growth = Math.exp(DEFAULT_RATE * yearsToExpiry(expiry, asOf))
  const strikes = m.options.strikes(stock, expiry)
  if (strikes.length > 0) {
    const ref = s
      ?? priceOf(q, nearestFuture(m, stock, istDate(asOf))?.instrumentToken)
      ?? (strikes[Math.floor(strikes.length / 2)] as number)
    let best: { k: number; c: number; p: number } | null = null
    for (const k of strikes) {
      const c = priceOf(q, m.options.resolve(stock, expiry, k, 'CE')?.instrumentToken)
      const p = priceOf(q, m.options.resolve(stock, expiry, k, 'PE')?.instrumentToken)
      if (c === null || p === null) continue
      if (best === null || Math.abs(k - ref) < Math.abs(best.k - ref)) best = { k, c, p }
    }
    if (best !== null) {
      const f = best.k + (best.c - best.p) * growth
      if (positive(f)) return { price: f, source: 'parity' }
    }
  }
  return s === null ? null : { price: s * growth, source: 'carry' }
}

/**
 * A month's quotes solved against `forward`: the one solve every caller uses,
 * whatever it is solved against (R2's vol basis re-solves through here too).
 */
export function solveMonth(quotes: readonly ChainQuoteLite[], forward: number, tYears: number, closed: boolean): readonly SolvedIv[] {
  const maxAgeMs = closed ? CLOSED_MAX_AGE_MS : DEFAULT_REPAIR_DIALS.maxQuoteAgeMs
  return solveChainIvs(quotes, forward, tYears, DEFAULT_RATE, { maxAgeMs })
}

/** One month's quotes, forward and vols. No forward, no vols: a solve needs one. */
export function monthQuotes(
  m: TradersMaster, q: TradersQuotes, stock: string, expiry: string, spot: number | null, asOf: number, closed: boolean,
): MonthQuotes {
  const quotes: ChainQuoteLite[] = []
  for (const strike of m.options.strikes(stock, expiry)) {
    for (const type of ['CE', 'PE'] as const) {
      const token = m.options.resolve(stock, expiry, strike, type)?.instrumentToken
      const got = token === undefined ? null : q.quote(token)
      if (got === null || !positive(got.price)) continue
      quotes.push({ strike, type, price: got.price, ageMs: got.ageMs })
    }
  }
  const fwd = forwardFor(m, q, stock, expiry, spot, asOf)
  const tYears = yearsToExpiry(expiry, asOf)
  return {
    expiry,
    future: priceOf(q, m.options.future(stock, expiry)?.instrumentToken),
    forward: fwd?.price ?? null,
    source: fwd?.source ?? null,
    quotes,
    ivs: fwd === null ? [] : solveMonth(quotes, fwd.price, tYears, closed),
    tYears,
  }
}

/** The line a screen shows for a held month with no price, or one valued off spot carried; null otherwise. */
export function monthWarning(mq: MonthQuotes): string | null {
  if (mq.forward === null) return `no price for ${mq.expiry} yet — that month's legs are not priced`
  if (mq.source === 'carry') return `${mq.expiry} is valued off spot carried to expiry — no future and no two-sided quote at the money`
  return null
}
