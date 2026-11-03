import { test } from 'node:test'
import assert from 'node:assert/strict'
import { colourStep, stepFill } from '../../src/traders/colour-scale.ts'

test('colourStep: 3 × value / the larger magnitude, rounded and clamped', () => {
  assert.equal(colourStep(0, -10, 10), 0)
  assert.equal(colourStep(10, -10, 10), 3)
  assert.equal(colourStep(-10, -10, 10), -3)
  assert.equal(colourStep(5, -10, 10), 2)
  assert.equal(colourStep(-5, -10, 10), -2)
  assert.equal(colourStep(null, -10, 10), null)
  assert.equal(colourStep(4, 4, 4), 0)
  assert.equal(colourStep(2, 2, 10), 1)
  assert.equal(colourStep(50, -10, 10), 3)
  assert.equal(colourStep(0, 0, 0), 0)
})

test('stepFill: success for positive, error for negative, nothing at zero or unknown', () => {
  assert.match(stepFill(2) ?? '', /--color-success/)
  assert.match(stepFill(-1) ?? '', /--color-error/)
  assert.equal(stepFill(0), undefined)
  assert.equal(stepFill(null), undefined)
})
