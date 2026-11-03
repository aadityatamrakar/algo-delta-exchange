/**
 * What Release 2 sends the page: the Analysis, Scenario and Margin views and
 * the charge rates. Types only; the page imports them with `import type`.
 *
 * Units as on every traders wire: IV a decimal (0.245), vol SHIFTS in vol
 * points (2 = +2 %), vega per vol point, theta per calendar day, vanna and
 * volga per vol point, units signed shares, money in rupees, dates
 * `YYYY-MM-DD` IST, epoch times in milliseconds.
 *
 * A LEAF: it imports types from `../types.ts` and `@algomaker/payoff` only, so
 * the page's type program never walks the server's graph.
 */

import type { GapInput, GapResult, PayoffTableRow, ScenarioCell } from '@algomaker/payoff'
import type { Instrument, OptType, SeriesPnl, SeriesTotal } from '../types.ts'

export type { GapInput, GapResult, PayoffTableRow, ScenarioCell } from '@algomaker/payoff'

/** What options are solved and priced against; snapshot.ts re-exports it. */
export type VolBasis = 'future' | 'synthetic' | 'cash'

export type IvSource = 'quote' | 'other-side' | 'nearest' | 'override' | 'none'

export interface GreekTotals { readonly delta: number; readonly gamma: number; readonly vega: number; readonly theta: number; readonly vanna: number; readonly volga: number }

export interface AnalysisParams {
  readonly expiry: string | null; readonly exclude: readonly string[]; readonly illiquid: readonly string[]
  readonly ivOverrides: Readonly<Record<string, number>>; readonly callVol: number; readonly putVol: number; readonly future: number | null
  readonly gap: readonly GapInput[]                       // exactly 2; default [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }]
  readonly gapUseLtp: boolean; readonly gapUseVol: boolean; readonly volBasis: VolBasis   // defaults true, true, 'future'
}

export interface AnalysisLeg {                            // VolHedge v50's columns in its order, then ours
  readonly key: string; readonly source: 'odin' | 'manual'; readonly included: boolean; readonly illiquid: boolean; readonly illiquidAuto: boolean
  readonly maturity: string; readonly maturityDate: string; readonly strike: number | null; readonly type: 'F' | 'C' | 'P' | 'EQ'
  readonly units: number; readonly lots: number | null; readonly ltp: number | null; readonly netPrice: number
  readonly buyPrice: number | null; readonly salePrice: number | null                    // best bid / best ask
  readonly grossMtm: number | null; readonly syntheticFuture: number | null
  readonly timeValue: number | null       // POSITION: −units × (LTP − intrinsic against the leg's own month future), so time value the book is short counts positive (VolHedge v50)
  readonly ivUsed: number | null; readonly marketIv: number | null
  readonly delta: number; readonly deltaValue: number; readonly vega: number; readonly vegaValue: number   // plain = per share (T); value = × units
  readonly remarks: string
  readonly gamma: number; readonly gammaValue: number; readonly theta: number; readonly thetaValue: number
  readonly vanna: number; readonly vannaValue: number; readonly volga: number; readonly volgaValue: number
  readonly ivSource: IvSource; readonly ivFrom: { readonly strike: number; readonly optType: OptType } | null
}

export interface ToNeutralize {
  readonly units: number
  /** Δ0: the underlying price where the book's delta crosses zero (spot − Δ/Γ, the desk's figure); null without spot or gamma. */
  readonly price: number | null
  /** Δ0's distance from spot, % (VolHedge's "420.00 (−1.14 %)"); null with `price`. */
  readonly pct: number | null
  readonly lots: number; readonly side: 'Buy' | 'Sell' | null; readonly contract: string; readonly text: string
}

/**
 * One row of the MTM block; null = not known, shown '—': yesterday's close is missing (Previous, Total), or the day
 * has not begun (`MtmBlock.dayReason`: then every column is null). The Expense row's `previous` is always null: the
 * day view carries no earlier charges (`MtmBlock.openCycleCharges`).
 */
export interface MtmCols { readonly previous: number | null; readonly today: number | null; readonly total: number | null }

/**
 * VolHedge v50's block, as the DAY view (spec G5): rows Gross MTM, Expense, Current MTM × columns Previous, Today,
 * Total. Current MTM's total is "Day MTM" = gross previous + gross today − the charges of TODAY's fills. The charges
 * of the contracts' earlier cycle are in no day figure (`openCycleCharges`). Before the session opens, or on a day
 * the market is closed, every day figure is null with its reason (`dayReason`), never a number built from
 * yesterday's last tick.
 */
export interface MtmBlock {
  readonly gross: MtmCols; readonly expense: MtmCols; readonly current: MtmCols
  readonly squareOff: number; readonly projected: number | null
  readonly payInOut: number; readonly cfBalance: number
  /**
   * The charges of the contracts' open cycle up to the start of today (what Expense Previous used to carry): a whole
   * cycle's cost set against one day's move, so it is in no Day figure. The series P&L counts it with the rest of the series.
   */
  readonly openCycleCharges: number
  /** Why every day figure is null ('market opens 09:15', 'market closed today'); null = the day has begun. Optional: an older server sends none. */
  readonly dayReason?: string | null
  readonly partial: readonly string[]; readonly ratesConfirmed: boolean; readonly notes: readonly string[]
}

