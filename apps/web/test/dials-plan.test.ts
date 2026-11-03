/**
 * THE DIALS PANEL'S ARITHMETIC, WITHOUT A DOM.
 *
 * Everything the panel decides before it draws anything lives in
 * `dials-plan.ts`: which section a dial belongs to, whether the value on
 * screen is the preset's own or one the operator changed, whether the engine
 * still reads it, and what a Save should actually send. Those are the parts
 * that can be WRONG IN SILENCE — a field that renders "preset default" while
 * carrying an override is a book the operator believes is running relief when
 * it is not — so they are pinned here rather than asserted through rendered
 * text.
 *
 * `.test.ts`, not `.tsx`: node:test runs this (repo-root `npm run test:node`),
 * and it must stay DOM-free to do so. The panel's own rendering is
 * `dials-panel.test.tsx`, under vitest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIALS } from '@algomaker/desk-engine/dials'
import { PRESETS } from '@algomaker/desk-engine/presets'
import {
  dialsPatch,
  fieldOf,
  planDialsView,
  presetDials,
  sectionOf,
} from '../src/dials-plan.ts'

const RELIEF = 'recenter-relief-r'

/** Every field row in the view, sections flattened, toggles included. */
function allFields(preset: string, overrides: Record<string, number | boolean>) {
  const view = planDialsView(preset, overrides)
  return view.sections.flatMap((s) => (s.toggle === null ? [] : [s.toggle]).concat(s.fields))
}

test('a preset with no overrides shows the preset everywhere, overridden nowhere', () => {
  const view = planDialsView(RELIEF, {})
  assert.equal(view.presetKnown, true)
  assert.deepEqual(view.unknown, [])
  for (const f of allFields(RELIEF, {})) {
    assert.equal(f.overridden, false, `${f.key} claims to be overridden by an empty document`)
  }
  // The live relief set, not the engine default, is what the rows show.
  assert.equal(fieldOf(view, 'delta_shorts_only')?.value, true)
  assert.equal(fieldOf(view, 'shift_margin_frac')?.value, 0.6)
})

test('ONE overridden dial is the only one that says so, and it carries the new value', () => {
  const view = planDialsView(RELIEF, { delta_tol_pct: 0.03 })
  const changed = fieldOf(view, 'delta_tol_pct')
  assert.equal(changed?.value, 0.03)
  assert.equal(changed?.overridden, true)
  for (const f of allFields(RELIEF, { delta_tol_pct: 0.03 })) {
    if (f.key === 'delta_tol_pct') continue
    assert.equal(f.overridden, false, `${f.key} was marked overridden and was not touched`)
  }
})

/**
 * A stored value that MATCHES the preset is not an override, whatever the
 * document says. The indicator answers "does this book differ from the preset
 * it was built from", and a row that reads `0.02` beside a preset that says
 * `0.02` differs from nothing.
 */
test('a stored dial equal to the preset is not an override', () => {
  const view = planDialsView(RELIEF, { delta_tol_pct: 0.02 })
  assert.equal(fieldOf(view, 'delta_tol_pct')?.overridden, false)
})

/** A changed field carries what it was changed FROM, or the badge says half of it. */
test('an overridden field carries the preset value it differs from', () => {
  const changed = fieldOf(planDialsView(RELIEF, { delta_tol_pct: 0.03 }), 'delta_tol_pct')
  assert.equal(changed?.value, 0.03)
  assert.equal(changed?.presetValue, 0.02)
})

test('a section toggled OFF renders its numerics inert — shown, stored, not read', () => {
  const view = planDialsView(RELIEF, { shift_enabled: false })
  const shift = sectionOf(view, 'shift')
  assert.equal(shift?.toggle?.value, false)
  // The switch itself is never inert: it is the control that turns the rest on.
  assert.equal(shift?.toggle?.inert, false)
  for (const f of shift?.fields ?? []) {
    assert.equal(f.inert, true, `${f.key} should be inert while shift_enabled is false`)
  }
  // And nothing outside the section is dimmed by it.
  assert.equal(fieldOf(view, 'delta_tol_pct')?.inert, false)
})

test('the same section toggled ON reads its numerics live', () => {
  const view = planDialsView(RELIEF, {})
  for (const f of sectionOf(view, 'shift')?.fields ?? []) {
    assert.equal(f.inert, false)
  }
})

