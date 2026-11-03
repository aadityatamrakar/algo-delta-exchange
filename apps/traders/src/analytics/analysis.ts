/**
 * VolHedge v50's Analysis window for one book (spec items 8–17, 22): the leg
 * table, the T and N totals, month-wise and option greeks, the Greeks
 * Comparison, To Neutralize, the book's time value, the breakeven range, the
 * Gap Up/Down panel and the MTM block. Reads only; a viewer's ticks, typed IVs
 * and shifts are never stored.
 *
 * T is the book at the IV used — market IV, or the viewer's typed IV, plus the
 * call/put vol shifts — and against the typed future when there is one; N at
 * market IV and spot, no shifts (our reading of VolHedge's rows, Phase 0 Q3).
 * Every leg is valued on its own month (`legPoints`), now.
 *
 * What the figures cover: the leg table, the totals, the comparison, the
 * option greeks and the book's time value follow the month tab; month-wise, To
 * Neutralize, the breakevens and the gap panel are the whole book. Every one
 * leaves out the unticked legs. A key in `exclude`, `illiquid` or `iv` that
 * is not one of this book's legs is ignored (Review Focus 3).
 *
 * The series P&L (series-pnl.ts) is the whole book's too, its open part the
 * legs' GrossMTM at the snapshot's prices, so it agrees with the leg table.
 *
 * The scenario helpers carry no warnings, so this file names what they leave
 * out: a leg with no IV, or one that cannot be priced, has its remark and one
 * warning. Nothing here is NaN: a number is finite, or null where unknown.
 */

import {
  breakevenRange, gapRows, istDay, ivUsed, IV_FLOOR, legPoints, rawIv, type LegPoint, type PayoffLeg, type ScenarioMarket, type VolShifts,
} from '@algomaker/payoff'
import type { TradersDeps } from '../deps.ts'
import { lotSizeOf as masterLotSize, type TradersMaster } from '../market/master.ts'
import { isIsoDate, istDate } from '../routes/kit.ts'
import { contractText, isOpenLeg, type OptType, type TraderLeg } from '../types.ts'
import { nextOpenDay } from './calendar.ts'
import { mtmOf } from './mtm.ts'
import { seriesPnl, type SeriesBase, type SeriesResult } from './series-pnl.ts'
import { MARKET_CLOSED, rebase, withIlliquid, type BookSnapshot, type PricedLeg } from './snapshot.ts'
import { bookLotGcd } from './units.ts'
import type { AnalysisLeg, AnalysisParams, AnalysisView, GapInput, GreekTotals, IvSource, MtmBlock, ToNeutralize, VolBasis } from './wire.ts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const DAY_MS = 86_400_000
/** Per repeated parameter: keeps the URL well under Node's 16 KB header limit. */
const LIST_MAX = 100
const IV_MAX = 5
const SHIFT_MAX = 50
const GAP_MAX = 50
const BASES: readonly VolBasis[] = ['future', 'synthetic', 'cash']
const DEFAULT_GAP: readonly GapInput[] = [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }]
/** A decimal as the page writes one (`String(number)`, exponent included); nothing else. */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const GAP_RULE = `gap must be given twice or not at all, as <move %>,<vol points>, each from -${GAP_MAX} to ${GAP_MAX}`

export const TOTALS_NOTE = 'T = at IV used · N = at market IV — our reading of VolHedge (Phase 0 Q3)'
export const COMPARISON_NOTE = "diff = T - N — our reading of VolHedge's Greeks Comparison (Phase 0 Q3)"
const NO_IV = 'no IV — marks flat'
const UNPRICED = 'cannot be priced'

const ZERO: GreekTotals = { delta: 0, gamma: 0, vega: 0, theta: 0, vanna: 0, volga: 0 }
const GREEKS = ['delta', 'gamma', 'vega', 'theta', 'vanna', 'volga'] as const

