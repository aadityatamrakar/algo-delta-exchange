/**
 * Day-end square-off and mid-session restart recovery, for all four classes.
 *
 * THE RULE THESE TESTS EXIST TO ENFORCE: a restart must not DUPLICATE a
 * position, and must not ABANDON one. Both directions are checked explicitly,
 * because the two failures are independent and neither is loud:
 *
 *   - restart holding a position -> it is recovered, its exit paths still work,
 *     and no second entry happens
 *   - restart after the day's trade already happened and closed -> no re-entry
 *
 * Every test simulates a REAL process restart via `restart()` below: a brand-new
 * context, new gateway, new market-data cache, new clock — sharing ONLY the
 * durable `StateStore`, which is exactly what a rebooted runner gets from
 * `MongoStateStore`. Reusing the same context or the same strategy instance
 * would prove nothing, because the in-memory fields would still be populated;
 * that is precisely how this defect survived, and why the only restart test in
 * the tree (`apps/runner/test/runner.test.ts`) passes against a FIXTURE strategy
 * implementing hooks no production strategy had.
 *
 * These are deliberately NOT golden tests. Nothing here is diffed against a
 * legacy file, because the legacy system structurally could not do any of it —
 * its own conventions admit an open position cannot be restored across a pm2
 * restart. There is no legacy behaviour to be faithful to; the reference is the
 * rule above.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, type Candle, type TestContextParts } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../src/range-breakout-directional/strategy.ts'
import { ORB_SCALP_BN } from '../src/range-breakout-directional/configs/orb-scalp.ts'
import { MomentumFlipDirectionalStrategy } from '../src/momentum-flip-directional/strategy.ts'
import { CHEETAH_B1_1 } from '../src/momentum-flip-directional/configs/cheetah-b1.ts'
import { PremiumLegBookStrategy } from '../src/premium-leg-book/strategy.ts'
import { LION_S25_2 } from '../src/premium-leg-book/configs/lion-s25.ts'
import { PremiumDistanceAccumulatorStrategy } from '../src/premium-distance-accumulator/strategy.ts'
import { EAGLE_S_1 } from '../src/premium-distance-accumulator/configs/eagle-s.ts'
import { SESSION_STATE_KEY, loadSessionState, saveSessionState } from '../src/session-state.ts'

/**
 * A process restart. Everything is new except the durable store — the same
 * boundary a pm2 restart draws, and the reason `onRecover()` is the only route
 * back to the position.
 */
function restart(prev: TestContextParts, nowMs: number): TestContextParts {
  const next = makeTestContext({ tag: prev.ctx.tag, nowMs })
  return { ...next, state: prev.state, ctx: { ...next.ctx, state: prev.state } }
}

/** Epoch ms for an IST wall-clock time on Fri 2026-07-24. */
const ist = (h: number, m: number): number => Date.UTC(2026, 6, 24, h - 5, m - 30, 0)

const sides = (parts: TestContextParts): string[] =>
  parts.gateway.orders.map((o) => `${o.side} ${o.lots} ${o.symbol}`)

// ---------------------------------------------------------------- the store contract

test('session state is snapshotted BY VALUE — the store never aliases live strategy fields', async () => {
  const parts = makeTestContext({ tag: 'ALIAS', nowMs: ist(10, 0) })
  const live = { tradedSides: { CE: false, PE: false } }

  await saveSessionState(parts.ctx, live)
  live.tradedSides.CE = true // the strategy trades a side AFTER the write
  const readBack = await loadSessionState<typeof live>(parts.ctx)
  assert.equal(readBack?.tradedSides.CE, false,
    'a write must capture the value at the time of the write. Aliasing would make every restart test read state the process never actually persisted — a false green that is worse than no test, because Mongo does NOT alias and production would diverge from the suite')

  readBack!.tradedSides.PE = true // and the recovered copy is the strategy's own
  const readAgain = await loadSessionState<typeof live>(parts.ctx)
  assert.equal(readAgain?.tradedSides.PE, false,
    'reading must not hand out the stored object either — `#day.tradedSides[side] = true` would otherwise reach into the store behind saveSessionState\'s back')
})

