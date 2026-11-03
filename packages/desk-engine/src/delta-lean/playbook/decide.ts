/**
 * `decidePlaybook()` — THE PLAYBOOK FRAME (six-playbooks spec §4).
 *
 * ── WHAT THE FRAME IS, IN ONE PARAGRAPH ─────────────────────────────────────
 * Everything the six strategies share, once: the day's exits, the session
 * statistics, the exit latch, the two-stage open, the common stops and every
 * gate on new risk. A strategy answers enter? exit? add? with DATA, and this
 * file alone turns answers into orders — so defined risk (D1) is a property of
 * the frame, not a promise six modules keep: no playbook routes a sale.
 *
 * ── THE ORDER, STEP FOR STEP (spec §4.3) — the first step that answers wins ─
 *    0. Day roll — `rollDay`, which resets `pb` on a new date.
 *    1. Latched stop — close what is left, D2 order, urgent.
 *    2. Clock — 14:50 passive, 14:55 urgent, 15:00 ladder; latches once flat.
 *    3. Day backstop — urgent, latches.         4. Day target — ladder, latches.
 *    5. Fold — the session statistics, `Dday`, the regime stamp.
 *    6. Exit latch — re-send the D2 close; escalate; finish once flat.
 *    7. Stage 1 — the protective legs routed and not yet all held.
 *    8. Stage 2 — sell each short against its own held cover.
 *    9. Manage — unknown legs; the common exits and the playbook's; adds.
 *   10. Flat bookkeeping — a trade with no legs and nothing working ends.
 *   11. The new-risk gates.                   12. Enter — stage 1 of a plan.
 * Steps 1-4 are `decideDeltaLean`'s, in its order and with its latches, for
 * its reasons (`delta-lean/decide.ts` header); what differs is the close, and
 * that 3-4 must hold `pb_rupee_hold_s` like every rupee rule here (`dayLines`).
 *
 * ── THE D2 CLOSE, FOR EVERY EXIT ────────────────────────────────────────────
 * Buy back every short; sell the longs only on a LATER pass, once no short is
 * held (`d2Close`). The gateway does not gate fills (spec G12): one package
 * holding both could sell the wing while the buy-back rests, and the book is
 * naked for as long as that takes. Every exit here — the frame's day exits,
 * a playbook's own, the aborts — sends this close and nothing else.
 *
 * ── WORKING: `pendingLots > 0 || inFlight` ──────────────────────────────────
 * The host never posts while a decision is in flight: that pass is a MARK
 * (`markState` persisted, nothing routed). So no pass may end or advance a
 * trade then — a leg can be filled and not yet in `desk-books` (`pendingLots`
 * 0, `inFlight` true: the paper-fold race, O18), and the mark would write the
 * finish. An EXIT may be decided: its latch rides `markState`, and the host
 * pre-empts the working package for it — with no legs, it acts with no
 * actions, for the host cancels only for a decision that acts.
 *
 * ── THE TWO STATES ──────────────────────────────────────────────────────────
 * `markState` is this pass's bookkeeping (fold, regime stamp, peaks, debounce
 * clocks, stage-1 readiness); `stateAfter` adds the package's deltas. An
 * open's `markState` is the book BEFORE it, so a refusal refunds the entry
 * (§4.4); its `dlLastAdjustMs` stamp, which the host's rollback KEEPS, paces
 * the retry (`pb_retry_s`; stage 2 `pb_stage_gap_s`). Latches ride on both.
 *
 * PURE, like the rest of the engine. `markCtx` is accepted and unread, for the
 * reason `decideDeltaLean` gives.
 */
import type { Dials } from '../../dials.ts';
import { type MarkContext, totalPnl } from '../../guards.ts';
import { isTradingDay } from '../../session.ts';
import {
  EMPTY_PLAYBOOK_STATE, type ChainSnap, type EngineAction, type EngineDecision, type LegView,
  type OptType, type PlaybookState, type RuleState, type Trigger, type Urgency,
} from '../../types.ts';
import { acted, clock, type DeltaLeanInputs, fitLots, hold, inr, pace, prevRegime, scaleLots } from '../decide.ts';
import { rollDay } from '../lean.ts';
import { atmStraddleMid, impliedWindowMove, readRegime, type RegimeRead } from '../regime.ts';
import { tradingDaysToExpiry } from './calendar.ts';
import { d2Close, debitSpreadMax, heldOpposite, liquidWing, lotsHeld, openOf, steadySpot } from './kit.ts';
import { PLAYBOOKS } from './registry.ts';
import { dayComplete, foldSession, median3 } from './session.ts';
import type { OpenPlan, PlannedShort, Playbook, PlaybookCtx } from './types.ts';

/** A passive exit is crossed after this long (D4). */
const ESCALATE_MS = 60_000;
/** Stage 1 must have every protective leg held within this of routing. */
const STAGE_ONE_MS = 300_000;
/** Stage 2 must have sold every short within this of stage 1 being held. */
const STAGE_TWO_MS = 120_000;
/** The oldest a board, and its newest option quote, may be for new risk. */
const CHAIN_FRESH_MS = 10_000;
/** The day backstop acts at once from this multiple of `dl_day_max_loss`: a
 * loss that deep is no wide quote, and a held second there is real money. */
const BACKSTOP_AT_ONCE = 1.25;
const MINUTE_MS = 60_000;
const EPS = 1e-6;
const TYPES: readonly OptType[] = ['CE', 'PE'];

/** The `pb` fields a strategy's `patch` may write: its debounce clocks, a trail
 * it arms, the peak, its stamps. The latch, the staging and the counting are
 * the frame's: a strategy that could clear `exiting` could undo this file. */
const STRATEGY_FIELDS: ReadonlySet<string> = new Set([
  'condSinceMs', 'rupeeSinceMs', 'trailArmed', 'peakPnl', 'entryStr', 'entryExtreme', 'boxHi', 'boxLo',
]);

/** One pass: the context every rule reads, and the name it acts under. */
interface Frame {
  readonly ctx: PlaybookCtx;
  readonly name: string;
}

// ── small things ────────────────────────────────────────────────────────────

/** A reason without its playbook prefix, and with it — once, never twice. */
const bare = (name: string, reason: string): string =>
  reason.startsWith(`${name}: `) ? reason.slice(name.length + 2) : reason;
