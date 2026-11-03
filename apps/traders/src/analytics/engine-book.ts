/**
 * A trader's book as the desk engine reads it: one expiry's chain as a
 * `ChainSnap`, and the whole book as engine legs (spec P2, P5).
 *
 * The option legs of that expiry are built from the BookView's own position
 * greeks (Decision 6): each per-share greek is the position greek ÷ qty, delta
 * unsigned as the engine wants it, and the lot is R1's `LegView.lotSize`.
 * Every future and share leg is a `kind: 'future'` leg of its shares, and the
 * options of every other expiry ride as one more, `OFFSET_INSTRUMENT`, of
 * their summed position delta. The engine measures those and never acts on
 * them (desk-engine's `LegView.kind`), so the corridor's netDelta is the
 * BookView's delta to the rounding, and the band and To Neutralize read one
 * number.
 */

import type { ChainSnap, EngineInputs, LegView as EngineLeg, Quote, StrikeQuote } from '@algomaker/desk-engine'
import { nearestFutureWithExpiry, type TradersMaster } from '../market/master.ts'
import type { TraderQuote, TradersQuotes } from '../market/quotes.ts'
import { IST_OFFSET_MS, istDate } from '../routes/kit.ts'
import { contractText, type BookView, type LegView, type OptType } from '../types.ts'
import { forwardFor } from './month-chain.ts'
import { liveExpiryFrom } from './near-expiry.ts'

/** The engine leg that carries the other expiries' options as a fixed delta (P5). */
export const OFFSET_INSTRUMENT = 'offset:other-expiries'
export const MEASURED_NOTE = 'Futures and shares are counted in the band and never adjusted by the advice.'

export interface EngineBook {
  readonly inputs: EngineInputs
  readonly expiry: string
  readonly lotSize: number
  /** The nearest listed future and its own lot: To Neutralize's contract. Null when the underlying lists none. */
  readonly nearFuture: { readonly expiry: string; readonly lotSize: number } | null
  /** The other expiries' options' summed position delta, in shares: the offset leg's (P5); 0 when none is held. */
  readonly offsetShares: number
  /** Those options with no IV, as contract text: what leaves the offset leg unmarked. */
  readonly offsetUnpriced: readonly string[]
  readonly notes: readonly string[]
}

