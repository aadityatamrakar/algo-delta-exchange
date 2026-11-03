/**
 * The runner's lifecycle, on a synthetic clock (Phase C §9).
 *
 * Everything time-driven goes through `tick()` and the injected clock, so
 * autostart, delay-start, cron firing, day-end square-off and a mid-session
 * restart are all assertable in milliseconds instead of over a trading day.
 *
 * The restart test is the important one. It is the failure the legacy system
 * could not fix — positions lived in process memory, so a 12:30 pm2 restart
 * lost them — and it has two halves that must BOTH hold: the position comes
 * back from the `StateStore`, and the entry job that opened it is NOT replayed.
 * Getting only the first half right leaves you with a recovered position and a
 * duplicate of it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock, MARKET_OPEN_MIN } from '@algomaker/core'
import {
  MemoryStateStore,
  RecordingGateway,
  makeLogger,
  StrategyBase,
  type CapturedLog,
  type JobSpec,
  type Quote,
  type StrategyContext,
  type InstrumentRef,
  type StateStore,
} from '@algomaker/strategy-kit'
import {
  instanceKey,
  Runner,
  autostartMinute,
  sessionStartMinute,
  type HostedInstance,
  type HostedRow,
  type StrategyFactory,
} from '../src/runner.ts'

// ------------------------------------------------------------------ fixtures

/** Friday 2026-07-24. IST = UTC + 05:30, no DST, so the arithmetic is exact. */
const ist = (h: number, m: number, s = 0): number => Date.UTC(2026, 6, 24, h - 5, m - 30, s)
/** Saturday 2026-07-25 IST — the market is shut, and only the CALENDAR says so. */
const sat = (h: number, m: number, s = 0): number => Date.UTC(2026, 6, 25, h - 5, m - 30, s)
/** Sunday 2026-07-26 IST. */
const sun = (h: number, m: number, s = 0): number => Date.UTC(2026, 6, 26, h - 5, m - 30, s)
/** Monday 2026-07-27 IST — the next real session. */
const mon = (h: number, m: number, s = 0): number => Date.UTC(2026, 6, 27, h - 5, m - 30, s)

const INSTRUMENT: InstrumentRef = {
  tradingsymbol: 'BANKNIFTY26AUG56000CE',
  instrumentToken: 1234,
  lotSize: 35,
  tickSize: 0.05,
  exchange: 'NFO',
}

interface Persisted {
  readonly symbol: string
  readonly lots: number
  readonly entryPrice: number
}

/**
 * A well-behaved strategy: it persists its position on entry, rebuilds it in
 * `onRecover`, marks its order-placing jobs `replayable: false`, and squares
 * itself off in `onDayEnd`.
 *
 * IT IS NOT REPRESENTATIVE, and the comment that used to sit here — "proving
 * the runner drives it correctly proves it for all of them" — was false and
 * expensive. No class in `packages/strategies` overrode `onDayEnd` or
 * `onRecover` at all, so every test in this file that looks like it proves a
 * square-off actually proves that THIS fixture squares itself off; the runner
 * placing nothing and reporting `squared-off` anyway was invisible here for
 * exactly that reason. The exit paths are tested against a production-shaped
 * fixture and a real catalogue class in `runner-exit.test.ts`; what this file
 * covers is the SCHEDULING — autostart, cron windows, catch-up, recovery,
 * registry sync and fault isolation.
 */
class TestStrategy extends StrategyBase {
  position: Persisted | null = null
  entryAttempts = 0
  setupRuns = 0
  /** Set to make a job throw. Contained by `StrategyBase`, NOT by the runner. */
  explodeOnSetup = false
  /**
   * Set to make `jobs()` itself throw.
   *
   * That is the RUNNER's own bookkeeping: `#fireDueJobs` calls `jobs()`
   * directly, outside anything `StrategyBase` guards, so the throw can only be
   * caught by `Runner.#guarded`. A fixture that throws inside `job.run()`
   * instead — which is what this file used to do — is caught by the base's own
   * guard and never reaches the runner at all, so the test passed with the
   * runner's guards deleted.
   */
  explodeOnJobs = false