// ---------------------------------------------------------------- RangeBreakoutDirectional

const RBD_SPOT = 260105
const RBD_CE = { tradingsymbol: 'BANKNIFTY50300CE', instrumentToken: 700003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

/** Six 09:15-09:45 bars: high 50200, low 49900 -> range 300, clears rangeFilterPts 250.
 *  `ts` is the bar's real IST open — `#formBand` keeps only TODAY's bars, as
 *  legacy's `historyData(today, today)` does, so epoch-0 bars form no band. */
const RBD_OPENING: Candle[] = [
  { ts: ist(9, 15), open: 50000, high: 50200, low: 49900, close: 50050 },
  { ts: ist(9, 20), open: 50050, high: 50120, low: 50000, close: 50080 },
  { ts: ist(9, 25), open: 50080, high: 50150, low: 50020, close: 50100 },
  { ts: ist(9, 30), open: 50100, high: 50160, low: 50040, close: 50120 },
  { ts: ist(9, 35), open: 50120, high: 50180, low: 50060, close: 50140 },
  { ts: ist(9, 40), open: 50140, high: 50190, low: 50080, close: 50160 },
]
/** Close 50280 clears rangeHigh 50200 * (1 + bufferPct 0.001) = 50250.2 -> BUY -> CE. */
const RBD_BREAKOUT: Candle = { ts: ist(9, 45), open: 50210, high: 50300, low: 50205, close: 50280 }

function seedRbd(parts: TestContextParts, cePremium: number): void {
  parts.md.setUnderlying('BANKNIFTY', RBD_SPOT, 100)
  parts.md.setOption('BANKNIFTY', 50300, 'CE', RBD_CE) // ATM of spot 50280 on a 100 grid
  parts.md.setCandles(RBD_SPOT, '5minute', [...RBD_OPENING, RBD_BREAKOUT])
  parts.md.setQuote({ token: RBD_SPOT, lastPrice: 50280, ts: 0 })
  parts.md.setQuote({ token: RBD_CE.instrumentToken, lastPrice: cePremium, ts: 0 })
}

/** Drive ORB_SCALP_BN to a live CE position entered at 09:50. */
async function rbdWithOpenPosition(): Promise<{
  parts: TestContextParts
  strategy: RangeBreakoutDirectionalStrategy
}> {
  const parts = makeTestContext({ tag: 'ORB_SCALP_BN', nowMs: ist(9, 35) })
  seedRbd(parts, 100)
  const strategy = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  await strategy.start()
  parts.clock.set(ist(9, 45))
  await strategy.fireJob('formBand')
  parts.clock.set(ist(9, 50))
  strategy.handleTick({ token: RBD_SPOT, lastPrice: 50280, ts: 0 })
  await strategy.drain()
  assert.deepEqual(sides(parts), ['BUY 1 BANKNIFTY50300CE'],
    'setup sanity: the pre-restart process must actually be holding an option')
  return { parts, strategy }
}

test('RBD: restart holding an option — recovered, not duplicated, and flattened by day end', async () => {
  const { parts: before } = await rbdWithOpenPosition()

  // 10:30: inside the 09:45 band, before the 14:00 deadline, and only 40 minutes
  // into the 90-minute time stop, so nothing fires on its own.
  const after = restart(before, ist(10, 30))
  seedRbd(after, 100)
  const s2 = new RangeBreakoutDirectionalStrategy(after.ctx, ORB_SCALP_BN)
  await s2.start()
  assert.equal(after.gateway.orders.length, 0,
    'start() must place nothing: formBand replays into an already-ready band, and squareOff is replayable:false so catch-up suppresses it')

  // A tick that WOULD be an entry signal on a flat book. Only the recovered
  // position stops it — the duplicate-position direction of the rule.
  after.md.setQuote({ token: RBD_SPOT, lastPrice: 50280, ts: 1 })
  s2.handleTick({ token: RBD_SPOT, lastPrice: 50280, ts: 1 })
  await s2.drain()
  assert.equal(after.gateway.orders.length, 0,
    'a recovered ACTIVE position must route the tick to the EXIT check, never back to entry')

  await s2.endDay('day end')
  assert.deepEqual(sides(after), ['SELL 1 BANKNIFTY50300CE'],
    'the day-end backstop must flatten the RECOVERED position — before onDayEnd existed this placed nothing at all')
  assert.equal(after.gateway.submitted[0]?.req.reducesExposure, true,
    'an exit must be marked reducesExposure so neither the risk gate nor the stale-feed gate can refuse it')
  assert.equal(await after.state.get(SESSION_STATE_KEY), null,
    'state is cleared once — and only once — the flatten is accepted')
})

test('RBD: the recovered position keeps its entry timestamp, so the 90-minute time stop still fires', async () => {
  const { parts: before } = await rbdWithOpenPosition() // entered 09:50

  const after = restart(before, ist(11, 30)) // 100 minutes later, past timeStopMinutes: 90
  seedRbd(after, 100)
  const s2 = new RangeBreakoutDirectionalStrategy(after.ctx, ORB_SCALP_BN)
  await s2.start()
  after.md.setQuote({ token: RBD_SPOT, lastPrice: 50280, ts: 1 })
  s2.handleTick({ token: RBD_SPOT, lastPrice: 50280, ts: 1 })
  await s2.drain()

  assert.deepEqual(sides(after), ['SELL 1 BANKNIFTY50300CE'],
    'entryTs must survive the restart: without it the time stop has no elapsed time to measure and the position runs unmanaged to EOD')
})

test('RBD: restart AFTER the day\'s trade opened and closed — no re-entry', async () => {
  const { parts: before, strategy } = await rbdWithOpenPosition()

  // Take the target on the ORIGINAL instance: entry 100 + targetPts 40 = 140.
  before.clock.set(ist(9, 55))
  before.md.setQuote({ token: RBD_CE.instrumentToken, lastPrice: 150, ts: 1 })
  strategy.handleTick({ token: RBD_CE.instrumentToken, lastPrice: 150, ts: 1 })
  await strategy.drain()
  assert.deepEqual(sides(before), ['BUY 1 BANKNIFTY50300CE', 'SELL 1 BANKNIFTY50300CE'],
    'setup sanity: the day\'s trade is closed at TARGET before the restart')

  const after = restart(before, ist(11, 0))
  seedRbd(after, 100)
  const s2 = new RangeBreakoutDirectionalStrategy(after.ctx, ORB_SCALP_BN)
  await s2.start()
  after.md.setQuote({ token: RBD_SPOT, lastPrice: 50280, ts: 2 })
  s2.handleTick({ token: RBD_SPOT, lastPrice: 50280, ts: 2 })
  await s2.drain()

  assert.deepEqual(sides(after), [],
    'stopForDay and tradedSides must come back: without them formBand replays, the band is ready again, and the SAME breakout candle opens a second position for the day')
})

test('RBD: a REFUSED day-end exit must not read back as a flat book', async () => {
  const { parts: before } = await rbdWithOpenPosition()

  const after = restart(before, ist(10, 30))
  seedRbd(after, 100)
  const s2 = new RangeBreakoutDirectionalStrategy(after.ctx, ORB_SCALP_BN)
  await s2.start()

  after.gateway.accept = false // the broker rejects everything
  await s2.endDay('day end')
  assert.equal(after.gateway.orders.length, 0, 'sanity: nothing reached the gateway')
  assert.notEqual(await after.state.get(SESSION_STATE_KEY), null,
    'the persisted position must SURVIVE a refused flatten — clearing it here is how a real open position ends up with nothing managing it and nobody knowing')
  assert.ok(after.logs.some((l) => l.level === 'error' && l.msg.includes('did not complete')),
    'and it is an ERROR, because a strategy that failed to flatten is a position somebody has to go and close by hand')

  // The next start recovers it and the exit works.
  const retry = restart(after, ist(10, 35))
  seedRbd(retry, 100)
  const s3 = new RangeBreakoutDirectionalStrategy(retry.ctx, ORB_SCALP_BN)
  await s3.start()
  await s3.endDay('day end')
  assert.deepEqual(sides(retry), ['SELL 1 BANKNIFTY50300CE'],
    'a refused exit leaves a retryable position, not an abandoned one')
})

test('RBD: state written on a different IST day is discarded, not adopted', async () => {
  const { parts: before } = await rbdWithOpenPosition()
  const stored = await before.state.get<{ sessionDay: string }>(SESSION_STATE_KEY)
  assert.ok(stored !== null, 'sanity: something was persisted')
  await before.state.set(SESSION_STATE_KEY, { ...stored, sessionDay: '2026-07-23' })

  const after = restart(before, ist(10, 30))
  seedRbd(after, 100)
  const s2 = new RangeBreakoutDirectionalStrategy(after.ctx, ORB_SCALP_BN)
  await s2.start()

  assert.ok(after.logs.some((l) => l.level === 'warn' && l.msg.includes('previous session')),
    'the stale record is dropped and logged loudly — a leftover record means yesterday\'s flatten did not complete, which an operator has to see')
  const rewritten = await after.state.get<{ sessionDay: string; value: { day: { tradedSides: Record<string, boolean> } } }>(SESSION_STATE_KEY)
  assert.equal(rewritten?.sessionDay, '2026-07-24',
    'what is on disk now is TODAY\'s record, written by the replayed formBand — not yesterday\'s')
  assert.deepEqual(rewritten?.value.day.tradedSides, { CE: false, PE: false },
    'and yesterday\'s once-per-day flags did not come with it')

  // Proof it was not adopted: the day really is fresh, so the breakout tick
  // opens a position instead of being blocked by yesterday's tradedSides.
  after.md.setQuote({ token: RBD_SPOT, lastPrice: 50280, ts: 1 })
  s2.handleTick({ token: RBD_SPOT, lastPrice: 50280, ts: 1 })
  await s2.drain()
  assert.deepEqual(sides(after), ['BUY 1 BANKNIFTY50300CE'])
})

// ---------------------------------------------------------------- MomentumFlipDirectional

const MF_FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const MF_CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const MF_PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

function seedMf(parts: TestContextParts, cePremium: number, pePremium: number): void {
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', MF_FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', MF_CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', MF_PE)
  parts.md.setQuote({ token: MF_FUT.instrumentToken, lastPrice: 50000, ts: 0, ohlc: { open: 49900 } })
  parts.md.setQuote({ token: MF_CE.instrumentToken, lastPrice: cePremium, ts: 0 })
  parts.md.setQuote({ token: MF_PE.instrumentToken, lastPrice: pePremium, ts: 0 })
}

/**
 * Drive CheetahB1-1 to: CE entry at 1 lot -> stop-flip -> PE at 2 lots, with the
 * martingale ladder now standing at 3. The context is left holding the PE leg.
 */
async function mfAfterOneFlip(): Promise<{
  parts: TestContextParts
  strategy: MomentumFlipDirectionalStrategy
}> {
  // 09:16, one minute before bootstrapEntry's 09:17 cron, so start()'s catch-up
  // does not mark the non-replayable entry job as already fired.
  const parts = makeTestContext({ tag: 'CheetahB1-1', nowMs: ist(9, 16) })
  seedMf(parts, 120, 80)
  const strategy = new MomentumFlipDirectionalStrategy(parts.ctx, CHEETAH_B1_1)
  await strategy.start()
  strategy.handleTick({ token: MF_FUT.instrumentToken, lastPrice: 50000, ts: 0, ohlc: { open: 49900 } })
  await strategy.drain()
  await strategy.fireJob('bootstrapEntry') // 50000 > open 49900 -> CE, 1 lot, sl = 120 - 10 = 110
  strategy.handleTick({ token: MF_CE.instrumentToken, lastPrice: 105, ts: 1 }) // < sl -> flip to PE at 2 lots
  await strategy.drain()
  assert.deepEqual(sides(parts),
    ['BUY 1 BANKNIFTY50000CE', 'SELL 1 BANKNIFTY50000CE', 'BUY 2 BANKNIFTY50000PE'],
    'setup sanity: one stop-flip, martingale stepped 1 -> 2')
  return { parts, strategy }
}

test('MF: restart holding the flipped leg — position, frozen ATM and the martingale ladder all come back', async () => {
  const { parts: before } = await mfAfterOneFlip()

  const after = restart(before, ist(12, 0))
  seedMf(after, 120, 80)
  const s2 = new MomentumFlipDirectionalStrategy(after.ctx, CHEETAH_B1_1)
  await s2.start()
  assert.equal(after.gateway.orders.length, 0,
    'bootstrapEntry is replayable:false, so catch-up suppresses it rather than opening a second position')

  // Stop the RECOVERED PE leg: entry 80, sl = 70.
  after.md.setQuote({ token: MF_PE.instrumentToken, lastPrice: 65, ts: 2 })
  s2.handleTick({ token: MF_PE.instrumentToken, lastPrice: 65, ts: 2 })
  await s2.drain()
  assert.deepEqual(sides(after), ['SELL 2 BANKNIFTY50000PE', 'BUY 3 BANKNIFTY50000CE'],
    'SELL 2 proves the position and its size survived; BUY 3 proves the martingale ladder did (a reset would re-enter at sizing.start = 1); the 50000 strike proves the frozen ATM did')

  await s2.endDay('day end')
  assert.deepEqual(sides(after).slice(-1), ['SELL 3 BANKNIFTY50000CE'],
    'day end flattens and STOPS — it must not run the stop-flip path and open yet another leg')
  assert.equal(await after.state.get(SESSION_STATE_KEY), null)
})

test('MF: squareOff flattens without re-entering — it used to run the stop-FLIP path and open a fresh leg at 15:20', async () => {
  const { parts, strategy } = await mfAfterOneFlip()
  const placedBefore = parts.gateway.orders.length
  await strategy.fireJob('squareOff')

  assert.deepEqual(sides(parts).slice(placedBefore), ['SELL 2 BANKNIFTY50000PE'],
    'exactly one order: the flatten. A trailing BUY is the old #exit(\'SL\') behaviour opening a brand new position ten minutes before the close')
})

// ---------------------------------------------------------------- PremiumLegBook

const PLB_FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 800001, lotSize: 15, tickSize: 0.05, exchange: 'NFO' }
const PLB_CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 800002, lotSize: 15, tickSize: 0.05, exchange: 'NFO' }
const PLB_PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 800003, lotSize: 15, tickSize: 0.05, exchange: 'NFO' }

