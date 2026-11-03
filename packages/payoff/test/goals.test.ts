/**
 * FOUR GOALS, FOUR MOVES, AND A HUMAN WHO STILL DECIDES.
 *
 * `searchRepairs` is the only thing in this package that RECOMMENDS. Everything
 * else answers a question about a book that already exists; this one proposes
 * books that do not, ranks them, and hands three of them to somebody who is
 * about to trade. So the suite is built around the four ways that recommendation
 * could be a lie:
 *
 *   1. THE OBJECTIVE IS NOT THE OBJECTIVE. A "reduce the loss" plan whose floor
 *      is worse than doing nothing, a "cheap tail cap" that does not cap the
 *      tail, a "max credit, safe" that quietly sold the floor for premium. Each
 *      goal gets an assertion in the goal's own words.
 *   2. THE CONSTRAINT IS ADVISORY. The hedge budget is the one that bites in
 *      practice — protection is always available at SOME price — so it gets a
 *      matched pair of runs on ONE book: identical everything, two budgets, and
 *      the starved one must come back with the baseline and say so rather than
 *      quietly overspending.
 *   3. THE ANSWER MOVES. A ranked list that reorders between two identical calls
 *      cannot be reviewed, argued with, or reproduced in a post-mortem.
 *   4. THE MONEY IS COUNTED TWICE, OR NOT AT ALL. Realised P&L belongs in every
 *      ₹ score that answers "how is the RUN doing" (`view.ts`) and in none of the
 *      ones that answer "what does this TRADE cost". The realised-shift test
 *      pins both halves at once.
 *
 * THE BOOK: a short strangle that has gone wrong on the call side — short 760CE
 * and short 700PE, two lots of a thousand, with the future now at 786. The 760CE
 * is ₹26 in the money and the position is ~₹30k down; at the top of the ±10%
 * scan it is ₹181k down. That is the book an operator actually opens this panel
 * for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, b76Greeks, b76ImpliedVol, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE, type PayoffLeg } from '../src/legs.ts'
import { expiryBreakevens } from '../src/expiry.ts'
import type { ReliefTriggers } from '../src/machine.ts'
import { DEFAULT_REPAIR_DIALS, type RepairDials, type StrikeInfo } from '../src/candidates.ts'
import { searchRepairs, type Goal, type RepairContext, type RepairPlan } from '../src/goals.ts'

const FUTURE = 786
const TODAY = '2026-08-19'
const EXPIRY = '2026-08-25'
/** The same clock `surface.ts` runs: calendar days over 365. */
const T = 6 / 365
const VOL = 0.3
const LOT = 1000

const STRIKES: readonly number[] = Array.from({ length: 21 }, (_, i) => 700 + i * 10)

/** One chain row, built the way the cockpit builds one: price → solved IV → delta. */
function row(strike: number, type: OptionType): StrikeInfo {
  const price = b76Price({ future: FUTURE, strike, t: T, vol: VOL, rate: DEFAULT_RATE, type })
  const iv = b76ImpliedVol(price, { future: FUTURE, strike, t: T, rate: DEFAULT_RATE, type })
  const delta =
    iv === null
      ? null
      : b76Greeks({ future: FUTURE, strike, t: T, vol: iv, rate: DEFAULT_RATE, type }).delta
  return { strike, type, price, ageMs: 0, iv, delta }
}

const CHAIN: readonly StrikeInfo[] = STRIKES.flatMap((k) => [row(k, 'CE'), row(k, 'PE')])
const BY_KEY = new Map(CHAIN.map((s) => [`${s.strike}${s.type}`, s]))
const priceOf = (k: number, t: OptionType): number | null => BY_KEY.get(`${k}${t}`)?.price ?? null
const ivOf = (k: number, t: OptionType): number | null => BY_KEY.get(`${k}${t}`)?.iv ?? null

const DIALS: RepairDials = { ...DEFAULT_REPAIR_DIALS, lotSize: LOT }

const SHORT_CE: PayoffLeg = {
  id: 'ce760',
  instrument: 'option',
  qty: -2000,
  strike: 760,
  type: 'CE',
  expiry: EXPIRY,
  entry: 8,
  iv: VOL,
}
const SHORT_PE: PayoffLeg = {
  id: 'pe700',
  instrument: 'option',
  qty: -2000,
  strike: 700,
  type: 'PE',
  expiry: EXPIRY,
  entry: 6,
  iv: VOL,
}
const STRANGLE: readonly PayoffLeg[] = [SHORT_CE, SHORT_PE]

