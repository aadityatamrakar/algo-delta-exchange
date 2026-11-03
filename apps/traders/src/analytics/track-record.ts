/**
 * A trader's track record (spec 2026-11-01 P4): how each of their option series was traded — when it was opened,
 * how far out the shorts were sold, whether wings were bought, how many days it was adjusted, how far the stock ran
 * from entry, whether it was held into expiry — beside what it made; and the same rolled up into buckets.
 *
 * WHY: the desk playbooks were written from the whole desk's record (agent/playbooks/desk-record.md: most series win
 * small, the trend month loses what the winners made). A trader asking "how have I done" or "is this book on the
 * losing profile" needs their OWN figures, measured the same way, from data the app already holds.
 *
 * A series is one stock and expiry with at least one option fill. Its fills are its options and futures of that
 * expiry, every client code (the Booked row's scope). The entry day is its first option fill; an adjustment day is any
 * later day with a fill. Days are calendar days.
 *
 *   shortCallPct / shortPutPct  the qty-weighted strike SOLD on the entry day, % out of the money from the previous
 *                               trading day's settlement close (`HistoryStore.close`, unadjusted — the strikes are
 *                               too): + = out of the money, − = in it; null when none was sold or no close is held.
 *   maxUpPct / maxDownPct       the highest and lowest daily close from the entry day to the expiry (held there, or
 *                               live) or else to the last fill — the move the trader carried — % from the close
 *                               before the entry day, on the back-adjusted bars (`HistoryStore.bars`) so a split or
 *                               bonus is no move; maxUpPct ≥ 0, maxDownPct ≤ 0; null when the bars do not reach.
 *   heldToExpiry                NSE's settlement closed a cycle of it (the ledger's settledCycles).
 *   pnl                         the Booked page's net for that stock and expiry: `bookedView` over the trader's ledger
 *                               (booked.ts), never a second formula, so the chat and the page cannot disagree. A
 *                               live expiry has none here (its P&L is the book's); an expired row with no net (an
 *                               unsettled contract) is null with the row's reason.
 *
 * The summary is over the expired series in the window, stock and index series apart (an index weekly is a different
 * trade). Every P&L figure is over the series that have a P&L; `noPnl` counts the rest.
 *
 * Pure: the tool (agent/tools/track-record.ts) reads the trades, the closes, the bars and the Booked ledger.
 */

import type { DailyBar } from './context-wire.ts'
import {
  bookedKey, bookedView, historyNote, LOT_UNKNOWN_NOTE, LOT_UNKNOWN_ROW_NOTE, NO_HISTORY_NOTE, RATES_ESTIMATE_NOTE, SETTLEMENT_NOTE,
  type BookedLedger,
} from './booked.ts'
import type { TraderTrade } from '../types.ts'

/** A fill as the record needs it: no price (P&L is the ledger's), and never a client code, order or trade number. */
export type TrackFill = Pick<TraderTrade, 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType' | 'side' | 'qty' | 'day'>

export interface TrackInputs {
  /** The trader's option and future fills (shares are ignored). */
  readonly fills: readonly TrackFill[]
  /** IST day: an expiry on or after it is live. */
  readonly today: string
  readonly isIndex: (stock: string) => boolean
  /** The unadjusted settlement close (`HistoryStore.close`): a number; null = listed with none; undefined = not held. */
  readonly close: (stock: string, day: string) => number | null | undefined
  /** The back-adjusted daily bars, oldest → newest (`HistoryStore.bars`). */
  readonly bars: (stock: string) => readonly Pick<DailyBar, 'date' | 'close'>[]
  /** The trader's Booked ledger (`bookedReader`). */
  readonly ledger: BookedLedger
}

