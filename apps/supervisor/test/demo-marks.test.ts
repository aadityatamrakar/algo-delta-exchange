/**
 * A BOOK IS MARKED ON THE EXCHANGE ITS POSITION LIVES ON.
 *
 * A paper book on Delta's DEMO rail is filled at testnet prices, so its stop
 * has to be checked against testnet quotes (`md.tick.demo`), not production's
 * (`md.tick`). These tests pin, end to end through the `Supervisor`:
 *
 *   1. a demo-rail BULL-S book's stop fires on the DEMO ask when demo and prod
 *      disagree;
 *   2. a prod-marked book (sim rail) never sees a demo quote;
 *   3. a contract with no fresh demo quote is marked off prod — and the reason
 *      and the log SAY so, naming the contract;
 *   4. the venue follows the registry row on the next poll.
 *
 * No Mongo, no network, no wall clock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_RULE_STATE,
  PRESETS,
  type ChainSnap,
  type DecisionRequest,
  type DecisionResponse,
  type OptType,
  type Quote,
} from '@algomaker/desk-engine'
import { BS_EMPTY, type BullSGroup } from '../../../packages/desk-engine/src/bull-s/state.ts'
import { DX } from '@algomaker/venue'
import { Supervisor, type BusPort, type DeskApiPort, type MasterPort, type MdSpot } from '../src/main.ts'
import { Lease } from '../src/lease.ts'
import type { ChainToken, MdTick } from '../src/chain-view.ts'
import type { HostLog } from '../src/engine-host.ts'
import { SUPERVISOR_STATE_COLLECTION, stateKey } from '../src/state-store.ts'
import { desiredBooks } from '../src/registry-poll.ts'
import { marksNoteOf, overlayDemo } from '../src/demo-marks.ts'

// ────────────────────────────────────────────────────────────── the market

const TAG = 'BTC-2026-11-04-bull-s-daily'
const SYMBOL = 'BTC'
const EXPIRY = '2026-11-04'
/** 2026-11-03 14:30 UTC = 20:00 IST — inside Delta's day. */
const T0 = Date.parse('2026-11-03T14:30:00.000Z')
const INDEX = 76_592
const STEP = 200
const LOT = 0.001
const LADDER = Array.from({ length: 13 }, (_, i) => 75_400 + i * STEP)
const HELD = 76_600

const tokenOf = (strike: number, opt: OptType): number => strike * 10 + (opt === 'CE' ? 1 : 2)
const instrumentOf = (strike: number, opt: OptType): string =>
  `${opt === 'CE' ? 'C' : 'P'}-BTC-${String(strike)}-041126`

function premium(strike: number, opt: OptType): number {
  const intrinsic = opt === 'CE' ? Math.max(0, INDEX - strike) : Math.max(0, strike - INDEX)
  return Math.round((intrinsic + 400 * Math.exp(-Math.abs(strike - INDEX) / 1500)) * 10) / 10
}

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
              instrument: instrumentOf(strike, optType),
            }),
          ),
        ),
  futureToken: () => 0,
  instrumentFor: (symbol, expiry, strike, optType) =>
    symbol === SYMBOL && expiry === EXPIRY ? instrumentOf(strike, optType) : null,
  tickSizeFor: () => 0.1,
  leverageFor: () => null,
  chainMeta: (symbol, expiry) =>
    symbol === SYMBOL && expiry === EXPIRY ? { lotSize: LOT, step: STEP } : { lotSize: 0, step: 0 },
}

/** The production board: every strike quoted one dollar either side of its premium. */
function prodFrame(ts: number): MdTick[] {
  return LADDER.flatMap((strike) =>
    (['CE', 'PE'] as const).map((opt): MdTick => {
      const p = premium(strike, opt)
      return { token: tokenOf(strike, opt), price: p, ts, bid: p - 1, ask: p + 1 }
    }),
  )
}

/** The testnet's book on the held straddle, `mult` x production — keyed by the DESK's token. */
function demoFrame(ts: number, mult: number, wings: readonly OptType[] = ['CE', 'PE']): MdTick[] {
  return wings.map((opt): MdTick => {
    const p = premium(HELD, opt) * mult
    return { token: tokenOf(HELD, opt), price: p, ts, bid: p - 1, ask: p + 1 }
  })
}

