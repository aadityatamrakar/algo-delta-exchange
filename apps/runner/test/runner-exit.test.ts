/**
 * THE EXIT PATHS — what happens to an open position at day end, on operator
 * switch-off, on a mode change, on session rollover and on shutdown.
 *
 * `runner.test.ts` covers scheduling, and its fixture squares itself off in
 * `onDayEnd`. NO CLASS IN `packages/strategies` DID, which is why the runner
 * reporting `squared-off` over a silent no-op — `endDay()` and `stop()` both
 * returning, nothing placed, the ledger untouched and `flattenAll()` never
 * called by anything — was invisible for a whole phase. So everything here is
 * driven either by a fixture with the PRODUCTION shape (no `onDayEnd`
 * override) or by a real catalogue class, through the real `HttpOrderGateway`
 * and the real `PositionLedger`, against a fake bridge that records what
 * actually went out on the wire.
 *
 * The rule every test below encodes: NEVER REPORT AN EXIT THAT DID NOT HAPPEN.
 * A state transition claiming a position was closed has to be backed by an
 * accepted order or an empty ledger, and when it is not, the state is `failed`
 * with the reason — never `squared-off`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import {
  makeLogger,
  MemoryStateStore,
  StrategyBase,
  type Candle,
  type CapturedLog,
  type InstrumentRef,
  type JobSpec,
  type Logger,
  type MarketData,
  type Quote,
  type StrategyContext,
} from '@algomaker/strategy-kit'
import { CATALOGUE } from '../src/catalogue.ts'
import { HttpOrderGateway, PositionLedger } from '../src/order-gateway.ts'
import { MongoStateStore } from '../src/state-store.ts'
import {
  instanceKey,
  Runner,
  type HostedInstance,
  type HostedRow,
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

// ------------------------------------------------------------- the fake bridge

/** One POST to `/v1/desk/submit`, flattened to what these tests assert on. */
interface Posted {
  readonly tag: string
  readonly mode: string
  readonly side: string
  readonly lots: number
  readonly tradingsymbol: string
  readonly reducesExposure: boolean
  /** `meta.flatten`, i.e. the order came from the runner's backstop, not the strategy. */
  readonly flatten: string | null
}

class FakeBridge {
  readonly posted: Posted[] = []
  /** Return a reason to refuse the next submit, or null to accept it. */
  refuse: (p: Posted) => string | null = () => null
  /** Lots the bridge claims actually ROUTED. Default: all of them. */
  routedLots: (p: Posted) => number = (p) => p.lots

  get exits(): readonly Posted[] {
    return this.posted.filter((p) => p.reducesExposure)
  }

  get fetch(): typeof globalThis.fetch {
    return (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, never>
      const instrument = body['instrument'] as unknown as InstrumentRef
      const meta = body['meta'] as unknown as Record<string, string> | undefined
      const p: Posted = {
        tag: String(body['tag']),
        mode: String(body['mode']),
        side: String(body['side']),
        lots: Number(body['lots']),
        tradingsymbol: instrument.tradingsymbol,
        reducesExposure: body['reducesExposure'] === true,
        flatten: meta?.['flatten'] ?? null,
      }
      this.posted.push(p)
      const refusal = this.refuse(p)
      const routed = this.routedLots(p)
      const payload =
        refusal !== null
          ? { accepted: false, clientOrderId: 'x', reason: refusal }
          : {
              accepted: true,
              clientOrderId: 'x',
              orders: [{ clientOrderId: 'x#0', lots: routed, qty: routed * 35 }],
              replayed: false,
              lots: p.lots,
              requestedLots: p.lots,
              freezeMaxLots: null,
              errors: routed === p.lots ? [] : ['x#1: freeze tranche rejected'],
            }
      const text = JSON.stringify(payload)
      return { ok: true, status: 200, text: async () => text }
    }) as unknown as typeof globalThis.fetch
  }
}

/**
 * The per-INSTANCE ports, wired exactly as `main.ts` wires them: one ledger and
 * one gateway per tag AND MODE (each outlives the strategy, which is rebuilt
 * every session), and the backstop reaching the gateway for the rail it is
 * told.
 *
 * The ledger is keyed `tag:mode`, not by tag. A row switched on for both rails
 * runs two strategies against the same instrument; one ledger between them
 * would net a paper long against a live short into nothing, so `openCount`
 * would read flat and the EOD backstop would place no exit while a real
 * position sat at the broker.
 */
