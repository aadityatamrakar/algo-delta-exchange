/**
 * `/v1/desk/submit` — ONE order from a hosted intraday strategy.
 *
 * The hosted strategies do not get a private order path. They go through the
 * same gates, the same journal and the same rails as the book-shaped decision
 * path (`POST /v1/desk/engine/decisions` → `applyDecision`), and the only thing
 * that differs is who forms the order (spec §4/§5). A second order path is a
 * second place to forget the kill switch.
 *
 * WHY A SEPARATE ENDPOINT AT ALL: the decision path is BOOK-shaped — a package
 * of open/close/resize against a stored book, one decisionId for the lot.
 * Intraday strategies own their positions internally and think in "buy 2 lots
 * of this contract", so expressing that as a book diff would mean inventing a
 * book on our side and then diffing it — a translation layer with its own
 * failure modes standing between a strategy and its stop-loss.
 *
 * CRASH SAFETY — the order of operations mirrors `service.ts:applyDecision`
 * exactly, and for the same reason:
 *
 *   - Route first, record after: a crash in between means the retry finds no
 *     record, re-submits, and DOUBLE-ORDERS.
 *   - Record first, route after: a crash in between means the retry finds the
 *     record and declines to re-route, so the order is silently LOST — but the
 *     record is sitting there in `ROUTING` saying exactly what happened.
 *
 * Losing an order loudly beats duplicating one silently, so the claim on
 * `clientOrderId` is written BEFORE anything routes. The unique index on
 * `desk-submissions.clientOrderId` is what makes that an actual lock rather
 * than a read-then-write race between N processes.
 *
 * RETRY UNDER THE SAME ID. A caller whose response went missing — a socket
 * reset, a 500, a timeout — MUST resubmit the SAME `clientOrderId`. Retrying
 * under a fresh one is the duplicate-order bug: both ids are new to both unique
 * indexes, so both route, and the strategy ends up with twice the position it
 * asked for while its ledger shows one. The endpoint therefore has to answer a
 * replay HONESTLY in every state, including the state where it does not yet
 * know the answer:
 *
 *   - `accepted: true`  + `status: 'DONE'`    — every tranche reached a rail.
 *   - `accepted: true`  + `status: 'FAILED'`  — PARTIAL. `routedLots` is what
 *     actually went out and it is SMALLER than `intendedLots`.
 *   - `accepted: false` + `status: 'DONE'`    — a gate refused; nothing was
 *     ever attempted, so the opportunity is genuinely still available.
 *   - `accepted: false` + `status: 'FAILED'`  — attempted, nothing routed.
 *   - `accepted: false` + `status: 'ROUTING'` + `indeterminate: true` — the
 *     claim exists but the process that owned it has not reported back. See
 *     `ROUTING_STALE_MS`.
 *
 * `accepted: false` is the deliberate boolean projection of the indeterminate
 * case. It is wrong in one direction only: a client that ignores
 * `indeterminate` under-books, and an under-booked position is recoverable by
 * the next replay once the record resolves. `accepted: true` would book a
 * position that may not exist, and a flatten against a phantom position opens a
 * NEW one in the opposite direction. Guessing "probably fine" here is worse
 * than admitting we do not know.
 *
 * `accepted: false` on a total routing failure is also what preserves anatomy
 * row 14: base.ts flips its "used this opportunity" flag only after a
 * successful submit, so a failed order leaves the opportunity available rather
 * than silently burning it.
 *
 * A REFUSAL IS 200 `{ accepted: false, reason }`, NOT A 4xx. The request was
 * processed and the body says precisely what happened; a 4xx would invite the
 * strategy to retry an order that may already be on the wire. The single
 * exception is an unregistered tag, which throws `UnknownStrategy` -> 403,
 * exactly as `/actions` does: a typo in a tag has no switch anywhere in the
 * portal, so it must fail loudly in the CLIENT's log rather than look like
 * "switched off, will resume later".
 */

import type { FreezeLimits, OptionMaster } from '@algomaker/instruments'
import type { InstrumentRef } from '@algomaker/order-bus'
import type { BridgeLeg, DeskMode, DeskSide, Fill, MarkSource } from './contract.ts'
import { applyRoutedFill } from './book.ts'
import { refoldOnConflict } from './book-write.ts'
import { errorMessage, isDuplicateKey } from './errors.ts'
import { deriveUnderlying } from '../../order-gateway/src/gateway.ts'
import type { JournalEntry } from './livebook.ts'
import { marketableLimit, type MarketableConfig } from './marketable.ts'
import { railFor, type OrderRail, type PaperFillEmit } from './rail.ts'
import { venueDay, type VenueSpec } from './venue.ts'
import type { MasterProvider } from './service.ts'
import { gateStrategy, UnknownStrategy, type StrategyRow } from './strategies.ts'
/**
 * Every PURE step of `submit` below — the gate verdicts, the sizing, the freeze
 * split, the claim record, the outcome classification. They live next door so
 * that this file is the ORDER of operations and nothing else; see
 * `submit-plan.ts`'s header.
 */
import {
  buildClaimRecord,
  chooseFillPrice,
  chooseLiveLots,
  classifyRouteOutcome,
  isGateRefusal,
  planTranches,
  screenRiskGate,
  screenSubmitGates,
  sumLots,
  trancheFill,
  type StoredSubmission,
  type SubmittedOrder,
} from './submit-plan.ts'
import { COLLECTIONS, type Collection } from './store.ts'
import { NO_EXPOSURE_LIMITS } from '@algomaker/order-bus'
import type { RiskGatePort } from './service.ts'
import { brokerLinkRefusal, type BrokerLinkState, type KillSwitchState } from './safety.ts'
import type { Validated } from './validate.ts'
import type { Log } from './routes/kit.ts'

/**
 * Submissions get their OWN collection rather than sharing `desk-decisions`.
 *
 * A submission is not a decision: it has no symbol, no expiry and no book, so
 * it would have to be padded with empty fields to fit, and every Phase B report
 * that aggregates decisions would then have to learn to ignore the padding.
 * Its own collection with its own unique index gives the same idempotency
 * guarantee without teaching four other readers about a shape they do not want.
 */
export const SUBMISSIONS = 'desk-submissions'

/**
 * A SECOND record, in `desk-decisions`, carrying the fills.
 *
 * Phase B's `PnlStore.loadFills` reads `desk-decisions` — the only collection
 * carrying `tag`, `mode` and a `Fill[]` in one document for BOTH paper and
 * live. The three order collections were rejected as a source because a PENDING
 * or rejected gateway row is indistinguishable from a filled one.
 *
 * So a hosted strategy that wrote only to the order queue would read as FLAT in
 * every P&L view while carrying real risk — no error anywhere, just a dashboard
 * card saying zero. The submission record above is the idempotency lock; this
 * one is the P&L journal, and it is written AFTER routing with only the
 * tranches that actually reached a rail, so what P&L sees is what went out.
 */
const PNL_JOURNAL = COLLECTIONS.decisions

export interface SubmitInstrument {
  readonly tradingsymbol: string
  readonly instrumentToken?: number
  readonly lotSize?: number
  readonly tickSize?: number
  readonly exchange?: string
}

