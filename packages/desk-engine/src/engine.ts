/**
 * `decide()` — THE WHOLE PASS, IN THE ORDER THE ORDER IS LOAD-BEARING.
 *
 * This is the engine's single public entry and the only place the tiers are
 * composed. Everything it calls is a pure function of a market snapshot, a dial
 * set and a rule state; nothing below it knows what time it is, what the feed is
 * doing, or that Mongo exists.
 *
 * ── THE ORDER (spec §5, item for item) ──────────────────────────────────────
 *
 *  0. **EXPIRY SETTLE — checked before everything, including the session gate.**
 *     `driver.py:30-37` is the argument and it is not a stylistic one: once the
 *     contract's expiry passes, the option is DROPPED FROM THE MASTER and can
 *     never be closed again by any means, "including a manual close-all". A
 *     `close` action needs no local price — the bridge marks and fills it — so
 *     gating the one shot at it behind a feed hiccup, a repair hold, or a
 *     working package would be exactly the failure the settle exists to
 *     prevent. Everything else on this list can wait five minutes; this cannot
 *     wait at all.
 *
 *     THE TRIGGER IS THE LAST MARK OF EXPIRY DAY, not the whole day. Python's
 *     `is_final_mark` (`session.py:97-109`) is `today == expiry AND this is the
 *     final mark of the grid`, and this ports it as `dte === 0 && minuteOfDay >=
 *     DECISIONS_END_MIN` — `>=` rather than `==` because a tick-driven
 *     supervisor must not miss the window by landing a second late. The brief
 *     for this ticket wrote the condition as "`dte === 0` and past
 *     `SESSION_OPEN_MIN`", which is satisfied by this and is also true of the
 *     whole expiry session; settling at 09:20 would flatten a 0-DTE book at the
 *     open and delete the one day the corridor is entirely delta and gamma —
 *     the day `marking.yearFrac` refines its tenor intraday specifically so the
 *     greeks stay alive (`marking.ts:186-208`). Measured on the recorded
 *     fixtures: 72 marks carry `dte 0`, ALL of them between 09:20 and 09:45, and
 *     Python holds on every one. The narrower trigger is what keeps those 72
 *     marks a real parity comparison instead of a carve-out.
 *
 *  1. **Session gate** — a trading day, at or after 09:20, at or before
 *     15:30 (`DECISIONS_END_MIN`: F&O trades to 15:40, the desk stops at
 *     15:30, see session.ts). The 09:20 floor is Python's own
 *     (`engine.py:894-900`, user-directed
 *     2026-08-03: "option prints on the 09:15 candle move too much to act on",
 *     and NO streak advances there either). The close bound is INCLUSIVE: the
 *     15:30 mark is a real mark the desk journals and trades — 12 recorded
 *     fixture marks sit on it and all 12 are adjusts.
 *
 *  2. **Repair hold** — `driver.py:696-714`. While desk-api's repair-Apply is
 *     routing a multi-leg repair the book is neither the pre-repair position nor
 *     the post-repair one, and a decision taken against it is a decision about a
 *     position that does not exist. Read AFTER the settle, deliberately, and
 *     Python spells out why: a hold lasts seconds and expires on its own; a
 *     missed settle is permanent.
 *
 *  3. **Guard tier** — `guards.ts`: the hard target lock, then the margin trim.
 *     Read that file's §5 for the one guard the spec names and this does not
 *     wire (crash protect), and the four independent reasons.
 *
 *  4. **Working-package hold** — `pendingLots > 0` suppresses NEW playbook
 *     actions (`engine.py:904-912`, spec §8). Marking, greeks and the guard
 *     tiers keep evaluating above this line, which is what lets a guard preempt
 *     a package that is still being worked.
 *
 *  5. **Scrap tier** — `scrap.ts`. After the working-package hold, exactly where
 *     Python has it: a paise short is bought back before the playbook starts a
 *     new package, never on top of one already in flight.
 *
 *  6/7. **Phase S then phase R** — and the ROLL-FORWARD between them, which is
 *     the one piece of arithmetic in this file that is not a gate. See the block
 *     above `rollForward`.
 *
 *  8. **Sell gate** — `scrap.ts`'s `sellGate`. It degrades rather than vetoes: a
 *     roll degrades to its close, an all-sells decision degrades to a hold.
 *
 *  9. **Margin projection** — `margin-project.ts`. Fresh Sell opens only, net of
 *     this decision's own closes; closes and Buy opens always survive.
 *
 * 10. **Deferred state commits, scaled to the lots that survived 8 and 9.** A
 *     playbook that advanced its bank when it DECIDED to sell would be wrong:
 *     both gates above run after phase R returns and both can shrink the sale
 *     (22 lots of an intended 710 was the measured case, `engine.py:946-973`).
 *     So phase R hands back a `creditCommit` instead of writing, and this scales
 *     it by `kept / wanted` — a partial fill funds a proportional slice and the
 *     remainder stays accumulating.
 *
 * ── WHAT IS NOT HERE, AND IS NOT MISSING ────────────────────────────────────
 * `cooldown_min` and the per-mark throttle are DELETED by spec §5: the cooldown
 * belongs to the supervisor (`cooldown_s`, §7) and the pacing to the gateway's
 * fill-gated tranches (§8). `decide` is a pure function of NOW and holds no
 * clock of its own to compare against.
 *
 * Python's `try/except -> hold("rule-engine error")` fail-soft wrapper is also
 * not ported. It exists because a Python rule could raise on any malformed dict;
 * here every input is typed and every arm is total. Swallowing an exception in
 * a decider is how a book goes quiet for a session and nobody finds out, and the
 * supervisor (Task 14) is the layer with somewhere to log it.
 */
