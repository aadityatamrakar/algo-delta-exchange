/**
 * XTS interactive adapter — live order placement.
 *
 * A fresh implementation. `server/tools/xtsOrder.js` was read for its
 * OPERATIONAL knowledge (which errors retry, which need re-login, how a stop
 * becomes a stop-limit) and none of its code; that knowledge lives in
 * xts-protocol.ts, tested. Three defects in the original are deliberately not
 * reproduced:
 *
 *   - `parseInt` on limit/stop prices, which truncates a 2.90 option to 2
 *     (xtsOrder.js:145).
 *   - Re-multiplying an already-computed contract quantity by a hardcoded 15 or
 *     50 when recording the order (xtsOrder.js:175), which makes the stored
 *     quantity wrong for every symbol that is not a legacy index.
 *   - Retrying on ANY non-success response. A margin rejection is not a network
 *     hiccup, and resending an order the exchange refused risks placing it twice
 *     if the "refusal" was really a timeout.
 *
 * The XTS client is INJECTED. That keeps the retry state machine — the part
 * with the concurrency hazard in it — testable without a broker account.
 */

import type { OrderIntent } from '@algomaker/order-bus'
import {
  assertCanPlaceOrders,
  type BrokerAdapter,
  type BrokerCapabilities,
  // The BROKER-layer row, which carries the average traded price the order-bus
  // reconciliation shape has no field for. See `BrokerOrder` in types.ts.
  type BrokerOrder,
  type BrokerPosition,
  type PlacedOrder,
} from './types.ts'
import {
  classifyXtsError,
  correlationId,
  exchangeSegment,
  isSuccess,
  mapOrderStatus,
  mapOrderType,
  parseCorrelationId,
  roundToTick,
  stopLimitBand,
  type XtsErrorClass,
} from './xts-protocol.ts'

export interface XtsResponse {
  readonly type?: string
  readonly result?: { AppOrderID?: string | number; [k: string]: unknown }
  readonly error?: { message?: string }
}

export interface XtsOrderRequest {
  clientID: string
  exchangeSegment: string
  exchangeInstrumentID: number
  productType: string
  orderType: string
  orderSide: string
  timeInForce: string
  disclosedQuantity: number
  limitPrice: number
  stopPrice: number
  orderQuantity: number
  orderUniqueIdentifier: string
}

/** The slice of the XTS SDK this adapter uses. */
export interface XtsClient {
  readonly clientCodes: readonly string[]
  placeOrder(req: XtsOrderRequest): Promise<XtsResponse>
  modifyOrder(req: Record<string, unknown>): Promise<XtsResponse>
  cancelOrder(req: Record<string, unknown>): Promise<XtsResponse>
  getPosition?(req?: Record<string, unknown>): Promise<XtsResponse>
  getOrderBook?(req?: Record<string, unknown>): Promise<XtsResponse>
}

/**
 * Owns the session. `relogin` must be safe to call concurrently — the adapter
 * guarantees single-flight, but a caller may share one session across adapters.
 */
export interface XtsSession {
  current(): XtsClient
  relogin(): Promise<XtsClient>
}

export interface XtsAdapterOptions {
  readonly session: XtsSession
  /** Attempts per order, INCLUDING the first. */
  readonly maxAttempts?: number
  readonly productType?: string
  /** Injected so tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
  /** Instrument token -> XTS exchangeInstrumentID, when they differ. */
  readonly exchangeInstrumentId?: (intent: OrderIntent) => number
  /**
   * Account code for every order. OVERRIDES the session's, when set.
   *
   * `XtsRestClient` already applies its own configured code, so this exists for
   * a session that is NOT the REST client (an injected SDK client, a shared
   * session serving several sub-accounts). It is an override for the same reason
   * that one is: a dealer login may report a code that is not the one orders
   * must go out under, and there is no way to tell after the fact unless the
   * configured value is the value that was sent.
   */
  readonly clientId?: string
}

