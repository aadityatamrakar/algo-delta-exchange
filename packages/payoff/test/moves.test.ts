/**
 * MOVES THAT BOOK THEIR OWN CLOSES.
 *
 * `applyMoves` is what stands between "the repairer proposed four legs" and a
 * payoff curve a human then trades on, so the two things this suite pins hardest
 * are the two that would turn a suggestion into a lie:
 *
 *   1. A move whose price is unknown is DROPPED, loudly. Never marked at the
 *      last-known, never at the entry, never at zero. A fabricated fill makes a
 *      repair look free, and the operator finds out at the broker.
 *   2. Closing a leg REALISES it. A shift that carried its short from 700 to 720
 *      and quietly forgot the ₹7,200 it paid to get out is the same lie with an
 *      extra step, and it is the one this desk actually made before (the shift
 *      leg looked like a free re-strike).
 *
 * The book is the strangle the fixtures use throughout this package — short
 * 700CE and short 620PE, 2 lots of 1000 — so the numbers below are hand-checkable
 * against the other suites.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { close as within, type Tolerance } from './helpers.ts'
import type { PayoffLeg } from '../src/legs.ts'
import { applyMoves, type Move } from '../src/moves.ts'

/**
 * Rupees on a ~₹20,000 move. Nothing here is approximate — `-2000 x (12 - 8.4)`
 * is exactly -7,200 in decimal and -7199.999999999999 in binary, and that is the
 * only gap this tolerance is ever asked to absorb.
 */
const RUPEES: Tolerance = { abs: 1e-9, rel: 1e-12 }
function money(actual: number, expected: number): void {
  assert.ok(within(actual, expected, RUPEES), `expected ${expected}, got ${actual}`)
}

const EXPIRY = '2026-08-25'

const CE: PayoffLeg = {
  id: 'ce700',
  instrument: 'option',
  qty: -2000,
  strike: 700,
  type: 'CE',
  expiry: EXPIRY,
  entry: 8.4,
  iv: 0.28,
}
const PE: PayoffLeg = {
  id: 'pe620',
  instrument: 'option',
  qty: -2000,
  strike: 620,
  type: 'PE',
  expiry: EXPIRY,
  entry: 6.1,
  iv: 0.31,
}
const BOOK = [CE, PE]

/** A chain that knows four strikes and nothing else. */
const MARKS = new Map<string, number>([
  ['700CE', 12],
  ['720CE', 5],
  ['620PE', 2],
  ['600PE', 3.3],
  ['730CE', 2.1],
])
const IVS = new Map<string, number>([
  ['700CE', 0.28],
  ['720CE', 0.26],
  ['620PE', 0.31],
  ['600PE', 0.33],
  ['730CE', 0.26],
])
const priceOf = (k: number, t: 'CE' | 'PE'): number | null => MARKS.get(`${k}${t}`) ?? null
const ivOf = (k: number, t: 'CE' | 'PE'): number | null => IVS.get(`${k}${t}`) ?? null

function apply(moves: readonly Move[], legs: readonly PayoffLeg[] = BOOK) {
  return applyMoves(legs, moves, priceOf, ivOf)
}

// ------------------------------------------------------------------- shift

test('a shift keeps the size, moves the strike, and books what the close cost', () => {
  const out = apply([{ op: 'shift', legId: 'ce700', toStrike: 720 }])
  assert.equal(out.warnings.length, 0, JSON.stringify(out.warnings))
  assert.equal(out.legs.length, 2)

  const moved = out.legs.find((l) => l.strike === 720)
  assert.ok(moved, 'the shifted leg should be in the book')
  // SAME qty — a shift is a re-strike, not a resize.
  assert.equal(moved.qty, -2000)
  assert.equal(moved.type, 'CE')
  assert.equal(moved.expiry, EXPIRY)
  // Entry is the CHAIN's price at the new strike, and the vol is the chain's too.
  assert.equal(moved.entry, 5)
  assert.equal(moved.iv, 0.26)
  // The old leg is gone, and only it.
  assert.equal(out.legs.filter((l) => l.id === 'ce700').length, 0)
  assert.ok(out.legs.some((l) => l.id === 'pe620'))

  // It cost 12 to buy back a short sold at 8.4: -2000 x (12 - 8.4).
  money(out.realisedDelta, -7200)
  // Paid 24,000 to close, collected 10,000 re-selling at 720.
  money(out.creditDelta, -14000)
})

