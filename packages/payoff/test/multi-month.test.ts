import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import { DEFAULT_RATE, type PayoffLeg } from '../src/legs.ts'
import { buildPayoffView } from '../src/view.ts'
import { buildMultiMonthView } from '../src/multi-month.ts'

const OCT = '2026-10-27', NOV = '2026-11-24', TODAY = '2026-10-19'
const opt = (id: string, expiry: string, qty: number, entry: number, strike = 3500, type: 'CE' | 'PE' = 'CE', iv: number | null = 0.2): PayoffLeg => ({ id, instrument: 'option', qty, strike, type, expiry, entry, iv })
const fut = (id: string, expiry: string, qty: number, entry: number): PayoffLeg => ({ id, instrument: 'future', qty, strike: null, type: null, expiry, entry, iv: null })

test('one month, no spot: identical to buildPayoffView', () => {
  const legs = [opt('c', OCT, -350, 40, 3500, 'CE', 0.22), fut('f', OCT, 175, 3480)]
  const ours = buildMultiMonthView({ legs, futures: { [OCT]: 3500 }, spot: null, today: TODAY, realised: 0, targetPnl: null })
  const desk = buildPayoffView({ legs, future: 3500, expiry: OCT, today: TODAY, realised: 0, targetPnl: null })
  assert.equal(ours.curve.length, desk.curve.length); assert.equal(ours.midDate, desk.midDate)
  ours.curve.forEach((p, i) => { for (const k of ['price', 'expiry', 't0', 'mid'] as const) assert.ok(Math.abs(p[k] - desk.curve[i]![k]) < 1e-6, `${k}@${i}`) })
  for (const g of ['delta', 'gamma', 'vega', 'theta'] as const) assert.ok(Math.abs(ours.greeks[g] - desk.greeks[g]) < 1e-9)
  const rung = 3500 * 0.1 / 60
  for (const s of ['down', 'up'] as const) { const a = ours.summary.breakevens[s], b = desk.summary.breakevens[s]; assert.ok(a === b || (a !== null && b !== null && Math.abs(a - b) <= rung)) }
  assert.ok(Math.abs(ours.summary.netCredit - desk.summary.netCredit) < 1e-9)
  assert.ok(Math.abs(ours.summary.worstShock - desk.summary.worstShock) < 1e-6)
  assert.ok(Math.abs(ours.summary.maxLoss - desk.summary.maxLoss) < 1e-6)
})
test('a far-month future is marked off its own month', () => {
  const v = buildMultiMonthView({ legs: [fut('n', NOV, 175, 3500)], futures: { [OCT]: 3490, [NOV]: 3510 }, spot: 3480, today: TODAY, realised: 0, targetPnl: null })
  assert.equal(v.curve[60]!.price, 3480); assert.ok(Math.abs(v.curve[60]!.t0 - 1750) < 1e-9)
})
test('a calendar keeps the far leg\'s time value at the near expiry', () => {
  const v = buildMultiMonthView({ legs: [opt('o', OCT, -350, 40), opt('n', NOV, 350, 80)], futures: { [OCT]: 3500, [NOV]: 3520 }, spot: null, today: TODAY, realised: 0, targetPnl: null })
  const far = b76Price({ future: 3520, strike: 3500, t: 28 / 365, vol: 0.2, rate: DEFAULT_RATE, type: 'CE' })
  assert.ok(Math.abs(v.curve[60]!.expiry - (14000 + 350 * (far - 80))) < 1e-6)
})
test('a share leg moves with spot', () => {
  const v = buildMultiMonthView({ legs: [fut('s', '', 1000, 3000)], futures: {}, spot: 3100, today: TODAY, realised: 0, targetPnl: null })
  assert.ok(Math.abs(v.curve[60]!.t0 - 100000) < 1e-9); assert.equal(v.greeks.delta, 1000); assert.equal(v.midDate, TODAY)
})
test('a month with no forward is left out, named', () => {
  const v = buildMultiMonthView({ legs: [opt('d', '2026-12-29', -175, 30), fut('f', OCT, 175, 3480)], futures: { [OCT]: 3500 }, spot: null, today: TODAY, realised: 0, targetPnl: null })
  assert.ok(v.warnings.includes('leg "d": no future price for 2026-12-29; left out'))
})
test('a share with no spot is left out, named', () => {
  const v = buildMultiMonthView({ legs: [fut('s', '', 10, 100), fut('f', OCT, 175, 3480)], futures: { [OCT]: 3500 }, spot: null, today: TODAY, realised: 0, targetPnl: null })
  assert.ok(v.warnings.includes('leg "s": no spot price; left out'))
})
test('nothing to price', () => {
  const v = buildMultiMonthView({ legs: [fut('s', '', 10, 100)], futures: {}, spot: null, today: TODAY, realised: 7, targetPnl: 9 })
  assert.deepEqual(v.curve, []); assert.ok(v.warnings.includes('no spot and no future price: nothing to price'))
  assert.equal(v.summary.booked, 7); assert.equal(v.summary.targetPnl, 9)
})
test('realised shifts every column; nothing is NaN even with an IV-less option', () => {
  const legs = [opt('c', OCT, -350, 40), opt('x', NOV, 175, 50, 3600, 'PE', null)]
  const base = { legs, futures: { [OCT]: 3500, [NOV]: 3520 }, spot: 3500, today: TODAY, targetPnl: null }
  const a = buildMultiMonthView({ ...base, realised: 0 }), b = buildMultiMonthView({ ...base, realised: 5000 })
  b.curve.forEach((p, i) => { for (const k of ['expiry', 't0', 'mid'] as const) assert.ok(Math.abs(p[k] - a.curve[i]![k] - 5000) < 1e-6) })
  const nums: number[] = [...b.curve.flatMap((p) => [p.price, p.expiry, p.t0, p.mid]), ...b.table.flatMap((p) => [p.price, p.expiry, p.t0, p.mid]), ...Object.values(b.greeks), b.summary.pop, b.summary.maxLoss, b.summary.maxProfit, b.summary.worstShock, b.summary.netCredit]
  assert.ok(nums.every(Number.isFinite))
})
