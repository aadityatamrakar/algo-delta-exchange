/**
 * A DELTA EXIT KEEPS WORKING UNTIL IT FILLS.
 *
 * THE DEFECT: a buy-back went out as a marketable limit off the MARK + 2 %;
 * the chaser repriced it three times by 3 % and then handed it to a human
 * (`chaseExhaustedAt`) — and with no usable mark the desk degraded to MARKET,
 * which `DxAdapter` refuses outright. On a fast or thin option book that is a
 * short left open with nothing working it.
 *
 * FOR A CLOSE (`desk_op: 'close'`, sent reduce-only), on Delta:
 *
 *   1. AT PLACEMENT it is priced off the TOUCH — the best ask for a buy, the
 *      best bid for a sell — plus `DESK_DX_CLOSE_BUFFER_PCT` (min
 *      `DESK_DX_CLOSE_MIN_TICKS` ticks), never off the mark and never MARKET
 *      (`closeLimitPrice`).
 *   2. THE BOOK is the gateway's own WS quote when it is at most
 *      `DESK_DX_CLOSE_QUOTE_MAX_AGE_MS` (5 s) old, else Delta REST's ticker
 *      for the contract — L1 and the price band in one read
 *      (`createCloseBookSource`).
 *   3. AFTER THE NORMAL CHASE it is not handed back: the chaser keeps
 *      repricing every `DESK_DX_CLOSE_STEP_MS`, each step
 *      `DESK_DX_CLOSE_STEP_PCT` further beyond the touch, capped at
 *      `DESK_DX_CLOSE_MAX_MULT` × the touch and the contract's price band,
 *      until it fills or the position is gone (`closeEscalationPrice`). A
 *      critical alert goes out the first time, and every 10 min while unfilled.
 *
 * A limit past the touch fills AT the touch, so the cap is a worst case, not
 * the price paid.
 */
import { num, type DxTicker } from '@algomaker/dx'
import type { Touch } from './quote-map.ts'

type Env = Readonly<Record<string, string | undefined>>

export const DEFAULT_CLOSE_BUFFER_PCT = 0.02
export const DEFAULT_CLOSE_MIN_TICKS = 2
export const DEFAULT_CLOSE_STEP_PCT = 0.05
export const DEFAULT_CLOSE_MAX_MULT = 3
export const DEFAULT_CLOSE_STEP_MS = 3_000
export const DEFAULT_CLOSE_QUOTE_MAX_AGE_MS = 5_000

export interface CloseDials {
  readonly bufferPct: number
  readonly minTicks: number
  readonly stepPct: number
  readonly maxMult: number
  readonly stepMs: number
  readonly wsMaxAgeMs: number
}

/** Read once at boot; a typo falls back rather than pricing at NaN. */
export function closeDialsFromEnv(env: Env): CloseDials {
  const dial = (name: string, fallback: number, ok: (n: number) => boolean): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) && ok(n) ? n : fallback
  }
  return {
    bufferPct: dial('DESK_DX_CLOSE_BUFFER_PCT', DEFAULT_CLOSE_BUFFER_PCT, (n) => n >= 0 && n < 1),
    minTicks: dial('DESK_DX_CLOSE_MIN_TICKS', DEFAULT_CLOSE_MIN_TICKS, (n) => n >= 0),
    stepPct: dial('DESK_DX_CLOSE_STEP_PCT', DEFAULT_CLOSE_STEP_PCT, (n) => n > 0 && n < 1),
    // Under 1x the cap would sit inside the touch and the close could never cross.
    maxMult: dial('DESK_DX_CLOSE_MAX_MULT', DEFAULT_CLOSE_MAX_MULT, (n) => n > 1),
    stepMs: dial('DESK_DX_CLOSE_STEP_MS', DEFAULT_CLOSE_STEP_MS, (n) => n >= 500),
    wsMaxAgeMs: dial('DESK_DX_CLOSE_QUOTE_MAX_AGE_MS', DEFAULT_CLOSE_QUOTE_MAX_AGE_MS, (n) => n > 0),
  }
}

/** One contract's book as a close sees it. A side with no quote is null. */
export interface CloseBook {
  readonly bid: number | null
  readonly ask: number | null
  /** Delta's absolute price band for orders, when known. */
  readonly lower: number | null
  readonly upper: number | null
  readonly source: 'ws' | 'rest'
}

const EPSILON = 1e-9
const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