const named = (name: string, reason: string): string => `${name}: ${bare(name, reason)}`;
const secs = (ms: number): number => Math.ceil(ms / 1000);
const leg = (strike: number, optType: OptType): string => `${strike}${optType}`;
const working = (inputs: DeltaLeanInputs): string =>
  `${inputs.pendingLots} lot(s) pending${inputs.inFlight === true ? ', a decision in flight' : ''}`;

/** What one D2 close does this pass, for the journal. */
function closing(legs: readonly LegView[]): string {
  const shorts = legs.filter((l) => l.side === 'Sell').length;
  const longs = legs.length - shorts;
  return shorts > 0
    ? `buying back ${shorts} short(s) first${longs > 0 ? `, ${longs} long(s) after` : ''}`
    : `selling ${longs} long(s), no short left`;
}

/**
 * `pb` with `delta` applied, and the SAME object when nothing in it moves, so
 * a quiet pass writes nothing (`sameRuleState`). An unknown key, a key outside
 * `only`, an `undefined`, a wrong type or a non-finite number is skipped: no
 * patch may leave the row in a shape the hydrator would read back otherwise.
 */
function patched(
  pb: PlaybookState,
  delta: { readonly [K in keyof PlaybookState]?: PlaybookState[K] | undefined } | undefined,
  only?: ReadonlySet<string>,
): PlaybookState {
  let out = pb;
  for (const k of Object.keys(delta ?? {}) as Array<keyof PlaybookState>) {
    const v = delta?.[k];
    if (!(k in EMPTY_PLAYBOOK_STATE) || (only !== undefined && !only.has(k))) continue;
    if (typeof v !== typeof EMPTY_PLAYBOOK_STATE[k] || (typeof v === 'number' && !Number.isFinite(v))) continue;
    if (JSON.stringify(v) !== JSON.stringify(out[k])) out = { ...out, [k]: v };
  }
  return out;
}

/** The per-type coverage test of D1: a type short more lots than it is long. */
function uncovered(legs: readonly LegView[]): string | null {
  for (const t of TYPES) {
    let net = 0;
    for (const l of legs) if (l.optType === t) net += l.side === 'Buy' ? l.lots : -l.lots;
    if (net < 0) return `${t} is short ${-net} lot(s) more than it is long`;
  }
  return null;
}


/** The newest option quote on the board, or null when it carries none. */
const newestQuoteMs = (chain: ChainSnap): number | null =>
  chain.strikes.flatMap((r) => [r.ce, r.pe]).reduce<number | null>((n, q) => (q !== null && (n === null || q.asOf > n) ? q.asOf : n), null);

// ── the pass's context (step 5) ─────────────────────────────────────────────

/** Everything a rule may read, computed once (`PlaybookCtx`, types.ts). */
function context(inputs: DeltaLeanInputs, dials: Dials, st: RuleState, read: RegimeRead, str: number | null): PlaybookCtx {
  const { chain, nowMs, minuteOfDay, dateIst, legs } = inputs;
  const pb = st.pb;
  const latest = inputs.ring.latest();
  const staleMs = dials.dl_spot_stale_s * 1000;
  const mte = inputs.minutesToExpiry;
  const total = totalPnl(inputs);
  const prev = inputs.prevClose;
  const complete = dayComplete(pb, dateIst);
  let cost = 0;
  for (const l of legs) cost += (l.side === 'Buy' ? 1 : -1) * l.entry * l.lots * l.lotSize;
  return {
    inputs, dials, st, pb, read, regime: read.slow,
    regimeHeldMs: st.dlRegimeSinceMs > 0 ? nowMs - st.dlRegimeSinceMs : 0,
    // `S`, the ring's newest print — fresh by the host's clock AND its own:
    // index rules read `S`, never the forward, and a stale `S` measures nothing.
    spot: latest?.spot ?? null,
    spotFresh: latest !== null && nowMs - inputs.spotAsOf <= staleMs && nowMs - latest.ms <= staleMs,
    fwd: chain.spot,
    // ABSENT is not fine: only the contract's own forward prices its strikes.
    forwardOk: inputs.forwardSource === 'parity' || inputs.forwardSource === 'index-carry',
    str,
    imp: (minutes) => (str === null ? null : impliedWindowMove(str, mte, minutes * 60)),
    dayComplete: complete,
    dayRobust: complete && pb.maxGapMs <= dials.pb_max_gap_min * MINUTE_MS,
    dayImplied: pb.dayImplied > 0 ? pb.dayImplied : null,
    // A fold that never saw the open has no opening gap: its first print is not O.
    gapPct: complete && pb.dayOpen > 0 && typeof prev === 'number' && Number.isFinite(prev) && prev > 0
      ? (100 * (pb.dayOpen - prev)) / prev
      : null,
    totalPnl: total,
    tradePnl: pb.tradeOpenMs > 0 ? total - pb.basePnl : 0,
    cost,
    working: inputs.pendingLots > 0 || inputs.inFlight === true,
    expiryDay: chain.expiry === dateIst,
    tradingDte: tradingDaysToExpiry(dateIst, chain.expiry),
    nowMs,
    minuteOfDay,
  };
}

/** The same pass on a `pb` this pass's bookkeeping moved. */
const withPb = (f: Frame, pb: PlaybookState): Frame =>
  pb === f.ctx.pb ? f : { ...f, ctx: context(f.ctx.inputs, f.ctx.dials, { ...f.ctx.st, pb }, f.ctx.read, f.ctx.str) };

/**
 * Step 5. The fold and the regime stamp ride on every state this pass writes,
 * `markState` included: they are the MARK. The regime clock restamps on a
 * change only, as on `decideDeltaLean` — every `pb_confirm_s` is measured from it.
 */
function fold(inputs: DeltaLeanInputs, dials: Dials, rolled: RuleState, name: string): Frame {
  const { chain, nowMs, minutesToExpiry: mte } = inputs;
  const str = atmStraddleMid(chain);
  const pb = foldSession(rolled.pb, inputs, mte, str);
  const since = rolled.dlRegimeSinceMs === 0 ? null : rolled.dlRegimeSinceMs;
  const read = readRegime(inputs.ring, chain, nowMs, mte, dials, prevRegime(rolled), since);
  const stamped = read.slow === rolled.dlRegime ? rolled : { ...rolled, dlRegime: read.slow, dlRegimeSinceMs: nowMs };
  return { name, ctx: context(inputs, dials, pb === stamped.pb ? stamped : { ...stamped, pb }, read, str) };
}

