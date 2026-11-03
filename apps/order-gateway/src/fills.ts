/**
 * The fill watcher: broker order updates -> `desk-fills`, the journal, and the
 * desk order's own state.
 *
 * THIS IS PRODUCTION LOGIC, deliberately not inlined into `main.ts`. It used to
 * be a closure inside the socket subscription, which made it untestable, and the
 * suite instead tested `aggregateTranches` — a function the running gateway
 * never called. The gateway therefore had a green test for a property it did not
 * have. Everything here is injected so the real path is the tested path.
 *
 * WHAT IT GETS RIGHT THAT THE CLOSURE DID NOT:
 *
 *  1. A SPLIT ORDER IS NOT TERMINAL UNTIL EVERY TRANCHE IS. 30 lots of NIFTY
 *     (lot 75, freeze 24 lots) becomes `X.1` (1800) and `X.2` (450). `X.1`
 *     FILLED marked `X` FILLED while 450 was still working; `X.2` FILLED then
 *     OVERWROTE the average with its own, so 1800@100 + 450@130 reported 130
 *     instead of 106 — Rs.54,000 out on one order. And an `X.2` REJECTED marked
 *     `X` REJECTED while 24 lots were live at the broker.
 *
 *  2. `desk-fills.tradingsymbol` IS A CONTRACT. It was being passed
 *     `update.clientOrderId`, so every row served to the portal named a
 *     correlation id in the symbol column and no broker fill could be joined to
 *     a contract.
 *
 * NEVER THROWS OUT. A rejection escaping here reaches an `void`-ed promise in a
 * socket handler, and Node 24 kills the process on an unhandled rejection — the
 * gateway would die on a Mongo blip mid-session.
 */

import type { PlacedOrder } from '@algomaker/brokers'
import {
  aggregateTranches,
  baseClientOrderId,
  decideOrderOutcome,
  decideTrancheStep,
  isMeaningfulUpdate,
  packedToExchangeToken,
  toFillRecord,
  trancheQtyThrough,
  type FillRecord,
  type TrancheAggregate,
  type TranchePlanEntry,
} from './gateway.ts'
import { orderMode, type OrderJournal } from './journal.ts'
import { TERMINAL_STATES, type OrderQueue } from './queue.ts'

