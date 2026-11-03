/**
 * The PURE half of the order path.
 *
 * Every function here computes a value from its arguments and returns it. None
 * of them awaits, reads a clock, touches a store, routes an order or mutates
 * anything the caller did not hand over. That is the entire contract of this
 * module, and it is what makes it testable directly rather than through a Mongo
 * fixture and a fake rail.
 *
 * Their callers — `BridgeService.applyDecision` and `BridgeService.flattenTag`
 * in `service.ts` — keep ALL of the I/O, the ordering, the record-before-route
 * crash safety and the error handling. The split is deliberate and one-way: a
 * step moves here only when it is a calculation, so reading `service.ts` still
 * shows the whole sequence of side effects in one place, in order.
 *
 * Nothing in here decides anything about trading (D1). It arranges what the
 * desk already decided into the shape the rails and the journal need.
 */

import {
  anyExposureLimitSet,
  checkExposureLimits,
  riskRefusalReason,
  type ExposureLimits,
  type ExposureState,
  type InstrumentRef,
} from '@algomaker/order-bus'
import { applyRoutedFill } from './book.ts'
import type { BridgeLeg, DeskAction, DeskMode, DeskSide, Fill, Skip } from './contract.ts'
import { deriveUnderlying } from '../../order-gateway/src/gateway.ts'
import { marketableLimit, type MarketableConfig } from './marketable.ts'
import { API_VENUE, venueDayRange, type VenueSpec } from './venue.ts'
import { addsExposure, type FlattenLegPlan, type KillSwitchState } from './safety.ts'

/**
 * Derived from the decision id, not random: a replayed decision must produce
 * the SAME ids, so the gateway's unique index recognises it as already-seen
 * rather than placing a duplicate.
 */
export function orderIdFor(decisionId: string, index: number): string {
  return `${decisionId}#${index}`
}

// ------------------------------------------------------- applyDecision

/**
 * GATE 2, as a calculation: which actions the halt lets through, and a skip for
 * each one it does not.
 *
 * The halt blocks NEW EXPOSURE only. Exits, rolls and shrinks stay open, because
 * a control that traps a position is worse than what it protects against —
 * consistent with order-bus/risk.ts:82.
 */
export function splitByKillSwitch(input: {
  readonly halt: KillSwitchState
  readonly actions: readonly DeskAction[]
  readonly book: readonly BridgeLeg[]
}): { readonly permitted: readonly DeskAction[]; readonly haltSkips: readonly Skip[] } {
  const { halt, actions, book } = input
  const permitted = halt.enabled ? actions.filter((a) => !addsExposure(a, book)) : actions
  const haltSkips: Skip[] = halt.enabled
    ? actions
        .filter((a) => addsExposure(a, book))
        .map((action) => ({
          action,
          reason: `kill switch engaged${halt.reason === '' ? '' : ` (${halt.reason})`}; only exposure-reducing actions are allowed`,
        }))
    : []
  return { permitted, haltSkips }
}

/**
 * The size the risk caps measure ONE action in. `null` when it cannot be
 * derived — an unresolvable contract, which `applyActions` refuses for itself
 * with a better reason than a cap could give.
 */
export interface ActionSize {
  readonly lots: number
  /** CONTRACT quantity, for the notional check. */
  readonly quantity: number
  /** Best known price, for the notional check. `null` skips that check only. */
  readonly price: number | null
}

