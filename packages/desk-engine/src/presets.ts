/**
 * THE PRESETS, AS PREFILLS — thirty-one of them: the twelve historical
 * recenter variants plus the one split that keeps a live book from being read
 * off a board it was never measured on, the six delta-lean books, the six
 * playbook books, and the six BULL-S books on Delta BTC options.
 *
 * What this prevents: the Python desk chose behaviour by NAME. A book row
 * carried `variant: "recenter-relief-r"`, a `desk-variants` collection mapped
 * that to a playbook, the playbook name selected a function, and the dials
 * came from a `DEFAULTS` dict full of dictionary spreads. Four indirections,
 * and no way to see from the book row what the book would actually do. Here a
 * preset is A PREFILL AND NOTHING MORE: picking one copies numbers into the
 * book's own dials, the row records `preset` as a label, and what the engine
 * reads is always the dials themselves (design spec §5 "Presets").
 *
 * ── SOURCES, AND HOW ABSENCE WAS TRANSLATED ─────────────────────────────────
 * Values are transliterated from the Python desk, read-only:
 *
 *   `sensibull-desk/sensibull_tools/sim/rules/playbooks.py`
 *     :349-362  DEFAULTS["recenter"]          :404-411  -atm / -otm
 *     :472-477  DEFAULTS["recenter-relief"]   :558-560  -b1 / -b2 / -free
 *     :585-587  DEFAULTS["recenter-eod"]      :613-615  DEFAULTS["recenter-eod3"]
 *     :626      -trend       :647-649  -reshift        :658-660  -crossfill
 *   `sensibull-desk/sensibull_tools/sim/variants.py:387-564`
 *     the registry rows — `default_target_pnl` 250000 and `default_margin_cap`
 *     ₹10cr are identical across all twelve, deliberately, so every board on a
 *     book compares on one axis.
 *
 * The delta-lean and playbook prefills are NOT Python's: each names its own
 * operator-approved table where it is defined (`DELTA_LEAN_BASE`,
 * `PLAYBOOK_BASE`).
 *
 * Python dials that DIED in the port are simply not here (spec §5 "Deleted
 * Python semantics"): `cooldown_min`, `no_buy`, `no_close`, `unwind_share` and
 * `unwind_entry_book` are engine constants for this family. `unwind_added_first`
 * became the `unwind_enabled` toggle, and `trend_skew: None` — Python's third
 * spelling of off — became `trend_enabled: false`.
 *
 * WHERE ABSENCE HAD TO BECOME A VALUE. Where a Python playbook omits a dial
 * the preset omits it too and the engine default applies — which is right
 * everywhere the default IS the off-state, and wrong wherever it is not.
 * `DEFAULT_DIALS` is the relief-r LIVE set, and the live set turns two blocks
 * ON, so both had to be written back off by hand:
 *
 *   THE SHIFT BLOCK. A playbook that never shifted (`recenter`, `-eod`,
 *   `-eod3`, `-trend`, `-reshift`, `-crossfill`) would silently inherit
 *   relief's margin-gated shift, so those presets say `shift_enabled: false`
 *   out loud. For the same reason `-atm`/`-otm` say `shift_margin_frac: 0`:
 *   Python omits it, and omission there means the GATE is off while the
 *   shifting stays on (playbooks.py:3907-3919) — inheriting 0.60 would give
 *   them a gate they were never measured with.
 *
 *   THE SHORTS-ONLY PAIR. `delta_shorts_only`/`gamma_shorts_only` are absent
 *   from EVERY shipped recenter playbook — `playbooks.py:555-557` keeps even
 *   `DEFAULTS["recenter-relief"]` absent of both, "non-negotiable", so the
 *   committed board stays reproducible. Both read sites are
 *   `if not p.get(...)`, and both say so: ":2968-2972 — absent the dial this
 *   is exactly `K.net_gamma`, which is what keeps `recenter` and its four
 *   siblings byte-identical", ":3002-3005 — the dial is absent from every
 *   shipped playbook". Only the LIVE relief-r book carries them, set per-book
 *   by the operator on 2026-08-12. Every other preset therefore states
 *   `delta_shorts_only: false, gamma_shorts_only: false`, because inheriting
 *   the live default would steer eleven presets off SHORT greeks when they
 *   were measured on WHOLE-BOOK greeks — a divergence that shows up the
 *   moment a book carries a hedge leg, and only then.
 *
 * `pairshift-*` is OUT OF SCOPE (spec §5): it is a different action on the
 * same trigger — a paired close+open rather than a shed — and none of it is
 * ported here.
 */

import type { Dials } from './dials.ts';

export interface Preset {
  readonly key: string;
  readonly label: string;
  readonly dials: Partial<Dials>;
}

/**
 * DEFAULTS["recenter"] — playbooks.py:349-362. The family's base: a 2%
 * gamma-scaled corridor with a √20-day shrink, price-scrap only, the 0.15
 * sell floor PINNED (it normally inherits `scrap_close_delta`, and zeroing
 * the exit would quietly reopen selling 0.15-delta strikes), LIFO unwind of
 * its own added legs before it flips sides, and the balance tier that rebuilds
 * a book that has lost a side.
 */
