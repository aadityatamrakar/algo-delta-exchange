import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder, type ShadowHistoryCandle } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../../src/range-breakout-directional/strategy.ts'
import { BN_BREAKOUT } from '../../src/range-breakout-directional/configs/bn-breakout.ts'
import { ORB_SCALP_BN } from '../../src/range-breakout-directional/configs/orb-scalp.ts'

/**
 * I2: class-level golden days for the `atm-option-of-side` execution mapping, driving the
 * legacy LAUNCHER (bn-breakout.js / orb-scalp.js) via LegacyShadowRunner — not just diffing
 * the extracted pure logic module, which is all `range-breakout-remaining.test.ts` does. The
 * orchestration layer (when entry is checked, which strike is chosen, what instrument the
 * exit carries, whether the time stop exists) was NEVER compared to legacy before this file,
 * and C4, C5 and I1 all lived in exactly that gap.
 */

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'archive', 'server', 'slive')

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

/** FakeMarketData.candles() wants a numeric `ts`; the legacy historyData fixture's `ts` (used
 *  only by atr-band-nifty.js, unused here) is an optional HH:MM string — distinct shapes for
 *  distinct callers, bridged here rather than forcing one type to serve both. */
/** 09:15 IST on the fixture's own day, in epoch ms — the session's first 5-minute bar. */
const SESSION_OPEN_MS = Date.UTC(2026, 6, 24, 3, 45, 0)

/**
 * Bar `ts` on the REAL IST session grid: 09:15, 09:20, 09:25, ...
 *
 * This used to hand back the array INDEX as `ts`, i.e. every bar dated 1 Jan
 * 1970. `#formBand` now scopes the opening range to TODAY before windowing it —
 * the port of the `historyData(today, today)` every legacy launcher issues, and
 * the fix for the runner seeding each series 200 bars (~2.7 sessions) deep — so
 * an epoch-0 bar is emphatically not today and is filtered out. Dating the
 * fixture properly is what makes the two sides comparable at all.
 */
function withSessionTs(candles: readonly ShadowHistoryCandle[]): { ts: number; open: number; high: number; low: number; close: number }[] {
  return candles.map((c, i) => ({
    ts: SESSION_OPEN_MS + i * 5 * 60_000,
    open: c.open, high: c.high, low: c.low, close: c.close,
  }))
}

// ---- bn-breakout: first-candle-pct band, offsetPct 0.09% (bn-breakout.js:31) ----

const BN_SPOT_TOKEN = 260105 // bn-breakout.js's own literal
const BN_CE = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 700002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const BN_OPTIONS_FIXTURE = {
  '50100CE': { instrument_token: BN_CE.instrumentToken, tradingsymbol: BN_CE.tradingsymbol, strike: 50100, lot_size: 35 },
}
// Candle[0] (09:15-09:20 close=50000) sets the +/-0.09% band: highLine=50045, lowLine=49955.
// Candle[1] is the FIRST completed candle checkBreakout() ever sees (a static fixture, not
// date-filtered — see ShadowHistoryCandle's doc) — green, close=50100 > highLine -> CE.
const BN_CANDLES: readonly ShadowHistoryCandle[] = [
  { open: 50000, high: 50010, low: 49990, close: 50000 },
  { open: 50000, high: 50120, low: 49990, close: 50100 },
]

