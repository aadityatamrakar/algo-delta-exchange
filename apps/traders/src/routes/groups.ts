/**
 * `GET|PUT /books/:stock/groups` — the named groups of one book with each
 * group's totals and payoff (`GroupsView`). PUT replaces the whole list.
 */

import { whose } from '../auth/whose.ts'
import { STOCK_RE } from '../books/manual.ts'
import { groupTotals, validateGroups, type GroupsView, type GroupView, type LegGroup } from '../books/groups.ts'
import { BadRequest, NotFound, isObject, type Route, type RouteCtx } from './kit.ts'
import type { R3RouteDeps } from './r3-deps.ts'

export function groupsRoutes(d: Pick<R3RouteDeps, 'users' | 'bookView' | 'groups' | 'now'>): Route {
  async function view(trader: string, stock: string, stored: readonly LegGroup[] | null): Promise<GroupsView | null> {
    const nowMs = d.now()
    const book = await d.bookView(trader, stock, nowMs)
    if (book === null) return null
    const open = new Map(book.legs.map((l) => [l.key, l]))
    const groups = stored ?? await d.groups.get(trader, stock)
    const one = async (name: string, keys: readonly string[]): Promise<GroupView> => {
      const legs = keys.map((k) => open.get(k)).filter((l) => l !== undefined)
      const live = legs.map((l) => l.key)
      const payoff = live.length === 0 ? null : (await d.bookView(trader, stock, nowMs, { keys: new Set(live) }))?.payoff ?? null
      return { name, keys: live, legCount: live.length, totals: groupTotals(legs), payoff }
    }
    const grouped = new Set<string>()
    const out: GroupView[] = []
    for (const g of groups) {
      const keys = g.keys.filter((k) => open.has(k) && !grouped.has(k))
      for (const k of keys) grouped.add(k)
      out.push(await one(g.name, keys))
    }
    const rest = book.legs.map((l) => l.key).filter((k) => !grouped.has(k))
    return { stock, asOf: book.asOf, groups: out, ungrouped: await one('ungrouped', rest) }
  }

  return async (ctx: RouteCtx): Promise<boolean> => {
    const id = ctx.endpoint.id
    if (id !== 'books.groups' && id !== 'books.groups.put') return false
    const stock = (ctx.params['stock'] ?? '').toUpperCase()
    if (!STOCK_RE.test(stock)) throw new BadRequest('the stock must be 1 to 20 letters, digits, & or -')
    const trader = await whose(ctx, d.users)
    if (id === 'books.groups.put') {
      const body = await ctx.readJson()
      if (!isObject(body) || !('groups' in body)) throw new BadRequest('body must be { groups }')
      const book = await d.bookView(trader, stock, d.now())
      if (book === null) throw new NotFound(`no open book ${stock}`)
      const v = validateGroups(body['groups'], new Set(book.legs.map((l) => l.key)))
      if (!v.ok) throw new BadRequest(v.error)
      await d.groups.set(trader, stock, v.groups)
      // the book's last leg may have gone between the check and this read
      const out = await view(trader, stock, v.groups)
      if (out === null) throw new NotFound(`no open book ${stock}`)
      ctx.send(200, out)
      return true
    }
    const out = await view(trader, stock, null)
    if (out === null) throw new NotFound(`no open book ${stock}`)
    ctx.send(200, out)
    return true
  }
}
