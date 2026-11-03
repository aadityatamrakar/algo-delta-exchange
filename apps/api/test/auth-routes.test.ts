/**
 * End-to-end auth: a real server, real Mongo, real argon2, real fetch.
 *
 * The policy itself is unit-tested in `packages/auth`. What is left, and what
 * this file covers, is the wire: the exact JSON the dashboard parses, that a
 * failed login never says which half was wrong, that the machine token still
 * works (the running Python desk depends on it), and that a session expires on
 * an injected clock rather than on a stopwatch.
 *
 * The Mongo availability check is INSIDE the test body, not a `skipIf()` at
 * registration time — the latter silently skipped the whole file when the
 * connection was still being established.
 */

import { test, before, after, beforeEach } from 'node:test'
import { skipUnlessMongo } from './require-mongo.ts'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { hashPassword } from '@algomaker/auth'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { createAuthGate, SESSION_COOKIE } from '../src/authsvc.ts'
import { AUTH_COLLECTIONS, AuthStore } from '../src/authstore.ts'
import { authRoutes } from '../src/routes/auth.ts'
import type { AuthGate } from '../src/authgate.ts'
import type { ApiDeps, Route, RouteCtx } from '../src/routes/kit.ts'

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_auth_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
/**
 * Per-process, and every fixture query is scoped to it.
 *
 * Two runs of this file against the same Mongo — which is what `npm test` twice
 * over, or two agents, produces — otherwise share `desk-users`, and one run's
 * `beforeEach` wipe lands in the middle of the other's assertions. Observed:
 * a row written under a clock the other process had advanced by an hour.
 */
const USER = `operator-${process.pid}`
const PASSWORD = 'correct-horse-battery-staple'
const TTL_MS = 60 * 60 * 1000

// argon2id at the default cost is ~30ms per hash and several tests do a handful
// of logins each; the default 30s per-test timeout is not the thing under test.
const SLOW = 60_000

let handle: MongoHandle | null = null
let store: AuthStore
let server: Server | null = null
let base = ''
let available = false
let clock = Date.UTC(2026, 6, 27, 5, 0)
let gate: AuthGate
let passwordHash = ''

/** A protected endpoint, so the gate's behaviour is observable over HTTP. */
const whoami: Route = async (ctx: RouteCtx): Promise<boolean> => {
  if (ctx.path === '/v1/test/whoami') {
    ctx.send(200, { kind: ctx.principal.kind, name: ctx.principal.name })
    return true
  }
  if (ctx.path === '/v1/test/reauth' && ctx.method === 'POST') {
    const body = (await ctx.readJson()) as Record<string, unknown>
    const denied = await gate.reauth(ctx.principal, body['password'])
    ctx.send(denied === null ? 200 : 403, denied === null ? { ok: true } : { error: denied })
    return true
  }
  return false
}

before(async () => {
  process.env['DESK_API_TOKEN'] = TOKEN
  process.env['DESK_SESSION_TTL_MS'] = String(TTL_MS)
  // The gate asserts the master key at construction (spec §7), so the fixture
  // has to supply one exactly as a deployment does.
  process.env['DESK_MASTER_KEY'] = 'a'.repeat(64)
  /**
   * ONLY THE CONNECT IS CAUGHT.
   *
   * `available = false` skips this whole file, and a skipped file reads green.
   * The session indexes are UNIQUE and the gate asserts the master key at
   * construction — exactly the two things this file exists to prove — so
   * catching them here would disable those tests the moment they were violated.
   */
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new AuthStore(handle.db)
  await store.ensureIndexes()
  const apiDeps = {
    db: handle.db,
    log: () => {},
    now: () => clock,
  } as unknown as ApiDeps
  gate = createAuthGate({ ...apiDeps, token: TOKEN })
  server = createBridgeServer({
    gate,
    publicRoutes: [authRoutes(apiDeps)],
    routes: [whoami],
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  passwordHash = await hashPassword(PASSWORD)
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  clock = Date.UTC(2026, 6, 27, 5, 0)
  // Scoped to this process's user, never `deleteMany({})` — see USER above.
  await handle!.db.collection(AUTH_COLLECTIONS.users).deleteMany({ username: USER })
  await handle!.db.collection(AUTH_COLLECTIONS.sessions).deleteMany({ username: USER })
  await handle!.db.collection<Record<string, unknown>>(AUTH_COLLECTIONS.users).insertOne({
    username: USER,
    passwordHash,
    createdAt: clock,
    lastLoginAt: null,
    failedAttempts: 0,
    lastFailureAt: null,
    lockedUntil: null,
  })
})

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, { timeout: SLOW }, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

const login = (username: string, password: string): Promise<Response> =>
  fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

/**
 * Present a credential the way a real client does.
 *
 * A SESSION is a cookie now, not a bearer. The MACHINE token is still a bearer,
 * because the Python desk has no cookie jar — so both headers exist and the
 * tests exercise the same two paths production does.
 *
 * `node:fetch` keeps no cookie jar, which is why the token is threaded through
 * explicitly here. That is a fair model of the browser: what matters is that
 * the value the server SET is the value it later accepts.
 */
const withCookie = (path: string, token: string): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } })

