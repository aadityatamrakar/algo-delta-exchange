// VolHedge's Market Watch columns. Every formula here is OUR READING of VolHedge, unconfirmed
// (Phase 0, Q3): the screen labels each with GUESS_LABEL. A formula lives only in its function, its
// label beside it.

/** The price of the option at a strike, or null when it has no price. */
export type PriceAt = (strike: number) => number | null

export const GUESS_LABEL = 'our reading of VolHedge, unconfirmed (Phase 0, Q3)'

const sum = (parts: readonly (number | null)[], weights: readonly number[]): number | null => {
  let total = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === null || p === undefined || !Number.isFinite(p)) return null
    total += weights[i]! * p
  }
  return total
}

/** Straddle: CE + PE at one strike. Our reading of VolHedge, unconfirmed (Phase 0, Q3). */
export function straddle(ce: number | null, pe: number | null): number | null {
  return sum([ce, pe], [1, 1])
}

/** BF's column label: its formula in words, and that it is a guess. */
export const BF_LABEL = `BF = price(K − step) − 2 × price(K) + price(K + step): ${GUESS_LABEL}`
/** BF: p(k-s) - 2p(k) + p(k+s). Our reading of VolHedge, unconfirmed (Phase 0, Q3). */
export function butterfly(p: PriceAt, k: number, step: number): number | null {
  return sum([p(k - step), p(k), p(k + step)], [1, -2, 1])
}

/** BF2's column label. */
export const BF2_LABEL = `BF2 = price(K − 2 steps) − 2 × price(K) + price(K + 2 steps): ${GUESS_LABEL}`
/** BF2: p(k-2s) - 2p(k) + p(k+2s). Our reading of VolHedge, unconfirmed (Phase 0, Q3). */
export function butterfly2(p: PriceAt, k: number, step: number): number | null {
  return sum([p(k - 2 * step), p(k), p(k + 2 * step)], [1, -2, 1])
}

/** Ratio's column label. */
export const RATIO_LABEL = `Ratio = CE price(K) − 2 × price(K + step); PE price(K) − 2 × price(K − step): ${GUESS_LABEL}`
/** Ratio: CE p(k) - 2p(k+s); PE p(k) - 2p(k-s). Our reading of VolHedge, unconfirmed (Phase 0, Q3). */
export function ratio(p: PriceAt, k: number, step: number, type: 'CE' | 'PE'): number | null {
  return sum([p(k), p(type === 'CE' ? k + step : k - step)], [1, -2])
}
