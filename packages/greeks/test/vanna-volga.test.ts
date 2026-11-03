import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Greeks, b76SecondOrder, bookGreeks, greeks } from '../src/index.ts'

const rel = (a: number, b: number, r = 1e-4) =>
  assert.ok(Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * r), `${a} vs ${b}`)
const B = { future: 100, strike: 105, t: 0.25, vol: 0.3, rate: 0.065 } as const

test('b76SecondOrder is the closed form, identical for CE and PE', () => {
  const ce = b76SecondOrder({ ...B, type: 'CE' })
  rel(ce.vanna, 0.005075529401, 1e-9)
  rel(ce.volga, 0.0006351206899, 1e-9)
  assert.deepEqual(b76SecondOrder({ ...B, type: 'PE' }), ce)
})

test('b76SecondOrder matches finite differences of b76Greeks', () => {
  for (const type of ['CE', 'PE'] as const)
    for (const vol of [0.12, 0.3, 0.6])
      for (const t of [0.02, 0.25]) {
        const i = { ...B, vol, t, type }
        const h = 1e-4
        const up = b76Greeks({ ...i, vol: vol + h })
        const dn = b76Greeks({ ...i, vol: vol - h })
        rel(b76SecondOrder(i).vanna, (up.delta - dn.delta) / (2 * h) / 100)
        rel(b76SecondOrder(i).volga, (up.vega - dn.vega) / (2 * h) / 100)
      }
})

test('degenerate inputs give zeros, never NaN', () => {
  for (const bad of [{ t: 0 }, { vol: 0 }, { future: 0 }, { strike: 0 }])
    assert.deepEqual(b76SecondOrder({ ...B, type: 'CE', ...bad }), { vanna: 0, volga: 0 })
})

test('greeks() carries vanna and volga (spot, dividend yield)', () => {
  const base = { spot: 521, strike: 530, t: 0.05, vol: 0.32, rate: 0.065, dividendYield: 0.01 }
  const g = greeks({ ...base, type: 'CE' })
  rel(g.vanna, 0.002909518781, 1e-9)
  rel(g.volga, 0.0005597767438, 1e-9)
  for (const type of ['CE', 'PE'] as const)
    for (const vol of [0.15, 0.32, 0.6]) {
      const i = { ...base, vol, type }
      const h = 1e-4
      const up = greeks({ ...i, vol: vol + h })
      const dn = greeks({ ...i, vol: vol - h })
      const g2 = greeks(i)
      rel(g2.vanna, (up.delta - dn.delta) / (2 * h) / 100)
      rel(g2.volga, (up.vega - dn.vega) / (2 * h) / 100)
    }
  const expired = greeks({ spot: 540, strike: 530, t: 0, vol: 0.3, rate: 0.065, type: 'CE' })
  assert.equal(expired.vanna, 0)
  assert.equal(expired.volga, 0)
})

test('bookGreeks sums positionVanna and positionVolga', () => {
  const mk = (strike: number, type: 'CE' | 'PE', qty: number, markPrice: number) => ({
    tradingsymbol: `X${strike}${type}`,
    underlying: 'X',
    strike,
    type,
    expiry: '2026-10-27',
    qty,
    spot: 3000,
    markPrice,
  })
  const bk = bookGreeks([mk(3000, 'CE', -175, 60), mk(2900, 'PE', 175, 30)], Date.UTC(2026, 9, 19, 4, 30))
  assert.equal(bk.legs.length, 2)
  assert.equal(bk.netVanna, bk.legs.reduce((s, l) => s + l.positionVanna, 0))
  assert.equal(bk.netVolga, bk.legs.reduce((s, l) => s + l.positionVolga, 0))
  assert.notEqual(bk.netVolga, 0)
  for (const l of bk.legs) {
    assert.equal(l.positionVanna, l.vanna * l.qty)
    assert.equal(l.positionVolga, l.volga * l.qty)
  }
})
