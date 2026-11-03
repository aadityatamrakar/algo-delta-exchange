/**
 * The wire shapes of the daily record (`GET /daily`) and of the admin's data status (`GET /admin/data-status`).
 * Types only: the web names this file, so it names nothing of the server (traders-imports.test.ts holds it to that).
 *
 * THE DAILY RECORD. Once a trading day, at 15:45 IST, the server writes one row per book (trader, stock) from the
 * same in-process functions the pages read — the BookView, the MTM block, the margin — into `traders-daily`, and
 * keeps it forever. It is a record of what the page said at the close, which no later read can rebuild: there are
 * no live prices for a past day. Days before the record began have no row, and none is made up.
 *
 * Money in rupees. A figure the page cannot give is null (shown "—"), never a 0 and never a sum of the known ones.
 */

/** One book's close, as written. */
export interface DailyRow {
  readonly trader: string; readonly stock: string
  /** IST trading day, YYYY-MM-DD. */
  readonly day: string
  /** When the row was written (epoch ms). */
  readonly at: number
  /** The MTM block's Current MTM total (carried legs from yesterday's close plus today's trades, after today's charges); null = the block cannot say. */
  readonly dayMtm: number | null
  /** Σ GrossMTM of the open legs, (LTP − net price) × qty; null when an open leg has no LTP. 0 for a book flat at the close. */
  readonly openPnl: number | null
  /** The book's live series together (BookView.seriesTotal): net of charges, and what its closed cycles booked. Null = the page had none. */
  readonly seriesNet: number | null
  readonly seriesBooked: number | null
  /** The underlying's spot at the close: what turns the delta into money across books. Null = no price. */
  readonly spot: number | null
  /** The book's greek totals as the Portfolio row and the strip read them (BookView.totals): delta in shares, gamma per share, theta and vega in ₹. */
  readonly delta: number; readonly gamma: number; readonly theta: number; readonly vega: number
  /** The book's NSE SPAN + exposure margin and the file it came from; null = no margin figure then. A flat book is 0 with no file. */
  readonly margin: number | null; readonly marginSource: string | null
  /** Open legs at the close. */
  readonly legs: number
  /** The page's own caveats for the book: the BookView's warnings plus the contracts the MTM block left out. */
  readonly warnings: number
}

/** The books of one day together. A total is null as soon as one book's figure is, and `missing` names those books. */
export interface DailyTotals {
  readonly books: number; readonly legs: number; readonly warnings: number
  readonly dayMtm: number | null; readonly openPnl: number | null
  readonly seriesNet: number | null; readonly seriesBooked: number | null
  /** Σ delta × spot (delta in shares is not added across underlyings); null as soon as a book has no spot. */
  readonly deltaValue: number | null
  readonly vega: number; readonly theta: number
  /** Σ of the books' margins; null as soon as a book has none, so an unknown margin never reads as ₹0. */
  readonly margin: number | null
  readonly missing: {
    readonly dayMtm: readonly string[]; readonly openPnl: readonly string[]; readonly series: readonly string[]
    readonly spot: readonly string[]; readonly margin: readonly string[]
  }
}

export interface DailyDay {
  readonly day: string
  /** The latest write among the day's rows. */
  readonly at: number
  readonly books: readonly DailyRow[]
  readonly totals: DailyTotals
}

export interface DailyView {
  readonly trader: string
  readonly asOf: number
  /** The trader's first recorded day ever; null = nothing recorded yet. */
  readonly recordedFrom: string | null
  /** Newest day first. */
  readonly days: readonly DailyDay[]
  readonly notes: readonly string[]
}

// ---- data status (admin) ---------------------------------------------------------

/** One trader on one trading day. */
export interface DataStatusDay {
  readonly day: string
  /** Files the trader's PC wrote that day (their modified time, which carries the year; ODIN's names do not). */
  readonly files: number
  /** Trade lines and order rows stored for the day, and the orders whose status says Rejected. */
  readonly trades: number; readonly orders: number; readonly rejected: number
  /** No files, while another trader had trade lines that day. */
  readonly noFilesWhileOthersTraded: boolean
}

export interface DataStatusWatcher {
  /** Null = the watcher has never reported. */
  readonly lastHeartbeatAt: number | null
  readonly lastUploadAt: number | null
  readonly version: string | null
  /** No heartbeat for 180 s as of `asOf`, or never one. */
  readonly offline: boolean
}

export interface DataStatusTrader {
  readonly trader: string
  readonly disabled: boolean
  readonly watcher: DataStatusWatcher
  /** One per `DataStatusView.days`, in its order. */
  readonly days: readonly DataStatusDay[]
}

export interface DataStatusView {
  readonly asOf: number
  /** The last trading days by the calendar, newest first. */
  readonly days: readonly string[]
  readonly traders: readonly DataStatusTrader[]
  /** One sentence per trader with a flagged day. */
  readonly flags: readonly string[]
  readonly notes: readonly string[]
}
