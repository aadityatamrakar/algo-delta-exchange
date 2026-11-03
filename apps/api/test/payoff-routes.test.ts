/**
 * The payoff cockpit's three endpoints, against an in-memory stand-in for Mongo.
 *
 * A fake database rather than a real one, for the same reason `pnl-routes.test.ts`
 * uses one: what is under test here is the ASSEMBLY — a book's legs plus a chain
 * snapshot plus the registry's dials, turned into the exact wire shapes the web
 * and the CLI are being built against — and none of that is a database property.
 *
 * THE CHAIN IS COMPUTED, NOT INVENTED. Every quote in this fixture is
 * `b76Price` at one vol, so `solveChainIvs` reads that vol back out of it and a
 * strike's delta is a real Black-76 delta rather than a number chosen to make a
 * band pass. A hand-written chain would let a repair plan look feasible here and
 * be unbuyable on the desk.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { b76Price, yearsToExpiry, type OptionType } from '@algomaker/greeks'
import { BridgeService } from '../src/service.ts'
import { LiveRail, PaperRail } from '../src/rail.ts'
import { QuoteCache, StaticMarks } from '../src/marks.ts'
import { DeskStore, type Collection, type Database, type FindCursor, type UpdateOutcome } from '../src/store.ts'
import type { PayoffLeg } from '@algomaker/payoff'
import { buildChain, type ChainResponse, type ChainRow } from '../src/chain.ts'
import type { ApiDeps, Route, RouteCtx } from '../src/routes/kit.ts'
import { payoffRoutes, toWireLegs } from '../src/routes/payoff.ts'

// ------------------------------------------------------------- the fake port

type Doc = Record<string, unknown>

/** Mongo's comparison bracket for a value. Different brackets never compare. */
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
    if (key === '$or') {
      return Array.isArray(want) && want.some((sub) => matches(doc, sub as Doc))
    }
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
  async findOne(filter: Doc): Promise<T | null> {
    return (this.docs.find((d) => matches(d, filter)) as T | undefined) ?? null
  }
  find(filter: Doc): FindCursor<T> {
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
  readonly indexes: Doc[] = []
  async createIndex(spec: Record<string, 1 | -1>): Promise<unknown> {
    this.indexes.push(spec)
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
  rows(name: string): Doc[] {
    return (this.collection(name) as unknown as FakeCollection<unknown>).docs
  }
  indexesOn(name: string): Doc[] {
    return (this.collection(name) as unknown as FakeCollection<unknown>).indexes
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
/** One vol for the whole chain: what goes in comes back out of `solveChainIvs`. */
const VOL = 0.28
const RATE = 0.065
const T_YEARS = yearsToExpiry(EXPIRY, NOW)
/** Wide enough that the repairer finds sells (|Δ| .15–.35) AND wings (|Δ| ≤ .10). */
const STRIKES: readonly number[] = Array.from({ length: 21 }, (_, i) => 360 + i * 5)
const FUT_TOKEN = 600001

function token(strike: number, type: OptionType): number {
  return 700000 + strike * 10 + (type === 'CE' ? 1 : 2)
}

function symbolOf(strike: number, type: OptionType): string {
  return `BHEL26AUG${strike}${type}`
}

function priceOf(strike: number, type: OptionType): number {
  return b76Price({ future: FUTURE, strike, t: T_YEARS, vol: VOL, rate: RATE, type })
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
  /** Quote the future? Absent it, the book cannot be priced at all. */
  readonly future?: boolean
  /** `420CE`-style keys whose quote is published five minutes late. */
  readonly stale?: readonly string[]
  /** Which sides of the chain print at all. Dropping one degrades the book. */
  readonly sides?: readonly OptionType[]
  /** Seed the registry row, the variant catalogue and the margin figure? */
  readonly registry?: boolean
  /** Publish the strategy's steering greeks? Without them there is no band. */
  readonly steering?: boolean
  /**
   * The clock for the CACHE, the SERVICE and the ROUTE, movable so a test can
   * seed the fixture during the session and then read it after the close.
   * Everything is still SEEDED at `NOW` regardless.
   */
  readonly now?: () => number
}

interface Harness {
  db: FakeDb
  deps: ApiDeps
  m: OptionMaster
  marks: QuoteCache
  /**
   * ONE route instance for the whole test, exactly as `main.ts` builds one for
   * the whole process — the archive's "do not file the same picture twice"
   * damper is per instance, and a fresh route per call would hide it.
   */
  route: Route
  writes: Promise<unknown>[]
}

/** One short leg of the book, as `desk-books` stores it. */
function leg(m: OptionMaster, strike: number, type: OptionType, qty: number, entry: number): Doc {
  const ref = m.resolve(SYMBOL, EXPIRY, strike, type)
  assert.ok(ref !== null && ref !== undefined, `${strike}${type} is not in the master`)
  return {
    deskTag: `${TAG}-${strike}${type}`,
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
  const sides = opts.sides ?? (['CE', 'PE'] as const)
  const stale = new Set(opts.stale ?? [])

  const nowFn = opts.now ?? ((): number => NOW)
  const marks = new QuoteCache({ now: nowFn })
  for (const strike of STRIKES) {
    for (const type of sides) {
      const price = priceOf(strike, type)
      if (!(price > 0)) continue
      const late = stale.has(`${strike}${type}`)
      marks.update(token(strike, type), price, late ? NOW - 300_000 : NOW, { oi: 1000, volume: 10 })
    }
  }
  if (opts.future !== false) marks.update(FUT_TOKEN, FUTURE, NOW)

  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(db), live: new LiveRail(db, []) },
    master: { current: () => m },
    // The display path for `positions()`; the payoff assembly prices off the
    // CHAIN, so these only have to be present, not clever.
    marks: new StaticMarks(
      Object.fromEntries(
        STRIKES.flatMap((s) => (['CE', 'PE'] as const).map((t) => [symbolOf(s, t), priceOf(s, t)])),
      ),
      // DELIBERATELY A FLOAT THAT PRINTS BADLY: `408.3 + 0.05` is
      // 408.34999999999997, and any sentence that quotes spot has to round it
      // the way every other price on this desk is quoted.
      { [SYMBOL]: 408.3 + 0.05 },
    ),
    clock: { now: nowFn },
  })

  // The BOOK: short two lots of the 420 call and one lot of the 395 put. The
  // call side is deliberately the heavier one, so the expiry floor sits on the
  // upside and a bought call wing is a repair rather than a decoration.
  await store.saveBook({ tag: TAG, symbol: SYMBOL, expiry: EXPIRY, mode: 'paper' }, [
    leg(m, 420, 'CE', -2 * LOT, priceOf(420, 'CE') + 1.5),
    leg(m, 395, 'PE', -LOT, priceOf(395, 'PE') + 1.2),
  ] as never, NOW)

  if (opts.registry !== false) {
    db.rows('desk-books-registry').push({
      tag: TAG,
      symbol: SYMBOL,
      expiry: EXPIRY,
      mode: 'paper',
      variant: 'recenter-relief',
      // The row's own dials sit ON TOP of the variant's defaults.
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
    if (opts.steering !== false) {
      db.rows('desk-declarations').push({
        tag: TAG,
        symbol: SYMBOL,
        legs: [],
        declaredAt: NOW,
        greeks: { steeringDelta: -1500, steeringGamma: 6.5 },
        greeksAt: NOW,
      })
    }
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
  const writes: Promise<unknown>[] = []
  const route = payoffRoutes(deps, { onSnapshot: (p) => void writes.push(p) })
  return { db, deps, m, marks, route, writes }
}

interface Sent {
  status: number
  body: Doc
}

/** Every call in this file goes through the harness's one route and awaits its snapshot. */
async function call(
  h: Harness,
  method: string,
  target: string,
  body: unknown = {},
): Promise<Sent> {
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
  const handled = await h.route(ctx)
  assert.equal(handled, true, `${method} ${target} was not handled`)
  // FIRE-AND-FORGET IN PRODUCTION, AWAITED HERE. The route never makes a reader
  // wait on the archive; the hook exists so this file asserts on a landed
  // document rather than on a race.
  await Promise.all(h.writes)
  return sent
}

/** A second route instance over the same fake database — a different clock, one archive. */
function payoffRoutesFor(h: Harness, deps: ApiDeps): Route {
  return payoffRoutes(deps, { onSnapshot: (p) => void h.writes.push(p) })
}

const warningsOf = (body: Doc): string[] => (body['warnings'] ?? []) as string[]
const said = (body: Doc, re: RegExp): boolean => warningsOf(body).some((w) => re.test(w))

// --------------------------------------------------------------- the payoff

test('GET /v1/desk/payoff prices the book off the chain and archives what it served', async () => {
  const h = await harness()
  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)

  assert.equal(res.status, 200)
  assert.equal(res.body['tag'], TAG)
  assert.equal(res.body['mode'], 'paper')
  assert.equal(res.body['symbol'], SYMBOL)
  assert.equal(res.body['expiry'], EXPIRY)
  assert.equal(res.body['future'], FUTURE)
  assert.equal(res.body['asOf'], NOW)

  const view = res.body['view'] as Doc
  assert.ok(view !== null, `the view must be priced; warnings: ${JSON.stringify(warningsOf(res.body))}`)
  assert.equal((view['curve'] as unknown[]).length, 121, 'the dense ±10% scan')
  assert.ok((view['table'] as unknown[]).length > 0)
  const summary = view['summary'] as Doc
  assert.ok(Number(summary['netCredit']) > 0, 'a short-premium book collected premium')
  assert.equal(summary['targetPnl'], 150_000, "the registry row's own dial")
  assert.equal(summary['booked'], 0, 'nothing has been closed on this book')

  // The IVs the legs were stamped from — one row per quoted (strike, side).
  const ivs = res.body['ivs'] as Doc[]
  assert.equal(ivs.length, STRIKES.length * 2)
  const at420 = ivs.find((r) => r['strike'] === 420 && r['type'] === 'CE')
  assert.equal(at420?.['source'], 'quote')
  assert.ok(Math.abs(Number(at420?.['iv']) - VOL) < 1e-4, 'the vol that priced the chain comes back out')

  // The machine card: dials merged variant-under-row, margin from the broker.
  const machine = res.body['machine'] as Doc
  assert.equal(machine['marginFrac'], 0.5, '₹2.5L held against a ₹5L cap')
  assert.equal(machine['targetPnl'], 150_000)
  assert.ok(machine['deltaImbalance'] !== null, 'steering greeks were published — there is a verdict')
  assert.ok((machine['notes'] as string[]).length > 0)

  // AND THE ARCHIVE. One document, naming what it is and when.
  const snaps = h.db.rows('desk-payoff-snapshots')
  assert.equal(snaps.length, 1, `exactly one snapshot; got ${JSON.stringify(snaps.map((s) => s['kind']))}`)
  assert.equal(snaps[0]?.['tag'], TAG)
  assert.equal(snaps[0]?.['mode'], 'paper')
  assert.equal(snaps[0]?.['kind'], 'payoff')
  assert.equal(snaps[0]?.['ts'], NOW)
  assert.equal(((snaps[0]?.['payload'] as Doc)['view'] as Doc)['midDate'], view['midDate'])
})

test('no future mark: the view is null and says why, and it is still a 200', async () => {
  // 200 because "the feed has not printed the future yet" is a state to render,
  // not a client error — and a 500 here would take the machine card down with a
  // panel that has nothing to do with the chain.
  const h = await harness({ future: false })
  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)

  assert.equal(res.status, 200)
  assert.equal(res.body['view'], null)
  assert.equal(res.body['future'], null)
  assert.ok(said(res.body, /future/i), `no warning named the future: ${JSON.stringify(warningsOf(res.body))}`)
  assert.ok(res.body['machine'] !== null, 'the bot card does not need a future to read its dials')

  /**
   * AND IT SAYS NOTHING FALSE ABOUT THE LEGS. With no future there is no solved
   * skew at all, so every leg used to come back "no vol … marks FLAT to expiry"
   * — a claim about the LEG, made because of a missing input, on a response
   * whose `view` is null and which therefore marks nothing at all. One true
   * sentence beats one true sentence plus one per leg.
   */
  for (const w of warningsOf(res.body)) {
    assert.ok(!/marks FLAT/i.test(w), `a leg claimed a mark that was never taken: ${w}`)
    assert.ok(!/interpolat/i.test(w), `a leg claimed a vol nothing solved: ${w}`)
  }
})

test('with no future the machine band falls back to cash spot — and says which', async () => {
  // The fallback is deliberate (a measured band beats a blank card) and the two
  // prices differ by the carry, which is real money on a tolerance quoted in
  // percent. Silent is the one thing it must not be.
  const h = await harness({ future: false })
  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.ok(
    said(res.body, /CASH SPOT 408\.35 /),
    `the fallback was silent, or quoted spot raw: ${JSON.stringify(warningsOf(res.body))}`,
  )
  assert.ok(!said(res.body, /408\.3499/), 'a price on this desk is quoted to the paisa')
  assert.ok((res.body['machine'] as Doc)['deltaImbalance'] !== null, 'and it did measure a band')

  // …and it is NOT said when the future is printing.
  const withFuture = await harness()
  const ok = await call(withFuture, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.ok(!said(ok.body, /CASH SPOT/), JSON.stringify(warningsOf(ok.body)))

  // …nor when there was no band to compute off it. With no steering pair the
  // card reports no imbalance at all, and a caveat about the price a band was
  // measured from is then a caveat about nothing.
  const noBand = await harness({ future: false, steering: false })
  const blank = await call(noBand, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal((blank.body['machine'] as Doc)['deltaImbalance'], null)
  assert.ok(!said(blank.body, /CASH SPOT/), JSON.stringify(warningsOf(blank.body)))
})

test('a leg whose own quote went stale is marked at an INTERPOLATED vol, and says so', async () => {
  // `ivFor` alone cannot tell a measured vol from a rebuilt one — it returns a
  // bare number either way. The provenance is on `SolvedIv.source`, and a leg
  // sized on an estimated vega must be able to know it was an estimate.
  const h = await harness({ stale: ['420CE'] })
  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)

  const ivs = res.body['ivs'] as Doc[]
  assert.equal(ivs.find((r) => r['strike'] === 420 && r['type'] === 'CE')?.['source'], 'interp')
  assert.ok(
    said(res.body, /BHEL26AUG420CE.*interpolat/i),
    `the leg was not named: ${JSON.stringify(warningsOf(res.body))}`,
  )
  // …and it is still priced. An estimate beats a hole.
  assert.ok(res.body['view'] !== null)
})

test('realised P&L that cannot be vouched for is treated as nothing banked, and named', async () => {
  const h = await harness()
  // A fill the journal cannot read makes `realised` unknowable rather than 0.
  h.db.rows('desk-decisions').push({
    decisionId: 'd-bad',
    symbol: SYMBOL,
    expiry: EXPIRY,
    tag: TAG,
    mode: 'paper',
    createdAt: NOW - 3600_000,
    fills: [{ op: 'open', deskTag: 'x', tradingsymbol: symbolOf(420, 'CE'), side: 'Sell', qty: LOT, price: 'NaN', ts: NOW - 3600_000 }],
    skips: [],
  })
  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.ok(said(res.body, /realised unknown/i), JSON.stringify(warningsOf(res.body)))
  assert.equal(((res.body['view'] as Doc)['summary'] as Doc)['booked'], 0)
})

test('a tag nobody has a book for is a 200 that says so, not a 404 and not a blank chart', async () => {
  const h = await harness()
  const res = await call(h, 'GET', '/v1/desk/payoff?tag=GHOST&mode=paper')
  assert.equal(res.status, 200)
  assert.match(String(res.body['error']), /GHOST/)
  assert.equal(res.body['view'], null)
  assert.equal(h.db.rows('desk-payoff-snapshots').length, 0, 'nothing was served, so nothing is archived')
})

test('every endpoint refuses to guess a tag', async () => {
  const h = await harness()
  for (const target of ['/v1/desk/payoff?mode=paper', '/v1/desk/repair?mode=paper']) {
    const res = await call(h, 'GET', target)
    assert.equal(res.status, 400, target)
    assert.match(String(res.body['error']), /tag is required/)
  }
  const post = await call(h, 'POST', '/v1/desk/payoff/whatif', { mode: 'paper', proposed: [] })
  assert.equal(post.status, 400)
})

// --------------------------------------------------------------- the what-if

test('POST whatif prices a proposed wing against the book it would join', async () => {
  const h = await harness()
  const res = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    // One bought call wing — the cap on the side this book is heaviest.
    proposed: [{ strike: 435, type: 'CE', qty: LOT }],
  })
  assert.equal(res.status, 200)

  const current = res.body['current'] as Doc
  const combined = res.body['combined'] as Doc
  const after = (combined['view'] as Doc)['summary'] as Doc
  assert.ok(current !== null && after !== null)
  assert.ok(
    Number(after['floor']) >= Number(current['floor']),
    `the wing must not lower the floor: ${String(current['floor'])} -> ${String(after['floor'])}`,
  )
  assert.ok(Number(after['floor']) > Number(current['floor']), 'and on this book it lifts it')
  assert.equal(combined['tag'], TAG)
  assert.equal(h.db.rows('desk-payoff-snapshots').length, 0, 'a hypothetical is not history')
})

test('a proposed leg the chain cannot price is dropped and named, never filled at a guess', async () => {
  const h = await harness()
  const res = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    proposed: [{ strike: 9999, type: 'CE', qty: LOT }],
  })
  assert.equal(res.status, 200)
  assert.ok(
    said(res.body['combined'] as Doc, /9999/),
    JSON.stringify(warningsOf(res.body['combined'] as Doc)),
  )
})

