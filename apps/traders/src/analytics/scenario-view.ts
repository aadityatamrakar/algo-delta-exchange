/**
 * VolHedge v50's Scenario window for one book (spec items 18–21, 23): the
 * spot × date grid, its totals row and the scenario leg table, with the
 * viewer's hypothetical legs; and Sensibull's target-date/expiry curve and P&L
 * table. Reads only: the viewer's inputs and hypothetical legs arrive in the
 * request body and are never stored.
 *
 * Two P&L bases, as the two screens have them. The grid and its totals are
 * VolHedge's: carried legs since yesterday's close and today's trades since the
 * fill (`dayLegs`, plus what the contracts closed today realised), so the top
 * row at CMP is the MTM block's Gross MTM total; when yesterday's close is
 * unknown the grid falls back to net price and `baseNote` says so. The chart
 * and the table are Sensibull's: against net price. A hypothetical leg is
 * entered at its own rate (typed, else LTP, else the model at its IV) in all.
 *
 * Every leg is valued on its own month (`scenario`, `legPoints`). A
 * hypothetical in a month the snapshot did not price has that month priced as
 * `priceBook` prices a held one. Viewer keys that are not this book's legs are
 * ignored, as in Analysis; an excluded leg keeps its row in the leg table and
 * leaves every figure. Nothing here is NaN: what would make one is refused,
 * naming the field.
 */

import { isTradingDay } from '@algomaker/desk-engine'
import { b76Price, yearsToExpiry } from '@algomaker/greeks'
import {
  DEFAULT_RATE, forwardAt, istDay, ivUsed, legPoints, liquidIv, payoffCurve, payoffTable, scenario, scenarioAxes,
  type LegPoint, type PayoffLeg, type ScenarioCell, type ScenarioMarket, type SolvedIv, type VolShifts,
} from '@algomaker/payoff'
import type { TradersDeps } from '../deps.ts'
import { spotTokenOf } from '../market/master.ts'
import { isIsoDate, isObject, istDate } from '../routes/kit.ts'
import { isOpenLeg, type OptType } from '../types.ts'
import { marketOf, times, unquotedFutureNotes } from './analysis.ts'
import { monthQuotes, monthWarning } from './month-chain.ts'
import { dayLegs, mtmInputsOf } from './mtm.ts'
import { MARKET_CLOSED, chainIvs, withIlliquid, type BookSnapshot, type SnapshotMarket } from './snapshot.ts'
import { bookLotGcd } from './units.ts'
import type { HypotheticalLeg, ScenarioLegRow, ScenarioRequest, ScenarioResolved, ScenarioView } from './wire.ts'

type Verdict = ScenarioView['hypothetical'][number]
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const SHIFT_MAX = 50
const IV_MAX = 5
const STEP_MAX = 100
const TARGETS_MAX = 5
const HYPOTHETICAL_MAX = 20
/** No underlying trades near a crore a share: above it a price is a slip of the keyboard, and every product stays finite. */
const PRICE_MAX = 10_000_000
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/

export const DAY_BASE_NOTE = "Grid: P&L since yesterday's close (carried legs) and since the fill (today's trades), as VolHedge. Chart and table: P&L against net price, as Sensibull."
export const NET_BASE_NOTE = "Grid, chart and table: P&L against net price — yesterday's close is unknown (see the MTM block)"

