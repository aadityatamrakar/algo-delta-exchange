/**
 * Order gateway host — the only process that places live orders (Delta desk).
 *
 * Wires four things the pure modules cannot do for themselves:
 *   1. The broker: the simulator always; Delta (`@algomaker/dx`) only when
 *      `DESK_BROKER=delta` AND `DESK_DX_LIVE=1`, and then only for documents
 *      whose `mode` is exactly `'live'` (`dx-edge.ts`). Paper never reaches it.
 *   2. The bus subscription: a nudge saying work is waiting, plus `md.tick`
 *      (quotes, simulated fills) and `md.spot` (the BTC index for fees/caps).
 *   3. The sweep loop: the safety net that makes a dropped nudge cost latency
 *      rather than an order.
 *   4. On Delta: the private socket for order updates, the dead-man heartbeat,
 *      and the settlement job that books expired legs at Delta's price.
 *
 * Boots unconditionally, never gated on market hours — Delta trades 24x7.
 *
 * SAFETY. This process can move real money, so two things are structural:
 *   - It reads ONLY `desk-gateway-orders`.
 *   - With no live tags configured it still runs, claims, and journals — but
 *     refuses to place live. A gateway that silently placed everything by
 *     default would be one env var away from a very bad morning.
 */

import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { OptionMaster, type FreezeLimits } from '@algomaker/instruments'
import { WsTransportClient } from '@algomaker/bus'
import {
  BrokerOrderError,
  SimulatorAdapter,
  classifyBrokerError,
  type BrokerAdapter,
  type PlacedOrder,
} from '@algomaker/brokers'
import { DxAdapter, DxPrivateSocket, DxRest } from '@algomaker/dx'
import { venueFromEnv } from '@algomaker/venue'
import { connectMongo } from '../../api/src/mongo.ts'
import { liveAllowlistFromStrategies } from '../../api/src/strategies.ts'
import { loadFreezeLimits, loadStoredInstruments } from '../../marketdata/src/sync-runner.ts'
import {
  OrderQueue,
  ORDER_NUDGE_TOPIC,
  DEFAULT_ORDER_MAX_AGE_MS,
  createSweeper,
  haltsQueuedOrder,
  refusesStaleOrder,
  shouldSweep,
  type HaltState,
  type NudgePayload,
} from './queue.ts'
import { OrderJournal, ORDER_EVENTS_COLLECTION, orderMode, safeRaw, type OrderEvent } from './journal.ts'
import { createDeskNotifier } from './notify.ts'
import {
  planOrder,
  freezeUnknownReason,
  planTranches,
  type GatewayOrderDoc,
  type PlannedOrder,
  type ResolvedContract,
  type TranchePlanEntry,
} from './gateway.ts'
import { FillWatcher, FILLS_COLLECTION } from './fills.ts'
import {
  createBrokerSweep,
  DEFAULT_AMBIGUOUS_TTL_MS,
  DEFAULT_WORKING_ALERT_MS,
} from './broker-sweep.ts'
import { createPaperSweep, DEFAULT_PAPER_ORPHAN_MS } from './paper-sweep.ts'
import { connectWithRetry, installCrashGuards } from './resilience.ts'
import { chaseDialsFromEnv, chaseDisabled, createOrderChaser } from './order-chaser.ts'
import { createQuoteMap, quoteMaxAgeFromEnv } from './quote-map.ts'
import {
  brokerModeFromEnv,
  deltaCommission,
  dxCapRefusal,
  dxCapsFromEnv,
  dxSimFee,
  liveRailEnabled,
  stampedPaperRail,
} from './dx-edge.ts'
import { DX_USER_AGENT, loadDxConfig, loadDxDemoConfig, readDeltaBrokerStore } from './dx-config.ts'
import { DemoRail, createAdapterRouter, demoKeyReadiness, holdsLegs } from './dx-demo.ts'
import { OiCapGate } from './dx-oicap.ts'
import { createDxHeartbeat, DX_HEARTBEAT_MS } from './dx-heartbeat.ts'
import {
  BROKER_SNAPSHOT_COLLECTION,
  createDeltaPositionsSnapshot,
  createGatewayHeartbeat,
  DELTA_DEMO_SNAPSHOT_ID,
  DELTA_SNAPSHOT_MS,
  GATEWAY_HEARTBEAT_COLLECTION,
  GATEWAY_HEARTBEAT_MS,
  hostOf,
} from './gateway-heartbeat.ts'
import {
  countWorking,
  createDxSettlementJob,
  DX_SETTLEMENT_POLL_MS,
  DX_SETTLEMENTS_COLLECTION,
  listOpenBooks,
  mongoSettlementBooker,
  type DxSettlementRow,
} from './dx-settlement.ts'

/** Cancel requests desk-api writes and this process performs. */
export const CANCEL_COLLECTION = 'desk-broker-cancels'
/**
 * Deliberately far faster than the snapshot. A cancel is reached for when
 * something is wrong; making it wait 30s would be the wrong trade.
 */
const CANCEL_POLL_MS = 2_000

/**
 * How many placement-or-recovery passes an order gets before it is dead-lettered.
 *
 * `placeAttempts` counts the one real placement plus every recovery pass after
 * it. An order that keeps being interrupted is not being interrupted by chance,
 * and looping it forever hides that from whoever has to look at the orderbook —
 * which is the only place its true state can be settled.
 */
const MAX_PLACE_ATTEMPTS = 3

function log(msg: string, ctx?: Record<string, unknown>): void {
  console.log(`[gateway] ${new Date().toISOString()} ${msg}${ctx === undefined ? '' : ' ' + JSON.stringify(ctx)}`)
}

/**
 * A positive millisecond duration from the environment, or the default.
 *
 * A typo'd value falls back rather than becoming `NaN`: every comparison
 * against NaN is false, so a mistyped threshold would silently disable the
 * control it configures instead of failing loudly.
 *
 * On THIS process the two ways that lands are both expensive. `DESK_BROKER_SWEEP_MS='45s'`
 * makes `setInterval(fn, NaN)` a ~1ms loop hammering `orderBook` from the only
 * process that can place orders; `DESK_AMBIGUOUS_TTL_MS='10m'` makes
 * `now - placedAt <= NaN` false, so the first sweep declares a traceless
 * ambiguous tranche never-placed and un-books a position that fills seconds
 * later — the F-3 failure the ambiguous hold exists to prevent.
 *
 * A local copy of the bridge's helper (`apps/api/src/main.ts`), not a shared
 * import: six lines is a cheaper coupling than making the gateway's boot depend
 * on the bridge's.
 */
