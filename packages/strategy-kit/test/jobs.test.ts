/**
 * Job scheduler behaviour: repeats, restart catch-up, self-retry, ordering and
 * the re-entrancy guard. `base.test.ts` covers the surrounding lifecycle.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  StrategyBase,
  makeTestContext,
  replay,
  type CandleEvent,
  type DataNeed,
  type JobSpec,
  type Quote,
  type ReplayTick,
  type StrategyContext,
} from '../src/index.ts'

const INST = { tradingsymbol: 'X', instrumentToken: 1, lotSize: 25, tickSize: 0.05, exchange: 'NFO' }

const ist = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s) - 330 * 60_000

// Friday 2026-07-24.
const FRI = { y: 2026, mo: 7, d: 24 }

const POLLER = '10 */5 9-13 * * 1-5'
const DEADLINE = '0 31 13 * * 1-5'

/**
 * A `bn-breakout`-shaped strategy: a repeating poller, a deadline that closes
 * entries, and an order-placing square-off. Every job records the order it ran
 * in, which is what the ordering assertions read.
 */
class Engine extends StrategyBase {
  readonly ran: string[] = []
  readonly candles: CandleEvent[] = []
  pollRuns = 0
  entryClosed = false
  ticks = 0
  /** While true, the poller reports "no data yet" and asks for a 30s retry. */
  starved = false
  /** Deferred that a job blocks on, for the re-entrancy test. */
  block: Promise<void> | null = null
  /** Deferred that `onTick` blocks on — the multi-second HTTP submit, simulated. */
  tickBlock: Promise<void> | null = null
  /** Override the square-off cron so a test can place it in the past. */
  squareOffCron = '0 15 15 * * 1-5'

  constructor(ctx: StrategyContext) {
    super(ctx)
  }

  dataNeeds(): readonly DataNeed[] {
    return [{ kind: 'index', underlying: 'BANKNIFTY' }]
  }

  jobs(): readonly JobSpec[] {
    return [
      {
        name: 'poll',
        cron: POLLER,
        replayable: true, // evaluates candles, places nothing
        retryAfterMs: 30_000,
        run: async () => {
          this.ran.push('poll')
          if (this.block !== null) await this.block
          if (this.starved) return { retry: true } as const
          this.pollRuns++
          return
        },
      },
      {
        name: 'closeEntries',
        cron: DEADLINE,
        replayable: true, // idempotent: just flips a flag
        run: () => {
          this.ran.push('closeEntries')
          this.entryClosed = true
        },
      },
      {
        name: 'squareOff',
        cron: this.squareOffCron,
        replayable: false, // places an order — never replayed
        run: async () => {
          this.ran.push('squareOff')
          await this.submit({ instrument: INST, side: 'SELL', lots: 1, reducesExposure: true })
        },
      },
    ]
  }

  protected override async onTick(_q: Quote): Promise<void> {
    this.ticks++
    if (this.tickBlock !== null) await this.tickBlock
  }

  protected override async onCandle(ev: CandleEvent): Promise<void> {
    this.candles.push(ev)
  }
}

const tick = (ts: number, price = 100): ReplayTick => ({
  ts,
  quote: { token: 260105, lastPrice: price, ts },
})

// --- repeats ----------------------------------------------------------------

test('a REPEATING job fires once per cron occurrence, not once per day', async () => {
  // The thing `atIstMinute` structurally could not express.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 16, 0) })
  const s = new Engine(parts.ctx)
  await s.start() // start's restart catch-up runs the poller once; ignore that here
  s.ran.length = 0
  s.pollRuns = 0

  const res = await replay(s, parts, [
    tick(ist(FRI.y, FRI.mo, FRI.d, 9, 17, 0)),
    tick(ist(FRI.y, FRI.mo, FRI.d, 9, 31, 0)), // spans 09:20:10, 09:25:10, 09:30:10
  ])
  assert.deepEqual(s.ran, ['poll', 'poll', 'poll'])
  assert.equal(s.pollRuns, 3)
  assert.ok(res.jobsFired.includes('poll'))
})

