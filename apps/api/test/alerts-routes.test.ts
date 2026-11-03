/**
 * `/v1/desk/alerts` — the dashboard's read of the shared `desk-alerts`
 * contract: unacked alerts, newest first, and an ack that stamps who and when.
 * A fake collection: no Mongo, no ports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { alertRoutes, ALERTS_COLLECTION } from '../src/routes/alerts.ts'
import type { ApiDeps, Principal, Route, RouteCtx } from '../src/routes/kit.ts'

type Doc = Record<string, unknown>
const NOW = 1_793_700_000_000
const OPERATOR: Principal = { kind: 'user', name: 'aaditya' }

function fakeDb(docs: Doc[]) {
  const queries: Doc[] = []
  const updates: { filter: Doc; update: Doc }[] = []
  const db = {
    collection(name: string): unknown {
      assert.equal(name, ALERTS_COLLECTION)
      return {
        find: (q: Doc) => {
          queries.push(q)
          let rows = docs.filter((d) => {
            if ((q['ackedAt'] as Doc | undefined)?.['$exists'] === false && d['ackedAt'] !== undefined) return false
            if (q['mode'] !== undefined && d['mode'] !== q['mode']) return false
            return true
          })
          const cursor = {
            sort: (s: Doc) => {
              if (s['at'] === -1) rows = [...rows].sort((a, b) => Number(b['at']) - Number(a['at']))
              return cursor
            },
            limit: (n: number) => {
              rows = rows.slice(0, n)
              return cursor
            },
            skip: () => cursor,
            toArray: async () => rows,
          }
          return cursor
        },
        updateOne: async (filter: Doc, update: Doc) => {
          updates.push({ filter, update })
          const d = docs.find((x) => x['_id'] === filter['_id'] && x['ackedAt'] === undefined)
          if (d === undefined) return { matchedCount: 0 }
          Object.assign(d, update['$set'] as Doc)
          return { matchedCount: 1 }
        },
      }
    },
  }
  return { db: db as unknown as ApiDeps['db'], queries, updates }
}

async function call(route: Route, method: string, target: string, principal: Principal = OPERATOR): Promise<{ status: number; body: Doc }> {
  const url = new URL(`http://desk${target}`)
  const sent: { status: number; body: Doc } = { status: 0, body: {} }
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method,
    principal,
    log: () => {},
    readJson: async () => ({}),
    send: (status, payload) => {
      sent.status = status
      sent.body = payload as Doc
    },
  }
  assert.equal(await route(ctx), true, `${method} ${target} was not handled`)
  return sent
}

const docs = (): Doc[] => [
  { _id: 'a1', at: NOW - 3000, severity: 'warn', source: 'dx-watchdog', mode: 'paper', key: 'k1', message: 'old warn' },
  { _id: 'a2', at: NOW - 1000, severity: 'critical', source: 'dx-gateway/backstop', mode: 'live', key: 'k2', message: 'no backstop', tag: 'T' },
  { _id: 'a3', at: NOW - 2000, severity: 'info', source: 'x', mode: 'live', key: 'k3', message: 'acked', ackedAt: NOW - 500 },
]

test('GET lists unacked alerts, newest first, with a string id', async () => {
  const f = fakeDb(docs())
  const route = alertRoutes({ db: f.db, now: () => NOW, toId: (s) => s })
  const r = await call(route, 'GET', '/v1/desk/alerts')
  assert.equal(r.status, 200)
  const alerts = r.body['alerts'] as Doc[]
  assert.deepEqual(alerts.map((a) => a['id']), ['a2', 'a1'])
  assert.equal(alerts[0]?.['severity'], 'critical')
  assert.equal(alerts[0]?.['tag'], 'T')
  assert.equal(alerts[0]?.['message'], 'no backstop')
})

test('GET ?mode= narrows to one rail; a bad mode is a 400', async () => {
  const f = fakeDb(docs())
  const route = alertRoutes({ db: f.db, now: () => NOW, toId: (s) => s })
  const r = await call(route, 'GET', '/v1/desk/alerts?mode=live')
  assert.deepEqual((r.body['alerts'] as Doc[]).map((a) => a['id']), ['a2'])
  assert.equal((await call(route, 'GET', '/v1/desk/alerts?mode=bogus')).status, 400)
})

test('POST /:id/ack stamps ackedAt and the AUTHENTICATED principal; then it is gone from the list', async () => {
  const f = fakeDb(docs())
  const route = alertRoutes({ db: f.db, now: () => NOW, toId: (s) => s })
  const r = await call(route, 'POST', '/v1/desk/alerts/a2/ack')
  assert.equal(r.status, 200)
  assert.deepEqual(f.updates[0]?.update, { $set: { ackedAt: NOW, ackedBy: 'aaditya' } })
  assert.deepEqual(f.updates[0]?.filter, { _id: 'a2', ackedAt: { $exists: false } })
  const after = await call(route, 'GET', '/v1/desk/alerts')
  assert.deepEqual((after.body['alerts'] as Doc[]).map((a) => a['id']), ['a1'])
})

test('ack of an unknown or already-acked alert is a 404; an unparseable id is a 400', async () => {
  const f = fakeDb(docs())
  const route = alertRoutes({ db: f.db, now: () => NOW, toId: (s) => s })
  assert.equal((await call(route, 'POST', '/v1/desk/alerts/a3/ack')).status, 404)
  assert.equal((await call(route, 'POST', '/v1/desk/alerts/nope/ack')).status, 404)
  const strict = alertRoutes({ db: f.db, now: () => NOW, toId: () => null })
  assert.equal((await call(strict, 'POST', '/v1/desk/alerts/zz/ack')).status, 400)
})

test('other paths are not this route', async () => {
  const route = alertRoutes({ db: fakeDb([]).db, now: () => NOW })
  const ctx = { path: '/v1/desk/other', method: 'GET' } as unknown as RouteCtx
  assert.equal(await route(ctx), false)
})