export function positiveEnvMs(
  name: string,
  dflt: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/**
 * The three things a REFUSAL is, in one place.
 *
 * Six sites used to write the same three statements by hand — journal the
 * reason, mark the queue document INVALID with it, log it — and the copies had
 * already drifted: the recovery path's "no longer plans" refusal marked and
 * logged but journalled NOTHING, so the one refusal an operator is most likely
 * to be hunting (an order interrupted mid-placement that then stopped planning)
 * was absent from `desk-order-events` and therefore from the failures feed the
 * dashboard is read on. Deduplicating fixes that by construction, which is the
 * point of doing it: the fourth copy of a three-line block is where the omission
 * hides.
 *
 * THE ORDER OF THE THREE IS PART OF THE CONTRACT. The journal line is written
 * BEFORE the document is marked, so a crash in between leaves a refusal that is
 * explained but not yet terminal — the order is reclaimed and refused again,
 * which is idempotent. Marking first and crashing would leave an order dead with
 * nothing anywhere saying why.
 *
 * `journal.record` never throws (see `OrderJournal.record`), so nothing here can
 * turn a refusal into an unhandled rejection.
 */
export interface RefusalPorts {
  readonly journal: { record(event: OrderEvent): Promise<void> }
  readonly queue: { markInvalid(clientOrderId: string, reason: string): Promise<void> }
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface Refusal {
  readonly clientOrderId: string
  readonly tag: string
  readonly tradingsymbol: string
  /**
   * Why, in the operator's words. The SAME string is journalled and written onto
   * the queue document, so "why is this order INVALID" and "what does the
   * journal say" can never answer differently.
   */
  readonly reason: string
  /**
   * `INVALID` for an order that could not be planned at all, `FAILED` for one a
   * gate refused. Stated per site rather than derived: the distinction is the
   * one an operator reads the feed by, and no rule here could infer it.
   */
  readonly phase: 'FAILED' | 'INVALID'
  /** Omitted where the site omits it — `transient` / `session` / `fatal`. */
  readonly errorClass?: string
  /** The shouty prefix on the log line: `BLOCKED`, `HALTED`, `STALE`, … */
  readonly label: string
  /**
   * What the LOG says, when that is deliberately shorter than the journalled
   * reason. Only the recovery path uses it, and only because its reason carries
   * a prefix the log line's own label already supplies.
   */
  readonly logReason?: string
  /**
   * WHICH RAIL the refused order was on — see `OrderEvent.mode`.
   *
   * Optional, because two call sites refuse an order whose DOCUMENT they never
   * read (a queue row that will not resolve at all), and a mode nobody could
   * establish is better omitted than guessed. Absent scopes as live, which is
   * where an unidentifiable order belongs.
   */
  readonly mode?: 'paper' | 'live'
}

export function refuse(ports: RefusalPorts): (r: Refusal) => Promise<void> {
  return async (r: Refusal): Promise<void> => {
    await ports.journal.record({
      clientOrderId: r.clientOrderId, phase: r.phase, ok: false, tag: r.tag,
      tradingsymbol: r.tradingsymbol, ts: Date.now(), error: r.reason,
      ...(r.errorClass === undefined ? {} : { errorClass: r.errorClass }),
      ...(r.mode === undefined ? {} : { mode: r.mode }),
    })
    await ports.queue.markInvalid(r.clientOrderId, r.reason)
    ports.log(`${r.label} ${r.tradingsymbol} [${r.clientOrderId}]: ${r.logReason ?? r.reason}`)
  }
}

/**
 * What ONE tranche's journal says happened to it, as the recovery path reads it.
 *
 * Three independent facts, because the three outcomes they encode are three
 * different things to tell the desk: `brokerOrderId` present means an ACK is on
 * record; `submitted` means a SUBMITTED line is (the request left this process);
 * `failed` means the BROKER itself refused it — a FAILED line whose `errorClass`
 * is anything but `'unknown'`. A FAILED/`unknown` line is a transport fault and
 * is deliberately NOT a failure here (see `placeOne`, which holds exactly those
 * ambiguous).
 */
export interface TrancheJournalState {
  /** From the ACK event. `''` is a real ACK that carried no id. */
  readonly brokerOrderId?: string
  /** A SUBMITTED line exists: the request was handed to the adapter. */
  readonly submitted?: boolean
  /** The broker answered with a terminal refusal. */
  readonly failed?: boolean
}

/**
 * ONE tranche's journal, read into the three facts above.
 *
 * `null` when the journal holds NOTHING for this tranche — the distinction the
 * whole partition turns on, and the reason this cannot be a "default empty
 * state": no line at all means the placement loop never reached this tranche,
 * which is the only case anybody may call never-placed.
 *
 * Pure and exported so the classification is provable without a Mongo: the
 * caller's loop is then nothing but `history()` and this call.
 */
export function readTrancheJournal(
  events: readonly Record<string, unknown>[],
): TrancheJournalState | null {
  if (events.length === 0) return null
  const ack = events.find((e) => e['phase'] === 'ACK')
  // A FAILED line whose class is `unknown` is NOT a failure: that is exactly
  // what `placeOne` writes for a transport fault it holds ambiguous, and a
  // recovery re-reading it as terminal would harden an unknown into a
  // rejection the broker never gave us.
  const failed = events.some(
    (e) => e['phase'] === 'FAILED' && String(e['errorClass'] ?? '') !== 'unknown',
  )
  return {
    ...(ack === undefined ? {} : { brokerOrderId: String(ack['brokerOrderId'] ?? '') }),
    submitted: events.some((e) => e['phase'] === 'SUBMITTED'),
    failed,
  }
}

/**
 * What an INTERRUPTED placement may conclude from its journal.
 *
 * Pure, and exported, because it is the decision the recovery path turns on and
 * it must be provable without a broker. This path PLACES NOTHING, so getting it
 * wrong cannot double-place — it can only mis-report — and the mis-reports are
 * not symmetric:
 *
 *  - calling an ACKed tranche failed under-reports a real position, which the
 *    fill socket and the boot sweep can still correct (`fills.ts` dedups);
 *  - calling a never-sent tranche placed leaves the desk order waiting on a
 *    fill that will never arrive.
 *
 * THE THIRD ANSWER (WP-L, the residual WP-E left behind). The old rule was "ACK
 * or failure", because when it was written nothing could settle an unknown and
 * failure was the least-bad guess. It is still a guess that UN-BOOKS REAL
 * POSITIONS: a tranche with a SUBMITTED line in the journal left this process
 * for the broker, and a gateway that died before the ACK came back knows
 * nothing about what the exchange did with it. Booking it failed marks the desk
 * order REJECTED and Python's reconcile un-books an open that may be live —
 * F-3, arriving by the recovery path instead of the placement path.
 *
 * The Tier-2 broker sweep now answers exactly that question (`broker-sweep.ts`:
 * a trace in the broker's own book ⇒ leave it working; no trace after the TTL ⇒
 * never placed), so SUBMITTED-but-unanswered belongs in `ambiguousTrancheIds`,
 * where the desk order stays NON-TERMINAL until the broker says which it was.
 * Only a tranche with NO journal entry at all is provably still on this side of
 * the wire, and only that one is failed.
 *
 * WHICH IS WHY `sweepAvailable` EXISTS. `ambiguousTrancheIds` is not a verdict,
 * it is a QUESTION, and the ONLY thing that ever answers it is the broker-book
 * sweep — armed only with a live Delta adapter, because in simulate mode the
 * "broker's book" is our own invention. Parking a tranche there with nothing to
 * settle it leaves the desk order non-terminal FOREVER: never filled, never
 * failed, never re-placed, blocking the tag for the rest of a paper session.
 * With no sweep the OLD rule is the right one and is kept exactly — a guess
 * that un-books a simulated position is cheap, and a paper order that hangs
 * forever is not.
 *
 * The flag is REQUIRED rather than defaulted: a caller that has not thought
 * about whether anything will answer the question is the caller that produces
 * the permanent hang.
 *
 * Only tranches in `plannedTrancheIds` are reported. Tranche ids are
 * deterministic, but a freeze-limit change between attempts re-splits the order,
 * and `markPlaced` must not record ids the fill watcher cannot account for.
 */
export function partitionInterruptedTranches(
  plannedTrancheIds: readonly string[],
  journalByTrancheId: ReadonlyMap<string, TrancheJournalState>,
  sweepAvailable: boolean,
): {
  readonly brokerOrderIds: readonly string[]
  readonly failedTrancheIds: readonly string[]
  readonly ambiguousTrancheIds: readonly string[]
} {
  const brokerOrderIds: string[] = []
  const failedTrancheIds: string[] = []
  const ambiguousTrancheIds: string[] = []
  for (const id of plannedTrancheIds) {
    const state = journalByTrancheId.get(id)
    if (state === undefined) {
      // Not one line in the journal: the loop died before even the SUBMITTED
      // line, so this tranche provably never left the process.
      failedTrancheIds.push(id)
      continue
    }
    if (state.brokerOrderId !== undefined) {
      // ACKed but unnamed: it reached the broker, so it is not a failure — but
      // an empty id in `brokerOrderIds` matches every order with no id at all.
      if (state.brokerOrderId !== '') brokerOrderIds.push(state.brokerOrderId)
      continue
    }
    if (state.failed === true) {
      // The broker answered. No order update will ever arrive, so the aggregate
      // has to know it is terminal or the desk order waits on it all session.
      failedTrancheIds.push(id)
      continue
    }
    if (!sweepAvailable) {
      // SIMULATE MODE keeps the old rule, and that is not a compromise: with no
      // broker book to read, "ambiguous" is a state nothing can leave. Booking
      // it failed is a guess — the same least-bad guess this path made before
      // the sweep existed — but it is TERMINAL, and the desk order finishes.
      failedTrancheIds.push(id)
      continue
    }
    ambiguousTrancheIds.push(id)
  }
  return { brokerOrderIds, failedTrancheIds, ambiguousTrancheIds }
}

// ------------------------------------------------------------- placement

/**
 * Everything the placement path needs from the world outside it.
 *
 * EXTRACTED FROM `main()` FOR THE REASON `fills.ts` GIVES ABOUT ITSELF: as a
 * closure over a boot sequence it could only be exercised by starting the
 * process against a Mongo and a broker, so the property that actually matters
 * — one desk order becomes N broker orders, in the right order, exactly once —
 * had no test that ran the code the gateway runs. With the ports injected, the
 * suite drives THIS function with the simulator and a fake collection.
 *
 * The seams are the ones that vary at runtime, and nothing more: reference data
 * is refreshed on an interval (so `resolveContract` and `freeze` are called per
 * order, never captured), and the broker sweep is armed after this is built (so
 * `sweepArmed` is a question, not a boolean).
 */
export interface PlacerPorts {
  readonly queue: Pick<
    OrderQueue,
    | 'markPlacing'
    | 'markPlaced'
    | 'heartbeat'
    | 'markInvalid'
    | 'writeTranchePlan'
    // A gate refusing a slice of an order that has already traded HALTS it
    // rather than calling the whole thing INVALID — see `refuseSlice`.
    | 'markHalted'
  >
  readonly journal: Pick<OrderJournal, 'record' | 'history'>
  readonly fills: Pick<FillWatcher, 'rememberSymbol' | 'reconcile' | 'filledSoFar'>
  /**
   * WHICH BROKER THIS DOCUMENT GOES TO — asked PER ORDER, not wired once (D14).
   *
   * Delta only for an exact `mode: 'live'` document with `DESK_DX_LIVE=1`
   * (`dx-edge.ts:chooseRail`); a PAPER document on a book set to the demo
   * rail goes to Delta's testnet (`dx-demo.ts:createAdapterRouter`); everything
   * else is the SIMULATOR. That
   * is the whole of what separates a paper order from a live one on this path:
   * same queue, same claim, same plan, same tranche cursor, same chaser, same
   * fill correlation — a rehearsal that skipped any of them would be rehearsing
   * something else.
   *
   * A FUNCTION rather than two fields because the choice is a property of the
   * ORDER, and a single-adapter port would force this decision back out into
   * `main()` where the document is no longer in hand. See `isPaperOrder` for
   * why the answer is fail-closed.
   */
  readonly adapterFor: (doc: Record<string, unknown>) => RoutedOrAdapter | Promise<RoutedOrAdapter>
  /** The instrument master's answer, already narrowed to what a plan needs. */
  readonly resolveContract: (tradingsymbol: string) => ResolvedContract | null
  readonly freeze: () => FreezeLimits
  /**
   * THE DELTA CAPS (spec §8): why this order is too big to route, or null.
   * Asked of BOTH rails, before any broker sees the order — paper rehearses the
   * same refusal live would make. Absent (NSE) is no cap.
   */
  readonly capRefusal?: (order: GatewayOrderDoc, contract: ResolvedContract | null) => string | null
  /**
   * THE DELTA OI CAP (`dx-oicap.ts`): why this order's opening PACKAGE must not
   * be sent — one of its legs is on a product Delta has in reduce-only mode on
   * the venue `rail` names — or null. Every leg of the package gets the same
   * answer, so none is sent. Closes are never refused. Absent (NSE) is no check.
   */
  readonly oiCapRefusal?: (order: GatewayOrderDoc, clientOrderId: string, rail: string | null) => Promise<string | null>
  /** Gate 2 — the Strategies page switch. Not asked of a PAPER order. */
  readonly allowsLive: (tag: string) => Promise<boolean>
  /** Gate 3 — the kill switch. */
  readonly readHalt: () => Promise<{ state: HaltState; reason: string }>
  /**
   * Gate 5 — the broker link. Null while this process may talk to the live
   * broker; the refusal text while an operator has released it. Asked of LIVE
   * orders only. The Delta gateway has no session to release and answers null.
   */
  readonly linkRefusal: () => string | null
  /** Gate 4 — how old a queued order that ADDS exposure may be. */
  readonly orderMaxAgeMs: number
  /**
   * Is anything going to answer an AMBIGUOUS tranche of THIS document? See
   * `partitionInterruptedTranches`. The live sweep answers live documents; the
   * demo rail's sweep answers paper documents placed on testnet.
   */
  readonly sweepArmed: (doc: Record<string, unknown>) => boolean
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

/**
 * What `adapterFor` answers: an adapter, or the router's `Routed` — the adapter
 * plus the rail it is and why, which the PLANNED journal row then carries
 * (`detail.rail`, `detail.railNote`), so the journal says which rail was used.
 */
export type RoutedOrAdapter =
  | Pick<BrokerAdapter, 'placeOrder'>
  | { readonly adapter: Pick<BrokerAdapter, 'placeOrder'>; readonly rail: string; readonly note: string }

function routedOf(r: RoutedOrAdapter): { adapter: Pick<BrokerAdapter, 'placeOrder'>; rail: string | null; note: string } {
  return 'adapter' in r && typeof (r as { placeOrder?: unknown }).placeOrder !== 'function'
    ? { adapter: r.adapter, rail: r.rail, note: r.note }
    : { adapter: r as Pick<BrokerAdapter, 'placeOrder'>, rail: null, note: '' }
}

export interface Placer {
  /** Handle ONE claimed order document. */
  processOne(doc: Record<string, unknown>): Promise<void>
}

/**
 * WHICH SLICE OF A GATED ORDER GOES OUT NOW, or null when the order is not
 * gated at all.
 *
 * The plan is read off the DOCUMENT whenever it is already there, and computed
 * only for an order that has never been placed. That asymmetry is deliberate:
 * the freeze table refreshes on an interval and a book's dial can be changed
 * mid-session, so a plan recomputed for slice 3 can legitimately differ from
 * the one slice 1 was cut from — and a cursor pointing into a different plan
 * names a different quantity than the one it was set against.
 */
export function trancheStateOf(
  order: GatewayOrderDoc,
  doc: Record<string, unknown>,
  lotSize: number,
  freezeMaxLots: number | null,
): TrancheState | null {
  const stored = Array.isArray(doc['tranchePlan'])
    ? (doc['tranchePlan'] as { qty?: unknown }[])
        .map((t) => ({ qty: Number(t?.qty ?? Number.NaN) }))
        .filter((t) => Number.isFinite(t.qty) && t.qty > 0)
    : []
  const rawCursor = Number(doc['trancheCursor'] ?? 0)
  const cursor = Number.isInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0
  if (stored.length > 0) {
    // A cursor past the end of its own plan is a corrupt document. Refusing to
    // treat it as gated makes the order settle on what it already holds rather
    // than place a tranche of a size nothing decided.
    return cursor >= stored.length ? null : { plan: stored, cursor, fresh: false }
  }
  const plan = planTranches({
    quantity: order.quantity,
    lotSize,
    trancheLots: order.trancheLots,
    workMode: order.workMode,
    freezeMaxLots,
  })
  return plan === null ? null : { plan, cursor: 0, fresh: true }
}

interface TrancheState {
  readonly plan: readonly TranchePlanEntry[]
  readonly cursor: number
  /** Never placed before: the plan is this claim's to write. */
  readonly fresh: boolean
}

/**
 * IS THIS A PAPER ORDER? Asked of the document, FAIL-CLOSED TO PAPER.
 *
 * The declared rail (`journal.ts:orderMode`): only an EXACT `mode: 'live'` is
 * live; everything else — `'paper'`, no mode, `'Live'` — is paper. A paper
 * order is simulated and skips the Strategies-page LIVE gate; whether a live
 * one actually reaches Delta is `dx-edge.ts:routesToDelta`.
 *
 * Exported so the property is provable without booting a gateway.
 */
export function isPaperOrder(doc: Record<string, unknown>): boolean {
  return orderMode(doc) === 'paper'
}

export function createOrderPlacer(ports: PlacerPorts): Placer {
  const { queue, journal, fills, log } = ports
  const now = ports.now
  const refuseOrder = refuse({ journal, queue, log })

  /**
   * `tag|underlying` pairs whose "no freeze limit" sentence has been logged.
   *
   * IN MEMORY AND SAID ONCE, the same discipline as the chaser's
   * `warnedNoTouch`: the condition holds for every order the book places on
   * that underlying until a freeze row exists, so logging the full paragraph
   * per order put it on the console for all 34 SENSEX orders of 2026-09-16/17.
   * Later orders get a one-liner that points back at the first. The JOURNAL
   * row is not rate-limited — every order still carries its own warning, so
   * the dialog on the web can explain any one of them. Not persisted: a
   * restart re-saying it once is the correct amount of noise.
   */
  const warnedFreeze = new Set<string>()

  /**
   * A gate refusing a TRANCHE OF AN ORDER THAT HAS ALREADY TRADED.
   *
   * Every gate below re-runs per slice, deliberately — a kill switch engaged
   * mid-sequence must stop the tranches that have not gone out yet, and a tag
   * switched off must too. But the REFUSAL cannot be the same one: `refuse()`
   * marks the document INVALID, which reads as "this order could not be
   * planned at all", and on slice 3 of 5 that is a statement about an order
   * two thirds of which is a real position at a real price. An operator
   * reading INVALID next to "queued order not placed" would re-submit the
   * whole thing.
   *
   * So a later slice HALTS instead: the same journal line, in the same
   * failures feed, with the same reason — and a state that says the sequence
   * was stopped part-way, which is what happened. Nothing further is placed
   * either way.
   *
   * IT CARRIES WHAT ALREADY TRADED, exactly as `FillWatcher.#halt` does and
   * from the same reader (`fills.filledSoFar`). `service.ts:#actualEntries`
   * prices legs off `filledQty`/`avgPrice` and skips a document that has
   * neither, and `reconcile-live.ts` folds the shortfall back off the same two
   * fields — so a halt that recorded only its reason would leave the legs of a
   * two-thirds-filled order marked at the seed price and the book carrying size
   * no order backs. Omitted rather than zeroed when nothing is known: a false
   * zero is worse than an absent field, because it is believed.
   */
  const refuseSlice = async (
    slice: { readonly cursor: number } | null,
    r: Refusal & { readonly clientOrderId: string },
  ): Promise<void> => {
    if (slice === null) {
      await refuseOrder(r)
      return
    }
    // The journal FIRST, as `refuse()` does: a crash in between leaves a halt
    // that is explained but not yet terminal, and the next pass halts again.
    await journal.record({
      clientOrderId: r.clientOrderId, phase: r.phase, ok: false, tag: r.tag,
      tradingsymbol: r.tradingsymbol, ts: now(),
      /**
       * IT SAYS HALTED, which is what the queue document says one line below.
       *
       * The Orders page renders `status` and falls back to the phase when
       * there is none, so a halted-after-partial order read REJECTED — the one
       * word that means "nothing traded" about an order that traded two thirds
       * of its size. `FillWatcher.#halt` has always stamped this; this site,
       * which is the OTHER way an order halts, never did.
       */
      status: 'HALTED',
      error: `HALTED: ${r.reason}`,
      ...(r.errorClass === undefined ? {} : { errorClass: r.errorClass }),
      ...(r.mode === undefined ? {} : { mode: r.mode }),
    })
    const traded = await fills.filledSoFar(r.clientOrderId)
    const landed = await queue.markHalted(
      r.clientOrderId,
      {
        reason: r.reason,
        ...(traded.filledQty > 0
          ? { filledQty: traded.filledQty, avgPrice: traded.avgPrice }
          : {}),
      },
      // The window this decision was taken in — the document is CLAIMED by this
      // worker and its cursor is the slice being refused. Same discipline as
      // `advanceTranche`: a conclusion reached some awaits ago must not land on
      // a document that has moved underneath it.
      { state: 'CLAIMED', trancheCursor: slice.cursor },
    )
    log(
      `${r.label} ${r.tradingsymbol} [${r.clientOrderId}]: ${r.logReason ?? r.reason} — HALTED ` +
        `part-way through a tranched order; the tranches already placed stand and nothing ` +
        `further is sent`,
      { filledQty: traded.filledQty, written: landed },
    )
  }

  /**
   * The whole order's plan, and then the slice of it that goes out now.
   *
   * The contract and the freeze table are resolved ONCE per order and handed to
   * both calls: they are read from a master that another timer replaces, and
   * asking twice inside one placement is how a plan comes to be cut against
   * reference data that changed between two lines of the same function.
   *
   * TWO PLANS RATHER THAN ONE, because the freeze limit the tranche sizes are
   * derived from is `planOrder`'s own answer (`maxLotsPerOrder`) — recomputing
   * it here would mean a second copy of `resolveUnderlying`'s precedence rules,
   * and eventually a copy that disagrees with the split it is slicing.
   *
   * `idOffset` is how many broker orders this document has already produced, so
   * slice 2's tranches are `.2`, `.3`… and never a second `.1`. Taken from the
   * document rather than from the plan's arithmetic because it must come out
   * IDENTICAL for a retry of the same slice — which is exactly what the
   * recovery path needs to name what the interrupted attempt would have sent.
   */
  const planFor = (
    order: GatewayOrderDoc,
    clientOrderId: string,
    doc: Record<string, unknown>,
  ): { readonly plan: PlannedOrder; readonly tranches: TrancheState | null } => {
    const contract = ports.resolveContract(order.tradingsymbol)
    const freeze = ports.freeze()
    const build = (slice?: { readonly quantity: number; readonly idOffset: number }): PlannedOrder =>
      planOrder({ doc: order, contract, freeze, clientOrderId, ...(slice === undefined ? {} : { slice }) })

    const whole = build()
    if (whole.rejected !== null || contract === null) return { plan: whole, tranches: null }
    const tranches = trancheStateOf(order, doc, contract.lotSize, whole.maxLotsPerOrder)
    if (tranches === null) return { plan: whole, tranches: null }
    const quantity = tranches.plan[tranches.cursor]?.qty ?? 0
    const idOffset = asIdCount(doc['trancheIds'])
    return { plan: build({ quantity, idOffset }), tranches }
  }

  /**
   * A claim whose previous attempt had already begun placing.
   *
   * THIS PATH PLACES NOTHING, and that is its entire reason to exist. Tranche 1
   * of 3 may be live at the broker, and the truncated wire correlation id cannot
   * dedup it (see `queue.ts:getByBrokerOrderId`), so re-planning and re-sending
   * — what this used to do — doubles a real position. The journal already knows
   * which tranches ACKed; resolve from it and let the fill watcher finish.
   *
   * Every unACKed tranche gets a LOUD journal line rather than a silent gap: its
   * outcome is genuinely unknown, and the only instrument that can settle it is
   * the broker's own orderbook.
   */
  const recoverInterrupted = async (
    doc: Record<string, unknown>,
    clientOrderId: string,
  ): Promise<void> => {
    const order = doc as unknown as GatewayOrderDoc
    const attempts = Number(doc['placeAttempts'] ?? 0)
    if (attempts >= MAX_PLACE_ATTEMPTS) {
      const reason =
        `dead-lettered after ${attempts} interrupted placement attempts — ` +
        `check the broker orderbook for '${order.tradingsymbol}' before re-submitting`
      await refuseSlice(completedSliceOf(doc), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason, phase: 'FAILED', errorClass: 'fatal', label: 'DEAD-LETTER',
        mode: orderMode(doc),
      })
      return
    }

    /**
     * Count THIS recovery pass.
     *
     * Nothing below places, so the counter is not counting placements — it
     * bounds the only loop this path can form: a recovery that throws before
     * `markPlaced` leaves the document CLAIMED with its marker still set, and
     * the next reclaim lands right back here. Re-stamping `placementStartedAt`
     * is harmless; only its PRESENCE is ever read.
     */
    await queue.markPlacing(clientOrderId)

    const { plan, tranches } = planFor(order, clientOrderId, doc)
    if (plan.rejected !== null) {
      // The order planned once (it got as far as placing) and does not now. The
      // reference data moved under it; there is still nothing to place.
      //
      // JOURNALLED AS OF THE DEDUP, and it was not before: this site marked and
      // logged and wrote no event, so the refusal existed only in a process log.
      // Same shape as `placeOne`'s plan rejection below — it is literally the
      // same refusal, one attempt later.
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason: `interrupted placement no longer plans: ${plan.rejected}`,
        phase: 'INVALID', label: 'RECOVERY INVALID',
        // The log line's own label already says "recovery", so it carries the
        // bare planner message the way it always has.
        logReason: plan.rejected,
        mode: orderMode(doc),
      })
      return
    }

    const trancheIds = plan.intents.map((i) => i.clientOrderId)
    // THE JOURNAL IS THE ONLY WITNESS — and a tranche it says nothing at all
    // about is the only one anybody may call never-placed.
    const states = new Map<string, TrancheJournalState>()
    for (const id of trancheIds) {
      const state = readTrancheJournal(await journal.history(id))
      if (state !== null) states.set(id, state)
    }
    /**
     * A PAPER ORDER HAS NO BROKER BOOK TO SETTLE IT, whatever mode this process
     * is in — the sweep reads the broker's order book, and a simulated order has no
     * row in it. So an ambiguous paper tranche would sit non-terminal forever,
     * blocking its tag for the rest of the session; the old rule (book it
     * failed, terminally) is the right one for it, exactly as it is for a whole
     * gateway running in simulate mode.
     */
    const { brokerOrderIds, failedTrancheIds, ambiguousTrancheIds } =
      partitionInterruptedTranches(
        trancheIds,
        states,
        // A demo-rail paper order DOES have a broker book: testnet's.
        ports.sweepArmed(doc) && (!isPaperOrder(doc) || stampedPaperRail(doc) === 'demo'),
      )

    for (const id of failedTrancheIds) {
      /**
       * TWO WAYS TO BE IN THIS LIST, and the journal must not tell the operator
       * the wrong one. A tranche with no journal line never left the gateway.
       * A SUBMITTED one lands here only in simulate mode, where nothing exists
       * that could ever settle it — that is a forced terminal call, not a
       * statement about where the tranche got to, and saying "it never left"
       * about it would be a lie written into the record.
       */
      const wasSubmitted = states.get(id)?.submitted === true
      await journal.record({
        clientOrderId: id, phase: 'FAILED', ok: false, tag: order.tag,
        tradingsymbol: order.tradingsymbol, ts: now(),
        error: wasSubmitted
          ? 'placement interrupted AFTER this tranche was submitted and before it ACKed — ' +
            'outcome unknown, and with no broker-book sweep armed (simulate mode) nothing can ' +
            'ever settle it, so it is booked FAILED rather than left hanging'
          : 'placement interrupted before this tranche was submitted — it never left the ' +
            'gateway, so nothing was placed for it',
        errorClass: 'fatal',
        mode: orderMode(doc),
      })
    }
    /**
     * The ambiguous ones get the SAME journal shape `placeOne` writes for a
     * transport unknown — FAILED with `errorClass: 'unknown'` — deliberately.
     * It is loud in the failures feed (`ok: false`), it does not mark the
     * tranche terminal anywhere, and a second recovery pass re-reading this
     * history reaches the same conclusion rather than a harder one.
     */
    for (const id of ambiguousTrancheIds) {
      await journal.record({
        clientOrderId: id, phase: 'FAILED', ok: false, tag: order.tag,
        tradingsymbol: order.tradingsymbol, ts: now(),
        error:
          'placement interrupted AFTER this tranche was submitted and before it ACKed — ' +
          'outcome UNKNOWN, resolving from the broker book; nothing is re-placed',
        errorClass: 'unknown',
        mode: orderMode(doc),
      })
    }
    await queue.markPlaced(clientOrderId, {
      brokerOrderIds,
      trancheIds,
      failedTrancheIds,
      // The desk order stays NON-TERMINAL while any of these is open — that is
      // the point of them. The broker sweep settles each from the broker's own
      // book, and nothing here retries a single one.
      ambiguousTrancheIds,
      expectedQty: plan.expectedQty,
      // A recovered LATER slice appends, exactly as a placed one does: the
      // tranches this document has already filled are not this attempt's to
      // rewrite.
      ...(isLaterSlice(tranches) ? { append: true } : {}),
    })
    log(
      `RECOVERED ${order.tradingsymbol} [${clientOrderId}]: ` +
        `${brokerOrderIds.length}/${trancheIds.length} tranches ACKed, ` +
        `${ambiguousTrancheIds.length} submitted-but-unanswered (held AMBIGUOUS for the broker ` +
        `sweep), ${failedTrancheIds.length} never submitted (attempt ${attempts}) — ` +
        `NOTHING was re-placed`,
    )
    await fills.reconcile(clientOrderId)
  }

  const placeOne = async (
    order: GatewayOrderDoc,
    clientOrderId: string,
    doc: Record<string, unknown>,
    onPlacementStarted: () => void,
  ): Promise<void> => {
    // WHICH RAIL, ONCE, for every decision this placement makes about the
    // document: which broker it goes to, whether the live gate is asked at
    // all, and which Orders tab each of its journal lines belongs on.
    const mode = orderMode(doc)
    const paper = mode === 'paper'
    // The broker for THIS document — the simulator for a paper order, the real
    // adapter for everything else. Resolved once per placement so every tranche
    // of one order goes to the same place.
    const routed = routedOf(await ports.adapterFor(doc))
    const adapter = routed.adapter
    const { plan, tranches } = planFor(order, clientOrderId, doc)

    if (plan.rejected !== null) {
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason: plan.rejected, phase: 'INVALID', label: 'INVALID', mode,
      })
      return
    }

    /**
     * No freeze limit means the order goes out as ONE order however large it
     * is, and on live the exchange rejects anything over the volume freeze
     * outright — `xtsOrder.js:104` all over again. That has to be VISIBLE,
     * and the way it was made visible was wrong: a second PLANNED row,
     * `ok: false, errorClass: 'fatal'`, for an order that was about to be
     * placed and (on paper) filled. The web paints an order by its first
     * `!ok` event, so on 2026-09-16/17 all 34 SENSEX paper orders rendered
     * REJECTED in red though every one of them filled (spec D5).
     *
     * The order is OK WITH A CAVEAT, and the journal now says exactly that:
     * ONE `ok: true` row, the sentence in `warning`, `detail.freezeUnknown`
     * for anything that wants to count them. The loudness lives where it is
     * read in time — the once-per-book log line below and the `unsplit`
     * badge the book page puts on the row. A NIFTY row, whose limit is
     * known, journals byte-for-byte what it always has.
     */
    const freezeWarning = plan.freezeUnknown
      ? freezeUnknownReason({
          underlying: plan.underlying,
          underlyingSource: plan.underlyingSource,
          // The CONTRACT's exchange, which is what decides whether the
          // NSE-sourced table could ever have carried this underlying at all.
          exchange: ports.resolveContract(order.tradingsymbol)?.exchange ?? '',
          lots: plan.tranches[0] ?? 0,
        })
      : null

    await journal.record({
      clientOrderId, phase: 'PLANNED', ok: true, tag: order.tag,
      tradingsymbol: order.tradingsymbol, ts: now(), mode,
      ...(freezeWarning === null ? {} : { warning: freezeWarning }),
      detail: {
        tranches: plan.tranches,
        orders: plan.intents.length,
        underlying: plan.underlying,
        underlyingSource: plan.underlyingSource,
        ...(freezeWarning === null ? {} : { freezeUnknown: true }),
        // WHICH RAIL, and why — present when the router answered (the DX gateway).
        ...(routed.rail === null ? {} : { rail: routed.rail }),
        ...(routed.note === '' ? {} : { railNote: routed.note }),
        // Present only for a gated order, so an ungated one journals exactly
        // what it always has.
        ...(tranches === null
          ? {}
          : {
              workTranche: `${tranches.cursor + 1}/${tranches.plan.length}`,
              tranchePlan: tranches.plan.map((t) => t.qty),
            }),
      },
    })

    if (freezeWarning !== null) {
      const key = `${order.tag}|${plan.underlying}`
      if (!warnedFreeze.has(key)) {
        warnedFreeze.add(key)
        log(`FREEZE LIMIT UNKNOWN ${order.tradingsymbol} [${clientOrderId}]: ${freezeWarning}`)
      } else {
        log(`FREEZE LIMIT UNKNOWN ${order.tradingsymbol} [${clientOrderId}]: unsplit (freeze unknown, see first warning)`)
      }
    }

    /**
     * The Delta caps — per-order contracts and notional — refused HERE, before
     * any gate that could route the order, on paper and live alike. A close is
     * exempt (`dxCapRefusal`): it goes out reduce-only and cannot add exposure.
     */
    const capped = ports.capRefusal?.(order, ports.resolveContract(order.tradingsymbol)) ?? null
    if (capped !== null) {
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason: capped, phase: 'FAILED', errorClass: 'fatal', label: 'CAPPED', mode,
      })
      return
    }

    /**
     * Delta's open-interest cap, asked of the WHOLE opening package before its
     * first leg goes out (`dx-oicap.ts`): a straddle with one leg on a product
     * in reduce-only mode would fill the other leg alone.
     */
    const oiCapped = (await ports.oiCapRefusal?.(order, clientOrderId, routed.rail)) ?? null
    if (oiCapped !== null) {
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason: oiCapped, phase: 'FAILED', errorClass: 'fatal', label: 'OI-CAP', mode,
      })
      return
    }

    /**
     * Gate 5: the broker link. When an operator has released the live broker,
     * EVERY live order is refused here, exits included: this is not a rule
     * about exposure, it is the absence of a broker. Paper is not asked.
     */
    const linkRefusal = paper ? null : ports.linkRefusal()
    if (linkRefusal !== null) {
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason: linkRefusal, phase: 'FAILED', errorClass: 'fatal', label: 'BLOCKED', mode,
      })
      return
    }

    /**
     * Gate 2: the tag must be allowlisted HERE too, not only in the bridge.
     * Two independent processes each refusing by default is what keeps a
     * misconfiguration from becoming a live order.
     *
     * NOT ASKED OF A PAPER ORDER, and this is the one gate that is genuinely
     * live-only. The allowlist answers "may this tag spend real money" — the
     * Strategies page's LIVE switch, password-gated. A simulated order spends
     * none, and refusing it would make the rehearsal test the operator's switch
     * position instead of the desk's logic: every paper book would need its
     * LIVE toggle on to rehearse, which is precisely the toggle nobody should
     * be flipping to run a rehearsal.
     *
     * Every OTHER gate below still applies to paper — the kill switch, the
     * staleness bound, the freeze split, the tranche cursor — because those are
     * statements about the desk's behaviour and D14 is that the action path
     * must match.
     *
     * AND IT IS NEVER ASKED OF AN EXIT. Spec §9: switching a tag off blocks new
     * exposure and NEVER AN EXIT. Every other gate on this path already holds
     * that line — `haltsQueuedOrder` exempts the exposure-reducing ops from the
     * kill switch, `refusesStaleOrder` exempts them from the age bound — and
     * this one did not, which is the whole defect below.
     *
     * THE TRACE THIS EXISTS FOR (C-1). `LiveRail` gained its own exit exemption
     * (`rail.ts:#exits`, derived from the stored legs, not claimed by the
     * caller), so a switched-off live tag's close now passes the FIRST gate and
     * lands in `desk-gateway-orders`. desk-api counts it routed
     * (`partitionRoutedFills`), folds the book as closed and writes the
     * recomputed legs back; the supervisor settles the decision DONE. Then this
     * gate refused it. NOTHING UN-BOOKS A GATEWAY REFUSAL, so the desk read
     * FLAT against a position still live at the broker — for up to 60s, until
     * the next broker sync — and the supervisor's `cumRealized` and `rcStack`
     * kept the phantom close permanently. A regression against master, where
     * `LiveRail` threw before anything was folded and the operator saw a clean
     * route error.
     *
     * THE PASS LIST IS EXACTLY WHAT THE RAIL's `#exits` CAN PASS: `close` and
     * `resize`, no more and no less.
     *
     *   NOT `reducesExposure` — it also admits `roll`, which `#exits` refuses
     *   whole (a roll's second fill is new exposure wearing the old leg's tag).
     *   This gate must never be LOOSER than the rail's.
     *
     *   BUT NOT `close` ALONE EITHER. `#exits` passes a SHRINKING resize, and a
     *   gate tighter than the rail re-creates C-1 exactly for resizes: the rail
     *   admits it, desk-api folds the shrink, this gate refuses, the book is
     *   wrong again. A `desk_op: 'resize'` that reaches this line on a
     *   switched-off tag is shrinking BY CONSTRUCTION — the rail already
     *   refused the growing ones, using the book that this process cannot see.
     *
     * The literal ops, not a helper, because the two lists must be read
     * together and a shared helper would let one move without the other.
     */
    if (
      !paper &&
      order.desk_op !== 'close' &&
      order.desk_op !== 'resize' &&
      !(await ports.allowsLive(order.tag))
    ) {
      const reason =
        `tag '${order.tag}' is not switched on for LIVE on the Strategies page; not placed`
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason, phase: 'FAILED', errorClass: 'fatal', label: 'BLOCKED', mode,
      })
      return
    }

    /**
     * Gate 3: the kill switch, read HERE as well as in the bridge.
     *
     * The bridge checks at WRITE time, so an order already queued when the halt
     * engages — or one orphaned by a gateway outage and swept up later — was
     * placed anyway. Same governing rule as `apps/api/src/safety.ts`: a halt
     * stops NEW EXPOSURE and never blocks an exit, and the only exposure signal
     * this process has is the document's own `desk_op`. See `haltsQueuedOrder`
     * for why the fail-closed rule applies to `open` and to nothing else.
     */
    const halt = await ports.readHalt()
    if (haltsQueuedOrder(order.desk_op, halt.state)) {
      const reason =
        `kill switch engaged${halt.reason === '' ? '' : ` (${halt.reason})`}; queued order not placed`
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason, phase: 'FAILED', errorClass: 'fatal', label: 'HALTED', mode,
      })
      return
    }

    /**
     * Gate 4: a stale queued order that ADDS exposure is refused, not placed at
     * any price. Its marketable limit was priced off a mark that is now
     * `orderMaxAgeMs` old, and the writer's own retry/replay machinery re-plans
     * with fresh pricing — whereas placing it executes a price nobody chose.
     *
     * An EXIT is exempt: nothing un-books a refusal, so refusing a close leaves
     * the desk reading flat against a live position. See `refusesStaleOrder`,
     * and for why an absent `createdAt` never trips, `isStaleOrder`.
     *
     * A LATER TRANCHE IS MEASURED FROM WHEN IT WAS ARMED (`trancheArmedAt`),
     * not from when the desk order was written. A nine-lot order worked three
     * lots at a time can outlive the age bound between its first slice and its
     * last, and refusing the remainder would leave the desk holding a third of
     * a position, with the rest never worked and the document INVALID — the
     * same asymmetry `refusesStaleOrder` already makes for exits, and worse
     * here because the position is real by then. The chaser re-prices whatever
     * does go out.
     */
    const nowMs = now()
    const armedAt = Number(doc['trancheArmedAt'] ?? 0)
    const createdAt = armedAt > 0 ? armedAt : Number(doc['createdAt'] ?? 0)
    const ageMs = nowMs - createdAt
    if (refusesStaleOrder(order.desk_op, createdAt, nowMs, ports.orderMaxAgeMs)) {
      const reason =
        `order is ${Math.round(ageMs / 1000)}s old (limit ${Math.round(ports.orderMaxAgeMs / 1000)}s) — ` +
        `refused as stale, re-submit for fresh pricing`
      await refuseSlice(laterSlice(tranches), {
        clientOrderId, tag: order.tag, tradingsymbol: order.tradingsymbol,
        reason, phase: 'FAILED', errorClass: 'fatal', label: 'STALE', mode,
      })
      return
    }

    /**
     * HOW THIS ORDER WILL BE WORKED, written before its first tranche goes out.
     *
     * BEFORE `markPlacing`, so a crash between the two leaves a plan on a
     * document that has placed nothing — harmless, and re-read rather than
     * recomputed on the next claim. Written after it, the first slice could go
     * out against a plan no reclaim could ever see, and the cursor would then
     * name a slice of a plan computed a second time from reference data that
     * has moved.
     */
    if (tranches !== null && tranches.fresh) {
      await queue.writeTranchePlan(clientOrderId, tranches.plan)
      log(
        `TRANCHED ${order.tradingsymbol} [${clientOrderId}]: ${plan.expectedQty} in ` +
          `${tranches.plan.length} tranches of ${tranches.plan.map((t) => t.qty).join('/')} — ` +
          `one live at the broker at a time`,
      )
    }

    // BEFORE the first tranche, never after: this marker is what tells a later
    // reclaim that a placement was interrupted rather than never started.
    await queue.markPlacing(clientOrderId)
    onPlacementStarted()

    const brokerIds: string[] = []
    const failedTrancheIds: string[] = []
    /**
     * Tranches whose outcome we never learned (F-3).
     *
     * SEPARATE FROM `failedTrancheIds` because the two mean opposite things to
     * the aggregate: a failed tranche is terminal with zero fill, an ambiguous
     * one may be live at the exchange. Left out of `failed`, it counts as
     * WORKING, the desk order stays PLACED — non-terminal — and the broker
     * sweep settles it from the broker's own book. Nothing about it is retried:
     * a retry is how one timeout becomes two positions.
     */
    const ambiguousTrancheIds: string[] = []
    for (const intent of plan.intents) {
      // Before anything can fill: the watcher must be able to name the CONTRACT
      // for an update whose PlacedOrder carries no symbol.
      fills.rememberSymbol(intent.clientOrderId, intent.instrument.tradingsymbol)
      await journal.record({
        clientOrderId: intent.clientOrderId, phase: 'SUBMITTED', ok: true, tag: order.tag,
        tradingsymbol: intent.instrument.tradingsymbol, ts: now(), mode,
        detail: { lots: intent.lots, quantity: intent.quantity, orderType: intent.orderType },
      })
      try {
        const placed = await adapter.placeOrder(intent)
        brokerIds.push(placed.brokerOrderId)
        await journal.record({
          clientOrderId: intent.clientOrderId, phase: 'ACK', ok: true, tag: order.tag,
          tradingsymbol: intent.instrument.tradingsymbol, ts: now(), mode,
          brokerOrderId: placed.brokerOrderId, status: placed.status,
        })
        log(`ACK ${intent.instrument.tradingsymbol} [${intent.clientOrderId}] broker=${placed.brokerOrderId}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        /**
         * The CLASS the adapter decided, not one re-derived from the text.
         *
         * `BrokerOrderError` (Delta's `DxOrderError` is one) carries it because
         * `unknown` and `fatal` are both thrown without a retry and are
         * indistinguishable afterwards by message alone. Falling back to a
         * fresh classification covers the simulator and anything thrown before
         * the adapter is reached.
         */
        const errorClass =
          err instanceof BrokerOrderError ? err.klass : classifyBrokerError(message)
        if (errorClass === 'unknown') {
          /**
           * WE DO NOT KNOW WHETHER THIS ORDER IS LIVE (F-3).
           *
           * A timeout, an aborted request, a dropped socket: the response never
           * came back, which says nothing about whether the request arrived.
           * Booking it as failed — what this used to do, because every network
           * fault classified as `fatal` — marks the desk order REJECTED and
           * Python's reconcile un-books an open that may be real, after which
           * the next decision trades against a book that does not exist.
           *
           * So: no retry (that double-places), no failure (that un-books), and
           * the desk order stays non-terminal until the broker's own book says
           * which it was.
           */
          ambiguousTrancheIds.push(intent.clientOrderId)
          await journal.record({
            clientOrderId: intent.clientOrderId, phase: 'FAILED', ok: false, tag: order.tag,
            tradingsymbol: intent.instrument.tradingsymbol, ts: now(), mode,
            error: `placement outcome UNKNOWN — resolving from the broker book: ${message}`,
            errorClass: 'unknown', raw: safeRaw(err),
          })
          log(
            `UNKNOWN ${intent.instrument.tradingsymbol} [${intent.clientOrderId}]: ${message} — ` +
              `held ambiguous, NOT retried and NOT booked as failed`,
          )
        } else {
          // No order update will EVER arrive for this tranche, so the aggregate
          // has to know it is terminal — otherwise the desk order waits on it for
          // the rest of the session and never resolves.
          failedTrancheIds.push(intent.clientOrderId)
          await journal.record({
            clientOrderId: intent.clientOrderId, phase: 'FAILED', ok: false, tag: order.tag,
            tradingsymbol: intent.instrument.tradingsymbol, ts: now(), mode,
            error: message, errorClass, raw: safeRaw(err),
          })
          log(`FAILED ${intent.instrument.tradingsymbol} [${intent.clientOrderId}]: ${message}`)
        }
        // Keep going: one rejected tranche must not abandon the others, which
        // may already be live at the broker.
      }
      // The claim must outlive the placement. Three retries x a 15s transport
      // timeout, per tranche, is minutes for a frozen index order — long enough
      // for a second gateway to reclaim it MID-FLIGHT and place it again.
      // Refreshing here bounds the timeout to the gap between two tranches.
      let stillOurs = true
      try {
        stillOurs = await queue.heartbeat(clientOrderId)
      } catch (err) {
        // A failed heartbeat is a wider reclaim window, not a reason to abandon
        // tranches that are already at the broker. Unknown is not "lost".
        log(`claim heartbeat failed [${clientOrderId}]`, { error: String(err) })
      }
      if (!stillOurs) {
        /**
         * The claim moved to a reclaimer while this placement was in flight.
         *
         * STOP HERE. From this moment the reclaimer's `recoverInterrupted` owns
         * the outcome, and it resolves from the journal — so every further
         * tranche this worker sends is a live position nothing will account for.
         * `markPlaced` is skipped for the same reason: the fence would refuse it
         * anyway, and the outcome the reclaimer wrote is the one that stands.
         */
        log(
          `LOST CLAIM ${order.tradingsymbol} [${clientOrderId}]: lost the claim mid-placement — ` +
            `stopping; the reclaimer's recovery owns the outcome`,
          { placed: brokerIds.length, planned: plan.intents.length },
        )
        return
      }
    }
    await queue.markPlaced(clientOrderId, {
      brokerOrderIds: brokerIds,
      trancheIds: plan.intents.map((i) => i.clientOrderId),
      failedTrancheIds,
      ambiguousTrancheIds,
      expectedQty: plan.expectedQty,
      /**
       * A LATER TRANCHE ADDS to what the document holds. Replacing would delete
       * the ids of the tranches that have already FILLED, and the aggregate
       * would then wait forever on tranches whose names it no longer knows —
       * the desk order stuck PLACED while the broker held it done.
       */
      ...(isLaterSlice(tranches) ? { append: true } : {}),
    })
    // A fill can land before `markPlaced` writes the tranche list, in which case
    // the watcher could not decide and left the order PLACED. Re-decide now that
    // it can. Also what resolves an order whose every tranche was refused — and,
    // for a gated order, what releases the NEXT tranche when this one filled
    // before the ink was dry.
    await fills.reconcile(clientOrderId)
  }

  const processOne = async (doc: Record<string, unknown>): Promise<void> => {
    const order = doc as unknown as GatewayOrderDoc
    const clientOrderId = String(doc['clientOrderId'] ?? '')

    /**
     * A reclaimed order whose previous attempt already began placing must NEVER
     * be re-placed wholesale. `placementStartedAt` is written BEFORE the first
     * tranche goes out, so its presence on a claim means "a placement was
     * interrupted", never "nothing was sent".
     *
     * A tranche ADVANCE clears the marker (`advanceTranche`), because the next
     * slice is a placement that has not started. Leaving it set would route
     * every tranche after the first into recovery — which places nothing — and
     * the order would stop dead after tranche 1 with no error anywhere.
     */
    if (doc['placementStartedAt'] !== undefined) {
      await recoverInterrupted(doc, clientOrderId)
      return
    }

    /**
     * The whole placement is inside a catch, because a throw used to leave the
     * document CLAIMED forever: the sweeper logs and moves on, the claim goes
     * stale, and the order is reclaimed and re-planned every timeout — an
     * unbounded duplicate-placement loop off one `splitIntoTranches` throw or one
     * Mongo blip inside `markPlaced`.
     *
     * The two halves are transitioned differently ON PURPOSE. Before the first
     * tranche nothing is at the broker, so INVALID is the truthful terminal
     * state. After it, the placement marker is already written, so leaving the
     * document CLAIMED is SAFE: the next reclaim routes into `recoverInterrupted`
     * and resolves from the journal. That is the conversion this guard buys — an
     * unbounded duplicate loop becomes a bounded recovery.
     */
    let placementStarted = false
    try {
      await placeOne(order, clientOrderId, doc, () => {
        placementStarted = true
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (placementStarted) {
        log(
          `CRITICAL ${order.tradingsymbol} [${clientOrderId}]: threw AFTER placement began (${message}) — ` +
            `left CLAIMED; the next sweep recovers it from the journal and re-places NOTHING`,
        )
        return
      }
      log(`processing threw before anything was placed ${order.tradingsymbol} [${clientOrderId}]: ${message}`)
      try {
        await queue.markInvalid(clientOrderId, `processing threw: ${message}`)
      } catch (markErr) {
        // The doc stays CLAIMED and is reclaimed after the timeout. Nothing was
        // placed, so re-planning it then is the correct outcome.
        log(`could not mark [${clientOrderId}] INVALID`, { error: String(markErr) })
      }
    }
  }

  return { processOne }
}

/** How many broker orders this document has already produced. */
function asIdCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0
}