test('the DEADLINE job runs AFTER the last poller tick, so the final check can still trade', async () => {
  // 13:30:10 poll, then 13:31:00 closeEntries. Deliberate in all four engines.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 13, 29, 0) })
  const s = new Engine(parts.ctx)
  await s.start()
  s.ran.length = 0

  await replay(s, parts, [tick(ist(FRI.y, FRI.mo, FRI.d, 13, 32, 0))])
  assert.deepEqual(s.ran, ['poll', 'closeEntries'])
  assert.equal(s.entryClosed, true)
})

// --- self-retry -------------------------------------------------------------

test('a job returning { retry: true } is rescheduled ~30s later and succeeds then', async (t) => {
  // Anatomy row 9 / the live log line "not enough hourly candles for ATR,
  // retrying in 30s". Without this one slow feed means the band never forms and
  // the strategy silently does nothing all day.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // 08:00 IST: pre-open, so no restart catch-up runs and the fireJob below is
  // unambiguously the job's first attempt.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 8, 0, 0) })
  const s = new Engine(parts.ctx)
  s.starved = true
  await s.start()

  await s.fireJob('poll')
  assert.equal(s.pollRuns, 0, 'the data was not there, so nothing was computed')
  assert.deepEqual(s.pendingRetries(), ['poll'], 'a retry must be armed')
  assert.ok(parts.logs.some((l) => l.msg.includes("job 'poll' has no data yet, retrying in 30s")))

  // Nothing happens before the delay elapses.
  t.mock.timers.tick(29_000)
  await drainMicrotasks()
  assert.equal(s.ran.length, 1)

  // The feed catches up; the re-armed attempt now succeeds.
  s.starved = false
  t.mock.timers.tick(1_000)
  await drainMicrotasks()
  assert.equal(s.ran.length, 2, 'the retry re-ran the job')
  assert.equal(s.pollRuns, 1)
  assert.deepEqual(s.pendingRetries(), [], 'a successful attempt disarms the retry')
})

test('a job that keeps starving keeps retrying, and maxRetries can bound it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 8, 0, 0) })

  class Bounded extends Engine {
    override jobs(): readonly JobSpec[] {
      return [
        {
          name: 'poll',
          cron: POLLER,
          replayable: true,
          retryAfterMs: 1_000,
          maxRetries: 2,
          run: () => {
            this.ran.push('poll')
            return { retry: true } as const
          },
        },
      ]
    }
  }
  const s = new Bounded(parts.ctx)
  await s.start()
  await s.fireJob('poll')
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1_000)
    await drainMicrotasks()
  }
  assert.equal(s.ran.length, 3, 'the first attempt plus exactly 2 retries')
  assert.ok(parts.logs.some((l) => l.msg.includes('gave up after 2 retries')))
})

test('endDay drops any armed retry, so it cannot leak into the next session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 8, 0, 0) })
  const s = new Engine(parts.ctx)
  s.starved = true
  await s.start()
  await s.fireJob('poll')
  assert.deepEqual(s.pendingRetries(), ['poll'])

  await s.endDay('EOD')
  assert.deepEqual(s.pendingRetries(), [])
  t.mock.timers.tick(60_000)
  await drainMicrotasks()
  assert.equal(s.ran.length, 1, 'the dropped retry must not fire after the day ended')
})

// --- restart catch-up -------------------------------------------------------

test('catch-up replays ONLY replayable jobs; the order-placing one is suppressed', async () => {
  // 15:20 IST: every job's threshold has passed. squareOff placing an order here
  // would double up on whatever `onRecover` already restored.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 15, 20, 0) })
  const s = new Engine(parts.ctx)
  await s.start()

  assert.deepEqual(s.ran, ['poll', 'closeEntries'], 'in catch-up-threshold order')
  assert.equal(parts.gateway.orders.length, 0, 'catch-up must never place an order')
  assert.ok(
    parts.logs.some((l) => l.level === 'warn' && l.msg.includes("job 'squareOff'") && l.msg.includes('not replay-safe')),
  )
  // It is still marked fired, so the live scheduler will not run it again for
  // the occurrence that has already passed.
  assert.ok(s.firedJobs().includes('squareOff'))
})