export interface SubmitRequestBody {
  readonly tag: string
  readonly mode: DeskMode
  /** The caller's idempotency key. Same id twice places once. */
  readonly clientOrderId: string
  readonly instrument: SubmitInstrument
  readonly side: DeskSide
  readonly lots: number
  readonly orderType?: 'MARKET' | 'LIMIT'
  readonly limitPrice?: number
  readonly triggerPrice?: number
  /**
   * The strategy's own decision price (`SubmitRequest.referencePrice` on the
   * `orders` port).
   *
   * A hosted strategy read a quote before it decided; sending that price means
   * the fill can be journalled even when the bridge's own mark cache has not
   * caught up. Without it a cold cache would refuse orders the strategy priced
   * perfectly well a millisecond earlier.
   */
  readonly referencePrice?: number
  /**
   * True for an exit. It is the ONLY thing that lets an order past the kill
   * switch, so it is the strategy's assertion that this order reduces risk.
   */
  readonly reducesExposure?: boolean
  /**
   * SIZE THIS ORDER EXACTLY AS ASKED — do not apply the `liveLots` override.
   *
   * For a POSITIONAL BOOK's leg. Design spec §7.4: "a positional book sizes
   * from its seed and its variant dials, and MUST NOT pick up `liveLots` — a
   * book that quietly resized on going live would be a different strategy from
   * the one that was paper-tested." A condor may carry 2-lot wings against
   * 4-lot shorts, and the override would flatten them to one number.
   *
   * It does not weaken any gate: the registry row, the password-gated LIVE
   * switch and the broker mode all still apply. It only says where the SIZE
   * comes from.
   */
  readonly exactLots?: boolean
  /**
   * Underlying, for the freeze table and for order provenance. Optional and
   * additive to the published contract: without it the underlying is derived
   * from the trading symbol by the same leading-non-digit rule the gateway
   * uses, which cannot distinguish an underlying whose name contains a digit.
   * Hosted strategies always know theirs, so they always send it.
   */
  readonly underlying?: string
  /**
   * A DELIBERATELY pending order — sit at `limitPrice` until it trades or is
   * cancelled. Requires an explicit `orderType: 'LIMIT'`: a resting MARKET is
   * a contradiction, and a resting order priced by the marketable machinery
   * would rest at a price nobody chose. The flag rides the fill onto the
   * gateway's order document, where the order chaser reads it and stands down.
   */
  readonly resting?: boolean
  /**
   * Who authored this order. `repair` legs are adopted BOT-MANAGED by the
   * Python driver — no `protected` stamp; absent means manual.
   *
   * It rides the fold onto the book leg (`BridgeLeg.origin`) and is stored
   * verbatim, because the leg is the only place the driver can read it: by the
   * time the supervisor adopts a leg, the order that opened it is history.
   */
  readonly origin?: 'manual' | 'repair'
  /**
   * THE DESK LEG THIS FILL CLOSES; rides onto the journal fill's `deskTag` so
   * the Python driver's absorb path books the realized P&L — absent, the
   * clientOrderId is used as before.
   *
   * `absorb_bridge_closes` (`translate.py`) books a leg's P&L only when a
   * confirmed `close` trade carries the LEG's own id, which is the equality the
   * dashboard's close-leg path preserves (`strategies.ts`: `deskTag: action.ts`)
   * and which a repair's own order id breaks — a full close splices the bridge
   * leg away, so nothing later can restate it and the profit is simply lost.
   * Only the repair path sends this; everything else keeps the tranche id.
   *
   * IT IS REFUSED ON AN OPENING ORDER, at both doors — see `BORROWED_LEG_TAG`.
   * A leg id is the closed leg's; on an open it would be borrowed from a leg
   * that still exists.
   *
   * IT IS NOT ON THE STORED CLAIM, so `#journalReconciledFills` rebuilds a
   * crashed submission's fills under the tranche id as it always has. That path
   * is reached only by a REPLAY of the same clientOrderId, and the repair wave
   * machine never replays one — a restart HALTS the run rather than resuming it
   * (`repair-apply.ts:haltStaleRunsOnBoot`), and every order id it mints is
   * used exactly once. Persisting it would be dead weight on every claim.
   *
   * The other residual, stated: `#maintainBook` reads "a leg whose deskTag was
   * not in the book BEFORE this fold" as a leg the fold CREATED. A close that
   * crossed through zero — possible only if the leg shrank between the plan and
   * the fill — would open its replacement under the closed leg's id and so not
   * be announced as a creation. That trade is deliberate: it costs one log line
   * in a rare race, against P&L that is otherwise never booked at all.
   */
  readonly fillDeskTag?: string
  readonly meta?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Declared in `submit-plan.ts` beside the pure functions that build them, and
 * re-exported here because this module is where callers look for them.
 *
 * `SubmittedOrder` — one broker-bound order this submission became.
 * `SubmitStatus`   — where a submission got to; see the header's matrix.
 */
export type { SubmittedOrder, SubmitStatus } from './submit-plan.ts'

export type SubmitResponse =
  | {
      readonly accepted: true
      /** `'FAILED'` here means PARTIAL: real exposure exists, but not all of it. */
      readonly status: 'DONE' | 'FAILED'
      readonly clientOrderId: string
      /** The tranches that actually reached a rail. Never the plan. */
      readonly orders: readonly SubmittedOrder[]
      /** True when this id had already been submitted; nothing routed again. */
      readonly replayed: boolean
      /**
       * THE NUMBER TO BOOK. Lots that actually reached a rail.
       *
       * A partial freeze split routes 24 of 30 and rejects 6. A ledger that
       * books the INTENDED 30 then flattens 30 against a real position of 24,
       * which sells 6 lots nobody asked for — a fresh short, opened by the
       * safety mechanism, at whatever the market is doing at 15:20. So the
       * routed size is a field of its own rather than something a caller has to
       * derive by summing `orders`.
       */
      readonly routedLots: number
      /**
       * Kept as an ALIAS of `routedLots`, not of `intendedLots`.
       *
       * Its docstring always promised "lots actually sent" and it was the
       * intended size, which is the bug above. New code reads `routedLots`; a
       * client that has not been updated reads this one and now gets the safe
       * number instead of the optimistic one.
       */
      readonly lots: number
      /** What we ATTEMPTED, after the `liveLots` override. `>= routedLots`. */
      readonly intendedLots: number
      /** What the caller asked for, before the `liveLots` override. */
      readonly requestedLots: number
      /** Freeze cap used for the split. `null` = the symbol is not in the table. */
      readonly freezeMaxLots: number | null
      /** Per-tranche routing failures. Non-empty means a PARTIAL route. */
      readonly errors: readonly string[]
    }
  | {
      readonly accepted: false
      /** `'DONE'` = a gate refused, nothing attempted. `'FAILED'` = attempted, none routed. */
      readonly status: 'DONE' | 'FAILED'
      readonly clientOrderId: string
      /** Which gate refused, by name. */
      readonly reason: string
      readonly replayed: boolean
      /** Always 0. Stated rather than omitted so "nothing routed" is explicit. */
      readonly routedLots: 0
    }
  | {
      /**
       * INDETERMINATE — the claim exists and we do not know its outcome.
       *
       * Deliberately carries NO `routedLots`: there is no honest value for it,
       * and its absence makes a caller that reads the routed size narrow on
       * this branch first rather than silently getting a number that is a
       * guess. See the header for why the boolean projection is `false`.
       */
      readonly accepted: false
      readonly status: 'ROUTING'
      readonly indeterminate: true
      readonly clientOrderId: string
      readonly reason: string
      /** Only a replay can be indeterminate; a fresh submit always resolves. */
      readonly replayed: true
      /** What the crashed attempt was TRYING to send. Not what it sent. */
      readonly intendedLots: number
      /** The tranches it PLANNED. Some subset of these may be live. */
      readonly plannedOrders: readonly SubmittedOrder[]
    }

/**
 * The persistence this endpoint needs, as a narrow port.
 *
 * `DeskStore` satisfies it structurally. Declaring only these five methods is
 * what lets every gate below be tested against a 30-line fake rather than a
 * running Mongo — the same reasoning as `store.ts`'s own narrow driver port.
 */
export interface SubmitStore {
  loadStrategy(tag: string): Promise<StrategyRow | null>
  loadKillSwitch(): Promise<KillSwitchState>
  /** The operator's "turn XTS off" switch — see `safety.ts`. */
  loadBrokerLink(): Promise<BrokerLinkState>
  touchStrategy(tag: string, nowMs: number): Promise<void>
  journalBlocked(events: readonly Record<string, unknown>[]): Promise<void>
  collection<T = Record<string, unknown>>(name: string): Collection<T>
  /** For `#maintainBook` — the book this order's tag holds, if it holds one. */
  bookDoc(tag: string, mode: DeskMode): Promise<StoredBookLike | null>
  /**
   * COMPARE-AND-SET when `expectedUpdatedAt` is given, answering `'conflict'`
   * rather than clobbering — see `store.ts` and `book-write.ts` for why the
   * book write cannot be a bare read-modify-write (audit F-27).
   */
  saveBook(
    key: BookKeyLike,
    legs: readonly BridgeLeg[],
    nowMs: number,
    expectedUpdatedAt?: number,
  ): Promise<'ok' | 'conflict'>
}

/** The parts of `StoredBook` this module reads. Structural, so `DeskStore` fits. */
export interface StoredBookLike {
  readonly symbol: string
  readonly expiry: string
  readonly legs: readonly BridgeLeg[]
  /** The row VERSION the fold below pins its write to. */
  readonly updatedAt?: number
}

export interface BookKeyLike {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
}

/**
 * The few fields the BOOK FOLD needs from the order that caused it.
 *
 * `SubmitRequestBody` satisfies it structurally, and so does a STORED CLAIM —
 * which is the point: `#resolveRouting` has to run the same fold from a
 * `desk-submissions` document long after the original request is gone (audit
 * F14), and narrowing the parameter is what lets it do that without inventing
 * a fake request body whose other fields would be lies.
 */
export interface BookFoldRequest {
  readonly tag: string
  readonly mode: DeskMode
  readonly clientOrderId: string
  /**
   * Who authored the order, stamped onto every leg this fold touches. Optional
   * because the RECONCILE path has none to give: the claim record does not
   * carry it, so a leg rebuilt from a stored claim is left unstamped — absent,
   * which reads as manual, and the operator adopting it by hand is the safe
   * end of that gap rather than a leg silently declared bot-managed.
   */
  readonly origin?: 'manual' | 'repair'
}

export interface SubmitDeps {
  readonly store: SubmitStore
  readonly rails: { paper: OrderRail; live: OrderRail }
  readonly master: MasterProvider
  readonly marks: MarkSource
  /** Refreshed out of band; read per call so a sync lands without a restart. */
  freeze(): FreezeLimits
  /**
   * The optional BOX-LEVEL PIN, i.e. `DESK_LIVE_TAGS` — no longer the
   * allowlist. The allowlist is the strategy row's `modes.live` switch, checked
   * as GATE 3 and enforced independently inside `LiveRail`.
   *
   * EMPTY MEANS NO PIN. Non-empty restricts this host to that subset whatever
   * the portal says, so a machine can be locked down without touching shared
   * state. It can only narrow, never widen: a pinned tag that is switched off
   * still cannot trade.
   *
   * Checked here so a refusal is a clean `accepted: false` naming the gate,
   * rather than an exception thrown from inside the rail after the submission
   * was already claimed.
   */
  readonly liveTags: ReadonlySet<string>
  /**
   * Which collection each rail writes its orders to.
   *
   * This is what makes a stuck `ROUTING` record RESOLVABLE instead of
   * permanently unknown: the tranche ids are deterministic (`<coid>#<i>`), so a
   * replay can ask the order collection which of them actually landed rather
   * than inventing an answer. Passed in rather than derived here because the
   * live rail's target is a deliberate choice (`rail.ts:LiveExecutor`) and
   * guessing it would probe the wrong collection and report a routed order as
   * lost — which is the one error that talks a caller into re-routing it.
   */
  readonly orderCollections: { readonly paper: string; readonly live: string }
  /**
   * Marketable-limit pricing for a submit that states no `orderType`.
   *
   * The same config the decision path uses, and for the same reason: the
   * broker REJECTS market orders, and `gateway.ts` maps anything that is not
   * `'LIMIT'` to `'MARKET'`. Without this, every hosted strategy's and every
   * signal mirror's live order is a market order.
   *
   * ABSENT MEANS "LEAVE THEM MARKET" — the historical behaviour, so a caller
   * that has not opted in is unchanged.
   */
  readonly marketable?: MarketableConfig
  /**
   * The desk-wide RISK LIMITS (audit F-28), on the LIVE rail only.
   *
   * ABSENT MEANS NO GATE — `main.ts` builds one only when at least one
   * `DESK_RISK_*` variable is set, so a desk that has configured nothing (and
   * every test) behaves exactly as it did. See GATE 6 in `submit`.
   */
  readonly risk?: RiskGatePort
  /**
   * Whose day "expires today" is judged on. Absent is the process venue. NSE:
   * the IST date. DX: the settlement day — the 24 hours up to the contract's
   * 12:00 UTC expiry instant, and not one millisecond after it.
   */
  readonly venue?: VenueSpec
  now(): number
  readonly log: Log
  /**
   * The websocket push. Optional — nothing here depends on a dashboard being
   * attached, and every existing caller keeps working without one.
   *
   * It carries the REFUSALS this endpoint journals, in BOTH modes. The fills go
   * out from `PaperRail.route` (paper) and from the gateway's notify (live), so
   * nothing is pushed twice; a refusal has no rail to emit it, and a strategy
   * that is being refused is exactly when someone is watching this page.
   */
  emit?: PaperFillEmit
  /**
   * Told about fills the moment `#writeJournal` lands them, so the in-memory
   * book (`livebook.ts`) sees a hosted strategy's position without waiting for
   * its 60s reconcile.
   *
   * Same contract as `emit`: synchronous, void, never throws, and optional —
   * a deployment without a book behaves exactly as it did before.
   */
  journal?: (entry: JournalEntry) => void
}

/**
 * How long a claim may sit in `ROUTING` before a replay reconciles it.
 *
 * Below this, a `ROUTING` record most likely belongs to a request that is alive
 * and mid-loop right now — reconciling it would read tranche 0 as routed and
 * tranche 1 as lost microseconds before tranche 1 routes, and report a partial
 * that is about to become whole. That is a WORSE lie than "unknown": the caller
 * books 24 of 30 and strands 6. Above it, the owning process is dead or wedged
 * and the order collection is the only remaining witness.
 *
 * 30s is chosen against the routing loop's real cost — a handful of Mongo
 * inserts, milliseconds — with three orders of magnitude of headroom, and
 * against the caller's retry cadence (a strategy tick, seconds), so a genuinely
 * crashed submission resolves within a few ticks rather than at EOD.
 */
export const ROUTING_STALE_MS = 30_000

/**
 * WHY A DESK TAG MAY ONLY RIDE ON AN EXIT — one sentence, said at both doors.
 *
 * `fillDeskTag` renames the fill after the leg it CLOSES. On an opening order
 * that is a leg id somebody else already owns: `applyRoutedFill` stamps the
 * fill's tag onto the leg it creates (`book.ts`), so the book would end up
 * holding two legs under one id — `findLeg` takes the first match, the Python
 * driver's book is keyed one leg per id, and neither could tell them apart
 * again. There is no legitimate caller for it: the repair path sets it only on
 * a close, where the leg it names is the leg being taken off.
 */
const BORROWED_LEG_TAG =
  'fillDeskTag names the desk leg being CLOSED, so it may only ride on an order that states ' +
  'reducesExposure — on an opening order it would stamp a second book leg under an id another ' +
  'leg already owns'

export class SubmitService {
  readonly #d: SubmitDeps
  /** Cached so the unique index is ensured once per process, not per request. */
  #indexed: Promise<void> | null = null