/**
 * A SECTION WITH A NUMERIC OFF-STATE HAS NO SWITCH — `recycle_frac: 0` is the
 * off, and a boolean invented for the panel would be a second spelling of it.
 */
test('recycle has no toggle and never goes inert', () => {
  const view = planDialsView(RELIEF, { recycle_frac: 0 })
  const recycle = sectionOf(view, 'recycle')
  assert.equal(recycle?.toggle, null)
  for (const f of recycle?.fields ?? []) assert.equal(f.inert, false)
})

// ------------------------------------------------------------------ F-29

test('a dial the schema does not know is an ERROR ROW, never dropped', () => {
  const view = planDialsView(RELIEF, { cooldown_min: 5 })
  assert.deepEqual(
    view.unknown.map((u) => u.key),
    ['cooldown_min'],
  )
  assert.match(view.unknown[0]?.reason ?? '', /not a dial/i)
  assert.equal(view.unknown[0]?.value, 5)
  // It is absent from every section — it belongs to none — which is precisely
  // why it would vanish without a row of its own.
  assert.equal(fieldOf(view, 'cooldown_min'), null)
})

test('a dial of the wrong type is an error row too, and the row keeps the preset value', () => {
  const view = planDialsView(RELIEF, { shift_enabled: 1 as unknown as boolean })
  assert.deepEqual(
    view.unknown.map((u) => u.key),
    ['shift_enabled'],
  )
  assert.match(view.unknown[0]?.reason ?? '', /boolean/)
  // Refused, so the preset's own value is what the panel shows and what the
  // engine will read — never the coerced 1.
  assert.equal(sectionOf(view, 'shift')?.toggle?.value, true)
})

test('the error rows keep the document order the operator wrote them in', () => {
  const view = planDialsView(RELIEF, { zzz_typo: 1, delta_tol_pct: 0.03, aaa_typo: 2 })
  assert.deepEqual(
    view.unknown.map((u) => u.key),
    ['zzz_typo', 'aaa_typo'],
  )
})

// ---------------------------------------------------------------- presets

test('an unknown preset falls back to the engine defaults AND says so', () => {
  const view = planDialsView('pairshift-something', { delta_tol_pct: 0.05 })
  assert.equal(view.presetKnown, false)
  // No preset to compare against, so "overridden" is measured against the
  // engine's own defaults rather than being suppressed.
  assert.equal(fieldOf(view, 'delta_tol_pct')?.overridden, true)
  assert.equal(fieldOf(view, 'shift_margin_frac')?.value, DEFAULT_DIALS.shift_margin_frac)
})

test('presetDials hands the create flow the WHOLE prefill, not a reference to it', () => {
  const dials = presetDials('recenter-r')
  assert.notEqual(dials, null)
  // recenter never shifted; the prefill has to say so out loud, or the row
  // inherits relief's margin-gated shift from the engine default.
  assert.equal(dials?.['shift_enabled'], false)
  const source = PRESETS.find((p) => p.key === 'recenter-r')
  assert.notEqual(dials, source?.dials)
  assert.equal(presetDials('nope-r'), null)
})

// ------------------------------------------------------------------ save

test('a Save sends only what changed — the endpoint is a merge, not a replace', () => {
  const stored = { delta_tol_pct: 0.02, target_pnl: 250000 }
  const draft = { delta_tol_pct: 0.03, target_pnl: 250000, shift_enabled: false }
  assert.deepEqual(dialsPatch(stored, draft), { delta_tol_pct: 0.03, shift_enabled: false })
})

test('an untouched draft sends nothing at all', () => {
  const stored = { delta_tol_pct: 0.02 }
  assert.deepEqual(dialsPatch(stored, { ...stored }), {})
})

/**
 * A key the operator DELETED cannot be sent as a removal: `patchBookDials`
 * `$set`s per key and nothing there can unset one. The plan therefore never
 * invents a null — the panel says so in words instead.
 */
test('a dial dropped from the draft is not sent as a null', () => {
  const patch = dialsPatch({ delta_tol_pct: 0.02, legacy_knob: 1 }, { delta_tol_pct: 0.02 })
  assert.deepEqual(patch, {})
})
