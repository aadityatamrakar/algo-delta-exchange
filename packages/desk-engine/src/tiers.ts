/**
 * THE SIX TIERS — everything `recenter` does BESIDES sizing one sale, each one
 * a dial the operator can switch on alone.
 *
 * `shed.ts` owns the sale: how much delta is over the band and which strike
 * sheds it. This file owns the six behaviours the Python desk grew AROUND that
 * sale over four weeks of live boards (`playbooks.py:3435-3876`), which in
 * Python are ~200 lines inlined into one function and reachable only by reading
 * the whole of it. That is the defect being ported out: `recenter`,
 * `recenter-eod`, `recenter-eod3`, `recenter-trend`, `recenter-reshift` and
 * `recenter-crossfill` are SIX ENTRY POINTS INTO ONE FUNCTION, distinguishable
 * only by which `p.get()` happened to return something. Here each is a named,
 * separately-testable function with a typed off-state, and `phaseShed` composes
 * them in Python's order.
 *
 * ── 1. THE EOD SWEEP CONSUMES THE SESSION, NOT THE SALE (`:3527-3534`) ──────
 * At `eod_flat_min` the tolerance becomes **0 for exactly one mark**, so the
 * whole `|netΔ|` is shed rather than the excess and the book carries overnight
 * flat to within a rounding lot. The arming is OUTCOME-BLIND: the first
 * eligible mark stamps `rcEodDay` whether the sale is emitted, downsized by the
 * margin projection, dropped by the scrap gate or comes out sub-lot. Python
 * says why, and it is the whole reason this is state rather than a predicate:
 * "Retrying in the session tail would chase the gamma the sweep itself just
 * added, and a sale the cap refused at 15:15 is refused again at 15:20."
 *
 * ── 2. THE ANCHOR IS AN EMA OF SPOT, NOT OF THE MARKS THAT ACTED (`:3509-3525`)
 * `anchor_ema_marks` sells `strikes_out` from a LAGGED anchor instead of from
 * spot, because selling at ATM±2 off current spot is what chases the market
 * into the extreme of a V. The EMA is updated on EVERY mark the rule reaches,
 * INCLUDING the ones that go on to hold — "an EMA sampled only when the rule
 * acts is not an EMA of spot". `phaseShed` therefore writes it before its own
 * hold guards, which is the one ordering in this file that looks like a bug and
 * is not.
 *
 * Its twin `confirm_marks` counts CONSECUTIVE breached consults and is
 * maintained BEFORE the in-band return, so an in-band mark genuinely resets it
 * (`:3603-3621`): a spike that reverts inside the window costs nothing, a
 * sustained move is still managed in the same session, just later. The streak
 * resets on EMIT and not on execution — a sale the scrap gate drops restarts
 * the clock, which can only make the arm trade less.
 *
 * ── 3. THE UNWIND AND THE SELL AGREE ON DELTA AND OPPOSE ON GAMMA (`:2820-2898`)
 * This is the single most expensive lesson in the file. Buying back a short CE
 * removes its negative delta exactly as selling a PE adds positive delta — so
 * the two are interchangeable for the trigger. They are NOT interchangeable for
 * the band: a sale ADDS short gamma and WIDENS `allowed = |netΓ| × tol × spot`,
 * while a buy-back REMOVES it and NARROWS the very band the rule steers by.
 * Unbounded, that is a spiral — a smaller allowance manufactures a larger
 * excess, which unwinds more — and it was measured on the 17-book board taking
 * marks outside the band from **7% to 46%**.
 *
 * Hence TWO bounds, and `lifoUnwind` honours both: the delta `budget`, and a
 * gamma floor `gFloor = lotSize / (tol × spot)` — the convexity at which the
 * band is worth exactly one lot, below which `phaseShed` disables itself with
 * "no convexity to centre" and stops managing delta at all.
 *
 * The other edge is Python's and it is kept verbatim: **a lot is ALWAYS taken
 * while excess remains and the floor allows it, even when one lot overshoots**
 * (`:2874-2882`). A stack leg that has run ITM sheds more in one lot than the
 * whole excess, `round()` then returns 0, and the walk breaks with the rule
 * selling the other side while its own legs sit right there — VEDL Dec-25, 12
 * times against a 10-leg CE stack.
 *
 * ── 4. THE RECYCLE BANKS WHAT A SINGLE MARK CANNOT SPEND (`:3761-3829`) ─────
 * The unwind buys the reversed side back and collects nothing, so a chop pays
 * premium out on every reversal and the theta meant to fund it is gone. The
 * recycle re-sells `recycle_frac` of the loss just realized — on the CLOSED
 * side (`reshift`) or the OPPOSITE one (`crossfill`) — clipped to the room the
 * package's landing point leaves inside the band.
 *
 * `recycle_bank` exists because `⌊frac × loss / lotPremium⌋` is 0 on almost
 * every mark of a big-lot name: the unwind buys back ONE leg per mark, so the
 * loss arrives in slices whose half never affords a whole lot. Measured on the
 * sell-only ASHOKLEY crossfill board: **₹4.01L of losses booked, ONE lot ever
 * recycled, ~₹2L of computed credit discarded sub-lot.** With the dial each
 * mark DEPOSITS into `rcCredit` and the sale spends the whole bank whenever it
 * affords ≥1 lot.
 *
 * The DEBIT is deferred and that is load-bearing: `RecycleCommit` is returned
 * BESIDE the state rather than folded into it, because the sale it pays for has
 * not happened yet — the scrap gate may drop it and the margin projection may
 * downsize it, and an unspent credit must stay banked (`:3755-3760`, Python's
 * `state_commit` / `RuleEngine._commit_state`). The DEPOSIT is written on emit,
 * because the closes that realized the loss are part of the same decision and
 * the sell-side gates never strip closes.
 *
 * ── 5. THE BALANCE TIER IS THE ANSWER TO A BOOK THAT LOST A SIDE (`:3578-3596`)
 * The convexity floor is right when both sides are there and simply deep ITM —
 * there is nothing to centre and selling would only add risk. It is badly wrong
 * when the book has LOST a side. On VEDL Dec-25 the scrap tier took all six
 * entry legs, the unwind drained the added PE, and the rule then answered "no
 * convexity" for **879 of the remaining 911 marks** while spot rallied 12% into
 * four naked calls. A book missing a side is REBUILT — sell that side back on,
 * matched to the live side's lots — not abandoned.
 *
 * ── 6. WHAT IS DELIBERATELY NOT PORTED ──────────────────────────────────────
 * `rc_seen`, Python's provenance ledger. It is a `{leg id → sequence}` dict
 * DERIVED at every mark from what is on the book (`:2751-2777`), and its whole
 * job is to order the unwind stack newest-first. `RuleState.rcStack` answers
 * the same question as an ordered list of what this rule ADDED, so
 * `unwindStack` reads that instead. The derivation's self-healing property is
 * kept: a leg that is no longer on the book simply does not appear in the
 * stack, whatever the ledger still says about it.
 *
 * `unwind_share` and `unwind_entry_book` have no dial here either. Every
 * shipped preset carries `1.0` and `True` (the user-directed 2026-07-31
 * values), so the arms they select are the only arms that ever ran; `dials.ts`
 * collapses all three onto `unwind_enabled`. The entry book is therefore always
 * eligible — it sorts LAST, so it is reached only once everything the rule
 * added itself has come off.
 *
 * IMPORTS THE GEOMETRY FROM `ladder.ts`, not from `corridor.ts`, for the same
 * reason `shed.ts` does: `corridor.ts` imports `shed.ts`, `shed.ts` imports
 * this file, and reaching back up to `corridor.ts` for a re-export would close
 * that ring at runtime. The `Corridor` TYPE is imported type-only and erases.
 *
 * PURE: no clock, no feed. Every tier takes the mark it is deciding on.
 */
