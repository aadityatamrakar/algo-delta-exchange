/**
 * The PURE decisions behind `/v1/desk/submit` — see `submit.ts` for the endpoint
 * itself and for the crash-safety argument that fixes the ORDER of everything
 * below.
 *
 * Everything here is a total function of its arguments: no `await`, no Mongo, no
 * clock, no service state. That is the whole point. `SubmitService.submit` is on
 * the live money path and its correctness is mostly a correctness of ORDERING —
 * claim before route, journal after route, gates before either — so the ordering
 * stays in one readable method there, and the arithmetic and the verdicts that
 * ordering is wrapped around live here where they can be exercised directly.
 *
 * Nothing in this module may grow an I/O dependency. A gate that has to read
 * something belongs in the method beside the read that feeds it.
 */

import { splitIntoTranches } from '@algomaker/instruments'
import {
  anyExposureLimitSet,
  checkExposureLimits,
  riskRefusalReason,
  type ExposureLimits,
  type ExposureState,
} from '@algomaker/order-bus'
import type { DeskMode, DeskSide, Fill } from './contract.ts'
import { isOn, type StrategyModes } from './strategies.ts'
import { haltApplies, type KillSwitchState } from './safety.ts'

/** One broker-bound order this submission became. `qty` is UNITS, not lots. */
export interface SubmittedOrder {
  readonly clientOrderId: string
  readonly qty: number
  readonly lots: number
}

/**
 * Where a submission got to. Same vocabulary, same three values and the same
 * meanings as `service.ts:DecisionStatus`, because the two order paths must not
 * need two mental models — see `submit.ts`'s header for the full
 * accepted/status matrix.
 */
export type SubmitStatus = 'ROUTING' | 'DONE' | 'FAILED'

// -------------------------------------------------------------- the claim

export interface StoredSubmission {
  readonly clientOrderId: string
  readonly tag: string
  readonly mode: DeskMode
  readonly tradingsymbol: string
  readonly side: DeskSide
  readonly requestedLots: number
  /** INTENDED lots, after the `liveLots` override. NOT what routed. */
  readonly lots: number
  readonly accepted: boolean
  readonly reason: string
  /**
   * What we believe ROUTED. Empty at claim time, because at claim time nothing
   * has: the old code stored the full plan here and left `accepted: true`
   * beside it, so a crash before the routing loop made a replay report every
   * tranche as filled. `plannedOrders` holds the plan; this holds the outcome.
   */
  readonly orders: readonly SubmittedOrder[]
  readonly status: SubmitStatus
  readonly routeErrors: readonly string[]
  readonly createdAt: number
  readonly freezeMaxLots: number | null
  /**
   * Written ONCE at claim time and never rewritten, so a reconcile can finish
   * the job a dead process started: the plan to check against the order
   * collection, plus everything needed to rebuild the P&L journal record that
   * a crash between routing and `#writeJournal` would otherwise lose forever.
   */
  readonly plannedOrders?: readonly SubmittedOrder[]
  readonly underlying?: string
  readonly price?: number
  readonly op?: 'open' | 'close'
  readonly orderType?: 'MARKET' | 'LIMIT'
  readonly limitPrice?: number
}

/**
 * "A gate refused; NOTHING was attempted" — the third row of the state matrix
 * in `submit.ts`'s header, and the only stored outcome that is safe to retry.
 *
 * The pair is the whole discriminator, and it is exact:
 *   - `FAILED` means a route was attempted, whether or not anything landed.
 *   - `ROUTING` means a claim is outstanding and the truth is unknown.
 * Both of those must keep replaying. Only a DONE refusal is a promise that no
 * order exists anywhere, and that promise is what makes re-running the gates
 * safe rather than a way to place twice.
 *
 * `orders` is asserted empty too. It is redundant against the matrix, and it
 * is here so that if some future writer produces a DONE+unaccepted record that
 * DID route, this predicate refuses it rather than silently authorising a
 * second placement.
 */
export function isGateRefusal(s: StoredSubmission): boolean {
  return s.status === 'DONE' && !s.accepted && s.orders.length === 0
}

