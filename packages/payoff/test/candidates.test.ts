/**
 * THE MOVES THE REPAIRER IS ALLOWED TO EVEN CONSIDER.
 *
 * `atomicMoves` is the alphabet the beam search spells plans out of, and every
 * mistake it can make is a mistake the human never sees: a plan is judged by its
 * payoff curve, and a curve drawn from a strike that has not traded since 09:20
 * looks exactly as convincing as one drawn from a live quote. So this suite
 * tests the FILTERS, and it tests them as properties over a real chain rather
 * than against a hand-typed list of strikes — a hand-typed list would only prove
 * that the test author and the implementation made the same arithmetic mistake.
 *
 * The chain is synthetic but not fabricated: every strike is priced with
 * Black-76 at 30% vol, the vol is SOLVED BACK out of that price by bisection,
 * and the delta the bands are read from comes from the solved vol. That is the
 * same three-step path the live cockpit takes (chain → `solveChainIvs` → delta),
 * so a band edge lands where it really lands and not where a closed-form
 * shortcut would put it.
 *
 * F = 700, 36 days out, strikes 500…900 in twenties. At that tenor one strike
 * step is about a third of a standard deviation, which is what puts two strikes
 * per side inside the 0.15–0.35 add band and leaves the far wings under 0.10 for
 * the hedges — a chain where every band held one strike would pass a filter that
 * was off by a whole strike.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, b76Greeks, b76ImpliedVol, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE, type PayoffLeg } from '../src/legs.ts'
import {
  atomicMoves,
  DEFAULT_REPAIR_DIALS,
  liquidQuote,
  planMoves,
  type PlanMoveRules,
  type RepairDials,
  type StrikeInfo,
} from '../src/candidates.ts'
import type { PlanQuote } from '../src/objective-types.ts'

/**
 * Collect, then report once — the fifth copy of this helper in the repo (see
 * `ivs.test.ts`). A chain suite asserts one property per strike per type, and
 * "every PE row is missing" is a diagnosis the first throw alone would not give.
 */
function reportAll(fails: readonly string[], what: string): void {
  assert.equal(
    fails.length,
    0,
    `${fails.length} ${what} problems:\n` +
      fails.slice(0, 20).join('\n') +
      (fails.length > 20 ? `\n… and ${fails.length - 20} more` : ''),
  )
}

const FUTURE = 700
/** 2026-08-19 → 2026-09-24, the tenor the book's legs carry. */
const T = 36 / 365
const VOL = 0.3
const LOT = 1000
const EXPIRY = '2026-09-24'

const STRIKES: readonly number[] = Array.from({ length: 21 }, (_, i) => 500 + i * 20)

/** One chain row, built the way the cockpit builds one: price → solved IV → delta. */
function row(strike: number, type: OptionType, ageMs = 0): StrikeInfo {
  const price = b76Price({ future: FUTURE, strike, t: T, vol: VOL, rate: DEFAULT_RATE, type })
  const iv = b76ImpliedVol(price, { future: FUTURE, strike, t: T, rate: DEFAULT_RATE, type })
  const delta =
    iv === null
      ? null
      : b76Greeks({ future: FUTURE, strike, t: T, vol: iv, rate: DEFAULT_RATE, type }).delta
  return { strike, type, price, ageMs, iv, delta }
}

const CHAIN: readonly StrikeInfo[] = STRIKES.flatMap((k) => [row(k, 'CE'), row(k, 'PE')])

const DIALS: RepairDials = { ...DEFAULT_REPAIR_DIALS, lotSize: LOT }

const SHORT_CE: PayoffLeg = {
  id: 'ce720',
  instrument: 'option',
  qty: -2000,
  strike: 720,
  type: 'CE',
  expiry: EXPIRY,
  entry: 12,
  iv: VOL,
}
const SHORT_PE: PayoffLeg = {
  id: 'pe680',
  instrument: 'option',
  qty: -2000,
  strike: 680,
  type: 'PE',
  expiry: EXPIRY,
  entry: 9,
  iv: VOL,
}
const BOOK: readonly PayoffLeg[] = [SHORT_CE, SHORT_PE]

