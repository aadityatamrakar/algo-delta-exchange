/**
 * THE DIAL TABLE, WRITTEN OUT LONGHAND.
 *
 * The expected object below is transcribed from the design spec's §5 field
 * schema (`docs/superpowers/specs/2026-08-21-recenter-supervisor-migration-
 * design.md:226-267`), field by field, deliberately NOT built from
 * `DEFAULT_DIALS` itself. A test that asserts `DEFAULT_DIALS` equals
 * `DEFAULT_DIALS` proves nothing; this one fails the moment a default drifts
 * from the operator-approved table — and these defaults are what an unattended
 * live book sells against.
 *
 * The resolver cases pin the failure the Python system had no answer for: a
 * dial the schema does not know (`desk-books-registry.dials` is a free-form
 * Mongo document) must come back NAMED, not silently swallowed. A swallowed
 * dial is an operator who set a limit that never applied.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIALS, DIAL_SECTIONS, resolveDials, type Dials } from '@algomaker/desk-engine'

/**
 * Spec §5, transcribed. Relief-r live values — plus the delta-lean block,
 * which is the OTHER spec's §9 aggressive column, and the playbook block at
 * the foot, which is the six-playbooks spec's §8.1 (see the notes there).
 * Three operator-approved tables, one `Dials`, because a book is one row with
 * one dial document.
 */
