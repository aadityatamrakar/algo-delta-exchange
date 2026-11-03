import test from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { bsPrice, greeks, yearsToExpiry } from '@algomaker/greeks'
import { selectOption, selectStrike, type Marks } from '../src/selector.ts'

// --- fixtures ---------------------------------------------------------------

let nextToken = 1000

const optionRow = (
  name: string,
  expiry: string,
  strike: number,
  type: 'CE' | 'PE',
  lotSize: number,
): InstrumentRow => ({
  instrument_token: nextToken++,
  tradingsymbol: `${name}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${strike}${type}`,
  name,
  expiry,
  strike,
  tick_size: 0.05,
  lot_size: lotSize,
  instrument_type: type,
  segment: 'NFO-OPT',
  exchange: 'NFO',
})

const chain = (
  name: string,
  expiry: string,
  strikes: readonly number[],
  lotSize: number,
  types: readonly ('CE' | 'PE')[] = ['CE', 'PE'],
): InstrumentRow[] =>
  strikes.flatMap((s) => types.map((t) => optionRow(name, expiry, s, t, lotSize)))

const BHEL_EXPIRY = '2026-08-27'
/**
 * A real-shaped BHEL chain: the grid is 5 wide here but the chain has a HOLE
 * between 510 and 530 — the strikes in between were never listed. Any arithmetic
 * walk lands in that hole.
 */
const BHEL_STRIKES = [495, 500, 505, 510, 530, 535] as const

const bhelMaster = new OptionMaster(chain('BHEL', BHEL_EXPIRY, BHEL_STRIKES, 5250))

const bhelInput = (spot: number) => ({
  master: bhelMaster,
  underlying: 'BHEL',
  expiry: BHEL_EXPIRY,
  spot,
  nowMs: Date.UTC(2026, 6, 27, 4, 0), // 09:30 IST
})

// --- ATM: nearest LISTED strike ---------------------------------------------

test('atm snaps to the nearest LISTED strike, not an arithmetic one', () => {
  assert.equal(selectStrike(bhelInput(511), { by: 'atm' }), 510)
  // 520 is equidistant from 510 and 530; neither 515 nor 520 is listed, and the
  // answer must be one that is.
  assert.equal(selectStrike(bhelInput(519), { by: 'atm' }), 510)
  assert.equal(selectStrike(bhelInput(524), { by: 'atm' }), 530)
  assert.equal(selectStrike(bhelInput(496), { by: 'atm' }), 495)
})

test('selectOption resolves the ATM contract with its real lot and tick size', () => {
  const sel = selectOption(bhelInput(511), { by: 'atm', type: 'PE' })
  assert.ok(sel !== null)
  assert.equal(sel.strike, 510)
  assert.equal(sel.type, 'PE')
  assert.equal(sel.instrument.lotSize, 5250)
  assert.equal(sel.instrument.tickSize, 0.05)
  assert.equal(sel.instrument.tradingsymbol, 'BHEL2608510PE')
})

test('an ATM CONTRACT without a type is null, not a guessed CE', () => {
  // The typeless question has a typeless answer, and it is a different call.
  assert.equal(selectOption(bhelInput(511), { by: 'atm' }), null)
  assert.equal(selectStrike(bhelInput(511), { by: 'atm' }), 510)
})

// --- offset: walks the LISTED grid, gaps and all ----------------------------

test('offset walks the listed grid ACROSS a gap', () => {
  // The whole point: +1 from 510 is 530, because 515/520/525 do not exist.
  assert.equal(selectStrike(bhelInput(511), { by: 'offset', steps: 1, type: 'CE' }), 530)
  assert.equal(selectStrike(bhelInput(511), { by: 'offset', steps: 2, type: 'CE' }), 535)
  assert.equal(selectStrike(bhelInput(511), { by: 'offset', steps: -1, type: 'PE' }), 505)
  assert.equal(selectStrike(bhelInput(511), { by: 'offset', steps: -3, type: 'PE' }), 495)
  assert.equal(selectStrike(bhelInput(511), { by: 'offset', steps: 0, type: 'CE' }), 510)
})

test('offset past the end of the chain returns null rather than clamping', () => {
  // Clamping to 535 would answer a much closer strike than "+3 OTM" implies.
  assert.equal(selectStrike(bhelInput(511), { by: 'offset', steps: 3, type: 'CE' }), null)
  assert.equal(selectStrike(bhelInput(511), { by: 'offset', steps: -4, type: 'PE' }), null)
  assert.equal(selectOption(bhelInput(511), { by: 'offset', steps: 9, type: 'CE' }), null)
})

