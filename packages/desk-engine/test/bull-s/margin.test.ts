import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bullSPyramid,
  bullSWorstAtCap,
  bsSizeAfter,
  marginModeOf,
  PORTFOLIO_MARGIN_HEADROOM,
  quoteMark,
  shortOptionMargin,
} from '../../src/bull-s/margin.ts'
import { dialsOf, q, Run, T0 } from './fixture.ts'

const S = 1_000

test('short option margin ≈ mark × qty + qty × index ÷ leverage — the demo account check', () => {
  // 5 contracts short C-BTC-77000-061126 at mark $1,350, 100×, index $77,460:
  // Delta's testnet showed position_margin $10.61.
  const m = shortOptionMargin({ mark: 1350, qty: 0.005, index: 77_460, leverage: 100 })
  assert.equal(m, 10.623)
  assert.ok(Math.abs(m - 10.61) < 0.05)
})

test('the mark is the mid of a two-sided quote, else the last price, else none', () => {
  assert.equal(quoteMark(q(10, 12, 50)), 11)
  assert.equal(quoteMark(q(null, 12, 50)), 50)
  assert.equal(quoteMark(q(null, null, null)), null)
  assert.equal(quoteMark(null), null)
})

test('the pyramid up to bs_max_open, capped, and the worst case at cap at the ATM marks', () => {
  const dials = dialsOf({ bs_lots_start: 50, bs_lots_step: 50, bs_lots_cap: 120, bs_max_open: 4 })
  assert.deepEqual(bullSPyramid(dials), [50, 100, 120, 120])
  const w = bullSWorstAtCap({ dials, lotSize: 0.001, index: 80_000, ceMark: 1_000, peMark: 900, ceLeverage: 100, peLeverage: 100 })
  // Σ contracts 390 = 0.39 BTC: (1000 + 900) × 0.39 + 2 × 0.39 × 80000 / 100
  assert.deepEqual(w, { usd: 1365, sizes: [50, 100, 120, 120], unbounded: false })
  const open = bullSWorstAtCap({
    dials: dialsOf({ bs_max_open: 0 }), lotSize: 0.001, index: 80_000, ceMark: 1, peMark: 1, ceLeverage: 100, peLeverage: 100,
  })
  assert.deepEqual(open, { usd: null, sizes: [], unbounded: true })
})

