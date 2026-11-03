/**
 * EXPIRY GAMMA BREAKOUT (id 6) — six-playbooks spec v2 §5.6.
 *
 * THE LONG-GAMMA HEDGE OF THE THETA AFTERNOON. Expiry Theta Fly (§5.5) sells
 * the calm 0-DTE afternoon; this book buys its one failure — the late break —
 * with ONE out-of-the-money option whose premium is the whole risk. There is
 * no direct evidence for it in the record (spec §1.5), which is why its loss
 * is a BUDGET: the premium stop takes half of what was paid, and the hard
 * stop, the day backstop and the clock sit above that.
 *
 * ── THE BOX ─────────────────────────────────────────────────────────────────
 * The index's FILTERED range over `[now - pb_box_min, now - 5 min]`, covered
 * to 90% by the tape (`windowRange`), and no wider than `pb_box_max_k` x the
 * move the board charges for `pb_box_min` minutes. The last five minutes are
 * left out on purpose: they are where the break is happening, and a box that
 * included them would move with the very move it is meant to measure. A ring
 * that does not cover the window — the supervisor restarted inside the hour —
 * is no box, and no trade (spec O8): a missed hour is not a calm one.
 *
 * ── THE BREAK ───────────────────────────────────────────────────────────────
 * `S` beyond the box by `pb_brk_buf_k` x the 5-minute implied move, AT or
 * beyond the day's own filtered extreme (less the same buffer) on a day the
 * fold can vouch for (`dayRobust`), with the slow regime trending that way for
 * `pb_confirm_s`. The extreme test is what separates a breakout from a bounce
 * inside a wider morning range.
 *
 * ── THE OPTION AND ITS SIZE ─────────────────────────────────────────────────
 * The first listed strike STRICTLY beyond the forward `F` (a strike at the
 * forward is the money, not beyond it), then `pb_otm_steps - 1` more steps —
 * a call on an up-break, a put on a down one. Strikes are priced off `F`,
 * never `S` (spec §4.2). It must pass the protective-leg liquidity bar: it is
 * a buy, and a buy cannot leave the book naked. Lots =
 * `min(pb_gamma_max_lots, floor(pb_premium_budget / (ask x lot)))`; a budget
 * that buys no lot is no trade. One stage: there is nothing to sell.
 *
 * ── THE EXITS ───────────────────────────────────────────────────────────────
 *   premium stop  `pb_prem_stop_frac` of the premium lost, on the shared
 *                 rupee clock — urgent;
 *   back in box   `S` back inside the box by the CURRENT buffer, held
 *                 `pb_stop_hold_s` — the break failed — urgent; skipped while
 *                 `S` is stale;
 *   premium trail ARMED here once the trade is up `pb_prem_trail_arm` x the
 *                 premium: this book only sets `trailArmed`, and the frame's
 *                 common floor (`pb_trail_keep` x the peak, held) does the
 *                 firing. The preset turns the common rupee arming off (both
 *                 trail starts 0), so this is the only way the floor arms.
 *
 * No pyramid. PURE, like the rest of the engine; reasons are bare — the frame
 * prefixes the playbook's name.
 */
import { clock, inr } from '../decide.ts';
import type { Regime } from '../regime.ts';
import { held, heldRupee, liquidWing, listedBeyond, onTape, openOf, stepsFrom, windowRange } from './kit.ts';
import type { EntryVerdict, Playbook, PlaybookCtx, PlaybookStep } from './types.ts';

const MINUTE_MS = 60_000;
/** The box ends this long before now: the break's own minutes are not the box. */
const BOX_LAG_MIN = 5;
/** The tape must cover the box to this share (`windowRange`'s default). */
const BOX_COVERAGE = 0.9;
/** "Strictly beyond the forward": a strike within this of `F` is AT it. */
const AT_FORWARD = 1e-3;

const wait = (reason: string): EntryVerdict => ({ kind: 'wait', reason });
const secs = (ms: number): number => Math.floor(ms / 1000);
const pts = (x: number): string => x.toFixed(1);
const minuteOf = (ctx: PlaybookCtx, ms: number): number => ctx.minuteOfDay - Math.round((ctx.nowMs - ms) / MINUTE_MS);

