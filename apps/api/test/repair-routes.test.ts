/**
 * `POST /v1/desk/repair/preflight` and `/v1/desk/repair/apply` — the modal's
 * whole preview, and the one button behind it that places real orders.
 *
 * What is asserted here is the CROSSING, because that is what this route adds
 * over the four cockpit endpoints beside it: a repair candidate's `moves` become
 * the ORDERS a broker would take, each priced by walking the book for its own
 * size, with the margin the plan would hold and the delta the book would be left
 * carrying. Everything the crossing itself does is already proven in
 * `repair-plan.test.ts`; what this file proves is the JOIN — chain quote to
 * order, bridge leg to hypothetical leg, and the fail-soft envelope around both.
 *
 * THE CHAIN IS COMPUTED, NOT INVENTED, exactly as `payoff-routes.test.ts` builds
 * it: every quote is `b76Price` at one vol, with a two-sided book around it, so
 * a depth walk here returns a price that could really be paid rather than a
 * number chosen to make an assertion pass.
 *
 * THE APPLY TESTS RUN THE REAL RAIL. Nothing here fakes `SubmitService`: the
 * route builds its own from this harness's deps, so an order that reaches
 * `desk-paper-trade` has passed the registry gate, the switch gate, the kill
 * switch, the mark lookup and the freeze split, exactly as a manual order does.
 * That is the whole claim the Apply button makes — "gated like every live
 * order" — and a stubbed rail would assert it against nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { b76Price, yearsToExpiry, type OptionType } from '@algomaker/greeks'
import { BridgeService, type PositionsResponse } from '../src/service.ts'
import type { DeskMode } from '../src/contract.ts'
import { LiveRail, LIVE_COLLECTION, PaperRail } from '../src/rail.ts'
import { QuoteCache, StaticMarks } from '../src/marks.ts'
import {
  COLLECTIONS,
  DeskStore,
  type Collection,
  type Database,
  type FindCursor,
  type UpdateOutcome,
} from '../src/store.ts'
import { REPAIR_HOLD_MS } from '../src/repair-apply.ts'
import type { DepthBook } from '../src/chain.ts'
import type { AuthGate } from '../src/authgate.ts'
import type { ApiDeps, Route, RouteCtx } from '../src/routes/kit.ts'
import { repairFillState, repairRoutes } from '../src/routes/repair.ts'
import { payoffRoutes } from '../src/routes/payoff.ts'

// ------------------------------------------------------------- the fake port

type Doc = Record<string, unknown>

function bracketOf(v: unknown): string {
  if (v instanceof Date) return 'date'
  if (v === null) return 'null'
  return typeof v
}

function cmp(a: unknown, b: unknown): number | null {
  if (bracketOf(a) !== bracketOf(b)) return null
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  const x = Number(a)
  const y = Number(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function at(doc: Doc, key: string): unknown {
  if (!key.includes('.')) return doc[key]
  let cur: unknown = doc
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Doc)[part]
  }
  return cur
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (key === '$or') return Array.isArray(want) && want.some((sub) => matches(doc, sub as Doc))
    const actual = at(doc, key)
    if (want !== null && typeof want === 'object' && !Array.isArray(want) && !(want instanceof Date)) {
      return Object.entries(want as Doc).every(([op, operand]) => {
        const c = cmp(actual, operand)
        switch (op) {
          case '$gte':
            return c !== null && c >= 0
          case '$gt':
            return c !== null && c > 0
          case '$lt':
            return c !== null && c < 0
          case '$lte':
            return c !== null && c <= 0
          case '$ne':
            return actual !== operand
          case '$in':
            return Array.isArray(operand) && operand.includes(actual)
          // Anchored-prefix only in practice (`^repair:…`), which is what the
          // real collection's unique index on `clientOrderId` can serve.
          case '$regex':
            return typeof actual === 'string' && new RegExp(String(operand)).test(actual)
          default:
            return false
        }
      })
    }
    if (want instanceof Date) return actual instanceof Date && actual.getTime() === want.getTime()
    return actual === want
  })
}

class FakeCursor<T> implements FindCursor<T> {
  #rows: T[]
  constructor(rows: T[]) {
    this.#rows = rows
  }
  sort(spec: Record<string, 1 | -1>): FindCursor<T> {
    const entries = Object.entries(spec)
    this.#rows = [...this.#rows].sort((a, b) => {
      for (const [key, dir] of entries) {
        const x = (a as Doc)[key]
        const y = (b as Doc)[key]
        if (x === y) continue
        const less = typeof x === 'string' || typeof y === 'string' ? String(x) < String(y) : Number(x) < Number(y)
        return less ? -dir : dir
      }
      return 0
    })
    return this
  }
  limit(n: number): FindCursor<T> {
    this.#rows = this.#rows.slice(0, n)
    return this
  }
  skip(n: number): FindCursor<T> {
    this.#rows = this.#rows.slice(n)
    return this
  }
  async toArray(): Promise<T[]> {
    return this.#rows
  }
}

class FakeCollection<T> implements Collection<T> {
  readonly docs: Doc[] = []
  /** Set to make every read fail, the way an unreachable Mongo does. */
  failReads = false
  async findOne(filter: Doc): Promise<T | null> {
    if (this.failReads) throw new Error('no primary available')
    return (this.docs.find((d) => matches(d, filter)) as T | undefined) ?? null
  }
  find(filter: Doc): FindCursor<T> {
    if (this.failReads) throw new Error('no primary available')
    return new FakeCursor(this.docs.filter((d) => matches(d, filter)) as T[])
  }
  async insertOne(doc: T): Promise<unknown> {
    this.docs.push({ ...(doc as Doc) })
    return {}
  }
  async insertMany(docs: readonly T[]): Promise<unknown> {
    for (const d of docs) this.docs.push({ ...(d as Doc) })
    return {}
  }
  async updateOne(filter: Doc, update: Doc, options?: { upsert?: boolean }): Promise<UpdateOutcome> {
    const set = (update['$set'] as Doc) ?? {}
    const hit = this.docs.find((d) => matches(d, filter))
    if (hit !== undefined) Object.assign(hit, set)
    else if (options?.upsert === true) this.docs.push({ ...filter, ...set })
    return {}
  }
  async deleteOne(filter: Doc): Promise<unknown> {
    const i = this.docs.findIndex((d) => matches(d, filter))
    if (i >= 0) this.docs.splice(i, 1)
    return {}
  }
  async deleteMany(filter: Doc): Promise<unknown> {
    for (let i = this.docs.length - 1; i >= 0; i--) {
      if (matches(this.docs[i] as Doc, filter)) this.docs.splice(i, 1)
    }
    return {}
  }
  async countDocuments(filter: Doc): Promise<number> {
    return this.docs.filter((d) => matches(d, filter)).length
  }
  async createIndex(): Promise<unknown> {
    return {}
  }
  async dropIndex(): Promise<unknown> {
    return {}
  }
}

class FakeDb implements Database {
  readonly named = new Map<string, FakeCollection<unknown>>()
  collection<T = Doc>(name: string): Collection<T> {
    let c = this.named.get(name)
    if (c === undefined) {
      c = new FakeCollection<unknown>()
      this.named.set(name, c)
    }
    return c as unknown as Collection<T>
  }
  raw(name: string): FakeCollection<unknown> {
    return this.collection(name) as unknown as FakeCollection<unknown>
  }
  rows(name: string): Doc[] {
    return this.raw(name).docs
  }
}

// ------------------------------------------------------------------ fixture

const SYMBOL = 'BHEL'
const EXPIRY = '2026-08-25'
/** 10:30 IST on 2026-08-05 — twenty days of life left in the chain. */
const NOW = Date.parse('2026-08-05T05:00:00.000Z')
const TAG = 'DESK_BHEL'
const LOT = 2625
const FUTURE = 410
const VOL = 0.28
const RATE = 0.065
const T_YEARS = yearsToExpiry(EXPIRY, NOW)
const STRIKES: readonly number[] = Array.from({ length: 21 }, (_, i) => 360 + i * 5)
const FUT_TOKEN = 600001
/** Half the touch's width: bid = mid − this, ask = mid + this. */
const HALF_SPREAD = 0.5
/** Top of book, then one level behind it — six lots visible a side, in all. */
const TOUCH_LOTS = 1
const BEHIND_LOTS = 5

function token(strike: number, type: OptionType): number {
  return 700000 + strike * 10 + (type === 'CE' ? 1 : 2)
}

