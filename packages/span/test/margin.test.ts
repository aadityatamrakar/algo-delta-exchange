import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSpanFile, spanMargin } from '../src/index.ts'
import { spanKey } from '../src/index.ts'
import type { SpanCommodity, SpanContract, SpanFile, SpanPosition, SpanSpread, SpanTier } from '../src/index.ts'
import { read } from './_helpers.ts'

const MINI = parseSpanFile(read('mini.spn'))
const ELM = new Map([['TCS', 0.035]])
const OCT = '2026-10-27'
const NOV = '2026-11-23'
const close = (a: number, b: number, tol: number): void => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`)
const pos = (kind: 'future' | 'option', expiry: string, strike: number | null, optType: 'CE' | 'PE' | null, qty: number): SpanPosition =>
  ({ symbol: 'TCS', kind, expiry, strike, optType, qty })

test('scanning risk is the worst of 16 scenarios', () => {
  const r = spanMargin([pos('future', OCT, null, null, 100)], MINI, ELM)
  assert.deepEqual([r.scanningRisk, r.worstScenario], [7000, 13])
})
test('a short call offsets a long future', () =>
  assert.equal(spanMargin([pos('future', OCT, null, null, 100), pos('option', OCT, 3000, 'CE', -100)], MINI, ELM).scanningRisk, 4200))
test('calendar spread: scan + inter-month charge, exposure 1/3 on the far leg', () => {
  const r = spanMargin([pos('future', OCT, null, null, 100), pos('future', NOV, null, null, -100)], MINI, ELM)
  close(r.scanningRisk, 70, 1e-9); assert.equal(r.worstScenario, 14); close(r.interMonthSpread, 300, 1e-9)
  close(r.initial, 370, 1e-9); close(r.exposure, 3535, 1e-6)                 // 100 × 3030 × 0.035 / 3
})
test('the short option minimum floors SPAN', () => {
  const r = spanMargin([pos('option', OCT, 3000, 'PE', -350)], MINI, ELM)
  assert.deepEqual([r.scanningRisk, r.shortOptionMinimum, r.initial], [175, 525, 525])
})
test('net option value is reported, not netted', () => {
  const r = spanMargin([pos('option', OCT, 3000, 'CE', 100), pos('option', OCT, 3000, 'PE', -350)], MINI, ELM)
  assert.equal(r.netOptionValue, 6000 - 17500); assert.equal(r.initial, Math.max(r.scanningRisk + r.interMonthSpread, r.shortOptionMinimum))
})
test('exposure: futures and short options; long options none', () => {
  close(spanMargin([pos('future', OCT, null, null, 175)], MINI, ELM).exposure, 18436.25, 1e-6)   // 175 × 3010 × 0.035
  close(spanMargin([pos('option', OCT, 3000, 'CE', -175)], MINI, ELM).exposure, 18436.25, 1e-6)
  assert.equal(spanMargin([pos('option', OCT, 3000, 'CE', 175)], MINI, ELM).exposure, 0)
})
test('a contract not in the file is named and not counted', () => {
  const r = spanMargin([pos('future', '2026-12-29', null, null, 100)], MINI, ELM)
  assert.deepEqual([r.missing, r.initial], [['future|2026-12-29||'], 0])
})
test('no ELM rate for the symbol is named', () =>
  assert.ok(spanMargin([pos('future', OCT, null, null, 100)], MINI, new Map()).missing.includes('exposure rate for TCS')))

test('no positions: all zeros, nothing missing', () => {
  const r = spanMargin([], MINI, ELM)
  assert.deepEqual(r, {
    scanningRisk: 0, worstScenario: 0, interMonthSpread: 0, shortOptionMinimum: 0, netOptionValue: 0,
    initial: 0, exposure: 0, total: 0, missing: [],
  })
})
test('a symbol with no commodity in the file is named and contributes nothing', () => {
  const r = spanMargin([{ symbol: 'ZZZ', kind: 'future', expiry: OCT, strike: null, optType: null, qty: 10 }], MINI, ELM)
  assert.deepEqual([r.missing, r.total], [['future|2026-10-27||'], 0])
})
test('a short option with no same-month future is named for exposure only', () => {
  const noFut = parseSpanFile(read('mini.spn').replace(/<futPf>[\s\S]*?<\/futPf>/, ''))
  const r = spanMargin([pos('option', OCT, 3000, 'CE', -100)], noFut, ELM)
  assert.deepEqual([r.missing, r.exposure], [['exposure base for option|2026-10-27|3000|CE'], 0])
  assert.equal(r.scanningRisk, 2800)
})
test('total is initial plus exposure', () => {
  const r = spanMargin([pos('future', OCT, null, null, 100)], MINI, ELM)
  close(r.total, r.initial + r.exposure, 1e-9)
})

// small hand-built files: zero risk arrays so only the spread / exposure logic is under test
const ZERO = new Array<number>(16).fill(0)
function fut(period: string, price: number): [string, SpanContract] {
  return [spanKey('future', period, null, null), { kind: 'future', period, strike: null, optType: null, price, delta: 1, riskArray: ZERO }]
}
function build(tcs: Partial<SpanCommodity>, futures: [string, SpanContract][]): SpanFile {
  const c: SpanCommodity = { symbol: 'TCS', contracts: new Map(futures), tiers: [], spreads: [], somRate: 0, ...tcs }
  return { businessDate: '2026-10-19', settlement: true, created: null, commodities: new Map([['TCS', c]]) }
}
const M1 = '2026-10-27'
const M2 = '2026-11-24'
const M3 = '2026-12-29'
const tier = (n: number, m: string): SpanTier => ({ tier: n, startMonth: m, endMonth: m })
const leg = (t: number, side: 'A' | 'B'): SpanSpread['legs'][number] => ({ tier: t, period: null, side, ratio: 1 })
const pleg = (period: string, side: 'A' | 'B'): SpanSpread['legs'][number] => ({ tier: null, period, side, ratio: 1 })
const THREE = [fut(M1, 3000), fut(M2, 3100), fut(M3, 3200)]
const TIERS = [tier(1, '2026-10'), tier(2, '2026-11'), tier(3, '2026-12')]

test('a non-finite quantity is named and contributes nothing; zero is skipped quietly', () => {
  const r = spanMargin([pos('future', OCT, null, null, Number.NaN), pos('future', NOV, null, null, Infinity), pos('future', OCT, null, null, 0)], MINI, ELM)
  assert.deepEqual(r.missing, ['bad quantity: future|2026-10-27||', 'bad quantity: future|2026-11-23||'])
  assert.deepEqual([r.total, r.scanningRisk], [0, 0])
})
test('a NaN or negative ELM rate is treated as absent', () => {
  for (const bad of [Number.NaN, -0.01, Infinity]) {
    const r = spanMargin([pos('future', OCT, null, null, 100)], MINI, new Map([['TCS', bad]]))
    assert.ok(r.missing.includes('exposure rate for TCS'))
    assert.equal(r.exposure, 0)
    for (const v of [r.scanningRisk, r.initial, r.exposure, r.total]) assert.ok(Number.isFinite(v))
  }
})
test("period legs (NSE's pLeg) match one expiry date exactly, two in one month apart", () => {
  const D1 = '2026-10-27', D2 = '2026-10-29'
  const f = build({ spreads: [{ priority: 1, rate: 3, legs: [pleg(D1, 'A'), pleg(D2, 'B')] }] }, [fut(D1, 3000), fut(D2, 3000)])
  // long 100 on the 27th, short 60 on the 29th: 60 pair off at 3 = 180; by month they would be one tier and charge nothing
  assert.equal(spanMargin([pos('future', D1, null, null, 100), pos('future', D2, null, null, -60)], f, ELM).interMonthSpread, 180)
  assert.equal(spanMargin([pos('future', D1, null, null, 100), pos('future', D2, null, null, 60)], f, ELM).interMonthSpread, 0)
})
test('same-sign tier deltas carry no inter-month charge', () => {
  const f = build({ tiers: TIERS, spreads: [{ priority: 1, rate: 3, legs: [leg(1, 'A'), leg(2, 'B')] }] }, THREE)
  assert.equal(spanMargin([pos('future', M1, null, null, 100), pos('future', M2, null, null, 100)], f, ELM).interMonthSpread, 0)
})
test('spreads run in priority order; the second charges only the remainder', () => {
  const f = build({
    tiers: TIERS,
    spreads: [   // listed out of order on purpose
      { priority: 2, rate: 5, legs: [leg(1, 'A'), leg(3, 'B')] },
      { priority: 1, rate: 3, legs: [leg(1, 'A'), leg(2, 'B')] },
    ],
  }, THREE)
  // long 100 M1, short 60 M2, short 80 M3: spread 1 matches 60 (60 × 3 = 180), leaves 40 long; spread 2 matches 40 (40 × 5 = 200)
  const r = spanMargin([pos('future', M1, null, null, 100), pos('future', M2, null, null, -60), pos('future', M3, null, null, -80)], f, ELM)
  close(r.interMonthSpread, 380, 1e-9)
})
test('two lines of the same contract are netted', () => {
  const both = spanMargin([pos('future', OCT, null, null, 100), pos('future', OCT, null, null, -40)], MINI, ELM)
  const one = spanMargin([pos('future', OCT, null, null, 60)], MINI, ELM)
  assert.deepEqual(both, one)
  assert.equal(one.scanningRisk, 60 * 70)
})
test('three months of futures: greedy pairing, far leg of each pair at 1/3', () => {
  const f = build({}, THREE)
  const e = new Map([['TCS', 0.1]])
  // long 100 M1, short 150 M2, long 50 M3. Pair M1/M2: 100 matched, far = M2: 100 × 3100 × 0.1 / 3.
  // Pair M3/M2: 50 matched, far = M3: 50 × 3200 × 0.1 / 3. Nothing left over.
  // (31000 + 16000) / 3 = 15666.67
  const r = spanMargin([pos('future', M1, null, null, 100), pos('future', M2, null, null, -150), pos('future', M3, null, null, 50)], f, e)
  close(r.exposure, 47000 / 3, 1e-6)
})
