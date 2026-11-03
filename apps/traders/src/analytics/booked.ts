/**
 * Booked P&L (spec 2026-10-23 G3, item 2): what every expiry series of every stock the trader ever traded has
 * booked — open, closed or settled — with its charges and net.
 *
 * WHY: until this page, booked P&L lived only in the Series P&L block of a held stock's LIVE expiries
 * (series-pnl.ts). A stock closed out, or an expiry gone by, took what it made with it: on 23 Oct, 89% of one
 * trader's realised cycles, and ₹69L of another's, sat in stocks with no open leg and so no tab.
 *
 * The figures are the Series P&L block's, off the same walk (cycles.ts), so the two can never disagree:
 *   booked   Σ −v of every cycle flat at a day's end (the ledger's reset rule), settlement included.
 *   settled  the part of booked whose cycles NSE's expiry settlement closed: what was held to expiry made. Not the
 *            settlement fills' own value — a future's fill is its whole notional at the close, which says nothing.
 *   charges  `chargesFor` over the row's real fills, an order per day; a settlement fill carries none (G2).
 *   net      booked − charges for a closed series; an open one adds its open MTM (the block's "open", the GrossMTM
 *            column), so its net IS its Series P&L.
 *
 * SHARES get their own row per stock, booked on the same net-value rule (flat at a day's end books −v), never left
 * out. WHY: settlement delivers an in-the-money stock option into shares at the close (G2) and the trader sells them
 * in the cash market; the option's cycle books its intrinsic value and the shares book the rest (sale − close).
 * Left out, a delivered position would show half its outcome. A share has no expiry, so a shares row's month is the
 * month a holding went flat — the day it was booked — and a holding still open sits in the current month.
 *
 * Every figure counts only from the ledger's history start (the day after the opening balance, or the first ODIN
 * trade file's day), and the view says so: a cycle opened before it and closed after books only what the app saw.
 *
 * `bookedLedger` (the walk: every row of the history, no prices) and `bookedView` (a range of months, the open MTM,
 * the totals) are pure. `bookedReader` reads the walk's inputs and keeps the ledger per trader and leg version for
 * five minutes: the walk reads the trader's whole history (one trader holds ~50k trades), so it runs only when that
 * history (or what settles it) has moved, or the five minutes are up.
 */

import type { TradersDb } from '../db.ts'
import type { OpeningBalance } from '../ingest/ledger.ts'
import type { LegStore } from '../books/legs.ts'
import type { LedgerStore } from '../ingest/ledger-store.ts'
import type { SettlementFill, Unsettled } from '../ingest/settlement.ts'
import { lotSizeOf, type TradersMaster } from '../market/master.ts'
import { istDate } from '../routes/kit.ts'
import type { Instrument } from '../types.ts'
import type { AdminBookedView, BookedMonth, BookedRow, BookedStatus, BookedStock, BookedTotal, BookedView } from './booked-wire.ts'
import { MINUTE_MS, TtlCache } from './cache.ts'
import { brokerageFor, chargesFor, type ChargeSettingsStore, type Fill } from './charges.ts'
import { cycleWalk, dayText, fold, historyStart, type WalkTrade } from './cycles.ts'
import type { ChargeRates } from './wire.ts'

export interface BookedInputs {
  readonly trader: string
  /** Every trade the trader has, every stock and client code, in the ledger's order (LedgerStore's query order). */
  readonly trades: readonly WalkTrade[]
  readonly balance: OpeningBalance | null
  /** LedgerStore.historyFrom: the earliest ODIN trade file's day. */
  readonly historyFrom: string | null
  readonly rates: ChargeRates
  /** NSE's settlement of every contract held to expiry (the ledger's, `LedgerStore.settlement(trader).fills`). */
  readonly settlement: readonly SettlementFill[]
  /** The contracts that expired open with no close to settle them at, and why (`LedgerStore.settlement(trader).unsettled`). */
  readonly unsettled?: readonly Unsettled[]
  /** IST day: a series is live while its expiry is on or after it. */
  readonly today: string
  /** A contract's lot size (per-lot brokerage); null = unknown, which pays per order. */
  readonly lotSizeOf: (stock: string, instrument: Instrument, expiry: string) => number | null
}

