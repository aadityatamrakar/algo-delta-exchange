/**
 * The order chaser — a resting LIVE order is repriced at the broker until it
 * crosses, escalating each attempt.
 *
 * THE DEFECT (2026-08-18): a marketable limit is priced ONCE, at submit. On a
 * fast tape the touch has moved by the time the order reaches the exchange, the
 * limit lands on the wrong side of it, and the order rests — a NIFTY option
 * sell sat unfilled for five minutes and the trade was missed. The broker-sweep
 * alert (F-17) told a human; nothing ACTED.
 *
 * WHY THIS IS NOT PART OF `broker-sweep.ts`. The sweep's covenant is stated in
 * its own header: IT PLACES, MODIFIES AND CANCELS NOTHING — it is the
 * instrument that tells the desk what is true, and an instrument that also
 * acts changes what it is measuring. This file is the deliberate opposite: it
 * exists to act. Keeping the two apart keeps the sweep's covenant checkable at
 * a glance, and gives the acting component its own kill switch
 * (`DESK_CHASE_DISABLED=1`) that cannot take the measuring one down with it.
 *
 * TWO WAYS TO WORK AN ORDER, AND THE DOCUMENT SAYS WHICH.
 *
 *   `workMode: 'passive'`  -> PEG MODE (below). Join the touch, follow it,
 *                             cross once at the deadline.
 *   anything else          -> the BLIND LADDER (this section). Unchanged.
 *
 * NO MARKET DATA IN THE BLIND LADDER, BY DESIGN. `desk-marks` is a
 * display-only snapshot whose stated invariant is that the order path never
 * reads it (apps/marketdata/src/main.ts) — and the moment a chaser is most
 * needed is exactly when the feed is dead, because a stale mark is how the
 * limit was mispriced in the first place. So the escalation is BLIND, off the
 * ORIGINAL limit price: attempt k (1-based) moves the price
 *
 *     k x max(stepPct x limit, minTicks x tick)
 *
 * through the original limit — down for a sell, up for a buy — with the same
 * arithmetic discipline as `apps/api/src/marketable.ts`: directional rounding
 * to the tick grid (sell floor, buy ceil), a one-tick clamp on sells, and a
 * re-round of the float product. OVERSHOOT IS SAFE: a limit pushed past the
 * touch fills AT the touch, never at the limit, so the limit remains the
 * worst-case bound — just k steps wider than the one chosen at submit.
 *
 * WHAT IT ACTS ON: `desk-gateway-orders` docs still `PLACED` past
 * `DESK_CHASE_AFTER_MS`, and ONLY those that went out as LIMIT with a known
 * `limitPrice` and side — a MARKET or unpriced doc has nothing to escalate
 * from. Each live (non-terminal) brokerOrderId on the doc is repriced via
 * `adapter.modifyOrder`, which restates the order from its OWN broker row and
 * moves only the price (xts.ts): a PARTIALLY_FILLED order keeps its total
 * quantity, so its remainder is repriced with the size untouched.
 * A tranche already FILLED / CANCELLED / REJECTED / EXPIRED — or CANCELLING —
 * is skipped by its own fills record.
 *
 * CANCEL WINS. A pending row in `desk-broker-cancels` for any of the doc's
 * broker ids suppresses the chase entirely: cancelling and chasing the same
 * order are contradictory intents, and the cancel is the human's.
 *
 * ONE RUNG PER DWELL. The timer fires every ~5s but the ladder is not a
 * per-tick ladder: EACH price gets a full `DESK_CHASE_AFTER_MS` to work before
 * the next one is sent. The dwell is measured from the last thing that moved
 * the price — `max(placedAt, chasedAt)` — so the submit price and every
 * escalated price are given the same chance to fill. Gating on `placedAt`
 * alone would spend the whole ladder in three consecutive ticks (t+15/20/25s),
 * which is not a chase but a market order paid for in three instalments.
 *
 * ORDERS OLDER THAN THIS PROCESS ARE LEFT ALONE. `bootedAt` is stamped at
 * construction and any doc placed before it is skipped — see the gate in
 * `chaseOne` for why a deploy is the one moment this component is dangerous.
 *
 * THE ATTEMPT COUNTER ADVANCES ONLY ON A MODIFY THE BROKER ACCEPTED. A refusal
 * or a transport error is logged and retried on the next tick at the SAME
 * rung; counting it would burn the bounded ladder on attempts that never
 * reached the exchange. After `DESK_CHASE_MAX_ATTEMPTS` accepted reprices the
 * doc is stamped `chaseExhaustedAt` once and ONE loud event goes to the
 * failures feed — from there it is a human's order again.
 *
 * ------------------------------------------------------------------------
 * PEG MODE (2026-08-21) — `workMode: 'passive'`.
 *
 * THE DEFECT IT PREVENTS: every desk action crossing the spread. The blind
 * ladder is a good answer to "this order must fill" and the wrong answer to
 * "this order should fill well" — it escalates THROUGH the touch by
 * construction, so a book that recentres a dozen times a session pays the
 * spread a dozen times, on both legs, for orders nobody was in a hurry to
 * fill. The supervisor now says which kind an order is (`workMode`, see
 * `packages/desk-engine/src/contract.ts:45`); passive is the default and this
 * is what works it.
 *
 * A passive order JOINS the touch — a sell rests at the best ask, a buy at
 * the best bid — and follows it by the same ATOMIC `modifyOrder` the blind
 * ladder uses (never cancel+replace, which races a fill). Three restraints
 * make that safe:
 *
 *   1. ONE TICK, ONE DWELL. The order moves only when the joined price is a
 *      full tick away from where it rests AND `DESK_PEG_DWELL_MS` has passed
 *      since the last accepted reprice. A modify per flicker is a broker
 *      rate-limit incident, not a chase.
 *   2. A WORST-PRICE BOUND. The peg never rests worse than the original limit
 *      ± `chase_cross_buffer_pct`, so an order does not follow a collapsing
 *      book down. Past the bound it stops moving and waits — the desk's own
 *      price is the floor under a passive sell.
 *   3. A STALE TOUCH PAUSES IT. `quotes.touch()` answers null past
 *      `DESK_PEG_QUOTE_MAX_AGE_MS`, and null means DO NOTHING: no modify, no
 *      attempt consumed, no fallback to the blind ladder. Guessing off an old
 *      book is the original defect wearing a new hat, and a passive order that
 *      cannot see the market resting untouched is the correct failure — the
 *      broker sweep's WORKING alert (F-17) still names it for a human.
 *
 * CROSSING IS THE LAST RESORT, NEVER THE FIRST. After `chase_max_ms` from
 * placement (doc field `chaseMaxMs`) the order crosses ONCE, priced off the
 * far side of the touch through `chase_cross_buffer_pct` — a reach, not a
 * price given away, since a limit past the touch fills AT the touch. That
 * single cross is stamped (`pegCrossedAt`) so no pass can send a second, and
 * once it has had its dwell to fill the doc is handed to a human by the same
 * `exhaust()` the blind ladder ends at.
 *
 * WHY THIS READS MARKET DATA WHEN THE SECTION ABOVE REFUSES TO: it reads the
 * gateway's OWN live subscription (`quote-map.ts`), not a persisted snapshot,
 * and it treats absence as a reason to stop rather than a reason to improvise.
 * The blind ladder's rule — never price off data that might be old — survives
 * intact: peg mode does not price off old data, it stops.
 *
 * NEVER REJECTS. It is driven by a `setInterval`, and an unhandled rejection
 * kills the only process that can place orders (the G4 lesson, again).
 */

