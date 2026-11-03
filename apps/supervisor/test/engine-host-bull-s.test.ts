/**
 * BULL-S, WIRED TO THE SAME RAILS — the host around `decideBullS` on Delta.
 *
 * `decideBullS` is proved in `desk-engine/test/bull-s/*`. This file is about
 * what only the host can get wrong:
 *
 *   1. **THE DISPATCH.** `bs_enabled` takes the BULL-S path, with the index
 *      (the `md.spot` ring, at its own stamp) as the reference and the minutes
 *      to the venue's 12:00 UTC instant.
 *   2. **THE WIRE.** 50 contracts of 0.001 BTC is `qty 0.05` per leg, PE then
 *      CE — never the `Math.round` that made it 0.
 *   3. **A 24x7 BOOK.** At 20:00 IST a DX book is marked and decided.
 *   4. **NO DAMPING.** An entry is a crossing seen once; a damped pass would
 *      spend it and the entry would never be proposed again.
 *   5. **EXITS PRE-EMPT ENTRIES.** A stop with an entry still working cancels
 *      the entry first, as a delta-lean exit cancels an add.
 *   6. **A RESTART MID-ENTRY.** A hydrated half straddle (PE held, CE not) is
 *      neither re-entered nor dropped.
 *   7. **NET OF FEES.** `cumRealized` banks every fill's fee.
 *
 * No Mongo, no network, no wall clock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRESETS,
  SpotRing,
  resolveDials,
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
import { BS_EMPTY, type BullSGroup } from '../../../packages/desk-engine/src/bull-s/state.ts'
import { DX } from '@algomaker/venue'
import type { DeskAlert } from '@algomaker/core'
import { BS_EXIT_TRIGGERS, EngineHost, MarkClock, type CancelOutcome, type HostLog } from '../src/engine-host.ts'
import type { MarkSample } from '../src/engine-host.ts'
import { StateStore, type StateCollection, type SupervisorBookState } from '../src/state-store.ts'

// ────────────────────────────────────────────────────────────── the market

const TAG = 'BTC-2026-11-04-bull-s-daily'
const EXPIRY = '2026-11-04'
/** 2026-11-03 14:30 UTC = 20:00 IST — after NSE's close, inside Delta's day. */
const T0 = Date.parse('2026-11-03T14:30:00.000Z')
const INDEX = 76_592
const STEP = 200
const LOT = 0.001
const LADDER = Array.from({ length: 13 }, (_, i) => 75_400 + i * STEP)

const q = (bid: number, ask: number, asOf: number): Quote => ({ bid, ask, ltp: (bid + ask) / 2, asOf })

/** Premiums that fall away from the money, both wings quoted. */
function premium(strike: number, opt: OptType): number {
  const intrinsic = opt === 'CE' ? Math.max(0, INDEX - strike) : Math.max(0, strike - INDEX)
  return Math.round((intrinsic + 400 * Math.exp(-Math.abs(strike - INDEX) / 1500)) * 10) / 10
}

const instrumentOf = (strike: number, opt: OptType): string =>
  `${opt === 'CE' ? 'C' : 'P'}-BTC-${String(strike)}-041126`

function chainOf(asOf: number, bump: (strike: number, opt: OptType) => number = () => 1): ChainSnap {
  return {
    symbol: 'BTC',
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: { bid: null, ask: null, ltp: INDEX, asOf },
    spot: INDEX,
    strikes: LADDER.map((k) => ({
      strike: k,
      ce: q(premium(k, 'CE') * bump(k, 'CE') - 1, premium(k, 'CE') * bump(k, 'CE') + 1, asOf),
      pe: q(premium(k, 'PE') * bump(k, 'PE') - 1, premium(k, 'PE') * bump(k, 'PE') + 1, asOf),
    })),
    asOf,
  }
}