/** The one refusal that is the book's, not the request's: the route answers it 409. */
export function noListedExpiry(stock: string): string {
  return `${stock} has no listed expiry`
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const orNull = (v: number | null | undefined): number | null => (num(v) && v > 0 ? v : null)
const later = (a: string, b: string): string => (a > b ? a : b)

function parseHypothetical(v: unknown, at: string): HypotheticalLeg | { readonly error: string } {
  if (!isObject(v)) return { error: `${at} must be an object` }
  const { id, instrument, expiry, strike, optType, qty, price, iv } = v
  if (typeof id !== 'string' || !ID_RE.test(id)) return { error: `${at}.id must be 1 to 32 letters, digits, _ or -` }
  if (instrument !== 'option' && instrument !== 'future' && instrument !== 'share') return { error: `${at}.instrument must be option, future or share` }
  const option = instrument === 'option'
  if (instrument !== 'share' && !isIsoDate(expiry)) return { error: `${at}.expiry must be a date (YYYY-MM-DD)` }
  if (option && !(num(strike) && strike > 0 && strike <= PRICE_MAX)) return { error: `${at}.strike must be a price above 0 and at most ${PRICE_MAX}` }
  if (option && optType !== 'CE' && optType !== 'PE') return { error: `${at}.optType must be CE or PE` }
  if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty === 0) return { error: `${at}.qty must be a non-zero whole number of shares` }
  const rate = price ?? null
  if (rate !== null && !(num(rate) && rate >= 0 && rate <= PRICE_MAX)) return { error: `${at}.price must be null or a price from 0 to ${PRICE_MAX}` }
  const vol = option ? iv ?? null : null   // futures and shares have no vol: whatever was sent is dropped
  if (vol !== null && !(num(vol) && vol > 0 && vol <= IV_MAX)) return { error: `${at}.iv must be null or an IV as a decimal, above 0 and at most ${IV_MAX}` }
  return {
    id, instrument, expiry: instrument === 'share' ? '' : (expiry as string),
    strike: option ? (strike as number) : null, optType: option ? (optType as OptType) : null, qty,
    price: rate as number | null, iv: vol as number | null,
  }
}

/**
 * The page's body: `exclude`/`illiquid` lists of leg keys, `ivOverrides` key →
 * IV (0 < iv ≤ 5), `spot` and `middle` prices, the three vol shifts in vol
 * points (|x| ≤ 50), `start`/`end`/`targetDate` dates, `everyNth` and `count`
 * numbers (their ranges are the grid's: `scenarioAxes`), `stepPct` (0, 100],
 * at most 5 `targets` and 20 `hypothetical` legs (ids unique). Only what was
 * given comes back; the defaults are `buildScenario`'s. Anything else in the
 * body is not the parser's. Each error starts with the field.
 */
export function parseScenarioRequest(raw: unknown): ScenarioRequest | { readonly error: string } {
  if (!isObject(raw)) return { error: 'the body must be a JSON object' }
  const out: Mutable<ScenarioRequest> = {}
  for (const name of ['exclude', 'illiquid'] as const) {
    const v = raw[name]
    if (v === undefined) continue
    if (!Array.isArray(v) || !v.every((k) => typeof k === 'string')) return { error: `${name} must be a list of leg keys` }
    out[name] = v as string[]
  }
  const ivs = raw['ivOverrides']
  if (ivs !== undefined) {
    if (!isObject(ivs) || !Object.values(ivs).every((x) => num(x) && x > 0 && x <= IV_MAX)) {
      return { error: `ivOverrides must map leg keys to IVs as decimals, above 0 and at most ${IV_MAX}` }
    }
    out.ivOverrides = ivs as Record<string, number>
  }
  for (const name of ['spot', 'middle'] as const) {
    const v = raw[name]
    if (v === undefined) continue
    if (!num(v) || v <= 0 || v > PRICE_MAX) return { error: `${name} must be a price above 0 and at most ${PRICE_MAX}` }
    out[name] = v
  }
  for (const name of ['callVolShift', 'putVolShift', 'volShift'] as const) {
    const v = raw[name]
    if (v === undefined) continue
    if (!num(v) || Math.abs(v) > SHIFT_MAX) return { error: `${name} must be vol points from -${SHIFT_MAX} to ${SHIFT_MAX}` }
    out[name] = v
  }
  for (const name of ['start', 'end', 'targetDate'] as const) {
    const v = raw[name]
    if (v === undefined) continue
    if (!isIsoDate(v)) return { error: `${name} must be a date (YYYY-MM-DD)` }
    out[name] = v
  }
  for (const name of ['everyNth', 'count'] as const) {
    const v = raw[name]
    if (v === undefined) continue
    if (!num(v)) return { error: `${name} must be a number` }
    out[name] = v
  }
  const step = raw['stepPct']
  if (step !== undefined) {
    if (!num(step) || step <= 0 || step > STEP_MAX) return { error: `stepPct must be a percent above 0 and at most ${STEP_MAX}` }
    out.stepPct = step
  }
  const targets = raw['targets']
  if (targets !== undefined) {
    if (!Array.isArray(targets) || targets.length > TARGETS_MAX || !targets.every((t) => num(t) && t > 0 && t <= PRICE_MAX)) {
      return { error: `targets must be at most ${TARGETS_MAX} prices, each above 0 and at most ${PRICE_MAX}` }
    }
    out.targets = targets as number[]
  }
  const hyp = raw['hypothetical']
  if (hyp !== undefined) {
    if (!Array.isArray(hyp) || hyp.length > HYPOTHETICAL_MAX) return { error: `hypothetical must be a list of at most ${HYPOTHETICAL_MAX} legs` }
    const legs: HypotheticalLeg[] = []
    for (const [i, v] of hyp.entries()) {
      const h = parseHypothetical(v, `hypothetical[${i}]`)
      if ('error' in h) return h
      if (legs.some((l) => l.id === h.id)) return { error: `hypothetical: id ${h.id} is given twice` }
      legs.push(h)
    }
    out.hypothetical = legs
  }
  return out
}

