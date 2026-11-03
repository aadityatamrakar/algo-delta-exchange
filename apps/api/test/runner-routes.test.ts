/**
 * `/v1/desk/runner/positions` — the audited clear (audit F-6d).
 *
 * What this replaces: "stop desk-runner -> edit Mongo -> start", in that order,
 * because the runner caches each `PositionLedger` at boot and the next `#save()`
 * silently undoes an edit made while it is up. That runbook was the ONLY way to
 * clear a stuck mirror leg, it cost a full restart of every hosted strategy, and
 * it left no record of who removed what.
 *
 * The property every test below is really about: THE API NEVER WRITES THE
 * LEDGER. It writes a REQUEST, keyed under the same `TAG:mode` scope, and the
 * runner applies it through the ledger it owns. One writer, still.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { runnerRoutes } from '../src/routes/runner.ts'
import type { ApiDeps, Principal, RouteCtx } from '../src/routes/kit.ts'
import type { AuthGate } from '../src/authgate.ts'

const NOW = 1_760_000_000_000
const STATE = 'desk-strategy-state'

type Doc = Record<string, unknown>

/** The narrow slice of the `Database` port this route uses, in memory. */
function fakeDb(docs: Doc[]): { db: ApiDeps['db']; docs: Doc[] } {
  const matches = (doc: Doc, filter: Doc): boolean =>
    Object.entries(filter).every(([k, v]) => doc[k] === v)
  const db = {
    collection(name: string): unknown {
      if (name !== STATE) throw new Error(`unexpected collection ${name}`)
      const cursor = (rows: Doc[]): unknown => ({
        sort: () => cursor(rows),
        limit: (n: number) => cursor(rows.slice(0, n)),
        toArray: async () => rows,
      })
      return {
        find: (filter: Doc) => cursor(docs.filter((d) => matches(d, filter))),
        findOne: async (filter: Doc) => docs.find((d) => matches(d, filter)) ?? null,
        updateOne: async (filter: Doc, update: Doc, options?: { upsert?: boolean }) => {
          const set = update['$set'] as Doc
          const existing = docs.find((d) => matches(d, filter))
          if (existing !== undefined) Object.assign(existing, set)
          else if (options?.upsert === true) docs.push({ ...filter, ...set })
          return { matchedCount: existing === undefined ? 0 : 1 }
        },
      }
    },
  }
  return { db: db as ApiDeps['db'], docs }
}

/** A gate whose reauth accepts exactly one password, like the real one. */
function gate(password = 'correct-horse'): AuthGate {
  return {
    authenticate: async () => null,
    reauth: async (principal, given) => {
      // The real `authsvc` refuses a machine principal unconditionally — an
      // automated client must never be able to clear a position ledger.
      if (principal.kind !== 'user') {
        return 'this action requires an operator password; a machine token cannot perform it'
      }
      return given === password ? null : 'password is incorrect'
    },
  }
}

function harness(docs: Doc[] = [], password?: string): {
  route: ReturnType<typeof runnerRoutes>
  docs: Doc[]
} {
  const fake = fakeDb(docs)
  const deps = {
    db: fake.db,
    store: null as unknown as ApiDeps['store'],
    service: null as unknown as ApiDeps['service'],
    master: null as unknown as ApiDeps['master'],
    log: () => {},
    now: () => NOW,
  } satisfies ApiDeps
  return { route: runnerRoutes({ ...deps, gate: gate(password) }), docs: fake.docs }
}

async function call(
  route: ReturnType<typeof runnerRoutes>,
  method: string,
  target: string,
  body: unknown = null,
  principal: Principal = { kind: 'user', name: 'aaditya' },
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
  const handled = await route(ctx)
  assert.equal(handled, true, `${method} ${target} was not handled`)
  return sent
}

const positionsDoc = (tag: string, entries: unknown[]): Doc => ({
  tag,
  key: 'runner:positions',
  value: entries,
  updatedAt: NOW - 60_000,
})

const LEG = {
  tradingsymbol: 'SENSEX2580681000CE',
  instrument: { tradingsymbol: 'SENSEX2580681000CE', lotSize: 10, tickSize: 0.05, exchange: 'BFO' },
  lots: -3,
  lastPrice: 12.5,
  expiry: '2026-08-06',
}

// ------------------------------------------------------------------ listing

test('GET lists every runner ledger, split into tag and mode', async () => {
  const h = harness([
    positionsDoc('MIRROR_A006:paper', [LEG]),
    positionsDoc('BN_BREAKOUT:live', []),
    // Not a ledger — the strategies' own recovery state shares this collection.
    { tag: 'BN_BREAKOUT:live', key: 'position', value: { some: 'state' } },
  ])

  const res = await call(h.route, 'GET', '/v1/desk/runner/positions')

  assert.equal(res.status, 200)
  const rows = res.body['positions'] as Doc[]
  assert.equal(rows.length, 2)
  const a006 = rows.find((r) => r['tag'] === 'MIRROR_A006')
  assert.equal(a006?.['mode'], 'paper')
  assert.equal(a006?.['openCount'], 1)
  assert.deepEqual((a006?.['entries'] as Doc[])[0]?.['tradingsymbol'], LEG.tradingsymbol)
  assert.equal(a006?.['entries'] !== undefined, true)
  const bn = rows.find((r) => r['tag'] === 'BN_BREAKOUT')
  assert.equal(bn?.['mode'], 'live')
  assert.equal(bn?.['openCount'], 0)
})

