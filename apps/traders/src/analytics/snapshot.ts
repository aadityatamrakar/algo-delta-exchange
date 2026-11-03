/**
 * One book's market, read once: every price, chain and vol that Analysis,
 * Scenario and Margin work from (P5, items 10 and 16, P13).
 *
 * Every leg is priced on its OWN month. Each held month, and the near month
 * whether held or not, gets one R1 `monthQuotes` — its own future, else R1's
 * parity forward, else spot carried — and its own tenor; nothing is re-dated
 * to the near expiry or the near future. An option leg's vol comes through
 * `liquidIv`: its own measured row, else the other side at its strike, else
 * the nearest measured row. A leg whose own row is missing, stale or unsolved
 * is illiquid by itself (`illiquidAuto`); a viewer may tick any other one
 * (`withIlliquid`).
 *
 * `rebase` re-solves the same raw quotes against another vol basis (the Gap
 * Up/Down panel's Vol Basis). No future moves with it, quoted or not: a
 * future's own price is its quote, else its month's forward on the future
 * basis (Analysis's `marketOf` and gap market).
 *
 * `SnapshotCache` keeps one snapshot per (trader, stock, leg version) for a
 * minute, shared by every viewer, as R1's PayoffCache keeps the payoff: the
 * quotes are read once a minute however many tabs poll.
 */

import { yearsToExpiry } from '@algomaker/greeks'
import { liquidIv } from '@algomaker/payoff'
import type { ChainQuoteLite, PayoffLeg, SolvedIv } from '@algomaker/payoff'
import type { TradersDeps } from '../deps.ts'
import { lotSizeOf, matchLeg, nearestFuture, notUnderstood, spotTokenOf, type TradersMaster } from '../market/master.ts'
import { FEED_NOT_TICKING, type TradersQuotes } from '../market/quotes.ts'
import { istDate } from '../routes/kit.ts'
import { isOpenLeg, type OptType, type TraderLeg } from '../types.ts'
import { marketOpenAt } from './calendar.ts'
import { monthQuotes, monthWarning, solveMonth, type ForwardSource, type MonthQuotes } from './month-chain.ts'
import type { VolBasis } from './wire.ts'

export type { VolBasis }

export interface SnapshotMarket {
  readonly master: () => TradersMaster
  /** R1's display reads: price, bid, ask, oi, volume, asOf, ageMs (N5). */
  readonly quotes: TradersQuotes
  readonly now: () => number
}

export interface PricedLeg {
  readonly leg: TraderLeg
  /** id = leg.key; a share is instrument 'future', expiry ''; iv = marketIv. */
  readonly payoff: PayoffLeg
  readonly ltp: number | null; readonly bid: number | null; readonly ask: number | null
  /** Options: strike + CE LTP − PE LTP at this strike and month; null otherwise or when a side has no quote. */
  readonly syntheticFuture: number | null
  readonly marketIv: number | null
  readonly ivSource: 'quote' | 'other-side' | 'nearest' | 'none'
  readonly ivFrom: { readonly strike: number; readonly optType: OptType } | null
  /** Own row not measured in the chain the leg is priced on (monthQuotes', or rebase's): missing, older than its window (120 s in session), or unsolved. */
  readonly illiquidAuto: boolean
  /** The leg's own month chain. */
  readonly lotSize: number | null
}

