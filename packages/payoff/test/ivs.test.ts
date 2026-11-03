/**
 * THE VOL THE PRICE SCAN HOLDS STILL.
 *
 * There is no Python counterpart to compare against here — the Python desk
 * carries whatever IV its chain source stamped on a leg, and never re-solves —
 * so this suite is hand-built rather than fixture-driven. Every case is
 * constructed by pricing a contract at a KNOWN vol with `b76Price` and then
 * demanding that vol back: an IV solver is exactly the function whose test can
 * be a round trip without being circular, because the inverse is computed by a
 * completely different method (bisection) from the forward (closed form).
 *
 * The three properties that matter to a live book, in the order they bite:
 *
 *   FRESHNESS IS NOT OPTIONAL. A wing that last traded at 09:20 still has an
 *   LTP at 14:50, and it will happily solve — to the vol of a market that no
 *   longer exists. The stale-quote cases price the middle strike at a
 *   deliberately ABSURD vol so that "the solver ignored the age" and "the
 *   solver read the age" cannot produce the same answer.
 *
 *   UNSOLVABLE IS A ROUTINE STATE, not an error. Deep wings quote below
 *   discounted intrinsic all day. They must fall back, not throw, and not be
 *   marked at a fabricated number.
 *
 *   CE AND PE ARE TWO SURFACES. A put's vol is not evidence about a call's at
 *   the same strike on this desk's chain, and an interpolator that pooled them
 *   would silently smooth a skew away.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, type OptionType } from '@algomaker/greeks'
import { close, type Tolerance } from './helpers.ts'
import { ivFor, solveChainIvs, type ChainQuoteLite, type SolvedIv } from '../src/ivs.ts'

const FUTURE = 700
/** ~30 calendar days, the tenor a weekly-to-monthly book actually sits in. */
const T = 30 / 365
const RATE = 0.065

/**
 * Bisection stops when the REPRICE lands within 1e-6 of the quote. At this
 * tenor a 1.0 move in vol is worth ~₹80 of premium, so 1e-6 of price is ~1e-8
 * of vol; 1e-6 leaves two orders of magnitude of headroom and still fails any
 * real disagreement (a skew point differs in the third decimal, not the sixth).
 */
const IV: Tolerance = { abs: 1e-6, rel: 0 }

/**
 * Collect, then report once — the fourth copy of this helper in the repo (see
 * `expiry.test.ts`). A chain suite asserts one field per strike per type, and
 * "every PE row is 'none'" is a diagnosis the first throw alone would not give.
 */
function reportAll(fails: readonly string[], what: string): void {
  assert.equal(
    fails.length,
    0,
    `${fails.length} ${what} mismatches:\n` +
      fails.slice(0, 20).join('\n') +
      (fails.length > 20 ? `\n… and ${fails.length - 20} more` : ''),
  )
}

/** A chain row priced AT a known vol — the only way to have an expected answer. */
function quote(strike: number, type: OptionType, vol: number, ageMs = 0): ChainQuoteLite {
  return {
    strike,
    type,
    price: b76Price({ future: FUTURE, strike, t: T, vol, rate: RATE, type }),
    ageMs,
  }
}

/** A chain row whose quote no vol can explain: priced far below intrinsic. */
function junkQuote(strike: number, type: OptionType, price = 0, ageMs = 0): ChainQuoteLite {
  return { strike, type, price, ageMs }
}

function row(solved: readonly SolvedIv[], strike: number, type: OptionType): SolvedIv {
  const found = solved.find((s) => s.strike === strike && s.type === type)
  assert.ok(found !== undefined, `no solved row for ${strike}${type}`)
  return found
}

// --------------------------------------------------------------- the happy path

test('a fresh quote at every strike solves back to the vol it was priced at', () => {
  const wanted: readonly (readonly [number, number])[] = [
    [680, 0.3],
    [700, 0.28],
    [720, 0.26],
  ]
  const solved = solveChainIvs(
    wanted.map(([k, v]) => quote(k, 'CE', v)),
    FUTURE,
    T,
    RATE,
  )

  assert.equal(solved.length, 3)
  const fails: string[] = []
  for (const [k, v] of wanted) {
    const r = row(solved, k, 'CE')
    if (r.source !== 'quote') fails.push(`${k}CE.source: want quote, got ${r.source}`)
    if (r.iv === null || !close(r.iv, v, IV)) fails.push(`${k}CE.iv: want ${v}, got ${r.iv}`)
  }
  reportAll(fails, 'solved chain')

  // Ascending in strike regardless of the order they arrived in — the array is
  // rendered as a chain, and a caller that zips it against its own sorted list
  // must not have to sort it first.
  const shuffled = solveChainIvs(
    [quote(720, 'CE', 0.26), quote(680, 'CE', 0.3), quote(700, 'CE', 0.28)],
    FUTURE,
    T,
    RATE,
  )
  assert.deepEqual(
    shuffled.map((s) => s.strike),
    [680, 700, 720],
  )
})

