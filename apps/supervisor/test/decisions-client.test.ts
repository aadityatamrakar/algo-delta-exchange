/**
 * THE ONE WIRE OUT — and the three answers it has to keep apart.
 *
 * `DecisionsClient` is the only thing in this process that can place an order,
 * and everything it does is in service of one distinction the supervisor cannot
 * make for itself:
 *
 *   REFUSED — desk-api looked at the request and said no. Nothing was claimed,
 *   nothing routed, and posting it again would be refused again. The host rolls
 *   its rule state back.
 *
 *   INDETERMINATE — the answer was lost. The package may be live. The id is
 *   kept and re-posted verbatim, which is safe precisely because desk-api's
 *   `decisionId` index answers a replay with the ORIGINAL outcome.
 *
 *   An outcome — DONE / FAILED / WORKING / ROUTING, as the endpoint decided it.
 *
 * Getting the first two the wrong way round is the expensive failure in both
 * directions: a REFUSED read as indeterminate re-posts a package forever, and
 * an INDETERMINATE read as refused rolls the rule state back on a package that
 * is at the broker right now.
 *
 * No network here: `fetch` is injected, so every one of these runs on a laptop.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ENGINE_DECISIONS_PATH, type DecisionRequest, type DecisionResponse } from '@algomaker/desk-engine'
import { DecisionsClient, RefusedError, refusalGuidance } from '../src/decisions-client.ts'

const REQ: DecisionRequest = {
  tag: 'TCS',
  mode: 'paper',
  decisionId: 'TCS:paper:7',
  symbol: 'TCS',
  expiry: '2026-08-28',
  trigger: 'shed',
  reason: 'the band is breached',
  actions: [{ op: 'open', instrument: 'TCS26AUG3300CE', side: 'Sell', qty: 175 }],
  work: { trancheLots: 3 },
}

const DONE: DecisionResponse = {
  decisionId: REQ.decisionId,
  replayed: false,
  status: 'DONE',
  fills: [{ instrument: 'TCS26AUG3300CE', side: 'Sell', qty: 175, price: 12.5 }],
  skips: [],
  routeErrors: [],
}

/** One recorded call, plus whatever the fake was told to answer with. */
interface Call {
  readonly url: string
  readonly init: RequestInit
}

function fakeFetch(
  answer: (n: number) => Promise<Response> | Response,
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = []
  const fn = (async (url: unknown, init: unknown): Promise<Response> => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return await answer(calls.length)
  }) as unknown as typeof globalThis.fetch
  return { fetch: fn, calls }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

const clientWith = (fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}): DecisionsClient =>
  new DecisionsClient('http://api.test', 'TOKEN', { fetch, retryDelayMs: 0, ...over })

test('the request goes to the engine path, as JSON, with the machine bearer', async () => {
  const f = fakeFetch(() => json(200, DONE))
  const out = await clientWith(f.fetch).submit(REQ)

  assert.deepEqual(out, DONE)
  const call = f.calls[0]
  assert.ok(call !== undefined)
  assert.equal(call.url, `http://api.test${ENGINE_DECISIONS_PATH}`)
  assert.equal(call.init.method, 'POST')
  const headers = call.init.headers as Record<string, string>
  assert.equal(headers['authorization'], 'Bearer TOKEN')
  assert.equal(headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(call.init.body)), REQ)
})

test('a 4xx is a REFUSAL: thrown with the body, and never retried', async () => {
  // desk-api answers a malformed or gated package with `400 {error}` and NOTHING
  // WRITTEN — no decisionId claimed. Retrying it would be refused again, and
  // treating it as indeterminate would leave the host holding an inFlight id
  // that no amount of polling will ever resolve.
  const f = fakeFetch(() => json(400, { error: "actions name 'X' more than once" }))
  await assert.rejects(
    async () => await clientWith(f.fetch).submit(REQ),
    (err: unknown) => {
      assert.ok(err instanceof RefusedError)
      assert.equal(err.status, 400)
      assert.match(err.body, /more than once/)
      return true
    },
  )
  assert.equal(f.calls.length, 1, 'a refusal is definite — one attempt only')
})

test('a 403 is a refusal too — the machine gate is not a transport failure', async () => {
  const f = fakeFetch(() => json(403, { error: 'only a machine principal may post an engine decision' }))
  await assert.rejects(async () => await clientWith(f.fetch).submit(REQ), RefusedError)
  assert.equal(f.calls.length, 1)
})

test('a 5xx is retried under the SAME decisionId, then answered INDETERMINATE', async () => {
  // The claim is written before the tranches go out, so a lost answer is not
  // evidence that nothing routed. Re-posting the same id cannot double-route —
  // it replays — and is the only way to find out.
  const f = fakeFetch(() => json(503, { error: 'mongo is down' }))
  const out = await clientWith(f.fetch).submit(REQ)

  assert.equal(out, 'INDETERMINATE')
  assert.equal(f.calls.length, 3, 'three attempts, as HttpOrderGateway makes')
  for (const call of f.calls) {
    assert.equal(JSON.parse(String(call.init.body)).decisionId, REQ.decisionId)
  }
})

