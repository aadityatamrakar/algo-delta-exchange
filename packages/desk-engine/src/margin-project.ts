/**
 * SPAN-LITE, AND THE PRE-TRADE CAP IT GATES — a MODEL, labelled as one.
 *
 * ── 0. READ THIS BEFORE YOU BELIEVE A NUMBER OUT OF THIS FILE ───────────────
 * Every figure here is a 21-scenario Black-76 estimate, not a broker figure.
 * The design spec is explicit about how wrong it can be (§6): on
 * BHEL-2026-08-25 this arithmetic said **20.8L where the broker said 42.9L**, a
 * factor of 2.06 on the one quantity a margin gate is a fraction of. That is
 * exactly why `shift.ts` refuses to arm phase S off anything but a fresh broker
 * read, and why the spec ports SPAN-lite "only as the labeled fallback for
 * display/projection".
 *
 * So the rule for this module is one sentence: **it may only ever REFUSE or
 * SHRINK a trade, never authorise one.** `projectMarginCap` drops or downsizes
 * fresh Sell opens; `guards.ts`'s trim walk uses it to decide how many shorts
 * to take OFF. Both directions are conservative under a model that overstates
 * AND under one that understates — an overstatement sells less than it could,
 * an understatement is caught by the broker's own margin call on the next read.
 * Nothing here is ever allowed to become the reason a book opens something.
 *
 * ── 1. WHAT SPAN-LITE IS (`sim/margin.py:1-24`, transliterated) ─────────────
 * The worst portfolio LOSS against the current mark across a grid of
 * `spot × (1 + f × price_scan_pct)` price shocks — `f ∈ {0, ±⅓, ±⅔, ±1}` —
 * crossed with `iv × {1 − vol_scan, 1, 1 + vol_scan}` (7 × 3 = 21 scenarios).
 * Every leg is repriced Black-76 in every scenario and the changes are SUMMED
 * per scenario before the minimum is taken, which is what makes the hedge
 * benefit fall out for free: a long wing's scenario gain offsets a short's
 * scenario loss in the same scenario, so no spread-matching logic is needed.
 *
 * The result is floored at `min_short_pct × short notional` (deep-OTM shorts
 * and fully-hedged books still post margin on NSE) and carries an
 * `exposure_pct` add-on for gap/settlement risk. A book with no short exposure
 * at all needs no SPAN — a fully-paid long option is margined nowhere.
 *
 * TWO DELIBERATE NARROWINGS from `sim/margin.py`, both because this engine
 * manages ONE options book on ONE expiry:
 *
 *   - **No futures leg.** `_span_core` prices `instrument == "future"` legs
 *     linearly and adds their notional to the exposure base. `LegView` is an
 *     option by construction (it carries `strike` and `optType`), so that arm
 *     has nothing to price and is not ported. A futures hedge on a desk book
 *     would need it back.
 *   - **No `wing_relief_candidates`, no `margin_benefit`, no `per_leg_naked`.**
 *     The wing-relief search (`margin.py:253-362`, ~110 LOC) exists to buy long
 *     wings to free margin, and the recenter family is `no_buy: True` on every
 *     one of its twelve presets (`playbooks.py:349-478`) — spec §5 hardcodes
 *     that, so the guard's only remedy is a trim and the search has no caller.
 *     `per_leg_naked` is a display breakdown; every caller here passes Python's
 *     `per_leg=False`.
 *
 * `entry` IS NOT AN INPUT, and that is arithmetic rather than an omission:
 * `_span_core` accumulates `leg_pnl(scenario) − leg_pnl(current)`, and
 * `leg_pnl` is `sign × (mark − entry) × shares` — the entry cancels exactly in
 * the difference. Passing it would be a field that could be wrong without ever
 * changing an answer.
 *
 * ── 2. THE TENOR IS THE CALENDAR ONE, NOT `marking.ts`'s ────────────────────
 * `_leg_t` reads `pricing.year_frac` (`pricing.py:46-49`) — plain calendar days
 * over 365, floored at `_MIN_T` ≈ one hour. It is NOT `year_frac_at`, and so it
 * is NOT `marking.yearFrac`, which refines intraday on the expiry day. On
 * expiry morning the two differ by 10× (marking's ~6h10m of session vs this
 * file's 1h floor), and a margin model quoted against a different tenor from
 * the one Python's boards were sized under is a model that cannot be checked.
 * Keeping the divergence explicit here is the point: the greeks that STEER the
 * book and the margin that CAPS it are two different measurements.
 *
 * ── 3. WHERE THE PROJECTION SITS (`engine.py:1009-1101`) ────────────────────
 * `projectMarginCap` runs LAST, after the sell gate, on a decision that already
 * exists. It is net of that decision's OWN closes and resizes: a roll frees the
 * old short's margin at the same mark it opens the new one, so the base book
 * excludes what the package closes — else every roll at the cap reads as a pure
 * margin add and defence starves behind the cap. When even the netted reopen
 * has no headroom the closes and any Buy opens are KEPT and only the Sell opens
 * go: a roll degrades to closing the tested short, never to holding it naked.
 *
 * PURE: no clock, no feed. `dateIst` and the expiry ride in as arguments.
 */