function ctxFor(legs: readonly PayoffLeg[], realised = 0): RepairContext {
  return {
    legs,
    future: FUTURE,
    today: TODAY,
    expiry: EXPIRY,
    realised,
    dials: DIALS,
    priceOf,
    ivOf,
    strikes: CHAIN,
    triggers: null,
  }
}

const CTX = ctxFor(STRANGLE)

const of = (plans: readonly RepairPlan[], goal: Goal): readonly RepairPlan[] =>
  plans.filter((p) => p.goal === goal)
const baselineOf = (plans: readonly RepairPlan[], goal: Goal): RepairPlan => {
  const b = of(plans, goal).find((p) => p.flags.includes('baseline'))
  assert.ok(b !== undefined, `${goal} has no baseline`)
  return b
}
const proposalsOf = (plans: readonly RepairPlan[], goal: Goal): readonly RepairPlan[] =>
  of(plans, goal).filter((p) => !p.flags.includes('baseline'))

const GOALS: readonly Goal[] = [
  'REDUCE-LOSS',
  'PROFITABLE-BY-EXPIRY',
  'CHEAP-TAIL-CAP',
  'MAX-CREDIT-SAFE',
]

// ------------------------------------------------------------ the four goals

test('REDUCE-LOSS: the top plan lifts the floor, and doing nothing is still on the table', () => {
  const plans = searchRepairs(CTX)
  const mine = of(plans, 'REDUCE-LOSS')
  const base = baselineOf(plans, 'REDUCE-LOSS')
  assert.equal(base.moves.length, 0, 'the baseline is the do-nothing plan')

  const props = proposalsOf(plans, 'REDUCE-LOSS')
  assert.ok(props.length > 0, 'a ₹181k floor should be repairable')
  const top = props[0]
  assert.ok(top !== undefined)
  assert.ok(
    top.score.maxLoss > base.score.maxLoss,
    `top floor ${top.score.maxLoss} is not better than doing nothing (${base.score.maxLoss})`,
  )
  // And the list itself is a ranking, not a bag.
  for (let i = 1; i < props.length; i++) {
    assert.ok(
      (props[i - 1] as RepairPlan).score.maxLoss >= (props[i] as RepairPlan).score.maxLoss,
      'REDUCE-LOSS is not sorted by floor',
    )
  }
  assert.ok(mine.length >= props.length + 1)
})

test('CHEAP-TAIL-CAP: every plan actually caps the tail, cheapest first', () => {
  const plans = searchRepairs(CTX)
  const base = baselineOf(plans, 'CHEAP-TAIL-CAP')
  // Default cap: half of what the book can currently lose on the scan.
  const cap = 0.5 * Math.abs(base.score.maxLoss)
  assert.ok(cap > 0, 'the fixture book should be losing')

  const props = proposalsOf(plans, 'CHEAP-TAIL-CAP')
  assert.ok(props.length > 0, 'the tail should be cappable on this book')
  for (const p of props) {
    assert.ok(
      p.score.maxLoss >= -cap - 1e-6,
      `a "cap the tail" plan floors at ${p.score.maxLoss}, past the ₹${cap} cap`,
    )
  }
  // Cheapest first = most credit first, since a cap is normally a debit.
  for (let i = 1; i < props.length; i++) {
    assert.ok(
      (props[i - 1] as RepairPlan).score.credit >= (props[i] as RepairPlan).score.credit,
      'CHEAP-TAIL-CAP is not sorted cheapest-first',
    )
  }
})

test('MAX-CREDIT-SAFE: it collects premium and never sells the floor to do it', () => {
  const plans = searchRepairs(CTX)
  const base = baselineOf(plans, 'MAX-CREDIT-SAFE')
  const props = proposalsOf(plans, 'MAX-CREDIT-SAFE')
  assert.ok(props.length > 0, 'there is premium to be had on the untested side')

  for (const p of props) {
    assert.ok(
      p.score.maxLoss >= base.score.maxLoss - 1e-6,
      `credit of ${p.score.credit} was bought by dropping the floor from ` +
        `${base.score.maxLoss} to ${p.score.maxLoss}`,
    )
  }
  const top = props[0]
  assert.ok(top !== undefined)
  assert.ok(top.score.credit > 0, 'the best "max credit" plan collects nothing')
  for (let i = 1; i < props.length; i++) {
    assert.ok(
      (props[i - 1] as RepairPlan).score.credit >= (props[i] as RepairPlan).score.credit,
      'MAX-CREDIT-SAFE is not sorted by credit',
    )
  }
})

