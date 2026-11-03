/**
 * THE OPERATOR AUDIT LOG (audit roadmap 17).
 *
 * Until this existed the desk recorded WHO for exactly one control — the kill
 * switch's `setBy` — and for nothing else. A book deleted, a dial retuned, a
 * strategy armed live, a ledger cleared: each left a log line in a file that
 * rotates and nothing in the database at all. "Who stopped BHEL yesterday?" was
 * unanswerable from the desk itself.
 *
 * What these tests are really about is the three properties that make an audit
 * log worth having:
 *
 *  1. IT CANNOT LEAK A CREDENTIAL. The brokers routes hand it bodies that
 *     carried a password one field away; a `detail` that ever contained one
 *     would be a secret copied into an append-only collection nobody prunes.
 *  2. IT CANNOT COST A MUTATION. A failed audit write logs and is dropped —
 *     the same contract `notify` holds. An operator's flatten must never fail
 *     because a bookkeeping insert did.
 *  3. IT RECORDS THE AUTHENTICATED PRINCIPAL, never the body. The same rule
 *     `setBy` has held since spec §5: a caller that can name themselves makes
 *     the record worthless.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AUDIT_COLLECTION,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  auditLog,
  ensureAuditIndex,
  redactDetail,
} from '../src/audit.ts'
import { deskRoutes } from '../src/routes/desk.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { runnerRoutes } from '../src/routes/runner.ts'
import { DayGuard } from '../src/day-guard.ts'
import type { ApiDeps, Principal, Route, RouteCtx } from '../src/routes/kit.ts'
import type { AuthGate } from '../src/authgate.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'

/**
 * This file builds `booksRoutes` inline, per test, against a fake `db` — no
 * Mongo, so it never imports `require-mongo.ts` and never gets that module's
 * defense-in-depth guard on `DESK_SUPERVISOR_PORT`. Two tests below drive the
 * registry start route and the dials PATCH, both of which call
 * `notifySupervisor` (`../src/engine-notify.ts`) on success. Without a sink
 * pointing `DESK_SUPERVISOR_PORT` somewhere loopback and harmless, those
 * nudges reach the REAL desk-supervisor on 8893 with no bearer token — see
 * `./nudge-sink.ts` for the full story (107 refusals per api suite run,
 * 2 of them from this file). One file-level sink for the whole file is
 * enough, since none of these tests exercise the routes concurrently.
 */
let sink: NudgeSink | null = null

before(async () => {
  sink = await startNudgeSink()
})

after(async () => {
  if (sink !== null) await sink.close()
})

const NOW = 1_760_000_000_000

type Doc = Record<string, unknown>

/** Every call the writer made, so "append-only" is a property a test can hold. */
interface Calls {
  inserted: Doc[]
  updated: number
  deleted: number
}

/**
 * The narrow slice of the `Database` port this module uses, in memory.
 *
 * `insertFails` is not decoration: the fail-soft contract is the reason the
 * writer exists in this shape, and it can only be tested from a collection that
 * refuses.
 */
