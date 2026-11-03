/**
 * THE DIAL SURFACE OF THE HOLD-AND-ADJUST ENGINE.
 *
 * Two things are pinned here and nowhere else:
 *
 *   1. THE SET. A dial the engine no longer reads is a limit an operator can
 *      set that never applies — the most expensive kind of dead code there is,
 *      because it reads as a working guard. So the section list is asserted
 *      EXACTLY, both ways: every key present and no key extra.
 *   2. THE NUMBERS. `DEFAULT_DIALS` IS spec §4's aggressive column, and the
 *      conservative preset is the base plus exactly the five numbers §4's
 *      second column moves. Asserting both stops the two drifting apart.
 *
 * And one behaviour: `resolveDials` IGNORES an unknown stored key rather than
 * refusing the row. Today's four registry rows carry the v1 dials until the
 * 08:50 roll erases them, and a resolver that refused those rows would leave
 * four books unsteered on the morning this ships.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  DIAL_SECTIONS,
  PRESETS,
  resolveDials,
  type Dials,
  type Preset,
} from '@algomaker/desk-engine'

function preset(key: string): Preset {
  const p = PRESETS.find((x) => x.key === key)
  assert.ok(p !== undefined, `preset ${key} must exist`)
  return p
}

const dlSection = (): readonly string[] => {
  const s = DIAL_SECTIONS.find((x) => x.key === 'delta-lean')
  assert.ok(s !== undefined, 'the Delta lean section must exist')
  return [...(s.toggle === undefined ? [] : [s.toggle]), ...s.fields]
}

/** Spec §4's surviving set, written out so the assertion is a statement rather
 * than a restatement of whatever the file happens to contain. */
const EXPECTED = [
  'delta_lean_enabled',
  // Budget and exits
  'dl_day_max_loss', 'dl_day_target', 'dl_open_lots', 'dl_stuck_loss', 'dl_stuck_confirm_s',
  // The hold book's rupee hold on the backstop and the target (2026-10-30)
  'dl_rupee_hold_s',
  // The open (delta-lean-zero spec, 2026-10-17)
  'dl_open_by_min', 'dl_open_fallback', 'dl_open_trend_up', 'dl_open_trend_down', 'dl_open_quiet',
  'dl_expiry_day_only',
  // Adjustment
  'dl_adjust_confirm_s', 'dl_adjust_cooldown_s', 'dl_max_adjusts_day', 'dl_dead_band_lots',
  // Regime detector
  'dl_fast_window_s', 'dl_slow_window_s', 'dl_context_window_s', 'dl_context_on',
  'dl_trend_mult', 'dl_trend_exit_mult', 'dl_clean_min', 'dl_quiet_mult', 'dl_regime_dwell_s',
  // Strike selection
  'dl_long_delta_lo', 'dl_long_delta_hi', 'dl_short_delta_lo', 'dl_short_delta_hi',
  'dl_credit_short_delta_max', 'dl_wing_delta', 'dl_min_strike_gap',
  'dl_neutral_short_delta_lo', 'dl_neutral_short_delta_hi',
  // Liquidity and staleness
  'dl_quote_fresh_s', 'dl_max_spread_pct', 'dl_max_spread_abs', 'dl_spot_stale_s',
  // Clock and pacing
  'dl_warmup_min', 'dl_flatten_passive_min', 'dl_flatten_urgent_min', 'dl_flat_by_min',
  'dl_eval_min_ms', 'dl_max_orders_min', 'dl_max_orders_s', 'dl_max_orders_day',
  // Lifecycle (hold-to-expiry spec, 2026-10-05)
  'dl_hold_to_expiry',
  // The chain's own forward (six-playbooks spec F1, 2026-10-16)
  'dl_parity_forward',
]

test('the Delta lean section is exactly the surviving dial set', () => {
  assert.deepEqual([...dlSection()].sort(), [...EXPECTED].sort())
  const s = DIAL_SECTIONS.find((x) => x.key === 'delta-lean')
  assert.equal(s?.fields.length, 48, 'forty-eight fields behind the toggle')
})

test('the playbook dials leave the Delta lean section exactly as it was', () => {
  // The playbooks run on this path but own their own section (six-playbooks
  // §8.1). A `pb_*` field here would grow the forty this section is pinned to,
  // and the dashboard would show one knob under two headers.
  assert.equal(dlSection().length, EXPECTED.length)
  assert.deepEqual(dlSection().filter((k) => k.startsWith('pb_')), [])
})

