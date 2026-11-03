/**
 * THE PAPER FILL, BOOKED WHEN IT ACTUALLY HAPPENS (D14, plan Task 18).
 *
 * WHY THIS FILE EXISTS. Until now an engine paper decision was booked
 * SYNCHRONOUSLY: `PaperRail` wrote a `COMPLETE` row and `applyDecision` folded
 * the leg into `desk-books` in the same request, at the decision-time mark. The
 * paper session therefore rehearsed none of the machinery a live order's
 * outcome depends on — no queue, no claim, no gates, no peg, no tranche cursor,
 * no fill correlation — and every one of those would have been met for the
 * first time in a live session. That is precisely the failure a rehearsal
 * exists to find.
 *
 * So an engine paper order is now queued in `desk-gateway-orders` like a live
 * one, worked by the gateway against the simulator, and filled when a tick
 * crosses it. This pass is the far end of that: it reads the gateway's own
 * terminal record and books what the order actually did onto the desk.
 *
 * THE MIRROR OF `reconcile-live.ts`, AND ITS OPPOSITE. That pass corrects a
 * fill the desk booked optimistically DOWN to what the broker did, and may
 * never grow a position. This one books a fill the desk deliberately did NOT
 * book, so it adds — which is safe here for the one reason it would not be
 * there: nothing has been booked yet, the decision's `fills` array is empty by
 * construction (`service.ts:worksAsync`), and the quantity is capped at what
 * the decision planned.
 *
 * THE DIRECTIVES, and each of them is load-bearing:
 *
 *  1. ONLY `via: 'engine'` PAPER DECISIONS. The marker is stamped on the record
 *     at claim time; a decision that books itself at route time is never
 *     touched here, so a live fill can never be folded in twice.
 *  2. NEVER MORE THAN THE DECISION PLANNED. The quantity is `min(what the
 *     gateway says filled, what the plan asked for)`. A simulator that answered
 *     a larger fill than the order is a bug, and a bug must not become a
 *     position.
 *  2b. ONLY AN `open` MAY CREATE A LEG. The deferred fold opens a window the
 *     synchronous path did not have — an operator can empty the book between
 *     the decision and its fill — and a close arriving at a book that no longer
 *     holds the leg would OPEN one the other way. See `foldIntoBook`.
 *  3. THE RECORD FIRST, THE BOOK SECOND, THE MARK LAST — `reconcile-live.ts`'s
 *     ordering, for its reason: `desk-decisions` is what P&L reads, so a crash
 *     after it still leaves the money correct and only the derived book lagging.
 *  4. EVERY STEP IDEMPOTENT. The record push is conditional on the order id not
 *     already being claimed; the book fold rides the book's own
 *     `appliedCorrections` receipt, written in the SAME update as the legs. A
 *     crash anywhere re-runs cleanly.
 *  5. ONE BAD DOCUMENT NEVER STOPS THE PASS, and a document that FAILED is not
 *     marked — it is retried next tick.
 *
 * IT PLACES NOTHING, CANCELS NOTHING and reads no market data. Its only inputs
 * are two collections this process already owns.
 */

import {
  refoldOnConflict,
  refoldRoutedFills,
  type BookWriteStore,
  type RefoldFill,
} from './book-write.ts'
import type { BridgeLeg, DeskMode, Fill } from './contract.ts'
import { notifySupervisor } from './engine-notify.ts'
// The SAME id split and the SAME terminal-state list the live reconciler uses.
// A second copy of either is a second thing to get wrong about one collection.
import { restoreView, splitOrderId, TERMINAL_STATES, type ReconcileMaster } from './reconcile-live.ts'
import { COLLECTIONS, type Collection } from './store.ts'

const DEFAULT_INTERVAL_MS = 2_000
/**
 * Two hours. Far shorter than the live reconciler's week, because there is
 * nothing here to repair retroactively: an engine paper order older than this
 * belongs to a supervisor session that has long since moved on, and booking its
 * fill into today's book would invent a leg rather than record one. The bound
 * also means a first deploy — where every historical document is unmarked —
 * scans nothing at all.
 */
