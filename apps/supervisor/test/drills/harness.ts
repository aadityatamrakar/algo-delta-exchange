/**
 * THE PROCESS DRILL RIG — a real mongod, a real bus server, a stub desk-api, and
 * `bin/desk-supervisor.mjs` spawned as its own operating-system process.
 *
 * Everything in `apps/supervisor/test/*.test.ts` proves a property of an OBJECT:
 * a stop flag checked twice, a compare-and-set that refuses a stale writer, a
 * boot that replays exactly one id. Those are the right shape for a rule, and
 * they are the wrong shape for the question this rig asks, which is the only one
 * an operator ever actually asks:
 *
 *   **If I kill this process right now, what does the desk do when it comes
 *   back?**
 *
 * That question has no answer inside one process. `kill -9` is not `stop()` — no
 * handler runs, no promise settles, no `finally` fires, and whatever was in
 * memory is simply gone. What survives is what reached the DATABASE, and what
 * the broker heard is what reached the WIRE. So this rig owns both ends: a real
 * `mongod` the child writes to, and a stub desk-api that records every POST and
 * decides — exactly as the real endpoint does — whether an id is a fresh claim or
 * a replay. The assertions are made against those two records, never against the
 * child's own report of itself.
 *
 * ── WHAT IS REAL AND WHY EACH ONE HAD TO BE ─────────────────────────────────
 *
 * | Piece | Real? | Because |
 * |---|---|---|
 * | the supervisor | the deployed `bin/` launcher, spawned | the launcher is where a `main()` that is never called hides (see its own header) |
 * | mongod | real | `kill -9` proves nothing against an in-memory fake: the fake dies WITH the process it was faking a database for |
 * | the bus | real `WsTransportServer` | the same class `apps/marketdata` binds; a fake emitter cannot prove the child dialled a socket and subscribed |
 * | desk-api | a stub | the drills are about the SUPERVISOR's exactly-once, and desk-api's own idempotency is proved in its own suite. The stub reproduces the one behaviour that matters here: the claim is written BEFORE the answer, so a replay is answered, not re-routed |
 * | the clock | shifted (`freeze-clock.mjs`) | the engine's first gate is the session gate; see that file |
 * | the instrument master | a synthetic dump in `instrument` | the same 21-strike ladder `main-lifecycle.test.ts` decides against, so a drill and a unit test disagree about nothing |
 *
 * ── THE SKIP ────────────────────────────────────────────────────────────────
 * No mongod, no drill — `skipUnlessMongo` (`../require-mongo.ts`), which turns
 * the skip into a FAILURE under `DESK_REQUIRE_MONGO=1`. A drill suite that
 * silently passes is worse than no drill suite, because "restart is safe" is
 * exactly the claim nobody re-checks.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createServer as createSocketServer, type AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { WsTransportServer } from '@algomaker/bus'
import { ENGINE_DECISIONS_PATH } from '@algomaker/desk-engine'
import type { DecisionRequest, DecisionResponse } from '@algomaker/desk-engine'
import { connectMongo, type MongoHandle } from '../../../api/src/mongo.ts'
import type { MdTick } from '../../src/chain-view.ts'
import { SUPERVISOR_STATE_COLLECTION } from '../../src/state-store.ts'

// ───────────────────────────────────────────────────────────── the market

/**
 * 2026-08-21 10:00 IST — a Friday inside the session, seven days from expiry.
 *
 * The same instant `main-lifecycle.test.ts` decides at, deliberately: a drill
 * that used a different market would be exercising a different decision, and the
 * one thing a process drill must not do is make the reader wonder whether the
 * difference is the process or the book.
 */
export const DRILL_NOW = Date.UTC(2026, 7, 21, 4, 30)

export const TAG = 'DRILL-2026-08-28-recenter-r'
export const SYMBOL = 'TCS'
export const EXPIRY = '2026-08-28'
export const LOT = 25
export const STEP = 10
export const SPOT = 300
const FUTURE_TOKEN = 900_001

/** 21 strikes, 200 → 400. `inferStrikeStep` reads a step of 10 off it. */
const LADDER = Array.from({ length: 21 }, (_, i) => 200 + i * STEP)