export type EngineBookResult = EngineBook | { readonly blocked: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const DAY_MS = 86_400_000

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
const zero = (x: number): number => (x === 0 ? 0 : x)

/** '2026-11-03' → '3 Nov'. */
export function dayMonthOf(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? day.slice(5, 7)}`
}

/** IST minutes since midnight (09:15 = 555). */
export function istMinuteOf(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / 60_000) % 1440
}

/** A display quote as the engine's two-sided `Quote`: bid and ask both or neither; null with no price and no book. */
function engineQuote(t: TraderQuote | null): Quote | null {
  if (t === null) return null
  const book = positive(t.bid) && positive(t.ask)
  const ltp = positive(t.price) ? t.price : null
  if (!book && ltp === null) return null
  return { bid: book ? t.bid : null, ask: book ? t.ask : null, ltp, asOf: t.asOf }
}

const quoteOf = (q: TradersQuotes, token: number | undefined): Quote | null => (token === undefined ? null : engineQuote(q.quote(token)))

/** The first listed future expiring on or after `todayIst`, with its own lot; an expiry with no future (an index weekly) is skipped. */
export function nearFutureOf(m: TradersMaster, stock: string, todayIst: string): EngineBook['nearFuture'] {
  const f = nearestFutureWithExpiry(m, stock, todayIst)
  return f === null ? null : { expiry: f.expiry, lotSize: f.ref.lotSize }
}

/**
 * The expiry's chain off the quote cache, priced at the BookView's forward for
 * it (its own future, else parity, else spot carried); a month the book holds
 * nothing in (a book of futures or shares alone) by the same rule, R1's
 * `forwardFor`, off the same quotes. An expiry with no future of its own, or
 * one that is unquoted, carries the forward as a print (bid and ask null), as
 * the supervisor's chain view does. Null with no forward for the expiry, or
 * when the master lists no such chain.
 */
export function chainSnapOf(m: TradersMaster, q: TradersQuotes, view: BookView, expiry: string, nowMs: number): ChainSnap | null {
  const forward = Object.hasOwn(view.forwards, expiry) ? view.forwards[expiry] : forwardFor(m, q, view.stock, expiry, view.spot, view.asOf)?.price
  const meta = m.options.chain(view.stock, expiry)
  if (!positive(forward) || meta === null) return null
  const future = quoteOf(q, m.options.future(view.stock, expiry)?.instrumentToken) ?? { bid: null, ask: null, ltp: forward, asOf: nowMs }
  let asOf = future.asOf
  const side = (strike: number, t: OptType): Quote | null => {
    const quote = quoteOf(q, m.options.resolve(view.stock, expiry, strike, t)?.instrumentToken)
    if (quote !== null && quote.asOf > asOf) asOf = quote.asOf
    return quote
  }
  const strikes: StrikeQuote[] = meta.strikes.map((strike) => ({ strike, ce: side(strike, 'CE'), pe: side(strike, 'PE') }))
  return { symbol: view.stock, expiry, step: meta.strikeStep ?? 0, lotSize: meta.lotSize, future, spot: forward, strikes, asOf }
}

function optionLeg(l: LegView, chain: ChainSnap): EngineLeg {
  const lotSize = positive(l.lotSize) ? l.lotSize : chain.lotSize
  const strike = l.strike as number
  const optType = l.optType as OptType
  const row = chain.strikes.find((s) => s.strike === strike)
  const quoted = (optType === 'CE' ? row?.ce : row?.pe) ?? null
  return {
    instrument: l.key, strike, optType, side: l.qty < 0 ? 'Sell' : 'Buy',
    lots: Math.abs(l.qty) / lotSize, lotSize, entry: l.avgPrice, openedByEngine: false, leanId: '',
    iv: l.iv,
    delta: zero(Math.abs(l.delta / l.qty)), gamma: zero(l.gamma / l.qty), theta: zero(l.theta / l.qty), vega: zero(l.vega / l.qty),
    hasGreeks: l.iv !== null,
    mtm: l.mtm ?? 0,
    exit: quoted ?? { bid: null, ask: null, ltp: l.ltp, asOf: chain.asOf },
  }
}

interface Measured {
  readonly instrument: string; readonly shares: number; readonly entry: number; readonly mtm: number
  readonly ltp: number | null; readonly hasGreeks: boolean
}

/**
 * A measured leg of `shares` (signed): the engine's future kind, by its
 * convention strike 0, CE, delta 1 and no other greek, in lots of one share,
 * valued at `ltp` as a print (an empty quote with none).
 */
function measuredLeg(m: Measured, asOf: number): EngineLeg {
  return {
    kind: 'future', instrument: m.instrument, strike: 0, optType: 'CE', side: m.shares < 0 ? 'Sell' : 'Buy',
    lots: Math.abs(m.shares), lotSize: 1, entry: m.entry, openedByEngine: false, leanId: '',
    iv: null, delta: 1, gamma: 0, theta: 0, vega: 0, hasGreeks: m.hasGreeks, mtm: m.mtm, exit: { bid: null, ask: null, ltp: m.ltp, asOf },
  }
}

/**
 * The engine's inputs for `view` on `chain`'s expiry, from a clean state: no
 * protected quantity, nothing realised, no broker margin, nothing working.
 * That expiry's options are the legs the engine may adjust. Each future and
 * share is a measured leg at its own last price. The other expiries' options
 * are one measured leg of their summed delta, entered and valued at the
 * chain's forward so its P&L is 0 (as repair's offset); it is unmarked when
 * any of them has no IV (its delta would be a hole), and left out when they
 * net to nothing. Unmatched legs are left out with a note, and so are options
 * that expired at today's close (no time left: R1's view gives them no greeks).
 */
export function engineBookOf(
  view: BookView, chain: ChainSnap, nearFuture: EngineBook['nearFuture'], nowMs: number, trader: string,
): EngineBook {
  const legs: EngineLeg[] = []
  const notes: string[] = []
  const live = liveExpiryFrom(nowMs)
  let unmatched = 0
  let settled = 0
  let measured = false
  let offsetShares = 0
  const offsetUnpriced: string[] = []
  for (const l of view.legs) {
    if (!l.matched) unmatched++
    else if (l.instrument === 'option' && l.expiry < live) settled++
    else if (l.instrument !== 'option') {
      legs.push(measuredLeg({ instrument: l.key, shares: l.qty, entry: l.avgPrice, mtm: l.mtm ?? 0, ltp: l.ltp, hasGreeks: true }, chain.asOf))
      measured = true
    } else if (l.expiry === chain.expiry) legs.push(optionLeg(l, chain))
    else {
      offsetShares += l.delta
      if (l.iv === null) offsetUnpriced.push(contractText(l))
    }
  }
  if (offsetShares !== 0 || offsetUnpriced.length > 0) {
    const at = chain.spot
    legs.push(measuredLeg({ instrument: OFFSET_INSTRUMENT, shares: offsetShares, entry: at, mtm: 0, ltp: at, hasGreeks: offsetUnpriced.length === 0 }, chain.asOf))
  }
  if (unmatched > 0) notes.push(unmatched === 1 ? '1 row not understood is left out' : `${unmatched} rows not understood are left out`)
  if (settled > 0) notes.push(settled === 1 ? "1 option that expired at today's close is left out" : `${settled} options that expired at today's close are left out`)
  if (measured) notes.push(MEASURED_NOTE)
  const dateIst = istDate(nowMs)
  const inputs: EngineInputs = {
    tag: `traders:${trader}:${view.stock}`, mode: 'paper', nowMs, dateIst, minuteOfDay: istMinuteOf(nowMs),
    dte: Math.max(0, Math.round((Date.parse(`${chain.expiry}T00:00:00Z`) - Date.parse(`${dateIst}T00:00:00Z`)) / DAY_MS)),
    chain, legs,
    protectedQty: {}, cumRealized: 0, margin: { value: 0, source: 'model', asOf: nowMs, fresh: false },
    pendingLots: 0, repairHold: false, pricing: 'live',
  }
  return { inputs, expiry: chain.expiry, lotSize: chain.lotSize, nearFuture, offsetShares: zero(offsetShares), offsetUnpriced, notes }
}
