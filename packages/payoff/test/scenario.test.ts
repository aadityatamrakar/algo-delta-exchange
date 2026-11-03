/**
 * The scenario function: any set of legs, priced at any (spot, instant, vol shift),
 * every option on its own month's future and tenor, with vanna and volga.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76SecondOrder, b76Greeks, yearsToExpiry, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE, legPnl, type PayoffLeg } from '../src/legs.ts'
import {
  scenario,
  legPoints,
  valuationAt,
  forwardAt,
  ivUsed,
  istDay,
  type ScenarioMarket,
} from '../src/scenario.ts'

const NOW = Date.UTC(2026, 9, 19, 4, 30) // Mon 10:00 IST
const OCT = '2026-10-27'
const NOV = '2026-11-23'

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

const M: ScenarioMarket = { spot: 3000, futures: { [OCT]: 3010, [NOV]: 3030 }, now: NOW }
const SHARE = leg('s', 'future', 1000, null, null, '', 2950, null)
const FUT = leg('f', 'future', 175, null, null, OCT, 3000, null)
const OCT_CE = leg('oc', 'option', -175, 3000, 'CE', OCT, 50, 0.25)
const NOV_CE = leg('nc', 'option', 175, 3000, 'CE', NOV, 80, 0.22)
const OCT_PE = leg('op', 'option', -175, 2900, 'PE', OCT, 30, 0.27)
const NOW_PT = valuationAt('2026-10-19', NOW, 'time')!

test('share and future legs are linear in spot', () => {
  const c = scenario([SHARE, FUT], M, [3030], [NOW_PT], {}).cells[0]![0]!
  close(c.pnl, 1000 * 80 + 175 * ((3010 * 3030) / 3000 - 3000), 1e-6)
  assert.equal(c.delta, 1175)
  assert.deepEqual([c.gamma, c.vega, c.theta, c.vanna, c.volga], [0, 0, 0, 0, 0])
})

test('each option prices off its own month future and tenor', () => {
  const c = scenario([OCT_CE, NOV_CE], M, [3000], [NOW_PT], {}).cells[0]![0]!
  close(
    c.pnl,
    legPnl(OCT_CE, 3010, yearsToExpiry(OCT, NOW)) + legPnl(NOV_CE, 3030, yearsToExpiry(NOV, NOW)),
    1e-9,
  )
})

test('valuation instants: today is now; later dates keep the time of day; open and close', () => {
  assert.deepEqual(valuationAt('2026-10-22', NOW, 'time'), {
    date: '2026-10-22',
    ms: Date.UTC(2026, 9, 22, 4, 30),
  })
  assert.equal(
    valuationAt('2026-10-22', Date.UTC(2026, 9, 19, 11, 30), 'time')!.ms,
    Date.UTC(2026, 9, 22, 10, 10),
  ) // 17:00 IST clamps to the 15:40 F&O close
  assert.equal(valuationAt('2026-10-21', NOW, 'open')!.ms, Date.UTC(2026, 9, 21, 3, 45))
  assert.equal(valuationAt('2026-10-27', NOW, 'close')!.ms, Date.UTC(2026, 9, 27, 10, 10))
  assert.equal(valuationAt('2026-10-18', NOW, 'time'), null)
  assert.equal(valuationAt('2026-13-40', NOW, 'time'), null)
  assert.equal(valuationAt('nope', NOW, 'close'), null)
  assert.equal(istDay(Date.UTC(2026, 9, 19, 19, 0)), '2026-10-20') // 00:30 IST next day
})

test('a later date prices at its own instant', () => {
  const pt = valuationAt('2026-10-22', NOW, 'time')!
  const c = scenario([OCT_CE, NOV_CE], M, [3000], [pt], {}).cells[0]![0]!
  close(
    c.pnl,
    legPnl(OCT_CE, 3010, yearsToExpiry(OCT, pt.ms)) + legPnl(NOV_CE, 3030, yearsToExpiry(NOV, pt.ms)),
    1e-9,
  )
})

test('forwardAt scales each month with spot; optionFutures is the option basis', () => {
  close(forwardAt(M, OCT, 3300, 'future'), 3010 * 1.1, 1e-9)
  assert.equal(forwardAt(M, '', 3300, 'future'), 3300)
  assert.equal(forwardAt(M, '2027-01-01', 3300, 'option'), 3300) // missing month -> spot
  const m2: ScenarioMarket = { ...M, optionFutures: { [OCT]: 3020 } }
  close(forwardAt(m2, OCT, 3000, 'option'), 3020, 1e-12)
  close(forwardAt(m2, OCT, 3000, 'future'), 3010, 1e-12)
})

test('shifts apply by side; an override replaces the base before the shifts', () => {
  const p = legPoints([OCT_CE, OCT_PE], M, { spot: 3000, point: NOW_PT }, {
    callVolShift: 2,
    volShift: 1,
    ivOverrides: { oc: 0.3 },
  })
  close(p[0]!.iv!, 0.33, 1e-12)
  close(p[1]!.iv!, 0.28, 1e-12)
  assert.equal(ivUsed(FUT, { volShift: 5 }), null)
})

test('vanna and volga are b76SecondOrder x qty', () => {
  const t = yearsToExpiry(OCT, NOW)
  const inp = { future: 3010, strike: 3000, t, vol: 0.25, rate: DEFAULT_RATE, type: 'CE' as const }
  const so = b76SecondOrder(inp)
  const g = b76Greeks(inp)
  assert.notEqual(so.vanna, 0)
  const c = scenario([OCT_CE], M, [3000], [NOW_PT], {}).cells[0]![0]!
  close(c.vanna, -175 * so.vanna, 1e-9)
  close(c.volga, -175 * so.volga, 1e-9)
  close(c.delta, -175 * g.delta, 1e-9)
  close(c.vega, -175 * g.vega, 1e-9)
  close(c.theta, -175 * g.theta, 1e-9)
  close(c.gamma, -175 * g.gamma, 1e-12)
  const [p] = legPoints([OCT_CE], M, { spot: 3000, point: NOW_PT }, {})
  close(p!.vanna, so.vanna, 1e-12) // per share
})

test('a shift through zero floors IV at 0.0001 and warns', () => {
  const r = scenario([OCT_CE], M, [3000], [NOW_PT], { volShift: -30 })
  const [p] = legPoints([OCT_CE], M, { spot: 3000, point: NOW_PT }, { volShift: -30 })
  assert.equal(p!.iv, 0.0001)
  assert.ok(r.warnings.some((w) => w.includes('oc') && w.includes('0.0001')))
  assert.ok(Object.values(r.cells[0]![0]!).every(Number.isFinite))
})

test('an option with no IV contributes nothing and is named', () => {
  const NOIV = leg('nv', 'option', -175, 3100, 'CE', OCT, 12, null)
  const r = scenario([NOIV], M, [3200], [NOW_PT], {})
  const c = r.cells[0]![0]!
  assert.deepEqual(c, { pnl: 0, delta: 0, gamma: 0, vega: 0, theta: 0, vanna: 0, volga: 0 })
  assert.ok(r.warnings.some((w) => w.includes('nv')))
  // an override supplies the missing IV
  const r2 = scenario([NOIV], M, [3200], [NOW_PT], { ivOverrides: { nv: 0.3 } })
  assert.notEqual(r2.cells[0]![0]!.pnl, 0)
})

test('a month with no future prices off spot and warns', () => {
  const r = scenario([OCT_CE], { ...M, futures: {} }, [3000], [NOW_PT], {})
  assert.ok(r.warnings.some((w) => w.includes(OCT)))
  close(r.cells[0]![0]!.pnl, legPnl(OCT_CE, 3000, yearsToExpiry(OCT, NOW)), 1e-9)
})

test('cells are indexed [spot][point]', () => {
  const pt2 = valuationAt(OCT, NOW, 'close')!
  const r = scenario([OCT_CE], M, [2900, 3000, 3100], [NOW_PT, pt2], {})
  assert.equal(r.cells.length, 3)
  assert.equal(r.cells[0]!.length, 2)
  assert.deepEqual(r.spots, [2900, 3000, 3100])
  // at the close of expiry the short call is worth intrinsic only
  close(r.cells[2]![1]!.pnl, -175 * (Math.max(3010 * 3100 / 3000 - 3000, 0) * Math.exp(0) - 50), 1e-6)
})

test('junk spot gives empty cells and a warning, never NaN', () => {
  for (const s of [NaN, 0, -1]) {
    const r = scenario([FUT], { ...M, spot: s }, [3000], [NOW_PT], {})
    assert.deepEqual(r.cells, [])
    assert.ok(r.warnings.length > 0)
  }
  const r = scenario([FUT], M, [3000, NaN], [NOW_PT], {})
  assert.deepEqual(r.cells, [])
  assert.ok(r.warnings.length > 0)
})

function allFinite(p: object): boolean {
  return Object.entries(p).every(([k, v]) => k === 'id' || v === null || Number.isFinite(v))
}

test('an option that cannot be priced is left out with a warning naming it', () => {
  const NOTYPE = leg('nt', 'option', -175, 3000, null, OCT, 50, 0.25)
  const NOSTRIKE = leg('ns', 'option', -175, null, 'CE', OCT, 50, 0.25)
  const ZEROSTRIKE = leg('zs', 'option', -175, 0, 'CE', OCT, 50, 0.25)
  const r = scenario([NOTYPE, NOSTRIKE, ZEROSTRIKE, OCT_CE], M, [3000], [NOW_PT], {})
  for (const id of ['nt', 'ns', 'zs']) {
    assert.ok(r.warnings.some((w) => w.includes(id) && w.includes('cannot be priced')), id)
  }
  assert.ok(!r.warnings.some((w) => w.startsWith('oc')))
  close(r.cells[0]![0]!.pnl, legPnl(OCT_CE, 3010, yearsToExpiry(OCT, NOW)), 1e-9)
})

test('a summed cell that overflows is zeroed and warned once', () => {
  const A = leg('a', 'future', 1e308, null, null, '', 3000, null)
  const B = leg('b', 'future', 1e308, null, null, '', 3000, null)
  const r = scenario([A, B], M, [3000], [NOW_PT], {})
  assert.ok(r.cells.every((row) => row.every(allFinite)))
  assert.equal(r.warnings.filter((w) => w.includes('overflowed')).length, 1)
  const huge = scenario([OCT_CE, FUT], M, [1e308], [NOW_PT], {})
  assert.ok(huge.cells.flat().every(allFinite))
  assert.ok(huge.warnings.length > 0)
})

test('legPoints never returns a non-finite number, whatever it is given', () => {
  const legs = [OCT_CE, OCT_PE, FUT, SHARE]
  const pt = { point: NOW_PT }
  const runs = [
    legPoints(legs, M, { spot: NaN, ...pt }, {}),
    legPoints(legs, M, { spot: 0, ...pt }, {}),
    legPoints(legs, M, { spot: -5, ...pt }, {}),
    legPoints(legs, M, { spot: Infinity, ...pt }, {}),
    legPoints(legs, M, { spot: 1e308, ...pt }, {}),
    legPoints(legs, { ...M, spot: NaN }, { spot: 3000, ...pt }, {}),
    legPoints(legs, { ...M, spot: 0 }, { spot: 3000, ...pt }, {}),
    legPoints(legs, { ...M, futures: { [OCT]: Infinity } }, { spot: 3000, ...pt }, {}),
    legPoints([leg('e', 'option', -175, 3000, 'CE', OCT, NaN, 0.25), leg('g', 'future', 1, null, null, OCT, NaN, null)], M, { spot: 3000, ...pt }, {}),
    legPoints(legs, M, { spot: 3000, point: { date: 'x', ms: NaN } }, {}),
    legPoints(legs, M, { spot: 3000, ...pt }, { volShift: NaN, callVolShift: Infinity }),
  ]
  for (const pts of runs) {
    assert.ok(pts.length >= 2)
    for (const p of pts) assert.ok(allFinite(p), JSON.stringify(p))
  }
  const [inertPt] = legPoints([OCT_CE], M, { spot: NaN, ...pt }, {})
  assert.equal(inertPt!.pnl, 0)
  assert.equal(inertPt!.delta, 0)
})

test('istDay and valuationAt do not throw on junk instants', () => {
  for (const ms of [NaN, Infinity, 9e15, -9e15]) {
    assert.equal(istDay(ms), '')
    assert.equal(valuationAt('2026-10-22', ms, 'time'), null)
    assert.equal(valuationAt('2026-10-22', ms, 'close'), null)
  }
  assert.equal(valuationAt('0000-01-01', NOW, 'time'), null)
})
