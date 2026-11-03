/**
 * relief-r's advice on a trader book (spec item 32): one `decide()` pass under
 * the `trader` preset from `EMPTY_RULE_STATE`, as a card. From where the book
 * stands now (P4): nothing is kept between passes, so every mark-counted tier
 * starts at zero each time (the target lock, which could only ever say
 * "confirming 1/3" from a clean state, is off in the preset: Decision 1). It
 * advises on the options of the one expiry the engine reads (P5); futures,
 * shares and the other expiries' options are measured in its band and never
 * adjusted (P2), and the card says so.
 *
 * It only suggests. The card's lines come with the same moves as Scenario rows
 * ("Show on payoff"); nothing here places, and no route takes a card back.
 */

import {
  DECISIONS_END_MIN, EMPTY_RULE_STATE, MARK_STEP_MIN, RULES_START_MIN, SESSION_OPEN_MIN,
  corridor, decide, isFutureLeg, isTradingDay, markOf, type EngineAction, type EngineInputs, type MarkContext, type OptType,
} from '@algomaker/desk-engine'
import { BAND_UNKNOWN, TRADER_DIALS } from './band.ts'
import { CLOSE_MINUTES } from './calendar.ts'
import { dayMonthOf, type EngineBook, type EngineBookResult } from './engine-book.ts'
import type { AdviceCard, BandStatus } from './r3-wire.ts'
import { legChangeOf, whatIfOfActions } from './what-if.ts'

export type { AdviceCard } from './r3-wire.ts'

export const P4_NOTE = 'From where the book stands now: the engine starts clean each time and does not remember earlier suggestions.'
export const SHIFT_NOTE = "relief-r's margin-gated shift needs a broker margin figure, which a trader book does not have, so this card never suggests a shift."
const FEED_DEAD = 'No advice: the market data feed is dead'
const DAY_MS = 86_400_000

/** The card's first note: where the positions come from, and what they miss (Decision 14). */
export function historyNote(historyFrom: string | null): string {
  return historyFrom === null
    ? 'The start of the trade history is not known. Positions opened before it, and shares delivered at expiry, count only if added as manual legs.'
    : `Built from trades since ${historyFrom}. Positions opened before then, and shares delivered at expiry, count only if added as manual legs.`
}

const lots = (n: number): string => {
  const k = Math.round(n * 100) / 100
  return `${k} ${k === 1 ? 'lot' : 'lots'}`
}

/** '+1,250', '-900': whole shares, Indian grouping. */
const signedShares = (n: number): string => {
  const k = Math.round(n)
  return `${k > 0 ? '+' : k < 0 ? '-' : ''}${Math.abs(k).toLocaleString('en-IN')}`
}

/**
 * 'TCS OCT 3500 CE'. An expiry with another a week later in its month (an
 * index weekly) is named by its day, 'NIFTY 20OCT 25050 CE', so it is never
 * read as the month's last.
 */
function contractOf(stock: string, expiry: string, strike: number, optType: OptType): string {
  const [day, month] = dayMonthOf(expiry).split(' ') as [string, string]
  const weekOn = new Date(Date.parse(`${expiry}T00:00:00Z`) + 7 * DAY_MS)
  const last = weekOn.getUTCMonth() !== Number(expiry.slice(5, 7)) - 1
  return `${stock} ${last ? month.toUpperCase() : `${day}${month.toUpperCase()}`} ${strike} ${optType}`
}

/**
 * relief-r's actions as sentences. An open is `Sell` or `Buy`; a close of a
 * short is `Buy back`, of a long `Sell out`; a resize says the same words for
 * the lots between held and target. Skips what `whatIfOfActions` skips
 * (`legChangeOf`).
 */
export function actionLines(actions: readonly EngineAction[], book: EngineBook, stock: string): string[] {
  const out: string[] = []
  for (const a of actions) {
    if (a.op === 'open') {
      out.push(`${a.side} ${lots(a.lots)} ${contractOf(stock, book.expiry, a.strike, a.optType)}`)
      continue
    }
    const change = legChangeOf(a, book.inputs.legs)
    if (change === null) continue
    const { leg, lots: by } = change
    const word = leg.side === 'Sell' ? (by < 0 ? 'Buy back' : 'Sell') : (by < 0 ? 'Sell out' : 'Buy')
    out.push(`${word} ${lots(Math.abs(by))} ${contractOf(stock, book.expiry, leg.strike, leg.optType)}`)
  }
  return out
}

/**
 * No advice: not a trading day, or 15:30 and after. The rules are the desk engine's and stop at its 15:30
 * `DECISIONS_END_MIN`, though F&O trades to 15:40 since 3 Aug 2026 (the band and the greeks read to then). The
 * engine's own gate opens only past 15:30, so it still acts at the 15:30 mark itself, and settles an expiry then.
 */
const sessionClosed = (inputs: EngineInputs): boolean => !isTradingDay(inputs.dateIst) || inputs.minuteOfDay >= DECISIONS_END_MIN
/** 15:30 to before the 15:40 close on a trading day: the rules have stopped, the market has not. */
const rulesStoppedInSession = (inputs: EngineInputs): boolean => isTradingDay(inputs.dateIst) && inputs.minuteOfDay < CLOSE_MINUTES