/**
 * GATE 2b, beside the halt: the desk-wide RISK LIMITS (audit F-28).
 *
 * The same rules, the same module and the same governing asymmetry as
 * `submit-plan.ts:screenRiskGate` — the two live rails must not answer
 * differently — so read that function's header for WHY each condition is here.
 * What differs is only the shape: a decision carries N actions, so this returns
 * a permitted/skipped split exactly as `splitByKillSwitch` does above.
 *
 * ONE MEASUREMENT, N ACTIONS, AND THE OPENS ACCUMULATE. The exposure snapshot
 * costs a P&L read, so the caller takes it once; each open this call permits is
 * then added to the running lots before the next is judged. Without that, a
 * decision holding five opens would compare all five against the same starting
 * position and let the whole basket through a cap any one of them fits under.
 *
 * THE RATE WINDOW ACCUMULATES FOR EXACTLY THE SAME REASON, and it is the same
 * defect one field over: the caller records the permitted orders on the rate
 * window only AFTER this returns, so a decision carrying 25 opens compared all
 * 25 against a window that still held zero and walked the whole basket through
 * a 10-per-minute limit. Each open permitted here therefore counts itself into
 * the window before the next is judged — the lot counters' rule, applied to the
 * one snapshot field that was left out of it.
 *
 * `sizeOf` is a callback for the same reason `instrumentForFill` takes one:
 * the lot size lives in the instrument master, and this module does no I/O.
 */
export function splitByRisk(input: {
  readonly mode: DeskMode
  readonly limits: ExposureLimits
  /** `null` = the desk could not be measured; see `screenRiskGate`. */
  readonly exposure: ExposureState | null
  readonly underlying: string
  readonly actions: readonly DeskAction[]
  readonly book: readonly BridgeLeg[]
  readonly sizeOf: (action: DeskAction) => ActionSize | null
}): { readonly permitted: readonly DeskAction[]; readonly riskSkips: readonly Skip[] } {
  // Inert unless this is the live rail AND somebody configured a limit. The
  // identity return matters: with nothing configured this function must be
  // indistinguishable from not being called.
  if (input.mode !== 'live' || !anyExposureLimitSet(input.limits)) {
    return { permitted: input.actions, riskSkips: [] }
  }

  const permitted: DeskAction[] = []
  const riskSkips: Skip[] = []
  let openLotsTotal = input.exposure?.openLotsTotal ?? 0
  const openLotsByUnderlying = { ...(input.exposure?.openLotsByUnderlying ?? {}) }
  const recentOrderTs = [...(input.exposure?.recentOrderTs ?? [])]

  for (const action of input.actions) {
    // Exits, rolls and shrinks are never gated — a limit that traps a position
    // is worse than whatever it was protecting against.
    if (!addsExposure(action, input.book)) {
      permitted.push(action)
      continue
    }
    if (input.exposure === null) {
      riskSkips.push({
        action,
        reason:
          `risk limits: the desk's day P&L and open lots could not be measured, and a limit ` +
          `is configured — refusing new exposure (exits are unaffected)`,
      })
      continue
    }
    const size = input.sizeOf(action)
    const verdict = checkExposureLimits(
      {
        lots: size?.lots ?? 0,
        quantity: size?.quantity ?? 0,
      },
      input.limits,
      {
        ...input.exposure,
        openLotsTotal,
        openLotsByUnderlying,
        recentOrderTs,
        isReducingExposure: false,
        underlying: input.underlying,
        price: size?.price ?? null,
      },
    )
    if (!verdict.allowed) {
      riskSkips.push({ action, reason: riskRefusalReason(verdict.rejection) })
      continue
    }
    permitted.push(action)
    const lots = size?.lots ?? 0
    openLotsTotal += lots
    openLotsByUnderlying[input.underlying] = (openLotsByUnderlying[input.underlying] ?? 0) + lots
    // One permitted open is one order the caller is about to send, so it counts
    // against the rate limit the next one is judged by. Stamped with the
    // measurement's clock — the same `nowMs` `checkExposureLimits` windows on.
    recentOrderTs.push(input.exposure.nowMs)
  }

  return { permitted, riskSkips }
}

