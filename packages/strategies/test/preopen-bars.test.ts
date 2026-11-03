import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../src/range-breakout-directional/strategy.ts'
import { BN_BREAKOUT } from '../src/range-breakout-directional/configs/bn-breakout.ts'
import { candlesClosedBy, sessionCandlesOn } from '../src/range-breakout-directional/logic.ts'

/**
 * PRE-OPEN BARS — the 2026-08-10 BN_BREAKOUT incident, reproduced.
 *
 * That morning BN_BREAKOUT bought 57900CE at 09:21:00.277 IST and stopped out nine
 * minutes later. Its persisted band was `57798.421805 / 57694.478195`, which is
 * Friday 2026-08-07's 15:25 close of 57746.45 +/- 0.09% — NOT today's 09:15-09:20
 * close of 57884.20, which would have banded 57936.30 / 57832.10.
 *
 * WHY. `#formBand` reads `sessionCandlesOn(raw, ...)[0]` as "the first candle of the
 * day", and that helper used to scope to the IST CALENDAR day. But `bucketStart`
 * (marketdata-core) deliberately buckets PRE-OPEN ticks into session-relative slots
 * — 09:00, 09:05, 09:10 — and during pre-open the index republishes the previous
 * session's close. So `[0]` was a pre-open bar carrying Friday's number.
 *
 * Legacy never had this failure available to it: `historyData(token,'5minute',today,
 * today)` is a Kite fetch, and Kite's intraday history starts at 09:15. The port
 * swapped that for a tick-fed CandleStore and inherited pre-open bars with it.
 *
 * THE CASCADE is what makes this worth a regression test rather than a one-line
 * comment. With the band stale and ~138 points low, the 09:21 entry check judged
 * today's 09:15-09:20 candle — the strategy's OWN BASE CANDLE — as the breakout
 * candle. That fires an entry four minutes before the first legal check at 09:25, on
 * a bar that by construction can never signal: a candle cannot close outside a band
 * drawn around its own close. That invariant is the sharpest statement of the bug,
 * and `bn_breakout does not enter on the bar its own band was drawn from` below is
 * the test that pins it.
 *
 * Blast radius was all six range-breakout configs plus the ATR one, because both
 * day-scoping helpers had the same calendar-day assumption. ORB_SCALP_NIFTY and
 * ORB_SCALP_SNX both traded that day off pre-open "opening ranges" of 3.8 and 23.8
 * points; the BN tags escaped only because `rangeFilterPts: 250` rejected the range
 * as too small.
 */

const IST_OFFSET_MS = 330 * 60_000
/** An IST wall-clock instant on the incident's own date, 2026-08-10. */
const ist = (h: number, m: number): number => Date.UTC(2026, 7, 10, 0, 0, 0) + (h * 60 + m) * 60_000 - IST_OFFSET_MS

const BN_SPOT_TOKEN = 260105

// The real bars, from Kite via the market-data process, for 2026-08-10.
const PRE_OPEN_BAR = { ts: ist(9, 5), open: 57746.45, high: 57746.45, low: 57746.45, close: 57746.45 }
const SESSION_FIRST_BAR = { ts: ist(9, 15), open: 57812.3, high: 58015.85, low: 57809.15, close: 57884.2 }

test('sessionCandlesOn drops PRE-OPEN bars: the first bar of the day is the 09:15 session bar', () => {
  const kept = sessionCandlesOn([PRE_OPEN_BAR, SESSION_FIRST_BAR], '5minute', ist(9, 21))

  assert.deepEqual(kept, [SESSION_FIRST_BAR],
    'a bar bucketed before 09:15 IST is pre-open, and Kite history — which this helper exists to emulate — never returns one')
})