test('a job whose catch-up threshold has NOT passed is left alone', async () => {
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 30, 0) })
  const s = new Engine(parts.ctx)
  await s.start()
  assert.deepEqual(s.ran, ['poll'], 'the 13:31 deadline is not due at 09:30')
  assert.equal(s.entryClosed, false)
})

test('catchUpFrom overrides the cron-derived threshold (orb-fut: fires 09:45:20, bootstraps 09:46)', async () => {
  class OrbFut extends Engine {
    override jobs(): readonly JobSpec[] {
      return [
        {
          name: 'setupRange',
          cron: '20 45 9 * * 1-5',
          catchUpFrom: 9 * 60 + 46, // the engine's own hand-written `mins >= 586`
          replayable: true,
          run: () => {
            this.ran.push('setupRange')
          },
        },
      ]
    }
  }
  // 09:45 IST — the cron's own minute, but one BEFORE the declared threshold.
  const early = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 45, 0) })
  const a = new OrbFut(early.ctx)
  await a.start()
  assert.deepEqual(a.ran, [], 'catchUpFrom, not the cron minute, decides')

  const late = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 46, 0) })
  const b = new OrbFut(late.ctx)
  await b.start()
  assert.deepEqual(b.ran, ['setupRange'])
})

test('an already-caught-up job is not re-run by the scheduler for the same occurrence', async () => {
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 30, 0) })
  const s = new Engine(parts.ctx)
  await s.start()
  assert.equal(s.pollRuns, 1)
  await s.fireJob('poll') // same gap between occurrences -> same occurrence
  assert.equal(s.pollRuns, 1)
})

// --- re-entrancy / serialisation --------------------------------------------

/**
 * K2. This test used to assert `s.ticks === 0` FOREVER — i.e. that a tick
 * arriving while a job held the guard was thrown away — and it codified the
 * losing side of a contradiction with the design spec: §2 row 10 says the exit
 * check runs off the tick, and §6 says "exits are never blocked". A dropped tick
 * is a skipped exit check, so the old behaviour disabled the exit path for the
 * entire duration of any job, and `onTick` in the range-breakout strategy awaits
 * HTTP submits measured in seconds.
 *
 * Resolved by DEFERRING rather than dropping. Exempting "just the exit path" is
 * not implementable in the base: `onTick` is one opaque method and StrategyBase
 * cannot see which half of it is the exit check. Deferral keeps the property the
 * guard exists for (no interleaving — a tick still cannot double-exit mid-close)
 * and drops only the loss.
 */
test('a tick arriving mid-job is DEFERRED, not interleaved and not dropped', async () => {
  // 08:00 IST: pre-open, so nothing is caught up and 'poll' is still unfired.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 8, 0, 0) })
  const s = new Engine(parts.ctx)
  await s.start()

  let release = (): void => {}
  s.block = new Promise<void>((r) => {
    release = () => {
      r()
    }
  })
  const busy = s.fireJob('poll') // blocks inside run(), holding the queue
  await drainMicrotasks()

  s.handleTick({ token: 260105, lastPrice: 100, ts: 1 })
  // NOT `drain()` — that would wait for the still-blocked job. Settling the
  // microtask queue is enough to prove the tick did not interleave.
  await drainMicrotasks()
  assert.equal(s.ticks, 0, 'not interleaved: the job still owns the queue')

  s.block = null
  release()
  await busy
  await s.drain()
  assert.equal(s.ticks, 1, 'the deferred tick RAN once the queue freed — it was not discarded')

  // ...and normal ticks still flow afterwards.
  s.handleTick({ token: 260105, lastPrice: 101, ts: 2 })
  await s.drain()
  assert.equal(s.ticks, 2)
})

