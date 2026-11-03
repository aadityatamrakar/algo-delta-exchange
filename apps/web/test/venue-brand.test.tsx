import { test, expect } from 'vitest'
import { brandFor, DX, NSE } from '../src/venue.ts'

test('the brand is Delta Desk on DX and SMPv2 on NSE', () => {
  expect(brandFor(DX)).toBe('Delta Desk')
  expect(brandFor(NSE)).toBe('SMPv2')
})
