/**
 * The `md` port's wiring.
 *
 * The pieces underneath (CandleStore, SubscriptionRegistry, selector) have
 * their own tests in `packages/marketdata-core`. What is tested here is the
 * wiring this file adds: that a strategy is routed only the tokens it declared,
 * that a chain window walks the LISTED grid, and that the two "cannot answer"
 * cases stay refusals rather than becoming plausible numbers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { makeLogger, type Quote } from '@algomaker/strategy-kit'
import { RunnerMarketData } from '../src/market-data.ts'

const NOW = Date.UTC(2026, 6, 24, 4, 0) // Fri 09:30 IST
const EXPIRY = '2026-08-27'
const SPOT_TOKEN = 260105 // BANKNIFTY, per INDEX_SPOT_TOKENS

function master(opts: { gap?: boolean } = {}): OptionMaster {
  const rows: InstrumentRow[] = [
    {
      instrument_token: SPOT_TOKEN,
      tradingsymbol: 'NIFTY BANK',
      name: 'NIFTY BANK',
      expiry: '',
      strike: 0,
      tick_size: 0.05,
      lot_size: 0,
      instrument_type: 'EQ',
      segment: 'INDICES',
      exchange: 'NSE',
    },
  ]
  for (let strike = 55_600; strike <= 56_400; strike += 100) {
    // A strike the exchange never listed. A window walking an ARITHMETIC grid
    // would fall into it and produce a symbol that does not exist.
    if (opts.gap === true && strike === 56_100) continue
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: strike + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BANKNIFTY26AUG${strike}${type}`,
        name: 'BANKNIFTY',
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: 35,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  return new OptionMaster(rows)
}

function md(m: OptionMaster = master()): { md: RunnerMarketData; clock: ReturnType<typeof fixedClock> } {
  const clock = fixedClock(NOW)
  return {
    md: new RunnerMarketData({ master: () => m, clock, log: makeLogger(), staleAfterMs: 15_000 }),
    clock,
  }
}

const tick = (token: number, price: number, ts = NOW): Quote => ({ token, lastPrice: price, ts })

test('an index need subscribes the spot token and routes it to that strategy only', () => {
  const { md: m } = md()
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  m.declare('B', [])
  assert.deepEqual(m.routesFor(SPOT_TOKEN), ['A'])
  assert.deepEqual(m.routesFor(999_999), [])
})

test('two strategies on the same underlying share ONE subscription', () => {
  const { md: m } = md()
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  m.declare('B', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  assert.deepEqual(m.subscriptionSet().map((s) => s.token), [SPOT_TOKEN])
  assert.deepEqual([...m.routesFor(SPOT_TOKEN)].sort(), ['A', 'B'])
})

test('an option-chain window is empty until spot arrives, then centres on ATM', () => {
  const { md: m } = md()
  const cold = m.declare('A', [{ kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 }])
  // No spot, so the window cannot be centred. Subscribing an arbitrary slice
  // would be worse than subscribing none.
  assert.equal(cold.tokens.length, 0)

  m.onTick(tick(SPOT_TOKEN, 56_010))
  const warm = m.declare('A', [{ kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 }])
  // ATM 56000, +/- 1 listed strike, both types = 6 contracts.
  assert.equal(warm.tokens.length, 6)
})

test('the chain window steps OVER an unlisted strike instead of fabricating it', () => {
  /**
   * ASSERTS THE TOKENS, NOT THE COUNT. This used to check
   * `declared.tokens.length === 6`, which is the SAME number the non-gap case
   * produces — the window is three listed strikes either way, it just walks a
   * different three. So the assertion could not tell "stepped over 56100" from
   * "included 56100", i.e. it could not observe the behaviour in its own title.
   *
   * The fixture encodes token = strike + 1 for CE and + 2 for PE, so naming the
   * tokens names the strikes.
   */
  const { md: m } = md(master({ gap: true }))
  m.onTick(tick(SPOT_TOKEN, 56_010))
  const declared = m.declare('A', [
    { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 },
  ])
  // ATM 56000, one LISTED strike either side: 55900 and 56200, because 56100
  // was never listed. An arithmetic grid would have produced 56100 here.
  assert.deepEqual(
    [...declared.tokens].sort((a, b) => a - b),
    [55_901, 55_902, 56_001, 56_002, 56_201, 56_202],
  )
  assert.deepEqual(m.routesFor(56_101), [], 'the phantom strike must be routed to nobody')
  assert.equal(m.option('BANKNIFTY', 56_100, 'CE'), null)
})

