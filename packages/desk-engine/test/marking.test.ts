/**
 * MARKING, PINNED TO ARITHMETIC A HUMAN CAN CHECK.
 *
 * Every number below is either hand-derived or a difference the engine must
 * show between two pricing modes. That matters more here than anywhere else in
 * the package: a marking bug does not throw. It produces a plausible P&L, a
 * plausible delta, and a book that is steered — or locked — off a price nobody
 * would trade at. The two historical failures this file guards are named in
 * `src/marking.ts`; the tests are the executable half of that.
 *
 * The three that would otherwise pass silently:
 *
 *   1. `parity` and `live` must DISAGREE on the same short leg (+75 vs +50).
 *      A mode switch that changes nothing is a mode switch that was never
 *      wired, and the parity fixtures would then "match" Python for the wrong
 *      reason.
 *   2. A failed IV solve must surface as `hasGreeks: false`, NOT as a
 *      delta of 0.30 and not as a delta of 0.0 that reads like a flat book.
 *   3. `yearFrac` must refine intraday ONLY on the expiry session. Refining
 *      early shortens every pre-expiry tenor; refining never zeroes the whole
 *      greek set on the one day a 0-DTE book lives or dies by them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RISK_FREE,
  midOf,
  exitPrice,
  markPrice,
  yearFrac,
  markLeg,
  strikeGreeks,
  theoreticalPrice,
  type ChainSnap,
  type OptType,
  type Quote,
  type Side,
} from '@algomaker/desk-engine'
import { b76Price, b76Greeks } from '@algomaker/greeks'

const q = (bid: number | null, ask: number | null, ltp: number | null = null): Quote => ({
  bid,
  ask,
  ltp,
  asOf: 1,
})

const NONE: Quote = { bid: null, ask: null, ltp: null, asOf: 0 }

/** Seven calendar days to expiry — no intraday refinement anywhere in here. */
const DATE = '2026-08-21'
const EXPIRY = '2026-08-28'
const MINUTE = 600 // 10:00 IST
const T7 = 7 / 365

function chainOf(strikes: ChainSnap['strikes'], spot = 2400): ChainSnap {
  return {
    symbol: 'TCS',
    expiry: EXPIRY,
    step: 20,
    lotSize: 25,
    future: q(spot - 1, spot + 1),
    spot,
    strikes,
    asOf: 1,
  }
}

const leg = (over: Partial<Parameters<typeof markLeg>[0]> = {}) => ({
  instrument: 'TCS26AUG2400PE',
  strike: 2400,
  optType: 'PE' as OptType,
  side: 'Sell' as Side,
  lots: 2,
  lotSize: 25,
  entry: 10,
  openedByEngine: true,
  // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
  leanId: '',
  ...over,
})

// ── midOf / exitPrice / markPrice ───────────────────────────────────────────

test('midOf takes the mid of a two-sided book', () => {
  assert.equal(midOf(q(100, 102, 95)), 101)
})

test('midOf falls back to ltp only when the book is one-sided', () => {
  assert.equal(midOf(q(null, null, 95)), 95)
  assert.equal(midOf(q(100, null, 95)), 95)
})

test('midOf is null when nothing has ever been seen', () => {
  assert.equal(midOf(NONE), null)
})

test('exitPrice closes a short at the ask and a long at the bid', () => {
  assert.equal(exitPrice(q(8, 9), 'Sell'), 9)
  assert.equal(exitPrice(q(8, 9), 'Buy'), 8)
})

test('exitPrice never substitutes ltp — an unquoted leg is unpriced', () => {
  assert.equal(exitPrice(q(null, null, 8.5), 'Sell'), null)
  assert.equal(exitPrice(q(null, null, 8.5), 'Buy'), null)
})

test('markPrice in parity is mid-or-ltp and ignores the side', () => {
  const one = q(8, 9, 7)
  assert.equal(markPrice(one, 'parity', 'Sell'), 8.5)
  assert.equal(markPrice(one, 'parity', 'Buy'), 8.5)
  assert.equal(markPrice(q(null, null, 7), 'parity', 'Sell'), 7)
})

test('markPrice in live is the exit side', () => {
  assert.equal(markPrice(q(8, 9, 7), 'live', 'Sell'), 9)
  assert.equal(markPrice(q(8, 9, 7), 'live', 'Buy'), 8)
  assert.equal(markPrice(q(null, null, 7), 'live', 'Sell'), null)
})

