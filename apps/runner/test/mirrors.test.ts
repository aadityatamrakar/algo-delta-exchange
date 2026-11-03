/**
 * The optionbhai signal mirrors, end to end — against a fake HTTP layer and a
 * fake socket, NEVER the real optionbhai.
 *
 * Five behaviours are load-bearing and each has cost real money somewhere in
 * this system's history:
 *
 *  - a non-EXECUTED message must not place an order (the upstream sends
 *    PENDING and REJECTED down the same socket);
 *  - an unknown symbol is DROPPED, not guessed — legacy indexed the instrument
 *    map with no lookup check and passed `undefined` to the order call;
 *  - a reconnect must not double-submit, which is what a leaked socket or a
 *    per-socket subscription produces;
 *  - a mirror with no credentials must refuse to start and NAME the variables,
 *    rather than sit in a login loop that looks like a quiet market;
 *  - a mirror added to both rails submits under BOTH, with the mode on each
 *    order, because that is what makes the per-mode switch real.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import { MemoryStateStore, makeLogger, type CapturedLog } from '@algomaker/strategy-kit'
import { HOSTED_STRATEGIES } from '../../api/src/registry-seed.ts'
import { CATALOGUE } from '../src/catalogue.ts'
import { MIRRORS, MirrorHost } from '../src/mirrors.ts'
import {
  credentialEnvNames,
  credentialsFromEnv,
  MissingMirrorCredentials,
  OptionbhaiClient,
  toOrderExecution,
  type SignalSocket,
  type SignalSocketHandlers,
} from '../src/optionbhai.ts'
import { HttpOrderGateway, PositionLedger } from '../src/order-gateway.ts'
import type { HostedRow } from '../src/runner.ts'

// ------------------------------------------------------------------ fixtures

const NOW = Date.UTC(2026, 6, 24, 4, 0)
const TOKEN = 'a-bearer-token-that-must-never-be-logged'

const INSTRUMENT_ROWS = [
  {
    tradingsymbol: 'BANKNIFTY26AUG56000CE',
    instrument_token: 4242,
    lot_size: 35,
    exchange: 'NFO',
    tick_size: 0.05,
  },
  { tradingsymbol: 'NIFTY26AUG24000PE', instrument_token: 777, lot_size: 75, exchange: 'NFO' },
]

/** A fake `/auth/login` + `/api/instruments`. Records what was asked for. */
function fakeHttp(opts: { loginStatus?: number; rows?: unknown } = {}): {
  fetch: typeof globalThis.fetch
  calls: string[]
} {
  const calls: string[] = []
  const fetch = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/auth/login')) {
      const status = opts.loginStatus ?? 200
      return reply(status, JSON.stringify({ token: TOKEN }))
    }
    if (url.endsWith('/api/instruments')) {
      return reply(200, JSON.stringify({ data: opts.rows ?? INSTRUMENT_ROWS }))
    }
    throw new Error(`unexpected request: ${url}`)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

function reply(status: number, text: string): unknown {
  return { ok: status < 400, status, text: async () => text }
}

/** A scriptable socket. `emit` pushes a frame; `drop` is the peer going away. */
class FakeSocket implements SignalSocket {
  handlers: SignalSocketHandlers | null
  detached = false
  closed = false
  readonly url: string
  constructor(url: string, handlers: SignalSocketHandlers) {
    this.url = url
    this.handlers = handlers
  }
  detach(): void {
    this.detached = true
    // The real `removeAllListeners()`: after this the socket delivers nothing,
    // which is the property the reconnect test is actually about.
    this.handlers = null
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.handlers?.onOpen()
  }
  emit(frame: unknown): void {
    this.handlers?.onMessage(typeof frame === 'string' ? frame : JSON.stringify(frame))
  }
  drop(): void {
    const h = this.handlers
    this.handlers = null
    h?.onClose()
  }
}

function socketFactory(sockets: FakeSocket[]): (url: string, h: SignalSocketHandlers) => SignalSocket {
  return (url, handlers) => {
    const s = new FakeSocket(url, handlers)
    sockets.push(s)
    return s
  }
}

function execution(symbol: string, side: 'BUY' | 'SELL', status = 'EXECUTED'): unknown {
  return { type: 'ORDER_EXECUTION', payload: { symbol, side, status, strategy: 'whatever' } }
}

