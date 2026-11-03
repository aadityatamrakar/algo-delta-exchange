/**
 * THE GUARD TIER — the two rules that outrank the playbook, and the one
 * quantity every tier nets through.
 *
 * Spec §5 item 4. A guard runs BEFORE the working-package hold, before the
 * scrap tier and before both phases, and it answers with the whole book rather
 * than with a victim: the target lock flattens, the margin guard trims. Both
 * are urgency executions at the gateway (§8), which is why they may preempt a
 * package that is still being worked.
 *
 * ── 1. `unprotectedLots` — THE ONE DEFINITION ───────────────────────────────
 * Python's `K.unprotected` is a per-leg BOOLEAN (`conditions.py:87-96`), and
 * the flag it reads draws the desk's sharpest line: a protected leg is COUNTED
 * in everything that measures the book — marking, MTM, every net greek — and
 * EXEMPT from everything that spends one. `EngineInputs.protectedQty` is a
 * QUANTITY per instrument instead, because an operator can part-own a position,
 * and a boolean cannot say "two of these five lots are mine".
 *
 * So the shared reading is: `steerableLots` = held − claimed, floored at zero,
 * and a leg with none left is not a candidate at all. An over-claim is CLAMPED
 * rather than netted negative — a bookkeeping disagreement is not permission to
 * sell the difference — and a fractional claim rounds UP, because the engine
 * never half-spends a lot the operator part-owns.
 *
 * ALL FOUR selection sites net through here, and the list is exhaustive on
 * purpose — a fifth copy is how the four come to disagree: phase S's ITM scan
 * (`shift.ts`), the LIFO unwind's victim stack (`tiers.ts`'s `unwindStack`,
 * which also reads the spendable count off the row this returns instead of
 * recomputing it), the scrap tier's victim list (`scrap.ts`), and the margin
 * trim below.
 *
 * What does NOT net through it is the WHOLE-BOOK TERMINAL EXIT — the target
 * lock takes the operator's leg too (`engine.py:439-443`: banking the run
 * outranks protecting a hedge, and a lock that left a leg behind would leave
 * the book open past the moment it reported itself flat).
 *
 * ── 2. THE TARGET LOCK IS MARK-ANCHORED, NOT TICK-ANCHORED (spec §7) ────────
 * The desk's one hard rule: the moment realised + open mark reaches
 * `target_pnl`, flatten everything and bank it. What it costs to get that wrong
 * is on the record — TCS 2026-06-19, a gap-open marked not-yet-traded legs at
 * the PRIOR session's prices while spot printed fresh, one 09:15 mark showed
 * **+17L on a book that was really −21L**, and the lock flattened 1,460 lots
 * into the crash. The defence is a streak of `target_confirm_marks` CONSECUTIVE
 * marks over target; any dip disarms it.
 *
 * This engine evaluates on every TICK, so the streak has to be told which ticks
 * are marks — hence `markCtx.isNewMark`. Ten tick-evaluations inside one
 * 5-minute mark advance the streak ONCE. Spec §7 is explicit that tick
 * persistence is not an equivalent defence: a gap-open's phantom print persists
 * perfectly well for five seconds, and it is the NEXT MARK re-printing that
 * proves it was real. `confirm_ms` damping in the supervisor is a different
 * rule for a different failure and does not substitute.
 *
 * The disarm is mark-anchored for the same reason and in the same place: a tick
 * that dips inside a mark already counted must not erase it, or the streak
 * becomes a measure of the noisiest tick in each window rather than of the
 * mark.
 *
 * ── 3. THE FOUR LOCK REFINEMENTS, AND WHAT EACH ONE COST TO PORT ────────────
 * All four are OFF in every recorded preset, so none of them moves a parity
 * mark; they are here because the spec's Advanced row names them and because an
 * operator turning one on must get the Python behaviour, not an approximation
 * nobody wrote down.
 *
 *   `lock_exclude_mark0` (`engine.py:173-179`, `:509-516`) — the run's FIRST
 *   mark is a phantom: 33 of 147 sweep runs carry |m0| > ₹20,000 and the very
 *   next mark is exactly 0.0 in 30 of them, because mark 0 prices legs that have
 *   not traded yet. It can neither arm, count NOR snap, and Python HOLDS the
 *   whole pass on it — kept, because a mark whose P&L is fiction is not a mark
 *   any other tier should act on either.
 *
 *   PORTED PER-SESSION, WHERE PYTHON'S IS PER-RUN, and that is the third
 *   declared narrowing on this list. Python counts `st["_run_marks"]`, which is
 *   the first mark of the whole BACKTEST RUN and fires exactly once ever; this
 *   reads `markCtx.markIndexToday`, so it excludes the first mark of EVERY
 *   session. The divergence is in the source, not in the intent: a live book has
 *   no "run", and the failure the dial defends against — legs marked at the
 *   prior session's prices before they have traded — is a property of a SESSION
 *   OPEN, which is the same shape the TCS 2026-06-19 gap-open defence has. So
 *   the per-session reading is the one that keeps doing the dial's job on a
 *   supervisor that never restarts; Python's would fire once on boot and never
 *   again. Whoever wants the literal run-scoped behaviour needs a counter in
 *   `RuleState`, which the spec's schema does not carry.
 *
 *   `target_snap_multiple` (`:180-185`, `:517-526`) — a qualifying non-entry
 *   mark at ≥ snap × target banks immediately, no streak. Measured +29,090
 *   across distinct policies and it LOSES on two runs; retained because the
 *   losses are small and bounded, not because the edge is broad. It is NOT
 *   gated on `isNewMark`: Python bypasses the confirmation streak outright, and
 *   at 5-minute sampling "any mark" and "any evaluation" were the same thing.
 *
 *   `lock_executability` (`:32-35`, `:536-544`) — PORTED NARROWED, deliberately.
 *   Python suppresses a target print during the first two marks of a session it
 *   has decided GAPPED (`|open/prev close − 1| > lock_gap_pct`, tracked in
 *   `_track_session`). Neither `lock_gap_pct` nor the four state fields that
 *   detect a gap (`_session_date`, `_session_marks`, `_gap_session`,
 *   `_last_spot`) exist in this migration's schema — the spec's Advanced row
 *   names the toggle and nothing else, and `RuleState` carries no cross-session
 *   spot. So the port keeps the SUPPRESSION and drops the GAP TEST: with the
 *   dial on, a target print in the session's first two marks never advances the
 *   streak (and, as in Python, never resets it either). That fires on quiet
 *   mornings too, which trades later banking for never banking a phantom — the
 *   same direction the rule was written in, applied more often. It is not
 *   Python's rule and this comment is the only place that says so.
 *
 *   `lock_branch_lots` (`:24-31`, `:444-463`) — PORTED AS THE ORDERING, NOT AS
 *   THE RATCHET. Python's two-branch lock does two separate things: above the
 *   branch it flattens with closes ordered GAMMA-FIRST and an adaptive per-mark
 *   clip; at or below it, it arms a TRAILING RATCHET that holds instead of
 *   flattening and exits later on `max(target, lock_trail_frac × peak)`, dte ≤ 1
 *   or the lot count growing past the branch. The ratchet needs
 *   `lock_trail_frac` and two state fields (`ratchet_on`, `ratchet_peak`), none
 *   of which the spec's schema or `RuleState` carries; half-porting it would
 *   make the desk's ONE hard rule HOLD on exactly the small clean books it was
 *   written for, which is a silent way to turn profit-taking off. So the lock
 *   always banks, and a positive `lock_branch_lots` buys the gamma-first
 *   ordering alone. The adaptive clip (`max(20, ceil(n/3))`, full size from
 *   15:15) is not ported at all and does not need to be: it is PACING, and spec
 *   §5 retires the per-mark throttle in favour of the gateway's fill-gated
 *   tranches (§8), which pace the same closes without the engine knowing.
 *
 * ── 4. THE MARGIN GUARD IS A TRIM, NEVER A WING (`engine.py:663-752`) ───────
 * Over the cap, Python tries to BUY relief wings first and falls back on
 * trimming the worst shorts by |delta/share|, one whole leg at a time, until
 * the projection clears 95% of cap. The wing arm is gated on `no_buy`, and spec
 * §5 hardcodes `no_buy` for the recenter family — every one of its twelve
 * presets carries it (`playbooks.py:349-478`) — so the wing search does not
 * exist here and `margin-project.ts` does not port `wing_relief_candidates`.
 *
 * The projection is built over the pool that can ACTUALLY be closed, not
 * filtered afterwards (`:696-701`): projecting over every short and letting the
 * close drop the protected ones under-trims, because the walk stops as soon as
 * the projection clears and counts relief from legs that then survive. With
 * `protectedQty` a quantity, a partly-protected leg contributes its steerable
 * lots and RESIZES down to the protected tail rather than closing.
 *
 * `margin_persist_marks` (`:646-655`, the opt-in "a breach must outlive N
 * marks") is NOT ported: it is absent from the spec's dial schema, it is off in
 * every recenter preset, and the supervisor's `confirm_ms` damping (§7) is the
 * replacement for exactly this class of same-tick reaction.
 *
 * ── 4b. THE UNIT MISMATCH INSIDE THIS GUARD — say it out loud ───────────────
 * The trigger and the remedy are measured in DIFFERENT UNITS, and an operator
 * setting `margin_cap` needs to know it. `margin > cap` reads
 * `inputs.margin.value`, which is a BROKER figure; the trim walk then decides
 * how much to cut by projecting SPAN-lite, which is a MODEL. Spec §6 records
 * how far apart those two can be: on BHEL-2026-08-25 SPAN-lite said 20.8L where
 * the broker said 42.9L — a factor of 2.06 on the quantity the cap is a
 * ceiling for.
 *
 * Two consequences, and the first is now handled in code:
 *
 *   - A book the broker calls over-cap and the model calls comfortably inside
 *     it must trim NOTHING. That is what the pre-check in `marginGuard` is; see
 *     the comment there for why Python could live without one.
 *   - When the two disagree the other way — the model over, the broker under —
 *     this guard does not fire at all, and the pre-trade projection in
 *     `margin-project.ts` is the only margin control the book has. That is the
 *     designed division (spec §5's "0 = uncapped disables shift + margin guard
 *     projection"), not an oversight, but it means `margin_cap` is a BROKER
 *     ceiling with a MODEL-sized remedy and should be set with that in mind.
 *
 * ── 5. WHAT THIS FILE DOES NOT PORT: THE CRASH TIER ─────────────────────────
 * Spec §5 names "crash protect" between the lock and the margin guard, and
 * `crash_delta` 0.60 is in the Advanced dial row. It is deliberately NOT wired,
 * and there are four independent reasons — any one of them alone would be worth
 * saying out loud, and none of them is "it looked hard":
 *
 *   1. THE TRIGGER HAS NO PRODUCER. Python gates the whole tier on
 *      `K.regime(ctx) == "crash"` (`engine.py:574`, `conditions.py:205-206`),
 *      and `regime` comes off the backtest's signal generator. Nothing in this
 *      migration's architecture computes one: `EngineInputs` carries a market
 *      snapshot, not a market opinion.
 *   2. WITHOUT THAT GATE IT IS NOT THE SAME RULE. Measured on the recorded
 *      fixtures: **72 short legs across the twelve presets carry |Δ/share| >
 *      0.60** (max 0.80). A regime-free crash tier would cut every one of them
 *      — deep-ITM shorts that phase S exists to SHIFT — and the parity suite
 *      would fail on the marks that prove it.
 *   3. `TRIGGERS` HAS NO `crash` (`types.ts:156-159`). That list is ratified,
 *      validated at desk-api's boundary, and adding a member to it is a contract
 *      change, not a detail.
 *   4. IT IS ALREADY DEAD FOR THIS FAMILY. `no_close: True` is what gates the
 *      crash tier off in Python (`engine.py:574`), and every recenter preset
 *      carries it. The recenter comment says so in as many words: "it gates the
 *      ENGINE's crash-protect and margin-trim tiers".
 *
 * (Reason 4 applies to the margin guard too, and there the spec overrules it
 * twice — §5 lists the guard, §8 lists "margin guard trims" as an urgency
 * exit — so it is wired. The difference is that the margin guard's trigger is a
 * number this engine actually has.)
 *
 * PURE: no clock, no feed. Every quantity arrives on `EngineInputs`.
 */