import type { BrokerAdapter } from '@algomaker/brokers'
import { isTerminalStatus } from './gateway.ts'
import { orderMode, type OrderEvent, type OrderJournal } from './journal.ts'
import type { QuoteMap, Touch } from './quote-map.ts'

/** How long an order may rest PLACED before the first reprice. */
export const DEFAULT_CHASE_AFTER_MS = 15_000
/** Fraction of the ORIGINAL limit each attempt escalates by. */
export const DEFAULT_CHASE_STEP_PCT = 0.03
/** Floor on each attempt's step, in ticks — the guarantee the pct can't give a cheap contract. */
export const DEFAULT_CHASE_MIN_TICKS = 2
/** Accepted reprices before the chaser gives the order back to a human. */
export const DEFAULT_CHASE_MAX_ATTEMPTS = 3
/**
 * PEG MODE: the shortest gap between two re-pegs of the same order.
 *
 * Deliberately far below the blind ladder's dwell. A rung of that ladder is a
 * decision to pay more, and each one earns a full 15s to work; a peg is the
 * same passive intent restated at a price that moved, so the only thing its
 * dwell has to buy is protection from a flickering touch.
 *
 * NOTE: the pass interval (`DESK_CHASE_MS`, 5s) is the real floor on how fast
 * a peg can follow the market. Lower it if pegging needs to be quicker; this
 * dial only decides how much of a pass's opportunity is taken.
 */
export const DEFAULT_PEG_DWELL_MS = 1_000
/**
 * PEG MODE: how long an order works passively before it crosses, when the doc
 * carries no `chaseMaxMs` of its own. The book's `chase_max_ms` dial is the
 * real source (`packages/desk-engine/src/dials.ts`); this is the fallback for
 * a doc written before that field existed.
 */
export const DEFAULT_CHASE_MAX_MS = 30_000
/**
 * PEG MODE: the reach through the touch on the one crossing modify, and the
 * width of the worst-price bound around the original limit. The book's
 * `chase_cross_buffer_pct`; 0.005 is well under the 2% the old marketable
 * limit paid.
 */
export const DEFAULT_CROSS_BUFFER_PCT = 0.005
/**
 * NFO options tick. Same fallback as `marketable.ts`, and now only a fallback:
 * `rail.ts:orderDocument` stamps the instrument's own `tickSize` onto the
 * document, so this is what covers a doc written before it started to.
 */
const DEFAULT_TICK = 0.05
/** Most PLACED documents examined per pass. A bound, not a business rule. */
const DEFAULT_MAX_ORDERS = 100
/**
 * How far before the placement's anchor stamp (`createdAt`, or `placedAt` on
 * a document without one) a fill row may be stamped and still be this
 * placement's — see `liveBrokerIds`. `placedAt` is written after the tranche
 * loop, so a fast fill's row legitimately precedes it by milliseconds; the
 * same allowance is kept for `createdAt` so the two anchors read alike.
 */
const PLACEMENT_SKEW_MS = 60_000

/**
 * Is the chaser switched off?
 *
 * FAILS TOWARD OFF: any non-empty value other than an explicit '0'/'false'
 * disables. This is the kill switch on a component that MOVES prices at the
 * broker, and an operator who set `DESK_CHASE_DISABLED=yes` in a hurry must
 * get the off they asked for, not a parse quibble.
 */
export function chaseDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['DESK_CHASE_DISABLED']
  if (raw === undefined || raw.trim() === '') return false
  return raw !== '0' && raw !== 'false'
}

export interface ChaserOptions {
  readonly chaseAfterMs?: number
  readonly stepPct?: number
  readonly minTicks?: number
  readonly maxAttempts?: number
  readonly maxOrders?: number
  /** PEG MODE only. The blind ladder keeps `chaseAfterMs`. */
  readonly pegDwellMs?: number
}

/**
 * The dials, from the environment — NaN-refusing, same shape and reasoning as
 * `clearRequestTtlMs` (apps/runner) and `positiveEnvMs` (main.ts): every
 * comparison against NaN is false, so a typo'd dial would silently disable the
 * control it configures — or, worse here, price every reprice at NaN, which is
 * exactly the malformed order this machinery exists to prevent.
 */