/**
 * A placement failure that KNOWS WHAT IT IS.
 *
 * `klass` is not decoration: `unknown` and `fatal` are both thrown without a
 * retry, and only this field tells them apart afterwards. The gateway books a
 * fatal tranche as failed (terminal, zero fill) and an unknown one as
 * AMBIGUOUS — non-terminal until the broker's own book answers. Re-classifying
 * the message at the catch site would work today and drift tomorrow, so the
 * class travels with the error.
 */
export class XtsOrderError extends Error {
  readonly klass: XtsErrorClass
  constructor(message: string, klass: XtsErrorClass) {
    super(message)
    this.name = 'XtsOrderError'
    this.klass = klass
  }
}

/**
 * Terminal at the broker — an order in any of these states cannot be modified.
 *
 * The legacy account model's own list (`xts-account.js:509`), which
 * `apps/order-gateway/src/cancel-queue.ts` also carries as
 * `CLOSED_ORDER_STATUS`. Duplicated rather than shared: a package cannot depend
 * on an app, and the four names are the exchange's, not ours — they change when
 * XTS changes, not when either caller does.
 *
 * `Replaced` belongs here for a reason of its own: it means an earlier modify
 * already went through and the id we hold is the OLD one.
 */
const TERMINAL_ORDER_STATUS: readonly string[] = ['Filled', 'Replaced', 'Cancelled', 'Rejected']

export class XtsAdapter implements BrokerAdapter {
  readonly name = 'xts'
  readonly capabilities: BrokerCapabilities = { orders: true, marketData: false, modify: true }

  readonly #o: XtsAdapterOptions
  readonly #handlers: ((o: PlacedOrder) => void)[] = []
  /** In-flight re-login, shared by every caller that needs one. */
  #reloginInFlight: Promise<XtsClient> | null = null

  constructor(opts: XtsAdapterOptions) {
    this.#o = opts
  }

  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    assertCanPlaceOrders(this)
    const maxAttempts = this.#o.maxAttempts ?? 3
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    const log = this.#o.log ?? ((): void => {})

    const req = this.#buildRequest(intent)
    let lastError = 'unknown'
    let lastKlass: XtsErrorClass = 'transient'

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let client: XtsClient
      try {
        client = this.#o.session.current()
      } catch (err) {
        throw new XtsOrderError(`no XTS session: ${msgOf(err)}`, 'session')
      }
      // clientID can change across a re-login, so it is resolved per attempt.
      // A configured code wins over the session's — see `clientId`'s comment.
      const configured = (this.#o.clientId ?? '').trim()
      const attemptReq: XtsOrderRequest = {
        ...req,
        clientID: configured !== '' ? configured : client.clientCodes[0] ?? req.clientID,
      }

      let resp: XtsResponse
      try {
        resp = await client.placeOrder(attemptReq)
      } catch (err) {
        resp = { type: 'error', error: { message: msgOf(err) } }
      }

      if (isSuccess(resp)) {
        const brokerOrderId = String(resp.result?.AppOrderID ?? '')
        if (brokerOrderId === '') {
          // Success with no id: the order may well be live, so this must NOT be
          // retried. Surfacing it un-correlated is bad; a duplicate is worse.
          throw new XtsOrderError('XTS reported success with no AppOrderID', 'fatal')
        }
        return {
          brokerOrderId,
          clientOrderId: intent.clientOrderId,
          status: 'PENDING_NEW',
          filledQty: 0,
          avgPrice: null,
        }
      }

      lastError = resp.error?.message ?? 'unknown XTS error'
      const klass = classifyXtsError(lastError)
      log('order attempt failed', { attempt, klass, clientOrderId: intent.clientOrderId })

      /**
       * NEITHER OF THESE RETRIES, for opposite reasons.
       *
       * `fatal` is a refusal: the exchange said no, and resending it risks a
       * double placement if the "refusal" was really a timeout.
       *
       * `unknown` IS that timeout. The request may already be at the exchange,
       * so a retry is the double placement — and reporting failure un-books a
       * live position. Stopping here, with the class attached, is what lets the
       * gateway hold the tranche ambiguous until the broker book settles it
       * (F-3). The classification is passed through rather than re-derived: one
       * decision, one answer.
       */
      if (klass === 'fatal' || klass === 'unknown') {
        throw new XtsOrderError(lastError, klass)
      }
      lastKlass = klass
      if (attempt === maxAttempts) break
      if (klass === 'session') {
        /**
         * A FAILING RE-LOGIN MUST NOT DOWNGRADE WHAT WE ALREADY KNOW.
         *
         * `session` is a PROOF of non-placement: the token was refused, so the
         * order never reached the exchange. Left unguarded, the re-login's own
         * transport failure escapes as a plain `Error('fetch failed')`, which
         * classifies as `unknown` — "the order may be live" — and the gateway
         * then holds the tranche ambiguous for the whole TTL while the desk
         * believes an exit is resting that never existed.
         *
         * `fatal` is the honest class. It says the order is not at the exchange
         * and retrying it here will not help, which is exactly the situation:
         * two facts, both named in the message so the operator does not have to
         * infer the second from the first.
         */
        try {
          await this.#reloginOnce()
        } catch (err) {
          throw new XtsOrderError(
            `order NOT placed: session refused and relogin failed: ${msgOf(err)}`,
            'fatal',
          )
        }
      } else {
        await sleep(1000)
      }
    }

