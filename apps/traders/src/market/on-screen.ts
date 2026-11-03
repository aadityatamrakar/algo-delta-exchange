// The underlyings Market Watch has on screen, each with the tokens it wants, kept for a TTL after
// its last poll and capped in tokens across all viewers, first come first served (P3). The cap is
// TRADERS_MARKET_WATCH_MAX_TOKENS, or what TRADERS_MAX_TOKENS leaves beside the books' own full
// windows when that is less: Market Watch yields to the books (Ruling R3-18).

export const ON_SCREEN_TTL_MS = 60_000
/** TRADERS_MARKET_WATCH_MAX_TOKENS when it is not set. */
export const DEFAULT_MARKET_WATCH_MAX_TOKENS = 1000

interface Entry { tokens: readonly number[]; expiresAt: number }

export class OnScreenSet {
  readonly #maxTokens: number
  readonly #ttlMs: number
  readonly #feedRoom: () => number
  readonly #entries = new Map<string, Entry>()

  /** `feedRoom`: TRADERS_MAX_TOKENS less the books' demand at the last declaration (none = no limit but `maxTokens`). */
  constructor(opts: { maxTokens: number; ttlMs?: number; feedRoom?: () => number }) {
    this.#maxTokens = opts.maxTokens
    this.#ttlMs = opts.ttlMs ?? ON_SCREEN_TTL_MS
    this.#feedRoom = opts.feedRoom ?? (() => Infinity)
  }

  get maxTokens(): number {
    return this.#maxTokens
  }

  /**
   * Granted when the union of all live sets, with this underlying's new set in place of its old one,
   * still fits. Refused, an underlying already in loses its grant: its old set no longer covers what
   * its screen shows, so it is not kept declaring strikes nobody sees.
   */
  touch(underlying: string, tokens: readonly number[], nowMs: number): boolean {
    this.#sweep(nowMs)
    if (!this.#fits(underlying, tokens)) {
      this.#entries.delete(underlying)
      return false
    }
    this.#entries.set(underlying, { tokens: [...tokens], expiresAt: nowMs + this.#ttlMs })
    return true
  }

  underlyings(nowMs: number): readonly string[] {
    this.#sweep(nowMs)
    return [...this.#entries.keys()]
  }

  /** The union of the live sets, a fresh array. */
  tokens(nowMs: number): readonly number[] {
    this.#sweep(nowMs)
    const all = new Set<number>()
    for (const e of this.#entries.values()) for (const t of e.tokens) all.add(t)
    return [...all]
  }

  #room(): number {
    return Math.max(0, Math.min(this.#maxTokens, this.#feedRoom()))
  }

  #fits(underlying: string, tokens: readonly number[]): boolean {
    const all = new Set<number>(tokens)
    for (const [name, e] of this.#entries) {
      if (name !== underlying) for (const t of e.tokens) all.add(t)
    }
    return all.size <= this.#room()
  }

  /** Drops the expired, then, when the books have grown into the room, the last comers until the rest fit. */
  #sweep(nowMs: number): void {
    for (const [name, e] of this.#entries) if (e.expiresAt <= nowMs) this.#entries.delete(name)
    const room = this.#room()
    const size = (): number => new Set([...this.#entries.values()].flatMap((e) => e.tokens)).size
    while (this.#entries.size > 0 && size() > room) this.#entries.delete([...this.#entries.keys()].at(-1) as string)
  }
}
