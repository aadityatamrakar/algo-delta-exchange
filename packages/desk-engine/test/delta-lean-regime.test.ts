/**
 * THE DETECTOR IS THE WHOLE EDGE, AND IT HAS NO INDICATORS TO HIDE BEHIND.
 *
 * It asks one question: did the index move more than the options were pricing
 * for the same window, and did it move cleanly? Get the time-scaling wrong and
 * every threshold is wrong by a constant, which is the kind of bug that looks
 * like a bad strategy instead of a bad square root.
 *
 * Three failures here are silent in production and each has its own block:
 *
 *   1. THE SQUARE ROOT. `straddle x sqrt(W / minutesToExpiry)` is the only
 *      bridge between an option price and a spot path. Scale linearly and a
 *      1-minute window reads 5x too rich, so nothing is ever a trend; invert
 *      the ratio and everything is.
 *   2. ABSENT READ AS CALM. `quiet` is the one regime that SELLS premium. A
 *      missing straddle, a thin window or a dead feed must all land on
 *      `unknown`; the single worst bug this module can have is a strangle
 *      sold into a chain that stopped printing.
 *   3. THE ASYMMETRIC HYSTERESIS. Entering a trend takes 2x implied, leaving
 *      one only 1.2x plus a dwell. Make the two bars equal and the book
 *      reclassifies on every tick that crosses the line, paying a round trip
 *      each time.
 *
 * The chain is built from real `b76Price` marks, never hand-typed, so every
 * implied number below is derived rather than asserted into existence. The
 * runtime imports are RELATIVE on purpose: the barrel is written centrally
 * after this module lands, and a test for a leaf unit should not need it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIALS } from '@algomaker/desk-engine/dials'
import type {
  ChainSnap,
  Dials,
  OptType,
  Quote,
} from '@algomaker/desk-engine'
import { b76Price } from '@algomaker/greeks'
import { RISK_FREE } from '../src/marking.ts'
import {
  MIN_SAMPLES,
  MIN_SPAN_FRAC,
  SpotRing,
  atmStraddleMid,
  classifyWindow,
  impliedWindowMove,
  readRegime,
  type Regime,
  type WindowStat,
} from '../src/delta-lean/regime.ts'

const DATE = '2026-09-11' // a Friday
const EXPIRY = '2026-09-15' // the following Tuesday — the weekly expiry
const NOW = Date.parse(`${DATE}T04:30:00.000Z`) // 10:00 IST
const T4 = 4 / 365 // calendar days to expiry, the tenor `marking.ts` marks at
const VOL = 0.12 // an index vol, not a single-stock one
const SPOT = 24_000
const STEP = 50
const LOT = 65 // NIFTY, as of Jan 2026

/**
 * Trading minutes from 10:00 on the 11th to the 15th close. Monday the 14th is
 * Ganesh Chaturthi in `MARKET_HOLIDAYS_2026`, so it contributes NOTHING — a
 * detector that counted it would price every window ~20% cheap.
 */
const MTX = 330 + 375

const DIALS: Dials = DEFAULT_DIALS
const NO_CONTEXT: Dials = { ...DEFAULT_DIALS, dl_context_on: false }