  dataNeeds(): [] {
    return []
  }

  jobs(): readonly JobSpec[] {
    if (this.explodeOnJobs) throw new Error('jobs() blew up')
    return [
      {
        name: 'setup',
        cron: '0 16 9 * * 1-5',
        // Idempotent: computes a band, places nothing.
        replayable: true,
        run: () => {
          if (this.explodeOnSetup) throw new Error('setup blew up')
          this.setupRuns++
        },
      },
      {
        name: 'entry',
        cron: '0 20 9 * * 1-5',
        // Places an order. Replaying it after a restart DUPLICATES the position.
        replayable: false,
        run: async () => {
          await this.enter()
        },
      },
    ]
  }

  ticksSeen = 0

  protected onTick(_quote: Quote): void {
    this.ticksSeen++
  }

  protected override async onRecover(): Promise<void> {
    this.position = await this.ctx.state.get<Persisted>('position')
  }

  protected override async onDayEnd(_reason: string): Promise<void> {
    await this.exit()
  }

  async enter(): Promise<void> {
    this.entryAttempts++
    const res = await this.submit({
      instrument: INSTRUMENT,
      side: 'BUY',
      lots: 2,
      referencePrice: 100,
    })
    // Anatomy row 14: the flag flips only AFTER a successful submit, so a
    // failed order leaves the opportunity available rather than burning it.
    if (!res.accepted) return
    this.position = { symbol: INSTRUMENT.tradingsymbol, lots: 2, entryPrice: 100 }
    await this.ctx.state.set('position', this.position)
  }

  async exit(): Promise<void> {
    const p = this.position
    if (p === null) return
    this.position = null // claim before the first await
    await this.submit({
      instrument: INSTRUMENT,
      side: 'SELL',
      lots: p.lots,
      reducesExposure: true,
    })
    await this.ctx.state.delete('position')
  }
}

function row(patch: Partial<HostedRow> = {}): HostedRow {
  return {
    tag: 'A',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    liveLots: 0,
    autostartAt: '',
    ...patch,
  }
}

interface Harness {
  runner: Runner
  clock: ReturnType<typeof fixedClock>
  gateways: Map<string, RecordingGateway>
  states: Map<string, StateStore>
  built: Map<string, TestStrategy>
  logs: CapturedLog[]
  setRows(rows: readonly HostedRow[]): void
}

function harness(
  opts: {
    rows?: readonly HostedRow[]
    nowMs?: number
    states?: Map<string, StateStore>
    unimplemented?: ReadonlySet<string>
    throwFor?: ReadonlySet<string>
  } = {},
): Harness {
  const clock = fixedClock(opts.nowMs ?? ist(9, 16))
  const logs: CapturedLog[] = []
  const log = makeLogger(logs)
  const gateways = new Map<string, RecordingGateway>()
  const states = opts.states ?? new Map<string, StateStore>()
  const built = new Map<string, TestStrategy>()
  let rows: readonly HostedRow[] = opts.rows ?? [row()]

  /**
   * Every per-instance map is keyed `tag:mode`, exactly as production is.
   *
   * A row switched on for both rails is built TWICE, and the two instances must
   * not share a gateway or a state store — see `HostedInstance`. Keying these
   * fixtures by tag alone would hide that in the one place it is testable.
   */
  const factory: StrategyFactory = {
    create(r: HostedInstance) {
      const key = instanceKey(r.tag, r.mode)
      if (opts.throwFor?.has(r.tag) === true) throw new Error('construction failed')
      if (opts.unimplemented?.has(r.tag) === true) return null
      const gateway = new RecordingGateway()
      gateways.set(key, gateway)
      let state = states.get(key)
      if (state === undefined) {
        state = new MemoryStateStore()
        states.set(key, state)
      }
      const ctx: StrategyContext = {
        tag: r.tag,
        clock,
        md: {
          quote: () => null,
          candles: async () => [],
          option: () => null,
          selectOption: () => null,
          future: () => null,
          atmStrike: () => 0,
          spotToken: () => 1,
        },
        orders: gateway,
        fills: gateway.asFillStream(),
        state,
        log,
        mode: r.mode === 'live' ? 'live' : 'sim',
        destinations: r.mode === 'live' ? ['xts'] : ['sim'],
        feed: { isTrustworthy: () => true, reason: () => null },
      }
      const s = new TestStrategy(ctx)
      built.set(key, s)
      return s
    },
  }

  const runner = new Runner({
    clock,
    log,
    factory,
    loadRows: async () => rows,
  })

  return {
    runner,
    clock,
    gateways,
    states,
    built,
    logs,
    setRows: (next) => {
      rows = next
    },
  }
}

