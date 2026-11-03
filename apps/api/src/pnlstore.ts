/**
 * Persistence for Phase B: the intraday M2M series, the daily rollups, and the
 * read of our own fills that both are computed from.
 *
 * Reached through the same narrow `Database` port as `store.ts`, for the same
 * two reasons: the tree pins Mongo driver 3.7.3 (a decision now, not a LoopBack
 * constraint — see `mongo.ts`), and 3.x ships no types. Nothing here imports
 * the driver.
 *
 * WHERE FILLS COME FROM, which is the load-bearing choice in this file:
 *
 *   `desk-decisions`. It is the only collection that carries `tag`, `mode` and
 *   a `Fill[]` in one document, for BOTH paper and live — which is precisely
 *   what B1 ("one engine for paper and live") requires. `@algomaker/pnl`'s
 *   `PnlFill` is a structural subset of `contract.ts:Fill`, so the array goes
 *   straight in with no adapter to keep in sync.
 *
 *   The order collections were the obvious alternative and are wrong: paper and
 *   live live in three different ones (`desk-paper-trade`, `positional`,
 *   `desk-gateway-orders`), a gateway row exists while it is still PENDING, and
 *   a rejected order sits there looking exactly like a filled one. Booking P&L
 *   on an order that never executed is worse than any amount of convenience.
 *
 *   NOTE for Phase C: `/v1/desk/submit` must land its fills where this read can
 *   see them. If it writes only to the order queue, a hosted strategy's P&L
 *   will read as flat while it is carrying real risk.
 *
 * SNAPSHOTS SURVIVE RESTARTS, which is the whole point (Phase B §5). The legacy
 * `strategyPNL` sat on a memory connector and lost the day every time the
 * process bounced.
 */

import type { DeskMode } from './contract.ts'
import { paperFillEvent, withDecisionContext, withOrderContext } from './rail.ts'
import { COLLECTIONS, type Database } from './store.ts'
import { API_VENUE, venueDayRange, type VenueSpec } from './venue.ts'
import type { ClosingSource, DailyReport, SeriesPoint, StampedFill } from './rollup.ts'

export const PNL_SNAPSHOTS = 'desk-pnl-snapshots'
export const DAILY_REPORTS = 'desk-daily-reports'

/** One persisted M2M point. Contract §3's `/pnl/series` renders these verbatim. */
export interface PnlSnapshot extends SeriesPoint {
  readonly tag: string
  readonly mode: DeskMode
}

/**
 * `tag|mode` — the identity everything in Phase B is keyed by.
 *
 * A tag is not enough on its own: the same strategy can have paper history and
 * be switched to live at lunchtime, and merging the two books would produce a
 * position that never existed.
 */
export function pnlKey(tag: string, mode: DeskMode): string {
  return `${tag}|${mode}`
}

/** Split on the LAST separator, so a tag containing '|' cannot corrupt the mode. */
export function splitPnlKey(key: string): { tag: string; mode: DeskMode } {
  const at = key.lastIndexOf('|')
  const tag = at === -1 ? key : key.slice(0, at)
  const mode = key.slice(at + 1) === 'live' ? 'live' : 'paper'
  return { tag, mode }
}

export interface FillLoad {
  /** Fills grouped by `tag|mode`, each already in book order. */
  readonly byKey: ReadonlyMap<string, StampedFill[]>
  /**
   * Fills we refused to use, by contract.
   *
   * `@algomaker/pnl` throws on a NaN price rather than absorbing it, which is
   * right for a pure engine and fatal for a 15-second job — one corrupt row
   * would blank the whole desk's P&L every tick. They are dropped HERE instead
   * and counted, and a strategy carrying a dropped fill is reported incomplete
   * rather than reported as if the fill never happened.
   */
  readonly malformed: readonly string[]
  /**
   * The same entries, bucketed by `tag|mode` — i.e. WHICH RAIL held the fill we
   * refused.
   *
   * `malformed` above cannot answer that: it is `tag:symbol` strings, and a
   * reader holding both rails at once (`LiveBook`) therefore applied a corrupt
   * PAPER fill to the LIVE row of the same tag, nulling a money total over a
   * simulation's bad row (audit F-53). The flat list is kept because the
   * flatten report and the two route guards that consume it are already scoped
   * to one tag and one mode by their caller, so for them the two are the same
   * list; this map is what a both-rails reader must use.
   */
  readonly malformedByKey: ReadonlyMap<string, readonly string[]>
  /**
   * True when the read hit its cap, so these fills are a SUBSET of the window.
   *
   * Stated rather than implied, because the failure it prevents is silent: a
   * capped read that dropped a strategy's opens returns fewer fills, not an
   * error, and every consumer downstream renders the result as a smaller
   * position or as no position at all. A caller must never be able to mistake
   * "we stopped reading" for "there was nothing to read".
   */
  readonly truncated: boolean
}

export interface FillQuery {
  readonly from: number
  readonly to: number
  readonly tag?: string
  readonly mode?: DeskMode
  readonly limit?: number
}

