/**
 * Order intake: durable record, WebSocket nudge, claim-based pickup.
 *
 * NO CHANGE STREAM. That was modelled on `xtsOrder.js:314`, which is the
 * pattern being replaced, and it drags in a replica-set dependency on the order
 * path for no benefit over what is here.
 *
 * But nor is it pure pub/sub. The distinction that matters:
 *
 *   A tick published to a disconnected subscriber is harmless — another arrives
 *   in 30 seconds. An ORDER published to a disconnected gateway is GONE, and
 *   the desk believes it placed something that never reached a broker. Market
 *   data can be lossy; orders cannot.
 *
 * So the collection is the durable record (write-ahead, exactly as
 * `packages/order-bus/wal.ts` intends) and the bus carries only a NUDGE saying
 * "something is waiting". Losing a nudge costs latency, never an order: the
 * sweep picks it up regardless.
 *
 * CLAIMING is what makes multiple gateway instances safe. An order is taken by
 * a conditional update that only succeeds for one caller; a second gateway
 * finds it already claimed and moves on. Without it, two instances started by a
 * careless deploy would both place every order.
 */

export type OrderState =
  /** Written by the bridge, not yet taken. */
  | 'PENDING'
  /** Claimed by a gateway instance; placement in flight. */
  | 'CLAIMED'
  /** Handed to the broker; awaiting terminal status. */
  | 'PLACED'
  | 'FILLED'
  /**
   * Every tranche is terminal but the order did not fill in full — one tranche
   * rejected, or a partial fill that stopped.
   *
   * Distinct from both FILLED and REJECTED on purpose. A partially filled split
   * order is a REAL position of a size nobody asked for; reporting it as FILLED
   * over-books it and reporting it as REJECTED tells the desk it holds nothing,
   * and flattening against that difference opens a fresh position the other way.
   */
  | 'PARTIAL'
  | 'REJECTED'
  /**
   * A GATED order whose sequence was stopped part-way (D11).
   *
   * A tranche came back REJECTED — or terminal short of its size — so the
   * tranches after it were never placed. Terminal for this process: nothing
   * re-arms it, and the remainder is a decision for a human or for the
   * supervisor's next pass, which reasons about the BOOK rather than about one
   * order document.
   *
   * Its own state rather than PARTIAL because the two say different things to
   * whoever is looking: PARTIAL means the broker is finished with an order that
   * did not fully fill, HALTED means THIS GATEWAY STOPPED — there is size the
   * desk asked for that was never shown to the market at all. Reporting the
   * second as the first hides a decision the gateway took.
   */
  | 'HALTED'
  /** Could not be planned at all (unresolvable, bad quantity). */
  | 'INVALID'

export interface ClaimResult {
  readonly claimed: boolean
  readonly reason?: string
}

/** Minimal Mongo surface. Same narrow-port reasoning as apps/api/src/store.ts. */
export interface QueueCollection {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): { limit(n: number): { toArray(): Promise<Record<string, unknown>[]> } }
  }
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ value?: Record<string, unknown> | null } | Record<string, unknown> | null>
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

/**
 * A claim that has been held too long is presumed dead.
 *
 * A gateway that crashes mid-placement leaves its order CLAIMED forever, and
 * the order silently never goes out. Reclaiming after a timeout trades that for
 * a stuck order being caught by nobody.
 *
 * It does NOT trade it for a double placement, and the earlier claim that the
 * broker-side correlation id catches one was wrong: the wire id is
 * `tag|clientOrderId` truncated to 45 chars (see `getByBrokerOrderId`), so it is
 * not unique and the broker will happily accept the same tranche twice. What
 * makes a reclaim safe is `placementStartedAt` — a claim carrying it is routed
 * into recovery from the journal, never into a fresh placement.
 *
 * 180s, not 60s, because it must EXCEED worst-case placement: three retry
 * attempts x a 15s transport timeout, per tranche, and a frozen index order is
 * several tranches. The placement loop also heartbeats the claim per tranche, so
 * this bound only ever has to cover the gap between two tranches.
 */
