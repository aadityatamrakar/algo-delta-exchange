/**
 * Market context on the wire: daily and intraday bars, levels and the context
 * view — types only, so the page and the agent compile against them while
 * `market/history.ts`, `market/intraday.ts`, `analytics/levels.ts` and
 * `analytics/context.ts` are written. Spec:
 * docs/superpowers/specs/2026-10-23-traders-ai-desk-design.md §5.
 *
 * Every figure here is either computed from bars the app actually holds or
 * null with a warning saying why; a level is never invented to fill a gap.
 */

/** One trading day of an underlying, from data/nse/history/<YYYY-MM-DD>.json. Oldest → newest in every array. */
export interface DailyBar {
  readonly date: string
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  /** Shares. */
  readonly volume: number
  readonly futClose: number | null
  readonly futOi: number | null
  readonly ceOi: number | null
  readonly peOi: number | null
  /**
   * Decimal, the mean of the ATM CE and PE IVs solved from the day's closes, of the first expiry at least 7 calendar
   * days out (a fixed tenor: the series IV rank reads; vol addendum). A summary written before that field gives the
   * nearest expiry's. Null when either side did not trade or does not solve.
   */
  readonly atmIv: number | null
  readonly maxPain: number | null
}

/** One intraday bar. `t` is the bar's start, epoch ms. */
export interface Bar {
  readonly t: number
  readonly o: number
  readonly h: number
  readonly l: number
  readonly c: number
  readonly v: number
}

export type BarInterval = 'day' | '15m' | '5m'

/** 'nse' = the mean of NSE's CE and PE impliedVolatility at the ATM strike; 'bhavcopy' = solved (Black-76, the future) from closes. */
export type IvSource = 'nse' | 'bhavcopy'

/** IV(t) − RV(t → t+20) over the window's days, decimals. `days` = how many such pairs. */
export interface RealizedVrp {
  readonly mean: number
  readonly median: number
  /** 0–100: % of the pairs where IV exceeded the realized vol that followed. */
  readonly positivePct: number
  readonly days: number
}

export interface BarsView {
  readonly stock: string
  readonly interval: BarInterval
  /**
   * What the bars are of: the spot (cash), or the near future — an index's daily bars always (NSE's CM
   * bhavcopy has no index rows), intraday when asked or when it is the context's reference. Optional only
   * because it was added after the contract was cut (backward compatible); the route always sets it.
   */
  readonly of?: 'spot' | 'future'
  readonly bars: readonly Bar[]
  readonly warnings: readonly string[]
}

export type LevelKind =
  | 'prev-high'
  | 'prev-low'
  | 'prev-close'
  | 'pivot'
  | 'r1'
  | 'r2'
  | 'r3'
  | 's1'
  | 's2'
  | 's3'
  | 'swing-high'
  | 'swing-low'
  | '52w-high'
  | '52w-low'
  | 'sma20'
  | 'sma50'
  | 'sma200'
  | 'round'
  | 'oi-call-wall'
  | 'oi-put-wall'
  | 'max-pain'
  | 'day-high'
  | 'day-low'
  | 'vwap'
  | 'or-high'
  | 'or-low'

export interface Level {
  readonly price: number
  readonly kind: LevelKind
  readonly strength: 1 | 2 | 3
  /** (price − ref) / ref × 100, ref = the spot, or the near future when `MarketContext.reference` says so. */
  readonly distancePct: number
  /** What it rests on, e.g. "swing high, 20 bars". */
  readonly basis: string
}

