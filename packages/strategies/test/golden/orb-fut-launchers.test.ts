import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder, type ShadowHistoryCandle } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../../src/range-breakout-directional/strategy.ts'
import { ORB_FUT_BN, ORB_FUT_NIFTY, ORB_FUT_SNX } from '../../src/range-breakout-directional/configs/orb-fut.ts'

/**
 * I2: class-level golden days for `orb-fut-bn.js` / `orb-fut-nifty.js` / `orb-fut-snx.js`,
 * driving the REAL legacy launchers (each a thin `orb-fut-core.js` factory call) via
 * LegacyShadowRunner — not just diffing the extracted `orb-fut-logic.js` pure module, which
 * is all `orb-fut.test.ts` does. Before this file, the orchestration layer for these 3 configs
 * (when the opening range forms, when a breakout is checked, which instrument the SL/T1 exit
 * carries) had never been compared to the legacy launcher at all — exactly the I2 gap that let
 * C4/C5/I1 through elsewhere. `orb-fut-core.js` has no time-stop and no ATM-strike lookup (it
 * trades the future itself), so it is structurally simpler than bn-breakout/orb-scalp, but the
 * launcher wiring (range windowing via `computeRange(candles,6)`, breakout via `breakoutSide`,
 * exit via the `evaluateExit` reducer's SL/T1/EOD precedence) was never driven end-to-end.
 */

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'archive', 'server', 'slive')

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

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

// ---- ORB_FUT_BN: rangeFilterPts 250, BANKNIFTY-scale, BUY entry -> T1 exit ----

const BN_FUT = { tradingsymbol: 'BANKNIFTY26JULFUT', instrumentToken: 800001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
// 6 range candles (09:15-09:45): rangeHigh=50300, rangeLow=49950, range=350 >= 250 filter.
// Candle[6] (09:45-09:50, the FIRST candle checkBreakout() ever sees once the range is set —
// a static fixture, not date-filtered) closes 50400 > 50300*1.001=50300.3 -> BUY.
const BN_CANDLES: readonly ShadowHistoryCandle[] = [
  { open: 50000, high: 50100, low: 49950, close: 50050 },
  { open: 50050, high: 50120, low: 50000, close: 50080 },
  { open: 50080, high: 50150, low: 50020, close: 50100 },
  { open: 50100, high: 50200, low: 50050, close: 50150 },
  { open: 50150, high: 50250, low: 50100, close: 50200 },
  { open: 50200, high: 50300, low: 50150, close: 50250 },
  { open: 50250, high: 50420, low: 50200, close: 50400 },
]

test('ORB_FUT_BN class-level golden day — BUY entry then T1 exit: legacy launcher and ported class emit the SAME orders, on the SAME instrument', { timeout: 20_000 }, async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'orb-fut-bn.js'),
    futureToken: BN_FUT.instrumentToken,
    futureInstrument: { instrument_token: BN_FUT.instrumentToken, tradingsymbol: BN_FUT.tradingsymbol, strike: 0, lot_size: BN_FUT.lotSize },
    currentExpiryOptions: {}, // orb-fut-core.js never touches options
    nowMs: Date.UTC(2026, 6, 24, 3, 49, 0), // 09:19 IST
    historyData: { [`${BN_FUT.instrumentToken}:5minute`]: BN_CANDLES },
  })
  await run.advance(27 * 60_000) // -> 09:46 IST, past 09:45:20 setupRange
  await run.tick([{ instrument_token: BN_FUT.instrumentToken, last_price: 50400 }]) // seed ticksCache for entry
  await run.advance(4 * 60_000 + 10_000) // -> 09:50:10, next checkBreakoutQ -> BUY breakout -> enters
  await run.tick([{ instrument_token: BN_FUT.instrumentToken, last_price: 50760 }]) // T1 = entry(50400)+range(350)=50750 -> crossed
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
  assert.equal(legacyOrders.length, 2, 'BUY future entry + SELL future T1 exit')
  assert.equal(legacyOrders[0]?.side, 'BUY')
  assert.equal(legacyOrders[1]?.side, 'SELL')
  assert.equal(legacyOrders[0]?.symbol, BN_FUT.tradingsymbol)
  assert.equal(legacyOrders[1]?.symbol, BN_FUT.tradingsymbol)

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
  parts.md.setFuture('BANKNIFTY', BN_FUT)
  // computeOpeningRange windows `candles.slice(0, band.candleCount)` — the trailing 7th
  // (breakout) candle is excluded from the range calc regardless of when it's already present,
  // so preloading all 7 upfront (unlike atr-band-nifty's atr-anchor, this mapping has no second
  // phase reading a DIFFERENT candle set) is safe and mirrors legacy's own static-fixture shape.
  parts.md.setCandles(BN_FUT.instrumentToken, '5minute', withSessionTs(BN_CANDLES))
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_FUT_BN)
  const ticks: ReplayTick[] = [
    // 09:45:30, matching `run.advance(27 * 60_000)` on the legacy side above — both sides
    // must read the opening range AFTER 09:45:20, never on the second its last bar closes.
    { ts: Date.UTC(2026, 6, 24, 4, 15, 30), quote: { token: BN_FUT.instrumentToken, lastPrice: 50400, ts: 0 } }, // band forms + breakout entry
    { ts: Date.UTC(2026, 6, 24, 4, 20, 0), quote: { token: BN_FUT.instrumentToken, lastPrice: 50760, ts: 1 } }, // 09:50, T1 exit
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(res.orders.length, 2)
  assert.equal(res.orders[1]?.symbol, res.orders[0]?.symbol, "exit instrument must equal the entry's")
})

