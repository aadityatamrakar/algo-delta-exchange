/**
 * THE WEEKLY'S OWN FORWARD (six-playbooks spec F1), PINNED ON SYNTHETIC CHAINS.
 *
 * `ChainSnap.spot` was the near-month future's mid for every book, and the
 * weekly's own parity forward sat a median 308 points below it on SENSEX: every
 * ATM, every delta and every band strike was picked off the wrong forward.
 * `parityForward` is the replacement, and each block below is one way it could
 * quietly hand the books a wrong number instead of none:
 *
 *   1. THE ARITHMETIC. Put-call parity on a future is `C - P = e^{-rT}(F - K)`,
 *      so each strike implies `F = K + (C - P) e^{rT}`. A chain priced by
 *      Black-76 at a known F must give that F back.
 *   2. ONE BAD STRIKE. A stale or fat-fingered wing moves a mean by a sixth of
 *      its error; a median does not move at all. The read is a median.
 *   3. TOO LITTLE CHAIN. Below three strikes there is no median to speak of,
 *      and the answer is "no read" (the host falls back to index x carry).
 *   4. A NUMBER THAT CANNOT BE TRUE. A forward 1% off the index on a weekly is
 *      not a forward, it is a broken quote set; the sanity band refuses it.
 *
 * The chain is built from real `b76Price` marks, never hand-typed, so every
 * forward below is derived rather than asserted into existence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import {
  PARITY_MIN_STRIKES,
  PARITY_QUOTE_AGE_MS,
  PARITY_STRIKES,
  RISK_FREE,
  carryForward,
  parityForward,
  type ForwardInput,
  type OptType,
  type Quote,
  type StrikeQuote,
} from '@algomaker/desk-engine'

const DATE = '2026-10-16' // a Friday
const EXPIRY = '2026-10-19' // the Monday after: three calendar days
const MINUTE = 600 // 10:00 IST
const NOW = Date.parse(`${DATE}T04:30:00.000Z`) // 10:00 IST as an epoch
const T3 = 3 / 365 // the tenor `yearFrac` prices a 3-DTE contract at
const VOL = 0.12
const INDEX = 23_000
const STEP = 50
/** The forward the board is priced at: 20 points of carry-and-basis above the
 * index, the shape a NIFTY weekly has. */
const FWD = 23_020

const LADDER = Array.from({ length: 21 }, (_, i) => 22_500 + i * STEP)

/** A two-sided book ₹1 wide whose MID is `mid` exactly, quoted at `asOf`. */
function book(mid: number, asOf = NOW): Quote {
  return { bid: mid - 0.5, ask: mid + 0.5, ltp: null, asOf }
}

function priceAt(fwd: number, strike: number, type: OptType): number {
  return b76Price({ future: fwd, strike, t: T3, vol: VOL, rate: RISK_FREE, type })
}

/** The whole ladder priced by Black-76 at `fwd`, with `edit` applied per row. */
function chainAt(
  fwd: number,
  edit: (row: StrikeQuote) => StrikeQuote = (row) => row,
): StrikeQuote[] {
  return LADDER.map((strike) =>
    edit({
      strike,
      ce: book(priceAt(fwd, strike, 'CE')),
      pe: book(priceAt(fwd, strike, 'PE')),
    }),
  )
}

function inputOf(strikes: readonly StrikeQuote[], over: Partial<ForwardInput> = {}): ForwardInput {
  return {
    strikes,
    index: INDEX,
    step: STEP,
    nowMs: NOW,
    dateIst: DATE,
    expiry: EXPIRY,
    minuteOfDay: MINUTE,
    ...over,
  }
}

/** Break the named strikes' CE wing, leaving every other row clean. */
const withoutCe = (strikes: readonly number[]) => (row: StrikeQuote): StrikeQuote =>
  strikes.includes(row.strike) ? { ...row, ce: null } : row

// ───────────────────────────────────────────────────────────── the constants

test('the constants are the spec`s: six strikes, at least three, quotes 10 s fresh', () => {
  assert.equal(PARITY_STRIKES, 6)
  assert.equal(PARITY_MIN_STRIKES, 3)
  assert.equal(PARITY_QUOTE_AGE_MS, 10_000)
})

// ───────────────────────────────────────────────────────────── the arithmetic

test('a clean chain gives back the forward it was priced at, off all six strikes', () => {
  const read = parityForward(inputOf(chainAt(FWD)))
  assert.ok(read !== null, 'a clean chain must read')
  assert.ok(Math.abs(read.forward - FWD) <= 1, `forward ${read.forward}, priced at ${FWD}`)
  assert.equal(read.strikesUsed, 6)
})

test('carryForward is the index carried at the desk rate over the contract`s tenor', () => {
  const f = carryForward(23_000, '2026-10-16', '2026-10-19', 600)
  assert.ok(Math.abs(f - 23_000 * Math.exp(0.065 * 3 / 365)) < 1e-9, `got ${f}`)
})

