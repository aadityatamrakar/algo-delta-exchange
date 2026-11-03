/**
 * `decideDeltaLean()` — THE SECOND DECIDE PATH: HOLD AND ADJUST.
 *
 * ── WHAT THIS ENGINE IS, IN ONE PARAGRAPH ───────────────────────────────────
 * It opens ONE hedged package a day and holds it. When the tape disagrees with
 * the book it NEUTRALISES BY ADDING — buys the opposite option, or sells a
 * same-side one — rather than closing anything. Nothing takes a leg off before
 * the close except four exits: the flatten windows, the day-loss backstop, the
 * day target, and the stuck rule. That is decision D2, and it is the whole
 * design: the engine it replaces had thirteen exit paths and spent 2026-09-22
 * opening strangles and unwinding them five minutes later, 240 orders across
 * four books for ₹6,377.
 *
 * ── THE ORDER, STEP FOR STEP (spec §5) ──────────────────────────────────────
 *
 *   0. **Day roll.** `rollDay` clears yesterday's stop, open and counters on a
 *      new IST date and does NOTHING on the same one. The second half is the
 *      operationally important one: a mid-session restart must never clear a
 *      stop the book set itself, nor let it lay a second package on the first.
 *      A HOLD book (`dl_hold_to_expiry`) keeps its stop and its open across
 *      the date — see "HOLD TO EXPIRY" below.
 *   1. **The latched stop.** `dlStopped` is terminal until the next day roll
 *      (until expiry, on a hold book). Legs remaining are flattened urgently; a
 *      flat book holds. ABOVE the clock and above everything the regime has to
 *      say, so a book that stopped itself cannot be talked back in by a tape
 *      that looks good.
 *   2. **The clock.** Past `dl_flat_by_min` the residual goes to the blind
 *      ladder; 14:55 urgent, 14:50 passive. ABOVE the session gate on purpose:
 *      the supervisor's SIGTERM is deliberately inert, so a book can wake up
 *      after 15:00 still carrying, and this is the only thing between that and
 *      the overnight carry D4 forbids. A hold book runs it from its expiry day
 *      on: every night before, the carry IS the plan (and 14:50 to the close
 *      is a freeze — see "HOLD TO EXPIRY").
 *   3. **The day-loss backstop** (D6). `totalPnl` — banked plus the open book's
 *      mark — against `dl_day_max_loss`. A DISASTER backstop, not a working
 *      stop: ₹30,000 aggressive / ₹15,000 conservative since R1 of the
 *      2026-10-04 review, at or just past the stuck floor — and unlike the
 *      stuck exit it fires on a book whose posture is met (§6.4). It
 *      is `totalPnl` and not the stored `dlDayRealized` because a budget
 *      counting only BANKED money would ignore the open loss it exists to stop.
 *      On a hold book this and step 4 wait out `dl_rupee_hold_s` first.
 *   4. **The day target.** The same number, the other way: `dl_day_target`
 *      reached (realised plus unrealised) closes the book on a ladder and stops
 *      the day, ON THE FLATTENING TICK — it is a MARK-based trigger and the
 *      ladder takes the mark with the legs. The operator's "exit on the day
 *      target, ₹10,000 per book". 0 is OFF (delta-lean-zero spec D4): the
 *      zero books have no target and hold to the clock.
 *   5. **The gates**: session, detector, warm-up, repair hold, working package.
 *      The DETECTOR RUNS BEFORE THE WARM-UP RETURNS, so 09:15-09:30 classifies
 *      on all three windows and places nothing — a warm-up that returned before
 *      the read would hand the first tradable minute a cold slow window.
 *   6. **The open** (§6.1). ONE hedged package a day, and only on a
 *      `trend-up`/`trend-down`/`quiet` that has held for `dl_adjust_confirm_s`.
 *      The trend open is a debit pair whose SHORT IS THE HEDGE; the quiet one
 *      is a strangle whose two WINGS are. The package is SPAN-projected WHOLE
 *      and truncated down to the lots that fit; if not one lot fits it does not
 *      go on at all, and no stuck clock starts behind it, because a book that
 *      never opened has nothing to lose. Three more gates stand in front of
 *      it, all off by default (delta-lean-zero spec D4, D5): the DAY
 *      (`dl_expiry_day_only`), the WINDOW (nothing opens past
 *      `dl_open_by_min`) and the REGIME's own switch (`dl_open_trend_up`,
 *      `_trend_down`, `_quiet`). In `dl_open_by_min`'s own minute
 *      `dl_open_fallback` opens the quiet package on any reading but
 *      `unknown` — the zero book's condor at 09:31.
 *   7. **The posture and the adjustment** (§6.2). An opened book holding NO
 *      LEGS holds, before anything else here is asked: the day's package is
 *      gone (a ladder filled, a repair took it off, the open was refused
 *      outright) and there is nothing left to adjust AROUND — a net delta of
 *      zero read as a `lean` shortfall is how a flattened book buys a naked
 *      pyramid. Otherwise the regime, read RELATIVE TO THE SIDE THE BOOK
 *      OPENED, wants the net delta somewhere: at +-D when the
 *      trend runs the way the book opened (`lean`, one-sided upward — the
 *      pyramid), at zero when it runs against it or the book is a strangle
 *      (`counter`, one-sided towards zero — a flip NEUTRALISES and never
 *      reverses), at zero two-sided when the tape is quiet or choppy (`flat` —
 *      the same-side ATM sale). Every expression of a gap is an ADD; nothing
 *      here can emit a close. FIVE gates stand in front of it, and their ORDER
 *      is the day limit, then the margin gate (§6.3), then the churn guard, the
 *      confirm window and the cooldown. The two at the top are BLOCKS — neither
 *      can clear by itself, so both feed the stuck exit (§6.4) — and the three
 *      below are WAITS, which reset its clock. The margin gate outranks the
 *      three deliberately: a book at the cap in a trend that merely persists
 *      would otherwise reset its own stuck clock on the churn guard every tick
 *      and never exit.
 *   8. **The stuck exit** (§6.4). Wanted-but-blocked AND `totalPnl` through
 *      `-dl_stuck_loss`, both held for `dl_stuck_confirm_s` — the fourth and
 *      last thing in this file that can close a leg. It latches on the
 *      flattening tick, because its own trigger does not survive that flatten.
 *
 * Every hold below is a WAIT or a BLOCK, and `wait()` is the only way to write
 * the first: the two BLOCKS (the cap, `dl_max_adjusts_day`) run the §6.4 clock
 * and everything else — including every gate above §6.2, which never evaluates
 * the block at all — clears it.
 *
 * ── WHY 3 AND 4 SIT BELOW 2 AND NOT ABOVE IT ────────────────────────────────
 * Both are exits and both end the day, so the only question their order settles
 * is WHICH REASON a 14:52 flatten is journalled under. The clock's is the one
 * an operator can act on: "it is 14:52" explains a package that the target
 * would also have explained, and the reverse is not true. The backstop still
 * outranks the target, because a book that is somehow at both is a book whose
 * two P&L rails disagree, and the urgent answer is the safe one.
 *
 * ── EVERY EXIT LATCHES ON THE FLATTENING TICK — EXCEPT THE CLOCK ────────────
 * `exitDecision` is the one place a `closeAll` becomes a decision, so the four
 * exits cannot drift apart on this. The test is whether the TRIGGER SURVIVES
 * ITS OWN FLATTEN, and three of the four do not:
 *
 *   `dl-stop`   fires on a loss that is still GROWING. A latch that waited for
 *               the flatten to fill would let one more package out in between.
 *   `dl-stuck`  is "an adjustment is wanted but BLOCKED", and that evaporates
 *               with the book: once the ladder fills nothing is wanted, an
 *               empty book fits under any cap, and `stuckExit` is never asked
 *               again — so a latch waiting for flat would never be set at all.
 *   `dl-target` is a MARK. `totalPnl` is `cumRealized + Σ leg.mtm` and the
 *               ladder takes the legs, and the mark with them, BEFORE the host
 *               has folded the fills back into `cumRealized`. A ladder that
 *               slipped banks less than the target that fired it, and the next
 *               tick reads below the target with the trigger gone for good.
 *
 * All three therefore latch on BOTH states the moment they order the flatten,
 * and step 1 carries out whatever a partial fill left behind. What they are
 * guarding against is identical and it is the same door: an OPENED, LEGLESS,
 * unlatched book falls through to §6.2, which reads a `lean` gap of the whole
 * D against a net delta of zero and buys a fresh UNHEDGED pyramid onto a day
 * that was already over. §6.2's own legless guard is the second lock on it.
 *
 * `eod` is the exception, and the reason is its ESCALATION LADDER rather than
 * its trigger. It is still 14:52 on the next tick, so the trigger does survive
 * — and the three windows are deliberately passive at 14:50, urgent at 14:55
 * and blind-ladder past 15:00. Latching on the first tick would hand every
 * residual straight to step 1's URGENT flatten and delete the passive window
 * the design put there to work the order instead of crossing it. So `eod`
 * latches once flat, and the re-decide each tick is what walks the ladder.
 *
 * The latch rides on `markState` as well as `stateAfter` wherever it is set.
 * `stateAfter` is persisted only when a decision ROUTES (`types.ts`), so a stop
 * that lived there alone would be undone by a dropped package.
 *
 * ── HOLD TO EXPIRY (`dl_hold_to_expiry`, spec 2026-10-05) ───────────────────
 * The weekly sibling of the intraday book, and one dial is the whole of it:
 *
 *   - the clock (step 2) runs only when `dateIst >= inputs.expiry` — expiry
 *     day, or past it after a missed roll — so the book carries overnight on
 *     every day before, including a book that wakes after 15:00 still holding
 *     its package. On those days it FREEZES from `dl_flatten_passive_min` to
 *     the close instead: exits still run, nothing opens or adjusts;
 *   - `rollDay` keeps `dlOpenedMs`/`dlOpenSide`, so the package is opened ONCE
 *     for the book's life and every later posture is read against that open;
 *   - `rollDay` keeps `dlStopped`, so a target, backstop or stuck exit is
 *     terminal to expiry, and steps 3-4 read "book" rather than "day": the
 *     figure is the same `totalPnl`, `cumRealized + Σ mtm`, which is the TAG's
 *     lifetime bank — on a book that lives a week, a week's money. The dial
 *     names stay `dl_day_*` so there is one table to keep in step;
 *   - steps 3-4 fire only on a reading held `dl_rupee_hold_s` (60s), because
 *     the carried legs' first marks at 09:15 are a blend of two sessions
 *     (`heldLine`). Once fired they latch exactly as on an intraday book.
 *
 * Everything else is still the day's: the adjust count, the cooldown, the
 * churn guard, the stuck clock, the warm-up and every guard.
 *
 * ── PACING IS SPLIT, AND DELIBERATELY ───────────────────────────────────────
 * `dl_max_orders_min` is enforced here, in `pace`, because a package's own size
 * is visible to a pure function of one tick. `dl_max_orders_s` and
 * `dl_max_orders_day` are NOT: counting routed orders over a second or a
 * session is the job of the thing that routes them, and the host does it.
 *
 * ── THE TWO GREEK SIGN CONVENTIONS, ONCE, HERE ──────────────────────────────
 * `LegView.delta` is an unsigned MAGNITUDE and `theta`/`gamma` are the
 * CONTRACT's, unsigned by side (`marking.ts`). `strikeGreeks` signs delta by
 * wing and leaves the rest contract-signed. Everything below therefore applies
 * BOTH signs — wing and side — exactly once, in `legDeltaLots` for held legs
 * and in `strikeDeltaLots` for candidates, and nothing downstream reapplies
 * either. A sign applied twice reads as a book leaning the wrong way, which is
 * indistinguishable from a bad strategy until it has paid for itself.
 *
 * ── URGENCY IS A FIELD, AND `makerQuote` IS FALSE EVERYWHERE HERE ───────────
 *   opens and adjustments              `'passive'`  — worked at the touch
 *   the backstop, the latched stop,    `'urgent'`   — crossed now
 *   the 14:55 flatten
 *   the 14:50 flatten                  `'passive'`  — worked, not crossed
 *   the target, the stuck exit, and    `'ladder'`   — it must be out
 *   the residual past `dl_flat_by_min`
 *
 * `makerQuote` means "the liquidity gate refused this strike's book" and this
 * controller never asks that gate, so it has nothing to report and says FALSE.
 *
 * PURE, like the rest of the engine: no clock, no feed, no Mongo. `nowMs`,
 * `dateIst` and `minuteOfDay` are fields of `inputs` so a fixture can replay a
 * session that is long over.
 */

