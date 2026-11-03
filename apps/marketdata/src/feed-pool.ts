/**
 * A pool of Kite websockets, sized to demand.
 *
 * Kite caps one connection at ~900 tokens. A desk running 10+ stock chains plus
 * index chains exceeds that, so the pool opens sockets as needed and shards
 * tokens across them via `TokenSharder` — which guarantees a token never moves
 * between sockets while it is still wanted (see shard.ts).
 *
 * This is still the ONE-SOCKET-PER-NEED discipline, not a regression to the
 * legacy per-strategy socket. The count is driven by the token total, not by how
 * many consumers there are: ten consumers wanting BHEL still produce one
 * subscription on one socket.
 *
 * Every socket shares one login. Kite issues a single enctoken per session and
 * all connections authenticate with it.
 */

import type { FeedHealth } from '@algomaker/marketdata-core'
import { KiteFeed, type KiteTick } from './kite-feed.ts'
import { TokenSharder, DEFAULT_MAX_TOKENS_PER_SOCKET } from './shard.ts'

export interface FeedPoolOptions {
  readonly accessToken: string
  readonly onTick: (tick: KiteTick) => void
  readonly maxTokensPerSocket?: number
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
  /**
   * The window every socket's `StalenessWatchdog` measures against — the FREEZE
   * window, not a tradability one.
   *
   * `KiteFeed` defaults to 15s, which is right for "is this quote fresh enough
   * to act on" and wrong for the only question this pool's `health()` is asked:
   * has the socket STOPPED. A stock chain's wings genuinely print once every
   * 30-60s, so on the 15s window a majority of a quiet chain's tokens are
   * "stale" in perfectly normal conditions — the F-14 alarm then fires all
   * session on a healthy wire. The host passes `DESK_FREEZE_STALE_MS` (3
   * minutes) here; see `frozenSockets` in main.ts.
   *
   * Nothing else consumes `KiteFeed.health()` — `KiteFeedPool.health()` is its
   * only caller — so widening it at construction costs no other consumer a
   * tighter window.
   */
  readonly staleAfterMs?: number
  /**
   * A socket exhausted its retries and is dead until rebuilt. The host reacts
   * by re-logging-in and calling `reconnect()` — see feed-recovery.ts.
   */
  readonly onDown?: (socket: number) => void
  /**
   * Injected for tests, so the pool can be exercised without a network. It is
   * handed the same feed options the real `KiteFeed` would get, so a fake that
   * wraps a real feed sees the staleness window the pool threads down.
   */
  readonly createFeed?: (index: number, options: FeedWindowOptions) => FeedLike
}

/** The per-feed options the pool decides, shared with an injected `createFeed`. */
export interface FeedWindowOptions {
  readonly staleAfterMs?: number
}

/** The slice of KiteFeed the pool depends on. */
export interface FeedLike {
  connect(): void
  disconnect(): void
  reconnect(accessToken: string): void
  /** Take a fresh token without touching a live socket — see `KiteFeed`. */
  noteAccessToken(accessToken: string): void
  declare(subscriberId: string, tokens: readonly number[]): void
  readonly connected: boolean
  downForMs(nowMs?: number): number | null
  /**
   * The socket's staleness verdict. OPTIONAL so an implementer that predates
   * the watchdog wiring (and every fake written before it) still satisfies this
   * port — a feed that cannot answer reports `ok` rather than failing a sweep
   * whose whole purpose is to notice trouble.
   */
  health?(): FeedHealth
}

/** One socket's contribution to `KiteFeedPool.health()`. */
export interface SocketHealth {
  readonly socket: number
  readonly connected: boolean
  /** Tokens sharded onto this socket. */
  readonly tokens: number
  /** How many of them have not ticked inside the watchdog's window. */
  readonly staleTokens: number
  /** Age of the oldest stale token, 0 when none is stale or none has data. */
  readonly oldestAgeMs: number
  readonly state: FeedHealth['state']
}

export interface PoolHealth {
  readonly staleTokens: number
  readonly oldestAgeMs: number
  readonly perSocket: readonly SocketHealth[]
}