test('PROFITABLE-BY-EXPIRY widens the green part of the scan, and never reports an impossible width', () => {
  const plans = searchRepairs(CTX)
  const base = baselineOf(plans, 'PROFITABLE-BY-EXPIRY')
  const props = proposalsOf(plans, 'PROFITABLE-BY-EXPIRY')
  for (const p of [...props, base]) {
    assert.ok(
      p.score.profitableWidthPct >= 0 && p.score.profitableWidthPct <= 100,
      `profitableWidthPct ${p.score.profitableWidthPct} is not a percentage`,
    )
  }
  if (props.length > 0) {
    const top = props[0] as RepairPlan
    assert.ok(
      top.score.profitableWidthPct >= base.score.profitableWidthPct,
      'the top plan is narrower than doing nothing',
    )
    for (let i = 1; i < props.length; i++) {
      assert.ok(
        (props[i - 1] as RepairPlan).score.profitableWidthPct >=
          (props[i] as RepairPlan).score.profitableWidthPct,
        'PROFITABLE-BY-EXPIRY is not sorted by width',
      )
    }
  }
})

// ------------------------------------------------------------ the plan shape

test('no plan is longer than four moves, and each goal offers at most three distinct ones', () => {
  const plans = searchRepairs(CTX)
  const fails: string[] = []
  for (const goal of GOALS) {
    const props = proposalsOf(plans, goal)
    if (props.length > 3) fails.push(`${goal}: ${props.length} proposals, want at most 3`)
    const seen = new Set<string>()
    for (const p of props) {
      if (p.moves.length > 4) fails.push(`${goal}: a plan carries ${p.moves.length} moves`)
      if (p.moves.length === 0) fails.push(`${goal}: a proposal with no moves is the baseline`)
      const key = JSON.stringify(p.moves)
      if (seen.has(key)) fails.push(`${goal}: two plans share a move set — ${key}`)
      seen.add(key)
    }
    if (of(plans, goal).filter((p) => p.flags.includes('baseline')).length !== 1) {
      fails.push(`${goal}: want exactly one baseline`)
    }
  }
  assert.equal(fails.length, 0, fails.join('\n'))
})

test('a shorter budget of moves is honoured', () => {
  const plans = searchRepairs(CTX, { maxMoves: 2, topN: 2 })
  for (const p of plans) {
    assert.ok(p.moves.length <= 2, `a plan carries ${p.moves.length} moves under maxMoves 2`)
  }
  for (const goal of GOALS) assert.ok(proposalsOf(plans, goal).length <= 2)
})

test('the score carries its own margin arithmetic, and the breakevens are ordered', () => {
  const plans = searchRepairs(CTX)
  const fails: string[] = []
  for (const p of plans) {
    const s = p.score
    if (Math.abs(s.marginAfter - s.marginBefore - s.marginDelta) > 1e-6) {
      fails.push(`${p.goal}: marginDelta ${s.marginDelta} ≠ ${s.marginAfter} − ${s.marginBefore}`)
    }
    if (!Number.isFinite(s.pop) || s.pop < 0 || s.pop > 1) fails.push(`${p.goal}: pop ${s.pop}`)
    const bes = [...s.breakevens]
    if (JSON.stringify(bes) !== JSON.stringify([...bes].sort((a, b) => a - b))) {
      fails.push(`${p.goal}: breakevens out of order — ${bes.join(', ')}`)
    }
    for (const v of [s.credit, s.maxLoss, s.maxLossAt, s.worstShock, s.marginAfter]) {
      if (!Number.isFinite(v)) fails.push(`${p.goal}: a score field is not finite`)
    }
  }
  assert.equal(fails.length, 0, fails.join('\n'))
})

// ------------------------------------------------------------- the hedge budget
//
// ONE book, TWO budgets. The threatened short is struck at 795 — a strike this
// chain does not quote, which is an ordinary state for a wing and is exactly what
// `moves.ts` refuses to fabricate a fill for. So it cannot be closed and it
// cannot be re-struck; selling more premium only pays a few thousand; and the
// ONLY lever that lifts a ₹111k upside floor is buying a call. Whether the goal
// can be served at all is then decided entirely by what it may spend.

const UNQUOTED_CE: PayoffLeg = {
  id: 'ce795',
  instrument: 'option',
  qty: -2000,
  strike: 795,
  type: 'CE',
  expiry: EXPIRY,
  entry: 8,
  iv: VOL,
}
/** ₹28,000 of open credit: 2,000 x ₹8 on the call, 2,000 x ₹6 on the put. */
const UNCLOSABLE: readonly PayoffLeg[] = [UNQUOTED_CE, SHORT_PE]
const OPEN_CREDIT = 2000 * 8 + 2000 * 6

