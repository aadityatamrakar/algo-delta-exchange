import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Principal, PrincipalKind } from '../src/types.ts'
import { ENDPOINTS } from '../src/routes/endpoints.ts'
import {
  BadRequest, Conflict, Forbidden, NotFound, RAW_BODY_MAX, istClock, istDate, isIsoDate,
  type Route, type TradersGate,
} from '../src/routes/kit.ts'
import { createTradersServer } from '../src/server.ts'

const ORIGIN = 'http://traders.test'
const gate: TradersGate = {
  async authenticate(req) {
    const m = /^Bearer (watcher|trader|admin):(.+)$/.exec(req.headers.authorization ?? '')
    return m ? ({ kind: m[1] as PrincipalKind, name: m[2] as string } satisfies Principal) : null
  },
}

let echoCalls = 0
const echo: Route = async (ctx) => {
  echoCalls++
  if (ctx.path.endsWith('/throw')) return false
  const out: Record<string, unknown> = { id: ctx.endpoint.id, principal: ctx.principal, params: ctx.params }
  if (ctx.endpoint.raw) out.bytes = (await ctx.readRaw()).length
  else if (ctx.method !== 'GET') await ctx.readJson()
  ctx.send(200, out)
  return true
}

const servers: Server[] = []
async function start(over: { routes?: Route[] } = {}) {
  const server = createTradersServer({ gate, routes: over.routes ?? [echo], allowedOrigins: [ORIGIN] })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function call(method: string, path: string, o: {
    bearer?: string; json?: unknown; raw?: string | Buffer; contentType?: string; origin?: string
  } = {}) {
    const headers: Record<string, string> = {}
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`
    if (o.origin) headers.origin = o.origin
    let body: string | Buffer | undefined
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json' }
    if (o.raw !== undefined) { body = o.raw; headers['content-type'] = o.contentType ?? 'application/octet-stream' }
    const r = await fetch(base + path, body === undefined ? { method, headers } : { method, headers, body })
    const text = await r.text()
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }
  }
  return { call }
}
after(() => { for (const s of servers) s.close() })

const { call } = await start()

test('the table: unique ids, /v1/traders prefix, exactly two raw endpoints', () => {
  assert.equal(new Set(ENDPOINTS.map((e) => e.id)).size, ENDPOINTS.length)
  assert.ok(ENDPOINTS.every((e) => e.pattern.startsWith('/v1/traders/')))
  assert.deepEqual(ENDPOINTS.filter((e) => e.raw).map((e) => e.id), ['watcher.files', 'admin.files.upload'])
})

test('preflight: allowed origin 204 with credentials, other origin 403', async () => {
  const ok = await call('OPTIONS', '/v1/traders/books', { origin: ORIGIN })
  assert.equal(ok.status, 204)
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN)
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true')
  assert.equal(ok.headers.get('access-control-max-age'), '600')
  const bad = await call('OPTIONS', '/v1/traders/books', { origin: 'http://evil.test' })
  assert.equal(bad.status, 403)
  assert.equal(bad.headers.get('access-control-allow-origin'), null)
})

test('a write from a foreign Origin is refused; no Origin is allowed', async () => {
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', json: {}, origin: 'http://evil.test' })).status, 403)
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', json: {} })).status, 200)
})

test('content types: JSON for writes, octet-stream only on the raw endpoints', async () => {
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', raw: 'x', contentType: 'text/plain' })).status, 415)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'watcher:a', raw: 'abc', contentType: 'application/octet-stream' })).body.bytes, 3)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'watcher:a', json: {} })).status, 415)
})

test('caps: JSON over 64 KiB and files over 20 MiB are 413', async () => {
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', json: { pad: 'x'.repeat(70_000) } })).status, 413)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'watcher:a', raw: Buffer.alloc(RAW_BODY_MAX + 1), contentType: 'application/octet-stream' })).status, 413)
})

test('an unlisted path is 404 and runs no route; a listed one with no handler is 500', async () => {
  const before = echoCalls
  assert.equal((await call('GET', '/v1/traders/nope', { bearer: 'trader:a' })).status, 404)
  assert.equal(echoCalls, before)
  const bare = await start({ routes: [] })
  const r = await bare.call('GET', '/v1/traders/books', { bearer: 'trader:a' })
  assert.equal(r.status, 500)
  assert.match(r.body.error, /books\.list has no handler/)
})

test('the endpoint kind decides who may call', async () => {
  assert.equal((await call('GET', '/v1/traders/books')).status, 401)
  assert.equal((await call('GET', '/v1/traders/books', { bearer: 'watcher:a' })).status, 403)
  assert.equal((await call('GET', '/v1/traders/admin/traders', { bearer: 'trader:a' })).status, 403)
  assert.equal((await call('PUT', '/v1/traders/files', { bearer: 'trader:a', raw: 'x', contentType: 'application/octet-stream' })).status, 403)
  assert.equal((await call('GET', '/v1/traders/books', { bearer: 'admin:root' })).status, 200)
  assert.equal((await call('GET', '/v1/traders/health')).body.principal, null)
})

test('path params are decoded; a malformed escape is 400', async () => {
  assert.equal((await call('PATCH', '/v1/traders/legs/manual%3Aabc', { bearer: 'trader:a', json: {} })).body.params.key, 'manual:abc')
  assert.equal((await call('GET', '/v1/traders/books/M%26M', { bearer: 'trader:a' })).body.params.stock, 'M&M')
  assert.equal((await call('GET', '/v1/traders/books/%E0%A4%A', { bearer: 'trader:a' })).status, 400)
})

test('errors map: BadRequest 400, NotFound 404, Forbidden 403, Conflict 409, other 500', async () => {
  const cases: Array<[Error, number, string]> = [
    [new BadRequest('bad'), 400, 'bad'], [new NotFound('gone'), 404, 'gone'],
    [new Forbidden('no'), 403, 'no'], [new Conflict('dup'), 409, 'dup'],
    [new Error('secret detail'), 500, 'internal error'],
  ]
  for (const [err, status, msg] of cases) {
    const s = await start({ routes: [async () => { throw err }] })
    const r = await s.call('GET', '/v1/traders/books', { bearer: 'trader:a' })
    assert.equal(r.status, status)
    assert.equal(r.body.error, msg)
  }
})

test('bad JSON is 400; empty body is {}', async () => {
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a', raw: '{nope', contentType: 'application/json' })).status, 400)
  assert.equal((await call('POST', '/v1/traders/heartbeat', { bearer: 'watcher:a' })).status, 200)
})

test('kit helpers: IST date and clock, ISO date check', () => {
  const ms = Date.parse('2026-10-19T20:00:00Z') // 01:30 IST next day
  assert.equal(istDate(ms), '2026-10-20')
  assert.equal(istClock(ms), '01:30')
  assert.ok(isIsoDate('2026-02-28'))
  assert.ok(!isIsoDate('2026-02-30'))
  assert.ok(!isIsoDate(20260228))
})
