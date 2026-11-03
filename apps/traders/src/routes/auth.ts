/**
 * Login, logout, whoami. All three are PUBLIC endpoints (the server does not
 * gate them), but `me` authenticates itself and 401s without a live session.
 */

import { randomBytes } from 'node:crypto'
import { DEFAULT_LOCKOUT_POLICY, hashPassword, verifyPassword } from '@algomaker/auth'
import { clearedSessionCookie, cookieOf, isSecureRequest, SESSION_COOKIE, sessionCookie } from '../auth/cookies.ts'
import { userOfSession } from '../auth/gate.ts'
import type { SessionStore } from '../auth/sessions.ts'
import { normaliseUsername, type TraderStore } from '../auth/users.ts'
import { isObject, type Log, type Route, type RouteCtx } from './kit.ts'

/** Verified against when the username does not exist, so timing does not reveal accounts. */
let decoyHash: Promise<string> | null = null
const decoy = (): Promise<string> => (decoyHash ??= hashPassword(randomBytes(24).toString('hex')))

/** Attempts for one username run one at a time, so attempt N+1 sees N's failure count. */
const chains = new Map<string, Promise<unknown>>()
function serialiseByUser<T>(username: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(username) ?? Promise.resolve()
  const next = prior.then(fn, fn)
  const clean = (): void => { if (chains.get(username) === next) chains.delete(username) }
  chains.set(username, next.then(clean, clean))
  return next
}

/** Argon2 is 19 MiB on the shared threadpool: past this many at once, refuse cheaply. */
const MAX_CONCURRENT_LOGINS = 4
let loginsInFlight = 0

export function authRoutes(d: {
  users: TraderStore; sessions: SessionStore; sessionTtlMs: number; now: () => number; log: Log
}): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'auth.login': return await login(ctx)
      case 'auth.logout': return await logout(ctx)
      case 'auth.me': return await me(ctx)
      default: return false
    }
  }

  async function login(ctx: RouteCtx): Promise<boolean> {
    const body = await ctx.readJson()
    const username = isObject(body) ? body['username'] : undefined
    const password = isObject(body) ? body['password'] : undefined
    if (typeof username !== 'string' || typeof password !== 'string' || password === '') {
      ctx.send(400, { error: 'username and password are required' })
      return true
    }
    if (loginsInFlight >= MAX_CONCURRENT_LOGINS) {
      ctx.send(503, { error: 'too many logins in progress, try again shortly' })
      return true
    }
    loginsInFlight++
    try {
      await serialiseByUser(normaliseUsername(username), () => attempt(ctx, username, password))
    } finally {
      loginsInFlight--
    }
    return true
  }

  async function attempt(ctx: RouteCtx, username: string, password: string): Promise<void> {
    const now = d.now()
    const user = await d.users.find(username)
    if (user === null) {
      await verifyPassword(password, await decoy())
      d.log('login failed', { username: username.slice(0, 64), reason: 'no such user' })
      ctx.send(401, { error: 'invalid credentials' })
      return
    }
    const lockedNow = user.lockedUntil !== null && now < user.lockedUntil
    if (lockedNow) {
      ctx.send(429, { error: `too many attempts, locked until ${new Date(user.lockedUntil ?? now).toISOString()}`, lockedUntil: user.lockedUntil })
      return
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      const state = await d.users.recordLoginFailure(user.username, now, DEFAULT_LOCKOUT_POLICY)
      d.log('login failed', { username: user.username, failedAttempts: state.failedAttempts })
      if (state.lockedUntil !== null) {
        ctx.send(429, { error: `too many attempts, locked until ${new Date(state.lockedUntil).toISOString()}`, lockedUntil: state.lockedUntil })
        return
      }
      ctx.send(401, { error: 'invalid credentials' })
      return
    }
    if (user.disabled) {
      ctx.send(403, { error: 'this account is disabled' })
      return
    }
    const session = await d.sessions.create(user.username, now, d.sessionTtlMs)
    await d.users.recordLoginSuccess(user.username, now)
    d.log('login ok', { username: user.username, role: user.role })
    ctx.res.setHeader('set-cookie', sessionCookie(session.token, d.sessionTtlMs, isSecureRequest(ctx.req)))
    ctx.send(200, { username: user.username, role: user.role, expiresAt: session.expiresAt })
  }

  async function logout(ctx: RouteCtx): Promise<boolean> {
    // Always 200, and the cookie is cleared even for an unknown token.
    await d.sessions.revoke(cookieOf(ctx.req, SESSION_COOKIE))
    ctx.res.setHeader('set-cookie', clearedSessionCookie(isSecureRequest(ctx.req)))
    ctx.send(200, { ok: true })
    return true
  }

  async function me(ctx: RouteCtx): Promise<boolean> {
    const token = cookieOf(ctx.req, SESSION_COOKIE)
    const user = token === '' ? null : await userOfSession(d, token, d.now())
    if (user === null) ctx.send(401, { error: 'unauthorised' })
    else ctx.send(200, { username: user.username, role: user.role })
    return true
  }
}
