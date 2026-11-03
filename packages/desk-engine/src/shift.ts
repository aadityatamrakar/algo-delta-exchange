/**
 * PHASE S — THE MARGIN-GATED ITM SHIFT: move a short that price has run past
 * back to a strike keyed to SPOT, at the same size.
 *
 * `playbooks.py:3879-4027` (`recenter_shift`), phase 1. Every short at least
 * `shift_itm_steps` full strike steps INSIDE spot is closed and re-sold on a
 * strike anchored to spot — the ATM snap when `shift_land_steps` is 0, that many
 * steps beyond it otherwise. The landing strike does NOT depend on how deep the
 * leg is, which is the whole distinction from a roll: a roll moves a leg
 * relative to ITSELF and therefore never catches up with a trend, while this
 * re-centres the book on where price actually is. The measured lever, from the
 * 2026-07-29 exploration, is ITC −24.9L → −8.6L.
 *
 * ── 1. THE MARGIN GATE, AND WHY IT IS THE TRIGGER (`:3943-3958`) ────────────
 * The gate is `margin / margin_cap >= shift_margin_frac`, and the argument for
 * measuring MARGIN rather than P&L is that P&L cannot tell a normal drawdown
 * from a broken book — TCS draws down 13.9L in the ordinary course — while
 * margin can: at peak, ITC ran at 100% of its cap and BHEL at 93%, against TCS
 * 48% and LTF 29%. It is self-limiting by construction: shifting relieves
 * margin, which closes the gate.
 *
 * Three DIFFERENT off-states, and only one of them means "shift anyway":
 *
 *   - `shift_margin_frac` 0 — the GATE is absent, not the shifting. Python
 *     spells this `_mfrac > 0`, and it is what makes `recenter-atm` and
 *     `recenter-otm` shift at any margin at all (their `DEFAULTS` carry no
 *     fraction). A port that read 0 as "never arm" silently deletes two
 *     playbooks.
 *   - `margin_cap` 0 — an UNCAPPED book has no ceiling to be a fraction of, so
 *     the gate has no meaning and the safe reading is "do not shift". Python
 *     writes it `_cap > 0 and ...`, which is also what stops `mgn / 0`.
 *   - a margin figure we do not TRUST — new here, design spec §6, and the one
 *     branch with no Python counterpart. The Python desk steered this gate off
 *     whatever number was to hand, including the SPAN-lite model estimate, and
 *     on BHEL-2026-08-25 SPAN-lite said **20.8L where the broker said 42.9L** —
 *     a factor of 2.06 on the one quantity the gate is a fraction OF. A model
 *     or stale figure reading 90% of cap could be any true load whatsoever, and
 *     it may not arm a rule whose action is a fresh short SALE. So in
 *     `pricing: 'live'` the gate additionally requires `margin.fresh` from
 *     `source: 'broker'`; anything else holds the shift.
 *
 *     The freshness test is skipped in `pricing: 'parity'` because Python's ctx
 *     carried one `margin` float with no provenance at all (§12) — requiring a
 *     broker stamp there would make every recorded shift mark unreproducible,
 *     which is the opposite of what the fixtures are for.
 *
 *     NOT IMPLEMENTED HERE, deliberately: the spec's "two consecutive fresh
 *     broker reads" (§7). That is a DAMPING rule over a sequence of reads and
 *     this function sees exactly one `MarginInput`; counting it belongs with
 *     `confirm_ms` and `cooldown_s` in the supervisor, which is the only layer
 *     that has the previous read.
 *
 * ── 2. WHAT `rolledDelta` / `rolledGamma` ARE ───────────────────────────────
 * ADJUSTMENTS, not totals: what phase R must ADD to the corridor's `netDelta` /
 * `netGamma` so that it sizes off the book it is about to hold rather than the
 * one it is holding. Python keeps one running `nd`/`ng` and mutates it in place
 * (`:4008-4009`), which is the same arithmetic with the corridor's contribution
 * inlined; splitting it out is what lets `corridor()` stay a pure measurement of
 * the CURRENT book and phase R own the addition.
 *
 * Landing on ATM lands on peak gamma and the allowance is keyed to gamma, so a
 * phase R that sized off the pre-shift greeks would answer with a band that
 * belongs to strikes it just sold. Per leg, and with the leg's OWN figure as the
 * fallback when the chain cannot price the target — which cancels to a zero
 * adjustment rather than zeroing the book's convexity.
 *
 * ONE DIVERGENCE FROM PYTHON, and it is a narrowing: `_chain_greek` reads delta
 * and gamma from the chain row independently, so a row carrying a delta but no
 * gamma rolls the delta and falls back on the gamma. `strikeGreeks` is
 * both-or-null by design (`marking.ts` §2 — an unpriceable strike is not a
 * candidate, there is no `dps = 0.30` stand-in), so here a target that does not
 * solve falls back on BOTH. The fixtures carry both greeks on every row, so the
 * two agree over the recorded set.
 *
 * ── 3. `fired`, AND WHO SHORT-CIRCUITS ──────────────────────────────────────
 * `hedge_after_shift` false means a mark that just shifted returns WITHOUT
 * running the delta phase: the book's delta has already moved because its
 * strikes moved, and hedging the same mark is a second adjustment against one
 * move (`:4021-4027`). That decision is the ORCHESTRATOR's — this function
 * reports `fired` and the caller reads the dial — because the alternative is
 * phase S returning a "and also stop" flag that only one caller can honour.
 *
 * ── 4. PROTECTED QUANTITY IS EXEMPT AT SELECTION (`:2962-2967`) ─────────────
 * Never at the close. A shift is ATOMIC — close this strike, sell that one — so
 * dropping only the close half downstream leaves the fresh sell standing alone
 * and the book bigger than it was. Python's `K.unprotected` is a per-leg
 * BOOLEAN; `EngineInputs.protectedQty` is a QUANTITY per instrument, which can
 * express a leg the operator part-owns, and `guards.ts`'s `unprotectedLots`
 * nets it — ONE definition, shared with the scrap tier and the margin trim. A
 * partly-protected leg therefore shifts its spendable lots and RESIZES down to
 * the protected tail instead of closing.
 *
 * The greeks `rolledDelta`/`rolledGamma` roll only the MOVING portion, and the
 * corridor still counts every leg including the protected ones — a hedge that
 * did not count would steer the desk into re-hedging a position it already
 * holds (`corridor.ts` §2).
 *
 * STATELESS (`:3893`). `RuleState` is taken for uniformity with the other
 * phases and no field is read; a shift mark that mutated state would break the
 * fixture invariant `state_after == state` the parity harness asserts.
 *
 * PURE: no clock, no feed. `dateIst`/`minuteOfDay` ride in on `EngineInputs`.
 */