function fakeDb(
  opts: { docs?: Doc[]; others?: Record<string, Doc[]>; insertFails?: boolean } = {},
): { db: ApiDeps['db']; calls: Calls; docs: Doc[] } {
  const docs = opts.docs ?? []
  const byName: Record<string, Doc[]> = { [AUDIT_COLLECTION]: docs, ...(opts.others ?? {}) }
  const calls: Calls = { inserted: [], updated: 0, deleted: 0 }
  const matches = (doc: Doc, filter: Doc): boolean =>
    Object.entries(filter).every(([k, v]) => doc[k] === v)
  const cursor = (rows: Doc[]): unknown => ({
    sort: (spec: Record<string, 1 | -1>) => {
      const dir = spec['at'] ?? 1
      return cursor([...rows].sort((a, b) => (Number(a['at']) - Number(b['at'])) * dir))
    },
    limit: (n: number) => cursor(rows.slice(0, n)),
    skip: () => cursor(rows),
    toArray: async () => rows,
  })
  const db = {
    collection(name: string): unknown {
      const own = (byName[name] ??= [])
      return {
        find: (filter: Doc) => cursor(own.filter((d) => matches(d, filter))),
        findOne: async (filter: Doc) => own.find((d) => matches(d, filter)) ?? null,
        insertOne: async (doc: Doc) => {
          if (opts.insertFails === true) throw new Error('audit collection is unwritable')
          calls.inserted.push(doc)
          own.push(doc)
          return {}
        },
        updateOne: async (filter: Doc, update: Doc, options?: { upsert?: boolean }) => {
          calls.updated += 1
          const set = (update['$set'] ?? {}) as Doc
          const existing = own.find((d) => matches(d, filter))
          if (existing !== undefined) Object.assign(existing, set)
          else if (options?.upsert === true) own.push({ ...filter, ...set })
          return { matchedCount: existing === undefined ? 0 : 1 }
        },
        deleteOne: async () => {
          calls.deleted += 1
          return {}
        },
        deleteMany: async () => {
          calls.deleted += 1
          return {}
        },
      }
    },
  }
  return { db: db as ApiDeps['db'], calls, docs }
}

const OPERATOR: Principal = { kind: 'user', name: 'aaditya' }
const MACHINE: Principal = { kind: 'machine', name: 'bearer' }

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

/** A gate that accepts one password, exactly as `authsvc` does. */
function gate(password = 'correct-horse'): AuthGate {
  return {
    authenticate: async () => null,
    reauth: async (principal, given) => {
      if (principal.kind !== 'user') return 'a machine token cannot perform this'
      return given === password ? null : 'password is incorrect'
    },
  }
}

// ------------------------------------------------------------------- writer

describe('the audit writer', () => {
  test('records who, where, what and when', async () => {
    const fake = fakeDb()
    const audit = auditLog({ db: fake.db, log: () => {}, now: () => NOW })
    await audit.record({
      principal: OPERATOR,
      source: '/v1/desk/killswitch',
      action: 'engaged the kill switch',
      tag: 'BHEL-2026-08-25-hold-recycle-r',
      mode: 'live',
      detail: { before: false, after: true },
    })
    const [entry] = fake.calls.inserted
    assert.ok(entry, 'the entry was not written')
    assert.equal(entry['at'], NOW)
    assert.equal(entry['principal'], 'aaditya')
    assert.equal(entry['principalKind'], 'user')
    assert.equal(entry['source'], '/v1/desk/killswitch')
    assert.equal(entry['action'], 'engaged the kill switch')
    assert.equal(entry['tag'], 'BHEL-2026-08-25-hold-recycle-r')
    assert.equal(entry['mode'], 'live')
    assert.deepEqual(entry['detail'], { before: false, after: true })
  })

  test('it is APPEND-ONLY — one insert, never an update or a delete', async () => {
    const fake = fakeDb()
    const audit = auditLog({ db: fake.db, log: () => {}, now: () => NOW })
    await audit.record({ principal: OPERATOR, source: '/x', action: 'did a thing' })
    await audit.record({ principal: OPERATOR, source: '/x', action: 'did it again' })
    assert.equal(fake.calls.inserted.length, 2)
    assert.equal(fake.calls.updated, 0)
    assert.equal(fake.calls.deleted, 0)
  })

  test('a failed audit write never fails the mutation', async () => {
    const fake = fakeDb({ insertFails: true })
    const said: string[] = []
    const audit = auditLog({ db: fake.db, log: (m) => said.push(m), now: () => NOW })
    // No rejection, no throw — the same contract `notify` holds.
    await audit.record({ principal: OPERATOR, source: '/v1/desk/close-all', action: 'flattened a tag' })
    assert.equal(said.length, 1, 'a dropped audit entry must be SAID, not swallowed silently')
    assert.match(said[0] ?? '', /audit/i)
  })

  test('a system principal (the day guard) is recorded as one', async () => {
    const fake = fakeDb()
    const audit = auditLog({ db: fake.db, log: () => {}, now: () => NOW })
    await audit.record({
      principal: { kind: 'system', name: 'day-guard' },
      source: 'day-guard',
      action: 'stopped a rail for the day',
      tag: 'BN_BREAKOUT',
      mode: 'paper',
    })
    assert.equal(fake.calls.inserted[0]?.['principal'], 'day-guard')
    assert.equal(fake.calls.inserted[0]?.['principalKind'], 'system')
  })
})

