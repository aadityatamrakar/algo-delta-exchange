/**
 * ONE DIAL SCHEMA, WITH A TYPED OFF-STATE FOR EVERY FIELD.
 *
 * What this prevents is the single worst class of bug in the Python desk it
 * replaces: a dial meaning three different things depending on which `.get()`
 * reached it first. In `playbooks.py` a dial could be ABSENT, present-and-zero,
 * or present-and-`None`, and the rules read those inconsistently —
 * `p.get("shift_margin_frac", 0.0) or 0.0` treats absent and 0 alike (the gate
 * is off, but the SHIFTING is on), while `p.get("balance_min_dte", 0) or 0`
 * treats 0 as "tier off", and `p.get("trend_skew")` treats an explicit `None`
 * as off. Reading a variant's behaviour therefore meant reading the whole
 * function, and the same dial name did not mean the same thing twice.
 *
 * Here every field is REQUIRED and every off-state is a value the type system
 * can see: a section that can be switched off has a boolean toggle
 * (`shift_enabled`, `unwind_enabled`, `trend_enabled`, `balance_enabled`, and
 * `delta_lean_enabled`, which switches the whole second decide path), and
 * a field whose off-state is genuinely numeric says so in one place (§5:
 * `tol_ref_dte` 0, `min_band_lots` 0, `eod_flat_min` 0, `recycle_frac` 0,
 * `anchor_ema_marks` 0, `min_sell_delta` 0, `scrap_close_delta` 0 — and
 * `pb_playbook` 0, which selects no playbook at all and leaves every other
 * `pb_*` dial unread; six-playbooks spec §8.1). There is no `undefined`
 * anywhere in a `Dials`, so no consumer has to guess.
 *
 * The values are NOT invented. `DEFAULT_DIALS` is the operator-approved table
 * in the design spec (`docs/superpowers/specs/2026-08-21-recenter-supervisor-
 * migration-design.md:226-267`), which states the relief-r LIVE set — the
 * dials the live desk actually runs. Two of those are worth naming because
 * they look like typos and are not:
 *
 *   `shift_margin_frac` 0.60 is an OPERATOR DECISION (2026-08-16). The
 *   relief-convexity study suggested ~0.02 so the strike shift could fire
 *   under the margin cap; the operator kept the conservative gate. Do not
 *   "fix" it without the operator saying so again (playbooks.py:467-471).
 *
 *   `margin_cap` is the one row the spec table writes as "per-book" rather
 *   than a number. It is ₹10cr here because that is the `default_margin_cap`
 *   every recenter variant carries (`variants.py:387-564`) and because
 *   `DEFAULT_DIALS` is the relief-r live set: relief's shift gate is a
 *   FRACTION OF THE CAP, so a 0 here would silently disable the shift the
 *   preset exists for (§5 — "an uncapped book never shifts"). A book row
 *   overrides it.
 *
 * ── WHY `resolveDials` NAMES WHAT IT REJECTS ────────────────────────────────
 * Dials live in `desk-books-registry.dials`, a free-form Mongo document that
 * humans hand-edit. A key the schema does not know — a leftover from a retired
 * variant, a typo, a value of the wrong type — must come back in `unknown` so
 * the dashboard can render it as an error row rather than dropping it (spec
 * §11 / plan F-29). Silently swallowing it is an operator who set a limit that
 * never applied, and only found out from the P&L.
 *
 * Wrong-TYPE values land in `unknown` for the same reason and are never
 * coerced: `1` for a boolean is what a hand-edited document looks like, and
 * coercing it turns a typo into a live behaviour change nobody was told about.
 * Non-finite numbers go the same way — a NaN `delta_tol_pct` makes `allowed`
 * NaN, every comparison false, and the book sheds on arithmetic nobody wrote.
 *
 * Pure: no storage, no clock, no defaults read from the environment.
 */

export interface Dials {
  // Corridor
  readonly delta_tol_pct: number; readonly delta_shorts_only: boolean;
  readonly gamma_shorts_only: boolean; readonly tol_ref_dte: number;
  // Shift
  readonly shift_enabled: boolean; readonly shift_itm_steps: number;
  readonly shift_land_steps: number; readonly shift_margin_frac: number;
  readonly hedge_after_shift: boolean;
  // Band floor
  readonly min_band_lots: number; readonly no_band_floor: boolean;
  // Shed
  readonly shed_scan_strikes: number; readonly strikes_out: number;
  readonly min_sell_dte: number; readonly min_sell_delta: number;
  readonly scrap_close_delta: number;
  // Tiers
  readonly unwind_enabled: boolean;
  readonly recycle_frac: number; readonly recycle_bank: boolean; readonly recycle_opposite: boolean;
  readonly eod_flat_min: number;
  readonly trend_enabled: boolean; readonly trend_skew: number;
  readonly anchor_ema_marks: number; readonly confirm_marks: number;
  // Risk
  readonly target_pnl: number; readonly margin_cap: number;
  // Execution
  readonly work_tranche_lots: number; readonly chase_max_ms: number;
  readonly chase_cross_buffer_pct: number; readonly rest_max_min: number;
  // Tick
  readonly confirm_ms: number; readonly cooldown_s: number;
  // Advanced
  readonly scrap_close_px: number; readonly min_sell_px: number;
  readonly crash_delta: number; readonly target_confirm_marks: number;
  readonly lock_exclude_mark0: boolean; readonly lock_executability: boolean;
  readonly target_snap_multiple: number; readonly lock_branch_lots: number;
  readonly sell_max_spread_pct: number; readonly quote_max_age_ms: number;
  readonly balance_min_dte: number; readonly balance_enabled: boolean;

  // ── DELTA LEAN ────────────────────────────────────────────────────────────
  // A SECOND DECIDE PATH, not a tier of the first. `delta_lean_enabled` picks
  // which `decide()` `EngineHost` calls; every `dl_*` dial below is read by
  // that path and by nothing else, and every dial above is read by the
  // recenter path and by nothing else — except `confirm_ms`/`cooldown_s`,
  // which live in the HOST's damping and so are shared. They are all in one
  // `Dials` because a book is one row with one dial document, and splitting
  // the schema by path would put the resolver back in the business of
  // guessing which half a stored key belonged to.
  //
  // Numbers are the design spec's §4 dial table, AGGRESSIVE column
  // (`docs/superpowers/specs/2026-09-22-delta-lean-hold-adjust-design.md`),
  // with one row since moved by an operator decision: `dl_day_max_loss`, R1 of
  // `docs/reports/2026-10-04-delta-lean-review.md`. `presets.ts` carries the
  // conservative column.