import { MARGIN_HYSTERESIS, bookSpanLegs, spanLiteMargin, type SpanLeg } from './margin-project.ts';
import type { Dials } from './dials.ts';
import type { EngineAction, EngineInputs, LegView, RuleState, Trigger } from './types.ts';

/** A leg plus the lots of it the rules may SPEND. See §1. */
export type SteerableLeg = LegView & { readonly steerableLots: number };

/** Where this evaluation sits on the 5-minute mark grid — the only thing that
 * may advance a mark-counted dial (§2). `markIndexToday` is the index of this
 * mark within today's session as the supervisor counts them; index 0 is the
 * session's first, which is what `lock_exclude_mark0` excludes. */
export interface MarkContext {
  readonly isNewMark: boolean;
  readonly markIndexToday: number;
}

/**
 * The legs the rules may spend, each annotated with how many lots of it.
 *
 * FILTERS as Python's `K.unprotected` filters: a leg the operator wholly owns
 * is not a candidate and does not appear. A caller that needs the whole book —
 * the corridor's greeks, the margin projection's base, the lock's flatten —
 * wants `inputs.legs`, and the fact that those three read a different list is
 * the entire protection semantics (spec §4).
 */
export function unprotectedLots(
  legs: ReadonlyArray<LegView>,
  protectedQty: Readonly<Record<string, number>>,
): ReadonlyArray<SteerableLeg> {
  const out: SteerableLeg[] = [];
  for (const leg of legs) {
    const held = Math.trunc(leg.lots);
    if (!(held > 0)) continue;
    const claimed = protectedQty[leg.instrument];
    const steerableLots =
      claimed === undefined || !Number.isFinite(claimed) || claimed <= 0
        ? held
        : Math.max(0, held - Math.min(Math.ceil(claimed), held));
    if (steerableLots > 0) out.push({ ...leg, steerableLots });
  }
  return out;
}

