/**
 * `LiveBook` — the desk's positions, held in memory, so that reading the P&L
 * stops being a database scan (design doc §Phase 2).
 *
 * THE PROBLEM IT EXISTS FOR. Every `GET /v1/desk/pnl` ran `PnlStore.loadFills`
 * over a THIRTY DAY window of `desk-decisions` and rebuilt every strategy's
 * position from raw fills, and the browser polled it. N tabs meant N 30-day
 * scans every poll, and the 15s snapshot job made two more. Phase 1 put a socket
 * in front of that and changed none of it: it made the answer arrive sooner, not
 * cost less. Moving the fills into memory is what makes it cheap; the socket is
 * only what makes it visible.
 *
 * THREE INPUTS, AND NOTHING ELSE:
 *
 *  1. **Boot** — one read of the journal, netted by the SAME `buildPositions`
 *     the REST path uses.
 *  2. **A fill** — `onJournal`, called by the three places that write fills to
 *     `desk-decisions` (`applyDecision`, `flattenTag`, `SubmitService`). Rare
 *     and event-driven.
 *  3. **A tick** — `onTick`, from the marketdata bus.
 *
 * NO CHANGE STREAMS ANYWHERE. Production Mongo is a standalone; they do not
 * exist there. Every mutation is handed to this object by the code that just
 * wrote the document.
 *
 * THE HELD-SET CHECK IN `onTick` IS LOAD-BEARING, NOT AN OPTIMISATION. The
 * RE-MARK is unthrottled — every tick on a held instrument recomputes that
 * strategy's row — and that is only affordable because the desk holds ~26 open
 * legs against ~112 subscribed tokens, so the recompute rate is bounded by ticks
 * on those 26 (order of 100/sec) and each one is arithmetic over an in-memory
 * position. Ticks on the rest of the chain must be discarded BEFORE any work
 * happens. If that check is ever removed, a full-chain subscription puts
 * thousands of recomputes a second into the process that also routes orders.
 * `stats.ticks` vs `stats.recomputes` is the bound, asserted in
 * `test/livebook.test.ts` rather than assumed.
 *
 * THE PUSH IS NOT UNTHROTTLED — the SOCKET is what throttles it. `publishPnl`
 * only records the row; `DeskStream` coalesces the dirty set and flushes the
 * changed fields every 250ms. That split is deliberate: the re-mark has to be
 * per tick so the flush always carries the CURRENT price, and the flush has to
 * be periodic so ~100 recomputes a second do not become ~100 frames a second.
 *
 * THE RECONCILE IS THE SAFETY NET, and it is why the optimisation is allowed to
 * exist at all. Every 60s the journal is re-read and compared leg by leg against
 * what is held here; any difference is logged LOUDLY and the journal's answer is
 * adopted. The worst failure available to an in-memory book is that it silently
 * drifts — showing a position nobody holds, or hiding one that is real — and a
 * book that cannot be caught doing it has no business serving a P&L screen.
 *
 * IT NEVER SERVES A BOOK IT HAS NOT LOADED. `ready` is false until the first
 * successful journal read, and `routes/pnl.ts` falls back to the Mongo path
 * while it is. An empty in-memory book rendered as "no positions" would be the
 * exact defect this codebase keeps fixing: a confident answer that is not one.
 *
 * NOTHING HERE MAY BLOCK, THROW INTO, OR DELAY THE ORDER PATH. `onJournal` and
 * `onTick` are synchronous, return void, and swallow their own errors — the same
 * contract `OrderJournal.record`, `journalBlocked` and `DeskStream.publish`
 * already hold to.
 */

import { buildPositions, type Marks, type Position } from '@algomaker/pnl'
import type { DeskMode } from './contract.ts'
import { istDate, istDayRange, type ApiDeps, type Log } from './routes/kit.ts'
import { pnlKey, splitPnlKey, toStampedFill, describeBadFill, isCorrectedNoop, type FillLoad, type PnlStore } from './pnlstore.ts'
import {
  lookbackDaysOf,
  markResolverFor,
  quoteResolverFor,
  pnlFromFills,
  pnlRowFor,
  type PnlOptions,
  type PnlRow,
  type PnlSummary,
} from './pnl-jobs.ts'
import type { StampedFill } from './rollup.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What a journal write hands us. Exactly the four fields the three writers of
 * `desk-decisions` already have in scope at the moment they write, so no caller
 * has to reconstruct anything or read back what it just wrote.
 *
 * `fills` is the RAW stored shape rather than a validated one: the same
 * `toStampedFill` that guards the database read guards this, so an in-memory
 * position and a rebuilt one can never disagree about which fills were usable.
 */