import { corridor, type Corridor } from './corridor.ts';
import { guardTier, type MarkContext } from './guards.ts';
import { isFutureLeg, sellLotSize } from './ladder.ts';
import { projectMarginCap } from './margin-project.ts';
import { scrapClose, sellGate } from './scrap.ts';
import { DECISIONS_END_MIN, RULES_START_MIN, isTradingDay } from './session.ts';
import { phaseShed } from './shed.ts';
import { phaseShift, type ShiftResult } from './shift.ts';
import type { Dials } from './dials.ts';
import type {
  AppliedCredit,
  EngineAction,
  EngineDecision,
  EngineInputs,
  RecycleCommit,
  RuleState,
  Trigger,
} from './types.ts';

/** Rupees, grouped en-US as every Python reason grouped them. Strikes are NOT
 * put through this — a 2437.5 would print as 2438 — they go in raw. */
const inr = (x: number): string => `Rs${Math.round(x).toLocaleString('en-US')}`;

/** An IST minute-of-day as `HH:MM`, so a session-gate hold names a time an
 * operator can find on a chart rather than a minute count. */
const clock = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * A decision that does nothing, carrying the state the pass has reached.
 *
 * `markState` IS `stateAfter` here and that is not a shortcut: a hold emits no
 * actions, so it has no acting delta to hold back from a caller that decides
 * not to route (`types.ts`'s `markState`).
 */
function hold(reason: string, stateAfter: RuleState, trigger: Trigger = 'none'): EngineDecision {
  return {
    action: 'hold',
    trigger,
    reason,
    actions: [],
    stateAfter,
    markState: stateAfter,
    // A hold routes nothing, so there is nothing to work; `'passive'` is what
    // this engine's binary guard rule (`types.ts`'s `urgency`) answers for the
    // non-guard trigger every call site here passes.
    urgency: 'passive',
    // A hold has no sale to quote — see `EngineDecision.makerQuote`.
    makerQuote: false,
    creditCommit: null,
  };
}

/**
 * The corridor phase R must size off AFTER phase S has moved strikes.
 *
 * `playbooks.py:4008-4009` and `:4058-4061` keep one running `nd`/`ng` and
 * mutate it in place; this engine splits that so `corridor()` stays a pure
 * measurement of the CURRENT book and phase S reports its move as an ADJUSTMENT
 * (`shift.ts` §2). Landing on ATM lands on peak gamma and the allowance is keyed
 * to gamma, so a phase R that sized off the pre-shift greeks would answer with a
 * band that belongs to strikes it just sold.
 *
 * `floorRef` is untouched: it is a whole lot measured off the ladder, a property
 * of the chain rather than of the book's greeks. `tol` is untouched because a
 * shift does not change the tolerance, and `hasGreeks` because a shift does not
 * un-mark a leg.
 *
 * MOVED HERE FROM `test/parity.test.ts:105-118`, where it was written while the
 * orchestrator did not exist. It is measured, not merely asserted: Python writes
 * `netΓ` and `allowance` into its reason on every mark, and the parity suite
 * reads both back and compares them to this corridor (1,072 band checks, 546
 * gamma checks).
 */
export function rollForward(
  cor: Corridor,
  shift: ShiftResult,
  inputs: EngineInputs,
  dials: Dials,
): Corridor {
  const netDelta = cor.netDelta + shift.rolledDelta;
  const netGamma = cor.netGamma + shift.rolledGamma;
  const measured = Math.abs(netGamma) * cor.tol * inputs.chain.spot;
  const mbl = dials.min_band_lots;
  const allowed =
    mbl > 0 ? Math.max(measured, mbl * sellLotSize(inputs.legs, inputs.chain)) : measured;
  return { ...cor, netDelta, netGamma, allowed, excess: Math.abs(netDelta) - allowed };
}

/** Phase S has no reason string of its own — it reports a package and a roll
 * (`shift.ts`) — so the orchestrator writes the line, in the shape Python's
 * `shift {lots} {ot} {from}->{to}` notes read in. */
function shiftReason(actions: ReadonlyArray<EngineAction>): string {
  const opens = actions.filter((a) => a.op === 'open');
  const exits = actions.length - opens.length;
  const sold = opens
    .map((a) => (a.op === 'open' ? `sell ${a.lots} ${a.strike}${a.optType}` : ''))
    .join(', ');
  return `shift: ${exits} ITM short(s) re-centred on spot — ${sold}`;
}

/**
 * WHICH TIER TO NAME IN THE JOURNAL when phase R acted.
 *
 * `ShedResult` reports a package and a reason, not a tier, and adding a tier
 * field would mean reopening `shed.ts`'s and `tiers.ts`'s ratified surface for a
 * LABEL. So the label is derived here, and the derivation is safe precisely
 * because nothing branches on it: `trigger` is journalling and dashboard
 * vocabulary (`types.ts:147-155`). A mislabelled trigger writes the wrong word
 * in a ledger row; it can never change an order, a size or a price.
 *
 * Two of the four tests are STRUCTURAL (the action shape) and two read a marker
 * `shed.ts` composes into its reason; the pair are pinned by tests in
 * `engine.test.ts` so a reworded reason fails loudly here instead of drifting.
 */
export function shedTrigger(reason: string, actions: ReadonlyArray<EngineAction>): Trigger {
  if (reason.startsWith('balance: ')) return 'balance';
  if (reason.includes('sweep at tolerance 0 (whole book)')) return 'eod';
  // Buy-backs only: the LIFO unwind covered the whole budget and nothing was
  // sold (`shed.ts:604-624`).
  if (!actions.some((a) => a.op === 'open')) return 'unwind';
  // The one branch where the only OPEN in the package is the recycle's.
  if (reason.includes('the buy-back covered it')) return 'recycle';
  return 'shed';
}

/**
 * One decision pass over one tick.
 *
 * `markCtx` is what makes the mark-counted dials honest on a tick-driven engine:
 * `isNewMark` is true exactly once per 5-minute mark, and the target lock's
 * confirmation streak is the only thing that reads it (`guards.ts` §2).
 */
export function decide(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  markCtx: MarkContext,
): EngineDecision {
  // FUTURE LEGS ARE MEASURED, NEVER ACTED ON (`types.ts`'s `LegView.kind`).
  // `corridor()` and `rollForward()` read `inputs`, the whole book; every other
  // step reads `opts`, the option legs, so nothing here can close, shift or scrap
  // a future, or size a package in its lot. A desk book carries no future leg and passes the
  // identical object.
  const opts: EngineInputs = inputs.legs.some(isFutureLeg)
    ? { ...inputs, legs: inputs.legs.filter((l) => !isFutureLeg(l)) }
    : inputs;
  const { legs, minuteOfDay, dateIst, dte } = opts;

  // ── 0. expiry settle ─────────────────────────────────────────────────────
  // 15:30, not the 15:40 F&O close: the settle is a flatten and must route
  // while the contracts still trade (`DECISIONS_END_MIN`, session.ts).
  if (dte === 0 && minuteOfDay >= DECISIONS_END_MIN && legs.length > 0) {
    return {
      action: 'flatten',
      trigger: 'expiry',
      reason:
        `expiry settle: the last mark of expiry day — closing all ${legs.length} leg(s) ` +
        'while the contracts still exist',
      actions: legs.map((l): EngineAction => ({ op: 'close', instrument: l.instrument })),
      stateAfter: state,
      // Nothing has counted yet — the settle is checked before every tier.
      markState: state,
      // A guard trigger: `'urgent'`, which is what the host's own
      // `GUARD_TRIGGERS` lookup answered for `'expiry'` before the field
      // existed. Unchanged, on purpose.
      urgency: 'urgent',
      // An urgency exit crosses whatever the book is; it is never quoted.
      makerQuote: false,
      creditCommit: null,
    };
  }

  // ── 1. session gate ──────────────────────────────────────────────────────
  if (!isTradingDay(dateIst)) return hold(`${dateIst} is not an NSE trading day`, state);
  if (minuteOfDay < RULES_START_MIN) {
    return hold(
      `session open: ${clock(minuteOfDay)} mark skipped — the rules start at 09:20, the ` +
        '09:15 option prints move too much to act on',
      state,
    );
  }
  if (minuteOfDay > DECISIONS_END_MIN) {
    return hold(`${clock(minuteOfDay)} is past 15:30, where the desk's decisions end (F&O trades to 15:40)`, state);
  }

  // ── 2. repair hold ───────────────────────────────────────────────────────
  if (opts.repairHold) {
    return hold('repair-Apply is working this tag — standing down until it finishes', state);
  }

  // ── 3. guards ────────────────────────────────────────────────────────────
  const guard = guardTier(opts, dials, state, markCtx);
  const guarded = guard.stateAfter;
  if (guard.decision !== null) {
    const g = guard.decision;
    return {
      action: g.action,
      trigger: g.trigger,
      reason: g.reason,
      actions: g.actions,
      stateAfter: guarded,
      // NOT `guarded`: a target-lock flatten latches `targetLocked` in its
      // stateAfter, and that latch is TERMINAL — a caller that persisted it for
      // a package which never routed would silence every guard on a book whose
      // legs are still open. `guardTier` reports the two separately for exactly
      // this reason (`guards.ts:GuardOutcome`), and the streak rides on both.
      markState: guard.markState,
      // Every trigger `guardTier` emits is in the host's `GUARD_TRIGGERS`, so
      // this is that same binary rule stated at the source.
      urgency: 'urgent',
      // Guards cross. `sell_max_spread_pct` governs what phase R may SELL into,
      // never whether an exit the desk has already decided on may leave.
      makerQuote: false,
      creditCommit: null,
    };
  }

  // ── 4. working-package hold ──────────────────────────────────────────────
  if (opts.pendingLots > 0) {
    return hold(`working package: ${opts.pendingLots} lots still being worked`, guarded);
  }

  // ── 5. scrap ─────────────────────────────────────────────────────────────
  const scrap = scrapClose(opts, dials, guarded);
  if (scrap !== null) {
    return {
      action: 'adjust',
      trigger: 'scrap',
      reason: scrap.reason,
      actions: scrap.actions,
      stateAfter: scrap.stateAfter,
      // WITHOUT the ban: a strike is banned because it was bought back, and a
      // buy-back that is never routed banned nothing.
      markState: guarded,
      // `'scrap'` is not a guard trigger, so it is worked rather than crossed —
      // again the rule the host applied before.
      urgency: 'passive',
      // A scrap close is a BUY-BACK of a spent short at a paise; there is no
      // sale in it for the liquidity gate to have refused.
      makerQuote: false,
      creditCommit: null,
    };
  }

  // ── 6. phase S ───────────────────────────────────────────────────────────
  // Phase S is stateless (`shift.ts`), so `guarded` passes straight through.
  const shift = phaseShift(opts, dials, guarded);
  if (shift.fired && !dials.hedge_after_shift) {
    // `hedge_after_shift` false: a mark that just shifted has already moved the
    // book's delta by moving its strikes, and hedging the same mark is a second
    // adjustment against one move (`playbooks.py:4021-4027`).
    return gated(opts, dials, guarded, {
      actions: shift.actions,
      reason: shiftReason(shift.actions),
      trigger: 'shift',
      commit: null,
      // Phase R never ran on this mark, so the guard tier is all that counted.
      markState: guarded,
      // The liquidity gate is phase R's (`shed.ts` §4). Phase S re-centres onto
      // strikes keyed to SPOT, where the book is deepest, and it did not consult
      // the gate — so it has no refusal to report.
      makerQuote: false,
    });
  }

  // ── 7. phase R ───────────────────────────────────────────────────────────
  // The whole book, futures included: the band is measured on what the book
  // carries, and phase R sizes its option package against it.
  const base = corridor(inputs, dials);
  const cor = shift.fired ? rollForward(base, shift, inputs, dials) : base;
  const shed = phaseShed(opts, dials, guarded, cor);
  const actions = [...shift.actions, ...shed.actions];
  if (actions.length === 0) return hold(shed.reason, shed.stateAfter);

  return gated(opts, dials, shed.stateAfter, {
    actions,
    reason: shift.fired ? `${shiftReason(shift.actions)}; ${shed.reason}` : shed.reason,
    // A mark that both shifted and hedged is named for the SHIFT: it is the
    // move with the bigger footprint and the one an operator reading the ledger
    // is looking for. The shed's own tier still shows in the reason.
    trigger: shift.fired ? 'shift' : shedTrigger(shed.reason, shed.actions),
    commit: shed.creditCommit,
    markState: shed.markState,
    /**
     * THE GATE'S REFUSAL, CARRIED OUT (`shed.ts` §4).
     *
     * Reported for the whole package rather than the one action, because the
     * wire carries a price per action and the caller cannot tell the shed's sale
     * from the shift's. On the ordinary path (`hedge_after_shift` false) the
     * package IS phase R's, so the two are the same thing; on the opt-in path a
     * shift's sale is also worked passively at theoretical, which is the
     * defaults it would have had anyway plus a price — never a cross into the
     * book the gate refused.
     */
    makerQuote: !shed.sheddable,
  });
}

interface Proposed {
  readonly actions: ReadonlyArray<EngineAction>;
  readonly reason: string;
  readonly trigger: Trigger;
  readonly commit: RecycleCommit | null;
  /** This mark's bookkeeping, without the package's own deltas (`types.ts`). */
  readonly markState: RuleState;
  /** The chain refused this sale's book — quote it (`types.ts:makerQuote`). */
  readonly makerQuote: boolean;
}

/**
 * Steps 8, 9 and 10 — the two gates every playbook package answers to, and the
 * deferred commit scaled to what came out the other side.
 *
 * A package that loses everything to a gate becomes a HOLD carrying the state it
 * reached, never a bare close: the sell gate keeps a package's exits when it
 * strips its sells (a roll degrading to its close) and only an all-sells package
 * degrades to nothing, and the margin projection makes the same distinction.
 */
function gated(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  proposed: Proposed,
): EngineDecision {
  const notes: string[] = [];

  // 8. the sell gate.
  const gate = sellGate(inputs, dials, state, proposed.actions);
  if (gate.degradedToHold) {
    return hold(
      `${proposed.reason} [scrap gate: nothing worth selling — dropped ${gate.dropped.join(', ')}; ` +
        'waiting to expiry]',
      state,
    );
  }
  if (gate.dropped.length > 0) {
    notes.push(`scrap gate: dropped ${gate.dropped.join(', ')}`);
  }

  // 9. the margin projection.
  const projection = projectMarginCap(inputs, dials, gate.actions);
  if (projection.verdict === 'hold') {
    return hold(
      `${proposed.reason} [margin-cap: no headroom for new shorts ` +
        `(projected ${inr(projection.projected)} (model) > cap ${inr(dials.margin_cap)})]`,
      state,
    );
  }
  if (projection.verdict === 'downsized') notes.push('downsized for the margin cap');
  if (projection.verdict === 'sells-dropped') notes.push('sell opens dropped for the margin cap');

  // Never empty: `projectMarginCap` answers `hold` (handled above) rather than
  // an empty package, and `sellGate` answers `degradedToHold` for the same case.
  const actions = projection.actions;

  // 10. the deferred commit, scaled to the lots that survived both gates.
  //
  // `keptLots` is stamped whether or not any survived, and the state moves only
  // when some did: a package whose sale was dropped leaves `rcCredit` exactly
  // where it was, and `keptLots: 0` is what says so on the decision itself
  // (`types.ts`'s `AppliedCredit`). Reporting the proposal without that count
  // would read as a spend that never happened.
  let stateAfter = state;
  const c = proposed.commit;
  let applied: AppliedCredit | null = null;
  if (c !== null) {
    let kept = 0;
    for (const a of actions) {
      if (a.op !== 'open' || a.side !== 'Sell') continue;
      if (a.optType !== c.optType || a.strike !== c.strike) continue;
      kept += Math.trunc(a.lots);
    }
    applied = { ...c, keptLots: kept };
    if (c.lots > 0 && kept > 0) {
      stateAfter = {
        ...state,
        rcCredit: c.base + (c.value - c.base) * Math.min(1, kept / c.lots),
      };
    }
  }

  return {
    action: 'adjust',
    trigger: proposed.trigger,
    reason: notes.length === 0 ? proposed.reason : `${proposed.reason} [${notes.join('; ')}]`,
    actions,
    stateAfter,
    // Carried through untouched: the two gates above can shrink or drop the
    // package, and none of that changes what the MARK counted.
    markState: proposed.markState,
    // A playbook package: `shift`, `shed`, `unwind`, `recycle` or `balance`,
    // none of which is a guard trigger. Worked, exactly as before.
    urgency: 'passive',
    // Same reasoning: the scrap gate and the margin cap decide HOW MUCH may be
    // sold, and the liquidity gate decided how it may be worked. A package that
    // survives either gate smaller is still a package the chain would not cross.
    makerQuote: proposed.makerQuote,
    creditCommit: applied,
  };
}
