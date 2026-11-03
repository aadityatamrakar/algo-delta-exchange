/**
 * OptionMaster — contract resolution from the exchange instrument dump.
 *
 * WHY this exists separately from `InstrumentUniverse`: that file models the ~5
 * INDEX underlyings as hand-maintained records, which is fine when there are five
 * of them and their strike steps never change. It does not survive stock options:
 *
 *   - Strike steps vary per name AND per price level. A Rs.200 stock and a
 *     Rs.3000 stock do not share a grid, and NSE's step schedule is not a
 *     function of price you can compute. Here the step is INFERRED from the
 *     strikes actually listed, so it is right by construction.
 *   - Lot sizes are revised by exchange circular. `books/KALYANKJIL.json` on the
 *     Python side hardcodes `lot_size: 1350`; the day that is revised, every
 *     order is mis-sized by a silent multiple. The dump is the only honest source.
 *   - Stock options are MONTHLY. The index path (`optionConfig`'s
 *     `weeklyExpiry`) has no answer for them.
 *
 * Input is the raw instrument dump — `instruments.csv` columns verbatim, which is
 * also the shape of the Mongo `instrument` collection that `xtsOrder.js:288`
 * already loads. Pure and synchronous: no Mongo, no network, so contract
 * resolution is testable without either.
 */

import type { InstrumentRef } from '@algomaker/order-bus'

/** One row of the exchange dump. Field names are the dump's own, not ours. */
export interface InstrumentRow {
  readonly instrument_token: number
  readonly tradingsymbol: string
  /** The UNDERLYING symbol, e.g. 'KALYANKJIL' — not the contract symbol. */
  readonly name: string
  /** 'YYYY-MM-DD', or '' for cash instruments. */
  readonly expiry: string
  readonly strike: number
  readonly tick_size: number
  readonly lot_size: number
  readonly instrument_type: string
  readonly segment: string
  readonly exchange: string
}

export type OptionType = 'CE' | 'PE'

const isOption = (r: InstrumentRow): boolean =>
  r.instrument_type === 'CE' || r.instrument_type === 'PE'

const isFuture = (r: InstrumentRow): boolean => r.instrument_type === 'FUT'

/**
 * The cash/index instrument carrying SPOT.
 *
 * Stocks list as `EQ` on NSE; indices list under an INDICES segment. Both are
 * matched because both are the spot leg of their own option chain.
 */
const isSpot = (r: InstrumentRow): boolean =>
  r.instrument_type === 'EQ' || r.segment.toUpperCase().includes('INDICES')

/**
 * Should `candidate` replace `existing` as the spot row under some key?
 *
 * A symbol can list a cash row on BOTH exchanges — ITC is NSE 424961 and BSE
 * 128224004 — and without a rule the winner is whichever the dump happened to
 * yield last, i.e. spot silently depends on file ordering. The desk trades NFO,
 * so the NSE cash row is the right forward reference. Otherwise first seen wins.
 */
const betterSpot = (existing: InstrumentRow | undefined, candidate: InstrumentRow): boolean =>
  existing === undefined ||
  (candidate.exchange.toUpperCase() === 'NSE' && existing.exchange.toUpperCase() !== 'NSE')

/**
 * Canonical underlying -> index spot token.
 *
 * Indices need this because their derivative underlying and their spot row have
 * DIFFERENT NAMES in the dump: options list under `NIFTY`, but the index itself
 * is `tradingsymbol="NIFTY 50", name="NIFTY 50"` (256265); `BANKNIFTY` options
 * against `"NIFTY BANK"` (260105). Name matching therefore finds nothing, which
 * is why only SENSEX resolved — it is the one case where both happen to read
 * `SENSEX`.
 *
 * The token is the stable key, and these are the values the legacy strategies
 * hardcoded and traded on for years (`INDEX_UNDERLYINGS` in ./index.ts).
 * Stocks need none of this: `BHEL` options and the `BHEL` EQ row already agree.
 */
export const INDEX_SPOT_TOKENS: Readonly<Record<string, number>> = {
  NIFTY: 256265,
  BANKNIFTY: 260105,
  SENSEX: 265,
  FINNIFTY: 257801,
  MIDCPNIFTY: 288009,
}

/** Reverse lookup: spot token -> canonical underlying. */
const SPOT_TOKEN_TO_UNDERLYING: ReadonlyMap<number, string> = new Map(
  Object.entries(INDEX_SPOT_TOKENS).map(([symbol, token]) => [token, symbol]),
)