function symbolOf(strike: number, type: OptionType): string {
  return `BHEL26AUG${strike}${type}`
}

function priceOf(strike: number, type: OptionType): number {
  return b76Price({ future: FUTURE, strike, t: T_YEARS, vol: VOL, rate: RATE, type })
}

/** A two-sided book around `mid`, symmetric so the mid stays exactly `mid`. */
function depthAround(mid: number): DepthBook {
  return {
    buy: [
      { price: mid - HALF_SPREAD, qty: TOUCH_LOTS * LOT },
      { price: mid - 2 * HALF_SPREAD, qty: BEHIND_LOTS * LOT },
    ],
    sell: [
      { price: mid + HALF_SPREAD, qty: TOUCH_LOTS * LOT },
      { price: mid + 2 * HALF_SPREAD, qty: BEHIND_LOTS * LOT },
    ],
  }
}

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of STRIKES) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: token(strike, type),
        tradingsymbol: symbolOf(strike, type),
        name: SYMBOL,
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
  rows.push({
    instrument_token: FUT_TOKEN,
    tradingsymbol: 'BHEL26AUGFUT',
    name: SYMBOL,
    expiry: EXPIRY,
    strike: 0,
    tick_size: 0.05,
    lot_size: LOT,
    instrument_type: 'FUT',
    segment: 'NFO-FUT',
    exchange: 'NFO',
  })
  return new OptionMaster(rows)
}

interface Options {
  /** `420CE`-style keys whose quote is published late — `staleMs` late. */
  readonly stale?: readonly string[]
  /**
   * How late. Five minutes by default: past the preflight's evidence window
   * (`STALE_QUOTE_MS`) and INSIDE the ceiling an open is priced against
   * (`DESK_MAX_OPEN_MARK_AGE_MS`, ten minutes), which is what makes the two
   * separable here.
   */
  readonly staleMs?: number
  /** `420CE`-style keys that carry no depth at all — an LTP and nothing else. */
  readonly noDepth?: readonly string[]
  /** Seed the book at all? Absent it, the tag names nothing. */
  readonly book?: boolean
  /**
   * Add a third leg — short 460PE, deep in the money — whose displayed mark is
   * BELOW its intrinsic value, so no vol solves out of it. That is not a
   * contrived state: a deep-ITM stock option prices off the future and its LTP
   * routinely sits under the cash-spot no-arbitrage floor (TCS 2440PE,
   * 2026-08-17). The Positions engine models it at the book's median vol; this
   * panel must do the same or the two disagree by a whole delta of underlying.
   */
  readonly unsolvableLeg?: boolean
  /**
   * `460PE`-style keys whose CHAIN quote is published below intrinsic, so the
   * mid a newly-opened leg would be marked at admits no vol either.
   */
  readonly unsolvableChain?: readonly string[]
  /**
   * Hold ONE contract on TWO pockets — a 1-lot short and a 2-lot short of the
   * same 420CE. `assemble` gives the second the id `…420CE#2`, and losing the
   * FIRST re-points the bare id onto the survivor: the exact hazard `legsPrint`
   * exists to catch.
   */
  readonly doubled?: boolean
  /** Seed the same book on the LIVE rail too, so a live apply has one to price. */
  readonly liveBook?: boolean
}

/** The deep-ITM put whose own quote admits no vol. See `Options.unsolvableLeg`. */
const BROKEN_STRIKE = 460
/** Far below intrinsic (~50), so `impliedVol` cannot solve it at any vol. */
const BROKEN_MARK = 1

interface FakeMd {
  readonly fetch: typeof globalThis.fetch
  readonly posted: Doc[]
}

function fakeMd(reply: { status?: number; body?: unknown } | Error): FakeMd {
  const posted: Doc[] = []
  const impl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    posted.push(JSON.parse(String(init?.body ?? 'null')) as Doc)
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch: impl as unknown as typeof globalThis.fetch, posted }
}

const BROKER_OK = { total: 250_000, span: 200_000, exposure: 50_000 }
const MD_URL = 'http://md.test:8892'

/**
 * The operator's password gate, as `routes/desk.ts` uses it.
 *
 * A `machine` principal can never satisfy it — that is the property the live
 * apply test leans on, and the reason the real gate exists.
 */
const PASSWORD = 'the-operator-was-here'

function fakeGate(): AuthGate & { readonly asked: unknown[] } {
  const asked: unknown[] = []
  return {
    asked,
    authenticate: async () => ({ kind: 'user', name: 'tester' }),
    reauth: async (principal, password) => {
      asked.push(password)
      if (principal.kind !== 'user') return 'a machine principal cannot re-authenticate'
      return password === PASSWORD ? null : 'that password is not right'
    },
  }
}

interface Harness {
  db: FakeDb
  deps: ApiDeps
  route: Route
  /** The repair MENU, so a card's `legsPrint` is the one the server serves. */
  menu: Route
  gate: AuthGate & { readonly asked: unknown[] }
  md: FakeMd
  store: DeskStore
  master: OptionMaster
}

/** One leg of the book, as `desk-books` stores it. */
function leg(
  m: OptionMaster,
  strike: number,
  type: OptionType,
  qty: number,
  entry: number,
  /** Distinguishes two POCKETS of one contract — the Python driver's leg id. */
  pocket = '',
): Doc {
  const ref = m.resolve(SYMBOL, EXPIRY, strike, type)
  assert.ok(ref !== null && ref !== undefined, `${strike}${type} is not in the master`)
  return {
    deskTag: `${TAG}-${strike}${type}${pocket}`,
    instrument: ref,
    underlying: SYMBOL,
    expiry: EXPIRY,
    strike,
    type,
    side: qty > 0 ? 'Buy' : 'Sell',
    qty,
    entryPrice: entry,
    openedTs: NOW - 86_400_000,
  }
}

