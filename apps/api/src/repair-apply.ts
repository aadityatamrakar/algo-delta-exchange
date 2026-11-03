/**
 * THE WAVE STATE MACHINE BEHIND THE REPAIR APPLY BUTTON.
 *
 * `repair-plan.ts` says WHAT to place. This module says WHEN, and that is the
 * whole of its job: closes first, then — only once the broker has actually
 * FILLED them — the opens. Nothing else here is new machinery. Every order
 * goes out through `SubmitService`, so the kill switch, the strategy switch,
 * the live allowlist, the freeze split, the risk caps, the journal and the book
 * fold are the same ones a manual order pays. This service is handed a rail
 * that answers like `SubmitService` does and it TRUSTS that answer; a gate
 * re-implemented here would be a second opinion about whether the desk is
 * allowed to trade, and the wrong one would be silent.
 *
 * WHY THE ORDER MATTERS ENOUGH TO BUILD A MACHINE FOR IT.
 *
 * A repair is a shift: take a leg off at 2440 and put it back on at 2260. Fire
 * both at once and, for as long as the closes are unfilled, the book carries
 * BOTH — double the size, double the margin, and a delta nothing on any screen
 * agrees with. Fire the open after the close is merely SUBMITTED and the same
 * thing happens whenever the close is slow. So the gate is a real fill, read
 * back off the rails' own records through the injected `fillState`, and the
 * open wave does not start until every close in front of it has one.
 *
 * FAILURE IS A HALT, NEVER A ROLLBACK (spec §6.4). An order the rail refuses,
 * a fill that comes back FAILED, a wave that ages out, a contract with no
 * quote — each stops the run exactly where it stands, records the per-order
 * ledger, and releases the hold. Orders already at the broker are left to
 * terminate: they are not ours to cancel from here, and "un-closing" a leg by
 * buying it back is a NEW position taken at a price nobody chose. The operator
 * reads what executed and finishes by hand.
 *
 * ONE RUN PER TAG, enforced by a UNIQUE index on `{tag}` filtered to
 * `state: 'RUNNING'` rather than by anything in this file — see `#insertClaim`.
 *
 * A RUN IS ALSO THE SUPERVISOR HOLD (spec §7): the Python driver polls
 * `/v1/desk/positions`, sees `repairHold`, and stands its own action pass down
 * until it clears. That TTL is the backstop for a bridge that dies mid-run — a
 * crashed apply must not be able to freeze a live book indefinitely.
 *
 * The two are NOT the same predicate, and `isLive`/`holdsBook` say why: the
 * claim ends when the run does, because a finished run cannot start a second
 * wave machine and must not refuse the operator's next plan; the hold outlives
 * it by `REPAIR_HOLD_GRACE_MS`, because the driver adopts the legs this run
 * opened one or two ticks AFTER the closes have already left its book.
 */

import type { DeskMode } from './contract.ts'
import { errorMessage, isDuplicateKey } from './errors.ts'
import { marketableFromEnv, marketableLimit, type MarketableConfig } from './marketable.ts'
import type { PlannedOrder } from './repair-plan.ts'
import type { SubmitRequestBody, SubmitResponse } from './submit.ts'
import { COLLECTIONS, type Collection, type Database } from './store.ts'

/**
 * THE OUTER BOUND ON EVERYTHING: the hold, the run, and how long a stranded
 * document may speak for a book.
 *
 * Ten minutes is EXACTLY two waves at the gateway's own 300s order age limit,
 * and that is not slack — it is the whole budget. Each wave restarts its own
 * clock, so a run that spent the full 300s on its closes and then started
 * spending on its opens would cross this line while orders were still live,
 * and the Python driver would resume managing a book mid-repair. So the run is
 * bounded by this number TOO (`#awaitWave`), not only by the per-wave cap: the
 * run always ends no later than the hold it set.
 *
 * The same number bounds a document nobody will ever finish. A desk-api that
 * dies mid-run leaves a RUNNING row behind; past this line it neither holds the
 * tag nor blocks the next apply, because a stranded record must not be able to
 * lock a book out of repair forever. `haltStaleRunsOnBoot` closes the same gap
 * faster when the process comes back.
 */
export const REPAIR_HOLD_MS = 600_000

/**
 * HOW LONG A FINISHED RUN GOES ON HOLDING ITS BOOK — three supervisor ticks.
 *
 * THE ARITHMETIC, because the number is nothing without it. The Python driver
 * ticks about every 30s. A repair's CLOSES land on the bridge's book the
 * instant they fill, so the driver sees them gone on its very next tick. The
 * legs its OPENS created arrive as bridge-only legs, and `adopt_manual_legs`
 * will not touch one until it has seen the identical `id -> qty` on the
 * PREVIOUS tick as well (its stability guard, plus an in-flight guard that can
 * hold it a tick longer) — so adoption lands up to two ticks after the fill.
 *
 * Between those two facts is a window of up to a minute in which the driver is
 * looking at a book that has lost the legs the repair closed and does not yet
 * carry the ones it opened: a short strangle mid-shift reads as half a book,
 * and the playbook re-centres, re-hedges or re-opens against a hole nobody
 * asked it to fill. The hold is what stands its ACTIONS down (marking, greeks
 * and adoption all carry on underneath it), so the hold has to outlive the run
 * by the adoption lag — two ticks, plus one for the tick the driver may just
 * have missed.
 *
 * IT IS A WINDOW, NOT A SECOND TTL. `REPAIR_HOLD_MS` still caps everything:
 * `min(createdAt + REPAIR_HOLD_MS, updatedAt + this)` is the end of every hold,
 * so a run that ends at its hold window releases the book then and there.
 */
