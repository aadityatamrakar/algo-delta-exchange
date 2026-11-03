import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OptionType } from '@algomaker/greeks'
import type { PayoffLeg } from '@algomaker/payoff'
import { whatIfOfMoves } from '../src/analytics/what-if.ts'

const OCT = '2026-10-27'
const k1: PayoffLeg = { id: 'k1', instrument: 'option', qty: -350, strike: 3400, type: 'CE', expiry: OCT, entry: 80, iv: 0.25 }
const f1: PayoffLeg = { id: 'f1', instrument: 'future', qty: 175, strike: null, type: null, expiry: OCT, entry: 3400, iv: null }
const LEGS = [k1, f1]
const PRICES: Record<string, number> = { '3400CE': 61, '3500CE': 30, '3300PE': 12 }
const priceOf = (strike: number, type: OptionType): number | null => PRICES[`${strike}${type}`] ?? null

test('a close is the leg\'s opposite quantity at the chain price', () => {
  assert.deepEqual(whatIfOfMoves([{ op: 'close', legId: 'k1' }], LEGS, priceOf, OCT), [
    { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: 350, price: 61 },
  ])
})

test('a shift closes the leg and opens the same size at the new strike', () => {
  assert.deepEqual(whatIfOfMoves([{ op: 'shift', legId: 'k1', toStrike: 3500 }], LEGS, priceOf, OCT), [
    { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: 350, price: 61 },
    { instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, price: 30 },
  ])
})

test('an add is that contract at the chain price, in the job\'s expiry', () => {
  assert.deepEqual(whatIfOfMoves([{ op: 'add', strike: 3300, type: 'PE', qty: -175 }], LEGS, priceOf, OCT), [
    { instrument: 'option', expiry: OCT, strike: 3300, optType: 'PE', qty: -175, price: 12 },
  ])
  assert.deepEqual(whatIfOfMoves([{ op: 'hedge', strike: 3500, type: 'CE', qty: 175 }], LEGS, priceOf, OCT), [
    { instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: 175, price: 30 },
  ])
})

test('a move with no price is dropped, never filled at a guess', () => {
  const none = (): number | null => null
  assert.deepEqual(whatIfOfMoves([{ op: 'close', legId: 'k1' }], LEGS, none, OCT), [])
  assert.deepEqual(whatIfOfMoves([{ op: 'add', strike: 3450, type: 'CE', qty: -175 }], LEGS, priceOf, OCT), [])
  // a shift whose landing strike has no price is dropped whole: never half a shift
  assert.deepEqual(whatIfOfMoves([{ op: 'shift', legId: 'k1', toStrike: 3450 }], LEGS, priceOf, OCT), [])
  const throws = (): number | null => { throw new Error('chain down') }
  assert.deepEqual(whatIfOfMoves([{ op: 'close', legId: 'k1' }], LEGS, throws, OCT), [])
  // a move on a leg the job does not hold names nothing
  assert.deepEqual(whatIfOfMoves([{ op: 'close', legId: 'nope' }], LEGS, priceOf, OCT), [])
})

test('a future is closed at the market: no chain price, so the rate is left to the Scenario tab', () => {
  assert.deepEqual(whatIfOfMoves([{ op: 'close', legId: 'f1' }], LEGS, priceOf, OCT), [
    { instrument: 'future', expiry: OCT, strike: null, optType: null, qty: -175, price: null },
  ])
})

test('the moves of one plan come out in its order', () => {
  const out = whatIfOfMoves([{ op: 'add', strike: 3300, type: 'PE', qty: -175 }, { op: 'close', legId: 'k1' }], LEGS, priceOf, OCT)
  assert.deepEqual(out.map((l) => [l.strike, l.qty]), [[3300, -175], [3400, 350]])
})

test('a future move is the book month\'s future at the future mark; with no mark the Scenario tab prices it', () => {
  assert.deepEqual(whatIfOfMoves([{ op: 'future', qty: -350 }], LEGS, priceOf, OCT, 3412.4), [
    { instrument: 'future', expiry: OCT, strike: null, optType: null, qty: -350, price: 3412.4 },
  ])
  assert.deepEqual(whatIfOfMoves([{ op: 'future', qty: 175 }], LEGS, priceOf, OCT), [
    { instrument: 'future', expiry: OCT, strike: null, optType: null, qty: 175, price: null },
  ])
  // a futures close takes the mark too when one is given
  assert.deepEqual(whatIfOfMoves([{ op: 'close', legId: 'f1' }], LEGS, priceOf, OCT, 3412.4), [
    { instrument: 'future', expiry: OCT, strike: null, optType: null, qty: -175, price: 3412.4 },
  ])
})

test('a side-aware price is asked with the signed size of each trade', () => {
  // bid one under, ask one over the chain price
  const crossing = (strike: number, type: OptionType, qty: number): number | null => {
    const p = priceOf(strike, type)
    return p === null ? null : qty > 0 ? p + 1 : p - 1
  }
  assert.deepEqual(whatIfOfMoves([{ op: 'shift', legId: 'k1', toStrike: 3500 }], LEGS, crossing, OCT), [
    { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: 350, price: 62 },
    { instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, price: 29 },
  ])
  assert.deepEqual(whatIfOfMoves([{ op: 'hedge', strike: 3500, type: 'CE', qty: 175 }], LEGS, crossing, OCT)[0]?.price, 31)
})