/**
 * K1, first half. The reviewer's reproduction, verbatim:
 *
 *     PROBE: job:squareOff skipped, already busy
 *     job actually ran? false
 *     recorded as fired (can never fire again today)? [ 'squareOff' ]
 *
 * `#execute` recorded the occurrence in `#firedOccurrences` BEFORE calling the
 * guard, and the guard returned `undefined` when busy — so the strategy's own
 * priced 15:15 exit was marked done for the day without ever having run, and the
 * occurrence key made it unfireable for the rest of the session.
 */
test('a job whose cron fires while a tick is mid-await still RUNS, and is not marked fired until it does', async () => {
  // 08:00 IST: pre-open, so restart catch-up touches nothing and every job below
  // is genuinely unfired.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 8, 0, 0) })
  const s = new Engine(parts.ctx)
  await s.start()
  s.ran.length = 0
  parts.gateway.orders.length = 0

  let release = (): void => {}
  s.tickBlock = new Promise<void>((r) => {
    release = () => {
      r()
    }
  })
  s.handleTick({ token: 260105, lastPrice: 100, ts: 1 }) // onTick blocks, as a real submit does
  await drainMicrotasks()

  const fired = s.fireJob('squareOff')
  await drainMicrotasks()
  assert.equal(s.ran.includes('squareOff'), false, 'it is queued behind the tick, not run yet')
  assert.equal(
    s.firedJobs().includes('squareOff'),
    false,
    'and it must NOT be recorded as fired before it has run — that is what made it unfireable',
  )

  s.tickBlock = null
  release()
  await fired
  await s.drain()

  assert.deepEqual(s.ran, ['squareOff'], 'the square-off actually ran')
  assert.equal(parts.gateway.orders.length, 1, 'the 15:15 exit reached the gateway')
  assert.equal(parts.gateway.orders[0]?.side, 'SELL')
  assert.ok(s.firedJobs().includes('squareOff'), 'recorded fired only once it really fired')
})

/**
 * K1, second half. A job must not be lost because a slow handler happened to be
 * in flight, and the two contenders must not race each other either.
 */
test('a cron job and a slow tick handler SERIALISE — neither is dropped, neither interleaves', async () => {
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 8, 0, 0) })
  const s = new Engine(parts.ctx)
  await s.start()
  s.ran.length = 0

  let release = (): void => {}
  s.tickBlock = new Promise<void>((r) => {
    release = () => {
      r()
    }
  })
  s.handleTick({ token: 260105, lastPrice: 100, ts: 1 })
  await drainMicrotasks()

  // Both of the deadline job and a second tick arrive during the block.
  const deadline = s.fireJob('closeEntries')
  s.handleTick({ token: 260105, lastPrice: 101, ts: 2 })
  await drainMicrotasks()
  assert.equal(s.entryClosed, false, 'nothing overtakes the in-flight handler')

  s.tickBlock = null
  release()
  await deadline
  await s.drain()

  assert.equal(s.entryClosed, true, 'the deadline job was deferred, not dropped')
  assert.equal(s.ticks, 2, 'and so was the second tick')
  assert.equal(s.queueDepth(), 0, 'the queue drained fully')
})

test('a job that THREW still counts as fired — it may have placed an order before throwing', async () => {
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 8, 0, 0) })
  class Exploding extends Engine {
    override jobs(): readonly JobSpec[] {
      return [
        {
          name: 'boom',
          cron: POLLER,
          replayable: true,
          run: () => {
            this.ran.push('boom')
            throw new Error('half-placed')
          },
        },
      ]
    }
  }
  const s = new Exploding(parts.ctx)
  await s.start()
  await s.fireJob('boom')
  assert.deepEqual(s.ran, ['boom'])
  assert.ok(s.firedJobs().includes('boom'), 'entered run() == fired, regardless of outcome')
  await s.fireJob('boom')
  assert.deepEqual(s.ran, ['boom'], 'and it is not retried into a duplicate order')
})

