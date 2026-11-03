/**
 * The bridge service: the whole of what this app decides.
 *
 * Which is: nothing about trading (D1). It resolves contracts, applies the
 * desk's actions to our book, routes fills to the chosen rail, marks the book
 * and computes greeks, and reports differences. Every "should we" question
 * belongs to Python.
 *
 * CRASH SAFETY. The order of operations in `applyDecision` is deliberate and is
 * the reason a decision record is written BEFORE anything is routed:
 *
 *   - Route first, record after: a crash in between means the replay finds no
 *     record, re-applies, and DOUBLE-ROUTES. Real duplicate orders.
 *   - Record first, route after: a crash in between means the replay finds the
 *     record and declines to re-route, so orders are silently LOST — but the
 *     record is right there, stuck in `ROUTING`, saying exactly what happened.
 *
 * Losing an order loudly beats duplicating one silently, so we record first.
 * The unique index on `decisionId` is what makes this an actual lock rather than
 * a read-then-write race between N pm2 processes.
 */

import { bookGreeks, carryYield, yearsToExpiry, type BookGreeks, type LegGreeks, type PositionLeg } from '@algomaker/greeks'
import type { OptionMaster } from '@algomaker/instruments'
import { buildPositions } from '@algomaker/pnl'
import type { ExposureLimits, ExposureState } from '@algomaker/order-bus'
import { applyActions, diffBooks, type BookDiff, type DeclaredLeg } from './book.ts'
import { refoldOnConflict } from './book-write.ts'
import {
  type ActionsRequest,
  type BridgeLeg,
  type DeskAction,
  type DeskMode,
  type Fill,
  type MarkSource,
  type Skip,
} from './contract.ts'
// The pure half of both order paths. Every step that is a CALCULATION lives
// there; everything below keeps the I/O, the ordering and the crash safety.
import {
  actionsFullyRouted,
  instrumentForFill,
  orderIdFor,
  partitionOpenPositions,
  partitionRoutedFills,
  priceFillsForRoute,
  splitByKillSwitch,
  splitByRisk,
  type ActionSize,
  type FlattenLegResult,
} from './decision-plan.ts'
import { errorMessage, isDuplicateKey } from './errors.ts'
// The flatten-by-tag order path, lifted out whole (roadmap 18a). `flattenTag`
// below is a delegate: the deps it runs on are this service's own, and the
// method's signature is unchanged.
import { FlattenService, type FlattenParams, type FlattenResponse } from './flatten.ts'
import type { JournalEntry } from './livebook.ts'
import type { MarketableConfig } from './marketable.ts'
// The SAME lookback the P&L card reads fills over — env-tuned in one place, so
// the realised figure below and the card can never disagree about the window.
import { lookbackDaysOf, type LegQuote } from './pnl-jobs.ts'
import type { ExitQuote, ExitSide } from './marks.ts'
import { PnlStore, pnlKey } from './pnlstore.ts'
import { feeOf } from './rollup.ts'
import { paperFillEvent, routedCollection, withOrderContext, type OrderRail, railFor } from './rail.ts'
// The SAME venue day `submit.ts` judges "expires today" with — the IST date on
// NSE, the settlement day on DX; never the host's own zone.
import { venueDay } from './venue.ts'
import { seedBook, type SeedRequest, type SeedResult } from './seed.ts'
import {
  addsExposure,
  brokerLinkRefusal,
  planCloseAll,
  type BrokerLinkDesired,
  type BrokerLinkState,
  type CloseStyle,
  type KillSwitchState,
} from './safety.ts'
import type { DeclaredGreeks } from './validate.ts'
import {
  blockedEvents,
  blockedSkips,
  gateStrategy,
  UnknownStrategy,
  type StrategyPatch,
  type StrategyRow,
} from './strategies.ts'
import { COLLECTIONS, DeskStore, type StoredDecision } from './store.ts'
// The SAME staleness window as `/v1/desk/submit`, imported rather than
// re-declared: the two order paths share one crash window and a second constant
// would drift, leaving one of them reconciling while the other still says
// "unknown". (Type-only in the other direction, so there is no runtime cycle.)
import { ROUTING_STALE_MS } from './submit.ts'

/**
 * `WORKING` — TERMINAL-LOOKING AND NOT TERMINAL (design spec §8, D14).
 *
 * Every order of the package reached its rail and NOTHING has traded yet: a
 * maker quote is resting and its fills arrive later, on their own event. It is
 * distinct from `ROUTING`, which means "we do not know whether the orders went
 * out"; here we know exactly that they did.
 *
 * Only the engine endpoint's PAPER packages can answer it today, because only
 * the recenter supervisor is built to wait — it holds the decision `inFlight`,
 * polls the same id, and is nudged when a fill lands. A caller that reads it as
 * DONE will form its next package against a book it already has working.
 */
export type DecisionStatus = 'ROUTING' | 'DONE' | 'FAILED' | 'WORKING'

export interface DecisionResponse {
  readonly decisionId: string
  readonly replayed: boolean
  readonly status: DecisionStatus
  readonly fills: readonly Fill[]
  readonly skips: readonly Skip[]
  readonly book: readonly BridgeLeg[]
  /** Routing failures, per fill. Distinct from `skips`, which never reached a rail. */
  readonly routeErrors: readonly { readonly fill: Fill; readonly error: string }[]
  /**
   * INDETERMINATE — the claim exists and we do not know its outcome.
   *
   * Present only alongside `status: 'ROUTING'`, and only on a replay. It is the
   * same contract `submit.ts` publishes for the same crash window, and it is
   * carried in the SAME direction: `fills` is `[]`, so a caller that ignores
   * this flag UNDER-books. An under-booked position is recoverable by the next
   * replay once the record resolves; an over-booked one is not, because a
   * `close-all` over a phantom leg places a real order in the opposite
   * direction and OPENS a position nobody asked for.
   */
  readonly indeterminate?: true
  /** Why, in words an operator can act on. Present only when indeterminate. */
  readonly reason?: string
  /**
   * What the crashed attempt was TRYING to route. NOT what it routed.
   *
   * Named `plannedFills` rather than folded into `fills` precisely so it cannot
   * be mistaken for a position: nothing books off this array.
   */
  readonly plannedFills?: readonly Fill[]
}

/**
 * A decision document as it is actually stored.
 *
 * `StoredDecision` is the shape `recordDecision` accepts; these are the fields
 * `applyDecision` adds around it (the claim's status, the parked plan, the
 * routing outcome). Declared here rather than widened into `StoredDecision`
 * because a caller building a decision must not be able to set them.
 */
type StoredDecisionRecord = StoredDecision & {
  readonly status?: DecisionStatus
  readonly plannedFills?: readonly Fill[]
  readonly routeErrors?: readonly { readonly fill: Fill; readonly error: string }[]
  /** Which endpoint formed it — `ActionsRequest.via`, stamped at claim time. */
  readonly via?: 'engine'
  /** For a `WORKING` package: the order ids whose fills are still to arrive. */
  readonly workingOrderIds?: readonly string[]
}

// Declared in `decision-plan.ts` beside the two pure functions that build it,
// and re-exported here so this module's public surface is unchanged.
export type { FlattenLegResult }

// Declared in `flatten.ts` beside the method that builds it, and re-exported
// here for the same reason `FlattenLegResult` is: `flattenTag` is still served
// from this class, so its return type must still be importable from this module.
export type { FlattenResponse }

/**
 * How old the strategy's published greeks may be before this API stops
 * serving them as current.
 *
 * A running driver republishes every tick (~30s) and decides on a 5-minute
 * mark grid, so six minutes is one full mark plus slack — long enough that a
 * single missed tick does not flip the dashboard between two models, short
 * enough that a stopped or wedged strategy is caught within one mark.
 */
const STRATEGY_GREEKS_MAX_AGE_MS = 6 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The book's own reference vol for the model pass: the median of the IVs that
 * DID solve. Median, not mean — one crazy wing quote must not drag the vol
 * every modelled leg is priced at. Null when nothing solved, in which case
 * there is no defensible reference and nothing gets modelled.
 */
function medianSolvedIv(legs: readonly LegGreeks[]): number | null {
  const ivs = legs
    .map((l) => l.iv)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  const mid = ivs[Math.floor((ivs.length - 1) / 2)]
  const midHi = ivs[Math.ceil((ivs.length - 1) / 2)]
  if (mid === undefined || midHi === undefined) return null
  return (mid + midHi) / 2
}

/**
 * WHEN A PAPER TRADE HAPPENED, whichever of the two paper writers produced it.
 *
 * The synchronous rail stamps `order_timestamp` (a BSON date, because that is
 * what `positional` has always carried); the gateway stamps `ts` (epoch ms).
 * `paperTrades` sorts one list across both, and a comparator that read only
 * one key would sort half the rows to the bottom as `NaN`.
 *
 * 0 for a row with neither, which puts an undatable trade LAST rather than
 * first: the top of this list is what an operator reads as "just now".
 */
function paperTradeTs(row: Record<string, unknown>): number {
  const stamp = row['order_timestamp']
  if (stamp instanceof Date) return stamp.getTime()
  const asNumber = Number(stamp ?? row['ts'])
  return Number.isFinite(asNumber) ? asNumber : 0
}

export interface PositionsResponse {
  readonly tag: string
  readonly symbol: string
  readonly mode: DeskMode
  readonly legs: readonly BridgeLeg[]
  readonly greeks: BookGreeks
  readonly spot: number | null
  readonly asOf: number
  /**
   * True only when every leg priced. When false the net greeks are computed
   * over a SUBSET, and `greeks.unpriced` names what is missing. Consumers must
   * not present the totals as authoritative unless this is true.
   */
  readonly complete: boolean
  /** True when any displayed mark is a persisted snapshot, not a live tick. */
  readonly stale: boolean
  readonly marksAsOf: number | null
  /**
   * The bid/ask pair each leg's mark was valued off, by tradingsymbol —
   * present only when the exit-side valuation seam is wired
   * (`displayExitQuotes`). A leg absent here could not be priced off a book.
   */
  readonly quotes?: Readonly<Record<string, LegQuote>>
  /**
   * WHAT THE STRATEGY IS ACTUALLY STEERING BY, when that is not the whole book.
   *
   * Under `delta_shorts_only` / `gamma_shorts_only` — set on every live
   * recenter-relief-r book, user-directed 2026-08-12 ("buy legs are making
   * issue so we ignore them from the position ... its just for hedge") — the
   * rules read the SHORT legs only. On BHEL 2026-08-14 the book carried +408
   * delta while the shorts alone were -1836: opposite signs, because the two
   * long hedge legs hold most of the positive delta.
   *
   * `greeks` above stays the WHOLE BOOK — that is the risk the desk is
   * actually carrying, and it is what a position page must show. This is the
   * number the rules compare against their band, which is what the Strategy
   * panel prints. Showing one without the other is what made the two panels
   * look like they disagreed.
   *
   * Null when the strategy reported none — an older decider, or a book with
   * the dials off where the two coincide anyway.
   */
  readonly steering: { readonly delta: number; readonly gamma: number } | null
  /**
   * REALISED-TO-DATE for this tag: what the desk has BOOKED — closed tranches,
   * rolls, resizes — summed over the P&L lookback window, gross of costs.
   *
   * WHY IT IS ON THIS PAYLOAD (2026-08-18). The positions table's Total sums
   * the OPEN legs against their entries, because a closed tranche leaves the
   * book and takes its P&L to the journal. The live BHEL book closed a leg
   * realising −95,524 and the Total read +95,419 — the profit the SURVIVING
   * legs show since entry — while the book's true lifetime P&L was ≈ −105.
   * Labelling the two apart (audit F-52) stopped them looking like a
   * disagreement; it did not stop the +95k being read as money made. The page
   * needs the realised figure to put the net on screen, and this is the one
   * payload it draws the table from.
   *
   * Computed from the SAME corrected fills every other P&L figure reads:
   * `desk-decisions` through `PnlStore.loadFills`, which the live reconciler
   * has already restated to the broker's own quantities and prices
   * (`reconcile-live.ts`). NOT the day's `realised` from the P&L card — that
   * subtracts everything carried in from earlier days, and the Total row is a
   * since-entry figure, so the day's number would re-create the same mismatch
   * one join later.
   *
   * OPT-IN, and absent unless asked for (see `positions()`): the Books page
   * calls `positions()` once per book on a 5s poll, and a fill-journal scan
   * per book per poll is the exact class of read `LiveBook` exists to remove.
   * Null — never 0 — when the figure cannot be vouched for: the fill read hit
   * its cap, a stored fill could not be read, or a position's opening fills
   * fall outside the window (a seeded or long-carried book), any of which
   * would understate silently. The page renders the Total exactly as before.
   */
  readonly realised?: number | null
}

