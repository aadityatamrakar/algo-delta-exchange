import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Goal, RepairPlan } from '@algomaker/payoff'
import { CLOSED_MAX_AGE_MS } from '../src/analytics/month-chain.ts'
import {
  OFFSET_LEG_ID, REALISED_NOT_COUNTED, REPAIR_PLANS_SHOWN, repairExpiryOf, repairJobOf, repairViewOf, runRepairJob, type RepairJobResult,
} from '../src/analytics/repair.ts'
import { FEED_NOT_TICKING } from '../src/market/quotes.ts'
import { NIFTY_W1, NIFTY_W2, NOV, OCT, fakeQuotes } from './fixtures/r3-market.ts'
import { REPAIR_NOW, TCS_LOT, TCS_OCT_FWD, book, keyOf, leg, monthOf, repairMarket, tcsBook } from './fixtures/repair-book.ts'

const GOALS: readonly Goal[] = ['REDUCE-LOSS', 'PROFITABLE-BY-EXPIRY', 'CHEAP-TAIL-CAP', 'MAX-CREDIT-SAFE']

function ok(r: RepairJobResult): Exclude<RepairJobResult, { blocked: string }> {
  if ('blocked' in r) throw new Error(`blocked: ${r.blocked}`)
  return r
}

test('near expiry only, the rest as one offset', () => {
  const { m, q } = repairMarket()
  const month = monthOf(m, q, 'TCS', OCT)
  const r = ok(repairJobOf(tcsBook(), month, TCS_LOT, REPAIR_NOW, null))
  assert.equal(r.job.expiry, OCT)
  assert.deepEqual(r.job.legs.map((l) => l.id), [keyOf('TCS', 'option', OCT, 3400, 'CE'), OFFSET_LEG_ID])
  const offset = r.job.legs[1]
  assert.deepEqual(offset, { id: OFFSET_LEG_ID, instrument: 'future', qty: 1080, strike: null, type: null, expiry: OCT, entry: TCS_OCT_FWD, iv: null })
  assert.equal(r.offsetShares, 1080)
  // the October leg as a PayoffLeg: signed qty, the entry is the average price, the iv the view's
  assert.deepEqual(r.job.legs[0], { id: keyOf('TCS', 'option', OCT, 3400, 'CE'), instrument: 'option', qty: -350, strike: 3400, type: 'CE', expiry: OCT, entry: 80, iv: 0.25 })
  assert.equal(r.job.future, TCS_OCT_FWD)
  assert.equal(month.source, 'future')
  assert.equal(r.job.today, '2026-10-19')
  assert.equal(r.job.realised, 0)
  assert.equal(r.job.dials.lotSize, TCS_LOT)
  assert.equal(r.job.dials.maxQuoteAgeMs, 120_000)
  assert.equal('tailCapRupees' in r.job, false)
  // the chain: every quoted October contract, banded by its Black-76 delta at its own solved vol
  assert.equal(r.job.strikes.length, 10)
  assert.deepEqual(r.job.solved, month.ivs)
  const atm = r.job.strikes.find((s) => s.strike === 3400 && s.type === 'CE')
  assert.ok(atm !== undefined && atm.delta !== null && atm.delta > 0.4 && atm.delta < 0.6, JSON.stringify(atm))
  assert.ok(r.job.strikes.every((s) => s.iv !== null && Math.abs(s.iv - 0.25) < 1e-6 && s.ageMs === 0))
  // structured-cloneable: what the worker gets is the job, whole
  assert.deepEqual(structuredClone(r.job), r.job)
})

test('a NIFTY weekly book is scored off its forward', () => {
  const { m, q } = repairMarket()
  const view = book('NIFTY', [
    leg('NIFTY', { instrument: 'option', expiry: NIFTY_W1, strike: 25000, optType: 'CE', qty: -750, avgPrice: 90, iv: 0.15, delta: -380, lotSize: 75 }),
    leg('NIFTY', { instrument: 'future', expiry: NIFTY_W2, qty: 75, avgPrice: 25050, delta: 75, lotSize: 75 }),
  ])
  const month = monthOf(m, q, 'NIFTY', NIFTY_W1)
  assert.equal(month.source, 'parity')
  assert.equal(month.future, null)
  const lot = m.options.chain('NIFTY', NIFTY_W1)?.lotSize ?? 0
  const r = ok(repairJobOf(view, month, lot, REPAIR_NOW, 40_000))
  assert.equal(r.job.expiry, NIFTY_W1)
  assert.equal(r.job.future, month.forward)
  assert.ok(Math.abs(r.job.future - 25010) < 0.01, String(r.job.future))
  // the W2 future is not this expiry's: it goes into the offset
  assert.deepEqual(r.job.legs.map((l) => [l.id, l.qty]), [[keyOf('NIFTY', 'option', NIFTY_W1, 25000, 'CE'), -750], [OFFSET_LEG_ID, 75]])
  assert.equal(r.offsetShares, 75)
  assert.equal(r.job.dials.lotSize, 75)
  assert.equal(r.job.tailCapRupees, 40_000)
})