export const CLAIM_TIMEOUT_MS = 180_000

/**
 * States after which nothing re-decides an order.
 *
 * HALTED is one of them: the sequence was stopped deliberately, and a later
 * fill on the tranche that was already live must not be able to restart it.
 * Shared with the fill watcher (which stops reconciling on them) and with the
 * broker-id lookup below, `getByBrokerOrderId` (which prefers a document NOT
 * in one of them).
 */
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'FILLED',
  'PARTIAL',
  'REJECTED',
  'INVALID',
  'HALTED',
])

/**
 * How old a queued order may be before it is refused as stale-priced.
 *
 * IT MUST EXCEED `CLAIM_TIMEOUT_MS`, and lives here rather than next to its
 * caller so that the two constants cannot drift apart unseen.
 *
 * When they were EQUAL (both 180s) a reclaim was a guaranteed dead end: an
 * order claimed at T and orphaned by a dying gateway is only reclaimable at
 * T+180s, by which time it is — always, deterministically — past a 180s age
 * bound. Every orphaned order was therefore refused rather than recovered, and
 * the timeout that exists to rescue stuck orders could only ever bin them. The
 * gap between the two is the window a single reclaim has to actually place.
 */
export const DEFAULT_ORDER_MAX_AGE_MS = 300_000

export interface OrderQueueDeps {
  readonly collection: QueueCollection
  /** Identifies this gateway instance in the claim. */
  readonly workerId: string
  readonly now: () => number
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

/**
 * Every write a CLAIM HOLDER makes is fenced on the claim.
 *
 * Filtering on `clientOrderId` alone was not enough. A worker that stalls past
 * `CLAIM_TIMEOUT_MS` loses its claim to a reclaimer but keeps running: it goes
 * on placing tranches, and then writes `markPlaced`/`markInvalid` over the top
 * of whatever the new owner concluded. Two processes then disagree about one
 * order and the LAST WRITER WINS, which is the stalled one.
 *
 * Adding `claimedBy` to the filter makes every such write a no-op — the zombie
 * matches nothing, so the reclaimer's recovery outcome stands. `heartbeat`
 * reports that back as a boolean so the placement loop can stop rather than
 * keep sending tranches nobody will account for.
 *
 * `markTerminal` is deliberately NOT fenced: the fill watcher writes it, and it
 * never holds the claim.
 */
const fenced = (clientOrderId: string, workerId: string): Record<string, unknown> => ({
  clientOrderId,
  claimedBy: workerId,
})

/**
 * Did the update reach a document?
 *
 * `undefined` where the driver reports nothing, which the callers read as "yes,
 * still ours": the fence has already been applied server-side, and treating
 * silence as a lost claim would abandon a healthy placement mid-flight.
 */
function matchedCountOf(res: unknown): number | undefined {
  if (res === null || typeof res !== 'object' || !('matchedCount' in res)) return undefined
  const n = (res as { matchedCount?: unknown }).matchedCount
  return typeof n === 'number' ? n : undefined
}

export class OrderQueue {
  readonly #d: OrderQueueDeps

  constructor(deps: OrderQueueDeps) {
    this.#d = deps
  }

  async ensureIndexes(): Promise<void> {
    await this.#d.collection.createIndex({ state: 1, createdAt: 1 })
    // The bridge's clientOrderId is the idempotency key end to end.
    await this.#d.collection.createIndex({ clientOrderId: 1 }, { unique: true })
    // The fill watcher resolves truncated socket echoes by ACKed broker id.
    await this.#d.collection.createIndex({ brokerOrderIds: 1 })
  }

