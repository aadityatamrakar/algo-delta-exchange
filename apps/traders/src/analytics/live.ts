/**
 * The book's live frame: what changes tick by tick (each leg's LTP, bid, ask and gross MTM, the spot and nearest
 * future, the MTM block's Today and Day MTM, the series P&L), worked out from the quote cache alone, once a second, for
 * the `GET /books/:stock/live` stream. Greeks and margin stay with the polled Analysis view.
 *
 * Two halves. `liveBaseOf` reads what changes only with a trade or an upload (the open legs, the MTM block's trades,
 * opening balance and charge rates, the series' trades) from Mongo; the stream refreshes it every LIVE_BASE_MS or when
 * the trader's legs change. `liveFrame` is the base plus the quote cache now; the series' closed part (the cycle walk
 * and the charges) is worked out once per base, and each tick adds only the open legs.
 */

import { eodKey, type EodContract } from '@algomaker/span'
import type { TradersDeps } from '../deps.ts'
import { lotSizeOf, matchLeg, nearestFutureWithExpiry, spotTokenOf, type TradersMaster } from '../market/master.ts'
import type { TradersQuotes } from '../market/quotes.ts'
import { istDate, type Log } from '../routes/kit.ts'
import { isOpenLeg, type TraderLeg } from '../types.ts'
import { marketOpenAt } from './calendar.ts'
import { mtmBlock, mtmInputsOf, type MtmInputs } from './mtm.ts'
import type { LiveFrame } from './r3-wire.ts'
import { seriesClosed, withOpenLegs, type SeriesBase, type SeriesClosed } from './series-pnl.ts'

/** How often a stream re-reads the legs, trades and rates (a new upload is caught sooner by the legs' version). */
export const LIVE_BASE_MS = 10_000

export interface LiveBase {
  readonly trader: string
  readonly stock: string
  /** LegStore.version when the legs were read. */
  readonly version: number
  readonly legs: readonly TraderLeg[]
  /** Each open leg's instrument token, by key; null when the master cannot place it. */
  readonly tokens: ReadonlyMap<string, number | null>
  readonly spotToken: number | null
  readonly futureToken: number | null
  /** The MTM block's inputs as read; their prices are replaced tick by tick. Null when they could not be read. */
  readonly mtm: MtmInputs | null
  /** The series' trades, balance, history and rates (`d.series`); absent = no reader, or it could not be read. */
  readonly series?: SeriesBase
  /** Where a series that cannot be worked out is said, once per base (counts only). */
  readonly log?: Log
}

const price = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null)

/** Null when the trader holds no open leg in `stock`. */
export async function liveBaseOf(d: TradersDeps, trader: string, stock: string, nowMs: number): Promise<LiveBase | null> {
  const version = d.legs.version(trader)
  const all = await d.legs.open(trader, stock)
  const today = istDate(nowMs)
  const legs = all.filter((l) => isOpenLeg(l, today))
  if (legs.length === 0) return null
  const master = d.master()
  const tokens = new Map(legs.map((l) => [l.key, matchLeg(master, l)] as const))
  const [mtm, series] = await Promise.all([
    (async (): Promise<MtmInputs | null> => {
      try {
        return await mtmInputsOf(d, d.snapshots.get(trader, stock, all, version), nowMs)
      } catch {
        return null   // the frame then carries no MTM block figures; the polled view still has them
      }
    })(),
    (async (): Promise<SeriesBase | undefined> => {
      try {
        return await d.series?.(trader, stock, version, nowMs)
      } catch {
        d.log('live frame: series not read, the page keeps the view\'s', { trader, stock, legs: legs.length })
        return undefined   // the frame then carries no series figures
      }
    })(),
  ])
  return {
    trader, stock, version, legs, tokens,
    spotToken: spotTokenOf(master, stock),
    futureToken: nearestFutureWithExpiry(master, stock, today)?.ref.instrumentToken ?? null,
    mtm,
    ...(series === undefined ? {} : { series }),
    log: d.log,
  }
}

/** Each base's series closed part, worked out on its first tick (and again on a new IST day). */
const closedParts = new WeakMap<SeriesBase, { readonly today: string; readonly closed: SeriesClosed }>()
/** The bases whose series failed once: said once, not every second. */
const said = new WeakSet<LiveBase>()