export const REPAIR_HOLD_GRACE_MS = 90_000

/** Fill polling cadence. Fast enough that a wave hand-off is not felt. */
const DEFAULT_POLL_MS = 2_000

/**
 * The gateway's own order max age. A wave that has not filled inside it is not
 * going to: the orders behind it have aged out at the broker too.
 */
const DEFAULT_MAX_WAVE_MS = 300_000

/**
 * WHAT AN ORDER WHOSE OUTCOME WE DO NOT KNOW IS CALLED.
 *
 * Two paths reach it — `submit` threw, or it answered `ROUTING` +
 * `indeterminate` — and they are the same fact: the claim may exist and the
 * order may be at the broker. `submit.ts`'s own header spells out why the
 * honest word matters more here than anywhere else: a caller that reads
 * "refused" as "nothing happened" places it a second time, and a repair placed
 * twice is a book carrying double the leg it was repairing.
 */
const UNKNOWN_OUTCOME =
  'submit outcome unknown — the order may have reached the broker; check the order book before ' +
  'finishing by hand'

/**
 * `SubmitService`, as narrowly as this module needs it.
 *
 * A port rather than the class, for the reason `SubmitStore` is one: the whole
 * sequencing above is then testable against a fake that answers in a few lines,
 * instead of against a service that needs a rail, an instrument master, a mark
 * source, a freeze table and a Mongo.
 */
export interface OrderRail {
  submit(req: SubmitRequestBody): Promise<SubmitResponse>
}

/** The touch, the mid and the grid — everything the two styles price off. */
export interface RepairQuote {
  readonly bid: number | null
  readonly ask: number | null
  readonly mid: number | null
  readonly tickSize: number
}

export type RunState = 'RUNNING' | 'DONE' | 'HALTED'

export interface RunOrder {
  readonly clientOrderId: string
  readonly wave: 'close' | 'open'
  readonly planned: PlannedOrder
  readonly status: 'QUEUED' | 'SUBMITTED' | 'FILLED' | 'FAILED'
  /** Why it is where it is — the rail's refusal, verbatim, when there was one. */
  readonly detail?: string
}