/** One row as the walk alone knows it: no open MTM, no status yet. */
export interface LedgerRow {
  readonly stock: string; readonly expiry: string; readonly kind: BookedRow['kind']; readonly month: string
  readonly booked: number; readonly settled: number; readonly charges: number
  readonly closedCycles: number; readonly settledCycles: number; readonly openContracts: number
  readonly firstDay: string | null; readonly lastDay: string | null
  /** Why its expired contracts were not settled (from the ledger's settlement); empty when it has none or nothing said. */
  readonly unsettled: readonly string[]
  /**
   * The trader's brokerage is per lot and a contract of the row has no lot size in today's master (an expired one is
   * dropped from it): its fills paid per order instead, so its charges are an estimate.
   */
  readonly lotUnknown: boolean
}

/** Every row of the trader's history: what the reader keeps. */
export interface BookedLedger {
  readonly trader: string
  readonly today: string
  readonly rows: readonly LedgerRow[]
  readonly historyStart: string | null
  readonly ratesConfirmed: boolean
}

/** How an open series' MTM is keyed in `bookedView`'s map: its stock and expiry ('' for shares). */
export const bookedKey = (stock: string, expiry: string): string => `${stock}|${expiry}`

export const SHARES_BOOKED_NOTE =
  "Shares are booked on the same rule as contracts — when a holding is flat at a day's end — in the month that happens; a holding still open sits in this month."
export const SETTLEMENT_NOTE =
  "Settled = closed by NSE's expiry settlement at the closing price, derived from the history, not a trade. Every in-the-money stock option is taken as exercised (do-not-exercise is not modelled); settlement carries no charges (exercise STT and delivery stamp duty are not modelled)."
export const RATES_ESTIMATE_NOTE = 'charges rates not confirmed — charges and net are estimates until an admin confirms them'
export const NET_UNKNOWN_NOTE = 'Net total unknown: a row has no open P&L or no settlement price (marked on the row).'
export const NO_HISTORY_NOTE = 'No trade history yet: the figures start with the first ODIN trade file.'
/** Per-lot brokerage on a contract the master no longer lists (it expired): counted per order, an estimate. */
export const LOT_UNKNOWN_ROW_NOTE = 'lot size no longer in the instrument master (expired) — brokerage counted per order, an estimate'
export const LOT_UNKNOWN_NOTE =
  'Per-lot brokerage: a series whose lot size the instrument master no longer lists (it expired) is charged per order instead — its charges are an estimate (marked on the row).'

/** The history-start line: every figure counts from that day. */
export const historyNote = (start: string): string =>
  `Figures count from ${dayText(start)}: the trade history the app holds starts there, and nothing before it is in them.`

// ---- months --------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

export const isMonth = (v: unknown): v is string => typeof v === 'string' && MONTH.test(v)

/** '2026-10' + -2 -> '2026-08'. */
export function addMonths(month: string, n: number): string {
  const k = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n
  return `${String(Math.floor(k / 12)).padStart(4, '0')}-${String((k % 12) + 1).padStart(2, '0')}`
}

/** The page's default: the current month and the two before it. */
export function defaultRange(today: string): { readonly from: string; readonly to: string } {
  const to = today.slice(0, 7)
  return { from: addMonths(to, -2), to }
}

// ---- the walk --------------------------------------------------------------------

interface Acc {
  readonly stock: string; readonly expiry: string; readonly kind: BookedRow['kind']; readonly month: string
  booked: number; settled: number
  closedCycles: number; settledCycles: number; openContracts: number
  firstDay: string | null; lastDay: string | null
  readonly fills: Fill[]
  readonly unsettled: Set<string>
  lotUnknown: boolean
}

