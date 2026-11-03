/**
 * THE SECOND DECIDE PATH, WIRED TO THE SAME RAILS — and the five ways the
 * wiring, not the rules, loses the money.
 *
 * `decideDeltaLean` is proved in `desk-engine/test/delta-lean-decide.test.ts`
 * against a NIFTY-shaped board. This file is about everything AROUND it, and
 * every test below pins a failure that a pure function cannot have:
 *
 *   1. **THE EXIT THAT WAITED 60 SECONDS.** `#obviousBreach` gates on
 *      `DL_EXIT_TRIGGERS` and on the delta-lean dial, so a delta-lean exit — a
 *      close, or a buy — takes the fast path, and the cooldown outranks it
 *      anyway. On a book at its SPAN cap the wait is the difference between the
 *      stuck exit and the day backstop. Both halves are pinned: the fast path,
 *      and the presets that keep `cooldown_s` at 0 so it can be reached.
 *
 *   2. **TRADING MINUTES, NOT CALENDAR ONES.** `minutesToExpiry` divides, under
 *      a square root, inside every implied move the detector computes. Hand it
 *      calendar minutes across a weekend and every threshold is mis-scaled by a
 *      constant — which presents as a strategy that keeps buying tops, not as
 *      arithmetic. Pinned across a weekend AND across a holiday.
 *
 *   3. **EXITS PRE-EMPT ADDS (spec §8).** The engine can emit an exit while an
 *      add tranche is working. If the host does not cancel the add first, the
 *      exit is simply never routed and the day backstop is decorative.
 *
 *   4. **THE ORDER BUDGET THE ENGINE CANNOT COUNT (R6).** Per second and per day
 *      are real time over routed orders, which only the thing that routes can
 *      see. And a cap may never drop an EXIT: a book that cannot place its add
 *      misses a trade, a book that cannot place its exit keeps the position.
 *
 *   5. **THE DAY'S OWN BANK.** `#settle` folded every close into the TAG's
 *      `cumRealized` and nothing into `dlDayRealized` (spec §7), so the day's
 *      banked half — the number the ledger and the run page read — was
 *      permanently zero.
 *
 * THE FIXTURE is the same NIFTY weekly board the engine's own suite uses: 41
 * strikes (23,000…25,000 by 50) around spot 24,000, lot 65, quoted so each MID
 * is exactly the Black-76 price at vol 0.12, six calendar days to expiry. The
 * tape is a real `SpotRing` filled one sample a second, exactly as the host
 * fills it, so every regime below is REACHED rather than injected.
 *
 * No Mongo, no network, no wall clock: the store is in-memory behind the REAL
 * `StateStore`, the client is scripted, and `now()` is a variable this file
 * moves by hand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { b76Price } from '@algomaker/greeks'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  PRESETS,
  RISK_FREE,
  SpotRing,
  resolveDials,
  strikeGreeks,
  type ChainSnap,
  type DecisionRequest,
  type DecisionResponse,
  type Dials,
  type LegPosition,
  type MarginInput,
  type OptType,
  type Quote,
  type RuleState,
  type WireFill,
} from '@algomaker/desk-engine'
import { workingOrderCanceller } from '../src/working-orders.ts'
import {
  CANCEL_REASK_MS,
  DL_EXIT_TRIGGERS,
  EngineHost,
  openBudget,
  tradingMinutesToExpiry,
  workModeFor,
  type CancelOutcome,
  type HostLog,
} from '../src/engine-host.ts'
import { RefusedError } from '../src/decisions-client.ts'
import { StateStore, type StateCollection, type SupervisorBookState } from '../src/state-store.ts'

// ────────────────────────────────────────────────────────────── the market

const TAG = 'NIFTY-2026-09-22-delta-lean'
const SYMBOL = 'NIFTY'
/** 2026-09-16, a Wednesday, and an NSE trading day. */
const DATE = '2026-09-16'
/** NIFTY's weekly expiry: the following Tuesday (spec §3). */
const EXPIRY = '2026-09-22'
/** 2026-09-16 10:00 IST as an epoch — a real instant, never `Date.now()`. */
const T0 = Date.UTC(2026, 8, 16, 4, 30)
const SPOT = 24_000
const STEP = 50
/** NIFTY, as of Jan 2026 — from `OptionMaster`, never `INDEX_UNDERLYINGS`. */
const LOT = 65
const DTE = 6
const T6 = DTE / 365
const VOL = 0.12

const IST_MIN = 60_000
const MIN_TO_1450 = (890 - 600) * IST_MIN // 10:00 -> 14:50
const MIN_TO_1455 = (896 - 600) * IST_MIN
const MIN_TO_1501 = (901 - 600) * IST_MIN

const q = (bid: number, ask: number, asOf = T0): Quote => ({ bid, ask, ltp: null, asOf })

/** A two-sided book whose MID is exactly the Black-76 price at `VOL`, so the IV
 * solve returns `VOL` and every greek the controller sizes with is the model's
 * rather than a number typed into this file. */
function bookAt(strike: number, type: OptType, asOf = T0): Quote {
  const px = b76Price({ future: SPOT, strike, t: T6, vol: VOL, rate: RISK_FREE, type })
  return q(px * 0.995, px * 1.005, asOf)
}

const LADDER = Array.from({ length: 41 }, (_, i) => 23_000 + i * STEP)

function chainOf(asOf = T0): ChainSnap {
  return {
    symbol: SYMBOL,
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: q(SPOT - 0.5, SPOT + 0.5, asOf),
    spot: SPOT,
    strikes: LADDER.map((k) => ({
      strike: k,
      ce: bookAt(k, 'CE', asOf),
      pe: bookAt(k, 'PE', asOf),
    })),
    asOf,
  }
}

const instrumentOf = (strike: number, optType: OptType): string =>
  `NIFTY26SEP${String(strike)}${optType}`

/**
 * A held leg as `desk-books` stores one. `leanId` defaults to `''` — no lean —
 * so a test that cares about the lean's bank has to say which lean, which is the
 * whole point of the stamp.
 */
function legOf(over: Partial<LegPosition> = {}): LegPosition {
  const strike = over.strike ?? 23_950
  const optType = over.optType ?? 'CE'
  return {
    instrument: over.instrument ?? instrumentOf(strike, optType),
    strike,
    optType,
    side: 'Buy',
    lots: 2,
    lotSize: LOT,
    entry: 200,
    openedByEngine: true,
    leanId: '',
    ...over,
  }
}

/** The board's own MID for a strike — an entry that marks a leg at zero, so a
 * fixture book carries no accidental P&L into `dl_day_target`/`dl_day_max_loss`. */
function midAt(strike: number, optType: OptType): number {
  const quote = bookAt(strike, optType)
  const { bid, ask } = quote
  assert.ok(bid !== null && ask !== null)
  return (bid + ask) / 2
}

/** The per-share |delta| of a strike on this board, as `markLeg` stores it. */
function deltaOf(strike: number, optType: OptType): number {
  const g = strikeGreeks(chainOf(), strike, optType, DATE, 600)
  assert.ok(g !== null, `${String(strike)} ${optType} must be measurable on this board`)
  return Math.abs(g.delta)
}

// ───────────────────────────────────────────────────────────────── the tape

/**
 * A clean 300-point ramp over the fifteen minutes ENDING at `T0`, then flat.
 *
 * 300 points is ~19x the 5-minute implied move on this board, so all three
 * windows read the same trend and the pyramiding gate opens. It ends AT `SPOT`
 * so the tape and the board agree about where the index is, and it stays there
 * afterwards so a test that advances the clock a minute does not silently change
 * regime underneath itself.
 */
const spotAt = (ms: number): number => (ms >= T0 ? SPOT : SPOT - (300 * (T0 - ms)) / 900_000)

/**
 * Push one sample a second up to `toMs`, FORWARD ONLY.
 *
 * `SpotRing.window` walks back from the newest sample and stops at the first one
 * before the cutoff, so it requires samples in time order — topping the ring up
 * the way the host does keeps that true, where re-filling it would not.
 */
function tapeTo(ring: SpotRing, from: number, toMs: number): number {
  let at = from
  while (at <= toMs) {
    ring.push({ ms: at, spot: spotAt(at) })
    at += 1_000
  }
  return at
}

// ─────────────────────────────────────────────────────────────── the fakes

/** `desk-supervisor-state`, in memory, with the CAS behaviours the store needs. */
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

class FakeClient {
  readonly requests: DecisionRequest[] = []
  #answers: Array<DecisionResponse | 'INDETERMINATE' | Error> = []

  queue(...answers: Array<DecisionResponse | 'INDETERMINATE' | Error>): void {
    this.#answers.push(...answers)
  }