/**
 * `K.total_pnl` (`conditions.py:191-199`): banked plus the open book's mark.
 *
 * The mark is the EXIT side in live pricing (`marking.ts`), which is the whole
 * point of the two-sided port — Python marked at mid, so a short book read as
 * profitable at prices it could not actually buy back at, and the lock fired on
 * money that was never there (`types.ts` §1).
 */
export function totalPnl(inputs: EngineInputs): number {
  let mtm = 0;
  for (const leg of inputs.legs) mtm += leg.mtm;
  return inputs.cumRealized + mtm;
}

/** `K.short_lots` (`conditions.py:105-113`): lots across SHORT option legs,
 * PROTECTED ONES INCLUDED. This measures the book rather than spending it, and
 * a measurement that skipped the operator's legs would report a smaller naked
 * position than the desk is actually carrying. */
export function shortLots(legs: ReadonlyArray<LegView>): number {
  let total = 0;
  for (const leg of legs) if (leg.side === 'Sell') total += Math.trunc(leg.lots);
  return total;
}

/** A guard's answer. `null` from `guardTier` means "no guard spoke" — the pass
 * continues — and the state it returns may still have moved (the lock's streak
 * advances on marks that do not fire). */
export interface GuardDecision {
  readonly action: 'hold' | 'adjust' | 'flatten';
  readonly trigger: Trigger;
  readonly reason: string;
  readonly actions: ReadonlyArray<EngineAction>;
}

