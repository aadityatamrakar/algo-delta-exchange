/**
 * Safety handles: the kill switch and close-all.
 *
 * THE GOVERNING RULE, consistent with `packages/order-bus/src/risk.ts:82`:
 * a halt stops NEW EXPOSURE and never blocks an exit. Trapping an open position
 * behind a safety control is worse than whatever the control was protecting
 * against — the position keeps moving whether or not you can act on it, so the
 * one thing that must always work is getting out.
 *
 * Close-all therefore ignores the kill switch by construction: closing is the
 * kill switch's purpose, not something it obstructs.
 *
 * The planning here is pure. `planCloseAll` turns a book into close actions and
 * `planFlatten` turns a net position into exit orders; neither performs IO, so
 * the two pricing styles and the degraded-mark cases are testable without a
 * broker.
 *
 * TWO PLANNERS, ONE PRICER. They exist because the desk has two kinds of
 * position and only one of them is a book:
 *
 *   - `planCloseAll` — the Python desk's book in `desk-books`, keyed by the
 *     desk's own leg tags. Emits `close` ACTIONS, which `applyActions` turns
 *     into fills against the stored legs.
 *   - `planFlatten` — a hosted strategy's position, which exists only as the
 *     fills `/v1/desk/submit` journalled to `desk-decisions`. There is no book
 *     and no leg tag, so it emits ORDERS directly, one per net contract.
 *
 * Both price through `priceExit`, which is the single implementation of "how far
 * through the mark does an exit have to sit to actually cross". Two copies of
 * that would drift, and the copy that drifts is the one that stops filling.
 */

import type { BridgeLeg, DeskAction, DeskMode, DeskSide } from './contract.ts'

export interface KillSwitchState {
  readonly enabled: boolean
  readonly reason: string
  readonly setBy: string
  readonly setAt: number
}

export const DEFAULT_KILL_SWITCH: KillSwitchState = {
  enabled: false,
  reason: '',
  setBy: '',
  setAt: 0,
}

// ------------------------------------------------------------ broker link

/**
 * THE BROKER LINK — the operator's "pause live execution" switch.
 *
 * Stored beside the kill switch in `desk-safety` (`_id: 'broker-link'`). The
 * bridge writes the WISH and refuses every live order while it reads
 * `released` (`brokerLinkRefusal`, enforced in `submit.ts` and `service.ts`),
 * so nothing new reaches the Delta gateway. The `applied*` half is a legacy
 * ack field: the Delta gateway writes none, so the dashboard no longer shows it.
 *
 * UNLIKE THE KILL SWITCH IT BLOCKS EXITS TOO, on the live rail only. Paper is
 * untouched.
 */
export type BrokerLinkDesired = 'connected' | 'released'

export interface BrokerLinkState {
  readonly desired: BrokerLinkDesired
  readonly reason: string
  readonly setBy: string
  readonly setAt: number
  /** The gateway's answer. `null` until it has acked at all. */
  readonly applied: BrokerLinkDesired | null
  readonly appliedAt: number
  /** Why the ack is not clean — a failed logout, a failed reconnect login. */
  readonly appliedError: string
}

export const DEFAULT_BROKER_LINK: BrokerLinkState = {
  desired: 'connected',
  reason: '',
  setBy: '',
  setAt: 0,
  applied: null,
  appliedAt: 0,
  appliedError: '',
}

/** Read the stored document defensively — only the literal words mean anything. */
export function readBrokerLinkDoc(doc: unknown): BrokerLinkState {
  if (doc === null || typeof doc !== 'object') return DEFAULT_BROKER_LINK
  const d = doc as Record<string, unknown>
  const word = (v: unknown): BrokerLinkDesired | null =>
    v === 'released' ? 'released' : v === 'connected' ? 'connected' : null
  return {
    desired: word(d['desired']) ?? 'connected',
    reason: typeof d['reason'] === 'string' ? d['reason'] : '',
    setBy: typeof d['setBy'] === 'string' ? d['setBy'] : '',
    setAt: typeof d['setAt'] === 'number' ? d['setAt'] : 0,
    applied: word(d['applied']),
    appliedAt: typeof d['appliedAt'] === 'number' ? d['appliedAt'] : 0,
    appliedError: typeof d['appliedError'] === 'string' ? d['appliedError'] : '',
  }
}

/**
 * The write-time refusal for an order while the link is released, or null.
 *
 * Decided on the WISH, not the ack: the moment the operator releases, nothing
 * new may be handed to a gateway that is about to log out — an order queued in
 * that window would be refused there anyway, after this bridge had already
 * folded it into the book.
 */
export function brokerLinkRefusal(
  mode: DeskMode,
  link: Pick<BrokerLinkState, 'desired' | 'reason'>,
): string | null {
  if (mode !== 'live' || link.desired !== 'released') return null
  const why = link.reason === '' ? '' : ` (${link.reason})`
  return (
    `live execution paused by operator${why}: live orders to Delta — exits included — ` +
    'are refused until it is resumed from Controls. Paper is unaffected'
  )
}

