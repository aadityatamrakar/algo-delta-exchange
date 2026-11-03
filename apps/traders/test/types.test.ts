import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contractText, isOpenLeg, legKey } from '../src/types.ts'
import { sha256hex } from '../src/hash.ts'

test('legKey is the contract format', () => {
  assert.equal(legKey({ clientCode: 'C1', instrument: 'option', stock: 'TCS', expiry: '2026-10-27', strike: 3500, optType: 'CE' }), 'C1|option|TCS|2026-10-27|3500|CE')
  assert.equal(legKey({ clientCode: 'C1', instrument: 'future', stock: 'TCS', expiry: '2026-10-27', strike: null, optType: null }), 'C1|future|TCS|2026-10-27||')
  assert.equal(legKey({ clientCode: '', instrument: 'share', stock: 'TCS', expiry: '', strike: null, optType: null }), '|share|TCS|||')
})
test('isOpenLeg drops zero and expired legs, never shares by date', () => {
  assert.equal(isOpenLeg({ qty: 0, instrument: 'option', expiry: '2026-10-27' }, '2026-10-19'), false)
  assert.equal(isOpenLeg({ qty: -350, instrument: 'option', expiry: '2026-10-27' }, '2026-10-28'), false)
  assert.equal(isOpenLeg({ qty: -350, instrument: 'option', expiry: '2026-10-27' }, '2026-10-27'), true)
  assert.equal(isOpenLeg({ qty: 1000, instrument: 'share', expiry: '' }, '2030-01-01'), true)
})
test('contractText', () => {
  assert.equal(contractText({ instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE' }), '3500 CE 2026-10-27')
  assert.equal(contractText({ instrument: 'future', expiry: '2026-10-27', strike: null, optType: null }), 'FUT 2026-10-27')
  assert.equal(contractText({ instrument: 'share', expiry: '', strike: null, optType: null }), 'shares')
})
test('sha256hex is lower-case hex of a string or buffer', () => {
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  assert.equal(sha256hex('abc'), abc)
  assert.equal(sha256hex(Buffer.from('abc')), abc)
})
