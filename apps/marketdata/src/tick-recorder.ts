/**
 * THE TAPE — one document per tick, for the tokens a book actually watches.
 *
 * `desk-marks` is not this. That collection is a 60-second upsert-IN-PLACE of
 * one "last known" document per token and its header in `main.ts` says DISPLAY
 * ONLY: it answers "what is this worth right now?", never "what did it do?".
 * Nothing else in the tree keeps a time series, so a controller that adds on a
 * new peak and cuts on a drawdown could be written but never replayed, and every
 * constant in it would be a number nobody could check against a real session.
 *
 * ── IT IS OFF UNLESS ASKED FOR ──────────────────────────────────────────────
 * `DESK_RECORD_TICKS=1` or nothing happens: no collection is named, no index is
 * built, no `md.tick` subscriber is added. `createTickRecorder` returns `null`
 * rather than a no-op recorder precisely so the disabled case is structural —
 * the host has nothing to subscribe, so the feed's hot path is untouched rather
 * than merely cheap.
 *
 * ── IT MUST NEVER COST THE FEED ─────────────────────────────────────────────
 * This process holds the ONE Kite login. Anything that can kill it takes the
 * whole desk's data with it, and every consumer's health check then reports "the
 * feed is not alive" rather than "market-data is gone" — the failure lands in
 * somebody else's log. So the tape defends the feed three ways:
 *
 *   1. `onTick` only buffers. The write happens on a timer, off the hot path.
 *   2. The buffer has a HARD CAP. Mongo stalls; the feed does not. An unbounded
 *      buffer plus a ten-minute stall is an OOM, so past `MAX_BUFFERED_TICKS`
 *      the buffer is dropped outright and the alarm is logged ONCE. A gap in a
 *      research tape costs nothing that a restart does not already cost.
 *   3. A failed insert is logged and swallowed, never rethrown and never
 *      re-queued. `flush()` is driven by a `void`-ed timer, so a rejection here
 *      would be an unhandled one — which `installCrashGuards` turns into a
 *      process exit for the whole host.
 *
 * ── ABSENT IS NEVER ZERO ────────────────────────────────────────────────────
 * `tickPayload` omits `bid`/`ask` when the packet has no two-sided book rather
 * than inventing zeros. A row on the tape has a FIXED shape so a replay can read
 * a column without asking whether the schema moved, so the absence is carried as
 * an explicit `null`. Zero is a price; null is the absence of one.
 */

/** THE collection. This file owns the name. */
export const TICK_COLLECTION = 'desk-ticks'

/** Default batching window. Five seconds of a chain is one modest insert. */
export const DEFAULT_TICK_FLUSH_MS = 5000

/**
 * The most rows held in memory before the buffer is dropped.
 *
 * A full NIFTY + SENSEX weekly chain is a few thousand tokens; at the ~1 Hz Kite
 * publishes, 50k rows is roughly ten seconds of the busiest feed this desk has
 * ever carried — i.e. it is never reached by normal batching and is only ever
 * reached by a Mongo that has stopped answering.
 */
export const MAX_BUFFERED_TICKS = 50_000

/** 30 days. Long enough to tune a controller against, short enough to forget. */
export const TICK_TTL_SECONDS = 30 * 24 * 60 * 60

/** Named so an operator can find and drop it when its options need to change. */
export const TICK_TTL_INDEX = 'desk_ticks_ttl'

/** One `md.tick` frame off the bus — the fields the tape keeps. */
export interface MdTick {
  readonly token: number
  readonly price: number
  readonly ts: number
  readonly bid?: number | undefined
  readonly ask?: number | undefined
}

/**
 * One row on the tape.
 *
 * `ts` is the epoch-ms the replay does arithmetic on. `tsDate` is the SAME
 * instant as a BSON Date and exists only to anchor the TTL index: Mongo expires
 * documents whose indexed field is a Date, and a TTL index on a number builds
 * cleanly, reports healthy and deletes nothing forever. The gateway's
 * `updatedAtDate` (`apps/order-gateway/src/session-store.ts`) is the same split
 * for the same reason.
 */
export interface TickRow {
  readonly token: number
  readonly ts: number
  readonly tsDate: Date
  readonly price: number
  readonly bid: number | null
  readonly ask: number | null
}

/** The narrow Mongo surface this needs. Same port style as `sync-runner.ts`. */
export interface TickCollection {
  insertMany(docs: readonly TickRow[], options?: { ordered?: boolean }): Promise<unknown>
  createIndex(
    spec: Record<string, 1 | -1>,
    options?: { expireAfterSeconds?: number; name?: string },
  ): Promise<unknown>
}

export interface TickDb {
  collection(name: string): TickCollection
}

/** `main.ts`'s logger shape. */
export type TickLog = (msg: string, ctx?: Record<string, unknown>) => void

export interface TickRecorderDeps {
  readonly db: TickDb
  /**
   * The tokens worth taping, RE-ASKED on every tick rather than captured once:
   * the host re-plans its subscriptions every 30 seconds, so a book that rolls
   * to next week stops watching this week's strikes mid-session.
   */
  tokens(): ReadonlySet<number>
  /** Fallback clock for a frame that arrived without a usable timestamp. */
  now(): number
  readonly flushMs?: number | undefined
  readonly log?: TickLog | undefined
}

/**
 * THE GATE. Exactly `'1'` — not "truthy".
 *
 * `DESK_RECORD_TICKS=0` and `DESK_RECORD_TICKS=false` are both an operator
 * saying no, and a gate that read either as yes would tape a production session
 * nobody asked for. The tree's other opt-IN flags read the same way.
 */
