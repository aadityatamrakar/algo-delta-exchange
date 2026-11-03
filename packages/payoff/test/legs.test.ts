/**
 * The leg: signed shares, Black-76 off the future, and no way to throw.
 *
 * These are HAND cases, not parity cases — `expiry.test.ts` next door does the
 * number-for-number diff against the Python desk. What this file pins down is
 * the contract the rest of the cockpit is written against:
 *
 *   - `qty` is SIGNED SHARES. The Python carries `lots` + `lot_size` + a `side`
 *     string and multiplies them back together in five places; a signed number
 *     cannot be assembled wrongly at the sixth call site.
 *   - `legPnl` is EXACTLY `qty · (b76Price − entry)` — asserted against a direct
 *     `b76Price` call with `===`, not a tolerance, because any tolerance here
 *     would also pass a leg that quietly priced off spot instead of the future.
 *   - `legGreeks` is already qty-scaled, so a book is a plain sum.
 *   - fail-soft is a REQUIREMENT, not politeness: this runs inside a payoff
 *     surface that walks hundreds of futures prices, and one unpriceable leg
 *     must cost that walk a zero, not a stack trace.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, b76Greeks } from '@algomaker/greeks'
import { fromPyLeg, legPnl, legGreeks, type PayoffLeg } from '../src/legs.ts'

/** The short 700CE the fixtures are built around, as a TS leg. */
const SHORT_CE: PayoffLeg = {
  id: 's_ce_700',
  instrument: 'option',
  qty: -1000,
  strike: 700,
  type: 'CE',
  expiry: '2026-08-25',
  entry: 8.4,
  iv: 0.28,
}

const LONG_FUT: PayoffLeg = {
  id: 'b_fut',
  instrument: 'future',
  qty: 1000,
  strike: null,
  type: null,
  expiry: '2026-08-25',
  entry: 662,
  iv: null,
}

const F = 700
const T = 0.02
const RATE = 0.065

const mark = (vol: number, future = F, t = T): number =>
  b76Price({ future, strike: 700, t, vol, rate: RATE, type: 'CE' })

test('an option leg is exactly qty x (black-76 mark - entry)', () => {
  const px = mark(0.28)
  assert.equal(legPnl(SHORT_CE, F, T), -1000 * (px - 8.4))
  // ATM with 7 days to run, a 28-vol call is worth well over the ₹8.40 this
  // leg was sold for — so the short is under water, and the sign has to say so.
  assert.ok(px > 8.4, `expected the ATM mark ${px} to exceed the ₹8.40 entry`)
  assert.ok(legPnl(SHORT_CE, F, T) < 0)
})

test('the same leg is in profit once the mark falls below its entry', () => {
  // Far out of the money and nearly expired: the call is worth ~nothing, so the
  // short keeps essentially the whole credit.
  const px = mark(0.28, 600, 0.002)
  assert.ok(px < 8.4)
  const pnl = legPnl(SHORT_CE, 600, 0.002)
  assert.equal(pnl, -1000 * (px - 8.4))
  assert.ok(pnl > 0)
  // ... and never more than the credit itself.
  assert.ok(pnl <= 1000 * 8.4)
})

test('a future leg is linear in F and needs no model at all', () => {
  assert.equal(legPnl(LONG_FUT, 670, T), 8000)
  assert.equal(legPnl(LONG_FUT, 682, T), 20000)
  // Twice the move, twice the money — and vol/time/rate cannot enter.
  assert.equal(legPnl(LONG_FUT, 682, 0.9, 0.2), 20000)
  const short: PayoffLeg = { ...LONG_FUT, qty: -1000 }
  assert.equal(legPnl(short, 670, T), -8000)
})

test('ivOverride reprices without the caller cloning the leg', () => {
  const at50 = legPnl(SHORT_CE, F, T, RATE, 0.5)
  assert.equal(at50, -1000 * (mark(0.5) - 8.4))
  // A fatter vol makes a short call worse, which is the whole point of the
  // scenario grid this argument exists for.
  assert.ok(at50 < legPnl(SHORT_CE, F, T))
  // The default really is "use the leg's own iv", not "use nothing".
  assert.equal(legPnl(SHORT_CE, F, T, RATE, undefined), legPnl(SHORT_CE, F, T))
})

test('the rate defaults to 0.065, the desk-wide risk-free', () => {
  assert.equal(legPnl(SHORT_CE, F, T), legPnl(SHORT_CE, F, T, 0.065))
  assert.deepEqual(legGreeks(SHORT_CE, F, T), legGreeks(SHORT_CE, F, T, 0.065))
})

