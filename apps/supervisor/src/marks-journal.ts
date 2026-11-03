/**
 * ONE ROW PER BOOK PER 5-MINUTE MARK — the only continuous record of what the
 * supervisor was looking at.
 *
 * The Python desk wrote `data/desk/<TAG>/*.jsonl` and the migration deletes it
 * (spec §9: tar-archived, then removed). This is what replaces it. It is not the
 * decision journal — `desk-engine-decisions` is that, and it only has rows on
 * the marks where something happened. THIS collection has a row on every mark,
 * including the thousands where the book sat inside its band, which is precisely
 * what makes it answer the question a post-mortem actually asks: *what was the
 * book carrying while it did nothing?*
 *
 * ── THE CLOCK IS THE LOCK'S, NOT A SECOND ONE ───────────────────────────────
 * `mark` is `MarkContext.markIndexToday` as the HOST consumed it — handed in,
 * never re-derived here. A journal with its own `MarkClock` would advance a
 * second grid off a second `Date.now()`, and the two would disagree at every
 * boundary: a row filed under mark 12 for a decision the target lock counted as
 * mark 13. The lock's confirmation streak is the desk's defence against a
 * gap-open phantom mark (TCS 2026-06-19), and an audit that cannot line its rows
 * up against that streak cannot check it. One clock, one grid, one truth.
 *
 * ── WHY THE ROW CARRIES `dateIst` WHEN THE SPEC'S FIELD LIST DOES NOT ───────
 * `markIndexToday` counts from the session open, so it repeats every day: mark 12
 * is 10:15 today and 10:15 tomorrow. The uniqueness this collection needs — ONE
 * row per book per mark — cannot be expressed without a date, and expressing it
 * in the index rather than in a caller's memory is what makes a restart at 10:16
 * cost nothing. A duplicate insert is not an error here; it is the second
 * supervisor pass of one mark saying the same thing.
 *
 * ── IT NEVER THROWS ─────────────────────────────────────────────────────────
 * Journalling is the least important thing this process does and it is called
 * from inside the evaluation path. A Mongo blip must cost a row in a history
 * table, never a mark's decision — so every failure is logged and swallowed, the
 * same direction `runtime.ts` and the order journal take.
 */

import type { ForwardSource, Mode } from '@algomaker/desk-engine'
import { isDuplicateKey } from '../../api/src/errors.ts'
import type { HostLog } from './engine-host.ts'

/** THE collection. This file owns the name (spec §9). */
export const BOOK_MARKS_COLLECTION = 'desk-book-marks'

/**
 * What one mark looked like.
 *
 * Every number is the one the ENGINE decided on, not a re-measurement: `spot` is
 * the forward `ChainSnap` carried, `netDelta`/`netGamma`/`band` come off the same
 * `corridor()` call the rules used, and `marginSource` says whether the shift
 * gate could have believed the margin figure at all. A row re-derived from the
 * market afterwards would be a different book.
 */
export interface BookMark {
  readonly tag: string
  readonly mode: Mode
  /** `MarkContext.markIndexToday`: 0 is the 09:15 window. */
  readonly mark: number
  /** IST calendar date. See the header — the mark index alone is not a key. */
  readonly dateIst: string
  readonly ts: number
  readonly spot: number
  /**
   * WHICH FORWARD `spot` IS (six-playbooks spec F1): the weekly's own parity
   * forward, the index carried over its tenor, the future's mid, or the proxy.
   * Two books on one chain are priced off different forwards now, so a spot
   * without its source cannot be compared with anything. Absent on a row from
   * before the field, or from a host nobody told — never a guess.
   */
  readonly forwardSource?: ForwardSource
  readonly netDelta: number
  readonly netGamma: number
  /** The corridor's `allowed` — what |netΔ| was compared against. */
  readonly band: number
  /** Realised plus open, as `guards.ts` computes it for the target lock. */
  readonly totalPnl: number
  readonly marginSource: 'broker' | 'model'
  /** What the engine said on this mark, for a reader with no decision row. */
  readonly reason: string
}

/** The narrow Mongo surface. Same port style as `state-store.ts`. */
export interface MarksCollection {
  insertOne(doc: Record<string, unknown>): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

export class MarksJournal {
  readonly #collection: MarksCollection
  readonly #log: HostLog
  #indexes: Promise<void> | null = null

  constructor(collection: MarksCollection, log: HostLog) {
    this.#collection = collection
    this.#log = log
  }

  /**
   * The uniqueness the header describes, plus the read index the dashboard's
   * per-book history needs.
   *
   * Self-invoking, like `Lease`/`StateStore`: the first `record` builds them if
   * a boot path forgot. Cached, and cleared on failure so the next call retries
   * rather than inheriting a rejection.
   */
  async ensureIndexes(): Promise<void> {
    this.#indexes ??= (async (): Promise<void> => {
      await this.#collection.createIndex(
        { tag: 1, mode: 1, dateIst: 1, mark: 1 },
        { unique: true },
      )
      await this.#collection.createIndex({ tag: 1, mode: 1, ts: -1 })
    })().catch((err: unknown) => {
      this.#indexes = null
      throw err
    })
    await this.#indexes
  }

  /**
   * Journal one mark. Resolves whatever happened — see the header.
   *
   * A duplicate is SILENT: two passes inside one mark (a restart, a second
   * evaluation before the clock moved) are one mark, and saying so in the log
   * every five minutes would train an operator to ignore this line.
   */
  async record(row: BookMark): Promise<void> {
    try {
      await this.ensureIndexes()
      await this.#collection.insertOne({ ...row })
    } catch (err) {
      if (isDuplicateKey(err)) return
      this.#log.warn('the mark journal could not write this row — the decision is unaffected', {
        tag: row.tag,
        mode: row.mode,
        mark: row.mark,
        dateIst: row.dateIst,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
