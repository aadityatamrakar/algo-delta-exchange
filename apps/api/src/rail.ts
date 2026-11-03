/**
 * Order rails: where a fill actually goes.
 *
 * Two rails, chosen by mode, and they are DIFFERENT COLLECTIONS rather than a
 * flag on one collection. `xtsOrder.js:314` opens a change stream on
 * `positional` and forwards every insert with a `tag` to a live XTS broker. If
 * paper and live shared a collection, the only thing standing between a
 * simulated order and real money would be a boolean read correctly by a daemon
 * nobody is looking at. Separate collections make it impossible by construction.
 *
 * This is the same reasoning that makes `ZerodhaDataAdapter.placeOrder` throw
 * rather than be "not called": the legacy system's defining defect was that
 * sim-vs-live depended on which daemon happened to be running.
 */

import type { InstrumentRef } from '@algomaker/order-bus'
import { ORDER_NUDGE_TOPIC, type NudgePayload } from '@algomaker/desk-engine'
import { signedQty, type DeskMode, type DeskSide, type Fill } from './contract.ts'
import { COLLECTIONS, type Database } from './store.ts'

/**
 * The websocket push, as the rail sees it: one call, no result, no promise.
 *
 * Structural on purpose — `DeskStream.publish` satisfies it — so this module
 * neither imports `ws` nor knows a socket exists. Synchronous and returning
 * `void` is the contract that matters: there is nothing here for the order path
 * to await, and therefore nothing for it to be delayed by.
 */
export type PaperFillEmit = (mode: DeskMode, event: Record<string, unknown>) => void

/**
 * The bus, as the rail sees it: one publish, no result, no promise.
 *
 * Structural for the same reason `PaperFillEmit` is — `WsTransportClient`
 * satisfies it without this module importing `@algomaker/bus` or knowing a
 * socket exists — and the signature is `Transport.publish`'s exactly, so the
 * wiring at a composition root is the bus handle it already holds.
 */
export interface OrderNudgeBus {
  publish(topic: string, payload: NudgePayload, ts: number): void
}

/**
 * "AN ORDER IS WAITING" — told to the gateway, AFTER it is true.
 *
 * `apps/order-gateway` subscribes to `ORDER_NUDGE_TOPIC` and sweeps its queue
 * the moment one lands. Nothing in the tree ever published it, so every desk
 * order — paper and live — sat in `desk-gateway-orders` until the 5s idle sweep
 * (`DESK_SWEEP_MS`) came round. Nothing FAILED, which is why it survived: the
 * idle sweep is a correct safety net, just a slow one, and a book that decides
 * on a seconds cadence cannot pay it.
 *
 * CALLED ONLY AFTER THE INSERT HAS RESOLVED, at every call site. A nudge that
 * overtakes its own document makes the gateway claim nothing, reset its idle
 * timer and sleep the full interval — strictly worse than not nudging at all.
 * That ordering is the property `apps/api/test/rail-nudge.test.ts` pins.
 *
 * ONLY FOR DOCUMENTS THE GATEWAY ACTUALLY READS. The book-keeping paper rail
 * (`desk-paper-trade`) and the retired `positional` executor are swept by
 * nobody, so waking the sweeper for them buys a pointless claim round and
 * resets the idle timer for the orders that ARE waiting.
 *
 * BEST EFFORT, AND IT CANNOT FAIL THE ORDER — same rule as the paper fill
 * emit above. The document is durable by this line; letting a transport error
 * propagate would report a routed order as a route FAILURE, and the caller's
 * recovery for that is to route it a second time.
 *
 * `ctx.nowMs` rather than `Date.now()` as the publish stamp: the caller's clock
 * is already the one every other field on this order was written with, and the
 * order path gains no new call into the platform clock.
 */
function nudgeGateway(bus: OrderNudgeBus | null, fill: Fill, ctx: RouteContext): void {
  if (bus === null) return
  const payload: NudgePayload = {
    clientOrderId: ctx.clientOrderId,
    tag: ctx.tag,
    tradingsymbol: fill.tradingsymbol,
  }
  try {
    bus.publish(ORDER_NUDGE_TOPIC, payload, ctx.nowMs)
  } catch {
    /* a gateway that missed a nudge sweeps on its interval; the order is safe */
  }
}

/** Broker-facing side vocabulary. Python speaks 'Buy'/'Sell'; brokers 'BUY'/'SELL'. */
export function brokerSide(side: DeskSide): 'BUY' | 'SELL' {
  return side === 'Buy' ? 'BUY' : 'SELL'
}

/**
 * WHO ASKED FOR THIS ORDER — and therefore which LIFECYCLE it gets (D14).
 *
 * `'engine'` is the recenter supervisor's endpoint (`routes/engine.ts`), and it
 * is the only caller that opts a PAPER order into the live order's life: queued
 * in `desk-gateway-orders`, claimed, gated, pegged, tranche-worked, and filled
 * by a tick that crosses it — with the book folding on the FILL EVENT rather
 * than at the moment of the write.
 *
 * ABSENT IS THE OLD PATH, and that is deliberate rather than a default waiting
 * to be tidied away. `/v1/desk/submit` (the manual order box), the runner's
 * hosted strategies and `closeAll` all book a paper fill synchronously, because
 * for them the paper rail is a BOOK-KEEPING device: a manual-box paper order
 * that rested until a tick crossed it would leave an operator staring at a
 * dialog that reported nothing. Only the supervisor has the machinery (a
 * `WORKING` status it understands, an inFlight poll, a fill nudge) to wait.
 */
