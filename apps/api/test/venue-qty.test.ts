/**
 * QUANTITIES ON A 0.001 GRID — the engine wire, the book fold and the
 * marketable limit on Delta (DX), with NSE unchanged.
 *
 * On the desk side a Delta quantity is BTC (0.05 = 50 contracts of 0.001). The
 * wire must accept a positive multiple of the venue step and nothing else; the
 * fold must land on exactly 0 when a position is closed, however many partial
 * fills built it; and a marketable limit must sit on Delta's 0.1 tick.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DX, NSE } from '@algomaker/venue'
import { applyRoutedFill } from '../src/book.ts'
import type { InstrumentRef } from '@algomaker/order-bus'
import { marketableFromEnv, marketableLimit } from '../src/marketable.ts'
import { validateDecisionRequest } from '../src/routes/engine.ts'

const TAG = 'BTC-D-bull-s'

function request(actions: unknown[]): Record<string, unknown> {
  return {
    symbol: 'BTC',
    expiry: '2026-11-06',
    mode: 'paper',
    tag: TAG,
    decisionId: `${TAG}:paper:1`,
    trigger: 'none',
    reason: '',
    actions,
  }
}

const open = (qty: number) => ({ op: 'open', instrument: 'C-BTC-70000-061126', side: 'Sell', qty })
const resize = (targetQty: number) => ({ op: 'resize', instrument: 'C-BTC-70000-061126', targetQty })

// ────────────────────────────────────────────────────────── the wire

test('DX wire: 0.05 BTC is a valid open quantity', () => {
  const r = validateDecisionRequest(request([open(0.05)]), DX)
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  if (r.ok) assert.equal(r.value.actions[0]?.op === 'open' && r.value.actions[0].qty, 0.05)
})

test('DX wire: 0.0505 BTC is refused — it is not a whole number of contracts', () => {
  const r = validateDecisionRequest(request([open(0.0505)]), DX)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /0\.001/)
})

test('DX wire: a float-noisy sum (0.15000000000000002) is refused, not rounded', () => {
  const r = validateDecisionRequest(request([open(0.05 + 0.05 + 0.05)]), DX)
  assert.equal(r.ok, false)
})

test('DX wire: resize to 0.1 is valid, to 0.1005 is not, to 0 is flat', () => {
  assert.equal(validateDecisionRequest(request([resize(0.1)]), DX).ok, true)
  assert.equal(validateDecisionRequest(request([resize(0.1005)]), DX).ok, false)
  assert.equal(validateDecisionRequest(request([resize(0)]), DX).ok, true)
})

test('NSE wire is unchanged: integers only, and the default venue is NSE', () => {
  assert.equal(validateDecisionRequest(request([open(75)])).ok, true)
  assert.equal(validateDecisionRequest(request([open(75)]), NSE).ok, true)
  const frac = validateDecisionRequest(request([open(0.05)]))
  assert.equal(frac.ok, false)
  if (!frac.ok) assert.match(frac.error, /positive integer CONTRACT quantity/)
  assert.equal(validateDecisionRequest(request([open(75.0000001)]), NSE).ok, false)
  assert.equal(validateDecisionRequest(request([resize(0.5)]), NSE).ok, false)
})

// ────────────────────────────────────────────────────────── the fold

const BTC_CE: InstrumentRef = {
  tradingsymbol: 'C-BTC-70000-061126',
  instrumentToken: 101,
  lotSize: 0.001,
  tickSize: 0.1,
  exchange: 'DX',
}

function fill(side: 'Buy' | 'Sell', qty: number, price: number, ts: number) {
  return {
    instrument: BTC_CE,
    underlying: 'BTC',
    expiry: '2026-11-06',
    strike: 70_000,
    type: 'CE' as const,
    side,
    qty,
    price,
    ts,
    deskTag: 'bs-70000-CE',
  }
}

test('three 50-contract fills then a 150-contract close leaves qty exactly 0', () => {
  let book = applyRoutedFill([], fill('Sell', 0.05, 300, 1))
  book = applyRoutedFill(book, fill('Sell', 0.05, 310, 2))
  book = applyRoutedFill(book, fill('Sell', 0.05, 320, 3))
  assert.equal(book.length, 1)
  assert.equal(book[0]?.qty, -0.15, 'the sum is on the grid, not -0.15000000000000002')
  assert.ok(Math.abs((book[0]?.entryPrice ?? 0) - 310) < 1e-9)

  book = applyRoutedFill(book, fill('Buy', 0.15, 250, 4))
  assert.deepEqual(book, [], 'flat removes the leg — no 2.7e-17 residue')
})

test('partial closes of 1 contract walk down to exactly 0', () => {
  let book = applyRoutedFill([], fill('Sell', 0.003, 300, 1))
  for (let i = 0; i < 3; i++) book = applyRoutedFill(book, fill('Buy', 0.001, 290, 2 + i))
  assert.deepEqual(book, [])
})

// ──────────────────────────────────────────────────── marketable limit

test('DX marketable limit sits on the 0.1 tick', () => {
  const cfg = marketableFromEnv({ DESK_VENUE: 'dx' })
  assert.equal(cfg.tickSize, 0.1)
  for (const mark of [305.37, 1234.56, 12.34, 0.73]) {
    for (const side of ['Buy', 'Sell'] as const) {
      const px = marketableLimit(side, mark, cfg)
      assert.ok(px !== null)
      const ticks = px / 0.1
      assert.ok(Math.abs(ticks - Math.round(ticks)) < 1e-9, `${side} ${mark} → ${px}`)
      assert.equal(px, Number(px.toFixed(1)), `${px} has no float tail`)
    }
  }
})

test('NSE marketable defaults are unchanged (0.05 tick)', () => {
  assert.equal(marketableFromEnv({}).tickSize, 0.05)
  assert.equal(marketableLimit('Sell', 100, marketableFromEnv({})), 98)
  assert.equal(marketableLimit('Buy', 7.2, marketableFromEnv({})), 7.35)
})
