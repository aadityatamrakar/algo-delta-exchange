/**
 * THE PLAYBOOK KIT — the strikes, structures and debounces a strategy builds
 * its answers from (six-playbooks spec §4.6, §4.7).
 *
 * A strategy proposes; the frame (`decide.ts` beside this file) disposes. But
 * a proposal is only as good as the strikes in it, and six strategies picking
 * strikes six ways is six places for a naked short to be born. So the ways a
 * package may be FORMED live here, once:
 *
 *   `debitByBands`     delta-lean's bands — buy 0.55-0.65, sell 0.20-0.30
 *                      strictly further out (Trend Drive, Reversal Spread);
 *   `debitByStraddle`  straddle units — buy ATM, sell the first strike at least
 *                      max(1 step, `pb_short_str_k` x STR) beyond (Expiry Drive);
 *   `flyPlan`          an iron fly — sell the ATM straddle, buy a wing each side
 *                      max(`pb_wing_min_steps`, round(`pb_wing_str_k` x STR /
 *                      step)) steps out (Wing Straddle, Expiry Theta Fly).
 *
 * EVERY SHORT NAMES ITS COVER — the strike of the same-type protective long
 * that bounds its loss (`PlannedShort.cover`): a debit spread's long, a fly's
 * own-type wing. The frame sells a short only once THAT leg is held, and only
 * as many lots as it holds (D1), so a plan is never "some longs and some
 * shorts" — it is a list of pairs.
 *
 * STRIKES THE BOOK HOLDS ON THE OTHER SIDE ARE NEVER CHOSEN (§4.6). An
 * opposite-side fill on a held instrument is netted downstream into a partial
 * CLOSE of that leg — nobody decided it, and the ledger would say "opened".
 * Same-side is an ADD, and `openOf` marks it so (`add: true`, spec F4) — the
 * desk refuses an unmarked open onto a held tag as "already open".
 *
 * LIQUIDITY IS TESTED PER WING, here and only here (`liquidWing`; delta-lean's
 * row-wise `tradableStrikes` is untouched): a short must be quoted as fresh as
 * delta-lean demands, a protective wing may be older, because a far wing
 * prints rarely and a BUY cannot leave the book naked.
 *
 * THE DEBOUNCES (`held`, `heldRupee`) are how a strategy's stop survives one
 * bad print: a condition must hold continuously for its window. The index
 * stop's clock is `pb.condSinceMs`; the rupee clock, `pb.rupeeSinceMs`, is
 * SHARED with the frame's own rupee rules (see `heldRupee`).
 *
 * PURE, like the rest of the engine: no clock, no IO. Every reading is a
 * field of the `PlaybookCtx` the frame computed once for the pass.
 */
import type { Dials } from '../../dials.ts';
import { deltaBandStrike } from '../express.ts';
import { classifyWindow, MIN_SAMPLES, type Regime } from '../regime.ts';
import type { ChainSnap, EngineAction, LegView, OptType, PlaybookState, Side } from '../../types.ts';
import type { DeltaLeanInputs } from '../decide.ts';
import { median3 } from './session.ts';
import type { OpenAction, PlannedShort, PlaybookCtx } from './types.ts';

/** Strike equality, the tolerance `marking.ts` matches a chain row on. */
const EPS = 1e-6;

/** A plan's two halves, sent apart: the buys now, the shorts once covered. */
export interface Structure {
  readonly protective: OpenAction[];
  readonly shorts: PlannedShort[];
}

// ── strikes ─────────────────────────────────────────────────────────────────

/**
 * The listed strike nearest the forward (`chain.spot`), a tie to the LOWER
 * strike whatever order the ladder is in. `null` on an empty chain.
 *
 * The forward and never the index: strikes and greeks are priced off `F`
 * (spec §4.2). Index RULES read `S`; this is not a rule, it is a strike.
 */
export function atmOf(chain: ChainSnap): number | null {
  let best: number | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const row of chain.strikes) {
    const d = Math.abs(row.strike - chain.spot);
    if (d < gap - EPS || (Math.abs(d - gap) <= EPS && best !== null && row.strike < best)) {
      best = row.strike;
      gap = d;
    }
  }
  return best;
}

/** The NEAREST listed strike at least `minDistance` beyond `from` in `dir`
 * (+1 up the ladder, -1 down), or `null` at the edge of the chain. */
export function listedBeyond(chain: ChainSnap, from: number, dir: 1 | -1, minDistance: number): number | null {
  let best: number | null = null;
  for (const row of chain.strikes) {
    if (dir * (row.strike - from) + EPS < minDistance) continue;
    if (best === null || dir * (row.strike - best) < 0) best = row.strike;
  }
  return best;
}