  // The path selector
  readonly delta_lean_enabled: boolean;
  // ── Budget and the four exits (hold-and-adjust spec §4, §6.5) ────────────
  /** The DISASTER BACKSTOP (D6), not a working stop. `totalPnl <= -this`
   * flattens urgently and latches the day. Sized to the BOOK, not the fund,
   * since R1 of `docs/reports/2026-10-04-delta-lean-review.md` (applied
   * 2026-10-05): 30,000 aggressive, 15,000 conservative — where §4 had
   * 200,000 (8% of the fund) on both. It is the one exit that acts on a book
   * whose posture is met while gamma eats it; the stuck exit cannot fire
   * there by design (§6.4). The desk day guard arms behind it at 1.5x. */
  readonly dl_day_max_loss: number;
  /** Rupees, realised PLUS unrealised. Reaching it closes the book and stops
   * the day — the operator's "exit on the day target". 0 = OFF, on both
   * delta-lean paths (delta-lean-zero spec D4): the zero books hold to the
   * clock with no target at all. */
  readonly dl_day_target: number;
  /** CONTRACT LOTS per leg at open, and the size a pyramid add starts from
   * (D7). Not delta-lots: the operator sizes in lots. */
  readonly dl_open_lots: number;
  /** With the cap or the adjust limit blocking every move, a loss past this
   * arms the stuck exit (§6.4). */
  readonly dl_stuck_loss: number;
  /** How long blocked-AND-losing must persist before the stuck exit fires. */
  readonly dl_stuck_confirm_s: number;
  /**
   * HOLD BOOKS ONLY: the backstop and the target fire on a reading that has
   * stood this long, continuously (2026-10-30). A hold book's first marks at
   * 09:15 blend legs already on today's book with legs still on the last
   * session's; on 19 Oct that read Rs-16,289 on a book whose close banked
   * +7,797, and stopped it. Every opening swing on file was gone by the desk's
   * next 15s mark, 18s in at most, so 60 holds it with margin and still lets
   * a real breach out within the minute. A FLAT book acts at once. Unread on
   * an intraday book, which is flat overnight and acts on the first mark;
   * 0 = the first mark on a hold book too.
   */
  readonly dl_rupee_hold_s: number;

  // ── The open (spec §6.1; delta-lean-zero spec D4, D5) ────────────────────
  // WHEN, ON WHAT, AND ON WHICH DAY the day's one package may go on. Read by
  // step 6 of `decideDeltaLean` and by nothing else: no exit, no adjustment
  // and no clock consults them. At their defaults the book opens on any
  // confirmed trend or quiet at any time before the flatten — the open every
  // delta-lean book had before they existed.
  /** The LAST minute of the day, inclusive, in which the open may go on. Past
   * it, a book that has not opened stands down for the day. 0 = no limit. */
  readonly dl_open_by_min: number;
  /** In `dl_open_by_min`'s own minute, with no confirmed regime that opens,
   * open the QUIET package anyway — on any reading but `'unknown'`, which
   * never sells. Inert while `dl_open_by_min` is 0 or `dl_open_quiet` is off. */
  readonly dl_open_fallback: boolean;
  /** A confirmed trend-up may open the call debit spread. */
  readonly dl_open_trend_up: boolean;
  /** A confirmed trend-down may open the put debit spread. */
  readonly dl_open_trend_down: boolean;
  /** A confirmed quiet may open the strangle with wings — and so may the
   * fallback, which opens the same package: off, the book sells no condor. */
  readonly dl_open_quiet: boolean;
  /** The book opens only on its contract's expiry day (`dateIst === expiry`).
   * Every other day it idles; the roll creates it only on that morning. */
  readonly dl_expiry_day_only: boolean;

  // ── Adjustment gating (spec §5 step 7, §6.2) ─────────────────────────────
  /** A regime must hold this long before it justifies the open or an
   * adjustment. The book's patience, in one dial. */
  readonly dl_adjust_confirm_s: number;
  /** Minimum gap between packages. The open counts as the first. */
  readonly dl_adjust_cooldown_s: number;
  /** Adjustment packages allowed AFTER the open. The open is not counted. */
  readonly dl_max_adjusts_day: number;

  // ── Regime detector (`regime.ts`, unchanged) ─────────────────────────────
  readonly dl_fast_window_s: number; readonly dl_slow_window_s: number;
  readonly dl_context_window_s: number; readonly dl_context_on: boolean;
  readonly dl_trend_mult: number; readonly dl_trend_exit_mult: number;
  readonly dl_clean_min: number; readonly dl_quiet_mult: number;
  readonly dl_regime_dwell_s: number;

  // ── Strike selection (`express.ts`) ──────────────────────────────────────
  readonly dl_long_delta_lo: number; readonly dl_long_delta_hi: number;
  readonly dl_short_delta_lo: number; readonly dl_short_delta_hi: number;
  readonly dl_credit_short_delta_max: number; readonly dl_wing_delta: number;
  readonly dl_min_strike_gap: number;
  /**
   * The band the SIDEWAYS NEUTRALISING SALE is picked in (D5).
   *
   * The operator asked for an in-the-money sale; ATM (0.45-0.60) carries the
   * same net-delta effect with more time value and a better book, and a BAND
   * rather than a constant is what lets it be pushed in the money later.
   */
  readonly dl_neutral_short_delta_lo: number;
  readonly dl_neutral_short_delta_hi: number;
  /**
   * The dead band, in DELTA-LOTS OF NET BOOK EXPOSURE.
   *
   * A posture inside this is already met and nothing is worth a spread. It is
   * net exposure now, not a per-package excess: the whole controller reduces to
   * "where is the book's delta, and where does the regime want it".
   */
  readonly dl_dead_band_lots: number;

  // ── Liquidity and staleness ──────────────────────────────────────────────
  readonly dl_quote_fresh_s: number; readonly dl_max_spread_pct: number;
  readonly dl_max_spread_abs: number;
  /** Spot older than this refuses NEW RISK — the open and every adjustment.
   * Exits never consult it: deciding an exit on a ten-second-old price is
   * safer than not exiting. */
  readonly dl_spot_stale_s: number;

  // ── Clock and pacing ─────────────────────────────────────────────────────
  readonly dl_warmup_min: number;
  readonly dl_flatten_passive_min: number; readonly dl_flatten_urgent_min: number;
  readonly dl_flat_by_min: number;
  readonly dl_eval_min_ms: number;
  readonly dl_max_orders_min: number;
  /**
   * The per-SECOND order budget (spec §8), and THE HOST ENFORCES IT, not the
   * engine.
   *
   * `decideDeltaLean` is a pure function of one tick: it can see how many orders
   * it is about to emit but not how many the previous second's package already
   * put on the wire, and one decision legitimately emits four (a debit pair plus
   * a theta offset). Counting routed orders OVER TIME is the job of the thing
   * that routes them, so this dial is carried here — one dial document per book,
   * one authority — and read by the supervisor's host.
   */
  readonly dl_max_orders_s: number;
  /**
   * The whole DAY's order budget (spec §8). THE HOST ENFORCES IT, for the same
   * reason as `dl_max_orders_s`: a per-tick pure function cannot count a day.
   */
  readonly dl_max_orders_day: number;