  constructor(deps: SubmitDeps) {
    this.#d = deps
  }

  /**
   * The unique index IS the idempotency lock. Without it two concurrent
   * submits of the same `clientOrderId` both read "not seen" and both route.
   *
   * Created here rather than in `store.ts:ensureIndexes` only because this
   * collection belongs to this module; it is idempotent, so calling it once
   * per process costs one round trip at first use.
   */
  async #ensureIndex(): Promise<void> {
    this.#indexed ??= this.#d.store
      .collection(SUBMISSIONS)
      .createIndex({ clientOrderId: 1 }, { unique: true })
      .then(() => undefined)
    await this.#indexed
  }

  async submit(req: SubmitRequestBody): Promise<SubmitResponse> {
    const now = this.#d.now()
    await this.#ensureIndex()

    /**
     * Replay check FIRST, before every gate.
     *
     * Disabling a strategy must not retroactively unmake an order that already
     * routed: a replay of that clientOrderId keeps returning the original
     * answer, which is what makes a strategy's retry loop safe across a switch
     * flip. Same placement, same reason, as `applyDecision`.
     */
    const existing = await this.#load(req.clientOrderId)
    if (existing !== null && !isGateRefusal(existing)) return await this.#replay(existing, now)
    /**
     * A GATE REFUSAL IS RETRIED, NOT REPLAYED.
     *
     * Idempotency exists to stop a retry placing a SECOND order. A gate
     * refusal placed no first one — `#refuse` says so itself: "nothing was
     * attempted, so ... the opportunity is genuinely still available" — so it
     * has nothing to protect, and replaying it turns a fixable refusal into a
     * permanent one.
     *
     * Measured on prod 2026-07-31: the Build screen sends `entry-<tag>-<symbol>`,
     * the same key on every attempt (correctly — that is what makes a
     * double-click safe). The first Place happened before the paper rail was
     * switched on and was refused; the refusal was stored; every Place after
     * the operator switched it ON replayed that refusal with the gates never
     * re-run, while the page showed the switch on beside the error. The book
     * could not be opened from the UI at all.
     *
     * Only the DONE+not-accepted pair is retried, which the file header defines
     * as exactly "a gate refused; nothing was attempted". A FAILED or ROUTING
     * record means something DID reach a rail, and those still replay.
     */
    if (existing !== null) {
      await this.#d.store
        .collection<StoredSubmission>(SUBMISSIONS)
        .deleteOne({ clientOrderId: req.clientOrderId, status: 'DONE', accepted: false })
    }

    /**
     * ---- SHAPE, NOT STATE: a desk tag belongs to an exit --------------
     *
     * Checked HERE as well as in `validateSubmitRequest`, because the HTTP
     * boundary is not the only door: `RepairApplyService` and every other
     * in-process caller build a `SubmitRequestBody` and call this method
     * directly. The rule has to hold where the FILL is built, not only where a
     * body is parsed. See `BORROWED_LEG_TAG` for what it prevents.
     */
    if (req.fillDeskTag !== undefined && req.reducesExposure !== true) {
      await this.#journal(req, BORROWED_LEG_TAG, now)
      return await this.#refuse(req, BORROWED_LEG_TAG, now)
    }

    // ---- GATE 1: the tag is registered at all ---------------------------
    // Gated on the mode the REQUEST states: the row's paper switch has no
    // opinion about a live order and must not be read as one.
    // `reducesExposure` is passed so a switched-off row still releases its
    // exits — the runner flattens ON switch-off, and refusing that flatten is
    // the 2026-08-04 stranded-position loop (see `gateStrategy`'s header).
    const row = await this.#d.store.loadStrategy(req.tag)
    const gate = gateStrategy(req.tag, row, req.mode, {
      ...(req.reducesExposure === undefined ? {} : { reducesExposure: req.reducesExposure }),
    })
    if (!gate.allowed) {
      const reason = gate.registered
        ? `strategy switch: ${gate.reason}`
        : `unknown strategy: ${gate.reason}`
      // Journalled even though nothing routed: "why did nothing trade this
      // morning?" has to be answerable from the portal, not from a process log.
      await this.#journal(req, reason, now)
      if (!gate.registered) throw new UnknownStrategy(gate.reason)
      // ---- GATE 2: the strategy switch ---------------------------------
      return await this.#refuse(req, reason, now)
    }

    // Liveness on the CALL, not on a fill: a strategy that decides to do
    // nothing all morning is still alive. Stamped after the switch gate, the
    // same as `applyDecision`, so `lastSeenAt` means "a live process is
    // trading under this row" rather than "something knows this name".
    await this.#d.store.touchStrategy(req.tag, now)

    // ---- GATES 3, 4a and 4: the kill switch, the row's mode switch and the
    // box-level pin. All three are pure verdicts over state that is loaded by
    // this line, so they are decided together and the FIRST reason wins —
    // exactly as it did when each gate returned in place. See
    // `submit-plan.ts:screenSubmitGates` for what each one is defending.
    const halt = await this.#d.store.loadKillSwitch()
    const refusal = screenSubmitGates({
      tag: req.tag,
      mode: req.mode,
      modes: gate.row.modes,
      halt,
      liveTags: this.#d.liveTags,
      ...(req.reducesExposure === undefined ? {} : { reducesExposure: req.reducesExposure }),
    })
    if (refusal !== null) {
      await this.#journal(req, refusal, now)
      return await this.#refuse(req, refusal, now)
    }

    // ---- GATE 3b: the broker link. Live only, and — unlike every gate above
    // — EXITS TOO: a released link is a logged-out gateway, not a policy. The
    // order would be refused there after the book had been folded here. See
    // `brokerLinkRefusal` and `service.ts`'s GATE 1b, which is the same rule
    // on the other live entry point.
    const linkRefusal = brokerLinkRefusal(req.mode, await this.#d.store.loadBrokerLink())
    if (linkRefusal !== null) {
      await this.#journal(req, linkRefusal, now)
      return await this.#refuse(req, linkRefusal, now)
    }

    const instrument = this.#resolve(req.instrument)
    if (instrument === null) {
      const reason =
        `instrument: cannot resolve '${req.instrument.tradingsymbol}' — it is not in the ` +
        `instrument master and the request carried no lotSize/exchange to route on`
      await this.#journal(req, reason, now)
      return await this.#refuse(req, reason, now)
    }

    // ---- LIVE SIZING: the `liveLots` override -------------------------
    // Pure, and the exemptions (exits, a positional book's leg) are stated
    // where the rule is — see `submit-plan.ts:chooseLiveLots`.
    const requestedLots = req.lots
    const sizing = chooseLiveLots({
      tag: req.tag,
      mode: req.mode,
      requestedLots,
      liveLots: gate.row.liveLots,
      ...(req.reducesExposure === undefined ? {} : { reducesExposure: req.reducesExposure }),
      ...(req.exactLots === undefined ? {} : { exactLots: req.exactLots }),
    })
    if (!sizing.ok) {
      await this.#journal(req, sizing.reason, now)
      return await this.#refuse(req, sizing.reason, now)
    }
    const lots = sizing.lots
    if (sizing.overridden) {
      this.#d.log('liveLots override applied', {
        tag: req.tag,
        requestedLots,
        liveLots: lots,
        symbol: instrument.tradingsymbol,
      })
    }

