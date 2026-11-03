/**
 * A small paper book for the BULL-S suites: a chain built from a premium model
 * (with per-strike overrides), a book that fills every action at once, and a
 * runner that feeds each decision's `stateAfter` back in, as the host does.
 *
 * Fills: a sale fills at the bid and a buy-back at the ask (`fill: 'touch'`),
 * or both at the last price (`fill: 'ltp'`, the NSE parity tape).
 */
import { resolveDials, type Dials } from '../../src/dials.ts'
import { PRESETS } from '../../src/presets.ts'
import { EMPTY_RULE_STATE } from '../../src/types.ts'
import type { ChainSnap, EngineDecision, LegView, OptType, Quote, RuleState } from '../../src/types.ts'
import type { MarkContext } from '../../src/guards.ts'
import { BS_EMPTY, type BullSState } from '../../src/bull-s/state.ts'
import { decideBullS, type BullSInputs } from '../../src/bull-s/decide.ts'

/** 2026-11-04 11:30 IST, a Wednesday. A real instant, never `Date.now()`. */
export const T0 = Date.UTC(2026, 10, 4, 6, 0)
export const DATE = '2026-11-04'
export const MINUTE = 690
export const LOT = 0.001
export const MARK: MarkContext = { isNewMark: false, markIndexToday: 0 }

export const key = (strike: number, opt: OptType): string => `${strike}${opt}`
export const sym = (strike: number, opt: OptType): string => `${opt === 'CE' ? 'C' : 'P'}-BTC-${strike}-041126`

export function q(bid: number | null, ask: number | null, ltp: number | null = null, asOf = T0): Quote {
  return { bid, ask, ltp, asOf }
}

/**
 * Intrinsic plus a time value that fades slowly away from the money; ±2 wide.
 * Flat enough that a $1,000 move leaves a straddle under 1.25× its sale, so a
 * stop fires in these suites only where a test prices one on purpose.
 */
export function model(strike: number, opt: OptType, ref: number, asOf: number): Quote {
  const intrinsic = Math.max(0, opt === 'CE' ? ref - strike : strike - ref)
  const px = Math.round((intrinsic + 2000 * Math.exp(-Math.abs(strike - ref) / 20_000)) * 10) / 10
  return q(px - 2, px + 2, px, asOf)
}

export const LADDER: readonly number[] = Array.from({ length: 101 }, (_, i) => 70_000 + i * 200)

export interface ChainOpts {
  readonly strikes?: readonly number[]
  /** `key(strike, opt)` → the quote, or null for a strike with that side missing. */
  readonly quotes?: Readonly<Record<string, Quote | null>>
  readonly step?: number
  readonly lotSize?: number
}

export function chainAt(ref: number, nowMs: number, o: ChainOpts = {}): ChainSnap {
  const strikes = o.strikes ?? LADDER
  const pick = (k: number, t: OptType): Quote | null => {
    const over = o.quotes?.[key(k, t)]
    return over !== undefined ? over : model(k, t, ref, nowMs)
  }
  return {
    symbol: 'BTC',
    expiry: '2026-11-05',
    step: o.step ?? 200,
    lotSize: o.lotSize ?? LOT,
    future: q(ref, ref, ref, nowMs),
    spot: ref,
    strikes: strikes.map((k) => ({ strike: k, ce: pick(k, 'CE'), pe: pick(k, 'PE') })),
    asOf: nowMs,
  }
}

/** The daily preset folded onto the defaults, plus `over`. Throws on a refused dial. */
export function dialsOf(over: Partial<Dials> = {}, preset = 'bull-s-btc-daily'): Dials {
  const p = PRESETS.find((x) => x.key === preset)
  if (p === undefined) throw new Error(`no preset ${preset}`)
  const { dials, unknown } = resolveDials({ ...p.dials, ...over } as Record<string, number | boolean>)
  if (unknown.length > 0) throw new Error(`refused dials: ${unknown.join(', ')}`)
  return dials
}

export function stateWith(bs: Partial<BullSState> = {}): RuleState {
  return { ...EMPTY_RULE_STATE, bs: { ...BS_EMPTY, ...bs } }
}

interface Held { strike: number; opt: OptType; lots: number; entry: number; lotSize: number }

export interface TickOpts {
  readonly chain?: ChainOpts
  readonly refAsOf?: number
  readonly minutesToExpiry?: number
  readonly minuteOfDay?: number
  readonly dateIst?: string
  readonly pendingLots?: number
  /** false: decide but fill nothing (an order still working). */
  readonly fill?: boolean
  readonly dials?: Dials
}