/** -0 reads as 0. */
const zero = (x: number): number => (x === 0 ? 0 : x)
const positive = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0
const finite = (x: number): number | null => (Number.isFinite(x) ? zero(x) : null)
/** A greek × units; 0 when either is junk. Scenario's leg table uses it too. */
export const times = (a: number, b: number): number => finite(a * b) ?? 0
const unique = (xs: readonly string[]): string[] => [...new Set(xs)]
const monthOf = (expiry: string): string | undefined => (isIsoDate(expiry) ? MONTHS[Number(expiry.slice(5, 7)) - 1] : undefined)
const dayMonth = (day: string): string => (monthOf(day) === undefined ? '—' : `${day.slice(8, 10)} ${monthOf(day) as string}`)

/** VolHedge v50's Maturity column: '2026-10-27' -> 'Oct 26'; '' (a share) -> 'EQ'. */
export function maturityLabel(expiry: string): string {
  if (expiry === '') return 'EQ'
  const m = monthOf(expiry)
  return m === undefined ? expiry : `${m} ${expiry.slice(2, 4)}`
}

/** Its month tabs: '2026-10-27' -> '27OCT' (an index's weeklies stay apart: '20OCT'); '' -> 'EQ'. */
export function expiryTab(expiry: string): string {
  if (expiry === '') return 'EQ'
  const m = monthOf(expiry)
  return m === undefined ? expiry : `${expiry.slice(8, 10)}${m.toUpperCase()}`
}

/** 'TCS OCT FUT'. */
const futureName = (stock: string, expiry: string): string => `${stock} ${(monthOf(expiry) ?? expiry).toUpperCase()} FUT`

/**
 * A leg's time value as a POSITION: −units × (LTP − intrinsic against `future`,
 * its own month's), so time value the book is short counts positive — on
 * VolHedge's JINDALSTEL screen the column sums to the book's TimeValue. Null
 * with no LTP.
 */
export function legTimeValue(units: number, ltp: number | null, strike: number, optType: OptType, future: number): number | null {
  if (ltp === null || ![units, ltp, strike, future].every(Number.isFinite)) return null
  const intrinsic = Math.max(0, optType === 'CE' ? future - strike : strike - future)
  return finite(-units * (ltp - intrinsic))
}

/**
 * How many of the nearest future make `delta` (shares) neutral, in its lots.
 * `price`/`pct` (Δ0) are left null here: `deltaNeutral` fills them where spot
 * and gamma are known. Total: a delta that is not a number counts as 0, and a `lotSize` that
 * is not a positive number gives `lots` 0 and `side` null, the text naming the
 * delta it cannot size (`Delta -1234 — lot size unknown, cannot size TCS OCT
 * FUT`, or `Neutral (0 shares)`).
 */
export function toNeutralize(delta: number, stock: string, futureExpiry: string, lotSize: number): ToNeutralize {
  const d = Number.isFinite(delta) ? delta : 0
  const units = zero(-Math.round(d))
  const contract = futureName(stock, futureExpiry)
  const shares = (k: number): string => `${k} ${Math.abs(k) === 1 ? 'share' : 'shares'}`
  if (!positive(lotSize)) {
    const text = units === 0 ? `Neutral (${shares(0)})` : `Delta ${units < 0 ? '+' : '-'}${Math.abs(units)} — lot size unknown, cannot size ${contract}`
    return { units, price: null, pct: null, lots: 0, side: null, contract, text }
  }
  const lots = zero(-Math.sign(d) * Math.round(Math.abs(d) / lotSize))
  const side = lots > 0 ? 'Buy' : lots < 0 ? 'Sell' : null
  const n = Math.abs(lots)
  const text = side === null
    ? `Neutral — within half a lot (${shares(units)})`
    : `${side} ${n} ${n === 1 ? 'lot' : 'lots'} ${contract}`
  return { units, price: null, pct: null, lots, side, contract, text }
}

/**
 * Δ0, the underlying price where the book's delta crosses zero, as the desk's dashboard works it out
 * (apps/web/src/positions.ts `bookTotals`): spot − Δ/Γ, a gamma-constant estimate, accurate near spot only;
 * with its distance from spot in %. Null without a spot, or when Γ is 0 or not a number (no leg priced).
 */
