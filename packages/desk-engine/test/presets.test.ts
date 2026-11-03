/**
 * THE TWENTY-THREE PREFILLS, AND THE ONE PAIR THAT IS NOT THE SAME BOOK.
 *
 * A preset is what an operator picks when creating a book, so a wrong value
 * here is a live short book run on dials nobody measured. Five classes of
 * mistake are pinned:
 *
 *   1. A KEY THAT IS NOT A DIAL. `Partial<Dials>` only checks the keys a
 *      transcriber spelled correctly at compile time — a typo'd key in a
 *      literal is a compile error, but a key that was CORRECT and later
 *      renamed in `Dials` is not, so the reflective subset check stands.
 *
 *   2. A DIAL LEFT OUT. The dangerous half of a `Partial`: an omitted field
 *      inherits `DEFAULT_DIALS`, which is the relief-r LIVE set, so omitting
 *      one of the two blocks the live set turns ON silently gives a preset
 *      behaviour Python never gave it. Nothing type-checks that. The two
 *      sweeps below therefore assert over the RESOLVED dials — the preset
 *      folded onto the defaults, which is what a book actually runs — and
 *      that is what caught eight presets inheriting shorts-only steering.
 *
 *   3. relief-r LIVE vs relief-r BOARD. Same playbook, two different books:
 *      the live desk runs `delta_shorts_only`/`gamma_shorts_only` ON (the
 *      operator's 2026-08-12 call, playbooks.py:424-465), while every
 *      committed backtest board was measured with them OFF. Reading one
 *      preset's numbers off the other's board is exactly the confusion the
 *      split preset exists to stop.
 *
 *   4. THE eod3 QUIRK. `playbooks.py:615` pops `min_sell_delta` so it falls
 *      back to `scrap_close_delta` (0.10) in `RuleEngine.__init__`. Inherited
 *      as the PARENT's pinned 0.0 instead, eod3 would sell 0.05-delta packages
 *      and scrap them on the next mark — two spread crossings, no delta shed.
 *
 *   5. A PLAYBOOK THAT TRADES ON AN OLD BUILD (six-playbooks D9). A build
 *      that does not know `pb_playbook` drops it as an unknown dial and runs
 *      the book as a plain delta-lean book, which opens `dl_open_lots`. Every
 *      playbook preset therefore carries `dl_open_lots: 0`, and the six
 *      columns of the spec's §8.2, as the spec review amended them, are
 *      transcribed below rather than read off the file under test.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  PRESETS,
  resolveDials,
  type Dials,
  type Preset,
} from '@algomaker/desk-engine'

/** The six playbook presets, in spec §5 order. */
const PLAYBOOK_KEYS = [
  'pb-trend-drive',
  'pb-wing-straddle',
  'pb-reversal',
  'pb-expiry-drive',
  'pb-expiry-theta',
  'pb-expiry-gamma',
]

function preset(key: string) {
  const p = PRESETS.find((x) => x.key === key)
  assert.ok(p !== undefined, `no preset ${key}`)
  return p
}

/** What a book created from this preset actually runs on: the preset folded
 * onto `DEFAULT_DIALS`, which is what every consumer of a preset does. A
 * preset's OWN literal is not the answer — an omitted field inherits the
 * live-relief default, and that is exactly where this file has caught a bug. */
function resolved(p: Preset) {
  const { dials, unknown } = resolveDials(
    p.dials as Record<string, number | boolean>,
  )
  assert.deepEqual(unknown, [], `${p.key} sets a dial the schema refuses`)
  return dials
}