test('a shift is all-or-nothing: no price at the landing strike leaves the book alone', () => {
  // The dangerous half-application. If the close landed and the re-sell did not,
  // the panel would draw a book that is one leg lighter than the real one —
  // which is precisely the naked-book failure the bot guards against when the
  // chain has no mark (playbooks.py:3867-3871).
  const out = apply([{ op: 'shift', legId: 'ce700', toStrike: 760 }])
  assert.deepEqual([...out.legs], BOOK)
  assert.equal(out.realisedDelta, 0)
  assert.equal(out.creditDelta, 0)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0]!, /760/)
})

test('a shift to the strike the leg already sits on is not a trade', () => {
  const out = apply([{ op: 'shift', legId: 'ce700', toStrike: 700 }])
  assert.deepEqual([...out.legs], BOOK)
  assert.equal(out.creditDelta, 0)
  assert.equal(out.realisedDelta, 0)
  assert.equal(out.warnings.length, 1)
})

// ------------------------------------------------------------------- close

test('a short bought back below its entry books a PROFIT', () => {
  // Short 620PE at 6.10, buy it back at 2.00: -2000 x (2 - 6.1) = +8,200.
  const out = apply([{ op: 'close', legId: 'pe620' }])
  money(out.realisedDelta, 8200)
  // Buying back is money OUT, whatever the P&L says.
  money(out.creditDelta, -4000)
  assert.deepEqual(
    out.legs.map((l) => l.id),
    ['ce700'],
  )
})

test('a long sold out books its loss and returns its premium', () => {
  const long: PayoffLeg = { ...CE, id: 'long730', qty: 1000, strike: 730, entry: 4, iv: 0.26 }
  const out = apply([{ op: 'close', legId: 'long730' }], [...BOOK, long])
  // Bought at 4, sold at 2.10: 1000 x (2.1 - 4) = -1,900.
  money(out.realisedDelta, -1900)
  money(out.creditDelta, 2100)
  assert.equal(out.legs.length, 2)
})

test('a close of a leg that is not in the book changes nothing and says so', () => {
  const out = apply([{ op: 'close', legId: 'ce999' }])
  assert.deepEqual([...out.legs], BOOK)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0]!, /ce999/)
})

// ------------------------------------------------------------- add / hedge

test('credit is premium received minus premium paid, across every move', () => {
  const moves: Move[] = [
    { op: 'add', strike: 600, type: 'PE', qty: -1000 }, // sell 1 lot at 3.30 → +3,300
    { op: 'hedge', strike: 730, type: 'CE', qty: 1000 }, // buy 1 lot at 2.10 → -2,100
  ]
  const out = apply(moves)
  assert.equal(out.warnings.length, 0, JSON.stringify(out.warnings))
  money(out.creditDelta, 1200)
  // Nothing was closed, so nothing was realised.
  assert.equal(out.realisedDelta, 0)

  assert.equal(out.legs.length, 4)
  const sold = out.legs.find((l) => l.id === 'add:600PE')
  assert.ok(sold, out.legs.map((l) => l.id).join(','))
  assert.equal(sold.qty, -1000)
  assert.equal(sold.entry, 3.3)
  assert.equal(sold.iv, 0.33)
  assert.equal(sold.expiry, EXPIRY)
  const bought = out.legs.find((l) => l.id === 'hedge:730CE')
  assert.ok(bought)
  assert.equal(bought.qty, 1000)
  assert.equal(bought.entry, 2.1)
})

test('an unpriced strike is dropped with a warning, never filled at a guess', () => {
  const out = apply([
    { op: 'add', strike: 640, type: 'PE', qty: -1000 },
    { op: 'hedge', strike: 730, type: 'CE', qty: 1000 },
  ])
  // The priced move still lands; only the unpriced one is refused.
  assert.deepEqual(
    out.legs.map((l) => l.id),
    ['ce700', 'pe620', 'hedge:730CE'],
  )
  money(out.creditDelta, -2100)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0]!, /640/)
  assert.match(out.warnings[0]!, /price/i)
})