/** Every row of the trader's history, from the one cycle walk. Pure. */
export function bookedLedger(i: BookedInputs): BookedLedger {
  const accs = new Map<string, Acc>()
  const accOf = (stock: string, expiry: string, kind: BookedRow['kind'], month: string): Acc => {
    const k = `${stock}|${expiry}|${month}`
    let a = accs.get(k)
    if (a === undefined) {
      a = { stock, expiry, kind, month, booked: 0, settled: 0, closedCycles: 0, settledCycles: 0, openContracts: 0, firstDay: null, lastDay: null, fills: [], unsettled: new Set(), lotUnknown: false }
      accs.set(k, a)
    }
    return a
  }
  const reasons = new Map<string, string[]>()
  for (const u of i.unsettled ?? []) {
    const k = bookedKey(u.stock, u.expiry)
    const list = reasons.get(k) ?? []
    list.push(u.reason)
    reasons.set(k, list)
  }

  // per-lot brokerage needs each F&O fill's lot size, and the master lists live contracts only: an expired one falls
  // back to per order (chargesFor's rule), which changes its charges the day after expiry — said on its row
  const perLot = brokerageFor(i.rates, i.trader).mode === 'lot'
  for (const c of cycleWalk(i.balance, i.trades, i.settlement)) {
    const { stock, instrument, expiry } = c.contract
    const shares = instrument === 'share'
    const a = accOf(stock, expiry, shares ? 'shares' : 'series', shares ? (c.closedOn ?? i.today).slice(0, 7) : expiry.slice(0, 7))
    const lotSize = c.fills.length === 0 ? null : i.lotSizeOf(stock, instrument, expiry)
    if (perLot && !shares && c.fills.length > 0 && (lotSize === null || lotSize <= 0)) a.lotUnknown = true
    for (const t of c.fills) {
      if (a.firstDay === null || t.day < a.firstDay) a.firstDay = t.day
      if (a.lastDay === null || t.day > a.lastDay) a.lastDay = t.day
      a.fills.push({ instrument: t.instrument, side: t.side, qty: t.qty, price: t.price, orderNo: `${t.day}|${t.orderNo}`, lotSize })
    }
    if (c.closedOn === null) {
      a.openContracts++
      if (!shares && expiry < i.today) for (const r of reasons.get(bookedKey(stock, expiry)) ?? []) a.unsettled.add(r)
      continue
    }
    a.booked += c.booked
    a.closedCycles++
    if (c.settled) { a.settled += c.booked; a.settledCycles++ }
  }

  const rows: LedgerRow[] = [...accs.values()].map((a) => ({
    stock: a.stock, expiry: a.expiry, kind: a.kind, month: a.month,
    booked: fold(a.booked), settled: fold(a.settled), charges: chargesFor(a.fills, i.rates, i.trader).total,
    closedCycles: a.closedCycles, settledCycles: a.settledCycles, openContracts: a.openContracts,
    firstDay: a.firstDay, lastDay: a.lastDay, unsettled: [...a.unsettled], lotUnknown: a.lotUnknown,
  }))
  return { trader: i.trader, today: i.today, rows, historyStart: historyStart(i.balance, i.historyFrom), ratesConfirmed: i.rates.confirmedBy !== null }
}

// ---- one range, priced -----------------------------------------------------------

export interface BookedViewOptions {
  readonly asOf: number
  readonly from: string
  readonly to: string
  /**
   * Each open series' open MTM by `bookedKey(stock, expiry)` — the Series P&L block's `open` — and each stock's open
   * shares' (expiry ''); null = known open but unpriced. Only series with an open leg belong here.
   */
  readonly openMtm?: ReadonlyMap<string, number | null>
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** Newest month first, then stock, a stock's series by expiry before its shares. */
const rowOrder = (a: BookedRow, b: BookedRow): number =>
  cmp(b.month, a.month) || cmp(a.stock, b.stock) || cmp(a.kind, b.kind) || cmp(a.expiry, b.expiry)

function priced(r: LedgerRow, today: string, open: ReadonlyMap<string, number | null>, start: string | null): BookedRow {
  const key = bookedKey(r.stock, r.expiry)
  // a shares row's open holding is in the current month's row only
  const listed = open.has(key) && (r.kind === 'series' || r.month === today.slice(0, 7))
  const held = r.openContracts > 0 || listed
  const live = r.kind === 'shares' || r.expiry >= today
  const status: BookedStatus = held ? (live ? 'open' : 'unsettled') : r.settledCycles > 0 ? 'settled' : 'closed'
  const openMtm = status === 'open' ? (open.get(key) ?? null) : null
  const net = status === 'unsettled' || (status === 'open' && openMtm === null) ? null
    : fold(r.booked + (openMtm ?? 0) - r.charges)
  const since = start !== null && start > `${r.month}-01` ? start : null
  const notes: string[] = []
  if (since !== null) notes.push(`counts from ${dayText(since)} — the trade history starts there`)
  if (status === 'open' && openMtm === null) notes.push('open P&L unknown (no LTP, or the book did not answer) — net unknown')
  if (status === 'unsettled') {
    notes.push(...(r.unsettled.length > 0 ? r.unsettled
      : [`expired ${dayText(r.expiry)} with ${r.openContracts} contract(s) still open and no NSE close to settle them at — net unknown`]))
  }
  if (r.lotUnknown) notes.push(LOT_UNKNOWN_ROW_NOTE)
  return {
    stock: r.stock, expiry: r.expiry, kind: r.kind, month: r.month,
    booked: r.booked, settled: r.settled, charges: r.charges, openMtm, net, status,
    closedCycles: r.closedCycles, openContracts: r.openContracts, firstDay: r.firstDay, lastDay: r.lastDay, since, notes,
  }
}

const ZERO: BookedTotal = { booked: 0, settled: 0, charges: 0, openMtm: 0, net: 0, rows: 0, open: 0 }
const plus = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : fold(a + b))