export interface JournalEntry {
  readonly tag: string
  readonly mode: DeskMode
  /** The decision's `createdAt`, i.e. what `loadFills` files the fill under. */
  readonly createdAt: number
  readonly fills: readonly unknown[]
}

/**
 * The push side of the socket, as this module sees it. `DeskStream` satisfies it
 * structurally, so nothing here imports `ws` or knows a socket exists.
 *
 * `subscriberCount` is not decoration: with no dashboard open there is nothing
 * for a re-mark to be visible in, so the tick path skips the arithmetic entirely
 * and a bridge with no browser attached does exactly the work it did before.
 */
export interface LiveBookStream {
  /**
   * Hand over a freshly marked row. IT DOES NOT SEND — `DeskStream` coalesces
   * these into a flush every 250ms and puts only the changed fields on the
   * wire. Calling it per tick is the intended cost; it is one map write.
   */
  publishPnl(mode: DeskMode, row: PnlRow): void
  subscriberCount(mode: DeskMode): number
}

/** One leg on which the in-memory book and the journal do not agree. */
export interface Divergence {
  /** `tag|mode`. */
  readonly key: string
  readonly tradingsymbol: string
  readonly field: 'qty' | 'avgCost' | 'realised' | 'missing' | 'extra'
  /** What memory said. Null when memory did not have the leg at all. */
  readonly book: number | null
  /** What the journal says. Null when the journal does not have the leg. */
  readonly journal: number | null
}

export type ReconcileStatus = 'ok' | 'skipped' | 'failed'

export interface ReconcileResult {
  readonly status: ReconcileStatus
  readonly divergences: readonly Divergence[]
}

/**
 * Counters, exposed so the load bound the design rests on can be ASSERTED.
 *
 * `ticks` counts every tick offered; `recomputes` counts the ones that reached
 * the arithmetic. The gap between them is the held-set filter doing its job, and
 * a test that watches it close is a test that catches the filter being removed.
 */
export interface LiveBookStats {
  readonly ticks: number
  readonly ticksHeld: number
  readonly recomputes: number
  readonly pushes: number
  readonly journalEntries: number
  readonly reconciles: number
  readonly divergences: number
  readonly heldTokens: number
}

export interface LiveBookDeps {
  /**
   * The same bag every route module gets. Read for `master` (symbol -> token),
   * `marks` and `store.listStrategies`. It must NOT carry the book itself —
   * this object is constructed from it, not through it.
   */
  readonly deps: ApiDeps
  readonly store: PnlStore
  readonly opts?: PnlOptions
  readonly stream?: LiveBookStream
  /** How often the journal is re-read and compared. See the header. */
  readonly reconcileMs?: number
  readonly log?: Log
  now?(): number
}

/**
 * The narrow view a route or a job has of the book: is it usable, and what does
 * it say? Declared here rather than in `kit.ts` so that `kit.ts` keeps its
 * type-only imports and no runtime cycle can form.
 */
export interface LiveBookPort {
  /** False until the first journal read succeeded. Callers fall back to Mongo. */
  readonly ready: boolean
  summary(mode: DeskMode, nowMs: number): Promise<PnlSummary>
  onJournal(entry: JournalEntry): void
}

export class LiveBook implements LiveBookPort {
  readonly #deps: ApiDeps
  readonly #store: PnlStore
  readonly #opts: PnlOptions
  readonly #stream: LiveBookStream | null
  readonly #log: Log
  readonly #now: () => number
  readonly #reconcileMs: number

  /** Fills by `tag|mode`, in book order. The book itself. */
  #fills = new Map<string, StampedFill[]>()
  /**
   * Contracts whose stored fill could not be read. Forces a row incomplete.
   *
   * KEYED `tag|mode`, exactly like `#fills`, and that is the fix for F-53. As a
   * flat list it had no rail on it, so a corrupt PAPER fill made the LIVE row
   * of the same tag incomplete — `total: null` on the money rail because a
   * simulation wrote a price nobody could read.
   */
  #malformed = new Map<string, string[]>()
  /** True when the boot/reconcile read hit its cap — the book is a SUBSET. */
  #truncated = false
  /** Registry labels, refreshed on reconcile. The tick path must not read Mongo. */
  #labels = new Map<string, string>()

