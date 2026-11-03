/**
 * Series P&L (the operator's ruling, 22 Oct 2026): what a book's expiry series
 * has made, its open legs and the contracts it already closed.
 *
 * WHY: the ledger (ingest/ledger.ts) resets a contract's value when it is flat
 * at a day's end, so a contract opened and fully closed earlier leaves no leg,
 * and nothing on the page carried what it booked: the GrossMTM column is the
 * open legs only, the MTM block is the day's view, and the payoff is passed
 * realised 0. A book could show +70,000 on its legs while its series had lost
 * 51,000 on strikes already closed.
 *
 * A series is every contract of the stock with one expiry, across the
 * trader's client codes, open and closed, from the first trade the app holds.
 * Each LIVE expiry (expiry ≥ today, as `isOpenLeg` reads it) that the book
 * holds or the trader traded is one series; an expired one drops out, so a new
 * month starts a fresh book, and a next-month contract traded earlier carries
 * into it from its first trade.
 *
 *   open     Σ (LTP − net) × qty over the expiry's open legs: the GrossMTM
 *            column. A partial close inside an open cycle is already in it,
 *            since (LTP − v/q)·q = LTP·q − v, so it is never booked again.
 *   booked   Σ −v of every cycle flat at a day's end: the one cycle walk
 *            (cycles.ts, the ledger's reset rule and opening balance, client
 *            codes upper-cased as LedgerStore reads them), which the Booked
 *            page (booked.ts) reads too, so the two never disagree.
 *   charges  `chargesFor` over every real fill of the series after the
 *            balance's day, an order per day (order numbers repeat across days).
 *   net      open + booked − charges.
 *
 * Expiry settlement (spec 2026-10-23 G1/G2) is folded in: on the expiry
 * evening, once NSE's close for the day is in the history, the ledger's
 * settlement (`LedgerStore.settlement`, guarded by the trader's whole trade
 * record) closes every contract still open at its settlement price, so the series
 * settles — its open legs leave `open` (the ledger closes them the same way)
 * and what they made is booked. Settlement fills carry no charges.
 *
 * Shares have no expiry and are left out, with a note. `seriesPnl` is pure;
 * `seriesReader` reads its inputs, a minute per trader, stock and leg version
 * (the trades query walks the trader's whole history).
 */

import type { TradersDb } from '../db.ts'
import type { OpeningBalance } from '../ingest/ledger.ts'
import type { LedgerStore } from '../ingest/ledger-store.ts'
import type { SettlementFill } from '../ingest/settlement.ts'
import { istDate } from '../routes/kit.ts'
import { contractText, type Instrument, type OptType, type SeriesPnl, type SeriesTotal, type TraderTrade } from '../types.ts'
import { MINUTE_MS, TtlCache } from './cache.ts'
import { chargesFor, type ChargeSettingsStore, type Fill } from './charges.ts'
import { cycleWalk, dayText, fold, historyStart, type WalkTrade } from './cycles.ts'
import type { ChargeRates } from './wire.ts'

export type SeriesTrade = WalkTrade

/** An open leg of the book as its GrossMTM column reads it. */
export interface SeriesLeg {
  readonly key: string
  readonly instrument: Instrument; readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null
  /** (LTP − net price) × qty; null = no LTP. */
  readonly mtm: number | null
}

/** What the series are worked out from, besides the open legs. */
export interface SeriesBase {
  /** The trader's trades in the stock, every client code, any day (expired contracts and shares are skipped here anyway). */
  readonly trades: readonly SeriesTrade[]
  readonly balance: OpeningBalance | null
  /** LedgerStore.historyFrom: the earliest ODIN trade file's day. */
  readonly historyFrom: string | null
  readonly rates: ChargeRates
  /** NSE's settlement of the stock's contracts held to expiry (the ledger's, `LedgerStore.settlement`); absent = none. */
  readonly settlement?: readonly SettlementFill[]
}

export interface SeriesInputs extends SeriesBase {
  readonly trader: string
  readonly stock: string
  /** IST day: a series is live while its expiry is on or after it. */
  readonly today: string
  readonly legs: readonly SeriesLeg[]
  readonly lotSizeOf: (instrument: Instrument, expiry: string) => number | null
}

export interface SeriesResult { readonly series: readonly SeriesPnl[]; readonly total: SeriesTotal }