const q = (bid: number, ask: number): Quote => ({ bid, ask, ltp: null, asOf: NOW })
const UNPRICED: Quote = { bid: null, ask: null, ltp: null, asOf: NOW }

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`. */
function bookAt(spot: number, strike: number, type: OptType): Quote {
  const px = b76Price({ future: spot, strike, t: T4, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.99, px * 1.01)
}

const LADDER = Array.from({ length: 41 }, (_, i) => SPOT - 1_000 + i * STEP)

function chainOf(spot = SPOT, over: Partial<ChainSnap> = {}): ChainSnap {
  return {
    symbol: 'NIFTY',
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: q(spot - 0.5, spot + 0.5),
    spot,
    strikes: LADDER.map((k) => ({ strike: k, ce: bookAt(spot, k, 'CE'), pe: bookAt(spot, k, 'PE') })),
    asOf: NOW,
    ...over,
  }
}

/** Absent HERE is a broken fixture, not a market condition. Defaulting it to
 *  0 would flatten every tape below and pass half this file for the wrong
 *  reason, so it fails at load instead. */
function priced(x: number | null, what: string): number {
  assert.ok(x !== null && x > 0, `the fixture must price ${what}`)
  return x
}

const CHAIN = chainOf()
/** ~240 points of straddle: the market's expected absolute move to expiry. */
const STRADDLE = priced(atmStraddleMid(CHAIN), 'an ATM straddle')
const IMPLIED_SLOW = priced(
  impliedWindowMove(STRADDLE, MTX, DIALS.dl_slow_window_s),
  'a 5-minute implied move',
)

/** One sample a second over `[endMs - seconds*1000, endMs]`, priced by `fn(t)`
 *  where `t` counts seconds from the START of the fill. */
function fill(ring: SpotRing, endMs: number, seconds: number, fn: (t: number) => number): void {
  for (let t = 0; t <= seconds; t++) ring.push({ ms: endMs - (seconds - t) * 1000, spot: fn(t) })
}

/** A straight ramp of `move` points over `seconds`, ending at `NOW`. */
function ramp(seconds: number, move: number, endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, seconds, (t) => SPOT + (move * t) / seconds)
  return ring
}

/** A triangle: up `amp` over the first half, back down over the second. Net
 *  displacement 0 over the whole fill, range `amp`. */
function triangle(seconds: number, amp: number, endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  const half = seconds / 2
  fill(ring, endMs, seconds, (t) => SPOT + amp * (t <= half ? t / half : (seconds - t) / half))
  return ring
}

/** A sine of period `periodS` and amplitude `amp`: EVERY whole window of that
 *  period has displacement 0 and range 2 x `amp`. This is chop under either
 *  trend multiplier, which is what makes it the right tape for a dwell test. */
function zigzag(seconds: number, amp: number, periodS: number, endMs = NOW): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, endMs, seconds, (t) => SPOT + amp * Math.sin((2 * Math.PI * t) / periodS))
  return ring
}

/** Down 24x the 5-minute implied for ten minutes, then back up 8x for five:
 *  a pullback INSIDE a move, which the 15-minute window still reads as down. */
function pullback(): SpotRing {
  const ring = new SpotRing(4096)
  fill(ring, NOW - 300_000, 600, (t) => SPOT - (IMPLIED_SLOW * 24 * t) / 600)
  fill(ring, NOW, 300, (t) => SPOT - IMPLIED_SLOW * 24 + (IMPLIED_SLOW * 8 * t) / 300)
  return ring
}

const stat = (over: Partial<WindowStat> = {}): WindowStat => ({
  displacement: 0,
  range: 0,
  cleanliness: 0,
  samples: 60,
  spanMs: 300_000,
  ...over,
})

// ------------------------------------------------------- the implied move

test('implied move scales with the square root of the window', () => {
  // 200-point straddle, 1125 trading minutes left, 5-minute window.
  const m = impliedWindowMove(200, 1125, 300)
  assert.ok(m !== null)
  assert.ok(Math.abs(m - 200 * Math.sqrt(5 / 1125)) < 1e-9)
  assert.ok(m > 13 && m < 13.5) // the worked example in the spec
  // Four times the window is twice the move, never four times.
  const wide = impliedWindowMove(200, 1125, 1200)
  assert.ok(wide !== null)
  assert.ok(Math.abs(wide / m - 2) < 1e-9)
})

test('implied move is absent, not zero, when there is no straddle or no time', () => {
  assert.equal(impliedWindowMove(0, 1125, 300), null)
  assert.equal(impliedWindowMove(200, 0, 300), null)
  assert.equal(impliedWindowMove(200, 1125, 0), null) // a zero window is not a zero move
  assert.equal(impliedWindowMove(Number.NaN, 1125, 300), null)
})

// ----------------------------------------------------------- classification

test('a clean move twice the implied is a trend', () => {
  // 27 against an implied 13 is 2.08x, and 27/30 of it is a straight line.
  const s = stat({ displacement: 27, range: 30, cleanliness: 27 / 30 })
  assert.equal(classifyWindow(s, 13, DIALS, false), 'trend-up')
  assert.equal(classifyWindow({ ...s, displacement: -27 }, 13, DIALS, false), 'trend-down')
  // The bar itself: 25 on the same implied is 1.92x, and 1.92x is not 2x.
  const under = stat({ displacement: 25, range: 30, cleanliness: 25 / 30 })
  assert.equal(classifyWindow(under, 13, DIALS, false), 'chop')
})

test('a big range with no displacement is chop, not trend', () => {
  const s = stat({ displacement: 5, range: 40, cleanliness: 5 / 40 })
  assert.equal(classifyWindow(s, 13, DIALS, false), 'chop')
})

test('a move twice the implied but on a dirty path is chop', () => {
  // Ratio 2.3, cleanliness 0.5 — under `dl_clean_min` (0.6). Displacement
  // alone is not a trend: a round trip with a tail is not a move to lean on.
  const s = stat({ displacement: 30, range: 60, cleanliness: 0.5 })
  assert.equal(classifyWindow(s, 13, DIALS, false), 'chop')
})

test('a small range under the implied is quiet', () => {
  const s = stat({ displacement: 3, range: 8, cleanliness: 3 / 8 })
  assert.equal(classifyWindow(s, 13, DIALS, false), 'quiet')
})

test('leaving a trend needs a lower bar than entering one', () => {
  // ratio 1.5: above trend_exit_mult (1.2), below trend_mult (2.0).
  const s = stat({ displacement: 19.5, range: 22, cleanliness: 19.5 / 22 })
  assert.equal(classifyWindow(s, 13, DIALS, false), 'chop') // would not START a trend
  assert.equal(classifyWindow(s, 13, DIALS, true), 'trend-up') // but does not END one either
})

test('an absent stat or an absent implied is unknown, never quiet', () => {
  // "No data" must never read as "nothing is happening" — that would sell a
  // strangle into a feed outage.
  assert.equal(classifyWindow(null, 13, DIALS, false), 'unknown')
  const calm = stat({ displacement: 1, range: 2, cleanliness: 0.5 })
  assert.equal(classifyWindow(calm, null, DIALS, false), 'unknown')
  assert.equal(classifyWindow(calm, 0, DIALS, false), 'unknown')
  // Same stat WITH an implied move is quiet, so the null is doing the work.
  assert.equal(classifyWindow(calm, 13, DIALS, false), 'quiet')
})

test('a stat with too few samples is unknown however calm it looks', () => {
  const thin = stat({ displacement: 1, range: 2, cleanliness: 0.5, samples: MIN_SAMPLES - 1 })
  assert.equal(classifyWindow(thin, 13, DIALS, false), 'unknown')
})

// ----------------------------------------------------------------- the ring

test('a window with too few samples or too short a span is unknown, never quiet', () => {
  const ring = new SpotRing(4096)
  ring.push({ ms: NOW, spot: SPOT })
  assert.equal(ring.window(NOW + 300_000, 300), null)
  assert.equal(classifyWindow(null, 13, DIALS, false), 'unknown')
})

test('the ring only reports samples inside the window', () => {
  const ring = new SpotRing(4096)
  for (let i = 0; i <= 600; i++) ring.push({ ms: NOW + i * 1000, spot: 24_000 + i })
  const w = ring.window(NOW + 600_000, 300)
  assert.ok(w !== null)
  assert.equal(w.displacement, 300) // the last 300 seconds only
  assert.equal(w.range, 300)
  assert.equal(w.samples, 301) // inclusive of the sample sitting on the cutoff
  assert.equal(w.spanMs, 300_000)
  assert.equal(w.cleanliness, 1) // a straight line is a perfectly clean path
})

test('a burst of samples clustered at the end of the window does not count as the window', () => {
  // 40 ticks in the last 20 seconds of a 300-second window. The count guard
  // passes; the SPAN guard is the one that must fire, because scaling a
  // 20-second move against a 5-minute implied over-reads it by sqrt(15).
  const ring = new SpotRing(4096)
  for (let i = 0; i <= 40; i++) ring.push({ ms: NOW - 20_000 + i * 500, spot: SPOT + i })
  assert.ok(ring.size > MIN_SAMPLES)
  assert.equal(ring.window(NOW, 300), null)
  // The same ticks ARE a valid 30-second window: 20s spans two thirds of it.
  assert.ok(ring.window(NOW, 30) !== null)
  assert.equal(MIN_SPAN_FRAC, 0.5)
})

test('the ring drops the oldest sample rather than growing', () => {
  const ring = new SpotRing(16)
  for (let i = 0; i < 100; i++) ring.push({ ms: NOW + i * 1000, spot: SPOT + i })
  assert.equal(ring.size, 16) // capacity, not 100
  const w = ring.window(NOW + 99_000, 15)
  assert.ok(w !== null)
  assert.equal(w.samples, 16)
  assert.equal(w.displacement, 15) // samples 84..99 survived; 0..83 are gone
})

test('a non-finite tick never enters the ring', () => {
  // One NaN print poisons displacement, and every NaN comparison is false, so
  // a poisoned window silently classifies as chop forever instead of unknown.
  const ring = new SpotRing(64)
  for (let i = 0; i < 20; i++) ring.push({ ms: NOW + i * 1000, spot: SPOT + i })
  ring.push({ ms: NOW + 20_000, spot: Number.NaN })
  ring.push({ ms: Number.NaN, spot: SPOT })
  assert.equal(ring.size, 20)
  const w = ring.window(NOW + 19_000, 19)
  assert.ok(w !== null)
  assert.equal(Number.isFinite(w.displacement), true)
  assert.equal(w.displacement, 19)
})

// ─────────────────────────────── the ring's two read methods (six-playbooks F5)
//
// The playbooks read the index off the ring directly — the newest level for
// every index-based rule, and an interval's high, low and coverage for the
// session fold, the calm filter and the breakout box. Both are pinned against
// a hand-checkable tape, and both must survive the wrap: the ring is a
// full-session buffer, and the morning has long since been overwritten on a
// short one.

test('latest() is null on an empty ring and the newest sample after pushes', () => {
  const ring = new SpotRing(8)
  assert.equal(ring.latest(), null)
  ring.push({ ms: NOW, spot: SPOT })
  assert.deepEqual(ring.latest(), { ms: NOW, spot: SPOT })
  ring.push({ ms: NOW + 1_000, spot: SPOT + 5 })
  assert.deepEqual(ring.latest(), { ms: NOW + 1_000, spot: SPOT + 5 })
  // A rejected print never becomes "the newest": the door drops it first.
  ring.push({ ms: NOW + 2_000, spot: Number.NaN })
  assert.deepEqual(ring.latest(), { ms: NOW + 1_000, spot: SPOT + 5 })
})

test('latest() follows the ring through a wrap', () => {
  const ring = new SpotRing(4)
  for (let i = 0; i < 10; i++) ring.push({ ms: NOW + i * 1_000, spot: SPOT + i })
  assert.deepEqual(ring.latest(), { ms: NOW + 9_000, spot: SPOT + 9 })
})

/** Seven prints a second apart: 100, 104, 98, 101, 107, 95, 102. */
function knownTape(): SpotRing {
  const ring = new SpotRing(64)
  const path = [100, 104, 98, 101, 107, 95, 102]
  path.forEach((spot, i) => ring.push({ ms: NOW + i * 1_000, spot }))
  return ring
}

test('range() summarises a known sequence: hi, lo, first, last, their times, the count, the span', () => {
  const ring = knownTape()
  assert.deepEqual(ring.range(NOW, NOW + 6_000), {
    hi: 107, lo: 95, first: 100, last: 102,
    firstMs: NOW, lastMs: NOW + 6_000, samples: 7, spanMs: 6_000,
  })
  // Both ends are INCLUSIVE: a sample sitting on either bound is in.
  assert.deepEqual(ring.range(NOW + 1_000, NOW + 4_000), {
    hi: 107, lo: 98, first: 104, last: 107,
    firstMs: NOW + 1_000, lastMs: NOW + 4_000, samples: 4, spanMs: 3_000,
  })
  // A sample past `toMs` is SKIPPED, and the walk goes on to the ones before it.
  assert.deepEqual(ring.range(NOW, NOW + 3_500), {
    hi: 104, lo: 98, first: 100, last: 101,
    firstMs: NOW, lastMs: NOW + 3_000, samples: 4, spanMs: 3_000,
  })
  // An interval wider than the tape reports what the tape holds — the span says
  // how little of the interval it covers, which is the caller's coverage test.
  const wide = ring.range(NOW - 60_000, NOW + 60_000)
  assert.ok(wide !== null)
  assert.equal(wide.samples, 7)
  assert.equal(wide.spanMs, 6_000)
})

test('range() of one sample is that sample, with no span', () => {
  assert.deepEqual(knownTape().range(NOW + 4_000, NOW + 4_000), {
    hi: 107, lo: 107, first: 107, last: 107,
    firstMs: NOW + 4_000, lastMs: NOW + 4_000, samples: 1, spanMs: 0,
  })
})

test('range() is null for an empty interval, and when fromMs > toMs', () => {
  const ring = knownTape()
  assert.equal(ring.range(NOW + 10_000, NOW + 20_000), null, 'after the tape')
  assert.equal(ring.range(NOW - 20_000, NOW - 10_000), null, 'before it')
  assert.equal(ring.range(NOW + 200, NOW + 900), null, 'between two prints')
  assert.equal(ring.range(NOW + 4_000, NOW + 1_000), null, 'an inverted interval')
  assert.equal(new SpotRing(8).range(NOW, NOW + 60_000), null, 'an empty ring')
  // A non-finite bound is not an interval — never "everything".
  assert.equal(ring.range(Number.NaN, NOW + 6_000), null)
  assert.equal(ring.range(NOW, Number.NaN), null)
})

test('range() still works after the ring wraps', () => {
  const ring = new SpotRing(16)
  for (let i = 0; i < 100; i++) ring.push({ ms: NOW + i * 1_000, spot: SPOT + i })
  // Samples 84..99 survived; 0..83 were overwritten.
  assert.deepEqual(ring.range(NOW, NOW + 99_000), {
    hi: SPOT + 99, lo: SPOT + 84, first: SPOT + 84, last: SPOT + 99,
    firstMs: NOW + 84_000, lastMs: NOW + 99_000, samples: 16, spanMs: 15_000,
  })
  assert.deepEqual(ring.range(NOW + 90_000, NOW + 95_000), {
    hi: SPOT + 95, lo: SPOT + 90, first: SPOT + 90, last: SPOT + 95,
    firstMs: NOW + 90_000, lastMs: NOW + 95_000, samples: 6, spanMs: 5_000,
  })
  // An interval whose every sample was overwritten holds nothing — never a
  // stale value read out of a slot that was reused.
  assert.equal(ring.range(NOW, NOW + 50_000), null)
})

// ───────────────────── filteredRange: the extremes no single print can set

/** `values` one second apart from `NOW`. */
function tapeOf(values: readonly number[], capacity = 64): SpotRing {
  const ring = new SpotRing(capacity)
  values.forEach((spot, i) => ring.push({ ms: NOW + i * 1_000, spot }))
  return ring
}

test('filteredRange(): ONE BAD PRINT never becomes an extreme — mid-tape or on either edge', () => {
  // Ten flat prints at 100 with one spike in them: the raw range takes the
  // spike as its high (or low), the filtered one never does.
  const flat = Array.from({ length: 10 }, () => 100)
  const cases: Array<[string, number[]]> = [
    ['a spike up mid-tape', flat.map((v, i) => (i === 4 ? 150 : v))],
    ['a spike down mid-tape', flat.map((v, i) => (i === 4 ? 50 : v))],
    ['a spike on the first print', flat.map((v, i) => (i === 0 ? 150 : v))],
    ['a spike on the last print', flat.map((v, i) => (i === 9 ? 50 : v))],
    // Beside an edge: the edge must not hand its neighbour's bad print out.
    ['a spike on the second print', flat.map((v, i) => (i === 1 ? 150 : v))],
    ['a spike on the second-last print', flat.map((v, i) => (i === 8 ? 50 : v))],
  ]
  for (const [name, values] of cases) {
    const ring = tapeOf(values)
    const raw = ring.range(NOW, NOW + 9_000)
    const filtered = ring.filteredRange(NOW, NOW + 9_000)
    assert.ok(raw !== null && filtered !== null, name)
    assert.ok(raw.hi !== 100 || raw.lo !== 100, `${name}: the raw range must see the spike`)
    assert.equal(filtered.hi, 100, `${name}: hi`)
    assert.equal(filtered.lo, 100, `${name}: lo`)
  }
})

test('filteredRange(): a move held for two prints is a real move, and it is kept', () => {
  // 100 100 120 120 100 100 — the median of three keeps a level two prints
  // agree on, so a genuine step is not filtered away with the noise.
  const r = tapeOf([100, 100, 120, 120, 100, 100]).filteredRange(NOW, NOW + 5_000)
  assert.ok(r !== null)
  assert.equal(r.hi, 120)
  assert.equal(r.lo, 100)
})

test('filteredRange(): the ends, the count and the span are the RAW tape`s, plus the longest hole', () => {
  const ring = knownTape()
  const raw = ring.range(NOW, NOW + 6_000)
  const filtered = ring.filteredRange(NOW, NOW + 6_000)
  assert.ok(raw !== null && filtered !== null)
  const { hi: _rh, lo: _rl, ...rawRest } = raw
  const { hi: _fh, lo: _fl, maxGapMs, ...filteredRest } = filtered
  assert.deepEqual(filteredRest, rawRest)
  assert.equal(maxGapMs, 1_000, 'a print a second')
  // 100 104 98 101 107 95 102: the medians of its five consecutive triples
  // are 100 101 101 101 102. The 107, the 95 — and the edges' 104 and 98 —
  // are each one print against two, and fall out.
  assert.equal(filtered.hi, 102)
  assert.equal(filtered.lo, 100)
})

