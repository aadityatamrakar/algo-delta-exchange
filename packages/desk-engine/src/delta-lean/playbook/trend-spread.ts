/**
 * TREND DRIVE (id 1) and EXPIRY DRIVE (id 4) — six-playbooks spec §5.1, §5.4.
 *
 * ONE STRATEGY, TWO DIAL SETS. Both buy the confirmed opening trend as a debit
 * spread — the desk's best record (spec §1.1: the delta-lean trend opens of the
 * first fifteen minutes after the warm-up, above all on gap-and-go days) — and
 * both are built by `trendSpread(id, name)`. Nothing in this file asks which
 * of the two it is; the dials decide the differences:
 *
 *                       Trend Drive (§5.1)        Expiry Drive (§5.4)
 *   contract            1+ trading days out       today's expiry
 *   strikes             delta bands (mode 0)      straddle units (mode 1)
 *   confirm / flip      120 s / 90 s              90 s / 60 s
 *   debit stop          0.4 x the debit           0.5 x the debit
 *   pyramid             one add                   none
 *   time exit           —                         12:00, final
 *
 * ── ENTER ───────────────────────────────────────────────────────────────────
 * The slow regime is a trend (`trendSide`), held `pb_confirm_s`, and — once
 * the fold has seen the open (`dayComplete`) — on the open's side of it:
 * `sign(S - O)` is the trend's own sign. A trend up below the open is a bounce
 * in a down day, not the drive this book exists for. A fold that never saw the
 * open (a supervisor started late, spec O9) has no `O` to test against, so the
 * test is SKIPPED, and the entry's reason says so. The gap gate (D10) is the
 * frame's; the reason only reports the gap, or that it was unknown and so the
 * gate did not bind (the dial's own contract, `pb_gap_min_pct`).
 *
 * ── EXITS (the frame has run the hard stop) ─────────────────────────────────
 *   debit stop   trade P&L at or through `-pb_debit_stop_frac` x the debit
 *                paid (`ctx.cost`, the adds included), urgent, not final;
 *   flip         the OPPOSITE trend held `pb_flip_confirm_s` AND the trade at
 *                or under zero, urgent, not final. D5: a winning trade is never
 *                flipped out — before 13:00 a winner has no floor at all
 *                (`pb_trail_start` 0), and the flip must not become one.
 * Both are RUPEE conditions — the flip's "losing" is a mark — so both are
 * debounced on the frame's shared rupee clock (`heldRupee`): one wide quote,
 * one mark at zero, is not a loss (spec O19). The flip's regime half needs no
 * clock of its own: `regimeHeldMs` already is one.
 *
 * ── A LABEL IS NOT A TREND UNTIL THE TAPE SAYS SO (spec M11) ────────────────
 * The detector holds a trend LABEL for `dl_regime_dwell_s` (120 s) after it
 * turns, whatever the tape does next — that is its defence against
 * reclassification noise. But ONE bad print, read as the newest sample, turns
 * the label too (a 1% spike is fourteen implied moves in a straight line), and
 * the dwell then holds it for 120 s on a tape that is back where it was. Any
 * hold here shorter than the dwell — Expiry Drive's 90 s confirm, both flips
 * (90 s, 60 s) — is then "confirmed" by the dwell alone: the scenario suite
 * caught Expiry Drive opening 92 s after a single bad print, and Trend Drive
 * flipped out of a losing trade 96 s after one. So every trend this file acts
 * on must ALSO be on the slow window now, at the detector's own hold bar
 * (`classifyWindow` with `wasTrending`: `dl_trend_exit_mult`, `dl_clean_min`).
 * Past the dwell the two readings are the same reading — the label IS that
 * classification — so a hold at least as long as the dwell is unchanged (Trend
 * Drive's 120 s confirm); inside it, a label the tape no longer shows is the
 * dwell talking, and nothing opens, flips or adds on it.
 *
 * ── ADDS (D6: never without a cap) ──────────────────────────────────────────
 * At most `pb_max_adds` (the frame's cap, restated here so a caller that is not
 * the frame cannot pyramid past it): a SINGLE bought option, one lot, on a
 * trade already winning, its own trend still held `pb_confirm_s`, the index
 * `pb_add_ext_k` x `Dday` beyond the entry, measured on a FRESH `S`, steadied
 * (the median of its newest three prints, so one bad print adds nothing). The
 * strike is the entry rule's long — the long band (mode 0) or the ATM strike
 * (mode 1) — never one the book holds short (an opposite-side fill is netted
 * downstream into a close), and `openOf` marks it `add` when the book already
 * holds it long (spec F4).
 *
 * The answers are data: the frame prefixes the name, sizes, stages and routes
 * (`types.ts`). PURE: no clock, no IO.
 */
import { deltaBandStrike } from '../express.ts';
import { inr } from '../decide.ts';
import type { OptType, PlaybookState } from '../../types.ts';
import { atmOf, debitByBands, debitByStraddle, heldOpposite, heldRupee, liquidWing, onTape, openOf, steadySpot, trendHeld, trendSide, type Structure } from './kit.ts';
import type { EntryVerdict, OpenAction, Playbook, PlaybookCtx, PlaybookStep } from './types.ts';

