import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE_STRENGTH, IV_RANK_MIN_DAYS, MAX_LEVELS, atr, dayStatsOf, hv, ivStatsOf, levelsOf, mergeLevels, nearestOf, pivotsOf,
  roundStepOf, sma, swingsOf, trendOf, type Candidate,
} from '../src/analytics/levels.ts'
import type { Bar, DailyBar } from '../src/analytics/context-wire.ts'

const close = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

/** A daily bar with only the price fields that matter; dates count up from 1 Jan 2026. */
function day(i: number, high: number, low: number, closePx: number, extra: Partial<DailyBar> = {}): DailyBar {
  const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
  return {
    date, open: closePx, high, low, close: closePx, volume: 0, futClose: null, futOi: null, ceOi: null, peOi: null,
    atmIv: null, maxPain: null, ...extra,
  }
}
const closes = (xs: readonly number[]): DailyBar[] => xs.map((c, i) => day(i, c, c, c))

test('sma: the mean of the last n closes; null under n', () => {
  const xs = Array.from({ length: 25 }, (_, i) => i + 1)
  assert.equal(sma(xs, 20), 15.5)   // 6..25
  assert.equal(sma(xs, 25), 13)
  assert.equal(sma(xs, 26), null)
})

test('atr: Wilder — the mean of the first n true ranges, then (prev × (n−1) + TR) / n', () => {
  const bars = [day(0, 10, 8, 9), day(1, 11, 9, 10), day(2, 12, 9.5, 11.5), day(3, 11, 10, 10.5), day(4, 14, 13, 13.5)]
  // true ranges: 2 (h−l), 2.5 (h−l), 1.5 (|l − prev c|), 3.5 (|h − prev c|, a gap)
  assert.equal(atr(bars, 4), (2 + 2.5 + 1.5 + 3.5) / 4)
  const more = [...bars, day(5, 14, 12, 12.5)]   // TR 2
  assert.equal(atr(more, 4), (2.375 * 3 + 2) / 4)
  assert.equal(atr(bars, 5), null, 'five true ranges need six bars')
  assert.equal(atr(bars), null, 'ATR14 needs 15 bars')
})

test('hv: sample stdev of close-to-close log returns × √252', () => {
  const xs = [100, 110, 99, 108.9]
  // returns ln 1.1, ln 0.9, ln 1.1
  const r = [Math.log(1.1), Math.log(0.9), Math.log(1.1)]
  const mean = (r[0]! + r[1]! + r[2]!) / 3
  const variance = ((r[0]! - mean) ** 2 + (r[1]! - mean) ** 2 + (r[2]! - mean) ** 2) / 2
  close(hv(xs, 3) as number, Math.sqrt(variance) * Math.sqrt(252))
  close(hv(xs, 3) as number, 1.83918, 1e-5)
  assert.equal(hv(xs, 4), null, 'four returns need five closes')
  close(hv(xs.slice(1), 2) as number, Math.abs(Math.log(0.9) - Math.log(1.1)) / Math.SQRT2 * Math.sqrt(252))
})

test('pivots: classic, off the previous day', () => {
  // P = (112 + 88 + 103) / 3 = 101
  assert.deepEqual(pivotsOf({ high: 112, low: 88, close: 103 }), { p: 101, r1: 114, s1: 90, r2: 125, s2: 77, r3: 138, s3: 66 })
})

test('swings: a fractal high or low beats the 2 bars either side, most recent first', () => {
  const highs = [10, 11, 15, 12, 11, 13, 18, 14, 13, 12, 17, 16]
  const bars = highs.map((h, i) => day(i, h, h - 5, h - 1))
  const s = swingsOf(bars)
  // 15 (i=2) and 18 (i=6) are fractal highs; 17 (i=10) has only one bar after it
  assert.deepEqual(s.highs.map((x) => x.price), [18, 15])
  assert.equal(s.highs[0]!.date, bars[6]!.date)
  // lows are h − 5: 5 at i=0 has no two bars before; 6 (i=4) is below 10, 7 and 8, 13; 7 (i=9) below 9, 8 and 12, 11
  assert.deepEqual(s.lows.map((x) => x.price), [7, 6])
})

test('round step: 1-2-5 at or below price / 40', () => {
  assert.deepEqual([2505, 22711, 357, 1184, 100, 54961].map(roundStepOf), [50, 500, 5, 20, 2, 1000])
})