/** Minimal Mongo surface for `desk-fills`. Same narrow-port reasoning as queue.ts. */
export interface FillsCollection {
  insertOne(doc: Record<string, unknown>): Promise<unknown>
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

export const FILLS_COLLECTION = 'desk-fills'

export interface FillWatcherDeps {
  readonly fills: FillsCollection
  readonly queue: Pick<
    OrderQueue,
    'get' | 'markTerminal' | 'getByBrokerOrderId' | 'advanceTranche' | 'markHalted'
  >
  readonly journal: Pick<OrderJournal, 'record'>
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /**
   * "There is work waiting" — called after a tranche advance re-arms a document.
   *
   * THE WATCHER NEVER PLACES ANYTHING, and this is what keeps that true. The
   * advance sets the document back to PENDING and this nudges the sweeper, so
   * tranche i+1 goes out through the SAME claim → gates → place path as tranche
   * 0. A second placement path here would be a second copy of the live-tag
   * gate, the kill switch, the staleness rule and the placement marker — and
   * the copy that stops refusing the day one of them changes.
   *
   * OPTIONAL, because a gateway wired without it is merely slower: the idle
   * sweep picks the document up on its next pass regardless. Losing a nudge
   * costs latency, never an order — the same guarantee the bus nudge has.
   */
  readonly wake?: () => void
}

/** What the desk order document tells us about the tranches it became. */
export interface OrderShape {
  readonly tradingsymbol: string
  /**
   * The exchange's token for the contract, unpacked from the document's
   * Zerodha-packed `instrument_token`; 0 when the document has none. The one
   * contract identity a broker row can be compared with — see `#fillsFor`.
   */
  readonly exchangeToken: number
  readonly tag: string
  readonly expectedQty: number
  readonly trancheIds: readonly string[]
  readonly failedTrancheIds: readonly string[]
  readonly brokerOrderIds: readonly string[]
  readonly state: string
  /**
   * When the order was routed (`createdAt`, written by desk-api at route time)
   * and when its placement was recorded (`placedAt`, written by `markPlaced`
   * after the tranche loop). 0 when the document carries none — legacy and
   * hand-written documents do not. Read by the adoption time guard in
   * `#fillsFor`, which anchors on `createdAt` because it always precedes the
   * fill, where `placedAt` can trail a fast fill by a few milliseconds.
   */
  readonly createdAt: number
  readonly placedAt: number
  /**
   * The desk leg this order acts on, and what it does to it. Carried purely so
   * the FILL can be stamped with them — see `toFillRecord`, which explains why
   * their absence made the Python desk's reconcile a no-op on the live rail.
   */
  readonly deskTag: string
  readonly deskOp: string
  /**
   * WHICH RAIL THIS ORDER IS ON, read off the document and stamped onto every
   * fill it produces.
   *
   * It used to be hard-coded `'live'` here, which was true while this process
   * only ever saw live orders. It no longer is: the engine endpoint's PAPER
   * orders are worked through this very queue (D14, `rail.ts`), and a paper
   * fill labelled live would be read by desk-api's live reconciler, shown on
   * the live tab, and — worst — booked against the live book by the Python
   * desk's own reconcile, which keys on this field.
   *
   * FAIL-CLOSED TO PAPER on the Delta desk (`orderMode`): only an exact
   * `mode: 'live'` document is live.
   */
  readonly mode: 'live' | 'paper'
  /** The slices this order is worked in. Empty for an ungated order. */
  readonly tranchePlan: readonly TranchePlanEntry[]
  /** Which slice is at the broker now. */
  readonly trancheCursor: number
}

export interface HandleOptions {
  /** The adapter the update came off, when the caller can say. See `handle`. */
  readonly rail?: 'live' | 'paper'
  /**
   * Refuse silently: `resolve` answers null without its own log line.
   *
   * For a caller that asks the same question on a schedule and announces the
   * answer itself. The broker sweep replays the whole XTS day book every 45 s
   * and asks `resolve` per row BEFORE its own once-per-id `reportedForeign`
   * guard, so every line `resolve` printed repeated per row per pass — each
   * same-day FILLED live order became a `NOT adopted` line every 45 s from
   * the moment it aged past the session window, for as long as the book
   * listed it. The verdict is unchanged; only who says it moves. `handle`
   * never passes this: a socket update is a one-off, and its refusal line is
   * the only record of why a raced row landed unattributed.
   */
  readonly quiet?: boolean
}

/** An update matched to its desk order. See `FillWatcher.resolve`. */
export interface Resolved {
  readonly base: string
  readonly order: OrderShape
  /** The update with its clientOrderId rewritten to the doc's tranche id. */
  readonly update: PlacedOrder
}

/**
 * How old a document may be and still be resolved by broker id.
 *
 * A SESSION, not a day. XTS AppOrderIDs recycle across sessions, not within
 * one, so the gate has to separate "this session" from "the last one" — and
 * the two are closer than a day: an NSE session runs 09:15–15:30 IST, which
 * puts a reused id 17.75–18.5 h after its previous owner (yesterday's 15:20
 * fill, today's 09:20 raced echo). The first cut of this gate was 24 h, and
 * that never fired on the one recycle that actually happens; yesterday's
 * FILLED document absorbed today's fill under yesterday's tag. Eight hours
 * clears the longest gap a same-session replay can have (09:15 → 15:30 is
 * 6.25 h) and sits well under the shortest overnight one; ANY document older
 * than this holding the id is the previous owner of a reused id, not the
 * order this update is for. A same-session terminal document is the ordinary
 * late replay of its own fill and must keep resolving.
 *
 * WHATEVER ITS STATE. The gate first covered terminal documents only, on the
 * reasoning that a working document holding the id is the order the fill is
 * for — but `getByBrokerOrderId` prefers a NON-terminal document among the
 * two newest, so a yesterday's PLACED left resting into the close, or an
 * AMBIGUOUS nobody resolved, holding a recycled id beat today's document in
 * the markPlaced race, took today's fill under yesterday's tag, and could be
 * pushed to FILLED by `reconcile` a session late. A day order cannot fill in
 * the next session; an update this long after the document's stamp is a
 * recycled id whatever the document says it is doing.
 *
 * EXCEPT A WORKING DOCUMENT STAMPED TODAY (`sameIstDay`). Widening the gate to
 * every state also refused a genuine same-session update that merely arrived
 * late: a live PLACED from 09:15 IST whose exchange close-cancel the 45 s
 * sweep first sees after 17:15 IST — the gateway down across the close and
 * restarted in the evening — was 8 h old, resolved to null, and stayed PLACED
 * where the terminal-only gate had let it settle. The window is a proxy for
 * "the previous session", and the IST date answers that question exactly:
 * ids recycle across sessions, never within one, so a non-terminal document
 * stamped on today's IST date is this session's order however many hours
 * have passed, and a previous-day document is refused however few (the
 * 15:20 → 09:20 case is 18 h AND yesterday). The exemption is deliberately
 * NOT extended to terminal documents: one of those has nothing left to
 * settle, its replay was already recorded under its base, and a refusal
 * costs it nothing — while a same-day PLACED refused at 17:20 is an order
 * the desk carries as working into tomorrow.
 */
const STALE_ADOPTION_MS = 8 * 60 * 60 * 1_000

/** UTC+05:30, no DST — the same constant `@algomaker/core`'s `istParts` uses. */
const IST_OFFSET_MS = 330 * 60_000

/**
 * Do two instants fall on the same IST calendar date? Pure arithmetic on the
 * offset, as `istParts` does it; no timezone database is consulted. Exported
 * for the gate's tests only.
 */
export function sameIstDay(aMs: number, bMs: number): boolean {
  const day = (ms: number): number => Math.floor((ms + IST_OFFSET_MS) / 86_400_000)
  return day(aMs) === day(bMs)
}

export class FillWatcher {
  readonly #d: FillWatcherDeps
  /** Last status seen per tranche, so an unchanged repeat is not re-persisted. */
  readonly #lastSeen = new Map<string, { status: string; filledQty: number }>()
  /**
   * clientOrderId -> contract, primed at placement.
   *
   * A cache, never the source of truth: after a restart it is empty and the
   * symbol comes from the broker update or the order document instead.
   */
  readonly #symbols = new Map<string, string>()

  constructor(deps: FillWatcherDeps) {
    this.#d = deps
  }

  async ensureIndexes(): Promise<void> {
    // The aggregation reads every tranche of one order; unindexed that is a
    // collection scan on the fill path, once per broker update.
    await this.#d.fills.createIndex({ baseClientOrderId: 1, ts: 1 })
    await this.#d.fills.createIndex({ clientOrderId: 1, ts: 1 })
  }

  /** Remember which contract a tranche is for, before any fill can arrive. */
  rememberSymbol(clientOrderId: string, tradingsymbol: string): void {
    if (tradingsymbol !== '') this.#symbols.set(clientOrderId, tradingsymbol)
  }