import { nearestStrike, otmSellStrike } from './corridor.ts';
import { unprotectedLots } from './guards.ts';
import { greekReader } from './marking.ts';
import type { Dials } from './dials.ts';
import type { EngineAction, EngineInputs, OptType, RuleState } from './types.ts';

/**
 * Phase S's whole answer.
 *
 * `actions` is ordered CLOSES/RESIZES first, then OPENS, so an executor that
 * gates on margin frees before it adds. The package is atomic either way — half
 * a shift is a naked short or a doubled one — but the order is the one that
 * survives a partial fill best.
 */
export interface ShiftResult {
  readonly actions: ReadonlyArray<EngineAction>;
  /** Add to `corridor().netDelta` to get the post-shift book. NOT a total. */
  readonly rolledDelta: number;
  /** Add to `corridor().netGamma` to get the post-shift book. NOT a total. */
  readonly rolledGamma: number;
  /** The shift produced orders. `hedge_after_shift` false + this = skip phase R. */
  readonly fired: boolean;
}

const NOTHING: ShiftResult = { actions: [], rolledDelta: 0, rolledGamma: 0, fired: false };

/**
 * Is the book loading enough margin — measured off a number we are entitled to
 * believe — for the shift to arm? See §1 of the header for all three off-states.
 */
function marginArmed(inputs: EngineInputs, dials: Dials): boolean {
  const frac = dials.shift_margin_frac;
  if (!(frac > 0)) return true; // the GATE is off; the shifting is not.

  const { margin } = inputs;
  if (inputs.pricing === 'live' && !(margin.fresh && margin.source === 'broker')) return false;

  const cap = dials.margin_cap;
  if (!(cap > 0)) return false; // uncapped: nothing to be a fraction of.
  return margin.value / cap >= frac;
}

/**
 * Phase S over one mark.
 *
 * `state` is unread — phase S is stateless; see the header. The caller supplies
 * it so every phase has the same shape.
 */