class Desk {
  readonly ledgers = new Map<string, PositionLedger>()
  readonly gateways = new Map<string, HttpOrderGateway>()
  readonly bridge: FakeBridge
  readonly log: Logger
  readonly clock: ReturnType<typeof fixedClock>

  constructor(bridge: FakeBridge, clock: ReturnType<typeof fixedClock>, log: Logger) {
    this.bridge = bridge
    this.clock = clock
    this.log = log
  }

  ledgerFor(tag: string, mode: 'paper' | 'live'): PositionLedger {
    const key = instanceKey(tag, mode)
    let l = this.ledgers.get(key)
    if (l === undefined) {
      l = new PositionLedger(new MemoryStateStore())
      this.ledgers.set(key, l)
    }
    return l
  }

  gatewayFor(tag: string, mode: 'paper' | 'live'): HttpOrderGateway {
    const key = `${tag}:${mode}`
    let g = this.gateways.get(key)
    if (g === undefined) {
      g = new HttpOrderGateway({
        baseUrl: 'http://bridge:8890',
        token: 'tok',
        tag,
        mode,
        underlying: 'BANKNIFTY',
        clock: this.clock,
        log: this.log,
        ledger: this.ledgerFor(tag, mode),
        state: new MemoryStateStore(),
        fetch: this.bridge.fetch,
      })
      this.gateways.set(key, g)
    }
    return g
  }

  openCount = (tag: string, mode: 'paper' | 'live'): number => this.ledgerFor(tag, mode).openCount

  flattenAll = async (tag: string, mode: 'paper' | 'live', reason: string): Promise<void> => {
    await this.gatewayFor(tag, mode).flattenAll(reason)
  }
}

// ------------------------------------------------------------------- fixtures

interface FixtureOpts {
  /** A cron for a self-square-off job, or null for a strategy that has none. */
  readonly squareOffCron: string | null
}

/**
 * A strategy with the PRODUCTION shape: it enters through the `orders` port and
 * does NOT override `onDayEnd` or `onRecover`. Every class in the catalogue
 * looked like this when the backstop was written, and that is the whole point —
 * `endDay()` on this class returns having placed nothing, so anything the
 * runner reports about the exit has to come from the ledger.
 */
class ProductionShapeStrategy extends StrategyBase {
  readonly opts: FixtureOpts
  /** Makes `jobs()` throw — the runner's own bookkeeping failing, not the base's. */
  breakJobs = false

  constructor(ctx: StrategyContext, opts: FixtureOpts) {
    super(ctx)
    this.opts = opts
  }

  dataNeeds(): [] {
    return []
  }

  jobs(): readonly JobSpec[] {
    if (this.breakJobs) throw new Error('jobs() blew up')
    const squareOff: readonly JobSpec[] =
      this.opts.squareOffCron === null
        ? []
        : [
            {
              name: 'squareOff',
              cron: this.opts.squareOffCron,
              replayable: false,
              run: async () => {
                await this.submit({
                  instrument: OPTION,
                  side: 'SELL',
                  lots: 2,
                  reducesExposure: true,
                })
              },
            },
          ]
    return [
      {
        name: 'entry',
        cron: '0 20 9 * * 1-5',
        replayable: false,
        run: async () => {
          await this.submit({ instrument: OPTION, side: 'BUY', lots: 2, referencePrice: 100 })
        },
      },
      ...squareOff,
    ]
  }

  protected onTick(_quote: Quote): void {}
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
  bridge: FakeBridge
  desk: Desk
  logs: CapturedLog[]
  built: ProductionShapeStrategy[]
  builtWith: HostedInstance[]
  setRows(rows: readonly HostedRow[]): void
  state(tag?: string, mode?: 'paper' | 'live'): string
  lastError(tag?: string, mode?: 'paper' | 'live'): string
}