test('steps are signed along the ascending grid, independent of CE/PE', () => {
  const ce = selectStrike(bhelInput(511), { by: 'offset', steps: 1, type: 'CE' })
  const pe = selectStrike(bhelInput(511), { by: 'offset', steps: 1, type: 'PE' })
  assert.equal(ce, pe, 'the type must not silently flip the direction of the walk')
})

// --- unlisted / unknown chains ----------------------------------------------

test('an unknown underlying or expiry is null everywhere', () => {
  const bad = { ...bhelInput(511), underlying: 'NOSUCH' }
  assert.equal(selectStrike(bad, { by: 'atm' }), null)
  assert.equal(selectOption(bad, { by: 'atm', type: 'CE' }), null)
  assert.equal(selectOption({ ...bhelInput(511), expiry: '2099-01-01' }, { by: 'atm', type: 'CE' }), null)
})

test('a strike that lists only one leg does not fabricate the other', () => {
  // 540 lists a CE and no PE — real chains are asymmetric at the wings.
  const master = new OptionMaster([
    ...chain('ASYM', BHEL_EXPIRY, [530, 535], 5250),
    ...chain('ASYM', BHEL_EXPIRY, [540], 5250, ['CE']),
  ])
  const input = { master, underlying: 'ASYM', expiry: BHEL_EXPIRY, spot: 539, nowMs: 0 }
  assert.ok(selectOption(input, { by: 'atm', type: 'CE' }) !== null)
  assert.equal(selectOption(input, { by: 'atm', type: 'PE' }), null, 'no phantom PE')
})

// --- delta ------------------------------------------------------------------

const NIFTY_EXPIRY = '2026-07-30'
const NIFTY_STRIKES = [24800, 24900, 25000, 25100, 25200, 25300, 25400]
const NIFTY_SPOT = 25000
const NOW_MS = Date.UTC(2026, 6, 27, 4, 0) // 09:30 IST, three days to expiry
const TRUE_VOL = 0.15
const RATE = 0.065

const niftyMaster = new OptionMaster(chain('NIFTY', NIFTY_EXPIRY, NIFTY_STRIKES, 75))

const niftyInput = (marks?: Marks) => ({
  master: niftyMaster,
  underlying: 'NIFTY',
  expiry: NIFTY_EXPIRY,
  spot: NIFTY_SPOT,
  nowMs: NOW_MS,
  rate: RATE,
  ...(marks === undefined ? {} : { marks }),
})

/** Marks generated from a KNOWN vol, so the expected delta is computable here. */
function niftyMarks(): Map<number, number> {
  const t = yearsToExpiry(NIFTY_EXPIRY, NOW_MS)
  const marks = new Map<number, number>()
  for (const strike of NIFTY_STRIKES) {
    for (const type of ['CE', 'PE'] as const) {
      const ref = niftyMaster.resolve('NIFTY', NIFTY_EXPIRY, strike, type)
      assert.ok(ref?.instrumentToken !== undefined)
      const price = bsPrice({ spot: NIFTY_SPOT, strike, t, vol: TRUE_VOL, rate: RATE, type })
      marks.set(ref.instrumentToken, Number(price.toFixed(2)))
    }
  }
  return marks
}

/** Independent expectation: argmin over |delta| at the vol the marks were built at. */
function closestByDelta(target: number, type: 'CE' | 'PE'): number {
  const t = yearsToExpiry(NIFTY_EXPIRY, NOW_MS)
  let best = NIFTY_STRIKES[0] as number
  let bestErr = Number.POSITIVE_INFINITY
  for (const strike of NIFTY_STRIKES) {
    const d = greeks({ spot: NIFTY_SPOT, strike, t, vol: TRUE_VOL, rate: RATE, type }).delta
    const err = Math.abs(Math.abs(d) - target)
    if (err < bestErr) {
      bestErr = err
      best = strike
    }
  }
  return best
}

test('delta selection picks the closest |delta| on the listed grid', () => {
  const marks = niftyMarks()
  for (const [target, type] of [
    [0.3, 'CE'],
    [0.5, 'CE'],
    [0.2, 'PE'],
    [0.45, 'PE'],
  ] as const) {
    const sel = selectOption(niftyInput(marks), { by: 'delta', target, type })
    assert.ok(sel !== null, `no selection for ${target} ${type}`)
    assert.equal(sel.strike, closestByDelta(target, type), `${target} ${type}`)
    assert.ok(sel.delta !== undefined && Math.abs(sel.delta - target) < 0.15)
  }
})