import { b76Price } from '@algomaker/greeks';
import { RISK_FREE } from './marking.ts';
import { sellLotSize } from './ladder.ts';
import type { Dials } from './dials.ts';
import type { EngineAction, EngineInputs, LegView, OptType, Side } from './types.ts';

/**
 * One position the scenario grid can price. Deliberately NOT `LegView`: the
 * projection has to price legs the book does not hold yet (a decision's own
 * Sell opens), and a `LegView` cannot be built for those without inventing a
 * mark, a greek set and an exit quote it would then be sized off.
 */
export interface SpanLeg {
  readonly strike: number;
  readonly optType: OptType;
  readonly side: Side;
  readonly lots: number;
  readonly lotSize: number;
  /** Marked IV. `null` — an unsolved leg, or a strike we do not hold yet —
   * takes `SPAN_LITE.defaultIv`, exactly as `_leg_iv` does. */
  readonly iv: number | null;
  readonly expiry: string;
}

/** `portfolio_margin`'s answer, minus the `per_leg_naked` breakdown no caller
 * here asks for. Rupees, rounded to paise as Python rounds them. */
export interface SpanResult {
  readonly span: number;
  readonly exposure: number;
  readonly total: number;
  readonly worstScenario: { readonly priceMovePct: number; readonly volMult: number };
  readonly shortNotional: number;
  readonly shortLots: number;
}

/**
 * `portfolio_margin`'s keyword defaults (`margin.py:158-169`), as one frozen
 * record so a caller cannot half-override the grid. These are the numbers every
 * committed Python board's margin column was computed at.
 */
export const SPAN_LITE = {
  defaultIv: 0.35,
  priceScanPct: 0.21,
  volScan: 0.25,
  exposurePct: 0.05,
  minShortPct: 0.05,
  rate: RISK_FREE,
} as const;

/** `margin.py:35` — the seven price-shock fractions, in Python's order. */
const F_MULTS: ReadonlyArray<number> = [0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1];

/** `margin.py:36` — ~1 hour, so expiry day still has a grid to scan. */
const MIN_T = 1 / 365 / 24;

/** The relief/trim target: 95% of cap, so the guard does not ping-pong across
 * it (`engine.py:87` `_MARGIN_HYSTERESIS`). */
export const MARGIN_HYSTERESIS = 0.95;

/** Python's `round(x, 2)` for the magnitudes this file deals in. Half-away
 * where Python is half-even; a rupee figure landing exactly on a half-paise is
 * not reachable from a Black-76 sum, and the difference could only ever be one
 * paise on a display field. */
const paise = (x: number): number => Math.round(x * 100) / 100;

/** `YYYY-MM-DD` → epoch ms at UTC midnight, or null. Date arithmetic on an
 * already-IST-resolved string, so no offset — the same convention `marking.ts`
 * and `session.ts` use. Rejects a rolled-over date (`2026-02-31`). */
function utcDayMs(dateIso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  if (!Number.isFinite(ms)) return null;
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/**
 * `pricing.year_frac` (`pricing.py:46-49`): calendar days over 365, floored at
 * zero, with NO intraday refinement. See §2 of the header for why this is not
 * `marking.yearFrac`.
 */
export function calendarYearFrac(fromDate: string, expiry: string): number {
  const from = utcDayMs(fromDate);
  const to = utcDayMs(expiry);
  if (from === null || to === null) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000) / 365);
}

