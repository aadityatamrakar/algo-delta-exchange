/**
 * Live marks for the bridge.
 *
 * Paper fills and greeks both price off this. It is a CACHE fed by the market
 * data feed, never a fetcher: pricing an order must not be able to block on a
 * network call, and a decision that arrives mid-outage must fail fast rather
 * than fill at whatever a retry eventually returns.
 *
 * TWO DIFFERENT FAILURES, measured 2026-07-27 against the live feed and
 * originally conflated here:
 *
 *  1. **A dead feed** — the socket stays open but ticks stop entirely. This is
 *     the dangerous one: every strategy decides on frozen prices while
 *     everything looks healthy. Prices must be treated as ABSENT.
 *  2. **An illiquid instrument** — the feed is perfectly healthy, this
 *     particular contract just does not trade often. Measured on the real BHEL
 *     August chain: **~2 ticks per minute, a 30s gap between ticks**, and the
 *     470CE wing ticked once in sixty seconds.
 *
 * The first version of this file applied a 15s age limit per token, which is
 * right for an index option ticking several times a second and catastrophic for
 * a stock option: every BHEL mark would read as absent more than half the time,
 * every action would skip with "no mark", and the bridge would book nothing.
 *
 * The discriminator is FEED-WIDE, not per-token: if ticks are arriving on some
 * tokens, the feed is alive and a 90-second-old quote on an illiquid strike is
 * genuinely the best price that exists — that is what the market is. If NO
 * token has ticked for `feedDeadAfterMs`, the feed is dead and everything is
 * absent. Per-token age is still tracked and reported, so a consumer can see
 * exactly how old a mark is, but it no longer hides the price.
 *
 * TWO CLOCKS, NOT ONE (audit F-15). "Feed-wide" means wide across the CONTRACT
 * feed. Spot arrives on its own topic from its own publisher, and it used to
 * bump the very same liveness clock — so one index spot still ticking made
 * every option mark look alive. That is not hypothetical: a chain
 * resubscription that fails after an expiry roll leaves every strike frozen at
 * yesterday's price while spot streams perfectly, and this cache would have
 * gone on pricing paper fills and every P&L on screen off those frozen quotes.
 * The two feeds fail INDEPENDENTLY, so they are judged independently:
 * `update()` bumps the token clock and `feedAlive()`/`mark()`/`price()`/
 * `quote()` read it; `updateSpot()` bumps the spot clock and `spot()` reads
 * that one. Neither can vouch for the other.
 */

import type { InstrumentRef } from '@algomaker/order-bus'
import type { DepthBook } from './chain.ts'
import type { MarkSource } from './contract.ts'

export interface QuoteCacheOptions {
  /**
   * No tick on ANY token for this long means the feed itself is dead, and every
   * price becomes absent. Must exceed the slowest instrument's natural tick gap
   * by a wide margin — BHEL's chain measured ~30s between ticks per contract,
   * but across a whole subscribed chain something ticks far more often.
   */
  readonly feedDeadAfterMs?: number
  /** Age past which a mark is REPORTED as stale. Does not hide the price. */
  readonly staleAfterMs?: number
  readonly now?: () => number
}

export interface Mark {
  readonly price: number
  readonly ageMs: number
  readonly stale: boolean
}

export interface Quote {
  readonly price: number
  readonly oi: number | null
  readonly volume: number | null
  /**
   * Best bid/ask from the tick this came from — both or neither (a one-sided
   * book prices nothing). When present, `price` IS their mid; they are exposed
   * anyway because "0.20 / 0.24" answers a question "0.22" cannot: how wide is
   * the market an order would actually cross.
   */
  readonly bid: number | null
  readonly ask: number | null
  /**
   * The book behind the touch, when the tick carried it. Stored verbatim from
   * the feed — see `chain.ts`'s `DepthBook` for the shape a client gets.
   */
  readonly depth?: DepthBook
  /** Epoch ms of the tick this came from. */
  readonly asOf: number
  readonly ageMs: number
  readonly stale: boolean
}