// ------------------------------------------------------------------ mapping

test('autostartMinute maps the legacy delay_start strings', () => {
  assert.equal(autostartMinute(''), 0)
  assert.equal(autostartMinute('0914'), 554)
  assert.equal(autostartMinute('0918'), 558)
  assert.equal(autostartMinute('1530'), 930)
  // Garbage falls back to "start with the process" rather than never starting:
  // a strategy that silently never runs is the worse failure.
  assert.equal(autostartMinute('9:14'), 0)
})

/**
 * The midnight start. On prod, `''` reached `#maybeStart` as minute 0, the day
 * roll resets every strategy to `waiting` at 00:00 IST, and `nowMin >= 0` is
 * true the instant the day turns — so four straddles opened at 01:00 IST
 * against the previous session's marks, two nights running.
 */
test('sessionStartMinute floors "as soon as possible" at the market open, not midnight', () => {
  assert.equal(sessionStartMinute(''), MARKET_OPEN_MIN)
  assert.notEqual(sessionStartMinute(''), 0, 'minute 0 is MIDNIGHT — that is the whole bug')
})

test('sessionStartMinute honours an EXPLICIT time exactly, including one before the bell', () => {
  // Not clamped: an operator who typed 0914 wants to be ready before the open,
  // and only the implicit "" case was ever ambiguous.
  assert.equal(sessionStartMinute('0914'), 554)
  assert.equal(sessionStartMinute('0918'), 558)
  assert.equal(sessionStartMinute('1530'), 930)
})

test('garbage still means "as soon as possible", and is floored the same way', () => {
  // `autostartMinute` maps unparseable input to 0 so a typo cannot make a
  // strategy silently never run. That fallback must not reintroduce midnight.
  assert.equal(sessionStartMinute('9:14'), MARKET_OPEN_MIN)
})

// ---------------------------------------------------------------- lifecycle

test('autostart starts at boot; delay_start waits for its own IST minute', async () => {
  const h = harness({
    rows: [row({ tag: 'AUTO', autostartAt: '' }), row({ tag: 'LATE', autostartAt: '0918' })],
    nowMs: ist(9, 16),
  })
  await h.runner.sync()
  assert.deepEqual(
    h.runner.snapshots().map((s) => s.state),
    ['waiting', 'waiting'],
  )

  await h.runner.tick()
  const afterBoot = new Map(h.runner.snapshots().map((s) => [s.tag, s.state]))
  assert.equal(afterBoot.get('AUTO'), 'running')
  assert.equal(afterBoot.get('LATE'), 'waiting', '09:18 has not arrived yet')

  h.clock.set(ist(9, 18))
  await h.runner.tick()
  const afterDelay = new Map(h.runner.snapshots().map((s) => [s.tag, s.state]))
  assert.equal(afterDelay.get('LATE'), 'running')
})

/**
 * THE MIDNIGHT START, end to end. This is the regression that matters — the
 * pure function above only proves the arithmetic.
 */