test('candlesClosedBy drops TODAY\'s pre-open bars while keeping earlier days whole', () => {
  // ATR-14 width reads 60-minute bars. A pre-open tick buckets into the 08:15-09:15
  // slot (bucketStart anchors on 09:15 and floors backwards), which closes at 09:15
  // and so passed a 10:15 cutoff — putting a flat, previous-close bar into the ATR.
  const priorDay = { ts: ist(9, 15) - 24 * 60 * 60_000, open: 24600, high: 24700, low: 24550, close: 24650 }
  const preOpen60 = { ts: ist(8, 15), open: 24650, high: 24650, low: 24650, close: 24650 }
  const session60 = { ts: ist(9, 15), open: 24655, high: 24720, low: 24610, close: 24700 }

  const kept = candlesClosedBy([priorDay, preOpen60, session60], '60minute', 10 * 60 + 15, ist(10, 15))

  assert.deepEqual(kept, [priorDay, session60],
    "earlier days stay whole (ATR-14 needs them) but today's pre-open bar must go")
})

test('bn_breakout does not enter on the bar its own band was drawn from', async () => {
  // The 2026-08-10 incident end to end. At 09:21 the store holds a pre-open bar and
  // today's 09:15-09:20 bar; formBand fires, then the tick drives an entry check.
  // The ONLY completed bar an entry check can see at 09:21 is the base candle
  // itself, so the correct number of orders is zero — whatever the band.
  const parts = makeTestContext({ nowMs: ist(9, 16) })
  parts.md.setUnderlying('BANKNIFTY', BN_SPOT_TOKEN, 100)
  // Wired up so a wrong entry actually REACHES the gateway. Without a routable
  // contract and a quote, `#enterOption` returns early and the test would pass
  // vacuously — green for the wrong reason.
  const CE_57900 = { tradingsymbol: 'BANKNIFTY26AUG57900CE', instrumentToken: 15131394, lotSize: 30, tickSize: 0.05, exchange: 'NFO' }
  parts.md.setOption('BANKNIFTY', 57900, 'CE', CE_57900)
  parts.md.setQuote({ token: CE_57900.instrumentToken, lastPrice: 703.1, ts: 0 })
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [PRE_OPEN_BAR, SESSION_FIRST_BAR])

  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, BN_BREAKOUT)
  const res = await replay(s, parts, [
    { ts: ist(9, 21) + 300, quote: { token: BN_SPOT_TOKEN, lastPrice: 57884.2, ts: 1 } },
  ])

  assert.deepEqual(res.orders, [],
    'the 09:15-09:20 candle IS the band\'s base candle — it can never close outside a band drawn around its own close')
})

test('bn_breakout bands off the 09:15 session candle, not the pre-open bar', async () => {
  // A green 09:20-09:25 bar closing at 57850. That is above the STALE pre-open band's
  // high line (57798.42) and below the CORRECT one (57936.30), so it separates the two
  // bands by behaviour alone: an entry here means the band anchored on the pre-open bar.
  const parts = makeTestContext({ nowMs: ist(9, 16) })
  parts.md.setUnderlying('BANKNIFTY', BN_SPOT_TOKEN, 100)
  const CE_57900 = { tradingsymbol: 'BANKNIFTY26AUG57900CE', instrumentToken: 15131394, lotSize: 30, tickSize: 0.05, exchange: 'NFO' }
  parts.md.setOption('BANKNIFTY', 57900, 'CE', CE_57900)
  parts.md.setQuote({ token: CE_57900.instrumentToken, lastPrice: 703.1, ts: 0 })
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [PRE_OPEN_BAR, SESSION_FIRST_BAR])

  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, BN_BREAKOUT)
  await replay(s, parts, [
    { ts: ist(9, 21) + 300, quote: { token: BN_SPOT_TOKEN, lastPrice: 57884.2, ts: 1 } }, // band forms
  ])

  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [
    PRE_OPEN_BAR, SESSION_FIRST_BAR,
    { ts: ist(9, 20), open: 57812.3, high: 57860, low: 57800, close: 57850 },
  ])
  const res = await replay(s, parts, [
    { ts: ist(9, 26), quote: { token: BN_SPOT_TOKEN, lastPrice: 57850, ts: 2 } },
  ])

  assert.deepEqual(res.orders, [],
    '57850 clears the pre-open band (57798.42) but not the real one (57936.30) — an order here means the band came from the pre-open bar')
})
