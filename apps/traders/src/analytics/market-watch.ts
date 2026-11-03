/**
 * Market Watch (item 24): an underlying's first three listed expiries on or
 * after today, each a chain of calls | strike | puts with VolHedge's columns.
 * A stock shows every listed strike; an index ATM ± 40 around spot.
 *
 * Each expiry is priced off R1's `monthQuotes`, so its forward (own future,
 * else parity, else carry) and its vols are exactly what Analysis uses. A
 * side's IV is R2's `liquidIv` rule, its greeks Black-76 at that IV off the
 * month's forward. OI change and price change are against the previous
 * trading day's NSE end-of-day file (`deps.eod`): Kite ticks carry no previous
 * close. A side with no quote is null, and anything unknown is blank, never 0.
 *
 * `marketInputOf` reads the master and the quotes; `buildMarketWatch` is pure.
 */

import { b76Greeks, type OptionType } from '@algomaker/greeks'
import { INDEX_SPOT_TOKENS } from '@algomaker/instruments'
import { DEFAULT_RATE, liquidIv } from '@algomaker/payoff'
import type { EodContract } from '@algomaker/span'
import { nearestFuture, spotTokenOf, type TradersMaster } from '../market/master.ts'
import { DEFAULT_MARKET_WATCH_MAX_TOKENS } from '../market/on-screen.ts'
import type { TraderQuote, TradersQuotes } from '../market/quotes.ts'
import { istDate } from '../routes/kit.ts'
import { marketOpenAt } from './calendar.ts'
import { eodFileOf, missingEodNote, type EodStore } from './eod.ts'
import { monthQuotes, type MonthQuotes } from './month-chain.ts'
import { MARKET_CLOSED } from './snapshot.ts'
import { BF2_LABEL, BF_LABEL, RATIO_LABEL, butterfly, butterfly2, ratio, straddle, type PriceAt } from './vh-columns.ts'
import type { MarketChain, MarketRow, MarketSide, MarketWatchView } from './r3-wire.ts'

export type { MarketChain, MarketRow, MarketSide, MarketWatchView } from './r3-wire.ts'

export const INDEX_STRIKES_EACH_SIDE = 40
/** Near, next and far (Decision 11). */
const CHAINS = 3
const TYPES = ['CE', 'PE'] as const

export const MARKET_FEED_DEAD = 'the market data feed is dead: every price below is the last one seen'
export const MARKET_WATCH_LABELS = { bf: BF_LABEL, bf2: BF2_LABEL, ratio: RATIO_LABEL } as const

export interface MarketWatchInput {
  readonly stock: string; readonly nowMs: number; readonly spot: TraderQuote | null; readonly feedAlive: boolean; readonly fullChains: boolean
  readonly chains: readonly {
    readonly expiry: string; readonly lotSize: number; readonly step: number | null; readonly future: TraderQuote | null; readonly month: MonthQuotes
    /** The expiry lists a future; `future` is null when it is not quoted. */
    readonly futureListed: boolean
    readonly rows: readonly { readonly strike: number; readonly ce: TraderQuote | null; readonly pe: TraderQuote | null }[]
  }[]
  readonly eod: Pick<EodStore, 'close' | 'oi' | 'status'>
  /** The chain's exchange is BFO: NSE's end-of-day files have no row for it. */
  readonly bse: boolean
  /** TRADERS_MARKET_WATCH_MAX_TOKENS, for the sentence said when the cap is reached. */
  readonly maxTokens?: number
}

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
const ltpOf = (q: TraderQuote | null): number | null => (positive(q?.price) ? q.price : null)
/** No quote, or the cache's own verdict that it is not live. */
const staleOf = (q: TraderQuote | null): boolean => q === null || q.stale === true

export function isIndex(underlying: string): boolean {
  return Object.hasOwn(INDEX_SPOT_TOKENS, underlying)
}

/** The first three listed option expiries on or after today (Decision 11). */
export function marketExpiries(m: TradersMaster, underlying: string, todayIst: string): string[] {
  return m.options.expiries(underlying).filter((e) => e >= todayIst).slice(0, CHAINS)
}