import type { Corridor } from './corridor.ts';
import type { Dials } from './dials.ts';
import { unprotectedLots, type SteerableLeg } from './guards.ts';
import { nearestStrike, otmSellStrike } from './ladder.ts';
import { greekReader, midOf, sellPrice } from './marking.ts';
import type {
  EngineAction,
  EngineInputs,
  LegView,
  OptType,
  RecycleCommit,
  RuleState,
} from './types.ts';

// ── 1. the EOD sweep ────────────────────────────────────────────────────────

export interface EodSweep {
  /** This mark sheds the WHOLE netΔ at tolerance 0. True at most once a day. */
  readonly armed: boolean;
  /** `RuleState.rcEodDay` after the mark — the session this sweep consumed. */
  readonly rcEodDay: string;
}

/**
 * Arm the once-per-session sweep — `playbooks.py:3527-3534`.
 *
 * `eod_flat_min` is a minute of day and 0 is its off-state (`dials.ts` §5), so
 * a sweep at midnight is not expressible and does not need to be. The date
 * comparison is against `RuleState.rcEodDay`, whose zero-value is `''` — never
 * a date, so a fresh book always arms on its first eligible mark.
 */
export function applyEodSweep(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
): EodSweep {
  const at = Math.trunc(dials.eod_flat_min);
  const armed = at > 0 && inputs.minuteOfDay >= at && state.rcEodDay !== inputs.dateIst;
  return { armed, rcEodDay: armed ? inputs.dateIst : state.rcEodDay };
}