  /**
   * The held set, keyed by INSTRUMENT TOKEN because that is what a tick carries.
   * `#tokensByKey` is its inverse, so one strategy's fill re-indexes only that
   * strategy rather than walking the whole desk.
   */
  #heldByToken = new Map<number, Set<string>>()
  #tokensByKey = new Map<string, Set<number>>()

  #ready = false
  /**
   * Bumped by every mutation. The reconcile samples it before its read and
   * refuses to adopt if it moved — a fill that landed mid-read is not a
   * divergence, and reporting it as one would train an operator to ignore the
   * one log line that matters.
   */
  #gen = 0
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #reconciling = false

  #ticks = 0
  #ticksHeld = 0
  #recomputes = 0
  #pushes = 0
  #journalEntries = 0
  #reconciles = 0
  #divergences = 0

  constructor(d: LiveBookDeps) {
    this.#deps = d.deps
    this.#store = d.store
    this.#opts = d.opts ?? {}
    this.#stream = d.stream ?? null
    this.#log = d.log ?? d.deps.log
    this.#now = d.now ?? ((): number => d.deps.now())
    this.#reconcileMs = d.reconcileMs ?? 60_000
  }

  get ready(): boolean {
    return this.#ready
  }

  get stats(): LiveBookStats {
    return {
      ticks: this.#ticks,
      ticksHeld: this.#ticksHeld,
      recomputes: this.#recomputes,
      pushes: this.#pushes,
      journalEntries: this.#journalEntries,
      reconciles: this.#reconciles,
      divergences: this.#divergences,
      heldTokens: this.#heldByToken.size,
    }
  }

  // ------------------------------------------------------------------ boot

