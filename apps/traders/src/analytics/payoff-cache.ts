/**
 * The book's payoff, rebuilt at most once a minute per key and shared by every
 * viewer (P13: the payoff walk is the expensive part of a book view, and every
 * open tab polls). The caller puts the trader's leg version in the key, so a
 * leg write misses the cache and the next read rebuilds at once. Entries older
 * than the TTL are dropped on each read, so the map holds only books viewed in
 * the last minute.
 */

import type { PayoffView } from '@algomaker/payoff'

export const PAYOFF_TTL_MS = 60_000

export class PayoffCache {
  readonly #now: () => number
  readonly #entries = new Map<string, { readonly at: number; readonly view: PayoffView | null }>()

  constructor(now: () => number) {
    this.#now = now
  }

  get(key: string, build: () => PayoffView | null): PayoffView | null {
    const now = this.#now()
    for (const [k, e] of this.#entries) if (now - e.at >= PAYOFF_TTL_MS) this.#entries.delete(k)
    const hit = this.#entries.get(key)
    if (hit !== undefined) return hit.view
    const view = build()
    this.#entries.set(key, { at: now, view })
    return view
  }
}