  async submit(req: DecisionRequest): Promise<DecisionResponse | 'INDETERMINATE'> {
    this.requests.push(structuredClone(req))
    const next = this.#answers.shift() ?? done(req.decisionId)
    // A queued Error is THROWN, as the real client throws a `RefusedError`.
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

const working = (decisionId: string): DecisionResponse => ({
  decisionId,
  replayed: false,
  status: 'WORKING',
  fills: [],
  skips: [],
  routeErrors: [],
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

/**
 * The aggressive preset, resolved exactly as the registry poll resolves it.
 *
 * `margin_cap` is left at the preset's own ₹25L (spec D4): `decide.ts` now
 * projects every open's SPAN-lite cost against it and truncates — or refuses
 * outright — a package that does not fit, so a test file that zeroed it would
 * open nothing at all, on every single test.
 */
function leanDials(over: Partial<Dials> = {}): Dials {
  const preset = PRESETS.find((p) => p.key === 'delta-lean-aggressive')
  assert.ok(preset !== undefined, 'the aggressive delta-lean preset must exist')
  const { dials, unknown } = resolveDials(preset.dials as Record<string, number | boolean>)
  assert.deepEqual(unknown, [], 'the preset must not carry a dial the schema refuses')
  return { ...dials, ...over }
}

interface Harness {
  readonly host: EngineHost
  readonly client: FakeClient
  readonly store: StateStore
  readonly lines: Line[]
  readonly ring: SpotRing
  readonly cancels: string[]
  /** Every stand-down the host reported to the page; `null` = resumed. */
  readonly standDowns: (string | null)[]
  book: LegPosition[]
  dials: Dials
  now: number
  /** Advance the clock AND the tape together, the way a session does. */
  advance(ms: number): void
  state(): Promise<SupervisorBookState>
  seed(rule: Partial<RuleState>): Promise<void>
}

function make(
  over: {
    book?: LegPosition[]
    dials?: Dials
    /** A deployment with no index feed wired to this host — the wiring fault. */
    noRing?: boolean
    /** The strategy switch as the registry poll reads it. Absent = unknown. */
    switchedOn?: () => boolean | null
    /**
     * The cancel sweep. Absent = every sweep requests one cancel and none
     * fails. Every call is recorded in `cancels` either way.
     */
    cancelWorking?: (decisionId: string, skip: ReadonlySet<string>) => Promise<CancelOutcome>
  } = {},
): Harness {
  const collection = new FakeStateCollection()
  const store = new StateStore(collection)
  const client = new FakeClient()
  const { log, lines } = fakeLog()
  const ring = new SpotRing(4096)
  let nextSample = tapeTo(ring, T0 - 900_000, T0)

  const h = {
    client,
    store,
    lines,
    ring,
    cancels: [] as string[],
    standDowns: [] as (string | null)[],
    book: over.book ?? [],
    dials: over.dials ?? leanDials(),
    now: T0,
    advance: (ms: number): void => {
      h.now += ms
      nextSample = tapeTo(ring, nextSample, h.now)
    },
    state: async (): Promise<SupervisorBookState> => await store.load(TAG, 'paper'),
    seed: async (rule: Partial<RuleState>): Promise<void> => {
      const prev = await store.load(TAG, 'paper')
      await store.save(prev, {
        ...prev,
        ruleState: { ...prev.ruleState, ...rule },
        updatedAt: prev.updatedAt + 1,
      })
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
    // The three delta-lean deps. Absent `ring` is the wiring fault, and it has
    // its own test.
    ...(over.noRing === true ? {} : { ring }),
    ...(over.switchedOn === undefined ? {} : { switchedOn: over.switchedOn }),
    onStandDown: (reason: string | null): void => {
      h.standDowns.push(reason)
    },
    spotAsOf: () => h.now,
    cancelWorking: async (decisionId: string, skip: ReadonlySet<string>): Promise<CancelOutcome> => {
      h.cancels.push(decisionId)
      return (await over.cancelWorking?.(decisionId, skip)) ?? { requested: 1, failed: 0 }
    },
  })
  return Object.assign(h, { host })
}

/** A book the day stop must flatten, stamped to the lean that opened it. */
const leanBook = (leanId: string, lots = 2): LegPosition[] => [
  legOf({ leanId, lots, strike: 23_950, optType: 'CE' }),
]

/**
 * An hour — far past `dl_adjust_confirm_s` (60s/120s), `dl_regime_dwell_s`
 * (120s) and `dl_adjust_cooldown_s` (600s/900s) on either preset. Mirrors
 * `delta-lean-decide.test.ts`'s own `NOW - 3_600_000` convention.
 */
const HOUR = 3_600_000

/**
 * Seed a book already past `dl_adjust_confirm_s`, for an OPEN test.
 *
 * `dlRegime` has to be the label the fixture's own tape actually classifies
 * as AT `h.now` — the default ramp-then-flat tape reads `'trend-up'` — or the
 * first tick's restamp (`decide.ts`: `read.slow === rolled.dlRegime ? rolled
 * : {...rolled, dlRegimeSinceMs: nowMs}`) resets the clock to 0s held and the
 * confirm gate blocks the very thing under test. Mirrors
 * `delta-lean-decide.test.ts`'s `settled()`.
 */
async function warm(h: Harness, regime = 'trend-up', over: Partial<RuleState> = {}): Promise<void> {
  await h.seed({ dlDayStarted: DATE, dlRegime: regime, dlRegimeSinceMs: h.now - HOUR, ...over })
}

/**
 * `warm`, plus a book that has already opened `side` and is past its own
 * `dl_adjust_cooldown_s`. Mirrors `delta-lean-decide.test.ts`'s
 * `opened()`/`openedOn()`.
 */
async function warmOpened(
  h: Harness,
  side: 'up' | 'down' | 'none',
  regime = 'trend-up',
  over: Partial<RuleState> = {},
): Promise<void> {
  await warm(h, regime, {
    dlOpenedMs: h.now - HOUR,
    dlOpenSide: side,
    dlLastAdjustMs: h.now - HOUR,
    dlLastAdjustRegime: regime,
    ...over,
  })
}

/**
 * A FULL reset to `EMPTY_RULE_STATE` (every field, not a merge — spreading it
 * as `rule` overwrites the whole document) that STILL reads as regime-confirmed,
 * for a test that reseeds between passes to isolate a host-side counter
 * (`ordersThisMinute`, the day budget) from the ruleState the engine itself
 * paces on. Without the three fields below, every reseeded pass would restamp
 * `dlRegimeSinceMs` to `nowMs` and refuse the very open the counter is being
 * tested against — indistinguishable, from the assertions alone, from the
 * counter actually doing its job.
 */
async function resetOpenReady(h: Harness, regime = 'trend-up'): Promise<void> {
  await h.seed({ ...EMPTY_RULE_STATE, dlDayStarted: DATE, dlRegime: regime, dlRegimeSinceMs: h.now - HOUR })
}

// ══════════════════════════════════ 1. the branch (plan Task 10, step 3)

test('delta_lean_enabled routes to the delta-lean path; without it, the recenter engine', async () => {
  /**
   * `dlStopped` is the cleanest tell there is: the delta-lean controller treats
   * it as terminal and flattens, and the recenter engine has never heard of the
   * field. One book, one state, one dial — two different decisions.
   */
  const lean = make({ book: leanBook('L1') })
  await lean.seed({ dlStopped: true, dlDayStarted: DATE })
  await lean.host.evaluate()
  const routed = lean.client.requests[0]
  assert.ok(routed !== undefined, 'the delta-lean path flattens a stopped book')
  assert.equal(routed.trigger, 'dl-stop')

  const recenter = make({ book: leanBook('L1'), dials: leanDials({ delta_lean_enabled: false }) })
  await recenter.seed({ dlStopped: true, dlDayStarted: DATE })
  await recenter.host.evaluate()
  // The recenter engine reads none of the `dl*` state, so a long call inside its
  // band is simply a book it holds. No `dl-` trigger can reach the wire.
  assert.equal(
    recenter.client.requests.filter((r) => r.trigger.startsWith('dl-')).length,
    0,
    'a book without the dial is untouched — exactly the path it always took',
  )
})

test('the dial ON with NO spot ring wired steers NOTHING, and says so once', async () => {
  // A deployment where the index feed has not been wired to this host. Falling
  // back to the recenter engine would steer a delta-lean book with rules that
  // are not its own — it would sell premium against a position nobody sized that
  // way — so the book holds, loudly, and the operator gets one line rather than
  // four a second.
  const h = make({ book: leanBook('L1'), noRing: true })
  await h.host.evaluate()
  await h.host.evaluate()
  await h.host.evaluate()

  assert.equal(h.client.requests.length, 0, 'nothing is routed by either engine')
  const faults = h.lines.filter((l) => l.level === 'error' && l.msg.includes('NO SPOT RING'))
  assert.equal(faults.length, 1, 'said once, not once per pass')
  assert.ok(
    h.lines.some((l) => String(l.ctx['reason'] ?? '').includes('no spot ring is wired')),
    'and the hold names itself in the reason an operator reads',
  )
})

// ══════════════════════════════ 2. trading minutes to expiry (step (b))

test('minutesToExpiry counts TRADING minutes — the weekend is not time to expiry', () => {
  /**
   * Friday 2026-09-18 10:00 IST to Tuesday 2026-09-22's close. Calendar minutes
   * would be 4 days and 5.5 hours — 6,090. The options were not decaying on
   * Saturday: it is 330 minutes left on the Friday plus two whole sessions
   * (Monday the 21st, Tuesday the 22nd) at 375 each.
   *
   * The over-count matters because it divides under a square root inside every
   * implied window move: 6,090 instead of 1,080 quotes each window's expected
   * move ~2.4x too LOW, so ordinary noise clears the trend bar and the book
   * leans into it with real size.
   */
  assert.equal(tradingMinutesToExpiry('2026-09-18', 600, '2026-09-22'), 330 + 2 * 375)
})

test('a market holiday is not time to expiry either', () => {
  /**
   * Friday 2026-09-11 10:00 to Tuesday 2026-09-15. 2026-09-14 is a MONDAY and
   * Ganesh Chaturthi — a full-day NSE closure in `MARKET_HOLIDAYS_2026` — so the
   * only whole session in between is the Tuesday itself. A weekday check alone
   * would count the Monday and over-state the window by a third.
   */
  assert.equal(tradingMinutesToExpiry('2026-09-11', 600, '2026-09-15'), 330 + 375)
})

test('the same-day, pre-open, past-close and expired cases', () => {
  // Expiry day at 10:00: what is left of one session, to the 15:30 SETTLE — not
  // to the book's own 15:00 flat-by, because the straddle this is compared
  // against is priced to expiry.
  assert.equal(tradingMinutesToExpiry('2026-09-16', 600, '2026-09-16'), 330)
  // 09:00 does not buy the book fifteen extra minutes of decay.
  assert.equal(tradingMinutesToExpiry('2026-09-16', 540, '2026-09-16'), 375)
  // And 15:45 does not owe it negative time.
  assert.equal(tradingMinutesToExpiry('2026-09-16', 945, '2026-09-16'), 0)
  // An expiry already past is 0, which `impliedWindowMove` answers `null` for —
  // "no reading", which opens nothing, rather than a zeroed bar.
  assert.equal(tradingMinutesToExpiry('2026-09-23', 600, '2026-09-22'), 0)
  // A date the market was shut on contributes nothing of its own.
  assert.equal(tradingMinutesToExpiry('2026-09-14', 600, '2026-09-14'), 0)
})

test('the host feeds the engine those minutes, not calendar ones', async () => {
  // End to end: 2026-09-16 10:00 to the 22nd is 330 + four whole sessions (the
  // 17th, 18th, 21st and 22nd; the 19th/20th are the weekend). The same 1,830
  // the engine's own fixture derives.
  const h = make()
  let seen = -1
  const host = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () => h.dials,
    snap: () => chainOf(h.now),
    readBook: async () => [],
    margin: (): MarginInput => ({ value: 0, source: 'broker', asOf: T0, fresh: true }),
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store: h.store,
    client: h.client,
    now: () => h.now,
    log: fakeLog().log,
    ring: h.ring,
    spotAsOf: () => h.now,
    // The seam, used here only to OBSERVE what the default would have been.
    minutesToExpiry: (): number => {
      seen = tradingMinutesToExpiry(DATE, 600, EXPIRY)
      return seen
    },
  })
  await host.evaluate()
  assert.equal(seen, 330 + 4 * 375)
})

// ═══════════════════════════════ 3. the fast path and the cooldown (d)

test('a delta-lean EXIT takes the fast path — no confirm wait', async () => {
  // A minute-long confirm window, and the exit goes out on the FIRST sighting.
  // The controller emits one only after the day backstop, the target or the
  // stuck clock has already fired; waiting re-asks a question it has answered,
  // and on a book at the cap the wait is the difference between the stuck exit
  // and the day backstop.
  const h = make({ book: leanBook('L1'), dials: leanDials({ confirm_ms: 60_000 }) })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  await h.host.evaluate()

  const req = h.client.requests[0]
  assert.ok(req !== undefined, 'routed on the first sighting')
  assert.equal(req.trigger, 'dl-stop')
  assert.ok(
    h.lines.some((l) => l.msg.includes('routing without the confirm wait')),
    'and it took the escape hatch rather than happening to be past the window',
  )
})

test('an OPEN and an ADJUSTMENT still serve their confirm window', async () => {
  // Only the three exits skip it. An open is a new position on a tape that has
  // to still be there a second later, which is the whole reason damping exists.
  //
  // The ENGINE's own `dl_adjust_confirm_s` (60s aggressive) is a separate gate
  // from the HOST's `confirm_ms` — it is what confirms the REGIME, off a clock
  // that only starts once the state has recorded one. Seeded already past it,
  // so what this test pins is the host's damping alone.
  const h = make({ dials: leanDials({ confirm_ms: 1_000 }) })
  // `dlDayStarted` has to be seeded too: `rollDay` restamps `dlRegimeSinceMs`
  // to `nowMs` on what it reads as a fresh day, which would silently undo the
  // seed below.
  await h.seed({ dlDayStarted: DATE, dlRegime: 'trend-up', dlRegimeSinceMs: T0 - 61_000 })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'the first sighting only ARMS the intent')
  assert.ok(h.host.armedIntent !== null)

  h.advance(1_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'and the second, past confirm_ms, routes it')
  assert.equal(h.client.requests[0]?.trigger, 'dl-open')
})

test('the four exit triggers are exactly dl-target, dl-stuck, dl-stop and dl-exit', () => {
  // Pinned as a SET rather than one trigger at a time: a fifth name added here
  // would silently gain the no-confirm fast path, and the fast path is what
  // lets a package skip the damping every other decision serves. `dl-exit` is
  // the playbook frame's exit (six-playbooks spec §4.5) — a stop, trail,
  // target, time exit or stage abort that has already fired.
  assert.deepEqual([...DL_EXIT_TRIGGERS].sort(), ['dl-exit', 'dl-stop', 'dl-stuck', 'dl-target'])
  for (const adds of ['dl-open', 'dl-add', 'dl-neutral'] as const) {
    assert.equal(DL_EXIT_TRIGGERS.has(adds), false, `${adds} is an ADD and must be damped`)
  }
})

test('the LEAN STAMP does not re-arm the intent — a clock reading is not a new package', async () => {
  /**
   * The v1 engine stamped every leg a package opened with a lean id minted
   * fresh on every tick, and `shapeOf` fed that straight into the damping key
   * — so the first open of every lean re-armed four times a second,
   * `confirm_ms` never elapsed, and the book opened nothing at all. Nothing
   * threw; the log just said `intent armed` forever. This engine mints no such
   * stamp, but `shapeOf` still strips `leanId` (see its own doc), so the same
   * shape-stability holds for whatever this engine's own opens carry.
   */
  const h = make({ dials: leanDials({ confirm_ms: 1_000 }) })
  await warm(h)
  await h.host.evaluate()
  const armedAt = h.host.armedIntent?.armedAt
  assert.ok(armedAt !== undefined)

  h.advance(400) // the intent's id would already be a different one by now
  await h.host.evaluate()
  assert.equal(h.host.armedIntent?.armedAt, armedAt, 'the same package, still arming')
  assert.equal(
    h.lines.filter((l) => l.msg === 'intent armed').length,
    1,
    'armed ONCE — a re-arm here is a confirm window that can never elapse',
  )
})

test('the COOLDOWN still outranks the fast path — which is why the presets set it to 0', async () => {
  /**
   * The ordering is deliberate ("this book just acted" is a stronger statement
   * than "this breach is obvious"), so the fast path is only reachable at
   * `cooldown_s: 0`. A retune that put the recenter default back would
   * reintroduce a 30-second wait in front of every cut, silently — the decision
   * would still be made, still be correct, and simply not go out.
   */
  const h = make({ book: leanBook('L1'), dials: leanDials({ cooldown_s: 30 }) })
  await h.seed({ dlStopped: true, dlDayStarted: DATE, lastActionMs: T0 - 5_000 })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'the cut waits out a cooldown it should not have')
})