export interface GuardOutcome {
  /** `null` = fall through to the rest of the pass. */
  readonly decision: GuardDecision | null;
  readonly stateAfter: RuleState;
  /**
   * The same mark's state WITHOUT the flag a guard only earns by EXECUTING —
   * `EngineDecision.markState`, for the caller that decides not to route.
   *
   * There is exactly one such flag in this tier and it is the expensive one:
   * `targetLocked`. It is TERMINAL by design (the check at the top of
   * `targetLock` never un-sets it, because a banked run does not redeploy), so
   * a supervisor that persisted it for a flatten desk-api REFUSED — or that it
   * dropped, or lost a compare-and-set on — would hold the book forever with
   * its legs still open and every guard silenced. Risk management off, quietly.
   *
   * So the flatten's `stateAfter` latches the lock and its `markState` does not,
   * while the STREAK is carried by both: the mark really did print over target,
   * and a lock that had to start counting again from zero after a refusal would
   * take another three marks to re-fire on a book it has already proved.
   *
   * Identical to `stateAfter` everywhere else in this file, holds included — a
   * decision that emits no actions has no acting delta to hold back.
   */
  readonly markState: RuleState;
}

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');
const inr = (x: number): string => `Rs${n0(x)}`;

/**
 * The flatten-everything package, PROTECTED LEGS INCLUDED (`engine.py:439-443`).
 *
 * Gamma-first when the two-branch dial is on (§3): Python orders the closes by
 * the leg's book-scaled |gamma| so the most convex risk leaves first when the
 * unwind cannot complete in one go. `LegView.gamma` is per-share, so the sort
 * key restores the scale Python's `leg.gamma` already carried.
 */