function budgetCtx(frac: number): RepairContext {
  return {
    legs: UNCLOSABLE,
    future: FUTURE,
    today: TODAY,
    expiry: EXPIRY,
    realised: 0,
    dials: { ...DIALS, hedgeBudgetFrac: frac },
    priceOf,
    ivOf,
    strikes: CHAIN,
    triggers: null,
    // Explicit rather than the 0.5·|floor| default: this pair of runs is about
    // the budget, and a cap that moved with the book would confound it.
    tailCapRupees: 60_000,
  }
}

test('a hedge the budget cannot afford is not proposed — the goal says so instead', () => {
  // 20% of ₹28,000 is ₹5,600, and the calls that lift this floor over the cap
  // cost about ₹2,000 a set.
  const rich = searchRepairs(budgetCtx(0.2))
  const richProps = proposalsOf(rich, 'CHEAP-TAIL-CAP')
  assert.ok(richProps.length > 0, 'with budget, the tail is cappable')
  assert.ok(
    richProps.some((p) => p.moves.some((m) => m.op === 'hedge')),
    'the cap should be bought with a hedge',
  )
  for (const p of rich) assert.ok(!p.flags.includes('no-feasible-plan'))

  // 1% of the same credit is ₹280 — enough for the far wings that cannot reach
  // the cap, and nowhere near the ones that can.
  const poor = searchRepairs(budgetCtx(0.01))
  const poorPlans = of(poor, 'CHEAP-TAIL-CAP')
  assert.equal(poorPlans.length, 1, 'a goal it cannot reach returns the baseline alone')
  const only = poorPlans[0] as RepairPlan
  assert.equal(only.moves.length, 0)
  assert.ok(only.flags.includes('baseline'))
  assert.ok(only.flags.includes('no-feasible-plan'), `flags were ${only.flags.join(',')}`)
})

test('the budget is a fraction of OPEN CREDIT, and no plan ever spends past it', () => {
  const plans = searchRepairs(budgetCtx(0.2))
  const budget = 0.2 * OPEN_CREDIT
  for (const p of plans) {
    let spend = 0
    for (const m of p.moves) {
      if (m.op !== 'hedge') continue
      spend += Math.max(0, m.qty) * (priceOf(m.strike, m.type) ?? 0)
    }
    assert.ok(spend <= budget + 1e-6, `${p.goal} spends ₹${spend} of a ₹${budget} budget`)
  }
})

// ----------------------------------------------------------- flattening a future

const FUT: PayoffLeg = {
  id: 'fut',
  instrument: 'future',
  qty: -1000,
  strike: null,
  type: null,
  expiry: EXPIRY,
  entry: FUTURE,
  iv: null,
}

test('a futures leg can be flattened — the chain prices options, the future prices itself', () => {
  // Short the future against a far short put: the unbounded upside IS the
  // future, so "close it" is the repair, and a search that cannot price a
  // futures close would silently never offer the one move that works.
  const plans = searchRepairs(ctxFor([FUT, SHORT_PE]))
  const flat = proposalsOf(plans, 'REDUCE-LOSS').filter((p) =>
    p.moves.some((m) => m.op === 'close' && m.legId === 'fut'),
  )
  assert.ok(flat.length > 0, 'closing the future was never proposed')
  const top = proposalsOf(plans, 'REDUCE-LOSS')[0] as RepairPlan
  assert.ok(
    top.moves.some((m) => m.op === 'close' && m.legId === 'fut'),
    `the best floor should come from flattening the future, got ${JSON.stringify(top.moves)}`,
  )
  // Flat at 786 against an entry of 786: nothing banked, and the remaining short
  // put is worthless across the whole scan.
  assert.ok(top.score.maxLoss > baselineOf(plans, 'REDUCE-LOSS').score.maxLoss)
  // No premium changes hands on a futures close.
  const closeOnly = flat.find((p) => p.moves.length === 1)
  if (closeOnly !== undefined) assert.equal(closeOnly.score.credit, 0)
})

// ------------------------------------------------------------------ doctrine

