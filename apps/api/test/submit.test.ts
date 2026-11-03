/**
 * `/v1/desk/submit` — every gate, independently.
 *
 * Phase C §9 asks for exactly that: each gate proven to refuse on its own, plus
 * `liveLots` proven to OVERRIDE rather than multiply. The store is a fake
 * implementing the same narrow port `DeskStore` satisfies, so all of it runs
 * with no Mongo — a gate that can only be tested against a running database is
 * a gate that stops being tested.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { FreezeLimits } from '@algomaker/instruments'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { StaticMarks } from '../src/marks.ts'
import { UnknownStrategy, type StrategyRow } from '../src/strategies.ts'
import { DEFAULT_STRATEGY } from '../src/strategies.ts'
import type { BridgeLeg, DeskMode, Fill } from '../src/contract.ts'
import { DEFAULT_BROKER_LINK, type BrokerLinkState, type KillSwitchState } from '../src/safety.ts'
import type { Collection, FindCursor, UpdateOutcome } from '../src/store.ts'
import type { OrderRail, PaperFillEmit, RouteContext } from '../src/rail.ts'
import { LiveRailBlocked } from '../src/rail.ts'
import {
  exposureLimitsFromEnv,
  ReservationLedger,
  type ExposureState,
} from '@algomaker/order-bus'
import type { RiskGatePort } from '../src/service.ts'
import {
  ROUTING_STALE_MS,
  SubmitService,
  SUBMISSIONS,
  validateSubmitRequest,
  type SubmitRequestBody,
  type SubmitStore,
  type StoredBookLike,
  type BookKeyLike,
} from '../src/submit.ts'

/**
 * The collections the rails write to, and the ones a reconcile probes.
 *
 * Named here rather than imported so a test asserting "the order is in the
 * order collection" fails if the wiring in `routes/submit.ts` ever points the
 * reconcile at a different collection from the one the rail writes to — the
 * failure that would report a routed order as lost.
 */
const ORDER_COLLECTIONS = { paper: 'desk-paper-trade', live: 'desk-gateway-orders' }

// ------------------------------------------------------------------ fixtures

const EXPIRY = '2026-08-27'
const LOT = 75
const SYMBOL = 'NIFTY26AUG25000CE'

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (let strike = 24_800; strike <= 25_200; strike += 50) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: strike + (type === 'CE' ? 1 : 2),
        tradingsymbol: `NIFTY26AUG${strike}${type}`,
        name: 'NIFTY',
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: LOT,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  return new OptionMaster(rows)
}

const MARKS = new StaticMarks({ [SYMBOL]: 120 }, { NIFTY: 25_010 })

/** NSE publishes NIFTY's volume freeze in CONTRACTS: 1800 / 75 = 24 lots. */
const FREEZE = new FreezeLimits([{ symbol: 'NIFTY', freezeQty: 1800 }])

class FakeCursor<T> implements FindCursor<T> {
  readonly rows: T[]
  constructor(rows: T[]) {
    this.rows = rows
  }
  sort(): FindCursor<T> {
    return this
  }
  limit(): FindCursor<T> {
    return this
  }
  skip(): FindCursor<T> {
    return this
  }
  async toArray(): Promise<T[]> {
    return this.rows
  }
}

/**
 * A Mongo collection with just enough behaviour to be honest about the one
 * property that matters here: the UNIQUE index on `clientOrderId` is what makes
 * idempotency a lock rather than a read-then-write race, so the fake enforces
 * it and throws code 11000 exactly as the driver does.
 */
class FakeCollection<T extends Record<string, unknown>> implements Collection<T> {
  readonly docs: T[] = []
  #unique: string | null = null
  /** Set to simulate a Mongo hiccup on the bookkeeping write after routing. */
  failUpdateWith: Error | null = null

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.docs.find((d) => matches(d, filter)) ?? null
  }
  find(filter: Record<string, unknown>): FindCursor<T> {
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)))
  }
  async insertOne(doc: T): Promise<unknown> {
    if (this.#unique !== null) {
      const key = this.#unique
      if (this.docs.some((d) => d[key] === doc[key])) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
      }
    }
    this.docs.push({ ...doc })
    return {}
  }
  async insertMany(docs: readonly T[]): Promise<unknown> {
    for (const d of docs) await this.insertOne(d)
    return {}
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<UpdateOutcome> {
    if (this.failUpdateWith !== null) throw this.failUpdateWith
    const i = this.docs.findIndex((d) => matches(d, filter))
    const set = (update['$set'] ?? {}) as Record<string, unknown>
    if (i < 0) {
      if (options?.upsert === true) this.docs.push({ ...filter, ...set } as T)
      return {}
    }
    this.docs[i] = { ...this.docs[i], ...set } as T
    return {}
  }
  async deleteOne(filter: Record<string, unknown>): Promise<unknown> {
    // Honours its filter. A no-op here would let a test pass while the real
    // Mongo removed a document, which is the opposite of what a fake is for.
    const i = this.docs.findIndex((d) => matches(d, filter))
    if (i >= 0) this.docs.splice(i, 1)
    return {}
  }
  async deleteMany(): Promise<unknown> {
    this.docs.length = 0
    return {}
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length
  }
  async createIndex(
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean },
  ): Promise<unknown> {
    if (options?.unique === true) this.#unique = Object.keys(spec)[0] ?? null
    return {}
  }
  async dropIndex(): Promise<unknown> {
    return {}
  }
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => doc[k] === v)
}

class FakeStore implements SubmitStore {
  readonly rows = new Map<string, StrategyRow>()
  readonly collections = new Map<string, FakeCollection<Record<string, unknown>>>()
  kill: KillSwitchState = { enabled: false, reason: '', setBy: '', setAt: 0 }
  link: BrokerLinkState = DEFAULT_BROKER_LINK
  readonly touched: string[] = []
  /** `tag:mode` -> the stored book, for `#maintainBook`. */
  readonly books = new Map<string, StoredBookLike>()
  /**
   * Runs INSIDE `saveBook`, before the version is compared — the window a
   * concurrent writer lands in. A lost update cannot be reproduced any other
   * way here: the fake is single-threaded by construction.
   */
  beforeSaveBook: (() => void) | null = null

  async bookDoc(tag: string, mode: DeskMode): Promise<StoredBookLike | null> {
    return this.books.get(`${tag}:${mode}`) ?? null
  }
  /** Compare-and-set, modelling `DeskStore.saveBook`'s contract exactly. */
  async saveBook(
    key: BookKeyLike,
    legs: readonly BridgeLeg[],
    nowMs: number,
    expectedUpdatedAt?: number,
  ): Promise<'ok' | 'conflict'> {
    this.beforeSaveBook?.()
    const id = `${key.tag}:${key.mode}`
    const current = this.books.get(id)
    if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) return 'conflict'
    const updatedAt =
      expectedUpdatedAt === undefined ? nowMs : Math.max(nowMs, expectedUpdatedAt + 1)
    this.books.set(id, { symbol: key.symbol, expiry: key.expiry, legs, updatedAt })
    return 'ok'
  }

  async loadStrategy(tag: string): Promise<StrategyRow | null> {
    return this.rows.get(tag) ?? null
  }
  async loadKillSwitch(): Promise<KillSwitchState> {
    return this.kill
  }
  async loadBrokerLink(): Promise<BrokerLinkState> {
    return this.link
  }
  async touchStrategy(tag: string): Promise<void> {
    this.touched.push(tag)
  }
  async journalBlocked(events: readonly Record<string, unknown>[]): Promise<void> {
    await this.collection('desk-order-events').insertMany(events)
  }
  collection<T = Record<string, unknown>>(name: string): Collection<T> {
    let c = this.collections.get(name)
    if (c === undefined) {
      c = new FakeCollection()
      this.collections.set(name, c)
    }
    return c as unknown as Collection<T>
  }
  docs(name: string): Record<string, unknown>[] {
    return this.collections.get(name)?.docs ?? []
  }
  /** The fake itself, for tests that need to make a specific write fail. */
  raw(name: string): FakeCollection<Record<string, unknown>> {
    this.collection(name)
    return this.collections.get(name) as FakeCollection<Record<string, unknown>>
  }
}

/**
 * A rail that records AND writes the order document, like the real ones.
 *
 * The write matters: `rail.route` succeeding means exactly "a document with
 * this clientOrderId is in the order collection", and that document is the only
 * witness a reconcile has after the submitting process dies. A rail that only
 * recorded in memory would let a reconcile test pass while the real reconcile
 * found nothing.
 */
class RecordingRail implements OrderRail {
  readonly routed: { fill: Fill; ctx: RouteContext }[] = []
  failWith: Error | null = null
  readonly mode: 'paper' | 'live'
  /** Where this rail's orders land — the seam a reconcile reads. */
  readonly collection: string
  readonly #store: FakeStore
  constructor(mode: 'paper' | 'live', store: FakeStore) {
    this.mode = mode
    this.#store = store
    this.collection = mode === 'live' ? ORDER_COLLECTIONS.live : ORDER_COLLECTIONS.paper
  }
  async route(fill: Fill, ctx: RouteContext): Promise<void> {
    if (this.failWith !== null) throw this.failWith
    await this.#store.collection(this.collection).insertOne({
      clientOrderId: ctx.clientOrderId,
      tradingsymbol: fill.tradingsymbol,
      quantity: fill.qty,
      price: fill.price,
    })
    this.routed.push({ fill, ctx })
  }
}

const T0 = 1_800_000_000_000

let store: FakeStore
let paper: RecordingRail
let live: RecordingRail
let logs: { msg: string; ctx?: Record<string, unknown> }[]
/** Movable, so a test can age a record past `ROUTING_STALE_MS` without waiting. */
let nowMs: number

function row(patch: Partial<StrategyRow> = {}): StrategyRow {
  return {
    ...DEFAULT_STRATEGY,
    tag: 'BN_BREAKOUT',
    kind: 'hosted',
    modes: { paper: { enabled: true } },
    ...patch,
  }
}

function service(liveTags: string[] = [], risk?: RiskGatePort): SubmitService {
  return new SubmitService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    freeze: () => FREEZE,
    liveTags: new Set(liveTags),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
    // Absent for every test but the risk ones — which is the production
    // default too, since `main.ts` builds no gate when nothing is configured.
    ...(risk === undefined ? {} : { risk }),
  })
}

/** A risk gate over a fixed measurement, as `main.ts` would build one. */
function riskGate(
  env: Record<string, string>,
  exposure: Partial<ExposureState> = {},
): RiskGatePort & { recorded: number[]; reserved: { lots: number; underlying: string }[] } {
  const recorded: number[] = []
  const reserved: { lots: number; underlying: string }[] = []
  return {
    recorded,
    reserved,
    limits: exposureLimitsFromEnv(env),
    exposure: async () => ({
      nowMs,
      recentOrderTs: recorded,
      openLotsByUnderlying: {},
      openLotsTotal: 0,
      dayLoss: 0,
      ...exposure,
    }),
    record: (ms: number) => recorded.push(ms),
    reserve: (lots: number, underlying: string) => reserved.push({ lots, underlying }),
  }
}

function req(patch: Partial<SubmitRequestBody> = {}): SubmitRequestBody {
  return {
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    clientOrderId: 'coid-1',
    instrument: { tradingsymbol: SYMBOL },
    side: 'Buy',
    lots: 2,
    underlying: 'NIFTY',
    ...patch,
  }
}

beforeEach(() => {
  store = new FakeStore()
  paper = new RecordingRail('paper', store)
  live = new RecordingRail('live', store)
  logs = []
  nowMs = T0
  store.rows.set('BN_BREAKOUT', row())
})

// -------------------------------------------------------------- gate 1: tag

test('an unregistered tag throws UnknownStrategy (the 403 path), never a silent 200', async () => {
  await assert.rejects(
    () => service().submit(req({ tag: 'TYPO_TAG' })),
    (err: unknown) => err instanceof UnknownStrategy,
  )
  assert.equal(paper.routed.length, 0)
})

test('an unregistered tag is still journalled, so the portal can answer "why nothing traded"', async () => {
  await service()
    .submit(req({ tag: 'TYPO_TAG' }))
    .catch(() => undefined)
  const events = store.docs('desk-order-events')
  assert.equal(events.length, 1)
  assert.match(String(events[0]?.['error']), /unknown strategy/)
})