export interface TrackSeries {
  readonly stock: string
  readonly expiry: string
  readonly kind: 'stock' | 'index'
  readonly entryDay: string
  readonly dteAtEntry: number
  readonly lastDay: string
  readonly dteAtLast: number
  readonly adjustDays: number
  readonly contracts: number
  readonly shortCallPct: number | null
  readonly shortPutPct: number | null
  readonly wings: boolean
  readonly maxUpPct: number | null
  readonly maxDownPct: number | null
  readonly heldToExpiry: boolean
  readonly pnl: number | null
  readonly pnlNote: string | null
  /** The expiry is today or later: no P&L here, the move and adjustments so far. */
  readonly open: boolean
}

export interface TrackBucket {
  readonly bucket: string
  /** Series in the bucket with a P&L. */
  readonly n: number
  /** % of them that made money; null when n is 0. */
  readonly winRate: number | null
  readonly medianPnl: number | null
}

export interface TrackSummary {
  /** Expired series in the window. */
  readonly n: number
  /** Of them, the ones with no P&L: left out of every P&L figure below. */
  readonly noPnl: number
  readonly wins: number
  /** % of the series with a P&L that made money. */
  readonly winRate: number | null
  readonly medianWin: number | null
  /** ≤ 0. */
  readonly medianLoss: number | null
  /** The sum of the losses among the worst ⌈n/10⌉ P&Ls (< 0); null when that tenth holds no loss. */
  readonly worstTenthLoss: number | null
  /** The sum of every winning P&L. */
  readonly allWins: number
  /** By the largest |move| from entry (max of maxUpPct and −maxDownPct). */
  readonly byMove: readonly TrackBucket[]
  readonly byAdjustDays: readonly TrackBucket[]
  readonly heldToExpiry: TrackBucket
  readonly closedBefore: TrackBucket
  /** Medians over every expired series in the window, P&L or not. */
  readonly typical: {
    readonly dteAtEntry: number | null; readonly shortCallPct: number | null; readonly shortPutPct: number | null
    readonly adjustDays: number | null; readonly dteAtLast: number | null
  }
}

export interface TrackRecord {
  /** The window: series expiring on or after `from` (expired ones) and every live one. */
  readonly from: string
  /** Newest expiry first, at most `maxRows`. */
  readonly series: readonly TrackSeries[]
  /** Series in the window, before the cut. */
  readonly total: number
  readonly truncated: boolean
  readonly summary: { readonly stock: TrackSummary | null; readonly index: TrackSummary | null }
  /** The live series in the window. */
  readonly open: number
  /** `trackNotes` over the window: the Booked page's notes that apply, and the record's own. */
  readonly notes: readonly string[]
}

export const TRACK_MAX_ROWS = 40
export const TRACK_MONTHS_DEFAULT = 12
export const TRACK_MONTHS_MAX = 18
/** How far back the previous close is looked for: a long weekend with a holiday is 4 days. */
export const PREV_CLOSE_LOOKBACK_DAYS = 10