// ---------------------------------------------------------------- redaction

describe('redaction — the one invariant', () => {
  test('a password, a token and a secret never reach the collection', () => {
    const out = redactDetail({
      password: 'hunter2',
      totpSecret: '234567',
      enctoken: 'abc.def',
      apiSecret: 'zzz',
      symbol: 'BHEL',
    })
    const text = JSON.stringify(out)
    assert.equal(text.includes('hunter2'), false)
    assert.equal(text.includes('234567'), false)
    assert.equal(text.includes('abc.def'), false)
    assert.equal(text.includes('zzz'), false)
    // The rest of the summary survives — a redactor that ate the whole detail
    // would make the entry useless rather than safe.
    assert.equal(out['symbol'], 'BHEL')
  })

  test('a NESTED credential is redacted too', () => {
    const out = redactDetail({ secret: { legacy: { password: 'hunter2' } }, kind: 'zerodha' })
    assert.equal(JSON.stringify(out).includes('hunter2'), false)
    assert.equal(out['kind'], 'zerodha')
  })

  test('the detail stays SMALL — long strings and long lists are cut', () => {
    const out = redactDetail({
      note: 'x'.repeat(1000),
      legs: Array.from({ length: 200 }, (_, i) => `LEG${i}`),
    })
    assert.ok(String(out['note']).length < 300, 'a 1000-character note is not a summary')
    assert.ok(Array.isArray(out['legs']) && (out['legs'] as unknown[]).length <= 21)
  })

  test('a cyclic detail does not hang the writer', () => {
    const cycle: Record<string, unknown> = { tag: 'BHEL' }
    cycle['self'] = cycle
    const out = redactDetail(cycle)
    assert.equal(out['tag'], 'BHEL')
    assert.equal(cycle['self'], cycle, 'the caller’s object is not mutated')
  })

  /**
   * THE SAME OBJECT TWICE IS NOT A CYCLE, and a before/after summary is the
   * exact shape that makes the difference matter.
   *
   * `{before: dials, after: dials}` — a handler that read the row once and
   * passed the same reference on both sides, or any two keys pointing at one
   * shared sub-object — is a DAG, not a loop. A `seen` set that is never
   * unwound rendered the SECOND branch as `'[cycle]'`, so half of the one
   * record that answers "what were the dials before?" read as a diagnostic
   * string. Detection has to be scoped to the PATH being walked, not to the
   * whole traversal.
   */
  test('a value shared by two branches is rendered twice, not called a cycle', () => {
    const shared = { shift_margin_frac: 0.6, band: 3 }
    const out = redactDetail({ before: shared, after: shared })
    assert.deepEqual(out['before'], shared)
    assert.deepEqual(out['after'], shared, 'the second branch is a DAG, not a loop')
  })

  test('a repeated value inside a LIST survives too', () => {
    const leg = { tradingsymbol: 'BHEL26AUG300CE', qty: -1350 }
    const out = redactDetail({ legs: [leg, leg] })
    assert.deepEqual(out['legs'], [leg, leg])
  })

  test('a genuine cycle is still named, at any depth', () => {
    const inner: Record<string, unknown> = { tag: 'BHEL' }
    const outer: Record<string, unknown> = { before: inner }
    inner['parent'] = outer
    const out = redactDetail(outer)
    const before = out['before'] as Record<string, unknown>
    assert.equal(before['tag'], 'BHEL')
    assert.equal(before['parent'], '[cycle]')
  })

  test('the writer redacts on the way in, not at the call site', async () => {
    const fake = fakeDb()
    const audit = auditLog({ db: fake.db, log: () => {}, now: () => NOW })
    await audit.record({
      principal: OPERATOR,
      source: '/v1/desk/brokers/zerodha',
      action: 'saved broker credentials',
      detail: { secret: { password: 'hunter2' } },
    })
    assert.equal(JSON.stringify(fake.calls.inserted[0]).includes('hunter2'), false)
  })
})

