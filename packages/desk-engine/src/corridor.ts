/**
 * THE CORRIDOR — how much delta this book is allowed to carry, and how much of
 * it is over.
 *
 * One function, six numbers, and every rule downstream steers off them. Phase S
 * asks whether the band was breached before it shifts; phase R sheds `excess`
 * and no more; the EOD sweep is this same arithmetic at `tol` 0. Getting it
 * wrong does not throw — it produces a plausible band and a book that is
 * steered, or left alone, for reasons nobody wrote down.
 *
 * The band itself is `|netΓ| x delta_tol_pct x spot` (`playbooks.py:4060`): the
 * delta a book of this convexity picks up over a `tol` move of the underlying.
 * It is a GAMMA measure on purpose — a book with convexity will re-acquire the
 * delta you shed, so shedding inside that distance is churn.
 *
 * ── 1. THE SIGNS ARE APPLIED HERE, NOT UPSTREAM ─────────────────────────────
 * `LegView.delta` and `LegView.gamma` are UNSIGNED per-share magnitudes
 * (`types.ts:80-81`, and the sign note in `marking.ts`'s header). Python's
 * marked legs were the opposite — `leg_greeks` returned `raw x sign x shares`
 * already folded in (`optimizer/legs.py:75-102`), so its net was a plain sum.
 * This file therefore re-applies both factors, and they are NOT the same factor:
 *
 *   delta contribution = wingSign(optType) x positionSign(side) x |δ| x shares
 *   gamma contribution =                     positionSign(side) x  γ  x shares
 *
 * Gamma has no wing: a call and a put at the same strike carry the SAME
 * positive convexity, so only the position sign survives. Delta has both, which
 * is why a short CE and a short PE of equal magnitude cancel while their gammas
 * add. Fold the wing into gamma and a strangle reads as flat convexity; drop
 * the position sign from delta and a hedged book reads as a naked one.
 *
 * `shares = lots x lotSize`; `lots` is always positive and `side` carries the
 * direction (`types.ts:89`). A futures hedge arrives as a typed leg kind,
 * `LegView.kind: 'future'` (shares too), and is Python's future leg exactly
 * (`book.py:223`):
 *
 *   delta contribution =                     positionSign(side) x shares
 *   gamma contribution = 0
 *
 * Its `delta`, `gamma` and `optType` fields are never read. It is MEASURED here
 * and nowhere else acts on it: `decide()` hands every other tier the option
 * legs alone. The desk's books carry no future leg.
 *
 * ── 2. WHICH LEGS ARE COUNTED (`playbooks.py:2957-3013`) ────────────────────
 * `delta_shorts_only` / `gamma_shorts_only` pick the population, and the two
 * dials do NOT mean the same thing — Python argues this at length and the
 * comment is worth keeping in front of you:
 *
 *   - `gamma_shorts_only` is the lesson of the deleted 5% move hedge (a
 *     measured -18.5L over 17 books, `:2960-2970`). A long wing carries
 *     POSITIVE gamma, so buying protection shrinks `|netΓ|`, which shrinks
 *     `allowed`, which makes the delta rule sell MORE. The protection quietly
 *     commands the steering. Reading short gamma only decouples them.
 *   - `delta_shorts_only` is a STRICTLY STRONGER claim (`:2986-3003`,
 *     user-directed 2026-08-12 off the live TCS-2026-08-25 book). A long leg's
 *     delta is not a distortion of the measurement — it is exposure the book
 *     actually has. Reading shorts only hedges a delta the book does not carry,
 *     and it errs in the direction that hurts: on a break down the long put
 *     gains negative delta fastest, so shorts-only reads the biggest number
 *     exactly when the true book is already partly hedged. Python shipped it
 *     anyway because on the live book it is the difference between shedding 2
 *     lots and 4.
 *
 * PROTECTED QUANTITY IS COUNTED, always. `inputs.protectedQty` is never read
 * here: a protected leg is "counted in everything that MEASURES the book —
 * marking, MTM, every net greek" and exempt only from what SPENDS a leg
 * (`conditions.py:51-85`). A hedge that did not count would steer the desk into
 * re-hedging a position it already holds.
 *
 * ── 3. `hasGreeks` REPLACES THE `netΓ == 0.0` SENTINEL (`:4063-4073`) ────────
 * Python guarded the band dials with `ng == 0.0`, reading an exact zero as "the
 * sim's missing-mark zero-fill, not a thin-but-honest book" and holding. That
 * conflates two different books: one whose greeks were never marked, and one
 * whose long and short convexity genuinely offset. The second is a real book
 * with a real (zero) band; the first is a hole in the data, and `no_band_floor`
 * on top of it would read the ENTIRE netΔ as excess and flatten the book on
 * missing marks.
 *
 * `marking.ts` already answers this honestly — a failed IV solve is
 * `hasGreeks: false`, never a zero and never the deleted `dps = 0.30` — so the
 * sentinel is deleted and the flag carries the claim. It is false when ANY leg
 * in EITHER population is unmarked, because a hole in the delta sum and a hole
 * in the gamma sum both poison the corridor. It is true for a genuinely flat
 * book, including an empty one: nothing was missed, there is simply nothing
 * there. The FLAT-BOOK hold belongs to the caller (`playbooks.py:3905-3906`),
 * as does the `spot <= 0` hold (`:3912-3913`) — at spot 0 the band is 0 and the
 * whole netΔ reads as excess, which is a flatten nobody asked for.
 *
 * ── 4. THE FLOOR, AND THE BOOKS THAT DIED UNDER IT (`:4030-4046`, `:4111-4116`)
 * `floorRef` is the finest delta a single tradeable lot can carry. Below it the
 * tolerance cannot be expressed in units the desk can sell, so phase R holds:
 * "no convexity to centre".
 *
 * The guard's own claim is TRUE and its consequences were not. On the live
 * TCS-2026-08-25-recenter-relief-r book (2026-08-12) a short 2440 PE sitting
 * 132 points ITM is synthetic stock — delta -0.835, almost no gamma — and the
 * long 2220 PE held against it cancelled most of what remained. netΓ -2.0
 * against a 225 lot gives an allowance of 92, and the floor then held the delta
 * phase silent ALL SESSION while the book carried netΔ +483 with its
 * zero-delta point 11.3% above spot. On **VEDL Dec-25** the same guard returned
 * "no convexity" for **879 of the remaining 911 marks** while spot rallied 12%
 * into four naked calls (`:3567-3577`) — the scrap tier had taken all six entry
 * legs and the unwind had drained the added PE, so the book had lost a side and
 * the rule abandoned it rather than rebuilding it.
 *
 * Three dials answer that, and this file owns two of them:
 *   - `min_band_lots` CLAMPS: `allowed = max(measured, mbl x lotSize)`. The rule
 *     keeps managing at every mark and collapsing gamma WIDENS the band instead
 *     of silencing the rule (`:4047-4051`).
 *   - `no_band_floor` FREES: the floor test is simply gone. It does not touch
 *     `allowed` — this file computes the same six numbers either way — because
 *     the test it removes is phase R's, not the corridor's.
 *   - `shed_scan_strikes` SHARPENS `floorRef` itself (below).
 *
 * ── 5. WHY `floorRef` SCANS (`:4075-4116`) ──────────────────────────────────
 * With the scan off, `floorRef` is one whole lot of the UNDERLYING — as if the
 * hedge were delta-1. It is not: a lot of a 0.30-delta option carries
 * `0.30 x lotSize` of delta, so the smallest increment the rule can actually
 * trade is `dps x lotSize`, and the floor was refusing to act on bands it could
 * in fact express, by a factor of 1/delta. On the live BHEL-2026-08-25 book
 * that is ~3.3x: band 1,675 against a 2,625 lot reads "no convexity to centre",
 * while one lot of the 405 PE it would actually sell is 788 delta-shares
 * against an excess of 746 — a 6% overshoot, entirely tradeable.
 *
 * Scanning OUTWARD is what makes this safe rather than merely looser: a
 * further-OTM strike carries LESS delta per lot, so it is FINER granularity,
 * not coarser. The cap is the point — user-directed 2026-08-12, "max 3 otm tak
 * dekhe … usse bahar ke strike nhi". Past that the premium is noise, the strike
 * is illiquid, and the sale stops being a hedge.
 *
 * Python's scan-off branch substituted `0.30` for an unpriceable strike
 * (`:4109`); that value never reached `floor_ref` (scan-off falls back to the
 * whole lot regardless) and it is deleted here with the rest of the constant —
 * an unsolvable strike is simply not a candidate (`marking.ts`, spec §5).
 *
 * The scan itself is `shed.ts`'s `shedCandidates` — the SAME walk phase R sizes
 * its package off, not a copy of it. That is deliberate and it is the one
 * import direction in this file that looks backwards: `floorRef` is defined as
 * "the finest lot among the strikes phase R would actually sell", so if the two
 * ever walked different ladders the floor would stop meaning what phase R
 * thinks it means, and it would do so silently. The strike geometry both need
 * (`nearestStrike`, `otmSellStrike`, `sellLotSize`) lives one level down in
 * `ladder.ts` so that shared use does not become a cycle.
 *
 * PURE: no clock, no feed. `dateIst`/`minuteOfDay` ride in on `EngineInputs`
 * so a fixture can replay a session that is long over.
 */
