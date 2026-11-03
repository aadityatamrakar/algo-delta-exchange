/**
 * Session-backed authentication, layered over the machine bearer token.
 *
 * THE FALLBACK IS LOAD-BEARING. `authenticate` tries the session store first and
 * the env bearer token second, so the Python desk — which is running today, and
 * holds a token, and has no way to log in — keeps working unchanged the moment
 * user accounts appear. Removing it turns every decision the desk POSTs into a
 * 401 with nothing in our logs to say why.
 *
 * The two kinds stay distinct all the way through (see `authgate.ts`): a session
 * yields a `user`, the env token yields a `machine`, and `reauth` refuses the
 * second unconditionally. An automated client must not be able to turn live
 * trading on by itself.
 */

import type { IncomingMessage } from 'node:http'
import { DEFAULT_LOCKOUT_POLICY, DEFAULT_SESSION_TTL_MS, isExpired, verifyPassword, type LockoutPolicy } from '@algomaker/auth'
import { bearerMatches, type AuthGate, type AuthGateFactory } from './authgate.ts'
import { AuthStore } from './authstore.ts'
import { requireMasterKey } from './brokerstore.ts'
import type { Principal } from './routes/kit.ts'

export interface AuthConfig {
  readonly sessionTtlMs: number
  readonly lockout: LockoutPolicy
}

/**
 * Session length and lockout policy, overridable per deployment.
 *
 * A non-numeric or non-positive override falls back to the default rather than
 * throwing: a typo'd `DESK_SESSION_TTL_MS` must not be the thing that stops the
 * bridge booting, and `mintSession` would throw on a zero TTL anyway — at login
 * time, per request, which is a far worse place to discover it.
 */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const ttl = Number(env['DESK_SESSION_TTL_MS'] ?? NaN)
  const maxFailures = Number(env['DESK_LOGIN_MAX_FAILURES'] ?? NaN)
  const lockoutMs = Number(env['DESK_LOGIN_LOCKOUT_MS'] ?? NaN)
  return {
    sessionTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_MS,
    lockout: {
      maxFailures:
        Number.isInteger(maxFailures) && maxFailures > 0 ? maxFailures : DEFAULT_LOCKOUT_POLICY.maxFailures,
      lockoutMs: Number.isFinite(lockoutMs) && lockoutMs > 0 ? lockoutMs : DEFAULT_LOCKOUT_POLICY.lockoutMs,
    },
  }
}

/**
 * The machine token, read from the environment.
 *
 * `main.ts` already requires it and passes it into this factory, so this is only
 * for the PUBLIC route module (`routes/auth.ts`), which is constructed from
 * `ApiDeps` alone and has nothing to pass a token through. Same variable, same
 * value, one place that names it.
 */
export function machineTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['DESK_API_TOKEN'] ?? ''
}

/** The bearer credential a request presents, or '' when it presents none. */
export function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  const prefix = 'Bearer '
  return header.startsWith(prefix) ? header.slice(prefix.length) : ''
}

/**
 * The session cookie name.
 *
 * THE DASHBOARD AUTHENTICATES BY COOKIE, not by a token the page can read.
 *
 * The token used to live in a JavaScript variable, which kept it away from any
 * script on the page but died with the page — so every refresh signed the
 * operator out. An `httpOnly` cookie is strictly better on BOTH counts: it
 * survives the reload AND JavaScript cannot read it at all, so an injected
 * script cannot exfiltrate it even though it can still make requests.
 *
 * `SameSite=Strict` is what stands in for a CSRF token: the browser will not
 * attach this cookie to a request originating from any other site, so a page
 * the operator has open elsewhere cannot drive this API. That is also why the
 * CORS origin allowlist in `server.ts` must stay explicit — a wildcard origin
 * is not even permitted alongside credentials, and for good reason.
 *
 * `dx_`-prefixed in the Delta clone: cookies are not port-scoped, so the live
 * NSE desk's `desk_session` and this one, served from the same host on other
 * ports, would otherwise overwrite each other and sign the operator out of one
 * desk on every login to the other.
 */
export const SESSION_COOKIE = 'dx_desk_session'

/**
 * One cookie's value from the request, or '' when absent or AMBIGUOUS.
 *
 * TWO PRESENT VALUES IS A REFUSAL, not a pick. RFC 6265 orders cookies by path
 * length, so an attacker who can set a cookie on the registrable domain — a
 * sibling subdomain, or XSS anywhere else on it — can send
 * `dx_desk_session=<theirs>; Domain=example.com; Path=/v1`, which is a DIFFERENT
 * cookie from ours and therefore does not get overwritten by login. Taking the
 * first match hands them a session that survives the operator authenticating:
 * login succeeds, and every request afterwards runs as them.
 *
 * Refusing both is safe in the only direction that matters — the operator logs
 * in again and the fresh `Path=/` cookie is then unambiguous only once the
 * shadow expires, which is visible rather than silent.
 */