    // The LAST attempt's classification, not a hard-coded one. The class is the
    // only thing the gateway has to reason with, and inventing it here would
    // overwrite a decision `classifyXtsError` already made correctly.
    throw new XtsOrderError(`order failed after ${maxAttempts} attempts: ${lastError}`, lastKlass)
  }

  /**
   * Re-login, at most once concurrently.
   *
   * Every in-flight order fails at the same moment when a session expires. Left
   * unguarded, each would independently hit the login endpoint, and XTS
   * invalidates the previous token on each login — so N concurrent logins can
   * leave N-1 orders holding a token that was killed by the login after theirs.
   * The shared promise makes them all wait for one.
   */
  async #reloginOnce(): Promise<XtsClient> {
    const existing = this.#reloginInFlight
    if (existing !== null) return await existing
    const p = (async (): Promise<XtsClient> => {
      try {
        return await this.#o.session.relogin()
      } finally {
        this.#reloginInFlight = null
      }
    })()
    this.#reloginInFlight = p
    return await p
  }

  #buildRequest(intent: OrderIntent): XtsOrderRequest {
    const tick = intent.instrument.tickSize > 0 ? intent.instrument.tickSize : 0.05
    let limitPrice = 0
    let stopPrice = 0

    if (intent.orderType === 'LIMIT' && intent.limitPrice !== undefined) {
      limitPrice = roundToTick(intent.limitPrice, tick)
    }
    if (
      (intent.orderType === 'SL_MARKET' || intent.orderType === 'SL_LIMIT') &&
      intent.triggerPrice !== undefined
    ) {
      const band = stopLimitBand(intent.side, intent.triggerPrice, tick)
      stopPrice = band.stopPrice
      limitPrice =
        intent.orderType === 'SL_LIMIT' && intent.limitPrice !== undefined
          ? roundToTick(intent.limitPrice, tick)
          : band.limitPrice
    }

    return {
      clientID: '',
      exchangeSegment: exchangeSegment(intent.instrument.exchange),
      exchangeInstrumentID:
        this.#o.exchangeInstrumentId?.(intent) ?? (intent.instrument.instrumentToken ?? 0),
      productType: this.#o.productType ?? 'NRML',
      orderType: mapOrderType(intent.orderType),
      orderSide: intent.side,
      timeInForce: 'DAY',
      disclosedQuantity: 0,
      limitPrice,
      stopPrice,
      // Contract quantity as-is. No hidden re-multiplication.
      orderQuantity: intent.quantity,
      orderUniqueIdentifier: correlationId(intent.strategyTag, intent.clientOrderId),
    }
  }

  /**
   * Reprice a resting order — the WHOLE `modified*` set, sourced from its row.
   *
   * `PUT /orders` is a REPLACE, not a patch. The documented body carries
   * modifiedProductType, modifiedOrderType, modifiedOrderQuantity,
   * modifiedDisclosedQuantity, modifiedLimitPrice, modifiedStopPrice and
   * modifiedTimeInForce, and a field the body omits is NOT "left as it was" —
   * it is whatever the build decides it is. This method used to send two fields
   * ({appOrderID, modifiedLimitPrice}) and had never had a live caller; the
   * order-chaser is the first. Either it was rejected outright, or — worse —
   * some XTS build accepted it and rewrote a LIVE order's quantity, product and
   * type with values nobody chose. So every field except the price is read back
   * off the broker's own row: the modify RESTATES the order as it already is,
   * and moves the one number it was asked to move.
   *
   * AND IT NEEDS A clientID. This is a DEALER account (`clientCodes[0] ===
   * '*****'`, see `isInvestorClient` in xts-rest.ts) and a dealer request with
   * no client comes back `e-orders-0002 ClientID cannot be empty` — the
   * 2026-07-30 failure that `cancelBrokerOrder` already learned from. It comes
   * from the ROW, not from configuration, for the reason the cancel takes it
   * from there: the order carries the client it was placed for, so a
   * multi-client dealer login modifies each order against the right one with no
   * lookup. `XtsRestClient.modifyOrder` injects the session's code underneath
   * as a second line of defence.
   *
   * FALSE, never a throw, when the order is absent from the book or already
   * terminal. There is nothing to reprice, and the chaser advances its bounded
   * ladder only on a modify the broker accepted.
   */
  async modifyOrder(brokerOrderId: string, price: number): Promise<boolean> {
    const log = this.#o.log ?? ((): void => {})
    const client = this.#o.session.current()

    const row = await this.#rawOrderRow(client, brokerOrderId)
    if (row === null) {
      log('modify skipped: order is not in the broker book', { brokerOrderId })
      return false
    }
    const status = String(row['OrderStatus'] ?? '')
    if (TERMINAL_ORDER_STATUS.includes(status)) {
      log('modify skipped: order is already terminal', { brokerOrderId, status })
      return false
    }

    const productType = String(row['ProductType'] ?? '')
    // WHAT IT WAS, deliberately. The chaser only ever moves the price of a
    // LIMIT, so the type it went out as is the type it stays; deriving one here
    // is how a StopLimit silently loses its stop.
    const orderType = String(row['OrderType'] ?? '')
    const timeInForce = String(row['TimeInForce'] ?? '')
    // `OrderQuantity`, NEVER `LeavesQuantity`: the modify restates the order's
    // TOTAL quantity, so sending the remainder of a partial fill would shrink
    // the order to what is left of it — the chaser reprices a partial's
    // remainder precisely by leaving this untouched.
    const orderQuantity = numberOf(row['OrderQuantity'], 0)
    if (productType === '' || orderType === '' || timeInForce === '' || orderQuantity <= 0) {
      // A field the row does not carry cannot be restated, and inventing one is
      // the defect this whole method exists to avoid. Refuse instead.
      log('modify refused: the broker row does not carry the fields a modify must restate', {
        brokerOrderId,
        productType,
        orderType,
        timeInForce,
        orderQuantity,
      })
      return false
    }

    const req: Record<string, unknown> = {
      appOrderID: row['AppOrderID'] ?? brokerOrderId,
      modifiedProductType: productType,
      modifiedOrderType: orderType,
      modifiedOrderQuantity: orderQuantity,
      modifiedDisclosedQuantity: numberOf(row['OrderDisclosedQuantity'], 0),
      // THE ONE FIELD THAT CHANGES.
      modifiedLimitPrice: price,
      modifiedStopPrice: numberOf(row['OrderStopPrice'], 0),
      modifiedTimeInForce: timeInForce,
      orderUniqueIdentifier: String(row['OrderUniqueIdentifier'] ?? ''),
    }
    const rowClient = String(row['ClientID'] ?? '')
    // Omitted rather than sent empty, exactly as the cancel omits it: an
    // explicit `clientID: ''` IS `e-orders-0002`, and omitting it is what lets
    // the REST layer substitute the session's code.
    if (rowClient !== '') req['clientID'] = rowClient

    const resp = await client.modifyOrder(req)
    if (!isSuccess(resp)) {
      log('modify refused by the broker', { brokerOrderId, error: resp.error?.message ?? '' })
      return false
    }
    return true
  }

  /**
   * The broker's OWN row for one order, RAW.
   *
   * Deliberately not `orderBook()`. That projects each row onto `BrokerOrder`'s
   * five reconciliation fields and drops every one a modify has to restate —
   * ProductType, OrderType, OrderQuantity, OrderDisclosedQuantity,
   * OrderStopPrice, TimeInForce, ClientID. The projection is right for
   * reconciliation and useless here, so the raw rows are read instead.
   *
   * Null on all of: a client with no book endpoint, a read that failed, no
   * matching row. They mean one thing to the caller — we do not know this order
   * well enough to restate it — and none of them deserves a throw on a path
   * driven by a `setInterval`.
   */
  async #rawOrderRow(
    client: XtsClient,
    brokerOrderId: string,
  ): Promise<Record<string, unknown> | null> {
    if (client.getOrderBook === undefined) return null
    let resp: XtsResponse
    try {
      resp = await client.getOrderBook()
    } catch {
      return null
    }
    const rows = resp.result as unknown
    if (!Array.isArray(rows)) return null
    const want = String(brokerOrderId)
    return (
      (rows as Record<string, unknown>[]).find((r) => String(r['AppOrderID'] ?? '') === want) ?? null
    )
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    const resp = await this.#o.session.current().cancelOrder({ appOrderID: brokerOrderId })
    return isSuccess(resp)
  }

  async positions(): Promise<readonly BrokerPosition[]> {
    const client = this.#o.session.current()
    if (client.getPosition === undefined) return []
    const resp = await client.getPosition({ dayOrNet: 'NetWise' })
    const list = (resp.result?.['positionList'] as Record<string, unknown>[] | undefined) ?? []
    return list.map((p) => ({
      tradingsymbol: String(p['TradingSymbol'] ?? ''),
      // SIGNED, as `reconcile()` requires: XTS reports Quantity already signed
      // for net-wise positions. An unsigned quantity here would make every short
      // leg look like a long one and produce a QTY_MISMATCH on every reconcile.
      netQty: Number(p['Quantity'] ?? 0),
      avgPrice: Number(p['BuyAveragePrice'] ?? p['AveragePrice'] ?? 0),
    }))
  }

  async orderBook(): Promise<readonly BrokerOrder[]> {
    const client = this.#o.session.current()
    if (client.getOrderBook === undefined) return []
    const resp = await client.getOrderBook()
    const list = (resp.result as Record<string, unknown>[] | undefined) ?? []
    return list.map((o) => ({
      brokerOrderId: String(o['AppOrderID'] ?? ''),
      // Recovered from the correlation id — this is what lets a restart match
      // broker orders back to our intents. Null when the order did not come
      // from us (a manual order on the same account), which `reconcile()`
      // reports rather than silently adopting.
      clientOrderId: parseCorrelationId(o['OrderUniqueIdentifier'] as string | undefined)
        ?.clientOrderId ?? null,
      tradingsymbol: String(o['TradingSymbol'] ?? ''),
      // The exchange token, which is what a consumer matches a row to an
      // order BY — the symbol above is XTS's spelling, and the desk's order
      // documents carry the instrument master's. Null when the row has none.
      exchangeToken: exchangeTokenOf(o) ?? null,
      status: mapOrderStatus(String(o['OrderStatus'] ?? '')) ?? 'PENDING_NEW',
      filledQty: Number(o['CumulativeQuantity'] ?? 0),
      // The SAME mapping the socket path uses, deliberately shared: the sweep
      // replays these rows through the very handler the socket feeds, and a
      // price that differed by route would make a fill's average depend on
      // which path delivered it.
      avgPrice: avgPriceOf(o['OrderAverageTradedPrice']),
    }))
  }

  /**
   * Feed an order-update message in from the XTS interactive socket.
   *
   * The socket is owned by the gateway, not the adapter — one socket per
   * account serves every adapter — so updates are pushed in rather than
   * subscribed to here.
   */
  ingestOrderUpdate(raw: Record<string, unknown>): PlacedOrder | null {
    const correlation = parseCorrelationId(
      raw['OrderUniqueIdentifier'] as string | undefined,
    )
    const status = mapOrderStatus(raw['OrderStatus'] as string | undefined)
    // Without a correlation id we cannot attribute the fill to an intent, and
    // guessing by symbol would attribute it to the wrong leg of a ladder that
    // holds several orders on the same contract.
    if (correlation === null || status === null) return null
    const exchangeToken = exchangeTokenOf(raw)
    const update: PlacedOrder = {
      brokerOrderId: String(raw['AppOrderID'] ?? ''),
      clientOrderId: correlation.clientOrderId,
      status,
      filledQty: Number(raw['CumulativeQuantity'] ?? 0),
      avgPrice: avgPriceOf(raw['OrderAverageTradedPrice']),
      // The broker's own symbol, so the consumer never has to guess which
      // contract filled. Omitted rather than empty when XTS does not send one.
      ...(typeof raw['TradingSymbol'] === 'string' && raw['TradingSymbol'] !== ''
        ? { tradingsymbol: raw['TradingSymbol'] }
        : {}),
      // Same rule as the symbol: present when XTS sent one, absent otherwise.
      // The v2 `trade` event drops `TradingSymbol`, so this may be the only
      // contract identity an update carries.
      ...(exchangeToken === undefined ? {} : { exchangeToken }),
      ...(status === 'REJECTED'
        ? { rejectReason: String(raw['CancelRejectReason'] ?? 'rejected') }
        : {}),
    }
    for (const h of this.#handlers) h(update)
    return update
  }

  onOrderUpdate(handler: (order: PlacedOrder) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const i = this.#handlers.indexOf(handler)
      if (i >= 0) this.#handlers.splice(i, 1)
    }
  }

  /** @deprecated Alias for {@link onOrderUpdate}. */
  onFill(handler: (order: PlacedOrder) => void): () => void {
    return this.onOrderUpdate(handler)
  }
}

