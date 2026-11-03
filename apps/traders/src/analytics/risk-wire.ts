/**
 * Risk on the wire: the portfolio stress, the historical replay, concentration and correlation (`GET /risk`), and the
 * results-event risk of each held book (`GET /events`) — types only, so the page, the routes and the assistant compile
 * against one contract. Spec: docs/superpowers/specs/2026-10-24-traders-risk-design.md.
 *
 * Every rupee figure here is a CHANGE from the book's value now under a stated shock, never a P&L headline: the page
 * labels them "Change" or "Loss", beside P&L and Today, never instead of them.
 * A figure that cannot be computed is null with a warning saying why.
 */

/** One held book's sensitivity to the market, as `/risk` reads it. */
export interface RiskBook {
  readonly stock: string
  /** Beta of the stock's daily log returns to NIFTY's over the last ≤250 aligned days; 1 for NIFTY. Null under 60. */
  readonly beta: number | null
  readonly betaDays: number
  /** Correlation of those returns to NIFTY's; null as beta. */
  readonly niftyCorr: number | null
  /** Book delta in shares (the book view's net delta) and in rupees (× spot). */
  readonly deltaShares: number | null
  readonly deltaRupees: number | null
  /** deltaRupees × beta: rupees the book moves per 100% NIFTY move, linear. */
  readonly betaDeltaRupees: number | null
  /** Full reprice: the change for NIFTY +1% and −1% (the stock moved beta × 1%, vol unchanged), rupees. */
  readonly niftyUp1: number | null
  readonly niftyDown1: number | null
  /** σ of a day, decimal: HV20 (else the near ATM IV) ÷ √252. */
  readonly daySigma: number | null
  /** Full reprice: the worse of the stock moving +2σ or −2σ in a day, vol unchanged; ≤ 0, rupees. */
  readonly twoSigmaLoss: number | null
  /** twoSigmaLoss ÷ the sum over books, percent (0–100); null when any input is null. */
  readonly sharePct: number | null
  readonly warnings: readonly string[]
}

/** NIFTY move (percent) rows × option vol shift (points) columns; every stock moved beta × the NIFTY move. */
export interface StressGrid {
  /** Percent: [-10, -5, -3, -1, 0, 1, 3, 5, 10]. */
  readonly moves: readonly number[]
  /** Vol points added to every option's IV: [-5, 0, 5, 10]. */
  readonly vols: readonly number[]
  /** cells[i][j]: summed change for moves[i] × vols[j], rupees; null when no book could be valued. */
  readonly cells: readonly (readonly (number | null)[])[]
  /** worst[i][j]: the book with the largest loss in that cell (null when none loses). */
  readonly worst: readonly (readonly (string | null)[])[]
  /** Books left out of every cell (no beta, no spot, unpriced), with why. */
  readonly excluded: readonly { readonly stock: string; readonly why: string }[]
}

/** Today's books replayed through each past day's actual returns (every stock its own close-to-close return). */
export interface HistoricalReplay {
  /** Past days used (aligned across every held stock); null figures under 60. */
  readonly days: number
  /** Losses as negative rupees: the 5th and 1st percentile of the summed daily change. */
  readonly var95: number | null
  readonly var99: number | null
  /** Mean of the days at or below var99 (expected shortfall), rupees. */
  readonly es99: number | null
  /** The three worst days, worst first: date, summed change, and each book's part. */
  readonly worstDays: readonly {
    readonly date: string
    readonly change: number
    readonly niftyPct: number | null
    readonly books: readonly { readonly stock: string; readonly change: number; readonly movePct: number }[]
  }[]
  /** Fixed sentences: vol unchanged, today's legs, one-day horizon. */
  readonly notes: readonly string[]
}

/** Held stocks whose daily returns move together (pairwise correlation ≥ threshold, joined transitively). */
export interface CorrelatedCluster {
  readonly stocks: readonly string[]
  /** Mean pairwise correlation inside the cluster. */
  readonly meanCorr: number
  /** Full reprice: every member moving 2σ together in the direction that loses most for the cluster, rupees ≤ 0. */
  readonly togetherLoss: number
  /** Sum of the members' own twoSigmaLoss, rupees ≤ 0 (each in its own worse direction). */
  readonly standaloneLoss: number
}