/** `from + steps x chain.step` if that strike is listed, else `null` — a
 * ladder walked off the board is no strike, never the nearest one. */
export function stepsFrom(chain: ChainSnap, from: number, steps: number): number | null {
  const want = from + steps * chain.step;
  return chain.strikes.find((r) => Math.abs(r.strike - want) <= EPS)?.strike ?? null;
}

/**
 * IS THIS WING WORTH TRADING? — spec §4.7, per wing:
 *
 *   - a two-sided quote: a real bid AND a real ask (a 0 bid is a quote for
 *     nothing, and a sale into it would collect nothing), not crossed;
 *   - a spread no wider than max(`dl_max_spread_pct` x mid,
 *     `dl_max_spread_abs`) — the rupee floor because 2% of a ₹1 wing is two
 *     paise, and a percentage bar alone would delete every far wing, which is
 *     where a fly's protection lives. A PROTECTIVE leg's floor is the larger
 *     of that and `pb_wing_spread_abs`: a SENSEX wing at ₹20-40 is often
 *     ₹1-2 wide, and a ₹1 bar would leave the fly with no wing to buy, so
 *     the book would never trade (a buy at the ask costs half the spread);
 *   - an age no older than `pb_wing_fresh_s` for a PROTECTIVE leg and
 *     `dl_quote_fresh_s` for a short or an ATM leg, measured against
 *     `chain.asOf`: this catches a row lagging the rest of the board. Whether
 *     the whole board is too old is the frame's gate, one level up.
 */
export function liquidWing(chain: ChainSnap, strike: number, optType: OptType, dials: Dials, protective: boolean): boolean {
  const row = chain.strikes.find((r) => Math.abs(r.strike - strike) <= EPS);
  const q = optType === 'CE' ? row?.ce : row?.pe;
  if (q === null || q === undefined) return false;
  const { bid, ask } = q;
  if (bid === null || ask === null || !(bid > 0) || !(ask >= bid)) return false;
  const freshS = protective ? dials.pb_wing_fresh_s : dials.dl_quote_fresh_s;
  if (chain.asOf - q.asOf > freshS * 1000) return false;
  const floor = protective ? Math.max(dials.dl_max_spread_abs, dials.pb_wing_spread_abs) : dials.dl_max_spread_abs;
  const limit = Math.max(dials.dl_max_spread_pct * ((bid + ask) / 2), floor);
  return limit > 0 && ask - bid <= limit;
}

// ── what the book holds ─────────────────────────────────────────────────────

const sameContract = (l: LegView, strike: number, optType: OptType): boolean =>
  l.optType === optType && Math.abs(l.strike - strike) <= EPS;

/** Lots the book holds at this strike, type and side (0 when none). */
export function lotsHeld(legs: readonly LegView[], strike: number, optType: OptType, side: Side): number {
  let lots = 0;
  for (const l of legs) if (sameContract(l, strike, optType) && l.side === side) lots += l.lots;
  return lots;
}

/** The book holds this contract on the OTHER side from `side`. */
export function heldOpposite(legs: readonly LegView[], strike: number, optType: OptType, side: Side): boolean {
  return legs.some((l) => sameContract(l, strike, optType) && l.side !== side);
}

/** The book already holds this contract on `side`. */
export function heldSame(legs: readonly LegView[], strike: number, optType: OptType, side: Side): boolean {
  return legs.some((l) => sameContract(l, strike, optType) && l.side === side);
}

/**
 * One open at ONE lot (the frame scales it), marked `add: true` when the book
 * already holds the same contract on the same side — a stage-2 re-send that
 * tops a short up, a pyramid onto a held strike. Unmarked, the desk would
 * refuse it as "already open" (spec F4). An opposite-side contract is never
 * marked: it is not an add, and no structure here chooses one.
 */
export function openOf(strike: number, optType: OptType, side: Side, legs: readonly LegView[]): OpenAction {
  return heldSame(legs, strike, optType, side)
    ? { op: 'open', strike, optType, side, lots: 1, add: true }
    : { op: 'open', strike, optType, side, lots: 1 };
}

// ── structures ──────────────────────────────────────────────────────────────

const typeOf = (side: 'up' | 'down'): OptType => (side === 'up' ? 'CE' : 'PE');
const dirOf = (side: 'up' | 'down'): 1 | -1 => (side === 'up' ? 1 : -1);

