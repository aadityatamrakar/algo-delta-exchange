/**
 * The `md` port, composed from the shared pieces — it reimplements none of them.
 *
 *   - `CandleStore` (marketdata-core) owns bar aggregation: one shared,
 *     refcounted series per (token, interval), advanced ONCE per tick rather
 *     than once per reader, handing out frozen slices of COMPLETED bars only.
 *   - `OptionMaster` (instruments) owns contract resolution on the LISTED grid.
 *   - `selectOption` (marketdata-core) owns delta/premium/offset selection, and
 *     returns null rather than an ATM fallback.
 *   - `StalenessWatchdog` (marketdata-core) owns feed health.
 *
 * This file is the wiring: it turns each strategy's `dataNeeds()` into tokens
 * and series, keeps a token -> tags routing table so a BANKNIFTY strategy is
 * never handed a BHEL tick, and answers the four `MarketData` methods.
 *
 * WHY A ROUTING TABLE RATHER THAN FANNING EVERY TICK TO EVERY STRATEGY: a
 * strategy's `onTick` is its exit check AND its entry check. Handing it a tick
 * for an instrument it never asked about means its entry evaluation runs on an
 * unrelated instrument's clock — which is not a performance problem, it is a
 * correctness one.
 *
 * SEEDING IS NOT OPTIONAL IN PRODUCTION. Series here are warmed only if a
 * `history` fetcher is injected; without one `seed()` returns immediately and
 * every series starts cold, so a job needing 15 completed hourly bars for an
 * ATR returns `{ retry: true }` and logs "no data yet, retrying in 30s" for the
 * rest of the session — the base's designed behaviour for missing data, but the
 * cause is us, not the market. `main.ts` injects `HttpHistoryFetcher`, which
 * reads from `apps/marketdata` (the process that holds the single Kite login).
 * The parameter stays OPTIONAL only so tests can exercise the cold path
 * deliberately.
 */

import {
  CandleStore,
  SubscriptionRegistry,
  StalenessWatchdog,
  // Aliased: the class below has a `selectOption` METHOD (the `MarketData`
  // port's), and two identical names in one file is the kind of thing that
  // reads as a recursive call at a glance.
  selectOption as selectOnGrid,
  topics,
  type Interval as StoreInterval,
  type SelectCriteria,
  type Selection,
  type TickMode,
} from '@algomaker/marketdata-core'
import type { OptionMaster } from '@algomaker/instruments'
import type { InstrumentRef } from '@algomaker/order-bus'
import type {
  Candle,
  Clock,
  DataNeed,
  FeedHealthPort,
  Interval,
  Logger,
  MarketData,
  Quote,
} from '@algomaker/strategy-kit'

/** Historical bars for a cold series. Injected; `apps/marketdata` can supply it. */
export interface HistoryFetcher {
  bars(token: number, interval: StoreInterval, count: number): Promise<readonly Candle[]>
}

export interface DeclaredSeries {
  readonly token: number
  readonly interval: StoreInterval
}

/**
 * Intervals a strategy may declare implicitly.
 *
 * `DataNeed` carries no interval (it names instruments, not bar sizes), and the
 * strategies pull `candles(token, '5minute'|'60minute', n)` at their own
 * decision points. Keeping both warm for every declared instrument costs two
 * series per token and removes the whole class of "the series the strategy
 * actually asked for was never declared, so it silently read nothing".
 */
export const WARM_INTERVALS: readonly StoreInterval[] = ['5minute', '60minute']

