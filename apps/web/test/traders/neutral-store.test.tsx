import { expect, test } from 'vitest'
import { clearNeutral, publishNeutral, readNeutral } from '../../src/traders/neutral-store.ts'

test('a published Δ0 and breakevens serve while fresh, and none after', () => {
  clearNeutral()
  expect(readNeutral('TCS', 0, 90_000)).toBe(null)
  publishNeutral('TCS', { price: 3034.1, pct: -0.74, bepLow: 2997.4, bepHigh: 3079.2, timeValue: 155843.75, delta: -412.5 }, 1_000)
  expect(readNeutral('TCS', 50_000, 90_000)).toEqual({ price: 3034.1, pct: -0.74, bepLow: 2997.4, bepHigh: 3079.2, timeValue: 155843.75, delta: -412.5, at: 1_000 })
  expect(readNeutral('TCS', 100_000, 90_000)).toBe(null)
  expect(readNeutral('INFY', 2_000, 90_000)).toBe(null)
})
