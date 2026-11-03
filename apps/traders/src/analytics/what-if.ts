/**
 * A repair plan's moves, and relief-r's actions, as the legs "Show on payoff"
 * puts on a book's Scenario tab (R2's `openWhatIf`). Built on the server from
 * the chain the plan or the pass read, so each row is the fill it assumed.
 * Nothing is placed: the legs only ever become hypothetical rows.
 */

import { isFutureLeg, sellLotSize, type EngineAction, type LegView as EngineLeg, type Quote } from '@algomaker/desk-engine'
import type { OptionType } from '@algomaker/greeks'
import type { Move, PayoffLeg } from '@algomaker/payoff'
import type { EngineBook } from './engine-book.ts'
import type { WhatIfLeg } from './r3-wire.ts'

export type { WhatIfLeg } from './r3-wire.ts'

/**
 * add/hedge → that contract at the chain price, in `expiry`; close → the leg's
 * opposite qty at the chain price; shift → that close plus the same qty opened
 * at `toStrike`. A move the chain cannot price is dropped, a shift whole (never
 * half of one). A future — a `future` move, or a futures leg closed — is at
 * `futureMark` when one is given; else its rate is `null` and the Scenario tab
 * prices it at its traded future, else the month's forward.
 *
 * `priceOf` is asked with the signed size of each trade (`qty > 0` a buy), so a
 * plan priced at the side it crosses shows that price; a chain mark ignores it.
 */
export function whatIfOfMoves(
  moves: readonly Move[], legs: readonly PayoffLeg[], priceOf: (strike: number, type: OptionType, qty: number) => number | null, expiry: string,
  futureMark?: number | null,
): WhatIfLeg[] {
  const ask = (strike: number, type: OptionType, qty: number): number | null => {
    try {
      const p = priceOf(strike, type, qty)
      return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null
    } catch {
      return null
    }
  }
  const option = (exp: string, strike: number, optType: OptionType, qty: number, price: number): WhatIfLeg =>
    ({ instrument: 'option', expiry: exp, strike, optType, qty, price })
  const futurePrice = typeof futureMark === 'number' && Number.isFinite(futureMark) && futureMark > 0 ? futureMark : null
  const future = (exp: string, qty: number): WhatIfLeg => ({ instrument: 'future', expiry: exp, strike: null, optType: null, qty, price: futurePrice })

  const out: WhatIfLeg[] = []
  for (const m of moves) {
    if (m.op === 'add' || m.op === 'hedge') {
      const price = ask(m.strike, m.type, m.qty)
      if (price !== null) out.push(option(expiry, m.strike, m.type, m.qty, price))
      continue
    }
    if (m.op === 'future') {
      out.push(future(expiry, m.qty))
      continue
    }
    const leg = legs.find((l) => l.id === m.legId)
    if (leg === undefined) continue
    if (leg.instrument === 'future') {
      if (m.op === 'close') out.push(future(leg.expiry, -leg.qty))
      continue
    }
    if (leg.strike === null || leg.type === null) continue
    const exit = ask(leg.strike, leg.type, -leg.qty)
    if (exit === null) continue
    if (m.op === 'close') {
      out.push(option(leg.expiry, leg.strike, leg.type, -leg.qty, exit))
      continue
    }
    const entry = ask(m.toStrike, leg.type, leg.qty)
    if (entry === null) continue
    out.push(option(leg.expiry, leg.strike, leg.type, -leg.qty, exit), option(leg.expiry, m.toStrike, leg.type, leg.qty, entry))
  }
  return out
}

/** A quote's mid when it has both sides, else its last price; null with neither. */
function midOf(q: Quote | null | undefined): number | null {
  if (q === null || q === undefined) return null
  if (q.bid !== null && q.ask !== null && q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2
  return q.ltp !== null && q.ltp > 0 ? q.ltp : null
}

/**
 * A close or a resize as the option leg it names and the lots it moves (fewer
 * held is negative): a close, the whole leg; a resize, the lots between held
 * and target. Null for a leg the book does not hold among its options (the
 * engine never acts on a future, a share or the offset) or a resize to what is
 * held: such an action gives no line and no row.
 */
export function legChangeOf(a: Exclude<EngineAction, { op: 'open' }>, legs: readonly EngineLeg[]): { leg: EngineLeg; lots: number } | null {
  const leg = legs.find((l) => !isFutureLeg(l) && l.instrument === a.instrument)
  if (leg === undefined) return null
  const lots = a.op === 'close' ? -leg.lots : a.targetLots - leg.lots
  return lots === 0 ? null : { leg, lots }
}

/**
 * relief-r's actions on a trader book, each in the book's expiry at its chain
 * mid (else its last price; null leaves the Scenario tab to price it): an open
 * sized in the lot the engine sells in; a close or a resize, `legChangeOf`'s
 * lots of the leg.
 */
export function whatIfOfActions(actions: readonly EngineAction[], book: EngineBook): WhatIfLeg[] {
  const { chain, legs } = book.inputs
  const option = (strike: number, optType: OptionType, qty: number, price: number | null): WhatIfLeg =>
    ({ instrument: 'option', expiry: book.expiry, strike, optType, qty: Math.round(qty), price })
  const out: WhatIfLeg[] = []
  for (const a of actions) {
    if (a.op === 'open') {
      const row = chain.strikes.find((s) => s.strike === a.strike)
      const qty = (a.side === 'Sell' ? -1 : 1) * a.lots * sellLotSize(legs, chain)
      out.push(option(a.strike, a.optType, qty, midOf(a.optType === 'CE' ? row?.ce : row?.pe)))
      continue
    }
    const change = legChangeOf(a, legs)
    if (change === null) continue
    const { leg, lots } = change
    out.push(option(leg.strike, leg.optType, (leg.side === 'Sell' ? -1 : 1) * lots * leg.lotSize, midOf(leg.exit)))
  }
  return out
}
