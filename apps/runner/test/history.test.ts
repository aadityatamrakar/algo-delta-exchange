/**
 * The `HistoryFetcher` the runner did not have.
 *
 * `RunnerMarketData.seed()` returns immediately when no fetcher is injected,
 * and `main.ts` injected none — so every candle series started COLD and filled
 * only from live ticks. A strategy needing 15 completed hourly bars had them at
 * 09:15 plus fifteen hours, i.e. never: `ATR_BAND_NIFTY` logged "not enough
 * hourly candles, retrying in 30s" until 15:30 and traded nothing, every day.
 *
 * The last test here is the one that matters — it runs the REAL
 * `RunnerMarketData` and asserts that after `declare` + `seed` the candles a
 * strategy would pull are actually there. It fails outright if the fetcher is
 * not wired in.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { makeLogger, type CapturedLog } from '@algomaker/strategy-kit'
import { HttpHistoryFetcher } from '../src/history.ts'
import { RunnerMarketData } from '../src/market-data.ts'

const NOW = Date.UTC(2026, 6, 24, 4, 0) // Fri 09:30 IST
const NIFTY_SPOT = 256_265

function bars(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: NOW - (count - i) * 3_600_000,
    open: 24_000 + i,
    high: 24_010 + i,
    low: 23_990 + i,
    close: 24_005 + i,
    volume: 1_000,
  }))
}

function fakeFetch(
  reply: () => { status?: number; body: unknown },
  seen: string[] = [],
): typeof globalThis.fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(`${url}|${init?.headers?.['authorization'] ?? ''}`)
    const r = reply()
    const text = JSON.stringify(r.body)
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => text }
  }) as unknown as typeof globalThis.fetch
}

function master(): OptionMaster {
  const rows: InstrumentRow[] = [
    {
      instrument_token: NIFTY_SPOT,
      tradingsymbol: 'NIFTY 50',
      name: 'NIFTY 50',
      expiry: '',
      strike: 0,
      tick_size: 0.05,
      lot_size: 0,
      instrument_type: 'EQ',
      segment: 'INDICES',
      exchange: 'NSE',
    },
  ]
  return new OptionMaster(rows)
}

test('the request names the token, interval and count, and carries the bearer', async () => {
  const seen: string[] = []
  const f = new HttpHistoryFetcher({
    baseUrl: 'http://md:8892',
    token: 'tok',
    log: makeLogger(),
    fetch: fakeFetch(() => ({ body: { candles: bars(2) } }), seen),
  })
  await f.bars(NIFTY_SPOT, '60minute', 15)
  assert.equal(
    seen[0],
    `http://md:8892/v1/md/history?token=${NIFTY_SPOT}&interval=60minute&count=15|Bearer tok`,
  )
})

test('an unusable bar is dropped and SAID SO — a NaN close poisons every indicator', async () => {
  // One NaN in a series makes the ATR built on it NaN, which downstream reads
  // as "the strategy declined to trade" rather than as a data fault. Dropping
  // the row loses one bar; keeping it loses the day, silently.
  const logs: CapturedLog[] = []
  const f = new HttpHistoryFetcher({
    baseUrl: 'http://md:8892',
    token: 'tok',
    log: makeLogger(logs),
    fetch: fakeFetch(() => ({
      body: { candles: [...bars(2), { ts: NOW, open: 1, high: 2, low: null, close: 3 }] },
    })),
  })
  const out = await f.bars(NIFTY_SPOT, '60minute', 15)
  assert.equal(out.length, 2)
  assert.ok(logs.some((l) => l.msg.includes('dropped unusable bars')))
})

test('an HTTP failure THROWS rather than returning an empty series', async () => {
  // `seed()` catches per series and logs which one failed. Returning `[]` here
  // would make "history is unavailable" and "this instrument has no history"
  // indistinguishable, and only the first is worth an alert.
  const f = new HttpHistoryFetcher({
    baseUrl: 'http://md:8892',
    token: 'tok',
    log: makeLogger(),
    fetch: fakeFetch(() => ({ status: 502, body: { error: 'kite: too many requests' } })),
  })
  await assert.rejects(() => f.bars(1, '60minute', 15), /502/)
})

test('a response with no candles array throws rather than seeding nothing quietly', async () => {
  const f = new HttpHistoryFetcher({
    baseUrl: 'http://md:8892',
    token: 'tok',
    log: makeLogger(),
    fetch: fakeFetch(() => ({ body: { error: 'nope' } })),
  })
  await assert.rejects(() => f.bars(1, '60minute', 15), /no candles array/)
})

// ------------------------------------------------------- the wiring that matters

test('a declared series is WARM after seed — cold is what stopped ATR trading', async () => {
  /**
   * The end-to-end claim, through the real `RunnerMarketData`: declare an
   * index, seed what became live, and the hourly bars a strategy would pull are
   * already there. Remove the `history` dependency and this returns `[]`,
   * which is exactly the production behaviour being fixed.
   */
  const md = new RunnerMarketData({
    master: () => master(),
    clock: fixedClock(NOW),
    log: makeLogger(),
    history: new HttpHistoryFetcher({
      baseUrl: 'http://md:8892',
      token: 'tok',
      log: makeLogger(),
      fetch: fakeFetch(() => ({ body: { candles: bars(20) } })),
    }),
  })

  const declared = md.declare('ATR_BAND_NIFTY', [{ kind: 'index', underlying: 'NIFTY' }])
  assert.ok(declared.newSeries.length > 0, 'declaring must activate the series to seed')
  await md.seed(declared.newSeries, 20)

  const hourly = await md.candles(NIFTY_SPOT, '60minute', 15)
  assert.ok(hourly.length >= 15, `expected at least 15 seeded hourly bars, got ${hourly.length}`)
  assert.ok(hourly.every((c) => Number.isFinite(c.close)))
})

test('with NO fetcher the same series is empty — the defect, pinned', async () => {
  // The control. Without it the test above could pass for a market data object
  // that was warm for some unrelated reason.
  const md = new RunnerMarketData({
    master: () => master(),
    clock: fixedClock(NOW),
    log: makeLogger(),
  })
  const declared = md.declare('ATR_BAND_NIFTY', [{ kind: 'index', underlying: 'NIFTY' }])
  await md.seed(declared.newSeries, 20)
  assert.deepEqual(await md.candles(NIFTY_SPOT, '60minute', 15), [])
})

test('one instrument failing to seed does not abort the batch', async () => {
  // Fail-soft per series: the others are what the rest of the strategies are
  // waiting on.
  let call = 0
  const md = new RunnerMarketData({
    master: () => master(),
    clock: fixedClock(NOW),
    log: makeLogger(),
    history: {
      bars: async () => {
        call++
        if (call === 1) throw new Error('kite timeout')
        return bars(20).map((b) => ({
          ts: b['ts'] as number,
          open: b['open'] as number,
          high: b['high'] as number,
          low: b['low'] as number,
          close: b['close'] as number,
        }))
      },
    },
  })
  const declared = md.declare('ATR_BAND_NIFTY', [{ kind: 'index', underlying: 'NIFTY' }])
  await md.seed(declared.newSeries, 20)
  // Two series per token (5minute and 60minute); the first threw, the second
  // still landed.
  assert.equal(call, 2)
  assert.ok((await md.candles(NIFTY_SPOT, '60minute', 5)).length > 0)
})
