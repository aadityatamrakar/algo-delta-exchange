/**
 * The scenario grid's axes, the Gap Up/Down rows, breakevens, and the Sensibull
 * target/expiry curve and table.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { yearsToExpiry, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE, legPnl, type PayoffLeg } from '../src/legs.ts'
import {
  scenarioAxes,
  gapRows,
  breakevenRange,
  payoffCurve,
  payoffTable,
  type Axes,
} from '../src/scenario-grid.ts'

const NOW = Date.UTC(2026, 9, 19, 4, 30) // Mon 10:00 IST

function leg(
  id: string,
  instrument: 'option' | 'future',
  qty: number,
  strike: number | null,
  type: OptionType | null,
  expiry: string,
  entry: number,
  iv: number | null,
): PayoffLeg {
  return { id, instrument, qty, strike, type, expiry, entry, iv }
}
function close(a: number, b: number, eps: number): void {
  assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (eps ${eps})`)
}

// weekends off, and Tue 2026-10-20 a holiday
const TD = (day: string): boolean => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
  return dow !== 0 && dow !== 6 && day !== '2026-10-20'
}

const BASE = { middle: 3000, stepPct: 0.5, count: 2, spot: 3012, start: '2026-10-19', end: '2026-10-27', everyNth: 1, expiry: '2026-10-27', now: NOW, isTradingDay: TD }

test('% rows around M.Strike, spot inserted, trading-day columns, the expiry date and then Expiry', () => {
  const a = scenarioAxes(BASE) as Axes
  assert.deepEqual([a.spots, a.currentRow], [[2970, 2985, 3000, 3012, 3015, 3030], 3])
  assert.deepEqual(a.columns.map((c) => c.date), ['2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-27'])
  assert.deepEqual(a.labels, ['19 Oct', '21 Oct', '22 Oct', '23 Oct', '26 Oct', '27 Oct', 'Expiry'])
  assert.deepEqual([a.columns[0]!.ms, a.columns[5]!.ms, a.columns[6]!.ms], [NOW, Date.UTC(2026, 9, 27, 4, 30), Date.UTC(2026, 9, 27, 10, 10)])
})
test('VolHedge’s defaults give ±25 % in 101 rows', () => {
  const a = scenarioAxes({ ...BASE, count: 50, spot: 3000 }) as Axes
  assert.deepEqual([a.spots.length, a.spots[0], a.spots[100], a.currentRow], [101, 2250, 3750, 50])
})
test('every 2nd trading day still ends on Expiry', () =>
  assert.deepEqual((scenarioAxes({ ...BASE, everyNth: 2 }) as Axes).labels, ['19 Oct', '22 Oct', '26 Oct', 'Expiry']))
test('bad specs are errors that name the field', () => {
  const err = (x: unknown) => (x as { error: string }).error
  assert.match(err(scenarioAxes({ ...BASE, count: 101 })), /count/); assert.match(err(scenarioAxes({ ...BASE, stepPct: 0 })), /stepPct/)
  assert.match(err(scenarioAxes({ ...BASE, everyNth: 0 })), /everyNth/); assert.match(err(scenarioAxes({ ...BASE, start: '2026-10-28' })), /start/)
  assert.match(err(scenarioAxes({ ...BASE, end: '2027-03-31', expiry: '2027-03-31' })), /60/)
})
test('the other field checks', () => {
  const err = (x: unknown) => (x as { error: string }).error
  assert.match(err(scenarioAxes({ ...BASE, stepPct: Number.NaN })), /stepPct/)
  assert.match(err(scenarioAxes({ ...BASE, everyNth: 1.5 })), /everyNth/)
  assert.match(err(scenarioAxes({ ...BASE, middle: 0 })), /middle/)
  assert.match(err(scenarioAxes({ ...BASE, spot: -1 })), /spot/)
  assert.match(err(scenarioAxes({ ...BASE, start: '2026-10-18' })), /start/) // before today
  assert.match(err(scenarioAxes({ ...BASE, start: '2026-10-22', end: '2026-10-21' })), /end/)
})
test('rows at or below zero are dropped', () => {
  const a = scenarioAxes({ ...BASE, middle: 100, stepPct: 50, count: 3, spot: 100 }) as Axes
  assert.deepEqual(a.spots, [50, 100, 150, 200, 250])
})

const M = { spot: 3000, futures: { '2026-10-27': 3010 }, now: NOW }
const FUT = leg('f', 'future', 175, null, null, '2026-10-27', 3000, null)
const OCT_CE = leg('oc', 'option', -175, 3000, 'CE', '2026-10-27', 50, 0.25)
test('gap rows: price move and vol change at the next open', () => {
  const [up] = gapRows([FUT], M, '2026-10-21', [{ movePct: 10, volPts: -10 }], {}, true, 1750)
  close(up!.price, 3300, 1e-9); close(up!.pnl, 54425, 1e-6); close(up!.change, 52675, 1e-6)   // 175 × (3311 − 3000)
  const open = Date.UTC(2026, 9, 21, 3, 45), t = yearsToExpiry('2026-10-27', open)
  close(gapRows([OCT_CE], M, '2026-10-21', [{ movePct: 10, volPts: -10 }], {}, true, 0)[0]!.pnl, legPnl(OCT_CE, 3311, t, DEFAULT_RATE, 0.15), 1e-9)
  close(gapRows([OCT_CE], M, '2026-10-21', [{ movePct: 10, volPts: -10 }], {}, false, 0)[0]!.pnl, legPnl(OCT_CE, 3311, t, DEFAULT_RATE, 0.25), 1e-9)
})
test('gap rows: IV overrides apply with and without the vol change', () => {
  const open = Date.UTC(2026, 9, 21, 3, 45), t = yearsToExpiry('2026-10-27', open)
  const ov = { oc: 0.4 }
  close(gapRows([OCT_CE], M, '2026-10-21', [{ movePct: 0, volPts: 5 }], ov, true, 0)[0]!.pnl, legPnl(OCT_CE, 3000 * 3010 / 3000, t, DEFAULT_RATE, 0.45), 1e-9)
  close(gapRows([OCT_CE], M, '2026-10-21', [{ movePct: 0, volPts: 5 }], ov, false, 0)[0]!.pnl, legPnl(OCT_CE, 3010, t, DEFAULT_RATE, 0.4), 1e-9)
})
test('gap rows: an unreadable next day gives no rows, never NaN', () =>
  assert.deepEqual(gapRows([FUT], M, 'not-a-date', [{ movePct: 1, volPts: 0 }], {}, false, 0), []))
test('breakeven range of a short straddle', () => {
  const be = breakevenRange([leg('c', 'option', -175, 3000, 'CE', '2026-10-27', 60, 0.25), leg('p', 'option', -175, 3000, 'PE', '2026-10-27', 50, 0.27)],
    { spot: 3000, futures: { '2026-10-27': 3000 }, now: NOW }, '2026-10-27', {})
  close(be.low!, 2890, 1e-6); close(be.high!, 3110, 1e-6)
})
test('breakeven range is null on a side with no crossing', () => {
  const be = breakevenRange([leg('f', 'future', 175, null, null, '2026-10-27', 2900, null)], M, '2026-10-27', {})
  assert.equal(be.high, null); close(be.low!, 2900 * 3000 / 3010, 1e-6)
})
test('payoff curve: 121 points across ±10%', () => {
  const c = payoffCurve([FUT], M, '2026-10-19', '2026-10-27', {})
  assert.equal(c.length, 121); close(c[0]!.price, 2700, 1e-9); close(c[120]!.expiry, 54425, 1e-6)
})
test('Sensibull table rows, deduped and ordered', () => assert.deepEqual(
  payoffTable([FUT], M, '2026-10-19', '2026-10-27', [3100, 3000.004], {}).map((r) => r.label),
  ['-8%', '-5%', '-3%', '-2%', '-1%', 'spot', '+1%', '+2%', '+3%', 'target 3100', '+5%', '+8%']))
test('target labels drop trailing zeros', () =>
  assert.ok(payoffTable([FUT], M, '2026-10-19', '2026-10-27', [3100.5, 3200.123], {}).some((r) => r.label === 'target 3100.5')
    && payoffTable([FUT], M, '2026-10-19', '2026-10-27', [3200.123], {}).some((r) => r.label === 'target 3200.12')))

test('gap rows: a bad row is skipped, the others keep their numbers', () => {
  const good = { movePct: 10, volPts: -10 }
  const alone = gapRows([OCT_CE], M, '2026-10-21', [good], {}, true, 0)
  assert.equal(alone.length, 1)
  for (const bad of [{ movePct: -100, volPts: 0 }, { movePct: Number.NaN, volPts: 0 }, { movePct: 1, volPts: Number.NaN }]) {
    assert.deepEqual(gapRows([OCT_CE], M, '2026-10-21', [bad, good], {}, true, 0), alone)
  }
  // volPts is ignored (so cannot be bad) when useVol is false
  assert.equal(gapRows([OCT_CE], M, '2026-10-21', [{ movePct: 1, volPts: Number.NaN }], {}, false, 0).length, 1)
})

test('axes date loop: month end, no trading days, far end, the 60-date cap', () => {
  const m = scenarioAxes({ ...BASE, start: '2026-10-29', end: '2026-11-03', expiry: '2026-11-03' }) as Axes
  assert.deepEqual(m.labels, ['29 Oct', '30 Oct', '02 Nov', '03 Nov', 'Expiry'])
  const none = scenarioAxes({ ...BASE, isTradingDay: () => false }) as Axes
  assert.deepEqual(none.labels, ['Expiry'])
  const err = (x: unknown) => (x as { error: string }).error
  assert.match(err(scenarioAxes({ ...BASE, isTradingDay: () => false, end: '9999-12-31', expiry: '9999-12-31' })), /end/)
  const every = { ...BASE, isTradingDay: () => true }
  const ok = scenarioAxes({ ...every, end: '2026-12-17', expiry: '2026-12-17' }) as Axes // 60 days
  assert.equal(ok.columns.length, 61)
  assert.match(err(scenarioAxes({ ...every, end: '2026-12-18', expiry: '2026-12-18' })), /60/)
})