test('two adds on the same contract are two legs with two ids', () => {
  const out = apply([
    { op: 'add', strike: 600, type: 'PE', qty: -1000 },
    { op: 'add', strike: 600, type: 'PE', qty: -1000 },
  ])
  assert.equal(out.legs.length, 4)
  assert.equal(new Set(out.legs.map((l) => l.id)).size, 4)
  money(out.creditDelta, 6600)
})

test('a leg added this batch can be closed in the same batch', () => {
  const out = apply([
    { op: 'add', strike: 600, type: 'PE', qty: -1000 },
    { op: 'close', legId: 'add:600PE' },
  ])
  assert.deepEqual([...out.legs], BOOK)
  // Sold at 3.30 and bought back at 3.30 — flat, both ways.
  money(out.creditDelta, 0)
  money(out.realisedDelta, 0)
})

// ------------------------------------------------------------- fail-soft

test('nothing to do is not an error', () => {
  const out = apply([])
  assert.deepEqual([...out.legs], BOOK)
  assert.equal(out.creditDelta, 0)
  assert.equal(out.realisedDelta, 0)
  assert.equal(out.warnings.length, 0)
})

test('a zero-qty add is refused rather than parked in the book', () => {
  const out = apply([{ op: 'add', strike: 600, type: 'PE', qty: 0 }])
  assert.deepEqual([...out.legs], BOOK)
  assert.equal(out.warnings.length, 1)
})

test('a futures leg closes at the future price, books its P&L, and pays no premium', () => {
  // The chain prices options only, so a future gets its own mark — without one
  // "flatten this book" is unproposable on any book carrying a future.
  const fut: PayoffLeg = {
    id: 'fut',
    instrument: 'future',
    qty: -1000,
    strike: null,
    type: null,
    expiry: EXPIRY,
    entry: 700,
    iv: null,
  }
  const out = applyMoves([...BOOK, fut], [{ op: 'close', legId: 'fut' }], priceOf, ivOf, 662)
  assert.equal(out.warnings.length, 0, JSON.stringify(out.warnings))
  assert.deepEqual(
    out.legs.map((l) => l.id),
    ['ce700', 'pe620'],
  )
  // Short 1000 at 700, bought back at 662: -1000 x (662 - 700).
  money(out.realisedDelta, 38000)
  // A FUTURE CARRIES NO PREMIUM. The ₹662,000 of notional is not cash paid —
  // booking it would report a fortune spent to flatten a position that settles
  // through variation margin.
  money(out.creditDelta, 0)
})

test('a futures leg cannot be closed off an option chain', () => {
  const fut: PayoffLeg = {
    id: 'fut',
    instrument: 'future',
    qty: 1000,
    strike: null,
    type: null,
    expiry: EXPIRY,
    entry: 662,
    iv: null,
  }
  const out = apply([{ op: 'close', legId: 'fut' }], [...BOOK, fut])
  assert.equal(out.legs.length, 3)
  assert.equal(out.realisedDelta, 0)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0]!, /fut/)
})

test('an add onto an empty book has no expiry to copy and is refused', () => {
  const out = apply([{ op: 'add', strike: 600, type: 'PE', qty: -1000 }], [])
  assert.equal(out.legs.length, 0)
  assert.equal(out.creditDelta, 0)
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0]!, /expiry/i)
})

test('the input book is never mutated', () => {
  const legs = [{ ...CE }, { ...PE }]
  const snapshot = JSON.stringify(legs)
  apply([{ op: 'shift', legId: 'ce700', toStrike: 720 }, { op: 'close', legId: 'pe620' }], legs)
  assert.equal(JSON.stringify(legs), snapshot)
})

// ------------------------------------------------------------------- future

