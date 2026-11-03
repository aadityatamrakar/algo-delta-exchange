/**
 * ONE BOOK'S BRAIN WIRED TO ONE BOOK'S RAILS — the layer that turns `decide()`
 * into a routed order EXACTLY ONCE, and folds back what the order did.
 *
 * `decide()` is pure and already proven against 1,152 recorded Python marks.
 * Everything in this file is what happens AROUND it, and every part of it is
 * here because of a failure a pure function cannot have:
 *
 * ── 1. DAMPING — the engine sees TICKS, not marks (spec §7, D4) ─────────────
 * The Python desk decided every 30 seconds against one mid price. This one
 * decides on every tick of a two-sided book, which is the point — a band breach
 * is acted on in seconds rather than at the next 5-minute mark — and is also how
 * a single flickering quote becomes a real package. So EVERY ORDER-PRODUCING
 * TRIGGER, phase S included, has to prove itself:
 *
 *   `confirm_ms`   the same trigger, with the same action shape, still wanted
 *                  `confirm_ms` later. A trigger that vanishes disarms.
 *   the OBVIOUS-BREACH ESCAPE   a phase-R excess of at least one full
 *                  lot-equivalent of delta is not a flicker, and waiting on it
 *                  costs more than it saves (spec §7: "or, for phase R, to
 *                  exceed the band by ≥ 1 full lot-equivalent").
 *   `cooldown_s`   after any ROUTED decision, nothing new for that book. This
 *                  is what stops a book re-deciding into its own working orders.
 *   TWO FRESH BROKER MARGIN READS   before the shift's margin gate may arm. The
 *                  engine's gate is a single read (`shift.ts:marginArmed`); the
 *                  second is the HOST's, because only the host knows how many
 *                  times it has asked. It stays armed while the reads keep
 *                  coming and resets when one is stale or modelled.
 *
 * GUARD TRIGGERS BYPASS ALL OF IT (`lock`, `margin`, `expiry`, `eod`). They are
 * urgency exits (§8) and they preempt an armed playbook intent rather than
 * queueing behind it: a target lock that waited to prove it meant it is the
 * desk's one hard rule, damped.
 *
 * THE ARMED INTENT IS IN MEMORY, AND ITS CLOCK RESTARTS. A supervisor restart,
 * a lease handover, or a package dropped inside this process (nothing routable,
 * one contract named twice) all leave the next pass arming from scratch — so a
 * trigger that had already persisted four seconds serves its `confirm_ms`
 * again. That is deliberate rather than merely convenient: `confirm_ms` says
 * "this condition has held while I have been watching", and a process that has
 * just started watching cannot honestly claim the earlier seconds. The cost is
 * one confirm window per restart, per book. What is NOT in memory is everything
 * that would be expensive to re-earn — the streak, the anchor, the flight —
 * which is why those are in `desk-supervisor-state` and this is not.
 *
 * A PASS THAT ROUTES NOTHING STILL BANKS THE MARK. Damped, dropped or refused,
 * `decision.markState` is persisted — the target lock's confirmation streak AND
 * its dip-disarm, the anchor EMA, the EOD stamp. Writing nothing there leaves a
 * streak that survives its own dips and counts NON-CONSECUTIVE marks, which is
 * the TCS 2026-06-19 defence turned off; writing `stateAfter` instead would bank
 * a scrap ban and a bank movement for a package that never went out. The engine
 * reports the two separately for exactly this reason (`types.ts:markState`).
 *
 * ── 2. EXACTLY-ONCE ROUTING — the save comes BEFORE the post ────────────────
 * `seq` is bumped, `inFlight` is set and the whole package is written to
 * `desk-supervisor-state` BEFORE the request goes out. A process killed in that
 * window comes back holding an id it may or may not have posted, re-posts it
 * verbatim, and desk-api's unique index on `decisionId` answers with the
 * ORIGINAL outcome instead of routing a second time. The other order — post,
 * then save — loses the id on exactly the same crash and forms a SECOND package
 * for a position it already has.
 *
 * The three outcomes are not symmetrical, and the asymmetry is the contract
 * (spec §8):
 *
 *   REFUSED (4xx)   desk-api read the request and said no. Nothing was claimed;
 *                   posting it again would be refused again. The decision's
 *                   rule-state delta is ROLLED BACK — a scrap ban that survived
 *                   a package which never routed would stop the book re-selling
 *                   a strike over an order that never existed — it is logged at
 *                   error, and it is NOT retried. The `seq` stays burnt.
 *   INDETERMINATE   the answer was lost. The id is kept and replayed at 1 s.
 *   DONE / FAILED   terminal. Fold the fills, clear the flight.
 *
 * ONE POLLER, AND IT IS `pollInFlight`. An evaluation that finds a package in
 * flight EVALUATES (the mark has to count, and a guard has to be seen) but does
 * not re-post: the 1 s poll and the fill nudge are the only things that ask
 * desk-api again, so one decision is never two requests racing each other's
 * fold.
 *
 * **A FAILED id replays FAILED forever** (`service.ts:#replay`), so a failed
 * decision is terminal HERE too and the next intent mints a new id. A host that
 * kept polling a FAILED id would hold that book for the rest of the session.
 *
 * ── 3. `rcStack` IS THE HOST'S TO MAINTAIN ──────────────────────────────────
 * The engine READS `RuleState.rcStack` to order the LIFO unwind newest-first
 * and never writes it — it cannot, because a decision is not a fill. So this
 * file pushes each engine-opened short onto the stack when its fill lands
 * (newest last, merged by strike and wing) and shrinks or pops an entry when a
 * buy-back reduces it. A host that forgets leaves the unwind eating the ENTRY
 * book first, which is the ASHOKLEY failure `tiers.ts` describes — and no
 * parity fixture can catch it, because parity never routes an order.
 *
 * ── 4. WHAT A FILL IS MEASURED AGAINST, AND ON WHICH RAIL ───────────────────
 * `cumRealized` folds at the price desk-api REPORTS for each fill, against the
 * leg's own entry — never the decision's limit and never this process's mark.
 * The entry, and the strike/wing behind a tradingsymbol, are recorded in
 * `workingPackage.basis` when the package forms, because desk-api folds a fill
 * into `desk-books` the moment it lands and the leg may be gone by the time the
 * outcome is read.
 *
 * THE GUARANTEE IS NOT THE SAME ON BOTH RAILS, and saying otherwise would be the
 * exact dishonesty the exit-side work exists to end:
 *
 *   PAPER — the reported price IS the fill. `paper-fold.ts` reads the gateway's
 *   terminal record and pushes the real `avgPrice` onto the decision, so a
 *   replay hands back what the simulator actually traded.
 *
 *   LIVE — the reported price is a DECISION-TIME MARK. `applyDecision` books
 *   optimistically at route time (`service.ts:829-837`) and `reconcile-live.ts`
 *   later restates `desk-books` from the broker's terminal record — but nothing
 *   restates THIS number. A live fold is therefore real money measured off a
 *   mark the broker may have disagreed with by a tick or more on a wide book.
 *
 * That is a known, ruled-on gap (live keeps the optimistic fold), not a defect
 * to fix here — so it is STAMPED instead: every fold records
 * `cumRealizedBasis: 'fill' | 'optimistic-mark'` per decisionId, which is what
 * lets the invariant sweep and a later broker-truth true-up find the rupees that
 * need re-measuring instead of re-deriving which rail each one came from.
 *
 * ── 5. TWO ENGINES, ONE SET OF RAILS ───────────────────────────────────────
 * `dials.delta_lean_enabled` selects `decideDeltaLean` instead of `decide` at
 * both call sites (`#decide`) — and, on such a book, `pb_playbook` 1-6 selects
 * the playbook frame, `decidePlaybook`, instead (six-playbooks spec §4.1). A
 * playbook IS a delta-lean book: it rides every rail below unchanged. NOTHING
 * ELSE in this file branches on the book's kind except the four things that
 * genuinely differ:
 *
 *   THE FAST PATH. A delta-lean target, stuck exit or stop, or a playbook exit,
 *   skips `confirm_ms` outright (`#obviousBreach`): the controller emits one
 *   only after a rule has already fired, so the wait re-asks a question that is
 *   answered. The cooldown still outranks it, which is why every delta-lean
 *   and playbook preset sets `cooldown_s: 0`.
 *
 *   EXITS PRE-EMPT ADDS. Spec §8: the engine can emit an exit while an add
 *   tranche is working, and `#watchWhileWorking` cancels the add so the next
 *   pass can route the exit against the book that really exists.
 *
 *   THE ORDER BUDGET. `dl_max_orders_s` and `dl_max_orders_day` are counted HERE
 *   (`#budgetRoom` reads the three rooms, `openBudget` rules on them), over
 *   real time and routed wire actions, because a pure function of one tick
 *   cannot see the second it is in or the session it is part of. Caps bind on
 *   OPENS only — an exit is never dropped.
 *
 *   THE DAY'S BANK. `#settle` folds a realised close into `dlDayRealized` as
 *   well as `cumRealized` — spec §7 — and ONLY on a delta-lean book, because
 *   only `decideDeltaLean` runs the `rollDay` that zeroes the field.
 *
 * Everything else — marking, damping, exactly-once routing, the fold, `rcStack`,
 * the maker quote — is shared, unbranched, and unchanged.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * **Cancelling a working package so a guard can preempt it.** Spec §8 has guards
 * preempt working ORDERS (cancel first, then act); the cancel path is Task 15's,
 * which owns the maker-quote invalidation and the broker cancel call. Until it
 * lands, a guard that wants a book with a package in flight is LOGGED AT ERROR
 * and not routed: a second package against orders that are still out would
 * double-close legs the first one is already closing. The log line is the seam.
 *
 * PURE OF EVERYTHING BUT ITS DEPS: no Mongo, no bus, no `Date.now()`, no
 * `process.env`. The clock, the market, the book, the margin and the wire are
 * all injected, which is what lets the whole lifecycle be tested on a laptop.
 */

import {
  DECISION_CLOCK_CLOSE_MIN,
  MARK_STEP_MIN,
  SESSION_OPEN_MIN,
  corridor,
  decide,
  decideBullS,
  decideDeltaLean,
  decidePlaybook,
  isTradingDay,
  markLeg,
  markOf,
  strikeGreeks,
  theoreticalPrice,
  totalPnl,
} from '@algomaker/desk-engine'
import { roundToStep, venueFromEnv, type VenueSpec } from '@algomaker/venue'
import type {
  BullSInputs,
  ChainSnap,
  DecisionRequest,
  DecisionResponse,
  DeltaLeanInputs,
  Dials,
  EngineAction,
  EngineDecision,
  EngineInputs,
  ForwardSource,
  LegPosition,
  LegView,
  MarginInput,
  MarkContext,
  Mode,
  OptType,
  Quote,
  RuleState,
  SpotRing,
  Trigger,
  Urgency,
  WireAction,
  WireFill,
  WorkDials,
  WorkMode,
} from '@algomaker/desk-engine'
import { RefusedError, refusalGuidance, type DecisionsPort } from './decisions-client.ts'
import { Throttle } from './throttle.ts'
import {
  REALIZED_BASIS_KEPT,
  nextVersion,
  type PackageBasis,
  type RealizedFold,
  type StateStore,
  type SupervisorBookState,
} from './state-store.ts'

/**
 * The four levels every process on this desk logs at.
 *
 * Declared here rather than imported from `@algomaker/strategy-kit` (which has
 * the identical shape) so the supervisor does not take a dependency on the
 * strategy runtime for four signatures. Structurally compatible on purpose:
 * `main.ts` hands over the same logger it hands everything else.
 */
export interface HostLog {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
}

export interface EngineHostDeps {
  readonly tag: string
  readonly mode: Mode
  /** The book's resolved dials, re-read every pass — a retune lands at once. */
  dials(): Dials
  /** The chain as the engine decides on it; `null` when there is no market. */
  snap(): ChainSnap | null
  /** This book's legs, read from `desk-books`. Read-only, every pass. */
  readBook(): Promise<ReadonlyArray<LegPosition>>
  margin(): MarginInput
  /**
   * The tradingsymbol for a strike and a wing.
   *
   * The wire addresses CONTRACTS while the engine decides in strikes, so
   * something has to bridge the two — and it must be a LOOKUP against the
   * instrument master, never a formula over the exchange's packing (an
   * underlying ending in digits defeats every regex, and a wrong strike here is
   * a real order on a contract nobody chose). `null` = not listed: the action is
   * dropped and named in the log rather than guessed at.
   */
  instrumentFor(strike: number, optType: OptType): string | null
  /** Is desk-api's repair-Apply holding this tag? See `repair-hold.ts`. */
  repairHold(): Promise<boolean>
  readonly store: StateStore
  readonly client: DecisionsPort
  now(): number
  readonly log: HostLog
  /**
   * THE 5-MINUTE GRID, AND THERE MUST BE EXACTLY ONE OF IT.
   *
   * `MarkClock.next()` ADVANCES: it answers `isNewMark: true` once per window and
   * false for every call after it. So a second clock is not a second reading of
   * the same thing — it is a second consumer, and whichever asks first takes the
   * mark. A marks journal with its own clock would file rows against a grid that
   * disagrees with the target lock's streak at every boundary, and the streak is
   * the desk's defence against a gap-open phantom mark (TCS 2026-06-19).
   *
   * Injected so `main.ts` can hand the SAME instance to whatever else needs the
   * grid, and defaulted so a test that does not care constructs one host and
   * nothing else. What the journal actually consumes is `onMark` below — it
   * never calls `next()` itself, precisely because calling it would consume the
   * mark this host is deciding on.
   *
   * ONE CLOCK PER BOOK, NOT ONE PER PROCESS, and the distinction is the whole
   * hazard this dep exists for. `next()` is a consume: whichever caller asks
   * first inside a window gets `isNewMark`, everyone after it gets false. A
   * process-wide clock shared across books would therefore have the first book
   * evaluated in each window swallow the mark for ALL of them — every other book
   * would count zero marks, its target-lock streak would never advance, and its
   * journal would have one row per five minutes for one book and none for the
   * rest. `main.ts` constructs a fresh `MarkClock` per host deliberately; the
   * sharing this field is for is between a book and ITS OWN journal row.
   */
  readonly marks?: MarkClock
  /**
   * ONE MARK, AS THE ENGINE SAW IT — the journal's row (`marks-journal.ts`).
   *
   * Called once per 5-minute window per book, from inside the evaluation, with
   * the numbers the rules actually decided on rather than a re-measurement.
   * Synchronous and fire-and-forget by contract: journalling may never be the
   * reason a decision waits, and it may never throw into the evaluation queue.
   */
  onMark?(sample: MarkSample): void
  /**
   * EVERY PASS'S REASON, for a BULL-S book only (`bs_enabled`). Its refusals
   * (a level cooling down after the venue refused the entry, the gateway's
   * `oi-cap: …`) are news the moment they happen; the mark journal's 5-minute
   * cadence would leave the book page showing an older line. Other engines'
   * last-decision line stays the mark's, exactly as before.
   */
  onDecision?(reason: string): void
  /**
   * The contract's tick size, for flooring a maker quote onto the exchange's
   * grid. `null`/absent falls back to the venue's `defaultTick` — see `#quoteAt`.
   */
  tickSizeFor?(strike: number, optType: OptType): number | null
  /**
   * The venue this book trades on: its quantity step, default tick, clock and
   * expiry instant. Absent = `venueFromEnv()` (`DESK_VENUE`, NSE when unset),
   * read once when the host is built.
   */
  readonly venue?: VenueSpec
  /**
   * CANCEL EVERY ORDER STILL WORKING UNDER THIS DECISION, and answer how many
   * cancels were requested.
   *
   * The seam spec §8 calls "guards always preempt working orders (cancel first,
   * then act)" and the maker quote's invalidation. Absent = a deployment with no
   * cancel path wired, in which case a guard that wants a working book is logged
   * at ERROR and nothing is routed — which is exactly what ticket 14 shipped and
   * disclosed.
   *
   * `skip` is the broker ids this host asked to cancel within the last
   * `CANCEL_REASK_MS`; the sweep files nothing for them and reports what it did
   * file in `CancelOutcome.asked`.
   */
  cancelWorking?(decisionId: string, skip: ReadonlySet<string>): Promise<CancelOutcome>
  /** Overrides `CANCEL_REASK_MS`. Production leaves it absent. */
  readonly cancelReaskMs?: number
  /**
   * THE SHARED SPOT BUFFER the delta-lean regime detector reads — one per
   * SYMBOL, not one per book, so four books on NIFTY classify off one tape.
   *
   * ABSENT MEANS THIS BOOK IS NOT DELTA-LEAN, and that is the whole contract of
   * these three fields. ~45 construction sites and every existing test predate
   * them; a required field here would be a required field on every recenter
   * book, which does not have a ring, does not want one, and would have to
   * invent a zeroed stand-in — the one thing `types.ts` §2 forbids.
   *
   * A book whose `delta_lean_enabled` dial is ON and whose ring is absent is a
   * WIRING FAULT, not a recenter book: it is logged once, at error, and the book
   * holds rather than being steered by an engine that is not its own.
   */
  readonly ring?: SpotRing
  /**
   * The epoch ms of the newest tick pushed into `ring`.
   *
   * Stated by the host rather than derived, for the reason `DeltaLeanInputs`
   * gives: taken off the chain it would be the OPTION feed's clock answering a
   * question about the INDEX feed, and `SpotRing` exposes no newest-sample
   * accessor. `dl_spot_stale_s` is measured against this.
   */
  spotAsOf?(): number
  /**
   * TRADING minutes to expiry, holidays already removed.
   *
   * Defaulted rather than required: absent, the host computes it with
   * `tradingMinutesToExpiry` off the chain's own expiry, which is the right
   * answer for every book on this desk. The seam exists so a symbol with a
   * calendar of its own can state one without this file learning about it.
   */
  minutesToExpiry?(): number
  /**
   * THE INDEX'S PREVIOUS SESSION CLOSE (six-playbooks spec F6), as `md.spot`
   * last carried it for this book's symbol.
   *
   * `null`, or absent, is UNKNOWN — never a zero: the playbook frame then has
   * no opening gap, and a rule that needs one does not pass. A close of 0
   * would be a gap of the whole index. Read on a delta-lean book only, and
   * only the playbook frame reads it (`DeltaLeanInputs.prevClose`).
   */
  prevClose?(): number | null
  /**
   * WHICH SOURCE PRICED THE CHAIN `snap()` RETURNED THIS PASS (spec F1): the
   * weekly's own parity forward, the index carried over its tenor, the
   * future's mid, or the proxy.
   *
   * The chain view is shared by every book, so `main.ts` records the answer on
   * the BOOK at the moment of its snap; this reads that, never the view later.
   * Handed to the engine (`DeltaLeanInputs.forwardSource`, F7) and journalled
   * beside `spot`. Absent = UNKNOWN, which the playbook frame reads as "not the
   * weekly's own forward" and takes no new risk on.
   */
  forwardSource?(): ForwardSource | undefined
  /**
   * THE PLAYBOOK FRAME, as a seam. Absent — production — is the engine's own
   * `decidePlaybook`. A test hands in a spy to prove which path a pass took,
   * and what it was told, without depending on what the frame decides.
   */
  decidePlaybook?(
    inputs: DeltaLeanInputs,
    dials: Dials,
    state: RuleState,
    markCtx: MarkContext,
  ): EngineDecision
  /**
   * THE STRATEGY SWITCH, as the registry poll last read it (spec E3, D3):
   * `desk-strategies.modes[mode].enabled` for this tag. `true` = on, `false`
   * = added and switched off, `null` = UNKNOWN (no row, an unreadable row, or
   * a collection that could not be read this pass).
   *
   * Synchronous and cached by the caller on purpose: it is asked on every
   * pass, and a Mongo read per evaluation per book is how a 2 s cadence turns
   * into a load. `main.ts` hands the value the poll resolved at most 5 s ago.
   *
   * WHY THE HOST READS IT AT ALL, when desk-api's gate already refuses a
   * switched-off book's package: because refusing is not the same as not
   * asking. From 09-16 15:42 to 09-18 three switched-off books went on
   * deciding, posting, and being refused INVALID — 835 red rows, each a burnt
   * seq and a journal line — for want of this one bit. `false` means this book
   * takes NO NEW RISK (no package with an open in it is formed) and, when it
   * holds nothing, IDLES: no mark, no state, no decision. It does NOT mean
   * "post nothing": desk-api admits a reduce-only package through a
   * switched-off row (`routes/engine.ts`'s `reducesExposure`), because "added
   * and off" is the operator's routine stop control and it must still release
   * what the book holds — so a switched-off book with legs keeps cutting.
   *
   * ABSENT, OR `null`, DECIDES. Unknown is not off: a blip reading the
   * strategies collection must not stand every book on the desk down, and the
   * api's `UnknownStrategy` refusal stays the guard for a row that really is
   * missing. Optional because ~45 construction sites predate it.
   */
  switchedOn?(): boolean | null
  /**
   * The host has stood down (`reason`), or resumed (`null`). `main.ts` puts the
   * reason in the registry row's `lastDecision` so the book page says "switched
   * off for paper — not deciding" instead of showing a book that has silently
   * gone quiet. Nothing branches on it.
   */
  onStandDown?(reason: string | null): void
  /**
   * WHOSE PRICES MARKED THIS PASS, for a book marked on Delta's testnet
   * (`demo-marks.ts`). Asked once per decision with the contracts that matter
   * to it — the legs held and the strikes being opened — and the note it
   * answers is appended to the reason the page and the journal read
   * (`marks: Delta demo, prod fallback on …`), with a WARN whenever the set of
   * contracts marked off production changes. A fallback is never silent.
   *
   * ABSENT, or `null`: production marks, and the reason is the engine's alone.
   */
  marksNote?(
    contracts: ReadonlyArray<{ readonly strike: number; readonly optType: OptType }>,
  ): { readonly note: string; readonly fallback: ReadonlyArray<string> } | null
}