const DEFAULT_LOOKBACK_MS = 2 * 60 * 60 * 1000
/** Bounded per pass so one tick's work stays one tick's work. */
const DEFAULT_BATCH = 50

/** The states whose `filledQty` is a REAL partial fill to be believed. */
const PARTLY_FILLED_STATES = new Set(['PARTIAL', 'HALTED'])

/**
 * The persistence this needs, as a narrow port — `DeskStore` satisfies it
 * structurally, which is what lets every test here run against a fake.
 */
export interface PaperFoldStore extends BookWriteStore {
  collection<T = Record<string, unknown>>(name: string): Collection<T>
  journalBlocked(events: readonly Record<string, unknown>[]): Promise<void>
}

/** One fill, as the in-memory book is told about it (`service.ts:#tellBook`). */
export interface PaperFoldJournalEntry {
  readonly tag: string
  readonly mode: DeskMode
  readonly createdAt: number
  readonly fills: readonly Fill[]
}

export interface PaperFoldDeps {
  readonly store: PaperFoldStore
  /** Read per pass, not captured: the master is refreshed on its own timer. */
  readonly master: () => ReconcileMaster
  /** The websocket push. Absent when no dashboard is attached. */
  readonly notify?: (mode: DeskMode, event: Record<string, unknown>) => void
  /** The in-memory book, told about fills the moment they become real. */
  readonly journal?: (entry: PaperFoldJournalEntry) => void
  /**
   * Where the supervisor's nudge endpoint is, when it is not the default.
   * Present for the tests; production reads the environment.
   */
  readonly nudge?: { readonly port?: number; readonly token?: string }
  readonly now: () => number
  readonly log: (message: string, detail?: Record<string, unknown>) => void
}

export interface PaperFoldOptions {
  readonly lookbackMs?: number
  readonly batchSize?: number
  readonly intervalMs?: number
}

export interface PaperFoldPass {
  /** True when a pass was already in flight and this call did nothing. */
  readonly busy: boolean
  readonly scanned: number
  /** Orders whose outcome reached the ledger this pass. */
  readonly folded: number
  readonly failed: number
}

const IDLE: PaperFoldPass = { busy: true, scanned: 0, folded: 0, failed: 0 }

/**
 * THE GATEWAY DOCUMENTS ONE FOLD PASS WOULD TAKE, oldest first — and nothing
 * else: it reads, it never writes. The pass itself uses it, and so does the
 * operator's one-off catch-up (`cli.ts fold-paper`), whose dry run is this list.
 */
export async function listFoldable(
  store: Pick<PaperFoldStore, 'collection'>,
  now: number,
  lookbackMs: number,
  limit: number = DEFAULT_BATCH,
): Promise<Record<string, unknown>[]> {
  return await store
    .collection(COLLECTIONS.gatewayOrders)
    .find({
      // The whole scope of the pass, stated in the query. Everything the live
      // reconciler owns is excluded by this one clause.
      mode: 'paper',
      state: { $in: TERMINAL_STATES },
      deskFolded: { $ne: true },
      /**
       * RECENT BY EITHER CLOCK. Created inside the window, or WENT TERMINAL
       * inside it (`resolvedAt`, stamped by every `markTerminal`). Created alone
       * missed the 2026-10-01 hedge close: it rested three days, the gateway's
       * restart sweep marked it REJECTED on 4 Oct, and this pass never looked —
       * so the decision stayed WORKING here while the gateway said REJECTED,
       * and the supervisor held it `inFlight`. An order that went terminal a
       * minute ago is news whenever it was created; history (created AND
       * resolved long ago) is still out.
       */
      $or: [{ createdAt: { $gt: now - lookbackMs } }, { resolvedAt: { $gt: now - lookbackMs } }],
    })
    // OLDEST FIRST: fills are folded in the order the orders were placed,
    // which is the order the book was built in.
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray()
}

