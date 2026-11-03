import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { OptionType } from '@algomaker/greeks'
import type { Move, PayoffLeg } from '@algomaker/payoff'
import { planLines, planWhatIf, type PlanLineInputs } from '../src/analytics/repair.ts'

const OCT = '2026-10-27'
const k1: PayoffLeg = { id: 'k1', instrument: 'option', qty: -350, strike: 3400, type: 'CE', expiry: OCT, entry: 80, iv: 0.25 }
const p1: PayoffLeg = { id: 'p1', instrument: 'option', qty: 175, strike: 3200, type: 'PE', expiry: OCT, entry: 9, iv: 0.27 }
const f1: PayoffLeg = { id: 'f1', instrument: 'future', qty: 175, strike: null, type: null, expiry: OCT, entry: 3400, iv: null }
const PRICES: Record<string, number> = { '3400CE': 61, '3500CE': 30, '3300PE': 12, '3600CE': 42.5, '3200PE': 6 }
const mark = (strike: number, type: OptionType): number | null => PRICES[`${strike}${type}`] ?? null
/** The plan search's fill: a buy pays a rupee over the mark, a sell takes a rupee under. */
const crossing = (strike: number, type: OptionType, qty: number): number | null => {
  const p = mark(strike, type)
  return p === null ? null : qty > 0 ? p + 1 : p - 1
}

const CARD: PlanLineInputs = { legs: [k1, p1, f1], lotSize: 175, priceOf: crossing, futureMark: 3412.4, expiry: OCT, stock: 'TCS' }

test('card lines name the stock, the contract and the fill price', () => {
  const moves: Move[] = [
    { op: 'add', strike: 3600, type: 'CE', qty: -175 },
    { op: 'hedge', strike: 3300, type: 'PE', qty: 350 },
    { op: 'future', qty: 350 },
    { op: 'future', qty: -175 },
    { op: 'shift', legId: 'k1', toStrike: 3500 },
    { op: 'close', legId: 'p1' },
    { op: 'close', legId: 'f1' },
  ]
  assert.deepEqual(planLines(moves, CARD), [
    'Sell 1 lot TCS 27 Oct 3600 CE @ 41.50',
    'Buy 2 lots TCS 27 Oct 3300 PE @ 13.00',
    'Buy 2 lots TCS Oct FUT @ 3412.40',
    'Sell 1 lot TCS Oct FUT @ 3412.40',
    'Shift short TCS 27 Oct 3400 CE to 3500 CE: buy 2 lots @ 62.00, sell 2 lots 3500 CE @ 29.00',
    'Close long TCS 27 Oct 3200 PE: sell 1 lot @ 5.00',
    'Close long TCS Oct FUT: sell 1 lot @ 3412.40',
  ])
})

test('card lines say what they do not know: shares off the lot, no price, no future mark, an unknown leg', () => {
  const inp: PlanLineInputs = { ...CARD, futureMark: null }
  assert.deepEqual(planLines([
    { op: 'add', strike: 3600, type: 'CE', qty: -100 },
    { op: 'add', strike: 3450, type: 'CE', qty: -175 },
    { op: 'future', qty: 175 },
    { op: 'close', legId: 'nope' },
  ], inp), [
    'Sell 100 shares TCS 27 Oct 3600 CE @ 41.50',
    'Sell 1 lot TCS 27 Oct 3450 CE (no price)',
    'Buy 1 lot TCS Oct FUT @ market',
    'close nope',
  ])
})

test('without a stock the lines keep the repair card\'s own wording, and a future reads the same way', () => {
  const inp: PlanLineInputs = { legs: [k1, f1], lotSize: 175, priceOf: (k, t) => mark(k, t), expiry: OCT, futureMark: 3412.4 }
  assert.deepEqual(planLines([
    { op: 'shift', legId: 'k1', toStrike: 3500 },
    { op: 'add', strike: 3300, type: 'PE', qty: -175 },
    { op: 'close', legId: 'f1' },
    { op: 'future', qty: -350 },
  ], inp), [
    'Shift the short 3400 CE (-350) to 3500 CE: buy 2 lots (350) 3400 CE at 61.00, sell 2 lots (350) 3500 CE at 30.00',
    'Sell 1 lot (175) 3300 PE at 12.00',
    'Close the long FUT (+175): sell 1 lot (175) at the market',
    'Sell 2 lots (350) FUT at 3412.40',
  ])
})

test('planWhatIf is the plan as Scenario rows at the same fills its lines quote', () => {
  assert.deepEqual(planWhatIf([{ op: 'add', strike: 3600, type: 'CE', qty: -175 }, { op: 'future', qty: 350 }], CARD), [
    { instrument: 'option', expiry: OCT, strike: 3600, optType: 'CE', qty: -175, price: 41.5 },
    { instrument: 'future', expiry: OCT, strike: null, optType: null, qty: 350, price: 3412.4 },
  ])
})