test('the SAME window with no gap includes the strike the gap case skipped', () => {
  // The control. Without it, the assertion above could be satisfied by a window
  // that is simply narrower than it claims.
  const { md: m } = md()
  m.onTick(tick(SPOT_TOKEN, 56_010))
  const declared = m.declare('A', [
    { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 },
  ])
  assert.deepEqual(
    [...declared.tokens].sort((a, b) => a - b),
    [55_901, 55_902, 56_001, 56_002, 56_101, 56_102],
  )
})

test('releasing a strategy drops its subscriptions and its routes', () => {
  const { md: m } = md()
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  m.release('A')
  assert.deepEqual(m.routesFor(SPOT_TOKEN), [])
  assert.deepEqual(m.subscriptionSet(), [])
})

// -------------------------------------------------------------- bounded state

/**
 * THE TWO MAPS THAT NOTHING EMPTIED (audit F-53).
 *
 * `#quotes` kept the last tick for every token that ever arrived and `#routes`
 * kept a set per token forever — and the chain window MOVES, so on a trending
 * day the runner declares a fresh pair of contracts every few minutes and never
 * takes one back. Both maps grew for the life of the process, and the entries
 * that accumulated are the useless ones: a quote for a contract nobody is
 * subscribed to any more is a price that will never be updated again, which is
 * a worse thing to hold than nothing (`selectOption` marks its grid from this
 * map).
 *
 * The prune is on the DECLARE cadence because that is when the answer to "who
 * wants this token" changes, and `declareAll` re-declares every catalogue entry
 * on every sync — so the currently-declared set is always complete at that
 * moment, never a single strategy's slice.
 */
test('a token no declaration wants any more is dropped from routes AND quotes', () => {
  const { md: m } = md()
  m.onTick(tick(SPOT_TOKEN, 56_010))
  const first = m.declare('A', [
    { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 },
  ])
  assert.equal(first.tokens.length, 6)
  for (const t of first.tokens) m.onTick(tick(t, 100))
  assert.equal(m.stats.quotes, 7, 'six contracts plus spot')

  // Spot runs 400 points: the window re-centres on 56400 and the old wings
  // (55900/56000) are wanted by nobody.
  m.onTick(tick(SPOT_TOKEN, 56_410))
  const moved = m.declare('A', [
    { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 },
  ])
  assert.deepEqual(
    [...moved.tokens].sort((a, b) => a - b),
    [56_301, 56_302, 56_401, 56_402],
    'the grid ends at 56400, so the window is two listed strikes here',
  )
  assert.deepEqual(m.routesFor(55_901), [], 'a retired token routes to nobody')
  assert.deepEqual(m.routesFor(56_401), ['A'])
  assert.equal(m.quote(55_901), null, 'and its stale price is gone, not kept forever')
  assert.equal(
    m.stats.routedTokens,
    4,
    'the routing table holds the CURRENT window, not every window there has ever been',
  )
})

test('the spot quote survives the prune, or no window could ever be centred again', () => {
  /**
   * The one token a chain-only declaration needs and does not subscribe:
   * `#chainWindow` centres on `#quotes.get(spotToken)`. Pruning strictly to the
   * subscription set would delete it and every subsequent declare would return
   * an empty window — the cold-start failure, permanently, at 09:20.
   */
  const { md: m } = md()
  m.onTick(tick(SPOT_TOKEN, 56_010))
  m.declare('A', [{ kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 }])
  assert.notEqual(m.quote(SPOT_TOKEN), null)
  const again = m.declare('A', [
    { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 1 },
  ])
  assert.equal(again.tokens.length, 6, 'still centred, declare after declare')
})

