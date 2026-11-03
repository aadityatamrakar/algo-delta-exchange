/**
 * THE daily history reader: `<nseDir>/history/<YYYY-MM-DD>.json`, one file per
 * trading day, written by scripts/span_job.py's history step (each evening) and
 * its `--backfill-history N` (once, by the operator). One entry per F&O
 * underlying: the cash OHLC and volume (an index's are its near future's,
 * `src: 'fut'`), the near future's close and OI, and the near expiry's OI,
 * ATM closes, walls and max pain.
 *
 * Settlement closes. `close(stock, day)` is what expiry settlement
 * (ingest/settlement.ts) prices at: a stock's CM close (`c` of a cash bar) or
 * an index's own close (`ic`, the FO bhavcopy's UndrlygPric, when the file
 * carries one; an index's bar is the near future's). They are kept for EVERY
 * file on disk, apart from the `maxDays` window of bars, because an expiry
 * settled once must stay settled after its day leaves the window. A dropped
 * close would re-open the contract and remove its delivered shares, leaving a
 * false short share leg. It is about 200 numbers a day. `version()` moves
 * whenever a day's bars or closes are added, changed or dropped, so the
 * settlement recompute knows a new close arrived.
 *
 * WHY its own store and not the EOD store: levels, trend, ATR, HV and IV rank
 * need a year of days, and the dated bhavcopy folders are pruned after a week;
 * the summaries are small (~75 KB a day) and kept.
 *
 * `refresh()` lists the folder and parses a file again only when it is new or
 * its size or mtime changed, so the app calls it every minute (the EOD store's
 * cadence). It never throws: a missing folder is no history, and a file that
 * does not parse is skipped, named in `status().problems` and logged once. At
 * most `maxDays` (400) of the newest days are held. The ATM IV of each day is
 * solved here with `@algomaker/greeks` (Black-76): the mean of the ATM call's
 * and put's IVs, off the future's close when the future is the option month's,
 * else off put-call parity at that strike (an index weekly lists no future);
 * null when either side fails. Nothing is invented: a missing number is null.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FNO_CLOSE_MIN } from '@algomaker/core'
import { b76ImpliedVol, yearsToExpiry, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import type { DailyBar } from '../analytics/context-wire.ts'
import { isNseTradingDay } from '../analytics/calendar.ts'
import { STOCK_RE } from '../books/manual.ts'
import type { Log } from '../routes/kit.ts'

export const HISTORY_FOLDER = 'history'
export const MAX_HISTORY_DAYS = 400
/** Days whose future and option summaries are held for `latest()`; older days keep only their bars. */
export const EXTRAS_DAYS = 10
/** The span job writes one file an evening; a minute's listing finds it soon enough. */
export const HISTORY_REFRESH_MS = 60_000

/** A daily bar and where its OHLC came from: the cash market, or (an index) the near future. */
export interface HistoryBar extends DailyBar {
  readonly src: 'cash' | 'fut'
  /** NSE's previous close (PrvsClsgPric): adjusted on an ex-date; a future's is its own contract's. */
  readonly pc?: number
  /** The future contract's expiry an index bar (`src: 'fut'`) is of. */
  readonly contract?: string
}

/** A break between two consecutive trading days that the older bars are scaled across. */
export interface Adjustment {
  /** The first day at the new scale. */
  readonly date: string
  /** NSE's previous close on `date` ÷ the bar before's close: what the older prices are multiplied by. */
  readonly ratio: number
  /** 'corporate': a bonus, split or the like; 'roll': an index's bars moving to the next future contract. */
  readonly kind: 'corporate' | 'roll'
}

/** A previous close this far from the day before's close is a corporate action, not rounding. */
export const ADJUST_OVER = 0.01
/** The backfill's record of weekdays NSE published no bhavcopy for (scripts/span_job.py `UNPUBLISHED`). */
export const UNPUBLISHED_FILE = 'unpublished.json'
const DAY_MS = 86_400_000
/** No run of closed days is this long: a longer gap is missing data. */
const MAX_GAP_DAYS = 30

/**
 * Whether `day`'s previous close is `prev`'s close: every weekday between them is known closed, either on the
 * calendar (2025, 2026 holidays) or recorded by the backfill as not published. A day simply missing from the history
 * is neither, and then nothing is adjusted across it.
 */
export function consecutiveDays(prev: string, day: string, unpublished: ReadonlySet<string> = new Set()): boolean {
  if (!(prev < day)) return false
  const end = Date.parse(`${day}T00:00:00Z`)
  for (let t = Date.parse(`${prev}T00:00:00Z`) + DAY_MS, n = 0; t < end; t += DAY_MS, n++) {
    const d = new Date(t).toISOString().slice(0, 10)
    if (n > MAX_GAP_DAYS || (isNseTradingDay(d) && !unpublished.has(d))) return false
  }
  return true
}

