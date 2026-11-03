/**
 * THE BRAIN-TO-WIRE ADAPTER — every way "decide once, route once" goes wrong.
 *
 * `decide()` is pure and already proven against 1,152 Python marks. Everything
 * this suite is about happens AROUND it, in the layer that turns a decision into
 * an order exactly once and then folds what came back:
 *
 *   1. **DAMPING.** The engine evaluates on every tick, so a trigger that flares
 *      for one tick and vanishes would route a real package on a quote that was
 *      never there. `confirm_ms` is what makes an order-producing trigger prove
 *      it persists — and `cooldown_s` is what stops a book re-deciding into its
 *      own working orders (spec §7, D4).
 *
 *   2. **EXACTLY-ONCE ROUTING.** State is saved BEFORE the post, so a process
 *      that dies in between comes back holding the id and replays it; desk-api's
 *      unique index answers the replay with the ORIGINAL outcome. Saving after
 *      the post is the shape that doubles a live short package.
 *
 *   3. **THE THREE OUTCOMES.** REFUSED (4xx) is final and its rule-state delta
 *      is rolled back; INDETERMINATE keeps the id; DONE folds at the FILL'S OWN
 *      price. A FAILED id replays FAILED forever, so the next intent must be a
 *      NEW decisionId — re-posting the failed one is a book that stops trading.
 *
 *   4. **`rcStack`.** The engine READS it for the LIFO unwind and never writes
 *      it: the host is the only thing that knows a sale actually filled. A host
 *      that forgets leaves the unwind buying back the entry book first — the
 *      ASHOKLEY failure — and no parity fixture can catch it, because parity
 *      never routes an order.
 *
 * No Mongo, no network, no wall clock: the store is an in-memory `StateCollection`
 * behind the REAL `StateStore` (so the CAS and the hydration are exercised), the
 * client is a scripted fake, and `now()` is a variable this file moves by hand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  type ChainSnap,
  type DecisionRequest,
  type DecisionResponse,
  type Dials,
  type LegPosition,
  type MarginInput,
  type OptType,
  type Quote,
  type StrikeQuote,
  type WireFill,
} from '@algomaker/desk-engine'
import {
  EngineHost,
  MarkClock,
  type CancelOutcome,
  type HostLog,
  type MarkSample,
} from '../src/engine-host.ts'
import {
  REALIZED_BASIS_KEPT,
  StateStore,
  stateKey,
  type StateCollection,
  type SupervisorBookState,
} from '../src/state-store.ts'
import { DX, type VenueSpec } from '@algomaker/venue'

// ────────────────────────────────────────────────────────────── the market

/** 2026-08-21 (a Friday) 10:00 IST — a real session, well inside the gates. */
const T0 = Date.UTC(2026, 7, 21, 4, 30)
const EXPIRY = '2026-08-28'
const SPOT = 300
const LOT = 25
const TAG = 'TEST'

const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * 10)
const q = (bid: number, ask: number, asOf = T0): Quote => ({ bid, ask, ltp: null, asOf })

/**
 * A crude but SOLVABLE surface: intrinsic plus two rupees of time value, floored
 * at 0.50. Every strike therefore implies a volatility (a quote at or under
 * discounted intrinsic does not), which is what keeps `hasGreeks` true and the
 * corridor arithmetic live.
 */
const theo = (strike: number, optType: OptType): number =>
  Math.max(0.5, (optType === 'CE' ? SPOT - strike : strike - SPOT) + 2)

const wing = (strike: number, optType: OptType): Quote => {
  const p = theo(strike, optType)
  return q(Number((p * 0.98).toFixed(2)), Number((p * 1.02).toFixed(2)))
}

/** `spent` prices one wing at a paise, which is what the scrap tier acts on. */
function chainOf(spent: { strike: number; optType: OptType } | null = null): ChainSnap {
  return {
    symbol: TAG,
    expiry: EXPIRY,
    step: 10,
    lotSize: LOT,
    future: q(SPOT - 0.5, SPOT + 0.5),
    spot: SPOT,
    strikes: LADDER.map((k): StrikeQuote => {
      const ce = spent !== null && spent.strike === k && spent.optType === 'CE' ? q(0.05, 0.1) : wing(k, 'CE')
      const pe = spent !== null && spent.strike === k && spent.optType === 'PE' ? q(0.05, 0.1) : wing(k, 'PE')
      return { strike: k, ce, pe }
    }),
    asOf: T0,
  }
}

const instrumentOf = (strike: number, optType: OptType): string =>
  `TEST26AUG${String(strike)}${optType}`

function legOf(over: Partial<LegPosition> = {}): LegPosition {
  const strike = over.strike ?? 360
  const optType = over.optType ?? 'PE'
  return {
    instrument: over.instrument ?? instrumentOf(strike, optType),
    strike,
    optType,
    side: 'Sell',
    lots: 4,
    lotSize: LOT,
    entry: 60,
    openedByEngine: false,
    // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
    leanId: '',
    ...over,
  }
}

/**
 * The three fixture books, each pinned by `engine.test.ts`'s own shapes:
 *
 *   `SHED`  — one deep-ITM short PE: netΔ +89 against an allowance of 3, which
 *             sells 54 lots of the 330 CE. Excess is 86, far past a lot
 *             equivalent, so it is also the OBVIOUS-BREACH fixture.
 *   `SPENT` — a short quoted at 5 paise: the scrap tier closes it, and because
 *             scrap is not a guard it is the DAMPED fixture.
 *   `RICH`  — the same short, sold higher, so the book is +676 and the target
 *             lock fires: the GUARD fixture.
 */
const shedBook = (): LegPosition[] => [legOf()]
const spentBook = (): LegPosition[] => [
  legOf({ strike: 400, optType: 'CE', lots: 2, entry: 3, openedByEngine: true }),
]
const richBook = (): LegPosition[] => [legOf({ entry: 70 })]

const SHED_INSTRUMENT = instrumentOf(330, 'CE')
const SPENT_INSTRUMENT = instrumentOf(400, 'CE')
const SHORT_INSTRUMENT = instrumentOf(360, 'PE')

// ─────────────────────────────────────────────────────────────── the fakes

/**
 * `desk-supervisor-state`, in memory, with the two behaviours the CAS is built
 * on: a filter on `updatedAt` matches nothing when someone else has written,
 * and the upsert that follows collides with the unique key on `key`.
 */
class FakeStateCollection implements StateCollection {
  readonly docs = new Map<string, Record<string, unknown>>()
  indexes = 0

  async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const doc = this.docs.get(String(filter['key']))
    if (doc === undefined) return null
    if (filter['updatedAt'] !== undefined && doc['updatedAt'] !== filter['updatedAt']) return null
    return { ...doc }
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const key = String(filter['key'])
    const doc = this.docs.get(key)
    const set = (update['$set'] ?? {}) as Record<string, unknown>
    if (doc !== undefined && doc['updatedAt'] === filter['updatedAt']) {
      this.docs.set(key, { ...doc, ...structuredClone(set) })
      return null
    }
    if (options?.['upsert'] !== true) return null
    if (doc !== undefined) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
    this.docs.set(key, structuredClone(set))
    return null
  }

  async createIndex(): Promise<unknown> {
    this.indexes += 1
    return null
  }
}

/** Scripted desk-api. Every request is recorded; answers are queued. */
class FakeClient {
  readonly requests: DecisionRequest[] = []
  #answers: Array<DecisionResponse | 'INDETERMINATE' | Error> = []
  /** The standing answer once the queue is empty. */
  fallback: ((req: DecisionRequest) => DecisionResponse | 'INDETERMINATE' | Error) | null = null

  queue(...answers: Array<DecisionResponse | 'INDETERMINATE' | Error>): void {
    this.#answers.push(...answers)
  }

  async submit(req: DecisionRequest): Promise<DecisionResponse | 'INDETERMINATE'> {
    this.requests.push(structuredClone(req))
    const next = this.#answers.shift() ?? this.fallback?.(req) ?? done(req.decisionId)
    if (next instanceof Error) throw next
    return next
  }
}

const done = (decisionId: string, fills: WireFill[] = []): DecisionResponse => ({
  decisionId,
  replayed: false,
  status: 'DONE',
  fills,
  skips: [],
  routeErrors: [],
})

const working = (decisionId: string, fills: WireFill[] = []): DecisionResponse => ({
  decisionId,
  replayed: false,
  status: 'WORKING',
  fills,
  skips: [],
  routeErrors: [],
})

const failed = (decisionId: string, routeErrors: string[]): DecisionResponse => ({
  decisionId,
  replayed: false,
  status: 'FAILED',
  fills: [],
  skips: [],
  routeErrors,
})

interface Line {
  readonly level: string
  readonly msg: string
  readonly ctx: Record<string, unknown>
}

function fakeLog(): { log: HostLog; lines: Line[] } {
  const lines: Line[] = []
  const at =
    (level: string) =>
    (msg: string, ctx: Record<string, unknown> = {}): void => {
      lines.push({ level, msg, ctx })
    }
  return { lines, log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } }
}

// ───────────────────────────────────────────────────────────── the harness

interface Harness {
  readonly host: EngineHost
  readonly client: FakeClient
  readonly store: StateStore
  readonly collection: FakeStateCollection
  readonly lines: Line[]
  book: LegPosition[]
  dials: Dials
  chain: ChainSnap | null
  margin: MarginInput
  now: number
  /** Every mark the host handed the journal, in order. */
  readonly marks: MarkSample[]
  /** Every decisionId the host swept — one entry per sweep. */
  readonly cancels: string[]
  /** Every broker id a sweep actually filed a cancel for, in order. */
  readonly filed: string[]
  /** Set to make the next cancel throw — a sweep where NOTHING got through. */
  cancelFails: Error | null
  /**
   * Working orders whose cancel the sweep could NOT file — a PARTIAL sweep.
   * They are the first `cancelFailures` of the ids `b0, b1, …`.
   */
  cancelFailures: number
  /** Working orders whose cancel CAN be filed. 0 = nothing was working any more. */
  cancelRequests: number
  /** A deployment with NO cancel path wired — ticket 14's shipped behaviour. */
  noCancel: boolean
  /** What the master says this contract's tick is. `null` = it does not say. */
  tick: number | null
  state(): Promise<SupervisorBookState>
  seed(patch: Partial<SupervisorBookState>): Promise<void>
}