function enter(ctx: PlaybookCtx): EntryVerdict {
  const d = ctx.dials;
  const S = ctx.spot;
  if (S === null || !ctx.spotFresh) return wait('the index is stale');
  if (!(d.pb_box_min > BOX_LAG_MIN)) return wait(`a ${d.pb_box_min}-minute box ends before it starts: it closes ${BOX_LAG_MIN} minutes back`);

  const fromMs = ctx.nowMs - d.pb_box_min * MINUTE_MS;
  const toMs = ctx.nowMs - BOX_LAG_MIN * MINUTE_MS;
  const box = windowRange(ctx, fromMs, toMs, BOX_COVERAGE);
  if (box === null) {
    return wait(`the tape does not cover the box ${clock(minuteOf(ctx, fromMs))}-${clock(minuteOf(ctx, toMs))} (${Math.round(BOX_COVERAGE * 100)}% of it, no long hole)`);
  }
  const impBox = ctx.imp(d.pb_box_min);
  const imp5 = ctx.imp(5);
  if (impBox === null || imp5 === null) return wait('no implied move to size the box and the buffer in');
  const width = box.hi - box.lo;
  const widest = d.pb_box_max_k * impBox;
  if (width > widest) {
    return wait(`the box ${pts(box.lo)}-${pts(box.hi)} is ${pts(width)} wide, past ${d.pb_box_max_k} x the ${d.pb_box_min}-minute implied move (${pts(widest)}): no consolidation`);
  }
  const buf = d.pb_brk_buf_k * imp5;
  const side = S >= box.hi + buf ? 'up' : S <= box.lo - buf ? 'down' : null;
  if (side === null) {
    return wait(`inside the box: the index ${pts(S)} is within ${pts(box.lo - buf)}-${pts(box.hi + buf)} (the box ${pts(box.lo)}-${pts(box.hi)} and a ${pts(buf)} buffer)`);
  }

  if (!ctx.dayRobust) {
    return wait(ctx.dayComplete
      ? `the day is not robust: a ${Math.ceil(ctx.pb.maxGapMs / MINUTE_MS)}-minute hole in the tape, past ${d.pb_max_gap_min} min — its extremes may have missed a move`
      : 'the day is not robust: the fold never saw the open, so the day\'s extremes are unknown');
  }
  const up = side === 'up';
  const extreme = up ? ctx.pb.dayHigh : ctx.pb.dayLow;
  const short = up ? extreme - buf - S : S - (extreme + buf);
  if (!(extreme > 0) || short > 0) {
    return wait(`broke the box ${side}, but the index ${pts(S)} is ${pts(Math.max(0, short))} short of the day's ${up ? 'high' : 'low'} ${pts(extreme)} (the buffer is ${pts(buf)})`);
  }
  const want: Regime = up ? 'trend-up' : 'trend-down';
  if (ctx.regime !== want) return wait(`the regime is ${ctx.regime}, not ${want}`);
  if (ctx.regimeHeldMs < d.pb_confirm_s * 1000) return wait(`${want} held ${secs(ctx.regimeHeldMs)}s of the ${d.pb_confirm_s}s`);
  // A 30 s confirm is far inside the detector's 120 s dwell: the breakout must
  // be on the slow window itself, not a label one bad print left (M11).
  const tape = onTape(ctx);
  if (tape !== want) return wait(`${want} held ${secs(ctx.regimeHeldMs)}s, but the slow window now reads ${tape}: the detector's dwell, not the tape`);

  // The option: strictly beyond the forward, then further out by the dial.
  const { chain, legs } = ctx.inputs;
  const t = up ? 'CE' : 'PE';
  const dir = up ? 1 : -1;
  const steps = Math.trunc(d.pb_otm_steps);
  if (!(steps >= 1)) return wait(`pb_otm_steps ${d.pb_otm_steps} is not a strike count`);
  const first = listedBeyond(chain, ctx.fwd, dir, AT_FORWARD);
  const strike = first === null ? null : stepsFrom(chain, first, dir * (steps - 1));
  if (strike === null) return wait(`no listed strike ${steps} step(s) beyond the forward ${pts(ctx.fwd)}`);
  if (!liquidWing(chain, strike, t, d, true)) {
    return wait(`${strike}${t} is not tradable (a fresh two-sided quote inside the spread bar)`);
  }
  const row = chain.strikes.find((r) => r.strike === strike);
  const ask = (t === 'CE' ? row?.ce : row?.pe)?.ask ?? null;
  if (ask === null || !(ask > 0)) return wait(`${strike}${t} has no ask to size the budget against`);
  const perLot = ask * chain.lotSize;
  const lots = Math.floor(Math.min(d.pb_gamma_max_lots, d.pb_premium_budget / perLot));
  if (!(lots >= 1)) {
    return wait(`the ${inr(d.pb_premium_budget)} budget buys no lot of ${strike}${t} at ${ask.toFixed(2)} x ${chain.lotSize} (${inr(perLot)} a lot)`);
  }
  const beyond = up ? S - box.hi : box.lo - S;
  return {
    kind: 'open',
    plan: {
      side,
      protective: [openOf(strike, t, 'Buy', legs)],
      shorts: [],
      lots,
      reason:
        `the index ${pts(S)} broke the ${pts(box.lo)}-${pts(box.hi)} box ${side} by ${pts(beyond)} (buffer ${pts(buf)}), ` +
        `at the day's ${up ? 'high' : 'low'}, ${want} held ${secs(ctx.regimeHeldMs)}s — ` +
        `buying the ${strike}${t} at ${ask.toFixed(2)}, ${lots} lot(s) inside the ${inr(d.pb_premium_budget)} budget`,
      stamps: { boxHi: box.hi, boxLo: box.lo },
    },
  };
}

