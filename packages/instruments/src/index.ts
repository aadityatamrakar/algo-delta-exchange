/**
 * InstrumentUniverse — underlyings as DATA.
 *
 * WHY: the legacy code hardcodes underlyings everywhere. Spot tokens (`260105`,
 * `256265`, `265`, `257801`, `288009`) and strike steps (50 / 100) are literals
 * scattered across ~150 files, so "add 5-10 stocks" means editing every file that
 * should trade them. Here an underlying is a record, and adding stocks becomes
 * config plus an instrument refresh.
 *
 * Stock options differ from index options in ways that MUST be per-symbol rather
 * than assumed: strike steps vary with price level (a Rs.200 stock and a Rs.3000
 * stock do not share a step), lot sizes vary per contract and are revised by the
 * exchange, and liquidity is far thinner — which is why chase execution exists.
 */

export type UnderlyingKind = 'index' | 'stock'

export interface Underlying {
  readonly symbol: string
  readonly kind: UnderlyingKind
  /** Kite instrument token for the spot/index price. */
  readonly spotToken: number
  /** Strike interval for the option chain. */
  readonly strikeStep: number
  /** Contract multiplier for options on this underlying. */
  readonly lotSize: number
  readonly tickSize: number
  /** Exchange for the DERIVATIVES (NFO for NSE names, BFO for SENSEX). */
  readonly derivativeExchange: 'NFO' | 'BFO'
  /** Exchange for the spot instrument. */
  readonly spotExchange: 'NSE' | 'BSE' | 'INDICES'
  /** Weekly expiry weekday (0=Sun..6=Sat), or null when only monthlies list. */
  readonly weeklyExpiryDay: number | null
  /** False for underlyings without a futures contract. */
  readonly hasFutures: boolean
}

/**
 * Index underlyings, with the tokens verified against the legacy code.
 *
 * NOTE on BANKNIFTY: weekly expiries were withdrawn in Nov 2024, so its nearest
 * expiry is the monthly. `weeklyExpiryDay: null` records that — the legacy
 * `bn-breakout.js:92` comment notes the same thing.
 *
 * NOTE on lot sizes: these change by exchange circular. They are defaults for
 * bootstrapping only; the live value must come from the instrument dump. Treating
 * a stale lot size as authoritative silently mis-sizes every order.
 */
export const INDEX_UNDERLYINGS: readonly Underlying[] = [
  {
    symbol: 'NIFTY',
    kind: 'index',
    spotToken: 256265,
    strikeStep: 50,
    lotSize: 75,
    tickSize: 0.05,
    derivativeExchange: 'NFO',
    spotExchange: 'INDICES',
    weeklyExpiryDay: 4, // Thursday
    hasFutures: true,
  },
  {
    symbol: 'BANKNIFTY',
    kind: 'index',
    spotToken: 260105,
    strikeStep: 100,
    lotSize: 35,
    tickSize: 0.05,
    derivativeExchange: 'NFO',
    spotExchange: 'INDICES',
    weeklyExpiryDay: null, // weeklies withdrawn Nov 2024 -> monthly only
    hasFutures: true,
  },
  {
    symbol: 'SENSEX',
    kind: 'index',
    spotToken: 265,
    strikeStep: 100,
    lotSize: 20,
    tickSize: 0.05,
    derivativeExchange: 'BFO',
    spotExchange: 'BSE',
    weeklyExpiryDay: 5, // Friday
    hasFutures: true,
  },
  {
    symbol: 'FINNIFTY',
    kind: 'index',
    spotToken: 257801,
    strikeStep: 50,
    lotSize: 65,
    tickSize: 0.05,
    derivativeExchange: 'NFO',
    spotExchange: 'INDICES',
    weeklyExpiryDay: null,
    hasFutures: true,
  },
  {
    symbol: 'MIDCPNIFTY',
    kind: 'index',
    spotToken: 288009,
    strikeStep: 50,
    lotSize: 140,
    tickSize: 0.05,
    derivativeExchange: 'NFO',
    spotExchange: 'INDICES',
    weeklyExpiryDay: null,
    hasFutures: true,
  },
]

export class InstrumentUniverse {
  readonly #bySymbol = new Map<string, Underlying>()

  constructor(underlyings: readonly Underlying[] = INDEX_UNDERLYINGS) {
    for (const u of underlyings) this.add(u)
  }

  add(u: Underlying): void {
    if (u.strikeStep <= 0) throw new Error(`${u.symbol}: strikeStep must be > 0`)
    if (u.lotSize <= 0) throw new Error(`${u.symbol}: lotSize must be > 0`)
    if (!Number.isFinite(u.spotToken) || u.spotToken <= 0) {
      throw new Error(`${u.symbol}: spotToken must be a positive number`)
    }
    this.#bySymbol.set(u.symbol, u)
  }

  get(symbol: string): Underlying | undefined {
    return this.#bySymbol.get(symbol)
  }

  /** Throwing accessor for call sites where absence is a programming error. */
  require(symbol: string): Underlying {
    const u = this.#bySymbol.get(symbol)
    if (u === undefined) {
      throw new Error(
        `unknown underlying '${symbol}'. Known: ${[...this.#bySymbol.keys()].join(', ')}`,
      )
    }
    return u
  }

  get symbols(): readonly string[] {
    return [...this.#bySymbol.keys()]
  }

  filter(kind: UnderlyingKind): readonly Underlying[] {
    return [...this.#bySymbol.values()].filter((u) => u.kind === kind)
  }

  /** ATM strike for a spot price, on this underlying's strike grid. */
  atmStrike(symbol: string, spotPrice: number): number {
    const u = this.require(symbol)
    return Math.round(spotPrice / u.strikeStep) * u.strikeStep
  }

  /**
   * A symmetric window of strikes around ATM.
   *
   * This is what keeps the subscription count sane. Subscribing to a whole option
   * chain per strategy is what produced ~50,000 token-subscriptions across ~150
   * processes; a +/-N strike window around ATM per underlying is a few hundred.
   */
  strikeWindow(symbol: string, spotPrice: number, widthEachSide: number): number[] {
    const u = this.require(symbol)
    const atm = this.atmStrike(symbol, spotPrice)
    const out: number[] = []
    for (let i = -widthEachSide; i <= widthEachSide; i++) {
      const strike = atm + i * u.strikeStep
      if (strike > 0) out.push(strike)
    }
    return out
  }
}

/**
 * Helper for defining a stock underlying, so adding one is a single call.
 * Strike step is required rather than guessed from price: NSE step schedules are
 * not a simple function of price level, and a wrong step silently produces
 * option symbols that do not exist.
 */
export function defineStock(params: {
  symbol: string
  spotToken: number
  strikeStep: number
  lotSize: number
  hasFutures?: boolean
}): Underlying {
  return {
    symbol: params.symbol,
    kind: 'stock',
    spotToken: params.spotToken,
    strikeStep: params.strikeStep,
    lotSize: params.lotSize,
    tickSize: 0.05,
    derivativeExchange: 'NFO',
    spotExchange: 'NSE',
    weeklyExpiryDay: null, // single-stock options are monthly-only
    hasFutures: params.hasFutures ?? true,
  }
}

export * from './master.ts'

export * from './freeze.ts'
