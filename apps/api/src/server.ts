/**
 * HTTP surface for the desk bridge — CORS, authentication, dispatch.
 *
 * `node:http` rather than Express. The endpoint count is small and fixed, the
 * clients are our own pm2 processes and one browser, and the legacy app already
 * carries an Express/LoopBack stack we are trying to stop depending on. No
 * router, no middleware chain, nothing to keep in sync with a framework's major
 * versions.
 *
 * THIS FILE OWNS NO ENDPOINTS. Every route lives in a module under `routes/`
 * and is wired in `main.ts`. That is what keeps the security-relevant part —
 * "is this caller allowed in at all?" — in one short readable place instead of
 * being re-decided in each handler.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AuthGate } from './authgate.ts'
import { BadRequest, type Log, type Route, type RouteCtx } from './routes/kit.ts'
import { refuse } from './stream.ts'
import { UnknownStrategy } from './strategies.ts'

/**
 * The websocket half of this server, if the deployment has one.
 *
 * Declared as an interface rather than importing `DeskStream` so this file
 * still owns nothing but "is this caller allowed in at all?" — it authenticates
 * the upgrade and hands the socket over, and it knows nothing about what is
 * pushed down it.
 */
export interface StreamUpgrade {
  /** The one path that may be upgraded. Anything else is a 404. */
  readonly path: string
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, principalName: string): void
}

export interface ServerDeps {
  readonly gate: AuthGate
  /** Tried in order; the first to return true has handled the request. */
  readonly routes: readonly Route[]
  /** Endpoints served WITHOUT authentication. Health and login only. */
  readonly publicRoutes?: readonly Route[]
  /**
   * Browser origins allowed to call this API.
   *
   * The dashboard is served from a different port in dev (:5184 vs :8890), so
   * without CORS every request is blocked by the browser before it is even
   * sent. An explicit allowlist rather than `*`: this API can move money, and a
   * wildcard would let any page the operator has open drive it.
   */
  readonly allowedOrigins?: readonly string[]
  /**
   * The read-only push socket. Absent in tests that only exercise HTTP, and
   * absent means no path on this server can be upgraded at all.
   */
  readonly stream?: StreamUpgrade
  readonly log?: Log
}

const MAX_BODY_BYTES = 1_000_000