type Dir = 'up' | 'down';

const typeOf = (side: Dir): OptType => (side === 'up' ? 'CE' : 'PE');
const signOf = (side: Dir): 1 | -1 => (side === 'up' ? 1 : -1);
const against = (side: Dir): Dir => (side === 'up' ? 'down' : 'up');
const secs = (ms: number): number => Math.floor(ms / 1000);
/** The trade's direction on record, or null for one with none (`''`, `'none'`). */
const sideOf = (pb: PlaybookState): Dir | null => (pb.side === 'up' || pb.side === 'down' ? pb.side : null);
const pts = (x: number): string => Math.abs(x).toFixed(1);

/** The strike mode by name, or null for a value that is neither: a dial nobody
 * meant trades nothing rather than one of the two by accident. */
function modeOf(ctx: PlaybookCtx): 'bands' | 'straddle' | null {
  const m = ctx.dials.pb_strike_mode;
  return m === 0 ? 'bands' : m === 1 ? 'straddle' : null;
}
const MODE_NAME = { bands: 'by delta bands', straddle: 'in straddle units' } as const;

const wait = (reason: string): EntryVerdict => ({ kind: 'wait', reason });


/** What the entry's reason says about the gap: its size, or that it was not
 * known and the gate therefore did not bind. */
function gapNote(ctx: PlaybookCtx): string {
  const g = ctx.gapPct;
  if (g !== null) return `gap ${g >= 0 ? '+' : '-'}${Math.abs(g).toFixed(2)}%`;
  const min = ctx.dials.pb_gap_min_pct;
  return min > 0 ? `gap unknown (the ${min.toFixed(2)}% gap gate skipped)` : 'gap unknown';
}

function enter(ctx: PlaybookCtx): EntryVerdict {
  const d = ctx.dials;
  const mode = modeOf(ctx);
  if (mode === null) return wait(`pb_strike_mode ${d.pb_strike_mode} is neither 0 (delta bands) nor 1 (straddle units)`);
  const side = trendSide(ctx.regime);
  if (side === null) return wait(`no trend: the slow regime is ${ctx.regime}`);
  if (ctx.regimeHeldMs < d.pb_confirm_s * 1000) {
    return wait(`${ctx.regime} held ${secs(ctx.regimeHeldMs)}s of the ${d.pb_confirm_s}s confirm`);
  }
  const raw = onTape(ctx);
  if (raw !== ctx.regime) {
    return wait(`${ctx.regime} held ${secs(ctx.regimeHeldMs)}s, but the slow window now reads ${raw}: a label the detector's dwell is holding, not a trend on the tape`);
  }

  let open: string;
  if (ctx.dayComplete) {
    if (ctx.spot === null) return wait(`${ctx.regime} confirmed, but no index level to test against the open`);
    const vsOpen = ctx.spot - ctx.pb.dayOpen;
    if (Math.sign(vsOpen) !== signOf(side)) {
      const where = vsOpen > 0 ? `${pts(vsOpen)} above` : vsOpen < 0 ? `${pts(vsOpen)} below` : 'at';
      return wait(`${ctx.regime} against the open: the index ${ctx.spot.toFixed(1)} is ${where} the ${ctx.pb.dayOpen.toFixed(1)} open`);
    }
    open = `the index ${pts(vsOpen)} ${vsOpen > 0 ? 'above' : 'below'} the open`;
  } else {
    open = 'the fold never saw the open: the open-direction test skipped';
  }

  const s: Structure | null = mode === 'bands' ? debitByBands(ctx, side) : debitByStraddle(ctx, side);
  const long = s?.protective[0];
  const short = s?.shorts[0];
  if (s === null || long === undefined || short === undefined) {
    return wait(`${ctx.regime} confirmed, but no ${typeOf(side)} debit spread ${MODE_NAME[mode]} on this board`);
  }
  return {
    kind: 'open',
    plan: {
      side,
      protective: s.protective,
      shorts: s.shorts,
      lots: d.pb_lots,
      reason: `${ctx.regime} held ${secs(ctx.regimeHeldMs)}s, ${open}, ${gapNote(ctx)}: the ${long.strike}/${short.strike} ${long.optType} debit spread ${MODE_NAME[mode]}`,
    },
  };
}