/** This file's cancel re-ask window: longer than the 5-minute marks it steps by. */
const REASK_MS = 30 * 60_000

const dialsOf = (over: Partial<Dials> = {}): Dials => ({
  ...DEFAULT_DIALS,
  shift_enabled: false,
  // `DEFAULT_DIALS` carries the ₹10cr relief-r cap; a fixture book this small
  // never comes near it, and 0 keeps the margin projection out of the way of
  // every test that is not about it.
  margin_cap: 0,
  ...over,
})

/**
 * One book's host over one book's fakes. The returned object is what the test
 * MUTATES — `book`, `chain`, `dials`, `margin`, `now` — and the host reads every
 * one of them through a closure, so a test moves the market and the clock by
 * assignment and then calls `evaluate()`.
 */
/**
 * The same rig on the LIVE rail.
 *
 * Only the operator-facing claims differ by rail (what will come back for a
 * resting maker quote), so this exists for those and nothing else — every rule
 * under test is rail-agnostic and is exercised on paper.
 */
function makeLive(
  over: Partial<Pick<Harness, 'book' | 'dials' | 'chain' | 'margin' | 'noCancel'>> = {},
): Harness {
  return make({ ...over }, 'live')
}

function make(
  over: Partial<Pick<Harness, 'book' | 'dials' | 'chain' | 'margin' | 'noCancel'>> & {
    readonly venue?: VenueSpec
  } = {},
  mode: 'paper' | 'live' = 'paper',
): Harness {
  const collection = new FakeStateCollection()
  const store = new StateStore(collection)
  const client = new FakeClient()
  const { log, lines } = fakeLog()
  const h = {
    client,
    store,
    collection,
    lines,
    book: over.book ?? shedBook(),
    dials: over.dials ?? dialsOf(),
    chain: over.chain === undefined ? chainOf() : over.chain,
    margin: over.margin ?? ({ value: 0, source: 'broker', asOf: T0, fresh: true } as MarginInput),
    now: T0,
    marks: [] as MarkSample[],
    cancels: [] as string[],
    filed: [] as string[],
    cancelFails: null,
    cancelFailures: 0,
    cancelRequests: 2,
    noCancel: over.noCancel === true,
    tick: null,
    state: async (): Promise<SupervisorBookState> => await store.load(TAG, mode),
    seed: async (patch: Partial<SupervisorBookState>): Promise<void> => {
      const prev = await store.load(TAG, mode)
      await store.save(prev, { ...prev, ...patch, updatedAt: prev.updatedAt + 1 })
    },
  } as Harness
  const host = new EngineHost({
    tag: TAG,
    mode,
    dials: () => h.dials,
    snap: () => h.chain,
    readBook: async () => h.book,
    margin: () => h.margin,
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store,
    client,
    now: () => h.now,
    log,
    onMark: (sample) => h.marks.push(sample),
    tickSizeFor: () => h.tick,
    ...(over.venue === undefined ? {} : { venue: over.venue }),
    /**
     * The cancel port. Present unless a test asks for the deployment that has
     * none, so "a guard preempts a working package" is the DEFAULT behaviour
     * under test and the un-wired case is the exception it used to be.
     */
    ...(over.noCancel === true
      ? {}
      : {
          // A recenter guard re-fires on 5-minute MARKS, so the re-ask window is
          // stretched past one mark here; production uses CANCEL_REASK_MS.
          cancelReaskMs: REASK_MS,
          // The real sweep's contract (`working-orders.ts`): files a cancel only
          // for a working id the host did not say to skip, and reports which.
          cancelWorking: async (
            decisionId: string,
            skip: ReadonlySet<string>,
          ): Promise<CancelOutcome> => {
            if (h.cancelFails !== null) throw h.cancelFails
            h.cancels.push(decisionId)
            const ids = Array.from(
              { length: h.cancelFailures + h.cancelRequests },
              (_, i) => `b${String(i)}`,
            ).filter((id) => !skip.has(id))
            const refused = (id: string): boolean => Number(id.slice(1)) < h.cancelFailures
            const asked = ids.filter((id) => !refused(id))
            h.filed.push(...asked)
            return { requested: asked.length, failed: ids.length - asked.length, asked }
          },
        }),
  })
  return Object.assign(h, { host })
}

// ─────────────────────────────────────────────────── 1. damping (spec §7)

test('a trigger that flares and vanishes inside confirm_ms routes NOTHING', async () => {
  // The whole reason damping exists: the engine sees every tick, and a book that
  // acted on the first one would route a real package off a quote that was gone
  // a second later.
  const h = make({ book: spentBook(), chain: chainOf({ strike: 400, optType: 'CE' }) })

  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'the first sighting only ARMS the intent')
  assert.equal(h.host.armedIntent?.trigger, 'scrap')

  // The paise quote comes back to life two seconds later: the condition is gone.
  h.now += 2_000
  h.chain = chainOf()
  await h.host.evaluate()

  assert.equal(h.client.requests.length, 0)
  assert.equal(h.host.armedIntent, null, 'a decision that no longer wants to act disarms')
  assert.equal((await h.state()).seq, 0, 'no decisionId was ever minted')
})

test('the same trigger past confirm_ms routes ONCE, and cooldown_s suppresses the next', async () => {
  const h = make({
    book: spentBook(),
    chain: chainOf({ strike: 400, optType: 'CE' }),
    dials: dialsOf({ confirm_ms: 5_000, cooldown_s: 30 }),
  })

  await h.host.evaluate() // arms
  h.now += 4_999
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, '4,999 ms is not 5,000')

  h.now += 1
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1)
  const req = h.client.requests[0]
  assert.ok(req !== undefined)
  assert.equal(req.decisionId, `${TAG}:paper:1`)
  assert.equal(req.trigger, 'scrap')
  // `workMode: 'passive'` is STATED now rather than left absent. desk-api's
  // engine endpoint has always read an absent work mode as passive-first
  // (`routes/engine.ts`: `a.workMode ?? 'passive'`), so this is the same order —
  // it is the engine, not the host, that now says so (`types.ts`'s `urgency`).
  assert.deepEqual(req.actions, [
    { op: 'close', instrument: SPENT_INSTRUMENT, workMode: 'passive' },
  ])

  const spent: unknown = h.host.armedIntent
  assert.equal(spent, null, 'a routed intent is spent — the next one re-proves itself')

  // The book has not changed (nothing filled), so the scrap tier still wants the
  // leg — and the cooldown is the only thing stopping a second package.
  h.now += 10_000
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'inside cooldown_s, nothing goes out')
  assert.equal(h.host.armedIntent?.trigger, 'scrap', 'but the intent arms while it waits')

  h.now += 20_001
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2, 'past cooldown, the re-proved intent routes again')
  assert.equal(h.client.requests[1]?.decisionId, `${TAG}:paper:2`)
})

test('a breach past one lot-equivalent does not wait — but a marginal one does', async () => {
  // Spec §7: phase R may act at once when it exceeds the band by ≥ 1 full
  // lot-equivalent. The fixture's excess is 86 shares of delta against a
  // ~1.6-share lot equivalent, which is not a flicker to be damped.
  const h = make({ dials: dialsOf({ confirm_ms: 60_000 }) })
  await h.host.evaluate()

  assert.equal(h.client.requests.length, 1, 'an obvious breach routes on the first sighting')
  const req = h.client.requests[0]
  assert.ok(req !== undefined)
  assert.equal(req.trigger, 'shed')
  assert.deepEqual(req.actions, [
    { op: 'open', instrument: SHED_INSTRUMENT, side: 'Sell', qty: 54 * LOT, add: true, workMode: 'passive' },
  ])

  // The scrap tier's close carries no band excess at all, so it is damped.
  const damped = make({
    book: spentBook(),
    chain: chainOf({ strike: 400, optType: 'CE' }),
    dials: dialsOf({ confirm_ms: 60_000 }),
  })
  await damped.host.evaluate()
  assert.equal(damped.client.requests.length, 0)
})

test('a guard trigger routes with ZERO damping, and preempts an armed playbook intent', async () => {
  const h = make({
    book: spentBook(),
    chain: chainOf({ strike: 400, optType: 'CE' }),
    dials: dialsOf({ confirm_ms: 60_000, cooldown_s: 600 }),
  })
  await h.host.evaluate()
  assert.equal(h.host.armedIntent?.trigger, 'scrap')
  assert.equal(h.client.requests.length, 0)

  // The book turns into the locked one under it. The lock is the desk's one
  // hard rule: it does not wait a minute to prove it means it, and it does not
  // queue behind the scrap intent the previous tick armed. (The streak is
  // MARK-anchored, so the next mark is when it can arm at all — `guards.ts` §2.)
  h.book = richBook()
  h.chain = chainOf()
  h.dials = dialsOf({ confirm_ms: 60_000, cooldown_s: 600, target_pnl: 500, target_confirm_marks: 1 })
  h.now += 5 * 60_000
  await h.host.evaluate()

  assert.equal(h.client.requests.length, 1)
  const req = h.client.requests[0]
  assert.ok(req !== undefined)
  assert.equal(req.trigger, 'lock')
  // Guard exits are URGENT at the gateway (spec §8); a playbook action carries
  // no work mode at all, which desk-api reads as passive-first.
  assert.deepEqual(req.actions, [
    { op: 'close', instrument: SHORT_INSTRUMENT, workMode: 'urgent' },
  ])
  assert.equal(h.host.armedIntent, null, 'the armed scrap intent is gone, not queued')
  assert.equal((await h.state()).ruleState.targetLocked, true)
})

test('a guard trigger ignores the cooldown a routed decision just set', async () => {
  const h = make({ dials: dialsOf({ cooldown_s: 600 }) })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'the shed routes')

  h.book = richBook()
  h.dials = dialsOf({ cooldown_s: 600, target_pnl: 500, target_confirm_marks: 1 })
  h.now += 5 * 60_000 // the next mark: the lock's streak is mark-anchored
  await h.host.evaluate()

  assert.equal(h.client.requests.length, 2)
  assert.equal(h.client.requests[1]?.trigger, 'lock')
})

// ──────────────────────────────────────── 2. exactly-once routing (spec §7)

