/**
 * THE CHAIN — a two-sided weekly option board, priced the way the engine
 * measures one.
 *
 * TEST-ONLY, like everything under `test/scenario/`.
 *
 * WHY IT IS BUILT ON THE ENGINE'S OWN CLOCK. Every number here goes through
 * `marking.ts` on the way back out: `markLeg` and `strikeGreeks` solve each
 * mid for an IV with Black-76 at `chain.spot`, `RISK_FREE` and `yearFrac`. So
 * the board is priced with exactly those three — the forward is the index
 * carried at `RISK_FREE` over `yearFrac`, the tenor is `yearFrac` — and the
 * engine's IV solve then recovers this model's own vol, up to the tick. A
 * board priced on any other clock would read to the engine as a skew nobody
 * put there, and every delta band would land a strike off.
 *
 * THE BOARD:
 *
 *   forward   F = index × e^(r·T)
 *   strikes   ATM ± 25 steps, ATM the strike nearest F
 *   vol       IV(K) = atmIv × (1 + 0.8·max(0, ln(F/K)) + 0.2·max(0, ln(K/F))) —
 *             a put skew with a little smile on the calls
 *   price     Black-76, the mid rounded to the 0.05 tick and floored at 0.05
 *   spread    half = max(0.05, 0.4% of mid), twice that beyond 10 steps from
 *             ATM, rounded UP to whole ticks — never tighter than stated
 *   ltp       the mid
 *   asOf      `quoteAsOf ?? nowMs`, on the board and on every quote
 *
 * The quote is CENTRED on its mid, always. At the 0.05 floor a full half
 * spread would push the bid below zero, so the half narrows to the mid there
 * (bid 0, ask 0.10) instead of the bid being clamped off-centre: a centred
 * quote is what keeps put-call parity inside a tick at the far wings.
 */

import { b76Price } from '@algomaker/greeks'
import { atmStraddleMid, impliedWindowMove } from '../../src/delta-lean/regime.ts'
import { RISK_FREE, yearFrac } from '../../src/marking.ts'
import type { ChainSnap, OptType, Quote, StrikeQuote } from '../../src/types.ts'

export type IndexSymbol = 'NIFTY' | 'SENSEX'

/** Contract multipliers: the lot sizes the desk's NIFTY and SENSEX books trade. */
export const LOT: Record<IndexSymbol, number> = Object.freeze({ NIFTY: 65, SENSEX: 20 })

/** Listed strike spacing of each weekly. */
export const STEP: Record<IndexSymbol, number> = Object.freeze({ NIFTY: 50, SENSEX: 100 })

/** Strikes listed on each side of ATM. */
export const STRIKES_EACH_SIDE = 25

/** Beyond this many steps from ATM the half-spread doubles: the far wings
 * are where a real board thins out first. */
export const WIDE_BEYOND_STEPS = 10

/** 0.05 ticks: prices are carried as whole ticks and divided once on the way
 * out, so a quote is the nearest double to its tick rather than a sum of
 * rounding errors. */
const TICKS_PER_RUPEE = 20

export interface ChainArgs {
  readonly symbol: IndexSymbol
  readonly expiry: string
  readonly dateIst: string
  readonly minuteOfDay: number
  readonly index: number
  readonly atmIv: number
  readonly nowMs: number
  /** When the quotes last updated; absent = now. A freeze passes its first instant. */
  readonly quoteAsOf?: number
}

interface Board {
  readonly forward: number
  readonly t: number
  readonly atm: number
  readonly step: number
  readonly atmIv: number
  readonly asOf: number
}

function boardOf(args: ChainArgs): Board {
  if (!(args.index > 0) || !Number.isFinite(args.index)) throw new RangeError(`index ${args.index} is not a level`)
  if (!(args.atmIv > 0) || !Number.isFinite(args.atmIv)) throw new RangeError(`atmIv ${args.atmIv} is not a vol`)
  const t = yearFrac(args.dateIst, args.expiry, args.minuteOfDay)
  const forward = args.index * Math.exp(RISK_FREE * t)
  const step = STEP[args.symbol]
  return {
    forward, t, atm: Math.round(forward / step) * step, step,
    atmIv: args.atmIv, asOf: args.quoteAsOf ?? args.nowMs,
  }
}