function seedPlb(parts: TestContextParts, cePremium: number, pePremium: number): void {
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', PLB_FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', PLB_CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PLB_PE)
  parts.md.setQuote({ token: PLB_CE.instrumentToken, lastPrice: cePremium, ts: 0 })
  parts.md.setQuote({ token: PLB_PE.instrumentToken, lastPrice: pePremium, ts: 0 })
}

async function plbWithOpenGroup(): Promise<TestContextParts> {
  const parts = makeTestContext({ tag: 'Lion_S25_2', nowMs: ist(10, 0) })
  seedPlb(parts, 100, 90)
  const s = new PremiumLegBookStrategy(parts.ctx, LION_S25_2)
  await s.start()
  s.handleTick({ token: PLB_FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  assert.deepEqual(sides(parts), ['SELL 1 BANKNIFTY50000CE', 'SELL 1 BANKNIFTY50000PE'],
    'setup sanity: one short strangle open at the 50000 ATM')
  return parts
}

test('PLB: restart holding a short group — stop triggers survive, the ATM gate blocks a duplicate, day end flattens the rest', async () => {
  const before = await plbWithOpenGroup()

  const after = restart(before, ist(12, 0))
  seedPlb(after, 100, 90)
  const s2 = new PremiumLegBookStrategy(after.ctx, LION_S25_2)
  await s2.start()
  assert.equal(after.gateway.orders.length, 0)

  // A tick straight through the SAME ATM. Both the re-baseline and the recovered
  // `openAtms` have to hold for this to place nothing: a `#lastPrice` of 0 — what
  // onDayStart leaves behind — makes isCrossover(50000, 0, 50000) true at once.
  after.md.setQuote({ token: PLB_FUT.instrumentToken, lastPrice: 50000, ts: 1 })
  s2.handleTick({ token: PLB_FUT.instrumentToken, lastPrice: 50000, ts: 1 })
  await s2.drain()
  assert.equal(after.gateway.orders.length, 0,
    'a crossover at an ATM that already has a live group must not open a second one')

  // Trip the CE leg's own stop: entry 100 * multiplier 1.25 = 125.
  after.md.setQuote({ token: PLB_CE.instrumentToken, lastPrice: 130, ts: 2 })
  s2.handleTick({ token: PLB_FUT.instrumentToken, lastPrice: 50010, ts: 2 })
  await s2.drain()
  assert.deepEqual(sides(after), ['BUY 1 BANKNIFTY50000CE'],
    'the per-leg trigger (125) is only knowable from the recovered ENTRY premium — recomputing it from the current 130 would silently move the stop to wherever the market is now')

  await s2.endDay('day end')
  assert.deepEqual(sides(after), ['BUY 1 BANKNIFTY50000CE', 'BUY 1 BANKNIFTY50000PE'],
    'C3: the surviving PE leg is still flattened at day end even though its sibling already stopped')
  assert.equal(await after.state.get(SESSION_STATE_KEY), null)
})

test('PLB: restart with the ATM gate legitimately CLEAR — the first tick still must not manufacture a crossover', async () => {
  const before = await plbWithOpenGroup()
  // Stop both legs. `reentry: 'per-leg'` deletes the group's open-ATM gate on
  // each stop, so the restart below genuinely has an empty `openAtms` — nothing
  // but the price baseline stands between it and a fresh group.
  const s1 = new PremiumLegBookStrategy(before.ctx, LION_S25_2)
  await s1.start()
  before.md.setQuote({ token: PLB_CE.instrumentToken, lastPrice: 130, ts: 1 }) // > 100 * 1.25
  before.md.setQuote({ token: PLB_PE.instrumentToken, lastPrice: 120, ts: 1 }) // > 90 * 1.25
  s1.handleTick({ token: PLB_FUT.instrumentToken, lastPrice: 50010, ts: 1 })
  await s1.drain()
  assert.deepEqual(sides(before).slice(2), ['BUY 1 BANKNIFTY50000CE', 'BUY 1 BANKNIFTY50000PE'],
    'setup sanity: both legs stopped out, so the ATM gate is clear')

  const after = restart(before, ist(12, 0))
  seedPlb(after, 100, 90)
  const s2 = new PremiumLegBookStrategy(after.ctx, LION_S25_2)
  await s2.start()
  after.md.setQuote({ token: PLB_FUT.instrumentToken, lastPrice: 50000, ts: 2 })
  s2.handleTick({ token: PLB_FUT.instrumentToken, lastPrice: 50000, ts: 2 })
  await s2.drain()
  assert.deepEqual(sides(after), [],
    'a `#lastPrice` of 0 makes isCrossover(50000, 0, 50000) true, so the very first tick after ANY restart would open a group the market never signalled')

  // One tick later the baseline is real and a genuine crossover still works —
  // the cost of the guard is exactly one tick, not the rest of the session.
  after.md.setQuote({ token: PLB_FUT.instrumentToken, lastPrice: 49950, ts: 3 })
  s2.handleTick({ token: PLB_FUT.instrumentToken, lastPrice: 49950, ts: 3 })
  await s2.drain()
  assert.deepEqual(sides(after), ['SELL 1 BANKNIFTY50000CE', 'SELL 1 BANKNIFTY50000PE'],
    'the strategy is not deaf after a restart — it just needs one tick to know where the price is')
})

// ---------------------------------------------------------------- PremiumDistanceAccumulator

const PDA_FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 810001, lotSize: 15, tickSize: 0.05, exchange: 'NFO' }
const PDA_CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 810002, lotSize: 15, tickSize: 0.05, exchange: 'NFO' }
const PDA_PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 810003, lotSize: 15, tickSize: 0.05, exchange: 'NFO' }

