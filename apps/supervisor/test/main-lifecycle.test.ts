/**
 * THE PROCESS, END TO END — with a fake bus, a fake desk-api and a clock this
 * file moves by hand.
 *
 * Everything below is about the WIRING rather than about a rule, because the
 * rules are already proven (1,152 parity marks) and the wiring is where this
 * desk's expensive failures have actually come from:
 *
 *   1. **A tick has to reach an order.** The whole chain — bus → `ChainView` →
 *      `EngineHost.evaluate()` → the decisions client — is one wire, and any
 *      link left unconnected presents as a desk that looks perfectly healthy and
 *      never trades (the runner's 2026-07 subscription hole, exactly).
 *   2. **THE SNAP IS THE DECLARATION.** A `ChainView` drops ticks for chains
 *      nothing has asked for, so a boot that subscribed before snapping would
 *      throw away every tick until the first evaluation — which cannot happen,
 *      because the first evaluation needs a snap.
 *   3. **D6: THE STOP IS INERT.** After SIGTERM the fake client must receive
 *      NOTHING. Not "nothing important" — nothing. Every restart path reaches
 *      that handler, including `max_memory_restart` at 11:40 with nobody
 *      watching, and the runner's square-off-on-stop cost this desk a live book.
 *   4. **A dial change lands on the NEXT evaluation**, without a restart. The
 *      registry poll re-resolves the dials every pass and the host reads them
 *      through a closure; a host that captured them at construction would make
 *      every retune a lie until somebody bounced the process.
 *   5. **The subscription is the COMPLETE token list**, published under this
 *      process's own source name — the thing that makes the feed carry the
 *      chains at all.
 *
 * No Mongo, no network, no wall clock. The database is an in-memory fake with
 * the two behaviours the state store's compare-and-set is built on (those are
 * proved against a real Mongo in `state-store.test.ts`); the bus is an emitter;
 * desk-api is a recorder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIALS, type DecisionRequest, type DecisionResponse } from '@algomaker/desk-engine'
import { Supervisor, type BusPort, type DeskApiPort, type MasterPort } from '../src/main.ts'
import { Lease } from '../src/lease.ts'
import type { ChainToken, MdTick } from '../src/chain-view.ts'
import type { HostLog } from '../src/engine-host.ts'

// ────────────────────────────────────────────────────────────── the market

/** 2026-08-21 (a Friday) 10:00 IST. */
const T0 = Date.UTC(2026, 7, 21, 4, 30)
const TAG = 'TCS-2026-08-28-recenter-r'
const SYMBOL = 'TCS'
const EXPIRY = '2026-08-28'
const LOT = 25
const STEP = 10
const SPOT = 300
const FUTURE_TOKEN = 900_001

const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * STEP)
const tokenOf = (strike: number, optType: 'CE' | 'PE'): number =>
  strike * 10 + (optType === 'CE' ? 1 : 2)
const symbolOf = (strike: number, optType: 'CE' | 'PE'): string =>
  `TCS26AUG${String(strike)}${optType}`

/** Intrinsic plus two rupees, so every strike implies a volatility. */
const theo = (strike: number, optType: 'CE' | 'PE'): number =>
  Math.max(0.5, (optType === 'CE' ? SPOT - strike : strike - SPOT) + 2)

const master: MasterPort = {
  tokensFor: (symbol, expiry): ChainToken[] =>
    symbol !== SYMBOL || expiry !== EXPIRY
      ? []
      : LADDER.flatMap((strike) =>
          (['CE', 'PE'] as const).map(
            (optType): ChainToken => ({
              token: tokenOf(strike, optType),
              strike,
              optType,
              instrument: symbolOf(strike, optType),
            }),
          ),
        ),
  futureToken: (symbol) => (symbol === SYMBOL ? FUTURE_TOKEN : 0),
  instrumentFor: (symbol, expiry, strike, optType) =>
    symbol === SYMBOL && expiry === EXPIRY ? symbolOf(strike, optType) : null,
  tickSizeFor: () => 0.05,
  chainMeta: (symbol, expiry) =>
    symbol === SYMBOL && expiry === EXPIRY ? { lotSize: LOT, step: STEP } : { lotSize: 0, step: 0 },
}

/** Every tick of one frame of the market, the shape `apps/marketdata` sends. */
function frame(ts: number): MdTick[] {
  const ticks: MdTick[] = [
    { token: FUTURE_TOKEN, price: SPOT, ts, bid: SPOT - 0.5, ask: SPOT + 0.5 },
  ]
  for (const strike of LADDER) {
    for (const optType of ['CE', 'PE'] as const) {
      const p = theo(strike, optType)
      ticks.push({
        token: tokenOf(strike, optType),
        price: p,
        ts,
        bid: Number((p * 0.98).toFixed(2)),
        ask: Number((p * 1.02).toFixed(2)),
      })
    }
  }
  return ticks
}