// ---------------------------------------------------- gate 2: strategy switch

test('a disabled strategy is refused by the strategy switch, with 200 and a named reason', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: false } }, disabledReason: 'margin' }))
  const res = await service().submit(req())
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^strategy switch:/)
  assert.match(res.reason, /margin/)
  assert.equal(paper.routed.length, 0)
})

test('the strategy switch RELEASES an exit — a switch that traps what it holds fired on 2026-08-04', async () => {
  /**
   * This test used to assert the opposite ("off means off", exits included),
   * and warned that a future change fixing the asymmetry must say it was
   * deliberate. It is: on 2026-08-04 the operator bulk-switched paper off with
   * six strategies holding positions, and the runner's OWN switch-off path —
   * which squares off as it stops (`runner.ts:#stopOne`) — had every closing
   * order refused by this gate. Four strategies parked in `failed`, positions
   * stranded, and the retry loop spammed the log for hours. The old rationale
   * ("flattening is the operator's job, via closeAll") did not hold either:
   * `closeAll` closes desk BOOKS, and a hosted strategy's ledger is not one —
   * the operator's UI flatten wrote bus closes the runner never saw, and the
   * ledger stayed desynced. So the switch now behaves like the kill switch:
   * OFF stops new exposure; it never refuses an exit.
   */
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: false } }, disabledReason: 'margin' }))
  const res = await service().submit(
    req({ clientOrderId: 'coid-exit', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(res.accepted, true)
  assert.equal(paper.routed.length, 1)
  assert.equal(paper.routed[0]?.fill.op, 'close')
  // And the exemption is exits ONLY: the same switched-off row still refuses
  // the entry beside it, which is what the switch is for.
  const entry = await service().submit(req({ clientOrderId: 'coid-entry' }))
  assert.equal(entry.accepted, false)
  assert.match(entry.reason, /^strategy switch:/)
  assert.equal(paper.routed.length, 1)
})

/**
 * THE POISONED KEY. Measured against prod on 2026-07-31.
 *
 * The Build screen derives its `clientOrderId` from tag and tradingsymbol
 * alone, so every attempt at a given leg carries the SAME key — which is
 * exactly right, and is what stops a double-click placing twice. But the
 * replay check runs before every gate, and `#refuse` used to persist a gate
 * refusal under that key. So the first refusal became the permanent answer:
 * the operator switched the rail on, pressed Place, and got the SAME refusal
 * back — `replayed: true`, gates never re-run — with the portal showing the
 * switch on beside it. There was no way out from the UI at all.
 *
 * `#refuse`'s own comment already said why this is wrong: "nothing was
 * attempted, so ... the opportunity is genuinely still available". Idempotency
 * exists to stop a retry placing a SECOND order; a refusal placed no first
 * one, so it has nothing to protect and must not be replayed.
 */
test('a gate refusal is NOT replayed — the same key retries once the switch is on', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: false } }, disabledReason: 'margin' }))
  const refused = await service().submit(req({ clientOrderId: 'coid-retry' }))
  assert.equal(refused.accepted, false)
  assert.equal(paper.routed.length, 0)

  // The operator switches it on and presses Place again — same key, as the
  // Build screen and every retry loop will send.
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: true } } }))
  const retry = await service().submit(req({ clientOrderId: 'coid-retry' }))
  assert.equal(retry.accepted, true, 'the gates must be re-run, not the old refusal replayed')
  assert.equal(paper.routed.length, 1, 'and the order must actually route this time')
})

test('a refusal that is retried while STILL refused stays refused, and still routes nothing', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: false } }, disabledReason: 'margin' }))
  await service().submit(req({ clientOrderId: 'coid-still-off' }))
  const again = await service().submit(req({ clientOrderId: 'coid-still-off' }))
  assert.equal(again.accepted, false)
  assert.match(again.accepted === false ? again.reason : '', /^strategy switch:/)
  assert.equal(paper.routed.length, 0)
})

test('an ACCEPTED submission is still replayed — idempotency is untouched', async () => {
  // The guarantee that must survive this change: a retry of a key that already
  // routed must never place a second order.
  const first = await service().submit(req({ clientOrderId: 'coid-once' }))
  assert.equal(first.accepted, true)
  assert.equal(paper.routed.length, 1)
  const second = await service().submit(req({ clientOrderId: 'coid-once' }))
  assert.equal(second.accepted, true)
  assert.equal(second.replayed, true, 'the second call must be a replay, not a fresh route')
  assert.equal(paper.routed.length, 1, 'and must NOT have placed a second order')
})

test('a row switched on for PAPER ONLY refuses a live order and keeps taking paper ones', async () => {
  // The per-mode switch on the order path. The row is the authorisation; the
  // body only states which authorisation it is claiming.
  store.rows.set(
    'BN_BREAKOUT',
    row({ modes: { paper: { enabled: true }, live: { enabled: false } }, liveLots: 1 }),
  )
  const svc = service(['BN_BREAKOUT'])

  const live_ = await svc.submit(req({ clientOrderId: 'coid-live', mode: 'live' }))
  assert.equal(live_.accepted, false)
  assert.match(live_.reason, /^strategy switch:/)
  assert.match(live_.reason, /switched off for live/)
  assert.equal(live.routed.length, 0)

  const paper_ = await svc.submit(req({ clientOrderId: 'coid-paper', mode: 'paper' }))
  assert.equal(paper_.accepted, true)
  assert.equal(paper.routed.length, 1, 'the paper run is untouched by the live refusal')
})

test('a row switched on for BOTH modes trades on BOTH rails', async () => {
  // What the operator asked for: proving a change out on paper without taking
  // the live book off the air.
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: true }, live: { enabled: true } }, liveLots: 1 }))
  const svc = service(['BN_BREAKOUT'])

  const p = await svc.submit(req({ clientOrderId: 'coid-p', mode: 'paper' }))
  const l = await svc.submit(req({ clientOrderId: 'coid-l', mode: 'live' }))
  assert.equal(p.accepted, true)
  assert.equal(l.accepted, true)
  assert.equal(paper.routed.length, 1)
  assert.equal(live.routed.length, 1)
})

test('a row switched on for LIVE ONLY refuses a paper order', async () => {
  // Symmetric, and it matters: a paper run left pointing at a row that is now
  // live-only must not quietly book fictional fills against it.
  store.rows.set(
    'BN_BREAKOUT',
    row({ modes: { paper: { enabled: false }, live: { enabled: true } }, liveLots: 1 }),
  )
  const res = await service(['BN_BREAKOUT']).submit(req({ mode: 'paper' }))
  assert.equal(res.accepted, false)
  assert.match(res.reason, /switched off for paper/)
  assert.equal(paper.routed.length, 0)
})

test('a live EXIT passes the switch gate too — the rail keeps its own, unchanged allowlist', async () => {
  // The 2026-08-04 exemption is per RULE, not per rail: the gate answers the
  // same way for both modes, because a live position stranded by its own
  // switch is strictly worse than a paper one. What this does NOT change is
  // the live rail's defense-in-depth: the real `LiveRail.route` and the
  // order-gateway's Gate 2 still refuse a tag whose `modes.live` is off,
  // closes included, and those checks are deliberately untouched — a "close"
  // over a phantom leg is an OPEN in disguise, and on the live rail that is
  // real money. This fake rail records instead of refusing, so what is being
  // asserted here is exactly the gate's verdict.
  store.rows.set(
    'BN_BREAKOUT',
    row({ modes: { paper: { enabled: true }, live: { enabled: false } }, liveLots: 1 }),
  )
  const res = await service(['BN_BREAKOUT']).submit(
    req({ mode: 'live', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(res.accepted, true)
  assert.equal(live.routed.length, 1)
  assert.equal(live.routed[0]?.fill.op, 'close')
  // A live ENTRY on the same switched-off row is still refused by the gate.
  const entry = await service(['BN_BREAKOUT']).submit(
    req({ mode: 'live', clientOrderId: 'coid-live-entry' }),
  )
  assert.equal(entry.accepted, false)
  assert.match(entry.reason, /switched off for live/)
})

// -------------------------------------------------------- gate 3: kill switch

test('the kill switch blocks NEW exposure', async () => {
  store.kill = { enabled: true, reason: 'vol spike', setBy: 'ops', setAt: 0 }
  const res = await service().submit(req())
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^kill switch:/)
  assert.match(res.reason, /vol spike/)
  assert.equal(paper.routed.length, 0)
})

test('the kill switch NEVER blocks an exit — trapping a position is worse', async () => {
  store.kill = { enabled: true, reason: 'vol spike', setBy: 'ops', setAt: 0 }
  const res = await service().submit(
    req({ clientOrderId: 'coid-exit', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(res.accepted, true)
  assert.equal(paper.routed.length, 1)
  assert.equal(paper.routed[0]?.fill.op, 'close')
})

// -------------------------------------------------- gate 3b: the broker link

test('a RELEASED broker link refuses a LIVE order — the exit too — and never a paper one', async () => {
  /**
   * Released means the gateway is LOGGED OUT of XTS. Unlike the kill switch
   * this is not a rule about exposure: there is no broker to place a close
   * with either, and a close let through here would be folded into the book
   * and then refused at the gateway — the desk reading flat against a live
   * position. So exits are refused too, and the reason says where to turn the
   * link back on.
   */
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: true }, live: { enabled: true } }, liveLots: 1 }))
  store.link = { ...DEFAULT_BROKER_LINK, desired: 'released', reason: 'key needed elsewhere', setBy: 'ops' }
  const svc = service(['BN_BREAKOUT'])

  const entry = await svc.submit(req({ mode: 'live', clientOrderId: 'coid-live-entry' }))
  assert.equal(entry.accepted, false)
  assert.match(entry.reason, /^live execution paused/)
  assert.match(entry.reason, /key needed elsewhere/)
  assert.match(entry.reason, /resumed from Controls/)

  const exit = await svc.submit(
    req({ mode: 'live', clientOrderId: 'coid-live-exit', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(exit.accepted, false, 'an exit cannot be placed by a logged-out gateway either')
  assert.match(exit.reason, /^live execution paused/)
  assert.equal(live.routed.length, 0)

  // The refusal is journalled like every other gate's, under the live rail.
  const blocked = store.docs('desk-order-events').filter((e) => /live execution paused/.test(String(e['error'] ?? e['reason'] ?? '')))
  assert.ok(blocked.length >= 1, 'the refusal is in the order events')

  // Paper never spoke to XTS: the rehearsal carries on while the key is elsewhere.
  const paper_ = await svc.submit(req({ mode: 'paper', clientOrderId: 'coid-paper' }))
  assert.equal(paper_.accepted, true)
  assert.equal(paper.routed.length, 1)
})

test('a CONNECTED broker link is not a gate at all', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: true }, live: { enabled: true } }, liveLots: 1 }))
  store.link = { ...DEFAULT_BROKER_LINK, desired: 'connected', applied: 'connected' }
  const res = await service(['BN_BREAKOUT']).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, true)
  assert.equal(live.routed.length, 1)
})

// -------------------------------------------------- gate 4: the box-level pin
//
// DESK_LIVE_TAGS stopped being the allowlist: that is now gate 3, the
// password-gated `modes.live` switch. Keeping an env allowlist here as well
// meant two sources that had to be edited and restarted in step, and when they
// drifted a correctly-enabled tag was refused with a message blaming the env
// var. Measured on prod 2026-07-30. What is left is a pin that can only NARROW.

test('an EMPTY pin no longer refuses — the portal switch is the allowlist', async () => {
  // The behaviour that changed. Empty used to mean "nothing trades live"; it
  // now means "no pin", so a switched-on tag reaches the rail.
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const res = await service([]).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, true)
  assert.equal(live.routed.length, 1)
})

test('a NON-EMPTY pin refuses a tag outside it', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const res = await service(['SOMETHING_ELSE']).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^live pin:/)
  assert.equal(live.routed.length, 0)
})

test('the pin can only NARROW — it cannot enable a switched-off tag', async () => {
  // Being pinned is not permission. Gate 3 still has to pass.
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: false } }, liveLots: 1 }))
  const res = await service(['BN_BREAKOUT']).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false)
  assert.equal(live.routed.length, 0)
})

test('an allowlisted tag reaches the live rail', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const res = await service(['BN_BREAKOUT']).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, true)
  assert.equal(live.routed.length, 1)
  assert.equal(paper.routed.length, 0)
})

