/**
 * Repair on a trader's book (item 31): the desk's repair search
 * (`searchRepairs`, @algomaker/payoff) run on one expiry of the book, and the
 * card the page shows. It only suggests: a plan offers "Show on payoff"
 * (`whatIf`) and nothing else.
 *
 * The search prices every leg off one chain (moves.ts, "ONE EXPIRY"), so a job
 * is the book's near expiry, the earliest option expiry still held (P5): for an
 * index usually a weekly. It is scored against that expiry's forward, and its
 * legs are that expiry's options and futures. Everything else the book holds
 * (other expiries, shares, other futures) becomes one future, `OFFSET_LEG_ID`,
 * of their combined position delta in shares, entered at the forward: their
 * delta counts, their P&L starts at 0, and a plan that closes it is dropped and
 * counted (`repairViewOf`). P&L already booked is not known here; the job
 * passes 0 and the card says so.
 *
 * A job is plain data, so it crosses to a worker thread (repair-worker.ts),
 * and `runRepairJob` rebuilds the chain lookups from it the way the desk's
 * `chainLookups` (apps/api/src/routes/payoff.ts) builds them.
 */

import { b76Greeks, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE, DEFAULT_REPAIR_DIALS, ivFor, searchRepairs } from '@algomaker/payoff'
import type { Goal, Move, PayoffLeg, RepairDials, RepairPlan, SolvedIv, StrikeInfo } from '@algomaker/payoff'
import { FEED_NOT_TICKING } from '../market/quotes.ts'
import { istDate } from '../routes/kit.ts'
import type { BookView } from '../types.ts'
import { CLOSED_MAX_AGE_MS, type MonthQuotes } from './month-chain.ts'
import { liveExpiryFrom, nearExpiryOf } from './near-expiry.ts'
import type { RepairCardPlan, RepairView, WhatIfLeg } from './r3-wire.ts'
import { whatIfOfMoves } from './what-if.ts'

export type { RepairCardPlan, RepairView } from './r3-wire.ts'

/** Structured-cloneable: no functions. */
export interface RepairJob {
  legs: PayoffLeg[]; future: number; today: string; expiry: string; realised: 0
  dials: RepairDials; strikes: StrikeInfo[]; solved: SolvedIv[]; tailCapRupees?: number
}

export const OFFSET_LEG_ID = 'offset'
export const REALISED_NOT_COUNTED = 'P&L already booked is not counted in these figures'
const MARKET_CLOSED = "market closed — the plans are priced off the last session's quotes"

/** `offsetLegs`: how many of the book's legs the offset stands for (0 = nothing outside the job's expiry). */
export type RepairJobResult =
  | { job: RepairJob; offsetShares: number; offsetLegs: number; warnings: string[] }
  | { blocked: string }

/** No plan closes a leg: a trader's repair adds a leg, hedges, or shifts one (the user, 20 Oct 2026). */
export const REPAIR_OPS = ['add', 'hedge', 'shift'] as const

/** searchRepairs' own order. */
const GOALS: readonly Goal[] = ['REDUCE-LOSS', 'PROFITABLE-BY-EXPIRY', 'CHEAP-TAIL-CAP', 'MAX-CREDIT-SAFE']
/** Plans a card shows per goal beside the baseline: searchRepairs' own default. */
export const REPAIR_PLANS_SHOWN = 3
/**
 * Plans asked of the search per goal. A big offset is often the cheapest thing
 * to close, so the top three are often offset plans that the card drops; the
 * card then shows the next ones that leave it alone. Free: `topN` only picks
 * from the states the beam already scored.
 */
export const REPAIR_SEARCH_TOP_N = 20