export type RouteVia = 'engine'

export interface RouteContext {
  readonly tag: string
  readonly underlying: string
  readonly instrument: InstrumentRef
  readonly nowMs: number
  /**
   * Idempotency key, unique per order and stable across a replay.
   *
   * The gateway's queue enforces a UNIQUE index on this, which is what stops a
   * retried decision producing a second broker order. It is also the
   * correlation id echoed back on the broker's order socket, so a fill can be
   * matched to the intent that produced it.
   */
  readonly clientOrderId: string
  /** Which caller's lifecycle this order gets. See `RouteVia`. */
  readonly via?: RouteVia
}

export interface OrderRail {
  readonly mode: 'paper' | 'live'
  /**
   * The collection this rail writes its orders to.
   *
   * Exposed because it is the ONLY witness a crashed decision leaves behind.
   * `route()` succeeding means exactly "this document was inserted", so a replay
   * that finds a claim stuck in `ROUTING` can ask this collection which of the
   * deterministic `<decisionId>#<i>` order ids actually landed instead of
   * guessing — see `service.ts:#resolveRouting` and `submit.ts:#resolveRouting`.
   *
   * It is read off the RAIL rather than configured beside it because the live
   * target is a deliberate choice (`LiveExecutor` below): a reconcile that
   * probed the wrong collection would report a routed order as lost, which is
   * the one error that talks a caller into re-routing it.
   */
  readonly collection: string
  route(fill: Fill, ctx: RouteContext): Promise<void>
}

/**
 * WHERE AN ORDER ROUTED WITH THIS CONTEXT ACTUALLY LANDED.
 *
 * A free function rather than a second field on `OrderRail`, and it lives
 * BESIDE `PaperRail.route` for the reason `paperFillEvent` gives about itself:
 * the writer and the reader of one rule must not be able to drift. `route`
 * picks its collection from this function and `#resolveRouting` asks the same
 * function where to go looking — so "an engine paper order is in the gateway
 * queue" is stated exactly once.
 *
 * A crash-recovery reader that probed the WRONG collection would find nothing
 * and report a routed order as lost, which is the one error that talks a caller
 * into routing it a second time.
 */
export function routedCollection(
  // The two fields it reads and no more, so the rule can be asserted against a
  // literal rather than a whole rail.
  rail: Pick<OrderRail, 'mode' | 'collection'>,
  via?: RouteVia,
): string {
  return rail.mode === 'paper' && via === 'engine' ? COLLECTIONS.gatewayOrders : rail.collection
}

/**
 * Build the order document.
 *
 * Field-for-field what `common/models/positional.js:7-19` writes, because
 * `xtsOrder.js` reads exactly these keys off the change-stream document. One
 * deliberate difference: `exchange` comes from the instrument rather than being
 * hardcoded `'NFO'`, since SENSEX contracts are BFO and a hardcoded NFO would
 * mis-route them.
 *
 * SIZING NOTE — `quantity` is CONTRACT quantity (lots x lot_size).
 * `xtsOrder.js:100` recovers lots by dividing by `lot_size`, then scales by the
 * account's own per-strategy multiplier. So the number written here is the
 * desk's intended size at multiplier 1, and the account multiplier is the
 * operator's size dial on top. Do not pre-multiply it here.
 */