// ── 2. the gk-anchor: a lagged sell reference, and its confirmation ─────────

export interface AnchorResult {
  /** What the fresh-sell strike is measured from. Spot, with the dial off. */
  readonly anchor: number;
  /** `RuleState.gkAnchor` after the mark. */
  readonly gkAnchor: number;
}

/**
 * Advance the anchor EMA — `playbooks.py:3509-3525`, `alpha = 2/(n+1)`.
 *
 * SEEDED TO SPOT on the first mark, so the arm degrades to its parent rather
 * than to a stale zero. `RuleState.gkAnchor`'s zero-value IS "unset"
 * (`types.ts:146`) and a real anchor is a spot, never 0 — the absent-vs-zero
 * conflation this type retires does not arise for a price.
 *
 * Called on EVERY mark, holds included; see §2 of the file header.
 */
export function applyAnchor(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
): AnchorResult {
  const spot = inputs.chain.spot;
  const marks = Math.trunc(dials.anchor_ema_marks);
  if (!(marks > 0)) return { anchor: spot, gkAnchor: state.gkAnchor };
  const alpha = 2 / (marks + 1);
  const prev = state.gkAnchor;
  const anchor = prev === 0 ? spot : alpha * spot + (1 - alpha) * prev;
  return { anchor, gkAnchor: anchor };
}

export interface ConfirmResult {
  /** `RuleState.gkStreak` after the mark. */
  readonly streak: number;
  /** The breach has lasted long enough to act on. Always true with the dial off. */
  readonly confirmed: boolean;
}

/**
 * The breach streak — `playbooks.py:3603-3621`, the second half of the
 * gk-anchor pair and the reason `applyAnchor` is not one function.
 *
 * The two run at DIFFERENT points of the mark: the EMA before every guard, the
 * streak after the band is known and before the in-band return. Fusing them
 * would force the caller to know the excess before it has measured the band.
 *
 * With `confirm_marks` off the streak is left exactly as it was rather than
 * zeroed — Python never writes the key at all in that case, and zeroing it here
 * would silently clear an operator's arm the moment the dial was turned off.
 */
export function applyConfirm(
  dials: Dials,
  state: RuleState,
  breached: boolean,
): ConfirmResult {
  const need = Math.trunc(dials.confirm_marks);
  if (!(need > 0)) return { streak: state.gkStreak, confirmed: true };
  const streak = breached ? state.gkStreak + 1 : 0;
  return { streak, confirmed: streak >= need };
}

// ── 3. the trend-skewed shed target ─────────────────────────────────────────

export interface TrendTarget {
  /** Shares of delta this mark is trying to move. `excess` with the dial off. */
  readonly budget: number;
  /** Where netΔ is aimed. Reason strings only — the budget is what acts. */
  readonly target: number;
  /** +1 when the move was UP (netΔ < 0 ⇒ we sell puts), −1 when it was down. */
  readonly dir: number;
}

/**
 * How far to shed once a mark has qualified — `playbooks.py:3639-3659`.
 *
 * The TRIGGER is untouched: a mark still acts only on a band breach. What
 * changes is the destination. Plain `recenter` sheds to the NEAR edge of the
 * band, which on a reversal is the edge AGAINST the new move — an up-move ends
 * the mark at `-allowed`, leaning the wrong way while spot rises. With the dial
 * the target is `trend_skew` of the band on the TREND side, so the book crosses
 * the band rather than stopping at its lip.
 *
 * The direction is the one the shed side already implies — selling CE means
 * spot fell, selling PE means it rose. No signal is read and no state is kept.
 *
 * `trend_skew` 0.0 is a LEGAL value (shed to flat); `trend_enabled` is the
 * off-state, because Python's `p.get("trend_skew")` reads an explicit `None` as
 * off and `recenter-reshift` ships exactly that (`dials.ts` header).
 */
