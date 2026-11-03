import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bsPrice,
  greeks,
  impliedVol,
  bookGreeks,
  carryYield,
  yearsToExpiry,
  normCdf,
  type PositionLeg,
} from '../src/index.ts'

const close = (a: number, b: number, eps: number, what = ''): void => {
  assert.ok(Math.abs(a - b) < eps, `${what} expected ~${b}, got ${a} (eps ${eps})`)
}

test('normCdf matches known values', () => {
  close(normCdf(0), 0.5, 1e-9)
  close(normCdf(1.96), 0.975, 1e-4)
  close(normCdf(-1.96), 0.025, 1e-4)
})

test('put-call parity holds', () => {
  const base = { spot: 521, strike: 530, t: 0.05, vol: 0.32, rate: 0.065, dividendYield: 0.01 }
  const c = bsPrice({ ...base, type: 'CE' })
  const p = bsPrice({ ...base, type: 'PE' })
  const lhs = c - p
  const rhs =
    base.spot * Math.exp(-base.dividendYield * base.t) - base.strike * Math.exp(-base.rate * base.t)
  close(lhs, rhs, 1e-8, 'put-call parity')
})

test('call and put deltas differ by exp(-qT)', () => {
  const base = { spot: 521, strike: 530, t: 0.05, vol: 0.32, rate: 0.065, dividendYield: 0.01 }
  const dc = greeks({ ...base, type: 'CE' }).delta
  const dp = greeks({ ...base, type: 'PE' }).delta
  close(dc - dp, Math.exp(-base.dividendYield * base.t), 1e-9, 'delta parity')
})

test('delta matches a numerical derivative of price', () => {
  const base = { strike: 530, t: 0.08, vol: 0.30, rate: 0.065, type: 'CE' as const }
  const h = 0.01
  const up = bsPrice({ ...base, spot: 521 + h })
  const dn = bsPrice({ ...base, spot: 521 - h })
  close(greeks({ ...base, spot: 521 }).delta, (up - dn) / (2 * h), 1e-5, 'delta')
})

test('gamma matches the second numerical derivative', () => {
  const base = { strike: 530, t: 0.08, vol: 0.30, rate: 0.065, type: 'PE' as const }
  const h = 0.05
  const up = bsPrice({ ...base, spot: 521 + h })
  const mid = bsPrice({ ...base, spot: 521 })
  const dn = bsPrice({ ...base, spot: 521 - h })
  close(greeks({ ...base, spot: 521 }).gamma, (up - 2 * mid + dn) / (h * h), 1e-5, 'gamma')
})

test('a short option has positive theta and negative vega at book level', () => {
  const g = greeks({ spot: 521, strike: 530, t: 0.05, vol: 0.32, rate: 0.065, type: 'CE' })
  assert.ok(g.theta < 0, 'long call theta must be negative')
  assert.ok(g.vega > 0, 'long call vega must be positive')
  // Shorting flips both, which is the whole premise of the desk's books.
  const qty = -6750
  assert.ok(g.theta * qty > 0)
  assert.ok(g.vega * qty < 0)
})

test('impliedVol round-trips a priced option', () => {
  const base = { spot: 521, strike: 530, t: 0.05, rate: 0.065, type: 'CE' as const }
  const price = bsPrice({ ...base, vol: 0.3712 })
  const iv = impliedVol({ ...base, price })
  assert.ok(iv !== null)
  close(iv, 0.3712, 1e-4, 'implied vol')
})

test('impliedVol returns null for an arbitrage-violating quote instead of guessing', () => {
  // A call cannot be worth more than the spot.
  assert.equal(impliedVol({ spot: 521, strike: 530, t: 0.05, rate: 0.065, type: 'CE', price: 600 }), null)
  // Below intrinsic.
  assert.equal(impliedVol({ spot: 600, strike: 500, t: 0.05, rate: 0.065, type: 'CE', price: 1 }), null)
  assert.equal(impliedVol({ spot: 521, strike: 530, t: 0.05, rate: 0.065, type: 'CE', price: 0 }), null)
})