export function chaseDialsFromEnv(env: NodeJS.ProcessEnv = process.env): Required<
  Pick<ChaserOptions, 'chaseAfterMs' | 'stepPct' | 'minTicks' | 'maxAttempts' | 'pegDwellMs'>
> {
  const dial = (name: string, fallback: number, minimum: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= minimum ? n : fallback
  }
  return {
    chaseAfterMs: dial('DESK_CHASE_AFTER_MS', DEFAULT_CHASE_AFTER_MS, 1),
    // Zero is legal for the pct — the tick floor still guarantees a real step,
    // the same reason `marketable.ts` accepts `bufferPct: 0`. Negative is not:
    // it would walk the price AWAY from the touch.
    stepPct: dial('DESK_CHASE_STEP_PCT', DEFAULT_CHASE_STEP_PCT, 0),
    minTicks: dial('DESK_CHASE_MIN_TICKS', DEFAULT_CHASE_MIN_TICKS, 0),
    maxAttempts: Math.floor(dial('DESK_CHASE_MAX_ATTEMPTS', DEFAULT_CHASE_MAX_ATTEMPTS, 1)),
    // Zero is refused, not treated as "as fast as possible": a peg with no
    // dwell sends a modify per pass for as long as the touch jitters.
    pegDwellMs: dial('DESK_PEG_DWELL_MS', DEFAULT_PEG_DWELL_MS, 1),
  }
}

/** Guards against 0.1 + 0.2 style drift pushing a value across a tick line. */
const EPSILON = 1e-9

/**
 * A raw price onto the tick grid, in a stated direction.
 *
 * The three disciplines every price in this file shares, in one place:
 * rounding is DIRECTIONAL (never to-nearest, which would pull a price back
 * across the line the caller chose it on), the result is clamped to one tick
 * (at or below zero is rejected by the broker outright, so the
 * aggressive-but-legal price is the useful one), and the float product is
 * re-rounded — `147 * 0.05` is 7.3500000000000005 in binary floating point,
 * and that is not on any grid.
 *
 * The direction is passed rather than derived from the side because the two
 * modes want OPPOSITE directions for the same side: a blind sell floors (it
 * is reaching down through the touch), a passive sell joining the ask ceils
 * (it must not round itself into a cross).
 */
function toTickGrid(raw: number, dir: 'floor' | 'ceil', tick: number): number {
  const ticks = dir === 'floor' ? Math.floor(raw / tick + EPSILON) : Math.ceil(raw / tick - EPSILON)
  return Math.round(Math.max(ticks, 1) * tick * 100) / 100
}

/** The tick this price moves on: the doc's own when it has one, else NFO's. */
function tickOf(tickSize: number): number {
  return Number.isFinite(tickSize) && tickSize > 0 ? tickSize : DEFAULT_TICK
}

/** A finite, strictly positive price, or null — the shape every input is checked to. */
function usable(v: number): boolean {
  return Number.isFinite(v) && v > 0
}

/**
 * The price attempt `k` goes out at, or null when nothing honest can be
 * derived (no usable limit, or a nonsensical attempt number).
 *
 * Escalates from the ORIGINAL limit every time — not from the previous chase
 * price — so the ladder is deterministic from the doc alone and a missed rung
 * (a refused modify) costs nothing but time.
 *
 * The arithmetic is `marketable.ts:marketableLimit`'s, reimplemented locally
 * rather than imported across apps (nothing in this app imports from apps/api
 * beyond the shared mongo/store helpers, and the order path must not grow a
 * dependency on the bridge to price a reprice):
 *   - the step is `max(pct-of-limit, ticks)` — 3% of a ₹1.50 option is under
 *     one tick and would round away to nothing, leaving the order resting,
 *     which is the exact failure being chased;
 *   - rounding is DIRECTIONAL (sell floor, buy ceil), never to-nearest, which
 *     would pull the price back toward where the order already rests;
 *   - a sell that crosses past zero clamps to one tick — at or below zero is
 *     rejected outright, so the aggressive-but-legal price is the useful one;
 *   - the float product is re-rounded: `147 * 0.05` is 7.3500000000000005 in
 *     binary floating point, and that is not on any grid.
 */
export function chasePrice(
  side: 'BUY' | 'SELL',
  limitPrice: number,
  attempt: number,
  cfg: { readonly stepPct: number; readonly minTicks: number; readonly tickSize: number },
): number | null {
  if (!usable(limitPrice)) return null
  if (!Number.isInteger(attempt) || attempt < 1) return null

  const tick = cfg.tickSize > 0 ? cfg.tickSize : DEFAULT_TICK
  const step = attempt * Math.max(cfg.stepPct * limitPrice, cfg.minTicks * tick)
  const raw = side === 'SELL' ? limitPrice - step : limitPrice + step

  return toTickGrid(raw, side === 'SELL' ? 'floor' : 'ceil', tick)
}

/**
 * PEG MODE: where a passive order rests right now — the touch, bounded.
 *
 * JOINING, not crossing: a sell rests at the best ASK and a buy at the best
 * BID, which is the whole point of working passively. Rounding goes AWAY from
 * the spread (sell up, buy down) so a quote that is somehow off the grid can
 * never round the order into an aggressive price it was not asked for.
 *
 * BOUNDED BY THE DESK'S OWN PRICE. The order never rests worse than
 * `limitPrice ± crossBufferPct x limitPrice`. Without that, a passive sell
 * follows a collapsing offer all the way down — each individual re-peg looks
 * reasonable and the order ends up 10% under the price the desk chose. Past
 * the bound the peg simply stops moving; the deadline is what resolves it.
 *
 * Returns null when the touch or the limit is unusable, which the caller
 * treats exactly like a stale quote: do nothing.
 */