export interface Clock {
  now(): number
}

export interface MasterProvider {
  /** Current instrument master. Refreshed out of band by the sync job. */
  current(): OptionMaster
}

export interface BridgeDeps {
  readonly store: DeskStore
  readonly rails: { paper: OrderRail; live: OrderRail }
  readonly master: MasterProvider
  readonly marks: MarkSource
  /** Display-only mark lookup, falling back to the persisted snapshot. */
  readonly displayMarks?: (token: number) => { price: number; asOf: number; live: boolean } | null
  /**
   * Display-only EXIT-SIDE valuation off the last two-sided book frame — long
   * legs at bid, shorts at ask, LTP never (`QuoteCache.displayExitQuote`).
   * When wired, `positions()` values legs off this alone; absent (tests with
   * `StaticMarks`), it falls back to `displayMarks`/`marks.price`.
   */
  readonly displayExitQuotes?: (token: number, exit: ExitSide | null) => ExitQuote | null
  /** Spot for display, falling back to the snapshot. Never used to fill. */
  readonly displaySpot?: (underlying: string, token: number | null) => number | null
  /**
   * Told about fills the moment they are journalled, so the in-memory book
   * (`livebook.ts`) does not have to wait for its 60s reconcile to see them.
   *
   * SYNCHRONOUS, RETURNS VOID, AND MUST NOT THROW — the same contract
   * `PaperFillEmit` holds. There is nothing here for the order path to await and
   * nothing for it to fail on; `LiveBook.onJournal` swallows its own errors, and
   * the reconcile repairs anything it dropped. Absent in every test and in any
   * deployment without a book, which must behave identically.
   */
  readonly journal?: (entry: JournalEntry) => void
  /**
   * Marketable-limit pricing for actions that arrive WITHOUT a price — which is
   * every action the Python supervisor sends, since the action shapes carry no
   * `orderType`/`limitPrice` field.
   *
   * Absent means "leave them MARKET", which is the historical behaviour and
   * what every test that does not configure this still gets. Production sets
   * it, because THE BROKER API REJECTS MARKET ORDERS: without it, every
   * delta-management order recenter places is refused and the book sits open
   * and unmanaged. See `marketable.ts`.
   */
  readonly marketable?: MarketableConfig
  /**
   * The ceiling on how old a mark may be and still price NEW exposure
   * (`DESK_MAX_OPEN_MARK_AGE_MS`, audit F-16). Threaded into every
   * `ApplyContext` this service builds; absent means no ceiling, which is what
   * every test that does not opt in gets. Exits are never gated by it — see
   * `tooStaleToOpen` in book.ts.
   */
  readonly maxOpenMarkAgeMs?: number
  /**
   * The desk-wide RISK LIMITS (audit F-28), on the LIVE rail only.
   *
   * ABSENT MEANS NO GATE AT ALL, which is what every test and every desk that
   * has configured no limit gets — `main.ts` builds this only when at least one
   * `DESK_RISK_*` variable is set. See `RiskGatePort`.
   */
  readonly risk?: RiskGatePort
  readonly clock: Clock
}

/**
 * The risk gate as the two order paths see it: the configured limits, one
 * measurement of the desk, and somewhere to count accepted orders.
 *
 * A PORT, not the object, for the usual reason — `submit.ts` and this service
 * both hold it, and neither should learn how the P&L is measured. `main.ts`
 * owns that (it is a `pnlFor` read behind a cache) and is the only place that
 * has to change if the source does.
 */
export interface RiskGatePort {
  /** Configured limits. `NO_EXPOSURE_LIMITS` (all disabled) is never passed. */
  readonly limits: ExposureLimits
  /**
   * What the desk has open and how much it is down, for one rail.
   *
   * `null` means it could not be measured — see `screenRiskGate`, which turns
   * that into a refusal of NEW exposure while a limit is configured. Async
   * because it may have to read; the caller takes it once per decision.
   */
  exposure(mode: DeskMode): Promise<ExposureState | null>
  /** Count one accepted exposure-adding order, for the rate limit. */
  record(nowMs: number): void
  /**
   * HOLD LOTS THIS RAIL HAS JUST ADMITTED against the caps, until `exposure`
   * can see them.
   *
   * Belt and braces over the journal-time book update, not a replacement for
   * it: fills reach `LiveBook.onJournal` synchronously, in this process, before
   * the request returns — so the NEXT measurement does include them. What this
   * covers is the window in which there is no next measurement: `main.ts`
   * caches the exposure read for `DESK_RISK_EXPOSURE_TTL_MS` (it costs a full
   * P&L re-mark), so several decisions inside those two seconds are all judged
   * against the same pre-fill snapshot and each one spends the same headroom.
   * See `ReservationLedger`.
   *
   * Called ONLY for exposure-ADDING orders the gate has already admitted, and
   * only on the live rail — the same two conditions as `record`.
   */
  reserve(lots: number, underlying: string, nowMs: number): void
}

export class BridgeService {
  readonly #d: BridgeDeps
  /**
   * The flatten-by-tag path, on the SAME deps object this service holds.
   *
   * Built once here rather than per call so there is exactly one of it, and
   * handed `#tellBook` because `applyDecision` and a flatten must notify the
   * in-memory book through one implementation — see `FlattenService`.
   */
  readonly #flatten: FlattenService

