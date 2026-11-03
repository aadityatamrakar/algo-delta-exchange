/**
 * THE SCRAP TIER AND ITS ENTRY GATE — buy back what is spent, and never sell it
 * back.
 *
 * Two halves of one desk directive (2026-07-21, all variants) that have to move
 * together. The EXIT half squares off any short that has decayed past a
 * threshold; the ENTRY half refuses to open one. A rule that only exited would
 * be worse than neither: phase R sizes its package `excess / (Δ × lot_size)`,
 * which demands its LARGEST packages exactly where delta is smallest, so an
 * exit-only dial would sell a low-delta package on one mark and scrap the whole
 * thing on the next.
 *
 * ── 1. TWO INDEPENDENT TESTS, ONE PACKAGE (`engine.py:753-814`) ─────────────
 * PRICE (`scrap_close_px`, 0.10 by default, every variant): a short marked at
 * or below the dial per share is bought back — the paise left in it is no
 * reward for the tail risk of holding.
 * DELTA (`scrap_close_delta`, 0 = off, `recenter` only): a short whose
 * per-share |Δ| has decayed STRICTLY below the dial goes the same way. Strictly:
 * at 0.15 exactly the leg stays.
 * A leg that qualifies on both is closed once, in one package, with one reason.
 *
 * ── 2. WHICH PRICE, AND THE ONE THE PORT CHANGES ────────────────────────────
 * Python read `leg["ltp"]` — one float per instrument, whichever side of the
 * spread it happened to be. Spec §6 fixes the scrap price test to the **bid**,
 * because the test asks "is there anything left in this short", and what is
 * left is what a BUYER would pay for it. `sellPrice` is that reading in `live`
 * and Python's mid-or-LTP float in `parity`, so a recorded board still replays.
 *
 * `ltp == 0` was Python's "missing mark, never a scrap" guard and the `0 < px`
 * test below is the same one. A quote that has never been seen gives `null` and
 * is likewise not a signal.
 *
 * ── 3. `hasGreeks: false` NEVER SCRAPS (TCS 2026-06-30) ─────────────────────
 * The delta test's guard in Python is `0.0 < abs(d)`, and the reason is
 * measured: `_mark_option_leg` seeds `_ZERO_GREEKS` and `leg_greeks` returns
 * them whenever iv/strike/opt_type is absent, so a leg the lake has no IV for
 * marks at delta 0.0 no matter how deep it is. **72 of 100 scrap marks on TCS
 * 2026-06-30 were zero-delta**, squaring off deep-ITM 2400 PEs against a ~2100
 * spot. `hasGreeks` is this engine's replacement for that sentinel
 * (`types.ts` §2) and it is read here directly: an unmarked leg is not a
 * candidate, whatever number its `delta` field happens to hold. A genuinely
 * 0.000-delta short is worth nothing anyway and the price test already takes
 * it, so excluding it costs no real scrap.
 *
 * ── 4. PROTECTED QUANTITY IS EXEMPT AT SELECTION, NOT DOWNSTREAM (`:780-784`) ─
 * This tier writes a re-sell BAN and a reason line off the same list it closes.
 * Filtering protection out later would ban a strike it never squared off and
 * name it in the reason — state recording a close that never happened. So the
 * victim list is `unprotectedLots` from the start, and a partly-protected leg
 * scraps its steerable lots and RESIZES down to the operator's tail.
 *
 * ── 5. THE BAN, AND WHY IT IS PER EXPIRY ───────────────────────────────────
 * A scrapped strike is banned from re-selling FOR ITS EXPIRY: the same contract
 * decayed to paise once and the rule that sold it would sell it again on the
 * next mark. The key is `strike:optType:expiry` (`types.ts`'s `scrapBanned`
 * comment); Python spells the same triple `optType:strike:expiry`
 * (`engine.py:745-751`) and the order is cosmetic — the key is internal state,
 * never crosses the wire, and the two sides of the parity suite compare the
 * LIST, which is empty on every recorded mark.
 *
 * ── 6. THE SELL GATE DEGRADES, IT DOES NOT VETO (`engine.py:816-877`) ───────
 * A banned / sub-price / sub-delta Sell open is stripped from the package. What
 * is left of the package still stands: a ROLL degrades to its close (closing the
 * tested short is a fine answer; holding it naked is not), and only a decision
 * that was ALL sells degrades to a hold — close and wait for expiry when there
 * is no option worth selling.
 *
 * FAIL-OPEN on a missing measurement, deliberately and in both arms: a strike
 * absent from the chain, carrying no price, or carrying no solvable delta is NOT
 * dropped. The gate exists to refuse a KNOWN-bad sale, not to refuse everything
 * it cannot measure — that would turn a quiet chain into a silent stand-down.
 *
 * Python's `atomic` arm (`:865-869`) is not ported: `atomic` is pairshift's
 * flag and pairshift is out of scope (spec §5). A recenter shift is never marked
 * atomic, so Python has never taken that branch for this family.
 *
 * PURE: no clock, no feed.
 */