// ── yearFrac ────────────────────────────────────────────────────────────────

test('the risk-free rate is the Python constant, exactly', () => {
  assert.equal(RISK_FREE, 0.065)
})

test('a later expiry is calendar days over 365, whatever the clock says', () => {
  assert.equal(yearFrac(DATE, EXPIRY, 600), T7)
  // 15:20 on a day that is not expiry must price the SAME tenor as 10:00.
  assert.equal(yearFrac(DATE, EXPIRY, 920), T7)
})

test('expiry day refines to the minutes left in the session', () => {
  // 10:00 -> 930 - 600 = 330 minutes of session left.
  assert.equal(yearFrac(EXPIRY, EXPIRY, 600), 330 / 1440 / 365)
})

test('expiry day never reaches zero — it floors at five minutes', () => {
  const floor = 5 / 1440 / 365
  assert.equal(yearFrac(EXPIRY, EXPIRY, 930), floor) // exactly the bell
  assert.equal(yearFrac(EXPIRY, EXPIRY, 1000), floor) // after it
})

test('a past expiry is zero', () => {
  assert.equal(yearFrac('2026-08-29', EXPIRY, 600), 0)
})

test('a date-shaped string that is no real day prices nothing rather than rolling over', () => {
  // Date.UTC would turn '2026-02-31' into 3 March and quietly add two days of
  // tenor. Zero here surfaces downstream as hasGreeks: false.
  assert.equal(yearFrac('2026-02-31', EXPIRY, 600), 0)
  assert.equal(yearFrac(DATE, '2026-13-45', 600), 0)
  assert.equal(yearFrac(DATE, '28-08-2026', 600), 0)
})

test('a malformed expiry leaves the leg valued but without greeks', () => {
  const chain = { ...chainOf([]), expiry: '2026-02-31' }
  const v = markLeg(leg(), q(8, 9), chain, DATE, MINUTE, 'live')
  assert.equal(v.mtm, 50)
  assert.equal(v.hasGreeks, false)
  assert.equal(v.iv, null)
})

// ── markLeg ─────────────────────────────────────────────────────────────────

test('parity marks a short at the mid: +(10-8.5) x 50 = +75', () => {
  const v = markLeg(leg(), q(8, 9), chainOf([]), DATE, MINUTE, 'parity')
  assert.equal(v.mtm, 75)
})

test('live marks the same short at the ask it must buy back at: +50', () => {
  const v = markLeg(leg(), q(8, 9), chainOf([]), DATE, MINUTE, 'live')
  assert.equal(v.mtm, 50)
})

test('live marks a long at the bid it would sell into', () => {
  const v = markLeg(leg({ side: 'Buy' }), q(8, 9), chainOf([]), DATE, MINUTE, 'live')
  // bought at 10, could sell at 8 -> -(2) x 50
  assert.equal(v.mtm, -100)
})

test('markLeg carries the leg identity and the pair it valued off', () => {
  const book = q(8, 9)
  const v = markLeg(leg(), book, chainOf([]), DATE, MINUTE, 'live')
  assert.equal(v.instrument, 'TCS26AUG2400PE')
  assert.equal(v.strike, 2400)
  assert.equal(v.optType, 'PE')
  assert.equal(v.side, 'Sell')
  assert.equal(v.lots, 2)
  assert.equal(v.lotSize, 25)
  assert.equal(v.entry, 10)
  assert.equal(v.openedByEngine, true)
  assert.deepEqual(v.exit, book)
})

test('an unpriced leg marks at zero and says so through an empty exit pair', () => {
  const v = markLeg(leg(), NONE, chainOf([]), DATE, MINUTE, 'live')
  assert.equal(v.mtm, 0)
  assert.equal(v.exit.bid, null)
  assert.equal(v.exit.ask, null)
  assert.equal(v.exit.ltp, null)
  assert.equal(v.hasGreeks, false)
  assert.equal(v.iv, null)
})

test('a quote under intrinsic has no IV: hasGreeks is false, never a 0.30 stand-in', () => {
  // 2600 PE against a 2400 future is 200 intrinsic; a 150 book cannot solve.
  const v = markLeg(leg({ strike: 2600 }), q(149, 151), chainOf([]), DATE, MINUTE, 'live')
  assert.equal(v.hasGreeks, false)
  assert.equal(v.iv, null)
  assert.equal(v.delta, 0)
  assert.equal(v.gamma, 0)
  assert.notEqual(v.delta, 0.3)
})