function legOf(strike: number, opt: OptType, entry: number, lots = 50): LegPosition {
  return {
    instrument: instrumentOf(strike, opt),
    strike,
    optType: opt,
    side: 'Sell',
    lots,
    lotSize: LOT,
    entry,
    openedByEngine: true,
    leanId: '',
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
    if (doc !== undefined) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
    this.docs.set(key, structuredClone(set))
    return null
  }

  async createIndex(): Promise<unknown> {
    return null
  }
}

const respond = (decisionId: string, status: DecisionResponse['status'], fills: WireFill[] = []): DecisionResponse => ({
  decisionId,
  replayed: false,
  status,
  fills,
  skips: [],
  routeErrors: [],
})

class FakeClient {
  readonly requests: DecisionRequest[] = []
  #answers: Array<(req: DecisionRequest) => DecisionResponse> = []

  queue(...answers: Array<(req: DecisionRequest) => DecisionResponse>): void {
    this.#answers.push(...answers)
  }

  async submit(req: DecisionRequest): Promise<DecisionResponse> {
    this.requests.push(structuredClone(req))
    return (this.#answers.shift() ?? ((r) => respond(r.decisionId, 'DONE')))(req)
  }
}

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

function dailyDials(over: Partial<Dials> = {}): Dials {
  const preset = PRESETS.find((p) => p.key === 'bull-s-btc-daily')
  assert.ok(preset !== undefined, 'the daily BULL-S preset must exist')
  const { dials, unknown } = resolveDials(preset.dials as Record<string, number | boolean>)
  assert.deepEqual(unknown, [])
  return { ...dials, ...over }
}

interface Harness {
  readonly host: EngineHost
  readonly client: FakeClient
  readonly store: StateStore
  readonly lines: Line[]
  readonly ring: SpotRing
  readonly cancels: string[]
  readonly samples: MarkSample[]
  /** Every pass's reason, as the page's last-decision line receives it. */
  readonly reasons: string[]
  /** Every alert the host raised, in order. */
  readonly alerts: DeskAlert[]
  book: LegPosition[]
  dials: Dials
  chain: (asOf: number) => ChainSnap
  now: number
  /** Advance the clock, with an index print at the new instant. */
  advance(ms: number, index?: number): void
  state(): Promise<SupervisorBookState>
  seed(rule: Partial<RuleState>): Promise<void>
}

function make(over: { book?: LegPosition[]; dials?: Dials; index?: number; leverage?: number | null } = {}): Harness {
  const store = new StateStore(new FakeStateCollection())
  const client = new FakeClient()
  const { log, lines } = fakeLog()
  const ring = new SpotRing(4096)
  ring.push({ ms: T0, spot: over.index ?? INDEX })
  const h = {
    client,
    store,
    lines,
    ring,
    cancels: [] as string[],
    samples: [] as MarkSample[],
    reasons: [] as string[],
    alerts: [] as DeskAlert[],
    book: over.book ?? [],
    dials: over.dials ?? dailyDials(),
    chain: (asOf: number) => chainOf(asOf),
    now: T0,
    advance: (ms: number, index = INDEX): void => {
      h.now += ms
      ring.push({ ms: h.now, spot: index })
    },
    state: async (): Promise<SupervisorBookState> => await store.load(TAG, 'paper'),
    seed: async (rule: Partial<RuleState>): Promise<void> => {
      const prev = await store.load(TAG, 'paper')
      await store.save(prev, { ...prev, ruleState: { ...prev.ruleState, ...rule }, updatedAt: prev.updatedAt + 1 })
    },
  } as Harness
  const host = new EngineHost({
    tag: TAG,
    mode: 'paper',
    venue: DX,
    dials: () => h.dials,
    snap: () => h.chain(h.now),
    readBook: async () => h.book,
    margin: (): MarginInput => ({ value: 0, source: 'broker', asOf: T0, fresh: true }),
    instrumentFor: instrumentOf,
    tickSizeFor: () => 0.1,
    ...(over.leverage === undefined ? {} : { leverageFor: () => over.leverage ?? null }),
    repairHold: async () => false,
    store,
    client,
    now: () => h.now,
    log,
    ring,
    spotAsOf: () => ring.latest()?.ms ?? 0,
    alert: (a: DeskAlert): void => {
      h.alerts.push(a)
    },
    onDecision: (reason: string): void => {
      h.reasons.push(reason)
    },
    onMark: (sample: MarkSample): void => {
      h.samples.push(sample)
    },
    cancelWorking: async (decisionId: string): Promise<CancelOutcome> => {
      h.cancels.push(decisionId)
      return { requested: 1, failed: 0 }
    },
  })
  return Object.assign(h, { host })
}

const opens = (r: DecisionRequest | undefined): Array<{ instrument: string; side: string; qty: number }> =>
  (r?.actions ?? []).flatMap((a) => (a.op === 'open' ? [{ instrument: a.instrument, side: a.side, qty: a.qty }] : []))

// ═════════════════════════════════════════════════════════════════ tests

test('the BULL-S exit set is pinned: stop, target, loss, flat, close, expiry — never an entry', () => {
  assert.deepEqual([...BS_EXIT_TRIGGERS].sort(), [
    'bs-balance', 'bs-close', 'bs-expiry', 'bs-flat', 'bs-loss', 'bs-stale', 'bs-stop', 'bs-target',
  ])
})

test('bs_enabled at 20:00 IST: the first fresh index print sells the nearest level, 0.05 BTC a leg, PE then CE', async () => {
  const h = make()
  await h.host.evaluate()
  const req = h.client.requests[0]
  assert.ok(req !== undefined, 'a DX book decides after the NSE close')
  assert.equal(req.trigger, 'bs-entry')
  assert.deepEqual(opens(req), [
    { instrument: 'P-BTC-76600-041126', side: 'Sell', qty: 0.05 },
    { instrument: 'C-BTC-76600-041126', side: 'Sell', qty: 0.05 },
  ])
  // Routed on the FIRST pass, under the preset's 5 s confirm_ms: not damped.
  assert.ok(h.dials.confirm_ms > 0)
  // And the mark was journalled off the venue's day, not frozen at 15:30 IST.
  assert.equal(h.samples.length, 1)
})

test('a crossing is spent on the pass that sees it — the host never sits on it until it is gone', async () => {
  // The same book, armed and baselined on the first print, then the index
  // crosses 76,800. One pass, one package; no "intent armed" wait in between.
  const h = make({ dials: dailyDials({ bs_enter_on_start: false }) })
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'no entry on start when the dial says so')
  h.advance(1_000, 76_810)
  await h.host.evaluate()
  const req = h.client.requests[0]
  assert.equal(req?.trigger, 'bs-entry')
  assert.deepEqual(opens(req).map((o) => o.instrument), ['P-BTC-76800-041126', 'C-BTC-76800-041126'])
})

