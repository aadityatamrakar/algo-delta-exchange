/**
 * RangeBreakoutDirectional — pure decision logic for all 3 band sources.
 *
 * Every function here is either a direct TypeScript port of an existing,
 * tested legacy pure module (orb-fut-logic.js, atr-band-logic.js,
 * orb-scalp-logic.js), or of the newly-extracted bn-breakout-logic.js (Step 1
 * above). The golden-master tests (Task 8, Task 9) diff each ported function
 * against its legacy counterpart directly — see
 * `test/golden/range-breakout-remaining.test.ts` for the technique (it used to
 * point at `packages/indicators`, deleted 2026-08-16 with nothing importing it).
 */

// Type-only, so this module stays runtime-dependency-free: `Interval` is the
// authoritative bar-size union and duplicating it here would let the two drift.
import type { Interval } from '@algomaker/strategy-kit'

export interface Candle {
  /** Epoch ms of the bar's OPEN — an IST-aligned bucket start, per CandleStore. */
  readonly ts: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

// ---- opening-range band (ported from orb-fut-logic.js; shared by orb-fut-* and orb-scalp) ----

export function computeOpeningRange(
  candles: readonly Candle[],
  count: number,
): { readonly rangeHigh: number; readonly rangeLow: number; readonly range: number } | null {
  if (candles.length < count) return null
  const window = candles.slice(0, count)
  const rangeHigh = Math.max(...window.map((c) => c.high))
  const rangeLow = Math.min(...window.map((c) => c.low))
  return { rangeHigh, rangeLow, range: rangeHigh - rangeLow }
}

export function passesRangeFilter(range: number, filterPts: number): boolean {
  if (!filterPts) return true
  return range >= filterPts
}

export function breakoutSideFromRange(
  close: number,
  rangeHigh: number,
  rangeLow: number,
  bufferPct: number,
): 'BUY' | 'SELL' | null {
  if (close > rangeHigh * (1 + bufferPct)) return 'BUY'
  if (close < rangeLow * (1 - bufferPct)) return 'SELL'
  return null
}

export interface FuturePosition {
  readonly side: 'BUY' | 'SELL'
  readonly entry: number
  readonly sl: number
  readonly t1: number
  readonly lots: number
  readonly status: 'ACTIVE' | 'CLOSED'
}

export function computeFutureLevels(
  side: 'BUY' | 'SELL',
  entry: number,
  range: number,
  rangeHigh: number,
  rangeLow: number,
): { readonly sl: number; readonly t1: number } {
  if (side === 'BUY') return { sl: rangeLow, t1: entry + range }
  return { sl: rangeHigh, t1: entry - range }
}

export function openFuturePosition(
  side: 'BUY' | 'SELL',
  entry: number,
  range: number,
  rangeHigh: number,
  rangeLow: number,
  lots: number,
): FuturePosition {
  const { sl, t1 } = computeFutureLevels(side, entry, range, rangeHigh, rangeLow)
  return { side, entry, sl, t1, lots, status: 'ACTIVE' }
}

export interface FutureExitAction {
  readonly side: 'BUY' | 'SELL'
  readonly lots: number
  readonly reason: 'EOD' | 'SL' | 'T1'
}

export function evaluateFutureExit(
  position: FuturePosition,
  price: number,
  opts: { readonly forceExit?: boolean } = {},
): { readonly actions: readonly FutureExitAction[]; readonly position: FuturePosition } {
  if (position.status !== 'ACTIVE') return { actions: [], position }
  const opp = position.side === 'BUY' ? 'SELL' : 'BUY'
  const long = position.side === 'BUY'

  if (opts.forceExit) {
    return { actions: [{ side: opp, lots: position.lots, reason: 'EOD' }], position: { ...position, status: 'CLOSED' } }
  }
  const slHit = long ? price <= position.sl : price >= position.sl
  if (slHit) {
    return { actions: [{ side: opp, lots: position.lots, reason: 'SL' }], position: { ...position, status: 'CLOSED' } }
  }
  const t1Hit = long ? price >= position.t1 : price <= position.t1
  if (t1Hit) {
    return { actions: [{ side: opp, lots: position.lots, reason: 'T1' }], position: { ...position, status: 'CLOSED' } }
  }
  return { actions: [], position }
}

// ---- ATR-anchor band (ported from atr-band-logic.js) ----

export function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
}