/**
 * THE ONE RULE FOR AN ORDER THAT WOULD OTHERWISE GO OUT AS MARKET.
 *
 * **The broker's API rejects market orders.** Every path that emits one emits a
 * rejection, and the shapes that reach here — a supervisor action with no price
 * at all, a `fast` close-all, a `priceExit` that degraded for want of a mark —
 * all arrive as MARKET for different reasons and need the identical answer: a
 * limit priced THROUGH the mark, which executes like a market order and carries
 * a hard worst case. See `marketable.ts`.
 *
 * Three ways the fill comes back UNCHANGED, and none of them is a fallback to
 * MARKET-with-a-guess:
 *
 *   - no `marketable` config — "leave them MARKET", the historical behaviour,
 *     and what every test that does not configure one still gets;
 *   - the fill is already a LIMIT — the caller priced it and that choice wins;
 *   - `marketableLimit` returned null, i.e. the mark is unusable. An invented
 *     price is worse than the rejection it would replace.
 *
 * AN ABSENT `orderType` IS A MARKET ORDER. `rail.ts` sends
 * `fill.orderType ?? 'MARKET'`, so the supervisor's unpriced fills — which
 * carry no `orderType` field at all — are exactly the ones this exists for.
 * Reading "absent" as "not MARKET" would skip them.
 *
 * ONE HELPER, THREE CALLERS: both branches of `priceFillsForRoute` and
 * `flattenTag`'s planned exits. `flattenTag` builds its fills with
 * `plannedFlattenFills` and routes them directly rather than through
 * `priceFillsForRoute`, so a rule that lived only inside that function left the
 * dashboard's Flatten button — on `fast`, the emergency style — as the single
 * path still sending raw MARKET to a rail that refuses it.
 *
 * `expiresToday` SELECTS THE WIDER EXPIRY-DAY BUFFER (`expiryBufferPct`) and
 * changes nothing else — see `marketableLimit`. It defaults to false, so a
 * caller that does not assert expiry day is priced exactly as it always was.
 * Today ONE does, through `priceFillsForRoute`: `applyDecision`, for an engine
 * decision of the delta-lean family on a book whose contract expires today.
 * `flattenTag` does not assert it.
 */
export function marketableFallback(
  fill: Fill,
  marketable: MarketableConfig | undefined,
  expiresToday = false,
): Fill {
  if (marketable === undefined) return fill
  if (fill.orderType !== undefined && fill.orderType !== 'MARKET') return fill
  const limitPrice = marketableLimit(fill.side, fill.price, marketable, expiresToday)
  return limitPrice === null ? fill : { ...fill, orderType: 'LIMIT' as const, limitPrice }
}

/**
 * Price the fills a decision produced, BEFORE they route.
 *
 * Must be applied to the fills rather than to the response: the rail writes its
 * document during the routing loop, so decorating the result afterwards leaves
 * the actual order as MARKET while the API reports LIMIT.
 *
 * Two callers, two rules:
 *
 *   - `pricing` absent — the supervisor's path, whose actions carry no price at
 *     all. Every fill goes through `marketableFallback`, because a MARKET order
 *     is rejected by the broker and a resting limit at the mark may never fill
 *     — and an unfilled hedge is not a hedge.
 *   - `pricing` present — close-all's per-leg plan and the engine endpoint's
 *     per-action one, both keyed by desk tag. A tag it does not name, or names
 *     as MARKET, falls through to the SAME helper, for the same reason: passing
 *     MARKET through made 'fast' — the emergency style — the one path
 *     guaranteed not to fill, while the API reported DONE and the book was
 *     emptied. A tag priced as LIMIT keeps the caller's price.
 *
 * `workMode` RIDES ALONG BOTH BRANCHES, and that is deliberate. It is not a
 * price, so a caller may choose how hard an order works without naming one —
 * and if it were stamped only on the LIMIT branch, a passive order with no
 * price would reach the gateway looking like every other order and be chased
 * across the spread, which is the opposite of what was asked for.
 *
 * THE EXECUTION DIALS RIDE ALONG WITH IT, for the identical reason: the size
 * an order shows the market and how long it works before crossing are not
 * prices either, and an unpriced supervisor action — the MARKET branch, which
 * is most of them — is exactly the one that needs them.
 *
 * `expiresToday` IS THREADED INTO EVERY `marketableFallback` CALL BELOW, both
 * branches: an action the supervisor named in the pricing map as MARKET and one
 * it did not name at all are the same unpriced order, and need the same buffer.
 * A price the caller chose is never touched by it — the wide buffer buys the
 * FILL of an unpriced order, not a different price for a priced one.
 */