test('BOTH delta-lean presets carry cooldown_s: 0 — the fast path stays reachable', () => {
  const lean = PRESETS.filter((p) => p.key.startsWith('delta-lean'))
  assert.equal(lean.length, 6, 'the aggressive and conservative prefills, their hold-to-expiry siblings, and the two zero books')
  for (const preset of lean) {
    // Read off the PRESET rather than the resolved set: inheriting the recenter
    // default from `DEFAULT_DIALS` is exactly the regression this guards, and a
    // resolved 0 could come from either.
    assert.equal(preset.dials.cooldown_s, 0, `${preset.key} must not reintroduce the wait`)
  }
})

test('the recenter fast path is UNCHANGED — the delta-lean branch cannot reach it', () => {
  // The branch is gated on the dial AND on a delta-lean trigger, so no recenter
  // trigger can take it: the four phase-R triggers still have to clear the band
  // by a full lot-equivalent, and everything else still serves `confirm_ms`.
  // `engine-host.test.ts` pins both halves on a real book; this pins that the
  // delta-lean dial did not widen the SET they are tested against.
  assert.equal(DEFAULT_DIALS.delta_lean_enabled, false)
})

// ═════════════════════════════════════ 4. the three urgency classes (e)

test('urgency maps onto the wire, and the ladder is NEVER the absence', () => {
  assert.equal(workModeFor('passive'), 'passive')
  assert.equal(workModeFor('urgent'), 'urgent')
  // The engine names three urgencies; the wire expresses two. Absence is not a
  // third: `routes/engine.ts` reads it as `'passive'`, which is the PEG. Mapping
  // the ladder to absence made the 15:00 residual flatten gentler than the 14:55
  // pass it escalates from — the last pass standing between an always-flat book
  // and an overnight carry. `'urgent'` is the value that reaches the blind
  // ladder, and it takes freeze-sized tranches on the way.
  assert.equal(workModeFor('ladder'), 'urgent')
  assert.notEqual(workModeFor('ladder'), undefined)
})

test('adds are PASSIVE, cuts are URGENT, and the 15:00 residual is the LADDER', async () => {
  const add = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(add)
  await add.host.evaluate()
  const opens = add.client.requests[0]?.actions ?? []
  assert.ok(opens.length > 0, 'the trending tape opens a lean')
  assert.ok(
    opens.every((a) => a.workMode === 'passive'),
    'an add is worked at the touch — it is not in a hurry',
  )

  const cut = make({ book: leanBook('L1'), dials: leanDials({ confirm_ms: 0 }) })
  await cut.seed({ dlStopped: true, dlDayStarted: DATE })
  await cut.host.evaluate()
  assert.deepEqual(
    (cut.client.requests[0]?.actions ?? []).map((a) => a.workMode),
    ['urgent'],
  )

  // 14:50 works the exit at the touch; 14:55 and 15:00 both cross it. The
  // engine distinguishes urgent from ladder and the journal records which was
  // meant, but the wire carries two values, so the escalation the book actually
  // gets is passive then forceful. What must never happen is 15:00 arriving
  // SOFTER than 14:55 — that pass is the last thing between an always-flat book
  // and an overnight carry, which is why `undefined` is asserted against below.
  for (const [skip, want] of [
    [MIN_TO_1450, 'passive'],
    [MIN_TO_1455, 'urgent'],
    [MIN_TO_1501, 'urgent'],
  ] as const) {
    const h = make({ book: leanBook('L1'), dials: leanDials({ confirm_ms: 0 }) })
    h.advance(skip)
    await h.host.evaluate()
    const req = h.client.requests[0]
    assert.ok(req !== undefined, `a flatten is expected at +${String(skip)}ms`)
    assert.equal(req.trigger, 'eod')
    assert.equal(req.actions[0]?.workMode, want)
    // Absence is the peg, never the ladder: desk-api reads a missing work mode
    // as 'passive'. A flatten that goes out bare is a flatten that dawdles.
    assert.notEqual(req.actions[0]?.workMode, undefined)
  }
})

