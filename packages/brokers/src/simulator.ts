/**
 * Paper adapter that actually FILLS resting orders.
 *
 * The legacy simulator could not: server/boot/paperstream.js:353 returns unless
 * `status === 'COMPLETE'`, while trackOrder_slm/trackOrder_limit insert
 * 'Pending'. So stop and limit orders rested forever and D3 (resting SL/target)
 * was impossible to rehearse in paper. Under a cutover that is unacceptable —
 * paper is the only rehearsal there is.
 *
 * Fill model:
 *   MARKET     fills immediately at the last tick
 *   SL_MARKET  fills when a tick crosses the trigger, then slips AGAINST us
 *   LIMIT      fills at the touch when the book crosses it (a buy at the ask, a
 *              sell at the bid, so it pays the spread), else when a tick trades
 *              through the limit; no slippage either way
 */
import type { OrderIntent } from '@algomaker/order-bus'
import type { BrokerAdapter, BrokerCapabilities, BrokerOrder, BrokerPosition, PlacedOrder } from './types.ts'

interface Resting {
  brokerOrderId: string
  intent: OrderIntent
  trigger: number
  token: number
}

/**
 * The best bid and ask a tick carried. A side is null when the book has none:
 * absent is "unknown", never zero, so a side that is not there cannot be taken.
 */
interface Touch {
  readonly bid: number | null
  readonly ask: number | null
}

/** A real price off a quote side, or null. `typeof` because types are erased at the wire. */
function positive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * The touch a quote describes, or null when it describes none.
 *
 * Checked here because this is the last stop before a quoted price becomes a
 * FILL. Unguarded, `0 <= limit` buys for nothing and `Infinity >= limit` sells
 * at Infinity, and either can arrive from a caller that trusted its frame, so a
 * side that is not a positive finite number is unknown. A crossed book (ask
 * under bid) is a bad frame rather than a market, and the gateway's QuoteMap
 * drops the same frame; a fill off it would pay better than any real book
 * offered. A locked market (ask equal to bid) is real and is kept.
 */
function touchOf(
  quote: { readonly bid: number | null; readonly ask: number | null } | undefined,
): Touch | null {
  if (quote === undefined) return null
  const bid = positive(quote.bid)
  const ask = positive(quote.ask)
  if (bid === null && ask === null) return null
  if (bid !== null && ask !== null && ask < bid) return null
  return { bid, ask }
}

interface Position {
  netQty: number
  avgPrice: number
}

export interface SimulatorOptions {
  /** Price given up when a stop triggers. Applied against the order's side. */
  readonly slippage?: number
  /**
   * Distinguishes THIS adapter's order ids from every other adapter's.
   *
   * Defaults to a fresh value per construction. Pass one only to make ids
   * reproducible in a test; two adapters sharing a runId reissue the same ids,
   * which is the very collision this exists to prevent.
   */
  readonly runId?: string
}

/**
 * A run token no other construction repeats.
 *
 * WHY THE IDS CANNOT JUST COUNT (2026-09-16). `#seq` is per-instance, so every
 * gateway restart began again at `sim-1` — while `desk-fills` kept every row
 * ever written. `sim-5` was TATASTEEL26SEP182.5PE filled 2750 on Sep 8 and
 * SENSEX2691778000CE filled 60 on Sep 16, and `FillWatcher` — which adopts a
 * row by broker id — credited the SENSEX order with TATASTEEL's 2750 at
 * TATASTEEL's price. The book then chased a 710-share residual that did not
 * exist, refused INVALID every 6s because 710 is not a whole 20-share lot.
 *
 * Time alone is not enough — two adapters built in the same millisecond would
 * share it — so the random suffix carries the uniqueness while the timestamp
 * keeps ids sortable and legible.
 */
function freshRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The exchange token a real broker would echo for this intent, so a paper
 * fill carries the same contract identity a live one does and the gateway's
 * fill attribution exercises the same guard on both rails. The instrument
 * master's token is Zerodha-PACKED (`exchange_token * 256 + segment`), the
 * same unpacking the XTS order path applies. Omitted when the intent has no
 * token: absent is "unknown", 0 would be read as a token.
 */
