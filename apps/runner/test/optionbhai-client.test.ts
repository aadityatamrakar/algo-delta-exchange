/**
 * `OptionbhaiClient` on the wire: the headers it sends, how long it waits
 * between attempts, and what it says when it is turned away.
 *
 * Against fake `fetch` / `openSocket` deps — NEVER the real optionbhai, and
 * never its origin IP. The two "real stack" tests at the bottom talk to a
 * server this file starts on 127.0.0.1 with an ephemeral port, to prove that
 * Node's fetch and `ws` actually put the `Host` header on the wire rather than
 * silently replacing it with the URL's host.
 *
 * Why each behaviour matters:
 *  - the origin is reached by IP, so without `Host: optionbhai.com` the
 *    request lands on the origin's default vhost, not optionbhai's;
 *  - between 8 and 10 September a fixed 5 s retry logged ~134,000 identical
 *    `login rejected with HTTP 403` lines against Cloudflare — the backoff
 *    and the 403 cool-off are what stop that from happening again;
 *  - the next block must be diagnosable from one log line (status, cf-ray,
 *    the start of the body), and that line must never carry a credential or
 *    the token.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { spawn } from 'node:child_process'
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { WebSocketServer } from 'ws'
import { makeLogger, type CapturedLog } from '@algomaker/strategy-kit'
import {
  nextRetryMs,
  OptionbhaiClient,
  wsSignalSocket,
  type SignalSocket,
  type SignalSocketHandlers,
  type SignalSocketOptions,
} from '../src/optionbhai.ts'
import { runnerUserAgent } from '../src/optionbhai-env.ts'

const TOKEN = 'a-bearer-token-that-must-never-be-logged'
const USER = 'LIVE001'
const PASS = 'not-a-real-password'
const ROWS = [{ tradingsymbol: 'NIFTY26AUG24000PE', instrument_token: 777, lot_size: 75, exchange: 'NFO' }]

interface Call {
  url: string
  method: string
  /** Lower-cased header names, as they would arrive at the server. */
  headers: Record<string, string>
}

type Reply = { status: number; body: string; headers?: Record<string, string> }

/** A fake fetch. `login` decides each login's answer; instruments always succeed. */
function fakeFetch(login: () => Reply = () => ({ status: 200, body: JSON.stringify({ token: TOKEN }) })): {
  fetch: typeof globalThis.fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v
    calls.push({ url, method: init?.method ?? 'GET', headers })
    const r: Reply = url.endsWith('/auth/login')
      ? login()
      : { status: 200, body: JSON.stringify({ data: ROWS }) }
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => h.get(name.toLowerCase()) ?? null },
      text: async () => r.body,
    }
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

class FakeSocket implements SignalSocket {
  handlers: SignalSocketHandlers | null
  readonly url: string
  readonly options: SignalSocketOptions | undefined
  constructor(url: string, handlers: SignalSocketHandlers, options: SignalSocketOptions | undefined) {
    this.url = url
    this.handlers = handlers
    this.options = options
  }
  /** The peer refusing or dropping the socket, as `ws` reports it: error, then close. */
  fail(error: string): void {
    const h = this.handlers
    h?.onError(new Error(error))
    h?.onClose()
  }
  open(): void {
    this.handlers?.onOpen()
  }
  emit(frame: unknown): void {
    this.handlers?.onMessage(JSON.stringify(frame))
  }
  detach(): void {
    this.handlers = null
  }
  close(): void {}
}