export function applyTrendTarget(
  dials: Dials,
  netDelta: number,
  allowed: number,
  excess: number,
): TrendTarget {
  const dir = netDelta < 0 ? 1 : -1;
  if (!dials.trend_enabled) return { budget: excess, target: -dir * allowed, dir };
  const target = dir * dials.trend_skew * allowed;
  return { budget: Math.abs(netDelta - target), target, dir };
}

// ── 4. the LIFO unwind ──────────────────────────────────────────────────────

/** One leg the unwind took, and how many lots of it. */
export interface UnwindTake {
  readonly leg: LegView;
  readonly lots: number;
}

export interface UnwindResult {
  /** Closes and resizes, in stack order. */
  readonly actions: ReadonlyArray<EngineAction>;
  /** What was taken — the recycle's loss basis and its landing bound. */
  readonly taken: ReadonlyArray<UnwindTake>;
  /** Shares of delta the buy-back removed. */
  readonly shed: number;
}

export const NO_UNWIND: UnwindResult = { actions: [], taken: [], shed: 0 };

/**
 * The victim pool for `optType`, NEWEST FIRST; ties DEEPEST-ITM first —
 * `playbooks.py:2780-2817`.
 *
 * Provenance comes from `RuleState.rcStack` in ADD ORDER, so a leg's sequence
 * is its index + 1 and anything not in the stack is entry book at sequence 0 —
 * which sorts LAST and is reached only once everything the rule added has come
 * off. That replaces `_rc_seen`'s derived ledger (§6 of the header) and keeps
 * its self-healing property: a leg no longer on the book cannot be selected,
 * whatever the stack still remembers.
 *
 * Matched by `(strike, optType)` rather than by instrument, because that is
 * what a supervisor can record before it knows the tradingsymbol the broker
 * will return; two legs of the same wing and strike are one position anyway.
 *
 * DEEPEST FIRST within a sequence is user-directed 2026-08-03: ASHOKLEY held
 * entry PEs at 155/157.5/160 and the unwind ate the 155 on book-load order
 * while the 160 — pure intrinsic, and the day's bleed — sat. Deepest is also
 * the better delta trade: most shed per lot, least time value surrendered,
 * most gamma preserved for the band.
 *
 * The sort is a two-key comparator over a STABLE sort, which is Python's
 * `sort(key=..., reverse=True)` exactly: `reverse` does not reverse ties, so an
 * equal pair keeps book order in both languages.
 */
export function unwindStack(
  inputs: EngineInputs,
  state: RuleState,
  optType: OptType,
): ReadonlyArray<SteerableLeg> {
  const spot = inputs.chain.spot;
  const seq = (leg: LegView): number => {
    const at = state.rcStack.findIndex(
      (s) => s.optType === leg.optType && Math.abs(s.strike - leg.strike) <= 1e-6,
    );
    return at < 0 ? 0 : at + 1;
  };
  const depth = (leg: LegView): number =>
    optType === 'PE' ? leg.strike - spot : spot - leg.strike;

  // `unprotectedLots` is the ONE definition of "lots the rules may spend"
  // (`guards.ts` §1) — it filters a wholly-claimed leg out and carries the
  // spendable count on the row it returns, so `lifoUnwind` below reads the
  // number rather than recomputing it. This file used to keep its own copy.
  return [...unprotectedLots(
    inputs.legs.filter((l) => l.side === 'Sell' && l.optType === optType),
    inputs.protectedQty,
  )].sort((a, b) => seq(b) - seq(a) || depth(b) - depth(a));
}

/**
 * Buy the stack back, newest first, against a delta budget AND a gamma floor —
 * `playbooks.py:3677-3708` and `_rc_unwind` `:2820-2896`.
 *
 * Whole legs become `close`, at most ONE partial becomes a `resize` and it ends
 * the walk. A leg the operator part-owns resizes down to the protected tail
 * even when the unwind takes everything it may spend.
 *
 * ONE NARROWING FROM PYTHON, and it is the file-wide rule: a leg whose greeks
 * did not mark is SKIPPED. Python fell back to the chain and then to the
 * `0.30` constant for DELTA while already skipping the leg on a missing GAMMA
 * ("the floor cannot be honoured on a number that is not there") — the same
 * argument applies to both greeks, and `LegView.hasGreeks` is the flag that
 * says so honestly rather than a zero (`marking.ts` §2).
 */