    // The fill price — required in BOTH modes, and refused rather than
    // defaulted to 0. See `submit-plan.ts:chooseFillPrice`.
    const mark = chooseFillPrice(this.#d.marks.price(instrument), req.referencePrice, req.limitPrice)
    if (mark === null) {
      const reason =
        `mark: no price for ${instrument.tradingsymbol} — refusing rather than journalling a ` +
        `fill at 0 (send referencePrice if the feed is cold)`
      await this.#journal(req, reason, now)
      return await this.#refuse(req, reason, now)
    }

    /**
     * THE ORDER TYPE THIS GOES OUT AS, decided ONCE so the claim record and
     * the routed fill can never disagree about it.
     *
     * A caller that STATED an `orderType` is honoured verbatim. One that did
     * not used to reach the gateway as MARKET — `gateway.ts` maps anything
     * that is not `'LIMIT'` to it — and **the broker rejects market orders**.
     * That is the defect the decision path fixed in `904a900e` via
     * `priceFillsForRoute`; this endpoint was never given the same treatment,
     * so every hosted strategy's and every signal mirror's live order was a
     * market order on a path that had never once been exercised live.
     *
     * Priced THROUGH the mark so it executes immediately, with the limit as
     * the hard worst case — see `marketable.ts`. `marketableLimit` answers
     * null when the mark is unusable, which leaves the order exactly as it
     * was rather than giving it an invented price.
     *
     * A contract EXPIRING TODAY gets the WIDER expiry buffer. The intraday
     * strategies and signal mirrors this endpoint serves trade the weeklies,
     * and on their last day the tape moves through a 2% buffer before the
     * order rests a heartbeat — a sell sat unfilled while the market fell
     * through it, which on a dying contract is the position pinned to
     * settlement. Expiry-day is judged in IST against the MASTER's row for
     * the resolved symbol; a contract the master has not synced answers null,
     * never matches today, and keeps the base buffer — the wide one is paid
     * on knowledge, not on a guess.
     */
    const marketableCfg = req.orderType === undefined ? this.#d.marketable : undefined
    // Asked only when the answer is USED: `expiryOf` is a linear scan of the
    // dump, and an order that stated its own type never needs it.
    const expiresToday =
      marketableCfg !== undefined &&
      this.#d.master.current().expiryOf(instrument.tradingsymbol) === venueDay(now, this.#d.venue)
    const marketablePrice =
      marketableCfg === undefined
        ? null
        : marketableLimit(req.side, mark, marketableCfg, expiresToday)
    const orderType = marketablePrice === null ? req.orderType : ('LIMIT' as const)
    const limitPrice = marketablePrice === null ? req.limitPrice : marketablePrice

    // ---- GATE 5: the exchange freeze split ------------------------------
    const underlying = req.underlying ?? deriveUnderlying(instrument.tradingsymbol)
    /**
     * `null` means "the symbol is not in NSE's freeze table", NEVER "no limit".
     * `xtsOrder.js:104` compared against an absent entry with `qty <= undefined`
     * — false — and fell into `tranches(qty, undefined)`, which is how stock
     * options could not be routed at all. Here the unknown is sent as ONE order
     * (inventing a split would be worse) and reported on the response and in
     * the log, so it is visible rather than silently infinite.
     */
    const freezeMaxLots = this.#d.freeze().maxLotsPerOrder(underlying, instrument.lotSize)
    if (freezeMaxLots === null) {
      this.#d.log('freeze limit UNKNOWN — sending as one order', {
        tag: req.tag,
        underlying,
        symbol: instrument.tradingsymbol,
        lots,
      })
    }
    /**
     * ---- GATE 6: the desk-wide RISK LIMITS (audit F-28) -----------------
     *
     * Beside GATES 3/4 in every sense that matters — same governing rule, same
     * refusal shape, same journal — but it cannot be evaluated up there: the
     * lot caps need the size AFTER the `liveLots` override, and the notional
     * cap needs the resolved contract and its mark. Those are the quantities it
     * limits, and screening on the request's own numbers would cap a size the
     * desk was never going to send.
     *
     * Still strictly BEFORE the claim insert and the routing loop, so a refusal
     * here is the third row of the state matrix: nothing attempted, nothing to
     * reconcile, safe to retry once the limit or the position changes.
     */
    const riskRefusal = screenRiskGate({
      mode: req.mode,
      underlying,
      lots,
      quantity: lots * instrument.lotSize,
      price: mark,
      limits: this.#d.risk?.limits ?? NO_EXPOSURE_LIMITS,
      // Not measured at all when nothing is configured — the gate is inert and
      // a P&L read for an answer nobody will use is a cost on the order path.
      exposure:
        this.#d.risk === undefined || req.mode !== 'live'
          ? null
          : await this.#d.risk.exposure(req.mode),
      ...(req.reducesExposure === undefined ? {} : { reducesExposure: req.reducesExposure }),
      ...(limitPrice === undefined ? {} : { limitPrice }),
    })
    if (riskRefusal !== null) {
      await this.#journal(req, riskRefusal, now)
      return await this.#refuse(req, riskRefusal, now)
    }
    /**
     * Counted only once the gate has passed, only on the LIVE rail, and only
     * for exposure-ADDING orders.
     *
     * All three conditions are the ones the gate itself screens on, and the
     * mode was the one missing here: paper is never measured and never refused
     * by these caps, so a paper rehearsal that counted itself against the live
     * rate budget could throttle real orders it has nothing to do with — and a
     * busy paper book would do it silently. `service.ts:#screenRisk` returns
     * early for paper and has always had this rail.
     *
     * The lots are RESERVED in the same breath, so the next order inside the
     * measurement cache's TTL is judged against a desk that already holds them
     * (`RiskGatePort.reserve`). Reserved AFTER the gate passed and BEFORE the
     * claim insert: a reservation over an order that was refused would hold
     * capacity nothing is using.
     */
    if (req.mode === 'live' && req.reducesExposure !== true) {
      this.#d.risk?.record(now)
      this.#d.risk?.reserve(lots, underlying, now)
    }

    const orders: SubmittedOrder[] = planTranches({
      clientOrderId: req.clientOrderId,
      lots,
      freezeMaxLots,
      lotSize: instrument.lotSize,
    })

    /**
     * Claim the id BEFORE routing. A duplicate key here means another process
     * won the race; treat it exactly like a replay rather than routing a second
     * set of orders.
     */
    const op: 'open' | 'close' = req.reducesExposure === true ? 'close' : 'open'
    const record: StoredSubmission = buildClaimRecord({
      clientOrderId: req.clientOrderId,
      tag: req.tag,
      mode: req.mode,
      tradingsymbol: instrument.tradingsymbol,
      side: req.side,
      requestedLots,
      lots,
      createdAt: now,
      freezeMaxLots,
      plannedOrders: orders,
      underlying,
      price: mark,
      op,
      ...(orderType === undefined ? {} : { orderType }),
      ...(limitPrice === undefined ? {} : { limitPrice }),
    })
    try {
      await this.#d.store.collection<StoredSubmission>(SUBMISSIONS).insertOne(record)
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
      const winner = await this.#load(req.clientOrderId)
      if (winner !== null) return await this.#replay(winner, now)
      throw err
    }

    const rail = railFor(req.mode, this.#d.rails)
    const routeErrors: string[] = []
    const routed: SubmittedOrder[] = []
    const routedFills: Fill[] = []
    for (const order of orders) {
      const fill = trancheFill(order, {
        op,
        tradingsymbol: instrument.tradingsymbol,
        side: req.side,
        // A RESTING order's honest price is the operator's limit, not the
        // mark: the mark is where the market is, the limit is where they
        // chose to wait. Validation guarantees a resting order carries one.
        price: req.resting === true && limitPrice !== undefined ? limitPrice : mark,
        ts: now,
        ...(orderType === undefined ? {} : { orderType }),
        ...(limitPrice === undefined ? {} : { limitPrice }),
        ...(req.resting === true ? { resting: true } : {}),
        // The desk leg this fill closes, when the caller named one. Absent for
        // every other order path, which keeps the tranche id it always had.
        ...(req.fillDeskTag === undefined ? {} : { deskTag: req.fillDeskTag }),
      })
      try {
        await rail.route(fill, {
          tag: req.tag,
          underlying,
          instrument,
          nowMs: now,
          clientOrderId: order.clientOrderId,
        })
        routed.push(order)
        routedFills.push(fill)
      } catch (err) {
        routeErrors.push(`${order.clientOrderId}: ${errorMessage(err)}`)
      }
    }

    /**
     * A LIVE RESTING ORDER IS NOT A FILL, so it is NOT booked.
     *
     * ON PAPER IT IS, and it is booked like any other. `/submit` paper orders
     * land in `desk-paper-trade` COMPLETE at route time (`rail.ts`), resting
     * or not — the Manual Order dialog says so. Skipping the book there left a
     * fill on the order log that no P&L view, no book and no supervisor ever
     * saw: on 2026-10-19 five Resting closes on the TCS book "filled" and every
     * leg stayed open, so the operator closed each one a second time.
     *
     * Every other order this endpoint routes is marketable — it executes in
     * moments, and booking it optimistically at route time is a rounding
     * error reconcile-live later trues up. A resting order may sit for hours
     * or never trade, and reconcile-live can only REDUCE or restate what was
     * booked, never insert — so an optimistic booking here would show a
     * position (or worse, an EXIT) as done while the risk is still live: the
     * 2026-08-18 phantom, rebuilt on purpose. The order is still fully
     * visible — desk-submissions holds the claim, the gateway journals the
     * real fill into desk-fills when it actually trades, and the Broker page
     * shows it resting. What is knowingly given up is per-decision P&L
     * attribution for the tag until broker truth arrives.
     *
     * AND NOTHING DOWNSTREAM EVER FINISHES THE JOB (audit F12). When the
     * resting order finally trades, the fill reaches `desk-fills` and the
     * Broker page and STOPS there: no `desk-decisions` record is written for
     * it, no `desk-books` leg is created, and the Python supervisor therefore
     * never adopts it. So a resting manual order under a desk book's tag is a
     * broker position the book does not hold — for as long as it lives. That
     * is a KNOWN GAP, not an oversight; closing it needs the gateway's fill
     * notification to reach this fold, which is a feature of its own. Until
     * then the Manual Order dialog says so in as many words when Resting is
     * picked on a book target (`manual-order-plan.ts:deskBookNote`), because
     * an operator choosing between two buttons is the only place this gap can
     * still be acted on.
     */
    if (!restsUnbooked(req.mode, req.resting === true)) {
      await this.#writeJournal(req, underlying, routedFills, now)
      // The RESOLVED contract goes with the fills. A `Fill` carries a
      // tradingsymbol and nothing else, and a leg the book does not yet hold
      // has to be built out of the real `InstrumentRef` — token, lot size and
      // all — rather than out of a name.
      await this.#maintainBook(req, underlying, instrument, routedFills, now)
    }

    const { accepted, status, reason } = classifyRouteOutcome(routed, routeErrors)
    /**
     * A FAILURE HERE MUST NOT BECOME A 500.
     *
     * By this line the orders are already in `desk-gateway-orders`. Letting a
     * Mongo hiccup on a bookkeeping write throw turns a routed order into an
     * HTTP error, and the caller cannot tell "never routed" from "routed,
     * response lost" — so it re-enters on the next tick and the order is
     * placed TWICE. The routing outcome is known here and in memory, so it is
     * reported; the record stays in `ROUTING` and the next replay of this id
     * reconciles it against the order collection.
     */
    try {
      await this.#d.store.collection(SUBMISSIONS).updateOne(
        { clientOrderId: req.clientOrderId },
        {
          $set: {
            status,
            accepted,
            orders: routed,
            routeErrors,
            reason,
            completedAt: this.#d.now(),
          },
        },
      )
    } catch (err) {
      this.#d.log('submission status write FAILED — the record stays ROUTING', {
        tag: req.tag,
        clientOrderId: req.clientOrderId,
        routedLots: sumLots(routed),
        error: errorMessage(err),
      })
    }

    if (!accepted) {
      return {
        accepted: false,
        status,
        clientOrderId: req.clientOrderId,
        reason,
        replayed: false,
        routedLots: 0,
      }
    }
    return acceptedResponse(req.clientOrderId, routed, {
      status,
      replayed: false,
      intendedLots: lots,
      requestedLots,
      freezeMaxLots,
      errors: routeErrors,
    })
  }

  // ------------------------------------------------------------- internals

  async #load(clientOrderId: string): Promise<StoredSubmission | null> {
    return await this.#d.store
      .collection<StoredSubmission>(SUBMISSIONS)
      .findOne({ clientOrderId })
  }

  /**
   * Answer a replay of an id we have already claimed.
   *
   * The whole safety of "retry under the SAME id" rests on this being honest in
   * all three states, and in particular on it NEVER reporting a `ROUTING`
   * record as a success. The old version branched on `accepted` alone, so a
   * record claimed-but-not-yet-routed replayed as `{accepted: true, orders:
   * [every tranche]}` — a phantom position on an entry, a phantom flat on an
   * exit, with no sweeper anywhere to ever correct it.
   */
  async #replay(s: StoredSubmission, now: number): Promise<SubmitResponse> {
    if (s.status === 'ROUTING') return await this.#resolveRouting(s, now)
    if (!s.accepted) {
      return {
        accepted: false,
        status: s.status,
        clientOrderId: s.clientOrderId,
        reason: s.reason,
        replayed: true,
        routedLots: 0,
      }
    }
    return acceptedResponse(s.clientOrderId, s.orders, {
      status: s.status,
      replayed: true,
      intendedLots: s.lots,
      requestedLots: s.requestedLots,
      freezeMaxLots: s.freezeMaxLots,
      errors: s.routeErrors,
    })
  }

  /**
   * A claim whose owner never reported back.
   *
   * Fresh: say so. Stale: ask the ORDER COLLECTION which tranches exist. That
   * is not a guess — a tranche id is deterministic (`<coid>#<i>`) and
   * `rail.route` succeeding means exactly "this document was inserted", so
   * presence in the collection is the same fact the routing loop would have
   * recorded had it survived. A PENDING gateway row counts as routed for the
   * same reason it does on the live path: it has left our hands.
   */
  async #resolveRouting(s: StoredSubmission, now: number): Promise<SubmitResponse> {
    const planned = s.plannedOrders ?? []
    if (now - s.createdAt < ROUTING_STALE_MS) {
      return {
        accepted: false,
        status: 'ROUTING',
        indeterminate: true,
        clientOrderId: s.clientOrderId,
        reason:
          `routing outcome UNKNOWN for '${s.clientOrderId}': it was claimed but has not ` +
          `reported back. Retry the SAME clientOrderId — a new one would place a second ` +
          `order. Do not book a position from this response.`,
        replayed: true,
        intendedLots: s.lots,
        plannedOrders: planned,
      }
    }

    const name = s.mode === 'live' ? this.#d.orderCollections.live : this.#d.orderCollections.paper
    const routed: SubmittedOrder[] = []
    const routeErrors: string[] = []
    /**
     * WAS THIS A RESTING ORDER? The claim does not say, but the order document
     * does — `rail.ts:orderDocument` stamps `resting: true` from the fill, and
     * this loop is already reading that very document.
     *
     * It has to be known here because everything below REBUILDS what the
     * routing loop would have written, and the routing loop writes NEITHER the
     * P&L record NOR the book fold for a live resting order (see `submit`'s "A
     * LIVE RESTING ORDER IS NOT A FILL"). Reconciling one into either would book a
     * position that may never trade — the 2026-08-18 phantom, rebuilt by the
     * repair path instead of by the order path.
     */
    let resting = false
    for (const order of planned) {
      const doc = await this.#d.store.collection(name).findOne({ clientOrderId: order.clientOrderId })
      if (doc === null) {
        routeErrors.push(
          `${order.clientOrderId}: no order in ${name} — the submitting process died before it routed`,
        )
      } else {
        routed.push(order)
        if (doc['resting'] === true) resting = true
      }
    }

    const { accepted, status, reason } = classifyRouteOutcome(routed, routeErrors)
    this.#d.log('stale ROUTING submission reconciled against the order collection', {
      tag: s.tag,
      clientOrderId: s.clientOrderId,
      collection: name,
      plannedLots: s.lots,
      routedLots: sumLots(routed),
      status,
    })

    /**
     * Filtered on `status: 'ROUTING'` so this can never overwrite the truth.
     *
     * If the original process was only wedged and finishes after us, its own
     * unfiltered write lands second and wins — it watched the routing happen
     * and we only inferred it. If it lands first, this one matches nothing.
     */
    try {
      await this.#d.store.collection(SUBMISSIONS).updateOne(
        { clientOrderId: s.clientOrderId, status: 'ROUTING' },
        {
          $set: {
            status,
            accepted,
            orders: routed,
            routeErrors,
            reason,
            completedAt: now,
            reconciledAt: now,
          },
        },
      )
    } catch (err) {
      // Same rule as the routing loop's own status write: the answer below is
      // already known and is not a guess, so failing to CACHE it must not turn
      // it into an error the caller resolves by placing another order. The
      // record stays ROUTING and the next replay reconciles again.
      this.#d.log('reconciled status write FAILED — the record stays ROUTING', {
        tag: s.tag,
        clientOrderId: s.clientOrderId,
        error: errorMessage(err),
      })
    }

    // The crash may have landed between routing and the P&L journal, which
    // would leave a real position reading as FLAT in every P&L view — no error
    // anywhere, just a card saying zero. Re-writing it is idempotent on
    // `decisionId`, so doing it here costs nothing when it was already written.
    await this.#journalReconciledFills(s, routed, resting)

    if (!accepted) {
      return {
        accepted: false,
        status,
        clientOrderId: s.clientOrderId,
        reason,
        replayed: true,
        routedLots: 0,
      }
    }
    return acceptedResponse(s.clientOrderId, routed, {
      status,
      replayed: true,
      intendedLots: s.lots,
      requestedLots: s.requestedLots,
      freezeMaxLots: s.freezeMaxLots,
      errors: routeErrors,
    })
  }

  /**
   * Rebuild and write the P&L record — and the BOOK — for tranches a reconcile
   * found alive.
   *
   * Every field comes off the claim, which recorded them before routing — the
   * price especially, because a fill re-derived from today's mark would book a
   * P&L that never happened. If the claim predates those fields there is
   * nothing honest to write, so nothing is written and the log says so.
   *
   * THE BOOK IS FOLDED HERE TOO (audit F14). This path used to write the P&L
   * record and stop, which was survivable while `#maintainBook` only reduced
   * legs the seed had already declared: the 5-minute reconcile would restate
   * them. Since `fefe922b` the same fold CREATES a manual leg, and a leg that
   * is never created is never restated by anything — the crash simply loses
   * it, and the position exists at the broker and nowhere else.
   */
  async #journalReconciledFills(
    s: StoredSubmission,
    routed: readonly SubmittedOrder[],
    resting: boolean,
  ): Promise<void> {
    if (routed.length === 0) return
    if (restsUnbooked(s.mode, resting)) {
      // Neither record is the routing loop's to write for a live resting order,
      // so neither is this repair's — see the `resting` flag in `#resolveRouting`.
      this.#d.log('reconciled a RESTING submission — no P&L record and no book leg, by design', {
        tag: s.tag,
        clientOrderId: s.clientOrderId,
      })
      return
    }
    if (s.price === undefined || s.op === undefined || s.underlying === undefined) {
      this.#d.log('reconciled a submission with no stored price — P&L will under-report', {
        tag: s.tag,
        clientOrderId: s.clientOrderId,
      })
      return
    }
    const op = s.op
    const price = s.price
    const fills: Fill[] = routed.map((order) => ({
      op,
      deskTag: order.clientOrderId,
      tradingsymbol: s.tradingsymbol,
      side: s.side,
      qty: order.qty,
      price,
      ts: s.createdAt,
      ...(s.orderType === undefined ? {} : { orderType: s.orderType }),
      ...(s.limitPrice === undefined ? {} : { limitPrice: s.limitPrice }),
    }))
    const req = { clientOrderId: s.clientOrderId, tag: s.tag, mode: s.mode }
    const wrote = await this.#writeJournal(req, s.underlying, fills, s.createdAt)
    /**
     * THE P&L INSERT IS THE CRASH MARKER, and the reason this fold is safe to
     * run twice.
     *
     * `#maintainBook` is NOT idempotent — it applies fills as DELTAS, so
     * folding the same fill twice doubles a leg or double-closes one. What
     * makes the repair safe is the ORDER the routing loop writes in: the P&L
     * record first (`decisionId`, uniquely indexed), the book fold immediately
     * after. So a dead process that got as far as the book fold necessarily
     * left the decision record behind, and this insert answers "duplicate" —
     * which is read here as "the original already folded; do not fold again".
     * A fresh insert means it died BEFORE the journal, so it cannot have
     * reached the fold and there is nothing to double.
     *
     * The residual window is a crash BETWEEN the two writes (or a book write
     * that failed and was logged): the leg is then lost and this will not
     * repair it. That is deliberate — a missing leg is named by the log and by
     * `positions-compare`, while a doubled one is a position the supervisor
     * hedges against and nothing anywhere contradicts.
     */
    if (!wrote) return
    /**
     * Resolved exactly as `submit` resolves it, and NULLABLE here: the claim
     * stores only a tradingsymbol, so a contract the master cannot name has no
     * `lotSize`/`exchange` fallback to fall back to. Null still folds a CLOSE
     * (the held leg carries its own instrument) and refuses to create.
     */
    const instrument = this.#resolve({ tradingsymbol: s.tradingsymbol })
    await this.#maintainBook(req, s.underlying, instrument, fills, s.createdAt)
  }

  /**
   * Resolve the contract to route on.
   *
   * The instrument master is preferred over whatever the caller sent, because
   * lot sizes are revised by exchange circular and a strategy holding a stale
   * one would mis-size every order by a silent multiple. The body's fields are
   * a fallback for contracts the master has not synced (a fresh weekly listed
   * this morning), and when neither can supply a lot size the answer is null —
   * a fabricated `lotSize: 1` is how the C5 synthetic exit instrument happened.
   */
  #resolve(req: SubmitInstrument): InstrumentRef | null {
    const fromMaster = this.#d.master.current().resolveSymbol(req.tradingsymbol)
    if (fromMaster !== null) return fromMaster
    if (req.lotSize === undefined || !(req.lotSize > 0) || req.exchange === undefined) return null
    return {
      tradingsymbol: req.tradingsymbol,
      lotSize: req.lotSize,
      tickSize: req.tickSize ?? 0.05,
      exchange: req.exchange,
      ...(req.instrumentToken === undefined ? {} : { instrumentToken: req.instrumentToken }),
    }
  }

  /**
   * Record the refusal so a replay returns the same answer.
   *
   * A refusal is persisted for exactly the same reason an acceptance is: the
   * caller's contract is "this id, once". A duplicate key here means a
   * concurrent caller already recorded the same refusal — the outcome is
   * identical either way, because nothing routed.
   */
  async #refuse(req: SubmitRequestBody, reason: string, now: number): Promise<SubmitResponse> {
    const record: StoredSubmission = {
      clientOrderId: req.clientOrderId,
      tag: req.tag,
      mode: req.mode,
      tradingsymbol: req.instrument.tradingsymbol,
      side: req.side,
      requestedLots: req.lots,
      lots: 0,
      accepted: false,
      reason,
      orders: [],
      status: 'DONE',
      routeErrors: [],
      createdAt: now,
      freezeMaxLots: null,
    }
    try {
      await this.#d.store.collection<StoredSubmission>(SUBMISSIONS).insertOne(record)
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
    }
    return {
      accepted: false,
      // 'DONE' — a gate refusal is TERMINAL. Nothing was attempted, so unlike a
      // 'FAILED' route there is no order anywhere and the opportunity is
      // genuinely still available.
      status: 'DONE',
      clientOrderId: req.clientOrderId,
      reason,
      replayed: false,
      routedLots: 0,
    }
  }

  /**
   * Write the P&L journal record — see `PNL_JOURNAL` above.
   *
   * Shaped exactly like `applyDecision`'s: `decisionId`, `tag`, `mode`,
   * `createdAt`, `fills[]`. `PnlStore.loadFills` filters on `createdAt`, `tag`
   * and `mode` and reads `fills` in ARRAY ORDER, so the tranches go in the
   * order they routed — average cost is path-dependent and the array is the
   * authoritative sequence.
   *
   * `decisionId` is the submission's `clientOrderId`, which is already unique
   * per submit, so the decisions collection's own unique index continues to
   * hold. A duplicate here means a concurrent caller wrote it first and the
   * content is identical — swallowed for the same reason `journalBlocked`
   * swallows: losing the record is bad, failing a request that has already
   * placed real orders is worse.
   *
   * Takes the three fields it needs rather than a whole `SubmitRequestBody`, so
   * a RECONCILE — which has only the stored claim, never the original request —
   * writes through this same path instead of growing a second, drifting copy of
   * the shape `PnlStore.loadFills` depends on.
   */
  /**
   * Fold what actually routed into `desk-books`.
   *
   * The record used to be written in exactly two places — the seed path and
   * `applyActions` — so neither this endpoint nor `close-all` maintained it.
   * Flattening BHEL on 2026-07-31 left the order log correctly reading "0 open,
   * 2 closed" while the book still recorded the opening BUYs: the Positions
   * page drew two legs that no longer existed, delta and P&L were computed off
   * them, and the book could not be deleted because the delete guard reads the
   * same record.
   *
   * IT NOW CREATES A LEG for an OPEN on a contract the book does not hold, and
   * that is a deliberate reversal of the rule this method shipped with.
   *
   * The old rule was REDUCES AND ADDS ONLY: opening a leg belonged to the
   * Record step (`seedLegsFromFills` -> `/v1/desk/seed`), which writes the book
   * wholesale from every fill at once and is the path that carries strike, type
   * and expiry, and creating here would have meant each of the Build screen's
   * four Places raced the Record that follows it. That reasoning holds for the
   * BUILD flow and nothing below changes it — a Place lands on a contract the
   * seed is about to declare, and the fold is an add either way.
   *
   * It does NOT hold for a MANUAL ORDER under a running book's tag (the Manual
   * Order dialog: `clientOrderId` `manual:TAG:mode:SYMBOL:ts`, `exactLots`, an
   * explicit LIMIT). There is no Record step behind it — the operator is
   * adjusting a book that already exists, on a strike it does not yet hold —
   * so "left alone" meant the leg existed at the broker and NOWHERE else: the
   * Python supervisor could not see it and so never managed it, the Positions
   * page could not draw it, and only `positions-compare` noticed, as a
   * divergence against a leg nobody could explain. An invisible real position
   * is the worst record this desk can hold.
   *
   * So the four conditions below are exactly the ones that make creating safe:
   *
   *   - `op: 'open'` ONLY. A close on a contract the book does not hold is
   *     still left alone — closing what you do not hold is not a leg, and
   *     booking one would put an opposite phantom position on the record.
   *   - A `desk-books` document must already EXIST for tag+mode. A hosted
   *     strategy owns its positions internally and has no book document; giving
   *     it one here would invent a book nobody asked for.
   *   - The MASTER must be able to name the contract (see `contractOf`). A
   *     future, or a symbol the dump does not carry, is logged and left alone:
   *     a leg at a guessed strike is worse than an invisible one, because
   *     everything downstream — delta, margin, the supervisor's adjustments —
   *     then acts on a position that does not exist.
   *   - A LIVE RESTING order never reaches this method at all: `submit` skips
   *     both journal and book for it, because an order that may sit for hours
   *     is not a fill. That stays true and is asserted in the tests. A paper
   *     one does — the paper rail fills it as it routes (`restsUnbooked`).
   *
   * FAIL-SOFT, and for the same reason the submission update below is: by this
   * line the orders have routed. A Mongo hiccup here must not turn a routed
   * order into a 500 that makes the caller retry and place it twice.
   */
  async #maintainBook(
    req: BookFoldRequest,
    underlying: string,
    instrument: InstrumentRef | null,
    fills: readonly Fill[],
    now: number,
  ): Promise<void> {
    if (fills.length === 0) return
    try {
      const doc = await this.#d.store.bookDoc(req.tag, req.mode)
      if (doc === null) return
      const priorLegs = doc.legs as readonly BridgeLeg[]
      let legs = priorLegs
      let touched = false
      /**
       * THE DESK TAGS THE BOOK CARRIED BEFORE THIS FOLD — the whole basis for
       * "which legs did this order create". See `created` below.
       */
      const before = new Set(priorLegs.map((l) => l.deskTag))
      for (const f of fills) {
        const held = legs.find((l) => l.instrument.tradingsymbol === f.tradingsymbol)
        /**
         * A leg the book already holds carries its own identity — strike, type,
         * expiry and underlying were settled when it was opened, and re-deriving
         * them from the master would let a re-listed contract restate a leg the
         * desk has been managing all day.
         */
        const meta = held ?? this.#newLegIdentity(req, doc, underlying, f, now)
        if (meta === null) continue
        /**
         * The held leg's own ref first, then the one the caller resolved. NULL
         * only on the reconcile path, for a contract the master cannot name and
         * whose request body — with its `lotSize`/`exchange` fallback — is long
         * gone. A leg with no instrument cannot be routed on later, so it is
         * refused here rather than fabricated.
         */
        const ref = held?.instrument ?? instrument
        if (ref === null) {
          this.#d.log('fill NOT added to the book — the contract resolves to no instrument', {
            tag: req.tag,
            mode: req.mode,
            clientOrderId: req.clientOrderId,
            tradingsymbol: f.tradingsymbol,
          })
          continue
        }
        legs = applyRoutedFill(legs, {
          instrument: ref,
          underlying: meta.underlying,
          expiry: meta.expiry,
          strike: meta.strike,
          type: meta.type,
          side: f.side,
          qty: f.qty,
          price: f.price,
          ts: now,
          deskTag: f.deskTag,
        })
        touched = true
      }
      if (!touched) return
      legs = stampOrigin(legs, priorLegs, req.origin)
      /**
       * WHAT THIS FOLD CREATED, BY DIFFING THE LEGS — not by `held === undefined`
       * (audit F4/F15).
       *
       * `applyRoutedFill` opens a leg on TWO paths, and the flag only saw one of
       * them. A reducing fill that crosses THROUGH zero — Sell 5 lots against a
       * 2-lot long — consumes the held leg and then opens a NEW one for the
       * remaining 3 (`book.ts`'s cross-through-zero branch), with `held` very
       * much defined. So the operator was told nothing, and a short leg the
       * supervisor now manages appeared on the book with no line anywhere
       * saying it had.
       *
       * A `deskTag` is the tranche's own `clientOrderId`, unique per submission,
       * and `applyRoutedFill` stamps it on a leg it OPENS and never on one it
       * merges into. So "present after, absent before" is exactly the set of
       * legs this fold opened, on either path — and the second tranche of a
       * freeze split, which folds into the leg the first one created, is still
       * not a creation because that leg's tag was already there.
       */
      const created = legs.filter((l) => !before.has(l.deskTag))
      const key = { tag: req.tag, mode: req.mode, symbol: doc.symbol, expiry: doc.expiry }
      // COMPARE-AND-SET on the version read above (F-27). The Build screen's
      // four Places each open one of these windows, and the Record that follows
      // them writes the same document — whoever finished last used to erase the
      // others. A conflict re-folds this order onto the fresh legs instead.
      const saved = await this.#d.store.saveBook(key, legs, now, doc.updatedAt)
      if (saved === 'conflict') {
        const recovery = await refoldOnConflict({
          store: this.#d.store,
          key,
          routedFills: fills,
          nextBook: legs,
          priorBook: priorLegs,
          /**
           * THE RETRY STILL REDUCES AND ADDS ONLY — a creation is NOT replayed
           * onto the winner's legs.
           *
           * `book-write.ts` documents `mayCreate: false` as this endpoint's
           * contract, and the loser of a race is the worst place to relax it:
           * it would have to decide, against a document it has not seen since,
           * whether the winner closed this contract deliberately. What it does
           * instead is LOUD — `refoldOnConflict` names every dropped fill as
           * "book and broker may now disagree — check positions" — so a manual
           * leg lost to the ~50ms window is reported rather than silently
           * missing, and `positions-compare` still carries it.
           */
          mayCreate: false,
          nowMs: now,
          log: (m) => this.#d.log(m, { clientOrderId: req.clientOrderId }),
        })
        /**
         * AND THE OPERATOR IS TOLD, not just the process log (audit F3).
         *
         * `refoldOnConflict` is loud — in `console`. The operator is looking at
         * the order feed, where the dialog has just said the order routed, and
         * a leg dropped by a ~50ms CAS race left that feed reading like an
         * ordinary success. The one place the loss is discoverable was a log
         * line on a box nobody has open at 14:32.
         *
         * A fill LANDED if the retry applied it; anything else — skipped
         * (`no-leg`), or a status that folded nothing at all (`lost`, `gone`)
         * and so reports no outcomes — is a leg the book does not have and the
         * broker does.
         */
        const landed = new Set(
          recovery.outcomes.filter((o) => !o.skipped).map((o) => o.fill.deskTag),
        )
        await this.#journalLegsLost(
          req,
          created.filter((l) => !landed.has(l.deskTag)),
          now,
        )
        return
      }
      // Announced only once the write LANDED. A leg the desk cannot read from
      // `desk-books` has not been added to the book, whatever this fold
      // computed, and telling the operator otherwise is the phantom again.
      await this.#journalLegsCreated(req, created, now)
    } catch (err) {
      this.#d.log('book maintenance FAILED after routing — the book may understate a close', {
        clientOrderId: req.clientOrderId,
        error: errorMessage(err),
      })
    }
  }

  /**
   * The identity a NEW leg gets, or null when this fill may not open one.
   *
   * Split out because it is the whole of the new rule and the fold above should
   * read as a fold. Null is returned — never a partial guess — in all three
   * refusing cases, and the last one is logged because it is the only one that
   * leaves a routed order unrepresented.
   */
  #newLegIdentity(
    req: BookFoldRequest,
    doc: StoredBookLike,
    underlying: string,
    f: Fill,
    now: number,
  ): { underlying: string; expiry: string; strike: number; type: 'CE' | 'PE' } | null {
    // Closing what you do not hold is not a leg. Silent on purpose: a flatten
    // that races a supervisor's own close is routine, and the order log already
    // records it.
    if (f.op !== 'open') return null
    /**
     * The underlying is offered in TWO spellings because the dump's chain key
     * is the dump's own `name`, and the first candidate is a guess:
     * `deriveUnderlying` says so itself — it cannot separate `NIFTYNXT50` from
     * `NIFTYNXT` on a weekly, because an underlying may end in digits and so
     * may an expiry. The book's own symbol is the key that book was built
     * from, so it answers second rather than being trusted first.
     */
    const contract = contractOf(this.#d.master.current(), f.tradingsymbol, [
      underlying,
      doc.symbol,
    ])
    if (contract !== null) {
      /**
       * IT MUST BE THIS BOOK'S OWN PAIR (audit F2).
       *
       * A book IS a symbol and an expiry: `books-registry.ts` requires both,
       * `applyActions` stamps `req.expiry` onto every leg it opens, and every
       * consumer downstream — the greeks (one spot, one time to expiry), the
       * margin basket, the delete guard, the Python supervisor's whole
       * adjustment model — reads the book as one chain. A leg from another
       * underlying or another expiry inside it is not a position the book can
       * reason about; it is a second book hiding in the first one.
       *
       * Nothing stopped it before. The Manual Order dialog locks the pair to
       * the row, but the dialog is not the boundary — `POST /v1/desk/submit`
       * is, and it accepts any tag with any contract. A single mistyped body
       * (or the Strategies-page dialog, where the operator picks the symbol)
       * put a BANKNIFTY leg on a NIFTY book, and `contractOf` resolved it
       * happily because `deriveUnderlying` offers the SYMBOL'S own underlying
       * as the first candidate.
       *
       * Refused the same way an unnameable contract is: the order stays real
       * and visible where it is real, and the book stays honest about not
       * being able to hold it. A blank stored expiry (the pre-`d83b81aa`
       * blanking bug, `service.ts:1098`) also lands here and also refuses,
       * which is the safe direction — the log names the pair either way.
       */
      if (contract.underlying !== doc.symbol || contract.expiry !== doc.expiry) {
        this.#d.log('manual fill NOT added to the book — the contract is not this book\'s pair', {
          tag: req.tag,
          mode: req.mode,
          clientOrderId: req.clientOrderId,
          tradingsymbol: f.tradingsymbol,
          contract: `${contract.underlying} ${contract.expiry}`,
          book: `${doc.symbol} ${doc.expiry}`,
          ts: now,
        })
        return null
      }
      return contract
    }
    /**
     * The master cannot name this contract: a future, an unlisted strike, or a
     * fallback instrument the dump never synced. A leg needs a strike, a type
     * and an expiry, and inventing any of them puts a position the desk does
     * not hold in front of every consumer that reads the book — delta, margin,
     * the delete guard, and the supervisor that would then adjust it. So the
     * order stays visible where it is real (the broker, `desk-submissions`,
     * `positions-compare`) and the book stays honest about not knowing.
     */
    this.#d.log('manual fill NOT added to the book — the master cannot name the contract', {
      tag: req.tag,
      mode: req.mode,
      clientOrderId: req.clientOrderId,
      tradingsymbol: f.tradingsymbol,
      underlying,
      bookSymbol: doc.symbol,
      ts: now,
    })
    return null
  }

  /**
   * One `desk-order-events` STATUS line per leg this fold created.
   *
   * Shaped like `#journal`'s refusals and `mirror-sync.ts:correctionEvent`, so
   * the portal's order feed renders it with no changes — and keyed on the
   * TRANCHE's `clientOrderId`, which is the id the gateway journals that order's
   * own ACK and fills under, so the line lands inside that order's timeline
   * rather than beside it.
   *
   * `ok: true`: nothing failed. What the operator needs to read is that a leg
   * they placed by hand is now ON the book and will therefore be managed —
   * "the supervisor adopts it on its next tick" is the consequence, and it is
   * the part that is not obvious from an order confirmation.
   *
   * IT DESCRIBES THE LEG, NOT THE FILL. They differ exactly where it matters:
   * a fill that crosses through zero leaves a leg smaller than itself (5 lots
   * sold against a 2-lot long is a 3-lot short), and announcing the fill's own
   * quantity there would name a position the book does not hold.
   */
  async #journalLegsCreated(
    req: BookFoldRequest,
    created: readonly BridgeLeg[],
    now: number,
  ): Promise<void> {
    if (created.length === 0) return
    await this.#d.store.journalBlocked(
      created.map((l) => ({
        clientOrderId: l.deskTag,
        phase: 'STATUS',
        ok: true,
        tag: req.tag,
        tradingsymbol: l.instrument.tradingsymbol,
        ts: now,
        status: 'BOOKED',
        error:
          `manual leg added to book ${req.tag}: ${l.instrument.tradingsymbol} ` +
          `qty ${l.qty} @ ${l.entryPrice} — the supervisor adopts it on its ` +
          `next tick`,
        detail: {
          source: 'submit',
          op: 'leg-created',
          mode: req.mode,
          side: l.side,
          clientOrderId: req.clientOrderId,
        },
      })),
    )
  }

  /**
   * One `desk-order-events` line per leg the CAS race took away from us.
   *
   * `ok: false`, and that is the whole point: the order is at the broker, the
   * book does not carry it, and no code anywhere can put it back — the loser of
   * the race may not create (see `mayCreate: false` above). The operator has
   * just been told the order routed, which it did; this is the second half of
   * that sentence, and without it the only witness is a process log.
   *
   * Emitted as well as journalled, the same as `#journal`'s refusals: this is
   * precisely the moment someone is watching the page, and the divergence it
   * names is one only a human can resolve.
   */
  async #journalLegsLost(
    req: BookFoldRequest,
    lost: readonly BridgeLeg[],
    now: number,
  ): Promise<void> {
    if (lost.length === 0) return
    const events = lost.map((l) => ({
      clientOrderId: l.deskTag,
      phase: 'STATUS',
      ok: false,
      tag: req.tag,
      tradingsymbol: l.instrument.tradingsymbol,
      ts: now,
      status: 'NOT BOOKED',
      error:
        `manual leg LOST to a concurrent book write — book and broker may disagree, check ` +
        `Positions: ${l.instrument.tradingsymbol} qty ${l.qty} @ ${l.entryPrice} under ` +
        `${req.tag}. The ORDER routed; only the book fold did not.`,
      detail: {
        source: 'submit',
        op: 'leg-lost',
        mode: req.mode,
        side: l.side,
        clientOrderId: req.clientOrderId,
      },
    }))
    await this.#d.store.journalBlocked(events)
    const emit = this.#d.emit
    if (emit === undefined) return
    for (const event of events) {
      try {
        emit(req.mode, event)
      } catch {
        /* a dashboard that missed an update is an inconvenience */
      }
    }
  }

  async #writeJournal(
    req: BookFoldRequest,
    underlying: string,
    fills: readonly Fill[],
    now: number,
  ): Promise<boolean> {
    if (fills.length === 0) return false
    try {
      await this.#d.store.collection(PNL_JOURNAL).insertOne({
        decisionId: req.clientOrderId,
        // The underlying, not the contract: `desk-decisions` is keyed by book
        // symbol everywhere else and `/v1/desk/decisions?symbol=` filters on it.
        symbol: underlying,
        expiry: '',
        mode: req.mode,
        tag: req.tag,
        fills,
        skips: [],
        createdAt: now,
        status: 'DONE',
        source: 'submit',
      })
    } catch (err) {
      // A DUPLICATE IS NOT A FAILURE, and it is not a fresh write either — the
      // difference is what `#journalReconciledFills` reads to decide whether
      // the crashed process had already folded the book. See the WHY there.
      if (isDuplicateKey(err)) return false
      this.#d.log('P&L journal write FAILED — this strategy will under-report', {
        tag: req.tag,
        clientOrderId: req.clientOrderId,
        error: errorMessage(err),
      })
      // NOT told to the book. The write above did not land, so the reconcile
      // will not find these fills either — putting them in memory would
      // manufacture a divergence out of a failure the log already names.
      return false
    }
    /**
     * The in-memory book, AFTER the durable write and unable to affect it.
     *
     * `createdAt: now` is the same stamp the document carries, so the fills are
     * filed in the window the reconcile will rebuild them into. Wrapped because
     * this method sits on the order path and `LiveBook.onJournal` must never be
     * able to turn a placed order into a failed request.
     */
    if (this.#d.journal !== undefined) {
      try {
        this.#d.journal({ tag: req.tag, mode: req.mode, createdAt: now, fills })
      } catch {
        /* the 60s reconcile repairs anything dropped here */
      }
    }
    return true
  }

  /**
   * Append the refusal to `desk-order-events`, the feed the portal renders as
   * "what happened to my orders". A rejection that leaves no trace makes a
   * switched-off strategy indistinguishable from a dead one.
   *
   * Shaped like `apps/order-gateway`'s `OrderEvent` and like
   * `strategies.ts:blockedEvents`, so the existing feed renders it unchanged.
   */
  async #journal(req: SubmitRequestBody, reason: string, now: number): Promise<void> {
    const event: Record<string, unknown> = {
      clientOrderId: `${req.clientOrderId}#0`,
      phase: 'INVALID',
      ok: false,
      tag: req.tag,
      tradingsymbol: req.instrument.tradingsymbol,
      ts: now,
      error: reason,
      detail: {
        source: 'submit',
        mode: req.mode,
        side: req.side,
        lots: req.lots,
        reducesExposure: req.reducesExposure === true,
        clientOrderId: req.clientOrderId,
      },
    }
    await this.#d.store.journalBlocked([event])
    /**
     * Pushed AFTER the journal write, and unable to affect it.
     *
     * A refusal is the event an operator is most likely to be waiting on — "why
     * did nothing trade this morning?" — so it goes out live. Wrapped for the
     * same reason `journalBlocked` swallows its own errors: this method is on
     * the path of every gate refusal, and a notification must never be the
     * reason an order response fails.
     */
    const emit = this.#d.emit
    if (emit !== undefined) {
      try {
        emit(req.mode, event)
      } catch {
        /* a dashboard that missed an update is an inconvenience */
      }
    }
  }
}