test('the rail is the second, independent gate — a refusal there is reported, not thrown', async () => {
  // Simulates LiveRail's own allowlist check firing (an edge check that got out
  // of step with the rail's). Nothing routed, so nothing was accepted.
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  live.failWith = new LiveRailBlocked("tag 'BN_BREAKOUT' is not in the live allowlist")
  const res = await service(['BN_BREAKOUT']).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^routing:/)
  assert.match(res.reason, /allowlist/)
})

// ------------------------------------------------------ gate 6: risk limits
//
// The wiring, not the arithmetic — `submit-plan.test.ts` and
// `order-bus/test/risk.test.ts` own the verdicts. What these prove is that the
// gate is CONSULTED on the live rail, refuses before anything is claimed or
// routed, and is inert everywhere else (audit F-28).

test('a configured lot cap refuses a LIVE open before anything is claimed or routed', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 3 }))
  const gate = riskGate({ DESK_RISK_MAX_TOTAL_LOTS: '4' }, { openLotsTotal: 2 })
  const res = await service([], gate).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false)
  assert.equal(res.status, 'DONE', 'a gate refusal: nothing was attempted, so it is retryable')
  assert.match(res.reason, /risk limit MAX_LOTS_TOTAL/)
  assert.match(res.reason, /2 \+ 3 > 4/, 'the measured value and the limit')
  assert.match(res.reason, /DESK_RISK_MAX_TOTAL_LOTS/, 'which knob to change')
  assert.equal(live.routed.length, 0)
  assert.deepEqual(gate.recorded, [], 'a refused order is not counted against the rate limit')
  // ...and it is in the ORDER LOG, which is where the operator looks.
  const events = store.docs('desk-order-events')
  assert.equal(events.length, 1)
  assert.match(String(events[0]?.['error']), /risk limit MAX_LOTS_TOTAL/)
  assert.equal(events[0]?.['tag'], 'BN_BREAKOUT')
})

test('the day loss stop refuses a live entry and NEVER the exit', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const gate = riskGate({ DESK_RISK_MAX_DAY_LOSS: '50000' }, { dayLoss: 61_250 })
  const entry = await service([], gate).submit(req({ mode: 'live' }))
  assert.equal(entry.accepted, false)
  assert.match(entry.reason, /risk limit DAILY_LOSS.*61250.*50000/)

  const exit = await service([], gate).submit(
    req({ mode: 'live', clientOrderId: 'coid-exit', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(exit.accepted, true, 'a stop that traps a position is worse than no stop')
  assert.equal(live.routed.length, 1)
})

test('an accepted live open is counted for the rate limit; an exit is not', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const gate = riskGate({ DESK_RISK_MAX_ORDERS_PER_MIN: '10' })
  await service([], gate).submit(req({ mode: 'live' }))
  assert.deepEqual(gate.recorded, [nowMs])
  await service([], gate).submit(
    req({ mode: 'live', clientOrderId: 'coid-2', side: 'Sell', reducesExposure: true }),
  )
  assert.deepEqual(gate.recorded, [nowMs], 'throttling exits would throttle getting flat')
})

test('a PAPER submit spends NONE of the live rate budget', async () => {
  const gate = riskGate({ DESK_RISK_MAX_ORDERS_PER_MIN: '10' })
  const res = await service([], gate).submit(req())
  assert.equal(res.accepted, true)
  assert.equal(paper.routed.length, 1)
  assert.deepEqual(
    gate.recorded,
    [],
    'the caps are measured on the LIVE rail only, so only live orders may consume them',
  )
  assert.deepEqual(gate.reserved, [], 'and a paper fill is no live exposure to reserve against')
})

test('two live opens inside ONE measurement window cannot jointly exceed the cap', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 3 }))
  const ledger = new ReservationLedger(6_000)
  // FROZEN, as the 2s TTL cache in main.ts freezes it: both submits see the
  // same measured book, and only the reservation tells the second one that the
  // first is already in flight.
  const measured: ExposureState = {
    nowMs,
    recentOrderTs: [],
    openLotsByUnderlying: {},
    openLotsTotal: 0,
    dayLoss: 0,
  }
  const gate: RiskGatePort = {
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_TOTAL_LOTS: '5' }),
    exposure: async () => ledger.applyTo(measured, nowMs),
    record: () => {},
    reserve: (lots, underlying, at) => ledger.reserve(lots, underlying, at),
  }
  const svc = service([], gate)

  const first = await svc.submit(req({ mode: 'live', clientOrderId: 'coid-a' }))
  assert.equal(first.accepted, true)
  const second = await svc.submit(req({ mode: 'live', clientOrderId: 'coid-b' }))
  assert.equal(second.accepted, false, '3 lots are already in flight; 3 + 3 > 5')
  assert.match(second.reason, /MAX_LOTS_TOTAL/)
  assert.equal(live.routed.length, 1)
})

test('an EXIT reserves nothing — a reservation is a claim on new exposure', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const gate = riskGate({ DESK_RISK_MAX_TOTAL_LOTS: '10' })
  await service([], gate).submit(req({ mode: 'live' }))
  assert.deepEqual(gate.reserved, [{ lots: 1, underlying: 'NIFTY' }])
  await service([], gate).submit(
    req({ mode: 'live', clientOrderId: 'coid-2', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(gate.reserved.length, 1, 'closing frees capacity; it never claims it')
})

test('PAPER is never risk-gated, and neither is a desk with no limits configured', async () => {
  const paperRes = await service(
    [],
    riskGate({ DESK_RISK_MAX_TOTAL_LOTS: '1' }, { openLotsTotal: 900 }),
  ).submit(req())
  assert.equal(paperRes.accepted, true)
  assert.equal(paper.routed.length, 1)

  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 3 }))
  const unset = await service([], riskGate({}, { openLotsTotal: 900, dayLoss: 9_000_000 })).submit(
    req({ mode: 'live', clientOrderId: 'coid-live' }),
  )
  assert.equal(unset.accepted, true, 'every limit unset means every limit disabled')
})

test('an unmeasurable desk refuses NEW live exposure while a limit is configured', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const gate: RiskGatePort = {
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '50000' }),
    exposure: async () => null,
    record: () => {},
    reserve: () => {},
  }
  const res = await service([], gate).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false)
  assert.match(res.reason, /could not be measured/)
  assert.equal(live.routed.length, 0)

  const exit = await service([], gate).submit(
    req({ mode: 'live', clientOrderId: 'coid-exit', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(exit.accepted, true)
})

test('a PARTIALLY measured desk is treated as unmeasured, and names what it missed', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const gate = riskGate(
    { DESK_RISK_MAX_TOTAL_LOTS: '500' },
    { unmeasuredSymbols: ['SENSEX25JUL80000CE'] },
  )
  const res = await service([], gate).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false, 'a cap judged on an under-count is not a cap')
  assert.match(res.reason, /could not be fully measured/)
  assert.match(res.reason, /SENSEX25JUL80000CE/)
  assert.equal(live.routed.length, 0)

  const exit = await service([], gate).submit(
    req({ mode: 'live', clientOrderId: 'coid-exit', side: 'Sell', reducesExposure: true }),
  )
  assert.equal(exit.accepted, true, 'and it still never traps a position')
})

// ------------------------------------------------------ gate 5: freeze split

test('an order over the freeze limit is split into tranches that sum exactly', async () => {
  // 30 lots against a 24-lot cap -> 24 + 6, and every tranche a distinct id.
  const res = await service().submit(req({ lots: 30 }))
  assert.equal(res.accepted, true)
  assert.deepEqual(
    res.orders.map((o) => o.lots),
    [24, 6],
  )
  assert.equal(
    res.orders.reduce((n, o) => n + o.qty, 0),
    30 * LOT,
  )
  assert.deepEqual(
    res.orders.map((o) => o.clientOrderId),
    ['coid-1#0', 'coid-1#1'],
  )
  assert.equal(paper.routed.length, 2)
})

test('an unknown freeze symbol sends ONE order and reports the unknown — never an implicit infinity', async () => {
  const svc = new SubmitService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    // Empty table: maxLotsPerOrder returns null for every symbol.
    freeze: () => new FreezeLimits(),
    liveTags: new Set(),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
  })
  const res = await svc.submit(req({ lots: 30 }))
  assert.equal(res.accepted, true)
  assert.equal(res.freezeMaxLots, null)
  assert.equal(res.orders.length, 1)
  assert.ok(logs.some((l) => l.msg.includes('freeze limit UNKNOWN')))
})

// ------------------------------------------------------------- liveLots

test('liveLots OVERRIDES the strategy lots in live mode — it does not multiply them', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 3 }))
  const res = await service(['BN_BREAKOUT']).submit(req({ mode: 'live', lots: 2 }))
  assert.equal(res.accepted, true)
  assert.equal(res.requestedLots, 2)
  // 3, the row's value. NOT 6 (2 x 3), which is what a multiplier would give —
  // and 6 is the number that would exist nowhere in either system.
  assert.equal(res.lots, 3)
  assert.equal(res.orders[0]?.lots, 3)
  assert.equal(live.routed[0]?.fill.qty, 3 * LOT)
})

test('liveLots is not applied in paper mode — the strategy sizes its own paper book', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: true } }, liveLots: 9 }))
  const res = await service().submit(req({ lots: 2 }))
  assert.equal(res.accepted, true)
  assert.equal(res.lots, 2)
})

test('liveLots does NOT re-size an EXIT — a 5-lot position must close as 5 lots', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 3 }))
  const res = await service(['BN_BREAKOUT']).submit(
    req({ mode: 'live', lots: 5, side: 'Sell', reducesExposure: true }),
  )
  assert.equal(res.accepted, true)
  assert.equal(res.lots, 5)
  assert.equal(live.routed[0]?.fill.qty, 5 * LOT)
})

test('liveLots of 0 refuses a live ENTRY rather than routing an unsized order', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 0 }))
  const res = await service(['BN_BREAKOUT']).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^live sizing:/)
  assert.equal(live.routed.length, 0)
})

// ------------------------------------------------------------ idempotency

test('the same clientOrderId twice places ONCE and replays the first answer', async () => {
  const svc = service()
  const first = await svc.submit(req())
  const second = await svc.submit(req())
  assert.equal(first.accepted, true)
  assert.equal(second.accepted, true)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(paper.routed.length, 1)
  assert.deepEqual(second.orders, first.orders)
})

/**
 * REVERSED on 2026-07-31, deliberately. This test used to assert that a
 * refusal is replayed like any other outcome — "the caller contract is 'this
 * id, once'". That contract is right for an order that ROUTED and wrong for
 * one that was refused, and the difference is not cosmetic: a refusal stored
 * under a deterministic key made the refusal permanent, so switching the rail
 * on could not unblock the Build screen. See `isGateRefusal` in submit.ts.
 *
 * What "once" actually protects is a second PLACEMENT. Nothing was placed
 * here, so the id is free to be tried again — and the two tests either side of
 * this one are what keep that from eroding the real guarantee.
 */
test('a refusal is re-gated on retry, and the reason is re-derived rather than replayed', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: false } } }))
  const svc = service()
  const first = await svc.submit(req())
  const second = await svc.submit(req())
  assert.equal(second.accepted, false)
  assert.equal(second.replayed, false, 'the gates ran again — this is not a cached answer')
  // Same verdict, because the switch is still off. Same reason, because it was
  // recomputed from the same row, not read back from the refusal record.
  assert.equal(first.accepted === false ? first.reason : '', second.accepted === false ? second.reason : 'x')
  assert.equal(paper.routed.length, 0)
})

test('the submission is claimed BEFORE routing, so a crash mid-route cannot double-order', async () => {
  const svc = service()
  paper.failWith = new Error('mongo went away mid-route')
  const res = await svc.submit(req())
  assert.equal(res.accepted, false)
  // The claim survives the failure: a blind retry of the SAME id replays rather
  // than re-routing, which is the point — the first attempt may have partly
  // routed.
  const claim = store.docs(SUBMISSIONS)[0]
  assert.equal(claim?.['clientOrderId'], 'coid-1')
  assert.equal(claim?.['status'], 'FAILED')
})

