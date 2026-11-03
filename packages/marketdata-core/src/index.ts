/**
 * Market-data core: subscription registry, dedup, grouping, staleness watchdog.
 *
 * WHY: in the legacy system every strategy opened its OWN Kite websocket —
 * measured, 147 of 156 files construct a `KiteTicker`. With whole option chains
 * subscribed per process that is on the order of 50,000 token-subscriptions
 * across ~150 sockets, for 15-18 distinct trading ideas.
 *
 * Here a strategy DECLARES what it needs and never subscribes. The registry
 * unions all declarations, refcounts each token, and the service subscribes once
 * per token on ONE connection. Ten strategies on BANKNIFTY produce one
 * subscription.
 *
 * All logic in this module is pure and synchronous so it can be tested without a
 * broker; the Kite websocket is a thin adapter that drives it.
 */

export type TickMode = 'ltp' | 'quote' | 'full'

/** Richer modes cost more bandwidth, so a token gets max(mode) across requesters. */
const MODE_RANK: Record<TickMode, number> = { ltp: 0, quote: 1, full: 2 }

export function maxMode(a: TickMode, b: TickMode): TickMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b
}

/** One token a subscriber wants, with the mode it needs. */
export interface TokenNeed {
  readonly token: number
  readonly mode: TickMode
  /** Topic this token's ticks publish to, e.g. `md.index.NIFTY`. */
  readonly topic: string
}

export interface Tick {
  readonly token: number
  readonly lastPrice: number
  readonly ts: number
  readonly bid?: number
  readonly ask?: number
  readonly volume?: number
  readonly oi?: number
}

export interface RegistryOptions {
  /**
   * Per-connection subscription cap. Kite enforces a limit (~3000 tokens); the
   * registry refuses to exceed it rather than letting the broker silently
   * truncate, which would look like a dead feed for arbitrary instruments.
   */
  readonly maxTokensPerConnection?: number
}

export interface Subscription {
  readonly subscriberId: string
  readonly needs: readonly TokenNeed[]
}

export interface RegistryDiff {
  /** Tokens to subscribe on the wire (first requester). */
  readonly toSubscribe: readonly { token: number; mode: TickMode }[]
  /** Tokens to unsubscribe (refcount hit zero). */
  readonly toUnsubscribe: readonly number[]
  /** Tokens whose effective mode changed and must be re-issued. */
  readonly toChangeMode: readonly { token: number; mode: TickMode }[]
}

const emptyDiff: RegistryDiff = { toSubscribe: [], toUnsubscribe: [], toChangeMode: [] }

/**
 * Refcounted token registry.
 *
 * Returns a DIFF rather than performing I/O, so the caller decides how to apply
 * it and the whole thing stays testable.
 */
export class SubscriptionRegistry {
  /** token -> subscriberId -> mode */
  readonly #refs = new Map<number, Map<string, TickMode>>()
  /** token -> currently-subscribed effective mode */
  readonly #active = new Map<number, TickMode>()
  /** token -> set of topics to publish to */
  readonly #topics = new Map<number, Set<string>>()
  readonly #maxTokens: number

  constructor(opts: RegistryOptions = {}) {
    this.#maxTokens = opts.maxTokensPerConnection ?? 3000
  }

  get tokenCount(): number {
    return this.#refs.size
  }

  /** Remaining capacity before the per-connection cap. */
  get headroom(): number {
    return this.#maxTokens - this.#refs.size
  }

  /** Effective mode for a token, i.e. the max across all requesters. */
  effectiveMode(token: number): TickMode | undefined {
    const holders = this.#refs.get(token)
    if (holders === undefined || holders.size === 0) return undefined
    let m: TickMode = 'ltp'
    for (const v of holders.values()) m = maxMode(m, v)
    return m
  }