const scaled = (b: HistoryBar, f: number): HistoryBar => (f === 1 ? b : {
  ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f, volume: Math.round(b.volume / f),
  futClose: b.futClose === null ? null : b.futClose * f, maxPain: b.maxPain === null ? null : b.maxPain * f,
})

/**
 * The bars back-adjusted, newest first in the walk: where a day's NSE previous close (`pc`) is not the bar before's
 * close (by more than ADJUST_OVER), or an index's bars move to the next future contract, every older bar's prices are
 * multiplied by pc ÷ that close (volume divided), so returns, HV, ATR, SMAs and 52-week levels see no false gap. Only
 * across consecutive trading days: across a missing day pc is not comparable. IV, OI and dates are left alone.
 */
export function adjustBars(
  bars: readonly HistoryBar[], unpublished: ReadonlySet<string> = new Set(),
): { readonly bars: readonly HistoryBar[]; readonly adjustments: readonly Adjustment[] } {
  const out: HistoryBar[] = new Array<HistoryBar>(bars.length)
  const adjustments: Adjustment[] = []
  let f = 1
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i] as HistoryBar
    out[i] = scaled(b, f)
    const prev = bars[i - 1]
    if (prev === undefined || b.pc === undefined || !positive(prev.close) || !consecutiveDays(prev.date, b.date, unpublished)) continue
    const ratio = b.pc / prev.close
    const roll = b.src === 'fut' && b.contract !== undefined && prev.contract !== undefined && b.contract !== prev.contract
    if (roll || Math.abs(ratio - 1) > ADJUST_OVER) {
      f *= ratio
      adjustments.push({ date: b.date, ratio, kind: roll ? 'roll' : 'corporate' })
    }
  }
  return { bars: out, adjustments: adjustments.reverse() }
}

/** The ATM strike (nearest the future's close) and its call's and put's closes; a side that did not trade is null. */
export interface HistoryAtm { readonly strike: number; readonly ce: number | null; readonly pe: number | null }

/** What the newest file holding a stock says beyond its bar: the OI view the levels and the context read. */
export interface HistoryDay {
  readonly date: string
  readonly src: 'cash' | 'fut'
  readonly fut: { readonly expiry: string; readonly close: number; readonly oi: number | null } | null
  readonly opt: {
    readonly expiry: string
    readonly ceOi: number | null
    readonly peOi: number | null
    readonly atm: HistoryAtm | null
    readonly walls: { readonly ce: readonly (readonly [number, number])[]; readonly pe: readonly (readonly [number, number])[] }
    readonly maxPain: number | null
  } | null
}

export interface HistoryStatus {
  readonly days: number
  readonly first: string | null
  readonly last: string | null
  /** Files skipped, as `<name>: <reason>`. */
  readonly problems: readonly string[]
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The 15:40 IST F&O close of a trading day: the instant a day's option closes price at (the greeks' expiry instant too). */
const closeOf = (day: string): number => Date.parse(`${day}T00:00:00+05:30`) + FNO_CLOSE_MIN * 60_000

/**
 * The day's ATM IV, decimal: the mean of the ATM call's and put's Black-76 IVs.
 * The forward is the future's close when it expires with the options, else
 * K + (C − P)·e^{r·t} at the ATM strike. Null when either side has no close or
 * does not solve, or the expiry has no time left.
 */
export function atmIvOf(
  day: string,
  fut: { readonly expiry: string; readonly close: number } | null,
  opt: { readonly expiry: string; readonly atm: HistoryAtm | null } | null,
): number | null {
  const atm = opt?.atm ?? null
  if (opt === null || atm === null || !positive(atm.ce) || !positive(atm.pe)) return null
  const t = yearsToExpiry(opt.expiry, closeOf(day))
  if (!(t > 0)) return null
  const forward = fut !== null && fut.expiry === opt.expiry ? fut.close : atm.strike + (atm.ce - atm.pe) * Math.exp(DEFAULT_RATE * t)
  if (!positive(forward)) return null
  const solve = (price: number, type: OptionType): number | null =>
    b76ImpliedVol(price, { future: forward, strike: atm.strike, t, rate: DEFAULT_RATE, type })
  const ce = solve(atm.ce, 'CE')
  const pe = solve(atm.pe, 'PE')
  return ce === null || pe === null ? null : (ce + pe) / 2
}