// ── exits ───────────────────────────────────────────────────────────────────

/** Steps 1-4: `exitDecision`'s latch with the D2 close. The backstop, the target
 * and a latched stop latch NOW, on both states — none survives its own flatten;
 * the clock latches once flat, so re-deciding walks its ladder. */
function dayExit(
  inputs: DeltaLeanInputs, name: string, trigger: Trigger, reason: string, urgency: Urgency, st: RuleState, latchWhenFlat: boolean,
): EngineDecision {
  const why = `${name}: ${reason}`;
  if (inputs.legs.length === 0) return hold(`${why} — flat already`, { ...st, dlStopped: true }, trigger);
  const after = latchWhenFlat ? st : { ...st, dlStopped: true };
  return acted('flatten', trigger, `${why} — ${closing(inputs.legs)}`, d2Close(inputs.legs), after, after, urgency);
}

/**
 * Steps 3-4. THE DAY'S BACKSTOP AND TARGET, HELD `pb_rupee_hold_s` like every
 * other rupee rule on this path. Both latch the WHOLE DAY, so one mark off a
 * briefly wide quote on a held leg (spec O19) must not fire either: a 2-lot
 * Theta Fly at -₹3,500 whose ATM ask prints ₹36 high for one pass reads
 * -₹8,180, through its ₹8,000 backstop, and would end the day — second entry
 * and all — on a loss it never took (engine review finding 4).
 *
 * The clock is the day's own (`pb.dayLineSinceMs`), not the trade's shared
 * rupee clock: these lines are read on every pass — flat or holding, staging
 * or exiting — and a trade's latch or finish, which clears the trade's clock,
 * must not restart them. Off either line, it is cleared.
 *
 * Two cases still act at once: a loss of `BACKSTOP_AT_ONCE` x the floor or
 * worse, and a FLAT book, whose P&L is banked rupees with no mark in it to
 * doubt. Playbook books only — `decideDeltaLean`'s own checks are untouched.
 * Returns the decision when a line fires, else the state with its clock.
 */
function dayLines(inputs: DeltaLeanInputs, dials: Dials, st: RuleState, name: string): EngineDecision | RuleState {
  const pnl = totalPnl(inputs);
  const floor = dials.dl_day_max_loss;
  const below = pnl <= -floor;
  // 0 is OFF, as on `decideDeltaLean`: the dial means one thing on both paths.
  const above = dials.dl_day_target > 0 && pnl >= dials.dl_day_target;
  const since = below || above ? (st.pb.dayLineSinceMs > 0 ? st.pb.dayLineSinceMs : inputs.nowMs) : 0;
  const flat = inputs.legs.length === 0;
  const held = flat || inputs.nowMs - since >= dials.pb_rupee_hold_s * 1000;
  const heldFor = flat ? '' : `, held ${dials.pb_rupee_hold_s}s`;
  if (below && (held || pnl <= -BACKSTOP_AT_ONCE * floor)) {
    const why = held ? heldFor : ` — ${BACKSTOP_AT_ONCE} x it or worse, at once`;
    return dayExit(inputs, name, 'dl-stop', `day backstop: ${inr(pnl)} through the ${inr(-floor)} floor${why}`, 'urgent', st, false);
  }
  if (above && held) {
    return dayExit(inputs, name, 'dl-target', `day target: ${inr(pnl)} at or past ${inr(dials.dl_day_target)}${heldFor} — banking it`, 'ladder', st, false);
  }
  return since === st.pb.dayLineSinceMs ? st : { ...st, pb: { ...st.pb, dayLineSinceMs: since } };
}

/** Every field of a trade at its zero: what finishing one clears. The day's
 * statistics, its trade counting (`entries`, `doneForDay`) and its day-line
 * clock (`dayLineSinceMs`) are not here. */
const TRADE_CLEARED: Partial<PlaybookState> = {
  tradeOpenMs: 0, side: '', stage: 0, planShorts: [], planLots: 0, stageMs: 0, stageSpot: 0,
  stageReadyMs: 0, entrySpot: 0, entryStr: 0, entryExtreme: 0, boxHi: 0, boxLo: 0, basePnl: 0,
  peakPnl: 0, trailArmed: false, adds: 0, condSinceMs: 0, rupeeSinceMs: 0,
  exiting: false, exitReason: '', exitUrgency: '', exitMs: 0,
};

/** The trade is over: flat, nothing working to put a leg back (§4.5). Clears it,
 * stamps `lastExitMs` (the cooldown), and latches the day when the entries or a
 * final exit are spent. A hold — on `markState`, where a flat pass lands. */
function finishTrade(f: Frame, why: string): EngineDecision {
  const { ctx, name } = f;
  const done = ctx.pb.doneForDay || ctx.pb.entries >= ctx.dials.pb_max_entries;
  const pb = { ...ctx.pb, ...TRADE_CLEARED, lastExitMs: ctx.nowMs };
  const reason = `${name}: trade finished (${why})${done ? ' — done for the day' : ''}`;
  return hold(reason, { ...ctx.st, dlStopped: ctx.st.dlStopped || done, pb });
}

/**
 * LATCH A PLAYBOOK EXIT (`dl-exit`, spec §4.5) and send its first D2 close.
 * The latch is what makes an exit FINISH: a stop whose condition evaporates
 * once half the book is off must still take the other half (review focus 2),
 * so step 6 re-sends until flat. On both states; a final exit ends the day.
 */
function pbExit(f: Frame, reason: string, urgency: Urgency, final: boolean): EngineDecision {
  const why = bare(f.name, reason);
  const pb = f.ctx.pb;
  const g = withPb(f, {
    ...pb, exiting: true, exitReason: why, exitUrgency: urgency, exitMs: f.ctx.nowMs,
    doneForDay: pb.doneForDay || final, condSinceMs: 0, rupeeSinceMs: 0,
  });
  const legs = f.ctx.inputs.legs;
  if (legs.length > 0) {
    return acted('flatten', 'dl-exit', `${f.name}: ${why} — ${closing(legs)}`, d2Close(legs), g.ctx.st, g.ctx.st, urgency);
  }
  return f.ctx.working ? cancelWorking(g, why, urgency) : finishTrade(g, why);
}