test('a delta-lean add is NOT priced as a maker quote — that flag means the chain refused it', async () => {
  // The overload Task 9 had to live with: `makerQuote` carried urgency, and the
  // host reprices a quoted SELL at Black-76 theoretical and alerts at ERROR on
  // every one. An ordinary passive add went out at a model price with an alarm
  // attached to it.
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h)
  await h.host.evaluate()
  const sale = (h.client.requests[0]?.actions ?? []).find((a) => a.op === 'open' && a.side === 'Sell')
  assert.ok(sale !== undefined && sale.op === 'open')
  assert.equal(sale.limitPrice, undefined, 'no model price on an ordinary add')
  assert.equal(h.lines.some((l) => l.msg.startsWith('MAKER QUOTE')), false)
})

// ══════════════════════════════════ 5. exits pre-empt adds (R1's host half)

test('an exit CANCELS the working add before anything else — exits outrank adds', async () => {
  /**
   * The engine can emit an exit while an add tranche is still out. Without this
   * half the pass would simply log "holding under a working package" and the
   * exit would never reach the wire at all — which is precisely the size of
   * book it exists for.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h)
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  const decisionId = h.client.requests[0]?.decisionId
  assert.ok(decisionId !== undefined)
  assert.equal((await h.state()).inFlight, decisionId, 'an add is working')

  // The day stop fires on the next tick, with the add still out.
  h.book = leanBook('L1')
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  h.advance(1_000)
  await h.host.evaluate()

  assert.deepEqual(h.cancels, [decisionId], 'the working add is taken off the market first')
  assert.ok(
    h.lines.some((l) => l.level === 'warn' && l.msg.includes('exits outrank adds')),
    'WARN, not ERROR: this is the designed behaviour of a book that exits on a rule firing',
  )
  // Cancel first, THEN act — on a later pass, once the flight has gone terminal
  // and its partial fills are in the book. Routing a second package now would
  // close more than the book holds.
  assert.equal(h.client.requests.length, 1)
})

/**
 * THE 2026-10-01 SENSEX WEDGE. Both SENSEX books routed their 14:50 passive
 * flatten; every leg filled but the long hedge, whose close crossed once and
 * then RESTED (the simulator fills a limit only on a print through it, and the
 * put was falling). The engine said "14:55: urgent flatten — closing all 1
 * leg(s)" on every pass from 14:55 to 15:30 and NOTHING was ever routed: the
 * leg expired in the book.
 *
 * Why: one second after routing, the next pass re-decided the SAME passive
 * flatten, `#watchWhileWorking` read it as a guard wanting the book and swept
 * the package — whose seven orders were still PENDING at the gateway, with no
 * broker id, so the sweep requested nothing, answered `{0, 0}`, and LATCHED.
 * Every later pass, the 14:55 urgent one included, hit the latch and returned.
 */
const wedgeBook = (): LegPosition[] => [
  legOf({ strike: 24_100, optType: 'CE', side: 'Sell', lots: 4, entry: midAt(24_100, 'CE') }),
  legOf({ strike: 24_300, optType: 'CE', side: 'Buy', lots: 4, entry: midAt(24_300, 'CE') }),
]

/**
 * The gateway's queue as the REAL sweep (`working-orders.ts`) reads it, so the
 * host and the canceller are proved together. Orders move the way `queue.ts`
 * moves them: PENDING until placed, PLACED with one broker id per tranche, and
 * a cancelled tranche of a CLOSE re-queued PENDING still carrying the finished
 * tranche's id (`advanceTranche`, `gateway.ts:decideTrancheStep` rule 3).
 */
function fakeQueue(): {
  readonly filed: string[]
  sweep(decisionId: string, skip: ReadonlySet<string>): Promise<CancelOutcome>
  queue(clientOrderId: string): void
  place(clientOrderId: string): void
  advance(clientOrderId: string): void
  finish(clientOrderId: string, state: string): void
} {
  const docs: Record<string, unknown>[] = []
  const filed: string[] = []
  let seq = 0
  const get = (id: string): Record<string, unknown> => {
    const d = docs.find((x) => x['clientOrderId'] === id)
    assert.ok(d !== undefined, `no order ${id}`)
    return d
  }
  const quiet: HostLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const sweep = workingOrderCanceller(
    {
      collection: {
        find: (f: Record<string, unknown>) => ({
          toArray: async () =>
            docs
              .filter((d) => (f['state'] as { $in: string[] }).$in.includes(String(d['state'])))
              .map((d) => ({ ...d })),
        }),
      },
      cancel: async (brokerOrderId: string) => void filed.push(brokerOrderId),
      log: quiet,
    },
    TAG,
    'paper',
  )
  return {
    filed,
    sweep,
    queue: (id) => void docs.push({ clientOrderId: id, tag: TAG, mode: 'paper', state: 'PENDING', brokerOrderIds: [] }),
    place: (id) => {
      const d = get(id)
      d['state'] = 'PLACED'
      d['brokerOrderIds'] = [...(d['brokerOrderIds'] as string[]), `sim-${String(++seq)}`]
    },
    advance: (id) => void (get(id)['state'] = 'PENDING'),
    finish: (id, state) => void (get(id)['state'] = state),
  }
}

test('a RESTING passive flatten cannot wedge the book: at 14:55 the urgent flatten takes BOTH tranches off the market, routes the held leg, and rest_max_min still works', async () => {
  const gw = fakeQueue()
  const h = make({
    book: wedgeBook(),
    dials: leanDials({ confirm_ms: 0 }),
    cancelWorking: (id, skip) => gw.sweep(id, skip),
  })
  const hedge = h.book[1]
  assert.ok(hedge !== undefined)

  // 14:50:00 — the passive flatten routes and comes back WORKING.
  h.advance(MIN_TO_1450)
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  const passive = h.client.requests[0]
  assert.ok(passive !== undefined)
  assert.equal(passive.trigger, 'eod')
  assert.deepEqual(passive.actions.map((a) => a.workMode), ['passive', 'passive'])
  const shortOrder = `${passive.decisionId}#0`
  const hedgeOrder = `${passive.decisionId}#1`
  gw.queue(shortOrder)
  gw.queue(hedgeOrder)

  // 14:50:01 — the next pass re-decides the SAME passive flatten; nothing placed yet.
  h.advance(1_000)
  await h.host.evaluate()

  // 14:50:06 — placed. The short fills; the hedge close's first tranche rests.
  gw.place(shortOrder) // sim-1
  gw.finish(shortOrder, 'FILLED')
  gw.place(hedgeOrder) // sim-2, tranche .1
  h.book = [hedge]
  for (let i = 0; i < 4; i++) {
    h.advance(60_000)
    await h.host.evaluate()
  }
  assert.deepEqual(h.cancels, [], 'a passive flatten is never swept by the passive flatten that placed it')
  assert.equal(h.client.requests.length, 1, 'nothing new routes while the package is out')

  // 14:55:00 — the escalation takes the resting tranche off the market.
  h.advance(59_000)
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-2'])

  // The gateway cancels tranche .1 and ADVANCES the close: PENDING, old id.
  gw.advance(hedgeOrder)
  h.advance(1_000)
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-2'], 'nothing is filed against the finished tranche')

  // Tranche .2 goes out under a new id — and is cancelled at once.
  gw.place(hedgeOrder) // sim-3
  h.advance(1_000)
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-2', 'sim-3'], 'the next tranche is swept, not left behind a latch')
  h.advance(1_000)
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-2', 'sim-3'], 'and nothing is filed twice')

  // The close is over; desk-api settles the decision.
  gw.finish(hedgeOrder, 'HALTED')
  h.client.queue(done(passive.decisionId))
  await h.host.pollInFlight()
  assert.equal((await h.state()).inFlight, null)

  // 14:55:04 — the urgent flatten routes, for every leg still held.
  h.client.queue(working(`${TAG}:paper:2`))
  h.advance(1_000)
  await h.host.evaluate()
  const urgent = h.client.requests.at(-1)
  assert.ok(urgent !== undefined)
  assert.notEqual(urgent.decisionId, passive.decisionId)
  assert.equal(urgent.trigger, 'eod')
  assert.deepEqual(
    urgent.actions.map((a) => [a.op, a.instrument, a.workMode]),
    [['close', hedge.instrument, 'urgent']],
  )

  // That close rests too. Its own escalation (the 15:00 ladder is 'urgent' on
  // the wire) does not sweep it, but rest_max_min still takes it back.
  const urgentOrder = `${urgent.decisionId}#0`
  gw.queue(urgentOrder)
  gw.place(urgentOrder) // sim-4
  for (let i = 0; i < 9; i++) {
    h.advance(60_000)
    await h.host.evaluate()
  }
  assert.deepEqual(gw.filed, ['sim-2', 'sim-3'], 'nine minutes is not rest_max_min')
  h.advance(60_000)
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-2', 'sim-3', 'sim-4'], 'rest_max_min is not blocked by an earlier cancel')
})

test('an escalation that finds the package NOT YET PLACED sweeps again next pass, and re-asks a cancel that never took', async () => {
  const gw = fakeQueue()
  const h = make({
    book: wedgeBook(),
    dials: leanDials({ confirm_ms: 0 }),
    cancelWorking: (id, skip) => gw.sweep(id, skip),
  })
  h.advance(MIN_TO_1450 + 5 * 60_000 - 1_000) // 14:54:59
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  const id = h.client.requests[0]?.decisionId
  assert.ok(id !== undefined)
  gw.queue(`${id}#0`)
  gw.queue(`${id}#1`)

  h.advance(1_000) // 14:55:00 — urgent, nothing placed yet
  await h.host.evaluate()
  assert.equal(h.cancels.length, 1, 'the sweep ran')
  assert.deepEqual(gw.filed, [], 'and found nothing at the broker')

  gw.place(`${id}#0`)
  gw.place(`${id}#1`)
  h.advance(1_000) // 14:55:01 — placed now: the sweep runs again and files both
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-1', 'sim-2'])

  h.advance(1_000) // a filed cancel is not re-filed on the next pass
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-1', 'sim-2'])

  // A cancel the gateway never acted on is asked again after CANCEL_REASK_MS.
  h.advance(CANCEL_REASK_MS)
  await h.host.evaluate()
  assert.deepEqual(gw.filed, ['sim-1', 'sim-2', 'sim-1', 'sim-2'])
})

test('an exit never sweeps ITSELF: a working dl-stop is not cancelled by the dl-stop that placed it', async () => {
  // The latched stop re-decides "stopped for the day — closing all" every pass
  // while its own urgent flatten is out. Sweeping that package would cancel the
  // exit it is waiting on and re-route it, over and over, once the sweep no
  // longer latches on unplaced orders.
  const gw = fakeQueue()
  const h = make({
    book: wedgeBook(),
    dials: leanDials({ confirm_ms: 0 }),
    cancelWorking: (id, skip) => gw.sweep(id, skip),
  })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  assert.equal(h.client.requests[0]?.trigger, 'dl-stop')
  gw.queue(`${TAG}:paper:1#0`)
  for (let i = 0; i < 3; i++) {
    h.advance(1_000)
    await h.host.evaluate()
    if (i === 0) gw.place(`${TAG}:paper:1#0`)
  }
  assert.deepEqual(h.cancels, [])
  assert.deepEqual(gw.filed, [])
  assert.equal(h.client.requests.length, 1)
})

test('a dl-target flatten is not swept by the dl-stop that its own latch decides next', async () => {
  // `dl-target` latches `dlStopped` on the flattening tick, so the very next
  // pass decides the SAME flatten under step 1's name, "stopped for the day".
  // Read as a different exit it swept the target's ladder while unplaced and
  // re-routed it as an urgent dl-stop.
  const gw = fakeQueue()
  const rich = legOf({ strike: 24_000, optType: 'CE', side: 'Buy', lots: 4, entry: midAt(24_000, 'CE') - 60 })
  const h = make({
    book: [rich],
    dials: leanDials({ confirm_ms: 0 }),
    cancelWorking: (id, skip) => gw.sweep(id, skip),
  })
  await warmOpened(h, 'up')
  h.client.queue(working(`${TAG}:paper:1`))
  await h.host.evaluate()
  const target = h.client.requests[0]
  assert.equal(target?.trigger, 'dl-target', 'the book is past its day target')
  gw.queue(`${TAG}:paper:1#0`)

  for (let i = 0; i < 3; i++) {
    h.advance(1_000)
    await h.host.evaluate()
    if (i === 0) gw.place(`${TAG}:paper:1#0`)
  }
  assert.ok((await h.state()).ruleState.dlStopped, 'the next passes are the latched stop')
  assert.deepEqual(h.cancels, [], 'the target ladder is its own exit, not an add to preempt')
  assert.deepEqual(gw.filed, [])
  assert.equal(h.client.requests.length, 1)
})

// ═════════════════════════════════════════ 6. the order budget (R6, (g))

/** Every wire action of the one package this book routed. */
const routedActions = (h: Harness): number => h.client.requests[0]?.actions.length ?? 0

test('dl_max_orders_s is a BURST cap: a clear second takes a whole unit even when the cap is smaller than the unit', async () => {
  /**
   * A debit unit is two legs, and half of one is a naked leg, so opens still go
   * whole or not at all. But the per-second cap is a BURST limit — how fast the
   * rail may be hit — not a bound on the size of one package: this board's open
   * is a two-leg debit pair against a cap of 1 in this test, and reading the
   * cap as a package-size limit would drop that package forever (spec E2: "the
   * order budget is spent" every 2 s for a whole session). A clear second takes
   * the whole package; the cap then holds the NEXT one until the window clears.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0, dl_max_orders_s: 1 }) })
  await warm(h)
  await h.host.evaluate()
  assert.equal(routedActions(h), 2, 'the clear second takes the whole debit unit, cap 1 or not')
  assert.equal(
    h.lines.filter((l) => l.level === 'warn' && l.msg.includes('order budget is spent')).length,
    0,
    'nothing was dropped, so nothing is warned about',
  )

  // ZERO still means "no opens", as it always has: a dial an operator set to 0
  // is a book told not to open, not a book told to open in one burst.
  const off = make({ dials: leanDials({ confirm_ms: 0, dl_max_orders_s: 0 }) })
  await warm(off)
  await off.host.evaluate()
  assert.equal(off.client.requests.length, 0, 'a zero cap opens nothing')
  assert.ok(
    off.lines.some((l) => l.level === 'warn' && l.msg.includes('nothing is opened')),
    'and it is named, not silent',
  )
})

test('a busy second holds the NEXT package whole, and releases it when the window clears', async () => {
  /**
   * The other half of a burst cap: once a package has gone out, the second it
   * went out in is BUSY and the next package waits — whole, not sliced — until
   * a second has passed. At DEBUG, not WARN: a package held for half a second
   * is pacing working as designed, not an alarm.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'the first package goes at once')

  await resetOpenReady(h)
  h.advance(500)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'inside the busy second: held')
  assert.equal(
    h.lines.filter((l) => l.level === 'debug' && /burst window/.test(l.msg)).length,
    1,
    'and said at DEBUG',
  )
  assert.equal(
    h.lines.filter((l) => l.level === 'warn' && l.msg.includes('order budget is spent')).length,
    0,
    'a held package is not a spent budget',
  )

  await resetOpenReady(h)
  h.advance(1_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2, 'the window cleared: the held package goes whole')
})

test('openBudget: the verdict table', () => {
  // The rules in order: a zero cap is "no opens"; the per-minute and per-day
  // caps must have room for the WHOLE package; a clear second takes any size;
  // otherwise the package fits the remaining burst or waits for the window.
  const base = { perSecond: 2, minuteRoom: 40, dayRoom: 600 }
  assert.equal(openBudget({ ...base, orders: 4, routedLastSecond: 0 }), 'route')
  // The brief's table had this one as 'route', against its own rule
  // (`routedLastSecond + orders <= perSecond`: 1 + 2 = 3 > 2). The rule wins:
  // the burst has room for one more order and the package needs two.
  assert.equal(openBudget({ ...base, orders: 2, routedLastSecond: 1 }), 'hold-second')
  assert.equal(openBudget({ ...base, orders: 1, routedLastSecond: 1 }), 'route')
  assert.equal(openBudget({ ...base, orders: 2, routedLastSecond: 2 }), 'hold-second')
  assert.equal(openBudget({ ...base, orders: 4, routedLastSecond: 0, minuteRoom: 3 }), 'exhausted')
  assert.equal(openBudget({ ...base, orders: 4, routedLastSecond: 0, dayRoom: 3 }), 'exhausted')
  assert.equal(openBudget({ ...base, orders: 1, routedLastSecond: 0, perSecond: 0 }), 'exhausted')
})

test('the exhausted WARN is once a minute, with the suppressed count', async () => {
  /**
   * The 09-21 page: hundreds of identical lines for one book. A spent budget
   * that persists is ONE condition, reported once a minute with how many passes
   * it held for — not once per pass.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0, dl_max_orders_day: 2 }) })
  await warm(h)
  await h.host.evaluate()
  assert.equal(routedActions(h), 2, 'the day is spent by one debit unit')

  for (let i = 0; i < 30; i += 1) {
    await resetOpenReady(h)
    h.advance(1_000)
    await h.host.evaluate()
  }
  const warns = () => h.lines.filter((l) => l.level === 'warn' && l.msg.includes('order budget is spent'))
  assert.equal(warns().length, 1, 'thirty passes inside the minute: one line')
  assert.equal(h.client.requests.length, 1, 'and nothing routed')

  h.advance(60_000)
  await resetOpenReady(h)
  await h.host.evaluate()
  assert.equal(warns().length, 2, 'the next minute: a second line')
  // Thirty passes inside the minute: the FIRST of them is the line itself, the
  // other twenty-nine are what it stood for.
  assert.equal(warns()[1]?.ctx['suppressed'], 29, 'which carries the passes it stood for')
})

test('dl_max_orders_min: the count is ROUTED orders over REAL time, and the window rolls', async () => {
  /**
   * The host is what feeds the engine `ordersThisMinute`, and it counts wire
   * actions this book actually put out — not decisions, and not a per-pass
   * guess. The rule state is reseeded between passes so the only thing carried
   * across them is that count.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0, dl_max_orders_min: 2 }) })
  await warm(h)
  await h.host.evaluate()
  const first = routedActions(h)
  assert.equal(first, 2, 'the debit unit is two orders, which spends the whole minute budget')

  await resetOpenReady(h)
  h.advance(20_000) // well inside the minute; the reseed clears dl_adjust_cooldown_s anyway
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'the budget is spent — nothing more opens this minute')

  await resetOpenReady(h)
  h.advance(45_000) // 65 s from the first: the rolling minute has passed
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2, 'and the window rolls off on real time')
})

test('dl_max_orders_day: the session cap is the host’s alone, and it survives the minute rolling', async () => {
  // The engine cannot count a session from one tick either, so this is the other
  // half of R6. The minute window is deliberately let roll before the second
  // pass, so the only thing that can refuse it is the DAY counter.
  const h = make({ dials: leanDials({ confirm_ms: 0, dl_max_orders_day: 2 }) })
  await warm(h)
  await h.host.evaluate()
  assert.equal(routedActions(h), 2, 'the day budget is spent by one debit unit')

  await resetOpenReady(h)
  h.advance(65_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'no second unit today')
  const warn = h.lines.find((l) => l.level === 'warn' && l.msg.includes('order budget is spent'))
  assert.ok(warn !== undefined)
  assert.equal(warn.ctx['routedToday'], 2)
})

test('AN EXIT IS NEVER DROPPED BY A CAP — a book that cannot cut keeps the position', async () => {
  /**
   * The one rule that outranks the budget. Missing an add costs a trade; missing
   * a cut leaves the position the cut exists to remove, and no rate limit is
   * worth that. Three legs to close against a one-per-second cap: all three go.
   */
  const h = make({
    book: [
      legOf({ strike: 23_950, optType: 'CE', leanId: 'L1' }),
      legOf({ strike: 24_200, optType: 'CE', side: 'Sell', leanId: 'L1' }),
      legOf({ strike: 23_800, optType: 'PE', side: 'Sell', leanId: 'L1' }),
    ],
    dials: leanDials({ confirm_ms: 0, dl_max_orders_s: 1, dl_max_orders_min: 1, dl_max_orders_day: 1 }),
  })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  await h.host.evaluate()

  const req = h.client.requests[0]
  assert.ok(req !== undefined, 'the flatten goes out')
  assert.equal(req.actions.length, 3, 'every leg is closed, cap or no cap')
  assert.ok(req.actions.every((a) => a.op === 'close'))
})

test('a recenter book is NOT paced by the delta-lean caps', async () => {
  // The caps are delta-lean dials. Applying them to a book on the other engine
  // would be a live behaviour change smuggled in under a delta-lean ticket, so
  // the budget answers "unbounded" the moment the dial is off.
  const h = make({
    book: leanBook('L1'),
    dials: leanDials({ delta_lean_enabled: false, confirm_ms: 0, dl_max_orders_s: 0, dl_max_orders_day: 0 }),
  })
  await h.host.evaluate()
  assert.equal(
    h.lines.filter((l) => l.msg.includes('order budget is spent')).length,
    0,
    'the delta-lean budget never even ran',
  )
})

// ═══════════════════════════════ 6b. the strategy switch (spec E3, D3)

test('a switched-off FLAT book stands down: no decision, no seq, no mark, one WARN, and the page is told', async () => {
  /**
   * THE 09-16..09-18 STORM. `desk-strategies.modes.paper.enabled` was false
   * (the day guard had tripped, or a purge+re-register had come back without
   * the switch), the supervisor went on deciding, and desk-api refused every
   * package INVALID: 348 + 270 + 217 red rows across three books, each one a
   * burnt seq and a journal row. Every one of those books was FLAT — a legless
   * phantom deciding into a wall. A flat book whose switch is off has nothing
   * to protect and nothing it may do, so it IDLES: no mark consumed, no state
   * written, no decision formed, one line, and the page told why.
   */
  let on: boolean | null = false
  const h = make({ dials: leanDials({ confirm_ms: 0 }), switchedOn: () => on })
  for (let i = 0; i < 3; i += 1) {
    await h.host.evaluate()
    h.advance(1_000)
  }
  assert.equal(h.client.requests.length, 0, 'nothing is posted')
  const state = await h.state()
  assert.equal(state.seq, 0, 'no seq was burnt')
  assert.equal(state.updatedAt, 0, 'nothing was persisted at all — not even the mark')
  assert.equal(
    h.lines.filter((l) => l.level === 'warn' && /switch is OFF/.test(l.msg)).length,
    1,
    'said once, not once per pass',
  )
  assert.deepEqual(h.standDowns, ['switched off for paper — not deciding'])

  // The operator flips the switch back on: the very next pass decides.
  on = true
  await warm(h)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'deciding again, at once')
  assert.equal(h.lines.filter((l) => l.level === 'info' && /ON again/.test(l.msg)).length, 1)
  assert.equal(h.standDowns.at(-1), null, 'and the page is told it resumed')
})

test('a switched-off book that HOLDS legs still cuts, and only its opens are held', async () => {
  /**
   * NOT a full stand-down. desk-api's gate lets a reduce-only package through a
   * switched-off row (`routes/engine.ts`'s `reducesExposure`, `gateStrategy`'s
   * exemption): "added and switched off" is the operator's routine stop control
   * and it must still release what the book holds. So a switched-off book with
   * legs keeps deciding, its cuts route, and it is only NEW risk — a package
   * with an open in it — that is held.
   */
  const cut = make({
    book: leanBook('L1', 1),
    dials: leanDials({ confirm_ms: 0 }),
    switchedOn: () => false,
  })
  await cut.seed({ dlStopped: true, dlDayStarted: DATE })
  await cut.host.evaluate()
  const req = cut.client.requests[0]
  assert.ok(req !== undefined, 'the flatten goes out, switch or no switch')
  assert.ok(req.actions.every((a) => a.op === 'close'))

  // A held leg the lean did not open, on a trending tape: the engine wants to
  // open its unit, and that is exactly what a switched-off book may not do.
  const held = make({
    book: [legOf({ leanId: '', lots: 1 })],
    dials: leanDials({ confirm_ms: 0 }),
    switchedOn: () => false,
  })
  await warm(held)
  await held.host.evaluate()
  assert.equal(held.client.requests.length, 0, 'no new risk')
  assert.ok(
    held.lines.some((l) => l.level === 'warn' && /holding, no new risk/.test(String(l.ctx['reason']))),
    'and the hold names itself',
  )
})

test('an UNKNOWN switch (null) decides — the api gate is the guard', async () => {
  // No strategy row, or one that could not be read, is not "off": the desk-api
  // gate refuses the package on its own if it must (`UnknownStrategy`), and a
  // Mongo blip on the strategies collection must not stand every book down.
  const h = make({ dials: leanDials({ confirm_ms: 0 }), switchedOn: () => null })
  await warm(h)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1)
  assert.deepEqual(h.standDowns, [])
})