export function deltaNeutral(spot: number | null, delta: number, gamma: number): { readonly price: number | null; readonly pct: number | null } {
  if (spot === null || !(spot > 0) || !Number.isFinite(delta) || !Number.isFinite(gamma) || gamma === 0) return { price: null, pct: null }
  const price = spot - delta / gamma
  return Number.isFinite(price) ? { price, pct: ((price - spot) / spot) * 100 } : { price: null, pct: null }
}

/** `String(number)` back to the number; null for anything else. */
function decimal(s: string): number | null {
  if (!DECIMAL.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? zero(n) : null
}

/**
 * The page's query: `expiry=YYYY-MM-DD`; `exclude=<key>`, `illiquid=<key>` and
 * `iv=<key>@<decimal>` repeated (split on the LAST '@', 0 < iv ≤ 5); `callVol`
 * and `putVol` in vol points (|x| ≤ 50); `future` > 0; `gap=<move %>,<vol pts>`
 * exactly twice or not at all (|x| ≤ 50 each); `gapLtp` and `gapVol` 0 or 1;
 * `basis` future, synthetic or cash. At most 100 of each list. Anything else
 * (`as`, for one) is not the parser's. Each error starts with the parameter.
 */
export function parseAnalysisQuery(q: URLSearchParams): AnalysisParams | { readonly error: string } {
  const lists = { exclude: q.getAll('exclude'), illiquid: q.getAll('illiquid'), iv: q.getAll('iv'), gap: q.getAll('gap') }
  for (const [name, l] of Object.entries(lists)) {
    if (l.length > LIST_MAX) return { error: `${name}: at most ${LIST_MAX} entries` }
  }

  const expiry = q.get('expiry')
  if (expiry !== null && !isIsoDate(expiry)) return { error: 'expiry must be a date (YYYY-MM-DD)' }

  const ivs: [string, number][] = []
  for (const e of lists.iv) {
    const at = e.lastIndexOf('@')
    const iv = at < 0 ? null : decimal(e.slice(at + 1))
    if (at <= 0 || iv === null || iv <= 0 || iv > IV_MAX) return { error: `iv must be <leg key>@<IV as a decimal, above 0 and at most ${IV_MAX}>` }
    ivs.push([e.slice(0, at), iv])
  }

  const shifts = { callVol: 0, putVol: 0 }
  for (const name of ['callVol', 'putVol'] as const) {
    const raw = q.get(name)
    if (raw === null) continue
    const n = decimal(raw)
    if (n === null || Math.abs(n) > SHIFT_MAX) return { error: `${name} must be vol points from -${SHIFT_MAX} to ${SHIFT_MAX}` }
    shifts[name] = n
  }

  const rawFuture = q.get('future')
  const future = rawFuture === null ? null : decimal(rawFuture)
  if (rawFuture !== null && (future === null || future <= 0)) return { error: 'future must be a price above 0' }

  if (lists.gap.length !== 0 && lists.gap.length !== 2) return { error: GAP_RULE }
  const gap: GapInput[] = []
  for (const g of lists.gap) {
    const parts = g.split(',').map(decimal)
    const [movePct, volPts] = parts
    if (parts.length !== 2 || typeof movePct !== 'number' || typeof volPts !== 'number' || Math.abs(movePct) > GAP_MAX || Math.abs(volPts) > GAP_MAX) {
      return { error: GAP_RULE }
    }
    gap.push({ movePct, volPts })
  }

  const flags = { gapLtp: true, gapVol: true }
  for (const name of ['gapLtp', 'gapVol'] as const) {
    const raw = q.get(name)
    if (raw === null) continue
    if (raw !== '0' && raw !== '1') return { error: `${name} must be 0 or 1` }
    flags[name] = raw === '1'
  }

  const basis = q.get('basis') ?? 'future'
  if (!(BASES as readonly string[]).includes(basis)) return { error: 'basis must be future, synthetic or cash' }

  return {
    expiry, exclude: lists.exclude, illiquid: lists.illiquid, ivOverrides: Object.fromEntries(ivs),
    callVol: shifts.callVol, putVol: shifts.putVol, future,
    gap: gap.length === 0 ? DEFAULT_GAP : gap, gapUseLtp: flags.gapLtp, gapUseVol: flags.gapVol, volBasis: basis as VolBasis,
  }
}

/**
 * The payoff package's market off a snapshot, now. Scenario prices on it too.
 * A month's future is its traded future, else the month's forward — the one
 * its options price against — so an unquoted future is valued there, not off
 * spot (Task 12 ruling). A month with neither is left out: it prices off spot.
 */
export function marketOf(s: BookSnapshot): ScenarioMarket {
  const known = (r: Readonly<Record<string, number | null>>): Record<string, number> =>
    Object.fromEntries(Object.entries(r).filter((e): e is [string, number] => e[1] !== null))
  const optionFutures = known(s.optionFutures)
  return { spot: s.spot ?? 0, futures: { ...optionFutures, ...known(s.futures) }, optionFutures, now: s.asOf }
}

/**
 * What `marketOf` does for an unquoted future, said once per month: a month
 * where one of `legs` is a future with no quote of its own and the month has a
 * forward (Task 12 ruling). Analysis passes its included legs, Scenario its
 * included legs and accepted hypotheticals. A month holding only options
 * values no future, so it gets no note.
 */
export function unquotedFutureNotes(s: BookSnapshot, legs: readonly PayoffLeg[]): string[] {
  const months = new Set(legs.filter((l) => l.instrument === 'future' && l.expiry !== ''
    && (s.futures[l.expiry] ?? null) === null && (s.optionFutures[l.expiry] ?? null) !== null).map((l) => l.expiry))
  return [...months].sort().map((e) => `${dayMonth(e)} future unquoted — valued at its forward`)
}

/** Σ qty × greek per share. */
function totalOf(rows: readonly { readonly leg: TraderLeg; readonly pt: LegPoint }[]): GreekTotals {
  const out: { -readonly [K in keyof GreekTotals]: number } = { ...ZERO }
  for (const { leg, pt } of rows) for (const g of GREEKS) out[g] += times(pt[g], leg.qty)
  return out
}

const minus = (a: GreekTotals, b: GreekTotals): GreekTotals =>
  ({ delta: a.delta - b.delta, gamma: a.gamma - b.gamma, vega: a.vega - b.vega, theta: a.theta - b.theta, vanna: a.vanna - b.vanna, volga: a.volga - b.volga })

/** How a leg is named in a warning: 'TCS 3000 CE 2026-10-27 (client C1)'. */
const nameOf = (l: TraderLeg): string => `${l.stock} ${contractText(l)} (client ${l.clientCode === '' ? 'manual' : l.clientCode})`

interface Entry {
  readonly priced: PricedLeg
  readonly leg: TraderLeg
  /** Today, at the IV used and the typed future. */
  readonly t: LegPoint
  /** Today, at market IV and spot. */
  readonly n: LegPoint
  readonly included: boolean
  readonly visible: boolean
  readonly row: AnalysisLeg
}

export function buildAnalysis(s: BookSnapshot, p: AnalysisParams, mtm: MtmBlock, nextDay: string, series: SeriesResult | null = null): AnalysisView {
  // keys that are not this book's legs (or, for the vol inputs, not its options) are ignored, so the answer is the no-params one
  const keys = new Set(s.legs.map((l) => l.leg.key))
  const options = new Set(s.legs.filter((l) => l.leg.instrument === 'option').map((l) => l.leg.key))
  const exclude = unique(p.exclude.filter((k) => keys.has(k)))
  const ticked = unique(p.illiquid.filter((k) => options.has(k)))
  const ivOverrides: Record<string, number> = Object.fromEntries(Object.entries(p.ivOverrides).filter(([k]) => options.has(k)))
  const params: AnalysisParams = { ...p, exclude, illiquid: ticked, ivOverrides }
  const excluded = new Set(exclude)
  const forced = new Set(ticked)

  // a closed market is the view's `closed`, which the page prints once: not a warning beside it too
  const warnings: string[] = s.warnings.filter((w) => w !== MARKET_CLOSED)
  const book = withIlliquid(s, forced)
  const market = marketOf(book)
  const now = { date: istDay(s.asOf), ms: s.asOf }
  const shifts: VolShifts = { callVolShift: p.callVol, putVolShift: p.putVol, ivOverrides }

  // T against the typed future: every month's future moves with it (spot × future / near future)
  const nf = s.nearFuture
  let future = nf?.price ?? null
  let futureOverridden = false
  let tSpot = market.spot
  if (p.future !== null) {
    if (nf === null) warnings.push(`Future override ${p.future} not applied — ${s.stock} lists no future`)
    else if (nf.price === null) warnings.push(`Future override ${p.future} not applied — no price for ${futureName(s.stock, nf.expiry)}`)
    else {
      tSpot = (market.spot * p.future) / nf.price
      future = p.future
      futureOverridden = true
    }
  }
  if (s.spot === null) warnings.push(`no spot price for ${s.stock} — the book is not valued: greeks 0, no breakevens, no gap rows`)
  warnings.push(...unquotedFutureNotes(s, book.legs.filter((l) => !excluded.has(l.leg.key)).map((l) => l.payoff)))

  const payoff = book.legs.map((l) => l.payoff)
  const tPts = legPoints(payoff, market, { spot: tSpot, point: now }, shifts)
  const nPts = legPoints(payoff, market, { spot: market.spot, point: now }, {})

  const entries = book.legs.map((priced, i): Entry => {
    const { leg } = priced
    const t = tPts[i] as LegPoint
    const n = nPts[i] as LegPoint
    const option = leg.instrument === 'option'
    const typed = option && Object.hasOwn(ivOverrides, leg.key)
    const iv = option ? ivUsed(priced.payoff, shifts) : null
    const unpriced = option ? iv !== null && t.iv === null : t.delta === 0
    const ivSource: IvSource = typed ? 'override' : priced.ivSource

    const remarks: string[] = []
    if (leg.source === 'manual') remarks.push('manual')
    if (option && priced.illiquidAuto) remarks.push('illiquid (no fresh quote)')
    else if (forced.has(leg.key)) remarks.push('illiquid (ticked)')
    if (option) {
      const from = priced.ivFrom === null ? '' : ` ${priced.ivFrom.strike} ${priced.ivFrom.optType}`
      if (ivSource === 'override') remarks.push('IV typed')
      else if (ivSource === 'other-side') remarks.push(`IV from other side${from}`)
      else if (ivSource === 'nearest') remarks.push(`IV from nearest${from}`)
      else if (ivSource === 'none') remarks.push(NO_IV)
    }
    if (unpriced) remarks.push(UNPRICED)

    const included = !excluded.has(leg.key)
    // with no spot nothing is valued, and one warning above says so
    if (included && s.spot !== null) {
      if (option && iv === null) warnings.push(`${nameOf(leg)}: ${NO_IV}`)
      else if (unpriced) warnings.push(`${nameOf(leg)}: ${UNPRICED} — left out of the figures`)
      const raw = rawIv(priced.payoff, shifts)
      if (raw !== null && raw < IV_FLOOR) warnings.push(`${nameOf(leg)}: IV ${raw.toFixed(4)} after the vol shift, floored at ${IV_FLOOR}`)
    }

    const ownFuture = s.futures[leg.expiry] ?? s.optionFutures[leg.expiry] ?? null
    const row: AnalysisLeg = {
      key: leg.key, source: leg.source, included,
      illiquid: option && (priced.illiquidAuto || forced.has(leg.key)), illiquidAuto: option && priced.illiquidAuto,
      maturity: maturityLabel(leg.instrument === 'share' ? '' : leg.expiry), maturityDate: leg.instrument === 'share' ? '' : leg.expiry,
      strike: option ? leg.strike : null,
      type: leg.instrument === 'share' ? 'EQ' : leg.instrument === 'future' ? 'F' : leg.optType === 'PE' ? 'P' : 'C',
      units: leg.qty, lots: priced.lotSize === null ? null : finite(leg.qty / priced.lotSize),
      ltp: priced.ltp, netPrice: leg.avgPrice, buyPrice: priced.bid, salePrice: priced.ask,
      grossMtm: priced.ltp === null ? null : finite(leg.qty * (priced.ltp - leg.avgPrice)),
      syntheticFuture: priced.syntheticFuture,
      timeValue: option && leg.strike !== null && leg.optType !== null && ownFuture !== null
        ? legTimeValue(leg.qty, priced.ltp, leg.strike, leg.optType, ownFuture) : null,
      ivUsed: iv, marketIv: priced.marketIv,
      delta: t.delta, deltaValue: times(t.delta, leg.qty), vega: t.vega, vegaValue: times(t.vega, leg.qty),
      remarks: remarks.join(' · '),
      gamma: t.gamma, gammaValue: times(t.gamma, leg.qty), theta: t.theta, thetaValue: times(t.theta, leg.qty),
      vanna: t.vanna, vannaValue: times(t.vanna, leg.qty), volga: t.volga, volgaValue: times(t.volga, leg.qty),
      ivSource, ivFrom: typed ? null : priced.ivFrom,
    }
    const visible = p.expiry === null || (leg.instrument !== 'share' && leg.expiry === p.expiry)
    return { priced, leg, t, n, included, visible, row }
  })

  const inBook = entries.filter((e) => e.included)
  const shown = inBook.filter((e) => e.visible)
  const T = totalOf(shown.map((e) => ({ leg: e.leg, pt: e.t })))
  const N = totalOf(shown.map((e) => ({ leg: e.leg, pt: e.n })))

  const held = [...new Set(entries.flatMap((e) => (e.leg.instrument === 'share' ? [] : [e.leg.expiry])))].sort()
  const monthWise = [...held, ...(entries.some((e) => e.leg.instrument === 'share') ? [''] : [])].map((expiry) => ({
    label: expiryTab(expiry), expiry,
    totals: totalOf(inBook.filter((e) => (e.leg.instrument === 'share' ? '' : e.leg.expiry) === expiry).map((e) => ({ leg: e.leg, pt: e.t }))),
  }))

  // To Neutralize: the whole book's T delta, in the nearest FUTURE's lots (an index's weekly options have none);
  // the future's own lot, else the near chain's — a lot of 0 is no lot
  const lotSize = positive(s.lotSize) ? s.lotSize : null
  const futureLot = nf?.lotSize ?? lotSize
  let neutral: ToNeutralize | null = null
  if (nf === null) warnings.push(`${s.stock} lists no future — To Neutralize is not worked out`)
  else if (futureLot === null) warnings.push(`no lot size for ${futureName(s.stock, nf.expiry)} — To Neutralize is not worked out`)
  else if (s.spot !== null) {
    const t = totalOf(inBook.map((e) => ({ leg: e.leg, pt: e.t })))
    neutral = { ...toNeutralize(t.delta, s.stock, nf.expiry, futureLot), ...deltaNeutral(s.spot, t.delta, t.gamma) }
  }

  const be = s.nearExpiry === null ? { low: null, high: null } : breakevenRange(inBook.map((e) => e.priced.payoff), market, s.nearExpiry, shifts)
  const side = (x: number | null): string => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(1))

  // Gap Up/Down on its vol basis: re-solved BEFORE the viewer's ticks go on (a tick on an auto-illiquid leg cannot be told from the verdict after)
  const gapBook = p.volBasis === s.basis ? book : withIlliquid(rebase(s, p.volBasis), forced)
  for (const w of gapBook.warnings) if (!s.warnings.includes(w)) warnings.push(w)
  // the vol basis moves options only: every future keeps its own price, an unquoted one its FUTURE-basis forward (Task 12 ruling)
  const gapMarket: ScenarioMarket = { ...marketOf(gapBook), futures: market.futures }
  const gapLegs: PayoffLeg[] = gapBook.legs.filter((l) => !excluded.has(l.leg.key)).map((l) => l.payoff)
  const atSpot = legPoints(gapLegs, gapMarket, { spot: gapMarket.spot, point: now }, { ivOverrides })
  // the value now (the Gap panel's "vs"; not the Open P&L: model at spot where there is no LTP, excluded legs dropped): each leg at its LTP when Ltp is ticked, else (or with no LTP) the model at spot
  const base = gapBook.legs.filter((l) => !excluded.has(l.leg.key)).reduce((sum, l, i) => {
    const atLtp = p.gapUseLtp && l.ltp !== null ? finite(l.leg.qty * (l.ltp - l.leg.avgPrice)) : null
    return sum + (atLtp ?? (atSpot[i] as LegPoint).pnl)
  }, 0)

  return {
    stock: s.stock, asOf: s.asOf, closed: s.closed, spot: s.spot, future, futureOverridden,
    nearExpiry: s.nearExpiry,
    daysToExpiry: s.nearExpiry === null ? null : Math.round((Date.parse(s.nearExpiry) - Date.parse(istDay(s.asOf))) / DAY_MS),
    nearFuture: nf?.expiry ?? null, lotSize, lotGcd: bookLotGcd(inBook.map((e) => e.priced.payoff), lotSize),
    months: held.map((expiry) => ({ expiry, label: expiryTab(expiry) })),
    params, legs: entries.filter((e) => e.visible).map((e) => e.row),
    totals: { T, N, note: TOTALS_NOTE },
    monthWise,
    optionGreeks: totalOf(shown.filter((e) => e.leg.instrument === 'option').map((e) => ({ leg: e.leg, pt: e.t }))),
    comparison: { T, N, diff: minus(T, N), note: COMPARISON_NOTE },
    toNeutralize: neutral,
    bookTimeValue: shown.reduce((sum, e) => sum + (e.row.timeValue ?? 0), 0),
    breakevens: { low: be.low, high: be.high, expiry: s.nearExpiry, text: `BEP = ${side(be.low)} - ${side(be.high)}` },
    gapPanel: {
      on: nextDay, basis: p.volBasis, useLtp: p.gapUseLtp, useVol: p.gapUseVol,
      rows: gapRows(gapLegs, gapMarket, nextDay, p.gap, ivOverrides, p.gapUseVol, base),
      note: `At the next open, 09:15 IST ${dayMonth(nextDay)} — our reading of VolHedge's Gap Up/Down (Phase 0 Q3)`,
    },
    mtm, unmatched: s.unmatched, warnings: unique(warnings),
    ...(series === null ? {} : { series: series.series, seriesTotal: series.total }),
  }
}

