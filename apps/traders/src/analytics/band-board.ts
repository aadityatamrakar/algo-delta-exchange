/**
 * The band board: once a minute, in session, every open book's band is read
 * through `BookRisk` and a `BandEvent` is written when it changes between in
 * and out. The books list shows the last reading (`state`).
 *
 * In session means an NSE trading day between 09:20 (the first minute the
 * desk's rules act) and the 15:40 F&O close. A book with no event starts as in, so a book
 * that first reads out writes in → out. `unknown` writes nothing and leaves the
 * last in/out alone: a dead feed is not a change of band. Nor does a reading
 * with the market closed (`marketOpen` false: the band reads 15:40 itself as
 * closed), so no event is written outside the session. `load()` restores the
 * last in/out of every book from its newest event, so a restart writes no
 * duplicate.
 */

import { RULES_START_MIN, isTradingDay } from '@algomaker/desk-engine'
import type { LegStore } from '../books/legs.ts'
import { istDate, type Log } from '../routes/kit.ts'
import type { BandState } from '../types.ts'
import type { BandEvent, EventStore } from './band.ts'
import { MINUTE_MS } from './cache.ts'
import { CLOSE_MINUTES } from './calendar.ts'
import { istMinuteOf } from './engine-book.ts'
import type { BookRisk } from './risk.ts'

export interface BandBoardDeps {
  readonly risk: Pick<BookRisk, 'band'>
  readonly events: Pick<EventStore, 'add' | 'lastBand'>
  readonly legs: Pick<LegStore, 'openBooks'>
  readonly now: () => number
  readonly log?: Log
}

const keyOf = (trader: string, stock: string): string => `${trader}|${stock}`

export class BandBoard {
  readonly #d: BandBoardDeps
  readonly #log: Log
  /** The last in/out an event was written for (or restored from one). */
  readonly #last = new Map<string, 'in' | 'out'>()
  /** The last reading, unknown included: what the books list shows. */
  readonly #shown = new Map<string, BandState>()
  #timer: ReturnType<typeof setInterval> | null = null
  #running = false

  constructor(d: BandBoardDeps) {
    this.#d = d
    this.#log = d.log ?? (() => {})
  }

  async load(): Promise<void> {
    for (const e of await this.#d.events.lastBand()) this.#last.set(keyOf(e.trader, e.stock), e.to)
  }

  /** One pass over the open books; the number of events written. Nothing is read outside the session. */
  async tick(nowMs: number): Promise<number> {
    const minute = istMinuteOf(nowMs)
    if (!isTradingDay(istDate(nowMs)) || minute < RULES_START_MIN || minute > CLOSE_MINUTES) return 0
    let written = 0
    const open = new Set<string>()
    for (const { trader, stock } of await this.#d.legs.openBooks()) {
      const key = keyOf(trader, stock)
      open.add(key)
      try {
        const band = await this.#d.risk.band(trader, stock, nowMs)
        if (band === null) { open.delete(key); continue }
        this.#shown.set(key, band.state)
        if (band.state === 'unknown' || !band.marketOpen) continue
        const from = this.#last.get(key) ?? 'in'
        if (band.state === from) continue
        const e: BandEvent = {
          trader, stock, kind: 'band', from, to: band.state, at: nowMs,
          netDelta: band.netDelta as number, bandShares: band.bandShares as number, lotSize: band.lotSize as number,
          outByLots: band.outByLots, source: band.source,
        }
        await this.#d.events.add(e)   // the state moves only once the event is written: a failed write is retried next minute
        this.#last.set(key, band.state)
        written++
      } catch (err) {
        this.#log('band board: a book could not be read', { trader, stock, error: String(err) })
      }
    }
    for (const key of this.#shown.keys()) if (!open.has(key)) this.#shown.delete(key)
    return written
  }

  /** The last reading of the book; null when it has not been read since the app started. */
  state(trader: string, stock: string): BandState | null {
    return this.#shown.get(keyOf(trader, stock)) ?? null
  }

  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => { void this.#pass() }, MINUTE_MS)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  /** A pass still running when the next minute comes is not overlapped. */
  async #pass(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      await this.tick(this.#d.now())
    } catch (err) {
      this.#log('band board: the open books could not be listed', { error: String(err) })
    } finally {
      this.#running = false
    }
  }
}