/** A registry row as `strategyFromDoc` produces one. */
function row(tag: string, modes: HostedRow['modes'], kind: HostedRow['kind'] = 'hosted'): HostedRow {
  return { tag, kind, modes, liveLots: 0, autostartAt: '0914' }
}

const ENV = {
  OPTIONBHAI_1PBUY_USER: 'LIVE001',
  OPTIONBHAI_1PBUY_PASS: 'not-a-real-password',
  OPTIONBHAI_A006_USER: 'LIVE002',
  OPTIONBHAI_A006_PASS: 'not-a-real-password',
  OPTIONBHAI_TEST3_USER: 'test3',
  OPTIONBHAI_TEST3_PASS: 'not-a-real-password',
} satisfies NodeJS.ProcessEnv

/**
 * A whole host, wired to fakes: fake HTTP, fake socket, real adapter, real
 * `HttpOrderGateway` (so the submitted BODY — including its mode — is what the
 * assertions read, not an intermediate double).
 */
function harness(
  opts: {
    /** A CALLBACK, so a test can change the registry between two syncs. */
    rows?: () => readonly HostedRow[]
    env?: NodeJS.ProcessEnv
    instrumentRows?: unknown
    /** The ledger net the host threads into each adapter. See `netLots` below. */
    netLots?: (tag: string, mode: string, symbol: string) => number
  } = {},
): {
  host: MirrorHost
  sockets: FakeSocket[]
  submits: { tag: string; mode: string; symbol: string; side: string; lots: number; underlying: unknown }[]
  /** The FULL submit body, for the fields `submits` deliberately does not carry. */
  bodies: Record<string, unknown>[]
  logs: CapturedLog[]
  http: { calls: string[] }
} {
  const sockets: FakeSocket[] = []
  const submits: {
    tag: string
    mode: string
    symbol: string
    side: string
    lots: number
    underlying: unknown
  }[] = []
  const logs: CapturedLog[] = []
  const log = makeLogger(logs)
  const clock = fixedClock(NOW)
  const http = fakeHttp(opts.instrumentRows === undefined ? {} : { rows: opts.instrumentRows })

  const bodies: Record<string, unknown>[] = []
  const submitFetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    const instrument = body['instrument'] as Record<string, unknown>
    bodies.push(body)
    submits.push({
      tag: String(body['tag']),
      mode: String(body['mode']),
      symbol: String(instrument['tradingsymbol']),
      side: String(body['side']),
      lots: Number(body['lots']),
      underlying: body['underlying'],
    })
    return reply(
      200,
      JSON.stringify({ accepted: true, status: 'DONE', clientOrderId: 'x', routedLots: body['lots'] }),
    )
  }) as unknown as typeof globalThis.fetch

  const host = new MirrorHost({
    clock,
    log,
    env: opts.env ?? ENV,
    loadRows: async () => opts.rows?.() ?? [row('MIRROR_1PBUY', { paper: { enabled: true } })],
    createSource: (config, credentials, mode) =>
      new OptionbhaiClient({
        tag: `${config.tag}:${mode}`,
        credentials,
        log,
        instrumentRefreshMinutes: config.instrumentRefreshMinutes,
        fetch: http.fetch,
        openSocket: socketFactory(sockets),
        // These tests assert that a reconnect was SCHEDULED and what it does,
        // never that it waited.
        retryMs: 0,
      }),
    createGateway: (tag, mode) =>
      new HttpOrderGateway({
        baseUrl: 'http://bridge:8890',
        token: 'tok',
        tag,
        mode,
        // Mirrors have no single underlying — the bridge derives it per symbol.
        underlying: null,
        clock,
        log,
        ledger: new PositionLedger(new MemoryStateStore()),
        state: new MemoryStateStore(),
        fetch: submitFetch,
        retryDelayMs: 0,
      }),
    ...(opts.netLots === undefined ? {} : { netLots: opts.netLots }),
  })
  return { host, sockets, submits, bodies, logs, http }
}