// ------------------------------------------------------------------- fallbacks

test('a stale quote is interpolated from its solved neighbours, never trusted', () => {
  // The middle strike is priced at a preposterous 90% vol and stamped 5 minutes
  // old. If age were ignored it would come back as 0.9; read correctly it is
  // discarded and rebuilt from 680/720 — equidistant, so the plain average.
  const solved = solveChainIvs(
    [quote(680, 'CE', 0.3), quote(700, 'CE', 0.9, 5 * 60_000), quote(720, 'CE', 0.26)],
    FUTURE,
    T,
    RATE,
  )
  const mid = row(solved, 700, 'CE')
  assert.equal(mid.source, 'interp')
  assert.ok(mid.iv !== null && close(mid.iv, 0.28, IV), `want 0.28, got ${mid.iv}`)
  // The wings are untouched — a fallback must not spread.
  assert.equal(row(solved, 680, 'CE').source, 'quote')
  assert.equal(row(solved, 720, 'CE').source, 'quote')
})

test('a quote no vol can explain falls back the same way a stale one does', () => {
  // 680CE against a 700 future is ~₹20 of intrinsic; ₹5 is below the
  // no-arbitrage floor and `b76ImpliedVol` returns null there.
  const solved = solveChainIvs(
    [quote(660, 'CE', 0.32), junkQuote(680, 'CE', 5), quote(700, 'CE', 0.28)],
    FUTURE,
    T,
    RATE,
  )
  const mid = row(solved, 680, 'CE')
  assert.equal(mid.source, 'interp')
  assert.ok(mid.iv !== null && close(mid.iv, 0.3, IV), `want 0.30, got ${mid.iv}`)
})

test('one solved neighbour is carried flat, on whichever side has one', () => {
  const upper = solveChainIvs(
    [quote(680, 'CE', 0.3), junkQuote(700, 'CE'), junkQuote(720, 'CE')],
    FUTURE,
    T,
    RATE,
  )
  for (const k of [700, 720]) {
    const r = row(upper, k, 'CE')
    assert.equal(r.source, 'interp', `${k}CE`)
    assert.ok(r.iv !== null && close(r.iv, 0.3, IV), `${k}CE: want 0.30, got ${r.iv}`)
  }

  const lower = solveChainIvs(
    [junkQuote(680, 'CE'), junkQuote(700, 'CE'), quote(720, 'CE', 0.26)],
    FUTURE,
    T,
    RATE,
  )
  for (const k of [680, 700]) {
    const r = row(lower, k, 'CE')
    assert.equal(r.source, 'interp', `${k}CE`)
    assert.ok(r.iv !== null && close(r.iv, 0.26, IV), `${k}CE: want 0.26, got ${r.iv}`)
  }
})

test('with nothing to interpolate from, the answer is null and says so', () => {
  const solved = solveChainIvs([junkQuote(680, 'CE', 5)], FUTURE, T, RATE)
  assert.deepEqual(solved, [{ strike: 680, type: 'CE', iv: null, source: 'none' }])
  assert.equal(ivFor(solved, 680, 'CE'), null)
})

test('CE and PE are two surfaces and never borrow from each other', () => {
  const solved = solveChainIvs(
    [quote(700, 'CE', 0.28), junkQuote(700, 'PE'), junkQuote(720, 'PE')],
    FUTURE,
    T,
    RATE,
  )
  assert.equal(row(solved, 700, 'CE').source, 'quote')
  const fails: string[] = []
  for (const k of [700, 720]) {
    const r = row(solved, k, 'PE')
    if (r.source !== 'none' || r.iv !== null) {
      fails.push(`${k}PE borrowed from the call surface: ${r.source} ${r.iv}`)
    }
  }
  reportAll(fails, 'cross-type leak')
})

// ------------------------------------------------------------------- freshness

test('the freshness cut is inclusive, and movable', () => {
  const chain = (ageMs: number): readonly SolvedIv[] =>
    solveChainIvs(
      [quote(680, 'CE', 0.3), quote(700, 'CE', 0.9, ageMs), quote(720, 'CE', 0.26)],
      FUTURE,
      T,
      RATE,
    )

  // Exactly at the default 120s bound the quote is still the best evidence there is.
  const atBound = row(chain(120_000), 700, 'CE')
  assert.equal(atBound.source, 'quote')
  assert.ok(atBound.iv !== null && close(atBound.iv, 0.9, IV))

  // One millisecond past it, it is junk.
  const past = row(chain(120_001), 700, 'CE')
  assert.equal(past.source, 'interp')
  assert.ok(past.iv !== null && close(past.iv, 0.28, IV))

  // And the bound is the caller's to set — a book being marked after the close
  // wants a wider one, a scalper a much tighter one.
  const tight = solveChainIvs(
    [quote(680, 'CE', 0.3), quote(700, 'CE', 0.9, 1), quote(720, 'CE', 0.26)],
    FUTURE,
    T,
    RATE,
    { maxAgeMs: 0 },
  )
  assert.equal(row(tight, 700, 'CE').source, 'interp')
})