/**
 * `OrderAverageTradedPrice` -> a price, or NULL where there is no average.
 *
 * Null, never 0. An order that has not traded reports an empty field, and
 * `Number('')` is 0 — a fill "at zero" that would be averaged into a real
 * position's price and reported to the desk as the price it paid.
 */
function avgPriceOf(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  // XTS has been seen to send the average GROUPED ("1,410.80" — the 1.160
  // socket sample in Symphony's own change log). `Number('1,410.80')` is NaN,
  // which read as "no average" and priced a real fill off nothing.
  const n = Number(typeof raw === 'string' ? raw.replace(/,/g, '') : raw)
  return Number.isFinite(n) ? n : null
}

/**
 * The exchange's instrument id off an XTS row, or undefined when it has none.
 *
 * XTS names the field `ExchangeInstrumentID` in its docs and
 * `ExchangeInstrumentId` in this account's replies, and sends it as a STRING
 * (`"ExchangeInstrumentId":"149471"`) — so it is coerced rather than
 * type-checked, and every casing is tried, for the same reason
 * `apps/api positions-compare.ts brokerExchangeToken` gives: a different XTS
 * build must not silently stop every row resolving. The key list is a copy of
 * that one, not an import — this package does not depend on the API app.
 *
 * UNDEFINED, NEVER 0 OR NaN, for anything that is not a positive integer. A
 * consumer compares this with the order document's token to decide whether a
 * row belongs to an order, and a garbage value read as "the token" would
 * refuse every row on a mismatch the coercion invented.
 */
function exchangeTokenOf(raw: Record<string, unknown>): number | undefined {
  for (const key of [
    'ExchangeInstrumentID',
    'ExchangeInstrumentId',
    'exchangeInstrumentID',
    'exchangeInstrumentId',
  ]) {
    const v = raw[key]
    if (v === undefined || v === null || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n
  }
  return undefined
}

/**
 * A broker row's numeric field, or `fallback` when it does not carry one.
 *
 * Stated rather than left to coercion, because this feeds a REPLACE body:
 * `Number(undefined)` is NaN and `JSON.stringify` turns NaN into `null`, which
 * is exactly the "field the caller did not specify" the exchange would then be
 * free to fill in itself.
 */
function numberOf(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
