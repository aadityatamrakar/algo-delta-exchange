/**
 * 'NIFTY', NOT 'NIFTY 50' — the index feed, into the process that needs it.
 *
 * The supervisor subscribes to `md.tick` and its token set is the future plus
 * the option chain. The INDEX SPOT TOKEN IS IN NEITHER, so before this wire
 * existed a delta-lean book had a `SpotRing` with nothing to fill it, a regime
 * detector that read `'unknown'` on every pass, and a book that never traded —
 * with no error anywhere, because "no regime" is a legitimate answer.
 *
 * The failures these assertions exist for, none of which throws:
 *
 *   1. **The wrong key.** Options list under `NIFTY`; the index itself is
 *      `"NIFTY 50"` in the instrument dump. `md.spot` publishes the CANONICAL
 *      key (`master.ts:70-90`, `apps/marketdata/src/main.ts:848`). Filtering on
 *      the dump's name yields a ring that never fills — the silent failure
 *      above, dressed as a quiet market.
 *   2. **One symbol only.** A NIFTY-shaped filter that never carried SENSEX
 *      would leave half the desk's books inert while the other half traded,
 *      which is the hardest kind of outage to see.
 *   3. **A ring nobody reads.** The rings can fill perfectly and still reach no
 *      engine: `EngineHostDeps.ring` is handed at construction, and a host
 *      built without one holds every pass and says so once. So the proof here
 *      is the MARK the book journalled, whose `reason` is the engine's rather
 *      than the host's stand-in — and, end to end, a package on the decisions
 *      endpoint that nothing but `md.spot` and `md.tick` produced. That last
 *      one is also the only observable `spotAsOf` has: stated as 0 rather than
 *      as the newest sample's stamp, the index reads as infinitely stale, every
 *      OPEN is refused, and the book trades nothing while looking healthy.
 *   4. **A book nobody publishes a spot for.** `DESK_UNIVERSE` is
 *      `apps/marketdata`'s env, not this process's; a book on a symbol that
 *      universe omits gets a ring that never fills, and is indistinguishable
 *      from a quiet market unless this process says so out loud.
 *   5. **An out-of-order or impossible sample.** `SpotRing.window` walks back
 *      from the newest sample and STOPS at the first one before the cutoff, so
 *      a sample pushed out of order truncates every window silently; a zero or
 *      NaN print poisons displacement the same way.
 *
 * No Mongo, no network, no wall clock: the database is the in-memory fake the
 * lifecycle suite uses (the real compare-and-set is proved in
 * `state-store.test.ts`), the bus is a pattern-keyed emitter, and the clock is
 * a number this file moves by hand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  PRESETS,
  RISK_FREE,
  resolveDials,
  type DecisionRequest,
  type DecisionResponse,
  type Dials,
} from '@algomaker/desk-engine'
import {
  Supervisor,
  chainForwardFor,
  chainForwardOverride,
  type BusPort,
  type DeskApiPort,
  type MasterPort,
  type MdSpot,
} from '../src/main.ts'
import { Lease } from '../src/lease.ts'
import type { ChainToken, MdTick } from '../src/chain-view.ts'
import { istDateOf, type HostLog } from '../src/engine-host.ts'
import { SUPERVISOR_STATE_COLLECTION, stateKey } from '../src/state-store.ts'

// ────────────────────────────────────────────────────────────── the market

/** 2026-09-15 (a Tuesday) 10:15 IST — a real market minute, mid-session. */
const T0 = Date.parse('2026-09-15T10:15:00+05:30')

const NIFTY = 'NIFTY'
const NIFTY_EXPIRY = '2026-09-22'
const NIFTY_TAG = 'NIFTY-2026-09-22-delta-lean-a'
const NIFTY_SPOT = 24_000
const NIFTY_LOT = 65
const NIFTY_STEP = 50

const SENSEX = 'SENSEX'
const SENSEX_EXPIRY = '2026-09-24'
const SENSEX_TAG = 'SENSEX-2026-09-24-delta-lean-a'
const SENSEX_LOT = 20
const SENSEX_STEP = 100

/**
 * The name the INSTRUMENT DUMP gives the index, which is not the name the
 * options list under and not what `md.spot` publishes. Filtering on this is
 * the bug the header's failure 1 is about.
 */
const DUMP_NAME = 'NIFTY 50'

/** A listed future that NOTHING EVER QUOTES — the §5 proxy-forward case. */
const NIFTY_FUTURE = 900_001
const SENSEX_FUTURE = 900_002

const NIFTY_LADDER = Array.from({ length: 41 }, (_, i) => NIFTY_SPOT - 1_000 + i * NIFTY_STEP)

/** 2026-09-15 to the 22nd. Trading days, not calendar ones, are the engine's. */
const DTE_YEARS = 7 / 365
const VOL = 0.12