test('the claim itself never says "accepted" — nothing has routed at the moment it is written', async () => {
  /**
   * The stored shape is the whole of S2. A claim that says `accepted: true`
   * with every planned tranche in `orders` IS a false success sitting in Mongo
   * waiting for a replay to read it.
   */
  const svc = service()
  paper.failWith = new Error('rail down, so the loop never rewrites the claim to a success')
  await svc.submit(req({ lots: 30 }))
  const claim = store.docs(SUBMISSIONS)[0]
  assert.equal(claim?.['accepted'], false)
  assert.deepEqual(claim?.['orders'], [])
  // The plan is kept separately, because a reconcile needs to know what to look for.
  assert.equal((claim?.['plannedOrders'] as unknown[]).length, 2)
})

// --------------------------------------------- S1/S2: the indeterminate replay

/** Exactly what a crash between the claim insert and the routing loop leaves. */
async function stuckClaim(patch: Record<string, unknown> = {}): Promise<void> {
  await store.collection(SUBMISSIONS).insertOne({
    clientOrderId: 'coid-1',
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    tradingsymbol: SYMBOL,
    side: 'Buy',
    requestedLots: 30,
    lots: 30,
    accepted: false,
    reason: '',
    orders: [],
    status: 'ROUTING',
    routeErrors: [],
    createdAt: T0,
    freezeMaxLots: 24,
    plannedOrders: [
      { clientOrderId: 'coid-1#0', lots: 24, qty: 24 * LOT },
      { clientOrderId: 'coid-1#1', lots: 6, qty: 6 * LOT },
    ],
    underlying: 'NIFTY',
    price: 120,
    op: 'open',
    ...patch,
  })
}

test('a replay of a ROUTING record NEVER reports success — it says the outcome is unknown', async () => {
  /**
   * The S2 defect: `replayOf` branched on `accepted` alone, so a record claimed
   * but not yet routed replayed as `{accepted: true, orders: [every tranche]}`.
   * On an entry the caller books a position that does not exist; on an exit it
   * believes it is flat while still holding, and nothing anywhere sweeps a
   * stuck ROUTING row to correct it.
   */
  await stuckClaim()
  const res = await service().submit(req({ lots: 30 }))
  assert.equal(res.accepted, false)
  if (res.accepted) return
  assert.equal(res.status, 'ROUTING')
  assert.equal(res.status === 'ROUTING' ? res.indeterminate : false, true)
  assert.match(res.reason, /UNKNOWN/)
  // It must not hand back a routed size at all — there is no honest value.
  assert.equal('routedLots' in res, false)
  // And it must not have routed anything itself.
  assert.equal(paper.routed.length, 0)
})

test('a FRESH ROUTING record is left alone — reconciling mid-flight would report a false partial', async () => {
  // Tranche 0 is in the order collection and tranche 1 is not, which is exactly
  // what an ALIVE routing loop looks like one instant before it routes tranche
  // 1. Answering "24 of 30 routed" here is a worse lie than "unknown": the
  // caller books 24, the loop routes 30, and 6 lots are stranded.
  await stuckClaim()
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0' })
  nowMs = T0 + ROUTING_STALE_MS - 1
  const res = await service().submit(req({ lots: 30 }))
  assert.equal(res.accepted, false)
  if (res.accepted || res.status !== 'ROUTING') return assert.fail('expected indeterminate')
  assert.equal(res.indeterminate, true)
})

test('a STALE ROUTING record is RESOLVED against the order collection, not guessed', async () => {
  await stuckClaim()
  // Both tranches did reach the rail; the process died before it could say so.
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0' })
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#1' })
  nowMs = T0 + ROUTING_STALE_MS
  const res = await service().submit(req({ lots: 30 }))
  assert.equal(res.accepted, true)
  if (!res.accepted) return
  assert.equal(res.status, 'DONE')
  assert.equal(res.routedLots, 30)
  assert.equal(res.replayed, true)
  // Nothing re-routed: the reconcile READS the order collection, it does not
  // re-drive the rail.
  assert.equal(paper.routed.length, 0)
  // The record is now terminal, so the next replay is cheap and consistent.
  const claim = store.docs(SUBMISSIONS)[0]
  assert.equal(claim?.['status'], 'DONE')
  assert.equal(claim?.['accepted'], true)
})

test('a stale reconcile reports a PARTIAL as partial — the missing tranche is named, not assumed', async () => {
  await stuckClaim()
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0' })
  nowMs = T0 + ROUTING_STALE_MS
  const res = await service().submit(req({ lots: 30 }))
  assert.equal(res.accepted, true)
  if (!res.accepted) return
  assert.equal(res.status, 'FAILED')
  assert.equal(res.routedLots, 24)
  assert.equal(res.intendedLots, 30)
  assert.equal(res.orders.length, 1)
  assert.equal(res.errors.length, 1)
  assert.match(String(res.errors[0]), /coid-1#1/)
})

test('a stale reconcile that finds NOTHING says nothing routed — the opportunity is still live', async () => {
  await stuckClaim()
  nowMs = T0 + ROUTING_STALE_MS
  const res = await service().submit(req({ lots: 30 }))
  assert.equal(res.accepted, false)
  if (res.accepted) return
  assert.equal(res.status, 'FAILED')
  assert.equal(res.routedLots, 0)
})

test('a reconcile writes the P&L record the crash lost, so real exposure stops reading as flat', async () => {
  await stuckClaim()
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0' })
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#1' })
  nowMs = T0 + ROUTING_STALE_MS
  await service().submit(req({ lots: 30 }))
  const decisions = store.docs('desk-decisions')
  assert.equal(decisions.length, 1)
  const fills = decisions[0]?.['fills'] as Fill[]
  assert.deepEqual(
    fills.map((f) => f.qty),
    [24 * LOT, 6 * LOT],
  )
  // The price stored at CLAIM time, not today's mark — a fill re-priced at
  // replay time books a P&L that never happened.
  for (const f of fills) assert.equal(f.price, 120)
})

/**
 * THE RECONCILE FOLDS THE BOOK TOO (audit F14).
 *
 * Repairing only the P&L record was survivable while this fold merely REDUCED
 * legs the seed had declared — the 5-minute reconcile restates those. Since
 * `fefe922b` the same fold CREATES a manual leg, and a leg that is never
 * created is never restated by anything: the crash simply loses it and the
 * position exists at the broker and nowhere else.
 */
test('a reconcile FOLDS the book, so a crash cannot swallow a whole created leg', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })
  await stuckClaim()
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0' })
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#1' })
  nowMs = T0 + ROUTING_STALE_MS

  await service().submit(req({ lots: 30 }))

  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 1, 'both tranches are one contract, so they are one leg')
  assert.equal(legs[0]?.qty, 30 * LOT)
  assert.equal(legs[0]?.strike, 25_000)
  assert.equal(legs[0]?.entryPrice, 120, 'the price the CLAIM stored, never today’s mark')
  assert.equal(legs[0]?.deskTag, 'coid-1#0')
  assert.equal(store.docs('desk-order-events').length, 1, 'and it is announced like any creation')
})

test('a reconcile does NOT fold a book the dead process had ALREADY folded', async () => {
  /**
   * `#maintainBook` applies fills as DELTAS: folding the same fill twice
   * doubles the leg. What makes the repair safe is the ORDER the routing loop
   * writes in — the uniquely-indexed P&L record first, the book fold straight
   * after — so a decision record that already exists means the fold already
   * ran, and the duplicate-key answer is the crash marker that says so.
   */
  await store.collection('desk-decisions').createIndex({ decisionId: 1 }, { unique: true })
  await store.collection('desk-decisions').insertOne({ decisionId: 'coid-1', fills: [] })
  store.books.set('BN_BREAKOUT:paper', {
    symbol: 'NIFTY',
    expiry: EXPIRY,
    // What the dead process's own fold left behind.
    legs: [heldLeg(30 * LOT)],
  })
  await stuckClaim()
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0' })
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#1' })
  nowMs = T0 + ROUTING_STALE_MS

  await service().submit(req({ lots: 30 }))

  assert.equal(
    store.books.get('BN_BREAKOUT:paper')?.legs[0]?.qty,
    30 * LOT,
    'a doubled leg is a position the supervisor hedges against and nothing contradicts',
  )
  assert.equal(store.docs('desk-decisions').length, 1)
})

test('a reconcile of a LIVE RESTING order writes NEITHER the P&L record NOR a leg', async () => {
  // The routing loop writes neither for a live resting order, so neither is
  // this repair's to write. The claim does not carry the flag; the ORDER
  // DOCUMENT does, and this path is already reading it.
  store.books.set('BN_BREAKOUT:live', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })
  await stuckClaim({ mode: 'live' })
  await store.collection(ORDER_COLLECTIONS.live).insertOne({ clientOrderId: 'coid-1#0', resting: true })
  await store.collection(ORDER_COLLECTIONS.live).insertOne({ clientOrderId: 'coid-1#1', resting: true })
  nowMs = T0 + ROUTING_STALE_MS

  const res = await service(['BN_BREAKOUT']).submit(req({ lots: 30, mode: 'live' }))

  assert.equal(res.accepted, true, 'the orders are real and the response says so')
  assert.deepEqual(store.books.get('BN_BREAKOUT:live')?.legs, [], 'it may never have traded')
  assert.equal(store.docs('desk-decisions').length, 0)
  assert.equal(logs.some((l) => /RESTING submission/.test(l.msg)), true)
})

test('a reconcile of a PAPER RESTING order writes BOTH — the paper rail filled it on the spot', async () => {
  // The routing loop books a paper resting order (see `submit`'s "A LIVE
  // RESTING ORDER IS NOT A FILL"), so the repair rebuilds both records for it.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })
  await stuckClaim()
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0', resting: true })
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#1', resting: true })
  nowMs = T0 + ROUTING_STALE_MS

  const res = await service().submit(req({ lots: 30 }))

  assert.equal(res.accepted, true)
  assert.equal(store.docs('desk-decisions').length, 1)
  assert.equal(store.books.get('BN_BREAKOUT:paper')?.legs[0]?.qty, 30 * LOT)
})

test('a reconcile of a LIVE submission probes the LIVE collection, never the paper one', async () => {
  // Probing the wrong collection reports a routed order as lost, which is the
  // one answer that talks a caller into placing it a second time.
  await stuckClaim({ mode: 'live' })
  await store.collection(ORDER_COLLECTIONS.paper).insertOne({ clientOrderId: 'coid-1#0' })
  await store.collection(ORDER_COLLECTIONS.live).insertOne({ clientOrderId: 'coid-1#1' })
  nowMs = T0 + ROUTING_STALE_MS
  const res = await service(['BN_BREAKOUT']).submit(req({ lots: 30, mode: 'live' }))
  assert.equal(res.accepted, true)
  if (!res.accepted) return
  assert.deepEqual(
    res.orders.map((o) => o.clientOrderId),
    ['coid-1#1'],
  )
})

// ------------------------------------------- S1: a lost response, and only one order

test('a routed order whose response is LOST is not placed twice when the same id is retried', async () => {
  /**
   * The S1 scenario end to end. The bookkeeping write after routing fails —
   * exactly the Mongo hiccup that used to throw a 500 for an order already
   * sitting in the order collection — so the caller sees nothing come back.
   *
   * The caller retries under the SAME clientOrderId. It must NEVER end up with
   * two orders on the wire, and it must eventually learn the truth.
   */
  const svc = service()
  store.raw(SUBMISSIONS).failUpdateWith = new Error('mongo hiccup on the status write')

  // Attempt 1: routes, then the status write fails. It must NOT throw: throwing
  // is what made the caller unable to tell "never routed" from "response lost".
  const first = await svc.submit(req({ lots: 30 }))
  assert.equal(first.accepted, true)
  if (!first.accepted) return
  assert.equal(first.routedLots, 30)
  assert.equal(paper.routed.length, 2)
  assert.ok(logs.some((l) => l.msg.includes('status write FAILED')))
  // ...and the record is stuck in ROUTING, which is the recoverable state.
  assert.equal(store.docs(SUBMISSIONS)[0]?.['status'], 'ROUTING')

  // Attempt 2, same id, immediately: honest "unknown", and nothing re-routed.
  const second = await svc.submit(req({ lots: 30 }))
  assert.equal(second.accepted, false)
  assert.equal(paper.routed.length, 2)

  // Attempt 3, same id, after the process would have been declared dead and
  // once Mongo is back: reconciled to the truth. Still two orders, not four.
  store.raw(SUBMISSIONS).failUpdateWith = null
  nowMs = T0 + ROUTING_STALE_MS
  const third = await svc.submit(req({ lots: 30 }))
  assert.equal(third.accepted, true)
  if (!third.accepted) return
  assert.equal(third.status, 'DONE')
  assert.equal(third.routedLots, 30)
  assert.equal(paper.routed.length, 2)
  assert.equal(store.docs(ORDER_COLLECTIONS.paper).length, 2)
})