test('a quote for a token nobody ever declared does not accumulate', () => {
  const { md: m } = md()
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  // The feed pool is shared: ticks arrive for tokens this process never asked
  // for, and `main.ts` routes them to nobody. They must not be stored either.
  m.onTick(tick(999_998, 12))
  m.onTick(tick(999_999, 13))
  assert.equal(m.stats.quotes, 2)
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  assert.equal(m.stats.quotes, 0, 'nothing declared them, so nothing keeps them')
})

test('releasing a strategy prunes the tokens only it wanted', () => {
  const { md: m } = md()
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  m.onTick(tick(SPOT_TOKEN, 56_000))
  assert.equal(m.stats.quotes, 1)
  m.release('A')
  assert.equal(m.stats.routedTokens, 0)
  assert.equal(m.stats.quotes, 0)
})

// ------------------------------------------------------------------- candles

test('ticks advance the declared series, and only COMPLETED bars are served', async () => {
  const { md: m, clock } = md()
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])

  // Three ticks inside one 5-minute bucket: still forming, so nothing is served.
  m.onTick(tick(SPOT_TOKEN, 56_000, Date.UTC(2026, 6, 24, 4, 0)))
  m.onTick(tick(SPOT_TOKEN, 56_050, Date.UTC(2026, 6, 24, 4, 1)))
  m.onTick(tick(SPOT_TOKEN, 55_950, Date.UTC(2026, 6, 24, 4, 2)))
  assert.deepEqual(await m.candles(SPOT_TOKEN, '5minute', 5), [])

  // A tick in the next bucket closes the first one.
  clock.set(Date.UTC(2026, 6, 24, 4, 6))
  m.onTick(tick(SPOT_TOKEN, 56_100, Date.UTC(2026, 6, 24, 4, 6)))
  const bars = await m.candles(SPOT_TOKEN, '5minute', 5)
  assert.equal(bars.length, 1)
  assert.deepEqual(
    { o: bars[0]?.open, h: bars[0]?.high, l: bars[0]?.low, c: bars[0]?.close },
    { o: 56_000, h: 56_050, l: 55_950, c: 55_950 },
  )
})

test('an undeclared series reads empty rather than throwing — the job retries', async () => {
  const { md: m } = md()
  assert.deepEqual(await m.candles(12_345, '5minute', 10), [])
})

// ---------------------------------------------------------------- resolution

test('atmStrike snaps to a LISTED strike', () => {
  const { md: m } = md()
  assert.equal(m.atmStrike('BANKNIFTY', 56_040), 56_000)
  assert.equal(m.atmStrike('BANKNIFTY', 56_060), 56_100)
})

test('atmStrike returns 0 when there is no chain — a value that cannot resolve', () => {
  const { md: m } = md()
  assert.equal(m.atmStrike('RELIANCE', 1500), 0)
  // ...and the follow-up lookup is null, so no order can be built from it.
  assert.equal(m.option('RELIANCE', 0, 'CE'), null)
})

test('spotToken throws for an unknown underlying — there is no number that means "none"', () => {
  const { md: m } = md()
  assert.equal(m.spotToken('BANKNIFTY'), SPOT_TOKEN)
  assert.throws(() => m.spotToken('RELIANCE'), /no spot instrument/)
})

test('a delta selection with no marks returns null, never an ATM fallback', () => {
  const { md: m } = md()
  m.onTick(tick(SPOT_TOKEN, 56_010))
  assert.equal(m.select('BANKNIFTY', { by: 'delta', target: 0.3, type: 'CE' }), null)
})

test('an ATM selection resolves to a real listed contract', () => {
  const { md: m } = md()
  m.onTick(tick(SPOT_TOKEN, 56_010))
  const sel = m.select('BANKNIFTY', { by: 'atm', type: 'CE' })
  assert.equal(sel?.strike, 56_000)
  assert.equal(sel?.instrument.tradingsymbol, 'BANKNIFTY26AUG56000CE')
})

// -------------------------------------------------------------- feed health