/** Flat while a package works: the exit still ACTS, with no actions — the host
 * cancels only for a decision that acts, and a resting buy could fill later. */
const cancelWorking = (f: Frame, why: string, urgency: Urgency): EngineDecision =>
  acted('flatten', 'dl-exit', `${f.name}: ${why} — flat, cancelling the working package (${working(f.ctx.inputs)})`, [], f.ctx.st, f.ctx.st, urgency);

/**
 * Step 6. Re-send the latched close until flat AND nothing is working. A
 * passive close escalates to urgent after `ESCALATE_MS`, or the moment the
 * hard stop's condition appears (D4) — undebounced: the book is already
 * leaving, and crossing the spread is all that changes.
 */
function exitLatch(f: Frame): EngineDecision {
  const { ctx, name } = f;
  const pb = ctx.pb;
  const legs = ctx.inputs.legs;
  const hardOn = pb.tradeOpenMs > 0 && ctx.tradePnl <= -ctx.dials.pb_trade_max_loss;
  const escalate = pb.exitUrgency === 'passive' && (ctx.nowMs - pb.exitMs >= ESCALATE_MS || hardOn);
  // An unreadable urgency on a latched exit is read as the safe one.
  const urgency: Urgency = escalate || pb.exitUrgency === '' ? 'urgent' : pb.exitUrgency;
  const g = withPb(f, patched(pb, { exitUrgency: urgency }));
  const why = escalate
    ? `${pb.exitReason} — escalated to urgent (${hardOn ? 'the hard stop' : `worked ${ESCALATE_MS / 1000}s`})`
    : pb.exitReason;
  if (legs.length > 0) {
    return acted('flatten', 'dl-exit', `${name}: ${why} — ${closing(legs)}`, d2Close(legs), g.ctx.st, g.ctx.st, urgency);
  }
  return ctx.working ? cancelWorking(g, why, urgency) : finishTrade(g, pb.exitReason);
}

/** The shared rupee clock (`pb.rupeeSinceMs`): kept, or stamped, while `on`. */
const rupeeSince = (pb: PlaybookState, on: boolean, nowMs: number): number =>
  on ? (pb.rupeeSinceMs > 0 ? pb.rupeeSinceMs : nowMs) : pb.rupeeSinceMs;

const hardReason = (ctx: PlaybookCtx): string =>
  `hard stop: trade P&L ${inr(ctx.tradePnl)} at or through the ${inr(-ctx.dials.pb_trade_max_loss)} stop, held ${ctx.dials.pb_rupee_hold_s}s`;

// ── staging (steps 7-8, spec §4.6) ──────────────────────────────────────────

/** A planned short this pass: its cover's lots, what is sold, what may be. */
type ShortView = PlannedShort & { readonly coverLots: number; readonly held: number; readonly want: number; readonly send: number };

/**
 * LOT-PAIRED SIZING (D1): each short is wanted at `min(planLots, its cover's
 * held lots)`, and what may still be sold is capped by its type's free long
 * lots, so even two shorts naming one cover cannot outsell it together.
 */
function shortViews(legs: readonly LegView[], pb: PlaybookState): ShortView[] {
  const room = { CE: 0, PE: 0 };
  for (const l of legs) room[l.optType] += l.side === 'Buy' ? l.lots : -l.lots;
  return pb.planShorts.map((s) => {
    const coverLots = lotsHeld(legs, s.cover, s.optType, 'Buy');
    const held = lotsHeld(legs, s.strike, s.optType, 'Sell');
    const want = Math.min(pb.planLots, coverLots);
    const send = Math.max(0, Math.min(want - held, room[s.optType]));
    room[s.optType] -= send;
    return { ...s, coverLots, held, want, send };
  });
}

/**
 * Steps 7-8. The hard stop first: half a package is still a trade. Stage 1 past
 * `STAGE_ONE_MS` aborts, working or not; working, it waits; with nothing
 * working a missing protective leg aborts (O16) and a complete set stamps
 * `stageReadyMs`. Returns a decision, or the frame of a whole trade.
 */
function staging(f: Frame): EngineDecision | Frame {
  const hardOn = f.ctx.tradePnl <= -f.ctx.dials.pb_trade_max_loss;
  let g = withPb(f, patched(f.ctx.pb, { rupeeSinceMs: hardOn ? rupeeSince(f.ctx.pb, true, f.ctx.nowMs) : 0 }));
  if (hardOn && g.ctx.nowMs - g.ctx.pb.rupeeSinceMs >= g.ctx.dials.pb_rupee_hold_s * 1000) {
    return pbExit(g, hardReason(g.ctx), 'urgent', false);
  }
  const { ctx, name } = g;
  const pb = ctx.pb;
  if (pb.stage === 1 && pb.stageReadyMs === 0) {
    const age = ctx.nowMs - pb.stageMs;
    if (age > STAGE_ONE_MS) {
      return pbExit(g, `stage-1 abort: the protective legs were not all held within ${STAGE_ONE_MS / 1000}s of routing`, 'urgent', false);
    }
    if (ctx.working) {
      return hold(`${name}: stage 1 working — waiting for the protective legs (${working(ctx.inputs)}); ${secs(STAGE_ONE_MS - age)}s of the ${STAGE_ONE_MS / 1000}s window left`, ctx.st);
    }
    const missing = pb.planShorts.filter((s) => lotsHeld(ctx.inputs.legs, s.cover, s.optType, 'Buy') === 0);
    if (missing.length > 0) {
      const list = missing.map((s) => leg(s.cover, s.optType)).join(', ');
      return pbExit(g, `stage-1 abort: protective ${list} not held, and nothing is working`, 'urgent', false);
    }
    g = withPb(g, { ...pb, stageReadyMs: ctx.nowMs });
  }
  return stageTwo(g);
}

/**
 * Step 8 (spec §4.6.4). Abort (the D2 close) when a cover is gone, when `S`
 * moved over `pb_stage_abort_k x STR` from `stageSpot` while a short is still
 * unsold (only measured with `S` fresh and `STR` read — blind, it waits), or a
 * short is unsold `STAGE_TWO_MS` after readiness. Else sell what is missing,
 * under the gates minus the window. Every short held at its size with nothing
 * working: the trade is whole.
 */
