/**
 * What Release 3 sends the page, one section per task. Types only; the page
 * imports them with `import type`.
 *
 * A LEAF, like wire.ts: it imports types from `../types.ts`, `./wire.ts` and
 * `@algomaker/payoff` (type-only) alone, so the page's type program never walks
 * the server's graph. Later tasks append their own sections.
 */

import type { Goal, LiquidIvSource, Move, PayoffView, PlanScore } from '@algomaker/payoff'
import type { BandState, BookView } from '../types.ts'
import type { HypotheticalLeg, ToNeutralize } from './wire.ts'

// ---------------------------------------------------------------------------
// Market Watch (Task 3)
// ---------------------------------------------------------------------------

export interface MarketSide {
  readonly ltp: number | null; readonly change: number | null; readonly changePct: number | null
  readonly oi: number | null; readonly oiChange: number | null; readonly volume: number | null
  readonly iv: number | null; readonly ivSource: LiquidIvSource
  /** Per share; vega per vol point, theta per day. */
  readonly delta: number | null; readonly gamma: number | null; readonly vega: number | null; readonly theta: number | null
  readonly bf: number | null; readonly bf2: number | null; readonly ratio: number | null
  readonly ageMs: number | null
  /** Not a live price: older than the quote cache's stale threshold, or the stored snapshot. The price is still shown. */
  readonly stale: boolean
}

export interface MarketRow { readonly strike: number; readonly straddle: number | null; readonly ce: MarketSide | null; readonly pe: MarketSide | null }

export interface MarketChain {
  readonly expiry: string; readonly lotSize: number; readonly step: number | null
  /** null = no future listed for this expiry (an index weekly lists none). A listed one with no quote: null prices, stale. */
  readonly future: { readonly ltp: number | null; readonly change: number | null; readonly changePct: number | null; readonly ageMs: number | null; readonly stale: boolean } | null
  readonly forward: number | null; readonly forwardSource: 'future' | 'parity' | 'carry' | null
  readonly rows: readonly MarketRow[]
}

/** A stock's listed contracts from today, for the Add leg dialog's pick lists: each option expiry with its lot and strikes, and whether a future lists on it. */
export interface ContractsView {
  readonly stock: string
  readonly expiries: readonly { readonly expiry: string; readonly future: boolean; readonly lotSize: number | null; readonly strikes: readonly number[] }[]
}

/**
 * One second of a book, from the quote cache alone (`GET /books/:stock/live`, Server-Sent Events): each leg's prices
 * and gross MTM, the spot and nearest future, the MTM block's today and total, the P&L. Sent only when it differs from the last.
 */
export interface LiveFrame {
  readonly stock: string
  readonly asOf: number
  readonly closed: boolean
  readonly feedAlive: boolean
  readonly spot: number | null
  readonly future: number | null
  readonly legs: readonly {
    readonly key: string; readonly ltp: number | null; readonly bid: number | null; readonly ask: number | null
    readonly stale: boolean; readonly grossMtm: number | null
  }[]
  /**
   * The MTM block's Current MTM: `mtmToday` its Today column, `mtmTotal` its total, the book's Day MTM. Null when it
   * cannot be worked out, or the day has not begun (`mtmReason` says which, when it is that).
   */
  readonly mtmToday: number | null
  readonly mtmTotal: number | null
  /** The block's charges on today's fills (`expense.today`): with the two above, Today's parts. Null as they are. Optional: an older server sends none. */
  readonly mtmCharges?: number | null
  /** Why the day figures are null: 'market opens 09:15', 'market closed today'; null = the day has begun (or the block could not be read). Optional: an older server sends none. */
  readonly mtmReason?: string | null
  /**
   * The book's P&L, its `seriesTotal` at this tick's LTPs (the same arithmetic): `seriesNet` = `seriesOpen` +
   * `seriesBooked` − `seriesCharges`. Net and open are null when an open leg of a live series has no LTP. Absent when
   * the book has no live series (shares only), the server has no series reader, the series could not be read, or the
   * server is older.
   */
  readonly seriesNet?: number | null
  readonly seriesOpen?: number | null
  readonly seriesBooked?: number
  readonly seriesCharges?: number
}