test('every dl_ dial in the schema is in the section, and every one has a default', () => {
  const inSection = new Set(dlSection())
  for (const key of Object.keys(DEFAULT_DIALS)) {
    if (!key.startsWith('dl_')) continue
    assert.ok(inSection.has(key), `${key} has no section — it would be invisible in the panel`)
  }
  for (const key of EXPECTED) {
    assert.ok(key in DEFAULT_DIALS, `${key} must have a default`)
  }
})

test('every dial the deleted rules read is GONE from the schema', () => {
  // A dial the engine no longer reads reads as a working limit and is not one.
  const gone = [
    'dl_capital', 'dl_lean_max_loss', 'dl_base_unit_lots', 'dl_max_lean_lots',
    'dl_add_step_pnl', 'dl_add_cooldown_s', 'dl_cut_frac', 'dl_cut_floor',
    'dl_flip_cooldown_s', 'dl_max_flips_hour', 'dl_max_flips_day', 'dl_flip_confirm_s',
    'dl_gamma_drift_keep', 'dl_theta_floor_per_lot', 'dl_theta_target',
    'dl_short_gamma_move_pct', 'dl_context_disagree_cap', 'dl_pause_theta_frac',
    'dl_chop_unwind_s', 'dl_min_hold_s', 'dl_wings_on', 'dl_roll_long_delta',
    'dl_roll_short_delta', 'dl_margin_frac', 'dl_cost_gate_mult', 'dl_leg_stale_s',
    'dl_no_new_units_min',
  ]
  const section = new Set(dlSection())
  for (const key of gone) {
    assert.ok(!(key in DEFAULT_DIALS), `${key} must be out of the schema`)
    assert.ok(!section.has(key), `${key} must be out of the section`)
  }
})

test('DEFAULT_DIALS carries spec §4`s AGGRESSIVE column', () => {
  assert.equal(DEFAULT_DIALS.dl_open_lots, 4)
  assert.equal(DEFAULT_DIALS.dl_day_target, 10_000)
  // R1 of the 2026-10-04 review (applied 2026-10-05): the backstop sized to the
  // book, not to the fund — 30,000, where §4 said 200,000.
  assert.equal(DEFAULT_DIALS.dl_day_max_loss, 30_000)
  assert.equal(DEFAULT_DIALS.dl_adjust_confirm_s, 60)
  assert.equal(DEFAULT_DIALS.dl_adjust_cooldown_s, 600)
  assert.equal(DEFAULT_DIALS.dl_max_adjusts_day, 6)
  assert.equal(DEFAULT_DIALS.dl_neutral_short_delta_lo, 0.45)
  assert.equal(DEFAULT_DIALS.dl_neutral_short_delta_hi, 0.6)
  assert.equal(DEFAULT_DIALS.dl_stuck_loss, 25_000)
  assert.equal(DEFAULT_DIALS.dl_stuck_confirm_s, 300)
  assert.equal(DEFAULT_DIALS.dl_dead_band_lots, 0.5)
  assert.equal(DEFAULT_DIALS.dl_max_orders_day, 40)
})

test('the day clock is the §5 timeline, in minutes of day and in order', () => {
  const d = DEFAULT_DIALS
  assert.ok(d.dl_warmup_min < d.dl_flatten_passive_min)
  assert.ok(d.dl_flatten_passive_min < d.dl_flatten_urgent_min)
  assert.ok(d.dl_flatten_urgent_min < d.dl_flat_by_min)
  assert.equal(d.dl_warmup_min, 570)   // 09:30
  assert.equal(d.dl_flatten_passive_min, 890) // 14:50
  assert.equal(d.dl_flatten_urgent_min, 895)  // 14:55
  assert.equal(d.dl_flat_by_min, 900)  // 15:00
})

test('the neutral sell band is ATM, not ITM, and sits inside the long band', () => {
  // D5: the operator said "sell in the money ce or something"; ATM keeps the
  // same net-delta effect with more time value and a better book. The dial is
  // the band, so it can still be pushed in the money.
  const d = DEFAULT_DIALS
  assert.ok(d.dl_neutral_short_delta_lo < d.dl_neutral_short_delta_hi)
  assert.ok(d.dl_neutral_short_delta_hi <= d.dl_long_delta_hi)
})

