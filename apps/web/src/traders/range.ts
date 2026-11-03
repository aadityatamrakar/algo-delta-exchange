/**
 * Range Calculator (spec item 25): the one-, two- and three-sigma band around a
 * price for each of the next days, from an annualised volatility.
 *
 * Pure. `change = vol × √(day / 365)` with `day` in calendar days, so row i of a
 * step-5 run is day 5i. Values are unrounded; the page rounds.
 */

export interface RangeInput {
  readonly cmp: number
  /** `YYYY-MM-DD`; row dates count calendar days from it. */
  readonly startDate: string
  /** Annualised, in percent: 27.7 */
  readonly vol: number
  /** Rows, 1..365. */
  readonly iterations: number
  /** Calendar days between rows, at least 1. */
  readonly step: number
}

export interface RangeBand { readonly lower: number; readonly upper: number; readonly points: number }

export interface RangeRow {
  readonly day: number
  readonly date: string
  readonly changePct: number
  /** 68%, 95% and 99% of outcomes. */
  readonly s1: RangeBand
  readonly s2: RangeBand
  readonly s3: RangeBand
}

export const MAX_ITERATIONS = 365
/** The last row may be at most ten years out. */
export const MAX_SPAN_DAYS = 3650
const DAY_MS = 86_400_000

function parseDate(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const t = Date.parse(`${s}T00:00:00Z`)
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? null : t
}

function band(cmp: number, k: number, change: number): RangeBand {
  return { lower: cmp * (1 - k * change), upper: cmp * (1 + k * change), points: cmp * k * change }
}

export function rangeRows(input: RangeInput): RangeRow[] | { error: string } {
  const { cmp, startDate, vol, iterations, step } = input
  if (!Number.isFinite(cmp) || cmp <= 0) return { error: 'cmp must be a number above 0' }
  if (!Number.isFinite(vol) || vol <= 0) return { error: 'vol must be a number above 0' }
  const start = parseDate(startDate)
  if (start === null) return { error: 'startDate must be a real date as YYYY-MM-DD' }
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    return { error: `iterations must be a whole number from 1 to ${MAX_ITERATIONS}` }
  }
  if (!Number.isInteger(step) || step < 1) return { error: 'step must be a whole number of days, at least 1' }
  if (iterations * step > MAX_SPAN_DAYS) return { error: `step is too large: iterations × step must be at most ${MAX_SPAN_DAYS} days` }

  const rows: RangeRow[] = []
  for (let i = 1; i <= iterations; i++) {
    const day = i * step
    const change = (vol / 100) * Math.sqrt(day / 365)
    rows.push({
      day,
      date: new Date(start + day * DAY_MS).toISOString().slice(0, 10),
      changePct: change * 100,
      s1: band(cmp, 1, change), s2: band(cmp, 2, change), s3: band(cmp, 3, change),
    })
  }
  return rows
}