/**
 * What contract a tradingsymbol IS — strike, type, expiry and the underlying
 * key its chain is filed under — or null when this dump cannot say.
 *
 * NO NEW SYMBOL REGEX, deliberately. `apps/order-gateway/src/gateway.ts` and
 * `apps/web/src/contract.ts` each already parse the exchange's packing, and
 * both say in their own headers that the result is a GUESS an underlying ending
 * in digits defeats. A third spelling of "what does NIFTY2580725000CE mean" is
 * a third thing to get wrong, and a wrong strike here is not a display bug: it
 * is a leg on the book at a contract nobody holds.
 *
 * So the answer is LOOKED UP rather than parsed. `expiryOf` names the expiry
 * off the master's own row, and the chain's LISTED strikes are then walked
 * until `resolve` hands back the very same tradingsymbol — exact identity, the
 * same join `applyActions` trusts to route on.
 *
 * NULL FOR A FUTURE, for free and on purpose: `expiryOf` is options-only, so a
 * `...FUT` symbol never resolves here and its caller leaves the book alone.
 *
 * The cost is a walk of one chain (a few hundred Map hits) and it is paid only
 * on the fills that would OPEN a leg — never on a close, never on a contract
 * the book already holds.
 *
 * EXPORTED for `routes/engine.ts`, whose whole wire is instrument-shaped and
 * which therefore asks this question of every open the supervisor sends. A
 * second implementation there would be a third spelling of the same guess.
 */