export interface RunnerMarketDataDeps {
  readonly master: () => OptionMaster
  readonly clock: Clock
  readonly log: Logger
  readonly history?: HistoryFetcher
  /** Feed-wide staleness threshold. Blocks new exposure only; never an exit. */
  readonly staleAfterMs?: number
  /**
   * Minimum spacing between two history calls, in ms. Default 350.
   *
   * Kite throttles the historical endpoint PER LOGIN at ~3 requests a second,
   * and the login is shared with the enctoken canary and the margin sweep. A
   * boot batch is ~150 series; fired back-to-back (~35ms apart) it drew
   * "NetworkException: Too many requests" on a handful of them every session —
   * 399 cold series across two weeks of prod logs.
   */
  readonly seedGapMs?: number
  /** Injected so the pacing is testable without real time passing. */
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_SEED_GAP_MS = 350

const seriesKey = (s: DeclaredSeries): string => `${s.token}:${s.interval}`

export class RunnerMarketData implements MarketData, FeedHealthPort {
  readonly #d: RunnerMarketDataDeps
  readonly #candles = new CandleStore()
  readonly #registry = new SubscriptionRegistry()
  readonly #watchdog: StalenessWatchdog
  readonly #quotes = new Map<number, Quote>()
  /** token -> the tags that declared it. The routing table. */
  readonly #routes = new Map<number, Set<string>>()
  /**
   * tag -> the SPOT tokens that tag's needs depend on.
   *
   * Kept because a spot token is not always subscribed by the strategy that
   * needs it: an `option-chain` need declares CONTRACTS, and `#chainWindow`
   * centres them on `#quotes.get(spotToken)` — a token that appears in nobody's
   * subscription set unless some other need asked for the index. The prune has
   * to know that, or it deletes the one quote without which no window can be
   * centred again for the rest of the session.
   */
  readonly #needSpots = new Map<string, Set<number>>()
  readonly #staleAfterMs: number
  #lastTickMs = 0
  /**
   * The ONE lane every history call goes through, and when the last one left.
   *
   * `seed()` is called from three places that overlap — boot, the 15s
   * declareAll and a `void md.seed()` per built strategy — so pacing inside a
   * single call is not enough; the lane is shared across all of them.
   */
  #seedLane: Promise<void> = Promise.resolve()
  #lastSeedAt = Number.NEGATIVE_INFINITY
  /**
   * Series whose seed FAILED and which are still held by a strategy.
   *
   * `declare()` reports a series as new exactly once, so without this a
   * throttled seed left the series cold until the next process restart — an
   * ATR strategy logging "not enough hourly candles" all day. Every `seed()`
   * call drains it first.
   */
  readonly #cold = new Map<string, DeclaredSeries>()

  constructor(deps: RunnerMarketDataDeps) {
    this.#d = deps
    this.#staleAfterMs = deps.staleAfterMs ?? 15_000
    this.#watchdog = new StalenessWatchdog(this.#staleAfterMs)
  }

  // ------------------------------------------------------------ declaration

