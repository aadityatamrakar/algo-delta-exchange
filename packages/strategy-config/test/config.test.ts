import test from 'node:test'
import assert from 'node:assert/strict'
import { assertValidConfig, type BaseConfig } from '../src/index.ts'

const DATA = [{ kind: 'future', underlying: 'BANKNIFTY' }] as const

function base(overrides: Partial<BaseConfig> = {}): BaseConfig {
  return {
    tag: 'Test_Tag',
    class: 'premium-leg-book',
    enabled: true,
    underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
    strike: { offsetPoints: 0 },
    expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
    sizing: { kind: 'flat', lots: 1 },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: 1, dayLossRupees: null },
    data: DATA,
    legacy: { files: ['server/slive/test.js'] },
    ...overrides,
  }
}

test('a well-formed config passes', () => {
  assert.doesNotThrow(() => assertValidConfig(base()))
})

test('rejects an empty tag', () => {
  assert.throws(() => assertValidConfig(base({ tag: '' })), /tag/)
})

test('rejects a duplicate tag against the existing-tags set', () => {
  const existing = new Set(['Test_Tag'])
  assert.throws(() => assertValidConfig(base(), existing), /unique|duplicate/i)
})

test('rejects a strikeStep that does not match the underlying grid', () => {
  assert.throws(
    () => assertValidConfig(base({ underlying: { symbol: 'NIFTY', reference: 'index-spot', strikeStep: 100 } })),
    /strikeStep/,
  )
})

test('accepts the correct strikeStep per underlying', () => {
  assert.doesNotThrow(() =>
    assertValidConfig(base({ underlying: { symbol: 'NIFTY', reference: 'index-spot', strikeStep: 50 } })),
  )
  assert.doesNotThrow(() =>
    assertValidConfig(base({ underlying: { symbol: 'SENSEX', reference: 'current-future', strikeStep: 100 } })),
  )
})

test('rejects a missing squareOffAt', () => {
  assert.throws(
    () => assertValidConfig(base({ session: { startAt: '09:15:00', squareOffAt: '' } })),
    /squareOffAt/,
  )
})

// --- D9: risk.maxLotsNet: null MUST be accepted for uncapped sizing --------

test('D9: accepts an explicit null maxLotsNet on a non-flat sizing (bull-s-1 stays uncapped)', () => {
  assert.doesNotThrow(() =>
    assertValidConfig(
      base({
        sizing: { kind: 'pyramid-up', start: 1, step: 1, cap: null },
        risk: { maxLotsNet: null, dayLossRupees: null },
      }),
    ),
  )
})

test('rejects a negative or zero maxLotsNet when it IS provided (still a valid number, just nonsensical)', () => {
  assert.throws(
    () => assertValidConfig(base({ risk: { maxLotsNet: 0, dayLossRupees: null } })),
    /maxLotsNet/,
  )
})

// --- D9: stopPolicy 'none' MUST be a first-class valid value ----------------

test("D9: stopPolicy 'none' is valid (eagle-s-1 stays stopless)", () => {
  const exit = { stop: { basis: 'none' as const }, target: { basis: 'none' as const },
                 precedence: ['EOD' as const], stopMeasuredOn: 'traded' as const, stopPolicy: 'none' as const }
  assert.doesNotThrow(() => assertValidConfig(base(), undefined, exit))
})

test("stopPolicy 'resting' or 'local-tick' also pass", () => {
  const restingExit = { stop: { basis: 'fixed-pct' as const, value: 1.25 }, target: { basis: 'none' as const },
                         precedence: ['EOD' as const, 'SL' as const], stopMeasuredOn: 'traded' as const,
                         stopPolicy: 'resting' as const }
  assert.doesNotThrow(() => assertValidConfig(base(), undefined, restingExit))
})
