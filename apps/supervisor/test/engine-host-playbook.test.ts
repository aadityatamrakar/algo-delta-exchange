/**
 * A PLAYBOOK BOOK ON THE DELTA-LEAN RAILS — the host's half of six-playbooks
 * spec §4.1, §4.5, F7 and F8.
 *
 * `decidePlaybook` is the engine's, and its frame is built elsewhere (plan
 * Task 5). This file is about everything the HOST does around it, so it drives
 * the host through the `decidePlaybook` seam: each test states what the frame
 * decides and pins what the wiring does with it, whatever the real frame later
 * decides on its own. The failures, none of which throws:
 *
 *   1. **The wrong engine.** `pb_playbook` 1-6 must reach the frame and 0 the
 *      delta-lean controller, on the same rails. A playbook steered by the
 *      controller opens nothing (its preset's `dl_open_lots` is 0) and looks
 *      like a quiet book.
 *   2. **The three host facts (F7).** `inFlight`, `prevClose` and
 *      `forwardSource` are known only here. A frame told nothing reads them as
 *      unknown; one told a zero would stage a short over a fill still in flight,
 *      or measure a gap off a close of 0.
 *   3. **A playbook exit that waits.** `dl-exit` is an exit: it skips
 *      `confirm_ms`, cancels a working add to get out, and never sweeps the
 *      package it is itself working — exactly what `dl-stop` gets.
 *   4. **The clock sweeping a working exit (F8).** From 14:50 the frame's
 *      clock re-decides the passive `eod` flatten — the same close a working
 *      playbook exit is already working. Swept, the exit is cancelled only to be
 *      re-routed; the urgent 14:55 pass must still take it back.
 *   5. **The journal.** The forward's source rides beside `spot` on the mark.
 *
 * No Mongo, no network, no wall clock: the store is in memory behind the REAL
 * `StateStore`, the client is scripted, and `now()` is a number moved by hand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import {
  PRESETS,
  RISK_FREE,
  SpotRing,
  resolveDials,
  type ChainSnap,
  type DecisionRequest,
  type DecisionResponse,
  type DeltaLeanInputs,
  type Dials,
  type EngineAction,
  type EngineDecision,
  type ForwardSource,
  type LegPosition,
  type MarginInput,
  type OptType,
  type Quote,
  type RuleState,
  type Trigger,
  type Urgency,
} from '@algomaker/desk-engine'
import { EngineHost, type CancelOutcome, type HostLog, type MarkSample } from '../src/engine-host.ts'
import { StateStore, type StateCollection, type SupervisorBookState } from '../src/state-store.ts'

// ────────────────────────────────────────────────────────────── the market

const TAG = 'NIFTY-2026-09-22-pb-trend-drive'
/** 2026-09-16, a Wednesday and an NSE trading day. */
const DATE = '2026-09-16'
const EXPIRY = '2026-09-22'
/** 2026-09-16 10:00 IST. */
const T0 = Date.UTC(2026, 8, 16, 4, 30)
const SPOT = 24_000
const STEP = 50
const LOT = 65
const T6 = 6 / 365
const VOL = 0.12

const q = (bid: number, ask: number, asOf: number): Quote => ({ bid, ask, ltp: null, asOf })