const RECENTER: Partial<Dials> = {
  delta_tol_pct: 0.02,
  delta_shorts_only: false, // absent in Python = whole-book greeks (:3002-3005)
  gamma_shorts_only: false, // absent in Python = whole-book greeks (:2968-2972)
  tol_ref_dte: 20,
  strikes_out: 2,
  min_sell_dte: 1,
  scrap_close_delta: 0,
  min_sell_delta: 0.15,
  unwind_enabled: true,
  balance_enabled: true,
  balance_min_dte: 7,
  shift_enabled: false,
  target_pnl: 250000,
  margin_cap: 100000000,
};

/**
 * DEFAULTS["recenter-eod"] — playbooks.py:585-587. recenter plus the 15:15
 * sweep, with three dials pinned back off so the A/B isolates `eod_flat_min`
 * alone: the delta scrap and its sell floor (both arrived the same day on the
 * parent) and `unwind_added_first`. `tol_ref_dte` goes to 0 with them.
 */
const RECENTER_EOD: Partial<Dials> = {
  ...RECENTER,
  eod_flat_min: 15 * 60 + 15,
  scrap_close_delta: 0,
  min_sell_delta: 0,
  unwind_enabled: false,
  tol_ref_dte: 0,
};

/**
 * DEFAULTS["recenter-relief"] — playbooks.py:472-477, as the committed BOARDS
 * were measured: shorts-only OFF. The live desk runs the same playbook with
 * both dials on; that is `recenter-relief-r` below, and the two are separate
 * presets on purpose (playbooks.py:463-465 — "the committed relief-r / -b1 /
 * -b2 / -free boards no longer reproduce against it").
 */
const RELIEF_BOARD: Partial<Dials> = {
  delta_tol_pct: 0.02,
  delta_shorts_only: false,
  gamma_shorts_only: false,
  strikes_out: 2,
  min_sell_dte: 1,
  shift_enabled: true,
  shift_itm_steps: 0.5,
  shift_land_steps: 2,
  shift_margin_frac: 0.6,
  hedge_after_shift: false,
  target_pnl: 250000,
  margin_cap: 100000000,
};

/**
 * DEFAULTS["recenter-reshift"] — playbooks.py:647-649. The near-edge shed
 * (`trend_skew: None`), the 0.10 delta scrap back on, and half of every
 * realized loss re-sold on the side just bought back, with sub-lot credit
 * banked rather than discarded. `min_sell_delta` stays the parent's 0.15.
 */
const RECENTER_RESHIFT: Partial<Dials> = {
  ...RECENTER,
  trend_enabled: false,
  recycle_frac: 0.5,
  recycle_bank: true,
  recycle_opposite: false,
  scrap_close_delta: 0.1,
};

/**
 * THE DELTA-LEAN PREFILLS — the presets that select a different ENGINE rather
 * than a different Python playbook. (The six `pb-*` presets below are built on
 * this same base: a playbook book is a delta-lean book.)
 *
 * Spec §4's dial table (`docs/superpowers/specs/2026-09-22-delta-lean-hold-
 * adjust-design.md`) has two columns, aggressive and conservative, BOTH on
 * the same ₹25L SPAN-lite margin cap (D4) — the cap is not what tells the
 * books apart. `DEFAULT_DIALS` already carries the aggressive column field
 * for field, so the aggressive preset is this base and nothing else, and the
 * conservative preset is this base plus the five numbers §4's second column
 * actually moves. A dial §4 writes as "same" is INHERITED here rather than
 * restated, so the two columns cannot silently drift apart.
 *
 * Three dials in the base are not delta-lean dials at all, and each is here
 * because a `Partial<Dials>` inherits `DEFAULT_DIALS`, which is the live
 * relief-r set:
 *
 *   `confirm_ms` / `cooldown_s` are the recenter engine's own dials, but they
 *   are read by the HOST's damping, which BOTH decide paths share. At the
 *   recenter defaults (5s confirm, 30s cooldown) a delta-lean CUT would wait
 *   out a window longer than the move it is cutting — and a cut that arrives
 *   late is the whole per-lean loss rather than a fraction of it. 1s confirm,
 *   no cooldown.
 *
 *   `delta_shorts_only` / `gamma_shorts_only` are inert on this path, but they
 *   are not inert in the dial DOCUMENT: `presets.test.ts` sweeps the resolved
 *   set of every preset for exactly one book that steers on short greeks, and
 *   inheriting the live default would put two books that are not on the
 *   recenter engine at all into that bucket. Written off out loud.
 *
 * `target_pnl` and `margin_cap` are the recenter family's own two numbers and
 * are restated at the family values so every preset still compares on one
 * axis. The delta-lean path reads `margin_cap` and not `target_pnl` — D4's
 * SPAN-lite ceiling on the whole package — but a book row carries one dial
 * document and an omitted field here would be a number nobody chose.
 */
