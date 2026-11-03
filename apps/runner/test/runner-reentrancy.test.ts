/**
 * RE-ENTRANCY: what happens when two passes of the runner overlap.
 *
 * `main.ts` drives `tick()` from a 1-second interval and `sync()` from a
 * 15-second one, and neither waits for the previous pass — so any await inside
 * them (a flatten is several HTTP round trips) lets a second pass in on top of
 * the first. `#stopOne` writes `state`/`retryExitAtMs` only on RETURN, so the
 * second pass still reads `running` and still reads a ledger holding the legs
 * the first is mid-closing: it reverses them a second time, under fresh
 * `clientOrderId`s, and the square-off backstop itself opens a short nobody
 * will ever close (audit F-7).
 *
 * The tests below drive that overlap deliberately: every flatten here BLOCKS on
 * a gate the test releases, which is what a 1.5-second real flatten looks like
 * to a 1-second interval.
 *
 * `stopAll` is here for the same reason from the other end (F-37): it is the
 * SIGTERM path and `main.ts` hard-exits 15 seconds later, so an instance that
 * is only ATTEMPTED after every instance before it has finished is an instance
 * that, on a slow bridge, is never attempted at all.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import {
  makeLogger,
  MemoryStateStore,
  RecordingGateway,
  StrategyBase,
  type CapturedLog,
  type InstrumentRef,
  type JobSpec,
  type MarketData,
  type Quote,
  type StrategyContext,
} from '@algomaker/strategy-kit'
import { HttpOrderGateway, PositionLedger } from '../src/order-gateway.ts'
import {
  Runner,
  type HostedInstance,
  type HostedRow,
  type RunMode,
  type StrategyFactory,
} from '../src/runner.ts'

/** Friday 2026-07-24. IST = UTC + 05:30, no DST, so the arithmetic is exact. */
const ist = (h: number, m: number, s = 0): number => Date.UTC(2026, 6, 24, h - 5, m - 30, s)

const OPTION: InstrumentRef = {
  tradingsymbol: 'BANKNIFTY26AUG56000CE',
  instrumentToken: 900_001,
  lotSize: 35,
  tickSize: 0.05,
  exchange: 'NFO',
}

/** Let every pending microtask AND the flatten's first await run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * A strategy with the production shape: no `onDayEnd`, no `onRecover`, no
 * jobs. It places nothing, so every order in these tests comes from the
 * runner's own backstop — which is the thing being guarded.
 */
class QuietStrategy extends StrategyBase {
  dataNeeds(): [] {
    return []
  }

  jobs(): readonly JobSpec[] {
    return []
  }

  protected onTick(_quote: Quote): void {}
}

function emptyMarketData(): MarketData {
  return {
    quote: () => null,
    candles: async () => [],
    option: () => null,
    selectOption: () => null,
    future: () => null,
    atmStrike: () => 0,
    spotToken: () => 1,
  }
}

function row(tag: string, enabled = true): HostedRow {
  return {
    tag,
    kind: 'hosted',
    modes: { paper: { enabled } },
    liveLots: 0,
    autostartAt: '',
  }
}

/**
 * A fake `PositionBackstop` whose flatten BLOCKS until the test releases it,
 * and which keeps reporting the position open until it does — exactly as the
 * real ledger does, since a leg is only removed once its reversing order has
 * been accepted.
 */
interface FakeBackstop {
  /** One entry per `flattenAll` call, in order, as `tag:mode`. */
  readonly attempts: string[]
  openCount(tag: string, mode: RunMode): number
  flattenAll(tag: string, mode: RunMode, reason: string): Promise<void>
  /** Let every blocked flatten finish. */
  release(): void
}

function backstop(opts: { readonly tags: readonly string[]; readonly blocked?: readonly string[] }): FakeBackstop {
  const open = new Map(opts.tags.map((t) => [t, 1]))
  const attempts: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const blocked = new Set(opts.blocked ?? opts.tags)
  return {
    attempts,
    openCount: (tag) => open.get(tag) ?? 0,
    flattenAll: async (tag, mode) => {
      attempts.push(`${tag}:${mode}`)
      if (blocked.has(tag)) await gate
      open.set(tag, 0)
    },
    release: () => release(),
  }
}

interface Harness {
  readonly runner: Runner
  readonly clock: ReturnType<typeof fixedClock>
  readonly logs: CapturedLog[]
  readonly loads: () => number
  setRows(rows: readonly HostedRow[]): void
}

