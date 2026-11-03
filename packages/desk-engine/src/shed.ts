/**
 * PHASE R — the sale that brings the book back inside its corridor, and the
 * three ways the Python desk got it wrong.
 *
 * `corridor.ts` answers how far over the band the book is. This file answers
 * what to sell, how much of it, and — new here — whether the strike it picked
 * has a book worth crossing. Every number it emits becomes a real order, so
 * each of the three defects below cost money in a way the logs did not show.
 *
 * ── 1. A NUMBER NOBODY MEASURED, SIZED LIKE ONE THAT WAS (`dps = 0.30`) ─────
 * Python had no greek for a strike it wanted to sell, so it substituted a
 * constant: `dps = abs(sd) if sd else 0.30` (`playbooks.py:3711`, `:4109`,
 * `:4857`; `default_dps: float = 0.30` at `:2822`). The package was then sized
 * off that constant as if it had been measured — a strike whose IV would not
 * solve sold exactly like a real 30-delta one, and the resulting lots were an
 * arithmetic fiction.
 *
 * The dated cost of exactly this class of error is the **ITC 2026-07-31
 * runaway** (`tests/test_desk_driver.py:440-450`, `tests/test_desk_translate.py
 * :231-253`). There the unmeasured object was a leg rather than a strike: a
 * null-strike leg priced at 0.0 with zeroed greeks, so the delta the rule saw
 * did not move when the shed filled. The rule was handed the same net delta on
 * the next mark and **shed again, roughly every thirty seconds — six lots for
 * the one the bridge actually booked.** The lesson generalises: a number the
 * engine did not measure must never enter sizing, because the feedback loop
 * that would catch it is the same number.
 *
 * So `shedCandidates` EXCLUDES an unsolvable strike (`marking.ts`'s
 * `strikeGreeks` returns `null`, with no fallback — spec §5) and `bestFit`
 * sizes only off real per-share deltas. A strike that cannot be priced is not
 * a candidate; if none is, the phase says so out loud (§4 below).
 *
 * ── 2. PLAIN ROUND, NEVER `max(1, …)` (`playbooks.py:3710-3715`) ────────────
 * Python is explicit and it is worth quoting: "Plain round, NOT max(1, ...):
 * the rule is consulted at every mark, so rounding up would fire on
 * essentially every mark past the tolerance. A sub-one-lot excess emits
 * nothing; being stateless, it simply accumulates."
 *
 * `bestFit` therefore returns `null` on a sub-one-lot excess and the phase
 * holds. That hold is a DECISION, not a failure — see `sheddable` below.
 *
 * ── 3. BEST FIT, NOT NEAREST STRIKE (`:4127-4141`) ──────────────────────────
 * The winner is the candidate whose whole-lot shed lands closest to the
 * excess, which is routinely the FURTHEST strike in range: a further-OTM lot
 * carries less delta, so it is finer granularity, not coarser. That is the
 * point of the outward scan (`shed_scan_strikes`, user-directed 2026-08-12,
 * "max 3 otm tak dekhe … usse bahar ke strike nhi") and the cap of 3 is the
 * safety on it — past that the premium is noise and the sale is a lottery
 * ticket sold for the arithmetic's convenience.
 *
 * Ties break toward the NEARER strike, where the premium and the liquidity
 * are: `shedCandidates` is nearest-first and the comparison is strict, so the
 * first of an equal pair keeps the win (Python's `min` does the same).
 *
 * ── 4. THE LIQUIDITY GATE, AND WHAT `sheddable` MEANS ───────────────────────
 * NEW here, from design spec §6: a strike is a candidate to SELL only if its
 * book is two-sided, its spread is within `sell_max_spread_pct` and it was
 * last seen within `quote_max_age_ms`. Python had no such gate and crossed
 * whatever the chain offered.
 *
 * The gate is `pricing: 'live'` ONLY. Parity replays Python's decisions
 * number-for-number off fixtures that carry no book at all, so applying it
 * there would re-price every committed board (spec §12).
 *
 * Gate failure NEVER becomes a silent hold (spec §6): the phase still sizes
 * the sale it wanted and returns `sheddable: false`, and the supervisor routes
 * that same action as a maker quote at Black-76 theoretical, passive, alerting
 * (spec §8; Task 15). Hence the precise meaning of the flag:
 *
 *   `sheddable: false` says **phase R passed every hold gate and still could
 *   not put its sale on a book it would cross.** It never appears on a hold
 *   decided by the book's own numbers — flat, no spot, unmarked greeks, inside
 *   the band, under the convexity floor, too near expiry, or an excess smaller
 *   than one lot everywhere. It appears when the excess is real, the phase
 *   wants to sell, and the CHAIN is what failed: no strike priced, or none of
 *   the priced ones has a book we would cross. `actions` still carries the
 *   intended sell whenever one could be sized, and is empty only when no
 *   strike priced at all — then there is nothing to quote either.
 *
 * A caller that ignores the flag and routes `actions` crosses a book the gate
 * refused. That is why the flag is returned beside the actions rather than
 * suppressing them: suppressing would turn a wide market into the silent hold
 * the spec forbids.
 *
 * ── 5. THE FLOOR, AND WHY IT IS APPLIED HERE ────────────────────────────────
 * `corridor.ts` computes `floorRef` but deliberately does not test against it,
 * because the two band dials decide whether the test happens at all
 * (`playbooks.py:4119`). The test is phase R's, so it is here — with the
 * measured cost of the guard in the test file beside it: the live TCS
 * relief-r book held silent all session at netΔ +483, and VEDL Dec-25 answered
 * "no convexity" for 879 of its 911 remaining marks while spot rallied 12% into
 * four naked calls (`:3567-3577`, `:4030-4046`).
 *
 * The `netΓ == 0.0` sentinel Python guarded this with is DELETED: it read a
 * genuinely flat book and an unmarked one as the same thing. `cor.hasGreeks`
 * carries the claim instead, and it holds the phase unconditionally rather
 * than only under the band dials — a hole in the marks poisons `netDelta` and
 * `allowed` alike, whatever the dials say.
 *
 * PURE: no clock, no feed. The corridor arrives as an argument so the composer
 * can hand phase R the POST-shift band (`shift.ts` rolls the greeks forward),
 * and `nowMs` rides in on `EngineInputs` so a fixture can age a quote against a
 * session that is long over.
 */
