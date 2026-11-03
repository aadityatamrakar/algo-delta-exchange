/** GET /v1/traders/risk: a trader's own books under shocks; an admin names one with ?as=, or sees every stock's legs repriced together (R15). */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import type { MarketContext } from '../src/analytics/context-wire.ts'
import { HistoryStore, type HistoryBar } from '../src/market/history.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { NIFTY_W2, OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { NO_NSE_DIR, startTraders, type TradersHarness } from './harness.ts'

const M = r3Master()
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)   // the harness clock: Monday 09:30 IST, in session
const quotes = fakeQuotes()
quotes.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: T0 })
quotes.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: T0 })
priceChain(quotes, M, 'TCS', OCT, 3400, 0.25, T0)
quotes.set(spotTokenOf(M, 'NIFTY') as number, { price: 25000, asOf: T0 })
quotes.set(M.options.future('NIFTY', NIFTY_W2)?.instrumentToken as number, { price: 25010, bid: 25009, ask: 25011, asOf: T0 })
priceChain(quotes, M, 'NIFTY', NIFTY_W2, 25010, 0.15, T0)

/** 150 daily closes up to 16 Oct: NIFTY's deterministic returns, TCS 0.8 × them plus its own. */
function bars(stock: string, n: number): HistoryBar[] {
  if (stock !== 'NIFTY' && stock !== 'TCS') return []
  const out: HistoryBar[] = []
  let c = stock === 'NIFTY' ? 24000 : 3300
  for (let k = 0; k < 150; k++) {
    const r = Math.sin(k * 1.7) * 0.01
    if (k > 0) c *= Math.exp(stock === 'NIFTY' ? r : 0.8 * r + Math.cos(k * 2.3) * 0.004)
    const date = new Date(Date.UTC(2026, 9, 16) - (149 - k) * 86_400_000).toISOString().slice(0, 10)
    out.push({ date, open: c, high: c, low: c, close: c, volume: 0, futClose: null, futOi: null, ceOi: null, peOi: null, atmIv: null, maxPain: null } as HistoryBar)
  }
  return out.slice(-n)
}
class FakeHistory extends HistoryStore {
  override bars(stock: string, n: number): readonly HistoryBar[] { return bars(stock, n) }
}
const context = async (stock: string): Promise<MarketContext | null> =>
  ({ stock, vol: { hv20: stock === 'NIFTY' ? 0.14 : 0.22, atmIv: 0.25, nearIv: 0.25 } }) as unknown as MarketContext

const h: TradersHarness | null = await startTraders({
  suite: 'risk_route', master: M, quotes, deps: { history: new FakeHistory({ dir: NO_NSE_DIR }), marketContext: context },
})
after(async () => { await h?.close() })