/**
 * WHAT A CANCEL SWEEP ACTUALLY DID — and why one number was not enough.
 *
 * `requested` counts the cancels that reached desk-api; `failed` counts the
 * orders whose request could not be filed, and the host says the two apart:
 * a refusal is an ERROR, a filed cancel the expected preemption.
 *
 * THE HOST NO LONGER LATCHES ON ANY OF IT (2026-10-01). It used to remember
 * "this decision has been cancelled" and stop sweeping, and that wedged twice:
 * a sweep that met only unplaced orders answered `{0, 0}` and latched while the
 * orders went out a second later and rested; and a cancelled tranche of a CLOSE
 * is ADVANCED by the gateway (`gateway.ts:decideTrancheStep` rule 3), so the
 * next tranche goes out under a NEW broker id after the latch was set. Now the
 * host sweeps every pass it still wants the package gone, and dedupes by
 * broker id instead (`asked`, fed back as the sweep's `skip`).
 */
export interface CancelOutcome {
  readonly requested: number
  readonly failed: number
  /**
   * Orders under the decision that are not at the broker right now — claimed
   * and not yet placed, or a close between tranches. Nothing to cancel THIS
   * pass; they are about to go out. Optional: absent and 0 are the same.
   */
  readonly unplaced?: number
  /**
   * The broker ids this sweep filed a cancel for. Optional for a canceller
   * that cannot say; the host then dedupes nothing, which is harmless
   * downstream (the request is upserted per order id) but noisy.
   */
  readonly asked?: readonly string[]
}

/**
 * How long a filed cancel is trusted before the same broker id is asked again.
 * A cancel the gateway never acted on must not leave a book behind a resting
 * order for the rest of the session; once a minute is not noise.
 */
export const CANCEL_REASK_MS = 60_000

/**
 * WHAT ONE MARK LOOKED LIKE — handed to the journal, never re-derived by it.
 *
 * Structurally the document `marks-journal.ts` writes; the two are declared
 * separately and joined at the call site in `main.ts`, so the compiler proves
 * they agree without this file importing the collection's name. Same pattern as
 * `repairHoldLookupFor`.
 */
export interface MarkSample {
  readonly tag: string
  readonly mode: Mode
  /** `MarkContext.markIndexToday`: 0 is the 09:15 window. */
  readonly mark: number
  readonly dateIst: string
  readonly ts: number
  /** The FORWARD every greek was taken at, not a last print. */
  readonly spot: number
  /**
   * Which source priced `spot` (six-playbooks spec F1): `parity`,
   * `index-carry`, `future` or `proxy`. Absent when the host was not told —
   * never a guess.
   */
  readonly forwardSource?: ForwardSource
  readonly netDelta: number
  readonly netGamma: number
  /** The corridor's `allowed` — what |netΔ| was compared against. */
  readonly band: number
  readonly totalPnl: number
  readonly marginSource: 'broker' | 'model'
  readonly reason: string
}

/** The intent a non-guard trigger has to hold long enough to earn a package. */
export interface ArmedIntent {
  readonly trigger: Trigger
  /** Trigger + the exact actions. A re-sized package is a NEW intent. */
  readonly shape: string
  readonly armedAt: number
}

/**
 * The triggers that do not wait.
 *
 * Each is an urgency execution at the gateway (§8) and each answers a condition
 * already confirmed by something stronger than a millisecond timer: the lock by
 * a multi-MARK streak (`guards.ts` §2), the margin trim by a broker figure, the
 * expiry settle by the calendar, the EOD sweep by the clock. `confirm_ms` on top
 * of those would delay the exits and defend nothing.
 */
const GUARD_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>(['lock', 'margin', 'expiry', 'eod'])

/** The wire's two work modes, weakest first. Absent on the wire is passive. */
const WORK_RANK: Readonly<Record<WorkMode, number>> = { passive: 0, urgent: 1 }

/**
 * IS THE WORKING PACKAGE ALREADY THIS GUARD'S OWN EXIT, WORKED AT LEAST AS HARD?
 *
 * Then the guard has nothing to preempt: what it wants is on the market. The
 * case is the flatten window. Every pass from 14:50 re-decides "passive flatten"
 * while the 14:50 package is still being worked, and sweeping that package
 * because a guard "wants the book" cancels the very orders the passive window
 * exists to work — or, on 2026-10-01, swept them one second after routing while
 * they were still unplaced and LATCHED, so the 14:55 urgent pass that should
 * have taken the resting hedge close off the market found the latch and did
 * nothing until the contract expired.
 *
 * Only the SAME EXIT (`sameExit`) at the same or a weaker work mode stands
 * down. The escalation — passive at 14:50 to urgent at 14:55 — is exactly what
 * must get through, and a different guard (a lock, a margin trim, a `dl-stop`
 * over a working `eod`) is a different reason with its own claim on the book.
 * The delta-lean exits read it too: the latched stop re-decides its own urgent
 * flatten every pass, and sweeping that would cancel the exit it is waiting on.
 * A package of the same trigger that simply rests is still taken back by
 * `rest_max_min`.
 */
function alreadyWorking(
  wp: SupervisorBookState['workingPackage'],
  trigger: Trigger,
  urgency: Urgency,
): boolean {
  const request = wp?.request ?? null
  if (request === null || request.actions.length === 0) return false
  if (!sameExit(request.trigger, trigger)) return false
  const wanted = WORK_RANK[workModeFor(urgency)]
  return request.actions.every((a) => WORK_RANK[a.workMode ?? 'passive'] >= wanted)
}

/**
 * IS A WORKING PACKAGE OF `working` THE SAME EXIT AS A DECISION OF `wanted`?
 *
 * The same trigger always is. Beyond that, a working DELTA-LEAN EXIT
 * (`DL_EXIT_TRIGGERS`) is re-decided under two other names, and under either
 * it is still the same close of the same legs — not a different reason with
 * its own claim on the book:
 *
 *   `dl-stop`  THE LATCHED NAME. `dl-target` and `dl-stuck` latch `dlStopped`
 *              on the flattening tick, so the very next pass re-decides their
 *              flatten as step 1's "stopped for the day"; the playbook frame's
 *              latched stop does the same over a working `dl-exit`.
 *   `eod`      THE CLOCK'S NAME (six-playbooks spec F8). A playbook exit still
 *              being worked at 14:50 is re-decided by the frame's clock step as
 *              the passive flatten. Swept, it would be cancelled only to be
 *              re-routed as the same close. The urgent 14:55 pass still takes
 *              it back, because work modes are ranked (`alreadyWorking`): an
 *              `eod` worked harder than the package on the market is an
 *              escalation of the same exit, not the same work.
 *
 * Not the other way round: a delta-lean exit over a working `eod` is a rule
 * that fired, with its own claim on the book (`#watchWhileWorking`).
 */
function sameExit(working: Trigger, wanted: Trigger): boolean {
  if (working === wanted) return true
  if (!DL_EXIT_TRIGGERS.has(working)) return false
  return wanted === 'dl-stop' || wanted === 'eod'
}

/**
 * The triggers whose size is measured against the corridor, and so the only
 * ones the obvious-breach escape can apply to. A scrap close carries no band
 * excess at all, and a shift is not phase R, so both are damped like any other
 * flicker.
 */
const PHASE_R_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>([
  'shed',
  'unwind',
  'recycle',
  'balance',
])

/**
 * THE DELTA-LEAN BOOK'S RISK-OFF TRIGGERS — the ones that must not wait, and
 * the ones that cancel a working add to get out.
 *
 * All four are emitted only AFTER a rule has already fired: the day target
 * after `dl_day_target` was made, the stuck exit after `dl_stuck_confirm_s` of
 * blocked-and-losing, the day backstop after the rupee floor — and the
 * PLAYBOOK EXIT, `dl-exit` (six-playbooks spec §4.5), after a playbook's stop,
 * trailing floor, take-profit, time exit or stage-2 abort has fired, or on legs
 * held with no trade open. `confirm_ms` on top of that re-asks a question the
 * engine has answered — and on a book at its SPAN cap the wait is the
 * difference between the stuck exit and the day backstop. A `dl-exit` that
 * queued behind a working add would leave a stop that fired unrouted while the
 * add it should be cutting kept filling; and the frame re-sends its close every
 * pass until the book is flat, which only works if its own working close is
 * recognised as the same exit (`sameExit`) rather than swept.
 *
 * The other three delta-lean triggers — `dl-open`, `dl-add`, `dl-neutral` — are
 * ADDS and are damped like any other decision; a playbook's staged opens and
 * pyramid adds are `dl-open` and `dl-add` too. Under spec D2 they can never
 * carry a close, so nothing they emit needs to jump a queue.
 *
 * `'eod'` is deliberately NOT here: it is already in `GUARD_TRIGGERS`, which
 * bypasses damping outright and preempts a working package on its own — except
 * one of these, which it stands down over (F8, `sameExit`).
 *
 * EXPORTED for the test that pins the set: a fifth name added here would
 * silently gain the fast path.
 */
export const DL_EXIT_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>([
  'dl-target',
  'dl-stuck',
  'dl-stop',
  'dl-exit',
])

/**
 * THE BULL-S BOOK'S EXITS — the triggers that cancel a working entry to get
 * out, exactly as `DL_EXIT_TRIGGERS` cancel a working add.
 *
 * A straddle's own stop, the book's target and loss cap, the operator's Close
 * book, and the expiry flat. Each is emitted only after `decideBullS` has
 * already confirmed it (the stop holds `bs_stop_confirm_s` on its own clock),
 * so a working entry that sat in front of it would leave a stop that fired
 * unrouted while the entry kept filling. `bs-expiry` is the engine's own hold
 * at the instant and carries no orders; it is here so that, should it ever
 * carry one, it outranks an entry too. `bs-entry` and `bs-rearm` are not exits.
 *
 * EXPORTED for the test that pins the set.
 */
export const BS_EXIT_TRIGGERS: ReadonlySet<Trigger> = new Set<Trigger>([
  'bs-stop',
  'bs-target',
  'bs-loss',
  'bs-flat',
  'bs-close',
  'bs-expiry',
])

const IST_OFFSET_MS = 330 * 60_000
const DAY_MS = 86_400_000

