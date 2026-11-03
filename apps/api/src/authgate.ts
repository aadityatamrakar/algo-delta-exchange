/**
 * Who is allowed to talk to this API, and what a dangerous action costs.
 *
 * TWO KINDS OF CALLER, deliberately not unified:
 *
 *  - `machine` — a bearer token from the environment. The Python desk and our
 *    own pm2 processes. It is not a person, so it has no session to expire and
 *    no password to re-enter.
 *  - `user` — an operator with a session minted by `POST /v1/auth/login`.
 *
 * The legacy system had exactly one of these and used it for both, which is how
 * a machine client ended up carrying a human's superadmin cookie. Keeping the
 * kinds distinct is what lets `reauth` mean something: you cannot ask a
 * background process for its password.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { ApiDeps, Principal } from './routes/kit.ts'

export type { Principal }

export interface AuthGate {
  /** The caller, or null when the request carries no valid credential. */
  authenticate(req: IncomingMessage): Promise<Principal | null>
  /**
   * Confirm a person is still at the keyboard before something irreversible.
   *
   * Returns null when re-authentication passed, or a reason when it did not.
   * Spec §5: enabling a live tag and releasing the kill switch both require it,
   * because password-only auth (A2) means one leaked password is otherwise full
   * control of a live trading account.
   *
   * A `machine` principal CANNOT satisfy this. That is the point — an automated
   * client must not be able to turn live trading on by itself.
   */
  reauth(principal: Principal, password: unknown): Promise<string | null>
}

/**
 * Bearer-token-only gate. The pre-login behaviour, kept as the fallback so the
 * bridge still serves its machine clients if no user has been created yet.
 */
export function bearerGate(token: string): AuthGate {
  return {
    authenticate: async (req) =>
      bearerMatches(req, token) ? { kind: 'machine', name: 'bearer' } : null,
    reauth: async () =>
      'this deployment has no user accounts, so re-authentication cannot be performed',
  }
}

/** Constant-time, so the token cannot be recovered by timing the comparison. */
export function bearerMatches(req: IncomingMessage, expected: string): boolean {
  if (expected === '') return false
  const header = req.headers.authorization ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const given = Buffer.from(header.slice(prefix.length))
  const want = Buffer.from(expected)
  if (given.length !== want.length) return false
  return timingSafeEqual(given, want)
}

/**
 * Built in `main.ts` and replaced by the session-backed implementation once the
 * user store exists. Signature is fixed so `server.ts` never changes again.
 */
export type AuthGateFactory = (deps: ApiDeps & { readonly token: string }) => AuthGate