// ---- ORB_FUT_NIFTY: no range filter, NIFTY-scale, BUY entry -> SL exit ----

const NIFTY_FUT = { tradingsymbol: 'NIFTY26JULFUT', instrumentToken: 800002, lotSize: 25, tickSize: 0.05, exchange: 'NFO' }
// 6 range candles: rangeHigh=22110, rangeLow=21980, range=130 (no filter, always passes).
// Candle[6] closes 22200 > 22110*1.001=22132.11 -> BUY.
const NIFTY_CANDLES: readonly ShadowHistoryCandle[] = [
  { open: 22000, high: 22050, low: 21980, close: 22020 },
  { open: 22020, high: 22060, low: 22000, close: 22040 },
  { open: 22040, high: 22070, low: 22010, close: 22050 },
  { open: 22050, high: 22090, low: 22030, close: 22060 },
  { open: 22060, high: 22100, low: 22040, close: 22070 },
  { open: 22070, high: 22110, low: 22050, close: 22080 },
  { open: 22080, high: 22210, low: 22070, close: 22200 },
]

test('ORB_FUT_NIFTY class-level golden day — no range filter, BUY entry then SL exit: legacy and ported emit the SAME orders', { timeout: 20_000 }, async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'orb-fut-nifty.js'),
    futureToken: NIFTY_FUT.instrumentToken,
    futureInstrument: { instrument_token: NIFTY_FUT.instrumentToken, tradingsymbol: NIFTY_FUT.tradingsymbol, strike: 0, lot_size: NIFTY_FUT.lotSize },
    currentExpiryOptions: {},
    nowMs: Date.UTC(2026, 6, 24, 3, 49, 0),
    historyData: { [`${NIFTY_FUT.instrumentToken}:5minute`]: NIFTY_CANDLES },
  })
  await run.advance(27 * 60_000)
  await run.tick([{ instrument_token: NIFTY_FUT.instrumentToken, last_price: 22200 }])
  await run.advance(4 * 60_000 + 10_000) // -> 09:50:10 -> BUY breakout -> enters
  // SL = rangeLow = 21980. Cross it.
  await run.tick([{ instrument_token: NIFTY_FUT.instrumentToken, last_price: 21970 }])
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
  assert.equal(legacyOrders.length, 2, 'BUY future entry + SELL future SL exit')
  assert.equal(legacyOrders[0]?.side, 'BUY')
  assert.equal(legacyOrders[1]?.side, 'SELL')

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
  parts.md.setFuture('NIFTY', NIFTY_FUT)
  parts.md.setCandles(NIFTY_FUT.instrumentToken, '5minute', withSessionTs(NIFTY_CANDLES))
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_FUT_NIFTY)
  const ticks: ReplayTick[] = [
    { ts: Date.UTC(2026, 6, 24, 4, 15, 30), quote: { token: NIFTY_FUT.instrumentToken, lastPrice: 22200, ts: 0 } }, // 09:45:30, past setupRange
    { ts: Date.UTC(2026, 6, 24, 4, 20, 0), quote: { token: NIFTY_FUT.instrumentToken, lastPrice: 21970, ts: 1 } }, // SL exit
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(res.orders.length, 2)
  assert.equal(res.orders[1]?.symbol, res.orders[0]?.symbol, "exit instrument must equal the entry's")
})

