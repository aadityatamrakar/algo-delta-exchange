/**
 * THE STRIKE LADDER — how the engine walks a chain, and whose lot it counts in.
 *
 * Three primitives, none of them interesting on their own, all three shared by
 * every phase that names a strike or sizes a package. They live in their own
 * file for a structural reason rather than a tidiness one: `corridor.ts` needs
 * the shed scan to compute `floorRef`, and `shed.ts` needs the ladder to run
 * that scan. Leaving the geometry in `corridor.ts` makes the two modules
 * import each other — a cycle that ESM tolerates and a reader does not. The
 * geometry moves down here, both import it, and the graph is
 * `ladder ← shed ← corridor`. `isFutureLeg` sits beside them for the same
 * reason: `sellLotSize` needs it, and so do the corridor and `decide()`.
 *
 * There is exactly ONE definition of each name in the package and `index.ts`
 * re-exports it, so a phase that redeclares `otmSellStrike` or `sellLotSize`
 * fails as a duplicate export rather than diverging quietly — which is the
 * whole point of hoisting them out of the phase that happened to need them
 * first.
 *
 * PURE: no clock, no feed. `dateIst`/`minuteOfDay` are arguments so a fixture
 * can replay a session that is long over.
 */
import type { ChainSnap, LegView, OptType } from './types.ts';

/**
 * Snap `x` to the nearest REAL strike on the chain — a generated strike
 * (`atm + n * step`) that the chain does not list would silently skip its fill.
 * Falls back to arithmetic rounding on the step when the chain has no rows, and
 * to `x` when there is no usable step. `actions.py:176-188` exactly, including
 * the first-wins tie-break of Python's `min(ks, key=...)`.
 */
export function nearestStrike(chain: ChainSnap, x: number): number {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const row of chain.strikes) {
    const gap = Math.abs(row.strike - x);
    if (gap < bestGap) {
      bestGap = gap;
      best = row.strike;
    }
  }
  if (best !== null) return best;
  return chain.step > 0 ? Math.round(x / chain.step) * chain.step : x;
}

/**
 * The fresh-sell strike for `optType`: `strikesOut` steps from `atm`, snapped to
 * a real chain strike and pushed further out until it is STRICTLY OTM against
 * `spot` — a coarse grid can snap `atm ± 2` back onto or inside spot
 * (`playbooks.py:2666-2680`).
 *
 * `atm` is a parameter rather than derived from `spot` because the gk-anchor
 * arm sells from a lagged EMA anchor instead (`:3630-3637`); the OTM push still
 * takes `spot` separately, so an anchored strike can never be sold ITM.
 *
 * The walk is bounded at 8 steps and returns what it has at the edge of the
 * chain, which means the result is NOT guaranteed strictly OTM: a caller that
 * requires that must re-check.
 */
export function otmSellStrike(
  chain: ChainSnap,
  atm: number,
  optType: OptType,
  spot: number,
  strikesOut: number,
): number {
  const step = chain.step;
  const off = step * Math.trunc(strikesOut);
  let k = nearestStrike(chain, optType === 'CE' ? atm + off : atm - off);
  for (let i = 0; i < 8; i += 1) {
    if (optType === 'CE' ? k > spot : k < spot) return k;
    const next = nearestStrike(chain, optType === 'CE' ? k + step : k - step);
    if (next === k) return k; // edge of the chain: take what we have
    k = next;
  }
  return k;
}

/**
 * A future (or share) leg: the corridor measures it, nothing acts on it
 * (`types.ts`'s `LegView.kind`). An absent `kind` is an option.
 */
export function isFutureLeg(l: LegView): boolean {
  return l.kind === 'future';
}

/**
 * The lot every band and every package is counted in: the first SHORT OPTION
 * leg carrying one, else the chain's. A short future's lot is 1 — a share — and
 * a package sized in it would be sized in shares.
 *
 * Python read the lot off the first short leg (`playbooks.py:3929`) and fell
 * back to `1.0` — unreachable there, since the rule had already held on an
 * empty shorts list. `ChainSnap.lotSize` is the honest fallback: a lot of 1
 * would make `floorRef` a single share and turn every convexity hold into a
 * shed, and would size a shed package in shares.
 *
 * Shared because `floorRef` is a delta-per-LOT and the sizing that compares
 * against it is a lot count: if the corridor and phase R ever read different
 * lots, the floor stops meaning what phase R thinks it means, and it does so
 * silently.
 */
export function sellLotSize(legs: ReadonlyArray<LegView>, chain: ChainSnap): number {
  return (
    legs.find((l) => l.side === 'Sell' && !isFutureLeg(l) && l.lotSize > 0)?.lotSize ??
    chain.lotSize
  );
}
