/**
 * GOLDEN PARITY + the two properties SPAN-lite exists for.
 *
 * `portfolio_margin` (`sensibull_tools/sim/margin.py`) is what the Python
 * engine's margin-cap guard sizes real books against, so the number this port
 * returns decides whether a live book is allowed to grow. Three fixture books
 * pin it: a naked strangle (worst case UP), the same strangle repaired with a
 * long wing and an extra short (worst case DOWN — the wing moved it), and one
 * with a futures leg (exposure on both sides).
 *
 * Beyond parity, two properties are asserted by hand because they are the whole
 * reason the estimator is a 21-point scenario grid and not a per-leg formula:
 *
 *   a fully-paid long book needs NO margin — real exchanges margin unbounded
 *   risk, never a paid-for option; a port that charges SPAN on a long call
 *   would quietly halve the desk's usable capital.
 *
 *   buying a wing STRICTLY reduces the total — the hedge benefit falls out of
 *   the grid (the long leg's gain lands in the same scenario as the short's
 *   loss) with no spread-matching logic anywhere. If that property breaks, the
 *   grid has stopped netting and every hedged book is over-margined.
 *
 * `n_short_lots` IS IN THE FIXTURE AND IS DELIBERATELY NOT CHECKED: algomaker
 * legs carry signed SHARES and no lot size at all, so there is no honest lot
 * count to return. The shape assertion below pins that omission so it stays a
 * decision rather than becoming an oversight.
 *
 * Failures are collected before reporting: 18 parity fields across 3 books, and
 * "every book's span is short by its exposure add-on" is a diagnosis that the
 * first failing field alone would not give.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { close, type Tolerance } from './helpers.ts'
import { DEFAULT_RATE, fromPyLeg, legPnl, type PayoffLeg } from '../src/legs.ts'
import { spanLiteMargin, type SpanLiteOptions } from '../src/margin.ts'

interface MarginCase {
  readonly name: string
  readonly legs: readonly Record<string, unknown>[]
  readonly spot: number
  readonly date: string
  /** The EXACT generation params — passed straight through, never guessed. */
  readonly kwargs: {
    readonly default_iv: number
    readonly price_scan_pct: number
    readonly vol_scan: number
    readonly exposure_pct: number
    readonly min_short_pct: number
    readonly r: number
  }
  readonly out: {
    readonly span: number
    readonly exposure: number
    readonly total: number
    readonly worst_scenario: { readonly price_move_pct: number; readonly vol_mult: number }
    readonly short_notional: number
    readonly n_short_lots: number
  }
}

const FIXTURE = new URL('./fixtures/parity/margin.json', import.meta.url)
const CASES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as readonly MarginCase[]

/**
 * Margin in RUPEES, on books margining ₹200k-₹500k. The Python rounds to 2dp
 * and re-prices every leg 21 times through `math.erf` where this stack uses the
 * Abramowitz & Stegun CDF (1.5e-7 absolute) — multiplied by a few thousand
 * shares and summed over four legs, that is rupees, not paise. `rel` carries
 * the answer; `abs` only keeps a near-zero span from being judged on scale.
 *
 * ONE RUPEE, NOT FIVE. The observed error on every field of all three books is
 * under ₹0.05 — a paisa either side of the Python's own 2dp rounding. `abs` is
 * the bound that judges the SMALL fields (`close` passes on either bound, so at
 * ₹250k `rel` is the one carrying the answer), and at ₹5 it was a hundred times
 * the real disagreement: a near-zero span that had genuinely drifted would still
 * have read as parity. ₹1 keeps the rounding step covered twentyfold and stops
 * there.
 */
const MARGIN: Tolerance = { abs: 1.0, rel: 1e-4 }
/**
 * The worst scenario is a COORDINATE on the grid, not a computed quantity: it
 * can only ever be one of 7 price fractions x 3 vol multipliers. Anything
 * outside a rounding step means the port picked a DIFFERENT cell, which is a
 * real disagreement about where the book hurts and must fail.
 */