  /**
   * Handle one broker order update.
   *
   * `opts.rail` is WHICH ADAPTER EMITTED IT, when the caller knows: the live
   * broker's socket and book are `'live'`, the simulator's are `'paper'`, and
   * a caller that cannot say (simulate mode runs both rails on one simulator)
   * leaves it out. It scopes the broker-id fallback — a simulator id that
   * happens to equal a live AppOrderID must not resolve across rails — and it
   * is what an UNATTRIBUTED row is stamped with, instead of the fail-closed
   * `'live'` that used to label every paper raced row.
   *
   * Swallows its own errors: see the file header. The alternative is a dead
   * process, which loses every subsequent fill rather than one.
   */
  async handle(update: PlacedOrder, opts: HandleOptions = {}): Promise<void> {
    try {
      await this.#handle(update, opts)
    } catch (err) {
      this.#d.log('fill handling FAILED — the broker update is not recorded', {
        clientOrderId: update.clientOrderId,
        status: update.status,
        error: String(err),
      })
    }
  }

  async #handle(raw: PlacedOrder, opts: HandleOptions): Promise<void> {
    const resolved = await this.resolve(raw, opts)
    // Unresolved: recorded under the echoed id as it came, attributed to
    // nothing. `reconcile` says so below, and the post-placement reconcile
    // can still recover it by broker id once the doc carries one.
    const update = resolved?.update ?? raw
    const base = resolved?.base ?? baseClientOrderId(raw.clientOrderId)
    const order = resolved?.order ?? null
    // The ORDER's rail when one is found; the EMITTING rail when the caller
    // named it; paper when neither can say — see `OrderShape.mode` on why that
    // is the safe direction to fail in on the Delta desk.
    const mode: 'live' | 'paper' = order?.mode ?? opts.rail ?? 'paper'

    /**
     * DEDUP AFTER RESOLUTION, ON THE RESOLVED IDS — so the key CHANGES when
     * the attribution does.
     *
     * The echoed clientOrderId is the wire correlation id, `tag|id` capped at
     * 45 chars — a long tag leaves every leg of one book echoing the SAME
     * truncated id, and keying the dedup on it alone would swallow three of
     * four entry fills as "repeats". The AppOrderID disambiguates them, and
     * keeping the clientOrderId in the key only ever dedups LESS.
     *
     * It used to key on the RAW pair, before resolution. A row that lands
     * before `markPlaced` (the socket is faster than the write) resolves to
     * nothing and is recorded under the wire id; when the 45 s broker-book
     * sweep replays the same raw row, the doc now carries the AppOrderID and
     * the row resolves to the real tranche — but the raw key had already been
     * seen, and the replay was swallowed for the life of the process (F2).
     * The post-placement `reconcile` recovers those rows by broker id, so the
     * order still settled; what was lost was the attributed row itself, which
     * is what the tag-filtered order log and `/v1/desk/trades?tag=` read.
     *
     * The cost: `queue.get` and `getByBrokerOrderId` now run BEFORE the dedup
     * on every replayed row — one indexed point read each, roughly once per
     * 45 s per live book row. Writing the truncated row AND the re-attributed
     * one does not double-count: `aggregateTranches` keeps the greatest
     * `filledQty` per tranche key, and the two sit under different keys until
     * `#fillsFor` rewrites the truncated one onto the same tranche, where the
     * max makes them one.
     */
    const seenKey = `${raw.brokerOrderId}|${update.clientOrderId}`
    const prev = this.#lastSeen.get(seenKey)
    const next = { status: raw.status, filledQty: raw.filledQty }
    // Suppress only exact repeats. Partial fills MUST pass — a partly filled
    // wing on a thin chain otherwise looks like nothing happened, forever.
    if (!isMeaningfulUpdate(prev, next)) return
    this.#lastSeen.set(seenKey, next)

    const rec = toFillRecord(update, this.#symbolOf(update, order), this.#d.now(), {
      tag: order?.tag ?? '',
      mode,
      deskTag: order?.deskTag ?? '',
      deskOp: order?.deskOp ?? '',
    })
    await this.#d.fills.insertOne({ ...rec })

    await this.#d.journal.record({
      clientOrderId: update.clientOrderId,
      phase: 'STATUS',
      ok: update.status !== 'REJECTED',
      tag: order?.tag ?? '',
      tradingsymbol: rec.tradingsymbol,
      ts: this.#d.now(),
      // The same rail the fill above is stamped with.
      mode,
      status: update.status,
      filledQty: update.filledQty,
      avgPrice: update.avgPrice,
      ...(update.rejectReason === undefined ? {} : { error: update.rejectReason }),
    })
    this.#d.log(
      `STATUS ${rec.tradingsymbol} [${update.clientOrderId}] status=${update.status} ` +
        `filled=${update.filledQty}${update.avgPrice === null ? '' : ` @${update.avgPrice}`}`,
    )

    await this.reconcile(base, order)
  }

  /**
   * Which desk order this update is for, and under which tranche id.
   *
   * The direct lookup first, then by the AppOrderID `markPlaced` stored on
   * the doc — which survives any truncation of the echoed correlation id. The
   * update's clientOrderId is rewritten to the doc's true tranche id so fills
   * aggregate under the id the rest of the desk uses.
   *
   * THE BROKER-ID FALLBACK CAN NAME THE WRONG ORDER, and two refusals keep it
   * from doing so (F3). A broker order id is not unique across sessions: when
   * the only document holding one is from the previous session
   * (`STALE_ADOPTION_MS`) — terminal or not — it is a recycled id and the
   * update is for an order this desk has not written the id onto yet —
   * recorded unattributed, and recovered by the post-placement reconcile,
   * never landed on the old document under ITS tag. The two rails share one watcher: an
   * update the caller says came off the simulator must not resolve to a live
   * document by an id the simulator reused. And the update's own contract is
   * judged (`contractMismatch`): an id that resolves to a document on another
   * exchange token is recycled whatever that document's state or age.
   *
   * A terminal document that is RECENT still resolves: that is the ordinary
   * case of the sweep replaying a fill the order already settled on, and
   * `reconcile` stops on the terminal state.
   *
   * PUBLIC for the broker sweep, which asks this before `handle` so a
   * correlated row it cannot attribute is counted foreign rather than written
   * as an untagged fill on every pass — and asks it `quiet`, because the
   * sweep names a refused id once itself (`HandleOptions.quiet`). `handle`
   * itself still records an unresolved row: on the socket path it may be a
   * raced fill of an order whose broker id is about to be written.
   *
   * RESOLUTION ORDER: direct id → broker id. A wire-token step between the
   * two — a deterministic 12-char token in the correlation id, stored on the
   * doc BEFORE the first tranche goes out — is the planned follow-up (brief
   * Task 8), deferred from this change. It matters because `tag|id` is capped
   * at 45 chars on the wire and a tag of 44+ chars (e.g.
   * `BANKNIFTY-delta-lean-conservative-2026-09-22`) leaves the separator and
   * the id unparseable, so `parseCorrelationId` yields null and the XTS
   * adapter DROPS the socket echo entirely — those orders are then seen only
   * through the 45 s book sweep. For orders whose echo does arrive, the
   * broker-id path with the contract, time, tag and rail guards above and in
   * `#fillsFor` is what keeps an in-flight order's fills attributed.
   */
  async resolve(raw: PlacedOrder, opts: HandleOptions = {}): Promise<Resolved | null> {
    const direct = baseClientOrderId(raw.clientOrderId)
    const byId = await this.#loadOrder(direct)
    if (byId !== null) return { base: direct, order: byId, update: raw }
    if (raw.brokerOrderId === '') return null

    const doc = await this.#d.queue.getByBrokerOrderId(raw.brokerOrderId)
    if (doc === null) return null
    const base = String(doc['clientOrderId'] ?? '')
    const order = this.#shapeOf(doc)

    // Silent on request, never silent by default — see `HandleOptions.quiet`.
    const log = opts.quiet === true ? (): void => {} : this.#d.log

    const stamp = order.placedAt > 0 ? order.placedAt : order.createdAt
    const nowMs = this.#d.now()
    const age = nowMs - stamp
    // Terminal OR NOT — see `STALE_ADOPTION_MS` on why the state does not
    // exempt a document from the session window, and why a WORKING document
    // stamped on today's IST date does stand outside it (an evening restart
    // replaying the close-cancel of a morning order is this session's, not a
    // recycled id). The state is named in the line so a stale PLACED (an
    // order left resting into the close) reads as what it is rather than as
    // a settled order.
    const thisSessionWorking = !TERMINAL_STATES.has(order.state) && sameIstDay(stamp, nowMs)
    if (stamp > 0 && age > STALE_ADOPTION_MS && !thisSessionWorking) {
      log(
        `broker order id ${raw.brokerOrderId} matches only a ${order.state} order from ` +
          `${new Date(stamp).toISOString()}, outside the session window — NOT adopted`,
        { base, state: order.state, tag: order.tag, clientOrderId: raw.clientOrderId },
      )
      return null
    }
    if (opts.rail !== undefined && order.mode !== opts.rail) {
      log(
        `broker order id ${raw.brokerOrderId} matches only a ${order.mode} order — ` +
          `rail mismatch, NOT adopted`,
        { base, rail: opts.rail, tag: order.tag, clientOrderId: raw.clientOrderId },
      )
      return null
    }

    // The UPDATE's own contract, judged the way `#fillsFor` judges a stored
    // row. A row written under the resolved base is never re-judged — it names
    // this order in `baseClientOrderId` and is taken as it stands — so a
    // recycled id on another contract that got past the two gates above (a
    // document of either state inside the session window that still holds
    // the id) would be booked for good. The broker's token on the
    // update against the document's is cheap, and no evidence still passes.
    const why = contractMismatch(order, {
      exchangeToken: raw.exchangeToken ?? 0,
      tradingsymbol: raw.tradingsymbol ?? '',
    })
    if (why !== null) {
      log('IGNORED a fill row whose broker order id belongs to another contract', {
        base,
        brokerOrderId: raw.brokerOrderId,
        reason: why,
        expected: order.tradingsymbol,
        found: raw.tradingsymbol ?? '',
        expectedToken: order.exchangeToken,
        foundToken: raw.exchangeToken ?? 0,
        tag: order.tag,
        clientOrderId: raw.clientOrderId,
      })
      return null
    }

    const i = order.brokerOrderIds.indexOf(raw.brokerOrderId)
    const trancheId = (i >= 0 ? order.trancheIds[i] : undefined) ?? order.trancheIds[0] ?? base
    return { base, order, update: { ...raw, clientOrderId: trancheId } }
  }

  /**
   * Re-derive the desk order's state from ALL of its tranches.
   *
   * Also called after placement, because a fill can land before `markPlaced`
   * has written the tranche list — in which case the aggregation at fill time
   * could not decide and this is what resolves the order instead of leaving it
   * PLACED forever.
   */
  async reconcile(base: string, preloaded?: OrderShape | null): Promise<void> {
    const order = preloaded === undefined ? await this.#loadOrder(base) : preloaded
    if (order === null) {
      // A fill for an order this gateway has no record of: a manual order on the
      // same account, or one placed before a wipe. Recorded, never adopted.
      this.#d.log('fill for an unknown desk order — recorded but not attributed', { base })
      return
    }
    if (order.expectedQty <= 0) {
      this.#d.log('order has no expected quantity — cannot decide completion', { base })
      return
    }
    if (TERMINAL_STATES.has(order.state)) return

    const fills = await this.#fillsFor(base, order)
    const agg = aggregateTranches(fills, order.expectedQty, {
      ids: order.trancheIds.length > 0 ? order.trancheIds : [base],
      failed: order.failedTrancheIds,
    })

    /**
     * A GATED ORDER MAY HAVE MORE TO PLACE, and that has to be asked BEFORE the
     * terminal decision — because to `decideOrderOutcome` a finished first
     * slice looks exactly like an order that stopped short: every tranche it
     * knows about is terminal and less than the whole quantity has filled, i.e.
     * PARTIAL. Marking a nine-lot order PARTIAL at three lots would end it, and
     * the six lots the desk decided on would never be placed at all.
     *
     * `settle` falls through to the unchanged decision below, and an UNGATED
     * order is always `settle` — one cheap question and then the code that has
     * always run.
     *
     * `working` RETURNS RIGHT HERE, and that is not the same as falling
     * through. A gated order between the claim and `markPlaced` has the tranche
     * in flight missing from `trancheIds`, so the aggregate says "every tranche
     * I know of is terminal, and less than the whole quantity has filled" —
     * which `decideOrderOutcome` reads as PARTIAL. It would end a nine-lot
     * order at three lots, at the exact moment tranche 2 was being placed.
     */
    const step = decideTrancheStep({
      plan: order.tranchePlan,
      cursor: order.trancheCursor,
      state: order.state,
      // The exposure signal decides which way a SHORT tranche fails: an open
      // halts, an exit carries on. See `decideTrancheStep` rule 3.
      deskOp: order.deskOp,
      agg,
    })
    if (step.kind === 'halt') {
      await this.#halt(base, order, step.reason, agg)
      return
    }
    if (step.kind === 'advance') {
      await this.#advance(base, order, step.from, agg, step.shortfall)
      return
    }
    if (step.kind === 'working') {
      this.#d.log('gated order still working', {
        base,
        tranche: `${order.trancheCursor + 1}/${order.tranchePlan.length}`,
        state: order.state,
        filledQty: agg.filledQty,
        expectedQty: order.expectedQty,
        working: agg.working,
      })
      return
    }

    const outcome = decideOrderOutcome(agg, order.expectedQty)
    if (outcome === null) {
      this.#d.log('order still working', {
        base,
        filledQty: agg.filledQty,
        expectedQty: order.expectedQty,
        working: agg.working,
      })
      return
    }

    await this.#d.queue.markTerminal(base, outcome.state, {
      filledQty: outcome.filledQty,
      avgPrice: outcome.avgPrice,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      // The order's fee total, on the document the desk folds from
      // (`apps/api/src/paper-fold.ts:foldedFee`). Absent when nothing said.
      ...(outcome.fee === undefined ? {} : { fee: outcome.fee }),
    })
    this.#d.log(`${outcome.state} ${order.tradingsymbol} [${base}]`, {
      filledQty: outcome.filledQty,
      expectedQty: order.expectedQty,
      avgPrice: outcome.avgPrice,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    })
    await this.#d.journal.record({
      clientOrderId: base,
      phase: 'STATUS',
      ok: outcome.state === 'FILLED',
      tag: order.tag,
      tradingsymbol: order.tradingsymbol,
      ts: this.#d.now(),
      mode: order.mode,
      status: outcome.state,
      filledQty: outcome.filledQty,
      avgPrice: outcome.avgPrice,
      ...(outcome.reason === undefined ? {} : { error: outcome.reason }),
      detail: { expectedQty: order.expectedQty, tranches: agg.working.length + order.trancheIds.length },
    })
  }

  /**
   * Release the next tranche — or find out that somebody else already did.
   *
   * The CAS is `advanceTranche`'s; all this adds is that a LOST race is a
   * no-op and a logged line, never a fall-through to the terminal decision.
   * Falling through would be the F-10 defect wearing a different hat: the
   * loser's aggregate says "every tranche is terminal and the order is not
   * complete", which `decideOrderOutcome` reads as PARTIAL — and it would end
   * an order the winner has just placed the next tranche of.
   */
  async #advance(
    base: string,
    order: OrderShape,
    from: number,
    agg: TrancheAggregate,
    shortfall: number,
  ): Promise<void> {
    const total = order.tranchePlan.length
    const won = await this.#d.queue.advanceTranche(base, from)
    if (!won) {
      this.#d.log('tranche advance lost the race — another watcher already moved this cursor', {
        base,
        from,
      })
      return
    }
    /**
     * A SHORT EXIT IS STILL AN ADVANCE, and it is still news.
     *
     * `decideTrancheStep` carries on through a shortfall for a close, because
     * abandoning the rest of an exit is the worse error — but "carried on" and
     * "filled" are different facts, and the line that reports them must not say
     * the second when it means the first. So the shortfall makes this loud
     * (`ok: false`, into the failures feed) while the sequence continues.
     */
    const short = shortfall > 0
    const note = short
      ? `tranche ${from + 1}/${total} came back ${shortfall} SHORT — this order reduces ` +
        `exposure, so tranche ${from + 2}/${total} still goes out; nothing else would send ` +
        `the rest of this exit`
      : `tranche ${from + 1}/${total} filled; tranche ${from + 2}/${total} released`
    this.#d.log(
      `TRANCHE ${from + 1}/${total} ${short ? 'SHORT' : 'DONE'} ${order.tradingsymbol} [${base}] — ` +
        `releasing tranche ${from + 2}/${total}`,
      { filledQty: agg.filledQty, expectedQty: order.expectedQty, shortfall },
    )
    await this.#d.journal.record({
      clientOrderId: base,
      phase: 'PLANNED',
      // Progress, not an incident: the failures feed stays for things that need
      // a human — unless a tranche came back short, which does.
      ok: !short,
      tag: order.tag,
      tradingsymbol: order.tradingsymbol,
      ts: this.#d.now(),
      mode: order.mode,
      filledQty: agg.filledQty,
      ...(short ? { error: note, errorClass: 'fatal' } : {}),
      detail: {
        note,
        trancheCursor: from + 1,
        tranches: total,
        expectedQty: order.expectedQty,
        ...(short ? { shortfall } : {}),
      },
    })
    /**
     * The nudge is LAST, after the document is re-armed and the record written.
     * Nudging first would let the sweeper claim a document whose cursor has not
     * moved yet and re-place the tranche that just filled.
     */
    try {
      this.#d.wake?.()
    } catch (err) {
      // A sweep that could not be woken costs one idle interval, and this whole
      // class exists on the promise that it never throws out.
      this.#d.log('tranche advance could not nudge the sweeper', { base, error: String(err) })
    }
  }

  /**
   * Stop a gated order and say so where somebody will see it (D11).
   *
   * THE JOURNAL LINE IS THE POINT. The document's state is read by machines;
   * `ok: false` is what puts this in the dashboard's failures feed, which is
   * the only place a human finds out that a decision the desk made was only
   * two-thirds executed — while the position it did open is real and marked.
   *
   * NOTHING IS CANCELLED HERE. A slice can be more than one broker order (the
   * freeze split still applies inside a tranche), so one refused order can
   * leave a sibling working; cancelling it would be this process deciding to
   * flatten part of a live position on its own initiative. It halts, it
   * reports, and it leaves the book to whoever reads the alert.
   *
   * THE JOURNAL LINE IS WRITTEN FIRST, and the order of the two is part of the
   * contract — the same ordering `refuse()` states and for the same reason: a
   * crash in between leaves a halt that is EXPLAINED but not yet terminal, and
   * the next reconcile reaches the same conclusion and halts again, which is
   * idempotent. Marking first and crashing would leave an order stopped dead
   * with nothing anywhere saying why.
   */
  async #halt(
    base: string,
    order: OrderShape,
    reason: string,
    agg: TrancheAggregate,
  ): Promise<void> {
    const due = trancheQtyThrough(order.tranchePlan, order.trancheCursor)
    await this.#d.journal.record({
      clientOrderId: base,
      phase: 'FAILED',
      ok: false,
      tag: order.tag,
      tradingsymbol: order.tradingsymbol,
      ts: this.#d.now(),
      mode: order.mode,
      status: 'HALTED',
      filledQty: agg.filledQty,
      avgPrice: agg.avgPrice,
      error: `HALTED: ${reason}`,
      errorClass: 'fatal',
      detail: {
        trancheCursor: order.trancheCursor,
        tranches: order.tranchePlan.length,
        expectedQty: order.expectedQty,
        dueSoFar: due,
      },
    })
    /**
     * WHAT ACTUALLY TRADED GOES ON THE DOCUMENT. `service.ts:#actualEntries`
     * prices legs off `filledQty`/`avgPrice` and skips a document without them,
     * and `reconcile-live.ts` folds the shortfall back off the same two fields.
     * A halt that recorded only its reason would leave a leg that really traded
     * marked at the seed price — the 2026-08-04 MTM error.
     */
    const halted = await this.#d.queue.markHalted(
      base,
      { filledQty: agg.filledQty, avgPrice: agg.avgPrice, reason },
      { state: 'PLACED', trancheCursor: order.trancheCursor },
    )
    this.#d.log(`HALTED ${order.tradingsymbol} [${base}]: ${reason}`, {
      filledQty: agg.filledQty,
      dueSoFar: due,
      expectedQty: order.expectedQty,
      written: halted,
    })
  }

  /**
   * WHAT THIS DESK ORDER HAS ACTUALLY TRADED SO FAR — the same aggregate the
   * halt above records, exposed for the one caller outside this class that
   * needs it.
   *
   * The PLACER halts too: a kill switch thrown between tranches stops the
   * slices that have not gone out. It has no fills of its own to aggregate, and
   * a halt that wrote no quantity would leave a two-thirds-filled order's legs
   * at the seed price — the very hole `#halt` carries `filledQty` to close. One
   * reader, one answer.
   *
   * NEVER THROWS: it is called on the placement path, where a rejection would
   * turn a refusal into an INVALID document. An unreadable aggregate answers
   * "nothing known" and the caller omits the fields rather than stamping a
   * false zero over them.
   */
  async filledSoFar(base: string): Promise<{ filledQty: number; avgPrice: number | null }> {
    try {
      const order = await this.#loadOrder(base)
      if (order === null) return { filledQty: 0, avgPrice: null }
      const fills = await this.#fillsFor(base, order)
      const agg = aggregateTranches(fills, order.expectedQty, {
        ids: order.trancheIds.length > 0 ? order.trancheIds : [base],
        failed: order.failedTrancheIds,
      })
      return { filledQty: agg.filledQty, avgPrice: agg.avgPrice }
    } catch (err) {
      this.#d.log('could not read what an order has filled so far', { base, error: String(err) })
      return { filledQty: 0, avgPrice: null }
    }
  }

  /**
   * The contract this update is for.
   *
   * The broker's own symbol first — it is what actually traded. Then the cache,
   * then the desk order. NEVER the clientOrderId: that is what put correlation
   * ids in the symbol column of every fill row the portal shows.
   */
  #symbolOf(update: PlacedOrder, order: OrderShape | null): string {
    const fromBroker = (update.tradingsymbol ?? '').trim()
    if (fromBroker !== '') return fromBroker
    return this.#symbols.get(update.clientOrderId) ?? order?.tradingsymbol ?? ''
  }

  async #loadOrder(base: string): Promise<OrderShape | null> {
    const doc = await this.#d.queue.get(base)
    return doc === null ? null : this.#shapeOf(doc)
  }

  #shapeOf(doc: Record<string, unknown>): OrderShape {
    return {
      tradingsymbol: String(doc['tradingsymbol'] ?? ''),
      exchangeToken: packedToExchangeToken(doc['instrument_token']),
      tag: String(doc['tag'] ?? ''),
      expectedQty: Number(doc['expectedQty'] ?? doc['quantity'] ?? 0),
      trancheIds: asStrings(doc['trancheIds']),
      failedTrancheIds: asStrings(doc['failedTrancheIds']),
      brokerOrderIds: asStrings(doc['brokerOrderIds']),
      state: String(doc['state'] ?? ''),
      createdAt: Number(doc['createdAt'] ?? 0) || 0,
      placedAt: Number(doc['placedAt'] ?? 0) || 0,
      deskTag: String(doc['desk_tag'] ?? ''),
      deskOp: String(doc['desk_op'] ?? ''),
      // Only an EXACT `'live'` is live on the Delta desk — `orderMode` is that
      // rule, and it is asked rather than re-spelled here.
      mode: orderMode(doc),
      tranchePlan: asPlan(doc['tranchePlan']),
      // A garbled cursor reads as 0, never NaN: `NaN >= plan.length - 1` is
      // false, so a NaN would make every step an advance from nowhere.
      trancheCursor: Number.isInteger(Number(doc['trancheCursor']))
        ? Number(doc['trancheCursor'])
        : 0,
    }
  }

  /**
   * Every fill belonging to `base` — by its own id, AND by the broker ids the
   * ACK stored. The second arm recovers fills that raced markPlaced: they were
   * recorded under the TRUNCATED wire id (no doc to resolve against yet), so
   * the direct query can never see them, and the order sat PLACED forever
   * while the broker held it filled. Their ids are rewritten to the true
   * tranche id here so the aggregation credits them.
   */
  /**
   * A row found by BROKER ID must also be for THIS ORDER'S CONTRACT.
   *
   * `desk-fills` outlives the process; a broker order id does not have to.
   * The paper simulator numbered from `sim-1` on every construction, so a
   * restart reissued ids the collection still held rows for — and adopting by
   * id alone then credited one order with another's trade.
   *
   * THE TRACE (2026-09-16). `sim-5` was TATASTEEL26SEP182.5PE filled 2750
   * @1.72 on Sep 8 and SENSEX2691778000CE filled 60 @2.05 on Sep 16. The
   * SENSEX order aggregated both and booked 2750 @1.72 — another contract's
   * quantity, at another contract's price. Its successor then read 1350 of
   * 2060 filled, believed 710 shares outstanding, and emitted a cut for 710:
   * not a multiple of the 20-share lot, refused INVALID every 6s for 45
   * minutes while the book could make no progress.
   *
   * THE CONTRACT IS THE SCOPE because it is the one thing a recycled id cannot
   * carry over. Unique ids (see `SimulatorAdapter`) stop the collision being
   * created; this stops one that exists anyway — a live broker recycling ids,
   * or the rows already written — from being believed.
   *
   * THE EXCHANGE TOKEN NAMES THE CONTRACT, NEVER THE SYMBOL STRING. The first
   * version of this guard compared `tradingsymbol` on the row with the one on
   * the document, and on the live rail that is not a guard but a rule that
   * refuses every row: the document carries the instrument master's spelling
   * (`NIFTY2692223150PE`) and every XTS row carries the broker's (`NIFTY
   * 22SEP2026 PE 23150`, which `#symbolOf` prefers). Mongo, 2026-09: 793 live
   * fill rows spelled the broker's way, 0 the master's. The rows this arm
   * exists to recover — a fill that raced `markPlaced` and sits under the
   * truncated wire id — were therefore refused on live, one and all, and the
   * order sat PLACED while the broker held it filled (the real TCS 1240030151
   * rows of 2026-08-04 replay exactly so). Both sides DO agree on the
   * exchange's integer: XTS `ExchangeInstrumentID` on the row, the unpacked
   * `instrument_token` on the document — see `contractMismatch`.
   *
   * THE CONTRACT DOES NOT SEPARATE TWO BOOKS ON THE SAME CONTRACT. NIFTY
   * aggressive and NIFTY conservative both trade the ATM weekly strike, so a
   * sibling book's row under a recycled broker id passes the token guard on
   * merit. `adoptionMismatch` adds what the contract cannot: the row must be
   * no older than the order (a live broker recycling AppOrderIDs across days
   * puts a two-day-old fill under an id this order now holds), and a row that
   * carries a tag must carry THIS order's, on this order's rail.
   *
   * ONLY AN ADOPTED ROW IS JUDGED. A row that names this base in
   * `baseClientOrderId` was written FOR this order and is taken as it stands;
   * missing evidence on either side is not evidence of a mismatch, so it
   * passes. Refusal is LOUD: a silently dropped fill is the same class of bug
   * pointing the other way.
   */
  async #fillsFor(base: string, order?: OrderShape): Promise<FillRecord[]> {
    const brokerIds = order?.brokerOrderIds ?? []
    const filter =
      brokerIds.length === 0
        ? { baseClientOrderId: base }
        : { $or: [{ baseClientOrderId: base }, { brokerOrderId: { $in: [...brokerIds] } }] }
    const rows = await this.#d.fills.find(filter).toArray()
    const kept: Record<string, unknown>[] = []
    for (const row of rows) {
      if (String(row['baseClientOrderId'] ?? '') === base) {
        kept.push(row)
        continue
      }
      const bid = String(row['brokerOrderId'] ?? '')
      const i = brokerIds.indexOf(bid)
      if (i < 0) continue
      const mismatch =
        order === undefined ? null : (contractMismatch(order, row) ?? adoptionMismatch(order, row))
      if (mismatch !== null) {
        this.#d.log('IGNORED a fill row whose broker order id belongs to another contract', {
          base,
          brokerOrderId: bid,
          reason: mismatch,
          expected: order?.tradingsymbol ?? '',
          found: String(row['tradingsymbol'] ?? ''),
          expectedToken: order?.exchangeToken ?? 0,
          foundToken: Number(row['exchangeToken'] ?? 0),
          expectedTag: order?.tag ?? '',
          foundTag: String(row['tag'] ?? ''),
          rowTs: Number(row['ts'] ?? 0),
          orderCreatedAt: order?.createdAt ?? 0,
          filledQty: Number(row['filledQty'] ?? 0),
          owner: String(row['baseClientOrderId'] ?? ''),
        })
        continue
      }
      kept.push({ ...row, clientOrderId: order?.trancheIds[i] ?? base, baseClientOrderId: base })
    }
    return kept.map((r) => ({
      clientOrderId: String(r['clientOrderId'] ?? ''),
      baseClientOrderId: String(r['baseClientOrderId'] ?? ''),
      brokerOrderId: String(r['brokerOrderId'] ?? ''),
      tradingsymbol: String(r['tradingsymbol'] ?? ''),
      status: String(r['status'] ?? ''),
      filledQty: Number(r['filledQty'] ?? 0),
      avgPrice: r['avgPrice'] === null || r['avgPrice'] === undefined ? null : Number(r['avgPrice']),
      ...(r['rejectReason'] === undefined ? {} : { rejectReason: String(r['rejectReason']) }),
      ts: Number(r['ts'] ?? 0),
      tag: String(r['tag'] ?? ''),
      // The stored row's own rail, through the same one rule. Nothing in the
      // aggregation reads it, but a record that lied about its mode in one
      // reader and told the truth in another is a difference somebody would
      // eventually act on.
      mode: orderMode(r),
    }))
  }
}