export class KiteFeedPool {
  readonly #opts: FeedPoolOptions
  readonly #sharder: TokenSharder
  readonly #feeds: FeedLike[] = []
  readonly #log: (msg: string, ctx?: Record<string, unknown>) => void
  /** subscriberId -> the tokens it last declared. */
  readonly #declared = new Map<string, Set<number>>()
  /** The CURRENT enctoken: rotated by `reconnect()`, used by every new socket. */
  #accessToken: string

  constructor(opts: FeedPoolOptions) {
    this.#opts = opts
    this.#log = opts.log ?? ((): void => {})
    this.#sharder = new TokenSharder(opts.maxTokensPerSocket ?? DEFAULT_MAX_TOKENS_PER_SOCKET)
    this.#accessToken = opts.accessToken
  }

  /**
   * The CURRENT enctoken, for a caller that needs to make a Kite REST call.
   *
   * READ IT PER CALL, never cache it: `reconnect()` rotates this, and a holder
   * that captured the old value would authenticate with a dead token from then
   * on. The pool stays the single owner of the session — this exposes the token
   * so nobody is tempted to log in a second time, which is what killed the feed
   * on 2026-08-04.
   */
  get accessToken(): string {
    return this.#accessToken
  }

  get socketCount(): number {
    return this.#feeds.length
  }

  get tokenCount(): number {
    return this.#sharder.size
  }

  /**
   * Declare a subscriber's complete token set.
   *
   * Idempotent end to end: an unchanged declaration produces an empty shard plan
   * and touches no socket. Safe to call on every Python tick.
   */
  declare(subscriberId: string, tokens: readonly number[]): void {
    this.#declared.set(subscriberId, new Set(tokens))
    this.#apply()
  }

  remove(subscriberId: string): void {
    this.#declared.delete(subscriberId)
    this.#apply()
  }

  #apply(): void {
    // Union across every subscriber — this is where dedup happens, and why ten
    // consumers on the same chain cost one subscription.
    const union = new Set<number>()
    for (const set of this.#declared.values()) for (const t of set) union.add(t)

    const before = this.#sharder.socketCount
    const plan = this.#sharder.reconcile(union)
    if (plan.added.size === 0 && plan.removed.size === 0) return

    while (this.#feeds.length < plan.socketCount) this.#openSocket()

    // Re-declare each affected socket with its full token set. The per-socket
    // KiteFeed registry then computes its own subscribe/unsubscribe diff, so a
    // token that did not move is not re-sent to the wire.
    const touched = new Set<number>()
    for (const socket of plan.added.values()) touched.add(socket)
    for (const socket of plan.removed.values()) touched.add(socket)
    for (const socket of touched) {
      const feed = this.#feeds[socket]
      if (feed === undefined) continue
      feed.declare('pool', this.#sharder.tokensOn(socket))
    }

    if (plan.socketCount !== before) {
      this.#log('socket count changed', {
        sockets: plan.socketCount,
        tokens: this.#sharder.size,
        loads: plan.loads,
      })
    }
  }

