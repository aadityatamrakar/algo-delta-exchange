/**
 * The terminal-state reconciler: broker truth joined back onto the desk.
 *
 * WHY THIS FILE EXISTS (audit F-2, and the "booked-but-refused" residual of the
 * Tier-1 review). `service.ts:554` writes `desk-decisions.fills` the moment the
 * order document is inserted — at the FULL requested quantity and the
 * decision-time mark, because that is the only thing it knows at that line.
 * `pnlstore.loadFills` then makes that document the sole input to P&L, the
 * daily rollup, `LiveBook`'s held set and `flattenTag`'s position
 * reconstruction. Nothing anywhere read the gateway's terminal `filledQty`,
 * `avgPrice` or `REJECTED` back onto it.
 *
 * So a margin 403 on a recenter leg left the desk carrying a leg no order
 * backs, forever. The cost is not a wrong report: tomorrow's `close-all` sends
 * a REAL order in the opposite direction against a position that never existed,
 * and OPENS one nobody asked for. The same hole swallows the Tier-1 gates —
 * an order the gateway refuses (kill switch, stale-age) is booked exactly like
 * one it fills.
 *
 * THE PRIME DIRECTIVES, and every one of them is load-bearing:
 *
 *  1. A correction may only REDUCE what was booked, or restate its price to the
 *     broker's. It may never grow a position. The one apparent exception —
 *     a REJECTED **close**, which puts a leg BACK — is the same rule seen from
 *     the other side: it undoes a reduction that never happened, returning the
 *     book to the state it was in before the decision. It never books more than
 *     the decision itself booked.
 *  2. The PAPER rail is never read and never written, and as of D14 that has to
 *     be ENFORCED rather than assumed. The engine endpoint's paper orders now
 *     do land in `desk-gateway-orders` (`rail.ts`, `mode: 'paper'`), so the
 *     premise this directive used to rest on — that a paper order cannot
 *     physically appear in this collection — is gone. Three things keep it
 *     true: the scan below excludes `mode: 'paper'` outright, the decision
 *     lookup pins `mode: 'live'`, and `bookDoc`/`saveBook` are only ever asked
 *     for the live book. Without the first, every paper order this desk works
 *     would be scanned here, fail to join a live decision, and be journalled as
 *     an unjoinable ORDER FAILURE — a loud, wrong alert per paper fill.
 *     `paper-fold.ts` is the pass that owns them.
 *  3. Every correction is journalled to `desk-order-events` and pushed, because
 *     a silent correction is indistinguishable from the defect it repairs.
 *  4. Everything is idempotent. The decision fill carries a `corrected` stamp
 *     and the gateway document is marked LAST, so a crash in between re-runs
 *     the correction and the stamp makes it a no-op.
 *  5. One bad document never stops the pass, and a document that FAILED is not
 *     marked — it is retried next minute.
 *
 * WHAT IT DOES NOT DO. It never places, cancels or amends an order. It reads
 * the gateway's own terminal record — written by `apps/order-gateway` from the
 * broker's order socket and its broker-book sweep — and makes the desk's two
 * records agree with it. If it cannot say what the truth is, it says so loudly
 * and changes nothing; a wrong correction on the money path is worse than a
 * visible divergence.
 */

import type { OptionType } from '@algomaker/greeks'
import type { InstrumentRef } from '@algomaker/order-bus'
import {
  refoldOnConflict,
  refoldRoutedFills,
  type BookWriteStore,
  type RefoldFill,
} from './book-write.ts'
import type { BridgeLeg, DeskMode, DeskSide } from './contract.ts'
// TYPE-ONLY, and erased at build: the same shared vocabulary
// `routes/repair.ts` takes, for the same reason — see `IS_TERMINAL`.
import type { OrderState } from '../../order-gateway/src/queue.ts'
import { COLLECTIONS, type Collection } from './store.ts'

/**
 * WHICH GATEWAY STATES THIS JOB MAY ACT ON — one answer per state, forced.
 *
 * `Record<OrderState, boolean>` and a type-only import of the gateway's own
 * union, exactly as `routes/repair.ts:VERDICT_OF` does and for the same reason:
 * a new state added over there must BREAK THE BUILD here rather than quietly
 * fall out of this scan. It has already happened once — `HALTED` (a fill-gated
 * order stopped part-way) was invisible to this pass, so a halted nine-lot open
 * of which three lots traded left the book carrying nine, permanently, with the
 * 60-second fold-back job running happily beside it. That is precisely the
 * "leg no order backs" this file exists to end, reached by a state it did not
 * know about.
 *
 * `false` means NOT FINAL — the broker has not answered yet — never "ignore".
 *
 * `import type` is erased under `verbatimModuleSyntax`, so this buys the shared
 * vocabulary without `@algomaker/api` taking a runtime dependency on the
 * gateway app.
 */
const IS_TERMINAL: Readonly<Record<OrderState, boolean>> = {
  PENDING: false,
  CLAIMED: false,
  PLACED: false,
  FILLED: true,
  PARTIAL: true,
  // Stopped part-way BY THE GATEWAY: the tranches that went out may well have
  // traded, and what they traded is on the document. Terminal, and it must be
  // reconciled like a PARTIAL rather than read as a rejection.
  HALTED: true,
  REJECTED: true,
  INVALID: true,
}