/**
 * Is this fill row, found by broker id, for a DIFFERENT contract than the
 * order? A reason when it is, null when it is not — or when nothing on the
 * row can say.
 *
 * 1. THE TOKEN IS THE VERDICT when both sides carry one. XTS reports
 *    `ExchangeInstrumentID` on every order-book row, the document carries the
 *    master's packed token, and `packedToExchangeToken` makes them the same
 *    integer. Two known tokens that differ are two contracts; two that agree
 *    are one, whatever the symbols say — no fall-through to the strings.
 * 2. THE SYMBOLS ARE COMPARED ONLY WHEN THEY SPEAK THE SAME LANGUAGE. XTS puts
 *    spaces in its spelling and the instrument master never does, so a
 *    spaced symbol beside an unspaced one is not two contracts, it is one
 *    contract in two vocabularies, and comparing them would refuse every live
 *    row (the defect this replaces). Same vocabulary and different text IS a
 *    mismatch: this is what keeps the TATASTEEL-under-a-SENSEX-id paper case
 *    refusing, where both rows are master-spelled and carry no token.
 * 3. NO EVIDENCE PASSES. A v2 `trade` event carries neither symbol nor token,
 *    and a legacy document carries no `instrument_token`; the time and tag
 *    guards on the same adoption are what stand between such a row and a
 *    wrong order, not a mismatch invented from a blank.
 */