interface DecisionDoc {
  readonly tag?: unknown
  readonly mode?: unknown
  readonly createdAt?: unknown
  readonly fills?: unknown
}

/**
 * The widest instant a `Date` can hold (ECMA-262: ±100,000,000 days from epoch).
 *
 * `new Date(Number.MAX_SAFE_INTEGER)` is an INVALID DATE, and the unbounded
 * guard reads — the book-delete and seed guards pass `to: MAX_SAFE_INTEGER` on
 * purpose, because a positional book's opens can be any age — would otherwise
 * put an Invalid Date into a Mongo filter. Clamping keeps "no upper bound"
 * meaning exactly that for the Date branch of the range too.
 */
const MAX_DATE_MS = 8.64e15
const asDate = (ms: number): Date => new Date(Math.min(MAX_DATE_MS, Math.max(-MAX_DATE_MS, ms)))

/** A cap, not a page: an unbounded read here would be an OOM at 09:15. */
const MAX_DECISIONS = 50_000
const MAX_SNAPSHOTS = 200_000
const DAY_MS = 24 * 60 * 60 * 1000

/** A decision beside its `createdAt` as an epoch instant, whatever it was stored as. */
interface StampedDoc {
  readonly doc: DecisionDoc
  readonly createdAt: number
}

/**
 * `createdAt` as an epoch instant, from either stamping.
 *
 * `Number(new Date(x))` is already the epoch value, so one coercion covers
 * both — and anything that coerces to `NaN` (a string stamp, a missing field)
 * becomes 0, which is what the fill-level fallback has always done with it. It
 * cannot arrive here in practice: neither typed range matches a string.
 */