const DELTA_LEAN_BASE: Partial<Dials> = {
  delta_lean_enabled: true,
  // Six-playbooks spec F1: the book's chain is priced off ITS OWN expiry's
  // forward. The one `dl_` dial restated here against `DEFAULT_DIALS`, which
  // must keep it off so a row registered before it existed keeps the future
  // (see the dial). Every delta-lean preset — the hold pair and the six
  // playbooks too — spreads it from here.
  dl_parity_forward: true,
  confirm_ms: 1000,
  cooldown_s: 0,
  // An existing execution dial, not a delta-lean one: the peg joins the
  // touch and follows it for this long before its single bounded cross. 30s
  // is a corridor book's patience; a package adjusting into a move already
  // underway cannot wait that long to be on it.
  chase_max_ms: 1500,
  delta_shorts_only: false,
  gamma_shorts_only: false,
  target_pnl: 250000,
  // D4: THE CAP IS A SPAN-LITE CEILING ON THE WHOLE PACKAGE, and this is it.
  // ₹25 lakh per book, priced with `spanLiteMargin` so a hedged or cross-side
  // package gets its offset. The recenter family's ₹10cr is a different number
  // answering a different question and must not be inherited here.
  margin_cap: 2_500_000,
};

/**
 * Spec §4's second column on the delta-lean base — named so the intraday
 * conservative preset and its hold-to-expiry sibling spread ONE object and
 * cannot drift apart.
 */
const DELTA_LEAN_CONSERVATIVE: Partial<Dials> = {
  ...DELTA_LEAN_BASE,
  // Spec §4's second column, and NOTHING ELSE but R1's backstop and the 30 Oct
  // switch-off below: a row §4 writes as "same" is inherited rather than
  // restated, so the two columns cannot drift apart.
  dl_open_lots: 2,
  dl_adjust_confirm_s: 120,
  dl_adjust_cooldown_s: 900,
  // OPENED AND HELD — NOT §4's number, which was 4. The 30 Oct 2026 review
  // found the neutralising adjustments lost money on balance in all four
  // daily books: the opening legs alone beat the managed book. So this column,
  // intraday and hold alike, now places its open and nothing after it, while
  // the aggressive column keeps its 6 — a TEST of held against adjusting, not
  // a verdict. To end it, put the 4 back; nothing else moved with it.
  dl_max_adjusts_day: 0,
  // ON the backstop, and it must stay there while the line above is 0. With
  // no adjustment allowed every one the posture wants is BLOCKED and §6.4's
  // stuck clock runs on any losing tick; at the backstop's level the backstop
  // reads the same `totalPnl` three steps earlier and takes the book first —
  // on the hold book too, whose 60s rupee hold is under the 300s stuck window
  // (the zero book's D6). Move the two together.
  dl_stuck_loss: 15_000,
  // NOT a §4 row: §4 wrote the backstop as "same" (200,000). R1 of the
  // 2026-10-04 review (applied 2026-10-05) sized it to each book — 30,000 on
  // the aggressive column, this on the conservative one, about 2.3x its worst
  // book-day outside 1 Oct. The desk day guard arms at 23,000 off it.
  dl_day_max_loss: 15_000,
  // Twice the aggressive book's patience at the touch: it is adding half
  // the size, so paying the spread hurts it more than arriving late does.
  chase_max_ms: 3000,
};

/**
 * THE ZERO BOOK — the conservative column carrying the dials a year of NIFTY
 * 1-minute history tuned it to (`docs/superpowers/specs/2026-10-17-delta-lean-
 * zero-design.md`, §4; Optuna trial #2615). What the tuning made of the book:
 * a far-winged iron condor opened at 09:31 and held to 14:30, with no
 * adjustment, no target and a debit spread on the mornings a trend has
 * already confirmed by then.
 *
 * Only what the study MOVED is restated, at the two decimals its report
 * prints (D7); every dial it left alone or found inert — the lots, the
 * cooldown, the dead band, the sideways-sale band, the windows, the dwell —
 * is the conservative column's, inherited so the two cannot drift apart on a
 * dial nobody re-measured.
 *
 * THE ₹0 TARGET IS ALSO THE OLD-BUILD FAIL-SAFE (D9). The roll runs from the
 * repository and may register this row before the desk is restarted onto the
 * build that knows the open dials. An older supervisor drops those as unknown
 * — but reads the target, and there `0 >= 0` on the first pass of a flat
 * book fires it and latches the day: the row places nothing, rather than
 * opening all day on any regime. Do not give this preset a target.
 */