export function orderDocument(fill: Fill, ctx: RouteContext): Record<string, unknown> {
  return {
    status: 'COMPLETE',
    order_timestamp: new Date(ctx.nowMs),
    exchange: ctx.instrument.exchange,
    tradingsymbol: fill.tradingsymbol,
    instrument_token: ctx.instrument.instrumentToken,
    // The contract's OWN tick grid, so the gateway's chaser rounds a reprice
    // onto the grid the instrument actually trades on instead of assuming
    // NFO's 0.05 (`order-chaser.ts` DEFAULT_TICK, which nothing had ever
    // stamped over). Omitted, never zeroed, when the instrument has no usable
    // tick — the default is the honest answer then.
    ...(Number.isFinite(ctx.instrument.tickSize) && ctx.instrument.tickSize > 0
      ? { tickSize: ctx.instrument.tickSize }
      : {}),
    order_type: fill.orderType ?? 'MARKET',
    ...(fill.limitPrice === undefined ? {} : { limitPrice: fill.limitPrice }),
    // Carried so the order chaser can tell a deliberately pending order from a
    // stuck one. See `Fill.resting`.
    ...(fill.resting === true ? { resting: true } : {}),
    /**
     * HOW HARD THIS ORDER SHOULD WORK, when the caller chose — the engine
     * endpoint's `workMode`, read by the gateway's peg chaser off this very
     * document. Written here rather than inferred there because the choice
     * belongs to whoever decided the order, and the gateway has no way to
     * recover it from a price.
     *
     * ABSENT WHEN NOBODY CHOSE, never defaulted: every order this desk has
     * routed until now has no work mode, and stamping one would tell the
     * chaser a decision was made where none was.
     */
    ...(fill.workMode === undefined ? {} : { workMode: fill.workMode }),
    /**
     * THE BOOK'S EXECUTION DIALS, on the order they govern (§8).
     *
     * `trancheLots` is read by the gateway's placer, which works a large order
     * one slice at a time and releases the next only when the last is terminal
     * (`gateway.ts:planTranches`); `chaseMaxMs`/`chaseCrossBufferPct` are read
     * by the peg chaser off this very document (`order-chaser.ts:577-581`),
     * which until now could only ever see its own env defaults — the book's
     * dials existed, and nothing carried them to the process that acts on them.
     *
     * ABSENT WHEN NOBODY CHOSE, never zeroed, for the same reason `workMode`
     * is: a `trancheLots: 0` would read as "slice into nothing" and a
     * `chaseMaxMs: 0` as "cross immediately" — both of which are decisions,
     * and neither of which anybody made.
     */
    ...(fill.trancheLots === undefined ? {} : { trancheLots: fill.trancheLots }),
    ...(fill.chaseMaxMs === undefined ? {} : { chaseMaxMs: fill.chaseMaxMs }),
    ...(fill.chaseCrossBufferPct === undefined
      ? {}
      : { chaseCrossBufferPct: fill.chaseCrossBufferPct }),
    /**
     * WHICH DELTA-LEAN BET ASKED FOR THIS ORDER (plan 10A) — written here
     * because this document is the only durable thing standing between an
     * engine PAPER decision and the leg it eventually becomes.
     *
     * The paper rail answers `WORKING` and books nothing; `paper-fold.ts` reads
     * this very document when the gateway's fill lands and puts the stamp on
     * the leg it creates. Without it the lean that opened a position cannot
     * find it again, so it never adds on a winner and never cuts on a loser.
     *
     * ABSENT WHEN NOBODY NAMED A LEAN — the recenter engine names none — and
     * never `leanId: undefined`, which Mongo stores as null and reads back as a
     * VALUE. The same rule as `workMode` and the work dials above.
     *
     * It is stamped on the LIVE document too, where nothing reads it: the live
     * leg is written by `applyActions` inside the request. Provenance that is
     * true of an order should not depend on which rail carried it, and a field
     * written on one rail only is a field that will be missing the day the
     * other one needs it.
     */
    ...(fill.leanId === undefined ? {} : { leanId: fill.leanId }),
    transaction_type: brokerSide(fill.side),
    quantity: fill.qty,
    filled_quantity: fill.qty,
    tag: ctx.tag,
    // Provenance so a fill in Mongo can be traced back to the desk decision.
    underlying: ctx.underlying,
    desk_tag: fill.deskTag,
    desk_op: fill.op,
    price: fill.price,
    clientOrderId: ctx.clientOrderId,
    dataObj: [ctx.clientOrderId],
  }
}

/**
 * A paper fill, read back as an order-journal event.
 *
 * WHY THIS EXISTS (2026-07-28). The Orders page reads `desk-order-events`,
 * which only `apps/order-gateway` (the LIVE rail) and refusals ever write — so
 * in PAPER it rendered "0 events" for a desk that had traded all morning, and
 * the strategy page said outright that paper orders are not journalled. They
 * are; they are just journalled HERE, by `PaperRail.route` above, with the fill
 * price and the timestamp the operator was asking for.
 *
 * Deliberately shaped like the gateway's `OrderEvent` so one table renders both
 * rails. It sits beside `orderDocument` because it reads exactly the keys that
 * function writes, and a reader that drifts from its writer returns `undefined`
 * for a field that was there all along.
 */
export function paperFillEvent(doc: Record<string, unknown>): Record<string, unknown> {
  const stamp = doc['order_timestamp']
  return {
    // `order_timestamp` is a BSON date; the journal's `ts` is epoch ms. A Date
    // handed to a table that formats numbers renders as "Invalid Date".
    ts: stamp instanceof Date ? stamp.getTime() : Number(stamp),
    phase: 'FILL',
    // A paper fill is booked the moment it is written — there is no rail to
    // refuse it. `false` here would light the whole log red.
    ok: true,
    tag: doc['tag'],
    tradingsymbol: doc['tradingsymbol'],
    clientOrderId: doc['clientOrderId'],
    side: doc['transaction_type'],
    filledQty: doc['filled_quantity'] ?? doc['quantity'],
    avgPrice: doc['price'],
    status: doc['status'] ?? 'COMPLETE',
    detail: { source: 'paper', mode: 'paper', underlying: doc['underlying'], op: doc['desk_op'] },
  }
}