export function pegPrice(
  side: 'BUY' | 'SELL',
  touch: { readonly bid: number; readonly ask: number },
  cfg: { readonly limitPrice: number; readonly crossBufferPct: number; readonly tickSize: number },
): number | null {
  const join = side === 'SELL' ? touch.ask : touch.bid
  if (!usable(join) || !usable(cfg.limitPrice)) return null
  const buffer = Number.isFinite(cfg.crossBufferPct) && cfg.crossBufferPct >= 0 ? cfg.crossBufferPct : 0
  const tick = tickOf(cfg.tickSize)

  if (side === 'SELL') {
    // The bound is a FLOOR under a sell, and it rounds UP so the clamped price
    // is never a paisa below the bound it is enforcing.
    const bound = toTickGrid(cfg.limitPrice * (1 - buffer), 'ceil', tick)
    return Math.max(toTickGrid(join, 'ceil', tick), bound)
  }
  const bound = toTickGrid(cfg.limitPrice * (1 + buffer), 'floor', tick)
  return Math.min(toTickGrid(join, 'floor', tick), bound)
}

/**
 * PEG MODE: the ONE crossing price, at the deadline.
 *
 * Off the FAR side of the touch — a sell crosses to the bid, a buy to the ask
 * — because that is the side an order actually fills against, plus a reach of
 * `crossBufferPct` through it.
 *
 * NOT clamped by `pegPrice`'s worst-price bound, deliberately. The bound
 * governs where an order may REST while it is being worked passively; this is
 * the deliberate decision that the fill now matters more than the tick, and
 * its bound is the book itself — a limit pushed past the touch fills AT the
 * touch, never at the limit. The staleness gate is what keeps that true: a
 * touch this function is never given is a touch it cannot reach through.
 */
export function crossPrice(
  side: 'BUY' | 'SELL',
  touch: { readonly bid: number; readonly ask: number },
  cfg: { readonly crossBufferPct: number; readonly tickSize: number },
): number | null {
  const far = side === 'SELL' ? touch.bid : touch.ask
  if (!usable(far)) return null
  const buffer = Number.isFinite(cfg.crossBufferPct) && cfg.crossBufferPct >= 0 ? cfg.crossBufferPct : 0
  const tick = tickOf(cfg.tickSize)
  return side === 'SELL'
    ? toTickGrid(far * (1 - buffer), 'floor', tick)
    : toTickGrid(far * (1 + buffer), 'ceil', tick)
}

/** The narrow slice of `desk-gateway-orders` this needs. Same port style as broker-sweep.ts. */
export interface ChaserOrdersCollection {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      limit(n: number): { toArray(): Promise<Record<string, unknown>[]> }
    }
  }
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>
}

/** `desk-broker-cancels` and `desk-fills`, read-only, one query shape each. */
export interface ChaserReadCollection {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
}

