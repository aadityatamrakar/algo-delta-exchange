// A small time-to-live cache for the Release 3 screens (advice, band, Market Watch).
// One entry per key: callers inside the ttl share it, and callers that arrive while it
// is still computing share the same promise. A compute that fails is not kept, and
// entries past the ttl are dropped on each read (as R1's PayoffCache), so the map holds
// only what was read in the last ttl: no old leg version or Market Watch view stays.
export const MINUTE_MS = 60_000

interface Entry<T> {
  readonly at: number
  readonly value: Promise<T>
}

export class TtlCache<T> {
  readonly #ttlMs: number
  readonly #maxEntries: number
  readonly #entries = new Map<string, Entry<T>>()

  constructor(ttlMs: number, opts?: { maxEntries?: number }) {
    this.#ttlMs = ttlMs
    this.#maxEntries = opts?.maxEntries ?? 2000
  }

  get(key: string, nowMs: number, compute: () => Promise<T>): Promise<T> {
    for (const [k, e] of this.#entries) if (nowMs - e.at >= this.#ttlMs) this.#entries.delete(k)
    const hit = this.#entries.get(key)
    if (hit !== undefined) return hit.value
    const value = compute()
    const entry: Entry<T> = { at: nowMs, value }
    this.#entries.delete(key) // re-insert, so the Map's order is oldest-first
    this.#entries.set(key, entry)
    value.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key)
    })
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    return value
  }

  size(): number {
    return this.#entries.size
  }
}