test('two CONCURRENT submits of the same id place the order exactly once', async () => {
  /**
   * The unique index is the lock, not the read-then-write above it: both calls
   * read "not seen" before either inserts. Only the insert can arbitrate, and
   * the loser must be told something that is not a success — it did not route
   * and cannot know what the winner did.
   */
  const svc = service()
  const both = await Promise.all([svc.submit(req()), svc.submit(req())])

  assert.equal(paper.routed.length, 1, 'the order must reach the rail exactly once')
  assert.equal(store.docs(SUBMISSIONS).length, 1, 'one claim, not two')
  assert.equal(store.docs(ORDER_COLLECTIONS.paper).length, 1)

  const winners = both.filter((r) => r.accepted)
  assert.equal(winners.length, 1, 'exactly one caller may be told the order was placed')
  const loser = both.find((r) => !r.accepted)
  assert.ok(loser !== undefined)
  if (loser.accepted) return
  // Whichever state the loser observed, it must not be a claim of success —
  // both callers booking the position is the same double-count as two orders.
  if (loser.status === 'ROUTING') assert.equal(loser.indeterminate, true)
  else assert.equal(loser.routedLots, 0)
})

// ------------------------------------------------------ S3: the ROUTED size

test('a PARTIAL route reports the ROUTED lots, never the intended ones', async () => {
  /**
   * 30 lots split 24 + 6 against the freeze cap; the 6 is rejected. Reporting
   * `lots: 30` is what makes the runner's ledger book 30 against a real
   * position of 24 — and the 15:20 flatten then SELLS 30, opening a 6-lot short
   * nobody asked for, at whatever the close is doing.
   */
  let n = 0
  const flaky: OrderRail = {
    mode: 'paper',
    collection: ORDER_COLLECTIONS.paper,
    route: async (fill, ctx) => {
      n++
      if (n === 2) throw new Error('exchange rejected the second tranche')
      await paper.route(fill, ctx)
    },
  }
  const svc = new SubmitService({
    store,
    rails: { paper: flaky, live },
    master: { current: master },
    marks: MARKS,
    freeze: () => FREEZE,
    liveTags: new Set(),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
  })
  const res = await svc.submit(req({ lots: 30 }))
  assert.equal(res.accepted, true)
  if (!res.accepted) return
  assert.equal(res.routedLots, 24, 'the number the caller must book')
  assert.equal(res.lots, 24, '`lots` is an alias of the routed size, not the intent')
  assert.equal(res.intendedLots, 30)
  assert.equal(res.requestedLots, 30)
  // A partial is not a clean success, and the response says so in three places.
  assert.equal(res.status, 'FAILED')
  assert.equal(res.orders.length, 1)
  assert.equal(res.errors.length, 1)
})

test('a replayed partial reports the same ROUTED lots — the truth does not decay on retry', async () => {
  let n = 0
  const flaky: OrderRail = {
    mode: 'paper',
    collection: ORDER_COLLECTIONS.paper,
    route: async (fill, ctx) => {
      n++
      if (n === 2) throw new Error('exchange rejected the second tranche')
      await paper.route(fill, ctx)
    },
  }
  const svc = new SubmitService({
    store,
    rails: { paper: flaky, live },
    master: { current: master },
    marks: MARKS,
    freeze: () => FREEZE,
    liveTags: new Set(),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: () => undefined,
  })
  await svc.submit(req({ lots: 30 }))
  const replay = await svc.submit(req({ lots: 30 }))
  assert.equal(replay.accepted, true)
  if (!replay.accepted) return
  assert.equal(replay.replayed, true)
  assert.equal(replay.routedLots, 24)
  assert.equal(replay.status, 'FAILED')
  assert.equal(paper.routed.length, 1)
})

test('a clean full route reports routedLots equal to intendedLots', async () => {
  const res = await service().submit(req({ lots: 30 }))
  assert.equal(res.accepted, true)
  if (!res.accepted) return
  assert.equal(res.status, 'DONE')
  assert.equal(res.routedLots, 30)
  assert.equal(res.intendedLots, 30)
  assert.equal(res.errors.length, 0)
})

// ----------------------------------------------------------------- pricing

function unmarked(liveTags: string[] = []): SubmitService {
  return new SubmitService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: { price: () => null, spot: () => null },
    freeze: () => FREEZE,
    liveTags: new Set(liveTags),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: () => undefined,
  })
}

test('an order with no price anywhere is REFUSED rather than journalled at 0', async () => {
  const res = await unmarked().submit(req())
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^mark:/)
  assert.equal(paper.routed.length, 0)
})

test('a LIVE order with no mark is refused too — a 0-price fill reports profit never made', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { live: { enabled: true } }, liveLots: 1 }))
  const res = await unmarked(['BN_BREAKOUT']).submit(req({ mode: 'live' }))
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^mark:/)
  assert.equal(live.routed.length, 0)
})

test("the strategy's own referencePrice carries an order through a cold mark cache", async () => {
  const res = await unmarked().submit(req({ referencePrice: 118.5 }))
  assert.equal(res.accepted, true)
  assert.equal(paper.routed[0]?.fill.price, 118.5)
})

// ------------------------------------------------------------- P&L journal

test('an accepted submit lands a desk-decisions record PnlStore.loadFills can see', async () => {
  await service().submit(req({ lots: 30 }))
  const decisions = store.docs('desk-decisions')
  assert.equal(decisions.length, 1)
  const d = decisions[0] as Record<string, unknown>
  // The four fields loadFills filters and groups on.
  assert.equal(d['tag'], 'BN_BREAKOUT')
  assert.equal(d['mode'], 'paper')
  assert.equal(d['createdAt'], T0)
  const fills = d['fills'] as Fill[]
  // One fill per ROUTED tranche, in the order they routed — average cost is
  // path-dependent and the array is the authoritative sequence.
  assert.equal(fills.length, 2)
  assert.deepEqual(
    fills.map((f) => f.qty),
    [24 * LOT, 6 * LOT],
  )
  for (const f of fills) {
    assert.equal(f.tradingsymbol, SYMBOL)
    assert.equal(f.side, 'Buy')
    /**
     * THE MARK, exactly. `f.price > 0` was satisfied by any non-zero number —
     * including the 0.05 tick a mis-wired price source would produce, which is
     * the real defect that shipped once already (2026-06-17: the API dropped
     * `instrument_token` and every fill booked at 0.05). The fixture's mark is
     * 120 and there is only one right answer.
     */
    assert.equal(f.price, 120, 'the fill books at the live mark, not at a tick')
  }
})

test('a fill is deskTagged by its own tranche id unless the caller names a desk leg', async () => {
  // The DEFAULT, pinned so the repair path's override cannot quietly become
  // everyone's: a manual order, a hosted strategy, a mirror — all of them
  // journal under the tranche's own clientOrderId, which is what makes
  // "present after, absent before" the set of legs a fold created.
  await service().submit(req({ lots: 2 }))
  const plain = (store.docs('desk-decisions')[0]?.['fills'] as Fill[])[0]
  assert.equal(plain?.deskTag, 'coid-1#0')

  /**
   * AND THE ONE CALLER THAT NEEDS OTHERWISE. A repair's close is a close OF a
   * driver-owned leg, and `absorb_bridge_closes` books that leg's realized P&L
   * only when a confirmed close trade carries the LEG's id. Tagged with the
   * order's own id the trade never matches, the driver drops the leg with
   * "P&L is NOT booked", and the money is gone from `cum_realized` for good.
   */
  await service().submit(
    req({ clientOrderId: 'repair:dec-9:0', lots: 2, reducesExposure: true, fillDeskTag: 'py:2440PE:1755' }),
  )
  const repaired = (store.docs('desk-decisions')[1]?.['fills'] as Fill[])[0]
  assert.equal(repaired?.deskTag, 'py:2440PE:1755')
  assert.equal(repaired?.op, 'close')
})

test('a LIVE RESTING submit journals NO fills and folds NO book — it is not a fill yet', async () => {
  // reconcile-live can only reduce or restate what was booked, never insert,
  // so an optimistic booking of an order that may rest for hours would show a
  // position (or an exit) as done while the risk is still live.
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: true }, live: { enabled: true } }, liveLots: 1 }))
  const res = await service(['BN_BREAKOUT']).submit(
    req({ mode: 'live', lots: 1, orderType: 'LIMIT', limitPrice: 99.5, resting: true }),
  )
  assert.equal(res.accepted, true)
  assert.equal(store.docs('desk-decisions').length, 0)
  // The order itself still routed — visibility lives at the broker, not in the book.
  assert.equal(live.routed.length, 1)
})

test('a PAPER RESTING submit IS journalled — the paper rail fills it at the limit as it routes', async () => {
  // Paper has no resting: `rail.ts` writes every `/submit` paper order
  // COMPLETE the moment it routes. Skipping the journal there left a fill on
  // the order log that no P&L view and no book ever saw (TCS, 2026-10-19).
  const res = await service().submit(req({ lots: 1, orderType: 'LIMIT', limitPrice: 99.5, resting: true }))
  assert.equal(res.accepted, true)
  const fills = store.docs('desk-decisions')[0]?.['fills'] as Fill[] | undefined
  assert.equal(fills?.length, 1)
  assert.equal(fills?.[0]?.price, 99.5, 'at the limit — the price the paper rail filled it at')
})

test('a RESTING fill carries the OPERATOR limit as its price, never the mark', async () => {
  await service().submit(req({ lots: 1, orderType: 'LIMIT', limitPrice: 99.5, resting: true }))
  assert.equal(paper.routed[0]?.fill.price, 99.5)
})

test('a REFUSED submit journals no fills — a blocked strategy must read as flat', async () => {
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: false } } }))
  await service().submit(req())
  assert.equal(store.docs('desk-decisions').length, 0)
})

test('only tranches that actually ROUTED reach the P&L journal', async () => {
  paper.failWith = new Error('rail down')
  await service().submit(req())
  assert.equal(store.docs('desk-decisions').length, 0)
})

// -------------------------------------------------------------- instrument

test('an unresolvable symbol with no lot size is refused, never fabricated', async () => {
  const res = await service().submit(
    req({ instrument: { tradingsymbol: 'NIFTY26AUG99999CE' } }),
  )
  assert.equal(res.accepted, false)
  assert.match(res.reason, /^instrument:/)
})

test('the instrument master wins over the caller-supplied lot size', async () => {
  // A strategy holding a stale lot size must not silently mis-size the order.
  const res = await service().submit(
    req({ instrument: { tradingsymbol: SYMBOL, lotSize: 50, exchange: 'NFO' } }),
  )
  assert.equal(res.accepted, true)
  assert.equal(res.orders[0]?.qty, 2 * LOT)
})

// -------------------------------------------------------------- validation