/** Ours on a trading day; otherwise the engine's own words for a closed session (with no leg its expiry settle has nothing to close, so its gate answers). */
function closedReason(inputs: EngineInputs, markCtx: MarkContext): string {
  if (rulesStoppedInSession(inputs)) return "the desk's rules stop at 15:30 — F&O trades until 15:40"
  if (isTradingDay(inputs.dateIst)) return 'the market closed at 15:40'
  return decide({ ...inputs, legs: [] }, TRADER_DIALS, EMPTY_RULE_STATE, markCtx).reason
}

function holdHeadline(inputs: EngineInputs): string {
  if (inputs.minuteOfDay < RULES_START_MIN) return 'Advice starts at 09:20'
  if (!inputs.legs.some((l) => !isFutureLeg(l))) return 'Nothing to adjust in options'
  return 'Hold'
}

/** With an override: relief-r still acts on its own band, so the card names it (unless it cannot be measured now). */
function overrideNote(book: EngineBookResult, band: BandStatus): string {
  const head = `Your band is overridden to ${lots(band.bandLots ?? 0)}; relief-r acts on its own band`
  if ('blocked' in book || band.state === 'unknown' || !(book.lotSize > 0)) return `${head}.`
  const own = Math.round((corridor(book.inputs, TRADER_DIALS).allowed / book.lotSize) * 10) / 10
  return `${head} of ${lots(own)}.`
}

/** The card's notes: the history line, P4, the shift, the expiry advised on and what rides beside it (P5), the override, the book's own. */
function notesOf(book: EngineBookResult, band: BandStatus, historyFrom: string | null): string[] {
  const notes = [historyNote(historyFrom), P4_NOTE, SHIFT_NOTE]
  const blocked = 'blocked' in book
  if (!blocked) {
    const expiry = `Advises on the ${dayMonthOf(book.expiry)} expiry only`
    notes.push(book.offsetShares === 0
      ? `${expiry}.`
      : `${expiry}; other expiries' options are carried as a fixed delta of ${signedShares(book.offsetShares)} shares (spec P5).`)
  }
  if (band.source === 'override') notes.push(overrideNote(book, band))
  if (!blocked) notes.push(...book.notes)
  return notes
}

/** A card with no advice on it, `headline` saying why: as of the chain the book was read off, or now for a blocked book. */
export function noAdvice(book: EngineBookResult, band: BandStatus, stock: string, historyFrom: string | null, nowMs: number, headline: string): AdviceCard {
  return {
    stock, asOf: 'blocked' in book ? nowMs : book.inputs.chain.asOf, computedAt: nowMs, status: 'unavailable', headline,
    lines: [], reason: '', trigger: 'none', whatIf: [], notes: notesOf(book, band, historyFrom), band, historyFrom,
  }
}

/**
 * The card for one book. `band` is `bandOf` on the same book; `feedAlive` the
 * quote feed's, which counts only while the market is open (`band.marketOpen`):
 * outside the session a quiet feed is not a dead one. A band that cannot be
 * read is no ground to advise on: the card says why, in the band's words.
 */
export function adviceOf(book: EngineBookResult, band: BandStatus, stock: string, historyFrom: string | null, nowMs: number, feedAlive: boolean): AdviceCard {
  if ('blocked' in book) return noAdvice(book, band, stock, historyFrom, nowMs, book.blocked)
  if (!feedAlive && band.marketOpen) return noAdvice(book, band, stock, historyFrom, nowMs, FEED_DEAD)
  if (band.state === 'unknown') {
    const why = band.sentence.startsWith(BAND_UNKNOWN) ? band.sentence.slice(BAND_UNKNOWN.length) : band.sentence
    return noAdvice(book, band, stock, historyFrom, nowMs, `No advice: ${why}`)
  }

  const { inputs } = book
  const markCtx: MarkContext = { isNewMark: true, markIndexToday: (markOf(inputs.minuteOfDay) - SESSION_OPEN_MIN) / MARK_STEP_MIN }
  const base = { stock, asOf: inputs.chain.asOf, computedAt: nowMs, lines: [], whatIf: [], notes: notesOf(book, band, historyFrom), band, historyFrom }
  // Asked before the engine: its expiry settle runs ahead of its session gate, and at 15:30 that gate is still open.
  // The rules are done by then: nothing to advise.
  if (sessionClosed(inputs)) {
    const headline = rulesStoppedInSession(inputs) ? 'Advice ends at 15:30' : 'Market closed'
    return { ...base, status: 'hold', headline, reason: closedReason(inputs, markCtx), trigger: 'none' }
  }
  const d = decide(inputs, TRADER_DIALS, EMPTY_RULE_STATE, markCtx)
  if (d.action === 'hold') return { ...base, status: 'hold', headline: holdHeadline(inputs), reason: d.reason, trigger: d.trigger }
  const lines = actionLines(d.actions, book, stock)
  return {
    ...base, status: 'advice', headline: lines[0] ?? d.reason, lines, reason: d.reason, trigger: d.trigger,
    whatIf: whatIfOfActions(d.actions, book),
  }
}