const tokenOf = (strike: number, optType: 'CE' | 'PE'): number =>
  strike * 10 + (optType === 'CE' ? 1 : 2)
const symbolOf = (strike: number, optType: 'CE' | 'PE'): string =>
  `NIFTY26922${String(strike)}${optType}`

/**
 * The Black-76 price at `VOL`, so the board a book marks off is the MODEL's
 * rather than a number typed into this file: every strike implies a volatility,
 * every greek the controller sizes with solves, and a decision that comes out of
 * it is one the engine could reach on a real chain.
 */
const theo = (strike: number, optType: 'CE' | 'PE'): number =>
  b76Price({
    future: NIFTY_SPOT,
    strike,
    t: DTE_YEARS,
    vol: VOL,
    rate: RISK_FREE,
    type: optType,
  })

const master: MasterPort = {
  tokensFor: (symbol, expiry): ChainToken[] =>
    symbol !== NIFTY || expiry !== NIFTY_EXPIRY
      ? []
      : NIFTY_LADDER.flatMap((strike) =>
          (['CE', 'PE'] as const).map(
            (optType): ChainToken => ({
              token: tokenOf(strike, optType),
              strike,
              optType,
              instrument: symbolOf(strike, optType),
            }),
          ),
        ),
  futureToken: (symbol) =>
    symbol === NIFTY ? NIFTY_FUTURE : symbol === SENSEX ? SENSEX_FUTURE : 0,
  instrumentFor: (symbol, expiry, strike, optType) =>
    symbol === NIFTY && expiry === NIFTY_EXPIRY ? symbolOf(strike, optType) : null,
  tickSizeFor: () => 0.05,
  chainMeta: (symbol, expiry) => {
    if (symbol === NIFTY && expiry === NIFTY_EXPIRY) return { lotSize: NIFTY_LOT, step: NIFTY_STEP }
    if (symbol === SENSEX && expiry === SENSEX_EXPIRY) {
      return { lotSize: SENSEX_LOT, step: SENSEX_STEP }
    }
    return { lotSize: 0, step: 0 }
  },
}

/**
 * One frame of the OPTION feed — and deliberately no future quote, so the only
 * forward this chain can be priced off is the index spot (`chain-view.ts` §5).
 */
function optionFrame(ts: number): MdTick[] {
  const ticks: MdTick[] = []
  for (const strike of NIFTY_LADDER) {
    for (const optType of ['CE', 'PE'] as const) {
      const p = theo(strike, optType)
      ticks.push({
        token: tokenOf(strike, optType),
        price: p,
        ts,
        bid: Number((p * 0.995).toFixed(2)),
        ask: Number((p * 1.005).toFixed(2)),
      })
    }
  }
  return ticks
}

// ─────────────────────────────────────────────────────────────── the fakes

/** The narrowest Mongo that satisfies everything this process reads. */
class FakeDb {
  readonly rows = new Map<string, Record<string, unknown>[]>()

  of(name: string): Record<string, unknown>[] {
    let list = this.rows.get(name)
    if (list === undefined) {
      list = []
      this.rows.set(name, list)
    }
    return list
  }

  collection(name: string): never {
    const rows = this.of(name)
    const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
      Object.entries(filter).every(([k, v]) => {
        if (v !== null && typeof v === 'object' && '$in' in (v as object)) {
          return ((v as { $in: unknown[] }).$in ?? []).includes(doc[k])
        }
        return doc[k] === v
      })
    return {
      find: (filter: Record<string, unknown> = {}) => ({
        toArray: async (): Promise<Record<string, unknown>[]> =>
          rows.filter((d) => matches(d, filter)).map((d) => ({ ...d })),
      }),
      findOne: async (filter: Record<string, unknown> = {}) => {
        const hit = rows.find((d) => matches(d, filter))
        return hit === undefined ? null : { ...hit }
      },
      findOneAndUpdate: async (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        const set = (update['$set'] ?? {}) as Record<string, unknown>
        const at = rows.findIndex((d) => matches(d, filter))
        if (at >= 0) {
          rows[at] = { ...rows[at], ...structuredClone(set) }
          return null
        }
        if (options?.['upsert'] !== true) return null
        const key = (filter['key'] ?? set['key']) as unknown
        // The unique key the lease and the state store depend on: a colliding
        // upsert is a duplicate-key error, never a second document.
        if (key !== undefined && rows.some((d) => d['key'] === key)) {
          throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
        }
        rows.push({ ...(filter['key'] === undefined ? {} : { key }), ...structuredClone(set) })
        return null
      },
      updateOne: async (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: { upsert?: boolean },
      ) => {
        const set = (update['$set'] ?? {}) as Record<string, unknown>
        const at = rows.findIndex((d) => matches(d, filter))
        if (at >= 0) {
          rows[at] = { ...rows[at], ...structuredClone(set) }
          return { matchedCount: 1 }
        }
        if (options?.upsert === true) rows.push({ ...filter, ...structuredClone(set) })
        return { matchedCount: 0 }
      },
      deleteOne: async (filter: Record<string, unknown>) => {
        const at = rows.findIndex((d) => matches(d, filter))
        if (at >= 0) rows.splice(at, 1)
        return { deletedCount: at >= 0 ? 1 : 0 }
      },
      insertOne: async (doc: Record<string, unknown>) => {
        rows.push({ ...doc })
        return {}
      },
      createIndex: async () => null,
    } as never
  }
}