function wallsOf(v: unknown): readonly (readonly [number, number])[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((w) => (Array.isArray(w) && positive(w[0]) && count(w[1]) !== null ? [[w[0], w[1] as number] as const] : []))
}

function futOf(v: unknown): HistoryDay['fut'] {
  if (!isObject(v) || typeof v['expiry'] !== 'string' || !ISO_DAY_RE.test(v['expiry']) || !positive(v['c'])) return null
  return { expiry: v['expiry'], close: v['c'], oi: count(v['oi']) }
}

/**
 * The fixed-tenor IV (`ivAtm` in the file: the ATM of the first expiry at least 7 calendar days out), solved as
 * `atmIvOf` solves any. Undefined when the file predates the field; null when it does not solve.
 */
function tenorIvOf(day: string, v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (!isObject(v) || typeof v['expiry'] !== 'string' || !ISO_DAY_RE.test(v['expiry']) || !positive(v['strike'])) return null
  const fut = positive(v['fut']) ? { expiry: v['expiry'], close: v['fut'] } : null
  const atm = { strike: v['strike'], ce: positive(v['ce']) ? v['ce'] : null, pe: positive(v['pe']) ? v['pe'] : null }
  return atmIvOf(day, fut, { expiry: v['expiry'], atm })
}

function optOf(v: unknown): HistoryDay['opt'] {
  if (!isObject(v) || typeof v['expiry'] !== 'string' || !ISO_DAY_RE.test(v['expiry'])) return null
  const a = v['atm']
  const atm = isObject(a) && positive(a['strike'])
    ? { strike: a['strike'], ce: positive(a['ce']) ? a['ce'] : null, pe: positive(a['pe']) ? a['pe'] : null }
    : null
  const w = isObject(v['walls']) ? v['walls'] : {}
  return {
    expiry: v['expiry'], ceOi: count(v['ceOi']), peOi: count(v['peOi']), atm,
    walls: { ce: wallsOf(w['ce']), pe: wallsOf(w['pe']) },
    maxPain: positive(v['maxPain']) ? v['maxPain'] : null,
  }
}

/** A day's settlement closes by stock: a cash bar's `c`, else (an index) its `ic`; null = listed with neither. */
export type DayCloses = ReadonlyMap<string, number | null>

interface ParsedDay {
  readonly bars: ReadonlyMap<string, HistoryBar>
  readonly extras: ReadonlyMap<string, HistoryDay>
  readonly closes: DayCloses
}

/** The file's `symbols`; throws when it is not `day`'s summary. */
function symbolsOf(text: string, day: string): Record<string, unknown> {
  const doc: unknown = JSON.parse(text)
  if (!isObject(doc) || !isObject(doc['symbols'])) throw new Error('not a history summary (no symbols)')
  if (doc['date'] !== day) throw new Error(`the file says it is ${String(doc['date'])}`)
  return doc['symbols']
}

function closesOf(symbols: Record<string, unknown>): DayCloses {
  const out = new Map<string, number | null>()
  for (const [stock, e] of Object.entries(symbols)) {
    if (!STOCK_RE.test(stock) || !isObject(e)) continue
    const close = e['src'] === 'fut' ? e['ic'] : e['c']
    out.set(stock, positive(close) ? close : null)
  }
  return out
}

/** Only a file's settlement closes: what is kept of a day outside the bars' window. Throws as `parseHistoryDay`. */
export function parseHistoryCloses(text: string, day: string): DayCloses {
  return closesOf(symbolsOf(text, day))
}

/** One file; throws when it is not a day's summary. An entry with no usable OHLC is left out of the bars. */
export function parseHistoryDay(text: string, day: string): ParsedDay {
  const symbols = symbolsOf(text, day)
  const bars = new Map<string, HistoryBar>()
  const extras = new Map<string, HistoryDay>()
  for (const [stock, e] of Object.entries(symbols)) {
    if (!STOCK_RE.test(stock) || !isObject(e)) continue
    const [o, h, l, c] = [e['o'], e['h'], e['l'], e['c']]
    if (!positive(o) || !positive(h) || !positive(l) || !positive(c)) continue
    const src = e['src'] === 'fut' ? 'fut' : 'cash'
    const fut = futOf(e['fut'])
    const opt = optOf(e['opt'])
    // the ranked IV is the fixed tenor's; a summary from before that field has only the nearest expiry's
    const tenorIv = tenorIvOf(day, e['ivAtm'])
    bars.set(stock, {
      date: day, open: o, high: h, low: l, close: c, volume: count(e['v']) ?? 0,
      futClose: fut?.close ?? null, futOi: fut?.oi ?? null, ceOi: opt?.ceOi ?? null, peOi: opt?.peOi ?? null,
      atmIv: tenorIv === undefined ? atmIvOf(day, fut, opt) : tenorIv, maxPain: opt?.maxPain ?? null, src,
      ...(positive(e['pc']) ? { pc: e['pc'] } : {}),
      ...(src === 'fut' && fut !== null ? { contract: fut.expiry } : {}),
    })
    extras.set(stock, { date: day, src, fut, opt })
  }
  return { bars, extras, closes: closesOf(symbols) }
}