const DELTA_LEAN_ZERO: Partial<Dials> = {
  ...DELTA_LEAN_CONSERVATIVE,
  // The regime detector, a little readier to call trend and much readier to
  // call quiet — which still needs two quiet windows in a row.
  dl_trend_mult: 1.94,
  dl_trend_exit_mult: 1.26,
  dl_clean_min: 0.62,
  dl_quiet_mult: 1.17,
  dl_adjust_confirm_s: 180,
  // The open: 09:29 to 09:31, and at 09:31 the condor on whatever the tape
  // reads but `unknown` — 146 of the study's 165 in-sample opens.
  dl_warmup_min: 569, // 09:29
  dl_open_by_min: 571, // 09:31
  dl_open_fallback: true,
  // No target (and see above); the backstop the study chose, never reached in
  // it (worst day ₹13,068). The stuck floor sits ON the backstop (D6): with no
  // adjustments allowed every wanted one is BLOCKED, and the backstop at the
  // same level fires first, so the stuck exit — which the study never had —
  // can never fire ahead of it. The desk guard arms at ₹30,000 off this.
  dl_day_target: 0,
  dl_day_max_loss: 20_000,
  dl_stuck_loss: 20_000,
  // The clock 20 minutes earlier, the conservative ladder's shape kept (D8).
  dl_flatten_passive_min: 870, // 14:30
  dl_flatten_urgent_min: 875,
  dl_flat_by_min: 880,
  // Strikes: a deeper debit spread with a closer hedge, and a condor whose
  // shorts sit further out and whose wings are cheap disaster cover.
  dl_long_delta_lo: 0.63,
  dl_long_delta_hi: 0.73,
  dl_short_delta_lo: 0.3,
  dl_short_delta_hi: 0.4,
  dl_credit_short_delta_max: 0.24,
  dl_wing_delta: 0.03,
  // Opened and held. The study's strongest finding: the conservative
  // adjustments turned this setting's ₹1,18,316 into a ₹13,766 loss.
  dl_max_adjusts_day: 0,
};

/**
 * THE SIX PLAYBOOK PREFILLS — six-playbooks spec §8.2
 * (`docs/superpowers/specs/2026-10-16-six-playbooks-design.md`): delta-lean
 * books whose `pb_playbook` hands them to the playbook frame.
 *
 * Built on `DELTA_LEAN_BASE` so every host behaviour keyed on
 * `delta_lean_enabled` — the cadence, the order budgets, the fast exits, the
 * day guard, the roll — applies to them unchanged (spec §4.1), plus ONE dial
 * the base does not set:
 *
 *   `dl_open_lots: 0` is THE OLD-BUILD FAIL-SAFE (D9). A supervisor that does
 *   not know `pb_playbook` drops it as an unknown dial and runs the row on
 *   `decideDeltaLean`, which sizes its open off `dl_open_lots` — resolved
 *   against THAT build's defaults, where it is 4. Written into the preset, the
 *   0 rides in the row itself: `fitLots` walks down from 0, nothing fits, and
 *   the book never opens, while its clock and its backstop still run. The
 *   playbook frame sizes off `pb_lots` and never reads it.
 *
 * Each preset then states its column of §8.2 as the spec review amended it:
 * every value the column gives, INCLUDING the ones equal to a default, so a
 * later change to `DEFAULT_DIALS` cannot move a playbook nobody re-measured.
 * A dial the column leaves blank is one the book does not use, and it is
 * inherited rather than invented. The clock is the delta-lean one for all six
 * (14:50 passive, 14:55 urgent, 15:00 flat), so it is inherited too.
 */
const PLAYBOOK_BASE: Partial<Dials> = { ...DELTA_LEAN_BASE, dl_open_lots: 0 };

/**
 * THE BULL-S BOOKS ON DELTA BTC OPTIONS (Delta spec §6.2) — one per expiry
 * class, each with a `-2` twin that differs ONLY in `bs_strike_jump`.
 *
 * Sizes and loss caps are the analyst's starting numbers
 * (`docs/research/delta/delta-strategies.md` §1); sizes are contracts of
 * 0.001 BTC, money is USD. The target is off until the operator sets one per
 * book. Every preset is CAPPED (spec C9): no uncapped pyramid ships on BTC.
 *
 * The two other engine switches are written OFF out loud, so a book whose
 * dials are refilled from one of these over a delta-lean or playbook preset
 * cannot keep a second path switched on.
 */