/** Let the adapter's async submit settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// ------------------------------------------------------------ the env mapping

test('credentialsRef names the two environment variables, and never holds a credential', () => {
  assert.deepEqual(credentialEnvNames('optionbhai/1pbuy'), {
    user: 'OPTIONBHAI_1PBUY_USER',
    pass: 'OPTIONBHAI_1PBUY_PASS',
  })
  assert.deepEqual(credentialEnvNames('optionbhai/test3'), {
    user: 'OPTIONBHAI_TEST3_USER',
    pass: 'OPTIONBHAI_TEST3_PASS',
  })
  // Every shipped config maps to a pair, and none of them IS the credential.
  for (const cfg of MIRRORS.values()) {
    const names = credentialEnvNames(cfg.credentialsRef)
    assert.match(names.user, /^[A-Z0-9_]+_USER$/)
    assert.match(names.pass, /^[A-Z0-9_]+_PASS$/)
  }
})

test('absent or blank credentials throw, naming BOTH variables', () => {
  const err = assertThrows(() => credentialsFromEnv('optionbhai/a006', {}))
  assert.ok(err instanceof MissingMirrorCredentials)
  assert.match(err.message, /OPTIONBHAI_A006_USER/)
  assert.match(err.message, /OPTIONBHAI_A006_PASS/)
  // A half-finished export is absent, not a credential: letting it through
  // would produce a login rejection every 5s instead of one clear refusal.
  assert.throws(() =>
    credentialsFromEnv('optionbhai/a006', { OPTIONBHAI_A006_USER: 'LIVE002', OPTIONBHAI_A006_PASS: '' }),
  )
})

// ---------------------------------------------------------- frame narrowing

test('only a well-formed ORDER_EXECUTION frame becomes a signal', () => {
  assert.notEqual(toOrderExecution(execution('X', 'BUY')), null)
  // A heartbeat, a status we do not know, and a garbage payload are all
  // dropped HERE rather than cast into the union and left for the adapter.
  assert.equal(toOrderExecution({ type: 'HEARTBEAT' }), null)
  assert.equal(toOrderExecution(execution('X', 'BUY', 'CANCELLED')), null)
  assert.equal(toOrderExecution({ type: 'ORDER_EXECUTION', payload: { symbol: 'X' } }), null)
  assert.equal(toOrderExecution('not an object'), null)
})

// ------------------------------------------------------------- the live path

test('an EXECUTED upstream order is mirrored onto /v1/desk/submit at 1 lot', async () => {
  const h = harness()
  await h.host.sync()
  const socket = h.sockets[0]
  assert.ok(socket !== undefined, 'a socket was opened')
  socket.open()
  socket.emit(execution('BANKNIFTY26AUG56000CE', 'BUY'))
  await settle()

  assert.equal(h.submits.length, 1)
  assert.deepEqual(h.submits[0], {
    tag: 'MIRROR_1PBUY',
    mode: 'paper',
    symbol: 'BANKNIFTY26AUG56000CE',
    side: 'Buy',
    // ONE LOT, matching legacy. `liveLots` is deliberately not consulted here.
    lots: 1,
    // Omitted: a mirror trades whatever the upstream did, so the bridge derives
    // the underlying from the symbol rather than being told a wrong one.
    underlying: undefined,
  })
  assert.equal(h.host.snapshots()[0]?.state, 'running')
})

test('a PENDING or REJECTED message places nothing', async () => {
  const h = harness()
  await h.host.sync()
  const socket = h.sockets[0]
  socket?.open()
  socket?.emit(execution('BANKNIFTY26AUG56000CE', 'BUY', 'PENDING'))
  socket?.emit(execution('BANKNIFTY26AUG56000CE', 'SELL', 'REJECTED'))
  socket?.emit({ type: 'POSITION_UPDATE', payload: { symbol: 'BANKNIFTY26AUG56000CE' } })
  await settle()
  assert.equal(h.submits.length, 0)
})

test('an unknown symbol is dropped with a warning — never guessed at', async () => {
  const h = harness()
  await h.host.sync()
  h.sockets[0]?.emit(execution('BANKNIFTY26AUG99999CE', 'BUY'))
  await settle()
  assert.equal(h.submits.length, 0, 'nothing may be placed against a symbol we cannot resolve')
  assert.ok(h.logs.some((l) => l.level === 'warn' && l.msg.includes('unknown symbol')))
})

test('a malformed frame is ignored rather than killing the socket', async () => {
  const h = harness()
  await h.host.sync()
  const socket = h.sockets[0]
  socket?.emit('{not json')
  socket?.emit(execution('NIFTY26AUG24000PE', 'SELL'))
  await settle()
  assert.equal(h.submits.length, 1, 'the good frame after the bad one still mirrored')
})

test('an instrument row without a lot size or an exchange is skipped, not defaulted', async () => {
  const h = harness({
    instrumentRows: [
      { tradingsymbol: 'GOOD', instrument_token: 1, lot_size: 50, exchange: 'NFO' },
      { tradingsymbol: 'NO_LOTS', instrument_token: 2, exchange: 'NFO' },
      { tradingsymbol: 'NO_EXCHANGE', instrument_token: 3, lot_size: 50 },
    ],
  })
  await h.host.sync()
  h.sockets[0]?.emit(execution('NO_LOTS', 'BUY'))
  h.sockets[0]?.emit(execution('NO_EXCHANGE', 'BUY'))
  h.sockets[0]?.emit(execution('GOOD', 'BUY'))
  await settle()
  // A fabricated lotSize: 1 is the C5 synthetic-instrument defect, and a
  // guessed exchange routes a SENSEX contract to the wrong one.
  assert.deepEqual(h.submits.map((s) => s.symbol), ['GOOD'])
  assert.ok(h.logs.some((l) => l.level === 'warn' && l.msg.includes('skipped')))
})

// ---------------------------------------------------------------- reconnect

test('a reconnect re-logs in and does NOT double-submit', async () => {
  const h = harness()
  await h.host.sync()
  const first = h.sockets[0]
  assert.ok(first !== undefined)
  first.open()
  first.emit(execution('BANKNIFTY26AUG56000CE', 'BUY'))
  await settle()
  assert.equal(h.submits.length, 1)

  // The peer goes away. The client re-logs in (retryMs 0) and opens a second
  // socket; the FIRST must have been detached and closed before it did.
  first.drop()
  await settle()
  const second = h.sockets[1]
  assert.ok(second !== undefined, 'a reconnect opened a new socket')
  assert.equal(first.detached, true, 'the superseded socket had its listeners removed')
  assert.equal(first.closed, true, 'the superseded socket was closed, not leaked')
  assert.equal(
    h.http.calls.filter((c) => c.includes('/auth/login')).length,
    2,
    'the reconnect is a FULL re-login, as the legacy file did',
  )

  second.open()
  second.emit(execution('BANKNIFTY26AUG56000CE', 'SELL'))
  await settle()
  // TWO in total, not three: the adapter subscribed to the CLIENT once and
  // stayed subscribed, and the old socket cannot deliver anything any more.
  assert.equal(h.submits.length, 2)
  assert.deepEqual(h.submits.map((s) => s.side), ['Buy', 'Sell'])

  // Belt and braces: even if the dead socket somehow still delivered, the
  // generation guard drops it.
  first.handlers = { onOpen: () => {}, onMessage: () => {}, onError: () => {}, onClose: () => {} }
  await settle()
  assert.equal(h.submits.length, 2)
})

test('the access token is never logged, and neither is the socket URL that carries it', async () => {
  const h = harness()
  await h.host.sync()
  h.sockets[0]?.open()
  // Legacy printed `console.log('Access token:', token)` on every connect,
  // putting a bearer credential into a rotated, shipped log file.
  const text = JSON.stringify(h.logs)
  assert.equal(text.includes(TOKEN), false)
  assert.equal(text.includes('not-a-real-password'), false)
})

// ------------------------------------------------------- credentials & modes

test('a mirror with no credentials does NOT start, and says so once naming both variables', async () => {
  const h = harness({ env: {} })
  await h.host.sync()
  await h.host.sync()

  assert.equal(h.sockets.length, 0, 'nothing may connect without credentials')
  const snap = h.host.snapshots()[0]
  assert.equal(snap?.state, 'failed')
  assert.match(snap?.lastError ?? '', /OPTIONBHAI_1PBUY_USER/)
  assert.match(snap?.lastError ?? '', /OPTIONBHAI_1PBUY_PASS/)
  const said = h.logs.filter((l) => l.level === 'error' && l.msg.includes('NOT started'))
  // ONCE. A 15-second sync loop must not turn this into a log line every 15s.
  assert.equal(said.length, 1)
  assert.match(said[0]?.msg ?? '', /OPTIONBHAI_1PBUY_USER and OPTIONBHAI_1PBUY_PASS/)
})

test('a mirror added to BOTH modes runs twice, and each order carries its own mode', async () => {
  const h = harness({
    rows: () => [row('MIRROR_A006', { paper: { enabled: true }, live: { enabled: true } })],
  })
  await h.host.sync()
  assert.equal(h.sockets.length, 2, 'two rails, two upstream sessions — never one shared socket')

  for (const s of h.sockets) {
    s.open()
    s.emit(execution('NIFTY26AUG24000PE', 'BUY'))
  }
  await settle()

  assert.equal(h.submits.length, 2)
  assert.deepEqual(
    h.submits.map((s) => `${s.tag}:${s.mode}`).sort(),
    ['MIRROR_A006:live', 'MIRROR_A006:paper'],
  )
  const modes = h.host.snapshots().map((s) => `${s.mode}:${s.state}`).sort()
  assert.deepEqual(modes, ['live:running', 'paper:running'])
})

test('a mode that is added but switched off does not run, and switching it off stops it', async () => {
  let modes: HostedRow['modes'] = { paper: { enabled: true }, live: { enabled: false } }
  const h = harness({ rows: () => [row('MIRROR_1PBUY', modes)] })
  await h.host.sync()
  assert.equal(h.sockets.length, 1, 'live is added but OFF — one instance only')

  modes = { paper: { enabled: false }, live: { enabled: false } }
  await h.host.sync()
  const socket = h.sockets[0]
  assert.equal(socket?.detached, true, 'switching the row off detaches the socket')
  assert.equal(socket?.closed, true)
  // And nothing arriving afterwards can still be mirrored.
  socket?.emit(execution('BANKNIFTY26AUG56000CE', 'BUY'))
  await settle()
  assert.equal(h.submits.length, 0)
})

test('a MIRROR tag registered as external is NOT hosted here', async () => {
  const h = harness({ rows: () => [row('MIRROR_1PBUY', { paper: { enabled: true } }, 'external')] })
  await h.host.sync()
  assert.equal(h.sockets.length, 0, 'external means another process owns it — hosting it would double-mirror')
  assert.ok(h.logs.some((l) => l.level === 'warn' && l.msg.includes("registered as 'external'")))
})

// ------------------------------------------------------- exits are exits (F-6b)

test('a mirrored order that reduces the ledger net goes out as an EXIT', async () => {
  // Without this the kill switch and the stale-feed block refuse the exit and
  // nothing ever retries it — the leg the upstream has already closed stays on
  // our books for good. The host is what threads the ledger net in; the adapter
  // has no position state of its own.
  const h = harness({ netLots: (tag, mode, symbol) =>
    tag === 'MIRROR_1PBUY' && mode === 'paper' && symbol === 'BANKNIFTY26AUG56000CE' ? -1 : 0,
  })
  await h.host.sync()
  const socket = h.sockets[0]
  socket?.open()
  socket?.emit(execution('BANKNIFTY26AUG56000CE', 'BUY'))
  await settle()

  assert.equal(h.bodies.length, 1)
  assert.equal(h.bodies[0]?.['reducesExposure'], true)
})

test('a mirrored order into a flat book is an ENTRY and is not marked as an exit', async () => {
  const h = harness({ netLots: () => 0 })
  await h.host.sync()
  const socket = h.sockets[0]
  socket?.open()
  socket?.emit(execution('BANKNIFTY26AUG56000CE', 'BUY'))
  await settle()

  assert.equal(h.bodies.length, 1)
  assert.equal(h.bodies[0]?.['reducesExposure'], undefined)
})

// --------------------------------------------------------------- the wiring

test('every MIRROR tag has a registry row and is deliberately absent from the catalogue', () => {
  const seeded = new Set(HOSTED_STRATEGIES.map((s) => s.tag))
  for (const tag of MIRRORS.keys()) {
    assert.ok(seeded.has(tag), `${tag} is hosted but has no registry row, so it could never be switched off`)
    assert.equal(CATALOGUE.has(tag), false, `${tag} is an adapter, not a StrategyBase`)
  }
  assert.deepEqual(
    [...MIRRORS.values()].map((c) => c.destinationTag).sort(),
    ['1PBUY', 'A006', 'A010', 'EMA2050'],
  )
})

// ------------------------------------------------------------------- helpers

function assertThrows(fn: () => unknown): Error {
  try {
    fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a throw')
}
