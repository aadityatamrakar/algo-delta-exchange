/**
 * Order-bus types.
 *
 * Two properties of the legacy system are designed out here, deliberately:
 *
 * 1. **Sim vs live was implicit.** A strategy inserted into the `paper-trade`
 *    collection and whether real money moved depended on which consumer daemon
 *    happened to be running. `mode` is now REQUIRED on every intent.
 *
 * 2. **`placeAllAccount` was dual-rail and nobody noticed.**
 *    `common/models/account.js:151` inserts onto the bus AND places Zerodha
 *    orders in the same call, so one decision could fill on Zerodha *and*
 *    XTS/Spark/Fyers. Modelling the rail as a single enum silently halves live
 *    size for the ~35 files that use it. `destinations` is therefore a SET.
 */

export type Side = 'BUY' | 'SELL'
export type ExecMode = 'sim' | 'live'

/**
 * Where an intent is allowed to go. A set, never a single value — see note 2.
 * `sim` is mutually exclusive with the rest and is enforced in the risk gate.
 */
export type Destination = 'sim' | 'zerodha' | 'xts' | 'fyers' | 'spark'

export type OrderType = 'MARKET' | 'LIMIT' | 'SL_MARKET' | 'SL_LIMIT'

export interface InstrumentRef {
  readonly tradingsymbol: string
  /** Kite instrument token. Absent for non-Kite instruments — see note below. */
  readonly instrumentToken?: number
  readonly lotSize: number
  readonly tickSize: number
  readonly exchange: string
}

/**
 * An order intent, as emitted by a strategy. Immutable once created.
 *
 * `clientOrderId` is assigned by the router BEFORE the journal write, so a
 * replay after a crash is recognisable as the same order and cannot double
 * submit. This is the idempotency key end to end.
 */
export interface OrderIntent {
  readonly clientOrderId: string
  readonly ts: number
  readonly strategyTag: string
  readonly mode: ExecMode
  readonly destinations: readonly Destination[]
  readonly instrument: InstrumentRef
  readonly side: Side
  readonly orderType: OrderType
  /** Contract quantity, already multiplied out from lots. */
  readonly quantity: number
  readonly lots: number
  readonly limitPrice?: number
  readonly triggerPrice?: number
  /** The strategy's decision price — the basis for slippage measurement. */
  readonly referencePrice?: number
  /** Free-form provenance for audit: which signal, which leg of which basket. */
  readonly meta?: Readonly<Record<string, string | number | boolean>>
}

export type OrderStatus =
  | 'PENDING_NEW'
  | 'WORKING'
  | 'PARTIALLY_FILLED'
  | 'AMENDING'
  | 'CANCELLING'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
]

export function isTerminal(s: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(s)
}

/** Live order state, per destination. One intent can have several. */
export interface OrderState {
  readonly clientOrderId: string
  readonly destination: Destination
  readonly brokerOrderId: string | null
  readonly status: OrderStatus
  readonly filledQty: number
  readonly avgFillPrice: number | null
  readonly lastPrice: number | null
  readonly updatedTs: number
  readonly rejectReason?: string
}

// ---------------------------------------------------------------- risk

/**
 * The CAPACITY limits — the numbers, without the kill switch or allowlist.
 *
 * This is the subset the desk API wires onto
 * its live rails (audit F-28): the kill switch and the live allowlist already
 * exist there as gates of their own (`safety.ts`, the Strategies page switch),
 * and a second copy of either would be a second thing to keep in step with the
 * first.
 *
 * `Infinity` on any field means THAT LIMIT IS DISABLED — see `NO_EXPOSURE_LIMITS`.
 */
export interface ExposureLimits {
  readonly maxOrdersPerMinute: number
  readonly maxOpenLotsPerUnderlying: number
  readonly maxOpenLotsTotal: number
  readonly maxNotionalPerOrder: number
  /** Realised+unrealised loss (positive number) at which trading stops. */
  readonly maxDailyLoss: number
}

/**
 * What the DESK measures, independent of any one order: the day's loss, what is
 * open, and how fast orders have been going out.
 *
 * Separated from `RiskSnapshot` because a caller answers this ONCE per decision
 * (it costs a P&L read) and then evaluates N orders against it — see the API's
 * `splitByRisk`, which screens every action in one decision off one of these.
 */
export interface ExposureState {
  readonly nowMs: number
  /** Timestamps (ms) of recently accepted orders, for the rate check. */
  readonly recentOrderTs: readonly number[]
  readonly openLotsByUnderlying: Readonly<Record<string, number>>
  readonly openLotsTotal: number
  /** Positive number = loss. */
  readonly dayLoss: number
  /**
   * HELD SYMBOLS THE MEASUREMENT COULD NOT SIZE — a leg the instrument master
   * cannot resolve, so its lots are missing from the counts above.
   *
   * Absent or empty means the count is complete, which is what every caller
   * that never has this problem gets. NON-EMPTY MEANS THE COUNTS UNDERSTATE THE
   * BOOK, and `checkExposureLimits` refuses new exposure on it for the same
   * reason the API refuses on a `null` measurement: a cap judged against an
   * under-count is not a cap. The concrete shape is an expired-but-still-held
   * leg (the MIRROR/SENSEX case), where the master has dropped the contract
   * while the desk is still carrying it.
   */
  readonly unmeasuredSymbols?: readonly string[]
}

/** Snapshot the risk gate evaluates against. Supplied by the caller; pure input. */
export interface RiskSnapshot extends ExposureState {
  /** Marks an order that reduces exposure; exits survive the kill switch. */
  readonly isReducingExposure: boolean
  /** Underlying symbol this order belongs to, for the per-underlying cap. */
  readonly underlying: string
  /** Best known price, for the notional check. */
  readonly price: number | null
}

export type RiskRejection =
  | { readonly code: 'RATE_LIMIT'; readonly detail: string }
  | { readonly code: 'MAX_LOTS_UNDERLYING'; readonly detail: string }
  | { readonly code: 'MAX_LOTS_TOTAL'; readonly detail: string }
  | { readonly code: 'MAX_NOTIONAL'; readonly detail: string }
  | { readonly code: 'DAILY_LOSS'; readonly detail: string }
  /** The open position could not be counted in full — see `unmeasuredSymbols`. */
  | { readonly code: 'UNMEASURED_EXPOSURE'; readonly detail: string }

// ---------------------------------------------------------------- broker snapshot

/** One net position as a broker reports it. */
export interface BrokerPosition {
  readonly tradingsymbol: string
  /** Signed: positive long, negative short. */
  readonly netQty: number
  readonly avgPrice: number
}

/** One order as a broker reports it. */
export interface BrokerOrder {
  readonly brokerOrderId: string
  /** Null when the broker has no record of our idempotency key. */
  readonly clientOrderId: string | null
  readonly tradingsymbol: string
  readonly status: string
  readonly filledQty: number
}