test('realised P&L moves every floor and not one credit', () => {
  const flat = searchRepairs(CTX)
  const banked = searchRepairs(ctxFor(STRANGLE, -50_000))
  const a = of(flat, 'REDUCE-LOSS')
  const b = of(banked, 'REDUCE-LOSS')
  assert.equal(a.length, b.length, 'a constant shift should not change which plans win')

  const fails: string[] = []
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as RepairPlan
    const y = b[i] as RepairPlan
    if (JSON.stringify(x.moves) !== JSON.stringify(y.moves)) {
      fails.push(`plan ${i}: the ranking moved — ${JSON.stringify(y.moves)}`)
      continue
    }
    // The RUN's floor: banked money is part of the answer to "how bad is this".
    if (Math.abs(y.score.maxLoss - (x.score.maxLoss - 50_000)) > 1e-6) {
      fails.push(`plan ${i}: floor ${y.score.maxLoss}, want ${x.score.maxLoss - 50_000}`)
    }
    if (Math.abs(y.score.worstShock - (x.score.worstShock - 50_000)) > 1e-6) {
      fails.push(`plan ${i}: worstShock ${y.score.worstShock}`)
    }
    // The TRADE's cash: what these legs cost has nothing to do with what the
    // book banked last week.
    if (y.score.credit !== x.score.credit) {
      fails.push(`plan ${i}: credit moved with realised — ${x.score.credit} → ${y.score.credit}`)
    }
    if (y.score.marginAfter !== x.score.marginAfter) {
      fails.push(`plan ${i}: margin moved with realised`)
    }
  }
  assert.equal(fails.length, 0, fails.join('\n'))
})

test('two identical calls return an identical ranking', () => {
  assert.deepStrictEqual(searchRepairs(CTX), searchRepairs(CTX))
  assert.deepStrictEqual(searchRepairs(CTX, { topN: 2 }), searchRepairs(CTX, { topN: 2 }))
})

// ------------------------------------------------------- what the bot is doing

const TRIGGERS = (over: Partial<ReliefTriggers>): ReliefTriggers => ({
  deltaTolPct: 0.02,
  deltaImbalance: 0.05,
  wouldRebalance: false,
  shiftEnabled: false,
  marginFrac: 0.4,
  targetPnl: null,
  notes: [],
  ...over,
})

test('a book the bot is about to rebalance says so on every plan, baseline included', () => {
  const plans = searchRepairs({ ...CTX, triggers: TRIGGERS({ wouldRebalance: true }) })
  assert.ok(plans.length > 0)
  for (const p of plans) {
    assert.ok(p.flags.includes('bot-rebalance-pending'), `${p.goal} plan is missing the flag`)
  }
  for (const p of searchRepairs(CTX)) {
    assert.ok(!p.flags.includes('bot-rebalance-pending'), 'flagged a book with no triggers')
  }
})

test('a re-strike the bot may itself undo is flagged, and only while its gate is open', () => {
  const opts = { maxMoves: 1, topN: 20 } as const
  const open = searchRepairs({ ...CTX, triggers: TRIGGERS({ shiftEnabled: true }) }, opts)
  const shut = searchRepairs({ ...CTX, triggers: TRIGGERS({ shiftEnabled: false }) }, opts)

  const shifted = (plans: readonly RepairPlan[]): readonly RepairPlan[] =>
    of(plans, 'REDUCE-LOSS').filter((p) => p.moves.some((m) => m.op === 'shift'))
  assert.ok(shifted(open).length > 0, 'the fixture should offer a re-strike')
  for (const p of shifted(open)) {
    assert.ok(p.flags.includes('bot-may-reshift'), `no flag on ${JSON.stringify(p.moves)}`)
  }
  for (const p of shifted(shut)) {
    assert.ok(!p.flags.includes('bot-may-reshift'), 'flagged a re-strike the bot cannot make')
  }
  for (const p of of(open, 'REDUCE-LOSS')) {
    if (!p.moves.some((m) => m.op === 'shift')) {
      assert.ok(!p.flags.includes('bot-may-reshift'), 'flagged a plan that re-strikes nothing')
    }
  }
})

// ------------------------------------------------- a book that cannot be priced
//
// `buildSurface` answers an unusable future or a date it cannot read with a
// ZEROED summary plus a warning. Zero is not a degraded floor, it is a BETTER
// one than any losing book has — so a search that scored on it would rank every
// plan against a book it never priced, and hand back four confident menus. The
// tell in the wild was a floor of exactly the realised P&L and a width of 100%.

const UNPRICEABLE: readonly [string, RepairContext][] = [
  ['no future price', { ...CTX, future: 0 }],
  ['a NaN future', { ...CTX, future: Number.NaN }],
  ['an expiry that is not a date', { ...CTX, expiry: 'not-a-date' }],
  ['a valuation date that is not a date', { ...CTX, today: '19-08-2026' }],
  // Not a pricing failure but the same verdict, and for a reason worth stating:
  // every score in this file is "at expiry", so a book with no expiry has no
  // column to be scored against. Answering it off whatever other date survived
  // would silently answer a different question.
  ['no expiry at all', { ...CTX, expiry: '' }],
]