test('the IST day roll does NOT start an "as soon as possible" strategy at midnight', async () => {
  // 23:59, the previous session long over.
  const h = harness({ rows: [row({ tag: 'AUTO', autostartAt: '' })], nowMs: ist(23, 59) })
  await h.runner.sync()
  await h.runner.tick()

  // Midnight: `tick()` sees a new IST day and rolls the session, which resets
  // every strategy to `waiting`. On prod this is the instant they all started.
  h.clock.set(ist(24, 0))
  await h.runner.tick()
  assert.equal(
    new Map(h.runner.snapshots().map((s) => [s.tag, s.state])).get('AUTO'),
    'waiting',
    'a strategy whose config says 09:15 must not be running at 00:00',
  )
})

test('and it starts on its own at the open, without needing a restart to get there', async () => {
  const h = harness({ rows: [row({ tag: 'AUTO', autostartAt: '' })], nowMs: ist(23, 59) })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(24, 0))
  await h.runner.tick()

  h.clock.set(ist(9, 15))
  await h.runner.tick()
  assert.equal(
    new Map(h.runner.snapshots().map((s) => [s.tag, s.state])).get('AUTO'),
    'running',
    'the floor delays the start to the open — it must not cancel it',
  )
})

test('a delay_start already in the past starts immediately — a 12:30 restart comes up ready', async () => {
  const h = harness({ rows: [row({ tag: 'LATE', autostartAt: '0918' })], nowMs: ist(12, 30) })
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'running')
})

test('day end squares off and STOPS — a state transition, not process.exit()', async () => {
  const h = harness({ nowMs: ist(9, 16) })
  await h.runner.sync()
  await h.runner.tick()

  // Open a position so there is something to square off.
  h.clock.set(ist(9, 20, 1))
  await h.runner.tick()
  const strategy = h.built.get('A:paper')
  assert.ok(strategy?.position !== null, 'the entry job should have opened a position')

  h.clock.set(ist(15, 30))
  await h.runner.tick()

  assert.equal(h.runner.snapshots()[0]?.state, 'squared-off')
  const orders = h.gateways.get('A:paper')?.orders ?? []
  assert.equal(orders.length, 2)
  assert.equal(orders[1]?.side, 'SELL', 'day end must square the position off')
  assert.equal(strategy?.position, null)
  // And the process is still alive: `stop()` is a transition, so the runner can
  // report the state instead of pm2 reporting an exit.
  assert.equal(strategy?.isStopped, true)
})

test('a strategy is not started after day end — it would catch up and immediately square off', async () => {
  const h = harness({ nowMs: ist(16, 0) })
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'waiting')
  assert.equal(h.gateways.size, 0)
})

test('a new IST day rebuilds the strategy and reopens the session', async () => {
  /**
   * FRIDAY 15:00, NOT 15:30. The version of this test that started at 15:30
   * never got past `#maybeStart`'s day-end guard, so no strategy was ever
   * constructed: `#rollSession`'s `s.strategy = null` nulled an already-null
   * field, and `h.built.get(...)?.isStopped` read `undefined?.isStopped`, which
   * is `undefined` and not `false`... so the last assertion held for a strategy
   * that did not exist. Deleting the rebuild left it green.
   *
   * What production actually does is start Friday, run, and stop at 15:30 —
   * and `StrategyBase` has no un-stop, deliberately. So if the rebuild is
   * dropped, Monday reuses Friday's STOPPED object and `submit()` answers
   * `{ accepted: false, reason: 'strategy stopped' }` to every order for the
   * rest of the week, while the runtime row cheerfully says `running`.
   */
  const h = harness({ nowMs: ist(15, 0) })
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'running')
  const friday = h.built.get('A:paper')
  assert.ok(friday !== undefined, 'Friday must actually build a strategy')

  // Friday 15:30: the session ends and the instance is stopped for good.
  h.clock.set(ist(15, 30))
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'squared-off')
  assert.equal(friday.isStopped, true)

  // Monday 09:16 IST.
  h.clock.set(Date.UTC(2026, 6, 27, 3, 46))
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'running')
  const monday = h.built.get('A:paper')
  assert.ok(monday !== undefined)
  assert.notEqual(monday, friday, 'Monday must be a FRESH instance, not Friday reawakened')
  assert.equal(monday.isStopped, false)

  // And the proof that matters: Monday's entry job can actually place an order.
  // On Friday's stopped instance this submit is refused with 'strategy stopped'
  // and the gateway records nothing.
  h.clock.set(Date.UTC(2026, 6, 27, 3, 50, 1)) // Monday 09:20:01 IST
  await h.runner.tick()
  assert.equal(monday.entryAttempts, 1)
  assert.equal(h.gateways.get('A:paper')?.orders.length, 1, "Monday's order must reach the rail")
})