async function harness(opts: Options = {}): Promise<Harness> {
  const db = new FakeDb()
  const store = new DeskStore(db)
  const m = master()
  const stale = new Set(opts.stale ?? [])
  const bare = new Set(opts.noDepth ?? [])
  const broken = new Set(opts.unsolvableChain ?? [])

  const nowFn = (): number => NOW
  const marks = new QuoteCache({ now: nowFn })
  for (const strike of STRIKES) {
    for (const type of ['CE', 'PE'] as const) {
      const key = `${strike}${type}`
      const price = broken.has(key) ? BROKEN_MARK : priceOf(strike, type)
      if (!(price > HALF_SPREAD)) continue
      marks.update(token(strike, type), price, stale.has(key) ? NOW - (opts.staleMs ?? 300_000) : NOW, {
        oi: 1000,
        volume: 10,
        bid: price - HALF_SPREAD,
        ask: price + HALF_SPREAD,
        ...(bare.has(key) ? {} : { depth: depthAround(price) }),
      })
    }
  }
  marks.update(FUT_TOKEN, FUTURE, NOW)

  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(db), live: new LiveRail(db, []) },
    master: { current: () => m },
    // The FUTURE is in here too, so the Positions engine derives the same carry
    // this route does — the delta panel's "now" column has to agree with the
    // Positions tiles digit for digit, and it cannot if the two price off
    // different forwards.
    marks: new StaticMarks(
      {
        ...Object.fromEntries(
          STRIKES.flatMap((s) => (['CE', 'PE'] as const).map((t) => [symbolOf(s, t), priceOf(s, t)])),
        ),
        'BHEL26AUGFUT': FUTURE,
        ...(opts.unsolvableLeg === true ? { [symbolOf(BROKEN_STRIKE, 'PE')]: BROKEN_MARK } : {}),
      },
      { [SYMBOL]: 408.3 + 0.05 },
    ),
    clock: { now: nowFn },
  })

  if (opts.book !== false) {
    const legs = [
      ...(opts.doubled === true ? [leg(m, 420, 'CE', -LOT, priceOf(420, 'CE') + 2.1, '-a')] : []),
      leg(m, 420, 'CE', -2 * LOT, priceOf(420, 'CE') + 1.5),
      leg(m, 395, 'PE', -LOT, priceOf(395, 'PE') + 1.2),
      ...(opts.unsolvableLeg === true
        ? [leg(m, BROKEN_STRIKE, 'PE', -LOT, priceOf(BROKEN_STRIKE, 'PE'))]
        : []),
    ]
    await store.saveBook({ tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper' }, legs as never, NOW)
    if (opts.liveBook === true) {
      await store.saveBook({ tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'live' }, legs as never, NOW)
    }
    /**
     * THE REGISTRY ROW EVERY ORDER PATH GATES ON (`submit.ts` GATE 1).
     *
     * Added for paper only: `modes.live` absent is what makes a live apply a
     * refusal at the rail even after the password, which is the second of the
     * two independent gates the live switch is.
     */
    await store.registerStrategy(
      { tag: TAG, kind: 'external', label: TAG, modes: { paper: { enabled: true } } },
      NOW,
    )
    db.rows('desk-books-registry').push({
      tag: TAG,
      symbol: SYMBOL,
      expiry: EXPIRY,
      mode: 'paper',
      variant: 'recenter-relief',
      dials: { target_pnl: 150_000 },
      desired: 'running',
      actual: 'running',
      lastMarkAt: NOW,
      lastDecision: '',
      createdAt: NOW,
      updatedAt: NOW,
    })
    db.rows('desk-variants').push({
      key: 'recenter-relief',
      decider: 'relief',
      playbook: 'recenter-relief',
      defaults: { delta_tol_pct: 0.02, margin_cap: 500_000, shift_margin_frac: 0.6, delta_shorts_only: 1 },
    })
    db.rows('desk-book-margin').push({
      _id: TAG,
      asOf: NOW,
      ok: true,
      span: 200_000,
      exposure: 50_000,
      premiumPaid: 0,
      premium: 0,
      total: 250_000,
      legs: [],
    })
  }

  const deps: ApiDeps = {
    db,
    store,
    service,
    master: { current: () => m },
    marks,
    log: () => {},
    now: nowFn,
  }
  const md = fakeMd({ body: BROKER_OK })
  const gate = fakeGate()
  const proxy = { url: MD_URL, token: 'machine-bearer', fetch: md.fetch }
  const route = repairRoutes({ ...deps, gate }, { margin: proxy })
  const menu = payoffRoutes(deps, { margin: proxy })
  /**
   * LET THE BOOT HALT LAND BEFORE ANY TEST SEEDS A RUN.
   *
   * `repairRoutes` calls `haltStaleRunsOnBoot` at construction — once per
   * process, on the runs a DEAD process left behind — and it is deliberately
   * not awaited there. A run seeded by a test AFTER construction stands for a
   * run that started later in the process's life, which the boot halt has no
   * business touching; without this tick the two would race and the register
   * would sometimes be swept out from under the test.
   */
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { db, deps, route, menu, gate, md, store, master: m }
}

interface Sent {
  status: number
  body: Doc
}

async function call(h: Harness, body: unknown, target = '/v1/desk/repair/preflight'): Promise<Sent> {
  return await hit(h.route, 'POST', target, body)
}

/** A GET on the repair menu, so a card's `legsPrint` is the served one. */
async function getMenu(h: Harness, tag = TAG): Promise<Sent> {
  return await hit(h.menu, 'GET', `/v1/desk/repair?tag=${encodeURIComponent(tag)}&mode=paper`, {})
}

async function hit(route: Route, method: string, target: string, body: unknown): Promise<Sent> {
  const url = new URL(`http://desk${target}`)
  const sent: Sent = { status: 0, body: {} }
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method,
    principal: { kind: 'user', name: 'tester' },
    log: () => {},
    readJson: async () => body,
    send: (status, payload) => {
      sent.status = status
      sent.body = payload as Doc
    },
  }
  const handled = await route(ctx)
  assert.equal(handled, true, `${method} ${target} was not handled`)
  return sent
}

const CLOSE_420CE = [{ op: 'close', legId: symbolOf(420, 'CE') }]

const ordersOf = (body: Doc): Doc[] => (body['orders'] ?? []) as Doc[]
const droppedOf = (body: Doc): string[] => (body['dropped'] ?? []) as string[]
const warningsOf = (body: Doc): string[] => (body['warnings'] ?? []) as string[]
const said = (body: Doc, re: RegExp): boolean => warningsOf(body).some((w) => re.test(w))
const deltaOf = (body: Doc, side: 'current' | 'after', set: 'all' | 'shortsOnly'): Doc =>
  ((body['delta'] as Doc)[side] as Doc)[set] as Doc

// --------------------------------------------------------------- happy path

test('preflight turns a close into the one order that would place it, priced off the book', async () => {
  const h = await harness()
  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })

  assert.equal(res.status, 200)
  assert.equal(res.body['tag'], TAG)
  assert.equal(res.body['mode'], 'paper')
  assert.equal(res.body['asOf'], NOW)
  assert.equal(typeof res.body['bookPrint'], 'string')
  assert.ok(String(res.body['bookPrint']).length > 0, 'the plan must be pinned to a book fingerprint')
  assert.deepEqual(droppedOf(res.body), [])
  assert.equal(res.body['holdActive'], false)

  const orders = ordersOf(res.body)
  assert.equal(orders.length, 1)
  const o = orders[0] as Doc
  assert.equal(o['wave'], 'close')
  assert.equal(o['moveIndex'], 0)
  // The SIGN is the side: a short leg is bought back.
  assert.equal(o['side'], 'Buy')
  assert.equal(o['lots'], 2)
  assert.equal(o['reducesExposure'], true)
  assert.equal((o['instrument'] as Doc)['tradingsymbol'], symbolOf(420, 'CE'))

  // The mark is the chain's own mid; the estimate is what two lots would pay
  // walking the asks — one lot at the touch, one at the level behind it.
  const mid = priceOf(420, 'CE')
  assert.ok(Math.abs(Number(o['mark']) - mid) < 1e-9, `mark ${String(o['mark'])} is not the chain mid ${mid}`)
  const est = o['est'] as Doc
  assert.ok(Math.abs(Number(est['price']) - (mid + 1.5 * HALF_SPREAD)) < 1e-9, 'not the two-level VWAP')
  assert.equal(est['coveredQty'], (TOUCH_LOTS + BEHIND_LOTS) * LOT)
  assert.equal(est['exceedsDepth'], false)
  assert.equal(est['quoteAgeMs'], 0)
})

test('preflight prices the plan at the broker AND at the desk, without being asked twice', async () => {
  const h = await harness()
  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })

  const margin = res.body['margin'] as Doc
  assert.equal(typeof margin['estimated'], 'number')
  assert.ok(Number(margin['estimated']) > 0, 'a book of two shorts holds margin')
  assert.equal((margin['broker'] as Doc)['total'], 250_000)
  assert.equal(h.md.posted.length, 1, 'the broker is asked exactly once per preflight')
})

test('the delta panel reads now against after, in the Positions engine', async () => {
  const h = await harness()
  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })

  const now = deltaOf(res.body, 'current', 'all')
  const after = deltaOf(res.body, 'after', 'all')
  assert.equal(typeof now['netDelta'], 'number')
  assert.equal(typeof after['netDelta'], 'number')

  // THE NOW COLUMN IS THE POSITIONS TILE. Same engine, same carry, same spot —
  // if these two ever drift the panel is quoting a model no other screen agrees
  // with, which is the whole reason this is not the cockpit's Black-76 delta.
  const pos = await h.deps.service.positions(TAG, 'paper', { realised: true })
  assert.ok(
    Math.abs(Number(now['netDelta']) - pos.greeks.netDelta) < 1,
    `panel ${String(now['netDelta'])} vs Positions ${pos.greeks.netDelta}`,
  )

  // Buying back a short call takes NEGATIVE delta off the book.
  assert.ok(
    Number(after['netDelta']) > Number(now['netDelta']),
    'closing the short call must raise net delta',
  )
  // Only the put is left, and it is short — so shorts-only after is the put alone.
  const shortsAfter = deltaOf(res.body, 'after', 'shortsOnly')
  assert.equal(shortsAfter['netDelta'], after['netDelta'])
  assert.equal(typeof (now['neutral'] as Doc | null)?.['price'], 'number')
})

