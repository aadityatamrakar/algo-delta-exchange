/**
 * The gateway's touch — token -> last TWO-SIDED book, with an age on it.
 *
 * THE DEFECT (2026-08-18, again): a marketable limit is priced once, at
 * submit, and by the time it reaches the exchange the touch has moved; the
 * order rests on the wrong side of a spread nobody is watching. The chaser's
 * answer so far was a BLIND ladder — escalate off the original limit, no
 * market data at all — which crosses the spread by construction. Passive
 * working needs the opposite: join the touch and follow it, and cross only
 * when the deadline says the fill matters more than the tick.
 *
 * Following the touch needs the touch, so this file is the ONE market-data
 * read on the order path, and it is deliberately shaped so that reading it
 * cannot repeat the failure it exists to fix:
 *
 * BOTH SIDES OR NOTHING. A frame is recorded only when bid and ask are both
 * real, positive and un-crossed. `md.tick` carries them both-or-neither off
 * the depth (`apps/marketdata/src/main.ts:tickPayload`); an LTP-only frame is
 * a TRADE print, not a book, and it is dropped — it neither replaces the last
 * book nor refreshes its age. On an illiquid strike the last print is a
 * memory (TCS 2440PE, 2026-08-17: last trade 14:20 under a book moving every
 * second) and pegging to a spread inferred from it is exactly the mispricing
 * being chased.
 *
 * AGE IS THE BOOK'S OWN. `touch()` answers `null` past
 * `DESK_PEG_QUOTE_MAX_AGE_MS` and null means PAUSE — the peg stops moving the
 * order and no attempt is consumed. A stale mark is how the limit was
 * mispriced in the first place; the one thing this must never do is guess.
 *
 * NEVER THROWS. `onTick` runs inside a bus subscriber on the only process
 * that can place orders, and every field it reads came off a socket. Junk is
 * dropped silently — a malformed frame must not cost the desk its gateway.
 *
 * DISPLAY-ONLY SNAPSHOTS ARE NOT A SOURCE. Nothing here reads `desk-marks`:
 * that collection's stated invariant is that the order path never touches it,
 * and it stays true. This map holds only what arrived live on this process's
 * own subscription, and holds nothing at all until a tick lands — a gateway
 * that just booted pegs nothing, which is the correct answer for a process
 * that has not yet seen the market.
 */

/** How old a book may be and still be worth pegging to. */
export const DEFAULT_QUOTE_MAX_AGE_MS = 15_000

/** The two-sided book, as the chaser consumes it. */
export interface Touch {
  readonly bid: number
  readonly ask: number
  /** The frame's own timestamp — how old this BOOK is, not the last trade. */
  readonly ts: number
}

export interface QuoteMap {
  /** One `md.tick` payload, straight off the wire and untrusted. */
  onTick(frame: unknown): void
  /** The token's book, or null when absent, malformed or stale. */
  touch(token: number): Touch | null
  /** Tokens holding a book. An observability hook, not a business rule. */
  readonly size: number
}

export interface QuoteMapOptions {
  readonly now: () => number
  readonly maxAgeMs?: number
}

/**
 * The staleness dial, from the environment.
 *
 * NaN-refusing for the same reason as `chaseDialsFromEnv`: every comparison
 * against NaN is false, so `age > NaN` would answer "fresh" for a book from
 * three hours ago — the mistyped dial would not disable pegging, it would
 * arm it against stale data.
 */
export function quoteMaxAgeFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DESK_PEG_QUOTE_MAX_AGE_MS']
  if (raw === undefined || raw.trim() === '') return DEFAULT_QUOTE_MAX_AGE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUOTE_MAX_AGE_MS
}

/** A finite, strictly positive number off an untrusted frame, or null. */
function price(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export function createQuoteMap(opts: QuoteMapOptions): QuoteMap {
  const maxAgeMs = opts.maxAgeMs !== undefined && opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_QUOTE_MAX_AGE_MS
  /**
   * Bounded in practice by the feed's own subscription list — this holds one
   * small record per token the marketdata process publishes, and that list is
   * the desk's open instruments plus its chains. Nothing here is per-tick
   * allocation that accumulates.
   */
  const byToken = new Map<number, Touch>()

  return {
    get size(): number {
      return byToken.size
    },

    onTick(frame: unknown): void {
      if (frame === null || typeof frame !== 'object') return
      const f = frame as Record<string, unknown>
      const token = f['token']
      if (typeof token !== 'number' || !Number.isFinite(token)) return

      const bid = price(f['bid'])
      const ask = price(f['ask'])
      // Both-or-neither, per frame. A one-sided book prices nothing, and a
      // crossed one (ask < bid) is a bad frame rather than a market — keeping
      // either would let the peg join a side that is not there. A locked
      // market (ask === bid) is real and is kept.
      if (bid === null || ask === null || ask < bid) return

      const rawTs = f['ts']
      // A garbled timestamp degrades to ARRIVAL, never to NaN: a NaN age reads
      // as fresh forever, which is the one failure mode staleness exists to
      // prevent. Arrival time is honest — the frame did just get here.
      const ts = typeof rawTs === 'number' && Number.isFinite(rawTs) && rawTs > 0 ? rawTs : opts.now()
      byToken.set(token, { bid, ask, ts })
    },

    touch(token: number): Touch | null {
      const q = byToken.get(token)
      if (q === undefined) return null
      // Kept, not deleted, on staleness: the book will be answered again the
      // moment a fresh frame lands, and deleting would lose the last known
      // state for no gain.
      return opts.now() - q.ts > maxAgeMs ? null : q
    },
  }
}