// ═══════════════════ 6c. a DONE whose every action was skipped (E3, layer 2)

/** desk-api's answer when the gate skipped every action of a package. */
const allSkipped = (decisionId: string, reason: string, n = 2): DecisionResponse => ({
  ...done(decisionId),
  skips: Array.from({ length: n }, (_, i) => ({ instrument: `x${String(i)}`, reason })),
})

test('a DONE with every open SKIPPED is folded as a refusal: the open stamp does NOT stick and nothing re-opens', async () => {
  /**
   * THE SECOND HALF OF THE STORM. desk-api does not 4xx a switched-off book's
   * package — it answers DONE with every action in `skips` and no fills. The
   * host settled that as a success: `stateAfter` stood, so `dlOpenedMs` was
   * stamped for a position that never existed, the budget was charged for
   * orders that never went out, and the next pass decided against a phantom
   * position. A package nothing of which routed is a refusal, and is rolled
   * back like one:
   * to the mark, seq burnt, flight cleared. And because the skip reason is
   * desk-api's own word that the switch is off, the host latches the
   * stand-down the same second rather than waiting for the next registry pass.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h)
  h.client.queue(allSkipped(`${TAG}:paper:1`, 'strategy TEST is switched off for paper'))
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1)
  const after = await h.state()
  assert.equal(after.ruleState.dlOpenedMs, 0, 'no phantom open is stamped')
  assert.equal(after.inFlight, null)
  assert.equal(after.workingPackage, null)
  assert.equal(after.seq, 1, 'the id is burnt, as for any refusal')
  assert.equal(
    h.lines.filter((l) => l.level === 'warn' && /SKIPPED every action/.test(l.msg)).length,
    1,
  )
  assert.deepEqual(h.standDowns.length, 1, 'the stand-down is latched at once')
  assert.match(String(h.standDowns[0]), /switched off for paper/)

  // No `switchedOn` dep is wired here (unknown), and unknown alone would decide
  // — but desk-api has just SAID the switch is off, so the latch holds.
  h.advance(20_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'held: nothing re-opens')

  // ...and not forever. Under a switch the host cannot read, a latch that
  // never expired would wedge a book the operator has since switched on, so
  // it re-probes once a minute rather than once every 2 s.
  h.advance(60_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2, 'one probe a minute under an unknown switch')
  // The probe is NOT the switch reading on: nothing read it. The line that
  // releases the latch must not say "ON again" for a switch that is unknown —
  // with a persistently-off row and an unreadable strategies collection that
  // would be a false INFO once a minute, ahead of the two true WARNs.
  assert.equal(
    h.lines.filter((l) => l.level === 'info' && /ON again/.test(l.msg)).length,
    0,
    'no "ON again" for a switch nobody read',
  )
  assert.ok(
    h.lines.some((l) => l.level === 'debug' && /UNKNOWN/.test(l.msg) && /prob/.test(l.msg)),
    'the probe says what it is, at DEBUG',
  )
  assert.equal(h.standDowns.at(-1), null, 'and the page is still told the latch let go')
})

test("the all-open fold is judged by the PACKAGE's engine, not by the dial as it reads when the DONE lands", async () => {
  /**
   * The every-OPEN arm of `allSkipped` belongs to the delta-lean engine. It
   * used to read `delta_lean_enabled` at DONE time, which is not when the
   * package was formed: an INDETERMINATE post is polled to its outcome later,
   * possibly by another process, and a dial flipped in between would judge
   * the fold with the wrong engine — a delta-lean lean whose every open was
   * skipped would SETTLE as a fill-less success (no WARN, the budget charge
   * left standing, the skip throttle reset) instead of being folded as the
   * refusal it is. The package's own `trigger` names the engine that formed
   * it (`dl-*` is the delta-lean path's alone — `types.ts` `TRIGGERS`),
   * travels with the working package and survives a restart, so that is what
   * the fold reads.
   *
   * The tell here is the fold itself, not the open stamp: on a POLLED outcome
   * the rollback target is gone (`#rollBack` with a `null` mark clears only
   * the flight), so `dlOpenedMs` stays whichever way the DONE is judged. That
   * is the replay path's own, older limitation, and not what this pins.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h)
  h.client.queue('INDETERMINATE')
  await h.host.evaluate()
  const req = h.client.requests[0]
  assert.ok(
    req !== undefined && req.trigger.startsWith('dl-') && req.actions.every((a) => a.op === 'open'),
    'precondition: a delta-lean all-open package is in flight',
  )
  assert.equal((await h.state()).inFlight, `${TAG}:paper:1`)

  // The dial flips while the package is in flight, and the DONE that resolves
  // it skipped every open for a reason that is not the switch.
  h.dials = leanDials({ confirm_ms: 0, delta_lean_enabled: false })
  h.client.queue({
    ...allSkipped(`${TAG}:paper:1`, 'open: no mark for x0', req.actions.length),
    replayed: true,
  })
  h.advance(1_000)
  await h.host.pollInFlight()

  const after = await h.state()
  assert.equal(after.inFlight, null, 'the flight resolved')
  assert.equal(after.workingPackage, null)
  assert.equal(
    h.lines.filter((l) => l.level === 'warn' && /SKIPPED every action/.test(l.msg)).length,
    1,
    'folded as a refusal although the dial read recenter when the DONE landed',
  )
  assert.deepEqual(h.standDowns, [], 'a skip that is not the switch latches no stand-down')
})

test('the stand-down REASON follows the book — legs to flat re-tells the page, without a second WARN', async () => {
  /**
   * `#standDown` is idempotent on the latch, and used to be idempotent on the
   * reason too: a switched-off book that stood down "holding, no new risk"
   * and then went flat (the operator closed its leg by hand) kept the first
   * string on the page for as long as the switch stayed off. One incident,
   * so one WARN — but the page says what the book is doing NOW.
   */
  const h = make({
    book: [legOf({ leanId: '', lots: 1 })],
    dials: leanDials({ confirm_ms: 0 }),
    switchedOn: () => false,
  })
  await warm(h)
  await h.host.evaluate()
  assert.deepEqual(h.standDowns, ['switched off for paper — holding, no new risk'])

  h.book = []
  h.advance(2_000)
  await h.host.evaluate()
  assert.deepEqual(h.standDowns, [
    'switched off for paper — holding, no new risk',
    'switched off for paper — not deciding',
  ])
  assert.equal(
    h.lines.filter((l) => l.level === 'warn' && /switch is OFF/.test(l.msg)).length,
    1,
    'one incident, one WARN',
  )

  // The same reason again is not a second report.
  h.advance(2_000)
  await h.host.evaluate()
  assert.equal(h.standDowns.length, 2)
})