const DAY_MS = 86_400_000
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`)
const daysBetween = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS)
const minusDays = (day: string, n: number): string => new Date(dayMs(day) - n * DAY_MS).toISOString().slice(0, 10)
const round2 = (x: number): number => (x === 0 ? 0 : Math.round(x * 100) / 100)
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `today` less `months` calendar months, the day clamped to the month's last ('2026-03-31' − 1 → '2026-02-28'). */
export function windowStart(today: string, months: number): string {
  const k = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 - months
  const y = Math.floor(k / 12)
  const m = (k % 12) + 1
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(Number(today.slice(8, 10)), last)
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** The middle value (the mean of the middle two); null when none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return round2(s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2)
}

/** The settlement close of the last trading day before `day`: walks back over days with no file; a listed null stops it. */
function prevClose(close: TrackInputs['close'], stock: string, day: string): number | null {
  for (let n = 1; n <= PREV_CLOSE_LOOKBACK_DAYS; n++) {
    const c = close(stock, minusDays(day, n))
    if (c === undefined) continue
    return c !== null && Number.isFinite(c) && c > 0 ? c : null
  }
  return null
}

/** The qty-weighted strike of `optType` sold in `fills`, % out of the money from `ref`. */
function shortPct(fills: readonly TrackFill[], optType: 'CE' | 'PE', ref: number | null): number | null {
  let qty = 0
  let w = 0
  for (const f of fills) {
    if (f.side !== 'Sell' || f.optType !== optType || f.strike === null) continue
    qty += f.qty
    w += f.qty * f.strike
  }
  if (qty === 0 || ref === null) return null
  const k = w / qty
  return round2(optType === 'CE' ? (k / ref - 1) * 100 : (1 - k / ref) * 100)
}

/** The highest and lowest close from `entryDay` to `end`, % from the close before `entryDay`; null when the bars do not reach. */
function excursion(bars: readonly Pick<DailyBar, 'date' | 'close'>[], entryDay: string, end: string): { readonly up: number; readonly down: number } | null {
  let ref: number | null = null
  let up = 0
  let down = 0
  let seen = false
  for (const b of bars) {
    if (b.date < entryDay) { ref = b.close; continue }
    if (b.date > end) break
    if (ref === null || !(ref > 0)) return null
    const move = (b.close / ref - 1) * 100
    if (move > up) up = move
    if (move < down) down = move
    seen = true
  }
  return seen ? { up: round2(up), down: round2(down) } : null
}

export const LIVE_PNL_NOTE = 'expiry not reached: the P&L of a held series is get_book\'s'
export const NO_ROW_NOTE = 'not on the Booked page: every trade of it is before the trade history starts'

/** Every option series in the fills, each with its P&L from the Booked ledger. Unordered. Pure. */
export function trackSeries(i: TrackInputs): TrackSeries[] {
  const groups = new Map<string, TrackFill[]>()
  for (const f of i.fills) {
    if (f.instrument === 'share') continue
    const k = bookedKey(f.stock, f.expiry)
    const list = groups.get(k)
    if (list === undefined) groups.set(k, [f])
    else list.push(f)
  }
  // the Booked page's rows, priced by its own function (no open MTM: a live series' net is not read here)
  const view = bookedView(i.ledger, { asOf: 0, from: '0000-01', to: '9999-12' })
  const priced = new Map(view.rows.filter((r) => r.kind === 'series').map((r) => [bookedKey(r.stock, r.expiry), r]))
  const walked = new Map(i.ledger.rows.filter((r) => r.kind === 'series').map((r) => [bookedKey(r.stock, r.expiry), r]))
  const bars = new Map<string, readonly Pick<DailyBar, 'date' | 'close'>[]>()
  const barsOf = (stock: string): readonly Pick<DailyBar, 'date' | 'close'>[] => {
    let b = bars.get(stock)
    if (b === undefined) { b = i.bars(stock); bars.set(stock, b) }
    return b
  }

  const out: TrackSeries[] = []
  for (const [key, fills] of groups) {
    const options = fills.filter((f) => f.instrument === 'option')
    const first = options[0]
    if (first === undefined) continue   // futures alone are not an option series
    const { stock, expiry } = first
    const entryDay = options.reduce((d, f) => (f.day < d ? f.day : d), first.day)
    const days = new Set(fills.map((f) => f.day))
    const lastDay = [...days].reduce((d, x) => (x > d ? x : d), entryDay)
    const onEntry = options.filter((f) => f.day === entryDay)
    const ref = prevClose(i.close, stock, entryDay)
    const open = expiry >= i.today
    const heldToExpiry = !open && (walked.get(key)?.settledCycles ?? 0) > 0
    // the move the trader carried: to the expiry when held there (or still live), else to the last fill — a rally after
    // a series was closed is not its trend month
    const move = excursion(barsOf(stock), entryDay, open || heldToExpiry ? expiry : lastDay)
    const row = priced.get(key)
    const notes = (row?.notes ?? []).filter((n) => n !== LOT_UNKNOWN_ROW_NOTE)
    const pnl = open || row === undefined || row.net === null ? null : round2(row.net)
    const pnlNote = open ? LIVE_PNL_NOTE : row === undefined ? NO_ROW_NOTE : notes.length > 0 ? notes.join('; ') : null
    out.push({
      stock, expiry, kind: i.isIndex(stock) ? 'index' : 'stock',
      entryDay, dteAtEntry: daysBetween(entryDay, expiry), lastDay, dteAtLast: daysBetween(lastDay, expiry),
      adjustDays: [...days].filter((d) => d > entryDay).length,
      contracts: new Set(options.map((f) => `${f.strike ?? ''}|${f.optType ?? ''}`)).size,
      shortCallPct: shortPct(onEntry, 'CE', ref), shortPutPct: shortPct(onEntry, 'PE', ref),
      wings: onEntry.some((f) => f.side === 'Buy'),
      maxUpPct: move?.up ?? null, maxDownPct: move?.down ?? null,
      heldToExpiry,
      pnl, pnlNote, open,
    })
  }
  return out
}

// ---- the summary -----------------------------------------------------------------

const absMove = (s: TrackSeries): number | null =>
  (s.maxUpPct === null || s.maxDownPct === null ? null : Math.max(s.maxUpPct, -s.maxDownPct))

const MOVE_BUCKETS: readonly { readonly bucket: string; readonly has: (m: number) => boolean }[] = [
  { bucket: 'under 4%', has: (m) => m < 4 },
  { bucket: '4–7%', has: (m) => m >= 4 && m < 7 },
  { bucket: '7–10%', has: (m) => m >= 7 && m < 10 },
  { bucket: '10% or more', has: (m) => m >= 10 },
]

/** The spec's 1, 2–3, 4–7, 8+, with 0 (opened and never touched again) in the first. */
const ADJUST_BUCKETS: readonly { readonly bucket: string; readonly has: (d: number) => boolean }[] = [
  { bucket: '0–1', has: (d) => d <= 1 },
  { bucket: '2–3', has: (d) => d >= 2 && d <= 3 },
  { bucket: '4–7', has: (d) => d >= 4 && d <= 7 },
  { bucket: '8 or more', has: (d) => d >= 8 },
]

function bucketOf(bucket: string, series: readonly TrackSeries[]): TrackBucket {
  const pnls = series.flatMap((s) => (s.pnl === null ? [] : [s.pnl]))
  return {
    bucket, n: pnls.length,
    winRate: pnls.length === 0 ? null : round2((pnls.filter((p) => p > 0).length / pnls.length) * 100),
    medianPnl: median(pnls),
  }
}

const nums = (xs: readonly (number | null)[]): number[] => xs.filter((x): x is number => x !== null)

/** The summary of expired series (the caller picks them). Pure. */
export function summarise(series: readonly TrackSeries[]): TrackSummary {
  const known = series.filter((s) => s.pnl !== null)
  const pnls = known.map((s) => s.pnl as number)
  const wins = pnls.filter((p) => p > 0)
  // the losses among the worst ⌈n/10⌉: a winner that falls in that tenth is not netted against them
  const worst = [...pnls].sort((a, b) => a - b).slice(0, Math.ceil(pnls.length / 10)).filter((p) => p < 0)
  const byMove = MOVE_BUCKETS.map((b) => bucketOf(b.bucket, known.filter((s) => { const m = absMove(s); return m !== null && b.has(m) })))
  const noMove = known.filter((s) => absMove(s) === null)
  return {
    n: series.length, noPnl: series.length - known.length,
    wins: wins.length,
    winRate: pnls.length === 0 ? null : round2((wins.length / pnls.length) * 100),
    medianWin: median(wins), medianLoss: median(pnls.filter((p) => p < 0)),
    worstTenthLoss: worst.length === 0 ? null : round2(worst.reduce((a, b) => a + b, 0)),
    allWins: round2(wins.reduce((a, b) => a + b, 0)),
    byMove: noMove.length === 0 ? byMove : [...byMove, bucketOf('no history', noMove)],
    byAdjustDays: ADJUST_BUCKETS.map((b) => bucketOf(b.bucket, known.filter((s) => b.has(s.adjustDays)))),
    heldToExpiry: bucketOf('held to expiry', known.filter((s) => s.heldToExpiry)),
    closedBefore: bucketOf('closed before expiry', known.filter((s) => !s.heldToExpiry)),
    typical: {
      dteAtEntry: median(series.map((s) => s.dteAtEntry)),
      shortCallPct: median(nums(series.map((s) => s.shortCallPct))),
      shortPutPct: median(nums(series.map((s) => s.shortPutPct))),
      adjustDays: median(series.map((s) => s.adjustDays)),
      dteAtLast: median(series.map((s) => s.dteAtLast)),
    },
  }
}

/** Newest expiry first, then stock. */
const newestFirst = (a: TrackSeries, b: TrackSeries): number => cmp(b.expiry, a.expiry) || cmp(a.stock, b.stock)

/**
 * One window of the series: the live ones and the expired ones expiring on or after `from`, of one stock or all;
 * newest first, cut at `maxRows`; the summary over every expired one in the window, stock and index apart; the
 * notes that apply to it, from the same ledger the P&L came from. Pure.
 */
export function trackRecord(
  all: readonly TrackSeries[],
  o: { readonly from: string; readonly stock: string | null; readonly ledger: BookedLedger; readonly maxRows?: number },
): TrackRecord {
  const inWindow = all.filter((s) => (s.open || s.expiry >= o.from) && (o.stock === null || s.stock === o.stock)).sort(newestFirst)
  const max = o.maxRows ?? TRACK_MAX_ROWS
  const expired = inWindow.filter((s) => !s.open)
  const of = (kind: TrackSeries['kind']): TrackSummary | null => {
    const xs = expired.filter((s) => s.kind === kind)
    return xs.length === 0 ? null : summarise(xs)
  }
  return {
    from: o.from, series: inWindow.slice(0, max), total: inWindow.length, truncated: inWindow.length > max,
    summary: { stock: of('stock'), index: of('index') }, open: inWindow.length - expired.length,
    notes: trackNotes(o.ledger, inWindow),
  }
}

/**
 * The Booked page's notes that apply to a window, and the record's own: where the history starts, charges that are
 * estimates, settlement's assumptions and the shares it delivers, series with no P&L or no closes.
 */
export function trackNotes(l: BookedLedger, series: readonly TrackSeries[]): string[] {
  const notes = [l.historyStart === null ? NO_HISTORY_NOTE : historyNote(l.historyStart)]
  if (!l.ratesConfirmed) notes.push(RATES_ESTIMATE_NOTE)
  const keys = new Set(series.map((s) => bookedKey(s.stock, s.expiry)))
  if (l.rows.some((r) => r.kind === 'series' && r.lotUnknown && keys.has(bookedKey(r.stock, r.expiry)))) notes.push(LOT_UNKNOWN_NOTE)
  const expired = series.filter((s) => !s.open)
  if (expired.some((s) => s.heldToExpiry)) {
    notes.push(SETTLEMENT_NOTE)
    notes.push('A short option settled in the money delivers shares: what they made afterwards is on the Booked page\'s shares rows, not in the series\' P&L.')
  }
  const noPnl = expired.filter((s) => s.pnl === null).length
  if (noPnl > 0) notes.push(`${noPnl} expired ${noPnl === 1 ? 'series has' : 'series have'} no P&L (pnlNote says why): left out of the summary's P&L figures`)
  const noBars = series.filter((s) => s.maxUpPct === null).length
  if (noBars > 0) notes.push(`${noBars} ${noBars === 1 ? 'series has' : 'series have'} no daily closes around the entry in the history: the move from entry is null`)
  return notes
}
