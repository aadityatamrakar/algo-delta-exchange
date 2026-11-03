/**
 * What a turn may spend, enforced outside the model (spec R10): the price
 * table that turns token usage into US dollars, the daily caps per trader and
 * for the whole desk — checked before a turn with its first call's worst case
 * held, and again before every further call — the ledger of what running
 * turns hold, and the gate that lets one turn per trader and four in all run
 * at once.
 *
 * Prices are US dollars per million tokens, Anthropic first-party rates as of
 * Oct 2026 (the claude-api skill's table): a cache read is billed at its own
 * rate and a 5-minute cache write at 1.25× input. A model not in the table has
 * no price, and with no TRADERS_AI_PRICE_* override the assistant stays off —
 * a cap that cannot be priced cannot be enforced.
 */

export interface AiPrice {
  /** USD per million uncached input tokens. */
  readonly inPerMTok: number
  readonly outPerMTok: number
  readonly cacheReadPerMTok: number
  readonly cacheWritePerMTok: number
}

const anthropic = (input: number, output: number, cacheRead: number): AiPrice =>
  ({ inPerMTok: input, outPerMTok: output, cacheReadPerMTok: cacheRead, cacheWritePerMTok: input * 1.25 })

export const PRICE_TABLE: Readonly<Record<string, AiPrice>> = Object.freeze({
  'claude-opus-5-5': anthropic(4, 20, 0.2),
  'claude-sonnet-5-5': anthropic(2, 10, 0.2),
  'claude-haiku-5-5': anthropic(0.1, 0.5, 0.01),
  'claude-fable-5-1': anthropic(10, 50, 0.25),
  'claude-fable-5': anthropic(10, 50, 1),
  'claude-opus-5': anthropic(5, 25, 0.5),
  'claude-sonnet-5': anthropic(2, 10, 0.2),
  'claude-opus-4-8': anthropic(5, 25, 0.5),
  'claude-sonnet-4-6': anthropic(3, 15, 0.3),
  'claude-haiku-4-5': anthropic(1, 5, 0.1),
})

/** An override (both numbers given) wins; else the table; else null. Cached input of an override is priced at 10% and 125%. */
export function priceFor(model: string, override: { readonly inPerMTok: number; readonly outPerMTok: number } | null): AiPrice | null {
  if (override !== null) {
    return { inPerMTok: override.inPerMTok, outPerMTok: override.outPerMTok, cacheReadPerMTok: override.inPerMTok * 0.1, cacheWritePerMTok: override.inPerMTok * 1.25 }
  }
  return PRICE_TABLE[model] ?? null
}

/** One call's or one turn's tokens. `inputTokens` is the whole prompt: uncached + cache read + cache write. */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export const NO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

/** Dollars, to a hundredth of a cent. Uncached input is what is left of the prompt after the cache's share. */
export function costUsd(u: TokenUsage, p: AiPrice): number {
  const uncached = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens)
  const usd = (uncached * p.inPerMTok + u.cacheReadTokens * p.cacheReadPerMTok + u.cacheWriteTokens * p.cacheWritePerMTok + u.outputTokens * p.outPerMTok) / 1e6
  return Math.round(usd * 1e4) / 1e4
}

/** Per-turn limits (spec R10). */
export const TURN_LIMITS = Object.freeze({
  maxSteps: 10,
  maxToolCalls: 16,
  maxSearches: 3,
  wallClockMs: 120_000,
  perTrader: 1,
  total: 4,
})

export type BudgetRefusal = { readonly code: 'budget'; readonly message: string }

export interface Caps { readonly traderUsd: number; readonly globalUsd: number }

/**
 * The day's spend against the caps: null when `reserveUsd` more still fits
 * both. `spent.globalUsd` includes what other running turns hold (SpendLedger),
 * so four turns at once cannot pass the desk cap together.
 */
export function capRefusal(spent: { readonly traderUsd: number; readonly globalUsd: number }, caps: Caps, reserveUsd = 0): BudgetRefusal | null {
  if (spent.globalUsd >= caps.globalUsd || spent.globalUsd + reserveUsd > caps.globalUsd) {
    return { code: 'budget', message: `the desk's assistant budget for today (US$${caps.globalUsd}) is spent — it resets at midnight IST` }
  }
  if (spent.traderUsd >= caps.traderUsd || spent.traderUsd + reserveUsd > caps.traderUsd) {
    return { code: 'budget', message: `your assistant budget for today (US$${caps.traderUsd}) is spent — it resets at midnight IST` }
  }
  return null
}

/** One model call at its worst: the whole prompt uncached and the full output cap. */
export function worstCallUsd(inputTokens: number, maxOutputTokens: number, p: AiPrice): number {
  return costUsd({ inputTokens, outputTokens: maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, p)
}

/**
 * What the turns running now hold against the caps, in this process: each
 * turn's cost so far plus its next call's worst case, from before its first
 * call until its record is stored (then the store's spend counts it). The
 * caps are checked against stored spend plus every other turn's hold.
 */
export class SpendLedger {
  readonly #holds = new Map<string, { readonly trader: string; usd: number }>()

  hold(turnId: string, trader: string, usd: number): void {
    this.#holds.set(turnId, { trader, usd })
  }

  set(turnId: string, usd: number): void {
    const h = this.#holds.get(turnId)
    if (h !== undefined) h.usd = usd
  }

  release(turnId: string): void {
    this.#holds.delete(turnId)
  }

  /** Held by every running turn but `except`: for the trader, and in all. */
  held(trader: string, except?: string): { readonly traderUsd: number; readonly globalUsd: number } {
    let traderUsd = 0, globalUsd = 0
    for (const [id, h] of this.#holds) {
      if (id === except) continue
      globalUsd += h.usd
      if (h.trader === trader) traderUsd += h.usd
    }
    return { traderUsd, globalUsd }
  }
}

/** One turn per trader and `total` in all. `enter` answers a release function, or null when busy. */
export class TurnGate {
  readonly #running = new Map<string, number>()
  readonly #perTrader: number
  readonly #total: number

  constructor(perTrader: number = TURN_LIMITS.perTrader, total: number = TURN_LIMITS.total) {
    this.#perTrader = perTrader
    this.#total = total
  }

  get running(): number {
    let n = 0
    for (const v of this.#running.values()) n += v
    return n
  }

  enter(trader: string): (() => void) | null {
    if (this.running >= this.#total) return null
    const mine = this.#running.get(trader) ?? 0
    if (mine >= this.#perTrader) return null
    this.#running.set(trader, mine + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.#running.get(trader) ?? 1) - 1
      if (n <= 0) this.#running.delete(trader)
      else this.#running.set(trader, n)
    }
  }
}