/**
 * A persisted snapshot of the last marks seen, for DISPLAY when the feed is
 * down (overnight, weekends, an outage).
 *
 * THE DISTINCTION THAT MATTERS, and the reason this is a separate path rather
 * than a longer staleness window:
 *
 *   DISPLAY may use last-known marks, clearly labelled. Wanting to see your
 *   book's delta at 9pm is legitimate, and a dashboard that shows nothing
 *   outside market hours is a dashboard nobody opens.
 *
 *   EXECUTION MUST NOT. Booking a fill at yesterday's close is precisely the
 *   frozen-price failure this whole design guards against. `price()` — the
 *   method `applyActions` calls — never falls back here.
 *
 * So the snapshot is reachable only through `displayMark()`, and everything it
 * returns carries `asOf` so the UI can say when it was true.
 */
export interface MarkSnapshot {
  readonly token: number
  readonly price: number
  readonly ts: number
  /** Last two-sided book frame, when the writer had one. Both or neither. */
  readonly bid?: number | null
  readonly ask?: number | null
  /** The frame's OWN time — it can be older than the last print's `ts`. */
  readonly bookTs?: number | null
}

/** The ORDER side that would close the leg being valued. */
export type ExitSide = 'Buy' | 'Sell'

export type MarkBasis = 'bid' | 'ask' | 'mid' | 'snapshot'

/**
 * A valuation read off the order book: what closing the leg would actually
 * fetch. LTP is never a basis here — see `exitQuote`.
 */
export interface ExitQuote {
  readonly price: number
  readonly basis: MarkBasis
  readonly bid: number
  readonly ask: number
  /** Epoch ms of the book frame this came from. */
  readonly asOf: number
  readonly ageMs: number
  readonly stale: boolean
}

function exitPick(
  bid: number,
  ask: number,
  exit: ExitSide | null,
): { price: number; basis: 'bid' | 'ask' | 'mid' } {
  if (exit === 'Sell') return { price: bid, basis: 'bid' }
  if (exit === 'Buy') return { price: ask, basis: 'ask' }
  return { price: (bid + ask) / 2, basis: 'mid' }
}

export class QuoteCache implements MarkSource {
  readonly #byToken = new Map<
    number,
    {
      price: number
      ts: number
      oi: number | null
      volume: number | null
      bid: number | null
      ask: number | null
      /**
       * The last TWO-SIDED frame, surviving LTP-only ticks: valuation prices
       * off the book, and a book that stopped is old, not gone. Its own `ts`
       * says how old.
       */
      book: { bid: number; ask: number; ts: number } | null
      depth?: DepthBook
    }
  >()
  readonly #spotByUnderlying = new Map<string, { price: number; ts: number }>()
  /** Last-known marks from persistence. DISPLAY ONLY — never used by price(). */
  readonly #snapshot = new Map<
    number,
    { price: number; ts: number; bid: number | null; ask: number | null; bookTs: number | null }
  >()
  readonly #feedDeadAfterMs: number
  readonly #staleAfterMs: number
  readonly #now: () => number
  /** Last CONTRACT tick, on any token. Never bumped by spot — see the header. */
  #lastAnyTickMs = 0
  /** Last SPOT tick, on any underlying. The other, independent clock. */
  #lastSpotTickMs = 0

  constructor(opts: QuoteCacheOptions = {}) {
    this.#feedDeadAfterMs = opts.feedDeadAfterMs ?? 120_000
    this.#staleAfterMs = opts.staleAfterMs ?? 60_000
    this.#now = opts.now ?? ((): number => Date.now())
  }

