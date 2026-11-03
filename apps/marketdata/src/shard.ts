/**
 * Sharding tokens across multiple Kite websockets.
 *
 * Kite caps a single connection at ~900 tokens, so a desk of 10+ stock chains
 * plus index chains needs several sockets. This module decides WHICH socket each
 * token lives on. It performs no IO, which is the point: the assignment policy
 * is the part with a subtle correctness property, so it is the part under test.
 *
 * STICKINESS IS THE WHOLE DESIGN. The naive assignment — sort the token set and
 * deal it out in chunks of 900 — is stable only while the set is. Add one token
 * near the start and every token after it shifts by one position, which
 * unsubscribes and resubscribes thousands of tokens across every socket. Since a
 * Python client re-declares its book on every tick, that would mean continuous
 * churn on a live feed and a permanently reconnecting stack.
 *
 * So a token, once assigned, NEVER moves while it is still wanted. New tokens
 * fill existing gaps first; a new socket is added only when every existing one
 * is full. That makes re-declaring an unchanged set a genuine no-op.
 */

export interface ShardPlan {
  /** Token -> socket index, for tokens that were newly assigned. */
  readonly added: ReadonlyMap<number, number>
  /** Token -> socket index, for tokens that are no longer wanted. */
  readonly removed: ReadonlyMap<number, number>
  /** Number of sockets required after applying this plan. */
  readonly socketCount: number
  /** Tokens per socket after applying, indexed by socket. */
  readonly loads: readonly number[]
}

/** Kite's practical per-connection subscription cap. */
export const DEFAULT_MAX_TOKENS_PER_SOCKET = 900

export class TokenSharder {
  readonly #maxPerSocket: number
  /** token -> socket index */
  readonly #assignment = new Map<number, number>()
  /** socket index -> how many tokens it holds */
  #loads: number[] = []

  constructor(maxPerSocket: number = DEFAULT_MAX_TOKENS_PER_SOCKET) {
    if (maxPerSocket <= 0) throw new Error('maxPerSocket must be positive')
    this.#maxPerSocket = maxPerSocket
  }

  get socketCount(): number {
    return this.#loads.length
  }

  get size(): number {
    return this.#assignment.size
  }

  socketOf(token: number): number | undefined {
    return this.#assignment.get(token)
  }

  loads(): readonly number[] {
    return [...this.#loads]
  }

  tokensOn(socket: number): number[] {
    const out: number[] = []
    for (const [token, s] of this.#assignment) if (s === socket) out.push(token)
    return out
  }

  /**
   * Reconcile to exactly `wanted`.
   *
   * Removals are applied BEFORE additions, so freed capacity on an existing
   * socket is reused instead of opening a new one. Rolling a book — which drops
   * one strike and adds another in the same breath — would otherwise grow the
   * socket count forever.
   */
  reconcile(wanted: Iterable<number>): ShardPlan {
    const want = new Set(wanted)
    const added = new Map<number, number>()
    const removed = new Map<number, number>()

    for (const [token, socket] of [...this.#assignment]) {
      if (want.has(token)) continue
      removed.set(token, socket)
      this.#assignment.delete(token)
      this.#loads[socket] = (this.#loads[socket] ?? 1) - 1
    }

    for (const token of want) {
      if (this.#assignment.has(token)) continue // sticky: never move it
      const socket = this.#firstWithRoom()
      this.#assignment.set(token, socket)
      this.#loads[socket] = (this.#loads[socket] ?? 0) + 1
      added.set(token, socket)
    }

    this.#trimEmptyTrailingSockets()
    return { added, removed, socketCount: this.#loads.length, loads: [...this.#loads] }
  }

  #firstWithRoom(): number {
    for (let i = 0; i < this.#loads.length; i++) {
      if ((this.#loads[i] ?? 0) < this.#maxPerSocket) return i
    }
    this.#loads.push(0)
    return this.#loads.length - 1
  }

  /**
   * Drop trailing empty sockets only.
   *
   * Not empty ones in the middle: removing socket 1 of 3 would renumber socket
   * 2 to 1, and every token on it would silently point at the wrong connection.
   * A hole costs one idle websocket; renumbering costs correctness.
   */
  #trimEmptyTrailingSockets(): void {
    while (this.#loads.length > 0 && (this.#loads[this.#loads.length - 1] ?? 0) === 0) {
      this.#loads.pop()
    }
  }
}
