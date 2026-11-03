/**
 * WING STRADDLE (id 2) and EXPIRY THETA FLY (id 5) — six-playbooks spec v2
 * §5.2 and §5.5: short premium sold as an iron fly. One factory, two presets.
 *
 * ── ONE STRATEGY, TWO CLOCKS ────────────────────────────────────────────────
 * Both sell the ATM straddle into a market doing less than the straddle
 * charges for, with a wing bought each side so the sale has a floor (D1). What
 * differs is WHEN the decay is collected, and the dials carry all of it:
 *
 *   Wing Straddle   a contract five or more sessions out, sold in the morning
 *                   (D3) at one lot, wings 2.0 x STR out. It leaves on its
 *                   COMBINED stop — the shorts at 1.25x what they were sold for
 *                   — or its INDEX stop, a whole entry straddle away.
 *   Expiry Theta    today's contract after 13:00 (D3) at two lots, wings 1.25 x
 *                   STR out, sold only into a calm half hour. It leaves on a
 *                   TREND held a minute, the start of a gamma blast, or at half
 *                   its credit. No index stop: on a 0-DTE afternoon one at 0.6
 *                   x STR is touched most days by the straddle's own variance,
 *                   so the hard stop and the wings bound the loss (§5.5).
 *
 * A rule whose dial is 0 is OFF, so each rule is written once here and each
 * preset switches on its own.
 *
 * ── THE DAY GATE, CHOSEN BY THE DIALS ───────────────────────────────────────
 * `pb_max_move_k > 0` asks how far the index has come from the open, which
 * needs the open. The Wing Straddle asks `dayComplete` (§5.2) and the Theta
 * Fly asks `dayRobust` (§5.5). This file tells them apart by the calm filter's
 * dial: `pb_calm_min > 0` → `dayRobust`, else `dayComplete`. For the two
 * presets that is the spec exactly, since the Theta Fly is the one with a calm
 * filter. It is also the right pairing for any preset: a book that trusts the
 * tape's last half hour to call the market calm must trust the tape to have no
 * hole in it.
 *
 * ── WHAT THE FRAME ALREADY DID ──────────────────────────────────────────────
 * The gap gates (D10), the contract, the window, every staleness gate, the
 * staging (both wings first, each short sold against its own wing), the hard
 * stop, the trail, the rupee take profit, the clock and every abort belong to
 * the frame (`decide.ts`). This file answers "open?" and "close?" and nothing
 * else, in bare reasons: the frame prefixes the name.
 *
 * ── THE DEBOUNCES ───────────────────────────────────────────────────────────
 * The combined stop and the credit take profit are RUPEE rules. `heldRupee`
 * debounces both on the clock they share with the frame's hard stop, trail
 * and take profit, because one wide quote on an ATM leg is not a loss (O19),
 * nor a profit. The index stop is an INDEX stop, debounced by
 * `held` on `condSinceMs` and skipped while `S` is stale (O1). Both clocks ride
 * the step's `patch` on every path, fired or not, so each stretch is measured
 * on one continuous condition.
 *
 * PURE, like the rest of the engine.
 */
import type { PlaybookState, Urgency } from '../../types.ts';
import { inr } from '../decide.ts';
import { flyPlan, held, heldRupee, onTape, shortsValue, steadySpot, trendSide, windowRange } from './kit.ts';
import type { EntryVerdict, Playbook, PlaybookCtx, PlaybookStep } from './types.ts';

const MINUTE_MS = 60_000;

const wait = (reason: string): EntryVerdict => ({ kind: 'wait', reason });
/** Whole seconds elapsed, rounded down: a hold is not met until it is met. */
const secs = (ms: number): number => Math.floor(ms / 1000);

// ── enter ───────────────────────────────────────────────────────────────────

/**
 * THE DAY GATE (`pb_max_move_k`): the index within k x `Dday` of the open,
 * inclusive. A day that has already run is no day to sell its straddle, and
 * `Dday` (the move priced for one session) is the unit (D7). `null` when the
 * gate passes. A stale `S` is no reading: the frame's gate refuses it before
 * any entry, and this rule refuses it again rather than measure from it. `S`
 * is STEADIED (kit `steadySpot`): one bad print must neither keep a calm
 * morning's fly out nor let one in on a day that has run (M11, engine review
 * finding 5).
 */
function dayGate(ctx: PlaybookCtx): string | null {
  const d = ctx.dials;
  if (!(d.pb_max_move_k > 0)) return null;
  if (!ctx.dayComplete) return 'the fold did not see the open (its first print was after 09:16): no move from the open to measure';
  if (d.pb_calm_min > 0 && !ctx.dayRobust) {
    return `a hole of ${(ctx.pb.maxGapMs / MINUTE_MS).toFixed(1)} min in today's tape, past the ${d.pb_max_gap_min} min pb_max_gap_min: the open and the extremes it folded are not trusted`;
  }
  if (ctx.dayImplied === null) return 'no Dday yet: the move from the open has no unit';
  const open = ctx.pb.dayOpen;
  if (!(open > 0)) return 'no open folded yet: no move from the open to measure';
  const spot = ctx.spotFresh ? steadySpot(ctx.inputs.ring) : null;
  if (spot === null) return 'the index is stale: no move from the open to measure';
  const move = Math.abs(spot - open);
  const limit = d.pb_max_move_k * ctx.dayImplied;
  if (move > limit) {
    return `the index is ${move.toFixed(1)} from the ${open.toFixed(1)} open, past ${d.pb_max_move_k} x the ${ctx.dayImplied.toFixed(1)} Dday (${limit.toFixed(1)})`;
  }
  return null;
}

