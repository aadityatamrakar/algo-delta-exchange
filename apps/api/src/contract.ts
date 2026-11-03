/**
 * The BOOK's internal shapes — legs, actions, fills — as `applyActions` and
 * `applyDecision` speak them.
 *
 * NOT A WIRE CONTRACT ANY MORE. This file was the Python desk's, shaped
 * field-for-field by what `decide.py` emitted, and the D9 cutover retired both
 * the process and the endpoint (`POST /v1/desk/actions`) that spoke it. The
 * desk's decisions now arrive at `POST /v1/desk/engine/decisions`, whose wire
 * addresses REAL INSTRUMENTS — `routes/engine.ts` owns that shape and its
 * validation, and translates it into the actions below.
 *
 * WHAT SURVIVED IT, AND WHY IT STILL LOOKS LIKE THIS:
 *
 *   `deskTag` IS STILL A LEG ID, NOT A SYMBOL, and that separation is the one
 *   idea worth keeping from the old contract. A book can hold two legs on the
 *   SAME contract — a tranche opened at a different price, a hedge layered onto
 *   a short — and a book keyed by tradingsymbol cannot name either of them
 *   again. So a leg carries BOTH: `deskTag` (its identity within this book) and
 *   `instrument` (the real contract, what routes). Actions reference the tag;
 *   orders leave keyed by the exchange symbol.
 *
 *   The Python engine minted tags positionally — `f"{otype}{_fmt_k(strike)}#
 *   {len(new_book)}"`, e.g. `CE530#3` — which is why they had to arrive over
 *   the wire rather than be generated here: the two books had to agree
 *   index-for-index, and a single skipped action put every later tag off by
 *   one. Nothing mints tags that way now (the engine endpoint derives one per
 *   action from the decision), and the rule that made the old scheme survivable
 *   still holds here: a tag is an OPAQUE key, only ever compared for equality.
 *
 *   `desk_tag` provenance on order documents is kept deliberately (spec §9),
 *   so a fill in Mongo can still be traced back to the leg it moved and the
 *   journal reads continuously across the cutover.
 */

import type { InstrumentRef } from '@algomaker/order-bus'
import type { OptionType } from '@algomaker/greeks'

/** Sim or real money. Never defaulted — see D4 in the plan. */
export type DeskMode = 'paper' | 'live'

/**
 * The BOOK's side vocabulary, which is not the broker's ('Buy'/'Sell' vs
 * 'BUY'/'SELL'). `rail.ts:brokerSide` is the one place they meet.
 */
export type DeskSide = 'Buy' | 'Sell'

/**
 * `ts` IS THE LEG TAG, and it is supplied rather than generated here.
 *
 * The caller names the leg it is opening because the caller is the only one who
 * can: `applyActions` is a fold over a book, and a tag it minted from that
 * book's CURRENT LENGTH — which is how the retired Python engine did it — is
 * positional identity, off by one for good the first time an action is skipped.
 * `routes/engine.ts` derives a tag per action from the decision instead, which
 * is stable whatever else in the package did or did not apply.
 *
 * Here the tag is an OPAQUE key, only ever compared for equality.
 */
export interface OpenAction {
  readonly op: 'open'
  readonly ts: string
  readonly strike: number
  readonly type: OptionType
  readonly side: DeskSide
  /** CONTRACT quantity, already multiplied out from lots. */
  readonly qty: number
  /**
   * This open ADDS to the leg already under `ts`, rather than starting one.
   *
   * Set by `phaseShed` (`EngineAction.add`) and carried off `WireAction.add` by
   * `routes/engine.ts`. Without it `applyActions` cannot tell an accumulating
   * shed from a decision repeating itself, so it refused both — and three
   * recenter books spent six days unable to act on their own shed (2026-09-16).
   *
   * ABSENT means "a new position", and an absent flag on a held tag is still
   * refused: the never-doubled rule is what stops a repeat growing the book.
   */
  readonly add?: boolean
  /**
   * The delta-lean lean this open belongs to, carried off `WireAction.leanId`
   * by `routes/engine.ts` and written onto the leg by `applyActions`.
   *
   * OPTIONAL, and ABSENT rather than `undefined` when there is none — the
   * recenter engine has no leans, and an `undefined` written into a Mongo
   * document is stored as null and read back as a VALUE. See `BridgeLeg.leanId`.
   */
  readonly leanId?: string
}