test('a leg whose own quote admits no vol is modelled into BOTH columns, as the tiles model it', async () => {
  const h = await harness({ unsolvableLeg: true })
  const broken = symbolOf(BROKEN_STRIKE, 'PE')

  // The fixture has to actually reproduce the state, or this test proves nothing.
  const pos = await h.deps.service.positions(TAG, 'paper', { realised: true })
  assert.ok(
    pos.greeks.fallbackPriced.includes(broken),
    `fixture: ${broken} must be model-priced by the Positions engine, got ${JSON.stringify(pos.greeks)}`,
  )

  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  const now = Number(deltaOf(res.body, 'current', 'all')['netDelta'])

  // WITHOUT the median-vol pass the deep put simply drops out of `bookGreeks`,
  // and this book's netΔ moves by a whole lot of underlying — so the tolerance
  // here is what makes the model pass load-bearing rather than decorative.
  assert.ok(
    Math.abs(now - pos.greeks.netDelta) < 1,
    `panel ${now} vs Positions ${pos.greeks.netDelta} — the model pass is missing`,
  )
  assert.ok(said(res.body, /median/i), warningsOf(res.body).join(' | '))

  // And it survives the fold: after == now minus exactly the leg being closed.
  const closed = pos.greeks.legs.find((l) => l.tradingsymbol === symbolOf(420, 'CE'))
  assert.ok(closed !== undefined)
  assert.ok(
    Math.abs(Number(deltaOf(res.body, 'after', 'all')['netDelta']) - (now - closed.positionDelta)) < 1,
    'the after column must differ from now by the closed leg alone',
  )
})

test('a leg this plan would OPEN that the chain cannot price is named, not quietly left out', async () => {
  const h = await harness({ unsolvableChain: [`${BROKEN_STRIKE}PE`] })
  const res = await call(h, {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'hedge', strike: BROKEN_STRIKE, type: 'PE', qty: -LOT }],
  })

  // It RESOLVES — the contract is listed and the size is whole lots — so the
  // order is real; it is only the delta panel that cannot carry it.
  assert.deepEqual(droppedOf(res.body), [])
  assert.equal(ordersOf(res.body).length, 1)
  assert.ok(said(res.body, /admits no vol/i), warningsOf(res.body).join(' | '))
})

test('an open is folded into the after column at the chain mid', async () => {
  const h = await harness()
  const res = await call(h, {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'hedge', strike: 430, type: 'CE', qty: LOT }],
  })

  assert.deepEqual(droppedOf(res.body), [])
  const orders = ordersOf(res.body)
  assert.equal(orders.length, 1)
  assert.equal((orders[0] as Doc)['wave'], 'open')
  assert.equal((orders[0] as Doc)['side'], 'Buy')
  assert.equal((orders[0] as Doc)['reducesExposure'], false, '430CE is not held — this is new exposure')

  // A bought call ADDS positive delta.
  assert.ok(
    Number(deltaOf(res.body, 'after', 'all')['netDelta']) >
      Number(deltaOf(res.body, 'current', 'all')['netDelta']),
    'a long call must raise net delta',
  )
  // The long leg is a hedge, so the shorts-only figure is unchanged by it.
  assert.equal(
    deltaOf(res.body, 'after', 'shortsOnly')['netDelta'],
    deltaOf(res.body, 'current', 'shortsOnly')['netDelta'],
  )
})

test('a shift produces both of its orders under one move index, closes first', async () => {
  const h = await harness()
  const res = await call(h, {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'shift', legId: symbolOf(395, 'PE'), toStrike: 385 }],
  })

  assert.deepEqual(droppedOf(res.body), [])
  const orders = ordersOf(res.body)
  assert.equal(orders.length, 2)
  assert.equal((orders[0] as Doc)['wave'], 'close')
  assert.equal((orders[1] as Doc)['wave'], 'open')
  assert.equal((orders[0] as Doc)['moveIndex'], 0)
  assert.equal((orders[1] as Doc)['moveIndex'], 0)
  assert.equal((orders[1] as Doc)['strike'], 385)
  assert.equal((orders[1] as Doc)['side'], 'Sell')
})

// ------------------------------------------------------------- the refusals

test('a legId the book no longer holds is dropped and named, and the answer is still a 200', async () => {
  const h = await harness()
  const res = await call(h, {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'close', legId: 'BHEL26AUG999CE' }],
  })

  assert.equal(res.status, 200)
  assert.deepEqual(ordersOf(res.body), [])
  assert.equal(droppedOf(res.body).length, 1)
  assert.match(droppedOf(res.body)[0] ?? '', /no such leg/)
})

test('a preflight with no tag is a 400 — there is no all-books repair', async () => {
  const h = await harness()
  const res = await call(h, { mode: 'paper', moves: CLOSE_420CE })
  assert.equal(res.status, 400)
  assert.match(String(res.body['error']), /tag is required/)
})

test('an unknown book is a 200 that says so, not a failed fetch', async () => {
  const h = await harness()
  const res = await call(h, { tag: 'DESK_NOTHING', mode: 'paper', moves: CLOSE_420CE })

  assert.equal(res.status, 200)
  assert.deepEqual(ordersOf(res.body), [])
  assert.ok(said(res.body, /has no book in paper/), warningsOf(res.body).join(' | '))
  assert.equal(deltaOf(res.body, 'current', 'all')['netDelta'], null)
  assert.equal((res.body['margin'] as Doc)['broker'], null)
  assert.equal(h.md.posted.length, 0, 'an unknown book never reaches the broker')
})

test('moves that are not a list are DROPPED, never read as a plan that changes nothing', async () => {
  const h = await harness()
  const res = await call(h, { tag: TAG, mode: 'paper', moves: 'close everything' })

  assert.equal(res.status, 200)
  assert.deepEqual(ordersOf(res.body), [])
  assert.equal(droppedOf(res.body).length, 1, 'an unreadable plan must refuse, not resolve to nothing')
})

// ------------------------------------------------------------------ the hold

/** A run document as `RepairApplyService` writes it. */
function run(tag: string, state: string, createdAt = NOW): Doc {
  return { _id: `apply-${tag}-${state}`, tag, mode: 'paper', state, createdAt, updatedAt: createdAt }
}

test('a RUNNING apply for this tag holds the button', async () => {
  const h = await harness()
  h.db.rows(COLLECTIONS.repairApplies).push(run(TAG, 'RUNNING'))

  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.equal(res.body['holdActive'], true)
})

test('an apply that finished having placed NOTHING does not hold it, and another tag\'s run never does', async () => {
  const h = await harness()
  h.db.rows(COLLECTIONS.repairApplies).push(run(TAG, 'DONE'))
  h.db.rows(COLLECTIONS.repairApplies).push(run('DESK_OTHER', 'RUNNING'))

  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.equal(res.body['holdActive'], false)
})

test('an apply that JUST finished still holds it — the book is still being handed back', async () => {
  const h = await harness()
  // The run is over, and for another minute and a half the Python driver is
  // still standing down over it: its closes are off the bridge's book while the
  // legs its opens created are not yet adopted (`REPAIR_HOLD_GRACE_MS`). The
  // button reads the same hold the supervisor does, so it says so too.
  h.db.rows(COLLECTIONS.repairApplies).push({
    ...run(TAG, 'DONE'),
    orders: [{ clientOrderId: 'repair:done:0', wave: 'close', status: 'FILLED' }],
  })

  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.equal(res.body['holdActive'], true)
})

test('the button reads the apply service\'s OWN hold, TTL and all', async () => {
  const h = await harness()
  // Still RUNNING on paper, but past the hold's expiry — the service would let
  // a new run start, and the button must not disagree with it.
  h.db.rows(COLLECTIONS.repairApplies).push(run(TAG, 'RUNNING', NOW - REPAIR_HOLD_MS - 1))

  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.equal(res.body['holdActive'], false)
})

test('a hold register that cannot be read holds the button rather than opening it', async () => {
  const h = await harness()
  h.db.raw(COLLECTIONS.repairApplies).failReads = true

  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.equal(res.status, 200)
  assert.equal(res.body['holdActive'], true, 'an unreadable register cannot vouch that nothing is running')
  assert.ok(said(res.body, /could not be read/), warningsOf(res.body).join(' | '))
})

// ------------------------------------------------------------- the estimate

test('a stale quote withdraws the estimate and says so — the mark still shows', async () => {
  const h = await harness({ stale: ['420CE'] })
  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })

  const o = ordersOf(res.body)[0] as Doc
  assert.equal((o['est'] as Doc)['price'], null, 'a five-minute-old book prices nothing')
  assert.equal((o['est'] as Doc)['quoteAgeMs'], 300_000)
  assert.ok(Math.abs(Number(o['mark']) - priceOf(420, 'CE')) < 1e-9, 'the mark is still served')
  assert.ok(said(res.body, /420CE.*(stale|old)/i), warningsOf(res.body).join(' | '))
})