export function phaseShift(inputs: EngineInputs, dials: Dials, state: RuleState): ShiftResult {
  const { chain, legs, protectedQty, dte } = inputs;
  const spot = chain.spot;

  if (!dials.shift_enabled) return NOTHING;
  // K.spot fails soft to 0.0 and the engine consults on every mark. At spot 0
  // every short PE reads as infinitely ITM, so the whole put book would be
  // shifted to the bottom of the chain — and with the chain missing too, the
  // opens are dropped on no_mark while the closes still land, leaving the book
  // naked (`playbooks.py:3907-3913`). The parent holds here; so do we.
  if (!(spot > 0)) return NOTHING;

  // §4: protected quantity is netted at SELECTION, so a leg the operator wholly
  // owns is never a candidate and a partly-owned one carries only its spendable
  // lots into the scan. `unprotectedLots` is `guards.ts`'s single definition of
  // that rule (this file used to carry a second copy of it).
  const shorts = unprotectedLots(
    legs.filter((l) => l.side === 'Sell'),
    protectedQty,
  );
  if (shorts.length === 0) return NOTHING;

  // Skipped near expiry: a shift CONTAINS a fresh sell (`:3959-3960`).
  if (!(dte > Math.trunc(dials.min_sell_dte))) return NOTHING;
  if (!marginArmed(inputs, dials)) return NOTHING;

  const step = chain.step;
  const atm = nearestStrike(chain, spot);
  const land = Math.trunc(dials.shift_land_steps);
  // NOT clamped at 0, and Python does not clamp it either: a negative
  // `shift_itm_steps` gives a negative threshold and shifts OTM legs too. Range
  // is the dial resolver's job — coercing a nonsense value here would hide an
  // operator's typo behind arithmetic that silently kept working
  // (`corridor.ts`'s note on `delta_tol_pct` makes the same call).
  const need = dials.shift_itm_steps * step;
  const bookLot = shorts.find((l) => l.lotSize > 0)?.lotSize ?? chain.lotSize;

  const exits: EngineAction[] = [];
  const opens: { strike: number; optType: OptType; lots: number }[] = [];
  // (strike, optType) -> index into `opens`, so two ITM legs landing on the
  // same spot-anchored target merge into ONE order instead of two. Leg-relative
  // families never collide like this; a spot-anchored target routinely does
  // (`playbooks.py:4011-4018`). The merge sums LOTS and nothing else — Python's
  // merged order keeps the first leg's `lot_size`, and an `EngineAction` open
  // carries no lot size at all, so two legs of different contract sizes on one
  // strike would merge wrongly in BOTH. A book cannot hold two lot sizes on one
  // instrument, so the case does not arise; it would have to be an expiry mix,
  // which this engine does not manage.
  const slot = new Map<string, number>();
  // The landing strike's greeks come from `greekReader`, not from a bare
  // `strikeGreeks`: these two numbers are what phase R then sizes its package
  // off, so under `pricing: 'parity'` they must be the fixture's OWN chain rows
  // and not a Black-76 re-solve of them (`marking.ts`, `types.ts`'s
  // `strikeGreeksOverride`). The re-solve differs by −8.5% on gamma, which is
  // −8.5% on the band phase R measures against.
  const greeks = greekReader(inputs);
  let rolledDelta = 0;
  let rolledGamma = 0;

  for (const leg of shorts) {
    const k = leg.strike;
    if (!Number.isFinite(k)) continue;
    const ot = leg.optType;

    // SIGNED depth: an OTM leg gives a negative one and fails the test, so OTM
    // legs are never touched (`:3976-3980`).
    const depth = ot === 'CE' ? spot - k : k - spot;
    if (depth < need) continue;

    // `land <= 0` lands on the ATM snap ITSELF, with no strictly-OTM push —
    // recenter-atm sells the ATM strike even when the snap sits inside spot.
    // Routing this through `otmSellStrike` would push one step further and
    // diverge on every recenter-atm mark.
    const nk = land <= 0 ? atm : otmSellStrike(chain, atm, ot, spot, land);
    if (nk === k) continue;

    const lots = leg.steerableLots;
    const ls = leg.lotSize > 0 ? leg.lotSize : bookLot;
    const shares = lots * ls;

    // Roll BOTH greeks forward, per leg, over the MOVING portion only. The
    // contributions use corridor.ts's sign rule: delta takes the wing sign and
    // the position sign, gamma the position sign alone. `strikeGreeks` returns
    // the RAW wing-signed delta, so a short's new contribution is its negation
    // — which is Python's `-cd * lots * ls` exactly.
    const g = greeks(nk, ot);
    if (g !== null) {
      const wing = ot === 'CE' ? 1 : -1;
      const oldDelta = wing * -1 * leg.delta * shares;
      const oldGamma = -1 * leg.gamma * shares;
      const newDelta = -g.delta * shares;
      const newGamma = -g.gamma * shares;
      rolledDelta += newDelta - oldDelta;
      rolledGamma += newGamma - oldGamma;
    }

    const held = Math.trunc(leg.lots);
    exits.push(
      lots >= held
        ? { op: 'close', instrument: leg.instrument }
        : { op: 'resize', instrument: leg.instrument, targetLots: held - lots },
    );

    const key = `${nk}:${ot}`;
    const at = slot.get(key);
    const merged = at === undefined ? undefined : opens[at];
    if (at === undefined || merged === undefined) {
      slot.set(key, opens.length);
      opens.push({ strike: nk, optType: ot, lots });
    } else {
      opens[at] = { ...merged, lots: merged.lots + lots };
    }
  }

  const actions: EngineAction[] = [
    ...exits,
    ...opens.map((o): EngineAction => ({ op: 'open', strike: o.strike, optType: o.optType, side: 'Sell', lots: o.lots })),
  ];
  return { actions, rolledDelta, rolledGamma, fired: actions.length > 0 };
}