function client(
  opts: {
    login?: () => Reply
    hostHeader?: string
    userAgent?: string
    baseUrl?: string
    socketUrl?: string
    random?: () => number
    now?: () => number
  } = {},
): {
  c: OptionbhaiClient
  calls: Call[]
  sockets: FakeSocket[]
  logs: CapturedLog[]
} {
  const logs: CapturedLog[] = []
  const sockets: FakeSocket[] = []
  const http = fakeFetch(opts.login)
  const c = new OptionbhaiClient({
    tag: 'MIRROR_1PBUY:paper',
    credentials: { username: USER, password: PASS },
    log: makeLogger(logs),
    instrumentRefreshMinutes: 15,
    fetch: http.fetch,
    openSocket: (url, handlers, options) => {
      const s = new FakeSocket(url, handlers, options)
      sockets.push(s)
      return s
    },
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.socketUrl === undefined ? {} : { socketUrl: opts.socketUrl }),
    ...(opts.hostHeader === undefined ? {} : { hostHeader: opts.hostHeader }),
    ...(opts.userAgent === undefined ? {} : { userAgent: opts.userAgent }),
    ...(opts.random === undefined ? {} : { random: opts.random }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  return { c, calls: http.calls, sockets, logs }
}

function lower(h: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v
  return out
}

// ------------------------------------------------------------------ headers

test('origin by IP: login, instruments and the socket all carry Host: optionbhai.com', async () => {
  const { c, calls, sockets, logs } = client({
    baseUrl: 'http://13.202.244.113',
    socketUrl: 'ws://13.202.244.113',
    hostHeader: 'optionbhai.com',
    userAgent: 'algomaker-desk-runner/9.9.9',
  })
  await c.start()
  c.stop()

  assert.deepEqual(
    calls.map((x) => `${x.method} ${x.url}`),
    ['POST http://13.202.244.113/auth/login', 'GET http://13.202.244.113/api/instruments'],
  )
  for (const call of calls) {
    assert.equal(call.headers['host'], 'optionbhai.com', call.url)
    assert.equal(call.headers['user-agent'], 'algomaker-desk-runner/9.9.9', call.url)
  }
  assert.equal(calls[0]?.headers['content-type'], 'application/json')
  assert.equal(calls[1]?.headers['authorization'], `Bearer ${TOKEN}`)

  const socket = sockets[0]
  assert.ok(socket !== undefined)
  assert.equal(socket.url, `ws://13.202.244.113/ws?token=${TOKEN}`)
  assert.deepEqual(lower(socket.options?.headers), {
    host: 'optionbhai.com',
    'user-agent': 'algomaker-desk-runner/9.9.9',
  })

  const text = JSON.stringify(logs)
  assert.equal(text.includes(TOKEN), false, 'the token is never logged')
  assert.equal(text.includes('/ws?token='), false, 'nor the socket URL that carries it')
  assert.equal(text.includes(PASS), false)
})

test('no Host override: no Host header is set, the User-Agent still is', async () => {
  const { c, calls, sockets } = client()
  await c.start()
  c.stop()
  assert.equal(calls[0]?.url, 'https://optionbhai.com/auth/login')
  for (const call of calls) {
    assert.equal('host' in call.headers, false)
    assert.equal(call.headers['user-agent'], runnerUserAgent())
  }
  assert.equal(sockets[0]?.url.startsWith('wss://optionbhai.com/ws?token='), true)
  assert.deepEqual(lower(sockets[0]?.options?.headers), { 'user-agent': runnerUserAgent() })
})

// --------------------------------------------------------- the real stacks

/**
 * WHY `host-fetch.ts` EXISTS, on record: Node's own fetch (undici) does not
 * send a caller's `Host`; it sends the URL's. If this ever starts failing,
 * Node has changed and the plain-fetch path could carry the override itself.
 */
test("real stack: Node's global fetch REPLACES a caller's Host header with the URL's host", async (t) => {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    res.end('ok')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const { port } = server.address() as AddressInfo
  await (await globalThis.fetch(`http://127.0.0.1:${port}/`, { headers: { Host: 'optionbhai.com' } })).text()
  assert.equal(seen[0]?.host, `127.0.0.1:${port}`)
})

test('real stack: with a Host override the client goes through hostFetch, and Host reaches the wire', async (t) => {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(403, { 'content-type': 'text/plain', 'cf-ray': 'local-test' })
    res.end('blocked')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const { port } = server.address() as AddressInfo
  const logs: CapturedLog[] = []
  const c = new OptionbhaiClient({
    tag: 'T:paper',
    credentials: { username: USER, password: PASS },
    log: makeLogger(logs),
    instrumentRefreshMinutes: 15,
    baseUrl: `http://127.0.0.1:${port}`,
    hostHeader: 'optionbhai.com',
    userAgent: 'algomaker-desk-runner/test',
  })
  await c.start()
  c.stop()
  assert.equal(seen[0]?.host, 'optionbhai.com')
  assert.equal(seen[0]?.['user-agent'], 'algomaker-desk-runner/test')
  // And the rejection is diagnosable through this path too.
  const diag = logs.find((l) => l.msg.endsWith('optionbhai login rejected'))?.ctx
  assert.equal(diag?.['status'], 403)
  assert.equal(diag?.['cfRay'], 'local-test')
  assert.equal(diag?.['bodyHead'], 'blocked')
})

test('real stack: the ws handshake carries the overriding Host header', async (t) => {
  const seen: IncomingHttpHeaders[] = []
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  t.after(() => wss.close())
  wss.on('connection', (_ws, req) => seen.push(req.headers))
  const { port } = wss.address() as AddressInfo
  const opened = new Promise<void>((resolve, reject) => {
    const s = wsSignalSocket(
      `ws://127.0.0.1:${port}/ws?token=x`,
      {
        onOpen: () => {
          s.detach()
          s.close()
          resolve()
        },
        onMessage: () => {},
        onError: (e) => reject(e as Error),
        onClose: () => {},
      },
      { headers: { Host: 'optionbhai.com', 'User-Agent': 'algomaker-desk-runner/test' } },
    )
  })
  await opened
  assert.equal(seen[0]?.host, 'optionbhai.com')
  assert.equal(seen[0]?.['user-agent'], 'algomaker-desk-runner/test')
})

// ------------------------------------------------------------------ backoff

test('nextRetryMs: 5 s doubling to a 5 min cap, without jitter at the midpoint', () => {
  const mid = (): number => 0.5
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 50].map((n) => nextRetryMs(n, null, mid)),
    [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000],
  )
})