test('expired and zero-vol contracts mark at intrinsic with a step delta, never NaN', () => {
  const expired = greeks({ spot: 540, strike: 530, t: 0, vol: 0.3, rate: 0.065, type: 'CE' })
  assert.equal(expired.price, 10)
  assert.equal(expired.delta, 1)
  assert.ok(Number.isFinite(expired.gamma))
  const otm = greeks({ spot: 520, strike: 530, t: 0, vol: 0.3, rate: 0.065, type: 'CE' })
  assert.equal(otm.price, 0)
  assert.equal(otm.delta, 0)
})

test('yearsToExpiry counts to the 15:40 IST F&O close, not the date boundary', () => {
  // 09:15 IST on expiry day == 03:45 UTC. 6h25m of life remains.
  const nineFifteenIst = Date.UTC(2026, 6, 28, 3, 45)
  const y = yearsToExpiry('2026-07-28', nineFifteenIst)
  close(y * 365 * 24, 6 + 25 / 60, 1e-6, 'hours to expiry')
  // F&O trades to 15:40 since 3 Aug 2026: at 15:35 IST five minutes remain, at 15:40 none.
  close(yearsToExpiry('2026-07-28', Date.UTC(2026, 6, 28, 10, 5)) * 365 * 24 * 60, 5, 1e-6, 'minutes at 15:35')
  assert.equal(yearsToExpiry('2026-07-28', Date.UTC(2026, 6, 28, 10, 10)), 0)
  // Past the close it is zero, never negative.
  assert.equal(yearsToExpiry('2026-07-28', Date.UTC(2026, 6, 29)), 0)
})

test('book net delta aggregates signed quantities across a strangle ladder', () => {
  // The KALYANKJIL book: 4 short CE + 4 short PE, 6750 qty each (5 lots x 1350).
  const nowMs = Date.UTC(2026, 6, 14, 5, 0) // 10:30 IST, two weeks to expiry
  const spot = 521
  const mk = (strike: number, type: 'CE' | 'PE', markPrice: number): PositionLeg => ({
    tradingsymbol: `KALYANKJIL26JUL${strike}${type}`,
    underlying: 'KALYANKJIL',
    strike,
    type,
    expiry: '2026-07-28',
    qty: -6750,
    spot,
    markPrice,
  })
  const legs = [
    mk(530, 'CE', 12.5), mk(535, 'CE', 10.4), mk(540, 'CE', 8.6), mk(545, 'CE', 7.0),
    mk(510, 'PE', 11.8), mk(505, 'PE', 9.9), mk(500, 'PE', 8.2), mk(495, 'PE', 6.8),
  ]
  const bk = bookGreeks(legs, nowMs)
  assert.equal(bk.legs.length, 8)
  assert.equal(bk.unpriced.length, 0)
  // Short strangle: theta positive (collecting), vega negative (short vol).
  assert.ok(bk.netTheta > 0, `expected positive net theta, got ${bk.netTheta}`)
  assert.ok(bk.netVega < 0, `expected negative net vega, got ${bk.netVega}`)
  assert.ok(bk.netGamma < 0, `expected negative net gamma, got ${bk.netGamma}`)
  // Roughly balanced ladder -> net delta small relative to a single leg's.
  const oneLeg = Math.abs(bk.legs[0]?.positionDelta ?? 0)
  assert.ok(Math.abs(bk.netDelta) < oneLeg, `net delta ${bk.netDelta} vs one leg ${oneLeg}`)
})

test('an unpriceable leg is NAMED and excluded, not marked at a guessed vol', () => {
  const nowMs = Date.UTC(2026, 6, 14, 5, 0)
  const legs: PositionLeg[] = [
    {
      tradingsymbol: 'GOOD', underlying: 'X', strike: 530, type: 'CE', expiry: '2026-07-28',
      qty: -6750, spot: 521, markPrice: 12.5,
    },
    {
      // A crossed/stale quote above spot — no vol solves this.
      tradingsymbol: 'STALE', underlying: 'X', strike: 530, type: 'CE', expiry: '2026-07-28',
      qty: -6750, spot: 521, markPrice: 900,
    },
  ]
  const bk = bookGreeks(legs, nowMs)
  assert.deepEqual(bk.unpriced, ['STALE'])
  assert.equal(bk.legs.length, 1)
  // The total must reflect only what was actually priced.
  assert.equal(bk.netDelta, bk.legs[0]?.positionDelta)

  // Opting into a fallback is explicit and then nothing is dropped.
  const forced = bookGreeks(legs, nowMs, { fallbackVol: 0.35 })
  assert.equal(forced.unpriced.length, 0)
  assert.equal(forced.legs.length, 2)
})