/**
 * A bus that REMEMBERS THE PATTERN each handler asked for.
 *
 * The lifecycle suite's fake ignores it, which was fine while this process had
 * one subscription. With two it is the whole point: a spot frame delivered to
 * the tick handler (or the reverse) would prove nothing about the wiring, and a
 * process that subscribed `md.spot` and never got called would pass a test that
 * called `onSpot` directly.
 */
class FakeBus implements BusPort {
  readonly handlers = new Map<string, ((msg: { payload: unknown }) => void)[]>()
  closed = false

  subscribe<T>(pattern: string, handler: (msg: { payload: T }) => void): () => void {
    const h = handler as unknown as (msg: { payload: unknown }) => void
    const list = this.handlers.get(pattern) ?? []
    list.push(h)
    this.handlers.set(pattern, list)
    return (): void => {
      const at = list.indexOf(h)
      if (at >= 0) list.splice(at, 1)
    }
  }

  async ready(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
  }

  /** Every subscriber of one topic, and nobody else. */
  emit(pattern: string, payloads: readonly unknown[]): void {
    for (const payload of payloads) {
      for (const h of [...(this.handlers.get(pattern) ?? [])]) h({ payload })
    }
  }

  spot(underlying: string, price: number, ts: number): void {
    this.emit('md.spot', [{ underlying, price, ts } satisfies MdSpot])
  }
}

class FakeClient {
  readonly requests: DecisionRequest[] = []

  async submit(req: DecisionRequest): Promise<DecisionResponse> {
    this.requests.push(structuredClone(req))
    return {
      decisionId: req.decisionId,
      replayed: false,
      status: 'DONE',
      fills: [],
      skips: [],
      routeErrors: [],
    }
  }
}

class FakeApi implements DeskApiPort {
  readonly cancels: string[] = []

  async reportActual(): Promise<void> {}

  async cancelOrder(brokerOrderId: string): Promise<void> {
    this.cancels.push(brokerOrderId)
  }
}

interface Entry {
  readonly level: string
  readonly msg: string
  readonly ctx: Record<string, unknown>
}

