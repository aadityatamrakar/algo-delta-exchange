/**
 * The two things that face the world before anything is authenticated: the
 * unauthenticated `/v1/desk/feed` surface, and what `main()` refuses to boot
 * without.
 *
 * Both are audit findings with the same shape — a claim in a comment that the
 * code did not keep.
 *
 *   A5. `routes/health.ts`'s header promises the response "carries no position
 *       or price detail, only counts and a boolean", and it returned every book
 *       BY SYMBOL with its leg count, to anyone who could reach the port. It
 *       also ran a full greeks computation per book on every request, unrated,
 *       and reported `ready: false` forever on a desk that holds no book —
 *       while `docs/DEPLOYMENT.md` §9 tells the operator to poll exactly that
 *       field to decide the system came up.
 *   A6. `authsvc.ts` claims `DESK_MASTER_KEY` "fails at BOOT". On the bridge's
 *       real boot path it was reached only after Mongo, the instrument master,
 *       the bus and the registry seed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { healthRoutes } from '../src/routes/health.ts'
import { requireBootEnv } from '../src/main.ts'
import type { ApiDeps, RouteCtx } from '../src/routes/kit.ts'
import type { BridgeService } from '../src/service.ts'
import type { QuoteCache } from '../src/marks.ts'

// ------------------------------------------------------------------ harness

type Book = Awaited<ReturnType<BridgeService['books']>>[number]

interface FeedHarness {
  deps: ApiDeps
  /**
   * The route, built ONCE — as `main.ts` builds it once. The books cache lives
   * in the factory's closure, so re-invoking the factory per request would
   * hand every call a fresh cache and quietly un-test the thing being tested.
   */
  route: ReturnType<typeof healthRoutes>
  /** How many times the greeks-computing `books()` was actually called. */
  calls: () => number
  setNow: (ms: number) => void
}

function harness(books: Book[], feedAlive = true): FeedHarness {
  let calls = 0
  let now = 1_000_000
  const service = {
    books: async (): Promise<Book[]> => {
      calls++
      return books
    },
  } as unknown as BridgeService
  const marks = {
    size: 42,
    cachedCount: 7,
    feedAlive: () => feedAlive,
    staleCount: () => 0,
    ageOfNewestTick: () => 500,
  } as unknown as QuoteCache
  const deps: ApiDeps = {
    db: null as unknown as ApiDeps['db'],
    store: null as unknown as ApiDeps['store'],
    service,
    master: null as unknown as ApiDeps['master'],
    marks,
    feedState: { subscribedTokens: 72 },
    log: () => {},
    now: () => now,
  }
  return {
    deps,
    route: healthRoutes(deps),
    calls: () => calls,
    setNow: (ms) => {
      now = ms
    },
  }
}

async function get(
  h: FeedHarness,
  path: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`http://desk${path}`)
  const out = { status: 0, body: {} as Record<string, unknown> }
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method: 'GET',
    principal: { kind: 'user', name: 'anonymous' },
    log: () => {},
    readJson: async () => ({}),
    send: (status, body) => {
      out.status = status
      out.body = body as Record<string, unknown>
    },
  }
  assert.equal(await h.route(ctx), true, `${path} was not handled`)
  return out
}

const book = (symbol: string, legs: number, complete: boolean): Book => ({
  tag: symbol,
  symbol,
  expiry: '',
  legs,
  netDelta: complete ? -900 : null,
  complete,
  updatedAt: 1,
})

// --------------------------------------------------------------- A5: the leak

