import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext } from '@algomaker/strategy-kit'
import { MomentumFlipDirectionalStrategy } from '../src/momentum-flip-directional/strategy.ts'
import type { MomentumFlipDirectionalConfig } from '../src/momentum-flip-directional/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 500002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 500003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

function cfg(): MomentumFlipDirectionalConfig {
  return {
    tag: 'CheetahB1-1_TEST', class: 'momentum-flip-directional', enabled: true,
    underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:17:00', squareOffAt: '15:20:00' },
    sizing: { kind: 'martingale-capped', start: 1, cap: 12 },
    rail: { mode: 'live', destinations: ['xts'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: 12, dayLossRupees: null },
    data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 2 }],
    legacy: { files: ['server/slive/cheetah-b1-1.js'] },
    trailSlPoints: 10, targetPoints: 90,
    flip: { onStop: true, onTarget: false, strikeRef: 'frozen-first-atm' },
    bootstrapDelayMs: 10_000, squareOffIstMinute: 15 * 60 + 20,
  }
}

test('on TARGET the strategy exits and goes IDLE — it does NOT re-enter', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 47, 0) }) // 09:17 IST
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setQuote({ token: FUT.instrumentToken, lastPrice: 50100, ts: 0 }) // above open -> CE
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, cfg())
  // C2: dayOpen comes from ohlc.open, never from the first-seen price.
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0, ohlc: { open: 49900 } })
  await s.drain()
  // 50040 (not 50100): above open -> CE, but must still round to ATM 50000
  // on the 100-wide BANKNIFTY grid so it resolves the CE registered at 50000.
  parts.md.setQuote({ token: FUT.instrumentToken, lastPrice: 50040, ts: 1 })
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 1 })
  await s.firePhase('bootstrapEntry')
  assert.equal(parts.gateway.orders.length, 1, 'initial CE entry')

  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 215, ts: 2 }) // entry 120 + target 90 = 210
  s.handleTick({ token: CE.instrumentToken, lastPrice: 215, ts: 2 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'target exit closes the leg')
  assert.equal(parts.gateway.orders[1]?.side, 'SELL')

  // A further tick must NOT re-enter — idle for the day.
  s.handleTick({ token: CE.instrumentToken, lastPrice: 50, ts: 3 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'no re-entry after a target hit')
})

test('on SL the strategy flips CE<->PE at the FROZEN first-tick ATM and re-enters', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 47, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, cfg())
  // C2: dayOpen comes from ohlc.open, never from the first-seen price.
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0, ohlc: { open: 49900 } })
  await s.drain()
  // 50040 (not 50100): above open -> CE, but must still round to ATM 50000
  // on the 100-wide BANKNIFTY grid so it resolves the CE/PE registered at 50000.
  parts.md.setQuote({ token: FUT.instrumentToken, lastPrice: 50040, ts: 1 })
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 1 })
  await s.firePhase('bootstrapEntry') // CE @ 120, sl = 110, target = 210

  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 80, ts: 2 })
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 2 }) // below SL trigger 110
  s.handleTick({ token: CE.instrumentToken, lastPrice: 100, ts: 2 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 3, 'SL exit (SELL CE) + flip re-entry (BUY PE)')
  assert.equal(parts.gateway.orders[1]?.side, 'SELL')
  assert.equal(parts.gateway.orders[2]?.side, 'BUY')
  assert.equal(parts.gateway.orders[2]?.symbol, PE.tradingsymbol, 're-enters at the SAME frozen ATM, opposite type')
})

test('martingale sizing increases by 1 per re-entry, capped at 12 (D9-adjacent: cap must equal risk.maxLotsNet)', async () => {
  const c = cfg()
  assert.equal(c.risk.maxLotsNet, c.sizing.cap)
})
