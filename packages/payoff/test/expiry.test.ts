/**
 * GOLDEN PARITY: the expiry payoff answers the Python desk's own numbers.
 *
 * `expiry_pnl_at` and `expiry_breakevens` (`sensibull_tools/sim/book.py`) are
 * the two figures the desk defends a short-premium book with, and they are the
 * ones a trader reads off the cockpit at 15:15. Pure intrinsic arithmetic, so
 * parity here should be near-exact — a deviation of more than a rupee on a
 * ₹1.8L number is a port bug, not float noise.
 *
 * THE TRAP IN THE FIXTURE, stated once so nobody "fixes" it later: `realized`
 * (₹1.25L in every case) shifts the BREAKEVENS and NOT `pnl_at`. That is not an
 * inconsistency in the generator, it is the two functions' actual contracts —
 * `expiry_pnl_at` measures the OPEN legs against their own entries, while
 * `expiry_breakevens` answers "where does the RUN break even", which has to
 * carry P&L already banked or a close-and-re-sell launders its own breach out
 * of the reading (book.py:99-105). The tests below assert BOTH halves of that
 * asymmetry on purpose, including that breakevens computed with `realized = 0`
 * DISAGREE with the fixture.
 *
 * Failures are collected rather than thrown on sight: 42 payoff points across 3
 * books, and "all three books are wrong below spot" is a diagnosis where "the
 * first point that broke" is a shrug.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { close, type Tolerance } from './helpers.ts'
import { fromPyLeg, type PayoffLeg } from '../src/legs.ts'
import { expiryPnlAt, expiryBreakevens } from '../src/expiry.ts'

interface ExpiryCase {
  readonly name: string
  readonly legs: readonly Record<string, unknown>[]
  readonly spot: number
  readonly realized: number
  /** Keyed by the underlying price, stringified by Python's `json.dump`. */
  readonly pnl_at: Readonly<Record<string, number>>
  readonly breakevens: { readonly down: number | null; readonly up: number | null }
}

const FIXTURE = new URL('./fixtures/parity/expiry.json', import.meta.url)
const CASES = JSON.parse(readFileSync(FIXTURE, 'utf8')) as readonly ExpiryCase[]

/**
 * BOOK-level rupees, which is why `abs` is ₹1 and not the paisa the per-share
 * price parity uses: these cells run from ₹9,800 to ₹1.87 lakh, and a rupee on
 * ₹1.87 lakh is 5e-6 of the value. `rel` carries the big end. Both bounds are
 * far tighter than any real port error could hide under — the arithmetic is
 * multiply-and-add on exact intrinsics, so the honest expectation is bit-equal
 * and the tolerance exists only for the float noise of a different summation
 * order.
 */
const RUPEES: Tolerance = { abs: 1.0, rel: 1e-4 }
/**
 * Breakevens are PRICES, and half a rupee is well inside the tick a trader can
 * act on. No relative component: a breakeven near zero would be a book with no
 * downside at all, and `rel` there would be meaninglessly wide.
 */
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

const legsOf = (c: ExpiryCase): PayoffLeg[] => c.legs.map(fromPyLeg)

// A fixture that silently lost its future leg, or its buy leg, would leave the
// suite green while testing only the easy symmetric strangle.
test('the fixture is the three generated books, with their distinguishing legs', () => {
  assert.equal(CASES.length, 3)
  assert.deepEqual(
    CASES.map((c) => c.name),
    ['strangle', 'repaired', 'with-future'],
  )
  const all = CASES.flatMap(legsOf)
  assert.ok(all.some((l) => l.instrument === 'future'), 'no future leg in the fixture')
  assert.ok(all.some((l) => l.qty > 0), 'no long leg in the fixture')
  assert.ok(all.some((l) => l.qty < 0), 'no short leg in the fixture')
  assert.ok(CASES.every((c) => Object.keys(c.pnl_at).length >= 14))
  assert.ok(CASES.every((c) => c.realized === 125000))
})

test('expiryPnlAt matches the Python desk at every payoff point', () => {
  const fails: string[] = []
  for (const c of CASES) {
    for (const [price, py] of Object.entries(c.pnl_at)) {
      const got = expiryPnlAt(legsOf(c), Number(price))
      if (!close(got, py, RUPEES)) fails.push(`${c.name} @${price}: py=${py} ts=${got}`)
    }
  }
  reportAll(fails, 'expiry P&L')
})

// The documented trap, asserted rather than trusted: these cells are OPEN-LEGS
// P&L. If someone later folds `realized` into `expiryPnlAt` to "make the two
// agree", this fails immediately instead of quietly double-counting ₹1.25L
// everywhere the cockpit shows a payoff curve.
test('expiryPnlAt is open-legs only — realized is NOT in it', () => {
  for (const c of CASES) {
    const atSpot = expiryPnlAt(legsOf(c), c.spot)
    const py = c.pnl_at[c.spot.toFixed(1)]
    assert.ok(py !== undefined, `fixture has no pnl_at point at spot ${c.spot}`)
    assert.ok(close(atSpot, py, RUPEES), `${c.name}: py=${py} ts=${atSpot}`)
    assert.ok(!close(atSpot, py + c.realized, RUPEES), `${c.name}: realized leaked into pnl_at`)
  }
})