/**
 * The record that CLAIMS the `clientOrderId`, written before anything routes.
 *
 * `accepted: false` while ROUTING, and `orders: []` beside it.
 *
 * Both fields describe what HAS HAPPENED, and at this instant nothing
 * has. Claiming `accepted: true` with the full tranche list here is what
 * made a crash between the insert and the routing loop replay as a
 * complete, successful order: on an entry the caller booked a position
 * that does not exist, and on an exit it believed it was flat while still
 * holding. The claim's job is to reserve the id, not to predict the
 * outcome.
 */
export function buildClaimRecord(input: {
  readonly clientOrderId: string
  readonly tag: string
  readonly mode: DeskMode
  readonly tradingsymbol: string
  readonly side: DeskSide
  readonly requestedLots: number
  readonly lots: number
  readonly createdAt: number
  readonly freezeMaxLots: number | null
  readonly plannedOrders: readonly SubmittedOrder[]
  readonly underlying: string
  readonly price: number
  readonly op: 'open' | 'close'
  readonly orderType?: 'MARKET' | 'LIMIT'
  readonly limitPrice?: number
}): StoredSubmission {
  return {
    clientOrderId: input.clientOrderId,
    tag: input.tag,
    mode: input.mode,
    tradingsymbol: input.tradingsymbol,
    side: input.side,
    requestedLots: input.requestedLots,
    lots: input.lots,
    accepted: false,
    reason: '',
    orders: [],
    status: 'ROUTING',
    routeErrors: [],
    createdAt: input.createdAt,
    freezeMaxLots: input.freezeMaxLots,
    plannedOrders: input.plannedOrders,
    underlying: input.underlying,
    price: input.price,
    op: input.op,
    ...(input.orderType === undefined ? {} : { orderType: input.orderType }),
    ...(input.limitPrice === undefined ? {} : { limitPrice: input.limitPrice }),
  }
}

// ------------------------------------------------------------------- gates

/**
 * The gates that run AFTER the strategy row has been loaded and the kill switch
 * read — the kill switch, the row's per-mode switch, and the box-level pin.
 *
 * They are evaluated together because they are all pure reads of state the
 * caller has already fetched, and because every one of them ends the same way:
 * journal the reason, then `#refuse`. Returning the FIRST reason preserves the
 * short-circuit exactly — a request that trips two gates is journalled once,
 * naming the same gate it named before.
 *
 * GATE 1 (is the tag registered at all) is NOT here: it can throw
 * `UnknownStrategy`, and it decides whether `touchStrategy` runs, so it stays
 * beside the load that feeds it.
 *
 * `null` means every gate passed.
 */
export function screenSubmitGates(input: {
  readonly tag: string
  readonly mode: DeskMode
  readonly reducesExposure?: boolean
  readonly modes: StrategyModes
  readonly halt: KillSwitchState
  readonly liveTags: ReadonlySet<string>
}): string | null {
  // ---- GATE 3: the kill switch ----------------------------------------
  // NEW EXPOSURE ONLY. An exit is never blocked, because a control that
  // traps an open position is worse than whatever it was protecting against
  // — the same asymmetry as safety.ts and order-bus/risk.ts:82.
  if (haltApplies(input.halt, input.mode) && input.reducesExposure !== true) {
    const why = input.halt.reason === '' ? '' : ` (${input.halt.reason})`
    return (
      `kill switch: engaged${why}; only exposure-reducing orders are allowed ` +
      `(set reducesExposure to submit an exit)`
    )
  }

  /**
   * ---- GATE 4a: the ROW permits the mode the request states -------------
   *
   * This endpoint keeps its OWN check, and it is deliberately redundant with
   * GATE 1 now that `gateStrategy` is per mode. It is not dead weight: it is
   * the assertion that survives a refactor of the gate. The defect it was
   * written for was exactly a missing one of these — the body alone decided
   * the mode, and a caller constructed while the row said `live` kept sending
   * `mode: 'live'` after an operator switched live off, so real money kept
   * trading while the portal showed it stopped. The runner bakes mode in at
   * construction, so a stale caller is the expected case, not a hypothetical.
   *
   * Same reasoning as the live allowlist being checked here AND in
   * `LiveRail`: an edge check is one refactor away from being bypassed by a
   * second call site, so the important ones are stated twice.
   *
   * REDUCE-ONLY ORDERS ARE EXEMPT, the same asymmetry as GATE 3 and for the
   * same 2026-08-04 reason as `gateStrategy`'s exemption: the runner flattens
   * ON switch-off, so a switch that refuses the closing orders strands the
   * position it was meant to stop. Being the redundant restatement of GATE 1,
   * this check must restate the exemption too, or the refactor-surviving copy
   * would reintroduce the trap the primary just removed.
   */
  if (!isOn(input.modes, input.mode) && input.reducesExposure !== true) {
    return (
      `strategy mode: '${input.tag}' is not switched on for ${input.mode} in the portal, ` +
      `so this order is refused (the caller may be holding a stale mode)`
    )
  }

  /**
   * ---- GATE 4: the optional BOX-LEVEL PIN ------------------------------
   *
   * This used to be the live allowlist proper, read from `DESK_LIVE_TAGS`.
   * The allowlist is now GATE 3 above — `modes.live` on the strategy row,
   * which is the password-gated switch — so an env allowlist here would be a
   * second, redundant source that has to be edited and restarted in step with
   * the first. It was not, and the mismatch refused a correctly-enabled tag.
   *
   * What remains is a pin: when `DESK_LIVE_TAGS` is non-empty this host may
   * only trade that subset, whatever the portal says. EMPTY MEANS NO PIN —
   * the inverse of the old meaning, and the reason this check is now guarded
   * on `size > 0`.
   */
  if (input.mode === 'live' && input.liveTags.size > 0 && !input.liveTags.has(input.tag)) {
    return (
      `live pin: this host is pinned by DESK_LIVE_TAGS to a subset that ` +
      `excludes '${input.tag}'`
    )
  }

  return null
}

