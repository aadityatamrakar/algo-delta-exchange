import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entrySequence,
  entryState,
  seedLegsFromFills,
  sideOf,
  suggestedLimit,
  suggestFromQuote,
  type EntryLeg,
} from '../src/entry-plan.ts'

const leg = (over: Partial<EntryLeg> & { strike: number; type: 'CE' | 'PE'; qty: number }): EntryLeg => ({
  tradingsymbol: `BAJFINANCE26AUG${over.strike}${over.type}`,
  instrumentToken: over.strike,
  ...over,
})

/** The condor, in the order an operator types it: shorts first, then wings. */
const CONDOR: EntryLeg[] = [
  leg({ strike: 1070, type: 'CE', qty: -3000 }),
  leg({ strike: 1030, type: 'PE', qty: -3000 }),
  leg({ strike: 1150, type: 'CE', qty: 3000 }),
  leg({ strike: 960, type: 'PE', qty: 3000 }),
]

test('sideOf reads the sign, not a separate field', () => {
  assert.equal(sideOf(leg({ strike: 1, type: 'CE', qty: -750 })), 'Sell')
  assert.equal(sideOf(leg({ strike: 1, type: 'CE', qty: 750 })), 'Buy')
})

test('WINGS ARE PLACED FIRST, whatever order they were typed in', () => {
  // The whole point. Shorts filling before their wings is a naked short
  // strangle; wings filling first only spends premium.
  const seq = entrySequence(CONDOR).map((l) => `${l.strike}${l.type}`)
  assert.deepEqual(seq, ['1150CE', '960PE', '1070CE', '1030PE'])
})

test('the typed order is preserved within each group', () => {
  const seq = entrySequence([
    leg({ strike: 960, type: 'PE', qty: 3000 }),
    leg({ strike: 1150, type: 'CE', qty: 3000 }),
  ]).map((l) => l.strike)
  assert.deepEqual(seq, [960, 1150])
})

test('a suggested limit CROSSES the touch, and lands on the tick grid', () => {
  // 2% of 28 = 0.56 -> 27.44 -> floored onto 0.05 for a sell.
  assert.equal(suggestedLimit('Sell', 28), 27.4)
  assert.equal(suggestedLimit('Buy', 28), 28.6)
  // The floor carries a cheap wing: 2% of 7 is 0.14, above the 0.10 minimum.
  assert.equal(suggestedLimit('Buy', 7), 7.15)
})

test('a tiny mark still crosses, via the tick floor', () => {
  // 2% of 1.50 is 0.03 — under one tick, so a percentage alone would leave the
  // order resting at the mark.
  assert.equal(suggestedLimit('Sell', 1.5), 1.4)
})

test('no usable mark yields null rather than an invented price', () => {
  for (const bad of [0, -1, Number.NaN]) {
    assert.equal(suggestedLimit('Buy', bad), null, String(bad))
  }
})

test('a SHORT FILLED WITHOUT ITS WING is reported as naked', () => {
  // THE STATE THIS SCREEN EXISTS FOR. 1070CE short filled, 1150CE wing did not.
  const st = entryState(CONDOR, [
    { tradingsymbol: 'BAJFINANCE26AUG1070CE', price: 28, qty: -3000 },
  ])
  assert.equal(st.nakedShorts.length, 1)
  assert.equal(st.nakedShorts[0]?.strike, 1070)
  assert.equal(st.canBuild, false)
})

test('a short IS covered once a long of the SAME option type has filled', () => {
  const st = entryState(CONDOR, [
    { tradingsymbol: 'BAJFINANCE26AUG1150CE', price: 7, qty: 3000 },
    { tradingsymbol: 'BAJFINANCE26AUG1070CE', price: 28, qty: -3000 },
  ])
  assert.deepEqual(st.nakedShorts, [])
})