/** A book whose mid is the Black-76 price, so every leg below marks and solves. */
function bookAt(strike: number, type: OptType, asOf: number): Quote {
  const px = b76Price({ future: SPOT, strike, t: T6, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.995, px * 1.005, asOf)
}

const LADDER = Array.from({ length: 21 }, (_, i) => 23_500 + i * STEP)

function chainOf(asOf: number): ChainSnap {
  return {
    symbol: 'NIFTY',
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: q(SPOT - 0.5, SPOT + 0.5, asOf),
    spot: SPOT,
    strikes: LADDER.map((k) => ({ strike: k, ce: bookAt(k, 'CE', asOf), pe: bookAt(k, 'PE', asOf) })),
    asOf,
  }
}

const instrumentOf = (strike: number, optType: OptType): string =>
  `NIFTY26SEP${String(strike)}${optType}`

/** The one leg every exit below closes: a long ATM call, entered at its mid. */
function legOf(): LegPosition {
  const quote = bookAt(24_000, 'CE', T0)
  return {
    instrument: instrumentOf(24_000, 'CE'),
    strike: 24_000,
    optType: 'CE',
    side: 'Buy',
    lots: 2,
    lotSize: LOT,
    entry: ((quote.bid ?? 0) + (quote.ask ?? 0)) / 2,
    openedByEngine: true,
    leanId: '',
  }
}

// ─────────────────────────────────────────────── what the frame decides

/** The frame holds. */
function holding(state: RuleState): EngineDecision {
  return {
    action: 'hold',
    trigger: 'none',
    reason: 'frame: nothing to do',
    actions: [],
    stateAfter: state,
    markState: state,
    urgency: 'passive',
    makerQuote: false,
    creditCommit: null,
  }
}

/** The frame closes every held leg, under `trigger`, worked at `urgency`. */
function closing(inputs: DeltaLeanInputs, state: RuleState, trigger: Trigger, urgency: Urgency): EngineDecision {
  const actions: EngineAction[] = inputs.legs.map((l) => ({ op: 'close', instrument: l.instrument }))
  return {
    action: 'flatten',
    trigger,
    reason: `${trigger}: closing ${String(actions.length)} leg(s)`,
    actions,
    stateAfter: state,
    markState: state,
    urgency,
    makerQuote: false,
    creditCommit: null,
  }
}

/** The frame buys one lot of the ATM call — a pyramid add, passive. */
function buying(state: RuleState): EngineDecision {
  return {
    action: 'adjust',
    trigger: 'dl-add',
    reason: 'frame: pyramid add',
    actions: [{ op: 'open', strike: 24_000, optType: 'CE', side: 'Buy', lots: 1 }],
    stateAfter: state,
    markState: state,
    urgency: 'passive',
    makerQuote: false,
    creditCommit: null,
  }
}

// ─────────────────────────────────────────────────────────────── the fakes

class FakeStateCollection implements StateCollection {
  readonly docs = new Map<string, Record<string, unknown>>()

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
    if (doc !== undefined) {
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
    }
    this.docs.set(key, structuredClone(set))
    return null
  }

  async createIndex(): Promise<unknown> {
    return null
  }
}

const done = (decisionId: string): DecisionResponse => ({
  decisionId,
  replayed: false,
  status: 'DONE',
  fills: [],
  skips: [],
  routeErrors: [],
})

const working = (decisionId: string): DecisionResponse => ({
  decisionId,
  replayed: false,
  status: 'WORKING',
  fills: [],
  skips: [],
  routeErrors: [],
})

class FakeClient {
  readonly requests: DecisionRequest[] = []
  #answers: DecisionResponse[] = []

  queue(...answers: DecisionResponse[]): void {
    this.#answers.push(...answers)
  }

  async submit(req: DecisionRequest): Promise<DecisionResponse> {
    this.requests.push(structuredClone(req))
    return this.#answers.shift() ?? done(req.decisionId)
  }
}

interface Line {
  readonly level: string
  readonly msg: string
}

// ───────────────────────────────────────────────────────────── the harness

/** The Trend Drive preset, resolved exactly as the registry poll resolves it. */
function pbDials(over: Partial<Dials> = {}): Dials {
  const preset = PRESETS.find((p) => p.key === 'pb-trend-drive')
  assert.ok(preset !== undefined, 'the Trend Drive preset must exist')
  const { dials, unknown } = resolveDials(preset.dials as Record<string, number | boolean>)
  assert.deepEqual(unknown, [], 'the preset must not carry a dial the schema refuses')
  assert.equal(dials.pb_playbook, 1)
  return { ...dials, ...over }
}