function contractMismatch(order: OrderShape, row: Record<string, unknown>): string | null {
  const rowToken = Number(row['exchangeToken'] ?? 0)
  if (rowToken > 0 && order.exchangeToken > 0) {
    return rowToken === order.exchangeToken ? null : 'exchange token differs'
  }
  const rowSymbol = String(row['tradingsymbol'] ?? '')
  const wantSymbol = order.tradingsymbol
  if (rowSymbol !== '' && wantSymbol !== '' && sameVocabulary(rowSymbol, wantSymbol)) {
    return rowSymbol === wantSymbol ? null : 'symbol differs'
  }
  return null
}

/**
 * How much earlier than the order's `createdAt` a row may be stamped and still
 * be this order's. Generous: a raced row's `ts` trails `createdAt` by the
 * whole route-claim-place path, and desk-api's clock and the gateway's are
 * the same box — the skew absorbs a clock step, not a different day.
 */
const ADOPTION_SKEW_MS = 60_000

/**
 * Is this fill row, found by broker id and on this order's contract, still not
 * THIS ORDER's? A reason when it is not, null when nothing on the row says so.
 *
 * TIME. A row stamped before the order existed cannot be its fill. The anchor
 * is `createdAt` — desk-api writes it at route time (`rail.ts
 * gatewayOrderDocument`), so it always precedes the fill; `placedAt` is the
 * fallback only, because `markPlaced` writes it after the tranche loop and the
 * real raced rows (TCS 1240030151: `ts` …234102-121 against `placedAt`
 * …234107) sit up to 5 ms BEFORE it. A missing timestamp on either side
 * PASSES: legacy documents carry none (`isStaleOrder` states the same rule),
 * and `NaN` comparisons refuse everything.
 *
 * TAG. `''` IS NOT EVIDENCE. Every raced row is written with `tag: ''` — no
 * document was resolvable when it landed — and those are exactly the rows this
 * adoption exists to recover. A row that DOES carry a tag was attributed when
 * written, and if it names another book it is that book's fill, whatever id it
 * sits under now.
 *
 * MODE, only on a tagged row, for the same reason: an unattributed row is
 * stamped with the EMITTING rail when the caller named it, and `'live'`
 * fail-closed otherwise (`#handle`) — either way it is the rail of the socket,
 * not of the order, so its mode says nothing about the order it belongs to. A
 * tagged row's mode was read off its own document, and a live row under a
 * paper order's id — or the reverse — is not that order's.
 */