/**
 * Most common positive gap between consecutive sorted strikes.
 *
 * The MODE, deliberately, not the min or the mean. Real chains carry stray
 * strikes from a past price regime (a stock that halved still lists the old
 * wide-grid strikes), so the minimum gap under-reports and the mean lands
 * between grids. The mode is what the exchange is currently listing on.
 */
export function inferStrikeStep(strikes: readonly number[]): number | null {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b)
  if (sorted.length < 2) return null
  const counts = new Map<number, number>()
  for (let i = 1; i < sorted.length; i++) {
    const gap = Number(((sorted[i] as number) - (sorted[i - 1] as number)).toFixed(4))
    if (gap <= 0) continue
    counts.set(gap, (counts.get(gap) ?? 0) + 1)
  }
  let best: number | null = null
  let bestCount = 0
  for (const [gap, n] of counts) {
    // Ties break to the SMALLER gap: listing a finer grid is the newer state.
    if (n > bestCount || (n === bestCount && best !== null && gap < best)) {
      best = gap
      bestCount = n
    }
  }
  return best
}

interface ChainKey {
  readonly underlying: string
  readonly expiry: string
}

const chainKeyOf = (k: ChainKey): string => `${k.underlying}|${k.expiry}`
const contractKeyOf = (k: ChainKey, strike: number, type: OptionType): string =>
  `${chainKeyOf(k)}|${strike}|${type}`

export interface ChainMeta {
  readonly underlying: string
  readonly expiry: string
  readonly lotSize: number
  readonly tickSize: number
  readonly exchange: string
  /** Inferred from the listed strikes; null when fewer than 2 strikes list. */
  readonly strikeStep: number | null
  readonly strikes: readonly number[]
}

/**
 * Indexed view over an instrument dump.
 *
 * Built once per dump refresh; every lookup is a Map hit. Rows that are neither
 * options nor futures are ignored rather than rejected — the dump carries every
 * segment (BCD, MCX, cash) and none of it is an error, just not ours.
 */
export class OptionMaster {
  readonly #options = new Map<string, InstrumentRow>()
  readonly #futures = new Map<string, InstrumentRow[]>()
  readonly #chains = new Map<string, { rows: InstrumentRow[]; strikes: Set<number> }>()
  readonly #expiriesByUnderlying = new Map<string, Set<string>>()
  readonly #stepCache = new Map<string, number | null>()
  /** underlying -> its cash/index instrument, the source of SPOT. */
  readonly #spot = new Map<string, InstrumentRow>()
  /**
   * EXCHANGE token -> the row, for the one join the BROKER can be read through.
   *
   * Zerodha PACKS its token: `instrument_token = exchange_token * 256 + segment`
   * (TCS26AUG2460CE is 39397890 = 153898*256 + 2). XTS speaks the unpacked half
   * — `exchangeInstrumentID` — which is why `apps/order-gateway/src/main.ts`
   * divides by 256 before placing an order, and why an XTS position row can be
   * turned back into the tradingsymbol every desk record uses only through this
   * index. THE PACKED TOKEN CANNOT BE REBUILT BY MULTIPLYING: the segment byte
   * is not in what XTS sends, so the index is keyed by the DIVIDED token and the
   * multiplication never happens.
   */
  readonly #byExchangeToken = new Map<number, InstrumentRow>()
  /**
   * Exchange tokens that name more than one contract in this dump.
   *
   * Two segments can reuse one exchange token (the packed token is what makes
   * them distinct), and the reply XTS sends does not always say which segment it
   * meant. An ambiguous key therefore resolves to NOTHING rather than to
   * whichever row was read first — a wrong contract on a positions comparison is
   * a divergence reported against a leg nobody holds.
   */
  readonly #ambiguousExchangeTokens = new Set<number>()

  /**
   * Tradingsymbol -> row, options and futures kept APART.
   *
   * Two maps rather than one because `#rowForSymbol` answers options first and
   * futures only as a fallback, and `expiryOf` must see options ONLY. Merging
   * them would need a per-row type check on every hit to keep both promises,
   * which is the cost this index exists to remove. First write wins, matching
   * the first-match-wins scan these replaced.
   */
  readonly #optionsBySymbol = new Map<string, InstrumentRow>()
  readonly #futuresBySymbol = new Map<string, InstrumentRow>()

