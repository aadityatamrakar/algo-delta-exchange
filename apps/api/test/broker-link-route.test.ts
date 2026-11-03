/**
 * `/v1/desk/broker-link` — the dashboard's "turn XTS off" switch.
 *
 * What is pinned: the SAME asymmetry as the kill switch. RELEASING (stop live
 * execution, log the gateway out) carries no password — it is the brake.
 * RECONNECTING makes real money placeable again and re-authenticates. The
 * principal on the audit line is the AUTHENTICATED one, never the body's, and
 * the answer is the whole document so the caller sees the gateway's last ack
 * beside the wish it just wrote.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { deskRoutes } from '../src/routes/desk.ts'
import type { ApiDeps, Principal, Route, RouteCtx } from '../src/routes/kit.ts'
import type { AuthGate } from '../src/authgate.ts'
import { AUDIT_COLLECTION } from '../src/audit.ts'
import { DEFAULT_BROKER_LINK, type BrokerLinkDesired, type BrokerLinkState } from '../src/safety.ts'

type Doc = Record<string, unknown>
const NOW = 1_756_700_000_000
const OPERATOR: Principal = { kind: 'user', name: 'aaditya' }

function fakeDb(): { db: ApiDeps['db']; inserted: Doc[] } {
  const inserted: Doc[] = []
  const byName: Record<string, Doc[]> = { [AUDIT_COLLECTION]: [] }
  const db = {
    collection(name: string): unknown {
      const own = (byName[name] ??= [])
      return {
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => own }) }) }),
        findOne: async () => null,
        insertOne: async (doc: Doc) => {
          inserted.push(doc)
          own.push(doc)
          return {}
        },
        createIndex: async () => {},
      }
    },
  }
  return { db: db as ApiDeps['db'], inserted }
}

function gate(password = 'correct-horse'): AuthGate {
  return {
    authenticate: async () => null,
    reauth: async (principal, given) => {
      if (principal.kind !== 'user') return 'a machine token cannot perform this'
      return given === password ? null : 'password is incorrect'
    },
  }
}

async function call(
  route: Route,
  method: string,
  target: string,
  body: unknown = null,
  principal: Principal = OPERATOR,
): Promise<{ status: number; body: Doc }> {
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
    readJson: async () => body,
    send: (status, payload) => {
      sent.status = status
      sent.body = payload as Doc
    },
  }
  assert.equal(await route(ctx), true, `${method} ${target} was not handled`)
  return sent
}

function harness(): {
  route: Route
  inserted: Doc[]
  writes: { desired: BrokerLinkDesired; reason: string; setBy: string }[]
  link: { current: BrokerLinkState }
} {
  const fake = fakeDb()
  const writes: { desired: BrokerLinkDesired; reason: string; setBy: string }[] = []
  // What the gateway last said — a stale "connected" ack right after a release
  // is the normal answer, and the route must relay it rather than invent one.
  const link = { current: { ...DEFAULT_BROKER_LINK, applied: 'connected' as const, appliedAt: NOW - 90_000 } }
  const service = {
    brokerLink: async () => link.current,
    setBrokerLink: async (desired: BrokerLinkDesired, reason: string, setBy: string) => {
      writes.push({ desired, reason, setBy })
      link.current = { ...link.current, desired, reason, setBy, setAt: NOW }
      return link.current
    },
  } as unknown as ApiDeps['service']
  const route = deskRoutes({
    db: fake.db,
    store: null as unknown as ApiDeps['store'],
    service,
    master: null as unknown as ApiDeps['master'],
    log: () => {},
    now: () => NOW,
    gate: gate(),
  })
  return { route, inserted: fake.inserted, writes, link }
}

describe('/v1/desk/broker-link', () => {
  test('GET answers the whole document — wish and the gateway ack', async () => {
    const h = harness()
    const res = await call(h.route, 'GET', '/v1/desk/broker-link')
    assert.equal(res.status, 200)
    assert.equal(res.body['desired'], 'connected')
    assert.equal(res.body['applied'], 'connected')
  })

  test('RELEASING needs no password, stamps the authenticated principal, and is audited', async () => {
    const h = harness()
    const res = await call(h.route, 'POST', '/v1/desk/broker-link', {
      desired: 'released',
      reason: 'key needed elsewhere',
      setBy: 'somebody-else',
    })
    assert.equal(res.status, 200)
    assert.deepEqual(h.writes, [{ desired: 'released', reason: 'key needed elsewhere', setBy: 'aaditya' }])
    // The answer carries the STALE ack — the gateway has not polled yet — so
    // the dashboard can render "asked, not yet done" honestly.
    assert.equal(res.body['desired'], 'released')
    assert.equal(res.body['applied'], 'connected')
    const line = h.inserted.find((d) => d['source'] === '/v1/desk/broker-link')
    assert.ok(line, 'no audit line')
    assert.equal(line['principal'], 'aaditya')
    assert.match(String(line['action']), /RELEASED the XTS session/)
  })

  test('RECONNECTING re-authenticates — no password is a 403 that asks for one', async () => {
    const h = harness()
    const denied = await call(h.route, 'POST', '/v1/desk/broker-link', { desired: 'connected' })
    assert.equal(denied.status, 403)
    assert.equal(denied.body['reauthRequired'], true)
    assert.deepEqual(h.writes, [], 'nothing was written')

    const wrong = await call(h.route, 'POST', '/v1/desk/broker-link', { desired: 'connected', password: 'nope' })
    assert.equal(wrong.status, 403)

    const ok = await call(h.route, 'POST', '/v1/desk/broker-link', { desired: 'connected', password: 'correct-horse' })
    assert.equal(ok.status, 200)
    assert.deepEqual(h.writes, [{ desired: 'connected', reason: '', setBy: 'aaditya' }])
    const line = h.inserted.find((d) => d['source'] === '/v1/desk/broker-link')
    assert.match(String(line?.['action']), /reconnected the XTS session/)
  })

  test('a machine token cannot reconnect', async () => {
    const h = harness()
    const res = await call(
      h.route, 'POST', '/v1/desk/broker-link',
      { desired: 'connected', password: 'correct-horse' },
      { kind: 'machine', name: 'bearer' },
    )
    assert.equal(res.status, 403)
    assert.deepEqual(h.writes, [])
  })

  test('anything but the two words is a 400, and a non-object body is not a 500', async () => {
    const h = harness()
    for (const body of [{ desired: 'off' }, { desired: true }, {}, null, 'x', []]) {
      const res = await call(h.route, 'POST', '/v1/desk/broker-link', body)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
    assert.deepEqual(h.writes, [])
  })
})