function logOf(): HostLog & { entries: Entry[] } {
  const entries: Entry[] = []
  const push =
    (level: string) =>
    (msg: string, ctx: Record<string, unknown> = {}): void => {
      entries.push({ level, msg, ctx })
    }
  return {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

// ─────────────────────────────────────────────────────────────── the rig

interface Rig {
  readonly supervisor: Supervisor
  readonly db: FakeDb
  readonly bus: FakeBus
  readonly client: FakeClient
  readonly log: HostLog & { entries: Entry[] }
  now: number
  /** The marks this desk journalled — the evidence that a book DECIDED. */
  marks(): Record<string, unknown>[]
}

/** Spin the microtask queue until `ready`, or give up. No wall clock. */
async function until(ready: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !ready(); i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function registryRow(
  tag: string,
  symbol: string,
  expiry: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tag,
    symbol,
    expiry,
    mode: 'paper',
    variant: 'delta-lean',
    /**
     * The one dial that selects the second decide path, and `confirm_ms: 0` so
     * one frame is enough to route — `DEFAULT_DIALS` IS spec §9's aggressive
     * column (`presets.ts:326`), and the damping is proved in
     * `engine-host.test.ts`. Repeating it here would make this suite about a
     * rule instead of about the feed.
     */
    dials: { delta_lean_enabled: true, confirm_ms: 0 },
    desired: 'running',
    actual: 'stopped',
    ...over,
  }
}

function rig(rows: Record<string, unknown>[], over: { chainForward?: 'future' | null } = {}): Rig {
  const db = new FakeDb()
  const bus = new FakeBus()
  const client = new FakeClient()
  const log = logOf()
  for (const row of rows) db.of('desk-books-registry').push(row)
  const r = { db, bus, client, log, now: T0 } as Rig
  const supervisor = new Supervisor({
    db: db as never,
    bus,
    client,
    api: new FakeApi(),
    master: () => master,
    lease: new Lease({
      collection: db.collection('desk-supervisor-lease'),
      key: 'desk-supervisor',
      now: () => r.now,
    }),
    owner: 'test:1',
    now: () => r.now,
    log,
    leaseRetryMs: 1,
    ...(over.chainForward === undefined ? {} : { chainForward: over.chainForward }),
  })
  return Object.assign(r, {
    supervisor,
    marks: (): Record<string, unknown>[] => db.of('desk-book-marks'),
  })
}

/** Boot one NIFTY book and one SENSEX book, both delta-lean. */
async function bothBooks(): Promise<Rig> {
  const r = rig([
    registryRow(NIFTY_TAG, NIFTY, NIFTY_EXPIRY),
    registryRow(SENSEX_TAG, SENSEX, SENSEX_EXPIRY),
  ])
  await r.supervisor.boot()
  return r
}

// ───────────────────────────────────────────────────────────────── tests

test('the process subscribes to md.spot as well as md.tick', async () => {
  const r = await bothBooks()
  assert.deepEqual([...r.bus.handlers.keys()].sort(), ['md.spot', 'md.tick'])
})

test('spot ticks land in the ring under the CANONICAL symbol', async () => {
  const r = await bothBooks()
  // The dump's name for the index. `md.spot` never publishes it, and a filter
  // written against it is the failure this whole file is named for.
  r.bus.spot(DUMP_NAME, NIFTY_SPOT, T0)
  assert.equal(r.supervisor.ringFor(DUMP_NAME), undefined)
  assert.equal(r.supervisor.ringFor(NIFTY)?.size, 0)

  r.bus.spot(NIFTY, NIFTY_SPOT, T0)
  assert.equal(r.supervisor.ringFor(NIFTY)?.size, 1)
})

test('SENSEX is carried too, not just NIFTY', async () => {
  const r = await bothBooks()
  r.bus.spot(SENSEX, 81_000, T0)
  assert.equal(r.supervisor.ringFor(SENSEX)?.size, 1)
  // And the two rings are separate tapes: one symbol's prints must never be
  // classified as another's.
  assert.equal(r.supervisor.ringFor(NIFTY)?.size, 0)
})

test('a symbol no book manages gets no ring at all', async () => {
  const r = await bothBooks()
  r.bus.spot('BHEL', 250, T0)
  // Not "an empty ring" — no ring. The desk's feed carries the whole universe
  // and a ring per symbol on it would be memory this process has no use for.
  assert.equal(r.supervisor.ringFor('BHEL'), undefined)
})

test('a book the operator switches off keeps its warm tape', async () => {
  const r = await bothBooks()
  r.bus.spot(NIFTY, NIFTY_SPOT, T0)
  const ring = r.supervisor.ringFor(NIFTY)

  const row = r.db.of('desk-books-registry').find((d) => d['tag'] === NIFTY_TAG)
  assert.ok(row !== undefined)
  row['desired'] = 'stopped'
  // The registry poll is what converges on `desired`; the nudge is only its
  // latency (`registry-poll.ts`). Driven here so the book is really let go.
  r.supervisor.nudge('registry')
  await until(() => r.supervisor.books.length === 1)
  assert.deepEqual(r.supervisor.books, [`${SENSEX_TAG}:paper`])

  r.now += 1_000
  r.bus.spot(NIFTY, NIFTY_SPOT + 3, r.now)
  // The ring OUTLIVES the book, and goes on filling: a book switched back on at
  // 13:00 whose tape had been discarded would read 'unknown' — and trade
  // nothing — for the quarter hour it took to refill the context window.
  assert.equal(r.supervisor.ringFor(NIFTY), ring)
  assert.equal(ring?.size, 2)
})

test('an out-of-order spot is dropped rather than pushed', async () => {
  const r = await bothBooks()
  r.bus.spot(NIFTY, NIFTY_SPOT, T0)
  r.bus.spot(NIFTY, NIFTY_SPOT + 10, T0 - 30_000)
  // `SpotRing.window` walks back from the newest sample and STOPS at the first
  // one before the cutoff, so a sample out of time order does not merely
  // arrive late — it truncates every window behind it, silently.
  assert.equal(r.supervisor.ringFor(NIFTY)?.size, 1)
})

test('a spot that is not a price never reaches the ring', async () => {
  const r = await bothBooks()
  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    r.bus.spot(NIFTY, price, T0)
  }
  r.bus.spot(NIFTY, NIFTY_SPOT, Number.NaN)
  // A zero spot is not a cheap index: displacement against it is the whole
  // level, which reads as the trend of a lifetime.
  assert.equal(r.supervisor.ringFor(NIFTY)?.size, 0)
})

test('the ring reaches the host that owns the symbol, and the forward comes off it', async () => {
  const r = await bothBooks()
  r.bus.emit('md.tick', optionFrame(r.now))

  // No spot yet: this chain's future is listed and NEVER QUOTED, so there is no
  // forward at all and the book cannot even snap. One evaluation, no mark.
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 0, 20)
  assert.equal(r.marks().length, 0)

  r.now += 1_000
  r.bus.spot(NIFTY, NIFTY_SPOT, r.now)
  r.bus.emit('md.tick', optionFrame(r.now))
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 0)

  const mark = r.marks().find((m) => m['tag'] === NIFTY_TAG)
  assert.ok(mark !== undefined, 'the NIFTY book must have marked off the proxy forward')
  // The forward is the index level times the carry, and the carry is a flat 1
  // because this process has no basis source — see `carryFor` in `main.ts`.
  assert.equal(mark['spot'], NIFTY_SPOT)
  // And the row says so: a book without `dl_parity_forward` is priced the way it
  // always was, and the journal names which of the four sources that was.
  assert.equal(mark['forwardSource'], 'proxy')
  // THE RING REACHED THE ENGINE. A host built without one holds every pass with
  // this reason (`engine-host.ts:heldByHost`), and that hold journals a mark of
  // its own — so the mark existing is not the proof, its REASON is.
  assert.ok(
    !String(mark['reason']).includes('spot ring'),
    `the book was held by the host for want of a ring: ${String(mark['reason'])}`,
  )
  assert.equal(
    r.log.entries.filter((e) => e.msg.includes('NO SPOT RING')).length,
    0,
    'the wiring fault was logged — the ring did not reach this book',
  )
})

