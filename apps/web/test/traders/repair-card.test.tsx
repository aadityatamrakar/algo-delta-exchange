/** The repair plans' layout: the do-nothing line once, three figures and a trade table per plan, folds, dedupe, badges. */
import { expect, test } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { RepairCardPlan, RepairView } from '../../../traders/src/analytics/r3-wire.ts'
import { RepairPlans, lotsText, short, signedShort, tradeRows } from '../../src/traders/repair-card.tsx'
import { leg } from './fixtures.ts'

type Score = RepairCardPlan['score']
const score = (over: Partial<Score> = {}): Score => ({
  credit: 1200, maxLoss: -45000, maxLossAt: 2950, breakevens: [2980, 3120], worstShock: -30000, worstShockAt: 2745,
  marginBefore: 150000, marginAfter: 160000, marginDelta: 10000, profitableWidthPct: 55, pop: 0.6, ...over,
})
const SHORT_CE = leg()                                                     // -175 TCS 3500 CE, lot 175
const LEGS = [SHORT_CE]
const EXP = '2026-10-27'

const BASE: RepairCardPlan = { moves: [], score: score({ credit: 0, marginDelta: 0, maxLoss: -218000, maxLossAt: 959 }), flags: ['baseline'], lines: [], whatIf: [] }
const SELL_PE: RepairCardPlan = {
  moves: [{ op: 'add', strike: 3300, type: 'PE', qty: -175 }], score: score({ credit: 56156, maxLoss: -62656, maxLossAt: 980, marginDelta: -2016550 }), flags: [],
  lines: ['Sell 1 lot (175) 3300 PE at 21.50'],
  whatIf: [{ instrument: 'option', expiry: EXP, strike: 3300, optType: 'PE', qty: -175, price: 21.5 }],
}
const CLOSE_CE: RepairCardPlan = {
  moves: [{ op: 'close', legId: SHORT_CE.key }], score: score({ credit: -256156, maxLoss: -300000 }), flags: ['degrades-floor'],
  lines: ['Close the short 3500 CE (-175): buy 1 lot (175) at 80.00'],
  whatIf: [{ instrument: 'option', expiry: EXP, strike: 3500, optType: 'CE', qty: 175, price: 80 }],
}
const SHIFT_CE: RepairCardPlan = {
  moves: [{ op: 'shift', legId: SHORT_CE.key, toStrike: 3600 }], score: score(), flags: [],
  lines: ['Shift the short 3500 CE (-175) to 3600 CE: buy 1 lot (175) 3500 CE at 80.00, sell 1 lot (175) 3600 CE at 41.00'],
  whatIf: [
    { instrument: 'option', expiry: EXP, strike: 3500, optType: 'CE', qty: 175, price: 80 },
    { instrument: 'option', expiry: EXP, strike: 3600, optType: 'CE', qty: -175, price: 41 },
  ],
}
const NONE: RepairCardPlan = { ...BASE, flags: ['baseline', 'no-feasible-plan'] }

const VIEW: RepairView = {
  stock: 'TCS', expiry: EXP, asOf: 0, computedAt: 0, cached: false,
  goals: [
    { goal: 'REDUCE-LOSS', plans: [SELL_PE, CLOSE_CE, SHIFT_CE, BASE] },
    { goal: 'PROFITABLE-BY-EXPIRY', plans: [NONE] },
    { goal: 'CHEAP-TAIL-CAP', plans: [CLOSE_CE, BASE] },
    { goal: 'MAX-CREDIT-SAFE', plans: [SELL_PE, CLOSE_CE, SHIFT_CE, BASE] },
  ],
  offset: null, warnings: [], error: null,
}

test('rupees in short form, signed with a true minus', () => {
  expect([short(950), short(62656), short(218000), short(12_500_000)]).toEqual(['950', '62.7 k', '2.18 L', '1.25 Cr'])
  expect([signedShort(-62656), signedShort(10000), signedShort(0)]).toEqual(['−62.7 k', '+10.0 k', '0'])
  expect([lotsText(-350, 175), lotsText(100, 175), lotsText(175, null)]).toEqual(['2', '100 sh', '175 sh'])
})