  // ── Lifecycle (hold-to-expiry spec, 2026-10-05) ──────────────────────────
  /**
   * HOLD THE BOOK TO ITS CONTRACT'S EXPIRY instead of flattening it every day.
   *
   * The ONLY thing that distinguishes the weekly family from the intraday one
   * — membership is by this dial, never by tag text. When true:
   *
   *   1. the 14:50/14:55/15:00 clock ladder runs only when `dateIst` is the
   *      book's `expiry` or past it; every day before, the book carries
   *      overnight and freezes (no opens, no adjustments) from 14:50;
   *   2. the package is opened ONCE for the book's life (`rollDay` keeps
   *      `dlOpenedMs` and `dlOpenSide`);
   *   3. `dl_day_target`, `dl_day_max_loss` and the stuck exit are BOOK-LIFE
   *      exits: the latch survives the day roll, and target/backstop read the
   *      tag's lifetime P&L (which `totalPnl` already is);
   *   4. target and backstop fire only on a reading held `dl_rupee_hold_s`.
   *
   * Everything else — the per-day counters, the warm-up, the adjustments, the
   * guards — still runs by the day.
   */
  readonly dl_hold_to_expiry: boolean;
  /**
   * PRICE THIS BOOK'S CHAIN OFF ITS OWN EXPIRY'S FORWARD (six-playbooks spec
   * F1), not the near-month future's mid.
   *
   * Read by the HOST's chain view, never by the engine: with it on,
   * `ChainSnap.spot` is the weekly's parity forward, falling back to the index
   * carried over the contract's tenor, then to the future's mid — and so every
   * ATM, delta and band strike on the book is picked off the right number. A
   * DIAL rather than a property of the delta-lean path because it moves every
   * strike a book picks, and a change that large must arrive on a book only
   * with that book's own row: a row registered before it existed resolves it
   * off and keeps the future. The host's `DESK_CHAIN_FORWARD=future` turns it
   * off for every book at once.
   */
  readonly dl_parity_forward: boolean;

  // ── PLAYBOOKS (six-playbooks spec §4, §8.1) ───────────────────────────────
  // A playbook book IS a delta-lean book (`delta_lean_enabled` true) whose
  // `pb_playbook` names one of six strategies, and the host then hands it to
  // the playbook frame instead of `decideDeltaLean`. Everything the host does
  // for a delta-lean book — the spot ring, the cadence, the order budgets, the
  // fast exits, the day guard, the roll — still applies, which is why these
  // live beside the `dl_*` dials rather than behind a second path switch.
  //
  // `pb_playbook` 0 IS THE OFF-STATE, and there is no toggle: every other
  // dial below is unread while it is 0, so no existing book moves when they
  // are added. The playbook frame still reads the delta-lean dials it shares —
  // the clock, the day's backstop and target (`dl_day_max_loss`,
  // `dl_day_target`), the warm-up, the index staleness bar, the regime
  // detector, the delta bands and the liquidity bar — and `margin_cap`.
  //
  // Every ₹ figure is per TRADE unless it says otherwise; the day's are the
  // `dl_day_*` pair.

  // Selection and contract
  /** 0 = not a playbook book; 1-6 select spec §5.1-§5.6. */
  readonly pb_playbook: number;
  /**
   * The contract has at least this many TRADING days to expiry, or the book
   * does not enter: the sessions after today up to and including the expiry
   * day, holidays removed (`tradingDaysToExpiry`), so 0 allows today's
   * contract. Sessions rather than calendar days because a Friday's Monday
   * weekly is one session, not three (D8: an intraday playbook never trades
   * 0-DTE).
   */
  readonly pb_min_dte: number;
  /** Trade only when the contract expires today — the three expiry books. */
  readonly pb_expiry_day_only: boolean;

  // Sizing and the entry window
  /** Lots per leg at entry. The frame truncates it to `margin_cap`. */
  readonly pb_lots: number;
  /** The entry window, in IST minutes: `[start, end)`. */
  readonly pb_entry_start_min: number; readonly pb_entry_end_min: number;
  /** Trades per day. */
  readonly pb_max_entries: number;
  /** Seconds after an exit before a new entry may be considered. */
  readonly pb_reentry_cooldown_s: number;
  /** How long the slow regime must have held before it justifies an entry. */
  readonly pb_confirm_s: number;
  /** The opening gap, `|O - previous close|` as a % of the close, must be AT
   * LEAST this (a trend book wants a morning that has already moved), or
   * LESS than the max (a short-premium book wants one that has not). Each:
   * 0 = off. Applied only when the gap is KNOWN (spec v2 §4.3): an unknown
   * previous close (`md.spot` carries none, or the day is not complete) is not
   * a small gap, nor a large one — the gate is skipped and the entry's reason
   * says so, so a desk whose feed never carries the close still trades on its
   * regime gates alone. */
  readonly pb_gap_min_pct: number; readonly pb_gap_max_pct: number;
  /** No new entry within this many seconds of the last routed package
   * (`dlLastAdjustMs`): an open the desk refused or dropped is retried at
   * this pace, not on every pass. */
  readonly pb_retry_s: number;
  /** A hole in the index tape longer than this many minutes — a feed outage,
   * a restart — makes the day's high and low INCOMPLETE (`dayRobust` false):
   * they may have missed the very move a rule would read off them. */
  readonly pb_max_gap_min: number;

  // The common exits (spec §4.5)
  /** ₹ hard stop per trade: `tradePnl <= -this` exits urgently. */
  readonly pb_trade_max_loss: number;
  /** ₹ take profit per trade, held `pb_rupee_hold_s`, worked passively; on a
   * whole debit spread, capped by `pb_target_max_frac`. 0 = off. */
  readonly pb_trade_target: number;
  /**
   * ₹ of trade P&L that ARMS the trailing floor — before `pb_late_min`, and
   * from it on. 0 = off. Two numbers because winners run late (spec §1.1: a
   * book up ₹2,000 at 13:00 never finished below it), so the floor arms on
   * less once the afternoon starts (D5).
   */
  readonly pb_trail_start: number; readonly pb_late_trail_start: number;
  /** The IST minute the late trail start takes over. 780 = 13:00. */
  readonly pb_late_min: number;
  /** The floor, as a fraction of the trade's peak P&L. */
  readonly pb_trail_keep: number;
  /** Close at this IST minute, final for the day. 0 = off. */
  readonly pb_time_exit_min: number;
  /** Seconds an index-based stop's condition must hold before it fires — a
   * single bad print is never a stop (spec M11). */
  readonly pb_stop_hold_s: number;
  /** Seconds a RUPEE exit's condition must hold before it fires — every stop,
   * the trail and both take profits, and the frame's day backstop and day
   * target (the backstop at once past 1.25 x its floor): one mark off a
   * briefly wide quote is not a loss, nor a profit. */
  readonly pb_rupee_hold_s: number;

  // Debit spreads (Trend Drive, Reversal Spread, Expiry Drive)
  /** 0 = delta bands (`dl_long_delta`/`dl_short_delta`); 1 = straddle units. */
  readonly pb_strike_mode: number;
  /** The short's distance from the long in straddle units, with
   * `pb_strike_mode` 1 — never less than one step. */
  readonly pb_short_str_k: number;
  /** Exit after losing this share of the debit paid. 0 = off. */
  readonly pb_debit_stop_frac: number;
  /**
   * The take profit's CEILING on a whole debit spread: at most this share of
   * the most the held spread can make (width x lots x lot size, less the
   * debit). 0 = off. A rupee target is one number for every contract, and a
   * one-session spread is narrow — SENSEX's 1-DTE pair tops out under the
   * ₹12,000 target — so without a ceiling the take profit could never fire.
   * Read only while the book is exactly one vertical, every short held; a
   * naked long beside it (the pyramid add) has no ceiling, and the plain
   * `pb_trade_target` applies.
   */
  readonly pb_target_max_frac: number;
  /** An opposite trend held this many seconds exits. 0 = off. */
  readonly pb_flip_confirm_s: number;
  /** Pyramid adds per trade (D6: never without a cap), and the extension
   * beyond the entry needed for one, in `Dday`. */
  readonly pb_max_adds: number; readonly pb_add_ext_k: number;

