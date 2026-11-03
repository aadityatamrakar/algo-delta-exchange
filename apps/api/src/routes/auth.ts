/**
 * Login, logout, whoami.
 *
 * Mounted PUBLIC, because login cannot require the thing it issues. "Public"
 * here means only that `server.ts` does not reject the request before it reaches
 * these handlers — `me` still authenticates itself and still 401s without a
 * valid session. The alternative, mounting `me` behind the gate, would make a
 * 401 from it indistinguishable from the gate refusing the request, which is the
 * exact signal the dashboard's auth gate keys off.
 */

import { randomBytes } from 'node:crypto'
import { hashPassword, isExpired, mintSession, verifyPassword } from '@algomaker/auth'
import { bearerMatches } from '../authgate.ts'
import {
  authConfigFromEnv,
  clearedSessionCookie,
  credentialOf,
  isSecureRequest,
  machineTokenFromEnv,
  sessionCookie,
} from '../authsvc.ts'
import { AuthStore } from '../authstore.ts'
import { isObject, type ApiDeps, type Route, type RouteCtx } from './kit.ts'

/**
 * A throwaway hash, verified against when the username does not exist.
 *
 * Without it a login for an unknown user returns in microseconds while one for a
 * real user takes ~30ms of argon2 — which tells an attacker exactly which
 * usernames exist, defeating the identical response body. Computed once, lazily,
 * so a deployment that never sees a bad username never pays for it.
 */
let decoyHash: Promise<string> | null = null
const decoy = (): Promise<string> => (decoyHash ??= hashPassword(randomBytes(24).toString('hex')))

/**
 * Serialise login attempts for one username.
 *
 * The lockout counter is atomic (`authstore.recordLoginFailure`), but the
 * CHECK still happens before the write. Without this, 200 requests fired
 * together all read `failedAttempts: 0`, all pass the lockout gate, and all get
 * a verdict — the counter is correct afterwards but the burst already had 200
 * guesses. Serialising per username means attempt N+1 sees attempt N's result,
 * which is what "five attempts" is supposed to mean.
 *
 * Per PROCESS, not per cluster. One bridge process is what runs today; a second
 * one would need this in Mongo, and that is a deliberate follow-up rather than
 * something to pretend is already true.
 */
const loginChains = new Map<string, Promise<unknown>>()

function serialiseByUser<T>(username: string, fn: () => Promise<T>): Promise<T> {
  const prior = loginChains.get(username) ?? Promise.resolve()
  const next = prior.then(fn, fn)
  // Keep the map from growing without bound: drop the entry once this is the
  // last attempt in flight for the name.
  loginChains.set(
    username,
    next.then(
      () => {
        if (loginChains.get(username) === next) loginChains.delete(username)
      },
      () => {
        if (loginChains.get(username) === next) loginChains.delete(username)
      },
    ),
  )
  return next
}