test('a DONE with a skipped CLOSE is still settled, never rolled back', async () => {
  /**
   * The restriction on the fold. A skipped EXIT (`close: unknown leg`,
   * `close: no mark` — `book.ts`) is excluded on purpose: `dl-stuck` and
   * `dl-stop` latch `dlStopped` in `stateAfter` on the very tick that
   * flattens, and rolling that back to `markState` would un-latch a book the
   * engine just stopped. So only an all-OPEN package, or a package the GATE
   * skipped wholesale, is folded as a refusal; a skipped close settles
   * exactly as a DONE with no fills does.
   */
  const flatten = (): Harness =>
    make({ book: leanBook('L1', 1), dials: leanDials({ confirm_ms: 0 }) })
  const plain = flatten()
  await plain.seed({ dlStopped: true, dlDayStarted: DATE })
  await plain.host.evaluate()
  assert.ok(plain.client.requests[0]?.actions.every((a) => a.op === 'close'))

  const skipped = flatten()
  await skipped.seed({ dlStopped: true, dlDayStarted: DATE })
  skipped.client.queue(allSkipped(`${TAG}:paper:1`, 'close: unknown leg', 1))
  await skipped.host.evaluate()

  const a = await plain.state()
  const b = await skipped.state()
  assert.deepEqual(b.ruleState, a.ruleState, 'settled exactly as the DONE without skips')
  assert.equal(b.inFlight, null)
  assert.equal(
    skipped.lines.filter((l) => l.level === 'warn' && /SKIPPED every action/.test(l.msg)).length,
    0,
    'no refusal fold',
  )
  assert.deepEqual(skipped.standDowns, [])
})