import type { Corridor } from './corridor.ts';
import type { Dials } from './dials.ts';
import { nearestStrike, otmSellStrike, sellLotSize } from './ladder.ts';
import { greekReader, strikeGreeks } from './marking.ts';
import {
  applyAnchor,
  applyConfirm,
  applyEodSweep,
  applyRecycle,
  applyTrendTarget,
  balanceTier,
  lifoUnwind,
} from './tiers.ts';
import type {
  ChainSnap,
  EngineAction,
  EngineInputs,
  OptType,
  RecycleCommit,
  RuleState,
  StrikeGreekReader,
} from './types.ts';

/** A strike we could sell, and what one share of it would shed. `dps` is an
 * unsigned per-share magnitude — `strikeGreeks` signs its delta by wing, and
 * sizing has always taken `abs` (Python's `abs(sd)`). */
export interface ShedCandidate {
  readonly strike: number;
  readonly dps: number;
}

/** Where a candidate scan starts and what prices it — both defaulted, so the
 * common call reads as it always did. `atm` is the gk-anchor's snap when that
 * arm is on (`playbooks.py:3636`), `greeks` the parity override
 * (`marking.ts`'s `greekReader`). */
export interface ScanOptions {
  readonly atm?: number;
  readonly greeks?: StrikeGreekReader;
}

/** What phase R decided, and whether the market will take it. See §4 of the
 * header for the exact meaning of `sheddable` — it is not "did anything
 * happen". */
export interface ShedResult {
  readonly actions: EngineAction[];
  readonly reason: string;
  readonly sheddable: boolean;
  /**
   * `RuleState` after the mark: the anchor EMA (advanced on holds too), the
   * session the EOD sweep consumed, the breach streak, and the recycle bank's
   * DEPOSIT. Return it even from a hold — three of those four move on marks
   * that do nothing, and that is the whole reason they are state.
   */
  readonly stateAfter: RuleState;
  /**
   * The same mark's state WITHOUT this pass's acting deltas — the anchor EMA
   * and the breach streak, and none of the recycle deposit, the emit-reset, or
   * the EOD day stamp, all three of which only make sense if the package is
   * really sent (see `marked`, where the stamp comes back out).
   *
   * `EngineDecision.markState` is built from this: the supervisor damps, drops
   * and gets refused, and on those paths the mark still has to count (see that
   * field). Identical to `stateAfter` on every hold, by construction.
   */
  readonly markState: RuleState;
  /**
   * The recycle bank's DEBIT, deferred: the sale it pays for has not happened
   * yet and the caller's gates may drop or downsize it (`tiers.ts` §4).
   */
  readonly creditCommit: RecycleCommit | null;
}