function bullS(step: number, start: number, lotStep: number, cap: number, lossCap: number, jump: 1 | 2): Partial<Dials> {
  return {
    delta_lean_enabled: false,
    pb_playbook: 0,
    // Not read on this path; written off for the reason the file header gives,
    // so no preset but the live relief-r book resolves to shorts-only steering.
    delta_shorts_only: false,
    gamma_shorts_only: false,
    bs_enabled: true,
    bs_strike_step: step,
    bs_strike_jump: jump,
    bs_stop_mult: 1.25,
    bs_stop_basis: 1,
    bs_stop_confirm_s: 3,
    bs_lots_start: start,
    bs_lots_step: lotStep,
    bs_lots_cap: cap,
    bs_max_open: 4,
    bs_target: 0,
    bs_loss_cap: lossCap,
    bs_after_halt: 0,
    bs_enter_on_start: true,
    bs_no_entry_before_expiry_min: 60,
  };
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    key: 'recenter-r',
    label: 'Recenter',
    dials: RECENTER,
  },
  {
    key: 'recenter-eod-r',
    label: 'Recenter + 15:15 sweep',
    dials: RECENTER_EOD,
  },
  {
    key: 'recenter-eod3-r',
    label: 'Recenter + sweep, 3% corridor',
    // playbooks.py:613-615. THE eod3 QUIRK: Python sets scrap_close_delta to
    // 0.10 and then POPS min_sell_delta, so it falls back to the scrap value
    // in RuleEngine.__init__ rather than inheriting the parent's pinned 0.0.
    // Encoded explicitly, because a 0.0 sell floor beside a live 0.10 scrap
    // is the churn trap the engine's own docstring warns about — sell a
    // 0.05-delta package, scrap the whole thing on the next mark.
    dials: {
      ...RECENTER_EOD,
      delta_tol_pct: 0.03,
      scrap_close_delta: 0.1,
      min_sell_delta: 0.1,
    },
  },
  {
    key: 'recenter-atm-r',
    label: 'Recenter + shift to ATM',
    // playbooks.py:404-407. A fresh dict in Python, NOT a spread of recenter:
    // no scrap, no sell floor, no √dte shrink, no unwind, no balance tier.
    dials: {
      delta_tol_pct: 0.02,
      delta_shorts_only: false,
      gamma_shorts_only: false,
      strikes_out: 2,
      min_sell_dte: 1,
      shift_enabled: true,
      shift_itm_steps: 1,
      shift_land_steps: 0,
      shift_margin_frac: 0, // gate off; see the header note
      target_pnl: 250000,
      margin_cap: 100000000,
    },
  },
  {
    key: 'recenter-otm-r',
    label: 'Recenter + shift one step OTM',
    // playbooks.py:408-411 — recenter-atm with the landing strike one out.
    dials: {
      delta_tol_pct: 0.02,
      delta_shorts_only: false,
      gamma_shorts_only: false,
      strikes_out: 2,
      min_sell_dte: 1,
      shift_enabled: true,
      shift_itm_steps: 1,
      shift_land_steps: 1,
      shift_margin_frac: 0,
      target_pnl: 250000,
      margin_cap: 100000000,
    },
  },
  {
    key: 'recenter-relief-r',
    label: 'Relief (live)',
    // The LIVE desk's variant: the board dials plus the shorts-only pair the
    // operator switched on 2026-08-12 (playbooks.py:424-465). Steering reads
    // SHORT delta and SHORT gamma only, so a protective long wing no longer
    // narrows the band that manages the book — and, deliberately, no longer
    // damps the delta the rule sheds against. Read peak margin and max DD.
    dials: {
      ...RELIEF_BOARD,
      delta_shorts_only: true,
      gamma_shorts_only: true,
    },
  },
  {
    key: 'recenter-relief-r-board',
    label: 'Relief (board)',
    dials: RELIEF_BOARD,
  },
  {
    key: 'recenter-relief-b1-r',
    label: 'Relief, band floored at 1 lot',
    // playbooks.py:558. Research arm (variants.py research_only): the
    // convexity floor becomes a clamp so collapsing gamma widens the band
    // instead of silencing the delta phase.
    dials: { ...RELIEF_BOARD, min_band_lots: 1 },
  },
  {
    key: 'recenter-relief-b2-r',
    label: 'Relief, band floored at 2 lots',
    dials: { ...RELIEF_BOARD, min_band_lots: 2 },
  },
  {
    key: 'recenter-relief-free-r',
    label: 'Relief, no convexity floor',
    // playbooks.py:560. Research arm, and an unbounded-SIZE one: with no
    // floor the rule sheds essentially the whole netΔ as gamma dies.
    dials: { ...RELIEF_BOARD, no_band_floor: true },
  },
  {
    key: 'recenter-trend-r',
    label: 'Recenter + trend lean',
    // playbooks.py:626 — sheds to ±0.5 × allowed on the trend side rather
    // than to the near band edge. The lean alone, so the A/B prices it.
    dials: { ...RECENTER, trend_enabled: true, trend_skew: 0.5 },
  },
  {
    key: 'recenter-reshift-r',
    label: 'Recenter + reshift (50% recycle)',
    dials: RECENTER_RESHIFT,
  },
  {
    key: 'recenter-crossfill-r',
    label: 'Recenter + crossfill (100% recycle, other side)',
    // playbooks.py:658-660 — the reshift with the premium on the OTHER side
    // and the whole realized loss recycled rather than half. Martingale-
    // shaped: read peak margin and max DD before net P&L.
    dials: { ...RECENTER_RESHIFT, recycle_opposite: true, recycle_frac: 1 },
  },
  {
    key: 'delta-lean-aggressive',
    label: 'Delta lean — aggressive (25L)',
    // Nothing but the base: `DEFAULT_DIALS` IS spec §4's aggressive column,
    // and restating it here would be a second copy of the operator-approved
    // table to keep in step with the first.
    dials: { ...DELTA_LEAN_BASE },
  },
  {
    key: 'delta-lean-conservative',
    label: 'Delta lean — conservative (25L)',
    // Spec §4's second column. The shape of the book is identical — same
    // regime detector, same strike bands, same day clock ("same" in every one
    // of those rows) — and what changes is how big the book opens, how
    // patient it is before it adjusts, how often it may adjust, and how much
    // it may lose before the stuck exit arms: half the lots, twice the
    // confirm and cooldown, two fewer adjustments a day, and a tighter stuck
    // trigger — and, since R1 (2026-10-05), half the backstop: 15,000. Since
    // 30 Oct 2026 it adjusts NOT AT ALL — opened and held, the test against
    // aggressive set out at `DELTA_LEAN_CONSERVATIVE`.
    dials: DELTA_LEAN_CONSERVATIVE,
  },
  {
    key: 'delta-lean-hold-aggressive',
    label: 'Delta lean — hold to expiry, aggressive (25L)',
    // The aggressive book carried to its contract's expiry, and NOTHING else
    // moves (hold-to-expiry spec, 2026-10-05). On this book `dl_day_target`
    // and `dl_day_max_loss` are BOOK-LIFE numbers — the tag's whole P&L from
    // the open to expiry — and the clock ladder runs from expiry day on. The
    // dial names stay the day's so there is one table, not two, to keep in step.
    // So the book-life backstop is the intraday column's: since R1
    // (2026-10-05), 30,000 here and 15,000 on the conservative hold book.
    dials: { ...DELTA_LEAN_BASE, dl_hold_to_expiry: true },
  },
  {
    key: 'delta-lean-hold-conservative',
    label: 'Delta lean — hold to expiry, conservative (25L)',
    // The conservative column carried to expiry; the note above applies.
    dials: { ...DELTA_LEAN_CONSERVATIVE, dl_hold_to_expiry: true },
  },
  {
    key: 'delta-lean-zero',
    label: 'Delta lean — zero (25L)',
    // The tuned conservative book: see `DELTA_LEAN_ZERO`. Paper, on NIFTY and
    // SENSEX alike, though only NIFTY was replayed (spec §2).
    dials: DELTA_LEAN_ZERO,
  },
  {
    key: 'delta-lean-zero-0dte',
    label: 'Delta lean — zero, 0-DTE trend-down (25L)',
    // The zero book's every dial ("same params"), opened only on its
    // contract's expiry day and only on a confirmed trend-down: the put debit
    // spread, the one setup the study never saw lose — on two expiry days,
    // and none at all in the holdout (spec §2). No condor, so no fallback:
    // stated off out loud, because "fallback on" beside "quiet off" would
    // read as a condor book to anyone scanning the row.
    dials: {
      ...DELTA_LEAN_ZERO,
      dl_expiry_day_only: true,
      dl_open_trend_up: false,
      dl_open_quiet: false,
      dl_open_fallback: false,
    },
  },
  // ── the six playbooks (spec §5), three intraday then three expiry-day ────
  {
    key: 'pb-trend-drive',
    label: 'Playbook — Trend Drive',
    // §5.1: the confirmed opening trend as a debit spread off the delta bands
    // — the desk's best record (§1.1) — on a morning that has already gapped,
    // never on 0-DTE, with a debit stop, a flip stop and one capped pyramid.
    // The trailing floor arms only from 13:00: winners run late (§1.1).
    dials: {
      ...PLAYBOOK_BASE,
      pb_playbook: 1,
      pb_min_dte: 1,
      pb_entry_start_min: 570, // 09:30
      pb_entry_end_min: 615, // 10:15
      pb_max_entries: 1,
      pb_confirm_s: 120,
      pb_trade_max_loss: 6_000,
      pb_trade_target: 12_000,
      // ...and never more than 0.7 x what the held spread can make at most. A
      // one-session contract's band pair is narrow: SENSEX's 1-DTE spread tops
      // out at about Rs9-11.7k at 2 lots (10-16% IV), NIFTY's Monday one at
      // about Rs10.7k at 12%, and a Rs12,000 target there could never fire.
      pb_target_max_frac: 0.7,
      pb_trail_start: 0, // no floor before 13:00
      pb_late_trail_start: 2_000,
      pb_late_min: 780, // 13:00
      pb_trail_keep: 0.6,
      pb_strike_mode: 0, // delta bands
      pb_debit_stop_frac: 0.4,
      pb_flip_confirm_s: 90,
      pb_max_adds: 1,
      pb_add_ext_k: 0.5,
      pb_gap_min_pct: 0.25,
      dl_day_max_loss: 9_000,
      dl_day_target: 15_000,
    },
  },
  {
    key: 'pb-wing-straddle',
    label: 'Playbook — Wing Straddle',
    // §5.2: a short ATM straddle with wings, one lot, on a contract at least
    // five sessions out, sold only into a quiet or choppy morning that has
    // neither gapped nor run away from the open. The 25% combined stop and an
    // index stop a whole entry straddle out are the working exits.
    dials: {
      ...PLAYBOOK_BASE,
      pb_playbook: 2,
      pb_min_dte: 5,
      pb_lots: 1,
      pb_entry_start_min: 570, // 09:30
      pb_entry_end_min: 750, // 12:30
      pb_max_entries: 2,
      pb_reentry_cooldown_s: 1_200,
      pb_confirm_s: 120,
      pb_trade_max_loss: 8_000,
      pb_trade_target: 6_000,
      pb_trail_start: 0, // no floor before 13:00
      pb_late_trail_start: 2_000,
      pb_trail_keep: 0.5,
      // 1.5 x STR, not the spec's first 2.0: on a SENSEX contract five or
      // more sessions out, 2.0 x STR put the wings 25-30 strikes out, where
      // the quotes run rupees wide (the 16 Oct close: ₹20-40 SENSEX options
      // ₹1-3 wide) and a wing would seldom pass the liquidity bar, so the
      // book could go days without opening. At 1.5 x the wing is
      // dearer and quoted tighter, and the fly's worst loss at one lot (the
      // width less the credit) falls from about 2-2.5 x the Rs12,000 day stop
      // to about 1.1-1.5 x it (NIFTY ~Rs13.6k, SENSEX ~Rs18k at 12-13% IV).
      pb_wing_str_k: 1.5,
      pb_wing_min_steps: 4,
      pb_combined_stop: 0.25,
      pb_stop_str_k: 1.0,
      pb_max_move_k: 0.75,
      pb_gap_max_pct: 0.6,
      pb_stop_hold_s: 20,
      dl_day_max_loss: 12_000,
      dl_day_target: 12_000,
    },
  },
  {
    key: 'pb-reversal',
    label: 'Playbook — Reversal Spread',
    // §5.3: the V-day trade — a debit spread in the new direction once a
    // morning excursion has given back 35% of itself and the tape has turned.
    // No pyramid; the floor arms only from 13:00.
    dials: {
      ...PLAYBOOK_BASE,
      pb_playbook: 3,
      pb_min_dte: 1,
      pb_entry_start_min: 600, // 10:00
      pb_entry_end_min: 810, // 13:30
      pb_max_entries: 1,
      pb_confirm_s: 120,
      pb_trade_max_loss: 6_000,
      pb_trade_target: 12_000,
      pb_target_max_frac: 0.7, // the same band pair, the same ceiling: see Trend Drive
      pb_trail_start: 0, // no floor before 13:00
      pb_late_trail_start: 2_000,
      pb_trail_keep: 0.6,
      pb_strike_mode: 0, // delta bands
      pb_debit_stop_frac: 0.4,
      pb_flip_confirm_s: 90,
      pb_max_adds: 0,
      pb_rev_min_ext: 0.6,
      pb_rev_retrace: 0.35,
      pb_rev_stop_k: 0.1,
      pb_stop_hold_s: 20,
      dl_day_max_loss: 9_000,
      dl_day_target: 15_000,
    },
  },
  {
    key: 'pb-expiry-drive',
    label: 'Playbook — Expiry Drive',
    // §5.4: Trend Drive on the contract that expires today, on a morning that
    // has already gapped, struck in straddle units (D7: the 0-DTE books
    // measure in the market's own unit), and out by 12:00, before the theta
    // afternoon.
    dials: {
      ...PLAYBOOK_BASE,
      pb_playbook: 4,
      pb_min_dte: 0,
      pb_expiry_day_only: true,
      pb_entry_start_min: 570, // 09:30
      pb_entry_end_min: 615, // 10:15
      pb_max_entries: 1,
      pb_confirm_s: 90,
      pb_trade_max_loss: 4_000,
      pb_trade_target: 5_000,
      // ...and never more than 0.7 x the held spread's maximum: a two-step
      // SENSEX pair on a calm expiry morning tops out near Rs5,300 at 2 lots,
      // where Rs5,000 is 94% of it and out of reach before the 12:00 exit.
      pb_target_max_frac: 0.7,
      pb_trail_start: 3_000,
      pb_late_trail_start: 3_000,
      pb_trail_keep: 0.6,
      pb_time_exit_min: 720, // 12:00
      pb_strike_mode: 1, // straddle units
      // 1.0 x STR, not the spec's first 0.6: on a 0-DTE morning STR is a
      // strike or two, so 0.6 x STR collapsed to a ONE-step spread whose
      // maximum profit (~Rs3.9-5.1k at 2 lots) sat at or under the Rs5,000
      // take profit and whose debit sat under the Rs4,000 hard stop — two
      // exits that could never fire (Task 9 finding). A full straddle's width
      // gives a two-step spread on NIFTY and SENSEX at ordinary 0-DTE vol.
      // On NIFTY that spread's whole debit (~Rs3.2-3.6k at 10-12% IV) is
      // still under the Rs4,000 hard stop, which therefore cannot bind there:
      // the 50% debit stop is the working stop (engine review note).
      pb_short_str_k: 1.0,
      pb_debit_stop_frac: 0.5,
      pb_flip_confirm_s: 60,
      pb_gap_min_pct: 0.25,
      dl_day_max_loss: 6_000,
      dl_day_target: 10_000,
    },
  },
  {
    key: 'pb-expiry-theta',
    label: 'Playbook — Expiry Theta Fly',
    // §5.5: the last hours of a 0-DTE straddle, sold as an iron fly into a
    // calm afternoon and left the moment a trend has held a minute. No trail,
    // no rupee target: the credit target, the hard stop and the 14:50 passive
    // flatten take it off.
    dials: {
      ...PLAYBOOK_BASE,
      pb_playbook: 5,
      pb_min_dte: 0,
      pb_expiry_day_only: true,
      pb_entry_start_min: 780, // 13:00
      pb_entry_end_min: 855, // 14:15
      pb_max_entries: 2,
      pb_reentry_cooldown_s: 900,
      pb_confirm_s: 120,
      pb_trade_max_loss: 4_000,
      pb_trade_target: 0, // off: the credit target is the profit exit
      // OFF, before and after 13:00 alike — the whole window is past
      // `pb_late_min`, where the default late start would arm a trail.
      pb_trail_start: 0,
      pb_late_trail_start: 0,
      pb_wing_str_k: 1.25,
      pb_wing_min_steps: 2,
      pb_combined_stop: 0,
      pb_stop_str_k: 0,
      pb_calm_min: 30,
      pb_calm_mult: 1.5,
      pb_max_move_k: 1.2,
      pb_target_frac: 0.5,
      pb_trend_exit_s: 60,
      dl_day_max_loss: 8_000,
      dl_day_target: 10_000,
    },
  },
  {
    key: 'pb-expiry-gamma',
    label: 'Playbook — Expiry Gamma Breakout',
    // §5.6: one out-of-the-money 0-DTE option bought on the break of a calm
    // afternoon box, sized to a ₹6,000 premium budget, with its own premium
    // stop and premium trail. The common rupee trail is OFF (both starts 0):
    // the premium trail replaces it.
    dials: {
      ...PLAYBOOK_BASE,
      pb_playbook: 6,
      pb_min_dte: 0,
      pb_expiry_day_only: true,
      pb_entry_start_min: 750, // 12:30
      pb_entry_end_min: 870, // 14:30
      pb_max_entries: 2,
      pb_reentry_cooldown_s: 600,
      pb_confirm_s: 30,
      pb_trade_max_loss: 4_000,
      pb_trade_target: 0, // off
      pb_trail_start: 0,
      pb_late_trail_start: 0,
      pb_trail_keep: 0.6,
      pb_box_min: 60,
      pb_box_max_k: 1.5,
      pb_brk_buf_k: 0.5,
      pb_premium_budget: 6_000,
      pb_gamma_max_lots: 4,
      pb_otm_steps: 1,
      pb_prem_stop_frac: 0.5,
      pb_prem_trail_arm: 0.8,
      pb_stop_hold_s: 30,
      dl_day_max_loss: 8_000,
      dl_day_target: 15_000,
    },
  },
  // BULL-S on Delta BTC options — last, so every NSE preset keeps its place.
  { key: 'bull-s-btc-daily', label: 'BULL-S — BTC daily ($200 grid)', dials: bullS(200, 50, 50, 150, 250, 1) },
  { key: 'bull-s-btc-daily-2', label: 'BULL-S — BTC daily, jump 2 ($400 grid)', dials: bullS(200, 50, 50, 150, 250, 2) },
  { key: 'bull-s-btc-weekly', label: 'BULL-S — BTC weekly ($500 grid)', dials: bullS(500, 10, 10, 30, 500, 1) },
  { key: 'bull-s-btc-weekly-2', label: 'BULL-S — BTC weekly, jump 2 ($1,000 grid)', dials: bullS(500, 10, 10, 30, 500, 2) },
  { key: 'bull-s-btc-monthly', label: 'BULL-S — BTC monthly ($1,000 grid)', dials: bullS(1000, 10, 10, 30, 500, 1) },
  { key: 'bull-s-btc-monthly-2', label: 'BULL-S — BTC monthly, jump 2 ($2,000 grid)', dials: bullS(1000, 10, 10, 30, 500, 2) },
];

/**
 * Trader books (apps/traders advice): relief-r counting the WHOLE book's
 * delta (spec P2), target lock off. Everything else is relief-r exactly.
 *
 * Two dials differ from `recenter-relief-r`:
 *   - `delta_shorts_only: false` — a trader's long legs are theirs; the
 *     corridor reads the delta the BookView shows.
 *   - `target_pnl: 0` — on a clean-state pass relief-r's lock returns a
 *     non-null hold ("confirming 1/3") on any book at or above ₹2,50,000,
 *     before the corridor runs, so advice would go silent on exactly the
 *     profitable books. 0 turns the lock off.
 *
 * Deliberately NOT in `PRESETS`: `presets.test.ts` pins that list at 25
 * presets with target 250000, and a member would also appear in the desk's
 * dials picker.
 */
export const TRADER_PRESET: Preset = {
  key: 'trader',
  label: 'Trader (relief-r, whole-book delta)',
  dials: {
    ...RELIEF_BOARD,
    delta_shorts_only: false,
    gamma_shorts_only: true,
    target_pnl: 0,
  },
};