const withToken = (path: string, token: string): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })

/** The session value out of a `Set-Cookie`, or '' when the header is absent. */
function sessionFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = /dx_desk_session=([^;]*)/.exec(raw)
  return m?.[1] === undefined ? '' : decodeURIComponent(m[1])
}

async function loginOk(): Promise<string> {
  const res = await login(USER, PASSWORD)
  assert.equal(res.status, 200)
  const token = sessionFrom(res)
  assert.notEqual(token, '', 'login must set the session cookie')
  return token
}

/**
 * The session is an httpOnly cookie and the body does NOT carry it.
 *
 * Returning the token as well would defeat the cookie entirely: the page would
 * keep a copy in a variable, and any script that can read that variable has the
 * session no matter what `httpOnly` says. Asserting its ABSENCE is the only
 * thing that stops a future change quietly putting it back for convenience.
 */
itMongo('login sets an httpOnly session cookie and returns no token in the body', async () => {
  const res = await login(USER, PASSWORD)
  assert.equal(res.status, 200)
  const cookie = res.headers.get('set-cookie') ?? ''
  assert.match(cookie, /dx_desk_session=/)
  assert.match(cookie, /HttpOnly/i, 'a session a script can read is not protected')
  assert.match(cookie, /SameSite=Strict/i, 'this is what stands in for a CSRF token')

  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body['token'], undefined, 'the token must NOT be in the body')
  assert.equal(body['username'], USER)
  assert.equal(body['expiresAt'], clock + TTL_MS, 'epoch ms, never a string')
  assert.equal(body['passwordHash'], undefined, 'no response may carry the hash')
})

itMongo('a wrong password and an unknown user are indistinguishable', async () => {
  const wrong = await login(USER, 'not-the-password')
  const unknown = await login('nobody-here', 'not-the-password')
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.deepEqual(await wrong.json(), { error: 'invalid credentials' })
  assert.deepEqual(await unknown.json(), { error: 'invalid credentials' })
})

itMongo('the username is case-insensitive, so one operator cannot become two', async () => {
  assert.equal((await login(USER.toUpperCase(), PASSWORD)).status, 200)
  assert.equal((await login(`  ${USER}  `, PASSWORD)).status, 200)
})

itMongo('five failures lock the account, and the lockout is reported with its end', async () => {
  for (let i = 0; i < 4; i++) {
    assert.equal((await login(USER, 'wrong')).status, 401, `attempt ${i + 1} should be a plain 401`)
  }
  const fifth = await login(USER, 'wrong')
  assert.equal(fifth.status, 429)
  const body = (await fifth.json()) as Record<string, unknown>
  assert.equal(typeof body['lockedUntil'], 'number')
  assert.match(String(body['error']), /too many attempts, locked until/)

  // The CORRECT password is refused while the lockout stands — otherwise the
  // lockout would only slow down an attacker who never guesses right.
  const correct = await login(USER, PASSWORD)
  assert.equal(correct.status, 429)

  // ...and it lifts on its own once the window passes.
  clock += 15 * 60 * 1000 + 1
  assert.equal((await login(USER, PASSWORD)).status, 200)
})