function harness(opts: {
  readonly rows: readonly HostedRow[]
  readonly positions?: FakeBackstop
  readonly loadDelay?: () => Promise<void>
}): Harness {
  const clock = fixedClock(ist(9, 16))
  const logs: CapturedLog[] = []
  const log = makeLogger(logs)
  let rows = opts.rows
  let loads = 0

  const factory: StrategyFactory = {
    create(r: HostedInstance) {
      const ctx: StrategyContext = {
        tag: r.tag,
        clock,
        md: emptyMarketData(),
        // The strategy places nothing; every order in these tests is the
        // runner's own backstop, which goes through `positions`, not here.
        orders: new RecordingGateway(),
        fills: { onFill: () => () => {} },
        state: new MemoryStateStore(),
        log,
        mode: r.mode === 'live' ? 'live' : 'sim',
        destinations: r.mode === 'live' ? ['xts'] : ['sim'],
        feed: { isTrustworthy: () => true, reason: () => null },
      }
      return new QuietStrategy(ctx)
    },
  }

  const runner = new Runner({
    clock,
    log,
    factory,
    loadRows: async () => {
      loads += 1
      if (opts.loadDelay !== undefined) await opts.loadDelay()
      return rows
    },
    ...(opts.positions === undefined
      ? {}
      : {
          positions: {
            openCount: opts.positions.openCount,
            flattenAll: opts.positions.flattenAll,
          },
        }),
  })

  return {
    runner,
    clock,
    logs,
    loads: () => loads,
    setRows: (next) => {
      rows = next
    },
  }
}

/** Sync, start, and put the instance in `running` before day end. */
async function running(h: Harness): Promise<void> {
  await h.runner.sync()
  await h.runner.tick()
}

// ------------------------------------------------------------------ F-7

test('concurrent day-end ticks flatten exactly once', async () => {
  const positions = backstop({ tags: ['T1'] })
  const h = harness({ rows: [row('T1')], positions })
  await running(h)

  h.clock.set(ist(15, 30))
  const first = h.runner.tick()
  await settle()
  assert.deepEqual(positions.attempts, ['T1:paper'], 'the first tick is mid-flatten')

  // The interval does not wait for the previous pass, and the ledger still
  // shows the legs the first pass is closing.
  const second = h.runner.tick()
  await settle()
  positions.release()
  await Promise.all([first, second])

  assert.deepEqual(positions.attempts, ['T1:paper'], 'the second tick must not reverse the same legs again')
})

test('a sync arriving mid-flatten does not flatten the same legs a second time', async () => {
  // The tick guard cannot help here: `sync()` is a different entry point on a
  // different interval, and its switched-off branch calls `#stopOne` directly.
  const positions = backstop({ tags: ['T1'] })
  const h = harness({ rows: [row('T1')], positions })
  await running(h)

  h.clock.set(ist(15, 30))
  const exiting = h.runner.tick()
  await settle()
  assert.deepEqual(positions.attempts, ['T1:paper'])

  h.setRows([row('T1', false)])
  const syncing = h.runner.sync()
  await settle()
  positions.release()
  await Promise.all([exiting, syncing])

  assert.deepEqual(positions.attempts, ['T1:paper'])
  assert.equal(
    h.runner.snapshots().length,
    1,
    'and the instance is not forgotten while its flatten is still in flight',
  )
})

test('overlapping syncs read the registry once', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const h = harness({ rows: [row('T1')], loadDelay: async () => gate })

  const first = h.runner.sync()
  const second = h.runner.sync()
  release()
  await Promise.all([first, second])

  assert.equal(h.loads(), 1, 'the second pass must not reconcile against a set the first is rebuilding')
})

// ----------------------------------------------------------------- F-37

test('stopAll attempts every instance even while one flatten is still in flight', async () => {
  // Serially, T2 and T3 are only reached once T1's flatten resolves — and on
  // the SIGTERM path `main.ts` hard-exits 15 seconds later regardless, so a
  // bridge that is merely slow means the tags at the back are never attempted.
  const positions = backstop({ tags: ['T1', 'T2', 'T3'], blocked: ['T1'] })
  const h = harness({ rows: [row('T1'), row('T2'), row('T3')], positions })
  await running(h)

  const stopping = h.runner.stopAll('SIGTERM shutdown')
  await settle()
  assert.deepEqual(
    [...positions.attempts].sort(),
    ['T1:paper', 'T2:paper', 'T3:paper'],
    'every instance is attempted, not just the ones before the slow one',
  )

  positions.release()
  await stopping
  assert.deepEqual(
    h.runner.snapshots().map((s) => s.state),
    ['squared-off', 'squared-off', 'squared-off'],
  )
})

// ------------------------------------- F-38: a guard that DROPS is a truncated exit