/** The skewed vol at a strike: puts richer below the forward, calls a little
 * richer above it, ATM exactly `atmIv`. */
export function skewIv(atmIv: number, forward: number, strike: number): number {
  const k = Math.log(forward / strike)
  return atmIv * (1 + 0.8 * Math.max(0, k) + 0.2 * Math.max(0, -k))
}

function quoteOn(b: Board, strike: number, optType: OptType): Quote {
  const vol = skewIv(b.atmIv, b.forward, strike)
  const theo = b76Price({ future: b.forward, strike, t: b.t, vol, rate: RISK_FREE, type: optType })
  const mid = Math.max(1, Math.round(theo * TICKS_PER_RUPEE))
  const wide = Math.abs(strike - b.atm) > WIDE_BEYOND_STEPS * b.step + 1e-6
  // max(0.05, 0.004 × mid) in ticks is max(1, 0.004 × mid-in-ticks), since a
  // tick is 0.05 and 20 of them make a rupee. The epsilon keeps an exact
  // product from ceiling up a tick on float noise.
  const half = Math.min(mid, Math.max(1, Math.ceil(0.004 * mid - 1e-9)) * (wide ? 2 : 1))
  return {
    bid: (mid - half) / TICKS_PER_RUPEE,
    ask: (mid + half) / TICKS_PER_RUPEE,
    ltp: mid / TICKS_PER_RUPEE,
    asOf: b.asOf,
  }
}

/**
 * The quote this model gives a strike, listed or not — the same one
 * `buildChain` lists at it. The driver prices a held leg that the moving
 * ladder has left behind with it, as if the board were unbounded.
 */
export function quoteAt(args: ChainArgs, strike: number, optType: OptType): Quote {
  return quoteOn(boardOf(args), strike, optType)
}

/** The board at one instant. Ascending strikes, both wings at every one. */
export function buildChain(args: ChainArgs): ChainSnap {
  const b = boardOf(args)
  const strikes: StrikeQuote[] = []
  for (let i = -STRIKES_EACH_SIDE; i <= STRIKES_EACH_SIDE; i += 1) {
    const strike = b.atm + i * b.step
    strikes.push({ strike, ce: quoteOn(b, strike, 'CE'), pe: quoteOn(b, strike, 'PE') })
  }
  const fut = Math.round(b.forward * TICKS_PER_RUPEE)
  return {
    symbol: args.symbol,
    expiry: args.expiry,
    step: b.step,
    lotSize: LOT[args.symbol],
    // A tick either side of the forward. Nothing on the decide path reads it
    // — `spot` is the forward the engine prices against — but a board without
    // its future is not a board any caller has ever been handed.
    future: { bid: (fut - 1) / TICKS_PER_RUPEE, ask: (fut + 1) / TICKS_PER_RUPEE, ltp: b.forward, asOf: b.asOf },
    spot: b.forward,
    strikes,
    asOf: b.asOf,
  }
}

/**
 * The move the options are charging for over `windowMin` minutes — exactly
 * what the regime detector compares the tape against
 * (`atmStraddleMid × √(window / minutesToExpiry)`), so a scenario sized in
 * multiples of it is sized in the detector's own units.
 *
 * THROWS rather than answering 0 when there is no reading (no straddle, no
 * time left): a burst sized off a zero would be no burst at all, and the
 * test built on it would pass for the wrong reason.
 */
export function impliedMove(chain: ChainSnap, minutesToExpiry: number, windowMin: number): number {
  const straddle = atmStraddleMid(chain)
  const move = straddle === null ? null : impliedWindowMove(straddle, minutesToExpiry, windowMin * 60)
  if (move === null) {
    throw new RangeError(
      `no implied move: straddle ${straddle}, ${minutesToExpiry} trading minutes, a ${windowMin}-minute window`,
    )
  }
  return move
}