test('filteredRange(): maxGapMs is the longest hole between consecutive prints', () => {
  const ring = new SpotRing(64)
  for (const s of [0, 1, 2, 10, 11, 13]) ring.push({ ms: NOW + s * 1_000, spot: SPOT })
  const r = ring.filteredRange(NOW, NOW + 13_000)
  assert.ok(r !== null)
  assert.equal(r.maxGapMs, 8_000, 'the 2s-to-10s hole')
  assert.equal(r.samples, 6)
})

test('filteredRange(): one print is itself; two prints cannot say which is wrong and report both', () => {
  const one = tapeOf([100]).filteredRange(NOW, NOW)
  assert.ok(one !== null)
  assert.equal(one.hi, 100)
  assert.equal(one.lo, 100)
  assert.equal(one.maxGapMs, 0)
  const two = tapeOf([100, 150]).filteredRange(NOW, NOW + 1_000)
  assert.ok(two !== null)
  assert.equal(two.hi, 150)
  assert.equal(two.lo, 100)
})

test('filteredRange(): null exactly where range() is, and the wrap is handled the same way', () => {
  const ring = knownTape()
  assert.equal(ring.filteredRange(NOW + 10_000, NOW + 20_000), null)
  assert.equal(ring.filteredRange(NOW + 200, NOW + 900), null)
  assert.equal(ring.filteredRange(NOW + 4_000, NOW + 1_000), null)
  assert.equal(ring.filteredRange(Number.NaN, NOW), null)
  assert.equal(new SpotRing(8).filteredRange(NOW, NOW + 60_000), null)

  const wrapped = new SpotRing(16)
  for (let i = 0; i < 100; i++) wrapped.push({ ms: NOW + i * 1_000, spot: SPOT + i })
  const r = wrapped.filteredRange(NOW, NOW + 99_000)
  assert.ok(r !== null)
  // Samples 84..99 survived. A straight ramp's medians are the ramp itself,
  // except each edge, which takes its one neighbour's median.
  assert.equal(r.hi, SPOT + 98)
  assert.equal(r.lo, SPOT + 85)
  assert.equal(r.first, SPOT + 84)
  assert.equal(r.last, SPOT + 99)
  assert.equal(r.samples, 16)
  assert.equal(r.maxGapMs, 1_000)
  assert.equal(wrapped.filteredRange(NOW, NOW + 50_000), null)
})