test('a deep-ITM leg quoting below the cash no-arb floor is fallback-priced, not dropped', () => {
  // THE TCS 2440PE CASE (2026-08-17). Spot 2321.40, the put's LTP 114 — below
  // the cash-spot zero-vol floor K·e^(-rt) − S ≈ 115.13, because stock options
  // price off the FUTURE and a deep put's LTP routinely sits under cash
  // intrinsic. No vol solves that quote, and dropping the leg removed ~+1,000
  // of position delta from a book whose tile then read -724 while the desk's
  // own engine read +355. With a fallback vol the leg contributes theoretical
  // greeks (delta ≈ -0.9, so the SHORT contributes ≈ +1,000) and a model
  // price, and it is NAMED in fallbackPriced with iv null — an estimate that
  // says it is one, instead of a hole that looks like flatness.
  const nowMs = Date.UTC(2026, 7, 17, 7, 52) // 13:22 IST, 8 days to expiry
  const legs: PositionLeg[] = [
    {
      tradingsymbol: 'TCS26AUG2440PE', underlying: 'TCS', strike: 2440, type: 'PE',
      expiry: '2026-08-25', qty: -1125, spot: 2321.4, markPrice: 114,
    },
  ]
  const dropped = bookGreeks(legs, nowMs)
  assert.deepEqual(dropped.unpriced, ['TCS26AUG2440PE'])
  assert.deepEqual(dropped.fallbackPriced, [])

  const bk = bookGreeks(legs, nowMs, { fallbackVol: 0.28 })
  assert.deepEqual(bk.unpriced, [])
  assert.deepEqual(bk.fallbackPriced, ['TCS26AUG2440PE'])
  const leg = bk.legs[0]
  assert.ok(leg !== undefined)
  // The IV is NOT claimed as solved — the quote admitted no solution.
  assert.equal(leg?.iv, null)
  // Short deep-ITM put: large positive position delta, near the whole size.
  assert.ok((leg?.positionDelta ?? 0) > 700, `positionDelta ${leg?.positionDelta}`)
  // And the model price is a usable theoretical mark near intrinsic.
  assert.ok((leg?.price ?? 0) > 110 && (leg?.price ?? 0) < 140, `price ${leg?.price}`)
})

test('carryYield makes BS price off the TRADED FUTURE — Black-76, verified on the live TCS quote', () => {
  // 2026-08-17 14:57 IST, all four numbers off the live desk: spot 2318.60,
  // TCS26AUGFUT 2328.80, the 2440PE mid 116.30, 8 days to expiry. Off cash
  // spot this quote is below the no-arbitrage floor (117.93) and admits NO
  // vol — the market discounts off the future, not cash. With the carry
  // implied by the future's own mark the very same solver returns 26.4%,
  // in line with the neighbouring strikes' 27-28%, and reprices the quote
  // exactly. The solver was never wrong; cash spot was.
  const t = 8 / 365
  const q = carryYield(2318.6, 2328.8, t, 0.065)
  assert.ok(q !== null)
  const base = { spot: 2318.6, strike: 2440, t, rate: 0.065, type: 'PE' as const }
  assert.equal(impliedVol({ ...base, price: 116.3 }), null) // cash spot: impossible
  const iv = impliedVol({ ...base, dividendYield: q, price: 116.3 })
  assert.ok(iv !== null && iv > 0.2 && iv < 0.35, `iv ${iv}`)
  assert.ok(Math.abs(bsPrice({ ...base, dividendYield: q, vol: iv }) - 116.3) < 0.01)
})

test('carryYield refuses garbage inputs rather than inventing a carry', () => {
  assert.equal(carryYield(0, 2328.8, 8 / 365, 0.065), null)
  assert.equal(carryYield(2318.6, 0, 8 / 365, 0.065), null)
  assert.equal(carryYield(2318.6, 2328.8, 0, 0.065), null)
  // A future 40% away from spot is a bad mark, not a carry.
  assert.equal(carryYield(2318.6, 3300, 8 / 365, 0.065), null)
})