/** Two totals summed; an unknown open MTM or net stays unknown. */
export function addTotals(a: BookedTotal, b: BookedTotal): BookedTotal {
  return {
    booked: fold(a.booked + b.booked), settled: fold(a.settled + b.settled), charges: a.charges + b.charges,
    openMtm: plus(a.openMtm, b.openMtm), net: plus(a.net, b.net), rows: a.rows + b.rows, open: a.open + b.open,
  }
}

function totalOf(rows: readonly BookedRow[]): BookedTotal {
  return rows.reduce<BookedTotal>((t, r) => addTotals(t, {
    booked: r.booked, settled: r.settled, charges: r.charges,
    openMtm: r.status === 'open' ? r.openMtm : 0, net: r.net, rows: 1, open: r.status === 'open' || r.status === 'unsettled' ? 1 : 0,
  }), ZERO)
}

function groupBy<K extends string>(rows: readonly BookedRow[], key: (r: BookedRow) => K): Map<K, BookedRow[]> {
  const out = new Map<K, BookedRow[]>()
  for (const r of rows) {
    const list = out.get(key(r))
    if (list === undefined) out.set(key(r), [r])
    else list.push(r)
  }
  return out
}

/** One range of months of the ledger, each open row priced by `openMtm`, with its totals and notes. Pure. */
export function bookedView(l: BookedLedger, o: BookedViewOptions): BookedView {
  const open = o.openMtm ?? new Map<string, number | null>()
  // a series (or shares) open only through a leg the walk has no trade of — a manual leg — still has a row
  const current = l.today.slice(0, 7)
  const have = new Set(l.rows.filter((r) => r.kind === 'series' || r.month === current).map((r) => bookedKey(r.stock, r.expiry)))
  const extra: LedgerRow[] = [...open.keys()].filter((k) => !have.has(k)).map((k) => {
    const [stock = '', expiry = ''] = k.split('|')
    return {
      stock, expiry, kind: expiry === '' ? 'shares' : 'series', month: expiry === '' ? current : expiry.slice(0, 7),
      booked: 0, settled: 0, charges: 0, closedCycles: 0, settledCycles: 0, openContracts: 0, firstDay: null, lastDay: null, unsettled: [], lotUnknown: false,
    }
  })
  const all = [...l.rows, ...extra]
  const inRange = all.filter((r) => r.month >= o.from && r.month <= o.to)
  const rows = inRange.map((r) => priced(r, l.today, open, l.historyStart)).sort(rowOrder)

  const byMonth: BookedMonth[] = [...groupBy(rows, (r) => r.month)].map(([month, rs]) => ({ month, ...totalOf(rs) }))
  const byStock: BookedStock[] = [...groupBy(rows, (r) => r.stock)].map(([stock, rs]) => ({ stock, ...totalOf(rs) }))
    .sort((a, b) => cmp(a.stock, b.stock))
  const total = totalOf(rows)

  const notes = [l.historyStart === null ? NO_HISTORY_NOTE : historyNote(l.historyStart)]
  if (rows.some((r) => r.kind === 'shares')) notes.push(SHARES_BOOKED_NOTE)
  if (rows.some((r) => r.settled !== 0 || r.status === 'settled')) notes.push(SETTLEMENT_NOTE)
  if (!l.ratesConfirmed) notes.push(RATES_ESTIMATE_NOTE)
  if (inRange.some((r) => r.lotUnknown)) notes.push(LOT_UNKNOWN_NOTE)
  if (total.net === null) notes.push(NET_UNKNOWN_NOTE)
  return {
    trader: l.trader, asOf: o.asOf, from: o.from, to: o.to,
    months: [...new Set(all.map((r) => r.month))].sort().reverse(),
    rows, byMonth, byStock, total, historyStart: l.historyStart, ratesConfirmed: l.ratesConfirmed, notes,
  }
}

/** `bookedLedger` then `bookedView`: one trader's range in one call. */
export function bookedOf(i: BookedInputs & BookedViewOptions): BookedView {
  return bookedView(bookedLedger(i), i)
}

// ---- the desk ----------------------------------------------------------------------