export function lifoUnwind(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  cor: Corridor,
  opts: { readonly stackSide: OptType; readonly budget: number; readonly lotSize: number },
): UnwindResult {
  if (!dials.unwind_enabled) return NO_UNWIND;

  const spot = inputs.chain.spot;
  const { tol } = cor;
  // The convexity at which `allowed` is worth exactly one lot. `tol` 0 — the
  // EOD sweep — makes the floor 0 rather than infinite: at tolerance 0 there is
  // no band left to protect, and the sweep's whole point is to flatten.
  const gFloor = tol > 0 && spot > 0 ? opts.lotSize / (tol * spot) : 0;

  const actions: EngineAction[] = [];
  const taken: UnwindTake[] = [];
  let shed = 0;
  let remaining = Math.max(0, opts.budget);
  let gLeft = Math.max(0, Math.abs(cor.netGamma) - gFloor);

  for (const leg of unwindStack(inputs, state, opts.stackSide)) {
    if (remaining <= 0 || gLeft <= 0) break;
    if (!leg.hasGreeks) continue;

    const lots = leg.steerableLots;
    const perLot = leg.delta * leg.lotSize;
    const gLot = leg.gamma * leg.lotSize;
    if (lots <= 0 || !(perLot > 0) || !(gLot > 0)) continue;

    // A lot is ALWAYS taken while excess remains and the floor allows it, even
    // when one lot overshoots — §3 of the header, and VEDL Dec-25.
    let take = Math.round(remaining / perLot);
    if (take <= 0) take = 1;
    take = Math.min(take, Math.floor(gLeft / gLot));
    if (take <= 0) break;

    const held = Math.trunc(leg.lots);
    if (take >= lots) {
      actions.push(
        lots >= held
          ? { op: 'close', instrument: leg.instrument }
          : { op: 'resize', instrument: leg.instrument, targetLots: held - lots },
      );
      taken.push({ leg, lots });
      shed += lots * perLot;
      remaining -= lots * perLot;
      gLeft -= lots * gLot;
    } else {
      actions.push({ op: 'resize', instrument: leg.instrument, targetLots: held - take });
      taken.push({ leg, lots: take });
      shed += take * perLot;
      gLeft -= take * gLot;
      break; // at most one partial, and it ends the walk
    }
  }

  return { actions, taken, shed };
}

// ── 5. the recycle ──────────────────────────────────────────────────────────

export interface RecycleResult {
  readonly actions: ReadonlyArray<EngineAction>;
  /** `RuleState.rcCredit` after the DEPOSIT. The debit rides on `commit`. */
  readonly rcCredit: number;
  /** Rupees deposited this mark — `recycle_frac` of the loss just realized. */
  readonly credit: number;
  readonly commit: RecycleCommit | null;
}

export const NO_RECYCLE = (state: RuleState): RecycleResult => ({
  actions: [],
  rcCredit: state.rcCredit,
  credit: 0,
  commit: null,
});

/**
 * Rupees of LOSS an unwind package realized — `playbooks.py:2899-2928`.
 *
 * Read per leg off the mark the book already carries (`LegView.mtm`, which the
 * parity adapter maps from Python's `gross_mtm`) so "50% of the loss we just
 * took" is exact rather than an approximation off book P&L. A partial is
 * prorated by `take/lots`.
 *
 * `max(0, …)` per leg, not over the sum: a buy-back at a PROFIT funds nothing,
 * and a winning close must not become a reason to sell more — nor may it net
 * off a losing one in the same package.
 */
export function recycleLoss(taken: ReadonlyArray<UnwindTake>): number {
  let loss = 0;
  for (const t of taken) {
    const held = Math.trunc(t.leg.lots);
    if (!(held > 0) || !(t.lots > 0)) continue;
    loss += Math.max(0, -t.leg.mtm) * (Math.min(t.lots, held) / held);
  }
  return loss;
}

/**
 * Where the recycled premium is sold: this rule's OWN fresh-sell strike, pushed
 * out by whole steps until strictly BEYOND the nearest strike just bought back
 * — `playbooks.py:2931-2954`.
 *
 * Re-selling at or inside the leg just closed is a wash trade, not a shift.
 * `null` at the edge of the chain: there is no strike further out, so the mark
 * degrades to a plain unwind.
 *
 * Anchored on SPOT, never on the gk-anchor — Python's `:2942` reads `spot`, and
 * the bound this walk has to clear is a real strike on the book.
 */