function stageTwo(f: Frame): EngineDecision | Frame {
  const { ctx, name } = f;
  const { legs, chain, nowMs } = ctx.inputs;
  const pb = ctx.pb;
  const shorts = shortViews(legs, pb);
  const gone = shorts.find((x) => x.coverLots === 0);
  if (gone !== undefined) {
    return pbExit(f, `stage-2 abort: the ${leg(gone.cover, gone.optType)} cover of the ${leg(gone.strike, gone.optType)} short is not held`, 'urgent', false);
  }
  const naked = uncovered(legs);
  if (naked !== null) return pbExit(f, `stage-2 abort: ${naked}`, 'urgent', false);
  // EVERY SHORT HELD IS A WHOLE TRADE, and the move abort below is over. It
  // guards the SALE — a structure sold into a market that has moved off the
  // one it was planned in — so it can only speak while some short is unsold.
  // Asked after the sale, it closed complete packages: measured from where
  // stage 1 went out, a trend still running the trade's way read as a reason
  // to leave, and on a one-entry book that was the day's only trade (engine
  // review finding 1).
  const missing = shorts.filter((x) => x.held < x.want);
  if (missing.length === 0) {
    if (ctx.working) return hold(`${name}: stage 2 working — every short is held, waiting for the package to clear (${working(ctx.inputs)})`, ctx.st);
    return withPb(f, { ...pb, stage: 0 });
  }
  const steady = steadySpot(ctx.inputs.ring);
  if (ctx.spotFresh && steady !== null && ctx.str !== null && pb.stageSpot > 0) {
    const moved = steady - pb.stageSpot;
    const limit = ctx.dials.pb_stage_abort_k * ctx.str;
    if (Math.abs(moved) > limit) {
      return pbExit(f, `stage-2 abort: the index moved ${moved.toFixed(1)} from ${pb.stageSpot.toFixed(1)} to ${steady.toFixed(1)}, past ${ctx.dials.pb_stage_abort_k} x the ${ctx.str.toFixed(1)} straddle (${limit.toFixed(1)})`, 'urgent', false);
    }
  }
  const since = nowMs - pb.stageReadyMs;
  const list = missing.map((x) => leg(x.strike, x.optType)).join(', ');
  if (since > STAGE_TWO_MS) {
    return pbExit(f, `stage-2 abort: ${list} still unsold ${Math.floor(since / 1000)}s after the protective legs were held`, 'urgent', false);
  }
  const left = `${secs(STAGE_TWO_MS - since)}s of the ${STAGE_TWO_MS / 1000}s window left`;
  if (ctx.working) return hold(`${name}: stage 2 working (${working(ctx.inputs)}); ${left}`, ctx.st);
  const gate = gates(f, 'stage2');
  if (gate !== null) return hold(`${name}: stage 2 waiting — ${gate}; ${left}`, ctx.st);
  const blocked = missing.filter(
    (x) => x.send === 0 || !liquidWing(chain, x.strike, x.optType, ctx.dials, false) || heldOpposite(legs, x.strike, x.optType, 'Sell'),
  );
  if (blocked.length > 0) {
    const what = blocked.map((x) => leg(x.strike, x.optType)).join(', ');
    return hold(`${name}: stage 2 waiting — ${what} not tradable (a fresh two-sided quote inside the spread bar, and a free long to cover it); ${left}`, ctx.st);
  }
  const send = missing.map((x): EngineAction => ({ ...openOf(x.strike, x.optType, 'Sell', legs), lots: x.send }));
  if (pace(send, ctx.inputs, ctx.dials).length < send.length) {
    return hold(`${name}: stage 2 needs ${send.length} order(s) [order budget]; ${left}`, ctx.st);
  }
  const sold = missing.map((x) => `${x.send} ${leg(x.strike, x.optType)} against ${x.coverLots} ${leg(x.cover, x.optType)}`).join(', ');
  const after = { ...ctx.st, dlLastAdjustMs: nowMs, pb: { ...pb, stage: 2 } };
  return acted('adjust', 'dl-open', `${name}: stage 2 — selling ${missing.length} short(s): ${sold}`, send, after, ctx.st, 'passive');
}

// ── managing a held trade (step 9, spec §4.5) ───────────────────────────────

/**
 * THE TAKE PROFIT'S LINE this pass — `pb_trade_target`, and on a whole debit
 * spread no higher than `pb_target_max_frac` x the most it can make (the kit's
 * `debitSpreadMax`). 0 = no take profit.
 *
 * A rupee target is one number for every contract, and a spread's ceiling is
 * not: a one-session pair is narrow (SENSEX's 1-DTE band pair tops out at
 * about ₹9-11.7k at 2 lots, under the ₹12,000 target), and a target above the
 * ceiling is an exit that cannot fire (engine review finding 3). Any other
 * shape — the short not all held, a pyramid's naked long beside the pair — has
 * no ceiling to name, and keeps the plain target.
 */
function takeProfitAt(ctx: PlaybookCtx): { readonly line: number; readonly why: string } {
  const d = ctx.dials;
  if (!(d.pb_trade_target > 0)) return { line: 0, why: '' };
  const max = d.pb_target_max_frac > 0 ? debitSpreadMax(ctx.inputs.legs) : null;
  if (max === null || !(max > 0) || d.pb_target_max_frac * max >= d.pb_trade_target) {
    return { line: d.pb_trade_target, why: '' };
  }
  const pct = Math.round(100 * d.pb_target_max_frac);
  return { line: d.pb_target_max_frac * max, why: ` (${pct}% of the spread's ${inr(max)} maximum)` };
}

/**
 * Step 9. Unknown legs, or a broken D1, close at once. Then the bookkeeping and
 * the exits in spec order — hard stop, the playbook's, trailing floor, take
 * profit, time exit — and only then an add. THE RUPEE CLOCK is one stretch in
 * which SOME rupee rule (the frame's stops, its take profit, or the playbook's
 * `heldRupee`) is in its zone, so neither resets the other's: the frame stamps
 * it for its own before asking the playbook, and resets it after only if
 * nobody holds it. The take profit is on it too: one mark off a briefly wide
 * quote is no more a profit than a loss (spec O19, engine review finding 4).
 */