test('a fill arriving while a tick is mid-await is delivered, not dropped', async () => {
  // A dropped fill means the strategy does not know it holds a position — the
  // same single-flag defect as the dropped job, on the path where it is worst.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 30, 0) })
  const fills: number[] = []
  class Filled extends Engine {
    protected override async onFill(f: { avgPrice: number }): Promise<void> {
      fills.push(f.avgPrice)
    }
  }
  const s = new Filled(parts.ctx)
  await s.start()

  let release = (): void => {}
  s.tickBlock = new Promise<void>((r) => {
    release = () => {
      r()
    }
  })
  s.handleTick({ token: 260105, lastPrice: 100, ts: 1 })
  await drainMicrotasks()

  parts.gateway.emitFill({
    clientOrderId: 'x',
    instrument: INST,
    side: 'BUY',
    filledQty: 25,
    avgPrice: 123,
    ts: 1,
  })
  await drainMicrotasks()
  assert.deepEqual(fills, [], 'queued behind the tick')

  s.tickBlock = null
  release()
  await s.drain()
  assert.deepEqual(fills, [123], 'delivered once the queue freed')
})

// --- candles ----------------------------------------------------------------

test('onCandle is delivered on the same serialised chain as ticks', async () => {
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 30, 0) })
  const s = new Engine(parts.ctx)
  await s.start()
  s.handleCandle({
    token: 260105,
    interval: '5minute',
    candle: { ts: 1, open: 1, high: 2, low: 0.5, close: 1.5 },
  })
  await s.drain()
  assert.equal(s.candles.length, 1)
  assert.equal(s.candles[0]?.interval, '5minute')

  await s.stop('test')
  s.handleCandle({
    token: 260105,
    interval: '5minute',
    candle: { ts: 2, open: 1, high: 2, low: 0.5, close: 1.5 },
  })
  await s.drain()
  assert.equal(s.candles.length, 1, 'nothing is delivered after stop()')
})

// --- start() failure --------------------------------------------------------

test('a failed start() resets, so a later retry can get through', async () => {
  // `bn-breakout.js`'s `catch { started = false }` — otherwise one transient
  // failure wedges the strategy for the whole day.
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 30, 0) })
  class Flaky extends Engine {
    fail = true
    protected override async onDayStart(): Promise<void> {
      if (this.fail) throw new Error('chain download failed')
    }
  }
  const s = new Flaky(parts.ctx)
  await s.start()
  assert.deepEqual(s.ran, [], 'catch-up never ran')
  assert.ok(parts.logs.some((l) => l.level === 'error' && l.msg.includes('start failed')))

  s.fail = false
  await s.start()
  assert.deepEqual(s.ran, ['poll'], 'the retry got all the way through catch-up')
})

test('a malformed cron fails the START with the job name attached, not at 10:15 on a Tuesday', async () => {
  const parts = makeTestContext({ nowMs: ist(FRI.y, FRI.mo, FRI.d, 9, 30, 0) })
  class Broken extends Engine {
    override jobs(): readonly JobSpec[] {
      return [{ name: 'bad', cron: '0 21 99 * * 1-5', replayable: true, run: () => {} }]
    }
  }
  const s = new Broken(parts.ctx)
  await s.start()
  const entry = parts.logs.find((l) => l.level === 'error' && l.msg.includes('start failed'))
  assert.ok(entry !== undefined, 'a bad cron must fail the start, not blow up inside a timer later')
  const detail = String(entry.ctx?.['error'])
  assert.ok(detail.includes("job 'bad'"), `must name the job, got: ${detail}`)
  assert.ok(detail.includes('hours'), `must name the offending field, got: ${detail}`)
})

/** Let the microtask queue settle after a mocked timer fires. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