// ------------------------------------------------------------ the straddle

test('the atm straddle is the two mids at the strike nearest spot', () => {
  const ce = b76Price({ future: SPOT, strike: SPOT, t: T4, vol: VOL, rate: RISK_FREE, type: 'CE' })
  const pe = b76Price({ future: SPOT, strike: SPOT, t: T4, vol: VOL, rate: RISK_FREE, type: 'PE' })
  assert.ok(Math.abs(STRADDLE - (ce + pe)) < 1e-9)
  assert.ok(STRADDLE > 200 && STRADDLE < 280) // ~1% of the index, four days out
  // Spot between two strikes still lands on the nearer one: at 24,020 the
  // 24,000 strike is 20 away and the 24,050 strike is 30, so 24,000 wins.
  const spot = SPOT + 20
  const off = atmStraddleMid(chainOf(spot))
  const atm =
    b76Price({ future: spot, strike: SPOT, t: T4, vol: VOL, rate: RISK_FREE, type: 'CE' }) +
    b76Price({ future: spot, strike: SPOT, t: T4, vol: VOL, rate: RISK_FREE, type: 'PE' })
  assert.ok(off !== null)
  assert.ok(Math.abs(off - atm) < 1e-9)
})

test('an unpriced side makes the straddle absent, not half a straddle', () => {
  const half = chainOf().strikes.map((r) => (r.strike === SPOT ? { ...r, ce: UNPRICED } : r))
  assert.equal(atmStraddleMid(chainOf(SPOT, { strikes: half })), null)
  const gone = chainOf().strikes.map((r) => (r.strike === SPOT ? { ...r, pe: null } : r))
  assert.equal(atmStraddleMid(chainOf(SPOT, { strikes: gone })), null)
  assert.equal(atmStraddleMid(chainOf(SPOT, { strikes: [] })), null) // no chain at all
})