function manage(f: Frame, playbook: Playbook): EngineDecision {
  const { ctx, name } = f;
  const { legs, nowMs, minuteOfDay } = ctx.inputs;
  const d = ctx.dials;
  if (ctx.pb.tradeOpenMs === 0) {
    return pbExit(f, `${legs.length} leg(s) held with no trade open — not this playbook's to keep`, 'urgent', false);
  }
  const naked = uncovered(legs);
  if (naked !== null) return pbExit(f, `uncovered short: ${naked}`, 'urgent', false);

  const pnl = ctx.tradePnl;
  // Winners run late (D5): before `pb_late_min` the floor arms on
  // `pb_trail_start`, from it on `pb_late_trail_start`; each 0 = off.
  const late = d.pb_late_min > 0 && minuteOfDay >= d.pb_late_min;
  const armAt = late ? d.pb_late_trail_start : d.pb_trail_start;
  const arming = !ctx.pb.trailArmed && armAt > 0 && pnl >= armAt;
  const armed = ctx.pb.trailArmed || arming;
  // A floor ARMED LATE measures from where it armed, not from the morning's
  // best: what the afternoon's floor protects is the trade as it stands at
  // 13:00 (a book up ₹2,000 then never finished below it, spec §1.1), and the
  // morning's peak closed every winner that had given back 40% of it at
  // 13:00:03 (engine review finding 2). A floor armed earlier keeps the peak
  // it has tracked since the entry.
  const peak = arming && late ? pnl : Math.max(ctx.pb.peakPnl, pnl);
  const floor = d.pb_trail_keep * peak;
  const target = takeProfitAt(ctx);
  const hardOn = pnl <= -d.pb_trade_max_loss;
  const trailOn = armed && pnl <= floor;
  const takeOn = target.line > 0 && pnl >= target.line;
  const frameOn = hardOn || trailOn || takeOn;
  const clock0 = rupeeSince(ctx.pb, frameOn, nowMs);
  let g = withPb(f, patched(ctx.pb, { peakPnl: peak, trailArmed: armed, rupeeSinceMs: clock0 }));
  const holdMs = d.pb_rupee_hold_s * 1000;

  if (hardOn && nowMs - clock0 >= holdMs) return pbExit(g, hardReason(g.ctx), 'urgent', false);

  const own = playbook.exits(g.ctx);
  const theirs = own.patch?.rupeeSinceMs;
  const clock1 = frameOn ? clock0 : typeof theirs === 'number' && theirs > 0 ? theirs : 0;
  g = withPb(g, patched(patched(g.ctx.pb, own.patch, STRATEGY_FIELDS), { rupeeSinceMs: clock1 }));
  if (own.exit !== undefined) return pbExit(g, own.exit.reason, own.exit.urgency, own.exit.final);

  if (trailOn && nowMs - clock1 >= holdMs) {
    return pbExit(g, `trailing floor: trade P&L ${inr(pnl)} at or under ${Math.round(d.pb_trail_keep * 100)}% of the ${inr(peak)} peak (${inr(floor)}), held ${d.pb_rupee_hold_s}s`, 'urgent', false);
  }
  if (takeOn && nowMs - clock1 >= holdMs) {
    return pbExit(g, `take profit: trade P&L ${inr(pnl)} at or past ${inr(target.line)}${target.why}, held ${d.pb_rupee_hold_s}s`, 'passive', false);
  }
  if (d.pb_time_exit_min > 0 && minuteOfDay >= d.pb_time_exit_min) {
    return pbExit(g, `time exit: ${clock(minuteOfDay)} at or past ${clock(d.pb_time_exit_min)} — final for the day`, 'passive', true);
  }

  // ADDS (D6): capped by the frame, single-stage buys, gated minus the window.
  let note = own.note;
  if (g.ctx.pb.adds < d.pb_max_adds) {
    const add = playbook.adds(g.ctx);
    g = withPb(g, patched(g.ctx.pb, add.patch, STRATEGY_FIELDS));
    if (add.add !== undefined) {
      const gate = gates(g, 'add');
      if (gate !== null) return hold(`${name}: add wanted (${bare(name, add.add.reason)}) — ${gate}`, g.ctx.st);
      return openPackage(g, add.add, 'dl-add');
    }
    note = add.note ?? note;
  }
  const trail = armed ? `, floor ${inr(floor)}` : '';
  const taking = takeOn ? `, take profit ${inr(target.line)} reached, held ${Math.floor((nowMs - clock1) / 1000)}s of ${d.pb_rupee_hold_s}s` : '';
  return hold(named(name, note ?? `holding — trade P&L ${inr(pnl)}, peak ${inr(peak)}${trail}${taking}`), g.ctx.st);
}

// ── new risk (steps 11-12, spec §4.3, §4.6) ─────────────────────────────────

type GateMode = 'entry' | 'stage2' | 'add';

/** The contract the preset may trade (D8, D11), or why this one is not it. */
function contractFault(ctx: PlaybookCtx): string | null {
  const { chain, dateIst } = ctx.inputs;
  const out = ctx.tradingDte < 0 ? 'is not a live contract' : `is ${ctx.tradingDte} trading day(s) out`;
  if (ctx.dials.pb_expiry_day_only && chain.expiry !== dateIst) {
    return `wrong contract: the preset trades only today's expiry, and ${chain.expiry} ${out}`;
  }
  if (ctx.tradingDte < ctx.dials.pb_min_dte) return `wrong contract: ${chain.expiry} ${out}, under the ${ctx.dials.pb_min_dte} the preset needs`;
  return null;
}

/**
 * THE NEW-RISK GATES (spec §4.3 step 11), the first failure named with its
 * numbers. Stage 2 and an add skip the window, the entry count and the
 * cooldown, which admit TRADES, not packages; stage 2 is paced by
 * `pb_stage_gap_s`, the rest by `pb_retry_s`. The straddle is asked before the
 * regime, which cannot be read without it: "unknown" would hide the cause.
 */