/**
 * The strictly-OTM sell strikes from 1 to `scan` steps out, nearest first,
 * deduplicated, each with the per-share delta a sale of it would shed —
 * `playbooks.py:2683-2712`.
 *
 * Deduplicated because `otmSellStrike` pushes outward until strictly OTM, so
 * two different `strikesOut` can snap to the same real strike on a coarse grid;
 * scoring one candidate twice would just bias the pick.
 *
 * A strike whose IV does not solve is EXCLUDED rather than defaulted — Python's
 * `dps > 0` filter with the `0.30` fallback deleted (header §1). So is a strike
 * that solves to a zero delta: selling it sheds nothing and `bestFit` would
 * divide by it.
 *
 * The anchor is `nearestStrike(spot)`, which is what `recenter_shift`'s phase 2
 * uses (`:3931`). `recenter`'s own shed anchors on the gk-anchor EMA instead
 * (`:3636`); when that arm is ported (Task 9) it needs the anchor as a
 * parameter — `otmSellStrike` already takes `atm` and `spot` separately, so an
 * anchored strike can never be sold ITM.
 *
 * NO liquidity gate here, deliberately: `corridor.ts` computes `floorRef` off
 * this same walk, and a floor that moved with the spread would make the
 * convexity hold depend on how wide the book happened to be at that instant.
 * Candidacy is `phaseShed`'s (header §4).
 */
export function shedCandidates(
  chain: ChainSnap,
  side: OptType,
  spot: number,
  scan: number,
  dateIst: string,
  minuteOfDay: number,
  opts: ScanOptions = {},
): ReadonlyArray<ShedCandidate> {
  const out: ShedCandidate[] = [];
  const seen = new Set<number>();
  const atm = opts.atm ?? nearestStrike(chain, spot);
  const greeks =
    opts.greeks ?? ((k: number, ot: OptType) => strikeGreeks(chain, k, ot, dateIst, minuteOfDay));
  const last = Math.trunc(scan);
  for (let n = 1; n <= last; n += 1) {
    const k = otmSellStrike(chain, atm, side, spot, n);
    if (!(k > 0) || seen.has(k)) continue;
    seen.add(k);
    const g = greeks(k, side);
    if (g === null) continue;
    const dps = Math.abs(g.delta);
    if (dps > 0) out.push({ strike: k, dps });
  }
  return out;
}

/**
 * The candidate whose whole-lot shed lands closest to `excess`, or `null` when
 * no candidate reaches one lot — `playbooks.py:4127-4141`, sized by `:3710-3715`.
 *
 * `Math.round`, never `max(1, …)`: header §2. The one divergence from Python
 * worth naming is the rounding rule at an exact half — Python's `round()` is
 * banker's (half to even), JS is half away from zero. `excess / (dps * lotSize)`
 * landing exactly on `.5` is not reachable off a solved greek, and half-up errs
 * toward shedding slightly more, which is the safe direction for a book that is
 * already past its band.
 *
 * Ties keep the FIRST candidate because the comparison is strict and
 * `shedCandidates` is nearest-first (header §3).
 */
export function bestFit(
  cands: ReadonlyArray<ShedCandidate>,
  excess: number,
  lotSize: number,
): { strike: number; lots: number } | null {
  if (!(lotSize > 0) || !Number.isFinite(excess)) return null;
  let best: { strike: number; lots: number } | null = null;
  let bestMiss = Infinity;
  for (const c of cands) {
    if (!(c.dps > 0)) continue;
    const perLot = c.dps * lotSize;
    const lots = Math.round(excess / perLot);
    if (!Number.isFinite(lots) || lots <= 0) continue;
    const miss = Math.abs(lots * perLot - excess);
    if (miss < bestMiss) {
      bestMiss = miss;
      best = { strike: c.strike, lots };
    }
  }
  return best;
}

/** Why a strike is not one we would cross right now — the string goes into the
 * decision reason, so it names the measurement, not the verdict. */
type Candidacy = { readonly ok: true } | { readonly ok: false; readonly why: string };

const PASS: Candidacy = { ok: true };

/**
 * Would we cross this strike's book to sell it? Design spec §6's candidacy row.
 *
 * The row lookup carries `marking.ts`'s strike tolerance for the same reason it
 * does — a strike reached by arithmetic can land on 2439.999999999999 — though
 * it cannot bite here: every candidate strike came OUT of a chain row via
 * `nearestStrike`, so the match is exact.
 *
 * Neither dial has a numeric off-state (`dials.ts` §5 lists the ones that do,
 * and these are not among them), so a non-positive value is not "gate off" — it
 * is a gate nothing can pass, and it says so. Reading it the other way would
 * let one mistyped dial cross any book at all, silently; this way the book
 * routes to a maker quote and the reason names the dial.
 */
