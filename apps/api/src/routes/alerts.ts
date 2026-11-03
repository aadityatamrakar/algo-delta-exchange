/**
 * `/v1/desk/alerts` — the dashboard's side of the shared `desk-alerts`
 * contract (`{ at, severity, source, mode, tag?, key, message, ackedAt?,
 * forwardedAt? }`, written by the gateway's backstop loop, dx-watchdog and
 * the desk engine lanes; forwarded to Telegram by dx-watchdog).
 *
 *   GET  /v1/desk/alerts[?mode=paper|live]  unacked, newest first (≤ 100)
 *   POST /v1/desk/alerts/:id/ack            stamps `ackedAt` and `ackedBy`
 *
 * `ackedBy` is the AUTHENTICATED principal, never anything a body claims. An
 * ack only lands on an unacked alert, so a second click is a 404, not a
 * second stamp. Acking hides an alert from the banner; it fixes nothing.
 */
import { createRequire } from 'node:module'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'

export const ALERTS_COLLECTION = 'desk-alerts'
const LIMIT = 100

type Doc = Record<string, unknown>

const require = createRequire(import.meta.url)

/** A 24-hex id is a Mongo ObjectId; anything else is not an alert id this desk writes. */
function objectIdOf(s: string): unknown {
  if (!/^[0-9a-f]{24}$/i.test(s)) return null
  const { ObjectId } = require('mongodb') as { ObjectId: new (hex: string) => unknown }
  return new ObjectId(s)
}

function view(d: Doc): Doc {
  const id = d['_id']
  return {
    id: typeof id === 'string' ? id : String((id as { toHexString?: () => string })?.toHexString?.() ?? id),
    at: d['at'],
    severity: d['severity'],
    source: d['source'],
    mode: d['mode'],
    key: d['key'],
    message: d['message'],
    ...(typeof d['tag'] === 'string' ? { tag: d['tag'] } : {}),
    ...(typeof d['forwardedAt'] === 'number' ? { forwardedAt: d['forwardedAt'] } : {}),
  }
}

const ACK = /^\/v1\/desk\/alerts\/([^/]+)\/ack$/

export function alertRoutes(deps: Pick<ApiDeps, 'db' | 'now'> & { readonly toId?: (s: string) => unknown }): Route {
  const toId = deps.toId ?? objectIdOf
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.path === '/v1/desk/alerts' && ctx.method === 'GET') {
      const mode = ctx.url.searchParams.get('mode')
      if (mode !== null && mode !== 'paper' && mode !== 'live') {
        ctx.send(400, { error: `mode must be paper or live, got '${mode}'` })
        return true
      }
      const q: Doc = { ackedAt: { $exists: false }, ...(mode === null ? {} : { mode }) }
      const rows = await deps.db.collection<Doc>(ALERTS_COLLECTION).find(q).sort({ at: -1 }).limit(LIMIT).toArray()
      ctx.send(200, { alerts: rows.map(view), generatedAt: deps.now() })
      return true
    }
    const m = ACK.exec(ctx.path)
    if (m !== null && ctx.method === 'POST') {
      const raw = decodeURIComponent(m[1] ?? '')
      const id = toId(raw)
      if (id === null || id === undefined) {
        ctx.send(400, { error: `'${raw}' is not an alert id` })
        return true
      }
      const r = await deps.db
        .collection<Doc>(ALERTS_COLLECTION)
        .updateOne({ _id: id, ackedAt: { $exists: false } }, { $set: { ackedAt: deps.now(), ackedBy: ctx.principal.name } })
      if ((r.matchedCount ?? 0) === 0) {
        ctx.send(404, { error: 'no unacked alert with that id' })
        return true
      }
      ctx.send(200, { ok: true, id: raw })
      return true
    }
    return false
  }
}