function infoOf(
  chain: readonly StrikeInfo[],
  strike: number,
  type: OptionType,
): StrikeInfo | undefined {
  return chain.find((s) => s.strike === strike && s.type === type)
}

/** `|delta|`, or NaN when the row carries none — NaN fails every band test. */
function absDelta(s: StrikeInfo | undefined): number {
  return s === undefined || s.delta === null ? NaN : Math.abs(s.delta)
}

const tag = (strike: number, type: OptionType): string => `${strike}${type}`

// --------------------------------------------------------------------- adds

test('adds sell exactly one lot, only inside the 0.15–0.35 delta band, and serve all of it', () => {
  const moves = atomicMoves(BOOK, CHAIN, DIALS)
  const adds = moves.filter((m) => m.op === 'add')
  // Not a vacuous pass: the band really does hold strikes on both sides.
  assert.ok(adds.length >= 4, `expected several adds, got ${adds.length}`)
  assert.ok(
    adds.some((m) => m.type === 'CE') && adds.some((m) => m.type === 'PE'),
    'the band should be served on both sides',
  )

  const fails: string[] = []
  const offered = new Set<string>()
  for (const m of adds) {
    if (m.op !== 'add') continue
    offered.add(tag(m.strike, m.type))
    const info = infoOf(CHAIN, m.strike, m.type)
    if (info === undefined) {
      fails.push(`add ${tag(m.strike, m.type)}: not on the chain at all`)
      continue
    }
    const d = absDelta(info)
    if (!(d >= DIALS.addDeltaMin && d <= DIALS.addDeltaMax)) {
      fails.push(`add ${tag(m.strike, m.type)}: |delta| ${d} is outside the add band`)
    }
    // SELL one lot. A repair that "adds premium" by buying is not one.
    if (m.qty !== -LOT) fails.push(`add ${tag(m.strike, m.type)}: qty ${m.qty}, want ${-LOT}`)
    if ((info.price ?? 0) < DIALS.minCreditPerShare) {
      fails.push(`add ${tag(m.strike, m.type)}: price ${info.price} is under the credit floor`)
    }
  }

  // The other half of the filter: nothing ELIGIBLE was silently skipped.
  for (const s of CHAIN) {
    const d = absDelta(s)
    const eligible =
      d >= DIALS.addDeltaMin &&
      d <= DIALS.addDeltaMax &&
      (s.price ?? 0) >= DIALS.minCreditPerShare &&
      (s.ageMs ?? Infinity) <= DIALS.maxQuoteAgeMs
    if (eligible && !offered.has(tag(s.strike, s.type))) {
      fails.push(`missing add ${tag(s.strike, s.type)}: |delta| ${d} is in band and it is fresh`)
    }
  }
  reportAll(fails, 'add')
})

test('the credit floor is an ADD rule, and raising it takes strikes off the list', () => {
  const cheap = atomicMoves(BOOK, CHAIN, DIALS).filter((m) => m.op === 'add')
  // ₹25 is above the near-band premium at this tenor, so the band empties out.
  const dear = atomicMoves(BOOK, CHAIN, { ...DIALS, minCreditPerShare: 25 }).filter(
    (m) => m.op === 'add',
  )
  assert.ok(dear.length < cheap.length, 'a higher credit floor should refuse some adds')
  for (const m of dear) {
    if (m.op !== 'add') continue
    const info = infoOf(CHAIN, m.strike, m.type)
    assert.ok((info?.price ?? 0) >= 25, `add ${tag(m.strike, m.type)} is under the raised floor`)
  }
})

// ------------------------------------------------------------------- hedges