/**
 * Has this document already completed tranches, and if so which slice is it on?
 *
 * The cursor, not the tranche ids: ids exist the moment the FIRST slice is
 * placed, while a moved cursor means an earlier slice went terminal and filled.
 * Asked where the plan is not to hand (the dead-letter branch runs before the
 * contract is resolved), and it answers the only question that matters there —
 * is there already a real position under this order?
 */
function completedSliceOf(doc: Record<string, unknown>): { readonly cursor: number } | null {
  const cursor = Number(doc['trancheCursor'] ?? 0)
  return Number.isInteger(cursor) && cursor > 0 ? { cursor } : null
}

/**
 * The second-or-later slice of a gated order, or null.
 *
 * Non-null means two things at once, and both follow from the same fact that
 * earlier tranches have filled: this slice's writes APPEND rather than replace,
 * and a gate refusing it HALTS rather than invalidates.
 */
function laterSlice(tranches: TrancheState | null): { readonly cursor: number } | null {
  return tranches !== null && tranches.cursor > 0 ? { cursor: tranches.cursor } : null
}

/** Shorthand for the append decision, which only cares whether there IS one. */
function isLaterSlice(tranches: TrancheState | null): boolean {
  return laterSlice(tranches) !== null
}

/**
 * ONE `md.tick` FRAME, fanned out to everything on the order path that reads
 * the market.
 *
 * TWO CONSUMERS, ONE FRAME, and they must not be able to drift apart. The
 * QuoteMap is what a passive order PEGS to; the simulator is what CROSSES a
 * resting paper order. If a paper order could be filled by a print the peg
 * never saw — or pegged to a book the fill model did not — the rehearsal would
 * be testing two different markets, and D14 says the action path must match
 * live.
 *
 * The simulator takes the frame's `price`, which `apps/marketdata` already
 * defines as the last trade, falling back to the mid on a strike that has never
 * printed (`tickPayload`) — so a never-traded contract still has a crossing
 * price rather than a zero. A frame with no usable price is dropped rather than
 * fed as `NaN`, which every comparison in the fill model reads as "no".
 *
 * It takes the frame's book too, when both sides are real: a marketable paper
 * limit fills at the touch instead of resting until a print trades through it
 * (`SimulatorAdapter.feedTick`). BOTH SIDES OR NOTHING, the QuoteMap's own rule
 * — `md.tick` carries them both-or-neither — so a one-sided or junk book is
 * fed as a print alone, never as a half-book a fill could be taken from. A
 * crossed book is fed as it came and the simulator ignores it, as the QuoteMap
 * does, so the book the peg follows and the book the fill model takes are the
 * same book.
 *
 * Extracted from the bus subscription so a suite can publish a tick without
 * standing up a bus, which is the only way the fill half of the lifecycle can
 * be driven end to end.
 */
