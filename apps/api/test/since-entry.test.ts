/**
 * The P&L card's book figure (`routes/pnl.ts` `sinceEntryOf`): open legs at
 * their marks against their entries, plus realised-to-date (net of the fees
 * paid), minus what closing the open legs would cost where the venue charges
 * it — "net pnl which if we close book now, we will get in account"
 * (operator, 5 Nov). The Positions page's Total is the same sum.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sinceEntryOf } from '../src/routes/pnl.ts'

type Pos = Parameters<typeof sinceEntryOf>[0]

/** Two short legs: sold at 900 and 700, marked at 800 and 750 → open +$5 − $5 = 0. */
function pos(over: Partial<Record<'realised' | 'feesPaid' | 'closeFees', number | null>> = {}, marks: Record<string, number> = { A: 800, B: 750 }): Pos {
  return {
    legs: [
      { qty: -0.05, entryPrice: 900, instrument: { tradingsymbol: 'A' } },
      { qty: -0.1, entryPrice: 700, instrument: { tradingsymbol: 'B' } },
    ],
    greeks: { legs: Object.entries(marks).map(([tradingsymbol, price]) => ({ tradingsymbol, price })) },
    ...over,
  } as unknown as Pos
}

const near = (a: number | null, b: number): void => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} vs ${b}`)

test('no closing fee on the venue (NSE): open + realised, exactly as before', () => {
  near(sinceEntryOf(pos({ realised: 12 })), 12)
})

test('Delta: the cost of closing the open legs now comes off — net if closed now', () => {
  near(sinceEntryOf(pos({ realised: 12, feesPaid: 3, closeFees: 1.5 })), 12 - 1.5)
})

test('fees paid are NOT taken twice: realised is already net of them', () => {
  near(sinceEntryOf(pos({ realised: -82.62, feesPaid: 12.05, closeFees: 7.01 })), -82.62 - 7.01)
})

test('an unknown closing cost makes the figure unknown while legs are open', () => {
  assert.equal(sinceEntryOf(pos({ realised: 12, closeFees: null })), null)
})

test('an unmarked open leg makes the figure unknown, as before', () => {
  assert.equal(sinceEntryOf(pos({ realised: 12, closeFees: 1 }, { A: 800 })), null)
})

test('no realised figure: the open legs net of closing alone', () => {
  near(sinceEntryOf(pos({ realised: null, closeFees: 2 })), -2)
})
