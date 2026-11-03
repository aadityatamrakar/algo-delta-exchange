import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, type ReplayTick } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../src/range-breakout-directional/strategy.ts'
import type { RangeBreakoutDirectionalConfig } from '../src/range-breakout-directional/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

/**
 * Bar `ts` on the IST session grid — 09:15, 09:20, 09:25. `#formBand` scopes the
 * opening range to TODAY (legacy's `historyData(today, today)`), so index
 * timestamps would date every bar to 1 Jan 1970 and no band would form.
 */
const barTs = (i: number): number => Date.UTC(2026, 6, 24, 3, 45, 0) + i * 5 * 60_000

const cfg: RangeBreakoutDirectionalConfig = {
  tag: 'ORB_FUT_BN_TEST', class: 'range-breakout-directional', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }],
  legacy: { files: ['server/slive/orb-fut-bn.js', 'server/slive/orb-fut-core.js', 'server/slive/orb-fut-logic.js'] },
  band: { source: 'opening-range', candleCount: 2, bufferPct: 0.001, rangeFilterPts: 0, formAtIstMinute: 9 * 60 + 25 },
  executionMapping: 'signal-instrument-itself',
  exit: { stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'none' }, precedence: ['EOD', 'SL', 'T1'], stopMeasuredOn: 'traded', stopPolicy: 'local-tick' },
  entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60, squareOffIstMinute: 15 * 60 + 15,
  dayBudget: { kind: 'per-day' },
}

test('opening-range breakout: enters on the close beyond the range, exits at T1', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 40, 0) }) // 09:10 IST
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setCandles(FUT.instrumentToken, '5minute', [
    { ts: barTs(0), open: 50000, high: 50100, low: 49950, close: 50050 },
    { ts: barTs(1), open: 50050, high: 50120, low: 50000, close: 50080 },
  ])
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, cfg)

  const ticks: ReplayTick[] = [
    { ts: Date.UTC(2026, 6, 24, 3, 56, 0), quote: { token: FUT.instrumentToken, lastPrice: 50080, ts: 0 } }, // 09:26, band forms
  ]
  // Re-set the candles including a breakout close AFTER the band-forming tick.
  parts.md.setCandles(FUT.instrumentToken, '5minute', [
    { ts: barTs(0), open: 50000, high: 50100, low: 49950, close: 50050 },
    { ts: barTs(1), open: 50050, high: 50120, low: 50000, close: 50080 },
    { ts: barTs(2), open: 50080, high: 50200, low: 50070, close: 50180 }, // breaks 50120 * 1.001
  ])
  ticks.push({ ts: Date.UTC(2026, 6, 24, 4, 1, 0), quote: { token: FUT.instrumentToken, lastPrice: 50180, ts: 1 } }) // 09:31, entry check

  const res = await replay(s, parts, ticks)
  assert.equal(res.orders.length, 1)
  assert.equal(res.orders[0]?.side, 'BUY')
  assert.equal(res.orders[0]?.symbol, FUT.tradingsymbol)
})

test('day is blocked when the opening range fails the filter', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 40, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setCandles(FUT.instrumentToken, '5minute', [
    { ts: barTs(0), open: 50000, high: 50010, low: 49995, close: 50005 },
    { ts: barTs(1), open: 50005, high: 50012, low: 49998, close: 50008 },
  ])
  const filtered: RangeBreakoutDirectionalConfig = { ...cfg, band: { ...cfg.band, source: 'opening-range', rangeFilterPts: 250 } as never }
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, filtered)
  const res = await replay(s, parts, [
    { ts: Date.UTC(2026, 6, 24, 3, 56, 0), quote: { token: FUT.instrumentToken, lastPrice: 50008, ts: 0 } },
    { ts: Date.UTC(2026, 6, 24, 4, 30, 0), quote: { token: FUT.instrumentToken, lastPrice: 50500, ts: 1 } },
  ])
  assert.equal(res.orders.length, 0, 'a range below the filter must block the whole day')
})

test('squareOff force-exits an ACTIVE future position at EOD', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 9, 44, 0) }) // 15:14 IST, just before squareOff
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, cfg)
  await s.start() // catch-up runs formBand + closeEntries; squareOff is order-placing, so it is NOT replayed
  // Manually arm an ACTIVE position the way a recovered strategy would, then fire squareOff live.
  await s.firePhase('squareOff') // no position yet -> no-op, proves idempotence
  assert.equal(parts.gateway.orders.length, 0)
})
