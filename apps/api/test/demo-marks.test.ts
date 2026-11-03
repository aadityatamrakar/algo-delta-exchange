/**
 * Demo-rail books are marked at Delta TESTNET prices (md.tick.demo), so the
 * desk's P&L matches the demo account's UPNL; sim-rail and live books keep
 * production's. A demo leg with no testnet quote yet falls back to
 * production, and the row says so.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuoteCache } from '../src/marks.ts'
import { pnlRowFor, venueResolversFor } from '../src/pnl-jobs.ts'
import { pnlUpdateFor } from '../src/stream.ts'
import { RailIndex } from '../src/demo-marks.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import type { StampedFill } from '../src/rollup.ts'

const NOW = Date.UTC(2026, 10, 10, 8)
const P77 = 'P-BTC-77000-131126'
const C77 = 'C-BTC-77000-131126'
const TOKENS: Record<string, number> = { [P77]: 501, [C77]: 502 }

function rig() {
  const prod = new QuoteCache({ now: () => NOW })
  const demo = new QuoteCache({ now: () => NOW })
  const master = {
    current: () => ({
      resolveSymbol: (s: string) =>
        TOKENS[s] === undefined
          ? null
          : { tradingsymbol: s, instrumentToken: TOKENS[s], lotSize: 0.001, tickSize: 0.1, exchange: 'DELTA' },
    }),
  }
  const rails = new RailIndex()
  rails.set([
    { tag: 'bs-demo', mode: 'paper', dx_paper_rail: 'demo', dx_rail_used: 'demo' },
    { tag: 'bs-sim', mode: 'paper', dx_paper_rail: 'sim', dx_rail_used: 'sim' },
  ])
  const deps = {
    marks: prod,
    demoMarks: demo,
    marksVenue: (tag: string, mode: string) => rails.venueOf(tag, mode),
    master,
    now: () => NOW,
  } as unknown as ApiDeps
  return { prod, demo, deps }
}

// Short 100 contracts (0.1 BTC) of the 77000 put at 1900.
const shortPut: StampedFill = { tradingsymbol: P77, side: 'Sell', qty: 0.1, price: 1900, ts: NOW - 60_000 }

function row(deps: ApiDeps, tag: string, fills: StampedFill[] = [shortPut]) {
  const r = venueResolversFor(deps, {}, tag, 'paper')
  return pnlRowFor({ tag, label: tag, mode: 'paper', fills, boundary: NOW - 3_600_000, malformed: [], ...r })
}

test('a demo-rail book is marked at the testnet ask; a sim-rail book at production', () => {
  const { prod, demo, deps } = rig()
  prod.update(501, 1783.5, NOW, { bid: 1780, ask: 1783.5 })
  demo.update(501, 1808.5, NOW, { bid: 1805, ask: 1808.5 })

  const d = row(deps, 'bs-demo')
  assert.equal(d.legs[0]?.mark, 1808.5)
  assert.equal(d.marksSource, 'delta-demo')
  assert.deepEqual(d.marksFallback, [])
  assert.equal(d.complete, true)
  assert.ok(Math.abs((d.unrealised ?? NaN) - (1900 - 1808.5) * 0.1) < 1e-9)

  const s = row(deps, 'bs-sim')
  assert.equal(s.legs[0]?.mark, 1783.5)
  assert.equal(s.marksSource, 'delta')
  assert.deepEqual(s.marksFallback, [])
})

test('no testnet quote yet: production prices the leg and the row names it — never silently', () => {
  const { prod, demo, deps } = rig()
  prod.update(501, 1783.5, NOW, { bid: 1780, ask: 1783.5 })
  prod.update(502, 400, NOW, { bid: 398, ask: 401 })
  demo.update(502, 410, NOW, { bid: 408, ask: 411 })
  const fills: StampedFill[] = [shortPut, { tradingsymbol: C77, side: 'Sell', qty: 0.1, price: 450, ts: NOW - 60_000 }]
  const d = row(deps, 'bs-demo', fills)
  assert.equal(d.legs.find((l) => l.tradingsymbol === P77)?.mark, 1783.5, 'fell back to production')
  assert.equal(d.legs.find((l) => l.tradingsymbol === C77)?.mark, 411, 'the quoted leg stays on demo')
  assert.deepEqual(d.marksFallback, [P77])
  assert.equal(d.quotes?.[P77]?.ask, 1783.5, 'the pair shown is the one that priced it')
})

test('neither feed has a quote: the leg is unpriced, not a fallback', () => {
  const { deps } = rig()
  const d = row(deps, 'bs-demo')
  assert.deepEqual(d.unpriced, [P77])
  assert.deepEqual(d.marksFallback, [])
  assert.equal(d.total, null)
})

test('a book the index has not seen is marked at production', () => {
  const { prod, demo, deps } = rig()
  prod.update(501, 1783.5, NOW, { bid: 1780, ask: 1783.5 })
  demo.update(501, 1808.5, NOW, { bid: 1805, ask: 1808.5 })
  assert.equal(row(deps, 'unknown').legs[0]?.mark, 1783.5)
})

test('a change of price source or fallback reaches the socket as a full row', () => {
  const { prod, demo, deps } = rig()
  prod.update(501, 1783.5, NOW, { bid: 1780, ask: 1783.5 })
  const before = row(deps, 'bs-demo')
  demo.update(501, 1783.5, NOW, { bid: 1780, ask: 1783.5 }) // same price, now from demo
  const after = row(deps, 'bs-demo')
  assert.deepEqual(before.marksFallback, [P77])
  assert.deepEqual(after.marksFallback, [])
  assert.equal(pnlUpdateFor(before, after).kind, 'full')
})

test('RailIndex: venue by tag and mode; live is always production', () => {
  const rails = new RailIndex()
  rails.set([
    { tag: 'a', mode: 'paper', dx_paper_rail: 'demo', dx_rail_used: null },
    { tag: 'a', mode: 'live', dx_paper_rail: 'demo', dx_rail_used: null },
  ])
  assert.equal(rails.venueOf('a', 'paper'), 'demo')
  assert.equal(rails.venueOf('a', 'live'), 'prod')
  assert.equal(rails.venueOf('b', 'paper'), 'prod')
})