// ----------------------------------------------------------- the whole read

test('a clean ramp reads as a trend on every window, and they agree', () => {
  // 6x the 5-minute implied, in a straight line, for a quarter of an hour.
  const ring = ramp(900, IMPLIED_SLOW * 18)
  const r = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'unknown')
  assert.equal(r.slow, 'trend-up')
  assert.equal(r.fast, 'trend-up') // the fast window is what gives DIRECTION
  assert.equal(r.context, 'trend-up')
  assert.equal(r.agrees, true) // slow and context point the same way
  assert.ok(r.slowStat !== null)
  assert.ok(Math.abs(r.slowStat.cleanliness - 1) < 1e-9)
  assert.ok(r.impliedSlow !== null)
  assert.ok(Math.abs(r.impliedSlow - IMPLIED_SLOW) < 1e-9)
})

test('a five-minute burst against a fifteen-minute move does not agree', () => {
  // The pullback-inside-a-trend the context window exists to catch: adding
  // into it at full size is the main whipsaw loss this book can suffer.
  const r = readRegime(pullback(), CHAIN, NOW, MTX, DIALS, 'unknown')
  assert.equal(r.slow, 'trend-up') // the last five minutes, on their own
  assert.equal(r.context, 'trend-down') // the last fifteen, which contain them
  assert.equal(r.agrees, false) // the pyramiding gate must see this
})