export function recycleStrike(
  inputs: EngineInputs,
  optType: OptType,
  bound: ReadonlyArray<number>,
  strikesOut: number,
): number | null {
  const { chain } = inputs;
  const spot = chain.spot;
  let k = otmSellStrike(chain, nearestStrike(chain, spot), optType, spot, Math.trunc(strikesOut));
  if (!(k > 0)) return null;
  if (bound.length === 0) return k;
  const edge = optType === 'CE' ? Math.max(...bound) : Math.min(...bound);
  for (let i = 0; i < 8; i += 1) {
    if (optType === 'CE' ? k > edge : k < edge) return k;
    const next = nearestStrike(chain, optType === 'CE' ? k + chain.step : k - chain.step);
    if (next === k) return null;
    k = next;
  }
  return null;
}

/**
 * Re-sell `recycle_frac` of the loss the unwind just booked — `playbooks.py
 * :3761-3829`. See §4 of the file header for why the bank and the deferred
 * debit exist.
 *
 * The two arms differ only in WHICH SIDE and therefore in which direction the
 * room runs. The closed side's delta pushes toward the counter-trend edge; the
 * opposite side's toward the far edge. A mark that lands ON the near edge
 * therefore leaves the closed-side arm zero room — by geometry, not by a dial —
 * while the opposite-side arm may cross the whole band. Either way the book
 * ends inside ±`allowed`, never fully one-sided.
 *
 * `landed` is where the package ACTUALLY puts netΔ (the unwind's shed plus the
 * residual sale's whole lots), not where `applyTrendTarget` aimed: the gamma
 * floor can truncate the unwind and the sale rounds to lots, so the target is
 * not what the band should be measured against (user-directed 2026-08-03,
 * "recenter ±2%").
 */
export function applyRecycle(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  cor: Corridor,
  opts: {
    readonly taken: ReadonlyArray<UnwindTake>;
    /** The side phase R would SELL to shed. `recycle_opposite` sells this one. */
    readonly shedSide: OptType;
    /** The side the unwind bought back. The default arm re-sells this one. */
    readonly stackSide: OptType;
    /** The residual sale's strike, or null when no candidate priced. */
    readonly sellStrike: number | null;
    readonly sellLots: number;
    readonly sellDps: number;
    /** Delta shares the unwind removed. */
    readonly shed: number;
    readonly lotSize: number;
    /** `applyTrendTarget`'s `dir`. */
    readonly trendDir: number;
  },
): RecycleResult {
  const frac = dials.recycle_frac;
  if (!(frac > 0) || opts.taken.length === 0) return NO_RECYCLE(state);

  const bankOn = dials.recycle_bank;
  const credit = frac * recycleLoss(opts.taken);
  const bank0 = bankOn ? state.rcCredit : 0;
  const fund = bank0 + credit;
  // The deposit is written on EMIT and only when there IS one: Python guards
  // `credit > 0` so a profitable buy-back cannot rewrite the bank with itself.
  const rcCredit = bankOn && credit > 0 ? fund : state.rcCredit;
  const nothing: RecycleResult = { actions: [], rcCredit, credit, commit: null };
  if (!(fund > 0)) return nothing;

  const opposite = dials.recycle_opposite;
  const side = opposite ? opts.shedSide : opts.stackSide;
  // What the re-sell must sit beyond: the strike just bought back on the
  // closed-side arm, the residual sale's own strike on the opposite-side arm. A
  // mark with no residual sale has nothing to clear, so the crossfill simply
  // takes the rule's own fresh-sell strike.
  const bound = opposite
    ? opts.sellLots > 0 && opts.sellStrike !== null
      ? [opts.sellStrike]
      : []
    : opts.taken.map((t) => t.leg.strike);

  const k = recycleStrike(inputs, side, bound, dials.strikes_out);
  if (k === null) return nothing;

  const row = inputs.chain.strikes.find((s) => Math.abs(s.strike - k) <= 1e-6);
  const quote = row === undefined ? null : side === 'CE' ? row.ce : row.pe;
  // SIZING is a valuation, CANDIDACY is a gate, and the spec keeps them apart
  // (§6's "valuation vs candidacy split"). The bid is what a fresh sale would
  // actually collect and is therefore the honest basis — but a contract whose
  // bid has never been seen is a ONE-SIDED BOOK, and dropping the package there
  // is precisely the silent hold §6/§8 forbid: gate failure routes to a maker
  // quote at theoretical, never to nothing. So the sizing falls back to the
  // VALUATION price and the package still forms; whether we would cross it is
  // `phaseShed`'s candidacy row, not this one.
  const px = quote === null ? null : (sellPrice(quote, inputs.pricing) ?? midOf(quote));
  if (px === null || !(px > 0)) return nothing;

  const want = Math.trunc(fund / (px * opts.lotSize));
  // Where the whole package lands, in shares of netΔ, signed onto the trend.
  const moved = opts.shed + opts.sellLots * opts.sellDps * opts.lotSize;
  const landed = opts.trendDir * (cor.netDelta + opts.trendDir * moved);
  const room = Math.max(0, opposite ? cor.allowed - landed : cor.allowed + landed);

  const g = greekReader(inputs)(k, side);
  const perLot = g === null ? 0 : Math.abs(g.delta) * opts.lotSize;
  const lots = perLot > 0 ? Math.min(want, Math.floor(room / perLot)) : want;
  if (lots <= 0) return nothing;

  const spend = lots * px * opts.lotSize;
  return {
    actions: [{ op: 'open', strike: k, optType: side, side: 'Sell', lots }],
    rcCredit,
    credit,
    commit: bankOn
      ? { base: fund, value: fund - spend, lots, optType: side, strike: k }
      : null,
  };
}

