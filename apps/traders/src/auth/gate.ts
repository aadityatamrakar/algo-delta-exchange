/**
 * The request gate: turns a request into a `Principal`, or null.
 *
 * Session cookie first; a dead cookie is a refusal, it does not fall through to
 * a bearer. Otherwise a watcher bearer token. A disabled account is no
 * principal on either path, so disabling a trader kills their sessions and
 * their watcher at once.
 */

import type { IncomingMessage } from 'node:http'
import { isExpired } from '@algomaker/auth'
import type { Principal, TraderUser } from '../types.ts'
import type { TradersGate } from '../routes/kit.ts'
import { bearerOf, cookieOf, SESSION_COOKIE } from './cookies.ts'
import type { SessionStore } from './sessions.ts'
import type { WatcherTokens } from './tokens.ts'
import type { TraderStore } from './users.ts'

/** The live user behind a session token; deletes an expired row. Shared with `auth/me`. */
export async function userOfSession(
  d: { users: TraderStore; sessions: SessionStore }, token: string, nowMs: number,
): Promise<TraderUser | null> {
  const s = await d.sessions.find(token)
  if (s === null) return null
  if (isExpired(s, nowMs)) {
    await d.sessions.revoke(token)
    return null
  }
  const user = await d.users.find(s.username)
  if (user === null || user.disabled) return null
  await d.sessions.touch(s, nowMs)
  return user
}

export function createTradersGate(d: {
  users: TraderStore; sessions: SessionStore; tokens: WatcherTokens; now: () => number
}): TradersGate {
  return {
    async authenticate(req: IncomingMessage): Promise<Principal | null> {
      const now = d.now()
      await d.sessions.purgeExpiredIfDue(now)

      if (req.headers.cookie !== undefined && cookieOf(req, SESSION_COOKIE) !== '') {
        const user = await userOfSession(d, cookieOf(req, SESSION_COOKIE), now)
        return user === null ? null : { kind: user.role, name: user.username }
      }

      const bearer = bearerOf(req)
      if (bearer === '') return null
      const token = await d.tokens.authenticate(bearer, now)
      if (token === null) return null
      const user = await d.users.find(token.trader)
      if (user === null || user.role !== 'trader' || user.disabled) return null
      if (user.username !== token.trader) return null // fail closed on a non-canonical row
      return { kind: 'watcher', name: user.username }
    },
  }
}