export function priceFillsForRoute(
  fills: readonly Fill[],
  pricing:
    | ReadonlyMap<
        string,
        {
          orderType: 'MARKET' | 'LIMIT'
          limitPrice?: number
          workMode?: 'passive' | 'urgent'
          trancheLots?: number
          chaseMaxMs?: number
          chaseCrossBufferPct?: number
        }
      >
    | undefined,
  marketable: MarketableConfig | undefined,
  expiresToday = false,
): readonly Fill[] {
  // The array itself is returned untouched when there is nothing to apply, so
  // "no pricing at all" is identity rather than a copy that merely looks equal.
  if (marketable === undefined && pricing === undefined) return fills
  if (pricing === undefined) {
    return fills.map((f) => marketableFallback(f, marketable, expiresToday))
  }
  return fills.map((f) => {
    const p = pricing.get(f.deskTag)
    // Stamped before the branch, so it survives both. Conditionally spread:
    // `exactOptionalPropertyTypes` makes an explicit `undefined` a different
    // thing from an absent key, and absent is what "nobody chose" must be.
    const carried = {
      ...(p?.workMode === undefined ? {} : { workMode: p.workMode }),
      ...(p?.trancheLots === undefined ? {} : { trancheLots: p.trancheLots }),
      ...(p?.chaseMaxMs === undefined ? {} : { chaseMaxMs: p.chaseMaxMs }),
      ...(p?.chaseCrossBufferPct === undefined
        ? {}
        : { chaseCrossBufferPct: p.chaseCrossBufferPct }),
    }
    // Untouched when there is nothing to carry, so a fill nobody made a
    // decision about is the SAME object rather than a copy that looks equal.
    const fill: Fill = Object.keys(carried).length === 0 ? f : { ...f, ...carried }
    // 'fast' close-all and any leg `priceExit` degraded to MARKET for want of a
    // mark used to go out as MARKET and be refused — the SAME shape, and now
    // the same answer, as an unpriced supervisor action.
    if (p === undefined || p.orderType === 'MARKET') {
      return marketableFallback(fill, marketable, expiresToday)
    }
    return {
      ...fill,
      orderType: p.orderType,
      ...(p.limitPrice === undefined ? {} : { limitPrice: p.limitPrice }),
    }
  })
}

/**
 * The contract a fill routes against, or null when there is none.
 *
 * The fill's desk tag is looked up in the NEW book first and the prior one
 * second, because a close removes the leg from the new book — falling back to
 * the pre-decision book, and then to the instrument master by exchange symbol,
 * is what keeps an exit from being dropped for want of a leg it just closed.
 *
 * `resolveSymbol` is called ONLY when neither book carries the tag, so the
 * master is consulted exactly as rarely as it was before.
 */
export function instrumentForFill(
  fill: Fill,
  nextBook: readonly BridgeLeg[],
  priorBook: readonly BridgeLeg[],
  resolveSymbol: (tradingsymbol: string) => InstrumentRef | null,
): InstrumentRef | null {
  const leg =
    nextBook.find((l) => l.deskTag === fill.deskTag) ??
    priorBook.find((l) => l.deskTag === fill.deskTag)
  return leg?.instrument ?? resolveSymbol(fill.tradingsymbol)
}

