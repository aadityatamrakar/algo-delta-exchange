import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPositions,
  realised,
  unrealised,
  dayPnl,
  totalCosts,
  type PnlFill,
  type Position,
} from '../src/index.ts'

const close = (a: number, b: number, eps: number, what = ''): void => {
  assert.ok(Math.abs(a - b) < eps, `${what} expected ~${b}, got ${a} (diff ${Math.abs(a - b)})`)
}

// BHEL: lot 2625. The desk trades this as a short strangle, 5 lots a leg.
const LOT = 2625
const lots = (n: number): number => n * LOT
const CE = 'BHEL26JUL270CE'
const PE = 'BHEL26JUL240PE'
const CE_ROLLED = 'BHEL26JUL280CE'

let seq = 0
const sell = (tradingsymbol: string, qty: number, price: number): PnlFill => ({
  tradingsymbol,
  side: 'Sell',
  qty,
  price,
  ts: 1_800_000_000_000 + seq++,
})
const buy = (tradingsymbol: string, qty: number, price: number): PnlFill => ({
  tradingsymbol,
  side: 'Buy',
  qty,
  price,
  ts: 1_800_000_000_000 + seq++,
})

const find = (ps: readonly Position[], sym: string): Position => {
  const p = ps.find((x) => x.tradingsymbol === sym)
  assert.ok(p !== undefined, `no position for ${sym}`)
  return p
}

// ------------------------------------------------------------ buildPositions

test('a short open is a NEGATIVE position carried at the premium received', () => {
  const ps = buildPositions([sell(CE, lots(5), 15)])
  assert.equal(ps.length, 1)
  const p = find(ps, CE)
  assert.equal(p.qty, -13125, 'short must be negative, matching apps/api')
  assert.equal(p.avgCost, 15)
  assert.equal(p.realised, 0, 'opening a short books nothing yet — it is a credit, not a profit')
})

test('a long open is a positive position at the debit paid', () => {
  const p = find(buildPositions([buy(CE, lots(2), 8.5)]), CE)
  assert.equal(p.qty, 5250)
  assert.equal(p.avgCost, 8.5)
})

test('positions are built per contract and flat legs are retained with their realised', () => {
  const ps = buildPositions([
    sell(CE, lots(5), 15),
    sell(PE, lots(5), 13),
    buy(CE, lots(5), 12), // CE closed out entirely
  ])
  assert.equal(ps.length, 2)
  const ce = find(ps, CE)
  assert.equal(ce.qty, 0)
  assert.equal(ce.avgCost, 0, 'flat has no open quantity for an average to describe')
  assert.equal(ce.realised, 39375, 'the closed leg keeps its booked P&L in the position list')
  assert.equal(find(ps, PE).qty, -13125)
})

// -------------------------------------------------- short credit / buy-back

test('SHORT-OPEN IS A CREDIT: buying back below the sale price realises a gain', () => {
  // Sold 5 lots at 15.00, bought back at 12.00 -> 13125 * 3.00.
  const fills = [sell(CE, lots(5), 15), buy(CE, lots(5), 12)]
  assert.equal(realised(fills), 39375)
  assert.equal(find(buildPositions(fills), CE).qty, 0)
})

test('buying a short back ABOVE the sale price realises a loss', () => {
  assert.equal(realised([sell(CE, lots(5), 15), buy(CE, lots(5), 21)]), -78750)
})

test('a long realises on the sell, with the opposite sign to a short', () => {
  assert.equal(realised([buy(CE, lots(5), 12), sell(CE, lots(5), 15)]), 39375)
  assert.equal(realised([buy(CE, lots(5), 15), sell(CE, lots(5), 12)]), -39375)
})

// ------------------------------------------------------- average cost / size

test('adding to a short averages the credit (resize), and realises against the blend', () => {
  // 5 lots at 15.00 then 3 lots at 12.00 -> (196875 + 94500) / 21000 = 13.875.
  const opens = [sell(CE, lots(5), 15), sell(CE, lots(3), 12)]
  const p = find(buildPositions(opens), CE)
  assert.equal(p.qty, -21000)
  close(p.avgCost, 13.875, 1e-12, 'blended short credit')
  assert.equal(p.realised, 0)

  // Full buy-back at 10.00 realises against the BLEND, not against either open.
  close(realised([...opens, buy(CE, lots(8), 10)]), 21000 * 3.875, 1e-9, 'realised on the blend')
})