test('there are twenty-five presets, each keyed once', () => {
  assert.equal(PRESETS.length, 25)
  const keys = PRESETS.map((p) => p.key)
  assert.equal(new Set(keys).size, 25)
  assert.deepEqual(keys, [
    'recenter-r',
    'recenter-eod-r',
    'recenter-eod3-r',
    'recenter-atm-r',
    'recenter-otm-r',
    'recenter-relief-r',
    'recenter-relief-r-board',
    'recenter-relief-b1-r',
    'recenter-relief-b2-r',
    'recenter-relief-free-r',
    'recenter-trend-r',
    'recenter-reshift-r',
    'recenter-crossfill-r',
    // The two that select the delta-lean engine rather than a recenter
    // playbook — last, so the thirteen ported variants keep their order.
    'delta-lean-aggressive',
    'delta-lean-conservative',
    // Their hold-to-expiry siblings (2026-10-05): the same two books carried
    // to the contract's expiry.
    'delta-lean-hold-aggressive',
    'delta-lean-hold-conservative',
    // The tuned conservative book and its 0-DTE trend-down sibling
    // (2026-10-17): the daily family's two newest columns.
    'delta-lean-zero',
    'delta-lean-zero-0dte',
    // The six playbooks (2026-10-16), in the spec's §5 order: three intraday,
    // then three expiry-day. `pb-` and not `delta-lean-`, so every sweep that
    // selects the delta-lean family by prefix still finds only its own.
    'pb-trend-drive',
    'pb-wing-straddle',
    'pb-reversal',
    'pb-expiry-drive',
    'pb-expiry-theta',
    'pb-expiry-gamma',
  ])
})

test('every preset writes real dials, of the right type', () => {
  const schema = DEFAULT_DIALS as unknown as Record<string, number | boolean>
  for (const p of PRESETS) {
    assert.ok(p.label.length > 0, `${p.key} has no label`)
    const entries = Object.entries(p.dials) as Array<
      [string, number | boolean | undefined]
    >
    assert.ok(entries.length > 0, `${p.key} sets nothing`)
    for (const [k, v] of entries) {
      assert.ok(k in schema, `${p.key} sets unknown dial ${k}`)
      assert.equal(
        typeof v,
        typeof schema[k],
        `${p.key}.${k} is a ${typeof v}, the dial is a ${typeof schema[k]}`,
      )
    }
  }
})

test('exactly one preset RESOLVES to shorts-only steering', () => {
  // The dial that is absent from every shipped Python playbook and present
  // only on the live desk's own relief-r book (operator, 2026-08-12).
  //
  //   playbooks.py:555-557  DEFAULTS["recenter-relief"] stays absent both,
  //                         "non-negotiable", so the board reproduces.
  //   playbooks.py:2968-72  "Absent the dial this is exactly K.net_gamma,
  //                         which is what keeps recenter and its four
  //                         siblings byte-identical."
  //   playbooks.py:3002-05  "The dial is absent from every shipped playbook."
  //
  // Both read sites are `if not p.get(...)`, so absent means WHOLE-BOOK
  // greeks. `DEFAULT_DIALS` is the live set and turns the pair ON, so a
  // preset that merely omits it inherits steering it was never measured
  // with — invisible until a book carries a hedge leg, whose positive gamma
  // narrows the band and whose delta damps the shed. This sweep is over the
  // RESOLVED dials for that reason: omission is the bug, not the literal.
  const shortsOnly: string[] = []
  for (const p of PRESETS) {
    const d = resolved(p)
    assert.equal(
      d.delta_shorts_only,
      d.gamma_shorts_only,
      `${p.key} resolves the pair half-on`,
    )
    if (d.delta_shorts_only) shortsOnly.push(p.key)
  }
  assert.deepEqual(shortsOnly, ['recenter-relief-r'])
})

test('the other twelve resolve to whole-book greeks, by name', () => {
  for (const key of [
    'recenter-r',
    'recenter-eod-r',
    'recenter-eod3-r',
    'recenter-atm-r',
    'recenter-otm-r',
    'recenter-relief-r-board',
    // b1/b2/free spread the BOARD dict in Python (playbooks.py:558-560), so
    // they are absent both dials exactly like their parent.
    'recenter-relief-b1-r',
    'recenter-relief-b2-r',
    'recenter-relief-free-r',
    'recenter-trend-r',
    'recenter-reshift-r',
    'recenter-crossfill-r',
  ]) {
    const d = resolved(preset(key))
    assert.equal(d.delta_shorts_only, false, `${key} delta_shorts_only`)
    assert.equal(d.gamma_shorts_only, false, `${key} gamma_shorts_only`)
  }
})