/**
 * The states above that are FINAL. A PLACED order has not answered yet.
 *
 * Exported for `paper-fold.ts`, which asks the identical question of the
 * identical collection and must not answer it from a second list — a state
 * added to `IS_TERMINAL` has to reach both passes or the paper rehearsal stops
 * booking a shape the live rail books.
 */
export const TERMINAL_STATES = Object.entries(IS_TERMINAL)
  .filter(([, terminal]) => terminal)
  .map(([state]) => state)

/**
 * The states in which an order is STILL OUT — the broker (or the simulator) has
 * not answered yet.
 *
 * The exact complement of `TERMINAL_STATES`, derived from the same map rather
 * than typed out, so a state added to `IS_TERMINAL` cannot end up in neither
 * list. `routes/engine.ts` asks this question of the paper rail: an engine
 * paper decision does not fold its book until its fills land, so "is there
 * already an order out on this contract" is the only thing standing between two
 * decisions and two legs on one instrument.
 */
export const NON_TERMINAL_STATES = Object.entries(IS_TERMINAL)
  .filter(([, terminal]) => !terminal)
  .map(([state]) => state)

/**
 * The states whose `filledQty` is a REAL partial fill to be believed.
 *
 * FILLED is the whole booked quantity and REJECTED/INVALID are zero; these two
 * are the ones where the document's own number is the answer.
 */
const PARTLY_FILLED_STATES = new Set(['PARTIAL', 'HALTED'])

const DEFAULT_INTERVAL_MS = 60_000
/**
 * Seven days. The window exists so a FIRST DEPLOY does not rewrite months of
 * history in one pass — every document ever written is unreconciled on the day
 * this ships, and a correction is a book write. Anything older than the window
 * is left exactly as it is: its book has long since moved on, and folding a
 * week-old shortfall into today's legs would invent a divergence rather than
 * repair one.
 */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** Bounded per pass so one minute's work stays one minute's work. */
const DEFAULT_BATCH = 50

/**
 * The instrument lookups a RESTORE needs.
 *
 * `OptionMaster` satisfies this structurally. A restored leg's strike and type
 * come from the master by SEARCHING the listed chain for the tradingsymbol —
 * never by parsing the symbol — because fabricating a contract from string
 * surgery is how the C4 phantom PE happened.
 */
export interface ReconcileMaster {
  resolveSymbol(tradingsymbol: string): InstrumentRef | null
  strikes(underlying: string, expiry: string): readonly number[]
  resolve(
    underlying: string,
    expiry: string,
    strike: number,
    type: OptionType,
  ): InstrumentRef | null
}

/**
 * The persistence this needs, as a narrow port. `DeskStore` satisfies it
 * structurally, which is what lets every test here run against a fake rather
 * than a live Mongo.
 */
export interface ReconcileStore extends BookWriteStore {
  collection<T = Record<string, unknown>>(name: string): Collection<T>
  journalBlocked(events: readonly Record<string, unknown>[]): Promise<void>
}

export interface ReconcileDeps {
  readonly store: ReconcileStore
  /** Read per pass, not captured: the master is refreshed on its own timer. */
  readonly master: () => ReconcileMaster
  /** The websocket push. Absent when no dashboard is attached. */
  readonly notify?: (mode: DeskMode, event: Record<string, unknown>) => void
  readonly now: () => number
  readonly log: (message: string, detail?: Record<string, unknown>) => void
}

export interface ReconcileOptions {
  readonly lookbackMs?: number
  readonly batchSize?: number
  readonly intervalMs?: number
}

export interface ReconcilePass {
  /** True when a pass was already in flight and this call did nothing. */
  readonly busy: boolean
  readonly scanned: number
  readonly corrected: number
  readonly failed: number
}

const IDLE: ReconcilePass = { busy: true, scanned: 0, corrected: 0, failed: 0 }

// ------------------------------------------------------------------- ids

/**
 * `<decisionId>#<i>` — and `<decisionId>#<i>.<tranche>` once the gateway has
 * split it under the exchange freeze limit.
 *
 * ONLY A TRAILING `.<digits>` IS A TRANCHE, which is exactly the rule the
 * writer uses (`gateway.ts:baseClientOrderId`). Stripping at the FIRST dot
 * instead truncated every id whose decision id contains one — a caller-chosen
 * `atr.v2-171#3` became decision `atr`, which matches nothing, so the order was
 * filed unjoinable and excluded from reconciliation forever. The two ends of
 * one id must not disagree about where it splits.
 *
 * Split at the LAST `#` rather than the first: `/v1/desk/submit` uses the
 * CALLER'S own `clientOrderId` as the decision id (`submit.ts:1102`) and a
 * caller may legitimately put a `#` in it. Every writer appends its index last
 * — `decision-plan.ts:orderIdFor`, `submit-plan.ts:planTranches` — so the last
 * separator is the one that means "order index".
 */
export function splitOrderId(clientOrderId: string): {
  readonly decisionId: string
  readonly index: number
} {
  const base = /^(.*)\.\d+$/.exec(clientOrderId)?.[1] ?? clientOrderId
  const hash = base.lastIndexOf('#')
  if (hash <= 0) return { decisionId: base, index: -1 }
  const raw = Number(base.slice(hash + 1))
  return {
    decisionId: base.slice(0, hash),
    index: Number.isInteger(raw) && raw >= 0 ? raw : -1,
  }
}