test('a book the pricer cannot read produces no plans at all, and says so', () => {
  const fails: string[] = []
  for (const [what, bad] of UNPRICEABLE) {
    const plans = searchRepairs(bad)
    if (plans.length !== GOALS.length) {
      fails.push(`${what}: ${plans.length} plans, want ${GOALS.length} baselines`)
      continue
    }
    for (const p of plans) {
      if (p.moves.length !== 0) fails.push(`${what}: ${p.goal} recommended ${p.moves.length} moves`)
      if (!p.flags.includes('no-feasible-plan')) fails.push(`${what}: ${p.goal} is not flagged`)
      // The specific lie this guards: a zeroed surface reads as "every leg
      // closed", so the run looks flat and green at whatever it banked.
      if (p.score.profitableWidthPct === 100) fails.push(`${what}: ${p.goal} claims 100% green`)
    }
  }
  assert.equal(fails.length, 0, fails.join('\n'))
})

// ------------------------------------------------------------- a winning book
//
// Short a 900 call for ₹5 with the future at 786 and six days left: it expires
// worthless anywhere on the scan, so the floor is a PROFIT of ₹10,000. Every
// repair on such a book can only take money off the table, which is where three
// separate bugs used to live.

const WINNER: readonly PayoffLeg[] = [
  {
    id: 'ce900',
    instrument: 'option',
    qty: -2000,
    strike: 900,
    type: 'CE',
    expiry: EXPIRY,
    entry: 5,
    iv: VOL,
  },
]
/** The winning book with NO chain, so the only move in the alphabet is the close. */
const CLOSE_ONLY: RepairContext = { ...ctxFor(WINNER), strikes: [] }

test('closing the whole book is a plan, and a flat run is 100% green at what it banked', () => {
  const plans = searchRepairs(CLOSE_ONLY)
  const props = proposalsOf(plans, 'REDUCE-LOSS')
  assert.equal(props.length, 1, 'the only move available is the close')
  const flat = props[0] as RepairPlan
  assert.deepEqual([...flat.moves], [{ op: 'close', legId: 'ce900' }])
  // Bought back for ~nothing what was sold for ₹5: the run banks ~₹10,000 and is
  // then flat at that figure, at every price. This is the ONE legitimate
  // no-ladder case and it must not be confused with a book that would not price.
  assert.ok(flat.score.maxLoss > 9_900, `banked ${flat.score.maxLoss}`)
  assert.equal(flat.score.profitableWidthPct, 100)
  assert.deepEqual([...flat.score.breakevens], [])
  assert.equal(flat.score.marginAfter, 0, 'a flat book posts nothing')
})

test('a plan that leaves the book worse off at the bottom is flagged, on every goal', () => {
  // On a WINNER, closing banks slightly less than holding to expiry would earn —
  // so REDUCE-LOSS itself ranks a floor-degrading plan first.
  const won = searchRepairs(CLOSE_ONLY)
  const closed = proposalsOf(won, 'REDUCE-LOSS')[0] as RepairPlan
  assert.ok(closed.score.maxLoss < baselineOf(won, 'REDUCE-LOSS').score.maxLoss)
  assert.ok(closed.flags.includes('degrades-floor'), `flags were ${closed.flags.join(',')}`)

  // And on the losing strangle, PROFITABLE-BY-EXPIRY buys width with tail by
  // construction — it has no floor constraint at all.
  const lost = searchRepairs(CTX)
  const base = baselineOf(lost, 'PROFITABLE-BY-EXPIRY')
  const fails: string[] = []
  let sawOne = false
  for (const p of proposalsOf(lost, 'PROFITABLE-BY-EXPIRY')) {
    const worse = p.score.maxLoss < base.score.maxLoss - 1e-6
    if (worse) sawOne = true
    if (worse !== p.flags.includes('degrades-floor')) {
      fails.push(`floor ${p.score.maxLoss} vs ${base.score.maxLoss}, flags ${p.flags.join(',')}`)
    }
  }
  assert.ok(sawOne, 'the fixture should produce at least one floor-degrading plan')
  assert.equal(fails.length, 0, fails.join('\n'))
  // The baseline is the reference, so it can never degrade itself.
  for (const p of [...lost, ...won]) {
    if (p.flags.includes('baseline')) assert.ok(!p.flags.includes('degrades-floor'))
  }
})

