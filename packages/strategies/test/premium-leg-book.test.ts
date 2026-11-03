import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, type ReplayTick } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../src/premium-leg-book/strategy.ts'
import type { PremiumLegBookConfig } from '../src/premium-leg-book/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 500002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 500003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const cfg: PremiumLegBookConfig = {
  tag: 'Bull_S-1_TEST', class: 'premium-leg-book', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'pyramid-up', start: 1, step: 1, cap: null }, // D9: uncapped
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: null, dayLossRupees: null }, // D9: null is valid
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 4 }],
  legacy: { files: ['server/slive/bull-s-1.js'] },
  legs: [{ type: 'CE', side: 'SELL' }, { type: 'PE', side: 'SELL' }],
  stop: { scope: 'combined', multiplier: 1.25 },
  reentry: 'paired',
  squareOffIstMinute: 15 * 60 + 20,
}

test('opens a straddle on ATM crossover and closes it when the combined stop fires', async () => {
  const parts = makeTestContext()
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, cfg)

  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } }, // first tick: 0 -> 50000 is a crossover
  ]
  const res1 = await replay(s, parts, ticks)
  assert.equal(res1.orders.length, 2, 'straddle opens: 1 SELL CE + 1 SELL PE')
  assert.equal(res1.orders[0]?.side, 'SELL')
  assert.equal(res1.orders[1]?.side, 'SELL')

  // Combined premium rises to 250 -> trigger is (100+100)*1.25 = 250 -> fires.
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 130, ts: 1 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 120, ts: 1 })
  s.handleTick({ token: CE.instrumentToken, lastPrice: 130, ts: 1 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 4, 'stop closes both legs: +1 BUY PE + 1 BUY CE')
  assert.equal(parts.gateway.orders[2]?.side, 'BUY')
  assert.equal(parts.gateway.orders[3]?.side, 'BUY')
})

test('D9: pyramid-up with cap:null grows past any lot count without being blocked', async () => {
  const parts = makeTestContext()
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, cfg)
  await s.start()
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'D9: no risk.maxLotsNet gate blocks the first entry despite null')
})