test('a stale index print: no entry, and nothing routed', async () => {
  // The only print is ten minutes old — past bs_ref_max_age_s (10 s).
  const h = make()
  h.now = T0 + 600_000
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0)
})

test('a STOP cancels the working entry before anything else — exits outrank entries', async () => {
  const h = make()
  h.client.queue((r) => respond(r.decisionId, 'WORKING'))
  await h.host.evaluate()
  const entry = h.client.requests[0]?.decisionId
  assert.ok(entry !== undefined)
  assert.equal((await h.state()).inFlight, entry, 'the entry is working')

  // The PE filled, the CE is still working; then the market runs through the
  // stop on both wings and holds there past bs_stop_confirm_s.
  const pe = premium(76_600, 'PE') - 1
  h.book = [legOf(76_600, 'PE', pe)]
  h.chain = (asOf) => chainOf(asOf, (k) => (k === 76_600 ? 2 : 1))
  h.advance(1_000)
  await h.host.evaluate()
  h.advance(4_000)
  await h.host.evaluate()

  assert.deepEqual(h.cancels.slice(0, 1), [entry], 'the working entry is taken off the market first')
  assert.ok(h.lines.some((l) => l.level === 'warn' && l.msg.includes('bs-stop')))
  assert.equal(h.client.requests.length, 1, 'cancel first; the stop routes once the flight is terminal')
})