test('the state is saved BEFORE the post — the crash window leaves an id to replay', async () => {
  const h = make()
  let seenAtPost: SupervisorBookState | null = null
  h.client.fallback = (req): DecisionResponse => {
    // Read the DOCUMENT, not the host's memory: this is what a process that
    // died one line later would come back to.
    void req
    return done(req.decisionId)
  }
  const store = h.store
  const original = h.client.submit.bind(h.client)
  h.client.submit = async (req): Promise<DecisionResponse | 'INDETERMINATE'> => {
    seenAtPost = await store.load(TAG, 'paper')
    return await original(req)
  }

  await h.host.evaluate()

  assert.ok(seenAtPost !== null)
  const at = seenAtPost as SupervisorBookState
  assert.equal(at.inFlight, `${TAG}:paper:1`, 'the id is durable before the order exists')
  assert.equal(at.seq, 1)
  assert.equal(at.workingPackage?.decisionId, `${TAG}:paper:1`)
  assert.equal(at.workingPackage?.request?.trigger, 'shed')
})

test('a crash between the save and the post: boot replays the SAME id and folds one fill', async () => {
  const h = make()
  // The state a killed process left behind, written by the save above.
  h.client.fallback = (req): DecisionResponse => done(req.decisionId)
  h.client.submit = async (req): Promise<DecisionResponse | 'INDETERMINATE'> => {
    h.client.requests.push(structuredClone(req))
    throw new Error('the process died here')
  }
  await assert.rejects(async () => await h.host.evaluate())

  const crashed = await h.state()
  assert.equal(crashed.inFlight, `${TAG}:paper:1`)

  // A fresh host over the same document — a supervisor that just booted.
  const rebooted = make()
  rebooted.collection.docs.set(stateKey(TAG, 'paper'), {
    ...(h.collection.docs.get(stateKey(TAG, 'paper')) as Record<string, unknown>),
  })
  const fill: WireFill = { instrument: SHED_INSTRUMENT, side: 'Sell', qty: 54 * LOT, price: 0.6 }
  rebooted.client.queue({ ...done(`${TAG}:paper:1`, [fill]), replayed: true })

  await rebooted.host.resolveInFlightOnBoot()

  assert.equal(rebooted.client.requests.length, 1)
  assert.equal(rebooted.client.requests[0]?.decisionId, `${TAG}:paper:1`, 'verbatim, same id')
  assert.deepEqual(
    rebooted.client.requests[0]?.actions,
    [{ op: 'open', instrument: SHED_INSTRUMENT, side: 'Sell', qty: 54 * LOT, add: true, workMode: 'passive' }],
    'and the same actions — the crash may have been BEFORE the post landed',
  )
  const after = await rebooted.state()
  assert.equal(after.inFlight, null)
  assert.equal(after.workingPackage, null)
  assert.deepEqual(after.ruleState.rcStack, [{ strike: 330, optType: 'CE', lots: 54 }])

  // A second boot resolve must not fold the same fill again.
  await rebooted.host.resolveInFlightOnBoot()
  assert.equal(rebooted.client.requests.length, 1, 'nothing left in flight to replay')
  assert.deepEqual((await rebooted.state()).ruleState.rcStack, [
    { strike: 330, optType: 'CE', lots: 54 },
  ])
})

test('ONE in flight: a working package forms no second decision', async () => {
  const h = make({ dials: dialsOf({ cooldown_s: 0, confirm_ms: 0 }) })
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1)
  assert.equal((await h.state()).inFlight, `${TAG}:paper:1`)

  // Ten more ticks with the book still breaching the band. An evaluation under
  // a working package EVALUATES — the mark has to count — but posts nothing:
  // the 1 s poll is the single poller, and a second re-post per tick would put
  // two requests on the wire for one decision, each racing the other's fold.
  h.client.fallback = (req): DecisionResponse => working(req.decisionId)
  for (let i = 0; i < 10; i++) {
    h.now += 1_000
    await h.host.evaluate()
  }
  assert.equal(h.client.requests.length, 1, 'ten ticks, no second decision and no second post')

  // The poller asks, and always under the SAME id.
  for (let i = 0; i < 3; i++) {
    h.now += 1_000
    await h.host.pollInFlight()
  }
  const ids = new Set(h.client.requests.map((r) => r.decisionId))
  assert.deepEqual([...ids], [`${TAG}:paper:1`], 'every post is the SAME id — a poll, not a package')
  assert.equal((await h.state()).seq, 1)
})

test('a lost CAS posts NOTHING — the winner may have routed orders this one cannot see', async () => {
  const h = make()
  const collection = h.collection
  const realUpdate = collection.findOneAndUpdate.bind(collection)
  collection.findOneAndUpdate = async (filter, update, options): Promise<unknown> => {
    // Somebody else wrote between this host's read and its save.
    collection.docs.set(stateKey(TAG, 'paper'), {
      key: stateKey(TAG, 'paper'),
      updatedAt: 999_999_999_999,
      seq: 4,
    })
    collection.findOneAndUpdate = realUpdate
    return await realUpdate(filter, update, options)
  }

  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'no save, no post')
  assert.ok(h.lines.some((l) => l.level === 'warn' && /wrote/i.test(l.msg)))
})

// ────────────────────────────────────────────────── 3. the three outcomes

test('REFUSED rolls the rule-state delta back, keeps the burnt seq, and does not retry', async () => {
  // The scrap tier BANS the strike in `stateAfter` — a delta that must not
  // survive a package desk-api never claimed, or the book would refuse to
  // re-sell a strike over an order that never existed.
  const h = make({
    book: spentBook(),
    chain: chainOf({ strike: 400, optType: 'CE' }),
    dials: dialsOf({ confirm_ms: 0 }),
  })
  const { RefusedError } = await import('../src/decisions-client.ts')
  h.client.queue(new RefusedError(400, "actions name 'TEST26AUG400CE' more than once"))

  await h.host.evaluate()

  assert.equal(h.client.requests.length, 1, 'a refusal is final — no retry')
  const after = await h.state()
  assert.deepEqual(after.ruleState.scrapBanned, [], 'the ban is rolled back')
  assert.equal(after.inFlight, null)
  assert.equal(after.workingPackage, null)
  assert.equal(after.seq, 1, 'the id is BURNT, never re-posted')
  assert.ok(h.lines.some((l) => l.level === 'error' && /refus/i.test(l.msg)))

  // The next intent gets a NEW id.
  h.now += 60_000
  await h.host.evaluate()
  assert.equal(h.client.requests[1]?.decisionId, `${TAG}:paper:2`)
})

test('INDETERMINATE keeps the id, replays it, and folds exactly once when it resolves', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  h.client.queue('INDETERMINATE')
  await h.host.evaluate()

  const held = await h.state()
  assert.equal(held.inFlight, `${TAG}:paper:1`)
  assert.equal(held.cumRealized, 0)

  const fill: WireFill = { instrument: SHED_INSTRUMENT, side: 'Sell', qty: 54 * LOT, price: 0.6 }
  h.client.queue('INDETERMINATE', { ...done(`${TAG}:paper:1`, [fill]), replayed: true })

  h.now += 1_000
  await h.host.pollInFlight()
  assert.equal((await h.state()).inFlight, `${TAG}:paper:1`, 'still unknown, still held')

  h.now += 1_000
  await h.host.pollInFlight()
  const after = await h.state()
  assert.equal(after.inFlight, null)
  assert.deepEqual(
    h.client.requests.map((r) => r.decisionId),
    [`${TAG}:paper:1`, `${TAG}:paper:1`, `${TAG}:paper:1`],
    'the same id every time — a replay cannot double-route',
  )
  assert.deepEqual(after.ruleState.rcStack, [{ strike: 330, optType: 'CE', lots: 54 }])
})

test('a FAILED decision is never re-posted — the next intent is a NEW id', async () => {
  // desk-api's `#replay` answers a FAILED id with FAILED forever. A host that
  // kept polling it would hold the book for the rest of the session.
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  h.client.queue(failed(`${TAG}:paper:1`, ['TEST26AUG330CE: allowlist refused']))
  await h.host.evaluate()

  const after = await h.state()
  assert.equal(after.inFlight, null, 'FAILED is terminal')
  assert.equal(after.workingPackage, null)
  assert.ok(h.lines.some((l) => l.level === 'error' && /allowlist refused/.test(JSON.stringify(l.ctx))))

  h.now += 1_000
  await h.host.evaluate()
  assert.equal(h.client.requests[1]?.decisionId, `${TAG}:paper:2`)
})

test('WORKING (paper) waits for the fill, and a nudge folds it AT THE FILL PRICE', async () => {
  // D14: an engine paper package books when the fill lands, not when it routes.
  const h = make({
    book: spentBook(),
    chain: chainOf({ strike: 400, optType: 'CE' }),
    dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }),
  })
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  assert.equal((await h.state()).cumRealized, 0, 'nothing is realised by an order')

  // The gateway fills the buy-back at 0.08 — NOT the 0.05 the decision was
  // taken at, and not the 0.10 ask it was marked at.
  h.client.queue({
    ...done(`${TAG}:paper:1`, [
      { instrument: SPENT_INSTRUMENT, side: 'Buy', qty: 2 * LOT, price: 0.08 },
    ]),
    replayed: true,
  })
  h.book = []
  h.host.onFillNudge()
  await h.host.drain()

  const after = await h.state()
  assert.equal(after.inFlight, null)
  // Short sold at 3, bought back at 0.08, 50 shares.
  assert.equal(after.cumRealized, (3 - 0.08) * 50)
  // AND NOT INTO `dlDayRealized`. `#settle` is shared by both decide paths,
  // but the field is the DELTA-LEAN day's bank and only `decideDeltaLean`'s
  // step 0 (`rollDay`) ever zeroes it — so an unconditional fold would have a
  // recenter tag accumulating a "day" figure for the life of the row.
  assert.equal(
    after.ruleState.dlDayRealized,
    0,
    'a recenter book banks into cumRealized only — dlDayRealized is the delta-lean day',
  )
})

