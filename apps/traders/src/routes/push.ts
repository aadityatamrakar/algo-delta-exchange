/**
 * Phone alerts (spec 2026-10-23-traders-gaps G7), for any signed-in user, trader or admin, about their own phones:
 *
 *   GET  /push/key          the server's VAPID public key, for `pushManager.subscribe`
 *   POST /push/subscribe    this browser's PushSubscription (endpoint on a known push service only)
 *   POST /push/unsubscribe  { endpoint }: only the caller's own
 *   POST /push/test         one test alert to the caller's own phones
 *   GET  /alerts?since=<ms> the stored alerts the bell lists: a trader's own; an admin's admin-wide ones, plus the
 *                           picked trader's with `?as=`
 */

import type { TraderStore } from '../auth/users.ts'
import { whose } from '../auth/whose.ts'
import { parseSubscription, type PushStore, type Pusher, type VapidStore } from '../alerts/push.ts'
import { ALERT_TTL_DAYS, type AlertStore } from '../alerts/store.ts'
import { BadRequest, Forbidden, isObject, type Route, type RouteCtx } from './kit.ts'

/** A test alert per user at most this often: each is a POST to a push service. */
export const TEST_EVERY_MS = 10_000
const DAY_MS = 86_400_000

export interface PushRouteDeps {
  readonly users: TraderStore
  readonly subs: Pick<PushStore, 'add' | 'remove' | 'count'>
  readonly vapid: Pick<VapidStore, 'keys'>
  readonly pusher: Pick<Pusher, 'send'>
  readonly alerts: Pick<AlertStore, 'feed'>
  readonly now: () => number
}

export function pushRoutes(d: PushRouteDeps): Route {
  const lastTest = new Map<string, number>()

  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'push.key': return await key(ctx)
      case 'push.subscribe': return await subscribe(ctx)
      case 'push.unsubscribe': return await unsubscribe(ctx)
      case 'push.test': return await test(ctx)
      case 'alerts.list': return await list(ctx)
      default: return false
    }
  }

  /** The signed-in user: their own phones, whoever they act as (`?as=` is for trader data). */
  function me(ctx: RouteCtx): string {
    const p = ctx.principal
    if (p === null || p.kind === 'watcher') throw new Forbidden('not available to this caller')
    return p.name
  }

  async function key(ctx: RouteCtx): Promise<boolean> {
    me(ctx)
    ctx.send(200, { publicKey: (await d.vapid.keys()).publicKey })
    return true
  }

  async function subscribe(ctx: RouteCtx): Promise<boolean> {
    const name = me(ctx)
    const target = parseSubscription(await ctx.readJson())
    ctx.send(200, { subscribed: true, phones: await d.subs.add(name, target) })
    return true
  }

  async function unsubscribe(ctx: RouteCtx): Promise<boolean> {
    const name = me(ctx)
    const body = await ctx.readJson()
    const endpoint = isObject(body) ? body['endpoint'] : undefined
    if (typeof endpoint !== 'string' || endpoint === '') throw new BadRequest('body must be { endpoint }')
    let href: string
    try { href = new URL(endpoint).href } catch { throw new BadRequest('endpoint is not a URL') }   // stored as its WHATWG href
    ctx.send(200, { removed: await d.subs.remove(name, href) })
    return true
  }

  async function test(ctx: RouteCtx): Promise<boolean> {
    const name = me(ctx)
    const now = d.now()
    const last = lastTest.get(name)
    if (last !== undefined && now - last < TEST_EVERY_MS) {
      ctx.send(429, { error: 'a test alert was just sent: wait a few seconds' })
      return true
    }
    lastTest.set(name, now)
    const phones = await d.subs.count(name)
    const sent = phones === 0 ? 0
      : await d.pusher.send([name], { title: 'Delta Desk: test alert', body: 'Phone alerts are on for this phone.', url: '/traders/', tag: 'test' })
    ctx.send(200, { sent, phones })
    return true
  }

  async function list(ctx: RouteCtx): Promise<boolean> {
    const name = me(ctx)
    const now = d.now()
    const raw = ctx.url.searchParams.get('since')
    const asked = raw === null || raw === '' ? now - DAY_MS : Number(raw)
    if (!Number.isSafeInteger(asked) || asked < 0) throw new BadRequest('since must be epoch milliseconds')
    const since = Math.max(asked, now - ALERT_TTL_DAYS * DAY_MS)
    let owners: (string | null)[]
    if (ctx.principal?.kind === 'admin') {
      const as = ctx.url.searchParams.get('as')
      owners = as === null || as === '' ? [null] : [null, await whose(ctx, d.users)]
    } else owners = [name]
    ctx.send(200, await d.alerts.feed(owners, since))
    return true
  }
}