test('hedges buy one lot at 0.10 delta or less, both types, and pay no credit floor', () => {
  const moves = atomicMoves(BOOK, CHAIN, DIALS)
  const hedges = moves.filter((m) => m.op === 'hedge')
  assert.ok(hedges.length >= 4, `expected several hedges, got ${hedges.length}`)
  assert.ok(
    hedges.some((m) => m.type === 'CE') && hedges.some((m) => m.type === 'PE'),
    'both tails should be hedgeable',
  )

  const fails: string[] = []
  for (const m of hedges) {
    if (m.op !== 'hedge') continue
    const info = infoOf(CHAIN, m.strike, m.type)
    const d = absDelta(info)
    if (!(d <= DIALS.hedgeDeltaMax)) {
      fails.push(`hedge ${tag(m.strike, m.type)}: |delta| ${d} is above the hedge ceiling`)
    }
    // BUY one lot. The sign is the whole difference between a hedge and an add.
    if (m.qty !== LOT) fails.push(`hedge ${tag(m.strike, m.type)}: qty ${m.qty}, want ${LOT}`)
    if (!((info?.price ?? 0) > 0)) fails.push(`hedge ${tag(m.strike, m.type)}: no price`)
  }
  reportAll(fails, 'hedge')

  // The credit floor guards SELLS. A wing worth 20 paise is exactly the tail cap
  // this desk wants to be able to buy, and refusing it would leave the repairer
  // with nothing but expensive protection.
  const penny = hedges.filter((m) => {
    if (m.op !== 'hedge') return false
    return (infoOf(CHAIN, m.strike, m.type)?.price ?? 0) < DIALS.minCreditPerShare
  })
  assert.ok(penny.length > 0, 'a sub-rupee wing should still be buyable as a hedge')
})

// ------------------------------------------------------------- quote quality

test('a stale quote is not tradeable anywhere — not as an add, a hedge, or a landing strike', () => {
  // 760CE is both an add candidate and the second landing strike for the 720CE
  // short, so one stale row exercises two families at once.
  const stale = CHAIN.map((s) =>
    s.strike === 760 && s.type === 'CE' ? row(760, 'CE', 5 * 60_000) : s,
  )
  const fresh = atomicMoves(BOOK, CHAIN, DIALS)
  const aged = atomicMoves(BOOK, stale, DIALS)

  const touches = (ms: ReturnType<typeof atomicMoves>): boolean =>
    ms.some(
      (m) =>
        (m.op === 'add' && m.strike === 760 && m.type === 'CE') ||
        (m.op === 'hedge' && m.strike === 760 && m.type === 'CE') ||
        (m.op === 'shift' && m.toStrike === 760 && m.legId === 'ce720'),
    )
  assert.ok(touches(fresh), 'the fixture is wrong: 760CE should be tradeable while fresh')
  assert.ok(!touches(aged), '760CE went stale and is still being proposed')
  assert.ok(aged.length < fresh.length, 'a stale strike should shrink the alphabet')
})

test('a row with no delta and a row with no price are both untradeable', () => {
  const blind = CHAIN.map((s) => {
    if (s.strike === 740 && s.type === 'CE') return { ...s, delta: null }
    if (s.strike === 660 && s.type === 'PE') return { ...s, price: null }
    return s
  })
  const moves = atomicMoves(BOOK, blind, DIALS)
  for (const m of moves) {
    if (m.op === 'add' || m.op === 'hedge') {
      assert.ok(
        !(m.strike === 740 && m.type === 'CE'),
        'a strike with no delta cannot be banded, so it cannot be traded',
      )
      assert.ok(!(m.strike === 660 && m.type === 'PE'), 'a strike with no price cannot be filled')
    }
    if (m.op === 'shift') {
      assert.notEqual(m.toStrike, 740, 'nothing should land on a strike with no delta')
      assert.notEqual(m.toStrike, 660, 'nothing should land on a strike with no price')
    }
  }
})

// ------------------------------------------------------------------- shifts