// -------------------------------------------------------------- risk limits

/**
 * GATE 6: the desk-wide RISK LIMITS — the daily loss stop, the order rate
 * limit, the lot caps and the notional cap (audit F-28).
 *
 * The rules `packages/order-bus/src/risk.ts` has always encoded, finally on a
 * path that runs. Everything about the verdict lives there; this function is
 * the seam that says WHEN the desk asks for one:
 *
 *   - **LIVE ONLY.** Paper is a rehearsal with no money at stake, and a paper
 *     book refused by a live-money cap would make the rehearsal a different
 *     strategy from the thing it is rehearsing.
 *   - **OPT-IN.** Every limit is disabled unless the operator set its variable,
 *     so this gate ships inert (`NO_EXPOSURE_LIMITS`) and only starts refusing
 *     when someone chooses a number. That is the whole deployment argument: no
 *     live desk changes behaviour on the commit that adds this.
 *   - **EXITS ARE NEVER GATED**, the same asymmetry as GATE 3 above and for the
 *     same reason. Stated here as well as inside `checkExposureLimits` because
 *     a gate that only says it in one place is one refactor from trapping a
 *     position.
 *
 * `exposure: null` means the desk could not be measured at all — the P&L read
 * failed both from memory and from Mongo. With a limit configured that is a
 * REFUSAL of new exposure: a stop that cannot see the number it stops on is not
 * a stop, and the operator asked for one. With nothing configured it is
 * irrelevant, and for an exit it is never reached.
 *
 * Returns the refusal reason, or `null` when the order may proceed — the same
 * shape as `screenSubmitGates`, so the caller journals and refuses identically.
 */
export function screenRiskGate(input: {
  readonly mode: DeskMode
  readonly reducesExposure?: boolean
  readonly underlying: string
  readonly lots: number
  /** CONTRACT quantity, for the notional check. */
  readonly quantity: number
  /** Best known price, for the notional check. `null` skips that check only. */
  readonly price: number | null
  readonly limitPrice?: number
  readonly limits: ExposureLimits
  readonly exposure: ExposureState | null
}): string | null {
  if (input.mode !== 'live') return null
  if (input.reducesExposure === true) return null
  if (!anyExposureLimitSet(input.limits)) return null
  if (input.exposure === null) {
    return (
      `risk limits: the desk's day P&L and open lots could not be measured, and a limit is ` +
      `configured — refusing new exposure (exits are unaffected)`
    )
  }
  const verdict = checkExposureLimits(
    {
      lots: input.lots,
      quantity: input.quantity,
      ...(input.limitPrice === undefined ? {} : { limitPrice: input.limitPrice }),
    },
    input.limits,
    {
      ...input.exposure,
      isReducingExposure: false,
      underlying: input.underlying,
      price: input.price,
    },
  )
  return verdict.allowed ? null : riskRefusalReason(verdict.rejection)
}