export function tickRecordingEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['DESK_RECORD_TICKS'] === '1'
}

/**
 * The recorder, or `null` when the tape is switched off.
 *
 * The null is the point: the caller has nothing to subscribe, so a disabled tape
 * adds no `md.tick` handler at all and the feed behaves exactly as it did before
 * this file existed.
 */
export function createTickRecorder(
  deps: TickRecorderDeps & { readonly env: Readonly<Record<string, string | undefined>> },
): TickRecorder | null {
  return tickRecordingEnabled(deps.env) ? new TickRecorder(deps) : null
}

/**
 * Build the tape's indexes, and DO NOT take the host down if Mongo refuses.
 *
 * The F-42 boot-safety pattern (`ensureSessionTtlIndex`, `ensureClientOrderIdUnique`):
 * an index is a guard against a future problem, and this runs on the boot path
 * of the process that holds the only Kite login. An existing index on the same
 * field with different options is refused outright by Mongo (code 85/86), and
 * that is a tidy-up for an operator, not a reason for the desk to have no feed.
 * Idempotent: re-running with identical options is a no-op.
 */
export async function ensureTickIndexes(db: TickDb, log: TickLog): Promise<boolean> {
  const col = db.collection(TICK_COLLECTION)
  try {
    // How a replay reads one instrument's session, in order.
    await col.createIndex({ token: 1, ts: 1 })
    await col.createIndex(
      { tsDate: 1 },
      { expireAfterSeconds: TICK_TTL_SECONDS, name: TICK_TTL_INDEX },
    )
    return true
  } catch (err) {
    log(
      `could not build the indexes on '${TICK_COLLECTION}' — the tape will still be written but ` +
        'it will not be indexed and it will not expire on its own. Booting anyway; drop the ' +
        `conflicting index and restart to fix it (db.getCollection('${TICK_COLLECTION}').getIndexes()).`,
      { error: err instanceof Error ? err.message : String(err) },
    )
    return false
  }
}

export class TickRecorder {
  readonly #col: TickCollection
  readonly #tokens: () => ReadonlySet<number>
  readonly #now: () => number
  readonly #log: TickLog
  #buffer: TickRow[] = []
  /** The overflow alarm fires ONCE per process. See `#overflow`. */
  #warnedOverflow = false
  #timer: ReturnType<typeof setInterval> | null

  constructor(deps: TickRecorderDeps) {
    this.#col = deps.db.collection(TICK_COLLECTION)
    this.#tokens = deps.tokens
    this.#now = deps.now
    this.#log = deps.log ?? ((): void => {})
    const timer = setInterval(() => void this.flush(), deps.flushMs ?? DEFAULT_TICK_FLUSH_MS)
    // A research tape must never be the reason this process refuses to exit.
    if (typeof timer.unref === 'function') timer.unref()
    this.#timer = timer
  }

  /** Buffer one frame. Synchronous, allocation-only, never awaits anything. */
  onTick(t: MdTick): void {
    if (!this.#tokens().has(t.token)) return
    if (this.#buffer.length >= MAX_BUFFERED_TICKS) this.#overflow()
    const ts = Number.isFinite(t.ts) ? t.ts : this.#now()
    this.#buffer.push({
      token: t.token,
      ts,
      tsDate: new Date(ts),
      price: t.price,
      // Absent is not zero: a never-traded strike has no bid, and a replay that
      // read one as 0 would price an exit nobody could ever have got.
      bid: typeof t.bid === 'number' && Number.isFinite(t.bid) ? t.bid : null,
      ask: typeof t.ask === 'number' && Number.isFinite(t.ask) ? t.ask : null,
    })
  }

  /**
   * Write whatever is buffered. Returns the number of rows written.
   *
   * The buffer is swapped out BEFORE the await, so a flush that overlaps the
   * next one (a slow Mongo under a fast timer) writes disjoint batches instead
   * of the same rows twice.
   */
  async flush(): Promise<number> {
    if (this.#buffer.length === 0) return 0
    const batch = this.#buffer
    this.#buffer = []
    try {
      // `ordered: false` — the tape is append-only and has no order to preserve,
      // so one rejected row must not void the rest of the batch behind it.
      await this.#col.insertMany(batch, { ordered: false })
      return batch.length
    } catch (err) {
      // Swallowed on purpose: see the header. Not re-queued either — a batch
      // that failed once will fail again, and holding it is how a stall becomes
      // the unbounded buffer `MAX_BUFFERED_TICKS` exists to prevent.
      this.#log('tick tape write failed — the batch is dropped', {
        rows: batch.length,
        error: err instanceof Error ? err.message : String(err),
      })
      return 0
    }
  }

  /** Stop the timer. Idempotent; anything still buffered is abandoned. */
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * Mongo has stopped answering. Drop everything held and keep taping forward.
   *
   * Logged once and only once: a stall lasts minutes, the feed ticks through all
   * of it, and a line per overflow would bury the stall's own evidence under
   * thousands of copies of the complaint about it.
   */
  #overflow(): void {
    const held = this.#buffer.length
    this.#buffer = []
    if (this.#warnedOverflow) return
    this.#warnedOverflow = true
    this.#log(
      `tick tape buffer passed ${MAX_BUFFERED_TICKS} rows and was DROPPED — Mongo is not keeping ` +
        'up. The feed is unaffected; the tape has a gap. This is logged once per process.',
      { dropped: held },
    )
  }
}