import type { Dials } from '../dials.ts';
import type { ForwardSource } from '../forward.ts';
import { type MarkContext, totalPnl } from '../guards.ts';
import { sellLotSize } from '../ladder.ts';
import { bookSpanLegs, openSpanLeg, spanLiteMargin } from '../margin-project.ts';
import { strikeGreeks } from '../marking.ts';
import { isTradingDay } from '../session.ts';
import type {
  EngineAction,
  EngineDecision,
  EngineInputs,
  LegView,
  OptType,
  RuleState,
  Side,
  Trigger,
  Urgency,
} from '../types.ts';
import { creditUnit, debitUnit, deltaBandStrike } from './express.ts';
import { rollDay } from './lean.ts';
import { readRegime, type Regime, type SpotRing } from './regime.ts';

/**
 * What the controller needs beyond an ordinary `EngineInputs`.
 *
 * Four quantities no snapshot of a chain can carry, each REQUIRED rather than
 * optional for the reason `types.ts` gives: an absent reading and a zero one
 * must never be the same read.
 *
 *   - `ring` is the host's shared spot buffer, one per symbol. The detector
 *     reads it; nothing here writes it.
 *   - `minutesToExpiry` is TRADING minutes, holidays already removed. Pass
 *     calendar minutes and every implied window move is quoted cheap, which
 *     turns ordinary noise into a trend the book acts on.
 *   - `ordersThisMinute` is the book's own count so far this minute, for
 *     `dl_max_orders_min`.
 *   - `spotAsOf` is the epoch ms of the newest tick pushed into `ring`. Derived
 *     from the chain it would be the wrong feed's clock, so the host states it,
 *     off the index feed's own last tick. (`SpotRing.latest()` now exists, for
 *     the playbook frame's index reads; this field is still the staleness
 *     clock new risk is gated on.)
 */
export interface DeltaLeanInputs extends EngineInputs {
  readonly ring: SpotRing;
  readonly minutesToExpiry: number;
  readonly ordersThisMinute: number;
  readonly spotAsOf: number;
  /**
   * The ISO date of the book's contract — the registry row's `expiry`.
   *
   * Read only by a HOLD book (`dl_hold_to_expiry`): its clock ladder runs on
   * this day and any day past it, and on no day before. Required rather than
   * optional for the reason above — an absent expiry must never read as
   * "not today", which would carry an expiring book through its last close.
   */
  readonly expiry: string;

  // ── read only by the PLAYBOOK frame (six-playbooks spec §4) ─────────────
  // OPTIONAL, unlike everything above, and that is the one exception to the
  // rule this interface states: these three were added after every host and
  // fixture that builds a `DeltaLeanInputs`, `decideDeltaLean` reads none of
  // them, and the frame reads each one's absence as UNKNOWN — never as a zero,
  // a "nothing in flight" or a "the forward is fine".

  /**
   * The index's previous session close, for the opening gap. Absent (or
   * null) = UNKNOWN: the gap is unknown, `gapPct` is null, and a rule that
   * needs a gap does not pass.
   */
  readonly prevClose?: number | null;
  /**
   * True while the host has a package for this book on the wire that
   * `pendingLots` does not count yet (posted, not acknowledged). Absent =
   * UNKNOWN, and the frame then has only `pendingLots` to go on.
   */
  readonly inFlight?: boolean;
  /**
   * Which source priced `chain.spot` (spec F1). Absent = UNKNOWN, which the
   * frame treats as not the weekly's own forward: `forwardOk` false.
   */
  readonly forwardSource?: ForwardSource;
}

/** Rupees, grouped as every other reason in this engine groups them. */
export const inr = (x: number): string => `Rs${Math.round(x).toLocaleString('en-US')}`;

/** An IST minute-of-day as `HH:MM`, so a clock gate names a time an operator
 * can find on a chart rather than a minute count. */
export const clock = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Delta-lots are floats; two that agree to a billionth are the same number. */
const EPS = 1e-9;

/** Strike equality, the same tolerance `marking.ts` matches a chain row on. */
const STRIKE_EPS = 1e-6;

const REGIME_NAMES: readonly string[] = ['trend-up', 'trend-down', 'quiet', 'chop', 'unknown'];

