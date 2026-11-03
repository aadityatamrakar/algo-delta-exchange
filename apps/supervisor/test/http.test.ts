/**
 * THE NUDGE SERVER — a real loopback socket, because the thing under test is a
 * contract with ANOTHER PROCESS.
 *
 * `apps/api/src/engine-notify.ts` composes the request: `POST /nudge`, a bearer
 * that defaults to `DESK_API_TOKEN`, a JSON body of `{kind, …}`, a 1-second
 * timeout. Every assertion below is against that shape rather than against a
 * handler function, because the failure this file exists to catch is the two
 * files DISAGREEING — and a mocked request cannot disagree with anything.
 *
 * The three that matter:
 *
 *   1. The answer comes back BEFORE the work. desk-api awaits this call inside
 *      an operator's dials PATCH; a supervisor that replied only after
 *      re-evaluating a book would hold the dashboard open for a Mongo round trip
 *      and a decision.
 *   2. A bad token is a 401 AND a log line at error. The failure it describes
 *      presents as "dial changes are sometimes slow", which nobody reports.
 *   3. `/health` needs no token. It is what an operator reaches for when the
 *      desk looks wrong, and putting a credential in front of that is how a
 *      health check becomes the thing nobody can run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNudgeServer, type SupervisorHealth } from '../src/http.ts'
import type { NudgeKind } from '../../api/src/engine-notify.ts'
import type { HostLog } from '../src/engine-host.ts'

interface Entry {
  readonly level: string
  readonly msg: string
  readonly ctx: Record<string, unknown>
}

function logOf(): HostLog & { lines: string[]; entries: Entry[] } {
  const lines: string[] = []
  const entries: Entry[] = []
  const push =
    (level: string) =>
    (msg: string, ctx: Record<string, unknown> = {}): void => {
      lines.push(`${level}: ${msg}`)
      entries.push({ level, msg, ctx })
    }
  return {
    lines,
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

const HEALTH: SupervisorHealth = { books: ['TCS:paper'], lease: 'sup-1', feedAgeMs: 240 }

interface Harness {
  readonly url: string
  readonly nudges: { kind: NudgeKind; body: Record<string, unknown> }[]
  readonly log: HostLog & { lines: string[]; entries: Entry[] }
  close(): Promise<void>
}

async function serve(token = '', health: () => SupervisorHealth = () => HEALTH): Promise<Harness> {
  const nudges: { kind: NudgeKind; body: Record<string, unknown> }[] = []
  const log = logOf()
  const server = createNudgeServer({
    port: 0,
    token,
    onNudge: (kind, body) => nudges.push({ kind, body }),
    health,
    log,
  })
  const port = await server.listen()
  return { url: `http://127.0.0.1:${String(port)}`, nudges, log, close: () => server.close() }
}

test('a dials nudge is accepted, answered, and handed over whole', async () => {
  const h = await serve()
  try {
    const res = await fetch(`${h.url}/nudge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'dials', tag: 'TCS', mode: 'paper' }),
    })
    assert.equal(res.status, 202)
    assert.deepEqual(await res.json(), { accepted: true, kind: 'dials' })
    assert.equal(h.nudges.length, 1)
    assert.equal(h.nudges[0]?.kind, 'dials')
    // The BODY is handed over verbatim — and is only ever used to narrow which
    // book to re-read, never as a decision input (see the module header).
    assert.equal(h.nudges[0]?.body['tag'], 'TCS')
  } finally {
    await h.close()
  }
})

test('THE ANSWER COMES BACK BEFORE THE WORK', async () => {
  // desk-api awaits this inside an operator's request. A reply that waited on the
  // re-evaluation would put a Mongo round trip in front of a dashboard save.
  let released = (): void => {}
  const blocked = new Promise<void>((resolve) => {
    released = resolve
  })
  const nudges: NudgeKind[] = []
  const server = createNudgeServer({
    port: 0,
    token: '',
    onNudge: (kind) => {
      nudges.push(kind)
      // A handler that never returns until the test says so.
      void blocked
    },
    health: () => HEALTH,
    log: logOf(),
  })
  const port = await server.listen()
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/nudge`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'fill' }),
    })
    assert.equal(res.status, 202)
    assert.deepEqual(nudges, ['fill'])
  } finally {
    released()
    await server.close()
  }
})

test('an unknown kind is refused rather than guessed at', async () => {
  const h = await serve()
  try {
    const res = await fetch(`${h.url}/nudge`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'flatten' }),
    })
    assert.equal(res.status, 400)
    assert.equal(h.nudges.length, 0)
  } finally {
    await h.close()
  }
})

test('a bad token is a 401 AND a loud line — the failure is silent otherwise', async () => {
  const h = await serve('the-real-token')
  try {
    const res = await fetch(`${h.url}/nudge`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: JSON.stringify({ kind: 'registry' }),
    })
    assert.equal(res.status, 401)
    assert.equal(h.nudges.length, 0)
    assert.ok(h.log.lines.some((l) => l.startsWith('error:') && l.includes('DESK_API_TOKEN')))

    const good = await fetch(`${h.url}/nudge`, {
      method: 'POST',
      headers: { authorization: 'Bearer the-real-token' },
      body: JSON.stringify({ kind: 'registry' }),
    })
    assert.equal(good.status, 202)
    assert.equal(h.nudges.length, 1)
  } finally {
    await h.close()
  }
})

test('a bad token is said once a minute, and the line names the caller', async () => {
  /**
   * A mis-set DESK_API_TOKEN on one of the two processes makes EVERY nudge
   * desk-api sends a 401: dial writes, desired-state changes, every fill. One
   * ERROR each is a page full of the same line within minutes; one a minute
   * with the count says the same thing and leaves the rest of the log
   * readable. The remote address is in the context so an operator can tell a
   * mis-configured desk-api from something else knocking on the port.
   */
  const h = await serve('the-real-token')
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${h.url}/nudge`, {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
        body: JSON.stringify({ kind: 'registry' }),
      })
      assert.equal(res.status, 401, 'every one is still refused')
    }
    const errors = h.log.entries.filter((e) => e.level === 'error' && e.msg.includes('DESK_API_TOKEN'))
    assert.equal(errors.length, 1, 'three refusals: one line')
    assert.ok(typeof errors[0]?.ctx['remote'] === 'string' && errors[0].ctx['remote'] !== '')
    assert.equal(errors[0]?.ctx['suppressed'], 0)
  } finally {
    await h.close()
  }
})

test('/health needs no token and answers the three questions', async () => {
  const h = await serve('the-real-token')
  try {
    const res = await fetch(`${h.url}/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { books: ['TCS:paper'], lease: 'sup-1', feedAgeMs: 240 })
  } finally {
    await h.close()
  }
})

test('a STANDBY answers honestly: no lease, no books', async () => {
  // Two supervisors is the worst failure this process has, so the second one
  // waiting must be visibly the second one — not indistinguishable from a
  // supervisor that is steering.
  const h = await serve('', () => ({ books: [], lease: null, feedAgeMs: null }))
  try {
    const body = (await (await fetch(`${h.url}/health`)).json()) as SupervisorHealth
    assert.equal(body.lease, null)
    assert.deepEqual(body.books, [])
  } finally {
    await h.close()
  }
})

test('anything else is a 404 that says what this server serves', async () => {
  const h = await serve()
  try {
    const res = await fetch(`${h.url}/v1/desk/flatten`, { method: 'POST' })
    assert.equal(res.status, 404)
    const body = (await res.json()) as { error?: string }
    assert.match(String(body.error), /POST \/nudge and GET \/health/)
  } finally {
    await h.close()
  }
})