interface Harness {
  readonly host: EngineHost
  readonly client: FakeClient
  readonly store: StateStore
  readonly lines: Line[]
  readonly cancels: string[]
  /** Every pass the frame was asked to decide, in order. */
  readonly asked: DeltaLeanInputs[]
  readonly marks: MarkSample[]
  book: LegPosition[]
  dials: Dials
  now: number
  /** What the frame decides on its next pass. */
  answer: (inputs: DeltaLeanInputs, state: RuleState) => EngineDecision
  state(): Promise<SupervisorBookState>
  seed(rule: Partial<RuleState>): Promise<void>
}

function make(
  over: {
    book?: LegPosition[]
    dials?: Dials
    prevClose?: () => number | null
    forwardSource?: () => ForwardSource | undefined
  } = {},
): Harness {
  const store = new StateStore(new FakeStateCollection())
  const client = new FakeClient()
  const lines: Line[] = []
  const at =
    (level: string) =>
    (msg: string): void => {
      lines.push({ level, msg })
    }
  const log: HostLog = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  const ring = new SpotRing(64)
  ring.push({ ms: T0, spot: SPOT })

  const h = {
    client,
    store,
    lines,
    cancels: [] as string[],
    asked: [] as DeltaLeanInputs[],
    marks: [] as MarkSample[],
    book: over.book ?? [],
    dials: over.dials ?? pbDials({ confirm_ms: 0 }),
    now: T0,
    answer: (_inputs: DeltaLeanInputs, state: RuleState): EngineDecision => holding(state),
    state: async (): Promise<SupervisorBookState> => await store.load(TAG, 'paper'),
    seed: async (rule: Partial<RuleState>): Promise<void> => {
      const prev = await store.load(TAG, 'paper')
      await store.save(prev, { ...prev, ruleState: { ...prev.ruleState, ...rule }, updatedAt: prev.updatedAt + 1 })
    },
  } as Harness

  const host = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () => h.dials,
    snap: () => chainOf(h.now),
    readBook: async () => h.book,
    margin: (): MarginInput => ({ value: 0, source: 'broker', asOf: T0, fresh: true }),
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store,
    client,
    now: () => h.now,
    log,
    ring,
    spotAsOf: () => h.now,
    onMark: (sample) => h.marks.push(sample),
    cancelWorking: async (decisionId: string): Promise<CancelOutcome> => {
      h.cancels.push(decisionId)
      return { requested: 1, failed: 0 }
    },
    ...(over.prevClose === undefined ? {} : { prevClose: over.prevClose }),
    ...(over.forwardSource === undefined ? {} : { forwardSource: over.forwardSource }),
    // THE SEAM: the frame as this test states it, recording what it was asked.
    decidePlaybook: (inputs, _dials, state) => {
      h.asked.push(inputs)
      return h.answer(inputs, state)
    },
  })
  return Object.assign(h, { host })
}

/** Route one package the frame decides and leave it WORKING. Returns its id. */
async function workingPackage(h: Harness, decide: Harness['answer']): Promise<string> {
  h.answer = decide
  const id = `${TAG}:paper:${String(h.client.requests.length + 1)}`
  h.client.queue(working(id))
  await h.host.evaluate()
  assert.equal((await h.state()).inFlight, id, 'the package is working')
  return id
}

// ══════════════════════════════════════════════ 1. the dispatch (spec §4.1)

test('pb_playbook 1 hands the pass to the playbook frame — the delta-lean controller never sees it', async () => {
  // `dlStopped` with a leg held is the controller's cleanest tell: it flattens
  // at once, as `dl-stop`. Handed to the frame, the pass is what the frame
  // says — here, a hold.
  const h = make({ book: [legOf()] })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  await h.host.evaluate()

  assert.equal(h.asked.length, 1, 'the frame decided this pass')
  assert.equal(h.client.requests.length, 0, 'and nothing of the controller`s went out')
})

test('pb_playbook 0 is the delta-lean controller, exactly as before', async () => {
  const h = make({ book: [legOf()], dials: pbDials({ pb_playbook: 0 }) })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  await h.host.evaluate()

  assert.equal(h.asked.length, 0, 'the frame is never asked')
  assert.equal(h.client.requests[0]?.trigger, 'dl-stop', 'the controller`s own latched stop')
})