const fold = (v: number): number => (v === 0 ? 0 : v)
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function listed(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] as string}`
}

/**
 * The expiry a repair works on: the earliest expiry in which the book holds an
 * option the master knows that still trades (P5). From the 15:40 F&O close on an
 * expiry day that is the next one, as for the band and the advice.
 */
export function repairExpiryOf(view: BookView, nowMs: number): string | null {
  return nearExpiryOf({ ...view, legs: view.legs.filter((l) => l.matched) }, liveExpiryFrom(nowMs))
}

/** An option that expired at today's close: no time left, so R1's view gives it no vol and no delta. */
const settledAt = (nowMs: number) => {
  const live = liveExpiryFrom(nowMs)
  return (l: BookView['legs'][number]): boolean => l.matched && l.instrument === 'option' && l.expiry < live
}

function holdingsOf(view: BookView, nowMs: number): string {
  const kinds: string[] = []
  if (view.legs.some((l) => l.matched && l.instrument === 'share')) kinds.push('shares')
  if (view.legs.some((l) => l.matched && l.instrument === 'future')) kinds.push('futures')
  if (view.legs.some((l) => !l.matched)) kinds.push('legs the instrument master does not know')
  if (view.legs.some(settledAt(nowMs))) kinds.push("options that expired at today's close")
  return listed(kinds)
}

/**
 * One book's job. `month` is `monthQuotes` for `repairExpiryOf(view, nowMs)`
 * (null when that is null); `lotSize` is that expiry's lot (0 = unknown: no
 * plan opens anything). Outside the session "fresh" is the last session's
 * quotes, the window the month's vols were solved through.
 */
export function repairJobOf(view: BookView, month: MonthQuotes | null, lotSize: number, nowMs: number, tailCap: number | null): RepairJobResult {
  const expiry = repairExpiryOf(view, nowMs)
  if (expiry === null) return { blocked: `no option legs to repair: ${view.stock} holds only ${holdingsOf(view, nowMs)}` }
  if (month === null || month.expiry !== expiry) return { blocked: `no ${expiry} chain to price the repair on` }
  const future = month.forward
  if (future === null) return { blocked: `no forward for ${expiry} yet` }

  const warnings: string[] = []
  if (view.closed) warnings.push(MARKET_CLOSED)
  else if (view.warnings.includes(FEED_NOT_TICKING)) warnings.push(FEED_NOT_TICKING)

  const legs: PayoffLeg[] = []
  const settled = settledAt(nowMs)
  let offsetDelta = 0
  let offsetLegs = 0
  let unknown = 0
  let expired = 0
  for (const l of view.legs) {
    if (!l.matched) { unknown++; continue }
    if (settled(l)) { expired++; continue }
    if (l.instrument === 'option' && l.expiry === expiry && l.strike !== null && l.optType !== null) {
      legs.push({ id: l.key, instrument: 'option', qty: l.qty, strike: l.strike, type: l.optType, expiry, entry: l.avgPrice, iv: l.iv })
      if (l.iv === null) warnings.push(`${l.strike} ${l.optType} ${expiry}: no vol solved from the chain — the plans count its P&L as 0`)
    } else if (l.instrument === 'future' && l.expiry === expiry) {
      legs.push({ id: l.key, instrument: 'future', qty: l.qty, strike: null, type: null, expiry, entry: l.avgPrice, iv: null })
    } else {
      // R1 gives an option with no forward or no solved vol a delta of 0: it is in the offset only by count
      const forward = view.forwards[l.expiry]
      if (l.instrument === 'option' && (l.iv === null || forward === undefined || forward === null)) {
        warnings.push(`${l.strike ?? ''} ${l.optType ?? ''} ${l.expiry}: no forward or vol — its delta is not in the offset`)
      }
      offsetDelta += l.delta
      offsetLegs++
    }
  }
  const offsetShares = fold(Math.round(offsetDelta))
  if (offsetShares !== 0) {
    legs.push({ id: OFFSET_LEG_ID, instrument: 'future', qty: offsetShares, strike: null, type: null, expiry, entry: future, iv: null })
  }
  if (unknown > 0) warnings.push(`${plural(unknown, 'leg', 'legs')} not understood (see the book) ${unknown === 1 ? 'is' : 'are'} left out of the repair`)
  if (expired > 0) warnings.push(`${plural(expired, 'option', 'options')} that expired at today's close ${expired === 1 ? 'is' : 'are'} left out of the repair`)
  if (lotSize <= 0) warnings.push(`the instrument master has no lot size for ${view.stock} ${expiry} — no plan below opens anything`)
  warnings.push(REALISED_NOT_COUNTED)

  // Delta at each strike's own solved vol: what the repairer's delta bands mean (chainLookups).
  const strikes: StrikeInfo[] = month.quotes.map((q) => {
    const iv = ivFor(month.ivs, q.strike, q.type)
    const delta = iv === null ? null : b76Greeks({ future, strike: q.strike, t: month.tYears, vol: iv, rate: DEFAULT_RATE, type: q.type }).delta
    return { strike: q.strike, type: q.type, price: q.price, ageMs: q.ageMs, iv, delta }
  })
  const dials: RepairDials = { ...DEFAULT_REPAIR_DIALS, lotSize, ...(view.closed ? { maxQuoteAgeMs: CLOSED_MAX_AGE_MS } : {}) }
  const job: RepairJob = {
    legs, future, today: istDate(nowMs), expiry, realised: 0, dials, strikes, solved: [...month.ivs],
    ...(tailCap === null ? {} : { tailCapRupees: tailCap }),
  }
  return { job, offsetShares, offsetLegs, warnings }
}