export const SHARES_NOTE = 'shares are left out of P&L: they have no expiry'
/** On a series NSE's settlement closed: what it booked at expiry is derived from the close, not a trade. */
export const SETTLED_NOTE = 'settled at expiry at the NSE close — derived, not a trade; no exercise STT or delivery stamp duty in charges'

/** One expiry's closed part: what its closed cycles booked, and the charges of its fills. */
interface ClosedPart { readonly booked: number; readonly closed: number; readonly settled: number; readonly from: string | null; readonly charges: number }

/** What the series hold before their open legs: it changes only with a trade, so the live frame keeps it per base. */
export interface SeriesClosed {
  readonly expiries: ReadonlyMap<string, ClosedPart>
  readonly start: string | null
  /** The charges of no fills, for an expiry the book holds but never traded. */
  readonly noFills: number
}

export function seriesPnl(i: SeriesInputs): SeriesResult {
  return withOpenLegs(seriesClosed(i), i)
}

/** The closed half of `seriesPnl`: the cycle walk and the charges, per live expiry. */
export function seriesClosed(i: Omit<SeriesInputs, 'legs'>): SeriesClosed {
  const live = (instrument: Instrument, expiry: string): boolean => instrument !== 'share' && expiry >= i.today
  const accs = new Map<string, { booked: number; closed: number; settled: number; from: string | null; readonly fills: Fill[] }>()

  // the one cycle walk (cycles.ts), this stock's live series only: each contract's cycles are its own, so the rest of the book does not change them
  const cycles = cycleWalk(i.balance, i.trades, i.settlement ?? [], (t) => t.stock === i.stock && live(t.instrument, t.expiry))
  for (const c of cycles) {
    // a cycle the walk never touched (a balance position still open) has nothing to book: its open legs bring its series in
    if (c.fills.length === 0 && c.closedOn === null) continue
    let a = accs.get(c.contract.expiry)
    if (a === undefined) {
      a = { booked: 0, closed: 0, settled: 0, from: null, fills: [] }
      accs.set(c.contract.expiry, a)
    }
    for (const t of c.fills) {
      if (a.from === null || t.day < a.from) a.from = t.day
      a.fills.push({ instrument: t.instrument, side: t.side, qty: t.qty, price: t.price, orderNo: `${t.day}|${t.orderNo}`, lotSize: i.lotSizeOf(t.instrument, t.expiry) })
    }
    if (c.closedOn === null) continue
    a.booked += c.booked
    a.closed++
    if (c.settled) a.settled++
  }
  const expiries = new Map([...accs].map(([expiry, a]) => [expiry, {
    booked: a.booked, closed: a.closed, settled: a.settled, from: a.from, charges: chargesFor(a.fills, i.rates, i.trader).total,
  }] as const))
  return { expiries, start: historyStart(i.balance, i.historyFrom), noFills: chargesFor([], i.rates, i.trader).total }
}

/** The open half: each live expiry's open legs added to its closed part, and the totals. */
export function withOpenLegs(c: SeriesClosed, i: Pick<SeriesInputs, 'today' | 'legs' | 'rates'>): SeriesResult {
  const live = (instrument: Instrument, expiry: string): boolean => instrument !== 'share' && expiry >= i.today
  const opens = new Map<string, { open: number; openLegs: number; readonly noLtp: SeriesLeg[] }>()
  let shares = false
  for (const l of i.legs) {
    if (l.instrument === 'share') { shares = true; continue }
    if (!live(l.instrument, l.expiry)) continue
    let o = opens.get(l.expiry)
    if (o === undefined) {
      o = { open: 0, openLegs: 0, noLtp: [] }
      opens.set(l.expiry, o)
    }
    o.openLegs++
    if (l.mtm === null) o.noLtp.push(l)
    else o.open += l.mtm
  }

  const series: SeriesPnl[] = [...new Set([...c.expiries.keys(), ...opens.keys()])].sort().map((expiry) => {
    const k = c.expiries.get(expiry) ?? { booked: 0, closed: 0, settled: 0, from: null, charges: c.noFills }
    const o = opens.get(expiry) ?? { open: 0, openLegs: 0, noLtp: [] }
    const open = o.noLtp.length > 0 ? null : fold(o.open)
    const booked = fold(k.booked)
    const charges = k.charges
    const gross = open === null ? null : fold(open + booked)
    const since = c.start !== null && c.start > `${expiry.slice(0, 7)}-01` ? c.start : null
    const notes = o.noLtp.map((l) => `${contractText(l)}: no LTP — open and net unknown`)
    if (since !== null) notes.push(`booked since ${dayText(since)} — the trade history starts there`)
    if (k.settled > 0) notes.push(SETTLED_NOTE)
    return {
      expiry, open, booked, gross, charges, net: gross === null ? null : fold(gross - charges),
      closedContracts: k.closed, openLegs: o.openLegs, from: k.from, since, noLtp: o.noLtp.map((l) => l.key), notes,
    }
  })

  const known = series.every((s) => s.open !== null)
  const sum = (f: (s: SeriesPnl) => number): number => fold(series.reduce((t, s) => t + f(s), 0))
  const froms = series.flatMap((s) => (s.from === null ? [] : [s.from])).sort()
  return {
    series,
    total: {
      open: known ? sum((s) => s.open as number) : null,
      booked: sum((s) => s.booked),
      gross: known ? sum((s) => s.gross as number) : null,
      charges: sum((s) => s.charges),
      net: known ? sum((s) => s.net as number) : null,
      closedContracts: series.reduce((t, s) => t + s.closedContracts, 0),
      from: froms[0] ?? null,
      ratesConfirmed: i.rates.confirmedBy !== null,
      notes: shares ? [SHARES_NOTE] : [],
    },
  }
}