const SPEC_TABLE: Dials = {
  // Corridor
  delta_tol_pct: 0.02,
  delta_shorts_only: true,
  gamma_shorts_only: true,
  tol_ref_dte: 0,
  // Shift
  shift_enabled: true,
  shift_itm_steps: 0.5,
  shift_land_steps: 2,
  shift_margin_frac: 0.6,
  hedge_after_shift: false,
  // Band floor
  min_band_lots: 0,
  no_band_floor: false,
  // Shed
  shed_scan_strikes: 3,
  strikes_out: 2,
  min_sell_dte: 1,
  min_sell_delta: 0,
  scrap_close_delta: 0,
  // Tiers
  unwind_enabled: false,
  recycle_frac: 0,
  recycle_bank: false,
  recycle_opposite: false,
  eod_flat_min: 0,
  trend_enabled: false,
  trend_skew: 0.5,
  anchor_ema_marks: 0,
  confirm_marks: 0,
  // Risk
  target_pnl: 250000,
  margin_cap: 100000000,
  // Execution
  work_tranche_lots: 3,
  chase_max_ms: 30000,
  chase_cross_buffer_pct: 0.005,
  rest_max_min: 10,
  // Tick
  confirm_ms: 5000,
  cooldown_s: 30,
  // Advanced
  scrap_close_px: 0.1,
  min_sell_px: 0,
  crash_delta: 0.6,
  target_confirm_marks: 3,
  // The four lock refinements the Advanced row names, at the value Python's
  // `p.get(...)` supplies when a playbook does not set them — which no recenter
  // preset does (`engine.py:160-185`, `playbooks.py:349-478`).
  lock_exclude_mark0: false,
  lock_executability: false,
  target_snap_multiple: 0,
  lock_branch_lots: 0,
  sell_max_spread_pct: 0.25,
  quote_max_age_ms: 120000,
  balance_min_dte: 7,
  balance_enabled: false,

  // ── DELTA LEAN ────────────────────────────────────────────────────────────
  // These come from a DIFFERENT operator-approved table: §4 of
  // `docs/superpowers/specs/2026-09-22-delta-lean-hold-adjust-design.md`,
  // whose two columns are the aggressive and conservative books. The
  // aggressive column is the default, so it is transcribed here; the
  // conservative column lives in `presets.ts` and is checked in
  // `delta-lean-dials.test.ts`.
  //
  // `delta_lean_enabled` is false and that is the assertion that matters most
  // in this file: every recenter book in `desk-books-registry` resolves
  // against this table, so a true here would move all of them onto the second
  // decide path with no row edited and nobody told.
  delta_lean_enabled: false,
  dl_day_max_loss: 30_000, // R1 of the 2026-10-04 review, applied 2026-10-05 (§4 said 200,000)
  dl_day_target: 10_000,
  dl_open_lots: 4,
  dl_stuck_loss: 25_000,
  dl_stuck_confirm_s: 300,
  // 2026-10-30: read on a hold book only. 60, not 0, in the defaults: the
  // hold rows on file were registered without it and must resolve to it.
  dl_rupee_hold_s: 60,
  // Delta-lean-zero spec D4: the open's gates, each at the value that opens
  // exactly as every book did before they existed — no window, every regime,
  // every day. The zero presets turn them on in their own rows.
  dl_open_by_min: 0,
  dl_open_fallback: false,
  dl_open_trend_up: true,
  dl_open_trend_down: true,
  dl_open_quiet: true,
  dl_expiry_day_only: false,
  dl_adjust_confirm_s: 60,
  dl_adjust_cooldown_s: 600,
  dl_max_adjusts_day: 6,
  dl_fast_window_s: 60,
  dl_slow_window_s: 300,
  dl_context_window_s: 900,
  dl_context_on: true,
  dl_trend_mult: 2,
  dl_trend_exit_mult: 1.2,
  dl_clean_min: 0.6,
  dl_quiet_mult: 0.7,
  dl_regime_dwell_s: 120,
  dl_long_delta_lo: 0.55,
  dl_long_delta_hi: 0.65,
  dl_short_delta_lo: 0.2,
  dl_short_delta_hi: 0.3,
  dl_credit_short_delta_max: 0.3,
  dl_wing_delta: 0.1,
  dl_min_strike_gap: 1,
  dl_neutral_short_delta_lo: 0.45,
  dl_neutral_short_delta_hi: 0.6,
  dl_dead_band_lots: 0.5,
  dl_quote_fresh_s: 3,
  dl_max_spread_pct: 0.02,
  dl_max_spread_abs: 1,
  dl_spot_stale_s: 10,
  dl_warmup_min: 570,
  dl_flatten_passive_min: 890,
  dl_flatten_urgent_min: 895,
  dl_flat_by_min: 900,
  dl_eval_min_ms: 1000,
  dl_max_orders_min: 40,
  // Carried in `Dials` but enforced by the HOST, not the engine: a pure function
  // of one tick cannot count orders over a second or a session (Task 9B, R6).
  dl_max_orders_s: 2,
  dl_max_orders_day: 40,
  // Hold-to-expiry spec (2026-10-05): off, so every intraday row stays intraday.
  dl_hold_to_expiry: false,
  // Six-playbooks spec F1: off, so a row registered before the parity forward
  // existed keeps pricing its chain off the future; the delta-lean presets
  // turn it on in their own rows.
  dl_parity_forward: false,

  // ── PLAYBOOKS ─────────────────────────────────────────────────────────────
  // A THIRD operator-approved table: §8.1 of
  // `docs/superpowers/specs/2026-10-16-six-playbooks-design.md`, transcribed
  // row by row, plus the eight dials the spec review added. `pb_playbook` 0
  // is the assertion that matters here, for the reason `delta_lean_enabled`
  // false is above: every registry row resolves against this table, and 0 is
  // what keeps every existing book off the playbook frame. Every other value
  // is INERT while it is 0.
  pb_playbook: 0,
  pb_min_dte: 1,
  pb_expiry_day_only: false,
  pb_lots: 2,
  pb_entry_start_min: 570,
  pb_entry_end_min: 615,
  pb_max_entries: 1,
  pb_reentry_cooldown_s: 1200,
  pb_confirm_s: 120,
  pb_gap_min_pct: 0,
  pb_gap_max_pct: 0,
  pb_retry_s: 30,
  pb_max_gap_min: 5,
  pb_trade_max_loss: 5000,
  pb_trade_target: 10000,
  pb_trail_start: 4000,
  pb_late_trail_start: 2000,
  pb_late_min: 780,
  pb_trail_keep: 0.6,
  pb_time_exit_min: 0,
  pb_stop_hold_s: 20,
  pb_rupee_hold_s: 3,
  pb_strike_mode: 0,
  pb_short_str_k: 0.6,
  pb_debit_stop_frac: 0.5,
  pb_target_max_frac: 0,
  pb_flip_confirm_s: 90,
  pb_max_adds: 0,
  pb_add_ext_k: 0.5,
  pb_wing_str_k: 1.25,
  pb_wing_min_steps: 2,
  pb_combined_stop: 0,
  pb_stop_str_k: 0,
  pb_calm_min: 0,
  pb_calm_mult: 1.0,
  pb_max_move_k: 0,
  pb_target_frac: 0,
  pb_trend_exit_s: 0,
  pb_stage_abort_k: 0.25,
  pb_stage_gap_s: 10,
  pb_wing_fresh_s: 30,
  pb_wing_spread_abs: 2,
  pb_rev_min_ext: 0.6,
  pb_rev_retrace: 0.35,
  pb_rev_stop_k: 0.1,
  pb_box_min: 60,
  pb_box_max_k: 1.5,
  pb_brk_buf_k: 0.5,
  pb_premium_budget: 6000,
  pb_gamma_max_lots: 4,
  pb_otm_steps: 1,
  pb_prem_stop_frac: 0.5,
  pb_prem_trail_arm: 0.8,
  // BULL-S (Delta spec §6.2, plan Task 3): off, every number unread while it is.
  bs_enabled: false,
  bs_strike_step: 0,
  bs_strike_jump: 1,
  bs_stop_mult: 1.25,
  bs_stop_basis: 1,
  bs_stop_confirm_s: 3,
  bs_lots_start: 1,
  bs_lots_step: 1,
  bs_lots_cap: 0,
  bs_max_open: 0,
  bs_margin_budget: 0,
  bs_target: 0,
  bs_loss_cap: 0,
  bs_after_halt: 0,
  bs_enter_on_start: true,
  bs_entry_from_min: 0,
  bs_entry_to_min: 1440,
  bs_entry_weekdays: 127,
  bs_no_entry_before_expiry_min: 0,
  bs_flat_before_expiry_min: 0,
  bs_ref_max_age_s: 10,
  bs_level_cooldown_s: 300,
  bs_close_req: 0,
  bs_rearm_req: 0,
}