/** The snapshot's last price for a contract: a share's spot, a future's mark, an option's chain quote; null when it has none. */
function lastPrice(s: BookSnapshot, l: Pick<PayoffLeg, 'instrument' | 'expiry' | 'strike' | 'type'>): number | null {
  if (l.instrument === 'future') return l.expiry === '' ? s.spot : s.futures[l.expiry] ?? null
  return orNull(s.quotes[l.expiry]?.find((q) => q.strike === l.strike && q.type === l.type)?.price)
}

/** The live price of a listed contract; null with no token or no quote. */
function liveQuote(m: SnapshotMarket, token: number | undefined): number | null {
  return token === undefined ? null : orNull(m.quotes.quote(token)?.price)
}

/** A month's forward and vols: the snapshot's, else solved now from whatever quotes there are (a month nobody holds). */
function monthOf(s: BookSnapshot, m: SnapshotMarket, expiry: string): { readonly forward: number | null; readonly chain: readonly SolvedIv[] } {
  const chain = s.chains[expiry]
  if (chain !== undefined) return { forward: s.optionFutures[expiry] ?? null, chain }
  const solved = chainIvs(m, s.stock, expiry, s.asOf)
  return { forward: solved?.forward ?? null, chain: solved?.solved ?? [] }
}

/**
 * One hypothetical row: a listed contract, its IV (typed, else the month's
 * `liquidIv`) and its rate, typed or else: a future where the market prices
 * it (`marketOf`: its traded future, else the month's forward), an option at
 * its snapshot or live LTP, else the model at its IV on the month's forward,
 * a share at spot. Refused with the reason when it is not listed, has
 * expired, has no IV, or has no price at all; a share where the master has
 * no cash-equity row is refused (Ruling). Never stored.
 */
export function resolveHypothetical(h: HypotheticalLeg, s: BookSnapshot, m: SnapshotMarket): { readonly leg: PayoffLeg | null; readonly view: Verdict } {
  const refuse = (reason: string): { leg: null; view: Verdict } => ({ leg: null, view: { id: h.id, accepted: false, reason, entry: null, iv: null } })
  const accept = (leg: PayoffLeg): { leg: PayoffLeg; view: Verdict } => ({ leg, view: { id: h.id, accepted: true, reason: null, entry: leg.entry, iv: leg.iv } })
  // the parser's rules again, for a caller that did not parse: refused, never priced as NaN
  if (!Number.isSafeInteger(h.qty) || h.qty === 0) return refuse('qty must be a non-zero whole number of shares')
  if (h.price !== null && !(Number.isFinite(h.price) && h.price >= 0)) return refuse('the rate must be a price of 0 or more')
  if (h.iv !== null && !(Number.isFinite(h.iv) && h.iv > 0)) return refuse('the vol must be above 0')
  const master = m.master()
  const base = { id: h.id, qty: h.qty, strike: null, type: null, iv: null }

  if (h.instrument === 'share') {
    // no NSE cash-equity row in the master: no shares to hold (Ruling); an index when R1's spot for it is the index's own
    if (!master.cash.has(s.stock)) {
      return refuse(spotTokenOf(master, s.stock) !== null ? `${s.stock} is an index — no shares` : `${s.stock} has no cash-equity row in the instrument master — no shares`)
    }
    const entry = h.price ?? s.spot
    return entry === null ? refuse(`no price for ${s.stock} — type a rate`) : accept({ ...base, instrument: 'future', expiry: '', entry })
  }

  const name = h.instrument === 'future' ? `${s.stock} ${h.expiry} FUT` : `${s.stock} ${h.expiry} ${h.strike ?? ''} ${h.optType ?? ''}`
  if (h.expiry < istDay(s.asOf)) return refuse(`${name} has expired`)
  if (h.instrument === 'future') {
    const f = master.options.future(s.stock, h.expiry)
    if (f === null) return refuse(`${name} is not listed`)
    // what the market prices it at (marketOf): the traded future, else the month's forward — so no P&L at CMP and now
    const entry = h.price ?? lastPrice(s, { ...base, instrument: 'future', expiry: h.expiry }) ?? monthOf(s, m, h.expiry).forward
    return entry === null ? refuse(`no price for ${name} — type a rate`) : accept({ ...base, instrument: 'future', expiry: h.expiry, entry })
  }

  if (h.strike === null || h.optType === null) return refuse('an option needs a strike and CE or PE')
  const contract = master.options.resolve(s.stock, h.expiry, h.strike, h.optType)
  if (contract === null) return refuse(`${name} is not listed`)
  const month = monthOf(s, m, h.expiry)
  const iv = h.iv ?? liquidIv(month.chain, h.strike, h.optType, false).iv
  if (iv === null) return refuse(`no IV for ${h.expiry} — type one`)
  const leg = { ...base, instrument: 'option', strike: h.strike, type: h.optType, expiry: h.expiry, iv } as const
  // the model on the forward the scenario prices it against: a month with no price prices off spot
  const future = month.forward ?? s.spot
  const model = future === null ? null : b76Price({ future, strike: h.strike, t: yearsToExpiry(h.expiry, s.asOf), vol: iv, rate: DEFAULT_RATE, type: h.optType })
  const entry = h.price ?? lastPrice(s, leg) ?? liveQuote(m, contract.instrumentToken) ?? (num(model) ? model : null)
  return entry === null ? refuse(`no price for ${name} — type a rate`) : accept({ ...leg, entry })
}