// ---- its inputs, read ---------------------------------------------------------

const SERIES_FIELDS = {
  _id: 0, clientCode: 1, stock: 1, instrument: 1, expiry: 1, strike: 1, optType: 1, side: 1, qty: 1, price: 1, time: 1, day: 1, seq: 1, orderNo: 1, tradeNo: 1,
} as const

/** The stock's live contracts' trades: a range on `{ trader, stock, expiry }` (db.ts), never the trader's whole history. */
export function seriesTradesFilter(trader: string, stock: string, today: string): Record<string, unknown> {
  return { trader, stock, expiry: { $gte: today }, instrument: { $ne: 'share' } }
}

/** LedgerStore's order, so trades the ledger finds level (same day, time and line) keep one order on every walk. */
const ledgerOrder = (a: TraderTrade, b: TraderTrade): number =>
  (a.day < b.day ? -1 : a.day > b.day ? 1 : a.tradeNo < b.tradeNo ? -1 : a.tradeNo > b.tradeNo ? 1 : a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0)

/** A book's `SeriesBase` at `nowMs`; `version` is the trader's leg version, read before the legs. */
export type SeriesReader = (trader: string, stock: string, version: number, nowMs: number) => Promise<SeriesBase>

export interface SeriesReaderDeps {
  readonly db: TradersDb
  /** `settlement`: the ledger's own settlement of the trader (guarded by their whole trade record), never a second one. */
  readonly ledger: Pick<LedgerStore, 'balance' | 'historyFrom' | 'settlement'>
  readonly charges: Pick<ChargeSettingsStore, 'get'>
}

/**
 * Reads only the live contracts' trades (`seriesTradesFilter`), put in the ledger's own order here — a sort in the
 * query would tempt the planner onto the `{ trader, day, … }` index and the whole history — and keeps the answer a
 * minute per trader, stock, leg version and day: a new trade file bumps the version, a closed cycle that leaves the
 * legs as they were is seen within the minute, and so are a new rates table and the expiry day's close (which
 * settles the expiring series).
 */
export function seriesReader(d: SeriesReaderDeps): SeriesReader {
  const cache = new TtlCache<SeriesBase>(MINUTE_MS)
  return (trader, stock, version, nowMs) => {
    const today = istDate(nowMs)
    return cache.get(`${trader}|${stock}|${version}|${today}`, nowMs, async () => {
      const [trades, balance, historyFrom, rates, run] = await Promise.all([
        d.db.collection<TraderTrade>('traders-trades').find(seriesTradesFilter(trader, stock, today), { projection: SERIES_FIELDS }).toArray(),
        d.ledger.balance(trader),
        d.ledger.historyFrom(trader),
        d.charges.get(),
        d.ledger.settlement(trader),
      ])
      const sorted = trades.sort(ledgerOrder) as readonly SeriesTrade[]
      // the ledger's fills for this stock's live contracts: the record guard needs every trade, which this read lacks
      const settlement = run.fills.filter((f) => f.stock === stock && f.instrument !== 'share' && f.expiry >= today)
      return { trades: sorted, balance, historyFrom, rates, settlement }
    })
  }
}
