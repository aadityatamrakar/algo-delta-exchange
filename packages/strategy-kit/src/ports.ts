/**
 * The ports a strategy talks to. EVERY one is injected.
 *
 * This is the single most important design decision in the rewrite. In the legacy
 * system a strategy reached out and grabbed what it needed: it called
 * `require('../server.js')` for `app.models`, constructed its own `KiteTicker`,
 * called `moment()` inline for the time, and invoked `Account.placeAllAccount`
 * directly. Consequences, all measured:
 *
 *   - 150 of 156 files booted an entire LoopBack app to reach the database
 *   - 147 of 156 opened their own Kite websocket
 *   - nothing could be replayed, because time and market data were ambient
 *
 * With ports, the SAME strategy class runs against a live feed or a recorded
 * replay depending only on what it is constructed with. That is what makes
 * golden-master port verification possible — proving a ported strategy emits the
 * same orders as the legacy file it replaces.
 *
 * NOTE: this is NOT a backtester. A research / P&L backtesting tool was
 * explicitly declined by the owner on 2026-07-25. Replay exists solely to verify
 * ports, and the scope should not be widened without a new decision.
 */

import type { Clock } from '@algomaker/core'
import type { Destination, ExecMode, InstrumentRef, OrderIntent, OrderType, Side } from '@algomaker/order-bus'
// `selector.ts` is the AUTHORITY on what a selection request and a selection
// answer look like; re-declaring the shapes here would let the port and the
// implementation drift, and a drifting selector is how `otmSelector` came to
// return 0 at 87 of 93 call sites. marketdata-core sits UNDER strategy-kit, so
// this import direction is the allowed one.
import type { SelectCriteria, Selection, OptionType } from '@algomaker/marketdata-core'

export type { Clock, SelectCriteria, Selection, OptionType }

export interface Quote {
  readonly token: number
  readonly lastPrice: number
  readonly ts: number
  readonly bid?: number
  readonly ask?: number
  readonly volume?: number
  readonly oi?: number
  /**
   * The exchange's day-open (Kite full-mode ticks carry this under
   * `ohlc.open`). C2: this is the ONLY faithful source for "day open" — it
   * must never be approximated by the first tick a strategy happens to
   * observe, which depends on when the process booted and can silently flip
   * a direction-from-open decision to its opposite.
   */
  readonly ohlc?: { readonly open: number }
}

export interface Candle {
  readonly ts: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume?: number
}

export type Interval = '1minute' | '3minute' | '5minute' | '15minute' | '60minute' | 'day'

/** What a strategy declares it needs. The service dedups across all strategies. */
export interface DataNeed {
  /**
   * `'candles'` declares a warm BAR SERIES, not an instrument subscription.
   *
   * Without it the host has to guess which intervals to keep warm — and it did:
   * `apps/runner/src/market-data.ts` hardcoded `WARM_INTERVALS = ['5minute',
   * '60minute']`, which happens to cover ATR_BAND_NIFTY's two timeframes and
   * nothing else. Any other interval a strategy declared would read an empty
   * series and silently do nothing, which is the failure mode this whole package
   * exists to design out. The design spec §4g example is written against this
   * kind and did not typecheck before it existed.
   */
  readonly kind: 'index' | 'stock' | 'option-chain' | 'future' | 'candles'
  readonly underlying: string
  /** For option chains: how many strikes each side of ATM to keep subscribed. */
  readonly strikeWindow?: number
  readonly mode?: 'ltp' | 'quote' | 'full'
  /** Bar size for `kind: 'candles'`. Ignored by every other kind. */
  readonly interval?: Interval
}

/**
 * Market data port. Read-only: a strategy can never subscribe or unsubscribe
 * itself, which is what keeps the subscription set centrally deduplicated.
 */