const SCENARIO: Tolerance = { abs: 0.01, rel: 0 }
/** `spot x |shares|` on both sides — exact arithmetic, no model in it. */
const NOTIONAL: Tolerance = { abs: 0.01, rel: 0 }

function reportAll(fails: readonly string[], what: string): void {
  assert.equal(
    fails.length,
    0,
    `${fails.length} ${what} mismatches vs the Python desk:\n` +
      fails.slice(0, 20).join('\n') +
      (fails.length > 20 ? `\n… and ${fails.length - 20} more` : ''),
  )
}

const optsOf = (c: MarginCase): SpanLiteOptions => ({
  defaultIv: c.kwargs.default_iv,
  priceScanPct: c.kwargs.price_scan_pct,
  volScan: c.kwargs.vol_scan,
  exposurePct: c.kwargs.exposure_pct,
  minShortPct: c.kwargs.min_short_pct,
  rate: c.kwargs.r,
})

const marginOf = (c: MarginCase) =>
  spanLiteMargin(c.legs.map(fromPyLeg), c.spot, c.date, optsOf(c))

// A fixture that silently lost its future leg, or its long wing, would leave
// the suite green while only ever testing the symmetric naked strangle.
test('the fixture is the three generated books, with their generation params', () => {
  assert.equal(CASES.length, 3)
  assert.deepEqual(
    CASES.map((c) => c.name),
    ['strangle', 'repaired', 'with-future'],
  )
  const all = CASES.flatMap((c) => c.legs.map(fromPyLeg))
  assert.ok(all.some((l) => l.instrument === 'future'), 'no future leg in the fixture')
  assert.ok(all.some((l) => l.qty > 0), 'no long leg in the fixture')
  assert.ok(all.some((l) => l.qty < 0), 'no short leg in the fixture')
  for (const c of CASES) {
    assert.equal(c.kwargs.default_iv, 0.35)
    assert.equal(c.kwargs.price_scan_pct, 0.21)
    assert.equal(c.kwargs.vol_scan, 0.25)
    assert.equal(c.kwargs.exposure_pct, 0.05)
    assert.equal(c.kwargs.min_short_pct, 0.05)
    assert.equal(c.kwargs.r, 0.065)
  }
})

test('span, exposure, total and the worst cell match the Python desk on every book', () => {
  const fails: string[] = []
  for (const c of CASES) {
    const m = marginOf(c)
    const fields: readonly [string, number, number, Tolerance][] = [
      ['span', m.span, c.out.span, MARGIN],
      ['exposure', m.exposure, c.out.exposure, MARGIN],
      ['total', m.total, c.out.total, MARGIN],
      ['short_notional', m.shortNotional, c.out.short_notional, NOTIONAL],
      [
        'worst_scenario.price_move_pct',
        m.worstScenario.priceMovePct,
        c.out.worst_scenario.price_move_pct,
        SCENARIO,
      ],
      ['worst_scenario.vol_mult', m.worstScenario.volMult, c.out.worst_scenario.vol_mult, SCENARIO],
    ]
    for (const [field, ts, py, tol] of fields) {
      if (!close(ts, py, tol)) fails.push(`${c.name}.${field}: py=${py} ts=${ts}`)
    }
  }
  reportAll(fails, 'margin')
})

// The result SHAPE, pinned: `n_short_lots` is dropped on purpose (see header),
// and `total` is never an independent number — a port that returned a rounded
// span plus an unrounded exposure would still pass the tolerances above.
test('the result is span + exposure and nothing else — no lot count', () => {
  for (const c of CASES) {
    const m = marginOf(c)
    assert.deepEqual(Object.keys(m).sort(), [
      'exposure',
      'shortNotional',
      'span',
      'total',
      'worstScenario',
    ])
    assert.deepEqual(Object.keys(m.worstScenario).sort(), ['priceMovePct', 'volMult'])
    assert.equal(m.total, m.span + m.exposure, `${c.name}: total is not span + exposure`)
  }
})