test('a proposal this endpoint cannot READ is named too, by position', async () => {
  // A different failure from the one above and it must not read the same: the
  // chain could not price that one, and this one never became a leg at all. A
  // combined curve missing a leg the caller believes it is looking at is the
  // whole reason neither may be dropped in silence.
  const h = await harness()
  const res = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    proposed: [{ strike: 435, type: 'XX', qty: LOT }, { strike: 435, type: 'CE', qty: LOT }],
  })
  assert.equal(res.status, 200)
  assert.ok(
    said(res.body['combined'] as Doc, /proposed\[0\]/),
    JSON.stringify(warningsOf(res.body['combined'] as Doc)),
  )
  // …and the readable one beside it was still applied.
  const after = ((res.body['combined'] as Doc)['view'] as Doc)['summary'] as Doc
  assert.ok(Number(after['floor']) > Number((res.body['current'] as Doc)['floor']))
})

/**
 * ── THE PLAN'S OWN VOCABULARY ───────────────────────────────────────────────
 *
 * `proposed` speaks CONTRACTS and cannot un-hold one, so a repair plan of pure
 * closes translated to an empty proposal and came back as the UNCHANGED book
 * under the label "if placed" — a flatten previewing as "this changes nothing".
 * `moves` is the repairer's own language, applied by the same `applyMoves` that
 * scored the plan, so the curve that comes back IS the plan.
 */