test('an order bigger than the visible book says so instead of quoting a price it cannot get', async () => {
  const h = await harness()
  const res = await call(h, {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'hedge', strike: 430, type: 'CE', qty: 10 * LOT }],
  })

  const est = (ordersOf(res.body)[0] as Doc)['est'] as Doc
  assert.equal(est['exceedsDepth'], true)
  assert.equal(est['coveredQty'], (TOUCH_LOTS + BEHIND_LOTS) * LOT)
  assert.ok(Number(est['price']) > 0, 'the VWAP of what IS visible, not a refusal')
  assert.ok(said(res.body, /only shows/i), warningsOf(res.body).join(' | '))
})

test('a contract with no book at all still serves its mark, with a warning', async () => {
  const h = await harness({ noDepth: ['420CE'] })
  const res = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })

  const o = ordersOf(res.body)[0] as Doc
  assert.ok(Math.abs(Number(o['mark']) - priceOf(420, 'CE')) < 1e-9)
  assert.equal((o['est'] as Doc)['price'], null)
  // SPECIFICALLY the depth sentence: "the book only shows 0 of the 5250 this
  // order would buy". A looser matcher here passed on any warning at all —
  // including the book-level ones every answer carries — so the assertion was
  // true of a response that had said nothing about depth.
  assert.ok(said(res.body, /only shows 0 of/), warningsOf(res.body).join(' | '))
})

// ------------------------------------------------- the menu's own staleness

test('a request with NO moves key reads as a plan that places nothing, and says so', async () => {
  const h = await harness()
  const res = await call(h, { tag: TAG, mode: 'paper' })

  assert.equal(res.status, 200)
  assert.deepEqual(ordersOf(res.body), [])
  // An absent key and an empty list are one fact — "there is nothing here to
  // place" — and the answer must not read as "this repair changes nothing".
  assert.ok(said(res.body, /carries no moves/), warningsOf(res.body).join(' | '))
})

test('the menu serves the legs it addresses, fingerprinted', async () => {
  const h = await harness()
  const menu = await getMenu(h)
  assert.equal(menu.status, 200)
  assert.equal(typeof menu.body['legsPrint'], 'string')

  // The preflight recomputes it from the BRIDGE's legs; the menu computes it
  // from the payoff legs. Two shapes of one book, one print, or the guard below
  // would fire on every card ever drawn.
  const pre = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.equal(pre.body['legsPrint'], menu.body['legsPrint'])
})

test('a legsPrint from before the book moved refuses every legId move, and keeps the adds', async () => {
  const h = await harness()
  const res = await call(h, {
    tag: TAG,
    mode: 'paper',
    legsPrint: 'a print from a book that is not this one',
    moves: [
      { op: 'close', legId: symbolOf(420, 'CE') },
      { op: 'hedge', strike: 430, type: 'CE', qty: LOT },
    ],
  })

  assert.equal(res.status, 200)
  assert.equal(droppedOf(res.body).length, 1)
  assert.match(droppedOf(res.body)[0] ?? '', /the book has changed since this menu was drawn/)
  // A hedge names a strike, not a leg: nothing about it can have re-pointed.
  assert.deepEqual(ordersOf(res.body).map((o) => (o as Doc)['wave']), ['open'])
  assert.ok(said(res.body, /the book has changed since this menu was drawn/), warningsOf(res.body).join(' | '))
})

test('THE HAZARD: a doubled contract loses a pocket and the bare id re-points — legsPrint catches it', async () => {
  const h = await harness({ doubled: true })
  const menu = await getMenu(h)
  const drawn = String(menu.body['legsPrint'])

  // The card said "close BHEL26AUG420CE", which at the time was the ONE-lot
  // pocket. Between the menu and the click, that pocket is closed — and the
  // TWO-lot pocket, which was `…420CE#2`, inherits the bare id.
  await h.store.saveBook({ tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper' }, [
    leg(h.master, 420, 'CE', -2 * LOT, priceOf(420, 'CE') + 1.5),
    leg(h.master, 395, 'PE', -LOT, priceOf(395, 'PE') + 1.2),
  ] as never, NOW)

  const blind = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  // Without the print, the plan resolves — at DOUBLE the size the card meant.
  // This is not the desired behaviour; it is the hazard, asserted so the guard
  // below is proved to be doing something.
  assert.deepEqual(ordersOf(blind.body).map((o) => (o as Doc)['lots']), [2])

  const guarded = await call(h, { tag: TAG, mode: 'paper', legsPrint: drawn, moves: CLOSE_420CE })
  assert.deepEqual(ordersOf(guarded.body), [])
  assert.match(droppedOf(guarded.body)[0] ?? '', /the book has changed since this menu was drawn/)
})

test('a legsPrint that still matches changes nothing at all', async () => {
  const h = await harness()
  const menu = await getMenu(h)
  const res = await call(h, {
    tag: TAG,
    mode: 'paper',
    legsPrint: String(menu.body['legsPrint']),
    moves: CLOSE_420CE,
  })
  assert.deepEqual(droppedOf(res.body), [])
  assert.equal(ordersOf(res.body).length, 1)
})

// ------------------------------------------------------------------- apply

const APPLY = '/v1/desk/repair/apply'
/** A shift: one close and one open, which is what makes the waves observable. */
const SHIFT_395PE = [{ op: 'shift', legId: symbolOf(395, 'PE'), toStrike: 385 }]

/**
 * The fingerprint a modal would carry into Confirm — the PREFLIGHT's, since
 * that is the answer the operator read.
 */
async function legsPrintOf(h: Harness, mode: 'paper' | 'live' = 'paper'): Promise<string> {
  const pre = await call(h, { tag: TAG, mode, moves: [] })
  const print = String(pre.body['legsPrint'])
  assert.ok(print.length > 0, 'the preflight must pin the plan to a fingerprint')
  return print
}

/** The paper rail's own record — the only proof an order really went out. */
function placed(h: Harness): [unknown, unknown][] {
  return h.db.rows(COLLECTIONS.paperTrade).map((d) => [d['desk_op'], d['tradingsymbol']])
}

/** Poll the status endpoint until the run stops being RUNNING. */
async function settled(h: Harness, applyId: string): Promise<Doc> {
  for (let i = 0; i < 200; i += 1) {
    const res = await hit(h.route, 'GET', `${APPLY}/${encodeURIComponent(applyId)}`, {})
    assert.equal(res.status, 200, JSON.stringify(res.body))
    if (res.body['state'] !== 'RUNNING') return res.body
    await new Promise((r) => setTimeout(r, 1))
  }
  assert.fail('the run never left RUNNING')
}

test('apply places the plan through the real rail — closes first, then opens', async () => {
  const h = await harness()
  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: SHIFT_395PE, legsPrint: await legsPrintOf(h), decisionId: 'dec-1', style: 'fast' },
    APPLY,
  )

  assert.equal(res.status, 202, JSON.stringify(res.body))
  assert.equal(res.body['accepted'], true)
  assert.equal(res.body['applyId'], 'dec-1')

  const run = await settled(h, 'dec-1')
  assert.equal(run['state'], 'DONE', JSON.stringify(run['haltReason']))
  assert.deepEqual(
    (run['orders'] as Doc[]).map((o) => [o['wave'], o['status']]),
    [['close', 'FILLED'], ['open', 'FILLED']],
  )
  // The rail's own record, in wave order: the leg comes off before the new one
  // goes on, which is the whole reason this is a state machine and not a loop.
  assert.deepEqual(placed(h), [
    ['close', symbolOf(395, 'PE')],
    ['open', symbolOf(385, 'PE')],
  ])
})

test('the applyId IS the decisionId — a replay answers with the run that id already owns', async () => {
  const h = await harness()
  // A caller whose 202 went missing retries under the SAME id. That id already
  // has a run, and it must be told about its own rather than starting a second.
  h.db.rows(COLLECTIONS.repairApplies).push({
    _id: 'dec-replay',
    tag: TAG,
    mode: 'paper',
    style: 'fast',
    bookPrint: 'the print it was claimed under',
    state: 'DONE',
    orders: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
  })
  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: await legsPrintOf(h), decisionId: 'dec-replay', style: 'fast' },
    APPLY,
  )

  assert.equal(res.status, 202)
  assert.equal(res.body['applyId'], 'dec-replay')
  assert.deepEqual(placed(h), [], 'that id had already executed — nothing may go out a second time')
})

