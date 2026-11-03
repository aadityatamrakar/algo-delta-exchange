import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import {
  makeTestContext, replay, diffIntents,
  type ReplayTick, type RecordedOrder, type SubmitRequest, type SubmitResult,
} from '@algomaker/strategy-kit'
import { PremiumDistanceAccumulatorStrategy } from '../../src/premium-distance-accumulator/strategy.ts'
import { EAGLE_S_1 } from '../../src/premium-distance-accumulator/configs/eagle-s.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'archive', 'server', 'slive')

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE2 = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 999004, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
// The future rallies through the add_pe trigger (trunc(50000+100)=50100), which re-selects the PE
// leg at floor(50150/100)*100 = 50100 — eagle-s-1.js's sendOrder('add_pe') then reads
// ticksCache[pe_option.instrument_token] for that NEW strike, so a 50100PE fixture (with a price
// already in ticksCache by the time the trigger fires) is required or the legacy run throws on an
// undefined lookup.
const PE2 = { tradingsymbol: 'BANKNIFTY50100PE', instrumentToken: 999005, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
// C1 regression fixture: EAGLE_S_1.data requests strikeWindow:8, so a 50200 pair is realistic
// chain content. Its PRESENCE is the point — the shipped fixture omitted it, which made the
// cascaded add_ce (triggered by the SAME add_pe fire, at trunc(50120-90)=50030, inside
// [50000,50120]) resolve to a null instrument and no-op, hiding C1 entirely. With 50200 CE
// listed and priced above premiumFloor, a buggy same-tick-visits-newly-pushed-triggers
// iterator self-feeds on this exact strike forever (identical futLtp/legLtp recomputed every
// pass), so the fixed strategy.ts (snapshot-before-iterating) is what keeps this test at 3
// orders instead of hanging.
const CE3 = { tradingsymbol: 'BANKNIFTY50200CE', instrumentToken: 999006, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE3 = { tradingsymbol: 'BANKNIFTY50200PE', instrumentToken: 999007, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS_FIXTURE = {
  '50000CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50000PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50100CE': { instrument_token: CE2.instrumentToken, tradingsymbol: CE2.tradingsymbol, strike: 50100, lot_size: 35 },
  '50100PE': { instrument_token: PE2.instrumentToken, tradingsymbol: PE2.tradingsymbol, strike: 50100, lot_size: 35 },
  '50200CE': { instrument_token: CE3.instrumentToken, tradingsymbol: CE3.tradingsymbol, strike: 50200, lot_size: 35 },
  '50200PE': { instrument_token: PE3.instrumentToken, tradingsymbol: PE3.tradingsymbol, strike: 50200, lot_size: 35 },
};

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

test('golden day — multi-leg accumulation: legacy and ported emit the SAME order sequence, D9 stopless', { timeout: 5_000 }, async () => {
  // The 5s timeout is a deliberate safety net, not a tuning knob: C1's actual bug is a
  // same-tick infinite cascade (see strategy.ts's #onTick comment). If the
  // snapshot-before-iterating fix ever regresses, THIS test — which now includes the
  // 50200 strike the cascade needs to keep resolving to a real instrument — will hang
  // rather than silently pass, and this timeout converts that hang into a clean failure
  // instead of wedging the whole suite.
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'eagle-s-1.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0),
  })
  // Initial straddle at the crossover.
  await run.tick([
    { instrument_token: FUT.instrumentToken, last_price: 50000 },
    { instrument_token: CE.instrumentToken, last_price: 100 },
    { instrument_token: PE.instrumentToken, last_price: 100 },
  ])
  // Future rallies through the ce-add trigger (trunc(50000 - 100) = 49900 is
  // already crossed on entry; use a later trigger — trunc(50000 + 100) = 50100,
  // the add_pe trigger — by moving price up through it). 50120 (not 50150) is
  // deliberate: eagle-s-1.js's sendOrder() unconditionally recomputes
  // `atm = round(bn_quote.last_price/100)*100` and looks up a CE+PE pair at
  // THAT atm before branching on `type` — 50150 rounds to 50200 (needing yet
  // another strike pair defined purely to avoid a crash), while 50120 rounds
  // to 50100, reusing CE2/PE2. The re-selected PE leg's price (50100PE) and
  // the unconditionally-read (but otherwise unused) CE leg's price (50100CE)
  // must already be in ticksCache when the trigger fires, so both ride in the
  // SAME batch as the future tick.
  await run.tick([
    { instrument_token: FUT.instrumentToken, last_price: 50120 },
    { instrument_token: PE2.instrumentToken, last_price: 90 },
    { instrument_token: CE2.instrumentToken, last_price: 90 },
  ])
  run.stop()
  const legacyOrders = toRecorded(run.orders)
  assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', CE2)
  parts.md.setOption('BANKNIFTY', 50100, 'PE', PE2)
  // C1: strike 50200 must resolve to a REAL instrument, or the cascade the bug produces
  // dead-ends at a null lookup and no-ops — which is exactly how the original fixture hid
  // this bug. Its presence is what makes this fixture a real regression guard rather than
  // a vacuous pass.
  parts.md.setOption('BANKNIFTY', 50200, 'CE', CE3)
  parts.md.setOption('BANKNIFTY', 50200, 'PE', PE3)
  // legacy's batched tick delivers CE=100/PE=100 in the SAME ticksCache update that opens the
  // straddle, so both must be seeded before the FUT crossover tick — replay() delivers ticks one
  // at a time, so CE needs seeding too, not just PE (#enterInitial bails out entirely if either
  // leg's quote is still null).
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE2.instrumentToken, lastPrice: 90, ts: 0 })
  // Priced above premiumFloor (20) so a buggy same-tick cascade would successfully re-sell
  // this leg (and keep pushing new triggers) rather than being pruned by the floor check —
  // the floor check alone must NOT be what keeps this test finite; the fix must be.
  parts.md.setQuote({ token: CE3.instrumentToken, lastPrice: 90, ts: 0 })
  parts.md.setQuote({ token: PE3.instrumentToken, lastPrice: 90, ts: 0 })
  // C1 regression guard. IMPORTANT: this is not a style choice — a live re-introduction of
  // the same-tick cascade bug is a SYNCHRONOUS microtask storm (every #fireTrigger recurses
  // through an already-resolved submit() promise), which starves the event loop's timer
  // phase. node:test's own per-test `timeout` option cannot interrupt that: it fires from a
  // macrotask timer that never gets a turn, so a real regression here would hang the whole
  // `node --test` process indefinitely rather than failing this one test (verified: reverting
  // the strategy.ts fix and running this file wedged the process; it required an OS-level
  // kill, not a timeout). Capping submit() forces the runaway loop to throw instead of spin —
  // StrategyBase's #guard swallows that throw and logs it, which is enough to unwind the
  // cascade, and the order-count assertion below then fails cleanly with a clear cause.
  const boundedSubmit = parts.gateway.submit.bind(parts.gateway)
  parts.gateway.submit = async (req: SubmitRequest): Promise<SubmitResult> => {
    if (parts.gateway.orders.length >= 20) {
      throw new Error(
        `C1 regression guard: order count reached 20 without the cascade terminating — the ` +
          `snapshot-before-iterating fix in strategy.ts's onTick has likely regressed. Last ` +
          `attempted order: ${req.side} ${req.instrument.tradingsymbol}`,
      )
    }
    return boundedSubmit(req)
  }
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, EAGLE_S_1)
  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
    { ts: 1, quote: { token: FUT.instrumentToken, lastPrice: 50120, ts: 1 } },
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  // C1's actual failure mode is COUNT, not content: the unbounded cascade keeps
  // re-selling 50200CE. Assert the count explicitly, not just via diffIntents, so a
  // regression reads unambiguously as "order count matches legacy" in the failure output.
  assert.equal(res.orders.length, legacyOrders.length, 'ported order count must match legacy exactly (3): 2 initial + 1 add_pe, with the 50200-strike add_ce deferred to a tick that never comes')
  assert.equal(res.orders.length, 3)
  // D9: no BUY order exists anywhere in EITHER sequence — this is the class
  // proof that stopPolicy:'none' is not merely configured but structurally true.
  assert.equal(legacyOrders.some((o) => o.side === 'BUY'), false)
  assert.equal(res.orders.some((o) => o.side === 'BUY'), false)
})

test('squareOff is eagle-s-1\'s ONLY exit — legacy has no equivalent call to compare against, so this is ported-side only, explicitly labelled', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 9, 48, 0) }) // 15:18 IST
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  // Both legs' quotes must be seeded — #enterInitial reads both via ctx.md.quote()
  // and bails out entirely (no submit at all) if either is still null.
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, EAGLE_S_1)
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  await s.firePhase('squareOff')
  const closes = parts.gateway.orders.filter((o) => o.side === 'BUY')
  assert.equal(closes.length, 2, 'both legs flattened at the central 15:24 square-off, eagle\'s only exit')
})