test('a PARTIAL close realises proportionally and leaves the rest at the SAME average', () => {
  const fills = [
    sell(CE, lots(5), 15),
    sell(CE, lots(3), 12), // avg 13.875 on 21000
    buy(CE, lots(3), 10), // cover 7875 of it
  ]
  const p = find(buildPositions(fills), CE)
  assert.equal(p.qty, -13125, 'remainder is the 5 lots still open')
  close(p.avgCost, 13.875, 1e-12, 'remainder must NOT be re-based to the closing price')
  close(p.realised, 7875 * 3.875, 1e-9, 'only the covered quantity is booked')

  // Closing the rest at the same price books the same per-unit P&L: proof the
  // remainder really did keep the original average.
  const rest = find(buildPositions([...fills, buy(CE, lots(5), 10)]), CE)
  close(rest.realised, 21000 * 3.875, 1e-9, 'both halves together == one full close')
})

test('trimming a long realises proportionally and holds the remainder at cost', () => {
  const p = find(buildPositions([buy(CE, lots(4), 20), sell(CE, lots(1), 26)]), CE)
  assert.equal(p.qty, lots(3))
  assert.equal(p.avgCost, 20)
  assert.equal(p.realised, 2625 * 6)
})

// ----------------------------------------------------------------- reversal

test('REVERSING THROUGH ZERO realises the whole short and opens a new long at the new price', () => {
  // Short 5 lots at 15.00, buy 8 lots at 12.00 -> long 3 lots.
  const p = find(buildPositions([sell(CE, lots(5), 15), buy(CE, lots(8), 12)]), CE)
  assert.equal(p.qty, lots(3), 'net long 3 lots')
  assert.equal(p.avgCost, 12, 'the new long is carried at the price just paid, not a blend')
  assert.equal(p.realised, 13125 * 3, 'the ENTIRE short is realised, not a pro-rated slice')
})

test('reversing a long into a short is symmetric', () => {
  const p = find(buildPositions([buy(PE, lots(2), 10), sell(PE, lots(6), 14)]), PE)
  assert.equal(p.qty, -lots(4))
  assert.equal(p.avgCost, 14)
  assert.equal(p.realised, 5250 * 4)
})

test('a reversal average is a real price, never a nonsense blend of the two sides', () => {
  const p = find(buildPositions([sell(CE, lots(5), 15), buy(CE, lots(8), 12)]), CE)
  // The naive weighted-average bug yields (-15*13125 + 12*21000)/7875 = +7.0.
  assert.notEqual(p.avgCost, 7)
  assert.ok(p.avgCost > 0, 'an average cost is a price and cannot be negative')
})

// --------------------------------------------------------------------- roll

test('a ROLL is a close plus an open, and MUST realise the closed leg', () => {
  const fills = [
    sell(CE, lots(5), 15), // opened the 270CE
    buy(CE, lots(5), 22), // spot ran up; cover it at a loss
    sell(CE_ROLLED, lots(5), 18), // roll out to the 280CE
  ]
  const ps = buildPositions(fills)
  assert.equal(ps.length, 2)
  assert.equal(find(ps, CE).qty, 0)
  assert.equal(find(ps, CE).realised, -13125 * 7)
  assert.equal(find(ps, CE_ROLLED).qty, -13125)
  assert.equal(find(ps, CE_ROLLED).avgCost, 18)
  assert.equal(find(ps, CE_ROLLED).realised, 0, 'the new leg is open, nothing booked on it')
  assert.equal(realised(fills), -91875, 'the roll shows the loss it locked in')
})

test('realised sums across contracts: a winning PE offsets a rolled CE', () => {
  const fills = [
    sell(CE, lots(5), 15),
    sell(PE, lots(5), 13),
    buy(CE, lots(5), 22), // -91,875
    buy(PE, lots(5), 4), // +118,125
  ]
  assert.equal(realised(fills), 26250)
})