test('nextRetryMs: the jitter is ±20 %, never more', () => {
  assert.equal(nextRetryMs(0, null, () => 0), 4_000)
  assert.equal(nextRetryMs(0, null, () => 1), 6_000)
  assert.equal(nextRetryMs(9, null, () => 0), 240_000)
  assert.equal(nextRetryMs(9, null, () => 1), 360_000)
  for (let i = 0; i <= 20; i++) {
    const r = i / 20
    const ms = nextRetryMs(3, 500, () => r)
    assert.ok(ms >= 32_000 && ms <= 48_000, `${r} -> ${ms}`)
  }
})

test('nextRetryMs: after a 403 (or a 429) the wait is at least 10 minutes, whatever the attempt', () => {
  for (const status of [403, 429]) {
    for (const attempt of [0, 1, 5, 40]) {
      for (let i = 0; i <= 20; i++) {
        const r = i / 20
        const ms = nextRetryMs(attempt, status, () => r)
        assert.ok(ms >= 600_000 && ms <= 720_000, `${status} #${attempt} r=${r} -> ${ms}`)
      }
    }
  }
  // Anything else backs off normally.
  assert.equal(nextRetryMs(0, 401, () => 0.5), 5_000)
  assert.equal(nextRetryMs(0, 503, () => 0.5), 5_000)
})

/** The `retryMs` each failed attempt announced, in order. */
function retries(logs: readonly CapturedLog[]): unknown[] {
  return logs.filter((l) => l.ctx !== undefined && 'retryMs' in l.ctx).map((l) => l.ctx?.['retryMs'])
}