function adoptionMismatch(order: OrderShape, row: Record<string, unknown>): string | null {
  const anchor = order.createdAt > 0 ? order.createdAt : order.placedAt
  const rowTs = Number(row['ts'] ?? 0)
  if (anchor > 0 && rowTs > 0 && rowTs < anchor - ADOPTION_SKEW_MS) {
    return 'row predates the order'
  }
  const rowTag = String(row['tag'] ?? '')
  if (rowTag !== '') {
    if (rowTag !== order.tag) return 'tag names another book'
    if (orderMode(row) !== order.mode) return 'rail differs'
  }
  return null
}

/**
 * Do two symbols use the same spelling convention, so that comparing them
 * means anything? The only string surgery the guard allows, and it decides
 * whether a comparison is MEANINGFUL, never whether two symbols match: XTS's
 * spelling has spaces (`NIFTY 22SEP2026 PE 23150`), the master's has none.
 */
function sameVocabulary(a: string, b: string): boolean {
  return a.includes(' ') === b.includes(' ')
}

function asStrings(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

/**
 * The stored tranche plan, read defensively.
 *
 * ONE UNUSABLE ROW DISCARDS THE WHOLE PLAN, rather than being skipped or read
 * as zero. Both alternatives are worse: a zero-qty slice satisfies "filled in
 * full" instantly and advances the cursor onto a tranche nobody placed, and
 * dropping a row shifts every index after it — so the cursor would name a
 * different slice than the one it was set against. An empty plan simply means
 * "not gated": the order settles on what it has and NOTHING further is placed,
 * which is the safe direction to fail in.
 */
function asPlan(v: unknown): readonly TranchePlanEntry[] {
  if (!Array.isArray(v) || v.length === 0) return []
  const out: TranchePlanEntry[] = []
  for (const row of v) {
    const qty = Number((row as { qty?: unknown } | null)?.qty ?? Number.NaN)
    if (!Number.isFinite(qty) || qty <= 0) return []
    out.push({ qty })
  }
  return out
}