// --------------------------------------------------------------- hand cases

const SPOT = 660
const DATE = '2026-08-19'
const EXPIRY = '2026-08-25'

const shortCall: PayoffLeg = {
  id: 's_ce_700',
  instrument: 'option',
  qty: -2000,
  strike: 700,
  type: 'CE',
  expiry: EXPIRY,
  entry: 8.4,
  iv: 0.28,
}
const shortPut: PayoffLeg = {
  id: 's_pe_620',
  instrument: 'option',
  qty: -2000,
  strike: 620,
  type: 'PE',
  expiry: EXPIRY,
  entry: 6.1,
  iv: 0.31,
}
/** The wing: LONG, so it adds risk-reducing convexity and no short notional. */
const longWing: PayoffLeg = {
  id: 'b_ce_730',
  instrument: 'option',
  qty: 1000,
  strike: 730,
  type: 'CE',
  expiry: EXPIRY,
  entry: 2.1,
  iv: 0.26,
}

test('a fully-paid long book needs no margin at all', () => {
  const longs: readonly PayoffLeg[] = [
    longWing,
    { ...shortCall, id: 'b_pe_620', qty: 2000, strike: 620, type: 'PE' },
  ]
  const m = spanLiteMargin(longs, SPOT, DATE)
  assert.equal(m.span, 0)
  assert.equal(m.exposure, 0)
  assert.equal(m.total, 0)
  assert.equal(m.shortNotional, 0)
  // Not "the grid found nothing": there IS no worst cell to report, and the
  // zeroed one must read as an unshocked book rather than a −21% crash.
  assert.deepEqual(m.worstScenario, { priceMovePct: 0, volMult: 1 })
})

test('buying a wing strictly reduces the total — the hedge benefit, for free', () => {
  const naked = spanLiteMargin([shortCall, shortPut], SPOT, DATE)
  const hedged = spanLiteMargin([shortCall, shortPut, longWing], SPOT, DATE)

  assert.ok(hedged.total < naked.total, `hedged ${hedged.total} !< naked ${naked.total}`)
  // The benefit is entirely in the SPAN. A long leg is not short notional, so
  // the exposure add-on cannot move — if it did, the wing was counted as risk.
  assert.equal(hedged.exposure, naked.exposure)
  assert.equal(hedged.shortNotional, naked.shortNotional)
  assert.ok(hedged.span < naked.span, `hedged span ${hedged.span} !< naked ${naked.span}`)
  // And the MECHANISM is visible: the naked strangle hurts most on the way up
  // (the call is the nearer strike); capping that arm moves the worst cell to
  // the downside, which is what "the grid nets" looks like from outside.
  assert.ok(naked.worstScenario.priceMovePct > 0, `naked worst ${naked.worstScenario.priceMovePct}`)
  assert.ok(
    hedged.worstScenario.priceMovePct < 0,
    `hedged worst ${hedged.worstScenario.priceMovePct}`,
  )
})

// Deep-OTM shorts scan to almost nothing, and NSE still charges for them. The
// floor is the difference between "this book is free" and the truth.
test('a deep-OTM short is floored at the short-notional minimum, not at its scan loss', () => {
  const far: PayoffLeg = { ...shortCall, id: 's_ce_1200', strike: 1200, entry: 0.05, iv: 0.5 }
  const m = spanLiteMargin([far], SPOT, DATE, { minShortPct: 0.05 })
  const notional = SPOT * 2000
  assert.equal(m.shortNotional, notional)
  assert.ok(close(m.span, 0.05 * notional, NOTIONAL), `span ${m.span} is not the floor`)
  assert.ok(close(m.exposure, 0.05 * notional, NOTIONAL), `exposure ${m.exposure}`)
})