test('the client backs off on repeated failures instead of hammering every 5 s', async () => {
  const { c, logs } = client({ login: () => ({ status: 502, body: 'bad gateway' }), random: () => 0.5 })
  // Each start() is one attempt; the timer it arms is superseded by the next.
  for (let i = 0; i < 8; i++) await c.start()
  c.stop()
  assert.deepEqual(retries(logs), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
})

test('a 403 login cools off for at least 10 minutes on every attempt of the burst', async () => {
  const { c, logs } = client({
    login: () => ({ status: 403, body: '<html>Attention Required! | Cloudflare</html>' }),
  })
  for (let i = 0; i < 6; i++) await c.start()
  c.stop()
  const waits = retries(logs) as number[]
  assert.equal(waits.length, 6)
  for (const ms of waits) assert.ok(ms >= 600_000, `waited only ${ms} ms after a 403`)
})

test('a socket refused with 403 at the handshake cools off the same way', async () => {
  const { c, sockets, logs } = client({ random: () => 0.5 })
  await c.start()
  sockets[0]?.fail('Unexpected server response: 403')
  c.stop()
  assert.deepEqual(retries(logs), [660_000])
})

test('a socket that stayed up for a minute ends the burst: the next drop waits 5 s again', async () => {
  let n = 0
  let now = 1_000_000
  const { c, sockets, logs } = client({
    random: () => 0.5,
    now: () => now,
    login: () =>
      ++n <= 2 ? { status: 500, body: 'oops' } : { status: 200, body: JSON.stringify({ token: TOKEN }) },
  })
  await c.start() // 500 -> 5 s
  await c.start() // 500 -> 10 s
  await c.start() // ok
  sockets[0]?.open()
  now += 60_000
  sockets[0]?.fail('read ECONNRESET') // a healthy session dropping
  c.stop()
  assert.deepEqual(retries(logs), [5_000, 10_000, 5_000])
})

test('a socket that delivered an ORDER_EXECUTION frame ends the burst, however briefly it was up', async () => {
  let n = 0
  const { c, sockets, logs } = client({
    random: () => 0.5,
    now: () => 0,
    login: () =>
      ++n <= 2 ? { status: 500, body: 'oops' } : { status: 200, body: JSON.stringify({ token: TOKEN }) },
  })
  await c.start()
  await c.start()
  await c.start()
  sockets[0]?.open()
  sockets[0]?.emit({ type: 'ORDER_EXECUTION', payload: { symbol: 'NIFTY26OCT25000CE', side: 'BUY', status: 'EXECUTED' } })
  sockets[0]?.fail('read ECONNRESET')
  c.stop()
  assert.deepEqual(retries(logs), [5_000, 10_000, 5_000])
})

test('a frame the mirror cannot act on does NOT end the burst: an error frame then a close keeps the waits growing', async () => {
  const { c, sockets, logs } = client({ random: () => 0.5, now: () => 0 })
  for (let i = 0; i < 4; i++) {
    await c.start()
    const s = sockets[i]
    assert.ok(s !== undefined, `attempt ${i} opened a socket`)
    s.open()
    s.emit({ type: 'ERROR', payload: { message: 'session replaced' } })
    s.emit({ type: 'HEARTBEAT' })
    s.fail('socket hang up')
  }
  c.stop()
  assert.deepEqual(retries(logs), [5_000, 10_000, 20_000, 40_000])
})

test('a peer that accepts the upgrade and closes at once is NOT a recovery: the waits keep growing', async () => {
  const { c, sockets, logs } = client({ random: () => 0.5, now: () => 0 })
  for (let i = 0; i < 6; i++) {
    await c.start()
    const s = sockets[i]
    assert.ok(s !== undefined, `attempt ${i} opened a socket`)
    s.open()
    s.fail('socket hang up')
  }
  c.stop()
  assert.deepEqual(retries(logs), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000])
})