test('a restart with a half straddle (PE held, CE not) neither re-enters the level nor drops the PE', async () => {
  const pe = premium(76_600, 'PE') - 1
  const group: BullSGroup = {
    strike: 76_600,
    lots: 50,
    ceEntry: premium(76_600, 'CE') - 1,
    peEntry: pe,
    openedMs: T0 - 60_000,
    ceOpen: false,
    peOpen: true,
    breachSinceMs: 0,
    staleSinceMs: 0,
    filled: false,
  }
  const h = make({ book: [legOf(76_600, 'PE', pe)] })
  await h.seed({
    bs: {
      ...BS_EMPTY,
      groups: [group],
      size: 100,
      lastRef: INDEX,
      lastRefMs: T0 - 1_000,
      armedAtMs: T0 - 120_000,
    },
  })
  await h.host.evaluate()
  const sent = h.client.requests.flatMap((r) => r.actions)
  assert.equal(
    sent.some((a) => a.op === 'open' && a.instrument.includes('-76600-')),
    false,
    'the level is not sold a second time',
  )
  // Nothing is working, so the half straddle is CLOSED rather than left naked.
  assert.equal(h.client.requests.length, 1)
  assert.equal(h.client.requests[0]?.trigger, 'bs-stop')
  assert.deepEqual(sent.map((a) => [a.op, a.instrument]), [['close', 'P-BTC-76600-041126']])
})

/** A restart with the entry's PE held and its CE still working, the entry sent `ageMs` ago. */
async function stuckCe(ageMs: number): Promise<Harness> {
  const pe = premium(76_600, 'PE') - 1
  const h = make({ book: [legOf(76_600, 'PE', pe)] })
  await h.seed({
    bs: {
      ...BS_EMPTY,
      groups: [{
        strike: 76_600, lots: 50, ceEntry: premium(76_600, 'CE') - 1, peEntry: pe,
        openedMs: T0 - ageMs, ceOpen: true, peOpen: true, breachSinceMs: 0, filled: false, staleSinceMs: 0,
      }],
      size: 100,
      lastRef: INDEX,
      lastRefMs: T0 - 1_000,
      armedAtMs: T0 - 120_000,
    },
  })
  // The CE is still on the market from before the restart.
  const prev = await h.state()
  await h.store.save(prev, {
    ...prev,
    inFlight: `${TAG}:paper:7`,
    workingPackage: {
      decisionId: `${TAG}:paper:7`,
      remaining: [{ op: 'open', instrument: 'C-BTC-76600-041126', side: 'Sell', qty: 0.05 }],
      request: {
        tag: TAG, mode: 'paper', decisionId: `${TAG}:paper:7`, symbol: 'BTC', expiry: EXPIRY,
        trigger: 'bs-entry', reason: 'entry',
        actions: [{ op: 'open', instrument: 'C-BTC-76600-041126', side: 'Sell', qty: 0.05 }],
      },
      basis: [{
        instrument: 'C-BTC-76600-041126', op: 'open', side: 'Sell', strike: 76_600, optType: 'CE',
        entry: premium(76_600, 'CE') - 1, lots: 50, lotSize: LOT, intentQty: 0.05, leanId: '',
      }],
      formedAt: T0 - 2_000,
      formedSpot: INDEX,
    },
    seq: 7,
    updatedAt: prev.updatedAt + 1,
  } as SupervisorBookState)
  h.client.queue((r) => respond(r.decisionId, 'WORKING'))
  return h
}