test('bn-breakout class-level golden day — entry then TARGET exit: legacy launcher and ported class emit the SAME orders, on the SAME instrument (C5)', { timeout: 10_000 }, async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'bn-breakout.js'),
    futureToken: 999999, // bn-breakout.js never reads a future token; kept distinct/unused
    currentExpiryOptions: BN_OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 49, 0), // 09:19 IST — before the 09:21:00 computeLines cron
    historyData: { [`${BN_SPOT_TOKEN}:5minute`]: BN_CANDLES },
  })
  await run.advance(4 * 60_000) // past 09:21:00 (band forms) and 09:25:10 (first entry check)
  // Seed BEFORE the entry-check cron would otherwise fire again is not required — enterPosition
  // reads ticksCache at call time, and checkBreakoutQ re-fires every 5 min regardless, so
  // seeding now and advancing again picks it up on the NEXT check.
  await run.tick([
    { instrument_token: BN_SPOT_TOKEN, last_price: 50100 },
    { instrument_token: BN_CE.instrumentToken, last_price: 100 },
  ])
  await run.advance(5 * 60_000) // next checkBreakoutQ tick (09:30:10) — enters CE
  // TARGET = entry(100) + targetPts(45) = 145. Cross it.
  await run.tick([{ instrument_token: BN_CE.instrumentToken, last_price: 150 }])
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
  assert.equal(legacyOrders.length, 2, 'BUY CE entry + SELL CE target exit')
  assert.equal(legacyOrders[0]?.symbol, BN_CE.tradingsymbol)
  assert.equal(legacyOrders[1]?.symbol, BN_CE.tradingsymbol)

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
  parts.md.setUnderlying('BANKNIFTY', BN_SPOT_TOKEN, 100)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', BN_CE)
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, BN_BREAKOUT)
  parts.md.setQuote({ token: BN_CE.instrumentToken, lastPrice: 100, ts: 0 })
  // 'first-candle-pct' band forming reads candles(token,'5minute',1) — FakeMarketData's "last
  // N" semantics mean this must be the FIRST 5-min candle ONLY at the moment formBand fires
  // (matching a real feed, where the 2nd candle genuinely doesn't exist yet), or #formBand
  // would band off the WRONG candle. Two replay() calls, with candles updated in between,
  // mirror that — a single upfront setCandles(both) would let formBand see the future.
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', withSessionTs(BN_CANDLES.slice(0, 1)))
  await replay(s, parts, [
    { ts: Date.UTC(2026, 6, 24, 3, 53, 0), quote: { token: BN_SPOT_TOKEN, lastPrice: 50100, ts: 0 } }, // 09:23, band forms
  ])
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', withSessionTs(BN_CANDLES))
  await replay(s, parts, [
    { ts: Date.UTC(2026, 6, 24, 3, 58, 0), quote: { token: BN_SPOT_TOKEN, lastPrice: 50100, ts: 1 } }, // 09:28, entry check
    { ts: Date.UTC(2026, 6, 24, 4, 20, 30), quote: { token: BN_CE.instrumentToken, lastPrice: 150, ts: 2 } }, // TARGET exit
  ])

  const diff = diffIntents(legacyOrders, [...parts.gateway.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  // C5: the exit must carry the REAL entry instrument, not a fabricated 'CLOSE' placeholder.
  assert.equal(parts.gateway.orders.length, 2)
  assert.equal(parts.gateway.orders[1]?.symbol, parts.gateway.orders[0]?.symbol, "exit instrument must equal the entry's — never a fabricated placeholder")
  assert.equal(parts.gateway.orders[1]?.symbol, BN_CE.tradingsymbol)
})

test('bn-breakout time stop (I1): a position with no TARGET/SL hit is force-closed after timeStopMinutes, on the SAME instrument', { timeout: 10_000 }, async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'bn-breakout.js'),
    futureToken: 999999,
    currentExpiryOptions: BN_OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 49, 0),
    historyData: { [`${BN_SPOT_TOKEN}:5minute`]: BN_CANDLES },
  })
  await run.advance(4 * 60_000)
  await run.tick([
    { instrument_token: BN_SPOT_TOKEN, last_price: 50100 },
    { instrument_token: BN_CE.instrumentToken, last_price: 100 },
  ])
  await run.advance(5 * 60_000) // enters CE @ 100, target 145 — never touched below
  await run.advance(90 * 60_000) // bn-breakout.js's own setTimeout(closePosition('TIME'), 90*60000)
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
  assert.equal(legacyOrders.length, 2, 'BUY CE entry + SELL CE time-stop exit')

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
  parts.md.setUnderlying('BANKNIFTY', BN_SPOT_TOKEN, 100)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', BN_CE)
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, BN_BREAKOUT)
  parts.md.setQuote({ token: BN_CE.instrumentToken, lastPrice: 100, ts: 0 })
  const entryTs = Date.UTC(2026, 6, 24, 3, 58, 0) // 09:28 IST entry check
  // See the previous test's comment: candles must appear progressively, or formBand would
  // band off the wrong (later) candle.
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', withSessionTs(BN_CANDLES.slice(0, 1)))
  await replay(s, parts, [
    { ts: Date.UTC(2026, 6, 24, 3, 53, 0), quote: { token: BN_SPOT_TOKEN, lastPrice: 50100, ts: 0 } },
  ])
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', withSessionTs(BN_CANDLES))
  await replay(s, parts, [
    { ts: entryTs, quote: { token: BN_SPOT_TOKEN, lastPrice: 50100, ts: 1 } }, // enters
    // I1: no price tick ever crosses TARGET or SL — without the time-stop fix this position
    // would simply sit open forever. A benign heartbeat tick 91 minutes later (same option
    // price) is what lets onTick's elapsed-time check notice the deadline has passed.
    { ts: entryTs + 91 * 60_000, quote: { token: BN_CE.instrumentToken, lastPrice: 100, ts: 2 } },
  ])

  const diff = diffIntents(legacyOrders, [...parts.gateway.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(parts.gateway.orders.length, 2)
  assert.equal(parts.gateway.orders[1]?.symbol, parts.gateway.orders[0]?.symbol, 'time-stop exit reuses the real entry instrument (C5), same as any other exit')
})

