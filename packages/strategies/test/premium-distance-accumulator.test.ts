import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext } from '@algomaker/strategy-kit'
import { PremiumDistanceAccumulatorStrategy } from '../src/premium-distance-accumulator/strategy.ts'
import type { PremiumDistanceAccumulatorConfig } from '../src/premium-distance-accumulator/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 500002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 500003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

function cfg(): PremiumDistanceAccumulatorConfig {
  return {
    tag: 'Eagle_S-1_TEST', class: 'premium-distance-accumulator', enabled: true,
    underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:24:00' },
    sizing: { kind: 'flat', lots: 1 },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: null, dayLossRupees: null },
    data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 6 }],
    legacy: { files: ['server/slive/eagle-s-1.js'] },
    premiumFloor: 20,
    stopPolicy: 'none', // D9, mandatory
    squareOffIstMinute: 15 * 60 + 24,
  }
}

test('D9: no per-leg stop exists anywhere — a wildly adverse tick never closes a leg', async () => {
  const parts = makeTestContext()
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, cfg())
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'initial straddle')

  // A large adverse move — a per-leg stop class would close a leg here. This one must not.
  s.handleTick({ token: CE.instrumentToken, lastPrice: 900, ts: 1 })
  await s.drain()
  assert.equal(parts.gateway.orders.filter((o) => o.side === 'BUY').length, 0, 'no BUY-to-close order exists at all')
})

test('squareOff is the ONLY exit path: it flattens every open leg', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, cfg())
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  await s.firePhase('squareOff')
  const closes = parts.gateway.orders.filter((o) => o.side === 'BUY')
  assert.equal(closes.length, 2, 'both legs flattened, and ONLY at squareOff')
})