test('a RECENTER book is never handed the proxy forward', async () => {
  /**
   * The proxy was built for an index book that would otherwise stop deciding
   * for seconds at a time. A recenter book whose future has no quote at all has
   * always gone silent, and silent is a state its operator has run live for
   * months. Answering for it here would change that quietly: it would decide off
   * spot x 1, and a flat carry on a single stock is wrong by the whole basis, so
   * every delta in the book moves with it.
   *
   * The spot feed publishes a cash leg for every symbol in DESK_UNIVERSE, so
   * without a filter the proxy reaches every book on the desk the moment this
   * subscription exists.
   */
  const r = rig([registryRow(NIFTY_TAG, NIFTY, NIFTY_EXPIRY, { dials: { confirm_ms: 0 } })])
  await r.supervisor.boot()

  r.bus.spot(NIFTY, NIFTY_SPOT, r.now)
  r.bus.emit('md.tick', optionFrame(r.now))
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 0, 20)

  // The chain's future is listed and never quoted. A delta-lean book on this
  // exact tape marks off the proxy (the test above); this one must not snap at
  // all, which is byte-for-byte what it did before the feed was subscribed.
  assert.equal(r.marks().length, 0)
})

test('a forward off a spot the feed stopped publishing goes cold, it does not freeze', async () => {
  const r = await bothBooks()
  r.bus.spot(NIFTY, NIFTY_SPOT, r.now)
  r.bus.emit('md.tick', optionFrame(r.now))
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 0)
  assert.equal(r.marks().length, 1)

  // Six minutes on: a new mark window, a still-ticking option feed, and an
  // index that has said nothing. Pricing a forward off the last level seen is
  // how a frozen quote routes an order (`chain-view.ts` §4), so the chain stops
  // snapping instead.
  r.now += 6 * 60_000
  r.bus.emit('md.tick', optionFrame(r.now))
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 1, 20)
  assert.equal(r.marks().length, 1)

  // The same instant, with the index printing again: the book is back.
  r.bus.spot(NIFTY, NIFTY_SPOT + 5, r.now)
  r.now += 1_000
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 1)
  assert.equal(r.marks().length, 2)
})

/**
 * A CLEAN 300-POINT RAMP over the fifteen minutes ENDING at `T0`, then flat.
 *
 * 300 points is many times the five-minute implied move on this board, so all
 * three windows read the same trend and the controller has something it wants
 * to do. It ends AT `NIFTY_SPOT` so the tape and the board agree about where
 * the index is.
 */
const rampAt = (ms: number): number =>
  ms >= T0 ? NIFTY_SPOT : NIFTY_SPOT - (300 * (T0 - ms)) / 900_000