test('a partial fill on a working package leaves the REMAINDER pending', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  h.client.queue(
    working(`${TAG}:paper:1`, [
      { instrument: SHED_INSTRUMENT, side: 'Sell', qty: 20 * LOT, price: 0.6 },
    ]),
  )
  await h.host.evaluate()

  const held = await h.state()
  assert.equal(held.inFlight, `${TAG}:paper:1`)
  assert.deepEqual(held.workingPackage?.remaining, [
    { op: 'open', instrument: SHED_INSTRUMENT, side: 'Sell', qty: 34 * LOT, add: true, workMode: 'passive' },
  ])
  assert.equal(held.cumRealized, 0, 'a partial is not folded — the decision is not terminal')

  // The engine is told the package is still working, in lots. desk-api's record
  // ACCUMULATES fills, so a replay reports the same 20 lots again — and the
  // remainder must never grow back.
  h.now += 1_000
  h.client.fallback = (req): DecisionResponse =>
    working(req.decisionId, [
      { instrument: SHED_INSTRUMENT, side: 'Sell', qty: 20 * LOT, price: 0.6 },
    ])
  await h.host.evaluate()
  assert.deepEqual((await h.state()).workingPackage?.remaining, [
    { op: 'open', instrument: SHED_INSTRUMENT, side: 'Sell', qty: 34 * LOT, add: true, workMode: 'passive' },
  ])
  assert.ok(
    h.lines.some((l) => /working package: 34 lots/.test(String(l.ctx['reason'] ?? ''))),
    'the engine holds new playbook actions while lots are owed',
  )
})

// ─────────────────────────────────────────────────────────── 4. `rcStack`

test('a filled sale is PUSHED onto rcStack, newest last, and a buy-back shrinks it', async () => {
  // The engine reads this stack for the LIFO unwind and never writes it. A host
  // that forgot would leave the unwind eating the ENTRY book first (ASHOKLEY,
  // 2026-08-03), and no parity fixture can catch it.
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  h.client.queue(
    done(`${TAG}:paper:1`, [
      { instrument: SHED_INSTRUMENT, side: 'Sell', qty: 54 * LOT, price: 0.6 },
    ]),
  )
  await h.host.evaluate()
  assert.deepEqual((await h.state()).ruleState.rcStack, [{ strike: 330, optType: 'CE', lots: 54 }])

  // A second sale, on another wing, sorts AFTER it — newest last. (The shift
  // re-centres the ITM 360 PE onto the 280 PE, which is a close and a sale in
  // one package.)
  const shed330 = legOf({ strike: 330, optType: 'CE', lots: 54, entry: 0.6, openedByEngine: true })
  h.book = [legOf(), shed330]
  h.dials = dialsOf({ confirm_ms: 0, cooldown_s: 0, shift_enabled: true, margin_cap: 1_000_000 })
  h.margin = { value: 700_000, source: 'broker', asOf: T0 + 60_000, fresh: true }
  h.now += 1_000
  h.client.queue(
    done(`${TAG}:paper:2`, [
      { instrument: SHORT_INSTRUMENT, side: 'Buy', qty: 4 * LOT, price: 55 },
      { instrument: instrumentOf(280, 'PE'), side: 'Sell', qty: 4 * LOT, price: 0.5 },
    ]),
  )
  await h.host.evaluate()
  assert.equal(h.client.requests[1]?.trigger, 'shift')
  assert.deepEqual((await h.state()).ruleState.rcStack, [
    { strike: 330, optType: 'CE', lots: 54 },
    { strike: 280, optType: 'PE', lots: 4 },
  ])

  // Now buy half the 330 back — a scrap close whose fill covers 24 of its 54
  // lots. The entry SHRINKS rather than disappearing.
  h.dials = dialsOf({ confirm_ms: 0, cooldown_s: 0 })
  h.chain = chainOf({ strike: 330, optType: 'CE' })
  h.book = [shed330, legOf({ strike: 280, optType: 'PE', lots: 4, entry: 0.5, openedByEngine: true })]
  h.now += 1_000
  h.client.queue(
    done(`${TAG}:paper:3`, [
      { instrument: SHED_INSTRUMENT, side: 'Buy', qty: 24 * LOT, price: 0.05 },
    ]),
  )
  await h.host.evaluate()
  assert.deepEqual((await h.state()).ruleState.rcStack, [
    { strike: 330, optType: 'CE', lots: 30 },
    { strike: 280, optType: 'PE', lots: 4 },
  ])

  // And the rest of it POPS the entry off entirely.
  h.now += 1_000
  h.client.queue(
    done(`${TAG}:paper:4`, [
      { instrument: SHED_INSTRUMENT, side: 'Buy', qty: 30 * LOT, price: 0.05 },
    ]),
  )
  await h.host.evaluate()
  assert.deepEqual((await h.state()).ruleState.rcStack, [{ strike: 280, optType: 'PE', lots: 4 }])
})

test('realised P&L folds at the fill price, and an OPEN realises nothing', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  h.client.queue(
    done(`${TAG}:paper:1`, [
      { instrument: SHED_INSTRUMENT, side: 'Sell', qty: 54 * LOT, price: 0.6 },
    ]),
  )
  await h.host.evaluate()
  assert.equal((await h.state()).cumRealized, 0, 'selling a fresh short banks nothing')

  h.chain = chainOf({ strike: 360, optType: 'PE' })
  h.now += 1_000
  h.client.queue(
    done(`${TAG}:paper:2`, [
      { instrument: SHORT_INSTRUMENT, side: 'Buy', qty: 4 * LOT, price: 55 },
    ]),
  )
  await h.host.evaluate()
  // Sold at 60, bought back at 55, 100 shares — measured off the leg's own
  // entry, at the price the broker actually gave.
  assert.equal((await h.state()).cumRealized, (60 - 55) * 100)
})

// ────────────────────────── 4b. the mark counts on a pass that routes nothing

test('a DAMPED pass still banks the mark: the lock disarms, the ban does not stick', async () => {
  // The failure this exists for: `decide` moved the target streak back to 0
  // because the book dipped under target on THIS mark, and the mark clock has
  // already been consumed — so a host that wrote nothing would keep a streak
  // that survives its own dips and counts NON-CONSECUTIVE marks. That is the
  // TCS 2026-06-19 defence (one 09:15 mark printed +17L on a book that was
  // really −21L) turned back off.
  const h = make({
    book: [legOf({ entry: 70 }), ...spentBook()],
    chain: chainOf({ strike: 400, optType: 'CE' }),
    dials: dialsOf({ confirm_ms: 60_000, target_pnl: 500, target_confirm_marks: 3 }),
  })

  // Mark 1: over target — the guard counts one and holds the whole pass.
  await h.host.evaluate()
  assert.equal((await h.state()).ruleState.targetStreak, 1)
  assert.equal(h.client.requests.length, 0)

  // Mark 2: the book dips under target, so the guard DISARMS and the pass falls
  // through to the scrap tier — which is damped and routes nothing.
  h.now = T0 + 5 * 60_000
  h.book = [legOf({ entry: 60 }), ...spentBook()]
  await h.host.evaluate()

  const after = await h.state()
  assert.equal(h.client.requests.length, 0, 'nothing was routed on this mark')
  assert.equal(after.ruleState.targetStreak, 0, 'the DISARM survived a pass that routed nothing')
  assert.deepEqual(
    after.ruleState.scrapBanned,
    [],
    'the ACTING delta does not stick: a strike is banned by a buy-back that happened',
  )
})

test('a REFUSED lock flatten does NOT latch the lock — and re-fires next mark', async () => {
  // The worst shape on this axis, and the one the round-1 fix walked into:
  // `targetLocked` is TERMINAL (`guards.ts` never un-sets it — a banked run does
  // not redeploy), so persisting it for a flatten that desk-api refused holds
  // the book forever with its legs still open and every guard silenced. Risk
  // management off, quietly, on a book that is in profit and cannot bank.
  const { RefusedError } = await import('../src/decisions-client.ts')

  // BOTH lock shapes latch, so both are checked: the confirmed streak and the
  // snap multiple, which banks immediately with no confirmation at all.
  for (const dials of [
    dialsOf({ confirm_ms: 0, cooldown_s: 0, target_pnl: 500, target_confirm_marks: 1 }),
    dialsOf({ confirm_ms: 0, cooldown_s: 0, target_pnl: 500, target_snap_multiple: 1 }),
  ]) {
    const snap = make({ book: richBook(), dials })
    snap.client.fallback = (): Error => new RefusedError(400, 'the kill switch is on')
    await snap.host.evaluate()
    const state = await snap.state()
    assert.equal(snap.client.requests.length, 1, 'the flatten went out and was refused')
    assert.equal(state.ruleState.targetLocked, false, 'a book that did not bank is not banked')
    assert.equal(state.inFlight, null)
  }

  const h = make({
    book: richBook(),
    dials: dialsOf({ confirm_ms: 0, cooldown_s: 0, target_pnl: 500, target_confirm_marks: 1 }),
  })
  h.client.fallback = (): Error => new RefusedError(400, 'the kill switch is on')

  await h.host.evaluate()

  const after = await h.state()
  assert.equal(after.ruleState.targetStreak, 1, 'but the mark that printed over target still counted')

  // The next mark re-fires it — which is the whole point of not latching.
  h.client.fallback = (req): DecisionResponse => done(req.decisionId)
  h.now = T0 + 5 * 60_000
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2)
  assert.equal(h.client.requests[1]?.trigger, 'lock')
  assert.equal((await h.state()).ruleState.targetLocked, true, 'the routed one DOES latch')
})

test('a mark damped by the cooldown still advances the anchor EMA', async () => {
  // `shed.ts` §1: the anchor and the EOD stamp "move on every mark, holds
  // included". A pass the supervisor declines to route is such a mark.
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 600, anchor_ema_marks: 3 }) })
  const fresh = await h.state()
  assert.equal(fresh.ruleState.gkAnchor, 0)
  await h.seed({ ruleState: { ...fresh.ruleState, lastActionMs: T0 - 1_000 } })

  await h.host.evaluate()

  const after = await h.state()
  assert.equal(h.client.requests.length, 0, 'the cooldown parked it')
  assert.equal(after.ruleState.gkAnchor, SPOT, 'the anchor is seeded at spot on the mark it saw')
  assert.equal(after.cumRealized, 0)
})

