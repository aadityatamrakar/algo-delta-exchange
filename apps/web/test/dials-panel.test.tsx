/**
 * The dials panel, rendered: sections from the engine schema, a toggle that
 * marks its own numerics inert, the F-29 error row, and a Save that sends the
 * CHANGED KEYS ONLY.
 *
 * The arithmetic behind all four is pinned without a DOM in
 * `dials-plan.test.ts`. What is asserted here is the part only a render can
 * prove: that the operator can see and reach it.
 */
import { expect, test, describe } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DialsPanel } from '../src/dials-panel.tsx'
import { AuthProvider, useReauth } from '../src/auth.tsx'
import type { BookRow, DialValue } from '../src/api.ts'
import { installFetch, type SentRequest } from './http.tsx'
import { DIAL_SECTIONS } from '@algomaker/desk-engine/dials'
import {
  dialMeta, fieldOf, groupFields, planDialsView, readDial, sectionOf,
} from '../src/dials-plan.ts'

const TAG = 'BHEL-2026-08-25-recenter-relief-r'

function bookRow(dials: Record<string, DialValue>, over: Partial<BookRow> = {}): BookRow {
  return {
    tag: TAG,
    symbol: 'BHEL',
    expiry: '2026-08-25',
    mode: 'paper',
    // The `variant` field IS the preset label now (spec §11, read-compatible).
    variant: 'recenter-relief-r',
    dials,
    desired: 'running',
    actual: 'running',
    lastMarkAt: 0,
    lastDecision: '',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

/** The panel as the Books page mounts it — the page owns the password prompt. */
function Harness(props: { row: BookRow }): React.ReactElement {
  const reauth = useReauth()
  return (
    <>
      <DialsPanel row={props.row} reauth={reauth} onClose={() => {}} onSaved={() => {}} />
      {reauth.dialog}
    </>
  )
}

function mount(row: BookRow): SentRequest[] {
  const sent = installFetch(() => ({ body: row }))
  render(
    <AuthProvider>
      <Harness row={row} />
    </AuthProvider>,
  )
  return sent
}

describe('the panel renders the engine schema, not a blob', () => {
  test('every section from the engine metadata has a heading', () => {
    mount(bookRow({}))
    for (const label of ['Corridor', 'Shift (phase S)', 'Shed (phase R)', 'Risk', 'Advanced']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  test('a field the row never set is still shown, at the preset value', () => {
    mount(bookRow({}))
    // The whole reason the old JSON box was replaced: you could not retune a
    // dial you did not already know existed.
    const input = screen.getByLabelText('shift_margin_frac') as HTMLInputElement
    expect(input.value).toBe('0.6')
  })

  test('an overridden field says what the preset said', () => {
    mount(bookRow({ delta_tol_pct: 0.03 }))
    expect(screen.getByText(/changed from the preset's 0\.02/)).toBeTruthy()
  })
})

describe('a section toggle', () => {
  test('OFF marks the section numerics inert, and says which switch did it', () => {
    mount(bookRow({ shift_enabled: false }))
    // One per numeric field in the shift section.
    expect(screen.getAllByText(/inert — shift_enabled is off/).length).toBeGreaterThan(0)
  })

  test('ON leaves them live', () => {
    mount(bookRow({}))
    expect(screen.queryByText(/inert — shift_enabled is off/)).toBe(null)
  })

  test('flipping the switch marks them inert without a save', () => {
    mount(bookRow({}))
    fireEvent.click(screen.getByLabelText('shift_enabled'))
    expect(screen.getAllByText(/inert — shift_enabled is off/).length).toBeGreaterThan(0)
  })
})

describe('F-29: what the engine refuses is on screen', () => {
  test('a dial the schema does not know gets a row of its own', () => {
    mount(bookRow({ cooldown_min: 5 }))
    expect(screen.getByText(/cooldown_min = 5/)).toBeTruthy()
    expect(screen.getByText(/not a dial this engine reads/)).toBeTruthy()
  })

  test('a preset the engine does not ship is named, not silently defaulted', () => {
    mount(bookRow({}, { variant: 'pairshift-thing' }))
    expect(screen.getByText(/No preset named 'pairshift-thing'/)).toBeTruthy()
  })
})

describe('save', () => {
  test('nothing changed, nothing to send — the button is dead until it is', () => {
    const sent = mount(bookRow({}))
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(sent.filter((r) => r.method === 'PATCH')).toEqual([])
  })

  test('the PATCH carries ONLY the changed dial, on the row\'s own mode', async () => {
    const sent = mount(bookRow({ delta_tol_pct: 0.02, target_pnl: 250000 }))
    fireEvent.change(screen.getByLabelText('delta_tol_pct'), { target: { value: '0.05' } })
    fireEvent.click(screen.getByRole('button', { name: /Save 1 change/ }))
    await waitFor(() => {
      const patch = sent.find((r) => r.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(patch?.path).toBe(`/v1/desk/books/registry/${TAG}`)
      // `target_pnl` is untouched and must NOT be re-sent: the endpoint is a
      // merge, and pinning every dial onto the row would end its preset.
      expect(patch?.body).toEqual({ mode: 'paper', dials: { delta_tol_pct: 0.05 } })
    })
  })

  test('a toggle flip is a saveable change like any other', async () => {
    const sent = mount(bookRow({}))
    fireEvent.click(screen.getByLabelText('unwind_enabled'))
    fireEvent.click(screen.getByRole('button', { name: /Save 1 change/ }))
    await waitFor(() => {
      const patch = sent.find((r) => r.method === 'PATCH')
      expect(patch?.body).toEqual({ mode: 'paper', dials: { unwind_enabled: true } })
    })
  })

  /**
   * A LIVE BOOK ASKS FIRST. The server gates on `mode === 'live'` and the panel
   * mirrors it exactly; a prompt that appeared on paper too would teach an
   * operator to click through the one that matters.
   */
  test('live asks for the password BEFORE it sends anything', async () => {
    const sent = mount(bookRow({}, { mode: 'live' }))
    fireEvent.change(screen.getByLabelText('delta_tol_pct'), { target: { value: '0.05' } })
    fireEvent.click(screen.getByRole('button', { name: /Save 1 change/ }))
    await screen.findByText(/Retune .* on the LIVE rail/)
    expect(sent.filter((r) => r.method === 'PATCH')).toEqual([])
  })

  test('paper sends straight away, with no prompt', async () => {
    const sent = mount(bookRow({}))
    fireEvent.change(screen.getByLabelText('delta_tol_pct'), { target: { value: '0.05' } })
    fireEvent.click(screen.getByRole('button', { name: /Save 1 change/ }))
    await waitFor(() => expect(sent.some((r) => r.method === 'PATCH')).toBe(true))
    expect(screen.queryByText(/Retune .* on the LIVE rail/)).toBe(null)
  })
})

/**
 * ── THE DELTA-LEAN SECTION ──────────────────────────────────────────────────
 *
 * Forty-eight fields plus a master switch, arriving as one `fields` array of raw
 * names. Three things about it can be wrong in silence, and each has a test
 * here: a GROUPING that loses a dial (strictly worse than the wall it
 * replaced — the wall at least showed the knob), a minutes-since-midnight dial
 * rendering as `900` (a number no operator can check against a spec that says
 * 15:00), and the master switch being off without the panel saying that the
 * forty-eight numbers under it are not being read by anything.
 */
const DELTA_LEAN = DIAL_SECTIONS.find((s) => s.key === 'delta-lean')
if (DELTA_LEAN === undefined) {
  throw new Error('the engine no longer ships a delta-lean section — this suite is out of date')
}

/** A book on the second decide path: the preset that turns it on. */
const leanRow = (dials: Record<string, DialValue> = {}): BookRow =>
  bookRow(dials, { variant: 'delta-lean-aggressive' })

/** The section opens SHUT — nothing inside it is mounted until this runs. */
function openDeltaLean(): void {
  fireEvent.click(screen.getByRole('button', { name: /Delta lean/ }))
}

/**
 * ONE SECTION'S OWN BODY, found through its trigger's `aria-controls`.
 *
 * A count of badges or units over the whole panel is a count over every
 * section it draws open — and BULL-S opens by default, with its own risk
 * badges and clock dials since its dials were described (5 Nov). A section's
 * claim about itself is asserted inside that section.
 */
function sectionBody(name: RegExp): HTMLElement {
  const id = screen.getByRole('button', { name }).getAttribute('aria-controls')
  const el = id === null ? null : document.getElementById(id)
  if (el === null) throw new Error(`no body for the section ${String(name)}`)
  return el
}

/**
 * Every rendered dial's name, in ONE pass over the DOM.
 *
 * Deliberately not forty-eight `getAllByLabelText` calls: each of those walks
 * every label, `aria-label` and `aria-labelledby` in the document, and
 * that many of them cost close to four seconds — most of this file's budget,
 * against a 5s per-test timeout, for an assertion that is one traversal.
 */
/**
 * One dial's input box, found by its own label without `getByLabelText`.
 *
 * Same reason as `renderedDialNames`: with the delta-lean section open the
 * panel carries ~78 labelled inputs, and a single `getByLabelText` against
 * that DOM costs 2.6 SECONDS — half the per-test timeout for one lookup. The
 * shut-section rule in `dials-panel.tsx` is what keeps the rest of the suite
 * away from that; the tests that deliberately open it use this instead.
 */
function dialInput(key: string): HTMLInputElement {
  for (const label of Array.from(document.querySelectorAll('label'))) {
    if ((label.textContent ?? '').trim() !== key) continue
    const id = label.getAttribute('for')
    const found = id === null ? null : document.getElementById(id)
    if (found instanceof HTMLInputElement) return found
  }
  throw new Error(`no dial input is labelled ${key}`)
}

function renderedDialNames(): string[] {
  const out: string[] = []
  for (const input of Array.from(document.querySelectorAll('input'))) {
    const aria = input.getAttribute('aria-label')
    if (aria !== null && aria !== '') {
      out.push(aria)
      continue
    }
    const id = input.getAttribute('id')
    const label = id === null ? null : document.querySelector(`label[for="${CSS.escape(id)}"]`)
    const text = (label?.textContent ?? '').trim()
    if (text !== '') out.push(text)
  }
  return out
}

describe('the delta-lean section is grouped, not a wall', () => {
  test('every dial in the section lands in exactly one group', () => {
    // The assertion that makes the grouping safe to add at all: it is measured
    // against the ENGINE's own field list, so a dial added to `DIAL_SECTIONS`
    // and forgotten in the panel's group table fails here rather than
    // disappearing from the screen.
    const view = planDialsView('delta-lean-aggressive', {})
    const section = sectionOf(view, 'delta-lean')
    expect(section).toBeTruthy()
    const grouped = groupFields('delta-lean', section?.fields ?? []).flatMap((g) =>
      g.fields.map((f) => f.key),
    )
    expect([...grouped].sort()).toEqual([...DELTA_LEAN.fields].sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  test('a dial the group table never heard of is still shown, under its own heading', () => {
    const stray = { key: 'dl_something_new', value: 1, presetValue: 1, overridden: false, inert: false, kind: 'number' } as const
    const groups = groupFields('delta-lean', [stray])
    expect(groups.map((g) => g.label)).toEqual(['Not grouped'])
    expect(groups[0]?.fields.map((f) => f.key)).toEqual(['dl_something_new'])
  })

  test('every other section is still one flat list, with no invented subheadings', () => {
    const view = planDialsView('recenter-relief-r', {})
    const corridor = sectionOf(view, 'corridor')
    const groups = groupFields('corridor', corridor?.fields ?? [])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBe(null)
  })

  test('opened, it shows the seven group headings and all 48 dials, each once', () => {
    mount(leanRow())
    openDeltaLean()
    for (const heading of [
      'Budget and the four exits',
      'The open',
      'Adjustment gating',
      'Regime detector',
      'Sizing and strike selection',
      'Liquidity and staleness',
      'Clock and pacing',
    ]) {
      expect(screen.getByText(heading)).toBeTruthy()
    }
    // Presence AND exactly-once, in one traversal: a grouping that rendered a
    // dial twice is as wrong as one that dropped it.
    const rendered = renderedDialNames().filter((n) => n.startsWith('dl_'))
    expect([...rendered].sort()).toEqual([...DELTA_LEAN.fields].sort())
    expect(renderedDialNames().filter((n) => n === 'delta_lean_enabled')).toHaveLength(1)
  })

  test('shut, it says how many dials are behind the chevron', () => {
    mount(leanRow())
    expect(screen.getByText('48 dials')).toBeTruthy()
  })
})

describe('a dial reads in its own units', () => {
  test('minutes since midnight render as a clock time', () => {
    expect(readDial('dl_warmup_min', 570)).toBe('09:30')
    expect(readDial('dl_flat_by_min', 900)).toBe('15:00')
    mount(leanRow())
    openDeltaLean()
    // The number stays typeable in the box; the clock time is the line under
    // it. An operator checking 900 against a spec that says 15:00 could not do
    // it from the box alone.
    expect(dialInput('dl_flat_by_min').value).toBe('900')
    expect(screen.getByText(/= 15:00/)).toBeTruthy()
    expect(screen.getByText(/= 09:30/)).toBeTruthy()
  })

  test('a minute-of-day that is not a time of day says so rather than showing 25:00', () => {
    expect(readDial('dl_flat_by_min', 1500)).toMatch(/NOT a time of day/)
    expect(readDial('dl_flat_by_min', 570.5)).toMatch(/NOT a time of day/)
    mount(leanRow({ dl_flat_by_min: 1500 }))
    openDeltaLean()
    expect(screen.getByText(/NOT a time of day/)).toBeTruthy()
  })

  test('renders a dial in the units the spec states it in', () => {
    expect(readDial('dl_day_max_loss', 30000)).toBe('₹30,000')
    expect(readDial('dl_day_target', 10000)).toBe('₹10,000')
    expect(readDial('dl_stuck_loss', 25000)).toBe('₹25,000')
    expect(readDial('dl_adjust_cooldown_s', 600)).toBe('10 min')
    expect(readDial('dl_adjust_confirm_s', 60)).toBe('1 min')
    expect(readDial('dl_flat_by_min', 900)).toBe('15:00')
    expect(readDial('dl_warmup_min', 570)).toBe('09:30')
    expect(readDial('margin_cap', 2500000)).toBe('₹25,00,000')
    // A plain count reads as itself and gets no second line.
    expect(readDial('dl_open_lots', 4)).toBeNull()
    expect(readDial('dl_max_adjusts_day', 6)).toBeNull()
    // A dial with no entry in the table reads as the plain number it is.
    expect(readDial('delta_tol_pct', 0.02)).toBe(null)
  })

  test('groups every delta-lean dial — none lands in "Not grouped"', () => {
    // A grouping that silently drops a dial is strictly worse than the wall it
    // replaced, because the wall at least showed the knob. The trailing group
    // is the safety net; this asserts the net is empty. `groupFields` is the
    // real (exported) grouping function `DELTA_LEAN_GROUPS` feeds — there is
    // no bare `deltaLeanGroups()` helper, so this uses the same entry point
    // `dials-plan.test.ts` and the test above it already exercise.
    const view = planDialsView('delta-lean-aggressive', {})
    const section = sectionOf(view, 'delta-lean')
    expect(section).toBeTruthy()
    const groups = groupFields('delta-lean', section?.fields ?? [])
    expect(groups.map((g) => g.label)).not.toContain('Not grouped')
    const grouped = new Set(groups.flatMap((g) => g.fields.map((f) => f.key)))
    for (const key of DELTA_LEAN.fields) expect(grouped.has(key)).toBe(true)
  })

  test('the preset value a changed dial is compared against reads in units too', () => {
    mount(leanRow({ dl_flat_by_min: 895 }))
    openDeltaLean()
    expect(screen.getByText(/changed from the preset's 900 \(15:00\)/)).toBeTruthy()
  })

  test('the units sit beside the box, so the number is never bare', () => {
    mount(leanRow())
    openDeltaLean()
    // dl_open_by_min, dl_warmup_min, dl_flatten_passive_min, dl_flatten_urgent_min,
    // dl_flat_by_min.
    const lean = within(sectionBody(/Delta lean/))
    expect(lean.getAllByText('min of day').length).toBe(5)
    expect(lean.getAllByText('Δ').length).toBeGreaterThan(0)
  })
})

describe('dl_parity_forward, the Lifecycle dial added with the playbooks', () => {
  test('sits in "Clock and pacing" beside dl_hold_to_expiry, with a help line of its own', () => {
    const view = planDialsView('delta-lean-aggressive', {})
    const section = sectionOf(view, 'delta-lean')
    const clock = groupFields('delta-lean', section?.fields ?? []).find(
      (g) => g.label === 'Clock and pacing',
    )
    expect(clock?.fields.map((f) => f.key).slice(-2)).toEqual(['dl_hold_to_expiry', 'dl_parity_forward'])
    expect(dialMeta('dl_parity_forward').kind).toBe('plain')
    expect(dialMeta('dl_parity_forward').help).toMatch(/own expiry's forward/)
  })

  test('is a switch: on in a delta-lean preset, off on a recenter book', () => {
    expect(fieldOf(planDialsView('delta-lean-aggressive', {}), 'dl_parity_forward')).toMatchObject({
      value: true, overridden: false, kind: 'boolean',
    })
    expect(fieldOf(planDialsView('recenter-relief-r', {}), 'dl_parity_forward')).toMatchObject({
      value: false, overridden: false, kind: 'boolean',
    })
  })
})

describe('dl_rupee_hold_s, the hold book`s hold on its backstop and target', () => {
  test('sits last in "Budget and the four exits", in seconds, and says it is read on hold books only', () => {
    const view = planDialsView('delta-lean-hold-conservative', {})
    const budget = groupFields('delta-lean', sectionOf(view, 'delta-lean')?.fields ?? []).find(
      (g) => g.label === 'Budget and the four exits',
    )
    expect(budget?.fields.map((f) => f.key).at(-1)).toBe('dl_rupee_hold_s')
    expect(dialMeta('dl_rupee_hold_s').kind).toBe('seconds')
    expect(dialMeta('dl_rupee_hold_s').risk).toBe(false)
    expect(dialMeta('dl_rupee_hold_s').help).toMatch(/^HOLD BOOKS ONLY/)
    expect(fieldOf(view, 'dl_rupee_hold_s')).toMatchObject({ value: 60, overridden: false, kind: 'number' })
  })
})

describe('in Delta lean, the two dials that decide what the book can lose', () => {
  test('are badged as risk limits, and nothing else is', () => {
    mount(leanRow())
    openDeltaLean()
    expect(within(sectionBody(/Delta lean/)).getAllByText('risk limit')).toHaveLength(2)
  })
})

describe('the master switch, off', () => {
  test('says once that the engine reads none of the 48, and names the path it is on', () => {
    // A recenter book: `delta_lean_enabled` is false, so the whole section is
    // stored settings that nothing reads.
    mount(bookRow({}))
    openDeltaLean()
    expect(screen.getByText(/delta_lean_enabled is off — nothing below is live/)).toBeTruthy()
    expect(screen.getByText(/reads none of the 48 dials below/)).toBeTruthy()
    expect(screen.getByText(/recenter decide path/)).toBeTruthy()
  })

  test('marks every one of the 48 inert, and the panel says which switch did it', () => {
    mount(bookRow({}))
    openDeltaLean()
    expect(screen.getAllByText(/inert — delta_lean_enabled is off/)).toHaveLength(48)
  })

  test('a book on the delta-lean preset has none of that — the dials are live', () => {
    mount(leanRow())
    openDeltaLean()
    expect(screen.queryByText(/inert — delta_lean_enabled is off/)).toBe(null)
    // The banner belongs to whichever switch is off — `trend_enabled` is, on
    // this preset — so the assertion is about THIS section's switch, not about
    // the panel being free of the line.
    expect(screen.queryByText(/delta_lean_enabled is off — nothing below is live/)).toBe(null)
  })

  test('the shut header names the switch that is off, not merely that one is', () => {
    mount(bookRow({}))
    expect(screen.getByText('delta_lean_enabled off')).toBeTruthy()
  })
})

/**
 * ── THE PLAYBOOK SECTION ────────────────────────────────────────────────────
 *
 * Fifty-one dials and NO master switch: `pb_playbook` 0 is the off-state, so it
 * is the section's first field rather than a toggle. What can be wrong in
 * silence has a test here, as it does for Delta lean: a group table that loses
 * a dial or draws the section in an order the engine does not use, a
 * minute-of-day dial read as a bare number, a "0 = off" read as midnight, a
 * percent read as a fraction, and a risk dial that does not wear its badge.
 */
const PLAYBOOK = DIAL_SECTIONS.find((s) => s.key === 'playbook')
if (PLAYBOOK === undefined) {
  throw new Error('the engine no longer ships a playbook section — this suite is out of date')
}

/** The groups the section is drawn in, top to bottom. */
const PLAYBOOK_GROUP_LABELS = [
  'Selection',
  'Sizing and window',
  'Common exits',
  'Debit spreads',
  'Short premium',
  'Staging',
  'Reversal',
  'Gamma',
]

/** A playbook book, on the preset a roll registers it under. */
const playbookRow = (dials: Record<string, DialValue> = {}): BookRow =>
  bookRow(dials, { variant: 'pb-trend-drive' })

/** The section opens SHUT — nothing inside it is mounted until this runs. */
function openPlaybook(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Playbook/ }))
}

describe('the playbook section is grouped, not a wall', () => {
  test('the engine ships it right after Delta lean, shut, with no master switch', () => {
    const keys = DIAL_SECTIONS.map((s) => s.key)
    expect(keys.indexOf('playbook')).toBe(keys.indexOf('delta-lean') + 1)
    expect(PLAYBOOK.collapsed).toBe(true)
    expect(PLAYBOOK.toggle).toBeUndefined()
    expect(PLAYBOOK.fields).toHaveLength(53)
    expect(sectionOf(planDialsView('pb-trend-drive', {}), 'playbook')?.toggle).toBeNull()
  })

  test('the groups come out in the engine\'s own order, every dial once, none "Not grouped"', () => {
    const section = sectionOf(planDialsView('pb-trend-drive', {}), 'playbook')
    expect(section).toBeTruthy()
    const groups = groupFields('playbook', section?.fields ?? [])
    expect(groups.map((g) => g.label)).toEqual(PLAYBOOK_GROUP_LABELS)
    expect(groups.map((g) => g.label)).not.toContain('Not grouped')
    // ORDER, not only membership: the table is "exactly as dials.ts orders
    // it", so read top to bottom the groups give the engine's list back. A
    // dial added over there and forgotten here fails this (it lands under
    // "Not grouped", at the foot) rather than vanishing from the screen.
    expect(groups.flatMap((g) => g.fields.map((f) => f.key))).toEqual([...PLAYBOOK.fields])
    for (const g of groups) expect((g.note ?? '').length).toBeGreaterThan(0)
  })

  test('a dial the playbook group table never heard of is still shown, under its own heading', () => {
    const stray = { key: 'pb_something_new', value: 1, presetValue: 1, overridden: false, inert: false, kind: 'number' } as const
    const groups = groupFields('playbook', [stray])
    expect(groups.map((g) => g.label)).toEqual(['Not grouped'])
    expect(groups[0]?.fields.map((f) => f.key)).toEqual(['pb_something_new'])
  })

  test('a dial is grouped by its OWN section: neither table finds the other\'s dials', () => {
    const field = (key: string) =>
      ({ key, value: 1, presetValue: 1, overridden: false, inert: false, kind: 'number' }) as const
    expect(groupFields('playbook', [field('dl_day_max_loss')]).map((g) => g.label)).toEqual(['Not grouped'])
    expect(groupFields('delta-lean', [field('pb_lots')]).map((g) => g.label)).toEqual(['Not grouped'])
  })

  test('shut, it says how many dials are behind the chevron, and mounts none of them', () => {
    mount(playbookRow())
    expect(screen.getByText('Playbook')).toBeTruthy()
    expect(screen.getByText('53 dials')).toBeTruthy()
    expect(renderedDialNames().filter((n) => n.startsWith('pb_'))).toEqual([])
  })

  test('opened, it shows the eight group headings and all 53 dials, once each, in the engine\'s order', () => {
    mount(playbookRow())
    openPlaybook()
    for (const heading of PLAYBOOK_GROUP_LABELS) expect(screen.getByText(heading)).toBeTruthy()
    expect(screen.queryByText('Not grouped')).toBe(null)
    // One traversal, in DOCUMENT order: presence, exactly-once and the order
    // the panel draws them in, in a single assertion.
    expect(renderedDialNames().filter((n) => n.startsWith('pb_'))).toEqual([...PLAYBOOK.fields])
  })

  test('the preset\'s own values are what the boxes show', () => {
    expect(fieldOf(planDialsView('pb-trend-drive', {}), 'pb_expiry_day_only')).toMatchObject({
      kind: 'boolean', value: false, overridden: false,
    })
    expect(fieldOf(planDialsView('pb-expiry-drive', {}), 'pb_expiry_day_only')).toMatchObject({
      kind: 'boolean', value: true, overridden: false,
    })
    mount(playbookRow())
    openPlaybook()
    expect(dialInput('pb_playbook').value).toBe('1')
    expect(dialInput('pb_trade_max_loss').value).toBe('6000')
  })
})

describe('a playbook dial reads in its own units', () => {
  test('only the four minute-of-day dials are clock times; the look-backs are plain minutes', () => {
    const clocks = PLAYBOOK.fields.filter((k) => dialMeta(k).kind === 'clock')
    expect([...clocks]).toEqual([
      'pb_entry_start_min', 'pb_entry_end_min', 'pb_late_min', 'pb_time_exit_min',
    ])
    for (const key of ['pb_calm_min', 'pb_box_min', 'pb_max_gap_min']) {
      expect(dialMeta(key).kind).toBe('count')
      expect(dialMeta(key).units).toBe('min')
    }
    expect(readDial('pb_entry_start_min', 570)).toBe('09:30')
    expect(readDial('pb_entry_end_min', 615)).toBe('10:15')
    expect(readDial('pb_late_min', 780)).toBe('13:00')
    expect(readDial('pb_time_exit_min', 720)).toBe('12:00')
    // A look-back of 30 minutes is not 00:30.
    expect(readDial('pb_calm_min', 30)).toBeNull()
    expect(readDial('pb_late_min', 1500)).toMatch(/NOT a time of day/)
  })

  test('rupees, seconds and fractions read in the spec\'s terms', () => {
    expect(readDial('pb_trade_max_loss', 6000)).toBe('₹6,000')
    expect(readDial('pb_trade_target', 12000)).toBe('₹12,000')
    expect(readDial('pb_premium_budget', 6000)).toBe('₹6,000')
    expect(readDial('pb_reentry_cooldown_s', 1200)).toBe('20 min')
    expect(readDial('pb_confirm_s', 120)).toBe('2 min')
    expect(readDial('pb_rupee_hold_s', 3)).toBeNull()
    expect(readDial('pb_trail_keep', 0.6)).toBe('60%')
    expect(readDial('pb_rev_retrace', 0.35)).toBe('35%')
    expect(readDial('pb_prem_trail_arm', 0.8)).toBe('80%')
    expect(readDial('pb_combined_stop', 0.25)).toBe('25%')
    // Counts, multiples and strikes read as the plain number they are.
    expect(readDial('pb_lots', 2)).toBeNull()
    expect(readDial('pb_wing_str_k', 1.25)).toBeNull()
    expect(readDial('pb_wing_min_steps', 2)).toBeNull()
  })

  test('a percent is NOT a fraction: 0.25 is a quarter of one percent', () => {
    // `fraction` would print 0.25 as 25% — a gap gate a hundred times too wide.
    for (const key of ['pb_gap_min_pct', 'pb_gap_max_pct']) {
      expect(dialMeta(key).kind).toBe('plain')
      expect(dialMeta(key).units).toBe('%')
    }
    expect(readDial('pb_gap_min_pct', 0.25)).toBeNull()
    expect(readDial('pb_gap_max_pct', 0.6)).toBeNull()
  })

  test('a zero that means "off" reads "off", not midnight, ₹0 or 0%', () => {
    expect(readDial('pb_time_exit_min', 0)).toBe('off')
    expect(readDial('pb_trade_target', 0)).toBe('off')
    expect(readDial('pb_trail_start', 0)).toBe('off')
    expect(readDial('pb_late_trail_start', 0)).toBe('off')
    expect(readDial('pb_flip_confirm_s', 0)).toBe('off')
    expect(readDial('pb_debit_stop_frac', 0)).toBe('off')
    expect(readDial('pb_max_adds', 0)).toBe('off')
    expect(readDial('pb_gap_min_pct', 0)).toBe('off')
    // The zero spec's two (2026-10-17): no open window, and no day target.
    expect(readDial('dl_open_by_min', 0)).toBe('off')
    expect(readDial('dl_open_by_min', 571)).toBe('09:31')
    expect(readDial('dl_day_target', 0)).toBe('off')
    expect(readDial('dl_day_target', 10_000)).toBe('₹10,000')
    // …and only the dials the spec says "0 = off" for: a zero elsewhere is a
    // number, so a typo there is not dressed up as a switched-off feature.
    expect(readDial('dl_warmup_min', 0)).toBe('00:00')
    expect(readDial('pb_entry_start_min', 0)).toBe('00:00')
    expect(readDial('pb_lots', 0)).toBeNull()
  })

  test('opened, the clock times and the "off" are on screen, beside the unit', () => {
    mount(playbookRow())
    openPlaybook()
    // The number stays typeable in the box; the clock time is the line under it.
    expect(dialInput('pb_entry_start_min').value).toBe('570')
    const pb = within(sectionBody(/^Playbook/))
    expect(pb.getByText(/= 09:30/)).toBeTruthy()
    expect(pb.getByText(/= 10:15/)).toBeTruthy()
    expect(pb.getByText(/= 13:00/)).toBeTruthy()
    // `pb_time_exit_min` is 0 on this preset: no time exit — not a 00:00 one.
    expect(dialInput('pb_time_exit_min').value).toBe('0')
    expect(pb.queryByText(/= 00:00/)).toBe(null)
    expect(pb.getAllByText('min of day')).toHaveLength(4)
    expect(pb.getAllByText('%')).toHaveLength(2)
  })
})

describe('in Playbook, the dials that decide what a trade can lose', () => {
  test('are exactly pb_lots, pb_trade_max_loss and pb_premium_budget', () => {
    expect(PLAYBOOK.fields.filter((k) => dialMeta(k).risk)).toEqual([
      'pb_lots', 'pb_trade_max_loss', 'pb_premium_budget',
    ])
  })

  test('opened, the section badges those three and nothing else', () => {
    mount(playbookRow())
    openPlaybook()
    expect(within(sectionBody(/^Playbook/)).getAllByText('risk limit')).toHaveLength(3)
  })
})

describe('every playbook dial says what it is', () => {
  test('each carries a help line, and "plain" is only the selectors, the switch and the percents', () => {
    for (const key of PLAYBOOK.fields) {
      const help = dialMeta(key).help
      expect(help, `${key} has no help line`).not.toBeNull()
      expect((help ?? '').length, `${key}'s help is too short to say anything`).toBeGreaterThan(30)
    }
    expect(PLAYBOOK.fields.filter((k) => dialMeta(k).kind === 'plain')).toEqual([
      'pb_playbook', 'pb_expiry_day_only', 'pb_gap_min_pct', 'pb_gap_max_pct', 'pb_strike_mode',
    ])
  })
})

describe('a playbook dial edits and saves like any other', () => {
  test('the PATCH carries only the changed key, and the section header counts it', async () => {
    const sent = mount(playbookRow())
    openPlaybook()
    fireEvent.change(dialInput('pb_lots'), { target: { value: '3' } })
    expect(screen.getByText('1 changed')).toBeTruthy()
    expect(screen.getByText(/changed from the preset's 2/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Save 1 change/))
    await waitFor(() => {
      const patch = sent.find((r) => r.method === 'PATCH')
      expect(patch?.path).toBe(`/v1/desk/books/registry/${TAG}`)
      expect(patch?.body).toEqual({ mode: 'paper', dials: { pb_lots: 3 } })
    })
  })
})
