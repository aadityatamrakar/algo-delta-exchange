/**
 * The Delta price feed: one public socket, every BTC option of every listed
 * expiry, published on the bus in the shape the Kite path publishes.
 *
 * WHAT IT PUBLISHES
 *   md.tick  {token, price, ts, oi?, bid?, ask?, depth?,     one per `ticker` frame,
 *            mark?, bidSize?, askSize?, iv?,                keyed by product id
 *            delta?, gamma?, theta?, vega?}
 *   md.spot  {underlying: 'BTC', price, ts}                 from `spot_price` .DEXBTUSD
 *
 * The first block is `tickPayload`'s shape in `main.ts` field for field, so
 * every consumer of the Kite feed (QuoteCache, the gateway's quote map, the
 * supervisor's chain view, the runner) reads a Delta tick without a change.
 * The option fields are optional and absent on NSE; each is OMITTED, never
 * `undefined` or 0, when the frame lacks it — a consumer spreading the object
 * must not manufacture a false zero.
 *
 * `price` IS THE MARK, not the last trade. A BTC option wing can go hours
 * without a print while its book and Delta's mark move every 5 s; the last
 * trade there is a memory, which is the TCS 2440PE failure the Kite path
 * already substitutes the mid for. The mark first, then the mid of a
 * two-sided book; a frame with neither publishes nothing.
 *
 * BID/ASK ARE BOTH OR NEITHER, positive and un-crossed — the rule
 * `bestBidAsk` applies on the Kite side and the gateway's quote map relies on.
 * A one-sided book publishes neither, so a missing ask reads as missing, never
 * as a price.
 *
 * UNITS. Prices are USD per BTC. `bidSize`/`askSize` are Delta contracts
 * (0.001 BTC each), as Delta shows them. `depth` quantities are BTC, the desk's
 * own quantity unit, as the Kite depth is in the desk's unit (shares).
 *
 * `ts` is receipt time, as on the Kite path: it is what the consumers' stale
 * tests measure against.
 */

import { DX_SPOT_SYMBOL, type DxFrame, type DxQuote } from '@algomaker/dx'
import { isConnectedState, type DxPublicSocketFactory, type DxPublicSocketPort } from './dx-ports.ts'

export { DX_SPOT_SYMBOL }
export const DX_UNDERLYING = 'BTC'
/** Symbols per subscribe message. Delta documents no cap; a chain is ~550 symbols, sent in a few frames. */
export const SUBSCRIBE_CHUNK = 200

const pos = (n: number | null): number | null => (n !== null && n > 0 ? n : null)

/**
 * A parsed `ticker` quote → the `md.tick` payload, or null when it carries no
 * usable price. Every field of the quote is already a number or null
 * (`quoteFromTickerFrame` in `@algomaker/dx`); null is OMITTED here.
 */
export function dxTickPayload(q: DxQuote, token: number, ts: number): Record<string, unknown> | null {
  const mark = pos(q.mark)
  const ask = pos(q.ask)
  const bid = pos(q.bid)
  const book = ask !== null && bid !== null && ask >= bid ? { bid, ask } : null
  const price = mark ?? (book !== null ? (book.bid + book.ask) / 2 : null)
  if (price === null) return null

  const opt = (k: string, v: number | null): Record<string, number> => (v === null ? {} : { [k]: v })
  const size = (n: number | null): number => (n !== null && n >= 0 ? n : 0)
  return {
    token,
    price,
    ts,
    ...opt('oi', q.oi),
    ...(book !== null
      ? {
          bid: book.bid,
          ask: book.ask,
          depth: {
            buy: [{ price: book.bid, qty: btcOf(size(q.bidSize)) }],
            sell: [{ price: book.ask, qty: btcOf(size(q.askSize)) }],
          },
          ...opt('bidSize', q.bidSize),
          ...opt('askSize', q.askSize),
        }
      : {}),
    ...opt('mark', mark),
    ...opt('iv', q.iv),
    ...opt('delta', q.delta),
    ...opt('gamma', q.gamma),
    ...opt('theta', q.theta),
    ...opt('vega', q.vega),
  }
}

/** Contracts → BTC on the 0.001 grid, float-clean (150 → 0.15, not 0.15000000000000002). */
function btcOf(contracts: number): number {
  return Math.round(contracts) / 1000
}

/** A spot frame → `md.spot`, or null when it is not `.DEXBTUSD` or has no positive price. */
export function dxSpotPayload(f: Extract<DxFrame, { kind: 'spot' }>, ts: number): Record<string, unknown> | null {
  if (f.symbol !== DX_SPOT_SYMBOL) return null
  const price = pos(f.price)
  return price === null ? null : { underlying: DX_UNDERLYING, price, ts }
}

export interface DxFeedHealth {
  readonly connected: boolean
  readonly downForMs: number | null
  /** Option symbols subscribed (the spot is not counted). */
  readonly tokens: number
  /** Subscribed tokens silent for longer than `staleAfterMs`, or never ticked. */
  readonly staleTokens: number
  /** Age of the oldest stale token that HAS ticked; 0 when none. */
  readonly oldestAgeMs: number
}

export interface DxFeedDeps {
  readonly url: string
  readonly socket: DxPublicSocketFactory
  readonly publish: (topic: string, payload: Record<string, unknown>, ts: number) => void
  readonly staleAfterMs: number
  readonly now?: () => number
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
  /**
   * The topic ticks go out on. `md.tick` (the default) for the production
   * feed; `md.tick.demo` for the testnet feed, whose prices must never reach
   * an `md.tick` consumer.
   */
  readonly tickTopic?: string
  /** Subscribe and publish `.DEXBTUSD` (default true). The testnet feed does not: the index stays production's. */
  readonly spot?: boolean
}