test('a skipped package gives its orders back to the budget', async () => {
  /**
   * `#noteRouted` charges the budget BEFORE the post (that is where the
   * broker's rate limit sees it). A package desk-api skipped wholesale put
   * nothing on the wire, so what it charged is given back — or a day cap of 2
   * would be spent by two orders that never existed.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0, dl_max_orders_day: 2 }) })
  await warm(h)
  h.client.queue(allSkipped(`${TAG}:paper:1`, 'strategy TEST is not added to paper'))
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1)

  await resetOpenReady(h)
  h.advance(65_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2, 'the day room was restored')
  assert.equal(
    h.lines.filter((l) => l.level === 'warn' && l.msg.includes('order budget is spent')).length,
    0,
  )
})

// ═══════════════════ 6d. a persistent 4xx is paced, and said once a minute

test('a persistent REFUSAL is retried on the adjust cooldown, and the ERROR is once a minute', async () => {
  /**
   * `dl_adjust_cooldown_s` gates an ADJUSTMENT, not the book's first open —
   * `decide.ts`'s open branch checks only the confirm window (a book that
   * never opened has nothing to lose from an immediate retry); it is the
   * post-open branch that checks `sinceAdjust < dl_adjust_cooldown_s * 1000`.
   * So this pins a refused ADJUSTMENT: a book already opened 'up', with its
   * last adjustment's regime seeded to something the churn guard reads as
   * DIFFERENT from the live tape (`quiet` vs. this fixture's `trend-up`), so
   * an adjustment is wanted on every pass rather than blocked by "the same
   * regime already justified the last package".
   *
   * The adjust stamp `dlLastAdjustMs` only rides on `stateAfter`, which is
   * exactly what a rollback discards — so before this fold existed a
   * persistent 4xx was retried on EVERY 2s pass: one request, one ERROR and
   * one burnt seq each, for the session. Now the rollback keeps the adjust
   * stamp when the refused package had an open in it, and the cooldown paces
   * the retry; the ERROR is once a minute with the count.
   *
   * The book is a REAL two-leg package — the long 23,950 call and the short
   * 24,200 call `debitUnit` opens an 'up' book with — and not an empty leg
   * list beside a non-zero `dlOpenedMs`. §6.2 now HOLDS an opened book that
   * holds nothing ("the day's package is gone — nothing to adjust"), because a
   * net delta of zero read as a `lean` shortfall is how a flattened book buys
   * a naked pyramid; a legless fixture would route nothing at all and this
   * test would pass on an empty request list.
   */
  const h = make({
    book: [
      legOf({ strike: 23_950, optType: 'CE', side: 'Buy', lots: 2, entry: midAt(23_950, 'CE') }),
      legOf({ strike: 24_200, optType: 'CE', side: 'Sell', lots: 2, entry: midAt(24_200, 'CE') }),
    ],
    dials: leanDials({ confirm_ms: 0 }),
  })
  await warmOpened(h, 'up', 'trend-up', { dlLastAdjustRegime: 'quiet' })
  assert.equal(h.dials.cooldown_s, 0, 'the preset really does disarm cooldown_s')
  assert.equal(h.dials.dl_adjust_cooldown_s, 600)
  for (let i = 0; i < 20; i += 1) h.client.queue(new RefusedError(400, 'x'))

  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1)
  assert.equal(
    h.client.requests[0]?.trigger,
    'dl-add',
    'the fixture book really does want a pyramid — not an exit and not an open',
  )
  assert.equal((await h.state()).ruleState.dlLastAdjustMs, h.now, 'the adjust stamp survives the rollback')

  // Still inside the cooldown, naturally: the stamp the rollback just kept is
  // this same tick's `nowMs`, and `dlLastAdjustRegime` reverted to 'quiet' —
  // the rollback discards everything BUT the stamp — so the churn guard still
  // reads a wanted adjustment on the very next pass.
  h.advance(1_000) // clears the per-second burst window only; nowhere near dl_slow_window_s (300s)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'still inside dl_adjust_cooldown_s, no retry')

  // The 600s cooldown itself is simulated on the STATE clock, not the wall
  // clock: `dl_slow_window_s` is 300s, so advancing `h.now` a full 600s+ would
  // walk the regime detector's window past the fixture's ramp entirely and
  // off 'trend-up' — a confound this test does not exist to pin.
  h.advance(1_000)
  await h.seed({ dlLastAdjustMs: h.now - 601_000 })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2, 'past the cooldown: the retry goes, under a new id')
  assert.equal(h.client.requests[1]?.decisionId, `${TAG}:paper:2`)
  const errors = () => h.lines.filter((l) => l.level === 'error' && /REFUSED/.test(l.msg))
  assert.equal(errors().length, 1, 'two refusals inside the minute: one line')

  // NOW the wall clock has to move — the once-a-minute throttle buckets on
  // real time — but 60s alone leaves most of the 300s slow window still
  // inside the ramp, so 'trend-up' still reads. The cooldown stamp is
  // reseeded past the cooldown again, on the new `h.now`.
  h.advance(60_000)
  await h.seed({ dlLastAdjustMs: h.now - 601_000 })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 3)
  assert.equal(errors().length, 2)
  assert.ok(Number(errors()[1]?.ctx['suppressed']) >= 1, 'which says what it stood for')
  assert.ok(typeof errors()[1]?.ctx['guidance'] === 'string', 'and keeps the per-status guidance')
})

test('a refused package keeps its adjust stamp, so the retry is paced', async () => {
  /**
   * Both delta-lean presets set `cooldown_s: 0`, so `lastActionMs` paces
   * nothing on this engine. What stands between a persistent 4xx and an
   * identical package every tick is `dlLastAdjustMs` → `dl_adjust_cooldown_s` —
   * and that stamp rides on `stateAfter` alone, which is exactly what a
   * rollback discards. So the rollback KEEPS it when the refused package had
   * an open in it, and a persistent 4xx costs one request every ten minutes
   * rather than one every two seconds.
   */
  // confirm_ms: 0 — the same reason every other refusal test here disarms it:
  // this pins the rollback's stamp-keeping, not the confirm window. The regime
  // is seeded already past `dl_adjust_confirm_s` too, for the same reason as
  // the confirm-window test above: a fresh state's own clock reads 0s held.
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await h.seed({ dlDayStarted: DATE, dlRegime: 'trend-up', dlRegimeSinceMs: T0 - 61_000 })
  h.client.queue(new RefusedError(400, 'strategy is switched off for paper'))
  await h.host.evaluate()
  const after = await h.state()
  assert.equal(after.ruleState.dlLastAdjustMs, h.now, 'the stamp survived the rollback')
  assert.equal(after.ruleState.dlOpenedMs, 0, 'but nothing else did — the book did NOT open')
  assert.equal(after.ruleState.dlAdjustsToday, 0, 'and a refused package burns no adjustment')
})