export interface RunDoc {
  /** The applyId, which is the caller's decisionId. Unique, so it is the claim. */
  readonly _id: string
  readonly tag: string
  readonly mode: DeskMode
  readonly style: 'fast' | 'limit'
  /**
   * The book fingerprint the plan was built against. Stored, not checked here:
   * the apply route compares it before this service is ever called, and keeping
   * it on the run is what lets an after-the-fact reader tell which book state
   * the operator was looking at.
   */
  readonly bookPrint: string
  readonly state: RunState
  readonly haltReason?: string
  readonly orders: readonly RunOrder[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** What the positions payload carries while a tag is held. */
export interface RepairHold {
  readonly applyId: string
  readonly heldAt: number
  readonly untilMs: number
}

export interface RepairApplyDeps {
  readonly db: Database
  readonly rail: OrderRail
  now(): number
  log(msg: string, ctx?: object): void
  /**
   * The live quote for a contract, read AT SUBMIT TIME rather than at preflight
   * time. The modal's estimate may be a minute old by the time Confirm is
   * pressed, and an order priced off it is an order priced off a screen.
   */
  quote(tradingsymbol: string): RepairQuote | null
  /**
   * Did this order actually trade? Injected because the answer lives in the
   * rails' own collections and differs between paper and live (Task 9).
   */
  fillState(mode: DeskMode, clientOrderId: string): Promise<'PENDING' | 'FILLED' | 'FAILED'>
  readonly pollMs?: number
  readonly maxWaveMs?: number
}

// ------------------------------------------------------------------- the hold

/**
 * IS THIS RUN STILL EXECUTING? — the CLAIM predicate.
 *
 * It answers the two questions about the RUN: does it block the next apply, and
 * does it outrank a racing one. Both have to agree and they did not — the hold
 * expired on the TTL while the block did not, so a stranded RUNNING document
 * released the Python driver and went on refusing every apply the operator
 * tried, forever. A run past its hold window claims nothing.
 *
 * IT IS NO LONGER THE HOLD. `holdsBook` below answers the third question — does
 * this run still speak for the BOOK — and it deliberately outlives this one by
 * `REPAIR_HOLD_GRACE_MS`. The two are separate because they protect different
 * things: this one keeps two wave machines off one book, and a run that has
 * FINISHED cannot start a second machine, so it must not be able to refuse the
 * operator's next plan. The hold keeps the SUPERVISOR off a book whose legs it
 * has not caught up with, and that outlasts the run by construction.
 */
function isLive(run: RunDoc, nowMs: number): boolean {
  return run.state === 'RUNNING' && nowMs <= run.createdAt + REPAIR_HOLD_MS
}

/**
 * WHEN THIS RUN STOPS SPEAKING FOR ITS BOOK — the end of the driver hold.
 *
 * A RUNNING run holds to its TTL, exactly as it always did. A run that has
 * ENDED holds for `REPAIR_HOLD_GRACE_MS` past its last write, capped by the
 * same TTL: `min(createdAt + REPAIR_HOLD_MS, updatedAt + REPAIR_HOLD_GRACE_MS)`.
 * See `REPAIR_HOLD_GRACE_MS` for the adoption-lag arithmetic that number is.
 */
function holdUntil(run: RunDoc): number {
  const ttl = run.createdAt + REPAIR_HOLD_MS
  return run.state === 'RUNNING' ? ttl : Math.min(ttl, run.updatedAt + REPAIR_HOLD_GRACE_MS)
}

/**
 * IS THIS RUN STILL SPEAKING FOR ITS BOOK? — the DRIVER-hold predicate.
 *
 * A RUN THAT PLACED NOTHING HOLDS NOTHING once it has ended. The grace exists
 * for legs the driver has to adopt, and an empty plan — which inserts DONE on
 * arrival, outside the claim index, precisely because there is no book to
 * protect — created none. Keeping the carve-out is what keeps that claim true.
 */
function holdsBook(run: RunDoc, nowMs: number): boolean {
  if (run.state !== 'RUNNING' && !(Array.isArray(run.orders) && run.orders.length > 0)) return false
  return nowMs <= holdUntil(run)
}

/**
 * The hold a run projects, or null. Shared by the service and by the standalone
 * lookup below so the two can never disagree about what "held" means.
 *
 * Two independent ends: the TTL, and — once the run has stopped — the adoption
 * grace past its last write. Whichever comes first releases the tag.
 */
function holdOf(run: RunDoc | null, nowMs: number): RepairHold | null {
  if (run === null || !holdsBook(run, nowMs)) return null
  return { applyId: run._id, heldAt: run.createdAt, untilMs: holdUntil(run) }
}

/** Oldest first, `_id` breaking a same-millisecond tie. A TOTAL order. */
function outranks(a: RunDoc, b: RunDoc): boolean {
  return a.createdAt === b.createdAt ? a._id < b._id : a.createdAt < b.createdAt
}

/**
 * Every run still speaking for this tag, OLDEST FIRST.
 *
 * The unique partial index means there is at most one RUNNING row per tag, so
 * this returns one element or none — on a database where the index built. It
 * reads the whole set anyway, because the one thing worse than a slow read here
 * is a hold that answers "unheld" off whichever row a restored-without-indexes
 * collection happened to hand back first.
 */
async function liveOnTag(runs: Collection<RunDoc>, tag: string, nowMs: number): Promise<RunDoc[]> {
  const rows = await runs.find({ tag, state: 'RUNNING' }).toArray()
  return rows.filter((r) => isLive(r, nowMs)).sort((a, b) => (outranks(a, b) ? -1 : 1))
}

/**
 * Every run still HOLDING this tag, whatever state it is in, strongest first.
 *
 * TWO CLAUSES, and neither can be dropped. `state: 'RUNNING'` is the executing
 * run, holding to its TTL however long ago it last wrote. The `updatedAt`
 * window is every run that has ENDED inside the adoption grace.
 *
 * THIS IS THE COMMON READ, NOT THE RARE ONE, and it was written down as rare
 * once. The fast path in `holdFor` answers only while a run is actually
 * executing — which is a few minutes a day — so every other positions poll of
 * every book, all day, lands here. The claim index cannot serve it either: that
 * one is PARTIAL on `state: 'RUNNING'` and this query deliberately asks about
 * runs that are not. Hence the plain `{tag: 1, updatedAt: -1}` index built
 * beside it (`store.ts:ensureIndexes`) — without it this is a collection scan
 * that grows with every Apply ever pressed, on the desk's busiest read.
 *
 * STRONGEST FIRST means the hold that ends LAST, so the driver is stood down
 * for the union of the holds on its book rather than for whichever row a
 * natural-order read happened to meet first. `outranks` breaks a tie, giving a
 * total order.
 */
async function holdingOnTag(runs: Collection<RunDoc>, tag: string, nowMs: number): Promise<RunDoc[]> {
  const rows = await runs
    .find({
      tag,
      $or: [{ state: 'RUNNING' }, { updatedAt: { $gte: nowMs - REPAIR_HOLD_GRACE_MS } }],
    })
    .toArray()
  return rows
    .filter((r) => holdsBook(r, nowMs))
    .sort((a, b) => holdUntil(b) - holdUntil(a) || (outranks(a, b) ? -1 : 1))
}

/**
 * The hold this tag is under, as the READ paths ask for it.
 *
 * ONE `findOne` WHILE A RUN IS EXECUTING, which is the answer that has to be
 * cheapest: it is paid on every positions poll of every book. It is also the
 * read that has to FAIL LOUDLY — a store that cannot answer has not said
 * "nothing is running", and the caller that turns this into a hold needs the
 * throw to tell those two apart.
 *
 * EVERYTHING ELSE FALLS THROUGH TO `holdingOnTag`, and that is the ORDINARY
 * path rather than an exception: a run executes for a few minutes a day and
 * every poll outside those minutes lands there, which is why it has an index of
 * its own. It answers two questions this one cannot. The first is a row that is
 * present but STALE: the unique partial index should make it impossible for a
 * live run to be hiding behind one, but "should" is doing work there — an index
 * that failed to build, or a collection restored without one, and this read
 * would release the supervisor onto a book mid-repair. The second is the
 * ordinary end of every repair: the run has FINISHED and is serving out its
 * adoption grace (`REPAIR_HOLD_GRACE_MS`), which no query for a RUNNING row can
 * see.
 */
async function holdFor(
  runs: Collection<RunDoc>,
  tag: string,
  nowMs: number,
): Promise<RepairHold | null> {
  const first = await runs.findOne({ tag, state: 'RUNNING' })
  if (first !== null && isLive(first, nowMs)) return holdOf(first, nowMs)
  return holdOf((await holdingOnTag(runs, tag, nowMs))[0] ?? null, nowMs)
}

/**
 * The hold lookup as a FUNCTION OF THE DATABASE, for readers that have no
 * business holding the whole service.
 *
 * `/v1/desk/positions` is one: it needs one field on one response and is built
 * by a different route factory. Threading the service through so that route
 * could ask it a single question would couple the two for nothing; a second
 * hand-written query would be the thing that drifts.
 */
export function repairHoldLookup(
  db: Database,
  now: () => number,
): (tag: string) => Promise<RepairHold | null> {
  const runs = db.collection<RunDoc>(COLLECTIONS.repairApplies)
  return async (tag: string): Promise<RepairHold | null> => await holdFor(runs, tag, now())
}

// ---------------------------------------------------------------- the pricing

/**
 * Half to NEAREST tick, deliberately, and not toward the operator.
 *
 * Rounding a buy DOWN and a sell UP is the intuitive "conservative" choice and
 * it is the wrong one here: it moves the limit AWAY from the market by up to
 * half a tick, and the Limit style is already sitting at the mid with nothing
 * to spare. Half a tick of "better price" that costs the fill is not a saving —
 * a repair that does not execute leaves the book in the shape it was being
 * repaired out of.
 */
function roundToTick(price: number, tick: number): number {
  const grid = tick > 0 ? tick : 0.05
  // Re-rounded to paise afterwards: `248 * 0.05` is 12.400000000000002 in
  // binary floating point, and a price with a 16th decimal is on no grid.
  return Math.round(Math.round(price / grid) * grid * 100) / 100
}

function positive(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** Only when the quote's own is missing — never overriding what it said. */
function tickOf(quote: RepairQuote, planned: PlannedOrder): number {
  return positive(quote.tickSize) ?? positive(planned.instrument.tickSize) ?? 0.05
}

/**
 * The limit price this order goes out at, or null when the quote cannot honestly
 * produce one.
 *
 * FAST takes the touch the order would have to lift or hit — a buy pays the
 * ask, a sell takes the bid — and steps THROUGH it by the same buffer every
 * other desk order pays (`marketable.ts`). Pricing off the mid, or off the last
 * print, is how a repair sits unfilled with half the book already moved.
 *
 * LIMIT is the mid on the tick, for a spread too wide to cross. It can rest;
 * the existing order chaser is what walks it toward the market, which is why
 * this is a style the operator picks rather than the default.
 *
 * `expiresToday` is deliberately NOT asserted. The wide expiry-day buffer in
 * `marketable.ts` exists because that mark is an LTP — a price from the past.
 * This mark is the far touch of the live book, which already crosses; widening
 * it further would pay for a fill that is bought and paid for.
 */
function limitFor(
  planned: PlannedOrder,
  style: 'fast' | 'limit',
  quote: RepairQuote,
  cfg: MarketableConfig,
): number | null {
  const tick = tickOf(quote, planned)
  if (style === 'fast') {
    const touch = positive(planned.side === 'Buy' ? quote.ask : quote.bid)
    if (touch === null) return null
    return marketableLimit(planned.side, touch, { ...cfg, tickSize: tick })
  }
  const bid = positive(quote.bid)
  const ask = positive(quote.ask)
  const mid = positive(quote.mid) ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null)
  if (mid === null) return null
  return positive(roundToTick(mid, tick))
}

// ------------------------------------------------------------------- the runs

/** The run as the executor mutates it. `toDoc` is the only thing persisted. */
interface RunProgress {
  readonly id: string
  readonly tag: string
  readonly mode: DeskMode
  readonly style: 'fast' | 'limit'
  readonly bookPrint: string
  readonly createdAt: number
  readonly orders: MutableOrder[]
  state: RunState
  haltReason: string | undefined
  updatedAt: number
}

type MutableOrder = { -readonly [K in keyof RunOrder]: RunOrder[K] }

function toDoc(run: RunProgress): RunDoc {
  return {
    _id: run.id,
    tag: run.tag,
    mode: run.mode,
    style: run.style,
    bookPrint: run.bookPrint,
    state: run.state,
    ...(run.haltReason === undefined ? {} : { haltReason: run.haltReason }),
    orders: run.orders.map((o) => ({ ...o })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

/**
 * Closes before opens, whatever order the caller's array arrived in.
 *
 * `resolveOrders` already emits them this way, and this is not a distrust of it:
 * the clientOrderIds below are POSITIONAL, so the execution order is part of
 * this module's own contract and must not be something a caller could change by
 * handing over a differently sorted array.
 */
function inWaveOrder(orders: readonly PlannedOrder[]): readonly PlannedOrder[] {
  return [...orders.filter((o) => o.wave === 'close'), ...orders.filter((o) => o.wave === 'open')]
}

/**
 * ONE sentence for "this book is busy", wherever it is decided.
 *
 * The courtesy scan and the index's own refusal are two code paths reaching the
 * same fact, and the operator must not be able to tell which one answered —
 * two wordings would read as two different problems.
 */
function refusal(tag: string, owner: string | undefined): string {
  return (
    `another repair is already running on ${tag}` +
    `${owner === undefined ? '' : ` (applyId ${owner})`} — one run per book at a time, so this ` +
    `plan is refused rather than interleaved with it`
  )
}

/** The id AND what it was for — a halt reason has to name both to be actionable. */
function describe(o: MutableOrder): string {
  return `${o.clientOrderId} (${o.planned.side} ${o.planned.lots} ${o.planned.instrument.tradingsymbol})`
}

const sleep = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export class RepairApplyService {
  readonly #d: RepairApplyDeps
  /**
   * Read ONCE, through `marketable.ts`'s single env reader — the third and last
   * construction site, and deliberately that reader rather than a fourth set of
   * `process.env` lookups to drift out of step with the other two.
   *
   * The TICK is overridden per order from the contract's own: the env dial is a
   * desk-wide default, and a price rounded onto a grid the contract does not
   * trade on is one the exchange rejects.
   */
  readonly #marketable: MarketableConfig = marketableFromEnv()

  constructor(deps: RepairApplyDeps) {
    this.#d = deps
  }

  #runs(): Collection<RunDoc> {
    return this.#d.db.collection<RunDoc>(COLLECTIONS.repairApplies)
  }

  /**
   * Claim the run and hand back immediately — the execution is DETACHED.
   *
   * The modal's Confirm must answer in one round trip; a run is two waves and
   * up to ten minutes of fill watching. So the HTTP response is "the run
   * exists, here is its id", and the modal polls `status` from there. That the
   * document exists before this returns is what makes the polling safe: there
   * is no window in which the caller has an applyId that resolves to nothing.
   */
  async start(req: {
    tag: string
    mode: DeskMode
    style: 'fast' | 'limit'
    bookPrint: string
    applyId: string
    orders: readonly PlannedOrder[]
  }): Promise<{ ok: true; run: RunDoc } | { ok: false; reason: string }> {
    /**
     * REPLAY FIRST.
     *
     * A caller whose 202 went missing retries under the SAME applyId, and its
     * own RUNNING run must not be read as somebody else's. Answering with the
     * existing document is the whole-run twin of `submit`'s replay: the same id
     * executes once, however many times it is asked for.
     */
    const claimed = await this.#runs().findOne({ _id: req.applyId })
    if (claimed !== null) return { ok: true, run: claimed }

    const now = this.#d.now()

    /**
     * A COURTESY REFUSAL, NOT THE CLAIM. The claim is the index below.
     *
     * This scan cannot be trusted to keep two runs off one book — that is
     * exactly the race the index exists for, and no amount of reading before
     * writing closes it. What it does buy is the ORDINARY case: an operator
     * clicking Apply while their own run is going gets a plain refusal naming
     * the run, rather than one derived from a duplicate-key error.
     *
     * It can only ever REFUSE. Anything it lets through still has to get past
     * the index, so a stale answer here costs nothing.
     */
    const running = (await this.#liveOnTag(req.tag, now))[0]
    if (running !== undefined && req.orders.length > 0) {
      return { ok: false, reason: refusal(req.tag, running._id) }
    }

    const ordered = inWaveOrder(req.orders)
    const run: RunProgress = {
      id: req.applyId,
      tag: req.tag,
      mode: req.mode,
      style: req.style,
      bookPrint: req.bookPrint,
      createdAt: now,
      updatedAt: now,
      // An empty plan is DONE on arrival rather than a run that holds the tag
      // while it waits for nothing.
      state: ordered.length === 0 ? 'DONE' : 'RUNNING',
      haltReason: undefined,
      orders: ordered.map((planned, i) => ({
        clientOrderId: `repair:${req.applyId}:${i}`,
        wave: planned.wave,
        planned,
        status: 'QUEUED',
      })),
    }

    /**
     * THE INSERT IS THE CLAIM — of the applyId AND of the tag.
     *
     * Two unique indexes stand behind this one write. `_id` makes the applyId
     * idempotent. `{tag}` UNIQUE filtered to `state: 'RUNNING'`
     * (`store.ts:ensureIndexes`) makes the BOOK exclusive, and it has to be an
     * index rather than a check: a read of "is anything running on this tag?"
     * followed by an insert has an await in the middle, so two applies on one
     * book under different applyIds both read "no" and both write. Comparing
     * afterwards cannot repair that — whichever run inserts last may be the one
     * that read first — so the second insert is refused by the database or it
     * is not refused at all.
     *
     * An EMPTY plan inserts as DONE, outside the partial filter, so it claims
     * nothing and conflicts with nothing. There is no book to protect.
     */
    const conflict = await this.#insertClaim(run, now)
    if (conflict !== null) return conflict

    this.#d.log('repair run started', {
      applyId: run.id,
      tag: run.tag,
      mode: run.mode,
      style: run.style,
      orders: run.orders.length,
    })
    // `.catch` on top of `#execute`'s own catch-all: an unhandled rejection
    // from a detached promise takes the whole bridge down, and every order this
    // process is watching with it.
    if (run.state === 'RUNNING') void this.#execute(run).catch(() => undefined)
    return { ok: true, run: toDoc(run) }
  }

  async #liveOnTag(tag: string, nowMs: number): Promise<RunDoc[]> {
    return await liveOnTag(this.#runs(), tag, nowMs)
  }

  /**
   * Write the claim, and translate a refusal into the answer it deserves.
   *
   * Null means the run is ours. A duplicate key is one of exactly two things
   * and they get opposite answers:
   *
   *  - the SAME applyId — a replay whose first attempt landed after our read.
   *    The winner's document is the honest answer, and it is `ok: true`: that
   *    run exists and the caller should poll it.
   *  - the TAG — a different repair owns this book. `ok: false`, because
   *    nothing was claimed and nothing will run under this applyId.
   *
   * A STRANDED claim is REAPED rather than worked around. The index does not
   * know about the hold window, so a RUNNING row left behind by a dead process
   * would lock its book out of repair forever — the failure this service
   * already refuses to have (`isLive`). Halting it releases the index in the
   * same write, and the insert is retried exactly ONCE: if it fails again, a
   * live run genuinely won the race in between.
   */
  async #insertClaim(
    run: RunProgress,
    nowMs: number,
  ): Promise<{ ok: true; run: RunDoc } | { ok: false; reason: string } | null> {
    try {
      await this.#runs().insertOne(toDoc(run))
      return null
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
    }

    const sameId = await this.#runs().findOne({ _id: run.id })
    if (sameId !== null) return { ok: true, run: sameId }

    if (await this.#reapStranded(run.tag, nowMs)) {
      try {
        await this.#runs().insertOne(toDoc(run))
        return null
      } catch (err) {
        if (!isDuplicateKey(err)) throw err
      }
    }

    // Named when it can be, because "which repair?" is the operator's next
    // question and the answer is one read away.
    const owner = (await this.#liveOnTag(run.tag, nowMs))[0]
    return { ok: false, reason: refusal(run.tag, owner?._id) }
  }

  /** Halt every RUNNING row on the tag that is past its hold window. */
  async #reapStranded(tag: string, nowMs: number): Promise<boolean> {
    const rows = await this.#runs().find({ tag, state: 'RUNNING' }).toArray()
    let reaped = false
    for (const row of rows) {
      if (isLive(row, nowMs)) continue
      await this.#runs().updateOne(
        { _id: row._id, state: 'RUNNING' },
        {
          $set: {
            state: 'HALTED',
            haltReason:
              'aged out of its hold window — the process running it never reported back, so the ' +
              'claim on this book was released. Whatever it placed is in the ledger below.',
            updatedAt: nowMs,
          },
        },
      )
      this.#d.log('stranded repair claim reaped', { applyId: row._id, tag })
      reaped = true
    }
    return reaped
  }

  async status(applyId: string): Promise<RunDoc | null> {
    return await this.#runs().findOne({ _id: applyId })
  }

  /**
   * The tag's hold, if it has one — the SAME read `repairHoldLookup` performs,
   * down to which query it makes. Two spellings of "is this book held" is how
   * the button and the supervisor end up disagreeing.
   *
   * It THROWS when the store cannot be read, and that is the contract: every
   * caller turns this into a hold, and a swallowed error would turn "we cannot
   * tell" into "nothing is running" on the one screen that places orders.
   */
  async activeHold(tag: string): Promise<RepairHold | null> {
    return await holdFor(this.#runs(), tag, this.#d.now())
  }

  /**
   * No run survives a restart (spec §6.1).
   *
   * The execution loop is in-memory: a restarted process has no idea which
   * orders it had already placed, and re-running a wave would double them.
   * Resuming from the document would mean re-deriving that from the rails, and
   * a wrong answer there places real orders. So every RUNNING run is halted,
   * every hold released, and the operator finishes the plan by hand — which is
   * a worse morning than a resume and a far better one than a doubled book.
   */
  async haltStaleRunsOnBoot(): Promise<void> {
    const stale = await this.#runs().find({ state: 'RUNNING' }).toArray()
    for (const run of stale) {
      await this.#runs().updateOne(
        { _id: run._id, state: 'RUNNING' },
        {
          $set: {
            state: 'HALTED',
            haltReason:
              'restart — desk-api restarted while this run was in flight. Nothing is resumed; ' +
              'the ledger below is what it had reached, and the rest is by hand.',
            updatedAt: this.#d.now(),
          },
        },
      )
      this.#d.log('repair run HALTED by restart', { applyId: run._id, tag: run.tag })
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * The waves, in order, each one gated on the last having actually filled.
   *
   * Every step answers false rather than throwing, because a halt is a
   * RECORDED outcome and not an error: the ledger it leaves behind is the whole
   * value of the run to the operator reading the modal afterwards.
   */
  async #execute(run: RunProgress): Promise<void> {
    try {
      for (const wave of ['close', 'open'] as const) {
        const orders = run.orders.filter((o) => o.wave === wave)
        if (orders.length === 0) continue
        /**
         * THE DEADLINE IS CHECKED BEFORE A WAVE IS PLACED, not only while one
         * is being watched. A close wave that finishes filling one millisecond
         * inside the hold window would otherwise fire a whole open wave outside
         * it — orders going to the broker at the moment the supervisor is told
         * the book is its own again.
         */
        if (this.#d.now() - run.createdAt > REPAIR_HOLD_MS) {
          await this.#halt(
            run,
            `the run reached its hold window of ${REPAIR_HOLD_MS}ms before the ${wave} wave was ` +
              `placed — the book is released back to its supervisor, so the ${wave} wave is not ` +
              `sent at all. Finish by hand.`,
          )
          return
        }
        if (!(await this.#placeWave(run, wave, orders))) return
        if (!(await this.#awaitWave(run, wave, orders))) return
      }
      run.state = 'DONE'
      if (!(await this.#save(run))) return
      this.#d.log('repair run DONE', { applyId: run.id, tag: run.tag })
    } catch (err) {
      // The loop above owns every expected failure, so reaching here means
      // something unforeseen — a Mongo write, a rail that threw. The run must
      // still stop being RUNNING, or the tag stays held until the TTL.
      await this.#halt(run, `the run could not continue: ${errorMessage(err)}`)
    }
  }

  /**
   * Price the WHOLE wave first, then submit it.
   *
   * Both halves happen inside milliseconds, so the prices are still submit-time
   * prices; what the split buys is that a contract with no quote stops the wave
   * BEFORE any of it is at the broker, rather than half way through. A wave
   * that has not started is the cheapest place a run can halt — nothing to
   * finish by hand, nothing to reconcile.
   */
  async #placeWave(
    run: RunProgress,
    wave: 'close' | 'open',
    orders: readonly MutableOrder[],
  ): Promise<boolean> {
    const priced: { order: MutableOrder; limitPrice: number }[] = []
    for (const order of orders) {
      const quote = this.#d.quote(order.planned.instrument.tradingsymbol)
      const limitPrice = quote === null ? null : limitFor(order.planned, run.style, quote, this.#marketable)
      if (limitPrice === null) {
        order.status = 'FAILED'
        order.detail = 'no quote to price it off'
        await this.#halt(
          run,
          `no quote for ${order.planned.instrument.tradingsymbol} — the ${wave} wave is halted ` +
            `before ${describe(order)} was placed, rather than priced off a guess`,
        )
        return false
      }
      priced.push({ order, limitPrice })
    }

    for (const { order, limitPrice } of priced) {
      let res: SubmitResponse
      try {
        res = await this.#d.rail.submit(this.#request(run, order, limitPrice))
      } catch (err) {
        /**
         * A THROW IS NOT A REFUSAL. `submit` answers a refusal in the body and
         * throws only when something broke around it — a Mongo write, an
         * UnknownStrategy, a socket. By then the claim may be written and the
         * order may be at the broker, so calling this "never sent" is the one
         * reading that talks the operator into placing it a second time.
         */
        order.status = 'FAILED'
        order.detail = `${UNKNOWN_OUTCOME} (${errorMessage(err)})`
        await this.#halt(run, `${describe(order)} — ${order.detail}`)
        return false
      }
      if (!res.accepted) {
        // An INDETERMINATE reply is the same fact in the body rather than in a
        // throw: `submit`'s claim exists and its outcome is unknown, and its
        // own header says in as many words not to book a position from it.
        const indeterminate = res.status === 'ROUTING'
        order.status = 'FAILED'
        order.detail = indeterminate ? `${UNKNOWN_OUTCOME}: ${res.reason}` : res.reason
        await this.#halt(
          run,
          indeterminate
            ? `${describe(order)} — ${order.detail}`
            : `${describe(order)} was refused: ${res.reason}`,
        )
        return false
      }
      /**
       * A PARTIAL IS A FAILURE OF THE PLAN, not a smaller version of it.
       *
       * `accepted: true, status: 'FAILED'` means some tranches routed and some
       * did not (`submit.ts`'s state matrix), so the book moves by a size
       * nobody chose and the rest of the plan is sized against a leg that is
       * not there. It stops here with the routed size named, which is exactly
       * what the operator needs to finish it.
       */
      if (res.status !== 'DONE' || res.routedLots !== order.planned.lots) {
        order.status = 'FAILED'
        order.detail = `only ${res.routedLots} of ${order.planned.lots} lots reached the rail`
        await this.#halt(run, `${describe(order)} routed PARTIALLY: ${order.detail}`)
        return false
      }
      order.status = 'SUBMITTED'
    }
    return await this.#save(run)
  }

  /**
   * Watch this wave until every order in it has FILLED — the gate the next wave
   * waits on.
   *
   * TWO DEADLINES, and both are needed. `maxWaveMs` is the gateway's own order
   * max age — past it these orders have aged out at the broker too, so waiting
   * on them is waiting on nothing. `REPAIR_HOLD_MS` bounds the WHOLE run,
   * because each wave restarts the first clock and two full waves would carry
   * the run past the hold it set: the Python driver would resume managing the
   * book while this one still had orders live on it. Whichever line is crossed
   * first ends the run.
   */
  async #awaitWave(
    run: RunProgress,
    wave: 'close' | 'open',
    orders: readonly MutableOrder[],
  ): Promise<boolean> {
    const startedAt = this.#d.now()
    const maxWaveMs = this.#d.maxWaveMs ?? DEFAULT_MAX_WAVE_MS
    for (;;) {
      let changed = false
      const pending: string[] = []
      for (const order of orders) {
        if (order.status !== 'SUBMITTED') continue
        const state = await this.#d.fillState(run.mode, order.clientOrderId)
        if (state === 'FILLED') {
          order.status = 'FILLED'
          changed = true
          continue
        }
        if (state === 'FAILED') {
          order.status = 'FAILED'
          order.detail = 'the rail reports it did not fill'
          await this.#halt(run, `${describe(order)} did not fill — the ${wave} wave is halted here`)
          return false
        }
        pending.push(order.clientOrderId)
      }
      // Persisted only on a transition: the modal polls this document, and a
      // write per poll would be a Mongo round trip every `pollMs` per run for
      // nothing new to read.
      if (changed && !(await this.#save(run))) return false
      if (pending.length === 0) return true
      const nowMs = this.#d.now()
      if (nowMs - run.createdAt > REPAIR_HOLD_MS) {
        await this.#halt(
          run,
          `the run exceeded its hold window of ${REPAIR_HOLD_MS}ms — finish by hand. The book is ` +
            `released back to its supervisor now, so nothing further is placed from here. ` +
            `Still unfilled: ${pending.join(', ')}.`,
        )
        return false
      }
      if (nowMs - startedAt > maxWaveMs) {
        await this.#halt(
          run,
          `the ${wave} wave aged out waiting on fills after ${maxWaveMs}ms — still unfilled: ` +
            `${pending.join(', ')}. Nothing later was placed.`,
        )
        return false
      }
      await sleep(this.#d.pollMs ?? DEFAULT_POLL_MS)
    }
  }

  /**
   * The order as the rail receives it. Every flag here is load-bearing:
   *
   *  - `origin: 'repair'` rides the fold onto the book leg, and is what tells
   *    the Python driver to adopt it BOT-MANAGED rather than leave it standing
   *    as a manual leg nothing manages.
   *  - `exactLots: true` — the plan's size is derived from the book's own legs.
   *    A `liveLots` override would resize half a shift and leave the other half
   *    at the size it was planned at.
   *  - an explicit `LIMIT` with a price, never `resting`: a resting fill never
   *    folds into the book (`submit.ts`'s F12 gap), and a leg the book does not
   *    hold is a leg the driver cannot adopt.
   *  - `reducesExposure` exactly as the plan derived it — true for every close,
   *    which is what carries the close wave past a raised kill switch.
   *  - `fillDeskTag`, on a CLOSE only: the id of the driver's leg this order
   *    takes off. It rides onto the journal fill's `deskTag`, which is the
   *    equality `absorb_bridge_closes` books the leg's realized P&L on — without
   *    it a repair's profit is dropped with "P&L is NOT booked". See
   *    `repair-plan.ts:PlannedOrder.deskTag`.
   */
  #request(run: RunProgress, order: MutableOrder, limitPrice: number): SubmitRequestBody {
    const planned = order.planned
    return {
      tag: run.tag,
      mode: run.mode,
      clientOrderId: order.clientOrderId,
      instrument: {
        tradingsymbol: planned.instrument.tradingsymbol,
        instrumentToken: planned.instrument.instrumentToken,
        lotSize: planned.instrument.lotSize,
        tickSize: planned.instrument.tickSize,
        exchange: planned.instrument.exchange,
      },
      side: planned.side,
      lots: planned.lots,
      orderType: 'LIMIT',
      limitPrice,
      reducesExposure: planned.reducesExposure,
      exactLots: true,
      origin: 'repair',
      // `exactOptionalPropertyTypes`: an absent key, never an explicit
      // undefined — and absent is exactly what an OPEN carries, since it closes
      // no leg and its fill mints the new one's identity.
      ...(planned.deskTag === undefined ? {} : { fillDeskTag: planned.deskTag }),
    }
  }

  async #halt(run: RunProgress, reason: string): Promise<void> {
    run.state = 'HALTED'
    run.haltReason = reason
    this.#d.log('repair run HALTED', { applyId: run.id, tag: run.tag, reason })
    try {
      await this.#save(run)
    } catch (err) {
      // The hold's TTL is the backstop for exactly this: a halt that cannot be
      // written leaves a RUNNING document, and ten minutes later it stops
      // holding the book whatever happened here.
      this.#d.log('repair run halt could not be written — the TTL will release the hold', {
        applyId: run.id,
        error: errorMessage(err),
      })
    }
  }

  /**
   * Persist the ledger, and answer whether this executor STILL OWNS the run.
   *
   * The filter carries `state: 'RUNNING'` for one reason: the progress saves
   * write `state: 'RUNNING'` back, and on `{_id}` alone they would write it
   * over a document that `haltStaleRunsOnBoot` — or an operator — had just
   * moved to HALTED. A halt that un-halts itself a poll later is a book
   * everyone has stopped watching while the orders keep going out.
   *
   * So a miss is not a failed write, it is a VERDICT: someone else ended this
   * run. The callers stop where they are rather than continuing to place
   * orders under a document that no longer says they may.
   */
  async #save(run: RunProgress): Promise<boolean> {
    run.updatedAt = this.#d.now()
    const outcome = await this.#runs().updateOne(
      { _id: run.id, state: 'RUNNING' },
      {
        $set: {
          state: run.state,
          ...(run.haltReason === undefined ? {} : { haltReason: run.haltReason }),
          orders: run.orders.map((o) => ({ ...o })),
          updatedAt: run.updatedAt,
        },
      },
    )
    /**
     * ABSENT `matchedCount` COUNTS AS A MATCH, which is the opposite of what
     * `DeskStore.clearSeededDisabledReason` does — `(res.matchedCount ?? 0) > 0`,
     * "report false rather than claiming a repair we cannot evidence" — and
     * deliberately so.
     *
     * The two are answering different questions. There, the caller is
     * REPORTING an outcome ("did I repair a row?") and the safe reading of "I
     * cannot evidence it" is `false`. Here the boolean is a GUARD on whether to
     * keep placing orders, and reading a silence as "you no longer own this
     * run" would stand the executor down between the close wave and the open
     * wave — closes at the broker, opens never sent, which is the worst state
     * this module can produce. `DeskStore.saveBook` makes the same call for the
     * same reason on the book's own compare-and-set: "Undefined means a fake
     * that does not model it — treated as matched, since the in-memory fakes
     * are single-threaded by construction." Driver 3.7.3 always reports it, so
     * in production this branch is unreachable.
     */
    if (outcome.matchedCount !== 0) return true
    /**
     * The state is not ours to write any more — but the LEDGER is still true.
     *
     * These orders reached the broker. Dropping them because the CAS missed
     * would leave the halted document claiming QUEUED for orders that are
     * live, and the modal tells the operator what to finish by hand off
     * exactly that list. So the ledger is written on its own, on `{_id}` alone
     * and touching neither `state` nor `haltReason`: it adds what we know
     * without taking back what whoever ended the run decided.
     */
    try {
      await this.#runs().updateOne(
        { _id: run.id },
        { $set: { orders: run.orders.map((o) => ({ ...o })), updatedAt: run.updatedAt } },
      )
    } catch (err) {
      this.#d.log('repair ledger could not be written onto the ended run', {
        applyId: run.id,
        error: errorMessage(err),
      })
    }
    this.#d.log('repair run was ended by someone else — this executor stands down', {
      applyId: run.id,
      tag: run.tag,
    })
    return false
  }
}