export interface MarketData {
  /** Latest quote for a token, or null if nothing has arrived yet. */
  quote(token: number): Quote | null
  /**
   * Completed candles, oldest -> newest. Only COMPLETED candles are returned,
   * matching the legacy `historyData` assumption that strategies read
   * `candles[candles.length - 1]` as the last closed bar.
   */
  candles(token: number, interval: Interval, count: number): Promise<readonly Candle[]>
  /** Resolve an option instrument. Returns null when the strike is not listed. */
  option(underlying: string, strike: number, type: 'CE' | 'PE'): InstrumentRef | null
  /**
   * Pick a contract off the LISTED grid: ATM, N listed strikes away, closest
   * |delta|, or closest premium.
   *
   * On the port, not merely available inside the market-data implementation,
   * because a selector no strategy can call is a selector that does not exist.
   * `marketdata-core/src/selector.ts` was fully implemented and tested and had
   * exactly zero reachable callers; meanwhile `atmStrike()` below still hands
   * back a sentinel, which is the same defect wearing a different hat.
   *
   * Returns `null` — never a fallback — when the request cannot be answered: no
   * chain, no listed strike at that offset, no mark to back a delta out of, or a
   * strike that lists on one side only. That null IS the feature. `otmSelector`
   * returned a plausible `0` at 87 of 93 call sites, so strategies documented as
   * OTM sellers sold ATM for years without anything looking wrong.
   *
   * `expiry` is explicit ('YYYY-MM-DD') rather than implied: "nearest" is a
   * decision with a roll date attached, and a port that silently picks one for
   * you is how a book rolls a day early and nobody can say which code did it.
   */
  selectOption(underlying: string, expiry: string, criteria: SelectCriteria): Selection | null
  /** Nearest-expiry future for an underlying. */
  future(underlying: string): InstrumentRef | null
  /** ATM strike on the underlying's grid. */
  atmStrike(underlying: string, spotPrice: number): number
  /** Spot token for an underlying. */
  spotToken(underlying: string): number
}

export interface SubmitRequest {
  readonly instrument: InstrumentRef
  readonly side: Side
  readonly lots: number
  readonly orderType?: OrderType
  readonly limitPrice?: number
  readonly triggerPrice?: number
  readonly referencePrice?: number
  /** Marks an exit so risk limits do not block closing a position. */
  readonly reducesExposure?: boolean
  readonly meta?: Readonly<Record<string, string | number | boolean>>
}

export interface SubmitResult {
  readonly accepted: boolean
  readonly clientOrderId: string | null
  readonly reason?: string
}

/**
 * Order port. A strategy expresses intent; mode/destinations/risk are applied by
 * the gateway, NOT chosen by the strategy. This is deliberate: it is how a
 * misconfigured strategy is prevented from reaching a live broker, and it removes
 * the legacy ambiguity where whether real money moved depended on which daemon
 * happened to be running.
 */
export interface OrderGateway {
  submit(req: SubmitRequest): Promise<SubmitResult>
  cancel(clientOrderId: string): Promise<boolean>
  /** Flatten everything this strategy holds. Used by EOD and the kill switch. */
  flattenAll(reason: string): Promise<void>
}

export interface Fill {
  readonly clientOrderId: string
  readonly instrument: InstrumentRef
  readonly side: Side
  readonly filledQty: number
  readonly avgPrice: number
  readonly ts: number
}

/** Fill notifications. Under replay these are synthesised from recorded orders. */
export interface FillStream {
  onFill(handler: (fill: Fill) => void): () => void
}

/**
 * Durable per-strategy state.
 *
 * The legacy system kept positions in process memory, so a mid-session pm2
 * restart lost them — its own conventions note that an open position cannot be
 * restored. Anything a strategy must survive a restart with goes here.
 */
export interface StateStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
}

/**
 * Whether market data is currently trustworthy.
 *
 * The dangerous failure is not a disconnect — that is loud. It is a socket that
 * stays OPEN while ticks stop, which looks healthy while every strategy decides
 * on frozen prices. `marketdata` owns the detection; strategies only ask.
 */
export interface FeedHealthPort {
  isTrustworthy(): boolean
  /** Human-readable reason when untrustworthy, else null. */
  reason(): string | null
}

/** Everything a strategy is constructed with. */
export interface StrategyContext {
  readonly tag: string
  readonly clock: Clock
  readonly md: MarketData
  readonly orders: OrderGateway
  readonly fills: FillStream
  readonly state: StateStore
  readonly log: Logger
  readonly mode: ExecMode
  readonly destinations: readonly Destination[]
  readonly feed: FeedHealthPort
}

export type { OrderIntent, InstrumentRef, Side, OrderType, ExecMode, Destination }