function harness(
  opts: { rows?: readonly HostedRow[]; nowMs?: number; squareOffCron?: string | null } = {},
): Harness {
  const clock = fixedClock(opts.nowMs ?? ist(9, 16))
  const logs: CapturedLog[] = []
  const log = makeLogger(logs)
  const bridge = new FakeBridge()
  const desk = new Desk(bridge, clock, log)
  const built: ProductionShapeStrategy[] = []
  const builtWith: HostedInstance[] = []
  let rows: readonly HostedRow[] = opts.rows ?? [row()]

  const factory: StrategyFactory = {
    create(r: HostedInstance) {
      builtWith.push(r)
      const ctx: StrategyContext = {
        tag: r.tag,
        clock,
        md: emptyMarketData(),
        orders: desk.gatewayFor(r.tag, r.mode),
        fills: { onFill: () => () => {} },
        state: new MemoryStateStore(),
        log,
        mode: r.mode === 'live' ? 'live' : 'sim',
        destinations: r.mode === 'live' ? ['xts'] : ['sim'],
        feed: { isTrustworthy: () => true, reason: () => null },
      }
      const s = new ProductionShapeStrategy(ctx, { squareOffCron: opts.squareOffCron ?? null })
      built.push(s)
      return s
    },
  }

  const runner = new Runner({
    clock,
    log,
    factory,
    loadRows: async () => rows,
    positions: { openCount: desk.openCount, flattenAll: desk.flattenAll },
  })

  const snap = (tag: string, mode?: 'paper' | 'live') =>
    runner.snapshots().find((s) => s.tag === tag && (mode === undefined || s.mode === mode))
  return {
    runner,
    clock,
    bridge,
    desk,
    logs,
    built,
    builtWith,
    setRows: (next) => {
      rows = next
    },
    state: (tag = 'A', mode?: 'paper' | 'live') => snap(tag, mode)?.state ?? 'gone',
    lastError: (tag = 'A', mode?: 'paper' | 'live') => snap(tag, mode)?.lastError ?? '',
  }
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

/** Start the strategy and let its 09:20 entry job open a position. */
async function openAPosition(h: Harness, mode: 'paper' | 'live' = 'paper'): Promise<void> {
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 20, 1))
  await h.runner.tick()
  assert.equal(h.desk.openCount('A', mode), 1, 'the entry job should have opened a position')
}

// ------------------------------------------------------- R1: the backstop

test('day end FLATTENS what the strategy did not square off — no catalogue class overrides onDayEnd', async () => {
  const h = harness()
  await openAPosition(h)

  h.clock.set(ist(15, 30))
  await h.runner.tick()

  // The strategy placed nothing (it has no onDayEnd, like every real one), so
  // the only thing that can have closed this position is the runner's backstop.
  assert.deepEqual(
    h.bridge.exits.map((p) => [p.side, p.lots, p.flatten]),
    [['Sell', 2, 'day end']],
  )
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.state(), 'squared-off')
})

test('a flatten the bridge REFUSES is reported failed, never squared-off', async () => {
  const h = harness()
  await openAPosition(h)
  h.bridge.refuse = (p) => (p.reducesExposure ? 'no mark for this contract' : null)

  h.clock.set(ist(15, 30))
  await h.runner.tick()

  assert.equal(h.bridge.exits.length, 1, 'the flatten was attempted')
  assert.equal(h.desk.openCount('A', 'paper'), 1, 'and it did not work — the leg is still open')
  assert.equal(h.state(), 'failed')
  assert.match(h.lastError(), /1 position\(s\) still open/)
})

test('an exit that did not complete is retried until it does, not once a day', async () => {
  const h = harness()
  await openAPosition(h)
  h.bridge.refuse = (p) => (p.reducesExposure ? 'bridge down' : null)

  h.clock.set(ist(15, 30))
  await h.runner.tick()
  assert.equal(h.state(), 'failed')

  // Inside the backoff window: no second POST, because hammering a bridge that
  // is down once a second helps nobody.
  h.clock.set(ist(15, 30, 20))
  await h.runner.tick()
  assert.equal(h.bridge.exits.length, 1)

  // Past it, and with the bridge back: the position closes and the state
  // catches up with reality.
  h.bridge.refuse = () => null
  h.clock.set(ist(15, 31, 5))
  await h.runner.tick()
  assert.equal(h.bridge.exits.length, 2)
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.state(), 'squared-off')
  assert.equal(h.lastError(), '')
})

test('switching a strategy off flattens the position its onDayEnd left open', async () => {
  const h = harness()
  await openAPosition(h)

  h.clock.set(ist(12, 30))
  h.setRows([row({ modes: { paper: { enabled: false } } })])
  await h.runner.sync()

  assert.deepEqual(
    h.bridge.exits.map((p) => p.flatten),
    ['switched off in the registry'],
  )
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.runner.snapshots().length, 0, 'and only then is it forgotten')
})

