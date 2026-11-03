/**
 * THE MULTI-MONTH SIBLING OF `buildPayoffView` — each leg on its own month.
 *
 * `buildPayoffView` prices the whole book at ONE expiry's tenor off ONE future.
 * A Traders book spans several expiries (and shares), so here every leg is
 * priced off ITS OWN month's forward and ITS OWN tenor; a share is priced off
 * spot with no time at all. `view.ts` is untouched: for a one-month book this
 * returns the same curve, and a test pins that equality.
 *
 * The near-date column ("expiry") is the book on the earliest expiry `N`: legs
 * expiring then are at intrinsic, later legs keep the time value they still
 * have on `N`. Everything is fail-soft — a leg that cannot be priced is left
 * out and named, and nothing NaN leaves.
 */
import { legGreeks, legPnl, DEFAULT_RATE, type PayoffLeg } from './legs.ts'
import { expiryPnlAt } from './expiry.ts'
import { lognormalProbBetween } from './surface.ts'
import type { PayoffPoint, PayoffRow, PayoffView } from './view.ts'

export interface MultiMonthInputs {
  /** A SHARE is `{ instrument: 'future', expiry: '' }`. */
  readonly legs: readonly PayoffLeg[]
  /** expiry -> the forward that month is valued off. */
  readonly futures: Readonly<Record<string, number>>
  readonly spot: number | null
  /** ISO date. */
  readonly today: string
  readonly realised: number
  readonly targetPnl: number | null
  readonly rate?: number
}

const CURVE_BAND = 0.1
const CURVE_STEPS = 60
const TABLE_PCTS = [1, 2, 3, 5, 8] as const
const SHOCKS = [0.9, 0.95, 1.05, 1.1] as const
const DEDUPE_TICK = 0.01
const DEFAULT_IV = 0.2
const MS_PER_DAY = 24 * 60 * 60 * 1000

function isoDayMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(String(value ?? '').trim())
  if (m === null) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms
}

function yearFrac(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / MS_PER_DAY / 365)
}

function fmt(x: number): string {
  return String(Math.round(x * 100) / 100)
}

const pos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

function emptyView(warnings: readonly string[], booked: number, target: number | null): PayoffView {
  return {
    curve: [],
    table: [],
    midDate: '',
    summary: {
      maxProfit: 0, maxLoss: 0, maxLossAt: 0, breakevens: { down: null, up: null }, pop: 0,
      netCredit: 0, worstShock: 0, worstShockAt: 0, floor: 0, booked, targetPnl: target,
    },
    greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    warnings,
  }
}

/** One leg, resolved: its reference price and the clock it runs on. */
interface Priced {
  readonly leg: PayoffLeg
  readonly ref: number
  /** UTC ms of its expiry, or null for a share. */
  readonly expMs: number | null
}