test('a PE wing does not cover a CE short', () => {
  // Cover is per option type. A put wing bounds nothing on the call side, and
  // treating "some long exists" as cover would hide exactly the wrong case.
  const st = entryState(CONDOR, [
    { tradingsymbol: 'BAJFINANCE26AUG960PE', price: 7, qty: 3000 },
    { tradingsymbol: 'BAJFINANCE26AUG1070CE', price: 28, qty: -3000 },
  ])
  assert.equal(st.nakedShorts.length, 1)
  assert.equal(st.nakedShorts[0]?.type, 'CE')
})

test('canBuild demands EVERY leg, not merely the absence of naked shorts', () => {
  // Three of four filled, nothing naked — still not a book. Seeding a partial
  // structure hands the supervisor a position nobody chose.
  const st = entryState(CONDOR, [
    { tradingsymbol: 'BAJFINANCE26AUG1150CE', price: 7, qty: 3000 },
    { tradingsymbol: 'BAJFINANCE26AUG960PE', price: 7, qty: 3000 },
    { tradingsymbol: 'BAJFINANCE26AUG1070CE', price: 28, qty: -3000 },
  ])
  assert.deepEqual(st.nakedShorts, [])
  assert.equal(st.complete, false)
  assert.equal(st.canBuild, false)
  assert.equal(st.outstanding.length, 1)
})

test('a complete structure can be built', () => {
  const st = entryState(
    CONDOR,
    CONDOR.map((l) => ({ tradingsymbol: l.tradingsymbol, price: 10, qty: l.qty })),
  )
  assert.equal(st.complete, true)
  assert.equal(st.canBuild, true)
  assert.deepEqual(st.nakedShorts, [])
})

test('an empty structure is never buildable', () => {
  assert.equal(entryState([], []).canBuild, false)
})

test('seed legs carry the price that ACTUALLY filled, not the one requested', () => {
  const legs = seedLegsFromFills(CONDOR, [
    { tradingsymbol: 'BAJFINANCE26AUG1070CE', price: 27.4, qty: -3000 },
    { tradingsymbol: 'BAJFINANCE26AUG1030PE', price: 25.85, qty: -3000 },
    { tradingsymbol: 'BAJFINANCE26AUG1150CE', price: 7.15, qty: 3000 },
    { tradingsymbol: 'BAJFINANCE26AUG960PE', price: 7.2, qty: 3000 },
  ])
  assert.deepEqual(legs[0], { strike: 1070, type: 'CE', qty: -3000, rate: 27.4 })
  assert.equal(legs[2]?.rate, 7.15)
})

test('a missing fill THROWS rather than guessing a cost basis', () => {
  // Every P&L, target and scrap decision inherits the entry price. A book is
  // not worth creating from half-known prices.
  assert.throws(
    () => seedLegsFromFills(CONDOR, [{ tradingsymbol: 'BAJFINANCE26AUG1070CE', price: 28, qty: -3000 }]),
    /no fill recorded for BAJFINANCE26AUG1030PE/,
  )
})

// ------------------------------------------- suggestions from a live quote

test('a fresh quote yields a marketable suggestion', () => {
  const s = suggestFromQuote('Sell', { price: 28, ageMs: 1_200 })
  assert.equal(s.price, 27.4)
  assert.equal(s.reason, '')
})

test('A STALE MARK SUGGESTS NOTHING, and says why', () => {
  // Pre-filling from a twenty-minute-old print is worse than an empty box: the
  // box makes an operator look at the depth, the number invites a click.
  const s = suggestFromQuote('Sell', { price: 28, ageMs: 20 * 60_000 })
  assert.equal(s.price, null)
  assert.match(s.reason, /too stale/)
})

test('a missing quote suggests nothing rather than zero', () => {
  for (const q of [null, undefined]) {
    const s = suggestFromQuote('Buy', q)
    assert.equal(s.price, null)
    assert.match(s.reason, /no quote yet/)
  }
})

test('a quote with no usable price says so', () => {
  const s = suggestFromQuote('Buy', { price: 0, ageMs: 100 })
  assert.equal(s.price, null)
  assert.match(s.reason, /no usable price/)
})
