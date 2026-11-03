/**
 * GOLDEN PARITY: the payoff surface answers the Python desk's own summary.
 *
 * `build_surface` (`sensibull_tools/sim/optimizer/surface.py`) is what ranks
 * every repair candidate the optimizer considers, and the ten numbers it
 * returns are the ones a trader reads off the cockpit before committing money:
 * the credit, the four book greeks, the best and worst expiry outcome, the
 * breakevens, the worst same-day shock, and the probability of profit. All ten
 * are checked here, on all three fixture books, because a port that gets nine
 * right and inverts the tenth is a port that quietly recommends the wrong
 * trade.
 *
 * WHY THE TOLERANCES DIFFER PER FIELD: the Python ROUNDS every output before it
 * returns (₹ to 2dp, delta 4dp, gamma 6dp, theta/vega 4dp, breakevens 4dp) and
 * the TS deliberately does not — rounding a number the dashboard is about to
 * round again for display only throws away precision the margin engine wants.
 * So each tolerance has to be at least the Python's own rounding step, and the
 * rest of the slack covers the one real numerical difference between the two
 * stacks: `math.erf` against the Abramowitz & Stegun normal CDF in
 * `@algomaker/greeks` (max 1.5e-7 absolute, multiplied here by a few thousand
 * shares).
 *
 * Failures are collected rather than thrown on sight: 30 summary fields across
 * 3 books, and "every book's gamma has the wrong sign" is a diagnosis where
 * "the first field that broke" is a shrug.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { close, type Tolerance } from './helpers.ts'
import { fromPyLeg, type PayoffLeg } from '../src/legs.ts'
import { buildSurface, lognormalProbBetween, type SurfaceInputs } from '../src/surface.ts'

interface SurfaceCase {
  readonly name: string
  readonly legs: readonly Record<string, unknown>[]
  readonly spot: number
  readonly dates: readonly string[]
  /** The EXACT generation params — passed straight through, never guessed. */
  readonly kwargs: { readonly r: number; readonly band: number; readonly steps: number }
  readonly out: {
    readonly net_credit: number
    readonly delta: number
    readonly gamma: number
    readonly theta: number
    readonly vega: number
    readonly max_profit: number
    readonly max_loss: number
    readonly breakevens: readonly number[]
    readonly worst_shock: number
    readonly pop: number
  }
}

const FIXTURE = new URL('./fixtures/parity/surface.json', import.meta.url)
const CASES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as readonly SurfaceCase[]

/** Book-level rupees: ₹29,000 credits and ₹94,000 shocks. See the header. */
const RUPEES: Tolerance = { abs: 1.0, rel: 1e-4 }
/**
 * BOOK-SCALED greeks — already multiplied by a few thousand signed shares, so
 * these are ±18 gammas and ±900 thetas, not the 0.001-scale per-share numbers.
 * `abs` covers the two fields that legitimately sit near zero; `rel` carries
 * the rest.
 */
const GREEK: Tolerance = { abs: 1e-4, rel: 1e-4 }
/** A probability. Three decimals is finer than anyone trades on. */
const POP: Tolerance = { abs: 1e-3, rel: 0 }
/** Breakevens are PRICES; half a rupee is inside the tick a trader can act on. */
const BREAKEVEN: Tolerance = { abs: 0.5, rel: 0 }

function reportAll(fails: readonly string[], what: string): void {
  assert.equal(
    fails.length,
    0,
    `${fails.length} ${what} mismatches vs the Python desk:\n` +
      fails.slice(0, 20).join('\n') +
      (fails.length > 20 ? `\n… and ${fails.length - 20} more` : ''),
  )
}

const inputsOf = (c: SurfaceCase): SurfaceInputs => ({
  legs: c.legs.map(fromPyLeg),
  spot: c.spot,
  dates: c.dates,
  rate: c.kwargs.r,
  band: c.kwargs.band,
  steps: c.kwargs.steps,
})

// A fixture that silently lost its future leg, or its long leg, would leave the
// suite green while testing only the easy symmetric strangle.
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
    assert.equal(c.kwargs.r, 0.065)
    assert.equal(c.kwargs.band, 0.1)
    assert.equal(c.kwargs.steps, 10)
    assert.ok(c.dates.length >= 2, `${c.name}: needs a today and an expiry`)
  }
})