export function createBridgeServer(deps: ServerDeps): Server {
  const log = deps.log ?? ((): void => {})

  const server = createServer((req, res) => {
    void handle(req, res, deps, log).catch((err: unknown) => {
      log('unhandled error', { error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })

  if (deps.stream !== undefined) {
    const stream = deps.stream
    server.on('upgrade', (req, socket, head) => {
      void upgrade(req, socket as Duplex, head, stream, deps, log).catch((err: unknown) => {
        log('stream upgrade failed', { error: err instanceof Error ? err.message : String(err) })
        refuse(socket as Duplex, 500, 'internal error')
      })
    })
  }

  return server
}

/**
 * Authenticate a websocket upgrade — THROUGH THE SAME GATE AS EVERY OTHER ROUTE.
 *
 * A websocket handshake IS an HTTP request, so the browser attaches the httpOnly
 * `SameSite=Strict` session cookie exactly as it does to a fetch, and
 * `gate.authenticate` reads it exactly as it does there. That is the whole
 * reason there is no token in the query string: query strings land in nginx
 * access logs, and a session token in a log file is a session token in a backup.
 *
 * The Origin rule is the one `handle()` applies to writes, for the same reason
 * and with the same exception. Browsers do NOT apply CORS to websockets — a page
 * on any other site can open one — so `SameSite=Strict` is what actually keeps
 * the cookie away from it, and this check is the second, explicit gate rather
 * than a reliance on that alone. A request with NO Origin is allowed through:
 * that is our own pm2 processes and the tests, which are not browsers.
 */
async function upgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  stream: StreamUpgrade,
  deps: ServerDeps,
  log: Log,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== stream.path) {
    refuse(socket, 404, 'no websocket at this path')
    return
  }

  const origin = req.headers.origin
  if (typeof origin === 'string' && !(deps.allowedOrigins ?? []).includes(origin)) {
    refuse(socket, 403, 'origin not allowed')
    return
  }

  const principal = await deps.gate.authenticate(req)
  if (principal === null) {
    // 401 rather than a bare destroy: "you are not signed in" has to arrive as
    // itself, or the page cannot tell it from the bridge being down and will
    // reconnect forever against a gate that will never let it in.
    refuse(socket, 401, 'unauthorised')
    log('stream upgrade refused — no valid session')
    return
  }

  stream.accept(req, socket, head, principal.name)
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  log: Log,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  const origin = req.headers.origin
  const allowed = deps.allowedOrigins ?? []
  const originOk = typeof origin === 'string' && allowed.includes(origin)
  if (originOk) {
    res.setHeader('access-control-allow-origin', origin)
    /**
     * Credentials are allowed so the browser sends the httpOnly session cookie.
     *
     * This is exactly why `allowedOrigins` must stay an explicit list: a
     * wildcard origin is not merely unwise alongside credentials, the spec
     * forbids it and the browser refuses the response outright. The cookie is
     * `SameSite=Strict`, so a page on any other site cannot cause it to be sent
     * in the first place — that is what stands in for a CSRF token here.
     */
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('access-control-max-age', '600')
  }
  // Preflight is answered before auth: the browser sends it without the
  // Authorization header by design, so requiring auth here would 401 every
  // cross-origin request before the real one is ever attempted.
  if (method === 'OPTIONS') {
    res.writeHead(originOk ? 204 : 403)
    res.end()
    return
  }

  /**
   * CROSS-ORIGIN WRITES ARE REFUSED, and a write must be JSON.
   *
   * `SameSite=Strict` was doing this job alone, and it is not enough: SameSite
   * is computed on the SITE (the registrable domain), not the origin. A page on
   * any same-site origin — a sibling subdomain, or anything an on-path attacker
   * can serve over plaintext on the domain — could POST here with the
   * operator's cookie attached.
   *
   * And it needed no preflight to do it, because `readBody` parses whatever
   * arrives regardless of content type: a plain HTML form with
   * `enctype="text/plain"` can be shaped into valid JSON, which makes it a
   * "simple request" the browser sends without asking us first. The reachable
   * targets were the kill switch (engaging needs no password), `close-all`,
   * and the bulk strategy switch — a mass stop that also blocks exits.
   *
   * Two rules, both cheap: a state-changing method must carry an Origin we
   * allow, and must declare JSON. Requiring the content type is what removes
   * the form-POST shape entirely, since a form cannot send
   * `application/json` without a preflight.
   *
   * A request with NO Origin is allowed through: that is our own pm2 processes
   * and the Python desk, which are not browsers and send none. Browsers always
   * send one on a cross-origin write, which is the case being closed.
   */
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
  if (WRITE_METHODS.has(method)) {
    if (typeof origin === 'string' && !originOk) {
      send(res, 403, { error: 'cross-origin write refused' })
      return
    }
    const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
    if (ct !== undefined && ct !== '' && ct !== 'application/json') {
      send(res, 415, { error: 'request body must be application/json' })
      return
    }
  }

  // Body is read at most ONCE per request and memoised. Several handlers want to
  // look at it (validation, then a re-auth password), and an incoming stream can
  // only be consumed once — a second read would silently see an empty body.
  const holder: { body?: Promise<unknown> } = {}
  const readJson = (): Promise<unknown> => (holder.body ??= readBody(req))

  const makeCtx = (principal: RouteCtx['principal']): RouteCtx => ({
    req,
    res,
    url,
    path,
    method,
    principal,
    log,
    readJson,
    send: (status, body) => send(res, status, body),
  })

  try {
    // Liveness and login are unauthenticated on purpose: a health check that
    // needs a secret is one more thing to get wrong in a pm2 restart loop, and
    // login cannot require the thing it issues.
    const anon: RouteCtx['principal'] = { kind: 'user', name: 'anonymous' }
    for (const route of deps.publicRoutes ?? []) {
      if (await route(makeCtx(anon))) return
    }

    const principal = await deps.gate.authenticate(req)
    if (principal === null) {
      send(res, 401, { error: 'unauthorised' })
      return
    }

    const ctx = makeCtx(principal)
    for (const route of deps.routes) {
      if (await route(ctx)) return
    }

    send(res, 404, { error: `no route for ${method} ${path}` })
  } catch (err) {
    if (err instanceof BadRequest) {
      send(res, 400, { error: err.message })
      return
    }
    // 403, not 400: the request was well-formed, the caller is simply not a
    // strategy this desk knows. A status the client's own log will show, so a
    // typo'd tag is debuggable from there rather than from our journal.
    if (err instanceof UnknownStrategy) {
      send(res, 403, { error: err.message })
      return
    }
    throw err
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new BadRequest('request body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new BadRequest('body is not valid JSON')
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}