// A future is margined on BOTH sides — long or short, the loss is unbounded.
test('a long future carries exposure and span even though it is a buy', () => {
  const fut: PayoffLeg = {
    id: 'b_fut',
    instrument: 'future',
    qty: 1000,
    strike: null,
    type: null,
    expiry: EXPIRY,
    entry: 662,
    iv: null,
  }
  const m = spanLiteMargin([fut], SPOT, DATE)
  // No SHORT option, so no short notional — but the exposure add-on still sees
  // the futures notional, and the 21-point scan still charges the down move.
  assert.equal(m.shortNotional, 0)
  assert.ok(close(m.exposure, 0.05 * SPOT * 1000, NOTIONAL), `exposure ${m.exposure}`)
  assert.ok(close(m.span, 0.21 * SPOT * 1000, { abs: 1, rel: 0 }), `span ${m.span}`)
  assert.ok(close(m.worstScenario.priceMovePct, -21, SCENARIO))
})

// Every cell losing the same amount is not a hypothetical — it is any book
// scanned with the price shock switched off, and it is the ONLY way to observe
// which end of a tie the port reports. The Python's `min()` keeps the FIRST
// cell in insertion order, i.e. the lowest vol multiplier of the unshocked
// price; a port that kept the last would name a scenario the book never
// reached, and no fixture book has a tie to catch it.
test('a tie is broken the Python way: the first cell on the grid, not the last', () => {
  const fut: PayoffLeg = {
    id: 'b_fut',
    instrument: 'future',
    qty: 1000,
    strike: null,
    type: null,
    expiry: EXPIRY,
    entry: 662,
    iv: null,
  }
  // A future has no vol at all, so with no price shock every one of the 21
  // cells changes by exactly zero.
  const m = spanLiteMargin([fut], SPOT, DATE, { priceScanPct: 0, volScan: 0.25 })
  assert.equal(m.span, 0)
  assert.deepEqual(m.worstScenario, { priceMovePct: 0, volMult: 0.75 })
})

/**
 * THE ONE PLACE THIS PORT REFUSES TO BE THE PYTHON, pinned so it stays a
 * decision (`margin.ts`'s "ONE DELIBERATE DIVERGENCE" note).
 *
 * `_span_core` keys its accumulator by the `(f, vm)` TUPLE. Switch the vol scan
 * off and the three multipliers all become 1.0, so the 21 cells collapse onto 7
 * dict keys and every leg's scenario change is added to each of them THREE
 * TIMES — a book margined with `vol_scan=0` posts three times the span it
 * should. This port indexes by scenario POSITION, so a zero vol scan is exactly
 * what asking for it means: a price-only scan over the same 7 shocks.
 *
 * ASSERTED AGAINST THE ARITHMETIC ITSELF, not against "less than 3x". The
 * expected span is the 7-shock grid computed here by hand, leg by leg, through
 * the same `legPnl` the estimator calls — so a port that started double-counting
 * (or dropped a shock, or lost the floor) fails on the number rather than on a
 * bound that a wrong answer could still sit inside.
 */