  constructor(rows: Iterable<InstrumentRow>) {
    for (const r of rows) {
      // The spot instrument. Greeks need a spot price and there is nowhere else
      // to get one for a stock underlying; without this every leg is unpriceable.
      if (isSpot(r)) {
        // Key under its own name (stocks: 'BHEL' EQ serves 'BHEL' options)...
        const nameKey = r.name === '' ? r.tradingsymbol : r.name
        if (betterSpot(this.#spot.get(nameKey), r)) this.#spot.set(nameKey, r)
        // ...AND under its TRADINGSYMBOL, because a cash row's `name` is the
        // COMPANY name while its options list under the SYMBOL: Bajaj Finance
        // is `tradingsymbol=BAJFINANCE, name="BAJAJ FINANCE"`, so name-keying
        // alone left spot('BAJFINANCE') null and every greek uncomputable.
        // This is the same divergence the index map below fixes, generalised —
        // for a cash row the tradingsymbol IS the underlying, so no list is
        // needed. Stocks whose name already equals their symbol (BHEL, ITC,
        // DLF) simply write the same key twice.
        if (r.tradingsymbol !== '' && betterSpot(this.#spot.get(r.tradingsymbol), r)) {
          this.#spot.set(r.tradingsymbol, r)
        }
        // ...AND under the canonical underlying when this is a known index
        // spot, because there the two names differ. Both keys point at the same
        // row, so 'NIFTY 50' and 'NIFTY' resolve identically. Unconditional and
        // last: an exact token match is the strongest signal there is.
        const canonical = SPOT_TOKEN_TO_UNDERLYING.get(r.instrument_token)
        if (canonical !== undefined) this.#spot.set(canonical, r)
        this.#indexExchangeToken(r)
        continue
      }
      if (isFuture(r)) {
        const list = this.#futures.get(r.name)
        if (list === undefined) this.#futures.set(r.name, [r])
        else list.push(r)
        if (r.tradingsymbol !== '' && !this.#futuresBySymbol.has(r.tradingsymbol)) {
          this.#futuresBySymbol.set(r.tradingsymbol, r)
        }
        this.#indexExchangeToken(r)
        continue
      }
      if (!isOption(r)) continue
      if (r.expiry === '') continue
      this.#indexExchangeToken(r)

      const key: ChainKey = { underlying: r.name, expiry: r.expiry }
      this.#options.set(contractKeyOf(key, r.strike, r.instrument_type as OptionType), r)
      if (r.tradingsymbol !== '' && !this.#optionsBySymbol.has(r.tradingsymbol)) {
        this.#optionsBySymbol.set(r.tradingsymbol, r)
      }

      const ck = chainKeyOf(key)
      let chain = this.#chains.get(ck)
      if (chain === undefined) {
        chain = { rows: [], strikes: new Set() }
        this.#chains.set(ck, chain)
      }
      chain.rows.push(r)
      chain.strikes.add(r.strike)

      let exps = this.#expiriesByUnderlying.get(r.name)
      if (exps === undefined) {
        exps = new Set()
        this.#expiriesByUnderlying.set(r.name, exps)
      }
      exps.add(r.expiry)
    }
    for (const list of this.#futures.values()) list.sort((a, b) => a.expiry.localeCompare(b.expiry))
  }

  /** Every underlying with a listed option chain, sorted. */
  underlyings(): readonly string[] {
    return [...this.#expiriesByUnderlying.keys()].sort()
  }

  /** Listed option expiries for an underlying, ascending. */
  expiries(underlying: string): readonly string[] {
    return [...(this.#expiriesByUnderlying.get(underlying) ?? [])].sort()
  }

  /**
   * First expiry on or after `onOrAfter` ('YYYY-MM-DD').
   *
   * Uses >= rather than >: an expiry-day contract is still tradable that day, and
   * excluding it would silently roll a book a day early.
   */
  nearestExpiry(underlying: string, onOrAfter: string): string | null {
    for (const e of this.expiries(underlying)) if (e >= onOrAfter) return e
    return null
  }

  strikes(underlying: string, expiry: string): readonly number[] {
    const chain = this.#chains.get(chainKeyOf({ underlying, expiry }))
    if (chain === undefined) return []
    return [...chain.strikes].sort((a, b) => a - b)
  }

  /** Inferred strike grid for one chain. Memoised — the dump does not change. */
  strikeStep(underlying: string, expiry: string): number | null {
    const ck = chainKeyOf({ underlying, expiry })
    const cached = this.#stepCache.get(ck)
    if (cached !== undefined) return cached
    const step = inferStrikeStep(this.strikes(underlying, expiry))
    this.#stepCache.set(ck, step)
    return step
  }

  /**
   * ATM strike on the chain's own grid.
   *
   * Snaps to a strike that is actually LISTED rather than to an arithmetic grid
   * point. Rounding to `round(spot/step)*step` produces a phantom strike whenever
   * the chain is asymmetric or has gaps — the C4 class of defect, where an order
   * is placed for a contract that does not exist.
   */
  atmStrike(underlying: string, expiry: string, spot: number): number | null {
    const strikes = this.strikes(underlying, expiry)
    if (strikes.length === 0) return null
    let best = strikes[0] as number
    let bestDist = Math.abs(best - spot)
    for (const s of strikes) {
      const d = Math.abs(s - spot)
      if (d < bestDist) {
        best = s
        bestDist = d
      }
    }
    return best
  }

  chain(underlying: string, expiry: string): ChainMeta | null {
    const chain = this.#chains.get(chainKeyOf({ underlying, expiry }))
    if (chain === undefined || chain.rows.length === 0) return null
    const first = chain.rows[0] as InstrumentRow
    return {
      underlying,
      expiry,
      lotSize: first.lot_size,
      tickSize: first.tick_size,
      exchange: first.exchange,
      strikeStep: this.strikeStep(underlying, expiry),
      strikes: this.strikes(underlying, expiry),
    }
  }

  /**
   * Resolve one option contract. Returns null when the strike is NOT listed.
   *
   * Null is the whole point: a caller must never fabricate a contract from
   * `underlying + strike + type` string concatenation. That is how the C4 phantom
   * PE and the legacy `0.05` fills happened.
   */
  resolve(
    underlying: string,
    expiry: string,
    strike: number,
    type: OptionType,
  ): InstrumentRef | null {
    const row = this.#options.get(contractKeyOf({ underlying, expiry }, strike, type))
    if (row === undefined) return null
    return toRef(row)
  }

  /**
   * Record one row under the exchange token XTS would name it by.
   *
   * A key that two different contracts want is REMOVED rather than
   * first-wins-or-last-wins: see `#ambiguousExchangeTokens`.
   */
  #indexExchangeToken(r: InstrumentRow): void {
    const token = exchangeTokenOf(r.instrument_token)
    if (token === null) return
    const seen = this.#byExchangeToken.get(token)
    if (seen === undefined) {
      this.#byExchangeToken.set(token, r)
      return
    }
    if (seen.instrument_token === r.instrument_token) return
    this.#ambiguousExchangeTokens.add(token)
  }

  /**
   * Resolve by the EXCHANGE token — the only identifier the broker and the desk
   * both hold.
   *
   * This is the join `apps/api/src/positions-compare.ts` uses to read an XTS
   * position row back into the tradingsymbol every desk record is written in.
   * The two systems spell the contract differently — `BHEL26AUG415CE` here,
   * `BHEL 25AUG2026 CE 415` there — and matching those strings, or parsing
   * either of them into the other, is the string fabrication that produced the
   * C4 phantom PE. The number is the same on both sides; the names are not.
   *
   * NULL FOR AN AMBIGUOUS TOKEN AS WELL AS AN ABSENT ONE. Both mean "this dump
   * does not name one contract for that number", and a caller that must not
   * guess needs only that answer.
   */
  resolveExchangeToken(exchangeToken: number): InstrumentRef | null {
    if (!Number.isFinite(exchangeToken) || this.#ambiguousExchangeTokens.has(exchangeToken)) {
      return null
    }
    const row = this.#byExchangeToken.get(exchangeToken)
    return row === undefined ? null : toRef(row)
  }

  /** Resolve by exchange tradingsymbol — the shape the Python book already speaks. */
  resolveSymbol(tradingsymbol: string): InstrumentRef | null {
    const row = this.#rowForSymbol(tradingsymbol)
    return row === null ? null : toRef(row)
  }

  /**
   * The listed expiry ('YYYY-MM-DD') of one contract, or null when this dump
   * does not carry it.
   *
   * A NARROW question on purpose. `InstrumentRef` is the routing shape shared
   * by every rail, journal and book record, and none of them need an expiry —
   * widening it would touch all of them for the ONE caller that does:
   * `submit.ts`'s expiry-day marketable buffer, which must know whether the
   * contract it is pricing dies today. Null means "not this dump's contract"
   * (a fallback instrument the master never synced), and the caller treats
   * that as NOT expiring — the base buffer, never the wide one on a guess.
   */
  expiryOf(tradingsymbol: string): string | null {
    /**
     * OPTIONS ONLY, deliberately. The one caller widens a marketable-limit
     * buffer on the contract's last day, and its rationale is a PREMIUM price
     * collapsing on expiry. A future expiring today trades at full notional —
     * 10% of that is not a buffer, it is a different order — so a futures
     * symbol answers null here and keeps the base buffer.
     */
    return this.#optionsBySymbol.get(tradingsymbol)?.expiry ?? null
  }

  /** The dump row behind a tradingsymbol — options first, then futures. */
  #rowForSymbol(tradingsymbol: string): InstrumentRow | null {
    return this.#optionsBySymbol.get(tradingsymbol) ?? this.#futuresBySymbol.get(tradingsymbol) ?? null
  }

  /**
   * The spot instrument for an underlying, or null when the dump carried none.
   *
   * Null is a real and important answer: it means the sync excluded the cash
   * row, and every greek for that underlying will be uncomputable. Callers
   * should surface it rather than substituting a future or the ATM strike.
   */
  spot(underlying: string): InstrumentRef | null {
    const row = this.#spot.get(underlying)
    return row === undefined ? null : toRef(row)
  }

  spotToken(underlying: string): number | null {
    return this.#spot.get(underlying)?.instrument_token ?? null
  }

  /** Every underlying that has a resolvable spot instrument. */
  spotUnderlyings(): readonly string[] {
    return [...this.#spot.keys()].sort()
  }

  /** Nearest-expiry future, or the given expiry's. */
  future(underlying: string, expiry?: string): InstrumentRef | null {
    const list = this.#futures.get(underlying)
    if (list === undefined || list.length === 0) return null
    if (expiry === undefined) return toRef(list[0] as InstrumentRow)
    const row = list.find((r) => r.expiry === expiry)
    return row === undefined ? null : toRef(row)
  }

  get optionCount(): number {
    return this.#options.size
  }
}

/**
 * The exchange half of a packed Zerodha token: `instrument_token >> 8`.
 *
 * `instrument_token = exchange_token * 256 + segment`. The gateway sends this
 * half to XTS as `exchangeInstrumentID` (`apps/order-gateway/src/main.ts`) —
 * sending the packed value names an instrument that does not exist, which XTS
 * ACKs and then voids: the 2026-08-04 phantom books.
 */
export function exchangeTokenOf(instrumentToken: number): number | null {
  if (!Number.isFinite(instrumentToken) || instrumentToken <= 0) return null
  return Math.floor(instrumentToken / 256)
}

function toRef(row: InstrumentRow): InstrumentRef {
  return {
    tradingsymbol: row.tradingsymbol,
    instrumentToken: row.instrument_token,
    lotSize: row.lot_size,
    tickSize: row.tick_size,
    exchange: row.exchange,
  }
}

/**
 * Parse the exchange dump CSV.
 *
 * Deliberately minimal rather than a CSV library: the only quoting the dump uses
 * is around `name`, and a dependency on the tick path is a liability we already
 * paid for once with `tulind`.
 */
export function parseInstrumentCsv(text: string): InstrumentRow[] {
  const lines = text.split('\n')
  const header = (lines[0] ?? '').trim().split(',')
  const idx = (col: string): number => header.indexOf(col)
  const iToken = idx('instrument_token')
  const iSymbol = idx('tradingsymbol')
  const iName = idx('name')
  const iExpiry = idx('expiry')
  const iStrike = idx('strike')
  const iTick = idx('tick_size')
  const iLot = idx('lot_size')
  const iType = idx('instrument_type')
  const iSegment = idx('segment')
  const iExchange = idx('exchange')
  if (iToken < 0 || iSymbol < 0 || iType < 0) {
    throw new Error(`instrument dump missing required columns; got header: ${header.join(',')}`)
  }

  const out: InstrumentRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trim() === '') continue
    const f = splitCsvLine(line)
    const token = Number(f[iToken])
    if (!Number.isFinite(token)) continue
    out.push({
      instrument_token: token,
      tradingsymbol: f[iSymbol] ?? '',
      name: f[iName] ?? '',
      expiry: f[iExpiry] ?? '',
      strike: Number(f[iStrike] ?? 0) || 0,
      tick_size: Number(f[iTick] ?? 0) || 0,
      lot_size: Number(f[iLot] ?? 0) || 0,
      instrument_type: f[iType] ?? '',
      segment: f[iSegment] ?? '',
      exchange: f[iExchange] ?? '',
    })
  }
  return out
}

/** Split one CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out.map((s) => s.trim())
}