function exits(ctx: PlaybookCtx): PlaybookStep {
  const d = ctx.dials;
  const pb = ctx.pb;
  const S = ctx.spot;
  const up = pb.side === 'up';
  const imp5 = ctx.imp(5);
  // TODAY's buffer: the 5-minute implied move is re-read every pass.
  const buf = imp5 === null ? null : d.pb_brk_buf_k * imp5;
  const boxed = pb.boxHi > 0 && pb.boxLo > 0 && (pb.side === 'up' || pb.side === 'down');
  const line = buf === null || !boxed ? Number.NaN : up ? pb.boxHi - buf : pb.boxLo + buf;
  const inside = ctx.spotFresh && S !== null && (up ? S <= line : S >= line);

  // Every debounce is read FIRST, so every path below hands back its clocks.
  const box = held(ctx, inside, d.pb_stop_hold_s);
  const stopOn = d.pb_prem_stop_frac > 0 && ctx.cost > 0 && ctx.tradePnl <= -d.pb_prem_stop_frac * ctx.cost;
  const stop = heldRupee(ctx, stopOn);
  const arm = !pb.trailArmed && d.pb_prem_trail_arm > 0 && ctx.cost > 0 && ctx.tradePnl >= d.pb_prem_trail_arm * ctx.cost;
  const patch = { ...box.patch, ...stop.patch, ...(arm ? { trailArmed: true } : {}) };

  if (stop.fire) {
    return {
      exit: {
        reason: `premium stop: trade P&L ${inr(ctx.tradePnl)} at or through ${d.pb_prem_stop_frac} x the ${inr(ctx.cost)} paid (${inr(-d.pb_prem_stop_frac * ctx.cost)}), held ${d.pb_rupee_hold_s}s`,
        urgency: 'urgent',
        final: false,
      },
      patch,
    };
  }
  if (box.fire && S !== null && buf !== null) {
    const depth = up ? pb.boxHi - S : S - pb.boxLo;
    return {
      exit: {
        reason: `back in the box: the index ${pts(S)} is back inside the ${pts(pb.boxLo)}-${pts(pb.boxHi)} box by ${pts(depth)} (the buffer ${pts(buf)}), held ${d.pb_stop_hold_s}s`,
        urgency: 'urgent',
        final: false,
      },
      patch,
    };
  }
  const trail = arm
    ? `premium trail armed at ${inr(ctx.tradePnl)} (${d.pb_prem_trail_arm} x the ${inr(ctx.cost)} paid); the floor keeps ${d.pb_trail_keep} x the peak`
    : pb.trailArmed
      ? `premium trail armed, floor ${inr(d.pb_trail_keep * pb.peakPnl)}`
      : `the premium trail arms at ${inr(d.pb_prem_trail_arm * ctx.cost)}`;
  return {
    patch,
    note: `holding — trade P&L ${inr(ctx.tradePnl)} on ${inr(ctx.cost)} paid; back in the box at ${Number.isNaN(line) ? 'no line' : pts(line)}; ${trail}`,
  };
}

export const EXPIRY_GAMMA: Playbook = {
  id: 6,
  name: 'expiry-gamma',
  enter,
  exits,
  adds: () => ({}),
};