test('POST whatif takes a plan\'s MOVES, and a close-only plan really closes', async () => {
  const h = await harness()
  const before = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    proposed: [],
  })
  const current = before.body['current'] as Doc

  const res = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    // The heavier side, taken off. Nothing `proposed` could ever have said.
    moves: [{ op: 'close', legId: symbolOf(420, 'CE') }],
  })
  assert.equal(res.status, 200)
  const combined = res.body['combined'] as Doc
  const view = combined['view'] as Doc
  assert.ok(view !== null, JSON.stringify(warningsOf(combined)))
  const after = view['summary'] as Doc

  /*
    THE SHORT CALL IS GONE, so the upside no longer runs away: the book is one
    short put, whose expiry curve is FLAT above its strike. Read off the top of
    the scan rather than from the summary, because "flat" is a statement about
    the curve and the summary is a statement about its extremes.
  */
  const curve = view['curve'] as Doc[]
  const top = curve.slice(-8).map((p) => Number(p['expiry']))
  const spread = Math.max(...top) - Math.min(...top)
  assert.ok(spread < 1, `the upside must be flat once the call is closed: ${JSON.stringify(top)}`)
  assert.ok(
    Number(after['maxProfit']) < Number((current as Doc)['maxProfit']),
    'and buying the short call back costs the premium it was sold for',
  )

  /*
    AND THE CLOSE'S P&L IS BANKED. `booked` is the run's realised, and a close
    that did not fold its own P&L into it would draw the whole curve at the
    book's OLD banked figure — the cost of getting out simply missing from the
    one picture drawn to show what getting out is worth.
  */
  assert.notEqual(Number(after['booked']), Number((current as Doc)['booked']))
})

