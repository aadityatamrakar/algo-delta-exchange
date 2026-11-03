/**
 * CandleStore — one shared, refcounted OHLC series per (token, interval).
 *
 * WHY this is shared rather than per-strategy: in the legacy system every
 * strategy called `historyData()` on its own poller, so ten strategies watching
 * BHEL 5-minute made ten network round-trips for the same bars and each kept its
 * own copy. Here a series is declared, and the SAME dedup principle as
 * `SubscriptionRegistry` applies — ten declarations produce one series.
 *
 * Pure logic, no I/O. The store is FED a historical seed and FED ticks; it never
 * fetches. That is what makes bar aggregation testable without a broker, and it
 * is why the fetch/subscribe side lives in the marketdata service instead.
 *
 * Three properties this file exists to guarantee, each a real bug class:
 *
 *   1. A tick advances a series ONCE, not once per reader. Aggregating inside
 *      the read path means N readers push the bar forward N times and every OHLC
 *      is wrong in a way that only shows up under load.
 *   2. Reads return a FROZEN slice. Handing out the internal array lets one
 *      strategy's `.pop()`/`.reverse()` silently corrupt what every other
 *      strategy reads — and it would present as a strategy defect, not a cache
 *      defect, so it would be debugged in the wrong file for days.
 *   3. Only COMPLETED bars are served. Strategies read
 *      `candles[candles.length - 1]` as the last CLOSED bar; a forming bar
 *      leaking in makes every breakout check fire early on partial data.
 */

/** Bar sizes the store aggregates. Matches Kite's historical intervals. */
export type Interval = '1minute' | '3minute' | '5minute' | '15minute' | '60minute' | 'day'

/**
 * One bar. Structurally identical to `@algomaker/strategy-kit`'s `Candle`, and
 * deliberately so: the store must be passable straight into an indicator (today
 * `wilderAtr` in `@algomaker/strategies`) without a mapping step. Duplicated
 * rather than imported because marketdata-core sits UNDER strategy-kit and must
 * not depend upward.
 */
export interface Candle {
  /** Epoch ms of the bar's OPEN, i.e. its IST-aligned bucket start. */
  readonly ts: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume?: number
}

/** A series a subscriber wants kept warm. */
export interface SeriesNeed {
  readonly token: number
  readonly interval: Interval
}

export interface CandleDiff {
  /** Series that became live on this call (first declarer). */
  readonly activated: readonly SeriesNeed[]
  /** Series dropped because the last declarer left. */
  readonly deactivated: readonly SeriesNeed[]
}

const emptyDiff: CandleDiff = { activated: [], deactivated: [] }

const MINUTE_MS = 60_000

const INTERVAL_MS: Readonly<Record<Interval, number>> = {
  '1minute': MINUTE_MS,
  '3minute': 3 * MINUTE_MS,
  '5minute': 5 * MINUTE_MS,
  '15minute': 15 * MINUTE_MS,
  '60minute': 60 * MINUTE_MS,
  day: 24 * 60 * MINUTE_MS,
}

export function intervalMs(interval: Interval): number {
  return INTERVAL_MS[interval]
}

/** IST is UTC+05:30 and has no DST, so a fixed offset is exact, not an approximation. */
const IST_OFFSET_MS = 330 * MINUTE_MS

/**
 * Start of the bucket `tsMs` falls in, as epoch ms.
 *
 * Buckets are IST WALL-CLOCK aligned: a 5-minute bar starts at :00/:05/:10, an
 * hourly bar at the top of the IST hour, a daily bar at IST midnight. Flooring in
 * UTC would put every hourly boundary at :30 IST, and every daily boundary at
 * 05:30 IST — i.e. mid-session — which silently splits a trading day in two.
 *
 * A tick landing exactly ON a boundary belongs to the NEW bar: the bucket is the
 * half-open range [start, start + size), the same convention Kite's historical
 * candles use, so a seeded series and a live-aggregated one agree.
 */
/** NSE session open, 09:15 IST, as minutes past IST midnight. */
export const SESSION_OPEN_IST_MIN = 9 * 60 + 15

