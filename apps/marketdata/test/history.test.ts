/**
 * The history endpoint — what makes a hosted strategy's candle series start
 * WARM.
 *
 * Without it `RunnerMarketData.seed()` is a no-op and every series fills only
 * from live ticks, so `ATR_BAND_NIFTY` (which needs `atrPeriod` COMPLETED
 * hourly bars) spends the whole session logging "not enough hourly candles,
 * retrying in 30s". Not a crash and not an error — a strategy that is up,
 * green, and structurally unable to trade.
 *
 * What is tested here is the WIRING and the refusals: the window arithmetic
 * (get it wrong and you return fewer bars than asked for, which reads
 * downstream as "no data yet"), the timestamp parsing (get it wrong and every
 * bar lands at epoch 0), and the fact that a request without the bearer is
 * refused.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeHistoryError,
  fetchHistory,
  handleHistoryRequest,
  historyWindow,
  isHistoryTokenRejection,
  parseBarTs,
  parseHistoryQuery,
  toCandles,
  type HistorySource,
} from '../src/history.ts'

const NOW = Date.UTC(2026, 6, 24, 4, 0) // Fri 2026-07-24 09:30 IST

function bar(ts: string, close: number): Record<string, unknown> {
  return { ts, open: close - 1, high: close + 2, low: close - 3, close, vol: 100 }
}

// ------------------------------------------------------------------- parsing

test('a Kite timestamp with a colon-less offset still parses', () => {
  // `2026-07-24T09:15:00+0530` is outside the ISO form `Date.parse` is REQUIRED
  // to accept. Returning NaN here would seed the store with bars at epoch 0 and
  // every indicator on them would be silently wrong rather than absent.
  const ms = parseBarTs('2026-07-24T09:15:00+0530')
  assert.equal(ms, Date.UTC(2026, 6, 24, 3, 45))
  assert.equal(parseBarTs('2026-07-24T09:15:00+05:30'), Date.UTC(2026, 6, 24, 3, 45))
  assert.equal(parseBarTs('not a date'), null)
  assert.equal(parseBarTs(undefined), null)
})

test('a bar missing an OHLC value is DROPPED, never defaulted to zero', () => {
  // A zero low turns an ATR into a band several thousand points wide, and a
  // breakout check on it fires on the first tick of the day.
  const candles = toCandles([
    bar('2026-07-24T09:15:00+0530', 100),
    { ts: '2026-07-24T10:15:00+0530', open: 1, high: 2, close: 3 }, // no low
    { ts: 'rubbish', open: 1, high: 2, low: 0.5, close: 3 },
    bar('2026-07-24T11:15:00+0530', 102),
  ])
  assert.deepEqual(candles.map((c) => c.close), [100, 102])
})

test('candles come back oldest -> newest whatever order the vendor sent', () => {
  const candles = toCandles([
    bar('2026-07-24T11:15:00+0530', 102),
    bar('2026-07-24T09:15:00+0530', 100),
  ])
  assert.deepEqual(candles.map((c) => c.close), [100, 102])
})

test('a non-array response reads as no candles rather than throwing', () => {
  assert.deepEqual(toCandles(null), [])
  assert.deepEqual(toCandles({ error: 'nope' }), [])
})

// -------------------------------------------------------------------- window

test('the window covers weekends and holidays, not just N/bars-per-day', () => {
  /**
   * FIVE SESSIONS LIVE IN SEVEN CALENDAR DAYS. A window sized on trading days
   * alone comes up short across every weekend, and short means fewer bars than
   * the strategy asked for — which it reads as "no data yet" and retries. That
   * is the exact symptom this module exists to remove, reintroduced by
   * arithmetic.
   */
  const hourly = historyWindow('60minute', 15, NOW)
  const days = (Date.parse(`${hourly.to}T00:00:00Z`) - Date.parse(`${hourly.from}T00:00:00Z`)) / 86_400_000
  // 15 hourly bars is 3 sessions; 3 sessions spans a weekend at least once.
  assert.ok(days >= 9, `window was only ${days} days for 15 hourly bars`)
  assert.equal(hourly.to, '2026-07-24')
})

