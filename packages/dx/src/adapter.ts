/**
 * DxAdapter — the Delta India `BrokerAdapter`.
 *
 * OrderIntent → Delta order:
 *   instrument.instrumentToken → product_id (else tradingsymbol → product_symbol)
 *   quantity (BTC on the lotSize grid) → size = contractsOf(quantity, lotSize);
 *     must equal `lots`; off-grid, zero or mismatched is refused, never rounded
 *   side BUY/SELL → buy/sell
 *   LIMIT only → limit_order; limitPrice → a string on the tick, rounded
 *     passively (buy down, sell up)
 *   clientOrderId → client_order_id (≤ 32 chars; a stable hash of a longer id)
 *   meta.reduceOnly === true or meta.desk_op === 'close' → reduce_only
 *   meta.timeInForce === 'ioc' → ioc, else gtc
 *
 * Quantities reported back (fills, positions, the order book) are BTC again.
 *
 * Errors are `DxOrderError`, a subclass of `XtsOrderError` so the gateway's
 * existing `err.klass` handling applies unchanged:
 *   429 → back off for X-RATE-LIMIT-RESET and retry (a 429 proves the order
 *         was not placed); still 429 after `maxAttempts` → 'transient'
 *   no response / 5xx → 'unknown' (may be live; never retried)
 *   any other refusal, or a bad intent → 'fatal'
 *
 * Capacity caps and the paper/live routing rule are the gateway's (Task 6);
 * this adapter places whatever reaches it.
 */
import { createHash } from 'node:crypto'
import {
  XtsOrderError,
  assertCanPlaceOrders,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerOrder,
  type BrokerPosition,
  type PlacedOrder,
  type XtsErrorClass,
} from '@algomaker/brokers'
import type { OrderIntent, OrderStatus } from '@algomaker/order-bus'
import { num } from './normalise.ts'
import { contractsOf, priceOnTick, priceString, qtyOfContracts } from './qty.ts'
import { DxApiError } from './rest.ts'
import type { DxRest } from './rest.ts'
import type { DxOrder, DxOrderRequest } from './types.ts'

/** The slice of `DxRest` the adapter uses (a fake in tests). */
export type DxTradingClient = Pick<
  DxRest,
  'placeOrder' | 'cancelOrder' | 'editOrder' | 'openOrders' | 'orderHistory' | 'positions'
>

export interface DxAdapterOptions {
  readonly rest: DxTradingClient
  /** BTC per contract, for rows that do not name their instrument. Default 0.001. */
  readonly qtyStep?: number
  /** Tick for repricing an order this process did not place. Default 0.1. */
  readonly defaultTick?: number
  /** Attempts per order on 429, including the first. Default 3. */
  readonly maxAttempts?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

export class DxOrderError extends XtsOrderError {
  constructor(message: string, klass: XtsErrorClass) {
    super(message, klass)
    this.name = 'DxOrderError'
  }
}

const CLIENT_ID_OK = /^[A-Za-z0-9_-]{1,32}$/

/**
 * The desk's client id as Delta may carry it: unchanged when it is ≤ 32 chars
 * of `[A-Za-z0-9_-]`, else a stable 32-char hash (`h` + 31 base64url chars of
 * SHA-256), so the same desk id always maps to the same Delta id.
 */
export function dxClientOrderId(id: string): string {
  if (CLIENT_ID_OK.test(id)) return id
  return 'h' + createHash('sha256').update(id).digest('base64url').slice(0, 31)
}

interface Known {
  readonly productId: number
  readonly side: 'BUY' | 'SELL'
  readonly tick: number
  readonly step: number
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class DxAdapter implements BrokerAdapter {
  readonly name = 'delta'
  readonly capabilities: BrokerCapabilities = { orders: true, marketData: false, modify: true }

  readonly #o: DxAdapterOptions
  readonly #handlers: ((o: PlacedOrder) => void)[] = []
  /** Delta client id → desk client id, for ids that were hashed. */
  readonly #deskIds = new Map<string, string>()
  /** Delta order id → what modify/cancel/fill mapping need. */
  readonly #known = new Map<string, Known>()

  constructor(opts: DxAdapterOptions) {
    this.#o = opts
  }

  get #step(): number {
    return this.#o.qtyStep ?? 0.001
  }

  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    assertCanPlaceOrders(this)
    const req = this.#buildRequest(intent)
    const deskId = intent.clientOrderId
    if (req.client_order_id !== undefined) this.#deskIds.set(req.client_order_id, deskId)