function flattenAll(legs: ReadonlyArray<LegView>, gammaFirst: boolean): EngineAction[] {
  const ordered = gammaFirst
    ? [...legs].sort(
        (a, b) =>
          Math.abs(b.gamma * b.lots * b.lotSize) - Math.abs(a.gamma * a.lots * a.lotSize),
      )
    : legs;
  return ordered.map((l): EngineAction => ({ op: 'close', instrument: l.instrument }));
}

/**
 * The hard target lock — spec §5 item 4, §7's mark anchoring, `engine.py:490-566`.
 *
 * Returns `null` when the lock has nothing to say, in which case the state it
 * hands back may still carry a streak that advanced or disarmed on this mark.
 */
function targetLock(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  markCtx: MarkContext,
): GuardOutcome {
  const { legs } = inputs;
  const none = (stateAfter: RuleState): GuardOutcome => ({
    decision: null,
    stateAfter,
    markState: stateAfter,
  });

  // TERMINAL. `target_locked` is never un-set: a banked run does not redeploy,
  // and the flatten it fired may still be working at the gateway.
  if (state.targetLocked) {
    return {
      decision: {
        action: 'hold',
        trigger: 'lock',
        reason: 'target banked — staying flat',
        actions: [],
      },
      stateAfter: state,
      markState: state,
    };
  }

  const target = dials.target_pnl;
  if (!(target > 0) || legs.length === 0) return none(state);

  const pnl = totalPnl(inputs);
  const confirm = Math.max(1, Math.trunc(dials.target_confirm_marks));
  const branch = Math.trunc(dials.lock_branch_lots);
  const gammaFirst = branch > 0;

  // §3: mark 0 can neither arm, count nor snap — and Python holds the whole
  // pass on it rather than falling through to a tier that would act on the
  // same fiction.
  if (dials.lock_exclude_mark0 && markCtx.markIndexToday === 0) {
    return {
      decision: {
        action: 'hold',
        trigger: 'lock',
        reason:
          `entry mark (${inr(pnl)}) — excluded from the lock (legs have not traded yet)`,
        actions: [],
      },
      stateAfter: state,
      markState: state,
    };
  }

  const snap = dials.target_snap_multiple;
  if (snap > 0 && pnl >= snap * target) {
    return {
      decision: {
        action: 'flatten',
        trigger: 'lock',
        reason:
          `TARGET SNAP: ${inr(pnl)} >= ${snap}x +${inr(target)} — bank immediately, ` +
          'no confirmation',
        actions: flattenAll(legs, gammaFirst),
      },
      stateAfter: { ...state, targetLocked: true },
      // The snap neither counts nor confirms — it banks — so the mark moved
      // NOTHING unless this flatten is really sent. See `GuardOutcome`.
      markState: state,
    };
  }

  if (pnl >= target) {
    // §3: the executability suppression, minus Python's gap test.
    if (dials.lock_executability && markCtx.markIndexToday <= 1) {
      return {
        decision: {
          action: 'hold',
          trigger: 'lock',
          reason:
            `target print on an opening mark (${inr(pnl)}) — not counted toward ` +
            'confirmation (executability)',
          actions: [],
        },
        stateAfter: state,
        markState: state,
      };
    }

    // §2: one mark, one streak step. A tick inside a mark already counted
    // reports the streak it is inside rather than advancing it.
    if (!markCtx.isNewMark) {
      return {
        decision: {
          action: 'hold',
          trigger: 'lock',
          reason:
            `target within reach (${inr(pnl)} >= +${inr(target)}) — confirming ` +
            `${state.targetStreak}/${confirm} (this tick is inside a mark already counted)`,
          actions: [],
        },
        stateAfter: state,
        markState: state,
      };
    }

    const streak = state.targetStreak + 1;
    if (streak < confirm) {
      return {
        decision: {
          action: 'hold',
          trigger: 'lock',
          reason:
            `target within reach (${inr(pnl)} >= +${inr(target)}) — confirming ` +
            `${streak}/${confirm}`,
          actions: [],
        },
        stateAfter: { ...state, targetStreak: streak },
        markState: { ...state, targetStreak: streak },
      };
    }

    return {
      decision: {
        action: 'flatten',
        trigger: 'lock',
        reason: `TARGET locked: total P&L ${inr(pnl)} >= +${inr(target)} — flatten & bank`,
        actions: flattenAll(legs, gammaFirst),
      },
      stateAfter: { ...state, targetStreak: streak, targetLocked: true },
      // The streak is the MARK's (this mark printed over target and it is the
      // Nth in a row); the lock is the PACKAGE's. A caller that does not route
      // this flatten keeps the count and must not keep the latch — see
      // `GuardOutcome`.
      markState: { ...state, targetStreak: streak },
    };
  }

  // Dipped back under target: disarm — but only on a mark, for the reason in §2.
  if (markCtx.isNewMark && state.targetStreak > 0) {
    return none({ ...state, targetStreak: 0 });
  }
  return none(state);
}