test('POST whatif takes a SHIFT, both halves or neither', async () => {
  const h = await harness()
  const res = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'shift', legId: symbolOf(420, 'CE'), toStrike: 435 }],
  })
  assert.equal(res.status, 200)
  const combined = res.body['combined'] as Doc
  assert.deepEqual(warningsOf(combined), warningsOf(await payoffBody(h)), 'a clean shift says nothing new')
  const after = ((combined['view'] as Doc)['summary'] as Doc)
  const current = res.body['current'] as Doc
  // Carrying the short call further out of the money lifts the upside floor.
  assert.ok(
    Number(after['floor']) > Number(current['floor']),
    `${String(current['floor'])} -> ${String(after['floor'])}`,
  )
})

test('a move the chain cannot apply is dropped and NAMED, and the rest still lands', async () => {
  const h = await harness()
  const res = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    moves: [
      { op: 'close', legId: 'BHEL26AUG999CE' },
      { op: 'close', legId: symbolOf(420, 'CE') },
    ],
  })
  assert.equal(res.status, 200)
  const combined = res.body['combined'] as Doc
  assert.ok(said(combined, /no such leg in the book/), JSON.stringify(warningsOf(combined)))
  assert.ok(said(combined, /999CE/), JSON.stringify(warningsOf(combined)))
  // …and the readable one beside it really happened.
  const legs = ((combined['view'] as Doc)['summary'] as Doc)
  assert.ok(Number(legs['maxProfit']) < Number((res.body['current'] as Doc)['maxProfit']))
  /*
    THE REQUEST'S OWN SENTENCES RIDE A CHANNEL OF THEIR OWN. `combined.warnings`
    folds them into the book-level envelope, and a client separating the two by
    set-difference against a stale envelope misattributes any book-level warning
    that appeared between two polls to the plan being loaded. One drop of two
    moves is ONE sentence here — the count is what tells "partly loaded" from
    "nothing loaded".
  */
  const dropped = res.body['dropped'] as string[]
  assert.equal(dropped.length, 1, JSON.stringify(dropped))
  assert.match(dropped[0] ?? '', /999CE.*no such leg/)
})

test('EVERY leg closed answers FLAT at what it banked — never the empty view', async () => {
  const h = await harness()
  /*
    "FLATTEN AND BANK" IS THE MOST CONSEQUENTIAL PLAN THE MENU OFFERS, and it
    used to preview as NOTHING: a zero-leg book reaches `emptyView` ("no legs:
    nothing to price", every figure a literal 0, an empty curve the panel
    rightly refuses to draw). `goals.ts` scores this case with its own flat
    branch; the preview must answer with the same flat line at `booked`.
  */
  const res = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    moves: [
      { op: 'close', legId: symbolOf(420, 'CE') },
      { op: 'close', legId: symbolOf(395, 'PE') },
    ],
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body['dropped'], [], 'both closes price off the chain')
  const view = (res.body['combined'] as Doc)['view'] as Doc
  assert.ok(view !== null, 'a flatten is a real answer, not an unpriceable book')
  const curve = view['curve'] as Doc[]
  assert.ok(curve.length > 1, 'the flat line is still a drawable curve')
  const summary = view['summary'] as Doc
  const booked = Number(summary['booked'])
  // Both legs were seeded ABOVE their marks, so buying them back banks a profit
  // — and a flatten that lost the closes' P&L would print the OLD booked here.
  assert.ok(booked > 0, `closing both shorts banks their premium: ${String(booked)}`)
  for (const p of curve) {
    assert.equal(Number(p['expiry']), booked, `flat at booked, everywhere: ${JSON.stringify(p)}`)
    assert.equal(Number(p['t0']), booked)
    assert.equal(Number(p['mid']), booked)
  }
  assert.equal(Number(summary['floor']), booked)
  assert.equal(Number(summary['maxProfit']), booked)
  assert.equal(Number(summary['maxLoss']), booked)
  // A flat line never crosses zero: no breakeven on either side.
  assert.deepEqual(summary['breakevens'], { down: null, up: null })
  // "Will the open legs finish green" has no answer with no open legs.
  assert.equal(Number(summary['pop']), 0)
})

test('a `moves` that is not an array is a 400, and an absent one is not', async () => {
  const h = await harness()
  const bad = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    moves: 'close them all',
  })
  assert.equal(bad.status, 400)
  assert.match(String(bad.body['error']), /moves must be an array/)
  // The old request — `proposed` alone — is still exactly as legal as it was.
  const old = await call(h, 'POST', '/v1/desk/payoff/whatif', { tag: TAG, mode: 'paper', proposed: [] })
  assert.equal(old.status, 200)
  // And neither field at all is still the old refusal.
  const neither = await call(h, 'POST', '/v1/desk/payoff/whatif', { tag: TAG, mode: 'paper' })
  assert.equal(neither.status, 400)
  assert.match(String(neither.body['error']), /proposed must be an array/)
  /*
    PRESENT-AND-UNREADABLE IS A 400 FOR EITHER FIELD, INDEPENDENTLY. An
    unreadable `proposed` must not ride to a 200 on the back of a well-formed
    `moves`: coercing it to [] silently drops legs the caller believes are in
    the curve it gets back.
  */
  const both = await call(h, 'POST', '/v1/desk/payoff/whatif', {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'close', legId: symbolOf(420, 'CE') }],
    proposed: { strike: 435, type: 'CE', qty: 1 },
  })
  assert.equal(both.status, 400)
  assert.match(String(both.body['error']), /proposed must be an array/)
})

/** The plain payoff's warnings, for the "said nothing new" comparison above. */
async function payoffBody(h: Harness): Promise<Doc> {
  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  return res.body
}

// ---------------------------------------------------------------- the repair

test('GET /v1/desk/repair returns all four goals, each with something to say', async () => {
  const h = await harness()
  const res = await call(h, 'GET', `/v1/desk/repair?tag=${TAG}&mode=paper`)
  assert.equal(res.status, 200)

  const goals = res.body['goals'] as Doc[]
  assert.deepEqual(
    goals.map((g) => g['goal']),
    ['REDUCE-LOSS', 'PROFITABLE-BY-EXPIRY', 'CHEAP-TAIL-CAP', 'MAX-CREDIT-SAFE'],
    'goal order is part of the contract',
  )
  for (const g of goals) {
    assert.ok((g['plans'] as unknown[]).length >= 1, `${String(g['goal'])} returned nothing at all`)
    // Every goal is ranked against a do-nothing baseline, and the baseline says
    // so — a menu of four baselines would satisfy the count above while
    // proposing nothing at all.
    const flags = (g['plans'] as Doc[]).map((p) => (p['flags'] as string[]).join(','))
    assert.ok(flags.some((f) => f.includes('baseline')), `${String(g['goal'])} has no baseline to rank against`)
  }
  const proposed = goals.flatMap((g) => g['plans'] as Doc[]).filter((p) => (p['moves'] as unknown[]).length > 0)
  assert.ok(proposed.length > 0, 'the search found nothing to propose on a chain this wide')
  for (const p of proposed) {
    const score = p['score'] as Doc
    assert.equal(typeof score['maxLoss'], 'number')
    assert.equal(typeof score['marginDelta'], 'number')
  }

  const universe = res.body['universe'] as Doc
  assert.ok(Number(universe['atomic']) > 0, 'the alphabet a plan is spelled in must not be empty')
  assert.ok(Number(universe['evaluated']) > 0)

  const dials = res.body['dials'] as Doc
  assert.equal(dials['lotSize'], LOT, 'sized in lots of the contract, never in single shares')
  assert.equal(dials['addDeltaMin'], 0.15)

  const snaps = h.db.rows('desk-payoff-snapshots')
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0]?.['kind'], 'repair')
  assert.equal(((snaps[0]?.['payload'] as Doc)['goals'] as unknown[]).length, 4)
})