/** A stock: every listed strike. An index: ATM ± 40 listed strikes around spot; with no spot, around the middle of the list. */
export function marketStrikes(m: TradersMaster, underlying: string, expiry: string, spot: number | null): number[] {
  const all = [...m.options.strikes(underlying, expiry)]
  if (!isIndex(underlying) || all.length === 0) return all
  const atm = positive(spot) ? m.options.atmStrike(underlying, expiry, spot) : null
  const i = atm === null ? Math.floor(all.length / 2) : all.indexOf(atm)
  return all.slice(Math.max(0, i - INDEX_STRIKES_EACH_SIDE), i + INDEX_STRIKES_EACH_SIDE + 1)
}

/** What the screen needs ticking: spot, the nearest listed future, each shown expiry's future, and every shown CE and PE. */
export function marketTokens(m: TradersMaster, q: TradersQuotes, underlying: string, todayIst: string): readonly number[] {
  const out = new Set<number>()
  const spotToken = spotTokenOf(m, underlying)
  if (spotToken !== null) out.add(spotToken)
  const nearest = nearestFuture(m, underlying, todayIst)?.instrumentToken
  if (nearest !== undefined) out.add(nearest)
  const spot = spotToken === null ? null : ltpOf(q.quote(spotToken))
  for (const e of marketExpiries(m, underlying, todayIst)) {
    const fut = m.options.future(underlying, e)?.instrumentToken
    if (fut !== undefined) out.add(fut)
    for (const k of marketStrikes(m, underlying, e, spot)) {
      for (const t of TYPES) {
        const token = m.options.resolve(underlying, e, k, t)?.instrumentToken
        if (token !== undefined) out.add(token)
      }
    }
  }
  return [...out]
}

/**
 * The quotes for `stock`'s chains; null when it lists no expiry. With
 * `fullChains` false only the strikes another screen (an open book, the desk)
 * already has ticking are kept: in session with a live feed, a side whose
 * quote is not stale; otherwise every quote is old, and any quote counts.
 */
export function marketInputOf(
  m: TradersMaster, q: TradersQuotes, eod: Pick<EodStore, 'close' | 'oi' | 'status'>, stock: string, nowMs: number, fullChains: boolean,
): MarketWatchInput | null {
  const expiries = marketExpiries(m, stock, istDate(nowMs))
  if (expiries.length === 0) return null
  const closed = !marketOpenAt(nowMs)
  const quoteOf = (token: number | null | undefined): TraderQuote | null => (token === null || token === undefined ? null : q.quote(token))
  const spotQuote = quoteOf(spotTokenOf(m, stock))
  const spot = ltpOf(spotQuote)
  const live = !closed && q.feedAlive()
  const watched = (x: TraderQuote | null): boolean => x !== null && (!live || x.stale !== true)
  const chains = expiries.map((expiry) => {
    const meta = m.options.chain(stock, expiry)
    const rows = marketStrikes(m, stock, expiry, spot).map((strike) => ({
      strike,
      ce: quoteOf(m.options.resolve(stock, expiry, strike, 'CE')?.instrumentToken),
      pe: quoteOf(m.options.resolve(stock, expiry, strike, 'PE')?.instrumentToken),
    }))
    const fut = m.options.future(stock, expiry)
    return {
      expiry, lotSize: meta?.lotSize ?? 0, step: meta?.strikeStep ?? null,
      future: quoteOf(fut?.instrumentToken), futureListed: fut !== null,
      month: monthQuotes(m, q, stock, expiry, spot, nowMs, closed),
      rows: fullChains ? rows : rows.filter((r) => watched(r.ce) || watched(r.pe)),
    }
  })
  const bse = m.options.chain(stock, expiries[0] as string)?.exchange.toUpperCase() === 'BFO'
  return { stock, nowMs, spot: spotQuote, feedAlive: q.feedAlive(), fullChains, chains, eod, bse }
}

/** Yesterday's close and OI of one contract; both null for a BSE underlying, whose rows NSE's files do not carry. */
interface PreviousDay {
  close(c: EodContract): number | null
  oi(c: EodContract): number | null
}

function changeOf(ltp: number | null, close: number | null): { change: number | null; changePct: number | null } {
  if (ltp === null || close === null) return { change: null, changePct: null }
  const change = ltp - close
  return { change, changePct: (change / close) * 100 }
}