// --------------------------------------------------------------- unrealised

test('an open short marked below its credit shows an unrealised GAIN', () => {
  const ps = buildPositions([sell(CE, lots(5), 15)])
  const u = unrealised(ps, { [CE]: 12 })
  assert.equal(u.total, 39375)
  assert.equal(u.legs.length, 1)
  assert.equal(u.legs[0]?.qty, -13125)
  assert.equal(u.legs[0]?.mark, 12)
  assert.equal(u.unpriced.length, 0)
})

test('an open short marked above its credit shows an unrealised loss', () => {
  assert.equal(unrealised(buildPositions([sell(CE, lots(5), 15)]), { [CE]: 19 }).total, -52500)
})

test('a mark of ZERO is a real mark, not a missing one', () => {
  // A far-OTM short that went worthless: the full credit is an unrealised gain.
  const u = unrealised(buildPositions([sell(PE, lots(5), 13)]), { [PE]: 0 })
  assert.equal(u.unpriced.length, 0)
  assert.equal(u.total, 13125 * 13)
})

test('an UNPRICED open leg is NAMED and excluded, never dropped or treated as zero', () => {
  const ps = buildPositions([sell(CE, lots(5), 15), sell(PE, lots(5), 13)])
  const u = unrealised(ps, { [CE]: 12 })
  assert.deepEqual(u.unpriced, [PE])
  assert.equal(u.legs.length, 1, 'only the leg that could be marked is in the detail')
  assert.equal(u.total, 39375, 'the total reflects ONLY what was priced')
  // A zero mark would have said -13125*13 = ... ; silence must not look like that.
  assert.notEqual(u.total, 39375 + 13125 * 13)
})

test('NaN and negative marks are unknown, not numbers', () => {
  const ps = buildPositions([sell(CE, lots(5), 15), sell(PE, lots(5), 13)])
  const u = unrealised(ps, { [CE]: Number.NaN, [PE]: -1 })
  assert.deepEqual([...u.unpriced].sort(), [CE, PE].sort())
  assert.equal(u.total, 0)
  assert.equal(u.legs.length, 0)
})

test('a FLAT contract needs no mark and is not reported unpriced', () => {
  const ps = buildPositions([sell(CE, lots(5), 15), buy(CE, lots(5), 12)])
  const u = unrealised(ps, {})
  assert.deepEqual(u.unpriced, [], 'a closed leg has no exposure to mark')
  assert.equal(u.total, 0)
})

// --------------------------------------------------------------------- costs

test('costs default to ZERO — we report gross (B3)', () => {
  const fills = [sell(CE, lots(5), 15), buy(CE, lots(5), 12)]
  assert.equal(totalCosts(), 0)
  assert.equal(totalCosts({}), 0)
  assert.equal(realised(fills), 39375)
  assert.equal(realised(fills, {}), 39375)
  assert.equal(dayPnl(fills, {}).realised, 39375)
})

test('costs are subtracted only when supplied, from both buckets', () => {
  const fills = [sell(CE, lots(5), 15), buy(CE, lots(5), 12)]
  assert.equal(totalCosts({ bySymbol: { [CE]: 120.5, [PE]: 79.5 }, book: 50 }), 250)
  assert.equal(realised(fills, { bySymbol: { [CE]: 200 } }), 39175)
  assert.equal(realised(fills, { book: 375 }), 39000)
  assert.equal(realised(fills, { bySymbol: { [CE]: 200 }, book: 175 }), 39000)
})

test('costs hit realised only — marking the book repeatedly must not re-charge them', () => {
  const fills = [sell(CE, lots(5), 15), sell(PE, lots(5), 13), buy(CE, lots(5), 12)]
  const costs = { bySymbol: { [CE]: 300 } }
  const a = dayPnl(fills, { [PE]: 11 }, costs)
  const b = dayPnl(fills, { [PE]: 11 }, costs)
  assert.deepEqual(a, b, 'pure: same inputs, same output')
  assert.equal(a.realised, 39375 - 300)
  assert.equal(a.unrealised, 13125 * 2, 'unrealised is untouched by costs')
})

// -------------------------------------------------------------------- dayPnl