// ------------------------------------------------------------------ reading

describe('reading the log back', () => {
  const rows = (n: number): Doc[] =>
    Array.from({ length: n }, (_, i) => ({
      at: NOW - i * 1000,
      principal: 'aaditya',
      principalKind: 'user',
      source: '/v1/desk/books/registry/T/start',
      action: 'started a book',
      tag: `T${i}`,
      mode: 'paper',
      detail: {},
    }))

  test('newest first, and capped', async () => {
    const fake = fakeDb({ docs: rows(10) })
    const audit = auditLog({ db: fake.db, log: () => {}, now: () => NOW })
    const got = await audit.recent(3)
    assert.equal(got.length, 3)
    assert.equal(got[0]?.at, NOW)
    assert.ok((got[0]?.at ?? 0) > (got[1]?.at ?? 0), 'the newest entry must come first')
  })

  test('a malformed row is dropped rather than rendered as a guess', async () => {
    const fake = fakeDb({ docs: [{ at: 'nonsense', action: 5 }, ...rows(1)] })
    const audit = auditLog({ db: fake.db, log: () => {}, now: () => NOW })
    const got = await audit.recent(10)
    assert.equal(got.length, 1)
    assert.equal(got[0]?.action, 'started a book')
  })

  test('the sort has an index behind it, and a database that cannot make one still boots', () => {
    /**
     * The collection is append-only and pruned by nothing. An unindexed sort is
     * fine at a thousand rows and a hard failure at Mongo's 32MB sort limit —
     * which is reached exactly when somebody is trying to find out what
     * happened.
     */
    const made: Record<string, 1 | -1>[] = []
    const withIndex = {
      collection: () => ({ createIndex: async (spec: Record<string, 1 | -1>) => made.push(spec) }),
    } as unknown as ApiDeps['db']
    ensureAuditIndex({ db: withIndex, log: () => {} })
    assert.deepEqual(made, [{ at: -1 }])

    // And a port with no `createIndex` at all — every route test builds one —
    // must be a desk with no index, not a route module that fails to construct.
    const said: string[] = []
    ensureAuditIndex({ db: fakeDb().db, log: (m) => said.push(m) })
    assert.equal(said.length, 1)
  })

  test('an unreadable collection answers empty rather than throwing', async () => {
    const db = {
      collection: () => {
        throw new Error('mongo is down')
      },
    } as unknown as ApiDeps['db']
    const audit = auditLog({ db, log: () => {}, now: () => NOW })
    assert.deepEqual(await audit.recent(10), [])
  })
})

// ------------------------------------------------------------- the endpoint

describe('GET /v1/desk/audit', () => {
  function deskHarness(docs: Doc[] = []): { route: Route; docs: Doc[] } {
    const fake = fakeDb({ docs })
    const deps = {
      db: fake.db,
      store: null as unknown as ApiDeps['store'],
      service: null as unknown as ApiDeps['service'],
      master: null as unknown as ApiDeps['master'],
      log: () => {},
      now: () => NOW,
    } satisfies ApiDeps
    return { route: deskRoutes({ ...deps, gate: gate() }), docs: fake.docs }
  }

  const entry = (over: Doc = {}): Doc => ({
    at: NOW,
    principal: 'aaditya',
    principalKind: 'user',
    source: '/v1/desk/killswitch',
    action: 'engaged the kill switch',
    detail: {},
    ...over,
  })

  test('an operator can read the recent actions', async () => {
    const { route } = deskHarness([entry(), entry({ at: NOW - 1000, action: 'started a book' })])
    const res = await call(route, 'GET', '/v1/desk/audit')
    assert.equal(res.status, 200)
    const entries = res.body['entries'] as Doc[]
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.['action'], 'engaged the kill switch')
  })

  test('a MACHINE principal is refused — this is an operator surface', async () => {
    const { route } = deskHarness([entry()])
    const res = await call(route, 'GET', '/v1/desk/audit', null, MACHINE)
    assert.equal(res.status, 403)
  })

  test('the limit is clamped, so no caller can page the collection into memory', async () => {
    const many = Array.from({ length: 60 }, (_, i) => entry({ at: NOW - i }))
    const { route } = deskHarness(many)
    const dflt = await call(route, 'GET', '/v1/desk/audit')
    assert.equal((dflt.body['entries'] as Doc[]).length, AUDIT_DEFAULT_LIMIT)
    const asked = await call(route, 'GET', `/v1/desk/audit?limit=${AUDIT_MAX_LIMIT * 10}`)
    assert.ok((asked.body['entries'] as Doc[]).length <= AUDIT_MAX_LIMIT)
  })
})