// ----------------------------------------------------------------------- ivFor

test('ivFor answers for strikes the chain never quoted, and admits when it cannot', () => {
  const solved = solveChainIvs(
    [quote(680, 'CE', 0.3), quote(700, 'CE', 0.28), quote(720, 'CE', 0.26)],
    FUTURE,
    T,
    RATE,
  )

  const exact = ivFor(solved, 700, 'CE')
  assert.ok(exact !== null && close(exact, 0.28, IV), `exact: ${exact}`)

  // Halfway between two quoted strikes — the case a leg struck off the chain's
  // own ladder (a rolled-in position, a 5-point strike on a 10-point chain) hits.
  const between = ivFor(solved, 690, 'CE')
  assert.ok(between !== null && close(between, 0.29, IV), `690: ${between}`)

  // Outside the quoted range the nearest value is carried FLAT. Extrapolating
  // the skew's slope past the last strike it was measured on is how a wing
  // acquires a negative vol.
  const above = ivFor(solved, 900, 'CE')
  assert.ok(above !== null && close(above, 0.26, IV), `900: ${above}`)
  const below = ivFor(solved, 500, 'CE')
  assert.ok(below !== null && close(below, 0.3, IV), `500: ${below}`)

  // Nothing on the put surface, and nothing at all.
  assert.equal(ivFor(solved, 700, 'PE'), null)
  assert.equal(ivFor([], 700, 'CE'), null)
})

// ----------------------------------------------------------------- fail-soft

test('a duplicated (strike, type) keeps the first row and does not double the chain', () => {
  const solved = solveChainIvs(
    [quote(700, 'CE', 0.28), quote(700, 'CE', 0.9)],
    FUTURE,
    T,
    RATE,
  )
  assert.equal(solved.length, 1)
  const only = row(solved, 700, 'CE')
  assert.ok(only.iv !== null && close(only.iv, 0.28, IV), `want 0.28, got ${only.iv}`)
})

test('junk in the chain is dropped, not thrown and not solved', () => {
  const junk = [
    null,
    undefined,
    'not a quote',
    { strike: Number.NaN, type: 'CE', price: 20, ageMs: 0 },
    { strike: 700, type: 'XX', price: 20, ageMs: 0 },
    { strike: -700, type: 'CE', price: 20, ageMs: 0 },
    { strike: 700, type: 'CE', price: Number.NaN, ageMs: 0 },
    { strike: 720, type: 'CE', price: 20, ageMs: Number.NaN },
  ] as unknown as readonly ChainQuoteLite[]

  const solved = solveChainIvs(junk, FUTURE, T, RATE)
  // Only the two rows that carry a usable (strike, type) key survive, and
  // neither has evidence behind it: an unreadable price and an unreadable age
  // are both "no quote".
  assert.deepEqual(solved, [
    { strike: 700, type: 'CE', iv: null, source: 'none' },
    { strike: 720, type: 'CE', iv: null, source: 'none' },
  ])
  assert.deepEqual(solveChainIvs(undefined as unknown as ChainQuoteLite[], FUTURE, T, RATE), [])
})

test('an unusable future or tenor solves nothing rather than inventing a surface', () => {
  const chain = [quote(680, 'CE', 0.3), quote(700, 'CE', 0.28), quote(720, 'CE', 0.26)]
  for (const [what, solved] of [
    ['future 0', solveChainIvs(chain, 0, T, RATE)],
    ['future NaN', solveChainIvs(chain, Number.NaN, T, RATE)],
    ['expired', solveChainIvs(chain, FUTURE, 0, RATE)],
  ] as const) {
    assert.equal(solved.length, 3, what)
    assert.ok(
      solved.every((s) => s.iv === null && s.source === 'none'),
      `${what}: ${JSON.stringify(solved)}`,
    )
  }
})

test('the rate defaults to the desk rate when the caller omits it', () => {
  const chain = [quote(700, 'CE', 0.28)]
  const explicit = solveChainIvs(chain, FUTURE, T, 0.065)
  const implied = solveChainIvs(chain, FUTURE, T)
  assert.deepEqual(implied, explicit)
})