test('relief-r live and relief-r board differ ONLY by the shorts-only pair', () => {
  const live = preset('recenter-relief-r')
  const board = preset('recenter-relief-r-board')
  assert.equal(live.dials.delta_shorts_only, true)
  assert.equal(live.dials.gamma_shorts_only, true)
  assert.equal(board.dials.delta_shorts_only, false)
  assert.equal(board.dials.gamma_shorts_only, false)
  assert.deepEqual(
    { ...board.dials, delta_shorts_only: true, gamma_shorts_only: true },
    live.dials,
  )
})

test('recenter-r is plain recenter: no shift, unwind on, 20-day band shrink', () => {
  // playbooks.py:349-362 — DEFAULTS["recenter"].
  const { dials } = preset('recenter-r')
  assert.equal(dials.delta_tol_pct, 0.02)
  assert.equal(dials.tol_ref_dte, 20)
  assert.equal(dials.strikes_out, 2)
  assert.equal(dials.min_sell_dte, 1)
  assert.equal(dials.scrap_close_delta, 0)
  assert.equal(dials.min_sell_delta, 0.15) // PINNED, not inherited
  assert.equal(dials.unwind_enabled, true) // unwind_added_first
  assert.equal(dials.balance_enabled, true)
  assert.equal(dials.balance_min_dte, 7)
  // The shift block is ABSENT in Python, and the engine default is relief-r's
  // ON — so plain recenter has to say off out loud.
  assert.equal(dials.shift_enabled, false)
})

test('recenter-eod arms the 15:15 sweep and un-pins what the A/B must isolate', () => {
  // playbooks.py:585-587.
  const { dials } = preset('recenter-eod-r')
  assert.equal(dials.eod_flat_min, 15 * 60 + 15)
  assert.equal(dials.scrap_close_delta, 0)
  assert.equal(dials.min_sell_delta, 0)
  assert.equal(dials.unwind_enabled, false)
  assert.equal(dials.tol_ref_dte, 0)
  assert.equal(dials.delta_tol_pct, 0.02)
})

test('recenter-eod3 widens the corridor and inherits the scrap delta as its sell floor', () => {
  // playbooks.py:613-615 — the pop() quirk, spelled out rather than inherited.
  const { dials } = preset('recenter-eod3-r')
  assert.equal(dials.delta_tol_pct, 0.03)
  assert.equal(dials.scrap_close_delta, 0.1)
  assert.equal(dials.min_sell_delta, 0.1)
  assert.equal(dials.eod_flat_min, 15 * 60 + 15)
})

test('atm and otm shift on spot at any margin, landing 0 and 1 steps out', () => {
  // playbooks.py:404-411. shift_margin_frac is ABSENT there, which in Python
  // disables the GATE — so it must be written as 0 against a 0.60 default.
  const atm = preset('recenter-atm-r').dials
  const otm = preset('recenter-otm-r').dials
  assert.equal(atm.shift_enabled, true)
  assert.equal(atm.shift_itm_steps, 1)
  assert.equal(atm.shift_land_steps, 0)
  assert.equal(atm.shift_margin_frac, 0)
  assert.equal(otm.shift_land_steps, 1)
  assert.equal(otm.shift_margin_frac, 0)
})

test('relief shifts only above 60% of the cap, and does not hedge that mark', () => {
  // playbooks.py:472-477.
  const { dials } = preset('recenter-relief-r')
  assert.equal(dials.shift_enabled, true)
  assert.equal(dials.shift_itm_steps, 0.5)
  assert.equal(dials.shift_land_steps, 2)
  assert.equal(dials.shift_margin_frac, 0.6)
  assert.equal(dials.hedge_after_shift, false)
})