/** A debit spread as a plan: the long now, the short once the long is held. */
function spread(long: number, short: number, optType: OptType, legs: readonly LegView[]): Structure {
  return {
    protective: [openOf(long, optType, 'Buy', legs)],
    shorts: [{ strike: short, optType, cover: long }],
  };
}

/**
 * A debit spread by DELTA BANDS (§4.7): buy in `dl_long_delta`, sell in
 * `dl_short_delta` STRICTLY further out of the money, so the pair can never
 * come back inverted. `side` is the delta expressed: `up` the call spread,
 * `down` the put one.
 *
 * The band walk is delta-lean's own (`deltaBandStrike`), which already demands
 * a fresh two-sided ROW; each wing is then held to its own §4.7 test. `null` —
 * never half a spread — when either leg cannot be found.
 */
export function debitByBands(ctx: PlaybookCtx, side: 'up' | 'down'): Structure | null {
  const { chain, dateIst, minuteOfDay, legs } = ctx.inputs;
  const d = ctx.dials;
  const t = typeOf(side);
  const long = deltaBandStrike(
    chain, t, d.dl_long_delta_lo, d.dl_long_delta_hi, dateIst, minuteOfDay, d,
    (k) => !heldOpposite(legs, k, t, 'Buy'),
  );
  if (long === null) return null;
  const short = deltaBandStrike(
    chain, t, d.dl_short_delta_lo, d.dl_short_delta_hi, dateIst, minuteOfDay, d,
    (k) => dirOf(side) * (k - long) > EPS && !heldOpposite(legs, k, t, 'Sell'),
  );
  if (short === null) return null;
  if (!liquidWing(chain, long, t, d, true) || !liquidWing(chain, short, t, d, false)) return null;
  return spread(long, short, t, legs);
}

/**
 * A debit spread in STRADDLE UNITS (§4.7, Expiry Drive): buy the ATM strike,
 * sell the first listed strike at least max(1 step, `pb_short_str_k` x STR)
 * beyond it — measured in the market's own unit (D7), because on 0-DTE a
 * delta band is a different strike every hour. The ATM long is held to the
 * SHORT freshness bar: it is the most liquid strike on the board, and a quote
 * that old there is a board problem, not a quiet wing.
 */
export function debitByStraddle(ctx: PlaybookCtx, side: 'up' | 'down'): Structure | null {
  const { chain, legs } = ctx.inputs;
  const d = ctx.dials;
  const t = typeOf(side);
  const dir = dirOf(side);
  const long = atmOf(chain);
  if (long === null || ctx.str === null || heldOpposite(legs, long, t, 'Buy')) return null;
  const dist = Math.max(chain.step, d.pb_short_str_k * ctx.str);
  // The first strike that far out the book does not hold long; a held long
  // there would be sold away by the "short".
  let short = listedBeyond(chain, long, dir, dist);
  while (short !== null && heldOpposite(legs, short, t, 'Sell')) {
    short = listedBeyond(chain, short, dir, chain.step);
  }
  if (short === null) return null;
  if (!liquidWing(chain, long, t, d, false) || !liquidWing(chain, short, t, d, false)) return null;
  return spread(long, short, t, legs);
}

/**
 * AN IRON FLY at the ATM strike (§4.7): the two shorts are the straddle, the
 * wings sit `w` steps either side, `w = max(pb_wing_min_steps, round(
 * pb_wing_str_k x STR / step))` — straddle units with a floor in steps, so a
 * cheap straddle cannot collapse the wings onto the centre. The CE short is
 * covered by the CE wing and the PE short by the PE wing: a fly that filled
 * one wing sells only the short that wing covers.
 */
export function flyPlan(ctx: PlaybookCtx): (Structure & { readonly centre: number }) | null {
  const { chain, legs } = ctx.inputs;
  const d = ctx.dials;
  const centre = atmOf(chain);
  if (centre === null || ctx.str === null || !(chain.step > 0)) return null;
  const w = Math.max(d.pb_wing_min_steps, Math.round((d.pb_wing_str_k * ctx.str) / chain.step));
  const ce = stepsFrom(chain, centre, w);
  const pe = stepsFrom(chain, centre, -w);
  if (ce === null || pe === null || w < 1) return null;
  const free =
    !heldOpposite(legs, ce, 'CE', 'Buy') && !heldOpposite(legs, pe, 'PE', 'Buy') &&
    !heldOpposite(legs, centre, 'CE', 'Sell') && !heldOpposite(legs, centre, 'PE', 'Sell');
  const liquid =
    liquidWing(chain, ce, 'CE', d, true) && liquidWing(chain, pe, 'PE', d, true) &&
    liquidWing(chain, centre, 'CE', d, false) && liquidWing(chain, centre, 'PE', d, false);
  if (!free || !liquid) return null;
  return {
    centre,
    protective: [openOf(ce, 'CE', 'Buy', legs), openOf(pe, 'PE', 'Buy', legs)],
    shorts: [
      { strike: centre, optType: 'CE', cover: ce },
      { strike: centre, optType: 'PE', cover: pe },
    ],
  };
}