  #openSocket(): void {
    const index = this.#feeds.length
    // The freeze window, threaded into the watchdog at construction — see
    // `staleAfterMs` above for why the 15s KiteFeed default is the wrong
    // number for a socket-has-stopped verdict.
    const window: FeedWindowOptions =
      this.#opts.staleAfterMs === undefined ? {} : { staleAfterMs: this.#opts.staleAfterMs }
    const feed =
      this.#opts.createFeed?.(index, window) ??
      new KiteFeed({
        accessToken: this.#accessToken,
        onTick: this.#opts.onTick,
        log: (m, c) => this.#log(`[socket ${index}] ${m}`, c),
        onDown: () => this.#opts.onDown?.(index),
        ...window,
      })
    this.#feeds.push(feed)
    feed.connect()
    this.#log('opened socket', { index })
  }

  connect(): void {
    for (const f of this.#feeds) f.connect()
  }

  /**
   * Rotate the enctoken and rebuild every DEAD socket with it.
   *
   * Connected sockets are not TORN DOWN: an established websocket survives its
   * enctoken being invalidated, and dropping a healthy socket would lose live
   * ticks for nothing. They are still HANDED the fresh token, because the
   * previous one is dead the instant a new login mints its replacement — a
   * connected socket that keeps the old token survives only until its next
   * blip, and then its own retry loop re-dials with a token Zerodha rejects
   * every time. That is the 2026-08-04 failure in miniature, and it became the
   * routine outcome once a REST rejection could trigger a login while every
   * socket was fine. Future sockets get the fresh token for the same reason.
   */
  reconnect(accessToken: string): void {
    this.#accessToken = accessToken
    for (const [index, feed] of this.#feeds.entries()) {
      if (feed.connected) {
        feed.noteAccessToken(accessToken)
        continue
      }
      this.#log('rebuilding dead socket with the fresh login', { socket: index })
      feed.reconnect(accessToken)
    }
  }

  disconnect(): void {
    for (const f of this.#feeds) f.disconnect()
  }

  /**
   * TICK health across every socket (audit F-14).
   *
   * The complement of `status()`, which answers "is the socket up". This one
   * answers the question a connected socket cannot: are ticks still FLOWING?
   * `StalenessWatchdog` has always computed it per feed and nothing has ever
   * called `KiteFeed.health()`, so a socket that stayed open while its ticks
   * stopped — a partially-failed resubscribe replay leaves tokens in the
   * registry and on no wire — looked identical to a healthy one from every
   * angle this process published.
   *
   * A `'no-data'` socket counts ALL its tokens as stale: nothing on it has ever
   * ticked, which is the resubscribe failure in its purest form. `oldestAgeMs`
   * stays 0 there because there is no timestamp to measure from — the
   * `staleTokens` count is what carries that case.
   *
   * "Stale" here means the FREEZE window (`staleAfterMs`, 3 minutes from the
   * host), not a tradability one: these numbers are published on `md.health`
   * and shown on the Status card, and on a 15s window a quiet stock chain would
   * put a large stale count in front of the operator every normal session.
   */
  health(): PoolHealth {
    const perSocket: SocketHealth[] = this.#feeds.map((feed, socket) => {
      const tokens = this.#sharder.tokensOn(socket).length
      const h = feed.health?.() ?? { state: 'ok' as const }
      const staleTokens =
        h.state === 'stale' ? h.staleTokens.length : h.state === 'no-data' ? tokens : 0
      return {
        socket,
        connected: feed.connected,
        tokens,
        staleTokens,
        oldestAgeMs: h.state === 'stale' ? h.oldestAgeMs : 0,
        state: h.state,
      }
    })
    let stale = 0
    let oldest = 0
    for (const s of perSocket) {
      stale += s.staleTokens
      if (s.oldestAgeMs > oldest) oldest = s.oldestAgeMs
    }
    return { staleTokens: stale, oldestAgeMs: oldest, perSocket }
  }

  /**
   * Rebuild ONE socket, keeping the current enctoken.
   *
   * The repair for a socket that is connected and frozen: `reconnect()` above
   * would leave it alone precisely because it is connected, and the registry
   * replays the full subscription set on the new socket's 'connect', which is
   * the only thing that can fix a subscription the exchange never took.
   *
   * Deliberately NOT called by the health sweep unless `DESK_STALE_RECONNECT=1`
   * — see `frozenSockets` in main.ts for why a wrong auto-repair mid-session is
   * worse than a loud log. The caller RESETS that socket's streak afterwards
   * (`sweepFrozenSockets`): a rebuilt socket needs a full re-observation before
   * it can be judged again, or the next sweep repairs it once more, forever.
   */
  repairSocket(socket: number): void {
    const feed = this.#feeds[socket]
    if (feed === undefined) return
    this.#log('rebuilding a socket whose ticks froze', { socket })
    feed.reconnect(this.#accessToken)
  }

  /** Per-socket connection state, for the health endpoint and dashboard. */
  status(): readonly { socket: number; connected: boolean; tokens: number; downForMs: number | null }[] {
    return this.#feeds.map((f, i) => ({
      socket: i,
      connected: f.connected,
      tokens: this.#sharder.tokensOn(i).length,
      downForMs: f.downForMs(),
    }))
  }
}