// ---------------------------------------------------------------- weekends

/**
 * THE CLOCK ALONE CANNOT TELL A SATURDAY FROM A TUESDAY.
 *
 * `#maybeStart` gated on the minute-of-day only, so at 09:15 on a Saturday every
 * switched-on paper strategy started, ran its cron jobs against a dead feed and
 * sat there `running` until 15:30 — with the portal showing a green badge all
 * weekend, which is the one word an operator trusts before touching anything.
 */
test('a Saturday starts nothing — the minute of day is right and the day is not', async () => {
  const h = harness({ rows: [row({ tag: 'AUTO', autostartAt: '' })], nowMs: sat(9, 16) })
  await h.runner.sync()
  await h.runner.tick()

  assert.equal(h.runner.snapshots()[0]?.state, 'waiting')
  // Nothing was even CONSTRUCTED: a built strategy has a gateway, and a gateway
  // is the thing an order would reach.
  assert.equal(h.gateways.size, 0)
})

test('and it stays waiting through the whole weekend, not just at the open', async () => {
  const h = harness({ rows: [row({ tag: 'AUTO', autostartAt: '' })], nowMs: sat(9, 16) })
  await h.runner.sync()
  for (const at of [sat(9, 16), sat(12, 0), sun(11, 0), sun(15, 29)]) {
    h.clock.set(at)
    await h.runner.tick()
    assert.equal(h.runner.snapshots()[0]?.state, 'waiting', `still waiting at ${new Date(at).toISOString()}`)
  }
  assert.equal(h.gateways.size, 0)
})

/**
 * An EXPLICIT autostart is not a way around the calendar. `sessionStartMinute`
 * honours a typed time exactly — an operator who wants to be ready before the
 * bell has a reason — but "before the bell" is still a weekday concept.
 */
test('an explicit autostart time does not override the weekend', async () => {
  const h = harness({ rows: [row({ tag: 'LATE', autostartAt: '0918' })], nowMs: sat(9, 18) })
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'waiting')
})

test('Monday starts exactly as it always did', async () => {
  const h = harness({ rows: [row({ tag: 'AUTO', autostartAt: '' })], nowMs: mon(9, 16) })
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'running')
})

/**
 * The weekend guard must not move DAY END. Friday's 15:30 square-off is the
 * backstop that keeps a position from being carried into the weekend, and it
 * runs on the exit path — which is deliberately NOT weekday-gated, because a
 * flatten that failed on Friday has to keep being retried until it works.
 */
test('Friday 15:30 still ends the day, and the weekend that follows never restarts it', async () => {
  const h = harness({ nowMs: ist(15, 0) })
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'running')
  const friday = h.built.get('A:paper')

  h.clock.set(ist(15, 30))
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'squared-off')

  // Saturday: the IST day roll resets it to `waiting`, and it stays there. The
  // roll is the moment prod used to hand every "" strategy a fresh session.
  h.clock.set(sat(9, 16))
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'waiting')
  assert.equal(h.built.get('A:paper'), friday, 'nothing new was built over the weekend')
  assert.equal(friday?.isStopped, true)

  // Monday: the session opens normally, on a FRESH instance.
  h.clock.set(mon(9, 16))
  await h.runner.tick()
  assert.equal(h.runner.snapshots()[0]?.state, 'running')
  assert.notEqual(h.built.get('A:paper'), friday)
})

// --------------------------------------------------------------- cron jobs