/** `base.series`' closed part for `today`, kept per series object: a tick adds only the open legs to it. */
export function liveSeriesClosed(base: LiveBase & { readonly series: SeriesBase }, master: TradersMaster, today: string): SeriesClosed {
  const kept = closedParts.get(base.series)
  if (kept !== undefined && kept.today === today) return kept.closed
  const closed = seriesClosed({
    ...base.series, trader: base.trader, stock: base.stock, today,
    lotSizeOf: (instrument, expiry) => lotSizeOf(master, { stock: base.stock, instrument, expiry, strike: null, optType: null }),
  })
  closedParts.set(base.series, { today, closed })
  return closed
}

/** The frame now. `master` places contracts the MTM block meets that are not held (closed today). */
export function liveFrame(base: LiveBase, quotes: TradersQuotes, master: TradersMaster, nowMs: number): LiveFrame {
  const feedAlive = quotes.feedAlive()
  const quoteOf = (token: number | null): ReturnType<TradersQuotes['quote']> => (token === null ? null : quotes.quote(token))
  const legs = base.legs.map((l) => {
    const q = quoteOf(base.tokens.get(l.key) ?? null)
    const ltp = price(q?.price)
    return {
      key: l.key, ltp, bid: price(q?.bid), ask: price(q?.ask),
      stale: q === null || q.stale === true || !feedAlive,
      grossMtm: ltp === null ? null : l.qty * (ltp - l.avgPrice),
    }
  })
  let mtmToday: number | null = null
  let mtmTotal: number | null = null
  let mtmCharges: number | null = null
  let mtmReason: string | null = null
  if (base.mtm !== null) {
    const live = new Map(legs.map((l) => [l.key, l] as const))
    const held = new Map(base.mtm.legs.map((pl) => [eodKey(pl.leg), live.get(pl.leg.key)?.ltp ?? pl.ltp] as const))
    try {
      const block = mtmBlock({
        ...base.mtm,
        nowMs,   // the base is up to LIVE_BASE_MS old: whether the day has begun is decided now, not when it was read
        legs: base.mtm.legs.map((pl) => {
          const f = live.get(pl.leg.key)
          return f === undefined ? pl : { ...pl, ltp: f.ltp ?? pl.ltp, bid: f.bid ?? pl.bid, ask: f.ask ?? pl.ask }
        }),
        ltpOf: (c: EodContract) => {
          const k = eodKey(c)
          if (held.has(k)) return held.get(k) ?? null
          return price(quoteOf(matchLeg(master, c))?.price)
        },
      })
      mtmToday = block.current.today
      mtmTotal = block.current.total
      mtmCharges = block.expense.today
      mtmReason = block.dayReason ?? null
    } catch {
      // a block that cannot be worked out this tick: the frame says nothing about it
    }
  }
  // the series as the views work it out (`seriesPnl`), each open leg at this tick's gross MTM; none for a book with no live series
  let series: Pick<LiveFrame, 'seriesNet' | 'seriesOpen' | 'seriesBooked' | 'seriesCharges'> = {}
  if (base.series !== undefined) {
    const gross = new Map(legs.map((l) => [l.key, l.grossMtm] as const))
    const today = istDate(nowMs)
    try {
      const r = withOpenLegs(liveSeriesClosed({ ...base, series: base.series }, master, today), {
        today, rates: base.series.rates,
        legs: base.legs.map((l) => ({ key: l.key, instrument: l.instrument, expiry: l.expiry, strike: l.strike, optType: l.optType, mtm: gross.get(l.key) ?? null })),
      })
      if (r.series.length > 0) series = { seriesNet: r.total.net, seriesOpen: r.total.open, seriesBooked: r.total.booked, seriesCharges: r.total.charges }
    } catch (err) {
      // a series that cannot be worked out this tick: the frame says nothing about it, and the log says so once per base
      if (!said.has(base)) {
        said.add(base)
        base.log?.('live frame: series not worked out, the page keeps the view\'s', {
          trader: base.trader, stock: base.stock, legs: base.legs.length, trades: Array.isArray(base.series.trades) ? base.series.trades.length : null, error: err instanceof Error ? err.name : typeof err,
        })
      }
    }
  }
  return {
    stock: base.stock, asOf: nowMs, closed: !marketOpenAt(nowMs), feedAlive,
    spot: price(quoteOf(base.spotToken)?.price), future: price(quoteOf(base.futureToken)?.price),
    legs, mtmToday, mtmTotal, mtmCharges, mtmReason, ...series,
  }
}

/** Two frames that would show the same: everything but `asOf`. */
export function sameFrame(a: LiveFrame | null, b: LiveFrame): boolean {
  if (a === null) return false
  return JSON.stringify({ ...a, asOf: 0 }) === JSON.stringify({ ...b, asOf: 0 })
}