test('a second stopOne caller AWAITS the in-flight flatten rather than resolving early', async () => {
  /**
   * The re-entrancy guard must not be a `return` that resolves immediately.
   * `stopAll` is the SIGTERM path, and `main.ts` closes mongo and calls
   * `process.exit(0)` the moment it resolves — so a guard that hands back a
   * resolved promise while the tick path's flatten is still on the wire kills
   * the process mid-flatten, under a log line that says the book is closed.
   *
   * Exactly one flatten, and every caller waits for THAT one.
   */
  const positions = backstop({ tags: ['T1'] })
  const h = harness({ rows: [row('T1')], positions })
  await running(h)

  h.clock.set(ist(15, 30))
  const exiting = h.runner.tick()
  await settle()
  assert.deepEqual(positions.attempts, ['T1:paper'], 'the tick path is mid-flatten')

  let stopped = false
  const stopping = h.runner.stopAll('SIGTERM shutdown').then(() => {
    stopped = true
  })
  await settle()
  await settle()
  assert.equal(stopped, false, 'stopAll must not resolve while the flatten it deferred to is on the wire')

  positions.release()
  await Promise.all([exiting, stopping])

  assert.equal(stopped, true)
  assert.deepEqual(positions.attempts, ['T1:paper'], 'and it waited rather than placing a second set of orders')
  assert.deepEqual(
    h.runner.snapshots().map((s) => s.state),
    ['squared-off'],
    'so the state main.ts reads afterwards is the settled one, not `running`',
  )
})

test('quiesce waits for an in-flight tick flatten', async () => {
  // The shutdown handler's own bound on the same hazard: whatever it does
  // next — square off, or log the book it is deliberately leaving open — it
  // must not do it while an exit it did not start is still in flight.
  const positions = backstop({ tags: ['T1'] })
  const h = harness({ rows: [row('T1')], positions })
  await running(h)

  h.clock.set(ist(15, 30))
  const exiting = h.runner.tick()
  await settle()
  assert.deepEqual(positions.attempts, ['T1:paper'])

  let quiet = false
  const quiesced = h.runner.quiesce().then(() => {
    quiet = true
  })
  await settle()
  await settle()
  assert.equal(quiet, false, 'quiesce is pending while the flatten is on the wire')

  positions.release()
  await Promise.all([exiting, quiesced])

  assert.equal(quiet, true)
  assert.deepEqual(positions.attempts, ['T1:paper'], 'quiesce WAITS; it does not start a flatten of its own')

  // With nothing in flight it is a no-op, which is the common case: a signal
  // arriving at 11:00 with every strategy simply running.
  await h.runner.quiesce()
  assert.deepEqual(positions.attempts, ['T1:paper'])
})

// ------------------------------------------------- the gateway's own guard

test('HttpOrderGateway.flattenAll refuses re-entry while one is in flight', async () => {
  /**
   * The ledger is shared state between overlapping flattens: both passes read
   * the same open legs and both submit a reversing order for each of them. The
   * runner's guards are the first line; this is the one that holds when
   * anything else (a mirror, an admin call) reaches the same gateway.
   */
  const clock = fixedClock(ist(15, 30))
  const logs: CapturedLog[] = []
  const log = makeLogger(logs)
  const posted: { readonly side: string; readonly flatten: string | null }[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, never>
    const meta = body['meta'] as unknown as Record<string, string> | undefined
    posted.push({ side: String(body['side']), flatten: meta?.['flatten'] ?? null })
    if (meta?.['flatten'] !== undefined) await gate
    const text = JSON.stringify({
      accepted: true,
      clientOrderId: 'x',
      orders: [{ clientOrderId: 'x#0', lots: Number(body['lots']), qty: Number(body['lots']) * 35 }],
      replayed: false,
      lots: Number(body['lots']),
      requestedLots: Number(body['lots']),
      freezeMaxLots: null,
      errors: [],
    })
    return { ok: true, status: 200, text: async () => text }
  }) as unknown as typeof globalThis.fetch

  const gateway = new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'T1',
    mode: 'paper',
    underlying: 'BANKNIFTY',
    clock,
    log,
    ledger: new PositionLedger(new MemoryStateStore()),
    state: new MemoryStateStore(),
    fetch: fetchImpl,
  })

  await gateway.submit({ instrument: OPTION, side: 'BUY', lots: 2, referencePrice: 100 })
  assert.equal(posted.length, 1)

  const first = gateway.flattenAll('day end')
  await settle()
  const second = gateway.flattenAll('day end')
  await settle()
  release()
  await Promise.all([first, second])

  assert.equal(
    posted.filter((p) => p.flatten !== null).length,
    1,
    'one reversing order for the one open leg, however many callers overlap',
  )
  assert.ok(
    logs.some((l) => l.msg.includes('flatten already in progress')),
    'and the refusal is said out loud',
  )
})