test('a restart with the CE still working (inside the grace) keeps the half straddle and adopts nothing', async () => {
  const h = await stuckCe(10_000)
  await h.host.evaluate()
  // The CE is still on the market: nothing new is sent, nothing is adopted,
  // and the half straddle keeps both legs on its record until the flight ends.
  assert.equal(h.client.requests.length, 0)
  const after = (await h.state()).ruleState.bs
  assert.deepEqual(after.groups.map((g) => [g.strike, g.ceOpen, g.peOpen]), [[76_600, true, true]])
  assert.ok(h.lines.some((l) => l.msg === 'holding under a working package' && String(l.ctx['reason']).includes('still working')))
})

test('the CE STUCK past the grace: the stuck entry is cancelled first, so the naked PE can be closed', async () => {
  const h = await stuckCe(60_000)
  await h.host.evaluate()
  assert.deepEqual(h.cancels, [`${TAG}:paper:7`], 'the stuck CE entry is taken off the market')
  assert.ok(h.lines.some((l) => l.level === 'warn' && l.msg.includes('bs-stop')), 'a bs-stop preempts the working entry')
})

test('cumRealized banks NET of the fee on every fill, the open as well as the close', async () => {
  const h = make()
  h.client.queue((r) =>
    respond(r.decisionId, 'DONE', [
      { instrument: 'P-BTC-76600-041126', side: 'Sell', qty: 0.05, price: 200, fee: 0.4 },
      { instrument: 'C-BTC-76600-041126', side: 'Sell', qty: 0.05, price: 210, fee: 0.38 },
    ]),
  )
  await h.host.evaluate()
  const s = await h.state()
  assert.equal(Number(s.cumRealized.toFixed(6)), -0.78, 'an open realises nothing but pays its fee')
})

test('MarkClock on DX marks every 5 minutes around the clock, counted from 12:00 UTC', () => {
  const c = new MarkClock(DX)
  const a = c.next(Date.parse('2026-11-03T14:30:00Z'))
  assert.equal(a.isNewMark, true)
  assert.equal(a.markIndexToday, (150 / 5))
  assert.equal(c.next(Date.parse('2026-11-03T14:34:59Z')).isNewMark, false)
  assert.equal(c.next(Date.parse('2026-11-03T14:35:00Z')).isNewMark, true)
  // 01:00 IST: NSE's grid would have frozen at 15:30 hours ago.
  assert.equal(c.next(Date.parse('2026-11-03T19:30:00Z')).isNewMark, true)
  // A new settlement day restarts the count.
  assert.equal(c.next(Date.parse('2026-11-04T12:00:00Z')).markIndexToday, 0)
})

/** The chain as the host sees it in the first seconds after a book starts: listed, nothing quoted. */
function unquoted(asOf: number): ChainSnap {
  const c = chainOf(asOf)
  return { ...c, strikes: c.strikes.map((s) => ({ strike: s.strike, ce: null, pe: null })) }
}

test('3 Nov: a book whose first index print beats its first option tick enters as soon as the quotes land', async () => {
  // Live, the six books decided 2 s after start, before any option tick, and
  // the start entry was spent — they traded only on a later crossing, minutes
  // on. The start now waits for the level's quotes.
  const h = make()
  h.chain = unquoted
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'nothing to sell at yet')
  h.chain = (asOf) => chainOf(asOf)
  h.advance(1_000)
  await h.host.evaluate()
  assert.equal(h.client.requests[0]?.trigger, 'bs-entry')
  assert.deepEqual(opens(h.client.requests[0]).map((o) => o.instrument), ['P-BTC-76600-041126', 'C-BTC-76600-041126'])
})

test('3 Nov: a jump-2 book sells the nearest level of ITS grid on start, once quoted — not only on a crossing', async () => {
  // daily-2 and monthly-2 never entered: their start levels (77200 on a 400
  // grid, 78000 on a 2000 grid) were spent unquoted, and the index never moved
  // far enough to cross a level of the wider grid. On a 400 grid at 76,592 the
  // nearest level is 76,400 — a listed strike.
  const h = make({ dials: dailyDials({ bs_strike_jump: 2 }) })
  h.chain = unquoted
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0)
  h.chain = (asOf) => chainOf(asOf)
  h.advance(1_000)
  await h.host.evaluate()
  assert.deepEqual(opens(h.client.requests[0]).map((o) => o.instrument), ['P-BTC-76400-041126', 'C-BTC-76400-041126'])
})