itMongo('a successful login clears the failure counter', async () => {
  for (let i = 0; i < 3; i++) await login(USER, 'wrong')
  await loginOk()
  const user = await store.findUser(USER)
  assert.equal(user?.failedAttempts, 0)
  assert.equal(user?.lockedUntil, null)
  assert.equal(user?.lastLoginAt, clock)
})

itMongo('me identifies a session as a user and the env token as a machine', async () => {
  const token = await loginOk()
  const asUser = await withCookie('/v1/auth/me', token)
  assert.equal(asUser.status, 200)
  assert.deepEqual(await asUser.json(), {
    username: USER,
    kind: 'user',
    expiresAt: clock + TTL_MS,
  })

  const asMachine = await withToken('/v1/auth/me', TOKEN)
  assert.equal(asMachine.status, 200)
  const body = (await asMachine.json()) as Record<string, unknown>
  assert.equal(body['kind'], 'machine')
  assert.equal(body['expiresAt'], null, 'a machine has no session to count down')
})

itMongo('me is 401 without a credential even though it is mounted public', async () => {
  assert.equal((await fetch(`${base}/v1/auth/me`)).status, 401)
  assert.equal((await withCookie('/v1/auth/me', 'not-a-real-token')).status, 401)
})

itMongo('logout revokes the session; a second logout is still 200', async () => {
  const token = await loginOk()
  const out = await fetch(`${base}/v1/auth/logout`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  })
  assert.equal(out.status, 200)
  assert.deepEqual(await out.json(), { ok: true })
  assert.equal((await withCookie('/v1/auth/me', token)).status, 401)
  assert.equal((await withCookie('/v1/test/whoami', token)).status, 401)

  const again = await fetch(`${base}/v1/auth/logout`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  })
  assert.equal(again.status, 200, 'logout is idempotent and never a token oracle')
})

/**
 * ONE OPERATOR, SEVERAL PLACES AT ONCE.
 *
 * The same account is expected to be logged in from more than one place —
 * a desk machine and a phone, say — so logging in again must MINT a session,
 * never replace the existing one, and logging out of one place must not sign
 * the operator out everywhere else.
 *
 * The tempting implementation is one session per user, which reads as tidier
 * and silently signs you out of the desk the moment you check the book from
 * your phone. That is a behaviour nobody would report as a bug; they would
 * just quietly stop trusting the portal.
 */
