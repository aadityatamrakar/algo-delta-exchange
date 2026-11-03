/**
 * The route-level test harness: a real TradersDb on a per-suite Mongo database,
 * the real gate and server on port 0, a fake clock, and a `call()` that speaks
 * HTTP. Route-level suites mount their routes through `startHarness`;
 * `startTraders` boots the whole app through `createApp`, as main does.
 */

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword } from '@algomaker/auth'
import { InProcessTransport } from '@algomaker/bus'
import type { MongoHandle } from '../../api/src/mongo.ts'
import type { PushSender } from '../src/alerts/push.ts'
import { createApp, type App, type AppOverride, type AssistantSetup } from '../src/app.ts'
import type { TradersConfig } from '../src/config.ts'
import type { TradersDeps } from '../src/deps.ts'
import type { TradersMaster } from '../src/market/master.ts'
import type { TradersQuotes } from '../src/market/quotes.ts'
import { createTradersGate } from '../src/auth/gate.ts'
import { SessionStore } from '../src/auth/sessions.ts'
import { WatcherTokens } from '../src/auth/tokens.ts'
import { TraderStore } from '../src/auth/users.ts'
import type { TradersDb } from '../src/db.ts'
import type { Log, Route } from '../src/routes/kit.ts'
import { createTradersServer } from '../src/server.ts'
import type { Role } from '../src/types.ts'
import { testMaster } from './fixtures/master.ts'
import { connectSuite, suiteUrl, wipe } from './mongo.ts'

export const HARNESS_ORIGIN = 'http://traders.test'
/** No such folder: an app started on it finds no NSE file. */
export const NO_NSE_DIR = join(tmpdir(), 'algomaker-traders-test-no-nse')

export interface HarnessDeps {
  db: TradersDb; users: TraderStore; sessions: SessionStore; tokens: WatcherTokens
  now: () => number; log: Log
}

export interface CallOpts {
  cookie?: string; bearer?: string; json?: unknown; raw?: Buffer | string
  contentType?: string; origin?: string; headers?: Record<string, string>
}

export interface Harness {
  readonly base: string
  readonly db: TradersDb
  readonly handle: MongoHandle
  readonly clock: { now: number }
  readonly users: TraderStore
  readonly sessions: SessionStore
  readonly tokens: WatcherTokens
  /** Password is `${name}-password`. */
  addUser(name: string, role?: Role): Promise<void>
  /** 'dx_traders_session=<value>' for a Cookie header. */
  login(name: string): Promise<string>
  watcherToken(name: string): Promise<string>
  call(method: string, path: string, o?: CallOpts): Promise<{ status: number; body: any; headers: Headers }>
  /** Wipes every traders collection (and `extra`), and resets the clock. */
  reset(extra?: readonly string[]): Promise<void>
  close(): Promise<void>
}

/** Null when no Mongo answers; the caller then goes through `skipUnlessMongo`. */
export async function startHarness(
  suite: string, routes: (d: HarnessDeps) => readonly Route[],
): Promise<Harness | null> {
  const s = await connectSuite(suite)
  if (s === null) return null
  await s.db.ensureIndexes()
  const clock = { now: Date.UTC(2026, 9, 19, 4, 0, 0) }
  const now = (): number => clock.now
  const users = new TraderStore(s.db)
  const sessions = new SessionStore(s.db)
  const tokens = new WatcherTokens(s.db)
  const deps: HarnessDeps = { db: s.db, users, sessions, tokens, now, log: () => {} }
  const server: Server = createTradersServer({
    gate: createTradersGate({ users, sessions, tokens, now }),
    routes: routes(deps),
    allowedOrigins: [HARNESS_ORIGIN],
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const hashes = new Map<string, string>()
  async function call(method: string, path: string, o: CallOpts = {}) {
    const headers: Record<string, string> = { ...(o.headers ?? {}) }
    if (o.cookie !== undefined) headers['cookie'] = o.cookie
    if (o.bearer !== undefined) headers['authorization'] = `Bearer ${o.bearer}`
    if (o.origin !== undefined) headers['origin'] = o.origin
    let body: string | Buffer | undefined
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json' }
    if (o.raw !== undefined) { body = o.raw; headers['content-type'] = o.contentType ?? 'application/octet-stream' }
    const r = await fetch(base + path, body === undefined ? { method, headers } : { method, headers, body })
    const text = await r.text()
    let parsed: unknown = null
    if (text !== '') { try { parsed = JSON.parse(text) } catch { parsed = text } }
    return { status: r.status, headers: r.headers, body: parsed as any }
  }

  const h: Harness = {
    base, db: s.db, handle: s.handle, clock, users, sessions, tokens,
    async addUser(name, role = 'trader') {
      const pw = `${name}-password`
      let hash = hashes.get(pw)
      if (hash === undefined) { hash = await hashPassword(pw); hashes.set(pw, hash) }
      await users.create(name, hash, role, clock.now)
    },
    async login(name) {
      const r = await call('POST', '/v1/traders/auth/login', { json: { username: name, password: `${name}-password` } })
      if (r.status !== 200) throw new Error(`harness login for ${name} answered ${r.status}`)
      return (r.headers.get('set-cookie') ?? '').split(';')[0] as string
    },
    async watcherToken(name) { return await tokens.issue(name, clock.now) },
    call,
    async reset(extra = []) {
      await wipe(s.handle, extra)
      clock.now = Date.UTC(2026, 9, 19, 4, 0, 0)
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()))
      await s.handle.close()
    },
  }
  return h
}