/** The series off the snapshot: each open leg's GrossMTM at the snapshot's LTP, as the leg table shows it; a leg it could not match has none. */
export function analysisSeries(s: BookSnapshot, legs: readonly TraderLeg[], base: SeriesBase, master: TradersMaster): SeriesResult {
  const ltp = new Map(s.legs.map((l) => [l.leg.key, l.ltp]))
  const today = istDate(s.asOf)
  return seriesPnl({
    ...base, trader: s.trader, stock: s.stock, today,
    legs: legs.filter((l) => isOpenLeg(l, today)).map((l) => {
      const price = ltp.get(l.key) ?? null
      return { key: l.key, instrument: l.instrument, expiry: l.expiry, strike: l.strike, optType: l.optType, mtm: price === null ? null : finite(l.qty * (price - l.avgPrice)) }
    }),
    lotSizeOf: (instrument, expiry) => masterLotSize(master, { stock: s.stock, instrument, expiry, strike: null, optType: null }),
  })
}

/** Null = the trader holds no open leg of `stock`. The snapshot is the minute's shared one; the viewer's inputs go on in `buildAnalysis`. */
export async function buildAnalysisView(d: TradersDeps, trader: string, stock: string, p: AnalysisParams, nowMs: number): Promise<AnalysisView | null> {
  const version = d.legs.version(trader)   // before the read: a write during it leaves this version stale (recomputed next time), never old legs under the new one
  const legs = await d.legs.open(trader, stock)
  if (!legs.some((l) => isOpenLeg(l, istDate(nowMs)))) return null
  const s = d.snapshots.get(trader, stock, legs, version)
  const [mtm, base] = await Promise.all([mtmOf(d, trader, stock, nowMs), d.series?.(trader, stock, version, nowMs)])
  if (mtm === null) return null
  return buildAnalysis(s, p, mtm, nextOpenDay(nowMs), base === undefined ? null : analysisSeries(s, legs, base, d.master()))
}