test('sync honours the exit backoff — a refused switch-off flatten is not re-attempted every 15 seconds', async () => {
  /**
   * The 2026-08-04 spam loop: `sync()` runs every 15 seconds and used to call
   * `#stopOne` unconditionally for every switched-off instance, so a flatten
   * the bridge kept refusing was re-attempted (and re-logged, per leg) on
   * every pass for hours. One attempt per backoff window is the alert; the
   * repetition was only noise.
   */
  const h = harness()
  await openAPosition(h)
  h.bridge.refuse = (p) => (p.reducesExposure ? 'strategy switch: switched off' : null)

  h.clock.set(ist(12, 30))
  h.setRows([row({ modes: { paper: { enabled: false } } })])
  await h.runner.sync()
  assert.equal(h.bridge.exits.length, 1)
  assert.equal(h.state(), 'failed')

  // Two more sync passes inside the 60-second window: no new attempt.
  h.clock.set(ist(12, 30, 15))
  await h.runner.sync()
  h.clock.set(ist(12, 30, 30))
  await h.runner.sync()
  assert.equal(h.bridge.exits.length, 1, 'the backoff gates sync exactly as it gates tick')
  assert.equal(h.state(), 'failed', 'and the instance stays supervised meanwhile')

  // Past the window the retry fires — and once the refusal clears (the gate
  // fix deploys, the feed returns), the exit completes and the instance is
  // collected: `failed` is a parking state, never a dead end.
  h.bridge.refuse = () => null
  h.clock.set(ist(12, 31, 5))
  await h.runner.sync()
  assert.equal(h.bridge.exits.length, 2)
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  await h.runner.sync()
  assert.equal(h.runner.snapshots().length, 0)
})

test('the exit retry DOUBLES its backoff per failure and resets when the exit lands', async () => {
  const h = harness()
  await openAPosition(h)
  h.bridge.refuse = (p) => (p.reducesExposure ? 'bridge down' : null)

  // Attempt 1 at 15:30 re-arms at +60s.
  h.clock.set(ist(15, 30))
  await h.runner.tick()
  assert.equal(h.bridge.exits.length, 1)

  // Attempt 2 at 15:31:05 re-arms at +120s: 15:32:35 is inside, 15:33:10 out.
  h.clock.set(ist(15, 31, 5))
  await h.runner.tick()
  assert.equal(h.bridge.exits.length, 2)
  h.clock.set(ist(15, 32, 35))
  await h.runner.tick()
  assert.equal(h.bridge.exits.length, 2, '60s after a second failure is inside its doubled window')
  h.clock.set(ist(15, 33, 10))
  await h.runner.tick()
  assert.equal(h.bridge.exits.length, 3)

  // Success resets the ladder for whatever fails next.
  h.bridge.refuse = () => null
  h.clock.set(ist(15, 37, 15))
  await h.runner.tick()
  assert.equal(h.bridge.exits.length, 4)
  assert.equal(h.state(), 'squared-off')
  assert.equal(h.lastError(), '')
})

test('a switched-off strategy whose flatten failed stays supervised — dropping it loses the position', async () => {
  const h = harness()
  await openAPosition(h)
  h.bridge.refuse = (p) => (p.reducesExposure ? 'bridge down' : null)

  h.clock.set(ist(12, 30))
  h.setRows([row({ modes: { paper: { enabled: false } } })])
  await h.runner.sync()

  assert.equal(h.state(), 'failed', 'it must not vanish from the portal holding a position')
  assert.equal(h.desk.openCount('A', 'paper'), 1)

  h.bridge.refuse = () => null
  h.clock.set(ist(12, 32))
  await h.runner.tick()
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  await h.runner.sync()
  assert.equal(h.runner.snapshots().length, 0, 'now it is genuinely flat, so it can be forgotten')
})

test('stopAll flattens on the way out — SIGTERM must not drop a position', async () => {
  const h = harness()
  await openAPosition(h)

  await h.runner.stopAll('SIGTERM shutdown')

  assert.equal(h.bridge.exits.length, 1)
  assert.equal(h.bridge.exits[0]?.flatten, 'SIGTERM shutdown')
  assert.equal(h.state(), 'squared-off')
})

test('stopAll flattens EVERY instance, not just the ones before a slow one', async () => {
  /**
   * `stopAll` runs its instances in parallel now (the serial loop meant a slow
   * bridge round trip left the tags at the back of the map unattempted before
   * `main.ts`'s 15-second hard exit fired). What must not change is what it
   * DOES: the operator switch-off and the explicit `make down` square-off both
   * come through here, and each instance is still squared off on its own rail
   * with its own ledger's lots.
   */
  const h = harness({ rows: [row({ modes: BOTH_MODES })] })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 20, 1))
  await h.runner.tick()
  assert.equal(h.desk.openCount('A', 'paper'), 1)
  assert.equal(h.desk.openCount('A', 'live'), 1)

  await h.runner.stopAll('SIGTERM shutdown')

  assert.deepEqual(h.bridge.exits.map((p) => p.mode).sort(), ['live', 'paper'])
  for (const p of h.bridge.exits) {
    assert.equal(p.lots, 2, 'each rail is flattened for the lots ITS ledger holds')
    assert.equal(p.flatten, 'SIGTERM shutdown')
  }
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.desk.openCount('A', 'live'), 0)
  assert.deepEqual(
    h.runner.snapshots().map((s) => s.state),
    ['squared-off', 'squared-off'],
  )
})