/**
 * Stamp what the DESK ORDER says — `side`, and its intent figures `limitPrice`
 * and `orderQty` — onto live order events that lack them.
 *
 * WHY THE COLUMNS WERE EMPTY. Nothing on the live rail has ever journalled a
 * side. `apps/order-gateway` records PLANNED / SUBMITTED / ACK / STATUS without
 * one, and STATUS — the only phase carrying a fill — is built from the broker's
 * update, which does not echo the direction either. So the Orders page and
 * every per-book log showed `—` in the Side column for every live row, forever.
 * Paper was fine, because `paperFillEvent` reads `transaction_type` off the
 * stored fill, which is why this went unnoticed.
 *
 * THE INTENT FIGURES ARE THE SAME HOLE ONE COLUMN OVER (2026-08-18). Only a
 * fill carries `filledQty`/`avgPrice`, so every PLANNED and SUBMITTED row in
 * the "every step" dialog read Qty `—` Price `—`, and the broker's first
 * PENDING_NEW echo read Qty 0 — while the quantity the desk asked for and the
 * limit it priced sit on the very order document this join already reads.
 * They are stamped under their own names, NEVER as `filledQty`/`avgPrice`:
 * what was asked and what traded must stay two different fields, because
 * conflating them is how a refused order reads as a fill.
 *
 * DONE HERE, ON THE READ, RATHER THAN AT THE WRITE, and that is the whole point:
 * teaching the gateway to journal a side would fix orders placed from then on
 * and leave every existing row blank. A positional book's log runs back weeks.
 * The direction is not missing from the desk — it is right there on the order
 * document the gateway consumed — it was simply never copied onto the event.
 *
 * JOINED ON THE BASE ID, because `desk-gateway-orders` is keyed by the DESK
 * order (uniquely indexed on `clientOrderId`) while a split order's events
 * carry `<base>.1`, `<base>.2`. One `$in` over an indexed field per request.
 *
 * An event that already has a field keeps it — paper fills arrive with a side,
 * and the stored document is not a better authority on them than the fill
 * itself.
 */
export async function withOrderContext<T extends Record<string, unknown>>(
  db: Database,
  events: readonly T[],
): Promise<T[]> {
  const wanted = new Set<string>()
  for (const e of events) {
    const id = String(e['clientOrderId'] ?? '')
    if (id !== '') wanted.add(baseClientOrderId(id))
  }
  if (wanted.size === 0) return [...events]

  /** Per desk order: the direction, and what was ASKED — never what filled. */
  interface OrderContext {
    side?: string
    limitPrice?: number
    orderQty?: number
  }
  let orders: Map<string, OrderContext>
  try {
    const docs = await db
      .collection(COLLECTIONS.gatewayOrders)
      .find({ clientOrderId: { $in: [...wanted] } })
      .toArray()
    orders = new Map()
    for (const d of docs) {
      const id = String(d['clientOrderId'] ?? '')
      if (id === '') continue
      const side = d['transaction_type']
      const limitPrice = Number(d['limitPrice'])
      // `quantity` is CONTRACT quantity (lots x lot_size) — see `orderDocument`.
      const qty = Number(d['quantity'])
      const ctx: OrderContext = {
        ...(side === 'BUY' || side === 'SELL' ? { side } : {}),
        ...(Number.isFinite(limitPrice) && limitPrice > 0 ? { limitPrice } : {}),
        ...(Number.isFinite(qty) && qty > 0 ? { orderQty: qty } : {}),
      }
      if (Object.keys(ctx).length > 0) orders.set(id, ctx)
    }
  } catch {
    // A log that renders without a side is degraded; one that 500s is gone.
    // This is decoration on a monitoring surface — it must never be the reason
    // an operator cannot see what traded.
    return [...events]
  }
  if (orders.size === 0) return [...events]

  return events.map((e) => {
    const ctx = orders.get(baseClientOrderId(String(e['clientOrderId'] ?? '')))
    if (ctx === undefined) return e
    const hasSide = typeof e['side'] === 'string' && e['side'] !== ''
    return {
      ...e,
      ...(hasSide || ctx.side === undefined ? {} : { side: ctx.side }),
      ...(typeof e['limitPrice'] === 'number' || ctx.limitPrice === undefined
        ? {}
        : { limitPrice: ctx.limitPrice }),
      ...(typeof e['orderQty'] === 'number' || ctx.orderQty === undefined
        ? {}
        : { orderQty: ctx.orderQty }),
    }
  })
}

/**
 * The DECISION an order belongs to: `<decisionId>#<index>`, tranche suffix
 * stripped first. The same rule as `reconcile-live.ts splitOrderId` (split at
 * the LAST `#`), restated here because importing it would close an import
 * cycle through `book-write.ts` -> `pnlstore.ts`. Null for an id with no
 * order index — a refusal journalled under a bare id has no decision to join.
 */
function decisionIdOf(clientOrderId: string): string | null {
  const base = baseClientOrderId(clientOrderId)
  const hash = base.lastIndexOf('#')
  return hash <= 0 ? null : base.slice(0, hash)
}

