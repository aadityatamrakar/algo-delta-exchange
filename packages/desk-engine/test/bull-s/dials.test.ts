/**
 * The bs_* dials (plan Task 3, spec §6.2): off by default, one section,
 * refused by name when out of range, and the six BTC presets.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIALS, DIAL_SECTIONS, resolveDials, type Dials } from '../../src/dials.ts'
import { PRESETS } from '../../src/presets.ts'

const BS_DEFAULTS = {
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

const bsOf = (d: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('bs_')))

test('the bs_* defaults are the plan`s table, with BULL-S off', () => {
  assert.deepEqual(bsOf(DEFAULT_DIALS as unknown as Record<string, unknown>), BS_DEFAULTS)
})

test('one BULL-S section holds every bs_* dial, behind bs_enabled, at the foot', () => {
  const s = DIAL_SECTIONS.find((x) => x.key === 'bull-s')
  assert.ok(s)
  assert.equal(s.toggle, 'bs_enabled')
  assert.deepEqual([...s.fields].sort(), Object.keys(BS_DEFAULTS).filter((k) => k !== 'bs_enabled').sort())
  assert.equal(DIAL_SECTIONS.at(-1)?.key, 'bull-s')
  for (const other of DIAL_SECTIONS) {
    if (other === s) continue
    assert.deepEqual([other.toggle ?? '', ...other.fields].filter((k) => k.startsWith('bs_')), [], other.key)
  }
})

test('an enabled book resolves with nothing unknown', () => {
  const { unknown, dials } = resolveDials({ bs_enabled: true, bs_strike_step: 200 })
  assert.deepEqual(unknown, [])
  assert.equal(dials.bs_strike_step, 200)
})

test('an out-of-range bs_* dial is refused BY NAME and keeps its default', () => {
  const cases: Array<[Partial<Record<keyof Dials, number | boolean>>, string]> = [
    [{ bs_strike_jump: 3 }, 'bs_strike_jump'],
    [{ bs_strike_jump: 1.5 }, 'bs_strike_jump'],
    [{ bs_strike_step: -200 }, 'bs_strike_step'],
    [{ bs_stop_mult: 1 }, 'bs_stop_mult'],
    [{ bs_stop_basis: 2 }, 'bs_stop_basis'],
    [{ bs_stop_confirm_s: -1 }, 'bs_stop_confirm_s'],
    [{ bs_lots_start: 0 }, 'bs_lots_start'],
    [{ bs_lots_start: 1.5 }, 'bs_lots_start'],
    [{ bs_lots_step: -1 }, 'bs_lots_step'],
    [{ bs_lots_cap: 2.5 }, 'bs_lots_cap'],
    [{ bs_max_open: -1 }, 'bs_max_open'],
    [{ bs_target: -5 }, 'bs_target'],
    [{ bs_loss_cap: -5 }, 'bs_loss_cap'],
    [{ bs_after_halt: 2 }, 'bs_after_halt'],
    [{ bs_entry_from_min: 1441 }, 'bs_entry_from_min'],
    [{ bs_entry_to_min: -1 }, 'bs_entry_to_min'],
    [{ bs_entry_weekdays: 128 }, 'bs_entry_weekdays'],
    [{ bs_no_entry_before_expiry_min: -1 }, 'bs_no_entry_before_expiry_min'],
    [{ bs_flat_before_expiry_min: -1 }, 'bs_flat_before_expiry_min'],
    [{ bs_ref_max_age_s: 0 }, 'bs_ref_max_age_s'],
    [{ bs_level_cooldown_s: -1 }, 'bs_level_cooldown_s'],
    [{ bs_close_req: -1 }, 'bs_close_req'],
    [{ bs_rearm_req: 0.5 }, 'bs_rearm_req'],
  ]
  for (const [raw, name] of cases) {
    const { unknown, dials } = resolveDials(raw as Record<string, number | boolean>)
    assert.deepEqual(unknown, [name], JSON.stringify(raw))
    assert.equal(dials[name as keyof Dials], DEFAULT_DIALS[name as keyof Dials], `${name} keeps its default`)
  }
})

test('an ENABLED book needs a strike step: 0 is refused by name, and only while enabled', () => {
  assert.deepEqual(resolveDials({ bs_enabled: true }).unknown, ['bs_strike_step'])
  assert.deepEqual(resolveDials({ bs_enabled: true, bs_strike_step: 0 }).unknown, ['bs_strike_step'])
  assert.deepEqual(resolveDials({ bs_strike_step: 0 }).unknown, [], 'off: 0 is the off-state')
  // The switch itself is never turned off by a bad step — that would hand the
  // book to another engine. The engine holds instead.
  assert.equal(resolveDials({ bs_enabled: true }).dials.bs_enabled, true)
})

test('a wrong-typed bs_* dial is refused by name, never coerced', () => {
  const { unknown, dials } = resolveDials({ bs_enabled: 1, bs_strike_step: true } as unknown as Record<string, number | boolean>)
  assert.deepEqual(unknown, ['bs_enabled', 'bs_strike_step'])
  assert.equal(dials.bs_enabled, false)
})

const PRESET_TABLE = {
  'bull-s-btc-daily': [200, 50, 50, 150, 4, 250, 60],
  'bull-s-btc-weekly': [500, 10, 10, 30, 4, 500, 60],
  'bull-s-btc-monthly': [1000, 10, 10, 30, 4, 500, 60],
} as const

test('the six BULL-S presets are the spec §6.2 table; the -2 twins differ only in the jump', () => {
  const keys = PRESETS.filter((p) => p.key.startsWith('bull-s-')).map((p) => p.key)
  assert.deepEqual(keys, [
    'bull-s-btc-daily', 'bull-s-btc-daily-2',
    'bull-s-btc-weekly', 'bull-s-btc-weekly-2',
    'bull-s-btc-monthly', 'bull-s-btc-monthly-2',
  ])
  for (const [k, [step, start, lotStep, cap, maxOpen, lossCap, blackout]] of Object.entries(PRESET_TABLE)) {
    for (const [key, jump] of [[k, 1], [`${k}-2`, 2]] as const) {
      const p = PRESETS.find((x) => x.key === key)
      assert.ok(p, key)
      const { dials, unknown } = resolveDials(p.dials as Record<string, number | boolean>)
      assert.deepEqual(unknown, [], key)
      assert.deepEqual(
        [dials.bs_strike_step, dials.bs_lots_start, dials.bs_lots_step, dials.bs_lots_cap, dials.bs_max_open,
          dials.bs_loss_cap, dials.bs_no_entry_before_expiry_min],
        [step, start, lotStep, cap, maxOpen, lossCap, blackout],
        key,
      )
      assert.equal(dials.bs_strike_jump, jump, key)
      assert.equal(dials.bs_enabled, true)
      assert.equal(dials.bs_stop_mult, 1.25)
      assert.equal(dials.bs_stop_basis, 1)
      assert.equal(dials.bs_stop_confirm_s, 3)
      assert.equal(dials.bs_target, 0)
      assert.equal(dials.bs_after_halt, 0)
      assert.equal(dials.bs_enter_on_start, true)
      assert.ok(dials.bs_lots_cap > 0, `${key}: every BTC preset is capped (spec C9)`)
      // Selects BULL-S and nothing else.
      assert.equal(dials.delta_lean_enabled, false, key)
      assert.equal(dials.pb_playbook, 0, key)
    }
    const one = PRESETS.find((x) => x.key === k)!.dials
    const two = PRESETS.find((x) => x.key === `${k}-2`)!.dials
    assert.deepEqual({ ...two, bs_strike_jump: 1 }, one, `${k}-2 is ${k} with jump 2 and nothing else`)
  }
})