export interface BookSnapshot {
  readonly trader: string; readonly stock: string; readonly asOf: number; readonly closed: boolean
  readonly spot: number | null
  /** Every held month + nearExpiry + nearFuture: the TRADED futures. */
  readonly futures: Readonly<Record<string, number | null>>
  /** What options are solved and priced against: each month's forward for basis 'future'. */
  readonly optionFutures: Readonly<Record<string, number | null>>
  /** Nearest listed OPTION expiry ≥ today (an index's is a weekly); latest held expiry. */
  readonly nearExpiry: string | null; readonly lastExpiry: string | null
  /** Nearest listed FUTURE: To Neutralize's contract, and its own lot (null when the master gives none above 0). */
  readonly nearFuture: { readonly expiry: string; readonly price: number | null; readonly lotSize: number | null } | null
  /** 'future' from priceBook. */
  readonly basis: VolBasis
  /** Raw chain quotes per month, kept for rebase. */
  readonly quotes: Readonly<Record<string, readonly ChainQuoteLite[]>>
  /** Listed option expiries for the stock. */
  readonly expiries: readonly string[]
  /** The near month's chain. */
  readonly lotSize: number | null; readonly strikeStep: number | null
  /** expiry -> master.atmStrike at that month's forward. */
  readonly atm: Readonly<Record<string, number | null>>
  readonly chains: Readonly<Record<string, readonly SolvedIv[]>>
  /** Matched legs only. */
  readonly legs: readonly PricedLeg[]
  readonly unmatched: readonly string[]
  /** The keys of the legs in `unmatched`, in its order: the MTM block leaves their contracts out. */
  readonly unmatchedKeys: readonly string[]
  readonly warnings: readonly string[]
}

/** Under the Analysis view's 5 s refresh while a book's live stream runs, so each refresh is priced afresh. */
export const SNAPSHOT_TTL_MS = 4_000
export const MARKET_CLOSED = "market closed — last session's prices"

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
const orNull = (x: number | null | undefined): number | null => (positive(x) ? x : null)

function priceOf(q: TradersQuotes, token: number | null): number | null {
  return token === null ? null : orNull(q.quote(token)?.price)
}

/** A trader's leg as the payoff package prices it: a share is a future that never expires. */
export function toPayoffLeg(l: TraderLeg, iv: number | null): PayoffLeg {
  return {
    id: l.key, instrument: l.instrument === 'option' ? 'option' : 'future', qty: l.qty,
    strike: l.instrument === 'option' ? l.strike : null, type: l.instrument === 'option' ? l.optType : null,
    expiry: l.instrument === 'share' ? '' : l.expiry, entry: l.avgPrice, iv,
  }
}

/** strike + CE − PE off one month's raw quotes; null unless both sides are quoted. */
function syntheticAt(quotes: readonly ChainQuoteLite[], strike: number): number | null {
  const ce = quotes.find((x) => x.strike === strike && x.type === 'CE')?.price
  const pe = quotes.find((x) => x.strike === strike && x.type === 'PE')?.price
  return positive(ce) && positive(pe) ? orNull(strike + ce - pe) : null
}

/** An option leg with its vol read off `chain`; `illiquid` skips its own row. Futures and shares are returned as they are. */
function withVol(l: PricedLeg, chain: readonly SolvedIv[], illiquid: boolean): PricedLeg {
  const { instrument, strike, optType } = l.leg
  if (instrument !== 'option' || strike === null || optType === null) return l
  const v = liquidIv(chain, strike, optType, illiquid)
  return {
    ...l, payoff: { ...l.payoff, iv: v.iv }, marketIv: v.iv, ivSource: v.source,
    ivFrom: v.from === null ? null : { strike: v.from.strike, optType: v.from.type },
  }
}

