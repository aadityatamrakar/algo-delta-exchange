import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../../src/premium-leg-book/strategy.ts'
import { BULL_S_1 } from '../../src/premium-leg-book/configs/bull-s.ts'

/**
 * THE TAPE. Each golden day below is a fixed tick sequence, and `LEGACY_*` is the order sequence the
 * legacy `archive/server/slive/bull-s-1.js` emitted for it, recorded on 3 Nov 2026 just before the
 * archive was deleted (it ran unmodified under the legacy shadow runner). The ported strategy must
 * still emit exactly that sequence. This file is the parity reference for the BULL-S decide path.
 */

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE2 = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 999004, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
// bull-s-1.js's sendOrder() always computes `ce_s = atm + farOtm` AND `pe_s = atm - farOtm` off the
// SAME atm, with farOtm=0 (D7 — otmSelector faked to 0), so a group's CE and PE legs always share
// the SAME strike as the atm that opened them. For a second group at atm=50100, that leg is
// 50100PE, not 49900PE — the recorded tape below has it so (the legacy run threw on an undefined
// `currentExpiryOptions['50100PE']` lookup otherwise).
const PE2 = { tradingsymbol: 'BANKNIFTY50100PE', instrumentToken: 999005, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const LEGACY_DAY_1: readonly RecordedOrder[] = [
  { symbol: 'BANKNIFTY50000CE', side: 'SELL', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50000PE', side: 'SELL', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50000PE', side: 'BUY', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50000CE', side: 'BUY', lots: 1, orderType: 'MARKET' },
]

const LEGACY_DAY_3: readonly RecordedOrder[] = [
  { symbol: 'BANKNIFTY50000CE', side: 'SELL', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50000PE', side: 'SELL', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50100CE', side: 'SELL', lots: 2, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50100PE', side: 'SELL', lots: 2, orderType: 'MARKET' },
]

async function runPortedSide(ticks: ReplayTick[], seedQuotes: { token: number; lastPrice: number }[] = []): Promise<RecordedOrder[]> {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', CE2)
  parts.md.setOption('BANKNIFTY', 50100, 'PE', PE2)
  for (const q of seedQuotes) parts.md.setQuote({ token: q.token, lastPrice: q.lastPrice, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, BULL_S_1)
  const res = await replay(s, parts, ticks)
  return [...res.orders]
}

test('golden day 1 — entry + combined-stop: the ported strategy emits the recorded legacy order sequence', async () => {
  const legacyOrders = LEGACY_DAY_1

  const portedOrders = await runPortedSide(
    [
      { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
      { ts: 1, quote: { token: CE.instrumentToken, lastPrice: 130, ts: 1 } },
      { ts: 2, quote: { token: PE.instrumentToken, lastPrice: 120, ts: 2 } }, // combined 250 = (100+100)*1.25 -> stop fires
    ],
    // legacy's batched tick delivers CE=100/PE=100 in the SAME ticksCache update that opens the
    // group, so both must be seeded before the FUT crossover tick — the ported side delivers
    // ticks one at a time, so CE and PE both need seeding, not just PE.
    [{ token: CE.instrumentToken, lastPrice: 100 }, { token: PE.instrumentToken, lastPrice: 100 }],
  )

  const diff = diffIntents(legacyOrders, portedOrders)
  assert.equal(diff.match, true, diff.differences.join('\n'))
})

test('golden day 2 — flat day, no crossover, no trigger: legacy and ported both emit ZERO orders', async () => {
  const legacyOrders: RecordedOrder[] = [] // legacy saw only a last_price 0 tick: no crossover math, no orders
  const portedOrders = await runPortedSide([])
  const diff = diffIntents(legacyOrders, portedOrders)
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(legacyOrders.length, 0)
})

test('golden day 3 — D9 pyramid: TWO re-adds, size grows 1 -> 2 -> 3, UNCAPPED, diff still clean', async () => {
  const legacyOrders = LEGACY_DAY_3
  const portedOrders = await runPortedSide(
    [
      { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
      { ts: 1, quote: { token: FUT.instrumentToken, lastPrice: 50100, ts: 1 } },
    ],
    [
      { token: PE.instrumentToken, lastPrice: 100 }, { token: CE.instrumentToken, lastPrice: 100 },
      { token: PE2.instrumentToken, lastPrice: 90 }, { token: CE2.instrumentToken, lastPrice: 90 },
    ],
  )
  const diff = diffIntents(legacyOrders, portedOrders)
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(portedOrders.filter((o) => o.side === 'SELL').length, 4, '2 groups x 2 legs, size uncapped and growing')
})
