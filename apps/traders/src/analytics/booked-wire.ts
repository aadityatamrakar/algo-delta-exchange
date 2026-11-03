/**
 * The Booked page's wire (`GET /v1/traders/booked`, `GET /v1/traders/admin/booked`; spec 2026-10-23 G3): what
 * each expiry series of every stock the trader ever traded has booked, open or long closed, so P&L made in a stock
 * that no longer has a tab has a home. No runtime imports: the page loads this file for free.
 *
 * Money is rupees, before tax. Every figure counts only from the ledger's history start (`historyStart`).
 */

/**
 * open      a contract of it is still held (a live series, or shares): `net` adds its open P&L, as Series P&L does;
 * closed    every cycle ended flat by the trader's own trades;
 * settled   every cycle ended flat, at least one of them by NSE's expiry settlement;
 * unsettled it expired with a contract still open and no settlement close to settle it at (G2): its outcome, and
 *           so its net, is unknown.
 */
export type BookedStatus = 'open' | 'closed' | 'settled' | 'unsettled'

/** One expiry series of one stock (every client code, futures and options), or one month of the stock's shares. */
export interface BookedRow {
  readonly stock: string
  /** 'YYYY-MM-DD'; '' on a shares row. */
  readonly expiry: string
  readonly kind: 'series' | 'shares'
  /** 'YYYY-MM': a series' expiry month; a shares row's month of booking (the current month while a holding is open). */
  readonly month: string
  /** Σ −v of every cycle flat at a day's end (the ledger's reset rule), settlement included. */
  readonly booked: number
  /** The part of `booked` from cycles NSE's settlement closed: what the contracts held to expiry made. */
  readonly settled: number
  /** `chargesFor` over the row's real fills; a settlement fill carries none. An estimate until the rates are confirmed. */
  readonly charges: number
  /** Σ (LTP − net price) × qty of the open legs — the Series P&L block's "open" — on an open row; null otherwise or when unknown. */
  readonly openMtm: number | null
  /** booked − charges, + openMtm when open (so an open series' net is its Series P&L); null = an open part is unknown. */
  readonly net: number | null
  readonly status: BookedStatus
  /** Cycles booked (a contract closed twice counts twice). */
  readonly closedCycles: number
  /** Contracts still held at the end of the walk. */
  readonly openContracts: number
  /** The first and last day of a real trade in the row; null = none (a balance position only). */
  readonly firstDay: string | null
  readonly lastDay: string | null
  /** The history start, when it is later than the row's month start: the row counts from it. */
  readonly since: string | null
  readonly notes: readonly string[]
}

/** Rows summed. `openMtm` and `net` are null when any row's is (each such row says why). */
export interface BookedTotal {
  readonly booked: number
  readonly settled: number
  readonly charges: number
  readonly openMtm: number | null
  readonly net: number | null
  readonly rows: number
  /** Rows still open (or unsettled). */
  readonly open: number
}

export interface BookedMonth extends BookedTotal { readonly month: string }
export interface BookedStock extends BookedTotal { readonly stock: string }

export interface BookedView {
  readonly trader: string
  readonly asOf: number
  /** The months shown, 'YYYY-MM', inclusive. */
  readonly from: string
  readonly to: string
  /** Every month the trader has a row in, newest first: the month filter's choices. */
  readonly months: readonly string[]
  /** Newest month first, then by stock; a stock's shares row after its series. */
  readonly rows: readonly BookedRow[]
  /** Newest first. */
  readonly byMonth: readonly BookedMonth[]
  readonly byStock: readonly BookedStock[]
  readonly total: BookedTotal
  /** The first day the figures count from: the day after the opening balance, or the first trade file's day. */
  readonly historyStart: string | null
  /** The admin has saved the rates: `charges` is not an estimate. */
  readonly ratesConfirmed: boolean
  readonly notes: readonly string[]
}

export interface AdminBookedTrader {
  readonly trader: string
  readonly byMonth: readonly BookedMonth[]
  readonly total: BookedTotal
  readonly historyStart: string | null
}

/** Every trader's months over the same range, and the desk's. */
export interface AdminBookedView {
  readonly asOf: number
  readonly from: string
  readonly to: string
  readonly traders: readonly AdminBookedTrader[]
  /** The desk per month, newest first. */
  readonly byMonth: readonly BookedMonth[]
  readonly total: BookedTotal
  readonly ratesConfirmed: boolean
  readonly notes: readonly string[]
}