export class HistoryStore {
  readonly #dir: string
  readonly #log: Log
  readonly #maxDays: number
  /** Date → that day's bars, the newest `maxDays` days. */
  readonly #days = new Map<string, ReadonlyMap<string, HistoryBar>>()
  /** Date → its file's extras, the newest `EXTRAS_DAYS` days only; the context reads the newest per stock. */
  readonly #extras = new Map<string, ReadonlyMap<string, HistoryDay>>()
  /** Date → its settlement closes, for every file on disk (not only the bars' window). */
  readonly #closes = new Map<string, DayCloses>()
  #version = 0
  /** File name → `size:mtime` last read (or tried) for its bars. */
  readonly #sigs = new Map<string, string>()
  /** File name → `size:mtime` its closes were last read (or tried) at. */
  readonly #closeSigs = new Map<string, string>()
  readonly #problems = new Map<string, string>()
  #dates: readonly string[] = []
  /** Weekdays the backfill found no bhavcopy for (history/unpublished.json): closed, not missing. */
  #unpublished: ReadonlySet<string> = new Set()
  #unpublishedSig: string | null = null
  #running: Promise<void> | null = null

  /** `dir` is the NSE folder (TRADERS_NSE_DIR); the summaries are in its `history/`. */
  constructor(opts: { readonly dir: string; readonly log?: Log; readonly maxDays?: number }) {
    this.#dir = join(opts.dir, HISTORY_FOLDER)
    this.#log = opts.log ?? (() => {})
    this.#maxDays = opts.maxDays ?? MAX_HISTORY_DAYS
  }

  /** Concurrent calls share one pass. Never throws. */
  refresh(): Promise<void> {
    this.#running ??= this.#refresh().finally(() => { this.#running = null })
    return this.#running
  }

