/**
 * THE reader of `<nseDir>/events.json`, which scripts/nse_vol_job.py's events step writes after its vol step (risk
 * spec R9): NSE's results board meetings, the one NSE input the results-event risk takes. Version 1:
 *
 *   { "v": 1, "writtenAt": "<ISO>",
 *     "upcoming": { "<SYMBOL>": [{ "date": "YYYY-MM-DD", "purpose": "Financial Results" }, …] },   every F&O symbol
 *     "past": { "<SYMBOL>": { "fetched": "<ISO>", "meetings": [{ "date": …, "purpose": … }, …] } },  the held stocks
 *     "errors": [ … ] }
 *
 * `refresh()` reads the file again only when its size or mtime changed, so the app calls it every minute beside the
 * VolStore; it never throws. A file that does not read keeps the last good read (the job writes atomically, so a bad
 * file is a bad job, not a half-written one) and is named in `status().problems`; the job's own error text is never
 * passed on. A missing file is no problem: there is simply no calendar yet (`writtenAt` null).
 *
 * Dates come back sorted and one per day. An entry that is not a date and a purpose is dropped and counted.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isIsoDate, istDate } from '../routes/kit.ts'

export const EVENTS_FILE = 'events.json'
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** NSE symbols: what a key must look like to be kept. */
const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/

/** One board meeting: its date and NSE's purpose text ("Financial Results/Dividend"). */
export interface EventDate {
  readonly date: string
  readonly purpose: string
}

export interface EventsStatus {
  /** When the job wrote the file last read, ISO; null = no file read yet. */
  readonly writtenAt: string | null
  /** `events.json: <why>` when the file on disk did not read (the last good read is kept). */
  readonly problems: readonly string[]
  /** How many NSE requests failed on the run that wrote the file (its `errors`): its dates may be an older run's. */
  readonly nseErrors: number
}

interface Loaded {
  readonly writtenAt: string
  readonly nseErrors: number
  readonly upcoming: ReadonlyMap<string, readonly EventDate[]>
  readonly past: ReadonlyMap<string, readonly EventDate[]>
}

const EMPTY: readonly EventDate[] = []