test('a plan\'s trades: an add is one row, a close one marked row, a shift a marked pair; a missing price is a dash', () => {
  expect(tradeRows(SELL_PE, LEGS)).toEqual([{ side: 'Sell', qty: -175, contract: '3300 PE', price: 21.5, mark: null }])
  expect(tradeRows(CLOSE_CE, LEGS)).toEqual([{ side: 'Buy', qty: 175, contract: '3500 CE', price: 80, mark: 'close' }])
  expect(tradeRows(SHIFT_CE, LEGS)).toEqual([
    { side: 'Buy', qty: 175, contract: '3500 CE', price: 80, mark: 'shift' },
    { side: 'Sell', qty: -175, contract: '3600 CE', price: 41, mark: 'shift' },
  ])
  expect(tradeRows({ ...SHIFT_CE, whatIf: [] }, LEGS).map((r) => r.price)).toEqual([null, null])
})

test('the do-nothing line is shown once, at the top; no plan sentence and no "baseline" tag', () => {
  render(<RepairPlans stock="TCS" view={VIEW} legs={LEGS} />)
  expect(screen.getAllByText(/^Now \(do nothing\)/).map((e) => e.textContent)).toEqual(['Now (do nothing): worst loss ₹2.18 L at 959'])
  expect(screen.queryByText(/baseline/)).toBe(null)
  expect(screen.queryByText('Sell 1 lot (175) 3300 PE at 21.50')).toBe(null)
})

test('each plan heads with Credit or Debit, worst loss against now, and the margin change; then its trade table', () => {
  render(<RepairPlans stock="TCS" view={VIEW} legs={LEGS} />)
  const first = screen.getAllByRole('table')[0] as HTMLElement
  expect(within(first).getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['Sell13300 PE21.50'])
  expect(screen.getAllByText('Credit')).toHaveLength(1)                  // Reduce loss's first plan; Max credit repeats it
  expect(screen.getByText('₹56.2 k')).toBeTruthy()
  expect(screen.getByText('−62.7 k at 980')).toBeTruthy()
  expect(screen.getAllByText('was −2.18 L').length).toBeGreaterThan(0)
  expect(screen.getByText('−20.17 L')).toBeTruthy()
})

test('a goal shows its first plan; the rest fold under "N more plans"', () => {
  render(<RepairPlans stock="TCS" view={VIEW} legs={LEGS} />)
  expect(screen.getAllByRole('button', { name: /^Show on payoff — Reduce loss/ })).toHaveLength(1)
  expect(screen.getAllByText('Debit')).toHaveLength(1)                   // Cheap tail cap's close
  fireEvent.click(screen.getByRole('button', { name: '2 more plans' }))
  expect(screen.getAllByRole('button', { name: /^Show on payoff — Reduce loss/ })).toHaveLength(3)
  expect(screen.getAllByText('Debit')).toHaveLength(2)
  expect(screen.getAllByText('shift')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Fewer plans' }))
  expect(screen.getAllByRole('button', { name: /^Show on payoff — Reduce loss/ })).toHaveLength(1)
})

test('a goal with the same plans as an earlier one says so; a goal with none says that', () => {
  render(<RepairPlans stock="TCS" view={VIEW} legs={LEGS} />)
  expect(screen.getByText('Same plans as Reduce loss')).toBeTruthy()
  expect(screen.queryAllByRole('button', { name: /^Show on payoff — Max credit/ })).toEqual([])
  expect(screen.getByText('No plan meets this goal')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Profitable by expiry' })).toBeTruthy()
  // Cheap tail cap's one plan is not Reduce loss's list, so it is shown, with its tag in words.
  expect(screen.getAllByRole('button', { name: /^Show on payoff — Cheap tail cap/ })).toHaveLength(1)
  expect(screen.getByText('Worse worst case')).toBeTruthy()
  expect(screen.queryByText('degrades-floor')).toBe(null)
})

test('every control on the plans, folds open, shows on payoff or folds — nothing trades (spec item 6)', () => {
  render(<RepairPlans stock="TCS" view={VIEW} legs={LEGS} />)
  fireEvent.click(screen.getByRole('button', { name: '2 more plans' }))
  const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
  expect(names.filter((n) => n.startsWith('Show on payoff — '))).toHaveLength(4)
  expect(names.filter((n) => !/^Show on payoff — |^Fewer plans$|^\d+ more plans?$/.test(n))).toEqual([])
})