export interface DxInstrument {
  readonly token: number
  readonly symbol: string
}

export class DxFeed {
  readonly #d: DxFeedDeps
  readonly #now: () => number
  #socket: DxPublicSocketPort | null = null
  #connected = false
  #downSince: number
  /** Option symbol → product id. */
  readonly #tokenOf = new Map<string, number>()
  /** Symbols already sent to the CURRENT connection. Cleared on every disconnect. */
  readonly #sent = new Set<string>()
  #spotToken: number | null = null
  readonly #lastSeen = new Map<number, number>()
  /** Last price per token and the last two-sided book, for the display snapshot. */
  readonly lastPrice = new Map<number, { price: number; ts: number; book: { bid: number; ask: number; ts: number } | null }>()

  constructor(d: DxFeedDeps) {
    this.#d = d
    this.#now = d.now ?? Date.now
    this.#downSince = this.#now()
  }

  /**
   * The options to carry and the spot row's token. Called after every
   * products sync: new symbols are subscribed on the live connection at once,
   * and the whole set is what a reconnect replays. A symbol that left the
   * listing is not unsubscribed — an expired product simply stops ticking —
   * but it is no longer replayed or counted.
   */
  setInstruments(options: readonly DxInstrument[], spotToken: number | null): void {
    this.#tokenOf.clear()
    for (const o of options) this.#tokenOf.set(o.symbol, o.token)
    this.#spotToken = spotToken
    const kept = new Set(this.#tokenOf.values())
    for (const t of [...this.#lastSeen.keys()]) {
      if (t !== spotToken && !kept.has(t)) this.#lastSeen.delete(t)
    }
    if (this.#connected) this.#subscribePending()
  }

  get tokenCount(): number {
    return this.#tokenOf.size
  }

  start(): void {
    if (this.#socket !== null) return
    this.#socket = this.#d.socket(this.#d.url, {
      onFrame: (f) => this.onFrame(f),
      onState: (s) => this.#onState(s),
    })
  }

  close(): void {
    this.#socket?.close()
    this.#socket = null
    this.#connected = false
  }

  #onState(s: string): void {
    const up = isConnectedState(s)
    if (up && !this.#connected) {
      this.#connected = true
      // A fresh connection holds no subscription of ours: replay everything.
      this.#sent.clear()
      if (this.#d.spot !== false) this.#socket?.subscribe('spot_price', [DX_SPOT_SYMBOL])
      this.#subscribePending()
      this.#d.log?.('dx feed connected', { symbols: this.#sent.size })
    } else if (!up && this.#connected) {
      this.#connected = false
      this.#downSince = this.#now()
      this.#sent.clear()
      this.#d.log?.('dx feed disconnected', { state: s })
    }
  }

  #subscribePending(): void {
    const socket = this.#socket
    if (socket === null) return
    const pending = [...this.#tokenOf.keys()].filter((s) => !this.#sent.has(s))
    for (let i = 0; i < pending.length; i += SUBSCRIBE_CHUNK) {
      const chunk = pending.slice(i, i + SUBSCRIBE_CHUNK)
      socket.subscribe('ticker', chunk)
      for (const s of chunk) this.#sent.add(s)
    }
  }

  /** One frame off the socket. Never throws: a malformed frame is dropped. */
  onFrame(f: DxFrame): void {
    try {
      const ts = this.#now()
      if (f.kind === 'ticker') {
        const token = this.#tokenOf.get(f.quote.symbol)
        if (token === undefined) return
        const p = dxTickPayload(f.quote, token, ts)
        if (p === null) return
        this.#seen(token, p, ts)
        this.#d.publish(this.#d.tickTopic ?? 'md.tick', p, ts)
      } else if (f.kind === 'spot' && this.#d.spot !== false) {
        const p = dxSpotPayload(f, ts)
        if (p === null) return
        this.#d.publish('md.spot', p, ts)
        if (this.#spotToken !== null) {
          const tick = { token: this.#spotToken, price: p['price'], ts }
          this.#seen(this.#spotToken, tick, ts)
          this.#d.publish('md.tick', tick, ts)
        }
      }
    } catch (err) {
      this.#d.log?.('dx frame dropped', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  #seen(token: number, p: Record<string, unknown>, ts: number): void {
    this.#lastSeen.set(token, ts)
    const bid = p['bid']
    const ask = p['ask']
    const prev = this.lastPrice.get(token)
    this.lastPrice.set(token, {
      price: p['price'] as number,
      ts,
      book: typeof bid === 'number' && typeof ask === 'number' ? { bid, ask, ts } : (prev?.book ?? null),
    })
  }

  health(): DxFeedHealth {
    const now = this.#now()
    let stale = 0
    let oldest = 0
    for (const token of this.#tokenOf.values()) {
      const seen = this.#lastSeen.get(token)
      if (seen === undefined) {
        stale++
        continue
      }
      const age = now - seen
      if (age > this.#d.staleAfterMs) {
        stale++
        if (age > oldest) oldest = age
      }
    }
    return {
      connected: this.#connected,
      downForMs: this.#connected ? null : now - this.#downSince,
      tokens: this.#tokenOf.size,
      staleTokens: stale,
      oldestAgeMs: oldest,
    }
  }
}
