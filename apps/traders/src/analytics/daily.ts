/**
 * The daily record (the operator's gaps ruling G4): one row per book, written once a trading day at 15:45 IST.
 *
 * WHY: every figure the pages show is live. At 15:30 the day's Day MTM, the series P&L, the greeks and the margin
 * are on screen; at 09:15 the next day they are replaced, and a past day cannot be rebuilt (the prices that made it
 * are gone). The only way to keep what a book looked like at a close is to write it down at the close.
 *
 * The values are NOT recomputed here. Each book is read through the functions the pages call — `d.bookView` (the
 * book's table, greeks and series), `mtmOf` (the MTM block), `bookMargin` (SPAN + exposure) — so a row can never
 * disagree with the page it was taken from. The greeks are the BookView's totals, as the Portfolio row and the
 * strip's Net Δ read them; Analysis's T/N totals depend on the viewer's overrides and would not be one number.
 *
 * A book is every stock the trader holds an open leg in at the close, plus every stock they traded that day (one
 * opened and closed inside the day has no view, but its Day MTM — what it made — is the point of the record: that
 * book goes through the same MTM block and series, with no legs).
 *
 *   when     a trading day (`isNseTradingDay`) from 15:45 IST, five minutes after the F&O close, until midnight.
 *            A server that was down at 15:45 writes it on its first tick that evening; one that is down all evening
 *            writes nothing — the next morning's prices are not that day's, so nothing is backfilled.
 *   how      a minute timer; each trader's books are listed on every tick and the ones with no row yet are written
 *            one at a time with sequential awaits, so the pass never builds every book at once and a book that
 *            appears later in the evening still gets its row.
 *   write    `$setOnInsert` on a unique (trader, stock, day): the FIRST row of a day stands. A later pass (a restart
 *            at 21:00, on stale prices) must not replace the one taken at the close, and re-running is harmless.
 *            Rows are kept forever.
 *
 * A trade file that lands after 15:45 is not in a row already written — the row says what the page said at the close.
 */

import type { TradersDb } from '../db.ts'
import type { TradersDeps } from '../deps.ts'
import { lotSizeOf } from '../market/master.ts'
import { IST_OFFSET_MS, istDate } from '../routes/kit.ts'
import { isOpenLeg, type BookView, type SeriesTotal, type TraderTrade } from '../types.ts'
import { CLOSE_MINUTES, isNseTradingDay } from './calendar.ts'
import type { DailyDay, DailyRow, DailyTotals, DailyView } from './daily-wire.ts'
import { bookMargin } from './margin.ts'
import { mtmBlock, mtmInputsOf, mtmOf } from './mtm.ts'
import { seriesPnl } from './series-pnl.ts'
import type { MarginView, MtmBlock } from './wire.ts'

export type { DailyDay, DailyRow, DailyTotals, DailyView } from './daily-wire.ts'

/** 15:45 IST: five minutes after the F&O close, when the last prices of the day are in. */
export const DAILY_AT_MINUTES = CLOSE_MINUTES + 5
/** The recorder's timer. */
export const DAILY_TICK_MS = 60_000
/** A book that fails this many passes is left for the operator (the log names it), not retried all evening. */
export const DAILY_MAX_TRIES = 5

export const DAILY_NOTES: readonly string[] = [
  'Written once a trading day at 15:45 IST from the same figures the pages show, and kept; a row is never rewritten.',
  'Days before the first row have none: a past day has no live prices to rebuild it from.',
]

/** One book's inputs: what its page reads. `view` is null for a book flat at the close (traded that day, nothing open). */
export interface DailyBook {
  readonly view: BookView | null
  readonly mtm: MtmBlock | null
  readonly margin: MarginView | null
  readonly series: SeriesTotal | null
  readonly spot: number | null
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** null as soon as one is null: a total of the known ones would read as the whole. */
const addKnown = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b)

/**
 * The IST day whose record is due at `nowMs`: today when it is an NSE trading day and 15:45 has passed; else null.
 * After midnight the day is over and nothing is due for it.
 */
export function dailyDue(nowMs: number): string | null {
  const day = istDate(nowMs)
  if (!isNseTradingDay(day)) return null
  const ist = new Date(nowMs + IST_OFFSET_MS)
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() >= DAILY_AT_MINUTES ? day : null
}

/** One book's row. Pure. */
export function dailyRowOf(trader: string, stock: string, day: string, at: number, b: DailyBook): DailyRow {
  const { view, mtm, margin } = b
  const t = view?.totals
  // Σ GrossMTM of the open legs; a leg with no LTP adds nothing to the page's sum, so the sum is not the whole: unknown
  const openPnl = view === null ? 0 : view.legs.some((l) => l.mtm === null) ? null : (t?.mtm ?? 0)
  const marginTotal = view === null ? 0 : margin !== null && margin.available ? margin.total : null
  return {
    trader, stock, day, at,
    dayMtm: mtm?.current.total ?? null,
    openPnl,
    seriesNet: b.series?.net ?? null, seriesBooked: b.series?.booked ?? null,
    spot: b.spot,
    delta: t?.delta ?? 0, gamma: t?.gamma ?? 0, theta: t?.theta ?? 0, vega: t?.vega ?? 0,
    margin: marginTotal, marginSource: view === null || marginTotal === null ? null : (margin?.span?.label ?? null),
    legs: view?.legs.length ?? 0,
    warnings: (view?.warnings.length ?? 0) + (mtm?.partial.length ?? 0),
  }
}