  /**
   * Declare one strategy's complete set of needs. Idempotent — re-declaring the
   * same set is a no-op, which is what makes it safe to call on every sync.
   *
   * Returns the tokens the feed must be subscribed to and the series that
   * became newly live (and therefore want a history seed).
   */
  declare(
    tag: string,
    needs: readonly DataNeed[],
  ): { tokens: readonly number[]; newSeries: readonly DeclaredSeries[] } {
    const master = this.#d.master()
    const tokens: { token: number; mode: TickMode; topic: string }[] = []
    /** Every underlying this tag names, resolved to spot. See `#needSpots`. */
    const spots = new Set<number>()

    for (const need of needs) {
      const mode: TickMode = need.mode ?? 'full'
      const spot = master.spotToken(need.underlying)
      if (spot !== null) spots.add(spot)
      if (need.kind === 'index' || need.kind === 'stock') {
        const t = master.spotToken(need.underlying)
        if (t !== null) tokens.push({ token: t, mode, topic: topics.index(need.underlying) })
        continue
      }
      if (need.kind === 'future') {
        const f = master.future(need.underlying)
        // The FUTURE, and the spot too: every one of these strategies references
        // the future for its signal but still needs spot to pick a strike.
        if (f?.instrumentToken !== undefined) {
          tokens.push({ token: f.instrumentToken, mode, topic: topics.future(need.underlying, '') })
        }
        const s = master.spotToken(need.underlying)
        if (s !== null) tokens.push({ token: s, mode, topic: topics.index(need.underlying) })
        continue
      }
      // option-chain: a WINDOW around ATM, never the whole chain. Subscribing
      // whole chains per strategy is what produced ~50,000 token-subscriptions
      // across ~150 legacy processes.
      for (const inst of this.#chainWindow(need)) {
        if (inst.instrumentToken === undefined) continue
        tokens.push({
          token: inst.instrumentToken,
          mode,
          topic: topics.option(need.underlying, ''),
        })
      }
    }

    this.#registry.declare({ subscriberId: tag, needs: tokens })

    // Rebuild this tag's routes from scratch: a chain window moves with spot,
    // so incremental updates would leave stale tokens routed forever.
    for (const set of this.#routes.values()) set.delete(tag)
    for (const t of tokens) {
      let set = this.#routes.get(t.token)
      if (set === undefined) {
        set = new Set()
        this.#routes.set(t.token, set)
      }
      set.add(tag)
    }

    this.#needSpots.set(tag, spots)
    this.#prune()

    const series: DeclaredSeries[] = []
    for (const t of tokens) {
      for (const interval of WARM_INTERVALS) series.push({ token: t.token, interval })
    }
    const diff = this.#candles.declare(tag, series)
    return {
      tokens: [...new Set(tokens.map((t) => t.token))],
      newSeries: diff.activated.map((s) => ({ token: s.token, interval: s.interval })),
    }
  }

  /** Drop a strategy's declarations entirely — it stopped or was switched off. */
  release(tag: string): void {
    this.#registry.remove(tag)
    this.#candles.remove(tag)
    for (const set of this.#routes.values()) set.delete(tag)
    this.#needSpots.delete(tag)
    this.#prune()
  }

  /**
   * How much state the two unbounded maps are holding. For tests and for a
   * health line — the bound in `#prune` is a claim, and a claim about memory
   * that nothing can observe is how it grew unnoticed in the first place.
   */
  get stats(): { quotes: number; routedTokens: number } {
    return { quotes: this.#quotes.size, routedTokens: this.#routes.size }
  }

  /** Which strategies want this token. Empty means "nobody asked" — drop it. */
  routesFor(token: number): readonly string[] {
    return [...(this.#routes.get(token) ?? [])]
  }

  /** Every token the feed should be subscribed to, for a (re)subscribe. */
  subscriptionSet(): readonly { token: number; mode: TickMode }[] {
    return this.#registry.fullSubscriptionSet()
  }

  /**
   * Seed newly-live series from history — PACED, SERIALISED, and with a memory
   * of what failed.
   *
   * Fail-soft per series: one instrument's history failing must not abort the
   * batch, because the other series in it are what the rest of the strategies
   * are waiting on. A failed series goes into `#cold` and is retried at the
   * front of the next call, so a throttled boot heals within one declareAll
   * cycle (15s) rather than at the next restart.
   */
  async seed(series: readonly DeclaredSeries[], count = 200): Promise<void> {
    const history = this.#d.history
    if (history === undefined) return
    const batch = new Map<string, DeclaredSeries>()
    for (const s of this.#cold.values()) batch.set(seriesKey(s), s)
    for (const s of series) batch.set(seriesKey(s), s)
    if (batch.size === 0) return
    for (const s of batch.values()) {
      // A series nobody holds any more was released between the failure and
      // this retry: fetching it would be a wasted slot of the shared budget.
      if (!this.#candles.isActive(s.token, s.interval)) {
        this.#cold.delete(seriesKey(s))
        continue
      }
      await this.#paced(async () => {
        try {
          const bars = await history.bars(s.token, s.interval, count)
          this.#candles.seed(s.token, s.interval, bars)
          this.#cold.delete(seriesKey(s))
        } catch (err) {
          this.#cold.set(seriesKey(s), s)
          this.#d.log.warn('runner md: history seed failed', {
            token: s.token,
            interval: s.interval,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })
    }
  }

  /** Series whose last seed failed and which a strategy still holds. For tests and the health line. */
  coldSeries(): readonly DeclaredSeries[] {
    return [...this.#cold.values()]
  }

  /** Run `fn` on the shared lane, no sooner than `seedGapMs` after the previous one. */
  #paced(fn: () => Promise<void>): Promise<void> {
    const gap = this.#d.seedGapMs ?? DEFAULT_SEED_GAP_MS
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const run = this.#seedLane.then(async () => {
      const wait = this.#lastSeedAt + gap - this.#d.clock.now()
      if (wait > 0) await sleep(wait)
      this.#lastSeedAt = this.#d.clock.now()
      await fn()
    })
    // The lane must never reject: one failure would stall every later seed.
    this.#seedLane = run.catch(() => {})
    return run
  }

  // -------------------------------------------------------------- ingestion

  /**
   * One tick in. Aggregates every series on the token ONCE, records liveness,
   * and stores the quote. The caller fans it out to `routesFor(token)`.
   */
  onTick(quote: Quote): void {
    this.#quotes.set(quote.token, quote)
    this.#candles.onTick(quote.token, quote.lastPrice, quote.ts)
    this.#watchdog.record(quote.token, quote.ts)
    if (quote.ts > this.#lastTickMs) this.#lastTickMs = quote.ts
  }

  // ------------------------------------------------------------ MarketData

  quote(token: number): Quote | null {
    return this.#quotes.get(token) ?? null
  }

  async candles(token: number, interval: Interval, count: number): Promise<readonly Candle[]> {
    return this.#candles.candles(token, interval as StoreInterval, count)
  }

  option(underlying: string, strike: number, type: 'CE' | 'PE'): InstrumentRef | null {
    const expiry = this.#nearestExpiry(underlying)
    if (expiry === null) return null
    return this.#d.master().resolve(underlying, expiry, strike, type)
  }

  future(underlying: string): InstrumentRef | null {
    return this.#d.master().future(underlying)
  }

  /**
   * ATM on the chain's LISTED grid, never `round(spot/step)*step`.
   *
   * Returns 0 when there is no chain at all. The port's return type has no
   * `null`, and 0 is the one value that cannot resolve to a listed strike — so
   * `option()` returns null immediately after and no order is placed. That is
   * the deliberate opposite of `otmSelector`, which returned a PLAUSIBLE 0 that
   * callers happily added to a strike and traded on.
   */
  atmStrike(underlying: string, spotPrice: number): number {
    const expiry = this.#nearestExpiry(underlying)
    if (expiry === null) return 0
    return this.#d.master().atmStrike(underlying, expiry, spotPrice) ?? 0
  }

  spotToken(underlying: string): number {
    const t = this.#d.master().spotToken(underlying)
    if (t === null) {
      // A throw rather than a sentinel: every caller uses this to look up a
      // price, and there is no number that means "this underlying has no spot".
      // StrategyBase contains the throw, so it costs one handler, not the day.
      throw new Error(`no spot instrument for '${underlying}' in the instrument master`)
    }
    return t
  }

  /**
   * Delta / premium / offset selection on a NAMED expiry — the `MarketData`
   * port's own method.
   *
   * The expiry is a parameter rather than "the nearest one" because choosing to
   * roll is a decision with a date attached, and a port that picks silently is
   * how a book rolls a day early with nothing able to say which code did it.
   * `select()` below is the nearest-expiry convenience on top of it.
   */
  selectOption(underlying: string, expiry: string, criteria: SelectCriteria): Selection | null {
    const spotToken = this.#d.master().spotToken(underlying)
    const spot = spotToken === null ? null : (this.#quotes.get(spotToken)?.lastPrice ?? null)
    if (spot === null) return null
    const marks = new Map<number, number>()
    for (const [token, q] of this.#quotes) marks.set(token, q.lastPrice)
    return selectOnGrid(
      {
        master: this.#d.master(),
        underlying,
        expiry,
        spot,
        marks,
        nowMs: this.#d.clock.now(),
      },
      criteria,
    )
  }

  /**
   * The same selection against the NEAREST listed expiry.
   *
   * Kept beside `selectOption` rather than folded into it because "nearest" is
   * this file's answer, not the port's: `#nearestExpiry` walks the instrument
   * master from today's IST date, which is a policy a caller may reasonably not
   * want. Returns null when there is no chain at all, exactly like the port
   * method — never a fallback.
   */
  select(underlying: string, criteria: SelectCriteria): Selection | null {
    const expiry = this.#nearestExpiry(underlying)
    if (expiry === null) return null
    return this.selectOption(underlying, expiry, criteria)
  }

  // ------------------------------------------------------------ FeedHealth

  /**
   * Feed-wide, not per token. A single stock option contract can legitimately
   * go 30 seconds without a print, so a per-token age limit would report the
   * whole feed dead all day. What is NOT legitimate is nothing arriving at all,
   * which is the socket-open-but-silent failure this exists to catch.
   */
  isTrustworthy(): boolean {
    if (this.#lastTickMs === 0) return false
    return this.#d.clock.now() - this.#lastTickMs <= this.#staleAfterMs
  }

  reason(): string | null {
    if (this.isTrustworthy()) return null
    if (this.#lastTickMs === 0) return 'no ticks received yet'
    const ageMs = this.#d.clock.now() - this.#lastTickMs
    return `no tick for ${Math.round(ageMs / 1000)}s across the whole feed`
  }

  // -------------------------------------------------------------- internals

  /**
   * Forget every token no current declaration wants (audit F-53).
   *
   * NEITHER MAP HAD AN EXIT BEFORE THIS. `#routes` gained an entry per token
   * and only ever had TAGS removed from it, so a token whose set had emptied
   * stayed as a permanent empty set; `#quotes` kept the last tick for every
   * token that ever arrived, including tokens on the shared feed this process
   * never asked for. A chain window re-centres as spot moves, so on a trending
   * day both maps grow all session and the entries they accumulate are the
   * stale ones — and a stale quote is not inert: `selectOption` builds its
   * marks grid out of this map, so a price frozen at 10:05 for a contract
   * nobody is subscribed to any more can still be selected on.
   *
   * ON THE DECLARE CADENCE, and that is the correct one: the registry holds
   * EVERY subscriber's declaration, so the union is complete at this instant
   * regardless of which tag triggered the call, and `main.ts` re-declares the
   * whole catalogue on every sync. `md.release(tag)` prunes for the same reason.
   *
   * Spot tokens are retained beyond the subscription set — see `#needSpots`.
   */
  #prune(): void {
    const keep = new Set<number>()
    for (const s of this.#registry.fullSubscriptionSet()) keep.add(s.token)
    for (const spots of this.#needSpots.values()) for (const t of spots) keep.add(t)

    for (const [token, tags] of this.#routes) {
      // An empty set IS the retirement: `routesFor` already answers [] for it.
      if (tags.size === 0 || !keep.has(token)) this.#routes.delete(token)
    }
    for (const token of this.#quotes.keys()) {
      if (!keep.has(token)) this.#quotes.delete(token)
    }
  }

  #nearestExpiry(underlying: string): string | null {
    const today = new Date(this.#d.clock.now() + 330 * 60_000).toISOString().slice(0, 10)
    return this.#d.master().nearestExpiry(underlying, today)
  }

  /**
   * The strikes around ATM to keep subscribed.
   *
   * Empty when spot has not arrived yet — the window cannot be centred without
   * it, and subscribing an arbitrary slice of the chain would be worse than
   * subscribing none. `declare()` is re-run on every sync, so it fills in as
   * soon as the first spot tick lands.
   */
  #chainWindow(need: DataNeed): readonly InstrumentRef[] {
    const master = this.#d.master()
    const expiry = this.#nearestExpiry(need.underlying)
    if (expiry === null) return []
    const spotToken = master.spotToken(need.underlying)
    const spot = spotToken === null ? undefined : this.#quotes.get(spotToken)?.lastPrice
    if (spot === undefined) return []
    const atm = master.atmStrike(need.underlying, expiry, spot)
    if (atm === null) return []
    const strikes = master.strikes(need.underlying, expiry)
    const at = strikes.indexOf(atm)
    if (at < 0) return []
    const width = need.strikeWindow ?? 3
    const out: InstrumentRef[] = []
    // Walked along the LISTED grid, so a gap where a strike was never listed is
    // stepped over rather than fallen into.
    for (let i = Math.max(0, at - width); i <= Math.min(strikes.length - 1, at + width); i++) {
      const strike = strikes[i]
      if (strike === undefined) continue
      for (const type of ['CE', 'PE'] as const) {
        const inst = master.resolve(need.underlying, expiry, strike, type)
        if (inst !== null) out.push(inst)
      }
    }
    return out
  }
}