test('both delta-lean presets select the path, confirm in 1s and never cool down', () => {
  for (const key of ['delta-lean-aggressive', 'delta-lean-conservative']) {
    const { dials } = resolveDials(preset(key).dials as Record<string, number | boolean>)
    assert.equal(dials.delta_lean_enabled, true, `${key} selects the engine`)
    // The HOST's damping is shared by both decide paths. At the recenter
    // defaults a delta-lean EXIT would wait out a window longer than the move
    // it is exiting.
    assert.equal(dials.confirm_ms, 1_000, `${key} confirms in 1s`)
    assert.equal(dials.cooldown_s, 0, `${key} never cools down`)
  }
})

test('the margin cap is the SPAN-lite ceiling of D4 — 25 lakh, in BOTH presets', () => {
  for (const key of ['delta-lean-aggressive', 'delta-lean-conservative']) {
    const { dials } = resolveDials(preset(key).dials as Record<string, number | boolean>)
    assert.equal(dials.margin_cap, 2_500_000, `${key} caps at 25 lakh`)
  }
})

test('the aggressive preset moves nothing the defaults do not already say', () => {
  // `DEFAULT_DIALS` IS the aggressive column, so restating it in the preset
  // would be a second copy of the operator-approved table to keep in step.
  // ONE exception, and it is not a column row: `dl_parity_forward` must stay
  // off in the defaults (an existing row keeps its future) and on in every
  // delta-lean preset, so the base states it — see the next test.
  const stated = preset('delta-lean-aggressive').dials as Record<string, number | boolean>
  for (const key of Object.keys(stated)) {
    if (!key.startsWith('dl_') || key === 'dl_parity_forward') continue
    assert.equal(stated[key], DEFAULT_DIALS[key as keyof Dials], `${key} is restated needlessly`)
  }
})

test('dl_parity_forward is OFF in the defaults and ON in every delta-lean-family preset', () => {
  // Off in the table every registry row resolves against: a book registered
  // before the parity forward existed keeps the future it was measured on,
  // with no row edited. On in every preset that builds a delta-lean book, so
  // every NEW row carries it in its own dial document (six-playbooks F1).
  assert.equal(DEFAULT_DIALS.dl_parity_forward, false)
  const family = PRESETS.filter(
    (p) => resolveDials(p.dials as Record<string, number | boolean>).dials.delta_lean_enabled,
  ).map((p) => p.key)
  assert.deepEqual(family, [
    'delta-lean-aggressive',
    'delta-lean-conservative',
    'delta-lean-hold-aggressive',
    'delta-lean-hold-conservative',
    'delta-lean-zero',
    'delta-lean-zero-0dte',
    'pb-trend-drive',
    'pb-wing-straddle',
    'pb-reversal',
    'pb-expiry-drive',
    'pb-expiry-theta',
    'pb-expiry-gamma',
  ])
  for (const key of family) {
    assert.equal(preset(key).dials.dl_parity_forward, true, `${key} states it in its own row`)
  }
  // And no recenter preset picks it up: Recenter books keep the future-mid
  // forward (the plan's global constraints).
  for (const p of PRESETS) {
    if (family.includes(p.key)) continue
    assert.equal(
      resolveDials(p.dials as Record<string, number | boolean>).dials.dl_parity_forward,
      false,
      p.key,
    )
  }
})

