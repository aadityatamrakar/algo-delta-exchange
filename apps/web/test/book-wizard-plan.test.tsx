/**
 * The New-book wizard's arithmetic, DOM-free: which presets it offers, which
 * expiries it lists, how the dials are grouped and described, what the create
 * writes, and what stops a create.
 *
 * `.test.tsx` only because that is all this directory's runner collects.
 */
import { describe, expect, test } from 'vitest'
import {
  BS_TITLES, WIZARD_HIDDEN, liveExpiries, pickExpiry, wizardChanges, wizardDials,
  wizardGroups, wizardPresets, wizardProblems, wizardTag,
} from '../src/book-wizard-plan.ts'
import { dialMeta, presetDials } from '../src/dials-plan.ts'
import { DIAL_SECTIONS } from '@algomaker/desk-engine/dials'

/** 5 Nov 2026, 08:00 UTC: the 4 Nov expiry settled yesterday at 12:00 UTC; the 5 Nov one settles at noon today. */
const NOW = Date.parse('2026-11-05T08:00:00Z')
const LISTED = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-13', '2026-11-27', '2026-12-25']

describe('presets', () => {
  test('every BULL-S and LION-S preset, with its strategy, expiry class and grid jump', () => {
    const p = wizardPresets()
    expect(p.map((x) => x.key)).toEqual([
      'bull-s-btc-daily', 'bull-s-btc-daily-2', 'bull-s-btc-weekly', 'bull-s-btc-weekly-2',
      'bull-s-btc-monthly', 'bull-s-btc-monthly-2',
      'lion-s-btc-daily', 'lion-s-btc-weekly', 'lion-s-btc-monthly',
    ])
    expect(p[0]).toMatchObject({ strategy: 'bull-s', expiryClass: 'daily', jump: 1, grid: 200, start: 50, step: 50, cap: 150, lossCap: 250 })
    expect(p[3]).toMatchObject({ strategy: 'bull-s', expiryClass: 'weekly', jump: 2, grid: 1000 })
    // LION-S: per leg, flat — no step, the cap is the size.
    expect(p[6]).toMatchObject({ strategy: 'lion-s', expiryClass: 'daily', grid: 200, start: 50, step: 0, cap: 50, lossCap: 250 })
    expect(p[7]).toMatchObject({ strategy: 'lion-s', expiryClass: 'weekly', grid: 500 })
  })
})

describe('expiries', () => {
  test('a settled expiry is not offered — the master still lists 4 Nov the day after', () => {
    expect(liveExpiries(LISTED, NOW)).toEqual(LISTED.slice(1))
    // 5 Nov is still live until noon UTC, and gone after it.
    expect(liveExpiries(LISTED, Date.parse('2026-11-05T12:00:01Z'))[0]).toBe('2026-11-06')
  })

  test('the preset picks the nearest expiry of its own class', () => {
    const live = liveExpiries(LISTED, NOW)
    expect(pickExpiry(live, 'daily')).toBe('2026-11-05')
    // 6 Nov is a Friday: weekly.
    expect(pickExpiry(live, 'weekly')).toBe('2026-11-06')
    // The last Friday of November.
    expect(pickExpiry(live, 'monthly')).toBe('2026-11-27')
    expect(pickExpiry([], 'daily')).toBe('')
  })

  test('the tag is symbol-expiry-preset, then the suffix', () => {
    expect(wizardTag('BTC', '2026-11-06', 'bull-s-btc-daily', '')).toBe('BTC-2026-11-06-bull-s-btc-daily')
    expect(wizardTag('BTC', '2026-11-06', 'bull-s-btc-daily', ' 2 ')).toBe('BTC-2026-11-06-bull-s-btc-daily-2')
  })
})

describe('dials', () => {
  test('every BULL-S dial the operator sets is shown once, titled and described', () => {
    const groups = wizardGroups('bull-s-btc-daily', {})
    const keys = groups.flatMap((g) => g.fields.map((f) => f.key))
    const section = DIAL_SECTIONS.find((s) => s.key === 'bull-s')
    const expected = (section?.fields ?? []).filter((k) => !WIZARD_HIDDEN.has(k))
    expect([...keys].sort()).toEqual([...expected].sort())
    for (const k of keys) {
      expect(BS_TITLES[k], `title for ${k}`).toBeTruthy()
      expect(dialMeta(k).help, `description for ${k}`).toBeTruthy()
    }
    // No "Not grouped" bucket: the grouping covers the section.
    expect(groups.some((g) => g.key === 'ungrouped')).toBe(false)
    // The feed-safety group starts folded away.
    expect(groups.find((g) => g.key === 'bs-safety')?.advanced).toBe(true)
  })

  test('starts at the preset; a change is marked against it', () => {
    const before = wizardGroups('bull-s-btc-daily', {}).flatMap((g) => g.fields)
    expect(before.find((f) => f.key === 'bs_loss_cap')).toMatchObject({ value: 250, overridden: false })
    const after = wizardGroups('bull-s-btc-daily', { bs_loss_cap: 100 }).flatMap((g) => g.fields)
    expect(after.find((f) => f.key === 'bs_loss_cap')).toMatchObject({ value: 100, presetValue: 250, overridden: true })
  })

  test('the create writes the preset, then only what was changed', () => {
    const dials = wizardDials('bull-s-btc-daily', { bs_loss_cap: 100, bs_lots_start: 50 })
    expect(dials).toEqual({ ...presetDials('bull-s-btc-daily'), bs_loss_cap: 100 })
    expect(wizardChanges('bull-s-btc-daily', { bs_loss_cap: 100, bs_lots_start: 50 })).toEqual([
      { key: 'bs_loss_cap', title: BS_TITLES['bs_loss_cap'], from: 250, to: 100 },
    ])
  })
})

describe('what stops a create', () => {
  const base = { preset: 'bull-s-btc-daily', expiry: '2026-11-06', tag: 'BTC-2026-11-06-bull-s-btc-daily', taken: [] }

  test('a paper book on the preset as it stands is fine', () => {
    expect(wizardProblems({ ...base, overrides: {}, mode: 'paper' })).toEqual([])
  })

  test('a live book needs a margin budget — the server refuses to arm one without', () => {
    const p = wizardProblems({ ...base, overrides: {}, mode: 'live' })
    expect(p).toHaveLength(1)
    expect(p[0]).toMatch(/margin budget/)
    expect(wizardProblems({ ...base, overrides: { bs_margin_budget: 500 }, mode: 'live' })).toEqual([])
  })

  test('a taken tag, no expiry, a size past its cap, a stop at or under 1×', () => {
    const p = wizardProblems({
      ...base, expiry: '', taken: [base.tag], mode: 'paper',
      overrides: { bs_lots_start: 200, bs_stop_mult: 1 },
    }).join(' | ')
    expect(p).toMatch(/Choose an expiry/)
    expect(p).toMatch(/already exists/)
    expect(p).toMatch(/bigger than the size cap/)
    expect(p).toMatch(/stop multiple/)
  })

  test('no uncapped pyramid, and sizes are whole contracts', () => {
    expect(wizardProblems({ ...base, mode: 'paper', overrides: { bs_lots_cap: 0 } }).join()).toMatch(/size cap/)
    expect(wizardProblems({ ...base, mode: 'paper', overrides: { bs_lots_step: 2.5 } }).join()).toMatch(/whole number/)
  })
})
