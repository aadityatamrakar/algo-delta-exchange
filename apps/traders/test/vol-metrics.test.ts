/** vol-metrics: IV rank/percentile, HV, VRP and realized VRP by hand-computed series; the chain summary on a synthetic smile. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import type { DailyBar } from '../src/analytics/context-wire.ts'
import { summarizeChain, volMetrics, type RawVolStock, type StrikeRow, type VolDay } from '../src/analytics/vol-metrics.ts'

const close = (a: number, b: number, tol = 1e-9): void => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b} (±${tol})`)

/** n weekdays from Mon 5 Jan 2026. */
function weekdays(n: number): string[] {
  const out: string[] = []
  for (let d = Date.UTC(2026, 0, 5); out.length < n; d += 86_400_000) {
    const wd = new Date(d).getUTCDay()
    if (wd !== 0 && wd !== 6) out.push(new Date(d).toISOString().slice(0, 10))
  }
  return out
}

/** Closes whose log returns alternate +1%, −1%: any 20 consecutive returns have mean 0 and a known stdev. */
function alternating(n: number): number[] {
  const out = [100]
  for (let i = 1; i < n; i++) out.push((out[i - 1] as number) * Math.exp(i % 2 === 1 ? 0.01 : -0.01))
  return out
}

function bars(ivs: readonly (number | null)[], closes: readonly number[] = alternating(ivs.length)): DailyBar[] {
  const ds = weekdays(ivs.length)
  return ivs.map((iv, i) => ({
    date: ds[i] as string, open: 0, high: 0, low: 0, close: closes[i] as number, volume: 0,
    futClose: null, futOi: null, ceOi: null, peOi: null, atmIv: iv, maxPain: null,
  }))
}

const lastDate = (b: readonly DailyBar[]): string => (b[b.length - 1] as DailyBar).date
/** stdev of 10 × +1% and 10 × −1% (mean 0), annualised: the HV20 of any alternating stretch. */
const H20 = Math.sqrt((20 * 1e-4 / 19) * 252)
const H10 = Math.sqrt((10 * 1e-4 / 9) * 252)

const day = (over: Partial<VolDay> & { date: string }): VolDay => ({
  nearExpiry: '2026-11-23', nextExpiry: '2026-12-29', rolled: false, atmStrike: 2500, nearIv: null, nearIvSource: null,
  nextIv: null, skew25: null, spot: null, future: null, nseHv: null, notes: [], ...over,
})

test('IV rank and percentile need 60 days: 59 is null with the count, 60 is the hand figure', () => {
  const ivs = [...Array.from({ length: 59 }, (_, i) => 0.20 + 0.001 * i), 0.2295]
  const sixty = bars(ivs)
  const m = volMetrics(sixty, [], lastDate(sixty))
  assert.equal(m.ivDays, 60)
  assert.equal(m.iv, 0.2295)
  assert.equal(m.ivSource, 'bhavcopy')
  close(m.ivRank as number, (0.2295 - 0.20) / (0.258 - 0.20) * 100)   // 50.86
  close(m.ivPercentile as number, 30 / 60 * 100)                       // 0.200…0.229 are below: 30 of the 60 days
  const fiftyNine = bars(ivs.slice(1))
  const n = volMetrics(fiftyNine, [], lastDate(fiftyNine))
  assert.deepEqual([n.ivDays, n.ivRank, n.ivPercentile], [59, null, null])
  assert.ok(n.warnings.includes('IV rank needs 60 days of IV; 59 held'), n.warnings.join(' | '))
})

test('flat IV has no rank, and no day below it', () => {
  const b = bars(Array.from({ length: 70 }, () => 0.25))
  const m = volMetrics(b, [], lastDate(b))
  assert.equal(m.ivRank, null)
  assert.equal(m.ivPercentile, 0)
  assert.ok(m.warnings.includes('IV flat over 70 days: no rank'), m.warnings.join(' | '))
})

test('the window is the last 252 trading days: an older extreme does not count', () => {
  const ivs = Array.from({ length: 300 }, () => 0.30)
  ivs[0] = 0.90      // outside the window (bars 48…299)
  ivs[100] = 0.10    // inside
  ivs[299] = 0.25
  const b = bars(ivs)
  const m = volMetrics(b, [], lastDate(b))
  assert.equal(m.ivDays, 252)
  close(m.ivRank as number, 75)                  // (0.25 − 0.10) / (0.30 − 0.10)
  close(m.ivPercentile as number, 1 / 252 * 100)
})