/**
 * THE CALM FILTER (`pb_calm_min`): over the last `pb_calm_min` minutes the
 * index ranged no more than `pb_calm_mult` x the move the options priced for
 * them. The expected range is about 2 x that move, so 1.5 asks for a calmer
 * half hour than the one priced. The window must be covered (`windowRange`,
 * 90%, no long hole): a tape that missed part of it would call a missed move
 * calm. `null` when the filter passes or is off.
 */
function calmGate(ctx: PlaybookCtx): string | null {
  const d = ctx.dials;
  if (!(d.pb_calm_min > 0)) return null;
  const r = windowRange(ctx, ctx.nowMs - d.pb_calm_min * MINUTE_MS, ctx.nowMs);
  if (r === null) return `the ring does not cover the last ${d.pb_calm_min} min (90% of it, with no long hole): a missed move is not a calm one`;
  const imp = ctx.imp(d.pb_calm_min);
  if (imp === null) return `no implied move over ${d.pb_calm_min} min to measure the tape against`;
  const range = r.hi - r.lo;
  const limit = d.pb_calm_mult * imp;
  if (range > limit) {
    return `not calm: the last ${d.pb_calm_min} min ranged ${range.toFixed(1)}, past ${d.pb_calm_mult} x the ${imp.toFixed(1)} implied move (${limit.toFixed(1)})`;
  }
  return null;
}

/**
 * OPEN? Quiet or chop, held `pb_confirm_s`: a fly is sold only into a market
 * doing less than it is charged for, never into a trend, and never on
 * `unknown`, which is no reading at all. Then the day gate, the calm filter
 * and the kit's iron fly at the money. The frame stages the plan: the two
 * wings, then each short against its own wing.
 */
function enter(ctx: PlaybookCtx): EntryVerdict {
  const d = ctx.dials;
  const regime = ctx.regime;
  if (regime !== 'quiet' && regime !== 'chop') {
    return wait(`the slow regime is ${regime}, not quiet or chop: a fly is sold only into a market doing less than it is charged for`);
  }
  if (ctx.regimeHeldMs < d.pb_confirm_s * 1000) {
    return wait(`${regime} has held ${secs(ctx.regimeHeldMs)}s of the ${d.pb_confirm_s}s it needs`);
  }
  const day = dayGate(ctx);
  if (day !== null) return wait(day);
  const calm = calmGate(ctx);
  if (calm !== null) return wait(calm);
  const fly = flyPlan(ctx);
  const str = ctx.str;
  if (fly === null || str === null) {
    return wait('no fly on this board: the ATM centre or a wing is unlisted, held the other way, or without a fresh two-sided quote inside the spread bar');
  }
  const ce = fly.protective.find((a) => a.optType === 'CE')?.strike;
  const pe = fly.protective.find((a) => a.optType === 'PE')?.strike;
  return {
    kind: 'open',
    plan: {
      side: 'none',
      protective: fly.protective,
      shorts: fly.shorts,
      lots: d.pb_lots,
      reason: `${regime} for ${secs(ctx.regimeHeldMs)}s — an iron fly at ${fly.centre}, wings ${pe}PE / ${ce}CE, against a ${str.toFixed(1)} straddle`,
      // The index stop's unit, frozen at the open: a stop measured in the
      // afternoon's straddle would drift with it.
      stamps: { entryStr: str },
    },
  };
}

// ── exits ───────────────────────────────────────────────────────────────────

/**
 * CLOSE? The four rules in spec order. The stops come first and are urgent;
 * the credit target is last and passive. None is final, since the frame's
 * entry count and cooldown decide whether the day goes on. Every debounce
 * clock rides `patch` on every path, and a clock still running is named in
 * `note`, the pass's hold reason.
 *
 *   1. COMBINED STOP (`pb_combined_stop`): the shorts' ASK-side value, what
 *      buying them back costs now, at or past (1 + k) x what they were sold
 *      for, held `pb_rupee_hold_s`. A short with no ask is no reading, so the
 *      stop never prices a straddle off one leg.
 *   2. INDEX STOP (`pb_stop_str_k`): |S - entrySpot| at or past k x
 *      `entryStr`, held `pb_stop_hold_s`. `S` and never the forward. Skipped
 *      while `S` is stale or the trade has no entry straddle to measure in:
 *      k x 0 would fire on any print.
 *   3. TREND EXIT (`pb_trend_exit_s`): the slow regime a trend, held that
 *      long. The regime clock is the dwell, so this rule needs no clock of
 *      its own.
 *   4. TAKE PROFIT (`pb_target_frac`): trade P&L at or past that share of the
 *      credit, held `pb_rupee_hold_s` on the shared rupee clock. Only a credit
 *      has a share to take (`cost < 0`).
 */