test('a leg whose greeks fail is still VALUED — the two are independent', () => {
  const v = markLeg(
    leg({ strike: 2600, entry: 160 }),
    q(149, 151),
    chainOf([]),
    DATE,
    MINUTE,
    'live',
  )
  assert.equal(v.hasGreeks, false)
  assert.equal(v.mtm, (160 - 151) * 50) // +450, off the ask
})

test('leg greeks solve off the MID even when the mark is the exit side', () => {
  // A book built so that its MID is exactly the Black-76 price at 30% vol.
  const vol = 0.3
  const mid = b76Price({ future: 2400, strike: 2400, t: T7, vol, rate: RISK_FREE, type: 'PE' })
  const v = markLeg(leg(), q(mid - 4, mid + 4), chainOf([]), DATE, MINUTE, 'live')
  assert.equal(v.hasGreeks, true)
  assert.ok(v.iv !== null && Math.abs(v.iv - vol) < 1e-4, `iv ${String(v.iv)}`)
  // Hand-derived ATM Black-76 put: |delta| = e^{-rt}N(-d1) = 0.99875 x 0.49171.
  assert.ok(Math.abs(v.delta - 0.4911) < 5e-4, `delta ${v.delta}`)
})

test('LegView.delta is an unsigned magnitude — the wings differ only in sign', () => {
  const vol = 0.3
  const put = b76Price({ future: 2400, strike: 2400, t: T7, vol, rate: RISK_FREE, type: 'PE' })
  const call = b76Price({ future: 2400, strike: 2400, t: T7, vol, rate: RISK_FREE, type: 'CE' })
  const p = markLeg(leg(), q(put - 4, put + 4), chainOf([]), DATE, MINUTE, 'live')
  const c = markLeg(leg({ optType: 'CE' }), q(call - 4, call + 4), chainOf([]), DATE, MINUTE, 'live')
  assert.ok(p.delta > 0, `put delta ${p.delta}`)
  assert.ok(c.delta > 0, `call delta ${c.delta}`)
  // e^{-rt}N(d1) + e^{-rt}N(-d1) = e^{-rt}
  assert.ok(Math.abs(p.delta + c.delta - Math.exp(-RISK_FREE * T7)) < 1e-6)
})

// ── strikeGreeks ────────────────────────────────────────────────────────────

test('strikeGreeks is null for a strike the chain does not carry — NOT 0.30', () => {
  const g = strikeGreeks(chainOf([{ strike: 2400, ce: q(30, 34), pe: q(30, 34) }]), 9999, 'CE', DATE, MINUTE)
  assert.equal(g, null)
})

test('strikeGreeks is null when the side has no book at all', () => {
  const chain = chainOf([{ strike: 2400, ce: null, pe: q(30, 34) }])
  assert.equal(strikeGreeks(chain, 2400, 'CE', DATE, MINUTE), null)
  assert.notEqual(strikeGreeks(chain, 2400, 'PE', DATE, MINUTE), null)
})

test('strikeGreeks is null when the IV will not solve — no fallback constant', () => {
  // 2600 PE at 150 against a 2400 future: under discounted intrinsic.
  const chain = chainOf([{ strike: 2600, ce: q(1, 2), pe: q(149, 151) }])
  const g = strikeGreeks(chain, 2600, 'PE', DATE, MINUTE)
  // Ordered before the null assert on purpose: `assert.equal` narrows `g` to
  // `null`, after which this line is unwritable. Python answered 0.30 here.
  assert.notEqual(g?.delta, 0.3)
  assert.equal(g, null)
})