/**
 * The chain's price and vol for a contract, from the job alone. The vol is memoised: the beam asks it for every candidate book.
 * Exported so a worker can rebuild a `PlanSearchContext` (`searchPlans`) from a plain job the same way `runRepairJob` does.
 */
export function lookupsOf(job: RepairJob): { priceOf: (strike: number, type: OptionType) => number | null; ivOf: (strike: number, type: OptionType) => number | null } {
  const prices = new Map<string, number>()
  for (const s of job.strikes) {
    const k = `${s.strike}|${s.type}`
    if (s.price !== null && !prices.has(k)) prices.set(k, s.price)
  }
  const vols = new Map<string, number | null>()
  return {
    priceOf: (strike, type) => prices.get(`${strike}|${type}`) ?? null,
    ivOf: (strike, type) => {
      const k = `${strike}|${type}`
      const hit = vols.get(k)
      if (hit !== undefined) return hit
      const v = ivFor(job.solved, strike, type)
      vols.set(k, v)
      return v
    },
  }
}

/** The search itself; a trader's book has no bot, so no trigger flags. What repair-worker.ts runs. */
export function runRepairJob(job: RepairJob): readonly RepairPlan[] {
  const { priceOf, ivOf } = lookupsOf(job)
  return searchRepairs({
    legs: job.legs, future: job.future, today: job.today, expiry: job.expiry, realised: job.realised, dials: job.dials,
    priceOf, ivOf, strikes: job.strikes, triggers: null,
    ...(job.tailCapRupees === undefined ? {} : { tailCapRupees: job.tailCapRupees }),
  }, { topN: REPAIR_SEARCH_TOP_N, ops: REPAIR_OPS })
}

function touchesOffset(m: Move): boolean {
  return (m.op === 'close' || m.op === 'shift') && m.legId === OFFSET_LEG_ID
}

/**
 * What a plan's moves are read against, for its sentences (`planLines`) and its
 * Scenario rows (`planWhatIf`). The repair card and the assistant's plan cards
 * both render through these, so a plan reads the same wherever it is shown.
 */
export interface PlanLineInputs {
  /** The book the moves apply to: a shift or a close names its leg from here. */
  readonly legs: readonly PayoffLeg[]
  /** Shares per lot; 0 = unknown, sizes are then said in shares. */
  readonly lotSize: number
  /** The price a trade fills at; `qty` is that trade's signed shares (> 0 a buy). A chain mark ignores it. */
  readonly priceOf: (strike: number, type: OptionType, qty: number) => number | null
  /** What a future trades at: a `future` move, or a futures leg closed. */
  readonly futureMark?: number | null
  /** The book's expiry: an add, a hedge and a future are opened in it. */
  readonly expiry: string
  /**
   * The plan card's wording, which names the contract in full: "Sell 1 lot TCS 27 Oct 3600 CE @ 42.50",
   * "Buy 2 lots TCS Oct FUT @ 3612.40". Absent: the repair card's own wording, "Sell 1 lot (175) 3600 CE at 42.50".
   */
  readonly stock?: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** '2026-10-27' → { day: '27', month: 'Oct' }; the raw string as the day when it is not an ISO date. */
function dayMonth(iso: string): { day: string; month: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1]
  return m === null || month === undefined ? { day: iso, month: iso } : { day: String(Number(m[3])), month }
}