test('a cron job fires when its occurrence falls inside the tick window', async () => {
  const h = harness({ nowMs: ist(9, 16, 30) })
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.built.get('A:paper')?.entryAttempts, 0)

  h.clock.set(ist(9, 20, 2))
  await h.runner.tick()
  assert.equal(h.built.get('A:paper')?.entryAttempts, 1)
  assert.equal(h.gateways.get('A:paper')?.orders.length, 1)
})

test('a LATE tick still fires the occurrence it slept through', async () => {
  // The interval driving tick() can be delayed by event-loop pressure. Matching
  // on "does the cron fire right now" would drop a 13:31 entry deadline — a
  // day's trading — so the runner evaluates a WINDOW.
  const h = harness({ nowMs: ist(9, 16, 30) })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 45)) // 25 minutes late
  await h.runner.tick()
  assert.equal(h.built.get('A:paper')?.entryAttempts, 1)
})

test('a job does not double-fire across two ticks in the same gap', async () => {
  const h = harness({ nowMs: ist(9, 16, 30) })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 20, 2))
  await h.runner.tick()
  h.clock.set(ist(9, 20, 30))
  await h.runner.tick()
  assert.equal(h.gateways.get('A:paper')?.orders.length, 1)
})

// ---------------------------------------------------------- restart recovery

test('a mid-session restart reconstructs the open position and does NOT re-enter', async () => {
  const states = new Map<string, StateStore>()

  // --- session, up to the entry ---
  const first = harness({ nowMs: ist(9, 16), states })
  await first.runner.sync()
  await first.runner.tick()
  first.clock.set(ist(9, 20, 1))
  await first.runner.tick()
  assert.equal(first.gateways.get('A:paper')?.orders.length, 1)
  assert.deepEqual(first.built.get('A:paper')?.position, {
    symbol: INSTRUMENT.tradingsymbol,
    lots: 2,
    entryPrice: 100,
  })

  // --- the process dies and comes back at 12:30, sharing only the StateStore ---
  const second = harness({ nowMs: ist(12, 30), states })
  await second.runner.sync()
  await second.runner.tick()

  const recovered = second.built.get('A:paper')
  assert.ok(recovered !== undefined)
  // Half one: the position is back.
  assert.deepEqual(recovered.position, {
    symbol: INSTRUMENT.tradingsymbol,
    lots: 2,
    entryPrice: 100,
  })
  // Half two, and the one that costs money if it is wrong: the entry job was
  // already due at 12:30, but it is `replayable: false`, so catch-up SUPPRESSED
  // it. A replay here would open a second 2-lot position on top of the one just
  // recovered.
  assert.equal(recovered.entryAttempts, 0)
  assert.equal(second.gateways.get('A:paper')?.orders.length, 0)
  assert.ok(
    second.logs.some((l) => l.msg.includes("not replay-safe")),
    'the suppression should be logged, not silent',
  )

  // ...and the recovered position is a REAL one: day end closes it.
  second.clock.set(ist(15, 30))
  await second.runner.tick()
  const orders = second.gateways.get('A:paper')?.orders ?? []
  assert.equal(orders.length, 1)
  assert.equal(orders[0]?.side, 'SELL')
  assert.equal(orders[0]?.lots, 2)
})

test('replay-SAFE setup jobs ARE caught up on a restart', async () => {
  const h = harness({ nowMs: ist(12, 30) })
  await h.runner.sync()
  await h.runner.tick()
  // 09:16 is long past, and recomputing a band places no order.
  assert.equal(h.built.get('A:paper')?.setupRuns, 1)
})

// ------------------------------------------------------------- registry sync

test('only switched-on HOSTED rows are supervised', async () => {
  const h = harness({
    rows: [
      row({ tag: 'ON', kind: 'hosted', modes: { paper: { enabled: true } } }),
      row({ tag: 'OFF', kind: 'hosted', modes: { paper: { enabled: false } } }),
      row({ tag: 'PYTHON', kind: 'external', modes: { paper: { enabled: true } } }),
    ],
  })
  await h.runner.sync()
  assert.deepEqual(
    h.runner.snapshots().map((s) => s.tag),
    ['ON'],
  )
})

