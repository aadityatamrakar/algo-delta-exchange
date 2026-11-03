/**
 * Whose data this request is about. Every trader-data query goes through here.
 *
 * A trader is always themselves: `?as=` is ignored, and no endpoint takes a
 * trader name from a trader's body or path. An admin must name a trader.
 */

import { BadRequest, Forbidden, NotFound, type RouteCtx } from '../routes/kit.ts'
import { normaliseUsername, type TraderStore } from './users.ts'

export async function whose(ctx: RouteCtx, users: TraderStore): Promise<string> {
  const p = ctx.principal
  if (p === null || p.kind === 'watcher') throw new Forbidden('not available to this caller')
  if (p.kind === 'trader') return p.name
  const raw = ctx.url.searchParams.get('as')
  const as = normaliseUsername(raw)
  if (as === '') throw new BadRequest('pick a trader: ?as=<username>')
  const u = await users.find(as)
  if (u === null || u.role !== 'trader') throw new NotFound(`no trader "${as}"`)
  return u.username
}