export interface MarketWatchView {
  readonly stock: string; readonly asOf: number; readonly spot: number | null; readonly feedAlive: boolean
  /** The spot is not a live price (stale, or the stored snapshot), or there is none. */
  readonly spotStale: boolean
  /** false = the token cap was reached: only strikes some other screen already watches are shown. */
  readonly fullChains: boolean
  /** The trade date OI and price change are measured from. */
  readonly oiDay: string | null
  readonly chains: readonly MarketChain[]
  readonly labels: { readonly bf: string; readonly bf2: string; readonly ratio: string }
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Portfolio (Task 11)
// ---------------------------------------------------------------------------

/**
 * One expiry of a book ('' = its shares): the legs' position greeks, and their Open P&L (`mtm`: at net price, R1's,
 * before charges). `pnl`: that expiry's series net (P&L); null for the shares or when unknown. A live series with no
 * open leg has a row of its own (no greeks). Optional: an older server sends none.
 */
export interface MonthRow {
  readonly expiry: string; readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number; readonly mtm: number
  readonly pnl?: number | null
}

/**
 * One book. Delta in shares, and in lots of the nearest listed future; position
 * greeks, vega per vol point, theta per day. The P&L figures, never one standing
 * in for another (spec G5; the page's names since 23 Oct):
 *  - `pnl`, "P&L": the book's series net (`seriesTotal.net`: booked on the closed
 *    contracts + the open legs at LTP − all charges, every live expiry since its
 *    first trade). Null when unknown or the book has no live series
 *    (`pnlReason`); a book with no live series is left out of every P&L sum,
 *    never makes it unknown. Optional: an older server sends none.
 *  - `mtmDay`, "Today": the MTM block's total (carried legs from yesterday's
 *    close plus today's trades, less the charges on today's fills). Null when
 *    the block cannot work it out: no block, a missing end-of-day file, or the
 *    day has not begun (`mtmDayReason`: before 09:15 IST, or a closed day).
 *  - `openPnl`: Σ (LTP − net price) × qty over the open legs, before charges;
 *    the legs' own MTM column. Always a number. A part of P&L, not shown as a total.
 * Margin is the NSE SPAN + exposure total, null when not available.
 */
export interface PortfolioRow {
  readonly stock: string; readonly spot: number | null; readonly lotSize: number | null
  readonly delta: number; readonly deltaLots: number | null; readonly gamma: number; readonly vega: number; readonly theta: number
  readonly mtmDay: number | null; readonly mtmDayReason: string | null; readonly openPnl: number
  readonly pnl?: number | null; readonly pnlReason?: string | null
  readonly margin: number | null; readonly marginLabel: string | null
  readonly band: BandState | null; readonly bandSentence: string | null; readonly months: readonly MonthRow[]
}

/**
 * Across underlyings delta is added as money: deltaValue = Σ delta × spot (an index at its level). Margin sums the known ones; marginMissing names the rest.
 * Day MTM and P&L are null as soon as one book's is: a total of the known ones would read as the whole. A book with no
 * live series (shares only) has no P&L to count and is left out of the P&L sum; with none to count, P&L is null.
 * `pnlReason` says why a null P&L is (the row's reasons).
 */
export interface PortfolioTotals {
  readonly books: number; readonly outOfBand: number; readonly deltaValue: number; readonly vega: number; readonly theta: number
  readonly mtmDay: number | null; readonly openPnl: number; readonly pnl?: number | null; readonly pnlReason?: string | null
  readonly margin: number; readonly marginMissing: readonly string[]
}

export interface PortfolioView { readonly trader: string; readonly asOf: number; readonly rows: readonly PortfolioRow[]; readonly totals: PortfolioTotals; readonly warnings: readonly string[] }

/** One underlying summed over every trader holding it; margin sums the known ones. */
export interface StockAcross {
  readonly stock: string; readonly traders: number; readonly delta: number; readonly deltaLots: number | null
  readonly gamma: number; readonly vega: number; readonly theta: number
  readonly mtmDay: number | null; readonly openPnl: number; readonly pnl?: number | null; readonly pnlReason?: string | null; readonly margin: number
}

export interface AdminPortfolioView {
  readonly asOf: number
  readonly traders: readonly { readonly trader: string; readonly totals: PortfolioTotals }[]
  readonly stocks: readonly StockAcross[]
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Groups (Task 6)
// ---------------------------------------------------------------------------

export interface LegGroup { readonly name: string; readonly keys: readonly string[] }

export interface GroupView { name: string; keys: string[]; legCount: number; totals: BookView['totals']; payoff: PayoffView | null }
export interface GroupsView { stock: string; asOf: number; groups: GroupView[]; ungrouped: GroupView }

// ---------------------------------------------------------------------------
// Advice and band (Tasks 9-10), and the repair card they sit beside (Task 7)
// ---------------------------------------------------------------------------

/** R2's web `WhatIfLeg` with no IV: the Scenario tab values each row at the market's vol. */
export type WhatIfLeg = Omit<HypotheticalLeg, 'id' | 'iv'>

export interface BandStatus {
  readonly state: BandState
  readonly netDelta: number | null
  readonly bandShares: number | null
  readonly bandLots: number | null
  readonly outByLots: number
  readonly lotSize: number | null
  readonly source: 'engine' | 'override'
  readonly toNeutralize: ToNeutralize | null
  readonly marketOpen: boolean
  readonly sentence: string
}

export interface RepairCardPlan { moves: readonly Move[]; score: PlanScore; flags: readonly string[]; lines: string[]; whatIf: WhatIfLeg[] }

export interface RepairView {
  stock: string; expiry: string | null; asOf: number; computedAt: number; cached: boolean
  goals: { goal: Goal; plans: RepairCardPlan[] }[]
  offset: { shares: number; note: string } | null
  warnings: string[]; error: string | null
}

/** relief-r's advice on one book, from a clean rule state. It only suggests: its one control is "Show on payoff" (`whatIf`). */
export interface AdviceCard {
  readonly stock: string
  /** The newest quote the card was read off; its `computedAt` when it read none. */
  readonly asOf: number
  /** When the pass ran: every viewer of the book shares it for a minute. */
  readonly computedAt: number
  readonly status: 'advice' | 'hold' | 'unavailable'
  /** The first line; 'Hold', 'Market closed', 'Advice starts at 09:20' or 'Nothing to adjust in options'; or why there is no advice. */
  readonly headline: string
  /** 'Sell 2 lots TCS OCT 3500 CE', 'Buy back 1 lot TCS OCT 3300 PE'; an index weekly by its day, 'NIFTY 20OCT 25050 CE'. */
  readonly lines: readonly string[]
  /** relief-r's own reason, verbatim; '' when it was not asked (unavailable). */
  readonly reason: string
  readonly trigger: string
  /** The lines as Scenario rows, each at its chain mid. */
  readonly whatIf: readonly WhatIfLeg[]
  /** The history line first, then P4, the shift, the expiry advised on, any override, and what the engine left out. */
  readonly notes: readonly string[]
  readonly band: BandStatus
  readonly historyFrom: string | null
}
