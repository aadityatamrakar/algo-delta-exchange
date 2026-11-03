/**
 * The single Kite websocket.
 *
 * The legacy system opened one per strategy — measured, 147 of 156 files
 * construct their own `KiteTicker`, which is on the order of 50,000 token
 * subscriptions across ~150 sockets for 15-18 distinct ideas. Here there is one
 * socket, and `SubscriptionRegistry` refcounts what is on it, so ten consumers
 * wanting BHEL produce one subscription.
 *
 * Wraps `server/lib/KiteTicker.js` rather than reimplementing it: that file is
 * self-contained (its only dependency is `ws`) and contains the binary tick
 * parser, which is the part that would be expensive and risky to rewrite.
 *
 * RESUBSCRIPTION AFTER A RECONNECT COMES FROM THE REGISTRY, never from a replay
 * of past diffs. After a socket drops, the wire state is gone; replaying the
 * diffs that built it would reproduce any drift they contained.
 */

import { createRequire } from 'node:module'
import { inspect } from 'node:util'
import { SubscriptionRegistry, StalenessWatchdog, isPlausibleTick, type TickMode } from '@algomaker/marketdata-core'

const require = createRequire(import.meta.url)

/** One tick as KiteTicker delivers it (full mode). */
export interface KiteTick {
  readonly instrument_token: number
  readonly last_price: number
  readonly timestamp?: Date | number
  readonly ohlc?: { open: number; high: number; low: number; close: number }
  readonly oi?: number
  /** Cumulative traded volume for the day. Present in quote and full mode. */
  readonly volume?: number
  readonly depth?: {
    buy?: { price: number; quantity?: number }[]
    sell?: { price: number; quantity?: number }[]
  }
}

export interface RawTicker {
  connect(): void
  disconnect(): void
  /** Toggle the vendored retry loop. Retiring a ticker MUST turn this off. */
  autoReconnect(enable: boolean, maxRetry?: number, maxDelay?: number): void
  on(event: string, handler: (...args: unknown[]) => void): void
  subscribe(tokens: number[]): void
  unsubscribe(tokens: number[]): void
  setMode(mode: string, tokens: number[]): void
  modeLTP: string
  modeQuote: string
  modeFull: string
}

export interface KiteFeedOptions {
  readonly accessToken: string
  readonly apiKey?: string
  readonly onTick: (tick: KiteTick) => void
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
  readonly staleAfterMs?: number
  /**
   * The ticker exhausted its retries — this feed stays dead until someone
   * rebuilds it with `reconnect()`. The host uses this to re-login: after the
   * 2026-08-04 incident, a mid-session enctoken invalidation meant every retry
   * re-dialled with a token Zerodha had already rejected, so only a FRESH login
   * could ever bring the feed back.
   */
  readonly onDown?: () => void
  /** Injected for tests, so the feed can be exercised without a network. */
  readonly createTicker?: (params: { api_key: string; access_token: string }) => RawTicker
}

export function describeFeedError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  if (typeof err === 'object' && err !== null) {
    return inspect(normalizeFeedError(err), { depth: 6, breakLength: Infinity })
  }
  return String(err)
}

function normalizeFeedError(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (Array.isArray(value)) return value.map((entry) => normalizeFeedError(entry))
  if (typeof value !== 'object' || value === null) return value
  const normalized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) normalized[key] = normalizeFeedError(entry)
  return normalized
}

export class KiteFeed {
  readonly #registry = new SubscriptionRegistry()
  readonly #watchdog: StalenessWatchdog
  readonly #opts: KiteFeedOptions
  readonly #log: (msg: string, ctx?: Record<string, unknown>) => void
  #ticker: RawTicker | null = null
  /** The live ticker's OWN params object — see `connect` and `noteAccessToken`. */
  #tickerParams: { api_key: string; access_token: string } | null = null
  #connected = false
  #accessToken: string
  /** When the CURRENT outage began; null while connected. */
  #downSinceMs: number | null = null

  constructor(opts: KiteFeedOptions) {
    this.#opts = opts
    this.#log = opts.log ?? ((): void => {})
    this.#watchdog = new StalenessWatchdog(opts.staleAfterMs ?? 15_000)
    this.#accessToken = opts.accessToken
  }

  get connected(): boolean {
    return this.#connected
  }

  get tokenCount(): number {
    return this.#registry.tokenCount
  }

  /**
   * How long this feed has been without a live socket, or null if connected.
   *
   * The clock starts at the FIRST disconnect (or a connect attempt that has not
   * succeeded yet) and survives the vendored retry cycle — each failed retry
   * emits its own 'disconnect', and resetting on every one would make a feed
   * that has been dead for ten minutes look thirty seconds old forever.
   */
  downForMs(nowMs: number = Date.now()): number | null {
    return this.#downSinceMs === null ? null : Math.max(0, nowMs - this.#downSinceMs)
  }