  /**
   * Load the book and start reconciling. Returns a stop function.
   *
   * The first load is AWAITED by callers that care, but `main.ts` deliberately
   * does not: a bridge that could not open its port until Mongo answered would
   * be down during exactly the outage someone opened the dashboard to look at.
   * Until it lands, `ready` is false and every reader takes the REST path.
   */
  async start(): Promise<() => void> {
    await this.#bootLoad()
    // A SIGTERM that arrived while the boot read was in flight must not be
    // undone by this line scheduling the interval it just stopped.
    if (this.#stopped) return (): void => this.stop()
    // `unref`, without exception. A referenced interval keeps the event loop
    // alive, so `pm2 restart` waits out its kill timeout on every deploy —
    // the defect `pnl-jobs.ts` documents at the top of the file.
    const timer = setInterval(() => {
      /**
       * `.catch`, not a bare `void` (audit F-41). `reconcile` guards its own
       * journal READ, and nothing after it: `#adopt` re-indexes every held leg
       * through the instrument master, and a throw there rejected a promise
       * nobody was listening to — which Node >=15 treats as fatal. So a fault
       * in the repair job did not cost the round, it killed the bridge, once
       * per interval, for as long as the condition lasted. The next round
       * retries; that is what a reconcile is for.
       */
      void this.reconcile(this.#now()).catch((err: unknown) => {
        this.#log('LiveBook reconcile threw — the book stands, the next round retries', {
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        })
      })
    }, this.#reconcileMs)
    timer.unref()
    this.#timer = timer
    return (): void => this.stop()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * The boot read, retried a couple of times if a fill lands during it.
   *
   * A fill mid-read cannot be adopted safely (see `#gen`), and at boot there is
   * no prior book to fall back on, so the read is simply taken again. If it will
   * not settle we stay NOT READY rather than serve a book we cannot vouch for.
   */
  async #bootLoad(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.reconcile(this.#now())
      if (result.status === 'ok') {
        this.#log('LiveBook loaded', {
          strategies: this.#fills.size,
          heldTokens: this.#heldByToken.size,
          truncated: this.#truncated,
        })
        return
      }
      if (result.status === 'failed') break
    }
    this.#log('LiveBook could not load — every P&L read stays on the REST path', {
      ready: this.#ready,
    })
  }

  // ------------------------------------------------------------------ reads

  /**
   * One mode's P&L, from memory.
   *
   * Routed through `pnlFromFills`, which is the SAME function `livePnl` calls
   * once it has read Mongo — the two differ only in where the fills came from.
   * That is deliberate and is the whole reason this method is three lines: the
   * carried-realised subtraction, the qty-0-only-if-it-traded-in-window rule,
   * the `openLegs` count and the null-not-zero discipline are all arithmetic
   * that was fixed at real cost (`439fa6f5`), and a second implementation of it
   * would be a second thing to get wrong.
   *
   * `listStrategies` is still read per call, and on purpose: it is a handful of
   * documents on a tiny collection, and caching it would mean a strategy
   * registered a moment ago is invisible on the page that was opened to check
   * it. The 30-day scan is what this class exists to remove, not that.
   */
  async summary(mode: DeskMode, nowMs: number): Promise<PnlSummary> {
    /**
     * `malformed` is FLATTENED TO THIS MODE, not to the whole book.
     * `pnlFromFills` buckets that list by tag alone — its own read is already
     * mode-scoped — so handing it both rails' entries is exactly what leaked a
     * paper fill onto the live row. The keyed map travels with it for any
     * reader that wants the rail back.
     */
    const load: FillLoad = {
      byKey: this.#fills,
      malformed: this.#malformedFor(mode),
      malformedByKey: this.#malformed,
      truncated: this.#truncated,
    }
    return await pnlFromFills(this.#deps, this.#opts, mode, nowMs, this.#boundary(nowMs), load)
  }

  /** Positions as the book currently holds them. For tests and diagnostics. */
  positions(tag: string, mode: DeskMode): readonly Position[] {
    return buildPositions(this.#fills.get(pnlKey(tag, mode)) ?? [])
  }

  // ----------------------------------------------------------------- fills

  /**
   * A fill was just journalled. Mutate the book.
   *
   * CALLED FROM THE ORDER PATH, after the durable write, so it holds the same
   * contract as `PaperRail`'s emit: synchronous, void, and it swallows
   * everything. A dashboard that missed an update is an inconvenience; an order
   * that failed because a cache could not be updated is an outage.
   *
   * A fill arriving before the boot load is not dropped — it is applied to the
   * (empty) book and bumps `#gen`, which makes the in-flight load refuse to
   * adopt and take itself again.
   */
  onJournal(entry: JournalEntry): void {
    try {
      if (entry.tag === '' || entry.fills.length === 0) return
      const key = pnlKey(entry.tag, entry.mode)
      const list = this.#fills.get(key) ?? []
      let added = 0
      for (const raw of entry.fills) {
        // Same rule as the database read: a reconciler-zeroed fill is a
        // legitimate no-op, not a corrupt row — see `isCorrectedNoop`.
        if (isCorrectedNoop(raw)) continue
        const fill = toStampedFill(raw, entry.createdAt)
        if (fill === null) {
          // Same treatment as the database read gives it: named, and it makes
          // the row incomplete. Absorbing it would report a book missing a leg
          // as a confident smaller book.
          //
          // ON THIS RAIL ONLY (F-53) — `key` is `tag|mode`. A paper fill nobody
          // could read must not put `total: null` on the tag's LIVE row.
          const bad = this.#malformed.get(key)
          if (bad === undefined) this.#malformed.set(key, [describeBadFill(raw, entry.tag)])
          else bad.push(describeBadFill(raw, entry.tag))
          continue
        }
        list.push(fill)
        added++
      }
      if (added === 0 && list.length === 0) return
      this.#fills.set(key, list)
      this.#journalEntries++
      this.#gen++
      this.#reindex(key)
      /**
       * RE-MARK ON THE FILL ITSELF, not only on the next tick.
       *
       * A fill is the only thing that moves `qty`, `avgCost`, `realised` and
       * the buy/sell figures, and the socket protocol omits those from a tick
       * delta precisely because they cannot move on a tick — so the fresh row
       * is what makes them arrive at all. Waiting for the next tick would be
       * almost right and wrong in the worst case: a fill that CLOSES the last
       * open leg takes the contract out of the held set, so no further tick for
       * it ever arrives and the page would show the position as still open
       * until the 15s REST poll.
       *
       * Cheap because fills are rare — this is the arithmetic `onTick` already
       * does ~100 times a second, done once more per fill — and it stays inside
       * the same try/catch, so the order path cannot be failed by it.
       */
      const stream = this.#stream
      if (stream !== null && stream.subscriberCount(entry.mode) > 0) {
        const row = this.#rowFor(entry.tag, entry.mode, this.#now())
        if (row !== null) {
          stream.publishPnl(entry.mode, row)
          this.#pushes++
        }
      }
    } catch (err) {
      // Never propagates. The 60s reconcile rebuilds from the journal, so the
      // worst case of a failure here is a minute of staleness, not a lost fill.
      this.#log('LiveBook could not apply a journalled fill — the reconcile will repair it', {
        tag: entry.tag,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ------------------------------------------------------------------ ticks

  /**
   * A tick arrived for `token`.
   *
   * THE MEMBERSHIP TEST IS THE FIRST STATEMENT AND IT RETURNS. Everything in
   * the header about the cadence being affordable depends on this line and on
   * nothing being put above it. Only an instrument we hold can change a P&L, so
   * a tick on any of the other ~86 subscribed tokens costs one map lookup.
   */
  onTick(token: number): void {
    this.#ticks++
    const keys = this.#heldByToken.get(token)
    if (keys === undefined) return
    this.#ticksHeld++
    const stream = this.#stream
    if (stream === null) return
    const now = this.#now()
    for (const key of keys) {
      const { tag, mode } = splitPnlKey(key)
      // Nobody is watching this rail, so there is nothing for a re-mark to be
      // visible in. Checked before the arithmetic, not after: a bridge with no
      // dashboard attached must do exactly the work it did before this class
      // existed.
      if (stream.subscriberCount(mode) === 0) continue
      try {
        const row = this.#rowFor(tag, mode, now)
        if (row === null) continue
        this.#recomputes++
        stream.publishPnl(mode, row)
        this.#pushes++
      } catch (err) {
        this.#log('LiveBook could not re-mark on a tick', {
          key,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * One strategy's row, priced right now, with NO database read.
   *
   * The label comes from the cache refreshed on reconcile rather than from
   * `listStrategies`: this runs on the tick path at up to ~100/sec, and a Mongo
   * round trip there would be the whole problem again in a new place. A label
   * up to a minute stale on a pushed frame costs nothing — REST remains the
   * authority for what is rendered.
   */
  #rowFor(tag: string, mode: DeskMode, nowMs: number): PnlRow | null {
    const fills = this.#fills.get(pnlKey(tag, mode))
    if (fills === undefined) return null
    const marksOf = markResolverFor(this.#deps, this.#opts)
    const quotesOf = quoteResolverFor(this.#deps, this.#opts)
    return pnlRowFor({
      tag,
      label: this.#labels.get(tag) ?? tag,
      mode,
      fills,
      boundary: this.#boundary(nowMs),
      marksOf,
      quotesOf,
      // This rail's refusals only — see `#malformed`.
      malformed: malformedFor(this.#malformed.get(pnlKey(tag, mode)) ?? [], tag),
    })
  }

  // ------------------------------------------------------------- reconcile

  /**
   * Rebuild from the journal, compare, log any difference LOUDLY, and adopt the
   * journal's answer.
   *
   * ADOPTION IS UNCONDITIONAL, not "on divergence". The journal is the only
   * durable record of what was filled, so it wins by definition — and adopting
   * every minute is also what slides the 30-day lookback forward at IST
   * midnight and drops fills that have aged out of it.
   *
   * A fill that lands while the read is in flight makes the comparison
   * meaningless: memory legitimately holds something the read predates. `#gen`
   * detects exactly that, and the round is SKIPPED rather than reported as
   * drift. Nothing is lost — the fill is already in the book and the next round
   * verifies it.
   */
  async reconcile(nowMs: number): Promise<ReconcileResult> {
    if (this.#reconciling) return { status: 'skipped', divergences: [] }
    this.#reconciling = true
    try {
      const gen = this.#gen
      let load: FillLoad
      try {
        load = await this.#store.loadFills({
          from: this.#boundary(nowMs) - lookbackDaysOf(this.#opts) * DAY_MS,
          // Exclusive upper bound, so a fill stamped exactly now is included.
          to: nowMs + 1,
          // BOTH modes in one read — the map is keyed `tag|mode`, so a second
          // scan of the busiest collection to fetch the other rail would undo
          // half of what this class exists for.
          //
          // The same cap policy the REST path uses, so the two cannot disagree
          // about how much of the window they read. Hitting it comes back as
          // `PnlSummary.truncated` rather than as a quietly smaller answer.
          ...(this.#opts.fillLimit === undefined ? {} : { limit: this.#opts.fillLimit }),
        })
      } catch (err) {
        // The book keeps serving what it has. Falling back to "no positions"
        // because Mongo blinked would be worse than a minute of staleness, and
        // this is the one place that would ever notice the outage.
        this.#log('LiveBook reconcile could not read the journal — serving the in-memory book', {
          error: err instanceof Error ? err.message : String(err),
        })
        return { status: 'failed', divergences: [] }
      }
      if (gen !== this.#gen) {
        this.#log('LiveBook reconcile skipped — a fill landed mid-read; retrying next round')
        return { status: 'skipped', divergences: [] }
      }

      this.#reconciles++
      const divergences = this.#ready ? compare(this.#fills, load.byKey) : []
      if (divergences.length > 0) {
        this.#divergences += divergences.length
        /**
         * LOUD, and it names every leg. An in-memory book that drifts shows a
         * position nobody holds or hides one that is real; a log line that said
         * only "reconciled" would let that happen every minute forever without
         * anyone being able to tell.
         */
        this.#log('LiveBook DIVERGED from the journal — adopting the journal', {
          legs: divergences.length,
          detail: divergences.slice(0, 20).map(describe),
          ...(divergences.length > 20 ? { omitted: divergences.length - 20 } : {}),
        })
      }
      this.#adopt(load)
      await this.#refreshLabels()
      this.#ready = true
      return { status: 'ok', divergences }
    } finally {
      this.#reconciling = false
    }
  }

  // ------------------------------------------------------------- internals

  /** Start of the current IST trading day: where `carried` stops and `during` begins. */
  #boundary(nowMs: number): number {
    return istDayRange(istDate(nowMs)).from
  }

  /**
   * One rail's refused fills, flattened back to the `tag:symbol` list
   * `pnlFromFills` buckets by tag.
   *
   * The flattening is the mode filter: `pnlFromFills` is handed one mode and
   * has no way to tell which rail an entry came from, so the caller has to be
   * the one that knows. Cheap by construction — refusals are rare, and on a
   * healthy desk this walks an empty map.
   */
  #malformedFor(mode: DeskMode): string[] {
    const out: string[] = []
    for (const [key, entries] of this.#malformed) {
      if (splitPnlKey(key).mode === mode) out.push(...entries)
    }
    return out
  }

  #adopt(load: FillLoad): void {
    this.#fills = new Map(load.byKey)
    // `malformedByKey`, not the flat list: the reconcile read covers BOTH rails
    // (one scan, see `reconcile`), so the flat list cannot say which rail a
    // refused fill belonged to and adopting it would re-mix them.
    this.#malformed = new Map([...load.malformedByKey].map(([k, v]) => [k, [...v]]))
    this.#truncated = load.truncated
    this.#gen++
    this.#reindexAll()
  }

  /**
   * Labels only, and only on the reconcile. The tick path reads this cache
   * rather than Mongo; `summary` still reads the registry live, because a row
   * missing from the P&L page for a minute is a worse failure than a stale
   * label on a frame nobody renders.
   */
  async #refreshLabels(): Promise<void> {
    try {
      const rows = await this.#deps.store.listStrategies()
      this.#labels = new Map(rows.map((r) => [r.tag, r.label === '' ? r.tag : r.label]))
    } catch {
      // Keep the previous labels. A label is cosmetic; failing a reconcile over
      // one would throw away the position check it just did.
    }
  }

  #reindexAll(): void {
    this.#heldByToken = new Map()
    this.#tokensByKey = new Map()
    for (const key of this.#fills.keys()) this.#reindex(key)
  }

  /**
   * Re-derive which tokens THIS strategy holds.
   *
   * Scoped to one key rather than the whole desk because it runs on the order
   * path: `onJournal` is called by the code that has just written a fill, and
   * walking every strategy's thirty days of fills there would put a growing,
   * unbounded cost in front of an order response.
   *
   * A contract the instrument master cannot resolve is simply not indexed. It
   * still appears in the P&L row (unpriced, and saying so) — it just cannot be
   * re-marked by a tick, because no tick for it can be identified.
   */
  #reindex(key: string): void {
    for (const token of this.#tokensByKey.get(key) ?? []) {
      const holders = this.#heldByToken.get(token)
      if (holders === undefined) continue
      holders.delete(key)
      if (holders.size === 0) this.#heldByToken.delete(token)
    }
    const tokens = new Set<number>()
    const master = this.#deps.master.current()
    let positions: readonly Position[]
    try {
      positions = buildPositions(this.#fills.get(key) ?? [])
    } catch {
      // `buildPositions` throws on a fill the validator should already have
      // rejected. Leaving the key unindexed loses a push, never a position:
      // `summary` reads the same fills and the reconcile rebuilds them.
      this.#tokensByKey.set(key, tokens)
      return
    }
    for (const p of positions) {
      // OPEN legs only. A closed round trip carries no exposure, so a tick on
      // it cannot change a mark-to-market and must not cost one.
      if (p.qty === 0) continue
      const token = master.resolveSymbol(p.tradingsymbol)?.instrumentToken
      if (token === undefined) continue
      tokens.add(token)
      const holders = this.#heldByToken.get(token)
      if (holders === undefined) this.#heldByToken.set(token, new Set([key]))
      else holders.add(key)
    }
    this.#tokensByKey.set(key, tokens)
  }
}