// ─────────────────────────────────────────────────────────────── the fakes

/** The narrowest Mongo that satisfies everything this process reads. */
class FakeDb {
  readonly rows = new Map<string, Record<string, unknown>[]>()
  /**
   * A barrier one collection's READS wait behind, and a flag saying one has
   * arrived.
   *
   * Armed BEFORE the `Supervisor` is constructed, because some collections are
   * resolved once in the constructor and some on every call — a test that
   * monkey-patched `collection()` afterwards would silently miss the first kind
   * and prove nothing. This lives inside the fake, so it catches both.
   */
  readonly #parks = new Map<string, { gate: Promise<void>; hit: () => void }>()

  park(name: string, gate: Promise<void>, hit: () => void): void {
    this.#parks.set(name, { gate, hit })
  }

  async #wait(name: string): Promise<void> {
    const park = this.#parks.get(name)
    if (park === undefined) return
    park.hit()
    await park.gate
  }

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
        toArray: async (): Promise<Record<string, unknown>[]> => {
          await this.#wait(name)
          return rows.filter((d) => matches(d, filter)).map((d) => ({ ...d }))
        },
      }),
      findOne: async (filter: Record<string, unknown> = {}) => {
        await this.#wait(name)
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
        // The unique keys this process depends on: `key` for the state store and
        // the lease. A colliding upsert must be a duplicate-key error, not a
        // second document — that is what makes exactly one supervisor steer.
        const key = (filter['key'] ?? set['key']) as unknown
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

class FakeBus implements BusPort {
  readonly handlers: ((msg: { payload: MdTick }) => void)[] = []
  closed = false

  subscribe<T>(_pattern: string, handler: (msg: { payload: T }) => void): () => void {
    const h = handler as unknown as (msg: { payload: MdTick }) => void
    this.handlers.push(h)
    return (): void => {
      const at = this.handlers.indexOf(h)
      if (at >= 0) this.handlers.splice(at, 1)
    }
  }

  async ready(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
  }

  /** One frame of the feed, to every live subscriber. */
  emit(ticks: MdTick[]): void {
    for (const tick of ticks) for (const h of [...this.handlers]) h({ payload: tick })
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
  readonly reports: { key: string; actual: string; lastDecision: string }[] = []
  readonly cancels: string[] = []

  async reportActual(
    book: { key: string },
    actual: 'running' | 'stopped',
    _at: number,
    lastDecision: string,
  ): Promise<void> {
    this.reports.push({ key: book.key, actual, lastDecision })
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    this.cancels.push(brokerOrderId)
  }
}

interface Entry {
  readonly level: string
  readonly msg: string
  readonly tag: string
}

function logOf(): HostLog & { lines: string[]; entries: Entry[] } {
  const lines: string[] = []
  // The same lines WITH the book they came from, so a test with two books can
  // tell which one evaluated. `lines` is untouched: every existing assertion
  // reads it.
  const entries: Entry[] = []
  const push =
    (level: string) =>
    (msg: string, ctx: Record<string, unknown> = {}): void => {
      lines.push(`${level}: ${msg}`)
      entries.push({ level, msg, tag: String(ctx['tag'] ?? '') })
    }
  return {
    lines,
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
  readonly api: FakeApi
  readonly log: HostLog & { lines: string[]; entries: Entry[] }
  now: number
  /** One frame of the feed plus one coalesced evaluation pass. */
  tick(): Promise<void>
}

/** Spin the microtask queue until `ready`, or give up. No wall clock. */
async function until(ready: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !ready(); i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** A deep-ITM short PE: netΔ far outside the band, so phase R sheds at once. */
function shortBook(): Record<string, unknown> {
  return {
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  }
}

function registryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: TAG,
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'paper',
    variant: 'recenter-relief-r',
    // `confirm_ms: 0` so one frame is enough to route: the damping is proved in
    // `engine-host.test.ts` and repeating it here would only make this suite
    // about a rule instead of about the wiring.
    dials: { confirm_ms: 0, cooldown_s: 0, margin_cap: 0, shift_enabled: false },
    desired: 'running',
    actual: 'stopped',
    ...over,
  }
}

function rig(): Rig {
  const db = new FakeDb()
  const bus = new FakeBus()
  const client = new FakeClient()
  const api = new FakeApi()
  const log = logOf()
  const r = {
    db,
    bus,
    client,
    api,
    log,
    now: T0,
  } as Rig
  const supervisor = new Supervisor({
    db: db as never,
    bus,
    client,
    api,
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
  })
  return Object.assign(r, {
    supervisor,
    tick: async (): Promise<void> => {
      bus.emit(frame(r.now))
      // The coalesced pass the timer would run. Called directly rather than
      // waited for, so the suite has no wall clock in it at all.
      await supervisor.evaluateDue()
    },
  })
}

// ───────────────────────────────────────────────────────────────── tests

test('boot builds the book, publishes its tokens, and the first tick routes', async () => {
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  // A deep-ITM short PE: netΔ far outside the band, so phase R sheds at once.
  r.db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  })

  await r.supervisor.boot()
  assert.deepEqual(r.supervisor.books, [`${TAG}:paper`])

  // The COMPLETE token list, under this process's own source name. Without it
  // the feed carries nothing this book needs, and the book simply never decides.
  const declared = r.db.of('desk-subscriptions')[0]
  assert.ok(declared !== undefined)
  assert.equal(declared['source'], 'desk-supervisor')
  const tokens = declared['tokens'] as number[]
  assert.equal(tokens.length, LADDER.length * 2 + 1)
  assert.ok(tokens.includes(FUTURE_TOKEN))
  assert.ok(tokens.includes(tokenOf(330, 'CE')))

  await r.tick()

  assert.equal(r.client.requests.length, 1)
  const req = r.client.requests[0]
  assert.ok(req !== undefined)
  assert.equal(req.tag, TAG)
  assert.equal(req.mode, 'paper')
  assert.equal(req.decisionId, `${TAG}:paper:1`)
  assert.equal(req.symbol, SYMBOL)
  assert.equal(req.expiry, EXPIRY)
  assert.ok(req.actions.some((a) => a.op === 'open' && a.side === 'Sell'))

  await r.supervisor.stop('TEST')
})