/** `_leg_t` (`margin.py:58-65`): the calendar tenor, floored so the grid still
 * has something to scan on expiry day. An unparseable expiry takes the floor
 * rather than zeroing the leg out of the book. */
function legTenor(leg: SpanLeg, dateIst: string): number {
  if (leg.expiry === '') return MIN_T;
  return Math.max(calendarYearFrac(dateIst, leg.expiry), MIN_T);
}

/** `_leg_iv` (`margin.py:48-55`): the leg's own vol when it has a positive one,
 * the grid's default otherwise. */
function legIv(leg: SpanLeg): number {
  const iv = leg.iv;
  return iv !== null && Number.isFinite(iv) && iv > 0 ? iv : SPAN_LITE.defaultIv;
}

const ZERO_SPAN: SpanResult = {
  span: 0,
  exposure: 0,
  total: 0,
  worstScenario: { priceMovePct: 0, volMult: 1 },
  shortNotional: 0,
  shortLots: 0,
};

/**
 * SPAN-lite for a book marked at `spot` on `dateIst` — `_span_core` +
 * `portfolio_margin`'s validation, transliterated (`margin.py:81-212`).
 *
 * Fail-soft exactly as Python is: a non-positive spot or an empty book returns
 * the zero-shaped result rather than throwing, because this is called on every
 * mark inside a decision pass and a raising margin model would take the whole
 * supervisor down over an unpriceable strike.
 */
export function spanLiteMargin(
  legs: ReadonlyArray<SpanLeg>,
  spot: number,
  dateIst: string,
): SpanResult {
  if (!Number.isFinite(spot) || spot <= 0 || legs.length === 0) return ZERO_SPAN;

  const volMults: ReadonlyArray<number> = [1 - SPAN_LITE.volScan, 1, 1 + SPAN_LITE.volScan];
  // Python builds `[(f, vm) for f in _F_MULTS for vm in vol_mults]` and keys a
  // dict by the pair; only the WORST VALUE is read downstream, so the totals
  // ride in a flat array in the same order and the tie-break Python's `min`
  // would apply cannot be observed.
  const totals = new Array<number>(F_MULTS.length * volMults.length).fill(0);

  let shortNotional = 0;
  let shortLots = 0;
  let anyShort = false;

  for (const leg of legs) {
    // `lotSize` is NOT truncated: Python's `int(lot_size)` is the identity on
    // every NSE lot, and on Delta (0.001 BTC per contract) it made every leg
    // weigh nothing. Lots stay whole — contracts are.
    const shares = Math.trunc(leg.lots) * leg.lotSize;
    if (!Number.isFinite(shares) || shares === 0) continue;
    const sign = leg.side === 'Buy' ? 1 : -1;
    const t = legTenor(leg, dateIst);
    const iv = legIv(leg);
    const base = { future: spot, strike: leg.strike, t, rate: SPAN_LITE.rate, type: leg.optType };
    const current = b76Price({ ...base, vol: iv });

    let at = 0;
    for (const f of F_MULTS) {
      const scenF = spot * (1 + f * SPAN_LITE.priceScanPct);
      for (const vm of volMults) {
        const scen = b76Price({ ...base, future: scenF, vol: iv * vm });
        // `leg_pnl(scenario) − leg_pnl(current)`, with `entry` cancelled out.
        totals[at] = (totals[at] ?? 0) + sign * (scen - current) * shares;
        at += 1;
      }
    }

    if (leg.side === 'Sell') {
      shortNotional += spot * shares;
      shortLots += Math.trunc(leg.lots);
      anyShort = true;
    }
  }

  // `margin.py:132-135` — no unbounded exposure at all, so no margin, exactly
  // as a real exchange treats a fully-paid long book.
  if (!anyShort) return ZERO_SPAN;

  let worstAt = 0;
  for (let i = 1; i < totals.length; i += 1) {
    if ((totals[i] ?? 0) < (totals[worstAt] ?? 0)) worstAt = i;
  }
  const worstChange = totals[worstAt] ?? 0;
  const rawSpan = Math.max(0, -worstChange);
  const span = Math.max(rawSpan, SPAN_LITE.minShortPct * shortNotional);
  const exposure = SPAN_LITE.exposurePct * shortNotional;

  const fAt = Math.floor(worstAt / volMults.length);
  const vAt = worstAt % volMults.length;
  return {
    span: paise(span),
    exposure: paise(exposure),
    total: paise(span + exposure),
    worstScenario: {
      priceMovePct: paise((F_MULTS[fAt] ?? 0) * SPAN_LITE.priceScanPct * 100),
      volMult: paise(volMults[vAt] ?? 1),
    },
    shortNotional: paise(shortNotional),
    shortLots,
  };
}