/**
 * ONLY WHAT ROUTED becomes the book and the P&L journal.
 *
 * An attempt is not a position. A leg whose route threw — a rail refusal, a
 * Mongo blip, a live tag missing from the allowlist — has no order behind it
 * anywhere, and booking it means every later reader believes in risk that does
 * not exist. The concrete cost is not a wrong report: `close-all` over a phantom
 * leg places a real order in the opposite direction and OPENS a position nobody
 * asked for.
 *
 * `failedTags` comes back beside the fills because the book is recomputed from
 * the same set — see `actionsFullyRouted`.
 */
export function partitionRoutedFills(
  fills: readonly Fill[],
  routeErrors: readonly { readonly fill: Fill; readonly error: string }[],
): { readonly failedTags: ReadonlySet<string>; readonly routedFills: readonly Fill[] } {
  const failedTags = new Set(routeErrors.map((e) => e.fill.deskTag))
  const routedFills = fills.filter((f) => !failedTags.has(f.deskTag))
  return { failedTags, routedFills }
}

/**
 * The actions that FULLY routed — the only ones that may reach the book.
 *
 * An action owns the fills carrying its desk tags (`ts`, and `to_ts` for a
 * roll). If any of its fills failed, the action did not happen and must not
 * appear in the book — a half-applied roll would leave the book claiming a leg
 * at a strike no order ever reached.
 */
export function actionsFullyRouted(
  actions: readonly DeskAction[],
  failedTags: ReadonlySet<string>,
): readonly DeskAction[] {
  return actions.filter((a) => {
    const to = (a as { to_ts?: string }).to_ts
    return !failedTags.has(a.ts) && (to === undefined || !failedTags.has(to))
  })
}

// ----------------------------------------------------------- flattenTag

/** What happened to ONE open contract during a flatten-by-tag. */
export interface FlattenLegResult {
  readonly tradingsymbol: string
  /** The signed net position that was found. Negative is short. */
  readonly positionQty: number
  /** The side that closes it. */
  readonly side: DeskSide
  readonly qty: number
  readonly orderType: 'MARKET' | 'LIMIT'
  readonly limitPrice?: number
  /** True only when an order for this leg actually reached a rail. */
  readonly routed: boolean
  /** Why it did not reach one. Empty when it did. */
  readonly error: string
  /** Why it went out degraded (no mark). Empty when it did not. */
  readonly degraded: string
}

/**
 * The fill window a flatten reconstructs its position from.
 *
 * `loadFills` filters `createdAt < to`, so a fill stamped at exactly `now` needs
 * the window to extend past it. Off-by-one here silently drops the most recent
 * order — which for an intraday strategy is the one that matters most.
 *
 * A whole venue day (IST on NSE, 12:00 UTC to 12:00 UTC on DX) is the right default because hosted strategies are intraday by
 * contract — the runner's own square-off cron is a daily one.
 *
 * A POSITIONAL BOOK DEFAULTS TO EVERY FILL (`positional`): its legs cross
 * sessions, so a day read can start after the opens and before the closes and
 * net to a position never held — TCS on 2026-10-19 sold 675 2400PE to "close"
 * a flat leg. The same window the delete guard and the day guard already give
 * a book. An explicit `sinceMs` still wins.
 */
export function flattenWindow(
  nowMs: number,
  sinceMs?: number,
  positional = false,
  venue: VenueSpec = API_VENUE,
): { readonly from: number; readonly to: number } {
  const from = sinceMs ?? (positional ? 0 : venueDayRange(venue.dayKey(nowMs), venue).from)
  return { from, to: nowMs + 1 }
}