test('HV10 and HV20 are close-to-close × √252; 20 closes are too few for HV20', () => {
  const b = bars(Array.from({ length: 30 }, () => 0.3))
  const m = volMetrics(b, [], lastDate(b))
  close(m.hv20 as number, H20, 1e-12)
  close(m.hv10 as number, H10, 1e-12)
  close(m.vrp as number, 0.3 - H20, 1e-12)
  close(m.vrpRatio as number, 0.3 / H20, 1e-9)
  const short = bars(Array.from({ length: 20 }, () => 0.3))
  const s = volMetrics(short, [], lastDate(short))
  assert.equal(s.hv20, null)
  assert.equal(s.vrp, null)
  assert.ok(s.warnings.includes('HV20 needs 21 closes; 20 held'), s.warnings.join(' | '))
})

test('realized VRP over a known series: IV 30% then 2% against a realized ~5.15%', () => {
  // 100 days; pairs t = 0…79 (t + 20 ≤ 99); every 20-day realized vol is H20
  const b = bars(Array.from({ length: 100 }, (_, t) => (t < 50 ? 0.30 : 0.02)))
  const r = volMetrics(b, [], lastDate(b)).realizedVrp
  assert.ok(r !== null)
  assert.equal(r.days, 80)
  close(r.positivePct, 62.5)                                   // 50 of 80
  close(r.mean, (50 * (0.30 - H20) + 30 * (0.02 - H20)) / 80, 1e-12)
  close(r.median, 0.30 - H20, 1e-12)                            // 30 negatives sort first; the 40th and 41st are positive
})

test('realized VRP needs 60 pairs: 79 days give 59', () => {
  const b = bars(Array.from({ length: 79 }, () => 0.3))
  const m = volMetrics(b, [], lastDate(b))
  assert.equal(m.realizedVrp, null)
  assert.ok(m.warnings.includes('realized VRP needs 60 days; 59 held'), m.warnings.join(' | '))
  const b80 = bars(Array.from({ length: 80 }, () => 0.3))
  assert.equal(volMetrics(b80, [], lastDate(b80)).realizedVrp?.days, 60)
})

test('VRP percentile: today\'s VRP against the window\'s', () => {
  // VRP(t) = IV(t) − H20 for t = 20…99 (80 values); today's IV 25.05% beats t = 20…50's
  const ivs = Array.from({ length: 100 }, (_, t) => 0.20 + 0.001 * t)
  ivs[99] = 0.2505
  const b = bars(ivs)
  const m = volMetrics(b, [], lastDate(b))
  assert.equal(m.vrpDays, 80)
  close(m.vrpPercentile as number, 31 / 80 * 100)
})

test('a chain snapshot\'s IV is that day\'s IV; the rest of the row comes from the as-of day\'s snapshot', () => {
  const ivs = [...Array.from({ length: 59 }, (_, i) => 0.20 + 0.001 * i), 0.22]
  const b = bars(ivs)
  const asOf = lastDate(b)
  const earlier = (b[10] as DailyBar).date
  const days = [
    day({ date: earlier, nearIv: 0.40, nearIvSource: 'nse' }),   // replaces bar 10's 0.21: the new max
    day({ date: asOf, nearIv: 0.25, nearIvSource: 'nse', nextIv: 0.26, skew25: 0.05, nseHv: 0.31 }),
  ]
  const m = volMetrics(b, days, asOf)
  assert.deepEqual([m.asOf, m.iv, m.ivSource, m.nearExpiry, m.nearIv, m.nextExpiry, m.nextIv, m.skew25, m.nseHv],
    [asOf, 0.25, 'nse', '2026-11-23', 0.25, '2026-12-29', 0.26, 0.05, 0.31])
  close(m.ivRank as number, (0.25 - 0.20) / (0.40 - 0.20) * 100)
  assert.ok(m.warnings.includes('NSE ATM IV 25.0% vs bhavcopy 22.0%'), m.warnings.join(' | '))
})