function sellable(
  chain: ChainSnap,
  strike: number,
  optType: OptType,
  dials: Dials,
  nowMs: number,
): Candidacy {
  const row = chain.strikes.find((s) => Math.abs(s.strike - strike) <= 1e-6);
  const quote = row === undefined ? null : optType === 'CE' ? row.ce : row.pe;
  if (quote === null) return { ok: false, why: 'no book' };
  const { bid, ask } = quote;
  if (bid === null || ask === null) return { ok: false, why: 'one-sided book' };

  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return { ok: false, why: 'no price' };
  const maxSpread = dials.sell_max_spread_pct;
  if (!(maxSpread > 0)) {
    return { ok: false, why: 'sell_max_spread_pct is not a positive fraction — no strike can pass' };
  }
  const spread = (ask - bid) / mid;
  if (spread > maxSpread) return { ok: false, why: `spread ${pct(spread, 1)}` };

  const maxAge = dials.quote_max_age_ms;
  if (!(maxAge > 0)) {
    return { ok: false, why: 'quote_max_age_ms is not a positive age — no strike can pass' };
  }
  // A quote stamped in the future is a clock, not a stale book: age is negative
  // and passes. Feed death is `md.health`'s to catch, not this gate's.
  const age = nowMs - quote.asOf;
  if (age > maxAge) return { ok: false, why: `${(age / 1000).toFixed(0)}s stale` };
  return PASS;
}

/**
 * Phase R: shed the excess, or say precisely why the book is not shedding.
 *
 * `cor` is a parameter rather than recomputed so the composer can hand this the
 * POST-shift corridor — phase S moves strikes, which moves both net greeks, and
 * hedging a mark off the PRE-shift band is a second adjustment against one move
 * (`playbooks.py:4022-4027`; the largest single lever in the 2026-07-29
 * exploration, ITC −24.9L → −8.6L).
 *
 * ── THE SIX TIERS COMPOSE HERE, IN PYTHON'S ORDER (`:3492-3876`) ────────────
 * This function is now the union of BOTH Python entry points: `recenter_shift`'s
 * phase 2 (`:4029-4163`, the band dials and the shed scan) and `recenter` itself
 * (`:3435-3876`, the six tiers). Python keeps them as separate copies of the
 * same arithmetic, which is why `gamma_shorts_only` was silently inert on the
 * whole relief family for weeks (`:3922-3925`). Here there is one path and
 * `tiers.ts` supplies the parts, each behind its own dial.
 *
 * The ORDER is load-bearing at four points and each one is a real Python bug
 * report:
 *
 *   1. THE ANCHOR EMA AND THE EOD ARM RUN BEFORE THE HOLD GUARDS. An EMA
 *      sampled only when the rule acts is not an EMA of spot (`:3510-3512`),
 *      and the sweep consumes the session whether or not the sale survives
 *      (`:3470-3474`). Both therefore appear in `stateAfter` on a hold.
 *   2. THE SWEEP OUTRANKS THE CONVEXITY FLOOR (`:3567`, `not eod and …`). At
 *      tolerance 0 the allowance is 0 by construction and the floor has nothing
 *      to say — and a book with no convexity left is exactly the one whose
 *      overnight gap risk most wants flattening.
 *   3. THE BREACH STREAK IS MAINTAINED BEFORE THE IN-BAND RETURN (`:3603-3612`)
 *      so an in-band mark genuinely resets it, and is zeroed on EMIT rather
 *      than on execution.
 *   4. THE UNWIND SIZES THE SALE, NOT THE OTHER WAY ROUND (`:3689-3715`). The
 *      residual `remaining = budget − shed` is what the candidate scan is
 *      sized against; sizing the sale off the raw excess and then unwinding
 *      would sell the other side with the rule's own legs sitting right there.
 *
 * The remaining branch order is Python's too: the flat-book and `spot <= 0`
 * holds first (`:3905-3913`), then the convexity floor, the band, the
 * near-expiry sell ban, and only then the candidate scan (`:4111-4159`). Put
 * the floor ahead of the flat-book guard and an EMPTY book answers "no
 * convexity to centre" — true, and useless — because a flat book measures a
 * zero band against a whole lot. Put the scan ahead of the holds and a book
 * that was never going to sell still pays for an IV solve per strike.
 *
 * ONE COMBINATION PYTHON NEVER HAD: an EOD sweep on a book that also carries a
 * band dial. `min_band_lots` is a floor UNDER the tolerance and the sweep sets
 * the tolerance to 0, so the two contradict each other. The sweep wins — it is
 * the more specific instruction, it fires once a day, and a clamp that survived
 * it would leave the book carrying `mbl` lots of delta overnight, which is the
 * one thing `eod_flat_min` exists to prevent.
 */