const wingSign = (t: OptType): number => (t === 'CE' ? 1 : -1);
const sideSign = (s: Side): number => (s === 'Buy' ? 1 : -1);

/** The book's own last label, read back off a `string` field that is '' before
 * the first classification. '' is 'unknown' — never 'quiet'. */
export function prevRegime(state: RuleState): Regime {
  return REGIME_NAMES.includes(state.dlRegime) ? (state.dlRegime as Regime) : 'unknown';
}

/** One leg's contribution to the book's net delta, in DELTA-LOTS: both signs —
 * wing and side — applied exactly once, here. */
function legDeltaLots(leg: LegView): number {
  return wingSign(leg.optType) * sideSign(leg.side) * Math.abs(leg.delta) * leg.lots;
}

/**
 * Is the index price too old to take NEW RISK against?
 *
 * A refusal of new risk and nothing more. Deciding an EXIT on a price ten
 * seconds old is safer than not exiting; opening or adjusting on one is paying
 * a spread for a position the book cannot currently see.
 */
function spotStale(inputs: DeltaLeanInputs, dials: Dials): boolean {
  return (inputs.nowMs - inputs.spotAsOf) / 1000 > dials.dl_spot_stale_s;
}

// ── decisions ───────────────────────────────────────────────────────────────
//
// `hold`, `wait`, `acted`, `closeAll`, `exitDecision`, `pace`, the sizing walk
// (`projectFits`, `fitLots`, `scaleLots`), `confirmed`, `prevRegime`, `inr` and
// `clock` are EXPORTED for the playbook frame (`playbook/decide.ts`, six-
// playbooks spec §4), which runs on this path and must build its holds, its
// closes and its sizing exactly as this engine does — one copy, so the two
// cannot drift. Exporting them changes nothing here.

/** A hold: no actions, so there is no acting delta to leave out of `markState`
 * and the two states are the same value by construction (`types.ts`). */
export function hold(reason: string, state: RuleState, trigger: Trigger = 'none'): EngineDecision {
  return {
    action: 'hold',
    trigger,
    reason,
    actions: [],
    stateAfter: state,
    markState: state,
    urgency: 'passive',
    makerQuote: false,
    creditCommit: null,
  };
}

/**
 * A hold that is WAITING rather than BLOCKED — and so RESETS §6.4's clock.
 *
 * Every hold on this path is one or the other, and the difference is the whole
 * stuck rule: a WAIT clears by itself (the tape changes its mind, the cooldown
 * runs out, the repair finishes, the minute rolls over), a BLOCK cannot (the
 * SPAN cap, `dl_max_adjusts_day`). `stuckExit` is the ONLY writer of a non-zero
 * `dlBlockedSinceMs`, and this is the only other way to answer, so "every wait
 * resets the clock" is structural rather than nine copies of the same spread
 * that one future branch forgets.
 *
 * The gates ABOVE §6.2 are waits too, and for a sharper reason: they do not
 * EVALUATE the block at all. A tick held by a working package or a repair hold
 * is no evidence that an adjustment is still refused, and §6.4's window is one
 * continuous stretch of ticks that looked and found it — carrying the clock
 * across ticks that never looked would fire a ladder on a five-minute-old
 * reading.
 */
export function wait(reason: string, state: RuleState): EngineDecision {
  return hold(reason, { ...state, dlBlockedSinceMs: 0 });
}

/**
 * A package.
 *
 * No stamping and no clock. The v1 version wrote a lean id onto every open and
 * a `dlLastAddMs` beside it, in here, so a new open site could not forget
 * either; this engine has no lean and stamps its cooldown at the two sites that
 * form a package (the open and the adjustment), because those are the only two
 * and each writes a different set of counters beside it.
 */
export function acted(
  action: 'adjust' | 'flatten',
  trigger: Trigger,
  reason: string,
  actions: readonly EngineAction[],
  stateAfter: RuleState,
  markState: RuleState,
  urgency: Urgency,
): EngineDecision {
  return {
    action,
    trigger,
    reason,
    actions,
    stateAfter,
    markState,
    urgency,
    // ALWAYS false on this path: `makerQuote` is the liquidity gate's refusal
    // (`shed.ts` §4) and this controller never asks that gate.
    makerQuote: false,
    creditCommit: null,
  };
}

/**
 * Close the whole book, SHORTS FIRST.
 *
 * Spec §6.5's leg ordering, on the way out: the short is bought back before the
 * long or the wing is sold, so the book is never naked — not even for the
 * instant between two fills, which is exactly when an index gaps.
 */
export function closeAll(legs: readonly LegView[]): readonly EngineAction[] {
  const ordered = [...legs].sort((a, b) => sideSign(a.side) - sideSign(b.side));
  return ordered.map((l): EngineAction => ({ op: 'close', instrument: l.instrument }));
}

/**
 * THE ONE PLACE A `closeAll` BECOMES A DECISION — so the four exits of §6.5
 * cannot drift apart on how they latch.
 *
 * `latchWhenFlat` false means "latch NOW, on both states", and it is what
 * `dl-stop`, `dl-target` and `dl-stuck` all pass: none of their triggers
 * survives its own flatten (the header spells out the three reasons), and an
 * opened, legless, unlatched book is handed straight back to §6.2. Step 1
 * carries out whatever a partial fill left behind.
 *
 * Only the flatten windows latch once the book is flat. Their trigger — the
 * clock — plainly does survive, and re-deciding each tick is what walks the
 * passive/urgent/ladder escalation; an immediate latch would send every
 * residual to step 1's urgent flatten and delete the 14:50 passive window.
 */
export function exitDecision(
  inputs: DeltaLeanInputs,
  trigger: Trigger,
  reason: string,
  urgency: Urgency,
  st: RuleState,
  latchWhenFlat: boolean,
): EngineDecision {
  const { legs } = inputs;
  if (legs.length === 0) {
    return hold(`${reason} — flat already`, { ...st, dlStopped: true }, trigger);
  }
  const after: RuleState = latchWhenFlat ? st : { ...st, dlStopped: true };
  return acted(
    'flatten',
    trigger,
    `${reason} — closing all ${legs.length} leg(s)`,
    closeAll(legs),
    after,
    after,
    urgency,
  );
}

/**
 * The per-minute order budget, applied to the CONTROLLER's package only — a
 * guard flatten is never budgeted.
 *
 * Opens go first and go WHOLE: half a debit pair is a naked leg, and a naked
 * leg is the one outcome every ordering rule in this file exists to prevent.
 * Exits survive to the last slot, because a book that cannot place its exit is
 * in more trouble than a book that cannot place its add.
 */
export function pace(
  actions: readonly EngineAction[],
  inputs: DeltaLeanInputs,
  dials: Dials,
): readonly EngineAction[] {
  const budget = dials.dl_max_orders_min - inputs.ordersThisMinute;
  if (budget >= actions.length) return actions;
  const exits = actions.filter((a) => a.op !== 'open');
  if (budget >= exits.length) return exits;
  return exits.slice(0, Math.max(0, budget));
}

// ── the margin cap (D4, §6.3) ───────────────────────────────────────────────

/** The `'open'` arm, narrowed once so the sizing helpers can read a `strike`
 * and a `side` without re-narrowing at every call site. */
type OpenAction = Extract<EngineAction, { op: 'open' }>;

/**
 * DOES THE WHOLE PACKAGE FIT UNDER `margin_cap`? (D4.)
 *
 * The cap is priced on the BOOK PLUS THE PACKAGE with `spanLiteMargin`, never
 * on the package alone, because that is the only way a hedged or cross-side leg
 * gets its offset: a 4-lot short call against a 4-lot long call one strike in
 * is a bounded spread the grid prices as one, and a per-leg naked figure would
 * refuse the entire strategy.
 *
 * It is also why this is a projection and not a reading of `inputs.margin`: the
 * broker's number describes the book that exists, and this question is about
 * the book the package would create.
 */
