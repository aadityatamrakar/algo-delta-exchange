import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INDEX_SPOT_TOKENS } from '@algomaker/instruments'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { MAX_BARS } from '../src/routes/market-context.ts'
import { OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { startTraders, type TradersHarness } from './harness.ts'

/** Monday 19 Oct 2026, 10:30 IST: in session. */
const AS_OF = Date.parse('2026-10-19T10:30:00+05:30')
const clock = { now: AS_OF }
const M = r3Master()
const TCS_FUT = M.options.future('TCS', OCT)?.instrumentToken as number

const q = fakeQuotes()
q.set(spotTokenOf(M, 'TCS') as number, { price: 3400, asOf: AS_OF, volume: 5000 })
q.set(TCS_FUT, { price: 3412.5, asOf: AS_OF })
priceChain(q, M, 'TCS', OCT, 3412.5, 0.3, AS_OF)
q.set(INDEX_SPOT_TOKENS['NIFTY'] as number, { price: 25010, asOf: AS_OF })
q.set(1010, { price: 25060, asOf: AS_OF })

// three days of end-of-day summaries, as span_job writes them
const nse = mkdtempSync(join(tmpdir(), 'traders-mkt-route-'))
mkdirSync(join(nse, 'history'))
const DAYS = [['2026-10-14', 3350], ['2026-10-15', 3370], ['2026-10-16', 3390]] as const
for (const [date, c] of DAYS) {
  writeFileSync(join(nse, 'history', `${date}.json`), JSON.stringify({
    date, symbols: {
      TCS: {
        o: c - 5, h: c + 10, l: c - 15, c, v: 1000,
        fut: { expiry: OCT, c: c + 4, oi: 9000 },
        opt: { expiry: OCT, ceOi: 500, peOi: 400, atm: { strike: 3400, ce: 40, pe: 45 }, walls: { ce: [[3500, 300]], pe: [[3300, 250]] }, maxPain: 3350 },
      },
      NIFTY: { o: 24990, h: 25100, l: 24900, c: 25000, v: 75, src: 'fut', fut: { expiry: '2026-10-27', c: 25000, oi: 10 }, opt: null },
    },
  }))
}

const h: TradersHarness | null = await startTraders({ suite: 'market-context', master: M, quotes: q, now: () => clock.now, nseDir: nse })
after(async () => { await h?.close(); rmSync(nse, { recursive: true, force: true }) })

let ravi: (path: string, init?: RequestInit) => Promise<Response>
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await ravi(path)
  return { status: r.status, body: await r.json() }
}

before(async () => {
  if (h === null) return
  await h.addUser('ravi')
  ravi = h.as('ravi')
  await h.deps.history.refresh()
  h.deps.intraday.sample(AS_OF + 500)
})

test('GET /market/TCS/context: the context the assistant reads, from the history and the live quotes', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await get('/v1/traders/market/TCS/context')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const c = r.body
  assert.deepEqual([c.stock, c.reference, c.spot, c.future, c.prevClose, c.closed, c.feedAlive, c.stale], ['TCS', 'spot', 3400, 3412.5, 3390, false, true, false])
  assert.equal(c.vol.atmIv, 0.3)
  assert.deepEqual(c.bars, { daily: 3, intraday: 1 })
  assert.deepEqual(c.oi, { expiry: OCT, pcr: 0.8, maxPain: 3350, callWall: 3500, putWall: 3300, day: '2026-10-16' })
  assert.ok(c.levels.length > 0 && c.levels.some((l: { kind: string }) => l.kind === 'pivot'))
  // 14 Oct's ATM put (45) is under its intrinsic value off that day's 3354 future (46): no IV that day, never a guess
  assert.ok(c.warnings.includes('IV rank and percentile need 60 days of IV history; 2 exist'), c.warnings.join('\n'))
  // the route serves exactly what deps.marketContext gives the assistant
  assert.deepEqual(JSON.parse(JSON.stringify(await h.deps.marketContext('TCS', clock.now))), c)
  assert.equal((await get('/v1/traders/market/tcs/context')).body.stock, 'TCS')
})