/**
 * Does an action ADD exposure?
 *
 * `open` always does. `resize` does only when it grows the leg — shrinking is an
 * exit and must survive the halt. `close` and `roll` reduce or replace, so both
 * are permitted: a roll that could not execute under a halt would strand a
 * tested short exactly when it most needs moving.
 */
export function addsExposure(action: DeskAction, book: readonly BridgeLeg[]): boolean {
  if (action.op === 'open') return true
  if (action.op === 'resize') {
    const leg = book.find((l) => l.deskTag === action.ts)
    if (leg === undefined) return false
    return action.qty > Math.abs(leg.qty)
  }
  return false
}

export type CloseStyle =
  /** MARKET. Certain fill, uncontrolled price. For getting flat NOW. */
  | 'fast'
  /**
   * LIMIT, priced THROUGH the mark by `aggressionPct` so it still crosses.
   * A limit at the mark on an illiquid stock option frequently will not fill,
   * which turns a "close everything" into a book that is half open and looks
   * closed — the worst outcome of the three.
   */
  | 'limit'

export interface CloseAllPlan {
  readonly actions: readonly DeskAction[]
  /** Per-leg pricing, keyed by desk tag. Empty entry means MARKET. */
  readonly pricing: ReadonlyMap<string, { orderType: 'MARKET' | 'LIMIT'; limitPrice?: number }>
  /** Legs that must go out as MARKET because no mark was available to price. */
  readonly unpriceable: readonly string[]
  readonly legCount: number
}

export interface CloseAllInputs {
  readonly book: readonly BridgeLeg[]
  readonly style: CloseStyle
  /** How far THROUGH the mark to price, as a fraction. 0.02 = 2%. */
  readonly aggressionPct?: number
  /** Live mark per exchange symbol. Missing means unpriceable. */
  readonly marks: (leg: BridgeLeg) => number | null
  readonly tickSize?: number
}

/**
 * Build the actions that flatten a book.
 *
 * Every leg gets a `close`, in one decision, so the whole thing is idempotent
 * under a single decisionId — a retried close-all cannot double-sell.
 *
 * A leg with no mark under `limit` DEGRADES TO MARKET rather than being
 * skipped. Refusing to close a position because we cannot price it is precisely
 * the trap this module exists to avoid; an uncontrolled exit price is bad, no
 * exit is worse. Every such leg is named in `unpriceable`.
 */
export function planCloseAll(input: CloseAllInputs): CloseAllPlan {
  const aggression = input.aggressionPct ?? 0.02
  const tick = input.tickSize ?? 0.05
  const actions: DeskAction[] = []
  const pricing = new Map<string, { orderType: 'MARKET' | 'LIMIT'; limitPrice?: number }>()
  const unpriceable: string[] = []

  for (const leg of input.book) {
    actions.push({ op: 'close', ts: leg.deskTag })
    const priced = priceExit(input.style, leg.qty < 0, input.marks(leg), aggression, tick)
    if (priced.degraded) unpriceable.push(leg.instrument.tradingsymbol)
    pricing.set(leg.deskTag, priced.order)
  }

  return { actions, pricing, unpriceable, legCount: input.book.length }
}

// ------------------------------------------------------- flatten by position

/**
 * A net position, as `@algomaker/pnl`'s `buildPositions` returns it.
 *
 * Structurally a subset of `Position` so that array passes straight in. Declared
 * here rather than imported so this module stays pure of the P&L engine's other
 * concerns — the only two fields a flatten needs are the signed quantity and the
 * average it was opened at.
 */
export interface NetPosition {
  readonly tradingsymbol: string
  /** SIGNED contract qty: negative is short. Same convention as `BridgeLeg`. */
  readonly qty: number
  /** Average price of the OPEN quantity. Zero when flat. */
  readonly avgCost: number
}

/** One exit order, ready to become a `Fill`. */
export interface FlattenLegPlan {
  readonly tradingsymbol: string
  /** The signed position this order closes. Echoed so the caller can report it. */
  readonly positionQty: number
  /** The side that CLOSES: a short is bought back, a long is sold. */
  readonly side: DeskSide
  /** Always positive — the side carries the direction. */
  readonly qty: number
  readonly orderType: 'MARKET' | 'LIMIT'
  readonly limitPrice?: number
  /**
   * The price this exit is JOURNALLED at, which on the paper rail is also the
   * price it books at.
   *
   * The live mark when we have one. When we do not, `avgCost` — NOT zero. A
   * fill journalled at 0 does not fail, it silently reports the entire premium
   * as profit; `submit.ts` refuses an order outright for exactly this reason.
   * Refusing is not available here, because refusing IS the trapped position
   * this whole path exists to undo. `avgCost` books the leg at no gain and no
   * loss, which is visibly a placeholder rather than a fictional windfall, and
   * every leg that used it is named in `unpriceable`.
   */
  readonly price: number
  /** Empty unless this order is going out degraded; the operator must see why. */
  readonly degraded: string
}

export interface FlattenPlan {
  readonly legs: readonly FlattenLegPlan[]
  /** Legs that had no usable mark. They still go out — as MARKET. */
  readonly unpriceable: readonly string[]
}