function exchangeTokenFor(intent: OrderIntent): { exchangeToken?: number } {
  const packed = intent.instrument.instrumentToken ?? 0
  return packed > 0 ? { exchangeToken: Math.floor(packed / 256) } : {}
}

export class SimulatorAdapter implements BrokerAdapter {
  readonly name = 'simulator'
  readonly capabilities: BrokerCapabilities = { orders: true, marketData: false, modify: true }

  readonly #last = new Map<number, number>()
  /** The last known touch per token, beside the last print; `feedTick` says how long it lives. */
  readonly #touch = new Map<number, Touch>()
  readonly #resting = new Map<string, Resting>()
  readonly #handlers: ((o: PlacedOrder) => void)[] = []
  readonly #positions = new Map<string, Position>()
  readonly #slippage: number
  readonly #runId: string
  #seq = 0

  constructor(opts: SimulatorOptions = {}) {
    this.#slippage = opts.slippage ?? 0
    this.#runId = opts.runId ?? freshRunId()
  }

  /**
   * One tick for `token`: the last trade, and the book's best bid and ask when
   * the feed has them (`md.tick` carries both whenever the book has a touch).
   * A caller with no book passes none and gets the print-only model exactly as
   * it always was.
   *
   * THE TOUCH LIVES ONE TICK, like a last price but never longer. A tick that
   * carries a book replaces it. A tick that carries none (the book has gone
   * one-sided, or empty) still gets one look at the previous touch: that is the
   * book an order placed since the last tick was placed against, and it is owed
   * its fill on the next tick for its token. Then the touch is forgotten. After
   * that the market has shown a book we cannot take from, and a standing touch
   * would go on filling orders at a price nobody is quoting.
   */
  feedTick(
    token: number,
    price: number,
    quote?: { readonly bid: number | null; readonly ask: number | null },
  ): void {
    this.#last.set(token, price)
    const fresh = touchOf(quote)
    const touch = fresh ?? this.#touch.get(token) ?? null
    if (fresh !== null) this.#touch.set(token, fresh)
    else this.#touch.delete(token)

    for (const r of [...this.#resting.values()]) {
      if (r.token !== token) continue
      const taken = this.#takes(r, touch)
      if (taken === null && !this.#crosses(r, price)) continue
      this.#resting.delete(r.brokerOrderId)
      const fill = this.#fillFor(r, taken ?? price)
      this.#applyFill(r.intent, fill.filledQty, fill.avgPrice as number)
      this.#emit(fill)
    }
  }

  // Judges a PRINT and nothing else: the whole rule for a stop, and the
  // fallback for a limit. A stop is armed by what traded, never by a quote. A
  // limit is no longer judged by this alone — a marketable limit takes the
  // touch first (`#takes`) — but a print through it still fills it when the
  // book offers nothing it can take, exactly as it always did.
  //
  // Deliberately strict inequality, not touch-or-cross: a tick exactly ON the
  // trigger does NOT fire. This delays a fill rather than making it optimistic
  // (never violates the "never fill on a price we didn't see trade through"
  // constraint), but it is a real deviation from typical broker semantics,
  // which usually treat touching the trigger as a fire. Recorded here rather
  // than fixed because the direction to fix it (touch-or-cross) is a broker
  // config detail, not something this simulator should guess at.
  #crosses(r: Resting, price: number): boolean {
    const t = r.intent.orderType
    const side = r.intent.side
    if (t === 'SL_MARKET' || t === 'SL_LIMIT') {
      // A stop triggers when price moves THROUGH it, in the losing direction.
      return side === 'SELL' ? price < r.trigger : price > r.trigger
    }
    // A limit the touch did not take still fills when the market trades
    // through it, in our favour.
    return side === 'SELL' ? price > r.trigger : price < r.trigger
  }

  /**
   * What a marketable LIMIT takes off the book, or null when there is nothing
   * it can take.
   *
   * WHY (2026-10-01, the stranded hedge). `#crosses` waits for a PRINT through
   * the limit, and a book that already crosses an order does not have to print:
   * the hedge's close sat under a standing bid while the put fell, no trade ever
   * came back above it, and it never filled. A real marketable limit does not
   * wait for a trade. It takes the touch, a buy at the ask and a sell at the
   * bid, and so pays the spread, which a fill at the print never did.
   *
   * Taken AT the touch, not at the limit: the order gets the improvement a real
   * one gets, and never a price worse than it asked for (an ask at or under a
   * buy limit, a bid at or over a sell limit). Touch-OR-cross, unlike `#crosses`:
   * a seller AT the buyer's price is a match, where a print exactly on a limit
   * says nothing about what was on offer.
   *
   * Limits only: a stop never reads the book.
   */
  #takes(r: Resting, touch: Touch | null): number | null {
    if (touch === null || r.intent.orderType !== 'LIMIT') return null
    if (r.intent.side === 'BUY') {
      return touch.ask !== null && touch.ask <= r.trigger ? touch.ask : null
    }
    return touch.bid !== null && touch.bid >= r.trigger ? touch.bid : null
  }