    const maxAttempts = this.#o.maxAttempts ?? 3
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    let last = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let order: DxOrder
      try {
        order = await this.#o.rest.placeOrder(req)
      } catch (err) {
        if (err instanceof DxApiError && err.status === 429) {
          last = err.message
          this.#o.log?.('delta 429, backing off', { attempt, retryAfterMs: err.retryAfterMs, clientOrderId: deskId })
          if (attempt < maxAttempts) await sleep(err.retryAfterMs ?? 1000)
          continue
        }
        throw new DxOrderError(`order ${deskId}: ${msgOf(err)}`, classify(err))
      }
      const step = intent.instrument.lotSize
      this.#known.set(String(order.id), {
        productId: order.product_id,
        side: intent.side,
        tick: intent.instrument.tickSize > 0 ? intent.instrument.tickSize : (this.#o.defaultTick ?? 0.1),
        step,
      })
      return this.#placed(order, step)
    }
    throw new DxOrderError(`order ${deskId} NOT placed: rate-limited on all ${maxAttempts} attempts: ${last}`, 'transient')
  }

  async modifyOrder(brokerOrderId: string, price: number): Promise<boolean> {
    const k = await this.#lookup(brokerOrderId)
    if (k === null) return false
    const p = priceOnTick(price, k.tick, k.side)
    if (!(p > 0)) return false
    try {
      await this.#o.rest.editOrder({ id: Number(brokerOrderId), productId: k.productId, limitPrice: priceString(p, k.tick) })
      return true
    } catch (err) {
      if (isRefusal(err)) return false
      throw err
    }
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    const k = await this.#lookup(brokerOrderId)
    if (k === null) return false
    try {
      await this.#o.rest.cancelOrder(Number(brokerOrderId), k.productId)
      return true
    } catch (err) {
      if (isRefusal(err)) return false
      throw err
    }
  }

  async positions(): Promise<readonly BrokerPosition[]> {
    const rows = await this.#o.rest.positions()
    return rows.map((p) => ({
      tradingsymbol: p.product_symbol,
      netQty: qtyOfContracts(p.size, this.#step),
      avgPrice: num(p.entry_price) ?? 0,
    }))
  }

  /** Open orders plus the latest page of closed/cancelled ones. */
  async orderBook(): Promise<readonly BrokerOrder[]> {
    const [open, done] = await Promise.all([this.#o.rest.openOrders(), this.#o.rest.orderHistory()])
    const seen = new Set<number>()
    const out: BrokerOrder[] = []
    for (const o of [...open, ...done]) {
      if (seen.has(o.id)) continue
      seen.add(o.id)
      const step = this.#known.get(String(o.id))?.step ?? this.#step
      const dxId = o.client_order_id ?? null
      out.push({
        brokerOrderId: String(o.id),
        clientOrderId: dxId === null ? null : (this.#deskIds.get(dxId) ?? dxId),
        tradingsymbol: o.product_symbol ?? '',
        status: mapStatus(o.state, o.size, o.unfilled_size),
        filledQty: qtyOfContracts(o.size - o.unfilled_size, step),
        avgPrice: num(o.average_fill_price),
        exchangeToken: o.product_id,
      })
    }
    return out
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

  /**
   * Feed one private-socket message (the raw object, or `DxFrame.raw`).
   * `orders` create/update/delete and snapshot rows become order updates;
   * everything else is ignored here.
   */
  onPrivateFrame(raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    const m = raw as Record<string, unknown>
    if (m['type'] !== 'orders') return
    const rows = m['action'] === 'snapshot' && Array.isArray(m['result']) ? (m['result'] as unknown[]) : [m]
    for (const r of rows) {
      const u = this.#fromFrameRow(r)
      if (u === null) continue
      for (const h of [...this.#handlers]) h(u)
    }
  }

  // ---------------------------------------------------------------- internals

  #fromFrameRow(r: unknown): PlacedOrder | null {
    if (r === null || typeof r !== 'object') return null
    const o = r as Record<string, unknown>
    const id = num(o['order_id'] ?? o['id'])
    const size = num(o['size'])
    const unfilled = num(o['unfilled_size'])
    if (id === null || size === null || unfilled === null) return null
    const step = this.#known.get(String(id))?.step ?? this.#step
    const dxId = typeof o['client_order_id'] === 'string' ? o['client_order_id'] : ''
    const symbol = o['product_symbol'] ?? o['symbol']
    const productId = num(o['product_id'])
    return {
      brokerOrderId: String(id),
      clientOrderId: this.#deskIds.get(dxId) ?? dxId,
      status: mapStatus(String(o['state'] ?? ''), size, unfilled),
      filledQty: qtyOfContracts(size - unfilled, step),
      avgPrice: num(o['average_fill_price']),
      ...(typeof symbol === 'string' && symbol !== '' ? { tradingsymbol: symbol } : {}),
      ...(productId === null ? {} : { exchangeToken: productId }),
    }
  }

  #placed(order: DxOrder, step: number): PlacedOrder {
    const dxId = order.client_order_id ?? ''
    return {
      brokerOrderId: String(order.id),
      clientOrderId: this.#deskIds.get(dxId) ?? dxId,
      status: mapStatus(order.state, order.size, order.unfilled_size),
      filledQty: qtyOfContracts(order.size - order.unfilled_size, step),
      avgPrice: num(order.average_fill_price),
      ...(order.product_symbol === undefined ? {} : { tradingsymbol: order.product_symbol }),
      exchangeToken: order.product_id,
    }
  }

  async #lookup(brokerOrderId: string): Promise<Known | null> {
    const k = this.#known.get(brokerOrderId)
    if (k !== undefined) return k
    // Not placed by this process (a restart): find it in Delta's open book.
    const open = await this.#o.rest.openOrders()
    const o = open.find((x) => String(x.id) === brokerOrderId)
    if (o === undefined) return null
    const found: Known = {
      productId: o.product_id,
      side: o.side === 'sell' ? 'SELL' : 'BUY',
      tick: this.#o.defaultTick ?? 0.1,
      step: this.#step,
    }
    this.#known.set(brokerOrderId, found)
    return found
  }

  #buildRequest(intent: OrderIntent): DxOrderRequest {
    const id = intent.clientOrderId
    const bad = (why: string): DxOrderError => new DxOrderError(`order ${id} refused: ${why}`, 'fatal')

    if (intent.orderType !== 'LIMIT') throw bad(`limit orders only (got ${intent.orderType})`)
    const lp = intent.limitPrice
    if (lp === undefined || !Number.isFinite(lp) || lp <= 0) throw bad(`limit price ${String(lp)} is not a positive number`)

    const step = intent.instrument.lotSize
    if (!(step > 0)) throw bad(`instrument ${intent.instrument.tradingsymbol} has no lot size`)
    let contracts: number
    try {
      contracts = contractsOf(intent.quantity, step)
    } catch {
      throw bad(`quantity ${intent.quantity} is not on the ${step} grid`)
    }
    if (contracts <= 0) throw bad(`quantity ${intent.quantity} is not a positive number of contracts`)
    if (intent.lots !== contracts) throw bad(`lots ${intent.lots} ≠ ${contracts} contracts in quantity ${intent.quantity}`)

    const tick = intent.instrument.tickSize > 0 ? intent.instrument.tickSize : (this.#o.defaultTick ?? 0.1)
    const price = priceOnTick(lp, tick, intent.side)
    if (!(price > 0)) throw bad(`limit price ${lp} rounds to ${price} on the ${tick} tick`)

    const meta = intent.meta ?? {}
    const token = intent.instrument.instrumentToken
    return {
      ...(token !== undefined && token > 0
        ? { product_id: token }
        : { product_symbol: intent.instrument.tradingsymbol }),
      size: contracts,
      side: intent.side === 'BUY' ? 'buy' : 'sell',
      order_type: 'limit_order',
      limit_price: priceString(price, tick),
      time_in_force: meta['timeInForce'] === 'ioc' ? 'ioc' : 'gtc',
      reduce_only: meta['reduceOnly'] === true || meta['desk_op'] === 'close',
      client_order_id: dxClientOrderId(id),
    }
  }
}

/** Delta order state + sizes → desk status. */
export function mapStatus(state: string, size: number, unfilled: number): OrderStatus {
  switch (state) {
    case 'closed':
      return unfilled === 0 ? 'FILLED' : 'CANCELLED'
    case 'cancelled':
      return 'CANCELLED'
    case 'open':
      return unfilled < size ? 'PARTIALLY_FILLED' : 'WORKING'
    case 'pending':
      return 'WORKING'
    default:
      return 'PENDING_NEW'
  }
}

function classify(err: unknown): XtsErrorClass {
  if (err instanceof DxApiError) {
    if (err.code === 'not_sent') return 'fatal'
    if (err.status === 0 || err.status >= 500) return 'unknown'
    return 'fatal'
  }
  // Anything else (a bug, a thrown non-API error): we cannot say it did not go out.
  return 'unknown'
}

/** A 4xx: Delta answered and said no. */
const isRefusal = (err: unknown): boolean => err instanceof DxApiError && err.status >= 400 && err.status < 500