test('switching a strategy off mid-session squares it off rather than abandoning it', async () => {
  const h = harness({ rows: [row({ tag: 'A' })], nowMs: ist(9, 16) })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 20, 1))
  await h.runner.tick()
  assert.equal(h.gateways.get('A:paper')?.orders.length, 1)

  h.setRows([row({ tag: 'A', modes: { paper: { enabled: false } } })])
  await h.runner.sync()

  assert.equal(h.runner.snapshots().length, 0)
  const orders = h.gateways.get('A:paper')?.orders ?? []
  assert.equal(orders.length, 2)
  assert.equal(orders[1]?.side, 'SELL', 'an unsupervised position must not be left open')
})

test('a registry read failure keeps the running set rather than stopping everything', async () => {
  const h = harness({ nowMs: ist(9, 16) })
  await h.runner.sync()
  await h.runner.tick()
  const runner = new Runner({
    clock: h.clock,
    log: makeLogger(h.logs),
    factory: { create: () => null },
    loadRows: async () => {
      throw new Error('mongo unreachable')
    },
  })
  await runner.sync()
  // The failing runner has nothing, but the point is it did not throw.
  assert.deepEqual(runner.snapshots(), [])
  assert.equal(h.runner.snapshots()[0]?.state, 'running')
})

// ------------------------------------------------------------- fault isolation

test("a throw in the RUNNER's own bookkeeping is parked on that strategy alone", async () => {
  /**
   * `jobs()`, not `job.run()`, and the difference is the whole test.
   *
   * `StrategyBase` guards everything it invokes, so a throw inside a job's
   * `run` never escapes the strategy — which means the version of this test
   * that used `explodeOnSetup` proved only that the BASE contains its own
   * errors. Deleting both of `Runner.#guarded`'s wrappers and calling
   * `await fn()` bare left it passing. `jobs()` is called by `#fireDueJobs`
   * directly, so a throw there can only be caught by the runner, and that is
   * the isolation this test is named for.
   */
  const h = harness({ rows: [row({ tag: 'BAD' }), row({ tag: 'GOOD' })], nowMs: ist(9, 15) })
  await h.runner.sync()
  await h.runner.tick()
  const bad = h.built.get('BAD:paper')
  assert.ok(bad !== undefined)
  bad.explodeOnJobs = true

  h.clock.set(ist(9, 16, 2))
  // The tick itself must RESOLVE. Without the runner's guard this rejects, and
  // in production that takes down the whole `setInterval` callback — every
  // other strategy's cron window and every other strategy's square-off with it.
  await h.runner.tick()

  // The neighbour ran its own job normally.
  assert.equal(h.built.get('GOOD:paper')?.setupRuns, 1)
  const snaps = new Map(h.runner.snapshots().map((s) => [s.tag, s]))
  assert.equal(snaps.get('GOOD')?.state, 'running')
  // ...and the failure is PARKED ON THE ROW, with the message, which is what
  // the strategies page renders instead of a silently wedged strategy.
  assert.equal(snaps.get('BAD')?.state, 'failed')
  assert.match(snaps.get('BAD')?.lastError ?? '', /jobs\(\) blew up/)
})

test('a throw inside a job is contained by the base and costs the strategy nothing', async () => {
  // The complement of the test above: `StrategyBase` catches this one, so the
  // strategy stays `running`. Both are worth having — what is not worth having
  // is one test that claims to prove the second and only proves the first.
  const h = harness({ rows: [row({ tag: 'BAD' }), row({ tag: 'GOOD' })], nowMs: ist(9, 15) })
  await h.runner.sync()
  await h.runner.tick()
  h.built.get('BAD:paper')!.explodeOnSetup = true

  h.clock.set(ist(9, 16, 2))
  await h.runner.tick()

  assert.equal(h.built.get('GOOD:paper')?.setupRuns, 1)
  const states = new Map(h.runner.snapshots().map((s) => [s.tag, s.state]))
  assert.equal(states.get('GOOD'), 'running')
  assert.equal(states.get('BAD'), 'running')
})