export interface OrderChaserDeps {
  /**
   * THE ONE ACTING METHOD, plus the flag that says whether it is real.
   *
   * `modifyOrder` is an atomic reprice — preferred over cancel+replace, which
   * races a fill (types.ts `BrokerCapabilities.modify`). An adapter that
   * declares `modify: false` gets no chaser at all: a reprice this component
   * cannot perform atomically is one it must not attempt by other means.
   */
  readonly adapter: Pick<BrokerAdapter, 'modifyOrder' | 'capabilities'>
  readonly orders: ChaserOrdersCollection
  /**
   * WHICH DOCUMENTS THIS CHASER OWNS, merged into its `PLACED` query.
   *
   * `desk-gateway-orders` carries two rails since the engine's paper lifecycle
   * landed (`rail.ts`, `mode: 'paper'`), and a chase is a `modifyOrder` against
   * a BROKER ORDER ID — a paper order's id means nothing to the real broker,
   * and a live order's means nothing to the simulator. So the gateway arms one
   * chaser per rail and each is scoped here.
   *
   * ABSENT MEANS EVERY PLACED DOCUMENT, which is what a single-adapter
   * deployment (simulate mode) wants and is exactly the behaviour this
   * component has always had.
   */
  readonly ordersFilter?: Record<string, unknown>
  /** Pending human cancels. `_id` IS the AppOrderID — see main.ts `drainCancels`. */
  readonly cancels: ChaserReadCollection
  /** The fill records that say which broker ids are already done. */
  readonly fills: ChaserReadCollection
  readonly journal: Pick<OrderJournal, 'record'>
  /**
   * PEG MODE's only input, and OPTIONAL on purpose.
   *
   * A gateway wired without it (or one whose feed has said nothing about a
   * token) pegs NOTHING — every passive doc pauses, exactly as it does on a
   * stale quote. The failure mode of a missing quote source must be an order
   * that rests, never one that quietly reverts to crossing the spread.
   */
  readonly quotes?: Pick<QuoteMap, 'touch'>
  /** Same double-push caveat as the sweep's: the journal usually notifies already. */
  readonly notify?: (event: OrderEvent) => void
  /**
   * Checked EVERY PASS, not only at wiring — the safe state must be reachable
   * without restarting the only process that can place orders.
   */
  readonly disabled?: () => boolean
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface OrderChaser {
  /** One pass. NEVER REJECTS, never overlaps itself. */
  run(): Promise<void>
  readonly running: boolean
}

export function createOrderChaser(deps: OrderChaserDeps, opts: ChaserOptions = {}): OrderChaser {
  const chaseAfterMs = opts.chaseAfterMs ?? DEFAULT_CHASE_AFTER_MS
  const stepPct = opts.stepPct ?? DEFAULT_CHASE_STEP_PCT
  const minTicks = opts.minTicks ?? DEFAULT_CHASE_MIN_TICKS
  const maxAttempts = opts.maxAttempts ?? DEFAULT_CHASE_MAX_ATTEMPTS
  const maxOrders = opts.maxOrders ?? DEFAULT_MAX_ORDERS
  const pegDwellMs = opts.pegDwellMs ?? DEFAULT_PEG_DWELL_MS
  const disabled = deps.disabled ?? ((): boolean => chaseDisabled())
  /**
   * THIS PROCESS'S BOOT INSTANT — the conservative-rollout line.
   *
   * A doc placed before this component existed cannot carry the `resting` flag
   * that says "the operator chose this price": nothing stamped it. Without
   * that flag every pre-deploy resting LIMIT on the book — target exits, bids
   * left under the market, orders a human is nursing by hand — looks
   * indistinguishable from a mispriced marketable, and the first pass after a
   * restart would drag them all to the touch within seconds of the gateway
   * coming up. Deploys happen mid-session; that is not an acceptable way to
   * find out the chaser is armed.
   *
   * So orders from before this boot keep the OLD behaviour, alert-only: the
   * broker sweep's WORKING alert (F-17) still names them for a human, exactly
   * as it did before this file existed. Nothing is lost, only left as it was.
   */
  const bootedAt = deps.now()
  let running = false
  /**
   * Orders already named as "past the deadline with no touch to cross to".
   *
   * IN MEMORY AND SAID ONCE, the same discipline as `exhaust`'s stamp and the
   * session store's legacy-plaintext notice: the condition is re-evaluated
   * every pass, so logging it every pass would put a line on the console every
   * five seconds per stuck order for as long as a feed outage lasts — the
   * volume that makes an operator stop reading gateway logs. Not persisted:
   * a restart re-saying it once is the correct amount of noise.
   */
  const warnedNoTouch = new Set<string>()

  /**
   * The broker ids on this doc that a reprice can still reach.
   *
   * Decided from OUR OWN fill records, not a broker read: the chaser must work
   * when the feed and the socket are dead, and the fills collection is what
   * the sweep keeps true in exactly that case. A terminal status is absorbing
   * — statuses replay out of order (see `aggregateTranches`), so ANY terminal
   * row for an id retires it, whatever arrived after. CANCELLING retires it
   * too: a cancel is in flight, and cancel wins over chase everywhere here.
   *
   * ONLY A ROW OF THIS PLACEMENT COUNTS. XTS reuses AppOrderIDs across
   * sessions, and `desk-fills` outlives them: a FILLED row two days old under
   * this doc's id belongs to whatever traded under the id back then, and
   * reading it as "done" would leave a live resting order unchased and
   * un-alerted (F6). A row stamped well before this placement began is
   * therefore not this placement's; a row without a `ts`, or a doc without a
   * stamp, is taken at its word — the absent-timestamp rule every reader here
   * shares. The skew is the same minute `FillWatcher` allows an adopted row,
   * for the same reason: a raced row can be stamped a few ms before the doc's
   * stamp lands.
   *
   * THE ANCHOR IS `createdAt`, NOT `placedAt`. `markPlaced` re-stamps
   * `placedAt = now()` on every appended slice (and again on crash recovery),
   * and gated slices are minutes apart by design — so measured from
   * `placedAt`, the first slice's own FILLED row looked like a stranger's the
   * moment the second slice landed more than a minute later, its id stayed
   * "live", and every rung sent a modify against a completed order (`modify
   * REFUSED by broker`, per rung, per pass). `createdAt` is written once,
   * before any slice goes out, so it names the whole placement — the same
   * anchor `FillWatcher.adoptionMismatch` chose for the same reason.
   * `placedAt` remains the fallback for a document that carries no
   * `createdAt`, so a legacy doc keeps the F6 guard rather than losing it.
   */
  const liveBrokerIds = async (
    ids: readonly string[],
    anchor: number,
  ): Promise<readonly string[]> => {
    if (ids.length === 0) return []
    const rows = await deps.fills.find({ brokerOrderId: { $in: [...ids] } }).toArray()
    const done = new Set<string>()
    for (const r of rows) {
      const ts = Number(r['ts'] ?? 0)
      if (ts > 0 && anchor > 0 && ts < anchor - PLACEMENT_SKEW_MS) continue
      const status = String(r['status'] ?? '')
      if (isTerminalStatus(status) || status === 'CANCELLING') {
        done.add(String(r['brokerOrderId'] ?? ''))
      }
    }
    return ids.filter((id) => !done.has(id))
  }

  /**
   * The chase is over; a human is told, ONCE.
   *
   * Journalled BEFORE the stamp, the same order `alertWorking` uses: the alert
   * exists to be noticed, and a crash between the two re-alerts — which is the
   * recoverable error. Stamping first and crashing silences it forever.
   */
  const exhaust = async (doc: Record<string, unknown>, now: number): Promise<void> => {
    const base = String(doc['clientOrderId'] ?? '')
    const symbol = String(doc['tradingsymbol'] ?? '')
    const attempts = Number(doc['chaseAttempts'] ?? 0)
    /**
     * The last price the BROKER ACCEPTED, doc-wide — which is why the alert
     * says so rather than claiming this is where the order rests.
     *
     * THE LADDER IS DOC-LEVEL BY DESIGN: one price for every live tranche, one
     * counter for the doc (see `chaseOne`), because the tranches are one
     * operator order split under the freeze limit and they all rest at the same
     * original limit. The cost of that choice is exactly this: a tranche the
     * broker refused on every pass is still sitting at its ORIGINAL limit while
     * `lastChasePrice` names where its siblings went. Naming the accepted
     * reprice honestly is better than implying a per-tranche ladder this
     * component does not run — the human is about to go look at the order book
     * anyway, and that is where the per-tranche truth lives.
     */
    const lastPrice = Number(doc['lastChasePrice'] ?? doc['limitPrice'] ?? 0)
    const event: OrderEvent = {
      clientOrderId: base,
      phase: 'STATUS',
      ok: false,
      tag: String(doc['tag'] ?? ''),
      tradingsymbol: symbol,
      ts: now,
      mode: orderMode(doc),
      error:
        `${symbol} still resting after ${attempts} reprices ` +
        `(last accepted reprice ${lastPrice}) — ` +
        `cancel it from the Broker page or handle it by hand`,
    }
    await deps.journal.record(event)
    deps.notify?.(event)
    await deps.orders.updateOne({ clientOrderId: base }, { $set: { chaseExhaustedAt: now } })
    deps.log(`CHASE EXHAUSTED ${symbol} [${base}]: ${event.error ?? ''}`)
  }

  /**
   * Send one price to every live tranche of a doc.
   *
   * ONE price for every live tranche — they all rest at the same original
   * limit, so they all move together. Acceptance is counted per PASS, not per
   * id: if the broker takes one of two modifies, that price IS on the wire,
   * and the refused id rejoins at the next one. Returns how many the broker
   * accepted; zero means nothing reached the exchange and NOTHING is stamped.
   */
  const sendPrice = async (
    liveIds: readonly string[],
    price: number,
    base: string,
    what: string,
  ): Promise<number> => {
    let accepted = 0
    for (const brokerOrderId of liveIds) {
      try {
        if (await deps.adapter.modifyOrder(brokerOrderId, price)) {
          accepted++
        } else {
          deps.log(`${what} modify REFUSED by broker`, { brokerOrderId, clientOrderId: base, price })
        }
      } catch (err) {
        // A throw says nothing about whether the modify landed — but a modify
        // is idempotent in a way a placement is not (the worst repeat is the
        // same price again), so retrying next pass is safe.
        deps.log(`${what} modify threw`, { brokerOrderId, clientOrderId: base, error: String(err) })
      }
    }
    return accepted
  }

  /**
   * One PASSIVE document: join the touch, follow it, cross once at the end.
   *
   * Called only after `chaseOne`'s gates have all passed — young order, cancel
   * pending, exhausted, nothing live, a deliberately `resting` price and a
   * pre-boot doc are all already handled there, identically for both modes.
   */
  const pegOne = async (
    doc: Record<string, unknown>,
    side: 'BUY' | 'SELL',
    limitPrice: number,
    liveIds: readonly string[],
    now: number,
  ): Promise<void> => {
    const base = String(doc['clientOrderId'] ?? '')
    const symbol = String(doc['tradingsymbol'] ?? '')
    const tickSize = Number(doc['tickSize'] ?? 0)
    const tick = tickOf(tickSize)
    const rawBuffer = Number(doc['chaseCrossBufferPct'] ?? NaN)
    const crossBufferPct =
      Number.isFinite(rawBuffer) && rawBuffer >= 0 && rawBuffer < 1 ? rawBuffer : DEFAULT_CROSS_BUFFER_PCT
    const rawMaxMs = Number(doc['chaseMaxMs'] ?? NaN)
    const chaseMaxMs = Number.isFinite(rawMaxMs) && rawMaxMs > 0 ? rawMaxMs : DEFAULT_CHASE_MAX_MS

    /**
     * THE CROSS ALREADY WENT. Working is over: the order rests at a crossing
     * price and nothing here will move it again. It is handed to a human once
     * that price has had the same dwell every other price gets — alerting a
     * second after a marketable modify would send somebody after an order that
     * filled while they were reading the message. If it DID fill, the liveness
     * gate in `chaseOne` retires this doc silently before we ever get here.
     */
    const crossedAt = Number(doc['pegCrossedAt'] ?? 0)
    if (Number.isFinite(crossedAt) && crossedAt > 0) {
      if (now - crossedAt <= chaseAfterMs) return
      await exhaust(doc, now)
      return
    }

    /**
     * THE TOUCH, OR NOTHING. No token on the doc, no quote map wired, no tick
     * for this instrument, or a book too old to trust — every one of them is
     * the same answer: pause. No modify, no attempt consumed, and above all no
     * fall-through to the blind ladder, which would cross the spread on the
     * very orders that asked not to.
     */
    const token = Number(doc['instrument_token'] ?? 0)
    const touch: Touch | null =
      Number.isFinite(token) && token > 0 ? (deps.quotes?.touch(token) ?? null) : null
    const pastDeadline = now - Number(doc['placedAt'] ?? 0) >= chaseMaxMs
    if (touch === null) {
      // Silent while there is still time to peg — a gap between ticks is
      // ordinary. Loud ONCE the deadline has come and gone, because a passive
      // order that can never cross is one a human has to know about.
      if (pastDeadline && !warnedNoTouch.has(base)) {
        warnedNoTouch.add(base)
        deps.log(
          `PEG PAUSED ${symbol} [${base}]: deadline reached but the touch is stale — ` +
            `not guessing a crossing price; the working-order alert stands`,
        )
      }
      return
    }

    if (pastDeadline) {
      const price = crossPrice(side, touch, { crossBufferPct, tickSize })
      if (price === null) return
      const accepted = await sendPrice(liveIds, price, base, 'peg cross')
      // Nothing accepted: this was NOT the one cross. Retried next pass.
      if (accepted === 0) return
      await deps.orders.updateOne(
        { clientOrderId: base },
        {
          $inc: { chaseAttempts: 1 },
          // `pegCrossedAt` is what makes it ONE cross: no later pass can send
          // a second at whatever the touch has become by then.
          $set: { chasedAt: now, lastChasePrice: price, pegCrossedAt: now },
        },
      )
      await deps.journal.record({
        clientOrderId: base,
        phase: 'STATUS',
        ok: true,
        tag: String(doc['tag'] ?? ''),
        tradingsymbol: symbol,
        ts: now,
        mode: orderMode(doc),
        detail: {
          note: `peg deadline: crossed to ${price} (touch ${touch.bid}/${touch.ask})`,
          price,
          bid: touch.bid,
          ask: touch.ask,
          crossBufferPct,
          modified: accepted,
          live: liveIds.length,
        },
      })
      deps.log(
        `PEG CROSS ${symbol} [${base}]: worked passively for ${chaseMaxMs}ms, ` +
          `crossed ${accepted}/${liveIds.length} order(s) to ${price} (touch ${touch.bid}/${touch.ask})`,
      )
      return
    }

    const target = pegPrice(side, touch, { limitPrice, crossBufferPct, tickSize })
    if (target === null) return
    /**
     * WHERE IT RESTS NOW — the last price the broker accepted, or the submit
     * price before any peg has landed. A garbled stamp degrades to the limit
     * rather than to NaN, which would compare false against everything and
     * make every pass send a modify.
     */
    const lastAccepted = Number(doc['lastChasePrice'] ?? NaN)
    const restingAt = Number.isFinite(lastAccepted) && lastAccepted > 0 ? lastAccepted : limitPrice
    // A move worth a broker round-trip is a WHOLE tick. Anything less is the
    // touch breathing.
    if (Math.abs(target - restingAt) < tick - EPSILON) return

    const accepted = await sendPrice(liveIds, target, base, 'peg')
    if (accepted === 0) return
    await deps.orders.updateOne(
      { clientOrderId: base },
      { $inc: { chaseAttempts: 1 }, $set: { chasedAt: now, lastChasePrice: target } },
    )
    // Quiet (`ok: true`): following the touch is the order working as
    // designed. The loud line is `exhaust`'s, after the cross.
    await deps.journal.record({
      clientOrderId: base,
      phase: 'STATUS',
      ok: true,
      tag: String(doc['tag'] ?? ''),
      tradingsymbol: symbol,
      ts: now,
      mode: orderMode(doc),
      detail: {
        note: `peg: repriced to ${target} (touch ${touch.bid}/${touch.ask})`,
        price: target,
        from: restingAt,
        bid: touch.bid,
        ask: touch.ask,
        modified: accepted,
        live: liveIds.length,
      },
    })
    deps.log(
      `PEG ${symbol} [${base}]: ${restingAt} -> ${target} on ${accepted}/${liveIds.length} order(s) ` +
        `(touch ${touch.bid}/${touch.ask})`,
    )
  }

  /** One document. Throws are caught by the caller; one bad doc is not a bad pass. */
  const chaseOne = async (
    doc: Record<string, unknown>,
    pendingCancelIds: ReadonlySet<string>,
    now: number,
  ): Promise<void> => {
    const base = String(doc['clientOrderId'] ?? '')
    if (base === '') return

    // An absent `placedAt` is not "infinitely old" — the same rule
    // `isStaleOrder` and the sweep state. A legacy document must not be chased
    // on a timestamp it never had.
    const placedAt = Number(doc['placedAt'] ?? 0)
    if (!Number.isFinite(placedAt) || placedAt <= 0) return

    // CONSERVATIVE ROLLOUT — see `bootedAt`. An order that predates this
    // process could not have been stamped `resting`, so the chaser cannot tell
    // a deliberate target price from a mispriced marketable; it keeps the old
    // alert-only treatment and the sweep's WORKING alert still covers it.
    if (placedAt < bootedAt) return

    /**
     * WHICH MODE WORKS THIS ORDER. The supervisor states it per action
     * (`packages/desk-engine/src/contract.ts:45`); anything that is not
     * exactly 'passive' — absent, 'urgent', or a value from a future version
     * of the contract this build does not know — takes the blind ladder it
     * has always taken. Peg mode is opt-in by name, so an unrecognised value
     * can never leave an order unworked.
     */
    const passive = doc['workMode'] === 'passive'

    /**
     * ONE RUNG PER DWELL. The dwell restarts from the last price that actually
     * went out — the submit price (`placedAt`) until a reprice lands, `chasedAt`
     * after — so every rung of the ladder gets the same full `chaseAfterMs` to
     * fill. Comparing against `placedAt` alone would fire a rung on EVERY tick
     * once the first dwell elapsed, spending a 3-rung ladder in 10 seconds.
     *
     * A garbled `chasedAt` degrades to the placement time rather than to NaN,
     * which every comparison would answer `false` to — i.e. an immediate chase,
     * the very thing the dwell exists to prevent. Same NaN discipline as
     * `chaseDialsFromEnv`.
     */
    const chasedAt = Number(doc['chasedAt'] ?? 0)
    const lastPriceMoved = Math.max(placedAt, Number.isFinite(chasedAt) ? chasedAt : 0)
    // A peg restates a passive intent at a price that moved and gets the short
    // peg dwell; a rung of the blind ladder is a decision to pay more and
    // keeps the full one. Same clock, same gate — only the constant differs.
    if (now - lastPriceMoved <= (passive ? pegDwellMs : chaseAfterMs)) return

    /**
     * ONLY a LIMIT with a known price and side can be chased. A MARKET doc has
     * no ladder to climb (and the broker filled or rejected it long ago); a
     * LIMIT without a stored price gives the escalation nothing honest to
     * escalate FROM — inventing one is how a reprice becomes a mispricing.
     */
    const side = doc['transaction_type']
    if (side !== 'BUY' && side !== 'SELL') return
    if (doc['order_type'] !== 'LIMIT') return
    /**
     * A DELIBERATELY pending order is not stuck — the operator chose that
     * price and wants the order to sit there (a target exit, a bid under the
     * market). Chasing it would drag their price to the touch, which is the
     * opposite of what was asked for. `resting` is stamped by the api's rail
     * from the submit body; see `Fill.resting` in apps/api/src/contract.ts.
     */
    if (doc['resting'] === true) return
    const limitPrice = Number(doc['limitPrice'])
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) return

    const brokerIds = asStrings(doc['brokerOrderIds']).filter((id) => id !== '')
    if (brokerIds.length === 0) return

    // Already handed back to a human; nothing more to say or do.
    if (doc['chaseExhaustedAt'] !== undefined) return

    // CANCEL WINS. A pending cancel on ANY id suppresses the whole doc's chase
    // — repricing tranche 2 while a human cancels tranche 1 is two hands on
    // one order — and suppresses the exhaustion alert too: the human is
    // already doing the thing the alert would ask for.
    const beingCancelled = brokerIds.filter((id) => pendingCancelIds.has(id))
    if (beingCancelled.length > 0) {
      deps.log(
        `CHASE SKIPPED ${String(doc['tradingsymbol'] ?? '')} [${base}]: ` +
          `a cancel is pending for ${beingCancelled.join(', ')} — cancel wins`,
      )
      return
    }

    /**
     * LIVENESS FIRST, EXHAUSTION SECOND — the order matters.
     *
     * Every tranche is terminal in our own records: the fill watcher settles
     * the doc itself, and there is nothing left for a reprice to reach. Asking
     * this BEFORE the ladder check is what keeps a filled-but-not-yet-settled
     * doc from drawing the loud `still resting` alert, which would send a human
     * to the Broker page to cancel an order that no longer exists. A dead doc
     * exits silently; only a doc with something actually resting can exhaust.
     */
    // `createdAt` first — see `liveBrokerIds` on why the per-slice `placedAt`
    // cannot anchor a multi-slice placement. `Number(undefined) || 0` reads
    // an absent stamp as "none", never as NaN.
    const createdAt = Number(doc['createdAt'] ?? 0) || 0
    const liveIds = await liveBrokerIds(brokerIds, createdAt > 0 ? createdAt : placedAt)
    if (liveIds.length === 0) return

    /**
     * PASSIVE ORDERS LEAVE HERE. Everything above is shared — the same dwell,
     * the same cancel-wins, the same liveness, the same deploy gate — and
     * everything below is the blind ladder, which a passive order never
     * enters. In particular it is exempt from the attempt CEILING: following a
     * touch for thirty seconds is the job, not a sign the order is stuck, and
     * its terminal condition is the deadline inside `pegOne`.
     */
    if (passive) {
      await pegOne(doc, side, limitPrice, liveIds, now)
      return
    }

    const attempts = Number(doc['chaseAttempts'] ?? 0)
    if (attempts >= maxAttempts) {
      await exhaust(doc, now)
      return
    }

    // The doc's own tick — `rail.ts:orderDocument` stamps the instrument's,
    // and the NFO default covers documents written before it did.
    const tickSize = Number(doc['tickSize'] ?? 0)
    const price = chasePrice(side, limitPrice, attempts + 1, { stepPct, minTicks, tickSize })
    if (price === null) return

    // ONE price for every live tranche — they all rest at the same original
    // limit, so they all move together, and a refused id rejoins at the next
    // rung. See `sendPrice` for the per-pass acceptance rule.
    const accepted = await sendPrice(liveIds, price, base, 'chase')
    // NOTHING accepted: the counter does not move, and the next tick retries
    // this same rung. Counting refusals would exhaust the ladder on attempts
    // the exchange never saw.
    if (accepted === 0) return

    const attempt = attempts + 1
    await deps.orders.updateOne(
      { clientOrderId: base },
      { $inc: { chaseAttempts: 1 }, $set: { chasedAt: now, lastChasePrice: price } },
    )
    // Quiet (`ok: true`): a reprice working as designed is progress, not an
    // incident. The loud line is `exhaust`'s.
    await deps.journal.record({
      clientOrderId: base,
      phase: 'STATUS',
      ok: true,
      tag: String(doc['tag'] ?? ''),
      tradingsymbol: String(doc['tradingsymbol'] ?? ''),
      ts: now,
      mode: orderMode(doc),
      detail: {
        note: `chase ${attempt}/${maxAttempts}: repriced to ${price}`,
        chaseAttempt: attempt,
        maxAttempts,
        price,
        modified: accepted,
        live: liveIds.length,
      },
    })
    deps.log(
      `CHASE ${String(doc['tradingsymbol'] ?? '')} [${base}]: attempt ${attempt}/${maxAttempts} ` +
        `repriced ${accepted}/${liveIds.length} order(s) to ${price}`,
    )
  }