// ---- orb-scalp (ORB_SCALP_BN): opening-range band, atm-option-of-side (C4's actual home) ----

const OS_SPOT_TOKEN = 260105 // orb-scalp.js CONFIGS[0].spotToken (BANKNIFTY)
const OS_CE = { tradingsymbol: 'BANKNIFTY50400CE', instrumentToken: 700003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
// C4 regression fixture: the no-breakout day's spot tick (50210) resolves to ATM strike
// 50200 — a coerced-SELL phantom entry would try to BUY a PE at THAT strike. Without a real
// instrument listed there, the phantom entry dead-ends on a null lookup and no-ops, which is
// exactly how a naive fixture would hide C4 (the same lesson as C1's 50200 strike). List it.
const OS_PE_PHANTOM = { tradingsymbol: 'BANKNIFTY50200PE', instrumentToken: 700004, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const OS_OPTIONS_FIXTURE = {
  '50400CE': { instrument_token: OS_CE.instrumentToken, tradingsymbol: OS_CE.tradingsymbol, strike: 50400, lot_size: 35 },
  '50200PE': { instrument_token: OS_PE_PHANTOM.instrumentToken, tradingsymbol: OS_PE_PHANTOM.tradingsymbol, strike: 50200, lot_size: 35 },
}
// 6 range candles (09:15-09:45): rangeHigh=50300, rangeLow=49950, range=350 >= 250 filter.
const OS_RANGE_CANDLES: readonly ShadowHistoryCandle[] = [
  { open: 50000, high: 50100, low: 49950, close: 50050 },
  { open: 50050, high: 50120, low: 50000, close: 50080 },
  { open: 50080, high: 50150, low: 50020, close: 50100 },
  { open: 50100, high: 50200, low: 50050, close: 50150 },
  { open: 50150, high: 50250, low: 50100, close: 50200 },
  { open: 50200, high: 50300, low: 50150, close: 50250 },
]
// Buffer thresholds (BUFFER_PCT 0.001): high*1.001=50350.3, low*0.999=49900.05.
const OS_NO_BREAKOUT_CANDLES: readonly ShadowHistoryCandle[] = [
  ...OS_RANGE_CANDLES,
  { open: 50200, high: 50260, low: 50190, close: 50210 }, // green, close 50210 — INSIDE the band
]
const OS_BREAKOUT_CANDLES: readonly ShadowHistoryCandle[] = [
  ...OS_RANGE_CANDLES,
  { open: 50200, high: 50420, low: 50190, close: 50400 }, // green, close 50400 > 50350.3 -> CE
]

test('C4 — orb-scalp no-breakout day: legacy and ported BOTH emit ZERO orders (the coerced-SELL phantom PE must not fire)', { timeout: 10_000 }, async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'orb-scalp.js'),
    futureToken: 999999, // orb-scalp.js never reads a future token
    currentExpiryOptions: OS_OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 4, 10, 0), // 09:40 IST — before the 09:45:20 setupRange cron
    historyData: { [`${OS_SPOT_TOKEN}:5minute`]: OS_NO_BREAKOUT_CANDLES },
  })
  await run.advance(6 * 60_000) // past 09:45:20 (range forms) and the next 09:50:10 breakout check
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.equal(legacyOrders.length, 0, 'legacy: no signal on a no-breakout day')

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 10, 0) })
  parts.md.setUnderlying('BANKNIFTY', OS_SPOT_TOKEN, 100)
  parts.md.setOption('BANKNIFTY', 50400, 'CE', OS_CE)
  // C4 regression fixture: list the strike a phantom PE would resolve to (50200, from the
  // 50210 spot tick below) WITH a quote, so a reintroduced `?? 'SELL'` bug would actually
  // reach submit() instead of dead-ending on a null instrument/quote lookup.
  parts.md.setOption('BANKNIFTY', 50200, 'PE', OS_PE_PHANTOM)
  parts.md.setQuote({ token: OS_PE_PHANTOM.instrumentToken, lastPrice: 50, ts: 0 })
  parts.md.setCandles(OS_SPOT_TOKEN, '5minute', withSessionTs(OS_NO_BREAKOUT_CANDLES))
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  const ticks: ReplayTick[] = [
    { ts: Date.UTC(2026, 6, 24, 4, 16, 0), quote: { token: OS_SPOT_TOKEN, lastPrice: 50210, ts: 0 } }, // 09:46, band forms
    { ts: Date.UTC(2026, 6, 24, 4, 21, 0), quote: { token: OS_SPOT_TOKEN, lastPrice: 50210, ts: 1 } }, // 09:51, entry check
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  // The direct C4 assertion: WITHOUT the fix, `?? 'SELL'` turns this exact "no signal" case
  // into a phantom BUY PE. This must be zero on both sides.
  assert.equal(res.orders.length, 0, 'no phantom PE entry on a day with no real breakout')
})