test('pb_playbook on a book without delta_lean_enabled is a recenter book — the frame is never asked', async () => {
  // A playbook IS a delta-lean book (spec §4.1); the dial alone selects nothing.
  const h = make({ book: [legOf()], dials: pbDials({ delta_lean_enabled: false }) })
  await h.host.evaluate()
  assert.equal(h.asked.length, 0)
})

// ══════════════════════════════════════ 2. the three host facts (spec F7)

test('the three host facts reach the frame: inFlight, prevClose and forwardSource', async () => {
  const h = make({ prevClose: () => 23_910.4, forwardSource: () => 'parity' })
  const id = await workingPackage(h, (_inputs, state) => buying(state))

  const first = h.asked[0]
  assert.ok(first !== undefined)
  assert.equal(first.inFlight, false, 'nothing was on the wire when this pass decided')
  assert.equal(first.prevClose, 23_910.4)
  assert.equal(first.forwardSource, 'parity')

  // The add is on the wire. Whatever `pendingLots` reads off the book, the
  // flight is the host's word that the package is not over — the paper-fold
  // race the frame's `working` closes.
  h.answer = (_inputs, state) => holding(state)
  h.now += 1_000
  await h.host.evaluate()
  assert.equal(h.asked[1]?.inFlight, true)

  // desk-api answers DONE: the flight clears, and so does the fact.
  h.client.queue(done(id))
  await h.host.pollInFlight()
  h.now += 1_000
  await h.host.evaluate()
  assert.equal(h.asked[2]?.inFlight, false)
})

test('a working package with no flight id is still in flight', async () => {
  // A document holding a package and no id is a torn state, not an idle book:
  // the frame must not stage on top of it.
  const h = make()
  const prev = await h.state()
  await h.store.save(prev, {
    ...prev,
    workingPackage: {
      decisionId: `${TAG}:paper:7`,
      remaining: [],
      request: null,
      basis: [],
      formedAt: 0,
      formedSpot: 0,
    },
    updatedAt: prev.updatedAt + 1,
  })
  assert.equal((await h.state()).inFlight, null)
  await h.host.evaluate()
  assert.equal(h.asked[0]?.inFlight, true)
})

test('host facts nobody stated are UNKNOWN — a null close, no source — never zeros', async () => {
  const h = make()
  await h.host.evaluate()
  const inputs = h.asked[0]
  assert.ok(inputs !== undefined)
  assert.equal(inputs.prevClose, null, 'no close is not a close of 0')
  assert.equal('forwardSource' in inputs, false, 'no source is not "parity"')
  assert.equal(inputs.inFlight, false)
})

// ════════════════════════════ 3. the playbook exit is an exit (spec §4.5)

test('a dl-exit takes the fast path — no confirm wait', async () => {
  // A minute-long confirm window, and the exit goes out on its FIRST sighting:
  // the frame emits one only after a stop, a trail, a target or a time exit has
  // already fired. Mirrors the `dl-stop` test in engine-host-delta-lean.
  const h = make({ book: [legOf()], dials: pbDials({ confirm_ms: 60_000 }) })
  h.answer = (inputs, state) => closing(inputs, state, 'dl-exit', 'urgent')
  await h.host.evaluate()

  assert.equal(h.client.requests[0]?.trigger, 'dl-exit', 'routed on the first sighting')
  assert.ok(
    h.lines.some((l) => l.msg.includes('routing without the confirm wait')),
    'and it took the escape hatch rather than happening to be past the window',
  )
})

test('a dl-exit CANCELS the working add before anything else — exits outrank adds', async () => {
  const h = make()
  const id = await workingPackage(h, (_inputs, state) => buying(state))

  // The add's leg is in the book and the trade's stop fires, add still out.
  h.book = [legOf()]
  h.answer = (inputs, state) => closing(inputs, state, 'dl-exit', 'urgent')
  h.now += 1_000
  await h.host.evaluate()

  assert.deepEqual(h.cancels, [id], 'the working add is taken off the market first')
  assert.ok(h.lines.some((l) => l.level === 'warn' && l.msg.includes('exits outrank adds')))
  // Cancel first, THEN act — on the pass after the flight goes terminal.
  assert.equal(h.client.requests.length, 1)
})