test('validation names the exact field, so a failing client is debuggable from its own log', () => {
  const cases: [unknown, RegExp][] = [
    [{}, /tag is required/],
    [{ tag: 'T' }, /clientOrderId is required/],
    [{ tag: 'T', clientOrderId: 'c' }, /mode must be stated/],
    [{ tag: 'T', clientOrderId: 'c', mode: 'paper' }, /side must be/],
    [{ tag: 'T', clientOrderId: 'c', mode: 'paper', side: 'Buy' }, /lots must be/],
    [
      { tag: 'T', clientOrderId: 'c', mode: 'paper', side: 'Buy', lots: 1 },
      /instrument must be an object/,
    ],
    [
      {
        tag: 'T',
        clientOrderId: 'c',
        mode: 'paper',
        side: 'Buy',
        lots: 1,
        instrument: { tradingsymbol: 'X' },
        orderType: 'LIMIT',
      },
      /limitPrice is required when orderType is LIMIT/,
    ],
    // A resting MARKET is a contradiction, and a resting order priced by the
    // marketable machinery would rest at a price nobody chose.
    [
      {
        tag: 'T',
        clientOrderId: 'c',
        mode: 'paper',
        side: 'Buy',
        lots: 1,
        instrument: { tradingsymbol: 'X' },
        resting: true,
      },
      /resting requires orderType 'LIMIT'/,
    ],
    [
      {
        tag: 'T',
        clientOrderId: 'c',
        mode: 'paper',
        side: 'Buy',
        lots: 1,
        instrument: { tradingsymbol: 'X' },
        orderType: 'MARKET',
        resting: true,
      },
      /resting requires orderType 'LIMIT'/,
    ],
    // An origin nobody defined is a leg the driver cannot classify. It is
    // refused at the door rather than stored and puzzled over later.
    [
      {
        tag: 'T',
        clientOrderId: 'c',
        mode: 'paper',
        side: 'Buy',
        lots: 1,
        instrument: { tradingsymbol: 'X' },
        origin: 'robot',
      },
      /origin must be 'manual' or 'repair'/,
    ],
    // An empty desk tag is not a desk leg. It would ride onto the fill as a
    // leg id that matches nothing, which is the failure the field exists to
    // fix, wearing the shape of the fix.
    [
      {
        tag: 'T',
        clientOrderId: 'c',
        mode: 'paper',
        side: 'Buy',
        lots: 1,
        instrument: { tradingsymbol: 'X' },
        fillDeskTag: '  ',
      },
      /fillDeskTag must be a non-empty string/,
    ],
    /**
     * A desk tag on an OPENING order is a leg id somebody else already owns.
     * `applyRoutedFill` stamps a created leg with the fill's tag, so this would
     * mint a SECOND bridge leg under one id — `findLeg` takes the first match
     * and the driver's own book is keyed one leg per id, so the two would be
     * indistinguishable to every reader that matters.
     */
    [
      {
        tag: 'T',
        clientOrderId: 'c',
        mode: 'paper',
        side: 'Buy',
        lots: 1,
        instrument: { tradingsymbol: 'X' },
        fillDeskTag: 'py:2440PE:1755',
      },
      /fillDeskTag names the desk leg being CLOSED/,
    ],
  ]
  for (const [body, pattern] of cases) {
    const v = validateSubmitRequest(body)
    assert.equal(v.ok, false)
    if (!v.ok) assert.match(v.error, pattern)
  }
})

test('a valid body round-trips, and absent optionals stay absent', () => {
  const v = validateSubmitRequest({
    tag: 'T',
    clientOrderId: 'c',
    mode: 'live',
    side: 'Sell',
    lots: 3,
    instrument: { tradingsymbol: 'X', lotSize: 75, exchange: 'NFO' },
    reducesExposure: true,
  })
  assert.equal(v.ok, true)
  if (!v.ok) return
  assert.equal(v.value.reducesExposure, true)
  assert.equal('orderType' in v.value, false)
  assert.equal('limitPrice' in v.value, false)
  assert.equal('origin' in v.value, false, 'absent means manual; it is not defaulted in')
  assert.equal('fillDeskTag' in v.value, false, 'absent means the tranche id, as it always was')
})

test('a fillDeskTag round-trips verbatim — it is a foreign id, not ours to normalise', () => {
  const v = validateSubmitRequest({
    tag: 'T',
    clientOrderId: 'c',
    mode: 'paper',
    side: 'Buy',
    lots: 1,
    instrument: { tradingsymbol: 'X' },
    reducesExposure: true,
    fillDeskTag: 'py:2440PE:1755',
  })
  assert.equal(v.ok, true)
  if (!v.ok) return
  assert.equal(v.value.fillDeskTag, 'py:2440PE:1755')
})

test('an OPENING order may not name a desk leg — the rail refuses it too', async () => {
  // The validator is the door; this is the room. `RepairApplyService` and every
  // other in-process caller reach `submit` directly, so the rule has to hold
  // where the fill is actually built, not only where a body is parsed.
  const res = await service().submit(req({ lots: 1, fillDeskTag: 'py:2440PE:1755' }))
  assert.equal(res.accepted, false)
  if (res.accepted) return
  assert.match(res.reason, /fillDeskTag/)
  assert.equal(paper.routed.length, 0, 'nothing may reach a rail under a borrowed leg id')
  assert.equal(store.docs('desk-decisions').length, 0)
})

test('and an EXIT that names one is placed exactly as before', async () => {
  const res = await service().submit(
    req({ lots: 1, reducesExposure: true, fillDeskTag: 'py:2440PE:1755' }),
  )
  assert.equal(res.accepted, true)
  assert.equal(paper.routed[0]?.fill.deskTag, 'py:2440PE:1755')
})

test('both origins round-trip verbatim', () => {
  for (const origin of ['manual', 'repair'] as const) {
    const v = validateSubmitRequest({
      tag: 'T',
      clientOrderId: 'c',
      mode: 'paper',
      side: 'Buy',
      lots: 1,
      instrument: { tradingsymbol: 'X' },
      origin,
    })
    assert.equal(v.ok, true)
    if (!v.ok) return
    assert.equal(v.value.origin, origin)
  }
})

// ----------------------------------------------------------------- liveness

test('a submit stamps lastSeenAt, so "is this strategy alive?" is answerable', async () => {
  await service().submit(req())
  assert.deepEqual(store.touched, ['BN_BREAKOUT'])
})

// ------------------------------------------------------- the websocket push

/**
 * The push is a NOTIFICATION, never a step in placing an order.
 *
 * A refusal is the event an operator is most likely to be waiting on — "why did
 * nothing trade this morning?" — so this endpoint emits the one it journals.
 * What follows is the guarantee around it: it cannot change the answer, and it
 * cannot fail the call.
 */
function serviceEmitting(emit: PaperFillEmit, liveTags: string[] = []): SubmitService {
  return new SubmitService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    freeze: () => FREEZE,
    liveTags: new Set(liveTags),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
    emit,
  })
}

test('a refusal is pushed, carrying the mode it was refused in', async () => {
  const pushed: { mode: string; event: Record<string, unknown> }[] = []
  store.kill = { enabled: true, reason: 'testing', setBy: 'op', setAt: T0 }

  const res = await serviceEmitting((mode, event) => pushed.push({ mode, event })).submit(req())

  assert.equal(res.accepted, false)
  assert.equal(pushed.length, 1)
  // The mode of the REQUEST. A live refusal pushed to a paper tab would be the
  // same lie as a live fill rendered under the PAPER badge.
  assert.equal(pushed[0]?.mode, 'paper')
  assert.equal(pushed[0]?.event['phase'], 'INVALID')
  assert.match(String(pushed[0]?.event['error']), /kill switch/)
})

test('a THROWING push does not change the answer or fail the call', async () => {
  store.kill = { enabled: true, reason: 'testing', setBy: 'op', setAt: T0 }

  const res = await serviceEmitting(() => {
    throw new Error('the dashboard socket exploded')
  }).submit(req())

  // Same response, same journal row. The notification is the only thing lost.
  assert.equal(res.accepted, false)
  assert.equal(store.docs('desk-order-events').length, 1)
})

test('an ACCEPTED order pushes nothing from here — the rail already did', async () => {
  // `PaperRail.route` emits the fill at the point it writes it, which is the
  // one place EVERY paper fill passes through. Emitting again here would put
  // the same fill on the page twice.
  const pushed: unknown[] = []
  const res = await serviceEmitting(() => pushed.push(1)).submit(req())
  assert.equal(res.accepted, true)
  assert.deepEqual(pushed, [])
})

// ------------------------------------------------- the book is MAINTAINED

/**
 * THE BHEL FLATTEN, reproduced. Reported from prod 2026-07-31.
 *
 * `desk-books` was written only by the seed path and `applyActions`, so this
 * endpoint routed orders and never touched it. After flattening BHEL the order
 * log correctly read "0 open, 2 closed" while the book still recorded the
 * opening BUYs — the Positions page drew two legs that no longer existed, net
 * delta and P&L were computed off them, and the book could not be deleted
 * because the delete guard reads the same record.
 */
function heldLeg(qty: number): BridgeLeg {
  return {
    deskTag: 'entry-seed#0',
    instrument: { tradingsymbol: SYMBOL, instrumentToken: 25_001, lotSize: LOT, tickSize: 0.05, exchange: 'NFO' },
    underlying: 'NIFTY',
    expiry: EXPIRY,
    strike: 25_000,
    type: 'CE',
    side: qty > 0 ? 'Buy' : 'Sell',
    qty,
    entryPrice: 100,
    openedTs: 0,
  }
}

test('a closing submit REMOVES the leg from the stored book', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(2 * LOT)] })
  const res = await service().submit(req({ side: 'Sell', reducesExposure: true }))
  assert.equal(res.accepted, true)
  assert.deepEqual(
    store.books.get('BN_BREAKOUT:paper')?.legs,
    [],
    'the book must not keep describing a position that was just closed',
  )
})

test('a partial close reduces the leg rather than removing it', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(5 * LOT)] })
  await service().submit(req({ side: 'Sell', lots: 2, reducesExposure: true }))
  assert.equal(store.books.get('BN_BREAKOUT:paper')?.legs[0]?.qty, 3 * LOT)
})

test('a tag with no book at all is not given one', async () => {
  await service().submit(req())
  assert.equal(store.books.get('BN_BREAKOUT:paper'), undefined)
})

// ------------------------------------ a MANUAL order becomes a VISIBLE leg

/**
 * PHASE 2, the bridge half. The Manual Order dialog posts `/v1/desk/submit`
 * under a DESK BOOK's tag, and this fold used to leave a fill on a contract the
 * book did not hold ALONE. The leg then existed at the broker and nowhere else:
 * the Python supervisor never managed it, the Positions page never drew it, and
 * only `positions-compare` noticed — as a divergence against a leg nobody could
 * explain. An invisible real position is the worst record this desk can hold.
 *
 * `manualReq` is the dialog's real shape: its own `clientOrderId` namespace,
 * `exactLots`, an explicit LIMIT, and NO `underlying` — the dialog does not
 * send one, so the underlying is the gateway's derivation from the symbol.
 */
const MANUAL_COID = `manual:BN_BREAKOUT:paper:${SYMBOL}:${T0}`

function manualReq(patch: Partial<SubmitRequestBody> = {}): SubmitRequestBody {
  return {
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    clientOrderId: MANUAL_COID,
    instrument: { tradingsymbol: SYMBOL },
    side: 'Buy',
    lots: 2,
    orderType: 'LIMIT',
    limitPrice: 120,
    exactLots: true,
    ...patch,
  }
}

test('a manual OPEN on a contract the book does not hold CREATES the leg', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  const res = await service().submit(manualReq())

  assert.equal(res.accepted, true)
  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 1, 'the manual order must be a leg the supervisor can see')
  const leg = legs[0] as BridgeLeg
  // Every field the book is read through, from the MASTER's own row — not from
  // a regex over the symbol, which is how phantom strikes get booked.
  assert.equal(leg.strike, 25_000)
  assert.equal(leg.type, 'CE')
  assert.equal(leg.expiry, EXPIRY)
  assert.equal(leg.underlying, 'NIFTY')
  assert.equal(leg.side, 'Buy')
  assert.equal(leg.qty, 2 * LOT, 'SIGNED contract qty — a Buy is positive')
  assert.equal(leg.entryPrice, 120, 'the cost basis is what filled, never the mark of the day')
  // The per-tranche clientOrderId, so the leg names the order that opened it.
  assert.equal(leg.deskTag, `${MANUAL_COID}#0`)
  // The full ref the submit path already resolved: token and lot size included,
  // because everything that routes off this leg later needs them.
  assert.equal(leg.instrument.instrumentToken, 25_001)
  assert.equal(leg.instrument.lotSize, LOT)
})

/**
 * WHO AUTHORED THE ORDER, RIDING SUBMIT ONTO THE LEG.
 *
 * The repair Apply button places its legs through this same endpoint, and the
 * Python driver must be able to tell them apart from an operator's manual one:
 * a repair leg is adopted BOT-MANAGED, a manual leg is adopted `protected` and
 * left alone. Nothing else in the request distinguishes them — same tag, same
 * dialog-shaped `clientOrderId`, same explicit LIMIT — so the leg has to carry
 * the word itself.
 */
test('a REPAIR order stamps its origin on the leg it creates', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  await service().submit(manualReq({ origin: 'repair' }))

  const leg = store.books.get('BN_BREAKOUT:paper')?.legs[0] as BridgeLeg
  assert.equal(leg.origin, 'repair', 'the driver adopts this one bot-managed')
})