export function phaseShed(
  inputs: EngineInputs,
  dials: Dials,
  state: RuleState,
  cor: Corridor,
): ShedResult {
  const { chain, legs, dateIst, minuteOfDay, dte, nowMs, pricing } = inputs;
  const spot = chain.spot;
  // A hold emits nothing, so its mark state IS its state: there is no acting
  // delta to leave out.
  const hold = (st: RuleState, reason: string): ShedResult => ({
    actions: [],
    reason,
    sheddable: true,
    stateAfter: st,
    markState: st,
    creditCommit: null,
  });

  // ---- the guards `corridor.ts` deliberately left to its caller ------------
  // A flat book has nothing to steer, and at spot 0 the band is 0 and the whole
  // netΔ reads as excess — a flatten nobody asked for (`playbooks.py:3905-3913`).
  // Python holds on the flat book BEFORE it touches state (`:3494`), so this one
  // guard returns the state it was handed.
  if (legs.length === 0) return hold(state, 'flat book');

  // ---- the two tiers that move on every mark, holds included (§1 above) ----
  const anchored = applyAnchor(inputs, dials, state);
  const sweep = applyEodSweep(inputs, dials, state);
  const armed: RuleState = {
    ...state,
    gkAnchor: anchored.gkAnchor,
    rcEodDay: sweep.rcEodDay,
  };

  if (!(spot > 0)) return hold(armed, 'no spot');
  if (!cor.hasGreeks) {
    return hold(
      armed,
      'the steering book is not fully marked — holding the delta phase rather ' +
        'than sizing off a hole in the greeks',
    );
  }

  // The sweep IS the corridor at tolerance 0: same book, same greeks, no band.
  // Derived rather than recomputed because nothing else in `corridor()` depends
  // on `tol` — `floorRef` is a property of the ladder, and the two nets are the
  // book's (`playbooks.py:3530-3531`).
  const band: Corridor = sweep.armed
    ? { ...cor, tol: 0, allowed: 0, excess: Math.abs(cor.netDelta) }
    : cor;

  const { netDelta: nd, netGamma: ng, allowed, floorRef, excess } = band;
  const scan = Math.trunc(dials.shed_scan_strikes);
  const lotSize = sellLotSize(legs, chain);
  // The side whose SALE reduces |netΔ| — short CE sheds +delta, short PE sheds
  // -delta (`:4102`; netΔ 0 takes the PE branch, as it does there).
  const side: OptType = nd > 0 ? 'CE' : 'PE';

  // ---- the convexity floor (`:3567-3599`, `:4111-4125`) -------------------
  // EITHER band dial removes the test outright (`:4119` is one condition, not
  // two behaviours): both are the operator saying "manage this book's delta
  // whatever is or is not supplying its convexity", and the floor is the only
  // thing that would refuse. So does the EOD sweep (§2 above). The wording stays
  // conditional on the scan because the scan-off line is the one every committed
  // board carries — adding the dial must not silently rewrite recorded history
  // (`:4121-4125`).
  const bandDials = dials.min_band_lots > 0 || dials.no_band_floor;
  if (!sweep.armed && !bandDials && allowed < floorRef) {
    // A book that has LOST a side is REBUILT here rather than abandoned — the
    // guard below is right only while both sides are still on (`tiers.ts` §5).
    const rebuild = balanceTier(inputs, dials, band);
    if (rebuild !== null) {
      // The rebuild is a FRESH SELL, so it answers to the same candidacy row as
      // phase R's own (§4): Python crossed whatever the chain offered, and the
      // spec does not exempt a tier from that because it is a different tier.
      // The action still stands — gate failure is a maker quote, never a silent
      // hold — and `sheddable` is what says which.
      const open = rebuild.actions.find((a) => a.op === 'open');
      const verdict =
        pricing === 'live' && open !== undefined && open.op === 'open'
          ? sellable(chain, open.strike, open.optType, dials, nowMs)
          : PASS;
      return {
        actions: [...rebuild.actions],
        reason: uncrossable(
          `balance: ${rebuild.reason}`,
          verdict.ok ? null : `that book is not one we would cross (${verdict.why})`,
        ),
        sheddable: verdict.ok,
        stateAfter: armed,
        // The balance tier banks nothing and bans nothing: its state IS the
        // mark's bookkeeping, whether or not the rebuild is routed.
        markState: armed,
        creditCommit: null,
      };
    }
    const yardstick =
      scan > 0
        ? `${n0(floorRef)} — the finest lot within ${scan} strikes`
        : `${n0(floorRef)}`;
    return hold(
      armed,
      `netΓ ${f1(ng)} — allowance ${n0(allowed)} under one lot (${yardstick}); ` +
        'no convexity to centre',
    );
  }

  // ---- the breach streak (§3 above; `:3603-3621`) --------------------------
  const confirm = applyConfirm(dials, armed, excess > 0);
  const counted: RuleState = { ...armed, gkStreak: confirm.streak };

  if (excess <= 0) {
    return hold(
      counted,
      `netΔ ${f0(nd)} inside allowed ${n0(allowed)} ` +
        `(|netΓ| ${Math.abs(ng).toFixed(1)} at spot ${spot.toFixed(1)})`,
    );
  }
  if (!confirm.confirmed) {
    return hold(
      counted,
      `netΔ ${f0(nd)} past allowed ${n0(allowed)}, but the breach is ` +
        `${confirm.streak}/${Math.trunc(dials.confirm_marks)} marks old — unconfirmed`,
    );
  }
  // A shed contains a fresh SELL, and near expiry there are none. The sweep does
  // not override this one — `min_sell_dte` still holds (`:3469-3470`).
  if (dte <= Math.trunc(dials.min_sell_dte)) {
    return hold(counted, `dte ${dte} — no fresh sells, holding every strike to expiry`);
  }

  // ---- how far to shed, and what the stack can cover of it -----------------
  const trend = applyTrendTarget(dials, nd, allowed, excess);
  const stackSide: OptType = side === 'CE' ? 'PE' : 'CE';
  // No `unwind_enabled` guard here: `lifoUnwind` owns its own toggle, and one
  // dial read in two places is one that eventually disagrees with itself.
  const unwind = lifoUnwind(inputs, dials, counted, band, {
    stackSide,
    budget: trend.budget,
    lotSize,
  });
  const remaining = Math.max(0, trend.budget - unwind.shed);

  // ---- the candidates -----------------------------------------------------
  // Scan on: 1…`shed_scan_strikes` steps out. Scan off: the single fixed
  // `strikes_out` strike, exactly as every committed board traded (`:4106-4109`)
  // — minus the `0.30` stand-in, so an unpriceable strike leaves the set empty.
  // Anchored on the gk-anchor EMA, which is spot with that dial off (`:3636`);
  // `otmSellStrike` still takes spot separately, so an anchored strike can never
  // be sold ITM.
  const scanOpts: ScanOptions = { atm: nearestStrike(chain, anchored.anchor), greeks: greekReader(inputs) };
  const cands =
    scan > 0
      ? shedCandidates(chain, side, spot, scan, dateIst, minuteOfDay, scanOpts)
      : fixedCandidate(chain, side, spot, dials.strikes_out, dateIst, minuteOfDay, scanOpts);
  // What the reason calls the place we looked: the scanned range, or — with the
  // scan off — the ONE strike, by name, so an operator can go and look at it
  // (`:4143-4145`). Naming only the distance would make the commonest hold the
  // least actionable line in the journal.
  const first = cands[0];
  const where =
    scan > 0
      ? `any strike within ${scan} of ATM`
      : first !== undefined
        ? `${n0(first.strike)}${side}`
        : `${Math.trunc(dials.strikes_out)} steps out`;

  // ---- candidacy: would we cross what we picked? (`'live'` only) ----------
  // A gate DIAL that nothing can satisfy is one fact about the book, not one
  // fact per strike: said per candidate it buries the actual cause under three
  // copies of itself. `sellable` still answers per strike — this only decides
  // how the reason says it.
  const dialFault =
    pricing !== 'live'
      ? null
      : !(dials.sell_max_spread_pct > 0)
        ? 'sell_max_spread_pct is not a positive fraction'
        : !(dials.quote_max_age_ms > 0)
          ? 'quote_max_age_ms is not a positive age'
          : null;
  const verdicts = cands.map((c) => ({
    cand: c,
    verdict: pricing === 'live' ? sellable(chain, c.strike, side, dials, nowMs) : PASS,
  }));
  const liquid = verdicts.filter((v) => v.verdict.ok).map((v) => v.cand);
  // Nothing to cross: size off the FULL set anyway, so the maker-quote path has
  // a strike and a lot count to quote (header §4).
  const gated = liquid.length === 0;
  // Sized off the RESIDUAL, which is the excess itself whenever the unwind is
  // off or took nothing (§4 above).
  const pick = bestFit(gated ? cands : liquid, remaining, lotSize);
  const sellDps = pick === null ? 0 : (cands.find((c) => c.strike === pick.strike)?.dps ?? 0);

  // ---- earn the buy-back loss back (`tiers.ts` §4) -------------------------
  const recycle = applyRecycle(inputs, dials, counted, band, {
    taken: unwind.taken,
    shedSide: side,
    stackSide,
    sellStrike: pick?.strike ?? first?.strike ?? null,
    sellLots: pick?.lots ?? 0,
    sellDps,
    shed: unwind.shed,
    lotSize,
    trendDir: trend.dir,
  });

  // ---- candidacy, again: the RECYCLE is a fresh sell too ------------------
  // `verdicts` above covers the strikes phase R would shed at. The recycle
  // lands somewhere else by construction — the crossfill arm sits strictly
  // FURTHER OTM than the strike that was just gated, which is the thinner book,
  // not the better one — so a package that reported `sheddable: true` off the
  // shed candidates alone would cross a strike nothing ever looked at.
  //
  // Same row, same handling: the order still stands so the supervisor can
  // maker-quote it, and `sheddable` is what says the market would not take it.
  const recycleOpen = recycle.actions.find((a) => a.op === 'open');
  const recycleVerdict =
    pricing === 'live' && recycleOpen !== undefined && recycleOpen.op === 'open'
      ? sellable(chain, recycleOpen.strike, recycleOpen.optType, dials, nowMs)
      : PASS;
  const recycleFault =
    recycleVerdict.ok || recycleOpen === undefined || recycleOpen.op !== 'open'
      ? null
      : `the recycle's ${n0(recycleOpen.strike)}${recycleOpen.optType} ${recycleVerdict.why}`;

  // The streak resets on EMIT, not on execution (`:3862-3867`): the caller's
  // scrap gate and margin projection both run after this returns and can drop
  // or downsize the sale, so a dropped mark restarts the confirmation clock.
  // That is the conservative direction — it can only make the arm trade less.
  const acted = unwind.actions.length > 0 || pick !== null || recycle.actions.length > 0;
  const banked: RuleState = { ...counted, rcCredit: recycle.rcCredit };
  const after: RuleState =
    acted && Math.trunc(dials.confirm_marks) > 0 ? { ...banked, gkStreak: 0 } : banked;
  /**
   * The mark state a package that is NEVER SENT leaves behind (`types.ts`'s
   * `markState`) — and the one field of `counted` that has to come back out of
   * it: the EOD sweep's day stamp.
   *
   * `applyEodSweep` consumes the session the moment it ARMS
   * (`rcEodDay !== dateIst` is the whole arming test), so a stamp that survived
   * a sweep desk-api refused would mean the once-a-session flatten never fires
   * again that day — the book carries its delta into the close, which is the
   * one thing `eod_flat_min` exists to prevent. If the sweep really goes out,
   * `stateAfter` carries the stamp exactly as before.
   *
   * The anchor EMA and the breach streak stay: both are properties of the mark
   * rather than of the package.
   */
  const marked: RuleState = { ...counted, rcEodDay: state.rcEodDay };

  const unwound =
    unwind.taken.length === 0
      ? ''
      : `unwind: buy back ${unwind.taken.map((t) => `${t.lots} ${n0(t.leg.strike)}${t.leg.optType}`).join(', ')} ` +
        `(sheds ${n0(unwind.shed)} of the ${n0(trend.budget)} budget) rather than sell more ${side}`;
  const recycled =
    recycle.actions.length === 0
      ? ''
      : `recycle: ${recycle.actions
          .map((a) => (a.op === 'open' ? `sell ${a.lots} ${n0(a.strike)}${a.optType}` : ''))
          .join('')} against the ${inr(recycle.credit)} loss just booked` +
        (dials.recycle_bank ? ` (bank ${inr(recycle.rcCredit)})` : '');
  const skewed = dials.trend_enabled
    ? `trend-skew ${pct(dials.trend_skew, 0)} of the band — shedding to netΔ ${f0(trend.target)}`
    : '';
  const swept = sweep.armed ? `${sweepStamp(minuteOfDay)} sweep at tolerance 0 (whole book)` : '';

  if (pick === null) {
    // The stack covered it, or a whole lot cannot express what is left. Ship
    // the unwind alone; only with nothing to unwind either is it a hold
    // (`:3831-3845`).
    if (unwind.actions.length > 0 || recycle.actions.length > 0) {
      const base = join([
        swept,
        unwound,
        `the buy-back covered it — no ${side} sale needed`,
        recycled,
      ]);
      return {
        actions: [...unwind.actions, ...recycle.actions],
        reason: uncrossable(base, recycleFault),
        // A buy-back is a BUY and answers to no sell gate; only the recycle's
        // fresh sale can fail one here.
        sheddable: recycleFault === null,
        stateAfter: after,
        markState: marked,
        creditCommit: recycle.commit,
      };
    }
    if (cands.length === 0) {
      return {
        actions: [],
        sheddable: false,
        reason: `excess ${n2(remaining)} shares to shed and no ${side} at ${where} prices — nothing to sell`,
        stateAfter: after,
        markState: marked,
        creditCommit: null,
      };
    }
    // Sub-one-lot everywhere. Stateless and deliberate: it accumulates, and the
    // gate is not what stopped it, so this stays sheddable (header §2).
    // `n2`, not `n0`: this branch fires precisely when the excess is SMALL, and
    // Python's `{:,.0f}` rounds the whole line to "excess 0 shares under one
    // lot" — the number the operator needs, rendered as the one number that
    // cannot be true.
    return hold(
      after,
      join([swept, `excess ${n2(remaining)} shares under one lot at ${where} — nothing to sell`]),
    );
  }

  const actions: EngineAction[] = [
    ...unwind.actions,
    // `add`: the shed ACCUMULATES — it re-picks the best strike and sells more
    // of it, whether or not the book already holds it. `book.ts` needs that
    // said explicitly to tell this from a decision repeating itself.
    { op: 'open', strike: pick.strike, optType: side, side: 'Sell', lots: pick.lots, add: true },
    ...recycle.actions,
  ];
  // Where the book's delta would cross zero, as a fraction of spot — the number
  // that says whether this shed is centring the book or nudging it (`:4152`).
  const off = ng !== 0 ? Math.abs(nd / ng) / spot : 0;
  const sale =
    `sell ${pick.lots} ${n0(pick.strike)}${side} (netΔ ${f0(nd)} vs allowed ` +
    `${n0(allowed)}, shed ${n0(remaining)}; zero-Δ point ${pct(off, 2)} of spot out)`;
  const reason = join([swept, unwound, sale, skewed, recycled]);

  const shedFault = !gated
    ? null
    : (dialFault ??
      `no candidate has a book we would cross (${verdicts
        .flatMap((v) => (v.verdict.ok ? [] : [`${n0(v.cand.strike)}${side} ${v.verdict.why}`]))
        .join(', ')})`);
  // BOTH gates, named together: the shed's and the recycle's are two different
  // sales on two different strikes, and an operator reading one of them and
  // acting on it would leave the other crossing a book we refused.
  const fault = [shedFault, recycleFault].filter((f) => f !== null).join('; ');
  return {
    actions,
    sheddable: fault === '',
    reason: uncrossable(reason, fault === '' ? null : fault),
    stateAfter: after,
    markState: marked,
    creditCommit: recycle.commit,
  };
}

