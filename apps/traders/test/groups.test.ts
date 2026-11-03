import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_GROUPS, groupTotals, validateGroups } from '../src/books/groups.ts'
import type { LegView } from '../src/types.ts'

const KEYS = new Set(['k1', 'k2', 'k3'])
const bad = (raw: unknown): string => {
  const r = validateGroups(raw, KEYS)
  assert.equal(r.ok, false)
  return r.ok ? '' : r.error
}

test('a valid body', () => {
  const r = validateGroups([{ name: '  Oct straddle ', keys: ['k1', 'k2'] }, { name: 'hedge', keys: ['k3'] }], KEYS)
  assert.deepEqual(r, { ok: true, groups: [{ name: 'Oct straddle', keys: ['k1', 'k2'] }, { name: 'hedge', keys: ['k3'] }] })
  assert.deepEqual(validateGroups([], KEYS), { ok: true, groups: [] })
})

test('refusals say why', () => {
  assert.equal(bad([{ name: 'a', keys: ['k1'] }, { name: 'b', keys: ['k1'] }]), 'leg k1 is in two groups')
  assert.equal(bad([{ name: 'a', keys: ['k1', 'kX'] }]), 'unknown leg keys: kX')
  assert.equal(bad([{ name: 'hedge', keys: [] }, { name: 'Hedge', keys: [] }]), 'two groups are named "Hedge"')
  assert.equal(bad([{ name: 'Ungrouped', keys: [] }]), '"ungrouped" is reserved')
  assert.equal(bad([{ name: '  ', keys: [] }]), 'a group needs a name')
  assert.equal(bad([{ keys: [] }]), 'a group needs a name')
  assert.equal(bad([{ name: 'x'.repeat(41), keys: [] }]), 'a group name is at most 40 characters')
  assert.equal(bad(Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({ name: `g${i}`, keys: [] }))), 'at most 20 groups')
  assert.equal(bad({ name: 'a' }), 'groups must be an array')
  assert.match(bad([{ name: 'a', keys: 'k1' }]), /array of leg keys/)
})

const leg = (o: Partial<LegView>): LegView => ({
  key: 'k', source: 'manual', clientCode: '', note: '', lotSize: 1, instrument: 'option', expiry: '2026-10-27', strike: 1, optType: 'CE',
  qty: 1, avgPrice: 1, ltp: 1, iv: 0.2, delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0, matched: true, ...o,
})

test('groupTotals sums position greeks and MTM', () => {
  const t = groupTotals([leg({ delta: 100, gamma: -2, vega: 5, theta: -1, mtm: 500 }), leg({ delta: -40, gamma: 1, vega: 2, theta: 3, mtm: null })])
  assert.deepEqual(t, { delta: 60, gamma: -1, vega: 7, theta: 2, mtm: 500 })
  assert.deepEqual(groupTotals([]), { delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0 })
})