export interface MarketContext {
  readonly stock: string
  readonly asOf: number
  readonly closed: boolean
  readonly feedAlive: boolean
  readonly stale: boolean
  /**
   * What `prevClose`, `changePct`, `day`, the daily bars and every level's distance are of: the spot, or for an
   * underlying NSE's bhavcopies give no cash OHLC for (an index) the near future. Optional only because it was
   * added after the contract was cut (backward compatible); `marketContextOf` always sets it.
   */
  readonly reference?: 'spot' | 'future'
  readonly spot: number | null
  readonly future: number | null
  readonly prevClose: number | null
  readonly changePct: number | null
  readonly day: {
    readonly open: number | null
    readonly high: number | null
    readonly low: number | null
    readonly vwap: number | null
    /** Opening range = the first 15 minutes. */
    readonly orHigh: number | null
    readonly orLow: number | null
  }
  readonly trend: {
    readonly label: 'up' | 'down' | 'range' | 'unknown'
    readonly sma20: number | null
    readonly sma50: number | null
    readonly sma200: number | null
    /** Decimal returns. */
    readonly ret5d: number | null
    readonly ret20d: number | null
    readonly basis: string
  }
  readonly vol: {
    /** Rupees. */
    readonly atr14: number | null
    /** Decimal, annualised close-to-close. */
    readonly hv10: number | null
    readonly hv20: number | null
    readonly atmIv: number | null
    /** 0–100; null under 60 days of IV history. */
    readonly ivRank: number | null
    readonly ivPercentile: number | null
    /** Decimal (atmIv − hv20). */
    readonly ivMinusHv20: number | null
    /** Days of IV history behind the rank. */
    readonly ivDays: number
    // Optional: the END-OF-DAY vol view (GET /vol, analytics/vol-metrics.ts, docs/superpowers/specs/
    // 2026-10-23-traders-vol-addendum.md), as of `volAsOf`. atmIv, ivRank and ivMinusHv20 above are the live ones.
    /** The trading day the fields below are as of. */
    readonly volAsOf?: string | null
    /** Where nearIv came from: NSE's option chain, or solved from the bhavcopy closes. */
    readonly ivSource?: IvSource | null
    /** Decimal, nearIv − hv20 at volAsOf (0.05 = 5 vol points). */
    readonly vrp?: number | null
    /** nearIv / hv20 at volAsOf. */
    readonly vrpRatio?: number | null
    /** 0–100: % of the last 252 days whose vrp was below volAsOf's; null under 60 days. */
    readonly vrpPercentile?: number | null
    /** IV(t) − the realized vol of t → t+20, over the last 252 days: has short premium been paid in this stock? */
    readonly realizedVrp?: RealizedVrp | null
    /** nearExpiry: the first expiry at least 7 calendar days out (the ranked tenor); next: the month after's last. ATM IVs, decimal. */
    readonly nearExpiry?: string | null
    readonly nearIv?: number | null
    readonly nextExpiry?: string | null
    readonly nextIv?: number | null
    /** Decimal, the near (ranked-tenor) expiry: 25-delta put IV − 25-delta call IV, solved from traded closes against the future. */
    readonly skew25?: number | null
    /** NSE's CMVOLT annualised volatility (EWMA λ 0.995, × √365), decimal — a cross-check for hv20. */
    readonly nseHv?: number | null
  }
  /**
   * The next results in NSE's calendar (risk spec R13), as `VolRow.results`: `inNear` = the ranked near IV (vol.nearExpiry,
   * else the first listed expiry a week or more out) includes them, so IV rank is event-inflated. Null = none known;
   * absent when the app has no results calendar wired.
   */
  readonly results?: { readonly date: string; readonly expiry: string | null; readonly inNear: boolean } | null
  readonly expectedMove: {
    readonly expiry: string | null
    readonly days: number | null
    /** Rupees either side of the future. */
    readonly oneSigma: number | null
    readonly twoSigma: number | null
  }
  readonly oi: {
    readonly expiry: string
    readonly pcr: number | null
    readonly maxPain: number | null
    readonly callWall: number | null
    readonly putWall: number | null
    /** The end-of-day file the OI comes from. */
    readonly day: string
  } | null
  /** Sorted by price, deduplicated within 0.25%, at most 24. */
  readonly levels: readonly Level[]
  readonly nearestSupport: Level | null
  readonly nearestResistance: Level | null
  readonly bars: { readonly daily: number; readonly intraday: number }
  readonly warnings: readonly string[]
}

// ------------------------------------------------------------------ GET /v1/traders/vol
// End-of-day volatility per held stock (docs/superpowers/specs/2026-10-23-traders-vol-addendum.md). Every figure is as
// of `asOf` (a trading day), decimal unless named otherwise, and null with a warning when the data behind it is short.

export interface VolMetrics {
  /** The trading day the figures are as of; null with no data at all. */
  readonly asOf: string | null
  /** Near-month ATM IV. */
  readonly iv: number | null
  readonly ivSource: IvSource | null
  /** 0–100 over the last 252 trading days; null under 60 days of IV. */
  readonly ivRank: number | null
  readonly ivPercentile: number | null
  /** Days with an IV in the window. */
  readonly ivDays: number
  /** Close-to-close, × √252. */
  readonly hv10: number | null
  readonly hv20: number | null
  /** NSE's CMVOLT annualised volatility (EWMA, × √365): a cross-check, not an input. */
  readonly nseHv: number | null
  /** iv − hv20 (0.05 = 5 vol points). */
  readonly vrp: number | null
  /** iv / hv20. */
  readonly vrpRatio: number | null
  readonly vrpPercentile: number | null
  readonly vrpDays: number
  readonly realizedVrp: RealizedVrp | null
  readonly nearExpiry: string | null
  readonly nearIv: number | null
  readonly nextExpiry: string | null
  readonly nextIv: number | null
  /** 25-delta put IV − 25-delta call IV, the near (ranked-tenor) expiry. */
  readonly skew25: number | null
  readonly warnings: readonly string[]
}

export interface VolRow extends VolMetrics {
  readonly stock: string
  /**
   * The stock's next results date (risk spec R13), held through or not: `expiry` = the first listed expiry on or after
   * it; `inNear` = the near IV ranked here includes it (date ≤ nearExpiry), so the page's cue is "event". Null = none
   * known; absent before the events store is wired.
   */
  readonly results?: { readonly date: string; readonly expiry: string | null; readonly inNear: boolean } | null
}

export interface VolView {
  /** When the view was built, epoch ms. */
  readonly asOf: number
  /** Whose held stocks: the trader, or null = every trader's (admin, no `?as=`). */
  readonly trader: string | null
  /** One row per held stock, by stock. */
  readonly rows: readonly VolRow[]
  readonly warnings: readonly string[]
}
