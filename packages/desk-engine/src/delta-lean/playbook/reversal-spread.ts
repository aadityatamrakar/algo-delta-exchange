/**
 * REVERSAL SPREAD (id 3) — six-playbooks spec v2 §5.3.
 *
 * THE V-DAY TRADE. A morning that ran a long way from its open and has turned
 * is the one day shape the trend books lose on and nothing else catches
 * (spec §6: gap-fade and V-reversal are "+" here and "−" on Trend Drive). So
 * this book waits for exactly that shape and buys a debit spread the other
 * way: the call spread after a fall, the put spread after a rally.
 *
 * ── THE ENTRY: AN EXCURSION, A RETRACE, A TURN ──────────────────────────────
 *   1. The day can be trusted (`dayRobust`): the fold saw the open, and the
 *      tape has no hole that could hide the very high it would fade.
 *   2. The EXCURSION — `H - O` or `O - L`, the larger — is at least
 *      `pb_rev_min_ext` x `Dday`: a move the options did not price as routine.
 *   3. `S` has given back at least `pb_rev_retrace` of it, and is STILL on the
 *      excursion's side of the open — a fade that has already reached the
 *      open has nothing left to pay, and its profit exit would fire at once.
 *   4. The slow regime is the COUNTER-trend, held `pb_confirm_s`: a retrace
 *      that drifts is a pause, one that trends is a turn.
 * The extremes are the fold's median-of-3 (`SpotRing.filteredRange`), so one
 * bad print can never be an excursion (spec M11). The plan stamps the extreme
 * it fades (`entryExtreme`) — the level the trade is wrong beyond.
 *
 * ── THE EXITS, URGENT FIRST ─────────────────────────────────────────────────
 *   new extreme   `S` past `entryExtreme` by `pb_rev_stop_k` x `Dday`, held
 *                 `pb_stop_hold_s` — the excursion resumed; the trade is wrong;
 *   flip back     the ORIGINAL trend held `pb_flip_confirm_s` while the trade
 *                 is not winning (D5: a winner is let run);
 *   debit stop    `pb_debit_stop_frac` of the debit lost, held on the shared
 *                 rupee clock;
 *   back to open  `S` at the open (passive) — the fade has paid what it was
 *                 bought for.
 * The frame has already run the hard stop, and runs the trail (from 13:00),
 * the take profit and the clock after these. Index rules read `S` and are
 * skipped while it is stale; the rupee stop and the flip are not index rules.
 * Back to the open is the spec's UNDEBOUNCED "`S` reaches `O`": one bad print
 * through the open ends the fade early — passively, at the touch — so what it
 * can cost is the rest of the fade, never a larger loss. The new-extreme stop,
 * which a bad print could otherwise turn into a loss, holds `pb_stop_hold_s`.
 *
 * No pyramid (`adds` answers nothing): a fade adds into a market that has not
 * yet proved it turned.
 *
 * PURE: every reading is a field of the `PlaybookCtx` the frame built. Reasons
 * are bare — the frame prefixes the playbook's name.
 */
import { inr } from '../decide.ts';
import type { Regime } from '../regime.ts';
import { debitByBands, held, heldRupee, onTape, steadySpot } from './kit.ts';
import type { EntryVerdict, Playbook, PlaybookCtx, PlaybookStep } from './types.ts';

const wait = (reason: string): EntryVerdict => ({ kind: 'wait', reason });
const secs = (ms: number): number => Math.floor(ms / 1000);
const pts = (x: number): string => x.toFixed(1);

/** Why the day's statistics cannot be faded off, or null when they can. */
function untrusted(ctx: PlaybookCtx): string | null {
  if (ctx.dayRobust) return null;
  if (!ctx.dayComplete) return 'the fold never saw the open (its first print came after 09:16): no morning excursion to measure';
  return `the tape has a ${Math.ceil(ctx.pb.maxGapMs / 60_000)}-minute hole, past ${ctx.dials.pb_max_gap_min} min: the day's high and low may have missed the move`;
}