export function priceBook(trader: string, stock: string, legs: readonly TraderLeg[], m: SnapshotMarket): BookSnapshot {
  const asOf = m.now()
  const master = m.master()
  const q = m.quotes
  const today = istDate(asOf)
  const closed = !marketOpenAt(asOf)
  const spot = priceOf(q, spotTokenOf(master, stock))
  const listed = master.options.expiries(stock).filter((e) => e >= today)
  const nearExpiry = listed[0] ?? null
  const nf = nearestFuture(master, stock, today)
  const nfExpiry = nf === null ? undefined : listed.find((e) => master.options.future(stock, e)?.tradingsymbol === nf.tradingsymbol)
  const nearFuture = nf === null || nfExpiry === undefined ? null : { expiry: nfExpiry, price: priceOf(q, nf.instrumentToken ?? null), lotSize: orNull(nf.lotSize) }

  const unmatched: string[] = []
  const unmatchedKeys: string[] = []
  const held: { readonly leg: TraderLeg; readonly token: number }[] = []
  for (const leg of legs) {
    if (!isOpenLeg(leg, today)) continue
    const token = leg.token ?? matchLeg(master, leg)
    if (token === null) {
      unmatched.push(notUnderstood(leg))
      unmatchedKeys.push(leg.key)
    } else held.push({ leg, token })
  }
  const heldMonths = [...new Set(held.flatMap(({ leg }) => (leg.instrument === 'share' ? [] : [leg.expiry])))].sort()

  // One solve per held month and the near month, each against its own forward and tenor (N8).
  const months = new Map<string, MonthQuotes>()
  for (const e of nearExpiry === null ? heldMonths : [...heldMonths, nearExpiry]) {
    if (!months.has(e)) months.set(e, monthQuotes(master, q, stock, e, spot, asOf, closed))
  }
  const futures: Record<string, number | null> = {}
  const optionFutures: Record<string, number | null> = {}
  const quotes: Record<string, readonly ChainQuoteLite[]> = {}
  const chains: Record<string, readonly SolvedIv[]> = {}
  const atm: Record<string, number | null> = {}
  for (const e of [...months.keys()].sort()) {
    const mq = months.get(e) as MonthQuotes
    futures[e] = mq.future
    optionFutures[e] = mq.forward
    quotes[e] = mq.quotes
    chains[e] = mq.ivs
    atm[e] = mq.forward === null ? null : master.options.atmStrike(stock, e, mq.forward)
  }
  if (nearFuture !== null && !(nearFuture.expiry in futures)) futures[nearFuture.expiry] = nearFuture.price

  const priced = held.map(({ leg, token }): PricedLeg => {
    const got = q.quote(token)
    const plain: PricedLeg = {
      leg, payoff: toPayoffLeg(leg, null), ltp: orNull(got?.price), bid: orNull(got?.bid), ask: orNull(got?.ask),
      syntheticFuture: null, marketIv: null, ivSource: 'none', ivFrom: null, illiquidAuto: false, lotSize: lotSizeOf(master, leg),
    }
    if (leg.instrument !== 'option' || leg.strike === null) return plain
    const month = months.get(leg.expiry)
    const own = withVol(plain, month?.ivs ?? [], false)
    return { ...own, syntheticFuture: syntheticAt(month?.quotes ?? [], leg.strike), illiquidAuto: own.ivSource !== 'quote' }
  })

  const warnings: string[] = []
  if (closed) warnings.push(MARKET_CLOSED)
  else if (!q.feedAlive()) warnings.push(FEED_NOT_TICKING)
  for (const e of heldMonths) {
    const w = monthWarning(months.get(e) as MonthQuotes)
    if (w !== null) warnings.push(w)
  }

  const near = nearExpiry === null ? null : master.options.chain(stock, nearExpiry)
  return {
    trader, stock, asOf, closed, spot, futures, optionFutures, nearExpiry, lastExpiry: heldMonths.at(-1) ?? null, nearFuture,
    basis: 'future', quotes, expiries: listed,
    lotSize: near?.lotSize ?? null, strikeStep: near?.strikeStep ?? null, atm, chains, legs: priced, unmatched, unmatchedKeys, warnings,
  }
}

/** The snapshot with every option leg in `forced` priced as illiquid; keys that are not this book's option legs change nothing. */
export function withIlliquid(s: BookSnapshot, forced: ReadonlySet<string>): BookSnapshot {
  if (forced.size === 0) return s
  return { ...s, legs: s.legs.map((l) => (forced.has(l.leg.key) ? withVol(l, s.chains[l.leg.expiry] ?? [], true) : l)) }
}

/**
 * Every month's raw quotes re-solved against another basis: its forward
 * ('future'), its synthetic future at the ATM strike ('synthetic', else the
 * forward, warned), or spot ('cash', else the forward, warned). Each option leg
 * has its own row read again on the new chain, so `illiquidAuto` is the new
 * basis's verdict; a viewer's tick carries over. A tick on a leg that was
 * already illiquid by itself cannot be told from that verdict, and follows it.
 *
 * Takes a priceBook snapshot (basis 'future', ticked or not): only that one
 * still carries every month's forward.
 */