export function tickFanout(deps: {
  readonly quotes: { onTick(frame: unknown): void }
  /** Every simulator that may hold a resting order. Empty is legal. */
  readonly sims: readonly {
    feedTick(token: number, price: number, quote?: { bid: number | null; ask: number | null }): void
  }[]
}): (frame: unknown) => void {
  return (frame: unknown): void => {
    // `onTick` validates and never throws (the bus catches a throwing
    // subscriber, but this process places orders — it must not rely on that).
    deps.quotes.onTick(frame)
    if (frame === null || typeof frame !== 'object') return
    const f = frame as Record<string, unknown>
    const token = f['token']
    const price = f['price']
    if (typeof token !== 'number' || !Number.isFinite(token)) return
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return
    const bid = f['bid']
    const ask = f['ask']
    const book =
      typeof bid === 'number' && Number.isFinite(bid) && bid > 0 &&
      typeof ask === 'number' && Number.isFinite(ask) && ask > 0
        ? { bid, ask }
        : null
    for (const sim of deps.sims) {
      try {
        // No third argument at all when there is no book, rather than an
        // explicit `undefined`: a simulator, or a stand-in, that counts its
        // arguments sees exactly the call it always saw.
        if (book === null) sim.feedTick(token, price)
        else sim.feedTick(token, price, book)
      } catch {
        /* a simulator that threw must not cost the QuoteMap its frame */
      }
    }
  }
}