export function contractOf(
  master: OptionMaster,
  tradingsymbol: string,
  underlyings: readonly string[],
): { underlying: string; expiry: string; strike: number; type: 'CE' | 'PE' } | null {
  const expiry = master.expiryOf(tradingsymbol)
  if (expiry === null) return null
  for (const underlying of underlyings) {
    for (const strike of master.strikes(underlying, expiry)) {
      for (const type of ['CE', 'PE'] as const) {
        if (master.resolve(underlying, expiry, strike, type)?.tradingsymbol === tradingsymbol) {
          return { underlying, expiry, strike, type }
        }
      }
    }
  }
  return null
}

/**
 * Stamp `origin` on the legs THIS FOLD produced, and on nothing else.
 *
 * The word belongs to the order, not to the book, so a repair Apply must not
 * relabel the four legs it did not touch — `origin` is what the Python driver
 * reads to decide whether a leg is adopted bot-managed, and restamping a
 * seeded leg would hand it to the supervisor on the strength of an unrelated
 * order.
 *
 * TOUCHED IS BY OBJECT IDENTITY, which is exact here and cheaper than any
 * diff: `applyRoutedFill` copies the array and rebuilds only the legs it
 * changes (`{ ...leg, qty }`) or opens, so every leg it left alone comes back
 * as the very object the prior book held. That covers BOTH shapes the brief
 * cares about — a leg created on a strike the book did not hold, and a leg
 * resized because it did — without the caller having to tell them apart.
 *
 * An ABSENT origin writes nothing at all: absent is manual, and stamping the
 * default would rewrite legs that were already correct while making the field
 * look like a decision somebody made.
 */