test('a tail cap is never looser than doing nothing — a profit is not a loss allowance', () => {
  // Left unclamped, `0.5 · |floor|` on a book floored at +₹10,000 would permit
  // a floor of −₹5,000 and CHEAP-TAIL-CAP would certify losing money as "capped".
  const plans = searchRepairs(ctxFor(WINNER))
  const base = baselineOf(plans, 'CHEAP-TAIL-CAP')
  assert.ok(base.score.maxLoss > 0, 'the fixture book should be winning')
  for (const p of proposalsOf(plans, 'CHEAP-TAIL-CAP')) {
    assert.ok(
      p.score.maxLoss >= -1e-6,
      `a capped plan floors at ${p.score.maxLoss} on a book that cannot lose`,
    )
  }
  // An explicitly requested cap is clamped the same way: the promise is about
  // the tail, not about where the number came from.
  const asked = searchRepairs({ ...ctxFor(WINNER), tailCapRupees: 50_000 })
  for (const p of proposalsOf(asked, 'CHEAP-TAIL-CAP')) {
    assert.ok(p.score.maxLoss >= -1e-6, `floor ${p.score.maxLoss} under an explicit ₹50k cap`)
  }
})

// ------------------------------------------------------ one position, one plan

/**
 * A short 830 call carrying a PROFIT — sold ₹3 above where it now marks —
 * beside a short put that funds the hedge budget.
 *
 * `close ce830` and `hedge 830CE` leave the identical net position (the put
 * alone) for the identical cash. They differ only in where the ₹3,000 is
 * PARKED: the close banks it as realised, the buy-back leaves it sitting in an
 * offsetting pair that is worth exactly that much at every price, forever. Same
 * run, same money, two spellings — and the ₹3 gap is the point, because a book
 * entered at today's mark hides the distinction entirely.
 */
const PROFITABLE_CE = (): readonly PayoffLeg[] => {
  const mark = priceOf(830, 'CE') ?? 0
  assert.ok(mark > 0)
  return [
    {
      id: 'ce830',
      instrument: 'option',
      qty: -1000,
      strike: 830,
      type: 'CE',
      expiry: EXPIRY,
      entry: mark + 3,
      iv: VOL,
    },
    SHORT_PE,
  ]
}

const buysBack = (p: RepairPlan): boolean =>
  p.moves.some((m) => m.op === 'hedge' && m.strike === 830 && m.type === 'CE')
const closesIt = (p: RepairPlan): boolean =>
  p.moves.some((m) => m.op === 'close' && m.legId === 'ce830')

test('buying your short back and closing it are ONE plan, not two menu rows', () => {
  const plans = searchRepairs(ctxFor(PROFITABLE_CE()), { topN: 6 })
  const fails: string[] = []
  let sawOne = false
  for (const goal of GOALS) {
    const rows = proposalsOf(plans, goal)
    const close = rows.some((p) => p.moves.length === 1 && closesIt(p))
    const buy = rows.some((p) => p.moves.length === 1 && buysBack(p))
    if (close || buy) sawOne = true
    if (close && buy) fails.push(`${goal}: offered the buy-back AND the close as separate rows`)
  }
  // Not vacuous: one spelling of the trade must actually be on the menu, or the
  // fixture is proving nothing.
  assert.ok(sawOne, 'neither spelling of the buy-back was proposed at all')
  assert.equal(fails.length, 0, fails.join('\n'))
})

test('a row suppressed as a duplicate does not come back wearing a ₹2 wing', () => {
  // Deduping the buy-back is only half the job: its SUPERSETS are not duplicates
  // of anything chosen, so "buy back the 830 and a far wing" would walk straight
  // back onto the menu — five times over, at six rows. The suppression has to
  // carry through the duplicate, and this asks for six rows precisely so there
  // is room for the decorations to appear if it does not.
  const plans = searchRepairs(ctxFor(PROFITABLE_CE()), { topN: 6 })
  const fails: string[] = []
  for (const goal of GOALS) {
    const rows = proposalsOf(plans, goal)
    for (const p of rows) {
      if (buysBack(p)) {
        fails.push(`${goal}: ${JSON.stringify(p.moves)} is the close, in more legs`)
      }
    }
    // The idea itself is on the menu — under the spelling that survived.
    if (rows.length > 0 && !rows.some(closesIt)) {
      fails.push(`${goal}: neither spelling survived, so nothing was proved`)
    }
  }
  assert.equal(fails.length, 0, fails.join('\n'))
})