test('the repair menu carries the payoff engine’s own warnings about a degraded book', async () => {
  // No PE prints at all, so the put leg admits no vol and marks FLAT until
  // expiry — every plan below is scored on a book that is quietly missing a
  // leg's convexity. `RepairPlan` has no warnings channel of its own, so the
  // route is the only place this can be said.
  const h = await harness({ sides: ['CE'] })
  const res = await call(h, 'GET', `/v1/desk/repair?tag=${TAG}&mode=paper`)
  assert.equal(res.status, 200)
  // THE ENGINE'S OWN SENTENCE, verbatim — not this route's assembly warning
  // about the same leg. The two are different claims: the route says the chain
  // could not solve a vol, and this says every plan below was SCORED on a book
  // that marks the leg flat. Matching loosely here let a mutant that dropped
  // the fold entirely go green.
  assert.ok(
    warningsOf(res.body).some((w) => /^leg "BHEL26AUG395PE": no IV/.test(w)),
    `the payoff engine's own warning did not reach the menu: ${JSON.stringify(warningsOf(res.body))}`,
  )
})

test('a repair with no future to price against is empty and says so, at 200', async () => {
  const h = await harness({ future: false })
  const res = await call(h, 'GET', `/v1/desk/repair?tag=${TAG}&mode=paper`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body['goals'], [])
  assert.ok(said(res.body, /future/i))
})

// ------------------------------------------------------------- the archive

/**
 * THE DAMPER, which is the difference between an archive and a disk-filling
 * loop. A dashboard polls; a book out of hours does not move; and a ~30KB
 * document filed every five seconds is 43-86MB a day for a picture that never
 * changed. Nothing prunes this collection yet, so not writing it is the only
 * lever there is.
 */
test('an answer that has not changed is not archived twice; a changed one is', async () => {
  const h = await harness()
  await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal(h.db.rows('desk-payoff-snapshots').length, 1, 'the same picture, filed twice')

  // The market moves: the 420 call ticks up. That IS a different answer.
  h.marks.update(token(420, 'CE'), priceOf(420, 'CE') + 3, NOW)
  await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal(h.db.rows('desk-payoff-snapshots').length, 2, 'a moved book was not archived')

  // …and the repair menu keeps its own key: same tag, same mode, other kind.
  await call(h, 'GET', `/v1/desk/repair?tag=${TAG}&mode=paper`)
  await call(h, 'GET', `/v1/desk/repair?tag=${TAG}&mode=paper`)
  const kinds = h.db.rows('desk-payoff-snapshots').map((d) => d['kind'])
  assert.deepEqual(kinds, ['payoff', 'payoff', 'repair'], JSON.stringify(kinds))
})

/**
 * ONE SLOT PER KIND, which the sequence above cannot actually prove: `kind` is
 * inside the fingerprint too, so a key of tag|mode alone passes it. ALTERNATING
 * is the case that separates them — with one shared slot the repair's print
 * would evict the payoff's and the third call would file a duplicate of a
 * picture already on file.
 */
test('the payoff and the repair each hold their own place in the damper', async () => {
  const h = await harness()
  await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  await call(h, 'GET', `/v1/desk/repair?tag=${TAG}&mode=paper`)
  await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  const kinds = h.db.rows('desk-payoff-snapshots').map((d) => d['kind'])
  assert.deepEqual(kinds, ['payoff', 'repair'], `the payoff was filed twice: ${JSON.stringify(kinds)}`)
})

/**
 * FRESHNESS IS A STEP, AND THE STEP IS AN EVENT.
 *
 * `solveChainIvs` refuses a quote older than two minutes and rebuilds that
 * strike off its neighbours instead. So a wing that simply sits there, at one
 * unchanged price, crossing that line flips its leg from a measured vol to an
 * interpolated one: the stamped IV moves, the whole t0 curve moves, a warning
 * appears and the repair bands shift — with every price on the chain identical.
 * On the illiquid wings this desk runs that is the ordinary way an answer
 * changes, and an inputs fingerprint blind to it would archive NOTHING for the
 * rest of a quiet window.
 */
test('a quote going stale at an unchanged price is a new answer, and is archived', async () => {
  const h = await harness()
  const before = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal(h.db.rows('desk-payoff-snapshots').length, 1)
  const solvedBefore = (before.body['ivs'] as Doc[]).find((r) => r['strike'] === 420 && r['type'] === 'CE')
  assert.equal(solvedBefore?.['source'], 'quote')

  // THE SAME PRICE, re-stamped as five minutes old. Nothing about the market
  // moved; the evidence simply expired.
  h.marks.update(token(420, 'CE'), priceOf(420, 'CE'), NOW - 300_000)

  const after = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  const solvedAfter = (after.body['ivs'] as Doc[]).find((r) => r['strike'] === 420 && r['type'] === 'CE')
  assert.equal(solvedAfter?.['source'], 'interp', 'the answer really did change')
  assert.ok(said(after.body, /BHEL26AUG420CE.*interpolat/i))
  assert.equal(
    h.db.rows('desk-payoff-snapshots').length,
    2,
    'the flip from measured to interpolated vol was not archived',
  )
})

/**
 * AND THE CLOCK ALONE IS NOT A CHANGE. `asOf` moves every millisecond and the
 * solved IVs drift in their sixth decimal as the tenor shrinks, so a byte
 * compare would never fire and the damper above would be a no-op in production
 * while passing every test written at a frozen clock.
 */