/** A price the inputs will trade on: finite and above zero, else null. A lookup that throws is no price. */
function priced(f: () => number | null | undefined): number | null {
  try {
    const p = f()
    return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

/** One move as a sentence: what is bought or sold, how much, at what. */
function lineOf(m: Move, inp: PlanLineInputs): string {
  const lot = inp.lotSize
  const card = inp.stock !== undefined
  const lotsOf = (qty: number): number | null => {
    const lots = lot > 0 ? Math.abs(qty) / lot : NaN
    return Number.isInteger(lots) ? lots : null
  }
  const size = (qty: number): string => {
    const n = Math.abs(qty)
    const lots = lotsOf(qty)
    if (card) return lots === null ? `${n} shares` : plural(lots, 'lot', 'lots')
    return lots === null ? `${n}` : `${plural(lots, 'lot', 'lots')} (${n})`
  }
  const side = (qty: number): string => (qty < 0 ? 'sell' : 'buy')
  const Side = (qty: number): string => (qty < 0 ? 'Sell' : 'Buy')
  const at = (p: number | null): string => card ? (p === null ? '(no price)' : `@ ${p.toFixed(2)}`) : (p === null ? 'with no price' : `at ${p.toFixed(2)}`)
  const price = (strike: number, type: OptionType, qty: number): number | null => priced(() => inp.priceOf(strike, type, qty))
  const futurePx = priced(() => inp.futureMark)
  const futureAt = card ? (futurePx === null ? '@ market' : `@ ${futurePx.toFixed(2)}`) : (futurePx === null ? 'at the market' : `at ${futurePx.toFixed(2)}`)
  const option = (expiry: string, strike: number | null, type: OptionType): string => {
    const { day, month } = dayMonth(expiry)
    return `${inp.stock ?? ''} ${day} ${month} ${strike ?? ''} ${type}`
  }
  const fut = (expiry: string): string => `${inp.stock ?? ''} ${dayMonth(expiry).month} FUT`

  if (m.op === 'add' || m.op === 'hedge') {
    const contract = card ? option(inp.expiry, m.strike, m.type) : `${m.strike} ${m.type}`
    return `${Side(m.qty)} ${size(m.qty)} ${contract} ${at(price(m.strike, m.type, m.qty))}`
  }
  if (m.op === 'future') return `${Side(m.qty)} ${size(m.qty)} ${card ? fut(inp.expiry) : 'FUT'} ${futureAt}`
  const leg = inp.legs.find((l) => l.id === m.legId)
  if (leg === undefined) return `${m.op} ${m.legId}`
  const long = leg.qty < 0 ? 'short' : 'long'
  if (card) {
    const held = `${long} ${leg.type === null ? fut(leg.expiry) : option(leg.expiry, leg.strike, leg.type)}`
    if (leg.strike === null || leg.type === null) {
      return m.op === 'close' ? `Close ${held}: ${side(-leg.qty)} ${size(leg.qty)} ${futureAt}` : `${m.op} ${held}`
    }
    const exit = `${side(-leg.qty)} ${size(leg.qty)} ${at(price(leg.strike, leg.type, -leg.qty))}`
    if (m.op === 'close') return `Close ${held}: ${exit}`
    return `Shift ${held} to ${m.toStrike} ${leg.type}: ${exit}, ${side(leg.qty)} ${size(leg.qty)} ${m.toStrike} ${leg.type} ${at(price(m.toStrike, leg.type, leg.qty))}`
  }
  const held = `the ${long} ${leg.type === null ? 'FUT' : `${leg.strike ?? ''} ${leg.type}`} (${leg.qty > 0 ? '+' : ''}${leg.qty})`
  if (leg.strike === null || leg.type === null) {
    return m.op === 'close' ? `Close ${held}: ${side(-leg.qty)} ${size(leg.qty)} at the market` : `${m.op} ${held}`
  }
  const exit = `${side(-leg.qty)} ${size(leg.qty)}`
  if (m.op === 'close') return `Close ${held}: ${exit} ${at(price(leg.strike, leg.type, -leg.qty))}`
  const to = `${m.toStrike} ${leg.type}`
  return `Shift ${held} to ${to}: ${exit} ${leg.strike} ${leg.type} ${at(price(leg.strike, leg.type, -leg.qty))}, ${side(leg.qty)} ${size(leg.qty)} ${to} ${at(price(m.toStrike, leg.type, leg.qty))}`
}

/** A plan's moves as sentences, one per move, in its order. */
export function planLines(moves: readonly Move[], inp: PlanLineInputs): string[] {
  return moves.map((m) => lineOf(m, inp))
}

/** A plan's moves as the Scenario rows "Show on payoff" loads, at the same fills `planLines` quotes. */
export function planWhatIf(moves: readonly Move[], inp: PlanLineInputs): WhatIfLeg[] {
  return whatIfOfMoves(moves, inp.legs, inp.priceOf, inp.expiry, inp.futureMark)
}

function offsetNote(legs: number, shares: number, expiry: string): string {
  const which = `${plural(legs, 'leg', 'legs')} outside ${expiry} — other expiries, shares and other futures —`
  return shares === 0
    ? `${which} net to no delta and are left out: no plan trades them`
    : `${which} are held as one fixed future of ${shares} shares, their combined delta, entered at the ${expiry} forward: its P&L starts at 0 and no plan trades it`
}

/**
 * The card. Per goal, in the search's order: its best `REPAIR_PLANS_SHOWN`
 * plans that leave the offset alone, then the baseline. Each has its moves as
 * sentences and as "Show on payoff" legs priced off the job's own chain. A plan
 * that closes or shifts the offset is dropped, and counted when it ranked
 * among those shown.
 */
export function repairViewOf(stock: string, r: RepairJobResult, plans: readonly RepairPlan[], computedAt: number, cached: boolean, nowMs: number): RepairView {
  if ('blocked' in r) return { stock, expiry: null, asOf: nowMs, computedAt, cached, goals: [], offset: null, warnings: [], error: r.blocked }
  const { job } = r
  const { priceOf } = lookupsOf(job)
  const inp: PlanLineInputs = { legs: job.legs, lotSize: job.dials.lotSize, priceOf: (k, t) => priceOf(k, t), expiry: job.expiry }
  const byGoal = new Map<Goal, RepairCardPlan[]>(GOALS.map((g) => [g, []]))
  const shown = new Map<Goal, number>()
  let dropped = 0
  for (const p of plans) {
    const list = byGoal.get(p.goal)
    if (list === undefined) continue
    if (p.moves.length > 0) {
      const n = shown.get(p.goal) ?? 0
      if (n >= REPAIR_PLANS_SHOWN) continue
      if (p.moves.some(touchesOffset)) { dropped++; continue }
      shown.set(p.goal, n + 1)
    }
    list.push({
      moves: p.moves, score: p.score, flags: p.flags,
      lines: planLines(p.moves, inp),
      whatIf: planWhatIf(p.moves, inp),
    })
  }
  const warnings = [...r.warnings]
  if (dropped > 0) {
    warnings.push(dropped === 1
      ? "1 plan touched the other expiries' fixed offset and was dropped"
      : `${dropped} plans touched the other expiries' fixed offset and were dropped`)
  }
  const shares = job.legs.find((l) => l.id === OFFSET_LEG_ID)?.qty ?? 0
  return {
    stock, expiry: job.expiry, asOf: nowMs, computedAt, cached,
    goals: [...byGoal].map(([goal, list]) => ({ goal, plans: list })),
    offset: r.offsetLegs === 0 ? null : { shares, note: offsetNote(r.offsetLegs, shares, job.expiry) },
    warnings, error: null,
  }
}
