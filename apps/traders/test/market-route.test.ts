import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { marketTokens } from '../src/analytics/market-watch.ts'
import { configFromEnv, type TradersConfig } from '../src/config.ts'
import type { TradersDb } from '../src/db.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { planTokens, startDeclaring, type Declarer } from '../src/market/subscriptions.ts'
import type { TraderLeg } from '../src/types.ts'
import { DEC, NIFTY_W1, NIFTY_W2, NIFTY_W3, NOV, OCT, SENSEX_W1, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { HARNESS_ORIGIN, NO_NSE_DIR, startTraders, type TradersHarness } from './harness.ts'

/** 2026-10-19 10:30 IST, a Monday in session. */
const AS_OF = Date.UTC(2026, 9, 19, 5, 0)
const TODAY = '2026-10-19'
const clock = { now: AS_OF }
const M = r3Master()

function market(niftySpot: number): ReturnType<typeof fakeQuotes> {
  const q = fakeQuotes()
  q.set(spotTokenOf(M, 'TCS') as number, { price: 3400, asOf: AS_OF })
  for (const [e, f] of [[OCT, 3412.5], [NOV, 3430], [DEC, 3450]] as const) {
    q.set(M.options.future('TCS', e)?.instrumentToken as number, { price: f, asOf: AS_OF })
    priceChain(q, M, 'TCS', e, f, 0.3, AS_OF)
  }
  q.set(spotTokenOf(M, 'NIFTY') as number, { price: niftySpot, asOf: AS_OF })
  priceChain(q, M, 'NIFTY', NIFTY_W1, 25040, 0.3, AS_OF)   // the other two weeklies are listed but unquoted
  return q
}
const quotes = market(25010)

/** The real declarer over a fake desk write; `counted` goes to the app and counts the route's calls to refreshNow. */
function declaring(q: ReturnType<typeof fakeQuotes>): { real: Declarer; counted: Declarer; calls: () => number } {
  const real = startDeclaring({
    db: { publishSubscription: async () => {} } as unknown as TradersDb, legs: async () => [], master: () => M,
    priceOf: (t) => q.quote(t)?.price ?? null, now: () => clock.now, log: () => {}, everyMs: 3_600_000,
  })
  let n = 0
  return { real, counted: { ...real, refreshNow: () => { n++; return real.refreshNow() } }, calls: () => n }
}
const sorted = (ts: readonly number[]): number[] => [...ts].sort((a, b) => a - b)

const decl = declaring(quotes)
const declarer = decl.real
const h: TradersHarness | null = await startTraders({ suite: 'market', master: M, quotes, now: () => clock.now, deps: { subscriptions: decl.counted } })
after(async () => { declarer.stop(); await h?.close() })

let ravi: (path: string, init?: RequestInit) => Promise<Response>
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await ravi(path)
  return { status: r.status, body: await r.json() }
}

before(async () => {
  if (h === null) return
  await h.addUser('ravi')
  ravi = h.as('ravi')
})

test('GET /v1/traders/market/TCS as a trader → 200 with three chains', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await get('/v1/traders/market/TCS')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.chains.map((c: { expiry: string }) => c.expiry), [OCT, NOV, DEC])
  assert.deepEqual([r.body.stock, r.body.spot, r.body.feedAlive, r.body.fullChains, r.body.oiDay], ['TCS', 3400, true, true, null])
  assert.deepEqual(r.body.chains.map((c: { future: { ltp: number } }) => c.future.ltp), [3412.5, 3430, 3450])
  // the app's own end-of-day reader: no file for the previous trading day in the test folder
  assert.ok(r.body.warnings.includes('NSE end-of-day file BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv for 16 Oct is missing — OI change and price change unknown'),
    r.body.warnings.join('\n'))
  assert.ok(r.body.labels.bf.includes('unconfirmed (Phase 0, Q3)'))
})

test('GET /v1/traders/market/NIFTY → three weekly chains of 81 rows', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await get('/v1/traders/market/NIFTY')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.chains.map((c: { expiry: string }) => c.expiry), [NIFTY_W1, NIFTY_W2, NIFTY_W3])
  assert.deepEqual(r.body.chains.map((c: { rows: unknown[] }) => c.rows.length), [81, 81, 81])
  assert.deepEqual([r.body.chains[0].future, r.body.chains[0].forwardSource], [null, 'parity'])
})

test('GET /v1/traders/market/M%26M → the name is M&M', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await get('/v1/traders/market/M%26M')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.stock, 'M&M')
  assert.deepEqual(r.body.chains.map((c: { expiry: string }) => c.expiry), [OCT])
  assert.equal((await get('/v1/traders/market/tcs')).body.stock, 'TCS')
})