/**
 * Per symbol: did the FIRST fill seen for it actually OPEN the position?
 *
 * This is the truncation guard's only evidence, and `op` alone cannot answer it
 * because `applyActions` stamps BOTH halves of a roll `op: 'roll'` — the buy-back
 * of the old strike and the sale of the new one are indistinguishable by op, by
 * side, and by the sign of the position they net to.
 *
 * They are distinguishable by POSITION IN THE ARRAY. `applyActions` pushes a
 * roll's closing fill immediately followed by its opening fill, and `loadFills`
 * preserves both document order and array order (average cost is
 * path-dependent, so it must). A roll's two fills are also always in the same
 * document, so a window can never split them. A contiguous run of same-instant
 * roll fills therefore alternates out, in, out, in — and the odd ones are the
 * openers.
 *
 * Everything else is decided by op alone:
 *
 *   - `open`   — opens. The only unambiguous case.
 *   - `close`  — cannot open. A window that starts here saw only buy-backs.
 *   - `resize` — cannot open BY DEFINITION: it resizes a leg that already
 *     exists, so seeing one first proves the opens fell outside the window.
 *   - absent   — a pre-existing or hand-repaired document. Not guessed at.
 *
 * Getting this wrong in the permissive direction is the expensive one: the
 * caller "flattens" a position that was never held, which SELLS, which opens a
 * naked short while trying to close nothing.
 */
export function firstFillOpensPosition(
  fills: readonly { readonly tradingsymbol: string; readonly op?: string; readonly ts: number }[],
): Map<string, boolean> {
  const out = new Map<string, boolean>()
  // Where we are inside a contiguous run of roll fills stamped at one instant.
  let rollRun = 0
  let rollTs: number | null = null
  for (const f of fills) {
    let opens: boolean
    if (f.op === 'roll') {
      if (rollTs !== f.ts) {
        rollTs = f.ts
        rollRun = 0
      }
      opens = rollRun % 2 === 1
      rollRun++
    } else {
      rollTs = null
      rollRun = 0
      opens = f.op === 'open'
    }
    if (!out.has(f.tradingsymbol)) out.set(f.tradingsymbol, opens)
  }
  return out
}

/**
 * The open contracts a flatten may act on, and the ones it must NOT.
 *
 * TRUNCATION GUARD. A symbol whose first fill in the window is not an OPEN is
 * not flattened; it is named and left alone.
 *
 * The window can legitimately start mid-position — `sinceMs` was widened
 * wrongly, or a carried book predates it. Rebuilding from buy-backs alone nets
 * to a LONG that was never held, and "flattening" that sends a SELL: a naked
 * short opened while trying to close nothing. That is the one outcome strictly
 * worse than leaving the leg open, because it creates exposure the operator did
 * not ask for and does not know about.
 *
 * `op` is what makes this detectable at all — see `StampedFill.op`. When it is
 * absent (a pre-existing or hand-repaired document) we do NOT guess: an unknown
 * first op is treated as suspect for the same reason.
 *
 * Contracts at qty 0 are dropped here rather than reported: they are a closed
 * round trip, which `buildPositions` retains for its realised P&L and a flatten
 * has nothing to do with.
 */
export function partitionOpenPositions<
  T extends { readonly tradingsymbol: string; readonly qty: number },
>(
  positions: readonly T[],
  fills: readonly { readonly tradingsymbol: string; readonly op?: string; readonly ts: number }[],
): { readonly open: readonly T[]; readonly truncated: readonly string[] } {
  const opensBySymbol = firstFillOpensPosition(fills)
  const truncated: string[] = []
  const open: T[] = []
  for (const p of positions) {
    if (p.qty === 0) continue
    if (opensBySymbol.get(p.tradingsymbol) === true) {
      open.push(p)
      continue
    }
    truncated.push(p.tradingsymbol)
  }
  return { open, truncated }
}

/**
 * Resolve every open contract BEFORE planning.
 *
 * A symbol the instrument master does not know cannot be routed, and fabricating
 * an `InstrumentRef` for it is how the C5 synthetic exit instrument happened —
 * an order at a made-up lot size against a contract that may not exist. It is
 * reported by name instead, so the operator knows exactly which leg still needs
 * closing by hand.
 */