/** Spec §8.1's rows in the table's order, with the spec review's eight in the
 * groups they belong to — the order the panel lists them. */
const PLAYBOOK_FIELDS = [
  // selection and contract
  'pb_playbook', 'pb_min_dte', 'pb_expiry_day_only',
  // sizing and the entry window
  'pb_lots', 'pb_entry_start_min', 'pb_entry_end_min', 'pb_max_entries',
  'pb_reentry_cooldown_s', 'pb_confirm_s',
  'pb_gap_min_pct', 'pb_gap_max_pct', 'pb_retry_s', 'pb_max_gap_min',
  // the common exits
  'pb_trade_max_loss', 'pb_trade_target',
  'pb_trail_start', 'pb_late_trail_start', 'pb_late_min', 'pb_trail_keep',
  'pb_time_exit_min', 'pb_stop_hold_s', 'pb_rupee_hold_s',
  // debit spreads
  'pb_strike_mode', 'pb_short_str_k', 'pb_debit_stop_frac', 'pb_target_max_frac', 'pb_flip_confirm_s',
  'pb_max_adds', 'pb_add_ext_k',
  // short premium
  'pb_wing_str_k', 'pb_wing_min_steps', 'pb_combined_stop', 'pb_stop_str_k',
  'pb_calm_min', 'pb_calm_mult', 'pb_max_move_k', 'pb_target_frac', 'pb_trend_exit_s',
  // staging and the protective legs
  'pb_stage_abort_k', 'pb_stage_gap_s', 'pb_wing_fresh_s', 'pb_wing_spread_abs',
  // Reversal Spread
  'pb_rev_min_ext', 'pb_rev_retrace', 'pb_rev_stop_k',
  // Expiry Gamma Breakout
  'pb_box_min', 'pb_box_max_k', 'pb_brk_buf_k',
  'pb_premium_budget', 'pb_gamma_max_lots', 'pb_otm_steps',
  'pb_prem_stop_frac', 'pb_prem_trail_arm',
]