test('every summary field matches the Python desk on every book', () => {
  const fails: string[] = []
  for (const c of CASES) {
    const s = buildSurface(inputsOf(c))
    const scalars: readonly [string, number, number, Tolerance][] = [
      ['net_credit', s.netCredit, c.out.net_credit, RUPEES],
      ['delta', s.greeks.delta, c.out.delta, GREEK],
      ['gamma', s.greeks.gamma, c.out.gamma, GREEK],
      ['theta', s.greeks.theta, c.out.theta, GREEK],
      ['vega', s.greeks.vega, c.out.vega, GREEK],
      ['max_profit', s.maxProfit, c.out.max_profit, RUPEES],
      ['max_loss', s.maxLoss, c.out.max_loss, RUPEES],
      ['worst_shock', s.worstShock, c.out.worst_shock, RUPEES],
      ['pop', s.pop, c.out.pop, POP],
    ]
    for (const [field, ts, py, tol] of scalars) {
      if (!close(ts, py, tol)) fails.push(`${c.name}.${field}: py=${py} ts=${ts}`)
    }
    if (s.breakevens.length !== c.out.breakevens.length) {
      fails.push(
        `${c.name}.breakevens: py=[${c.out.breakevens.join(', ')}] ts=[${s.breakevens.join(', ')}] (count)`,
      )
    } else {
      c.out.breakevens.forEach((py, i) => {
        const ts = s.breakevens[i]
        if (ts === undefined || !close(ts, py, BREAKEVEN)) {
          fails.push(`${c.name}.breakevens[${i}]: py=${py} ts=${ts}`)
        }
      })
    }
    assert.deepEqual(s.warnings, [], `${c.name}: a clean book warned`)
  }
  reportAll(fails, 'surface summary')
})

// The grid the summary is reduced FROM. The Python optimizer only keeps the
// expiry column, so nothing upstream pins this shape — but the cockpit draws
// every column, and a grid misaligned with `prices` mislabels the whole chart.
test('the grid is 21 prices wide, one column per date, and centred on spot', () => {
  for (const c of CASES) {
    const s = buildSurface(inputsOf(c))
    assert.equal(s.prices.length, 2 * c.kwargs.steps + 1)
    assert.deepEqual([...s.prices].sort((a, b) => a - b), [...s.prices], 'prices not sorted')
    assert.equal(s.prices[c.kwargs.steps], c.spot, 'the ladder is not centred on spot')
    assert.ok(close(s.prices[0] ?? 0, c.spot * (1 - c.kwargs.band), RUPEES))
    assert.ok(close(s.prices.at(-1) ?? 0, c.spot * (1 + c.kwargs.band), RUPEES))
    assert.deepEqual(Object.keys(s.cells), [...c.dates])
    for (const d of c.dates) assert.equal(s.cells[d]?.length, s.prices.length)
    assert.ok(
      Object.values(s.cells).every((col) => col.every(Number.isFinite)),
      `${c.name}: a non-finite cell`,
    )
  }
})

// max/min are read off the EXPIRY column specifically — an earlier date still
// carries time value, and a book whose max profit was read off today's column
// would claim a short strangle can never reach its full credit.
test('maxProfit and maxLoss are the expiry column, not any other date', () => {
  for (const c of CASES) {
    const s = buildSurface(inputsOf(c))
    const expiryCol = s.cells[c.dates[c.dates.length - 1] ?? ''] ?? []
    assert.equal(s.maxProfit, Math.max(...expiryCol))
    assert.equal(s.maxLoss, Math.min(...expiryCol))
    const today = s.cells[c.dates[0] ?? ''] ?? []
    assert.notEqual(Math.max(...today), s.maxProfit, `${c.name}: today's column IS the expiry one`)
  }
})

// --------------------------------------------------------------- hand cases

const shortCall: PayoffLeg = {
  id: 's_ce_700',
  instrument: 'option',
  qty: -1000,
  strike: 700,
  type: 'CE',
  expiry: '2026-08-25',
  entry: 10,
  iv: 0.25,
}
const HAND: SurfaceInputs = {
  legs: [shortCall],
  spot: 660,
  dates: ['2026-08-19', '2026-08-22', '2026-08-25'],
}

test('one short 700CE sold at ₹10: the credit IS the max profit, and it is flat below', () => {
  const s = buildSurface(HAND)
  assert.equal(s.netCredit, 10_000)
  // At expiry every price below the strike settles the call worthless, so the
  // whole low arm is the credit — exactly, no model involved.
  const expiryCol = s.cells['2026-08-25'] ?? []
  assert.equal(expiryCol[0], 10_000)
  assert.equal(s.maxProfit, 10_000)
  assert.equal(s.maxProfit, s.netCredit)
  // 726 is the top of the ladder: settle 26 points ITM against a ₹10 credit.
  // Not exact — the top rung is `660 * 1.1`, which in binary is 726.0000000000001,
  // and the ₹1.1e-10 that follows from it is the ladder's, not the payoff's.
  assert.ok(close(s.maxLoss, -16_000, RUPEES), `maxLoss ${s.maxLoss}`)
  assert.equal(expiryCol.at(-1), s.maxLoss)
})

