/**
 * The endpoint table. Every request is matched against it; anything unlisted
 * is a 404. `kind` decides who may call:
 *   public  — no session (health, login, logout, me)
 *   watcher — a watcher token only
 *   admin   — an admin session
 *   trader  — any session, trader or admin; the route decides with `whose()`
 *             whether it reads trader data (market data never does)
 */

import { BadRequest } from './kit.ts'

export type EndpointKind = 'public' | 'watcher' | 'admin' | 'trader'

export interface Endpoint {
  readonly id: string
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly pattern: string
  readonly kind: EndpointKind
  /** The body is bytes (application/octet-stream), not JSON. */
  readonly raw?: true
}

const P = '/v1/traders'

export const ENDPOINTS: readonly Endpoint[] = [
  { id: 'health', method: 'GET', pattern: `${P}/health`, kind: 'public' },
  { id: 'auth.login', method: 'POST', pattern: `${P}/auth/login`, kind: 'public' },
  { id: 'auth.logout', method: 'POST', pattern: `${P}/auth/logout`, kind: 'public' },
  { id: 'auth.me', method: 'GET', pattern: `${P}/auth/me`, kind: 'public' },
  { id: 'watcher.files', method: 'PUT', pattern: `${P}/files`, kind: 'watcher', raw: true },
  { id: 'watcher.heartbeat', method: 'POST', pattern: `${P}/heartbeat`, kind: 'watcher' },
  { id: 'admin.traders.list', method: 'GET', pattern: `${P}/admin/traders`, kind: 'admin' },
  { id: 'admin.traders.add', method: 'POST', pattern: `${P}/admin/traders`, kind: 'admin' },
  { id: 'admin.traders.patch', method: 'PATCH', pattern: `${P}/admin/traders/:name`, kind: 'admin' },
  { id: 'admin.token.issue', method: 'POST', pattern: `${P}/admin/traders/:name/token`, kind: 'admin' },
  { id: 'admin.token.revoke', method: 'DELETE', pattern: `${P}/admin/traders/:name/token`, kind: 'admin' },
  { id: 'admin.files.upload', method: 'PUT', pattern: `${P}/admin/traders/:name/files`, kind: 'admin', raw: true },
  { id: 'admin.settings.get', method: 'GET', pattern: `${P}/admin/settings`, kind: 'admin' },
  { id: 'admin.settings.put', method: 'PUT', pattern: `${P}/admin/settings`, kind: 'admin' },
  { id: 'books.list', method: 'GET', pattern: `${P}/books`, kind: 'trader' },
  { id: 'books.view', method: 'GET', pattern: `${P}/books/:stock`, kind: 'trader' },
  { id: 'books.live', method: 'GET', pattern: `${P}/books/:stock/live`, kind: 'trader' },
  { id: 'books.margin', method: 'GET', pattern: `${P}/books/:stock/margin`, kind: 'trader' },
  { id: 'books.analysis', method: 'GET', pattern: `${P}/books/:stock/analysis`, kind: 'trader' },
  { id: 'books.scenario', method: 'POST', pattern: `${P}/books/:stock/scenario`, kind: 'trader' },
  { id: 'legs.add', method: 'POST', pattern: `${P}/books/:stock/legs`, kind: 'trader' },
  { id: 'legs.patch', method: 'PATCH', pattern: `${P}/legs/:key`, kind: 'trader' },
  { id: 'legs.delete', method: 'DELETE', pattern: `${P}/legs/:key`, kind: 'trader' },
  { id: 'orders.list', method: 'GET', pattern: `${P}/orders`, kind: 'trader' },
  { id: 'trades.list', method: 'GET', pattern: `${P}/trades`, kind: 'trader' },
  { id: 'log.list', method: 'GET', pattern: `${P}/log`, kind: 'trader' },
  { id: 'watcher.status', method: 'GET', pattern: `${P}/watcher`, kind: 'trader' },
  { id: 'files.list', method: 'GET', pattern: `${P}/files`, kind: 'trader' },
  { id: 'books.groups', method: 'GET', pattern: `${P}/books/:stock/groups`, kind: 'trader' },
  { id: 'books.groups.put', method: 'PUT', pattern: `${P}/books/:stock/groups`, kind: 'trader' },
  { id: 'books.repair', method: 'POST', pattern: `${P}/books/:stock/repair`, kind: 'trader' },
  { id: 'books.band', method: 'PUT', pattern: `${P}/books/:stock/band`, kind: 'trader' },
  { id: 'market.watch', method: 'GET', pattern: `${P}/market/:stock`, kind: 'trader' },
  { id: 'market.context', method: 'GET', pattern: `${P}/market/:stock/context`, kind: 'trader' },
  { id: 'market.bars', method: 'GET', pattern: `${P}/market/:stock/bars`, kind: 'trader' },
  { id: 'market.contracts', method: 'GET', pattern: `${P}/contracts/:stock`, kind: 'trader' },
  { id: 'portfolio.view', method: 'GET', pattern: `${P}/portfolio`, kind: 'trader' },
  { id: 'admin.portfolio', method: 'GET', pattern: `${P}/admin/portfolio`, kind: 'admin' },
  { id: 'books.advice', method: 'GET', pattern: `${P}/books/:stock/advice`, kind: 'trader' },
  { id: 'assistant.status', method: 'GET', pattern: `${P}/assistant/status`, kind: 'trader' },
  { id: 'assistant.chat', method: 'POST', pattern: `${P}/assistant/chat`, kind: 'trader' },
  { id: 'assistant.conversations', method: 'GET', pattern: `${P}/assistant/conversations`, kind: 'trader' },
  { id: 'assistant.conversation', method: 'GET', pattern: `${P}/assistant/conversations/:id`, kind: 'trader' },
  { id: 'assistant.conversation.hide', method: 'DELETE', pattern: `${P}/assistant/conversations/:id`, kind: 'trader' },
  { id: 'assistant.feedback', method: 'POST', pattern: `${P}/assistant/conversations/:id/feedback`, kind: 'trader' },
  { id: 'admin.assistant.usage', method: 'GET', pattern: `${P}/admin/assistant/usage`, kind: 'admin' },
  { id: 'admin.assistant.export', method: 'GET', pattern: `${P}/admin/assistant/export`, kind: 'admin' },
  { id: 'books.plan-search', method: 'POST', pattern: `${P}/books/:stock/plan-search`, kind: 'trader' },
  { id: 'vol.view', method: 'GET', pattern: `${P}/vol`, kind: 'trader' },
  // traders risk (spec 2026-10-24): the portfolio stress and each held book's results-event risk
  { id: 'risk.view', method: 'GET', pattern: `${P}/risk`, kind: 'trader' },
  { id: 'events.view', method: 'GET', pattern: `${P}/events`, kind: 'trader' },
  { id: 'daily.list', method: 'GET', pattern: `${P}/daily`, kind: 'trader' },
  { id: 'admin.data-status', method: 'GET', pattern: `${P}/admin/data-status`, kind: 'admin' },
  { id: 'booked.view', method: 'GET', pattern: `${P}/booked`, kind: 'trader' },
  { id: 'admin.booked', method: 'GET', pattern: `${P}/admin/booked`, kind: 'admin' },
  // phone alerts (gaps G7): the caller's own phones; the bell's stored alerts
  { id: 'push.key', method: 'GET', pattern: `${P}/push/key`, kind: 'trader' },
  { id: 'push.subscribe', method: 'POST', pattern: `${P}/push/subscribe`, kind: 'trader' },
  { id: 'push.unsubscribe', method: 'POST', pattern: `${P}/push/unsubscribe`, kind: 'trader' },
  { id: 'push.test', method: 'POST', pattern: `${P}/push/test`, kind: 'trader' },
  { id: 'alerts.list', method: 'GET', pattern: `${P}/alerts`, kind: 'trader' },
]

/** `:x` matches exactly one non-empty segment, percent-decoded. A bad escape is a BadRequest. */
export function matchEndpoint(
  method: string,
  path: string,
  table: readonly Endpoint[] = ENDPOINTS,
): { endpoint: Endpoint; params: Record<string, string> } | null {
  const segs = path.split('/')
  for (const endpoint of table) {
    if (endpoint.method !== method) continue
    const pat = endpoint.pattern.split('/')
    if (pat.length !== segs.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < pat.length; i++) {
      const p = pat[i] as string
      const s = segs[i] as string
      if (p.startsWith(':')) {
        if (s === '') { ok = false; break }
        try {
          params[p.slice(1)] = decodeURIComponent(s)
        } catch {
          throw new BadRequest('malformed percent-escape in path')
        }
      } else if (p !== s) { ok = false; break }
    }
    if (ok) return { endpoint, params }
  }
  return null
}