test('an index print, and nothing else, becomes an order on the wire', async () => {
  const r = rig([registryRow(NIFTY_TAG, NIFTY, NIFTY_EXPIRY)])

  // `decideDeltaLean`'s own regime clock (`dlRegimeSinceMs`) is STATEFUL: it
  // starts counting only once the RuleState first records a regime, not from
  // how long the tape below has actually been trending. A fresh state's first
  // tick therefore always reads "trend-up for 0s — inside the confirm window"
  // and holds, whatever the ring says. Seeded past `dl_adjust_confirm_s` (60s
  // aggressive) here, the same way `engine-host-delta-lean.test.ts`'s `warm()`
  // does, so what this test pins is the wire end to end, not the confirm
  // window it does not exist to prove.
  r.db.of(SUPERVISOR_STATE_COLLECTION).push({
    key: stateKey(NIFTY_TAG, 'paper'),
    ruleState: {
      ...EMPTY_RULE_STATE,
      dlDayStarted: istDateOf(T0),
      dlRegime: 'trend-up',
      dlRegimeSinceMs: T0 - 3_600_000,
    },
    updatedAt: 1,
  })

  await r.supervisor.boot()

  // One print a second for fifteen minutes, forward only, exactly as the feed
  // delivers them. This is the ONLY source of the index in this test: there is
  // no future quote, so the forward is the proxy and the regime is the tape.
  for (let at = T0 - 900_000; at <= T0; at += 1_000) r.bus.spot(NIFTY, rampAt(at), at)
  r.bus.emit('md.tick', optionFrame(T0))
  await r.supervisor.evaluateDue()
  await until(() => r.client.requests.length > 0)

  // THE WHOLE WIRE, END TO END: `md.spot` → the ring → the regime detector →
  // a package on the decisions endpoint. It also pins `spotAsOf`, which has no
  // other observable: wired to 0 instead of the newest sample's stamp, the
  // index reads as infinitely stale, every OPEN is refused (cuts still run) and
  // this book puts nothing on the wire while looking perfectly healthy.
  assert.equal(r.client.requests.length, 1)
  const req = r.client.requests[0]
  assert.ok(req !== undefined)
  assert.equal(req.tag, NIFTY_TAG)
  assert.ok(req.actions.length > 0, 'a decision that routes nothing is not an order')
})

test('a book whose symbol never publishes a spot is REPORTED, not left silently inert', async () => {
  const r = await bothBooks()
  // The topic is demonstrably flowing — for a symbol no book here manages, which
  // is how a desk whose `DESK_UNIVERSE` omits SENSEX actually looks from this
  // process. `DESK_UNIVERSE` is marketdata's env, not ours; observing the feed
  // is the only honest way to know.
  r.bus.spot('BANKNIFTY', 52_000, r.now)
  await r.supervisor.evaluateDue()
  assert.equal(r.log.entries.filter((e) => e.msg.includes('index spot')).length, 0)

  // Well past the grace: one minute of a live topic with nothing for either
  // managed symbol is a wiring fault, not a quiet market.
  r.now += 5 * 60_000
  await r.supervisor.evaluateDue()
  const faults = r.log.entries.filter((e) => e.msg.includes('index spot'))
  assert.equal(faults.length, 2)
  assert.deepEqual(
    faults.map((e) => String(e.ctx['symbol'])).sort(),
    [NIFTY, SENSEX],
  )
  // At ERROR, because both books are delta-lean: without a tape they are not
  // quiet, they are stopped.
  assert.deepEqual([...new Set(faults.map((e) => e.level))], ['error'])

  // ONCE. This is read every 250 ms forever.
  r.now += 5 * 60_000
  await r.supervisor.evaluateDue()
  assert.equal(r.log.entries.filter((e) => e.msg.includes('index spot')).length, 2)
})

test('a symbol that IS publishing is never reported', async () => {
  const r = await bothBooks()
  r.bus.spot(NIFTY, NIFTY_SPOT, r.now)
  r.now += 5 * 60_000
  await r.supervisor.evaluateDue()
  const faults = r.log.entries.filter((e) => e.msg.includes('index spot'))
  assert.deepEqual(
    faults.map((e) => String(e.ctx['symbol'])),
    [SENSEX],
  )
})

// ───────────────────────── a full-session tape (six-playbooks spec F5)

test('the tape holds a WHOLE SESSION at one print a second — and is still bounded', async () => {
  /**
   * The playbook frame folds the day's open, high and low off this ring
   * (`SpotRing.filteredRange`). At 4,096 samples — 68 minutes — the 09:15 open
   * had been overwritten by 10:23, and every later fold would have described a
   * day that started then.
   */
  const r = await bothBooks()
  const open = Date.parse('2026-09-15T09:15:00+05:30')
  const close = Date.parse('2026-09-15T15:30:00+05:30')
  for (let at = open; at <= close; at += 1_000) r.bus.spot(NIFTY, NIFTY_SPOT, at)
  const ring = r.supervisor.ringFor(NIFTY)
  assert.ok(ring !== undefined)
  const day = ring.range(open, close)
  assert.equal(day?.samples, 22_501, '09:15:00 to 15:30:00 inclusive, every print kept')
  assert.equal(day?.firstMs, open, 'the open is still on the tape at the close')

  // Bounded all the same: a feed printing past the design rate fills the ring
  // and then overwrites it, it never grows.
  for (let i = 1; i <= 20_000; i++) r.bus.spot(NIFTY, NIFTY_SPOT, close + i * 1_000)
  assert.equal(ring.size, 32_768)
})