test('a refused EXIT is paced by nothing — nothing may delay an exit', async () => {
  const h = make({ book: leanBook('L1'), dials: leanDials() })
  await h.seed({ dlStopped: true, dlDayStarted: DATE })
  h.client.queue(new RefusedError(400, 'boom'))
  await h.host.evaluate()
  const after = await h.state()
  assert.equal(after.ruleState.dlLastAdjustMs, 0, 'an exit carries no open, so no stamp is kept')
})

test('a refusal after a package that SETTLED is a fresh incident, said at once', async () => {
  /**
   * The throttle is for a condition that PERSISTS. One that CLEARS — a
   * refusal at T, a package that settles at T+10 s — and then returns with a
   * different status and a different cause must be reported the moment it
   * returns, not swallowed until the first incident's minute is up with its
   * count folded into the old one. The Throttle's `reset()` exists for this,
   * and the registry's start-failure throttle already uses it; the host's
   * three did not.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h)
  const errors = () => h.lines.filter((l) => l.level === 'error' && /REFUSED/.test(l.msg))
  h.client.queue(new RefusedError(400, 'x'))
  await h.host.evaluate()
  assert.equal(errors().length, 1)

  // The condition clears: the next package is accepted and settles.
  await resetOpenReady(h)
  h.advance(10_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2)
  assert.equal((await h.state()).inFlight, null, 'settled')

  // A NEW refusal, 20 s later — inside the first one's minute.
  await resetOpenReady(h)
  h.advance(20_000)
  h.client.queue(new RefusedError(404, 'gone'))
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 3)
  assert.equal(errors().length, 2, 'the first ERROR of a fresh incident is not lost')
  assert.equal(errors()[1]?.ctx['status'], 404)
  assert.equal(errors()[1]?.ctx['suppressed'], 0, 'and it carries no count from the old one')
})

test('an all-skipped DONE after a package that SETTLED is a fresh incident too', async () => {
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h)
  const warns = () => h.lines.filter((l) => l.level === 'warn' && /SKIPPED every action/.test(l.msg))
  // Not the switch's word: that would latch the stand-down and hold the
  // probe. A gate reason that skips without latching keeps the book posting.
  h.client.queue(allSkipped(`${TAG}:paper:1`, 'strategy TEST is not added to paper'))
  await h.host.evaluate()
  assert.equal(warns().length, 1)

  await resetOpenReady(h)
  h.advance(10_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 2, 'settled in between')

  await resetOpenReady(h)
  h.advance(20_000)
  h.client.queue(allSkipped(`${TAG}:paper:3`, 'strategy TEST is not added to paper'))
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 3)
  assert.equal(warns().length, 2, 'said at once')
  assert.equal(warns()[1]?.ctx['suppressed'], 0)
})

test('a budget that is spent AGAIN after a package routed is a fresh incident', async () => {
  /**
   * The one host-only cap that can clear and return inside a minute is the
   * per-second one, through a RETUNE (`dials()` is read every pass, and the
   * registry lands a dial change live): `dl_max_orders_s: 0` is "no opens"
   * and is exhausted on every pass; restored, a package routes — the
   * condition cleared — and set to 0 again it is spent afresh. The minute
   * cap cannot stage this (the engine's own `pace` holds the package first,
   * on the same count) and the day cap only clears at IST midnight.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0, dl_max_orders_s: 0 }) })
  await warm(h)
  const warns = () => h.lines.filter((l) => l.level === 'warn' && l.msg.includes('order budget is spent'))
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0)
  assert.equal(warns().length, 1)

  // The cap is restored: the package routes.
  h.dials = leanDials({ confirm_ms: 0 })
  h.advance(10_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'the condition cleared')

  // ...and set to 0 again, 20 s later — inside the first WARN's minute.
  h.dials = leanDials({ confirm_ms: 0, dl_max_orders_s: 0 })
  await resetOpenReady(h)
  h.advance(20_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 1, 'spent again')
  assert.equal(warns().length, 2, 'and said at once, not when the old minute is up')
  assert.equal(warns()[1]?.ctx['suppressed'], 0)
})

// ═══════════════════════════════════ 7. the day's own realised P&L (h)

test('a realised close folds into dlDayRealized as well as cumRealized', async () => {
  /**
   * Spec §7. `cumRealized` is the TAG's bank and drives `totalPnl`, which is
   * what the backstop, the target and the stuck rule all read. `dlDayRealized`
   * is this DAY's half of the same money, kept for the ledger and the run page
   * so an operator can see what was banked without subtracting a mark. The
   * engine reads it nowhere — which is exactly why it has to be written here or
   * it is permanently 0 and silently wrong.
   */
  const h = make({ book: leanBook('L1'), dials: leanDials({ confirm_ms: 0 }) })
  await h.seed({ dlStopped: true, dlDayStarted: DATE, dlDayRealized: 1_000 })
  // Bought at 200, closed at 260, two lots of 65 — above the leg's entry, a gain.
  h.client.queue(
    done(`${TAG}:paper:1`, [
      { instrument: instrumentOf(23_950, 'CE'), side: 'Sell', qty: 2 * LOT, price: 260 },
    ]),
  )
  const before = await h.state()
  await h.host.evaluate()

  const after = await h.state()
  const banked = after.cumRealized - before.cumRealized
  assert.ok(banked > 0, 'the fill banked something')
  assert.equal(
    after.ruleState.dlDayRealized,
    before.ruleState.dlDayRealized + banked,
    'the same rupees, counted for the day as well as for the tag',
  )
})

test('a package that opens and banks nothing leaves dlDayRealized alone', async () => {
  /**
   * Trivially true if nothing routes at all — a fresh state's own regime
   * clock reads 0s held, `#settle` never runs, and an unmoved `dlDayRealized`
   * proves nothing about the fold. So the book is warmed to actually open
   * (`trigger` is asserted below), and its long leg is filled at its own open
   * mid: an `op: 'open'` fill skips `#settle`'s bank line regardless of price
   * (`if (b.op !== 'open') { ...banked += gain... }`), so this is the honest
   * "opened, nothing yet to realise" case rather than a contrived DONE with
   * no fills at all.
   */
  const h = make({ dials: leanDials({ confirm_ms: 0 }) })
  await warm(h, 'trend-up', { dlDayRealized: 4_200 })
  const openMid = (bookAt(23_950, 'CE').bid ?? 0) + (bookAt(23_950, 'CE').ask ?? 0)
  h.client.queue(
    done(`${TAG}:paper:1`, [
      { instrument: instrumentOf(23_950, 'CE'), side: 'Buy', qty: 4 * LOT, price: openMid / 2 },
    ]),
  )
  await h.host.evaluate()
  const req = h.client.requests[0]
  assert.ok(req !== undefined, 'a package actually routed — the fixture is not vacuous')
  assert.equal(req.trigger, 'dl-open')
  const after = await h.state()
  assert.equal(after.ruleState.dlDayRealized, 4_200)
})

// ─────────────────────────────────────────────────────────── the fixture

test('the fixture board really does price the bands the controller selects on', () => {
  // A guard on this file rather than on the code: if the surface stopped
  // producing a ~0.55-0.65 long and a ~0.20-0.30 short, the "add" tests above
  // would stop opening anything and would pass for the wrong reason.
  const long = deltaOf(23_950, 'CE')
  const short = deltaOf(24_200, 'CE')
  assert.ok(long >= 0.5 && long <= 0.65, `the debit long is ${String(long)}`)
  assert.ok(short >= 0.2 && short <= 0.32, `the debit short is ${String(short)}`)
})

// ══════════════════════════════════ hold to expiry (spec 2026-10-05)

test('HOLD: the book\'s expiry reaches the engine — no ladder at 15:01 before it, the ladder on it', async () => {
  /**
   * `DeltaLeanInputs.expiry` is the registry row's `expiry`, and the host
   * states it off the chain it snapped for that row (`main.ts` snaps
   * `runtime.book.expiry`). A hold book's clock ladder runs only when that is
   * today, so the pair below differs in ONE thing — the snapped contract's
   * expiry — and the 15:01 tick is a carry on one and the ladder on the other.
   */
  const dials = leanDials({ confirm_ms: 0, dl_hold_to_expiry: true })

  // 2026-09-16 15:01, contract 2026-09-22: the carry.
  const carry = make({ book: leanBook('L1'), dials })
  await warmOpened(carry, 'up')
  carry.advance(MIN_TO_1501)
  await carry.host.evaluate()
  assert.ok(
    carry.client.requests.every((r) => r.trigger !== 'eod' && r.actions.every((a) => a.op !== 'close')),
    `nothing closes on a non-expiry day. Got: ${carry.client.requests.map((r) => r.trigger).join(', ')}`,
  )
  assert.equal((await carry.state()).ruleState.dlStopped, false)

  // The same tick on the contract's own expiry day: the ladder, from the host.
  const h = make({ book: leanBook('L1'), dials })
  await warmOpened(h, 'up')
  h.advance(MIN_TO_1501)
  const expiring = new EngineHost({
    tag: TAG,
    mode: 'paper',
    dials: () => h.dials,
    snap: () => ({ ...chainOf(h.now), expiry: DATE }),
    readBook: async () => h.book,
    margin: (): MarginInput => ({ value: 0, source: 'broker', asOf: T0, fresh: true }),
    instrumentFor: instrumentOf,
    repairHold: async () => false,
    store: h.store,
    client: h.client,
    now: () => h.now,
    log: fakeLog().log,
    ring: h.ring,
    spotAsOf: () => h.now,
    cancelWorking: async (): Promise<CancelOutcome> => ({ requested: 0, failed: 0 }),
  })
  await expiring.evaluate()
  const req = h.client.requests[0]
  assert.ok(req !== undefined, 'the expiry-day 15:01 tick routes the flatten')
  assert.equal(req.trigger, 'eod')
  assert.ok(req.actions.every((a) => a.op === 'close'))
})
