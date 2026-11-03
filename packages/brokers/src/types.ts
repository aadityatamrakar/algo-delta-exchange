/**
 * One interface; on the Delta desk: the simulator (paper) and `@algomaker/dx`'s DxAdapter (live). Paper and live run IDENTICAL strategy
 * code — only the injected adapter differs (spec D2).
 *
 * `capabilities` is enforced at construction rather than by convention. That is
 * what makes the dual-rail bug structurally impossible: `zerodha-data` declares
 * `orders: false`, so it CANNOT place an order. The legacy
 * `Account.placeAllAccount` inserted on the order bus AND placed Zerodha orders
 * in one call (common/models/account.js:148-152), and nothing prevented it.
 */
import type {
  BrokerOrder as BusBrokerOrder,
  BrokerPosition,
  OrderIntent,
  OrderStatus,
} from '@algomaker/order-bus'

export type { BrokerPosition }

/**
 * A row of the broker's order book, as an ADAPTER reports it.
 *
 * It extends the order-bus shape (which `reconcile()` compares positions with)
 * by the one field that shape has no use for and this layer cannot work
 * without: the AVERAGE TRADED PRICE.
 *
 * The broker sweep replays these rows through the same fill handler the order
 * socket feeds, so a row without a price would book every recovered fill at
 * "no price" — and a fill with no price is exactly the hole the sweep exists to
 * fill after a socket outage (F-1). Required, not optional: an implementer that
 * cannot answer must say `null` deliberately rather than omit it and have the
 * consumer guess zero.
 */
export interface BrokerOrder extends BusBrokerOrder {
  /** Broker-reported average fill, or null where nothing has traded. */
  readonly avgPrice: number | null
  /**
   * The exchange's own integer for the contract (XTS `ExchangeInstrumentID`),
   * or null when the row does not carry one.
   *
   * This is the one name for a contract that the broker and the desk agree
   * on. `tradingsymbol` is not: XTS spells a contract `NIFTY 22SEP2026 PE
   * 23150` where the instrument master (and so every order document) spells
   * it `NIFTY2692223150PE`, and a consumer deciding whether a book row is for
   * a given order cannot compare the two. Optional so the simulator and the
   * data-only adapter are unchanged; null rather than 0 for the same reason
   * `avgPrice` is null rather than 0 — a consumer must not read "unknown" as
   * a token.
   */
  readonly exchangeToken?: number | null
}

export interface BrokerCapabilities {
  readonly orders: boolean
  readonly marketData: boolean
  /** Atomic reprice. Preferred over cancel+replace, which races a fill. */
  readonly modify: boolean
}

export interface PlacedOrder {
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly status: OrderStatus
  readonly filledQty: number
  /** Broker-reported average fill. NEVER inferred locally — D3 depends on it. */
  readonly avgPrice: number | null
  /** Present when `status === 'REJECTED'`. */
  readonly rejectReason?: string
  /**
   * The CONTRACT this update is for, when the broker names it.
   *
   * Optional because not every transport carries it, but supplied wherever it is
   * available: a consumer with no symbol has to invent one for its fill record,
   * and the gateway used to "invent" it by writing the correlation id into the
   * symbol column — which makes every stored fill unjoinable to a contract.
   */
  readonly tradingsymbol?: string
  /**
   * The exchange's integer for the contract, when the broker names it — see
   * `BrokerOrder.exchangeToken` for why a consumer needs it and cannot use
   * the symbol instead. OMITTED, never 0, when the update carries none.
   */
  readonly exchangeToken?: number
  /**
   * WHAT THE FILLS ON THIS ORDER COST, cumulative, in the venue's currency —
   * the same running total `filledQty` is. The simulator's fee model sets it
   * (Delta's option fee + GST at the price it filled at); a live adapter sets
   * it from the venue's reported commission. OMITTED, never 0, when nothing
   * says what it cost: a missing fee is unknown, a 0 fee is a claim.
   */
  readonly fee?: number
}

export interface BrokerAdapter {
  readonly name: string
  readonly capabilities: BrokerCapabilities
  placeOrder(intent: OrderIntent): Promise<PlacedOrder>
  modifyOrder(brokerOrderId: string, price: number): Promise<boolean>
  cancelOrder(brokerOrderId: string): Promise<boolean>
  /**
   * Current broker-side net positions. `reconcile()` (@algomaker/order-bus)
   * needs this snapshot for restart recovery and cutover rollback (spec 8.5) —
   * a first-class adapter method, not an afterthought a future XTS implementer
   * has to discover on their own.
   */
  positions(): Promise<readonly BrokerPosition[]>
  /** Current broker-side order book, for the same reconciliation. */
  orderBook(): Promise<readonly BrokerOrder[]>
  onFill(handler: (order: PlacedOrder) => void): () => void
  /**
   * Every order-status transition, not just fills — WORKING, CANCELLED,
   * REJECTED included. Every onOrderUpdate should drive a WAL
   * `{kind:'STATUS'}` record, and OCO-pair cancellation depends on seeing the
   * other leg's status change. `onFill` remains as an alias kept for existing
   * callers that only care about the FILLED subset.
   */
  onOrderUpdate(handler: (order: PlacedOrder) => void): () => void
}

export class CapabilityError extends Error {}

/** Guard for call sites: throws rather than silently doing nothing. */
export function assertCanPlaceOrders(a: BrokerAdapter): void {
  if (!a.capabilities.orders) {
    throw new CapabilityError(`adapter '${a.name}' is market-data only and cannot place orders`)
  }
}