  // Short premium (Wing Straddle, Expiry Theta Fly)
  /** The fly's wing distance: max(`pb_wing_min_steps`, round(k x STR / step))
   * steps either side of the centre — in straddle units (D7), with a floor in
   * steps so a cheap straddle cannot collapse the wings onto the centre. */
  readonly pb_wing_str_k: number; readonly pb_wing_min_steps: number;
  /** Exit once the shorts' ask-side value has risen by this fraction of their
   * entry value. 0 = off. */
  readonly pb_combined_stop: number;
  /** The index stop: exit once the INDEX (`S`, never the chain forward) has
   * moved this far from where the trade opened, `|S - entrySpot|`, in units of
   * the ATM straddle at entry (`entryStr`), held `pb_stop_hold_s`. Skipped
   * while the index is stale. 0 = off. */
  readonly pb_stop_str_k: number;
  /** The calm filter: the index's range over the last `pb_calm_min` minutes
   * must be within `pb_calm_mult` x the implied move over them. 0 min = off. */
  readonly pb_calm_min: number; readonly pb_calm_mult: number;
  /** Skip an entry when `|S - O|` > k x `Dday`. 0 = off. */
  readonly pb_max_move_k: number;
  /** Take this share of the credit received. 0 = off. */
  readonly pb_target_frac: number;
  /** A NEUTRAL trade exits once the slow regime is a trend that has held
   * this many seconds: a fly sold into a range is the wrong book in a trend.
   * 0 = off. */
  readonly pb_trend_exit_s: number;

  // Staging and the protective legs (spec §4.6)
  /** The stage-2 abort distance, in STR: an index that moved further than
   * this between the stages aborts the package — the book is closed rather
   * than sold into a different market from the one the plan was made in. */
  readonly pb_stage_abort_k: number;
  /** Seconds after the last open before stage 2 may route: the protective
   * legs' fills must have reached the book before a sale is decided on
   * them. */
  readonly pb_stage_gap_s: number;
  /** How old a PROTECTIVE (bought) leg's quote may be and still be traded.
   * Looser than `dl_quote_fresh_s`, because a far wing prints rarely and a
   * buy cannot leave the book naked. */
  readonly pb_wing_fresh_s: number;
  /** The rupee spread a PROTECTIVE (bought) leg may quote and still be
   * bought: its bar is the largest of `dl_max_spread_pct` x mid, this and
   * `dl_max_spread_abs`. Looser than a sale's, because the far wing is the
   * fly's protection and quotes wide (a ₹20-40 SENSEX wing is often ₹1-2
   * wide); paying the ask on a ₹2 spread is ₹1 over mid, ₹20 a SENSEX lot,
   * against stops of thousands. At or under `dl_max_spread_abs`, off. */
  readonly pb_wing_spread_abs: number;

  // Reversal Spread
  /** The morning excursion needed (in `Dday`), the share of it given back
   * before the fade, and the new-extreme stop's distance (in `Dday`). */
  readonly pb_rev_min_ext: number; readonly pb_rev_retrace: number; readonly pb_rev_stop_k: number;

  // Expiry Gamma Breakout
  /** The box's length in minutes, the widest it may be in implied moves over
   * it, and the breakout buffer in 5-minute implied moves. */
  readonly pb_box_min: number; readonly pb_box_max_k: number; readonly pb_brk_buf_k: number;
  /** ₹ premium per trade, the lot cap, and how many listed strikes beyond the
   * forward the option is bought. The premium IS the risk, so it is a budget. */
  readonly pb_premium_budget: number; readonly pb_gamma_max_lots: number; readonly pb_otm_steps: number;
  /** The premium stop and the premium trail's arming point, both as fractions
   * of the premium paid. */
  readonly pb_prem_stop_frac: number; readonly pb_prem_trail_arm: number;

  // ── BULL-S (Delta spec §6, plan Task 3) ───────────────────────────────────
  // A FOURTH decide path: a straddle sold each time the reference price
  // crosses a grid level, pyramided, each with its own combined stop.
  // `bs_enabled` is its master switch (an engine switch, like
  // `delta_lean_enabled`) and is off, so no existing book reads one dial
  // below. Prices are in the book's own price units (USD on Delta, ₹ on NSE),
  // sizes in CONTRACTS (lots), P&L in the book's currency.

  /** Selects the BULL-S decide path. */
  readonly bs_enabled: boolean;
  /** One strike, in price units, for this expiry class (Delta daily 200,
   * weekly 500, monthly 1000). REQUIRED > 0 while enabled; `resolveDials`
   * names a 0 and the engine holds on it. */
  readonly bs_strike_step: number;
  /** Strikes per grid step, 1 or 2: the grid is `jump × step`. Applies to new
   * entries; open straddles keep their strikes. */
  readonly bs_strike_jump: number;
  /** The combined stop: buy both legs back when the summed exit price is at
   * or past this multiple of the summed entry premium. Read live, so a change
   * reaches open straddles at the next decision. */
  readonly bs_stop_mult: number;
  /** What the stop sums: 1 = each leg's ASK (the price it can be bought back
   * at); 0 = each leg's LTP against the legacy `trunc`ated trigger (the NSE
   * parity basis). */
  readonly bs_stop_basis: number;
  /** The breach must hold this many seconds. 0 = on the first reading. */
  readonly bs_stop_confirm_s: number;
  /** The pyramid, in contracts: the first straddle's size, the step each
   * accepted entry adds, and the ceiling. `bs_lots_cap` 0 = uncapped — the NSE
   * parity setting only; every BTC preset caps. */
  readonly bs_lots_start: number;
  readonly bs_lots_step: number;
  readonly bs_lots_cap: number;
  /** Most straddles open at once. 0 = unlimited. */
  readonly bs_max_open: number;
  /** Book profit target and loss cap on the P&L since the last arm (net of
   * fees where the venue charges them). 0 = off. */
  readonly bs_target: number;
  readonly bs_loss_cap: number;
  /** After a target or loss halt: 0 = stay flat until Re-arm; 1 = re-arm by
   * itself once flat (new baseline, size back to start) and trade from the
   * next crossing. */
  readonly bs_after_halt: number;
  /** The first fresh price after Start or Re-arm counts as a crossing at the
   * nearest level (the legacy first-tick ATM sale). */
  readonly bs_enter_on_start: boolean;
  /** NEW entries only between these IST minutes of day, `from <= m < to`
   * (from > to wraps midnight), and on these IST weekdays (bit 0 = Sunday).
   * 0 / 1440 / 127 = always. Stops run at every hour. */
  readonly bs_entry_from_min: number;
  readonly bs_entry_to_min: number;
  readonly bs_entry_weekdays: number;
  /** No new entry within this many minutes of the expiry instant. 0 = off
   * (none at or after the instant regardless). */
  readonly bs_no_entry_before_expiry_min: number;
  /** Close everything and halt this many minutes before the expiry instant.
   * 0 = hold into settlement. */
  readonly bs_flat_before_expiry_min: number;
  /** A reference price older than this is not traded on: no entry, and it is
   * not counted as a crossing. Stops still run. */
  readonly bs_ref_max_age_s: number;
  /** A level whose entry the venue refused — nothing opened, or only one leg
   * and that leg closed as a half straddle — is not sold again for this many
   * seconds; after it, on its next crossing. 0 = off. */
  readonly bs_level_cooldown_s: number;
  /** One-shot commands as COUNTERS: the dashboard PATCHes +1, and the engine
   * acts once when the dial exceeds the count it has already seen. Close book
   * closes every straddle and halts; Re-arm clears a halt. */
  readonly bs_close_req: number;
  readonly bs_rearm_req: number;
}