/**
 * WHICH FILL IN THE DECISION THIS ORDER IS.
 *
 * Two independent answers, tried strongest first, because the three writers
 * that produce these documents do not agree on what `desk_tag` means:
 *
 *  - `submit.ts` and `flattenTag` set the fill's `deskTag` TO the order id, so
 *    `desk_tag` is unique within the decision and identifies the fill outright.
 *  - `applyActions` sets it to the BOOK LEG's tag (`book.ts:209`), and one
 *    decision may legally carry two fills on the same leg — a resize and a
 *    close — so `desk_tag` alone is ambiguous there.
 *
 * The order index is never ambiguous. `plannedFills` is the array the routing
 * loop indexed (`service.ts:529`), and `fills` is that array filtered by
 * `routeErrors` (`decision-plan.ts:partitionRoutedFills`), so the index maps
 * exactly. The tag match is the fallback for records written by `submit.ts`,
 * which journals no plan.
 *
 * A THIRD WRITER MADE THE TAG NON-UNIQUE (the repair path). Every tranche of a
 * repair CLOSE journals under the driver's LEG id — `submit.ts:fillDeskTag`,
 * which is the equality the Python side books realized P&L on — so a
 * freeze-split close puts two identically-tagged fills in one decision with no
 * plan to tell them apart. Demanding a unique match filed BOTH of them
 * unjoinable, and the broker's real price and size were never booked back for
 * any split repair close. `shareTheKey` is that case and only that case.
 *
 * Returns -1 when no answer is certain. GUESSING IS NOT AN OPTION: the wrong
 * fill corrected is a phantom position created rather than removed.
 */
export function locateFill(
  decision: Record<string, unknown>,
  doc: Record<string, unknown>,
  index: number,
): number {
  const fills = asArray(decision['fills'])
  const deskTag = str(doc['desk_tag'])
  const symbol = str(doc['tradingsymbol'])
  const isMatch = (f: Record<string, unknown>): boolean =>
    (deskTag === '' || str(f['deskTag']) === deskTag) &&
    (symbol === '' || str(f['tradingsymbol']) === symbol)

  const viaPlan = fillIndexFromPlan(decision, index)
  const planned = fills[viaPlan]
  if (viaPlan >= 0 && planned !== undefined && isMatch(planned)) return viaPlan

  const candidates: number[] = []
  for (let i = 0; i < fills.length; i++) {
    if (isMatch(fills[i] as Record<string, unknown>)) candidates.push(i)
  }
  if (candidates.length <= 1) return candidates[0] ?? -1
  return shareTheKey(fills, candidates, doc)
}

/**
 * WHICH OF SEVERAL IDENTICALLY-TAGGED FILLS IS THIS TRANCHE'S — in three steps,
 * each of which is a FACT rather than a preference.
 *
 * 1. THE ONE THIS DOCUMENT ALREADY CLAIMED. The correction stamp carries the
 *    `clientOrderId` that wrote it, so a document re-read after a crash between
 *    the correction and the mark re-finds its OWN fill. Without this the retry
 *    would skip past it as "already claimed" and correct the sibling a second
 *    time off one broker answer.
 * 2. UNCLAIMED ONLY. A fill another tranche has corrected is that tranche's; two
 *    documents may never fold into one fill. Corrections are written before the
 *    next document is read (the pass is a sequential single-flight loop), so the
 *    claim is visible by the time it matters.
 * 3. EXACT SIZE FIRST, and this one is not a nicety. A freeze split is `[24, 6]`
 *    lots, not two equal halves: pairing the 6-lot tranche with the 24-lot fill
 *    would restate it to 6 and fold an 18-lot compensating trade into the book
 *    that nobody made. When the sizes cannot separate them — an even split — the
 *    fills are identical in every field this job reads, so any injective
 *    assignment produces the same record and the first free one is taken.
 *
 * Still -1 when nothing is free: better an unjoinable order, journalled and
 * visible, than a correction aimed at a fill that belongs to another order.
 */