function stampOrigin(
  legs: readonly BridgeLeg[],
  prior: readonly BridgeLeg[],
  origin: 'manual' | 'repair' | undefined,
): readonly BridgeLeg[] {
  if (origin === undefined) return legs
  const untouched = new Set<BridgeLeg>(prior)
  return legs.map((l) => (untouched.has(l) ? l : { ...l, origin }))
}

/**
 * Does this order skip the P&L journal and the book fold at route time?
 *
 * Only a LIVE resting order: it may sit at the broker for hours, so it is not a
 * fill yet. A PAPER resting order is a fill the moment it routes — the paper
 * rail writes it COMPLETE at the operator's limit — so it is booked like any
 * other. One rule for the routing loop and the reconcile that rebuilds it.
 */
function restsUnbooked(mode: DeskMode, resting: boolean): boolean {
  return resting && mode === 'live'
}

/**
 * The one place an `accepted: true` body is built, so `routedLots` is derived
 * from the ROUTED tranches and from nothing else.
 *
 * Both call sites used to spell the body out and both reached for the intended
 * `lots`, which is how a 24-of-30 partial reported 30. Deriving it here means
 * the number cannot drift from the array it describes.
 */
function acceptedResponse(
  clientOrderId: string,
  routed: readonly SubmittedOrder[],
  rest: {
    readonly status: 'DONE' | 'FAILED'
    readonly replayed: boolean
    readonly intendedLots: number
    readonly requestedLots: number
    readonly freezeMaxLots: number | null
    readonly errors: readonly string[]
  },
): SubmitResponse {
  const routedLots = sumLots(routed)
  return {
    accepted: true,
    status: rest.status,
    clientOrderId,
    orders: routed,
    replayed: rest.replayed,
    routedLots,
    lots: routedLots,
    intendedLots: rest.intendedLots,
    requestedLots: rest.requestedLots,
    freezeMaxLots: rest.freezeMaxLots,
    errors: rest.errors,
  }
}