  /**
   * Take the next order, or null when there is nothing to do.
   *
   * The claim is a CONDITIONAL update on `state`, so of two gateways racing for
   * the same document exactly one wins — the loser's filter matches nothing.
   */
  async claimNext(): Promise<Record<string, unknown> | null> {
    const now = this.#d.now()
    const staleBefore = now - CLAIM_TIMEOUT_MS
    const res = await this.#d.collection.findOneAndUpdate(
      {
        $or: [
          { state: 'PENDING' },
          // Reclaim a dead worker's order rather than leaving it stuck forever.
          { state: 'CLAIMED', claimedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { state: 'CLAIMED', claimedBy: this.#d.workerId, claimedAt: now } },
      { sort: { createdAt: 1 }, returnDocument: 'after' },
    )
    return unwrap(res)
  }

  /** One order document by its idempotency key. */
  async get(clientOrderId: string): Promise<Record<string, unknown> | null> {
    return await this.#d.collection.findOne({ clientOrderId })
  }

  /**
   * The order an ACKed broker id belongs to.
   *
   * The broker echoes our `OrderUniqueIdentifier` on its socket, but the wire
   * format is `tag|clientOrderId` capped at 45 chars — a 32-char tag leaves 12
   * for the id, so every leg of one book echoes the SAME truncated id and the
   * echo alone cannot name the order. `AppOrderID` can: it is unique and it
   * survives any truncation — but it is stored by `markPlaced` AFTER the whole
   * tranche loop, not at ACK, so a fast fill can beat it here and land
   * unattributed. `FillWatcher.#fillsFor` recovers those rows by broker id at
   * the post-placement reconcile.
   */
  async getByBrokerOrderId(brokerOrderId: string): Promise<Record<string, unknown> | null> {
    if (brokerOrderId === '') return null
    /**
     * A BROKER ORDER ID IS NOT UNIQUE ACROSS DAYS. XTS's AppOrderID can be
     * reused, so yesterday's FILLED document and today's PLACED one can hold
     * the same id — and a `findOne` on the multikey equality yields whichever
     * Mongo likes, in practice the one inserted first. A fill for today's
     * order then landed on yesterday's terminal document, tagged and
     * journalled under yesterday's book (F3). Two candidates, newest first;
     * the one still WORKING is the one a fill can be for. With a single match
     * this is exactly what it always was, so `isPaperBrokerOrder` and the
     * sweep's foreign test are unchanged.
     */
    const docs = await this.#d.collection
      .find({ brokerOrderIds: brokerOrderId })
      .sort({ createdAt: -1 })
      .limit(2)
      .toArray()
    return docs.find((d) => !TERMINAL_STATES.has(String(d['state'] ?? ''))) ?? docs[0] ?? null
  }

  /**
   * A placement is about to go on the wire.
   *
   * Written BEFORE the first tranche, so its presence on a later claim means
   * "a placement was interrupted" and never "nothing was sent". That asymmetry
   * is the whole design: a marker written after the fact would be missing in
   * exactly the crash window it exists to describe, and the reclaim would
   * re-place tranches that are already live at the broker.
   *
   * `placeAttempts` bounds the recovery: an order that keeps being interrupted
   * is dead-lettered rather than looping through recovery forever.
   */
  async markPlacing(clientOrderId: string): Promise<void> {
    const res = await this.#d.collection.updateOne(
      fenced(clientOrderId, this.#d.workerId),
      { $set: { placementStartedAt: this.#d.now() }, $inc: { placeAttempts: 1 } },
    )
    this.#warnIfUnmatched('markPlacing', clientOrderId, res)
  }

  /**
   * This gateway is still working on the order.
   *
   * A multi-tranche placement can outlive `CLAIM_TIMEOUT_MS` on its own (retries
   * x transport timeout x tranches), and a claim that expires under a LIVE
   * placement is the one case where two gateways are both on the wire for the
   * same order. Refreshing per tranche keeps the timeout covering only the gap
   * between two tranches, which is the interval it can actually bound.
   *
   * RETURNS whether this worker still holds the claim. False means a reclaimer
   * took the order while this placement was in flight, and the caller must stop
   * placing: from that moment the reclaimer's recovery owns the outcome, and
   * every further tranche is one nothing will ever account for.
   */
  async heartbeat(clientOrderId: string): Promise<boolean> {
    const res = await this.#d.collection.updateOne(
      fenced(clientOrderId, this.#d.workerId),
      { $set: { claimedAt: this.#d.now() } },
    )
    const matched = matchedCountOf(res)
    return matched === undefined || matched > 0
  }

  /**
   * Record the placement outcome.
   *
   * `trancheIds` and `expectedQty` are persisted because the FILL WATCHER needs
   * them and cannot derive them: a fill arriving as `X.2` says nothing about how
   * many tranches `X` became or how many contracts it was for, and a gateway
   * that restarted between placing and filling has no memory of either. Without
   * them the watcher can only ever say "every tranche I have heard from is
   * done", which is also true after the first of three.
   *
   * `failedTrancheIds` are terminal with zero fill — the broker refused them, so
   * no order update will ever arrive and an order waiting on one waits forever.
   *
   * `ambiguousTrancheIds` are the OPPOSITE of that, and the distinction is the
   * whole of F-3. A placement that timed out may be live at the exchange: it
   * cannot be retried (that double-places) and it cannot be called failed (that
   * un-books a real position), so it goes in neither the placed list nor the
   * failed one. `aggregateTranches` therefore still counts it as WORKING, the
   * desk order stays PLACED — non-terminal — and the broker sweep settles it
   * from the only source that knows: the broker's own order book.
   */
  async markPlaced(
    clientOrderId: string,
    outcome: {
      readonly brokerOrderIds: readonly string[]
      readonly trancheIds: readonly string[]
      readonly failedTrancheIds: readonly string[]
      /** Placement outcome genuinely unknown. Defaults to none. */
      readonly ambiguousTrancheIds?: readonly string[]
      readonly expectedQty: number
      /**
       * A LATER SLICE of a gated order: add these ids to what the document
       * already carries instead of replacing them.
       *
       * Replacing is what an ungated order wants and what every write before
       * gating did. For slice 2 it would DELETE slice 1's tranche and broker
       * ids — the ones that have already filled — and the aggregate would then
       * see three lots of a nine-lot order, wait forever for tranches it no
       * longer knows the names of, and leave the desk order PLACED for the rest
       * of the session while the broker held it done.
       */
      readonly append?: boolean
    },
  ): Promise<void> {
    const ambiguous = outcome.ambiguousTrancheIds ?? []
    const update: Record<string, unknown> = outcome.append === true
      ? {
          $set: { state: 'PLACED', expectedQty: outcome.expectedQty, placedAt: this.#d.now() },
          // One operator per field: `$set` and `$push` on the same key is an
          // outright Mongo error, not a last-writer-wins.
          $push: {
            brokerOrderIds: { $each: [...outcome.brokerOrderIds] },
            trancheIds: { $each: [...outcome.trancheIds] },
            failedTrancheIds: { $each: [...outcome.failedTrancheIds] },
            ambiguousTrancheIds: { $each: [...ambiguous] },
          },
        }
      : {
          $set: {
            state: 'PLACED',
            brokerOrderIds: outcome.brokerOrderIds,
            trancheIds: outcome.trancheIds,
            failedTrancheIds: outcome.failedTrancheIds,
            // ALWAYS written, empty or not: the sweep reads this field on every
            // PLACED document, and an absent one would have to mean both
            // "nothing ambiguous" and "written before this existed".
            ambiguousTrancheIds: ambiguous,
            expectedQty: outcome.expectedQty,
            placedAt: this.#d.now(),
          },
        }
    const res = await this.#d.collection.updateOne(fenced(clientOrderId, this.#d.workerId), update)
    this.#warnIfUnmatched('markPlaced', clientOrderId, res)
  }

  /**
   * Record how a large order will be worked, before its first tranche goes out.
   *
   * PERSISTED RATHER THAN RE-DERIVED, and that is the point of the field: the
   * freeze table is refreshed on an interval and the book's dial can be changed
   * mid-session, so a plan recomputed for slice 3 could legitimately disagree
   * with the one slice 1 was cut from — different sizes, a different number of
   * slices, and a cursor that now points at the wrong quantity. The plan is
   * decided once and the document carries it.
   *
   * Fenced on the claim like every other placement write.
   */
  async writeTranchePlan(
    clientOrderId: string,
    plan: readonly { readonly qty: number }[],
  ): Promise<void> {
    const res = await this.#d.collection.updateOne(
      fenced(clientOrderId, this.#d.workerId),
      { $set: { tranchePlan: plan.map((t) => ({ qty: t.qty })), trancheCursor: 0 } },
    )
    this.#warnIfUnmatched('writeTranchePlan', clientOrderId, res)
  }

  /**
   * Release the next tranche: move the cursor on and re-arm the document.
   *
   * A COMPARE-AND-SET ON THE CURSOR ITSELF (F-10), and nothing about this is
   * decorative. The advance is decided by the fill watcher, which runs from a
   * broker socket callback, a boot reconcile and the end of every placement —
   * three sources that can observe ONE terminal tranche at the same moment. A
   * read-then-write would let both conclude "advance from 0", both re-arm the
   * document, and the sweeper place tranche 2 twice: two live orders at one
   * price, for double the size the desk chose to show. Conditioning the update
   * on the cursor value the caller acted on means the second one matches
   * nothing and is told so.
   *
   * `state: 'PLACED'` IS PART OF THE CONDITION, for the same reason
   * `decideTrancheStep` refuses to decide off any other state: a document that
   * is CLAIMED has a placement in flight, and re-arming it underneath that
   * placement would hand the same slice to a second claim.
   *
   * RETURNS whether this caller won. False is not an error — it is the race
   * being handled — but it must never be ignored, because the caller's next act
   * would otherwise be to conclude something about a document it no longer
   * describes.
   *
   * WHAT IT CLEARS is as important as what it sets:
   *   - `placementStartedAt`, or `processOne` would route the re-armed document
   *     into recovery and place nothing, forever;
   *   - the claim fields, so the sweeper can take it;
   *   - `placeAttempts`, because the dead-letter counter bounds ONE placement's
   *     recovery loop, and a five-slice order would otherwise dead-letter on its
   *     fourth slice for having been placed four times, exactly as intended;
   *   - the CHASER's per-slice state (`chaseAttempts`, `chasedAt`,
   *     `lastChasePrice`, `chaseExhaustedAt`, `pegCrossedAt`). A slice whose
   *     chase exhausted leaves `chaseExhaustedAt` behind, and the chaser skips
   *     any document carrying it — so every later tranche of that order would
   *     rest at a price nothing re-pegs, on a passive order, in silence.
   */
  async advanceTranche(clientOrderId: string, fromCursor: number): Promise<boolean> {
    const res = await this.#d.collection.findOneAndUpdate(
      { clientOrderId, trancheCursor: fromCursor, state: 'PLACED' },
      {
        $set: {
          trancheCursor: fromCursor + 1,
          state: 'PENDING',
          // The age the staleness gate measures this tranche by. See
          // `refusesStaleOrder`'s caller: an order part-way through a sequence
          // is a live decision in progress, not a queued order nobody has
          // acted on, and refusing its remainder for age would leave the desk
          // holding a partial position with the rest never worked.
          trancheArmedAt: this.#d.now(),
          placeAttempts: 0,
        },
        $unset: {
          placementStartedAt: '',
          claimedBy: '',
          claimedAt: '',
          chaseAttempts: '',
          chasedAt: '',
          lastChasePrice: '',
          chaseExhaustedAt: '',
          pegCrossedAt: '',
        },
      },
      { returnDocument: 'after' },
    )
    return unwrap(res) !== null
  }

  /**
   * Stop a gated order part-way and say so on the document (D11).
   *
   * NOT FENCED ON THE CLAIM, like `markTerminal`: the fill watcher writes it and
   * never holds one. `filledQty`/`avgPrice` are carried because the position is
   * REAL — `service.ts:#actualEntries` prices legs off exactly these fields and
   * `reconcile-live.ts` folds the shortfall back off them, so a halt that
   * recorded only its own reason would leave a leg that traded marked at the
   * seed price.
   *
   * IT IS STILL CONDITIONAL, on the window the caller decided in — the same
   * discipline `advanceTranche` uses (F-10). Both callers read a document, reach
   * a conclusion, and write it some awaits later; between those two moments the
   * cursor can move or another watcher can settle the order, and a blind write
   * would stamp a stale conclusion (a stale cursor's `filledQty`, over a state
   * somebody else has already decided) onto whatever is there now.
   *
   * RETURNS whether it landed, so the caller can say so rather than assume.
   */
  async markHalted(
    clientOrderId: string,
    detail: Record<string, unknown>,
    expect?: { readonly state: string; readonly trancheCursor: number },
  ): Promise<boolean> {
    const res = await this.#d.collection.updateOne(
      {
        clientOrderId,
        ...(expect === undefined
          ? {}
          : { state: expect.state, trancheCursor: expect.trancheCursor }),
      },
      { $set: { state: 'HALTED', ...detail, resolvedAt: this.#d.now() } },
    )
    const matched = matchedCountOf(res)
    // `undefined` is "the driver said nothing", which the fenced writes above
    // also read as success — silence is not evidence of a lost race.
    return matched === undefined || matched > 0
  }

  /**
   * The broker had no trace of an ambiguous tranche: it never reached the
   * exchange after all, so it becomes a plain failure.
   *
   * ONE TRANCHE AT A TIME, with `$pull`/`$addToSet` rather than a whole-array
   * `$set`: the sweep runs on an interval and a fill can land between two of
   * its passes, so rewriting both arrays wholesale would clobber whatever the
   * fill path concluded in between. Both operators are idempotent, which is
   * what makes a crashed pass safe to repeat.
   *
   * NOT fenced on the claim — like `markTerminal`. The placement claim is long
   * gone by the time the TTL expires, and a fenced write would match nothing
   * and silently do nothing.
   */
  async resolveAmbiguous(clientOrderId: string, trancheId: string): Promise<void> {
    await this.#d.collection.updateOne(
      { clientOrderId },
      {
        $pull: { ambiguousTrancheIds: trancheId },
        $addToSet: { failedTrancheIds: trancheId },
      },
    )
  }

  async markInvalid(clientOrderId: string, reason: string): Promise<void> {
    const res = await this.#d.collection.updateOne(
      fenced(clientOrderId, this.#d.workerId),
      { $set: { state: 'INVALID', reason, resolvedAt: this.#d.now() } },
    )
    this.#warnIfUnmatched('markInvalid', clientOrderId, res)
  }

  /**
   * A fenced write that matched nothing is CORRECT — the claim moved and the new
   * owner has already written the outcome — but it must never be silent. It is
   * the only trace that two processes were on one order, and an operator
   * comparing the desk against the broker has nothing else to go on.
   */
  #warnIfUnmatched(what: string, clientOrderId: string, res: unknown): void {
    if (matchedCountOf(res) !== 0) return
    this.#d.log?.(
      `${what} matched NO document [${clientOrderId}] — this worker no longer holds the claim; ` +
        `the reclaimer owns the outcome`,
      { workerId: this.#d.workerId },
    )
  }

  /**
   * Resolve an order.
   *
   * ONLY the fill watcher's aggregate may call this, and only once every tranche
   * is accounted for — see `gateway.ts:decideOrderOutcome`. Calling it from a
   * single broker update marks a 30-lot order FILLED while 6 lots are still
   * working, at the last tranche's price.
   */
  async markTerminal(
    clientOrderId: string,
    state: 'FILLED' | 'PARTIAL' | 'REJECTED',
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#d.collection.updateOne(
      { clientOrderId },
      { $set: { state, ...detail, resolvedAt: this.#d.now() } },
    )
  }

  /** Orders still awaiting pickup. Surfaced on the health endpoint. */
  async pendingCount(): Promise<number> {
    const rows = await this.#d.collection
      .find({ state: 'PENDING' })
      .sort({ createdAt: 1 })
      .limit(1000)
      .toArray()
    return rows.length
  }
}

/**
 * Driver 3.x returns `{value}`; driver 4+ returns the document. Normalising
 * here keeps the pin-to-3.7.3 decision from leaking into the caller.
 */
function unwrap(
  res: { value?: Record<string, unknown> | null } | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (res === null) return null
  if (typeof res === 'object' && 'value' in res) {
    return (res as { value?: Record<string, unknown> | null }).value ?? null
  }
  return res as Record<string, unknown>
}

// ---------------------------------------------------------------- admission

/**
 * Refuse a queued order older than `maxAgeMs` — its price is stale.
 *
 * A queued order's marketable limit was priced off a mark that is now `maxAgeMs`
 * old, so placing it executes a price nobody chose. The writer's own retry and
 * replay machinery re-plans with fresh pricing; a refusal is therefore recovered
 * from, whereas a stale placement is a real position at a real bad price.
 *
 * PURE AGE ONLY. Whether the age may be acted on is `refusesStaleOrder`'s
 * decision, because it depends on which way the order moves exposure.
 *
 * `createdAt <= 0` is NEVER stale. Legacy and hand-written documents carry no
 * timestamp, and reading a missing one as "infinitely old" would mass-refuse the
 * entire backlog the first time this shipped.
 */
export function isStaleOrder(createdAt: number, nowMs: number, maxAgeMs: number): boolean {
  return createdAt > 0 && nowMs - createdAt > maxAgeMs
}

/**
 * The ops that can only ever REDUCE exposure, as far as this process can tell.
 *
 * `desk_op` is the gateway's one exposure signal — it cannot see the book — so
 * this is a statement about intent, not about size.
 */
const EXPOSURE_REDUCING_OPS = new Set(['close', 'roll', 'resize'])

/** Known to reduce (or at worst re-shape) exposure. Unknown/absent is NOT. */
export function reducesExposure(deskOp: string | undefined): boolean {
  return deskOp !== undefined && EXPOSURE_REDUCING_OPS.has(deskOp)
}

/**
 * Does the age bound refuse this queued order?
 *
 * ONLY FOR ORDERS THAT ADD EXPOSURE — the same governing rule as the halt. A
 * stale entry is genuinely better refused: nothing is at risk yet, and the
 * writer re-plans with fresh pricing.
 *
 * An EXIT is the opposite trade, and refusing one was the defect. The bridge
 * books the desk's position at WRITE time, and NOTHING un-books a gateway
 * refusal — so a refused close leaves the desk reading flat while the real
 * position is still live at the broker, and the next decision is taken against a
 * book that does not exist. A stale-priced exit that merely rests unfilled is
 * far nearer the desk's intent than that: it is visible in the orderbook, it can
 * be chased, and the position it is closing is still on the desk's own books.
 * So exits go out regardless of age.
 */
export function refusesStaleOrder(
  deskOp: string | undefined,
  createdAt: number,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (reducesExposure(deskOp)) return false
  return isStaleOrder(createdAt, nowMs, maxAgeMs)
}

/** What the gateway could learn about the halt. `unreadable` is a Mongo failure. */
export type HaltState = 'off' | 'on' | 'unreadable'

/**
 * Does the halt refuse this queued order?
 *
 * THE GOVERNING RULE, identical to `apps/api/src/safety.ts`: a halt stops NEW
 * EXPOSURE and never blocks an exit. Trapping an open position behind a safety
 * control is worse than whatever the control was protecting against.
 *
 * So the pass list is the KNOWN exposure-reducing ops, not "anything that is not
 * `open`". Refusing only `open` failed OPEN for everything else: a document with
 * a misspelt, renamed or absent `desk_op` sailed through an engaged kill switch
 * and opened a fresh position — the one thing the switch exists to stop. An
 * unknown op is unknown in both directions, and the fail-closed rule that
 * governs every other gate on this path applies to it.
 *
 * The exits keep passing even when the switch is UNREADABLE. A Mongo blip must
 * not be able to trap a live position.
 *
 * ACCEPTED RESIDUAL: a queued `resize` that GROWS a position passes. This
 * process cannot see the book, so it cannot tell a grow from a shrink, and
 * trapping a shrink — which is an exit — is the worse of the two errors. A
 * resize decided AFTER the halt engages is caught by the bridge's write-time
 * gate; only one already sitting in the queue can slip through.
 */
export function haltsQueuedOrder(deskOp: string | undefined, halt: HaltState): boolean {
  if (halt === 'off') return false
  return !reducesExposure(deskOp)
}

// ------------------------------------------------------------------ sweeping

export interface SweeperDeps {
  /** Usually `OrderQueue.claimNext`. */
  claimNext(): Promise<Record<string, unknown> | null>
  /** What to do with one claimed order. May throw; one bad order is not a bad sweep. */
  handle(doc: Record<string, unknown>): Promise<void>
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly now: () => number
}

export interface Sweeper {
  /** Drain the queue. NEVER REJECTS. */
  sweep(): Promise<void>
  readonly lastSweepMs: number
  readonly running: boolean
}

/**
 * The drain loop, extracted so its failure behaviour is testable.
 *
 * IT MUST NEVER REJECT. Both call sites are `void sweep()` — a bus subscription
 * and a 1s interval — so a rejection here is an unhandled rejection, and Node 24
 * exits the process on those. That is G4: a Mongo blip inside `claimNext()`
 * killed the only process that can place orders, mid-session. The original had
 * `try { … } finally { sweeping = false }` with no catch, which releases the
 * lock and then re-throws.
 *
 * Concurrency 1: overlapping sweeps would race for the same claim and double the
 * broker load for nothing.
 */
export function createSweeper(deps: SweeperDeps): Sweeper {
  let running = false
  let lastSweepMs = 0

  return {
    get running(): boolean {
      return running
    },
    get lastSweepMs(): number {
      return lastSweepMs
    },
    async sweep(): Promise<void> {
      if (running) return
      running = true
      try {
        for (;;) {
          const doc = await deps.claimNext()
          if (doc === null) break
          try {
            await deps.handle(doc)
          } catch (err) {
            // One order that cannot be processed must not stop the queue: the
            // rest may be stop-losses.
            deps.log('order processing threw', { error: String(err) })
          }
        }
        lastSweepMs = deps.now()
      } catch (err) {
        // The claim itself failed. The next tick sweeps again; the order is
        // still PENDING and still durable, which is the whole point of the
        // collection being the record rather than the bus.
        deps.log('sweep FAILED — will retry on the next tick', { error: String(err) })
      } finally {
        running = false
      }
    },
  }
}

// ------------------------------------------------------------------ nudging

/**
 * Topic the bridge publishes on after durably writing an order.
 *
 * RE-EXPORTED, NOT DECLARED. It used to be declared right here, which made this
 * file the only owner of a string desk-api also has to know — and desk-api
 * cannot import an app package, so it never knew it and never published. The
 * subscription below ran for months against a topic with no publisher. It now
 * lives in `@algomaker/desk-engine`'s wire contract, beside the decision path,
 * where both processes read the same constant. Kept exported from here so every
 * existing importer in this app is unaffected.
 */
export { ORDER_NUDGE_TOPIC, type NudgePayload } from '@algomaker/desk-engine'

/**
 * Should the gateway sweep right now?
 *
 * Pure so the pacing is testable. A nudge means work is definitely waiting, so
 * sweep immediately. Otherwise sweep on the idle interval — that is the safety
 * net that makes a dropped nudge cost latency instead of an order.
 */
export function shouldSweep(params: {
  nudged: boolean
  msSinceLastSweep: number
  idleIntervalMs: number
}): boolean {
  if (params.nudged) return true
  return params.msSinceLastSweep >= params.idleIntervalMs
}