  topicsFor(token: number): readonly string[] {
    return [...(this.#topics.get(token) ?? [])]
  }

  /**
   * Declare (or re-declare) a subscriber's complete set of needs. Idempotent:
   * calling twice with the same needs produces an empty diff, which is what makes
   * it safe to call on every strategy restart.
   */
  declare(sub: Subscription): RegistryDiff {
    const prev = new Set<number>()
    for (const [token, holders] of this.#refs) if (holders.has(sub.subscriberId)) prev.add(token)

    const wanted = new Map<number, TokenNeed>()
    for (const n of sub.needs) {
      const existing = wanted.get(n.token)
      // A subscriber asking for the same token twice gets the richer mode.
      wanted.set(
        n.token,
        existing === undefined ? n : { ...n, mode: maxMode(existing.mode, n.mode) },
      )
    }

    // Capacity check BEFORE mutating: a partially-applied declaration would
    // leave the registry disagreeing with the wire.
    const newTokens = [...wanted.keys()].filter((t) => !this.#refs.has(t))
    if (this.#refs.size + newTokens.length > this.#maxTokens) {
      throw new Error(
        `subscription cap exceeded: ${this.#refs.size} active + ${newTokens.length} new > ` +
          `${this.#maxTokens}. Shard across another connection or narrow the strike window.`,
      )
    }

    const before = new Map<number, TickMode | undefined>()
    for (const t of new Set([...prev, ...wanted.keys()])) before.set(t, this.effectiveMode(t))

    // Apply: remove this subscriber from tokens it no longer wants...
    for (const token of prev) {
      if (!wanted.has(token)) this.#removeHolder(token, sub.subscriberId)
    }
    // ...and add/update the ones it does.
    for (const [token, need] of wanted) {
      let holders = this.#refs.get(token)
      if (holders === undefined) {
        holders = new Map()
        this.#refs.set(token, holders)
      }
      holders.set(sub.subscriberId, need.mode)
      let topics = this.#topics.get(token)
      if (topics === undefined) {
        topics = new Set()
        this.#topics.set(token, topics)
      }
      topics.add(need.topic)
    }

    return this.#diff(before)
  }

  /** Drop a subscriber entirely — used when a strategy is stopped or reset. */
  remove(subscriberId: string): RegistryDiff {
    const affected = new Map<number, TickMode | undefined>()
    for (const [token, holders] of this.#refs) {
      if (holders.has(subscriberId)) affected.set(token, this.effectiveMode(token))
    }
    for (const token of affected.keys()) this.#removeHolder(token, subscriberId)
    return this.#diff(affected)
  }

  #removeHolder(token: number, subscriberId: string): void {
    const holders = this.#refs.get(token)
    if (holders === undefined) return
    holders.delete(subscriberId)
    if (holders.size === 0) {
      this.#refs.delete(token)
      this.#topics.delete(token)
    }
  }

  #diff(before: Map<number, TickMode | undefined>): RegistryDiff {
    const toSubscribe: { token: number; mode: TickMode }[] = []
    const toUnsubscribe: number[] = []
    const toChangeMode: { token: number; mode: TickMode }[] = []

    for (const [token, prevMode] of before) {
      const nowMode = this.effectiveMode(token)
      if (prevMode === undefined && nowMode !== undefined) {
        toSubscribe.push({ token, mode: nowMode })
        this.#active.set(token, nowMode)
      } else if (prevMode !== undefined && nowMode === undefined) {
        toUnsubscribe.push(token)
        this.#active.delete(token)
      } else if (nowMode !== undefined && prevMode !== nowMode) {
        toChangeMode.push({ token, mode: nowMode })
        this.#active.set(token, nowMode)
      }
    }
    if (toSubscribe.length === 0 && toUnsubscribe.length === 0 && toChangeMode.length === 0) {
      return emptyDiff
    }
    return { toSubscribe, toUnsubscribe, toChangeMode }
  }

  /**
   * Full set for a reconnect. After a socket drop the wire state is gone, so
   * resubscription must come from the registry rather than from a replayed diff.
   */
  fullSubscriptionSet(): readonly { token: number; mode: TickMode }[] {
    const out: { token: number; mode: TickMode }[] = []
    for (const token of this.#refs.keys()) {
      const mode = this.effectiveMode(token)
      if (mode !== undefined) out.push({ token, mode })
    }
    return out
  }
}

// ---------------------------------------------------------------- watchdog

export type FeedHealth =
  | { readonly state: 'ok' }
  | { readonly state: 'stale'; readonly staleTokens: readonly number[]; readonly oldestAgeMs: number }
  | { readonly state: 'no-data' }

/**
 * Staleness watchdog.
 *
 * The dangerous failure is not a disconnect — that is loud. It is a socket that
 * stays open while ticks stop flowing, which looks perfectly healthy while every
 * strategy makes decisions on frozen prices. This detects that and is why new
 * entries get blocked while existing positions keep being managed.
 */
export class StalenessWatchdog {
  readonly #lastTickTs = new Map<number, number>()
  readonly #maxAgeMs: number

  constructor(maxAgeMs = 15_000) {
    this.#maxAgeMs = maxAgeMs
  }

  record(token: number, ts: number): void {
    const prev = this.#lastTickTs.get(token)
    // Never let an out-of-order tick make a token look staler than it is.
    if (prev === undefined || ts > prev) this.#lastTickTs.set(token, ts)
  }

  forget(token: number): void {
    this.#lastTickTs.delete(token)
  }

  /** Health across `tokens` at time `nowMs`. */
  check(tokens: readonly number[], nowMs: number): FeedHealth {
    if (tokens.length === 0) return { state: 'ok' }
    const stale: number[] = []
    let oldest = 0
    let anyData = false
    for (const t of tokens) {
      const last = this.#lastTickTs.get(t)
      if (last === undefined) {
        stale.push(t)
        continue
      }
      anyData = true
      const age = nowMs - last
      if (age > this.#maxAgeMs) {
        stale.push(t)
        if (age > oldest) oldest = age
      }
    }
    if (!anyData) return { state: 'no-data' }
    if (stale.length > 0) return { state: 'stale', staleTokens: stale, oldestAgeMs: oldest }
    return { state: 'ok' }
  }
}

// ---------------------------------------------------------------- tick sanity

/**
 * Reject implausible ticks at ingest.
 *
 * The legacy `0.05` fill artefact came from this class of problem: a missing or
 * absurd price propagating into orders. Filtering here keeps bad data out of
 * every downstream consumer at once.
 */
export function isPlausibleTick(t: Tick): boolean {
  if (!Number.isFinite(t.lastPrice) || t.lastPrice <= 0) return false
  if (!Number.isFinite(t.token) || t.token <= 0) return false
  if (!Number.isFinite(t.ts) || t.ts <= 0) return false
  if (t.bid !== undefined && (!Number.isFinite(t.bid) || t.bid < 0)) return false
  if (t.ask !== undefined && (!Number.isFinite(t.ask) || t.ask < 0)) return false
  // A crossed book (bid above ask) means a malformed packet, not an arbitrage.
  if (t.bid !== undefined && t.ask !== undefined && t.bid > 0 && t.ask > 0 && t.bid > t.ask) {
    return false
  }
  return true
}

// ---------------------------------------------------------------- topics

/** Canonical topic builders. Keeping them here stops topic strings drifting. */
export const topics = {
  index: (symbol: string) => `md.index.${symbol}`,
  stock: (symbol: string) => `md.stock.${symbol}`,
  option: (underlying: string, expiry: string) => `md.opt.${underlying}.${expiry}`,
  future: (underlying: string, expiry: string) => `md.fut.${underlying}.${expiry}`,
} as const

export * from './candles.ts'
export * from './selector.ts'