function enter(ctx: PlaybookCtx): EntryVerdict {
  const d = ctx.dials;
  const doubt = untrusted(ctx);
  if (doubt !== null) return wait(doubt);
  const dday = ctx.dayImplied;
  if (dday === null) return wait('no day move (Dday) frozen yet');
  const S = ctx.spot;
  if (S === null || !ctx.spotFresh) return wait('the index is stale');

  const { dayOpen: O, dayHigh: H, dayLow: L } = ctx.pb;
  const up = H - O;
  const dn = O - L;
  // The LARGER excursion is the one faded; a tie (measure zero) fades the rally.
  const rally = up >= dn;
  const ext = rally ? up : dn;
  const need = d.pb_rev_min_ext * dday;
  if (!(ext >= need)) {
    return wait(`the morning excursion is ${pts(ext)} points (${rally ? 'up' : 'down'}), under ${d.pb_rev_min_ext} x the ${pts(dday)} day move (${pts(need)})`);
  }
  const extreme = rally ? H : L;
  const given = rally ? H - S : S - L;
  const back = d.pb_rev_retrace * ext;
  if (!(given >= back)) {
    return wait(`fading the ${rally ? 'up' : 'down'} excursion of ${pts(ext)}: ${pts(given)} given back, under the ${pts(back)} (${d.pb_rev_retrace} x) it takes`);
  }
  if (!(rally ? S > O : S < O)) {
    return wait(`the index ${pts(S)} is back through the open ${pts(O)}: the excursion is spent`);
  }
  // ROOM TO THE TARGET (Task 11 finding): the trade's target is the open, so a
  // fade confirmed with almost nothing left to it is a round trip in a minute.
  // The give-back must sit inside the band [retrace, 1 - retrace] of the
  // excursion — at the 0.35 preset, at least 35% of the move still to come back.
  if (!(given <= (1 - d.pb_rev_retrace) * ext)) {
    return wait(`fading the ${rally ? 'up' : 'down'} excursion of ${pts(ext)}: ${pts(given)} already given back, past ${(1 - d.pb_rev_retrace).toFixed(2)} x — too little room left to the open`);
  }
  // The counter-trend: a rally is faded on trend-down, a fall on trend-up.
  const want: Regime = rally ? 'trend-down' : 'trend-up';
  if (ctx.regime !== want) return wait(`the regime is ${ctx.regime}, not ${want}`);
  if (ctx.regimeHeldMs < d.pb_confirm_s * 1000) {
    return wait(`${want} held ${secs(ctx.regimeHeldMs)}s of the ${d.pb_confirm_s}s`);
  }
  // The label must still be on the tape (kit `onTape`, spec M11): a dwell-held
  // label after one bad print is not a counter-trend.
  const tape = onTape(ctx);
  if (tape !== want) return wait(`${want} held ${secs(ctx.regimeHeldMs)}s, but the slow window now reads ${tape}: the detector's dwell, not the tape`);

  const side = rally ? 'down' : 'up';
  const type = side === 'up' ? 'CE' : 'PE';
  const spread = debitByBands(ctx, side);
  if (spread === null) return wait(`no ${type} debit spread on the delta bands`);
  return {
    kind: 'open',
    plan: {
      side,
      protective: spread.protective,
      shorts: spread.shorts,
      lots: d.pb_lots,
      reason:
        `fading the morning's ${ext.toFixed(0)}-point ${rally ? 'up' : 'down'}-move from ${pts(extreme)}: ` +
        `${pts(given)} given back (${Math.round((100 * given) / ext)}%), ${want} held ${secs(ctx.regimeHeldMs)}s — a ${type} debit spread`,
      stamps: { entryExtreme: extreme },
    },
  };
}

