/**
 * A book's risk reading — its band and relief-r's advice, one entry — computed
 * at most once a minute per book and shared by every viewer and the band board
 * (P13): the board's minute pass warms the advice for whoever opens the card.
 * The key carries the leg version, so a new upload or a manual leg reads fresh
 * inside the minute, and the override, so a new band is never answered from
 * the old one.
 */

import type { LegStore } from '../books/legs.ts'
import type { R3RouteDeps } from '../routes/r3-deps.ts'
import type { TradersMaster } from '../market/master.ts'
import type { TradersQuotes } from '../market/quotes.ts'
import type { BookView } from '../types.ts'
import { adviceOf, noAdvice } from './advice.ts'
import { futurePriceName, spotPriceName, stalePricePrefix } from './book-view.ts'
import { bandOf, type BandOverrideStore } from './band.ts'
import { MINUTE_MS, TtlCache } from './cache.ts'
import { chainSnapOf, dayMonthOf, engineBookOf, nearFutureOf, type EngineBookResult } from './engine-book.ts'
import { liveExpiryFrom, nearExpiryOf } from './near-expiry.ts'
import type { AdviceCard, BandStatus } from './r3-wire.ts'

/**
 * The BookView's own line for a stale price the band is read off: the spot, or
 * the expiry's own future. It writes those only in session while the feed
 * ticks, so a closed market or a dead feed never finds one here (Ruling R3-12).
 */
function staleLine(view: BookView, expiry: string): string | null {
  const reads = [stalePricePrefix(spotPriceName(view.stock)), stalePricePrefix(futurePriceName(view.stock, expiry))]
  return view.warnings.find((w) => reads.some((r) => w.startsWith(r))) ?? null
}

/**
 * The engine's view of the book: the earliest expiry of a MATCHED option leg
 * still trading (an unmatched row has no month priced in the view, and is left
 * out with a note), on that expiry's chain; a book with no such leg (futures
 * or shares alone) on the first chain listed from then. From the 15:40 F&O close
 * on an expiry day that is the next expiry, not today's settled one. A stale
 * spot or future makes it unknown, as a dead feed does.
 */
export function engineBookFor(m: TradersMaster, q: TradersQuotes, view: BookView, trader: string, nowMs: number): EngineBookResult {
  const from = liveExpiryFrom(nowMs)
  const expiry = nearExpiryOf({ ...view, legs: view.legs.filter((l) => l.matched) }, from) ?? m.options.nearestExpiry(view.stock, from)
  if (expiry === null) return { blocked: `Band unknown: ${view.stock} lists no option chain on or after ${from}` }
  const stale = staleLine(view, expiry)
  if (stale !== null) return { blocked: `Band unknown: ${stale}` }
  const chain = chainSnapOf(m, q, view, expiry, nowMs)
  if (chain === null) return { blocked: `Band unknown: no forward for the ${dayMonthOf(expiry)} chain yet` }
  return engineBookOf(view, chain, nearFutureOf(m, view.stock, from), nowMs, trader)
}

export type BookRiskDeps = Pick<R3RouteDeps, 'bookView' | 'master' | 'quotes'> & {
  readonly legs: Pick<LegStore, 'version'>
  readonly bands: Pick<BandOverrideStore, 'get'>
}

/** One book's minute: the band and the advice read off the same BookView. */
export interface Reading { readonly band: BandStatus; readonly advice: AdviceCard }

/**
 * The band and the advice on `book`, the engine's view of `view`. A throw in
 * the advice step costs the card, never the band: the cache keeps no
 * rejection, so a throw would otherwise take the band down on every read.
 */
export function readingOf(book: EngineBookResult, view: BookView, override: number | null, feedAlive: boolean, nowMs: number): Reading {
  const band = bandOf(book, view.stock, override, feedAlive, !view.closed)
  try {
    return { band, advice: adviceOf(book, band, view.stock, view.historyFrom, nowMs, feedAlive) }
  } catch (e) {
    return { band, advice: noAdvice(book, band, view.stock, view.historyFrom, nowMs, `No advice: ${e instanceof Error ? e.message : String(e)}`) }
  }
}

export class BookRisk {
  readonly #d: BookRiskDeps
  readonly #readings = new TtlCache<Reading | null>(MINUTE_MS)

  constructor(d: BookRiskDeps) {
    this.#d = d
  }

  /** Null when the trader holds no open leg in `stock`. */
  async band(trader: string, stock: string, nowMs: number): Promise<BandStatus | null> {
    return (await this.#read(trader, stock, nowMs))?.band ?? null
  }

  /** Null when the trader holds no open leg in `stock`. */
  async advice(trader: string, stock: string, nowMs: number): Promise<AdviceCard | null> {
    return (await this.#read(trader, stock, nowMs))?.advice ?? null
  }

  async #read(trader: string, stock: string, nowMs: number): Promise<Reading | null> {
    // the version is read before the legs (bookView reads them), as the payoff cache does
    const version = this.#d.legs.version(trader)
    const override = await this.#d.bands.get(trader, stock)
    return await this.#readings.get(`${trader}|${stock}|${version}|${override ?? ''}`, nowMs, async () => {
      const view = await this.#d.bookView(trader, stock, nowMs)
      if (view === null) return null
      const book = engineBookFor(this.#d.master(), this.#d.quotes, view, trader, nowMs)
      return readingOf(book, view, override, this.#d.quotes.feedAlive(), nowMs)
    })
  }
}