test('the window is clamped to what Kite will answer in one request', () => {
  // Kite errors rather than truncating when the span is too long, so asking for
  // 2000 one-minute bars must not produce a 20-day request it will reject.
  const minute = historyWindow('1minute', 2000, NOW)
  const days = (Date.parse(`${minute.to}T00:00:00Z`) - Date.parse(`${minute.from}T00:00:00Z`)) / 86_400_000
  assert.ok(days <= 60, `1minute window was ${days} days, past Kite's 60-day cap`)
})

test('1minute is sent to Kite as "minute" — it is the one name that differs', async () => {
  const seen: string[] = []
  const source: HistorySource = {
    historyData: async (_t, interval) => {
      seen.push(interval)
      return []
    },
  }
  await fetchHistory(source, { token: 1, interval: '1minute', count: 10 }, NOW)
  await fetchHistory(source, { token: 1, interval: '60minute', count: 10 }, NOW)
  assert.deepEqual(seen, ['minute', '60minute'])
})

test('at most `count` bars come back, newest-aligned', async () => {
  const source: HistorySource = {
    historyData: async () =>
      Array.from({ length: 40 }, (_, i) =>
        bar(new Date(NOW + i * 3_600_000).toISOString(), 100 + i),
      ),
  }
  const candles = await fetchHistory(source, { token: 1, interval: '60minute', count: 5 }, NOW)
  assert.equal(candles.length, 5)
  assert.deepEqual(candles.map((c) => c.close), [135, 136, 137, 138, 139])
})

// --------------------------------------------------------------- the request

const deps = (source: HistorySource | null): Parameters<typeof handleHistoryRequest>[0] => ({
  port: 0,
  token: 'tok',
  source: () => source,
  now: () => NOW,
})

const OK: HistorySource = {
  historyData: async () => [bar('2026-07-24T09:15:00+0530', 100)],
}

test('a valid request returns candles', async () => {
  const out = await handleHistoryRequest(deps(OK), {
    method: 'GET',
    url: '/v1/md/history?token=256265&interval=60minute&count=15',
    authorization: 'Bearer tok',
  })
  assert.equal(out.status, 200)
  assert.equal((out.body['candles'] as unknown[]).length, 1)
})

test('the bearer is REQUIRED — this process holds the only Kite session', async () => {
  // Not because bars are secret. Kite throttles the whole login, so anyone able
  // to hammer this endpoint can stop the desk fetching its own history.
  for (const authorization of [undefined, 'Bearer wrong', 'tok']) {
    const out = await handleHistoryRequest(deps(OK), {
      method: 'GET',
      url: '/v1/md/history?token=1&interval=day&count=5',
      ...(authorization === undefined ? {} : { authorization }),
    })
    assert.equal(out.status, 401, `auth '${String(authorization)}' should be refused`)
  }
})

test('a bad query is a 400 and never reaches the broker', async () => {
  let called = false
  const spy: HistorySource = {
    historyData: async () => {
      called = true
      return []
    },
  }
  const cases = [
    '/v1/md/history?token=abc&interval=day&count=5',
    '/v1/md/history?token=0&interval=day&count=5',
    '/v1/md/history?token=1&interval=hourly&count=5',
    '/v1/md/history?token=1&interval=day&count=0',
    '/v1/md/history?token=1&interval=day&count=99999',
  ]
  for (const url of cases) {
    const out = await handleHistoryRequest(deps(spy), {
      method: 'GET',
      url,
      authorization: 'Bearer tok',
    })
    assert.equal(out.status, 400, url)
  }
  // `Number('abc')` is NaN and a NaN token reaches Kite as the literal 'NaN' —
  // a broker 400 for what is really our own bad request.
  assert.equal(called, false)
})

test('a login that has not finished is a 503, not a 500', async () => {
  const out = await handleHistoryRequest(deps(null), {
    method: 'GET',
    url: '/v1/md/history?token=1&interval=day&count=5',
    authorization: 'Bearer tok',
  })
  assert.equal(out.status, 503)
})