export function projectFits(
  inputs: DeltaLeanInputs,
  dials: Dials,
  opens: readonly EngineAction[],
): boolean {
  const { chain, dateIst, legs } = inputs;
  // `sellLotSize` and `openSpanLeg` are the RECENTER projection's own two, not
  // lookalikes: `projectMarginCap` prices its Sell opens with exactly this
  // pair, so the two cap gates on this desk cannot come to price the same
  // package differently. The lot is the book's first short's, and the chain's
  // only when the book holds no short — a lot read off the chain while the
  // book is carrying a different one would size the whole package in the wrong
  // unit, and SPAN-lite would report the wrong number without ever erroring.
  const lotSize = sellLotSize(legs, chain);
  const projected = [
    ...bookSpanLegs(legs, chain.expiry),
    ...opens
      .filter((a): a is OpenAction => a.op === 'open')
      .map((a) => openSpanLeg(a, lotSize, chain.expiry)),
  ];
  if (projected.length === 0) return true;
  return spanLiteMargin(projected, chain.spot, dateIst).total <= dials.margin_cap;
}

/** The same package at `lots` a leg. `express.ts` builds its structures one lot
 * a leg and the caller scales them, so that the structure and the size are
 * decided in different places and neither can quietly imply the other. */
export function scaleLots(actions: readonly EngineAction[], lots: number): readonly EngineAction[] {
  return actions.map((a) => (a.op === 'open' ? { ...a, lots } : a));
}

/**
 * THE LARGEST SIZE THAT FITS, BY TRUNCATION — never by rounding up (§6.3).
 *
 * Walked DOWN from `maxLots`, so a cap that lands between two sizes always
 * takes the smaller, and 0 is a real answer meaning "not even one lot". The
 * walk is linear rather than a binary search because `maxLots` here is
 * `dl_open_lots` (2-4) or an adjustment's computed lots (single digits), and a
 * loop that is obviously correct beats one that is merely fast — `spanLiteMargin`
 * is a 21-scenario grid over a handful of legs.
 */
export function fitLots(
  inputs: DeltaLeanInputs,
  dials: Dials,
  unit: readonly EngineAction[],
  maxLots: number,
): number {
  for (let n = Math.max(0, Math.trunc(maxLots)); n >= 1; n -= 1) {
    if (projectFits(inputs, dials, scaleLots(unit, n))) return n;
  }
  return 0;
}

// ── the open (§6.1) ─────────────────────────────────────────────────────────

/**
 * THE DAY'S ONE PACKAGE, hedge included (D3).
 *
 *   `trend-up`   a CE debit pair: buy the `dl_long_delta` band, sell the
 *                `dl_short_delta` band further out. The SHORT IS THE HEDGE.
 *   `trend-down` the same on the put ladder.
 *   `quiet`      both credit units — the strangle, whose two WINGS are its
 *                hedge.
 *
 * `null` for `chop` and `unknown`, and for a chain the bands cannot be found
 * on. `'unknown'` is not `'quiet'`: quiet is the one regime that SELLS premium,
 * and a strangle sold into a chain that stopped printing is the worst thing
 * this engine can cause.
 *
 * The package is margin-projected and TRUNCATED down to what fits. If not one
 * lot fits it does not go on — and the stuck rule does not apply, because a
 * book that never opened has nothing to lose.
 */
function openPackage(
  inputs: DeltaLeanInputs,
  dials: Dials,
  regime: Regime,
): {
  readonly actions: readonly EngineAction[];
  readonly side: 'up' | 'down' | 'none';
  /** The size that FITTED, which is `dl_open_lots` unless the cap trimmed it.
   * Returned rather than re-derived off `actions[0]`, so the ledger can say so
   * and a trim from four lots to two leaves a trace. */
  readonly lots: number;
} | null {
  const { chain, dateIst, minuteOfDay } = inputs;
  const side: 'up' | 'down' | 'none' | null =
    regime === 'trend-up' ? 'up' : regime === 'trend-down' ? 'down' : regime === 'quiet' ? 'none' : null;
  if (side === null) return null;

  let unit: readonly EngineAction[];
  if (side === 'none') {
    // Two credit units, one each way. `creditUnit` takes its own lots, so build
    // both at one lot and let `fitLots` scale the pair together — sizing the
    // two sides independently could leave a strangle lopsided.
    const up = creditUnit(chain, 'up', 1, dials, dateIst, minuteOfDay);
    const down = creditUnit(chain, 'down', 1, dials, dateIst, minuteOfDay);
    if (up === null || down === null) return null;
    unit = [...up, ...down];
  } else {
    const pair = debitUnit(chain, side, dials, dateIst, minuteOfDay);
    if (pair === null) return null;
    unit = pair;
  }

  const lots = fitLots(inputs, dials, unit, dials.dl_open_lots);
  if (lots === 0) return null;
  return { actions: scaleLots(unit, lots), side, lots };
}

/**
 * Has the current regime held long enough to justify a package?
 *
 * `dlRegimeSinceMs` 0 is "no reading yet" and never confirms — a book whose
 * clock was never stamped has not measured anything. The comparison is
 * INCLUSIVE: exactly `dl_adjust_confirm_s` later is confirmed, because a gate
 * that fired one tick late would be a different dial.
 */
export function confirmed(st: RuleState, dials: Dials, nowMs: number): boolean {
  return st.dlRegimeSinceMs !== 0 && nowMs - st.dlRegimeSinceMs >= dials.dl_adjust_confirm_s * 1000;
}

/**
 * The dial that lets a confirmed `regime` open the day's package (delta-lean-
 * zero spec D4), or `null` for the two readings `openPackage` has no structure
 * for — `chop` and `unknown` — which no switch can give one.
 */
function openSwitch(regime: Regime): 'dl_open_trend_up' | 'dl_open_trend_down' | 'dl_open_quiet' | null {
  if (regime === 'trend-up') return 'dl_open_trend_up';
  if (regime === 'trend-down') return 'dl_open_trend_down';
  if (regime === 'quiet') return 'dl_open_quiet';
  return null;
}

/**
 * THE FALLBACK'S MINUTE (delta-lean-zero spec D5): may this pass open the
 * QUIET package with no confirmed regime behind it?
 *
 * Only inside `dl_open_by_min`'s own minute, with the fallback on and quiet
 * allowed — the fallback IS the quiet package, so a book that sells no condor
 * sells no fallback condor either — and never on `'unknown'`: no reading never
 * sells premium, here exactly as at the confirmed open. The replay this
 * mirrors had one try, at the minute's close; a pass that waits inside the
 * minute here (an order in flight, a stale index) tries again on the next.
 */
function fallbackMinute(inputs: DeltaLeanInputs, dials: Dials, regime: Regime): boolean {
  return (
    dials.dl_open_fallback &&
    dials.dl_open_quiet &&
    dials.dl_open_by_min > 0 &&
    inputs.minuteOfDay === dials.dl_open_by_min &&
    regime !== 'unknown'
  );
}

// ── the posture (§6.2) ──────────────────────────────────────────────────────

/**
 * The book's NET DELTA, in delta-lots, and whether it can be believed.
 *
 * `priced` false is the `hasGreeks` contract carried up a level: a book with
 * one unsolved leg has no measurable delta, and the caller HOLDS rather than
 * sizing an order against a sum that is missing a term. It is NOT a zero
 * (`types.ts`: absent is never zero) — a zero would read as a flat book, which
 * is the one reading that makes the engine act.
 */
function netDeltaLots(legs: readonly LegView[]): { readonly lots: number; readonly priced: boolean } {
  let lots = 0;
  let priced = true;
  for (const leg of legs) {
    if (!leg.hasGreeks) {
      priced = false;
      continue;
    }
    lots += legDeltaLots(leg);
  }
  return { lots, priced };
}

/**
 * `D` — THE HEDGED PAIR'S OWN NET DELTA, in delta-lots (§6.2).
 *
 * `dl_open_lots` x (mid(long band) - mid(short band)) = 4 x (0.60 - 0.25) =
 * 1.4. BOTH bands, because the unit the book actually opens is a PAIR and its
 * short leg carries delta too: a 4-lot 0.556/0.297 pair is ~1.04 delta-lots,
 * not ~2.2. So a freshly opened trend book MEETS ITS OWN POSTURE, which is the
 * whole point of defining D this way. Taken off the long band alone it would
 * read as permanently short of itself, and every tick after the open would want
 * a pyramid it had no business wanting.
 */
function unitDelta(dials: Dials): number {
  const long = (dials.dl_long_delta_lo + dials.dl_long_delta_hi) / 2;
  const short = (dials.dl_short_delta_lo + dials.dl_short_delta_hi) / 2;
  return dials.dl_open_lots * (long - short);
}

