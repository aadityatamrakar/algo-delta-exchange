/**
 * Persistence for the desk bridge.
 *
 * The Mongo driver is reached through a NARROW port (`Collection`/`Database`
 * below) rather than imported directly. Two reasons, both concrete:
 *
 *  1. The tree pins driver 3.7.3 exactly. It was `loopback-connector-mongodb`
 *     that put it there and no LoopBack server remains — the pin is now a
 *     deliberate decision (verified against MongoDB 8.2; 4.x/6.x change the
 *     connection options and the cursor API, so moving is a change of behaviour,
 *     not a bump). `mongo.ts` carries the full note. Confining the driver to one
 *     adapter means that upgrade, when it happens, touches a single file.
 *  2. Driver 3.x ships no bundled types. Declaring only the handful of methods
 *     actually used keeps `strict` + `exactOptionalPropertyTypes` meaningful
 *     instead of importing an `any`.
 *
 * Every method is testable against an in-memory fake implementing the same port.
 */

import type { BridgeLeg, DeskMode, Fill, Skip } from './contract.ts'
import type { DeclaredLeg } from './book.ts'
import type { DeclaredGreeks } from './validate.ts'
import { isDuplicateKey } from './errors.ts'
import {
  DEFAULT_KILL_SWITCH,
  readBrokerLinkDoc,
  type BrokerLinkState,
  type KillSwitchState,
} from './safety.ts'
import {
  applyStrategyPatch,
  DEFAULT_STRATEGY,
  isAdded,
  strategyFromDoc,
  withMode,
  type StrategyPatch,
  type StrategyRow,
} from './strategies.ts'
import { bookFromDoc, deriveSeries, type BookRow, type BookState, type DialValue, type VariantRow } from './books-registry.ts'

// ------------------------------------------------------------------ the port

/**
 * What the driver reports back from an update.
 *
 * Only `matchedCount` is declared, and only because a COMPARE-AND-SET needs it:
 * an update whose filter carries an expected version has to be able to say "the
 * row moved under me" rather than silently doing nothing. Optional so a test
 * fake is not obliged to model it.
 */
export interface UpdateOutcome {
  readonly matchedCount?: number
}

export interface FindCursor<T> {
  sort(spec: Record<string, 1 | -1>): FindCursor<T>
  limit(n: number): FindCursor<T>
  skip(n: number): FindCursor<T>
  toArray(): Promise<T[]>
}

export interface Collection<T = Record<string, unknown>> {
  findOne(filter: Record<string, unknown>): Promise<T | null>
  find(filter: Record<string, unknown>): FindCursor<T>
  insertOne(doc: T): Promise<unknown>
  insertMany(docs: readonly T[]): Promise<unknown>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<UpdateOutcome>
  deleteOne(filter: Record<string, unknown>): Promise<unknown>
  deleteMany(filter: Record<string, unknown>): Promise<unknown>
  countDocuments(filter: Record<string, unknown>): Promise<number>
  createIndex(
    spec: Record<string, 1 | -1>,
    // `sparse` is declared because F-42's paper-trade index needs it: a row
    // written before `clientOrderId` existed has none, Mongo reads a missing
    // key as `null`, and two nulls collide on a plain unique index — which on
    // the boot path means the API does not start.
    //
    // `partialFilterExpression` is declared because a UNIQUE-WHILE-ACTIVE claim
    // needs it: `desk-repair-applies` must allow many finished runs per tag and
    // exactly one RUNNING one, and that is a uniqueness that applies to a
    // SUBSET of the collection. Without it the claim has to be a read-then-write
    // in application code, which is not a claim at all — see `repair-apply.ts`.
    options?: {
      unique?: boolean
      name?: string
      sparse?: boolean
      partialFilterExpression?: Record<string, unknown>
    },
  ): Promise<unknown>
  dropIndex(name: string): Promise<unknown>
}

export interface Database {
  collection<T = Record<string, unknown>>(name: string): Collection<T>
}

// ------------------------------------------------------------- collections

/**
 * Paper fills live in their OWN collection.
 *
 * D4, and it is the single most important line in this file. `xtsOrder.js:314`
 * opens a change stream on `positional` and forwards every insert to a real
 * broker. A paper order written there is a real trade. Keeping the two in
 * separate collections makes that mistake structurally impossible rather than a
 * thing to remember.
 */
export const COLLECTIONS = {
  paperTrade: 'desk-paper-trade',
  /** The LIVE rail, executed by the legacy xtsOrder.js daemon. Never paper. */
  live: 'positional',
  /**
   * The LIVE rail executed by the NEW gateway. Separate from `positional` so
   * the two executors can never both act on the same order — see rail.ts's
   * `LiveExecutor`.
   */
  gatewayOrders: 'desk-gateway-orders',
  books: 'desk-books',
  /**
   * The BOOK REGISTRY (phase 1-2 task 5): one row per managed positional book —
   * its variant, its dials, the operator's `desired` state and the supervisor's
   * `actual` one.
   *
   * DELIBERATELY NOT `desk-books`. That name already holds the LEG-LEVEL book
   * from phase 0 — the actual open positions. Reusing it here would have the
   * registry's upsert overwrite real positions the moment a book was created or
   * edited; naming it `desk-books-registry` makes that collision structurally
   * impossible rather than a thing to remember.
   */
  booksRegistry: 'desk-books-registry',
  /**
   * WHICH SERIES EACH BOOK BELONGED TO (WS2): one row per `{tag, mode}`,
   * written when the book is created and NEVER deleted — not by `eraseBook`,
   * not by `purgeTagHistory`. It is the only record of a dated book's series
   * that outlives its registry row. See `book-series.ts`.
   */
  bookSeries: 'desk-book-series',
  /**
   * The variant catalogue (phase 1-2 task 6). HISTORICAL as of the D9 cutover:
   * the Python supervisor that published it wholesale is gone and nothing
   * writes it any more. Still read — see `DeskStore.listVariants`.
   */
  variants: 'desk-variants',
  decisions: 'desk-decisions',
  /**
   * The supervisor's journal: one row per decision it ACTED on, with the
   * `trigger` and `reason` that explain it. Written by `routes/engine.ts`
   * (its `ENGINE_DECISIONS_COLLECTION` is this value); read by the reports
   * order log to say WHY each order went out (`withDecisionContext`).
   */
  engineDecisions: 'desk-engine-decisions',
  declarations: 'desk-declarations',
  /** Kill-switch state. Persisted so a halt SURVIVES a restart — a safety
   *  control that forgets itself on redeploy is not a safety control. */
  safety: 'desk-safety',
  /**
   * The strategy registry: one row per trading source, each with its own on/off
   * switch. Persisted for the same reason as `safety` — an operator who switched
   * a book off before going home must find it still off in the morning.
   */
  strategies: 'desk-strategies',
  /**
   * The order journal, WRITTEN BY apps/order-gateway and appended to here for
   * decisions a gate refused. It is the feed the portal renders as "what
   * happened to my orders", so a rejection that never reaches it makes a
   * switched-off strategy indistinguishable from a dead one.
   */
  orderEvents: 'desk-order-events',
  /** Per-book margin, priced through Kite and WRITTEN BY desk-marketdata. */
  bookMargin: 'desk-book-margin',
  /**
   * WHAT THE PAYOFF COCKPIT SHOWED, every time it was asked.
   *
   * Append-only and written fire-and-forget by `routes/payoff.ts`. It exists
   * for one question — "what did the book look like when I decided that?" — and
   * that question is only answerable after the fact, from a record taken at the
   * time. The chain it was priced off is gone within seconds.
   */
  payoffSnapshots: 'desk-payoff-snapshots',
  /** One document per repair Apply run — its ledger, and, while RUNNING, the
   *  supervisor hold on its tag. See `repair-apply.ts`. */
  repairApplies: 'desk-repair-applies',
} as const