  /** The last `n` days of `stock`, oldest → newest, back-adjusted (`adjustBars`); [] when none are held. */
  bars(stock: string, n: number): readonly HistoryBar[] {
    return adjustBars(this.#raw(stock, n), this.#unpublished).bars
  }

  /** The breaks `bars(stock, n)` was adjusted across, oldest first. */
  adjustments(stock: string, n: number): readonly Adjustment[] {
    return adjustBars(this.#raw(stock, n), this.#unpublished).adjustments
  }

  #raw(stock: string, n: number): HistoryBar[] {
    const want = Math.max(0, Math.min(Math.floor(n), this.#maxDays))
    const out: HistoryBar[] = []
    for (let i = this.#dates.length - 1; i >= 0 && out.length < want; i--) {
      const b = this.#days.get(this.#dates[i] as string)?.get(stock)
      if (b !== undefined) out.push(b)
    }
    return out.reverse()
  }

  /**
   * `stock`'s settlement close on `day`, raw (a settlement is at that day's own price): a number; null = the file lists
   * it with no close to settle at (an index bar with no `ic`); undefined = the file does not list it, or no file of the
   * day is held (`hasCloses` tells which).
   */
  close(stock: string, day: string): number | null | undefined {
    return this.#closes.get(day)?.get(stock)
  }

  /** Whether `day`'s file is on disk and read. */
  hasCloses(day: string): boolean {
    return this.#closes.has(day)
  }

  /** The days whose closes are held: how many, and the first. */
  closeDays(): { readonly days: number; readonly first: string | null } {
    let first: string | null = null
    for (const d of this.#closes.keys()) if (first === null || d < first) first = d
    return { days: this.#closes.size, first }
  }

  /** Moves whenever a day's bars or closes are added, re-read or dropped. */
  version(): number {
    return this.#version
  }

  /** The newest of the last `EXTRAS_DAYS` held days that lists `stock`, with its future and option summary; null when none does. */
  latest(stock: string): HistoryDay | null {
    for (let i = this.#dates.length - 1; i >= 0; i--) {
      const e = this.#extras.get(this.#dates[i] as string)?.get(stock)
      if (e !== undefined) return e
    }
    return null
  }

  status(): HistoryStatus {
    return {
      days: this.#dates.length, first: this.#dates[0] ?? null, last: this.#dates.at(-1) ?? null,
      problems: [...this.#problems.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, why]) => `${name}: ${why}`),
    }
  }

  async #refresh(): Promise<void> {
    let all: string[]
    try {
      all = (await readdir(this.#dir)).filter((n) => FILE_RE.test(n)).sort()
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') this.#log('history folder unreadable', { dir: this.#dir, error: reason(err) })
      return   // what is held stays: a folder that vanishes for a moment does not empty the charts (nor un-settle an expiry)
    }
    const older = all.slice(0, Math.max(0, all.length - this.#maxDays))
    const names = all.slice(older.length)
    const keep = new Set(names.map((n) => n.slice(0, 10)))
    const onDisk = new Set(all.map((n) => n.slice(0, 10)))
    for (const d of [...this.#days.keys()]) if (!keep.has(d)) { this.#days.delete(d); this.#extras.delete(d); this.#version++ }
    for (const d of [...this.#closes.keys()]) if (!onDisk.has(d)) { this.#closes.delete(d); this.#version++ }
    for (const n of [...this.#sigs.keys()]) if (!keep.has(n.slice(0, 10))) this.#sigs.delete(n)
    for (const n of [...this.#closeSigs.keys()]) if (!onDisk.has(n.slice(0, 10))) this.#closeSigs.delete(n)
    for (const n of [...this.#problems.keys()]) if (!onDisk.has(n.slice(0, 10))) this.#problems.delete(n)
    for (const name of names) await this.#load(name)
    // outside the bars' window only the closes are kept (a file read once, unless it changes)
    for (const name of older) await this.#loadCloses(name)
    await this.#loadUnpublished()
    this.#dates = [...this.#days.keys()].sort()
    // the OI summaries (walls, ATM) weigh ~1 KB a stock a day and only the newest are read: older days keep their bars only
    for (const d of this.#dates.slice(0, -EXTRAS_DAYS)) this.#extras.delete(d)
  }

  async #loadUnpublished(): Promise<void> {
    const path = join(this.#dir, UNPUBLISHED_FILE)
    try {
      const st = await stat(path)
      const sig = `${st.size}:${st.mtimeMs}`
      if (sig === this.#unpublishedSig) return
      this.#unpublishedSig = sig
      const doc: unknown = JSON.parse(await readFile(path, 'utf8'))
      const days = isObject(doc) && Array.isArray(doc['days']) ? doc['days'] : []
      this.#unpublished = new Set(days.filter((d): d is string => typeof d === 'string' && ISO_DAY_RE.test(d)))
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') this.#log('history unpublished record unreadable', { error: reason(err) })
      else { this.#unpublished = new Set(); this.#unpublishedSig = null }   // no record: every missing weekday is missing
    }
  }

  async #load(name: string): Promise<void> {
    const day = name.slice(0, 10)
    const path = join(this.#dir, name)
    let sig: string
    try {
      const st = await stat(path)
      if (!st.isFile()) return
      sig = `${st.size}:${st.mtimeMs}`
    } catch {
      return   // gone between the listing and now
    }
    if (this.#sigs.get(name) === sig) return
    this.#sigs.set(name, sig)   // kept on failure too: the same bad file is not parsed and logged every minute
    this.#closeSigs.set(name, sig)
    try {
      const parsed = parseHistoryDay(await readFile(path, 'utf8'), day)
      this.#days.set(day, parsed.bars)
      this.#extras.set(day, parsed.extras)
      this.#closes.set(day, parsed.closes)
      this.#problems.delete(name)
      this.#version++
    } catch (err) {
      const had = this.#days.delete(day)
      if (this.#closes.delete(day) || had) this.#version++
      this.#extras.delete(day)
      this.#problems.set(name, reason(err))
      this.#log('history file skipped', { file: name, error: reason(err) })
    }
  }

  /** A day outside the bars' window: its closes only, read again only when the file changes. */
  async #loadCloses(name: string): Promise<void> {
    const day = name.slice(0, 10)
    const path = join(this.#dir, name)
    let sig: string
    try {
      const st = await stat(path)
      if (!st.isFile()) return
      sig = `${st.size}:${st.mtimeMs}`
    } catch {
      return
    }
    if (this.#closeSigs.get(name) === sig) return
    this.#closeSigs.set(name, sig)
    try {
      this.#closes.set(day, parseHistoryCloses(await readFile(path, 'utf8'), day))
      this.#problems.delete(name)
      this.#version++
    } catch (err) {
      if (this.#closes.delete(day)) this.#version++
      this.#problems.set(name, reason(err))
      this.#log('history file skipped', { file: name, error: reason(err) })
    }
  }
}
