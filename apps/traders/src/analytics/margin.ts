/**
 * NSE SPAN + exposure margin for one trader book (spec items 15 and 28).
 *
 * `SpanStore` reads what the span job (scripts/span_job.py) saves under
 * `TRADERS_NSE_DIR`: `<YYYY-MM-DD>/nsccl.YYYYMMDD.s.spn` (end of day),
 * `…i<N>.spn` (intraday), `ael_DDMMYYYY.csv` (exposure rates) and a
 * `manifest.json` whose `savedAt` is epoch milliseconds. It keeps only the
 * newest business date's files in memory, each parsed for the symbols the open
 * books hold, and re-reads a file only when it changed or the symbol set grew.
 * A pass parses at most one file — a full-size one holds this process's one
 * thread for seconds — the newest due first, then one older file of the date
 * a pass, yielding before and after; `today()` and the peak cover what is read
 * so far. `refresh` never throws.
 *
 * Nothing is estimated: with no SPAN file the margin is not available; a
 * contract the file does not carry is named and the figure is called partial;
 * a file that does not parse is named and the last good one is shown instead.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { parseExposureFile, parseSpanFile, spanMargin, type SpanFile, type SpanPosition } from '@algomaker/span'
import type { TradersDeps } from '../deps.ts'
import { IST_OFFSET_MS, istClock, istDate } from '../routes/kit.ts'
import { isOpenLeg } from '../types.ts'
import { marketOpenAt, previousTradingDay } from './calendar.ts'
import type { BookSnapshot } from './snapshot.ts'
import type { MarginView, SpanSourceView } from './wire.ts'

export interface SpanFileName { readonly kind: 'eod' | 'intraday'; readonly businessDate: string; readonly seq: number }

const SPAN_NAME = /^nsccl\.(\d{4})(\d{2})(\d{2})\.(?:(s)|i(\d{1,3}))\.spn$/
const EXPOSURE_NAME = /^ael_(\d{2})(\d{2})(\d{4})\.csv$/
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const EOD_SEQ = 99
/** The newest date folders looked into each pass: a SPAN or exposure file older than that is long stale. */
const DAYS_SCANNED = 10

export const NO_SPAN_NOTE = 'No NSE SPAN file yet — margin appears once the span job has saved one'
export const SHARES_NOTE = 'Shares are cash segment: not in SPAN'
/**
 * Whether the method has been checked against a broker's margin on the Phase 0
 * Q6 golden books (packages/span/test/golden/). False until plan Task 8 Step 6
 * lands those cases and they pass: that change flips it to true, and the note
 * leaves every margin figure.
 */
export const MARGIN_CHECKED = false
export const UNCHECKED_NOTE = "Not yet checked against a broker's margin figure (Phase 0 Q6)"