// ─────────────────────────── the previous close (six-playbooks spec F6)

/** One `md.spot` frame carrying the previous close, as marketdata now sends it. */
function closeFrame(underlying: string, ts: number, prevClose: number): MdSpot {
  return { underlying, price: NIFTY_SPOT, ts, prevClose }
}

test('the previous close rides md.spot into the supervisor — a finite positive one, per symbol', async () => {
  const r = await bothBooks()
  // Nothing yet: UNKNOWN, never a zero close (a zero is a -100% gap).
  assert.equal(r.supervisor.prevCloseFor(NIFTY), null)

  r.bus.emit('md.spot', [closeFrame(NIFTY, r.now, 23_910.4)])
  assert.equal(r.supervisor.prevCloseFor(NIFTY), 23_910.4)
  assert.equal(r.supervisor.prevCloseFor(SENSEX), null, 'one symbol`s close is not another`s')

  // A frame without one says nothing about it — absent is unknown, and the
  // close this session already saw stands. One carrying junk is not a close.
  r.now += 1_000
  r.bus.spot(NIFTY, NIFTY_SPOT + 1, r.now)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    r.now += 1_000
    r.bus.emit('md.spot', [closeFrame(NIFTY, r.now, bad)])
  }
  assert.equal(r.supervisor.prevCloseFor(NIFTY), 23_910.4)

  // A frame out of time order is dropped WHOLE, its close with it.
  r.bus.emit('md.spot', [closeFrame(NIFTY, T0 - 60_000, 1)])
  assert.equal(r.supervisor.prevCloseFor(NIFTY), 23_910.4)

  // A real correction is taken.
  r.now += 1_000
  r.bus.emit('md.spot', [closeFrame(NIFTY, r.now, 23_912)])
  assert.equal(r.supervisor.prevCloseFor(NIFTY), 23_912)
})

test('a symbol no book manages keeps no close at all', async () => {
  const r = await bothBooks()
  r.bus.emit('md.spot', [closeFrame('BHEL', r.now, 250)])
  assert.equal(r.supervisor.prevCloseFor('BHEL'), null)
})

test('yesterday`s previous close is not today`s — a close is answered only on its own session', async () => {
  // The supervisor runs across midnight. The close a frame carried on the 15th
  // is the 14th's; on the 16th, until the first frame says otherwise, the
  // previous close is unknown rather than two sessions old.
  const r = await bothBooks()
  r.bus.emit('md.spot', [closeFrame(NIFTY, r.now, 23_910.4)])
  r.now += 24 * 3_600_000
  assert.equal(r.supervisor.prevCloseFor(NIFTY), null)

  r.bus.emit('md.spot', [closeFrame(NIFTY, r.now, 23_990)])
  assert.equal(r.supervisor.prevCloseFor(NIFTY), 23_990)
})

// ─────────────────────── the chain's own forward (six-playbooks spec F1)

test('DESK_CHAIN_FORWARD: only "future" overrides the books, and it is read as one word', () => {
  assert.equal(chainForwardOverride({}), null)
  assert.equal(chainForwardOverride({ DESK_CHAIN_FORWARD: 'future' }), 'future')
  assert.equal(chainForwardOverride({ DESK_CHAIN_FORWARD: ' Future ' }), 'future')
  for (const other of ['', 'parity', 'futures', 'off']) {
    assert.equal(chainForwardOverride({ DESK_CHAIN_FORWARD: other }), null, `"${other}" is not the revert`)
  }
})

test('the per-book rule: parity iff delta_lean_enabled AND dl_parity_forward, and the override wins', () => {
  const lean = (over: Partial<Dials>): Dials => ({ ...DEFAULT_DIALS, delta_lean_enabled: true, ...over })
  assert.equal(chainForwardFor(lean({ dl_parity_forward: true }), null), 'parity')
  assert.equal(chainForwardFor(lean({ dl_parity_forward: true }), 'future'), 'future')
  // The override never moves a hold-to-expiry book: it carries legs across
  // the restart that sets (or clears) it, and would be repriced mid-contract.
  assert.equal(chainForwardFor(lean({ dl_parity_forward: true, dl_hold_to_expiry: true }), 'future'), 'parity')
  assert.equal(chainForwardFor(lean({ dl_parity_forward: false, dl_hold_to_expiry: true }), 'future'), 'future')
  assert.equal(chainForwardFor(lean({ dl_parity_forward: true, dl_hold_to_expiry: true }), null), 'parity')
  // A row registered before the dial existed resolves it off, and keeps the
  // future it was measured on (spec F1, review finding 8).
  assert.equal(chainForwardFor(lean({ dl_parity_forward: false }), null), 'future')
  // A recenter book never gets it, whatever its row says.
  assert.equal(chainForwardFor({ ...DEFAULT_DIALS, dl_parity_forward: true }, null), 'future')
  assert.equal(chainForwardFor(DEFAULT_DIALS, null), 'future')
  // Every preset the roll creates from: the delta-lean family and the six
  // playbooks ask for it, and no recenter preset does.
  for (const preset of PRESETS) {
    const { dials } = resolveDials(preset.dials as Record<string, number | boolean>)
    assert.equal(chainForwardFor(dials, null), dials.delta_lean_enabled ? 'parity' : 'future', preset.key)
  }
})