test('an unknown name → 404 with the message; TCS;DROP → 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.deepEqual(await get('/v1/traders/market/INFY'), { status: 404, body: { error: 'no F&O contracts listed for INFY' } })
  const bad = await get('/v1/traders/market/TCS;DROP')
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
})

test('no session → 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await fetch(`${h.url}/v1/traders/market/TCS`)).status, 401)
})

test('the declaration holds the on-screen tokens after a GET and drops them 60 s after the last one', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  clock.now = AS_OF + 10 * 60_000   // every earlier poll has left the screen
  assert.deepEqual(await declarer.refreshNow(), [])
  const want = sorted(marketTokens(M, quotes, 'TCS', TODAY))

  const n0 = decl.calls()
  assert.equal((await get('/v1/traders/market/TCS')).status, 200)
  assert.equal(decl.calls(), n0 + 1, 'a new underlying is declared at once')
  assert.deepEqual(await declarer.refreshNow(), want)

  clock.now += 30_000
  assert.equal((await get('/v1/traders/market/TCS')).status, 200)
  assert.equal(decl.calls(), n0 + 1, 'an underlying already on screen waits for the next pass')
  clock.now += 59_999
  assert.deepEqual(await declarer.refreshNow(), want)
  clock.now += 2
  assert.deepEqual(await declarer.refreshNow(), [])
})

test('over the cap: first come first served; a new underlying refused, and one on screen whose new set does not fit loses its grant', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  clock.now = AS_OF
  const q = market(29990)   // NIFTY near the top of its list: a short window (41 strikes)
  q.set(spotTokenOf(M, 'SENSEX') as number, { price: 81000, asOf: AS_OF })
  priceChain(q, M, 'SENSEX', SENSEX_W1, 81050, 0.3, AS_OF)
  for (const type of ['CE', 'PE'] as const) q.set(M.options.resolve('SENSEX', SENSEX_W1, 80000, type)?.instrumentToken as number, { stale: true })
  const d = declaring(q)
  const config: TradersConfig = {
    port: 0, mongoUrl: '', busUrl: '', origins: [HARNESS_ORIGIN], sessionTtlMs: 3_600_000, maxTokens: 2000, nseDir: NO_NSE_DIR,
    marketWatchMaxTokens: 300,
  }
  const c = await startTraders({ suite: 'market_cap', master: M, quotes: q, now: () => clock.now, deps: { config, subscriptions: d.counted } })
  assert.ok(c)
  try {
    await c.addUser('ravi')
    const as = c.as('ravi')
    const view = async (stock: string) => (await as(`/v1/traders/market/${stock}`)).json() as Promise<any>
    const capped = 'Market Watch is already watching 300 contracts for other screens; this one shows only the strikes already watched for open books'
    const tcsTokens = sorted(marketTokens(M, q, 'TCS', TODAY))
    assert.deepEqual([marketTokens(M, q, 'NIFTY', TODAY).length, tcsTokens.length, marketTokens(M, q, 'SENSEX', TODAY).length], [1 + 1 + 3 * 41 * 2, 34, 1 + 21 * 2])

    const nifty = await view('NIFTY')                       // 248 of 300
    assert.deepEqual([nifty.fullChains, nifty.chains.map((x: any) => x.rows.length)], [true, [41, 41, 41]])
    const tcs = await view('TCS')                           // 282 of 300
    assert.deepEqual([tcs.fullChains, tcs.warnings.includes(capped)], [true, false])
    assert.equal(d.calls(), 2)

    // a new underlying that does not fit (43 more) is refused outright: nothing declared for it
    const sensex = await view('SENSEX')
    assert.deepEqual([sensex.fullChains, sensex.warnings.includes(capped)], [false, true])
    assert.equal(d.calls(), 2, 'a refused underlying changes nothing in the declaration')
    // only strikes another screen keeps ticking: the 80000 quotes are stale, so that strike is not one of them
    assert.deepEqual([sensex.chains[0].rows.length, sensex.chains[0].rows.some((r: any) => r.strike === 80000)], [20, false])

    // NIFTY moves to 25,010: its new window alone (488 tokens) is over the 300 cap
    clock.now += 5_000
    q.set(spotTokenOf(M, 'NIFTY') as number, { price: 25010 })
    const moved = await view('NIFTY')
    assert.equal(moved.fullChains, false)
    assert.ok(moved.warnings.includes(capped), moved.warnings.join('\n'))
    // only the strikes some other screen already has ticking: W1 is quoted, W2 and W3 are not
    assert.deepEqual(moved.chains.map((x: any) => x.rows.length), [81, 0, 0])
    // it lost its grant: the declaration no longer carries its old strikes, at once
    assert.equal(d.calls(), 3)
    assert.deepEqual(await d.real.refreshNow(), tcsTokens)
    assert.equal((await view('TCS')).fullChains, true)
    // the room it left is the next comer's
    assert.equal((await view('SENSEX')).fullChains, true)
  } finally {
    d.real.stop()
    await c.close()
  }
})