/**
 * Stamp WHY an order went out — the supervisor's `trigger` and `reason` — onto
 * the order events of the decision that placed it.
 *
 * WHY. The order journal records what happened to an order (PLANNED, ACK,
 * FILLED…) and nothing about the decision behind it, so the reports order log
 * could show "BUY NIFTY 22650 CE filled" but not that it was the day's OPEN,
 * an ADJUSTMENT, or the 14:50 FLATTEN — which is the first thing an operator
 * reading a day wants to know. The supervisor's journal
 * (`desk-engine-decisions`, one row per decision, keyed on `decisionId`) holds
 * exactly that, and every engine order id is `<decisionId>#<leg>`.
 *
 * ADDITIVE AND OPTIONAL, like `withOrderContext`: an event that already says
 * something keeps it, an order with no journal row (a manual close, a submit
 * through `/v1/desk/submit`) is returned untouched, and a failed read degrades
 * to the events as they were — this is decoration on a monitoring surface and
 * must never be why the log fails to load.
 */
export async function withDecisionContext<T extends Record<string, unknown>>(
  db: Database,
  events: readonly T[],
): Promise<T[]> {
  const wanted = new Set<string>()
  for (const e of events) {
    const id = decisionIdOf(String(e['clientOrderId'] ?? ''))
    if (id !== null) wanted.add(id)
  }
  if (wanted.size === 0) return [...events]

  const why = new Map<string, { trigger?: string; reason?: string }>()
  try {
    const docs = await db
      .collection(COLLECTIONS.engineDecisions)
      .find({ decisionId: { $in: [...wanted] } })
      .toArray()
    for (const d of docs) {
      const id = String(d['decisionId'] ?? '')
      const trigger = d['trigger']
      const reason = d['reason']
      const ctx = {
        ...(typeof trigger === 'string' && trigger !== '' ? { trigger } : {}),
        ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
      }
      if (id !== '' && Object.keys(ctx).length > 0) why.set(id, ctx)
    }
  } catch {
    return [...events]
  }
  if (why.size === 0) return [...events]

  return events.map((e) => {
    const id = decisionIdOf(String(e['clientOrderId'] ?? ''))
    const ctx = id === null ? undefined : why.get(id)
    if (ctx === undefined) return e
    return {
      ...e,
      ...(typeof e['trigger'] === 'string' || ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
      ...(typeof e['reason'] === 'string' || ctx.reason === undefined ? {} : { reason: ctx.reason }),
    }
  })
}

/**
 * `ORB-123.2` -> `ORB-123`, the DESK order a tranche belongs to.
 *
 * Deliberately a copy of `apps/order-gateway`'s `baseClientOrderId` rather than
 * an import: `@algomaker/api` does not depend on the gateway app and must not
 * start doing so for two lines. The suffix convention is a wire format shared
 * by both, and it is pinned by tests on each side — which is how the two
 * copies were found to have drifted: this one cut at the FIRST dot, so a
 * hosted strategy's `atr.v2-171#3` joined as `atr` and found no document.
 * Only a TRAILING numeric `.N` is a tranche suffix.
 */
function baseClientOrderId(id: string): string {
  const m = /^(.*)\.\d+$/.exec(id)
  return m?.[1] ?? id
}

/**
 * The document the GATEWAY consumes.
 *
 * Adds the queue's own fields to the order shape. Without them `claimNext()`
 * (which filters on `state: 'PENDING'`) matches nothing and the gateway sits
 * idle while orders pile up — caught end-to-end locally, because the two halves
 * had been written to different contracts.
 *
 * AND DROPS THE LEGACY SHAPE'S FILL FIELDS. `status: 'COMPLETE'`,
 * `filled_quantity` and `price` are true on `desk-paper-trade` (the row IS the
 * fill) and are what `xtsOrder.js` reads off `positional`; on this queue they
 * were a fill claimed at ENQUEUE, beside the gateway's own lifecycle (`state`,
 * `filledQty`, `avgPrice`) that nothing here reads them in preference to. On
 * 2026-10-01 `SENSEX-delta-lean-aggressive-2026-10-01:paper:5#4` read
 * "COMPLETE, 80 filled @ 149.15" next to `state: REJECTED, filledQty: 0`, and
 * was taken for a fill the desk had lost. The decision-time mark stays, as
 * `markPrice`, under a name that is not a fill.
 */
export function gatewayOrderDocument(fill: Fill, ctx: RouteContext): Record<string, unknown> {
  const { status: _status, filled_quantity: _filled, price, ...order } = orderDocument(fill, ctx)
  return {
    ...order,
    markPrice: price,
    state: 'PENDING',
    createdAt: ctx.nowMs,
  }
}

/**
 * Paper rail. Writes to a collection nothing forwards from.
 *
 * The fill price is the live mark supplied by the caller — this is a paper
 * BOOK, not a paper price model. Marking at anything other than the feed's own
 * price would make the paper book's delta diverge from the live one for reasons
 * that have nothing to do with the strategy.
 */
export class PaperRail implements OrderRail {
  readonly mode = 'paper' as const
  readonly collection = COLLECTIONS.paperTrade
  readonly #db: Database
  readonly #emit: PaperFillEmit | null
  readonly #bus: OrderNudgeBus | null

  /**
   * `emit` is the websocket push, and it is OPTIONAL for a reason: every test
   * and every code path that builds a rail without one keeps working, and a
   * deployment with no dashboard attached behaves identically. A paper fill is
   * booked by the write above it, never by the notification.
   *
   * `bus` is the gateway nudge (see `nudgeGateway`) and is optional on the same
   * terms: without it an engine paper order is still durable and still worked,
   * it just waits for the gateway's idle sweep instead of being picked up at
   * once. Latency, never correctness.
   */
  constructor(db: Database, emit?: PaperFillEmit, bus?: OrderNudgeBus) {
    this.#db = db
    this.#emit = emit ?? null
    this.#bus = bus ?? null
  }

  async route(fill: Fill, ctx: RouteContext): Promise<void> {
    /**
     * THE ENGINE'S PAPER ORDERS GO INTO THE LIVE QUEUE (D14, plan Task 18).
     *
     * Same collection, same claim, same gates (bar the live allowlist, which is
     * about real money and nothing else), same peg chaser, same tranche cursor,
     * same fill correlation — the only difference between this document and a
     * live one is `mode: 'paper'`, which is what makes the gateway hand it to
     * the SIMULATOR instead of the broker.
     *
     * The mode is a field on the document rather than a second collection
     * precisely because the point is to run ONE lifecycle. The separation this
     * file's header argues for — paper and live as different collections, so a
     * daemon watching one cannot execute the other — is preserved by the
     * process on the far side reading the field and choosing an adapter with
     * it, and by that choice being FAIL-CLOSED: anything that is not explicitly
     * `'paper'` is treated as live, and a live order still has to pass the
     * Strategies-page allowlist in the gateway's own second gate.
     *
     * NOTHING IS FILLED HERE, and nothing is emitted. There is no fill yet —
     * that is the entire change. `paper-fold.ts` publishes the fill frame when
     * a tick actually crosses the order.
     */
    if (routedCollection(this, ctx.via) === COLLECTIONS.gatewayOrders) {
      await this.#db
        .collection(COLLECTIONS.gatewayOrders)
        .insertOne({ ...gatewayOrderDocument(fill, ctx), mode: 'paper' })
      // AFTER the await, never before — see `nudgeGateway`.
      nudgeGateway(this.#bus, fill, ctx)
      return
    }

    const doc = { ...orderDocument(fill, ctx), mode: 'paper' }
    await this.#db.collection(COLLECTIONS.paperTrade).insertOne(doc)
    /**
     * The push happens HERE, after the durable write, because this is the one
     * place EVERY paper fill passes through — the Python desk's book-shaped
     * actions and a hosted strategy's `/submit` both route through this method.
     * Emitting at the two call sites instead would be two places to forget.
     *
     * BEST EFFORT, AND IT CANNOT FAIL THE FILL. The fill is already durable by
     * this line; letting a notification error propagate would turn a dashboard
     * problem into a routing failure, and the caller would then be told an
     * order did not go out when it did. Same rule as `OrderJournal.record` and
     * `journalBlocked`: swallow, carry on.
     */
    if (this.#emit !== null) {
      try {
        this.#emit('paper', paperFillEvent(doc))
      } catch {
        /* a dashboard that missed an update is an inconvenience */
      }
    }
  }
}

export class LiveRailBlocked extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'LiveRailBlocked'
  }
}