export function resolveOpenContracts<T extends { readonly tradingsymbol: string }>(
  open: readonly T[],
  resolveSymbol: (tradingsymbol: string) => InstrumentRef | null,
): {
  readonly resolvable: readonly T[]
  readonly unresolved: readonly string[]
  readonly instruments: ReadonlyMap<string, InstrumentRef>
} {
  const resolvable: T[] = []
  const unresolved: string[] = []
  const instruments = new Map<string, InstrumentRef>()
  for (const p of open) {
    const inst = resolveSymbol(p.tradingsymbol)
    if (inst === null) {
      unresolved.push(p.tradingsymbol)
      continue
    }
    instruments.set(p.tradingsymbol, inst)
    resolvable.push(p)
  }
  return { resolvable, unresolved, instruments }
}

/**
 * The exit orders a flatten intends to place, in plan order.
 *
 * Index-aligned with `legs` — the routing loop pairs them by position, and the
 * replay path re-derives the same ids from the same decisionId.
 */
export function plannedFlattenFills(
  legs: readonly FlattenLegPlan[],
  decisionId: string,
  nowMs: number,
): readonly Fill[] {
  return legs.map((leg, i) => ({
    op: 'close' as const,
    // The clientOrderId doubles as the desk tag so a journalled fill can be
    // matched to the gateway order it produced — the same convention
    // `submit.ts` uses for a hosted strategy's own orders.
    deskTag: orderIdFor(decisionId, i),
    tradingsymbol: leg.tradingsymbol,
    side: leg.side,
    qty: leg.qty,
    price: leg.price,
    ts: nowMs,
    orderType: leg.orderType,
    ...(leg.limitPrice === undefined ? {} : { limitPrice: leg.limitPrice }),
  }))
}

/**
 * An unresolvable leg is reported as a SKIP in the decision record, in the same
 * shape as every other skip, so `/v1/desk/decisions` renders it without learning
 * a new one.
 */
export function unresolvedFlattenSkips(unresolved: readonly string[]): readonly Skip[] {
  return unresolved.map((tradingsymbol) => ({
    action: { op: 'close', ts: tradingsymbol },
    reason: `flatten: '${tradingsymbol}' is not in the instrument master — it could not be routed`,
  }))
}

/**
 * The underlying to file the flatten's decision record under.
 *
 * One underlying when they agree, otherwise none: `desk-decisions.symbol` is
 * only the filter key for `/v1/desk/decisions?symbol=`, and naming one
 * underlying for a mixed flatten would misfile the rest.
 */
export function flattenDecisionSymbol(legs: readonly FlattenLegPlan[]): string {
  const symbols = new Set(legs.map((l) => deriveUnderlying(l.tradingsymbol)))
  return symbols.size === 1 ? ([...symbols][0] as string) : ''
}

/**
 * One planned leg's outcome, once the routing loop knows whether it went out.
 *
 * `orderType`/`limitPrice` come from the FILL, not from the plan, and that is
 * the whole reason the fill is a parameter. The plan is the intent; the fill is
 * what `marketableFallback` actually sent. Reporting the plan's MARKET beside a
 * limit order on the wire is the same class of lie as decorating a response
 * after routing — the operator reads one thing and the broker saw another.
 */
export function flattenLegResult(
  leg: FlattenLegPlan,
  fill: Pick<Fill, 'orderType' | 'limitPrice'>,
  error: string,
): FlattenLegResult {
  return {
    tradingsymbol: leg.tradingsymbol,
    positionQty: leg.positionQty,
    side: leg.side,
    qty: leg.qty,
    // An absent `orderType` on the fill IS MARKET — `rail.ts` defaults it.
    orderType: fill.orderType ?? 'MARKET',
    ...(fill.limitPrice === undefined ? {} : { limitPrice: fill.limitPrice }),
    routed: error === '',
    error,
    degraded: leg.degraded,
  }
}