const tokenOf = (strike: number, optType: 'CE' | 'PE'): number =>
  strike * 10 + (optType === 'CE' ? 1 : 2)

export const symbolOf = (strike: number, optType: 'CE' | 'PE'): string =>
  `TCS26AUG${String(strike)}${optType}`

/** Intrinsic plus two rupees, so every strike implies a volatility. */
const theo = (strike: number, optType: 'CE' | 'PE'): number =>
  Math.max(0.5, (optType === 'CE' ? SPOT - strike : strike - SPOT) + 2)

/**
 * The exchange dump, as `loadStoredInstruments` reads it back.
 *
 * Field names are the DUMP's, not ours (`packages/instruments/src/master.ts`) —
 * this is the one place in the drills that has to speak Zerodha's spelling, and
 * getting it wrong presents as a book that will not start ("the instrument
 * master lists no chain") rather than as a bad fixture.
 */
export function instrumentDump(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const strike of LADDER) {
    for (const optType of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: tokenOf(strike, optType),
        tradingsymbol: symbolOf(strike, optType),
        name: SYMBOL,
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: LOT,
        instrument_type: optType,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  rows.push({
    instrument_token: FUTURE_TOKEN,
    tradingsymbol: 'TCS26AUGFUT',
    name: SYMBOL,
    expiry: EXPIRY,
    strike: 0,
    tick_size: 0.05,
    lot_size: LOT,
    instrument_type: 'FUT',
    segment: 'NFO-FUT',
    exchange: 'NFO',
  })
  return rows
}

/** One frame of the feed, in the CHILD's clock frame. See `Drill.frame`. */
export function frame(ts: number): MdTick[] {
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

/**
 * A deep-ITM short PE — netΔ far outside the band, so phase R sheds on the
 * first tick the child admits.
 */
export function shortBook(): Record<string, unknown> {
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

/**
 * The registry row the operator would have created from the preset.
 *
 * `confirm_ms: 0` so one frame is enough to route: the damping has its own
 * tests, and a drill that also had to wait out a confirmation window would be a
 * drill about the damping.
 */
export function registryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: TAG,
    symbol: SYMBOL,
    expiry: EXPIRY,
    mode: 'paper',
    variant: 'recenter-relief-r',
    dials: { confirm_ms: 0, cooldown_s: 0, margin_cap: 0, shift_enabled: false },
    desired: 'running',
    actual: 'stopped',
    ...over,
  }
}

// ────────────────────────────────────────────────────────────── the stub api

/** The bearer token both sides of the drill agree on. See `StubApi.unauthorised`. */
const API_TOKEN = 'drill-token'

/** What the stub answers a first post with. Default: DONE, no fills. */
export type Answer = (req: DecisionRequest) => Omit<DecisionResponse, 'decisionId' | 'replayed'>

const DONE: Answer = () => ({ status: 'DONE', fills: [], skips: [], routeErrors: [] })

/**
 * desk-api, reduced to the three things a supervisor asks of it — and to the one
 * behaviour the drills are actually about.
 *
 * **THE CLAIM IS WRITTEN BEFORE THE ANSWER.** That is not a convenience here, it
 * is the property under test: the real endpoint writes its claim before the
 * tranches go out (`decisions-client.ts` §2), which is precisely why a POST whose
 * response was lost may be fully live at the broker, and why the supervisor's
 * only safe move is to replay the SAME id rather than form a new package. A stub
 * that recorded the claim on the way out instead would answer a replay by routing
 * it a second time — and would report every drill green while doing the one thing
 * the whole exactly-once mechanism exists to prevent.
 *
 * `routed` is therefore the assertion surface: one entry per decisionId that was
 * ever CLAIMED. `posts` is every POST that arrived, replays included.
 */
export class StubApi {
  readonly posts: DecisionRequest[] = []
  readonly routed = new Map<string, { readonly request: DecisionRequest; readonly at: number }>()
  readonly actuals: { tag: string; actual: string }[] = []
  readonly cancels: string[] = []
  /** Paths the supervisor asked for that this stub does not serve. */
  readonly unhandled: string[] = []
  /**
   * Requests that arrived without the bearer token, by path.
   *
   * Checked because the real endpoint refuses one with a 401, and the host reads
   * that as a DEPLOYMENT FAULT that will refuse EVERY package for EVERY book
   * until somebody fixes it — silently, because each individual refusal looks
   * exactly like a book that had nothing to do (`decisions-client.ts:
   * refusalGuidance`). A stub that waved the token through would let a launcher
   * that stopped passing `DESK_API_TOKEN` pass every drill.
   */
  readonly unauthorised: string[] = []

  #answer: Answer = DONE
  #parked = false
  /** Responses held open by a parked post, so `close()` can let go of them. */
  readonly #held: ServerResponse[] = []
  #server: Server | null = null
  #port = 0

  get url(): string {
    return `http://127.0.0.1:${String(this.#port)}`
  }

  /** Every post of one id, replays included. */
  postsOf(decisionId: string): DecisionRequest[] {
    return this.posts.filter((p) => p.decisionId === decisionId)
  }

  /** What this stub answers a decision post with, from now on. */
  answer(fn: Answer): void {
    this.#answer = fn
  }

  /**
   * PARK every decision post: record it, claim it, and never answer.
   *
   * The barrier the kill-mid-decision drill needs. The supervisor has already
   * saved its package by the time the request arrives (`engine-host.ts:#route`
   * saves BEFORE it posts), so "the stub has seen a post" is a precise, race-free
   * statement that the state on disk holds a burnt seq and an in-flight id.
   */
  park(on: boolean): void {
    this.#parked = on
  }

  async listen(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const path = (req.url ?? '').split('?')[0] ?? ''

        if ((req.headers['authorization'] ?? '') !== `Bearer ${API_TOKEN}`) {
          this.unauthorised.push(path)
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorised"}')
          return
        }

        if (path === ENGINE_DECISIONS_PATH) {
          let parsed: DecisionRequest
          try {
            parsed = JSON.parse(body) as DecisionRequest
          } catch {
            res.writeHead(400).end('unreadable body')
            return
          }
          this.posts.push(parsed)
          const claimed = this.routed.has(parsed.decisionId)
          if (!claimed) this.routed.set(parsed.decisionId, { request: parsed, at: Date.now() })
          if (this.#parked) {
            // Held, not answered and not closed: a response that never comes is
            // what a process killed mid-flight actually saw.
            this.#held.push(res)
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              decisionId: parsed.decisionId,
              replayed: claimed,
              ...this.#answer(parsed),
            }),
          )
          return
        }

        const actual = /^\/v1\/desk\/books\/registry\/([^/]+)\/actual$/.exec(path)
        if (actual !== null) {
          let state = ''
          try {
            state = String((JSON.parse(body) as { actual?: unknown }).actual ?? '')
          } catch {
            state = ''
          }
          this.actuals.push({ tag: decodeURIComponent(actual[1] ?? ''), actual: state })
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
          return
        }

        const cancel = /^\/v1\/desk\/broker\/orders\/([^/]+)\/cancel$/.exec(path)
        if (cancel !== null) {
          this.cancels.push(decodeURIComponent(cancel[1] ?? ''))
          res.writeHead(202, { 'content-type': 'application/json' }).end('{}')
          return
        }

        // Recorded rather than merely 404'd: a supervisor asking for a path this
        // stub does not serve is a drill that is silently exercising a fallback.
        this.unhandled.push(path)
        res.writeHead(404).end('no such stub route')
      })
    })
    this.#server = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    this.#port = (server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    for (const res of this.#held) res.destroy()
    this.#held.length = 0
    const server = this.#server
    this.#server = null
    if (server === null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// ──────────────────────────────────────────────────────────── the child

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const LAUNCHER = `${ROOT}bin/desk-supervisor.mjs`
const CLOCK = fileURLToPath(new URL('./freeze-clock.mjs', import.meta.url))

/**
 * The child as `spawn` hands it back under this rig's stdio: no stdin, both
 * output streams piped. Named rather than asserted, so the two cannot drift.
 */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>

/** A port the OS says is free right now. See `Drill.spawn`. */
async function freePort(): Promise<number> {
  const probe = createSocketServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** One spawned `desk-supervisor`, and the two ways a drill ends it. */
export class SupervisorProcess {
  readonly #child: PipedChild
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  #output = ''

  constructor(child: PipedChild) {
    this.#child = child
    const absorb = (chunk: Buffer): void => {
      this.#output += chunk.toString('utf8')
    }
    child.stdout.on('data', absorb)
    child.stderr.on('data', absorb)
    this.#exit = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
    })
  }

  /** Everything the process has said. Quoted into a failure, never parsed. */
  get output(): string {
    return this.#output
  }

  /** Wait until the process has logged `text`. Throws if it exits first. */
  async waitForLog(text: string, timeoutMs = 30_000): Promise<void> {
    await this.#until(() => this.#output.includes(text), timeoutMs, `log line ${JSON.stringify(text)}`)
  }

  /** Wait for an arbitrary condition, quoting the child's output on failure. */
  async until(ready: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
    await this.#until(ready, timeoutMs, what)
  }

  async #until(ready: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let dead = false
    void this.#exit.then(() => {
      dead = true
    })
    while (!ready()) {
      if (Date.now() > deadline) {
        throw new Error(`drill timed out waiting for ${what}\n--- supervisor output ---\n${this.#output}`)
      }
      if (dead && !ready()) {
        throw new Error(
          `the supervisor EXITED while the drill waited for ${what}\n--- supervisor output ---\n${this.#output}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /**
   * `kill -9`. No handler runs, nothing is flushed, nothing is released — which
   * is the whole point: what the next process finds is what had already reached
   * the database.
   */
  async kill9(): Promise<void> {
    this.#child.kill('SIGKILL')
    await this.#exit
  }

  /** The signal every restart path actually sends. Returns the exit code. */
  async sigterm(timeoutMs = 20_000): Promise<number | null> {
    this.#child.kill('SIGTERM')
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), timeoutMs)
    timer.unref()
    const { code } = await this.#exit
    clearTimeout(timer)
    return code
  }

  /** Make sure this process is gone, whatever the drill did or did not do. */
  async dispose(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return
    this.#child.kill('SIGKILL')
    await this.#exit
  }
}

// ───────────────────────────────────────────────────────────────── the rig

export interface DrillOptions {
  /**
   * The mongo URL. Defaults to this suite's OWN database.
   *
   * Its own, not a shared one, and that is `require-mongo.ts`'s rule rather than
   * a preference: node:test runs these files in parallel processes and every one
   * of them wipes its collections between drills, so pointing two at one database
   * would have them deleting each other's fixtures.
   *
   * A parameter as well as a variable so a throwaway rehearsal harness can drive
   * this rig at a scratch database WITHOUT exporting an env var that would then
   * apply to whatever else the shell runs next — and `seed()` refuses a database
   * that is not obviously disposable either way.
   */
  readonly mongoUrl?: string
}

const DEFAULT_URL =
  process.env['DESK_TEST_MONGO_SUPERVISOR_DRILLS'] ??
  'mongodb://127.0.0.1:27017/algomaker_dx_supervisor_drills_test'

/**
 * Is this database one a drill may DELETE FROM?
 *
 * `seed()` empties `desk-books`, `desk-books-registry` and the supervisor's own
 * state, which on a developer's desk database is the desk. The URL comes from an
 * env var, and an env var left over from something else is exactly how that
 * happens — so the name has to say it is disposable, and a drill that cannot
 * tell refuses rather than guesses.
 */
function disposable(url: string): boolean {
  let name = ''
  try {
    name = new URL(url).pathname.replace(/^\//, '')
  } catch {
    return false
  }
  return /test|drill|scratch/i.test(name)
}

/**
 * Everything one drill needs, and the guarantee that none of it outlives the
 * drill: every spawned child is tracked and killed by `close()`, whether the
 * drill ended in an assertion or in an exception.
 */
export class Drill {
  readonly api = new StubApi()
  readonly bus: WsTransportServer
  /** The wall-clock instant this rig started; the child's shift is measured off it. */
  readonly #startedAt = Date.now()
  #busPort = 0
  #handle: MongoHandle | null = null
  readonly #children: SupervisorProcess[] = []
  readonly #url: string
  /**
   * `bus.ready()` AWAITED FROM THE CONSTRUCTOR, and it has to be.
   *
   * `WsTransportServer.ready()` waits on `once('listening')` and caches the port
   * only inside itself — so a caller that constructs the server, does something
   * slow, and only then asks, waits forever on an event that has already fired.
   * `apps/marketdata` never sees it because it awaits on the next line. Taking
   * the promise here, before the Mongo connect, is what makes the order of the
   * two irrelevant.
   */
  readonly #busReady: Promise<number>

  private constructor(url: string) {
    this.#url = url
    // Port 0: the OS picks, so parallel test files never collide on 8891.
    this.bus = new WsTransportServer({ port: 0 })
    this.#busReady = this.bus.ready()
  }

  /**
   * Stand the rig up, or answer `null` when there is no mongod.
   *
   * `null` rather than a throw, so the caller can `skipUnlessMongo` — which is a
   * skip on a laptop and a FAILURE in CI.
   */
  static async start(opts: DrillOptions = {}): Promise<Drill | null> {
    const url = opts.mongoUrl ?? DEFAULT_URL
    const drill = new Drill(url)
    drill.#busPort = await drill.#busReady
    try {
      drill.#handle = await connectMongo(url, { serverSelectionTimeoutMS: 2500 })
    } catch {
      await drill.bus.close()
      return null
    }
    await drill.api.listen()
    return drill
  }

  get db(): MongoHandle['db'] {
    if (this.#handle === null) throw new Error('the drill has no database')
    return this.#handle.db
  }

  /** The clock the CHILD is running on, for tick timestamps and lease TTLs. */
  now(): number {
    return Date.now() + this.offsetMs
  }

  get offsetMs(): number {
    return DRILL_NOW - this.#startedAt + this.#advanced
  }

  #advanced = 0

  /**
   * Move the drill's market clock forward — the rig's own and every child spawned
   * after it, which is the only way to be somewhere else in the session.
   *
   * THE ONE THING THIS EXISTS FOR IS THE LEASE. A `kill -9` releases nothing, so
   * the dead process's lease document sits in Mongo with up to `LEASE_TTL_MS`
   * (30 s) left on it, and the replacement correctly STANDS BY rather than
   * steering a book somebody else may still be steering. That is not a defect to
   * work around — it is the mechanism doing its job, and drill 4 pins it — but
   * waiting it out in wall-clock seconds would buy nothing except a slower suite.
   * So the restart happens where it really happens: THIRTY-ONE SECONDS LATER.
   *
   * It is a shift of the whole rig, not a skew between the rig and the child:
   * ticks published after it are stamped in the new frame too, so a book's quote
   * ages exactly as it would have.
   */
  advance(ms: number): void {
    this.#advanced += ms
  }

  /** The lease TTL a killed supervisor leaves behind (`main.ts:LEASE_TTL_MS`). */
  static readonly LEASE_TTL_MS = 30_000

  /**
   * Wipe every collection this rig touches and lay down the fixture.
   *
   * Wiped rather than dropped, and named one by one: a `dropDatabase` on a URL
   * somebody pointed at their dev desk would take the desk with it.
   */
  async seed(rows: { registry?: Record<string, unknown>[]; books?: Record<string, unknown>[] } = {}): Promise<void> {
    if (!disposable(this.#url)) {
      throw new Error(
        `refusing to seed ${this.#url}: a drill EMPTIES desk-books, desk-books-registry and the ` +
          "supervisor's state, and this database's name does not say it is disposable " +
          '(it must contain "test", "drill" or "scratch")',
      )
    }
    const db = this.db
    for (const name of [
      'instrument',
      'desk-books-registry',
      'desk-books',
      'desk-marks',
      'desk-subscriptions',
      'desk-book-margin',
      'desk-book-marks',
      'desk-gateway-orders',
      SUPERVISOR_STATE_COLLECTION,
      'desk-supervisor-lease',
    ]) {
      await (db.collection(name) as unknown as { deleteMany(f: unknown): Promise<unknown> }).deleteMany({})
    }
    const insert = async (name: string, docs: Record<string, unknown>[]): Promise<void> => {
      if (docs.length === 0) return
      await (db.collection(name) as unknown as { insertMany(d: unknown[]): Promise<unknown> }).insertMany(docs)
    }
    await insert('instrument', instrumentDump())
    await insert('desk-books-registry', rows.registry ?? [registryRow()])
    await insert('desk-books', rows.books ?? [shortBook()])
  }

  /** This book's supervisor state, exactly as the next process would load it. */
  async state(): Promise<Record<string, unknown> | null> {
    const doc = await (
      this.db.collection(SUPERVISOR_STATE_COLLECTION) as unknown as {
        findOne(f: unknown): Promise<Record<string, unknown> | null>
      }
    ).findOne({ key: `${TAG}:paper` })
    return doc
  }

  /**
   * Write a state DOCUMENT by hand — a book left holding something.
   *
   * A raw document rather than a `SupervisorBookState`, deliberately: what the
   * next process finds in Mongo is whatever was written there, and hydration is
   * the thing that has to cope with it (`state-store.ts` §2). Typing this as the
   * in-memory shape would make the drill unable to express the case it exists
   * for.
   */
  async putState(state: Record<string, unknown> & { key: string }): Promise<void> {
    await (
      this.db.collection(SUPERVISOR_STATE_COLLECTION) as unknown as {
        insertOne(d: unknown): Promise<unknown>
      }
    ).insertOne(state)
  }

  /** Hold the lease under somebody else's name, so the child is a STANDBY. */
  async holdLease(owner: string, ttlMs: number): Promise<void> {
    await (
      this.db.collection('desk-supervisor-lease') as unknown as {
        insertOne(d: unknown): Promise<unknown>
      }
    ).insertOne({
      key: 'desk-supervisor',
      owner,
      acquiredAt: this.now(),
      expiresAt: this.now() + ttlMs,
    })
  }

  /**
   * Spawn `bin/desk-supervisor.mjs` — the deployed launcher, unmodified, with
   * the drill's clock shifted into the session by `--import`.
   *
   * THE NUDGE PORT IS ALLOCATED, not defaulted. `main.ts` refuses a
   * `DESK_SUPERVISOR_PORT` that is not a positive integer and falls back to
   * 8893 — so a drill that left it unset would fail to boot on any machine with
   * a real supervisor running, and two drills that overlapped would collide with
   * each other. `listen()` throwing takes `main()` down before the lease.
   */
  async spawn(env: Record<string, string> = {}): Promise<SupervisorProcess> {
    const child = spawn(
      process.execPath,
      ['--import', CLOCK, LAUNCHER],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DESK_MONGO_URL: this.#url,
          DESK_API_TOKEN: API_TOKEN,
          DESK_API_URL: this.api.url,
          DESK_BUS_URL: `ws://127.0.0.1:${String(this.#busPort)}`,
          DESK_SUPERVISOR_PORT: String(await freePort()),
          DESK_DRILL_CLOCK_OFFSET_MS: String(this.offsetMs),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const proc = new SupervisorProcess(child)
    this.#children.push(proc)
    return proc
  }

  /** One frame of the feed, stamped in the child's clock frame. */
  publishFrame(): void {
    const ts = this.now()
    for (const tick of frame(ts)) this.bus.publish('md.tick', tick, ts)
  }

  /** Feed the child until `ready`, or give up loudly. */
  async feedUntil(ready: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`drill timed out feeding for ${what}`)
      this.publishFrame()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /** Wait until the child has dialled the bus; before that every tick is lost. */
  async awaitSubscriber(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.bus.clientCount === 0) {
      if (Date.now() > deadline) throw new Error('the supervisor never connected to the bus')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  async close(): Promise<void> {
    for (const child of this.#children) await child.dispose()
    await this.api.close()
    await this.bus.close()
    if (this.#handle !== null) await this.#handle.close()
    this.#handle = null
  }
}
