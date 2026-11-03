/**
 * Admin settings: the charges rates table (spec item 14a). One table for the
 * whole desk; a save confirms it in the admin's name, so the page stops
 * calling the expenses estimates. Admin endpoints: the server has already
 * refused anyone else.
 */

import { parseRates } from '../analytics/charges.ts'
import type { TradersDeps } from '../deps.ts'
import { BadRequest, Forbidden, isObject, type Route, type RouteCtx } from './kit.ts'

export function settingsRoutes(d: Pick<TradersDeps, 'charges'>): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'admin.settings.get': return await get(ctx)
      case 'admin.settings.put': return await put(ctx)
      default: return false
    }
  }

  async function get(ctx: RouteCtx): Promise<boolean> {
    ctx.send(200, { charges: await d.charges.get() })
    return true
  }

  async function put(ctx: RouteCtx): Promise<boolean> {
    const admin = ctx.principal
    if (admin === null || admin.kind !== 'admin') throw new Forbidden('admins only')
    const body = await ctx.readJson()
    if (!isObject(body) || !('charges' in body)) throw new BadRequest('body must be { charges }')
    const rates = parseRates(body['charges'])
    if ('error' in rates) throw new BadRequest(rates.error)
    ctx.send(200, { charges: await d.charges.put(rates, admin.name) })
    return true
  }
}