export interface AnalysisView {
  readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly spot: number | null; readonly future: number | null; readonly futureOverridden: boolean
  readonly nearExpiry: string | null; readonly daysToExpiry: number | null; readonly nearFuture: string | null; readonly lotSize: number | null; readonly lotGcd: number
  readonly months: readonly { readonly expiry: string; readonly label: string }[]
  readonly params: AnalysisParams; readonly legs: readonly AnalysisLeg[]
  readonly totals: { readonly T: GreekTotals; readonly N: GreekTotals; readonly note: string }
  readonly monthWise: readonly { readonly label: string; readonly expiry: string; readonly totals: GreekTotals }[]
  readonly optionGreeks: GreekTotals
  readonly comparison: { readonly T: GreekTotals; readonly N: GreekTotals; readonly diff: GreekTotals; readonly note: string }   // "Greeks Comparison" tab
  readonly toNeutralize: ToNeutralize | null
  readonly bookTimeValue: number
  readonly breakevens: { readonly low: number | null; readonly high: number | null; readonly expiry: string | null; readonly text: string }
  readonly gapPanel: { readonly on: string; readonly basis: VolBasis; readonly useLtp: boolean; readonly useVol: boolean; readonly rows: readonly GapResult[]; readonly note: string }
  readonly mtm: MtmBlock; readonly unmatched: readonly string[]; readonly warnings: readonly string[]
  /** The book's live expiry series (BookView's), whole book whatever the month tab; optional: an older server sends none. */
  readonly series?: readonly SeriesPnl[]
  readonly seriesTotal?: SeriesTotal
}

export interface HypotheticalLeg { readonly id: string; readonly instrument: Instrument; readonly expiry: string; readonly strike: number | null; readonly optType: OptType | null; readonly qty: number; readonly price: number | null; readonly iv: number | null }

export interface ScenarioRequest {
  readonly exclude?: readonly string[]; readonly illiquid?: readonly string[]; readonly ivOverrides?: Readonly<Record<string, number>>
  readonly spot?: number; readonly callVolShift?: number; readonly putVolShift?: number; readonly volShift?: number
  readonly start?: string; readonly end?: string; readonly everyNth?: number
  readonly middle?: number; readonly stepPct?: number; readonly count?: number      // VolHedge v50: M.Strike, Interval %, Strike +/-
  readonly targetDate?: string; readonly targets?: readonly number[]; readonly hypothetical?: readonly HypotheticalLeg[]
}

export interface ScenarioLegRow {                         // VolHedge v50 scenario leg table, per share unless 'value'
  readonly id: string; readonly hypothetical: boolean; readonly expiry: string; readonly type: 'F' | 'C' | 'P' | 'EQ'; readonly underlying: number; readonly strike: number | null
  readonly qty: number; readonly rate: number; readonly vol: number | null; readonly ltp: number | null
  readonly delta: number; readonly deltaValue: number; readonly gamma: number; readonly gammaValue: number; readonly vega: number; readonly vegaValue: number; readonly theta: number; readonly thetaValue: number
}

export interface ScenarioResolved { readonly spot: number; readonly callVolShift: number; readonly putVolShift: number; readonly volShift: number; readonly start: string; readonly end: string; readonly everyNth: number; readonly middle: number; readonly stepPct: number; readonly count: number; readonly targetDate: string }

export interface ScenarioView {
  readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly nearExpiry: string; readonly lastExpiry: string; readonly expiries: readonly string[]
  readonly lotSize: number | null; readonly lotGcd: number; readonly resolved: ScenarioResolved
  readonly totals: ScenarioCell                           // the top row: P&L and greeks at CMP on the first column
  readonly legs: readonly ScenarioLegRow[]                 // the leg table: book legs, then hypothetical rows
  readonly grid: { readonly spots: readonly number[]; readonly currentRow: number; readonly dates: readonly string[]; readonly labels: readonly string[]; readonly cells: readonly (readonly ScenarioCell[])[] }
  readonly baseNote: string
  readonly chart: { readonly targetDate: string; readonly expiryDate: string; readonly spot: number; readonly points: readonly { readonly price: number; readonly target: number; readonly expiry: number }[] }
  readonly table: readonly PayoffTableRow[]
  readonly hypothetical: readonly { readonly id: string; readonly accepted: boolean; readonly reason: string | null; readonly entry: number | null; readonly iv: number | null }[]
  readonly warnings: readonly string[]
}

export interface SpanSourceView { readonly file: string; readonly label: string; readonly businessDate: string; readonly savedAt: number | null }

export interface MarginView {
  readonly available: boolean; readonly initial: number | null; readonly exposure: number | null; readonly total: number | null
  readonly peak: { readonly total: number; readonly label: string } | null     // highest total over the newest business date's SPAN files read so far
  readonly parts: { readonly scanningRisk: number; readonly worstScenario: number; readonly interMonthSpread: number; readonly shortOptionMinimum: number; readonly netOptionValue: number } | null
  readonly span: SpanSourceView | null; readonly exposureFile: SpanSourceView | null
  readonly stale: boolean; readonly missing: readonly string[]; readonly notes: readonly string[]
}

export interface SegmentRates { readonly sttBuyPct: number; readonly sttSellPct: number; readonly exchangePct: number; readonly stampBuyPct: number }

export interface Brokerage { readonly mode: 'order' | 'lot'; readonly amount: number }

export interface ChargeRates {
  readonly option: SegmentRates; readonly future: SegmentRates; readonly share: SegmentRates
  readonly sebiPerCrore: number; readonly gstPct: number
  readonly brokerage: { readonly default: Brokerage; readonly byTrader: Readonly<Record<string, Brokerage>> }
  readonly confirmedBy: string | null; readonly confirmedAt: number | null
}