import { unprotectedLots, type SteerableLeg } from './guards.ts';
import { greekReader, sellPrice } from './marking.ts';
import type { Dials } from './dials.ts';
import type { ChainSnap, EngineAction, EngineInputs, OptType, RuleState } from './types.ts';

/** Strikes are compared with the same tolerance `marking.ts` uses, for the same
 * reason: a caller reaching a ladder by arithmetic can land on 2439.999999. */
const STRIKE_EPS = 1e-6;

/**
 * `%g` for a strike, so `2400.0` keys as `2400` and `2437.5` as `2437.5`.
 *
 * Python's `f"{float(strike):g}"` switches to exponent notation past six
 * significant digits; no NSE strike is within three orders of magnitude of
 * that, so a plain `String(Number)` is the same rendering over the whole
 * reachable range.
 */
const strikeKey = (strike: number): string =>
  Number.isFinite(strike) ? String(Number(strike)) : String(strike);

/** The re-sell ban key — see §5. */
export function scrapKey(strike: number, optType: OptType, expiry: string): string {
  return `${strikeKey(strike)}:${optType}:${expiry}`;
}

/** What the scrap tier decided. `null` from `scrapClose` means nothing had
 * decayed far enough — the pass continues to the playbook phases. */
export interface ScrapResult {
  readonly actions: ReadonlyArray<EngineAction>;
  readonly reason: string;
  readonly stateAfter: RuleState;
}

/** Which test took a leg, so the reason can say it and a test can assert on the
 * branch rather than on prose. */
type ScrapCause = 'price' | 'delta';

/**
 * The scrap tier over one mark — `_scrap_close` (`engine.py:753-814`).
 *
 * Runs AFTER the guard tier and AFTER the working-package hold, exactly where
 * Python runs it (`engine.py:914-918`): a paise short is bought back before the
 * playbook starts a new package, but it never preempts one that is already
 * being worked.
 */
export function scrapClose(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
): ScrapResult | null {
  const px = dials.scrap_close_px;
  const dd = dials.scrap_close_delta;
  if (!(px > 0) && !(dd > 0)) return null;

  const { legs, protectedQty, chain, pricing } = inputs;
  const taken: Array<{ leg: SteerableLeg; cause: ScrapCause; at: number }> = [];

  for (const leg of unprotectedLots(
    legs.filter((l) => l.side === 'Sell'),
    protectedQty,
  )) {
    const mark = sellPrice(leg.exit, pricing);
    if (px > 0 && mark !== null && mark > 0 && mark <= px) {
      taken.push({ leg, cause: 'price', at: mark });
      continue;
    }
    // §3 — an unmarked leg is not a candidate, whatever its `delta` field says.
    if (dd > 0 && leg.hasGreeks) {
      const d = Math.abs(leg.delta);
      if (d > 0 && d < dd) taken.push({ leg, cause: 'delta', at: d });
    }
  }
  if (taken.length === 0) return null;

  const banned = new Set(state.scrapBanned);
  for (const t of taken) banned.add(scrapKey(t.leg.strike, t.leg.optType, chain.expiry));

  const thresholds: string[] = [];
  if (px > 0) thresholds.push(`<= ${px.toFixed(2)}/share`);
  if (dd > 0) thresholds.push(`|Δ| < ${dd.toFixed(2)}`);
  const labels = taken.map((t) =>
    t.cause === 'price'
      ? `${strikeKey(t.leg.strike)}${t.leg.optType}@${t.at.toFixed(2)}`
      : `${strikeKey(t.leg.strike)}${t.leg.optType}@Δ${t.at.toFixed(3)}`,
  );

  return {
    actions: taken.map(({ leg }): EngineAction => {
      const held = Math.trunc(leg.lots);
      return leg.steerableLots >= held
        ? { op: 'close', instrument: leg.instrument }
        : { op: 'resize', instrument: leg.instrument, targetLots: held - leg.steerableLots };
    }),
    reason:
      `scrap-close: square off spent short(s) (${thresholds.join(' or ')}) ` +
      `(${labels.join(', ')}) — book it, no re-sell`,
    stateAfter: { ...state, scrapBanned: [...banned] },
  };
}