/**
 * The relief-r LIVE dial set — design spec §5, transcribed. This is what a
 * book with no overrides sells against, so read it as a position, not as
 * boilerplate.
 */
export const DEFAULT_DIALS: Dials = {
  // Corridor — allowed = |netΓ| × delta_tol_pct × spot, on SHORT greeks only
  // (the operator's 2026-08-12 call; a long wing's positive gamma otherwise
  // narrows the band that steers the book — playbooks.py:424-465).
  delta_tol_pct: 0.02,
  delta_shorts_only: true,
  gamma_shorts_only: true,
  tol_ref_dte: 0, // off: no √dte band shrink

  // Shift ⏻ — phase S. See the shift_margin_frac note in the header.
  shift_enabled: true,
  shift_itm_steps: 0.5,
  shift_land_steps: 2,
  shift_margin_frac: 0.6,
  hedge_after_shift: false, // a shift mark returns without phase R

  // Band floor — the "no convexity to centre" guard and its two escapes.
  min_band_lots: 0, // off: no clamp
  no_band_floor: false, // the floor stands

  // Shed — phase R's candidate scan and its sell gates.
  shed_scan_strikes: 3,
  strikes_out: 2,
  min_sell_dte: 1,
  min_sell_delta: 0, // off
  scrap_close_delta: 0, // off: price scrap only

  // Tiers — each independently toggleable (§5).
  unwind_enabled: false,
  recycle_frac: 0, // off
  recycle_bank: false,
  recycle_opposite: false,
  eod_flat_min: 0, // off: no tol=0 sweep
  trend_enabled: false,
  trend_skew: 0.5, // inert while trend_enabled is false
  anchor_ema_marks: 0, // off
  confirm_marks: 0, // off

  // Risk
  target_pnl: 250000,
  margin_cap: 100000000, // ₹10cr; see the header note on "per-book"

  // Execution (§8)
  work_tranche_lots: 3,
  chase_max_ms: 30000,
  chase_cross_buffer_pct: 0.005,
  rest_max_min: 10,

  // Tick (§7)
  confirm_ms: 5000,
  cooldown_s: 30,

  // Advanced — engine defaults, rarely touched.
  scrap_close_px: 0.1,
  min_sell_px: 0, // off
  crash_delta: 0.6,
  target_confirm_marks: 3,

  // ── the four lock refinements (`engine.py:160-185`) ──────────────────────
  // Every one of these is OPT-IN in Python — `bool(p.get(...))` or
  // `float(p.get(..., 0.0) or 0.0)` — and NO recenter preset sets any of them
  // (`playbooks.py:349-478`). So the typed off-state is the value that
  // reproduces the twelve recorded boards, and `guards.ts` reads each one's
  // off-state as "this refinement does not exist" rather than as a number.
  lock_exclude_mark0: false, // off: the day's first mark can arm, count and snap
  lock_executability: false, // off: an early-session print counts like any other
  target_snap_multiple: 0, // off: no immediate bank, the streak is the only path
  // 0 = off, and it is the only numeric off-state on this row that ISN'T
  // Python's own: Python spells "no two-branch lock" as `None`
  // (`engine.py:164-165`) and 0 there would mean "branch at zero naked lots".
  // `Dials` carries `number | boolean` only (§5 storage), so 0 is the off-state
  // and `guards.ts` says in one place what a positive value buys.
  lock_branch_lots: 0,

  sell_max_spread_pct: 0.25,
  quote_max_age_ms: 120000,
  balance_min_dte: 7, // inert while balance_enabled is false
  balance_enabled: false,

  // ── THE DELTA-LEAN BOOK, spec §4's AGGRESSIVE column ─────────────────────
  // `DEFAULT_DIALS` IS that column, field for field (with R1's backstop, below),
  // which is why the aggressive preset states nothing but the base (`presets.ts`).
  //
  // Off, and it must STAY off here. Every recenter book in `desk-books-
  // registry` resolves against this table, so a true would move all of them
  // onto the second decide path with no row edited and no operator told.
  // A delta-lean book turns it on through its preset (`presets.ts`).
  delta_lean_enabled: false,

  // Budget and the four exits
  //
  // THE ONE ROW THAT IS NOT §4's: the review's R1 (2026-10-04, applied
  // 2026-10-05) moved the backstop from 200,000 to 30,000 — about 3.3x the
  // worst aggressive book-day outside 1 Oct, and the line 1 Oct's aggressive
  // book crossed at 12:50. `apps/api` arms the desk guard at 45,000 off it.
  dl_day_max_loss: 30_000,
  dl_day_target: 10_000,
  dl_open_lots: 4,
  dl_stuck_loss: 25_000,
  dl_stuck_confirm_s: 300,
  // 60 HERE, not in the hold presets: the hold rows on file were registered
  // without the dial and must resolve it with no data patch, and a hold
  // preset is pinned to its intraday column plus `dl_hold_to_expiry` alone.
  // An intraday row resolves the same 60 and never reads it.
  dl_rupee_hold_s: 60,

  // The open. Every one at the value that reproduces the open as it was
  // before these dials existed — no window, every regime, every day — so a
  // registry row resolved against this table opens exactly as it always did.
  dl_open_by_min: 0,
  dl_open_fallback: false,
  dl_open_trend_up: true,
  dl_open_trend_down: true,
  dl_open_quiet: true,
  dl_expiry_day_only: false,

  // Adjustment gating
  dl_adjust_confirm_s: 60,
  dl_adjust_cooldown_s: 600,
  dl_max_adjusts_day: 6,

  // Regime detector — unchanged from v1; `regime.ts` is not touched.
  dl_fast_window_s: 60, dl_slow_window_s: 300, dl_context_window_s: 900,
  dl_context_on: true,
  dl_trend_mult: 2, dl_trend_exit_mult: 1.2, dl_clean_min: 0.6,
  dl_quiet_mult: 0.7,
  dl_regime_dwell_s: 120,

  // Strike selection
  dl_long_delta_lo: 0.55, dl_long_delta_hi: 0.65,
  dl_short_delta_lo: 0.2, dl_short_delta_hi: 0.3,
  dl_credit_short_delta_max: 0.3, dl_wing_delta: 0.1,
  dl_min_strike_gap: 1,
  dl_neutral_short_delta_lo: 0.45, dl_neutral_short_delta_hi: 0.6,
  // 0.5 delta-lots of NET book exposure — half a future's worth. Twice the v1
  // number, because this is the whole book's position rather than a per-package
  // excess, and adjusting for less than half a lot is paying a spread to stand
  // still.
  dl_dead_band_lots: 0.5,

  // Liquidity and staleness
  dl_quote_fresh_s: 3, dl_max_spread_pct: 0.02, dl_max_spread_abs: 1,
  dl_spot_stale_s: 10,

  // Clock and pacing. 09:30 warm-up, 14:50 passive, 14:55 urgent, 15:00 out.
  dl_warmup_min: 570,
  dl_flatten_passive_min: 890, dl_flatten_urgent_min: 895, dl_flat_by_min: 900,
  dl_eval_min_ms: 1_000, dl_max_orders_min: 40,
  // 2 a second and 40 a day, both enforced by the HOST rather than the engine
  // (see the `Dials` doc comments). 40 is twice §8's ~20-orders-a-book-a-day
  // design ceiling and still a third of the 09-22 incident.
  dl_max_orders_s: 2, dl_max_orders_day: 40,

  // Lifecycle. OFF, and it must stay off here for the reason
  // `delta_lean_enabled` must: every registry row resolves against this
  // table, and a true would turn every intraday book into a weekly carry with
  // no row edited. The hold presets turn it on (`presets.ts`).
  dl_hold_to_expiry: false,
  // OFF here for the same reason, and it is the one `dl_` dial the delta-lean
  // base DOES restate: a row registered before the parity forward existed
  // resolves against this table and keeps the future it was measured on.
  // `DELTA_LEAN_BASE` turns it on, so every delta-lean preset — and every
  // playbook — carries it in its own row.
  dl_parity_forward: false,

  // ── THE PLAYBOOKS, six-playbooks spec §8.1 ────────────────────────────────
  // `pb_playbook` 0 and it must STAY 0 here, for the reason
  // `delta_lean_enabled` must stay false: every registry row resolves against
  // this table, and a non-zero would hand every delta-lean book to the
  // playbook frame with no row edited. The six presets set it (`presets.ts`).
  // Every value below is INERT while it is 0, and each is §8.1's default —
  // or, for the eight the spec review added, the review's.
  pb_playbook: 0,
  pb_min_dte: 1,
  pb_expiry_day_only: false,
  pb_lots: 2,
  pb_entry_start_min: 570, pb_entry_end_min: 615, // 09:30-10:15
  pb_max_entries: 1,
  pb_reentry_cooldown_s: 1200,
  pb_confirm_s: 120,
  pb_gap_min_pct: 0, pb_gap_max_pct: 0, // off
  pb_retry_s: 30,
  pb_max_gap_min: 5,
  pb_trade_max_loss: 5000,
  pb_trade_target: 10000,
  pb_trail_start: 4000, pb_late_trail_start: 2000,
  pb_late_min: 780, // 13:00
  pb_trail_keep: 0.6,
  pb_time_exit_min: 0, // off
  pb_stop_hold_s: 20,
  pb_rupee_hold_s: 3,
  pb_strike_mode: 0, // delta bands
  pb_short_str_k: 0.6,
  pb_debit_stop_frac: 0.5,
  pb_target_max_frac: 0, // off
  pb_flip_confirm_s: 90,
  pb_max_adds: 0, pb_add_ext_k: 0.5, // no pyramid
  pb_wing_str_k: 1.25, pb_wing_min_steps: 2,
  pb_combined_stop: 0, // off
  pb_stop_str_k: 0, // off
  pb_calm_min: 0, pb_calm_mult: 1.0, // off
  pb_max_move_k: 0, // off
  pb_target_frac: 0, // off
  pb_trend_exit_s: 0, // off
  pb_stage_abort_k: 0.25,
  pb_stage_gap_s: 10,
  pb_wing_fresh_s: 30,
  pb_wing_spread_abs: 2,
  pb_rev_min_ext: 0.6, pb_rev_retrace: 0.35, pb_rev_stop_k: 0.1,
  pb_box_min: 60, pb_box_max_k: 1.5, pb_brk_buf_k: 0.5,
  pb_premium_budget: 6000, pb_gamma_max_lots: 4, pb_otm_steps: 1,
  pb_prem_stop_frac: 0.5, pb_prem_trail_arm: 0.8,
  // BULL-S: OFF, and every number below unread while it is. A row registered
  // before these existed resolves them here and never reaches the path.
  bs_enabled: false,
  bs_strike_step: 0, // > 0 required once enabled
  bs_strike_jump: 1,
  bs_stop_mult: 1.25,
  bs_stop_basis: 1, // the ask
  bs_stop_confirm_s: 3,
  bs_lots_start: 1,
  bs_lots_step: 1,
  bs_lots_cap: 0, // uncapped: NSE parity only — every DX preset sets it
  bs_max_open: 0, // unlimited
  bs_target: 0, // off
  bs_loss_cap: 0, // off
  bs_after_halt: 0, // stay flat
  bs_enter_on_start: true,
  bs_entry_from_min: 0,
  bs_entry_to_min: 1440,
  bs_entry_weekdays: 127, // every day
  bs_no_entry_before_expiry_min: 0, // off
  bs_flat_before_expiry_min: 0, // hold into settlement
  bs_ref_max_age_s: 10,
  bs_level_cooldown_s: 300,
  bs_close_req: 0,
  bs_rearm_req: 0,
};