test('a zero vol scan is a PRICE-ONLY scan, not the Python’s triple count', () => {
  const book: readonly PayoffLeg[] = [shortCall, shortPut]
  // `legT`: calendar days over 365, six of them, well above the one-hour floor.
  const T = 6 / 365
  const F_MULTS = [0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1]
  const SCAN = 0.21

  // The grid by hand, at ONE vol — because with `volScan: 0` there is only one.
  let worstChange = Number.POSITIVE_INFINITY
  for (const f of F_MULTS) {
    const F = SPOT * (1 + f * SCAN)
    let change = 0
    for (const leg of book) {
      const iv = leg.iv ?? undefined
      change += legPnl(leg, F, T, DEFAULT_RATE, iv) - legPnl(leg, SPOT, T, DEFAULT_RATE, iv)
    }
    if (change < worstChange) worstChange = change
  }
  const shortNotional = SPOT * 4000
  const expected = Math.max(Math.max(0, -worstChange), 0.05 * shortNotional)

  const m = spanLiteMargin(book, SPOT, DATE, { volScan: 0 })
  assert.ok(close(m.span, expected, { abs: 0.01, rel: 0 }), `span ${m.span} !== ${expected}`)
  assert.equal(m.shortNotional, shortNotional)
  // There is only one vol multiplier on this grid, so the worst cell must name
  // it — a `0.75` or `1.25` here would mean the scan was never switched off.
  assert.equal(m.worstScenario.volMult, 1)

  // And the defect this pins, stated as a number: the tripling would clear the
  // floor by miles and put ~3x the span on a live book's cap guard.
  const tripled = Math.max(0, -3 * worstChange)
  assert.ok(tripled > expected * 2, 'the fixture is too small to distinguish the triple count')
  assert.ok(m.span < tripled * 0.4, `span ${m.span} looks like the tripled ${tripled}`)
})

// --------------------------------------------------------------- fail-soft

test('nothing unusable throws, and everything unusable is a zeroed book', () => {
  const zero = {
    span: 0,
    exposure: 0,
    total: 0,
    worstScenario: { priceMovePct: 0, volMult: 1 },
    shortNotional: 0,
  }
  assert.deepEqual(spanLiteMargin([], SPOT, DATE), zero)
  assert.deepEqual(spanLiteMargin([shortCall], 0, DATE), zero)
  assert.deepEqual(spanLiteMargin([shortCall], Number.NaN, DATE), zero)
  assert.deepEqual(spanLiteMargin(null as unknown as PayoffLeg[], SPOT, DATE), zero)
  assert.deepEqual(spanLiteMargin([null as unknown as PayoffLeg], SPOT, DATE), zero)
  // A leg the grid cannot price is SKIPPED, not fatal: the rest of the book is
  // still margined, and a book that reads ₹0 because one leg lost its IV is the
  // failure mode this whole package is fail-soft to avoid.
  const noIv: PayoffLeg = { ...shortPut, id: 's_pe_620_noiv', iv: null }
  const withJunk = spanLiteMargin([shortCall, noIv, null as unknown as PayoffLeg], SPOT, DATE)
  assert.ok(withJunk.total > 0, 'a book with one bad leg margined at zero')
  // ...and `iv: null` falls back to `defaultIv`, so the leg is still SCANNED —
  // it is not silently worth nothing.
  const alone = spanLiteMargin([noIv], SPOT, DATE)
  assert.ok(alone.span > 0.05 * SPOT * 2000, `no-IV leg was not scanned: span ${alone.span}`)
})

test('unusable options fall back to their defaults rather than poisoning the answer', () => {
  const base = spanLiteMargin([shortCall, shortPut], SPOT, DATE)
  const junk = spanLiteMargin([shortCall, shortPut], SPOT, DATE, {
    // `volScan` is OMITTED rather than passed as NaN: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not a legal value
    // for an optional field, and "absent" is the same path anyway.
    priceScanPct: Number.NaN,
    exposurePct: Number.POSITIVE_INFINITY,
    minShortPct: Number.NaN,
    rate: Number.NaN,
    defaultIv: Number.NaN,
  })
  assert.deepEqual(junk, base)
})

// The date is the only input that is not a number, and a book whose date will
// not parse must still be margined — as an expiring one, which is the Python's
// answer (`_leg_t` swallows the parse error and returns `_MIN_T`).
test('an unreadable date prices the book at the one-hour floor, it does not zero it', () => {
  const bad = spanLiteMargin([shortCall, shortPut], SPOT, 'not-a-date')
  const expiryDay = spanLiteMargin([shortCall, shortPut], SPOT, EXPIRY)
  assert.ok(bad.total > 0, 'an unreadable date zeroed the book')
  assert.ok(close(bad.total, expiryDay.total, { abs: 1e-6, rel: 1e-9 }), `${bad.total}`)
})
