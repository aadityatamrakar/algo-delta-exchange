/**
 * Margin utilized (operator, 3 Nov): the Delta accounts' margin as the gateway
 * read it, and each BULL-S book's estimated margin — now, and at its cap.
 * Pure: no Mongo, no HTTP.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDials } from '@algomaker/desk-engine'
import { accountMarginView, ACCOUNT_MARGIN_STALE_MS, bookMarginEstimate } from '../src/dx-margin.ts'

const NOW = Date.parse('2026-11-04T08:00:00Z')

const okRow = {
  _id: 'delta-demo',
  asOf: NOW - 10_000,
  ok: true,
  error: '',
  rail: 'demo',
  balance: 1000,
  available: 850,
  positionMargin: 140,
  orderMargin: 10,
  portfolioMargin: 0,
  used: 150,
  utilizedPct: 15,
}

test('both accounts are always listed, demo first; a missing row is absent with a reason, never zeros', () => {
  const v = accountMarginView([okRow], NOW)
  assert.equal(v.inrPerUsd, 85)
  assert.deepEqual(v.accounts.map((a) => [a.id, a.rail, a.label, a.state]), [
    ['delta-demo', 'demo', 'Demo', 'ok'],
    ['delta', 'live', 'Live', 'absent'],
  ])
  const demo = v.accounts[0]!
  assert.deepEqual(
    [demo.balance, demo.available, demo.positionMargin, demo.orderMargin, demo.used, demo.utilizedPct, demo.ageMs],
    [1000, 850, 140, 10, 150, 15, 10_000],
  )
  const live = v.accounts[1]!
  assert.equal(live.balance, null)
  assert.equal(live.utilizedPct, null)
  assert.match(live.reason, /gateway has not read/)
})

test('a failed read is failed with its error and no figures; an old read is stale and keeps its figures', () => {
  const failed = accountMarginView(
    [{ _id: 'delta', asOf: NOW - 5_000, ok: false, error: 'Delta /v2/wallet/balances failed: 401', balance: null, used: null }],
    NOW,
  ).accounts[1]!
  assert.equal(failed.state, 'failed')
  assert.equal(failed.balance, null)
  assert.match(failed.error, /401/)
  const stale = accountMarginView([{ ...okRow, asOf: NOW - ACCOUNT_MARGIN_STALE_MS - 1 }], NOW).accounts[0]!
  assert.equal(stale.state, 'stale')
  assert.equal(stale.balance, 1000)
  assert.match(stale.reason, /old/)
  // A row that says ok but carries a non-number is NOT a zero.
  const junk = accountMarginView([{ ...okRow, balance: 'x' }], NOW).accounts[0]!
  assert.equal(junk.balance, null)
})

const dials = resolveDials({
  bs_enabled: true,
  bs_strike_step: 200,
  bs_lots_start: 50,
  bs_lots_step: 50,
  bs_lots_cap: 120,
  bs_max_open: 4,
  bs_margin_budget: 1500,
}).dials

const leg = (strike: number, type: 'CE' | 'PE', qty: number, token: number) => ({
  deskTag: `${type}${strike}`,
  instrument: { tradingsymbol: `${type === 'CE' ? 'C' : 'P'}-BTC-${strike}-051126`, instrumentToken: token, lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA' },
  underlying: 'BTC',
  expiry: '2026-11-05',
  strike,
  type,
  side: qty < 0 ? ('Sell' as const) : ('Buy' as const),
  qty,
  entryPrice: 1000,
  openedTs: 1,
})

test('the current estimate sums the SHORT legs at mark, index and leverage; the worst case is the pyramid at the ATM marks', () => {
  const marks = new Map([[11, 1000], [12, 900], [21, 1100], [22, 800]])
  const lev = new Map([[11, 100], [12, 100], [21, 100], [22, 100]])
  const e = bookMarginEstimate({
    tag: 'BS-D1',
    mode: 'paper',
    dials,
    legs: [leg(80_000, 'CE', -0.05, 11), leg(80_000, 'PE', -0.05, 12), leg(81_000, 'CE', 0.01, 99)],
    index: 80_000,
    markOf: (t) => marks.get(t) ?? null,
    leverageOf: (t) => lev.get(t) ?? null,
    atm: { strike: 80_200, ceToken: 21, peToken: 22 },
    lotSize: 0.001,
  })
  // (1000 + 900) × 0.05 + 2 × 0.05 × 80000 / 100 = 95 + 80; the long leg costs no margin.
  assert.deepEqual(e.current, { usd: 175, shortLegs: 2, missing: [] })
  // Σ 390 contracts = 0.39: (1100 + 800) × 0.39 + 2 × 0.39 × 800 = 741 + 624
  assert.deepEqual(e.worstAtCap, { usd: 1365, atmStrike: 80_200, sizes: [50, 100, 120, 120], unbounded: false, missing: [] })
  assert.equal(e.budget, 1500)
})

test('a missing mark, leverage or index is named and the figure is null — never a guess', () => {
  const e = bookMarginEstimate({
    tag: 'BS-D1',
    mode: 'paper',
    dials,
    legs: [leg(80_000, 'CE', -0.05, 11)],
    index: 80_000,
    markOf: () => 1000,
    leverageOf: () => null,
    atm: null,
    lotSize: 0.001,
  })
  assert.equal(e.current.usd, null)
  assert.deepEqual(e.current.missing, ['C-BTC-80000-051126: no leverage'])
  assert.equal(e.worstAtCap.usd, null)
  assert.match(e.worstAtCap.missing.join(), /no listed ATM strike/)
  const noIndex = bookMarginEstimate({
    tag: 'x', mode: 'paper', dials, legs: [], index: null, markOf: () => 1, leverageOf: () => 1, atm: null, lotSize: 0.001,
  })
  assert.deepEqual(noIndex.current, { usd: null, shortLegs: 0, missing: ['no BTC index price'] })
  const unbounded = bookMarginEstimate({
    tag: 'x', mode: 'paper', dials: resolveDials({ ...dials, bs_max_open: 0 }).dials,
    legs: [], index: 80_000, markOf: () => 1, leverageOf: () => 100, atm: { strike: 80_000, ceToken: 1, peToken: 2 }, lotSize: 0.001,
  })
  assert.deepEqual(unbounded.current, { usd: 0, shortLegs: 0, missing: [] })
  assert.deepEqual(unbounded.worstAtCap, { usd: null, atmStrike: 80_000, sizes: [], unbounded: true, missing: [] })
})