test('conservative differs from aggressive on exactly the five §4 risk dials, plus R1`s backstop (one of them moved 30 Oct)', () => {
  const agg = resolveDials(preset('delta-lean-aggressive').dials as Record<string, number | boolean>).dials
  const con = resolveDials(preset('delta-lean-conservative').dials as Record<string, number | boolean>).dials
  const moved = (Object.keys(agg) as (keyof Dials)[]).filter((k) => agg[k] !== con[k])
  assert.deepEqual([...moved].sort(), [
    'chase_max_ms',           // an EXECUTION dial: half the size, so twice the patience
    'dl_adjust_confirm_s',
    'dl_adjust_cooldown_s',
    'dl_day_max_loss',        // R1 (2026-10-05): the backstop is per-preset now
    'dl_max_adjusts_day',
    'dl_open_lots',
    'dl_stuck_loss',
  ].sort())
  assert.equal(con.dl_open_lots, 2)
  assert.equal(con.dl_adjust_confirm_s, 120)
  assert.equal(con.dl_adjust_cooldown_s, 900)
  // §4 wrote 4; the 30 Oct 2026 review turned the column's adjustments off
  // (opened and held, against aggressive's 6) — see the test below.
  assert.equal(con.dl_max_adjusts_day, 0)
  assert.equal(con.dl_stuck_loss, 15_000)
  assert.equal(con.chase_max_ms, 3_000)
  assert.equal(agg.dl_day_max_loss, 30_000)
  assert.equal(con.dl_day_max_loss, 15_000)
  // "same" in §4's table is INHERITED, never restated.
  assert.equal(con.dl_day_target, agg.dl_day_target)
  assert.equal(con.dl_stuck_confirm_s, agg.dl_stuck_confirm_s)
  assert.equal(con.margin_cap, agg.margin_cap)
})

test('resolveDials IGNORES an unknown stored key and still returns the row', () => {
  /**
   * Spec §4, and it is not a nicety: today's four registry rows carry the v1
   * dials (`dl_max_lean_lots`, `dl_cut_frac`, …) until the 08:50 roll writes
   * fresh ones. A resolver that REFUSED such a row would leave four paper books
   * unsteered on the morning this ships. The key is NAMED in `unknown` so the
   * dashboard and `delta-lean-books.mjs` can say what was dropped — reported,
   * never swallowed, and never fatal.
   */
  const { dials, unknown } = resolveDials({
    dl_max_lean_lots: 9,      // a v1 dial this engine does not have
    dl_cut_frac: 0.5,         // another
    not_a_dial_at_all: 1,     // a typo
    dl_open_lots: 3,          // a real one, and it must still land
  })
  assert.equal(dials.dl_open_lots, 3, 'the known key resolved')
  assert.equal(dials.dl_day_target, DEFAULT_DIALS.dl_day_target, 'the rest fell back to defaults')
  assert.deepEqual(unknown, ['dl_max_lean_lots', 'dl_cut_frac', 'not_a_dial_at_all'])
})

test('a wrong-typed or NaN delta-lean dial is refused BY NAME, never coerced', () => {
  const { dials, unknown } = resolveDials({
    dl_open_lots: 'four' as unknown as number,
    dl_day_target: Number.NaN,
    dl_context_on: 1 as unknown as boolean,
  })
  assert.deepEqual([...unknown].sort(), ['dl_context_on', 'dl_day_target', 'dl_open_lots'])
  assert.equal(dials.dl_open_lots, DEFAULT_DIALS.dl_open_lots)
  assert.equal(dials.dl_day_target, DEFAULT_DIALS.dl_day_target)
  assert.equal(dials.dl_context_on, DEFAULT_DIALS.dl_context_on)
})

