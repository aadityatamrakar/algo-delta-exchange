import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../../src/premium-leg-book/strategy.ts'
import { LION_S25_2 } from '../../src/premium-leg-book/configs/lion-s25.ts'

/**
 * The order sequence the legacy `archive/server/slive/lion-s25-2.js` emitted for the golden day below
 * (entry batch FUT 50010 / CE 100 / PE 100, its 5 s + 5 s bootstrap, then CE 130, then PE 130),
 * recorded on 3 Nov 2026 just before the archive was deleted. The ported strategy must still match it.
 */
const LEGACY_GOLDEN_DAY: readonly RecordedOrder[] = [
  { symbol: 'BANKNIFTY50000CE', side: 'SELL', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50000PE', side: 'SELL', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50000CE', side: 'BUY', lots: 1, orderType: 'MARKET' },
  { symbol: 'BANKNIFTY50000PE', side: 'BUY', lots: 1, orderType: 'MARKET' },
]

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

test('golden day — ONLY the stopped leg exits, the other stays open (per-leg, not combined)', async () => {
  const legacyOrders = LEGACY_GOLDEN_DAY

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  // legacy's forced entry read CE=100/PE=100 out of ticksCache at bootstrap end (both seeded from
  // the SAME batch above) — replay() delivers ticks one at a time, so both legs' quotes must be
  // seeded before the FUT crossover tick, or #openGroup bails out entirely (ceQ/peQ still null).
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, LION_S25_2)
  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50010, ts: 0 } },
    { ts: 1, quote: { token: CE.instrumentToken, lastPrice: 130, ts: 1 } },
    { ts: 2, quote: { token: PE.instrumentToken, lastPrice: 130, ts: 2 } },
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  // C3: BOTH legs must independently stop — CE's stop must not orphan PE's own trigger.
  const buys = res.orders.filter((o) => o.side === 'BUY')
  assert.equal(buys.length, 2, 'both legs stop on their OWN trigger, independently')
  assert.equal(buys[0]?.symbol, CE.tradingsymbol)
  assert.equal(buys[1]?.symbol, PE.tradingsymbol)
})

test('squareOff flattens every leg still open, per leg — a leg whose sibling already stopped is not skipped', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, LION_S25_2)
  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50010, ts: 0 } },
    { ts: 1, quote: { token: CE.instrumentToken, lastPrice: 130, ts: 1 } }, // CE stops; PE stays open
  ]
  await replay(s, parts, ticks)
  await s.firePhase('squareOff')
  const buys = parts.gateway.orders.filter((o) => o.side === 'BUY')
  // C3: without the fix, the group's single status flag flips to 'CLOSED' the moment CE
  // stops, so squareOff (which only visits ACTIVE groups) would skip the group entirely and
  // never flatten the still-open PE leg — a naked short left open indefinitely.
  assert.equal(buys.length, 2, 'CE from its own stop, PE from squareOff — neither left open')
  assert.equal(buys.filter((o) => o.symbol === CE.tradingsymbol).length, 1)
  assert.equal(buys.filter((o) => o.symbol === PE.tradingsymbol).length, 1)
})
