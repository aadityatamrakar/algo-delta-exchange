/**
 * RATE-LIMIT THE `engine decision applied` LINE FOR REPLAYS — one log site,
 * `routes/engine.ts`.
 *
 * WHY. desk-api has no debug level (`Log` is one function), and on a dead
 * weekend it wrote 10 MB every 3 h 20 min: 35,904 of 35,971 lines in one
 * rotated file were `engine decision applied … replayed: true, status:
 * WORKING`, for exactly three decision ids. The supervisor re-posts a package
 * it holds in flight until the package settles; a package wedged on orders
 * that can never fill (the SENSEX 10-01 books and TCS 09-29, on contracts
 * that had expired) is re-posted about once a second, forever, and every
 * re-post was a line. A replay routes nothing and changes nothing, so the line
 * is news once.
 *
 * THE RULE. A fresh decision (`replayed: false`) is ALWAYS logged — that is
 * the line an operator reads to see what the desk did. A replay is logged the
 * first time its id is seen, then at most once per `intervalMs` per id, and
 * that line carries how many replays it stood for. Still visible, so a wedged
 * book is still findable in the log; no longer the whole log.
 */

export interface ReplayLogVerdict {
  /** Write the line. */
  readonly log: boolean
  /** Replays of this id that were NOT logged since the last line that was. */
  readonly suppressed: number
}

/**
 * `outcome` is what the line would SAY — the route passes
 * `status|fills|routeErrors`. A replay whose outcome differs from the last
 * logged one is news (WORKING→DONE, a fill landing, a route error) and is
 * logged at once, whatever the interval.
 */
export type ReplayLogGate = (decisionId: string, replayed: boolean, nowMs: number, outcome?: string) => ReplayLogVerdict

export function createReplayLogGate(opts: { intervalMs: number; maxIds?: number }): ReplayLogGate {
  const maxIds = opts.maxIds ?? 1_000
  /** Insertion-ordered, so the first key is the least recently logged. */
  const seen = new Map<string, { lastAt: number; suppressed: number; outcome: string }>()
  return (decisionId, replayed, nowMs, outcome = '') => {
    if (!replayed) return { log: true, suppressed: 0 }
    const entry = seen.get(decisionId)
    if (entry !== undefined && nowMs - entry.lastAt < opts.intervalMs && entry.outcome === outcome) {
      entry.suppressed += 1
      return { log: false, suppressed: 0 }
    }
    const suppressed = entry?.suppressed ?? 0
    seen.delete(decisionId)
    seen.set(decisionId, { lastAt: nowMs, suppressed: 0, outcome })
    while (seen.size > maxIds) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    return { log: true, suppressed }
  }
}