// --------------------------------------------------------------- validation

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Validate a submit body. Hand-written, for the reasons in `validate.ts`: this
 * is an untrusted boundary, and a malformed order does not fail loudly — it
 * books a position at the wrong size against the wrong contract.
 */
export function validateSubmitRequest(raw: unknown): Validated<SubmitRequestBody> {
  if (!isObject(raw)) return { ok: false, error: 'body must be a JSON object' }
  if (!isNonEmptyString(raw['tag'])) return { ok: false, error: 'tag is required' }
  if (!isNonEmptyString(raw['clientOrderId'])) {
    return {
      ok: false,
      error: 'clientOrderId is required — it is the idempotency key for this order',
    }
  }
  // No default. Guessing paper silently stops a live strategy; guessing live is
  // catastrophic. The caller states it every time.
  if (raw['mode'] !== 'paper' && raw['mode'] !== 'live') {
    return { ok: false, error: "mode must be stated explicitly as 'paper' or 'live'" }
  }
  if (raw['side'] !== 'Buy' && raw['side'] !== 'Sell') {
    return { ok: false, error: "side must be 'Buy' or 'Sell'" }
  }
  const lots = raw['lots']
  if (!isFiniteNumber(lots) || !Number.isInteger(lots) || lots <= 0) {
    return { ok: false, error: 'lots must be a positive integer number of lots' }
  }
  const inst = raw['instrument']
  if (!isObject(inst)) return { ok: false, error: 'instrument must be an object' }
  if (!isNonEmptyString(inst['tradingsymbol'])) {
    return { ok: false, error: 'instrument.tradingsymbol is required' }
  }
  for (const k of ['instrumentToken', 'lotSize', 'tickSize'] as const) {
    if (inst[k] !== undefined && !isFiniteNumber(inst[k])) {
      return { ok: false, error: `instrument.${k} must be a finite number when present` }
    }
  }
  if (inst['exchange'] !== undefined && typeof inst['exchange'] !== 'string') {
    return { ok: false, error: 'instrument.exchange must be a string when present' }
  }
  const orderType = raw['orderType']
  if (orderType !== undefined && orderType !== 'MARKET' && orderType !== 'LIMIT') {
    return { ok: false, error: "orderType must be 'MARKET' or 'LIMIT'" }
  }
  // A LIMIT without a price would route as a market order at the broker, which
  // is the opposite of what the caller asked for.
  if (orderType === 'LIMIT' && !isFiniteNumber(raw['limitPrice'])) {
    return { ok: false, error: 'limitPrice is required when orderType is LIMIT' }
  }
  for (const k of ['limitPrice', 'triggerPrice', 'referencePrice'] as const) {
    if (raw[k] !== undefined && (!isFiniteNumber(raw[k]) || raw[k] <= 0)) {
      return { ok: false, error: `${k} must be a positive number when present` }
    }
  }
  if (raw['reducesExposure'] !== undefined && typeof raw['reducesExposure'] !== 'boolean') {
    return { ok: false, error: 'reducesExposure must be a boolean when present' }
  }
  if (raw['resting'] !== undefined && typeof raw['resting'] !== 'boolean') {
    return { ok: false, error: 'resting must be a boolean when present' }
  }
  // A resting order without a caller-chosen LIMIT would rest at a price the
  // marketable machinery invented — nobody's price, resting indefinitely.
  if (raw['resting'] === true && orderType !== 'LIMIT') {
    return { ok: false, error: "resting requires orderType 'LIMIT' and an explicit limitPrice" }
  }
  if (raw['exactLots'] !== undefined && typeof raw['exactLots'] !== 'boolean') {
    return { ok: false, error: 'exactLots must be a boolean when present' }
  }
  if (raw['underlying'] !== undefined && !isNonEmptyString(raw['underlying'])) {
    return { ok: false, error: 'underlying must be a non-empty string when present' }
  }
  // A word nobody defined is a leg the Python driver cannot classify, so it is
  // refused at the door rather than stored and puzzled over on adoption.
  const origin = raw['origin']
  if (origin !== undefined && origin !== 'manual' && origin !== 'repair') {
    return { ok: false, error: "origin must be 'manual' or 'repair' when present" }
  }
  // A blank one is not a desk leg: it would ride onto the fill as an id that
  // matches nothing, which is the failure the field exists to fix.
  if (raw['fillDeskTag'] !== undefined && !isNonEmptyString(raw['fillDeskTag'])) {
    return { ok: false, error: 'fillDeskTag must be a non-empty string when present' }
  }
  if (raw['fillDeskTag'] !== undefined && raw['reducesExposure'] !== true) {
    return { ok: false, error: BORROWED_LEG_TAG }
  }

  const instrument: SubmitInstrument = {
    tradingsymbol: inst['tradingsymbol'],
    ...(inst['instrumentToken'] === undefined
      ? {}
      : { instrumentToken: inst['instrumentToken'] as number }),
    ...(inst['lotSize'] === undefined ? {} : { lotSize: inst['lotSize'] as number }),
    ...(inst['tickSize'] === undefined ? {} : { tickSize: inst['tickSize'] as number }),
    ...(inst['exchange'] === undefined ? {} : { exchange: inst['exchange'] as string }),
  }
  return {
    ok: true,
    value: {
      tag: raw['tag'],
      mode: raw['mode'] as DeskMode,
      clientOrderId: raw['clientOrderId'],
      instrument,
      side: raw['side'] as DeskSide,
      lots,
      ...(orderType === undefined ? {} : { orderType: orderType as 'MARKET' | 'LIMIT' }),
      ...(raw['limitPrice'] === undefined ? {} : { limitPrice: raw['limitPrice'] as number }),
      ...(raw['triggerPrice'] === undefined ? {} : { triggerPrice: raw['triggerPrice'] as number }),
      ...(raw['referencePrice'] === undefined
        ? {}
        : { referencePrice: raw['referencePrice'] as number }),
      ...(raw['exactLots'] === undefined ? {} : { exactLots: raw['exactLots'] as boolean }),
      ...(raw['reducesExposure'] === undefined
        ? {}
        : { reducesExposure: raw['reducesExposure'] as boolean }),
      ...(raw['resting'] === undefined ? {} : { resting: raw['resting'] as boolean }),
      ...(raw['underlying'] === undefined ? {} : { underlying: raw['underlying'] as string }),
      ...(origin === undefined ? {} : { origin }),
      // Verbatim: it is a FOREIGN id (the Python driver mints it), and trimming
      // or casing it here would be this bridge editing the other side's key.
      ...(raw['fillDeskTag'] === undefined ? {} : { fillDeskTag: raw['fillDeskTag'] as string }),
      ...(isObject(raw['meta'])
        ? { meta: raw['meta'] as Record<string, string | number | boolean> }
        : {}),
    },
  }
}

/** `DESK_LIVE_TAGS`, parsed the same way `main.ts` parses it for the rail. */
export function liveTagsFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env['DESK_LIVE_TAGS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
}
