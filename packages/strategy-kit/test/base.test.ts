import test from 'node:test'
import assert from 'node:assert/strict'
import {
  StrategyBase,
  makeTestContext,
  replay,
  diffIntents,
  cronAtIstMinute,
  type DataNeed,
  type JobSpec,
  type Quote,
  type RecordedOrder,
  type StrategyContext,
  type Fill,
} from '../src/index.ts'

const INST = {
  tradingsymbol: 'BANKNIFTY2673050000CE',
  instrumentToken: 111,
  lotSize: 35,
  tickSize: 0.05,
  exchange: 'NFO',
}

/**
 * A minimal strategy shaped like `bn-breakout`: a job sets a level, then ticks
 * above it trigger one entry per day.
 */
class LevelBreakout extends StrategyBase {
  level: number | null = null
  entered = false
  setupRuns = 0
  ticks = 0
  fills: Fill[] = []
  recoveredFrom: string | null = null
  /** Set true to make the setup job throw, exercising error containment. */
  explodeOnSetup = false
  /** Set true to make the setup job ask for a 30s retry instead of succeeding. */
  starveSetup = false
  /** Whether the day-end square-off was ACCEPTED, not merely attempted. */
  squareOffAccepted: boolean | null = null

  constructor(ctx: StrategyContext) {
    super(ctx)
  }

  dataNeeds(): readonly DataNeed[] {
    return [{ kind: 'index', underlying: 'BANKNIFTY' }]
  }

  jobs(): readonly JobSpec[] {
    return [
      {
        name: 'setLevel',
        cron: '0 21 9 * * 1-5',
        replayable: true, // idempotent: just computes a number
        run: async () => {
          this.setupRuns++
          if (this.explodeOnSetup) throw new Error('setup blew up')
          // Anatomy row 9: "not enough hourly candles for ATR, retrying in 30s".
          if (this.starveSetup) return { retry: true } as const
          this.level = 50_000
          return
        },
      },
      {
        name: 'enterNow',
        cron: cronAtIstMinute(10 * 60),
        replayable: false, // places an order — must NOT be replayed
        run: async () => {
          await this.submit({ instrument: INST, side: 'BUY', lots: 1 })
        },
      },
    ]
  }

  protected override async onRecover(): Promise<void> {
    const saved = await this.ctx.state.get<{ entered: boolean }>('pos')
    if (saved !== null) {
      this.entered = saved.entered
      this.recoveredFrom = 'state'
    }
  }

  protected override async onFill(fill: Fill): Promise<void> {
    this.fills.push(fill)
  }

  /**
   * Square off at day end, exactly as a real strategy holding a position does.
   * `reducesExposure` marks it an exit, so no risk gate may refuse it.
   */
  protected override async onDayEnd(_reason: string): Promise<void> {
    if (!this.entered) return
    const res = await this.submit({
      instrument: INST,
      side: 'SELL',
      lots: 1,
      reducesExposure: true,
    })
    this.squareOffAccepted = res.accepted
  }

  protected override async onTick(q: Quote): Promise<void> {
    this.ticks++
    if (this.level === null || this.entered) return
    if (q.lastPrice > this.level) {
      const res = await this.submit({ instrument: INST, side: 'BUY', lots: 1 })
      // Flag flips ONLY after a successful submit — the legacy discipline.
      if (res.accepted) this.entered = true
    }
  }
}

const q = (price: number, ts = 0): Quote => ({ token: 260105, lastPrice: price, ts })

// --- startup ----------------------------------------------------------------

test('start() runs unconditionally, not gated behind a time window', async () => {
  // The 2026-07-06 bug: login gated inside a time-windowed bootstrap meant
  // strategies silently never initialised. Startup must always run.
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 1, 0, 0) }) // 06:30 IST, pre-market
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  assert.ok(parts.logs.some((l) => l.msg.includes('starting')), 'must start outside market hours too')
})

test('start() is idempotent — including the fill subscription', async () => {
  // This used to assert `setupRuns <= 1`, which accepts 0 and which passes with
  // the `#started` guard DELETED — because the occurrence key stops catch-up
  // re-running the job anyway. What `#started` actually protects is the
  // `ctx.fills.onFill(...)` registration: without it a second start() subscribes
  // a second handler and every fill is then delivered N times, so a strategy
  // counting fills into a position size silently doubles it.
  const parts = makeTestContext()
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  await s.start()
  assert.equal(s.setupRuns, 1, 'exactly once — not zero, not twice')

  parts.gateway.emitFill({
    clientOrderId: 'x',
    instrument: INST,
    side: 'BUY',
    filledQty: 35,
    avgPrice: 120,
    ts: 1,
  })
  await s.drain()
  assert.equal(s.fills.length, 1, 'one fill, one delivery — not one per start() call')
})