/** Every dial name, taken from the defaults so the two can never disagree. */
const DIAL_KEYS = Object.keys(DEFAULT_DIALS) as ReadonlyArray<keyof Dials>;

/**
 * ── HOW THE DIALS ARE GROUPED FOR A HUMAN ───────────────────────────────────
 *
 * The dashboard's dials panel renders FROM THIS TABLE and holds no field list
 * of its own. That is the whole point of putting it here rather than in
 * `apps/web`: a dial added to `Dials` and forgotten in the UI is a knob the
 * operator cannot see (the failure the old raw-JSON box had by construction —
 * you could not retune `shift_margin_frac` if you did not already know it
 * existed), and a UI list copied out of this file goes stale the first time
 * the schema moves. `DIAL_SECTIONS` is checked against `DEFAULT_DIALS` in the
 * suite: every dial appears in exactly one section, as a `toggle` or a field.
 *
 * `toggle` IS THE SECTION'S MASTER SWITCH, and only the six dials that really
 * are one may sit there (`shift_enabled`, `unwind_enabled`, `trend_enabled`,
 * `balance_enabled`, `delta_lean_enabled` — see the header — and
 * `bs_enabled`, the BULL-S path's switch). While it is
 * false the section's numeric
 * fields are INERT: still shown, still their stored value, but not read by the
 * engine. The sections whose off-state is a NUMBER — Recycle (`recycle_frac`
 * 0), EOD (`eod_flat_min` 0), Anchor (`anchor_ema_marks` 0), Playbook
 * (`pb_playbook` 0) — deliberately carry NO toggle: inventing a boolean for
 * them here would be a second spelling of off, which is the ambiguity this
 * whole file retires.
 *
 * `collapsed` is a rendering hint for the two sections spec §5 calls
 * "Advanced … rarely touched": open them to see them, and the panel is not a
 * wall of forty inputs on the way to the corridor width.
 */