test('the short call breaks even at strike + credit, and can only lose on a shock', () => {
  const s = buildSurface(HAND)
  assert.equal(s.breakevens.length, 1)
  assert.ok(close(s.breakevens[0] ?? 0, 710, BREAKEVEN), `breakeven ${s.breakevens[0]}`)
  // The worst of ±5%/±10% TODAY is the +10% one, and it is a loss: a short call
  // whose worst shock reads positive has its sign inverted somewhere. WHERE it
  // lands rides with it — the exact shocked price, not a ladder rung.
  assert.ok(s.worstShock < 0, `worstShock ${s.worstShock}`)
  assert.equal(s.worstShockAt, 660 * 1.1, `worstShockAt ${s.worstShockAt}`)
  // Short call, 6 days out, 6% OTM: short delta, short gamma, short vega, and
  // decay working FOR the position.
  assert.ok(s.greeks.delta < 0 && s.greeks.delta > -1000, `delta ${s.greeks.delta}`)
  assert.ok(s.greeks.gamma < 0, `gamma ${s.greeks.gamma}`)
  assert.ok(s.greeks.theta > 0, `theta ${s.greeks.theta}`)
  assert.ok(s.greeks.vega < 0, `vega ${s.greeks.vega}`)
  // One breakeven with a losing high arm: POP is the probability of finishing
  // BELOW it. Six days, 25% vol, 7.6% away — likely, never certain.
  assert.ok(s.pop > 0.8 && s.pop < 1, `pop ${s.pop}`)
  assert.deepEqual(s.warnings, [])
})

// The surface prices the OPEN LEGS. Realised P&L shifts where the RUN breaks
// even, which is `expiryBreakevens(legs, spot, realized)`'s question and the
// view layer's to ask — folding it in here would claim the surviving legs are
// worth money they never earn again, at every price and every date.
test('the surface takes no realised P&L — it is the view layer that shifts the curve', () => {
  const shifted = { ...HAND, realized: 125_000 } as SurfaceInputs
  assert.deepEqual(buildSurface(shifted), buildSurface(HAND))
})

test('an empty book is a zeroed surface with a warning, never a throw', () => {
  const zeroed = {
    prices: [],
    cells: {},
    netCredit: 0,
    greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    maxProfit: 0,
    maxLoss: 0,
    breakevens: [],
    worstShock: 0,
    worstShockAt: 0,
    pop: 0,
  }
  const empty = buildSurface({ ...HAND, legs: [] })
  assert.deepEqual({ ...empty, warnings: undefined }, { ...zeroed, warnings: undefined })
  assert.equal(empty.warnings.length, 1)
  assert.match(empty.warnings[0] ?? '', /leg/i)

  // The other three ways the Python bails out, each named in its own warning.
  for (const bad of [
    { ...HAND, dates: [] },
    { ...HAND, spot: 0 },
    { ...HAND, spot: Number.NaN },
    { ...HAND, steps: 0 },
  ]) {
    const s = buildSurface(bad)
    assert.deepEqual({ ...s, warnings: undefined }, { ...zeroed, warnings: undefined })
    assert.ok(s.warnings.length >= 1, `no warning for ${JSON.stringify(Object.keys(bad))}`)
  }
})

/**
 * The bail-out that a warning alone does NOT cover.
 *
 * An unreadable `dates[0]` or expiry date resolves every leg's `t` to null,
 * which prices the whole column flat at zero — and a flat-zero expiry column is
 * not a degraded answer, it is a WRONG one that reads like a real book: every
 * rung sits exactly on zero, so `breakevensOf`'s `y0 === 0` branch fires at all
 * 21 of them and the surface reports a position that breaks even everywhere and
 * can neither profit nor lose. The Python never reaches that state —
 * `year_frac` raises through `build_surface`'s outer except and it returns
 * `_empty()`. This pins the same bail-out here, from both ends of `dates`.
 */
test('an unreadable today or expiry date zeroes the whole surface, as the Python does', () => {
  for (const dates of [
    ['oops', '2026-08-22', '2026-08-25'],
    ['2026-08-19', '2026-08-22', 'oops'],
    // The anchored parse: a date with junk welded to its tail is NOT a date.
    // A bare prefix match would take this as the 25th and price it as valid.
    ['2026-08-19', '2026-08-22', '2026-08-25garbage'],
    ['2026-02-31', '2026-08-22', '2026-08-25'],
  ]) {
    const s = buildSurface({ ...HAND, dates })
    assert.deepEqual(s.prices, [], `${dates.join()}: a ladder was built anyway`)
    assert.deepEqual(s.cells, {})
    assert.equal(s.breakevens.length, 0, `${dates.join()}: phantom breakevens`)
    assert.equal(s.maxProfit, 0)
    assert.equal(s.maxLoss, 0)
    assert.equal(s.netCredit, 0)
    assert.equal(s.worstShock, 0)
    assert.equal(s.worstShockAt, 0)
    assert.equal(s.pop, 0)
    assert.deepEqual(s.greeks, { delta: 0, gamma: 0, theta: 0, vega: 0 })
    assert.equal(s.warnings.length, 1, `${dates.join()}: ${s.warnings.join(' | ')}`)
    assert.match(s.warnings[0] ?? '', /is not an ISO date/)
  }
})