test('DEFAULT_DIALS is the spec tables, field for field', () => {
  assert.deepEqual(DEFAULT_DIALS, SPEC_TABLE)
})

test('an empty override resolves to the defaults with nothing unknown', () => {
  const { dials, unknown } = resolveDials({})
  assert.deepEqual(dials, SPEC_TABLE)
  assert.deepEqual(unknown, [])
})

test('a dial the schema does not know is NAMED, not swallowed', () => {
  const { dials, unknown } = resolveDials({ lot_size: 100 })
  assert.deepEqual(unknown, ['lot_size'])
  assert.deepEqual(dials, SPEC_TABLE)
})

test('a known dial overrides exactly one field', () => {
  const { dials, unknown } = resolveDials({ delta_tol_pct: 0.03 })
  assert.equal(dials.delta_tol_pct, 0.03)
  assert.deepEqual(unknown, [])
  assert.deepEqual({ ...dials, delta_tol_pct: 0.02 }, SPEC_TABLE)
})

test('booleans and numbers both round-trip', () => {
  const { dials } = resolveDials({
    shift_enabled: false,
    no_band_floor: true,
    min_band_lots: 2,
    eod_flat_min: 915,
  })
  assert.equal(dials.shift_enabled, false)
  assert.equal(dials.no_band_floor, true)
  assert.equal(dials.min_band_lots, 2)
  assert.equal(dials.eod_flat_min, 915)
})

test('a dial of the wrong type is rejected by NAME, never coerced', () => {
  // `1` for a boolean is the shape a hand-edited Mongo document arrives in.
  // Coercing it would turn a typo into a live behaviour change in silence;
  // the operator has to see the name.
  const { dials, unknown } = resolveDials({
    shift_enabled: 1 as unknown as boolean,
    delta_tol_pct: true as unknown as number,
  })
  assert.deepEqual(unknown, ['shift_enabled', 'delta_tol_pct'])
  assert.equal(dials.shift_enabled, true)
  assert.equal(dials.delta_tol_pct, 0.02)
})

test('a non-finite number is rejected — a NaN corridor sheds the whole book', () => {
  const { dials, unknown } = resolveDials({ delta_tol_pct: Number.NaN })
  assert.deepEqual(unknown, ['delta_tol_pct'])
  assert.equal(dials.delta_tol_pct, 0.02)
})

test('the resolved object is a fresh copy, never the shared default', () => {
  const a = resolveDials({ delta_tol_pct: 0.05 })
  assert.equal(DEFAULT_DIALS.delta_tol_pct, 0.02)
  assert.notEqual(a.dials, DEFAULT_DIALS)
})

// ------------------------------------------------------- sections, for the UI

/**
 * EVERY DIAL IS IN EXACTLY ONE SECTION — the property the dashboard's panel
 * rests on, since it renders from `DIAL_SECTIONS` and holds no field list of
 * its own. A dial added to the schema and forgotten here is a knob nobody can
 * see; one listed twice is a knob with two inputs racing each other.
 */
test('DIAL_SECTIONS partitions the schema: every dial once, and nothing invented', () => {
  const seen: string[] = []
  for (const section of DIAL_SECTIONS) {
    if (section.toggle !== undefined) seen.push(section.toggle)
    seen.push(...section.fields)
  }
  const schema = Object.keys(DEFAULT_DIALS)
  assert.deepEqual([...seen].sort(), [...schema].sort())
  assert.equal(new Set(seen).size, seen.length, 'a dial is listed in two sections')
})

/**
 * A `toggle` IS A BOOLEAN, or "off" means whatever the panel decides it means
 * — the exact ambiguity the typed off-state retires. The four that qualify are
 * named in the file header; a numeric off-state (`recycle_frac` 0) is a field,
 * never a switch.
 */