// -------------------------------------------- R2: `failed` still owes an exit

test('a strategy parked in FAILED is still squared off — its position is not carried into tomorrow', async () => {
  const h = harness()
  await openAPosition(h)
  // The runner's own bookkeeping throws for this strategy (jobs() is called
  // outside StrategyBase's guard), which is what parks a strategy in `failed`.
  h.built[0]!.breakJobs = true

  h.clock.set(ist(15, 30))
  await h.runner.tick()

  // Both halves of the tick ran: the job phase failed AND the exit still
  // happened. A phase that throws must not cost the strategy its square-off.
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.bridge.exits[0]?.flatten, 'day end')
  assert.equal(h.state(), 'squared-off')
})

test('a new session does not start on top of an exit that never completed', async () => {
  const h = harness()
  await openAPosition(h)
  h.bridge.refuse = (p) => (p.reducesExposure ? 'bridge down' : null)
  h.clock.set(ist(15, 30))
  await h.runner.tick()
  assert.equal(h.state(), 'failed')

  // Monday 09:16 IST.
  h.clock.set(Date.UTC(2026, 6, 27, 3, 46))
  await h.runner.tick()

  assert.equal(h.state(), 'failed', 'it must not be quietly reset to waiting')
  assert.equal(h.desk.openCount('A', 'paper'), 1)
  assert.equal(h.built.length, 1, 'and no fresh instance was built over the top of it')

  // The retry keeps running through the new session and eventually closes it.
  h.bridge.refuse = () => null
  h.clock.set(Date.UTC(2026, 6, 27, 3, 48))
  await h.runner.tick()
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.state(), 'squared-off')

  // It does NOT resume trading on its own: a strategy whose square-off had to
  // be retried is exactly the one an operator should look at before it takes
  // another position. Switching the row off and on is what rebuilds it.
  h.clock.set(Date.UTC(2026, 6, 27, 3, 49))
  await h.runner.tick()
  assert.equal(h.state(), 'squared-off')
  assert.equal(h.built.length, 1)

  h.setRows([row({ modes: { paper: { enabled: false } } })])
  await h.runner.sync()
  h.setRows([row()])
  await h.runner.sync()
  await h.runner.tick()
  assert.equal(h.state(), 'running')
  assert.equal(h.built.length, 2)
})

// -------------------------------------- R3: drain the cron window, then stop

test('a late tick crossing day end fires the square-off it slept through', async () => {
  // 15:24 squareOff, and a tick that arrives at 15:31. The old ordering
  // (`if past day end … else fireDueJobs`) dropped the occurrence and closed
  // the window forever, replacing the strategy's own exit with a blind flatten.
  const h = harness({ squareOffCron: '0 24 15 * * 1-5' })
  await openAPosition(h)

  h.clock.set(ist(15, 31))
  await h.runner.tick()

  assert.deepEqual(
    h.bridge.exits.map((p) => p.flatten),
    [null],
    'the strategy squared itself off; the backstop had nothing left to do',
  )
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.state(), 'squared-off')
})

test('an occurrence scheduled AFTER day end is not fired — the session is over', async () => {
  const h = harness({ squareOffCron: '0 45 15 * * 1-5' })
  await openAPosition(h)

  h.clock.set(ist(15, 50))
  await h.runner.tick()

  // Draining the window must not become "fire anything that ever comes due":
  // 15:45 is past the close, so the exit is the backstop's, not the job's.
  assert.deepEqual(
    h.bridge.exits.map((p) => p.flatten),
    ['day end'],
  )
  assert.equal(h.desk.openCount('A', 'paper'), 0)
})

// ------------------- R5: one row, two instances, NOTHING shared between them

const BOTH_MODES = { paper: { enabled: true }, live: { enabled: true } } as const

/**
 * The state a strategy persists is scoped by `tag:mode`, not by tag.
 *
 * `onRecover()` rebuilds an open position out of this store. Two instances
 * sharing a scope would have the live one recover the PAPER one's position — it
 * would then manage, and eventually flatten, a position that does not exist on
 * its rail, placing a real order against nothing.
 */