test('a submit with NO origin stores no origin key at all — absent IS manual', async () => {
  /**
   * Absent, never `'manual'` written as a default. Every leg already on the
   * book — seeded, adopted, opened by a supervisor months ago — has no such
   * key, and a reader that treats absence as manual keeps all of them valid.
   * Stamping the default here would say nothing new and would make the field
   * look like it had been decided when it had not.
   */
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  await service().submit(manualReq())

  const leg = store.books.get('BN_BREAKOUT:paper')?.legs[0] as BridgeLeg
  assert.equal('origin' in leg, false)
})

test('a repair fill folded into a leg the book ALREADY holds restamps that leg', async () => {
  // The repair sizes up a strike the book is already short. The leg that comes
  // out of the fold is the one the driver will manage, so it is the one that
  // has to say who last authored it.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(2 * LOT)] })

  await service().submit(manualReq({ lots: 2, origin: 'repair' }))

  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.qty, 4 * LOT)
  assert.equal(legs[0]?.origin, 'repair')
})

test('a repair fill leaves the origin of legs it never touched alone', async () => {
  // A book holding an untouched leg on ANOTHER contract keeps that leg exactly
  // as it was: the stamp describes the order that folded, not the book.
  const other: BridgeLeg = {
    ...heldLeg(-2 * LOT),
    instrument: {
      tradingsymbol: 'NIFTY26AUG25100CE',
      lotSize: LOT,
      tickSize: 0.05,
      exchange: 'NFO',
    },
    strike: 25_100,
    deskTag: 'other#0',
  }
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [other] })

  await service().submit(manualReq({ origin: 'repair' }))

  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 2)
  const untouched = legs.find((l) => l.deskTag === 'other#0') as BridgeLeg
  assert.equal('origin' in untouched, false)
  assert.equal(legs.find((l) => l.deskTag !== 'other#0')?.origin, 'repair')
})

test('a manual SELL creates a SHORT leg — the sign comes from the fill side', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })
  await service().submit(manualReq({ side: 'Sell' }))
  const leg = store.books.get('BN_BREAKOUT:paper')?.legs[0] as BridgeLeg
  assert.equal(leg.side, 'Sell')
  assert.equal(leg.qty, -2 * LOT)
})

test('the created leg is announced on the order feed, so the operator sees it was ADOPTED', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  await service().submit(manualReq())

  const events = store.docs('desk-order-events')
  assert.equal(events.length, 1, 'exactly one line — an announcement, not a stream')
  const e = events[0] as Record<string, unknown>
  assert.equal(e['phase'], 'STATUS')
  assert.equal(e['ok'], true, 'nothing failed; this is news, not a fault')
  assert.equal(e['tag'], 'BN_BREAKOUT')
  assert.equal(e['tradingsymbol'], SYMBOL)
  // Keyed on the TRANCHE id, which is what the gateway journals that order's
  // ACK and fills under — so the line lands inside that order's own timeline.
  assert.equal(e['clientOrderId'], `${MANUAL_COID}#0`)
  assert.match(String(e['error']), /^manual leg added to book BN_BREAKOUT: /)
  assert.match(String(e['error']), new RegExp(`${SYMBOL} qty ${2 * LOT} @ 120`))
  assert.match(String(e['error']), /the supervisor adopts it on its next tick/)
})

test('a freeze-split manual order creates ONE leg and announces it ONCE', async () => {
  // 30 lots against NIFTY's 24-lot freeze cap: two tranches, one contract. The
  // second tranche must find the leg the first created and fold into it.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  const res = await service().submit(manualReq({ lots: 30 }))

  assert.equal(res.accepted, true)
  assert.equal(res.orders.length, 2)
  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.qty, 30 * LOT)
  assert.equal(store.docs('desk-order-events').length, 1)
})

test('a manual open on a contract the book ALREADY holds still folds, and announces nothing', async () => {
  // The pre-existing behaviour, unchanged: an add is size-weighted onto the
  // held leg and does not create a second one.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(2 * LOT)] })

  await service().submit(manualReq({ lots: 2 }))

  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.qty, 4 * LOT)
  // 2 x 100 (the held basis) + 2 x 120 (this fill), over 4 lots.
  assert.equal(legs[0]?.entryPrice, 110)
  assert.equal(legs[0]?.deskTag, 'entry-seed#0', 'the held leg keeps its own identity')
  assert.equal(store.docs('desk-order-events').length, 0, 'nothing was created')
})

test('a CLOSE on a contract the book does not hold is still left alone', async () => {
  // Closing what you do not hold is not a leg. Booking one would put an
  // OPPOSITE phantom position on the record — the exact shape this fold exists
  // to keep off it.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  const res = await service().submit(manualReq({ side: 'Sell', reducesExposure: true }))

  assert.equal(res.accepted, true, 'the order still routes — only the book stays silent')
  assert.deepEqual(store.books.get('BN_BREAKOUT:paper')?.legs, [])
  assert.equal(store.docs('desk-order-events').length, 0)
})

test('a tag with NO book document is still not given one by a manual open', async () => {
  // A hosted strategy owns its positions internally and has no book document.
  // Creating one here would invent a book nobody asked for.
  await service().submit(manualReq())
  assert.equal(store.books.get('BN_BREAKOUT:paper'), undefined)
  assert.equal(store.docs('desk-order-events').length, 0)
})

test('a contract the MASTER cannot name is left alone, and LOGGED', async () => {
  /**
   * A guessed leg is worse than an invisible one: a wrong strike on the book is
   * acted on by delta, by margin, by the delete guard and by the supervisor's
   * next adjustment. The instrument still resolves through the request's own
   * lotSize/exchange fallback — so the order routes — but the dump carries no
   * row for it and the fold refuses rather than parsing the symbol itself.
   */
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  const res = await service().submit(
    manualReq({
      instrument: { tradingsymbol: 'NIFTY26SEP25000CE', lotSize: LOT, exchange: 'NFO' },
      referencePrice: 120,
    }),
  )

  assert.equal(res.accepted, true, 'the order routed; only the book could not describe it')
  assert.deepEqual(store.books.get('BN_BREAKOUT:paper')?.legs, [])
  assert.equal(store.docs('desk-order-events').length, 0, 'nothing was created, so nothing is announced')
  assert.equal(
    logs.some((l) => /master cannot name the contract/.test(l.msg)),
    true,
    'silence here is the invisible position all over again',
  )
})

test('a FUTURE is left alone — an option leg needs a strike this symbol does not have', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  const res = await service().submit(
    manualReq({
      instrument: { tradingsymbol: 'NIFTY26AUGFUT', lotSize: LOT, exchange: 'NFO' },
      limitPrice: 25_000,
      referencePrice: 25_000,
    }),
  )

  assert.equal(res.accepted, true)
  assert.deepEqual(store.books.get('BN_BREAKOUT:paper')?.legs, [])
  assert.equal(logs.some((l) => /master cannot name the contract/.test(l.msg)), true)
})

test('a LIVE RESTING manual order creates NOTHING — it is not a fill yet', async () => {
  // The guarantee `#maintainBook` is never even reached for a live resting
  // order. An optimistic leg for an order that may sit for hours is a position
  // the book shows and the account does not.
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: true }, live: { enabled: true } }, liveLots: 1 }))
  store.books.set('BN_BREAKOUT:live', { symbol: 'NIFTY', expiry: EXPIRY, legs: [] })

  const res = await service(['BN_BREAKOUT']).submit(
    manualReq({ mode: 'live', lots: 1, limitPrice: 99.5, resting: true }),
  )

  assert.equal(res.accepted, true)
  assert.equal(live.routed.length, 1, 'the order itself still routed')
  assert.deepEqual(store.books.get('BN_BREAKOUT:live')?.legs, [])
  assert.equal(store.docs('desk-order-events').length, 0)
})

test('a PAPER RESTING manual CLOSE reduces the book — it filled as it routed', async () => {
  // The TCS incident, 2026-10-19: five Resting closes from the Manual Order
  // dialog filled on the paper rail, read "filled" on the order log, and left
  // every leg on the book untouched — the operator then closed them again.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(5 * LOT)] })

  const res = await service().submit(
    manualReq({ side: 'Sell', lots: 2, limitPrice: 99.5, resting: true, reducesExposure: true }),
  )

  assert.equal(res.accepted, true)
  assert.equal(store.books.get('BN_BREAKOUT:paper')?.legs[0]?.qty, 3 * LOT)
})

test('a manual open whose book write LOSES the race creates nothing, and says so loudly', async () => {
  /**
   * The retry still reduces and adds only. The loser cannot tell, against a
   * document it has not seen since, whether the winner closed this contract
   * deliberately — so it refuses to create and is LOUD about the routed order
   * the book will not show, which is what `positions-compare` then picks up.
   */
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [], updatedAt: 10 })
  store.beforeSaveBook = (): void => {
    store.beforeSaveBook = null
    const b = store.books.get('BN_BREAKOUT:paper') as StoredBookLike
    store.books.set('BN_BREAKOUT:paper', { ...b, legs: [otherLeg()], updatedAt: 99 })
  }

  const res = await service().submit(manualReq())

  assert.equal(res.accepted, true)
  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.deepEqual(
    legs.map((l) => l.instrument.tradingsymbol),
    ['NIFTY26JUL24000PE'],
    'the winner’s leg survives and ours is not invented onto it',
  )
  assert.equal(
    logs.some((l) => /could NOT be re-folded/.test(l.msg)),
    true,
  )
})

test('THE DROPPED CREATION IS ON THE ORDER FEED, not only in a process log', async () => {
  /**
   * The operator has just been told the order routed — it did. A leg lost to
   * the ~50ms CAS window used to leave that feed reading like an ordinary
   * success, with the only witness a `console` line on a box nobody has open.
   */
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [], updatedAt: 10 })
  store.beforeSaveBook = (): void => {
    store.beforeSaveBook = null
    const b = store.books.get('BN_BREAKOUT:paper') as StoredBookLike
    store.books.set('BN_BREAKOUT:paper', { ...b, legs: [otherLeg()], updatedAt: 99 })
  }

  await service().submit(manualReq())

  const events = store.docs('desk-order-events')
  assert.equal(events.length, 1)
  const e = events[0] as Record<string, unknown>
  assert.equal(e['phase'], 'STATUS')
  assert.equal(e['ok'], false, 'the book and the broker disagree — that is a fault, not news')
  assert.equal(e['status'], 'NOT BOOKED')
  assert.equal(e['clientOrderId'], `${MANUAL_COID}#0`, 'inside the order’s own timeline')
  assert.match(String(e['error']), /manual leg LOST to a concurrent book write/)
  assert.match(String(e['error']), /check Positions/)
  assert.match(String(e['error']), /The ORDER routed/)
})

test('a leg the retry DOES land is not reported as lost', async () => {
  // The winner still holds the contract, so our fill folds onto their leg —
  // nothing was dropped and there is nothing to warn about. A creation that is
  // announced as lost while the book carries it is a false alarm, and a feed
  // that cries wolf is a feed nobody reads.
  store.books.set('BN_BREAKOUT:paper', {
    symbol: 'NIFTY',
    expiry: EXPIRY,
    legs: [],
    updatedAt: 10,
  })
  store.beforeSaveBook = (): void => {
    store.beforeSaveBook = null
    const b = store.books.get('BN_BREAKOUT:paper') as StoredBookLike
    store.books.set('BN_BREAKOUT:paper', { ...b, legs: [heldLeg(LOT)], updatedAt: 99 })
  }

  await service().submit(manualReq({ lots: 1 }))

  assert.equal(store.books.get('BN_BREAKOUT:paper')?.legs[0]?.qty, 2 * LOT)
  assert.equal(store.docs('desk-order-events').length, 0)
})

// ------------------------------------ a leg is THIS book's pair, or nothing