function gates(f: Frame, mode: GateMode): string | null {
  const { ctx } = f;
  const { inputs, dials: d, pb, st } = ctx;
  const { nowMs, minuteOfDay: m, dateIst, chain } = inputs;
  if (!isTradingDay(dateIst)) return `${dateIst} is not an NSE trading day`;
  const wrong = contractFault(ctx);
  if (wrong !== null) return wrong;
  if (mode === 'entry' && (m < d.pb_entry_start_min || m >= d.pb_entry_end_min)) {
    return `${clock(m)} is outside the ${clock(d.pb_entry_start_min)}-${clock(d.pb_entry_end_min)} entry window`;
  }
  if (m < d.dl_warmup_min) return `warm-up: ${clock(m)} is before ${clock(d.dl_warmup_min)}`;
  if (mode === 'entry') {
    if (pb.doneForDay) return 'done for the day';
    if (pb.entries >= d.pb_max_entries) return `${pb.entries} of ${d.pb_max_entries} trade(s) taken today`;
    const sinceExit = nowMs - pb.lastExitMs;
    if (pb.lastExitMs > 0 && sinceExit < d.pb_reentry_cooldown_s * 1000) {
      return `${secs(d.pb_reentry_cooldown_s * 1000 - sinceExit)}s left of the ${d.pb_reentry_cooldown_s}s re-entry cooldown`;
    }
  }
  const [paceS, what] = mode === 'stage2' ? [d.pb_stage_gap_s, 'stage gap'] : [d.pb_retry_s, 'retry interval'];
  const sinceAdjust = nowMs - st.dlLastAdjustMs;
  if (st.dlLastAdjustMs > 0 && sinceAdjust < paceS * 1000) {
    return `${secs(paceS * 1000 - sinceAdjust)}s left of the ${paceS}s ${what} since the last package`;
  }
  if (inputs.repairHold) return 'repair-Apply is working this tag';
  if (ctx.working) return `a package is working (${working(inputs)})`;
  if (!ctx.spotFresh) {
    const age = Math.max(nowMs - inputs.spotAsOf, nowMs - (inputs.ring.latest()?.ms ?? 0));
    return ctx.spot === null ? 'no index level on the ring' : `the index is ${(age / 1000).toFixed(1)}s stale, past ${d.dl_spot_stale_s}s`;
  }
  const chainAge = nowMs - chain.asOf;
  if (!(chainAge <= CHAIN_FRESH_MS)) return `the chain is ${(chainAge / 1000).toFixed(1)}s old, past ${CHAIN_FRESH_MS / 1000}s`;
  const newest = newestQuoteMs(chain);
  if (newest === null) return 'the chain carries no option quote';
  if (!(nowMs - newest <= CHAIN_FRESH_MS)) {
    return `the newest option quote is ${((nowMs - newest) / 1000).toFixed(1)}s old, past ${CHAIN_FRESH_MS / 1000}s: the option feed is frozen`;
  }
  if (!ctx.forwardOk) return `the chain's forward is ${inputs.forwardSource ?? 'unknown'}, not the contract's own (parity or index-carry)`;
  if (ctx.str === null) return 'no ATM straddle reading';
  if (ctx.regime === 'unknown') return 'the regime is unknown';
  const gap = ctx.gapPct;
  if (gap !== null && d.pb_gap_min_pct > 0 && Math.abs(gap) < d.pb_gap_min_pct) {
    return `the opening gap is ${gap.toFixed(2)}%, under the ${d.pb_gap_min_pct.toFixed(2)}% minimum`;
  }
  if (gap !== null && d.pb_gap_max_pct > 0 && Math.abs(gap) >= d.pb_gap_max_pct) {
    return `the opening gap is ${gap.toFixed(2)}%, at or over the ${d.pb_gap_max_pct.toFixed(2)}% maximum`;
  }
  return null;
}

/** CAN THE FRAME STAGE THIS SAFELY? Every buy not held short; every short
 * covered by a buy of its type on another strike, not held long; no type
 * selling more legs than it buys; an add a buy alone (D6). */
function planFault(plan: OpenPlan, legs: readonly LegView[], trigger: 'dl-open' | 'dl-add'): string | null {
  if (!(Number.isFinite(plan.lots) && plan.lots >= 1)) return `${plan.lots} lot(s) a leg`;
  if (plan.protective.length === 0) return 'no protective leg to buy';
  if (trigger === 'dl-add' && plan.shorts.length > 0) return 'an add is a single-stage buy (D6), and this one sells';
  const count = { CE: 0, PE: 0 };
  for (const a of plan.protective) {
    if (a.side !== 'Buy') return `${leg(a.strike, a.optType)} is not a buy`;
    if (heldOpposite(legs, a.strike, a.optType, 'Buy')) return `${leg(a.strike, a.optType)} is held short`;
    count[a.optType] += 1;
  }
  for (const s of plan.shorts) {
    const name = leg(s.strike, s.optType);
    if (!plan.protective.some((a) => a.optType === s.optType && Math.abs(a.strike - s.cover) <= EPS)) {
      return `the ${name} short names no protective ${s.optType} at ${s.cover}`;
    }
    if (Math.abs(s.strike - s.cover) <= EPS) return `the ${name} short is its own cover`;
    if (heldOpposite(legs, s.strike, s.optType, 'Sell')) return `${name} is held long`;
    count[s.optType] -= 1;
  }
  for (const t of TYPES) {
    const shorts = plan.shorts.filter((s) => s.optType === t).length;
    if (count[t] < 0) return `${shorts} ${t} short(s) against ${shorts + count[t]} ${t} long(s)`;
  }
  return null;
}

/** STAGE 1 OF AN ENTRY, or an ADD (spec §4.6.1-2, .5): the whole structure
 * sized to `margin_cap` (`fitLots`; 0 lots waits), the buys sent, the shorts
 * kept as `planShorts`. `openOf` marks a same-side add `add`, nothing else (F4). */
