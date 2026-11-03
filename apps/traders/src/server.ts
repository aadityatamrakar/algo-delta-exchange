/**
 * HTTP front door of the traders app (internet-facing): CORS, the write-origin
 * rule, content types, body caps, and the endpoint table.
 *
 * This file owns no endpoints. Every request is matched against ENDPOINTS
 * (unlisted = 404), the endpoint's `kind` decides who may call, and route
 * modules (wired in main.ts) only do the work.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ENDPOINTS, matchEndpoint, type Endpoint } from './routes/endpoints.ts'
import {
  BadRequest, Conflict, Forbidden, JSON_BODY_MAX, NotFound, PayloadTooLarge, RAW_BODY_MAX,
  type Log, type Route, type RouteCtx, type TradersGate,
} from './routes/kit.ts'

export interface TradersServerDeps {
  readonly gate: TradersGate
  /** Tried in order; the first to return true has handled the request. */
  readonly routes: readonly Route[]
  /** Browser origins allowed to call this API. An explicit list, never `*`: credentials are on. */
  readonly allowedOrigins: readonly string[]
  readonly endpoints?: readonly Endpoint[]
  readonly log?: Log
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function createTradersServer(d: TradersServerDeps): Server {
  const log = d.log ?? ((): void => {})
  return createServer((req, res) => {
    void handle(req, res, d, log).catch((err: unknown) => {
      log('unhandled error', { error: err instanceof Error ? err.message : String(err) })
      send(res, 500, { error: 'internal error' })
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, d: TradersServerDeps, log: Log): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  const origin = req.headers.origin
  const originOk = typeof origin === 'string' && d.allowedOrigins.includes(origin)
  if (originOk) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-credentials', 'true')
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('access-control-max-age', '600')
  }
  // Preflight is answered before auth: browsers send it without credentials.
  if (method === 'OPTIONS') {
    res.writeHead(originOk ? 204 : 403)
    res.end()
    return
  }

  // A write from a browser page on another origin is refused outright. No
  // Origin means a non-browser caller (the watcher, curl, tests).
  if (WRITE_METHODS.has(method) && typeof origin === 'string' && !originOk) {
    send(res, 403, { error: 'cross-origin write refused' })
    return
  }

  try {
    const matched = matchEndpoint(method, path, d.endpoints ?? ENDPOINTS)
    if (matched === null) {
      send(res, 404, { error: `no route for ${method} ${path}` })
      return
    }
    const { endpoint, params } = matched

    if (WRITE_METHODS.has(method)) {
      const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (endpoint.raw === true) {
        if (ct !== 'application/octet-stream') {
          send(res, 415, { error: 'request body must be application/octet-stream' })
          return
        }
      } else if (ct !== '' && ct !== 'application/json') {
        send(res, 415, { error: 'request body must be application/json' })
        return
      }
    }

    let principal: RouteCtx['principal'] = null
    if (endpoint.kind !== 'public') {
      principal = await d.gate.authenticate(req)
      if (principal === null) {
        send(res, 401, { error: 'unauthorised' })
        return
      }
      if (principal.kind === 'watcher' && endpoint.kind !== 'watcher') {
        send(res, 403, { error: 'a watcher token can only upload and heartbeat' })
        return
      }
      const allowed =
        endpoint.kind === 'watcher' ? principal.kind === 'watcher'
        : endpoint.kind === 'admin' ? principal.kind === 'admin'
        : principal.kind === 'trader' || principal.kind === 'admin'
      if (!allowed) {
        send(res, 403, { error: 'forbidden' })
        return
      }
    }

    // A body is read at most once per request and memoised.
    const holder: { raw?: Promise<Buffer> } = {}
    const readRaw = (max: number): Promise<Buffer> => (holder.raw ??= readBytes(req, max))
    const ctx: RouteCtx = {
      req, res, url, path, method, endpoint, params, principal, log,
      readJson: async () => {
        const text = (await readRaw(JSON_BODY_MAX)).toString('utf8')
        if (text.trim() === '') return {}
        try {
          return JSON.parse(text) as unknown
        } catch {
          throw new BadRequest('body is not valid JSON')
        }
      },
      readRaw: () => {
        if (endpoint.raw !== true) throw new Error(`readRaw on non-raw endpoint ${endpoint.id}`)
        return readRaw(RAW_BODY_MAX)
      },
      send: (status, body) => send(res, status, body),
    }

    for (const route of d.routes) {
      if (await route(ctx)) return
    }
    send(res, 500, { error: `endpoint ${endpoint.id} has no handler` })
  } catch (err) {
    if (err instanceof BadRequest) send(res, 400, { error: err.message })
    else if (err instanceof Forbidden) send(res, 403, { error: err.message })
    else if (err instanceof NotFound) send(res, 404, { error: err.message })
    else if (err instanceof Conflict) send(res, 409, { error: err.message })
    else if (err instanceof PayloadTooLarge) send(res, 413, { error: err.message }, true)
    else {
      log('route error', { error: err instanceof Error ? err.message : String(err), path })
      send(res, 500, { error: 'internal error' })
    }
  }
}

/** Reads the body, counting streamed bytes (not trusting content-length). */
async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) throw new PayloadTooLarge('request body too large')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > max) throw new PayloadTooLarge('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...(close ? { connection: 'close' } : {}),
  })
  res.end(text)
}