function seedPda(parts: TestContextParts): void {
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', PDA_FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', PDA_CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PDA_PE)
  parts.md.setQuote({ token: PDA_CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PDA_PE.instrumentToken, lastPrice: 90, ts: 0 })
}

async function pdaWithOpenLegs(): Promise<TestContextParts> {
  const parts = makeTestContext({ tag: 'Eagle_S-1', nowMs: ist(10, 0) })
  seedPda(parts)
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, EAGLE_S_1)
  await s.start()
  s.handleTick({ token: PDA_FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  assert.deepEqual(sides(parts), ['SELL 1 BANKNIFTY50000CE', 'SELL 1 BANKNIFTY50000PE'],
    'setup sanity: the initial straddle is short, with triggers at 49900 (add_ce) and 50090 (add_pe)')
  return parts
}

test('PDA: restart holding short legs — the first tick re-baselines instead of firing the whole ladder at once', async () => {
  const before = await pdaWithOpenLegs()

  const after = restart(before, ist(12, 0))
  seedPda(after)
  const s2 = new PremiumDistanceAccumulatorStrategy(after.ctx, EAGLE_S_1)
  await s2.start()
  assert.equal(after.gateway.orders.length, 0)

  // 50200 is on the far side of BOTH pending triggers. With a `#lastPrice` of 0 —
  // what onDayStart leaves behind — every trigger in the ladder reads as crossed
  // and the accumulator sells a fresh leg for each of them in one tick.
  after.md.setQuote({ token: PDA_FUT.instrumentToken, lastPrice: 50200, ts: 1 })
  s2.handleTick({ token: PDA_FUT.instrumentToken, lastPrice: 50200, ts: 1 })
  await s2.drain()
  assert.equal(after.gateway.orders.length, 0,
    'the first tick after a restart only re-seeds the price baseline')

  // Now a genuine crossing of the 50090 add_pe trigger, 50200 -> 50000.
  after.md.setQuote({ token: PDA_FUT.instrumentToken, lastPrice: 50000, ts: 2 })
  s2.handleTick({ token: PDA_FUT.instrumentToken, lastPrice: 50000, ts: 2 })
  await s2.drain()
  assert.deepEqual(sides(after), ['SELL 1 BANKNIFTY50000PE'],
    'exactly the one trigger that crossed. A second order here would mean `entered` was lost and the initial straddle re-opened on top of the live book')

  await s2.endDay('day end')
  assert.deepEqual(sides(after).slice(1),
    ['BUY 1 BANKNIFTY50000CE', 'BUY 1 BANKNIFTY50000PE', 'BUY 1 BANKNIFTY50000PE'],
    'day end buys back all THREE short legs — the two recovered from before the restart and the one added after. This class has no other exit at all (D9)')
  assert.equal(await after.state.get(SESSION_STATE_KEY), null)
})