test('a shift moves a SHORT further out, same type, into the 0.20–0.30 band', () => {
  const long: PayoffLeg = { ...SHORT_CE, id: 'long760', qty: 1000, strike: 760, entry: 4 }
  const moves = atomicMoves([...BOOK, long], CHAIN, DIALS)
  const shifts = moves.filter((m) => m.op === 'shift')
  assert.ok(shifts.length >= 2, `expected shifts for both shorts, got ${shifts.length}`)

  const fails: string[] = []
  for (const m of shifts) {
    if (m.op !== 'shift') continue
    const leg = [...BOOK, long].find((l) => l.id === m.legId)
    if (leg === undefined || leg.strike === null || leg.type === null) {
      fails.push(`shift ${m.legId}: no such option leg`)
      continue
    }
    // A LONG leg is not the repairer's to re-strike: rolling somebody's hedge
    // out is a different decision from rolling a threatened short.
    if (leg.qty >= 0) fails.push(`shift ${m.legId}: that leg is long`)
    const further = leg.type === 'CE' ? m.toStrike > leg.strike : m.toStrike < leg.strike
    if (!further) fails.push(`shift ${m.legId} → ${m.toStrike}: that is not further OTM`)
    const d = absDelta(infoOf(CHAIN, m.toStrike, leg.type))
    if (!(d >= DIALS.shiftDeltaMin && d <= DIALS.shiftDeltaMax)) {
      fails.push(`shift ${m.legId} → ${m.toStrike}: landing |delta| ${d} is outside the band`)
    }
  }
  reportAll(fails, 'shift')
  assert.ok(!shifts.some((m) => m.op === 'shift' && m.legId === 'long760'), 'a long was shifted')
})

// ------------------------------------------------------------------- closes

test('every leg can be closed, exactly once — including the ones nothing else can touch', () => {
  const fut: PayoffLeg = {
    id: 'fut',
    instrument: 'future',
    qty: 1000,
    strike: null,
    type: null,
    expiry: EXPIRY,
    entry: 700,
    iv: null,
  }
  const legs = [...BOOK, fut]
  const closes = atomicMoves(legs, CHAIN, DIALS).filter((m) => m.op === 'close')
  assert.equal(closes.length, legs.length)
  assert.deepEqual(
    [...closes.map((m) => (m.op === 'close' ? m.legId : ''))].sort(),
    [...legs.map((l) => l.id)].sort(),
  )
})

// ------------------------------------------------------------- determinism

test('the alphabet is ordered by op then strike, and two calls are byte-identical', () => {
  const a = atomicMoves(BOOK, CHAIN, DIALS)
  const b = atomicMoves(BOOK, CHAIN, DIALS)
  assert.deepStrictEqual(a, b, 'atomicMoves is not deterministic')

  const rank: Record<string, number> = { add: 0, hedge: 1, shift: 2, close: 3 }
  let last = -1
  for (const m of a) {
    const r = rank[m.op]
    assert.ok(r !== undefined, `unknown op ${m.op}`)
    assert.ok((r as number) >= last, `op ${m.op} came after a later family`)
    last = r as number
  }
  const strikesOf = (op: 'add' | 'hedge'): number[] =>
    a.filter((m) => m.op === op).map((m) => (m.op === op ? m.strike : 0))
  for (const op of ['add', 'hedge'] as const) {
    const ks = strikesOf(op)
    assert.deepEqual([...ks].sort((x, y) => x - y), ks, `${op} strikes are not ascending`)
  }
})

// --------------------------------------------------------------- fail-soft

test('no chain is not a crash: the book can still be closed', () => {
  const moves = atomicMoves(BOOK, [], DIALS)
  assert.equal(moves.length, BOOK.length)
  assert.ok(moves.every((m) => m.op === 'close'))
})

test('a lot size of zero refuses to open anything but still closes and shifts', () => {
  const moves = atomicMoves(BOOK, CHAIN, { ...DIALS, lotSize: 0 })
  assert.ok(!moves.some((m) => m.op === 'add' || m.op === 'hedge'), 'opened a zero-size leg')
  assert.ok(moves.some((m) => m.op === 'shift'), 'a shift keeps the leg’s own size')
  assert.equal(moves.filter((m) => m.op === 'close').length, BOOK.length)
})

