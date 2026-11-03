/**
 * Day-end square-off and mid-session restart recovery, for the premium-leg-book class.
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
import { makeTestContext, type TestContextParts } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../src/premium-leg-book/strategy.ts'
import { LION_S25_2 } from '../src/premium-leg-book/configs/lion-s25.ts'
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
