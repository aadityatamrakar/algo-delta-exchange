/**
 * THE reader of `<nseDir>/vol/<YYYY-MM-DD>.json`, which scripts/nse_vol_job.py writes once each weekday evening:
 * the held stocks' near (a week or more out) and next-month chains and NSE's CMVOLT volatility. Each file is reduced on read, stock by stock,
 * to a `VolDay` (vol-metrics' `summarizeChain`); the term structure and skew are worked out for the newest day only,
 * since the metrics read them from the as-of day alone. Spec: docs/superpowers/specs/2026-10-23-traders-vol-addendum.md.
 *
 * `refresh()` lists the folder and reads a file again only when its size or mtime changed, so the app may call it
 * every minute; it yields between files and never throws. A file that does not read is named in `status().problems`
 * and skipped; the job's own error text is never passed on.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { summarizeChain, type RawSide, type RawVolStock, type StrikeRow, type VolDay } from '../analytics/vol-metrics.ts'

/** A year and a half of trading days: more than the 252-day window plus the 20 days realized VRP looks ahead. */
export const VOL_KEEP_DAYS = 400
const MAX_FILE_BYTES = 20 * 1024 * 1024
const NAME_RE = /^(\d{4}-\d{2}-\d{2})\.json$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface VolStatus {
  readonly files: number
  readonly latest: string | null
  /** `vol/<name>: <why>` per file that did not read. */
  readonly problems: readonly string[]
}

