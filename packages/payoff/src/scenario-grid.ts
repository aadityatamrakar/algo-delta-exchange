/**
 * The scenario grid's axes, the Gap Up/Down rows, the breakeven range and the
 * Sensibull target/expiry curve and table — all built on `scenario()`.
 *
 * Pure, like it: the clock is `now`, the trading calendar is injected. Nothing
 * here is NaN; what `scenario()` cannot value comes back empty (no rows, null
 * breakevens, an empty curve), and its `warnings` are not surfaced by these
 * signatures — a caller that needs them calls `scenario()` itself.
 */
import type { PayoffLeg } from './legs.ts'
import {
  scenario,
  valuationAt,
  istDay,
  type ScenarioMarket,
  type ValuationPoint,
  type VolShifts,
} from './scenario.ts'

export const GRID_MAX_COUNT = 100
export const GRID_MAX_DATES = 60

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_SCAN_DAYS = 20_000 // a range longer than this cannot be a real grid
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SAME_PRICE = 0.01

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPos = (v: unknown): v is number => isNum(v) && v > 0

export interface AxesSpec {
  /** VolHedge v50: "Interval" % and "Strike +/-" rows each side, around M.Strike. */
  readonly middle: number
  readonly stepPct: number
  readonly count: number
  readonly spot: number
  readonly start: string
  readonly end: string
  readonly everyNth: number
  readonly expiry: string
  readonly now: number
  /** Injected: this package stays free of the desk calendar. */
  readonly isTradingDay: (day: string) => boolean
}
export interface Axes {
  readonly spots: readonly number[]
  readonly currentRow: number
  readonly columns: readonly ValuationPoint[]
  readonly labels: readonly string[]
}

function addDay(day: string): string {
  return istDay(Date.parse(`${day}T00:00:00Z`) + DAY_MS + 330 * 60 * 1000)
}
function dayLabel(day: string): string {
  return `${day.slice(8, 10)} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`
}

function spotRows(middle: number, stepPct: number, count: number, spot: number): { spots: number[]; currentRow: number } {
  const spots: number[] = []
  for (let k = -count; k <= count; k++) {
    const row = (middle * (100 + k * stepPct)) / 100
    if (row > 0) spots.push(row)
  }
  let at = spots.findIndex((s) => Math.abs(s - spot) < SAME_PRICE)
  if (at < 0) {
    spots.push(spot)
    spots.sort((a, b) => a - b)
    at = spots.indexOf(spot)
  }
  return { spots, currentRow: at }
}

export function scenarioAxes(spec: AxesSpec): Axes | { readonly error: string } {
  const { middle, stepPct, count, spot, start, end, everyNth, expiry, now } = spec
  if (!isPos(middle)) return { error: 'middle must be a positive number' }
  if (!isPos(spot)) return { error: 'spot must be a positive number' }
  if (!isPos(stepPct)) return { error: 'stepPct must be a positive number' }
  if (!isNum(count) || !Number.isInteger(count) || count < 0 || count > GRID_MAX_COUNT) {
    return { error: `count must be a whole number from 0 to ${GRID_MAX_COUNT}` }
  }
  if (!isNum(everyNth) || !Number.isInteger(everyNth) || everyNth < 1) return { error: 'everyNth must be a whole number of at least 1' }

  const expiryPt = valuationAt(expiry, now, 'close')
  if (expiryPt === null) return { error: 'expiry must be a date today or later (YYYY-MM-DD)' }
  const today = istDay(now)
  if (valuationAt(start, now, 'time') === null) return { error: `start must be a date from ${today} (YYYY-MM-DD)` }
  if (start > expiry) return { error: `start ${start} is after the expiry ${expiry}` }
  if (valuationAt(end, now, 'time') === null) return { error: 'end must be a date today or later (YYYY-MM-DD)' }
  if (end < start) return { error: `end ${end} is before start ${start}` }

  const last = end < expiry ? end : expiry
  const columns: ValuationPoint[] = []
  const labels: string[] = []
  let seen = 0
  let day = start
  for (let scanned = 0; day <= last; scanned++, day = addDay(day)) {
    if (scanned > MAX_SCAN_DAYS) return { error: 'end is too far out for a grid' }
    if (!spec.isTradingDay(day)) continue
    if (seen++ % everyNth !== 0) continue
    if (columns.length >= GRID_MAX_DATES) return { error: `more than ${GRID_MAX_DATES} dates — widen everyNth or shorten end` }
    columns.push(valuationAt(day, now, 'time')!)
    labels.push(dayLabel(day))
  }
  columns.push(expiryPt)
  labels.push('Expiry')

  const { spots, currentRow } = spotRows(middle, stepPct, count, spot)
  return { spots, currentRow, columns, labels }
}

export interface GapInput {
  readonly movePct: number
  readonly volPts: number
}
export interface GapResult extends GapInput {
  readonly price: number
  readonly pnl: number
  /** `pnl` less the caller's current MTM (`base`). */
  readonly change: number
}

/**
 * The Gap Up/Down rows: the book at the next open (09:15 IST of `nextDay`) after
 * a `movePct` move in the stock, every option's IV shifted by `volPts` when
 * `useVol`. `ivOverrides` apply either way. A row with a non-positive or non-finite price (or vol change) is skipped; no rows at all when the day or the market
 * cannot be valued.
 */