// --- job catch-up on restart ------------------------------------------------

test('a replay-safe job already due IS caught up on restart', async () => {
  // 09:30 IST — past the 09:21 setLevel job.
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  assert.equal(s.level, 50_000, 'restart must recover the frozen level')
  assert.deepEqual(s.firedJobs().includes('setLevel'), true)
})

test('an order-placing job already due is NOT replayed', async () => {
  // 10:30 IST — past BOTH jobs. Replaying 'enterNow' would duplicate a position.
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 5, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  assert.equal(
    parts.gateway.orders.length,
    0,
    'catch-up must never place an order for a non-replay-safe job',
  )
  assert.ok(
    s.firedJobs().includes('enterNow'),
    'it is marked fired so the scheduler will not fire it again',
  )
  assert.ok(parts.logs.some((l) => l.level === 'warn' && l.msg.includes('not replay-safe')))
})

test('no catch-up happens outside market hours', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 12, 0, 0) }) // 17:30 IST
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  assert.equal(s.level, null)
  assert.deepEqual(s.firedJobs(), [])
})

test('catch-up does not run on a weekend', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 25, 4, 0, 0) }) // Sat 09:30 IST
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  assert.equal(s.level, null)
})

test('a job fires at most once per occurrence', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  await s.fireJob('setLevel')
  await s.fireJob('setLevel')
  assert.equal(s.setupRuns, 1)
})

test('endDay clears fired jobs so the next session starts fresh', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  assert.ok(s.firedJobs().length > 0)
  await s.endDay('EOD')
  assert.deepEqual(s.firedJobs(), [])
})

// --- restart recovery -------------------------------------------------------

test('onRecover restores an open position from durable state', async () => {
  // The legacy system could NOT do this: positions lived in process memory.
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  parts.state.seed('pos', { entered: true })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  assert.equal(s.entered, true)
  assert.equal(s.recoveredFrom, 'state')

  // ...and a breakout tick must not re-enter.
  s.handleTick(q(60_000))
  await s.drain()
  assert.equal(parts.gateway.orders.length, 0, 'recovered position must suppress re-entry')
})

// --- order discipline -------------------------------------------------------

test('the used-flag flips only after a SUCCESSFUL submit', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()

  parts.gateway.accept = false
  s.handleTick(q(60_000))
  await s.drain()
  assert.equal(s.entered, false, 'a rejected order must not burn the opportunity')

  parts.gateway.accept = true
  s.handleTick(q(60_001))
  await s.drain()
  assert.equal(s.entered, true)
  assert.equal(parts.gateway.orders.length, 1)
})

test('a rejected order is logged as a warning', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  parts.gateway.accept = false
  s.handleTick(q(60_000))
  await s.drain()
  assert.ok(parts.logs.some((l) => l.level === 'warn' && l.msg.includes('rejected')))
})

test('no orders are submitted after stop()', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  await s.stop('test')
  s.handleTick(q(60_000))
  await s.drain()
  assert.equal(parts.gateway.orders.length, 0)
})

/**
 * THE DAY-END SQUARE-OFF MUST ACTUALLY REACH THE GATEWAY.
 *
 * `stop()` used to set `#stopped` before running `endDay()`, and `submit()`
 * refuses everything once that flag is set — so a strategy that flattened from
 * `onDayEnd()` had its exit SILENTLY REFUSED and carried the position overnight.
 * Nothing threw and nothing logged an error; the only trace was an open position
 * nobody could account for the next morning.
 *
 * Note what this asserts: not that submit was CALLED, but that it was ACCEPTED
 * and that the order actually reached the gateway. The old code called it too.
 */
test('a day-end square-off placed from onDayEnd() is accepted, not refused by stop()', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  await s.fireJob('setLevel')
  s.handleTick(q(60_000))
  await s.drain()
  assert.equal(s.entered, true, 'fixture must hold a position before it can square off')
  assert.equal(parts.gateway.orders.length, 1, 'the entry')

  await s.stop('EOD')

  assert.equal(s.squareOffAccepted, true, 'the exit must not be refused as "strategy stopped"')
  assert.equal(parts.gateway.orders.length, 2, 'the square-off must reach the gateway')
  assert.equal(parts.gateway.orders[1]?.side, 'SELL')
  // And the strategy is genuinely stopped afterwards — the window is only open
  // for the duration of endDay(), never left open.
  assert.equal(s.isStopped, true)
  const after = await s['submit']({ instrument: INST, side: 'BUY', lots: 1 })
  assert.equal(after.accepted, false, 'the window closes once endDay() has finished')
})