export interface TradersHarness {
  readonly url: string
  readonly db: TradersDb
  readonly handle: MongoHandle
  readonly app: App
  readonly bus: InProcessTransport
  readonly deps: TradersDeps
  readonly clock: { now: number }
  /** Password is `${name}-password`. */
  addUser(name: string, role?: Role): Promise<void>
  /** A watcher bearer token for the trader. */
  token(name: string): Promise<string>
  /** Logs in once, then sends the cookie (an admin adds `?as=` itself). */
  as(user: string): (path: string, init?: RequestInit) => Promise<Response>
  close(): Promise<void>
}

/**
 * The whole app on port 0 over a per-suite database, wiped on start. The master
 * is `testMaster()` unless given; no declaration is published; the bus is
 * in-process. Null when no Mongo answers.
 */
export async function startTraders(o: {
  suite: string; master?: TradersMaster; quotes?: TradersQuotes; now?: () => number
  deps?: AppOverride; origins?: readonly string[]
  /** The NSE folder the app's EodStore reads; default a folder that does not exist (every end-of-day file missing). */
  nseDir?: string
  /** The assistant; absent = off, as in production without TRADERS_AI_*. */
  assistant?: AssistantSetup
  /** The phone alerts' sender; default one that answers 201 and sends nothing (a test never makes a real push). */
  pushSender?: PushSender
}): Promise<TradersHarness | null> {
  const s = await connectSuite(o.suite)
  if (s === null) return null
  await wipe(s.handle, ['instrument', 'desk-marks', 'desk-subscriptions'])
  const clock = { now: Date.UTC(2026, 9, 19, 4, 0, 0) }
  const now = o.now ?? ((): number => clock.now)
  const bus = new InProcessTransport()
  const config: TradersConfig = {
    port: 0, mongoUrl: suiteUrl(o.suite), busUrl: '', origins: o.origins ?? [HARNESS_ORIGIN], sessionTtlMs: 8 * 3_600_000,
    maxTokens: 2000, nseDir: o.nseDir ?? NO_NSE_DIR,
  }
  const app = await createApp({
    db: s.db, bus, config, now, log: () => {}, master: o.master ?? testMaster(), declare: false,
    ...(o.quotes === undefined ? {} : { quotes: o.quotes }),
    ...(o.deps === undefined ? {} : { override: o.deps }),
    bandBoard: false,   // no minute loop writing band events under a suite: a test ticks h.app.board itself
    daily: false,   // nor a minute timer writing the daily record: a test ticks h.app.daily itself
    ...(o.assistant === undefined ? {} : { assistant: o.assistant }),
    alertRunner: false,   // nor raising alerts: a test ticks h.app.alerts itself
    push: { send: o.pushSender ?? (async () => 201) },
  })
  await app.start()
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  await app.deps.eod.refresh()   // joins the first read, which starts as the server listens: the folder is read before a test runs
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  const hashes = new Map<string, string>()
  const h: TradersHarness = {
    url, db: s.db, handle: s.handle, app, bus, deps: app.deps, clock,
    async addUser(name, role = 'trader') {
      const pw = `${name}-password`
      let hash = hashes.get(pw)
      if (hash === undefined) { hash = await hashPassword(pw); hashes.set(pw, hash) }
      await app.deps.users.create(name, hash, role, clock.now)
    },
    async token(name) { return await app.deps.tokens.issue(name, clock.now) },
    as(user) {
      let cookie: string | undefined
      return async (path, init = {}) => {
        if (cookie === undefined) {
          const r = await fetch(url + '/v1/traders/auth/login', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: user, password: `${user}-password` }),
          })
          if (r.status !== 200) throw new Error(`harness login for ${user} answered ${r.status}`)
          cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] as string
        }
        const headers = new Headers(init.headers)
        headers.set('cookie', cookie)
        return await fetch(url + path, { ...init, headers })
      }
    },
    async close() {
      await app.stop()
      await new Promise<void>((r) => app.server.close(() => r()))
      await s.handle.close()
    },
  }
  return h
}