  connect(): void {
    const create =
      this.#opts.createTicker ??
      ((p: { api_key: string; access_token: string }): RawTicker => {
        const KiteTicker = require('../../../packages/marketdata-core/vendor/KiteTicker.js') as new (params: {
          api_key: string
          access_token: string
        }) => RawTicker
        return new KiteTicker(p)
      })

    /**
     * HELD, NOT DISCARDED. The vendored ticker keeps this exact object and
     * reads `params.access_token` afresh on every `connect()` — including the
     * ones its own auto-reconnect makes. Keeping the reference is therefore
     * the whole mechanism behind `noteAccessToken`.
     */
    const params = {
      // 'kitefront' is the web client's key, which is what pairs with an
      // enctoken from the web login flow. A real API key would need a real
      // KiteConnect subscription and a different token entirely.
      api_key: this.#opts.apiKey ?? 'kitefront',
      access_token: this.#accessToken,
    }
    const ticker = create(params)
    this.#tickerParams = params
    this.#ticker = ticker
    // Attempting, not connected: if this ticker never comes up, the outage
    // clock must already be running so the host's dead-feed sweep can see it.
    this.#downSinceMs ??= Date.now()

    // EVERY handler checks it still belongs to the live ticker. A retired
    // ticker keeps its listeners (the vendored emitter has no `off`) and may
    // fire one last in-flight attempt after `reconnect()` replaced it; without
    // the guard that ghost flips #connected under the replacement.
    ticker.on('connect', () => {
      if (this.#ticker !== ticker) return
      this.#connected = true
      this.#downSinceMs = null
      this.#log('feed connected')
      // Resubscribe the FULL set from the registry — see the file header.
      const full = this.#registry.fullSubscriptionSet()
      if (full.length > 0) this.#applySubscriptions(full)
      this.#log('resubscribed after connect', { tokens: full.length })
    })

    ticker.on('ticks', (...args: unknown[]) => {
      if (this.#ticker !== ticker) return
      const ticks = args[0] as KiteTick[]
      for (const t of ticks ?? []) {
        if (!acceptTick(t, tickTimeMs(t))) continue
        this.#watchdog.record(t.instrument_token, Date.now())
        this.#opts.onTick(t)
      }
    })

    ticker.on('disconnect', (...args: unknown[]) => {
      if (this.#ticker !== ticker) return
      this.#connected = false
      this.#downSinceMs ??= Date.now()
      const detail = args[0]
      this.#log('feed disconnected', detail === undefined ? undefined : { error: describeFeedError(detail) })
    })
    ticker.on('error', (...args: unknown[]) => {
      if (this.#ticker !== ticker) return
      this.#log('feed error', { error: describeFeedError(args[0]) })
    })
    ticker.on('noreconnect', () => {
      if (this.#ticker !== ticker) return
      this.#log('feed gave up reconnecting — market data is DOWN')
      this.#opts.onDown?.()
    })

    ticker.connect()
  }

  /**
   * Take a fresh enctoken WITHOUT disturbing a live socket.
   *
   * For the connected case, where `reconnect` would be wrong: an established
   * websocket outlives its token, so tearing it down to rotate a credential it
   * is not currently using would drop live ticks for nothing. But the old
   * token IS dead — a new login invalidates the previous one — so a socket
   * left holding it survives only until its next blip, after which the
   * vendored auto-reconnect re-dials with a token Zerodha rejects every time
   * and the instruments sharded here go quiet until the dead-feed sweep spends
   * another login.
   *
   * The vendored ticker reads `access_token` off its params object at each
   * connect, so updating that object in place is enough: the retry loop that
   * is already armed picks the new token up by itself.
   */
  noteAccessToken(accessToken: string): void {
    if (this.#accessToken === accessToken) return
    this.#accessToken = accessToken
    if (this.#tickerParams !== null) this.#tickerParams.access_token = accessToken
    this.#log('enctoken rotated under a live socket — its next re-dial uses the fresh one')
  }

  /**
   * Tear the dead ticker down and rebuild with a fresh token.
   *
   * The registry is the durable state, so resubscription costs nothing extra:
   * the new ticker's 'connect' handler replays the full set exactly as a boot
   * does. The old ticker is retired, not merely dropped — its retry loop MUST
   * be switched off first, or it keeps re-dialling with the dead token in the
   * background and eventually fires its own 'noreconnect'.
   */
  reconnect(accessToken: string): void {
    const old = this.#ticker
    if (old !== null) {
      old.autoReconnect(false)
      try {
        old.disconnect()
      } catch {
        // A half-closed socket may throw on close; the ticker is being
        // abandoned either way.
      }
    }
    this.#accessToken = accessToken
    this.#connected = false
    // Fresh attempt, fresh clock: the host's dead-feed sweep should give this
    // rebuild a full grace period before concluding it too has failed.
    this.#downSinceMs = Date.now()
    this.#ticker = null
    this.#tickerParams = null
    this.connect()
  }

  /**
   * Declare a subscriber's complete token set. Idempotent: re-declaring the
   * same set produces an empty diff and touches the socket not at all, which is
   * what makes it safe for a Python client to call on every tick.
   */
  declare(subscriberId: string, tokens: readonly number[], mode: TickMode = 'full'): void {
    const diff = this.#registry.declare({
      subscriberId,
      needs: tokens.map((token) => ({ token, mode, topic: `md.${token}` })),
    })
    if (diff.toSubscribe.length > 0) this.#applySubscriptions(diff.toSubscribe)
    if (diff.toUnsubscribe.length > 0) {
      this.#ticker?.unsubscribe([...diff.toUnsubscribe])
      for (const t of diff.toUnsubscribe) this.#watchdog.forget(t)
      this.#log('unsubscribed', { tokens: diff.toUnsubscribe.length })
    }
    if (diff.toChangeMode.length > 0) this.#applySubscriptions(diff.toChangeMode)
  }

  /** Drop a subscriber entirely; its tokens go when the last holder does. */
  remove(subscriberId: string): void {
    const diff = this.#registry.remove(subscriberId)
    if (diff.toUnsubscribe.length > 0) {
      this.#ticker?.unsubscribe([...diff.toUnsubscribe])
      for (const t of diff.toUnsubscribe) this.#watchdog.forget(t)
    }
  }

  /** Feed health across the currently subscribed set. */
  health(): ReturnType<StalenessWatchdog['check']> {
    const tokens = this.#registry.fullSubscriptionSet().map((s) => s.token)
    return this.#watchdog.check(tokens, Date.now())
  }

  #applySubscriptions(entries: readonly { token: number; mode: TickMode }[]): void {
    const ticker = this.#ticker
    if (ticker === null || !this.#connected) return
    const byMode = new Map<TickMode, number[]>()
    for (const e of entries) {
      const list = byMode.get(e.mode)
      if (list === undefined) byMode.set(e.mode, [e.token])
      else list.push(e.token)
    }
    for (const [mode, tokens] of byMode) {
      ticker.subscribe(tokens)
      ticker.setMode(
        mode === 'ltp' ? ticker.modeLTP : mode === 'quote' ? ticker.modeQuote : ticker.modeFull,
        tokens,
      )
    }
  }

  disconnect(): void {
    // Deliberate shutdown: without this the vendored retry loop treats the
    // close as an outage and starts re-dialling while the process exits.
    this.#ticker?.autoReconnect(false)
    this.#ticker?.disconnect()
    this.#connected = false
  }
}

/**
 * Best bid/ask off a full-mode packet — both-or-neither. A one-sided book
 * prices nothing, an empty slot parses as price 0 (absence, not a price),
 * and a crossed pair is handled by `acceptTick`, not here.
 */
export function bestBidAsk(t: KiteTick): { bid: number; ask: number } | null {
  const bid = t.depth?.buy?.[0]?.price
  const ask = t.depth?.sell?.[0]?.price
  const ok =
    typeof bid === 'number' && Number.isFinite(bid) && bid > 0 &&
    typeof ask === 'number' && Number.isFinite(ask) && ask > 0 && ask >= bid
  return ok ? { bid, ask } : null
}

/**
 * Admission at ingest: reject implausible ticks before any consumer sees
 * them — a zero or absurd price is the shape the legacy 0.05-fill artefact
 * took. But "implausible" is judged on the best price the packet CARRIES,
 * not on the LTP alone: a strike that has never traded arrives as
 * `last_price: 0` beside a perfectly live book (the subscribe-time snapshot
 * does exactly this), and dropping it left such strikes "no mark" until
 * their first ever print — a BHEL wing sat stuck that way on 2026-08-17.
 * With the mid as the desk mark, a two-sided book IS a price. A crossed
 * book still rejects the whole packet as malformed, ltp or no ltp.
 */
export function acceptTick(t: KiteTick, ts: number): boolean {
  const bid = t.depth?.buy?.[0]?.price
  const ask = t.depth?.sell?.[0]?.price
  const hasBid = typeof bid === 'number' && Number.isFinite(bid) && bid > 0
  const hasAsk = typeof ask === 'number' && Number.isFinite(ask) && ask > 0
  if (hasBid && hasAsk && (bid as number) > (ask as number)) return false
  const book = bestBidAsk(t)
  const lastPrice =
    t.last_price > 0 ? t.last_price : book !== null ? (book.bid + book.ask) / 2 : t.last_price
  return isPlausibleTick({ token: t.instrument_token, lastPrice, ts })
}

function tickTimeMs(t: KiteTick): number {
  const ts = t.timestamp
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'number') return ts > 1e12 ? ts : ts * 1000
  return Date.now()
}