/**
 * WHERE THE REGIME WANTS THE BOOK'S DELTA — relative to the side it OPENED.
 *
 * Three modes, and the difference between them is the operator's rule
 * "neutralise by adding, never reverse":
 *
 *   `lean`     The trend is the direction the book opened. Target +-D,
 *              ONE-SIDED: short of it, buy more of the open's own option — the
 *              pyramid. Past it, nothing, because a book that has run is never
 *              sold down and this engine owns no rule that could sell it.
 *   `counter`  The trend is AGAINST the open, or it is any trend on a strangle
 *              book (`'none'`). Target ZERO, ONE-SIDED TOWARDS IT: buy the
 *              REGIME's option only while the book leans against the regime.
 *              Never past zero — a flip NEUTRALISES, so a long open can never
 *              end the day short. A book already on the regime's side is asked
 *              for nothing at all.
 *   `flat`     Quiet or chop. Target zero, TWO-SIDED: sell the same-side option
 *              in the ATM neutral band to bring the net back inside the band.
 *
 * `direction` is the only sign of gap the posture will act on, and it is what
 * carries the one-sidedness: `+1` will only ever add LONG delta, `-1` only
 * short, `0` (the `'flat'` case alone) either.
 *
 * `null` for `'unknown'`: no reading, no posture, and nothing is done.
 */
type PostureMode = 'lean' | 'counter' | 'flat';

interface Posture {
  readonly mode: PostureMode;
  readonly target: number;
  readonly direction: 1 | -1 | 0;
}

function wantedPosture(
  regime: Regime,
  openSide: RuleState['dlOpenSide'],
  dials: Dials,
): Posture | null {
  if (regime === 'quiet' || regime === 'chop') {
    return { mode: 'flat', target: 0, direction: 0 };
  }
  if (regime === 'trend-up') {
    return openSide === 'up'
      ? { mode: 'lean', target: unitDelta(dials), direction: 1 }
      : { mode: 'counter', target: 0, direction: 1 };
  }
  if (regime === 'trend-down') {
    return openSide === 'down'
      ? { mode: 'lean', target: -unitDelta(dials), direction: -1 }
      : { mode: 'counter', target: 0, direction: -1 };
  }
  return null;
}

/**
 * How many delta-lots the book is SHORT OF ITS POSTURE, signed — or 0 when the
 * posture is met.
 *
 * `+` means the book needs MORE long delta, `-` more short. A posture with a
 * `direction` reports a gap of THAT SIGN ONLY, which is what makes "adds only"
 * and "never reverse" the same line of code: a `lean` book past its target
 * reports 0 rather than a sale, and a `counter` book already on the regime's
 * side reports 0 rather than a reversal.
 */
function postureGap(posture: Posture, net: number, band: number): number {
  const gap = posture.target - net;
  if (Math.abs(gap) <= band + EPS) return 0;
  if (posture.direction === 0) return gap;
  return Math.sign(gap) === posture.direction ? gap : 0;
}

/**
 * THE ONE LEG THAT EXPRESSES A GAP — at one lot, with the lots wanted beside it
 * so the caller can shrink it against the cap without rebuilding it.
 *
 * Four rows, and every one of them is an ADD (§6.2):
 *
 *   `lean`/`counter`, gap > 0    BUY a CE at the long band
 *   `lean`/`counter`, gap < 0    BUY a PE at the long band
 *   `flat`, gap < 0 (net long)   SELL a CE in the neutral band
 *   `flat`, gap > 0 (net short)  SELL a PE in the neutral band
 *
 * The two `flat` rows are the only adjustment that ADDS MARGIN; the buy is a
 * debit and always fits (§6.3), which is what makes the counter-trend
 * neutralisation unconditional. The sideways sale is picked in
 * `dl_neutral_short_delta`, the ATM band: the operator asked for an ITM sale,
 * and ATM carries the same net-delta effect with more time value and a better
 * book (D5) — with the band as the dial, so it can be pushed in.
 *
 * The BUY's option type falls out of the GAP'S SIGN, and on both buying modes
 * that sign agrees with the regime by construction: a `lean` gap points the way
 * the book opened, which is the way the trend is going, and a `counter` gap
 * points from the book's own delta back towards zero, which is also the way the
 * trend is going. So §6.2's "buy the open's option" and "buy the regime's
 * option" are the same instruction, and there is one branch rather than two.
 *
 * `null` when the band holds no tradable strike. "Nearest miss" is how a book
 * ends up 40% off its posture while every individual decision looks defensible.
 */
function adjustmentPackage(
  inputs: DeltaLeanInputs,
  dials: Dials,
  gap: number,
  mode: PostureMode,
): { readonly unit: readonly EngineAction[]; readonly lots: number } | null {
  const { chain, dateIst, minuteOfDay, legs } = inputs;
  const selling = mode === 'flat';
  const optType: OptType = selling ? (gap < 0 ? 'CE' : 'PE') : gap > 0 ? 'CE' : 'PE';
  const side: Side = selling ? 'Sell' : 'Buy';
  const [lo, hi] = selling
    ? [dials.dl_neutral_short_delta_lo, dials.dl_neutral_short_delta_hi]
    : [dials.dl_long_delta_lo, dials.dl_long_delta_hi];

  /**
   * AN ADJUSTMENT MAY NEVER LAND ON A STRIKE THE BOOK HOLDS ON THE OTHER SIDE.
   *
   * An opposite-side fill on an instrument the book already holds is NOT a new
   * leg anywhere downstream: the paper fold (and the broker) NETS it into the
   * held position. So the "adjustment" is a partial CLOSE of a leg this engine
   * promised to hold to the close — D2's one prohibition, arrived at without
   * any exit ever deciding it and without a `closeAll` to order the legs. And
   * it is SILENT: the ledger reads `dl-neutral, selling 4 lots` while the book
   * quietly shrinks.
   *
   * BOTH directions, because both are reachable and the expensive one is the
   * BUY:
   *
   *   a SELL onto a held long  the `flat` sideways sale, whose neutral band
   *                            (0.45-0.60) is where a trend book's own long leg
   *                            sits once it has run — it closes the position
   *                            the day was built on.
   *   a BUY onto a held short  the `lean` pyramid or the `counter` buy, out of
   *                            the long band (0.55-0.65) — and THE OPEN'S HEDGE
   *                            DRIFTS INTO IT. The hedge is sold at 0.20-0.30
   *                            delta and a trending day carries it up through
   *                            0.55, so the pyramid that expresses the trend
   *                            picks the hedge's own strike and nets away the
   *                            one leg D3 says is held all day. The book is
   *                            then naked in the direction it is pyramiding.
   *
   * SAME-SIDE IS FINE, and deliberately untouched: adding to a leg the book
   * already holds on the SAME side grows it, which is an ADD. Refusing that
   * would take the pyramid away from the strike it most wants and the sideways
   * sale away from the books that have already used it once.
   */
  const opposite: Side = side === 'Buy' ? 'Sell' : 'Buy';
  const heldOpposite = (k: number): boolean =>
    legs.some(
      (l) => l.optType === optType && l.side === opposite && Math.abs(l.strike - k) < STRIKE_EPS,
    );
  const strike = deltaBandStrike(
    chain, optType, lo, hi, dateIst, minuteOfDay, dials,
    (k) => !heldOpposite(k),
  );
  // `null` — the band holds no strike this book may sell — falls through to the
  // caller's existing "no tradable strike in the band" WAIT.
  if (strike === null) return null;

  const g = strikeGreeks(chain, strike, optType, dateIst, minuteOfDay);
  if (g === null) return null;
  // What ONE LOT of this leg does to the book's net delta, both signs applied
  // once — `strikeGreeks` signs by wing, this applies the side.
  const perLot = sideSign(side) * g.delta;
  if (!Number.isFinite(perLot) || Math.abs(perLot) < EPS) return null;
  // The gap and the leg must point the same way, or the leg is the wrong one.
  if (Math.sign(perLot) !== Math.sign(gap)) return null;

  // `max(1, round(...))` — §6.2's own formula. A round alone can be 0 on a gap
  // barely past the dead band, and an adjustment worth deciding is worth a lot.
  // ROUNDING rather than flooring is what lets a `counter` package land ON zero
  // rather than stopping short of it; it can overshoot by at most half a
  // strike's delta.
  const rounded = Math.max(1, Math.round(Math.abs(gap) / Math.abs(perLot)));
  // AND THE OVERSHOOT IS CLAMPED, so "never reverses" does not depend on a
  // dial. Half a strike's delta is inside the SHIPPED 0.5 dead band, which is
  // why the rounding is safe today — but `dl_dead_band_lots` is a dial, and at
  // 0.1 the same round would fold a long book to net SHORT and end the day on
  // the other side of the open. A `counter` package may therefore land no
  // further than one dead band past zero; one lot less is still a move towards
  // zero, and 1 is the floor because a wanted neutralisation that sends nothing
  // is the failure this posture exists to prevent.
  const overshoots =
    mode === 'counter' &&
    rounded * Math.abs(perLot) > Math.abs(gap) + dials.dl_dead_band_lots + EPS;
  const lots = overshoots ? Math.max(1, rounded - 1) : rounded;
  /**
   * AND A SAME-SIDE STRIKE IS MARKED AS THE ADD IT IS. `book.ts` refuses an
   * open on a contract the book already holds unless `add: true` says so —
   * its guard against a decision repeating itself — so an unmarked add was
   * skipped as "already open" and the book stayed off its target delta
   * (352 refused packages, 25 Sep–30 Oct 2026). The playbook frame marks its
   * own the same way (`openOf`, spec F4).
   */
  const heldSame = legs.some(
    (l) => l.optType === optType && l.side === side && Math.abs(l.strike - strike) < STRIKE_EPS,
  );
  return {
    unit: [
      heldSame
        ? { op: 'open', strike, optType, side, lots: 1, add: true }
        : { op: 'open', strike, optType, side, lots: 1 },
    ],
    lots,
  };
}