/**
 * Bars are anchored to the SESSION OPEN (09:15 IST), not to wall-clock midnight.
 *
 * This is not cosmetic. Kite's own historical candles are session-anchored, so
 * hourly bars run 09:15-10:15, 10:15-11:15 — NOT 09:00-10:00. `atr-band-nifty.js`
 * says so at line 113: "Freeze the ATR at the 09:15-10:15 hourly candle (start ts
 * 09:15)", and it filters on exactly that string.
 *
 * Anchoring to midnight instead would give 09:00-10:00 bars, so a series seeded
 * from Kite history and one advanced from live ticks would disagree about where
 * every hourly bar begins — and ATR-14 computed over them would quietly differ
 * from the value the legacy strategy trades on. A wrong band that still looks
 * like a band.
 *
 * For intervals that divide the session start evenly (1/3/5/15 minute) this is
 * indistinguishable from wall-clock alignment, which is why the discrepancy only
 * shows up at 60minute.
 */
export function bucketStart(tsMs: number, interval: Interval): number {
  const size = INTERVAL_MS[interval]
  const ist = tsMs + IST_OFFSET_MS
  if (interval === 'day') return Math.floor(ist / size) * size - IST_OFFSET_MS
  const dayStart = Math.floor(ist / DAY_MS) * DAY_MS
  const anchor = dayStart + SESSION_OPEN_IST_MIN * 60_000
  // A tick before the open (pre-market) buckets into the session-relative slot
  // it falls in, so the arithmetic stays continuous rather than special-casing.
  return anchor + Math.floor((ist - anchor) / size) * size - IST_OFFSET_MS
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A tick as the store needs it. Structurally satisfied by `Tick` from ./index.ts. */
export interface TickLike {
  readonly lastPrice: number
  readonly ts?: number
}

interface FormingBar {
  ts: number
  open: number
  high: number
  low: number
  close: number
}

interface SeriesState {
  readonly token: number
  readonly interval: Interval
  /** Completed bars, oldest -> newest. Every entry is frozen. */
  readonly completed: Candle[]
  forming: FormingBar | null
  /** ts of the newest completed bar, or -Infinity. Guards late ticks. */
  lastCompletedTs: number
}

/**
 * A bar that has just CLOSED, as handed to `onBarComplete` subscribers.
 *
 * Structurally identical to `@algomaker/strategy-kit`'s `CandleEvent` on
 * purpose, so a host can forward it to `StrategyBase.handleCandle` with no
 * mapping step. Duplicated rather than imported for the same reason `Candle` is:
 * marketdata-core sits UNDER strategy-kit and must not depend upward.
 */
export interface CompletedBar {
  readonly token: number
  readonly interval: Interval
  readonly candle: Candle
}

export type BarCompleteHandler = (bar: CompletedBar) => void

export interface CandleStoreOptions {
  /**
   * Bars retained per series. Bounded because the store is long-lived and a
   * 1-minute series over a week is 2,000+ bars per token; the deepest consumer
   * (ATR-14 on 60-minute) needs tens, not thousands.
   */
  readonly maxBars?: number
  /**
   * Where a throwing `onBarComplete` subscriber's error goes.
   *
   * A subscriber must not be able to break aggregation: `#complete` runs INSIDE
   * the loop over a token's series, so letting the throw escape would leave every
   * other interval on that token un-advanced — a data-corruption bug presenting
   * as a strategy bug. Swallowing it silently is the other unacceptable option.
   * With no handler supplied the error is rethrown on a fresh macrotask so it
   * surfaces as an unhandled exception instead of vanishing; hosts should pass
   * one that logs.
   */
  readonly onError?: (err: unknown, bar: CompletedBar) => void
}

const seriesKeyOf = (token: number, interval: Interval): string => `${token}:${interval}`

/**
 * Refcounted (token, interval) -> series store.
 *
 * `declare`/`remove` return a DIFF rather than doing I/O, exactly like
 * `SubscriptionRegistry`, so the caller decides what to fetch and the store stays
 * testable with no feed at all.
 */
export class CandleStore {
  /** seriesKey -> subscriberIds holding it. */
  readonly #refs = new Map<string, Set<string>>()
  /** seriesKey -> state. Exactly one state per key, however many holders. */
  readonly #series = new Map<string, SeriesState>()
  /**
   * token -> every series on that token.
   *
   * This index is the mechanism behind guarantee (1): `onTick` walks the token's
   * series ONCE and advances each, instead of aggregating lazily per reader.
   */
  readonly #byToken = new Map<number, SeriesState[]>()
  readonly #maxBars: number
  /** Bar-completion subscribers. See `onBarComplete`. */
  readonly #barHandlers = new Set<BarCompleteHandler>()
  readonly #onError: (err: unknown, bar: CompletedBar) => void

  constructor(opts: CandleStoreOptions = {}) {
    this.#maxBars = opts.maxBars ?? 1500
    this.#onError =
      opts.onError ??
      ((err) => {
        setTimeout(() => {
          throw err
        }, 0)
      })
  }

  /**
   * Subscribe to bar completions. Returns an unsubscribe.
   *
   * WHY this exists: `onCandle` on `StrategyBase` is documented as "pushed when a
   * declared series completes a bar", and there was no push. The store closed
   * bars silently, so `handleCandle` had no production caller at all and the hook
   * was a dead limb — a strategy could declare a 5-minute series, implement
   * `onCandle`, and never once be called. The store is the only place that KNOWS
   * a bar closed, so the event has to originate here; the host wires it to
   * `handleCandle`.
   *
   * Fires ONLY for bars closed by the live tick stream (`onTick`), never for
   * `seed()` — seeded bars are history that closed before this process existed,
   * and replaying them as completions would re-trigger every strategy decision
   * for the whole warm-up window on every restart.
   *
   * A bar closes when the FIRST tick of the next bucket arrives, not on a timer:
   * the store is pure and has no clock. An instrument that stops printing leaves
   * its last bar forming, which is correct — nothing has closed it.
   */
  onBarComplete(handler: BarCompleteHandler): () => void {
    this.#barHandlers.add(handler)
    return () => {
      this.#barHandlers.delete(handler)
    }
  }

  get seriesCount(): number {
    return this.#series.size
  }

  isActive(token: number, interval: Interval): boolean {
    return this.#series.has(seriesKeyOf(token, interval))
  }

  /** Every live series, for the caller that has to go fetch their history. */
  activeSeries(): readonly SeriesNeed[] {
    return [...this.#series.values()].map((s) => ({ token: s.token, interval: s.interval }))
  }

  /**
   * Declare a subscriber's COMPLETE set of series. Idempotent: re-declaring the
   * same set returns an empty diff, which is what makes it safe to call on every
   * strategy restart without churning the seed.
   */
  declare(subscriberId: string, series: readonly SeriesNeed[]): CandleDiff {
    const wanted = new Set<string>()
    const wantedNeeds = new Map<string, SeriesNeed>()
    for (const s of series) {
      const key = seriesKeyOf(s.token, s.interval)
      wanted.add(key)
      wantedNeeds.set(key, { token: s.token, interval: s.interval })
    }

    const activated: SeriesNeed[] = []
    const deactivated: SeriesNeed[] = []

    // Drop what this subscriber no longer wants...
    for (const [key, holders] of [...this.#refs]) {
      if (!holders.has(subscriberId) || wanted.has(key)) continue
      const dropped = this.#releaseHolder(key, subscriberId)
      if (dropped !== null) deactivated.push(dropped)
    }
    // ...and take a reference on what it does.
    for (const [key, need] of wantedNeeds) {
      let holders = this.#refs.get(key)
      if (holders === undefined) {
        holders = new Set()
        this.#refs.set(key, holders)
      }
      const wasEmpty = holders.size === 0
      holders.add(subscriberId)
      if (wasEmpty) {
        this.#createSeries(key, need)
        activated.push(need)
      }
    }

    if (activated.length === 0 && deactivated.length === 0) return emptyDiff
    return { activated, deactivated }
  }

  /** Drop a subscriber entirely — a strategy stopping or being reset. */
  remove(subscriberId: string): CandleDiff {
    const deactivated: SeriesNeed[] = []
    for (const [key, holders] of [...this.#refs]) {
      if (!holders.has(subscriberId)) continue
      const dropped = this.#releaseHolder(key, subscriberId)
      if (dropped !== null) deactivated.push(dropped)
    }
    if (deactivated.length === 0) return emptyDiff
    return { activated: [], deactivated }
  }

  #createSeries(key: string, need: SeriesNeed): void {
    const state: SeriesState = {
      token: need.token,
      interval: need.interval,
      completed: [],
      forming: null,
      lastCompletedTs: Number.NEGATIVE_INFINITY,
    }
    this.#series.set(key, state)
    const list = this.#byToken.get(need.token)
    if (list === undefined) this.#byToken.set(need.token, [state])
    else list.push(state)
  }

  /** Returns the series that died, or null when other holders remain. */
  #releaseHolder(key: string, subscriberId: string): SeriesNeed | null {
    const holders = this.#refs.get(key)
    if (holders === undefined) return null
    holders.delete(subscriberId)
    if (holders.size > 0) return null
    this.#refs.delete(key)
    const state = this.#series.get(key)
    if (state === undefined) return null
    this.#series.delete(key)
    const list = this.#byToken.get(state.token)
    if (list !== undefined) {
      const idx = list.indexOf(state)
      if (idx >= 0) list.splice(idx, 1)
      if (list.length === 0) this.#byToken.delete(state.token)
    }
    return { token: state.token, interval: state.interval }
  }

  // ------------------------------------------------------------------ seeding

  /**
   * Seed a series with historical bars, OLDEST FIRST.
   *
   * Returns false when the series is not (or is no longer) declared. That is a
   * real case rather than an error: the history fetch is async, and a strategy
   * can stop while its seed is still in flight. Throwing there would take down
   * the fetch loop for every other series in the same batch.
   *
   * Bars are assumed COMPLETE — the caller must drop the broker's trailing
   * partial bar, because there is no way to tell one from a closed bar by shape
   * alone, and admitting a forming bar here would break guarantee (3).
   */
  seed(token: number, interval: Interval, bars: readonly Candle[]): boolean {
    const state = this.#series.get(seriesKeyOf(token, interval))
    if (state === undefined) return false

    // Re-seeding replaces history rather than appending: a re-fetch after a
    // reconnect overlaps what is already held, and appending would duplicate bars.
    state.completed.length = 0
    const sorted = [...bars].sort((a, b) => a.ts - b.ts)
    let prevTs = Number.NEGATIVE_INFINITY
    for (const bar of sorted) {
      if (!isUsableBar(bar)) continue
      // Snap to the bucket grid so a seeded ts and a live-aggregated ts for the
      // same bar are identical; otherwise dedup and the late-tick guard misfire.
      const ts = bucketStart(bar.ts, interval)
      if (ts === prevTs) {
        // Duplicate bucket: last one wins, brokers re-send the most recent bar.
        state.completed[state.completed.length - 1] = freezeBar({ ...bar, ts })
        continue
      }
      state.completed.push(freezeBar({ ...bar, ts }))
      prevTs = ts
    }
    this.#trim(state)
    state.lastCompletedTs = state.completed.at(-1)?.ts ?? Number.NEGATIVE_INFINITY
    // A forming bar built before the seed landed is now unreliable — its open
    // came from whichever tick happened to arrive first, not from the bar's open.
    if (state.forming !== null && state.forming.ts <= state.lastCompletedTs) state.forming = null
    return true
  }

  // ------------------------------------------------------------------- ticks

  /**
   * Advance every series on `token` by one tick.
   *
   * Called ONCE per tick by the feed adapter — never from a read path. All
   * intervals registered on the token advance together off the same price, which
   * is what keeps a 5-minute and a 60-minute view of the same instrument
   * consistent.
   */
  onTick(token: number, priceOrTick: number | TickLike, tsMs?: number): void {
    const series = this.#byToken.get(token)
    if (series === undefined || series.length === 0) return

    const price = typeof priceOrTick === 'number' ? priceOrTick : priceOrTick.lastPrice
    const ts = tsMs ?? (typeof priceOrTick === 'number' ? undefined : priceOrTick.ts)

    // An undated tick cannot be bucketed. Substituting Date.now() would make the
    // store impure and would mis-bucket a replayed or delayed tick, so drop it.
    if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return
    // Same reasoning as `isPlausibleTick`: a zero/NaN price must never reach OHLC.
    if (!Number.isFinite(price) || price <= 0) return

    // One pass over the token's series. Each has its own bucket size, so the
    // boundary is computed per series inside #advance.
    for (const state of series) this.#advance(state, price, ts)
  }

  #advance(state: SeriesState, price: number, ts: number): void {
    const start = bucketStart(ts, state.interval)
    const forming = state.forming

    if (forming !== null) {
      if (start === forming.ts) {
        if (price > forming.high) forming.high = price
        if (price < forming.low) forming.low = price
        forming.close = price
        return
      }
      if (start < forming.ts) return // out-of-order tick; never rewrite a bar backwards
      // A NEW bucket closes the forming bar. Note that no bars are fabricated for
      // the buckets in between: a gap with no ticks is a gap, and inventing flat
      // bars there would feed indicators data the market never printed.
      this.#complete(state, forming)
      state.forming = null
    }

    // Belongs to an already-closed bar (a late tick, or a seed that covers it).
    if (start <= state.lastCompletedTs) return
    state.forming = { ts: start, open: price, high: price, low: price, close: price }
  }

  #complete(state: SeriesState, bar: FormingBar): void {
    const candle = freezeBar({ ...bar })
    state.completed.push(candle)
    state.lastCompletedTs = bar.ts
    this.#trim(state)
    if (this.#barHandlers.size === 0) return
    // Emitted AFTER the bar is in `completed`, so a handler that immediately
    // reads `candles(token, interval, n)` sees the bar it was just told about.
    const event: CompletedBar = { token: state.token, interval: state.interval, candle }
    // A copy of the handler set: a handler that unsubscribes itself (a strategy
    // stopping on the bar that closed it out) must not skip its neighbours.
    for (const h of [...this.#barHandlers]) {
      try {
        h(event)
      } catch (err) {
        this.#onError(err, event)
      }
    }
  }

  #trim(state: SeriesState): void {
    const excess = state.completed.length - this.#maxBars
    if (excess > 0) state.completed.splice(0, excess)
  }

  // ------------------------------------------------------------------- reads

  /**
   * The last `count` COMPLETED bars, oldest -> newest.
   *
   * The returned array is FROZEN, as are the bars in it (guarantee 2). Callers
   * that need to sort or slice must copy first — that copy is theirs, and its
   * cost is a rounding error next to the class of bug it prevents.
   *
   * The forming bar is deliberately absent (guarantee 3).
   */
  candles(token: number, interval: Interval, count: number): readonly Candle[] {
    const state = this.#series.get(seriesKeyOf(token, interval))
    if (state === undefined || count <= 0) return EMPTY_BARS
    const all = state.completed
    const from = count >= all.length ? 0 : all.length - count
    return Object.freeze(all.slice(from))
  }

  /**
   * The bar currently being built, or null.
   *
   * Exposed for diagnostics and UI only, and deliberately NOT part of
   * `candles()`: every strategy decision must be taken on closed bars.
   */
  formingBar(token: number, interval: Interval): Candle | null {
    const forming = this.#series.get(seriesKeyOf(token, interval))?.forming
    if (forming === undefined || forming === null) return null
    return freezeBar({ ...forming })
  }

  /** Newest completed bar, or null. The read strategies actually make most. */
  lastCandle(token: number, interval: Interval): Candle | null {
    return this.#series.get(seriesKeyOf(token, interval))?.completed.at(-1) ?? null
  }
}

const EMPTY_BARS: readonly Candle[] = Object.freeze([])

function freezeBar(bar: Candle): Candle {
  return Object.freeze(bar)
}

/** A bar with a non-finite price would poison every indicator downstream. */
function isUsableBar(bar: Candle): boolean {
  return (
    Number.isFinite(bar.ts) &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close)
  )
}