test('the fold stamps WHAT IT WAS MEASURED OFF, per rail', async () => {
  // `cumRealized` is one number and the two rails do not earn it the same way:
  // a paper fill is the gateway's own terminal fill, while a live decision is
  // booked optimistically at route time and nothing restates this number
  // afterwards. A true-up has to be able to find those rupees.
  const paper = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  paper.chain = chainOf({ strike: 360, optType: 'PE' })
  paper.client.queue(
    done(`${TAG}:paper:1`, [{ instrument: SHORT_INSTRUMENT, side: 'Buy', qty: 4 * LOT, price: 55 }]),
  )
  await paper.host.evaluate()
  assert.deepEqual(
    (await paper.state()).cumRealizedBasis.map((r) => [r.decisionId, r.basis, r.amount]),
    [[`${TAG}:paper:1`, 'fill', 500]],
  )

  // The same fold on the live rail.
  const store = new StateStore(new FakeStateCollection())
  const client = new FakeClient()
  const { log } = fakeLog()
  const live = new EngineHost({
    tag: TAG,
    mode: 'live',
    dials: () => dialsOf({ confirm_ms: 0, cooldown_s: 0 }),
    snap: () => chainOf({ strike: 360, optType: 'PE' }),
    readBook: async () => [legOf()],
    margin: () => ({ value: 0, source: 'broker', asOf: T0, fresh: true }),
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store,
    client,
    now: () => T0,
    log,
  })
  client.queue(
    done(`${TAG}:live:1`, [{ instrument: SHORT_INSTRUMENT, side: 'Buy', qty: 4 * LOT, price: 55 }]),
  )
  await live.evaluate()
  assert.deepEqual(
    (await store.load(TAG, 'live')).cumRealizedBasis.map((r) => [r.decisionId, r.basis]),
    [[`${TAG}:live:1`, 'optimistic-mark']],
  )
})

test('the provenance list is bounded, and it SAYS when it starts forgetting', async () => {
  // The eviction is the moment a true-up's job stops being complete: the oldest
  // fold is out of state and only the append-only journal still knows it.
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  const fresh = await h.state()
  await h.seed({
    cumRealizedBasis: Array.from({ length: REALIZED_BASIS_KEPT }, (_, i) => ({
      decisionId: `${TAG}:paper:${String(i + 1)}`,
      basis: 'fill' as const,
      amount: 1,
      at: T0 - 1,
    })),
    seq: REALIZED_BASIS_KEPT,
    ruleState: fresh.ruleState,
  })

  h.chain = chainOf({ strike: 360, optType: 'PE' })
  h.client.queue(
    done(`${TAG}:paper:${String(REALIZED_BASIS_KEPT + 1)}`, [
      { instrument: SHORT_INSTRUMENT, side: 'Buy', qty: 4 * LOT, price: 55 },
    ]),
  )
  await h.host.evaluate()

  const after = await h.state()
  assert.equal(after.cumRealizedBasis.length, REALIZED_BASIS_KEPT, 'bounded')
  assert.equal(after.cumRealizedBasis[0]?.decisionId, `${TAG}:paper:2`, 'oldest out first')
  assert.equal(
    after.cumRealizedBasis[REALIZED_BASIS_KEPT - 1]?.decisionId,
    `${TAG}:paper:${String(REALIZED_BASIS_KEPT + 1)}`,
  )
  const line = h.lines.find((l) => /provenance is FULL/.test(l.msg))
  assert.ok(line !== undefined, 'the eviction is not silent')
  assert.equal(line.level, 'warn')
  assert.equal(line.ctx['oldestEvicted'], `${TAG}:paper:1`)
})

// ──────────────────────────────────────── 5. the inputs the host assembles

test("the book's execution dials ride on the request", async () => {
  const h = make({
    dials: dialsOf({
      confirm_ms: 0,
      work_tranche_lots: 7,
      chase_max_ms: 12_000,
      chase_cross_buffer_pct: 0.002,
    }),
  })
  await h.host.evaluate()
  assert.deepEqual(h.client.requests[0]?.work, {
    trancheLots: 7,
    chaseMaxMs: 12_000,
    chaseCrossBufferPct: 0.002,
  })
})

test('a dial at its off-state is ABSENT from the wire, never zero', async () => {
  // `trancheLots: 0` tells the gateway to slice into nothing; absent means "use
  // your default". The two must not be spelled the same way.
  const h = make({
    dials: dialsOf({ confirm_ms: 0, work_tranche_lots: 0, chase_max_ms: 0, chase_cross_buffer_pct: 0 }),
  })
  await h.host.evaluate()
  assert.equal(h.client.requests[0]?.work, undefined)

  // And a hand-edited fraction is not half a tranche — it is a dial nobody can
  // trade. Truncated to 0, it must drop out rather than reach the door as a 0,
  // which desk-api refuses WITH THE WHOLE PACKAGE.
  const fractional = make({ dials: dialsOf({ confirm_ms: 0, work_tranche_lots: 0.5 }) })
  await fractional.host.evaluate()
  assert.equal(fractional.client.requests[0]?.work?.trancheLots, undefined)
})

test('the SHIFT is damped like everything else — phase S is not exempt', async () => {
  // D4/spec §7 spells this out: damping applies to every order-producing
  // trigger, "phase S and phase R alike". A shift moves real strikes.
  const h = make({
    dials: dialsOf({
      confirm_ms: 5_000,
      cooldown_s: 2,
      shift_enabled: true,
      margin_cap: 1_000_000,
    }),
    margin: { value: 700_000, source: 'broker', asOf: T0, fresh: true },
  })
  // This book acted a second ago, which parks the shed the first (unarmed)
  // margin read would otherwise route on the band breach alone.
  const fresh = await h.state()
  await h.seed({ ruleState: { ...fresh.ruleState, lastActionMs: T0 - 1_000 } })

  // Two margin reads to arm the shift's gate.
  await h.host.evaluate()
  h.now += 1_000
  h.margin = { value: 700_000, source: 'broker', asOf: T0 + 60_000, fresh: true }
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'the shift arms; it does not go out')
  assert.equal(h.host.armedIntent?.trigger, 'shift')

  h.now += 4_999
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0)

  h.now += 1
  await h.host.evaluate()
  assert.equal(h.client.requests[0]?.trigger, 'shift')
})

test('the shift arms only on TWO consecutive fresh broker margin reads', async () => {
  // Spec §7. One fresh read is a single sample of a number the broker refreshes
  // on its own clock; the shift moves real strikes on it.
  const h = make({
    dials: dialsOf({ confirm_ms: 0, cooldown_s: 0, shift_enabled: true, margin_cap: 1_000_000 }),
    margin: { value: 700_000, source: 'broker', asOf: T0, fresh: true },
  })
  await h.host.evaluate()
  assert.equal(h.client.requests[0]?.trigger, 'shed', 'one read is not enough to arm the shift')

  // The SAME read again is not a second read.
  h.now += 1_000
  await h.host.evaluate()
  assert.equal(h.client.requests[1]?.trigger, 'shed')

  // A genuinely new broker figure arms it.
  h.now += 1_000
  h.margin = { value: 700_000, source: 'broker', asOf: T0 + 60_000, fresh: true }
  await h.host.evaluate()
  assert.equal(h.client.requests[2]?.trigger, 'shift')

  // And it STAYS armed while the reads keep coming: a supervisor evaluating
  // every tick against a margin poller that refreshes every minute would
  // otherwise have exactly one armed tick per refresh.
  h.now += 1_000
  await h.host.evaluate()
  assert.equal(h.client.requests[3]?.trigger, 'shift')

  // A stale or modelled read disarms, and the count starts again.
  h.now += 1_000
  h.margin = { value: 700_000, source: 'model', asOf: T0 + 120_000, fresh: true }
  await h.host.evaluate()
  assert.equal(h.client.requests[4]?.trigger, 'shed')
  h.now += 1_000
  h.margin = { value: 700_000, source: 'broker', asOf: T0 + 180_000, fresh: true }
  await h.host.evaluate()
  assert.equal(h.client.requests[5]?.trigger, 'shed', 'one fresh read after a gap is still one')
})

test('protected lots come from supervisor state and the engine may not spend them', async () => {
  const h = make({
    book: spentBook(),
    chain: chainOf({ strike: 400, optType: 'CE' }),
    dials: dialsOf({ confirm_ms: 0 }),
  })
  await h.seed({ protectedQty: { [SPENT_INSTRUMENT]: 2 } })

  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'the operator owns both lots; the scrap tier sees none')
})

test('a repair hold stands the book down without touching the market', async () => {
  const collection = new FakeStateCollection()
  const store = new StateStore(collection)
  const client = new FakeClient()
  const { log, lines } = fakeLog()
  let held = true
  const host = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () => dialsOf({ confirm_ms: 0 }),
    snap: () => chainOf(),
    readBook: async () => shedBook(),
    margin: () => ({ value: 0, source: 'broker', asOf: T0, fresh: true }),
    instrumentFor: instrumentOf,
    repairHold: async () => held,
    store,
    client,
    now: () => T0,
    log,
  })

  await host.evaluate()
  assert.equal(client.requests.length, 0)
  assert.ok(lines.some((l) => /repair-Apply/.test(String(l.ctx['reason'] ?? ''))))

  held = false
  await host.evaluate()
  assert.equal(client.requests.length, 1)
})

test('a package that names one contract twice is dropped here, not at the door', async () => {
  // desk-api refuses it with a 400 and nothing written: two actions on one
  // contract collapse onto one leg tag, swapping their prices. Catching it here
  // spends no seq and no round trip — and names the contract in a log line.
  const store = new StateStore(new FakeStateCollection())
  const client = new FakeClient()
  const { log, lines } = fakeLog()
  let now = T0
  let margin: MarginInput = { value: 700_000, source: 'broker', asOf: T0, fresh: true }
  // The shift package is a close AND an open — and a master that answered the
  // held leg's symbol for every strike collapses the two onto one contract.
  const collide = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () =>
      dialsOf({ confirm_ms: 0, cooldown_s: 0, shift_enabled: true, margin_cap: 1_000_000 }),
    snap: () => chainOf(),
    readBook: async () => shedBook(),
    margin: () => margin,
    instrumentFor: () => SHORT_INSTRUMENT,
    repairHold: async () => false,
    store,
    client,
    now: () => now,
    log,
  })

  await collide.evaluate() // one margin read: a shed, which is one action
  now += 1_000
  margin = { value: 700_000, source: 'broker', asOf: T0 + 60_000, fresh: true }
  await collide.evaluate() // two reads: the shift, which is two

  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0]?.trigger, 'shed')
  assert.equal(
    (await store.load(TAG, 'paper')).seq,
    1,
    'no second decisionId is burnt on a package that never forms',
  )
  assert.ok(lines.some((l) => l.level === 'error' && /names one contract twice/.test(l.msg)))
})