test('with the context window off its roles are inert, not hostile', () => {
  const ring = pullback()
  const r = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'unknown')
  const off = readRegime(ring, CHAIN, NOW, MTX, NO_CONTEXT, 'unknown')
  assert.equal(r.agrees, false) // same tape, context on: capped
  assert.equal(off.context, 'unknown') // no reading, rather than a fabricated one
  assert.equal(off.agrees, true) // ...and therefore no cap
  assert.equal(off.slow, r.slow) // the two-window rules are unchanged
})

test('an absent straddle reads unknown on a dead-calm tape, never quiet', () => {
  // THE WORST BUG THIS MODULE CAN HAVE. The tape is flat, so every range test
  // would pass; but with no straddle there is no implied move to compare it
  // to, and quiet is the one regime that SELLS premium.
  const dead = chainOf().strikes.map((r) => (r.strike === SPOT ? { ...r, ce: UNPRICED } : r))
  const chain = chainOf(SPOT, { strikes: dead })
  const ring = triangle(900, IMPLIED_SLOW * 0.2)
  assert.equal(readRegime(ring, CHAIN, NOW, MTX, DIALS, 'unknown').slow, 'quiet') // priced: quiet
  const r = readRegime(ring, chain, NOW, MTX, DIALS, 'unknown')
  assert.equal(r.impliedSlow, null)
  assert.equal(r.slow, 'unknown')
  assert.equal(r.fast, 'unknown')
  assert.equal(r.context, 'unknown')
  for (const g of [r.fast, r.slow, r.context]) assert.notEqual(g, 'quiet')
})