// --------------------------------------------------------------- divergence

/**
 * Prices and realised P&L are floats built by repeated addition, so an exact
 * comparison would report drift on two sets of fills that are identical. A
 * hundredth of a rupee is below the smallest tick this desk trades.
 */
const EPSILON = 0.005

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON
}

/**
 * Compare two books leg by leg.
 *
 * Both sides are netted by the same `buildPositions` the P&L runs on, so this
 * asks the only question worth asking: would the two produce the same positions
 * table? A comparison of raw fill arrays would flag orderings and duplicates
 * that net to the same book, and the noise would bury a real divergence.
 */
export function compare(
  book: ReadonlyMap<string, readonly StampedFill[]>,
  journal: ReadonlyMap<string, readonly StampedFill[]>,
): Divergence[] {
  const out: Divergence[] = []
  const keys = new Set([...book.keys(), ...journal.keys()])
  for (const key of [...keys].sort()) {
    const mine = positionsBySymbol(book.get(key) ?? [])
    const theirs = positionsBySymbol(journal.get(key) ?? [])
    const symbols = new Set([...mine.keys(), ...theirs.keys()])
    for (const tradingsymbol of [...symbols].sort()) {
      const a = mine.get(tradingsymbol)
      const b = theirs.get(tradingsymbol)
      /**
       * A leg netting to zero on one side only is not a divergence worth
       * shouting about: the two books simply cut the lookback at slightly
       * different instants and one of them has a closed round trip the other
       * does not. Only a leg with EXPOSURE on one side and not the other is a
       * position that is being shown or hidden wrongly.
       */
      if (a === undefined || b === undefined) {
        const held = a ?? b
        if (held === undefined || held.qty === 0) continue
        out.push({
          key,
          tradingsymbol,
          field: a === undefined ? 'missing' : 'extra',
          book: a?.qty ?? null,
          journal: b?.qty ?? null,
        })
        continue
      }
      if (a.qty !== b.qty) {
        out.push({ key, tradingsymbol, field: 'qty', book: a.qty, journal: b.qty })
      }
      if (!close(a.avgCost, b.avgCost)) {
        out.push({ key, tradingsymbol, field: 'avgCost', book: a.avgCost, journal: b.avgCost })
      }
      if (!close(a.realised, b.realised)) {
        out.push({ key, tradingsymbol, field: 'realised', book: a.realised, journal: b.realised })
      }
    }
  }
  return out
}

function positionsBySymbol(fills: readonly StampedFill[]): Map<string, Position> {
  try {
    return new Map(buildPositions(fills).map((p) => [p.tradingsymbol, p]))
  } catch {
    // An unreadable fill on either side. Reporting an empty book here would
    // manufacture a divergence for every leg; the malformed list is what says
    // the figures are incomplete.
    return new Map()
  }
}

function describe(d: Divergence): string {
  return `${d.key} ${d.tradingsymbol} ${d.field}: book=${String(d.book)} journal=${String(d.journal)}`
}

/**
 * The malformed entries belonging to one tag, in the `tag:symbol` shape
 * `pnl-jobs.malformedByTag` splits on. Restated here because the tick path
 * builds ONE row and has no reason to bucket the whole desk.
 */
function malformedFor(all: readonly string[], tag: string): string[] {
  const prefix = `${tag}:`
  const out: string[] = []
  for (const e of all) {
    if (e === tag) out.push('<unreadable fill>')
    else if (e.startsWith(prefix)) out.push(e.slice(prefix.length))
  }
  return out
}