/**
 * Live rail. Writes to the executor's collection — `desk-gateway-orders` for
 * the order-gateway, `positional` for the retired legacy executor.
 *
 * The allowlist is checked HERE, at the point of writing, not at the API edge.
 * An edge check is one refactor away from being bypassed by a second call site;
 * a check inside the only object that can write to the live collection is not.
 *
 * This is the FIRST of two independent gates. The second is the ORDER-GATEWAY's
 * own check (`apps/order-gateway/src/main.ts`) — a separate process refusing
 * independently, which is the property that matters.
 *
 * BOTH NOW READ THE STRATEGY ROW's `modes.live` switch, per order, via
 * `liveAllowlistFromStrategies`. They used to read `DESK_LIVE_TAGS` from the
 * shared ecosystem env, and each needed its OWN restart to pick a change up —
 * a restart that `pm2 restart <name> --update-env` does not actually perform,
 * because it does not re-parse the file that reads `.env.local`. The two
 * drifted apart on prod 2026-07-30 and refused a correctly-enabled tag while
 * blaming the env var. `DESK_LIVE_TAGS` survives only as an optional
 * box-level pin that can narrow the set, never widen it.
 *
 * WHAT THE ALLOWLIST STOPS IS NEW EXPOSURE, not every order (spec §9). An
 * order that only reduces this tag's live book routes whether the switch is on
 * or off — see `#exits`, which derives that from the stored legs rather than
 * being told it.
 */