// ── debounces ───────────────────────────────────────────────────────────────

/** A debounced condition: whether it fires, and the clock to persist. */
export interface Debounce {
  readonly fire: boolean;
  readonly patch: Partial<PlaybookState>;
}

/**
 * THE INDEX-STOP DEBOUNCE, on `pb.condSinceMs`: a stop on one print is a stop
 * on a feed error (spec M11). Off → reset to 0. The first pass on → stamp now
 * and do not fire. Fires once it has held `holdS` seconds — inclusive, so a
 * hold of 0 fires at once. Return `patch` on EVERY path: a clock the frame
 * never sees reset is a stop that fires on two moments that never met.
 *
 * Reading `S` while it is stale is the caller's to refuse (`ctx.spotFresh`):
 * an index rule is skipped then, which is `active: false` here.
 */
export function held(ctx: PlaybookCtx, active: boolean, holdS: number): Debounce {
  if (!active) return { fire: false, patch: { condSinceMs: 0 } };
  const since = ctx.pb.condSinceMs > 0 ? ctx.pb.condSinceMs : ctx.nowMs;
  return { fire: ctx.nowMs - since >= holdS * 1000, patch: { condSinceMs: since } };
}

/**
 * THE RUPEE DEBOUNCE, on `pb.rupeeSinceMs` (`pb_rupee_hold_s`): one mark off
 * a briefly wide quote is not a loss (spec O19), nor a profit.
 *
 * The clock is SHARED with the frame's own rupee rules (the hard stop, the
 * trailing floor and the take profit): it measures one continuous stretch in
 * which SOME rupee rule is in its zone, so a strategy's debit stop and the
 * frame's hard stop cannot each reset the other. Hence the asymmetry with
 * `held`: on, it stamps (or keeps) the clock; OFF, it says nothing
 * (`patch: {}`), and the frame resets the clock itself when no rupee condition
 * anywhere holds.
 */
export function heldRupee(ctx: PlaybookCtx, active: boolean, holdS: number = ctx.dials.pb_rupee_hold_s): Debounce {
  if (!active) return { fire: false, patch: {} };
  const since = ctx.pb.rupeeSinceMs > 0 ? ctx.pb.rupeeSinceMs : ctx.nowMs;
  return { fire: ctx.nowMs - since >= holdS * 1000, patch: { rupeeSinceMs: since } };
}

// ── the tape over a window ──────────────────────────────────────────────────

/**
 * The index's FILTERED high and low over `[fromMs, toMs]` (median-of-3, so one
 * bad print is never an extreme), or `null` when the ring does not cover the
 * window: fewer than `MIN_SAMPLES` prints, samples spanning less than
 * `minCoverage` of it, or a single hole longer than the rest
 * (`1 - minCoverage`). A calm filter or a breakout box read off a tape that
 * missed part of its window would call a missed move "calm".
 */
export function windowRange(
  ctx: PlaybookCtx,
  fromMs: number,
  toMs: number,
  minCoverage = 0.9,
): { readonly hi: number; readonly lo: number } | null {
  const span = toMs - fromMs;
  if (!(span > 0)) return null;
  const r = ctx.inputs.ring.filteredRange(fromMs, toMs);
  if (r === null || r.samples < MIN_SAMPLES) return null;
  if (r.spanMs < minCoverage * span || r.maxGapMs > (1 - minCoverage) * span) return null;
  return { hi: r.hi, lo: r.lo };
}

// ── values and sides ────────────────────────────────────────────────────────

/**
 * The shorts as they stand: Σ ask x qty (what buying them back costs now)
 * against Σ entry x qty (what they were sold for). `null` when any short has
 * no ask — a combined stop priced without one leg would read the straddle as
 * half its price — and when there are no shorts at all: a 0 against a 0 is no
 * reading, and `now >= k x entry` would fire on it.
 */
export function shortsValue(legs: readonly LegView[]): { readonly now: number; readonly entry: number } | null {
  let now = 0;
  let entry = 0;
  let shorts = 0;
  for (const l of legs) {
    if (l.side !== 'Sell') continue;
    const ask = l.exit.ask;
    if (ask === null || !Number.isFinite(ask)) return null;
    const qty = l.lots * l.lotSize;
    now += ask * qty;
    entry += l.entry * qty;
    shorts += 1;
  }
  return shorts === 0 ? null : { now, entry };
}