export interface Flat {
  readonly op: 'open' | 'close'
  readonly strike: number
  readonly optType: OptType
  readonly side: 'Buy' | 'Sell'
  readonly lots: number
}

export class Run {
  state: RuleState
  dials: Dials
  cum = 0
  readonly book = new Map<string, Held>()
  /** Every action filled so far, flattened to (op, strike, optType, side, lots). */
  readonly orders: Flat[] = []
  readonly fillMode: 'touch' | 'ltp'

  constructor(dials: Dials, state: RuleState = stateWith(), fillMode: 'touch' | 'ltp' = 'touch') {
    this.dials = dials
    this.state = state
    this.fillMode = fillMode
  }

  legs(chain: ChainSnap): LegView[] {
    return [...this.book.entries()].map(([instrument, h]) => {
      const row = chain.strikes.find((s) => s.strike === h.strike)
      const quote = (h.opt === 'CE' ? row?.ce : row?.pe) ?? q(null, null)
      const mark = this.fillMode === 'ltp' ? quote.ltp : quote.ask
      return {
        instrument,
        strike: h.strike,
        optType: h.opt,
        side: 'Sell',
        lots: h.lots,
        lotSize: h.lotSize,
        entry: h.entry,
        openedByEngine: true,
        leanId: '',
        iv: null,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        hasGreeks: false,
        mtm: mark === null ? 0 : -(mark - h.entry) * h.lots * h.lotSize,
        exit: quote,
      }
    })
  }

  inputs(ref: number | null, nowMs: number, o: TickOpts = {}): BullSInputs {
    const chain = chainAt(ref ?? 80_000, nowMs, o.chain)
    return {
      tag: 'BTC-2026-11-05-bull-s-daily',
      mode: 'paper',
      nowMs,
      dateIst: o.dateIst ?? DATE,
      minuteOfDay: o.minuteOfDay ?? MINUTE,
      dte: 1,
      chain,
      legs: this.legs(chain),
      protectedQty: {},
      cumRealized: this.cum,
      margin: { value: 0, source: 'model', asOf: nowMs, fresh: false },
      pendingLots: o.pendingLots ?? 0,
      repairHold: false,
      pricing: 'live',
      ref,
      refAsOf: o.refAsOf ?? (ref === null ? 0 : nowMs),
      minutesToExpiry: o.minutesToExpiry ?? 1_800,
    }
  }

  tick(ref: number | null, nowMs: number, o: TickOpts = {}): EngineDecision {
    const inputs = this.inputs(ref, nowMs, o)
    const d = decideBullS(inputs, o.dials ?? this.dials, this.state, MARK)
    if (o.fill === false) {
      this.state = d.markState
      return d
    }
    this.state = d.stateAfter
    for (const a of d.actions) {
      if (a.op === 'open') {
        const row = inputs.chain.strikes.find((s) => s.strike === a.strike)
        const quote = a.optType === 'CE' ? row?.ce : row?.pe
        const px = this.fillMode === 'ltp' ? quote?.ltp : quote?.bid
        if (px === null || px === undefined) throw new Error(`no price to fill ${key(a.strike, a.optType)}`)
        this.book.set(sym(a.strike, a.optType), {
          strike: a.strike, opt: a.optType, lots: a.lots, entry: px, lotSize: inputs.chain.lotSize,
        })
        this.orders.push({ op: 'open', strike: a.strike, optType: a.optType, side: a.side, lots: a.lots })
      } else if (a.op === 'close') {
        const h = this.book.get(a.instrument)
        if (h === undefined) throw new Error(`close of a leg not held: ${a.instrument}`)
        const leg = inputs.legs.find((l) => l.instrument === a.instrument)
        const px = this.fillMode === 'ltp' ? leg?.exit.ltp : leg?.exit.ask
        this.cum += (h.entry - (px ?? h.entry)) * h.lots * h.lotSize
        this.book.delete(a.instrument)
        this.orders.push({ op: 'close', strike: h.strike, optType: h.opt, side: 'Buy', lots: h.lots })
      } else {
        throw new Error('BULL-S never resizes')
      }
    }
    return d
  }
}

export const opensOf = (d: EngineDecision): string[] =>
  d.actions.flatMap((a) => (a.op === 'open' ? [`${a.side} ${a.strike}${a.optType} x${a.lots}`] : []))
export const closesOf = (d: EngineDecision): string[] =>
  d.actions.flatMap((a) => (a.op === 'close' ? [a.instrument] : []))