import type { Dials } from './dials.ts';
import { isFutureLeg, sellLotSize } from './ladder.ts';
import { greekReader } from './marking.ts';
import { shedCandidates } from './shed.ts';
import type { EngineInputs, LegView, OptType, Side } from './types.ts';

// The phase implementations were directed to import the strike geometry from
// THIS module, so it keeps answering to that name after the move to
// `ladder.ts` — same single definitions, re-exported, no cycle (`ladder.ts`
// imports nothing from here).
export { nearestStrike, otmSellStrike, sellLotSize } from './ladder.ts';

/**
 * The band, what is in it, and whether any of it can be believed.
 *
 * `excess` is `|netDelta| - allowed`: negative or zero is a book inside its
 * corridor. `floorRef` is the yardstick phase R compares `allowed` against —
 * this file computes it but does not apply it, because the two band dials
 * decide whether the comparison happens at all (`playbooks.py:4119`).
 */
export interface Corridor {
  readonly allowed: number;
  readonly netDelta: number;
  readonly netGamma: number;
  readonly hasGreeks: boolean;
  readonly floorRef: number;
  readonly excess: number;
  /**
   * The tolerance `allowed` was actually measured at — `delta_tol_pct` after
   * the `tol_ref_dte` shrink, NOT the dial.
   *
   * Exposed because the LIFO unwind's convexity floor is `lotSize / (tol ×
   * spot)` (`playbooks.py:3688`): the gamma at which the band is worth exactly
   * one lot. Recomputing it from the dial would ignore the near-expiry shrink
   * and let the unwind spend convexity the band no longer has, which is the
   * spiral `_rc_unwind`'s docstring measures at 7% → 46% of marks outside the
   * band. It is also what the EOD sweep sets to 0.
   */
  readonly tol: number;
}