/** Every trader's view over one range, rolled up per trader per month and for the desk. */
export function adminBookedOf(views: readonly BookedView[], o: Pick<BookedViewOptions, 'asOf' | 'from' | 'to'>): AdminBookedView {
  const desk = new Map<string, BookedTotal>()
  for (const v of views) for (const m of v.byMonth) desk.set(m.month, addTotals(desk.get(m.month) ?? ZERO, m))
  const byMonth: BookedMonth[] = [...desk].sort((a, b) => cmp(b[0], a[0])).map(([month, t]) => ({ month, ...t }))
  const total = views.reduce((t, v) => addTotals(t, v.total), ZERO)
  const ratesConfirmed = views.every((v) => v.ratesConfirmed)
  const notes = views.map((v) => `${v.trader}: ${v.historyStart === null ? 'no trade history yet' : `figures count from ${dayText(v.historyStart)}`}`)
  if (views.some((v) => v.rows.some((r) => r.kind === 'shares'))) notes.push(SHARES_BOOKED_NOTE)
  if (views.some((v) => v.rows.some((r) => r.settled !== 0 || r.status === 'settled'))) notes.push(SETTLEMENT_NOTE)
  if (!ratesConfirmed) notes.push(RATES_ESTIMATE_NOTE)
  if (views.some((v) => v.notes.includes(LOT_UNKNOWN_NOTE))) notes.push(LOT_UNKNOWN_NOTE)
  if (total.net === null) notes.push(NET_UNKNOWN_NOTE)
  return {
    asOf: o.asOf, from: o.from, to: o.to,
    traders: views.map((v) => ({ trader: v.trader, byMonth: v.byMonth, total: v.total, historyStart: v.historyStart })),
    byMonth, total, ratesConfirmed, notes,
  }
}

// ---- its inputs, read ----------------------------------------------------------------

const BOOKED_FIELDS = {
  _id: 0, clientCode: 1, stock: 1, instrument: 1, expiry: 1, strike: 1, optType: 1, side: 1, qty: 1, price: 1, time: 1, day: 1, seq: 1, orderNo: 1,
} as const

/** How long a walked ledger is kept: its key already changes with every leg write, so the TTL only bounds staleness. */
export const BOOKED_TTL_MS = 5 * MINUTE_MS

/** One trader's ledger at `nowMs`, kept five minutes per leg version. */
export type BookedReader = (trader: string, nowMs: number) => Promise<BookedLedger>

export interface BookedReaderDeps {
  readonly db: TradersDb
  /** `version(trader)`: bumped by every leg write (a trade file applied, a settlement recompute), read before the walk. */
  readonly legs: Pick<LegStore, 'version'>
  /** `settlement`: the ledger's own settlement of the trader (guarded by their whole trade record), never a second one. */
  readonly ledger: Pick<LedgerStore, 'balance' | 'historyFrom' | 'settlement'>
  readonly charges: Pick<ChargeSettingsStore, 'get'>
  readonly master: () => TradersMaster
}

/**
 * Reads the trader's whole history, only the fields the walk needs, in the unique index's order (`{ trader, day,
 * tradeNo, orderNo }`, as LedgerStore reads it, so trades the ledger finds level keep one order on every walk), and
 * keeps the walked ledger — not the trades — per trader, leg version and day for five minutes. The walk is the
 * page's whole cost (lalit: 46k trades, ~470 ms read + ~170 ms walk), so it runs again only when something it reads
 * has moved: a trade file or a settlement recompute bumps the leg version (read before the walk, so a write landing
 * during it leaves this version stale, never old figures under the new one) and is seen at once; a new rates table
 * within the five minutes.
 */
export function bookedReader(d: BookedReaderDeps): BookedReader {
  const cache = new TtlCache<BookedLedger>(BOOKED_TTL_MS)
  return (trader, nowMs) => {
    const today = istDate(nowMs)
    return cache.get(`${trader}|${d.legs.version(trader)}|${today}`, nowMs, async () => {
      const [trades, balance, historyFrom, rates, settlement] = await Promise.all([
        d.db.collection<WalkTrade>('traders-trades').find({ trader }, { projection: BOOKED_FIELDS }).sort({ day: 1, tradeNo: 1, orderNo: 1 }).toArray(),
        d.ledger.balance(trader),
        d.ledger.historyFrom(trader),
        d.charges.get(),
        d.ledger.settlement(trader),
      ])
      const m = d.master()
      return bookedLedger({
        trader, trades, balance, historyFrom, rates, settlement: settlement.fills, unsettled: settlement.unsettled, today,
        lotSizeOf: (stock, instrument, expiry) => lotSizeOf(m, { stock, instrument, expiry, strike: null, optType: null }),
      })
    })
  }
}