test('a future of the near expiry is one of the job\'s legs, at its own entry', () => {
  const { m, q } = repairMarket()
  const view = book('TCS', [
    leg('TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: -350, avgPrice: 80, iv: 0.25, delta: -140 }),
    leg('TCS', { instrument: 'future', expiry: OCT, qty: 175, avgPrice: 3390, delta: 175 }),
  ])
  const r = ok(repairJobOf(view, monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  assert.deepEqual(r.job.legs.map((l) => [l.instrument, l.qty, l.entry]), [['option', -350, 80], ['future', 175, 3390]])
  // nothing outside October: no offset leg, and the view says nothing about one
  assert.equal(r.offsetShares, 0)
  assert.equal(repairViewOf('TCS', r, [], REPAIR_NOW, false, REPAIR_NOW).offset, null)
})

test('an offset option with no vol or no forward is said: its delta is not in the offset', () => {
  const { m, q } = repairMarket()
  const month = monthOf(m, q, 'TCS', OCT)
  const oct = leg('TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: -350, avgPrice: 80, iv: 0.25, delta: -140 })
  const shares = leg('TCS', { instrument: 'share', expiry: '', qty: 1000, delta: 1000, lotSize: 1 })
  // R1 gives a November leg with no solved vol a delta of 0
  const noVol = ok(repairJobOf(book('TCS', [oct, leg('TCS', { instrument: 'option', expiry: NOV, strike: 3500, optType: 'CE', qty: 175, iv: null, delta: 0 }), shares]), month, TCS_LOT, REPAIR_NOW, null))
  assert.ok(noVol.warnings.includes('3500 CE 2026-11-24: no forward or vol — its delta is not in the offset'), JSON.stringify(noVol.warnings))
  assert.equal(noVol.offsetShares, 1000)
  // a vol but no forward for its month (book-view.ts: no greeks then either)
  const nov = leg('TCS', { instrument: 'option', expiry: NOV, strike: 3500, optType: 'CE', qty: 175, iv: 0.24, delta: 0 })
  const noFwd = ok(repairJobOf(book('TCS', [oct, nov, shares], { forwards: { [OCT]: TCS_OCT_FWD, [NOV]: null } }), month, TCS_LOT, REPAIR_NOW, null))
  assert.ok(noFwd.warnings.includes('3500 CE 2026-11-24: no forward or vol — its delta is not in the offset'), JSON.stringify(noFwd.warnings))
  // a priced month, and a future or shares (whose delta is their qty), say nothing
  const priced = ok(repairJobOf(tcsBook(), month, TCS_LOT, REPAIR_NOW, null))
  assert.equal(priced.warnings.some((w) => w.includes('its delta is not in the offset')), false, JSON.stringify(priced.warnings))
})

test('a plan that closes the offset is dropped and counted', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  const baseline = runRepairJob(r.job).filter((p) => p.flags.includes('baseline'))
  const [score] = baseline.map((p) => p.score)
  if (score === undefined) throw new Error('no baseline')
  const plans: RepairPlan[] = [
    { goal: 'REDUCE-LOSS', moves: [{ op: 'close', legId: OFFSET_LEG_ID }], score, flags: [] },
    { goal: 'REDUCE-LOSS', moves: [{ op: 'close', legId: keyOf('TCS', 'option', OCT, 3400, 'CE') }], score, flags: [] },
    ...baseline,
  ]
  const v = repairViewOf('TCS', r, plans, REPAIR_NOW, false, REPAIR_NOW)
  assert.ok(v.warnings.includes('1 plan touched the other expiries\' fixed offset and was dropped'), JSON.stringify(v.warnings))
  const reduce = v.goals.find((g) => g.goal === 'REDUCE-LOSS')
  assert.deepEqual(reduce?.plans.map((p) => p.moves.map((x) => x.op)), [['close'], []])
  assert.equal(reduce?.plans[0]?.moves[0]?.op === 'close' && reduce.plans[0].moves[0].legId !== OFFSET_LEG_ID, true)
  const two = repairViewOf('TCS', r, [plans[0] as RepairPlan, plans[0] as RepairPlan], REPAIR_NOW, false, REPAIR_NOW)
  assert.ok(two.warnings.includes('2 plans touched the other expiries\' fixed offset and were dropped'))
})

test('a card shows three plans per goal that leave the offset alone; an offset plan ranked below them is not counted', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  const [base] = runRepairJob(r.job).filter((p) => p.goal === 'REDUCE-LOSS' && p.flags.includes('baseline'))
  if (base === undefined) throw new Error('no baseline')
  const add = (strike: number): RepairPlan => ({ ...base, flags: [], moves: [{ op: 'add', strike, type: 'CE', qty: -TCS_LOT }] })
  const off: RepairPlan = { ...base, flags: [], moves: [{ op: 'hedge', strike: 3300, type: 'PE', qty: TCS_LOT }, { op: 'close', legId: OFFSET_LEG_ID }] }
  const v = repairViewOf('TCS', r, [off, add(3450), add(3500), off, add(3300), add(3350), off, base], REPAIR_NOW, false, REPAIR_NOW)
  const reduce = v.goals.find((g) => g.goal === 'REDUCE-LOSS')
  assert.deepEqual(reduce?.plans.map((p) => p.moves[0]?.op === 'add' ? p.moves[0].strike : 'baseline'), [3450, 3500, 3300, 'baseline'])
  assert.ok(v.warnings.includes('2 plans touched the other expiries\' fixed offset and were dropped'), JSON.stringify(v.warnings))
})

test('the search is asked for more than it shows, so the offset cannot crowd a goal out', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  const v = repairViewOf('TCS', r, runRepairJob(r.job), REPAIR_NOW, false, REPAIR_NOW)
  for (const g of v.goals) {
    assert.ok(g.plans.filter((p) => p.moves.length > 0).length <= REPAIR_PLANS_SHOWN, g.goal)
    assert.equal(g.plans.some((p) => p.moves.some((x) => 'legId' in x && x.legId === OFFSET_LEG_ID)), false, g.goal)
  }
  // on this book closing the 1080-share offset is what lifts the floor most, yet REDUCE-LOSS still offers three ideas
  assert.equal(v.goals.find((g) => g.goal === 'REDUCE-LOSS')?.plans.filter((p) => p.moves.length > 0).length, 3)
})

test('shares-only book', () => {
  const view = book('TCS', [leg('TCS', { instrument: 'share', expiry: '', qty: 1000, delta: 1000, lotSize: 1 })])
  assert.deepEqual(repairJobOf(view, null, TCS_LOT, REPAIR_NOW, null), { blocked: 'no option legs to repair: TCS holds only shares' })
  const both = book('TCS', [...view.legs, leg('TCS', { instrument: 'future', expiry: NOV, qty: 175, delta: 175 })])
  assert.deepEqual(repairJobOf(both, null, TCS_LOT, REPAIR_NOW, null), { blocked: 'no option legs to repair: TCS holds only shares and futures' })
  const v = repairViewOf('TCS', { blocked: 'no option legs to repair: TCS holds only shares' }, [], REPAIR_NOW, false, REPAIR_NOW)
  assert.deepEqual(v, {
    stock: 'TCS', expiry: null, asOf: REPAIR_NOW, computedAt: REPAIR_NOW, cached: false, goals: [], offset: null, warnings: [],
    error: 'no option legs to repair: TCS holds only shares',
  })
})

test('far month only', () => {
  const { m, q } = repairMarket()
  const view = book('TCS', [
    leg('TCS', { instrument: 'option', expiry: NOV, strike: 3500, optType: 'CE', qty: -175, avgPrice: 40, iv: 0.24, delta: -80 }),
    leg('TCS', { instrument: 'share', expiry: '', qty: 100, delta: 100, lotSize: 1 }),
  ])
  const r = ok(repairJobOf(view, monthOf(m, q, 'TCS', NOV), TCS_LOT, REPAIR_NOW, null))
  assert.equal(r.job.expiry, NOV)
  assert.deepEqual(r.job.legs.map((l) => [l.id, l.qty]), [[keyOf('TCS', 'option', NOV, 3500, 'CE'), -175], [OFFSET_LEG_ID, 100]])
})

test('an option leg the master does not know sets no expiry and is said', () => {
  const { m, q } = repairMarket()
  const view = book('TCS', [
    leg('TCS', { instrument: 'option', expiry: OCT, strike: 3333, optType: 'CE', qty: -175, delta: 0, matched: false }),
    leg('TCS', { instrument: 'option', expiry: NOV, strike: 3500, optType: 'CE', qty: -175, avgPrice: 40, iv: 0.24, delta: -80 }),
  ])
  const r = ok(repairJobOf(view, monthOf(m, q, 'TCS', NOV), TCS_LOT, REPAIR_NOW, null))
  assert.equal(r.job.expiry, NOV)
  assert.deepEqual(r.job.legs.map((l) => l.strike), [3500])
  assert.ok(r.warnings.includes('1 leg not understood (see the book) is left out of the repair'), JSON.stringify(r.warnings))
  const lost = book('TCS', view.legs.filter((l) => !l.matched))
  assert.deepEqual(repairJobOf(lost, null, TCS_LOT, REPAIR_NOW, null), { blocked: 'no option legs to repair: TCS holds only legs the instrument master does not know' })
})

test("after the close on an expiry day the repair works on the next expiry; the options that settled are left out (R3 final fix, M3 for repair)", () => {
  const { m, q } = repairMarket()
  const EVENING = Date.parse(`${OCT}T18:00:00+05:30`)
  // R1's view after the close: the OCT leg has no time left, so no vol and no delta
  const view = book('TCS', [
    leg('TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: -350, avgPrice: 80, iv: null, delta: 0 }),
    leg('TCS', { instrument: 'option', expiry: NOV, strike: 3500, optType: 'CE', qty: 175, avgPrice: 40, iv: 0.24, delta: 80 }),
    leg('TCS', { instrument: 'share', expiry: '', qty: 1000, avgPrice: 3300, delta: 1000, lotSize: 1 }),
  ], { closed: true })
  // today's options trade, and are priced, to the 15:40 F&O close (G6)
  assert.equal(repairExpiryOf(view, Date.parse(`${OCT}T15:39:00+05:30`)), OCT)
  assert.equal(repairExpiryOf(view, Date.parse(`${OCT}T15:40:00+05:30`)), NOV)
  const r = ok(repairJobOf(view, monthOf(m, q, 'TCS', NOV, true), TCS_LOT, EVENING, null))
  assert.equal(r.job.expiry, NOV)
  assert.deepEqual(r.job.legs.map((l) => [l.id, l.qty]), [[keyOf('TCS', 'option', NOV, 3500, 'CE'), 175], [OFFSET_LEG_ID, 1000]])
  assert.deepEqual([r.offsetShares, r.offsetLegs], [1000, 1])
  assert.ok(r.warnings.includes("1 option that expired at today's close is left out of the repair"), JSON.stringify(r.warnings))
  assert.ok(!r.warnings.some((w) => w.includes('no forward or vol')), JSON.stringify(r.warnings))
  // a book of today's expiry and shares has no option left to repair
  const alone = book('TCS', [view.legs[0]!, view.legs[2]!], { closed: true })
  assert.equal(repairExpiryOf(alone, EVENING), null)
  assert.deepEqual(repairJobOf(alone, null, TCS_LOT, EVENING, null), { blocked: "no option legs to repair: TCS holds only shares and options that expired at today's close" })
})

test('no forward for the near expiry blocks the repair', () => {
  const { m } = repairMarket()
  const month = monthOf(m, fakeQuotes(), 'TCS', OCT)
  assert.equal(month.forward, null)
  assert.deepEqual(repairJobOf(tcsBook(), month, TCS_LOT, REPAIR_NOW, null), { blocked: 'no forward for 2026-10-27 yet' })
  // the wrong month is never priced as if it were the near one
  assert.deepEqual(repairJobOf(tcsBook(), monthOf(m, repairMarket().q, 'TCS', NOV), TCS_LOT, REPAIR_NOW, null), { blocked: 'no 2026-10-27 chain to price the repair on' })
})

test('runRepairJob on a small fixture returns a baseline per goal', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  const plans = runRepairJob(r.job)
  for (const goal of GOALS) {
    assert.ok(plans.some((p) => p.goal === goal && p.flags.includes('baseline')), goal)
  }
  assert.ok(plans.some((p) => p.moves.length > 0), 'the search found something to propose')
  // deterministic: the same job is the same menu
  assert.deepEqual(runRepairJob(structuredClone(r.job)), plans)
})

test('the card: four goals in order, a line and a whatIf per plan, the offset said', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  const v = repairViewOf('TCS', r, runRepairJob(r.job), REPAIR_NOW - 5_000, true, REPAIR_NOW)
  assert.equal(v.error, null)
  assert.equal(v.expiry, OCT)
  assert.deepEqual([v.asOf, v.computedAt, v.cached], [REPAIR_NOW, REPAIR_NOW - 5_000, true])
  assert.deepEqual(v.goals.map((g) => g.goal), GOALS)
  for (const g of v.goals) {
    assert.ok(g.plans.some((p) => p.flags.includes('baseline')), g.goal)
    for (const p of g.plans) {
      assert.equal(p.lines.length, p.moves.length)
      if (p.moves.length > 0) assert.ok(p.whatIf.length >= p.moves.length, JSON.stringify(p))
      for (const w of p.whatIf) assert.ok(w.price === null || w.price > 0)
    }
  }
  assert.deepEqual(v.offset?.shares, 1080)
  assert.match(v.offset?.note ?? '', /^2 legs outside 2026-10-27 — other expiries, shares and other futures — are held as one fixed future of 1080 shares/)
  // no plan closes a leg (add, hedge or shift only); REDUCE-LOSS rolls the short call up instead: its sentence and legs
  for (const g of v.goals) for (const p of g.plans) assert.equal(p.moves.some((mv) => mv.op === 'close'), false, JSON.stringify(p.moves))
  const shift = v.goals.find((g) => g.goal === 'REDUCE-LOSS')?.plans.find((p) => p.moves.length === 1 && p.moves[0]?.op === 'shift')
  assert.ok(shift !== undefined, JSON.stringify(v.goals[0]))
  assert.deepEqual(shift.moves, [{ op: 'shift', legId: keyOf('TCS', 'option', OCT, 3400, 'CE'), toStrike: 3500 }])
  const px = (k: number): number | null => r.job.strikes.find((x) => x.strike === k && x.type === 'CE')?.price ?? null
  assert.equal(shift.lines[0], `Shift the short 3400 CE (-350) to 3500 CE: buy 2 lots (350) 3400 CE at ${(px(3400) ?? 0).toFixed(2)}, sell 2 lots (350) 3500 CE at ${(px(3500) ?? 0).toFixed(2)}`)
  assert.deepEqual(shift.whatIf, [
    { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: 350, price: px(3400) },
    { instrument: 'option', expiry: OCT, strike: 3500, optType: 'CE', qty: -350, price: px(3500) },
  ])
})

