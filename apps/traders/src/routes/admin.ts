/**
 * Admin: create and manage traders, issue and revoke watcher tokens, see each
 * watcher's heartbeat. The trader is named in the path (the admin is the
 * caller). A token appears in exactly one response: the issue call.
 */

import { hashPassword } from '@algomaker/auth'
import type { PushStore } from '../alerts/push.ts'
import type { SessionStore } from '../auth/sessions.ts'
import type { WatcherTokens } from '../auth/tokens.ts'
import {
  assertPassword, assertUsername, DuplicateUser, InvalidUsername, normaliseUsername, WeakPassword,
  type TraderStore,
} from '../auth/users.ts'
import type { WatcherStatusStore } from '../watcher-status.ts'
import type { AdminTraderRow } from '../types.ts'
import { BadRequest, Conflict, isObject, NotFound, type Log, type Route, type RouteCtx } from './kit.ts'

export function adminRoutes(d: {
  users: TraderStore; sessions: SessionStore; tokens: WatcherTokens; status: WatcherStatusStore
  now: () => number; log: Log
  /** The trader's phone-alert subscriptions (gaps G7): forgotten when access is revoked. */
  phones?: Pick<PushStore, 'forget'>
}): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'admin.traders.list': return await list(ctx)
      case 'admin.traders.add': return await add(ctx)
      case 'admin.traders.patch': return await patch(ctx)
      case 'admin.token.issue': return await issue(ctx)
      case 'admin.token.revoke': return await revoke(ctx)
      default: return false
    }
  }

  /** The named user, if and only if a trader; admins are not managed here. */
  async function traderOf(ctx: RouteCtx): Promise<string> {
    const user = await d.users.find(ctx.params['name'])
    if (user === null || user.role !== 'trader') throw new NotFound('no such trader')
    return user.username
  }

  async function list(ctx: RouteCtx): Promise<boolean> {
    const [traders, statuses] = await Promise.all([d.users.list('trader'), d.status.all()])
    const rows: AdminTraderRow[] = []
    for (const u of traders) {
      const t = await d.tokens.active(u.username)
      rows.push({
        username: u.username, disabled: u.disabled, lastLoginAt: u.lastLoginAt,
        watcher: statuses.get(u.username) ?? null,
        token: t === null ? null : { createdAt: t.createdAt, lastUsedAt: t.lastUsedAt },
      })
    }
    rows.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0))
    ctx.send(200, rows)
    return true
  }

  async function add(ctx: RouteCtx): Promise<boolean> {
    const body = await ctx.readJson()
    if (!isObject(body)) throw new BadRequest('body must be a JSON object')
    let username: string
    let password: string
    try {
      username = assertUsername(body['username'])
      password = assertPassword(body['password'])
    } catch (err) {
      if (err instanceof InvalidUsername || err instanceof WeakPassword) throw new BadRequest(err.message)
      throw err
    }
    try {
      await d.users.create(username, await hashPassword(password), 'trader', d.now())
    } catch (err) {
      if (err instanceof DuplicateUser) throw new Conflict(err.message)
      throw err
    }
    d.log('trader added', { username })
    ctx.send(201, { username })
    return true
  }

  async function patch(ctx: RouteCtx): Promise<boolean> {
    const name = await traderOf(ctx)
    const body = await ctx.readJson()
    if (!isObject(body)) throw new BadRequest('body must be a JSON object')
    const disabled = body['disabled']
    const password = body['password']
    if (disabled !== undefined && typeof disabled !== 'boolean') throw new BadRequest('disabled must be true or false')
    if (disabled === undefined && password === undefined) throw new BadRequest('nothing to change')
    let hash: string | null = null
    if (password !== undefined) {
      try {
        hash = await hashPassword(assertPassword(password))
      } catch (err) {
        if (err instanceof WeakPassword) throw new BadRequest(err.message)
        throw err
      }
    }
    // access revoked (disabled, or a password reset): the sessions end and the phones stop getting alerts
    let phonesForgotten = 0
    if (disabled !== undefined) {
      await d.users.setDisabled(name, disabled)
      if (disabled) {
        await d.sessions.revokeAll(name)
        phonesForgotten += (await d.phones?.forget(name)) ?? 0
      }
    }
    if (hash !== null) {
      await d.users.setPassword(name, hash) // also clears the lockout
      await d.sessions.revokeAll(name)
      phonesForgotten += (await d.phones?.forget(name)) ?? 0
    }
    d.log('trader changed', { username: name, disabled: disabled ?? null, passwordReset: hash !== null, phonesForgotten })
    ctx.send(200, { username: name })
    return true
  }

  async function issue(ctx: RouteCtx): Promise<boolean> {
    const name = await traderOf(ctx)
    const token = await d.tokens.issue(name, d.now())
    d.log('watcher token issued', { username: name })
    ctx.send(200, { token })
    return true
  }

  async function revoke(ctx: RouteCtx): Promise<boolean> {
    const name = normaliseUsername(ctx.params['name'])
    if (!(await d.tokens.revoke(name, d.now()))) throw new NotFound('no active token')
    d.log('watcher token revoked', { username: name })
    ctx.send(200, { revoked: true })
    return true
  }
}