export function wilderAtr(candles: readonly Candle[], period: number): number | null {
  if (candles.length < period) return null
  const tr: number[] = []
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] as Candle
    if (i === 0) tr.push(c.high - c.low)
    else tr.push(trueRange(c.high, c.low, (candles[i - 1] as Candle).close))
  }
  let atr = 0
  for (let i = 0; i < period; i++) atr += tr[i] as number
  atr = atr / period
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + (tr[i] as number)) / period
  return atr
}

export function atrBandWidth(atr: number, divisor: number): number {
  return atr / divisor
}

// ---- phase anchoring (ported from atr-band-nifty.js's two timestamp filters) ----

const IST_OFFSET_MS = 330 * 60_000
const DAY_MS = 24 * 60 * 60_000

/**
 * Bar sizes in MINUTES.
 *
 * Duplicated from `@algomaker/marketdata-core`'s `intervalMs` rather than
 * imported, for the same reason that package duplicates the `Candle` shape:
 * marketdata-core sits UNDER strategy-kit, and packages/strategies must not
 * grow a dependency edge onto it just to divide by 60_000.
 */
const INTERVAL_MINUTES: Readonly<Record<Interval, number>> = {
  '1minute': 1, '3minute': 3, '5minute': 5, '15minute': 15, '60minute': 60, day: 24 * 60,
}

export function intervalMinutes(interval: Interval): number {
  return INTERVAL_MINUTES[interval]
}