interface Loaded {
  readonly date: string
  readonly stocks: ReadonlyMap<string, VolDay>
  /** CMVOLT annualised volatility by symbol; kept for the newest file only. */
  cmvolt: ReadonlyMap<string, number> | null
  /** Whether the stocks were summarized with the term structure and skew. */
  readonly full: boolean
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const numOrNull = (x: unknown): x is number | null => x === null || num(x)

function side(x: unknown): RawSide | null | undefined {
  if (x === null) return null
  if (typeof x !== 'object' || x === undefined) return undefined
  const o = x as Record<string, unknown>
  if (typeof o['expiry'] !== 'string' || !DATE_RE.test(o['expiry']) || typeof o['rolled'] !== 'boolean' || !numOrNull(o['future'])) return undefined
  const rows = o['strikes']
  if (!Array.isArray(rows)) return undefined
  for (const r of rows) {
    if (!Array.isArray(r) || r.length !== 5 || !num(r[0]) || !r.slice(1).every(numOrNull)) return undefined
  }
  return { expiry: o['expiry'], rolled: o['rolled'], future: o['future'] as number | null, strikes: rows as StrikeRow[] }
}

function stock(x: unknown): RawVolStock | null {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  const near = side(o['near'])
  const next = side(o['next'])
  if (near === undefined || next === undefined || !numOrNull(o['spot'])) return null
  return { spot: o['spot'] as number | null, sources: [], near, next, errors: [] }
}

/** The file's CMVOLT symbols object, or null. */
function cmvoltSymbols(x: unknown): Record<string, unknown> | null {
  const syms = typeof x === 'object' && x !== null ? (x as Record<string, unknown>)['symbols'] : null
  return typeof syms === 'object' && syms !== null && !Array.isArray(syms) ? syms as Record<string, unknown> : null
}

/** One symbol's annualised CMVOLT, decimal; null when absent. */
function annualOf(syms: Record<string, unknown> | null, sym: string): number | null {
  const v = syms === null || !Object.hasOwn(syms, sym) ? undefined : syms[sym]
  return Array.isArray(v) && num(v[1]) && v[1] > 0 ? v[1] : null
}

/** Every symbol's: built for the newest file only (~5,000 symbols; 400 days of them would be ~120 MB held). */
function cmvoltOf(syms: Record<string, unknown> | null): Map<string, number> {
  const out = new Map<string, number>()
  for (const sym of Object.keys(syms ?? {})) {
    const a = annualOf(syms, sym)
    if (a !== null) out.set(sym, a)
  }
  return out
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

export class VolStore {
  readonly #dir: string
  readonly #keep: number
  #files = new Map<string, Loaded>()
  #problems = new Map<string, string>()
  /** The signature of each file last tried, so an unchanged file (a bad one too) is not parsed again every minute. */
  #tried = new Map<string, string>()
  #running: Promise<void> | null = null

  constructor(opts: { readonly dir: string; readonly now: () => number; readonly keep?: number }) {
    this.#dir = join(opts.dir, 'vol')
    this.#keep = opts.keep ?? VOL_KEEP_DAYS
  }

  /** Concurrent calls share one pass. */
  refresh(): Promise<void> {
    this.#running ??= this.#refresh().catch(() => {}).finally(() => { this.#running = null })
    return this.#running
  }

  /** One stock's days, oldest → newest. A stock only in the newest CMVOLT file gets that one day, with NSE's HV only. */
  days(stock: string): readonly VolDay[] {
    const out: VolDay[] = []
    const dates = [...this.#files.keys()].sort()
    for (const date of dates) {
      const f = this.#files.get(date) as Loaded
      const d = f.stocks.get(stock)
      if (d !== undefined) out.push(d)
      else if (date === dates[dates.length - 1] && f.cmvolt?.has(stock) === true) out.push(summarizeChain(date, null, f.cmvolt.get(stock) ?? null))
    }
    return out
  }

  status(): VolStatus {
    const dates = [...this.#files.keys()].sort()
    return { files: dates.length, latest: dates[dates.length - 1] ?? null, problems: [...this.#problems.values()] }
  }

  async #refresh(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.#dir)
    } catch {
      this.#files = new Map()
      this.#problems = new Map()
      return
    }
    const dates = names.flatMap((n) => { const m = NAME_RE.exec(n); return m === null ? [] : [m[1] as string] }).sort().slice(-this.#keep)
    const keepSet = new Set(dates)
    for (const d of [...this.#files.keys()]) if (!keepSet.has(d)) this.#files.delete(d)
    for (const d of [...this.#problems.keys()]) if (!keepSet.has(d)) this.#problems.delete(d)
    for (const d of [...this.#tried.keys()]) if (!keepSet.has(d)) this.#tried.delete(d)
    const newest = dates[dates.length - 1]
    for (const date of [...dates].reverse()) {
      await this.#load(date, date === newest)
      await yieldNow()
    }
    // the CMVOLT map is held for the newest file only
    for (const [d, f] of this.#files) if (d !== newest) f.cmvolt = null
  }

  async #load(date: string, newest: boolean): Promise<void> {
    const name = `${date}.json`
    const path = join(this.#dir, name)
    let sig: string
    try {
      const st = await stat(path)
      if (!st.isFile()) throw new Error('not a file')
      if (st.size > MAX_FILE_BYTES) throw new Error(`over ${MAX_FILE_BYTES} bytes`)
      sig = `${st.size}:${st.mtimeMs}`
    } catch (err) {
      this.#files.delete(date)
      this.#tried.delete(date)
      this.#problems.set(date, `vol/${name}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    const had = this.#files.get(date)
    // read again when the file changed, or when it became the newest and was only summarized lightly
    if (this.#tried.get(date) === sig && (had === undefined || had.full || !newest)) return
    this.#tried.set(date, sig)
    try {
      const doc = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (doc['v'] !== 1 || doc['date'] !== date || typeof doc['stocks'] !== 'object' || doc['stocks'] === null) {
        throw new Error(`not a version 1 vol file for ${date}`)
      }
      const syms = cmvoltSymbols(doc['cmvolt'])
      // an older day is read for its held stocks' IV only: their own CMVOLT values, no map of every symbol
      const cmvolt = newest ? cmvoltOf(syms) : null
      const stocks = new Map<string, VolDay>()
      const bad: string[] = []
      for (const [sym, raw] of Object.entries(doc['stocks'] as Record<string, unknown>)) {
        const s = stock(raw)
        if (s === null) { bad.push(sym); continue }
        stocks.set(sym, summarizeChain(date, s, annualOf(syms, sym), { full: newest }))
      }
      this.#files.set(date, { date, stocks, cmvolt, full: newest })
      if (bad.length > 0) this.#problems.set(date, `vol/${name}: unreadable stock entries: ${bad.slice(0, 5).join(', ')}`)
      else this.#problems.delete(date)
    } catch (err) {
      this.#files.delete(date)
      this.#problems.set(date, `vol/${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