/**
 * The legs a net greek is summed over: every leg, or the SHORT options only.
 *
 * `playbooks.py:2972-2980` / `:3005-3013` — both helpers walk `K.shorts(ctx)`,
 * which is `instrument == "option" and side == "sell"` (`conditions.py:32-33`),
 * so a short future is not a short. Protected legs are NOT excluded; see the
 * header.
 */
export function steeringPopulation(
  legs: ReadonlyArray<LegView>,
  shortsOnly: boolean,
): ReadonlyArray<LegView> {
  return shortsOnly ? legs.filter((l) => l.side === 'Sell' && !isFutureLeg(l)) : legs;
}

/** +1 for a call, -1 for a put — the sign a raw Black-76 delta carries and that
 * `LegView.delta` deliberately drops. Gamma never takes this. */
function wingSign(optType: OptType): number {
  return optType === 'CE' ? 1 : -1;
}

/** +1 long, -1 short (`optimizer/legs.py:96` `scale = sign * sh`). */
function positionSign(side: Side): number {
  return side === 'Sell' ? -1 : 1;
}

/**
 * The book's corridor at this mark.
 *
 * Measurement only: nothing here holds, sheds or shifts. The caller owns the
 * flat-book and `spot <= 0` guards, the convexity-floor comparison and the
 * cooldown — see the header for why each of those lives there rather than here.
 */