  constructor(deps: BridgeDeps) {
    this.#d = deps
    this.#flatten = new FlattenService(deps, (entry) => {
      this.#tellBook(entry)
    })
  }

  /**
   * Tell the in-memory book about fills that were just journalled.
   *
   * WRAPPED, AND IT SWALLOWS EVERYTHING. This is called on the order path after
   * the write that made the fills real; letting a cache update propagate would
   * report an order as failed when it went out perfectly — the same inversion
   * `PaperRail`'s emit and `journalBlocked` already guard against. A missed
   * entry costs at most one reconcile interval of staleness.
   *
   * A decision that routed nothing is skipped: an empty entry is a mutation the
   * book would count and the journal would not.
   */
  #tellBook(entry: JournalEntry): void {
    if (this.#d.journal === undefined || entry.fills.length === 0) return
    try {
      this.#d.journal(entry)
    } catch {
      /* a stale dashboard is an inconvenience; a failed order is an outage */
    }
  }

  /**
   * GATE 2b: the desk-wide risk limits over one decision's actions (F-28).
   *
   * The verdict is `splitByRisk`'s; everything here is the I/O it must not do —
   * ONE exposure measurement for the whole decision, the lot size and mark each
   * action is judged with, the rate-window bump for each order this permits,
   * and the order-log write that makes a refusal answerable from the same place
   * `/v1/desk/submit`'s refusals are.
   *
   * NO GATE CONFIGURED IS THE COMMON CASE and it costs nothing: no dep, no
   * measurement, the caller's own array handed straight back.
   */
  async #screenRisk(
    req: ActionsRequest,
    actions: readonly DeskAction[],
    book: readonly BridgeLeg[],
    nowMs: number,
  ): Promise<{ permitted: readonly DeskAction[]; riskSkips: readonly Skip[] }> {
    const risk = this.#d.risk
    if (risk === undefined || req.mode !== 'live') return { permitted: actions, riskSkips: [] }

    const out = splitByRisk({
      mode: req.mode,
      limits: risk.limits,
      // One read per decision, never one per action: it is a P&L answer.
      exposure: await risk.exposure(req.mode),
      underlying: req.symbol,
      actions,
      book,
      sizeOf: (action) => this.#sizeOf(action, req, book),
    })
    /**
     * Only what the gate PERMITTED and only what ADDS exposure is counted: a
     * refused order placed nothing, and a rate limit that counted exits would
     * throttle getting flat.
     *
     * The lots are RESERVED in the same pass, so the next decision inside the
     * measurement cache's TTL is judged against a desk that already holds them
     * — see `RiskGatePort.reserve`. Sized through the same `#sizeOf` the gate
     * judged the action with, so a reservation can never differ from what was
     * admitted; an action whose size could not be resolved reserves nothing,
     * exactly as it was capped on nothing.
     */
    for (const a of out.permitted) {
      if (!addsExposure(a, book)) continue
      risk.record(nowMs)
      const size = this.#sizeOf(a, req, book)
      if (size !== null) risk.reserve(size.lots, req.symbol, nowMs)
    }
    if (out.riskSkips.length === 0) return out

    /**
     * The refusal in the ORDER LOG, not only in the decision record.
     *
     * "Which limit stopped this, and by how much" has to be answerable from the
     * order log alone, on BOTH rails — `submit.ts` journals its own refusals
     * there through the same `blockedEvents` shape and the same reason string.
     *
     * A REFUSAL IS NOT AN ORDER, AND MUST NOT WEAR AN ORDER'S ID.
     *
     * `blockedEvents` stamps `<decisionId>#<i>` — the derivation a ROUTED order
     * uses (`orderIdFor`), over a different list. The routed ids run over the
     * post-split FILL list while these run over the actions, so the moment one
     * action in the middle is skipped the two lists slide apart and the same
     * `D#0` names both this refusal and a real order that went to a broker. An
     * operator grepping the order log for an id then finds two rows saying
     * opposite things about the same order.
     *
     * So refusals get their own shape, `#skip-<i>`, which no order can collide
     * with. The ROUTED derivation is deliberately untouched: replay determinism
     * depends on a retried decision producing byte-identical order ids.
     */
    const reasons = new Map(out.riskSkips.map((s) => [s.action, s.reason]))
    await this.#d.store.journalBlocked(
      blockedEvents({
        tag: req.tag,
        symbol: req.symbol,
        decisionId: req.decisionId,
        actions,
        reason: '',
        nowMs,
        mode: req.mode,
      })
        .map((event, i) => ({
          event: { ...event, clientOrderId: `${req.decisionId}#skip-${i}` },
          reason: reasons.get(actions[i] as DeskAction),
        }))
        .filter((e) => e.reason !== undefined)
        .map((e) => ({ ...e.event, error: e.reason })),
    )
    return out
  }

  /**
   * The size a risk cap measures ONE action in — lots, contracts and a mark.
   *
   * `null` when the contract cannot be resolved: `applyActions` refuses that
   * case for itself, with a reason that names the symbol, and a cap that
   * refused it first would hide the real problem behind a risk message.
   *
   * Only ever asked about actions that ADD exposure, which is `open` and a
   * GROWING `resize` — a resize is judged on the DELTA it adds, not on its
   * absolute new size, because the lots already open are in the snapshot.
   */
  #sizeOf(action: DeskAction, req: ActionsRequest, book: readonly BridgeLeg[]): ActionSize | null {
    if (action.op === 'open') {
      const inst = this.#d.master
        .current()
        .resolve(req.symbol, req.expiry, action.strike, action.type)
      if (inst === null || !(inst.lotSize > 0)) return null
      return {
        lots: action.qty / inst.lotSize,
        quantity: action.qty,
        price: this.#d.marks.price(inst),
      }
    }
    if (action.op === 'resize') {
      const leg = book.find((l) => l.deskTag === action.ts)
      if (leg === undefined || !(leg.instrument.lotSize > 0)) return null
      const added = action.qty - Math.abs(leg.qty)
      return {
        lots: added / leg.instrument.lotSize,
        quantity: added,
        price: this.#d.marks.price(leg.instrument),
      }
    }
    return null
  }

  /**
   * Apply one decision. Idempotent on `decisionId`.
   *
   * A replay returns the ORIGINAL result and routes nothing — N pm2 processes
   * retrying the same decision must not produce N sets of orders.
   */
  async applyDecision(
    req: ActionsRequest,
    /**
     * Per-leg order pricing, applied to the fills BEFORE they route.
     *
     * Must be applied here rather than to the returned result: the rail writes
     * its document during the routing loop below, so decorating the response
     * afterwards leaves the actual order as MARKET while the API reports LIMIT.
     */
    pricing?: ReadonlyMap<
      string,
      {
        orderType: 'MARKET' | 'LIMIT'
        limitPrice?: number
        /** How hard the order works. Carried to the rail — see `Fill.workMode`. */
        workMode?: 'passive' | 'urgent'
        /**
         * The book's execution dials, carried to the rail the same way — see
         * `Fill.trancheLots`. Per-leg in shape because the pricing map is; per
         * PACKAGE in fact, because they are the book's dials and every leg of
         * one decision is worked the same way.
         */
        trancheLots?: number
        chaseMaxMs?: number
        chaseCrossBufferPct?: number
      }
    >,
    /**
     * OPERATOR-INITIATED, set only by `closeAll`.
     *
     * Flattening runs as the operator, not as the strategy, so it is exempt from
     * the strategy switch — the same exemption it already has from the kill
     * switch. Without it "off means off" would trap the position it just
     * stopped managing, which is the failure mode safety.ts exists to prevent.
     */
    asOperator = false,
    /**
     * THIS PACKAGE ONLY REDUCES EXPOSURE, so a switched-off row must not trap
     * it (`gateStrategy`'s reduce-only exemption, and the 2026-08-04 incident
     * its header describes: the runner's own switch-off path squared off, and
     * the gate refused the very flatten the switch had just ordered).
     *
     * A SEPARATE FLAG FROM `asOperator`, because they are different claims. The
     * operator exemption says "a human is doing this by hand and is exempt from
     * the strategy switch and the halt alike"; this one says "every action here
     * is an exit", which is a fact about the actions and leaves the halt, the
     * risk caps and the rails exactly where they are.
     *
     * Claimed by the CALLER, as `/v1/desk/submit`'s is — only the caller knows
     * whether the package it formed was meant as an exit. But it is NEVER
     * TAKEN AT FACE VALUE: it is ANDed below with a fresh `addsExposure` pass
     * over the book THIS method read, so a caller reasoning off a stale book
     * cannot carry the exemption past a switched-off row. See
     * `reducesExposureEffective`.
     *
     * `routes/engine.ts` derives its claim from the book rather than reading it
     * off a request body; nothing on this path trusts a body for it.
     */
    reducesExposure = false,
  ): Promise<DecisionResponse> {
    const existing = await this.#d.store.getDecision(req.decisionId)
    if (existing !== null) return await this.#replay(existing, req)

    const now = this.#d.clock.now()
    // THE VERSION WE DECIDE AGAINST. Everything below — three gates, N routed
    // orders, a network round trip each — happens between this read and the
    // write at the bottom, and `bookVersion` is what makes that write refuse to
    // clobber whatever else landed in the window (audit F-27, `store.saveBook`).
    // `null` means there is no row yet, and the write must CREATE one — an
    // insert that loses to whoever created it first, never a blind upsert over
    // their document. `undefined` (a row from before this field existed) is the
    // one case with nothing to pin at all.
    const bookAtRead = await this.#d.store.bookDoc(req.tag, req.mode)
    // `?? []` for the same reason `closeAll` carries it: a document written
    // before this collection had legs reads back without the field, and
    // `loadBook` — which this replaced — never had to care.
    const book: readonly BridgeLeg[] = bookAtRead === null ? [] : [...(bookAtRead.legs ?? [])]
    const bookVersion = bookAtRead === null ? null : bookAtRead.updatedAt

    /**
     * GATE 1: the strategy switch. Checked here, before the halt, and it is the
     * one gate that blocks EXITS TOO — see strategies.ts for why that asymmetry
     * is deliberate. Nothing below this point runs for a blocked tag: no
     * actions applied, no order queued, no book written.
     *
     * It sits AFTER the replay check on purpose. Disabling a strategy must not
     * retroactively unmake a decision that already routed; a replay of that
     * decisionId keeps returning the original result, which is what makes the
     * desk's retry loop safe across a switch flip.
     *
     * The gate is asked about `req.mode`, so a desk registered for paper only
     * is refused a live decision even though the same tag trades happily on the
     * paper rail a millisecond later.
     */
    /**
     * THE CLAIM IS RE-CHECKED AGAINST THE BOOK WE ACTUALLY READ.
     *
     * A caller derives `reducesExposure` from a book it read a moment before
     * calling — `routes/engine.ts` reads one to translate instruments into leg
     * tags — and `bookAtRead` above is a SECOND, later read. Between the two, a
     * leg can appear: a concurrent decision, an operator's manual order, a
     * repair Apply. The window is small and the failure it opens is not: a
     * `resize` to 5 lots is an EXIT against a 9-lot book and NEW EXPOSURE
     * against the 1-lot book that actually exists, and on the caller's stale
     * reading it would carry the reduce-only exemption straight past a
     * switched-off row.
     *
     * So the claim is ANDed, never taken. `addsExposure` is the same predicate
     * the kill switch is split on, run here over the book this method will
     * itself act on, which is the only book whose answer cannot be stale.
     *
     * A caller that claims nothing is unaffected and pays nothing for the
     * check: `false && anything` short-circuits before the book is walked.
     */
    const reducesExposureEffective =
      reducesExposure && !req.actions.some((a) => addsExposure(a, book))

    const switchGate = asOperator
      ? ({ allowed: true } as const)
      : gateStrategy(req.tag, await this.#d.store.loadStrategy(req.tag), req.mode, {
          reducesExposure: reducesExposureEffective,
        })
    /**
     * GATE 1b: the broker link — and it is asked of the OPERATOR too, exits
     * included. A released link means the gateway is logged out of XTS; a
     * live order handed to it now is refused there AFTER this bridge has
     * folded it into the book (nothing un-books a gateway refusal — the C-1
     * trace), so the refusal has to happen here, before anything is applied.
     * Same blocked path as a switched-off row: journalled, recorded, every
     * action a skip. Paper never reaches this — see `brokerLinkRefusal`.
     */
    const linkRefusal = switchGate.allowed
      ? brokerLinkRefusal(req.mode, await this.#d.store.loadBrokerLink())
      : null
    const gate =
      linkRefusal === null
        ? switchGate
        : ({ allowed: false, registered: true, reason: linkRefusal } as const)
    if (!gate.allowed) {
      // Journalled even though nothing routed: "why did nothing trade this
      // morning?" has to be answerable from the portal, not from a process log.
      await this.#d.store.journalBlocked(
        blockedEvents({
          tag: req.tag,
          symbol: req.symbol,
          decisionId: req.decisionId,
          actions: req.actions,
          reason: gate.reason,
          nowMs: now,
          mode: req.mode,
        }),
      )
      // An unregistered tag is a misconfiguration only a human can fix, and it
      // has no switch in the portal to fix it with. It fails LOUDLY rather than
      // returning a 200 that a client could mistake for "switched off, will
      // resume later".
      if (!gate.registered) throw new UnknownStrategy(gate.reason)

      // A disabled tag, by contrast, is a normal state: report EVERY action back
      // as a skip in the same shape as every other skip, and record it so the
      // desk can read back what did not happen.
      const skips = blockedSkips(req.actions, gate.reason)
      try {
        await this.#d.store.recordDecision({
          decisionId: req.decisionId,
          symbol: req.symbol,
          expiry: req.expiry,
          mode: req.mode,
          tag: req.tag,
          fills: [],
          skips,
          createdAt: now,
          ...({ status: 'DONE' } as Record<string, unknown>),
        })
      } catch (err) {
        // A duplicate id here means a concurrent caller already recorded the
        // same refusal. The outcome is identical either way — nothing routed.
        if (!isDuplicateKey(err)) throw err
      }
      return {
        decisionId: req.decisionId,
        replayed: false,
        status: 'DONE',
        fills: [],
        skips,
        book,
        routeErrors: [],
      }
    }

    // Liveness. Stamped on the CALL, not on a fill: the question the portal's
    // "last seen" answers is "is this book's process still alive?", and a
    // strategy that decides to do nothing all morning is still alive.
    if (!asOperator) await this.#d.store.touchStrategy(req.tag, now)

    // GATE 2: the halt. It blocks NEW EXPOSURE only — see `splitByKillSwitch`.
    const halt = await this.#d.store.loadKillSwitch()
    const { permitted: unhalted, haltSkips } = splitByKillSwitch({
      halt,
      actions: req.actions,
      book,
    })

    // GATE 2b: the desk-wide risk limits, on the live rail and only when the
    // operator configured one. Beside the halt because it is the same kind of
    // control and carries the same exemption — see `splitByRisk`.
    const { permitted, riskSkips } = await this.#screenRisk(req, unhalted, book, now)

    const applied = applyActions(book, permitted, {
      master: this.#d.master.current(),
      marks: this.#d.marks,
      nowMs: now,
      underlying: req.symbol,
      expiry: req.expiry,
      // The stale-mark ceiling on NEW exposure. Conditionally spread because
      // `exactOptionalPropertyTypes` distinguishes "absent" from "undefined",
      // and absent is what "no ceiling configured" must look like.
      ...(this.#d.maxOpenMarkAgeMs === undefined
        ? {}
        : { maxOpenMarkAgeMs: this.#d.maxOpenMarkAgeMs }),
    })
    /**
     * THE EXPIRY-DAY BUFFER, for the one family of decisions that needs it.
     *
     * `/v1/desk/submit` pays the wide buffer on a contract that expires today;
     * this path used to pay the base one always, so an exit on a dying contract
     * went out 2% through an LTP the tape had already left and sat unfilled.
     * Asserted only for an ENGINE decision (`via` is set in code by the engine
     * route, never read off a body) whose trigger starts `dl-` — the delta-lean
     * family, every playbook included — on a book whose contract expires today
     * (`req.expiry`, the book's one contract, judged in IST against this
     * service's clock).
     *
     * `eod` IS INCLUDED, though the trigger is shared with recenter: it is the
     * delta-lean family's 14:50 / 14:55 / 15:00 flatten — on a 0-DTE book the
     * one exit that matters most (spec 2026-10-16 F3, review finding 4) — and
     * desk-api cannot tell the two families' `eod` apart by name. No recenter
     * preset in use emits `eod` (`recenter-relief-r` has `eod_flat_min` 0), and
     * on a recenter book's OWN expiry day a 15:15 sweep paying the wide buffer
     * is the intended behaviour for an exit on a dying contract.
     *
     * Recenter's other triggers (`shift`, `shed`, ...) do not start `dl-`, so
     * their pricing is unchanged: a positional book trades monthlies and an
     * intraday fix must not move it. `flattenTag` does not assert it either.
     *
     * The buffer is a limit PRICE only. It never changes which orders go out,
     * and the config's `expiryBufferPct` is read from the one env reader
     * (`marketableFromEnv`), so this service and `/submit` pay the same 10%.
     */
    const expiresToday =
      req.via === 'engine' &&
      typeof req.action === 'string' &&
      (req.action.startsWith('dl-') || req.action === 'eod') &&
      req.expiry === venueDay(now)
    // Priced BEFORE routing, never after: the rail writes its document during
    // the loop below, so decorating the response would leave the real order
    // MARKET while the API reported LIMIT. See `priceFillsForRoute`.
    const result = {
      ...applied,
      fills: priceFillsForRoute(applied.fills, pricing, this.#d.marketable, expiresToday),
    }

    // Claim the decision id BEFORE routing. A duplicate key here means another
    // process won the race; treat it exactly like a replay rather than routing
    // a second set of orders.
    try {
      await this.#d.store.recordDecision({
        decisionId: req.decisionId,
        symbol: req.symbol,
        expiry: req.expiry,
        mode: req.mode,
        tag: req.tag,
        // `fills: []` AT CLAIM TIME, with the plan parked where nothing reads it.
        //
        // `desk-decisions` is the ONLY source `PnlStore.loadFills` reads, so a
        // fill written here is booked as real. Claiming the whole PLAN meant a
        // decision whose orders never reached a rail still produced P&L and a
        // book — and `close-all` over that book then places REAL orders to
        // close a position that was never opened, which is a new position in
        // the opposite direction. `flattenTag` documents this trap and avoids
        // it; this path did not.
        fills: [],
        // The plan, parked where nothing reads it as a position.
        ...({ plannedFills: result.fills } as Record<string, unknown>),
        skips: [...haltSkips, ...riskSkips, ...result.skips],
        createdAt: now,
        ...({ status: 'ROUTING' } as Record<string, unknown>),
        /**
         * WHICH ENDPOINT FORMED THIS DECISION — stamped at CLAIM time, before
         * anything routes, so it is on the record even for a process that dies
         * mid-loop. `paper-fold.ts` scans by it: a pass that had to infer which
         * decisions book themselves on a fill event would eventually infer it
         * about one that books itself at route time, and double-fold it.
         */
        ...(req.via === undefined ? {} : ({ via: req.via } as Record<string, unknown>)),
      })
    } catch (err) {
      if (isDuplicateKey(err)) {
        /**
         * Another process won the race. Answer with ITS record, through the very
         * same replay path a retry takes.
         *
         * This branch used to hard-code `status: 'DONE'` beside the winner's
         * fills, which is the loser inventing an outcome it did not witness.
         * Process A claims the id and dies mid-route; process B loses the insert
         * race and answered `{status: 'DONE', fills: [3 fills]}` — the desk booked
         * three legs of which zero had routed. `submit.ts` funnels this exact
         * race through `#replay` for the same reason; so does this now.
         */
        const winner = await this.#d.store.getDecision(req.decisionId)
        if (winner !== null) return await this.#replay(winner, req)
        // The duplicate key says a record exists, so a null read here is a
        // transient one. Rethrowing is honest; inventing a status is not.
        throw err
      }
      throw err
    }

    const rail = railFor(req.mode, this.#d.rails)
    /**
     * DOES THIS PACKAGE BOOK ITSELF, OR DOES ITS FILL EVENT BOOK IT? (D14)
     *
     * The engine's PAPER orders are worked by the gateway exactly as live ones
     * are — queued, claimed, pegged, tranche-gated, filled by a tick that
     * crosses them — so at this line nothing has traded and there is nothing
     * honest to book. `paper-fold.ts` folds each fill when it actually lands.
     *
     * LIVE IS UNCHANGED, and the asymmetry is deliberate rather than an
     * oversight. A live decision books optimistically here at the requested
     * size and the decision-time mark, and `reconcile-live.ts` restates it from
     * the broker's own terminal record — a whole file of prime directives built
     * on that order of events. Rewiring the live rail onto the fill event is a
     * separate change with a separate blast radius; this one is scoped to the
     * rail where a mistake costs a rehearsal rather than a position.
     */
    const worksAsync = req.via === 'engine' && req.mode === 'paper'
    const routeErrors: { fill: Fill; error: string }[] = []
    /**
     * The order ids that ACTUALLY reached the rail, in routing order.
     *
     * Recorded rather than re-derived, and only `worksAsync` reads it: the pass
     * that books a paper fill later has to know when the package is finished,
     * and "every planned fill minus the ones that errored" is arithmetic over
     * two arrays that a partial refusal makes subtly wrong. A list of the ids
     * that exist cannot be wrong about which ids exist.
     */
    const routedOrderIds: string[] = []
    let fillIndex = -1
    for (const fill of result.fills) {
      fillIndex++
      // Both books, then the instrument master by exchange symbol — a close
      // removes the leg from the new book, so it must not be dropped for want
      // of a leg it just closed. See `instrumentForFill`.
      const instrument = instrumentForFill(fill, result.book, book, (s) =>
        this.#d.master.current().resolveSymbol(s),
      )
      if (instrument === null) {
        routeErrors.push({ fill, error: `cannot resolve ${fill.tradingsymbol} to route` })
        continue
      }
      const clientOrderId = orderIdFor(req.decisionId, fillIndex)
      try {
        await rail.route(fill, {
          tag: req.tag,
          underlying: req.symbol,
          instrument,
          nowMs: now,
          clientOrderId,
          // Carried onto the rail so the PAPER rail knows which queue this
          // order belongs in. See `rail.ts:RouteVia`.
          ...(req.via === undefined ? {} : { via: req.via }),
        })
        routedOrderIds.push(clientOrderId)
      } catch (err) {
        routeErrors.push({ fill, error: errorMessage(err) })
      }
    }

    /**
     * ONLY WHAT ROUTED becomes the book and the P&L journal.
     *
     * An attempt is not a position. A leg whose route threw — a rail refusal, a
     * Mongo blip, a live tag missing from `DESK_LIVE_TAGS` — has no order behind
     * it anywhere, and booking it means every later reader believes in risk that
     * does not exist. The concrete cost is not a wrong report: `close-all` over
     * a phantom leg places a real order in the opposite direction and OPENS a
     * position nobody asked for.
     *
     * The book is recomputed from the routed subset rather than from
     * `result.book`, so the two can never disagree.
     */
    const { failedTags, routedFills } = partitionRoutedFills(result.fills, routeErrors)

    /**
     * THE PACKAGE IS OUT AND NOTHING HAS TRADED (D14) — see `worksAsync`.
     *
     * Three things do NOT happen here, and each of them is the point:
     *
     *   THE BOOK IS NOT WRITTEN. There is no position yet. Folding the plan in
     *   would put a leg on `desk-books` that the gateway has not placed, let
     *   alone filled, and every later reader — P&L, the payoff, `close-all` —
     *   reads that leg as real. `close-all` over a leg nobody holds sends a
     *   REAL order in the opposite direction, which is the shape of failure
     *   `partitionRoutedFills` above exists to prevent, reached the other way.
     *
     *   `fills` STAYS EMPTY. `desk-decisions` is the P&L journal and a fill
     *   written there is booked as real. `plannedFills` — parked at claim time,
     *   where nothing reads it as a position — is what `paper-fold.ts` joins
     *   each arriving fill back to.
     *
     *   THE IN-MEMORY BOOK IS NOT TOLD. `#tellBook` is for fills that just
     *   became real; it is called by the fold pass instead, at the moment they
     *   do.
     *
     * WHAT THE UNFOLDED BOOK COSTS, and who pays it. `applyActions` refuses an
     * open whose contract the book already holds, and on every other path the
     * book holds it because the decision that opened it folded HERE. It does
     * not fold here, so between this line and the fill the book says nothing
     * about a position that is on its way — and a second decision naming the
     * same contract would route a second order and land two legs on one
     * instrument, which the engine wire (which addresses contracts) could never
     * name again. `routes/engine.ts` closes that window explicitly, by refusing
     * an open whose contract already has a non-terminal order in the queue.
     * That guard is the paper rail's stand-in for the leg, and it is why it
     * lives at the door rather than in here: it must refuse before a decisionId
     * is claimed.
     *
     * A ROUTE ERROR STILL WINS THE STATUS, exactly as it does on the live path:
     * `FAILED` with `routeErrors` naming what did not go. It is deliberately
     * NOT softened to "WORKING with a note" — a supervisor reading WORKING
     * waits for fills, and half a package's worth of fills never arriving is
     * indistinguishable from a slow market.
     */
    if (worksAsync) {
      const workingStatus: DecisionStatus =
        routeErrors.length > 0 ? 'FAILED' : routedOrderIds.length === 0 ? 'DONE' : 'WORKING'
      await this.#d.store.collection(COLLECTIONS.decisions).updateOne(
        { decisionId: req.decisionId },
        {
          $set: {
            status: workingStatus,
            fills: [],
            routeErrors,
            /**
             * WHAT THE FOLD PASS HAS TO ACCOUNT FOR before this package is
             * finished. The `via` marker it scans by is already on the record
             * from claim time.
             */
            workingOrderIds: routedOrderIds,
            ...(workingStatus === 'WORKING' ? {} : { completedAt: this.#d.clock.now() }),
          },
        },
      )
      return {
        decisionId: req.decisionId,
        replayed: false,
        status: workingStatus,
        fills: [],
        skips: [...haltSkips, ...riskSkips, ...result.skips],
        // The book as it was READ, unchanged — this decision has not moved it.
        book,
        routeErrors,
      }
    }

    /**
     * Recomputed from only the actions that FULLY routed — see
     * `actionsFullyRouted` for why a half-routed action is dropped whole.
     */
    const savedBook =
      routeErrors.length === 0
        ? result.book
        : applyActions(book, actionsFullyRouted(permitted, failedTags), {
            master: this.#d.master.current(),
            marks: this.#d.marks,
            nowMs: now,
            underlying: req.symbol,
            expiry: req.expiry,
            /**
             * THE STALE-MARK CEILING IS DELIBERATELY OMITTED, and this is the
             * one place the two passes must differ.
             *
             * The ceiling is a PRICING decision: may this mark price NEW
             * exposure? It was asked and answered above, before anything
             * routed. This pass is BOOKKEEPING — it records what actually went
             * out — and it is fed a strictly narrower set of actions, so it can
             * never book something the first pass refused.
             *
             * Re-asking is not "identical rules", because the input moved:
             * `QuoteCache.markAge` reads `Date.now()`, and routing is N network
             * round trips. An open that legitimately passed the ceiling at
             * decision time ages past it DURING routing, the recompute skips
             * it, and a leg with a real broker order behind it drops off the
             * book — the exact phantom-position shape (in reverse) that
             * `partitionRoutedFills` above exists to prevent.
             */
          }).book
    /**
     * COMPARE-AND-SET against the version read at the top of this method.
     *
     * `'conflict'` means somebody else wrote the book while we were routing —
     * an operator's "Close leg", a flatten, another decision. It is not an
     * error and it is not ours to overwrite: their write describes orders that
     * really went out, exactly as ours does. So we re-read and fold OUR routed
     * fills onto THEIR legs. See `book-write.ts` for why it retries once and
     * then gives up loudly rather than looping.
     */
    const saved = await this.#d.store.saveBook(
      { tag: req.tag, mode: req.mode, symbol: req.symbol, expiry: req.expiry },
      savedBook,
      now,
      bookVersion,
    )
    if (saved === 'conflict') {
      await refoldOnConflict({
        store: this.#d.store,
        key: { tag: req.tag, mode: req.mode, symbol: req.symbol, expiry: req.expiry },
        routedFills,
        nextBook: savedBook,
        priorBook: book,
        // An `open` is a leg this decision created; the retry must be able to
        // create it again on the winner's book.
        mayCreate: true,
        nowMs: now,
        log: (m) => console.error(m),
      })
    }

    const status: DecisionStatus = routeErrors.length === 0 ? 'DONE' : 'FAILED'
    await this.#d.store
      .collection(COLLECTIONS.decisions)
      .updateOne(
        { decisionId: req.decisionId },
        { $set: { status, fills: routedFills, routeErrors, completedAt: this.#d.clock.now() } },
      )
    // AFTER the durable write, and unable to affect it. `createdAt: now` is the
    // stamp the row above was claimed with, which is what `loadFills` files it
    // under — passing `clock.now()` here would file the same fills a few
    // milliseconds later than the reconcile will find them.
    this.#tellBook({ tag: req.tag, mode: req.mode, createdAt: now, fills: routedFills })

    /**
     * THE RESPONSE REPORTS WHAT ROUTED, exactly as the record does.
     *
     * The journal and the stored book were narrowed to the routed subset above,
     * but this return still handed back `result.fills` and `result.book` — the
     * PLAN — so the two disagreed and the caller was given the optimistic one.
     * A live decision refused by the allowlist came back
     * `{status: 'FAILED', fills: [1], book: [1 leg]}` beside a `desk-books` that
     * was correctly empty, and a desk that books its position from the response
     * (which is the whole point of returning one) carried a leg that has no
     * order behind it anywhere. `close-all` over that leg then places a REAL
     * order in the opposite direction.
     *
     * `routeErrors` remains the detail of what did not; `status` is `FAILED`
     * whenever it is non-empty.
     */
    return {
      decisionId: req.decisionId,
      replayed: false,
      status,
      fills: routedFills,
      skips: [...haltSkips, ...riskSkips, ...result.skips],
      book: savedBook,
      routeErrors,
    }
  }

  /**
   * Answer a replay of a decisionId we have already claimed.
   *
   * The whole safety of "retry under the SAME decisionId" rests on this being
   * honest in every state, INCLUDING the state where we do not yet know the
   * answer. It is the same three-state contract `submit.ts:#replay` publishes,
   * because the two order paths must not need two mental models:
   *
   *   - `DONE`    — every fill in the record reached a rail.
   *   - `FAILED`  — some or all of them did not; `routeErrors` says which.
   *   - `ROUTING` — the claim exists and its owner has not reported back.
   */
  async #replay(stored: StoredDecision, req: ActionsRequest): Promise<DecisionResponse> {
    const d = stored as StoredDecisionRecord
    // An absent `status` is a record written before the field existed. Those
    // were only ever written AFTER routing, so `DONE` is the true answer.
    const status: DecisionStatus = d.status ?? 'DONE'
    if (status === 'ROUTING') return await this.#resolveRouting(d, req)
    return {
      decisionId: req.decisionId,
      replayed: true,
      status,
      // The stored fills, which the routing loop narrowed to what ROUTED.
      fills: stored.fills,
      skips: stored.skips,
      book: await this.#d.store.loadBook(req.tag, req.mode),
      // Carried through rather than blanked: a replay of a FAILED decision that
      // reported no errors would leave the caller unable to see what failed.
      routeErrors: d.routeErrors ?? [],
    }
  }

  /**
   * A claim whose owner never reported back.
   *
   * FRESH: say so, and say nothing else. A `ROUTING` record younger than
   * `ROUTING_STALE_MS` most likely belongs to a request that is alive and
   * mid-loop right now, and reconciling it would read leg 0 as routed and leg 1
   * as lost microseconds before leg 1 routes. That is a WORSE lie than
   * "unknown": the desk books half a position and strands the rest.
   *
   * STALE: ask the RAIL'S OWN COLLECTION which orders exist. That is not a
   * guess — the order id is derived from the decisionId (`orderIdFor`), and
   * `rail.route` succeeding means exactly "this document was inserted", so its
   * presence is the same fact the routing loop would have recorded had it
   * survived.
   *
   * THE BOOK IS DELIBERATELY NOT REBUILT HERE. `desk-books` is keyed by
   * (tag, mode) and later decisions on this tag have almost certainly written
   * it since; recomputing it from a snapshot we no longer hold would discard
   * them. The decision record is repaired — which is what P&L reads — and the
   * book/desk disagreement it leaves is exactly what `/v1/desk/diff` exists to
   * surface.
   */
  async #resolveRouting(d: StoredDecisionRecord, req: ActionsRequest): Promise<DecisionResponse> {
    const planned = d.plannedFills ?? []
    const book = await this.#d.store.loadBook(req.tag, req.mode)
    if (this.#d.clock.now() - d.createdAt < ROUTING_STALE_MS) {
      return {
        decisionId: req.decisionId,
        replayed: true,
        status: 'ROUTING',
        indeterminate: true,
        reason:
          `routing outcome UNKNOWN for '${req.decisionId}': it was claimed but has not ` +
          `reported back. Retry the SAME decisionId — a new one would place a second set ` +
          `of orders. Do not book a position from this response.`,
        plannedFills: planned,
        // Empty, not the plan: nothing here is known to have routed.
        fills: [],
        skips: d.skips,
        book,
        routeErrors: [],
      }
    }

    const rail = railFor(req.mode, this.#d.rails)
    /**
     * WHICH LIFECYCLE THE CLAIM WAS MADE UNDER — read off the RECORD, never off
     * this request.
     *
     * `via` is stamped at claim time, so the stored value is what the crashed
     * process actually did; `req.via` is only what the caller resolving it says
     * now. The two can differ — a replay issued by anything other than the
     * engine endpoint, an operator retrying by hand, a future second client —
     * and every way they differ is expensive: reading `req.via` as absent would
     * probe `desk-paper-trade` for orders that are in the gateway queue and
     * report every one of them as LOST, which is the one answer that talks a
     * caller into routing them a second time. Reading it as present would do
     * the mirror image to a package that really did instant-fill.
     *
     * A record written before the field existed has no `via`, which is exactly
     * right: it was written by the old path.
     */
    const via = d.via
    // Where THIS package's orders landed, not where the rail's default ones do.
    const collection = routedCollection(rail, via)
    const routed: Fill[] = []
    const routedOrderIds: string[] = []
    const routeErrors: { fill: Fill; error: string }[] = []
    for (let i = 0; i < planned.length; i++) {
      const fill = planned[i] as Fill
      const orderId = orderIdFor(req.decisionId, i)
      const doc = await this.#d.store.collection(collection).findOne({ clientOrderId: orderId })
      if (doc === null) {
        routeErrors.push({
          fill,
          // The order ID is NAMED, so an operator can go and look for it: this
          // message is the only place the tranche that vanished is identified.
          error:
            `${orderId}: no order in ${collection} — the process that claimed this ` +
            `decision died before it routed`,
        })
      } else {
        routed.push(fill)
        routedOrderIds.push(orderId)
      }
    }

    /**
     * THE SAME THREE ANSWERS, EXCEPT WHEN THE FILLS ARE STILL TO COME (D14).
     *
     * For an engine PAPER package the orders this pass just evidenced are
     * QUEUED, not filled — the gateway may not even have claimed them yet — so
     * promoting them into `fills` would book positions off the existence of an
     * order document. It resolves to `WORKING` with an empty ledger and the
     * order ids the fold pass will account for, which is exactly the state the
     * crashed process would have written had it survived.
     */
    const worksAsync = via === 'engine' && d.mode === 'paper'
    const status: DecisionStatus =
      routeErrors.length > 0 ? 'FAILED' : worksAsync && routed.length > 0 ? 'WORKING' : 'DONE'
    const promoted = worksAsync ? [] : routed
    /**
     * Filtered on `status: 'ROUTING'` so this can never overwrite the truth.
     *
     * If the original process was merely wedged and finishes after us, its own
     * unfiltered write lands second and wins — it WATCHED the routing happen and
     * we only inferred it. If it lands first, this update matches nothing.
     */
    try {
      await this.#d.store.collection(COLLECTIONS.decisions).updateOne(
        { decisionId: req.decisionId, status: 'ROUTING' },
        {
          $set: {
            status,
            // Promoted only now, and only the legs the rail can still evidence:
            // `desk-decisions` is the P&L journal, so a fill written here is
            // booked as real.
            fills: promoted,
            routeErrors,
            ...(worksAsync ? { workingOrderIds: routedOrderIds } : {}),
            // Not for a package still working: `completedAt` is what says a
            // decision is finished, and this one has fills yet to arrive.
            ...(status === 'WORKING' ? {} : { completedAt: this.#d.clock.now() }),
            reconciledAt: this.#d.clock.now(),
          },
        },
      )
    } catch {
      // The answer below is already known and is not a guess, so failing to
      // CACHE it must not turn it into an error a caller resolves by routing
      // again. The record stays ROUTING and the next replay reconciles again.
    }

    return {
      decisionId: req.decisionId,
      replayed: true,
      status,
      fills: promoted,
      skips: d.skips,
      book,
      routeErrors,
    }
  }

  // ------------------------------------------------------------- safety

  async killSwitch(): Promise<KillSwitchState> {
    return await this.#d.store.loadKillSwitch()
  }

  async setKillSwitch(enabled: boolean, reason: string, setBy: string): Promise<KillSwitchState> {
    const state: KillSwitchState = { enabled, reason, setBy, setAt: this.#d.clock.now() }
    await this.#d.store.saveKillSwitch(state)
    return state
  }

  async brokerLink(): Promise<BrokerLinkState> {
    return await this.#d.store.loadBrokerLink()
  }

  /**
   * Write the wish; answer with the whole document, gateway ack included, so
   * the caller renders "asked" beside whatever the gateway last said.
   */
  async setBrokerLink(desired: BrokerLinkDesired, reason: string, setBy: string): Promise<BrokerLinkState> {
    await this.#d.store.saveBrokerLink({ desired, reason, setBy, setAt: this.#d.clock.now() })
    return await this.#d.store.loadBrokerLink()
  }

  // --------------------------------------------------------- strategies

  /** The registry, as the portal's Strategies page renders it. */
  async strategies(): Promise<readonly StrategyRow[]> {
    return await this.#d.store.listStrategies()
  }

  /**
   * Null when the tag is not registered — the HTTP layer turns that into 404.
   *
   * `expectedUpdatedAt` pins the row version the caller's re-auth decision was
   * made against; `'conflict'` comes back when another writer moved the row in
   * between. See `DeskStore.patchStrategy` for why that is a security control.
   */
  async patchStrategy(
    tag: string,
    patch: StrategyPatch,
    expectedUpdatedAt?: number,
  ): Promise<StrategyRow | null | 'conflict'> {
    return await this.#d.store.patchStrategy(tag, patch, this.#d.clock.now(), expectedUpdatedAt)
  }

  /**
   * Seed or REPLACE a row wholesale. Still not reachable from HTTP.
   *
   * `createStrategy` is what the portal's add form reaches, and the difference
   * matters: this one overwrites, so a POST wired to it would let "add a
   * strategy" silently reset a running row's switches. Seeding is the only
   * caller that legitimately wants an upsert.
   */
  async registerStrategy(row: Partial<StrategyRow> & { tag: string }): Promise<StrategyRow> {
    return await this.#d.store.registerStrategy(row, this.#d.clock.now())
  }

  /** Add a strategy to one mode. `'exists'` when it is already added (409). */
  async addStrategyMode(
    row: Partial<StrategyRow> & { tag: string },
    mode: DeskMode,
  ): Promise<StrategyRow | 'exists'> {
    return await this.#d.store.addStrategyMode(row, mode, this.#d.clock.now())
  }

  /** Take a strategy off one mode's page. Null / `'absent'` are both 404. */
  async removeStrategyMode(
    tag: string,
    mode: DeskMode,
  ): Promise<StrategyRow | null | 'absent'> {
    return await this.#d.store.removeStrategyMode(tag, mode, this.#d.clock.now())
  }

  /**
   * The tags of every stored book on one symbol, sorted. The CHEAP lookup —
   * `booksForSymbol` above prices each book, which a caller asking "which books
   * exist here?" does not need.
   *
   * This is what turns a symbol into a book key for close-all. It exists
   * because a synthesised `DESK_${symbol}` did that job and is not a key: with
   * books keyed by tag, an invented tag names a book that does not exist, and
   * `loadBook` answers `[]` — a flatten that reports DONE with no fills over a
   * book that is still open. The caller must be able to tell "one book",
   * "none" and "several" apart, so this returns the list rather than a guess.
   */
  async bookTagsForSymbol(symbol: string, mode: DeskMode): Promise<readonly string[]> {
    const rows = await this.#d.store.booksForSymbol(symbol, mode)
    return rows.map((r) => r.tag).sort()
  }

  /**
   * Flatten a book.
   *
   * DELIBERATELY IGNORES BOTH SWITCHES: closing is what the halt is for, not
   * something it obstructs, and the strategy switch blocks the STRATEGY's
   * exits — not the operator's. Flattening runs as you. Without this exemption
   * switching a book off would leave its position unmanaged AND unclosable.
   * One decisionId covers every leg, so a retried close-all cannot double-sell.
   */
  async closeAll(params: {
    symbol: string
    mode: DeskMode
    tag: string
    decisionId: string
    style: CloseStyle
    aggressionPct?: number
  }): Promise<DecisionResponse & { unpriceable: readonly string[] }> {
    // The WHOLE document, not just the legs. The expiry has to come from the
    // book itself: `book[0]?.expiry ?? ''` read it off the first leg, so
    // flattening an already-flat book passed `expiry: ''` down to `saveBook`
    // and blanked the stored one. An empty expiry is not nullish, so it beats
    // the `?? legs[0]?.expiry` fallback in marketdata's `subscriptionBooks`,
    // and `strikes(underlying, '')` subscribes nothing — the book could never
    // open its next leg. That is the Task 6 defect, reached through close-all.
    const doc = await this.#d.store.bookDoc(params.tag, params.mode)
    // A BOOK THAT WAS NEVER LOADED IS NEVER SAVED. `saveBook` upserts, so a tag
    // naming no book planned nothing, closed nothing, answered DONE, and minted
    // a row under the typo carrying the blank expiry the comment above
    // describes. The route answers this as a 409 with the real tags; this throw
    // is the layer under it, so no other caller can reach the same corruption.
    if (doc === null) {
      throw new Error(
        `close-all: no ${params.mode} book stored under tag '${params.tag}' — nothing to close`,
      )
    }
    const book = [...(doc.legs ?? [])]
    const plan = planCloseAll({
      book,
      style: params.style,
      ...(params.aggressionPct === undefined ? {} : { aggressionPct: params.aggressionPct }),
      marks: (leg) => this.#d.marks.price(leg.instrument),
    })
    const expiry = doc.expiry ?? book[0]?.expiry ?? ''
    const res = await this.applyDecision(
      {
        symbol: params.symbol,
        expiry,
        mode: params.mode,
        tag: params.tag,
        decisionId: params.decisionId,
        actions: plan.actions,
      },
      plan.pricing,
      true,
    )
    return { ...res, unpriceable: plan.unpriceable }
  }

  /**
   * Close ONE CONTRACT out of a book, leaving every other leg alone.
   *
   * WHY THIS EXISTS. `closeAll` is all-or-nothing, and the desk's real need is
   * narrower: a short option whose delta has decayed to ~0.10 is no longer
   * doing any work in the structure, but it still consumes margin and still
   * carries the tail. An operator wants that one strike gone without
   * dismantling the position around it.
   *
   * IT IS `closeAll` WITH A FILTERED BOOK, deliberately. The planning, the
   * pricing, the operator exemption, the `decisionId` idempotency and the book
   * maintenance are all the existing path — the only new thing is WHICH legs
   * are handed to `planCloseAll`. A second implementation of "how does an exit
   * get priced and routed" would be a second thing to keep correct, and the one
   * that drifts is the one that stops filling.
   *
   * EVERY LEG ON THE CONTRACT, not the first match. A book can hold the same
   * strike more than once (`recenter-relief` sells a strike, then sells more of
   * it at a later mark under a fresh leg id), and the net-positions table an
   * operator clicks from shows the NETTED contract. Closing one of three legs
   * while the table says the contract is gone is the worst available outcome.
   *
   * THE REFUSALS ARE TYPED, NOT THROWN, and both mean "nothing was closed":
   *
   *   - `no-book` — no book document for this tag/mode at all.
   *   - `no-leg` — the book holds nothing on that contract. `held` names what
   *     it DOES hold, because the realistic cause is a stale dashboard: the
   *     strategy closed the leg itself between the render and the click.
   */
  async closeLeg(params: {
    tag: string
    mode: DeskMode
    tradingsymbol: string
    decisionId: string
    style: CloseStyle
    aggressionPct?: number
  }): Promise<
    | { readonly ok: false; readonly reason: 'no-book' | 'no-leg'; readonly held: readonly string[] }
    | (DecisionResponse & {
        readonly ok: true
        readonly closed: readonly string[]
        readonly unpriceable: readonly string[]
      })
  > {
    const doc = await this.#d.store.bookDoc(params.tag, params.mode)
    if (doc === null) return { ok: false, reason: 'no-book', held: [] }
    const all = [...(doc.legs ?? [])]
    const mine = all.filter((l) => l.instrument.tradingsymbol === params.tradingsymbol)
    if (mine.length === 0) {
      return {
        ok: false,
        reason: 'no-leg',
        held: [...new Set(all.map((l) => l.instrument.tradingsymbol))],
      }
    }
    const plan = planCloseAll({
      book: mine,
      style: params.style,
      ...(params.aggressionPct === undefined ? {} : { aggressionPct: params.aggressionPct }),
      marks: (leg) => this.#d.marks.price(leg.instrument),
    })
    /**
     * THE BOOK's expiry, never the leg's — the same trap `closeAll` documents
     * one method up. `applyDecision` passes this straight to `saveBook`, so a
     * blank or leg-derived expiry rewrites the stored one and the book can
     * never open another leg.
     */
    const expiry = doc.expiry ?? all[0]?.expiry ?? ''
    const res = await this.applyDecision(
      {
        symbol: doc.symbol ?? '',
        expiry,
        mode: params.mode,
        tag: params.tag,
        decisionId: params.decisionId,
        actions: plan.actions,
      },
      plan.pricing,
      // Operator-initiated, exactly as `closeAll` is: this runs as the human,
      // so a switched-off strategy must not be able to trap the leg.
      true,
    )
    return {
      ...res,
      ok: true,
      closed: mine.map((l) => l.deskTag),
      unpriceable: plan.unpriceable,
    }
  }

  /**
   * Flatten a HOSTED strategy's position, by tag.
   *
   * THE WHOLE PATH LIVES IN `flatten.ts` — the reconstruction from the fill
   * journal, the exit plan, the claim, the routing loop and the book
   * maintenance, with the war stories that explain each of them. It is served
   * from here because this is the object every caller already holds; the method
   * is otherwise a straight hand-off to `FlattenService`, which runs on THESE
   * deps and this service's own `#tellBook`.
   */
  async flattenTag(params: FlattenParams): Promise<FlattenResponse> {
    return await this.#flatten.flattenTag(params)
  }

  /**
   * Open legs with per-leg greeks and net book delta, computed here (D5).
   *
   * Keyed by TAG, not symbol — two tags on one underlying are two independent
   * books (the whole point of this phase). The underlying is no longer a
   * parameter; it is read off the stored document, because the caller only
   * knows the tag. A tag with no book yet (or ever) yields an empty document:
   * `legs` is `[]` and `symbol` is `''`. That is safe rather than bogus here —
   * `spotToken('')` resolves to `null`, so `spot` comes back `null` too, and
   * with zero legs there is nothing for a null spot to mis-price. The book
   * reports `complete: true, greeks: {netDelta: 0, ...}`, which is the correct
   * answer for a book that genuinely holds nothing.
   */
  /**
   * Serve legs at the prices that ACTUALLY traded, not the seeds.
   *
   * The book document's `entryPrice` is the mark the desk assumed when it
   * SUBMITTED the order; the broker's average is what money changed hands at.
   * On 2026-08-04 the marketable entries crossed the spread favourably on
   * every leg and the MTM tile read ~Rs.4,275 worse than the truth on one
   * book — the operator's call is "actual MTM only". The override lives here,
   * at the one place legs are served, because the book doc is re-declared by
   * the Python desk and any correction written INTO it would be clobbered.
   *
   * Averages come from the gateway's FILLED/PARTIAL/HALTED orders for the tag —
   * broker-confirmed, side-matched, qty-weighted across adds. A leg with no
   * filled order on its side keeps its seed: an honest assumption is better
   * than a guess joined from the wrong side.
   *
   * HALTED is in that list because it is a real position too: a fill-gated
   * order stopped part-way still traded the tranches that went out, at a
   * broker-confirmed average sitting on the very same fields. Leaving it out
   * would mark those legs at the seed price — the 2026-08-04 MTM error, on the
   * one order shape most likely to need looking at.
   */
  async #actualEntries(
    tag: string,
    mode: DeskMode,
    legs: readonly BridgeLeg[],
  ): Promise<readonly BridgeLeg[]> {
    if (mode !== 'live' || legs.length === 0) return legs
    const orders = await this.#d.store
      .collection<Record<string, unknown>>(COLLECTIONS.gatewayOrders)
      .find({ tag, state: { $in: ['FILLED', 'PARTIAL', 'HALTED'] } })
      .toArray()
    const acc = new Map<string, { qty: number; value: number }>()
    for (const o of orders) {
      const qty = Number(o['filledQty'] ?? 0)
      const avg = Number(o['avgPrice'] ?? Number.NaN)
      if (qty <= 0 || !Number.isFinite(avg)) continue
      const key = `${String(o['tradingsymbol'] ?? '')}|${String(o['transaction_type'] ?? '')}`
      const a = acc.get(key) ?? { qty: 0, value: 0 }
      a.qty += qty
      a.value += qty * avg
      acc.set(key, a)
    }
    if (acc.size === 0) return legs
    return legs.map((l) => {
      const a = acc.get(`${l.instrument.tradingsymbol}|${l.qty > 0 ? 'BUY' : 'SELL'}`)
      if (a === undefined || a.qty <= 0) return l
      return { ...l, entryPrice: a.value / a.qty }
    })
  }

  /**
   * `opts.realised` asks for the book's realised-to-date alongside the legs —
   * see the field on `PositionsResponse` for what it is and why it is opt-in.
   * Only the single-book route passes it; the per-book loops in `books()` and
   * `booksForSymbol` never do, so the tab strip stays as cheap as it was.
   */
  async positions(
    tag: string,
    mode: DeskMode,
    opts: { readonly realised?: boolean } = {},
  ): Promise<PositionsResponse> {
    const doc = await this.#d.store.bookDoc(tag, mode)
    // The strategy's own greeks, if it has published any recently. Read here
    // rather than in the caller so EVERY consumer of `positions` — the book
    // page's tiles, the book tabs, the Books table — gets the same number
    // without three render sites having to agree about which to prefer.
    const declared = await this.#d.store.loadDeclaration(tag)
    const legs = await this.#actualEntries(tag, mode, doc?.legs ?? [])
    const symbol = doc?.symbol ?? ''
    const now = this.#d.clock.now()
    // Spot must use the DISPLAY path too. Every leg needs spot to price, so a
    // null spot drops the whole book even when each leg's own mark resolved
    // from the snapshot — which is exactly what happened after the close.
    const spotToken = this.#d.master.current().spotToken(symbol)
    const spot =
      this.#d.displaySpot !== undefined
        ? this.#d.displaySpot(symbol, spotToken)
        : this.#d.marks.spot(symbol)
    const priced: PositionLeg[] = []
    // Legs dropped BEFORE greeks — no mark, or no spot to price against.
    // These must be reported, not silently skipped: `bookGreeks` can only name
    // legs it was given, so a leg dropped here would vanish from both the
    // totals AND the unpriced list, and a fully-unmarked book would report
    // netDelta 0 — indistinguishable from genuinely flat. On a delta dashboard
    // that reads as "no action needed" while the book is carrying real risk.
    const unmarked: string[] = []
    // Quote-less legs, carried separately so the MODEL PASS below can price
    // them theoretically off spot and expiry. `markPrice: 0` never solves an
    // IV, so they cost nothing on the market-priced pass.
    const quoteless: PositionLeg[] = []
    // Display path: falls back to the persisted snapshot when the feed is down,
    // so a book still renders out of hours. Flagged via `live` below; the ORDER
    // path (applyActions) never sees this and still refuses a stale price.
    const display = this.#d.displayMarks
    /**
     * EXIT-SIDE VALUATION, when the seam is wired: each leg priced at the side
     * of the book that would close it — long at bid, short at ask — and LTP
     * never substitutes (operator directive 2026-08-21, the BHEL +25k display
     * incident: this very page held a morning number all afternoon). A leg
     * whose book cannot answer goes through the same unmarked/model-pass flow
     * an unpriced leg always has. Absent seam (tests with `StaticMarks`) keeps
     * the old display/price chain.
     */
    const exitQuotes = this.#d.displayExitQuotes
    const quotes: Record<string, LegQuote> = {}
    let anyStale = false
    let asOf: number | null = null
    for (const l of legs) {
      const token = l.instrument.instrumentToken
      const exit: ExitSide = l.qty > 0 ? 'Sell' : 'Buy'
      const eq: ExitQuote | null =
        exitQuotes !== undefined && token !== undefined ? exitQuotes(token, exit) : null
      const dm =
        exitQuotes === undefined && display !== undefined && token !== undefined ? display(token) : null
      const mark = exitQuotes !== undefined ? (eq?.price ?? null) : (dm?.price ?? this.#d.marks.price(l.instrument))
      if (eq !== null) {
        quotes[l.instrument.tradingsymbol] = { bid: eq.bid, ask: eq.ask, basis: eq.basis, asOf: eq.asOf }
        if (eq.basis === 'snapshot') {
          anyStale = true
          asOf = asOf === null ? eq.asOf : Math.min(asOf, eq.asOf)
        }
      } else if (dm !== null && dm !== undefined && !dm.live) {
        anyStale = true
        asOf = asOf === null ? dm.asOf : Math.min(asOf, dm.asOf)
      }
      if (spot === null) {
        unmarked.push(l.instrument.tradingsymbol)
        continue
      }
      const leg: PositionLeg = {
        tradingsymbol: l.instrument.tradingsymbol,
        underlying: l.underlying,
        strike: l.strike,
        type: l.type,
        expiry: l.expiry,
        qty: l.qty,
        spot,
        markPrice: mark ?? 0,
      }
      if (mark === null) {
        unmarked.push(l.instrument.tradingsymbol)
        quoteless.push(leg)
        continue
      }
      priced.push(leg)
    }
    /**
     * BLACK-76, VIA THE CARRY. Stock options price off the FUTURE, not cash
     * spot — the market's own arithmetic proved it on TCS 2440PE
     * (2026-08-17): future 2328.8 over spot 2318.6, so the put's 116.30 mid
     * sat below the cash no-arbitrage floor (117.93) and admitted NO vol,
     * while against the future the same quote solves at 26.4%, in line with
     * its neighbours. `carryYield` turns the future's own mark into the
     * dividend yield that lands BS on that forward — one model, priced where
     * the hedge trades, and the same convention the Python desk uses (whose
     * disagreements with this page — the BHEL sign flip of 08-14 — were
     * exactly this carry).
     */
    const RATE = 0.065
    const futRef = this.#d.master.current().future(symbol)
    let futMark: number | null = null
    if (futRef !== null && futRef !== undefined) {
      const t = futRef.instrumentToken
      if (display !== undefined && t !== undefined) futMark = display(t)?.price ?? null
      if (futMark === null) futMark = this.#d.marks.price(futRef)
    }
    const tBook = doc?.expiry !== undefined && doc?.expiry !== '' ? yearsToExpiry(doc.expiry, now) : 0
    const carry = spot !== null && futMark !== null && tBook > 0
      ? carryYield(spot, futMark, tBook, RATE)
      : null
    const greekOpts = { rate: RATE, ...(carry === null ? {} : { dividendYield: carry }) }

    let greeks = bookGreeks(priced, now, greekOpts)
    /**
     * THE MODEL PASS. Two kinds of leg can still fall out of the market-priced
     * pass: a quote that admits no IV even against the forward (a print
     * pinned below carry-implied intrinsic), and no quote at all. Both are
     * re-priced THEORETICALLY, off spot/forward and expiry at the book's own
     * median solved IV, and named in `greeks.fallbackPriced` so the page can
     * say "estimate" instead of showing a hole that reads as flat. No
     * reference IV (nothing solved) → nothing modelled, and they stay in
     * `unpriced` as before.
     */
    if (greeks.unpriced.length > 0 || quoteless.length > 0) {
      const ref = medianSolvedIv(greeks.legs)
      if (ref !== null) greeks = bookGreeks([...priced, ...quoteless], now, { ...greekOpts, fallbackVol: ref })
    }
    const modeled = new Set(greeks.fallbackPriced)
    const stillUnmarked = unmarked.filter((s) => !modeled.has(s))
    /**
     * THE MARK COLUMN STAYS THE MARKET'S. A fallback-priced leg that HAS a
     * quote keeps that quote as its displayed price and P&L basis — the model
     * supplied its greeks, not its price. Showing the model price beside the
     * broker's own panel produced two "marks" ~7 rupees apart on the same leg
     * (123.61 vs 116.00, 2026-08-17); the model price is shown only for a leg
     * with no quote at all.
     */
    if (modeled.size > 0) {
      const quoteBySymbol = new Map(priced.map((l) => [l.tradingsymbol, l.markPrice]))
      greeks = {
        ...greeks,
        legs: greeks.legs.map((l) => {
          const mkt = quoteBySymbol.get(l.tradingsymbol)
          return modeled.has(l.tradingsymbol) && mkt !== undefined && mkt > 0 ? { ...l, price: mkt } : l
        }),
      }
    }

    /**
     * IS THE STRATEGY'S PUBLISHED SET STILL CURRENT?
     *
     * A running driver republishes every tick (~30s) and decides on a 5-minute
     * grid, so six minutes is one full mark plus slack: long enough that a
     * single missed tick does not blank the figure, short enough that a stopped
     * or wedged strategy is caught within one mark. Only `steering` is served
     * from it — see below.
     */
    const sg = declared?.greeks
    const sgAt = declared?.greeksAt ?? null
    const fresh = sg !== undefined && sgAt !== null && now - sgAt <= STRATEGY_GREEKS_MAX_AGE_MS

    /**
     * THE HEADLINE GREEKS ARE THIS ENGINE'S, and the per-leg ones beside them
     * are too. That consistency is the point.
     *
     * They were briefly served from the strategy's published set instead, which
     * broke an invariant the page is read on: the `Pos delta` column sums to the
     * `Net delta` tile. The strategy prices off the FUTURE and this engine off
     * cash spot, so the headline came out -47 over a column totalling +174 —
     * about `netGamma x (future - spot)` apart — and the operator was left with
     * two numbers that could not be reconciled by looking.
     *
     * Mixing was the mistake, not either model: `greeks.legs` comes from
     * `bookGreeks` and there are no per-leg figures on the wire to replace them
     * with. One engine for the whole response, and the genuinely different
     * number — what the RULES steer by — is served separately as `steering`,
     * where it is labelled rather than silently swapped in.
     */
    return {
      tag,
      symbol,
      mode,
      legs,
      greeks: { ...greeks, unpriced: [...stillUnmarked, ...greeks.unpriced] },
      // Only from a FRESH set, on the same staleness rule as the greeks: a
      // steering figure from an hour ago is exactly as misleading as a stale
      // delta, and worse for looking like a live comparison.
      steering:
        fresh && sg.steeringDelta !== undefined && sg.steeringGamma !== undefined
          ? { delta: sg.steeringDelta, gamma: sg.steeringGamma }
          : null,
      spot,
      asOf: now,
      /** True when any mark came from the snapshot rather than a live tick. */
      stale: anyStale,
      /** When the oldest displayed mark was true. Null when all are live. */
      marksAsOf: asOf,
      // The pair each leg was valued off — only when the exit-side seam is
      // wired, so a StaticMarks test response looks exactly as it always did.
      ...(exitQuotes !== undefined ? { quotes } : {}),
      /** True only when EVERY leg priced — market or model. The dashboard
       *  must not show a net delta as authoritative when it is MISSING legs;
       *  a model-priced leg is included (and named in `fallbackPriced`), so it
       *  does not break completeness, it qualifies it. */
      complete: stillUnmarked.length === 0 && greeks.unpriced.length === 0,
      // Spread rather than `realised: undefined` — `exactOptionalPropertyTypes`
      // says absent, and a reader must be able to tell "not asked for" (absent)
      // from "asked for and unknowable" (null).
      ...(opts.realised === true
        ? { realised: await this.#realisedToDate(tag, mode, now) }
        : {}),
    }
  }

  /**
   * What this book has BOOKED over the P&L lookback, or null when the number
   * cannot be vouched for. See `PositionsResponse.realised` for the story.
   *
   * THE READ IS `flattenTag`'s: `desk-decisions` through `PnlStore.loadFills`
   * (`DeskStore` satisfies its `Database` port structurally), netted by
   * `buildPositions`. Those fills are the ones the live reconciler restates to
   * broker truth, so this figure is the broker's — a fourth reconstruction of
   * "what did this tag book" would be a fourth thing to keep correct.
   *
   * CUMULATIVE, NOT THE WINDOW'S: `Position.realised` is summed as-is, with no
   * carried-realised subtraction — the subtraction is what makes the P&L card
   * a DAY figure, and this is a since-entry one, the same basis as the table's
   * Total it sits beside. The lookback is the same dial position rebuilding
   * has always leaned on ("must comfortably exceed how long a book is
   * carried"), so for any book opened inside it, cumulative IS to-date.
   *
   * NULL — NEVER 0 — whenever the sum would be understated by an unknown
   * amount, the rule every other figure on this payload keeps:
   *
   *  - the fill read hit its cap (`truncated`): the missing fills are missing
   *    money;
   *  - a stored fill could not be read (`malformedByKey`, THIS rail's only —
   *    the F-53 lesson);
   *  - an open position's first fill in the window is not an OPEN
   *    (`partitionOpenPositions`): a seeded book, or one carried past the
   *    lookback — its closes would realise against a cost basis that is not
   *    in the window, or against nothing at all.
   *
   * Errors degrade to null rather than throw, the `withOrderContext` rule: the
   * legs and greeks above are the page, and they must not 500 because a
   * decoration on them could not be computed.
   */
  async #realisedToDate(tag: string, mode: DeskMode, nowMs: number): Promise<number | null> {
    try {
      const load = await new PnlStore(this.#d.store).loadFills({
        from: nowMs - lookbackDaysOf({}) * DAY_MS,
        to: nowMs + 1,
        tag,
        mode,
      })
      if (load.truncated) return null
      const key = pnlKey(tag, mode)
      if ((load.malformedByKey.get(key)?.length ?? 0) > 0) return null
      const fills = load.byKey.get(key) ?? []
      const positions = buildPositions(fills)
      if (partitionOpenPositions(positions, fills).truncated.length > 0) return null
      let realised = 0
      for (const p of positions) realised += p.realised
      // NET of the venue's fees, as the day's `cumRealized` is. 0 on NSE,
      // whose fills carry no `fee`.
      for (const f of fills) realised -= feeOf(f)
      return realised
    } catch {
      return null
    }
  }

  /** D2: our executed book vs what the desk says it holds. No arbitration. */
  async diff(tag: string, mode: DeskMode): Promise<BookDiff & { declaredAt: number | null }> {
    const [ours, declared] = await Promise.all([
      this.#d.store.loadBook(tag, mode),
      this.#d.store.loadDeclaration(tag),
    ])
    const d = diffBooks(declared?.legs ?? [], ours)
    return { ...d, declaredAt: declared?.declaredAt ?? null }
  }

  async declare(
    tag: string,
    symbol: string,
    legs: readonly DeclaredLeg[],
    greeks?: DeclaredGreeks,
  ): Promise<void> {
    await this.#d.store.saveDeclaration(tag, symbol, legs, this.#d.clock.now(), greeks)
  }

  /**
   * Record an already-held position. Routes NOTHING — see seed.ts.
   *
   * Throws when the book is non-empty and `replace` was not asked for, which
   * the HTTP layer turns into a 409. Re-running a seed against a live book
   * would discard every fill since it was opened.
   */
  async seed(req: SeedRequest & { replace: boolean }): Promise<SeedResult> {
    return await seedBook(req, {
      store: this.#d.store,
      master: this.#d.master.current(),
      nowMs: this.#d.clock.now(),
      replace: req.replace,
    })
  }

  /**
   * The order journal — every submission attempt with its outcome.
   *
   * `failuresOnly` exists because "what went wrong today" is the query an
   * operator actually runs, and scanning a full feed for the red lines is a
   * worse way to answer it.
   */
  async orderEvents(
    opts: { limit?: number; failuresOnly?: boolean; mode?: DeskMode } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    const limit = opts.limit ?? 200
    const filter: Record<string, unknown> = opts.failuresOnly === true ? { ok: false } : {}
    /**
     * MODE SCOPING, same rule as `PnlStore.orderEvents` — see the note there.
     * `desk-order-events` holds live routing plus refusals from BOTH rails, so
     * unscoped this page showed a paper rejection under LIVE, and showed PAPER
     * nothing at all because the paper rail's fills are in another collection.
     * An event is paper iff it says so.
     *
     * THE GATEWAY STAMPS ITS OWN ROWS NOW (D9's removal ticket, closing the
     * gap D14 opened). "The gateway is live by construction" was true while
     * `apps/order-gateway` only ever saw live orders; once it began working the
     * engine's PAPER orders through the same queue, its unstamped PLANNED /
     * SUBMITTED / ACK / STATUS / refusal rows fell on the LIVE side of this
     * filter and were missing from the PAPER side — a rehearsal's routing
     * rendered on the live Orders tab. `OrderEvent.mode` is supplied per event
     * from the order document and folded into `detail.mode` by the journal
     * writer, so this filter now separates the two rails at the source.
     *
     * `$ne 'paper'` still means every row written before the stamp existed —
     * all of them live — keeps reading as live, with no backfill.
     */
    if (opts.mode === 'paper') filter['detail.mode'] = 'paper'
    else if (opts.mode === 'live') filter['detail.mode'] = { $ne: 'paper' }
    const events = await this.#d.store
      .collection(COLLECTIONS.orderEvents)
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray()
    // A paper fill is never a failure, so `failuresOnly` is already answered.
    //
    // `withOrderContext` first: nothing on the live rail journals a direction
    // or its order's intent, so the Side column was `—` on every live row ever
    // written (see its docstring).
    if (opts.mode !== 'paper' || opts.failuresOnly === true) {
      return await withOrderContext(this.#d.store, events)
    }

    const fills = await this.#d.store
      .collection(COLLECTIONS.paperTrade)
      .find({})
      .sort({ order_timestamp: -1 })
      .limit(limit)
      .toArray()
    // Sorted across both sources then capped once — capping each first would
    // interleave two truncated tails and lose recent rows from the busier one.
    return await withOrderContext(
      this.#d.store,
      [...events, ...fills.map(paperFillEvent)]
        .sort((a, b) => Number(b['ts']) - Number(a['ts']))
        .slice(0, limit),
    )
  }

  /**
   * Broker fills, newest first. What actually happened, not what we asked for.
   *
   * `desk-fills` is written by `apps/order-gateway/src/main.ts:184` as the
   * broker's fill stream lands. It is a literal rather than a `COLLECTIONS`
   * entry because `COLLECTIONS` names the collections THIS app writes, and the
   * gateway owns this one — adding it here would imply an ownership that does
   * not exist. Verified against the writer, not assumed.
   *
   * `tag` is required for per-book reconciliation — without it a two-variant
   * symbol returns the sibling book's fills and the reconcile corrects the
   * wrong legs.
   */
  async fills(
    opts: { readonly tag?: string | null | undefined; readonly limit?: number | undefined } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    /**
     * LIVE ROWS ONLY, and this is a filter rather than an assumption as of D14.
     *
     * `desk-fills` used to hold nothing but broker fills, because the gateway
     * only ever saw live orders. It now also holds the SIMULATED fills of an
     * engine paper book worked through the same queue (`rail.ts`,
     * `fills.ts:OrderShape.mode`) — and this method serves
     * `/v1/desk/trades?mode=live`, so without the clause a paper rehearsal's
     * trades would appear on the live tab of a tag that trades on both rails.
     *
     * `$ne` matches a missing field, so every fill written before the mode
     * existed still qualifies.
     */
    const filter: Record<string, unknown> = { mode: { $ne: 'paper' } }
    if (opts.tag !== undefined && opts.tag !== null) filter['tag'] = opts.tag
    return await this.#d.store
      .collection('desk-fills')
      .find(filter)
      .sort({ ts: -1 })
      .limit(opts.limit ?? 200)
      .toArray()
  }

  /**
   * Paper-side trades, for the paper book's history — FROM BOTH PAPER WRITERS.
   *
   * There are two, and there have been since D14 gave the engine's paper orders
   * the live order's life:
   *
   *   `desk-paper-trade` — the synchronous paper rail. `/v1/desk/submit`, the
   *   runner's hosted strategies and `closeAll` book a fill at the moment of
   *   the write, and that document IS the trade.
   *
   *   `desk-fills` with `mode: 'paper'` — the engine's paper orders, worked
   *   through the gateway queue and filled by a tick that crossed them. The
   *   gateway writes the fill exactly where it writes a live one, with the rail
   *   on the row.
   *
   * Serving only the first meant a rehearsal traded all morning and the Trades
   * tab showed nothing — the one surface that answers "did the engine actually
   * fill?" during the rehearsal it exists for.
   *
   * THE TWO SHAPES ARE NOT MERGED INTO ONE. A `desk-fills` row is exactly what
   * `fills()` already serves to `?mode=live`, so both shapes are already part
   * of this endpoint's contract, and normalising one into the other would mean
   * inventing `order_timestamp`/`price` keys for a row that has `ts`/`avgPrice`
   * — a rewrite that reads as provenance. Each row keeps its own shape and says
   * which writer produced it.
   *
   * SORTED ACROSS BOTH, THEN CAPPED ONCE, for the reason `orderEvents` gives
   * beside its own union: taking the newest `limit` of each and concatenating
   * interleaves two truncated tails and drops recent rows from the busier one.
   */
  async paperTrades(
    opts: {
      readonly tag?: string | null | undefined
      readonly symbol?: string | null | undefined
      readonly limit?: number | undefined
    } = {},
  ): Promise<readonly Record<string, unknown>[]> {
    const limit = opts.limit ?? 200
    const rail = await this.#d.store.listPaperTrades(opts)

    /**
     * A `?symbol=`-ONLY QUERY GETS THE RAIL'S ROWS AND NOTHING ELSE.
     *
     * `desk-fills` carries the CONTRACT and the TAG, never the underlying (see
     * `toFillRecord`), so there is no honest way to answer "this symbol" from
     * it. Returning the lot regardless would put another book's trades under a
     * symbol that never traded them, which is worse than a short answer. A
     * `?tag=` query has no such problem — a tag is one book on one symbol — and
     * it is what every per-book read uses.
     */
    const tagged = opts.tag !== undefined && opts.tag !== null
    if (!tagged && opts.symbol !== undefined && opts.symbol !== null) return rail.slice(0, limit)

    /**
     * `mode: 'paper'` EXACTLY, and never `$ne: 'live'` — the mirror of the
     * clause in `fills()`. An unstamped row is a live broker fill from before
     * the field existed, and matching it here would put real trades on the
     * paper tab.
     */
    const engineFilter: Record<string, unknown> = { mode: 'paper' }
    if (tagged) engineFilter['tag'] = opts.tag
    let engine: Record<string, unknown>[] = []
    try {
      engine = await this.#d.store
        .collection('desk-fills')
        .find(engineFilter)
        .sort({ ts: -1 })
        .limit(limit)
        .toArray()
    } catch {
      // A history page that is missing the engine's half is degraded; one that
      // 500s is gone. The rail's own rows are already in hand.
      return rail.slice(0, limit)
    }
    if (engine.length === 0) return rail.slice(0, limit)

    return [...rail, ...engine]
      .sort((a, b) => paperTradeTs(b) - paperTradeTs(a))
      .slice(0, limit)
  }

  /**
   * Every book on one symbol, each fully priced.
   *
   * `symbol` stopped being a book key when tags took over (see `positions`
   * above) — a symbol can now carry several independent books at once, so
   * there is no single "the" book to hand back. This answers with all of
   * them rather than picking one arbitrarily.
   */
  async booksForSymbol(symbol: string, mode: DeskMode): Promise<readonly PositionsResponse[]> {
    const rows = await this.#d.store.booksForSymbol(symbol, mode)
    const out: PositionsResponse[] = []
    for (const r of rows) {
      try {
        out.push(await this.positions(r.tag, mode))
      } catch {
        // Same isolation as `books()` below: one book on this symbol that
        // cannot be read must not take every OTHER book on the symbol down
        // with it — `Promise.all` would turn one bad tag into a 500 for the
        // whole `?symbol=` request. Reported in a degraded-but-honest form
        // (`complete: false`, every leg named in `unpriced`) rather than
        // dropped silently, which would read as "no book" instead of "book
        // unreadable".
        out.push({
          tag: r.tag,
          symbol: r.symbol,
          mode,
          legs: r.legs,
          greeks: {
            legs: [],
            netDelta: 0,
            netGamma: 0,
            netVega: 0,
            netTheta: 0,
            netVanna: 0,
            netVolga: 0,
            // `l.instrument` is not guaranteed here — a shape bad enough to
            // throw inside `positions()` is exactly what this branch exists
            // to survive, so the very thing that broke pricing must not also
            // break reporting it.
            unpriced: r.legs.map((l, i) => l.instrument?.tradingsymbol ?? `leg-${i}`),
            fallbackPriced: [],
          },
          spot: null,
          asOf: this.#d.clock.now(),
          complete: false,
          stale: true,
          marksAsOf: null,
          // Nothing was computed and nothing was read, so neither engine can
          // be claimed. `dashboard` with a null timestamp is the honest label
          // for a book that could not be marked at all.
          steering: null,
        })
      }
    }
    return out
  }

  /** Every book in a mode, with its net delta. The dashboard's index view. */
  async books(mode: DeskMode): Promise<readonly BookListing[]> {
    const stored = await this.#d.store.allBooks(mode)
    const out: BookListing[] = []
    for (const b of stored) {
      let netDelta: number | null = null
      let steeringDelta: number | null = null
      let neutralPct: number | null = null
      let complete = false
      /**
       * WHERE THE MARKS CAME FROM, carried onto the row.
       *
       * `positions()` already knows whether every mark came off a live tick or
       * off the persisted snapshot, and when the oldest of them was true — and
       * this listing used to compute that and drop it. The Books page was left
       * rendering a last-mark time with nothing to say it was Friday's close
       * rather than a tick.
       *
       * UNDEFINED WHEN THE BOOK COULD NOT BE READ AT ALL, never defaulted:
       * `stale: false` there would be a claim that the marks are live, made
       * about a book whose marks nobody could obtain.
       */
      let stale: boolean | undefined
      let marksAsOf: number | null | undefined
      try {
        const pos = await this.positions(b.tag, mode)
        complete = pos.complete
        stale = pos.stale
        marksAsOf = pos.marksAsOf
        /**
         * `complete` DECIDES THE NUMBER, not just a badge beside it.
         *
         * `positions()` does not throw for an unmarked leg — it drops the leg
         * and names it in `greeks.unpriced` — and `bookGreeks([])` returns
         * `netDelta: 0`. So a book whose feed is dead advertised `+0` next to
         * its tab, identical to a book that is genuinely flat, which on a delta
         * dashboard reads as "no action needed" while real risk is running.
         * `positions()` already documents that its totals are computed over a
         * SUBSET whenever this is false and must not be presented as
         * authoritative; a summary number is exactly such a presentation, so an
         * incomplete book reports its delta as UNKNOWN.
         */
        netDelta = pos.complete ? pos.greeks.netDelta : null
        /*
          AND WHAT THE STRATEGY STEERS BY, on the same completeness rule.

          The tab strip is the at-a-glance number, and it showed the whole
          book's delta while the tile and the Strategy panel one click away
          showed the shorts-only figure the rules act on — the same
          contradiction, one level up. `complete` gates it for the same reason
          it gates the book's: a summary IS a presentation of a total.
        */
        steeringDelta = pos.complete ? (pos.steering?.delta ?? null) : null
        /*
          HOW FAR THIS BOOK IS FROM DELTA-NEUTRAL, as a percentage of spot.

          The tab strip showed raw net delta, which is not comparable ACROSS
          books — +176 means something very different on BHEL at 426 than on
          TCS at 2355, and the strip's whole job is to be scanned across three
          of them at once. Distance to Δ0 is the same question in a unit that
          travels (operator's call 2026-08-14).

          `Δ0 = spot − netΔ/netΓ`, the same linear gamma-constant estimate the
          tile uses (`bookTotals` in the web's positions.ts), so the strip and
          the tile can never print different numbers for one book. A zero netΓ
          is left NULL rather than divided by: on this bridge that means "no
          leg priced", not "a gamma-flat book".
        */
        neutralPct =
          pos.complete && pos.spot !== null && pos.spot !== 0 && pos.greeks.netGamma !== 0
            ? ((pos.spot - pos.greeks.netDelta / pos.greeks.netGamma - pos.spot) / pos.spot) * 100
            : null
      } catch {
        // A book that could not be read at all still belongs in the list; its
        // delta is simply unknown, which the dashboard shows as such rather
        // than as zero.
        netDelta = null
        steeringDelta = null
        neutralPct = null
      }
      out.push({
        tag: b.tag,
        symbol: b.symbol,
        expiry: b.expiry,
        legs: b.legs.length,
        netDelta,
        ...(steeringDelta === null ? {} : { steeringDelta }),
        ...(neutralPct === null ? {} : { neutralPct }),
        complete,
        updatedAt: b.updatedAt,
        ...(stale === undefined ? {} : { stale }),
        ...(marksAsOf === undefined ? {} : { marksAsOf }),
      })
    }
    return out
  }
}

/**
 * One row of the books listing.
 *
 * Named rather than inlined because `routes/health.ts` derives its own type
 * from it and the web client mirrors it — three places that have to agree about
 * which fields may be absent.
 */
export interface BookListing {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly legs: number
  readonly netDelta: number | null
  /** What the strategy steers by, when that is not the whole book. */
  readonly steeringDelta?: number
  /**
   * Distance from delta-neutral as a PERCENTAGE OF SPOT — the tab strip's
   * figure, because a raw delta is not comparable across books at different
   * price levels. Absent when netΓ is zero (nothing priced) or spot is unknown.
   */
  readonly neutralPct?: number
  readonly complete: boolean
  readonly updatedAt: number
  /** True when any displayed mark is a persisted snapshot, not a live tick. */
  readonly stale?: boolean
  /** When the oldest displayed mark was true. Null when all of them are live. */
  readonly marksAsOf?: number | null
}