test('garbage in is an empty alphabet, never a throw', () => {
  assert.deepEqual(
    [...atomicMoves(null as unknown as PayoffLeg[], null as unknown as StrikeInfo[], DIALS)],
    [],
  )
  assert.deepEqual([...atomicMoves([], [], DIALS)], [])
  const rubbish = [{ strike: 'x', type: 'ZZ' }] as unknown as StrikeInfo[]
  assert.deepEqual([...atomicMoves([], rubbish, DIALS)], [])
})

// ============================================== the objective search's alphabet

const ALL_OPS = ['add', 'hedge', 'shift', 'future', 'close'] as const
const RULES: PlanMoveRules = { ops: ALL_OPS, maxLotsPerMove: 2, futureMark: 701.5, untouchable: [] }

test('the size ladder: every open the repair alphabet offers, at 1…maxLotsPerMove lots, strike-major', () => {
  const one = atomicMoves(BOOK, CHAIN, DIALS)
  const { moves, illiquid } = planMoves(BOOK, CHAIN, DIALS, RULES)
  assert.equal(illiquid, 0)
  for (const op of ['add', 'hedge'] as const) {
    const base = one.filter((m) => m.op === op)
    const laddered = moves.filter((m) => m.op === op)
    assert.ok(base.length > 0, op)
    // each contract twice, sizes adjacent and ascending in lots, the sign the family's own
    const want = base.flatMap((m) =>
      m.op === op ? [1, 2].map((n) => ({ ...m, qty: Math.sign(m.qty) * n * LOT })) : [],
    )
    assert.deepEqual(laddered, want, op)
  }
  const five = planMoves(BOOK, CHAIN, DIALS, { ...RULES, maxLotsPerMove: 9 }).moves.filter((m) => m.op === 'add')
  assert.equal(five.length, one.filter((m) => m.op === 'add').length * 5, 'the ladder stops at 5 lots')
})

test('futures: both sides, 1…maxLotsPerMove lots, only with a usable mark and a lot', () => {
  const fut = (r: PlanMoveRules, dials = DIALS) => planMoves(BOOK, CHAIN, dials, r).moves.filter((m) => m.op === 'future')
  assert.deepEqual(fut(RULES), [
    { op: 'future', qty: -2 * LOT },
    { op: 'future', qty: -LOT },
    { op: 'future', qty: LOT },
    { op: 'future', qty: 2 * LOT },
  ])
  assert.deepEqual(fut({ ...RULES, futureMark: null }), [])
  assert.deepEqual(fut({ ...RULES, futureMark: 0 }), [])
  assert.deepEqual(fut({ ...RULES, ops: ['add', 'hedge'] }), [])
  assert.deepEqual(fut(RULES, { ...DIALS, lotSize: 0 }), [])
})

test('family order: adds, hedges, futures, shifts, closes; ops and untouchable legs filter', () => {
  const { moves } = planMoves(BOOK, CHAIN, DIALS, RULES)
  const order = ['add', 'hedge', 'future', 'shift', 'close']
  const ranks = moves.map((m) => order.indexOf(m.op))
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'families out of order')
  assert.ok(moves.some((m) => m.op === 'shift' && m.legId === 'ce720'))
  assert.ok(moves.some((m) => m.op === 'close' && m.legId === 'ce720'))

  const guarded = planMoves(BOOK, CHAIN, DIALS, { ...RULES, untouchable: ['ce720'] }).moves
  assert.equal(guarded.some((m) => (m.op === 'shift' || m.op === 'close') && m.legId === 'ce720'), false)
  assert.ok(guarded.some((m) => m.op === 'shift' && m.legId === 'pe680'), 'only the named leg is protected')

  const noClose = planMoves(BOOK, CHAIN, DIALS, { ...RULES, ops: ['add', 'hedge', 'shift', 'future'] }).moves
  assert.equal(noClose.some((m) => m.op === 'close'), false)
})