test('an upstream Kite failure is a 502 — the caller must not read it as OUR fault', async () => {
  const broken: HistorySource = {
    historyData: async () => {
      throw new Error('kite: too many requests')
    },
  }
  const out = await handleHistoryRequest(deps(broken), {
    method: 'GET',
    url: '/v1/md/history?token=1&interval=day&count=5',
    authorization: 'Bearer tok',
  })
  assert.equal(out.status, 502)
  assert.match(String(out.body['error']), /too many requests/)
})

test('parseHistoryQuery defaults count but nothing else', () => {
  const q = parseHistoryQuery('/v1/md/history?token=5&interval=5minute')
  assert.deepEqual(q, { token: 5, interval: '5minute', count: 200 })
})

// ------------------------------------------------------- a rejected enctoken
//
// THE SECOND REST CONSUMER OF THE TOKEN. The margin path got a recovery
// trigger after the 2026-08-05 outage; this endpoint reads the same enctoken
// and had no way to report one. It matters on its own because the margin sweep
// only runs for LIVE books on a SPAN slot or a leg change — a desk holding
// nothing exercises the token nowhere else, and a strategy restarting into a
// dead token seeds no candles and trades nothing for the rest of the day.

/** How the VENDORED client rejects: the raw parsed body, not an Error. */
const TOKEN_BODY = {
  status: 'error',
  message: 'Incorrect `api_key` or `access_token`.',
  error_type: 'TokenException',
}

test('a rejected enctoken is DESCRIBED, not stringified to [object Object]', () => {
  assert.match(describeHistoryError(TOKEN_BODY), /TokenException/)
  assert.match(describeHistoryError(TOKEN_BODY), /access_token/)
  assert.equal(describeHistoryError(new Error('boom')), 'boom')
  assert.ok(isHistoryTokenRejection(TOKEN_BODY))
  assert.ok(!isHistoryTokenRejection(new Error('kite: too many requests')))
})

test('a rejected enctoken triggers a re-login and the retry answers', async () => {
  let calls = 0
  const dead: HistorySource = {
    historyData: async () => {
      calls++
      throw TOKEN_BODY
    },
  }
  let live: HistorySource = dead
  let rotations = 0
  let accepted = 0
  const out = await handleHistoryRequest(
    {
      ...deps(dead),
      // The fresh session REPLACES the source, which is why the retry re-reads
      // it rather than reusing the one that was just rejected.
      source: () => live,
      onAuthFailure: async () => {
        rotations++
        live = OK
        return true
      },
      onTokenAccepted: () => {
        accepted++
      },
    },
    { method: 'GET', url: '/v1/md/history?token=256265&interval=60minute&count=15', authorization: 'Bearer tok' },
  )
  assert.equal(rotations, 1)
  assert.equal(calls, 1, 'one rejection, one rotation, one retry — never a loop')
  assert.equal(out.status, 200)
  assert.equal(accepted, 1)
})

test('a recovery that did NOT rotate is not retried against', async () => {
  // Gated or failed recovery leaves the SAME dead token in place; retrying
  // would re-send it for an identical rejection.
  let calls = 0
  const dead: HistorySource = {
    historyData: async () => {
      calls++
      throw TOKEN_BODY
    },
  }
  const out = await handleHistoryRequest(
    { ...deps(dead), onAuthFailure: async () => false },
    { method: 'GET', url: '/v1/md/history?token=1&interval=day&count=5', authorization: 'Bearer tok' },
  )
  assert.equal(calls, 1)
  assert.equal(out.status, 502)
  assert.match(String(out.body['error']), /TokenException/)
})

test('a NON-token upstream failure burns no login', async () => {
  // A real password+TOTP login on a live trading account is not the answer to
  // Zerodha having a bad minute.
  let rotations = 0
  const broken: HistorySource = {
    historyData: async () => {
      throw new Error('kite: too many requests')
    },
  }
  const out = await handleHistoryRequest(
    {
      ...deps(broken),
      onAuthFailure: async () => {
        rotations++
        return true
      },
    },
    { method: 'GET', url: '/v1/md/history?token=1&interval=day&count=5', authorization: 'Bearer tok' },
  )
  assert.equal(rotations, 0)
  assert.equal(out.status, 502)
})