// ── 6. the balance tier ─────────────────────────────────────────────────────

export interface BalanceResult {
  readonly actions: ReadonlyArray<EngineAction>;
  readonly reason: string;
}

/**
 * Rebuild a book that has lost a side — `playbooks.py:3578-3596`, and §5 of the
 * file header for the 879 marks that paid for it.
 *
 * Consulted ONLY from inside the convexity-floor branch: with both sides on the
 * book the floor's own claim is true and selling would just add risk. `null` is
 * "not my case", and the caller then holds as it did before.
 *
 * A CONSEQUENCE worth knowing before an operator turns two dials at once: with
 * `min_band_lots` or `no_band_floor` set there IS no convexity-floor branch, so
 * this tier is unreachable however a book is shaped — the band dials keep the
 * delta phase managing at every mark instead, which is a different answer to
 * the same problem rather than no answer. Python is the same shape and never
 * shipped a preset combining them, so this is undecided rather than wrong, and
 * it is the same standing as the sweep-vs-band-dial ruling in `shed.ts`'s
 * header. If an operator wants both, the floor branch is where the decision
 * goes.
 *
 * `dte > balance_min_dte`, strictly: rebuilding a side days before expiry buys
 * a naked short whose whole life is gamma. Anchored on SPOT — the missing side
 * is being re-established where the market is, not where a lagged anchor is.
 */
export function balanceTier(
  inputs: EngineInputs,
  dials: Dials,
  cor: Corridor,
): BalanceResult | null {
  if (!dials.balance_enabled) return null;
  const minDte = Math.trunc(dials.balance_min_dte);
  if (!(minDte > 0) || !(inputs.dte > minDte)) return null;

  const lots: Record<OptType, number> = { CE: 0, PE: 0 };
  for (const l of inputs.legs) {
    if (l.side === 'Sell') lots[l.optType] += Math.trunc(l.lots);
  }
  const missing = (['CE', 'PE'] as const).filter((ot) => lots[ot] <= 0);
  if (missing.length !== 1) return null;

  const side = missing[0];
  if (side === undefined) return null;
  const other = lots[side === 'CE' ? 'PE' : 'CE'];
  if (!(other > 0)) return null;

  const { chain } = inputs;
  const spot = chain.spot;
  const k = otmSellStrike(
    chain,
    nearestStrike(chain, spot),
    side,
    spot,
    Math.trunc(dials.strikes_out),
  );
  if (!(k > 0)) return null;

  const held = side === 'CE' ? 'PE' : 'CE';
  return {
    actions: [{ op: 'open', strike: k, optType: side, side: 'Sell', lots: other }],
    reason:
      `${other} lot(s) of ${held} only and no convexity left (allowance ` +
      `${Math.round(cor.allowed).toLocaleString('en-US')} under one lot) — sell ` +
      `${Math.round(k).toLocaleString('en-US')}${side} back on, matched to the live side`,
  };
}