test('every dl_ dial is a number or a boolean, never a string or a sentinel', () => {
  // The dial document round-trips through Mongo and an HTTP body. A string dial
  // would survive `resolveDials` as its own type and be compared against a
  // number at decide time.
  for (const key of EXPECTED) {
    const v = DEFAULT_DIALS[key as keyof Dials]
    assert.ok(typeof v === 'number' || typeof v === 'boolean', `${key} is ${typeof v}`)
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${key} is not finite`)
  }
})

// ── hold to expiry (spec 2026-10-05-delta-lean-hold-to-expiry-design.md) ────

test('dl_hold_to_expiry is a boolean dial, OFF by default, in the Delta lean section', () => {
  // Off in the defaults for the same reason `delta_lean_enabled` is: every
  // registry row resolves against this table, and a true here would turn all
  // four intraday books into weekly carries with no row edited.
  assert.equal(DEFAULT_DIALS.dl_hold_to_expiry, false)
  assert.ok(dlSection().includes('dl_hold_to_expiry'), 'visible in the panel')
  const { dials, unknown } = resolveDials({ dl_hold_to_expiry: true })
  assert.deepEqual(unknown, [], 'desk-api resolves it rather than dropping it')
  assert.equal(dials.dl_hold_to_expiry, true)
})

test('the intraday presets stay intraday: both resolve dl_hold_to_expiry false', () => {
  for (const key of ['delta-lean-aggressive', 'delta-lean-conservative']) {
    const { dials } = resolveDials(preset(key).dials as Record<string, number | boolean>)
    assert.equal(dials.dl_hold_to_expiry, false, key)
  }
})

test('each hold preset is its intraday parent plus dl_hold_to_expiry, and NOTHING else', () => {
  // The dial is the ONLY thing that distinguishes the family (spec "The new
  // family"): same numbers, same clock dials, same cap — so the hold book and
  // its intraday sibling compare on one axis, and a change to the parent is a
  // change to the child.
  const pairs: Array<[string, string, string]> = [
    ['delta-lean-hold-aggressive', 'delta-lean-aggressive', 'Delta lean — hold to expiry, aggressive (25L)'],
    ['delta-lean-hold-conservative', 'delta-lean-conservative', 'Delta lean — hold to expiry, conservative (25L)'],
  ]
  for (const [holdKey, parentKey, label] of pairs) {
    const hold = preset(holdKey)
    assert.equal(hold.label, label)
    const h = resolveDials(hold.dials as Record<string, number | boolean>)
    assert.deepEqual(h.unknown, [], `${holdKey} sets a dial the schema refuses`)
    const parent = resolveDials(preset(parentKey).dials as Record<string, number | boolean>).dials
    const moved = (Object.keys(parent) as (keyof Dials)[]).filter((k) => parent[k] !== h.dials[k])
    assert.deepEqual(moved, ['dl_hold_to_expiry'], `${holdKey} vs ${parentKey}`)
    assert.equal(h.dials.dl_hold_to_expiry, true)
    assert.equal(h.dials.delta_lean_enabled, true, `${holdKey} selects the engine`)
  }
})

test('dl_rupee_hold_s is 60s in the defaults, so a hold row without it resolves to 60', () => {
  // The four hold rows on file (2026-10-30) were registered before the dial:
  // a document with every other dial and not this one is what they hold. The
  // intraday rows resolve the same 60 and never read it.
  assert.equal(DEFAULT_DIALS.dl_rupee_hold_s, 60)
  const { dl_rupee_hold_s: _absent, ...onFile } = resolveDials(
    preset('delta-lean-hold-aggressive').dials as Record<string, number | boolean>,
  ).dials
  const { dials, unknown } = resolveDials(onFile)
  assert.deepEqual(unknown, [])
  assert.equal(dials.dl_hold_to_expiry, true)
  assert.equal(dials.dl_rupee_hold_s, 60)
})

test('the hold books inherit R1`s backstop: 30,000 / 15,000 for the BOOK`s life', () => {
  // On a hold book `dl_day_max_loss` reads the tag's lifetime P&L, so the
  // same number is a whole-week line, not a day's.
  const life = (key: string) => resolveDials(preset(key).dials as Record<string, number | boolean>).dials.dl_day_max_loss
  assert.equal(life('delta-lean-hold-aggressive'), 30_000)
  assert.equal(life('delta-lean-hold-conservative'), 15_000)
})

// ── the conservative column, opened and held (30 Oct 2026) ──────────────────
//
// The 30 Oct review found the neutralising adjustments lost money on balance
// in all four daily books: the opening legs alone beat the managed book. The
// operator's test: no adjustments on the conservative column, intraday and
// hold alike, against aggressive adjusting as before.

/** A preset folded onto the defaults — what a book registered from it runs. */
function resolvedPreset(key: string): Dials {
  const { dials, unknown } = resolveDials(preset(key).dials as Record<string, number | boolean>)
  assert.deepEqual(unknown, [], `${key} sets a dial the schema refuses`)
  return dials
}

test('conservative and hold-conservative are opened and held: 0 adjustments, the stuck floor ON the backstop', () => {
  for (const key of ['delta-lean-conservative', 'delta-lean-hold-conservative']) {
    const d = resolvedPreset(key)
    assert.equal(d.dl_max_adjusts_day, 0, `${key} adjusts nothing`)
    assert.equal(d.dl_day_max_loss, 15_000, `${key}: R1's backstop is unchanged`)
    // With no adjustment allowed every wanted one is BLOCKED and §6.4's clock
    // runs; at the backstop's level the backstop reads the same `totalPnl`
    // first, so the stuck exit can never fire ahead of it (zero spec D6).
    assert.equal(d.dl_stuck_loss, d.dl_day_max_loss, `${key}: the stuck floor sits on the backstop`)
  }
  // ...and on the HOLD book the backstop waits `dl_rupee_hold_s` first. Both
  // clocks start on the same pass through the floor, so it still wins only
  // while its wait is the shorter one.
  const hold = resolvedPreset('delta-lean-hold-conservative')
  assert.ok(
    hold.dl_rupee_hold_s < hold.dl_stuck_confirm_s,
    `rupee hold ${hold.dl_rupee_hold_s}s must stay under the ${hold.dl_stuck_confirm_s}s stuck window`,
  )
})