test('the unauthenticated feed names NO book — counts only', async () => {
  const h = harness([book('BHEL', 8, true), book('KALYANKJIL', 2, true)])
  const res = await get(h, '/v1/desk/feed')
  assert.equal(res.status, 200)

  /**
   * Asserted on the RAW TEXT rather than on named fields, exactly as
   * `brokers.test.ts` asserts about secrets: a symbol nested in a field added
   * later is still a leaked position. What the desk is positioned in is the
   * single most valuable thing this API knows.
   */
  const text = JSON.stringify(res.body)
  assert.ok(!text.includes('BHEL'), `the feed leaked a book symbol: ${text}`)
  assert.ok(!text.includes('KALYANKJIL'), `the feed leaked a book symbol: ${text}`)

  // The counts that actually answer the readiness question are still there.
  assert.equal(res.body['bookCount'], 2)
  assert.equal(res.body['booksIncomplete'], 0)
  assert.equal(res.body['marksHeld'], 42)
  assert.equal(res.body['subscribedTokens'], 72)
  assert.equal(res.body['coverage'], 0.583)
  /**
   * The old key is GONE rather than redefined as a number: a client still
   * reading `books` gets `undefined`, which its own `?? []` renders as an empty
   * list. Reusing the key for a scalar would hand `.map` a number and crash a
   * page that was merely out of date.
   */
  assert.equal(res.body['books'], undefined)
})

// -------------------------------------------------------- A5: ready semantics

test('a healthy feed with NO book is READY — not unready forever', async () => {
  /**
   * `ready` was `books.length > 0 && every(complete)`. On the first paper day,
   * before the desk has opened anything, that is FALSE beside a perfectly
   * healthy feed — and it never becomes true, so the smoke test
   * `docs/DEPLOYMENT.md` §9 documents could not pass on a fresh deployment.
   *
   * Readiness asks "can the desk act on what it holds?". Holding nothing
   * answers that vacuously yes: there is no leg whose mark is missing.
   */
  const h = harness([])
  const res = await get(h, '/v1/desk/feed')
  assert.equal(res.body['bookCount'], 0)
  assert.equal(res.body['ready'], true)
})

test('a book with an unmarked leg is NOT ready, and the count says how many', async () => {
  const h = harness([book('BHEL', 8, false), book('KALYANKJIL', 2, true)])
  const res = await get(h, '/v1/desk/feed')
  assert.equal(res.body['booksIncomplete'], 1)
  assert.equal(
    res.body['ready'],
    false,
    'an action on the unmarked leg would be skipped as "no mark"'
  )
})

test('a DEAD feed is never ready, whatever the books say', async () => {
  const h = harness([], false)
  const res = await get(h, '/v1/desk/feed')
  assert.equal(res.body['feedAlive'], false)
  assert.equal(res.body['ready'], false, 'a dead feed refuses every order')
})

// ------------------------------------------------- was the market even open?

/** Tue 2026-07-28, 11:00 IST. */
const IN_SESSION = new Date('2026-07-28T11:00:00+05:30').getTime()
/** Sat 2026-08-01, 11:00 IST — session hours, but a weekend. */
const WEEKEND = new Date('2026-08-01T11:00:00+05:30').getTime()

test('the feed states whether the market was open when it answered', async () => {
  /**
   * PRESENTATION ONLY. A silent feed at 11:00 on a Saturday is not a fault, and
   * the page that renders this had no way to know that — so it said "Feed is
   * down" in red every weekend, which is how an operator learns to ignore it.
   */
  const h = harness([], false)
  h.setNow(WEEKEND)
  const shut = await get(h, '/v1/desk/feed')
  assert.equal(shut.body['sessionOpen'], false)

  h.setNow(IN_SESSION)
  const open = await get(h, '/v1/desk/feed')
  assert.equal(open.body['sessionOpen'], true)
})

test('`ready` IS NOT SOFTENED by a closed market — it is the smoke test', async () => {
  /**
   * `docs/DEPLOYMENT.md` §9 polls `ready` to decide the system came up. A
   * closed market must never make a dead feed answer "yes" there: the deploy
   * check would pass on a bridge that cannot price anything.
   */
  const h = harness([], false)
  h.setNow(WEEKEND)
  const res = await get(h, '/v1/desk/feed')
  assert.equal(res.body['feedAlive'], false, 'the measured value, unchanged')
  assert.equal(res.body['ready'], false, 'a dead feed is never ready, weekend or not')
})

