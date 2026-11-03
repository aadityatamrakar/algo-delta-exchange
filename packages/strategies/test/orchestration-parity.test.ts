import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, type ReplayTick } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../src/range-breakout-directional/strategy.ts'
import { ORB_FUT_BN } from '../src/range-breakout-directional/configs/orb-fut.ts'
import { ORB_SCALP_BN } from '../src/range-breakout-directional/configs/orb-scalp.ts'

/**
 * ORCHESTRATION parity with the legacy launchers — the layer the golden tests do
 * not reach.
 *
 * `golden/*.test.ts` diffs the pure decision functions against the legacy modules
 * and drives two-tick static-fixture days. That is blind to everything ROUND the
 * decision: how many times a day may trade, which candle the band is anchored on,
 * and when an entry check is allowed to run. Five defects lived in exactly that
 * gap, all of them invisible to a passing golden suite, and each test below was
 * first written to FAIL against the port and pass against legacy's own rules.
 *
 *   1. ORB_FUT_* re-entered after every exit   (legacy: `tradedToday`, 1/day)
 *   2. ATR_BAND_NIFTY re-entered the same side (legacy: `ceUsed`/`peUsed`, 1/side)
 *   3. BN_BREAKOUT's band anchored on the LAST bar after a restart, not the first
 *   4. the opening range was windowed off the oldest bars in a 200-bar store,
 *      which is a range from a PRIOR SESSION
 *   5. entry checks were paced by the wall clock, not by the bar (see
 *      `DayState.lastEvaluatedBarTs`)
 */

const BN_FUT = { tradingsymbol: 'BANKNIFTY26JULFUT', instrumentToken: 800001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

// Same 7-candle fixture the existing golden test uses: range 49950-50300 (350 >= 250 filter),
// candle[6] closes 50400 > 50300.3 -> BUY.
// `ts` is epoch ms of the bar's OPEN, on the IST session grid — 09:15, 09:20, ...
// Array-index timestamps would put every bar on 1 Jan 1970 and the day filter in
// `#formBand` would (correctly) discard the lot.
//
// The hours below are IST WALL CLOCK, which is what `- 330 * 60_000` converts FROM.
// They used to read `3, 45 + i * 5` — the UTC instant of 09:15 IST — and then
// subtract the offset a second time, landing the whole fixture at 03:45 IST. That
// survived only because the scope filter tested the IST DATE and 03:45 shares it;
// once the filter learned that a bar before 09:15 is a PRE-OPEN bar, a fixture
// claiming to be the opening range at 3:45 in the morning stopped being accepted.
const BN_CANDLES = [
  { open: 50000, high: 50100, low: 49950, close: 50050 },
  { open: 50050, high: 50120, low: 50000, close: 50080 },
  { open: 50080, high: 50150, low: 50020, close: 50100 },
  { open: 50100, high: 50200, low: 50050, close: 50150 },
  { open: 50150, high: 50250, low: 50100, close: 50200 },
  { open: 50200, high: 50300, low: 50150, close: 50250 },
  { open: 50250, high: 50420, low: 50200, close: 50400 },
].map((c, i) => ({ ts: Date.UTC(2026, 6, 24, 9, 15 + i * 5, 0) - 330 * 60_000, ...c }))

test('ORB_FUT_BN: one trade per day — no re-entry after the T1 exit (legacy orb-fut-core.js `tradedToday`)', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) }) // 09:19 IST
  parts.md.setFuture('BANKNIFTY', BN_FUT)
  parts.md.setCandles(BN_FUT.instrumentToken, '5minute', BN_CANDLES)
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_FUT_BN)

  const ticks: ReplayTick[] = [
    // 09:45:30 — past the 09:45:20 setupRange, the same offset the legacy side advances
    // to. The opening range's last bar closes AT 09:45:00, so a band job firing on that
    // exact second is racing the bar it reads (orb-scalp.js:292).
    { ts: Date.UTC(2026, 6, 24, 4, 15, 30), quote: { token: BN_FUT.instrumentToken, lastPrice: 50400, ts: 0 } }, // 09:45:30 band + BUY
    { ts: Date.UTC(2026, 6, 24, 4, 20, 0), quote: { token: BN_FUT.instrumentToken, lastPrice: 50760, ts: 1 } }, // 09:50 T1 exit
    { ts: Date.UTC(2026, 6, 24, 4, 26, 0), quote: { token: BN_FUT.instrumentToken, lastPrice: 50400, ts: 2 } }, // 09:56 — legacy is DONE for the day
    { ts: Date.UTC(2026, 6, 24, 4, 32, 0), quote: { token: BN_FUT.instrumentToken, lastPrice: 50400, ts: 3 } }, // 10:02
  ]
  const res = await replay(s, parts, ticks)

  assert.deepEqual(
    res.orders.map((o) => o.side),
    ['BUY', 'SELL'],
    `legacy sets tradedToday at entry and never resets it — exactly 1 round trip per day. Got ${res.orders.length} orders: ${JSON.stringify(res.orders.map((o) => `${o.side} ${o.symbol}`))}`,
  )
})

