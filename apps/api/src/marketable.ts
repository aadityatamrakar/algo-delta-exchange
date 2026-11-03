/**
 * MARKETABLE LIMIT PRICING — the price a desk action goes out at.
 *
 * A desk action carries no price of its own: the action shapes in `contract.ts`
 * have no `orderType`/`limitPrice` field, so `rail.ts` used to default every
 * one of them to MARKET.
 *
 * **The broker's API rejects market orders**, so a MARKET default means every
 * delta-management order recenter places is rejected and the book sits open and
 * unmanaged. A resting limit at the mark is no better — it may never fill, and
 * an unfilled hedge is a hedge that does not exist.
 *
 * The answer is a MARKETABLE limit: priced THROUGH the touch so it executes
 * immediately like a market order, with the limit as a hard worst-case
 * guarantee. A sell prices below the mark, a buy above it.
 *
 * Only the last traded price is available — `MarkSource` exposes `price()` and
 * `spot()`, no bid/ask — so the buffer is taken off the mark the fill was
 * booked at rather than off the spread itself.
 */
import { roundToStep, venueFromEnv } from '@algomaker/venue'
import type { DeskSide } from './contract.ts'

/** NFO options tick. Used when an instrument reports no usable tick size. */
const DEFAULT_TICK = 0.05

export interface MarketableConfig {
  /** Fraction of the mark to cross by, e.g. 0.02 for 2%. */
  readonly bufferPct: number
  /** Floor on the buffer, in ticks. Applies when the percentage is smaller. */
  readonly minTicks: number
  /** The instrument's tick size; `DEFAULT_TICK` when non-positive. */
  readonly tickSize: number
  /**
   * The buffer on a contract that EXPIRES TODAY, replacing `bufferPct`.
   *
   * Expiry-day tape moves through a 2% buffer before the order rests a
   * heartbeat: a sell priced 2% under the mark sat unfilled while the market
   * fell through it, and an unfilled exit on a dying contract is the position
   * pinned to settlement. 10% of a collapsing premium is small in rupees and
   * the limit is still the hard worst case — this buys the FILL, not a price.
   *
   * ABSENT MEANS `bufferPct` — a hand-built config that has not opted in is
   * unchanged. Selected ONLY when the caller ASSERTS expiry day (see
   * `marketableLimit`). Two callers assert it:
   *
   *   - `/v1/desk/submit`, for any contract the master says expires today;
   *   - `applyDecision`, for an ENGINE decision of the delta-lean family
   *     (trigger `dl-*`, every playbook included) or an `eod` flatten, on a
   *     book whose contract expires today.
   *
   * Nothing else asserts it. Recenter's other triggers are not `dl-*` — a
   * positional book trades monthlies and its pricing must not move on an
   * intraday fix (its `eod` sweep, unused by the preset in service, would pay
   * the wide buffer on its own expiry day, which is what a dying contract's exit
   * wants) —
   * `flattenTag` keeps the base buffer, and the repair path prices off the
   * touch (`repair-apply.ts` `limitFor`), where the wide buffer would only pay
   * for a fill that is already bought.
   */
  readonly expiryBufferPct?: number
}

/**
 * The config, from the environment — the ONE place it is read.
 *
 * There are two construction sites: `main.ts`'s bridge service (which drives
 * the engine decision path) and `routes/submit.ts`'s own service (which drives
 * `/v1/desk/submit`). This codebase has twice been bitten by exactly that pair
 * drifting — the live allowlist, where one moved to the strategy row and the
 * other stayed on the env set and refused a correctly-enabled tag; and the
 * freeze table. Three duplicated `process.env` reads would be the third.
 *
 * A non-numeric dial falls back rather than becoming `NaN`: `Number('oops')`
 * is NaN, `marketableLimit` would propagate it, and an order priced at NaN is
 * worse than the MARKET order this machinery exists to replace.
 */
export function marketableFromEnv(env: NodeJS.ProcessEnv = process.env): MarketableConfig {
  const dial = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    bufferPct: dial('DESK_MARKETABLE_BUFFER_PCT', 0.02),
    minTicks: dial('DESK_MARKETABLE_MIN_TICKS', 2),
    // The venue's tick unless the env names one: NSE 0.05, Delta 0.1.
    tickSize: dial('DESK_MARKETABLE_TICK', venueFromEnv(env).defaultTick),
    expiryBufferPct: dial('DESK_MARKETABLE_EXPIRY_BUFFER_PCT', 0.1),
  }
}

/** Guards against 0.1 + 0.2 style drift pushing a value across a tick line. */
const EPSILON = 1e-9

/**
 * The limit price for a marketable order, or `null` when the mark is unusable
 * and no price can honestly be derived.
 *
 * The buffer is `max(bufferPct x mark, minTicks x tick)`. The percentage alone
 * is not enough: 2% of a ₹1.50 option is ₹0.03, below one ₹0.05 tick, so it
 * would round away to nothing and leave a resting order. The tick floor is what
 * guarantees the price actually crosses, and it is why `bufferPct: 0` still
 * produces a marketable order rather than one at the mark.
 *
 * Rounding is DIRECTIONAL — sell down, buy up — never to nearest. Rounding to
 * nearest would pull the price back toward the mark by up to half a tick, which
 * on a cheap contract is a meaningful share of the buffer and can cost the fill
 * the buffer was chosen to guarantee.
 *
 * `expiresToday` selects `expiryBufferPct` over `bufferPct` — nothing else
 * changes: the tick floor, the directional rounding and the zero clamp apply
 * to the wide buffer identically, because an expiry-day order needs them for
 * exactly the same reasons plus a faster tape.
 */
export function marketableLimit(
  side: DeskSide,
  mark: number,
  cfg: MarketableConfig,
  expiresToday = false,
): number | null {
  if (!Number.isFinite(mark) || mark <= 0) return null

  const pct = expiresToday ? (cfg.expiryBufferPct ?? cfg.bufferPct) : cfg.bufferPct
  const tick = cfg.tickSize > 0 ? cfg.tickSize : DEFAULT_TICK
  const buffer = Math.max(pct * mark, cfg.minTicks * tick)
  const raw = side === 'Sell' ? mark - buffer : mark + buffer

  const ticks =
    side === 'Sell'
      ? Math.floor(raw / tick + EPSILON)
      : Math.ceil(raw / tick - EPSILON)

  // A sell that crosses past zero clamps to one tick: an order at or below zero
  // is rejected outright, so the aggressive-but-legal price is the useful one.
  const bounded = Math.max(ticks, 1)

  // Re-round after multiplying: `147 * 0.05` is 7.3500000000000005 in binary
  // floating point, and a price with a 16th decimal place is not on any grid.
  // To the tick's own decimals (0.05 → 2, 0.1 → 1), never a fixed 2.
  return roundToStep(bounded * tick, tick)
}