// ── a refused entry (demo, 3 Nov: OI cap → only_reduce_only_orders_allowed) ──

const OI_CAP = 'oi-cap: 76600 open interest at the venue cap'

test('a refused entry: the size stays, the level cools, and the oi-cap reason reaches the book\'s last-decision line', async () => {
  const h = make()
  // Both orders refused by the gateway's whole-package OI cap: DONE, nothing filled.
  h.client.queue((r) => ({
    ...respond(r.decisionId, 'DONE', []),
    skips: [
      { instrument: 'P-BTC-76600-041126', reason: OI_CAP },
      { instrument: 'C-BTC-76600-041126', reason: OI_CAP },
    ],
  }))
  await h.host.evaluate()
  assert.equal(h.client.requests[0]?.trigger, 'bs-entry')
  assert.equal((await h.state()).ruleState.bs.entryRefusal, OI_CAP, 'the host recorded why')

  h.advance(1_000)
  await h.host.evaluate()
  const bs = (await h.state()).ruleState.bs
  assert.equal(bs.size, 50, 'the pyramid did not step on an entry that never opened')
  assert.deepEqual(bs.cooldowns.map((c) => c.strike), [76_600])
  assert.equal(bs.entryRefusal, '')
  const line = h.reasons.at(-1) ?? ''
  assert.match(line, /entry at 76600 was refused \(oi-cap: 76600 open interest at the venue cap\): size stays 50, level cools down 300s/)
  // And it stays on the line while the level cools, not only on the pass that found it.
  h.advance(30_000)
  await h.host.evaluate()
  assert.match(h.reasons.at(-1) ?? '', /level 76600 cooling down after a refused entry \(oi-cap: 76600 open interest at the venue cap\)/)
  assert.equal(h.client.requests.length, 1, 'nothing re-sent at the level')
})

test('a half-filled entry (CE refused) is closed, the size stays, and the level cools', async () => {
  const h = make()
  h.client.queue((r) => ({
    ...respond(r.decisionId, 'DONE', [{ instrument: 'P-BTC-76600-041126', side: 'Sell', qty: 0.05, price: 200 }]),
    skips: [{ instrument: 'C-BTC-76600-041126', reason: 'only_reduce_only_orders_allowed' }],
  }))
  await h.host.evaluate()
  h.book = [legOf(76_600, 'PE', 200)]
  h.advance(1_000)
  await h.host.evaluate()
  const close = h.client.requests[1]
  assert.equal(close?.trigger, 'bs-stop')
  assert.deepEqual(close?.actions.map((a) => [a.op, a.instrument]), [['close', 'P-BTC-76600-041126']])
  const bs = (await h.state()).ruleState.bs
  assert.equal(bs.size, 50)
  assert.match(bs.cooldowns[0]?.reason ?? '', /only the PE filled; only_reduce_only_orders_allowed/)
  // Re-entering at a bigger size after the failed one was the live defect.
  h.book = []
  h.advance(1_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.filter((r) => r.trigger === 'bs-entry').length, 1, 'no re-entry while it cools')
})

test('an entry that filled whole steps the size as before, and records no refusal', async () => {
  const h = make()
  await h.host.evaluate()
  h.book = [legOf(76_600, 'PE', 200), legOf(76_600, 'CE', 210)]
  h.advance(1_000)
  await h.host.evaluate()
  const bs = (await h.state()).ruleState.bs
  assert.equal(bs.size, 100)
  assert.equal(bs.groups[0]?.filled, true)
  assert.deepEqual(bs.cooldowns, [])
})