test('a successful login clears a stale 403: the next network error backs off normally', async () => {
  const answers: Reply[] = [
    { status: 403, body: 'blocked' },
    { status: 200, body: JSON.stringify({ token: TOKEN }) },
  ]
  const { c, sockets, logs } = client({
    random: () => 0.5,
    now: () => 0,
    login: () => answers.shift() ?? { status: 200, body: JSON.stringify({ token: TOKEN }) },
  })
  await c.start() // 403 -> 660 s, failures 1
  await c.start() // login ok; the socket never opens
  sockets[0]?.fail('connect ECONNREFUSED')
  c.stop()
  // 10 s (second failure of the burst), not a 403 cool-off for a refused connect.
  assert.deepEqual(retries(logs), [660_000, 10_000])
})

test('stop() during an in-flight login opens nothing when the login lands', async () => {
  let release: (() => void) | null = null
  const fetch = (async (url: string) => {
    if (url.endsWith('/auth/login')) await new Promise<void>((r) => (release = r))
    const body = url.endsWith('/auth/login') ? JSON.stringify({ token: TOKEN }) : JSON.stringify({ data: ROWS })
    return { ok: true, status: 200, headers: new Headers(), text: async () => body }
  }) as unknown as typeof globalThis.fetch
  let opened = 0
  const c = new OptionbhaiClient({
    tag: 'T:paper',
    credentials: { username: USER, password: PASS },
    log: makeLogger([]),
    instrumentRefreshMinutes: 15,
    fetch,
    openSocket: () => {
      opened++
      return { detach: () => {}, close: () => {} }
    },
  })
  const starting = c.start()
  await new Promise((r) => setTimeout(r, 0))
  c.stop()
  ;(release as (() => void) | null)?.()
  await starting
  assert.equal(opened, 0, 'a stopped client must not open an upstream session')
  assert.equal(c.status().connected, false)
})

test('stop() during an in-flight instruments fetch opens nothing either', async () => {
  let release: (() => void) | null = null
  const fetch = (async (url: string) => {
    if (url.endsWith('/api/instruments')) await new Promise<void>((r) => (release = r))
    const body = url.endsWith('/auth/login') ? JSON.stringify({ token: TOKEN }) : JSON.stringify({ data: ROWS })
    return { ok: true, status: 200, headers: new Headers(), text: async () => body }
  }) as unknown as typeof globalThis.fetch
  let opened = 0
  const c = new OptionbhaiClient({
    tag: 'T:paper',
    credentials: { username: USER, password: PASS },
    log: makeLogger([]),
    instrumentRefreshMinutes: 15,
    fetch,
    openSocket: () => {
      opened++
      return { detach: () => {}, close: () => {} }
    },
  })
  const starting = c.start()
  await new Promise((r) => setTimeout(r, 0))
  c.stop()
  ;(release as (() => void) | null)?.()
  await starting
  assert.equal(opened, 0)
})

// -------------------------------------------------------------- diagnostics