test('one unreadable leg costs the panel a warning, not its whole menu', () => {
  // `buildSurface` warns about a leg whose entry will not parse — and then
  // prices the book anyway, with a full ladder, which is exactly what `view.ts`
  // draws for the same operator. Refusing to rank that would blank all four
  // menus over one bad row out of Mongo, which is a worse answer than the one
  // caveat the panel is already showing.
  const broken: readonly PayoffLeg[] = [{ ...SHORT_CE, entry: Number.NaN }, SHORT_PE]
  const plans = searchRepairs(ctxFor(broken))
  assert.ok(plans.length > GOALS.length, 'the menu was blanked by a survivable warning')
  assert.ok(proposalsOf(plans, 'REDUCE-LOSS').length > 0, 'REDUCE-LOSS was blanked')
  assert.ok(
    !baselineOf(plans, 'REDUCE-LOSS').flags.includes('no-feasible-plan'),
    'the search gave up on a book it could price',
  )
  for (const p of plans) {
    assert.ok(Number.isFinite(p.score.maxLoss), `${p.goal} scored a non-finite floor`)
    assert.ok(Number.isFinite(p.score.credit), `${p.goal} scored a non-finite credit`)
  }
  // A goal may still find nothing on this book — MAX-CREDIT-SAFE cannot beat a
  // floor the unreadable leg left sitting in profit — and that is a real verdict
  // about the goal, not the blanking this test is about.
})

const exactOf = (legs: readonly PayoffLeg[], banked: number): readonly number[] => {
  const be = expiryBreakevens(legs, FUTURE, banked)
  return [be.down, be.up].filter((v): v is number => v !== null).sort((a, b) => a - b)
}

test('the breakevens are the panel’s own — the exact kinks, by the same function', () => {
  // ₹28,000 of credit over 2,000 shares is ₹14 above the struck call: 774, the
  // nearest crossing below a future sitting at 786.
  const base = baselineOf(searchRepairs(CTX), 'REDUCE-LOSS')
  assert.deepEqual([...base.score.breakevens], exactOf(STRANGLE, 0))
  assert.deepEqual(
    base.score.breakevens.map((v) => Math.round(v)),
    [774],
  )
})

test('a breakeven outside the ±10% scan is still reported — a grid cannot see one', () => {
  // Short the 900 call for ₹5 with the future at 786: the run is +₹10,000 flat
  // across the ENTIRE scan (707–865) and only crosses zero at 905, well outside
  // it. Every column of the ladder is the same positive number, so no crossing
  // of that ladder exists at any step size — a grid method reports nothing here.
  const base = baselineOf(searchRepairs(ctxFor(WINNER)), 'REDUCE-LOSS')
  assert.deepEqual(
    base.score.breakevens.map((v) => Math.round(v)),
    [905],
  )
  assert.ok(
    (base.score.breakevens[0] as number) > FUTURE * 1.1,
    'the fixture breakeven should sit outside the scan, or this proves nothing',
  )
  assert.deepEqual([...base.score.breakevens], exactOf(WINNER, 0))
})

// ---------------------------------------------------------------- fail-soft

test('a book nothing can be done to gets four honest baselines, not an empty answer', () => {
  const blind: RepairContext = {
    ...CTX,
    strikes: [],
    priceOf: () => null,
    ivOf: () => null,
  }
  const plans = searchRepairs(blind)
  assert.equal(plans.length, GOALS.length)
  for (const goal of GOALS) {
    const mine = of(plans, goal)
    assert.equal(mine.length, 1)
    const only = mine[0] as RepairPlan
    assert.deepEqual([...only.moves], [])
    assert.ok(only.flags.includes('baseline'))
    assert.ok(only.flags.includes('no-feasible-plan'))
  }
})

test('garbage in is four baselines, never a throw', () => {
  const junk = { legs: null, strikes: null } as unknown as RepairContext
  const plans = searchRepairs(junk)
  assert.equal(plans.length, GOALS.length)
  for (const p of plans) {
    assert.ok(p.flags.includes('baseline'))
    assert.equal(p.moves.length, 0)
  }
  assert.deepEqual(
    plans.map((p) => p.goal),
    [...GOALS],
  )
})

test('ops limits the moves a plan may use: without close no plan closes a leg; the default still can', () => {
  const all = searchRepairs(ctxFor(PROFITABLE_CE()), { topN: 6 })
  assert.ok(all.some((p) => p.moves.some((m) => m.op === 'close')), 'the fixture proposes a close by default')
  const noClose = searchRepairs(ctxFor(PROFITABLE_CE()), { topN: 6, ops: ['add', 'hedge', 'shift'] })
  assert.ok(noClose.some((p) => p.moves.length > 0), 'plans still come back')
  for (const p of noClose) for (const m of p.moves) assert.notEqual(m.op, 'close', JSON.stringify(p.moves))
})