test('the two instances of one tag do not share a StateStore scope', async () => {
  const docs = new Map<string, unknown>()
  const collection = {
    findOne: async (f: Record<string, unknown>) => {
      const v = docs.get(`${String(f['tag'])}|${String(f['key'])}`)
      return v === undefined ? null : ({ value: v } as Record<string, unknown>)
    },
    updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
      docs.set(
        `${String(f['tag'])}|${String(f['key'])}`,
        (u['$set'] as Record<string, unknown>)['value'],
      )
      return {}
    },
    deleteOne: async (f: Record<string, unknown>) => {
      docs.delete(`${String(f['tag'])}|${String(f['key'])}`)
      return {}
    },
    createIndex: async () => ({}),
  }

  const paper = new MongoStateStore(collection, instanceKey('A', 'paper'))
  const live = new MongoStateStore(collection, instanceKey('A', 'live'))

  await paper.set('position', { lots: 2 })
  assert.equal(await live.get('position'), null, 'the live instance must not see a paper position')

  await live.set('position', { lots: 5 })
  assert.deepEqual(await paper.get('position'), { lots: 2 }, 'and the paper one is not overwritten')
  assert.equal(docs.size, 2, 'two documents, two scopes')
})

/**
 * A row switched on for BOTH rails runs TWICE, and the two runs keep their
 * positions apart.
 *
 * MUTATION-TESTED: key `Desk.ledgerFor` on the bare tag instead of `tag:mode`
 * and this fails — the two entries net into one 4-lot leg, so switching live
 * off sells 4 lots on the live rail (2 of which exist only on paper) and leaves
 * the paper instance reading FLAT while it is still holding.
 */
test('a row on in both modes trades on both rails, with separate ledgers', async () => {
  const h = harness({ rows: [row({ modes: BOTH_MODES })] })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 20, 1))
  await h.runner.tick()

  // Two instances, two entries, one per rail.
  assert.deepEqual(h.runner.snapshots().map((s) => s.mode).sort(), ['live', 'paper'])
  assert.deepEqual(h.bridge.posted.map((p) => p.mode).sort(), ['live', 'paper'])
  assert.equal(h.desk.ledgers.size, 2, 'one ledger per instance, keyed tag:mode')
  assert.equal(h.desk.openCount('A', 'paper'), 1)
  assert.equal(h.desk.openCount('A', 'live'), 1)

  // Switch LIVE off. Only the live instance is squared off, only on the live
  // rail, and only for the lots the LIVE ledger actually holds.
  h.clock.set(ist(12, 30))
  h.setRows([row({ modes: { paper: { enabled: true }, live: { enabled: false } } })])
  await h.runner.sync()

  assert.equal(h.bridge.exits.length, 1)
  assert.equal(h.bridge.exits[0]?.mode, 'live')
  assert.equal(h.bridge.exits[0]?.lots, 2, 'the LIVE leg, not both legs netted together')
  assert.equal(h.desk.openCount('A', 'live'), 0)
  // The paper instance is untouched: still supervised, still running, still
  // holding. This is the assertion a shared ledger cannot satisfy.
  assert.equal(h.desk.openCount('A', 'paper'), 1)
  assert.equal(h.state('A', 'paper'), 'running')
  assert.equal(h.state('A', 'live'), 'gone')
})

test('day end squares off BOTH instances, each on its own rail', async () => {
  const h = harness({ rows: [row({ modes: BOTH_MODES })] })
  await h.runner.sync()
  await h.runner.tick()
  h.clock.set(ist(9, 20, 1))
  await h.runner.tick()

  h.clock.set(ist(15, 30))
  await h.runner.tick()

  assert.deepEqual(h.bridge.exits.map((p) => p.mode).sort(), ['live', 'paper'])
  for (const p of h.bridge.exits) assert.equal(p.lots, 2)
  assert.equal(h.desk.openCount('A', 'paper'), 0)
  assert.equal(h.desk.openCount('A', 'live'), 0)
  assert.deepEqual(
    h.runner.snapshots().map((s) => s.state),
    ['squared-off', 'squared-off'],
  )
})

// ------------------------ R4: switching a mode off stops THAT instance only

const LIVE_ONLY = { live: { enabled: true } } as const
const PAPER_ONLY = { paper: { enabled: true } } as const