/**
 * The margin-cap trim — §4, `engine.py:663-743`.
 *
 * `null` = decline and fall through. Declining rather than holding is
 * load-bearing: a hold here would freeze this mark, and every later one, for as
 * long as the book stayed over its cap, and the pre-trade projection is still
 * blocking fresh sells meanwhile.
 *
 * The margin figure is read at face value, whatever its provenance. That is
 * Python's behaviour and it is the right one HERE even though `shift.ts`
 * refuses it: this guard's action is an EXIT, and the worst a wrong model can
 * do is take risk off a book that did not need it. Phase S's action is a fresh
 * SALE, which is why that gate wants a broker figure and this one does not.
 */
function marginGuard(inputs: EngineInputs, dials: Dials): GuardDecision | null {
  const cap = dials.margin_cap;
  if (!(cap > 0)) return null; // uncapped: nothing to breach
  const margin = inputs.margin.value;
  if (!Number.isFinite(margin) || !(margin > cap)) return null;

  const { legs, chain, protectedQty, dateIst } = inputs;
  const shorts = [...unprotectedLots(legs.filter((l) => l.side === 'Sell'), protectedQty)].sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
  );
  if (shorts.length === 0) return null;

  const target = MARGIN_HYSTERESIS * cap;
  // The walk mutates a per-instrument lot count over the WHOLE book — longs and
  // protected tails included — because that is the book the projection has to
  // be taken over.
  const cut = new Map<string, number>();
  const removed: SteerableLeg[] = [];
  // `bookSpanLegs` maps 1:1 over `legs`, so `spans[i]` is `legs[i]`'s row — the
  // index is the only join, because a `SpanLeg` deliberately carries no id.
  const spans = bookSpanLegs(legs, chain.expiry);
  const project = (): number => {
    // Rebuilt rather than filtered, so a partly-cut leg stays in the base at
    // its SURVIVING size: a trim of two of five lots frees two lots' worth of
    // margin, and dropping the leg whole would credit relief the book never
    // gets and stop the walk early.
    const out: SpanLeg[] = [];
    spans.forEach((span, i) => {
      const leg = legs[i];
      if (leg === undefined) return;
      const left = Math.trunc(leg.lots) - (cut.get(leg.instrument) ?? 0);
      if (left <= 0) return;
      out.push({ ...span, lots: left });
    });
    return spanLiteMargin(out, chain.spot, dateIst).total;
  };

  // THE PRE-CHECK, AND THE UNIT MISMATCH IT EXISTS FOR. This guard is TRIGGERED
  // by `inputs.margin.value` — a broker figure — and STEERED by SPAN-lite, and
  // §4b is the measured gap between them: on BHEL-2026-08-25 the model read
  // 20.8L where the broker read 42.9L, a factor of 2.06. Without this line the
  // walk is entered whenever the BROKER says "over cap" and always removes at
  // least one whole leg before it first measures anything — so a book the model
  // already reads as comfortably inside its cap gets a leg cut anyway, and the
  // reason then claims a projection that was true BEFORE the trim.
  //
  // Python has the same shape (`engine.py:656`, no pre-check) and it never
  // mattered there, because `no_close: True` makes this tier dead for the whole
  // recenter family. Spec §5 and §8 make it LIVE here, so the shape has to be
  // fixed rather than inherited. Declining is the conservative direction — this
  // can only ever trim LESS — and the pre-trade projection is still blocking
  // fresh sells meanwhile.
  if (project() <= target) return null;

  for (const short of shorts) {
    cut.set(short.instrument, (cut.get(short.instrument) ?? 0) + short.steerableLots);
    removed.push(short);
    if (project() <= target) break;
  }
  if (removed.length === 0) return null;

  const actions = removed.map((l): EngineAction => {
    const held = Math.trunc(l.lots);
    return l.steerableLots >= held
      ? { op: 'close', instrument: l.instrument }
      : { op: 'resize', instrument: l.instrument, targetLots: held - l.steerableLots };
  });
  return {
    action: 'adjust',
    trigger: 'margin',
    reason:
      `margin-cap: trim ${removed.length} short leg(s) ` +
      `(${removed.map((l) => `${l.steerableLots} ${l.strike}${l.optType}`).join(', ')}) ` +
      `— margin ${inr(margin)} (broker) > cap ${inr(cap)}; projects ` +
      `${inr(project())} (model), under the ${inr(target)} target`,
    actions,
  };
}

/**
 * The whole guard tier in evaluation order: target lock, then the margin trim.
 *
 * `decision: null` means neither spoke and the pass continues — with the state
 * this returns, which is not always the state it was handed.
 */
export function guardTier(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  markCtx: MarkContext,
): GuardOutcome {
  const lock = targetLock(inputs, dials, state, markCtx);
  if (lock.decision !== null) return lock;

  const trim = marginGuard(inputs, dials);
  // The margin trim carries NO state of its own — it is a package, not a latch —
  // so both states are the lock's, whichever way it went.
  return { decision: trim, stateAfter: lock.stateAfter, markState: lock.markState };
}