/** The chain's row for a strike, or null. */
function rowQuote(chain: ChainSnap, strike: number, optType: OptType) {
  const row = chain.strikes.find((s) => Math.abs(s.strike - strike) <= STRIKE_EPS);
  if (row === undefined) return null;
  return optType === 'CE' ? row.ce : row.pe;
}

/** What the sell gate did to a package. `dropped` is empty when it did
 * nothing, which is also when `actions` is the array it was handed. */
export interface SellGateResult {
  readonly actions: ReadonlyArray<EngineAction>;
  /** One label per stripped sell, naming the strike and the reason. */
  readonly dropped: ReadonlyArray<string>;
  /** True when the whole package was sells and the gate took all of them —
   * §6's "close and wait for expiry when there is no option worth selling". */
  readonly degradedToHold: boolean;
}

/**
 * Strip the Sell opens a package should never have proposed — `_scrap_sell_gate`
 * (`engine.py:816-877`). See §6.
 */
export function sellGate(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  actions: ReadonlyArray<EngineAction>,
): SellGateResult {
  const opens = actions.filter((a) => a.op === 'open');
  if (opens.length === 0) return { actions, dropped: [], degradedToHold: false };

  const { chain, pricing } = inputs;
  const banned = new Set(state.scrapBanned);
  const minPx = dials.min_sell_px;
  const minDelta = dials.min_sell_delta;
  const greeks = greekReader(inputs);

  const dropped: string[] = [];
  const kept: EngineAction[] = [];
  for (const a of actions) {
    if (!(a.op === 'open' && a.side === 'Sell')) {
      kept.push(a);
      continue;
    }
    const label = `${strikeKey(a.strike)}${a.optType}`;
    if (banned.has(scrapKey(a.strike, a.optType, chain.expiry))) {
      dropped.push(`${label} (scrap-banned)`);
      continue;
    }
    const q = rowQuote(chain, a.strike, a.optType);
    const px = q === null ? null : sellPrice(q, pricing);
    if (minPx > 0 && px !== null && px > 0 && px <= minPx) {
      dropped.push(`${label} (premium ${px.toFixed(2)})`);
      continue;
    }
    // The delta arm is only measured when it is armed: `greekReader` costs a
    // Black-76 solve per strike outside parity, and an inert dial must not pay
    // for one (`engine.py:847-848` reads the same way).
    const g = minDelta > 0 ? greeks(a.strike, a.optType) : null;
    const cd = g === null ? null : Math.abs(g.delta);
    if (cd !== null && cd > 0 && cd <= minDelta) {
      dropped.push(`${label} (|Δ| ${cd.toFixed(3)})`);
      continue;
    }
    kept.push(a);
  }

  if (dropped.length === 0) return { actions, dropped: [], degradedToHold: false };
  // A package with nothing left but the sells it just lost is a hold. One with
  // an exit left keeps it — that is the roll degrading to its close.
  //
  // `kept` counts RESIZES as well as whole closes, and that is deliberately
  // safer than Python. Python's branch is `if kept or dec.get("close_ids")`
  // (`engine.py:870`), which ignores `close_parts` — its own comment calls the
  // result "only accidentally safe for a partial close". A package whose only
  // exit is a partial unwind would degrade to a HOLD there and keep the delta it
  // was trying to shed; here it degrades to the partial, which is the same
  // "a roll degrades to its close" rule applied to the shape Python forgot.
  if (kept.length === 0) return { actions: [], dropped, degradedToHold: true };
  return { actions: kept, dropped, degradedToHold: false };
}
