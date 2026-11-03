/**
 * The option chain page's arithmetic, kept apart from the rendering so each
 * rule can be tested on its own: which side is in the money, where the spot
 * line goes, PCR, max pain, the settlement countdown and the expiry grouping.
 *
 * Nothing here reads the clock. Every time-dependent function takes `now`.
 */
import type { ChainRowWire, ChainSide } from './api.ts'

export type ExpiryClass = 'daily' | 'weekly' | 'monthly'

/**
 * Delta's listing pattern: a monthly is the LAST Friday of its month, a weekly
 * any other Friday, a daily every other day. Decided from the date alone, so
 * an expiry the instrument list adds tomorrow files itself.
 */
export function expiryClass(expiry: string): ExpiryClass {
  const at = Date.parse(`${expiry}T12:00:00Z`)
  if (!Number.isFinite(at)) return 'daily'
  const d = new Date(at)
  if (d.getUTCDay() !== 5) return 'daily'
  const nextWeek = new Date(at + 7 * 86_400_000)
  return nextWeek.getUTCMonth() !== d.getUTCMonth() ? 'monthly' : 'weekly'
}

export interface ExpiryGroup {
  readonly cls: ExpiryClass
  readonly label: string
  readonly expiries: readonly string[]
}

const GROUP_LABELS: readonly { cls: ExpiryClass; label: string }[] = [
  { cls: 'daily', label: 'Daily' },
  { cls: 'weekly', label: 'Weekly' },
  { cls: 'monthly', label: 'Monthly' },
]