test('a machine principal may READ the ledgers — the runner itself is one', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])
  const res = await call(h.route, 'GET', '/v1/desk/runner/positions', null, {
    kind: 'machine',
    name: 'bearer',
  })
  assert.equal(res.status, 200)
})

// -------------------------------------------------------------- the clear

test('a clear WITHOUT the password is refused, and writes nothing at all', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])

  const res = await call(h.route, 'POST', '/v1/desk/runner/positions/clear', {
    tag: 'MIRROR_A006',
    mode: 'paper',
    symbols: 'expired',
  })

  assert.equal(res.status, 403)
  assert.equal(res.body['reauthRequired'], true)
  assert.equal(h.docs.length, 1, 'no request document may be written by a refused call')
})

test('a MACHINE principal can never clear — an automated client must not empty a ledger', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])

  const res = await call(
    h.route,
    'POST',
    '/v1/desk/runner/positions/clear',
    { tag: 'MIRROR_A006', mode: 'paper', symbols: 'all', password: 'correct-horse' },
    { kind: 'machine', name: 'bearer' },
  )

  assert.equal(res.status, 403)
  assert.equal(h.docs.length, 1)
})

test('an authorised clear writes a REQUEST document — never the ledger itself', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])

  const res = await call(h.route, 'POST', '/v1/desk/runner/positions/clear', {
    tag: 'MIRROR_A006',
    mode: 'paper',
    symbols: [LEG.tradingsymbol],
    password: 'correct-horse',
  })

  assert.equal(res.status, 202, 'the runner has not applied it yet — 202, not 200')
  const request = h.docs.find((d) => d['key'] === 'runner:clear-request')
  assert.ok(request !== undefined, 'a clear-request document is written')
  assert.equal(request['tag'], 'MIRROR_A006:paper', 'scoped to the instance, like the ledger')
  const value = request['value'] as Doc
  assert.deepEqual(value['symbols'], [LEG.tradingsymbol])
  assert.equal(value['requestedBy'], 'aaditya')
  assert.equal(value['requestedAt'], NOW)
  // READ, not merely recorded: the runner refuses a request it finds older than
  // its TTL, so the 202 must not promise an application that will never come.
  assert.match(String(res.body['note']), /expires/)
  // THE LEDGER IS UNTOUCHED. Single writer: the runner owns that document.
  const ledger = h.docs.find((d) => d['key'] === 'runner:positions')
  assert.deepEqual(ledger?.['value'], [LEG])
})

test("a second clear REPLACES the pending request rather than stacking a duplicate", async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])
  const body = { tag: 'MIRROR_A006', mode: 'paper', symbols: 'all', password: 'correct-horse' }
  await call(h.route, 'POST', '/v1/desk/runner/positions/clear', body)
  await call(h.route, 'POST', '/v1/desk/runner/positions/clear', body)

  assert.equal(h.docs.filter((d) => d['key'] === 'runner:clear-request').length, 1)
})

test('a clear for an instance with no ledger is a 404, not an orphan request', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])

  const res = await call(h.route, 'POST', '/v1/desk/runner/positions/clear', {
    tag: 'MIRROR_TYPO',
    mode: 'paper',
    symbols: 'all',
    password: 'correct-horse',
  })

  assert.equal(res.status, 404)
  assert.equal(h.docs.filter((d) => d['key'] === 'runner:clear-request').length, 0)
})

test('an unreadable symbols selector is a 400 that names what is accepted', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])
  for (const symbols of ['everything', [], [''], [{ nope: 1 }], 42, undefined]) {
    const res = await call(h.route, 'POST', '/v1/desk/runner/positions/clear', {
      tag: 'MIRROR_A006',
      mode: 'paper',
      ...(symbols === undefined ? {} : { symbols }),
      password: 'correct-horse',
    })
    assert.equal(res.status, 400, `${JSON.stringify(symbols)} must be refused`)
    assert.match(String(res.body['error']), /expired|all/)
  }
  assert.equal(h.docs.filter((d) => d['key'] === 'runner:clear-request').length, 0)
})

test('a mode that is neither paper nor live is refused — a typo must not clear the wrong rail', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])
  const res = await call(h.route, 'POST', '/v1/desk/runner/positions/clear', {
    tag: 'MIRROR_A006',
    mode: 'PAPER',
    symbols: 'all',
    password: 'correct-horse',
  })
  assert.equal(res.status, 400)
})

test('a tag carrying a Mongo operator character is refused before it reaches a query', async () => {
  const h = harness([positionsDoc('MIRROR_A006:paper', [LEG])])
  for (const tag of ['$where', 'a.b', '', 'x'.repeat(200)]) {
    const res = await call(h.route, 'POST', '/v1/desk/runner/positions/clear', {
      tag,
      mode: 'paper',
      symbols: 'all',
      password: 'correct-horse',
    })
    assert.equal(res.status, 400, `${tag} must be refused`)
  }
})

test('an unrelated path falls through to the next route module', async () => {
  const h = harness()
  const url = new URL('http://desk/v1/desk/pnl')
  const handled = await h.route({
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method: 'GET',
    principal: { kind: 'user', name: 'aaditya' },
    log: () => {},
    readJson: async () => null,
    send: () => assert.fail('nothing may be sent for a path this module does not own'),
  })
  assert.equal(handled, false)
})
