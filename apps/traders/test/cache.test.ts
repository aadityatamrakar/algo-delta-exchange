import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TtlCache } from '../src/analytics/cache.ts'
import { liveExpiryFrom, nearExpiryOf } from '../src/analytics/near-expiry.ts'
import type { BookView, LegView } from '../src/types.ts'
import { DEC, NIFTY_W1, NIFTY_W2, NIFTY_W3, NOV, OCT, SENSEX_W1, r3Master } from './fixtures/r3-market.ts'

function counting(): { calls: () => number; compute: () => Promise<{ n: number }> } {
  let n = 0
  return { calls: () => n, compute: async () => ({ n: ++n }) }
}

test('one compute per key inside the ttl, shared by every caller', async () => {
  const c = new TtlCache<{ n: number }>(60_000)
  const k = counting()
  const a = await c.get('a', 0, k.compute)
  const b = await c.get('a', 59_999, k.compute)
  assert.equal(k.calls(), 1)
  assert.equal(a, b)
})
test('a call at the ttl recomputes', async () => {
  const c = new TtlCache<{ n: number }>(60_000)
  const k = counting()
  await c.get('a', 0, k.compute)
  await c.get('a', 60_000, k.compute)
  assert.equal(k.calls(), 2)
})
test('concurrent callers share one in-flight compute', async () => {
  const c = new TtlCache<{ n: number }>(60_000)
  const k = counting()
  const [a, b] = await Promise.all([c.get('a', 0, k.compute), c.get('a', 0, k.compute)])
  assert.equal(k.calls(), 1)
  assert.equal(a, b)
})
test('a failed compute is not cached', async () => {
  const c = new TtlCache<{ n: number }>(60_000)
  const k = counting()
  await assert.rejects(c.get('a', 0, async () => { throw new Error('boom') }), /boom/)
  await c.get('a', 1, k.compute)
  assert.equal(k.calls(), 1)
  assert.equal(c.size(), 1)
  await c.get('a', 2, k.compute)
  assert.equal(k.calls(), 1)
})
test('a new key recomputes', async () => {
  const c = new TtlCache<{ n: number }>(60_000)
  const k = counting()
  await c.get('ravi|TCS|v1', 0, k.compute)
  await c.get('ravi|TCS|v2', 1, k.compute)
  assert.equal(k.calls(), 2)
})
test('an expired entry is dropped on the next read, whatever its key (R3 final fix M1)', async () => {
  const c = new TtlCache<{ n: number }>(60_000)
  const k = counting()
  await c.get('NIFTY|full', 0, k.compute)
  await c.get('ravi|TCS|v1', 30_000, k.compute)
  assert.equal(c.size(), 2)
  await c.get('ravi|TCS|v2', 60_000, k.compute)
  assert.equal(c.size(), 2)   // the 60 s old Market Watch view is gone, the 30 s old reading stays
  await c.get('ravi|TCS|v2', 90_000, k.compute)
  assert.equal(c.size(), 1)   // and so is v1 once it is a minute old, on a read of another key
  assert.equal(k.calls(), 3)
})
test('past maxEntries the oldest goes first', async () => {
  const c = new TtlCache<{ n: number }>(60_000, { maxEntries: 2 })
  const k = counting()
  await c.get('a', 0, k.compute)
  await c.get('b', 0, k.compute)
  await c.get('c', 0, k.compute)
  assert.equal(c.size(), 2)
  await c.get('a', 2, k.compute)
  assert.equal(k.calls(), 4)
})

const leg = (instrument: LegView['instrument'], expiry: string): LegView => ({
  key: `${instrument}-${expiry}`, source: 'manual', clientCode: '', note: '', lotSize: 175,
  instrument, expiry, strike: instrument === 'option' ? 3400 : null, optType: instrument === 'option' ? 'CE' : null,
  qty: -175, avgPrice: 10, ltp: 10, iv: 0.3, delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0, matched: true,
})
const viewOf = (legs: LegView[]): BookView => ({
  stock: 'TCS', asOf: 0, closed: false, spot: 3400, futures: {}, forwards: {}, legs,
  totals: { delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0 }, payoff: null, unmatched: [], mismatch: null, historyFrom: null, warnings: [],
})

test('near expiry is the earliest held option expiry on or after today', () => {
  const view = viewOf([leg('option', '2026-10-16'), leg('option', NOV), leg('future', OCT)])
  assert.equal(nearExpiryOf(view, '2026-10-19'), NOV)
  assert.equal(nearExpiryOf(viewOf([leg('share', '')]), '2026-10-19'), null)
})
test("today's expiry is live until the 15:40 F&O close, then the next day's on are (R3 final fix M3, G6)", () => {
  const at = (hm: string) => Date.parse(`2026-10-27T${hm}:00+05:30`)
  assert.deepEqual([at('00:00'), at('09:15'), at('15:30'), at('15:39')].map(liveExpiryFrom), [OCT, OCT, OCT, OCT])
  assert.deepEqual([at('15:40'), at('18:00'), at('23:59')].map(liveExpiryFrom), ['2026-10-28', '2026-10-28', '2026-10-28'])
  assert.equal(liveExpiryFrom(Date.parse('2026-12-31T16:00:00+05:30')), '2027-01-01')
  const view = viewOf([leg('option', OCT), leg('option', NOV)])
  assert.deepEqual([nearExpiryOf(view, liveExpiryFrom(at('15:39'))), nearExpiryOf(view, liveExpiryFrom(at('15:40')))], [OCT, NOV])
})
test('the fixture lists what the tasks rely on', () => {
  const m = r3Master()
  assert.deepEqual(m.options.expiries('NIFTY'), [NIFTY_W1, NIFTY_W2, NIFTY_W3])
  assert.equal(m.options.future('NIFTY', NIFTY_W1), null)
  assert.equal(m.options.chain('SENSEX', SENSEX_W1)!.exchange, 'BFO')
  assert.equal(m.options.strikes('NIFTY', NIFTY_W1).length, 201)
})
test('the fixture lists TCS and M&M as briefed', () => {
  const m = r3Master()
  for (const e of [OCT, NOV, DEC]) assert.equal(m.options.strikes('TCS', e).length, 5)
  assert.equal(m.options.strikes('M&M', OCT).length, 5)
  assert.equal(m.options.chain('TCS', OCT)!.lotSize, 175)
  assert.equal(m.options.future('TCS', NOV)!.lotSize, 175)
  assert.equal(m.options.future('M&M', OCT)!.lotSize, 700)
  assert.equal(m.options.future('NIFTY', NIFTY_W2)!.lotSize, 75)
  assert.equal(m.options.future('SENSEX', SENSEX_W1), null)
  assert.equal(m.cash.get('TCS')!.exchange, 'NSE')
  assert.ok(m.cash.has('M&M'))
})
test('future symbols are distinct and each resolves to its own contract', () => {
  const m = r3Master()
  const syms = [OCT, NOV, DEC].map((e) => m.options.future('TCS', e)!.tradingsymbol)
  assert.equal(new Set(syms).size, 3)
  for (const e of [OCT, NOV, DEC]) {
    const f = m.options.future('TCS', e)!
    assert.equal(m.options.resolveSymbol(f.tradingsymbol)?.instrumentToken, f.instrumentToken)
  }
  const ce = m.options.resolve('TCS', NOV, 3400, 'CE')!
  assert.equal(m.options.expiryOf(ce.tradingsymbol), NOV)
})
