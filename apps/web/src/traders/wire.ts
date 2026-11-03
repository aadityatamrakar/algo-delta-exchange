/**
 * Pure helpers between the wire shapes and what the page prints or sends.
 * No DOM, no network: unit-testable on their own.
 */

import { inr } from '../format.ts'
import { contractText } from '../../../traders/src/types.ts'
import type { Instrument, LegView, ManualLegInput, OptType, StoredFile, WatcherStatus } from '../../../traders/src/types.ts'

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/**
 * The tooltip of a day figure ("—") the page will not print because the server that sent it is the old one. The web
 * goes live on a build, the server on the operator's restart: until then a server's `mtmDay`, `mtmToday` and block are
 * on the OLD basis (the open cycle's charges in them, no pre-open null) and their names are the new ones. Only the new
 * server sends the reason keys (`mtmDayReason` on a portfolio row, `mtmReason` on a live frame, `dayReason` on the block,
 * each null when the day has begun), so their presence is what says its figures are on the new basis (spec G5).
 */
export const SERVER_UPDATE_PENDING = 'server update pending'

/** IST `HH:MM` of an epoch-ms instant. */
export function istHm(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16)
}

/** IST calendar day `YYYY-MM-DD` of an epoch-ms instant. */
export function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * VolHedge v50's Maturity text: month and two-digit year, `2026-10-27` → `Oct 26`;
 * `''` (a share) → `EQ`. The same output as the server's `maturityLabel`, which
 * the page cannot import; leg rows arrive with theirs already filled in.
 */
export function maturityLabel(expiry: string): string {
  if (expiry === '') return 'EQ'
  const m = /^\d{2}(\d{2})-(\d{2})-\d{2}$/.exec(expiry)
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1]
  return m === null || month === undefined ? expiry : `${month} ${m[1]}`
}

/**
 * An expiry by its day, `2026-10-20` → `20 Oct 26`; `''` (a share) → `EQ`. An
 * index's weeklies share a month, so a row per expiry needs the date where
 * `maturityLabel` would print `Oct 26` twice.
 */
export function expiryDayLabel(expiry: string): string {
  if (expiry === '') return 'EQ'
  const m = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(expiry)
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1]
  return m === null || month === undefined ? expiry : `${m[3]} ${month} ${m[1]}`
}

/** A figure that may be unknown, at fixed decimals: null prints `—`, never 0. */
export function orDash(n: number | null, digits: number): string {
  return n === null ? '—' : inr(n, digits)
}

/** What the Type column prints: `FUT`, `CE`, `PE`, `EQ`. */
export function typeText(l: Pick<LegView, 'instrument' | 'optType'>): string {
  if (l.instrument === 'future') return 'FUT'
  if (l.instrument === 'share') return 'EQ'
  return l.optType ?? '—'
}

/** Signed lots, or null when the lot size is unknown. Fractions are kept: a half lot should look wrong. */
export function lotsOf(qty: number, lotSize: number | null): number | null {
  return lotSize === null || lotSize <= 0 ? null : qty / lotSize
}

/** The lot size of a book, read from any leg that carries one. */
export function bookLotSize(legs: readonly Pick<LegView, 'lotSize'>[]): number | null {
  for (const l of legs) if (l.lotSize !== null && l.lotSize > 0) return l.lotSize
  return null
}

/**
 * Up to `digits` decimals, trailing zeros dropped: a whole-book delta reads
 * `-525` as VolHedge prints it, and the same figure per share keeps its
 * decimals instead of rounding to `-0`.
 */
export function figure(n: number, digits: number): string {
  if (!Number.isFinite(n)) return '—'
  const s = n.toLocaleString('en-IN', { maximumFractionDigits: digits })
  return s === '-0' ? '0' : s
}

/** An IV decimal in vol points, without the float noise of `iv × 100` (0.245 → 24.5). */
export function ivPoints(iv: number): number {
  return Math.round(iv * 1e6) / 1e4
}

/** `legKey`-less one-line name of a leg for confirmations. */
export function legName(stock: string, l: Pick<LegView, 'instrument' | 'expiry' | 'strike' | 'optType'>): string {
  return `${stock} ${contractText(l)}`
}

/** How an unmatched row from the server reads in the list. */
export function notUnderstood(line: string): string {
  return /^not understood/i.test(line) ? line : `not understood: ${line}`
}

export interface LegForm {
  instrument: Instrument
  expiry: string
  strike: string
  optType: OptType
  qty: string
  avgPrice: string
  note: string
}

export const EMPTY_LEG_FORM: LegForm = {
  instrument: 'share', expiry: '', strike: '', optType: 'CE', qty: '', avgPrice: '', note: '',
}

function num(s: string): number | null {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** The request body for a form, or the first thing wrong with it. */
export function legBody(f: LegForm): { body: Omit<ManualLegInput, 'stock'> } | { problem: string } {
  const qty = num(f.qty)
  if (qty === null || qty === 0 || !Number.isInteger(qty)) return { problem: 'Quantity must be a non-zero whole number of shares (negative = short).' }
  const avgPrice = num(f.avgPrice)
  if (avgPrice === null || avgPrice < 0) return { problem: 'Average price must be a number, zero or more.' }
  if (f.instrument === 'share') {
    return { body: { instrument: 'share', expiry: '', strike: null, optType: null, qty, avgPrice, note: f.note } }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.expiry)) return { problem: 'Expiry must be a date, YYYY-MM-DD.' }
  if (f.instrument === 'future') {
    return { body: { instrument: 'future', expiry: f.expiry, strike: null, optType: null, qty, avgPrice, note: f.note } }
  }
  const strike = num(f.strike)
  if (strike === null || strike <= 0) return { problem: 'Strike must be a positive number.' }
  return { body: { instrument: 'option', expiry: f.expiry, strike, optType: f.optType, qty, avgPrice, note: f.note } }
}

/** IST `HH:MM:SS` of an epoch-ms instant (an order's entry time). */
export function istHms(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19)
}

/** The watcher is offline after this long without a heartbeat. */
export const WATCHER_OFFLINE_MS = 180_000

export function watcherText(w: WatcherStatus | null): string {
  return w === null
    ? 'never'
    : `last heartbeat ${istHm(w.lastHeartbeatAt)} · v${w.version} · ${w.fileCount} files`
}

export function watcherState(w: WatcherStatus | null, now: number): string {
  return w === null ? 'never connected' : now - w.lastHeartbeatAt > WATCHER_OFFLINE_MS ? 'offline' : 'online'
}

/** `GET /files` keeps the first 20 skipped lines of a file; a full list may stand for more. */
const SKIPPED_KEPT = 20

/** What is wrong with a stored file, or null when its last parse was clean (the book view's wording). */
export function fileProblem(f: Pick<StoredFile, 'path' | 'parseError' | 'skipped'>): string | null {
  if (f.parseError !== null) return `${f.path} did not parse: ${f.parseError}`
  const s = f.skipped ?? []
  const first = s[0]
  if (first === undefined) return null
  const n = s.length >= SKIPPED_KEPT ? `${SKIPPED_KEPT} or more lines` : s.length === 1 ? '1 line' : `${s.length} lines`
  return `${n} of ${f.path} ${s.length === 1 ? 'was' : 'were'} skipped: line ${first.lineNo}: ${first.reason}`
}