test('SIGTERM IS INERT — the client receives NOTHING after the signal (D6)', async () => {
  /**
   * The one test this file exists for. A stop that squares off is a stop that
   * places real orders with nobody watching: `max_memory_restart` at 11:40, a
   * reboot, a `make restart` mid-session. The runner shipped that behaviour and
   * it cost a live book (2026-08-17), and this process has NO opt-in to it at
   * all — not even one that is off by default.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  r.db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  })
  await r.supervisor.boot()
  await r.tick()
  const before = r.client.requests.length
  assert.ok(before > 0, 'the book was trading before the signal')

  await r.supervisor.stop('SIGTERM')

  // Everything that would have driven another decision, driven anyway.
  r.now += 10 * 60_000
  r.bus.emit(frame(r.now))
  await r.supervisor.evaluateDue()
  await r.supervisor.pollFlights()
  r.supervisor.nudge('fill')
  r.supervisor.nudge('dials')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(r.client.requests.length, before, 'NOTHING was sent after the signal')
  // And the book is still there, untouched: the state is durable and a restart
  // resumes it.
  assert.equal(r.db.of('desk-books')[0]?.['legs'] !== undefined, true)
  // The lease is HANDED BACK rather than left to lapse, so a standby takes over
  // in a second instead of waiting out the TTL.
  assert.equal(r.db.of('desk-supervisor-lease').length, 0)
  assert.ok(r.log.lines.some((l) => l.includes('WITHOUT touching a book')))
})

test('SIGTERM MID-PASS: a decision formed before the signal never reaches the wire', async () => {
  /**
   * The D6 test above proves nothing NEW starts. This one proves the window that
   * flag cannot close on its own: a pass already inside `evaluate()` — past every
   * timer, between its book read and its route — which `drain()` would otherwise
   * politely let finish burning a `seq` and posting an order with nobody
   * watching. The stop has to reach the HOST, not just the loops.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  r.db.of('desk-books').push(shortBook())
  await r.supervisor.boot()

  // Park the book read the next pass will make.
  let release = (): void => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let parked = false
  r.db.park('desk-books', barrier, () => {
    parked = true
  })

  r.bus.emit(frame(r.now))
  const pass = r.supervisor.evaluateDue()
  await until(() => parked)
  assert.equal(parked, true, 'a pass is in flight, past every timer')

  // SIGTERM lands while it is parked.
  const stopping = r.supervisor.stop('SIGTERM')
  release()
  await pass
  await stopping

  assert.equal(r.client.requests.length, 0, 'the formed package never reached the wire')
  assert.equal(r.db.of('desk-supervisor-state').length, 0, 'and no seq was burnt')
})

test('SIGTERM DURING BOOT: nothing is armed and no boot replay is posted', async () => {
  /**
   * `main` installs the signal handlers before it awaits `boot()`, and it has to:
   * a standby's lease wait has no end. So a shutdown must be able to interrupt a
   * boot — and every line of `boot()` is an await, including the one that
   * REPLAYS an in-flight decision, which is a POST.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  const actions = [{ op: 'open', instrument: symbolOf(330, 'CE'), side: 'Sell', qty: 25 }]
  r.db.of('desk-supervisor-state').push({
    key: `${TAG}:paper`,
    inFlight: `${TAG}:paper:7`,
    seq: 7,
    updatedAt: T0 - 60_000,
    workingPackage: {
      decisionId: `${TAG}:paper:7`,
      remaining: actions,
      request: {
        tag: TAG,
        mode: 'paper',
        decisionId: `${TAG}:paper:7`,
        symbol: SYMBOL,
        expiry: EXPIRY,
        trigger: 'shed',
        reason: 'the band was breached',
        actions,
      },
      basis: [],
      formedAt: T0 - 60_000,
      formedSpot: SPOT,
    },
  })

  // Park the registry read the boot makes.
  let release = (): void => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let parked = false
  r.db.park('desk-books-registry', barrier, () => {
    parked = true
  })

  const booting = r.supervisor.boot()
  await until(() => parked)
  assert.equal(parked, true, 'the boot is mid-read')

  await r.supervisor.stop('SIGTERM')
  release()
  await booting

  assert.equal(r.client.requests.length, 0, 'the in-flight decision was NOT replayed')
  assert.deepEqual(r.supervisor.books, [], 'no book was taken up')
  // Nothing armed: driving the loops by hand is the only way anything runs, and
  // even that must do nothing.
  r.bus.emit(frame(r.now))
  await r.supervisor.evaluateDue()
  await r.supervisor.pollFlights()
  assert.equal(r.client.requests.length, 0)
  assert.ok(r.log.lines.some((l) => l.includes('boot was interrupted')))
})

test('SIGTERM INSIDE #start: the book is dropped and its flight is not replayed', async () => {
  /**
   * The sibling of the test above, at the other await boundary. `#start` reads
   * a margin figure before it replays an in-flight decision, so a signal can
   * land BETWEEN the entry check and the POST — which is the window a single
   * check at the top of `boot()` cannot see. Each of the three checks on this
   * path guards a different await; this one is the last of them.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  const actions = [{ op: 'open', instrument: symbolOf(330, 'CE'), side: 'Sell', qty: 25 }]
  r.db.of('desk-supervisor-state').push({
    key: `${TAG}:paper`,
    inFlight: `${TAG}:paper:7`,
    seq: 7,
    updatedAt: T0 - 60_000,
    workingPackage: {
      decisionId: `${TAG}:paper:7`,
      remaining: actions,
      request: {
        tag: TAG,
        mode: 'paper',
        decisionId: `${TAG}:paper:7`,
        symbol: SYMBOL,
        expiry: EXPIRY,
        trigger: 'shed',
        reason: 'the band was breached',
        actions,
      },
      basis: [],
      formedAt: T0 - 60_000,
      formedSpot: SPOT,
    },
  })

  // The margin read is INSIDE `#start`, after it has taken the book up.
  let release = (): void => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let parked = false
  r.db.park('desk-book-margin', barrier, () => {
    parked = true
  })

  const booting = r.supervisor.boot()
  await until(() => parked)
  assert.equal(parked, true, 'the boot is inside #start')

  await r.supervisor.stop('SIGTERM')
  release()
  await booting

  assert.equal(r.client.requests.length, 0, 'the in-flight decision was NOT replayed')
  assert.deepEqual(r.supervisor.books, [], 'the half-built book was dropped, not left registered')
})

test('A DIAL CHANGE LANDS ON THE NEXT EVALUATION, with no restart', async () => {
  const r = rig()
  // A band so wide that nothing is ever outside it: the book holds.
  r.db.of('desk-books-registry').push(
    registryRow({ dials: { confirm_ms: 0, cooldown_s: 0, margin_cap: 0, delta_tol_pct: 5 } }),
  )
  r.db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  })
  await r.supervisor.boot()
  await r.tick()
  assert.equal(r.client.requests.length, 0, 'inside the band, nothing to do')

  // The operator retunes the corridor. desk-api writes the row and nudges.
  r.db.of('desk-books-registry')[0] = registryRow({
    dials: { confirm_ms: 0, cooldown_s: 0, margin_cap: 0, delta_tol_pct: 0.02 },
  })
  r.supervisor.nudge('dials')
  await new Promise((resolve) => setImmediate(resolve))

  r.now += 1_000
  await r.tick()
  assert.equal(r.client.requests.length, 1, 'the very next evaluation used the new dial')

  await r.supervisor.stop('TEST')
})

test('a book whose strategy switch is OFF posts nothing and the page says so', async () => {
  /**
   * The wiring of spec E3: the registry poll reads `desk-strategies` beside the
   * registry, hands the switch to the host, and the host's stand-down reason
   * reaches the registry row's `lastDecision` through the heartbeat — so the
   * book page says "switched off for paper" instead of showing a book that has
   * silently gone quiet. A PATCH on the strategy row lands within one poll
   * pass: there is no nudge for it, the 5 s poll is the guarantee.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  // The boot test's book: a deep-ITM short PE the recenter engine answers with
  // an `open Sell` on the very first tick. An OPEN is new risk, which is what a
  // switched-off book may not take; a flat book would hold anyway and prove
  // nothing here.
  r.db.of('desk-books').push(shortBook())
  const strategy: Record<string, unknown> = {
    tag: TAG,
    kind: 'external',
    label: TAG,
    liveLots: 0,
    modes: { paper: { enabled: false } },
    updatedAt: 1,
  }
  r.db.of('desk-strategies').push(strategy)
  await r.supervisor.boot()
  assert.deepEqual(r.supervisor.books, [`${TAG}:paper`], 'the book is steered — the switch is not a stop')

  r.now += 1_000
  await r.tick()
  assert.equal(r.client.requests.length, 0, 'a switched-off book takes no new risk')
  r.supervisor.nudge('registry')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(
    (r.api.reports.at(-1)?.lastDecision ?? '').includes('switched off'),
    'and the page is told why',
  )

  // The operator flips the switch on: the next poll pass carries it to the
  // host, and the next tick decides.
  strategy['modes'] = { paper: { enabled: true } }
  r.supervisor.nudge('registry')
  await new Promise((resolve) => setImmediate(resolve))
  r.now += 1_000
  await r.tick()
  assert.equal(r.client.requests.length, 1, 'deciding again')
  assert.ok(r.client.requests[0]?.actions.some((a) => a.op === 'open'), 'and it is the open that was held')
  r.supervisor.nudge('registry')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(
    !(r.api.reports.at(-1)?.lastDecision ?? '').includes('switched off'),
    'the page no longer says it is standing down',
  )

  await r.supervisor.stop('TEST')
})

test('a book switched off stops being steered and places NOTHING', async () => {
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  r.db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  })
  await r.supervisor.boot()
  assert.deepEqual(r.supervisor.books, [`${TAG}:paper`])

  r.db.of('desk-books-registry')[0] = registryRow({ desired: 'stopped' })
  r.supervisor.nudge('registry')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(r.supervisor.books, [])
  // And the page is TOLD, or it would show a book the operator switched off as
  // still being steered forever.
  assert.equal(r.api.reports.at(-1)?.actual, 'stopped')
  r.now += 1_000
  await r.tick()
  assert.equal(r.client.requests.length, 0)
  // The legs are exactly where they were. Switching a book off is not a close.
  assert.equal((r.db.of('desk-books')[0]?.['legs'] as unknown[]).length, 1)

  await r.supervisor.stop('TEST')
})

test('THE WARM START IS SCOPED to the managed books’ tokens', async () => {
  // `ChainView`'s whole memory argument is that it holds the declared set and
  // nothing else (F-53). Reading all of `desk-marks` would seed it with every
  // token the desk has ever subscribed — thousands of prices that will never
  // update again.
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  const marks = r.db.of('desk-marks')
  marks.push({ token: FUTURE_TOKEN, price: SPOT, ts: T0 - 60_000, bid: SPOT - 1, ask: SPOT + 1 })
  marks.push({ token: tokenOf(330, 'CE'), price: 2, ts: T0 - 60_000, bid: 1.9, ask: 2.1 })
  marks.push({ token: 42, price: 1, ts: T0 - 60_000, bid: 0.9, ask: 1.1 })

  const seen: Record<string, unknown>[] = []
  const find = r.db.collection('desk-marks') as unknown as {
    find: (f: Record<string, unknown>) => unknown
  }
  void find
  // The query itself is what is asserted: a scan would carry the foreign token.
  const original = r.db.collection.bind(r.db)
  r.db.collection = ((name: string) => {
    const col = original(name) as unknown as Record<string, unknown>
    if (name !== 'desk-marks') return col as never
    return {
      ...col,
      find: (filter: Record<string, unknown>) => {
        seen.push(filter)
        return (col['find'] as (f: Record<string, unknown>) => unknown)(filter)
      },
    } as never
  }) as typeof r.db.collection

  await r.supervisor.boot()

  assert.equal(seen.length, 1)
  const scope = seen[0]?.['token'] as { $in: number[] }
  assert.ok(Array.isArray(scope.$in))
  assert.ok(scope.$in.includes(FUTURE_TOKEN))
  assert.equal(scope.$in.includes(42), false, 'a token no book wants is never even read')

  await r.supervisor.stop('TEST')
})

test('a SECOND supervisor stands by — it steers nothing and says so', async () => {
  // Two supervisors on one book both work, perfectly, against the same broker
  // position. The second one waiting is the correct state, and `/health` has to
  // be able to say it is that rather than a process that failed to start.
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  await r.supervisor.boot()

  const standby = new Supervisor({
    db: r.db as never,
    bus: r.bus,
    client: r.client,
    api: r.api,
    master: () => master,
    lease: new Lease({
      collection: r.db.collection('desk-supervisor-lease'),
      key: 'desk-supervisor',
      now: () => r.now,
    }),
    owner: 'test:2',
    now: () => r.now,
    log: r.log,
    leaseRetryMs: 1,
  })
  const health = standby.health()
  assert.equal(health.lease, null)
  assert.deepEqual(health.books, [])

  // It is still trying, and it must never have decided anything meanwhile.
  const booting = standby.boot()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(standby.books, [])

  await standby.stop('TEST')
  await booting
  await r.supervisor.stop('TEST')
})

test('/health reports the books, the lease and the feed’s age', async () => {
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  await r.supervisor.boot()
  assert.equal(r.supervisor.health().feedAgeMs, null, 'nothing has ticked yet')

  r.bus.emit(frame(r.now))
  r.now += 4_000
  const health = r.supervisor.health()
  assert.deepEqual(health.books, [`${TAG}:paper`])
  assert.equal(health.lease, 'test:1')
  assert.equal(health.feedAgeMs, 4_000)

  await r.supervisor.stop('TEST')
})

test('THE MARK IS JOURNALLED, once per window, with the dials that decided it', async () => {
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow({ dials: { confirm_ms: 0, delta_tol_pct: 5 } }))
  r.db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  })
  await r.supervisor.boot()
  await r.tick()
  r.now += 60_000
  await r.tick()

  const rows = r.db.of('desk-book-marks')
  assert.equal(rows.length, 1, 'two evaluations inside one window are ONE mark')
  const row = rows[0]
  assert.ok(row !== undefined)
  assert.equal(row['tag'], TAG)
  assert.equal(row['mode'], 'paper')
  assert.equal(row['dateIst'], '2026-08-21')
  assert.equal(row['spot'], SPOT)
  assert.equal(row['marginSource'], 'model')
  assert.ok(Number(row['netDelta']) > 0)
  assert.ok(typeof row['reason'] === 'string' && row['reason'] !== '')

  r.now = T0 + 5 * 60_000
  await r.tick()
  assert.equal(r.db.of('desk-book-marks').length, 2)

  await r.supervisor.stop('TEST')
})

test('the registry heartbeat reports `actual: running` with the last decision', async () => {
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow({ dials: { confirm_ms: 0, delta_tol_pct: 5 } }))
  r.db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  })
  await r.supervisor.boot()
  assert.deepEqual(r.api.reports, [{ key: `${TAG}:paper`, actual: 'running', lastDecision: '' }])

  await r.tick()
  r.supervisor.nudge('registry')
  await new Promise((resolve) => setImmediate(resolve))

  const last = r.api.reports.at(-1)
  assert.ok(last !== undefined)
  assert.ok(last.lastDecision !== '', 'the page shows what the book is actually doing')

  await r.supervisor.stop('TEST')
})

test('THE 1-SECOND POLL IS REALLY ARMED — a working package resolves itself', async () => {
  /**
   * The one test in this file that spends real time, and it is worth it.
   * `evaluate()` no longer re-posts an in-flight decision: `pollInFlight` and the
   * fill nudge are the ONLY things that ask desk-api again. A deployment that
   * built every other loop and forgot this one would hold every working package
   * for the rest of the session — the book would simply stop trading, with
   * nothing in the log to say why. Driving `pollFlights()` by hand proves the
   * method; only the wall clock proves the TIMER.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  r.db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: [
      {
        instrument: { tradingsymbol: symbolOf(360, 'PE'), lotSize: LOT },
        strike: 360,
        type: 'PE',
        qty: -4 * LOT,
        entryPrice: 60,
      },
    ],
  })
  // The paper rail's real answer: the orders are resting, fills come later.
  let answered = 0
  r.client.submit = async (req: DecisionRequest): Promise<DecisionResponse> => {
    r.client.requests.push(structuredClone(req))
    answered += 1
    return {
      decisionId: req.decisionId,
      replayed: answered > 1,
      status: answered === 1 ? 'WORKING' : 'DONE',
      fills: [],
      skips: [],
      routeErrors: [],
    }
  }

  await r.supervisor.boot()
  await r.tick()
  assert.equal(r.client.requests.length, 1, 'the package went out and is WORKING')

  // Nothing is called by hand from here on.
  await new Promise((resolve) => setTimeout(resolve, 1_300))

  assert.equal(r.client.requests.length, 2, 'the poll asked again, on its own')
  assert.equal(r.client.requests[1]?.decisionId, `${TAG}:paper:1`, 'the SAME id, replayed')

  await r.supervisor.stop('TEST')
})

test('A DECISION LEFT IN FLIGHT IS REPLAYED VERBATIM, before anything else decides', async () => {
  /**
   * The crash this recovers from may have happened EITHER SIDE of the post, so
   * the replay is both "what happened to my package?" and, if the answer is that
   * it never arrived, the package itself. It has to go out before the first
   * evaluation, or this book decides against a position an unresolved package
   * may still be moving — and it has to go out as it was WRITTEN, because a body
   * rebuilt from today's market would route a package this supervisor never
   * decided on.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  const actions = [{ op: 'open', instrument: symbolOf(330, 'CE'), side: 'Sell', qty: 25 }]
  r.db.of('desk-supervisor-state').push({
    key: `${TAG}:paper`,
    inFlight: `${TAG}:paper:7`,
    seq: 7,
    updatedAt: T0 - 60_000,
    workingPackage: {
      decisionId: `${TAG}:paper:7`,
      remaining: actions,
      request: {
        tag: TAG,
        mode: 'paper',
        decisionId: `${TAG}:paper:7`,
        symbol: SYMBOL,
        expiry: EXPIRY,
        trigger: 'shed',
        reason: 'the band was breached',
        actions,
      },
      basis: [],
      formedAt: T0 - 60_000,
      formedSpot: SPOT,
    },
  })

  await r.supervisor.boot()

  assert.equal(r.client.requests.length, 1)
  const replay = r.client.requests[0]
  assert.ok(replay !== undefined)
  assert.equal(replay.decisionId, `${TAG}:paper:7`)
  // VERBATIM: the same reason, the same actions, no re-derivation.
  assert.equal(replay.reason, 'the band was breached')
  assert.deepEqual(replay.actions, actions)

  await r.supervisor.stop('TEST')
})

test('a boot replay that cannot reach desk-api leaves the book NOT running', async () => {
  // A half-built book is not a running one. Left in the map, the registry poll
  // would report `actual: 'running'` for a book whose in-flight decision was
  // never resolved — and would never try again, because the next pass would see
  // it as already started.
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  const actions = [{ op: 'open', instrument: symbolOf(330, 'CE'), side: 'Sell', qty: 25 }]
  r.db.of('desk-supervisor-state').push({
    key: `${TAG}:paper`,
    inFlight: `${TAG}:paper:7`,
    seq: 7,
    updatedAt: T0 - 60_000,
    workingPackage: {
      decisionId: `${TAG}:paper:7`,
      remaining: actions,
      request: {
        tag: TAG,
        mode: 'paper',
        decisionId: `${TAG}:paper:7`,
        symbol: SYMBOL,
        expiry: EXPIRY,
        trigger: 'shed',
        reason: 'the band was breached',
        actions,
      },
      basis: [],
      formedAt: T0 - 60_000,
      formedSpot: SPOT,
    },
  })
  let down = true
  r.client.submit = async (req: DecisionRequest): Promise<DecisionResponse> => {
    if (down) throw new Error('desk-api is unreachable')
    r.client.requests.push(structuredClone(req))
    return {
      decisionId: req.decisionId,
      replayed: true,
      status: 'DONE',
      fills: [],
      skips: [],
      routeErrors: [],
    }
  }

  await r.supervisor.boot()
  assert.deepEqual(r.supervisor.books, [], 'the book was NOT taken up')
  assert.deepEqual(r.api.reports, [], 'and nothing claimed it was running')

  // desk-api comes back; the next pass builds it, replay and all.
  down = false
  r.supervisor.nudge('registry')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(r.supervisor.books, [`${TAG}:paper`])
  assert.equal(r.client.requests[0]?.decisionId, `${TAG}:paper:7`)

  await r.supervisor.stop('TEST')
})

test('a book the master has no chain for is refused, loudly, and the rest run', async () => {
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow({ tag: 'GHOST', symbol: 'NOSUCH' }))
  r.db.of('desk-books-registry').push(registryRow())
  await r.supervisor.boot()

  assert.deepEqual(r.supervisor.books, [`${TAG}:paper`])
  assert.ok(r.log.lines.some((l) => l.includes('could NOT be started')))

  await r.supervisor.stop('TEST')
})

// ────────────────────────── the delta-lean cadence gate (plan Task 10, step 6)

/** The tag of the delta-lean book below — same chain, a second book on it. */
const DL_TAG = 'TCS-2026-08-28-delta-lean'

/** How many evaluations a book has been through, counted off its own holds. */
const evaluations = (r: Rig, tag: string): number =>
  r.log.entries.filter((e) => e.msg === 'hold' && e.tag === tag).length

test('a delta-lean book is paced by dl_eval_min_ms; a recenter book keeps the tick rule', async () => {
  /**
   * TWO GATES, AND NEITHER CAN DO THE OTHER'S JOB.
   *
   * The recenter gate is `ChainView.touchedSince` — evaluate when the chain has
   * ticked — which is right for a book deciding off a 5-minute grid. It cannot
   * pace a delta-lean book, because a tape that ticks ten times a second passes
   * it every single time: at `EVALUATE_MS` (250) every delta-lean book would run
   * the regime detector, mark its whole chain and re-read `desk-books` four
   * times a second, for a controller whose own dial says once a second.
   *
   * And the cadence gate cannot do the tick gate's job either — it would
   * evaluate a quiet recenter book on a wall clock against a market that has not
   * moved, which is the comparison-of-two-clocks `evaluateDue` refuses.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  r.db.of('desk-books-registry').push(
    registryRow({
      tag: DL_TAG,
      dials: {
        delta_lean_enabled: true,
        dl_eval_min_ms: 1_000,
        confirm_ms: 0,
        cooldown_s: 0,
        margin_cap: 0,
        shift_enabled: false,
      },
    }),
  )
  await r.supervisor.boot()
  assert.deepEqual(r.supervisor.books.length, 2)

  await r.tick()
  assert.equal(evaluations(r, DL_TAG), 1, 'the first pass is never held — `lastEvalMs` is 0')
  assert.equal(evaluations(r, TAG), 1)

  // 400 ms later, and two more ticks: the recenter book takes both, the
  // delta-lean book takes neither.
  r.now += 200
  await r.tick()
  r.now += 200
  await r.tick()
  assert.equal(evaluations(r, DL_TAG), 1, 'inside dl_eval_min_ms, it is skipped')
  assert.equal(evaluations(r, TAG), 3, 'the recenter book is untouched — one pass per tick')

  r.now += 700 // 1,100 ms since its last pass
  await r.tick()
  assert.equal(evaluations(r, DL_TAG), 2, 'and past the dial it runs again')
  assert.equal(evaluations(r, TAG), 4)

  await r.supervisor.stop('TEST')
})

test('a delta-lean book with no ticks at all STILL evaluates — its clock is its own', async () => {
  /**
   * The other half of the same distinction. A delta-lean book flattens on its
   * own clock at 14:50/14:55/15:00 and stops on its own rupee budget, and none
   * of that is a statement about whether the chain has printed. Gating it on the
   * tick rule would mean a book that goes quiet at 14:49 never flattens — and
   * SIGTERM is deliberately inert (D6), so nothing else would.
   */
  const r = rig()
  r.db.of('desk-books-registry').push(registryRow())
  r.db.of('desk-books-registry').push(
    registryRow({
      tag: DL_TAG,
      dials: {
        delta_lean_enabled: true,
        dl_eval_min_ms: 1_000,
        confirm_ms: 0,
        margin_cap: 0,
        shift_enabled: false,
      },
    }),
  )
  await r.supervisor.boot()

  // ONE tick, so both books have a chain to decide against at all — and then
  // the bus goes silent and only the clock moves.
  await r.tick()
  assert.equal(evaluations(r, DL_TAG), 1)
  assert.equal(evaluations(r, TAG), 1)

  r.now += 1_500
  await r.supervisor.evaluateDue()
  r.now += 1_500
  await r.supervisor.evaluateDue()

  assert.equal(evaluations(r, DL_TAG), 3, 'a silent feed does not stop its day clock')
  assert.equal(
    evaluations(r, TAG),
    1,
    'while the recenter book waits for the market to say something — unchanged',
  )

  await r.supervisor.stop('TEST')
})