test('a retry that succeeds is the answer — the first 500 is not the outcome', async () => {
  const f = fakeFetch((n) => (n === 1 ? json(500, { error: 'blip' }) : json(200, DONE)))
  assert.deepEqual(await clientWith(f.fetch).submit(REQ), DONE)
  assert.equal(f.calls.length, 2)
})

test('a transport throw is indeterminate, not a refusal', async () => {
  const f = fakeFetch(() => {
    throw new Error('ECONNRESET')
  })
  assert.equal(await clientWith(f.fetch).submit(REQ), 'INDETERMINATE')
  assert.equal(f.calls.length, 3)
})

test('a request that never answers times out — and is still indeterminate', async () => {
  // Without a timeout a hung desk-api wedges the host's evaluation queue for
  // the rest of the session: no polls, no guards, no marks.
  // The fake honours `signal` exactly as the platform `fetch` does — a fake
  // that ignored it would prove the timer was set and nothing about the abort.
  const f = fakeFetch(
    async (n): Promise<Response> =>
      await new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(json(200, DONE)), 60_000)
        t.unref?.()
        const call = f.calls[n - 1]
        call?.init.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('This operation was aborted'))
        })
      }),
  )
  const out = await clientWith(f.fetch, { timeoutMs: 5 }).submit(REQ)
  assert.equal(out, 'INDETERMINATE')
  assert.equal(f.calls.length, 3, 'a timeout is a lost answer, so it is retried')
})

test('a 200 that is not a decision outcome is INDETERMINATE, never an outcome', async () => {
  // A body we cannot read is not evidence of anything. Folding fills off it —
  // or worse, clearing the inFlight id — would lose a package that is live.
  for (const body of [{ ok: true }, { decisionId: REQ.decisionId, status: 'SORTOF', fills: [] }, 'not json at all']) {
    const f = fakeFetch(() =>
      typeof body === 'string' ? new Response(body, { status: 200 }) : json(200, body),
    )
    assert.equal(await clientWith(f.fetch).submit(REQ), 'INDETERMINATE')
  }
})

test('a 200 answering a DIFFERENT decisionId is never folded', async () => {
  // The one shape that would book another book's fills into this one's P&L.
  const f = fakeFetch(() => json(200, { ...DONE, decisionId: 'TCS:paper:6' }))
  assert.equal(await clientWith(f.fetch).submit(REQ), 'INDETERMINATE')
})

test('the guidance on a refusal says whose problem it is', () => {
  // Every 4xx is final for its id, but only some of them are ABOUT the package.
  // A deployment fault refuses EVERY book until somebody fixes it, and each
  // individual refusal looks exactly like a book that had nothing to do — which
  // is why the log line has to say which kind it was.
  for (const status of [401, 403]) {
    assert.match(refusalGuidance(status), /DEPLOYMENT FAULT/)
    assert.match(refusalGuidance(status), /DESK_API_TOKEN/)
  }
  for (const status of [404, 405]) {
    assert.match(refusalGuidance(status), /DEPLOYMENT FAULT/)
    assert.match(refusalGuidance(status), /DESK_API_URL/)
  }
  assert.match(refusalGuidance(429), /rate limited/)
  assert.match(refusalGuidance(429), /cooldown_s/)
  assert.doesNotMatch(refusalGuidance(429), /DEPLOYMENT FAULT/)

  const semantic = refusalGuidance(400)
  assert.match(semantic, /on its merits/)
  assert.match(semantic, /rolled back to the mark/)
  assert.doesNotMatch(semantic, /DEPLOYMENT FAULT/)
  // Anything unforeseen reads as the semantic case rather than as nothing.
  assert.equal(refusalGuidance(418), semantic)
})

test('the arrays come back as arrays, whatever the body said', async () => {
  // `fills`/`skips`/`routeErrors` are walked by the fold. A body missing one is
  // a desk-api that predates the field, not a reason to throw inside the host.
  const f = fakeFetch(() => json(200, { decisionId: REQ.decisionId, replayed: true, status: 'WORKING' }))
  const out = await clientWith(f.fetch).submit(REQ)
  assert.notEqual(out, 'INDETERMINATE')
  if (out === 'INDETERMINATE') return
  assert.deepEqual(out.fills, [])
  assert.deepEqual(out.skips, [])
  assert.deepEqual(out.routeErrors, [])
  assert.equal(out.replayed, true)
})

test('a fill\'s venue fee is read back; a fee that is not a finite positive number is dropped', async () => {
  const f = fakeFetch(() =>
    json(200, {
      ...DONE,
      fills: [
        { instrument: 'P-BTC-76600-041126', side: 'Sell', qty: 0.05, price: 200, fee: 0.4 },
        { instrument: 'C-BTC-76600-041126', side: 'Sell', qty: 0.05, price: 210, fee: 'x' },
        { instrument: 'C-BTC-76800-041126', side: 'Sell', qty: 0.05, price: 150 },
      ],
    }),
  )
  const out = await clientWith(f.fetch).submit(REQ)
  assert.ok(out !== 'INDETERMINATE')
  assert.equal(out.fills[0]?.fee, 0.4)
  assert.equal(out.fills[1] !== undefined && 'fee' in out.fills[1], false)
  assert.equal(out.fills[2] !== undefined && 'fee' in out.fills[2], false)
})