test('a re-click AFTER the plan executed is a 409: the book it moved is no longer that book', async () => {
  const h = await harness()
  const body = {
    tag: TAG,
    mode: 'paper',
    moves: CLOSE_420CE,
    legsPrint: await legsPrintOf(h),
    decisionId: 'dec-once',
    style: 'fast',
  }
  assert.equal((await call(h, body, APPLY)).status, 202)
  await settled(h, 'dec-once')

  // The close folded onto `desk-books`, so the fingerprint the modal is still
  // holding describes a book with a leg this one no longer has. The idempotency
  // key is the inner guard; THIS is the one a stale screen actually meets.
  const again = await call(h, body, APPLY)
  assert.equal(again.status, 409)
  assert.equal(again.body['error'], 'book-changed')
  assert.equal(placed(h).length, 1, 'the same plan placed a second order')
})

test('a legsPrint that no longer describes this book is a 409, and nothing is placed', async () => {
  const h = await harness()
  const res = await call(
    h,
    {
      tag: TAG,
      mode: 'paper',
      moves: SHIFT_395PE,
      legsPrint: 'the legs as they stood ten minutes ago',
      decisionId: 'dec-stale',
      style: 'fast',
    },
    APPLY,
  )

  assert.equal(res.status, 409)
  assert.equal(res.body['error'], 'book-changed')
  assert.match(String(res.body['detail']), /legs/)
  assert.deepEqual(placed(h), [])
  assert.equal(h.db.rows(COLLECTIONS.repairApplies).length, 0, 'a refused apply claims no run')
})

/**
 * A service whose reads DISAGREE — the first answers the book as it stands, and
 * every one after it answers `mutate`'s version.
 *
 * It is a cast rather than a subclass because `BridgeService` keeps private
 * state its methods read off `this`, so a prototype-chained stand-in would
 * throw on the first call. `positions` is the only method this route module
 * asks for (`assemble` included), which is what makes the narrow fake honest.
 */
function readsDisagree(
  real: ApiDeps['service'],
  mutate: (p: PositionsResponse) => PositionsResponse,
): ApiDeps['service'] {
  let reads = 0
  return {
    positions: async (tag: string, mode: DeskMode, opts: { readonly realised?: boolean } = {}) => {
      reads += 1
      const answer = await real.positions(tag, mode, opts)
      return reads === 1 ? answer : mutate(answer)
    },
  } as unknown as ApiDeps['service']
}

test('THE REAUTH WINDOW: the print is taken from the read the ORDERS are resolved against', async () => {
  const h = await harness({ doubled: true, liveBook: true })
  const print = await legsPrintOf(h, 'live')

  /**
   * The hazard, exactly. `assemble`'s read vouches for the fingerprint; the
   * password gate then spends a few hundred milliseconds inside argon2id; and
   * `resolveOrders` resolves against a SECOND read. A pocket of the doubled
   * 420CE removed in that window re-points the bare legId onto the survivor,
   * and a confirmed 1-lot close goes out against a 2-lot leg. Nothing about the
   * book the operator confirmed has been checked against the book that is about
   * to be traded — until the print is recomputed from the second read.
   */
  const route = repairRoutes(
    {
      ...h.deps,
      service: readsDisagree(h.deps.service, (p) => ({ ...p, legs: p.legs.slice(1) })),
      gate: h.gate,
    },
    { margin: { url: MD_URL, token: 'machine-bearer', fetch: h.md.fetch } },
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  const res = await hit(route, 'POST', APPLY, {
    tag: TAG,
    mode: 'live',
    moves: CLOSE_420CE,
    legsPrint: print,
    decisionId: 'dec-toctou',
    style: 'fast',
    password: PASSWORD,
  })

  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body['error'], 'book-changed')
  // LIVE, and the password was accepted — so this refusal is on the far side of
  // the gate that opens the window. A check that sat in front of the gate would
  // pass this test on paper and prove nothing about the window at all.
  assert.equal(h.gate.asked.length, 1)
  assert.deepEqual(placed(h), [], 'a re-pointed close is exactly what must not go out')
  assert.equal(h.db.rows(COLLECTIONS.repairApplies).length, 0, 'and no run is claimed')
})

test('A QUOTE TICKING BETWEEN PREFLIGHT AND CONFIRM DOES NOT REFUSE THE PLAN', async () => {
  const h = await harness()
  const before = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  const drawn = String(before.body['legsPrint'])

  // One strike prints. Nothing the operator read has changed — same legs, same
  // sizes, same entries — and the orders will be priced off the LIVE touch at
  // submit time regardless, so the preview's numbers were never the contract.
  h.deps.marks?.update(token(430, 'CE'), priceOf(430, 'CE') + 3, NOW, {
    oi: 1000,
    volume: 10,
    bid: priceOf(430, 'CE') + 3 - HALF_SPREAD,
    ask: priceOf(430, 'CE') + 3 + HALF_SPREAD,
    depth: depthAround(priceOf(430, 'CE') + 3),
  })

  const after = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.equal(after.body['legsPrint'], drawn, 'a tick is not a change of legs')
  // THE POINT OF THE SWITCH: the wide fingerprint DID move, so a 409 keyed on
  // it would have refused this Confirm — and would refuse essentially every
  // Confirm ever pressed while the market is open.
  assert.notEqual(after.body['bookPrint'], before.body['bookPrint'])

  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: drawn, decisionId: 'dec-tick', style: 'fast' },
    APPLY,
  )
  assert.equal(res.status, 202, JSON.stringify(res.body))
  await settled(h, 'dec-tick')
  assert.deepEqual(placed(h), [['close', symbolOf(420, 'CE')]])
})

test('a LEG changing between preflight and Confirm DOES refuse the plan', async () => {
  const h = await harness()
  const drawn = await legsPrintOf(h)

  // The bot resized the very leg this plan is sized against, between the
  // preview and the click. Same contracts, different book.
  await h.store.saveBook({ tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper' }, [
    leg(h.master, 420, 'CE', -3 * LOT, priceOf(420, 'CE') + 1.5),
    leg(h.master, 395, 'PE', -LOT, priceOf(395, 'PE') + 1.2),
  ] as never, NOW)

  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: drawn, decisionId: 'dec-resized', style: 'fast' },
    APPLY,
  )
  assert.equal(res.status, 409)
  assert.equal(res.body['error'], 'book-changed')
  assert.deepEqual(placed(h), [])
})

test('a decisionId that already owns ANOTHER book’s run is refused, not answered with that run', async () => {
  const h = await harness()
  // The modal would otherwise poll a finished run belonging to a different book
  // and render its DONE as this plan's success — a repair reported as placed
  // that never was.
  h.db.rows(COLLECTIONS.repairApplies).push({
    _id: 'dec-borrowed',
    tag: 'DESK_OTHER',
    mode: 'paper',
    style: 'fast',
    bookPrint: 'another book, another day',
    state: 'DONE',
    orders: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
  })
  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: await legsPrintOf(h), decisionId: 'dec-borrowed', style: 'fast' },
    APPLY,
  )

  assert.equal(res.status, 200)
  assert.equal(res.body['accepted'], false)
  assert.match(String(res.body['reason']), /DESK_OTHER/)
  assert.deepEqual(placed(h), [])
})

test('the same id on the same book but the OTHER rail is refused too', async () => {
  const h = await harness()
  h.db.rows(COLLECTIONS.repairApplies).push({
    _id: 'dec-rail',
    tag: TAG,
    mode: 'live',
    style: 'fast',
    bookPrint: 'the live run',
    state: 'DONE',
    orders: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
  })
  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: await legsPrintOf(h), decisionId: 'dec-rail', style: 'fast' },
    APPLY,
  )
  assert.equal(res.body['accepted'], false)
  assert.match(String(res.body['reason']), /live/)
  assert.deepEqual(placed(h), [])
})

// ------------------------------------------------- what an open may price off