export interface DialSection {
  readonly key: string;
  readonly label: string;
  /** The section's master switch; its fields are inert while this is false. */
  readonly toggle?: keyof Dials;
  /** Every other dial in the section, in the order the spec table lists them. */
  readonly fields: ReadonlyArray<keyof Dials>;
  /** Rarely touched — the panel opens it closed. */
  readonly collapsed?: true;
}

/** The dial schema as sections, in the order the panel shows them (spec §5). */
export const DIAL_SECTIONS: ReadonlyArray<DialSection> = [
  {
    key: 'corridor',
    label: 'Corridor',
    fields: ['delta_tol_pct', 'delta_shorts_only', 'gamma_shorts_only', 'tol_ref_dte'],
  },
  {
    key: 'shift',
    label: 'Shift (phase S)',
    toggle: 'shift_enabled',
    fields: ['shift_itm_steps', 'shift_land_steps', 'shift_margin_frac', 'hedge_after_shift'],
  },
  {
    key: 'band',
    label: 'Band floor',
    fields: ['min_band_lots', 'no_band_floor'],
  },
  {
    key: 'shed',
    label: 'Shed (phase R)',
    fields: ['shed_scan_strikes', 'strikes_out', 'min_sell_dte', 'min_sell_delta', 'scrap_close_delta'],
  },
  {
    // A toggle and nothing else: LIFO unwind takes no parameters of its own
    // (`unwind_share` and `unwind_entry_book` are engine constants now — §5
    // "Deleted Python semantics"), and a section with an empty `fields` is the
    // honest shape of that rather than a dial invented to keep it company.
    key: 'unwind',
    label: 'Unwind',
    toggle: 'unwind_enabled',
    fields: [],
  },
  {
    key: 'recycle',
    label: 'Recycle',
    fields: ['recycle_frac', 'recycle_bank', 'recycle_opposite'],
  },
  {
    key: 'eod',
    label: 'EOD sweep',
    fields: ['eod_flat_min'],
  },
  {
    key: 'trend',
    label: 'Trend lean',
    toggle: 'trend_enabled',
    fields: ['trend_skew'],
  },
  {
    key: 'anchor',
    label: 'Anchor',
    fields: ['anchor_ema_marks', 'confirm_marks'],
  },
  {
    key: 'risk',
    label: 'Risk',
    fields: ['target_pnl', 'margin_cap'],
  },
  {
    key: 'execution',
    label: 'Execution',
    fields: ['work_tranche_lots', 'chase_max_ms', 'chase_cross_buffer_pct', 'rest_max_min'],
  },
  {
    key: 'tick',
    label: 'Tick',
    fields: ['confirm_ms', 'cooldown_s'],
  },
  {
    // Its own section rather than four loose dials in Advanced: the tier has a
    // real master switch, and a toggle buried in a list of numbers is a tier
    // an operator turns on without noticing.
    key: 'balance',
    label: 'Balance tier',
    toggle: 'balance_enabled',
    fields: ['balance_min_dte'],
    collapsed: true,
  },
  {
    key: 'advanced',
    label: 'Advanced',
    // The four target-lock refinements (`guards.ts`, header note): `_mark0`
    // skips the session's first phantom mark so it cannot arm, count or snap
    // the lock; `_executability` requires a mark to be tradeable before it
    // advances the streak; `target_snap_multiple` banks the instant the mark
    // clears N× target rather than waiting on the streak; `lock_branch_lots`
    // is the small-clean-book flatten ordering, gamma leg first.
    fields: [
      'scrap_close_px',
      'min_sell_px',
      'crash_delta',
      'target_confirm_marks',
      'lock_exclude_mark0',
      'lock_executability',
      'target_snap_multiple',
      'lock_branch_lots',
      'sell_max_spread_pct',
      'quote_max_age_ms',
    ],
    collapsed: true,
  },
  {
    // At the FOOT, and `collapsed` — followed only by Playbook, which runs on
    // this path. At the foot because it is a second engine rather than a
    // tier of the first — a recenter operator scrolls past it once and never
    // again, while the corridor they came for stays at the top. Collapsed
    // because the panel mounts a shut section's inputs only when it is first
    // opened (`dials-panel.tsx`), and forty-eight inputs nobody asked to see
    // is most of the panel's render budget. The section stays discoverable
    // shut: the header carries the label and an `off` badge.
    //
    // The toggle earns its place by the header's rule: while it is false the
    // engine reads not one of the forty-eight dials below, because the book
    // is on the other decide path entirely.
    collapsed: true,
    key: 'delta-lean',
    label: 'Delta lean',
    toggle: 'delta_lean_enabled',
    fields: [
      // Budget and the four exits
      'dl_day_max_loss',
      'dl_day_target',
      'dl_open_lots',
      'dl_stuck_loss',
      'dl_stuck_confirm_s',
      'dl_rupee_hold_s',
      // The open
      'dl_open_by_min',
      'dl_open_fallback',
      'dl_open_trend_up',
      'dl_open_trend_down',
      'dl_open_quiet',
      'dl_expiry_day_only',
      // Adjustment gating
      'dl_adjust_confirm_s',
      'dl_adjust_cooldown_s',
      'dl_max_adjusts_day',
      'dl_dead_band_lots',
      // Regime detector
      'dl_fast_window_s',
      'dl_slow_window_s',
      'dl_context_window_s',
      'dl_context_on',
      'dl_trend_mult',
      'dl_trend_exit_mult',
      'dl_clean_min',
      'dl_quiet_mult',
      'dl_regime_dwell_s',
      // Strike selection
      'dl_long_delta_lo',
      'dl_long_delta_hi',
      'dl_short_delta_lo',
      'dl_short_delta_hi',
      'dl_credit_short_delta_max',
      'dl_wing_delta',
      'dl_min_strike_gap',
      'dl_neutral_short_delta_lo',
      'dl_neutral_short_delta_hi',
      // Liquidity and staleness
      'dl_quote_fresh_s',
      'dl_max_spread_pct',
      'dl_max_spread_abs',
      'dl_spot_stale_s',
      // Clock and pacing
      'dl_warmup_min',
      'dl_flatten_passive_min',
      'dl_flatten_urgent_min',
      'dl_flat_by_min',
      'dl_eval_min_ms',
      'dl_max_orders_min',
      'dl_max_orders_s',
      'dl_max_orders_day',
      // Lifecycle
      'dl_hold_to_expiry',
      'dl_parity_forward',
    ],
  },
  {
    // AFTER Delta lean, which it runs on, and `collapsed` for the same reasons:
    // a third engine's dials at the foot of the panel, mounted only when the
    // section is first opened.
    //
    // NO TOGGLE. `pb_playbook` 0 is the off-state — it selects no playbook, and
    // while it is 0 the engine reads none of the fifty-two dials after it — so it
    // is the section's first FIELD, and a boolean beside it would be a second
    // spelling of off (see above). Spec §8.1's order, with the eight dials the
    // spec review added placed in the groups they belong to.
    collapsed: true,
    key: 'playbook',
    label: 'Playbook',
    fields: [
      // Selection and contract
      'pb_playbook',
      'pb_min_dte',
      'pb_expiry_day_only',
      // Sizing and the entry window
      'pb_lots',
      'pb_entry_start_min',
      'pb_entry_end_min',
      'pb_max_entries',
      'pb_reentry_cooldown_s',
      'pb_confirm_s',
      'pb_gap_min_pct',
      'pb_gap_max_pct',
      'pb_retry_s',
      'pb_max_gap_min',
      // The common exits
      'pb_trade_max_loss',
      'pb_trade_target',
      'pb_trail_start',
      'pb_late_trail_start',
      'pb_late_min',
      'pb_trail_keep',
      'pb_time_exit_min',
      'pb_stop_hold_s',
      'pb_rupee_hold_s',
      // Debit spreads
      'pb_strike_mode',
      'pb_short_str_k',
      'pb_debit_stop_frac',
      'pb_target_max_frac',
      'pb_flip_confirm_s',
      'pb_max_adds',
      'pb_add_ext_k',
      // Short premium
      'pb_wing_str_k',
      'pb_wing_min_steps',
      'pb_combined_stop',
      'pb_stop_str_k',
      'pb_calm_min',
      'pb_calm_mult',
      'pb_max_move_k',
      'pb_target_frac',
      'pb_trend_exit_s',
      // Staging and the protective legs
      'pb_stage_abort_k',
      'pb_stage_gap_s',
      'pb_wing_fresh_s',
      'pb_wing_spread_abs',
      // Reversal Spread
      'pb_rev_min_ext',
      'pb_rev_retrace',
      'pb_rev_stop_k',
      // Expiry Gamma Breakout
      'pb_box_min',
      'pb_box_max_k',
      'pb_brk_buf_k',
      'pb_premium_budget',
      'pb_gamma_max_lots',
      'pb_otm_steps',
      'pb_prem_stop_frac',
      'pb_prem_trail_arm',
    ],
  },
  {
    // The FOURTH decide path, at the very foot: no NSE book opens it, and on
    // the Delta desk it is the only section a BULL-S book reads. Not
    // `collapsed` — there it is the whole panel. `bs_enabled` is a real master
    // switch (an engine switch, like `delta_lean_enabled`): while it is false
    // the engine reads none of the fields below.
    key: 'bull-s',
    label: 'BULL-S',
    toggle: 'bs_enabled',
    fields: [
      // The grid
      'bs_strike_step',
      'bs_strike_jump',
      // The stop
      'bs_stop_mult',
      'bs_stop_basis',
      'bs_stop_confirm_s',
      // The pyramid
      'bs_lots_start',
      'bs_lots_step',
      'bs_lots_cap',
      'bs_max_open',
      // The book's target, loss cap and halt
      'bs_target',
      'bs_loss_cap',
      'bs_after_halt',
      'bs_enter_on_start',
      // When new entries may go on
      'bs_entry_from_min',
      'bs_entry_to_min',
      'bs_entry_weekdays',
      'bs_no_entry_before_expiry_min',
      'bs_flat_before_expiry_min',
      'bs_ref_max_age_s',
      'bs_level_cooldown_s',
      // The two book actions, as counters
      'bs_close_req',
      'bs_rearm_req',
    ],
  },
];