test('a rejected login is diagnosed ONCE per burst: status, cf-ray, the start of the body', async () => {
  const body = `<!DOCTYPE html><title>Attention Required! | Cloudflare</title>${'x'.repeat(400)}`
  const answers: Reply[] = [
    { status: 403, body, headers: { 'CF-RAY': '8c1f2e3d4a5b6c7d-BOM' } },
    { status: 403, body, headers: { 'CF-RAY': '8c1f2e3d4a5b6c7d-BOM' } },
    { status: 403, body, headers: { 'CF-RAY': '8c1f2e3d4a5b6c7d-BOM' } },
    { status: 200, body: JSON.stringify({ token: TOKEN }) },
    { status: 403, body: 'blocked again' },
  ]
  const { c, logs, sockets } = client({
    random: () => 0.5,
    login: () => answers.shift() ?? { status: 403, body: 'blocked again' },
  })
  for (let i = 0; i < 3; i++) await c.start()

  const diag = (): CapturedLog[] => logs.filter((l) => l.msg.endsWith('optionbhai login rejected'))
  assert.equal(diag().length, 1, 'one diagnostic line for three identical rejections')
  assert.deepEqual(diag()[0]?.ctx, {
    status: 403,
    cfRay: '8c1f2e3d4a5b6c7d-BOM',
    bodyHead: body.slice(0, 200),
    retryMs: 660_000,
    attempt: 1,
  })
  assert.equal(logs.filter((l) => l.msg.endsWith('optionbhai login failed, retrying')).length, 2)
  // The runtime row carries the status and nothing else.
  assert.equal(c.status().lastError, 'login rejected with HTTP 403')

  // Recovery ends the burst; the next block is a new burst and is diagnosed again.
  await c.start()
  sockets[0]?.open()
  sockets[0]?.emit({ type: 'ORDER_EXECUTION', payload: { symbol: 'NIFTY26OCT25000CE', side: 'BUY', status: 'EXECUTED' } })
  sockets[0]?.fail('read ECONNRESET')
  await c.start()
  c.stop()
  assert.equal(diag().length, 2)
  assert.equal(diag()[1]?.ctx?.['bodyHead'], 'blocked again')
  assert.equal(diag()[1]?.ctx?.['cfRay'], null)
})

test('a change of status inside a burst is diagnosed again', async () => {
  const answers: Reply[] = [
    { status: 500, body: 'upstream down' },
    { status: 500, body: 'upstream down' },
    { status: 403, body: 'blocked' },
  ]
  const { c, logs } = client({ login: () => answers.shift() ?? { status: 403, body: 'blocked' } })
  for (let i = 0; i < 4; i++) await c.start()
  c.stop()
  const diag = logs.filter((l) => l.msg.endsWith('optionbhai login rejected')).map((l) => l.ctx?.['status'])
  assert.deepEqual(diag, [500, 403])
})

test('the diagnostic body never carries the credentials, even when the server echoes them', async () => {
  const echoed = JSON.stringify({
    error: 'bad login',
    username: USER,
    password: PASS,
    raw: encodeURIComponent(PASS),
  })
  const { c, logs } = client({ login: () => ({ status: 401, body: echoed }) })
  await c.start()
  c.stop()
  const text = JSON.stringify(logs)
  assert.equal(text.includes(PASS), false)
  assert.equal(text.includes(USER), false)
  const head = logs.find((l) => l.msg.endsWith('optionbhai login rejected'))?.ctx?.['bodyHead']
  assert.equal(typeof head, 'string')
  assert.match(String(head), /bad login/)
  assert.match(String(head), /\[redacted\]/)
})

test('a rejected instruments request is diagnosed without the token', async () => {
  const logs: CapturedLog[] = []
  const fetch = (async (url: string) => {
    if (url.endsWith('/auth/login')) {
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ token: TOKEN }) }
    }
    return {
      ok: false,
      status: 403,
      headers: new Headers({ 'cf-ray': 'abc-BOM' }),
      text: async () => `forbidden for Bearer ${TOKEN}`,
    }
  }) as unknown as typeof globalThis.fetch
  const c = new OptionbhaiClient({
    tag: 'T:paper',
    credentials: { username: USER, password: PASS },
    log: makeLogger(logs),
    instrumentRefreshMinutes: 15,
    fetch,
    openSocket: () => ({ detach: () => {}, close: () => {} }),
    random: () => 0,
  })
  await c.start()
  c.stop()
  const diag = logs.find((l) => l.msg.endsWith('optionbhai instruments rejected'))
  assert.deepEqual(diag?.ctx, {
    status: 403,
    cfRay: 'abc-BOM',
    bodyHead: 'forbidden for Bearer [redacted]',
    retryMs: 600_000,
    attempt: 1,
  })
  assert.equal(JSON.stringify(logs).includes(TOKEN), false)
})