export async function main(): Promise<void> {
  // Installed FIRST: a rejection escaping anything below would otherwise kill
  // the process, and the boot path is where the least is wired up to catch one.
  installCrashGuards({ process, log })

  const mongoUrl = process.env['DESK_MONGO_URL']
  if (mongoUrl === undefined || mongoUrl.trim() === '') throw new Error('DESK_MONGO_URL is required')
  const busUrl = process.env['DESK_BUS_URL'] ?? 'ws://127.0.0.1:8891'
  const workerId = process.env['DESK_WORKER_ID'] ?? `gw-${process.pid}`
  const idleSweepMs = positiveEnvMs('DESK_SWEEP_MS', 5000)

  /**
   * THE TOUCH — this process's own live book, token by token.
   *
   * Built here, ahead of everything that uses it, and fed by the ONE
   * unconditional `md.tick` subscription at the bottom of this function. It is
   * what lets a passive order join the market instead of crossing it; a
   * gateway whose bus is down simply holds an empty map, and every passive
   * order pauses rather than falling back to crossing (see `quote-map.ts` and
   * peg mode in `order-chaser.ts`).
   */
  const quotes = createQuoteMap({
    now: () => Date.now(),
    maxAgeMs: quoteMaxAgeFromEnv(process.env),
  })

  /**
   * Gate 2, refusing independently of the bridge — but now reading the same
   * SOURCE as gate 1: the password-gated `modes.live` switch on the Strategies
   * page, not an env var each process had to be restarted to pick up.
   *
   * The two gates were never independent in their DATA (both read one shared
   * env var); they are independent in PROCESS, and that is unchanged. What is
   * gone is the restart, and the failure mode where one process had the new
   * value and the other did not.
   *
   * `DESK_LIVE_TAGS` remains only as a box-level pin that can narrow the set.
   * Empty now means "no extra restriction", the inverse of its old meaning.
   */
  const livePin = new Set(
    (process.env['DESK_LIVE_TAGS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
  )
  if (livePin.size > 0) {
    log('live rail PINNED to a subset by DESK_LIVE_TAGS', { tags: [...livePin] })
  } else {
    log('live rail governed by the Strategies page switch (no DESK_LIVE_TAGS pin)')
  }

  // A retrying boot must still be stoppable. Without this, `pm2 stop` on a
  // gateway waiting for Mongo would hang until pm2's kill timeout every time.
  let booted = false
  const bailOut = (signal: string): void => {
    if (booted) return
    log(`${signal} received while still booting — exiting`)
    process.exit(0)
  }
  process.on('SIGTERM', () => bailOut('SIGTERM'))
  process.on('SIGINT', () => bailOut('SIGINT'))

  // RETRY, NEVER EXIT. Exiting here is what made a 30-second Mongo outage a
  // permanent one: each attempt died inside pm2's `min_uptime`, so ten of them
  // spent the whole restart budget in ~70 seconds and pm2 stopped trying. See
  // resilience.ts (G6). SIGTERM below is what still lets an operator stop it.
  const mongo = await connectWithRetry(() => connectMongo(mongoUrl), {
    log,
    what: 'Mongo',
    ...(process.env['DESK_BOOT_MAX_ATTEMPTS'] === undefined
      ? {}
      : { maxAttempts: Number(process.env['DESK_BOOT_MAX_ATTEMPTS']) }),
  })
  // Gate 2's resolver — built here because it needs the Mongo handle. See the
  // `livePin` block above for why the allowlist moved off the environment.
  const allowsLive = liveAllowlistFromStrategies(
    mongo.db.collection('desk-strategies'),
    livePin,
  )
  /**
   * Gate 3's source: the same `desk-safety` document `apps/api/src/store.ts`
   * reads and writes. Read HERE as well as in the bridge because the bridge only
   * checks at WRITE time — an order already queued when the halt engages, or one
   * orphaned by a gateway outage, was placed anyway on the next sweep.
   */
  const safety = mongo.db.collection('desk-safety')
  const readHalt = async (): Promise<{ state: HaltState; reason: string }> => {
    try {
      const doc = (await safety.findOne({ _id: 'killswitch' as never })) as
        | { enabled?: boolean; reason?: string }
        | null
      return { state: doc?.enabled === true ? 'on' : 'off', reason: String(doc?.reason ?? '') }
    } catch (err) {
      // Unreadable, not "off". `haltsQueuedOrder` decides what that costs, and
      // it costs it only to orders that ADD exposure.
      return { state: 'unreadable', reason: `kill-switch state unreadable: ${String(err)}` }
    }
  }
  /**
   * How old a queued order that ADDS exposure may be before it is refused rather
   * than placed. See `refusesStaleOrder` for why a refusal beats a placement at
   * a mark nobody chose — and why an exit is never refused for age.
   *
   * The default deliberately EXCEEDS `CLAIM_TIMEOUT_MS`; see the constant.
   */
  const orderMaxAgeMs = positiveEnvMs('DESK_ORDER_MAX_AGE_MS', DEFAULT_ORDER_MAX_AGE_MS)
  const queue = new OrderQueue({
    collection: mongo.db.collection('desk-gateway-orders') as never,
    workerId,
    now: () => Date.now(),
    log,
  })
  await queue.ensureIndexes()

  /**
   * Is this BROKER order id one of the simulator's? One question, one answer,
   * asked by both cancel drains — the live one to skip it and the paper one to
   * claim it. Two copies of the predicate would eventually disagree, and the
   * way they would disagree is that both drains handle one row.
   *
   * An id we cannot resolve is NOT paper: the live drain then treats it exactly
   * as it always has, which is the behaviour that predates paper orders.
   */
  const isPaperBrokerOrder = async (brokerOrderId: string): Promise<boolean> => {
    try {
      const doc = await queue.getByBrokerOrderId(brokerOrderId)
      return doc !== null && isPaperOrder(doc)
    } catch {
      return false
    }
  }
  /** Is this broker order id a demo-rail (testnet) paper order? Asked only of paper ids. */
  const isDemoBrokerOrder = async (brokerOrderId: string): Promise<boolean> => {
    try {
      const doc = await queue.getByBrokerOrderId(brokerOrderId)
      return doc !== null && isPaperOrder(doc) && stampedPaperRail(doc) === 'demo'
    } catch {
      return false
    }
  }

  /**
   * Every journalled event is also pushed to `desk-api`, which fans it out to
   * any dashboard watching the LIVE rail.
   *
   * BEST EFFORT AND UNABLE TO AFFECT AN ORDER — see `notify.ts`. It returns
   * void, swallows every failure, and carries its own timeout, so the worst a
   * dead bridge can do is leave the dashboard on its 10-second REST polling,
   * which it says on screen.
   */
  const journal = new OrderJournal({
    collection: mongo.db.collection(ORDER_EVENTS_COLLECTION) as never,
    notify: createDeskNotifier({
      url: process.env['DESK_API_URL'] ?? 'http://127.0.0.1:8890',
      token: process.env['DESK_API_TOKEN'] ?? '',
      log,
    }),
  })
  await journal.ensureIndexes()

  /**
   * Every refusal below goes through this — see `refuse`. Bound once, here,
   * because the ports never change for the life of the process.
   */
  const refuseOrder = refuse({ journal, queue, log })

  let master = new OptionMaster([])
  let freeze = await loadFreezeLimits(mongo.db.collection('desk-freeze-limits'))
  /**
   * tradingsymbol -> the dump's `name`, i.e. the AUTHORITATIVE freeze key.
   *
   * Kept alongside the master because `OptionMaster` resolves to an
   * `InstrumentRef`, which does not carry `name`. Deriving the underlying from
   * the symbol instead is what produced `NIFTYNXT` for `NIFTYNXT50…` and a
   * freeze lookup that missed — see `gateway.ts:deriveUnderlying`.
   */
  let underlyingBySymbol = new Map<string, string>()

  const loadReference = async (): Promise<void> => {
    const rows = await loadStoredInstruments(mongo.db.collection('instrument'))
    master = new OptionMaster(rows)
    underlyingBySymbol = new Map(
      rows.filter((r) => r.tradingsymbol !== '' && r.name !== '').map((r) => [r.tradingsymbol, r.name]),
    )
    freeze = await loadFreezeLimits(mongo.db.collection('desk-freeze-limits'))
  }
  await loadReference()
  log('reference data loaded', {
    contracts: master.optionCount,
    freezeSymbols: freeze.size,
    underlyings: underlyingBySymbol.size,
  })

  const refreshRef = setInterval(() => {
    void (async () => {
      try {
        await loadReference()
      } catch (err) {
        log('reference refresh failed, keeping previous', { error: String(err) })
      }
    })()
  }, positiveEnvMs('DESK_REF_REFRESH_MS', 15 * 60_000))
  refreshRef.unref()

  /**
   * Broker mode: `simulate` (default) or `delta` (`dx-edge.ts`). A typo stops
   * the boot rather than guessing.
   *
   * `simulate` exists so the ENTIRE live path — durable write, nudge, claim,
   * plan, placement, fill correlation, journal — can be exercised with no
   * Delta account and no real money. The simulator implements the same
   * `BrokerAdapter` interface and fills at the touch (a sell at the bid, a buy
   * at the ask) when the book crosses, charging Delta's fee on DX.
   *
   * `delta` builds the Delta adapter ONLY when `DESK_DX_LIVE=1` too. Without
   * it the whole gateway simulates, whatever the documents say.
   */
  const brokerMode = brokerModeFromEnv(process.env)
  const liveRail = liveRailEnabled(process.env)
  const venue = venueFromEnv(process.env)
  const onDx = venue.id === 'dx'
  /**
   * The latest `.DEXBTUSD` index, from `md.spot` underlying BTC. The fee
   * model's notional and the notional cap read it; null until the feed speaks.
   */
  let btcIndex: number | null = null
  /**
   * THE PAPER BROKER, BUILT UNCONDITIONALLY (D14). It serves every document
   * that is not routed to Delta — on a simulate box, all of them.
   *
   * On DX it charges Delta's option fee at the price each fill took, and echoes
   * the Delta product id as the exchange token (Delta ids are not packed).
   */
  const paperAdapter = new SimulatorAdapter({
    slippage: Number(process.env['DESK_SIM_SLIPPAGE'] ?? 0),
    ...(onDx ? { feeModel: dxSimFee(() => btcIndex, log), packedTokens: false } : {}),
  })
  let adapter: BrokerAdapter = paperAdapter
  /** The live Delta adapter, or null — `chooseAdapter` never routes to null. */
  let dxAdapter: DxAdapter | null = null
  let dxRest: DxRest | null = null
  /** Delta's private socket (order updates). Null unless the live rail is on. */
  let privateSocket: DxPrivateSocket | null = null
  /** The demo rail's private socket, on Delta's testnet. Null until that rail is built. */
  let demoSocket: DxPrivateSocket | null = null
  /** Production's key, so the demo rail can refuse to run on the same one. */
  let liveApiKey: string | undefined
  /**
   * Arms the broker-book sweep, once the fill watcher it replays into exists.
   * A no-op in simulate mode — the simulator's book is our own invention.
   */
  let startBrokerSweep: (fills: FillWatcher) => void = () => {}
  /**
   * Is anything going to answer an AMBIGUOUS tranche? True exactly when the
   * sweep timer has actually been armed.
   */
  let brokerSweepArmed = false

  /** Delta's dead-man switch and REST host, for the Status heartbeat. Null in simulate mode. */
  let dxDeadman: { readonly healthy: boolean } | null = null
  let dxHost: string | null = null

  if (brokerMode === 'delta' && !liveRail) {
    log('BROKER MODE: delta, but DESK_DX_LIVE is not 1 — EVERY order is simulated; no Delta session is opened')
  }
  if (!liveRail) {
    log('BROKER MODE: simulate — no real orders will be placed')
  } else {
    const cfg = await loadDxConfig(() => readDeltaBrokerStore(mongo.db as never, log), process.env, log)
    const rest = new DxRest({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      userAgent: DX_USER_AGENT,
    })
    dxRest = rest
    liveApiKey = cfg.apiKey
    const live = new DxAdapter({ rest, log })
    dxAdapter = live
    adapter = live
    log('BROKER MODE: delta — LIVE ORDERS ARE POSSIBLE for documents with mode: live')

    /**
     * Delta's dead-man switch: Delta cancels every open BTC option order if
     * this process stops acking (ttl 30 s, acked every 10 s).
     */
    const heartbeat = createDxHeartbeat({ rest, log })
    void heartbeat.beat()
    const hbTimer = setInterval(() => void heartbeat.beat(), DX_HEARTBEAT_MS)
    hbTimer.unref()
    dxDeadman = heartbeat
    dxHost = hostOf(cfg.baseUrl)

    /** Delta's positions for Status' Positions truth (`gateway-heartbeat.ts`). */
    const positionsSnapshot = createDeltaPositionsSnapshot({
      positions: () => live.positions(),
      collection: mongo.db.collection(BROKER_SNAPSHOT_COLLECTION) as never,
      now: () => Date.now(),
      host: dxHost,
      log,
    })
    void positionsSnapshot.take()
    const snapTimer = setInterval(() => void positionsSnapshot.take(), DELTA_SNAPSHOT_MS)
    snapTimer.unref()

    /** Order updates as they happen; the broker sweep below is the fallback. */
    privateSocket = new DxPrivateSocket(cfg.wsUrl, {
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      onFrame: (f) => {
        if (f.kind === 'other') live.onPrivateFrame(f.raw)
      },
      onState: (state) => log(`Delta private socket ${state}`),
    })
    privateSocket.subscribe('orders', ['all'])

    /**
     * Cancel requests desk-api writes, performed here because this process
     * owns the Delta key. A paper order's cancel is the paper drain's.
     */
    const cancels = mongo.db.collection(CANCEL_COLLECTION)
    const drainCancels = async (): Promise<void> => {
      try {
        const pending = (await cancels.find({ status: 'pending' }).toArray()) as unknown as { _id: string }[]
        for (const req of pending) {
          const id = String(req._id)
          if (await isPaperBrokerOrder(id)) continue
          let ok = false
          let error = ''
          try {
            ok = await live.cancelOrder(id)
            if (!ok) error = 'Delta is not holding this order open — it has already filled or been cancelled'
          } catch (err) {
            error = err instanceof Error ? err.message : String(err)
          }
          await cancels.updateOne(
            { _id: id as never },
            { $set: { status: ok ? 'done' : 'failed', finishedAt: Date.now(), error } },
          )
          log(ok ? 'cancel done' : 'CANCEL FAILED', { brokerOrderId: id, detail: error })
        }
      } catch (err) {
        log('cancel drain failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    const cancelTimer = setInterval(() => void drainCancels(), CANCEL_POLL_MS)
    cancelTimer.unref()

    /**
     * THE BROKER-BOOK SWEEP (F-1), over Delta's own order book. The LIVE queue
     * only: `{mode: 'live'}` is exactly what `chooseAdapter` routes here.
     */
    startBrokerSweep = (fillWatcher: FillWatcher): void => {
      const sweep = createBrokerSweep(
        {
          adapter: live,
          queue,
          fills: fillWatcher,
          journal,
          orders: mongo.db.collection('desk-gateway-orders') as never,
          ordersFilter: { mode: 'live' },
          now: () => Date.now(),
          log,
        },
        {
          ambiguousTtlMs: positiveEnvMs('DESK_AMBIGUOUS_TTL_MS', DEFAULT_AMBIGUOUS_TTL_MS),
          workingAlertMs: positiveEnvMs('DESK_WORKING_ALERT_MS', DEFAULT_WORKING_ALERT_MS),
        },
      )
      const sweepTimer = setInterval(() => {
        void sweep.run().catch((err: unknown) => log('broker sweep threw', { error: String(err) }))
      }, positiveEnvMs('DESK_BROKER_SWEEP_MS', 45_000))
      sweepTimer.unref()
      brokerSweepArmed = true
      log('broker sweep armed — fills, ambiguous placements and resting orders reconcile from the Delta book')
    }
  }

  /**
   * PROOF OF LIFE for Status, in every broker mode — see `gateway-heartbeat.ts`.
   * The bridge reads the gateway as ok/stale from this row's age.
   */
  /** Late-bound: the demo rail is built further down. Null off DX. */
  let demoReadyNow: () => boolean | null = () => null
  const gatewayHeartbeat = createGatewayHeartbeat({
    collection: mongo.db.collection(GATEWAY_HEARTBEAT_COLLECTION) as never,
    events: mongo.db.collection(ORDER_EVENTS_COLLECTION) as never,
    now: () => Date.now(),
    startedAt: Date.now(),
    pid: process.pid,
    broker: liveRail ? 'delta' : 'simulate',
    host: dxHost,
    deltaHeartbeatOk: () => (dxDeadman === null ? null : dxDeadman.healthy),
    demoReady: () => demoReadyNow(),
    log,
  })
  void gatewayHeartbeat.beat()
  const gatewayBeatTimer = setInterval(() => void gatewayHeartbeat.beat(), GATEWAY_HEARTBEAT_MS)
  gatewayBeatTimer.unref()

  // --- fills: correlate broker updates back to our intents ----------------
  // All of the logic is in `FillWatcher`, deliberately. As a closure here it was
  // untestable, and the property that mattered most — one desk order is not
  // terminal until every tranche of it is — was tested against a function
  // production never called (`aggregateTranches`). See fills.ts.
  /**
   * "There is work waiting" — set by a tranche advance, consumed by the sweep.
   *
   * A LATE-BOUND HOOK because the sweeper is built further down (it needs
   * `processOne`, which needs this watcher). A no-op until then, which is the
   * correct behaviour and not a gap: an advance that cannot nudge is picked up
   * by the idle sweep on its next pass, exactly as a dropped bus nudge is.
   */
  let wakeSweeper: () => void = () => {}
  const fills = new FillWatcher({
    fills: mongo.db.collection(FILLS_COLLECTION) as never,
    queue,
    journal,
    now: () => Date.now(),
    log,
    wake: () => wakeSweeper(),
  })
  await fills.ensureIndexes()
  startBrokerSweep(fills)

  /**
   * THE DEMO RAIL (Delta venue only) — a paper book whose registry row says
   * `dx_paper_rail: 'demo'` is worked on Delta's India TESTNET with the
   * `delta-demo` credentials instead of on the simulator (`dx-demo.ts`).
   *
   * Built lazily: on the first demo order, or by the boot attempt below. Its
   * key goes to testnet hosts only (`loadDxDemoConfig`), and production's key
   * is never a fallback. Built, it gets what the live rail has: a private
   * socket feeding the same fill watcher, a dead-man switch (its own id), and
   * a broker sweep over testnet's book for the demo documents — paper rows.
   *
   * Every component that assumes "paper = the simulator's memory" is scoped
   * away from demo documents by their stamp (`notDemo` below).
   */
  let demoSweepArmed = false
  const gatewayOrders = mongo.db.collection('desk-gateway-orders')
  const demoRail: DemoRail | null = onDx
    ? new DemoRail({
        loadConfig: () =>
          loadDxDemoConfig(
            () => readDeltaBrokerStore(mongo.db as never, log, 'delta-demo'),
            process.env,
            log,
            liveApiKey === undefined ? {} : { liveApiKey },
          ),
        now: () => Date.now(),
        log,
        onBuilt: ({ rest, adapter: demoDx, cfg }) => {
          /**
           * The testnet account's positions, for Status' "Positions truth —
           * demo". Read through the testnet adapter itself: its product
           * symbols are the desk's tradingsymbols, so nothing is translated.
           */
          const demoSnapshot = createDeltaPositionsSnapshot({
            positions: () => demoDx.positions(),
            collection: mongo.db.collection(BROKER_SNAPSHOT_COLLECTION) as never,
            now: () => Date.now(),
            host: hostOf(cfg.baseUrl),
            log,
            id: DELTA_DEMO_SNAPSHOT_ID,
            broker: 'delta-demo',
          })
          void demoSnapshot.take()
          setInterval(() => void demoSnapshot.take(), DELTA_SNAPSHOT_MS).unref()
          const hb = createDxHeartbeat({ rest, log })
          void hb.beat()
          setInterval(() => void hb.beat(), DX_HEARTBEAT_MS).unref()
          demoSocket = new DxPrivateSocket(cfg.wsUrl, {
            apiKey: cfg.apiKey,
            apiSecret: cfg.apiSecret,
            onFrame: (f) => {
              if (f.kind === 'other') demoRail?.onPrivateFrame(f.raw)
            },
            onState: (state) => log(`Delta DEMO private socket ${state}`),
          })
          demoSocket.subscribe('orders', ['all'])
          if (demoRail === null) return
          const demoSweep = createBrokerSweep(
            {
              adapter: demoRail,
              rail: 'paper',
              queue,
              fills,
              journal,
              orders: gatewayOrders as never,
              ordersFilter: { mode: { $ne: 'live' }, dx_paper_rail: 'demo' },
              now: () => Date.now(),
              log,
            },
            {
              ambiguousTtlMs: positiveEnvMs('DESK_AMBIGUOUS_TTL_MS', DEFAULT_AMBIGUOUS_TTL_MS),
              workingAlertMs: positiveEnvMs('DESK_WORKING_ALERT_MS', DEFAULT_WORKING_ALERT_MS),
            },
          )
          setInterval(() => {
            void demoSweep.run().catch((err: unknown) => log('demo broker sweep threw', { error: String(err) }))
          }, positiveEnvMs('DESK_BROKER_SWEEP_MS', 45_000)).unref()
          demoSweepArmed = true
        },
      })
    : null
  if (demoRail !== null) demoReadyNow = () => demoRail.ready
  /** Merged into every simulator-scoped query: a demo document is not in the simulator's memory. */
  const notDemo: Record<string, unknown> = demoRail === null ? {} : { dx_paper_rail: { $ne: 'demo' } }

  /**
   * THE ORDER CHASER — the acting counterpart to the read-only broker sweep.
   *
   * The sweep tells somebody an order is resting (F-17); this reprices it at
   * the broker until it fills. Two modes, chosen per order document: a
   * `workMode: 'passive'` order PEGS to the QuoteMap's touch and crosses only
   * at its deadline; anything else escalates blindly off the ORIGINAL limit,
   * reading no market data at all. See order-chaser.ts for why each is shaped
   * the way it is — and why a passive order with no fresh quote pauses rather
   * than falling back to the blind ladder.
   *
   * Wired for ANY adapter that declares `capabilities.modify` — the simulator
   * does, so the whole chase path is exercised on paper before it ever moves a
   * live price. Checked here AND per-pass: `DESK_CHASE_DISABLED=1` at boot
   * never arms the timer, and the per-pass check inside `run()` means the safe
   * state does not depend on this wiring being the only gate.
   */
  /**
   * ONE CHASER PER RAIL, and the split exists for a blunt reason: a chase is a
   * `modifyOrder` against a BROKER ORDER ID, and a paper order's id (`sim-3`)
   * means nothing to Delta. A single chaser over the whole collection would send
   * reprices for simulated orders to the real broker — which either errors on
   * every pass or, far worse, names an id that happens to exist.
   *
   * So each chaser reads only its own rail's documents. In simulate mode the
   * two adapters are the same object, so there is exactly ONE chaser over the
   * whole collection and the behaviour is identical to what it always was.
   */
  const armChaser = (
    name: string,
    chaseAdapter: BrokerAdapter,
    ordersFilter?: Record<string, unknown>,
    /** Checked per pass by the chaser itself; the live rail adds the broker link. */
    disabled?: () => boolean,
  ): void => {
    if (!chaseAdapter.capabilities.modify) {
      log(`${name} order chaser not armed — adapter '${chaseAdapter.name}' cannot modify orders`)
      return
    }
    const chaser = createOrderChaser(
      {
        adapter: chaseAdapter,
        orders: mongo.db.collection('desk-gateway-orders') as never,
        cancels: mongo.db.collection(CANCEL_COLLECTION) as never,
        fills: mongo.db.collection(FILLS_COLLECTION) as never,
        journal,
        quotes,
        ...(ordersFilter === undefined ? {} : { ordersFilter }),
        ...(disabled === undefined ? {} : { disabled }),
        now: () => Date.now(),
        log,
      },
      chaseDialsFromEnv(process.env),
    )
    // `run()` never rejects (it catches its own errors), but the `.catch` is
    // kept anyway — same reasoning as the sweep timer above: this process's
    // survival must not depend on a promise made in another file.
    const chaseTimer = setInterval(() => {
      void chaser.run().catch((err: unknown) => log(`${name} order chaser threw`, { error: String(err) }))
    }, positiveEnvMs('DESK_CHASE_MS', 5_000))
    chaseTimer.unref()
    log(
      `${name} order chaser armed — passive orders peg to the touch, everything else escalates ` +
        'blindly (DESK_CHASE_DISABLED=1 to stop)',
    )
  }
  if (chaseDisabled(process.env)) {
    log('order chaser DISABLED by DESK_CHASE_DISABLED — resting orders will only be alerted on')
  } else {
    if (adapter === paperAdapter) {
      armChaser('simulate', adapter, demoRail === null ? undefined : notDemo)
    } else {
      // Each chaser reads exactly the documents its adapter holds: Delta the
      // exact-live ones, the simulator everything else but demo.
      armChaser('live', adapter, { mode: 'live' })
      armChaser('paper', paperAdapter, { mode: { $ne: 'live' }, ...notDemo })
    }
    // The demo rail's own: a testnet order id means nothing to the simulator.
    if (demoRail !== null) armChaser('demo', demoRail, { mode: { $ne: 'live' }, dx_paper_rail: 'demo' })
  }

  /**
   * A DASHBOARD CANCEL OF A PAPER ORDER, performed on the simulator.
   *
   * `POST /v1/desk/broker/orders/:id/cancel` writes one row keyed by the BROKER
   * order id and this process performs it. Paper orders now have broker ids
   * too (`sim-3`), and until this existed their cancel row had two possible
   * fates and both were wrong: on an xts box the live drain reported "already
   * gone" and marked it DONE while the order carried on working, and on a
   * simulate box nothing drained it at all.
   *
   * The simulator's own `cancelOrder` emits a CANCELLED update, which the fill
   * watcher aggregates as terminal-with-nothing-filled — so the desk order goes
   * REJECTED and `paper-fold.ts` settles the package that owns it. No second
   * path, and nothing here decides an outcome by itself.
   *
   * Armed unconditionally and polled at the same fast cadence as the live
   * drain: a cancel is what you reach for when something is wrong.
   */
  const paperCancels = mongo.db.collection(CANCEL_COLLECTION)
  const drainPaperCancels = async (): Promise<void> => {
    try {
      const pending = (await paperCancels
        .find({ status: 'pending' })
        .toArray()) as unknown as { _id: string }[]
      for (const req of pending) {
        const id = String(req._id)
        if (!(await isPaperBrokerOrder(id))) continue
        if (demoRail !== null && (await isDemoBrokerOrder(id))) {
          // A demo order rests on Delta's testnet, not in the simulator.
          let ok = false
          let error = ''
          try {
            ok = await demoRail.cancelOrder(id)
            if (!ok) error = 'the Delta testnet is not holding this order open — it has already filled or been cancelled'
          } catch (err) {
            error = err instanceof Error ? err.message : String(err)
          }
          await paperCancels.updateOne(
            { _id: id as never },
            { $set: { status: ok ? 'done' : 'failed', finishedAt: Date.now(), error } },
          )
          log(ok ? 'demo cancel done' : 'DEMO CANCEL FAILED', { brokerOrderId: id, detail: error })
          continue
        }
        const cancelled = await paperAdapter.cancelOrder(id)
        await paperCancels.updateOne(
          { _id: id as never },
          {
            $set: {
              // "Not resting any more" is a DONE cancel: the order is already
              // terminal and the watcher has, or will have, said so.
              status: cancelled ? 'done' : 'failed',
              finishedAt: Date.now(),
              error: cancelled
                ? ''
                : 'the simulator is not holding this order — it has already filled, been ' +
                  'cancelled, or was orphaned by a restart',
            },
          },
        )
        log(cancelled ? 'paper cancel done' : 'PAPER CANCEL FAILED', { brokerOrderId: id })
      }
    } catch (err) {
      // Never take the loop down; the next tick retries whatever is pending.
      log('paper cancel drain failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const paperCancelTimer = setInterval(() => void drainPaperCancels(), CANCEL_POLL_MS)
  paperCancelTimer.unref()

  /**
   * THE PAPER ORPHAN SWEEP — the restart hole a live order does not have.
   *
   * A paper order rests in the simulator's memory, so a restart strands it
   * PLACED forever: nothing replays it, the broker sweep is scoped away from
   * it, and the fold pass only scans TERMINAL states. The decision that owns it
   * would stay WORKING for the rest of the session. See `paper-sweep.ts`.
   *
   * Armed UNCONDITIONALLY, including in simulate mode — the hole is a property
   * of the simulator's memory, not of which broker the live rail talks to.
   */
  const paperSweep = createPaperSweep(
    {
      adapter: paperAdapter,
      queue,
      journal,
      orders: mongo.db.collection('desk-gateway-orders') as never,
      // What the simulator holds: everything on a simulate box, the non-live
      // documents beside a live Delta adapter.
      ordersFilter: adapter === paperAdapter ? { ...notDemo } : { mode: { $ne: 'live' }, ...notDemo },
      bootedAt: Date.now(),
      now: () => Date.now(),
      log,
    },
    { orphanAfterMs: positiveEnvMs('DESK_PAPER_ORPHAN_MS', DEFAULT_PAPER_ORPHAN_MS) },
  )
  const paperSweepTimer = setInterval(() => {
    // `run()` never rejects (it catches its own errors); the `.catch` is kept
    // for the reason every timer on this process keeps one.
    void paperSweep.run().catch((err: unknown) => log('paper sweep threw', { error: String(err) }))
  }, positiveEnvMs('DESK_PAPER_SWEEP_MS', 30_000))
  paperSweepTimer.unref()
  // Heal orders that raced their own ACK. A fill landing before markPlaced is
  // recorded under the truncated wire id, and with no further broker update
  // ever coming (the order is already terminal at the broker), the doc sits
  // PLACED forever. Re-deciding every PLACED order at boot picks those fills
  // up via the broker-id arm of the fill query.
  void mongo.db
    .collection('desk-gateway-orders')
    .find({ state: 'PLACED' })
    .toArray()
    .then(async (stuck: readonly Record<string, unknown>[]) => {
      for (const s of stuck) {
        await fills.reconcile(String(s['clientOrderId'] ?? ''))
      }
      if (stuck.length > 0) log('boot reconcile swept PLACED orders', { count: stuck.length })
    })
    .catch((err: unknown) => log('boot reconcile failed', { error: String(err) }))
  /**
   * ONE FILL WATCHER, BOTH BROKERS. Correlation is by `clientOrderId`, which is
   * unique across the whole queue, so a paper update and a live one cannot be
   * confused for each other on the direct lookup — and the watcher reads the
   * order document to decide the mode it stamps on the fill.
   *
   * THE BROKER-ID FALLBACK IS NOT UNIQUE ACROSS RAILS, so each subscription
   * tells the watcher which adapter it is listening to: a simulator id that
   * happens to equal a live AppOrderID must not resolve to the live document,
   * and a paper raced row must be stamped paper, not the fail-closed live. In
   * simulate mode both rails run on one simulator and the rail is unknown.
   *
   * Subscribed once when the two are the same object (simulate mode), or a
   * second update would be handled twice.
   */
  /**
   * A live Delta fill carries DELTA'S REPORTED commission (spec §5.4a), read
   * off `/v2/fills` for that order. None reported yet → no fee on the row,
   * never an invented one; the simulator's fills already carry theirs.
   */
  const withLiveFee = async (from: BrokerAdapter, update: PlacedOrder): Promise<PlacedOrder> => {
    if (update.fee !== undefined || !(update.filledQty > 0)) return update
    // The demo rail's fills carry the TESTNET's reported commission, the same way.
    const rest = from === dxAdapter ? dxRest : demoRail !== null && from === demoRail ? demoRail.rest : null
    if (rest === null) return update
    const fee = await deltaCommission(rest, update.brokerOrderId)
    return fee === null ? update : { ...update, fee }
  }
  const watchFills = (from: BrokerAdapter): void => {
    // The demo rail emits PAPER rows, always: testnet is a rehearsal.
    const rail: 'live' | 'paper' | undefined =
      from === demoRail ? 'paper' : adapter === paperAdapter ? undefined : from === paperAdapter ? 'paper' : 'live'
    from.onOrderUpdate((update: PlacedOrder) => {
      // `handle` never rejects (it catches its own errors), but the `void` is
      // still guarded by the crash guard above: an unhandled rejection reaching
      // Node 24 from here kills the only process that can place orders.
      void withLiveFee(from, update)
        .then((u) => fills.handle(u, rail === undefined ? {} : { rail }))
        .catch((err: unknown) => {
          log('fill watcher threw', { clientOrderId: update.clientOrderId, error: String(err) })
        })
    })
  }
  watchFills(adapter)
  if (adapter !== paperAdapter) watchFills(paperAdapter)
  if (demoRail !== null) {
    watchFills(demoRail)
    // Up at boot when credentials are stored, so its socket and sweep cover
    // demo orders left resting by a restart. Not configured is not an error.
    void demoRail.ensure().catch(() => {})
  }

  /**
   * The market-data fan-out: the QuoteMap the peg reads, and the simulator that
   * fills a resting paper order when a real tick crosses it: the touch, or a
   * print through it.
   *
   * ONE simulator, always — `paperAdapter` serves the paper rail beside Delta
   * and BOTH rails in simulate mode, so listing it once is the whole list.
   * Feeding one simulator twice would fill a resting order off a single print
   * twice, which is why the list is built here rather than appended to.
   */
  const onTick = tickFanout({ quotes, sims: [paperAdapter] })

  // --- one order ----------------------------------------------------------
  /**
   * The placement path is `createOrderPlacer`, above — plan, gates, tranche
   * loop and interrupted-placement recovery — so that all of it can be driven
   * by a suite with a simulator rather than only by this boot sequence.
   *
   * The ports are the things that vary at runtime: reference data is refreshed
   * on an interval, so the resolver and the freeze table are ASKED per order
   * instead of captured here, and the broker sweep is armed above only
   * with a live Delta adapter, so `sweepArmed` is read per recovery.
   */
  /** Read once; a typo stops the boot. NSE has no caps. */
  const dxCaps = onDx ? dxCapsFromEnv(process.env) : null
  if (dxCaps !== null) log('DX caps', { ...dxCaps })
  /** Delta's per-product OI cap, checked per opening package on the rail it goes to. */
  const oiCapGate = onDx
    ? new OiCapGate({
        venueFor: (rail) => (rail === 'live' ? dxRest : rail === 'demo' ? (demoRail?.rest ?? null) : null),
        loadPackage: async (decisionId) => {
          const d = await mongo.db.collection('desk-decisions').findOne({ decisionId })
          const planned = d?.['plannedFills']
          if (!Array.isArray(planned)) return null
          return planned.map((f: Record<string, unknown>) => ({
            tradingsymbol: String(f['tradingsymbol'] ?? ''),
            qty: Number(f['qty'] ?? 0),
            ...(typeof f['op'] === 'string' ? { op: f['op'] } : {}),
          }))
        },
        index: () => btcIndex,
        now: () => Date.now(),
        log,
      })
    : null
  const placer = createOrderPlacer({
    queue,
    journal,
    fills,
    // Per document — Delta only for an exact `mode: 'live'` with the live
    // rail on; the simulator for everything else (`dx-edge.ts`).
    adapterFor: createAdapterRouter<BrokerAdapter>({
      env: process.env,
      simulator: paperAdapter,
      live: dxAdapter,
      demo: demoRail,
      bookState: async (tag) => {
        const row = await mongo.db.collection('desk-books-registry').findOne({ tag, mode: 'paper' })
        const book = await mongo.db.collection('desk-books').findOne({ tag, mode: 'paper' })
        const used = row?.['dx_rail_used']
        return {
          setting: row?.['dx_paper_rail'] === 'sim' ? 'sim' : 'demo',
          held: holdsLegs(book),
          lastUsed: used === 'demo' || used === 'sim' ? used : null,
        }
      },
      demoReady: async () => demoKeyReadiness(await mongo.db.collection('desk-brokers').findOne({ kind: 'delta-demo' })),
      stamp: async (doc, rail, note) => {
        const res = await gatewayOrders.updateOne(
          { clientOrderId: String(doc['clientOrderId'] ?? '') },
          { $set: { dx_paper_rail: rail, dx_rail_note: note } },
        )
        if (res.matchedCount !== 1) throw new Error(`order document ${String(doc['clientOrderId'])} not found to stamp`)
        // The book row says where its order went — and a holding book reads it back to stay there.
        await mongo.db
          .collection('desk-books-registry')
          .updateOne(
            { tag: String(doc['tag'] ?? ''), mode: 'paper' },
            { $set: { dx_rail_used: rail, dx_rail_note: note, dx_rail_used_at: Date.now() } },
          )
      },
    }),
    resolveContract: (tradingsymbol) => {
      const contract = master.resolveSymbol(tradingsymbol)
      if (contract === null || contract.instrumentToken === undefined) return null
      const masterUnderlying = underlyingBySymbol.get(tradingsymbol)
      return {
        tradingsymbol: contract.tradingsymbol,
        instrumentToken: contract.instrumentToken,
        lotSize: contract.lotSize,
        tickSize: contract.tickSize,
        exchange: contract.exchange,
        ...(masterUnderlying === undefined ? {} : { underlying: masterUnderlying }),
      }
    },
    freeze: () => freeze,
    ...(dxCaps === null
      ? {}
      : {
          capRefusal: (order: GatewayOrderDoc, contract: ResolvedContract | null) =>
            dxCapRefusal({
              caps: dxCaps,
              quantity: order.quantity,
              lotSize: contract?.lotSize ?? venue.qtyStep,
              deskOp: order.desk_op,
              index: btcIndex,
            }),
        }),
    ...(oiCapGate === null
      ? {}
      : {
          oiCapRefusal: (order: GatewayOrderDoc, clientOrderId: string, rail: string | null) =>
            oiCapGate.refusal(order, clientOrderId, rail),
        }),
    allowsLive,
    readHalt,
    // No session to release on Delta: the kill switch and the Strategies page
    // are the gates; Delta's heartbeat is the dead-man switch.
    linkRefusal: () => null,
    orderMaxAgeMs,
    sweepArmed: (doc) => (stampedPaperRail(doc) === 'demo' ? demoSweepArmed : brokerSweepArmed),
    now: () => Date.now(),
    log,
  })
  const processOne = (doc: Record<string, unknown>): Promise<void> => placer.processOne(doc)

  // --- sweep --------------------------------------------------------------
  let nudged = false

  // The loop lives in queue.ts so its failure behaviour is tested: it must
  // NEVER reject, because both call sites below are `void sweep()` (G4).
  const sweeper = createSweeper({
    claimNext: () => queue.claimNext(),
    handle: processOne,
    log,
    now: () => Date.now(),
  })
  const sweep = async (): Promise<void> => {
    await sweeper.sweep()
    nudged = false
  }
  /**
   * A tranche advance re-armed a document: sweep it up now rather than at the
   * idle interval. Same shape as the bus nudge below — `void sweep()`, whose
   * `running` guard makes a re-entrant call from inside a sweep a no-op, and
   * the drain loop then claims the re-armed document on its very next turn.
   */
  wakeSweeper = () => {
    nudged = true
    void sweep()
  }

  const bus = new WsTransportClient({ url: busUrl })
  /**
   * UNCONDITIONAL, as of peg mode (2026-08-21). This subscription used to
   * exist only in simulate mode, to drive simulated fills; the live gateway
   * heard no market data at all, which is why the chaser could only escalate
   * blindly. It now also feeds the QuoteMap, which is what a passive order
   * pegs to — and a subscription that exists only on paper would mean the
   * paper rehearsal pegs and the live session crosses.
   *
   * Both consumers are behind ONE fan-out (`tickFanout`), so the book a passive
   * order pegs to and the book and print that fill a resting paper order come
   * off the same frame and cannot drift apart.
   */
  bus.subscribe<{ token: number; price: number }>('md.tick', (m) => {
    onTick(m.payload)
  })
  /** The BTC index for the fee model's notional and the notional cap. */
  bus.subscribe<{ underlying?: string; price?: number }>('md.spot', (m) => {
    const p = m.payload
    if (p?.underlying === 'BTC' && typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0) {
      btcIndex = p.price
    }
  })
  bus.subscribe<NudgePayload>(ORDER_NUDGE_TOPIC, () => {
    nudged = true
    void sweep()
  })
  void bus.ready().then(
    () => log('bus connected', { url: busUrl }),
    () => log('bus not reachable yet, sweeping on the interval until it is', { url: busUrl }),
  )

  const tick = setInterval(() => {
    if (shouldSweep({ nudged, msSinceLastSweep: Date.now() - sweeper.lastSweepMs, idleIntervalMs: idleSweepMs })) {
      void sweep()
    }
  }, 1000)
  tick.unref()

  /**
   * DELTA SETTLEMENT (DX only): every minute, each still-open leg of an
   * expired contract is booked at the price in `dx-settlements` — paper and
   * live — and never at any other. See `dx-settlement.ts`.
   */
  if (onDx) {
    const settlement = createDxSettlementJob({
      listBooks: () => listOpenBooks(mongo.db as never),
      settlements: async () =>
        (await mongo.db.collection(DX_SETTLEMENTS_COLLECTION).find({}).toArray()) as unknown as DxSettlementRow[],
      workingOn: (tag, mode, tradingsymbol) => countWorking(mongo.db as never, tag, mode, tradingsymbol),
      book: mongoSettlementBooker({ db: mongo.db as never, now: () => Date.now(), log }),
      alert: async (w) => {
        await journal.record({
          clientOrderId: `settle-${w.tag}-${w.mode}-${w.tradingsymbol}`,
          phase: 'FAILED', ok: false, tag: w.tag, tradingsymbol: w.tradingsymbol, ts: Date.now(), mode: w.mode,
          error:
            `Delta's settlement price for ${w.tradingsymbol} (expiry ${w.expiry}) is still missing ` +
            `${Math.round(w.overdueMs / 60_000)} min after 12:00 UTC — the leg is NOT settled; ` +
            'it will be booked at Delta\'s price as soon as dx-settlements has it',
          errorClass: 'fatal',
          detail: { source: 'dx-settlement', expiry: w.expiry },
        })
      },
      now: () => Date.now(),
      log,
    })
    const settleTimer = setInterval(() => void settlement.run(), DX_SETTLEMENT_POLL_MS)
    settleTimer.unref()
    void settlement.run()
  }

  await sweep()
  booted = true
  log('gateway up', { workerId, pending: await queue.pendingCount() })

  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`)
    // Before Mongo, so a socket still reconnecting cannot hold the exit open
    // past the 10s backstop below.
    privateSocket?.close()
    demoSocket?.close()
    void bus.close().then(() => mongo.close()).then(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error('[gateway] fatal', err)
    process.exit(1)
  })
}