/** Everything that could not be closed because it could not be resolved. */
export function unresolvedFlattenLegs(
  unresolved: readonly string[],
  open: readonly { readonly tradingsymbol: string; readonly qty: number }[],
): readonly FlattenLegResult[] {
  return unresolved.map((tradingsymbol) => {
    const pos = open.find((p) => p.tradingsymbol === tradingsymbol)
    return {
      tradingsymbol,
      positionQty: pos?.qty ?? 0,
      side: ((pos?.qty ?? 0) < 0 ? 'Buy' : 'Sell') as DeskSide,
      qty: Math.abs(pos?.qty ?? 0),
      orderType: 'MARKET' as const,
      routed: false,
      error: `'${tradingsymbol}' is not in the instrument master — close it manually`,
      degraded: '',
    }
  })
}

/**
 * Fold a flatten's routed exits into the book this tag holds, if it holds one.
 *
 * Only what actually ROUTED is folded in, and only legs the book ALREADY holds
 * are touched — the same rule as `submit`'s, for the same reasons. A fill for a
 * contract the book does not carry is not this book's business; inventing a leg
 * for it would open a position in a record that is read as one.
 *
 * `touched` is false when nothing matched, which is the caller's signal that
 * there is no write to make at all.
 */
export function foldRoutedFillsIntoBook(
  legs: readonly BridgeLeg[],
  routedFills: readonly Fill[],
  nowMs: number,
): { readonly legs: readonly BridgeLeg[]; readonly touched: boolean } {
  let bookLegs = legs
  let touched = false
  for (const f of routedFills) {
    const held = bookLegs.find((l) => l.instrument.tradingsymbol === f.tradingsymbol)
    if (held === undefined) continue
    bookLegs = applyRoutedFill(bookLegs, {
      instrument: held.instrument,
      underlying: held.underlying,
      expiry: held.expiry,
      strike: held.strike,
      type: held.type,
      side: f.side,
      qty: f.qty,
      price: f.price,
      ts: nowMs,
      deskTag: f.deskTag,
    })
    touched = true
  }
  return { legs: bookLegs, touched }
}

/**
 * `flat` AND `malformedFills` MUST AGREE.
 *
 * `flat` is documented as the one field an operator acts on, and
 * `malformedFills` as "non-empty means the reconstructed position may be
 * WRONG". Computing `flat` from the legs alone let those two statements
 * contradict each other in the worst possible direction: a corrupt stored
 * fill for a real 5-lot short dropped the leg entirely, `legs` came back
 * empty, `legs.every(...)` was vacuously true over nothing, and the answer
 * was `{flat: true, legs: 0, malformedFills: [...]}` with zero orders
 * routed. An operator reading `flat` went home short 5 lots.
 *
 * The same argument applies to a truncated fill READ: a position rebuilt
 * from a subset of the decisions in the window is a position that may be
 * understated, which is the identical failure with a different cause.
 */
export function flattenIsFlat(input: {
  readonly legs: readonly FlattenLegResult[]
  readonly truncated: readonly string[]
  readonly malformedFills: readonly string[]
  readonly fillsTruncated: boolean
  /** Fills read in the window. 0 with 0 legs means the WINDOW was empty. */
  readonly fillCount: number
}): boolean {
  // An empty reconstruction proves nothing about the position: a multi-day book
  // (the window defaults to today) and a seeded book (which journals no fills)
  // both come back empty, `legs.every` over [] is vacuously true, and the
  // operator reading `flat: true` goes home carrying the book — the
  // NIFTY-2026-08-03 incident. Zero legs is flat ONLY when the window actually
  // held fills that net to zero.
  if (input.legs.length === 0 && input.fillCount === 0) return false
  return (
    input.legs.every((l) => l.routed) &&
    input.truncated.length === 0 &&
    input.malformedFills.length === 0 &&
    !input.fillsTruncated
  )
}
