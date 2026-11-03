import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { MomentumFlipDirectionalStrategy } from '../../src/momentum-flip-directional/strategy.ts'
import { CHEETAH_B1_1 } from '../../src/momentum-flip-directional/configs/cheetah-b1.ts'
import { assertValidMomentumFlipConfig } from '../../src/momentum-flip-directional/config.ts'

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

test('config guard: martingale-capped ALWAYS requires risk.maxLotsNet === sizing.cap', () => {
  assert.doesNotThrow(() => assertValidMomentumFlipConfig(CHEETAH_B1_1))
  const uncapped = { ...CHEETAH_B1_1, risk: { maxLotsNet: null, dayLossRupees: null } }
  assert.throws(() => assertValidMomentumFlipConfig(uncapped), /maxLotsNet/,
    'this is what keeps the cheetah-b1-2117 uncapped sibling out of the active config set by construction')
})

test('golden day — stop-flip re-entry: legacy and ported both flip CE->PE at the frozen ATM', async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'cheetah-b1-1.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 47, 0), // 09:17 IST
  })
  // cheetah-b1-1.js's setTimeout(placeTrade, 10000) is NOT gated on any subsequent tick — it fires
  // unconditionally at t=10s and reads straight out of ticksCache at that instant (its own
  // do-while/retry loop swallows a missing future price, but sendOrder()'s ce_ltp lookup is NOT
  // guarded — an ungated `ticksCache[ce_option.instrument_token].last_price` on a token that was
  // never ticked throws as an unhandled rejection). So the CE premium must already be in
  // ticksCache before the bootstrap timer fires, not delivered after.
  await run.tick([
    { instrument_token: FUT.instrumentToken, last_price: 50000, ohlc: { open: 49900 } },
    { instrument_token: CE.instrumentToken, last_price: 120 },
  ])
  await run.advance(10_000) // cheetah-b1-1.js's setTimeout(placeTrade, 10000)
  // Same reasoning applies to the stop-flip's re-entry: checkSL()'s SL branch calls
  // sendOrder(atm_index, 'PE') synchronously, which reads pe_ltp out of ticksCache immediately —
  // so PE's premium must ride in the SAME batch as the triggering CE tick.
  await run.tick([
    { instrument_token: CE.instrumentToken, last_price: 105 }, // below sl_trigger (120-10=110) -> SL, flips to PE
    { instrument_token: PE.instrumentToken, last_price: 80 },
  ])
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')

  // nowMs is deliberately 09:16 IST, NOT 09:17: bootstrapEntry's cron fires at exactly 09:17
  // (catch-up threshold 557), and StrategyBase.start()'s restart-catch-up treats a job whose
  // threshold has ALREADY arrived as due — since bootstrapEntry is not `replayable` (it places
  // the first order), catch-up marks it fired WITHOUT running it, which would silently no-op the
  // explicit firePhase('bootstrapEntry') call below. One minute earlier avoids that exact
  // boundary.
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, CHEETAH_B1_1)
  // C2 regression: NO synthetic 49900 priming tick. The ONLY tick the port ever sees is the
  // real 50000 print, carrying the real day-open (49900) in `ohlc.open`, exactly like the
  // single tick fed to the legacy side above. Priming with a separate 49900 tick first (the
  // shipped fixture's approach) let #dayOpen default to "first tick observed" and still land
  // on the right answer BY COINCIDENCE — it could never have caught #dayOpen being set from
  // lastPrice instead of ohlc.open, including the degenerate case where dayOpen ends up
  // exactly equal to the first real tick (which silently forces every entry to PE).
  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0, ohlc: { open: 49900 } } },
  ]
  await replay(s, parts, ticks)
  // #enterInitial() reads BOTH the future's AND the CE leg's quote straight off ctx.md — the
  // future's is already there via replay() above, but firePhase() bypasses replay()'s per-tick
  // md.setQuote(), so CE's must be seeded explicitly before firing the phase, or #openLeg bails
  // out silently (quote still null) and NOTHING is submitted.
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 2 })
  await s.firePhase('bootstrapEntry')
  // Likewise for the flip's re-entry: #openLeg('PE', ...) needs PE's quote seeded before the
  // triggering tick, since handleTick() below doesn't go through replay() either.
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 80, ts: 3 })
  s.handleTick({ token: CE.instrumentToken, lastPrice: 105, ts: 3 })
  await s.drain()

  // replay()'s returned `.orders` is the SAME array reference as parts.gateway.orders (it doesn't
  // copy), so every order emitted here — via replay(), firePhase(), and handleTick() alike — is
  // already in parts.gateway.orders exactly once; reading both would double-count each entry.
  const diff = diffIntents(legacyOrders, [...parts.gateway.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
})

test('sizing: quantity increases by 1 per re-entry, hard-capped at 12 — never past it', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 47, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, CHEETAH_B1_1)
  // handleTick() called directly (bypassing replay()) never writes to ctx.md — #enterInitial()
  // reads the future's quote from ctx.md, so it must be seeded explicitly too, not just CE's.
  // C2: the day-open tick must carry ohlc.open, not rely on a first-seen-price default.
  parts.md.setQuote({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0, ohlc: { open: 49900 } })
  await s.drain()
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 1 })
  await s.firePhase('bootstrapEntry')
  assert.equal(parts.gateway.submitted[0]?.req.lots, 1, 'first entry is 1 lot')

  // I4: the shipped test only asserted the FIRST entry's lots and left a comment describing
  // what it would have tested. Actually drive 13 consecutive stop-flips (CE<->PE, alternating
  // entry premiums 120/80 each time so the same trailSlPoints=10 trigger price works on both
  // sides) and assert the full lots sequence: 1,2,...,12, then PINNED at 12 — never 13.
  let currentToken = CE.instrumentToken
  let nextToken = PE.instrumentToken
  let nextEntryPremium = 80
  for (let i = 0; i < 13; i++) {
    parts.md.setQuote({ token: nextToken, lastPrice: nextEntryPremium, ts: 2 + i })
    const currentEntryPremium = nextEntryPremium === 80 ? 120 : 80
    const triggerPrice = currentEntryPremium - CHEETAH_B1_1.trailSlPoints - 5 // well past slTrigger
    s.handleTick({ token: currentToken, lastPrice: triggerPrice, ts: 2 + i })
    await s.drain()
    ;[currentToken, nextToken] = [nextToken, currentToken]
    nextEntryPremium = nextEntryPremium === 80 ? 120 : 80
  }

  const buyLots = parts.gateway.submitted.filter((o) => o.req.side === 'BUY').map((o) => o.req.lots)
  assert.equal(buyLots.length, 14, '1 initial entry + 13 flips')
  for (const lots of buyLots) assert.ok(lots <= 12, `lots must never exceed the cap: got ${lots}`)
  assert.deepEqual(buyLots, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12],
    'quantity climbs by 1 per flip then is PINNED at 12 for the last two flips — never reaches 13')
})