test('C4/C5/I2 — orb-scalp REAL breakout day: legacy launcher and ported class enter+exit identically, exit reuses the real entry instrument', { timeout: 10_000 }, async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'orb-scalp.js'),
    futureToken: 999999,
    currentExpiryOptions: OS_OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 4, 10, 0),
    historyData: { [`${OS_SPOT_TOKEN}:5minute`]: OS_BREAKOUT_CANDLES },
  })
  await run.advance(6 * 60_000) // range forms (09:45:20) + first breakout check (09:50:10): no entry yet, no spot/option ticks seeded
  await run.tick([
    { instrument_token: OS_SPOT_TOKEN, last_price: 50400 },
    { instrument_token: OS_CE.instrumentToken, last_price: 100 },
  ])
  await run.advance(5 * 60_000) // next breakout check (09:55:10) — enters CE @ 100
  // TARGET = entry(100) + targetPts(40) = 140.
  await run.tick([{ instrument_token: OS_CE.instrumentToken, last_price: 145 }])
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
  assert.equal(legacyOrders.length, 2, 'BUY CE entry + SELL CE target exit')

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 10, 0) })
  parts.md.setUnderlying('BANKNIFTY', OS_SPOT_TOKEN, 100)
  parts.md.setOption('BANKNIFTY', 50400, 'CE', OS_CE)
  parts.md.setCandles(OS_SPOT_TOKEN, '5minute', withSessionTs(OS_BREAKOUT_CANDLES))
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  parts.md.setQuote({ token: OS_CE.instrumentToken, lastPrice: 100, ts: 0 })
  const ticks: ReplayTick[] = [
    { ts: Date.UTC(2026, 6, 24, 4, 16, 0), quote: { token: OS_SPOT_TOKEN, lastPrice: 50400, ts: 0 } }, // band forms
    { ts: Date.UTC(2026, 6, 24, 4, 21, 0), quote: { token: OS_SPOT_TOKEN, lastPrice: 50400, ts: 1 } }, // entry check -> enters CE
    { ts: Date.UTC(2026, 6, 24, 4, 26, 0), quote: { token: OS_CE.instrumentToken, lastPrice: 145, ts: 2 } }, // TARGET exit
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(res.orders.length, 2)
  assert.equal(res.orders[1]?.symbol, res.orders[0]?.symbol, "exit instrument must equal the entry's — never a fabricated placeholder")
  assert.equal(res.orders[1]?.symbol, OS_CE.tradingsymbol)
})
