/**
 * THE ILLIQUID IV RULE — own vol if measured, else the other side, else the
 * nearest measured strike. Never interpolated.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { liquidIv } from '../src/illiquid.ts'
import type { SolvedIv } from '../src/ivs.ts'

const S: SolvedIv[] = [
  { strike: 100, type: 'CE', iv: 0.30, source: 'quote' }, { strike: 100, type: 'PE', iv: 0.32, source: 'quote' },
  { strike: 105, type: 'CE', iv: null, source: 'none' },  { strike: 105, type: 'PE', iv: 0.34, source: 'quote' },
  { strike: 110, type: 'CE', iv: 0.28, source: 'quote' },
]

test('a liquid leg keeps its own vol', () =>
  assert.deepEqual(liquidIv(S, 100, 'CE', false), { iv: 0.30, source: 'quote', from: null }))
test('ticked illiquid takes the other side at the same strike', () =>
  assert.deepEqual(liquidIv(S, 100, 'CE', true), { iv: 0.32, source: 'other-side', from: { strike: 100, type: 'PE' } }))
test('an unsolved own row is illiquid without a tick', () =>
  assert.deepEqual(liquidIv(S, 105, 'CE', false), { iv: 0.34, source: 'other-side', from: { strike: 105, type: 'PE' } }))
test('no other side: the nearest liquid strike, either side', () =>
  assert.deepEqual(liquidIv(S, 110, 'CE', true), { iv: 0.34, source: 'nearest', from: { strike: 105, type: 'PE' } }))
test('a tie on distance goes to the same side', () =>
  assert.deepEqual(liquidIv(S, 102, 'PE', false), { iv: 0.32, source: 'nearest', from: { strike: 100, type: 'PE' } }))
test('nothing measured anywhere is none', () =>
  assert.deepEqual(liquidIv([], 100, 'CE', true), { iv: null, source: 'none', from: null }))
test('an interpolated row is not measured', () => {
  const rows: SolvedIv[] = [
    { strike: 100, type: 'CE', iv: 0.30, source: 'interp' },
    { strike: 100, type: 'PE', iv: 0.31, source: 'interp' },
    { strike: 120, type: 'CE', iv: 0.25, source: 'quote' },
  ]
  assert.deepEqual(liquidIv(rows, 100, 'CE', false), { iv: 0.25, source: 'nearest', from: { strike: 120, type: 'CE' } })
})
test('equal distance and side: the lower strike wins', () => {
  const rows: SolvedIv[] = [
    { strike: 90, type: 'CE', iv: 0.4, source: 'quote' },
    { strike: 110, type: 'CE', iv: 0.2, source: 'quote' },
  ]
  assert.deepEqual(liquidIv(rows, 100, 'CE', true), { iv: 0.4, source: 'nearest', from: { strike: 90, type: 'CE' } })
})