test('strikeGreeks prices off the chain spot, RISK_FREE and the calendar tenor', () => {
  const vol = 0.3
  const px = b76Price({ future: 2400, strike: 2400, t: T7, vol, rate: RISK_FREE, type: 'CE' })
  const chain = chainOf([{ strike: 2400, ce: q(px - 4, px + 4), pe: q(1, 2) }])
  const g = strikeGreeks(chain, 2400, 'CE', DATE, MINUTE)
  assert.ok(g !== null)
  const want = b76Greeks({ future: 2400, strike: 2400, t: T7, vol, rate: RISK_FREE, type: 'CE' })
  assert.ok(Math.abs(g.delta - want.delta) < 1e-6, `delta ${g.delta}`)
  assert.ok(Math.abs(g.gamma - want.gamma) < 1e-9, `gamma ${g.gamma}`)
  // Hand-derived: e^{-rt}N(d1) = 0.99875 x 0.50829, gamma = e^{-rt}phi(d1)/(F sigma sqrt t).
  assert.ok(Math.abs(g.delta - 0.5077) < 5e-4, `delta ${g.delta}`)
  assert.ok(Math.abs(g.gamma - 0.0039952) < 2e-5, `gamma ${g.gamma}`)
})

test('strikeGreeks keeps the wing sign the Python chain carried', () => {
  const vol = 0.3
  const px = b76Price({ future: 2400, strike: 2400, t: T7, vol, rate: RISK_FREE, type: 'PE' })
  const chain = chainOf([{ strike: 2400, ce: q(1, 2), pe: q(px - 4, px + 4) }])
  const g = strikeGreeks(chain, 2400, 'PE', DATE, MINUTE)
  assert.ok(g !== null)
  assert.ok(g.delta < 0, `put strike delta ${g.delta}`)
  assert.ok(g.gamma > 0, `gamma ${g.gamma}`)
})

// ── PORTED FROM PYTHON — `_chain_greek` (`test_sim_recenter_shift.py:31-52`) ──
//
// Python's `_chain_greek(ctx, strike, opt_type, which)` reads ONE greek off a
// chain row and answers `None` for a missing strike or a missing greek. This
// engine's counterpart is `strikeGreeks`, and it is BOTH-OR-NULL by design
// (`marking.ts`): a row that can price a delta but not a gamma is not a
// candidate at all, because the deleted `dps = 0.30` stand-in is what used to
// fill exactly that hole. The three claims Python makes still hold; the fourth —
// "the fixture chain carries price + delta only, so gamma is None" — becomes
// "there is no such thing as half a measurement here", and that is the point.

/** A ladder around spot 2400 whose mids are the Black-76 price at 30 vol, so
 * every strike solves back to a real greek. */
function solvableChain(spot = 2400) {
  const strikes = [2360, 2380, 2400, 2420, 2440].map((k) => ({
    strike: k,
    ce: q(
      b76Price({ future: spot, strike: k, t: T7, vol: 0.3, rate: RISK_FREE, type: 'CE' }) * 0.98,
      b76Price({ future: spot, strike: k, t: T7, vol: 0.3, rate: RISK_FREE, type: 'CE' }) * 1.02,
    ),
    pe: q(
      b76Price({ future: spot, strike: k, t: T7, vol: 0.3, rate: RISK_FREE, type: 'PE' }) * 0.98,
      b76Price({ future: spot, strike: k, t: T7, vol: 0.3, rate: RISK_FREE, type: 'PE' }) * 1.02,
    ),
  }))
  return chainOf(strikes, spot)
}

test('PORTED: the strike greek is SIGNED BY WING — CE positive, PE negative', () => {
  // `test_chain_greek_reads_delta_like_chain_delta_did`. The sign is the wing's,
  // not the position's: `corridor.ts` applies the position sign itself, and a
  // reader that pre-applied one would double it.
  const chain = solvableChain()
  const ce = strikeGreeks(chain, 2420, 'CE', DATE, MINUTE)
  const pe = strikeGreeks(chain, 2380, 'PE', DATE, MINUTE)
  assert.ok(ce !== null && pe !== null)
  assert.ok(ce.delta > 0, `CE delta ${ce.delta} should be positive`)
  assert.ok(pe.delta < 0, `PE delta ${pe.delta} should be negative`)
  // Gamma is unsigned by wing — it is a curvature, and both wings curve the same
  // way — so the corridor takes the position sign alone.
  assert.ok(ce.gamma > 0 && pe.gamma > 0)
})

test('PORTED: a missing STRIKE and a missing WING are both null', () => {
  // `test_chain_greek_missing_strike_and_missing_greek_are_none`. Null, never a
  // fallback constant: an unpriceable strike is simply not a candidate (spec §5).
  const chain = solvableChain()
  assert.equal(strikeGreeks(chain, 99_999, 'CE', DATE, MINUTE), null)

  const oneSided = chainOf(
    [{ strike: 2400, ce: null, pe: q(30, 31) }],
    2400,
  )
  assert.equal(strikeGreeks(oneSided, 2400, 'CE', DATE, MINUTE), null)
  assert.notEqual(strikeGreeks(oneSided, 2400, 'PE', DATE, MINUTE), null)
})