/**
 * One held leg as the grid sees it.
 *
 * `iv` is the leg's MARKED vol, and `hasGreeks: false` sends `null` rather than
 * the stale number the field still holds: an unsolved leg has no vol, and
 * pricing it at one nothing measured is the sentinel `types.ts` §2 retires.
 */
function legToSpan(l: LegView, expiry: string): SpanLeg {
  return {
    strike: l.strike,
    optType: l.optType,
    side: l.side,
    lots: Math.trunc(l.lots),
    lotSize: l.lotSize,
    iv: l.hasGreeks ? l.iv : null,
    expiry,
  };
}

/** The book as the grid sees it. One expiry per engine, so the chain's is every
 * leg's (`actions.py:36-37` reads the same figure off the first leg carrying
 * one). */
export function bookSpanLegs(
  legs: ReadonlyArray<LegView>,
  expiry: string,
): ReadonlyArray<SpanLeg> {
  return legs.map((l) => legToSpan(l, expiry));
}

/**
 * A leg the decision would OPEN, as the grid sees it.
 *
 * EXPORTED, and the only way any path on this desk prices an open against the
 * cap: `projectMarginCap` below and `decide.ts`'s `projectFits` both call it,
 * with the same `sellLotSize(legs, chain)` lot. Two copies of this four-line
 * record is exactly how the recenter projection and the delta-lean one would
 * come to price the same package differently — and a margin gate that
 * disagrees with itself is one that is wrong on one of the two paths, silently.
 *
 * `iv: null` — so `SPAN_LITE.defaultIv` prices it — and that is Python's number
 * rather than a shortcut: `roll_out`, `protect_partial` and every recenter sell
 * build their open leg without an `iv` key (`actions.py:66-72`, `:105-111`;
 * confirmed on the recorded fixtures, whose `open_legs` carry
 * `expiry/instrument/lot_size/lots/opt_type/series/side/strike` and nothing
 * else), so `_leg_iv` fell through to 0.35 for every projected sale on every
 * committed board. Solving the strike's real IV here would be a better model
 * and a worse port — it would move the cap gate away from the numbers the
 * boards were sized under, silently.
 */
export function openSpanLeg(
  action: Extract<EngineAction, { op: 'open' }>,
  lotSize: number,
  expiry: string,
): SpanLeg {
  return {
    strike: action.strike,
    optType: action.optType,
    side: action.side,
    lots: Math.trunc(action.lots),
    lotSize,
    iv: null,
    expiry,
  };
}

/**
 * The book a decision would LEAVE BEHIND, before its opens: every held leg
 * minus what the package closes, and a partly-resized leg at its SURVIVING
 * size.
 *
 * The partial matters (`engine.py:1045-1055`): recenter's unwind buys back part
 * of a leg, which frees only that part's margin. Dropping the leg whole would
 * credit relief the book never gets and oversize whatever the same package
 * sells.
 */
export function baseAfterExits(
  legs: ReadonlyArray<LegView>,
  actions: ReadonlyArray<EngineAction>,
  expiry: string,
): ReadonlyArray<SpanLeg> {
  const closed = new Set<string>();
  const resized = new Map<string, number>();
  for (const a of actions) {
    if (a.op === 'close') closed.add(a.instrument);
    else if (a.op === 'resize') resized.set(a.instrument, Math.trunc(a.targetLots));
  }
  // Walked over `legs` rather than over `bookSpanLegs(...)` because the exit
  // actions name an INSTRUMENT and `SpanLeg` deliberately carries no id: the
  // grid prices contracts, it does not track positions.
  const kept: SpanLeg[] = [];
  for (const leg of legs) {
    if (closed.has(leg.instrument)) continue;
    const target = resized.get(leg.instrument);
    if (target === undefined) {
      kept.push(legToSpan(leg, expiry));
      continue;
    }
    if (target <= 0) continue;
    kept.push({ ...legToSpan(leg, expiry), lots: target });
  }
  return kept;
}