/**
 * `dl-add` or `dl-neutral` — the ledger's word for what a package IS.
 *
 * A PYRAMID is exactly the `lean` mode: the trend is the direction the book
 * opened, and this is more of the same bet. `counter` and `flat` are both
 * CORRECTIONS — a flip neutralised to zero, a threatened strangle, a sideways
 * sale — and an operator reading a journal needs those two apart: one is
 * conviction, the other is damage control.
 *
 * Read off the MODE and nothing else, so the trigger and the rule that produced
 * the package can never disagree about which one happened.
 */
function adjustTrigger(posture: Posture): Trigger {
  return posture.mode === 'lean' ? 'dl-add' : 'dl-neutral';
}

// ── the stuck exit (§6.4) ───────────────────────────────────────────────────

/**
 * "CAP REACHED, NO MOVE CAN STILL MAKE MONEY, MINIMISE THE DOWNSIDE."
 *
 * Two conditions, both required, and BOTH must hold CONTINUOUSLY for
 * `dl_stuck_confirm_s`:
 *
 *   1. an adjustment is WANTED but blocked — by the SPAN cap, or by
 *      `dl_max_adjusts_day`, and by nothing else;
 *   2. `totalPnl <= -dl_stuck_loss`.
 *
 * `dlBlockedSinceMs` is the clock and ANY tick where either condition clears
 * resets it to 0, so the window measures one continuous stretch rather than a
 * total. Measured as a total, a book that was blocked all morning and losing
 * all afternoon would exit on two conditions that never once held together.
 *
 * WHY A COOLDOWN AND A SAME-REGIME HOLD DO NOT ARM IT: both clear by
 * themselves — the first in ten minutes, the second the moment the tape changes
 * its mind — so the book is not stuck, it is waiting. Arming on those would
 * turn the engine's own patience into a stop, which is the exact failure mode
 * this whole design exists to remove. It is also why the margin gate runs ABOVE
 * those three in the pass: a cap-blocked book in a trend that merely persists
 * would otherwise reset its own clock on the churn guard for ever.
 *
 * The exit is a LADDER, like the target: it must be out, and it is not an
 * emergency. And like the target and the backstop it latches IMMEDIATELY, on
 * both states, because its trigger does not survive its own flatten: the
 * condition is "an adjustment is wanted but blocked", and the moment the ladder
 * fills there is no book, nothing is wanted, an empty book fits under any cap,
 * and nothing calls this function again. `dlStopped` left false there hands a
 * book that just paid a ladder to get flat straight back to §6.2, which reads a
 * `lean` gap of the whole D against nothing and routes a fresh UNHEDGED
 * pyramid. The remainder of a partial fill is carried out by step 1 instead.
 */
function stuckExit(
  inputs: DeltaLeanInputs,
  dials: Dials,
  st: RuleState,
  why: string,
): EngineDecision {
  const { nowMs } = inputs;
  const pnl = totalPnl(inputs);
  if (pnl > -dials.dl_stuck_loss) {
    return wait(
      `${why} — but ${inr(pnl)} is inside the ${inr(-dials.dl_stuck_loss)} stuck floor, so the clock is not running`,
      st,
    );
  }
  // 0 is "not yet started", so the first blocked-and-losing tick stamps NOW and
  // every tick after it leaves the stamp alone.
  const since = st.dlBlockedSinceMs === 0 ? nowMs : st.dlBlockedSinceMs;
  const armed: RuleState = { ...st, dlBlockedSinceMs: since };
  const heldMs = nowMs - since;
  if (heldMs < dials.dl_stuck_confirm_s * 1000) {
    const leftS = ((dials.dl_stuck_confirm_s * 1000 - heldMs) / 1000).toFixed(0);
    return hold(
      `${why} at ${inr(pnl)} — ${leftS}s left of the ${dials.dl_stuck_confirm_s}s stuck window`,
      armed,
    );
  }
  return exitDecision(
    inputs,
    'dl-stuck',
    `stuck: ${why} at ${inr(pnl)} for ${dials.dl_stuck_confirm_s}s — no move can still help, minimising the downside`,
    'ladder',
    armed,
    // LATCH NOW, on both states — see above. The flatten is still a ladder.
    false,
  );
}

/**
 * Steps 3-4 ON A HOLD BOOK: the backstop and the target fire on a reading that
 * has STOOD `dl_rupee_hold_s`, on `dlRupeeSinceMs` — the playbook frame's
 * `dayLines`, one clock for both lines.
 *
 * A hold book carries its legs overnight, and its first passes at 09:15 mark
 * them off a BLEND: legs already printing on today's book, at its wide opening
 * spreads, beside legs still on the last session's. That read Rs-16,289
 * through a Rs-15,000 floor on a book whose close then banked +Rs7,797, seven
 * of its nine legs inside three seconds (19 Oct), and Rs14,853 past a Rs10,000
 * target against +Rs8,645 a second later (22 Oct) — and both latched the book
 * until expiry. Every opening swing on file was gone by the desk's next 15s
 * mark, 18s in at most.
 *
 * NO AT-ONCE ESCAPE on the loss side, unlike the frame's `BACKSTOP_AT_ONCE`:
 * the 19 Oct blend was a ₹24,000 swing, 1.6 x the conservative floor, so no
 * multiple of it tells a blend from a crash; the hold itself is the bound. A
 * FLAT book acts at once — banked rupees have no mark in them to doubt.
 *
 * An intraday book returns here untouched and fires on the first mark: it is
 * flat until the warm-up and overnight, so it never carries a stale open.
 */
function heldLine(
  inputs: DeltaLeanInputs,
  dials: Dials,
  st: RuleState,
  holdBook: boolean,
  through: boolean,
): { readonly fire: boolean; readonly heldFor: string; readonly state: RuleState } {
  if (!holdBook) return { fire: through, heldFor: '', state: st };
  const since = through ? (st.dlRupeeSinceMs > 0 ? st.dlRupeeSinceMs : inputs.nowMs) : 0;
  const state = since === st.dlRupeeSinceMs ? st : { ...st, dlRupeeSinceMs: since };
  const holdS = dials.dl_rupee_hold_s;
  if (inputs.legs.length === 0 || holdS <= 0) return { fire: through, heldFor: '', state };
  return { fire: through && inputs.nowMs - since >= holdS * 1000, heldFor: `, held ${holdS}s`, state };
}

// ── the pass ────────────────────────────────────────────────────────────────

/**
 * One decision pass over one tick of one delta-lean book.
 *
 * `markCtx` is accepted so both decide paths present one signature to
 * `EngineHost` and is deliberately unread: the 5-minute mark grid is the
 * recenter engine's, and spec §10 requires it not to gate this variant's
 * per-second evaluation.
 */