test('GET /market/NIFTY/context: an index is measured on its near future', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await get('/v1/traders/market/NIFTY/context')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.reference, r.body.spot, r.body.future, r.body.prevClose], ['future', 25010, 25060, 25000])
})

test('an unknown underlying → 404; a bad name → 400; no session → 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.deepEqual(await get('/v1/traders/market/INFY/context'), { status: 404, body: { error: 'no such underlying in the instrument master: INFY' } })
  assert.deepEqual(await get('/v1/traders/market/INFY/bars'), { status: 404, body: { error: 'no such underlying in the instrument master: INFY' } })
  assert.equal((await get('/v1/traders/market/TCS;DROP/context')).status, 400)
  assert.equal((await get('/v1/traders/market/TCS;DROP/bars')).status, 400)
  assert.equal((await fetch(`${h.url}/v1/traders/market/TCS/context`)).status, 401)
  assert.equal((await fetch(`${h.url}/v1/traders/market/TCS/bars`)).status, 401)
})

test('GET /market/TCS/bars?interval=day: the summaries, oldest first, at most n', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await get('/v1/traders/market/TCS/bars')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body, {
    stock: 'TCS', interval: 'day', of: 'spot', warnings: [],
    bars: DAYS.map(([date, c]) => ({ t: Date.parse(`${date}T09:15:00+05:30`), o: c - 5, h: c + 10, l: c - 15, c, v: 1000 })),
  })
  assert.deepEqual((await get('/v1/traders/market/TCS/bars?interval=day&n=2')).body.bars.map((b: { c: number }) => b.c), [3370, 3390])
  const nifty = await get('/v1/traders/market/NIFTY/bars?interval=day')
  assert.deepEqual([nifty.body.of, nifty.body.warnings], ['future', ["NSE's end-of-day files carry no OHLC for NIFTY: these are its near future's bars"]])
  const none = await get('/v1/traders/market/M%26M/bars?interval=day')
  assert.deepEqual([none.status, none.body.bars, none.body.warnings], [200, [], ['no daily history for M&M yet (no end-of-day summary lists it)']])
})

test('GET /market/TCS/bars?interval=5m|15m: today\'s sampled bars, spot or future', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const bar = (c: number, v: number) => ({ t: Date.parse('2026-10-19T10:30:00+05:30'), o: c, h: c, l: c, c, v })
  for (const interval of ['5m', '15m']) {
    const spot = await get(`/v1/traders/market/TCS/bars?interval=${interval}`)
    assert.equal(spot.status, 200, JSON.stringify(spot.body))
    assert.deepEqual([spot.body.of, spot.body.bars], ['spot', [bar(3400, 0)]])
    const fut = await get(`/v1/traders/market/TCS/bars?interval=${interval}&of=future`)
    assert.deepEqual([fut.body.of, fut.body.bars], ['future', [bar(3412.5, 0)]])
  }
  // an index defaults to its future, as the context measures it
  const nifty = await get('/v1/traders/market/NIFTY/bars?interval=5m')
  assert.deepEqual([nifty.body.of, nifty.body.bars], ['future', [bar(25060, 0)]])
  const quiet = await get('/v1/traders/market/M%26M/bars?interval=5m')
  assert.deepEqual([quiet.body.bars, quiet.body.warnings], [[], ["no ticks of M&M's spot sampled today (19 Oct)"]])
})

test('bars refuses a bad interval, n or of', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const qs of ['interval=1h', 'n=0', `n=${MAX_BARS + 1}`, 'n=2.5', 'n=abc', 'of=index', 'interval=5m&of=x']) {
    const r = await get(`/v1/traders/market/TCS/bars?${qs}`)
    assert.equal(r.status, 400, `${qs}: ${JSON.stringify(r.body)}`)
  }
  assert.equal((await get(`/v1/traders/market/TCS/bars?n=${MAX_BARS}`)).status, 200)
})
