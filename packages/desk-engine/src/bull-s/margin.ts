/**
 * BULL-S MARGIN, ESTIMATED (operator, 3 Nov: "show margin utilized").
 *
 * Delta's short option margin, as verified on the demo account: a 5-contract
 * short C-BTC-77000-061126 at mark $1,350, 100×, index $77,460 showed
 * position_margin $10.61 against
 *
 *   margin ≈ mark × qty + qty × index ÷ leverage
 *
 * with qty in BTC (contracts × 0.001) and leverage the product's own
 * `default_leverage` (the instrument row's `dx_leverage`). A long leg is its
 * premium, already paid: no margin here.
 *
 * THAT IS ISOLATED MARGIN. On a PORTFOLIO-margin account (`/v2/profile`
 * `margin_mode: 'portfolio'` — the demo account since 3 Nov) the premium is
 * credited to the balance and the shorts' mark value is carried as
 * "unrealised cashflow", not blocked: Delta's UI showed 130 short contracts
 * blocking $89.38 against $342.84 by the isolated formula. Probed on demo,
 * 4 Nov: a resting 10-contract sell at 1.1× mark blocked $0.88/contract (CE)
 * and $0.53/contract (PE, netted against the calls) at index $77,390, where
 * qty × index ÷ leverage is $0.77. So on portfolio margin:
 *
 *   margin ≈ qty × index ÷ leverage × PORTFOLIO_MARGIN_HEADROOM
 *
 * — the 1% notional with room for the scenario add-on, never the premium.
 *
 * PURE. Nothing is guessed: a missing mark or leverage is the caller's to name.
 */
import type { Dials } from '../dials.ts';
import type { OptType, Quote } from '../types.ts';

const r8 = (x: number): number => Number(x.toFixed(8));

/** One strike's leverage per wing, from the instrument master. null = not stated. */
export interface StrikeLeverage {
  readonly strike: number;
  readonly ce: number | null;
  readonly pe: number | null;
}

const STRIKE_EPS = 1e-6;

export function leverageAt(list: readonly StrikeLeverage[], strike: number, opt: OptType): number | null {
  const row = list.find((x) => Math.abs(x.strike - strike) < STRIKE_EPS);
  const v = row === undefined ? null : opt === 'CE' ? row.ce : row.pe;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/** The account's margin mode, as Delta's `/v2/profile` states it. */
export type MarginMode = 'isolated' | 'portfolio';

/** Room over the 1%-notional figure for portfolio margin's scenario add-on (probed 1.14× on a call). */
export const PORTFOLIO_MARGIN_HEADROOM = 1.25;

/** A profile's `margin_mode`, or null when it names neither. */
export function marginModeOf(v: unknown): MarginMode | null {
  return v === 'portfolio' || v === 'isolated' ? v : null;
}

/**
 * Margin of one SHORT option position, USD. `mode` absent or null is ISOLATED
 * — the larger figure, so an account whose mode is unknown is never under-asked.
 */
export function shortOptionMargin(a: {
  readonly mark: number;
  readonly qty: number;
  readonly index: number;
  readonly leverage: number;
  readonly mode?: MarginMode | null;
}): number {
  const notional = (a.qty * a.index) / a.leverage;
  if (a.mode === 'portfolio') return r8(notional * PORTFOLIO_MARGIN_HEADROOM);
  return r8(a.mark * a.qty + notional);
}

const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The mark a quote states: the mid of a two-sided book, else the last price. */
export function quoteMark(q: Quote | null | undefined): number | null {
  if (q === null || q === undefined) return null;
  if (pos(q.bid) && pos(q.ask)) return (q.bid + q.ask) / 2;
  return pos(q.ltp) ? q.ltp : null;
}

/** The first straddle's size: `bs_lots_start`, never past the cap. */
export function bsFirstSize(dials: Dials): number {
  return dials.bs_lots_cap > 0 ? Math.min(dials.bs_lots_start, dials.bs_lots_cap) : dials.bs_lots_start;
}

/** Rule 4: each accepted entry adds a step, never past the cap (0 = uncapped). */
export function bsNextSize(size: number, dials: Dials): number {
  const up = size + dials.bs_lots_step;
  return dials.bs_lots_cap > 0 ? Math.min(up, dials.bs_lots_cap) : up;
}

/** The lot dials a size is stepped under, as one comparable key. */
export function bsSizeKey(dials: Dials): string {
  return `${dials.bs_lots_start}/${dials.bs_lots_step}/${dials.bs_lots_cap}`;
}

/** The next straddle's size after `held` straddles, under these dials. */
export function bsSizeAfter(held: number, dials: Dials): number {
  let size = bsFirstSize(dials);
  for (let i = 0; i < held; i++) size = bsNextSize(size, dials);
  return size;
}

/** The pyramid's sizes up to `bs_max_open` straddles; [] when that is 0 (unlimited). */
export function bullSPyramid(dials: Dials): number[] {
  const out: number[] = [];
  let size = bsFirstSize(dials);
  for (let i = 0; i < dials.bs_max_open; i++) {
    out.push(size);
    size = bsNextSize(size, dials);
  }
  return out;
}

/**
 * THE WORST CASE AT CAP: every straddle of the pyramid open at once
 * (`bs_max_open` of them, sizes stepping to `bs_lots_cap`), each priced at the
 * CURRENT at-the-money marks and leverage. `unbounded` when `bs_max_open` is 0.
 */
export function bullSWorstAtCap(a: {
  readonly dials: Dials;
  readonly lotSize: number;
  readonly index: number;
  readonly ceMark: number;
  readonly peMark: number;
  readonly ceLeverage: number;
  readonly peLeverage: number;
  readonly mode?: MarginMode | null;
}): { readonly usd: number | null; readonly sizes: number[]; readonly unbounded: boolean } {
  if (a.dials.bs_max_open <= 0) return { usd: null, sizes: [], unbounded: true };
  const sizes = bullSPyramid(a.dials);
  const qty = r8(sizes.reduce((s, n) => s + n, 0) * a.lotSize);
  const usd =
    shortOptionMargin({ mark: a.ceMark, qty, index: a.index, leverage: a.ceLeverage, mode: a.mode ?? null }) +
    shortOptionMargin({ mark: a.peMark, qty, index: a.index, leverage: a.peLeverage, mode: a.mode ?? null });
  return { usd: Number(usd.toFixed(2)), sizes, unbounded: false };
}
