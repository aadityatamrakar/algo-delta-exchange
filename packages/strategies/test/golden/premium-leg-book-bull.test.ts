import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../../src/premium-leg-book/strategy.ts'
import { BULL_S_1 } from '../../src/premium-leg-book/configs/bull-s.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'archive', 'server', 'slive')

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE2 = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 999004, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
// bull-s-1.js's sendOrder() always computes `ce_s = atm + farOtm` AND `pe_s = atm - farOtm` off the
// SAME atm, with farOtm=0 (D7 — otmSelector faked to 0), so a group's CE and PE legs always share
// the SAME strike as the atm that opened them. For a second group at atm=50100, that leg is
// 50100PE, not 49900PE — this fixture must match that or the legacy run throws on an undefined
// `currentExpiryOptions['50100PE']` lookup.
const PE2 = { tradingsymbol: 'BANKNIFTY50100PE', instrumentToken: 999005, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS_FIXTURE = {
  '50000CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50000PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50100CE': { instrument_token: CE2.instrumentToken, tradingsymbol: CE2.tradingsymbol, strike: 50100, lot_size: 35 },
  '50100PE': { instrument_token: PE2.instrumentToken, tradingsymbol: PE2.tradingsymbol, strike: 50100, lot_size: 35 },
};

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

async function runLegacySide(ticks: { instrument_token: number; last_price: number }[][]): Promise<RecordedOrder[]> {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'bull-s-1.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0),
  })
  for (const batch of ticks) await run.tick(batch)
  run.stop()
  return toRecorded(run.orders)
}

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

test('golden day 1 — entry + combined-stop: legacy and ported emit the SAME order sequence', async () => {
  const legacyOrders = await runLegacySide([
    [{ instrument_token: FUT.instrumentToken, last_price: 50000 }, { instrument_token: CE.instrumentToken, last_price: 100 }, { instrument_token: PE.instrumentToken, last_price: 100 }],
    [{ instrument_token: CE.instrumentToken, last_price: 130 }, { instrument_token: PE.instrumentToken, last_price: 120 }], // combined 250 = (100+100)*1.25 -> stop fires
  ])
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')

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
  const legacyOrders = await runLegacySide([
    [{ instrument_token: FUT.instrumentToken, last_price: 0 }], // last_price 0: no real tick yet, no crossover math possible
  ])
  const portedOrders = await runPortedSide([])
  const diff = diffIntents(legacyOrders, portedOrders)
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(legacyOrders.length, 0)
})

test('golden day 3 — D9 pyramid: TWO re-adds, size grows 1 -> 2 -> 3, UNCAPPED, diff still clean', async () => {
  const legacyOrders = await runLegacySide([
    [{ instrument_token: FUT.instrumentToken, last_price: 50000 }, { instrument_token: CE.instrumentToken, last_price: 100 }, { instrument_token: PE.instrumentToken, last_price: 100 }], // group 1 @ 50000, size 1
    [{ instrument_token: FUT.instrumentToken, last_price: 50100 }, { instrument_token: CE2.instrumentToken, last_price: 90 }, { instrument_token: PE2.instrumentToken, last_price: 90 }], // group 2 @ 50100, size 2
  ])
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
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