function exits(ctx: PlaybookCtx): PlaybookStep {
  const d = ctx.dials;
  const pb = ctx.pb;
  // +1 fades a rally (the put spread, wrong ABOVE the extreme); -1 a fall.
  const dir = pb.side === 'down' ? 1 : pb.side === 'up' ? -1 : 0;
  const S = ctx.spot;
  const live = ctx.spotFresh && S !== null && dir !== 0;
  const dday = ctx.dayImplied;

  // Every debounce is read FIRST, so every path below hands back its clocks.
  const limit = dday === null ? Number.NaN : d.pb_rev_stop_k * dday;
  const beyond = live && pb.entryExtreme > 0 && dday !== null ? dir * (S - pb.entryExtreme) : Number.NaN;
  const extreme = held(ctx, beyond >= limit, d.pb_stop_hold_s);
  const debitOn = d.pb_debit_stop_frac > 0 && ctx.cost > 0 && ctx.tradePnl <= -d.pb_debit_stop_frac * ctx.cost;
  const debit = heldRupee(ctx, debitOn);
  const patch = { ...extreme.patch, ...debit.patch };

  if (extreme.fire && S !== null) {
    return {
      exit: {
        reason: `new extreme: the index ${pts(S)} is ${pts(beyond)} beyond the ${pts(pb.entryExtreme)} the trade faded, past ${d.pb_rev_stop_k} x Dday (${pts(limit)}), held ${d.pb_stop_hold_s}s`,
        urgency: 'urgent',
        final: false,
      },
      patch,
    };
  }
  // The excursion's own direction, back: losing, it is the original trend resumed.
  const original: Regime = dir > 0 ? 'trend-up' : 'trend-down';
  if (
    d.pb_flip_confirm_s > 0 && dir !== 0 && ctx.regime === original &&
    ctx.regimeHeldMs >= d.pb_flip_confirm_s * 1000 && ctx.tradePnl <= 0 &&
    // The 90 s flip is shorter than the detector's 120 s dwell: the trend must
    // be on the tape, not a label one bad print left behind (M11).
    onTape(ctx) === original
  ) {
    return {
      exit: {
        reason: `flip back: ${original} held ${secs(ctx.regimeHeldMs)}s (>= ${d.pb_flip_confirm_s}s) with the trade at ${inr(ctx.tradePnl)}`,
        urgency: 'urgent',
        final: false,
      },
      patch,
    };
  }
  if (debit.fire) {
    return {
      exit: {
        reason: `debit stop: trade P&L ${inr(ctx.tradePnl)} at or through ${d.pb_debit_stop_frac} x the ${inr(ctx.cost)} debit (${inr(-d.pb_debit_stop_frac * ctx.cost)}), held ${d.pb_rupee_hold_s}s`,
        urgency: 'urgent',
        final: false,
      },
      patch,
    };
  }
  const O = pb.dayOpen;
  // On the STEADIED index (median of the newest three prints): one bad print
  // through the open must not bank the trade early (Task 11 finding — it cost
  // M7 two thirds of its profit). The exit is passive, so a late one costs
  // nothing but the wait.
  const steady = live ? steadySpot(ctx.inputs.ring) : null;
  if (steady !== null && O > 0 && (dir > 0 ? steady <= O : steady >= O)) {
    return {
      exit: { reason: `back to the open: the index ${pts(steady)} (median of the last three prints) reached the open ${pts(O)}`, urgency: 'passive', final: false },
      patch,
    };
  }
  const stop = dir === 0 || dday === null || !(pb.entryExtreme > 0) ? 'no new-extreme line' : `new extreme at ${pts(pb.entryExtreme + dir * limit)}`;
  return {
    patch,
    note: `holding — trade P&L ${inr(ctx.tradePnl)}; ${stop}, the open at ${pts(O)}, the index ${S === null ? 'unread' : pts(S)}`,
  };
}

export const REVERSAL: Playbook = {
  id: 3,
  name: 'reversal',
  enter,
  exits,
  adds: () => ({}),
};