function exits(ctx: PlaybookCtx): PlaybookStep {
  const d = ctx.dials;
  const pnl = ctx.tradePnl;
  const hold = d.pb_rupee_hold_s;

  const line = -d.pb_debit_stop_frac * ctx.cost;
  const debitOn = d.pb_debit_stop_frac > 0 && ctx.cost > 0 && pnl <= line;

  const side = sideOf(ctx.pb);
  const flipWanted =
    d.pb_flip_confirm_s > 0 && side !== null &&
    trendSide(ctx.regime) === against(side) &&
    ctx.regimeHeldMs >= d.pb_flip_confirm_s * 1000 &&
    pnl <= 0;
  const flipOn = flipWanted && onTape(ctx) === ctx.regime;

  // One clock for both: each is "the trade's marks in a stop's zone", and the
  // debit zone lies inside the flip's (a debit loss is a loss).
  const rupee = heldRupee(ctx, debitOn || flipOn);
  const debitWhy = `trade P&L ${inr(pnl)} at or through ${inr(line)}`;
  const flipWhy = `${ctx.regime} held ${secs(ctx.regimeHeldMs)}s against the ${side ?? ''} trade, which is losing (trade P&L ${inr(pnl)})`;
  if (rupee.fire && debitOn) {
    const pct = Math.round(d.pb_debit_stop_frac * 100);
    return {
      exit: { reason: `debit stop: trade P&L ${inr(pnl)} at or through ${pct}% of the ${inr(ctx.cost)} debit (${inr(line)}), held ${hold}s`, urgency: 'urgent', final: false },
      patch: rupee.patch,
    };
  }
  if (rupee.fire && flipOn) {
    return { exit: { reason: `flip: ${flipWhy}, held ${hold}s`, urgency: 'urgent', final: false }, patch: rupee.patch };
  }
  if (!debitOn && !flipOn) {
    // A losing trade under a contrary label held past the flip, that only the
    // dwell is holding: say why it was not flipped.
    return flipWanted
      ? { patch: rupee.patch, note: `flip held off: ${ctx.regime} is a label the detector's dwell is holding — the slow window reads ${onTape(ctx)}` }
      : { patch: rupee.patch };
  }
  const since = typeof rupee.patch.rupeeSinceMs === 'number' ? ctx.nowMs - rupee.patch.rupeeSinceMs : 0;
  const pending = debitOn ? `debit stop pending: ${debitWhy}` : `flip pending: ${flipWhy}`;
  return { patch: rupee.patch, note: `${pending} — held ${secs(since)}s of ${hold}s` };
}

/** The pyramid's strike: the entry rule's long, never one held short. */
function addStrike(ctx: PlaybookCtx, side: Dir, mode: 'bands' | 'straddle'): { readonly strike: number } | { readonly why: string } {
  const { chain, dateIst, minuteOfDay, legs } = ctx.inputs;
  const d = ctx.dials;
  const t = typeOf(side);
  if (mode === 'bands') {
    const k = deltaBandStrike(
      chain, t, d.dl_long_delta_lo, d.dl_long_delta_hi, dateIst, minuteOfDay, d,
      (strike) => !heldOpposite(legs, strike, t, 'Buy') && liquidWing(chain, strike, t, d, true),
    );
    return k === null
      ? { why: `no tradable ${t} strike in the ${d.dl_long_delta_lo}-${d.dl_long_delta_hi} long band that the book does not hold short` }
      : { strike: k };
  }
  const atm = atmOf(chain);
  if (atm === null || heldOpposite(legs, atm, t, 'Buy') || !liquidWing(chain, atm, t, d, false)) {
    return { why: `the ATM ${t} strike${atm === null ? '' : ` ${atm}`} is held short or not tradable` };
  }
  return { strike: atm };
}

function adds(ctx: PlaybookCtx): PlaybookStep {
  const d = ctx.dials;
  const pb = ctx.pb;
  if (pb.adds >= d.pb_max_adds) return {};
  const side = sideOf(pb);
  const mode = modeOf(ctx);
  if (side === null || mode === null) return {};
  if (!(ctx.tradePnl > 0)) return {};
  if (!trendHeld(ctx, side, d.pb_confirm_s)) return {};
  if (ctx.dayImplied === null || !ctx.spotFresh || ctx.spot === null) return {};
  // The STEADIED index (kit `steadySpot`), never the newest print: one bad
  // print in the trend's direction is no extension, and an add bought on it
  // is a real lot on a move that never happened (M11, engine review finding 5).
  const S = steadySpot(ctx.inputs.ring);
  if (S === null) return {};
  const ext = signOf(side) * (S - pb.entrySpot);
  const need = d.pb_add_ext_k * ctx.dayImplied;
  if (ext < need) return {};

  const pick = addStrike(ctx, side, mode);
  if (!('strike' in pick)) return { note: `pyramid wanted, but ${pick.why}` };
  const t = typeOf(side);
  const buy: OpenAction = openOf(pick.strike, t, 'Buy', ctx.inputs.legs);
  return {
    add: {
      side,
      protective: [buy],
      shorts: [],
      lots: 1,
      reason: `pyramid: trade P&L ${inr(ctx.tradePnl)} and ${ctx.regime} held ${secs(ctx.regimeHeldMs)}s, the index ${ext.toFixed(1)} beyond the ${pb.entrySpot.toFixed(1)} entry (${d.pb_add_ext_k} x Dday = ${need.toFixed(1)}): one ${pick.strike}${t}`,
    },
  };
}

/** The one factory: a Trend-Drive-shaped playbook under `id` and `name`. */
export function trendSpread(id: number, name: string): Playbook {
  return { id, name, enter, exits, adds };
}

export const TREND_DRIVE: Playbook = trendSpread(1, 'trend-drive');
export const EXPIRY_DRIVE: Playbook = trendSpread(4, 'expiry-drive');