test('the convexity-floor arms are relief plus one dial each', () => {
  // playbooks.py:558-560.
  const parent = preset('recenter-relief-r-board').dials
  assert.deepEqual(preset('recenter-relief-b1-r').dials, {
    ...parent,
    min_band_lots: 1,
  })
  assert.deepEqual(preset('recenter-relief-b2-r').dials, {
    ...parent,
    min_band_lots: 2,
  })
  assert.deepEqual(preset('recenter-relief-free-r').dials, {
    ...parent,
    no_band_floor: true,
  })
})

test('trend leans, reshift banks half its loss, crossfill banks all of it elsewhere', () => {
  // playbooks.py:626, 647-649, 658-660.
  const trend = preset('recenter-trend-r').dials
  assert.equal(trend.trend_enabled, true)
  assert.equal(trend.trend_skew, 0.5)

  const reshift = preset('recenter-reshift-r').dials
  assert.equal(reshift.trend_enabled, false) // trend_skew None = near edge
  assert.equal(reshift.recycle_frac, 0.5)
  assert.equal(reshift.recycle_bank, true)
  assert.equal(reshift.recycle_opposite, false)
  assert.equal(reshift.scrap_close_delta, 0.1)
  assert.equal(reshift.min_sell_delta, 0.15) // still the parent's pin

  const crossfill = preset('recenter-crossfill-r').dials
  assert.deepEqual(crossfill, {
    ...reshift,
    recycle_opposite: true,
    recycle_frac: 1,
  })
})

test('every preset carries the recenter family target and cap', () => {
  // variants.py:387-564 — default_target_pnl / default_margin_cap are the
  // same on all twelve so the boards compare on one axis. The two delta-lean
  // presets carry the same target_pnl (DELTA_LEAN_BASE restates it so every
  // preset still compares on one axis) but D4's own margin cap — ₹25 lakh,
  // not the recenter family's ₹10cr.
  const deltaLeanMarginCap = new Set([
    'delta-lean-aggressive',
    'delta-lean-conservative',
    'delta-lean-hold-aggressive',
    'delta-lean-hold-conservative',
    'delta-lean-zero',
    'delta-lean-zero-0dte',
    // The playbooks spread the same base, so they carry the same D4 cap.
    ...PLAYBOOK_KEYS,
  ])
  for (const p of PRESETS) {
    assert.equal(p.dials.target_pnl, 250000, p.key)
    assert.equal(
      p.dials.margin_cap,
      deltaLeanMarginCap.has(p.key) ? 2_500_000 : 100000000,
      p.key,
    )
  }
})

// ── PORTED FROM PYTHON — the DIAL-RELATIONSHIP tests of ─────────────────────
//    `test_sim_recenter_eod.py`, `_eod3.py` and `_relief_band.py`.
//
// Those files check `P.DEFAULTS[key] == {**parent, **extra}` — that an A/B arm
// differs from its parent by the dials it is NAMED for and by nothing else.
// The Python registry is gone, but the claim is not: `presets.ts` is where the
// same twelve variants live now, and an arm that quietly drifted would make
// every committed board it was measured against unreadable.
//
// Compared over the RESOLVED dials (the preset folded onto `DEFAULT_DIALS`),
// because that is what a book created from the preset actually runs — see the
// note above `resolved`.

/** The dial names on which two resolved sets differ. */
function differingDials(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return Object.keys(a)
    .filter((k) => a[k] !== b[k])
    .sort()
}