test('a snapshot newer than the last bar still gives the IV, and says the closes stop short', () => {
  const b = bars(Array.from({ length: 30 }, () => 0.3))
  const m = volMetrics(b, [day({ date: '2026-03-02', nearIv: 0.33, nearIvSource: 'bhavcopy' })], '2026-03-02')
  assert.deepEqual([m.asOf, m.iv, m.ivSource], ['2026-03-02', 0.33, 'bhavcopy'])
  close(m.hv20 as number, H20, 1e-12)
  assert.ok(m.warnings.includes(`no close for 2026-03-02: HV ends ${lastDate(b)}`), m.warnings.join(' | '))
})

test('bars after today are ignored; no data at all is all null and says so', () => {
  const b = bars(Array.from({ length: 30 }, () => 0.3))
  assert.equal(volMetrics(b, [], (b[24] as DailyBar).date).asOf, (b[24] as DailyBar).date)
  const none = volMetrics([], [], '2026-10-22')
  assert.deepEqual([none.asOf, none.iv, none.hv20, none.ivRank, none.realizedVrp, none.ivDays], [null, null, null, null, null, 0])
  assert.deepEqual(none.warnings, ['no end-of-day history or chain snapshot'])
})

// ------------------------------------------------------------------ chain summary

const DATE = '2026-10-22'
const T = 32 / 365   // 15:30 IST 22 Oct → 15:30 IST 23 Nov
const F = 1000

/** A synthetic smile: puts below the future at 30%, calls above at 20%, the 1000 strike at 25%; every close traded. */
function smile(nseAtm: [number | null, number | null] = [null, null]): StrikeRow[] {
  const rows: StrikeRow[] = []
  for (let k = 800; k <= 1200; k += 10) {
    const price = (type: 'CE' | 'PE', vol: number): number => b76Price({ future: F, strike: k, t: T, vol, rate: DEFAULT_RATE, type })
    if (k === 1000) rows.push([k, price('CE', 0.25), price('PE', 0.25), nseAtm[0], nseAtm[1]])
    else if (k < 1000) rows.push([k, null, price('PE', 0.30), null, null])
    else rows.push([k, price('CE', 0.20), null, null, null])
  }
  return rows
}

const stock = (strikes: StrikeRow[], future: number | null = F): RawVolStock => ({
  spot: 998, sources: ['bhavcopy'], errors: [],
  near: { expiry: '2026-11-23', rolled: true, future, strikes },
  next: { expiry: '2026-12-29', rolled: true, future: 1005, strikes: [[1000, null, null, 0.24, 0.26]] },
})

test('ATM IV is solved from the closes against the future when NSE gives no IV', () => {
  const d = summarizeChain(DATE, stock(smile()), 0.3458)
  assert.deepEqual([d.date, d.nearExpiry, d.nextExpiry, d.rolled, d.atmStrike, d.nearIvSource, d.future, d.spot, d.nseHv],
    [DATE, '2026-11-23', '2026-12-29', true, 1000, 'bhavcopy', F, 998, 0.3458])
  close(d.nearIv as number, 0.25, 1e-5)
  close(d.nextIv as number, 0.25, 1e-12)   // NSE's mean of 24% and 26%
})

test('ATM IV is NSE\'s CE/PE mean when both are there', () => {
  const d = summarizeChain(DATE, stock(smile([0.21, 0.27])), null)
  assert.equal(d.nearIvSource, 'nse')
  close(d.nearIv as number, 0.24, 1e-12)
})

test('the 25-delta skew is the put\'s solved IV less the call\'s', () => {
  const d = summarizeChain(DATE, stock(smile()), null)
  close(d.skew25 as number, 0.10, 1e-4)
})

test('no future close: no skew, and a note says why; no chain at all is an empty day', () => {
  const d = summarizeChain(DATE, stock(smile(), null), null)
  assert.equal(d.skew25, null)
  assert.ok(d.notes.includes('skew needs the near future\'s close'), d.notes.join(' | '))
  close(d.nearIv as number, 0.25, 1e-5)   // ATM found off the spot; solved off put-call parity at the strike
  const e = summarizeChain(DATE, null, 0.2)
  assert.deepEqual([e.nearIv, e.nextIv, e.skew25, e.nseHv, e.nearExpiry], [null, null, null, 0.2, null])
})