test('dayPnl over a realistic short strangle: one leg rolled, one still open', () => {
  const fills = [
    sell(CE, lots(5), 15), // open the strangle
    sell(PE, lots(5), 13),
    buy(CE, lots(5), 22), // CE tested, cover at a loss
    sell(CE_ROLLED, lots(5), 18), // and roll it out
  ]
  const marks = { [CE_ROLLED]: 16.5, [PE]: 9.25 }
  const d = dayPnl(fills, marks)

  assert.equal(d.realised, -91875, 'the roll booked a loss')
  // Rolled CE: -13125 * (16.5 - 18) = +19,687.5. PE: -13125 * (9.25 - 13) = +49,218.75.
  close(d.unrealised, 68906.25, 1e-9, 'open legs marked')
  close(d.total, d.realised + d.unrealised, 1e-9, 'total is the sum of the two')
  assert.deepEqual(d.unpriced, [])
})

test('dayPnl reports a partially-marked book as partial instead of a confident wrong number', () => {
  const fills = [sell(CE, lots(5), 15), sell(PE, lots(5), 13)]
  const d = dayPnl(fills, { [CE]: 12 })
  assert.deepEqual(d.unpriced, [PE])
  assert.equal(d.realised, 0)
  assert.equal(d.unrealised, 39375)
  assert.equal(d.total, 39375)
  // ₹39,375 with a named gap must not be confusable with ₹39,375 complete.
  assert.notDeepEqual(d, dayPnl(fills, { [CE]: 12, [PE]: 13 }))
})

test('dayPnl on an empty book is zero and complete, not partial', () => {
  assert.deepEqual(dayPnl([], {}), { realised: 0, unrealised: 0, total: 0, unpriced: [] })
})

test('a fully closed book has no unrealised and total == realised', () => {
  const fills = [
    sell(CE, lots(5), 15),
    sell(PE, lots(5), 13),
    buy(CE, lots(5), 12),
    buy(PE, lots(5), 11),
  ]
  const d = dayPnl(fills, {})
  assert.equal(d.unrealised, 0)
  assert.equal(d.total, d.realised)
  assert.equal(d.total, 39375 + 26250)
})

// ------------------------------------------------------------------ hygiene

test('fills are consumed in array order, because average cost is path-dependent', () => {
  const a = realised([sell(CE, lots(5), 15), buy(CE, lots(3), 12), buy(CE, lots(2), 20)])
  const b = realised([sell(CE, lots(5), 15), buy(CE, lots(2), 20), buy(CE, lots(3), 12)])
  // Same net realised here, but the interim position differs — check the walk.
  assert.equal(a, b)
  const mid = find(buildPositions([sell(CE, lots(5), 15), buy(CE, lots(3), 12)]), CE)
  assert.equal(mid.qty, -lots(2))
})

test('corrupt fills throw instead of poisoning every downstream rupee with NaN', () => {
  assert.throws(() => buildPositions([{ tradingsymbol: CE, side: 'Sell', qty: 0, price: 15 }]), /qty/)
  assert.throws(
    () => buildPositions([{ tradingsymbol: CE, side: 'Sell', qty: -100, price: 15 }]),
    /qty/,
  )
  assert.throws(
    () => buildPositions([{ tradingsymbol: CE, side: 'Sell', qty: 100, price: Number.NaN }]),
    /price/,
  )
  assert.throws(() => buildPositions([{ tradingsymbol: '', side: 'Buy', qty: 1, price: 1 }]), /trad/)
})

test('an apps/api Fill shape passes straight in without adaptation', () => {
  // Structural check: the extra contract fields (op, deskTag, orderType) are
  // carried, not rejected — this package must stay usable from apps/api with no
  // mapping layer and no import from apps/.
  const apiFills = [
    { op: 'open', deskTag: 'bhel-ce-1', tradingsymbol: CE, side: 'Sell', qty: lots(5), price: 15, ts: 1 },
    { op: 'close', deskTag: 'bhel-ce-1', tradingsymbol: CE, side: 'Buy', qty: lots(5), price: 12, ts: 2 },
  ] as const
  assert.equal(realised(apiFills), 39375)
})