test('an OPEN whose mark is older than the ceiling halts the run before it is sent', async () => {
  // 385PE has not printed in eleven minutes on a feed that is ticking
  // everywhere else — `QuoteCache.quote` answers happily, and the "marketable"
  // limit derived from it would rest forever. On a repair that is not one
  // unfilled order: the close in front of it has ALREADY filled, so the book
  // would sit naked on the leg just taken off (audit F-16).
  const h = await harness({ stale: ['385PE'], staleMs: 11 * 60_000 })
  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: SHIFT_395PE, legsPrint: await legsPrintOf(h), decisionId: 'dec-old', style: 'fast' },
    APPLY,
  )
  assert.equal(res.status, 202, JSON.stringify(res.body))

  const run = await settled(h, 'dec-old')
  assert.equal(run['state'], 'HALTED')
  assert.match(String(run['haltReason']), /mark age/)
  assert.match(String(run['haltReason']), /660s/, 'the halt reason must carry the age')
  // The close went; the open did not. Nothing was sent at a price nobody shows.
  assert.deepEqual(placed(h), [['close', symbolOf(395, 'PE')]])
})

test('a CLOSE is never blocked by the ceiling, however old its mark', async () => {
  // The governing rule: a control stops NEW exposure and never blocks an exit.
  // Trapping a position behind a safety control is worse than what the control
  // was protecting against — the position keeps moving either way.
  const h = await harness({ stale: ['395PE'], staleMs: 11 * 60_000 })
  const res = await call(
    h,
    {
      tag: TAG,
      mode: 'paper',
      moves: [{ op: 'close', legId: symbolOf(395, 'PE') }],
      legsPrint: await legsPrintOf(h),
      decisionId: 'dec-exit',
      style: 'fast',
    },
    APPLY,
  )
  assert.equal(res.status, 202, JSON.stringify(res.body))

  const run = await settled(h, 'dec-exit')
  assert.equal(run['state'], 'DONE', String(run['haltReason']))
  assert.deepEqual(placed(h), [['close', symbolOf(395, 'PE')]])
})

// ------------------------------------------------------------ the kill switch

/** Engage the desk-wide halt, exactly as the Safety page writes it. */
async function engage(h: Harness, reason = 'the feed died at 11:02'): Promise<void> {
  await h.store.saveKillSwitch({ enabled: true, reason, setBy: 'tester', setAt: NOW })
}

test('THE HAZARD: a halted desk must not fill a shift’s closes and then be refused its opens', async () => {
  const h = await harness()
  await engage(h)

  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: SHIFT_395PE, legsPrint: await legsPrintOf(h), decisionId: 'dec-halt', style: 'fast' },
    APPLY,
  )

  // GATE 3 is per ORDER and every close carries `reducesExposure` — so without
  // a check on the PLAN the close wave fills, the open wave is refused, and the
  // book is left naked on the leg it just took off. That is the exact
  // half-applied shape `resolveOrders` refuses a plan to prevent.
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body['accepted'], false)
  assert.match(String(res.body['reason']), /kill switch/i)
  assert.match(String(res.body['reason']), /the feed died at 11:02/, 'the operator is told WHY the desk is halted')
  assert.deepEqual(placed(h), [], 'the close would have gone out on its own')
  assert.equal(h.db.rows(COLLECTIONS.repairApplies).length, 0, 'a refused apply claims no run')
})

test('a halted desk still places a pure CLOSE plan — a control may never trap a position', async () => {
  const h = await harness()
  await engage(h)

  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: await legsPrintOf(h), decisionId: 'dec-halt-exit', style: 'fast' },
    APPLY,
  )

  assert.equal(res.status, 202, JSON.stringify(res.body))
  const run = await settled(h, 'dec-halt-exit')
  assert.equal(run['state'], 'DONE', String(run['haltReason']))
  assert.deepEqual(placed(h), [['close', symbolOf(420, 'CE')]])
})

test('the preflight says the switch is engaged BEFORE Confirm, and only when it matters', async () => {
  const h = await harness()
  await engage(h)

  // The modal renders `warnings`, so this is the only place the operator can
  // learn that Confirm is going to be refused.
  const shift = await call(h, { tag: TAG, mode: 'paper', moves: SHIFT_395PE })
  assert.ok(said(shift.body, /kill switch/i), warningsOf(shift.body).join(' | '))

  // A plan that only CLOSES is not refused, so warning about it would be noise
  // on the one screen that has to stay readable.
  const exit = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE })
  assert.ok(!said(exit.body, /kill switch/i), warningsOf(exit.body).join(' | '))
})

test('a switch register that cannot be read refuses the opens and still lets the exits out', async () => {
  const h = await harness()
  const print = await legsPrintOf(h)
  h.db.raw(COLLECTIONS.safety).failReads = true

  const shift = await call(
    h,
    { tag: TAG, mode: 'paper', moves: SHIFT_395PE, legsPrint: print, decisionId: 'dec-unread', style: 'fast' },
    APPLY,
  )
  assert.equal(shift.status, 200)
  assert.equal(shift.body['accepted'], false)
  assert.match(String(shift.body['reason']), /could not be read/)
  assert.deepEqual(placed(h), [])

  // The exit never asks the register at all, so an unreadable one cannot trap
  // a position behind THIS gate. What the rail then makes of a store it cannot
  // read is the rail's own story — the claim here is that the plan was let
  // through rather than refused for holding an open it does not hold.
  const exit = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: print, decisionId: 'dec-unread-exit', style: 'fast' },
    APPLY,
  )
  assert.equal(exit.status, 202, JSON.stringify(exit.body))
  assert.equal(exit.body['accepted'], true)
})

test('with the switch clear the preflight says nothing about it', async () => {
  const h = await harness()
  const res = await call(h, { tag: TAG, mode: 'paper', moves: SHIFT_395PE })
  assert.ok(!said(res.body, /kill switch/i), warningsOf(res.body).join(' | '))
})

test('a LIVE apply without the operator’s password is a 403, and nothing is placed', async () => {
  const h = await harness({ liveBook: true })
  const res = await call(
    h,
    {
      tag: TAG,
      mode: 'live',
      moves: CLOSE_420CE,
      legsPrint: await legsPrintOf(h, 'live'),
      decisionId: 'dec-live',
      style: 'fast',
    },
    APPLY,
  )

  assert.equal(res.status, 403, JSON.stringify(res.body))
  assert.equal(res.body['reauthRequired'], true)
  assert.equal(h.gate.asked.length, 1, 'the gate is the thing that decided this')
  assert.deepEqual(placed(h), [])
  assert.equal(h.db.rows(COLLECTIONS.repairApplies).length, 0)
})

test('a PAPER apply never asks for a password — the gate is for money, not for clicks', async () => {
  const h = await harness()
  await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: await legsPrintOf(h), decisionId: 'dec-paper', style: 'fast' },
    APPLY,
  )
  assert.deepEqual(h.gate.asked, [])
})

test('a second apply while one is RUNNING is refused, not interleaved', async () => {
  const h = await harness()
  h.db.rows(COLLECTIONS.repairApplies).push(run(TAG, 'RUNNING'))

  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: await legsPrintOf(h), decisionId: 'dec-second', style: 'fast' },
    APPLY,
  )

  assert.equal(res.status, 200)
  assert.equal(res.body['accepted'], false)
  assert.match(String(res.body['reason']), /already running/)
  assert.deepEqual(placed(h), [])
})

test('a plan with anything dropped is refused outright, naming every drop', async () => {
  const h = await harness()
  const res = await call(
    h,
    {
      tag: TAG,
      mode: 'paper',
      moves: [{ op: 'close', legId: 'BHEL26AUG999CE' }],
      legsPrint: await legsPrintOf(h),
      decisionId: 'dec-dropped',
      style: 'fast',
    },
    APPLY,
  )

  assert.equal(res.status, 200)
  assert.equal(res.body['accepted'], false)
  assert.match(String(res.body['reason']), /no such leg/)
  assert.deepEqual(placed(h), [])
})

test('an apply that would place nothing is refused rather than claiming a run', async () => {
  const h = await harness()
  const res = await call(
    h,
    { tag: TAG, mode: 'paper', moves: [], legsPrint: await legsPrintOf(h), decisionId: 'dec-empty', style: 'fast' },
    APPLY,
  )
  assert.equal(res.status, 200)
  assert.equal(res.body['accepted'], false)
  assert.equal(h.db.rows(COLLECTIONS.repairApplies).length, 0)
})

test('apply without a tag or a decisionId is a 400 — neither can be guessed', async () => {
  const h = await harness()
  const print = await legsPrintOf(h)
  const noTag = await call(h, { mode: 'paper', moves: CLOSE_420CE, legsPrint: print, decisionId: 'x' }, APPLY)
  assert.equal(noTag.status, 400)
  const noId = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: print }, APPLY)
  assert.equal(noId.status, 400)
  assert.match(String(noId.body['error']), /decisionId/)
  const noPrint = await call(h, { tag: TAG, mode: 'paper', moves: CLOSE_420CE, decisionId: 'x' }, APPLY)
  assert.equal(noPrint.status, 400)
  assert.match(String(noPrint.body['error']), /legsPrint/)
  assert.deepEqual(placed(h), [])
})

