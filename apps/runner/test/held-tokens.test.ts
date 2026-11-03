/**
 * The subscription hole that left a held leg unmarkable (2026-09-07).
 *
 * Each case here is the shape of a real book seen on prod that afternoon, not
 * an invented one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { heldLegTokens } from '../src/held-tokens.ts'

// The real dump rows for the two contracts MIRROR_A010 could not mark, plus
// the two it could — the pair that proved the correlation.
const DUMP = [
  { instrument_token: 10916098, tradingsymbol: 'NIFTY2690824050CE' },
  { instrument_token: 10916354, tradingsymbol: 'NIFTY2690824050PE' },
  { instrument_token: 10914050, tradingsymbol: 'NIFTY2690823850CE' },
  { instrument_token: 220339461, tradingsymbol: 'SENSEX2691076700CE' },
]

test('a MIRROR leg carrying no instrumentToken still resolves, from the dump', () => {
  // This is the whole bug: the mirror ledger persists no token, so a fix that
  // trusted the leg would have changed nothing for the books that needed it.
  // `instrument: {}` is the real mirror shape — the ledger persists no token.
  const legs = [{ tradingsymbol: 'NIFTY2690824050CE', instrument: {} }]
  const { tokens, unresolved } = heldLegTokens(legs, DUMP)
  assert.deepEqual(tokens, [10916098])
  assert.deepEqual(unresolved, [])
})

test("the leg's own token wins when it has one", () => {
  const legs = [
    { tradingsymbol: 'NIFTY2690823850CE', instrument: { instrumentToken: 10914050 } },
  ]
  assert.deepEqual(heldLegTokens(legs, DUMP).tokens, [10914050])
})

test('an unresolvable held symbol is REPORTED, never silently dropped', () => {
  // An expired contract is gone from the dump. Saying nothing here would
  // recreate the silent blindness this file exists to end.
  const legs = [{ tradingsymbol: 'SENSEX2680678700PE', instrument: {} }]
  const { tokens, unresolved } = heldLegTokens(legs, DUMP)
  assert.deepEqual(tokens, [])
  assert.deepEqual(unresolved, ['SENSEX2680678700PE'])
})

test('the same contract held by two instances is declared once', () => {
  const legs = [
    { tradingsymbol: 'NIFTY2690824050CE', instrument: {} },
    { tradingsymbol: 'NIFTY2690824050CE', instrument: { instrumentToken: 10916098 } },
    { tradingsymbol: 'SENSEX2691076700CE', instrument: {} },
  ]
  assert.deepEqual(heldLegTokens(legs, DUMP).tokens, [10916098, 220339461])
})

test('a zero or malformed token never reaches the feed', () => {
  const legs = [{ tradingsymbol: 'GHOST', instrument: { instrumentToken: 0 } }]
  const { tokens, unresolved } = heldLegTokens(legs, [
    { instrument_token: 0, tradingsymbol: 'GHOST' },
  ])
  assert.deepEqual(tokens, [])
  assert.deepEqual(unresolved, ['GHOST'])
})

test('no held legs declares nothing extra', () => {
  assert.deepEqual(heldLegTokens([], DUMP), { tokens: [], unresolved: [] })
})