test('a poll one second later, on an unmoved book, is still the same picture', async () => {
  const h = await harness()
  await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  const first = h.db.rows('desk-payoff-snapshots').length
  assert.equal(first, 1)

  // The only thing that changed is the clock. Everything the book is made of —
  // the legs, the chain, the registry — is untouched.
  let later = NOW + 1_000
  const deps: ApiDeps = { ...h.deps, now: () => later }
  const moved: Harness = { ...h, deps, route: payoffRoutesFor(h, deps) }
  await call(moved, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  const before = h.db.rows('desk-payoff-snapshots').length
  await call(moved, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal(
    h.db.rows('desk-payoff-snapshots').length,
    before,
    'a second poll at a second clock filed a duplicate — the fingerprint is reading the clock',
  )
  later += 60_000
  await call(moved, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal(h.db.rows('desk-payoff-snapshots').length, before, 'a minute later, still the same book')
})


test('ensureIndexes declares the (tag, ts) index the snapshot history is read by', async () => {
  const db = new FakeDb()
  await new DeskStore(db).ensureIndexes()
  const keys = db.indexesOn('desk-payoff-snapshots').map((s) => Object.keys(s).join(','))
  assert.ok(keys.includes('tag,ts'), `no index for a tag's history; got ${JSON.stringify(keys)}`)
})

// ------------------------------------------------- the broker margin verify

/**
 * THE ONE NUMBER THE COCKPIT CANNOT COMPUTE ITSELF.
 *
 * `spanLiteMargin` is a 21-cell grid and a floor; the broker's is SPAN plus
 * whatever Zerodha's own tiers say that day. The gap between them is the
 * difference between a plan that can be placed and one that is refused at the
 * counter — so the plan the operator is about to take to the order box gets
 * priced by the broker, through the ONE process holding the Kite session.
 *
 * What is asserted here is the WIRE and the REFUSALS: that the FULL combined
 * book crosses it (not just the moves — a broker prices a portfolio, and the
 * hedge that makes a plan cheap is the leg already held), and that a broker
 * that cannot answer leaves `broker: null` beside an estimate that is always
 * there. A verify screen that blanks when Kite hiccups is a screen nobody uses.
 */

interface FakeMd {
  readonly fetch: typeof globalThis.fetch
  /** Every body POSTed, already parsed. */
  readonly posted: Doc[]
  readonly urls: string[]
  readonly auth: (string | null)[]
}

function fakeMd(reply: { status?: number; body?: unknown } | Error): FakeMd {
  const posted: Doc[] = []
  const urls: string[] = []
  const auth: (string | null)[] = []
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    urls.push(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    auth.push(headers['authorization'] ?? null)
    posted.push(JSON.parse(String(init?.body ?? 'null')) as Doc)
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch: impl as unknown as typeof globalThis.fetch, posted, urls, auth }
}

const MD_URL = 'http://md.test:8892'
const MD_TOKEN = 'machine-bearer'

/** A harness whose route talks to `md` instead of to a socket. */
function verifying(h: Harness, md: FakeMd): Harness {
  return {
    ...h,
    route: payoffRoutes(h.deps, {
      onSnapshot: (p) => void h.writes.push(p),
      margin: { url: MD_URL, token: MD_TOKEN, fetch: md.fetch },
    }),
  }
}

/**
 * A reply from a marketdata that PREDATES `premiumPaid` — deliberately, so the
 * backward tolerance is exercised by the happy path rather than by one test.
 */
const BROKER_OK = { total: 250_000, span: 200_000, exposure: 50_000 }
/**
 * What that reply must become on the wire out: the tile's four fields, plus the
 * flag that says whose RATES they are. `calibrated: false` because the harness
 * seeds no `desk-broker-snapshot` — see `calibrating` below.
 */
const BROKER_SEEN = {
  total: 250_000,
  span: 200_000,
  exposure: 50_000,
  premiumPaid: 0,
  calibrated: false,
}

/**
 * Seed the ONE document `brokerCalibration` derives the account's multipliers
 * from, so `brokerFigures` stops being the identity.
 *
 * `TotalSpanMargin / Σ span` and `ExposureMarginPresent / Σ exposure` over the
 * priced books — the harness's single `desk-book-margin` row is 200k/50k, so
 * 210k and 52.5k make both ratios exactly 1.05, which is the XTS account's own
 * measured uplift (2026-08-04) and comfortably inside the sanity bounds.
 */
function calibrating(h: Harness): Harness {
  h.db.rows('desk-broker-snapshot').push({
    _id: 'xts',
    asOf: NOW,
    ok: true,
    funds: { TotalSpanMargin: 210_000, ExposureMarginPresent: 52_500 },
  })
  return h
}

/** A long 430 call wing, two lots — the hedge that makes the short call cheap. */
const HEDGE = [{ op: 'hedge', strike: 430, type: 'CE', qty: 2 * LOT }]

test('verify-margin proxies the FULL combined book, not just the moves', async () => {
  const md = fakeMd({ body: BROKER_OK })
  const h = verifying(await harness(), md)
  const res = await call(h, 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: HEDGE,
  })

  assert.equal(res.status, 200)
  // A marketdata that has not been restarted since `premiumPaid` shipped sends
  // three fields; the missing one is zero, which is exactly what it meant there.
  assert.deepEqual(res.body['broker'], BROKER_SEEN)
  assert.ok(Number(res.body['estimated']) > 0, 'the SPAN-lite estimate is always present')
  assert.deepEqual(res.body['warnings'], [])

  assert.equal(md.urls.length, 1)
  assert.equal(md.urls[0], `${MD_URL}/v1/md/margin-basket`)
  assert.equal(md.auth[0], `Bearer ${MD_TOKEN}`, 'the same machine principal history uses')

  const legs = (md.posted[0]?.['legs'] ?? []) as Doc[]
  assert.deepEqual(
    legs.map(
      (l) =>
        `${String(l['underlying'])} ${String(l['expiry'])} ${String(l['strike'])}${String(l['type'])} ${String(l['qty'])}`,
    ),
    [
      // THE LEGS ALREADY HELD, and then the proposal. A broker prices a
      // portfolio: posting the hedge alone would price a naked long call and
      // report a margin of nothing for a plan that still carries two short legs.
      `${SYMBOL} ${EXPIRY} 420CE ${String(-2 * LOT)}`,
      `${SYMBOL} ${EXPIRY} 395PE ${String(-LOT)}`,
      `${SYMBOL} ${EXPIRY} 430CE ${String(2 * LOT)}`,
    ],
    JSON.stringify(legs),
  )
})

test('a close takes the leg OFF the posted book', async () => {
  const md = fakeMd({ body: BROKER_OK })
  const h = verifying(await harness(), md)
  await call(h, 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'close', legId: symbolOf(395, 'PE') }],
  })
  const legs = (md.posted[0]?.['legs'] ?? []) as Doc[]
  assert.deepEqual(legs.map((l) => `${String(l['strike'])}${String(l['type'])}`), ['420CE'])
})

/**
 * THE PANEL AND THE TILE MUST NOT DISAGREE ABOUT ONE BOOK.
 *
 * The per-book margin tile's headline is `span + exposure + premiumPaid`
 * (`book-margin.ts`'s `brokerFigures`) because the broker BLOCKS the long legs'
 * premium as margin too — the XTS account's `MarginUsed` matches that sum to the
 * paisa. Zerodha's calculator prints only `span + exposure`. Serving the
 * calculator's figure here would show a SMALLER margin on the verify panel than
 * the tile shows for the same book, on exactly the books a repair adds a long
 * wing to — and an operator reads a smaller margin as headroom.
 */