test('a decisionId that could not be indexed is a 400, not a driver error from insertOne', async () => {
  const h = await harness()
  const print = await legsPrintOf(h)
  // This becomes the run's `_id` AND the stem of every uniquely-indexed
  // clientOrderId under it. Mongo refuses an indexed key over ~1KB with a
  // driver error, which would surface as a 500 from the endpoint that places
  // orders — indistinguishable, to a caller, from the bridge falling over.
  for (const bad of ['x'.repeat(129), 'has a space', 'tab\there']) {
    const res = await call(
      h,
      { tag: TAG, mode: 'paper', moves: CLOSE_420CE, legsPrint: print, decisionId: bad, style: 'fast' },
      APPLY,
    )
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.match(String(res.body['error']), /decisionId/)
  }
  // …and the ordinary shapes this desk actually mints still pass.
  const ok = await call(
    h,
    {
      tag: TAG,
      mode: 'paper',
      moves: CLOSE_420CE,
      legsPrint: print,
      decisionId: 'repair:DESK_BHEL:paper:1754377200000',
      style: 'fast',
    },
    APPLY,
  )
  assert.equal(ok.status, 202, JSON.stringify(ok.body))
})

test('an applyId nothing ever claimed is a 404, not an empty run', async () => {
  const h = await harness()
  const res = await hit(h.route, 'GET', `${APPLY}/never-happened`, {})
  assert.equal(res.status, 404)
  assert.match(String(res.body['error']), /never-happened/)
})

test('apply and status handle nothing but their own paths', async () => {
  const h = await harness()
  for (const [method, target] of [
    ['GET', APPLY],
    ['POST', `${APPLY}/dec-1`],
    ['DELETE', '/v1/desk/repair/preflight'],
  ] as const) {
    const url = new URL(`http://desk${target}`)
    const ctx: RouteCtx = {
      req: null as unknown as IncomingMessage,
      res: null as unknown as ServerResponse,
      url,
      path: url.pathname,
      method,
      principal: { kind: 'user', name: 'tester' },
      log: () => {},
      readJson: async () => ({}),
      send: () => assert.fail(`the repair route answered ${method} ${target}`),
    }
    assert.equal(await h.route(ctx), false, `${method} ${target}`)
  }
})

// --------------------------------------------------------------- fillState

/** One `desk-gateway-orders` document, as the live rail and the queue leave it. */
function gatewayOrder(clientOrderId: string, state: string): Doc {
  return { clientOrderId, state, tag: TAG, tradingsymbol: symbolOf(420, 'CE'), quantity: LOT }
}

test('paper books synchronously — an accepted order is FILLED the moment it is asked about', async () => {
  const h = await harness()
  const fillState = repairFillState(h.deps, COLLECTIONS.gatewayOrders)
  // Nothing is seeded: the paper rail wrote the fill inside `submit`, so there
  // is no later truth to wait for. The price-stamp the paperstream applies
  // afterwards is display, not settlement.
  assert.equal(await fillState('paper', 'repair:dec-1:0'), 'FILLED')
})

test('live folds every freeze tranche of one order into ONE verdict', async () => {
  const h = await harness()
  const fillState = repairFillState(h.deps, COLLECTIONS.gatewayOrders)
  const rows = h.db.rows(COLLECTIONS.gatewayOrders)

  rows.push(gatewayOrder('repair:dec-1:0#0', 'FILLED'))
  rows.push(gatewayOrder('repair:dec-1:0#1', 'PLACED'))
  assert.equal(await fillState('live', 'repair:dec-1:0'), 'PENDING', 'one tranche still live is not a fill')

  rows[1]!['state'] = 'FILLED'
  assert.equal(await fillState('live', 'repair:dec-1:0'), 'FILLED')
})

test('live reads the gateway’s own `.N` tranche ids too, not only the bridge’s `#N`', async () => {
  const h = await harness()
  const fillState = repairFillState(h.deps, COLLECTIONS.gatewayOrders)
  h.db.rows(COLLECTIONS.gatewayOrders).push(gatewayOrder('repair:dec-1:0.1', 'FILLED'))
  h.db.rows(COLLECTIONS.gatewayOrders).push(gatewayOrder('repair:dec-1:0.2', 'FILLED'))
  assert.equal(await fillState('live', 'repair:dec-1:0'), 'FILLED')
})

test('a REJECTED, INVALID or PARTIAL tranche fails the whole order', async () => {
  for (const bad of ['REJECTED', 'INVALID', 'PARTIAL']) {
    const h = await harness()
    const fillState = repairFillState(h.deps, COLLECTIONS.gatewayOrders)
    h.db.rows(COLLECTIONS.gatewayOrders).push(gatewayOrder('repair:dec-1:0#0', 'FILLED'))
    h.db.rows(COLLECTIONS.gatewayOrders).push(gatewayOrder('repair:dec-1:0#1', bad))
    // PARTIAL especially: a real position of a size nobody asked for is a
    // failure of the PLAN, and the rest of the plan is sized against a leg
    // that is not there.
    assert.equal(await fillState('live', 'repair:dec-1:0'), 'FAILED', bad)
  }
})

test('an order the gateway has not answered for yet is PENDING, never FILLED', async () => {
  const h = await harness()
  const fillState = repairFillState(h.deps, COLLECTIONS.gatewayOrders)
  assert.equal(await fillState('live', 'repair:dec-1:0'), 'PENDING', 'no rows is not a fill')

  h.db.rows(COLLECTIONS.gatewayOrders).push(gatewayOrder('repair:dec-1:0#0', 'CLAIMED'))
  assert.equal(await fillState('live', 'repair:dec-1:0'), 'PENDING')
})

test('a tranche of ANOTHER order is not this one’s — the prefix stops at the separator', async () => {
  const h = await harness()
  const fillState = repairFillState(h.deps, COLLECTIONS.gatewayOrders)
  h.db.rows(COLLECTIONS.gatewayOrders).push(gatewayOrder('repair:dec-1:0', 'FILLED'))
  // `repair:dec-1:01` shares a prefix with `repair:dec-1:0` and is a different
  // order entirely — a substring match here would fail a run over it.
  h.db.rows(COLLECTIONS.gatewayOrders).push(gatewayOrder('repair:dec-1:01#0', 'REJECTED'))
  assert.equal(await fillState('live', 'repair:dec-1:0'), 'FILLED')
})

test('a store that cannot be read is PENDING — the wave ages out rather than booking a guess', async () => {
  const h = await harness()
  const fillState = repairFillState(h.deps, COLLECTIONS.gatewayOrders)
  h.db.raw(COLLECTIONS.gatewayOrders).failReads = true
  assert.equal(await fillState('live', 'repair:dec-1:0'), 'PENDING')
})

test('the collection is the RAIL’s, so a legacy-executor box does not read PENDING forever', async () => {
  const h = await harness()
  // `LIVE_COLLECTION.legacy` — the retired executor writes `positional`, and a
  // reader hardcoded to `desk-gateway-orders` would find nothing there, answer
  // PENDING to every poll, and age out a run whose closes had all filled.
  const legacy = LIVE_COLLECTION['legacy-positional']
  assert.notEqual(legacy, COLLECTIONS.gatewayOrders, 'fixture: the two names must differ')
  h.db.rows(legacy).push(gatewayOrder('repair:dec-1:0#0', 'FILLED'))

  assert.equal(await repairFillState(h.deps, legacy)('live', 'repair:dec-1:0'), 'FILLED')
  assert.equal(
    await repairFillState(h.deps, COLLECTIONS.gatewayOrders)('live', 'repair:dec-1:0'),
    'PENDING',
    'reading the wrong collection is exactly the silence this guards against',
  )
})

test('preflight handles nothing but its own path', async () => {
  const h = await harness()
  const url = new URL('http://desk/v1/desk/payoff')
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method: 'GET',
    principal: { kind: 'user', name: 'tester' },
    log: () => {},
    readJson: async () => ({}),
    send: () => {
      assert.fail('the repair route answered a path that is not its own')
    },
  }
  assert.equal(await h.route(ctx), false)
})