export interface StoredDecision {
  readonly decisionId: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly tag: string
  readonly fills: readonly Fill[]
  readonly skips: readonly Skip[]
  readonly createdAt: number
}

/** The identity of a book. `tag` is the key; `symbol`/`expiry` are attributes. */
export interface BookKey {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
}

export interface StoredBook {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly legs: readonly BridgeLeg[]
  readonly updatedAt: number
  /**
   * The reconciler's fold receipts — one gateway `clientOrderId` per
   * compensating fold this document has already absorbed. See `saveBook`.
   *
   * Absent on a document written before the field existed, which reads as "no
   * fold has landed" and never as "already folded".
   */
  readonly appliedCorrections?: readonly string[]
}

export interface StoredDeclaration {
  readonly tag: string
  readonly symbol: string
  readonly legs: readonly DeclaredLeg[]
  readonly declaredAt: number
  /**
   * The STRATEGY'S OWN greeks, when it published any. Absent on a declaration
   * from before the field existed, or when the strategy's mark failed.
   */
  readonly greeks?: DeclaredGreeks
  /**
   * When THE GREEKS were last published — not when the legs were.
   *
   * Separate from `declaredAt` because a failed mark advances one and not the
   * other: the legs are still current while the greeks are the last good set.
   * A reader that aged them by `declaredAt` would call a stale set fresh.
   */
  readonly greeksAt?: number
}

/**
 * How many fold receipts one book keeps. See `saveBook`'s `correctionNonce`.
 *
 * The array only has to outlive the reconciler's 7-day lookback; 200 is the
 * bound that keeps a hot document small without ever being reachable in that
 * window by a book that folds a handful of corrections a day.
 */
const APPLIED_CORRECTIONS_CAP = 200

/**
 * Drop an index if it exists, tolerating both "no such index" and "no such
 * collection". Boot must not fail on a database that has never been written to.
 *
 * Exported for `migrate.ts`, which drops the same obsolete unique indexes for
 * the same reason and must not fork the tolerate-absence logic.
 */
export async function dropIfPresent(
  collection: { dropIndex(name: string): Promise<unknown> },
  name: string,
): Promise<void> {
  try {
    await collection.dropIndex(name)
  } catch {
    // IndexNotFound (27) or NamespaceNotFound (26). Both mean "already absent".
  }
}

/**
 * Build the F-42 `{clientOrderId}` unique index — and do NOT take the desk down
 * if history refuses it.
 *
 * A collection that ALREADY contains two rows under one `clientOrderId` cannot
 * have this index built over it, and this runs on the API's boot path
 * (`main.ts:132`, awaited). Throwing there converts an old duplicate — a defect
 * that is already in the past and is not making anything worse — into "the desk
 * does not start", at 09:14, with live books to mark. The index is a guard
 * against the NEXT duplicate; the correct failure mode is to say so at ERROR,
 * loudly enough that an operator dedupes it, and keep booting.
 *
 * Only a duplicate-key refusal is tolerated. Anything else (no connection, no
 * permission) is a real fault and is rethrown, because then nothing else in
 * this method would have worked either.
 */
async function ensureClientOrderIdUnique(
  db: Database,
  collection: string,
  sparse: boolean,
): Promise<void> {
  try {
    await db
      .collection(collection)
      .createIndex({ clientOrderId: 1 }, { unique: true, ...(sparse ? { sparse: true } : {}) })
  } catch (err) {
    if (!isDuplicateKey(err)) throw err
    console.error(
      `[bridge] COULD NOT build the unique clientOrderId index on '${collection}': it already ` +
        `holds two rows under one clientOrderId. The desk is booting WITHOUT the database-level ` +
        `duplicate-order guard on that collection — find and remove the duplicate ` +
        `(db.getCollection('${collection}').aggregate([{$group:{_id:'$clientOrderId',n:{$sum:1}}},` +
        `{$match:{n:{$gt:1}}}])) and restart.`,
      err,
    )
  }
}

/**
 * Build the repair CLAIM index — and do NOT take the desk down if the
 * collection already contains what the index forbids.
 *
 * Exactly the reasoning of `ensureClientOrderIdUnique` above, on a collection
 * that can get dirty in ways nothing in this process controls: a restore, an
 * index dropped by hand, or a run started by a path that never calls
 * `ensureIndexes` at all (`cli.ts`). Two RUNNING rows for one tag then refuse
 * the build, and on the boot path (`main.ts`, awaited) that is a bare E11000
 * turning into exit 1 and a pm2 crash-loop on a live bridge — over a pair of
 * rows that are already in the past.
 *
 * The index guards the NEXT race. Booting past an old duplicate does not make
 * it worse: `RepairApplyService`'s own courtesy scan still refuses a second
 * apply, and its stranded-claim reaper still clears rows past the hold window
 * — which is very likely what those rows are.
 *
 * Only a duplicate-key refusal is tolerated. Anything else (no connection, no
 * permission) is a real fault and is rethrown.
 */
async function ensureRepairClaimUnique(db: Database): Promise<void> {
  const name = COLLECTIONS.repairApplies
  try {
    await db
      .collection(name)
      .createIndex({ tag: 1 }, { unique: true, partialFilterExpression: { state: 'RUNNING' } })
  } catch (err) {
    if (!isDuplicateKey(err)) throw err
    console.error(
      `[bridge] COULD NOT build the unique repair-claim index on '${name}': it already holds two ` +
        `RUNNING runs for one tag. The desk is booting WITHOUT the database-level one-repair-per-` +
        `book guard — find them (db.getCollection('${name}').aggregate([{$match:{state:'RUNNING'}},` +
        `{$group:{_id:'$tag',n:{$sum:1},runs:{$push:'$_id'}}},{$match:{n:{$gt:1}}}])), end the ones ` +
        `that are not running any more (db.getCollection('${name}').updateOne({_id:'<applyId>'},` +
        `{$set:{state:'HALTED',haltReason:'cleared by hand'}})) and restart.`,
      err,
    )
  }
}