itMongo('several concurrent sessions for one account, and logout ends only its own', async () => {
  const laptop = await loginOk()
  const phone = await loginOk()
  assert.notEqual(laptop, phone, 'each login mints its own token')

  assert.equal((await withCookie('/v1/test/whoami', laptop)).status, 200)
  assert.equal(
    (await withCookie('/v1/test/whoami', phone)).status,
    200,
    'the second login must not have evicted the first',
  )

  await fetch(`${base}/v1/auth/logout`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${phone}` },
  })
  assert.equal((await withCookie('/v1/test/whoami', phone)).status, 401)
  assert.equal(
    (await withCookie('/v1/test/whoami', laptop)).status,
    200,
    'signing out on one device must not sign the operator out on the others',
  )
})

itMongo('a session expires on the injected clock, and the row is deleted', async () => {
  const token = await loginOk()
  assert.equal((await withCookie('/v1/test/whoami', token)).status, 200)

  // AT the expiry instant, not one millisecond later.
  clock += TTL_MS
  assert.equal((await withCookie('/v1/test/whoami', token)).status, 401)
  assert.equal(await store.findSession(token), null, 'an expired session is deleted on sight')
})

itMongo('THE FALLBACK: the machine bearer token still reaches protected routes', async () => {
  const res = await withToken('/v1/test/whoami', TOKEN)
  assert.equal(res.status, 200, 'the running Python desk holds this token and cannot log in')
  assert.deepEqual(await res.json(), { kind: 'machine', name: 'bearer' })
})

itMongo('a session principal is a user, named for the account', async () => {
  const res = await withCookie('/v1/test/whoami', await loginOk())
  assert.deepEqual(await res.json(), { kind: 'user', name: USER })
})

itMongo('no credential at all is a 401 from the gate', async () => {
  assert.equal((await fetch(`${base}/v1/test/whoami`)).status, 401)
})

itMongo('reauth accepts the operator password and refuses a wrong one', async () => {
  const token = await loginOk()
  const ok = await fetch(`${base}/v1/test/reauth`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  assert.equal(ok.status, 200)

  const bad = await fetch(`${base}/v1/test/reauth`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  })
  assert.equal(bad.status, 403)
  assert.match(String(((await bad.json()) as Record<string, unknown>)['error']), /password is incorrect/)

  const missing = await fetch(`${base}/v1/test/reauth`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(missing.status, 403)
})

itMongo('reauth ALWAYS refuses a machine principal', async () => {
  const res = await fetch(`${base}/v1/test/reauth`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    // Even holding the operator's real password, a machine cannot re-authenticate.
    body: JSON.stringify({ password: PASSWORD }),
  })
  assert.equal(res.status, 403)
  assert.match(
    String(((await res.json()) as Record<string, unknown>)['error']),
    /machine token cannot perform it/,
  )
})

itMongo('a failed reauth counts against the same lockout as login', async () => {
  const token = await loginOk()
  for (let i = 0; i < 5; i++) {
    await fetch(`${base}/v1/test/reauth`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
  }
  // Otherwise the re-auth prompt is an unlimited password oracle for anyone who
  // has stolen a session token but not the password.
  assert.equal((await login(USER, PASSWORD)).status, 429)
})

itMongo('a successful reauth clears the failure counter but does not restamp the login', async () => {
  const token = await loginOk()
  const loginAt = (await store.findUser(USER))?.lastLoginAt
  clock += 60_000
  await fetch(`${base}/v1/test/reauth`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  })
  await fetch(`${base}/v1/test/reauth`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  const user = await store.findUser(USER)
  assert.equal(user?.failedAttempts, 0)
  assert.equal(user?.lastLoginAt, loginAt, 'reauth is not a login')
})

itMongo('login rejects a missing or non-string field with a 400, not a 401', async () => {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER }),
  })
  assert.equal(res.status, 400)
})

itMongo('a password reset revokes every live session', async () => {
  // TWO sessions, because one operator is normally signed in from more than one
  // place. A reset that ended only the session that requested it would leave the
  // leaked password's other sessions running — which is the whole thing a reset
  // is for.
  const laptop = await loginOk()
  const phone = await loginOk()
  assert.equal((await withCookie('/v1/test/whoami', laptop)).status, 200)
  assert.equal((await withCookie('/v1/test/whoami', phone)).status, 200)
  await store.setPassword(USER, await hashPassword('a-completely-new-password'), clock)
  assert.equal(
    (await withCookie('/v1/test/whoami', laptop)).status,
    401,
    'a reset usually means the old password leaked',
  )
  assert.equal((await withCookie('/v1/test/whoami', phone)).status, 401, 'every session, everywhere')
  assert.equal((await login(USER, PASSWORD)).status, 401)
  assert.equal((await login(USER, 'a-completely-new-password')).status, 200)
})

itMongo('a duplicate username is refused by the unique index, not by a read', async () => {
  await assert.rejects(() => store.createUser(USER, passwordHash, clock), /already exists/)
})

itMongo('"anonymous" cannot be an account name', async () => {
  // `server.ts` names the pre-authentication principal `anonymous`; an account
  // by that name would make an operator indistinguishable from no credential.
  await assert.rejects(() => store.createUser('anonymous', passwordHash, clock), /reserved/)
})

itMongo('purgeExpired removes only sessions that are past their expiry', async () => {
  const live = await loginOk()
  clock += TTL_MS + 1
  const fresh = await loginOk()
  // Asserted per token rather than on the count: the sweep is collection-wide
  // and a concurrent run's rows are not this test's business.
  assert.ok((await store.purgeExpired(clock)) >= 1)
  assert.equal(await store.findSession(live), null)
  assert.notEqual(await store.findSession(fresh), null)
})