/** What `projectMarginCap` did, so the caller can say it in the reason and a
 * test can assert on the branch rather than on prose. */
export type ProjectionVerdict = 'fits' | 'downsized' | 'sells-dropped' | 'hold';

export interface Projection {
  readonly actions: ReadonlyArray<EngineAction>;
  readonly verdict: ProjectionVerdict;
  /** SPAN-lite of the book the package would leave, before its opens. */
  readonly base: number;
  /** SPAN-lite of that book WITH the package's opens, as first proposed. */
  readonly projected: number;
}

/**
 * Project a decision's fresh Sell opens against `margin_cap` and downsize or
 * drop them to fit — `_project_margin_cap` (`engine.py:1009-1127`).
 *
 * Untouched, always: closes, resizes, and Buy opens. A Buy only ever helps
 * margin, and an exit is the remedy rather than the risk.
 *
 * `margin_cap` 0 is an UNCAPPED book and returns the decision whole — the same
 * off-state `shift.ts` reads, and what stops a division by nothing.
 *
 * The `atomic` arm of Python's version is NOT ported: `atomic` is pairshift's
 * flag (`actions.py:40-46`, human-ruled 2026-08-05) and pairshift is out of
 * scope for this engine (spec §5's presets note). A recenter shift is never
 * marked atomic in Python and so has never taken that branch.
 */
export function projectMarginCap(
  inputs: EngineInputs,
  dials: Dials,
  actions: ReadonlyArray<EngineAction>,
): Projection {
  const opens = actions.filter((a): a is Extract<EngineAction, { op: 'open' }> => a.op === 'open');
  const sells = opens.filter((a) => a.side === 'Sell');
  const cap = dials.margin_cap;
  if (sells.length === 0 || !(cap > 0)) {
    return { actions, verdict: 'fits', base: 0, projected: 0 };
  }

  const { chain, legs } = inputs;
  const expiry = chain.expiry;
  const lotSize = sellLotSize(legs, chain);
  const base = baseAfterExits(legs, actions, expiry);
  const openLegs = opens.map((a) => openSpanLeg(a, lotSize, expiry));

  const baseTotal = spanLiteMargin(base, chain.spot, inputs.dateIst).total;
  const projected = spanLiteMargin([...base, ...openLegs], chain.spot, inputs.dateIst).total;
  if (projected <= cap) return { actions, verdict: 'fits', base: baseTotal, projected };

  /** Keep everything but the Sell opens. A package with nothing else left is a
   * hold — never a bare close the playbook did not decide to make. */
  const strip = (): Projection => {
    const kept = actions.filter((a) => !(a.op === 'open' && a.side === 'Sell'));
    return kept.length > 0
      ? { actions: kept, verdict: 'sells-dropped', base: baseTotal, projected }
      : { actions: [], verdict: 'hold', base: baseTotal, projected };
  };

  // `headroom` is the package's own marginal load, floored at 1 so a package
  // that reads as free cannot divide by nothing (`engine.py:1097`).
  const headroom = Math.max(projected - baseTotal, 1);
  const f = Math.max(0, (cap - baseTotal) / headroom);
  const downsized: EngineAction[] = [];
  for (const a of actions) {
    if (!(a.op === 'open' && a.side === 'Sell')) {
      downsized.push(a);
      continue;
    }
    // TRUNCATION, not rounding: `int(lots * f)` in Python. Rounding up is what
    // would put a package back over the cap it was just scaled to fit.
    const lots = Math.trunc(Math.trunc(a.lots) * f);
    if (lots > 0) downsized.push({ ...a, lots });
  }
  if (!downsized.some((a) => a.op === 'open' && a.side === 'Sell')) return strip();

  const reLegs = downsized
    .filter((a): a is Extract<EngineAction, { op: 'open' }> => a.op === 'open')
    .map((a) => openSpanLeg(a, lotSize, expiry));
  const reprojected = spanLiteMargin([...base, ...reLegs], chain.spot, inputs.dateIst).total;
  if (reprojected > cap) return strip();

  return { actions: downsized, verdict: 'downsized', base: baseTotal, projected };
}
