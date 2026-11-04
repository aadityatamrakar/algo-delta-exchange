/**
 * The BULL-S grid (spec §6.1 rule 1): levels are the multiples of
 * `bs_strike_jump × bs_strike_step`, in price units. Pure arithmetic.
 *
 * Levels are computed as `k × grid` with an integer `k`, never accumulated, so
 * a $200 grid at $80,000 is exact.
 */

/** Float slack on `x / grid`, so a price sitting exactly on a level reads as on it. */
const EPS = 1e-9;

/** The level nearest `ref`. */
export function bsNearestLevel(ref: number, grid: number): number {
  return Math.round(ref / grid) * grid;
}

/**
 * The level a move from `prev` to `ref` crossed that sits nearest `ref`, or
 * null when it crossed none.
 *
 * A level is crossed when the move LEAVES one side of it and reaches it or
 * passes it: `prev < L <= ref` going up, `prev > L >= ref` going down. A price
 * already on a level and moving away has crossed nothing — it crossed that
 * level on the way in.
 *
 * Of several levels crossed at once (a gap, a reconnect, a cascade) only the
 * one nearest the current price is returned (rule 2: never a burst).
 */
export function bsCrossedLevel(prev: number, ref: number, grid: number): number | null {
  if (!(grid > 0) || prev === ref) return null;
  if (ref > prev) {
    const level = Math.floor(ref / grid + EPS) * grid;
    return level > prev + grid * EPS ? level : null;
  }
  const level = Math.ceil(ref / grid - EPS) * grid;
  return level < prev - grid * EPS ? level : null;
}

/**
 * THE LISTED LADDER (`bs_grid_listed`): the levels are the strikes the
 * exchange lists for the book's expiry, not multiples of a step. Delta lists a
 * weekly every 500 near the money and wider further out, so a fixed grid
 * either skips listed strikes or names ones that do not exist.
 *
 * The same crossing rule as the fixed grid: `prev < L <= ref` going up,
 * `prev > L >= ref` going down, and of several crossed at once only the one
 * nearest `ref`. `levels` need not be sorted or unique.
 */
export function bsCrossedListed(prev: number, ref: number, levels: readonly number[]): number | null {
  if (prev === ref) return null;
  let best: number | null = null;
  for (const l of levels) {
    if (!(l > 0)) continue;
    if (ref > prev ? l > prev && l <= ref : l < prev && l >= ref) {
      if (best === null || Math.abs(ref - l) < Math.abs(ref - best)) best = l;
    }
  }
  return best;
}

/** The listed strike nearest `ref`; null when none is listed. Ties go to the lower strike. */
export function bsNearestListed(ref: number, levels: readonly number[]): number | null {
  let best: number | null = null;
  for (const l of levels) {
    if (!(l > 0)) continue;
    if (best === null || Math.abs(ref - l) < Math.abs(ref - best) || (Math.abs(ref - l) === Math.abs(ref - best) && l < best)) best = l;
  }
  return best;
}