function sideOf(
  stock: string, expiry: string, strike: number, type: OptionType, quote: TraderQuote | null,
  month: MonthQuotes, at: PriceAt, step: number | null, prev: PreviousDay,
): MarketSide | null {
  if (quote === null) return null
  const ltp = ltpOf(quote)
  const contract: EodContract = { stock, instrument: 'option', expiry, strike, optType: type }
  const prevOi = prev.oi(contract)
  const vol = liquidIv(month.ivs, strike, type, false)
  // an expiry past today's close has no time left: no greeks rather than Black-76's zeros
  const g = vol.iv !== null && month.forward !== null && month.tYears > 0
    ? b76Greeks({ future: month.forward, strike, t: month.tYears, vol: vol.iv, rate: DEFAULT_RATE, type })
    : null
  return {
    ltp, ...changeOf(ltp, prev.close(contract)),
    oi: quote.oi, oiChange: quote.oi !== null && prevOi !== null ? quote.oi - prevOi : null, volume: quote.volume,
    iv: vol.iv, ivSource: vol.source,
    delta: g?.delta ?? null, gamma: g?.gamma ?? null, vega: g?.vega ?? null, theta: g?.theta ?? null,
    bf: step === null ? null : butterfly(at, strike, step),
    bf2: step === null ? null : butterfly2(at, strike, step),
    ratio: step === null ? null : ratio(at, strike, step, type),
    ageMs: quote.ageMs,
    stale: staleOf(quote),
  }
}

function chainOf(stock: string, c: MarketWatchInput['chains'][number], prev: PreviousDay): MarketChain {
  // BF, BF2 and Ratio read the LTPs on screen, one side at a time
  const ltps = { CE: new Map<number, number | null>(), PE: new Map<number, number | null>() }
  for (const r of c.rows) { ltps.CE.set(r.strike, ltpOf(r.ce)); ltps.PE.set(r.strike, ltpOf(r.pe)) }
  const at = (type: OptionType): PriceAt => (k) => ltps[type].get(k) ?? null
  const futLtp = ltpOf(c.future)
  // a listed future with no quote is said as such, never taken for "no future"
  const future = !c.futureListed && c.future === null ? null : {
    ltp: futLtp,
    ...changeOf(futLtp, prev.close({ stock, instrument: 'future', expiry: c.expiry, strike: null, optType: null })),
    ageMs: c.future?.ageMs ?? null,
    stale: staleOf(c.future),
  }
  return {
    expiry: c.expiry, lotSize: c.lotSize, step: c.step, future, forward: c.month.forward, forwardSource: c.month.source,
    rows: c.rows.map((r) => ({
      strike: r.strike,
      straddle: straddle(ltpOf(r.ce), ltpOf(r.pe)),
      ce: sideOf(stock, c.expiry, r.strike, 'CE', r.ce, c.month, at('CE'), c.step, prev),
      pe: sideOf(stock, c.expiry, r.strike, 'PE', r.pe, c.month, at('PE'), c.step, prev),
    })),
  }
}

const isFoFile = (entry: string): boolean => eodFileOf(entry).includes('_FO_')

export function buildMarketWatch(i: MarketWatchInput): MarketWatchView {
  const status = i.eod.status()
  const prev: PreviousDay = i.bse ? { close: () => null, oi: () => null } : { close: (c) => i.eod.close(c), oi: (c) => i.eod.oi(c) }

  const warnings: string[] = []
  // a closed market is no dead feed: there is nothing to tick
  if (!marketOpenAt(i.nowMs)) warnings.push(MARKET_CLOSED)
  else if (!i.feedAlive) warnings.push(MARKET_FEED_DEAD)
  if (!i.fullChains) {
    const cap = (i.maxTokens ?? DEFAULT_MARKET_WATCH_MAX_TOKENS).toLocaleString('en-IN')
    warnings.push(`Market Watch is already watching ${cap} contracts for other screens; this one shows only the strikes already watched for open books`)
  }
  // only the F&O file feeds these columns; the cash file is the MTM block's
  if (i.bse) warnings.push(`${i.stock} trades on BSE; NSE's end-of-day files do not cover it — OI change and price change unknown`)
  else for (const entry of status.missing) if (isFoFile(entry)) warnings.push(missingEodNote(entry, 'OI change and price change unknown'))

  return {
    stock: i.stock, asOf: i.nowMs, spot: ltpOf(i.spot), spotStale: staleOf(i.spot), feedAlive: i.feedAlive, fullChains: i.fullChains,
    oiDay: !i.bse && status.fo !== null ? status.day : null,
    chains: i.chains.map((c) => chainOf(i.stock, c, prev)),
    labels: MARKET_WATCH_LABELS,
    warnings,
  }
}