/** Sorted, one per date (the first purpose given for a day is kept), bad entries counted in `bad`. */
function dates(x: unknown, bad: { n: number }): EventDate[] {
  if (!Array.isArray(x)) { bad.n++; return [] }
  const byDay = new Map<string, EventDate>()
  for (const e of x) {
    const o = typeof e === 'object' && e !== null ? e as Record<string, unknown> : {}
    const date = o['date']
    const purpose = o['purpose']
    if (!isIsoDate(date) || typeof purpose !== 'string') { bad.n++; continue }
    if (!byDay.has(date)) byDay.set(date, { date, purpose: purpose.slice(0, 200) })
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
}

const record = (x: unknown): Record<string, unknown> | null =>
  (typeof x === 'object' && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : null)

/** The parsed file, or why it is not a version 1 events file. */
export function parseEvents(text: string): { readonly loaded: Loaded; readonly bad: number } | { readonly error: string } {
  let doc: Record<string, unknown> | null
  try {
    doc = record(JSON.parse(text))
  } catch {
    return { error: 'not JSON' }
  }
  if (doc === null || doc['v'] !== 1) return { error: 'not a version 1 events file' }
  const writtenAt = doc['writtenAt']
  const up = record(doc['upcoming'])
  const past = record(doc['past'])
  if (typeof writtenAt !== 'string' || !Number.isFinite(Date.parse(writtenAt)) || up === null || past === null) {
    return { error: 'not a version 1 events file (writtenAt, upcoming or past)' }
  }
  const bad = { n: 0 }
  const upcoming = new Map<string, readonly EventDate[]>()
  for (const [sym, v] of Object.entries(up)) {
    if (!SYMBOL_RE.test(sym)) { bad.n++; continue }
    const ds = dates(v, bad)
    if (ds.length > 0) upcoming.set(sym, ds)
  }
  const pastMap = new Map<string, readonly EventDate[]>()
  for (const [sym, v] of Object.entries(past)) {
    const o = record(v)
    if (!SYMBOL_RE.test(sym) || o === null) { bad.n++; continue }
    const ds = dates(o['meetings'], bad)
    if (ds.length > 0) pastMap.set(sym, ds)
  }
  // NSE's event calendar starts the day after the run, so a held stock's meeting on the run's own day is only in its
  // board-meeting list: count it (and any later one listed there) as coming too
  const runDay = istDate(Date.parse(writtenAt))
  for (const [sym, ds] of pastMap) {
    const extra = ds.filter((e) => e.date >= runDay && !(upcoming.get(sym) ?? EMPTY).some((u) => u.date === e.date))
    if (extra.length > 0) upcoming.set(sym, [...(upcoming.get(sym) ?? EMPTY), ...extra].sort((a, b) => a.date.localeCompare(b.date)))
  }
  const errors = doc['errors']
  return { loaded: { writtenAt, nseErrors: Array.isArray(errors) ? errors.length : 0, upcoming, past: pastMap }, bad: bad.n }
}

export class EventsStore {
  readonly #path: string
  #loaded: Loaded | null = null
  #problem: string | null = null
  /** The signature of the file last tried, so an unchanged file (a bad one too) is not parsed again every minute. */
  #tried: string | null = null
  #running: Promise<void> | null = null

  constructor(opts: { readonly dir: string }) {
    this.#path = join(opts.dir, EVENTS_FILE)
  }

  /** Concurrent calls share one pass. */
  refresh(): Promise<void> {
    this.#running ??= this.#refresh().catch(() => {}).finally(() => { this.#running = null })
    return this.#running
  }

  /** NSE's coming board meetings of `stock` as the job last saw them, oldest first (some may have passed since). */
  upcoming(stock: string): readonly EventDate[] {
    return this.#loaded?.upcoming.get(stock) ?? EMPTY
  }

  /** Every symbol's coming meetings: what the alert runner scans before it reads any leg. */
  upcomingAll(): ReadonlyMap<string, readonly EventDate[]> {
    return this.#loaded?.upcoming ?? new Map()
  }

  /** The stock's past board meetings (held stocks only, ~400 days), oldest first. */
  past(stock: string): readonly EventDate[] {
    return this.#loaded?.past.get(stock) ?? EMPTY
  }

  get writtenAt(): string | null {
    return this.#loaded?.writtenAt ?? null
  }

  status(): EventsStatus {
    return { writtenAt: this.writtenAt, problems: this.#problem === null ? [] : [this.#problem], nseErrors: this.#loaded?.nseErrors ?? 0 }
  }

  async #refresh(): Promise<void> {
    let sig: string
    try {
      const st = await stat(this.#path)
      if (!st.isFile()) throw new Error('not a file')
      if (st.size > MAX_FILE_BYTES) throw new Error(`over ${MAX_FILE_BYTES} bytes`)
      sig = `${st.size}:${st.mtimeMs}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // no file (yet, or removed): no calendar, and nothing wrong
        this.#loaded = null
        this.#problem = null
        this.#tried = null
        return
      }
      this.#problem = `${EVENTS_FILE}: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    if (this.#tried === sig) return
    let text: string
    try {
      text = await readFile(this.#path, 'utf8')
    } catch (err) {
      // not marked tried: a passing read error (EIO) is retried on the next refresh, not the next evening's file
      this.#problem = `${EVENTS_FILE}: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    this.#tried = sig
    const r = parseEvents(text)
    if ('error' in r) {
      this.#problem = `${EVENTS_FILE}: ${r.error}${this.#loaded === null ? '' : ' (the last good read is kept)'}`
      return
    }
    this.#loaded = r.loaded
    this.#problem = r.bad > 0 ? `${EVENTS_FILE}: ${r.bad} unreadable ${r.bad === 1 ? 'entry' : 'entries'} left out` : null
  }
}