test('the 30 Oct switch-off moved nothing on aggressive, hold-aggressive, zero or 0-DTE', () => {
  // Aggressive is the comparison arm: it keeps adjusting, on its own numbers.
  for (const key of ['delta-lean-aggressive', 'delta-lean-hold-aggressive']) {
    const d = resolvedPreset(key)
    assert.equal(d.dl_max_adjusts_day, 6, key)
    assert.equal(d.dl_stuck_loss, 25_000, key)
    assert.equal(d.dl_day_max_loss, 30_000, key)
    assert.equal(d.dl_open_lots, 4, key)
    assert.equal(d.dl_adjust_confirm_s, 60, key)
    assert.equal(d.dl_adjust_cooldown_s, 600, key)
    assert.equal(d.chase_max_ms, 1_500, key)
  }
  // The zero books spread the conservative column but state both dials it
  // moved themselves, so their resolved sets cannot follow it.
  for (const key of ['delta-lean-zero', 'delta-lean-zero-0dte']) {
    const d = resolvedPreset(key)
    assert.equal(preset(key).dials.dl_max_adjusts_day, 0, `${key} states its own 0`)
    assert.equal(d.dl_max_adjusts_day, 0, key)
    assert.equal(d.dl_stuck_loss, 20_000, key)
    assert.equal(d.dl_day_max_loss, 20_000, key)
    assert.equal(d.dl_day_target, 0, key)
    assert.equal(d.dl_open_lots, 2, key)
    assert.equal(d.dl_adjust_confirm_s, 180, key)
    assert.equal(d.dl_adjust_cooldown_s, 900, key)
    assert.equal(d.chase_max_ms, 3_000, key)
  }
})

// ── the zero books (spec 2026-10-17-delta-lean-zero-design.md) ──────────────

const resolved = (key: string): Dials =>
  resolveDials(preset(key).dials as Record<string, number | boolean>).dials

test('the open`s gates are OFF in the defaults: no window, every regime, every day (D4)', () => {
  // Every registry row resolves against this table, so any other value here
  // would put a window or a regime filter on every delta-lean book at once.
  assert.equal(DEFAULT_DIALS.dl_open_by_min, 0)
  assert.equal(DEFAULT_DIALS.dl_open_fallback, false)
  assert.equal(DEFAULT_DIALS.dl_open_trend_up, true)
  assert.equal(DEFAULT_DIALS.dl_open_trend_down, true)
  assert.equal(DEFAULT_DIALS.dl_open_quiet, true)
  assert.equal(DEFAULT_DIALS.dl_expiry_day_only, false)
  for (const key of ['delta-lean-aggressive', 'delta-lean-conservative', 'pb-trend-drive']) {
    const d = resolved(key)
    assert.equal(d.dl_open_by_min, 0, key)
    assert.equal(d.dl_expiry_day_only, false, key)
  }
})