export interface CloseAction {
  readonly op: 'close'
  /** The leg's id within this book, not an exchange symbol. */
  readonly ts: string
}

/**
 * `to_ts` is the tag for the REPLACEMENT leg. A roll changes a leg's identity —
 * it is a close and an open in one action — so without naming the new tag,
 * every later action referencing the rolled leg would miss.
 */
export interface RollAction {
  readonly op: 'roll'
  readonly ts: string
  readonly to_ts: string
  readonly to_strike: number
}

/**
 * `qty` is the ABSOLUTE new quantity, NOT a delta — and the distinction has
 * cost a book once already (the 2026-08-03 ITC desync, where a fold read the
 * fill's delta as the new size).
 */
export interface ResizeAction {
  readonly op: 'resize'
  readonly ts: string
  readonly qty: number
}

export type DeskAction = OpenAction | CloseAction | RollAction | ResizeAction

export const VALID_OPS = ['open', 'close', 'roll', 'resize'] as const

/**
 * ONE DECISION, as `BridgeService.applyDecision` takes it.
 *
 * An INTERNAL shape now, not a request body: the endpoint that parsed one of
 * these off the wire is gone, and `routes/engine.ts` builds this by translating
 * its own instrument-addressed wire (`WireAction` there). The name is kept
 * because it is what every caller, journal field and test in this app already
 * says, and renaming it would be a very wide diff that changes nothing.
 */
export interface ActionsRequest {
  /** Underlying, e.g. 'KALYANKJIL'. */
  readonly symbol: string
  /** 'YYYY-MM-DD'. The desk manages one expiry per book. */
  readonly expiry: string
  readonly mode: DeskMode
  /** Order-bus tag. Also the live-routing key in `xtsOrder.js:237`. */
  readonly tag: string
  /**
   * Idempotency key for this whole decision. A replay returns the original
   * result and routes nothing — N pm2 processes retrying must not double-fill.
   */
  readonly decisionId: string
  readonly actions: readonly DeskAction[]
  /**
   * What the strategy decided this mark — its trigger, and its own words for
   * why. TELEMETRY, with one exception that is a PRICE and never a choice of
   * orders: neither field can change which orders route, and `reason` can
   * change nothing at all.
   *
   * THE EXCEPTION. On an ENGINE decision (`via: 'engine'`), an `action` that
   * starts `dl-` — the delta-lean family, every playbook included — or is the
   * `eod` flatten, on a book whose contract expires today (IST), routes with
   * the wider expiry-day buffer on its limit price (`applyDecision`,
   * `marketable.ts`). Every other value, and an absent one, is priced as
   * before. So the `dl-` prefix of a trigger is a contract between the engine
   * and this API rather than a label: renaming the family on the engine side
   * moves a price here.
   *
   * Both optional because the decision-reason panel postdates the callers: a
   * path that names neither still routes exactly as it did, and the panel says
   * "no reason recorded" rather than breaking.
   *
   * `reason` is stored VERBATIM and never parsed. It is generated by the engine
   * and its wording changes whenever a playbook does; anything that
   * pattern-matched it would break silently on the next preset.
   */
  readonly action?: string
  readonly reason?: string
  /**
   * WHICH CALLER'S ORDER LIFECYCLE THIS DECISION GETS — `rail.ts`'s `RouteVia`.
   *
   * `'engine'` (the recenter supervisor's endpoint, and only it) opts a PAPER
   * package into the live order's life: the orders are queued for the gateway,
   * the response is `WORKING`, and the book folds when the fills land rather
   * than at the moment of the write (D14).
   *
   * NOT A WIRE FIELD. No validator reads it off a body; the engine route sets
   * it in code — a caller that could name its own lifecycle on the wire could
   * ask for a paper package it never has to account for.
   *
   * Typed as a string union rather than a boolean because the question it
   * answers ("who asked") has more possible answers than the one it happens to
   * change today.
   */
  readonly via?: 'engine'
}