export function createPaperFillFolder(
  deps: PaperFoldDeps,
  opts: PaperFoldOptions = {},
): { run(): Promise<PaperFoldPass> } {
  const lookbackMs = positive(opts.lookbackMs, DEFAULT_LOOKBACK_MS)
  const batchSize = positive(opts.batchSize, DEFAULT_BATCH)
  let running = false

  const run = async (): Promise<PaperFoldPass> => {
    // SINGLE FLIGHT, as the live reconciler is: a pass that outruns its
    // interval must not have a second copy of itself folding one fill twice.
    if (running) return IDLE
    running = true
    try {
      const now = deps.now()
      const docs = await listFoldable(deps.store, now, lookbackMs, batchSize)

      let folded = 0
      let failed = 0
      for (const doc of docs) {
        try {
          if (await foldOne(deps, doc, now)) folded++
        } catch (err) {
          // FAIL SOFT and DO NOT MARK — one unreadable document must not cost
          // the others their fold, and leaving it unmarked is what makes the
          // next pass try again.
          failed++
          deps.log('paper fold: one order failed and was left for the next pass', {
            clientOrderId: str(doc['clientOrderId']),
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return { busy: false, scanned: docs.length, folded, failed }
    } finally {
      running = false
    }
  }

  return { run }
}

/**
 * Wire the pass onto an interval.
 *
 * FASTER THAN THE LIVE RECONCILER (2s against its 60s), and it has to be: the
 * supervisor holds a decision `inFlight` until its fills are accounted for, so
 * this interval is the floor on how long a paper book waits between deciding
 * and knowing. It is one indexed query against a small collection.
 *
 * `.catch` on every tick and `unref()` on the timer, for `pnl-jobs.ts`'s
 * reasons: an unhandled rejection inside a timer takes down the process that
 * routes orders, and a housekeeping timer must never hold a restart open.
 */
export function startPaperFillFolder(
  deps: PaperFoldDeps,
  opts: PaperFoldOptions = {},
): () => void {
  const folder = createPaperFillFolder(deps, opts)
  const intervalMs = positive(opts.intervalMs, DEFAULT_INTERVAL_MS)
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void folder.run().catch((err: unknown) => {
      deps.log('paper fold pass failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, intervalMs)
  timer.unref()
  return (): void => {
    stopped = true
    clearInterval(timer)
  }
}

/** True when this document's outcome reached the ledger. Throws only on I/O. */
async function foldOne(
  deps: PaperFoldDeps,
  doc: Record<string, unknown>,
  now: number,
): Promise<boolean> {
  const clientOrderId = str(doc['clientOrderId'])
  if (clientOrderId === '') {
    deps.log('paper fold: a gateway order carries no clientOrderId — skipped', { doc })
    return false
  }
  const { decisionId, index } = splitOrderId(clientOrderId)
  const decision = await deps.store
    .collection(COLLECTIONS.decisions)
    // `mode: 'paper'` and `via: 'engine'` are PART OF THE KEY, not a tidiness
    // filter: together they are what makes it impossible for this pass to read
    // — let alone write — a record that books itself at route time.
    .findOne({ decisionId, mode: 'paper', via: 'engine' })

  if (decision === null) {
    deps.log('paper fold: no engine paper decision for this order — left alone', {
      clientOrderId,
      decisionId,
    })
    // NOT marked. A document with no decision is either a decision still being
    // written (the claim lands before the orders route) or one this pass does
    // not own; either way the honest act is to leave it exactly as it is.
    return false
  }

  /**
   * STILL ROUTING — WAIT, never book. `applyDecision` claims the id with
   * `plannedFills` parked and `status: 'ROUTING'`, and only promotes it to
   * `WORKING` once every order is out. A fill arriving inside that window (the
   * simulator can fill a marketable order in the same millisecond it is placed)
   * has a plan to join to, but the decision does not yet know which of its
   * orders routed — so `workingOrderIds` is absent and completion cannot be
   * decided. One pass later it can.
   */
  if (str(decision['status']) === 'ROUTING') return false

  const planned = asArray(decision['plannedFills'])[index]
  if (planned === undefined) {
    deps.log('paper fold: the decision has no planned fill at this order index', {
      clientOrderId,
      decisionId,
      index,
    })
    // CLAIMED ANYWAY. This order is as settled as this pass will ever make it,
    // and a package cannot finish while one of its ids is unaccounted for — see
    // `claimOrder`.
    await claimOrder(deps, decisionId, clientOrderId)
    await settle(deps, decisionId, clientOrderId, now)
    await markFolded(deps, clientOrderId, now, 'no planned fill at this index')
    return false
  }

  const state = str(doc['state'])
  const plannedQty = num(planned['qty'])
  const reported =
    state === 'FILLED'
      ? // FILLED means the whole desk order traded. `filledQty` is written by
        // `markTerminal` and is the same number; the plan is the fallback for a
        // document that reached FILLED without one.
        positiveOr(num(doc['filledQty']), plannedQty)
      : PARTLY_FILLED_STATES.has(state)
        ? Math.max(0, num(doc['filledQty']))
        : 0
  // DIRECTIVE 2. The desk may book what it asked for and never more.
  const qty = Math.min(reported, plannedQty)
  // `0` is not a price: a REJECTED order carries `avgPrice: null`, and an
  // absent one must never restate the plan's mark to zero.
  const reportedPrice = num(doc['avgPrice'])
  const price = reportedPrice > 0 ? reportedPrice : num(planned['price'])

  if (qty <= 0) {
    // The order is terminal and nothing traded — a rejected limit, a halted
    // first tranche. There is no position, which is exactly what the book
    // already says, so nothing is written to it. Reported, claimed, marked.
    await publish(deps, {
      ts: now,
      phase: 'STATUS',
      ok: false,
      tag: str(doc['tag']),
      tradingsymbol: str(doc['tradingsymbol']),
      clientOrderId,
      side: doc['transaction_type'],
      filledQty: 0,
      avgPrice: null,
      status: state,
      error: `paper order finished ${state} with nothing traded — no leg was booked`,
      detail: { source: 'paper-fold', mode: 'paper', decisionId, deskTag: str(planned['deskTag']) },
    })
    /**
     * THE CLAIM IS NOT OPTIONAL HERE, and leaving it out was a real defect
     * (review C-1). An order that traded NOTHING books no fill, so this branch
     * had nothing to `$push` and wrote no receipt at all — while still marking
     * the document `deskFolded`, which takes it out of every future pass.
     *
     * A package of two, whose FIRST order is rejected at placement (the normal
     * ordering — a rejection is terminal immediately, a fill waits for a tick),
     * then settled like this: order 0 folded silently, order 1 filled and asked
     * `settle` whether every id was accounted for, read a `foldedOrders` that
     * had never heard of order 0, and answered no. Both documents marked, no
     * pass could revisit either, and the decision stayed `WORKING` for the rest
     * of the session — with the supervisor holding it `inFlight` and forming no
     * further package for that book.
     *
     * It is not a corner: the simulator REJECTS a MARKET order on a token it
     * has seen no tick for, and the engine routes MARKET whenever an action
     * carries no `limitPrice` — so the first package of a paper session is a
     * live candidate for exactly this shape.
     */
    await claimOrder(deps, decisionId, clientOrderId)
    await settle(deps, decisionId, clientOrderId, now)
    await markFolded(deps, clientOrderId, now)
    return false
  }

  const leanId = leanStamp(doc['leanId'])
  // The venue's charge for what is being booked (Delta), or nothing (NSE).
  const fee = foldedFee(doc, qty, reported)
  // THE RECORD FIRST (directive 3), and CONDITIONALLY (directive 4) — with the
  // fill riding along on the same claim. See `claimOrder`.
  const booked: Fill = {
    ...(planned as unknown as Fill),
    qty,
    price,
    ts: now,
    /**
     * WHOSE BET THIS WAS, read back off the order document (plan 10A).
     *
     * The delta-lean controller selects the legs of its current lean by this
     * stamp, so a leg that arrives here without one belongs to no lean: the
     * lean holds nothing, never adds on a peak, never cuts on a drawdown, and
     * nothing throws. `applyActions` put it on the `Fill`, `rail.ts` wrote it
     * onto the document this pass is folding, and the leg
     * `refoldRoutedFills` creates below carries it from here.
     *
     * READ FROM THE DOCUMENT rather than trusted from `planned`, even though
     * both were written from the same fill in the same request: this pass is
     * the record of what the gateway actually worked, and the document is what
     * it worked. The conditional spread means a document without the key falls
     * back to whatever the plan carried instead of ERASING it — which is what
     * an order queued before this field existed, folded after the deploy,
     * needs.
     */
    ...(leanId === undefined ? {} : { leanId }),
    ...(fee === undefined ? {} : { fee }),
  }
  const alreadyRecorded = !(await claimOrder(deps, decisionId, clientOrderId, booked))

  const outcome = await foldIntoBook(deps, {
    tag: str(decision['tag']),
    // The decision's own underlying and expiry, because the book row may not
    // exist yet: an engine paper decision writes NO book at route time, so the
    // FIRST fill on a brand-new tag is the write that creates it.
    symbol: str(decision['symbol']),
    expiry: str(decision['expiry']),
    fill: booked,
    now,
    nonce: clientOrderId,
  })

  await publish(deps, {
    ts: now,
    phase: 'FILL',
    ok: outcome.changed || outcome.note === '',
    tag: str(doc['tag']),
    tradingsymbol: str(doc['tradingsymbol']),
    clientOrderId,
    side: doc['transaction_type'],
    filledQty: qty,
    avgPrice: price,
    status: state,
    ...(outcome.note === '' ? {} : { error: outcome.note }),
    detail: {
      source: 'paper-fold',
      mode: 'paper',
      decisionId,
      deskTag: str(planned['deskTag']),
      op: str(planned['op']),
      book: outcome.changed ? 'folded' : 'unchanged',
      ...(alreadyRecorded ? { recorded: 'on an earlier pass' } : {}),
    },
  })

  /**
   * THE MARK IS THE LAST STEP OF A FINISHED JOB, and a fold that lost both of
   * its races is not one. It stays unmarked and the next pass retries — the
   * book's own receipt is what stops the retry double-booking.
   */
  if (outcome.retry) return false

  /**
   * The in-memory book, told the moment the fill became real — the same call
   * `applyDecision` makes at the moment ITS fills do.
   *
   * ONLY WHEN THIS PASS IS THE ONE THAT MADE IT REAL. A retry after a crash
   * between the fold and the mark re-runs everything above; telling the cache
   * again would count the same fill twice. Under-telling is the safe direction
   * and is exactly `#tellBook`'s own contract — a missed entry costs at most
   * one reconcile interval of staleness, an extra one is a wrong number.
   */
  if (!alreadyRecorded) {
    tell(deps, {
      tag: str(decision['tag']),
      mode: 'paper',
      createdAt: num(decision['createdAt']),
      fills: [booked],
    })
  }

  await settle(deps, decisionId, clientOrderId, now)
  await markFolded(deps, clientOrderId, now)

  /**
   * THE NUDGE IS LAST, after everything it describes is durable.
   *
   * It carries no instructions — the supervisor re-reads the book and its own
   * decision from Mongo — so an early one would only make it read a state that
   * has not landed yet. `notifySupervisor` never throws and never rejects.
   */
  await notifySupervisor(
    'fill',
    { tag: str(decision['tag']), mode: 'paper', decisionId, clientOrderId },
    {
      log: deps.log,
      ...(deps.nudge?.port === undefined ? {} : { port: deps.nudge.port }),
      ...(deps.nudge?.token === undefined ? {} : { token: deps.nudge.token }),
    },
  )
  return true
}

/**
 * THIS ORDER IS ACCOUNTED FOR — the receipt `settle` counts, written once.
 *
 * `foldedOrders` answers exactly one question: "has this pass finished with
 * order X?". It is NOT a list of fills, and conflating the two is the defect
 * this function exists to make impossible — an order that traded nothing is
 * every bit as finished as one that filled, and a package cannot settle while
 * one of its ids is missing from here (see the `qty <= 0` branch for what that
 * cost).
 *
 * CONDITIONAL AND ATOMIC: the write lands only while the id is absent, so two
 * passes racing one document produce one claim and, when a fill rides along,
 * one fill. It answers TRUE when THIS call was the one that claimed it —
 * `false` means an earlier pass already did, and the caller retries the work
 * that comes after rather than skipping it.
 *
 * The `$push` is the same update as the `$addToSet` deliberately: a fill
 * recorded without its receipt could be recorded twice, and a receipt written
 * without its fill would settle a package that never booked one.
 */
async function claimOrder(
  deps: PaperFoldDeps,
  decisionId: string,
  clientOrderId: string,
  fill?: Fill,
): Promise<boolean> {
  const res = await deps.store.collection(COLLECTIONS.decisions).updateOne(
    { decisionId, mode: 'paper', foldedOrders: { $ne: clientOrderId } },
    {
      $addToSet: { foldedOrders: clientOrderId },
      ...(fill === undefined ? {} : { $push: { fills: fill } }),
    },
  )
  return res.matchedCount !== 0
}

/**
 * IS THE WHOLE PACKAGE ACCOUNTED FOR? Then it is no longer WORKING.
 *
 * `workingOrderIds` is what `applyDecision` recorded as having reached the
 * rail, and `foldedOrders` is what this pass has settled. Comparing two
 * explicit lists rather than counting: a package with one order refused at the
 * door has fewer orders than planned fills, and arithmetic over the two arrays
 * would leave it WORKING for the rest of the session — a supervisor waiting
 * forever on a fill that was never coming.
 *
 * THE RECORD IS RE-READ, not taken from the caller. `foldOne` read the decision
 * before it claimed its own order, and a sibling claimed by another pass — a
 * second desk-api, a retry — landed after that read too. Deciding completion
 * off a stale list is how BOTH orders of a package end up believing the other
 * is outstanding, which leaves it WORKING with nothing left to revisit. One
 * extra `findOne`, on the settle path only.
 *
 * The write is FILTERED ON `WORKING`, so it can only ever end a package that
 * was working; nothing here can revive a FAILED one.
 */
async function settle(
  deps: PaperFoldDeps,
  decisionId: string,
  clientOrderId: string,
  now: number,
): Promise<void> {
  const decision = await deps.store
    .collection(COLLECTIONS.decisions)
    .findOne({ decisionId, mode: 'paper', via: 'engine' })
  if (decision === null) return
  const working = asStrings(decision['workingOrderIds'])
  if (working.length === 0) return
  const settled = new Set([...asStrings(decision['foldedOrders']), clientOrderId])
  if (!working.every((id) => settled.has(id))) return
  await deps.store
    .collection(COLLECTIONS.decisions)
    .updateOne(
      { decisionId, mode: 'paper', status: 'WORKING' },
      { $set: { status: 'DONE', completedAt: now } },
    )
}

// --------------------------------------------------------- the book fold

interface FoldOutcome {
  readonly note: string
  readonly changed: boolean
  /** The write could not be made. The caller must NOT mark the document. */
  readonly retry: boolean
}

const NO_FOLD: FoldOutcome = { note: '', changed: false, retry: false }

/**
 * Fold one paper fill into `desk-books`.
 *
 * `mayCreate` IS THE FILL'S OWN OP, and nothing else. An `open` is by definition
 * a leg the book does not hold yet — that is what makes it an open — so it may
 * create one, and the identity it needs (strike, type, underlying, expiry) is
 * found by SEARCHING the listed chain for the tradingsymbol, never by parsing
 * it. A contract the chain does not contain is reported rather than invented.
 *
 * A CLOSE OR A RESIZE MAY NOT CREATE, and this is the one hazard the deferred
 * fold opens that the old synchronous path did not have. There is a real window
 * now between the decision and its fill, and an operator's Close-leg or a
 * flatten can empty the book inside it. With `mayCreate` on, the close's fill
 * would then arrive at a book holding nothing and OPEN a leg in the opposite
 * direction — a phantom position created by the very pass that books reality.
 * With it off, the fill is dropped and reported loudly, which is a visible
 * divergence rather than an invented one. A resize that GROWS a leg the book
 * still holds is unaffected: `refoldRoutedFills` only consults `mayCreate` when
 * nothing anywhere describes the contract.
 *
 * Written through the same compare-and-set as every other book write, with the
 * order id as the fold receipt: `saveBook` appends it to `appliedCorrections`
 * inside the same `updateOne` as the legs, so a nonce already present is the
 * book itself saying this fill is on it — which no crash can contradict.
 */
async function foldIntoBook(
  deps: PaperFoldDeps,
  input: {
    readonly tag: string
    readonly symbol: string
    readonly expiry: string
    readonly fill: Fill
    readonly now: number
    readonly nonce: string
  },
): Promise<FoldOutcome> {
  const { tag, fill, now, nonce } = input
  if (tag === '' || fill.tradingsymbol === '') {
    return { note: 'book NOT folded — the decision fill is unreadable', changed: false, retry: false }
  }

  /**
   * THE BOOK ROW MAY NOT EXIST YET, and that is the normal case rather than an
   * error. An engine paper decision writes no book at route time, so the first
   * fill on a fresh tag is the write that CREATES the row — exactly as
   * `applyDecision` creates it when `bookDoc` came back null there.
   *
   * The version pinned below is then `null`, which `saveBook` reads as
   * CREATE-ONLY: an insert that LOSES to whoever created the row first rather
   * than a blind upsert over their document. The loser re-folds onto the
   * winner's legs through `refoldOnConflict`, same as everywhere else.
   */
  const doc = await deps.store.bookDoc(tag, 'paper')
  const symbol = doc?.symbol ?? input.symbol
  const expiry = doc?.expiry ?? input.expiry
  if (symbol === '' || expiry === '') {
    return {
      note: 'book NOT folded — the decision names no underlying or expiry to file it under',
      changed: false,
      retry: false,
    }
  }
  if ((doc?.appliedCorrections ?? []).includes(nonce)) {
    return { note: alreadyFolded(nonce), changed: false, retry: false }
  }

  const legs = doc?.legs ?? []
  const held = legs.some((l) => l.instrument.tradingsymbol === fill.tradingsymbol)
  const mayCreate = fill.op === 'open'
  let view: readonly BridgeLeg[] = []
  if (!held && mayCreate) {
    const meta = restoreView(deps.master(), fill.tradingsymbol, { symbol, expiry })
    if (meta === null) {
      return {
        note:
          `book NOT folded — ${fill.tradingsymbol} is not resolvable in ${symbol} ` +
          `${expiry}; the paper fill is recorded but no leg was written`,
        changed: false,
        retry: false,
      }
    }
    view = [meta]
  }

  const routed: RefoldFill = { ...fill }
  const folded = refoldRoutedFills({
    legs,
    routedFills: [routed],
    views: [legs, view],
    mayCreate,
    nowMs: now,
  })
  const applied = folded.outcomes[0]?.applied ?? 0
  if (applied <= 0) {
    return {
      note: `book NOT folded — nothing in it matched ${fill.tradingsymbol}`,
      changed: false,
      retry: false,
    }
  }

  const key = { tag, mode: 'paper' as DeskMode, symbol, expiry }
  // `null` = CREATE-ONLY (there is no row); `undefined` = unconditional (a row
  // written before versions existed). Collapsing the two with `??` would turn
  // every legacy book's fold into a permanent conflict.
  const version = doc === null ? null : doc.updatedAt
  const saved = await deps.store.saveBook(key, folded.legs, now, version, nonce)
  if (saved === 'ok') return { note: '', changed: true, retry: false }

  const retried = await refoldOnConflict({
    store: deps.store,
    key,
    routedFills: [routed],
    nextBook: folded.legs,
    priorBook: view,
    mayCreate,
    nowMs: now,
    nonce,
    log: (m) => deps.log(m),
  })
  if (retried.status === 'already-applied') return { note: alreadyFolded(nonce), changed: false, retry: false }
  if (retried.status === 'lost') {
    return { note: 'book NOT folded — the write lost its race', changed: false, retry: true }
  }
  if (retried.status === 'gone') {
    return { note: 'book NOT folded — the book was deleted', changed: false, retry: false }
  }
  // The retry's OWN quantity, never the one we asked for — see
  // `reconcile-live.ts:compensate` for what reporting the wrong one costs.
  return (retried.outcomes[0]?.applied ?? 0) > 0
    ? { note: '', changed: true, retry: false }
    : { note: `book NOT folded — nothing in it matched ${fill.tradingsymbol}`, changed: false, retry: false }
}

function alreadyFolded(nonce: string): string {
  return (
    `book already carries this fill (${nonce}) — folded on an earlier pass that died before ` +
    `it could say so; NOT folded twice`
  )
}

// -------------------------------------------------------------- plumbing

/**
 * The journal line and the socket frame, in the shape the Orders page already
 * renders — `paperFillEvent`'s, so one table renders paper fills from the
 * manual box and paper fills from the engine identically.
 */
async function publish(deps: PaperFoldDeps, event: Record<string, unknown>): Promise<void> {
  await deps.store.journalBlocked([event])
  if (deps.notify === undefined) return
  try {
    deps.notify('paper', event)
  } catch {
    /* a dashboard that missed an update is an inconvenience */
  }
}

/** `#tellBook`'s contract: swallow everything. A cache is not an order. */
function tell(deps: PaperFoldDeps, entry: PaperFoldJournalEntry): void {
  if (deps.journal === undefined) return
  try {
    deps.journal(entry)
  } catch {
    /* a stale dashboard is an inconvenience; a failed fold is not */
  }
}

/** LAST, always — see directive 3. */
async function markFolded(
  deps: PaperFoldDeps,
  clientOrderId: string,
  now: number,
  note?: string,
): Promise<void> {
  await deps.store.collection(COLLECTIONS.gatewayOrders).updateOne(
    { clientOrderId },
    {
      $set: {
        deskFolded: true,
        deskFoldedAt: now,
        ...(note === undefined ? {} : { deskFoldNote: note }),
      },
    },
  )
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The delta-lean stamp as stored, or `undefined` when there is none.
 *
 * NOT `str()`, and that is the point: `''` is what a missing string reads as
 * there, and "no lean" must not become an EMPTY lean on the leg. A stored null
 * — which is what an `undefined` written into Mongo comes back as — is the same
 * absence, and is treated as one rather than copied onto a leg where the
 * supervisor's mapper expects a string or no key at all.
 */
function leanStamp(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * THE FEE FOR THE QUANTITY BEING BOOKED, off the gateway's terminal document.
 *
 * The document's own `fee` total when it has one, else the sum of its fill
 * rows' `fee`. When the fold books less than the gateway reported (directive
 * 2's cap), the fee is cut in the same proportion — the desk pays for what it
 * books. `undefined` when nothing on the document is a fee: an NSE order, whose
 * fill must not grow a `fee: 0` key it never had.
 */
export function foldedFee(doc: Record<string, unknown>, bookedQty: number, reportedQty: number): number | undefined {
  const asFee = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  let total = asFee(doc['fee'])
  if (total === undefined) {
    for (const row of asArray(doc['fills'])) {
      const f = asFee(row['fee'])
      if (f !== undefined) total = (total ?? 0) + f
    }
  }
  if (total === undefined) return undefined
  const share = reportedQty > 0 && bookedQty < reportedQty ? bookedQty / reportedQty : 1
  return Number((total * share).toFixed(8))
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function positiveOr(value: number, fallback: number): number {
  return value > 0 ? value : fallback
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}