test('a contract from ANOTHER UNDERLYING is refused a leg on this book, and LOGGED', async () => {
  /**
   * A book IS a symbol and an expiry — the registry requires both, every leg
   * `applyActions` opens carries the book's own, and the greeks, the margin
   * basket, the delete guard and the Python supervisor all read the book as
   * ONE chain. A BANKNIFTY leg inside a NIFTY book is a second book hiding in
   * the first. The dialog locks the pair, but the dialog is not the boundary:
   * `POST /v1/desk/submit` is, and it takes any tag with any contract.
   */
  store.books.set('BN_BREAKOUT:paper', { symbol: 'BANKNIFTY', expiry: EXPIRY, legs: [] })

  const res = await service().submit(manualReq())

  assert.equal(res.accepted, true, 'the order still routes — only the book stays silent')
  assert.deepEqual(store.books.get('BN_BREAKOUT:paper')?.legs, [])
  assert.equal(store.docs('desk-order-events').length, 0)
  const named = logs.find((l) => /not this book's pair/.test(l.msg))
  assert.notEqual(named, undefined, 'silence here is the invisible position all over again')
  assert.equal(named?.ctx?.['contract'], `NIFTY ${EXPIRY}`)
  assert.equal(named?.ctx?.['book'], `BANKNIFTY ${EXPIRY}`)
})

test('a contract from ANOTHER EXPIRY is refused a leg on this book too', async () => {
  // The far month is a different chain: one spot, one time to expiry, one
  // margin basket. A leg from the next expiry inside this book prices, hedges
  // and margins as though it expired with the rest of it.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: '2026-09-24', legs: [] })

  await service().submit(manualReq())

  assert.deepEqual(store.books.get('BN_BREAKOUT:paper')?.legs, [])
  assert.equal(logs.some((l) => /not this book's pair/.test(l.msg)), true)
})

// ------------------------------- a fill that crosses ZERO also creates a leg

test('a reducing fill that crosses THROUGH zero creates a leg — and ANNOUNCES it', async () => {
  /**
   * `applyRoutedFill` opens a leg on two paths, and the old `held === undefined`
   * flag only saw one. Selling 5 lots against a 2-lot long consumes the held
   * leg and opens a NEW 3-lot short for the remainder — with `held` very much
   * defined, so the operator was told nothing while a short the supervisor now
   * manages appeared on the book.
   */
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(2 * LOT)] })

  await service().submit(manualReq({ side: 'Sell', lots: 5, reducesExposure: true }))

  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.qty, -3 * LOT, 'the long is gone and a 3-lot short is what remains')
  const events = store.docs('desk-order-events')
  assert.equal(events.length, 1, 'a leg nobody was told about is the invisible position again')
  const e = events[0] as Record<string, unknown>
  assert.equal(e['ok'], true)
  assert.equal(e['status'], 'BOOKED')
  // THE LEG'S quantity, not the FILL's: 5 lots were sold, 3 lots became a leg,
  // and announcing 5 would name a position the book does not hold.
  assert.match(String(e['error']), new RegExp(`qty ${-3 * LOT} @ 120`))
})

/**
 * F-27 on this path. `#maintainBook` reads the book, folds, and writes it back
 * with the routing round trip in between — the same lost-update window
 * `applyDecision` has, reached through the Build screen's Place instead of the
 * supervisor's POST.
 */
function otherLeg(): BridgeLeg {
  return {
    ...heldLeg(-LOT),
    deskTag: 'operator#1',
    instrument: { tradingsymbol: 'NIFTY26JUL24000PE', instrumentToken: 24_002, lotSize: LOT, tickSize: 0.05, exchange: 'NFO' },
    strike: 24_000,
    type: 'PE',
  }
}

test('a submit whose book write LOSES the race re-folds onto the fresh legs', async () => {
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(5 * LOT)], updatedAt: 10 })
  store.beforeSaveBook = (): void => {
    store.beforeSaveBook = null
    const b = store.books.get('BN_BREAKOUT:paper') as StoredBookLike
    store.books.set('BN_BREAKOUT:paper', { ...b, legs: [...b.legs, otherLeg()], updatedAt: 99 })
  }

  const res = await service().submit(req({ side: 'Sell', lots: 2, reducesExposure: true }))
  assert.equal(res.accepted, true)
  const legs = store.books.get('BN_BREAKOUT:paper')?.legs ?? []
  assert.equal(legs.length, 2)
  assert.equal(legs[0]?.qty, 3 * LOT, 'our close is applied to the winner’s book, not lost')
  assert.equal(legs[1]?.deskTag, 'operator#1', 'and the winner’s leg is not overwritten')
})

test('a lost race NEVER creates a leg the fresh book no longer holds', async () => {
  // REDUCES AND ADDS ONLY, on the retry too: if the winner already closed the
  // contract, our fold has nothing to reduce and must not invent a position.
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(5 * LOT)], updatedAt: 10 })
  store.beforeSaveBook = (): void => {
    store.beforeSaveBook = null
    const b = store.books.get('BN_BREAKOUT:paper') as StoredBookLike
    store.books.set('BN_BREAKOUT:paper', { ...b, legs: [], updatedAt: 99 })
  }

  await service().submit(req({ side: 'Sell', lots: 2, reducesExposure: true }))
  assert.deepEqual(store.books.get('BN_BREAKOUT:paper')?.legs, [])
})

test('a REFUSED submit leaves the book untouched — nothing routed', async () => {
  // The refusal here is the switch blocking a plain order. It used to be a
  // switched-off EXIT, which since the 2026-08-04 change routes on purpose —
  // the refusal had to move, the property under test did not.
  store.rows.set('BN_BREAKOUT', row({ modes: { paper: { enabled: false } } }))
  store.books.set('BN_BREAKOUT:paper', { symbol: 'NIFTY', expiry: EXPIRY, legs: [heldLeg(2 * LOT)] })
  const res = await service().submit(req({ side: 'Sell' }))
  assert.equal(res.accepted, false)
  assert.equal(store.books.get('BN_BREAKOUT:paper')?.legs.length, 1)
})

// -------------------------------------------- marketable pricing on /submit

/**
 * THE BROKER REJECTS MARKET ORDERS, and a submit that states no `orderType`
 * reached the gateway as one: `gateway.ts` maps anything that is not `'LIMIT'`
 * to `'MARKET'`. The decision path has been pricing its unpriced actions
 * through the mark since `904a900e`; `/v1/desk/submit` was
 * never given the same treatment, so every hosted strategy's and every signal
 * mirror's live order was a market order — a path that had never once been
 * exercised live.
 */
function pricedService(): SubmitService {
  return new SubmitService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    freeze: () => FREEZE,
    liveTags: new Set(),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
    marketable: { bufferPct: 0.02, minTicks: 2, tickSize: 0.05, expiryBufferPct: 0.1 },
  })
}

test('a submit that states no orderType routes as a MARKETABLE LIMIT, never MARKET', async () => {
  const res = await pricedService().submit(req({ lots: 1 }))
  assert.equal(res.accepted, true)
  const fill = paper.routed[0]?.fill
  // Mark 120, buy: 120 + max(2% x 120, 2 x 0.05) = 122.40, rounded UP a tick.
  assert.equal(fill?.orderType, 'LIMIT')
  assert.equal(fill?.limitPrice, 122.4)
})

test('a SELL prices BELOW the mark — the buffer is directional', async () => {
  const res = await pricedService().submit(req({ side: 'Sell', lots: 1 }))
  assert.equal(res.accepted, true)
  assert.equal(paper.routed[0]?.fill.limitPrice, 117.6)
})

test('an orderType the caller STATED is left exactly as it asked', async () => {
  await pricedService().submit(req({ lots: 1, orderType: 'LIMIT', limitPrice: 99.5 }))
  const fill = paper.routed[0]?.fill
  assert.equal(fill?.orderType, 'LIMIT')
  assert.equal(fill?.limitPrice, 99.5)
})

test('a RESTING order carries the flag onto the routed fill — the chaser reads it there', async () => {
  await pricedService().submit(req({ lots: 1, orderType: 'LIMIT', limitPrice: 99.5, resting: true }))
  const fill = paper.routed[0]?.fill
  assert.equal(fill?.orderType, 'LIMIT')
  assert.equal(fill?.limitPrice, 99.5)
  assert.equal(fill?.resting, true)
})

test('a non-resting order carries NO resting field — absent, not false', async () => {
  await pricedService().submit(req({ lots: 1, orderType: 'LIMIT', limitPrice: 99.5 }))
  const fill = paper.routed[0]?.fill
  assert.equal(fill !== undefined && 'resting' in fill, false)
})

test('with no marketable config the order is left MARKET — the historical behaviour', async () => {
  await service().submit(req({ lots: 1 }))
  assert.equal(paper.routed[0]?.fill.orderType, undefined)
})

test('the price the SUBMISSION RECORD claims is the price that routed', async () => {
  await pricedService().submit(req({ lots: 1 }))
  const claim = store.docs(SUBMISSIONS)[0]
  assert.equal(claim?.['orderType'], 'LIMIT')
  assert.equal(claim?.['limitPrice'], 122.4)
})

/**
 * EXPIRY-DAY tape moves through the 2% buffer before the order rests a
 * heartbeat: a sell priced 2% under the mark sat unfilled while the market
 * fell through it, and an unfilled exit on a dying weekly is the position
 * pinned to settlement. On the day the RESOLVED contract expires (IST, per
 * the master's own row) the submit path pays the wider expiry buffer — and
 * ONLY then: the day before, and any contract whose expiry the master cannot
 * vouch for, stay on the base buffer.
 */
test('a contract EXPIRING TODAY prices with the WIDER expiry buffer', async () => {
  // 10:30 IST on the fixture chain's expiry day.
  nowMs = Date.parse(`${EXPIRY}T05:00:00.000Z`)
  const res = await pricedService().submit(req({ side: 'Sell', lots: 1 }))
  assert.equal(res.accepted, true)
  const fill = paper.routed[0]?.fill
  // Mark 120, sell on expiry day: 120 - max(10% x 120, 2 x 0.05) = 108.00.
  assert.equal(fill?.orderType, 'LIMIT')
  assert.equal(fill?.limitPrice, 108)
})

test('the SAME contract a day earlier keeps the base buffer', async () => {
  nowMs = Date.parse(`${EXPIRY}T05:00:00.000Z`) - 24 * 60 * 60 * 1000
  await pricedService().submit(req({ side: 'Sell', lots: 1 }))
  assert.equal(paper.routed[0]?.fill.limitPrice, 117.6)
})

test('a fallback instrument the master never synced keeps the base buffer on expiry day', async () => {
  // `expiryOf` answers null for a contract the dump does not carry, and null
  // never matches today — the wide buffer is paid on knowledge, not a guess.
  nowMs = Date.parse(`${EXPIRY}T05:00:00.000Z`)
  const res = await pricedService().submit(
    req({
      lots: 1,
      instrument: { tradingsymbol: 'NIFTY26SEP25000CE', lotSize: LOT, exchange: 'NFO' },
      referencePrice: 120,
    }),
  )
  assert.equal(res.accepted, true)
  assert.equal(paper.routed[0]?.fill.limitPrice, 122.4)
})

test('DX: "expires today" is the settlement day — 14:00 UTC the day before is inside it', async () => {
  const { DX } = await import('@algomaker/venue')
  // 14:00 UTC on the eve: past the previous 12:00 UTC settlement, so on DX the
  // contract settles at the NEXT 12:00 UTC — today, by the venue's day.
  nowMs = Date.parse(`${EXPIRY}T14:00:00.000Z`) - 24 * 60 * 60 * 1000
  const dx = new SubmitService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    freeze: () => FREEZE,
    liveTags: new Set(),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
    marketable: { bufferPct: 0.02, minTicks: 2, tickSize: 0.05, expiryBufferPct: 0.1 },
    venue: DX,
  })
  await dx.submit(req({ side: 'Sell', lots: 1 }))
  assert.equal(paper.routed[0]?.fill.limitPrice, 108)
})

test('DX: after the 12:00 UTC instant the contract no longer "expires today"', async () => {
  const { DX } = await import('@algomaker/venue')
  nowMs = Date.parse(`${EXPIRY}T12:00:00.000Z`)
  const dx = new SubmitService({
    store,
    rails: { paper, live },
    master: { current: master },
    marks: MARKS,
    freeze: () => FREEZE,
    liveTags: new Set(),
    orderCollections: ORDER_COLLECTIONS,
    now: () => nowMs,
    log: (msg, ctx) => logs.push(ctx === undefined ? { msg } : { msg, ctx }),
    marketable: { bufferPct: 0.02, minTicks: 2, tickSize: 0.05, expiryBufferPct: 0.1 },
    venue: DX,
  })
  await dx.submit(req({ side: 'Sell', lots: 1 }))
  assert.equal(paper.routed[0]?.fill.limitPrice, 117.6)
})