/**
 * The snapshot with every listed month a hypothetical names but the snapshot
 * did not price (no leg held there, not the near month) priced as `priceBook`
 * prices a held one — its future, forward, quotes and vols — so the
 * hypothetical is valued on its own month, not off spot. Each such month's
 * warning (valued off spot carried, or no price) comes back apart, for the
 * caller to show only when an accepted row uses the month. A copy: the
 * minute's shared snapshot is untouched.
 */
function withHypotheticalMonths(
  s: BookSnapshot, m: SnapshotMarket, hyps: readonly HypotheticalLeg[],
): { readonly snapshot: BookSnapshot; readonly notes: ReadonlyMap<string, string> } {
  const master = m.master()
  const today = istDay(s.asOf)
  const months = [...new Set(hyps.filter((h) => h.instrument !== 'share' && isIsoDate(h.expiry) && h.expiry >= today && !(h.expiry in s.chains)
    && (master.options.chain(s.stock, h.expiry) !== null || master.options.future(s.stock, h.expiry) !== null)).map((h) => h.expiry))].sort()
  const notes = new Map<string, string>()
  if (months.length === 0) return { snapshot: s, notes }
  const futures = { ...s.futures }
  const optionFutures = { ...s.optionFutures }
  const quotes = { ...s.quotes }
  const chains = { ...s.chains }
  for (const e of months) {
    const mq = monthQuotes(master, m.quotes, s.stock, e, s.spot, s.asOf, s.closed)
    if (!(e in futures)) futures[e] = mq.future
    optionFutures[e] = mq.forward
    quotes[e] = mq.quotes
    chains[e] = mq.ivs
    const w = monthWarning(mq)
    if (w !== null) notes.set(e, w)
  }
  return { snapshot: { ...s, futures, optionFutures, quotes, chains }, notes }
}

/** The same market seen from `spot`: every future scaled by spot / market spot, so each leg prices as before at any price, and the curve and table centre on the CMP. */
function centredOn(m: ScenarioMarket, spot: number): ScenarioMarket {
  if (spot === m.spot) return m
  const k = spot / m.spot
  const scaled = (r: Readonly<Record<string, number>>): Record<string, number> => Object.fromEntries(Object.entries(r).map(([e, f]) => [e, f * k]))
  return { ...m, spot, futures: scaled(m.futures), ...(m.optionFutures === undefined ? {} : { optionFutures: scaled(m.optionFutures) }) }
}