test('quiet needs two consecutive calm windows, not one', () => {
  // The spec's rule, and the reason is the direction of the error: one calm
  // five minutes at the end of a violent fifteen is the eye of the storm, and
  // selling a strangle into it is how a quiet book gets run over.
  const shaken = new SpotRing(4096)
  fill(shaken, NOW - 300_000, 300, (t) => SPOT + IMPLIED_SLOW * 3 * Math.sin((t / 300) * Math.PI * 4))
  fill(shaken, NOW, 300, (t) => SPOT + IMPLIED_SLOW * 0.1 * Math.sin((t / 300) * Math.PI * 4))
  const one = readRegime(shaken, CHAIN, NOW, MTX, DIALS, 'unknown')
  assert.equal(one.slow, 'chop') // the current window alone IS calm
  const calm = triangle(900, IMPLIED_SLOW * 0.2)
  assert.equal(readRegime(calm, CHAIN, NOW, MTX, DIALS, 'unknown').slow, 'quiet')
})

test('quiet is withheld, not asserted, when the prior window has no data', () => {
  // Exactly 300 seconds of calm ticks and nothing before them: the current
  // window is quiet, the one before it is empty. Absent is not a second
  // confirmation, so the read is unknown — which opens nothing.
  const ring = triangle(300, IMPLIED_SLOW * 0.2)
  const r = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'unknown')
  assert.equal(r.slow, 'unknown')
  assert.notEqual(r.slow, 'quiet')
})