test('greeks come back already scaled by the signed qty', () => {
  const per = b76Greeks({ future: F, strike: 700, t: T, vol: 0.28, rate: RATE, type: 'CE' })
  const got = legGreeks(SHORT_CE, F, T)
  assert.equal(got.delta, per.delta * -1000)
  assert.equal(got.gamma, per.gamma * -1000)
  assert.equal(got.theta, per.theta * -1000)
  assert.equal(got.vega, per.vega * -1000)
  // A short call: short delta, short gamma, short vega, and time is the friend.
  assert.ok(got.delta < 0)
  assert.ok(got.gamma < 0)
  assert.ok(got.vega < 0)
  assert.ok(got.theta > 0)
})

test('a long put is the mirror: short delta, LONG gamma and vega', () => {
  const put: PayoffLeg = { ...SHORT_CE, id: 'b_pe_620', qty: 1000, strike: 620, type: 'PE' }
  const got = legGreeks(put, F, T)
  assert.ok(got.delta < 0)
  assert.ok(got.gamma > 0)
  assert.ok(got.vega > 0)
  assert.ok(got.theta < 0)
})

test('a future leg carries its qty as delta and nothing else', () => {
  assert.deepEqual(legGreeks(LONG_FUT, F, T), { delta: 1000, gamma: 0, theta: 0, vega: 0 })
  assert.deepEqual(legGreeks({ ...LONG_FUT, qty: -2000 }, F, T), {
    delta: -2000,
    gamma: 0,
    theta: 0,
    vega: 0,
  })
})

test('an unpriceable option degrades to zero, it does not throw', () => {
  const ZERO = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  for (const bad of [
    { ...SHORT_CE, iv: null },
    { ...SHORT_CE, strike: null },
    { ...SHORT_CE, type: null },
  ] satisfies PayoffLeg[]) {
    assert.equal(legPnl(bad, F, T), 0, `pnl for ${JSON.stringify(bad)}`)
    assert.deepEqual(legGreeks(bad, F, T), ZERO)
  }
  // An iv override rescues the null-iv leg; it cannot rescue a null strike.
  assert.ok(legPnl({ ...SHORT_CE, iv: null }, F, T, RATE, 0.28) !== 0)
  assert.equal(legPnl({ ...SHORT_CE, strike: null }, F, T, RATE, 0.28), 0)
})

test('junk numbers degrade too — NaN never reaches the surface', () => {
  const ZERO = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  assert.equal(legPnl(SHORT_CE, Number.NaN, T), 0)
  assert.equal(legPnl(SHORT_CE, F, Number.NaN), 0)
  assert.equal(legPnl({ ...SHORT_CE, entry: Number.NaN }, F, T), 0)
  assert.equal(legPnl({ ...SHORT_CE, qty: Number.NaN }, F, T), 0)
  assert.equal(legPnl(LONG_FUT, Number.POSITIVE_INFINITY, T), 0)
  assert.deepEqual(legGreeks(SHORT_CE, Number.NaN, T), ZERO)
  assert.deepEqual(legGreeks(LONG_FUT, Number.NaN, T), ZERO)
  // Not an instrument we know: zero, not a guess.
  const alien = { ...SHORT_CE, instrument: 'swap' } as unknown as PayoffLeg
  assert.equal(legPnl(alien, F, T), 0)
  assert.deepEqual(legGreeks(alien, F, T), ZERO)
})

test('fromPyLeg turns lots+lot_size+side into one signed share count', () => {
  const sold = fromPyLeg({
    instrument: 'option',
    side: 'Sell',
    lots: 2,
    lot_size: 1000,
    strike: 700.0,
    opt_type: 'CE',
    series: 'I',
    expiry: '2026-08-25',
    entry: 8.4,
    iv: 0.28,
    id: 's_ce_700',
  })
  // 2 lots x 1000 = 2000 shares, sold, so −2000. The one multiplication the
  // Python does at every call site, done once, here.
  assert.deepEqual(sold, { ...SHORT_CE, qty: -2000 })

  const bought = fromPyLeg({
    instrument: 'future',
    side: 'Buy',
    lots: 1,
    lot_size: 1000,
    strike: null,
    opt_type: null,
    expiry: '2026-08-25',
    entry: 662.0,
    iv: null,
    id: 'b_fut',
  })
  assert.deepEqual(bought, LONG_FUT)
})

test('fromPyLeg is fail-soft on a dict the Python would have skipped', () => {
  const junk = fromPyLeg({ instrument: 'option', side: 'Sell', lots: 'two', lot_size: 1000 })
  assert.equal(junk.qty, 0)
  assert.equal(junk.entry, 0)
  assert.equal(junk.strike, null)
  assert.equal(junk.type, null)
  assert.equal(junk.iv, null)
  // A leg with no qty contributes nothing anywhere, which is the point.
  assert.equal(legPnl(junk, F, T), 0)
  assert.equal(fromPyLeg({}).qty, 0)
})