// --- error containment ------------------------------------------------------

test('a throwing job is contained and logged, not propagated', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 1, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  s.explodeOnSetup = true
  await s.start()
  // Fire it explicitly (pre-market, so no catch-up).
  await assert.doesNotReject(() => s.fireJob('setLevel'))
  assert.ok(parts.logs.some((l) => l.level === 'error' && l.msg.includes('threw')))
})

test('a throwing tick handler does not break subsequent ticks', async () => {
  class Thrower extends LevelBreakout {
    protected override async onTick(qq: Quote): Promise<void> {
      this.ticks++
      if (qq.lastPrice === 1) throw new Error('bad tick')
    }
  }
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new Thrower(parts.ctx)
  await s.start()
  s.handleTick(q(1))
  s.handleTick(q(2))
  await s.drain()
  assert.equal(s.ticks, 2, 'one bad tick must not stop the stream')
  assert.ok(parts.logs.some((l) => l.level === 'error'))
})

// --- fills ------------------------------------------------------------------

test('fills are delivered to the strategy', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new LevelBreakout(parts.ctx)
  await s.start()
  parts.gateway.emitFill({
    clientOrderId: 'x',
    instrument: INST,
    side: 'BUY',
    filledQty: 35,
    avgPrice: 120,
    ts: 1,
  })
  // Fill handling is queued through the guard, so let it drain.
  await new Promise((r) => setImmediate(r))
  assert.equal(s.fills.length, 1)
  assert.equal(s.fills[0]?.avgPrice, 120)
})

// --- replay + golden master -------------------------------------------------

test('replay drives jobs and ticks in time order', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 40, 0) }) // 09:10 IST
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  const s = new LevelBreakout(parts.ctx)

  const res = await replay(s, parts, [
    { ts: Date.UTC(2026, 6, 24, 3, 46, 0), quote: q(49_000) }, // 09:16, before setLevel
    { ts: Date.UTC(2026, 6, 24, 3, 52, 0), quote: q(49_500) }, // 09:22, setLevel now fired
    { ts: Date.UTC(2026, 6, 24, 3, 55, 0), quote: q(50_500) }, // 09:25, breakout
    { ts: Date.UTC(2026, 6, 24, 3, 56, 0), quote: q(51_000) }, // 09:26, must NOT re-enter
  ])

  assert.equal(res.ticksProcessed, 4)
  assert.ok(res.jobsFired.includes('setLevel'))
  assert.equal(res.orders.length, 1, 'exactly one entry for the day')
  assert.equal(res.orders[0]?.side, 'BUY')
  assert.equal(res.orders[0]?.symbol, INST.tradingsymbol)
})

test('diffIntents reports a match for identical sequences', () => {
  const a: RecordedOrder[] = [
    { symbol: 'X', side: 'BUY', lots: 1, orderType: 'MARKET' },
    { symbol: 'X', side: 'SELL', lots: 1, orderType: 'MARKET' },
  ]
  const d = diffIntents(a, [...a])
  assert.equal(d.match, true)
  assert.deepEqual(d.differences, [])
})

test('diffIntents catches a count mismatch, a field change, and ORDERING', () => {
  const legacy: RecordedOrder[] = [
    { symbol: 'X', side: 'BUY', lots: 1, orderType: 'MARKET' },
    { symbol: 'Y', side: 'SELL', lots: 2, orderType: 'MARKET' },
  ]

  // missing order
  let d = diffIntents(legacy, [legacy[0] as RecordedOrder])
  assert.equal(d.match, false)
  assert.ok(d.differences.some((x) => x.includes('COUNT')))
  assert.ok(d.differences.some((x) => x.includes('MISSING')))

  // changed lots
  d = diffIntents(legacy, [legacy[0] as RecordedOrder, { ...(legacy[1] as RecordedOrder), lots: 3 }])
  assert.equal(d.match, false)
  assert.ok(d.differences.some((x) => x.includes('lots: legacy=2 ported=3')))

  // same orders, WRONG ORDER — must not be treated as equivalent, because
  // sequencing changes exposure over time.
  d = diffIntents(legacy, [legacy[1] as RecordedOrder, legacy[0] as RecordedOrder])
  assert.equal(d.match, false, 'ordering is part of behaviour')
})

test('diffIntents compares limit and trigger prices', () => {
  const a: RecordedOrder[] = [{ symbol: 'X', side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 100 }]
  const b: RecordedOrder[] = [{ symbol: 'X', side: 'BUY', lots: 1, orderType: 'LIMIT', limitPrice: 101 }]
  const d = diffIntents(a, b)
  assert.equal(d.match, false)
  assert.ok(d.differences.some((x) => x.includes('limitPrice')))
})