test('PORTED: the whole greek set comes back TOGETHER or not at all', () => {
  // Python read each greek independently, so a row with a delta and no gamma
  // yielded half a measurement and the caller filled the rest in. Here a strike
  // whose mid does not imply a volatility yields NONE of them — the narrowing
  // `shift.ts` §2 names, in the conservative direction.
  const unpriceable = chainOf([{ strike: 2400, ce: q(0.001, 0.002), pe: q(30, 31) }], 2400)
  assert.equal(strikeGreeks(unpriceable, 2400, 'CE', DATE, MINUTE), null)

  const solvable = strikeGreeks(solvableChain(), 2400, 'CE', DATE, MINUTE)
  assert.ok(solvable !== null)
  // All five, from the single Black-76 solve. `theta` and `vega` joined the set
  // rather than being re-solved elsewhere; see `marking-greeks.test.ts`.
  assert.equal(Object.keys(solvable).sort().join(','), 'delta,gamma,iv,theta,vega')
})

// ── theoreticalPrice — the maker quote's price (spec §8) ────────────────────

test("the maker quote prices off the strike's OWN mid when it implies a vol", () => {
  // The gate refuses a book for being WIDE or OLD, not for being unpriceable —
  // so the ordinary maker-quote case is a strike that still implies its own
  // volatility, and the quote must be that contract's own model price.
  const iv = 0.28
  const px = b76Price({ future: 2400, strike: 2440, t: T7, rate: RISK_FREE, type: 'CE', vol: iv })
  // A 40-rupee-wide book around the model price: refused by the gate, perfectly
  // solvable as a mid.
  const chain = chainOf([{ strike: 2440, ce: q(px - 20, px + 20), pe: null }])

  const quote = theoreticalPrice(chain, 2440, 'CE', DATE, MINUTE)
  assert.ok(quote !== null)
  // The mid IS the model price here, so the solve round-trips to the same
  // number. Anything else means the quote was priced off another strike.
  assert.ok(Math.abs(quote - px) < 1e-4)
})

test('a strike with NO book of its own is priced off the nearest wing neighbour', () => {
  // The one-sided-book case: nothing to solve on the target strike, and a flat
  // vol guess is what this desk deleted. The neighbour's smile point is the
  // best measurement available.
  const iv = 0.3
  const near = b76Price({ future: 2400, strike: 2420, t: T7, rate: RISK_FREE, type: 'CE', vol: iv })
  const chain = chainOf([
    { strike: 2420, ce: q(near - 0.5, near + 0.5), pe: null },
    // The target: a bid and no ask, and no last print — nothing to solve.
    { strike: 2440, ce: q(5, null), pe: null },
  ])

  const quote = theoreticalPrice(chain, 2440, 'CE', DATE, MINUTE)
  assert.ok(quote !== null)
  const expected = b76Price({
    future: 2400,
    strike: 2440,
    t: T7,
    rate: RISK_FREE,
    type: 'CE',
    vol: iv,
  })
  // Priced AT THE TARGET STRIKE with the NEIGHBOUR's vol — not the neighbour's
  // price, which would quote a 2440 call at a 2420 call's premium.
  assert.ok(Math.abs(quote - expected) < 1e-3)
  assert.ok(quote < near)
})

test('nothing on the wing implies a vol: null, never a guessed number', () => {
  // Every CE quoted at or under discounted intrinsic — the shape a dead chain
  // takes. There is nothing to quote, and the caller must hold rather than
  // publish a price the engine could not measure.
  const chain = chainOf([
    { strike: 2380, ce: q(0.001, 0.002), pe: q(30, 31) },
    { strike: 2400, ce: q(0.001, 0.002), pe: q(30, 31) },
  ])
  assert.equal(theoreticalPrice(chain, 2400, 'CE', DATE, MINUTE), null)
  // The PE wing of the SAME chain is perfectly priceable: the scan is per wing,
  // and a call is never priced off a put's volatility.
  assert.notEqual(theoreticalPrice(chain, 2400, 'PE', DATE, MINUTE), null)
})