/** The IST calendar date of an instant — the desk's own house conversion. */
export function istDateOf(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** Minutes since IST midnight. 09:15 is 555, which is `SESSION_OPEN_MIN`. */
export function istMinuteOf(nowMs: number): number {
  const shifted = new Date(nowMs + IST_OFFSET_MS)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** Epoch ms of an IST calendar date — date arithmetic, not a moment in time. */
function utcDayMs(dateIso: string): number | null {
  const ms = Date.parse(`${dateIso}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Calendar days to expiry — 0 on expiry day, and NEGATIVE past it.
 *
 * Not clamped. A book still holding a contract whose expiry has passed has a
 * real problem (the master has dropped it and it can never be closed again), and
 * reporting `dte: 0` would have the engine flatten it at the next close as
 * though the settle window were still open. `decide` reads `dte === 0` exactly,
 * so an honest negative holds and the operator sees the legs rather than a
 * package that cannot route.
 */
export function dteOf(dateIst: string, expiry: string): number {
  const from = utcDayMs(dateIst)
  const to = utcDayMs(expiry)
  if (from === null || to === null) return 0
  return Math.round((to - from) / DAY_MS)
}

/** A whole session on the live desk's decision clock, 09:15 to 15:30: 375
 * minutes (`DECISION_CLOCK_CLOSE_MIN`, desk-engine session.ts). */
const SESSION_MINUTES = DECISION_CLOCK_CLOSE_MIN - SESSION_OPEN_MIN

/** Nothing on this desk trades a contract more than a year out; the bound is
 * here so a hand-edited expiry cannot spin the walk below forever. */
const MAX_EXPIRY_DAYS = 400

/**
 * TRADING MINUTES TO EXPIRY — sessions, not wall clock, with weekends and the
 * NSE holiday calendar taken out.
 *
 * THIS NUMBER SCALES EVERY THRESHOLD THE DELTA-LEAN BOOK HAS. The regime
 * detector prices a window's expected move as
 * `straddle × sqrt(windowMinutes / minutesToExpiry)` (`regime.ts` §1), so it is
 * under a square root and it divides: hand it CALENDAR minutes across a weekend
 * and the denominator is ~3x too big, the implied bar comes out ~1.7x too LOW,
 * and ordinary Monday noise clears a "trend" the book leans into with real size.
 * Nothing throws and no reason string looks wrong — it presents as a strategy
 * that keeps buying tops, which is why this is a function with its own tests
 * rather than three lines inside `#inputs`.
 *
 * The count is inclusive of both ends and measured to the 15:30 SETTLE, not to
 * the book's own 15:00 flat-by: the straddle it is compared against is priced to
 * expiry, so the window has to be quoted in the same clock.
 *
 * 15:30, NOT THE 15:40 F&O CLOSE. Since 3 Aug 2026 a contract trades and is
 * valued to 15:40, but this count scales the regime bar every delta-lean entry
 * clears. Measuring it to 15:40 would move when live books enter (~1.3% on the
 * bar), so it stays on the desk's decision clock until that is decided on its
 * own (`DECISION_CLOCK_CLOSE_MIN`, desk-engine session.ts).
 *
 *   - today contributes `DECISION_CLOCK_CLOSE_MIN − minuteOfDay`, clamped into the
 *     session — 0 before it has opened would be wrong, and 0 after the close is
 *     exactly right;
 *   - every whole day between contributes 375, or nothing if the calendar says
 *     the market is shut;
 *   - a `dateIst` that is itself a holiday contributes nothing, which is the
 *     honest answer rather than a special case.
 *
 * 0 for an expiry already past. `impliedWindowMove` answers `null` — never a
 * zeroed bar — on a 0, so a stale contract degrades to "no reading", which opens
 * nothing (`regime.ts` §2).
 */
export function tradingMinutesToExpiry(
  dateIst: string,
  minuteOfDay: number,
  expiry: string,
): number {
  const from = utcDayMs(dateIst)
  const to = utcDayMs(expiry)
  if (from === null || to === null || to < from) return 0
  if (to - from > MAX_EXPIRY_DAYS * DAY_MS) return 0
  let minutes = 0
  for (let day = from; day <= to; day += DAY_MS) {
    const iso = new Date(day).toISOString().slice(0, 10)
    if (!isTradingDay(iso)) continue
    if (day !== from) {
      minutes += SESSION_MINUTES
      continue
    }
    // Clamped into the session at BOTH ends: a pre-open minute does not buy the
    // book extra time, and a post-close one does not owe it negative time.
    const m = Math.min(Math.max(minuteOfDay, SESSION_OPEN_MIN), DECISION_CLOCK_CLOSE_MIN)
    minutes += DECISION_CLOCK_CLOSE_MIN - m
  }
  return minutes
}

/**
 * WHICH 5-MINUTE MARK AN INSTANT BELONGS TO, and whether it is the first tick of
 * it — the target lock's clock (spec §7).
 *
 * The lock's confirmation streak counts MARKS, not ticks: ten tick evaluations
 * inside one window advance it once, because it is the NEXT MARK re-printing
 * that proves a gap-open print was real (TCS 2026-06-19, `guards.ts` §2).
 * `markIndexToday` counts from the session open, so mark 0 is the 09:15 window
 * `lock_exclude_mark0` excludes.
 *
 * Its own class so `marks-journal.ts` (Task 15) can share the identical grid: a
 * journal that disagreed with the lock about which mark it is would write its
 * row against a different clock than the streak counts on.
 */
export class MarkClock {
  #date = ''
  #mark = -1
  readonly #venue: VenueSpec | null

  /**
   * `venue` absent or NSE is the session grid above, exactly. A 24x7 venue
   * (DX) marks every `MARK_STEP_MIN` around the clock, counted from the start
   * of its settlement day (12:00 UTC): NSE's clamp to 09:15-15:30 would freeze
   * the mark at 15:30 IST and a Delta book would journal nothing all night.
   */
  constructor(venue?: VenueSpec) {
    this.#venue = venue === undefined || venue.id === 'nse' ? null : venue
  }

  /** ADVANCES the clock: `isNewMark` is true for the first call in each mark. */
  next(nowMs: number): MarkContext {
    if (this.#venue !== null) {
      const day = this.#venue.dayKey(nowMs)
      const dayStart = Date.parse(`${day}T00:00:00.000Z`) - 12 * 60 * 60_000
      const index = Math.max(0, Math.floor((nowMs - dayStart) / (MARK_STEP_MIN * 60_000)))
      const isNew = day !== this.#date || index !== this.#mark
      this.#date = day
      this.#mark = index
      return { isNewMark: isNew, markIndexToday: index }
    }
    const date = istDateOf(nowMs)
    const mark = markOf(istMinuteOf(nowMs))
    const isNewMark = date !== this.#date || mark !== this.#mark
    this.#date = date
    this.#mark = mark
    return { isNewMark, markIndexToday: Math.max(0, (mark - SESSION_OPEN_MIN) / MARK_STEP_MIN) }
  }
}

/**
 * One line naming why a package's orders did not all trade — the distinct
 * skip reasons, then the route errors, capped so a row stays a row.
 */
export function refusalText(outcome: DecisionResponse): string {
  const seen = new Set<string>()
  for (const s of outcome.skips) if (s.reason.trim() !== '') seen.add(s.reason.trim())
  for (const e of outcome.routeErrors) if (e.trim() !== '') seen.add(e.trim())
  const text = [...seen].join('; ')
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

/** A contract nothing has ever quoted: unpriced, and honest about it. */
const NO_QUOTE: Quote = { bid: null, ask: null, ltp: null, asOf: 0 }

function quoteFor(chain: ChainSnap, strike: number, optType: OptType): Quote {
  const row = chain.strikes.find((s) => Math.abs(s.strike - strike) <= 1e-6)
  if (row === undefined) return NO_QUOTE
  return (optType === 'CE' ? row.ce : row.pe) ?? NO_QUOTE
}

/**
 * A hold this FILE decided on, as opposed to one an engine did.
 *
 * There is exactly one caller — a book whose `delta_lean_enabled` dial is on and
 * whose spot ring was never wired — and it exists so that book takes the same
 * path as any other hold: the mark's bookkeeping is persisted, nothing is armed,
 * nothing is routed. Running the RECENTER engine on it instead would steer a
 * delta-lean book with rules that are not its own.
 */
function heldByHost(reason: string, state: RuleState): EngineDecision {
  return {
    action: 'hold',
    trigger: 'none',
    reason,
    actions: [],
    stateAfter: state,
    markState: state,
    urgency: 'passive',
    makerQuote: false,
    creditCommit: null,
  }
}

/**
 * A package's identity for damping: the trigger and the exact actions — MINUS
 * the lean stamp, which was a clock reading and never part of what the
 * package does.
 *
 * THE BUG THIS ONCE FIXED WAS INVISIBLE AND TOTAL. `#damped` re-arms whenever
 * the shape changes, and the v1 delta-lean engine minted a fresh `leanId` on
 * every tick for a lean that did not exist yet — so the FIRST open of every
 * lean carried a different id on every tick, the shape never repeated,
 * `armedAt` reset four times a second and `confirm_ms` could never elapse.
 * With the preset's 1,000 ms confirm window that was a book which armed a
 * lean forever and opened nothing, with `intent armed` in the log and no
 * error anywhere.
 *
 * This engine has no lean and mints no such stamp, so the strip below is a
 * no-op on delta-lean's own opens — kept because `open.leanId` remains an
 * optional field on the action type generally, and stripping it is also the
 * RIGHT identity rather than merely the working one: two packages that buy
 * the same strikes in the same lots are the same package whichever stamp they
 * carry, and it is settled by `stateAfter` at the moment one actually routes.
 */
function shapeOf(decision: EngineDecision): string {
  const actions = decision.actions.map((a) => {
    if (a.op !== 'open' || a.leanId === undefined) return a
    const { leanId: _stamp, ...rest } = a
    return rest
  })
  return JSON.stringify([decision.trigger, actions])
}

/**
 * Lots in a quantity, FLOAT-CLEAN: (0.1 + 0.2) / 0.001 is 300.00000000000006,
 * which `Math.ceil` would call 301. Snapped to a grid far finer than any lot
 * (1e-6 of one) rather than to whole lots, so a quantity that really is part
 * of a lot keeps its fraction and is never rounded to 0.
 */
const lotsOf = (qty: number, lotSize: number): number =>
  lotSize > 0 ? roundToStep(qty / lotSize, LOT_GRID) : 0
const LOT_GRID = 1e-6

/**
 * The quantity a whole number of lots puts on the wire: `lots × lotSize` on
 * the venue's grid. NSE (step 1) is the old `Math.round(lots × lotSize)`
 * exactly; Delta (step 0.001) is BTC, where that `Math.round` was 0.
 */
export function wireQty(lots: number, lotSize: number, step: number): number {
  return roundToStep(lots * lotSize, step)
}

/**
 * The book's execution dials as the wire carries them — absent when off.
 *
 * POSITIVE OR ABSENT, never zero: `trancheLots: 0` tells the gateway to slice
 * into nothing, `chaseMaxMs: 0` to cross at once and `chaseCrossBufferPct: 0` to
 * cross with no reach at all. A dial at its off-state means "the gateway's own
 * default", and the only way to say that on the wire is to omit the key.
 */
export function workDialsOf(dials: Dials): WorkDials | undefined {
  // Whole lots, and the truncation happens BEFORE the test: `0.5` is not "half
  // a tranche", it is a dial nobody can trade, and a `trancheLots: 0` on the
  // wire is refused at the door — taking the whole package with it.
  const tranche = Math.trunc(dials.work_tranche_lots)
  const out: WorkDials = {
    ...(tranche > 0 ? { trancheLots: tranche } : {}),
    ...(dials.chase_max_ms > 0 ? { chaseMaxMs: dials.chase_max_ms } : {}),
    ...(dials.chase_cross_buffer_pct > 0
      ? { chaseCrossBufferPct: dials.chase_cross_buffer_pct }
      : {}),
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * AN URGENCY CLASS ONTO THE WIRE'S TWO WORK MODES (spec §8).
 *
 * The engine names one of three and the wire carries one of two, so one of them
 * has to be the absence:
 *
 *   `'passive'` -> `'passive'`   the gateway's PEG: join the touch, follow it,
 *                                cross once at `chase_max_ms`.
 *   `'urgent'`  -> `'urgent'`    cross now, whole size, worst-price bounded.
 *   `'ladder'`  -> absent        no work mode is stated at all.
 *
 * ── A DISCLOSED GAP, NOT A SILENT ONE ───────────────────────────────────────
 * `'ladder'` does NOT reach the gateway's blind ladder today. desk-api's engine
 * endpoint stamps `workMode: a.workMode ?? 'passive'` on every action of an
 * engine decision (`apps/api/src/routes/engine.ts:547`, `a.workMode ?? 'passive'`),
 * because absent-means-passive-first is that wire's own contract. So "no work
 * mode" is not a third behaviour — it is the FIRST one, pegged.
 *
 * The engine names three urgencies; the gateway implements two. `order-chaser.ts`
 * reads `workMode: 'passive'` as peg mode and ANYTHING ELSE as the blind ladder,
 * and `gateway.ts` additionally gives `'urgent'` freeze-sized tranches — the
 * biggest legal slice, so it arrives in the fewest rounds. That is precisely what
 * a residual flatten wants, so `'ladder'` maps onto `'urgent'` rather than onto
 * absence.
 *
 * Mapping it to `undefined` instead would make the 15:00 residual flatten worked
 * at the touch, crossing once at `chase_max_ms` — SOFTER than the 14:55 pass it
 * exists to escalate from, and the pass that is the last thing standing between
 * an always-flat book and an overnight carry. The three names are kept because
 * the journal and the tests reason about intent; they collapse here, at the one
 * place that knows what the wire can express.
 */
export function workModeFor(urgency: Urgency): WorkMode {
  return urgency === 'passive' ? 'passive' : 'urgent'
}

/** One action, translated to the wire and to the basis its fills fold against. */
interface Translated {
  readonly action: WireAction
  readonly basis: PackageBasis
}

/**
 * ONE OPEN, ON THE WIRE — and the only place its fields are written out.
 *
 * `#translate` used to build this object twice, once for a quoted sale and once
 * for everything else, and a field added to one spelling and not the other is
 * dropped in exactly half the packages. That is how the delta-lean `leanId`
 * would have gone missing on precisely the passive-peg adds the book places
 * most of (Task 9A), so the action is SPREAD through here instead: everything
 * `EngineAction`'s open variant carries and the wire understands travels by
 * construction, and the two callers differ only in price and work mode.
 *
 * EXPORTED so a test can pin the hop without booting a host: the stamp is
 * invisible end to end and nothing throws when it goes.
 */
export function wireOpen(
  action: Extract<EngineAction, { op: 'open' }>,
  instrument: string,
  qty: number,
  price: { readonly limitPrice: number; readonly workMode: WorkMode } | { readonly workMode?: WorkMode },
): WireAction {
  return {
    op: 'open',
    instrument,
    side: action.side,
    qty,
    // Conditional rather than `leanId: action.leanId`: `exactOptionalPropertyTypes`
    // is on repo-wide and an explicit `undefined` would travel as a JSON null,
    // which Mongo stores and reads back as a VALUE. Absent must stay absent.
    ...(action.leanId === undefined || action.leanId === '' ? {} : { leanId: action.leanId }),
    // Same conditional spelling, same reason: an add that lost its flag here is
    // invisible end to end — the shed simply starts being refused again.
    ...(action.add === true ? { add: true } : {}),
    ...price,
  }
}

/**
 * THE ORDER BUDGET'S VERDICT ON ONE PACKAGE OF OPENS (spec §8, E2).
 *
 * THE PER-SECOND CAP IS A BURST LIMIT, NOT A PACKAGE-SIZE LIMIT. The rail is
 * rate-limited on how fast orders arrive, and `dl_max_orders_s` says how many
 * may go in one second — but one decision legitimately emits more than that:
 * `dials.ts` says so in as many words ("a debit pair plus a theta offset" is
 * four), and opens must go whole or not at all, because half a debit pair is a
 * naked leg. The old reading, `min(perSecondRoom, minuteRoom, dayRoom) >=
 * orders`, therefore made a four-order package UNROUTABLE under a cap of two —
 * not held, not sliced, dropped on every pass forever, which is exactly what
 * the 09-21 session showed for NIFTY aggressive ("the order budget is spent"
 * every 2 s, `orders:4, room:2`, and the aggressive book trading less than the
 * conservative one).
 *
 * So the rules, in order:
 *   - `perSecond <= 0` is EXHAUSTED. Zero keeps meaning "this book opens
 *     nothing", as it always has; an operator who dialled 0 did not ask for an
 *     unbounded burst.
 *   - The per-MINUTE and per-DAY caps must have room for the WHOLE package.
 *     Those are genuine budgets and a package that does not fit is dropped.
 *   - A CLEAR second — nothing routed in the last 1 s — takes a package of any
 *     size. That is the burst.
 *   - A busy second still takes a package that fits the burst's remainder;
 *     otherwise the package WAITS for the window to clear (`hold-second`). It
 *     is held whole, not sliced, and at DEBUG rather than WARN: a package that
 *     waits half a second is pacing working, not an alarm.
 *
 * Exits never come here — the caller sends every close and resize regardless.
 */
export function openBudget(i: {
  readonly orders: number
  readonly routedLastSecond: number
  readonly perSecond: number
  readonly minuteRoom: number
  readonly dayRoom: number
}): 'route' | 'hold-second' | 'exhausted' {
  if (i.perSecond <= 0) return 'exhausted'
  if (i.minuteRoom < i.orders || i.dayRoom < i.orders) return 'exhausted'
  if (i.routedLastSecond === 0) return 'route'
  if (i.routedLastSecond + i.orders <= i.perSecond) return 'route'
  return 'hold-second'
}

/**
 * A DONE nothing of which routed — see `EngineHost.#skipped` for why it is a
 * refusal and why the shape is this narrow.
 *
 * The every-OPEN arm is the DELTA-LEAN engine's alone: it exists for the
 * phantom position (`stateAfter` stamping `dlOpenedMs`/`dlOpenSide` for a leg
 * that never opened), and the recenter engine has no such stamp to protect. A
 * recenter book whose all-open package desk-api skipped for `open: no mark for …`
 * settles as it always has — the same as a DONE with no fills — rather than
 * being rolled back to the mark like a 4xx. The switch/not-added arm is a
 * refusal on either engine: desk-api's own word that the row cannot trade,
 * whatever the package held.
 *
 * WHICH ENGINE is read off the PACKAGE, not off the dial: `request.trigger`
 * is `dl-*` if and only if the delta-lean path formed it (`types.ts`
 * `TRIGGERS` — the recenter engine never emits one), it travels with the
 * working package and so survives a restart and a replay. The dial as it
 * reads when the DONE lands is a different question — an INDETERMINATE post
 * is polled to its outcome later, possibly by another process, and
 * `delta_lean_enabled` flipped in between would judge the fold with the
 * engine that did NOT form the package.
 */
function allSkipped(request: DecisionRequest, outcome: DecisionResponse): boolean {
  if (outcome.fills.length > 0) return false
  if (request.actions.length === 0) return false
  if (outcome.skips.length < request.actions.length) return false
  const deltaLean = request.trigger.startsWith('dl-')
  return (
    (deltaLean && request.actions.every((a) => a.op === 'open')) ||
    outcome.skips.every((s) => /switched off for|is not added to/.test(s.reason))
  )
}

/**
 * Lots still owed on a working package.
 *
 * Derived rather than stored, and from the CURRENT book on purpose: desk-api
 * folds each fill into `desk-books` as it lands, so a partly-filled close names
 * a leg whose remaining lots ARE the remainder. An `open` is what is left of its
 * quantity, a `close` is whatever the book still holds, and a `resize` is the
 * distance still to travel. A leg that has gone contributes nothing, which is
 * the honest answer for an action there is no longer anything to do.
 */
export function pendingLotsOf(
  state: SupervisorBookState,
  book: ReadonlyArray<LegPosition>,
  lotSize: number,
): number {
  const wp = state.workingPackage
  if (wp === null) return 0
  const held = new Map(book.map((l) => [l.instrument, l]))
  let lots = 0
  for (const action of wp.remaining) {
    const leg = held.get(action.instrument)
    if (action.op === 'open') {
      lots += Math.ceil(lotsOf(action.qty, leg?.lotSize ?? lotSize))
      continue
    }
    if (leg === undefined) continue
    if (action.op === 'close') {
      lots += Math.ceil(leg.lots)
      continue
    }
    const size = leg.lotSize > 0 ? leg.lotSize : lotSize
    lots += Math.ceil(lotsOf(Math.abs(leg.lots * size - action.targetQty), size > 0 ? size : 1))
  }
  return lots
}

/** Push a filled sale onto the LIFO stack — newest LAST, merged by wing. */
function pushStack(
  stack: ReadonlyArray<RuleState['rcStack'][number]>,
  strike: number,
  optType: OptType,
  lots: number,
): RuleState['rcStack'] {
  if (!(lots > 0)) return [...stack]
  const at = stack.findIndex((s) => s.optType === optType && Math.abs(s.strike - strike) <= 1e-6)
  if (at < 0) return [...stack, { strike, optType, lots }]
  // MERGED IN PLACE, not appended: `unwindStack` reads a leg's sequence off the
  // index of its (strike, wing), so a second entry for one position would give
  // the same leg two sequences and order the stack against itself.
  const merged = [...stack]
  const prev = merged[at]
  if (prev !== undefined) merged[at] = { ...prev, lots: prev.lots + lots }
  return merged
}

/** A buy-back shrinks its entry, and pops it when nothing is left. */
function shrinkStack(
  stack: ReadonlyArray<RuleState['rcStack'][number]>,
  strike: number,
  optType: OptType,
  lots: number,
): RuleState['rcStack'] {
  const at = stack.findIndex((s) => s.optType === optType && Math.abs(s.strike - strike) <= 1e-6)
  if (at < 0 || !(lots > 0)) return [...stack]
  const entry = stack[at]
  if (entry === undefined) return [...stack]
  const left = entry.lots - lots
  const next = [...stack]
  if (left > 0) next[at] = { ...entry, lots: left }
  else next.splice(at, 1)
  return next
}

/** Two rule states that would write the same document. */
function sameRuleState(a: RuleState, b: RuleState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The tick a contract is quoted on when the master does not say.
 *
 * NSE options are 0.05 almost everywhere, and the consequence of being wrong is
 * bounded and visible: a limit off the grid is refused by the exchange, which is
 * an error in the log rather than a fill at a price nobody chose. The master IS
 * asked first (`tickSizeFor`); this is what a deployment without it gets.
 */
export class EngineHost {
  readonly #d: EngineHostDeps
  readonly #marks: MarkClock
  readonly #venue: VenueSpec
  /** The serial queue — one pass at a time. See `#serial`. */
  #running: Promise<void> = Promise.resolve()
  #intent: ArmedIntent | null = null
  /** The last margin read and how many FRESH BROKER ones preceded it in a row. */
  #lastMargin: { asOf: number; reads: number } | null = null
  #inFlight: string | null = null
  /**
   * THE CANCELS ALREADY FILED for the flight in `#askedFlight`: broker id ->
   * when it was asked.
   *
   * One cancel per ORDER, not one per tick: the request row is keyed by order
   * id and upserted (`routes/desk.ts`), so asking again changes nothing at the
   * broker — but it would put an HTTP round trip and a log line on every tick
   * for as long as the orders take to drain. Keyed by broker id rather than by
   * decision, because a decision is not one order: a cancelled tranche of a
   * close is followed by the next tranche under a new id, and a per-decision
   * latch is what left 1 Oct's hedge close resting. An id is asked again after
   * `CANCEL_REASK_MS`. Cleared when the flight clears.
   */
  #askedFlight: string | null = null
  #asked = new Map<string, number>()
  /** Set by `stop()`; nothing new is decided after it. See `stop`. */
  #stopping = false
  /**
   * WHEN EACH ORDER THIS BOOK ROUTED WENT OUT — the per-second and per-minute
   * halves of spec §8's order budget, which only the thing that routes can
   * count (Task 9B, R6).
   *
   * Epoch ms, one entry per WIRE ACTION (a four-leg package is four entries),
   * appended when the package is persisted and posted and pruned to the last
   * minute on every read. In memory on purpose: the caps are "how fast is this
   * book trading RIGHT NOW", and a restart genuinely has not traded yet.
   */
  #routedAt: number[] = []
  /** The IST date `#routedToday` counts within. '' = nothing routed yet. */
  #routedDay = ''
  /** Orders routed today, for `dl_max_orders_day`. Reset on a new IST date. */
  #routedToday = 0
  /**
   * The wiring fault has been reported once. A delta-lean book evaluates four
   * times a second, and the same ERROR four times a second is not an alarm.
   */
  #ringFaultLogged = false
  /**
   * "The order budget is spent" once a minute, with the count. A spent minute
   * or day budget persists across passes by definition, and the 09-21 page had
   * hundreds of identical lines for one book (spec E2).
   */
  readonly #budgetWarn = new Throttle()
  /**
   * The strategy switch is OFF and this book has said so (`switchedOn`). A
   * latch, not a counter: the WARN is on the way in, the INFO on the way out,
   * and the passes in between are silent — a book that is standing down is
   * evaluated every 2 s for as long as the switch stays off.
   */
  #standingDown = false
  /** The prod-fallback contracts last logged (`marksNote`), joined. '' = none. */
  #marksFallback = ''
  /**
   * What the page was last told the stand-down is for. The latch is one
   * incident, but the REASON follows the book: "holding, no new risk" while
   * it has legs, "not deciding" once the operator has closed them by hand,
   * and the page says what the book is doing NOW rather than what it was
   * doing when the switch first read off. `null` = not standing down.
   */
  #standDownReason: string | null = null
  /**
   * Until when a stand-down LATCHED BY DESK-API'S OWN WORD holds under a switch
   * the host cannot read. `#skipped` sets it when every action of a package
   * came back skipped "switched off for …": that is the gate saying the row
   * is off, and waiting for the next registry pass to confirm it would post
   * (and burn a seq on) one more package first. Under an UNKNOWN switch it
   * expires after a minute — a latch that never expired would wedge a book the
   * operator has since switched on, and one probe a minute is the price of not
   * knowing — and a switch that reads `true` releases it at once. 0 = no such
   * latch.
   */
  #skipLatchUntil = 0
  /**
   * "desk-api SKIPPED every action" once a minute, with the count. A gate that
   * skips this book's package will skip the next one too.
   */
  readonly #skipWarn = new Throttle()
  /**
   * "desk-api REFUSED the decision" once a minute, with the count. A 4xx that
   * persists is deployment skew and hits every book; see `#refused`.
   */
  readonly #refuseErr = new Throttle()

  constructor(deps: EngineHostDeps) {
    this.#d = deps
    this.#venue = deps.venue ?? venueFromEnv()
    this.#marks = deps.marks ?? new MarkClock(this.#venue)
  }

  /** The decision this book is waiting on — the 1 s poll loop's gate. */
  get inFlight(): string | null {
    return this.#inFlight
  }

  /** The intent still proving itself. Diagnostics: nothing branches on it. */
  get armedIntent(): ArmedIntent | null {
    return this.#intent
  }

  /**
   * STOP DECIDING — and the one thing that survives it.
   *
   * Called by `main.ts`'s shutdown BEFORE the drain, because clearing the timers
   * only stops passes that have not STARTED. A pass already inside `evaluate()`
   * is past that gate: it holds a decision, it has not saved it, and left alone
   * it would burn a `seq` and post a package with nobody watching. This flag is
   * what closes that window, and it is checked twice — at the top of a pass and
   * again immediately before the save-and-post — because everything between the
   * two is an `await`.
   *
   * WHAT IT DOES NOT STOP is a package that is already PERSISTED. Once `#route`
   * has written `inFlight` to Mongo, the id is burnt and the exactly-once
   * property is that this process posts it; abandoning it there would leave a
   * decision the next boot has to replay for no reason at all. So a pass in
   * flight finishes, and `drain()` waits for it — but no NEW decision is formed.
   *
   * There is no un-stop. A process that has been told to stop is a process that
   * is going away; `main.ts` builds fresh hosts on the next boot.
   */
  stop(): void {
    this.#stopping = true
  }

  /**
   * One full pass: mark the book, decide, damp, route, fold.
   *
   * SERIALISED. Two evaluations of one book must never interleave — they would
   * read the same `seq` and both post — so every pass queues behind the one
   * running. A tick storm therefore costs a queue, not a race; `main.ts` calls
   * this on a coalesced timer rather than once per tick.
   */
  async evaluate(): Promise<void> {
    return await this.#serial(async () => {
      await this.#evaluateOnce()
    })
  }

  /**
   * Ask desk-api about the decision this book is waiting on. Driven at 1 s by
   * `main.ts` while `inFlight` is set, and immediately by a fill nudge.
   */
  async pollInFlight(): Promise<void> {
    return await this.#serial(async () => {
      const state = await this.#d.store.load(this.#d.tag, this.#d.mode)
      this.#inFlight = state.inFlight
      if (state.inFlight === null) return
      await this.#resolve(state)
    })
  }

  /**
   * desk-api says a fill landed on this book (`engine-notify.ts`). The nudge
   * carries no instructions — the truth is re-read from Mongo — so this is
   * simply "ask again, now". Fire-and-forget: the notifier must not wait on it.
   */
  onFillNudge(): void {
    void this.pollInFlight().catch(() => undefined)
  }

  /**
   * Boot: re-post an `inFlight` decision VERBATIM before anything else decides.
   *
   * The crash this recovers from may have happened either side of the post, so
   * the replay is both "what happened to my package?" and, if the answer is that
   * it never arrived, the package itself. That is safe in one direction only —
   * the id is idempotent at desk-api — which is why the request is replayed as
   * it was written rather than rebuilt from today's market.
   */
  async resolveInFlightOnBoot(): Promise<void> {
    const state = await this.#d.store.load(this.#d.tag, this.#d.mode)
    this.#inFlight = state.inFlight
    if (state.inFlight === null) return
    this.#d.log.warn('resolving the decision this book was left holding', {
      tag: this.#d.tag,
      mode: this.#d.mode,
      decisionId: state.inFlight,
    })
    await this.pollInFlight()
  }

  /** Everything queued has finished. For tests and for a clean shutdown. */
  async drain(): Promise<void> {
    let seen: Promise<void> | null = null
    while (seen !== this.#running) {
      seen = this.#running
      await seen
    }
  }

  // ------------------------------------------------------------ the queue

  async #serial<T>(fn: () => Promise<T>): Promise<T> {
    const queued = this.#running.then(fn, fn)
    // The tail never rejects: a rejected tail would wedge every later tick, poll
    // and nudge behind one bad pass. The CALLER still sees the error.
    this.#running = queued.then(
      () => undefined,
      () => undefined,
    )
    return await queued
  }

  // ------------------------------------------------------------- the pass

  async #evaluateOnce(): Promise<void> {
    const { tag, mode, log } = this.#d
    // CHECK ONE OF TWO (`stop`). A pass that was queued behind another when the
    // signal landed must not start; the second check is below, because
    // everything between here and the route is an await.
    if (this.#stopping) {
      log.debug('stopping — this book decides nothing further', { tag, mode })
      return
    }
    const chain = this.#d.snap()
    if (chain === null) {
      // No forward, no chain. A book with no market is not a book that is flat,
      // and deciding off the last one seen is how a frozen quote routes an order
      // (`chain-view.ts` §4).
      log.debug('no chain snapshot — nothing to decide on', { tag, mode })
      return
    }

    const state = await this.#d.store.load(tag, mode)
    this.#inFlight = state.inFlight
    if (state.inFlight !== null) {
      // ONE POLLER, and it is not this one. `pollInFlight` runs on its own 1 s
      // timer and on every fill nudge; a second re-post from here would put two
      // requests on the wire per tick for one decision, each racing the other's
      // fold. What this pass still does is EVALUATE — the mark has to count
      // (see `#watchWhileWorking`).
      await this.#watchWhileWorking(state, chain)
      return
    }

    const dials = this.#d.dials()
    const nowMs = this.#d.now()
    const inputs = await this.#inputs(state, chain, dials, nowMs)
    /**
     * THE STRATEGY SWITCH (`EngineHostDeps.switchedOn`). Read AFTER the
     * in-flight branch above — a working package must still be watched and
     * cancellable whatever the switch says — and after the book, because the
     * answer depends on whether there is anything held.
     *
     * A switched-off FLAT book idles here, BEFORE the mark is consumed: no
     * `#marks.next`, no journal row, no `persistRuleState`, no decision. That
     * is the E3 storm case — every observed storm was a legless phantom
     * deciding into desk-api's refusal — and the idle is the whole fix. A
     * switched-off book WITH legs goes on to decide, so its cuts can route,
     * and only a package carrying an open is held (below).
     */
    const read = this.#d.switchedOn?.() ?? null
    const on =
      read === null && this.#standingDown && nowMs < this.#skipLatchUntil ? false : read
    if (on === false) {
      if (inputs.legs.length === 0) {
        this.#standDown(`switched off for ${mode} — not deciding`)
        return
      }
    } else {
      this.#resume(read)
    }
    const markCtx = this.#marks.next(nowMs)
    const decision = this.#decide(inputs, dials, state, markCtx)
    const reason = this.#withMarks(inputs, decision)
    this.#journal(markCtx, inputs, dials, reason)
    this.#tellReason(dials, reason)

    if (
      on === false &&
      decision.action !== 'hold' &&
      decision.actions.some((a) => a.op === 'open')
    ) {
      // NO NEW RISK. The package has an open in it and the switch is off:
      // desk-api would refuse it (and only admits packages whose every action
      // reduces the book), so it is not formed — but the mark happened, and
      // its bookkeeping is kept exactly as a damped pass keeps it.
      this.#standDown(`switched off for ${mode} — holding, no new risk`)
      await this.#persistRuleState(state, decision.markState)
      return
    }

    if (decision.action === 'hold') {
      if (this.#intent !== null) {
        log.debug('the armed intent no longer wants to act', {
          tag,
          mode,
          was: this.#intent.trigger,
          reason: decision.reason,
        })
        this.#intent = null
      }
      // The state moves on a HOLD too — the lock's streak advances and disarms
      // on marks that do nothing, and the anchor lags — and losing that is a
      // book that never confirms anything. On a hold `markState` and
      // `stateAfter` are the same value (`types.ts`), so this is the same write
      // either way; it is spelled `markState` so every non-routing path in this
      // file reads identically.
      await this.#persistRuleState(state, decision.markState)
      log.debug('hold', { tag, mode, trigger: decision.trigger, reason: decision.reason })
      return
    }

    const guard = GUARD_TRIGGERS.has(decision.trigger)
    /**
     * A BULL-S BOOK IS NEVER DAMPED. `decideBullS` owns its own timing: a stop
     * has held `bs_stop_confirm_s` before it is emitted, and an entry is the
     * crossing it saw ONCE — its `markState` spends that crossing, so a pass
     * damped by `confirm_ms` would persist the crossing as seen and the entry
     * would never be proposed again. `cooldown_s` would likewise sit a stop
     * behind the entry it is protecting. One package at a time still holds
     * (`pendingLots` blocks a new entry inside the engine).
     */
    const undamped = guard || dials.bs_enabled
    if (!undamped) {
      if (!this.#damped(decision, state, inputs, dials, nowMs)) {
        // DAMPED, NOT IGNORED. The actions did not happen; the MARK did, and
        // the counters that moved with it — the lock's streak and its
        // dip-disarm above all — have to survive a pass that routes nothing, or
        // the streak counts non-consecutive marks (`types.ts`'s `markState`).
        await this.#persistRuleState(state, decision.markState)
        return
      }
    } else if (this.#intent !== null) {
      log.info('a guard preempts the armed intent', {
        tag,
        mode,
        guard: decision.trigger,
        preempted: this.#intent.trigger,
      })
    }
    this.#intent = null
    /**
     * CHECK TWO OF TWO, and this is the one that matters (`stop`).
     *
     * Everything above is awaits — the book read, the repair-hold read, the
     * margin — so a signal that landed while this pass was reading finds it
     * here, holding a fully-formed package and one line from burning a `seq`.
     * Past this point the decision is PERSISTED and this process owns posting
     * it; before it, the package simply never existed. The mark still counts.
     */
    if (this.#stopping) {
      log.warn('stopping — a formed package is NOT routed; the book is unchanged', {
        tag,
        mode,
        trigger: decision.trigger,
        reason: decision.reason,
      })
      await this.#persistRuleState(state, decision.markState)
      return
    }
    // A package that never leaves this process — nothing routable in it, one
    // contract named twice, a lost compare-and-set — still has to leave the
    // mark's bookkeeping behind.
    if (!(await this.#route(state, decision, inputs, dials, nowMs))) {
      await this.#persistRuleState(await this.#d.store.load(tag, mode), decision.markState)
    }
  }

  /**
   * Latch the stand-down: one WARN on the way in, the armed intent dropped (a
   * trigger that was proving itself under a switch that is now off has nothing
   * to prove), and the page told. Idempotent on the latch — called on every
   * pass the switch is off — but NOT on the reason: a book that stood down
   * holding legs and has since gone flat is re-told to the page, without a
   * second WARN, because the incident is the same and only the book changed.
   */
  #standDown(reason: string): void {
    if (this.#standingDown) {
      if (this.#standDownReason !== reason) {
        this.#standDownReason = reason
        this.#d.onStandDown?.(reason)
      }
      return
    }
    this.#standingDown = true
    this.#standDownReason = reason
    this.#intent = null
    this.#d.log.warn('the strategy switch is OFF — this book takes no new risk', {
      tag: this.#d.tag,
      mode: this.#d.mode,
      reason,
    })
    this.#d.onStandDown?.(reason)
  }

  /**
   * Unlatch and tell the page. What is SAID depends on what let the latch go:
   * a switch that read `true` is the operator turning the book on, and that
   * is one INFO; a `null` is nobody reading it — the skip latch's minute is
   * up under an unreadable or missing strategy row and the next package is a
   * probe — and saying "ON again" there would be a false INFO once a minute,
   * ahead of the two true WARNs the probe's skip brings back.
   */
  #resume(read: boolean | null): void {
    if (!this.#standingDown) return
    this.#standingDown = false
    this.#standDownReason = null
    this.#skipLatchUntil = 0
    const ctx = { tag: this.#d.tag, mode: this.#d.mode }
    if (read === true) {
      this.#d.log.info('the strategy switch is ON again — deciding', ctx)
    } else {
      this.#d.log.debug(
        'the strategy switch is UNKNOWN — the stand-down lets go and the next package is a probe',
        ctx,
      )
    }
    this.#d.onStandDown?.(null)
  }

  /**
   * A pass while a package is still working — and the two reasons to take it
   * back off the market (spec §8).
   *
   * The engine is still run: marking, greeks and the guard tiers keep evaluating
   * under a working package, which is what lets a guard SEE the book. It does
   * not route — a second package against orders that are still out would
   * double-close legs the first is already closing — so preemption is
   * "cancel first, THEN act", and the two halves land on different passes:
   *
   *   this pass   cancels every order still working under the flight;
   *   1 s later   `pollInFlight` reads the terminal outcome and folds whatever
   *               filled before the cancel landed;
   *   the tick after that   decides against the book that really exists.
   *
   * Sequencing it across passes rather than cancelling-and-routing in one is
   * what makes it safe: the replacement package is sized off a book that has
   * already absorbed the cancelled package's partial fills, so a guard cannot
   * close more than the book holds.
   *
   * WHAT INVALIDATES A QUOTE THAT NOBODY IS PREEMPTING: `rest_max_min` and a
   * one-strike move in the underlying (`#invalidated`). A maker quote is placed
   * at a model price with pegging off, so it does not follow the market — after
   * a strike-step move it is a price from a different book, and re-deciding is
   * strictly better than resting at it.
   *
   * WITHOUT A CANCEL PATH WIRED this is exactly what ticket 14 shipped: a loud
   * ERROR and nothing routed.
   *
   * ── WHICH RAIL THIS RUNS ON AT ALL ──────────────────────────────────────────
   * Only while an `inFlight` decision is held — and desk-api makes a package
   * async on the PAPER rail only (`service.ts:837`). A LIVE engine decision
   * settles `DONE` at route time, so this pass never runs for one and neither
   * the guard preemption nor the invalidation below reaches a live resting
   * order: the gateway's chaser owns those. Both are also reached by anything
   * desk-api reports `WORKING`/`ROUTING`, so they arrive on the live rail for
   * free the day it goes async. Until then it is a disclosed gap, not a
   * silent one (`#quoteAt`, and the ticket 15 report §8).
   */
  async #watchWhileWorking(state: SupervisorBookState, chain: ChainSnap): Promise<void> {
    const { tag, mode, log } = this.#d
    const dials = this.#d.dials()
    const nowMs = this.#d.now()
    const inputs = await this.#inputs(state, chain, dials, nowMs)
    const markCtx = this.#marks.next(nowMs)
    const decision = this.#decide(inputs, dials, state, markCtx)
    const reason = this.#withMarks(inputs, decision)
    this.#journal(markCtx, inputs, dials, reason)
    this.#tellReason(dials, reason)
    // `markState`, never `stateAfter`: nothing is routed under a working
    // package, so the guard's streak and the anchor step are all that happened.
    await this.#persistRuleState(state, decision.markState)

    /**
     * WHAT THE WORKING PACKAGE IS TO THIS DECISION. The same exit worked harder
     * than it is on the market — the 14:55 urgent flatten over the 14:50
     * passive one, a passive playbook exit turned urgent, the clock's urgent
     * pass over a working playbook exit (F8) — is an ESCALATION: the designed
     * path, said at WARN and named as what it is. Anything else that pre-empts
     * is a different reason with its own claim on the book.
     */
    const working = state.workingPackage?.request?.trigger ?? null
    const escalation =
      working === null
        ? null
        : !sameExit(working, decision.trigger)
          ? null
          : working === decision.trigger
            ? `its own working package to ${workModeFor(decision.urgency)}`
            : `the working ${working} package to ${workModeFor(decision.urgency)} — the same exit`

    const guard =
      decision.action !== 'hold' &&
      GUARD_TRIGGERS.has(decision.trigger) &&
      !alreadyWorking(state.workingPackage, decision.trigger, decision.urgency)
    if (guard) {
      // An escalation is the designed path and says so at WARN; any other guard
      // finding a working book is the unplanned preemption and stays at ERROR.
      await this.#preempt(
        state,
        escalation !== null
          ? `the ${decision.trigger} guard escalates ${escalation}`
          : `a ${decision.trigger} guard wants this book`,
        decision.reason,
        inputs.pendingLots,
        escalation !== null ? 'warn' : 'error',
      )
      return
    }

    /**
     * A DELTA-LEAN CUT PREEMPTS THE ADD THAT IS STILL WORKING (spec §8, R1).
     *
     * The engine used to hold its whole pass while `pendingLots > 0`, so at nine
     * delta-lots the per-lean stop could not be emitted AT ALL — the one
     * scenario it exists for. Task 9B moved the two lean cuts ABOVE that hold,
     * which makes the cut arrive here, on a pass that routes nothing, with an
     * add tranche still out. This is the other half: cancel the add, and the
     * tick after the flight goes terminal decides the cut against the book that
     * really exists (see this method's header for why the two halves are on
     * different passes).
     *
     * WARN, not ERROR: a guard finding a working book is a preemption nobody
     * planned for, while this is the designed behaviour of a book that adds on
     * profit and cuts on drawdown. Logging it at ERROR would put an alarm on
     * every ordinary cut.
     */
    // Its own working exit is not an add to preempt — see `alreadyWorking`.
    // Worked SOFTER than the exit now wants (a playbook's passive exit turned
    // urgent after 60 s, spec §4.5), it is taken back as the escalation it is.
    const exiting =
      decision.action !== 'hold' &&
      ((dials.delta_lean_enabled && DL_EXIT_TRIGGERS.has(decision.trigger)) ||
        (dials.bs_enabled && BS_EXIT_TRIGGERS.has(decision.trigger))) &&
      !alreadyWorking(state.workingPackage, decision.trigger, decision.urgency)
    if (exiting) {
      await this.#preempt(
        state,
        escalation !== null
          ? `the ${decision.trigger} escalates ${escalation}`
          : `a ${decision.trigger} preempts the working add — exits outrank adds`,
        decision.reason,
        inputs.pendingLots,
        'warn',
      )
      return
    }

    const stale = this.#invalidated(state, chain, dials, nowMs)
    if (stale !== null) {
      await this.#preempt(state, stale, decision.reason, inputs.pendingLots, 'warn')
      return
    }

    log.debug('holding under a working package', {
      tag,
      mode,
      decisionId: state.inFlight,
      pendingLots: inputs.pendingLots,
      reason: decision.reason,
    })
  }

  /**
   * Has this working package stopped being the package we would place now?
   *
   * Both tests are measured off what was PERSISTED when the package formed
   * (`state-store.ts`'s `formedAt`/`formedSpot`), not off this process's memory:
   * the orders rest at the gateway and outlive a supervisor restart, so a clock
   * that restarted with the process would give a twenty-minute-old quote another
   * ten minutes and would forget a move that had already happened.
   *
   * A package written before those fields existed reports `0` and is never
   * invalidated — it is still polled to a terminal outcome and a guard can still
   * preempt it. That is the honest reading of "this clock is not running".
   */
  #invalidated(
    state: SupervisorBookState,
    chain: ChainSnap,
    dials: Dials,
    nowMs: number,
  ): string | null {
    const wp = state.workingPackage
    if (wp === null) return null

    const restMs = Math.max(0, dials.rest_max_min) * 60_000
    if (restMs > 0 && wp.formedAt > 0 && nowMs - wp.formedAt >= restMs) {
      return `it has rested past rest_max_min (${String(dials.rest_max_min)} min)`
    }
    // The STEP, not a fraction of it: the ladder is what a package is priced and
    // sized on, so one whole step is the smallest move that would have produced
    // a different package.
    if (wp.formedSpot > 0 && chain.step > 0 && Math.abs(chain.spot - wp.formedSpot) >= chain.step) {
      return (
        `the underlying has moved a full strike step (${String(wp.formedSpot)} -> ` +
        `${String(chain.spot)}, step ${String(chain.step)})`
      )
    }
    return null
  }

  /**
   * Take the working package off the market so the next pass can decide freshly.
   *
   * SWEEPS EVERY PASS it is called on, and files a cancel only for a broker id
   * it has not asked about in the last `CANCEL_REASK_MS` (`#asked`). There is
   * no per-decision latch: a decision is not one order.
   *
   * Cancelling an EXIT may still let its later tranches go out: a short terminal
   * tranche halts an OPEN but ADVANCES a close, deliberately
   * (`gateway.ts:decideTrancheStep` rule 3 — abandoning half an exit is the
   * worse error). The decision stays non-terminal until every tranche is, so
   * this host routes nothing meanwhile — and because it keeps sweeping, the
   * next tranche is cancelled as soon as it is placed under its new id, rather
   * than resting behind a latch set on the first one (2026-10-01's shape: the
   * hedge close was tranched 60 + 20).
   */
  async #preempt(
    state: SupervisorBookState,
    why: string,
    reason: string,
    pendingLots: number,
    level: 'warn' | 'error',
  ): Promise<void> {
    const { tag, mode, log } = this.#d
    const decisionId = state.inFlight
    if (decisionId === null) return
    const ctx = { tag, mode, decisionId, pendingLots, reason }

    if (this.#d.cancelWorking === undefined) {
      log.error(
        'A GUARD WANTS THIS BOOK WHILE A PACKAGE IS WORKING — it is not routed, and there is ' +
          'NO CANCEL PATH WIRED to take the package off the market',
        { ...ctx, why },
      )
      return
    }
    if (this.#askedFlight !== decisionId) {
      this.#askedFlight = decisionId
      this.#asked = new Map()
    }
    const nowMs = this.#d.now()
    const skip = new Set<string>()
    for (const [id, at] of this.#asked) {
      if (nowMs - at < (this.#d.cancelReaskMs ?? CANCEL_REASK_MS)) skip.add(id)
    }

    let outcome: CancelOutcome
    try {
      outcome = await this.#d.cancelWorking(decisionId, skip)
    } catch (err) {
      // Nothing was filed: the next pass tries again, because a package nobody
      // could cancel is one a guard is still waiting behind.
      log.error('the working package could NOT be cancelled — the guard is still waiting', {
        ...ctx,
        why,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    for (const id of outcome.asked ?? []) this.#asked.set(id, nowMs)

    if (outcome.failed > 0) {
      // A PARTIAL SWEEP IS NOT A CANCELLED PACKAGE. The refused ids are not in
      // `asked`, so the next pass files them again.
      log.error('only PART of the working package could be cancelled — orders are still out', {
        ...ctx,
        why,
        cancelRequests: outcome.requested,
        cancelFailures: outcome.failed,
      })
      return
    }

    if (outcome.requested === 0) {
      // Nothing NEW to file: the cancels are already in, or the orders are
      // between placements (`unplaced`), or they went terminal. The next pass
      // looks again; none of it is news an operator needs above debug.
      log.debug('nothing new to cancel this pass — waiting for the package to go terminal', {
        ...ctx,
        why,
        unplaced: outcome.unplaced ?? 0,
        alreadyAsked: skip.size,
      })
      return
    }

    log[level](
      `${why} — cancelling the working package first, then deciding again on what the book ` +
        'really holds',
      { ...ctx, why, cancelRequests: outcome.requested },
    )
  }

  /**
   * The decision's reason with the marks venue named (`EngineHostDeps.
   * marksNote`), for the journal and the page — never for what is routed.
   */
  #withMarks(inputs: EngineInputs, decision: EngineDecision): string {
    const read = this.#d.marksNote
    if (read === undefined) return decision.reason
    const contracts: Array<{ strike: number; optType: OptType }> = inputs.legs.map((l) => ({
      strike: l.strike,
      optType: l.optType,
    }))
    for (const a of decision.actions) {
      if (a.op === 'open') contracts.push({ strike: a.strike, optType: a.optType })
    }
    let marks: ReturnType<NonNullable<EngineHostDeps['marksNote']>>
    try {
      marks = read(contracts)
    } catch {
      return decision.reason
    }
    if (marks === null) {
      // Production-marked (the row moved off the demo rail): nothing to name.
      this.#marksFallback = ''
      return decision.reason
    }
    const { tag, mode, log } = this.#d
    const fallback = marks.fallback.join(', ')
    if (fallback !== this.#marksFallback) {
      if (fallback !== '') {
        log.warn(`marks: prod fallback on ${fallback} — no fresh Delta demo quote`, {
          tag,
          mode,
          instruments: marks.fallback,
        })
      } else {
        log.info('marks: every contract this book holds or trades is on Delta demo again', {
          tag,
          mode,
        })
      }
      this.#marksFallback = fallback
    }
    return decision.reason === '' ? marks.note : `${decision.reason} · ${marks.note}`
  }

  /** The pass's reason to the page, for a BULL-S book (`EngineHostDeps.onDecision`). */
  #tellReason(dials: Dials, reason: string): void {
    if (!dials.bs_enabled) return
    try {
      this.#d.onDecision?.(reason)
    } catch {
      // The page's line is the least important thing here; never a decision's cost.
    }
  }

  /** The flight is over: nothing it asked to cancel matters any more. */
  #forgetCancels(): void {
    this.#askedFlight = null
    this.#asked = new Map()
  }

  /**
   * Hand this mark to the journal, once per 5-minute window.
   *
   * Inside the evaluation because the numbers are the ones the rules used: a row
   * re-measured afterwards is a different book. Synchronous and guarded — the
   * journal is the least important thing this process does, and it may never
   * take a decision down.
   */
  #journal(markCtx: MarkContext, inputs: EngineInputs, dials: Dials, reason: string): void {
    const onMark = this.#d.onMark
    if (onMark === undefined || !markCtx.isNewMark) return
    try {
      const cor = corridor(inputs, dials)
      const forwardSource = this.#d.forwardSource?.()
      onMark({
        tag: this.#d.tag,
        mode: this.#d.mode,
        mark: markCtx.markIndexToday,
        dateIst: inputs.dateIst,
        ts: inputs.nowMs,
        spot: inputs.chain.spot,
        // Beside the spot it names: books on one chain are priced off
        // different forwards now, and a row's spot means nothing without it.
        ...(forwardSource === undefined ? {} : { forwardSource }),
        netDelta: cor.netDelta,
        netGamma: cor.netGamma,
        band: cor.allowed,
        totalPnl: totalPnl(inputs),
        marginSource: inputs.margin.source,
        reason,
      })
    } catch (err) {
      this.#d.log.warn('the mark could not be journalled — the decision is unaffected', {
        tag: this.#d.tag,
        mode: this.#d.mode,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ------------------------------------------------------- the two engines

  /**
   * WHICH ENGINE DECIDES THIS BOOK — one dial, read fresh every pass.
   *
   * `delta_lean_enabled` selects a whole second decide path rather than a tier
   * of the first (`desk-engine/index.ts`), and it is the ONLY thing that
   * selects it: a book without the dial takes `decide()` down to the same line
   * of code it always did, which is what keeps the 1,152 parity marks meaning
   * something.
   *
   * The five fields `DeltaLeanInputs` adds beyond an `EngineInputs` are each
   * stated here rather than derived downstream — the first four because no
   * snapshot of a chain can carry them, `expiry` so the engine reads the BOOK's
   * contract date as a field of its own rather than off whatever chain it is
   * handed:
   *
   *   `ring`             the host's shared spot buffer, one per SYMBOL.
   *   `minutesToExpiry`  TRADING minutes — see `tradingMinutesToExpiry`, and
   *                      read its docstring before changing anything here.
   *   `ordersThisMinute` this book's own routed count over the last 60 s of
   *                      REAL time, which is the engine's half of the order
   *                      budget (`dl_max_orders_min`); the per-second and
   *                      per-day halves are this host's alone (`#budgetRoom`,
   *                      ruled on by `openBudget`).
   *   `spotAsOf`         the INDEX feed's own clock, never the chain's.
   *   `expiry`           the book's contract date, off the snapped chain —
   *                      the registry row's `expiry`, read by a hold book.
   *
   * And three more that only the PLAYBOOK FRAME reads (six-playbooks spec F7),
   * optional on the type and always stated here, absence meaning UNKNOWN:
   *
   *   `inFlight`         a package on the wire, from the book state this pass
   *                      loaded — see the field below.
   *   `prevClose`        the index's previous close, off `md.spot` (F6).
   *   `forwardSource`    which source priced `chain.spot` (F1).
   *
   * Then `pb_playbook` picks the frame: 1-6 is a playbook (spec §4.1), 0 the
   * delta-lean controller. Both decide off the same inputs, and everything
   * this host does with the decision — damping, the fast path, pre-emption,
   * the budget, the fold — is the same for either.
   *
   * `state.dlDayRealized` is deliberately NOT among them: it is state, zeroed
   * by the engine's own `rollDay` in the same write that rolls `dlDayStarted`,
   * and read by nothing in the engine's rules — only by `#settle` and by
   * whoever reads the ledger.
   */
  #decide(
    inputs: EngineInputs,
    dials: Dials,
    book: SupervisorBookState,
    markCtx: MarkContext,
  ): EngineDecision {
    const state = book.ruleState
    // THE BULL-S PATH, first: `bs_enabled` names its own engine, whatever the
    // other two dials say (`ENGINE_SWITCH_DIALS` keeps them exclusive).
    if (dials.bs_enabled) return decideBullS(this.#bullSInputs(inputs), dials, state, markCtx)
    if (!dials.delta_lean_enabled) return decide(inputs, dials, state, markCtx)

    const ring = this.#d.ring
    if (ring === undefined) {
      // A dial that says "delta lean" and a deployment with no index feed wired
      // to this host. NOT a recenter book — steering it with rules that are not
      // its own would sell premium against a book nobody sized that way — so it
      // holds and says so, once.
      if (!this.#ringFaultLogged) {
        this.#ringFaultLogged = true
        this.#d.log.error(
          'delta_lean_enabled is ON for this book but NO SPOT RING is wired to its host. It is ' +
            'NOT being steered — not by the delta-lean controller, which has no tape to read, ' +
            'and not by the recenter engine, whose rules are not this book\'s. Wire the index ' +
            'feed, or turn the dial off.',
          { tag: this.#d.tag, mode: this.#d.mode },
        )
      }
      return heldByHost(
        'delta_lean_enabled, but no spot ring is wired to this host — the book is NOT steered',
        state,
      )
    }

    const forwardSource = this.#d.forwardSource?.()
    const dl: DeltaLeanInputs = {
      ...inputs,
      ring,
      minutesToExpiry:
        this.#d.minutesToExpiry?.() ??
        tradingMinutesToExpiry(inputs.dateIst, inputs.minuteOfDay, inputs.chain.expiry),
      ordersThisMinute: this.#routedWithin(60_000, inputs.nowMs),
      // 0 = the epoch, which reads as infinitely stale and refuses OPENS (R2)
      // while still letting cuts through. That is the right answer for a
      // deployment that never said when the tape was last seen.
      spotAsOf: this.#d.spotAsOf?.() ?? 0,
      // The REGISTRY ROW's expiry: `main.ts` snaps this book's chain on
      // `runtime.book.expiry`, so the snapped contract's date is the row's —
      // the same source `minutesToExpiry` reads above. A hold book
      // (`dl_hold_to_expiry`) runs its clock ladder from this date on.
      expiry: inputs.chain.expiry,
      // A package this book has on the wire — posted and not yet terminal —
      // whatever `pendingLots` reads off the book. The paper fold can land a
      // fill in `desk-books` before desk-api says DONE, and a frame that read
      // that window as idle would stage its next step on a package that is not
      // over (spec F7). Off the state THIS pass loaded, never a cached flag.
      inFlight: book.inFlight !== null || book.workingPackage !== null,
      prevClose: this.#d.prevClose?.() ?? null,
      // Conditional, never `undefined`: absent IS the unknown (F1).
      ...(forwardSource === undefined ? {} : { forwardSource }),
    }
    if (dials.pb_playbook > 0) {
      // The seam answers whenever it is wired; it never answers `undefined`.
      return (
        this.#d.decidePlaybook?.(dl, dials, state, markCtx) ??
        decidePlaybook(dl, dials, state, markCtx)
      )
    }
    return decideDeltaLean(dl, dials, state, markCtx)
  }

  /**
   * WHAT `decideBullS` NEEDS BEYOND AN `EngineInputs` (spec §6): the reference
   * the grid is crossed on, its own stamp, and the minutes to the venue's
   * expiry instant.
   *
   *   DX   the `.DEXBTUSD` index — the newest sample on this symbol's
   *        `md.spot` ring, at ITS OWN stamp. Never the chain's forward: a
   *        steadied or carried level is not the price the book crosses on.
   *   NSE  the future (the parity suite's reference): the chain's forward at
   *        the chain's `asOf`.
   *
   * `null` / `0` when there is no reading. The engine reads both as stale: no
   * entry and no crossing until a fresh price arrives, then it re-baselines.
   */
  #bullSInputs(inputs: EngineInputs): BullSInputs {
    let ref: number | null = null
    let refAsOf = 0
    if (this.#venue.id === 'nse') {
      const spot = inputs.chain.spot
      if (Number.isFinite(spot) && spot > 0) {
        ref = spot
        refAsOf = inputs.chain.asOf
      }
    } else {
      const latest = this.#d.ring?.latest() ?? null
      if (latest !== null && Number.isFinite(latest.spot) && latest.spot > 0) {
        ref = latest.spot
        refAsOf = latest.ms
      }
    }
    const minutesToExpiry = (this.#venue.expiryInstantMs(inputs.chain.expiry) - inputs.nowMs) / 60_000
    return { ...inputs, ref, refAsOf, minutesToExpiry }
  }

  // ------------------------------------------------------ the order budget

  /** Orders this book routed in the last `windowMs`, pruning as it reads. */
  #routedWithin(windowMs: number, nowMs: number): number {
    // Pruned to the longest window anyone asks about (a minute), so the array
    // is bounded by `dl_max_orders_min` rather than by the length of a session.
    const keep = nowMs - 60_000
    if (this.#routedAt.length > 0 && (this.#routedAt[0] ?? 0) <= keep) {
      this.#routedAt = this.#routedAt.filter((at) => at > keep)
    }
    const cutoff = nowMs - windowMs
    let n = 0
    for (const at of this.#routedAt) if (at > cutoff) n += 1
    return n
  }

  /**
   * WHAT THE ORDER BUDGET LOOKS LIKE RIGHT NOW (spec §8) — the three readings
   * `openBudget` rules on.
   *
   * Three caps: `dl_max_orders_s` (2), `dl_max_orders_min` (40) and
   * `dl_max_orders_day` (600). The engine enforces the per-minute one on the
   * package it is building, because a pure function of one tick can see its
   * own size — it cannot see the SECOND it is in or the session it is part of,
   * which is why those two are here (Task 9B, R6). Counting both places is not
   * a duplicate: the engine's is a bound on the package, this is a bound on
   * the rail.
   *
   * Counted in WIRE ACTIONS, which is what the broker rate-limits: a four-leg
   * package is four orders, not one decision.
   *
   * NOT A SINGLE NUMBER ANY MORE. This used to answer `min()` of the three
   * rooms and `#paced` compared the package's size against it — which read the
   * per-second cap as a package-size limit and dropped every package larger
   * than it, forever (E2; see `openBudget`). The three readings are returned
   * separately so the verdict can treat the second as a burst window and the
   * minute and the day as budgets.
   *
   * `null` for a recenter book. The caps are delta-lean dials and a book on
   * the other engine has never been paced by them; introducing one here would
   * be a live behaviour change smuggled in under a delta-lean ticket.
   */
  #budgetRoom(
    dials: Dials,
    nowMs: number,
  ): { lastSecond: number; minuteRoom: number; dayRoom: number } | null {
    if (!dials.delta_lean_enabled) return null
    const day = istDateOf(nowMs)
    if (day !== this.#routedDay) {
      this.#routedDay = day
      this.#routedToday = 0
    }
    return {
      lastSecond: this.#routedWithin(1_000, nowMs),
      minuteRoom: Math.max(0, dials.dl_max_orders_min - this.#routedWithin(60_000, nowMs)),
      dayRoom: Math.max(0, dials.dl_max_orders_day - this.#routedToday),
    }
  }

  /** Record `n` orders as routed at `nowMs`. Called once a package is posted. */
  #noteRouted(n: number, nowMs: number): void {
    for (let i = 0; i < n; i += 1) this.#routedAt.push(nowMs)
    this.#routedToday += n
  }

  /**
   * Give `n` orders back: the package was charged before the post (that is
   * where the broker's rate limit sees it) and desk-api then put none of it on
   * the wire (`#skipped`). The NEWEST entries go, which are the package's own.
   */
  #unnoteRouted(n: number): void {
    this.#routedAt.splice(Math.max(0, this.#routedAt.length - n), n)
    this.#routedToday = Math.max(0, this.#routedToday - n)
  }

  /**
   * THE BUDGET APPLIED TO ONE PACKAGE — and the one rule that outranks it.
   *
   * AN EXIT IS NEVER DROPPED. A book that cannot place its add is a book that
   * misses a trade; a book that cannot place its cut is a book carrying the
   * position the cut exists to remove, and no rate limit is worth that. So the
   * caps bind on OPENS only, and an over-budget package still sends every close
   * and resize in it.
   *
   * OPENS GO WHOLE OR NOT AT ALL, exactly as the engine's own `pace` has them
   * (`decide.ts`): half a debit pair is a naked leg, which is the one outcome
   * every ordering rule on this desk exists to prevent. Two of the four legs of
   * a credit unit is a short with no wing.
   *
   * AND THE PER-SECOND CAP IS A BURST WINDOW, not a size limit (`openBudget`):
   * a package the second cannot fit WAITS for the window to clear — at DEBUG,
   * because that is pacing working — while a package the minute or the day
   * cannot fit is dropped, and that is said at WARN once a minute with the
   * count of passes it stood for.
   */
  #paced(
    translated: ReadonlyArray<Translated>,
    decision: EngineDecision,
    dials: Dials,
    nowMs: number,
  ): ReadonlyArray<Translated> {
    const room = this.#budgetRoom(dials, nowMs)
    if (room === null) return translated
    const verdict = openBudget({
      orders: translated.length,
      routedLastSecond: room.lastSecond,
      perSecond: dials.dl_max_orders_s,
      minuteRoom: room.minuteRoom,
      dayRoom: room.dayRoom,
    })
    if (verdict === 'route') {
      // The budget has room again: whatever the WARN below was standing for
      // has cleared, so the next spend is a fresh incident, said at once.
      this.#budgetWarn.reset()
      return translated
    }
    const exits = translated.filter((t) => t.action.op !== 'open')
    if (exits.length === translated.length) return translated
    const ctx = {
      tag: this.#d.tag,
      mode: this.#d.mode,
      trigger: decision.trigger,
      orders: translated.length,
      exits: exits.length,
      routedLastSecond: room.lastSecond,
      minuteRoom: room.minuteRoom,
      dayRoom: room.dayRoom,
      perSecond: dials.dl_max_orders_s,
      perMinute: dials.dl_max_orders_min,
      perDay: dials.dl_max_orders_day,
      routedToday: this.#routedToday,
    }
    if (verdict === 'hold-second') {
      this.#d.log.debug('the per-second burst window is busy — the opens wait for it to clear', ctx)
      return exits
    }
    const suppressed = this.#budgetWarn.claim(nowMs)
    if (suppressed !== null) {
      this.#d.log.warn(
        exits.length === 0
          ? 'the order budget is spent — this package is dropped, nothing is opened'
          : 'the order budget is spent — the OPENS are dropped and only the exits go out',
        { ...ctx, suppressed },
      )
    }
    return exits
  }

  // ----------------------------------------------------------- the inputs

  async #inputs(
    state: SupervisorBookState,
    chain: ChainSnap,
    dials: Dials,
    nowMs: number,
  ): Promise<EngineInputs> {
    const dateIst = istDateOf(nowMs)
    const minuteOfDay = istMinuteOf(nowMs)
    const book = await this.#d.readBook()
    const legs: LegView[] = book.map((leg) =>
      // ALWAYS `pricing: 'live'`. Parity is a fixture-replay mode and is not
      // settable from anywhere (`marking.ts` §1): a live book steered off
      // Python's mid-or-LTP float is the defect this migration exists to retire.
      markLeg(leg, quoteFor(chain, leg.strike, leg.optType), chain, dateIst, minuteOfDay, 'live', this.#venue),
    )
    return {
      tag: this.#d.tag,
      mode: this.#d.mode,
      nowMs,
      dateIst,
      minuteOfDay,
      dte: dteOf(dateIst, chain.expiry),
      chain,
      legs,
      protectedQty: state.protectedQty,
      cumRealized: state.cumRealized,
      margin: this.#margin(dials),
      pendingLots: pendingLotsOf(state, book, chain.lotSize),
      repairHold: await this.#d.repairHold(),
      pricing: 'live',
      // Absent on NSE, so an NSE book's inputs are exactly what they were.
      ...(this.#venue.id === 'nse' ? {} : { venue: this.#venue }),
    }
  }

  /**
   * The margin figure, with the SECOND-READ gate applied (spec §7).
   *
   * The engine's shift gate believes a `fresh` broker figure; the supervisor is
   * the only thing that knows whether it has seen two of them in a row. So the
   * first fresh read is presented as NOT fresh and the engine's own gate does
   * the refusing — no second copy of the gate — while the margin TRIM, which
   * reads `margin.value` at face value (`guards.ts:marginGuard`), keeps working
   * through both reads.
   *
   * "Consecutive" is measured on `asOf`: a poller handing back the same cached
   * figure on ten ticks has been read once, not ten times.
   */
  #margin(dials: Dials): MarginInput {
    const raw = this.#d.margin()
    const broker = raw.fresh && raw.source === 'broker'
    const prev = this.#lastMargin
    // A READ, not a tick: the same `asOf` seen again is the same read, and it
    // neither arms nor disarms. Once two distinct fresh broker figures have
    // arrived in a row the gate STAYS armed — it is the broker going quiet or
    // falling back to the model that resets it, not a tick that saw nothing new.
    const reads = !broker
      ? 0
      : prev === null
        ? 1
        : prev.asOf === raw.asOf
          ? prev.reads
          : Math.min(2, prev.reads + 1)
    this.#lastMargin = { asOf: raw.asOf, reads }
    if (!broker || reads >= 2) return raw
    if (dials.shift_enabled) {
      this.#d.log.debug('one fresh broker margin read — the shift gate needs two', {
        tag: this.#d.tag,
        mode: this.#d.mode,
        margin: raw.value,
      })
    }
    return { ...raw, fresh: false }
  }

  // ---------------------------------------------------------- the damping

  /** `true` = route now. `false` = armed, still waiting, or in cooldown. */
  #damped(
    decision: EngineDecision,
    state: SupervisorBookState,
    inputs: EngineInputs,
    dials: Dials,
    nowMs: number,
  ): boolean {
    const { tag, mode, log } = this.#d
    const shape = shapeOf(decision)
    if (this.#intent === null || this.#intent.shape !== shape) {
      this.#intent = { trigger: decision.trigger, shape, armedAt: nowMs }
      log.debug('intent armed', { tag, mode, trigger: decision.trigger, reason: decision.reason })
    }
    const intent = this.#intent

    // The cooldown outranks the escape hatch: "this book just acted" is a
    // stronger statement than "this breach is obvious", and re-deciding into
    // orders that are still settling is what it exists to stop.
    const cooldownMs = Math.max(0, dials.cooldown_s) * 1000
    const last = state.ruleState.lastActionMs
    if (cooldownMs > 0 && last > 0 && nowMs - last < cooldownMs) {
      log.debug('in cooldown — the intent stays armed', {
        tag,
        mode,
        trigger: decision.trigger,
        leftMs: cooldownMs - (nowMs - last),
      })
      return false
    }

    if (this.#obviousBreach(decision, inputs, dials)) {
      log.info('breach past a full lot-equivalent — routing without the confirm wait', {
        tag,
        mode,
        trigger: decision.trigger,
      })
      return true
    }

    const waited = nowMs - intent.armedAt
    if (waited < dials.confirm_ms) {
      log.debug('waiting for the trigger to persist', {
        tag,
        mode,
        trigger: decision.trigger,
        waitedMs: waited,
        confirmMs: dials.confirm_ms,
      })
      return false
    }
    return true
  }

  /**
   * Is the band breached by at least one full lot-equivalent of delta?
   *
   * The lot-equivalent is measured off the STRIKE THE PACKAGE ACTUALLY SELLS —
   * the engine picked it, and its delta-per-share is the same number the package
   * was sized with (`lots = round(excess / (dps × lotSize))`). A strike whose
   * greeks do not solve gives no answer, and no answer means the ordinary
   * `confirm_ms` wait rather than a guess.
   */
  #obviousBreach(decision: EngineDecision, inputs: EngineInputs, dials: Dials): boolean {
    /**
     * A DELTA-LEAN EXIT IS ALWAYS OBVIOUS.
     *
     * Everything below measures a band excess against a lot-equivalent of the
     * strike the package SELLS, so an exit could never take this path twice
     * over: its trigger is not in `PHASE_R_TRIGGERS`, and it is a close or a
     * BUY, so there is no `open`+`Sell` to measure. Both tests answer a
     * question the controller has already answered — it emits an exit only
     * once the day target, the stuck clock or the day backstop has fired — and
     * the confirm window is pure delay on a book that already has its answer.
     *
     * THE COOLDOWN STILL OUTRANKS THIS (see `#damped`), which is why both
     * delta-lean presets set `cooldown_s: 0`. A retune that put it back would
     * silently reintroduce exactly the wait this branch removes, so there is a
     * test on the presets themselves.
     *
     * NOTHING HERE TOUCHES A RECENTER TRIGGER: the set is the delta-lean path's
     * own three, and the dial has to be on as well.
     */
    if (dials.delta_lean_enabled && DL_EXIT_TRIGGERS.has(decision.trigger)) return true
    if (!PHASE_R_TRIGGERS.has(decision.trigger)) return false
    const sale = decision.actions.find(
      (a): a is Extract<EngineAction, { op: 'open' }> => a.op === 'open' && a.side === 'Sell',
    )
    if (sale === undefined) return false
    const cor = corridor(inputs, dials)
    if (!cor.hasGreeks || !(cor.excess > 0)) return false
    const g = strikeGreeks(
      inputs.chain,
      sale.strike,
      sale.optType,
      inputs.dateIst,
      inputs.minuteOfDay,
      this.#venue,
    )
    if (g === null) return false
    const lotEquivalent = Math.abs(g.delta) * inputs.chain.lotSize
    return lotEquivalent > 0 && cor.excess >= lotEquivalent
  }

  // ------------------------------------------------------------ the route

  /**
   * `false` = the package never left this process, and the caller still owes the
   * mark's bookkeeping a write.
   */
  async #route(
    state: SupervisorBookState,
    decision: EngineDecision,
    inputs: EngineInputs,
    dials: Dials,
    nowMs: number,
  ): Promise<boolean> {
    const { tag, mode, log } = this.#d
    const wire = this.#translate(decision, inputs)
    if (wire.length === 0) {
      log.error('nothing in this package can be routed — it is dropped', {
        tag,
        mode,
        trigger: decision.trigger,
        reason: decision.reason,
      })
      return false
    }
    // The order budget, AFTER translation and before anything is spent: a
    // package the caps empty is an ordinary rate-limit outcome that `#paced` has
    // already named at WARN, not the defect the ERROR above reports.
    const translated = this.#paced(wire, decision, dials, nowMs)
    if (translated.length === 0) return false

    /**
     * ONE ACTION PER CONTRACT, refused HERE as well as at the door.
     *
     * desk-api refuses a package naming an instrument twice with a 400 and
     * nothing written (`routes/engine.ts`), because two actions on one contract
     * collapse onto one leg tag downstream — swapping their prices and losing
     * the refusal that should have stopped the second. The engine forms one move
     * per contract by construction, so this can only fire on a defect (a sale
     * landing on the same strike the unwind is buying back), and catching it
     * here spends no `seq`, places no round trip, and names the contract in a
     * log line an operator can act on rather than in an HTTP body.
     */
    const named = new Set<string>()
    const twice = translated.find((t) => {
      if (named.has(t.action.instrument)) return true
      named.add(t.action.instrument)
      return false
    })
    if (twice !== undefined) {
      log.error('this package names one contract twice — it is dropped, not posted', {
        tag,
        mode,
        instrument: twice.action.instrument,
        trigger: decision.trigger,
        reason: decision.reason,
      })
      return false
    }

    const seq = state.seq + 1
    const decisionId = `${tag}:${mode}:${String(seq)}`
    const work = workDialsOf(dials)
    const request: DecisionRequest = {
      tag,
      mode,
      decisionId,
      symbol: inputs.chain.symbol,
      expiry: inputs.chain.expiry,
      trigger: decision.trigger,
      reason: decision.reason,
      actions: translated.map((t) => t.action),
      ...(work === undefined ? {} : { work }),
    }

    const armed: SupervisorBookState = {
      ...state,
      // `lastActionMs` is the HOST's cooldown anchor and the engine never writes
      // it; stamping it here is what makes `cooldown_s` survive a restart.
      ruleState: { ...decision.stateAfter, lastActionMs: nowMs },
      seq,
      inFlight: decisionId,
      workingPackage: {
        decisionId,
        remaining: request.actions,
        request,
        basis: translated.map((t) => t.basis),
        // The invalidation clock, persisted with the package because the orders
        // outlive this process (`state-store.ts`). The FORWARD, not a print:
        // it is what the package was priced and laddered against.
        formedAt: nowMs,
        formedSpot: inputs.chain.spot,
      },
      updatedAt: nextVersion(state, nowMs),
    }

    // BEFORE THE POST. See §2 of the header.
    if (!(await this.#d.store.save(state, armed))) {
      // Somebody else wrote this book's state. The version that won may have
      // routed orders this pass knows nothing about, so nothing is posted and
      // nothing is retried — the next tick decides against what is really there.
      log.warn('another writer wrote this state first — the decision was NOT posted', {
        tag,
        mode,
        decisionId,
        trigger: decision.trigger,
      })
      return false
    }
    this.#inFlight = decisionId
    // COUNTED HERE, not at translation: the budget is "orders this book put on
    // the wire", and a package dropped for a lost compare-and-set put none
    // there. Before the post rather than after it, because the post is what the
    // broker's rate limit sees and it may not answer for seconds.
    this.#noteRouted(translated.length, nowMs)
    log.info('decision routed', {
      tag,
      mode,
      decisionId,
      trigger: decision.trigger,
      reason: decision.reason,
      actions: request.actions.length,
    })
    // The ROLLBACK TARGET is the mark's bookkeeping, not the state as it was
    // read: a refusal means the package did not happen, never that the mark did
    // not (`types.ts`'s `markState`).
    await this.#post(request, decision.markState)
    return true
  }

  /**
   * The engine's actions on the wire, and the basis their fills fold against.
   *
   * THE ONE PLACE LOTS BECOME CONTRACTS. The engine counts in lots and the wire
   * counts in shares; the qty-vs-lots confusion between endpoints is a standing
   * hazard on this desk, so the multiplication happens once, here, and nothing
   * downstream multiplies again.
   *
   * FAIL-SOFT PER ACTION, like desk-api's own translation: one strike the master
   * cannot name must not discard the rest of the package. Everything dropped is
   * named at error, because a silently shortened package is a book that thinks
   * it hedged.
   */
  #translate(decision: EngineDecision, inputs: EngineInputs): ReadonlyArray<Translated> {
    const { log, tag, mode } = this.#d
    const out: Translated[] = []
    const byInstrument = new Map(inputs.legs.map((l) => [l.instrument, l]))
    const workMode = workModeFor(decision.urgency)

    for (const action of decision.actions) {
      if (action.op === 'open') {
        const instrument = this.#d.instrumentFor(action.strike, action.optType)
        if (instrument === null) {
          log.error('the instrument master lists no contract for this strike — action dropped', {
            tag,
            mode,
            strike: action.strike,
            optType: action.optType,
            trigger: decision.trigger,
          })
          continue
        }
        const qty = wireQty(action.lots, inputs.chain.lotSize, this.#venue.qtyStep)
        if (!(qty > 0)) continue
        // `makerQuote` and ONLY `makerQuote`: the flag means "the liquidity gate
        // refused this strike's book", which is a statement about the CHAIN. It
        // used to double as the urgency channel; `decision.urgency` is that now,
        // and reading this for urgency is what put a Black-76 model price and an
        // ERROR line on every ordinary delta-lean add.
        const quoted = decision.makerQuote && action.side === 'Sell'
        const quote = quoted
          ? this.#quoteAt(action.strike, action.optType, inputs, instrument, decision)
          : undefined
        if (quoted && quote === undefined) {
          // The gate refused this book AND nothing on the wing implies a
          // volatility, so there is no price to quote at. Crossing anyway is the
          // one thing that must not happen — the gate has already said the
          // market would not take this sale.
          log.error(
            'no price for a MAKER QUOTE this chain would not cross — the sale is dropped, ' +
              'not crossed. The book stays outside its band until a strike prices.',
            { tag, mode, instrument, strike: action.strike, optType: action.optType },
          )
          continue
        }
        out.push({
          // A quoted sale is PASSIVE at a price; anything else takes the pass's
          // own work mode (urgent for a guard, absent — passive-first at
          // desk-api — for a playbook action) and no price at all.
          action: wireOpen(
            action,
            instrument,
            qty,
            quote === undefined
              ? workMode === undefined
                ? {}
                : { workMode }
              : { limitPrice: quote, workMode: 'passive' },
          ),
          basis: {
            instrument,
            strike: action.strike,
            optType: action.optType,
            side: action.side,
            op: 'open',
            // The lean this leg is being opened FOR (Task 9A's stamp). It
            // realises nothing when it fills, so it never folds — it is carried
            // so a later resize of the same row still names its lean.
            leanId: action.leanId ?? '',
            // An open has no prior position, which is exactly why it realises
            // nothing when it fills.
            entry: 0,
            lots: 0,
            lotSize: inputs.chain.lotSize,
            intentQty: qty,
          },
        })
        continue
      }

      const leg = byInstrument.get(action.instrument)
      if (leg === undefined) {
        // Only reachable if the engine named a leg that is not in the book it
        // was given, which is a bug rather than a market condition.
        log.error('the engine named a leg this book does not hold — action dropped', {
          tag,
          mode,
          instrument: action.instrument,
          trigger: decision.trigger,
        })
        continue
      }
      const shares = wireQty(leg.lots, leg.lotSize, this.#venue.qtyStep)
      if (action.op === 'close') {
        out.push({
          action: { op: 'close', instrument: action.instrument, ...(workMode === undefined ? {} : { workMode }) },
          basis: {
            instrument: action.instrument,
            strike: leg.strike,
            optType: leg.optType,
            side: leg.side,
            op: 'close',
            // Carried through for continuity with the stored leg, though
            // `#settle` no longer attributes a close to it — see
            // `state-store.ts`'s `PackageBasis.leanId`.
            leanId: leg.leanId,
            entry: leg.entry,
            lots: leg.lots,
            lotSize: leg.lotSize,
            intentQty: shares,
          },
        })
        continue
      }
      const targetQty = wireQty(action.targetLots, leg.lotSize, this.#venue.qtyStep)
      out.push({
        action: { op: 'resize', instrument: action.instrument, targetQty, ...(workMode === undefined ? {} : { workMode }) },
        basis: {
          instrument: action.instrument,
          strike: leg.strike,
          optType: leg.optType,
          side: leg.side,
          op: 'resize',
          leanId: leg.leanId,
          entry: leg.entry,
          lots: leg.lots,
          lotSize: leg.lotSize,
          intentQty: roundToStep(Math.abs(shares - targetQty), this.#venue.qtyStep),
        },
      })
    }
    return out
  }

  /**
   * THE MAKER QUOTE'S PRICE — what to ask when the market will not be crossed
   * (spec §8, "no liquid candidate").
   *
   * `shed.ts`'s liquidity gate has already refused this strike's book: it is
   * one-sided, wider than `sell_max_spread_pct`, or older than
   * `quote_max_age_ms`. Joining the touch of a book like that is not a passive
   * order, it is a fill at a price nobody chose — which is the whole reason the
   * gate exists. So the sale is QUOTED: Black-76 theoretical off the chain's own
   * forward and its own volatility (`theoreticalPrice`), floored onto the
   * contract's tick, worked `passive`.
   *
   * FLOORED, not rounded to nearest, and the direction is not arbitrary: only a
   * SELL reaches this path, so flooring asks for LESS than the model says and
   * the error is on the side of the quote being taken. Rounding up would leave
   * a quote a tick above theoretical resting all session, which is the
   * silent-hold outcome §6 forbids wearing a limit price.
   *
   * ALERTED AT ERROR VISIBILITY, every time. A book that has to quote instead of
   * cross is a book whose chain has stopped working, and it is invisible in
   * every other record: the package looks ordinary, the fill (if it comes) looks
   * ordinary, and the only tell is this line. `undefined` when nothing on the
   * wing implies a volatility — the caller drops the sale rather than crossing.
   *
   * ── THE ALERT IS RAIL-AWARE, AND IT HAS TO BE ───────────────────────────────
   * Spec §8's invalidation — cancel and re-decide after `rest_max_min` or a
   * strike-step move — runs out of `#watchWhileWorking`, which only runs while
   * this host holds an `inFlight` decision. desk-api makes a package async on
   * the PAPER rail only (`service.ts:837`: `worksAsync = via === 'engine' &&
   * mode === 'paper'`), so a LIVE engine decision settles `DONE` at route time
   * and the flight clears while the order is still resting at the gateway.
   *
   * On live, therefore, NOTHING IN THIS PROCESS WILL COME BACK FOR THIS QUOTE.
   * The gateway's chaser owns it from here — it crosses at `chase_max_ms` or
   * rests and raises the working-order alert. Telling an operator "it is
   * invalidated and re-decided" on that rail would be a promise this code cannot
   * keep, on the one line they have to go on, so the line says which rail it is
   * on and what will actually happen.
   */
  #quoteAt(
    strike: number,
    optType: OptType,
    inputs: EngineInputs,
    instrument: string,
    decision: EngineDecision,
  ): number | undefined {
    const { tag, mode, log } = this.#d
    const theo = theoreticalPrice(
      inputs.chain,
      strike,
      optType,
      inputs.dateIst,
      inputs.minuteOfDay,
      this.#venue,
    )
    if (theo === null) return undefined

    const rawTick = this.#d.tickSizeFor?.(strike, optType) ?? null
    const tick =
      rawTick !== null && Number.isFinite(rawTick) && rawTick > 0 ? rawTick : this.#venue.defaultTick
    // At least ONE tick: a sub-tick theoretical floors to zero, and a limit of
    // zero is not a quote — it is an order to sell at nothing.
    const price = Math.max(tick, Math.floor(theo / tick) * tick)
    // Re-rounded because `Math.floor(x / 0.05) * 0.05` is 3.9000000000000004 as
    // often as it is 3.9, and a limit that is not on the grid is refused.
    const limitPrice = Number(price.toFixed(4))

    log.error(
      `MAKER QUOTE: the chain would not take this sale, so ${instrument} is QUOTED at ` +
        `${String(limitPrice)} (Black-76 theoretical, tick-floored) and worked passively. ` +
        'Nothing is crossed. ' +
        (mode === 'paper'
          ? 'If it does not fill it is invalidated (rest_max_min, or a full strike step of ' +
            'underlying movement) and the book is re-decided.'
          : 'THIS SUPERVISOR WILL NOT COME BACK FOR IT: a live engine decision settles at route ' +
            'time, so the gateway owns this order from here — it crosses at chase_max_ms or ' +
            'rests and alerts. There is no rest_max_min re-decide on the live rail.'),
      {
        tag,
        mode,
        instrument,
        strike,
        optType,
        theoretical: theo,
        limitPrice,
        tick,
        trigger: decision.trigger,
        reason: decision.reason,
      },
    )
    return limitPrice
  }

  // ---------------------------------------------------------- the outcome

  /**
   * Post, and act on the one of three answers that comes back.
   *
   * `markState` is what a REFUSAL rolls back TO: this mark's bookkeeping without
   * the package's own deltas (`types.ts`). It is `null` on a replay, where the
   * decision was taken by a process that is gone and its mark is long over.
   */
  async #post(request: DecisionRequest, markState: RuleState | null): Promise<void> {
    const { tag, mode, log } = this.#d
    let outcome: DecisionResponse | 'INDETERMINATE'
    try {
      outcome = await this.#d.client.submit(request)
    } catch (err) {
      if (err instanceof RefusedError) {
        await this.#refused(request, err, markState)
        return
      }
      // Anything else is an unknown outcome that is not even a lost HTTP answer
      // — the client itself failed. The id stays `inFlight` and the 1 s poll
      // picks it up; the throw is surfaced so the caller can log it.
      throw err
    }

    if (outcome === 'INDETERMINATE') {
      log.warn('decision outcome unknown — holding the id and polling it', {
        tag,
        mode,
        decisionId: request.decisionId,
      })
      return
    }

    switch (outcome.status) {
      case 'DONE':
        // A DONE nothing of which routed is a refusal wearing a success code —
        // see `#skipped`. Checked FIRST, because `#settle` would let
        // `stateAfter` stand for a package that never happened.
        if (allSkipped(request, outcome)) {
          await this.#skipped(request, outcome, markState)
          return
        }
        await this.#settle(request, outcome, 'done')
        return
      case 'FAILED':
        // Terminal, and NEVER re-posted: `#replay` answers a FAILED id with
        // FAILED forever. Whatever DID route is still folded — a partial route
        // is real exposure.
        log.error('decision FAILED at desk-api — the next intent gets a new id', {
          tag,
          mode,
          decisionId: request.decisionId,
          routeErrors: outcome.routeErrors,
          skips: outcome.skips,
        })
        await this.#settle(request, outcome, 'failed')
        return
      default:
        // WORKING (a paper package resting at the gateway) or ROUTING (a claim
        // whose owner has not reported back). Both mean fills are still to come.
        await this.#progress(request, outcome)
    }
  }

  /** Ask desk-api again about the decision this book is holding. */
  async #resolve(state: SupervisorBookState): Promise<void> {
    const { tag, mode, log } = this.#d
    const decisionId = state.inFlight
    if (decisionId === null) return
    const request = state.workingPackage?.request ?? null
    if (request === null || request.decisionId !== decisionId) {
      // Only reachable through a hand-edited document: there is no package to
      // re-post, nothing to poll and no basis to fold against, so holding the id
      // would wedge this book for the rest of the session with no way out but
      // another hand-edit. `desk-engine-decisions` has the truth of what the id
      // did.
      log.error(
        'an inFlight decision with NO package to replay — the flight is abandoned. ' +
          'This book will decide again from the next tick; if that id really did route, its ' +
          'legs are in desk-books and its outcome is in desk-engine-decisions — reconcile by ' +
          'hand (or flatten the tag) before trusting this book\'s realised P&L.',
        { tag, mode, decisionId },
      )
      await this.#update((current) =>
        current.inFlight !== decisionId
          ? null
          : { ...current, inFlight: null, workingPackage: null },
      )
      this.#inFlight = null
      this.#forgetCancels()
      return
    }
    await this.#post(request, null)
  }

  /**
   * A REFUSAL, which is final: roll the decision's rule-state delta back, clear
   * the flight, and do not retry THIS package.
   *
   * ROLLED BACK TO THE MARK, NOT TO BEFORE IT. The package did not happen, so
   * its scrap ban and its bank movement must not stand; the MARK did happen, so
   * the lock's streak and the anchor step stay (`types.ts`'s `markState`).
   *
   * The `seq` is deliberately NOT rolled back — the id is burnt, and a burnt id
   * is cheaper than any chance of a second package under one. "Do not retry"
   * means this package: if the intent is still true on the next pass it
   * re-forms under a new id, and what stands between that and hammering the
   * endpoint every tick is PACING, which differs by engine:
   *
   *   - RECENTER: `lastActionMs` stays stamped and `cooldown_s` paces it.
   *   - DELTA-LEAN: both presets set `cooldown_s: 0` (`presets.ts`), so that
   *     stamp paces nothing. The engine's own pacing is `dlLastAdjustMs` →
   *     `dl_adjust_cooldown_s` (10 min) — and that stamp only rides on
   *     `stateAfter` (`decide.ts`'s `acted`), which is exactly what a rollback
   *     discards. So the rollback KEEPS it when the refused package had an
   *     open in it (`#rollBack`'s `keepAdjustStamp`), and a persistent 4xx
   *     costs one request every 10 min rather than one every 2 s. A refused
   *     EXIT is not paced by anything — nothing may delay an exit — and
   *     re-posts every pass; only the throttle below helps there.
   *
   * WHAT A PERSISTENT 4xx COSTS, per retry: one request, one ERROR here, one
   * burnt seq. Not a journal row — every 4xx door in `routes/engine.ts` returns
   * before `recordDecisionReason`, so desk-api writes nothing. The realistic
   * persistent one on a live desk is a 401/403/404 or a 400 from the validator,
   * i.e. deployment or version skew, and it hits EVERY book at once — which is
   * why the ERROR is once a minute per book with the count, not once per pass.
   *
   * The guidance in the log line is per STATUS, because the operator's next move
   * differs: a 400 is the desk refusing this package on its merits, while a 404
   * or a 401 is a deployment fault that will refuse EVERY package until someone
   * fixes it (`refusalGuidance`).
   */
  async #refused(
    request: DecisionRequest,
    err: RefusedError,
    markState: RuleState | null,
  ): Promise<void> {
    const { tag, mode, log } = this.#d
    const suppressed = this.#refuseErr.claim(this.#d.now())
    if (suppressed !== null) {
      log.error('desk-api REFUSED the decision — rolling back to the mark, no retry', {
        tag,
        mode,
        decisionId: request.decisionId,
        trigger: request.trigger,
        status: err.status,
        body: err.body,
        guidance: refusalGuidance(err.status),
        suppressed,
      })
    }
    await this.#rollBack(request, markState, true)
  }

  /**
   * DESK-API ANSWERED DONE AND ROUTED NOTHING: every action of the package is
   * in `skips`, no fill came back. That is the shape a switched-off row
   * produces — the gate does not 4xx it, it skips each action with "strategy X
   * is switched off for paper" and answers DONE — and `#settle` used to take
   * it at its word: `stateAfter` stood, so the v1 engine's `leanId` was
   * stamped for a unit that never existed, `#noteRouted`'s charge stood for
   * orders that never went out, and the next pass decided against a phantom
   * lean (spec E3, the 09-16..09-18 storm's second half; SUP-9 for the
   * budget).
   *
   * So it is folded as what it is, a REFUSAL: rolled back to the mark (with
   * the adjust stamp kept, so `dl_adjust_cooldown_s` paces the retry), the
   * flight cleared, the seq burnt, the budget given back. And when the reason
   * is the switch, the stand-down is latched HERE, the same second, rather than one
   * registry pass later: the gate has just said the row is off, and every
   * pass between now and the poll's confirmation would post one more package
   * into the same answer.
   *
   * WHICH DONEs QUALIFY is deliberately narrow (`allSkipped`): an all-OPEN
   * package ON THE DELTA-LEAN ENGINE, or one the gate skipped wholesale on
   * either engine. A skipped EXIT (`close: unknown leg`, `close: no mark` —
   * `book.ts`) is excluded on purpose: `dl-stuck` and `dl-stop` latch
   * `dlStopped` in `stateAfter` on the very tick that flattens, and rolling
   * that back would un-latch a book the engine just stopped. And a RECENTER
   * book's skipped opens are not folded at all: there is no latch to protect,
   * and that engine settled them as a fill-less DONE before this fold existed.
   */
  async #skipped(
    request: DecisionRequest,
    outcome: DecisionResponse,
    markState: RuleState | null,
  ): Promise<void> {
    const { tag, mode, log } = this.#d
    const reason = outcome.skips[0]?.reason ?? ''
    await this.#rollBack(request, markState, true)
    this.#unnoteRouted(request.actions.length)
    const nowMs = this.#d.now()
    const suppressed = this.#skipWarn.claim(nowMs)
    if (suppressed !== null) {
      log.warn('desk-api SKIPPED every action of the package — folded as a refusal, nothing routed', {
        tag,
        mode,
        decisionId: request.decisionId,
        trigger: request.trigger,
        actions: request.actions.length,
        reason,
        suppressed,
      })
    }
    if (/switched off for/.test(reason)) {
      this.#skipLatchUntil = nowMs + 60_000
      this.#standDown(`switched off for ${mode} — desk-api skipped the package; no new risk`)
    }
  }

  /**
   * The package did not happen: put the rule state back to the MARK, clear
   * the flight. Shared by a 4xx (`#refused`) and an all-skipped DONE
   * (`#skipped`).
   *
   * `lastActionMs` always survives, so `cooldown_s` paces the retry. With
   * `keepAdjustStamp`, so does `dlLastAdjustMs` when the package had an open
   * in it: the delta-lean presets set `cooldown_s: 0` (`presets.ts`), so on
   * that engine it is `dl_adjust_cooldown_s` (10 min) that stands between a
   * refusal and the next identical package, and the stamp only rides on
   * `stateAfter` — which is exactly what is being rolled back (`decide.ts`'s
   * `acted`).
   *
   * `markState` is `null` on a replay (the mark belonged to a process that is
   * gone): then only the flight is cleared.
   */
  async #rollBack(
    request: DecisionRequest,
    markState: RuleState | null,
    keepAdjustStamp: boolean,
  ): Promise<void> {
    const hadOpen = request.actions.some((a) => a.op === 'open')
    await this.#update((current) => {
      if (current.inFlight !== request.decisionId) return null
      return {
        ...current,
        ruleState:
          markState === null
            ? current.ruleState
            : {
                ...markState,
                lastActionMs: current.ruleState.lastActionMs,
                ...(keepAdjustStamp && hadOpen
                  ? { dlLastAdjustMs: current.ruleState.dlLastAdjustMs }
                  : {}),
              },
        inFlight: null,
        workingPackage: null,
      }
    })
    this.#inFlight = null
    this.#forgetCancels()
  }

  /**
   * A terminal outcome: fold the fills, maintain `rcStack`, clear the flight.
   *
   * Folding happens ONLY here, never on a partial `WORKING` poll: a package's
   * fills accumulate on desk-api's record and a replay reports the whole list
   * every time, so folding early would count the same fill on every poll.
   */
  async #settle(
    request: DecisionRequest,
    outcome: DecisionResponse,
    how: 'done' | 'failed',
  ): Promise<void> {
    const { tag, mode, log } = this.#d
    // desk-api took this package: a refusal or an all-skipped DONE that was
    // being said once a minute has CLEARED, and the next one is a fresh
    // incident to be said at once — not swallowed until the old minute is up
    // with its count folded into the old one. Every terminal outcome comes
    // through here (`#post` is the only caller of the three), so this is the
    // one place the two throttles let go.
    this.#refuseErr.reset()
    this.#skipWarn.reset()
    // WHICH ENGINE OWNS THIS BOOK, read once for the `dlDayRealized` fold
    // below. `dials()` is the live resolved row, the same one `#pass` reads.
    const onDeltaLean = this.#d.dials().delta_lean_enabled;
    /**
     * WHY A BULL-S ENTRY DID NOT TRADE, as desk-api reports it: the plan's skips
     * (the gateway's `oi-cap: …`, the venue's refusal, folded onto the decision
     * by the paper fold) and any route error. Written onto `ruleState.bs` for
     * `decideBullS` to name when it finds the entry failed; '' when there is
     * nothing to say, and then the engine says what the book shows.
     */
    const entryRefusal =
      this.#d.dials().bs_enabled && request.trigger === 'bs-entry' ? refusalText(outcome) : ''
    const folded = await this.#update((current) => {
      if (current.inFlight !== request.decisionId) return null
      const basis = new Map((current.workingPackage?.basis ?? []).map((b) => [b.instrument, b]))
      let cumRealized = current.cumRealized
      let banked = 0
      /**
       * THE DAY'S HALF OF THE SAME RUPEES (spec §7).
       *
       * `cumRealized` is the TAG's bank. It drives `totalPnl`, which is what
       * the day backstop, the day target and the stuck rule all read, and it
       * also feeds the RECENTER target lock — which is why it is not zeroed per
       * day here. `dlDayRealized` is this day's slice of it, zeroed by
       * `rollDay` and read by nothing in the engine: it exists so a ledger row,
       * the run page and an operator can see what was BANKED without
       * subtracting a mark.
       *
       * The v1 engine attributed these rupees to a LEAN instead, off the basis
       * row's `leanId`, because its add/cut/flip rules read a per-lean P&L.
       * This engine has no lean and no such rule — every exit reads the day's
       * number — so the attribution is gone and the whole `banked` lands here.
       *
       * ONLY ON THE DELTA-LEAN PATH. `#settle` is shared by both decide paths,
       * and a recenter book has no `rollDay` to zero this field — `rollDay` is
       * `decideDeltaLean`'s step 0 and nothing on the recenter path calls it.
       * So an unconditional fold makes a recenter tag's `dlDayRealized`
       * accumulate for the life of the row, which is not "the day's bank" under
       * any reading and is not a number the ledger or the run page may show
       * beside a delta-lean one. `cumRealized` is the tag's bank and stays
       * unconditional: it is what both engines decide on.
       */
      let rcStack = current.ruleState.rcStack
      for (const fill of outcome.fills) {
        /**
         * THE VENUE'S FEE IS BANKED AGAINST THE BOOK on every fill, open or
         * close (Delta charges both sides), so `cumRealized` — and the
         * target, loss cap and day guard that read it through `totalPnl` — is
         * NET. Absent on NSE, where the desk reports gross.
         */
        const fee = typeof fill.fee === 'number' && Number.isFinite(fill.fee) && fill.fee > 0 ? fill.fee : 0
        if (basis.has(fill.instrument)) banked -= fee
        const b = basis.get(fill.instrument)
        if (b === undefined) {
          log.warn('a fill this package cannot attribute — not folded', {
            tag,
            mode,
            decisionId: request.decisionId,
            instrument: fill.instrument,
          })
          continue
        }
        const lots = lotsOf(fill.qty, b.lotSize)
        if (fill.side === b.side) {
          // The position grew. Nothing is realised — and an engine-opened SHORT
          // is what the LIFO unwind will want to buy back first.
          if (b.op === 'open' && b.side === 'Sell') {
            rcStack = pushStack(rcStack, b.strike, b.optType, lots)
          }
          continue
        }
        // The position was reduced: bank it at the FILL'S OWN PRICE against the
        // entry the book held, and take the same lots off the stack.
        if (b.op !== 'open') {
          const gain = (b.side === 'Sell' ? b.entry - fill.price : fill.price - b.entry) * fill.qty
          banked += gain
        }
        if (b.side === 'Sell') rcStack = shrinkStack(rcStack, b.strike, b.optType, lots)
      }
      cumRealized += banked
      return {
        ...current,
        cumRealized,
        // WHAT THIS FOLD WAS MEASURED OFF, stamped per decisionId (§4 of the
        // header). Only a fold that moved money is recorded: a package that
        // banked nothing has nothing for a true-up to re-measure.
        cumRealizedBasis:
          banked === 0
            ? current.cumRealizedBasis
            : this.#capped([
                ...current.cumRealizedBasis,
                {
                  decisionId: request.decisionId,
                  // The LIVE rail books a decision optimistically at route time
                  // and nothing restates this number afterwards — see the
                  // field's own doc. Paper fills are the gateway's real ones.
                  basis: (this.#d.mode === 'live' ? 'optimistic-mark' : 'fill') as RealizedFold['basis'],
                  amount: banked,
                  at: this.#d.now(),
                },
              ]),
        ruleState: {
          ...current.ruleState,
          rcStack,
          ...(onDeltaLean
            ? { dlDayRealized: current.ruleState.dlDayRealized + banked }
            : {}),
          ...(entryRefusal === '' ? {} : { bs: { ...current.ruleState.bs, entryRefusal } }),
        },
        inFlight: null,
        workingPackage: null,
      }
    })
    this.#inFlight = null
    this.#forgetCancels()
    if (folded === null) return
    log.info(`decision ${how}`, {
      tag,
      mode,
      decisionId: request.decisionId,
      fills: outcome.fills.length,
      cumRealized: folded.cumRealized,
    })
  }

  /**
   * A package that is still working: record what is LEFT of it and keep the id.
   *
   * The remainder is the package minus the fills desk-api has recorded so far,
   * so `pendingLots` shrinks as the tranches land — and the engine's
   * working-package hold (`decide` step 4) keeps naming a number that is true.
   */
  async #progress(request: DecisionRequest, outcome: DecisionResponse): Promise<void> {
    const { tag, mode, log } = this.#d
    const step = this.#venue.qtyStep
    await this.#update((current) => {
      if (current.inFlight !== request.decisionId) return null
      const wp = current.workingPackage
      if (wp === null) return null
      const filled = new Map<string, number>()
      for (const fill of outcome.fills) {
        // On the venue grid: 0.05 + 0.05 + 0.05 is 0.15000000000000002.
        filled.set(fill.instrument, roundToStep((filled.get(fill.instrument) ?? 0) + fill.qty, step))
      }
      const basis = new Map(wp.basis.map((b) => [b.instrument, b]))
      // What is STILL OUTSTANDING, per contract — never more than it was.
      // desk-api's record accumulates fills and a replay reports the whole list,
      // so this is a recomputation rather than a decrement; taking the smaller
      // of the two is what stops a short answer (a record read before its fills
      // were pushed) winding `pendingLots` back up and re-opening the engine's
      // working-package hold.
      const outstanding = new Map(
        wp.remaining.map((a) => [a.instrument, a.op === 'open' ? a.qty : Number.POSITIVE_INFINITY]),
      )
      const remaining: WireAction[] = []
      for (const action of request.actions) {
        if (!outstanding.has(action.instrument)) continue
        const done = filled.get(action.instrument) ?? 0
        const intent = basis.get(action.instrument)?.intentQty ?? 0
        if (intent > 0 && done >= intent) continue
        if (action.op === 'open') {
          const left = roundToStep(
            Math.min(action.qty - done, outstanding.get(action.instrument) ?? action.qty),
            step,
          )
          if (left <= 0) continue
          remaining.push({ ...action, qty: left })
          continue
        }
        remaining.push(action)
      }
      return { ...current, workingPackage: { ...wp, remaining } }
    })
    log.debug('package still working', {
      tag,
      mode,
      decisionId: request.decisionId,
      status: outcome.status,
      fills: outcome.fills.length,
    })
  }

  // ------------------------------------------------------------ the state

  /**
   * The provenance list, trimmed to its bound — and SAYING SO when it evicts.
   *
   * The eviction is the moment the true-up's job stops being complete: the
   * oldest fold is out of state and only `desk-engine-decisions` still knows it
   * happened. On a book folding a handful a day that is weeks away and the line
   * never prints; on a book that has been folding all session without a true-up
   * ever running, it is the warning that one is overdue.
   */
  #capped(rows: ReadonlyArray<RealizedFold>): ReadonlyArray<RealizedFold> {
    if (rows.length <= REALIZED_BASIS_KEPT) return rows
    const dropped = rows.slice(0, rows.length - REALIZED_BASIS_KEPT)
    this.#d.log.warn(
      'realised-P&L provenance is FULL — the oldest folds are being evicted; ' +
        'desk-engine-decisions is now the only record of them',
      {
        tag: this.#d.tag,
        mode: this.#d.mode,
        kept: REALIZED_BASIS_KEPT,
        evicted: dropped.length,
        oldestEvicted: dropped[0]?.decisionId ?? '',
      },
    )
    return rows.slice(-REALIZED_BASIS_KEPT)
  }

  /**
   * Persist a rule state the engine moved, and ONLY when it actually moved.
   *
   * A write per tick would be a write per tick per book, all session, for a
   * document that changes a handful of times an hour — and every one of them is
   * a compare-and-set another writer can lose against.
   */
  async #persistRuleState(state: SupervisorBookState, next: RuleState): Promise<void> {
    if (sameRuleState(state.ruleState, next)) return
    await this.#update((current) => ({ ...current, ruleState: next }))
  }

  /**
   * Read-modify-write against the compare-and-set, RETRIED EXACTLY ONCE.
   *
   * `false` from `save` means somebody else wrote; the modification is re-made
   * against what is really there rather than re-applied blind (the same rule
   * desk-api's protect route follows). Two losses in a row is a book being
   * written to hard enough that a third attempt is not the answer — it is logged
   * at error, because what it costs is a fold: realised P&L that is simply gone.
   *
   * A `null` from `mutate` means "nothing to do any more" — the state moved
   * under this pass and the change no longer applies.
   */
  async #update(
    mutate: (current: SupervisorBookState) => SupervisorBookState | null,
  ): Promise<SupervisorBookState | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.#d.store.load(this.#d.tag, this.#d.mode)
      const next = mutate(current)
      if (next === null) return null
      const stamped = { ...next, updatedAt: nextVersion(current, this.#d.now()) }
      if (await this.#d.store.save(current, stamped)) return stamped
    }
    this.#d.log.error('supervisor state could not be written — this pass is LOST', {
      tag: this.#d.tag,
      mode: this.#d.mode,
    })
    return null
  }
}