test('the feed is untrustworthy before the first tick, and again once it goes quiet', () => {
  const { md: m, clock } = md()
  assert.equal(m.isTrustworthy(), false)
  assert.match(m.reason() ?? '', /no ticks received yet/)

  m.onTick(tick(SPOT_TOKEN, 56_000, NOW))
  assert.equal(m.isTrustworthy(), true)
  assert.equal(m.reason(), null)

  // A socket that stays OPEN while ticks stop is the dangerous failure — it
  // looks healthy while every strategy decides on frozen prices.
  clock.set(NOW + 20_000)
  assert.equal(m.isTrustworthy(), false)
  assert.match(m.reason() ?? '', /no tick for 20s/)
})

// ------------------------------------------------------------------ seeding

/**
 * Kite throttles the historical endpoint per LOGIN at ~3 requests a second.
 * A boot batch is 72 tokens x 2 intervals, and before pacing the seed loop
 * fired them ~35ms apart — 399 "NetworkException: Too many requests" seed
 * failures in two weeks of prod logs, each one a series that stayed COLD until
 * the next restart because `declare()` only reports newly-activated series.
 */
function seededMd(opts: {
  gapMs: number
  fail?: (token: number, calls: number) => boolean
}): {
  md: RunnerMarketData
  calls: { token: number; at: number }[]
  sleeps: number[]
} {
  const calls: { token: number; at: number }[] = []
  const sleeps: number[] = []
  let virtual = 0
  let n = 0
  const m = new RunnerMarketData({
    master: () => master(),
    clock: fixedClock(NOW),
    log: makeLogger(),
    seedGapMs: opts.gapMs,
    sleep: async (ms) => {
      sleeps.push(ms)
      virtual += ms
    },
    history: {
      bars: async (token) => {
        n += 1
        calls.push({ token, at: virtual })
        if (opts.fail?.(token, n) === true) throw new Error('history HTTP 502: Too many requests')
        return [{ ts: NOW - 300_000, open: 1, high: 2, low: 0.5, close: 1.5 }]
      },
    },
  })
  return { md: m, calls, sleeps }
}

const series = (tokens: number[]) =>
  tokens.flatMap((token) => [
    { token, interval: '5minute' as const },
    { token, interval: '60minute' as const },
  ])

test('seed paces history calls at the configured gap instead of bursting', async () => {
  const { md: m, calls } = seededMd({ gapMs: 350 })
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  await m.seed(series([SPOT_TOKEN]))
  assert.equal(calls.length, 2)
  // The FIRST call goes immediately; every later one waits out the gap.
  assert.deepEqual(calls.map((c) => c.at), [0, 350])
})

test('overlapping seed batches share one lane — never two calls in flight', async () => {
  const { md: m, calls } = seededMd({ gapMs: 350 })
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  // main.ts fires `void md.seed()` per built strategy on top of the 15s
  // declareAll — without a shared lane they burst side by side.
  await Promise.all([m.seed(series([SPOT_TOKEN])), m.seed(series([SPOT_TOKEN]))])
  assert.deepEqual(calls.map((c) => c.at), [0, 350, 700, 1050])
})

test('a series whose seed failed is retried on the next seed call', async () => {
  const { md: m, calls } = seededMd({ gapMs: 0, fail: (_t, n) => n === 1 })
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  await m.seed(series([SPOT_TOKEN]))
  assert.equal(calls.length, 2)
  assert.equal(m.coldSeries().length, 1, 'the failed series is remembered as cold')
  // The next declareAll pass reports NO new series, but must still warm the cold one.
  await m.seed([])
  assert.equal(calls.length, 3)
  assert.deepEqual(m.coldSeries(), [])
})

test('a cold series released by its only holder is forgotten, not retried forever', async () => {
  const { md: m, calls } = seededMd({ gapMs: 0, fail: () => true })
  m.declare('A', [{ kind: 'index', underlying: 'BANKNIFTY' }])
  await m.seed(series([SPOT_TOKEN]))
  assert.equal(m.coldSeries().length, 2)
  m.release('A')
  await m.seed([])
  assert.equal(calls.length, 2, 'nothing re-fetched for a series nobody holds')
  assert.deepEqual(m.coldSeries(), [])
})