test('PORTED: the relief BAND arms differ from relief by their floor dial and NOTHING else', () => {
  // `test_arms_inherit_every_other_relief_dial` — "the A/B has to isolate the
  // floor, so nothing else may drift" — and `test_relief_carries_neither_dial`,
  // which is non-negotiable: the arms spread FROM the parent, never into it.
  const parent = resolved(preset('recenter-relief-r-board')) as unknown as Record<string, unknown>
  assert.equal(parent['min_band_lots'], 0, 'relief-r itself carries neither dial')
  assert.equal(parent['no_band_floor'], false)

  const table: Record<string, string[]> = {
    'recenter-relief-b1-r': ['min_band_lots'],
    'recenter-relief-b2-r': ['min_band_lots'],
    'recenter-relief-free-r': ['no_band_floor'],
  }
  for (const [key, expected] of Object.entries(table)) {
    const arm = resolved(preset(key)) as unknown as Record<string, unknown>
    assert.deepEqual(differingDials(parent, arm), expected, key)
  }
  assert.equal(
    (resolved(preset('recenter-relief-b1-r')) as unknown as Record<string, unknown>)['min_band_lots'],
    1,
  )
  assert.equal(
    (resolved(preset('recenter-relief-b2-r')) as unknown as Record<string, unknown>)['min_band_lots'],
    2,
  )
})

test('PORTED: recenter-eod differs from recenter by the sweep and its pinned dials', () => {
  // `test_only_the_sweep_and_the_pinned_dials_differ_from_recenter`: this
  // variant "used to differ from recenter by eod_flat_min ALONE", and the
  // 2026-07-30 delta-scrap work pinned two more on the parent that eod keeps at
  // its pre-07-30 values so the EOD A/B stays readable.
  const parent = resolved(preset('recenter-r')) as unknown as Record<string, unknown>
  const eod = resolved(preset('recenter-eod-r')) as unknown as Record<string, unknown>
  assert.ok(differingDials(parent, eod).includes('eod_flat_min'))
  assert.equal(eod['eod_flat_min'], 15 * 60 + 15, 'the dial IS 15:15')
  assert.equal(parent['eod_flat_min'], 0, 'and the parent is untouched — the board must stay comparable')
})

test('PORTED: eod3 differs from eod by exactly three dials, and the parent is untouched', () => {
  // `test_sim_recenter_eod3.py:test_only_the_two_intended_dials_differ_from_the_parent`
  // — whose own assertion names THREE (`{delta_tol_pct, scrap_close_delta,
  // min_sell_delta}`), because moving the scrap dial drags the entry gate with
  // it; only two were INTENDED and the third is the consequence — plus
  // `test_the_parent_is_untouched`.
  const eod = resolved(preset('recenter-eod-r')) as unknown as Record<string, unknown>
  const eod3 = resolved(preset('recenter-eod3-r')) as unknown as Record<string, unknown>
  assert.deepEqual(differingDials(eod, eod3), [
    'delta_tol_pct',
    'min_sell_delta',
    'scrap_close_delta',
  ])
  assert.equal(eod3['delta_tol_pct'], 0.03)
  assert.equal(eod3['scrap_close_delta'], 0.1)

  // The parent, which is what keeps its committed board valid.
  assert.equal(eod['delta_tol_pct'], 0.02)
  assert.equal(eod['scrap_close_delta'], 0)
  assert.equal(eod['min_sell_delta'], 0)
  assert.equal(
    (resolved(preset('recenter-r')) as unknown as Record<string, unknown>)['delta_tol_pct'],
    0.02,
  )
})

test('PORTED: THE eod3 QUIRK — min_sell_delta INHERITS the scrap, it is not pinned to 0', () => {
  // `test_min_sell_delta_is_absent_so_it_inherits_the_scrap`: "absent, not 0.0 —
  // the parent pins 0.0 and inheriting that alongside a 0.10 scrap would sell
  // 0.05-delta packages and square them off on the next mark". Two spread
  // crossings, no delta shed.
  const eod3 = resolved(preset('recenter-eod3-r')) as unknown as Record<string, unknown>
  assert.equal(eod3['scrap_close_delta'], 0.1)
  assert.equal(eod3['min_sell_delta'], 0.1, 'the entry gate tracks the exit')

  // The parent's own pin is the opposite case and stays as it is (user-directed
  // 2026-07-31): the exit is OFF and the entry gate is PINNED at 0.15.
  const parent = resolved(preset('recenter-r')) as unknown as Record<string, unknown>
  assert.equal(parent['scrap_close_delta'], 0)
  assert.equal(parent['min_sell_delta'], 0.15)
})