test('live -> paper squares off ON THE LIVE RAIL, then starts a fresh paper instance', async () => {
  const h = harness({ rows: [row({ modes: LIVE_ONLY })] })
  await openAPosition(h, 'live')
  assert.equal(h.bridge.posted[0]?.mode, 'live')

  h.clock.set(ist(12, 30))
  h.setRows([row({ modes: PAPER_ONLY })])
  await h.runner.sync()

  // The position was opened on the live rail, so it is closed on the live rail.
  // Reversing it through paper would book a fictional exit and leave the real
  // one at the broker.
  assert.equal(h.bridge.exits.length, 1)
  assert.equal(h.bridge.exits[0]?.mode, 'live')
  assert.equal(h.desk.openCount('A', 'live'), 0)

  // The paper instance is a NEW instance, not the live one re-pointed: the mode
  // is fixed into the gateway at construction, so a re-pointed one would keep
  // POSTing mode:'live' all day.
  await h.runner.tick()
  assert.deepEqual(
    h.builtWith.map((r) => r.mode),
    ['live', 'paper'],
  )
  assert.equal(h.state('A', 'paper'), 'running')
  assert.equal(h.state('A', 'live'), 'gone', 'the live instance is collected once it is flat')
})

test('a failed square-off keeps the LIVE instance alive and retrying on its own rail', async () => {
  const h = harness({ rows: [row({ modes: LIVE_ONLY })] })
  await openAPosition(h, 'live')
  h.bridge.refuse = (p) => (p.reducesExposure ? 'bridge down' : null)

  h.clock.set(ist(12, 30))
  h.setRows([row({ modes: PAPER_ONLY })])
  await h.runner.sync()

  // The live instance is NOT forgotten: it is the last thing that knows the
  // position exists, and it stays parked on the rail the position is on.
  assert.equal(h.state('A', 'live'), 'failed')
  assert.equal(h.desk.openCount('A', 'live'), 1)

  // The retry keeps aiming at the rail the position is actually on, even though
  // the row now says paper — the instance owns its mode, not the row.
  h.bridge.refuse = () => null
  h.clock.set(ist(12, 32))
  await h.runner.tick()
  assert.equal(h.bridge.exits.at(-1)?.mode, 'live')
  assert.equal(h.desk.openCount('A', 'live'), 0)
})

test('liveLots changing really is nothing to restart for', async () => {
  const h = harness({ rows: [row({ liveLots: 1 })] })
  await openAPosition(h)

  h.setRows([row({ liveLots: 9 })])
  await h.runner.sync()

  // Sizing is applied by /v1/desk/submit off the row it reads itself, so there
  // is nothing to rebuild and — crucially — nothing to square off.
  assert.equal(h.bridge.exits.length, 0)
  assert.equal(h.state(), 'running')
  assert.equal(h.built.length, 1)
})

// ------------------------------------------------- a REAL catalogue strategy

/**
 * BULL_S_1, the real premium-leg-book class from `packages/strategies`, driven
 * through the real runner with the real gateway and ledger.
 *
 * This is the test the fixture in `runner.test.ts` could not be: it makes no
 * assumption about which lifecycle hooks the class implements. The invariant it
 * asserts is the one that has to hold for every strategy in the catalogue
 * however each of them is written — when the runner says the position is
 * closed, an exit for every instrument the entry actually used has reached the
 * bridge and the ledger is empty.
 */
const CE: InstrumentRef = { ...OPTION, tradingsymbol: 'BANKNIFTY26AUG56000CE', instrumentToken: 900_001 }
const PE: InstrumentRef = { ...OPTION, tradingsymbol: 'BANKNIFTY26AUG56000PE', instrumentToken: 900_002 }
const LEGS = [CE.tradingsymbol, PE.tradingsymbol].sort()