test('bs_margin_budget refuses a new straddle that would take the book over budget, naming the figures', () => {
  // Daily preset: size 50 contracts = 0.05 BTC. Near 80,000 the model prices
  // a straddle at ~2,000 a side: ~0.05 × 4,000 + 2 × 0.05 × 80,000 / 100 ≈ 280.
  const tight = new Run(dialsOf({ bs_margin_budget: 100 }))
  const d = tight.tick(80_090, T0)
  assert.deepEqual(d.actions, [])
  assert.match(d.reason, /margin budget: est \$\d+\.\d\d > \$100/)
  const room = new Run(dialsOf({ bs_margin_budget: 600 }))
  assert.equal(room.tick(80_090, T0).actions.length, 2, 'inside budget: the straddle goes on')
  // The SECOND straddle is checked with the first one's margin in the total.
  const second = room.tick(80_250, T0 + S)
  assert.match(second.reason, /margin budget: est \$\d+\.\d\d > \$600 \(held \$\d+\.\d\d \+ this straddle/)
  assert.deepEqual(second.actions, [])
})

test('0 is off, and an unknown leverage refuses only while a budget is set', () => {
  const off = new Run(dialsOf({ bs_margin_budget: 0 }))
  assert.equal(off.tick(80_090, T0, { leverage: null }).actions.length, 2)
  const on = new Run(dialsOf({ bs_margin_budget: 10_000 }))
  const d = on.tick(80_090, T0, { leverage: null })
  assert.deepEqual(d.actions, [])
  assert.match(d.reason, /margin budget: no leverage for the \d+ (CE|PE)/)
})

test('a stop is never blocked by the margin budget', () => {
  const run = new Run(dialsOf({ bs_margin_budget: 1_000, bs_stop_confirm_s: 0, bs_loss_cap: 0 }))
  run.tick(80_090, T0)
  assert.equal(run.state.bs.groups.length, 1)
  const g = run.state.bs.groups[0]!
  // Over budget now (a tiny budget) and the straddle's asks far over its stop.
  const ask = (g.ceEntry + g.peEntry) * 2
  const stop = run.tick(80_100, T0 + S, {
    dials: dialsOf({ bs_margin_budget: 1, bs_stop_confirm_s: 0, bs_loss_cap: 0 }),
    chain: { quotes: { [`${g.strike}CE`]: q(ask - 2, ask, ask), [`${g.strike}PE`]: q(ask - 2, ask, ask) } },
  })
  assert.equal(stop.trigger, 'bs-stop')
  assert.equal(stop.actions.length, 2)
})

test('portfolio margin: 1% notional with headroom, never the premium — the demo probe of 4 Nov', () => {
  // A resting 10-contract sell of C-BTC-77000-131126 at 1.1× mark, index $77,390,
  // blocked $8.78 on the portfolio-margin testnet account; the premium ($20.62) was not.
  const m = shortOptionMargin({ mark: 2_062, qty: 0.01, index: 77_390, leverage: 100, mode: 'portfolio' })
  assert.equal(PORTFOLIO_MARGIN_HEADROOM, 1.25)
  assert.equal(m, 9.67375)
  assert.ok(m >= 8.78, 'never under what Delta blocked')
  // The same short on an isolated (or unknown) account keeps the premium term.
  assert.equal(shortOptionMargin({ mark: 2_062, qty: 0.01, index: 77_390, leverage: 100, mode: 'isolated' }), 28.359)
  assert.equal(shortOptionMargin({ mark: 2_062, qty: 0.01, index: 77_390, leverage: 100, mode: null }), 28.359)
  assert.equal(marginModeOf('portfolio'), 'portfolio')
  assert.equal(marginModeOf('cross'), null)
})

test('the budget prices by the account mode: a straddle refused on isolated goes on under portfolio', () => {
  // ~0.05 × 4,000 + 2 × 0.05 × 80,000 / 100 ≈ 280 isolated; 2 × 40 × 1.25 = 100 portfolio.
  const iso = new Run(dialsOf({ bs_margin_budget: 150 }))
  assert.deepEqual(iso.tick(80_090, T0, { marginMode: 'isolated' }).actions, [])
  const pm = new Run(dialsOf({ bs_margin_budget: 150 }))
  assert.equal(pm.tick(80_090, T0, { marginMode: 'portfolio' }).actions.length, 2)
})

test('a retune of the lot dials re-derives the next size for the straddles held', () => {
  const before = dialsOf({ bs_lots_start: 20, bs_lots_step: 20, bs_lots_cap: 100, bs_max_open: 5 })
  const run = new Run(before)
  run.tick(80_090, T0)
  run.tick(80_250, T0 + S)
  assert.equal(run.state.bs.groups.length, 2)
  assert.equal(run.state.bs.size, 60)
  run.dials = dialsOf({ bs_lots_start: 10, bs_lots_step: 10, bs_lots_cap: 100, bs_max_open: 5 })
  const d = run.tick(80_260, T0 + 2 * S)
  assert.equal(run.state.bs.size, 30, 'start 10, one step per held straddle')
  assert.equal(bsSizeAfter(2, run.dials), 30)
  assert.match(d.reason, /lot dials retuned to start\/step\/cap 10\/10\/100: next size 60 → 30 for the 2 straddle\(s\) held/)
  // Said once: the next pass carries the new size silently.
  assert.doesNotMatch(run.tick(80_270, T0 + 3 * S).reason, /lot dials retuned/)
})

test('a row from before sizedBy adopts its size as-is — the deploy alone never resizes a book', () => {
  const run = new Run(dialsOf({ bs_lots_start: 20, bs_lots_step: 20, bs_lots_cap: 100, bs_max_open: 5 }))
  run.tick(80_090, T0)
  run.state = { ...run.state, bs: { ...run.state.bs, size: 45, sizedBy: '' } }
  const d = run.tick(80_100, T0 + S)
  assert.equal(run.state.bs.size, 45)
  assert.equal(run.state.bs.sizedBy, '20/20/100')
  assert.doesNotMatch(d.reason, /lot dials retuned/)
})