test('a dl-exit never sweeps ITSELF: the latched exit re-sends its close under its own package', async () => {
  // The frame's exit latch re-decides the same close every pass until the book
  // is flat. Sweeping its own package would cancel the exit it is waiting on.
  const h = make({ book: [legOf()] })
  await workingPackage(h, (inputs, state) => closing(inputs, state, 'dl-exit', 'urgent'))
  for (let i = 0; i < 3; i++) {
    h.now += 1_000
    await h.host.evaluate()
  }
  assert.deepEqual(h.cancels, [])
  assert.equal(h.client.requests.length, 1)
})

test('a passive dl-exit that escalates to urgent takes its own package back — said as an escalation', async () => {
  // Spec §4.5: a passive exit becomes urgent after 60 s. The package on the
  // market is worked softer than the frame now wants, so it comes off; the log
  // must not call the trade's own exit "the working add".
  const h = make({ book: [legOf()] })
  const id = await workingPackage(h, (inputs, state) => closing(inputs, state, 'dl-exit', 'passive'))

  h.answer = (inputs, state) => closing(inputs, state, 'dl-exit', 'urgent')
  h.now += 60_000
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [id])
  assert.ok(
    h.lines.some((l) => l.level === 'warn' && l.msg.includes('escalates its own working package to urgent')),
  )
  assert.equal(h.lines.some((l) => l.msg.includes('working add')), false)
})

// ═══════════════════════════ 4. the clock over a working exit (spec F8)

test('F8: the passive eod over a working passive dl-exit stands down; the urgent one takes it back', async () => {
  const h = make({ book: [legOf()] })
  // 14:49:30 — a time exit goes out passive and is still being worked.
  h.now = Date.parse('2026-09-16T14:49:30+05:30')
  const id = await workingPackage(h, (inputs, state) => closing(inputs, state, 'dl-exit', 'passive'))

  // 14:50 — the clock re-decides the same close, passive. Nothing to pre-empt:
  // what it wants is on the market already.
  h.answer = (inputs, state) => closing(inputs, state, 'eod', 'passive')
  h.now += 30_000
  await h.host.evaluate()
  h.now += 1_000
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [], 'the passive flatten does not sweep the exit it duplicates')

  // 14:55 — the urgent pass. Work modes are ranked, so this is an escalation.
  h.answer = (inputs, state) => closing(inputs, state, 'eod', 'urgent')
  h.now += 5 * 60_000
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [id], 'the urgent flatten takes the passive exit off the market')
  assert.ok(
    h.lines.some((l) => l.level === 'warn' && l.msg.includes('escalates the working dl-exit package')),
    'the designed escalation, said at WARN rather than as an unplanned guard',
  )
  assert.equal(h.client.requests.length, 1, 'cancel first; the urgent close routes once the flight is over')
})

test('F8 covers every delta-lean exit: an eod never sweeps an urgent dl-stop that is already out', async () => {
  const h = make({ book: [legOf()] })
  await workingPackage(h, (inputs, state) => closing(inputs, state, 'dl-stop', 'urgent'))
  for (const urgency of ['passive', 'urgent'] as const) {
    h.answer = (inputs, state) => closing(inputs, state, 'eod', urgency)
    h.now += 1_000
    await h.host.evaluate()
  }
  assert.deepEqual(h.cancels, [], 'an urgent exit is already worked as hard as either pass wants')
})

// ═══════════════════════════════════════════ 5. the journal (spec F1)

test('the mark carries the forward`s source beside the spot', async () => {
  const told = make({ forwardSource: () => 'index-carry' })
  await told.host.evaluate()
  assert.equal(told.marks[0]?.spot, SPOT)
  assert.equal(told.marks[0]?.forwardSource, 'index-carry')

  // A host nobody told says nothing — never a guessed source.
  const untold = make()
  await untold.host.evaluate()
  const mark = untold.marks[0]
  assert.ok(mark !== undefined)
  assert.equal('forwardSource' in mark, false)
})