/** VolHedge's scenario leg table row: per share at one point, value = × qty. */
function legRow(l: PayoffLeg, pt: LegPoint, hypothetical: boolean, ltp: number | null, market: ScenarioMarket, spot: number, shifts: VolShifts): ScenarioLegRow {
  return {
    id: l.id, hypothetical, expiry: l.expiry,
    type: l.instrument === 'option' ? (l.type === 'PE' ? 'P' : 'C') : l.expiry === '' ? 'EQ' : 'F',
    underlying: forwardAt(market, l.expiry, spot, l.instrument), strike: l.strike, qty: l.qty,
    rate: l.entry, vol: ivUsed(l, shifts), ltp,
    delta: pt.delta, deltaValue: times(pt.delta, l.qty), gamma: pt.gamma, gammaValue: times(pt.gamma, l.qty),
    vega: pt.vega, vegaValue: times(pt.vega, l.qty), theta: pt.theta, thetaValue: times(pt.theta, l.qty),
  }
}

/**
 * The view for one snapshot. `hyps` are the accepted hypothetical legs (they
 * join every figure), `hypViews` every row's verdict, echoed. `day` is
 * `dayLegs` over the same snapshot; null (yesterday's close unknown) puts the
 * grid on net price. Errors are the range checks that need the book: no
 * listed expiry, no spot and none typed, a target date outside today to the
 * last expiry held (a hypothetical's month counts), and `scenarioAxes`' own.
 */
export function buildScenario(
  s: BookSnapshot, req: ScenarioRequest, hyps: readonly PayoffLeg[], hypViews: ScenarioView['hypothetical'],
  day: { readonly legs: readonly PayoffLeg[]; readonly offset: number } | null,
): ScenarioView | { readonly error: string } {
  const near = s.nearExpiry
  if (near === null) return { error: noListedExpiry(s.stock) }
  const spot = req.spot ?? s.spot
  if (spot === null) return { error: `spot: no price for ${s.stock} yet — type the CMP` }
  const today = istDay(s.asOf)
  const lastExpiry = [s.lastExpiry ?? near, ...hyps.map((l) => l.expiry)].reduce(later, near)
  const r: ScenarioResolved = {
    spot, callVolShift: req.callVolShift ?? 0, putVolShift: req.putVolShift ?? 0, volShift: req.volShift ?? 0,
    start: req.start ?? today, end: req.end ?? near, everyNth: req.everyNth ?? 1,
    middle: req.middle ?? s.atm[near] ?? spot, stepPct: req.stepPct ?? 0.5, count: req.count ?? 50, targetDate: req.targetDate ?? today,
  }
  if (!isIsoDate(r.targetDate) || r.targetDate < today || r.targetDate > lastExpiry) {
    return { error: `targetDate must be a date from ${today} to ${lastExpiry}, the last expiry in the scenario` }
  }
  const axes = scenarioAxes({
    middle: r.middle, stepPct: r.stepPct, count: r.count, spot, start: r.start, end: r.end, everyNth: r.everyNth, expiry: near, now: s.asOf, isTradingDay,
  })
  if ('error' in axes) return { error: axes.error }

  // keys that are not this book's legs (or, for the vol inputs, not its options) are ignored, as in Analysis
  const keys = new Set(s.legs.map((l) => l.leg.key))
  const options = new Set(s.legs.filter((l) => l.leg.instrument === 'option').map((l) => l.leg.key))
  const excluded = new Set((req.exclude ?? []).filter((k) => keys.has(k)))
  const book = withIlliquid(s, new Set((req.illiquid ?? []).filter((k) => options.has(k))))
  const ivOverrides = Object.fromEntries(Object.entries(req.ivOverrides ?? {}).filter(([k]) => options.has(k)))
  const shifts: VolShifts = { callVolShift: r.callVolShift, putVolShift: r.putVolShift, volShift: r.volShift, ivOverrides }

  // a closed market is the view's `closed`, which the page prints once: not a warning beside it too
  const warnings = s.warnings.filter((w) => w !== MARKET_CLOSED)
  // with no live spot the typed CMP is what the futures are scaled from
  const market: ScenarioMarket = s.spot === null ? { ...marketOf(book), spot } : marketOf(book)
  if (s.spot === null) warnings.push(`no spot price for ${s.stock} — the scenario is valued around the typed CMP ${spot}`)

  const included = book.legs.filter((l) => !excluded.has(l.leg.key))
  const net: readonly PayoffLeg[] = [...included.map((l) => l.payoff), ...hyps]
  warnings.push(...unquotedFutureNotes(book, net))
  // the grid on the day's base when it covers every included leg, else on net price
  const entries = new Map(day?.legs.map((l) => [l.id, l.entry]) ?? [])
  const onDay = day !== null && included.every((l) => entries.has(l.leg.key))
  const gridLegs = onDay ? [...included.map((l) => ({ ...l.payoff, entry: entries.get(l.leg.key) as number })), ...hyps] : net
  const offset = onDay && day !== null ? day.offset : 0
  const grid = scenario(gridLegs, market, axes.spots, axes.columns, shifts)
  if (grid.cells.length !== axes.spots.length) return { error: `the grid cannot be valued: ${grid.warnings.join('; ')}` }
  const cells = offset === 0 ? grid.cells : grid.cells.map((row) => row.map((c) => ({ ...c, pnl: c.pnl + offset })))

  // the leg table at CMP on the first column: every book leg (an excluded one too: the page shows it muted), then the hypotheticals
  const point = axes.columns[0] as (typeof axes.columns)[number]
  const rows: readonly PayoffLeg[] = [...book.legs.map((l) => l.payoff), ...hyps]
  const pts = legPoints(rows, market, { spot, point }, shifts)
  const legs = rows.map((l, i) => {
    const ltp = i < book.legs.length ? (book.legs[i] as (typeof book.legs)[number]).ltp : lastPrice(book, l)
    return legRow(l, pts[i] as LegPoint, i >= book.legs.length, ltp, market, spot, shifts)
  })
  const atCmp = scenario(net, market, [spot], [point], shifts)

  const lotSize = s.lotSize !== null && s.lotSize > 0 ? s.lotSize : null
  const centred = centredOn(market, spot)
  return {
    stock: s.stock, asOf: s.asOf, closed: s.closed, nearExpiry: near, lastExpiry, expiries: s.expiries,
    lotSize, lotGcd: bookLotGcd(net, lotSize), resolved: r,
    totals: (cells[axes.currentRow] as readonly ScenarioCell[])[0] as ScenarioCell,
    legs,
    grid: { spots: axes.spots, currentRow: axes.currentRow, dates: axes.columns.map((c) => c.date), labels: axes.labels, cells },
    baseNote: onDay ? DAY_BASE_NOTE : NET_BASE_NOTE,
    chart: { targetDate: r.targetDate, expiryDate: near, spot, points: payoffCurve(net, centred, r.targetDate, near, shifts) },
    table: payoffTable(net, centred, r.targetDate, near, req.targets ?? [], shifts),
    hypothetical: hypViews,
    warnings: [...new Set([...warnings, ...grid.warnings, ...atCmp.warnings])],
  }
}