function realHarness(nowMs: number): {
  runner: Runner
  clock: ReturnType<typeof fixedClock>
  bridge: FakeBridge
  desk: Desk
  setRows(rows: readonly HostedRow[]): void
  state(): string
} {
  const clock = fixedClock(nowMs)
  const log = makeLogger()
  const bridge = new FakeBridge()
  const desk = new Desk(bridge, clock, log)
  const entry = CATALOGUE.get('BULL_S_1')
  assert.ok(entry !== undefined, 'BULL_S_1 must be in the catalogue')
  let rows: readonly HostedRow[] = [row({ tag: 'BULL_S_1' })]

  // No future listed, so the strategy references the index spot.
  const SPOT_TOKEN = 260_105
  const md: MarketData = {
    quote: (token) =>
      token === CE.instrumentToken || token === PE.instrumentToken
        ? { token, lastPrice: 100, ts: clock.now() }
        : { token, lastPrice: 56_000, ts: clock.now() },
    candles: async () => [],
    option: (_u, _strike, type) => (type === 'CE' ? CE : PE),
    selectOption: () => null,
    future: () => null,
    atmStrike: (_u, price) => Math.round(price / 100) * 100,
    spotToken: () => SPOT_TOKEN,
  }

  const runner = new Runner({
    clock,
    log,
    factory: {
      create: (r) =>
        entry.build({
          tag: r.tag,
          clock,
          md,
          orders: desk.gatewayFor(r.tag, r.mode),
          fills: { onFill: () => () => {} },
          state: new MemoryStateStore(),
          log,
          mode: r.mode === 'live' ? 'live' : 'sim',
          destinations: r.mode === 'live' ? ['xts'] : ['sim'],
          feed: { isTrustworthy: () => true, reason: () => null },
        }),
    },
    loadRows: async () => rows,
    positions: { openCount: desk.openCount, flattenAll: desk.flattenAll },
  })

  return {
    runner,
    clock,
    bridge,
    desk,
    setRows: (next) => {
      rows = next
    },
    state: () => runner.snapshots()[0]?.state ?? 'gone',
  }
}

/** Run the real BULL_S_1 up to an open short straddle. */
async function realEntry(): Promise<ReturnType<typeof realHarness>> {
  const h = realHarness(ist(9, 19))
  await h.runner.sync()
  await h.runner.tick()

  // The first reference tick crosses the 56000 strike: sell the ATM straddle.
  h.runner.handleTick('BULL_S_1', { token: 260_105, lastPrice: 56_000, ts: ist(9, 19) })
  await drain(h)

  assert.deepEqual(
    h.bridge.posted.map((p) => [p.side, p.tradingsymbol]).sort(),
    [['Sell', CE.tradingsymbol], ['Sell', PE.tradingsymbol]],
    'the real class should have sold the ATM straddle',
  )
  assert.equal(h.desk.openCount('BULL_S_1', 'paper'), 2)
  return h
}

/** The strategy's tick handling is queued; let it settle. */
async function drain(h: { runner: Runner }): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await h.runner.tick()
}

test('a REAL catalogue strategy: BULL_S_1 enters, and the runner closes what it entered', async () => {
  const h = await realEntry()

  // Switched off mid-session — the path with no cron and no market close to
  // help, i.e. exactly where a strategy without an `onDayEnd` used to be
  // reported `squared-off` while its position stayed open.
  h.clock.set(ist(12, 30))
  h.setRows([row({ tag: 'BULL_S_1', modes: { paper: { enabled: false } } })])
  await h.runner.sync()

  const exits = h.bridge.exits
  assert.equal(exits.length, 2, 'an exit order per leg must actually have reached the bridge')
  assert.ok(exits.every((e) => e.side === 'Buy'))
  assert.deepEqual(
    exits.map((e) => e.tradingsymbol).sort(),
    LEGS,
    'and for the instruments the entry actually used, never a fabricated one',
  )
  assert.equal(h.desk.openCount('BULL_S_1', 'paper'), 0)
})

test('a REAL catalogue strategy: an exit the bridge REFUSED does not become a squared-off report', async () => {
  const h = await realEntry()
  // The strategy's own square-off is rejected. Only the ledger knows the legs
  // are still open, which is the entire reason the runner keeps one.
  h.bridge.refuse = (p) => (p.reducesExposure && p.flatten === null ? 'no mark for this contract' : null)

  h.clock.set(ist(15, 30, 5))
  await h.runner.tick()

  const flattens = h.bridge.exits.filter((p) => p.flatten !== null)
  assert.deepEqual(
    flattens.map((p) => p.tradingsymbol).sort(),
    LEGS,
    'the runner must reverse what the strategy could not',
  )
  assert.equal(h.desk.openCount('BULL_S_1', 'paper'), 0)
  assert.equal(h.state(), 'squared-off')
})

test('a REAL catalogue strategy: day end leaves nothing open', async () => {
  const h = await realEntry()

  h.clock.set(ist(15, 30, 5))
  await h.runner.tick()

  assert.equal(h.state(), 'squared-off')
  assert.equal(h.desk.openCount('BULL_S_1', 'paper'), 0, 'squared-off must mean the ledger is empty')
  assert.deepEqual(h.bridge.exits.map((e) => e.tradingsymbol).sort(), LEGS)
})