test('view says realised is not counted', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  assert.equal(REALISED_NOT_COUNTED, 'P&L already booked is not counted in these figures')
  assert.ok(repairViewOf('TCS', r, [], REPAIR_NOW, false, REPAIR_NOW).warnings.includes(REALISED_NOT_COUNTED))
})

test('outside the session the plans are priced off the last session, and say so', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook({ closed: true }), monthOf(m, q, 'TCS', OCT, true), TCS_LOT, REPAIR_NOW, null))
  assert.equal(r.job.dials.maxQuoteAgeMs, CLOSED_MAX_AGE_MS)
  assert.ok(r.warnings.includes('market closed — the plans are priced off the last session\'s quotes'))
  const dead = ok(repairJobOf(tcsBook({ warnings: [FEED_NOT_TICKING] }), monthOf(m, q, 'TCS', OCT), TCS_LOT, REPAIR_NOW, null))
  assert.equal(dead.warnings[0], FEED_NOT_TICKING)
  assert.equal(dead.job.dials.maxQuoteAgeMs, 120_000)
})

test('no lot size: nothing is opened, and the card says why', () => {
  const { m, q } = repairMarket()
  const r = ok(repairJobOf(tcsBook(), monthOf(m, q, 'TCS', OCT), 0, REPAIR_NOW, null))
  assert.ok(r.warnings.includes('the instrument master has no lot size for TCS 2026-10-27 — no plan below opens anything'))
  assert.equal(runRepairJob(r.job).some((p) => p.moves.some((x) => x.op === 'add' || x.op === 'hedge')), false)
})