// ------------------------------------------------------- A5: the compute cost

test('the greeks computation is not repeated per unauthenticated request', async () => {
  /**
   * `service.books()` runs Black-Scholes per leg per book. This endpoint takes
   * no token and has no rate limit, so recomputing per request means anyone who
   * can reach the port can pin a core. Readiness is a 60-90 second warm-up
   * question; answering it from a value a few seconds old costs nothing real.
   */
  const h = harness([book('BHEL', 8, true)])
  await Promise.all([get(h, '/v1/desk/feed'), get(h, '/v1/desk/feed'), get(h, '/v1/desk/feed')])
  await get(h, '/v1/desk/feed')
  assert.equal(h.calls(), 1, 'a burst of callers shares ONE computation')

  // ...and it is a cache, not a freeze: past the window it recomputes, or a
  // book that warmed up would be reported cold forever.
  h.setNow(1_000_000 + 60_000)
  await get(h, '/v1/desk/feed')
  assert.equal(h.calls(), 2)
})

test('/health needs no token and says nothing else', async () => {
  const h = harness([book('BHEL', 8, true)])
  const res = await get(h, '/health')
  assert.deepEqual(res.body, { ok: true })
  assert.equal(h.calls(), 0, 'liveness must not cost a greeks computation')
})

// ------------------------------------------------------------- A6: boot env

test('DESK_MASTER_KEY is required at BOOT, before any IO', () => {
  const base = {
    DESK_MONGO_URL: 'mongodb://127.0.0.1:27017/x',
    DESK_API_TOKEN: 'token',
    DESK_MASTER_KEY: 'a'.repeat(64),
  }
  // The happy path first, so the assertions below are about the key and not
  // about the fixture being wrong.
  assert.deepEqual(requireBootEnv(base), {
    mongoUrl: base.DESK_MONGO_URL,
    token: base.DESK_API_TOKEN,
  })

  const { DESK_MASTER_KEY: _absent, ...noKey } = base
  assert.throws(
    () => requireBootEnv(noKey),
    /DESK_MASTER_KEY is required/,
    'a bridge that cannot open its broker credentials must not come up at all'
  )
  assert.throws(
    () => requireBootEnv({ ...base, DESK_MASTER_KEY: '   ' }),
    /DESK_MASTER_KEY is required/
  )
  assert.throws(
    () => requireBootEnv({ ...base, DESK_MASTER_KEY: 'not-a-hex-key' }),
    /DESK_MASTER_KEY is malformed/,
    'a typo must fail here, not hours later as an inexplicable broker login failure'
  )
})

test('the other two boot secrets are still required, and named', () => {
  const base = {
    DESK_MONGO_URL: 'mongodb://127.0.0.1:27017/x',
    DESK_API_TOKEN: 'token',
    DESK_MASTER_KEY: 'a'.repeat(64),
  }
  const { DESK_MONGO_URL: _u, ...noUrl } = base
  const { DESK_API_TOKEN: _t, ...noToken } = base
  assert.throws(() => requireBootEnv(noUrl), /DESK_MONGO_URL is required/)
  assert.throws(() => requireBootEnv(noToken), /DESK_API_TOKEN is required/)
})

test('on DX the feed reports sessionOpen true on a Saturday', async () => {
  const { DX } = await import('@algomaker/venue')
  const h = harness([])
  h.setNow(Date.parse('2026-11-07T11:00:00Z'))
  const res = await get({ ...h, route: healthRoutes({ ...h.deps, venue: DX }) }, '/v1/desk/feed')
  assert.equal(res.body['sessionOpen'], true)
  const nse = await get(h, '/v1/desk/feed')
  assert.equal(nse.body['sessionOpen'], false)
})