// ------------------------------------------------------------------ sizing

/** What `chooseLiveLots` decided: the size to route, or the gate that refused. */
export type LiveLotsPlan =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true
      readonly lots: number
      /** True when `liveLots` REPLACED the caller's size. Worth a log line. */
      readonly overridden: boolean
    }

/**
 * LIVE SIZING: `liveLots` REPLACES the strategy's own lots. It is an
 * override, not a multiplier (Phase C §7).
 *
 * Multipliers compound invisibly — `xtsOrder.js:100` divides the contract
 * quantity back out to lots and then applies the account's per-strategy
 * multiplier on top of a quantity the strategy had already sized, so the
 * number that reached the exchange existed nowhere in either system. An
 * override can be read straight off the registry row and matched against
 * the order that went out, which is the only version of this that is
 * auditable after the fact.
 *
 * EXITS ARE EXEMPT. A position opened at 5 lots must be closed at 5 lots;
 * re-sizing an exit to whatever `liveLots` says today would strand the
 * difference, which is the trapped-position failure the kill switch's own
 * exemption exists to avoid. The strategy knows what it is holding, so on
 * an exit its number wins.
 *
 * A POSITIONAL BOOK'S LEG IS EXEMPT — design spec §7.4, "Sizing does not
 * silently change":
 *
 *   "`StrategyRow.liveLots` is read by the Phase C intraday runner. A
 *   positional book sizes from its seed and its variant dials, and MUST
 *   NOT pick up `liveLots` — a book that quietly resized on going live
 *   would be a different strategy from the one that was paper-tested."
 *
 * The Build screen opens a book's structure leg by leg through this
 * endpoint, and each leg carries its own size: a condor may have 2-lot
 * wings against 4-lot shorts. Applying the override there would force
 * every leg to the same number and seed a structure nobody chose — silent,
 * and only visible later as a book whose greeks do not match its intent.
 *
 * The `liveLots > 0` gate goes with it: it exists to make someone size the
 * strategy deliberately, and a book's size comes from its seed instead.
 * The gates that DO apply to a book are unchanged and all still enforced
 * by the caller — the registry row, the password-gated LIVE switch, and the
 * broker mode.
 */
export function chooseLiveLots(input: {
  readonly tag: string
  readonly mode: DeskMode
  readonly requestedLots: number
  readonly reducesExposure?: boolean
  readonly exactLots?: boolean
  /** `StrategyRow.liveLots` — the registry row's live size. */
  readonly liveLots: number
}): LiveLotsPlan {
  if (
    input.mode !== 'live' ||
    input.reducesExposure === true ||
    input.exactLots === true
  ) {
    return { ok: true, lots: input.requestedLots, overridden: false }
  }
  if (!(input.liveLots > 0)) {
    return {
      ok: false,
      reason:
        `live sizing: liveLots is ${input.liveLots} on the registry row for '${input.tag}' — ` +
        `set it in the portal before this strategy can open a live position`,
    }
  }
  return {
    ok: true,
    lots: input.liveLots,
    overridden: input.liveLots !== input.requestedLots,
  }
}

// ------------------------------------------------------------------- price

/**
 * The fill price, and it is required in BOTH modes.
 *
 * On the paper rail it IS the booked price — `PaperRail` is a paper BOOK,
 * not a paper price model. On the live rail the broker sets the real fill,
 * but this number is what lands in the P&L journal, and a fill recorded at 0
 * is a free option: it does not fail, it silently reports a profit that was
 * never made. `applyActions` already refuses for exactly this reason ("no
 * mark" is a skip, not a zero), and this is the same rule.
 *
 * Three sources, most authoritative first: our own live mark, the
 * strategy's decision price, the limit it asked for. Only when all three
 * are absent is the answer `null`, which in practice means the feed is
 * down AND the caller sent neither price.
 */