test('a trend is held for the dwell before it may be left', () => {
  // The tape has gone to chop. Under `dl_trend_exit_mult` alone the regime
  // would flip on the first window that crossed back; the dwell makes the
  // book sit in the trend for `dl_regime_dwell_s` first.
  const ring = zigzag(900, IMPLIED_SLOW, DIALS.dl_slow_window_s)
  const raw = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'unknown')
  assert.equal(raw.slow, 'chop') // no prior trend: the tape is plainly chop
  const lowBar = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'trend-up', null)
  assert.equal(lowBar.slow, 'chop') // and chop even at the 1.2x exit bar
  const dwellMs = DIALS.dl_regime_dwell_s * 1000
  const held = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'trend-up', NOW - dwellMs + 1_000)
  assert.equal(held.slow, 'trend-up') // 119s in: still trending by the dwell
  const freed = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'trend-up', NOW - dwellMs - 1_000)
  assert.equal(freed.slow, 'chop') // 121s in: the dwell is spent
  const unknownSince = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'trend-up')
  assert.equal(unknownSince.slow, 'chop') // no start time is not "started now"
})

test('the dwell holds a trend but never invents one from a dead window', () => {
  // A trend must not be resurrected by the dwell when the window has no data:
  // the dwell suppresses reclassification noise, it does not manufacture a
  // reading. `unknown` opens nothing, so it is the safe side of this call.
  const empty = new SpotRing(4096)
  const r = readRegime(empty, CHAIN, NOW, MTX, DIALS, 'trend-up', NOW - 1_000)
  assert.equal(r.slow, 'unknown')
  assert.equal(r.slowStat, null)
})

test('the exit multiplier keeps a fading trend alive inside the read', () => {
  // 1.5x implied, cleanly: below `dl_trend_mult` (2), above
  // `dl_trend_exit_mult` (1.2). A book already leaning stays leaning; a flat
  // book does not open into it.
  const ring = ramp(900, IMPLIED_SLOW * 4.5) // 1.5x over each 300s window
  const fresh = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'unknown')
  const leaning = readRegime(ring, CHAIN, NOW, MTX, DIALS, 'trend-up', NOW - 10 * 60_000)
  assert.notEqual(fresh.slow, 'trend-up') // would not START a trend
  assert.equal(leaning.slow, 'trend-up') // but does not END one either
})

test('the regime of an empty ring is unknown on every window', () => {
  const r = readRegime(new SpotRing(4096), CHAIN, NOW, MTX, DIALS, 'unknown')
  const all: Regime[] = [r.fast, r.slow, r.context]
  for (const g of all) assert.equal(g, 'unknown')
  assert.equal(r.fastStat, null)
  assert.equal(r.slowStat, null)
  assert.equal(r.agrees, false) // nothing to agree with, and no cap lifted
  assert.ok(r.impliedSlow !== null) // the chain is fine; it is the tape that is missing
})