export function gapRows(
  legs: readonly PayoffLeg[],
  market: ScenarioMarket,
  nextDay: string,
  rows: readonly GapInput[],
  ivOverrides: Readonly<Record<string, number>>,
  useVol: boolean,
  base: number,
): readonly GapResult[] {
  const open = valuationAt(nextDay, market.now, 'open')
  if (open === null || !isNum(base)) return []
  const atOpen: ScenarioMarket = { ...market, now: open.ms }
  const out: GapResult[] = []
  for (const row of rows) {
    const price = (market.spot * (100 + row.movePct)) / 100
    if (!isPos(price) || (useVol && !isNum(row.volPts))) continue // skip this row, keep the others
    const shifts: VolShifts = useVol ? { volShift: row.volPts, ivOverrides } : { ivOverrides }
    const cell = scenario(legs, atOpen, [price], [open], shifts).cells[0]?.[0]
    if (cell === undefined) return []
    out.push({ ...row, price, pnl: cell.pnl, change: cell.pnl - base })
  }
  return out
}

/** Target and expiry P&L at each price; empty when either instant or the market is unusable. */
function pnlAt(
  legs: readonly PayoffLeg[],
  market: ScenarioMarket,
  prices: readonly number[],
  targetDate: string,
  expiryDate: string,
  shifts: VolShifts,
): readonly PayoffPointTE[] {
  const target = valuationAt(targetDate, market.now, 'time')
  const expiry = valuationAt(expiryDate, market.now, 'close')
  if (target === null || expiry === null) return []
  const { cells } = scenario(legs, market, prices, [target, expiry], shifts)
  if (cells.length !== prices.length) return []
  return prices.map((price, i) => ({ price, target: cells[i]![0]!.pnl, expiry: cells[i]![1]!.pnl }))
}

/**
 * Where the book breaks even at the expiry close: zero crossings on 1,001 points
 * across 0.5-1.5 x spot, linearly interpolated. `low` is the nearest below spot,
 * `high` the nearest above; null when there is none.
 */
export function breakevenRange(
  legs: readonly PayoffLeg[],
  market: ScenarioMarket,
  expiryDate: string,
  shifts: VolShifts,
): { readonly low: number | null; readonly high: number | null } {
  const none = { low: null, high: null }
  const close = valuationAt(expiryDate, market.now, 'close')
  if (close === null || !isPos(market.spot)) return none
  const prices = Array.from({ length: 1001 }, (_, k) => market.spot * (0.5 + k / 1000))
  const { cells } = scenario(legs, market, prices, [close], shifts)
  if (cells.length !== prices.length) return none
  const pnl = cells.map((c) => c[0]!.pnl)
  let low: number | null = null
  let high: number | null = null
  const cross = (x: number): void => {
    if (x < market.spot) low = x // ascending scan: the last one below spot is the nearest
    else if (high === null) high = x
  }
  for (let i = 0; i < prices.length; i++) {
    const a = pnl[i]!
    if (a === 0) cross(prices[i]!)
    else if (i + 1 < prices.length) {
      const b = pnl[i + 1]!
      if (a * b < 0) cross(prices[i]! + ((prices[i + 1]! - prices[i]!) * a) / (a - b))
    }
  }
  return { low, high }
}

export interface PayoffPointTE {
  readonly price: number
  /** P&L at the target date. */
  readonly target: number
  /** P&L at the expiry close. */
  readonly expiry: number
}

/** 121 points across spot +/-10 %: the Sensibull target-date and expiry lines. */
export function payoffCurve(
  legs: readonly PayoffLeg[],
  market: ScenarioMarket,
  targetDate: string,
  expiryDate: string,
  shifts: VolShifts,
): readonly PayoffPointTE[] {
  if (!isPos(market.spot)) return []
  const prices = Array.from({ length: 121 }, (_, k) => market.spot * (1 + (0.1 * (k - 60)) / 60))
  return pnlAt(legs, market, prices, targetDate, expiryDate, shifts)
}

export const PAYOFF_TABLE_PCTS = [1, 2, 3, 5, 8] as const
export interface PayoffTableRow extends PayoffPointTE {
  readonly label: string
}

function targetLabel(price: number): string {
  return `target ${Number(price.toFixed(2))}`
}

/**
 * The Sensibull P&L table: spot, +/-1/2/3/5/8 %, and each target price. Rows
 * within 0.01 of a higher-priority row are dropped (spot > target > pct);
 * ascending by price.
 */
export function payoffTable(
  legs: readonly PayoffLeg[],
  market: ScenarioMarket,
  targetDate: string,
  expiryDate: string,
  targets: readonly number[],
  shifts: VolShifts,
): readonly PayoffTableRow[] {
  if (!isPos(market.spot)) return []
  const wanted: { label: string; price: number }[] = [{ label: 'spot', price: market.spot }]
  for (const t of targets) wanted.push({ label: targetLabel(t), price: t })
  for (const p of PAYOFF_TABLE_PCTS) {
    wanted.push({ label: `-${p}%`, price: market.spot * (1 - p / 100) })
    wanted.push({ label: `+${p}%`, price: market.spot * (1 + p / 100) })
  }
  const kept: { label: string; price: number }[] = []
  for (const w of wanted) {
    if (isPos(w.price) && !kept.some((k) => Math.abs(k.price - w.price) <= SAME_PRICE)) kept.push(w)
  }
  kept.sort((a, b) => a.price - b.price)
  const points = pnlAt(legs, market, kept.map((k) => k.price), targetDate, expiryDate, shifts)
  return points.map((p, i) => ({ ...p, label: kept[i]!.label }))
}