test('the broker headline includes the long legs’ premium, as the tile does', async () => {
  const md = fakeMd({ body: { ...BROKER_OK, premiumPaid: 34_675 } })
  const h = verifying(await harness(), md)
  // HEDGE buys a 430 call, so the plan really does hold a long leg.
  const res = await call(h, 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: HEDGE,
  })
  assert.deepEqual(res.body['broker'], {
    total: 284_675,
    span: 200_000,
    exposure: 50_000,
    premiumPaid: 34_675,
    calibrated: false,
  })
  // And the components are still there, so Kite's own 2,50,000 is recoverable.
  const broker = res.body['broker'] as Doc
  assert.equal(Number(broker['span']) + Number(broker['exposure']), 250_000)
})

/**
 * WHOSE RATES THESE ARE, ON THE WIRE.
 *
 * `brokerFigures` with no calibration is the IDENTITY — Zerodha's own rates, in
 * the account's shape — and the four figures are indistinguishable from
 * calibrated ones by inspection. The verify panel prints a sentence naming the
 * rates, so the flag has to travel with the numbers: without it the panel says
 * "at this account's calibrated rates" over a figure no multiplier ever touched,
 * which is a claim about a x1.05 that was not applied.
 *
 * BOTH DIRECTIONS, because a flag that is hardcoded true and a flag that is
 * hardcoded false each pass one half of this.
 */
test('the broker figure says whether the account’s calibration was applied', async () => {
  // No `desk-broker-snapshot` at all — the harness's default, and the live case
  // for any desk the gateway has not published funds for.
  const raw = await call(verifying(await harness(), fakeMd({ body: BROKER_OK })), 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: HEDGE,
  })
  assert.equal((raw.body['broker'] as Doc)['calibrated'], false)
  assert.equal((raw.body['broker'] as Doc)['span'], 200_000, 'Zerodha’s own span, untouched')

  // ...and with the snapshot the ratios derive from, the SAME reply comes back
  // multiplied and flagged, so the sentence and the number change together.
  const cal = await call(
    verifying(calibrating(await harness()), fakeMd({ body: BROKER_OK })),
    'POST',
    '/v1/desk/repair/verify-margin',
    { tag: TAG, mode: 'paper', moves: HEDGE },
  )
  const b = cal.body['broker'] as Doc
  assert.equal(b['calibrated'], true)
  assert.equal(b['span'], 210_000)
  assert.equal(b['exposure'], 52_500)
  assert.equal(b['total'], 262_500)
})

test('the reply’s own `total` is not trusted — the components are', async () => {
  // A far side whose `total` disagrees with its own parts must not be able to
  // put a number on this panel that none of its components add up to.
  const md = fakeMd({ body: { total: 999_999, span: 200_000, exposure: 50_000, premiumPaid: 1_000 } })
  const h = verifying(await harness(), md)
  const res = await call(h, 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: HEDGE,
  })
  assert.equal((res.body['broker'] as Doc)['total'], 251_000)
})

test('the estimate is of the COMBINED book — a wing makes it cheaper', async () => {
  // Not a tautology: it is what proves `estimated` is computed on the applied
  // book rather than on the stored one. A long call above the short strikes
  // caps the upside scenario the grid reads its worst loss off.
  const naked = fakeMd({ body: BROKER_OK })
  const bare = await call(verifying(await harness(), naked), 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: [],
  })
  const hedged = fakeMd({ body: BROKER_OK })
  const capped = await call(verifying(await harness(), hedged), 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: HEDGE,
  })
  assert.ok(
    Number(capped.body['estimated']) < Number(bare.body['estimated']),
    `hedged ${String(capped.body['estimated'])} was not cheaper than naked ${String(bare.body['estimated'])}`,
  )
})

test('a move the chain cannot fill is NAMED and never reaches the broker', async () => {
  const md = fakeMd({ body: BROKER_OK })
  const h = verifying(await harness({ sides: ['CE'] }), md)
  const res = await call(h, 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: [{ op: 'add', strike: 390, type: 'PE', qty: -LOT }],
  })
  assert.equal(res.status, 200)
  assert.ok(
    warningsOf(res.body).some((w) => /390PE.*no price/i.test(w)),
    JSON.stringify(warningsOf(res.body)),
  )
  const legs = (md.posted[0]?.['legs'] ?? []) as Doc[]
  assert.ok(
    !legs.some((l) => l['strike'] === 390),
    'a leg that could not be filled must not reach the broker as if it had been',
  )

  // AND the estimate says it guessed. With no PE side on the chain the held
  // 395PE solves no vol, so `spanLiteMargin` scans it at its 35% default —
  // silently, because that estimator returns no warnings by design. An estimate
  // carrying a guessed vol is not the same claim as one carrying the chain's.
  assert.ok(
    warningsOf(res.body).some((w) => /BHEL26AUG395PE.*DEFAULT volatility/.test(w)),
    JSON.stringify(warningsOf(res.body)),
  )
})

test('the broker declining leaves broker null, an estimate, and a sentence', async () => {
  const replies: ({ status?: number; body?: unknown } | Error)[] = [
    new Error('connect ECONNREFUSED 127.0.0.1:8892'),
    { status: 502, body: { error: 'basket margin HTTP 403: token rejected' } },
    { status: 200, body: { error: 'BHEL 999CE is not listed' } },
    { status: 200, body: { total: 'lots' } },
  ]
  for (const reply of replies) {
    const md = fakeMd(reply)
    const h = verifying(await harness(), md)
    const res = await call(h, 'POST', '/v1/desk/repair/verify-margin', {
      tag: TAG,
      mode: 'paper',
      moves: HEDGE,
    })
    assert.equal(res.status, 200, 'a broker outage is not a failed request')
    assert.equal(res.body['broker'], null)
    assert.ok(Number(res.body['estimated']) > 0, 'the estimate survives the broker')
    assert.ok(warningsOf(res.body).length > 0, `no warning for ${JSON.stringify(reply)}`)
  }
})

test('verify-margin with no tag is a 400 — there is no all-books margin', async () => {
  const md = fakeMd({ body: BROKER_OK })
  const h = verifying(await harness(), md)
  const res = await call(h, 'POST', '/v1/desk/repair/verify-margin', { mode: 'paper', moves: [] })
  assert.equal(res.status, 400)
  assert.equal(md.posted.length, 0, 'nothing was asked of the broker')
})