function shareTheKey(
  fills: readonly Record<string, unknown>[],
  candidates: readonly number[],
  doc: Record<string, unknown>,
): number {
  const clientOrderId = str(doc['clientOrderId'])
  const stampOf = (i: number): Record<string, unknown> => {
    const s = (fills[i] as Record<string, unknown>)['corrected']
    return (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>
  }
  const qtyOf = (i: number): number => num((fills[i] as Record<string, unknown>)['qty'])
  const claimed = (i: number): boolean =>
    (fills[i] as Record<string, unknown>)['corrected'] !== undefined

  const mine = candidates.find(
    (i) => clientOrderId !== '' && str(stampOf(i)['clientOrderId']) === clientOrderId,
  )
  if (mine !== undefined) return mine

  const free = candidates.filter((i) => !claimed(i))
  // `quantity` is what the DESK asked for on this tranche (`rail.ts:
  // orderDocument`), which is the number the fill was booked at — never
  // `filledQty`, which is what the broker did with it and is smaller on exactly
  // the documents this job exists to correct.
  const wanted = num(doc['quantity'])
  const exact = wanted > 0 ? free.filter((i) => qtyOf(i) === wanted) : []
  const pool = exact.length > 0 ? exact : free
  return pool[0] ?? -1
}

/** The position in `fills` of `plannedFills[index]`, or -1 if it never routed. */
function fillIndexFromPlan(decision: Record<string, unknown>, index: number): number {
  const planned = asArray(decision['plannedFills'])
  const target = planned[index]
  if (index < 0 || target === undefined) return -1
  const failed = new Set<string>()
  for (const e of asArray(decision['routeErrors'])) {
    const f = e['fill']
    if (typeof f === 'object' && f !== null) failed.add(str((f as Record<string, unknown>)['deskTag']))
  }
  if (failed.has(str(target['deskTag']))) return -1
  let k = -1
  for (let j = 0; j <= index; j++) {
    if (!failed.has(str((planned[j] as Record<string, unknown>)['deskTag']))) k++
  }
  return k
}

// ------------------------------------------------------------ the reconciler

export function createLiveReconciler(
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): { run(): Promise<ReconcilePass> } {
  const lookbackMs = positive(opts.lookbackMs, DEFAULT_LOOKBACK_MS)
  const batchSize = positive(opts.batchSize, DEFAULT_BATCH)
  let running = false

  const run = async (): Promise<ReconcilePass> => {
    // SINGLE FLIGHT. A pass that outruns its interval — a first deploy with a
    // full batch, a slow Mongo — must not have a second copy of itself folding
    // the same shortfall into the book twice.
    if (running) return IDLE
    running = true
    try {
      const now = deps.now()
      const docs = await deps.store
        .collection(COLLECTIONS.gatewayOrders)
        .find({
          state: { $in: TERMINAL_STATES },
          deskReconciled: { $ne: true },
          createdAt: { $gt: now - lookbackMs },
          // PRIME DIRECTIVE 2, as a query. `$ne` matches a MISSING field, which
          // is what every live order document written before the engine's paper
          // lifecycle existed looks like — so this narrows and never excludes.
          mode: { $ne: 'paper' },
        })
        // OLDEST FIRST: corrections are folded into the book in the order the
        // orders were placed, which is the order the book was built in.
        .sort({ createdAt: 1 })
        .limit(batchSize)
        .toArray()

      let corrected = 0
      let failed = 0
      for (const doc of docs) {
        try {
          if (await reconcileOne(deps, doc, now)) corrected++
        } catch (err) {
          // FAIL SOFT, and DO NOT MARK. One unreadable document must not cost
          // the other 49 their correction, and leaving it unmarked is what
          // makes the next pass try again.
          failed++
          deps.log('reconcile: one order failed and was left for the next pass', {
            clientOrderId: str(doc['clientOrderId']),
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return { busy: false, scanned: docs.length, corrected, failed }
    } finally {
      running = false
    }
  }

  return { run }
}

/**
 * Wire the pass onto an interval.
 *
 * `.catch` on every tick and `unref()` on the timer, for the same reason
 * `pnl-jobs.ts` carries both: an unhandled rejection inside a timer takes down
 * the process that routes orders, and a housekeeping timer must never be the
 * thing that holds a restart open.
 */
export function startLiveReconciler(
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): () => void {
  const reconciler = createLiveReconciler(deps, opts)
  const intervalMs = positive(opts.intervalMs, DEFAULT_INTERVAL_MS)
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void reconciler.run().catch((err: unknown) => {
      deps.log('reconcile pass failed', {
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

/** True when this document produced a correction. Throws only on I/O. */
async function reconcileOne(
  deps: ReconcileDeps,
  doc: Record<string, unknown>,
  now: number,
): Promise<boolean> {
  const clientOrderId = str(doc['clientOrderId'])
  if (clientOrderId === '') {
    deps.log('reconcile: a gateway order carries no clientOrderId — skipped', { doc })
    return false
  }
  const { decisionId, index } = splitOrderId(clientOrderId)
  const decision = await deps.store
    .collection(COLLECTIONS.decisions)
    // `mode: 'live'` is PART OF THE KEY, not a filter for tidiness: it is what
    // makes it impossible for this job to read — let alone write — a paper
    // record that happens to share a decision id.
    .findOne({ decisionId, mode: 'live' })

  if (decision === null) {
    await reportUnjoinable(deps, doc, now, 'no matching decision', clientOrderId, decisionId)
    return false
  }

  /**
   * STILL ROUTING — WAIT, never condemn.
   *
   * `service.ts:493` claims the decision id with `fills: []` and fills the array
   * in at the completion write (`:621`, which also stamps `completedAt`).
   * `flattenTag` and `/v1/desk/submit` claim theirs the same way. An order that
   * reaches a terminal state inside that window — a broker refusal answers in
   * milliseconds — has no fill to join to YET, so `locateFill` answered -1 and
   * this job filed it unjoinable and MARKED it, excluding it from every future
   * pass. A margin refusal on the first leg of a recenter was therefore never
   * booked back, which is the exact failure this file exists to end.
   *
   * A document can wait out routing: it stays unmarked and the next pass tries
   * again once the decision completes. It must never be declared unjoinable
   * during it.
   */
  if (str(decision['status']) === 'ROUTING') return false

  const k = locateFill(decision, doc, index)
  if (k < 0) {
    await reportUnjoinable(deps, doc, now, 'no matching fill', clientOrderId, decisionId)
    return false
  }
  const fill = (asArray(decision['fills'])[k] ?? {}) as Record<string, unknown>

  const stamp = fill['corrected']
  if (stamp !== undefined) {
    return await finishFold(deps, {
      doc,
      decision,
      decisionId,
      clientOrderId,
      k,
      fill,
      stamp: (typeof stamp === 'object' && stamp !== null ? stamp : {}) as Record<string, unknown>,
      now,
    })
  }

  const state = str(doc['state'])
  const bookedQty = num(fill['qty'])
  const bookedPrice = num(fill['price'])
  const reported =
    state === 'FILLED'
      ? bookedQty
      : PARTLY_FILLED_STATES.has(state)
        ? Math.max(0, num(doc['filledQty']))
        : 0
  const clamped = reported > bookedQty
  if (clamped) {
    deps.log('reconcile: the broker reports MORE filled than we booked — clamped', {
      clientOrderId,
      tag: str(doc['tag']),
      booked: bookedQty,
      reported,
    })
  }
  const actualQty = clamped ? bookedQty : reported
  // `0` is not a price. A REJECTED order carries `avgPrice: null` and an
  // absent one must leave the booked mark alone rather than restate it to zero.
  const brokerPrice = num(doc['avgPrice'])
  const actualPrice = Number.isFinite(brokerPrice) && brokerPrice > 0 ? brokerPrice : bookedPrice

  /**
   * THE RECORD FIRST, the book second, the mark last.
   *
   * `desk-decisions` is the source of truth — `book-write.ts` says so, and
   * `pnlstore`/`LiveBook` read it and nothing else. Writing it first means a
   * crash anywhere after this line still leaves the desk's P&L, its held set
   * and its flatten reconstruction correct; only the derived book lags, and
   * the next pass repairs it.
   *
   * A dotted `$set` rather than a whole-array rewrite: the completion write in
   * `service.ts:601` sets the same array, and rewriting it here would clobber
   * a sibling fill's own correction.
   *
   * `foldDone: false` TRAVELS WITH THE STAMP, and it is what makes the two
   * writes one unit of work. The stamp alone used to short-circuit the next
   * pass, so a fold that failed — both compare-and-sets lost, the process died
   * mid-fold — was abandoned permanently while the record said the correction
   * had been made. The book kept a leg no order backs, which is the whole
   * defect this file repairs, reintroduced by its own repair.
   */
  await deps.store.collection(COLLECTIONS.decisions).updateOne(
    { decisionId, mode: 'live' },
    {
      $set: {
        [`fills.${k}.qty`]: actualQty,
        [`fills.${k}.price`]: actualPrice,
        [`fills.${k}.corrected`]: {
          at: now,
          fromQty: bookedQty,
          fromPrice: bookedPrice,
          state,
          /**
           * WHO CLAIMED THIS FILL. It is what lets `shareTheKey` hand a
           * re-read document its OWN fill back — when several fills of one
           * decision share a desk tag (a freeze-split repair close), the stamp
           * is the only thing that says which tranche corrected which.
           */
          clientOrderId,
        },
        [`fills.${k}.foldDone`]: false,
      },
    },
  )

  const shortfall = bookedQty - actualQty
  const outcome =
    shortfall > 0
      ? await compensate(deps, {
          tag: str(decision['tag']),
          fill,
          shortfall,
          price: bookedPrice,
          now,
          nonce: clientOrderId,
        })
      : NO_FOLD

  // Two decimals: a booked mark is a float whose binary dust
  // ("3.0250000000000004") is not a price anywhere it is read.
  const summary =
    `reconciled: booked ${bookedQty}@${bookedPrice.toFixed(2)}, ` +
    `broker says ${actualQty}@${actualPrice.toFixed(2)}` +
    (clamped ? `; CLAMPED — the broker reported ${reported}, more than we booked` : '') +
    (outcome.note === '' ? '' : `; ${outcome.note}`)

  await publish(deps, {
    ts: now,
    phase: 'STATUS',
    // The broker did exactly what we booked, or it did not. A clamp means the
    // two records disagree even though the numbers now match, so it is loud.
    ok: actualQty === bookedQty && !clamped,
    tag: str(doc['tag']),
    tradingsymbol: str(doc['tradingsymbol']),
    clientOrderId,
    side: doc['transaction_type'],
    filledQty: actualQty,
    avgPrice: actualPrice,
    status: state,
    error: summary,
    detail: {
      source: 'reconcile',
      mode: 'live',
      decisionId,
      deskTag: str(fill['deskTag']),
      state,
      bookedQty,
      book: outcome.changed ? 'corrected' : 'unchanged',
    },
  })

  /**
   * THE MARK IS THE LAST STEP OF A FINISHED JOB, and an abandoned fold is not
   * one. A compensation that lost both races has changed nothing; marking it
   * would say "reconciled" about a book that still carries the phantom leg. It
   * stays unmarked, and the next pass finds `corrected && !foldDone` and
   * retries just the fold.
   */
  if (outcome.retry) return false
  await markFoldDone(deps, decisionId, k)
  await markReconciled(deps, clientOrderId, now)
  return true
}

/**
 * The tail of a document whose decision fill is ALREADY corrected.
 *
 * Two shapes, and the difference is `foldDone`:
 *
 *  - `foldDone: true` — the record and the book are both right and only the
 *    gateway mark is missing: a crash between the two. Re-folding would apply
 *    the same shortfall twice, so only the mark is finished. This is exactly
 *    why the mark is written last.
 *  - otherwise — the correction landed and the FOLD did not, OR the fold landed
 *    too and the process died before it could say so. The decision numbers are
 *    already corrected, so the shortfall is re-derived from the stamp
 *    (`fromQty` minus what the fill now says) and only the fold runs again —
 *    and `compensate` answers the second case from the BOOK's own receipt
 *    (`appliedCorrections`), which is the only record that cannot disagree with
 *    the fold it describes. Nothing re-reads the broker and nothing re-writes
 *    the record.
 */
async function finishFold(
  deps: ReconcileDeps,
  input: {
    readonly doc: Record<string, unknown>
    readonly decision: Record<string, unknown>
    readonly decisionId: string
    readonly clientOrderId: string
    readonly k: number
    readonly fill: Record<string, unknown>
    readonly stamp: Record<string, unknown>
    readonly now: number
  },
): Promise<boolean> {
  const { doc, decision, decisionId, clientOrderId, k, fill, stamp, now } = input
  if (fill['foldDone'] === true) {
    await markReconciled(deps, clientOrderId, now)
    return false
  }

  const shortfall = num(stamp['fromQty']) - num(fill['qty'])
  const outcome =
    shortfall > 0
      ? await compensate(deps, {
          tag: str(decision['tag']),
          fill,
          shortfall,
          price: num(stamp['fromPrice']),
          now,
          // The SAME nonce this correction folded under on the earlier pass —
          // it is what makes this retry able to tell "the fold never landed"
          // from "the fold landed and the stamp did not".
          nonce: clientOrderId,
        })
      : NO_FOLD

  await publish(deps, {
    ts: now,
    phase: 'STATUS',
    ok: !outcome.retry,
    tag: str(doc['tag']),
    tradingsymbol: str(doc['tradingsymbol']),
    clientOrderId,
    status: str(doc['state']),
    error:
      `reconcile: an earlier pass corrected this order but could not fold it into the book — ` +
      `retried${outcome.note === '' ? '; nothing left to fold' : `; ${outcome.note}`}`,
    detail: {
      source: 'reconcile',
      mode: 'live',
      decisionId,
      deskTag: str(fill['deskTag']),
      retry: true,
      book: outcome.changed ? 'corrected' : 'unchanged',
    },
  })

  if (outcome.retry) return false
  await markFoldDone(deps, decisionId, k)
  await markReconciled(deps, clientOrderId, now)
  return outcome.changed
}

/** The book fold for this fill is FINISHED — nothing may retry it again. */
async function markFoldDone(deps: ReconcileDeps, decisionId: string, k: number): Promise<void> {
  await deps.store
    .collection(COLLECTIONS.decisions)
    .updateOne({ decisionId, mode: 'live' }, { $set: { [`fills.${k}.foldDone`]: true } })
}

// --------------------------------------------------------- the book fold

/**
 * What a fold attempt did, in the three terms the caller needs.
 *
 * `retry` is the one that is easy to miss and impossible to do without: it
 * separates "there was nothing to fold" — a finished job — from "the fold could
 * not be written", which must leave the gateway document unmarked so the next
 * pass tries again. Collapsing the two is how a phantom leg becomes permanent.
 */
interface FoldOutcome {
  readonly note: string
  readonly changed: boolean
  readonly retry: boolean
}

/** Nothing needed folding, and nothing failed. */
const NO_FOLD: FoldOutcome = { note: '', changed: false, retry: false }

/**
 * Fold the compensating fill into `desk-books`.
 *
 * The fill is the booked one INVERTED: same contract, same size as the
 * shortfall, opposite side. A refused OPEN shrinks the phantom leg; a refused
 * CLOSE puts back the leg that is really still open. One rule, two directions.
 *
 * TWO REGIMES, and the difference is the whole safety argument:
 *
 *  - RESTORING (the refused fill was a `close`): the compensation may add, and
 *    may create the leg outright — the close removed it from the book, so
 *    there is nothing left to reduce. It restores exactly what the decision
 *    removed and no more.
 *  - REDUCING (everything else): the compensation may only CONSUME. It is sent
 *    `reduceOnly`, so its size is capped — AT APPLY TIME, against whatever legs
 *    it actually meets — at the offsetting quantity the book holds for that
 *    contract, and it never creates a leg. Without the cap, undoing a refused
 *    SELL on a book that holds the same contract LONG through some other leg
 *    would re-average into that long and GROW it — a correction inventing
 *    exposure, which is the one thing this job may never do.
 *
 * THE CAP TRAVELS WITH THE FILL rather than being applied here, and that is
 * load-bearing. Deriving it here caps against the book THIS function read; the
 * lost-race retry below re-applies to legs somebody else has since moved, and
 * the original quantity then consumes what is left and crosses through zero
 * into a brand new opposite leg. Re-deriving it at apply time is the only
 * placement that is correct for both attempts, and it is why everything
 * reported below — the note, `changed`, the journal — is built from the
 * quantity that was ACTUALLY applied and never from the one we asked for.
 *
 * A `roll`'s or a shrinking `resize`'s refused half also leaves a position
 * unbooked, but the book alone cannot say which half it was, so those are
 * reported rather than guessed at.
 *
 * Written through WP-G's compare-and-set: the book is a whole-document
 * read-modify-write and this job runs beside live decisions, so a lost race is
 * re-folded onto the winner's legs (`book-write.ts`) rather than clobbering
 * them.
 */
async function compensate(
  deps: ReconcileDeps,
  input: {
    readonly tag: string
    readonly fill: Record<string, unknown>
    readonly shortfall: number
    readonly price: number
    readonly now: number
    /** The gateway `clientOrderId` — this fold's receipt. See below. */
    readonly nonce: string
  },
): Promise<FoldOutcome> {
  const { tag, fill, shortfall, price, now, nonce } = input
  const tradingsymbol = str(fill['tradingsymbol'])
  const side = flip(fill['side'])
  if (tag === '' || tradingsymbol === '' || side === null) {
    return { note: 'book NOT corrected — the decision fill is unreadable', changed: false, retry: false }
  }

  const doc = await deps.store.bookDoc(tag, 'live')
  if (doc === null) {
    // A hosted strategy has no book, and a deleted book must never be
    // resurrected by a reconciler. Neither is an error.
    return NO_FOLD
  }

  /**
   * THE FOLD ALREADY LANDED — the crash window `foldDone` could not close.
   *
   * `foldDone` is stamped on `desk-decisions` AFTER the fold is written to
   * `desk-books`: two documents, two writes, and a process that died in between
   * left a book that had been folded and a record that said it had not. The
   * next pass re-folded it, and for a refused CLOSE — the one regime allowed to
   * CREATE a leg — that is a second position nobody ordered, a repair inventing
   * exactly the exposure it exists to remove.
   *
   * So the proof rides WITH the fold: `saveBook` appends this nonce to the
   * book's `appliedCorrections` inside the same `updateOne` as the legs. A
   * nonce already present is therefore the book itself saying the fold is on
   * it, which no crash can contradict. Nothing is written, and the caller goes
   * on to repair the missing stamp (`markFoldDone`) instead of the book.
   */
  if ((doc.appliedCorrections ?? []).includes(nonce)) {
    return { note: alreadyApplied(nonce), changed: false, retry: false }
  }

  const legs = doc.legs
  const held = legs.some((l) => l.instrument.tradingsymbol === tradingsymbol)
  const restoring = fill['op'] === 'close'

  let view: readonly BridgeLeg[] = []
  if (restoring && !held) {
    const meta = restoreView(deps.master(), tradingsymbol, doc)
    if (meta === null) {
      return {
        note:
          `book NOT corrected — ${tradingsymbol} is not resolvable in ${doc.symbol} ` +
          `${doc.expiry}; the position it refused to close is NOT on the book`,
        changed: false,
        retry: false,
      }
    }
    view = [meta]
  }

  const op = fill['op']
  const compensating: RefoldFill = {
    op: op === 'open' || op === 'close' || op === 'roll' || op === 'resize' ? op : 'close',
    /**
     * The refused fill's own tag, and it only matters when a leg is CREATED.
     *
     * For `applyActions` that IS the book leg's tag, so a restored leg comes
     * back under the name the Python desk knows it by. For a FLATTEN it is the
     * order id (`decision-plan.ts:388`) — the leg's original tag died with the
     * leg and nothing records it, so a leg restored from a refused flatten
     * carries the flatten's tag and the supervisor will treat it as an
     * unmanaged position. That is visible and safe; inventing the old tag
     * would not be.
     */
    deskTag: str(fill['deskTag']),
    tradingsymbol,
    side,
    qty: shortfall,
    price,
    ts: now,
    // A RESTORE may add; everything else may only consume. See the header.
    ...(restoring ? {} : { reduceOnly: true }),
  }
  const mayCreate = restoring
  const folded = refoldRoutedFills({
    legs,
    routedFills: [compensating],
    views: [legs, view],
    mayCreate,
    nowMs: now,
  })
  const applied = folded.outcomes[0]?.applied ?? 0
  if (applied <= 0) {
    return { note: nothingApplied(restoring, tradingsymbol), changed: false, retry: false }
  }

  const key = { tag, mode: 'live' as DeskMode, symbol: doc.symbol, expiry: doc.expiry }
  // The legs and the receipt, in ONE write. See the nonce check above for why
  // there must be no gap between them.
  const saved = await deps.store.saveBook(key, folded.legs, now, doc.updatedAt, nonce)
  if (saved === 'ok') {
    return { note: bookNote(restoring, applied, tradingsymbol), changed: true, retry: false }
  }

  const retried = await refoldOnConflict({
    store: deps.store,
    key,
    routedFills: [compensating],
    nextBook: folded.legs,
    priorBook: view,
    mayCreate,
    nowMs: now,
    nonce,
    log: (m) => deps.log(m),
  })
  if (retried.status === 'already-applied') {
    // Another pass of this same correction won the race and folded it. Finished
    // — by somebody else, which is still finished.
    return { note: alreadyApplied(nonce), changed: false, retry: false }
  }
  if (retried.status === 'lost') {
    // NOT done, and the caller must not mark it. The next pass retries the fold.
    return { note: 'book NOT corrected — the write lost its race (lost)', changed: false, retry: true }
  }
  if (retried.status === 'gone') {
    return { note: 'book NOT corrected — the book was deleted', changed: false, retry: false }
  }
  /**
   * THE RETRY'S OWN QUANTITY, never the one we asked for.
   *
   * The winner may have taken part or all of the leg while we were writing; the
   * `reduceOnly` cap was therefore re-derived against ITS legs. Reporting the
   * requested size here — "book reduced by 500", `changed: true` — while zero
   * contracts moved is the desk being told a repair happened that did not.
   */
  const appliedOnRetry = retried.outcomes[0]?.applied ?? 0
  return appliedOnRetry > 0
    ? { note: bookNote(restoring, appliedOnRetry, tradingsymbol), changed: true, retry: false }
    : { note: nothingApplied(restoring, tradingsymbol), changed: false, retry: false }
}

function alreadyApplied(nonce: string): string {
  return (
    `book already carries this correction (${nonce}) — folded on an earlier pass that died ` +
    `before it could say so; NOT folded twice`
  )
}

function nothingApplied(restoring: boolean, tradingsymbol: string): string {
  return restoring
    ? `book NOT corrected — nothing in it matched ${tradingsymbol}`
    : `book NOT corrected — nothing left to reduce for ${tradingsymbol}; it holds no ` +
        'offsetting quantity'
}

function bookNote(restoring: boolean, qty: number, tradingsymbol: string): string {
  return restoring
    ? `book RESTORED ${qty} ${tradingsymbol} the broker refused to close`
    : `book reduced by ${qty} ${tradingsymbol}`
}

/**
 * The contract identity a restored leg needs, found in the LISTED chain.
 *
 * A `Fill` carries a tradingsymbol and nothing else, and `BridgeLeg` needs the
 * strike and the type. They are recovered by asking the master for every listed
 * strike of the book's own underlying and expiry and finding the one whose
 * tradingsymbol matches — never by parsing the symbol, which is the string
 * surgery that fabricated the C4 phantom PE. A contract the chain does not
 * contain comes back `null` and the caller reports rather than invents.
 *
 * The underlying and expiry come from the BOOK document, not the decision: a
 * flatten files its record under `expiry: ''` (`service.ts:1156`), and the book
 * is the record that always carries both.
 */
export function restoreView(
  master: ReconcileMaster,
  tradingsymbol: string,
  doc: { readonly symbol: string; readonly expiry: string },
): BridgeLeg | null {
  if (doc.symbol === '' || doc.expiry === '') return null
  for (const strike of master.strikes(doc.symbol, doc.expiry)) {
    for (const type of ['CE', 'PE'] as const) {
      const ref = master.resolve(doc.symbol, doc.expiry, strike, type)
      if (ref === null || ref.tradingsymbol !== tradingsymbol) continue
      // A META-ONLY leg. `refoldRoutedFills` reads a view for the contract's
      // identity and never for its size, so the quantity here is never booked.
      return {
        deskTag: '',
        instrument: ref,
        underlying: doc.symbol,
        expiry: doc.expiry,
        strike,
        type,
        side: 'Buy',
        qty: 0,
        entryPrice: 0,
        openedTs: 0,
      }
    }
  }
  return null
}

// -------------------------------------------------------------- journalling

/**
 * A gateway order that cannot be joined to a live decision.
 *
 * Journalled ONCE and marked, deliberately: it will never resolve on its own,
 * and a job that retried it every minute forever would bury the corrections
 * that matter under it. The mark carries `deskReconcileNote` rather than
 * `reason` — `queue.markInvalid` owns `reason`, and overwriting an INVALID
 * order's refusal text would destroy the only record of WHY it was refused.
 */
async function reportUnjoinable(
  deps: ReconcileDeps,
  doc: Record<string, unknown>,
  now: number,
  note: string,
  clientOrderId: string,
  decisionId: string,
): Promise<void> {
  await publish(deps, {
    ts: now,
    phase: 'STATUS',
    ok: false,
    tag: str(doc['tag']),
    tradingsymbol: str(doc['tradingsymbol']),
    clientOrderId,
    status: str(doc['state']),
    error:
      `reconcile: no matching live decision fill for '${clientOrderId}' ` +
      `(decision '${decisionId}') — its outcome cannot be booked back`,
    detail: { source: 'reconcile', mode: 'live', decisionId, note },
  })
  await markReconciled(deps, clientOrderId, now, note)
}

async function publish(deps: ReconcileDeps, event: Record<string, unknown>): Promise<void> {
  await deps.store.journalBlocked([event])
  if (deps.notify === undefined) return
  try {
    deps.notify('live', event)
  } catch {
    /* a dashboard that missed an update is an inconvenience */
  }
}

/** LAST, always — see the header's idempotency directive. */
async function markReconciled(
  deps: ReconcileDeps,
  clientOrderId: string,
  now: number,
  note?: string,
): Promise<void> {
  await deps.store.collection(COLLECTIONS.gatewayOrders).updateOne(
    { clientOrderId },
    {
      $set: {
        deskReconciled: true,
        deskReconciledAt: now,
        ...(note === undefined ? {} : { deskReconcileNote: note }),
      },
    },
  )
}

// ------------------------------------------------------------------- utils

function flip(side: unknown): DeskSide | null {
  if (side === 'Buy') return 'Sell'
  if (side === 'Sell') return 'Buy'
  return null
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}