  return {
    get running(): boolean {
      return running
    },
    async run(): Promise<void> {
      // Single-flight: two passes would climb two rungs off one resting order.
      if (running) return
      running = true
      try {
        if (disabled()) return
        // No atomic modify, no chaser — see `OrderChaserDeps.adapter`.
        if (!deps.adapter.capabilities.modify) return

        const now = deps.now()
        const placed = await deps.orders
          .find({ ...(deps.ordersFilter ?? {}), state: 'PLACED' })
          .sort({ placedAt: 1 })
          .limit(maxOrders)
          .toArray()
        if (placed.length === 0) return

        // One read for the whole pass. If it fails, the pass aborts: with the
        // cancel list unreadable, "cancel wins" cannot be honoured, and a
        // chase that might fight a human's cancel is worse than a 5s delay.
        const pending = await deps.cancels.find({ status: 'pending' }).toArray()
        const pendingCancelIds = new Set(pending.map((c) => String(c['_id'] ?? '')))

        for (const doc of placed) {
          try {
            await chaseOne(doc, pendingCancelIds, now)
          } catch (err) {
            deps.log('chase failed for one order', {
              clientOrderId: String(doc['clientOrderId'] ?? ''),
              error: String(err),
            })
          }
        }
      } catch (err) {
        // The order query or the cancel read failed. The next tick chases
        // again; nothing here is stateful.
        deps.log('order chaser FAILED — will retry on the next tick', { error: String(err) })
      } finally {
        running = false
      }
    },
  }
}

function asStrings(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}