function exits(ctx: PlaybookCtx): PlaybookStep {
  const d = ctx.dials;
  const pb = ctx.pb;
  const now = ctx.nowMs;
  let patch: Partial<PlaybookState> = {};
  const notes: string[] = [];
  let stop: string | null = null;

  if (d.pb_combined_stop > 0) {
    const v = shortsValue(ctx.inputs.legs);
    if (v !== null && v.entry > 0) {
      const bar = 1 + d.pb_combined_stop;
      const ratio = v.now / v.entry;
      const on = v.now >= bar * v.entry;
      const deb = heldRupee(ctx, on);
      patch = { ...patch, ...deb.patch };
      if (deb.fire) {
        stop = `combined stop: the shorts' ask-side value ${inr(v.now)} is ${ratio.toFixed(2)}x their ${inr(v.entry)} entry value, at or past ${bar}x, held ${d.pb_rupee_hold_s}s`;
      } else if (on) {
        const since = deb.patch.rupeeSinceMs ?? now;
        notes.push(`combined stop in its zone: the shorts at ${ratio.toFixed(2)}x their entry value, held ${secs(now - since)}s of ${d.pb_rupee_hold_s}s`);
      }
    }
  }

  if (d.pb_stop_str_k > 0) {
    const spot = ctx.spot;
    const limit = d.pb_stop_str_k * pb.entryStr;
    const dist = ctx.spotFresh && spot !== null && pb.entrySpot > 0 && pb.entryStr > 0 ? Math.abs(spot - pb.entrySpot) : null;
    const on = dist !== null && dist >= limit;
    const deb = held(ctx, on, d.pb_stop_hold_s);
    patch = { ...patch, ...deb.patch };
    if (deb.fire && dist !== null && stop === null) {
      stop = `index stop: the index is ${dist.toFixed(1)} from the ${pb.entrySpot.toFixed(1)} entry, at or past ${d.pb_stop_str_k} x the ${pb.entryStr.toFixed(1)} entry straddle (${limit.toFixed(1)}), held ${d.pb_stop_hold_s}s`;
    } else if (on && !deb.fire) {
      const since = deb.patch.condSinceMs ?? now;
      notes.push(`index stop in its zone: the index is ${dist.toFixed(1)} from the entry, held ${secs(now - since)}s of ${d.pb_stop_hold_s}s`);
    }
  }

  const out = (reason: string, urgency: Urgency): PlaybookStep => ({ exit: { reason, urgency, final: false }, patch });
  if (stop !== null) return out(stop, 'urgent');

  // The 60 s trend exit sits inside the detector's 120 s dwell, so the trend
  // must be on the slow window itself (kit `onTape`, M11): a label one bad
  // print turned is no gamma blast, and closing a fly on it pays the spread for
  // nothing. A real break IS on the tape — that is what labelled it.
  if (d.pb_trend_exit_s > 0 && trendSide(ctx.regime) !== null && ctx.regimeHeldMs >= d.pb_trend_exit_s * 1000 && onTape(ctx) === ctx.regime) {
    return out(`trend exit: the slow regime is ${ctx.regime}, held ${secs(ctx.regimeHeldMs)}s (the ${d.pb_trend_exit_s}s bar) — a fly is the wrong book in a trend`, 'urgent');
  }

  if (d.pb_target_frac > 0 && ctx.cost < 0) {
    const credit = -ctx.cost;
    const share = Math.round((100 * ctx.tradePnl) / credit);
    // A RUPEE rule like the stops: one pass with an ATM short's ask briefly
    // off reads as profit as readily as a loss, so the take profit holds on
    // the shared rupee clock too before it banks the fly (O19, engine review
    // finding 4).
    const deb = heldRupee(ctx, ctx.tradePnl >= d.pb_target_frac * credit);
    patch = { ...patch, ...deb.patch };
    if (deb.fire) {
      return out(`take profit: trade P&L ${inr(ctx.tradePnl)} is ${share}% of the ${inr(credit)} credit, at or past ${Math.round(100 * d.pb_target_frac)}%, held ${d.pb_rupee_hold_s}s`, 'passive');
    }
    if (deb.patch.rupeeSinceMs !== undefined) {
      notes.push(`take profit in its zone: ${share}% of the ${inr(credit)} credit, held ${secs(now - deb.patch.rupeeSinceMs)}s of ${d.pb_rupee_hold_s}s`);
    }
  }

  return notes.length > 0 ? { patch, note: `${notes.join('; ')} — trade P&L ${inr(ctx.tradePnl)}` } : { patch };
}

// ── the factory ─────────────────────────────────────────────────────────────

/** One short-premium fly. The id selects the preset, and the preset's dials
 * decide which rules are on. A fly never pyramids, so `adds` is always `{}`. */
function thetaFly(id: number, name: string): Playbook {
  return { id, name, enter, exits, adds: () => ({}) };
}

export const WING_STRADDLE: Playbook = thetaFly(2, 'wing-straddle');
export const EXPIRY_THETA: Playbook = thetaFly(5, 'expiry-theta');