// ────────────────────────────────────────────────────────── one bad strike

test('one strike with a CE mid off by +40 does not move the median by more than 2', () => {
  const bad = (row: StrikeQuote): StrikeQuote =>
    row.strike === 23_000 && row.ce !== null
      ? { ...row, ce: book(priceAt(FWD, 23_000, 'CE') + 40) }
      : row
  const read = parityForward(inputOf(chainAt(FWD, bad)))
  assert.ok(read !== null)
  assert.ok(Math.abs(read.forward - FWD) <= 2, `the outlier moved the read to ${read.forward}`)
  assert.equal(read.strikesUsed, 6, 'an outlier still counts — it is the median that ignores it')
})

test('an even count is the mean of the middle two; an odd count is the middle one', () => {
  // Four usable strikes whose parity values are set by hand: 23,010, 23,014,
  // 23,020 and 23,030 (the two outer candidates are one-sided and drop). The
  // median of four is (23,014 + 23,020) / 2 = 23,017; drop a fifth to three and
  // it is the middle value itself.
  const g = Math.exp(RISK_FREE * T3)
  const target = new Map<number, number>([
    [22_900, 23_010],
    [22_950, 23_014],
    [23_000, 23_020],
    [23_050, 23_030],
  ])
  const shaped = (row: StrikeQuote): StrikeQuote => {
    const f = target.get(row.strike)
    if (f === undefined) return { ...row, ce: null }
    const put = 100
    return { ...row, ce: book(put + (f - row.strike) / g), pe: book(put) }
  }
  const four = parityForward(inputOf(chainAt(FWD, shaped)))
  assert.ok(four !== null)
  assert.equal(four.strikesUsed, 4)
  assert.ok(Math.abs(four.forward - 23_017) < 1e-6, `got ${four.forward}`)

  const three = parityForward(
    inputOf(chainAt(FWD, (row) => (row.strike === 23_050 ? { ...row, ce: null } : shaped(row)))),
  )
  assert.ok(three !== null)
  assert.equal(three.strikesUsed, 3)
  assert.ok(Math.abs(three.forward - 23_014) < 1e-6, `got ${three.forward}`)
})

// ─────────────────────────────────────────────────────── which strikes count

test('only 2 valid strikes is no read — and the read never reaches past the six nearest', () => {
  // The six nearest 23,000 are 23,000, 22,950, 23,050, 22,900, 23,100 and
  // 22,850. Four of them lose a wing; the 23,150 and 22,800 behind them are
  // clean but are not candidates, so two strikes are all there is.
  const read = parityForward(inputOf(chainAt(FWD, withoutCe([22_900, 22_950, 23_050, 23_100]))))
  assert.equal(read, null)
})

test('three valid strikes is enough', () => {
  const read = parityForward(inputOf(chainAt(FWD, withoutCe([22_950, 23_050, 23_100]))))
  assert.ok(read !== null)
  assert.equal(read.strikesUsed, 3)
  assert.ok(Math.abs(read.forward - FWD) <= 1)
})

test('a CE quote older than 10 s at a strike excludes that strike', () => {
  const stale = (row: StrikeQuote): StrikeQuote =>
    row.strike === 23_050 && row.ce !== null
      ? { ...row, ce: { ...row.ce, asOf: NOW - PARITY_QUOTE_AGE_MS - 1 } }
      : row
  const read = parityForward(inputOf(chainAt(FWD, stale)))
  assert.ok(read !== null)
  assert.equal(read.strikesUsed, 5)
})

test('a quote exactly 10 s old is still fresh, and a stale PE excludes its strike too', () => {
  const edge = (row: StrikeQuote): StrikeQuote =>
    row.strike === 23_050 && row.ce !== null
      ? { ...row, ce: { ...row.ce, asOf: NOW - PARITY_QUOTE_AGE_MS } }
      : row
  assert.equal(parityForward(inputOf(chainAt(FWD, edge)))?.strikesUsed, 6)

  const stalePut = (row: StrikeQuote): StrikeQuote =>
    row.strike === 22_950 && row.pe !== null
      ? { ...row, pe: { ...row.pe, asOf: NOW - PARITY_QUOTE_AGE_MS - 1 } }
      : row
  assert.equal(parityForward(inputOf(chainAt(FWD, stalePut)))?.strikesUsed, 5)
})

/** Replace one strike's PE wing, leaving every other row clean. */
const putAt = (strike: number, pe: Quote) => (row: StrikeQuote): StrikeQuote =>
  row.strike === strike ? { ...row, pe } : row

/** Replace one strike's CE wing, leaving every other row clean. */
const callAt = (strike: number, ce: Quote) => (row: StrikeQuote): StrikeQuote =>
  row.strike === strike ? { ...row, ce } : row