function realDate(y: string, m: string, d: string): string | null {
  const iso = `${y}-${m}-${d}`
  const t = new Date(`${iso}T00:00:00.000Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null
}

/** 'nsccl.20261019.i2.spn' -> { intraday, 2026-10-19, 2 }; an end-of-day file has seq 99. */
export function parseSpanFileName(name: string): SpanFileName | null {
  const m = SPAN_NAME.exec(name)
  if (m === null) return null
  const businessDate = realDate(m[1] as string, m[2] as string, m[3] as string)
  if (businessDate === null) return null
  return m[4] === 's' ? { kind: 'eod', businessDate, seq: EOD_SEQ } : { kind: 'intraday', businessDate, seq: Number(m[5]) }
}

const dayMonth = (iso: string): string => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`
/** The peak line, named by its files' own business date (every morning that is the last session's), and how many it covers while some wait. */
export const peakNote = (businessDate: string, read: number, of: number): string =>
  `Peak = highest of ${dayMonth(businessDate)}'s NSE SPAN files${read < of ? ` — ${read} of ${of} read so far` : ''} (our reading of VolHedge's peak-margin line)`
const EXPOSURE_GAP = 'exposure rate for '
/** A `missing` entry as its sentence: an exposure-rate gap is the exposure file's, every other the SPAN file's. */
function missingNote(k: string, exposureFile: string | null): string {
  if (!k.startsWith(EXPOSURE_GAP)) return `not in the SPAN file: ${k} — the figure is partial`
  return exposureFile === null ? `${k} missing: no NSE exposure file read — the figure is partial` : `${k} missing from ${exposureFile} — the figure is partial`
}
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFile = (st: { isFile(): boolean }): boolean => st.isFile()

interface SpanEntry {
  readonly name: string; readonly kind: 'eod' | 'intraday'; readonly seq: number
  /** `size:mtime` of the file read (or tried). */
  readonly sig: string
  /** The symbols the file was parsed for; null = it did not parse. */
  readonly parsedFor: ReadonlySet<string> | null
  readonly file: SpanFile | null
  readonly error: string | null
}
/** `symbols`: what the file was parsed for — a stock outside them is not in `file`. */
interface Parsed { readonly file: SpanFile; readonly kind: 'eod' | 'intraday'; readonly symbols: ReadonlySet<string>; readonly source: SpanSourceView }
type Found = SpanFileName & { readonly name: string }
interface ExposureSlot { readonly name: string; readonly sig: string; readonly rates: ReadonlyMap<string, number> | null; readonly error: string | null }

const covers = (have: ReadonlySet<string>, want: ReadonlySet<string>): boolean => [...want].every((s) => have.has(s))

export class SpanStore {
  readonly #dir: string
  readonly #now: () => number
  /** Newest business date's files by name; what the last pass read. */
  #entries = new Map<string, SpanEntry>()
  #current: readonly Parsed[] = []
  /** The files of #current's date that parse or still wait to: what the peak counts against. */
  #dayFiles = 0
  #exposure: { readonly rates: ReadonlyMap<string, number>; readonly source: SpanSourceView } | null = null
  #exposureSlot: ExposureSlot | null = null
  #exposureError: string | null = null
  #lastError: string | null = null
  #running: Promise<void> | null = null
  #runningFor: ReadonlySet<string> = new Set()

  constructor(opts: { readonly dir: string; readonly now: () => number }) {
    this.#dir = opts.dir
    this.#now = opts.now
  }

  /** A call while a pass runs joins it; one that holds a stock the pass did not parse for runs once more after it. */
  refresh(symbols: ReadonlySet<string>): Promise<void> {
    if (this.#running !== null) {
      return covers(this.#runningFor, symbols) ? this.#running : this.#running.then(() => this.refresh(symbols))
    }
    this.#runningFor = new Set(symbols)
    const run: Promise<void> = this.#refresh(symbols).catch((err: unknown) => {
      this.#lastError = `margin refresh failed: ${reason(err)}`
    }).finally(() => { if (this.#running === run) this.#running = null })
    this.#running = run
    return run
  }

  /** The newest file read (by business date, then sequence). */
  span(): Parsed | null { return this.#current.at(-1) ?? null }

  /** Every file of the newest business date read so far, oldest first. */
  today(): readonly Parsed[] { return this.#current }

  /** How many of that date's files are read or wait for their pass; one that did not parse is not counted. */
  dayFiles(): number { return this.#dayFiles }

  exposure(): { readonly rates: ReadonlyMap<string, number>; readonly source: SpanSourceView } | null { return this.#exposure }

  /** `<file> did not parse: <reason>` for the newest SPAN file that failed; null when none did. */
  lastError(): string | null { return this.#lastError }

  /** The same for the exposure file. */
  exposureError(): string | null { return this.#exposureError }

  async #refresh(symbols: ReadonlySet<string>): Promise<void> {
    let days: string[]
    try {
      days = (await readdir(this.#dir)).filter((d) => DAY_DIR.test(d)).sort().reverse().slice(0, DAYS_SCANNED)
    } catch {
      return        // the folder is unreadable now: what is held stays
    }
    let spans: { readonly day: string; readonly names: readonly Found[] } | null = null
    let exposure: { readonly day: string; readonly name: string } | null = null
    for (const day of days) {
      if (spans !== null && exposure !== null) break
      let names: string[]
      try { names = await readdir(join(this.#dir, day)) } catch { continue }
      if (spans === null) {
        const found = names.flatMap((name) => { const p = parseSpanFileName(name); return p === null ? [] : [{ ...p, name }] })
        const newest = found.reduce((a, f) => (f.businessDate > a ? f.businessDate : a), '')
        if (newest !== '') spans = { day, names: found.filter((f) => f.businessDate === newest).sort((a, b) => a.seq - b.seq) }
      }
      if (exposure === null) {
        const best = names.flatMap((name) => {
          const m = EXPOSURE_NAME.exec(name)
          const date = m === null ? null : realDate(m[3] as string, m[2] as string, m[1] as string)
          return date === null ? [] : [{ name, date }]
        }).sort((a, b) => b.date.localeCompare(a.date))[0]
        if (best !== undefined) exposure = { day, name: best.name }
      }
    }
    await this.#refreshSpans(spans, symbols)
    await this.#refreshExposure(exposure)
  }

  async #refreshSpans(found: { readonly day: string; readonly names: readonly Found[] } | null, symbols: ReadonlySet<string>): Promise<void> {
    if (found === null) {
      this.#entries = new Map()
      this.#current = []
      this.#dayFiles = 0
      this.#lastError = null
      return
    }
    const saved = await this.#manifest(found.day)
    const files: { readonly f: Found; readonly sig: string }[] = []
    for (const f of found.names) {
      try {
        const st = await stat(join(this.#dir, found.day, f.name))
        if (isFile(st)) files.push({ f, sig: `${st.size}:${st.mtimeMs}` })
      } catch {
        continue      // vanished between the listing and the stat
      }
    }
    // what is held of an unchanged file stands, one parsed for fewer symbols too (it still serves those)
    const held = (x: (typeof files)[number]): SpanEntry | undefined => {
      const had = this.#entries.get(x.f.name)
      return had?.sig === x.sig ? had : undefined
    }
    const due = (x: (typeof files)[number]): boolean => {
      const had = held(x)
      return had === undefined || (had.parsedFor !== null && !covers(had.parsedFor, symbols))
    }
    // one parse a pass, the newest due first (new, changed, or read for fewer stocks); the others wait for later passes
    const next = files.filter(due).at(-1)
    const parsed = next === undefined ? undefined : await this.#parse(found.day, next.f, next.sig, symbols)

    const entries = new Map<string, SpanEntry>()
    const ok: Parsed[] = []
    let error: string | null = null
    let failed = 0
    for (const x of files) {
      const entry = x === next ? parsed : held(x)
      if (entry === undefined) continue
      entries.set(x.f.name, entry)
      if (entry.file !== null && entry.parsedFor !== null) {
        ok.push({ file: entry.file, kind: entry.kind, symbols: entry.parsedFor, source: this.#view(entry, x.f.businessDate, saved.get(x.f.name) ?? null) })
      } else {
        error = entry.error
        failed++
      }
    }
    this.#entries = entries
    this.#lastError = error
    // a newest date whose every file failed keeps what was shown before
    if (ok.length > 0 || error === null) {
      this.#current = ok
      this.#dayFiles = files.length - failed
    }
  }

  /** One file, between two yields: what is queued (a page's request, a watcher's upload) goes first, and again after. */
  async #parse(day: string, f: Found, sig: string, symbols: ReadonlySet<string>): Promise<SpanEntry> {
    const base = { name: f.name, kind: f.kind, seq: f.seq, sig }
    try {
      const text = await readFile(join(this.#dir, day, f.name), 'utf8')
      await yieldTurn()
      const file = parseSpanFile(text, symbols)
      return { ...base, parsedFor: new Set(symbols), file, error: null }
    } catch (err) {
      return { ...base, parsedFor: null, file: null, error: `${f.name} did not parse: ${reason(err)}` }
    } finally {
      await yieldTurn()
    }
  }

  #view(e: SpanEntry, businessDate: string, savedAt: number | null): SpanSourceView {
    const label = e.kind === 'eod'
      ? `NSE SPAN end of day ${dayMonth(businessDate)}`
      : savedAt === null ? `NSE SPAN intraday ${e.seq}` : `NSE SPAN ${istClock(savedAt)}`
    return { file: e.name, label, businessDate, savedAt }
  }

  async #manifest(day: string): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    try {
      const doc: unknown = JSON.parse(await readFile(join(this.#dir, day, 'manifest.json'), 'utf8'))
      if (typeof doc !== 'object' || doc === null) return out
      for (const v of Object.values(doc)) {
        const name: unknown = (v as { name?: unknown } | null)?.name
        const at: unknown = (v as { savedAt?: unknown } | null)?.savedAt
        if (typeof name === 'string' && typeof at === 'number' && Number.isFinite(at)) out.set(name, at)
      }
    } catch {
      // no manifest, or not JSON: the files are still named, only their save times are unknown
    }
    return out
  }

  async #refreshExposure(found: { readonly day: string; readonly name: string } | null): Promise<void> {
    if (found === null) {
      this.#exposure = null
      this.#exposureSlot = null
      this.#exposureError = null
      return
    }
    const path = join(this.#dir, found.day, found.name)
    let sig: string
    try {
      const st = await stat(path)
      if (!isFile(st)) return
      sig = `${st.size}:${st.mtimeMs}`
    } catch {
      return
    }
    const had = this.#exposureSlot
    if (had !== null && had.name === found.name && had.sig === sig) return
    const m = EXPOSURE_NAME.exec(found.name) as RegExpExecArray
    const businessDate = realDate(m[3] as string, m[2] as string, m[1] as string) as string
    try {
      // NSE serves the exposure file gzipped, and a span job before 20 Oct 2026 saved it as served
      const raw = await readFile(path)
      const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 64 * 1024 * 1024 }) : raw).toString('utf8')
      const rates = parseExposureFile(text)
      this.#exposureSlot = { name: found.name, sig, rates, error: null }
      this.#exposure = { rates, source: { file: found.name, label: `NSE exposure ${dayMonth(businessDate)}`, businessDate, savedAt: null } }
      this.#exposureError = null
    } catch (err) {
      this.#exposureSlot = { name: found.name, sig, rates: null, error: null }
      this.#exposureError = `${found.name} did not parse: ${reason(err)}`
    }
  }
}

/** The SPAN legs of a book: options and futures not in `exclude`, with their full expiry. A share is cash segment and never one. */
export function spanPositions(s: BookSnapshot, exclude: ReadonlySet<string>): readonly SpanPosition[] {
  const out: SpanPosition[] = []
  for (const { leg } of s.legs) {
    if (leg.instrument === 'share' || exclude.has(leg.key)) continue
    out.push({
      symbol: s.stock, kind: leg.instrument, expiry: leg.expiry,
      strike: leg.instrument === 'option' ? leg.strike : null, optType: leg.instrument === 'option' ? leg.optType : null, qty: leg.qty,
    })
  }
  return out
}

/** Nothing to show: the span job has saved no file (or none that parses). */
export function noFileMargin(): MarginView {
  return {
    available: false, initial: null, exposure: null, total: null, peak: null, parts: null, span: null, exposureFile: null,
    stale: false, missing: [], notes: [NO_SPAN_NOTE],
  }
}

const NO_RATES: ReadonlyMap<string, number> = new Map()
const MINUTES_1300 = 13 * 60

function isStale(source: SpanSourceView, today: readonly Parsed[], now: number): boolean {
  const day = istDate(now)
  if (source.businessDate < previousTradingDay(day)) return true
  if (!marketOpenAt(now)) return false
  const ist = new Date(now + IST_OFFSET_MS)
  if (ist.getUTCHours() * 60 + ist.getUTCMinutes() < MINUTES_1300) return false
  return !today.some((t) => t.source.businessDate === day && t.kind === 'intraday')
}

export function marginFor(s: BookSnapshot, exclude: ReadonlySet<string>, store: SpanStore, now: number): MarginView {
  const cur = store.span()
  if (cur === null) {
    const err = store.lastError()
    const none = noFileMargin()
    return err === null ? none : { ...none, notes: [...none.notes, err] }
  }
  const exposure = store.exposure()
  const rates = exposure?.rates ?? NO_RATES
  const positions = spanPositions(s, exclude)
  const r = spanMargin(positions, cur.file, rates)

  // an open leg the master could not place has no contract to look up: named, never dropped
  const unplaced = s.unmatchedKeys.flatMap((k, i) => (exclude.has(k) ? [] : [s.unmatched[i] ?? k]))
  const missing = [...r.missing, ...unplaced]
  const left = s.legs.filter((l) => l.leg.instrument !== 'share' && exclude.has(l.leg.key)).length + s.unmatchedKeys.filter((k) => exclude.has(k)).length

  const notes: string[] = []
  if (!MARGIN_CHECKED) notes.push(UNCHECKED_NOTE)
  if (s.legs.some((l) => l.leg.instrument === 'share')) notes.push(SHARES_NOTE)
  if (left > 0) notes.push(`${left} unticked leg(s) left out`)
  for (const k of missing) notes.push(missingNote(k, exposure?.source.file ?? null))
  const err = store.lastError()
  if (err !== null) notes.push(`${err}; showing ${cur.source.file}`)
  const xerr = store.exposureError()
  if (xerr !== null) notes.push(`${xerr}; ${exposure === null ? 'no exposure rates shown' : `showing ${exposure.source.file}`}`)

  // over the files read so far that carry this book's stock: one parsed before the stock was held does not
  const read = store.today().filter((t) => t.symbols.has(s.stock))
  let peak: { total: number; label: string } | null = null
  for (const t of read) {
    const total = spanMargin(positions, t.file, rates).total
    if (peak === null || total > peak.total) peak = { total, label: t.source.label }
  }
  if (peak !== null) notes.push(peakNote(cur.source.businessDate, read.length, store.dayFiles()))

  return {
    available: true, initial: r.initial, exposure: r.exposure, total: r.total, peak,
    parts: {
      scanningRisk: r.scanningRisk, worstScenario: r.worstScenario, interMonthSpread: r.interMonthSpread,
      shortOptionMinimum: r.shortOptionMinimum, netOptionValue: r.netOptionValue,
    },
    span: cur.source, exposureFile: exposure?.source ?? null,
    stale: isStale(cur.source, store.today(), now), missing, notes,
  }
}

/** The margin of one open book; null when the trader holds none. */
export async function bookMargin(
  d: Pick<TradersDeps, 'legs' | 'snapshots' | 'span'>, trader: string, stock: string, nowMs: number, exclude: ReadonlySet<string> = new Set(),
): Promise<MarginView | null> {
  const today = istDate(nowMs)
  const version = d.legs.version(trader)   // before the read: a write during it leaves this version stale (recomputed next time), never old legs under the new one
  const legs = await d.legs.open(trader, stock)
  if (!legs.some((l) => isOpenLeg(l, today))) return null
  const snapshot = d.snapshots.get(trader, stock, legs, version)
  return marginFor(snapshot, exclude, d.span, nowMs)
}