export function rebase(s: BookSnapshot, basis: VolBasis): BookSnapshot {
  if (basis === s.basis) return s
  if (s.basis !== 'future') throw new Error(`rebase takes a snapshot on the future basis, not '${s.basis}'`)
  const warnings = [...s.warnings]
  if (basis === 'cash' && s.spot === null) warnings.push(`no spot price for ${s.stock} — the cash basis uses each month's forward`)
  const optionFutures: Record<string, number | null> = {}
  const chains: Record<string, readonly SolvedIv[]> = {}
  for (const [e, quotes] of Object.entries(s.quotes)) {
    const forward = s.optionFutures[e] ?? null
    let f = forward
    if (basis === 'cash') f = s.spot ?? forward
    else {
      const k = s.atm[e] ?? null
      const syn = k === null ? null : syntheticAt(quotes, k)
      if (k !== null && syn === null) warnings.push(`${e}: no two-sided quote at the ${k} strike — the synthetic basis uses its forward`)
      f = syn ?? forward
    }
    optionFutures[e] = f
    chains[e] = f === null ? [] : solveMonth(quotes, f, yearsToExpiry(e, s.asOf), s.closed)
  }
  const legs = s.legs.map((l): PricedLeg => {
    if (l.leg.instrument !== 'option') return l
    const chain = chains[l.leg.expiry] ?? []
    const ticked = l.ivSource !== 'quote' && !l.illiquidAuto
    const own = withVol(l, chain, false)
    return { ...(ticked ? withVol(l, chain, true) : own), illiquidAuto: own.ivSource !== 'quote' }
  })
  return { ...s, basis, optionFutures, chains, legs, warnings }
}

/**
 * R1's solve for any listed (stock, expiry), held or not, with spot from
 * `spotTokenOf`: the seam Market Watch and repair (R3) read, so they show the
 * same vols as Analysis. Null when the expiry lists no option chain.
 */
export function chainIvs(
  d: Pick<TradersDeps, 'master' | 'quotes'>, stock: string, expiry: string, nowMs: number,
): { readonly future: number | null; readonly forward: number | null; readonly source: ForwardSource | null; readonly tYears: number; readonly solved: readonly SolvedIv[] } | null {
  const m = d.master()
  if (m.options.chain(stock, expiry) === null) return null
  const mq = monthQuotes(m, d.quotes, stock, expiry, priceOf(d.quotes, spotTokenOf(m, stock)), nowMs, !marketOpenAt(nowMs))
  return { future: mq.future, forward: mq.forward, source: mq.source, tYears: mq.tYears, solved: mq.ivs }
}

/**
 * One snapshot per (trader, stock, leg version) for `ttlMs`, shared by every
 * viewer. The caller passes `LegStore.version(trader)`, so a new upload misses
 * at once; entries past the TTL are dropped on each read, as R1's PayoffCache.
 */
export class SnapshotCache {
  readonly #m: SnapshotMarket
  readonly #ttlMs: number
  readonly #entries = new Map<string, { readonly at: number; readonly snapshot: BookSnapshot }>()

  constructor(m: SnapshotMarket, ttlMs: number = SNAPSHOT_TTL_MS) {
    this.#m = m
    this.#ttlMs = ttlMs
  }

  get(trader: string, stock: string, legs: readonly TraderLeg[], version: number): BookSnapshot {
    const now = this.#m.now()
    for (const [k, e] of this.#entries) if (now - e.at >= this.#ttlMs) this.#entries.delete(k)
    const key = `${trader}|${stock}|${version}`
    const hit = this.#entries.get(key)
    if (hit !== undefined) return hit.snapshot
    const snapshot = priceBook(trader, stock, legs, this.#m)
    this.#entries.set(key, { at: now, snapshot })
    return snapshot
  }
}