// ── THE SIX PLAYBOOKS (six-playbooks spec §8.2) ─────────────────────────────

/**
 * Spec §8.2 as the spec review amended it, transcribed column by column —
 * deliberately NOT read off `presets.ts`, for the reason the dial table in
 * `dials.test.ts` is not read off `DEFAULT_DIALS`.
 *
 * A dial a column leaves blank is one the playbook does not use, and it is not
 * listed here, EXCEPT the time exit and the expiry-only flag: a blank there is
 * a statement — this book has no time exit; this book is not an expiry book —
 * so each is pinned at its off-state. Expiry Theta's and Expiry Gamma's COMMON
 * rupee trail is 0 before AND after `pb_late_min`: both books trade after
 * 13:00, where the default late start would otherwise arm a trail the spec
 * never gave them (Gamma trails its premium instead).
 */
const PLAYBOOK_COLUMNS: Record<string, { readonly label: string; readonly dials: Partial<Dials> }> = {
  'pb-trend-drive': {
    label: 'Playbook — Trend Drive',
    dials: {
      pb_playbook: 1,
      pb_min_dte: 1, pb_expiry_day_only: false,
      pb_entry_start_min: 570, pb_entry_end_min: 615,
      pb_max_entries: 1,
      pb_confirm_s: 120,
      pb_trade_max_loss: 6_000, pb_trade_target: 12_000, pb_target_max_frac: 0.7,
      pb_trail_start: 0, pb_late_trail_start: 2_000, pb_late_min: 780, pb_trail_keep: 0.6,
      pb_time_exit_min: 0,
      pb_strike_mode: 0, pb_debit_stop_frac: 0.4, pb_flip_confirm_s: 90,
      pb_max_adds: 1, pb_add_ext_k: 0.5,
      pb_gap_min_pct: 0.25,
      dl_day_max_loss: 9_000, dl_day_target: 15_000,
    },
  },
  'pb-wing-straddle': {
    label: 'Playbook — Wing Straddle',
    dials: {
      pb_playbook: 2,
      pb_min_dte: 5, pb_expiry_day_only: false,
      pb_lots: 1,
      pb_entry_start_min: 570, pb_entry_end_min: 750,
      pb_max_entries: 2, pb_reentry_cooldown_s: 1_200,
      pb_confirm_s: 120,
      pb_trade_max_loss: 8_000, pb_trade_target: 6_000,
      pb_trail_start: 0, pb_late_trail_start: 2_000, pb_trail_keep: 0.5,
      pb_time_exit_min: 0,
      pb_wing_str_k: 1.5, pb_wing_min_steps: 4, pb_combined_stop: 0.25,
      pb_stop_str_k: 1.0, pb_max_move_k: 0.75,
      pb_gap_max_pct: 0.6, pb_stop_hold_s: 20,
      dl_day_max_loss: 12_000, dl_day_target: 12_000,
    },
  },
  'pb-reversal': {
    label: 'Playbook — Reversal Spread',
    dials: {
      pb_playbook: 3,
      pb_min_dte: 1, pb_expiry_day_only: false,
      pb_entry_start_min: 600, pb_entry_end_min: 810,
      pb_max_entries: 1,
      pb_confirm_s: 120,
      pb_trade_max_loss: 6_000, pb_trade_target: 12_000, pb_target_max_frac: 0.7,
      pb_trail_start: 0, pb_late_trail_start: 2_000, pb_trail_keep: 0.6,
      pb_time_exit_min: 0,
      pb_strike_mode: 0, pb_debit_stop_frac: 0.4, pb_flip_confirm_s: 90, pb_max_adds: 0,
      pb_rev_min_ext: 0.6, pb_rev_retrace: 0.35, pb_rev_stop_k: 0.1, pb_stop_hold_s: 20,
      dl_day_max_loss: 9_000, dl_day_target: 15_000,
    },
  },
  'pb-expiry-drive': {
    label: 'Playbook — Expiry Drive',
    dials: {
      pb_playbook: 4,
      pb_min_dte: 0, pb_expiry_day_only: true,
      pb_entry_start_min: 570, pb_entry_end_min: 615,
      pb_max_entries: 1,
      pb_confirm_s: 90,
      pb_trade_max_loss: 4_000, pb_trade_target: 5_000, pb_target_max_frac: 0.7,
      pb_trail_start: 3_000, pb_late_trail_start: 3_000, pb_trail_keep: 0.6,
      pb_time_exit_min: 720,
      pb_strike_mode: 1, pb_short_str_k: 1.0, pb_debit_stop_frac: 0.5, pb_flip_confirm_s: 60,
      pb_gap_min_pct: 0.25,
      dl_day_max_loss: 6_000, dl_day_target: 10_000,
    },
  },
  'pb-expiry-theta': {
    label: 'Playbook — Expiry Theta Fly',
    dials: {
      pb_playbook: 5,
      pb_min_dte: 0, pb_expiry_day_only: true,
      pb_entry_start_min: 780, pb_entry_end_min: 855,
      pb_max_entries: 2, pb_reentry_cooldown_s: 900,
      pb_confirm_s: 120,
      pb_trade_max_loss: 4_000, pb_trade_target: 0,
      pb_trail_start: 0, pb_late_trail_start: 0,
      pb_time_exit_min: 0,
      pb_wing_str_k: 1.25, pb_wing_min_steps: 2, pb_combined_stop: 0, pb_stop_str_k: 0,
      pb_calm_min: 30, pb_calm_mult: 1.5, pb_max_move_k: 1.2, pb_target_frac: 0.5,
      pb_trend_exit_s: 60,
      dl_day_max_loss: 8_000, dl_day_target: 10_000,
    },
  },
  'pb-expiry-gamma': {
    label: 'Playbook — Expiry Gamma Breakout',
    dials: {
      pb_playbook: 6,
      pb_min_dte: 0, pb_expiry_day_only: true,
      pb_entry_start_min: 750, pb_entry_end_min: 870,
      pb_max_entries: 2, pb_reentry_cooldown_s: 600,
      pb_confirm_s: 30,
      pb_trade_max_loss: 4_000, pb_trade_target: 0,
      pb_trail_start: 0, pb_late_trail_start: 0, pb_trail_keep: 0.6,
      pb_time_exit_min: 0,
      pb_box_min: 60, pb_box_max_k: 1.5, pb_brk_buf_k: 0.5,
      pb_premium_budget: 6_000, pb_gamma_max_lots: 4, pb_otm_steps: 1,
      pb_prem_stop_frac: 0.5, pb_prem_trail_arm: 0.8, pb_stop_hold_s: 30,
      dl_day_max_loss: 8_000, dl_day_target: 15_000,
    },
  },
}