// ----------------------------------------------------- representative routes

describe('the mutating routes write their line', () => {
  test('the kill switch records the AUTHENTICATED principal, not the body', async () => {
    const fake = fakeDb()
    const service = {
      setKillSwitch: async (enabled: boolean, reason: string, setBy: string) => ({
        enabled,
        reason,
        setBy,
        at: NOW,
      }),
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
    const res = await call(route, 'POST', '/v1/desk/killswitch', {
      enabled: true,
      reason: 'feed is wrong',
      setBy: 'somebody-else',
    })
    assert.equal(res.status, 200)
    const line = fake.calls.inserted[0]
    assert.ok(line, 'engaging the kill switch wrote no audit line')
    assert.equal(line['principal'], 'aaditya')
    assert.equal(line['source'], '/v1/desk/killswitch')
    assert.match(String(line['action']), /kill switch/i)
  })

  test('starting a book records the state it moved FROM and TO', async () => {
    const fake = fakeDb()
    const book = {
      tag: 'BHEL-2026-08-25-hold-recycle-r',
      mode: 'paper',
      desired: 'stopped',
      actual: 'stopped',
      variant: 'hold-recycle-r',
      dials: {},
    }
    const store = {
      getBook: async () => book,
      setDesired: async () => ({ ...book, desired: 'running' }),
    } as unknown as ApiDeps['store']
    const route = booksRoutes({
      db: fake.db,
      store,
      service: null as unknown as ApiDeps['service'],
      master: null as unknown as ApiDeps['master'],
      log: () => {},
      now: () => NOW,
      gate: gate(),
    })
    assert.ok(sink !== null)
    sink.nudges.length = 0
    const res = await call(
      route,
      'POST',
      `/v1/desk/books/registry/${book.tag}/start`,
      { mode: 'paper' },
    )
    assert.equal(res.status, 200)
    const line = fake.calls.inserted[0]
    assert.ok(line, 'starting a book wrote no audit line')
    assert.equal(line['tag'], book.tag)
    assert.equal(line['mode'], 'paper')
    assert.deepEqual(line['detail'], { before: 'stopped', after: 'running' })
    // Load-bearing, not just a silencer: starting a book nudges the
    // supervisor with kind registry (see ./nudge-sink.ts).
    assert.equal(sink.nudges.length, 1, 'starting a book did not nudge the supervisor')
    assert.equal(sink.nudges[0]?.['kind'], 'registry')
    assert.equal(sink.nudges[0]?.['tag'], book.tag)
  })

  test('a dials patch records the VALUES, and never the password beside them', async () => {
    const fake = fakeDb()
    const book = {
      tag: 'BHEL-2026-08-25-hold-recycle-r',
      mode: 'live',
      desired: 'running',
      actual: 'running',
      variant: 'hold-recycle-r',
      dials: { shift_margin_frac: 0.6 },
    }
    const store = {
      getBook: async () => book,
      listVariants: async () => [
        { key: 'hold-recycle-r', label: 'hold', defaults: { shift_margin_frac: 0.6 } },
      ],
      patchBookDials: async () => ({ ...book, dials: { shift_margin_frac: 0.02 } }),
    } as unknown as ApiDeps['store']
    const route = booksRoutes({
      db: fake.db,
      store,
      service: null as unknown as ApiDeps['service'],
      master: null as unknown as ApiDeps['master'],
      log: () => {},
      now: () => NOW,
      gate: gate(),
    })
    const res = await call(route, 'PATCH', `/v1/desk/books/registry/${book.tag}`, {
      mode: 'live',
      dials: { shift_margin_frac: 0.02 },
      password: 'correct-horse',
    })
    assert.equal(res.status, 200)
    const line = fake.calls.inserted[0]
    assert.ok(line, 'a dials patch wrote no audit line')
    assert.equal(JSON.stringify(line).includes('correct-horse'), false, 'the password reached the log')
    assert.deepEqual(line['detail'], {
      before: { shift_margin_frac: 0.6 },
      after: { shift_margin_frac: 0.02 },
    })
  })

  test("the DAY GUARD's automatic stop is recorded as the desk's own act", async () => {
    /**
     * A rail that is off tomorrow morning was switched off by somebody. Without
     * this line the guard's stop and an operator's stop are indistinguishable
     * in the one record that exists to tell them apart.
     */
    const fake = fakeDb()
    const row = {
      tag: 'BN_BREAKOUT',
      kind: 'hosted' as const,
      label: 'BN breakout',
      modes: { paper: { added: true, enabled: true } },
      dailyLimits: { stop: 3000 },
      updatedAt: NOW - 1000,
      liveLots: 1,
      autostartAt: '',
      lastSeenAt: 0,
      disabledReason: '',
    }
    const guard = new DayGuard({
      now: () => NOW,
      log: () => {},
      listStrategies: async () => [row] as unknown as never,
      loadStrategy: async () => row as unknown as never,
      pnl: async () => ({
        strategies: [
          { tag: 'BN_BREAKOUT', realised: -4000, total: -4000, complete: true, unpriced: 0, openLegs: 0 },
        ],
      }) as unknown as never,
      patchStrategy: async () => ({ ...row, modes: { paper: { added: true, enabled: false } } }) as unknown as never,
      guards: {
        claim: async () => true,
        appendAction: async () => {},
        today: async () => [],
      },
      journal: async () => {},
      runtimeHost: async () => 'runner',
      flattenTag: async () => ({ decisionId: 'd', replayed: false, flat: true, legs: [] }),
      audit: auditLog({ db: fake.db, log: () => {}, now: () => NOW }),
    })
    await guard.runGuards(NOW)
    const line = fake.calls.inserted[0]
    assert.ok(line, 'the day guard stopped a rail and recorded nothing')
    assert.equal(line['principal'], 'day-guard')
    assert.equal(line['principalKind'], 'system')
    assert.equal(line['tag'], 'BN_BREAKOUT')
    assert.equal(line['mode'], 'paper')
    assert.match(String(line['action']), /stop/i)
  })

  test('a runner ledger clear records who asked for it', async () => {
    const fake = fakeDb({
      others: {
        'desk-strategy-state': [
          { tag: 'MIRROR_A006:live', key: 'runner:positions', value: [], updatedAt: NOW },
        ],
      },
    })
    const route = runnerRoutes({
      db: fake.db,
      store: null as unknown as ApiDeps['store'],
      service: null as unknown as ApiDeps['service'],
      master: null as unknown as ApiDeps['master'],
      log: () => {},
      now: () => NOW,
      gate: gate(),
    })
    const res = await call(route, 'POST', '/v1/desk/runner/positions/clear', {
      tag: 'MIRROR_A006',
      mode: 'live',
      symbols: 'expired',
      password: 'correct-horse',
    })
    assert.equal(res.status, 202)
    const line = fake.calls.inserted.at(-1)
    assert.ok(line, 'a ledger clear wrote no audit line')
    assert.equal(line['principal'], 'aaditya')
    assert.equal(line['tag'], 'MIRROR_A006')
    assert.equal(line['mode'], 'live')
    assert.equal(JSON.stringify(line).includes('correct-horse'), false)
  })
})