export function buildMultiMonthView(i: MultiMonthInputs): PayoffView {
  const warnings: string[] = []
  const raw = Number.isFinite(i?.realised) ? (i.realised as number) : 0
  const booked = raw === 0 ? 0 : raw
  const target = Number.isFinite(i?.targetPnl) ? (i.targetPnl as number) : null

  try {
    if (i === null || typeof i !== 'object') return emptyView(['no inputs'], 0, null)
    if (!Number.isFinite(i.realised)) {
      warnings.push(`realised P&L "${i.realised}" is unreadable: treated as nothing banked`)
    }
    let rate = i.rate ?? DEFAULT_RATE
    if (!Number.isFinite(rate)) {
      warnings.push(`unusable rate ${rate}: priced at ${DEFAULT_RATE}`)
      rate = DEFAULT_RATE
    }
    const todayMs = isoDayMs(i.today)
    if (todayMs === null) {
      return emptyView([...warnings, `valuation date "${i.today}" is not an ISO date`], booked, target)
    }
    const rawLegs = i.legs ?? []
    const legs = rawLegs.filter((l): l is PayoffLeg => l !== null && typeof l === 'object')
    if (legs.length !== rawLegs.length) {
      warnings.push(`${rawLegs.length - legs.length} leg(s) were not objects and were dropped`)
    }
    if (legs.length === 0) return emptyView([...warnings, 'no legs: nothing to price'], booked, target)

    // Each leg's reference: its own month's forward, or spot for a share.
    const spot = pos(i.spot) ? i.spot : null
    const priced: Priced[] = []
    for (const leg of legs) {
      const isShare = leg.instrument === 'future' && leg.expiry === ''
      if (isShare) {
        if (spot === null) {
          warnings.push(`leg "${leg.id}": no spot price; left out`)
          continue
        }
        priced.push({ leg, ref: spot, expMs: null })
        continue
      }
      const expMs = isoDayMs(leg.expiry)
      const fwd = i.futures?.[leg.expiry]
      if (expMs === null || !pos(fwd)) {
        warnings.push(`leg "${leg.id}": no future price for ${leg.expiry}; left out`)
        continue
      }
      if (leg.instrument === 'option' && (leg.iv === null || !Number.isFinite(leg.iv))) {
        warnings.push(`leg "${leg.id}": no IV; it marks flat until expiry`)
      }
      priced.push({ leg, ref: fwd, expMs })
    }

    // Near date: the earliest expiry on or after today among dated legs.
    let nearMs: number | null = null
    for (const p of priced) {
      if (p.expMs !== null && p.expMs >= todayMs && (nearMs === null || p.expMs < nearMs)) nearMs = p.expMs
    }
    const nMs = nearMs ?? todayMs

    const nearFwd = priced.find((p) => p.expMs !== null && p.expMs === nearMs)?.ref
    const x0 = spot ?? (pos(nearFwd) ? nearFwd : null)
    if (x0 === null || priced.length === 0) {
      return emptyView([...warnings, 'no spot and no future price: nothing to price'], booked, target)
    }

    const spanDays = Math.max(0, Math.round((nMs - todayMs) / MS_PER_DAY))
    const midMs = todayMs + Math.floor(spanDays / 2) * MS_PER_DAY
    const midDate = new Date(midMs).toISOString().slice(0, 10)

    const tOf = (p: Priced, fromMs: number): number => (p.expMs === null ? 0 : yearFrac(fromMs, p.expMs))
    const markAt = (m: number, fromMs: number): number => {
      let total = 0
      for (const p of priced) {
        const v = legPnl(p.leg, p.ref * m, tOf(p, fromMs), rate)
        if (Number.isFinite(v)) total += v
      }
      return total
    }
    const nearAt = (m: number): number => {
      let total = 0
      for (const p of priced) {
        const v =
          p.expMs !== null && p.expMs === nMs
            ? expiryPnlAt([p.leg], p.ref * m)
            : legPnl(p.leg, p.ref * m, tOf(p, nMs), rate)
        if (Number.isFinite(v)) total += v
      }
      return total
    }
    const pointAtRatio = (m: number): PayoffPoint => ({
      price: x0 * m,
      expiry: nearAt(m) + booked,
      t0: markAt(m, todayMs) + booked,
      mid: markAt(m, midMs) + booked,
    })

    const ratios = [
      ...new Set(Array.from({ length: 2 * CURVE_STEPS + 1 }, (_, k) => 1 + CURVE_BAND * ((k - CURVE_STEPS) / CURVE_STEPS))),
    ].sort((a, b) => a - b)
    const curve = ratios.map(pointAtRatio)

    let maxProfit = -Infinity
    let maxLoss = Infinity
    let maxLossAt = x0
    for (const p of curve) {
      if (p.expiry > maxProfit) maxProfit = p.expiry
      if (p.expiry < maxLoss) {
        maxLoss = p.expiry
        maxLossAt = p.price
      }
    }
    if (!Number.isFinite(maxProfit)) maxProfit = 0
    if (!Number.isFinite(maxLoss)) maxLoss = 0

    // Breakevens: zero crossings of the near-date column nearest x0 each side.
    const crossings: number[] = []
    for (let k = 0; k + 1 < curve.length; k++) {
      const a = curve[k]!
      const b = curve[k + 1]!
      if (a.expiry === 0) crossings.push(a.price)
      else if (a.expiry * b.expiry < 0) {
        crossings.push(a.price + ((b.price - a.price) * (0 - a.expiry)) / (b.expiry - a.expiry))
      }
    }
    const last = curve[curve.length - 1]
    if (last !== undefined && last.expiry === 0) crossings.push(last.price)
    const downs = crossings.filter((c) => c <= x0)
    const ups = crossings.filter((c) => c > x0)
    const breakevens = {
      down: downs.length > 0 ? Math.max(...downs) : null,
      up: ups.length > 0 ? Math.min(...ups) : null,
    }

    // POP: lognormal mass of the rungs whose (unshifted) mean value is >= 0.
    const ivs = priced
      .filter((p) => p.leg.instrument === 'option' && p.leg.iv !== null && Number.isFinite(p.leg.iv))
      .map((p) => p.leg.iv as number)
    const sigma = ivs.length > 0 ? ivs.reduce((a, b) => a + b, 0) / ivs.length : DEFAULT_IV
    const tNear = yearFrac(todayMs, nMs)
    let pop = 0
    for (let k = 0; k + 1 < curve.length; k++) {
      const mean = (curve[k]!.expiry + curve[k + 1]!.expiry) / 2 - booked
      if (!(mean >= 0)) continue
      const lo = k === 0 ? null : curve[k]!.price
      const hi = k + 2 === curve.length ? null : curve[k + 1]!.price
      pop += lognormalProbBetween(x0, lo, hi, sigma, tNear)
    }
    pop = Number.isFinite(pop) ? Math.max(0, Math.min(1, pop)) : 0

    let netCredit = 0
    for (const p of priced) {
      if (p.leg.instrument !== 'option') continue
      if (!Number.isFinite(p.leg.entry) || !Number.isFinite(p.leg.qty)) {
        warnings.push(`leg "${p.leg.id}": entry/qty unusable; not counted in the credit`)
        continue
      }
      netCredit += p.leg.entry * -p.leg.qty
    }

    let worstShock = Infinity
    let worstShockAt = x0
    for (const m of SHOCKS) {
      const v = markAt(m, todayMs) + booked
      if (v < worstShock) {
        worstShock = v
        worstShockAt = x0 * m
      }
    }
    if (!Number.isFinite(worstShock)) {
      worstShock = 0
      worstShockAt = 0
    }

    const greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 }
    for (const p of priced) {
      const g = legGreeks(p.leg, p.ref, tOf(p, todayMs), rate)
      greeks.delta += g.delta
      greeks.gamma += g.gamma
      greeks.theta += g.theta
      greeks.vega += g.vega
    }

    // Table, in the desk's priority order; first label to claim a price keeps it.
    const strikes = [
      ...new Set(
        priced
          .filter((p) => p.leg.instrument === 'option')
          .map((p) => p.leg.strike)
          .filter((s): s is number => s !== null && Number.isFinite(s)),
      ),
    ].sort((a, b) => a - b)
    const candidates: { price: number; label: string }[] = [{ price: x0, label: 'spot' }]
    if (breakevens.down !== null) candidates.push({ price: breakevens.down, label: `BE ${fmt(breakevens.down)}` })
    if (breakevens.up !== null) candidates.push({ price: breakevens.up, label: `BE ${fmt(breakevens.up)}` })
    for (const k of strikes) candidates.push({ price: k, label: `strike ${fmt(k)}` })
    for (const pct of [...TABLE_PCTS].sort((a, b) => b - a)) candidates.push({ price: x0 * (1 - pct / 100), label: `-${pct}%` })
    for (const pct of TABLE_PCTS) candidates.push({ price: x0 * (1 + pct / 100), label: `+${pct}%` })
    const taken: { price: number; label: string }[] = []
    for (const c of candidates) {
      if (!Number.isFinite(c.price) || c.price <= 0) continue
      if (taken.some((t) => Math.abs(t.price - c.price) < DEDUPE_TICK)) continue
      taken.push(c)
    }
    const table: PayoffRow[] = taken
      .sort((a, b) => a.price - b.price)
      .map((c) => ({ ...pointAtRatio(c.price / x0), price: c.price, label: c.label }))

    return {
      curve,
      table,
      midDate,
      summary: {
        maxProfit, maxLoss, maxLossAt, breakevens, pop, netCredit, worstShock, worstShockAt,
        floor: maxLoss, booked, targetPnl: target,
      },
      greeks,
      warnings,
    }
  } catch (err) {
    return emptyView(
      [...warnings, `payoff view failed: ${err instanceof Error ? err.message : err}`],
      booked,
      target,
    )
  }
}
