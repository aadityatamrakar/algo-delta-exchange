import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../../src/premium-leg-book/strategy.ts'
import { LION_S25_2 } from '../../src/premium-leg-book/configs/lion-s25.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'archive', 'server', 'slive')

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS_FIXTURE = {
  '50000CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50000PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 50000, lot_size: 35 },
};

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

test('golden day — ONLY the stopped leg exits, the other stays open (per-leg, not combined)', async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'lion-s25-2.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0),
  })
  // Seed ticksCache with the entry batch BEFORE advancing the bootstrap timers: the nested
  // setTimeout at t=10s calls `placeTrade(true)` directly (a FORCED entry, not gated on a
  // subsequent tick) and reads ce_ltp/pe_ltp straight out of ticksCache at that instant — so the
  // entry premiums must already be there, or lion-s25-2.js throws on an undefined lookup at t=5s
  // reading `ticksCache[futureToken].last_price` before any tick has ever arrived.
  // 50010, not 50000: landing EXACTLY on the strike grid makes lastQuote === new_ATM_Strike
  // after entry, and lion-s25-2.js's isCrossover check (`>=` AND `<=` against the SAME grid
  // value) then re-fires on EVERY later tick regardless of token — including the CE/PE ticks
  // below — triggering an unrelated RE-ENTRY cascade (a real legacy quirk, but a separate one
  // from C3 — see I5) that would conflate two different findings into one fixture. Landing a
  // few points off the grid keeps the crossover a one-time event, as it is on every other
  // golden day in this suite, isolating C3's actual bug: the orphaned surviving leg.
  await run.tick([
    { instrument_token: FUT.instrumentToken, last_price: 50010 },
    { instrument_token: CE.instrumentToken, last_price: 100 },
    { instrument_token: PE.instrumentToken, last_price: 100 },
  ])
  await run.advance(11_000) // lion-s25-2.js's own 5s+5s bootstrap sequence; startTrade=true, forced entry fires
  // CE alone crosses its OWN 1.25x trigger (125); PE stays well under its trigger.
  await run.tick([{ instrument_token: CE.instrumentToken, last_price: 130 }])
  // C3: extend PAST the point where CE alone has stopped, to where PE's OWN trigger (125)
  // is ALSO crossed. Legacy keeps CE and PE as two fully independent optionOrders entries
  // (lion-s25-2.js:143-160) — CE stopping never touches PE's own forEach entry, so PE's
  // stop fires on its own BUY here regardless of CE's fate. The shipped fixture stopped
  // exactly one tick short of this, at the point where C3's bug (one leg's stop marking the
  // WHOLE group closed) was invisible because nothing else was ever checked afterward.
  await run.tick([{ instrument_token: PE.instrumentToken, last_price: 130 }])
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  // legacy's forced entry reads CE=100/PE=100 out of ticksCache at bootstrap end (both seeded from
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