/**
 * THE MOST A HELD DEBIT SPREAD CAN MAKE — width x lots x lot size, less the
 * debit paid — or `null` when the book is not exactly one: one long and one
 * short of the same type, the same lots, the long nearer the money.
 *
 * `null` is the answer for every other shape ON PURPOSE: a short not yet held
 * leaves a long option, a pyramid add leaves a naked long beside the pair, and
 * neither has a ceiling to name — while a fly's or a credit pair's ceiling is
 * a different sum this does not attempt. The caller then keeps its plain
 * rupee target (`pb_target_max_frac`, decide.ts).
 */
export function debitSpreadMax(legs: readonly LegView[]): number | null {
  if (legs.length !== 2) return null;
  const long = legs.find((l) => l.side === 'Buy');
  const short = legs.find((l) => l.side === 'Sell');
  if (long === undefined || short === undefined || long.optType !== short.optType) return null;
  if (Math.abs(long.lots - short.lots) > EPS || long.lotSize !== short.lotSize) return null;
  const width = long.optType === 'CE' ? short.strike - long.strike : long.strike - short.strike;
  if (!(width > 0)) return null;
  const qty = long.lots * long.lotSize;
  const max = (width - (long.entry - short.entry)) * qty;
  return Number.isFinite(max) ? max : null;
}

/** The side a trend regime points, or `null` for anything that is not one. */
export function trendSide(regime: Regime): 'up' | 'down' | null {
  return regime === 'trend-up' ? 'up' : regime === 'trend-down' ? 'down' : null;
}

/**
 * THE SLOW WINDOW'S OWN READING, NOW, at the detector's hold bar — the label
 * as it would read without the dwell (spec M11; Task 9 and 11 findings).
 *
 * The detector holds a trend LABEL for `dl_regime_dwell_s` (120 s) after it
 * turns, whatever the tape does next. One bad print, read as the newest
 * sample, turns the label too, and the dwell then holds it on a tape that is
 * back where it was. Any rule that acts on a trend held for LESS than the
 * dwell — an entry confirm, a flip, a trend exit — must therefore also see the
 * trend on the slow window itself (`classifyWindow` with `wasTrending`: the
 * hold bar `dl_trend_exit_mult`, cleanliness `dl_clean_min`). Past the dwell
 * the two readings are the same reading.
 */
export const onTape = (ctx: PlaybookCtx): Regime =>
  classifyWindow(ctx.read.slowStat, ctx.read.impliedSlow, ctx.dials, true);

/** The label is `side`'s trend, held at least `holdS`, AND still on the tape. */
export const trendHeld = (ctx: PlaybookCtx, side: 'up' | 'down', holdS: number): boolean =>
  trendSide(ctx.regime) === side && ctx.regimeHeldMs >= holdS * 1000 && onTape(ctx) === ctx.regime;

/**
 * `S` STEADIED: the median of the newest three prints (within 30 s). For the
 * index rules a single bad print must not move — the stage-2 abort, a trade's
 * anchors, a profit exit at a level — so one bad print can neither abort a
 * stage, anchor a trade, nor bank a trade early (M11). Raw `ctx.spot` stays
 * the newest print for everything else.
 */
export function steadySpot(ring: DeltaLeanInputs['ring']): number | null {
  const a = ring.latest();
  const b = a === null ? null : ring.range(a.ms - 30_000, a.ms - 1);
  const c = a === null || b === null ? null : ring.range(a.ms - 30_000, b.lastMs - 1);
  return a === null ? null : b === null || c === null ? a.spot : median3(a.spot, b.last, c.last);
}

/**
 * THE D2 CLOSE — buy back every short first; sell the longs only once no
 * short is held (spec D2, §4.5).
 *
 * Not "shorts first, longs after" in one package: the gateway does not gate
 * fills (spec G12), so a package holding both could fill the long's sale
 * while the short's buy-back rests, and the book would be naked for exactly
 * as long as the market takes to move. The longs therefore go out on a LATER
 * pass, once the book shows no short at all. A short that cannot be bought
 * back holds its longs on the book — defined risk, by construction.
 */
export function d2Close(legs: readonly LegView[]): readonly EngineAction[] {
  const shorts = legs.filter((l) => l.side === 'Sell');
  return (shorts.length > 0 ? shorts : legs).map((l): EngineAction => ({ op: 'close', instrument: l.instrument }));
}