test('Market Watch yields to the books: a grant needs room beside their full windows under TRADERS_MAX_TOKENS, and never narrows one (Ruling R3-18)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  clock.now = AS_OF
  // one NIFTY weekly leg at 25,010: spot, the W2 future and ATM ± 15 = 64 tokens. TCS's screen wants 34 more.
  const niftyLeg: TraderLeg = {
    trader: 'ravi', stock: 'NIFTY', instrument: 'option', expiry: NIFTY_W2, strike: 25000, optType: 'CE', qty: -75, avgPrice: 100,
    clientCode: 'C1', source: 'odin', key: 'nifty-w2', token: M.options.resolve('NIFTY', NIFTY_W2, 25000, 'CE')?.instrumentToken ?? null, note: '', updatedAt: 0,
  }
  let legs: TraderLeg[] = []
  const d = startDeclaring({
    db: { publishSubscription: async () => {} } as unknown as TradersDb, legs: async () => legs, master: () => M,
    priceOf: (tk) => quotes.quote(tk)?.price ?? null, now: () => clock.now, log: () => {}, everyMs: 3_600_000, maxTokens: 90,
  })
  const config: TradersConfig = {
    port: 0, mongoUrl: '', busUrl: '', origins: [HARNESS_ORIGIN], sessionTtlMs: 3_600_000, maxTokens: 90, nseDir: NO_NSE_DIR,
    marketWatchMaxTokens: 90,
  }
  const c = await startTraders({ suite: 'market_room', master: M, quotes, now: () => clock.now, deps: { config, subscriptions: d } })
  assert.ok(c)
  try {
    await c.addUser('ravi')
    const view = async (stock: string) => (await c.as('ravi')(`/v1/traders/market/${stock}`)).json() as Promise<any>
    const capped = 'Market Watch is already watching 90 contracts for other screens; this one shows only the strikes already watched for open books'
    const tcsTokens = marketTokens(M, quotes, 'TCS', TODAY)
    assert.equal(tcsTokens.length, 34)

    // no book yet: TCS fits
    await d.refreshNow()
    assert.equal((await view('TCS')).fullChains, true)
    assert.deepEqual(await d.refreshNow(), sorted(tcsTokens))

    // a NIFTY book comes: 64 + 34 is over 90, so TCS's tokens go, and the book keeps its full window
    legs = [niftyLeg]
    const books = sorted(planTokens(legs, M, (tk) => quotes.quote(tk)?.price ?? null, TODAY, { cap: Infinity }).tokens)
    assert.equal(books.length, 64)
    assert.deepEqual(await d.refreshNow(), books)
    assert.deepEqual([d.last().count, d.last().capHit, [...d.last().trimmed], d.last().bookDemand], [64, false, [], 64])
    // and the screen is told at its next poll: only 26 are left beside the book
    const after = await view('TCS')
    assert.deepEqual([after.fullChains, after.warnings.includes(capped)], [false, true])
    assert.deepEqual(await d.refreshNow(), books)
    assert.deepEqual([...d.last().trimmed], [])
  } finally {
    d.stop()
    await c.close()
  }
})

test('TRADERS_MARKET_WATCH_MAX_TOKENS: 1000 unless set; a bad value refuses to start', () => {
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm' }).marketWatchMaxTokens, 1000)
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MARKET_WATCH_MAX_TOKENS: ' 1500 ' }).marketWatchMaxTokens, 1500)
  for (const bad of ['abc', 'NaN', '0', '-1', '1.5']) {
    assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MARKET_WATCH_MAX_TOKENS: bad }), /TRADERS_MARKET_WATCH_MAX_TOKENS is not a positive whole number/, bad)
  }
})

test('TRADERS_MARKET_WATCH_MAX_TOKENS over TRADERS_MAX_TOKENS refuses to start; unset, it is at most TRADERS_MAX_TOKENS (Ruling R3-18)', () => {
  assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MARKET_WATCH_MAX_TOKENS: '2001' }),
    /^Error: TRADERS_MARKET_WATCH_MAX_TOKENS \(2001\) is over TRADERS_MAX_TOKENS \(2000\)/)
  assert.throws(() => configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MAX_TOKENS: '800', TRADERS_MARKET_WATCH_MAX_TOKENS: '1000' }),
    /TRADERS_MARKET_WATCH_MAX_TOKENS \(1000\) is over TRADERS_MAX_TOKENS \(800\)/)
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MAX_TOKENS: '800', TRADERS_MARKET_WATCH_MAX_TOKENS: '800' }).marketWatchMaxTokens, 800)
  assert.equal(configFromEnv({ TRADERS_MONGO_URL: 'm', TRADERS_MAX_TOKENS: '800' }).marketWatchMaxTokens, 800)
})