test('bs_margin_budget: the host hands the master\'s leverage to the engine, and an over-budget entry is refused, named', async () => {
  const tight = make({ dials: dailyDials({ bs_margin_budget: 1 }), leverage: 100 })
  await tight.host.evaluate()
  assert.equal(tight.client.requests.length, 0, 'nothing routed')
  assert.ok(tight.reasons.some((r) => /margin budget: est \$\d+\.\d\d > \$1\b/.test(r)), tight.reasons.join(' | '))
  // A roomy budget: the same book enters as before.
  const room = make({ dials: dailyDials({ bs_margin_budget: 100_000 }), leverage: 100 })
  await room.host.evaluate()
  assert.equal(room.client.requests[0]?.trigger, 'bs-entry')
  // No leverage stated by the master: with a budget set, no entry and it says why.
  const blind = make({ dials: dailyDials({ bs_margin_budget: 100_000 }) })
  await blind.host.evaluate()
  assert.equal(blind.client.requests.length, 0)
  assert.ok(blind.reasons.some((r) => /margin budget: no leverage/.test(r)), blind.reasons.join(' | '))
})

// ── a held leg's quote gone stale (lane A, 3 Nov) ──────────────────────────

/** A straddle at 76,600 that opened, both legs held, the chain frozen at T0. */
async function frozenStraddle(): Promise<Harness> {
  const ce = premium(76_600, 'CE') - 1
  const pe = premium(76_600, 'PE') - 1
  const h = make({ book: [legOf(76_600, 'CE', ce), legOf(76_600, 'PE', pe)] })
  await h.seed({
    bs: {
      ...BS_EMPTY,
      groups: [{
        strike: 76_600, lots: 50, ceEntry: ce, peEntry: pe,
        openedMs: T0 - 60_000, ceOpen: true, peOpen: true, breachSinceMs: 0, filled: true, staleSinceMs: 0,
      }],
      size: 100,
      lastRef: INDEX,
      lastRefMs: T0 - 1_000,
      armedAtMs: T0 - 120_000,
    },
  })
  // Every book frame stops at T0: the quotes keep their T0 timestamp.
  h.chain = () => chainOf(T0)
  return h
}

test('a stale held-leg quote raises a warn alert keyed by the tag, and sends nothing', async () => {
  const h = await frozenStraddle()
  h.advance(30_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.length, 0, 'no new straddle on a book that cannot see its legs')
  const warn = h.alerts.filter((a) => a.severity === 'warn')
  assert.equal(warn.length, 1)
  assert.equal(warn[0]?.key, `${TAG}:stale-quote`)
  assert.equal(warn[0]?.source, 'supervisor')
  assert.equal(warn[0]?.mode, 'paper')
  assert.equal(warn[0]?.tag, TAG)
  assert.match(warn[0]?.message ?? '', /76600CE/)
  assert.equal(h.alerts.some((a) => a.severity === 'critical'), false)
})

test('stale past bs_stale_exit_s: the straddle is closed on bs-stale and a CRITICAL alert is raised', async () => {
  const h = await frozenStraddle()
  h.advance(30_000)
  await h.host.evaluate()
  h.advance(115_000)
  await h.host.evaluate()
  const req = h.client.requests.at(-1)
  assert.equal(req?.trigger, 'bs-stale')
  assert.deepEqual(req?.actions.map((a) => [a.op, a.instrument]), [
    ['close', 'P-BTC-76600-041126'],
    ['close', 'C-BTC-76600-041126'],
  ])
  const crit = h.alerts.filter((a) => a.severity === 'critical')
  assert.equal(crit.length, 1)
  assert.equal(crit[0]?.key, `${TAG}:stale-exit`)
  assert.match(crit[0]?.message ?? '', /stale/)
})

test('an alert sink that throws never stops the stale exit from routing', async () => {
  const h = await frozenStraddle()
  ;(h.alerts as unknown as { push: () => never }).push = () => {
    throw new Error('alert store down')
  }
  h.advance(145_000)
  await h.host.evaluate()
  assert.equal(h.client.requests.at(-1)?.trigger, 'bs-stale')
})
