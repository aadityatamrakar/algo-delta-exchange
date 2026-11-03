import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bookGreeks, yearsToExpiry, yearsToExpiryAt } from '../src/index.ts'

const HOUR = 3_600_000
const YEAR_MS = 365 * 24 * HOUR

test('yearsToExpiryAt measures calendar time to an expiry instant', () => {
  const instant = Date.UTC(2026, 10, 6, 12) // Delta: 12:00 UTC
  assert.equal(yearsToExpiryAt(instant - 6 * HOUR, instant), (6 * HOUR) / YEAR_MS)
  assert.equal(yearsToExpiryAt(instant - 30 * 24 * HOUR, instant), 30 / 365)
})

test('yearsToExpiryAt is never negative and 0 at the instant', () => {
  const instant = Date.UTC(2026, 10, 6, 12)
  assert.equal(yearsToExpiryAt(instant, instant), 0)
  assert.equal(yearsToExpiryAt(instant + HOUR, instant), 0)
  assert.equal(yearsToExpiryAt(Number.NaN, instant), 0)
})

test('yearsToExpiry is yearsToExpiryAt on the 15:40 IST close (10:10 UTC)', () => {
  const now = Date.UTC(2026, 6, 28, 3, 45)
  assert.equal(yearsToExpiry('2026-07-28', now), yearsToExpiryAt(now, Date.UTC(2026, 6, 28, 10, 10)))
})

test('bookGreeks prices to a caller-supplied expiry instant when given one', () => {
  const now = Date.UTC(2026, 10, 6, 6)
  const leg = {
    tradingsymbol: 'C-BTC-70000-061126',
    underlying: 'BTC',
    expiry: '2026-11-06',
    strike: 70_000,
    type: 'CE' as const,
    spot: 70_000,
    markPrice: 300,
    qty: -0.05,
  }
  const nse = bookGreeks([leg], now, { rate: 0 })
  const dx = bookGreeks([leg], now, { rate: 0, expiryInstantMs: () => Date.UTC(2026, 10, 6, 12) })
  // 6 hours to 12:00 UTC against 4h10m to 10:10 UTC: same premium, longer
  // tenor, so a lower implied vol.
  const ivN = nse.legs[0]?.iv ?? null
  const ivD = dx.legs[0]?.iv ?? null
  assert.ok(ivN !== null && ivD !== null)
  assert.ok(ivD < ivN, `${ivD} < ${ivN}`)
})