test('no chain, no decision — a book with no market is not a book with a flat one', async () => {
  const h = make({ chain: null, dials: dialsOf({ confirm_ms: 0 }) })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0)
  assert.equal((await h.state()).seq, 0)
})

test('a new 5-minute mark is new exactly once, whatever the tick rate', async () => {
  // The target lock's confirmation streak counts MARKS, and ten tick
  // evaluations inside one 5-minute window must advance it once (spec §7 —
  // tick persistence is not an equivalent defence to the gap-open phantom).
  const h = make({
    book: richBook(),
    dials: dialsOf({ confirm_ms: 0, target_pnl: 500, target_confirm_marks: 3 }),
  })
  h.client.fallback = (req): DecisionResponse => done(req.decisionId)

  for (let i = 0; i < 10; i++) {
    h.now += 20_000 // 200 s in total: still inside 10:00-10:05
    await h.host.evaluate()
  }
  assert.equal((await h.state()).ruleState.targetStreak, 1, 'one mark, one advance')
  assert.equal(h.client.requests.length, 0)

  h.now = T0 + 5 * 60_000 // the 10:05 mark
  await h.host.evaluate()
  assert.equal((await h.state()).ruleState.targetStreak, 2)

  h.now = T0 + 10 * 60_000
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'the third consecutive mark banks it')
  assert.equal(h.client.requests[0]?.trigger, 'lock')
})

test('two passes that would BOTH route are serialised, not interleaved', async () => {
  // The sharper version of the test below: nothing here declines the second
  // pass, so both really do form a package. What must not happen is the two
  // reading one `seq` and posting under one id — which is a doubled live short
  // package, and the reason `evaluate()` is a queue rather than a function.
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  let inside = 0
  let overlapped = false
  const seen: string[] = []
  h.client.submit = async (req): Promise<DecisionResponse> => {
    h.client.requests.push(structuredClone(req))
    inside += 1
    if (inside > 1) overlapped = true
    // Every await inside the critical section is a chance for the other pass to
    // walk in: read the state, yield, and read it again.
    const before = await h.store.load(TAG, 'paper')
    await new Promise((resolve) => setImmediate(resolve))
    const after = await h.store.load(TAG, 'paper')
    if (before.seq !== after.seq || before.inFlight !== after.inFlight) overlapped = true
    seen.push(req.decisionId)
    inside -= 1
    return done(req.decisionId)
  }

  await Promise.all([h.host.evaluate(), h.host.evaluate()])

  assert.equal(overlapped, false, 'no pass saw the state move under it')
  assert.deepEqual(seen, [`${TAG}:paper:1`, `${TAG}:paper:2`], 'two packages, two ids, in order')
  assert.equal((await h.state()).seq, 2)
})

test('a tick storm cannot interleave two evaluations', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0, cooldown_s: 600 }) })
  let inFlightCalls = 0
  let overlapped = false
  h.client.submit = async (req): Promise<DecisionResponse> => {
    h.client.requests.push(structuredClone(req))
    inFlightCalls += 1
    if (inFlightCalls > 1) overlapped = true
    await new Promise((resolve) => setImmediate(resolve))
    inFlightCalls -= 1
    return done(req.decisionId)
  }

  await Promise.all([h.host.evaluate(), h.host.evaluate(), h.host.evaluate()])

  assert.equal(overlapped, false)
  assert.equal(h.client.requests.length, 1, 'the cooldown the first one set applies to the rest')
  assert.equal((await h.state()).seq, 1)
})

test('an evaluation that throws does not wedge the queue', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  h.client.submit = async (): Promise<DecisionResponse> => {
    throw new Error('mongo fell over')
  }
  await assert.rejects(async () => await h.host.evaluate())

  h.client.submit = async (req): Promise<DecisionResponse> => {
    h.client.requests.push(structuredClone(req))
    return done(req.decisionId)
  }
  h.now += 60_000
  // The poller resolves the id the dead pass left behind...
  await h.host.pollInFlight()
  // ...and the next evaluation, no longer holding one, decides afresh.
  await h.host.evaluate()
  assert.deepEqual(
    h.client.requests.map((r) => r.decisionId),
    [`${TAG}:paper:1`, `${TAG}:paper:2`],
  )
})

// ──────────────────── 4b. the stop that reaches the wire (spec §10, D6)

test('STOP MID-PASS: a package formed before the signal is NOT routed', async () => {
  /**
   * The window the loop flags cannot close. Clearing a timer stops passes that
   * have not STARTED; this one has — it is between its book read and its route,
   * holding a fully-formed package — and `drain()` would politely let it finish
   * burning a `seq` and posting an order after the signal.
   */
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  let release = (): void => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  const book = h.book
  const host = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () => h.dials,
    snap: () => h.chain,
    // The pass parks HERE, exactly where a real one parks on Mongo.
    readBook: async () => {
      held = true
      await barrier
      return book
    },
    margin: () => h.margin,
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store: h.store,
    client: h.client,
    now: () => h.now,
    log: fakeLog().log,
  })

  const pass = host.evaluate()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(held, true, 'the pass is inside evaluate(), past every timer')

  // SIGTERM lands now.
  host.stop()
  release()
  await pass
  await host.drain()

  assert.equal(h.client.requests.length, 0, 'NOTHING was posted after the signal')
  // The mark still counted: the package did not happen, the MARK did.
  assert.equal((await h.state()).seq, 0, 'and no seq was burnt')
})

test('a stopped host does not even START a queued pass', async () => {
  // The check at the TOP of a pass, as distinct from the one before the route:
  // a pass that was queued behind another when the signal landed must not run at
  // all. It would read the book, read the repair hold, and BANK THE MARK — a
  // write, during a shutdown, for a mark nobody is going to act on.
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  h.host.stop()
  await h.host.evaluate()

  assert.equal(h.client.requests.length, 0)
  assert.equal(h.collection.docs.size, 0, 'nothing was read, decided or written')
  assert.deepEqual(h.marks, [], 'and no mark was journalled')
})

test('a PERSISTED package still completes its post — that is exactly-once', async () => {
  // The other half of the rule. Once `#route` has written `inFlight`, the id is
  // burnt and this process owns posting it; abandoning it there leaves a
  // decision the next boot has to replay for no reason at all.
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  let release = (): void => {}
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  h.client.submit = async (req): Promise<DecisionResponse> => {
    h.client.requests.push(structuredClone(req))
    await barrier
    return done(req.decisionId)
  }

  const pass = h.host.evaluate()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.client.requests.length, 1, 'the package is at desk-api')

  h.host.stop()
  release()
  await pass
  await h.host.drain()

  // It settled rather than being abandoned mid-flight.
  const state = await h.state()
  assert.equal(state.inFlight, null)
  assert.equal(state.seq, 1)
})

// ────────────────────────────────── 5. the mark journal (spec §7, Task 15)

test('ONE sample per 5-minute mark, whatever the tick rate', async () => {
  // The grid is the target lock's, and the lock counts MARKS: ten evaluations
  // inside one window are one mark. A journal that filed a row per tick would
  // not be a mark journal, it would be a tick log with the word "mark" on it.
  const h = make({ dials: dialsOf({ confirm_ms: 60_000 }) })
  await h.host.evaluate()
  h.now += 30_000
  await h.host.evaluate()
  h.now += 30_000
  await h.host.evaluate()
  assert.equal(h.marks.length, 1)

  h.now = T0 + 5 * 60_000
  await h.host.evaluate()
  assert.equal(h.marks.length, 2)
  assert.deepEqual(
    h.marks.map((m) => m.mark),
    [9, 10],
  )
})

test('the sample carries the numbers the RULES used, not a re-measurement', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 60_000 }) })
  await h.host.evaluate()
  const sample = h.marks[0]
  assert.ok(sample !== undefined)

  assert.equal(sample.tag, TAG)
  assert.equal(sample.mode, 'paper')
  assert.equal(sample.dateIst, '2026-08-21')
  assert.equal(sample.ts, T0)
  // The FORWARD, which is the mid of the future — not its last print.
  assert.equal(sample.spot, SPOT)
  assert.equal(sample.marginSource, 'broker')
  // The shed book: one short PE, δ per share ~0.9, so netΔ is a real number and
  // the band is the gamma-scaled allowance it was compared against.
  assert.ok(sample.netDelta > 0)
  assert.ok(sample.band > 0)
  assert.ok(Number.isFinite(sample.netGamma))
  assert.ok(Number.isFinite(sample.totalPnl))
  assert.equal(sample.reason, h.lines.find((l) => l.msg === 'decision routed')?.ctx['reason'])
})

test('THE JOURNAL SHARES THE HOST’S CLOCK — it never consumes a mark of its own', async () => {
  // `MarkClock.next()` ADVANCES. Two clocks means two consumers, and whichever
  // asks first takes the mark: the lock would count a streak the journal cannot
  // line up against. So the clock is injected, and this proves the host uses the
  // one it was given rather than building its own.
  const shared = new MarkClock()
  const h = make({ dials: dialsOf({ confirm_ms: 60_000 }) })
  const host = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () => h.dials,
    snap: () => h.chain,
    readBook: async () => h.book,
    margin: () => h.margin,
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store: h.store,
    client: h.client,
    now: () => h.now,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    marks: shared,
    onMark: (sample) => h.marks.push(sample),
  })

  // Somebody else consumed this window from the SAME clock first.
  assert.equal(shared.next(T0).isNewMark, true)
  await host.evaluate()
  assert.equal(h.marks.length, 0, 'the window was already taken — this is not a new mark')

  // The next window is this host's.
  h.now = T0 + 5 * 60_000
  await host.evaluate()
  assert.equal(h.marks.length, 1)
})

test('a journal that throws costs a row, never a decision', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  const host = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () => h.dials,
    snap: () => h.chain,
    readBook: async () => h.book,
    margin: () => h.margin,
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store: h.store,
    client: h.client,
    now: () => h.now,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    onMark: () => {
      throw new Error('mongo fell over')
    },
  })
  await host.evaluate()
  assert.equal(h.client.requests.length, 1, 'the package still went out')
})