// --- control: the option mapping DOES stop for the day (dayBudget per-day is honoured there) ---

const BN_SPOT = 260105
const CE = { tradingsymbol: 'BANKNIFTY50400CE', instrumentToken: 900001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

test('ORB_SCALP_BN control: after the option exit the day is closed (stopForDay is set on the option path)', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
  parts.md.setUnderlying('BANKNIFTY', BN_SPOT, 100)
  parts.md.setOption('BANKNIFTY', 50400, 'CE', CE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 500, ts: 0 })
  parts.md.setCandles(BN_SPOT, '5minute', BN_CANDLES)
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)

  const ticks: ReplayTick[] = [
    { ts: Date.UTC(2026, 6, 24, 4, 15, 0), quote: { token: BN_SPOT, lastPrice: 50400, ts: 0 } },
    { ts: Date.UTC(2026, 6, 24, 4, 20, 0), quote: { token: CE.instrumentToken, lastPrice: 500, ts: 1 } },
    { ts: Date.UTC(2026, 6, 24, 4, 26, 0), quote: { token: BN_SPOT, lastPrice: 50400, ts: 2 } },
  ]
  const res = await replay(s, parts, ticks)
  assert.ok(res.orders.length <= 2, `expected at most one round trip, got ${JSON.stringify(res.orders)}`)
})

// --- ATR_BAND_NIFTY: legacy `ceUsed`/`peUsed` allow ONE entry per side per day ---

import { BN_BREAKOUT } from '../src/range-breakout-directional/configs/bn-breakout.ts'
import { ATR_BAND_NIFTY } from '../src/range-breakout-directional/configs/atr-band-nifty.ts'

const IST = 330 * 60_000
const at = (hh: number, mm: number, day = 24): number => Date.UTC(2026, 6, day, hh, mm, 0) - IST
const NIFTY_SPOT = 256265
const N_CE = { tradingsymbol: 'NIFTY22450CE', instrumentToken: 900011, lotSize: 75, tickSize: 0.05, exchange: 'NFO' }

const SIXTY = [
  ...Array.from({ length: 14 }, () => ({ ts: at(9, 15, 17), open: 22400, high: 22410, low: 22390, close: 22400 })),
  { ts: at(9, 15), open: 22400, high: 22410, low: 22390, close: 22400 }, // today's 09:15-10:15 bar
]
const FILLER = [] as { ts: number; open: number; high: number; low: number; close: number }[]
for (let m = 9 * 60 + 15; m <= 11 * 60 + 35; m += 5) {
  FILLER.push({ ts: at(Math.floor(m / 60), m % 60), open: 22300, high: 22310, low: 22290, close: 22300 }) // doji
}
const GREEN_PAIR_A = [
  { ts: at(11, 40), open: 22300, high: 22430, low: 22290, close: 22420 },
  { ts: at(11, 45), open: 22420, high: 22460, low: 22410, close: 22450 },
]
const GREEN_PAIR_B = [
  { ts: at(11, 50), open: 22450, high: 22470, low: 22440, close: 22460 },
  { ts: at(11, 55), open: 22460, high: 22480, low: 22450, close: 22470 },
]

test('ATR_BAND_NIFTY: one entry per SIDE per day — no second CE after the first CE closes (legacy ceUsed/peUsed)', async () => {
  const parts = makeTestContext({ nowMs: at(9, 20) })
  parts.md.setUnderlying('NIFTY', NIFTY_SPOT, 50)
  parts.md.setOption('NIFTY', 22450, 'CE', N_CE)
  parts.md.setCandles(NIFTY_SPOT, '60minute', SIXTY)
  parts.md.setCandles(NIFTY_SPOT, '5minute', FILLER)
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ATR_BAND_NIFTY)
  await s.start()

  parts.clock.set(at(10, 15)); await s.fireJob('formBand')
  parts.clock.set(at(11, 40)); await s.fireJob('anchorBand')

  // 11:50 — the two green closes above highLine (22306.67) are in: CE entry at premium 100.
  parts.md.setCandles(NIFTY_SPOT, '5minute', [...FILLER, ...GREEN_PAIR_A])
  parts.clock.set(at(11, 50))
  parts.md.setQuote({ token: N_CE.instrumentToken, lastPrice: 100, ts: at(11, 50) })
  const spotQ = { token: NIFTY_SPOT, lastPrice: 22450, ts: at(11, 50) }
  parts.md.setQuote(spotQ); s.handleTick(spotQ); await s.drain()

  // 11:51 — premium 130 >= target min(120, 130): TARGET exit.
  parts.clock.set(at(11, 51))
  const optQ = { token: N_CE.instrumentToken, lastPrice: 130, ts: at(11, 51) }
  parts.md.setQuote(optQ); s.handleTick(optQ); await s.drain()

  // 11:56 — two more green closes above the line. Legacy: ceUsed is set, CE is spent for the day.
  parts.md.setCandles(NIFTY_SPOT, '5minute', [...FILLER, ...GREEN_PAIR_A, ...GREEN_PAIR_B])
  parts.clock.set(at(11, 56))
  const spotQ2 = { token: NIFTY_SPOT, lastPrice: 22470, ts: at(11, 56) }
  parts.md.setQuote(spotQ2); s.handleTick(spotQ2); await s.drain()

  assert.deepEqual(
    parts.gateway.orders.map((o) => `${o.side} ${o.symbol}`),
    ['BUY NIFTY22450CE', 'SELL NIFTY22450CE'],
    'legacy sets ceUsed at entry and never clears it — the CE side gets exactly one entry per day',
  )
})