export class DeskStore {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  /**
   * Indexes the bridge depends on for correctness, not just speed.
   *
   * `decisionId` is UNIQUE: idempotency is enforced by the database, not by a
   * read-then-write in application code. N pm2 processes retrying the same
   * decision concurrently would both pass a "have I seen this?" check and both
   * route; a unique index makes the second insert fail instead.
   */
  async ensureIndexes(): Promise<void> {
    await this.#db
      .collection(COLLECTIONS.decisions)
      .createIndex({ decisionId: 1 }, { unique: true })
    /**
     * Books are keyed by TAG, not by symbol.
     *
     * The old index was `{symbol, mode}` UNIQUE, which meant two variants on one
     * symbol — the entire point of running an A/B — upserted over each other with
     * no error, because `saveBook` is an upsert. `symbol` survives as a NON-unique
     * index so "every book on BHEL" is still one query.
     *
     * `dropIndex` runs first because Mongo rejects `createIndex` on the same keys
     * with different options, and it is tolerant of the index being absent so this
     * is safe to run on a fresh database and on every boot.
     */
    await dropIfPresent(this.#db.collection(COLLECTIONS.books), 'symbol_1_mode_1')
    await dropIfPresent(this.#db.collection(COLLECTIONS.declarations), 'symbol_1')
    await this.#db.collection(COLLECTIONS.books).createIndex({ tag: 1, mode: 1 }, { unique: true })
    // EXPLICITLY NAMED, and it must not be `symbol_1_mode_1`. That is the name
    // Mongo derives from these keys by default, and it is exactly the name
    // dropped above — so every API restart dropped this index and rebuilt it,
    // leaving a window on each boot where the symbol lookup had no index and
    // the drop/build churned for nothing.
    await this.#db
      .collection(COLLECTIONS.books)
      .createIndex({ symbol: 1, mode: 1 }, { name: 'books_symbol_mode' })
    await this.#db.collection(COLLECTIONS.declarations).createIndex({ tag: 1 }, { unique: true })
    await this.#db.collection(COLLECTIONS.paperTrade).createIndex({ order_timestamp: -1 })
    /**
     * F-42 — THE API'S OWN DUPLICATE-ORDER PROTECTION.
     *
     * `rail.ts` calls the `{clientOrderId}` UNIQUE index on
     * `desk-gateway-orders` its protection against writing one order twice, and
     * until now only `apps/order-gateway` ever created it (`queue.ts`). A
     * restored database, or an API that boots before the gateway does, wrote
     * LIVE orders with no such protection at all: a safety property that
     * depends on which process happened to start first is not one. Both
     * processes now build it; `createIndex` is idempotent, and the options here
     * match the gateway's exactly (a different `unique`/`name` would make Mongo
     * refuse the second build outright).
     *
     * `desk-paper-trade` had no uniqueness of any kind. It is built SPARSE
     * because rows written before `clientOrderId` existed have none, Mongo
     * reads a missing key as `null`, and two nulls collide — which on this path
     * would mean the API refusing to boot over historical paper rows. Sparse
     * leaves those outside the index and every row the desk writes today
     * inside it.
     */
    await ensureClientOrderIdUnique(this.#db, COLLECTIONS.gatewayOrders, false)
    await ensureClientOrderIdUnique(this.#db, COLLECTIONS.paperTrade, true)
    // `tag` is UNIQUE for the same reason `decisionId` is: it is the key every
    // decision is gated on, and two rows for one tag would mean the answer to
    // "is this strategy enabled?" depends on which one Mongo returns first.
    await this.#db.collection(COLLECTIONS.strategies).createIndex({ tag: 1 }, { unique: true })
    // Same key shape as the phase-0 books index, and unique for the same
    // reason: two registry rows for one {tag, mode} would make "is this book
    // running?" depend on which one Mongo returns first.
    await this.#db
      .collection(COLLECTIONS.booksRegistry)
      .createIndex({ tag: 1, mode: 1 }, { unique: true })
    // One series membership per book, keyed exactly like the registry row it
    // outlives — `recordSeries` is insert-only and relies on this to make two
    // concurrent creates land one row, not two.
    await this.#db
      .collection(COLLECTIONS.bookSeries)
      .createIndex({ tag: 1, mode: 1 }, { unique: true })
    /**
     * The payoff archive is only ever read one book at a time, newest first —
     * "show me this book's cockpit at 14:32". Not unique: the whole point is
     * many rows per tag, and two requests inside one millisecond are two real
     * answers, not a duplicate.
     */
    await this.#db.collection(COLLECTIONS.payoffSnapshots).createIndex({ tag: 1, ts: -1 })
    /**
     * ONE RUNNING REPAIR PER BOOK — enforced by the database, not by a scan.
     *
     * `RepairApplyService.start` used to read "is anything running on this
     * tag?" and then insert. Between the read and the insert sits an await, so
     * two applies on ONE BOOK under DIFFERENT applyIds both read "no" and both
     * inserted — and the `_id` index cannot catch that, because their ids
     * differ by design. Two wave machines then closed and opened legs on one
     * book at once. No amount of after-the-fact comparing fixes it: whichever
     * run inserts last may be the one that scanned first.
     *
     * PARTIAL, on `state: 'RUNNING'`, because uniqueness is only true while the
     * run is live: a tag accumulates one row per repair it has ever had, and a
     * plain unique index on `tag` would let a book be repaired exactly once,
     * ever. With the filter, the INSERT of a RUNNING run *is* the claim — the
     * database refuses the second one — and a run that reaches DONE or HALTED
     * leaves the index and releases the tag in the same write.
     *
     * GUARDED, like the `clientOrderId` indexes: a collection that already
     * holds what this forbids must not stop the desk from booting.
     */
    await ensureRepairClaimUnique(this.#db)
    /**
     * AND THE INDEX THE HOLD READ ACTUALLY USES.
     *
     * The claim index above is PARTIAL on `state: 'RUNNING'`, so it can serve
     * "is a run executing on this tag?" and nothing else. The supervisor hold
     * outlives the run by the adoption grace (`repair-apply.ts:holdFor`), which
     * asks a wider question — RUNNING, *or* ended inside the last 90 seconds —
     * and that query cannot use a RUNNING-only index at all. It is asked on
     * essentially every positions poll of every book, which is the busiest read
     * this desk makes, so it gets an index of its own rather than a scan that
     * grows with every Apply ever pressed.
     *
     * NOT UNIQUE and not partial: many runs per tag is the whole point, and
     * `updatedAt` descending is the order the read wants (the most recently
     * ended run first).
     */
    await this.#db
      .collection(COLLECTIONS.repairApplies)
      .createIndex({ tag: 1, updatedAt: -1 })
  }

  // ---------------------------------------------------------------- books

  async loadBook(tag: string, mode: DeskMode): Promise<BridgeLeg[]> {
    const doc = await this.#db.collection<StoredBook>(COLLECTIONS.books).findOne({ tag, mode })
    return doc === null ? [] : [...doc.legs]
  }

  /** The whole document, for callers that need `symbol` or `expiry` too. */
  async bookDoc(tag: string, mode: DeskMode): Promise<StoredBook | null> {
    return await this.#db.collection<StoredBook>(COLLECTIONS.books).findOne({ tag, mode })
  }

  /**
   * AN EMPTY `expiry` NEVER OVERWRITES A STORED ONE.
   *
   * The book-level expiry is what lets a FLAT book keep its option chain
   * subscribed — with no legs there is nothing to infer it from, and
   * marketdata's fallback is `book.expiry ?? legs[0]?.expiry`, which `''` wins
   * because it is not nullish. So a write of `''` does not clear a field, it
   * makes the book permanently unsubscribable: no chain, no marks, no first
   * leg. Any caller that reaches here with `''` has failed to carry the book's
   * own expiry, and the safe reading of "I have no expiry for you" is "leave
   * the one you have" rather than "erase it".
   *
   * The extra read is confined to that path; a caller supplying an expiry
   * writes in one round trip exactly as before.
   *
   * COMPARE-AND-SET WHEN `expectedUpdatedAt` IS GIVEN (audit F-27), the same
   * pattern and the same reasoning as `patchStrategy` below.
   *
   * This document is a whole-document read-modify-write: `applyDecision` reads
   * it at `service.ts:353`, gates, routes N orders, and writes the recomputed
   * legs back at `:554`. Everything an operator does in that window — "Close
   * leg", a flatten, a Build-screen Place — was silently discarded by whoever
   * wrote last, which is the 2026-08-03 ITC desync shape. `updatedAt` IS the
   * version: the caller pins the one it made its decision against, and a write
   * that does not still find it comes back `'conflict'` so the caller can
   * re-fold its fills onto the fresh legs instead of overwriting them.
   *
   * NO UPSERT on that path. A conflict must never be "resurrect the document"
   * — the row may be gone because the book was deleted, and recreating it is
   * the phantom-book failure `close-all` already has scar tissue for.
   *
   * `null` MEANS CREATE-ONLY, and it closes the hole the version pin left
   * exactly where there was no version to pin. `applyDecision` reading no row
   * at the top of its window used to pass `undefined` and fall back to the
   * blind upsert below — so an operator creating that same book from the Build
   * screen while the orders routed was `$set`-overwritten, with no conflict and
   * no signal. The insert relies on the `{tag, mode}` UNIQUE index in
   * `ensureIndexes`: the database refuses the second writer rather than the
   * application hoping it read first, and the duplicate key comes back as
   * `'conflict'` so the caller re-reads and folds its fills onto the winner's
   * legs like every other loser.
   *
   * ABSENT `expectedUpdatedAt` keeps the historical upsert, deliberately: the
   * seed path (`seed.ts`) has no prior version to pin, and its whole job is to
   * write whatever document is there or not there. It still may not REGRESS the
   * version — see below.
   *
   * `correctionNonce` IS THE FOLD RECEIPT, and it is appended in THIS write —
   * the same `updateOne`, the same document — for the one reason that matters:
   * the reconciler's proof that a fold landed used to live on a DIFFERENT
   * collection (`desk-decisions.fills.N.foldDone`), so a process that died
   * between the two left a book that had been folded and a record that said it
   * had not. The next pass folded the same compensation again, and for a
   * refused CLOSE — the regime allowed to CREATE a leg — that is a second
   * position nobody ordered. One document and one write leaves no window to
   * crash in; `reconcile-live.ts` reads the array back and skips a fold whose
   * nonce is already there.
   *
   * CAPPED AT 200, oldest dropped (`$slice: -200`). A book folded a few times a
   * day for a year is still a small array, but an unbounded one on a document
   * that is read on every decision is a document that eventually stops fitting.
   * 200 is far more history than the 7-day reconcile window can ever revisit.
   */
  async saveBook(
    key: BookKey,
    legs: readonly BridgeLeg[],
    nowMs: number,
    expectedUpdatedAt?: number | null,
    correctionNonce?: string,
  ): Promise<'ok' | 'conflict'> {
    // `$each` + `$slice` rather than a read-modify-write: the cap is applied by
    // the database inside the same update, so two writers cannot both read a
    // 200-long array and both push onto it.
    const push =
      correctionNonce === undefined
        ? {}
        : {
            $push: {
              appliedCorrections: {
                $each: [correctionNonce],
                $slice: -APPLIED_CORRECTIONS_CAP,
              },
            },
          }

    if (expectedUpdatedAt === null) {
      try {
        await this.#db.collection(COLLECTIONS.books).insertOne({
          tag: key.tag,
          mode: key.mode,
          symbol: key.symbol,
          expiry: key.expiry,
          legs,
          updatedAt: nowMs,
          ...(correctionNonce === undefined ? {} : { appliedCorrections: [correctionNonce] }),
        })
        return 'ok'
      } catch (err) {
        // Somebody created this book while we were routing. That is a lost
        // race, not an error: their row describes work that really happened,
        // exactly as ours does.
        if (isDuplicateKey(err)) return 'conflict'
        throw err
      }
    }

    const existing =
      expectedUpdatedAt === undefined || key.expiry === ''
        ? await this.bookDoc(key.tag, key.mode)
        : null
    const expiry = key.expiry === '' ? (existing?.expiry ?? '') : key.expiry
    /**
     * The version must STRICTLY advance, on BOTH paths.
     *
     * Two compare-and-sets landing in the same millisecond would otherwise
     * leave an identical version behind and the next one would be waved through
     * against a document it never read. The unconditional path has the same
     * hazard pointing backwards: it wrote `nowMs` flat, so a writer whose clock
     * is a moment behind a version the compare-and-set already advanced pushed
     * the version DOWN, and a reader holding the higher one would match again.
     * No write may ever move this field backwards.
     */
    const updatedAt =
      expectedUpdatedAt === undefined
        ? Math.max(nowMs, (existing?.updatedAt ?? 0) + 1)
        : Math.max(nowMs, expectedUpdatedAt + 1)
    const filter =
      expectedUpdatedAt === undefined
        ? { tag: key.tag, mode: key.mode }
        : { tag: key.tag, mode: key.mode, updatedAt: expectedUpdatedAt }
    const res = await this.#db.collection(COLLECTIONS.books).updateOne(
      filter,
      {
        $set: {
          tag: key.tag,
          mode: key.mode,
          symbol: key.symbol,
          expiry,
          legs,
          updatedAt,
        },
        ...push,
      },
      expectedUpdatedAt === undefined ? { upsert: true } : {},
    )
    // matchedCount 0 means another writer moved the row between our read and
    // our write. Undefined means a fake that does not model it — treated as
    // matched, since the in-memory fakes are single-threaded by construction.
    if (expectedUpdatedAt !== undefined && res.matchedCount === 0) return 'conflict'
    return 'ok'
  }

  async allBooks(mode: DeskMode): Promise<StoredBook[]> {
    return await this.#db.collection<StoredBook>(COLLECTIONS.books).find({ mode }).toArray()
  }

  /**
   * Every book on one symbol. NOT unique any more — that is the whole point of
   * this key change, and callers that want one book must ask by tag.
   */
  async booksForSymbol(symbol: string, mode: DeskMode): Promise<StoredBook[]> {
    return await this.#db.collection<StoredBook>(COLLECTIONS.books).find({ symbol, mode }).toArray()
  }

  // ------------------------------------------------------------ decisions

  /** Null when this decision has not been seen. Drives idempotent replay. */
  async getDecision(decisionId: string): Promise<StoredDecision | null> {
    return await this.#db
      .collection<StoredDecision>(COLLECTIONS.decisions)
      .findOne({ decisionId })
  }

  /**
   * WHAT A SPENT FLATTEN ID SAYS HAPPENED, or null when it has never been used.
   *
   * `getDecision` above answers `StoredDecision`, which carries neither the
   * `status` nor the `flatten` block `flattenTag` writes — and those are exactly
   * the two facts a caller needs to tell "this id already closed the book" from
   * "this id was consumed by a flatten that closed nothing". Read here rather
   * than widened into `StoredDecision` because a caller BUILDING a decision must
   * still not be able to set them (see `service.ts:StoredDecisionRecord`).
   *
   * The two are independent and both matter. `status` is `DONE` only when every
   * leg routed and resolved; `flat` is `flattenIsFlat`'s answer, which is false
   * for a DONE run over an empty window — it routed nothing and closed nothing,
   * and its id is spent all the same. A record with no `flatten` block at all
   * (this id was claimed by `applyDecision`, or the process died between the
   * claim and the update) reads as not-flat, which is the honest answer: nothing
   * here says a position was closed.
   */
  async flattenOutcome(
    decisionId: string,
  ): Promise<{ readonly status: string; readonly flat: boolean } | null> {
    const doc = await this.#db.collection(COLLECTIONS.decisions).findOne({ decisionId })
    if (doc === null) return null
    const flatten = doc['flatten']
    const flat =
      typeof flatten === 'object' && flatten !== null && (flatten as Record<string, unknown>)['flat'] === true
    return { status: typeof doc['status'] === 'string' ? doc['status'] : '', flat }
  }

  /**
   * Record a decision. Throws on a duplicate `decisionId` (unique index) — the
   * caller treats that as "already applied" and replays the stored result.
   */
  async recordDecision(d: StoredDecision): Promise<void> {
    await this.#db.collection<StoredDecision>(COLLECTIONS.decisions).insertOne(d)
  }

  async listDecisions(symbol: string | null, limit = 100): Promise<StoredDecision[]> {
    const filter = symbol === null ? {} : { symbol }
    return await this.#db
      .collection<StoredDecision>(COLLECTIONS.decisions)
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  }

  // --------------------------------------------------------- declarations

  /** What the desk says it holds (D2). Overwritten each declare; it is a snapshot. */
  async saveDeclaration(
    tag: string,
    symbol: string,
    legs: readonly DeclaredLeg[],
    nowMs: number,
    greeks?: DeclaredGreeks,
  ): Promise<void> {
    /*
      GREEKS ARE OMITTED FROM THE $set RATHER THAN WRITTEN NULL when the
      strategy sent none.

      A failed mark is a gap in measurement, not a measurement of nothing. The
      stored set stays where it was and `declaredAt` still advances, so the
      reader can age it and say how old it is — which is a better answer than
      replacing a real number with a hole every time one mark hiccups. The
      alternative would blank the dashboard's delta on any transient failure.
    */
    await this.#db.collection(COLLECTIONS.declarations).updateOne(
      { tag },
      {
        $set: {
          tag,
          symbol,
          legs,
          declaredAt: nowMs,
          ...(greeks === undefined ? {} : { greeks, greeksAt: nowMs }),
        },
      },
      { upsert: true },
    )
  }

  async loadDeclaration(tag: string): Promise<StoredDeclaration | null> {
    return await this.#db
      .collection<StoredDeclaration>(COLLECTIONS.declarations)
      .findOne({ tag })
  }

  // --------------------------------------------------------------- trades

  async listPaperTrades(
    opts: {
      readonly tag?: string | null | undefined
      readonly symbol?: string | null | undefined
      readonly limit?: number | undefined
    } = {},
  ): Promise<Record<string, unknown>[]> {
    const filter: Record<string, unknown> = {}
    if (opts.tag !== undefined && opts.tag !== null) filter['tag'] = opts.tag
    if (opts.symbol !== undefined && opts.symbol !== null) filter['underlying'] = opts.symbol
    return await this.#db
      .collection(COLLECTIONS.paperTrade)
      .find(filter)
      .sort({ order_timestamp: -1 })
      .limit(opts.limit ?? 200)
      .toArray()
  }

  async listLiveTrades(tag: string | null, limit = 200): Promise<Record<string, unknown>[]> {
    const filter = tag === null ? {} : { tag }
    return await this.#db
      .collection(COLLECTIONS.live)
      .find(filter)
      .sort({ order_timestamp: -1 })
      .limit(limit)
      .toArray()
  }

  async loadKillSwitch(): Promise<KillSwitchState> {
    const doc = await this.#db
      .collection<KillSwitchState & { _id?: string }>(COLLECTIONS.safety)
      .findOne({ _id: 'killswitch' })
    return doc === null ? DEFAULT_KILL_SWITCH : {
      enabled: doc.enabled === true,
      reason: doc.reason ?? '',
      setBy: doc.setBy ?? '',
      setAt: doc.setAt ?? 0,
    }
  }

  async saveKillSwitch(state: KillSwitchState): Promise<void> {
    await this.#db
      .collection(COLLECTIONS.safety)
      .updateOne({ _id: 'killswitch' }, { $set: { ...state } }, { upsert: true })
  }

  /** The broker link — wish AND the gateway's ack, one document. See `safety.ts`. */
  async loadBrokerLink(): Promise<BrokerLinkState> {
    const doc = await this.#db
      .collection<Record<string, unknown> & { _id?: string }>(COLLECTIONS.safety)
      .findOne({ _id: 'broker-link' })
    return readBrokerLinkDoc(doc)
  }

  /**
   * Write the WISH only. `applied`/`appliedAt`/`appliedError` belong to the
   * gateway; a `$set` of the four wish fields leaves its last answer in place,
   * which is exactly what the dashboard needs to show "asked, not yet done".
   */
  async saveBrokerLink(desire: Pick<BrokerLinkState, 'desired' | 'reason' | 'setBy' | 'setAt'>): Promise<void> {
    await this.#db
      .collection(COLLECTIONS.safety)
      .updateOne({ _id: 'broker-link' }, { $set: { ...desire } }, { upsert: true })
  }

  // ----------------------------------------------------------- strategies

  /**
   * One registry row, or null when the tag has never been registered.
   *
   * Null is a MEANINGFUL answer here — the gate rejects an unknown tag rather
   * than treating a missing row as "no restriction configured".
   */
  async loadStrategy(tag: string): Promise<StrategyRow | null> {
    const doc = await this.#db.collection(COLLECTIONS.strategies).findOne({ tag })
    return strategyFromDoc(doc)
  }

  /** Sorted by tag so the portal's list does not reshuffle between polls. */
  async listStrategies(): Promise<StrategyRow[]> {
    const docs = await this.#db.collection(COLLECTIONS.strategies).find({}).sort({ tag: 1 }).toArray()
    return docs.map((d) => strategyFromDoc(d)).filter((r): r is StrategyRow => r !== null)
  }

  /**
   * Create or update a row wholesale. The seeding path (Phase C fills the
   * registry from the process table); NOT what the PATCH endpoint uses, because
   * an operator editing one field must not silently reset the others.
   */
  async registerStrategy(row: Partial<StrategyRow> & { tag: string }, nowMs: number): Promise<StrategyRow> {
    const merged: StrategyRow = {
      ...DEFAULT_STRATEGY,
      label: row.tag,
      ...row,
      updatedAt: nowMs,
    }
    await this.#db
      .collection(COLLECTIONS.strategies)
      .updateOne({ tag: row.tag }, { $set: { ...merged } }, { upsert: true })
    return merged
  }

  /**
   * ADD a strategy to one mode: create the row if the tag is new, otherwise add
   * the mode key to the row that exists. `'exists'` when it is already added.
   *
   * The two paths are one method because they are one operator action ("put
   * this on the live page"), and because splitting them would make the
   * new-tag/existing-tag race the caller's problem.
   *
   * INSERT, not the upsert `registerStrategy` uses, and that is the whole
   * difference between them. An upsert reached from HTTP would let an add at a
   * tag that already exists overwrite an operator's switches, live lots and
   * autostart with the form's defaults — silently turning an "add this
   * strategy" mistake into a reset of a running row. So the existing-row path
   * touches NOTHING but the mode key: not the label, not the kind, not the
   * lots. The unique index on `tag` is what makes the create path a real check
   * rather than a read-then-write two callers can both pass.
   *
   * The added mode is always `{ enabled: false }`, and that is not negotiable
   * by the caller — see `validateStrategyCreate`.
   */
  async addStrategyMode(
    row: Partial<StrategyRow> & { tag: string },
    mode: DeskMode,
    nowMs: number,
  ): Promise<StrategyRow | 'exists'> {
    const existing = await this.loadStrategy(row.tag)
    if (existing !== null) {
      if (isAdded(existing.modes, mode)) return 'exists'
      const next: StrategyRow = {
        ...existing,
        modes: withMode(existing.modes, mode, { enabled: false }),
        // `updatedAt` IS the version — see `patchStrategy`. It must advance, or
        // a compare-and-set against the row an operator was looking at would
        // wave through an edit made before the mode existed.
        updatedAt: Math.max(nowMs, existing.updatedAt + 1),
      }
      await this.#db
        .collection(COLLECTIONS.strategies)
        .updateOne({ tag: row.tag }, { $set: { ...next } })
      return next
    }
    const created: StrategyRow = {
      ...DEFAULT_STRATEGY,
      label: row.tag,
      ...row,
      modes: withMode({}, mode, { enabled: false }),
      updatedAt: nowMs,
    }
    try {
      await this.#db.collection(COLLECTIONS.strategies).insertOne({ ...created })
    } catch (err) {
      // Another caller created the same tag between our read and our insert.
      // Reported as 'exists' rather than retried: the operator asked for a
      // specific add and should be told what actually happened.
      if (isDuplicateKey(err)) return 'exists'
      throw err
    }
    return created
  }

  /**
   * REMOVE a mode from a row — take it off that page entirely.
   *
   * The row itself survives with its other mode, its live lots and its
   * autostart, because "remove from live" is not "delete this strategy".
   * `null` when the tag does not exist, `'absent'` when it was never added to
   * that mode; the caller turns both into a 404 rather than pretending a no-op
   * succeeded.
   *
   * AND IT SURVIVES WITH NO MODE AT ALL. This is the Strategies page's route
   * as well as the book erase's, and for a registered book an emptied row and
   * a missing row are NOT the same read at the supervisor: its registry poll
   * (`apps/supervisor/src/registry-poll.ts`) reads `modes: {}` through `isOn`
   * as OFF, so a flat book stands down quietly, but reads NO row as UNKNOWN —
   * and unknown deliberately keeps deciding, because a blip on one collection
   * must not stand every book down. Delete the row from under a book still
   * `desired: 'running'` and the host posts, desk-api answers `UnknownStrategy`
   * 403, and the book rolls back and re-posts every cooldown with an ERROR a
   * minute. The `?all=1` picker loses the row too, so the gate's own remedy
   * ("add it on the live strategies page") no longer offers it. Deleting an
   * orphaned external row is `deleteOrphanStrategy`'s job, called by the erase
   * route alone, where the registry row is known to be gone.
   *
   * Refusing while a position is open is the CALLER's job (`routes/desk.ts`),
   * because only it can see the runner's ledger. The store must not decide it,
   * or a repair script with a good reason would have no way past.
   */
  async removeStrategyMode(
    tag: string,
    mode: DeskMode,
    nowMs: number,
  ): Promise<StrategyRow | null | 'absent'> {
    const current = await this.loadStrategy(tag)
    if (current === null) return null
    if (!isAdded(current.modes, mode)) return 'absent'
    const next: StrategyRow = {
      ...current,
      modes: withMode(current.modes, mode, null),
      updatedAt: Math.max(nowMs, current.updatedAt + 1),
    }
    // `$set: { modes: ... }` REPLACES the whole sub-document, which is what
    // makes the key genuinely disappear. A dotted `$set` of the surviving mode
    // would leave the removed one in place and the page would keep listing it —
    // and pairing this `$set` with a `$unset` of `modes.<mode>` is a Mongo path
    // conflict, not a belt-and-braces.
    await this.#db.collection(COLLECTIONS.strategies).updateOne({ tag }, { $set: { ...next } })
    return next
  }

  /**
   * DELETE an EXTERNAL row that is added to NOTHING — the book erase's
   * last step, and nobody else's.
   *
   * An external row exists because a registration (`routes/books.ts`) needed
   * a switch for its book — it has no autostart, no runner, and its
   * `dailyLimits` were armed from that book's dials. Once the book is erased
   * and its last membership is gone there is nothing left for the row to be,
   * and leaving it was not harmless: the daily roll erases four books a
   * trading day, so four `modes: {}` rows a day piled up in `desk-strategies`,
   * hidden from the Strategies list but offered by its `?all=1` add picker as
   * strategies that could be added. A re-register puts a fresh row back (the
   * converge branch of the create route re-adds the mode and re-arms the
   * guard), exactly as it does for a row removed from the Strategies page.
   *
   * The filter is the whole precondition, so a mode added between the
   * caller's read and this write is never deleted from under its adder: only
   * a row that is external AND empty at the moment of the write goes. A HOSTED
   * row never matches — it is the desk's record of a strategy the runner
   * starts, and taking it off both pages is a stop, not a delete. Whether any
   * registry row still needs the row is the CALLER's check (`routes/books.ts`
   * asks the registry for the other rail), for the reason `removeStrategyMode`
   * gives: the supervisor reads a missing row as UNKNOWN, and unknown keeps
   * deciding. Returns whether a row went.
   */
  async deleteOrphanStrategy(tag: string): Promise<boolean> {
    const res: unknown = await this.#db
      .collection(COLLECTIONS.strategies)
      .deleteOne({ tag, kind: 'external', modes: {} })
    // `Database.deleteOne` is typed `unknown` (the fake in some tests models
    // no result), so the count is read the way `purgeTagHistory` reads it.
    const deleted = (res as { deletedCount?: number } | null)?.deletedCount
    return typeof deleted === 'number' && deleted > 0
  }

  /**
   * Clear the filler `disabledReason` the seeder used to write.
   *
   * A one-off repair, and narrow on purpose. `disabledReason` exists to record
   * why a HUMAN switched something off ("margin call", "misfiring on gap
   * days"); the seeder filled it with "not yet enabled by an operator", which
   * only restates a switch that is off — a fact the control beside it already
   * shows. Once every row carries a reason the field stops meaning anything and
   * a real one is invisible in the noise.
   *
   * The filter pins the EXACT seeded text, so an operator's own note can never
   * match it, and the caller additionally checks the row is still switched off
   * everywhere. Returns whether a row was cleared, so the boot log can say.
   */
  /**
   * Correct an `autostartAt` the seed no longer writes.
   *
   * Matched on the EXACT old value, so an operator who chose that time keeps
   * it — the same discipline as `clearSeededDisabledReason`. The one case this
   * exists for is the mirrors' 0914, which `MirrorHost` never honoured: seeding
   * is insert-only by design, so a row already in Mongo would display a start
   * time nothing acts on, forever.
   */
  async repairSeededAutostart(tag: string, from: string, to: string): Promise<boolean> {
    const res = await this.#db
      .collection(COLLECTIONS.strategies)
      .updateOne({ tag, autostartAt: from }, { $set: { autostartAt: to } })
    return (res.matchedCount ?? 0) > 0
  }

  async deleteUnusedHostedRow(tag: string): Promise<boolean> {
    const books = await this.#db.collection(COLLECTIONS.booksRegistry).countDocuments({ tag })
    if (books > 0) return false
    for (const c of [COLLECTIONS.paperTrade, COLLECTIONS.gatewayOrders]) {
      if ((await this.#db.collection(c).countDocuments({ tag })) > 0) return false
    }
    const res: unknown = await this.#db
      .collection(COLLECTIONS.strategies)
      .deleteOne({ tag, kind: 'hosted' })
    const n = (res as { deletedCount?: number } | null)?.deletedCount
    return typeof n === 'number' && n > 0
  }

  async clearSeededDisabledReason(tag: string, seeded: string): Promise<boolean> {
    const res = await this.#db
      .collection(COLLECTIONS.strategies)
      .updateOne({ tag, disabledReason: seeded }, { $set: { disabledReason: '' } })
    // `undefined` from a fake that does not model matchedCount: report false
    // rather than claiming a repair we cannot evidence.
    return (res.matchedCount ?? 0) > 0
  }

  /**
   * Apply an operator's edit. Null when the tag does not exist — PATCH must not
   * conjure a row, or a typo in the URL would create a phantom strategy that
   * nothing ever runs while the real one stays untouched.
   *
   * COMPARE-AND-SET, not a bare read-modify-write. `expectedUpdatedAt` pins the
   * row version the CALLER made its decision against, and the write only lands
   * if the row still carries it.
   *
   * This is a security control, not tidiness. The re-auth gate in
   * `routes/desk.ts` decides whether a password is needed by reading the row,
   * and the write happens later; without the version pin two concurrent patches
   * interleave and the row that lands is one neither request was gated
   * against. Under the old `enabled` + `mode` pair that was an outright bypass
   * — `{enabled:true}` and `{mode:'live'}` each looked harmless alone and
   * COMBINED into an unconfirmed live enable. `modes` removes that particular
   * split (one field carries the whole answer), but the pin stays: a patch
   * setting `liveLots` still races a patch arming live, and the bulk switch
   * below writes through this same path. This file previously asserted "the
   * writer is one operator clicking a toggle", which is exactly the assumption
   * a gate must not inherit.
   *
   * Returns `'conflict'` when the row moved; the caller re-reads and retries, so
   * the second request re-evaluates the gate against the state the first left.
   */
  async patchStrategy(
    tag: string,
    patch: StrategyPatch,
    nowMs: number,
    expectedUpdatedAt?: number,
  ): Promise<StrategyRow | null | 'conflict'> {
    const current = await this.loadStrategy(tag)
    if (current === null) return null
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return 'conflict'
    // `updatedAt` IS the version, so it must strictly advance. Two patches
    // landing in the same millisecond would otherwise produce an identical
    // version and the compare-and-set would wave the second one through.
    const merged = applyStrategyPatch(current, patch, nowMs)
    const next: StrategyRow = { ...merged, updatedAt: Math.max(nowMs, current.updatedAt + 1) }
    const filter: Record<string, unknown> =
      expectedUpdatedAt === undefined ? { tag } : { tag, updatedAt: expectedUpdatedAt }
    /**
     * AN OPTIONAL FIELD THAT IS NOW ABSENT HAS TO BE `$unset`, NOT OMITTED.
     *
     * `$set` only writes the keys it is given, so a patch that CLEARS
     * `dailyLimits` — or a morning re-arm that clears `disabledByGuard` — would
     * produce a `next` without the key, `$set` would leave the old value in the
     * document, and the very next read would resurrect it. For the day guard
     * that is the difference between "the operator disarmed the stop" and a
     * stop that quietly stays armed, and between a rail re-arming tomorrow and
     * one that re-arms every morning forever.
     *
     * No path conflict: `next` never carries a key that is also unset here.
     */
    const unset: Record<string, ''> = {}
    for (const key of ['dailyLimits', 'disabledByGuard'] as const) {
      if (next[key] === undefined) unset[key] = ''
    }
    const update: Record<string, unknown> =
      Object.keys(unset).length === 0 ? { $set: { ...next } } : { $set: { ...next }, $unset: unset }
    const res = await this.#db.collection(COLLECTIONS.strategies).updateOne(filter, update)
    // matchedCount 0 means another writer won the race between our read and our
    // write. Undefined means a fake that does not model it — treated as matched,
    // since the in-memory fakes are single-threaded by construction.
    if (expectedUpdatedAt !== undefined && res.matchedCount === 0) return 'conflict'
    return next
  }

  /** Stamp liveness. Separate from `patchStrategy` so a heartbeat never
   *  touches a switch — the two writers must not race over `enabled`. */
  async touchStrategy(tag: string, nowMs: number): Promise<void> {
    await this.#db.collection(COLLECTIONS.strategies).updateOne({ tag }, { $set: { lastSeenAt: nowMs } })
  }

  // ------------------------------------------------------- books registry

  /** Every registered book on one rail, sorted by tag so the page does not reshuffle. */
  async listBooks(mode: DeskMode): Promise<BookRow[]> {
    const docs = await this.#db
      .collection(COLLECTIONS.booksRegistry)
      .find({ mode })
      .sort({ tag: 1 })
      .toArray()
    return docs.map((d) => bookFromDoc(d)).filter((r): r is BookRow => r !== null)
  }

  /** One row, or null when the tag has no book registered on that rail. */
  async getBook(tag: string, mode: DeskMode): Promise<BookRow | null> {
    const doc = await this.#db.collection(COLLECTIONS.booksRegistry).findOne({ tag, mode })
    return bookFromDoc(doc)
  }

  /**
   * The registry document UNMAPPED, for readers of fields `BookRow` does not
   * model.
   *
   * `bookFromDoc` is an allowlist — it builds a `BookRow` from the lifecycle
   * fields and drops everything else, which is what keeps an unknown field in
   * Mongo from reaching the portal's switches. That is the right default and
   * this is the deliberate exception: the decision reason and action log are
   * display-only, they change shape independently of the lifecycle contract,
   * and widening `BookRow` to carry them would put telemetry into the type
   * every trading gate reads.
   *
   * Callers get `Record<string, unknown>` and must narrow each field
   * themselves. Do NOT use this to read a lifecycle field — `getBook` exists
   * so those go through validation exactly once.
   */
  async getBookRaw(tag: string, mode: DeskMode): Promise<Record<string, unknown> | null> {
    return await this.#db.collection(COLLECTIONS.booksRegistry).findOne({ tag, mode })
  }

  /**
   * Erase a tag's TRADING HISTORY — the journalled decisions and the paper
   * order rows.
   *
   * PAPER ONLY, enforced at the route. On the live rail these rows are the
   * desk's copy of orders that really reached a broker, and the broker's own
   * record cannot be deleted — so purging live history would leave the two
   * permanently disagreeing, with no way to tell which is right.
   *
   * It also deletes the SOURCE OF TRUTH for what a tag holds. `flattenTag` and
   * the book-delete guard both reconstruct the position from these fills; erase
   * them while anything is open and the position becomes unknowable — which is
   * why the route refuses unless the tag is verifiably flat.
   *
   * `positional` (the LIVE order rail) is deliberately NOT touched here at all.
   */
  async purgeTagHistory(tag: string): Promise<{ decisions: number; orders: number }> {
    const decisions = await this.#db.collection(COLLECTIONS.decisions).deleteMany({ tag })
    const orders = await this.#db.collection(COLLECTIONS.paperTrade).deleteMany({ tag })
    const count = (r: unknown): number =>
      typeof (r as { deletedCount?: number })?.deletedCount === 'number'
        ? ((r as { deletedCount: number }).deletedCount)
        : 0
    return { decisions: count(decisions), orders: count(orders) }
  }

  /**
   * Erase a book: its registry row AND the stored position record.
   *
   * BOTH, because they are separate records and leaving either behind is what
   * made "delete the book and build it again" impossible. Removing only the
   * strategy row left a registry row that blocked re-registration; removing
   * only the registry row would leave a `desk-books` document whose legs still
   * drive the feed's subscriptions and every P&L view.
   *
   * The CALLER decides whether erasing is allowed — this does not check for
   * open legs. That guard belongs at the route, where it can name what is
   * still held and point at `close-all`; a store method that silently refused
   * would be a policy hidden in a data access layer.
   *
   * `desk-book-series` is deliberately NOT touched: the series row is what
   * keeps this tag's reports grouped after the registry row is gone.
   */
  async eraseBook(tag: string, mode: DeskMode): Promise<void> {
    await this.#db.collection(COLLECTIONS.booksRegistry).deleteOne({ tag, mode })
    await this.#db.collection(COLLECTIONS.books).deleteOne({ tag, mode })
  }

  /**
   * Create a registry row wholesale. Used only by the create route, which
   * always passes `desired`/`actual` STOPPED (`DEFAULT_BOOK`) — creating a book
   * is never itself a trading permission.
   */
  async upsertBook(row: Omit<BookRow, 'series'> & { readonly series?: string }): Promise<void> {
    // A caller that states no series (one written before WS2) still stores
    // one — the same `${symbol}-${variant}` a create without one is given.
    const series = row.series ?? deriveSeries(row.symbol, row.variant)
    await this.#db
      .collection(COLLECTIONS.booksRegistry)
      .updateOne({ tag: row.tag, mode: row.mode }, { $set: { ...row, series } }, { upsert: true })
  }

  /**
   * Flip the operator's intent. NEVER touches `actual` — the two are separate
   * writers (see the module comment in `books-registry.ts`), and a `/start`
   * that also stamped `actual: 'running'` would let the registry claim a
   * supervisor is running before it has said so itself.
   */
  async setDesired(
    tag: string,
    mode: DeskMode,
    desired: BookState,
    nowMs: number,
  ): Promise<BookRow | null> {
    await this.#db
      .collection(COLLECTIONS.booksRegistry)
      .updateOne({ tag, mode }, { $set: { desired, updatedAt: nowMs } })
    return await this.getBook(tag, mode)
  }

  /**
   * Dials only — an operator's edit to the tuning knobs, not the lifecycle.
   *
   * MERGES per key with a dotted-path `$set` (`dials.target_pnl`, …) rather
   * than replacing the whole `dials` object. A plain `$set: { dials }` would
   * silently delete every knob not named in this patch — for a book that
   * matters: `target_pnl` is the hard profit target the strategy flattens
   * and banks at, and losing it changes what the strategy does, not just
   * how it is displayed.
   *
   * Dotted-path `$set` also keeps this atomic under two concurrent PATCHes
   * to different keys of the same book — a read-modify-write merge here
   * would let the second write clobber the first's key with a stale read.
   * `validateBookDialsPatch` already refuses an empty `dials` and any
   * non-finite-number value (so `null` cannot be used to remove a knob);
   * this patch can only add or overwrite named keys, never delete one.
   *
   * `setBy` — WHO — IS PART OF THE SAME `$set` (F-29). A live book's dials
   * change what the strategy does with real money, and a dial change with no
   * principal on it leaves a book behaving differently from yesterday with
   * nothing to say who made it so. Written in a second update it would be an
   * attribution a crash can lose; written here it lands with the dial or not
   * at all.
   */
  async patchBookDials(
    tag: string,
    mode: DeskMode,
    dials: Readonly<Record<string, DialValue>>,
    nowMs: number,
    setBy: string,
  ): Promise<BookRow | null> {
    const set: Record<string, number | boolean | string> = {
      updatedAt: nowMs,
      dialsSetBy: setBy,
      dialsSetAt: nowMs,
    }
    for (const [k, v] of Object.entries(dials)) {
      set[`dials.${k}`] = v
    }
    await this.#db.collection(COLLECTIONS.booksRegistry).updateOne({ tag, mode }, { $set: set })
    return await this.getBook(tag, mode)
  }

  /** The supervisor reporting its own state back. The only writer of `actual`. */
  async setActual(
    tag: string,
    mode: DeskMode,
    actual: BookState,
    lastMarkAt: number,
    lastDecision: string,
    nowMs: number,
  ): Promise<BookRow | null> {
    await this.#db
      .collection(COLLECTIONS.booksRegistry)
      .updateOne({ tag, mode }, { $set: { actual, lastMarkAt, lastDecision, updatedAt: nowMs } })
    return await this.getBook(tag, mode)
  }

  // ---------------------------------------------------- decision reasons

  /**
   * The strategy's own account of what it is doing, for the run page.
   *
   * WHY THIS LIVES ON THE REGISTRY DOC rather than in `desk-decisions`: that
   * collection is the P&L journal (`PnlStore.loadFills` scans 30 days of it)
   * and it is written from inside `applyDecision`, whose ordering is
   * crash-safety-critical. A display field has no business in either. One
   * overwritten field per book also cannot grow, where a row per mark would
   * add ~800 a day per book that all say the same thing.
   *
   * NO UPSERT. A reason for a book with no registry row describes a book that
   * does not exist; creating one here would invent a row that `bookFromDoc`
   * then has to defend against, and an unregistered tag is a misconfiguration
   * that should stay visible rather than be papered over by telemetry.
   *
   * Called on EVERY mark including replays — see the route handler. That is
   * the point: `applyDecision` returns early for a repeated `decisionId`, and
   * the supervisor posts the same id several times per five-minute slot, so a
   * reason written inside that path would freeze at the slot's first mark.
   */
  async recordDecisionReason(
    tag: string,
    mode: DeskMode,
    action: string | undefined,
    reason: string | undefined,
    nowMs: number,
  ): Promise<void> {
    const set: Record<string, unknown> = { lastReasonAt: nowMs }
    // Only the fields actually supplied: a desk that sends `action` but no
    // `reason` must not blank a good reason with `undefined`.
    if (action !== undefined) set['lastAction'] = action
    if (reason !== undefined) set['lastReason'] = reason
    await this.#db.collection(COLLECTIONS.booksRegistry).updateOne({ tag, mode }, { $set: set })
  }

  /**
   * Append one decision that actually traded.
   *
   * CAPPED IN THE WRITE with `$slice: -200`, not trimmed by a later job: the
   * cap is the only thing standing between a pathological book and an
   * unbounded document, and a cleanup that runs separately is a cleanup that
   * can be down. `-200` keeps the NEWEST 200 (a negative slice takes from the
   * end), which is the half worth keeping.
   *
   * Books live to expiry and adjust rarely — the first live books carried 18
   * and 11 fills across their whole life — so in practice this holds the
   * complete history and the cap never engages.
   */
  async appendDecisionAction(
    tag: string,
    mode: DeskMode,
    entry: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#db
      .collection(COLLECTIONS.booksRegistry)
      .updateOne({ tag, mode }, { $push: { actionLog: { $each: [entry], $slice: -200 } } })
  }

  // ------------------------------------------------------------ variants

  /**
   * The variant catalogue, READ-ONLY since the D9 cutover.
   *
   * `putVariants` went with `POST /v1/desk/variants` and the Python supervisor
   * that was its only writer. What is stored stays: it is the only statement of
   * what dials a book registered under a published variant had, and both
   * readers (`routes/payoff.ts`'s defaults merge, the dials PATCH's unknown-key
   * check) already degrade to "unpublished" for a variant it does not carry.
   */
  async listVariants(): Promise<VariantRow[]> {
    return await this.#db.collection<VariantRow>(COLLECTIONS.variants).find({}).toArray()
  }

  /**
   * Append refusals to the order journal.
   *
   * NEVER THROWS, for the same reason `OrderJournal.record` does not: losing the
   * record of a rejection is bad, but failing the request because the journal
   * write failed would turn a clean refusal into a 500.
   */
  async journalBlocked(events: readonly Record<string, unknown>[]): Promise<void> {
    if (events.length === 0) return
    try {
      await this.#db.collection(COLLECTIONS.orderEvents).insertMany(events)
    } catch {
      // Deliberately swallowed — see above.
    }
  }

  collection<T = Record<string, unknown>>(name: string): Collection<T> {
    return this.#db.collection<T>(name)
  }
}