/** One leg as the desk holds it. */
export interface BridgeLeg {
  /** The leg's id within this book. What actions reference. */
  readonly deskTag: string
  /** The real contract. What actually routes. */
  readonly instrument: InstrumentRef
  readonly underlying: string
  readonly expiry: string
  readonly strike: number
  readonly type: OptionType
  readonly side: DeskSide
  /** Signed contract qty: negative is short, so legs sum without a side lookup. */
  readonly qty: number
  readonly entryPrice: number
  readonly openedTs: number
  /**
   * WHO AUTHORED THE ORDER THAT PUT THIS LEG HERE, stamped by `/v1/desk/submit`
   * (`'manual'`) and by the repair Apply path (`'repair'`). An engine open
   * stamps NOTHING (`book.ts:applyActions`). Served on the positions payload
   * verbatim.
   *
   * INFORMATIONAL ONLY. It is read in exactly one place — the supervisor's
   * `#readBook` maps an ABSENT origin to `LegView.openedByEngine`, i.e. "the
   * desk's own automation put this here" — and `openedByEngine` is a LABEL:
   * `marking.ts` carries it onto the view and nothing in `shed`, `scrap`,
   * `shift`, `guards` or `tiers` reads it. No decision anywhere turns on this
   * field.
   *
   * IT CONFERS NO PROTECTION, and this docstring used to say it did. The
   * retired rule read "a `repair` leg is adopted bot-managed while a manual
   * leg is adopted protected and left alone" — false in BOTH halves under D12.
   * The Python default that auto-protected a hand-added leg was REVERSED:
   * `protectedQty` is written only by the operator's explicit `/protect` call
   * (`routes/engine.ts`), so from launch on ANY leg added by hand to a steered
   * book is immediately shed/scrap/close-eligible until the operator presses
   * Protect. See `docs/GOING-LIVE-RUNBOOK-SUPERVISOR.md`.
   *
   * Which is also why `protectedQty` is a QUANTITY per instrument rather than
   * a flag on the leg: protection is the operator's pin, held in supervisor
   * state, not a property of who opened the position.
   *
   * ABSENT MEANS "the engine opened it", and is not written as a default.
   * Every leg the desk already holds — seeded, adopted, opened last month —
   * has no such key, and a legacy leg reading as engine-opened costs a label
   * and never an order, precisely because nothing decides on it.
   */
  readonly origin?: 'manual' | 'repair'
  /**
   * WHICH DELTA-LEAN BET PUT THIS LEG HERE, under the v1 controller — its
   * `dlLeanId`, stamped from the open action that created the leg.
   *
   * The v1 delta-lean controller DECIDED off this stamp: it read the P&L of
   * the legs carrying its current lean and added size on a new peak, cut on
   * the drawdown from it, and stopped the whole lean on its own floor. This
   * engine has no lean and no such rule — every exit reads `totalPnl`
   * (`cumRealized + Σ mtm`) instead; `RuleState.dlDayRealized` is kept for the
   * ledger and read by no exit — so the field is carried through for
   * round-trip fidelity on a stored leg rather than read by any current rule.
   *
   * ABSENT MEANS "no lean" — every recenter leg, every manual leg, every leg
   * opened before this field existed, and every leg this engine opens now —
   * and it is NOT written as a default: the supervisor's `#readBook` maps an
   * absent one to `''`, which matches no lean. `applyActions` therefore omits
   * the key entirely rather than writing `leanId: undefined`, which Mongo
   * stores as null and reads back as a value.
   */
  readonly leanId?: string
}

export type FillOp = 'open' | 'close' | 'roll' | 'resize'