/** The expiries split into Daily / Weekly / Monthly, in that order, empty groups dropped. */
export function groupExpiries(list: readonly string[]): ExpiryGroup[] {
  return GROUP_LABELS
    .map(({ cls, label }) => ({ cls, label, expiries: list.filter((e) => expiryClass(e) === cls) }))
    .filter((g) => g.expiries.length > 0)
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-11-04` → `04 Nov`. */
export function expiryLabel(expiry: string): string {
  const [, m, d] = expiry.split('-')
  return `${d ?? ''} ${MONTH[Number(m) - 1] ?? m ?? ''}`
}

/** Delta settles its BTC options at 17:30 IST, which is 12:00 UTC. */
export function settlesAt(expiry: string): number {
  return Date.parse(`${expiry}T12:00:00Z`)
}

const IST_OFFSET_MS = 330 * 60_000

/**
 * Calendar days from today (in IST, the desk's clock) to the expiry date.
 * The expiry's own day is 0. Never negative.
 */
export function daysToExpiry(expiry: string, now: number): number {
  const exp = Date.parse(`${expiry}T00:00:00Z`)
  if (!Number.isFinite(exp)) return 0
  const ist = new Date(now + IST_OFFSET_MS)
  const today = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate())
  return Math.max(0, Math.round((exp - today) / 86_400_000))
}

/** The pill text: `06 Nov · 3d`. */
export function expiryPillLabel(expiry: string, now: number): string {
  return `${expiryLabel(expiry)} · ${daysToExpiry(expiry, now)}d`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * The time left to settlement: `2d 04:12:33` past a day, `04:12:33` inside
 * one, `Settled` once it is reached.
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'Settled'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const clock = `${pad2(h)}:${pad2(m)}:${pad2(s)}`
  return d > 0 ? `${d}d ${clock}` : clock
}

/** The listed strike nearest the index price; null without a price or strikes. */
export function atmStrike(strikes: readonly number[], spot: number | null): number | null {
  if (spot === null || !Number.isFinite(spot) || strikes.length === 0) return null
  let best = strikes[0] as number
  for (const k of strikes) if (Math.abs(k - spot) < Math.abs(best - spot)) best = k
  return best
}

/**
 * Which sides of a strike are in the money: a call below the index, a put
 * above it. A strike exactly at the index is neither. No index, no shading.
 */
export function itmSides(strike: number, spot: number | null): { ce: boolean; pe: boolean } {
  if (spot === null || !Number.isFinite(spot)) return { ce: false, pe: false }
  return { ce: strike < spot, pe: strike > spot }
}

/**
 * Where the spot line goes: the number of strikes at or below the index, so
 * the line is drawn before row `i` — between the last strike under the price
 * and the first above it. 0 puts it above every row, `strikes.length` below
 * them all. Null without an index price. `strikes` must be ascending.
 */
export function spotLineIndex(strikes: readonly number[], spot: number | null): number | null {
  if (spot === null || !Number.isFinite(spot)) return null
  let i = 0
  while (i < strikes.length && (strikes[i] as number) <= spot) i++
  return i
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Put/call ratio by open interest: total put OI over total call OI. Null
 * unless BOTH sides report OI somewhere on the chain, and null when the call
 * total is zero — a feed that sends no put OI is not a PCR of 0.
 */
export function putCallRatio(rows: readonly ChainRowWire[]): number | null {
  let ce = 0
  let pe = 0
  let anyCe = false
  let anyPe = false
  for (const r of rows) {
    const c = r.CE?.oi
    const p = r.PE?.oi
    if (finite(c)) { ce += c; anyCe = true }
    if (finite(p)) { pe += p; anyPe = true }
  }
  if (!anyCe || !anyPe || ce <= 0) return null
  return pe / ce
}

/**
 * Max pain: the settlement strike at which option holders' total intrinsic
 * value is smallest. O(n²) over ~40 strikes. Null when no OI is reported.
 */
export function maxPain(rows: readonly ChainRowWire[]): number | null {
  const legs = rows.map((r) => {
    const c = r.CE?.oi
    const p = r.PE?.oi
    return { k: r.strike, ce: finite(c) ? c : 0, pe: finite(p) ? p : 0 }
  })
  if (legs.every((l) => l.ce === 0 && l.pe === 0)) return null
  let best: number | null = null
  let bestPain = Infinity
  for (const { k: K } of legs) {
    let pain = 0
    for (const l of legs) pain += l.ce * Math.max(0, K - l.k) + l.pe * Math.max(0, l.k - K)
    if (pain < bestPain) { bestPain = pain; best = K }
  }
  return best
}

/** The side's price for arithmetic: the exchange mark, else the mid, else the last price. */
export function sidePrice(s: ChainSide | null | undefined): number | null {
  if (s === null || s === undefined) return null
  if (finite(s.mark)) return s.mark
  if (finite(s.bid) && finite(s.ask)) return (s.bid + s.ask) / 2
  return finite(s.price) ? s.price : null
}

/** The ATM straddle: call plus put at the ATM strike. Null unless both are priced. */
export function atmStraddle(row: ChainRowWire | undefined): number | null {
  if (row === undefined) return null
  const ce = sidePrice(row.CE)
  const pe = sidePrice(row.PE)
  return ce === null || pe === null ? null : ce + pe
}

/** The ATM IV: the mean of the call's and put's, or whichever one is quoted. */
export function atmIv(row: ChainRowWire | undefined): number | null {
  if (row === undefined) return null
  const ivs = [row.CE?.iv, row.PE?.iv].filter(finite)
  return ivs.length === 0 ? null : ivs.reduce((a, b) => a + b, 0) / ivs.length
}

/**
 * A strike is "far" when it sits more than two standard deviations of the
 * expiry's expected move from the index — ln(K/S) / (σ·√T) > 2, with T floored
 * at two hours so the last minutes before settlement do not dim the whole
 * chain. Without an ATM IV it falls back to 5% from the index.
 */
export function isFar(strike: number, spot: number | null, iv: number | null, msToSettle: number): boolean {
  if (spot === null || !(spot > 0) || !(strike > 0)) return false
  const dist = Math.abs(Math.log(strike / spot))
  if (iv === null || !(iv > 0)) return dist > 0.05
  const years = Math.max(msToSettle, 2 * 3600_000) / (365 * 86_400_000)
  return dist / (iv * Math.sqrt(years)) > 2
}

/** 0..10: where `v` sits between `lo` and `hi`. Null for a missing value. */
export function heatStep(v: number | null | undefined, lo: number, hi: number): number | null {
  if (!finite(v)) return null
  if (!(hi > lo)) return 0
  return Math.max(0, Math.min(10, Math.round(((v - lo) / (hi - lo)) * 10)))
}