// --- BN_BREAKOUT: legacy computeLines() anchors on candles[0], the 09:15-09:20 bar ---

const BNB_SPOT = 260105
const BNB_CE = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 900001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

// legacy band  (first candle close 50000, +/-0.09%): 49955.0  ..  50045.0
// port band    (last  candle close 51100, +/-0.09%): 51054.01 .. 51145.99
test('BN_BREAKOUT formBand on a catch-up run anchors on the LAST bar, not the first (legacy uses candles[0])', async () => {
  const parts = makeTestContext({ nowMs: at(9, 20) })
  parts.md.setUnderlying('BANKNIFTY', BNB_SPOT, 100)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', BNB_CE)
  parts.md.setQuote({ token: BNB_CE.instrumentToken, lastPrice: 200, ts: at(13, 0) })
  // A restart at 13:00: the store legitimately holds the whole session so far.
  parts.md.setCandles(BNB_SPOT, '5minute', [
    { ts: at(9, 15), open: 50000, high: 50100, low: 49950, close: 50000 }, // the REAL first candle
    { ts: at(9, 20), open: 50000, high: 50200, low: 49900, close: 50100 },
    { ts: at(12, 55), open: 51000, high: 51200, low: 50900, close: 51100 }, // whatever is latest now
  ])
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, BN_BREAKOUT)
  await s.start()
  parts.clock.set(at(13, 0))
  await s.fireJob('formBand')

  // A green candle closing 50060: through the LEGACY highLine (50045), nowhere near the port's.
  parts.md.setCandles(BNB_SPOT, '5minute', [
    { ts: at(13, 0), open: 50000, high: 50080, low: 49990, close: 50060 },
  ])
  parts.clock.set(at(13, 5))
  const q = { token: BNB_SPOT, lastPrice: 50060, ts: at(13, 5) }
  parts.md.setQuote(q)
  s.handleTick(q)
  await s.drain()

  assert.equal(
    parts.gateway.orders.length, 1,
    'legacy computeLines() takes candles[0] — the 09:15-09:20 close — however late it runs, so this breakout enters',
  )
})


// --- opening-range: the store is seeded 200 bars deep, so `slice(0,6)` can land on a PRIOR session ---

// Yesterday's first six 5-min bars: range 45300-45200 = 100, BELOW ORB_FUT_BN's 250 filter.
const YESTERDAY = [
  { open: 45200, high: 45250, low: 45200, close: 45220 },
  { open: 45220, high: 45260, low: 45210, close: 45240 },
  { open: 45240, high: 45270, low: 45215, close: 45250 },
  { open: 45250, high: 45280, low: 45220, close: 45260 },
  { open: 45260, high: 45290, low: 45230, close: 45270 },
  { open: 45270, high: 45300, low: 45240, close: 45280 },
].map((c, i) => ({ ts: Date.UTC(2026, 6, 23, 9, 15 + i * 5, 0) - 330 * 60_000, ...c }))

// Today's six: range 49950-50300 = 350, which PASSES the filter, then the breakout bar.
const TODAY = BN_CANDLES

test("ORB_FUT_BN: the opening range is TODAY's first six bars, not the oldest six in the store", async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
  parts.md.setFuture('BANKNIFTY', BN_FUT)
  parts.md.setCandles(BN_FUT.instrumentToken, '5minute', [...YESTERDAY, ...TODAY])
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_FUT_BN)

  const res = await replay(s, parts, [
    { ts: Date.UTC(2026, 6, 24, 4, 15, 30), quote: { token: BN_FUT.instrumentToken, lastPrice: 50400, ts: 0 } }, // 09:45:30, past setupRange
  ])

  assert.equal(
    res.orders.length, 1,
    "legacy asks historyData(today, today): the range is 49950-50300 (350 >= 250) and the day trades. " +
    "Windowing the first 6 of a 200-bar store takes YESTERDAY's range (100 < 250) and blocks the day.",
  )
})