// ---- ORB_FUT_SNX: no range filter, SENSEX-scale, SELL entry -> T1 exit ----

const SNX_FUT = { tradingsymbol: 'SENSEX26JULFUT', instrumentToken: 800003, lotSize: 10, tickSize: 0.05, exchange: 'BFO' }
// 6 range candles: rangeHigh=74300, rangeLow=73950, range=350 (no filter).
// Candle[6] closes 73800 < 73950*0.999=73876.05 -> SELL.
const SNX_CANDLES: readonly ShadowHistoryCandle[] = [
  { open: 74000, high: 74100, low: 73950, close: 74050 },
  { open: 74050, high: 74120, low: 74000, close: 74080 },
  { open: 74080, high: 74150, low: 74020, close: 74100 },
  { open: 74100, high: 74200, low: 74050, close: 74150 },
  { open: 74150, high: 74250, low: 74100, close: 74200 },
  { open: 74200, high: 74300, low: 74150, close: 74250 },
  { open: 74200, high: 74210, low: 73790, close: 73800 },
]

test('ORB_FUT_SNX class-level golden day — no range filter, SELL entry then T1 exit: legacy and ported emit the SAME orders', { timeout: 20_000 }, async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'orb-fut-snx.js'),
    futureToken: SNX_FUT.instrumentToken,
    futureInstrument: { instrument_token: SNX_FUT.instrumentToken, tradingsymbol: SNX_FUT.tradingsymbol, strike: 0, lot_size: SNX_FUT.lotSize },
    currentExpiryOptions: {},
    nowMs: Date.UTC(2026, 6, 24, 3, 49, 0),
    historyData: { [`${SNX_FUT.instrumentToken}:5minute`]: SNX_CANDLES },
  })
  await run.advance(27 * 60_000)
  await run.tick([{ instrument_token: SNX_FUT.instrumentToken, last_price: 73800 }])
  await run.advance(4 * 60_000 + 10_000) // -> 09:50:10 -> SELL breakout -> enters
  // T1 = entry(73800) - range(350) = 73450. Cross it.
  await run.tick([{ instrument_token: SNX_FUT.instrumentToken, last_price: 73440 }])
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
  assert.equal(legacyOrders.length, 2, 'SELL future entry + BUY future T1 exit')
  assert.equal(legacyOrders[0]?.side, 'SELL')
  assert.equal(legacyOrders[1]?.side, 'BUY')

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
  parts.md.setFuture('SENSEX', SNX_FUT)
  parts.md.setCandles(SNX_FUT.instrumentToken, '5minute', withSessionTs(SNX_CANDLES))
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_FUT_SNX)
  const ticks: ReplayTick[] = [
    { ts: Date.UTC(2026, 6, 24, 4, 15, 30), quote: { token: SNX_FUT.instrumentToken, lastPrice: 73800, ts: 0 } }, // 09:45:30, past setupRange
    { ts: Date.UTC(2026, 6, 24, 4, 20, 0), quote: { token: SNX_FUT.instrumentToken, lastPrice: 73440, ts: 1 } }, // T1 exit
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(res.orders.length, 2)
  assert.equal(res.orders[1]?.symbol, res.orders[0]?.symbol, "exit instrument must equal the entry's")
})