test('the retry line names the call that failed: login or instruments', async () => {
  const logs: CapturedLog[] = []
  let loginFails = true
  const fetch = (async (url: string) => {
    if (url.endsWith('/auth/login')) {
      if (loginFails) throw new TypeError('fetch failed')
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ token: TOKEN }) }
    }
    throw new TypeError('fetch failed')
  }) as unknown as typeof globalThis.fetch
  const c = new OptionbhaiClient({
    tag: 'T:paper',
    credentials: { username: USER, password: PASS },
    log: makeLogger(logs),
    instrumentRefreshMinutes: 15,
    fetch,
    openSocket: () => ({ detach: () => {}, close: () => {} }),
  })
  await c.start()
  loginFails = false
  await c.start()
  c.stop()
  assert.deepEqual(
    logs.filter((l) => l.level === 'error').map((l) => l.msg),
    ['T:paper: optionbhai login failed, retrying', 'T:paper: optionbhai instruments failed, retrying'],
  )
})

// ------------------------------------------------------- the handshake deadline

/** Open a real `wsSignalSocket` and resolve with how long until it reported error + close. */
function timeToFailure(url: string, handshakeTimeoutMs: number): Promise<{ ms: number; error: string }> {
  const started = Date.now()
  return new Promise((resolve) => {
    let error = ''
    wsSignalSocket(
      url,
      {
        onOpen: () => {},
        onMessage: () => {},
        onError: (e) => (error = e instanceof Error ? e.message : String(e)),
        onClose: () => resolve({ ms: Date.now() - started, error }),
      },
      { headers: {}, handshakeTimeoutMs },
    )
  })
}

test('real stack: a server that accepts TCP but never answers the upgrade is abandoned at the deadline', async (t) => {
  const sockets: Socket[] = []
  const server = createNetServer((s) => sockets.push(s))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    for (const s of sockets) s.destroy()
    server.close()
  })
  const { port } = server.address() as AddressInfo
  const { ms, error } = await timeToFailure(`ws://127.0.0.1:${port}/ws?token=x`, 500)
  assert.ok(ms >= 400 && ms < 2_000, `took ${ms} ms`)
  assert.notEqual(error, '')
})

test('real stack: a connect that never completes is abandoned at the deadline', async (t) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const s = require('node:net').createServer();
       s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
         process.stdout.write(String(s.address().port) + '\\n');
         process.kill(process.pid, 'SIGSTOP');
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const fillers: Socket[] = []
  t.after(() => {
    for (const f of fillers) f.destroy()
    child.kill('SIGKILL')
  })
  const port = await new Promise<number>((resolve) =>
    child.stdout?.once('data', (d: Buffer) => resolve(Number(String(d).trim()))),
  )
  for (let i = 0; i < 4; i++) {
    const f = connect(port, '127.0.0.1')
    f.on('error', () => {})
    fillers.push(f)
  }
  await new Promise((r) => setTimeout(r, 200))
  const { ms } = await timeToFailure(`ws://127.0.0.1:${port}/ws?token=x`, 1_000)
  assert.ok(ms >= 900 && ms < 2_500, `took ${ms} ms`)
})

test('real stack: detach + close while the handshake is in flight does not throw an unhandled error', async (t) => {
  const sockets: Socket[] = []
  const server = createNetServer((s) => sockets.push(s))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    for (const s of sockets) s.destroy()
    server.close()
  })
  const { port } = server.address() as AddressInfo
  const uncaught: unknown[] = []
  const onUncaught = (e: unknown): void => {
    uncaught.push(e)
  }
  process.on('uncaughtException', onUncaught)
  t.after(() => process.off('uncaughtException', onUncaught))
  const s = wsSignalSocket(
    `ws://127.0.0.1:${port}/ws?token=x`,
    { onOpen: () => {}, onMessage: () => {}, onError: () => {}, onClose: () => {} },
    { headers: {} },
  )
  await new Promise((r) => setTimeout(r, 50))
  s.detach()
  s.close()
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(uncaught, [])
})