export interface RiskView {
  readonly asOf: number
  /** Null = an admin's view across every trader's books (each stock's books summed). */
  readonly trader: string | null
  readonly nifty: { readonly spot: number | null; readonly lotSize: number | null }
  readonly books: readonly RiskBook[]
  readonly totals: {
    readonly betaDeltaRupees: number | null
    /** betaDeltaRupees ÷ (NIFTY spot × NIFTY lot): NIFTY futures lots equivalent, signed. */
    readonly niftyLots: number | null
    readonly niftyUp1: number | null
    readonly niftyDown1: number | null
  }
  readonly grid: StressGrid
  readonly replay: HistoricalReplay
  /** Pairwise correlation of held stocks' returns: stocks in the order of `books`, matrix[i][j], null under 60 days. */
  readonly correlation: { readonly stocks: readonly string[]; readonly matrix: readonly (readonly (number | null)[])[] }
  readonly clusters: readonly CorrelatedCluster[]
  /** The single largest risk, one sentence with numbers (e.g. "NIFTY −5% with vol +5: −₹4,12,000, most from BHEL"). */
  readonly headline: string | null
  readonly warnings: readonly string[]
}

/** One past results day of a stock, measured from the history bars. */
export interface PastReaction {
  /** The board meeting date (results). */
  readonly date: string
  /** Close of the last bar before `date` → close of the first bar after it, signed decimal (covers an announcement in or after the session). */
  readonly move: number
  /** ATM IV (history atmIv, decimal) on those two bars; crush = after − before, vol points (×100). */
  readonly ivBefore: number | null
  readonly ivAfter: number | null
  readonly crushPts: number | null
}

/** The book's change under one event outcome, valued on the first trading day after the results. */
export interface EventOutcome {
  readonly label: 'up' | 'down' | 'up-big' | 'down-big' | 'crush-only'
  /** Spot move, signed decimal (crush-only: 0). */
  readonly move: number
  /** Vol points added to every option of the book (the expected crush, ≤ 0). */
  readonly volPts: number
  /** Rupees, against the book's value now (so time decay to that day is in it). Null when unpriced. */
  readonly change: number | null
}

export interface EventRiskRow {
  readonly stock: string
  /** The next results board meeting on or after today; null = none in NSE's calendar for this stock. */
  readonly next: {
    readonly date: string
    readonly purpose: string
    /** Calendar days from today. */
    readonly days: number
    /** The first listed option expiry on or after `date`: the series that carries the event. */
    readonly expiry: string | null
    /** True when that expiry is the near one (the IV the Vol page ranks includes the event). */
    readonly inNear: boolean
    /** True when the book holds a leg of an expiry on or after `date`. */
    readonly heldThrough: boolean
  } | null
  /** Live ATM straddle ÷ future of `next.expiry`, decimal (≈ 0.8 σ√T to expiry); null when not quoted. */
  readonly impliedMove: number | null
  readonly past: readonly PastReaction[]
  /** Mean and median of |move| over `past`; mean crush over the reactions that have it. */
  readonly pastAbsMean: number | null
  readonly pastAbsMedian: number | null
  readonly crushMeanPts: number | null
  /** impliedMove ÷ pastAbsMean. */
  readonly ratio: number | null
  /** rich ≥ 1.25, cheap ≤ 0.8, else fair; unknown when ratio is null. */
  readonly verdict: 'rich' | 'fair' | 'cheap' | 'unknown'
  /** Fewer than 3 past reactions, or the date's purpose is not plainly results. */
  readonly provisional: boolean
  /** Empty when `next` is null or the book does not hold through it. */
  readonly outcomes: readonly EventOutcome[]
  readonly warnings: readonly string[]
}

export interface EventRiskView {
  readonly asOf: number
  readonly trader: string | null
  /** When scripts/nse_vol_job.py last wrote `<nseDir>/events.json`, ISO; null = never. */
  readonly calendarAsOf: string | null
  /** Rows with a `next` first (soonest first), then the rest by stock. */
  readonly rows: readonly EventRiskRow[]
  readonly warnings: readonly string[]
}