/** The books of one day together. Pure. */
export function dailyTotalsOf(rows: readonly DailyRow[]): DailyTotals {
  let legs = 0; let warnings = 0; let vega = 0; let theta = 0
  let deltaValue: number | null = 0; let margin: number | null = 0
  let dayMtm: number | null = 0; let openPnl: number | null = 0; let seriesNet: number | null = 0; let seriesBooked: number | null = 0
  const missing = { dayMtm: [] as string[], openPnl: [] as string[], series: [] as string[], spot: [] as string[], margin: [] as string[] }
  for (const r of rows) {
    legs += r.legs; warnings += r.warnings; vega += r.vega; theta += r.theta
    dayMtm = addKnown(dayMtm, r.dayMtm)
    openPnl = addKnown(openPnl, r.openPnl)
    seriesNet = addKnown(seriesNet, r.seriesNet)
    seriesBooked = addKnown(seriesBooked, r.seriesBooked)
    if (r.dayMtm === null) missing.dayMtm.push(r.stock)
    if (r.openPnl === null) missing.openPnl.push(r.stock)
    if (r.seriesNet === null || r.seriesBooked === null) missing.series.push(r.stock)
    if (r.spot === null) missing.spot.push(r.stock)
    deltaValue = addKnown(deltaValue, r.spot === null ? null : r.delta * r.spot)
    if (r.margin === null) missing.margin.push(r.stock)
    margin = addKnown(margin, r.margin)
  }
  return { books: rows.length, legs, warnings, dayMtm, openPnl, seriesNet, seriesBooked, deltaValue, vega, theta, margin, missing }
}

/** A trader's rows as the page reads them: newest day first, a day's books by stock, with the day's totals. Pure. */
export function dailyViewOf(trader: string, rows: readonly DailyRow[], asOf: number, recordedFrom: string | null): DailyView {
  const by = new Map<string, DailyRow[]>()
  for (const r of rows) {
    const day = by.get(r.day)
    if (day === undefined) by.set(r.day, [r])
    else day.push(r)
  }
  const days: DailyDay[] = [...by.keys()].sort((a, b) => byText(b, a)).map((day) => {
    const books = [...(by.get(day) as DailyRow[])].sort((a, b) => byText(a.stock, b.stock))
    return { day, at: Math.max(...books.map((r) => r.at)), books, totals: dailyTotalsOf(books) }
  })
  return { trader, asOf, recordedFrom, days, notes: DAILY_NOTES }
}

// ---- the store ---------------------------------------------------------------------

const NO_ID = { projection: { _id: 0 } } as const

/** `traders-daily`: unique on (trader, stock, day), and (trader, day) newest first for the page's read. */
export class DailyStore {
  readonly #db: TradersDb

  constructor(db: TradersDb) {
    this.#db = db
  }

  #col() {
    return this.#db.collection<DailyRow>('traders-daily')
  }

  /** True = this call wrote the row; false = the day's row already existed and stands. */
  async insert(row: DailyRow): Promise<boolean> {
    const r = await this.#col().updateOne(
      { trader: row.trader, stock: row.stock, day: row.day },
      { $setOnInsert: { ...row } },
      { upsert: true },
    )
    return (r.upsertedCount ?? 0) > 0
  }

  /** The stocks already recorded for the day. */
  async stocks(trader: string, day: string): Promise<ReadonlySet<string>> {
    const rows = await this.#col().find({ trader, day }, { projection: { _id: 0, stock: 1 } }).toArray()
    return new Set(rows.map((r) => r.stock))
  }

  /** Rows from `fromDay` on, newest day first. */
  async since(trader: string, fromDay: string): Promise<DailyRow[]> {
    return await this.#col().find({ trader, day: { $gte: fromDay } }, NO_ID).sort({ day: -1 }).toArray()
  }

  /** The trader's first recorded day. */
  async firstDay(trader: string): Promise<string | null> {
    const r = await this.#col().find({ trader }, { projection: { _id: 0, day: 1 } }).sort({ day: 1 }).limit(1).toArray()
    return r[0]?.day ?? null
  }
}

// ---- the recorder ------------------------------------------------------------------