// ──────────────────────── 6. the maker quote (spec §8, ticket 14 carry 1)

/** Every CE book widened symmetrically: the same mids, refused by the gate. */
function uncrossableChain(): ChainSnap {
  const base = chainOf()
  return {
    ...base,
    strikes: base.strikes.map((row) => {
      const ce = row.ce
      if (ce === null || ce.bid === null || ce.ask === null) return row
      const mid = (ce.bid + ce.ask) / 2
      return { ...row, ce: { ...ce, bid: mid * 0.5, ask: mid * 1.5 } }
    }),
  }
}

test('a sale the chain would not CROSS is quoted, passive, on the tick grid', async () => {
  const h = make({ chain: uncrossableChain(), dials: dialsOf({ confirm_ms: 0 }) })
  await h.host.evaluate()

  const req = h.client.requests[0]
  assert.ok(req !== undefined)
  const sale = req.actions.find((a) => a.op === 'open')
  assert.ok(sale !== undefined && sale.op === 'open')
  // The SAME sale the gate refused — not a smaller one and not a hold.
  assert.equal(sale.instrument, SHED_INSTRUMENT)
  // Priced and worked passively rather than joined to a touch the gate refused.
  assert.equal(sale.workMode, 'passive')
  assert.ok(sale.limitPrice !== undefined && sale.limitPrice > 0)
  // On the exchange's grid: the master said nothing, so 0.05.
  assert.equal(Math.round(sale.limitPrice * 100) % 5, 0)

  // And it is LOUD. A book that has to quote instead of cross is invisible in
  // every other record — the package looks ordinary and so does the fill.
  const alert = h.lines.find((l) => l.msg.startsWith('MAKER QUOTE'))
  assert.ok(alert !== undefined)
  assert.equal(alert.level, 'error')
})

test('THE MAKER-QUOTE ALERT DOES NOT PROMISE WHAT THE LIVE RAIL CANNOT DO', async () => {
  /**
   * The invalidation runs out of `#watchWhileWorking`, which only runs while a
   * flight is held — and desk-api makes a package async on the PAPER rail only
   * (`service.ts:837`). On live the decision settles at route time and the order
   * rests at the gateway with nothing in this process coming back for it. This
   * line is the only tell an operator gets, so it must not tell them a
   * re-decide is coming when none is.
   */
  const paper = make({ chain: uncrossableChain(), dials: dialsOf({ confirm_ms: 0 }) })
  await paper.host.evaluate()
  const onPaper = paper.lines.find((l) => l.msg.startsWith('MAKER QUOTE'))
  assert.ok(onPaper !== undefined)
  assert.match(onPaper.msg, /invalidated \(rest_max_min/)

  const live = makeLive({ chain: uncrossableChain(), dials: dialsOf({ confirm_ms: 0 }) })
  await live.host.evaluate()
  const onLive = live.lines.find((l) => l.msg.startsWith('MAKER QUOTE'))
  assert.ok(onLive !== undefined)
  assert.equal(onLive.level, 'error')
  assert.match(onLive.msg, /WILL NOT COME BACK FOR IT/)
  assert.match(onLive.msg, /no rest_max_min re-decide on the live rail/)
  // And it says who DOES own it, so the line is actionable rather than a warning.
  assert.match(onLive.msg, /the gateway owns this order/)
})

test('the tick comes from the MASTER when it has one', async () => {
  const h = make({ chain: uncrossableChain(), dials: dialsOf({ confirm_ms: 0 }) })
  h.tick = 0.5
  await h.host.evaluate()
  const sale = h.client.requests[0]?.actions.find((a) => a.op === 'open')
  assert.ok(sale !== undefined && sale.op === 'open' && sale.limitPrice !== undefined)
  assert.equal(sale.limitPrice % 0.5, 0)
  // FLOORED, never rounded up: only a sell reaches this path, so the error is on
  // the side of the quote being taken rather than resting above theoretical.
  assert.ok(sale.limitPrice <= Number(alertTheo(h)))
})

/** The theoretical the host logged, for the floor-direction assertion above. */
function alertTheo(h: Harness): number {
  const alert = h.lines.find((l) => l.msg.startsWith('MAKER QUOTE'))
  return Number(alert?.ctx['theoretical'] ?? 0)
}

test('an ORDINARY package carries no limit price at all', async () => {
  // Absent = let the gateway pick the touch (§8). A price on every action would
  // make the maker quote indistinguishable from a passive-first playbook order.
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  await h.host.evaluate()
  const sale = h.client.requests[0]?.actions.find((a) => a.op === 'open')
  assert.ok(sale !== undefined && sale.op === 'open')
  assert.equal(sale.limitPrice, undefined)
  // The PRICE is what this test is about, and it is still absent. The work mode
  // is now stated — the recenter engine says `urgency: 'passive'` for every
  // non-guard package — which is the same instruction desk-api derived from the
  // silence before it.
  assert.equal(sale.workMode, 'passive')
  assert.equal(h.lines.some((l) => l.msg.startsWith('MAKER QUOTE')), false)
})

// ─────────── 7. preempting a working package (spec §8, ticket 14 carry 1)

/** A book holding a WORKING package, exactly as a paper rail leaves one. */
async function withWorkingPackage(h: Harness): Promise<string> {
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  const state = await h.state()
  assert.equal(state.inFlight, `${TAG}:paper:1`)
  return state.inFlight ?? ''
}

test('A GUARD CANCELS THE WORKING PACKAGE FIRST — and routes nothing this pass', async () => {
  // Spec §8: "guards always preempt working orders (cancel first, then act)".
  // The two halves land on different passes on purpose: the replacement package
  // must be sized off a book that has already absorbed whatever filled before
  // the cancel landed, or a guard closes more than the book holds.
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  const decisionId = await withWorkingPackage(h)
  assert.equal(h.client.requests.length, 1)

  h.book = richBook()
  h.dials = dialsOf({ confirm_ms: 0, target_pnl: 500, target_confirm_marks: 1 })
  h.now += 5 * 60_000
  await h.host.evaluate()

  assert.deepEqual(h.cancels, [decisionId])
  assert.equal(h.client.requests.length, 1, 'nothing new is posted while orders are still out')
  const line = h.lines.find((l) => l.msg.includes('cancelling the working package'))
  assert.ok(line !== undefined)
  assert.equal(line.level, 'error')
})

test('a cancel is FILED once per order, not once per pass — and re-asked only after the re-ask window', async () => {
  // The request row is upserted per order id downstream, so a second ask changes
  // nothing at the broker — but it would put an alarm on every pass for as long
  // as the orders take to drain, which is how a real alarm becomes noise. The
  // host sweeps every pass (a decision is not one order) and dedupes by id.
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  await withWorkingPackage(h)
  h.book = richBook()
  h.dials = dialsOf({ confirm_ms: 0, target_pnl: 500, target_confirm_marks: 1 })

  // THREE separate MARKS, so the lock genuinely re-fires each time rather than
  // the test passing because the guard went quiet.
  for (let i = 0; i < 3; i++) {
    h.now += 5 * 60_000
    await h.host.evaluate()
  }
  assert.equal(h.cancels.length, 3, 'the sweep runs on every pass the guard fires')
  assert.deepEqual(h.filed, ['b0', 'b1'], 'but nothing is filed twice inside the re-ask window')
  assert.equal(
    h.lines.filter((l) => l.msg.includes('cancelling the working package')).length,
    1,
    'and nothing is said twice',
  )

  // A cancel the gateway never acted on is not trusted for ever.
  h.now += REASK_MS
  await h.host.evaluate()
  assert.deepEqual(h.filed, ['b0', 'b1', 'b0', 'b1'])
})

test('A PARTIALLY cancelled package is asked again for what was refused, and only that', async () => {
  /**
   * The sweep files one cancel per working order and only throws when NOTHING
   * got through. One refusal out of three therefore comes back as a count — and
   * the refused order is still out, so the next pass must file it again while
   * leaving the two that went through alone.
   */
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  await withWorkingPackage(h)
  h.book = richBook()
  h.dials = dialsOf({ confirm_ms: 0, target_pnl: 500, target_confirm_marks: 1 })

  h.cancelFailures = 1
  h.now += 5 * 60_000
  await h.host.evaluate()
  assert.deepEqual(h.filed, ['b1', 'b2'])
  assert.ok(h.lines.some((l) => l.msg.includes('only PART of the working package')))

  // The next pass asks AGAIN for the refused one, and only for it.
  h.cancelFailures = 0
  h.cancelRequests = 3
  h.now += 5 * 60_000
  await h.host.evaluate()
  assert.deepEqual(h.filed, ['b1', 'b2', 'b0'])

  // Nothing new is out: nothing is filed.
  h.now += 5 * 60_000
  await h.host.evaluate()
  assert.deepEqual(h.filed, ['b1', 'b2', 'b0'])
})

test('a sweep that finds NOTHING working is quiet, and the next pass looks again', async () => {
  // The orders went terminal between the decision and this pass. There is
  // nothing to take off the market, and an ERROR line saying a package was
  // cancelled when none was is the kind of alarm that trains an operator to
  // ignore the ones that matter.
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  await withWorkingPackage(h)
  h.book = richBook()
  h.dials = dialsOf({ confirm_ms: 0, target_pnl: 500, target_confirm_marks: 1 })

  h.cancelRequests = 0
  h.now += 5 * 60_000
  await h.host.evaluate()

  assert.equal(h.cancels.length, 1, 'the sweep ran')
  assert.deepEqual(h.filed, [])
  assert.equal(
    h.lines.some((l) => l.msg.includes('cancelling the working package')),
    false,
    'but nothing was taken off the market, so nothing is claimed',
  )
  assert.ok(h.lines.some((l) => l.level === 'debug' && l.msg.includes('nothing new to cancel')))

  // No latch: an order that shows up later (a close's next tranche) is found.
  h.cancelRequests = 1
  h.now += 5 * 60_000
  await h.host.evaluate()
  assert.equal(h.cancels.length, 2)
  assert.deepEqual(h.filed, ['b0'])
})

test('a cancel that FAILS is tried again — a guard is still waiting behind it', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0 }) })
  await withWorkingPackage(h)
  h.book = richBook()
  h.dials = dialsOf({ confirm_ms: 0, target_pnl: 500, target_confirm_marks: 1 })

  h.cancelFails = new Error('desk-api is down')
  h.now += 5 * 60_000
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [])
  assert.ok(h.lines.some((l) => l.msg.includes('could NOT be cancelled')))

  h.cancelFails = null
  h.now += 5 * 60_000
  await h.host.evaluate()
  assert.equal(h.cancels.length, 1)
})

