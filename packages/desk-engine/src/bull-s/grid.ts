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