test('a future move opens a futures leg at the future mark, in the book month, for no premium', () => {
  const out = applyMoves(BOOK, [{ op: 'future', qty: 1000 }], priceOf, ivOf, 662.5)
  assert.equal(out.warnings.length, 0, JSON.stringify(out.warnings))
  assert.deepEqual(out.legs[2], {
    id: 'future:FUT',
    instrument: 'future',
    qty: 1000,
    strike: null,
    type: null,
    expiry: EXPIRY,
    entry: 662.5,
    iv: null,
  })
  // No premium on a future (see the header): opening one moves no cash and banks nothing.
  assert.equal(out.creditDelta, 0)
  assert.equal(out.realisedDelta, 0)
})

test('a future move with no usable mark is dropped, named, never filled at a guess', () => {
  for (const mark of [undefined, 0, -5, Number.NaN]) {
    const out = applyMoves(BOOK, [{ op: 'future', qty: -1000 }], priceOf, ivOf, mark)
    assert.deepEqual([...out.legs], BOOK, String(mark))
    assert.equal(out.warnings.length, 1)
    assert.match(out.warnings[0]!, /^future -1000: /)
  }
  const zero = applyMoves(BOOK, [{ op: 'future', qty: 0 }], priceOf, ivOf, 662.5)
  assert.equal(zero.legs.length, 2)
  assert.match(zero.warnings[0]!, /not a tradeable/)
})

test('a second future move gets its own id, and a plan can close what it opened at no P&L', () => {
  const two = applyMoves(BOOK, [{ op: 'future', qty: 1000 }, { op: 'future', qty: -2000 }], priceOf, ivOf, 662.5)
  assert.deepEqual(two.legs.map((l) => l.id), ['ce700', 'pe620', 'future:FUT', 'future:FUT#2'])
  const round = applyMoves(BOOK, [{ op: 'future', qty: 1000 }, { op: 'close', legId: 'future:FUT' }], priceOf, ivOf, 662.5)
  assert.equal(round.legs.length, 2)
  assert.equal(round.realisedDelta, 0)
  assert.equal(round.creditDelta, 0)
})

// ------------------------------------------------------- the crossing side

/** Bid one below the mark, ask one above: a buy pays the ask, a sell takes the bid. */
const crossing = (k: number, t: 'CE' | 'PE', qty: number): number | null => {
  const m = priceOf(k, t)
  return m === null ? null : qty > 0 ? m + 1 : m - 1
}

test('with a fill function every trade is priced at the side it crosses', () => {
  // A sell of 600PE takes the bid (3.3 − 1), a buy of 730CE pays the ask (2.1 + 1).
  const opens = applyMoves(
    BOOK,
    [{ op: 'add', strike: 600, type: 'PE', qty: -1000 }, { op: 'hedge', strike: 730, type: 'CE', qty: 1000 }],
    priceOf,
    ivOf,
    undefined,
    crossing,
  )
  assert.deepEqual(opens.legs.slice(2).map((l) => [l.id, l.entry]), [['add:600PE', 3.3 - 1], ['hedge:730CE', 2.1 + 1]])
  money(opens.creditDelta, 1000 * (3.3 - 1) - 1000 * (2.1 + 1))
  // Closing the short 700CE BUYS it back, at the ask: -2000 x (13 − 8.4).
  const closed = applyMoves(BOOK, [{ op: 'close', legId: 'ce700' }], priceOf, ivOf, undefined, crossing)
  money(closed.realisedDelta, -2000 * (13 - 8.4))
  money(closed.creditDelta, -2000 * 13)
  // A shift is a buy-back at the ask and a re-sell at the bid.
  const shifted = applyMoves(BOOK, [{ op: 'shift', legId: 'ce700', toStrike: 720 }], priceOf, ivOf, undefined, crossing)
  assert.equal(shifted.legs.find((l) => l.strike === 720)?.entry, 4)
  money(shifted.realisedDelta, -2000 * (13 - 8.4))
  money(shifted.creditDelta, -2000 * 13 + 2000 * 4)
})

test('a fill function that throws or has no price drops the move like a chain with no price', () => {
  const throws = (): number | null => {
    throw new Error('quote cache down')
  }
  const out = applyMoves(BOOK, [{ op: 'add', strike: 600, type: 'PE', qty: -1000 }], priceOf, ivOf, undefined, throws)
  assert.deepEqual([...out.legs], BOOK)
  assert.match(out.warnings[0]!, /no price/)
})