type Who = (path: string, init?: RequestInit) => Promise<Response>
let ravi: Who
let sita: Who
let boss: Who
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })
const addLeg = async (who: Who, stock: string, leg: Record<string, unknown>): Promise<void> => {
  const r = await who(`/v1/traders/books/${stock}/legs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(leg) })
  assert.equal(r.status, 201, await r.text())
}
const near = (a: number | null, b: number | null, eps = 1e-6): void =>
  assert.ok(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps, `${a} vs ${b}`)

before(async () => {
  if (h === null) return
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
  ravi = h.as('ravi'); sita = h.as('sita'); boss = h.as('boss')
  await addLeg(ravi, 'TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: -1750, avgPrice: 120 })
  await addLeg(ravi, 'TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'PE', qty: -1750, avgPrice: 110 })
  await addLeg(ravi, 'NIFTY', { instrument: 'option', expiry: NIFTY_W2, strike: 25000, optType: 'PE', qty: -75, avgPrice: 150 })
  await addLeg(sita, 'TCS', { instrument: 'option', expiry: OCT, strike: 3400, optType: 'CE', qty: 175, avgPrice: 60 })
})

test('a trader gets their own books: beta, deltas, the grid, the replay, the headline; ?as= is ignored', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await json(await ravi('/v1/traders/risk?as=sita'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const v = r.body
  assert.deepEqual([v.trader, v.asOf, v.books.map((b: any) => b.stock)], ['ravi', h.clock.now, ['NIFTY', 'TCS']])
  assert.deepEqual(v.nifty, { spot: 25000, lotSize: 75 })
  const [nifty, tcs] = v.books
  assert.equal(nifty.beta, 1)
  assert.ok(tcs.beta > 0.5 && tcs.beta < 1.1, String(tcs.beta))
  assert.equal(tcs.betaDays, 149)
  // the delta is the book view's, in shares, and in rupees at the snapshot's spot
  const view = (await json(await ravi('/v1/traders/books/TCS'))).body
  assert.equal(tcs.deltaShares, view.totals.delta)
  near(tcs.deltaRupees, view.totals.delta * 3395)
  near(tcs.betaDeltaRupees, tcs.deltaRupees * tcs.beta)
  near(tcs.daySigma, 0.22 / Math.sqrt(252), 1e-12)
  // a short straddle loses on a 2σ day; the shares of the 2σ loss add to 100
  assert.ok(tcs.twoSigmaLoss < 0 && nifty.twoSigmaLoss <= 0)
  near(tcs.sharePct + nifty.sharePct, 100)
  // the grid: short premium loses at −10% and at vol +10, gains at 0 / vol −5
  const g = v.grid
  const cell = (m: number, vol: number): number => g.cells[g.moves.indexOf(m)][g.vols.indexOf(vol)]
  assert.equal(cell(0, 0), 0)
  assert.ok(cell(-10, 0) < 0 && cell(0, 10) < 0 && cell(0, -5) > 0)
  assert.deepEqual(g.excluded, [])
  near(v.totals.niftyUp1, nifty.niftyUp1 + tcs.niftyUp1)
  assert.equal(v.replay.days, 149)
  assert.ok(v.replay.var99 <= v.replay.var95 && v.replay.es99 <= v.replay.var99)
  assert.equal(v.replay.worstDays.length, 3)
  assert.deepEqual(v.correlation.stocks, ['NIFTY', 'TCS'])
  assert.ok(v.correlation.matrix[0][1] > 0.6)
  assert.deepEqual(v.clusters.map((c: any) => c.stocks), [['NIFTY', 'TCS']])
  assert.match(v.headline, /^NIFTY [−+]\d+% with vol [−+]\d+: −₹[\d,]+, most from (TCS|NIFTY)$/)
  assert.equal(JSON.stringify(v).includes('sita'), false)
})

test('the view is kept 60 s: a new leg shows after the minute, not before', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const first = (await json(await sita('/v1/traders/risk'))).body
  assert.deepEqual(first.books.map((b: any) => b.stock), ['TCS'])
  await addLeg(sita, 'NIFTY', { instrument: 'option', expiry: NIFTY_W2, strike: 25000, optType: 'CE', qty: 75, avgPrice: 200 })
  const t0 = h.clock.now
  try {
    h.clock.now = t0 + 30_000
    const cached = (await json(await sita('/v1/traders/risk'))).body
    assert.deepEqual([cached.asOf, cached.books.map((b: any) => b.stock)], [first.asOf, ['TCS']])
    h.clock.now = t0 + 61_000
    const fresh = (await json(await sita('/v1/traders/risk'))).body
    assert.deepEqual([fresh.asOf, fresh.books.map((b: any) => b.stock)], [t0 + 61_000, ['NIFTY', 'TCS']])
  } finally {
    h.clock.now = t0
    const legs = (await json(await sita('/v1/traders/books/NIFTY'))).body.legs as { key: string }[]
    for (const l of legs) assert.equal((await sita(`/v1/traders/legs/${encodeURIComponent(l.key)}`, { method: 'DELETE' })).status, 200)
  }
})

test('an admin without ?as= gets each stock with every trader\'s legs repriced as one book; with ?as= that trader\'s', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  h.clock.now += 200_000   // past the minute the other tests kept
  try {
    const all = (await json(await boss('/v1/traders/risk'))).body
    const r = (await json(await ravi('/v1/traders/risk'))).body
    const s = (await json(await sita('/v1/traders/risk'))).body
    assert.deepEqual([all.trader, all.books.map((b: any) => b.stock)], [null, ['NIFTY', 'TCS']])
    const tcs = all.books[1]
    // one reprice of the combined legs is the sum of the two books' (every leg on the same market)
    near(tcs.niftyUp1, r.books[1].niftyUp1 + s.books[0].niftyUp1)
    near(tcs.deltaShares, r.books[1].deltaShares + s.books[0].deltaShares)
    const g = (v: any, m: number, vol: number): number => v.grid.cells[v.grid.moves.indexOf(m)][v.grid.vols.indexOf(vol)]
    near(g(all, -5, 5), g(r, -5, 5) + g(s, -5, 5), 1e-4)
    assert.equal(JSON.stringify(all).includes('sita') || JSON.stringify(all).includes('ravi'), false)
    const one = (await json(await boss('/v1/traders/risk?as=sita'))).body
    assert.deepEqual([one.trader, one.books.map((b: any) => b.stock)], ['sita', ['TCS']])
    assert.equal((await boss('/v1/traders/risk?as=nobody')).status, 404)
  } finally { h.clock.now -= 200_000 }
})

test('a watcher token and no session are refused', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const tok = await h.token('ravi')
  assert.equal((await fetch(`${h.url}/v1/traders/risk`, { headers: { authorization: `Bearer ${tok}` } })).status, 403)
  assert.equal((await fetch(`${h.url}/v1/traders/risk`)).status, 401)
})