test('each playbook preset resolves with no unknowns and carries its §8.2 column exactly', () => {
  assert.deepEqual(Object.keys(PLAYBOOK_COLUMNS), PLAYBOOK_KEYS)
  for (const [key, column] of Object.entries(PLAYBOOK_COLUMNS)) {
    const p = preset(key)
    assert.equal(p.label, column.label, key)
    const d = resolved(p) as unknown as Record<string, unknown>
    for (const [dial, want] of Object.entries(column.dials)) {
      assert.equal(d[dial], want, `${key}.${dial}`)
    }
  }
})

test('the six ids are 1 to 6, in spec order, one preset each', () => {
  assert.deepEqual(
    PLAYBOOK_KEYS.map((k) => resolved(preset(k)).pb_playbook),
    [1, 2, 3, 4, 5, 6],
  )
})

test('every playbook preset is INERT on an old build: dl_open_lots 0, written out loud (D9)', () => {
  // A build that does not know `pb_playbook` drops it and runs the row as a
  // plain delta-lean book, which sizes its open off `dl_open_lots` — resolved
  // against THAT build's defaults, where it is 4. So the 0 must be in the
  // preset's own literal, not merely in the resolved set of this build.
  for (const key of PLAYBOOK_KEYS) {
    const p = preset(key)
    assert.equal(p.dials.dl_open_lots, 0, `${key} states dl_open_lots: 0`)
    assert.equal(p.dials.delta_lean_enabled, true, `${key} is a delta-lean book to every build`)
    assert.ok((p.dials.pb_playbook ?? 0) >= 1, `${key} names its playbook`)
  }
})