test('an intermediate bad date costs only its own column', () => {
  const s = buildSurface({ ...HAND, dates: ['2026-08-19', 'oops', '2026-08-25'] })
  const good = buildSurface(HAND)
  // Every summary field is read off today and the expiry date, so all of them
  // survive; only the middle column is lost.
  assert.deepEqual(s.prices, good.prices)
  assert.deepEqual(s.cells['2026-08-25'], good.cells['2026-08-25'])
  assert.equal(s.maxProfit, good.maxProfit)
  assert.deepEqual(s.breakevens, good.breakevens)
  assert.ok((s.cells['oops'] ?? []).every((v) => v === 0), 'the bad column is not zeroed')
  assert.equal(s.warnings.length, 1)
  assert.match(s.warnings[0] ?? '', /all zeros/)
})

// The other half of the anchored parse: the forms the Python DOES accept must
// keep working, or a `str(pandas.Timestamp)` expiry starts reading as junk.
test('a date carrying a time component still parses, exactly as the Python takes it', () => {
  const withTime = buildSurface({
    ...HAND,
    legs: [{ ...shortCall, expiry: '2026-08-25T09:45:00+00:00' }],
    dates: ['2026-08-19 00:00:00', '2026-08-22', '2026-08-25 00:00:00'],
  })
  const plain = buildSurface(HAND)
  assert.deepEqual(withTime.warnings, [])
  assert.equal(withTime.maxProfit, plain.maxProfit)
  assert.equal(withTime.pop, plain.pop)
  assert.deepEqual(withTime.greeks, plain.greeks)
})

test('a leg the surface cannot value is skipped, not allowed to poison the grid', () => {
  const broken: PayoffLeg = { ...shortCall, id: 'broken', expiry: 'not-a-date' }
  const s = buildSurface({ ...HAND, legs: [shortCall, broken] })
  const good = buildSurface(HAND)
  assert.deepEqual(s.cells, good.cells)
  assert.ok(s.warnings.some((w) => w.includes('broken')), `warnings: ${s.warnings.join(' | ')}`)
  // netCredit counts what was SOLD, which the bad expiry does not change.
  assert.equal(s.netCredit, 20_000)
  const nanQty: PayoffLeg = { ...shortCall, id: 'nan', qty: Number.NaN }
  const s2 = buildSurface({ ...HAND, legs: [shortCall, nanQty] })
  assert.ok(Object.values(s2.cells).every((col) => col.every(Number.isFinite)))
  assert.ok(Number.isFinite(s2.netCredit) && Number.isFinite(s2.pop))
})

// --------------------------------------------------- lognormalProbBetween

test('lognormalProbBetween is a probability: unbounded is 1, and the halves sum', () => {
  const S = 660
  assert.ok(close(lognormalProbBetween(S, null, null, 0.25, 0.02), 1, POP))
  const below = lognormalProbBetween(S, null, 700, 0.25, 0.02)
  const above = lognormalProbBetween(S, 700, null, 0.25, 0.02)
  assert.ok(close(below + above, 1, POP), `${below} + ${above}`)
  assert.ok(below > 0.5 && below < 1, `below ${below}`)
  // Wider band, more probability inside it — monotone in the band, always.
  assert.ok(
    lognormalProbBetween(S, 600, 720, 0.25, 0.02) >
      lognormalProbBetween(S, 640, 680, 0.25, 0.02),
  )
  // More vol, less chance of staying inside a fixed band.
  assert.ok(
    lognormalProbBetween(S, 600, 720, 0.60, 0.02) <
      lognormalProbBetween(S, 600, 720, 0.15, 0.02),
  )
})

test('with no time or no vol left, the probability is where the price already is', () => {
  assert.equal(lognormalProbBetween(660, 600, 700, 0.25, 0), 1)
  assert.equal(lognormalProbBetween(660, 600, 700, 0, 0.02), 1)
  assert.equal(lognormalProbBetween(660, 700, 800, 0.25, 0), 0)
  assert.equal(lognormalProbBetween(660, null, 620, 0.25, 0), 0)
  // Never negative, never NaN — it is multiplied into a ranking downstream.
  assert.equal(lognormalProbBetween(660, 700, 600, 0.25, 0.02), 0)
  assert.equal(lognormalProbBetween(Number.NaN, 600, 700, 0.25, 0.02), 0)
  assert.equal(lognormalProbBetween(660, 600, 700, Number.NaN, 0.02), 0)
})