// ─────────────────────────────────────────────────────────────── the fakes

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

/** A bus that delivers each topic to its own subscribers and nobody else's. */
class FakeBus implements BusPort {
  readonly handlers = new Map<string, ((msg: { payload: unknown }) => void)[]>()

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
  async close(): Promise<void> {}

  emit(pattern: string, payloads: readonly unknown[]): void {
    for (const payload of payloads) {
      for (const h of [...(this.handlers.get(pattern) ?? [])]) h({ payload })
    }
  }
}

class FakeClient {
  readonly requests: DecisionRequest[] = []

  async submit(req: DecisionRequest): Promise<DecisionResponse> {
    this.requests.push(structuredClone(req))
    return { decisionId: req.decisionId, replayed: false, status: 'DONE', fills: [], skips: [], routeErrors: [] }
  }
}

class FakeApi implements DeskApiPort {
  readonly reports: string[] = []
  async reportActual(_b: unknown, _a: unknown, _at: number, lastDecision: string): Promise<void> {
    this.reports.push(lastDecision)
  }
  async cancelOrder(): Promise<void> {}
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
  return { entries, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

// ─────────────────────────────────────────────────────────────── the rig

async function until(ready: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !ready(); i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const PRESET = PRESETS.find((p) => p.key === 'bull-s-btc-daily')

interface Rig {
  readonly supervisor: Supervisor
  readonly db: FakeDb
  readonly bus: FakeBus
  readonly client: FakeClient
  readonly api: FakeApi
  readonly log: HostLog & { entries: Entry[] }
  now: number
  /** One pass: an index print, the production board, then whatever the testnet says. */
  pass(demo: MdTick[]): Promise<void>
  stops(): DecisionRequest[]
  reasons(): string[]
}

/** A BULL-S book holding the 76,600 straddle, sold at production's mid. */
function rig(rail: Record<string, unknown>): Rig {
  assert.ok(PRESET !== undefined)
  const db = new FakeDb()
  const bus = new FakeBus()
  const client = new FakeClient()
  const api = new FakeApi()
  const log = logOf()
  db.of('desk-books-registry').push({
    tag: TAG,
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'paper',
    variant: 'bull-s',
    dials: { ...PRESET.dials },
    desired: 'running',
    actual: 'stopped',
    ...rail,
  })
  const ce = premium(HELD, 'CE')
  const pe = premium(HELD, 'PE')
  db.of('desk-books').push({
    tag: TAG,
    mode: 'paper',
    legs: (['PE', 'CE'] as const).map((opt) => ({
      instrument: { tradingsymbol: instrumentOf(HELD, opt), lotSize: LOT },
      strike: HELD,
      type: opt,
      qty: -50 * LOT,
      entryPrice: opt === 'CE' ? ce : pe,
    })),
  })
  const group: BullSGroup = {
    strike: HELD,
    lots: 50,
    ceEntry: ce,
    peEntry: pe,
    openedMs: T0 - 600_000,
    ceOpen: true,
    peOpen: true,
    breachSinceMs: 0,
    staleSinceMs: 0,
    filled: true,
  }
  db.of(SUPERVISOR_STATE_COLLECTION).push({
    key: stateKey(TAG, 'paper'),
    ruleState: {
      ...EMPTY_RULE_STATE,
      bs: { ...BS_EMPTY, groups: [group], size: 100, lastRef: INDEX, lastRefMs: T0 - 1_000, armedAtMs: T0 - 600_000 },
    },
    updatedAt: 1,
  })
  const r = { db, bus, client, api, log, now: T0 } as Rig
  const supervisor = new Supervisor({
    db: db as never,
    bus,
    client,
    api,
    master: () => master,
    lease: new Lease({ collection: db.collection('desk-supervisor-lease'), key: 'desk-supervisor', now: () => r.now }),
    owner: 'test:1',
    now: () => r.now,
    log,
    leaseRetryMs: 1,
    venue: DX,
  })
  return Object.assign(r, {
    supervisor,
    pass: async (demo: MdTick[]): Promise<void> => {
      bus.emit('md.spot', [{ underlying: SYMBOL, price: INDEX, ts: r.now } satisfies MdSpot])
      bus.emit('md.tick', prodFrame(r.now))
      bus.emit('md.tick.demo', demo)
      await supervisor.evaluateDue()
    },
    stops: (): DecisionRequest[] => client.requests.filter((q) => q.trigger === 'bs-stop'),
    reasons: (): string[] => db.of('desk-book-marks').map((m) => String(m['reason'] ?? '')),
  })
}

/** Two passes 4 s apart — past `bs_stop_confirm_s` (3) — on the same testnet book. */
async function breachTwice(r: Rig, mult: number, wings?: readonly OptType[]): Promise<void> {
  await r.pass(demoFrame(r.now, mult, wings))
  r.now += 4_000
  await r.pass(demoFrame(r.now, mult, wings))
}

// ───────────────────────────────────────────────────────────────── tests

test('the process subscribes md.tick.demo beside md.tick and md.spot', async () => {
  const r = rig({ dx_paper_rail: 'demo' })
  await r.supervisor.boot()
  assert.deepEqual([...r.bus.handlers.keys()].sort(), ['md.spot', 'md.tick', 'md.tick.demo'])
  await r.supervisor.stop('TEST')
})

test('a DEMO-rail book stops on the demo ask when demo and production disagree', async () => {
  const r = rig({ dx_paper_rail: 'demo' })
  await r.supervisor.boot()
  // Production sits at the entry; the testnet's book on the straddle is 1.5x —
  // through the 1.25x stop line on the exchange the position lives on.
  await breachTwice(r, 1.5)
  await until(() => r.stops().length > 0)
  assert.equal(r.stops().length, 1, 'the stop fired on the demo quotes')
  assert.ok(r.reasons().some((s) => s.includes('marks: Delta demo')), 'the reason names the venue')
  assert.ok(!r.reasons().some((s) => s.includes('prod fallback')), 'every held contract had a demo quote')
  await r.supervisor.stop('TEST')
})

test('a PROD-marked book (sim rail) ignores md.tick.demo entirely', async () => {
  const r = rig({ dx_paper_rail: 'sim' })
  await r.supervisor.boot()
  await breachTwice(r, 1.5)
  await until(() => r.client.requests.length > 0, 20)
  assert.equal(r.stops().length, 0, 'a testnet price never reaches a prod-marked book')
  assert.ok(!r.reasons().some((s) => s.includes('marks:')), 'and its reason is unchanged')
  await r.supervisor.stop('TEST')
})

test('the rail the gateway USED wins over the setting: a demo setting simulated is prod-marked', async () => {
  const r = rig({ dx_paper_rail: 'demo', dx_rail_used: 'sim' })
  await r.supervisor.boot()
  await breachTwice(r, 1.5)
  await until(() => r.client.requests.length > 0, 20)
  assert.equal(r.stops().length, 0)
  await r.supervisor.stop('TEST')
})

test('a held contract with NO demo quote falls back to prod — and the reason and the log say so', async () => {
  const r = rig({ dx_paper_rail: 'demo' })
  await r.supervisor.boot()
  // The testnet quotes the PE only. The CE is marked off production, named.
  await r.pass(demoFrame(r.now, 1, ['PE']))
  await until(() => r.reasons().length > 0)
  const ce = instrumentOf(HELD, 'CE')
  const reason = r.reasons().at(-1) ?? ''
  assert.match(reason, /marks: Delta demo, prod fallback on C-BTC-76600-041126/)
  assert.ok(!reason.includes(instrumentOf(HELD, 'PE')), 'the PE had its demo quote')
  const warn = r.log.entries.find((e) => e.level === 'warn' && e.msg.includes('prod fallback'))
  assert.ok(warn !== undefined, 'the fallback is logged')
  assert.deepEqual(warn.ctx['instruments'], [ce])
  await r.supervisor.stop('TEST')
})

test('a demo quote that has gone STALE is a fallback, not a mark', async () => {
  const r = rig({ dx_paper_rail: 'demo' })
  await r.supervisor.boot()
  // The testnet printed 1.5x ten minutes ago and has said nothing since.
  r.bus.emit('md.tick.demo', demoFrame(r.now - 600_000, 1.5))
  await breachTwice(r, 1.5, [])
  await until(() => r.client.requests.length > 0, 20)
  assert.equal(r.stops().length, 0, 'a frozen testnet quote does not stop the book')
  assert.match(r.reasons().at(-1) ?? '', /prod fallback on C-BTC-76600-041126, P-BTC-76600-041126/)
  await r.supervisor.stop('TEST')
})

test('a rail change on the row moves the marks on the next registry poll', async () => {
  const r = rig({ dx_paper_rail: 'sim' })
  await r.supervisor.boot()
  await breachTwice(r, 1.5)
  await until(() => r.client.requests.length > 0, 20)
  assert.equal(r.stops().length, 0, 'prod-marked while the row says sim')

  const row = r.db.of('desk-books-registry')[0]
  assert.ok(row !== undefined)
  row['dx_rail_used'] = 'demo'
  const reported = r.api.reports.length
  r.supervisor.nudge('registry')
  await until(() => r.api.reports.length > reported)

  // The first demo-marked pass declares the chain on the testnet view (its
  // ticks before that are dropped, `chain-view.ts` §3); the breach is then
  // timed from the pass after it.
  r.now += 1_000
  await r.pass(demoFrame(r.now, 1.5))
  r.now += 1_000
  await breachTwice(r, 1.5)
  await until(() => r.stops().length > 0)
  assert.equal(r.stops().length, 1, 'demo-marked from the next poll on')
  await r.supervisor.stop('TEST')
})

// ─────────────────────────────────────────────────────────── the pure parts

test('desiredBooks carries the marks venue off the row (marksVenueOf)', () => {
  const row = (over: Record<string, unknown>): Record<string, unknown> => ({
    tag: TAG,
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'paper',
    variant: 'bull-s',
    dials: {},
    desired: 'running',
    ...over,
  })
  const venue = (over: Record<string, unknown>): string | undefined => desiredBooks([row(over)])[0]?.marks
  assert.equal(venue({}), 'demo', 'demo is the paper default')
  assert.equal(venue({ dx_paper_rail: 'sim' }), 'prod')
  assert.equal(venue({ dx_paper_rail: 'sim', dx_rail_used: 'demo' }), 'demo')
  assert.equal(venue({ mode: 'live', dx_paper_rail: 'demo' }), 'prod')
})

test('overlayDemo replaces only freshly quoted wings; spot, future and the rest stay prod', () => {
  const q = (bid: number, ask: number, asOf: number): Quote => ({ bid, ask, ltp: (bid + ask) / 2, asOf })
  const prod: ChainSnap = {
    symbol: SYMBOL,
    expiry: EXPIRY,
    step: STEP,
    lotSize: LOT,
    future: { bid: null, ask: null, ltp: INDEX, asOf: T0 },
    spot: INDEX,
    strikes: [
      { strike: 76_400, ce: q(10, 12, T0), pe: q(20, 22, T0) },
      { strike: 76_600, ce: q(30, 32, T0), pe: q(40, 42, T0) },
    ],
    asOf: T0,
  }
  const demo = new Map<number, Quote>([
    [tokenOf(76_600, 'CE'), q(50, 52, T0 + 500)],
    [tokenOf(76_600, 'PE'), q(60, 62, T0 - 3_600_000)],
  ])
  const out = overlayDemo(prod, master.tokensFor(SYMBOL, EXPIRY), demo, T0 + 1_000)
  assert.equal(out.snap.spot, INDEX)
  assert.deepEqual(out.snap.future, prod.future)
  assert.deepEqual(out.snap.strikes[0], prod.strikes[0])
  assert.equal(out.snap.strikes[1]?.ce?.ask, 52, 'the fresh demo CE')
  assert.equal(out.snap.strikes[1]?.pe?.ask, 42, 'the stale demo PE falls back to prod')
  assert.equal(out.snap.asOf, T0 + 500)
  const note = marksNoteOf(out.fallback, [
    { strike: 76_600, optType: 'CE' },
    { strike: 76_600, optType: 'PE' },
  ])
  assert.deepEqual(note.fallback, ['P-BTC-76600-041126'])
  assert.equal(note.note, 'marks: Delta demo, prod fallback on P-BTC-76600-041126')
  assert.equal(marksNoteOf(out.fallback, [{ strike: 76_600, optType: 'CE' }]).note, 'marks: Delta demo')
})