test('a 0.30-delta call is OTM and a 0.30-delta put is ITM-side of nothing', () => {
  const marks = niftyMarks()
  const ce = selectOption(niftyInput(marks), { by: 'delta', target: 0.3, type: 'CE' })
  const pe = selectOption(niftyInput(marks), { by: 'delta', target: 0.3, type: 'PE' })
  assert.ok(ce !== null && pe !== null)
  // The sanity check the legacy otmSelector failed: a 30-delta call must be
  // ABOVE spot and a 30-delta put BELOW it. Returning ATM for both is the bug.
  assert.ok(ce.strike > NIFTY_SPOT, `30d call landed at ${ce.strike}, not above ${NIFTY_SPOT}`)
  assert.ok(pe.strike < NIFTY_SPOT, `30d put landed at ${pe.strike}, not below ${NIFTY_SPOT}`)
  assert.notEqual(ce.strike, pe.strike)
})

test('delta selection is null when marks are missing — it never falls back to ATM', () => {
  assert.equal(selectOption(niftyInput(), { by: 'delta', target: 0.3, type: 'CE' }), null)
  assert.equal(selectStrike(niftyInput(), { by: 'delta', target: 0.3, type: 'CE' }), null)
  assert.equal(
    selectOption(niftyInput(new Map()), { by: 'delta', target: 0.3, type: 'CE' }),
    null,
    'an empty marks map is still no data',
  )
  // A zero / negative mark is a missing quote, not a free option.
  const zeros = new Map([...niftyMarks()].map(([k]) => [k, 0] as const))
  assert.equal(selectOption(niftyInput(zeros), { by: 'delta', target: 0.3, type: 'CE' }), null)
})

test('delta selection ignores strikes whose quote admits no implied vol', () => {
  // Only one strike carries a solvable quote; the rest are above the no-arbitrage
  // ceiling. The answer must be that one strike, not the nearest-to-spot.
  const t = yearsToExpiry(NIFTY_EXPIRY, NOW_MS)
  const marks = new Map<number, number>()
  for (const strike of NIFTY_STRIKES) {
    const ref = niftyMaster.resolve('NIFTY', NIFTY_EXPIRY, strike, 'CE')
    assert.ok(ref?.instrumentToken !== undefined)
    const priced = strike === 25300
    marks.set(
      ref.instrumentToken,
      priced ? bsPrice({ spot: NIFTY_SPOT, strike, t, vol: TRUE_VOL, rate: RATE, type: 'CE' }) : 1e9,
    )
  }
  const sel = selectOption(niftyInput(marks), { by: 'delta', target: 0.99, type: 'CE' })
  assert.ok(sel !== null)
  assert.equal(sel.strike, 25300)
})

test('delta selection is null after expiry rather than reporting a step delta', () => {
  const afterExpiry = { ...niftyInput(niftyMarks()), nowMs: Date.UTC(2026, 7, 1) }
  assert.equal(selectOption(afterExpiry, { by: 'delta', target: 0.3, type: 'CE' }), null)
})

// --- premium ----------------------------------------------------------------

test('premium selection picks the closest mark on the listed grid', () => {
  const marks = niftyMarks()
  const sel = selectOption(niftyInput(marks), { by: 'premium', target: 40, type: 'CE' })
  assert.ok(sel !== null)
  assert.ok(sel.premium !== undefined)

  let bestErr = Number.POSITIVE_INFINITY
  let bestStrike = 0
  for (const strike of NIFTY_STRIKES) {
    const ref = niftyMaster.resolve('NIFTY', NIFTY_EXPIRY, strike, 'CE')
    const mark = marks.get(ref?.instrumentToken as number)
    if (mark === undefined) continue
    const err = Math.abs(mark - 40)
    if (err < bestErr) {
      bestErr = err
      bestStrike = strike
    }
  }
  assert.equal(sel.strike, bestStrike)
  assert.equal(sel.premium, marks.get(sel.instrument.instrumentToken as number))
})

test('premium selection is null when there are no marks', () => {
  assert.equal(selectOption(niftyInput(), { by: 'premium', target: 40, type: 'CE' }), null)
})

test('a selection carries the mark when one exists and omits it when it does not', () => {
  const marks = niftyMarks()
  const withMark = selectOption(niftyInput(marks), { by: 'atm', type: 'CE' })
  assert.ok(withMark !== null)
  assert.ok(withMark.premium !== undefined && withMark.delta !== undefined)

  const noMark = selectOption(niftyInput(), { by: 'atm', type: 'CE' })
  assert.ok(noMark !== null, 'ATM needs no mark, so it still resolves')
  assert.equal(noMark.premium, undefined)
  assert.equal(noMark.delta, undefined)
})