/** Every stock the trader holds an open leg in, or traded, on `day`. */
async function booksOf(d: TradersDeps, trader: string, day: string): Promise<string[]> {
  const held = (await d.legs.open(trader)).filter((l) => isOpenLeg(l, day)).map((l) => l.stock)
  const traded = await d.db.collection<TraderTrade>('traders-trades').find({ trader, day }, { projection: { _id: 0, stock: 1 } }).toArray()
  return [...new Set([...held, ...traded.map((t) => t.stock)])].sort(byText)
}

/** A book flat at the close: no BookView, but the block and the series answer for what it made. */
async function flatBook(d: TradersDeps, trader: string, stock: string, nowMs: number): Promise<DailyBook> {
  const version = d.legs.version(trader)   // before the read, as mtmOf does
  const legs = await d.legs.open(trader, stock)   // all of them, as mtmOf passes them: the snapshot cache is keyed without the legs
  const snapshot = d.snapshots.get(trader, stock, legs, version)
  const mtm = mtmBlock(await mtmInputsOf(d, snapshot, nowMs))
  let series: SeriesTotal | null = null
  if (d.series !== undefined) {
    const base = await d.series(trader, stock, version, nowMs)
    series = seriesPnl({
      ...base, trader, stock, today: istDate(nowMs), legs: [],
      lotSizeOf: (instrument, expiry) => lotSizeOf(d.master(), { stock, instrument, expiry, strike: null, optType: null }),
    }).total
  }
  return { view: null, mtm, margin: null, series, spot: snapshot.spot }
}

/** One book as its page reads it. */
export async function dailyBookOf(d: TradersDeps, trader: string, stock: string, nowMs: number): Promise<DailyBook> {
  const view = await d.bookView(trader, stock, nowMs)
  if (view === null) return await flatBook(d, trader, stock, nowMs)
  const mtm = await mtmOf(d, trader, stock, nowMs)
  const margin = await bookMargin(d, trader, stock, nowMs)
  return { view, mtm, margin, series: view.seriesTotal ?? null, spot: view.spot }
}

export class DailyRecorder {
  readonly #d: TradersDeps
  readonly #store: DailyStore
  /** `trader|day` -> the stocks whose row is written, read from the store the first time the pair is seen. */
  readonly #have = new Map<string, Set<string>>()
  /** `trader|day|stock` -> failed passes; a book at `DAILY_MAX_TRIES` is left alone for the evening. */
  readonly #failures = new Map<string, number>()
  #running = false

  constructor(d: TradersDeps, store: DailyStore = new DailyStore(d.db)) {
    this.#d = d
    this.#store = store
  }

  get store(): DailyStore {
    return this.#store
  }

  /**
   * One pass: when a day's record is due, each trader's books are listed afresh and the ones with no row yet are
   * written, one at a time. The list is read on every tick, not once: a book that appears after 15:45 (a late trade
   * file, a watcher that was behind) is picked up by the next tick, and a trader with no books at first has them
   * written when they arrive. Returns the rows written. Never throws: a book that fails is logged and tried again on
   * the next tick, up to `DAILY_MAX_TRIES`.
   */
  async tick(nowMs: number = this.#d.now()): Promise<number> {
    const day = dailyDue(nowMs)
    if (day === null || this.#running) return 0
    this.#running = true
    let written = 0
    try {
      for (const k of [...this.#have.keys()]) if (!k.endsWith(`|${day}`)) this.#have.delete(k)   // an earlier day's are done with
      for (const k of [...this.#failures.keys()]) if (!k.includes(`|${day}|`)) this.#failures.delete(k)
      for (const u of await this.#d.users.list('trader')) written += await this.#trader(u.username, day, nowMs)
    } catch (err) {
      this.#d.log('daily record pass failed', { error: String(err) })
    } finally {
      this.#running = false
    }
    return written
  }

  async #trader(trader: string, day: string, nowMs: number): Promise<number> {
    const key = `${trader}|${day}`
    let written = 0
    try {
      let have = this.#have.get(key)
      if (have === undefined) {
        have = new Set(await this.#store.stocks(trader, day))
        this.#have.set(key, have)
      }
      for (const stock of await booksOf(this.#d, trader, day)) {
        const book = `${key}|${stock}`
        if (have.has(stock) || (this.#failures.get(book) ?? 0) >= DAILY_MAX_TRIES) continue
        try {
          const row = dailyRowOf(trader, stock, day, nowMs, await dailyBookOf(this.#d, trader, stock, nowMs))
          if (await this.#store.insert(row)) written++
          have.add(stock)   // written now, or by an earlier process: either way the close's row stands
        } catch (err) {
          const n = (this.#failures.get(book) ?? 0) + 1
          this.#failures.set(book, n)
          this.#d.log('daily record failed for a book', { trader, stock, day, error: String(err) })
          if (n >= DAILY_MAX_TRIES) this.#d.log('daily record given up for the evening', { trader, stock, day, tries: n })
        }
      }
    } catch (err) {
      this.#d.log('daily record failed for a trader', { trader, day, error: String(err) })
    }
    return written
  }
}