function instantOf(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Two newest-first runs into one newest-first stream, by instant.
 *
 * STABLE ON A TIE, in the only sense that can be stable: neither Mongo nor this
 * merge can order two decisions stamped in the SAME millisecond meaningfully,
 * so a tie is settled the same way every time (the numeric run first, in the
 * descending stream) rather than by whichever array happened to be longer.
 * Within one run the order Mongo gave is preserved exactly, which is what keeps
 * a rolled position's average cost reproducible between runs.
 */
function mergeNewestFirst(a: readonly StampedDoc[], b: readonly StampedDoc[]): StampedDoc[] {
  const out: StampedDoc[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    out.push(a[i]!.createdAt >= b[j]!.createdAt ? a[i++]! : b[j++]!)
  }
  while (i < a.length) out.push(a[i++]!)
  while (j < b.length) out.push(b[j++]!)
  return out
}

export class PnlStore {
  readonly #db: Database
  /**
   * Whose day `date` arguments name: an IST date on NSE, a settlement day
   * (12:00 UTC to 12:00 UTC) on DX. Absent is the process venue.
   */
  readonly #venue: VenueSpec

  constructor(db: Database, venue: VenueSpec = API_VENUE) {
    this.#db = db
    this.#venue = venue
  }

  /** `[from, to)` of one venue day — the window every `date` argument here names. */
  dayRange(date: string): { from: number; to: number } {
    return venueDayRange(date, this.#venue)
  }

  /**
   * Indexes this module depends on.
   *
   * `(date, tag, mode)` on the rollups is UNIQUE for the same reason
   * `decisionId` is: the day-end job and a manual repair can both write the
   * same day, and two rows for one strategy-day would make "what did we make on
   * Tuesday?" depend on which one Mongo returned first.
   *
   * The index on `desk-decisions` is created here rather than in `store.ts`
   * because it exists for THIS module's query: the snapshot tick reads a
   * month of decisions every 15 seconds, and without `(tag, mode, createdAt)`
   * every tick is a collection scan.
   */
  async ensureIndexes(): Promise<void> {
    await this.#db.collection(PNL_SNAPSHOTS).createIndex({ tag: 1, mode: 1, ts: 1 })
    // The prune deletes by time range across every strategy at once.
    await this.#db.collection(PNL_SNAPSHOTS).createIndex({ ts: 1 })
    await this.#db
      .collection(DAILY_REPORTS)
      .createIndex({ date: 1, tag: 1, mode: 1 }, { unique: true })
    await this.#db.collection(DAILY_REPORTS).createIndex({ date: -1 })
    await this.#db.collection(COLLECTIONS.decisions).createIndex({ tag: 1, mode: 1, createdAt: 1 })
    /**
     * The index the 15-SECOND SNAPSHOT actually queries on.
     *
     * `livePnl` reads a month of decisions filtered by `{createdAt: range,
     * mode}` with NO tag, twice per tick (once per mode). `(tag, mode,
     * createdAt)` above cannot serve that at all — its leading field is absent
     * from the filter — so every tick was a full collection scan of the busiest
     * collection in the system, four times a minute, forever.
     *
     * Equality first, then the range and the sort it shares: `(mode,
     * createdAt)`.
     */
    await this.#db.collection(COLLECTIONS.decisions).createIndex({ mode: 1, createdAt: 1 })
    /**
     * The window read WITHOUT a mode. `LiveBook` reads both rails in one
     * `loadFills` (livebook.ts), as do the rollup and the prune, and neither
     * index above can serve a filter with no `tag` and no `mode` — each was a
     * collection scan plus an in-memory sort: 12,021 scans of ~10,900 rows in
     * the 99 hours to 2026-10-19 (`$collStats.queryExecStats`).
     */
    await this.#db.collection(COLLECTIONS.decisions).createIndex({ createdAt: 1 })
  }

  // ----------------------------------------------------------------- fills

  /**
   * Our own fills over a time range, grouped by `tag|mode`.
   *
   * Ordered by the decision's `createdAt` and then by position within the
   * decision's own array. Average cost is path-dependent, so the order is part
   * of the answer — and re-sorting on a per-fill timestamp would shuffle two
   * fills stamped in the same millisecond and silently change the average.
   *
   * THE CAP IS APPLIED FROM THE NEWEST END, and that is not a preference.
   * `.sort({createdAt: 1}).limit(n)` keeps the OLDEST n and silently discards
   * everything after them — so on a desk that has written more than the cap
   * inside the lookback (`livePnl` and `rollupDate` both read a month, unscoped
   * by tag), the decisions thrown away are TODAY'S. P&L and positions then read
   * flat with no error anywhere. Reading newest-first and reversing keeps the
   * same ascending answer while making the discarded end the one nobody is
   * looking at, and `truncated` says it happened either way.
   *
   * Reversing only affects the relative order of decisions stamped in the SAME
   * millisecond, which Mongo does not order deterministically in either
   * direction; a roll's two fills live in one document and so cannot be split.
   *
   * TWO QUERIES, ONE STREAM, and that is the whole reason this method is longer
   * than a find: `createdAt` in this collection is genuinely BOTH a number and
   * a `Date` (see the filter note below), and MONGO SORTS BY BSON TYPE FIRST.
   * One `$or` query sorted by `createdAt` therefore returns two type-bracketed
   * runs — every numeric decision, then every Date one — which is not
   * chronological order and only looks like it while a window holds one type.
   * Average cost is path-dependent, so an order that never happened is a
   * realised P&L that never happened. The two ranges are read separately, each
   * already sorted by the instant WITHIN its type, and merged on the NORMALISED
   * instant here.
   *
   * That normalisation is not the re-sort this docstring forbids above. What
   * must never be re-sorted is the FILL's own `ts` — a per-fill stamp shuffles
   * two fills of one roll. What is sorted here is the DECISION's `createdAt`,
   * the same value Mongo was asked to order by, read as an epoch instant
   * instead of as a BSON type; fills keep their position inside their document
   * exactly as before.
   */
  async loadFills(q: FillQuery): Promise<FillLoad> {
    /**
     * BOTH TYPES, because Mongo brackets comparisons by BSON type (audit F-53).
     *
     * `{createdAt: {$gte: <number>}}` matches numbers ONLY. It does not match a
     * Date, and it does not error either — the decision simply is not in the
     * result. This collection is written by more than this process (the Python
     * desk, and every hand-repair through the shell), and a driver stamping
     * `createdAt` as a Date is the ordinary case, not a corruption. Those
     * decisions were invisible to P&L, to positions, and to every report built
     * on this read: a real leg presented as flat, with nothing anywhere saying
     * why.
     *
     * TWO TYPED RANGES rather than a normalising migration: the rows belong to
     * other writers, so the reader is the honest place to be tolerant. As two
     * queries rather than one `$or`, the index `(mode, createdAt)` serves each
     * one on its own — equality prefix, then the range AND the sort it shares,
     * which is the access pattern the index was built for — and the branch that
     * matches nothing costs an empty scan of that type's key range.
     *
     * No decision can appear in both: a value is a number or a Date, never
     * both, so the merge below cannot double-count one.
     */
    const scope: Record<string, unknown> = {}
    if (q.tag !== undefined) scope['tag'] = q.tag
    if (q.mode !== undefined) scope['mode'] = q.mode

    const limit = q.limit ?? MAX_DECISIONS
    /**
     * SEQUENTIAL, not `Promise.all`. The same trade `routes/system.ts` and the
     * positions comparison make: the moment this read matters most is the
     * moment the database is least able to serve two concurrent scans of the
     * busiest collection in the system.
     */
    const numeric = await this.#readDecisions(
      { ...scope, createdAt: { $gte: q.from, $lt: q.to } },
      limit,
    )
    const dated = await this.#readDecisions(
      { ...scope, createdAt: { $gte: asDate(q.from), $lt: asDate(q.to) } },
      limit,
    )

    /**
     * `>= limit` on EITHER branch means that branch may itself have been cut by
     * Mongo, and a merged stream longer than the cap loses its tail here. Both
     * are truncation, and both must say so — a partial read that reads as a
     * small book is the failure this flag exists to prevent.
     */
    const capped = numeric.length >= limit || dated.length >= limit
    const merged = mergeNewestFirst(numeric, dated)
    const truncated = capped || merged.length > limit
    // The cap applies to the MERGED stream, so "the newest N" means the newest
    // N of the DAY — not the newest N of each stamping, which on a repair day
    // would keep old numeric rows and discard this afternoon's Date ones.
    const docs = merged.slice(0, limit).reverse()

    const byKey = new Map<string, StampedFill[]>()
    const malformed: string[] = []
    const malformedByKey = new Map<string, string[]>()
    for (const { doc, createdAt } of docs) {
      const tag = typeof doc.tag === 'string' ? doc.tag : ''
      if (tag === '') continue
      const mode: DeskMode = doc.mode === 'live' ? 'live' : 'paper'
      const raw = Array.isArray(doc.fills) ? (doc.fills as unknown[]) : []
      const key = pnlKey(tag, mode)
      for (const item of raw) {
        // A reconciler-zeroed fill contributes nothing and is NOT malformed.
        if (isCorrectedNoop(item)) continue
        const fill = toStampedFill(item, createdAt)
        if (fill === null) {
          const described = describeBadFill(item, tag)
          malformed.push(described)
          const bad = malformedByKey.get(key)
          if (bad === undefined) malformedByKey.set(key, [described])
          else bad.push(described)
          continue
        }
        const list = byKey.get(key)
        if (list === undefined) byKey.set(key, [fill])
        else list.push(fill)
      }
    }
    return { byKey, malformed, malformedByKey, truncated }
  }

  /**
   * One typed range, NEWEST FIRST and capped — the read `loadFills` runs twice.
   *
   * Each document is paired with its `createdAt` read as an epoch instant right
   * here, so the merge that follows never has to look at the BSON type again
   * and the rest of the method sees one kind of value.
   */
  async #readDecisions(filter: Record<string, unknown>, limit: number): Promise<StampedDoc[]> {
    const docs = await this.#db
      .collection<DecisionDoc>(COLLECTIONS.decisions)
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
    return docs.map((doc) => ({ doc, createdAt: instantOf(doc.createdAt) }))
  }

  // ------------------------------------------------------------- snapshots

  /** Append M2M points. One insert per tick, all strategies together. */
  async writeSnapshots(rows: readonly PnlSnapshot[]): Promise<void> {
    if (rows.length === 0) return
    await this.#db.collection<PnlSnapshot>(PNL_SNAPSHOTS).insertMany(rows)
  }

  /** The intraday series, oldest first — the order a chart wants to plot. */
  async series(q: {
    from: number
    to: number
    tag?: string
    mode?: DeskMode
    limit?: number
  }): Promise<PnlSnapshot[]> {
    const filter: Record<string, unknown> = { ts: { $gte: q.from, $lt: q.to } }
    if (q.tag !== undefined) filter['tag'] = q.tag
    if (q.mode !== undefined) filter['mode'] = q.mode
    const docs = await this.#db
      .collection<Record<string, unknown>>(PNL_SNAPSHOTS)
      .find(filter)
      .sort({ ts: 1 })
      .limit(q.limit ?? MAX_SNAPSHOTS)
      .toArray()
    return docs.map(toSnapshot)
  }

  /** A whole IST day's series, grouped by `tag|mode`. What the rollup reads. */
  async seriesByKey(date: string): Promise<Map<string, PnlSnapshot[]>> {
    const { from, to } = this.dayRange(date)
    const out = new Map<string, PnlSnapshot[]>()
    for (const s of await this.series({ from, to })) {
      const key = pnlKey(s.tag, s.mode)
      const list = out.get(key)
      if (list === undefined) out.set(key, [s])
      else list.push(s)
    }
    return out
  }

  async countSnapshots(date: string): Promise<number> {
    const { from, to } = this.dayRange(date)
    return await this.#db.collection(PNL_SNAPSHOTS).countDocuments({ ts: { $gte: from, $lt: to } })
  }

  async deleteSnapshots(date: string): Promise<void> {
    const { from, to } = this.dayRange(date)
    await this.#db.collection(PNL_SNAPSHOTS).deleteMany({ ts: { $gte: from, $lt: to } })
  }

  // --------------------------------------------------------------- rollups

  /**
   * Write one strategy-day. Upsert, because the repair path rewrites a day the
   * scheduled job already covered and must land on the same row rather than a
   * second one.
   */
  async writeReport(r: DailyReport): Promise<void> {
    await this.#db
      .collection(DAILY_REPORTS)
      .updateOne(
        { date: r.date, tag: r.tag, mode: r.mode },
        { $set: { ...r } },
        { upsert: true },
      )
  }

  async reportsFor(date: string): Promise<DailyReport[]> {
    const docs = await this.#db
      .collection<Record<string, unknown>>(DAILY_REPORTS)
      .find({ date })
      .sort({ tag: 1 })
      .limit(MAX_DECISIONS)
      .toArray()
    return docs.map(toReport)
  }

  /**
   * One strategy's stored rollups across a DATE RANGE, oldest first.
   *
   * Both bounds inclusive, and compared as `YYYY-MM-DD` strings — which is only
   * safe because that format sorts lexicographically in the same order it sorts
   * chronologically. Any other date format here would silently return the wrong
   * window rather than failing.
   *
   * Reads only what was WRITTEN at day end. It deliberately does not recompute
   * missing days from fills the way the single-day endpoint does: a three-month
   * range would mean replaying every fill in the window on every page load, and
   * the caller is looking for a shape over time rather than an exact figure for
   * one day. Days with no rollup are simply absent, and the route says how many.
   */
  async reportHistory(input: {
    tag: string
    mode: DeskMode
    from: string
    to: string
  }): Promise<DailyReport[]> {
    const docs = await this.#db
      .collection<Record<string, unknown>>(DAILY_REPORTS)
      .find({ tag: input.tag, mode: input.mode, date: { $gte: input.from, $lte: input.to } })
      .sort({ date: 1 })
      .limit(MAX_DECISIONS)
      .toArray()
    return docs.map(toReport)
  }

  /**
   * SEVERAL tags' rollups across a range, ONE ROW PER DAY — a series or a
   * whole variant (`book-series.ts`). Same window rules as `reportHistory`;
   * the summing and the null discipline are `aggregateReportDays`.
   *
   * `expiries` maps each tag to its book's contract expiry, which is what
   * marks a day as an expiry day.
   */
  async reportHistoryForTags(input: {
    tags: readonly string[]
    mode: DeskMode
    from: string
    to: string
    expiries: Readonly<Record<string, string>>
    /** tag -> its series row's symbol. Given only by the variant view; adds `bySymbol`. */
    symbols?: Readonly<Record<string, string>>
  }): Promise<AggregatedDay[]> {
    if (input.tags.length === 0) return []
    const docs = await this.#db
      .collection<Record<string, unknown>>(DAILY_REPORTS)
      .find({ tag: { $in: [...input.tags] }, mode: input.mode, date: { $gte: input.from, $lte: input.to } })
      .sort({ date: 1 })
      .limit(MAX_DECISIONS)
      .toArray()
    return aggregateReportDays(docs.map(toReport), input.expiries, input.symbols)
  }

  /** tag -> the first and last day it reported on one rail. The series list's dates. */
  async reportSpans(mode: DeskMode): Promise<Map<string, { first: string; last: string }>> {
    const docs = await this.#db
      .collection<Record<string, unknown>>(DAILY_REPORTS)
      .find({ mode })
      .sort({ date: 1 })
      .limit(MAX_DECISIONS)
      .toArray()
    const spans = new Map<string, { first: string; last: string }>()
    for (const d of docs) {
      const tag = d['tag']
      const date = d['date']
      if (typeof tag !== 'string' || tag === '' || typeof date !== 'string') continue
      const span = spans.get(tag)
      if (span === undefined) spans.set(tag, { first: date, last: date })
      else {
        if (date < span.first) span.first = date
        if (date > span.last) span.last = date
      }
    }
    return spans
  }

  /**
   * Every tag that has been rolled up — on one rail when `mode` is given,
   * on either when it is not. Populates the report picker.
   */
  async reportedTags(mode?: DeskMode): Promise<string[]> {
    const docs = await this.#db
      .collection<Record<string, unknown>>(DAILY_REPORTS)
      .find(mode === undefined ? {} : { mode })
      .sort({ tag: 1 })
      .limit(MAX_DECISIONS)
      .toArray()
    const seen = new Set<string>()
    for (const d of docs) {
      const tag = d['tag']
      if (typeof tag === 'string' && tag !== '') seen.add(tag)
    }
    return [...seen].sort()
  }

  /** `tag|mode` keys that already have a rollup for the day. The prune's guard. */
  async rolledUpKeys(date: string): Promise<Set<string>> {
    const out = new Set<string>()
    for (const r of await this.reportsFor(date)) out.add(pnlKey(r.tag, r.mode))
    return out
  }

  /**
   * `tag|mode` keys with intraday detail for the day.
   *
   * Read off the snapshots rather than counted, because the prune's question is
   * "is every strategy whose detail I am about to delete already summarised?",
   * and only the detail itself can answer that.
   */
  async snapshotKeys(date: string): Promise<Set<string>> {
    const { from, to } = this.dayRange(date)
    const out = new Set<string>()
    for (const s of await this.series({ from, to })) out.add(pnlKey(s.tag, s.mode))
    return out
  }

  // ---------------------------------------------------------------- dates

  /**
   * Days with activity, newest first — the reports page's date picker.
   *
   * The union of days that traded and days that were rolled up. A day the
   * rollup job missed still appears, which is how an operator finds it in order
   * to repair it; showing only rolled-up days would hide exactly the days that
   * need attention.
   */
  async activityDates(limit: number): Promise<string[]> {
    const dates = new Set<string>()
    const reports = await this.#db
      .collection<Record<string, unknown>>(DAILY_REPORTS)
      .find({})
      .sort({ date: -1 })
      .limit(limit * 20)
      .toArray()
    for (const r of reports) {
      const d = r['date']
      if (typeof d === 'string') dates.add(d)
    }
    const decisions = await this.#db
      .collection<DecisionDoc>(COLLECTIONS.decisions)
      .find({})
      .sort({ createdAt: -1 })
      .limit(MAX_DECISIONS)
      .toArray()
    for (const d of decisions) {
      const at = Number(d.createdAt)
      if (Number.isFinite(at) && at > 0) dates.add(this.#venue.dayKey(at))
    }
    return [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, limit)
  }

  /** IST days strictly older than `keepDays` that still hold snapshots. */
  async pruneCandidates(nowMs: number, keepDays: number): Promise<string[]> {
    const cutoff = nowMs - keepDays * DAY_MS
    const docs = await this.#db
      .collection<Record<string, unknown>>(PNL_SNAPSHOTS)
      .find({ ts: { $lt: cutoff } })
      .sort({ ts: 1 })
      .limit(MAX_SNAPSHOTS)
      .toArray()
    const days = new Set<string>()
    for (const d of docs) {
      const ts = Number(d['ts'])
      if (Number.isFinite(ts)) days.add(this.#venue.dayKey(ts))
    }
    return [...days].sort()
  }

  // -------------------------------------------------------- order journal

  /**
   * The day's order log, newest first. Contract §4's `/reports/orders`.
   *
   * TWO SOURCES, ONE FEED (2026-07-28). `desk-order-events` holds live routing
   * and REFUSALS FROM BOTH MODES; the paper rail's own fills live in
   * `desk-paper-trade`. Reading only the first is why this endpoint answered
   * "0 events" in paper for a desk that had traded all morning.
   *
   * `mode` is not optional in effect: without it a paper refusal renders under
   * LIVE, which is a rejection an operator would go hunting for on a rail that
   * never saw it. An event is PAPER iff it says so in `detail.mode`, and every
   * writer stamps it — `apps/order-gateway`'s journal included, as of the D9
   * cutover. It used to carry no such field and be "live by construction",
   * which stopped being true when the engine's paper orders started going
   * through its queue (D14): those rows fell on the LIVE side of this filter
   * and were missing from the paper one. `$ne 'paper'` still matches every row
   * written before the stamp existed, all of which are live.
   *
   * `from` WIDENS THE WINDOW BACKWARDS, and is what a POSITIONAL book needs.
   * A hosted strategy is intraday by contract, so one day is its whole life and
   * `date` alone is the right window; a book registered in `desk-books-registry`
   * is held for weeks, and its opening trade — the one an operator most wants to
   * see — falls outside every day but the first. Absent, this reads exactly the
   * single IST day it always did.
   */
  async orderEvents(q: {
    date: string
    /** The FIRST IST day in the window, `YYYY-MM-DD`. Defaults to `date`. */
    from?: string
    tag?: string
    mode?: DeskMode
    failuresOnly?: boolean
    limit?: number
  }): Promise<Record<string, unknown>[]> {
    const { to } = this.dayRange(q.date)
    const from = this.dayRange(q.from ?? q.date).from
    const limit = q.limit ?? 500
    const filter: Record<string, unknown> = { ts: { $gte: from, $lt: to } }
    if (q.tag !== undefined) filter['tag'] = q.tag
    if (q.failuresOnly === true) filter['ok'] = false
    if (q.mode === 'paper') filter['detail.mode'] = 'paper'
    else if (q.mode === 'live') filter['detail.mode'] = { $ne: 'paper' }
    const events = await this.#db
      .collection<Record<string, unknown>>(COLLECTIONS.orderEvents)
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray()
    // A paper FILL is never a failure, so `failuresOnly` answers itself here —
    // and skipping the read keeps "show me what went wrong" as cheap as it was.
    //
    // `withOrderContext` first: nothing on the live rail journals a direction
    // or its order's intent, so the Side column was `—` on every live row ever
    // written. See its docstring.
    //
    // `withDecisionContext` after it: the order journal says what happened to
    // an order, never why it was placed — the supervisor's trigger and reason
    // are what let the reports log read "Open", "Add", "EOD flatten".
    if (q.mode !== 'paper' || q.failuresOnly === true) {
      return await withDecisionContext(this.#db, await withOrderContext(this.#db, events))
    }

    const trades: Record<string, unknown> = {
      order_timestamp: { $gte: new Date(from), $lt: new Date(to) },
    }
    if (q.tag !== undefined) trades['tag'] = q.tag
    const fills = await this.#db
      .collection<Record<string, unknown>>(COLLECTIONS.paperTrade)
      .find(trades)
      .sort({ order_timestamp: -1 })
      .limit(limit)
      .toArray()
    // Re-sorted across BOTH sources, then capped once: taking the newest `limit`
    // of each and concatenating would interleave two truncated tails and drop
    // recent rows from the busier one.
    return await withDecisionContext(this.#db, await withOrderContext(
      this.#db,
      [...events, ...fills.map(paperFillEvent)]
        .sort((a, b) => Number(b['ts']) - Number(a['ts']))
        .slice(0, limit),
    ))
  }
}

// --------------------------------------------------------------- coercion

/**
 * A stored fill, validated to exactly what the engine will accept.
 *
 * `ts` falls back to the decision's `createdAt`: the fill's own stamp is what
 * `applyActions` wrote, but a hand-repaired document might not have one, and a
 * fill with no timestamp would otherwise land at epoch 0 and be filed under
 * 1970 — outside every window, i.e. silently dropped from P&L.
 *
 * EXPORTED FOR `LiveBook`, which validates a fill handed to it by the order path
 * with this same function. A second validator would mean an in-memory position
 * and the one the reconcile rebuilds could disagree about which fills were
 * usable — and the reconcile would then report drift that is really just two
 * different opinions about a corrupt row.
 */
/**
 * A fill the reconciler corrected DOWN TO ZERO — a REJECTED/never-placed order
 * whose booking was undone (`reconcile-live.ts`).
 *
 * It is a legitimate no-op, not a corrupt row: `qty: 0` is the CORRECTION, and
 * the `corrected` stamp is what distinguishes it from a hand-mangled document.
 * Filing it under `malformed` made `flattenIsFlat` refuse `flat` for the tag's
 * whole window — the reconciler undoing a phantom leg then blocked the very
 * flatten that would have confirmed the book clean.
 */
export function isCorrectedNoop(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const f = value as Record<string, unknown>
  return typeof f['corrected'] === 'object' && f['corrected'] !== null && Number(f['qty']) === 0
}

export function toStampedFill(value: unknown, createdAt: number): StampedFill | null {
  if (typeof value !== 'object' || value === null) return null
  const f = value as Record<string, unknown>
  const tradingsymbol = f['tradingsymbol']
  const side = f['side']
  const qty = Number(f['qty'])
  const price = Number(f['price'])
  if (typeof tradingsymbol !== 'string' || tradingsymbol === '') return null
  if (side !== 'Buy' && side !== 'Sell') return null
  if (!Number.isFinite(qty) || qty <= 0) return null
  if (!Number.isFinite(price) || price < 0) return null
  // The venue's charge, when the fill row carries one (Delta). A malformed one
  // is dropped rather than poisoning realised: absent is zero, and the fill
  // itself is still good.
  const rawFee = Number(f['fee'])
  const fee = Number.isFinite(rawFee) && rawFee > 0 ? rawFee : undefined
  const rawTs = Number(f['ts'])
  const ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : createdAt
  // `op` is passed through, not validated away: it is the ONLY signal a
  // consumer has that a reconstruction window may have cut the opens off a
  // position. Unrecognised values are dropped rather than coerced.
  const rawOp = f['op']
  const op =
    rawOp === 'open' || rawOp === 'close' || rawOp === 'roll' || rawOp === 'resize'
      ? rawOp
      : undefined
  return {
    tradingsymbol,
    side,
    qty,
    price,
    ts: Number.isFinite(ts) ? ts : 0,
    ...(op === undefined ? {} : { op }),
    ...(fee === undefined ? {} : { fee }),
  }
}

export function describeBadFill(value: unknown, tag: string): string {
  const f = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const sym = typeof f['tradingsymbol'] === 'string' ? f['tradingsymbol'] : '<no symbol>'
  return `${tag}:${sym}`
}

function toSnapshot(doc: Record<string, unknown>): PnlSnapshot {
  return {
    tag: String(doc['tag'] ?? ''),
    mode: doc['mode'] === 'live' ? 'live' : 'paper',
    ts: Number(doc['ts'] ?? 0),
    realised: Number(doc['realised'] ?? 0),
    unrealised: numberOrNull(doc['unrealised']),
    total: numberOrNull(doc['total']),
  }
}

/** One IST day of a series or variant: its tags' rollups summed. */
export interface AggregatedDay {
  readonly date: string
  readonly mode: DeskMode
  readonly realised: number
  /** Null when ANY contributing tag's total is null — never a partial sum. */
  readonly total: number | null
  readonly maxProfit: number | null
  readonly maxLoss: number | null
  readonly orderCount: number
  readonly closingPositions: number
  /** The worst of the day: `none` over `snapshot` over `marks`. */
  readonly closingSource: ClosingSource
  /** The tags that reported this day, sorted — each one's order log is a link. */
  readonly tags: readonly string[]
  /** A contributing book's contract expired on this day. */
  readonly expiryDay: boolean
  /** Which of `tags` expired on this day. */
  readonly expiryTags: readonly string[]
  /**
   * The day split per symbol — present only when the caller gave a symbol map
   * (the variant view). A symbol that did not report that day is ABSENT, not 0.
   */
  readonly bySymbol?: Readonly<Record<string, SymbolDay>>
}

/** One symbol's share of an aggregated day. */
export interface SymbolDay {
  readonly realised: number
  /** Null when ANY of this symbol's tags that day has a null total. */
  readonly total: number | null
  /** This symbol's contributing tags, sorted. */
  readonly tags: readonly string[]
}

const CLOSING_RANK: Record<ClosingSource, number> = { marks: 0, snapshot: 1, none: 2 }

/**
 * Sum tag-days into days. Pure.
 *
 * THE NULL DISCIPLINE, per field: `realised` and the counts are sums of known
 * numbers and always add up; `total`, `maxProfit` and `maxLoss` go NULL for the
 * whole day the moment one contributing tag could not produce them. A day on
 * which SENSEX was unmarked is not "NIFTY's number" — it is a number nobody
 * knows, and the page must say so rather than show the half it has.
 *
 * Summing the extremes is an approximation (two books' worst moments need not
 * coincide), which is stated rather than hidden: it is the bound the page has.
 */
export function aggregateReportDays(
  reports: readonly DailyReport[],
  expiries: Readonly<Record<string, string>>,
  /**
   * tag -> symbol, from the series rows. When given, each day also carries
   * `bySymbol`. A tag missing from the map is filed under ITS OWN NAME as the
   * symbol key — a tag's text is never parsed for a symbol.
   */
  symbols?: Readonly<Record<string, string>>,
): AggregatedDay[] {
  const byDate = new Map<string, DailyReport[]>()
  for (const r of reports) {
    const day = byDate.get(r.date)
    if (day === undefined) byDate.set(r.date, [r])
    else day.push(r)
  }
  const addNullable = (acc: number | null, v: number | null): number | null =>
    acc === null || v === null ? null : acc + v
  const out: AggregatedDay[] = []
  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!
    let realised = 0
    let total: number | null = 0
    let maxProfit: number | null = 0
    let maxLoss: number | null = 0
    let orderCount = 0
    let closingPositions = 0
    let closingSource: ClosingSource = 'marks'
    for (const r of day) {
      realised += r.realised
      total = addNullable(total, r.total)
      maxProfit = addNullable(maxProfit, r.maxProfit)
      maxLoss = addNullable(maxLoss, r.maxLoss)
      orderCount += r.orderCount
      closingPositions += r.closingPositions
      if (CLOSING_RANK[r.closingSource] > CLOSING_RANK[closingSource]) closingSource = r.closingSource
    }
    const tags = [...new Set(day.map((r) => r.tag))].sort()
    const expiryTags = tags.filter((t) => expiries[t] === date)
    let bySymbol: Record<string, SymbolDay> | undefined
    if (symbols !== undefined) {
      const acc = new Map<string, { realised: number; total: number | null; tags: Set<string> }>()
      for (const r of day) {
        const key = Object.hasOwn(symbols, r.tag) ? symbols[r.tag]! : r.tag
        const a = acc.get(key)
        if (a === undefined) acc.set(key, { realised: r.realised, total: r.total, tags: new Set([r.tag]) })
        else {
          a.realised += r.realised
          a.total = addNullable(a.total, r.total)
          a.tags.add(r.tag)
        }
      }
      bySymbol = {}
      for (const key of [...acc.keys()].sort()) {
        const a = acc.get(key)!
        bySymbol[key] = { realised: a.realised, total: a.total, tags: [...a.tags].sort() }
      }
    }
    out.push({
      date,
      mode: day[0]!.mode,
      realised,
      total,
      maxProfit,
      maxLoss,
      orderCount,
      closingPositions,
      closingSource,
      tags,
      expiryDay: expiryTags.length > 0,
      expiryTags,
      ...(bySymbol === undefined ? {} : { bySymbol }),
    })
  }
  return out
}

function toReport(doc: Record<string, unknown>): DailyReport {
  return {
    date: String(doc['date'] ?? ''),
    tag: String(doc['tag'] ?? ''),
    mode: doc['mode'] === 'live' ? 'live' : 'paper',
    realised: Number(doc['realised'] ?? 0),
    // A row written before fees were recorded was gross and fee-free.
    gross: Number(doc['gross'] ?? doc['realised'] ?? 0),
    fees: Number(doc['fees'] ?? 0),
    total: numberOrNull(doc['total']),
    maxProfit: numberOrNull(doc['maxProfit']),
    maxLoss: numberOrNull(doc['maxLoss']),
    orderCount: Number(doc['orderCount'] ?? 0),
    closingPositions: Number(doc['closingPositions'] ?? 0),
    snapshots: Number(doc['snapshots'] ?? 0),
    closingSource:
      doc['closingSource'] === 'marks' || doc['closingSource'] === 'snapshot'
        ? doc['closingSource']
        : 'none',
    writtenAt: Number(doc['writtenAt'] ?? 0),
  }
}

/**
 * A stored null stays null. `Number(null)` is 0, and 0 is the one value this
 * whole module exists to keep distinct from "could not be computed".
 */
function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