test('a strategy that cannot be constructed is parked in failed, not retried into a crash loop', async () => {
  const h = harness({
    rows: [row({ tag: 'BROKEN' }), row({ tag: 'FINE' })],
    throwFor: new Set(['BROKEN']),
  })
  await h.runner.sync()
  await h.runner.tick()
  const states = new Map(h.runner.snapshots().map((s) => [s.tag, s.state]))
  assert.equal(states.get('BROKEN'), 'failed')
  assert.equal(states.get('FINE'), 'running')
  const broken = h.runner.snapshots().find((s) => s.tag === 'BROKEN')
  assert.match(broken?.lastError ?? '', /construction failed/)
})

test('a tag with no hosted implementation reports stopped with a reason, never running', async () => {
  const h = harness({
    rows: [row({ tag: 'MIRROR_1PBUY' })],
    unimplemented: new Set(['MIRROR_1PBUY']),
  })
  await h.runner.sync()
  await h.runner.tick()
  const snap = h.runner.snapshots()[0]
  assert.equal(snap?.state, 'stopped')
  assert.match(snap?.lastError ?? '', /no hosted implementation/)
})

// ------------------------------------------------------------- tick routing

test('ticks only reach a RUNNING strategy, and an unknown tag is dropped', async () => {
  const h = harness({ nowMs: ist(9, 16) })
  await h.runner.sync()
  const quote: Quote = { token: 1234, lastPrice: 101, ts: ist(9, 16) }

  // `waiting`: the strategy has not even been constructed, so there is nothing
  // to deliver to and nothing to throw.
  h.runner.handleTick('A', quote)
  assert.equal(h.built.size, 0)

  await h.runner.tick()
  h.runner.handleTick('A', quote)
  await h.built.get('A:paper')?.drain()
  assert.equal(h.built.get('A:paper')?.ticksSeen, 1)

  // A tag nobody is supervising is ignored rather than crashing the feed loop.
  h.runner.handleTick('NOT_A_TAG', quote)
  assert.equal(h.built.get('A:paper')?.ticksSeen, 1)
})

// ---------------------------------------------------------- runtime snapshot

test('snapshots carry the four fields the strategies page renders', async () => {
  const h = harness({ nowMs: ist(9, 16) })
  await h.runner.sync()
  await h.runner.tick()
  const snap = h.runner.snapshots()[0]
  assert.ok(snap !== undefined)
  assert.equal(snap.tag, 'A')
  assert.equal(snap.state, 'running')
  assert.equal(snap.startedAt, ist(9, 16))
  assert.equal(snap.lastError, null)
  assert.equal(snap.openPositions, 0)
})

test('snapshots are published to whoever the runner was given', async () => {
  const published: string[] = []
  const clock = fixedClock(ist(9, 16))
  const runner = new Runner({
    clock,
    log: makeLogger(),
    factory: { create: () => null },
    loadRows: async () => [row({ tag: 'X' })],
    publish: async (snaps) => {
      published.push(...snaps.map((s) => `${s.tag}:${s.state}`))
    },
  })
  await runner.sync()
  assert.deepEqual(published, ['X:waiting'])
})

test('a publish failure never stops a tick — the strategies matter more than the status', async () => {
  const clock = fixedClock(ist(9, 16))
  const runner = new Runner({
    clock,
    log: makeLogger(),
    factory: { create: () => null },
    loadRows: async () => [row({ tag: 'X' })],
    publish: async () => {
      throw new Error('mongo down')
    },
  })
  await runner.sync()
  await runner.tick()
  assert.equal(runner.snapshots().length, 1)
})

// ------------------------------------------------------------------ shutdown

test('stopAll squares off every strategy', async () => {
  const h = harness({ nowMs: ist(9, 16) })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 20, 1))
  await h.runner.tick()

  await h.runner.stopAll('SIGTERM shutdown')
  const orders = h.gateways.get('A:paper')?.orders ?? []
  assert.equal(orders.length, 2)
  assert.equal(orders[1]?.side, 'SELL')
})