test('the playbooks steer on whole-book greeks, inherited from the delta-lean base', () => {
  for (const key of PLAYBOOK_KEYS) {
    const d = resolved(preset(key))
    assert.equal(d.delta_shorts_only, false, `${key} delta_shorts_only`)
    assert.equal(d.gamma_shorts_only, false, `${key} gamma_shorts_only`)
    assert.equal(d.delta_lean_enabled, true, key)
    assert.equal(d.confirm_ms, 1_000, `${key} confirms in 1s, as its base`)
    assert.equal(d.cooldown_s, 0, `${key} never cools down, as its base`)
  }
})

test('a playbook moves nothing on the delta-lean base but the open lots and its two day exits', () => {
  // Everything the host does for a delta-lean book — the cadence, the order
  // budgets, the clock, the detector — must apply to a playbook book unchanged
  // (spec §4.1). So against the aggressive delta-lean book, the only non-pb
  // dials a playbook may move are the fail-safe and the day's backstop and
  // target.
  const base = resolved(preset('delta-lean-aggressive')) as unknown as Record<string, unknown>
  const allowed = new Set(['dl_open_lots', 'dl_day_max_loss', 'dl_day_target'])
  for (const key of PLAYBOOK_KEYS) {
    const d = resolved(preset(key)) as unknown as Record<string, unknown>
    const moved = Object.keys(base).filter((k) => !k.startsWith('pb_') && base[k] !== d[k])
    assert.ok(moved.includes('dl_open_lots'), `${key} must move dl_open_lots`)
    for (const k of moved) assert.ok(allowed.has(k), `${key} moves ${k}`)
  }
})

test('intraday playbooks never trade 0-DTE; expiry playbooks trade nothing else (D8)', () => {
  for (const key of ['pb-trend-drive', 'pb-wing-straddle', 'pb-reversal']) {
    const d = resolved(preset(key))
    assert.equal(d.pb_expiry_day_only, false, key)
    assert.ok(d.pb_min_dte >= 1, `${key} min DTE ${d.pb_min_dte}`)
  }
  for (const key of ['pb-expiry-drive', 'pb-expiry-theta', 'pb-expiry-gamma']) {
    const d = resolved(preset(key))
    assert.equal(d.pb_expiry_day_only, true, key)
    assert.equal(d.pb_min_dte, 0, key)
  }
})

test('every entry window opens after the warm-up and closes before the 14:50 flatten', () => {
  for (const key of PLAYBOOK_KEYS) {
    const d = resolved(preset(key))
    assert.ok(d.pb_entry_start_min >= d.dl_warmup_min, `${key} opens inside the warm-up`)
    assert.ok(d.pb_entry_end_min > d.pb_entry_start_min, `${key} has an empty window`)
    assert.ok(d.pb_entry_end_min <= d.dl_flatten_passive_min, `${key} enters into the flatten`)
  }
})