/** The near-month future, quoted 300 points ABOVE the board's own forward. */
function futureTick(ts: number, mid = NIFTY_SPOT + 300): MdTick {
  return { token: NIFTY_FUTURE, price: mid, ts, bid: mid - 0.5, ask: mid + 0.5 }
}

const PARITY_DIALS = { delta_lean_enabled: true, dl_parity_forward: true, confirm_ms: 0 }

test('a dl_parity_forward book is priced off its own chain; its neighbour on the same chain keeps the future', async () => {
  // One chain, one shared view, two books. The board is Black-76 at 24,000 and
  // the future quotes 24,300: the parity book must read the first, the book
  // without the dial the second — and each mark must name its own source, not
  // whichever book the shared view snapped last.
  const NEIGHBOUR = 'NIFTY-2026-09-22-delta-lean-b'
  const r = rig([
    registryRow(NIFTY_TAG, NIFTY, NIFTY_EXPIRY, { dials: PARITY_DIALS }),
    registryRow(NEIGHBOUR, NIFTY, NIFTY_EXPIRY),
  ])
  await r.supervisor.boot()
  r.bus.spot(NIFTY, NIFTY_SPOT, r.now)
  r.bus.emit('md.tick', [...optionFrame(r.now), futureTick(r.now)])
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length >= 2)

  const own = r.marks().find((m) => m['tag'] === NIFTY_TAG)
  const kept = r.marks().find((m) => m['tag'] === NEIGHBOUR)
  assert.ok(own !== undefined && kept !== undefined, 'both books marked')
  assert.ok(Math.abs(Number(own['spot']) - NIFTY_SPOT) < 0.5, `parity spot ${String(own['spot'])}`)
  assert.equal(own['forwardSource'], 'parity')
  assert.equal(kept['spot'], NIFTY_SPOT + 300)
  assert.equal(kept['forwardSource'], 'future')
})

test('one bad index print cannot throw a clean parity read out — the band and the carry read the steadied index', async () => {
  // Integration review finding 4: the parity read is sanity-banded against the
  // index (0.6%), and the fallback carries it. Read RAW, one print 1.25% off
  // replaced a clean parity forward with index x carry six strikes away, and
  // the host's one-step invalidation then cancelled every working package on
  // the symbol. The level is the median of the newest three prints.
  const r = rig([registryRow(NIFTY_TAG, NIFTY, NIFTY_EXPIRY, { dials: PARITY_DIALS })])
  await r.supervisor.boot()
  r.bus.spot(NIFTY, NIFTY_SPOT, r.now - 2_000)
  r.bus.spot(NIFTY, NIFTY_SPOT + 1, r.now - 1_000)
  r.bus.spot(NIFTY, NIFTY_SPOT * 1.0125, r.now) // the bad print: 300 points up
  r.bus.emit('md.tick', [...optionFrame(r.now), futureTick(r.now)])
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 0)

  const mark = r.marks().find((m) => m['tag'] === NIFTY_TAG)
  assert.ok(mark !== undefined)
  assert.equal(mark['forwardSource'], 'parity', 'one print moved the forward off parity')
  assert.ok(Math.abs(Number(mark['spot']) - NIFTY_SPOT) < 0.5, `parity spot ${String(mark['spot'])}`)
})

test('DESK_CHAIN_FORWARD=future puts that same book back on the future`s mid', async () => {
  const r = rig([registryRow(NIFTY_TAG, NIFTY, NIFTY_EXPIRY, { dials: PARITY_DIALS })], {
    chainForward: 'future',
  })
  await r.supervisor.boot()
  r.bus.spot(NIFTY, NIFTY_SPOT, r.now)
  r.bus.emit('md.tick', [...optionFrame(r.now), futureTick(r.now)])
  await r.supervisor.evaluateDue()
  await until(() => r.marks().length > 0)

  const mark = r.marks().find((m) => m['tag'] === NIFTY_TAG)
  assert.ok(mark !== undefined)
  assert.equal(mark['spot'], NIFTY_SPOT + 300)
  assert.equal(mark['forwardSource'], 'future')
})
