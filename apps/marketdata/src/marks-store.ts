/**
 * `desk-marks` — the last price per token, upserted IN PLACE every 60 seconds by
 * the snapshot loop in `main.ts`, read by desk-api at boot (display only) and by
 * the supervisor's warm start.
 *
 * ── THE INDEX ───────────────────────────────────────────────────────────────
 * The snapshot loop writes one `updateOne({ token })` per token per minute, and
 * for its first three months the collection had no index but `_id`. Every one
 * of those upserts was a COLLECTION SCAN: 836 tokens a minute against 5,946
 * rows, 6.24 million scans and ~28 billion documents examined in 99 hours of
 * uptime — essentially every document read the database did (measured
 * 2026-10-19 with `$collStats.queryExecStats`). `{token: 1}` UNIQUE turns each
 * into a point lookup, and makes "one row per token" a property of the
 * collection rather than of the loop happening to run sequentially.
 *
 * ── THE PRUNE ───────────────────────────────────────────────────────────────
 * Nothing ever deleted a row, so every contract the desk ever subscribed kept
 * its row forever: on 2026-10-19, 4,313 of the 5,946 rows were for tokens the
 * instrument master no longer had. They were not just dead weight — desk-api
 * loads the whole collection into its quote cache at boot and every 5 minutes.
 *
 * "NOT IN THE MASTER" IS THE EXPIRY TEST, and it is the right one because the
 * daily sync already decided it: `planSync` deletes an expired contract only
 * when no book references it (`referencedTokens` → `retainedExpired`), and the
 * spot rows settlement reads (NIFTY 50, NIFTY BANK, SENSEX, the stock spots) are
 * master rows too. So a token missing from the master is one nothing on the
 * desk can still need a mark for.
 *
 * THE GRACE IS THE SECOND KEY. A row is pruned only if it has also not been
 * priced for `MARKS_ORPHAN_GRACE_MS`: a token this process is still pricing is
 * re-stamped every minute and can never qualify, whatever a bad sync did to the
 * master. The marks are display-only (the order path never reads them), so the
 * worst a wrong prune can cost is a `no mark` out of hours — but it should not
 * be able to cost even that.
 */

export const MARKS_COLLECTION = 'desk-marks'

/** A week: longer than any exchange holiday run, so a live token is never a candidate. */
export const MARKS_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60_000

/** The narrow Mongo surface this needs. Same port style as `subscription-store.ts`. */
export interface MarksCollection {
  deleteMany(filter: Record<string, unknown>): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

type Log = (msg: string, ctx?: Record<string, unknown>) => void

/**
 * Build the `{token: 1}` unique index. NEVER THROWS.
 *
 * Fail-soft because the snapshot works without it — slowly, as it did for three
 * months — and a boot that refused to start over an index would stop the feed.
 * The one way it can fail is a duplicate `token` row already in the collection,
 * and that is said loudly so someone removes the duplicate.
 */
export async function ensureMarksIndex(marks: MarksCollection, log: Log): Promise<void> {
  try {
    await marks.createIndex({ token: 1 }, { unique: true })
  } catch (err) {
    log('desk-marks token index NOT built — every snapshot upsert is a collection scan until it is', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export interface MarksPruneResult {
  readonly deleted: number
  /** Why nothing was attempted, when nothing was. */
  readonly skipped?: string
}

/**
 * Delete the rows of tokens the instrument master no longer has and that have
 * not been priced within the grace. NEVER THROWS — it runs on the tail of the
 * daily sync, and a failed prune must not read as a failed sync.
 *
 * `masterTokens` is the WHOLE master as just rebuilt. An empty one is refused
 * outright: `$nin: []` matches every row, and an empty master means the sync
 * produced nothing, not that every contract expired.
 */
export async function pruneOrphanMarks(input: {
  readonly marks: MarksCollection
  readonly masterTokens: readonly number[]
  readonly nowMs: number
  readonly graceMs?: number
  readonly log: Log
}): Promise<MarksPruneResult> {
  if (input.masterTokens.length === 0) {
    input.log('desk-marks prune skipped — the instrument master is empty')
    return { deleted: 0, skipped: 'empty master' }
  }
  const cutoff = input.nowMs - (input.graceMs ?? MARKS_ORPHAN_GRACE_MS)
  try {
    const res = await input.marks.deleteMany({
      token: { $nin: [...new Set(input.masterTokens)] },
      ts: { $lt: cutoff },
    })
    const deleted = Number((res as { deletedCount?: unknown } | null)?.deletedCount ?? 0)
    input.log('desk-marks prune complete', { deleted, cutoff: new Date(cutoff).toISOString() })
    return { deleted }
  } catch (err) {
    input.log('desk-marks prune FAILED', { error: err instanceof Error ? err.message : String(err) })
    return { deleted: 0, skipped: 'error' }
  }
}