export interface FlattenInputs {
  readonly positions: readonly NetPosition[]
  readonly style: CloseStyle
  /** How far THROUGH the mark to price, as a fraction. 0.02 = 2%. */
  readonly aggressionPct?: number
  /** Live mark by exchange symbol. Missing means unpriceable. */
  readonly marks: (tradingsymbol: string) => number | null
  readonly tickSize?: number
}

/**
 * Build the exit orders that flatten a net position.
 *
 * Same contract as `planCloseAll`, for the same reasons: one order per open
 * contract, an unmarked leg DEGRADES to MARKET rather than being skipped, and
 * every degraded leg is named. Nothing is dropped silently — a position that
 * quietly did not get an order is indistinguishable from one that closed.
 *
 * FLAT CONTRACTS ARE DROPPED, and this is load-bearing. `buildPositions`
 * deliberately retains a contract at qty 0 because it still carries the day's
 * realised P&L; sending an order for it would be an order for zero contracts,
 * or worse, an order whose side was picked by `0 < 0` being false — i.e. a SELL
 * that opens a brand-new naked short while trying to close nothing.
 */
export function planFlatten(input: FlattenInputs): FlattenPlan {
  const aggression = input.aggressionPct ?? 0.02
  const tick = input.tickSize ?? 0.05
  const legs: FlattenLegPlan[] = []
  const unpriceable: string[] = []

  for (const pos of input.positions) {
    if (pos.qty === 0) continue
    const mark = input.marks(pos.tradingsymbol)
    const closingBuy = pos.qty < 0
    const priced = priceExit(input.style, closingBuy, mark, aggression, tick)
    if (priced.degraded) unpriceable.push(pos.tradingsymbol)

    /**
     * A MARK OF EXACTLY 0 IS A MARK.
     *
     * This read `mark > 0`, which silently reclassified a genuine zero as "no
     * mark" and journalled the leg at its average cost instead — reporting a
     * loss that had not been taken, with a `degraded` note saying "no mark"
     * when there had been one. `@algomaker/pnl` deliberately accepts 0 ("a
     * worthless far-OTM option genuinely marks at zero") and so does
     * `pnlstore.ts:toStampedFill`; this module disagreeing with them made the
     * same contract book two different prices depending on which path closed it.
     *
     * Zero is still not LIMIT-priceable — see `priceExit` — but that is a
     * separate fact and it is now reported separately.
     */
    const hasMark = mark !== null && Number.isFinite(mark)
    const usableMark = hasMark && (mark as number) >= 0
    const price = usableMark ? (mark as number) : pos.avgCost
    const notes: string[] = []
    if (priced.degraded) {
      notes.push(
        hasMark
          ? `mark ${String(mark)} cannot be priced as a crossing limit: sent as MARKET rather than not sent`
          : 'no mark: sent as MARKET rather than not sent',
      )
    }
    if (!usableMark) {
      notes.push(`no mark: journalled at the average cost ${pos.avgCost}, not at the live price`)
    }

    legs.push({
      tradingsymbol: pos.tradingsymbol,
      positionQty: pos.qty,
      side: closingBuy ? 'Buy' : 'Sell',
      qty: Math.abs(pos.qty),
      price,
      degraded: notes.join('; '),
      ...priced.order,
    })
  }

  return { legs, unpriceable }
}

// ------------------------------------------------------------------ pricing

/**
 * How an exit is priced. THE one implementation, shared by both planners.
 *
 * `degraded` is true only when `limit` was asked for and no mark was available:
 * `fast` never needs a price, so nothing about it is a degradation. The caller
 * turns `degraded` into the named entry in `unpriceable`.
 */
function priceExit(
  style: CloseStyle,
  /** True when flattening this leg means BUYING, i.e. it is short. */
  closingBuy: boolean,
  mark: number | null,
  aggression: number,
  tick: number,
): { order: { orderType: 'MARKET' | 'LIMIT'; limitPrice?: number }; degraded: boolean } {
  if (style === 'fast') return { order: { orderType: 'MARKET' }, degraded: false }
  // A mark of 0 is a real price but not a usable LIMIT: pricing a closing sell
  // through it lands at or below zero, which no exchange accepts, so the order
  // would simply be rejected. MARKET is the honest degradation. The CALLER
  // distinguishes this from "no mark at all" when it writes the reason.
  if (mark === null || !(mark > 0)) return { order: { orderType: 'MARKET' }, degraded: true }

  // Closing a SHORT means buying: bid UP through the mark. Closing a long
  // means selling: offer DOWN. Either way the limit is priced so it crosses.
  const raw = closingBuy ? mark * (1 + aggression) : mark * (1 - aggression)
  // Never let aggression round to nothing on a cheap contract — one tick is
  // the minimum meaningful concession.
  const minMove = tick
  const adjusted = closingBuy
    ? Math.max(raw, mark + minMove)
    : Math.max(0, Math.min(raw, mark - minMove))
  return {
    order: { orderType: 'LIMIT', limitPrice: roundTick(adjusted, tick) },
    degraded: false,
  }
}

function roundTick(price: number, tick: number): number {
  if (!(tick > 0)) return price
  return Number((Math.round(price / tick) * tick).toFixed(4))
}