test('R8: opens and shift landings need a live two-sided quote within max(10% of mid, ₹1)', () => {
  const adds = atomicMoves(BOOK, CHAIN, DIALS).filter((m) => m.op === 'add')
  const s0 = atomicMoves(BOOK, CHAIN, DIALS).find((m) => m.op === 'shift' && m.legId === 'ce720')
  assert.ok(s0?.op === 'shift')
  // the shift's landing is often in the add band too; the three refused adds are three OTHER contracts
  const others = adds.filter((m) => m.op === 'add' && !(m.type === 'CE' && m.strike === s0.toStrike))
  const landingIsAdd = others.length < adds.length
  const [a0, a1, a2] = others
  assert.ok(a0?.op === 'add' && a1?.op === 'add' && a2?.op === 'add')
  const quotes = new Map<string, PlanQuote>()
  for (const s of CHAIN) {
    const p = s.price ?? 0
    // a tight market everywhere: 4% wide around the mark, a real bid even on a 5-paise wing
    quotes.set(tag(s.strike, s.type), { bid: p * 0.98, ask: p * 1.02, stale: false })
  }
  quotes.set(tag(a0.strike, a0.type), { bid: null, ask: 5, stale: false }) // one-sided
  quotes.set(tag(a1.strike, a1.type), { bid: 4, ask: 6, stale: true }) // stale
  quotes.set(tag(a2.strike, a2.type), { bid: 10, ask: 12, stale: false }) // ₹2 wide on an ₹11 mid: 18%
  quotes.set(`${s0.toStrike}CE`, { bid: 2, ask: 3.01, stale: false }) // ₹1.01 wide: over the ₹1 floor
  const quoteOf = (k: number, t: OptionType): PlanQuote | null => quotes.get(tag(k, t)) ?? null

  const { moves, illiquid } = planMoves(BOOK, CHAIN, DIALS, { ...RULES, quoteOf })
  const has = (k: number, t: OptionType) => moves.some((m) => (m.op === 'add' || m.op === 'hedge') && m.strike === k && m.type === t)
  assert.equal(has(a0.strike, a0.type), false, 'one-sided')
  assert.equal(has(a1.strike, a1.type), false, 'stale')
  assert.equal(has(a2.strike, a2.type), false, 'wide')
  assert.equal(moves.some((m) => m.op === 'shift' && m.toStrike === s0.toStrike), false, 'a shift lands only on a liquid strike')
  assert.equal(illiquid, 4)
  // everything else is still offered
  assert.equal(moves.filter((m) => m.op === 'add').length, (adds.length - 3 - (landingIsAdd ? 1 : 0)) * 2)
  // closes are the trader's own legs: never refused for liquidity
  assert.equal(moves.filter((m) => m.op === 'close').length, BOOK.length)
})

test('R8 at the edges: exactly 10% of mid and exactly ₹1 are inside; crossed and zero bids are out', () => {
  assert.equal(liquidQuote({ bid: 9.5, ask: 10.5, stale: false }), true)
  assert.equal(liquidQuote({ bid: 2.5, ask: 3.5, stale: false }), true)
  assert.equal(liquidQuote({ bid: 2.5, ask: 3.6, stale: false }), false)
  assert.equal(liquidQuote({ bid: 95, ask: 105.01, stale: false }), false)
  assert.equal(liquidQuote({ bid: 5, ask: 4, stale: false }), false)
  assert.equal(liquidQuote({ bid: 0, ask: 0.5, stale: false }), false)
  assert.equal(liquidQuote(null), false)
  assert.equal(liquidQuote({ bid: 3, ask: 3.2 } as unknown as PlanQuote), false, 'unknown staleness is stale')
})

test('the plan alphabet is fail-soft: garbage is an empty alphabet, never a throw', () => {
  const r = planMoves(null as unknown as PayoffLeg[], null as unknown as StrikeInfo[], DIALS, RULES)
  assert.deepEqual([...r.moves.filter((m) => m.op !== 'future')], [])
  const thrower = (): PlanQuote | null => {
    throw new Error('quote cache down')
  }
  const t = planMoves(BOOK, CHAIN, DIALS, { ...RULES, quoteOf: thrower })
  assert.equal(t.moves.some((m) => m.op === 'add' || m.op === 'hedge'), false, 'a quote that throws is not a quote')
})