function decimalsOf(tick: number): number {
  const s = String(tick)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

/** A price onto the tick grid in a stated direction, never below one tick. */
function grid(raw: number, dir: 'floor' | 'ceil', tick: number): number {
  const t = raw / tick
  const ticks = dir === 'floor' ? Math.floor(t + EPSILON) : Math.ceil(t - EPSILON)
  return Number((Math.max(ticks, 1) * tick).toFixed(decimalsOf(tick)))
}

const tickOf = (t: number): number => (Number.isFinite(t) && t > 0 ? t : 0.1)

/**
 * THE CLOSE'S PRICE AT PLACEMENT: the far side of the touch plus the buffer —
 * `max(bufferPct × touch, minTicks × tick)` — rounded away from the market,
 * held inside the price band. Null when the side it must cross is empty.
 */
export function closeLimitPrice(
  side: 'BUY' | 'SELL',
  book: CloseBook,
  d: { readonly bufferPct: number; readonly minTicks: number; readonly tickSize: number },
): number | null {
  const tick = tickOf(d.tickSize)
  if (side === 'BUY') {
    if (!pos(book.ask)) return null
    const p = grid(book.ask + Math.max(d.bufferPct * book.ask, d.minTicks * tick), 'ceil', tick)
    return pos(book.upper) ? Math.min(p, grid(book.upper, 'floor', tick)) : p
  }
  if (!pos(book.bid)) return null
  const p = grid(book.bid - Math.max(d.bufferPct * book.bid, d.minTicks * tick), 'floor', tick)
  return pos(book.lower) ? Math.max(p, grid(book.lower, 'ceil', tick)) : p
}

/**
 * STEP `step` (1-based) OF A CLOSE THE NORMAL CHASE DID NOT FILL.
 *
 * With a book: `step × stepPct` beyond the far touch, capped at `maxMult` ×
 * that touch (a buy) or floored at touch ÷ `maxMult` (a sell), and held inside
 * the band. With no book at all: one `stepPct` beyond the last accepted price
 * (the original limit before any), bounded by `maxMult` off the ORIGINAL limit
 * — blind, but still a limit, never MARKET.
 */
export function closeEscalationPrice(
  side: 'BUY' | 'SELL',
  step: number,
  d: {
    readonly book: CloseBook | null
    readonly lastPrice: number
    readonly limitPrice: number
    readonly stepPct: number
    readonly maxMult: number
    readonly tickSize: number
  },
): number | null {
  if (!Number.isInteger(step) || step < 1) return null
  const tick = tickOf(d.tickSize)
  const blindBase = pos(d.lastPrice) ? d.lastPrice : d.limitPrice
  if (side === 'BUY') {
    const ask = d.book?.ask ?? null
    let raw: number
    let cap: number
    if (pos(ask)) {
      raw = ask * (1 + d.stepPct * step)
      cap = ask * d.maxMult
    } else {
      if (!pos(blindBase) || !pos(d.limitPrice)) return null
      raw = blindBase * (1 + d.stepPct)
      cap = d.limitPrice * d.maxMult
    }
    const upper = d.book?.upper ?? null
    if (pos(upper)) cap = Math.min(cap, upper)
    return Math.min(grid(raw, 'ceil', tick), grid(cap, 'floor', tick))
  }
  const bid = d.book?.bid ?? null
  let raw: number
  let floor: number
  if (pos(bid)) {
    raw = bid * (1 - d.stepPct * step)
    floor = bid / d.maxMult
  } else {
    if (!pos(blindBase) || !pos(d.limitPrice)) return null
    raw = blindBase * (1 - d.stepPct)
    floor = d.limitPrice / d.maxMult
  }
  const lower = d.book?.lower ?? null
  if (pos(lower)) floor = Math.max(floor, lower)
  return Math.max(grid(raw, 'floor', tick), grid(floor, 'ceil', tick))
}

/** The ticker's L1 and band as a close's book. */
export function bookFromTicker(t: DxTicker): CloseBook {
  const p = (v: unknown): number | null => {
    const n = num(v)
    return n !== null && n > 0 ? n : null
  }
  return {
    bid: p(t.quotes?.best_bid),
    ask: p(t.quotes?.best_ask),
    lower: p(t.price_band?.lower_limit),
    upper: p(t.price_band?.upper_limit),
    source: 'rest',
  }
}

export interface CloseBookSource {
  /** The contract's book, or null when neither the WS quote nor REST has one. Never throws. */
  book(doc: { readonly instrument_token?: unknown; readonly tradingsymbol?: unknown }): Promise<CloseBook | null>
}

/**
 * WS FIRST, REST WHEN IT IS OLD. `touch` is the gateway's QuoteMap (null past
 * its own bound); a quote older than `wsMaxAgeMs` is not used for an exit.
 * `ticker` is the rail's own Delta REST client (production for live, testnet
 * for demo); absent (the simulator) means WS only.
 */
export function createCloseBookSource(d: {
  readonly touch: (token: number) => Touch | null
  readonly now: () => number
  readonly wsMaxAgeMs: number
  readonly ticker?: (symbol: string) => Promise<DxTicker>
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}): CloseBookSource {
  return {
    async book(doc) {
      const token = Number(doc.instrument_token ?? 0)
      const t = Number.isFinite(token) && token > 0 ? d.touch(token) : null
      if (t !== null && d.now() - t.ts <= d.wsMaxAgeMs) {
        return { bid: pos(t.bid) ? t.bid : null, ask: pos(t.ask) ? t.ask : null, lower: null, upper: null, source: 'ws' }
      }
      const symbol = String(doc.tradingsymbol ?? '')
      if (d.ticker === undefined || symbol === '') return null
      try {
        return bookFromTicker(await d.ticker(symbol))
      } catch (err) {
        d.log?.('close book: REST ticker failed', { symbol, error: err instanceof Error ? err.message : String(err) })
        return null
      }
    },
  }
}