/**
 * Which collection live orders are written to, i.e. WHO executes them.
 *
 * EXACTLY ONE executor may consume a given collection. `xtsOrder.js:314` watches
 * `positional`; if a new order-gateway also watched it, every desk order would
 * be placed TWICE — once by each. That is the single most expensive mistake
 * available in this system, so the target is an explicit choice rather than a
 * default that quietly becomes wrong the day the gateway ships.
 *
 *  - `desk-gateway` — DEFAULT. apps/order-gateway executes: it splits under the
 *    exchange freeze limit, correlates fills, and captures partial fills.
 *  - `legacy-positional` — DEPRECATED. The `xtsOrder.js` daemon executes.
 *    Retained only so an in-flight cutover can be pointed back for one session;
 *    it cannot route stock options at all (its `maxOrderLots` table has no
 *    entry, so `qty <= undefined` is false and it falls into a bad tranche
 *    call). Do not run it alongside the gateway — both would place every
 *    order.
 */
export type LiveExecutor = 'desk-gateway' | 'legacy-positional'

export const LIVE_COLLECTION: Readonly<Record<LiveExecutor, string>> = {
  'legacy-positional': COLLECTIONS.live,
  'desk-gateway': COLLECTIONS.gatewayOrders,
}

/**
 * Answers, at the moment an order tries to route, whether this tag may trade
 * live. A FUNCTION, not a set, because the allowlist now lives in the
 * `desk-strategies` row that the password-gated Strategies page writes — so it
 * changes without a restart and must be asked, not remembered.
 */
export type LiveAllowlist = (tag: string) => Promise<boolean>

export class LiveRail implements OrderRail {
  readonly mode = 'live' as const
  readonly #db: Database
  readonly #allows: LiveAllowlist
  readonly #collection: string
  readonly #executor: LiveExecutor
  readonly #bus: OrderNudgeBus | null

  /**
   * `allowlist` accepts a static iterable (tests, and any caller that really
   * does have a fixed set) or a resolver. Production passes
   * `liveAllowlistFromStrategies`, so the switch on the Strategies page is the
   * allowlist.
   *
   * `bus` is the gateway nudge (see `nudgeGateway`), optional and last so every
   * existing construction site is untouched. It is published only when this
   * rail's executor is the gateway — `legacy-positional` writes `positional`,
   * which `xtsOrder.js` watches on a change stream and no sweeper reads.
   */
  constructor(
    db: Database,
    allowlist: Iterable<string> | LiveAllowlist,
    executor: LiveExecutor = 'desk-gateway',
    bus?: OrderNudgeBus,
  ) {
    this.#db = db
    this.#bus = bus ?? null
    if (typeof allowlist === 'function') {
      this.#allows = allowlist
    } else {
      const fixed = new Set(allowlist)
      this.#allows = async (tag: string): Promise<boolean> => fixed.has(tag)
    }
    this.#executor = executor
    this.#collection = LIVE_COLLECTION[executor]
  }

  get executor(): LiveExecutor {
    return this.#executor
  }

  get collection(): string {
    return this.#collection
  }