  /**
   * Called by the feed for every tick on a subscribed token.
   *
   * `oi`/`volume` are OPTIONAL and default to null rather than 0. Zero is a
   * real value on an illiquid strike, so defaulting to it would make "no
   * data" and "no interest" indistinguishable — and ΔOI would then read as a
   * real change.
   */
  update(
    token: number,
    price: number,
    ts?: number,
    extra?: {
      oi?: number | undefined
      volume?: number | undefined
      bid?: number | undefined
      ask?: number | undefined
      depth?: DepthBook | undefined
    },
  ): void {
    // Reject implausible prices at ingest rather than downstream. A zero or
    // negative mark is the shape the legacy `0.05` fill artefact took.
    if (!Number.isFinite(price) || price <= 0) return
    const at = ts ?? this.#now()
    // Both-or-neither, per tick: a one-sided book prices nothing, and keeping
    // a PREVIOUS tick's depth against a new LTP would blend two moments.
    const bid = extra?.bid
    const ask = extra?.ask
    const bothSides =
      typeof bid === 'number' && Number.isFinite(bid) && bid > 0 &&
      typeof ask === 'number' && Number.isFinite(ask) && ask > 0 && ask >= bid
    const prev = this.#byToken.get(token)
    this.#byToken.set(token, {
      price,
      ts: at,
      oi: Number.isFinite(extra?.oi) ? (extra?.oi as number) : null,
      volume: Number.isFinite(extra?.volume) ? (extra?.volume as number) : null,
      bid: bothSides ? bid : null,
      ask: bothSides ? ask : null,
      book: bothSides ? { bid: bid as number, ask: ask as number, ts: at } : (prev?.book ?? null),
      ...(extra?.depth === undefined ? {} : { depth: extra.depth }),
    })
    // Feed liveness is driven by ARRIVAL, not by the exchange timestamp on the
    // packet, so a broker replaying old timestamps cannot look alive.
    this.#lastAnyTickMs = this.#now()
  }

  /**
   * THE MARK IS THE MID when the tick carried a two-sided book, the LTP when
   * it did not. On an illiquid strike the last trade is a memory — TCS 2440PE
   * (2026-08-17) last printed at 14:20 while its 115.50/117.15 book moved
   * every second — and the depth is the market. Every read path shares this
   * one definition: greeks, paper fills, the chain the Python desk prices
   * off, marketable-limit pricing, the persisted snapshot.
   */
  #effective(e: { price: number; bid: number | null; ask: number | null }): number {
    return e.bid !== null && e.ask !== null ? (e.bid + e.ask) / 2 : e.price
  }

  updateSpot(underlying: string, price: number, ts?: number): void {
    if (!Number.isFinite(price) || price <= 0) return
    this.#spotByUnderlying.set(underlying, { price, ts: ts ?? this.#now() })
    // ITS OWN CLOCK. A spot publisher that survives an option-chain
    // resubscription failure must not be able to vouch for the strikes — see
    // the file header (audit F-15).
    this.#lastSpotTickMs = this.#now()
  }

  /**
   * Is the CONTRACT feed alive? False means every option price is
   * untrustworthy, regardless of what is cached.
   */
  feedAlive(): boolean {
    if (this.#lastAnyTickMs === 0) return false
    return this.#now() - this.#lastAnyTickMs <= this.#feedDeadAfterMs
  }

  /** Is the SPOT feed alive? Judged on spot ticks alone, for the same reason. */
  spotAlive(): boolean {
    if (this.#lastSpotTickMs === 0) return false
    return this.#now() - this.#lastSpotTickMs <= this.#feedDeadAfterMs
  }

  price(instrument: InstrumentRef): number | null {
    const token = instrument.instrumentToken
    if (token === undefined) return null
    return this.mark(token)?.price ?? null
  }

  spot(underlying: string): number | null {
    if (!this.spotAlive()) return null
    const e = this.#spotByUnderlying.get(underlying)
    return e === undefined ? null : e.price
  }

  /**
   * How old this contract's mark is, in ms — `null` when there is no usable
   * mark at all (never ticked, no token on the ref, or a dead contract feed).
   *
   * The optional half of `MarkSource`, for the ONE caller that must distinguish
   * "old but real" from "fresh": `applyActions`' ceiling on pricing NEW
   * exposure (audit F-16). Everything else deliberately keeps taking the price
   * regardless of age — a 90-second-old quote on a strike that trades twice a
   * minute IS the market, and refusing it books nothing all day.
   */
  markAge(instrument: InstrumentRef): number | null {
    const token = instrument.instrumentToken
    if (token === undefined) return null
    return this.mark(token)?.ageMs ?? null
  }

  /** Seed last-known marks from persistence. Display-only; see `MarkSnapshot`. */
  loadSnapshot(rows: Iterable<MarkSnapshot>): void {
    for (const r of rows) {
      if (!Number.isFinite(r.price) || r.price <= 0) continue
      // Both-or-neither, the same rule `update()` applies to a live frame.
      const paired =
        typeof r.bid === 'number' && Number.isFinite(r.bid) && r.bid > 0 &&
        typeof r.ask === 'number' && Number.isFinite(r.ask) && r.ask >= r.bid
      this.#snapshot.set(r.token, {
        price: r.price,
        ts: r.ts,
        bid: paired ? (r.bid as number) : null,
        ask: paired ? (r.ask as number) : null,
        bookTs: paired ? (typeof r.bookTs === 'number' && Number.isFinite(r.bookTs) ? r.bookTs : r.ts) : null,
      })
    }
  }

  /** Everything currently cached, for persisting. */
  snapshot(): MarkSnapshot[] {
    // The EFFECTIVE price, deliberately: this seeds displayMark after a
    // restart, and persisting the raw LTP would resurrect exactly the stale
    // print the mid exists to replace.
    const out: MarkSnapshot[] = []
    for (const [token, e] of this.#byToken) out.push({ token, price: this.#effective(e), ts: e.ts })
    return out
  }

  /**
   * A mark for DISPLAY, falling back to the persisted snapshot when the feed is
   * down. Never used by the order path — see `MarkSnapshot`.
   */
  displayMark(token: number): (Mark & { asOf: number; live: boolean }) | null {
    const live = this.mark(token)
    if (live !== null) return { ...live, asOf: this.#now() - live.ageMs, live: true }
    const inCache = this.#byToken.get(token)
    const cached = inCache ?? this.#snapshot.get(token)
    if (cached === undefined) return null
    return {
      price: inCache !== undefined ? this.#effective(inCache) : cached.price,
      ageMs: this.#now() - cached.ts,
      stale: true,
      asOf: cached.ts,
      live: false,
    }
  }

  /**
   * A full quote for DISPLAY, past the feed-dead gate and down to the persisted
   * snapshot — `displayMark`'s rule with `quote`'s shape. The closed-market
   * cockpit prices its chain off this: a payoff curve and a repair menu are
   * pictures, not orders, and outside the session the last session's prices are
   * the only honest ones there are. Everything carries `asOf` and `stale` so
   * the panel can say whose prices these are. The snapshot knows only a price
   * and a time, so depth/oi/volume come back null from it.
   */
  displayQuote(token: number): Quote | null {
    const e = this.#byToken.get(token)
    if (e !== undefined) {
      const ageMs = this.#now() - e.ts
      return {
        price: this.#effective(e),
        oi: e.oi,
        volume: e.volume,
        bid: e.bid,
        ask: e.ask,
        ...(e.depth === undefined ? {} : { depth: e.depth }),
        asOf: e.ts,
        ageMs,
        stale: ageMs > this.#staleAfterMs,
      }
    }
    const s = this.#snapshot.get(token)
    if (s === undefined) return null
    return {
      price: s.price,
      oi: null,
      volume: null,
      bid: null,
      ask: null,
      asOf: s.ts,
      ageMs: this.#now() - s.ts,
      stale: true,
    }
  }

  displaySpot(underlying: string, token: number | null): number | null {
    const live = this.spot(underlying)
    if (live !== null) return live
    const e = this.#spotByUnderlying.get(underlying)
    if (e !== undefined) return e.price
    return token === null ? null : (this.displayMark(token)?.price ?? null)
  }

  /**
   * The VALUATION read: the exit side of the last two-sided book frame.
   *
   * LTP NEVER SUBSTITUTES (operator directive 2026-08-21, after the BHEL +25k
   * display incident) — a contract whose book has never been seen is unpriced,
   * and the total goes incomplete the same way an unmarked leg always has.
   * `Sell` (closing a long) values at the bid, `Buy` (closing a short) at the
   * ask, no direction at the mid. Feed-gated exactly like `mark()`: a dead
   * feed prices nothing however full the cache is.
   */
  exitQuote(token: number, exit: ExitSide | null): ExitQuote | null {
    if (!this.feedAlive()) return null
    const book = this.#byToken.get(token)?.book
    if (book === undefined || book === null) return null
    const ageMs = this.#now() - book.ts
    const picked = exitPick(book.bid, book.ask, exit)
    return { ...picked, bid: book.bid, ask: book.ask, asOf: book.ts, ageMs, stale: ageMs > this.#staleAfterMs }
  }

  /**
   * `exitQuote`'s rule with `displayMark`'s forgiveness: past the feed gate
   * and down to the persisted pair. A snapshot row that never carried a pair
   * prices nothing here — display may be old, it may not be a last print.
   */
  displayExitQuote(token: number, exit: ExitSide | null): ExitQuote | null {
    const live = this.exitQuote(token, exit)
    if (live !== null) return live
    const held = this.#byToken.get(token)?.book ?? null
    const snap = this.#snapshot.get(token)
    const book =
      held ??
      (snap !== undefined && snap.bid !== null && snap.ask !== null
        ? { bid: snap.bid, ask: snap.ask, ts: snap.bookTs ?? snap.ts }
        : null)
    if (book === null) return null
    const picked = exitPick(book.bid, book.ask, exit)
    return {
      price: picked.price,
      basis: 'snapshot',
      bid: book.bid,
      ask: book.ask,
      asOf: book.ts,
      ageMs: this.#now() - book.ts,
      stale: true,
    }
  }

  /** The mark with its age, for reporting. Null only when genuinely unusable. */
  mark(token: number): Mark | null {
    if (!this.feedAlive()) return null
    const e = this.#byToken.get(token)
    if (e === undefined) return null
    const ageMs = this.#now() - e.ts
    return { price: this.#effective(e), ageMs, stale: ageMs > this.#staleAfterMs }
  }

  /**
   * A quote for the DECISION path: price plus the extras, with its own age.
   *
   * Refuses on a dead feed exactly as `mark()` does. `displayMark` is the
   * separate, deliberately more forgiving path for rendering.
   */
  quote(token: number): Quote | null {
    if (!this.feedAlive()) return null
    const e = this.#byToken.get(token)
    if (e === undefined) return null
    const ageMs = this.#now() - e.ts
    return {
      price: this.#effective(e),
      oi: e.oi,
      volume: e.volume,
      bid: e.bid,
      ask: e.ask,
      ...(e.depth === undefined ? {} : { depth: e.depth }),
      asOf: e.ts,
      ageMs,
      stale: ageMs > this.#staleAfterMs,
    }
  }

  /**
   * Marks that are actually USABLE right now.
   *
   * Zero when the feed is dead, even though the cache is still full. The cached
   * entries survive a dead feed but `mark()` correctly refuses to return them,
   * so counting them made the health panel advertise "73/73 marks held" beside
   * "Status DOWN" and eight unpriced legs — three true statements that together
   * read as nonsense.
   */
  get size(): number {
    return this.feedAlive() ? this.#byToken.size : 0
  }

  /** Cached entries regardless of feed health. Diagnostics only. */
  get cachedCount(): number {
    return this.#byToken.size
  }

  /** How many cached quotes are older than the stale threshold. */
  staleCount(): number {
    const now = this.#now()
    let n = 0
    for (const e of this.#byToken.values()) if (now - e.ts > this.#staleAfterMs) n++
    return n
  }

  /** Milliseconds since ANY token last ticked. Infinity before the first. */
  ageOfNewestTick(): number {
    return this.#lastAnyTickMs === 0 ? Number.POSITIVE_INFINITY : this.#now() - this.#lastAnyTickMs
  }
}

/**
 * A fixed mark source. For tests and for a dry run against a closed market,
 * where "no quotes" would otherwise make every action skip.
 */
export class StaticMarks implements MarkSource {
  readonly #prices: ReadonlyMap<string, number>
  readonly #spots: ReadonlyMap<string, number>

  constructor(prices: Record<string, number> = {}, spots: Record<string, number> = {}) {
    this.#prices = new Map(Object.entries(prices))
    this.#spots = new Map(Object.entries(spots))
  }

  price(instrument: InstrumentRef): number | null {
    return this.#prices.get(instrument.tradingsymbol) ?? null
  }

  spot(underlying: string): number | null {
    return this.#spots.get(underlying) ?? null
  }
}