/**
 * The scan-off candidate set: one strike, `strikes_out` steps out
 * (`playbooks.py:4106-4109`). Empty when the chain cannot price it — the
 * deleted `0.30` fallback is what used to fill that hole.
 */
function fixedCandidate(
  chain: ChainSnap,
  side: OptType,
  spot: number,
  strikesOut: number,
  dateIst: string,
  minuteOfDay: number,
  opts: ScanOptions = {},
): ReadonlyArray<ShedCandidate> {
  const atm = opts.atm ?? nearestStrike(chain, spot);
  const k = otmSellStrike(chain, atm, side, spot, Math.trunc(strikesOut));
  if (!(k > 0)) return [];
  const greeks =
    opts.greeks ?? ((s: number, ot: OptType) => strikeGreeks(chain, s, ot, dateIst, minuteOfDay));
  const g = greeks(k, side);
  if (g === null) return [];
  const dps = Math.abs(g.delta);
  return dps > 0 ? [{ strike: k, dps }] : [];
}

// ── reason formatting ───────────────────────────────────────────────────────
// Python's `{:,.0f}` / `{:+.0f}` / `{:+.1f}` / `{:.2%}`, so an operator reading
// a TS reason reads the same shapes they have been reading for months. Grouping
// is forced to en-US: the Python desk wrote Western groups, and an en-IN
// runtime would silently start printing 4,83,000 for the same number.

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');
/** Grouped, but keeping up to two decimals — for the one line whose whole
 * subject is a quantity smaller than a lot. */
const n2 = (x: number): string => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
const f0 = (x: number): string => `${x >= 0 ? '+' : '-'}${n0(Math.abs(x))}`;
const f1 = (x: number): string => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(1)}`;
const pct = (x: number, digits: number): string => `${(x * 100).toFixed(digits)}%`;
const inr = (x: number): string => `Rs${n0(x)}`;
/** `HH:MM` back out of a minute of day — the sweep names the mark it fired on,
 * as Python's `{ctx['time']} sweep` does (`playbooks.py:3856`). */
const sweepStamp = (minute: number): string => {
  const m = Math.max(0, Math.trunc(minute));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
/** The clauses that actually happened, in the order they happened. An empty
 * clause is DROPPED rather than rendered as a dangling separator — a reason is
 * read by a human deciding whether to intervene. */
const join = (parts: ReadonlyArray<string>): string => parts.filter((p) => p !== '').join('; ');
/** The one sentence a gated package ends with, wherever it was gated. Kept in
 * one place because `sheddable: false` and this wording are the same claim, and
 * a caller greps the prose when the flag is not to hand. */
const uncrossable = (reason: string, fault: string | null): string =>
  fault === null ? reason : `${reason} — ${fault}; quote it, do not cross`;