test('with NO cancel path wired the guard is loud and nothing is routed', async () => {
  // Ticket 14's shipped behaviour, preserved for a deployment that has not got
  // the cancel route: a second package against orders that are still out would
  // double-close legs the first one is already closing.
  const h = make({ dials: dialsOf({ confirm_ms: 0 }), noCancel: true })
  await withWorkingPackage(h)
  h.book = richBook()
  h.dials = dialsOf({ confirm_ms: 0, target_pnl: 500, target_confirm_marks: 1 })
  h.now += 5 * 60_000
  await h.host.evaluate()

  assert.equal(h.client.requests.length, 1)
  const line = h.lines.find((l) => l.msg.includes('NO CANCEL PATH WIRED'))
  assert.ok(line !== undefined)
  assert.equal(line.level, 'error')
})

// ───────────────────────────── 8. maker-quote invalidation (spec §8)

test('a package that has rested past rest_max_min is taken off the market', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0, rest_max_min: 10 }) })
  const decisionId = await withWorkingPackage(h)

  h.now += 9 * 60_000
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [], 'nine minutes is not ten')

  h.now += 60_000
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [decisionId])
  const line = h.lines.find((l) => l.msg.includes('rested past rest_max_min'))
  assert.ok(line !== undefined)
  // A quote that simply did not fill is not an alarm the way a guard is.
  assert.equal(line.level, 'warn')
})

test('A FULL STRIKE STEP of underlying movement invalidates the package', async () => {
  // A maker quote is placed at a model price with pegging OFF, so it does not
  // follow the market. After a strike-step move it is a price from a different
  // book, and the package it belongs to was sized on a ladder that has moved.
  const h = make({ dials: dialsOf({ confirm_ms: 0, rest_max_min: 0 }) })
  const decisionId = await withWorkingPackage(h)
  const base = chainOf()

  h.now += 1_000
  h.chain = { ...base, spot: SPOT + 9.99 }
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [], 'less than one step is not a step')

  h.now += 1_000
  h.chain = { ...base, spot: SPOT + 10 }
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [decisionId])
  assert.ok(h.lines.some((l) => l.msg.includes('moved a full strike step')))
})

test('a package with NO clock — an older document — is never invalidated', async () => {
  const h = make({ dials: dialsOf({ confirm_ms: 0, rest_max_min: 10 }) })
  await withWorkingPackage(h)

  // What a build before `formedAt`/`formedSpot` left behind.
  const state = await h.state()
  const wp = state.workingPackage
  assert.ok(wp !== null)
  await h.store.save(state, {
    ...state,
    workingPackage: { ...wp, formedAt: 0, formedSpot: 0 },
    updatedAt: state.updatedAt + 1,
  })

  h.now += 60 * 60_000
  h.chain = { ...chainOf(), spot: SPOT + 100 }
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [], 'a clock that is not running never fires')
  // And the flight is untouched: it is still polled to a terminal outcome.
  assert.equal((await h.state()).inFlight, `${TAG}:paper:1`)
})

// ──────────────────────────── 9. an all-skipped DONE on the RECENTER engine

test('a recenter DONE whose every OPEN was skipped is SETTLED, not rolled back — the fold is delta-lean only', async () => {
  /**
   * `allSkipped` folds a DONE nothing of which routed as a refusal, and that
   * fold exists for the delta-lean storm (E3, `engine-host-delta-lean.test.ts`
   * §6c): a phantom lean stamped for a unit that never opened. Its every-OPEN
   * arm was written without naming the engine, so a RECENTER book whose
   * all-open package desk-api skipped for `open: no mark for …` (`book.ts`)
   * was rolled back to the mark too — a behaviour change on the live engine,
   * landed under a delta-lean ticket. This pins the recenter engine as it was
   * before that merge: a skipped open settles exactly as a DONE with no fills
   * does, and the switch/not-added arm (which IS a refusal on either engine)
   * is the only fold a recenter book ever sees.
   */
  const plain = make({ dials: dialsOf({ confirm_ms: 60_000 }) })
  await plain.host.evaluate()
  const req = plain.client.requests[0]
  assert.ok(req !== undefined && req.actions.every((a) => a.op === 'open'), 'precondition: an all-open package')

  const skipped = make({ dials: dialsOf({ confirm_ms: 60_000 }) })
  skipped.client.queue({
    ...done(`${TAG}:paper:1`),
    skips: [{ instrument: SHED_INSTRUMENT, reason: `open: no mark for ${SHED_INSTRUMENT}` }],
  })
  await skipped.host.evaluate()
  assert.equal(skipped.client.requests.length, 1)

  const a = await plain.state()
  const b = await skipped.state()
  assert.deepEqual(b.ruleState, a.ruleState, 'settled exactly as the DONE without skips')
  assert.equal(b.inFlight, null)
  assert.equal(b.workingPackage, null)
  assert.equal(
    skipped.lines.filter((l) => l.level === 'warn' && /SKIPPED every action/.test(l.msg)).length,
    0,
    'no refusal fold on the recenter engine',
  )
})

// ──────────────────────────────────────── 0.001 quantities on Delta (DX)

/**
 * THE SAME BOOK ON A 0.001 LOT. On NSE the wire quantity is `lots × lotSize`
 * rounded to a whole share; on Delta it is BTC on a 0.001 grid, and the old
 * `Math.round` turned every sub-1-BTC open into 0 and dropped it.
 */
const BTC_LOT = 0.001
const dxChain = (): ChainSnap => ({ ...chainOf(), lotSize: BTC_LOT })
const dxBook = (): LegPosition[] => [legOf({ lotSize: BTC_LOT })]
const onGrid = (x: number): boolean => x === Number((Math.round(x / BTC_LOT) * BTC_LOT).toFixed(3))

test('DX: a shed of N lots × 0.001 posts qty N/1000 BTC, not 0', async () => {
  const h = make({ venue: DX, book: dxBook(), chain: dxChain(), dials: dialsOf({ confirm_ms: 60_000 }) })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'the open is routed, not dropped as 0')
  const action = h.client.requests[0]?.actions[0]
  assert.ok(action !== undefined && action.op === 'open', JSON.stringify(action))
  assert.ok(action.qty > 0 && action.qty < 1, String(action.qty))
  assert.ok(onGrid(action.qty), `${action.qty} is a clean multiple of 0.001`)
})

test('DX: lots 50 × 0.001 on the wire is exactly 0.05', async () => {
  const { wireQty } = await import('../src/engine-host.ts')
  assert.equal(wireQty(50, BTC_LOT, DX.qtyStep), 0.05)
  assert.equal(wireQty(150, BTC_LOT, DX.qtyStep), 0.15)
  assert.equal(wireQty(1, BTC_LOT, DX.qtyStep), 0.001)
  // NSE: identical to the old Math.round(lots × lotSize).
  assert.equal(wireQty(54, LOT, 1), 54 * LOT)
})

test('DX: a partial fill leaves a clean 0.001 remainder', async () => {
  const h = make({ venue: DX, book: dxBook(), chain: dxChain(), dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  h.client.fallback = (req): DecisionResponse => {
    const a = req.actions[0]
    if (a === undefined || a.op !== 'open') return done(req.decisionId)
    // 0.054 − 0.012 is 0.041999999999999996 in floating point.
    return working(req.decisionId, [{ instrument: a.instrument, side: 'Sell', qty: 0.012, price: 0.6 }])
  }
  await h.host.evaluate()
  const sent = h.client.requests[0]?.actions[0]
  assert.ok(sent !== undefined && sent.op === 'open')
  const held = await h.state()
  const left = held.workingPackage?.remaining[0]
  assert.ok(left !== undefined && left.op === 'open', JSON.stringify(held.workingPackage))
  assert.equal(left.qty, Number((sent.qty - 0.012).toFixed(3)), `${sent.qty} − 0.012 = ${left.qty}`)

})

test('DX: a filled sale folds onto rcStack as whole lots', async () => {
  const h = make({ venue: DX, book: dxBook(), chain: dxChain(), dials: dialsOf({ confirm_ms: 0, cooldown_s: 0 }) })
  // Three partial fills that sum to 0.30000000000000004 in floating point.
  h.client.fallback = (req): DecisionResponse => {
    const a = req.actions[0]
    if (a === undefined || a.op !== 'open') return done(req.decisionId)
    return done(req.decisionId, [
      { instrument: a.instrument, side: 'Sell', qty: 0.1, price: 0.6 },
      { instrument: a.instrument, side: 'Sell', qty: 0.2, price: 0.6 },
    ])
  }
  await h.host.evaluate()
  const stack = (await h.state()).ruleState.rcStack
  assert.ok(stack.length >= 1, JSON.stringify(stack))
  for (const row of stack) assert.ok(Number.isInteger(row.lots), `${row.lots} lots`)
})

test('pendingLotsOf: 0.1 + 0.2 BTC still owed at 0.001 is 300 lots, not 301', async () => {
  const { pendingLotsOf } = await import('../src/engine-host.ts')
  const h = make()
  const state = await h.state()
  const lots = pendingLotsOf(
    {
      ...state,
      workingPackage: {
        decisionId: 'x',
        remaining: [{ op: 'open', instrument: SHED_INSTRUMENT, side: 'Sell', qty: 0.1 + 0.2 }],
        basis: [],
        startedAt: 0,
      } as unknown as NonNullable<SupervisorBookState['workingPackage']>,
    },
    [],
    BTC_LOT,
  )
  assert.equal(lots, 300)
  // A part-lot still owed is still owed: 30 shares of a 75 lot is 1, never 0.
  const part = pendingLotsOf(
    {
      ...state,
      workingPackage: {
        decisionId: 'x',
        remaining: [{ op: 'open', instrument: SHED_INSTRUMENT, side: 'Sell', qty: 30 }],
        basis: [],
        startedAt: 0,
      } as unknown as NonNullable<SupervisorBookState['workingPackage']>,
    },
    [],
    75,
  )
  assert.equal(part, 1)
})