test('expiryBreakevens matches the Python desk on both sides', () => {
  const fails: string[] = []
  for (const c of CASES) {
    const got = expiryBreakevens(legsOf(c), c.spot, c.realized)
    for (const side of ['down', 'up'] as const) {
      const py = c.breakevens[side]
      const ts = got[side]
      if ((py === null) !== (ts === null)) {
        fails.push(`${c.name} ${side}: py=${py} ts=${ts} (null disagreement)`)
      } else if (py !== null && ts !== null && !close(ts, py, BREAKEVEN)) {
        fails.push(`${c.name} ${side}: py=${py} ts=${ts}`)
      }
    }
    // The crossings really do bracket spot, on every book in the fixture.
    if (got.down !== null) assert.ok(got.down <= c.spot)
    if (got.up !== null) assert.ok(got.up >= c.spot)
  }
  reportAll(fails, 'breakeven')
})

// The other half of the trap: `realized` genuinely moves these, so a port that
// ignored the argument would still pass the parity test above if the fixture
// had been generated with realized = 0. It was not.
test('realized shifts the breakevens outwards — dropping it changes the answer', () => {
  for (const c of CASES) {
    const withIt = expiryBreakevens(legsOf(c), c.spot, c.realized)
    const without = expiryBreakevens(legsOf(c), c.spot)
    assert.notDeepEqual(withIt, without, `${c.name}: realized had no effect`)
    // Banked profit can only widen the safe band, never narrow it.
    if (withIt.down !== null && without.down !== null) assert.ok(withIt.down < without.down)
    if (withIt.up !== null && without.up !== null) assert.ok(withIt.up > without.up)
  }
})

// --------------------------------------------------------------- hand cases

const shortCall = (qty: number, strike: number, entry: number): PayoffLeg => ({
  id: `s_ce_${strike}`,
  instrument: 'option',
  qty,
  strike,
  type: 'CE',
  expiry: '2026-08-25',
  entry,
  iv: 0.28,
})

test('one short 100CE sold at ₹5 breaks even at 105 and never below', () => {
  const legs = [shortCall(-100, 100, 5)]
  assert.deepEqual(expiryBreakevens(legs, 100), { down: null, up: 105 })
  // `down: null` is UNBOUNDED SAFETY, not missing data: the short call keeps
  // the whole ₹500 credit all the way to zero.
  assert.equal(expiryPnlAt(legs, 0), 500)
  assert.equal(expiryPnlAt(legs, 105), 0)
  assert.equal(expiryPnlAt(legs, 110), -500)
})

test('a book with no strikes, or a nonsense spot, reports no breakevens', () => {
  const fut: PayoffLeg = {
    id: 'b_fut',
    instrument: 'future',
    qty: 1000,
    strike: null,
    type: null,
    expiry: '2026-08-25',
    entry: 662,
    iv: null,
  }
  const NONE = { down: null, up: null }
  assert.deepEqual(expiryBreakevens([fut], 660), NONE)
  assert.deepEqual(expiryBreakevens([], 660), NONE)
  assert.deepEqual(expiryBreakevens([shortCall(-100, 100, 5)], 0), NONE)
  assert.deepEqual(expiryBreakevens([shortCall(-100, 100, 5)], -5), NONE)
  assert.deepEqual(expiryBreakevens([shortCall(-100, 100, 5)], Number.NaN), NONE)
})

// Ported quirks, pinned so a later "tidy-up" has to argue with a test. Both
// come straight from book.py:125-135.
test('a kink sitting exactly on zero IS a breakeven (the y0 == 0 branch)', () => {
  // Sold for nothing: the payoff is flat at zero below 100 and falls after it.
  const legs = [shortCall(-100, 100, 0)]
  assert.equal(expiryPnlAt(legs, 50), 0)
  // Every zero kink at or below spot counts; the NEAREST one is reported.
  assert.deepEqual(expiryBreakevens(legs, 100), { down: 100, up: null })
})

test('the far endpoint counts too when the payoff ends exactly at zero', () => {
  // A put sold for nothing is worth nothing above its strike, so the payoff is
  // flat at zero from 100 out to the synthetic 3x endpoint — which the Python
  // then reports as an upside breakeven. It is an artefact of the endpoint, not
  // a real crossing, and it is ported deliberately: parity with the desk that
  // is already running beats a cleaner answer nobody else computes.
  const put: PayoffLeg = {
    id: 's_pe_100',
    instrument: 'option',
    qty: -100,
    strike: 100,
    type: 'PE',
    expiry: '2026-08-25',
    entry: 0,
    iv: 0.28,
  }
  assert.deepEqual(expiryBreakevens([put], 100), { down: 100, up: 300 })
})

test('expiryPnlAt skips a leg it cannot value instead of poisoning the sum', () => {
  const good = shortCall(-100, 100, 5)
  const broken: PayoffLeg = { ...good, id: 'broken', strike: null }
  assert.equal(expiryPnlAt([good, broken], 110), expiryPnlAt([good], 110))
  const nanEntry: PayoffLeg = { ...good, id: 'nan', entry: Number.NaN }
  assert.equal(expiryPnlAt([good, nanEntry], 110), expiryPnlAt([good], 110))
  assert.equal(expiryPnlAt([good], Number.NaN), 0)
  assert.equal(expiryPnlAt([], 110), 0)
})