/**
 * Cap on argon2 hashes running at once, across ALL usernames.
 *
 * Every login — including one for an account that does not exist, which pays
 * the decoy hash — costs 19 MiB and two passes on the libuv threadpool. That
 * pool is shared with `fs` and DNS, so an unauthenticated flood of logins for
 * random usernames degrades the whole bridge, not merely this endpoint, on a
 * process that is routing real orders. Excess attempts are refused cheaply
 * rather than queued, so the refusal itself cannot be used to build a backlog.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? NaN)
  // A typo — `four`, or a stray space — yields NaN, and `n >= NaN` is ALWAYS
  // false, so the cap would never fire and the unauthenticated argon2 flood
  // would be silently restored. Every other env read in this codebase guards
  // this; this one did not.
  return Number.isInteger(raw) && raw > 0 ? raw : fallback
}

const MAX_CONCURRENT_LOGINS = positiveIntFromEnv('DESK_LOGIN_MAX_CONCURRENT', 4)
let loginsInFlight = 0

export function authRoutes(deps: ApiDeps): Route {
  const store = new AuthStore(deps.db)
  const config = authConfigFromEnv()
  // Read from the environment rather than plumbed in: this module is built from
  // `ApiDeps` alone, which carries no token. See `machineTokenFromEnv`.
  const machineToken = machineTokenFromEnv()

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, send } = ctx

    if (path === '/v1/auth/login' && method === 'POST') {
      const body = await ctx.readJson()
      const username = isObject(body) ? body['username'] : undefined
      const password = isObject(body) ? body['password'] : undefined
      if (typeof username !== 'string' || typeof password !== 'string' || password === '') {
        send(400, { error: 'username and password are required' })
        return true
      }

      if (loginsInFlight >= MAX_CONCURRENT_LOGINS) {
        // 503 with Retry-After, not 429: this is the SERVER being saturated,
        // not this caller being throttled, and a real operator caught behind a
        // flood should be told to try again rather than told they misbehaved.
        send(503, { error: 'too many logins in progress, try again shortly' })
        return true
      }
      loginsInFlight++
      try {
        await serialiseByUser(username.trim().toLowerCase(), () =>
          attemptLogin(username, password),
        )
      } finally {
        loginsInFlight--
      }
      return true
    }

    /** One login attempt. Runs serialised per username; see `serialiseByUser`. */
    async function attemptLogin(username: string, password: string): Promise<void> {
      const now = deps.now()
      const user = await store.findUser(username)
      if (user === null) {
        // Same body, same status, same latency as a wrong password. An attacker
        // must not learn that an account exists by probing.
        await verifyPassword(password, await decoy())
        ctx.log('login failed', { username: String(username).slice(0, 64), reason: 'no such user' })
        send(401, { error: 'invalid credentials' })
        return
      }

      if (store.isLockedOut(user, now)) {
        const lockedUntil = user.lockedUntil ?? now
        send(429, {
          error: `too many attempts, locked until ${new Date(lockedUntil).toISOString()}`,
          lockedUntil,
        })
        return
      }

      if (!(await verifyPassword(password, user.passwordHash))) {
        const state = await store.recordLoginFailure(user.username, now, config.lockout)
        ctx.log('login failed', { username: user.username, failedAttempts: state.failedAttempts })
        if (state.lockedUntil !== null) {
          send(429, {
            error: `too many attempts, locked until ${new Date(state.lockedUntil).toISOString()}`,
            lockedUntil: state.lockedUntil,
          })
          return
        }
        send(401, { error: 'invalid credentials' })
        return
      }

      const session = mintSession(user.username, now, config.sessionTtlMs)
      await store.saveSession(session, now)
      await store.recordLoginSuccess(user.username, now)
      ctx.log('login ok', { username: user.username, expiresAt: session.expiresAt })
      /**
       * The session goes back as an httpOnly cookie, and the body no longer
       * carries the token.
       *
       * Returning it as well would defeat the point: the page would hold a copy
       * in a variable, and a script that can read that variable has the session
       * whatever the cookie says. The dashboard does not need it — the browser
       * attaches the cookie automatically on every same-site request.
       */
      ctx.res.setHeader(
        'set-cookie',
        sessionCookie(session.token, config.sessionTtlMs, isSecureRequest(ctx.req)),
      )
      send(200, { username: session.username, expiresAt: session.expiresAt })
      return
    }

    if (path === '/v1/auth/logout' && method === 'POST') {
      // Always 200, even when the token is unknown or already expired. Logout is
      // idempotent by nature, and telling a caller that its token was not a real
      // session is a token-probing oracle for no operational benefit.
      await store.revokeSession(credentialOf(ctx.req))
      // Cleared even when the token was unknown: a cookie left in place after a
      // logout is the failure the operator is explicitly trying to avoid.
      ctx.res.setHeader('set-cookie', clearedSessionCookie(isSecureRequest(ctx.req)))
      send(200, { ok: true })
      return true
    }

    if (path === '/v1/auth/me' && method === 'GET') {
      const presented = credentialOf(ctx.req)
      if (presented === '') {
        send(401, { error: 'unauthorised' })
        return true
      }
      const now = deps.now()
      const session = await store.findSession(presented)
      if (session !== null && !isExpired(session, now)) {
        send(200, { username: session.username, kind: 'user', expiresAt: session.expiresAt })
        return true
      }
      // The machine token answers `me` too, so a Python client can verify its
      // credential without placing an order to find out. `expiresAt` is null
      // because it has no session: there is nothing for the UI to count down.
      // `bearerMatches`, not `===`: the comparison is constant-time, so this
      // endpoint cannot be used to recover the machine token a byte at a time.
      if (bearerMatches(ctx.req, machineToken)) {
        send(200, { username: 'bearer', kind: 'machine', expiresAt: null })
        return true
      }
      send(401, { error: 'unauthorised' })
      return true
    }

    return false
  }
}