test('zero is the conservative column plus exactly trial #2615`s moves (spec §4)', () => {
  const con = resolved('delta-lean-conservative')
  const zero = resolved('delta-lean-zero')
  assert.deepEqual(resolveDials(preset('delta-lean-zero').dials as Record<string, number | boolean>).unknown, [])
  const moved = (Object.keys(con) as (keyof Dials)[]).filter((k) => con[k] !== zero[k])
  // `dl_max_adjusts_day` is NOT in this list since 30 Oct 2026: the column
  // itself went to 0, where the zero book already was. Zero still states its
  // own 0 (`want` below), so it does not move if the column comes back.
  assert.deepEqual([...moved].sort(), [
    'dl_adjust_confirm_s', 'dl_clean_min', 'dl_credit_short_delta_max', 'dl_day_max_loss',
    'dl_day_target', 'dl_flat_by_min', 'dl_flatten_passive_min', 'dl_flatten_urgent_min',
    'dl_long_delta_hi', 'dl_long_delta_lo', 'dl_open_by_min',
    'dl_open_fallback', 'dl_quiet_mult', 'dl_short_delta_hi', 'dl_short_delta_lo',
    'dl_stuck_loss', 'dl_trend_exit_mult', 'dl_trend_mult', 'dl_warmup_min', 'dl_wing_delta',
  ].sort())
  const want: Partial<Dials> = {
    dl_trend_mult: 1.94, dl_trend_exit_mult: 1.26, dl_clean_min: 0.62, dl_quiet_mult: 1.17,
    dl_adjust_confirm_s: 180, dl_warmup_min: 569, dl_open_by_min: 571, dl_open_fallback: true,
    dl_day_target: 0, dl_day_max_loss: 20_000, dl_stuck_loss: 20_000,
    dl_flatten_passive_min: 870, dl_flatten_urgent_min: 875, dl_flat_by_min: 880,
    dl_long_delta_lo: 0.63, dl_long_delta_hi: 0.73, dl_short_delta_lo: 0.3, dl_short_delta_hi: 0.4,
    dl_credit_short_delta_max: 0.24, dl_wing_delta: 0.03, dl_max_adjusts_day: 0,
  }
  for (const [k, v] of Object.entries(want)) assert.equal(zero[k as keyof Dials], v, k)
  // What the study left alone is the conservative column's, inherited.
  assert.equal(zero.dl_open_lots, 2)
  assert.equal(zero.dl_adjust_cooldown_s, 900)
  assert.equal(zero.chase_max_ms, 3_000)
  assert.equal(zero.margin_cap, 2_500_000)
  assert.equal(zero.dl_hold_to_expiry, false, 'an intraday book')
})

test('0-DTE is the zero book plus its four gates, and NOTHING else ("same params")', () => {
  const zero = resolved('delta-lean-zero')
  const odte = resolved('delta-lean-zero-0dte')
  assert.deepEqual(resolveDials(preset('delta-lean-zero-0dte').dials as Record<string, number | boolean>).unknown, [])
  const moved = (Object.keys(zero) as (keyof Dials)[]).filter((k) => zero[k] !== odte[k])
  assert.deepEqual([...moved].sort(), [
    'dl_expiry_day_only', 'dl_open_fallback', 'dl_open_quiet', 'dl_open_trend_up',
  ])
  assert.equal(odte.dl_expiry_day_only, true)
  assert.equal(odte.dl_open_trend_down, true, 'trend-down is the one regime it opens on')
  assert.equal(odte.dl_open_trend_up, false)
  assert.equal(odte.dl_open_quiet, false)
  // Stated off out loud, not left to `dl_open_quiet` to make inert.
  assert.equal(preset('delta-lean-zero-0dte').dials.dl_open_fallback, false)
})

test('the zero books are inert on an old build: a ₹0 target written in their own rows (D9)', () => {
  // An old supervisor drops the open dials as unknown and reads `0 >= 0` as a
  // target hit on its first pass — the latch that keeps the row from opening.
  for (const key of ['delta-lean-zero', 'delta-lean-zero-0dte']) {
    assert.equal(preset(key).dials.dl_day_target, 0, `${key} states the 0 itself`)
  }
})

test('the stuck floor sits ON the zero backstop, so the backstop always fires first (D6)', () => {
  for (const key of ['delta-lean-zero', 'delta-lean-zero-0dte']) {
    const d = resolved(key)
    assert.equal(d.dl_stuck_loss, d.dl_day_max_loss, key)
  }
})

test('the zero clock opens inside the warm-up-to-flatten day, in order', () => {
  for (const key of ['delta-lean-zero', 'delta-lean-zero-0dte']) {
    const d = resolved(key)
    assert.ok(d.dl_warmup_min <= d.dl_open_by_min, `${key}: the window ends after it starts`)
    assert.ok(d.dl_open_by_min < d.dl_flatten_passive_min, `${key}: and before the flatten`)
    assert.ok(d.dl_flatten_passive_min < d.dl_flatten_urgent_min)
    assert.ok(d.dl_flatten_urgent_min < d.dl_flat_by_min)
    assert.ok(d.dl_flat_by_min <= 900, `${key}: flat by 15:00 is a hard rule`)
  }
})