test('a tag that names no book answers 200 with the reason and no broker call', async () => {
  const md = fakeMd({ body: BROKER_OK })
  const h = verifying(await harness(), md)
  const res = await call(h, 'POST', '/v1/desk/repair/verify-margin', {
    tag: 'DESK_NOTHING',
    mode: 'paper',
    moves: [],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body['broker'], null)
  assert.equal(res.body['estimated'], 0)
  assert.ok(said(res.body, /has no book/))
  assert.equal(md.posted.length, 0)
})

// ------------------------------------------------ what crosses the wire, alone

/**
 * `toWireLegs` DIRECTLY, because both of its refusals are hard to stage through
 * the route and both are the ones that matter: they decide whether a basket the
 * broker prices describes the book the operator is looking at.
 *
 * It takes the three fields it needs rather than a whole `Assembled` — which is
 * what lets these be three-line literals.
 */

function chainOf(rows: ChainRow[]): ChainResponse {
  return {
    underlying: SYMBOL,
    expiry: EXPIRY,
    spot: 408.35,
    spotAsOf: NOW,
    future: FUTURE,
    futureAsOf: NOW,
    step: 5,
    lotSize: LOT,
    rows,
    feedAlive: true,
  }
}

function optionLeg(over: Partial<PayoffLeg> = {}): PayoffLeg {
  return {
    id: 'BHEL26AUG420CE',
    instrument: 'option',
    qty: -LOT,
    strike: 420,
    type: 'CE',
    expiry: EXPIRY,
    entry: 10,
    iv: 0.28,
    ...over,
  }
}

const wireBook = (chain: ChainResponse | null) => ({ symbol: SYMBOL, expiry: EXPIRY, chain })

test('a strike the chain does not list is NAMED, and still posted', async () => {
  // Reachable from a real book: a rolled-in leg, or a strike the exchange has
  // since delisted. It is a warning and not a refusal because desk-marketdata's
  // master is the authority — a stale master HERE must not veto a contract that
  // really exists, and if it does not exist that side refuses the whole basket.
  const m = master()
  const marks = new QuoteCache({ now: () => NOW })
  const chain = buildChain({ master: m, marks, now: () => NOW }, SYMBOL, EXPIRY)
  const listedRows = chain.rows.filter((r) => r.strike === 420)
  const out = toWireLegs(wireBook(chainOf([...listedRows, { strike: 500, CE: null, PE: null }])), [
    optionLeg(),
    optionLeg({ id: 'shift:500CE', strike: 500 }),
  ])
  assert.equal(out.postable, true, 'a warning, never a refusal')
  assert.deepEqual(out.legs.map((l) => l.strike), [420, 500], 'both still cross the wire')
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0] ?? '', /500CE is not listed on the 2026-08-25 chain/)
})

test('with no chain at all nothing is claimed about what is listed', async () => {
  // The bug this pins: an empty `listed` set made every leg of a book the desk
  // is HOLDING look unlisted — a page of confident nonsense.
  const out = toWireLegs(wireBook(null), [optionLeg()])
  assert.deepEqual(out.warnings, [])
  assert.equal(out.postable, true)
  assert.equal(out.legs.length, 1)
})

test('a leg this wire cannot carry leaves the whole basket UNASKED', async () => {
  // A futures leg has no strike or type. Posting the rest would price a book
  // without its largest margin line and report the difference as a cheaper plan;
  // `moves.ts` refuses a half-applied shift for the same reason.
  const out = toWireLegs(wireBook(chainOf([])), [
    optionLeg(),
    { id: 'BHEL26AUGFUT', instrument: 'future', qty: LOT, strike: null, type: null, expiry: EXPIRY, entry: FUTURE, iv: null },
  ])
  assert.equal(out.postable, false)
  assert.match(out.warnings.join(' '), /BHEL26AUGFUT.*options only/)
})

test('a zero-qty leg is dropped — Kite rejects the whole basket for one', async () => {
  const out = toWireLegs(wireBook(chainOf([])), [optionLeg(), optionLeg({ id: 'closed', qty: 0 })])
  assert.deepEqual(out.legs.map((l) => l.strike), [420])
})

test('with no marketdata URL configured the estimate still answers', async () => {
  // The default is `http://127.0.0.1:8892`; an operator who has blanked it gets
  // the SPAN-lite figure and a sentence, never a fetch to the empty string.
  const h = await harness()
  const route = payoffRoutes(h.deps, {
    onSnapshot: (p) => void h.writes.push(p),
    margin: { url: '', token: MD_TOKEN },
  })
  const res = await call({ ...h, route }, 'POST', '/v1/desk/repair/verify-margin', {
    tag: TAG,
    mode: 'paper',
    moves: [],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body['broker'], null)
  assert.ok(Number(res.body['estimated']) > 0)
  assert.ok(warningsOf(res.body).length > 0)
})

// ---------------------------------------------------------- the closed market

/** 19:30 IST the same Wednesday — the session ended four hours ago. */
const CLOSED_NOW = Date.parse('2026-08-05T14:00:00.000Z')

test('CLOSED MARKET: the payoff prices off the last session and says so once, not eight times', async () => {
  // Seeded during the session, read after the close: every quote is hours old,
  // the contract feed is rightly dead, and before this path existed the panel
  // answered "no payoff could be built" over a wall of clock-noise warnings.
  let t = NOW
  const h = await harness({ now: () => t })
  t = CLOSED_NOW

  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal(res.status, 200)
  assert.equal(res.body['marketClosed'], true)
  assert.equal(res.body['future'], FUTURE, 'the last session future is the display mark')

  const view = res.body['view'] as Doc | null
  assert.ok(view !== null, `the view must be priced; warnings: ${JSON.stringify(warningsOf(res.body))}`)
  assert.equal(((view as Doc)['curve'] as unknown[]).length, 121)

  // The known-because-it-is-evening sentences are gone; the header label
  // (`marketClosed`) is where that honesty lives now.
  assert.ok(!said(res.body, /not ticking/), 'feed silence is known after the close')
  assert.ok(!said(res.body, /steering greeks below are STALE/), 'greeks age is known after the close')
  assert.ok(!said(res.body, /margin figure is .* minutes old/), 'margin age is known after the close')
  assert.ok(!said(res.body, /no future mark/), 'the future IS marked, from the last session')

  // The machine card still reads the last published steering pair.
  assert.ok(res.body['machine'] !== null)
})

test('CLOSED MARKET: the repair search still has a universe to search', async () => {
  let t = NOW
  const h = await harness({ now: () => t })
  t = CLOSED_NOW

  const res = await call(h, 'GET', `/v1/desk/repair?tag=${TAG}&mode=paper`)
  assert.equal(res.status, 200)
  const universe = res.body['universe'] as Doc
  assert.ok(Number(universe['evaluated']) > 0, 'last-session quotes are quotable for the menu')
  assert.ok(Number(universe['atomic']) > 0, 'the dials must not refuse every row as too old')
  const goals = res.body['goals'] as { plans: unknown[] }[]
  assert.ok(goals.some((g) => g.plans.length > 0), 'the menu is not empty at 7pm')
})

test('OPEN MARKET with a dead feed keeps every warning — the gate is the clock, not liveness', async () => {
  // A feed that dies at 11am is the dangerous case the cache guards against;
  // the closed-market path must not soothe it.
  let t = NOW
  const h = await harness({ now: () => t })
  t = NOW + 200_000 // 10:33 IST, and nothing has ticked for 200s

  const res = await call(h, 'GET', `/v1/desk/payoff?tag=${TAG}&mode=paper`)
  assert.equal(res.status, 200)
  assert.equal(res.body['marketClosed'], false)
  assert.ok(said(res.body, /not ticking/), 'mid-session feed death must still be said')
})
