/**
 * The rules every ODIN `OnLineBackup` file shares: CSV with no header and no
 * quoting, space-padded fields, CRLF line ends, IST times. ODIN appends to the
 * day's file during the session, so a last line without its line end is one
 * still being written: it is held back until the next upload completes it.
 */

import { ParseError } from '../csv.ts'
import type { ParsedFile } from '../parsers.ts'
import { IST_OFFSET_MS } from '../../routes/kit.ts'

export interface OdinLine { readonly lineNo: number; readonly fields: readonly string[] }

/** Complete lines with their 1-based line numbers; blank lines skipped, every field trimmed. */
export function odinLines(text: string): OdinLine[] {
  const parts = text.split('\n')
  parts.pop()   // after the last '\n': '' for a finished file, else a line ODIN is still writing
  const out: OdinLine[] = []
  parts.forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() !== '') out.push({ lineNo: i + 1, fields: line.split(',').map((f) => f.trim()) })
  })
  return out
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** A real calendar day as UTC midnight ms, or NaN. A two-digit year is 20YY. */
function dayMs(dd: string, mon: string, year: string): number {
  const m = MONTHS.indexOf(mon.toUpperCase())
  const y = Number(year.length === 2 ? `20${year}` : year)
  const d = Number(dd)
  const ms = Date.UTC(y, m, d)
  const back = new Date(ms)
  return m >= 0 && back.getUTCFullYear() === y && back.getUTCMonth() === m && back.getUTCDate() === d ? ms : NaN
}

const TIME = /^(\d{2}) ([A-Za-z]{3}) (\d{4}|\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** '19 OCT 2026 09:21:09' or '19 Oct 26 09:18:42', IST, to epoch ms. */
export function odinTime(v: string): number {
  const m = TIME.exec(v)
  const day = m ? dayMs(m[1]!, m[2]!, m[3]!) : NaN
  const [hh, mm, ss] = m ? [Number(m[4]), Number(m[5]), Number(m[6])] : [NaN, NaN, NaN]
  if (!Number.isFinite(day) || !(hh < 24 && mm < 60 && ss < 60)) throw new Error(`time "${v}" is not an ODIN time`)
  return day + ((hh * 60 + mm) * 60 + ss) * 1000 - IST_OFFSET_MS
}

const EXPIRY = /^(\d{2}) ?([A-Za-z]{3}) ?(\d{4})$/

/** '27OCT2026' or '08 OCT 2026' to '2026-10-27'. */
export function odinExpiry(v: string): string {
  const m = EXPIRY.exec(v)
  const day = m ? dayMs(m[1]!, m[2]!, m[3]!) : NaN
  if (!Number.isFinite(day)) throw new Error(`expiry "${v}" is not an ODIN expiry`)
  return new Date(day).toISOString().slice(0, 10)
}

export function odinSide(v: string): 'Buy' | 'Sell' {
  if (v === '1') return 'Buy'
  if (v === '2') return 'Sell'
  throw new Error(`side "${v}" must be 1 (buy) or 2 (sell)`)
}

export function odinInt(v: string, what: string): number {
  const n = /^[+-]?\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isSafeInteger(n)) throw new Error(`${what} "${v}" is not a whole number`)
  return n
}

export function odinNum(v: string, what: string): number {
  const n = v === '' ? NaN : Number(v)
  if (!Number.isFinite(n)) throw new Error(`${what} "${v}" is not a number`)
  return n
}

export type SkippedLine = NonNullable<ParsedFile['skipped']>[number]

/**
 * Every complete line through `row`. A line `row` throws on is skipped and
 * recorded with its reason, and the rest still land: ODIN appends all
 * session, so one odd line must not freeze the day's file. Only a file with
 * complete lines of which none can be read is a ParseError.
 */
export function odinRows<T>(text: string, row: (fields: readonly string[], lineNo: number) => T): { readonly rows: T[]; readonly skipped: SkippedLine[] } {
  const rows: T[] = []
  const skipped: SkippedLine[] = []
  for (const { lineNo, fields } of odinLines(text)) {
    try {
      rows.push(row(fields, lineNo))
    } catch (e) {
      if (!(e instanceof Error)) throw e
      skipped.push({ lineNo, reason: e.message })
    }
  }
  const first = skipped[0]
  if (rows.length === 0 && first) throw new ParseError(`no line could be read; line ${first.lineNo}: ${first.reason}`)
  return { rows, skipped }
}