test('every section toggle is a boolean dial', () => {
  for (const section of DIAL_SECTIONS) {
    if (section.toggle === undefined) continue
    assert.equal(
      typeof DEFAULT_DIALS[section.toggle],
      'boolean',
      `${section.key}: ${section.toggle} is not a boolean`,
    )
  }
})

test('section keys are unique — the panel keys its rendering on them', () => {
  const keys = DIAL_SECTIONS.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
})

// ------------------------------------------------- the playbook dials (§8.1)

test('every pb_* dial is in exactly one section — Playbook — in spec §8.1 order', () => {
  assert.equal(PLAYBOOK_FIELDS.length, 53, 'spec §8.1`s forty-three, the review`s eight, the protective spread floor and the take profit`s ceiling')
  const section = DIAL_SECTIONS.find((s) => s.key === 'playbook')
  assert.ok(section !== undefined, 'the Playbook section must exist')
  assert.equal(section.label, 'Playbook')
  assert.deepEqual([...section.fields], PLAYBOOK_FIELDS)
  // No toggle: `pb_playbook` 0 IS the off-state, and a boolean beside it would
  // be a second spelling of off — the ambiguity this file retires.
  assert.equal(section.toggle, undefined)
  assert.equal(section.collapsed, true, 'a second engine nobody on the recenter path opens')
  // The schema's pb_* dials are exactly these, and no other section lists one.
  const schema = Object.keys(DEFAULT_DIALS).filter((k) => k.startsWith('pb_'))
  assert.deepEqual([...schema].sort(), [...PLAYBOOK_FIELDS].sort())
  for (const other of DIAL_SECTIONS) {
    if (other.key === 'playbook') continue
    const listed = [...(other.toggle === undefined ? [] : [other.toggle]), ...other.fields]
    assert.deepEqual(listed.filter((k) => k.startsWith('pb_')), [], `${other.key} lists a playbook dial`)
  }
})

test('the Playbook section sits right after Delta lean, at the foot of the NSE panel', () => {
  const keys = DIAL_SECTIONS.map((s) => s.key)
  assert.equal(keys.indexOf('playbook'), keys.indexOf('delta-lean') + 1)
  // Only BULL-S, the fourth path, comes after it (test/bull-s/dials.test.ts).
  assert.deepEqual(keys.slice(-2), ['playbook', 'bull-s'])
})

test('the playbook defaults are inert: pb_playbook 0 and no expiry-only contract', () => {
  // 0 selects no playbook at all, so every number in the section is unread.
  assert.equal(DEFAULT_DIALS.pb_playbook, 0)
  assert.equal(DEFAULT_DIALS.pb_expiry_day_only, false)
  for (const key of PLAYBOOK_FIELDS) {
    const v = DEFAULT_DIALS[key as keyof Dials]
    assert.ok(typeof v === 'number' || typeof v === 'boolean', `${key} is ${typeof v}`)
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${key} is not finite`)
  }
})

test('resolveDials({ pb_playbook: 3 }) resolves with no unknowns', () => {
  // A build that knows the playbooks must NAME none of their dials as unknown —
  // the roll's engine gate and the dashboard both read `unknown` to tell.
  const { dials, unknown } = resolveDials({ pb_playbook: 3 })
  assert.deepEqual(unknown, [])
  assert.equal(dials.pb_playbook, 3)
  assert.deepEqual({ ...dials, pb_playbook: 0 }, SPEC_TABLE)
})

test('a wrong-typed playbook dial is refused by name, never coerced', () => {
  const { dials, unknown } = resolveDials({
    pb_playbook: '1' as unknown as number,
    pb_expiry_day_only: 1 as unknown as boolean,
    pb_trade_max_loss: Number.NaN,
  })
  assert.deepEqual(unknown, ['pb_playbook', 'pb_expiry_day_only', 'pb_trade_max_loss'])
  assert.equal(dials.pb_playbook, 0)
  assert.equal(dials.pb_expiry_day_only, false)
  assert.equal(dials.pb_trade_max_loss, 5000)
})