test('a one-sided, locked, crossed, wide or non-finite wing excludes its strike', () => {
  // The 22,850 PE is a cheap option (~₹38), so 3% of its mid is ~₹1.15 and the
  // ₹2 floor is the bar that applies.
  const mid = priceAt(FWD, 22_850, 'PE')
  assert.ok(mid * 0.03 < 2, `the fixture needs a cheap wing, got ${mid}`)
  const cases: Array<[string, Quote]> = [
    ['one-sided', { bid: null, ask: null, ltp: mid, asOf: NOW }],
    ['locked', { bid: mid, ask: mid, ltp: null, asOf: NOW }],
    ['crossed', { bid: mid + 1, ask: mid - 1, ltp: null, asOf: NOW }],
    ['wide', { bid: mid - 1.05, ask: mid + 1.05, ltp: null, asOf: NOW }],
    ['non-finite', { bid: Number.NaN, ask: mid, ltp: null, asOf: NOW }],
  ]
  for (const [name, pe] of cases) {
    const read = parityForward(inputOf(chainAt(FWD, putAt(22_850, pe))))
    assert.ok(read !== null, name)
    assert.equal(read.strikesUsed, 5, `${name}: the strike must not count`)
  }
  // ₹1.99 wide is inside the ₹2 floor.
  const inside = parityForward(
    inputOf(chainAt(FWD, putAt(22_850, { bid: mid - 0.995, ask: mid + 0.995, ltp: null, asOf: NOW }))),
  )
  assert.equal(inside?.strikesUsed, 6)
})

test('on a rich wing the bar is 3% of the mid, not ₹2', () => {
  // The 23,000 CE is ~₹110: 2.9% of it is wider than ₹2 and still counts, 3.1%
  // does not. The spread stays symmetric, so the mid — and the parity value —
  // does not move.
  const mid = priceAt(FWD, 23_000, 'CE')
  assert.ok(mid * 0.029 > 2, `the fixture needs a rich wing, got ${mid}`)
  const wide = (frac: number): Quote => ({
    bid: mid * (1 - frac / 2),
    ask: mid * (1 + frac / 2),
    ltp: null,
    asOf: NOW,
  })
  assert.equal(parityForward(inputOf(chainAt(FWD, callAt(23_000, wide(0.029)))))?.strikesUsed, 6)
  assert.equal(parityForward(inputOf(chainAt(FWD, callAt(23_000, wide(0.031)))))?.strikesUsed, 5)
})

test('a tie for the sixth candidate goes to the LOWER strike', () => {
  // 22,850 and 23,150 are both 150 from the index. Break the lower one: if it
  // was the candidate the read loses a strike; if the upper one was, it does not.
  const read = parityForward(inputOf(chainAt(FWD, withoutCe([22_850]))))
  assert.ok(read !== null)
  assert.equal(read.strikesUsed, 5)
  const upper = parityForward(inputOf(chainAt(FWD, withoutCe([23_150]))))
  assert.equal(upper?.strikesUsed, 6, '23,150 was never a candidate')
})

// ───────────────────────────────────────────────────────────── the sanity band

test('a parity value 1% from the index is no read — the sanity band', () => {
  // max(0.6% x 23,000, 2 x 50) = 138 points; a board priced at +1% is 230 off.
  assert.equal(parityForward(inputOf(chainAt(INDEX * 1.01))), null)
  assert.equal(parityForward(inputOf(chainAt(INDEX * 0.99))), null)
})

test('a forward inside the band reads, and the bar is the larger of its two terms', () => {
  // 100 points over on 23,000 is inside max(138, 100) = 138.
  const inside = parityForward(inputOf(chainAt(INDEX + 100)))
  assert.ok(inside !== null)
  assert.ok(Math.abs(inside.forward - (INDEX + 100)) <= 1)
  // 150 over is outside 138 on a 50-point step, but a 100-point step makes the
  // bar max(138, 2 x 100) = 200, and the same gap reads.
  assert.equal(parityForward(inputOf(chainAt(INDEX + 150))), null)
  assert.ok(parityForward(inputOf(chainAt(INDEX + 150), { step: 100 })) !== null)
})

// ───────────────────────────────────────────────────────────── garbage in

test('a non-finite or non-positive input anywhere is no read, never a number', () => {
  const clean = chainAt(FWD)
  const overs: Array<Partial<ForwardInput>> = [
    { index: Number.NaN },
    { index: 0 },
    { index: -23_000 },
    { step: Number.NaN },
    { step: 0 },
    { nowMs: Number.NaN },
    { minuteOfDay: Number.NaN },
  ]
  for (const over of overs) {
    assert.equal(parityForward(inputOf(clean, over)), null, JSON.stringify(over))
  }
  const badStrike = clean.map((row, i) => (i === 10 ? { ...row, strike: Number.NaN } : row))
  assert.equal(parityForward(inputOf(badStrike)), null, 'a ladder with a non-number strike is not a ladder')
  assert.equal(parityForward(inputOf([])), null, 'an empty chain')
})