export function decideDeltaLean(
  inputs: DeltaLeanInputs,
  dials: Dials,
  state: RuleState,
  markCtx: MarkContext,
): EngineDecision {
  void markCtx;
  const { legs, minuteOfDay, dateIst, nowMs } = inputs;
  // A HOLD book's exits are the BOOK's, not the day's (header, "HOLD TO
  // EXPIRY"); the word is all that differs in the reasons below.
  const holdBook = dials.dl_hold_to_expiry;
  const scope = holdBook ? 'book' : 'day';

  // ── 0. the day roll ──────────────────────────────────────────────────────
  const rolled = rollDay(state, dateIst, nowMs, holdBook);

  // ── 1. the latched stop ──────────────────────────────────────────────────
  // Through `exitDecision` like the other three, and not by hand: the row is
  // ALREADY latched here, so both of its arms are no-ops on the state and the
  // only thing a second copy of this code could ever do is drift from the one
  // place §6.5's closes are built.
  if (rolled.dlStopped) {
    const why = holdBook ? 'stopped until expiry' : 'stopped for the day';
    return exitDecision(inputs, 'dl-stop', why, 'urgent', rolled, false);
  }

  // ── 2. the clock ─────────────────────────────────────────────────────────
  // ABOVE the session gate: a book that woke up after 15:00 still carrying has
  // nothing else between it and an overnight position. A HOLD book runs it on
  // its contract's expiry day — and on any day PAST it, so a book a missed roll
  // left running on a dead contract ladders out rather than sitting. On every
  // day before expiry the overnight position is the plan and this is skipped.
  // ISO dates, so the string order is the calendar order.
  const clockRuns = !holdBook || dateIst >= inputs.expiry;
  if (clockRuns && minuteOfDay >= dials.dl_flat_by_min) {
    return exitDecision(
      inputs, 'eod',
      `${clock(minuteOfDay)} is past the ${clock(dials.dl_flat_by_min)} flat-by`,
      'ladder', rolled, true,
    );
  }
  if (clockRuns && minuteOfDay >= dials.dl_flatten_urgent_min) {
    return exitDecision(inputs, 'eod', `${clock(minuteOfDay)}: urgent flatten`, 'urgent', rolled, true);
  }
  if (clockRuns && minuteOfDay >= dials.dl_flatten_passive_min) {
    return exitDecision(
      inputs, 'eod', `${clock(minuteOfDay)}: passive flatten — worked, not crossed`,
      'passive', rolled, true,
    );
  }

  // ── 3. the day-loss backstop (D6) ────────────────────────────────────────
  // `totalPnl` is banked plus the open book's mark. It latches IMMEDIATELY, on
  // both states — see `exitDecision`. `cumRealized` is the TAG's bank, so on a
  // hold book this one figure is already the book's lifetime P&L. A hold book
  // fires either line only on a reading held `dl_rupee_hold_s` (`heldLine`).
  const pnl = totalPnl(inputs);
  const below = pnl <= -dials.dl_day_max_loss;
  // 0 is OFF: without the guard a flat book's 0 would be "at or past" a ₹0
  // target on its first tick and latch the day before it ever opened.
  const above = dials.dl_day_target > 0 && pnl >= dials.dl_day_target;
  const line = heldLine(inputs, dials, rolled, holdBook, below || above);
  const lined = line.state;
  if (below && line.fire) {
    return exitDecision(
      inputs, 'dl-stop',
      `${scope} backstop: ${inr(pnl)} through the ${inr(-dials.dl_day_max_loss)} floor${line.heldFor}`,
      'urgent', lined, false,
    );
  }

  // ── 4. the day target ────────────────────────────────────────────────────
  if (above && line.fire) {
    // LATCHES IMMEDIATELY, on both states: `pnl` is a MARK and the ladder
    // takes the mark away with the legs, so the trigger does not survive its
    // own flatten — see `exitDecision`.
    return exitDecision(
      inputs, 'dl-target',
      `${scope} target: ${inr(pnl)} at or past ${inr(dials.dl_day_target)}${line.heldFor} — banking it`,
      'ladder', lined, false,
    );
  }

  // ── 4½. the overnight freeze (hold books only) ───────────────────────────
  // A hold book carrying overnight STANDS STILL from the intraday flatten slot
  // to the close: the intraday books never trade that half hour, and it is the
  // thinnest part of the session. BELOW the four exits, so the target, the
  // backstop and the latched stop still run; above every gate, so nothing opens
  // or adjusts. Tomorrow's warm-up is what resumes it. A WAIT: nothing is
  // blocked, so the stuck clock has nothing to measure.
  if (!clockRuns && minuteOfDay >= dials.dl_flatten_passive_min) {
    return wait(
      `${clock(minuteOfDay)}: holding overnight — no adjustments after the intraday flatten slot`,
      lined,
    );
  }

  // ── 5. the gates ─────────────────────────────────────────────────────────
  if (!isTradingDay(dateIst)) return wait(`${dateIst} is not an NSE trading day`, lined);

  // The DETECTOR runs before the warm-up returns: 09:15-09:30 classifies on all
  // three windows and places nothing, so the first tradable minute has a warm
  // slow window rather than a cold one.
  const read = readRegime(
    inputs.ring,
    inputs.chain,
    nowMs,
    inputs.minutesToExpiry,
    dials,
    prevRegime(lined),
    lined.dlRegimeSinceMs === 0 ? null : lined.dlRegimeSinceMs,
  );
  // The regime clock restamps on a CHANGE and only on a change: it is the
  // confirmation reference for the open and for every adjustment, so restamping
  // it on an unchanged reading would mean no regime ever confirms.
  const st: RuleState =
    read.slow === lined.dlRegime
      ? lined
      : { ...lined, dlRegime: read.slow, dlRegimeSinceMs: nowMs };

  if (minuteOfDay < dials.dl_warmup_min) {
    return wait(
      `warm-up: ${clock(minuteOfDay)} is before ${clock(dials.dl_warmup_min)} — the detector ran (${read.slow}), no orders`,
      st,
    );
  }
  if (inputs.repairHold) {
    return wait('repair-Apply is working this tag — standing down until it finishes', st);
  }
  if (inputs.pendingLots > 0) {
    return wait(`working package: ${inputs.pendingLots} lots still being worked`, st);
  }
  if (spotStale(inputs, dials)) {
    const ageS = (nowMs - inputs.spotAsOf) / 1000;
    return wait(
      `the index is ${ageS.toFixed(1)}s stale, past ${dials.dl_spot_stale_s}s — no new risk (exits still run)`,
      st,
    );
  }

  // ── 6. the open (§6.1) ───────────────────────────────────────────────────
  if (st.dlOpenedMs === 0) {
    // The DAY and the WINDOW first (delta-lean-zero spec D4): both are about
    // the calendar, not the tape, so neither waits on a reading. Off by
    // default, and then neither can fire.
    if (dials.dl_expiry_day_only && dateIst !== inputs.expiry) {
      return wait(
        `${dateIst} is not this book's expiry day (${inputs.expiry}) — it opens only on its contract's last session`,
        st,
      );
    }
    if (dials.dl_open_by_min > 0 && minuteOfDay > dials.dl_open_by_min) {
      return wait(`${clock(minuteOfDay)} is past the ${clock(dials.dl_open_by_min)} open window — no package today`, st);
    }
    const allowedBy = openSwitch(read.slow);
    const wanted = allowedBy !== null && dials[allowedBy];
    const ready = wanted && confirmed(st, dials, nowMs);
    const lastMinute = fallbackMinute(inputs, dials, read.slow);
    if (!ready && !lastMinute) {
      if (allowedBy === null) {
        return wait(`${read.slow}: nothing to express — waiting for a trend or a quiet range`, st);
      }
      if (!wanted) {
        return wait(`${read.slow}: this book does not open on ${read.slow} (${allowedBy} is off)`, st);
      }
      const heldS = ((nowMs - st.dlRegimeSinceMs) / 1000).toFixed(0);
      return wait(
        `${read.slow} for ${heldS}s — inside the ${dials.dl_adjust_confirm_s}s confirm window`,
        st,
      );
    }
    // A confirmed regime's own package first; in the window's last minute,
    // the quiet package when there is none — including when that regime's
    // structure cannot form on this chain, as the replay does (spec D5).
    let pkg = ready ? openPackage(inputs, dials, read.slow) : null;
    const fellBack = pkg === null && lastMinute;
    if (fellBack) pkg = openPackage(inputs, dials, 'quiet');
    const opening = fellBack
      ? `${read.slow} at ${clock(minuteOfDay)}, the open window's last minute — the quiet package anyway`
      : read.slow;
    if (pkg === null) {
      // §6.1: a book that never opened has NOTHING TO LOSE, so a cap that
      // refuses the open is not a stuck condition — it is a wait like any other.
      return wait(
        `${opening}: the open does not fit the ${inr(dials.margin_cap)} SPAN cap (or the bands are not on this chain) — nothing opened`,
        st,
      );
    }
    const paced = pace(pkg.actions, inputs, dials);
    if (paced.length < pkg.actions.length) {
      // WHOLE OR NOTHING. Half a debit pair is a naked leg and two of a
      // strangle's four is a short with no wing.
      return wait(`${opening}: the open needs ${pkg.actions.length} orders [order budget]`, st);
    }
    const after: RuleState = {
      ...st,
      dlOpenedMs: nowMs,
      dlOpenSide: pkg.side,
      // THE OPEN COUNTS AS THE FIRST PACKAGE, so the first adjustment is a
      // whole `dl_adjust_cooldown_s` away rather than available next tick.
      dlLastAdjustMs: nowMs,
      // And it is the package this regime justified, so the SAME regime cannot
      // justify the next one. A fallback records the reading it opened on —
      // `chop`, say — not the quiet its package is.
      dlLastAdjustRegime: read.slow,
      dlBlockedSinceMs: 0,
    };
    // A LEG COUNT ALONE HIDES THE TRIM: a quiet open is four legs whether the
    // cap let it have four lots or two, so the size and the reason it shrank
    // are what the ledger has to carry.
    const trim =
      pkg.lots < dials.dl_open_lots
        ? `, trimmed from ${dials.dl_open_lots} by the ${inr(dials.margin_cap)} SPAN cap`
        : '';
    return acted(
      'adjust',
      'dl-open',
      `${opening}: opening ${pkg.side}, ${paced.length} leg(s) at ${pkg.lots} lot(s) a leg${trim}, hedge included`,
      paced,
      after,
      // `markState` is the book BEFORE the package: a dropped open must not
      // leave the row saying the book opened.
      st,
      'passive',
    );
  }

  // ── 7. the posture and the adjustment (§6.2) ─────────────────────────────
  // AN OPENED BOOK WITH NO LEGS HOLDS, ahead of every other question here.
  // `dlOpenedMs` non-zero and an empty book is a real state — the target or the
  // stuck ladder filled, a repair took the package off, the broker refused the
  // whole open — and every one of them leaves a book whose day is done. Read as
  // a posture instead, a net delta of ZERO is a `lean` shortfall of the whole D
  // and the engine buys a NAKED PYRAMID onto it: no hedge, no package, nothing
  // to adjust around. A WAIT and not a block: there is no cap and no spent
  // budget here, so §6.4's clock has nothing to measure.
  if (legs.length === 0) {
    return wait("the day's package is gone — nothing to adjust", st);
  }
  const net = netDeltaLots(legs);
  if (!net.priced) {
    // NOT A BLOCK: the book is unreadable, not capped, and a clock armed here
    // would exit a losing book on a stale quote (§6.4).
    return wait('a leg has no solvable IV — the book delta is not measurable', st);
  }
  const posture = wantedPosture(read.slow, st.dlOpenSide, dials);
  if (posture === null) {
    // No reading, no posture — and no block either, so the stuck clock resets.
    return wait('the detector has no reading — holding what the book holds', st);
  }
  const gap = postureGap(posture, net.lots, dials.dl_dead_band_lots);
  if (gap === 0) {
    // Either the posture is MET, or the book is already PAST it on a one-sided
    // posture — a `lean` book that has run, a `counter` book already on the
    // regime's side. Both are "nothing to add", and neither is a sale.
    return wait(
      `${read.slow}/${posture.mode}: the book is at ${net.lots.toFixed(2)} delta-lots against a wanted ${posture.target.toFixed(2)} — nothing to add`,
      st,
    );
  }

  // An adjustment is WANTED. The gates, in the order their consequences differ:
  // the two BLOCKS first — the day limit (terminal until tomorrow's roll) and
  // the §6.3 margin gate — because neither can clear by itself and both are
  // what §6.4 arms on; then the three that are merely a WAIT (the churn guard,
  // the confirm window and the cooldown), each of which resets that clock.
  const shortfall = `${read.slow}/${posture.mode}: ${net.lots.toFixed(2)} delta-lots against a wanted ${posture.target.toFixed(2)}`;
  if (st.dlAdjustsToday >= dials.dl_max_adjusts_day) {
    // BLOCKED, not waiting: this cannot clear before tomorrow's roll, so it is
    // one of the two conditions the stuck exit arms on.
    return stuckExit(
      inputs,
      dials,
      st,
      `${shortfall} — all ${dials.dl_max_adjusts_day} adjustments are spent`,
    );
  }

  // The package and its MARGIN GATE come next, ABOVE the three waiting gates,
  // because their consequences differ: a cap-blocked adjustment is a BLOCK for
  // §6.4 whether or not the churn guard or the cooldown would also have held
  // it, and priced the other way round a book at the cap in a persistent trend
  // would reset its own stuck clock on the churn guard every tick.
  const pkg = adjustmentPackage(inputs, dials, gap, posture.mode);
  if (pkg === null) {
    // A band with no tradable strike is a WAIT, not a block: the next print can
    // put a strike back in it, and no exit should ride on a thin ladder.
    return wait(`${shortfall} — no tradable strike in the band`, st);
  }

  // ── §6.3, the margin gate ────────────────────────────────────────────────
  // TRUNCATE to the largest size that fits, never round up. A BUY always
  // survives this (a long option never raises SPAN-lite), which is what makes
  // the `counter` neutralising buy of §6.2 unconditional; only the `flat`
  // sideways SALE can shrink or be refused outright.
  const lots = fitLots(inputs, dials, pkg.unit, pkg.lots);
  if (lots === 0) {
    return stuckExit(
      inputs,
      dials,
      st,
      `${shortfall} — not one lot fits under the ${inr(dials.margin_cap)} SPAN cap`,
    );
  }

  if (read.slow === st.dlLastAdjustRegime) {
    // THE CHURN GUARD. A trend that merely persists must not top the book up
    // every cooldown; the tape has to change its mind and come back. Not a
    // stuck condition — the book is not blocked, it has already acted on this
    // reading, and the next change of tape frees it.
    return wait(`${shortfall} — ${read.slow} already justified the last package`, st);
  }
  if (!confirmed(st, dials, nowMs)) {
    const heldS = ((nowMs - st.dlRegimeSinceMs) / 1000).toFixed(0);
    return wait(
      `${shortfall} — ${read.slow} for ${heldS}s, inside the ${dials.dl_adjust_confirm_s}s confirm window`,
      st,
    );
  }
  const sinceAdjust = st.dlLastAdjustMs === 0 ? Number.POSITIVE_INFINITY : nowMs - st.dlLastAdjustMs;
  if (sinceAdjust < dials.dl_adjust_cooldown_s * 1000) {
    const leftS = ((dials.dl_adjust_cooldown_s * 1000 - sinceAdjust) / 1000).toFixed(0);
    return wait(`${shortfall} — ${leftS}s left of the ${dials.dl_adjust_cooldown_s}s cooldown`, st);
  }

  const actions = scaleLots(pkg.unit, lots);
  const paced = pace(actions, inputs, dials);
  if (paced.length < actions.length) {
    // A RATE LIMIT, not a block: it clears next minute on its own, so the stuck
    // clock resets here like at every other wait branch.
    return wait(`${shortfall} [order budget]`, st);
  }
  const trigger = adjustTrigger(posture);
  // A LOT COUNT ALONE HIDES THE TRIM, exactly as at the open: the size and the
  // reason it shrank are what the ledger has to carry.
  const shrunk = lots < pkg.lots ? ` (cut from ${pkg.lots} by the SPAN cap)` : '';
  const after: RuleState = {
    ...st,
    dlAdjustsToday: st.dlAdjustsToday + 1,
    dlLastAdjustMs: nowMs,
    dlLastAdjustRegime: read.slow,
    dlBlockedSinceMs: 0,
  };
  return acted(
    'adjust',
    trigger,
    `${shortfall} — ${trigger === 'dl-add' ? 'pyramiding' : 'neutralising'} by adding ${lots} lot(s)${shrunk}`,
    paced,
    after,
    // A dropped package must not burn an adjustment or start a cooldown.
    st,
    'passive',
  );
}