test('trend: up, down, range and unknown under 50 bars', () => {
  const up = trendOf(closes(Array.from({ length: 60 }, (_, i) => 100 + i)))
  assert.equal(up.label, 'up')
  assert.equal(up.sma20, 149.5)
  assert.equal(up.sma50, 134.5)
  close(up.ret20d as number, 159 / 139 - 1)
  close(up.ret5d as number, 159 / 154 - 1)
  assert.equal(up.sma200, null)
  assert.match(up.basis, /SMA20/)
  assert.equal(trendOf(closes(Array.from({ length: 60 }, (_, i) => 160 - i))).label, 'down')
  // a zig-zag: close, sma20 and sma50 are not in order
  assert.equal(trendOf(closes(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 100 : 102)))).label, 'range')
  // up by the averages but the 20-day return is not positive: range
  const flatEnd = [...Array.from({ length: 50 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, () => 150), 151]
  assert.equal(trendOf(closes(flatEnd)).label, 'up')
  const fell = [...Array.from({ length: 50 }, (_, i) => 100 + i), 170, ...Array.from({ length: 19 }, () => 155), 160]
  assert.equal(trendOf(closes(fell)).label, 'range', 'close > sma20 > sma50 but ret20d < 0')
  const short = trendOf(closes(Array.from({ length: 49 }, (_, i) => 100 + i)))
  assert.equal(short.label, 'unknown')
  assert.equal(short.sma50, null)
  assert.match(short.basis, /49 daily bars/)
})

test('IV rank and percentile need 60 days of IV: 59 → null, 60 → computed', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => 0.1 + i / 100)   // 0.10 … 0.69
  const r60 = ivStatsOf(sixty, 0.4)
  assert.equal(r60.ivDays, 60)
  close(r60.ivRank as number, ((0.4 - 0.1) / (0.69 - 0.1)) * 100)
  close(r60.ivPercentile as number, (30 / 60) * 100)   // 0.10 … 0.39 lie below
  const r59 = ivStatsOf([null, ...sixty.slice(1)], 0.4)
  assert.deepEqual(r59, { ivRank: null, ivPercentile: null, ivDays: 59 })
  assert.equal(IV_RANK_MIN_DAYS, 60)
  // no current IV: no rank, the days still counted
  assert.deepEqual(ivStatsOf(sixty, null), { ivRank: null, ivPercentile: null, ivDays: 60 })
  // outside the year's range: clamped
  assert.equal(ivStatsOf(sixty, 0.9).ivRank, 100)
  assert.equal(ivStatsOf(sixty, 0.05).ivRank, 0)
})

const OPEN = Date.parse('2026-10-22T09:15:00+05:30')
const M5 = 5 * 60_000
const bar = (i: number, o: number, h: number, l: number, c: number, v: number): Bar => ({ t: OPEN + i * M5, o, h, l, c, v })

test('day stats: open, high, low, VWAP and the 15-minute opening range from 5-minute bars', () => {
  const bars = [bar(0, 100, 102, 99, 101, 10), bar(1, 101, 103, 100, 102, 20), bar(2, 102, 102, 98, 99, 10), bar(3, 99, 105, 99, 104, 60)]
  const s = dayStatsOf(bars, { openMs: OPEN, coveredFrom: OPEN - 60_000, nowMs: OPEN + 4 * M5 })
  assert.deepEqual([s.open, s.high, s.low, s.orHigh, s.orLow, s.partial], [100, 105, 98, 103, 98, false])
  const tp = (b: Bar): number => (b.h + b.l + b.c) / 3
  close(s.vwap as number, bars.reduce((a, b) => a + tp(b) * b.v, 0) / 100)
  // before 09:30 the opening range is still forming
  const early = dayStatsOf(bars.slice(0, 2), { openMs: OPEN, coveredFrom: OPEN - 1, nowMs: OPEN + 2 * M5 })
  assert.deepEqual([early.orHigh, early.orLow], [null, null])
  // sampling began at 09:31: no open and no opening range; high, low and VWAP are since then
  const late = dayStatsOf(bars.slice(3), { openMs: OPEN, coveredFrom: OPEN + 16 * 60_000, nowMs: OPEN + 4 * M5 })
  assert.deepEqual([late.open, late.orHigh, late.orLow, late.high, late.low, late.partial], [null, null, null, 105, 99, true])
  // no volume (an index): no VWAP
  assert.equal(dayStatsOf(bars.map((b) => ({ ...b, v: 0 })), { openMs: OPEN, coveredFrom: OPEN - 1, nowMs: OPEN + 4 * M5 }).vwap, null)
  assert.deepEqual(dayStatsOf([], { openMs: OPEN, coveredFrom: null, nowMs: OPEN }),
    { open: null, high: null, low: null, vwap: null, orHigh: null, orLow: null, partial: true })
})