function openPackage(f: Frame, plan: OpenPlan, trigger: 'dl-open' | 'dl-add'): EngineDecision {
  const { ctx, name } = f;
  const { inputs, dials: d, pb, st } = ctx;
  const legs = inputs.legs;
  const reason = bare(name, plan.reason);
  const lead = trigger === 'dl-add' ? `add wanted (${reason})` : reason;
  const fault = planFault(plan, legs, trigger);
  if (fault !== null) return hold(`${name}: ${lead} — plan refused: ${fault}`, st);
  const buys = plan.protective.map((a) => openOf(a.strike, a.optType, 'Buy', legs));
  const sales = plan.shorts.map((s): EngineAction => ({ op: 'open', strike: s.strike, optType: s.optType, side: 'Sell', lots: 1 }));
  const lots = fitLots(inputs, d, [...buys, ...sales], plan.lots);
  if (lots === 0) return hold(`${name}: ${lead} — not one lot fits the ${inr(d.margin_cap)} SPAN cap`, st);
  const send = scaleLots(buys, lots);
  if (pace(send, inputs, d).length < send.length) return hold(`${name}: ${lead} — needs ${send.length} order(s) [order budget]`, st);

  const trim = lots < Math.trunc(plan.lots) ? `, trimmed from ${Math.trunc(plan.lots)} by the ${inr(d.margin_cap)} SPAN cap` : '';
  if (trigger === 'dl-add') {
    const after = { ...st, dlLastAdjustMs: ctx.nowMs, pb: { ...pb, adds: pb.adds + 1 } };
    return acted('adjust', 'dl-add', `${name}: ${reason} — adding ${send.length} long(s) at ${lots} lot(s)${trim}`, send, after, st, 'passive');
  }
  const S = steadySpot(inputs.ring) ?? ctx.fwd;
  const opened: PlaybookState = {
    ...pb, ...TRADE_CLEARED,
    entries: pb.entries + 1, tradeOpenMs: ctx.nowMs, side: plan.side, stage: plan.shorts.length > 0 ? 1 : 0,
    planShorts: plan.shorts.map(({ strike, optType, cover }) => ({ strike, optType, cover })),
    planLots: lots, stageMs: ctx.nowMs, stageSpot: S, entrySpot: S, entryStr: ctx.str ?? 0, basePnl: ctx.totalPnl,
  };
  const s = plan.stamps;
  const pbAfter = s === undefined ? opened : patched(opened, { entryStr: s.entryStr, entryExtreme: s.entryExtreme, boxHi: s.boxHi, boxLo: s.boxLo });
  const what = plan.shorts.length > 0
    ? `stage 1: buying ${send.length} protective leg(s) at ${lots} lot(s) a leg${trim}; ${plan.shorts.length} short(s) to follow once covered`
    : `buying ${send.length} leg(s) at ${lots} lot(s) a leg${trim}`;
  return acted('adjust', 'dl-open', `${name}: ${reason} — ${what}`, send, { ...st, dlLastAdjustMs: ctx.nowMs, pb: pbAfter }, st, 'passive');
}

// ── the pass ────────────────────────────────────────────────────────────────

/**
 * The frame over a registry: `decidePlaybook` is it over `PLAYBOOKS`, and a test
 * registers a scripted strategy of its own. An id the registry does not hold
 * trades nothing and closes what is held: no rules is no reason to keep a position.
 */
export function makeDecidePlaybook(
  registry: ReadonlyMap<number, Playbook>,
): (inputs: DeltaLeanInputs, dials: Dials, state: RuleState, markCtx: MarkContext) => EngineDecision {
  return function decidePlaybook(inputs, dials, state, markCtx) {
    void markCtx;
    const { minuteOfDay: m, dateIst, nowMs } = inputs;
    const playbook = registry.get(dials.pb_playbook);
    const name = playbook?.name ?? `pb_playbook ${dials.pb_playbook}`;

    // ── 0. the day roll — a playbook book is intraday: it never holds over ─
    const rolled = rollDay(state, dateIst, nowMs, false);

    // ── 1-4. the day's exits, above everything a strategy can say ─────────
    if (rolled.dlStopped) return dayExit(inputs, name, 'dl-stop', 'stopped for the day', 'urgent', rolled, false);
    if (m >= dials.dl_flat_by_min) {
      return dayExit(inputs, name, 'eod', `${clock(m)} is past the ${clock(dials.dl_flat_by_min)} flat-by`, 'ladder', rolled, true);
    }
    if (m >= dials.dl_flatten_urgent_min) return dayExit(inputs, name, 'eod', `${clock(m)}: urgent flatten`, 'urgent', rolled, true);
    if (m >= dials.dl_flatten_passive_min) {
      // Never gentler than a latched urgent stop: 14:50 must not re-work a
      // stop's remaining legs passively (the host ranks work modes, F8).
      const stop = rolled.pb.exiting && rolled.pb.exitUrgency === 'urgent';
      const why = stop ? `passive flatten, crossed for the latched ${rolled.pb.exitReason}` : 'passive flatten — worked, not crossed';
      return dayExit(inputs, name, 'eod', `${clock(m)}: ${why}`, stop ? 'urgent' : 'passive', rolled, true);
    }
    // Steps 3-4, the backstop then the target, each held like any rupee rule.
    const lined = dayLines(inputs, dials, rolled, name);
    if ('action' in lined) return lined;

    // ── 5. the fold ─────────────────────────────────────────────────────────
    const f = fold(inputs, dials, lined, name);

    // ── 6. the exit latch — it needs no strategy, only the book ────────────
    if (f.ctx.pb.exiting) return exitLatch(f);
    if (playbook === undefined) {
      return inputs.legs.length > 0
        ? pbExit(f, 'names no playbook on this build — closing what is held', 'urgent', true)
        : hold(`${name}: names no playbook on this build — nothing to trade`, f.ctx.st);
    }

    // ── 7-8. a package not yet whole ────────────────────────────────────────
    let g = f;
    if (f.ctx.pb.tradeOpenMs > 0 && f.ctx.pb.stage >= 1) {
      const staged = staging(f);
      if ('action' in staged) return staged;
      g = staged;
    }

    // ── 9. a held trade ─────────────────────────────────────────────────────
    if (inputs.legs.length > 0) return manage(g, playbook);

    // ── 10. a trade with no legs: over, unless something may still fill ────
    if (g.ctx.pb.tradeOpenMs > 0) {
      return g.ctx.working
        ? hold(`${name}: the trade's package is working (${working(inputs)}) — nothing held yet`, g.ctx.st)
        : finishTrade(g, 'flat with nothing working');
    }

    // ── 11-12. new risk ─────────────────────────────────────────────────────
    const gate = gates(g, 'entry');
    if (gate !== null) return hold(`${name}: no new risk — ${gate}`, g.ctx.st);
    const v = playbook.enter(g.ctx);
    if (v.kind === 'wait') return hold(named(name, v.reason), g.ctx.st);
    return openPackage(g, v.plan, 'dl-open');
  };
}

/** The production frame: `pb_playbook` 1-6, as `registry.ts` names them. */
export const decidePlaybook = makeDecidePlaybook(PLAYBOOKS);
