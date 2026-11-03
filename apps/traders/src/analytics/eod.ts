/**
 * THE end-of-day reader: yesterday's CLOSE and open interest from NSE's
 * bhavcopies, which the span job (scripts/span_job.py) saves unzipped under
 * `TRADERS_NSE_DIR` as `<YYYY-MM-DD>/BhavCopy_NSE_FO_0_0_0_<YYYYMMDD>_F_0000.csv`
 * and `…_CM_…csv`. "Yesterday" is the trading day before the session shown
 * (`sessionDay`: today, or on a day the market is closed the last trading
 * day), on the desk's calendar. The MTM block reads the close through it;
 * Release 3's Market Watch reads the OI through it too (`deps.eod`).
 *
 * `refresh()` stats the two files and parses one again only when the day or
 * the file changed (size or mtime), so the app may call it every minute. It
 * never throws: a file that is absent, unreadable or does not parse is listed
 * in `missing` (a failure as `<name>: <error>`) and every close it would have
 * given is null. Nothing is guessed from an older day's file.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { eodKey, parseCmBhavcopy, parseFoBhavcopy, type EodContract, type EodRow } from '@algomaker/span'
import { istDate } from '../routes/kit.ts'
import { previousTradingDay, sessionDay } from './calendar.ts'

export interface EodStatus {
  /** The trading day before sessionDay(today, IST), as of the last refresh. */
  readonly day: string
  /** The file name when it was read; null when it is missing or did not parse. */
  readonly fo: string | null; readonly cm: string | null
  /** File names not found for that day; one that did not parse as `<name>: <error>`. */
  readonly missing: readonly string[]
}

export const foFileName = (day: string): string => `BhavCopy_NSE_FO_0_0_0_${day.replaceAll('-', '')}_F_0000.csv`
export const cmFileName = (day: string): string => `BhavCopy_NSE_CM_0_0_0_${day.replaceAll('-', '')}_F_0000.csv`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** The file name of an `EodStatus.missing` entry (`<name>`, or `<name>: <error>` for one that did not parse). */
export const eodFileOf = (entry: string): string => (entry.includes(': ') ? entry.slice(0, entry.indexOf(': ')) : entry)

/**
 * One `EodStatus.missing` entry as the sentence a screen shows, ending in what
 * that screen cannot say without it: `NSE end-of-day file <name> for <DD Mon>
 * is missing — <consequence>`, or `… could not be read (<error>) — <consequence>`.
 */
export function missingEodNote(entry: string, consequence: string): string {
  const name = eodFileOf(entry)
  const d = /_(\d{4})(\d{2})(\d{2})_/.exec(name)
  const month = d === null ? undefined : MONTHS[Number(d[2]) - 1]
  const file = `NSE end-of-day file ${name}${d === null || month === undefined ? '' : ` for ${d[3]} ${month}`}`
  return name === entry ? `${file} is missing — ${consequence}` : `${file} could not be read (${entry.slice(name.length + 2)}) — ${consequence}`
}

const NOTHING: ReadonlyMap<string, EodRow> = new Map()

interface Slot {
  readonly name: string
  /** `size:mtime` of the file last read (or tried); null = not found. */
  sig: string | null
  rows: ReadonlyMap<string, EodRow>
  /** What `missing` says for it; null = read. */
  problem: string | null
}

const slot = (name: string): Slot => ({ name, sig: null, rows: NOTHING, problem: name })
function put(s: Slot, sig: string | null, rows: ReadonlyMap<string, EodRow>, problem: string | null): void {
  s.sig = sig
  s.rows = rows
  s.problem = problem
}
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** The trading day before the session shown at `nowMs`. */
const yesterdayOf = (nowMs: number): string => previousTradingDay(sessionDay(istDate(nowMs)))
/** A close of 0 or less cannot be a last price: it is no close. */
const priced = (x: number | undefined): number | null => (x !== undefined && Number.isFinite(x) && x > 0 ? x : null)

export class EodStore {
  readonly #dir: string
  readonly #now: () => number
  #day: string
  #fo: Slot
  #cm: Slot
  #running: Promise<void> | null = null

  constructor(opts: { readonly dir: string; readonly now: () => number }) {
    this.#dir = opts.dir
    this.#now = opts.now
    this.#day = yesterdayOf(opts.now())
    this.#fo = slot(foFileName(this.#day))
    this.#cm = slot(cmFileName(this.#day))
  }

  /** Concurrent calls share one pass. */
  refresh(): Promise<void> {
    this.#running ??= this.#refresh().finally(() => { this.#running = null })
    return this.#running
  }

  status(): EodStatus {
    const missing = [this.#fo, this.#cm].flatMap((s) => (s.problem === null ? [] : [s.problem]))
    return {
      day: this.#day,
      fo: this.#fo.problem === null ? this.#fo.name : null,
      cm: this.#cm.problem === null ? this.#cm.name : null,
      missing,
    }
  }

  /** Yesterday's CLOSE (not the settlement price — Phase 0 Q3); null when that day's file is missing or has no such row. */
  close(c: EodContract): number | null {
    return priced((c.instrument === 'share' ? this.#cm : this.#fo).rows.get(eodKey(c))?.close)
  }

  /** Yesterday's open interest, F&O only. */
  oi(c: EodContract): number | null {
    if (c.instrument === 'share') return null
    return this.#fo.rows.get(eodKey(c))?.oi ?? null
  }

  async #refresh(): Promise<void> {
    const day = yesterdayOf(this.#now())
    if (day !== this.#day) {
      this.#day = day
      this.#fo = slot(foFileName(day))
      this.#cm = slot(cmFileName(day))
    }
    await Promise.all([this.#load(this.#fo, day, parseFoBhavcopy), this.#load(this.#cm, day, parseCmBhavcopy)])
  }

  async #load(s: Slot, day: string, parse: (csv: string) => readonly EodRow[]): Promise<void> {
    const path = join(this.#dir, day, s.name)
    let sig: string
    try {
      const st = await stat(path)
      if (!st.isFile()) {
        put(s, null, NOTHING, `${s.name}: not a file`)
        return
      }
      sig = `${st.size}:${st.mtimeMs}`
    } catch (err) {
      const code = (err as { code?: unknown }).code
      put(s, null, NOTHING, code === 'ENOENT' || code === 'ENOTDIR' ? s.name : `${s.name}: ${reason(err)}`)
      return
    }
    if (sig === s.sig) return
    try {
      const rows = new Map<string, EodRow>()
      for (const r of parse(await readFile(path, 'utf8'))) rows.set(eodKey(r), r)
      put(s, sig, rows, null)
    } catch (err) {
      // the signature is kept, so the same bad file is not parsed again every minute; a changed one is
      put(s, sig, NOTHING, `${s.name}: ${reason(err)}`)
    }
  }
}