export function chooseFillPrice(
  feedMark: number | null | undefined,
  referencePrice: number | undefined,
  limitPrice: number | undefined,
): number | null {
  return feedMark ?? referencePrice ?? limitPrice ?? null
}

// ---------------------------------------------------------------- tranches

/**
 * The exchange freeze split, as the tranche orders it becomes.
 *
 * `freezeMaxLots === null` means "the symbol is not in NSE's freeze table",
 * NEVER "no limit" — `splitIntoTranches` sends it as ONE order, because
 * inventing a split would be worse. The caller logs the unknown.
 */
export function planTranches(input: {
  readonly clientOrderId: string
  readonly lots: number
  readonly freezeMaxLots: number | null
  readonly lotSize: number
}): SubmittedOrder[] {
  return splitIntoTranches(input.lots, input.freezeMaxLots).map((trancheLots, i) => ({
    // Always suffixed, even for a single tranche: the tranche id and the
    // idempotency key must live in different namespaces, or a single-order
    // submit would write a gateway order whose id collides with the
    // submission claim and the two would be indistinguishable in the journal.
    clientOrderId: `${input.clientOrderId}#${i}`,
    lots: trancheLots,
    qty: trancheLots * input.lotSize,
  }))
}

/**
 * The `Fill` one tranche routes as, and the one journalled if it lands.
 *
 * `deskTag` IS THE TRANCHE'S OWN ID unless the caller names a desk leg. The
 * default is what makes a fill traceable to the order that placed it, and what
 * lets `#maintainBook` read "a tag the book did not carry before" as the set of
 * legs a fold created. `ctx.deskTag` is the ONE exception — a repair closing a
 * driver-owned leg, which has to be booked under that LEG's id or its realized
 * P&L is never booked at all. See `SubmitRequestBody.fillDeskTag`.
 */
export function trancheFill(
  order: SubmittedOrder,
  ctx: {
    readonly op: 'open' | 'close'
    readonly tradingsymbol: string
    readonly side: DeskSide
    readonly price: number
    readonly ts: number
    readonly orderType?: 'MARKET' | 'LIMIT'
    readonly limitPrice?: number
    readonly resting?: boolean
    /** The desk leg this fill closes, when it closes one. */
    readonly deskTag?: string
  },
): Fill {
  return {
    op: ctx.op,
    deskTag: ctx.deskTag ?? order.clientOrderId,
    tradingsymbol: ctx.tradingsymbol,
    side: ctx.side,
    qty: order.qty,
    price: ctx.price,
    ts: ctx.ts,
    ...(ctx.orderType === undefined ? {} : { orderType: ctx.orderType }),
    ...(ctx.limitPrice === undefined ? {} : { limitPrice: ctx.limitPrice }),
    ...(ctx.resting === true ? { resting: true } : {}),
  }
}

// ----------------------------------------------------------------- outcome

/** How a routing loop ended, in the three fields every writer of it needs. */
export interface RouteOutcome {
  /**
   * NOTHING routed -> `accepted: false`. This is what preserves anatomy row
   * 14: base.ts flips a strategy's "opportunity used" flag only on an
   * accepted submit, so a total failure leaves the opportunity available
   * instead of silently burning it. A PARTIAL route stays `accepted: true`
   * — real exposure exists and the strategy must know it does — with the
   * failures named in `errors`.
   */
  readonly accepted: boolean
  readonly status: 'DONE' | 'FAILED'
  /** `''` when anything routed; otherwise the named per-tranche failures. */
  readonly reason: string
}

/**
 * Classify a routing loop's result. Used by the live loop AND by the stale
 * reconcile, which infer the same three fields from different evidence and
 * must not disagree about what "partial" means.
 */
export function classifyRouteOutcome(
  routed: readonly SubmittedOrder[],
  routeErrors: readonly string[],
): RouteOutcome {
  const accepted = routed.length > 0
  return {
    accepted,
    status: routeErrors.length === 0 ? 'DONE' : 'FAILED',
    reason: accepted ? '' : `routing: ${routeErrors.join('; ')}`,
  }
}

/** Total lots across a set of tranches. */
export function sumLots(orders: readonly SubmittedOrder[]): number {
  return orders.reduce((n, o) => n + o.lots, 0)
}