export function cookieOf(req: IncomingMessage, name: string): string {
  const header = req.headers.cookie
  if (typeof header !== 'string') return ''
  let found: string | null = null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    if (found !== null) return ''
    try {
      found = decodeURIComponent(part.slice(eq + 1).trim())
      continue
    } catch {
      // `decodeURIComponent('%')` THROWS. Uncaught, that propagates out of
      // `gate.authenticate` and 500s every authenticated endpoint — including
      // `/v1/auth/logout`, so an operator sent a malformed cookie could not
      // clear it from the UI (it is httpOnly). A credential we cannot parse is
      // simply not a credential.
      return ''
    }
  }
  return found ?? ''
}

/**
 * The credential a request presents, cookie first.
 *
 * Cookie before header so a browser that still has a stale `Authorization` from
 * an older build cannot pin an expired session in place.
 */
export function credentialOf(req: IncomingMessage): string {
  const cookie = cookieOf(req, SESSION_COOKIE)
  return cookie !== '' ? cookie : bearerOf(req)
}

/**
 * `Set-Cookie` for a freshly minted session.
 *
 * `Secure` is set only when the request actually arrived over TLS. Chrome
 * treats `http://localhost` as a secure context and would accept it anyway, but
 * Safari does not — and a `Secure` cookie silently dropped over plain http is a
 * login that appears to succeed and then behaves as though it never happened.
 */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Expiring the cookie must repeat every attribute, or the browser keeps the original. */
export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Whether the request reached us over TLS, honouring a terminating proxy. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  if (typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https') return true
  return (req.socket as { encrypted?: boolean }).encrypted === true
}

export const createAuthGate: AuthGateFactory = (deps): AuthGate => {
  const store = new AuthStore(deps.db)
  const config = authConfigFromEnv()

  // Spec §7: a missing or malformed DESK_MASTER_KEY fails at BOOT. This factory
  // is the earliest thing `main.ts` calls that belongs to Phase A, and it throws
  // out of `main()` before the server listens. Checking here rather than only in
  // `brokerRoutes` means the process cannot come up half-configured, serving
  // logins while every broker credential is unreadable.
  requireMasterKey()

  // Fire-and-forget: the indexes are correctness for CONCURRENT writes, and the
  // factory is synchronous by contract. A failure is logged rather than thrown
  // because an index that already exists is the normal case and a transient
  // Mongo blip here should not prevent the bridge from serving.
  void store.ensureIndexes().catch((err: unknown) => {
    deps.log('auth index creation failed', { error: err instanceof Error ? err.message : String(err) })
  })
  void store.purgeExpired(deps.now()).catch(() => {})

  return {
    async authenticate(req: IncomingMessage): Promise<Principal | null> {
      const presented = credentialOf(req)
      if (presented === '') return null
      const now = deps.now()

      const session = await store.findSession(presented)
      if (session !== null) {
        if (isExpired(session, now)) {
          // Deleted on sight rather than left for the sweep: the token has just
          // been proven to be in someone's hands, and a row that lingers is a
          // row a clock change could bring back to life.
          await store.revokeSession(presented)
          return null
        }
        await store.touchSession(session, now)
        void store.purgeExpiredIfDue(now)
        return { kind: 'user', name: session.username }
      }

      // THE FALLBACK. See the file header — the Python desk depends on it.
      if (bearerMatches(req, deps.token)) return { kind: 'machine', name: 'bearer' }
      return null
    },

    async reauth(principal: Principal, password: unknown): Promise<string | null> {
      if (principal.kind !== 'user') {
        return 'this action requires an operator password; a machine token cannot perform it'
      }
      if (typeof password !== 'string' || password === '') {
        return 'password is required to confirm this action'
      }
      const user = await store.findUser(principal.name)
      if (user === null) {
        // Reachable when the account was deleted while its session was live.
        return 'this action requires an operator password; this session has no account'
      }
      const now = deps.now()
      if (store.isLockedOut(user, now)) {
        return `too many failed attempts, locked until ${new Date(user.lockedUntil ?? now).toISOString()}`
      }
      if (!(await verifyPassword(password, user.passwordHash))) {
        // Counted against the SAME lockout as login. Otherwise the re-auth
        // prompt would be an unlimited password oracle for anyone who has
        // stolen a session token but not the password.
        const state = await store.recordLoginFailure(user.username, now, config.lockout)
        return state.lockedUntil !== null
          ? `password is incorrect — too many failed attempts, locked until ${new Date(state.lockedUntil).toISOString()}`
          : 'password is incorrect'
      }
      await store.clearLoginFailures(user.username)
      return null
    },
  }
}