test('merge: levels within 0.25% of the reference fold into the stronger, bases merged, strength +1', () => {
  const c = (price: number, kind: Candidate['kind'], strength: 1 | 2 | 3, basis: string): Candidate => ({ price, kind, strength, basis })
  const out = mergeLevels([
    c(100.2, 'r1', 2, 'R1'), c(100, 'prev-high', 2, 'high'), c(100.3, 'round', 1, 'round'), c(95, 'sma50', 2, 'SMA50'),
    c(95.2, 'sma200', 3, 'SMA200'), c(110, 's3', 1, 'S3'),
  ], 100)
  // 100 and 100.2 (0.2 apart): the tie in strength goes to the earlier kind, prev-high; 100.3 is 0.3 from 100 → its own level
  assert.deepEqual(out.map((l) => [l.price, l.kind, l.strength, l.basis]), [
    [95.2, 'sma200', 3, 'SMA200; SMA50 at 95'],
    [100, 'prev-high', 3, 'high; R1 at 100.2'],
    [100.3, 'round', 1, 'round'],
    [110, 's3', 1, 'S3'],
  ])
  assert.deepEqual(out.map((l) => l.distancePct), [-4.8, 0, 0.3, 10])
  // at most 24, the nearest to the reference, sorted by price
  const many = Array.from({ length: 40 }, (_, i) => c(100 + (i - 20) * 1, 'round', 1, `r${i}`))
  const kept = mergeLevels(many, 100)
  assert.equal(kept.length, MAX_LEVELS)
  assert.deepEqual([kept[0]!.price, kept.at(-1)!.price], [88, 111])
  const near = nearestOf(kept, 100.5)
  assert.deepEqual([near.support?.price, near.resistance?.price], [100, 101])
  assert.deepEqual(nearestOf([], 100), { support: null, resistance: null })
})

test('levelsOf: every source on fixed bars', () => {
  // 260 bars: a slow rise to 199.5 so SMA200, 52-week high/low and swings exist; the last day 112 / 88 / 103 for the pivots
  const rise: DailyBar[] = Array.from({ length: 259 }, (_, i) => day(i, 70 + i * 0.5 + 1, 70 + i * 0.5 - 1, 70 + i * 0.5))
  const daily = [...rise, day(259, 112, 88, 103)]
  const levels = levelsOf({
    ref: 103, daily,
    day: { open: 103, high: 104.6, low: 101, vwap: 102.5, orHigh: 103.5, orLow: 101.5, partial: false },
    oi: { expiry: '2026-10-27', day: '2026-10-22', callWalls: [[110, 900], [120, 500], [105, 100]], putWalls: [[95, 800]], maxPain: 99 },
  })
  assert.ok(levels.length <= MAX_LEVELS)
  const kinds = new Set(levels.map((l) => l.kind))
  for (const k of ['pivot', 'r1', 's1', 'oi-call-wall', 'oi-put-wall', 'max-pain', 'day-high', 'vwap', 'or-high'] as const) {
    assert.ok(kinds.has(k), `${k} missing: ${JSON.stringify(levels.map((l) => [l.kind, l.price]))}`)
  }
  const at = (k: string): number[] => levels.filter((l) => l.kind === k).map((l) => l.price)
  assert.deepEqual(at('pivot'), [101])
  assert.deepEqual(at('r1'), [114])
  assert.deepEqual(at('oi-put-wall'), [95])
  // the biggest call wall is strength 3, the third 1 (before any confluence)
  assert.equal(levels.find((l) => l.price === 110)?.strength, 3)
  // sorted by price, distances from the reference
  assert.deepEqual(levels.map((l) => l.price), [...levels.map((l) => l.price)].sort((a, b) => a - b))
  for (const l of levels) close(l.distancePct, Math.round(((l.price - 103) / 103) * 10_000) / 100)
  // the 52-week high (199.5 + 1 = 200.5) and SMA200 are far: dropped as the 24 nearest are kept, never invented
  assert.ok(levels.every((l) => Math.abs(l.distancePct) < 50))
  assert.equal(BASE_STRENGTH['52w-high'], 3)
})

test('levelsOf with no daily bars and no day: only round numbers', () => {
  const levels = levelsOf({ ref: 2505, daily: [], day: null, oi: null })
  assert.deepEqual(levels.map((l) => [l.price, l.kind, l.strength]), [[2450, 'round', 1], [2500, 'round', 2], [2550, 'round', 1], [2600, 'round', 1]])
})