export interface Fill {
  readonly op: FillOp
  /** Defaults to MARKET. Set by close-all's `limit` style. */
  readonly orderType?: 'MARKET' | 'LIMIT'
  readonly limitPrice?: number
  /**
   * A DELIBERATELY pending order: the caller chose this price and wants the
   * order to SIT there (a target exit, a bid under the market). The order
   * chaser must not touch it — chasing would drag the caller's price to the
   * touch, which is the opposite of what was asked for. Absent means "fill me
   * now", which is what every marketable limit and every close means.
   */
  readonly resting?: boolean
  /**
   * HOW HARD THE ORDER SHOULD WORK, when a caller chose (`@algomaker/desk-
   * engine`'s `WorkMode`, carried on the engine wire).
   *
   * `passive` joins the touch and re-pegs as it moves; `urgent` crosses. It is
   * NOT the same statement as `resting`: resting says "leave my price alone",
   * passive says "keep my price at the best bid/offer". The order gateway's
   * chaser reads this off the routed document.
   *
   * ABSENT IS NOT A DEFAULT. Every fill this desk has ever routed has no work
   * mode, and stamping one would tell the chaser that a decision was made about
   * an order where none was.
   */
  readonly workMode?: 'passive' | 'urgent'
  /**
   * THE BOOK'S EXECUTION DIALS, carried to the gateway on the order document
   * (`@algomaker/desk-engine`'s `WorkDials`, §8).
   *
   * `trancheLots` is the slice size in LOTS — the gateway keeps one tranche
   * live at the broker at a time and releases the next only when that one is
   * terminal. `chaseMaxMs` and `chaseCrossBufferPct` are the peg chaser's
   * deadline and its one reach through the far touch.
   *
   * ABSENT IS NOT A DEFAULT, exactly as `workMode` is not. The gateway has its
   * own defaults for the two chase dials, and no tranche gating at all without
   * one — which is what every order this desk has routed relies on. Writing a
   * value here says the decision was made; writing nothing says it was not.
   */
  readonly trancheLots?: number
  readonly chaseMaxMs?: number
  readonly chaseCrossBufferPct?: number
  readonly deskTag: string
  readonly tradingsymbol: string
  readonly side: DeskSide
  /** Contract quantity traded by THIS fill (always positive). */
  readonly qty: number
  readonly price: number
  readonly ts: number
  /**
   * WHICH DELTA-LEAN BET THIS ORDER BELONGS TO — `OpenAction.leanId`, carried
   * onto the order so the PAPER rail can put it back on the leg (plan 10A).
   *
   * IT IS HERE BECAUSE OF WHEN THE PAPER LEG IS WRITTEN. On the live rail
   * `applyActions` stamps the leg in the same breath as it forms the fill, and
   * the fill never needed to carry anything. On the paper rail the engine route
   * answers `WORKING` and the leg is created MINUTES LATER by `paper-fold.ts`,
   * from a gateway-order document and a contract rebuilt out of the instrument
   * master — neither of which has ever heard of a lean. The fill is what stands
   * between the two: it is written onto the order document (`rail.ts:
   * orderDocument`) and parked in the decision's `plannedFills`, so the stamp is
   * durable across the gap rather than living only in the request that decided
   * it.
   *
   * ABSENT IS "NO LEAN", never a default and never `undefined`: it is spread
   * conditionally at every hop, because an `undefined` written into Mongo is
   * stored as null and reads back as a value. See `BridgeLeg.leanId`.
   */
  readonly leanId?: string
}

/**
 * An action the desk could not perform.
 *
 * FAIL-SOFT PER ACTION, deliberately: one bad action in a decision must not
 * discard the other seven — a package whose fourth leg names an unlisted strike
 * still has three legs that should go out. Every skip is reported back with its
 * reason, so the caller sees exactly what did not happen instead of inferring
 * it from a position count.
 */
export interface Skip {
  readonly action: DeskAction
  readonly reason: string
}

export interface ApplyResult {
  readonly book: readonly BridgeLeg[]
  readonly fills: readonly Fill[]
  readonly skips: readonly Skip[]
}

/** Marks the bridge prices against. Supplied by the caller; never fetched here. */
export interface MarkSource {
  /** Last traded price for a contract, or null when the feed has nothing. */
  price(instrument: InstrumentRef): number | null
  /** Underlying spot, for greeks. */
  spot(underlying: string): number | null
  /**
   * Age of that price in ms, or null when there is no usable mark.
   *
   * OPTIONAL, and the gate that reads it treats an absent implementation as
   * "no opinion" rather than "stale" — `StaticMarks` (dry runs against a closed
   * market, and every test that does not opt in) has no ages to give, and a
   * mark source that cannot answer must not become a mark source that refuses.
   *
   * Only `applyActions`' ceiling on NEW exposure consumes it (audit F-16):
   * pricing an open off an hours-old quote produces a "marketable" limit that
   * rests forever, so the hedge silently does not exist.
   */
  markAge?(instrument: InstrumentRef): number | null
}

export function isValidOp(op: unknown): op is FillOp {
  return typeof op === 'string' && (VALID_OPS as readonly string[]).includes(op)
}

/** Signed qty from the desk's side vocabulary. Short is negative, everywhere. */
export function signedQty(side: DeskSide, qty: number): number {
  return side === 'Sell' ? -Math.abs(qty) : Math.abs(qty)
}

/** The side that CLOSES a position — the opposite of the one that opened it. */
export function closingSide(side: DeskSide): DeskSide {
  return side === 'Sell' ? 'Buy' : 'Sell'
}