type BsKey = Extract<keyof Dials, `bs_${string}`>;

const int = (v: number): boolean => Number.isInteger(v);
const minuteOfDay = (v: number): boolean => int(v) && v >= 0 && v <= 1440;
const count = (v: number): boolean => int(v) && v >= 0;
const nonNegative = (v: number): boolean => v >= 0;

/**
 * THE RANGE EACH NUMERIC bs_* DIAL MUST BE IN. Every other dial is checked for
 * type only (header); these are checked for range as well because the BULL-S
 * path is new and its dials are typed by hand into a free-form document, and
 * a jump of 3, a stop multiple of 1 or a size of 1.5 contracts is a book that
 * trades on a rule nobody wrote. Sizes and counters are whole contracts.
 */
const BS_RANGES: Partial<Record<BsKey, (v: number) => boolean>> = {
  bs_strike_step: nonNegative,
  bs_strike_jump: (v) => v === 1 || v === 2,
  bs_stop_mult: (v) => v > 1,
  bs_stop_basis: (v) => v === 0 || v === 1,
  bs_stop_confirm_s: nonNegative,
  bs_lots_start: (v) => int(v) && v >= 1,
  bs_lots_step: count,
  bs_lots_cap: count,
  bs_max_open: count,
  bs_target: nonNegative,
  bs_loss_cap: nonNegative,
  bs_after_halt: (v) => v === 0 || v === 1,
  bs_entry_from_min: minuteOfDay,
  bs_entry_to_min: minuteOfDay,
  bs_entry_weekdays: (v) => int(v) && v >= 0 && v <= 127,
  bs_no_entry_before_expiry_min: nonNegative,
  bs_flat_before_expiry_min: nonNegative,
  bs_ref_max_age_s: (v) => v > 0,
  bs_level_cooldown_s: nonNegative,
  bs_close_req: count,
  bs_rearm_req: count,
};

/**
 * Fold a stored `dials` document onto `DEFAULT_DIALS`.
 *
 * Returns the resolved set plus the names of every entry it refused — a key
 * that is not a dial, a value of the wrong type, a number that is not finite,
 * or a bs_* number outside `BS_RANGES` (and `bs_strike_step` while
 * `bs_enabled` has no step). `unknown` preserves the document's own key order so the dashboard
 * can point at rows in the order the operator wrote them.
 */
export function resolveDials(
  raw: Readonly<Record<string, number | boolean>>,
): { dials: Dials; unknown: string[] } {
  const out: Record<string, number | boolean> = { ...DEFAULT_DIALS };
  const unknown: string[] = [];

  for (const key of Object.keys(raw)) {
    // Membership is tested against the key LIST, not against `out[key]`: a
    // document containing `toString` would otherwise resolve to Object's own
    // method and be accepted as a dial.
    if (!DIAL_KEYS.includes(key as keyof Dials)) {
      unknown.push(key);
      continue;
    }
    const value = raw[key];
    const bad =
      typeof value !== typeof out[key] ||
      (typeof value === 'number' && !Number.isFinite(value));
    if (bad) {
      unknown.push(key);
      continue;
    }
    out[key] = value as number | boolean;
  }

  // The bs_* ranges: a value the BULL-S path cannot run on is refused BY NAME
  // and keeps its default, exactly as a wrong type is.
  for (const key of Object.keys(raw)) {
    const range = BS_RANGES[key as BsKey];
    if (range === undefined || unknown.includes(key)) continue;
    if (!range(out[key] as number)) {
      unknown.push(key);
      out[key] = (DEFAULT_DIALS as unknown as Record<string, number | boolean>)[key] as number;
    }
  }
  // An ENABLED book with no strike step has no grid. Named, so the dashboard
  // shows it — but `bs_enabled` stays as stored: turning it off here would
  // hand the book to another engine. `decideBullS` holds on a 0 step instead.
  if (out['bs_enabled'] === true && !((out['bs_strike_step'] as number) > 0) && !unknown.includes('bs_strike_step')) {
    unknown.push('bs_strike_step');
  }

  // The one cast in the file, and it is load-bearing rather than lazy: `out`
  // started as a full copy of `DEFAULT_DIALS` and only ever had a same-typed
  // value written over a known dial name, so every field is present and of
  // the right type — which is precisely what the type system cannot follow
  // through a string-keyed write.
  return { dials: out as unknown as Dials, unknown };
}