export function corridor(inputs: EngineInputs, dials: Dials): Corridor {
  const { chain, legs, dateIst, minuteOfDay, dte } = inputs;
  const spot = chain.spot;

  const deltaPop = steeringPopulation(legs, dials.delta_shorts_only);
  const gammaPop = steeringPopulation(legs, dials.gamma_shorts_only);

  // A future leg is `sign x shares` of delta and no gamma (§1).
  let netDelta = 0;
  for (const l of deltaPop) {
    netDelta += isFutureLeg(l)
      ? positionSign(l.side) * l.lots * l.lotSize
      : wingSign(l.optType) * positionSign(l.side) * l.delta * l.lots * l.lotSize;
  }
  let netGamma = 0;
  for (const l of gammaPop) {
    if (isFutureLeg(l)) continue;
    netGamma += positionSign(l.side) * l.gamma * l.lots * l.lotSize;
  }

  const marked = (pop: ReadonlyArray<LegView>) => pop.every((l) => l.hasGreeks);
  const hasGreeks = marked(deltaPop) && marked(gammaPop);

  // ---- near-expiry: stop the band inflating (`playbooks.py:3535-3549`) -----
  // ATM gamma ~ 1/(S x iv x sqrt(T)), so a FIXED tol makes the band grow like
  // 1/sqrt(T): it widens into expiry and calls a book carrying many times the
  // delta "inside tolerance" — precisely where gamma makes that delta most
  // dangerous. Measured over the 17-book board: median allowance 2,919 at
  // dte>10 against 31,218 at dte 3, with median |netΔ| carried 1,327 against
  // 57,531. Scaling by sqrt(dte/ref) cancels the 1/sqrt(T) exactly. It NEVER
  // widens past the dial, and Python's `0 < dte` guard means the expiry
  // session keeps the full tolerance rather than collapsing to nothing.
  //
  // NOT clamped at 0, deliberately: a negative `delta_tol_pct` gives a negative
  // band and reads every book as breached, and Python does the same. Range is
  // the dial resolver's job — coercing a nonsense value here would hide an
  // operator's typo behind arithmetic that silently kept working.
  let tol = dials.delta_tol_pct;
  const ref = Math.trunc(dials.tol_ref_dte);
  if (ref > 0 && dte > 0 && dte < ref) tol *= Math.sqrt(dte / ref);

  // The first SHORT option leg's lot, else the chain's (`playbooks.py:3929`; see
  // `ladder.ts` for why the 1.0 fallback is not ported). Shared with phase R
  // rather than restated: `floorRef` is a delta-per-LOT and the sizing that
  // compares against it is a lot count.
  const lotSize = sellLotSize(legs, chain);

  const measured = Math.abs(netGamma) * tol * spot;
  const mbl = dials.min_band_lots;
  const allowed = mbl > 0 ? Math.max(measured, mbl * lotSize) : measured;

  // The side whose SALE reduces |netΔ| — short CE sheds +delta, short PE sheds
  // -delta (`playbooks.py:4102`; netΔ 0 takes the PE branch, as it does there).
  const shedSide: OptType = netDelta > 0 ? 'CE' : 'PE';
  const scan = Math.trunc(dials.shed_scan_strikes);
  // Anchored on SPOT, always — never on the gk-anchor EMA phase R may sell
  // from. `floorRef` answers "can this band be expressed in tradeable units at
  // all", which is a property of the ladder and not of where a lagged anchor
  // happens to be pointing; and Python's `recenter`, the only arm that HAS an
  // anchor, never computes a `floor_ref` at all (`:3567` compares the whole
  // lot). The greek reader is `EngineInputs`', so a parity replay measures the
  // floor off the same rows phase R sizes off (`marking.ts`'s `greekReader`).
  const cands =
    scan > 0
      ? shedCandidates(chain, shedSide, spot, scan, dateIst, minuteOfDay, {
          greeks: greekReader(inputs),
        })
      : [];
  const finest = cands.reduce((a, c) => (c.dps < a ? c.dps : a), Infinity);
  const floorRef = cands.length > 0 ? finest * lotSize : lotSize;

  return {
    allowed,
    netDelta,
    netGamma,
    hasGreeks,
    floorRef,
    excess: Math.abs(netDelta) - allowed,
    tol,
  };
}