  #fillFor(r: Resting, price: number): PlacedOrder {
    const isStop = r.intent.orderType === 'SL_MARKET' || r.intent.orderType === 'SL_LIMIT'
    // Slippage always hurts: a SELL stop fills lower, a BUY stop fills higher.
    const slip = isStop ? (r.intent.side === 'SELL' ? -this.#slippage : this.#slippage) : 0
    return {
      brokerOrderId: r.brokerOrderId,
      clientOrderId: r.intent.clientOrderId,
      status: 'FILLED',
      filledQty: r.intent.quantity,
      avgPrice: Number((price + slip).toFixed(4)),
      ...exchangeTokenFor(r.intent),
    }
  }

  /**
   * Update the net position for `reconcile()` to read back via `positions()`.
   * Blends the average price while adding to a position in the same
   * direction; a reduction keeps the existing average; a flip through zero
   * starts a fresh average at the flipping fill's price.
   */
  #applyFill(intent: OrderIntent, qty: number, price: number): void {
    const symbol = intent.instrument.tradingsymbol
    const signedQty = intent.side === 'BUY' ? qty : -qty
    const prev = this.#positions.get(symbol)
    if (prev === undefined || prev.netQty === 0) {
      if (signedQty !== 0) this.#positions.set(symbol, { netQty: signedQty, avgPrice: price })
      return
    }
    const newQty = prev.netQty + signedQty
    const addingToPosition = Math.sign(prev.netQty) === Math.sign(signedQty)
    if (newQty === 0) {
      this.#positions.delete(symbol)
    } else if (addingToPosition) {
      const avgPrice =
        (prev.avgPrice * Math.abs(prev.netQty) + price * Math.abs(signedQty)) / Math.abs(newQty)
      this.#positions.set(symbol, { netQty: newQty, avgPrice })
    } else if (Math.sign(newQty) === Math.sign(prev.netQty)) {
      // Still reducing towards zero from the same side — average is unchanged.
      this.#positions.set(symbol, { netQty: newQty, avgPrice: prev.avgPrice })
    } else {
      // Flipped through zero — the remainder is a fresh position at this price.
      this.#positions.set(symbol, { netQty: newQty, avgPrice: price })
    }
  }

  #emit(o: PlacedOrder): void {
    for (const h of [...this.#handlers]) {
      try {
        h(o)
      } catch (err) {
        console.error('[simulator] fill handler threw:', err)
      }
    }
  }

  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    this.#seq++
    const brokerOrderId = `sim-${this.#runId}-${this.#seq}`
    const token = intent.instrument.instrumentToken ?? -1
    const last = this.#last.get(token)

    if (intent.orderType === 'MARKET') {
      if (last === undefined) {
        // No tick has been fed for this token yet. The resting path already
        // refuses to fabricate a fill without a real price (see the
        // `trigger === undefined` branch below) — MARKET must follow the same
        // discipline rather than reporting FILLED with avgPrice: null, which
        // violates this package's own invariant (types.ts: "Broker-reported
        // average fill. NEVER inferred locally — D3 depends on it").
        const o: PlacedOrder = {
          brokerOrderId, clientOrderId: intent.clientOrderId,
          status: 'REJECTED', filledQty: 0, avgPrice: null,
          rejectReason: `no tick received yet for token ${token}`,
        }
        this.#emit(o)
        return o
      }
      const o: PlacedOrder = {
        brokerOrderId,
        clientOrderId: intent.clientOrderId,
        status: 'FILLED',
        filledQty: intent.quantity,
        avgPrice: last,
        ...exchangeTokenFor(intent),
      }
      this.#applyFill(intent, o.filledQty, last)
      this.#emit(o)
      return o
    }

    const trigger = intent.orderType === 'LIMIT' ? intent.limitPrice : intent.triggerPrice
    if (trigger === undefined) {
      const o: PlacedOrder = {
        brokerOrderId, clientOrderId: intent.clientOrderId,
        status: 'REJECTED', filledQty: 0, avgPrice: null,
        rejectReason: `${intent.orderType} requires a limit/trigger price`,
      }
      this.#emit(o)
      return o
    }
    // A limit the known touch already crosses is still RESTED, not filled
    // here: the next tick for its token delivers the fill (`feedTick`), the way
    // a print through it always did. Placement answers WORKING for every
    // non-MARKET order, so nothing downstream has to learn otherwise.
    this.#resting.set(brokerOrderId, { brokerOrderId, intent, trigger, token })
    const o: PlacedOrder = {
      brokerOrderId, clientOrderId: intent.clientOrderId,
      status: 'WORKING', filledQty: 0, avgPrice: null,
      ...exchangeTokenFor(intent),
    }
    this.#emit(o)
    return o
  }

  async modifyOrder(brokerOrderId: string, price: number): Promise<boolean> {
    const r = this.#resting.get(brokerOrderId)
    if (r === undefined) return false
    this.#resting.set(brokerOrderId, { ...r, trigger: price })
    return true
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    const r = this.#resting.get(brokerOrderId)
    const cancelled = this.#resting.delete(brokerOrderId)
    if (cancelled && r !== undefined) {
      // OCO-pair cancellation and the WAL both depend on seeing this
      // transition, not just fills — see onOrderUpdate's contract below.
      this.#emit({
        brokerOrderId, clientOrderId: r.intent.clientOrderId,
        status: 'CANCELLED', filledQty: 0, avgPrice: null,
      })
    }
    return cancelled
  }

  /**
   * Every order-status transition — WORKING, CANCELLED, REJECTED, and
   * FILLED — not only fills. An implementer modelling the real XTS adapter on
   * this reference could otherwise reasonably forward only fills, silently
   * dropping broker rejections and cancels from the WAL and starving OCO-pair
   * cancellation of the other leg's status change.
   */
  onOrderUpdate(handler: (order: PlacedOrder) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const i = this.#handlers.indexOf(handler)
      if (i >= 0) this.#handlers.splice(i, 1)
    }
  }

  /** @deprecated Alias for {@link onOrderUpdate}, kept for existing callers that only want fills. */
  onFill(handler: (order: PlacedOrder) => void): () => void {
    return this.onOrderUpdate(handler)
  }

  async positions(): Promise<readonly BrokerPosition[]> {
    return [...this.#positions.entries()].map(([tradingsymbol, p]) => ({
      tradingsymbol,
      netQty: p.netQty,
      avgPrice: p.avgPrice,
    }))
  }

  async orderBook(): Promise<readonly BrokerOrder[]> {
    return [...this.#resting.values()].map((r) => ({
      brokerOrderId: r.brokerOrderId,
      clientOrderId: r.intent.clientOrderId,
      tradingsymbol: r.intent.instrument.tradingsymbol,
      status: 'WORKING',
      filledQty: 0,
      // Resting, so nothing has traded — see BrokerOrder.avgPrice on why this
      // is null rather than 0.
      avgPrice: null,
    }))
  }

  get restingCount(): number {
    return this.#resting.size
  }
}