/** Minutes past IST midnight for an epoch-ms instant. IST is UTC+05:30, no DST. */
export function istMinuteOfDay(tsMs: number): number {
  return Math.floor((((tsMs + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000)
}

/** Which IST calendar day an instant falls on, as days since the epoch. */
export function istDayIndex(tsMs: number): number {
  return Math.floor((tsMs + IST_OFFSET_MS) / DAY_MS)
}

/**
 * NSE session open, 09:15 IST, in minutes past IST midnight.
 *
 * Duplicated from `@algomaker/marketdata-core`'s `SESSION_OPEN_IST_MIN` for exactly
 * the reason `INTERVAL_MINUTES` above is duplicated: that package sits UNDER this
 * one and packages/strategies must not grow a dependency edge onto it.
 */
const SESSION_OPEN_IST_MINUTE = 9 * 60 + 15

/**
 * A bar bucketed BEFORE the session open — i.e. built from PRE-OPEN ticks.
 *
 * These exist because `bucketStart` (marketdata-core) deliberately buckets a
 * pre-open tick "into the session-relative slot it falls in, so the arithmetic
 * stays continuous rather than special-casing". With bars anchored on 09:15 that
 * puts NSE's 09:00-09:15 pre-open session into 09:00/09:05/09:10 buckets, stamped
 * with today's IST date and therefore indistinguishable from session bars by date
 * alone.
 *
 * They must never reach a band: during pre-open the index republishes the PREVIOUS
 * SESSION'S CLOSE until price discovery starts, so the earliest such bar is a flat
 * bar carrying a number from a different day. On 2026-08-10 that is exactly what
 * BN_BREAKOUT banded on — Friday's 15:25 close of 57746.45 instead of today's
 * 09:15-09:20 close of 57884.20 — and the resulting band was 138 points low.
 *
 * Neither of the two filters below could see this coming, because both exist to
 * emulate a legacy `historyData(token, interval, today, today)` call and KITE'S
 * INTRADAY HISTORY STARTS AT 09:15. A pre-open bar is not something the thing being
 * ported could ever return; it is an artefact of replacing that fetch with a
 * tick-fed CandleStore.
 *
 * `day` bars are exempt: `bucketStart` floors those to IST MIDNIGHT, so a daily bar
 * always reads as minute 0 and a blanket test would discard every one of them.
 */
function isPreOpenBar(c: Candle, interval: Interval): boolean {
  if (interval === 'day') return false
  return istMinuteOfDay(c.ts) < SESSION_OPEN_IST_MINUTE
}

/**
 * The bars that had already CLOSED by `cutoffIstMinute` on the cutoff's own IST
 * day. Bars from earlier days are kept whole; bars from a later day are dropped.
 *
 * This is the port of BOTH timestamp filters in `atr-band-nifty.js`, which are
 * there for one reason each file states explicitly:
 *
 *   - `computeWidth` (line 116): keep today's 60-minute bar only while
 *     `ts <= '09:15'`, i.e. the 09:15-10:15 bar — the last one CLOSED at the
 *     10:15 phase. Kite anchors hourly bars at the session open, not the top of
 *     the hour, so 09:15 + 60 == 10:15 exactly; `bucketStart()` in
 *     marketdata-core already produces that alignment and it is not re-derived
 *     here.
 *   - `computeLines` (line 148): keep today's 5-minute bars only while
 *     `ts <= '11:35'`, i.e. the 11:35-11:40 bar.
 *
 * WITHOUT this, a mid-session restart at (say) 13:00 replays both phases against
 * whatever the store holds NOW and anchors the day's band on the 12:55 bar — a
 * band that still looks like a band, on a level the strategy never traded. The
 * live path is protected by the CandleStore serving only completed bars; the
 * catch-up path is not, and catch-up is exactly when this fires.
 */
export function candlesClosedBy(
  candles: readonly Candle[],
  interval: Interval,
  cutoffIstMinute: number,
  cutoffMs: number,
): Candle[] {
  const size = intervalMinutes(interval)
  const cutoffDay = istDayIndex(cutoffMs)
  return candles.filter((c) => {
    // Pre-open bars are dropped on EVERY day, not just the cutoff's own. This
    // filter keeps earlier days whole on purpose (ATR-14 needs them), and a flat
    // previous-close bar poisons a 14-period average exactly as much when it comes
    // from last Tuesday as it does when it comes from this morning.
    if (isPreOpenBar(c, interval)) return false
    const day = istDayIndex(c.ts)
    if (day < cutoffDay) return true
    if (day > cutoffDay) return false
    return istMinuteOfDay(c.ts) + size <= cutoffIstMinute
  })
}

/**
 * The bars belonging to the same TRADING SESSION as `atMs` — today's IST date, and
 * at or after the 09:15 open.
 *
 * This is the port of the `historyData(token, interval, today, today)` that every
 * legacy launcher issues — `from == to == today`, so the array it windows can only
 * ever contain today's bars. The CandleStore has no such property: the runner
 * seeds each series 200 bars deep (`market-data.ts` `seed(series, count = 200)`),
 * which for a 5-minute series is roughly 2.7 SESSIONS. Windowing "the first 6 bars
 * in the store" therefore takes six bars from two sessions ago, and the opening
 * range is a stale day's range — bandReady, plausible-looking, and wrong on every
 * level it publishes.
 *
 * SESSION, not calendar day. Scoping this to the IST date alone was the 2026-08-10
 * BN_BREAKOUT defect: pre-open bars carry today's date too, so `[0]` — "the first
 * candle of the day" — was a 09:05 bar holding the PREVIOUS session's close. See
 * `isPreOpenBar` for why those bars exist and why Kite could never return one.
 *
 * Deliberately NOT `candlesClosedBy`, which keeps earlier days whole on purpose
 * (the ATR-14 width needs them). These two filters are opposites and both are
 * load-bearing: width looks BACK across days, the range looks only at today. They
 * agree on exactly one thing, which is that a pre-open bar is not a bar.
 */
export function sessionCandlesOn(candles: readonly Candle[], interval: Interval, atMs: number): Candle[] {
  const day = istDayIndex(atMs)
  return candles.filter((c) => istDayIndex(c.ts) === day && !isPreOpenBar(c, interval))
}

export function atrLines(anchorClose: number, width: number): { readonly highLine: number; readonly lowLine: number } {
  return { highLine: anchorClose + width, lowLine: anchorClose - width }
}

export function candleColor(c: Candle): 'green' | 'red' | 'doji' {
  if (c.close > c.open) return 'green'
  if (c.close < c.open) return 'red'
  return 'doji'
}

export function atrEntrySignal(
  last2: readonly Candle[] | null,
  highLine: number,
  lowLine: number,
): 'CE' | 'PE' | null {
  if (last2 === null || last2.length < 2) return null
  const a = last2[last2.length - 2] as Candle
  const b = last2[last2.length - 1] as Candle
  const bothGreen = candleColor(a) === 'green' && candleColor(b) === 'green'
  const bothRed = candleColor(a) === 'red' && candleColor(b) === 'red'
  if (bothGreen && a.close > highLine && b.close > highLine) return 'CE'
  if (bothRed && a.close < lowLine && b.close < lowLine) return 'PE'
  return null
}

export function atrTarget(entryPremium: number, targetPts: number, targetPct: number): number {
  return Math.min(entryPremium + targetPts, entryPremium * (1 + targetPct))
}

export function atrStopHitOnClose(side: 'CE' | 'PE', candleClose: number, highLine: number, lowLine: number): boolean {
  if (side === 'CE') return candleClose < lowLine
  if (side === 'PE') return candleClose > highLine
  return false
}

// ---- first-candle-pct band (ported from bn-breakout-logic.js, Step 1) ----

export function firstCandleBand(firstCandleClose: number, pct: number): { readonly highLine: number; readonly lowLine: number } {
  const offset = firstCandleClose * pct
  return { highLine: firstCandleClose + offset, lowLine: firstCandleClose - offset }
}

export function firstCandleBreakoutSide(c: Candle, highLine: number, lowLine: number): 'CE' | 'PE' | null {
  const color = candleColor(c)
  if (color === 'green' && c.close > highLine) return 'CE'
  if (color === 'red' && c.close < lowLine) return 'PE'
  return null
}

// ---- shared option-side execution (ported from orb-scalp-logic.js; used by
//      bn-breakout and orb-scalp, both executionMapping: 'atm-option-of-side') ----

export function atmStrike(spotLtp: number, step: number): number {
  return Math.round(spotLtp / step) * step
}

export function sideFromSignal(signal: 'BUY' | 'SELL'): 'CE' | 'PE' {
  return signal === 'BUY' ? 'CE' : 'PE'
}

export function spotSl(side: 'CE' | 'PE', rangeHigh: number, rangeLow: number): number {
  return side === 'CE' ? rangeLow : rangeHigh
}

export interface OptionPosition {
  readonly side: 'CE' | 'PE'
  readonly target: number
  readonly slSpot: number
  readonly status: 'ACTIVE' | 'CLOSED'
}

export function evaluateOptionExit(
  position: OptionPosition,
  optLtp: number | undefined,
  spotLtp: number | undefined,
  opts: { readonly forceExit?: boolean } = {},
): { readonly exit: boolean; readonly reason?: 'EOD' | 'TARGET' | 'SL' } {
  if (position.status !== 'ACTIVE') return { exit: false }
  if (opts.forceExit) return { exit: true, reason: 'EOD' }
  if (typeof optLtp === 'number' && !Number.isNaN(optLtp) && optLtp >= position.target) {
    return { exit: true, reason: 'TARGET' }
  }
  if (typeof spotLtp === 'number' && !Number.isNaN(spotLtp)) {
    const slHit = position.side === 'CE' ? spotLtp < position.slSpot : spotLtp > position.slSpot
    if (slHit) return { exit: true, reason: 'SL' }
  }
  return { exit: false }
}

/**
 * dayBudget.kind === 'per-side' continuation policy (ported from
 * bn-breakout-logic.js's dayContinuesAfterExit, Task 2 Step 1): a
 * profitable-or-breakeven trade ends the day; a loss leaves the opposite side
 * tradeable, UNLESS that side has already been used too.
 */
export function dayContinuesAfterExit(pnl: number, otherSideAlreadyTraded: boolean): boolean {
  if (pnl >= 0) return false
  return !otherSideAlreadyTraded
}