/**
 * Null = the trader holds no open leg of `stock`. The snapshot is the minute's
 * shared one (version read before the legs, as Analysis); each hypothetical is
 * resolved on it, its month priced first when nobody holds it; the day base
 * comes from the MTM block's inputs.
 */
export async function buildScenarioView(
  d: TradersDeps, trader: string, stock: string, req: ScenarioRequest, nowMs: number,
): Promise<ScenarioView | { readonly error: string } | null> {
  const version = d.legs.version(trader)   // before the read: a write during it leaves this version stale (recomputed next time), never old legs under the new one
  const legs = await d.legs.open(trader, stock)
  if (!legs.some((l) => isOpenLeg(l, istDate(nowMs)))) return null
  const m: SnapshotMarket = { master: d.master, quotes: d.quotes, now: () => nowMs }
  const hyps = req.hypothetical ?? []
  const { snapshot, notes } = withHypotheticalMonths(d.snapshots.get(trader, stock, legs, version), m, hyps)
  const resolved = hyps.map((h) => resolveHypothetical(h, snapshot, m))
  const accepted = resolved.flatMap((x) => (x.leg === null ? [] : [x.leg]))
  // a month only the hypotheticals named is warned about only when an accepted one uses it
  const used = new Set(accepted.map((l) => l.expiry))
  const s: BookSnapshot = { ...snapshot, warnings: [...snapshot.warnings, ...[...notes].flatMap(([e, w]) => (used.has(e) ? [w] : []))] }
  const day = dayLegs(await mtmInputsOf(d, s, nowMs))
  return buildScenario(s, req, accepted, resolved.map((x) => x.view), day)
}