  async route(fill: Fill, ctx: RouteContext): Promise<void> {
    if (!(await this.#allows(ctx.tag)) && !(await this.#exits(fill, ctx))) {
      throw new LiveRailBlocked(
        `tag '${ctx.tag}' is not enabled for live and this order would ADD exposure; ` +
          `switch it on for LIVE on the Strategies page (password required). An order that ` +
          `only reduces the live book is allowed through regardless of the switch.`,
      )
    }
    const doc =
      this.#executor === 'desk-gateway'
        ? gatewayOrderDocument(fill, ctx)
        : orderDocument(fill, ctx)
    await this.#db.collection(this.#collection).insertOne(doc)
    // AFTER the await, never before — see `nudgeGateway`. A refused order threw
    // above and reaches neither line, so nothing is ever announced that is not
    // in the queue.
    if (this.#executor === 'desk-gateway') nudgeGateway(this.#bus, fill, ctx)
  }

  /**
   * DOES THIS ORDER ONLY REDUCE THE LIVE BOOK? Read off the book, never claimed.
   *
   * WHY THE EXEMPTION EXISTS AT ALL. Spec §9: switching a tag off blocks new
   * exposure and never blocks an exit. `gateStrategy` has held that since the
   * 2026-08-04 stranded-position incident — a switch that traps what it holds
   * is the trap the kill switch's own exemption exists to avoid — but this rail
   * re-checked the same switch on the way to the wire with no exemption of its
   * own, so a switched-off LIVE tag's exit passed the gate and was refused
   * HERE, as a route error. "Off" meant "cannot get out", which is the one
   * thing it must never mean.
   *
   * DERIVED, NOT TRUSTED — the rule `routes/engine.ts` states for its own
   * claim, and the reason nothing was added to `RouteContext` for a caller to
   * assert. A rail that took a caller's word for "this is an exit" would be a
   * live-order gate any caller could open by saying so; the second of two
   * independent gates has to be able to answer for itself.
   *
   * THE PRE-DECISION BOOK IS THE RIGHT BOOK, and it is what this read gets.
   * `applyDecision` reads `desk-books`, applies the actions in memory, routes
   * (here), and only then writes the recomputed legs back — so at this line the
   * stored legs are still the position this order is trading against.
   *
   * THE TEST IS THE OP, THEN DIRECTION AND SIZE. Only `close` and `resize` can
   * reduce a position at all; past that gate, an order reduces iff it trades
   * OPPOSITE the leg it names and does not exceed it — a `close` sells back
   * exactly what is held, a shrinking `resize` trades the delta on the closing
   * side, a growing one trades the leg's own side. One comparison rather than
   * per-op arithmetic that could disagree with `applyActions` about what any op
   * means, with the op itself checked first because the size test alone is
   * package-blind (see the return).
   *
   * FAIL CLOSED, EVERY TIME. No book, no leg for the tag, two legs sharing it,
   * a leg naming a different contract, an unreadable quantity, a read that
   * threw — every one of those answers "not an exit", which refuses. The cost
   * of a wrong `false` is a route error on an exit that the operator's
   * close-all can still perform; the cost of a wrong `true` is a real order
   * placed for a tag the operator switched off.
   *
   * A ROLL IS REFUSED WHOLE, both halves of it, and that is the right answer
   * for a rail that sees one order at a time. `applyActions` emits two fills
   * for one roll and stamps both `op: 'roll'`; letting the buy-back through and
   * refusing the replacement would leave a switched-off book short a hedge,
   * which is worse than leaving it untouched. Nothing forms a `RollAction` any
   * more — the only wire that emitted one was `POST /v1/desk/actions`, removed
   * in the D9 cutover — so this costs nothing today and is the safe shape if a
   * roll producer ever returns. Whether a roll SHOULD carry the exemption is a
   * package-level judgement (`addsExposure` calls a roll non-adding) and would
   * have to be settled there, where the whole decision is in view.
   */
  async #exits(fill: Fill, ctx: RouteContext): Promise<boolean> {
    let doc: Record<string, unknown> | null
    try {
      doc = await this.#db.collection(COLLECTIONS.books).findOne({ tag: ctx.tag, mode: 'live' })
    } catch {
      // A book we cannot read is a book we cannot vouch for.
      return false
    }
    if (doc === null) return false
    const legs = doc['legs']
    if (!Array.isArray(legs)) return false

    // EXACTLY ONE, because a duplicate desk tag makes "the leg this order
    // reduces" a guess — and `applyActions` refuses to create one precisely so
    // readers like this never have to guess.
    const named = legs.filter(
      (l): l is Record<string, unknown> =>
        typeof l === 'object' && l !== null && (l as Record<string, unknown>)['deskTag'] === fill.deskTag,
    )
    if (named.length !== 1) return false
    const leg = named[0] as Record<string, unknown>

    // The leg must be the same CONTRACT. A tag that resolves to a different
    // tradingsymbol is a book this order was not formed against.
    const instrument = leg['instrument']
    const symbol =
      typeof instrument === 'object' && instrument !== null
        ? (instrument as Record<string, unknown>)['tradingsymbol']
        : undefined
    if (symbol !== fill.tradingsymbol) return false

    const held = Number(leg['qty'])
    if (!Number.isFinite(held) || held === 0) return false
    const traded = signedQty(fill.side, fill.qty)
    if (!Number.isFinite(traded) || traded === 0) return false
    /**
     * THE OP IS PART OF THE TEST, and it is what makes this rule safe to apply
     * one fill at a time.
     *
     * Direction-and-size alone is PACKAGE-BLIND. This method sees a single
     * order and cannot know what else is in the decision, so two shapes walk
     * past a size check that reads only the numbers:
     *
     *   A ROLL. `applyActions` emits two fills for one roll and stamps BOTH
     *   `op: 'roll'` — the buy-back of the old leg, which really does reduce,
     *   and the sale of the replacement, which is new exposure. Judged on
     *   direction and size, that second fill reduces "the leg it names" too,
     *   because it is stamped with the OLD leg's tag.
     *
     *   AN OPEN WEARING A CLOSE'S CLOTHES. `[close X, open ts='X' on the
     *   opposite side, qty <= held]` is a package whose second action names a
     *   tag the pre-decision book still holds — this method's read is of the
     *   book BEFORE the decision, so the leg is there — in the closing
     *   direction, at a permitted size. It is an OPEN.
     *
     * Gate 1 refuses both of those today (`applyActions` will not open onto a
     * tag it already holds, and the engine wire has no roll at all). But this
     * rail exists FOR the case where gate 1 does not hold — that is the whole
     * argument for two independent gates — so it must not be relying on gate 1
     * to be right.
     *
     * `close` and `resize` are the only ops that can reduce a position, and
     * naming them here can only ever REFUSE MORE than the size test alone: an
     * exit is a close or a shrinking resize, and it stays permitted.
     */
    if (fill.op !== 'close' && fill.op !== 'resize') return false
    return Math.sign(traded) === -Math.sign(held) && Math.abs(traded) <= Math.abs(held)
  }
}

/**
 * Pick a rail. Explicit map, no default.
 *
 * An unknown mode throws rather than falling back, because every plausible
 * fallback is wrong: defaulting to paper silently stops a live desk from
 * trading, and defaulting to live is catastrophic.
 */
export function railFor(
  mode: string,
  rails: { paper: OrderRail; live: OrderRail },
): OrderRail {
  if (mode === 'paper') return rails.paper
  if (mode === 'live') return rails.live
  throw new Error(`unknown mode '${mode}': expected 'paper' or 'live'`)
}
