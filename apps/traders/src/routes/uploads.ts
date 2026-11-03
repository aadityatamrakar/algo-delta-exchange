/**
 * The watcher's two calls (a file, a heartbeat) and the admin's manual upload.
 * The trader is the watcher's token, or the admin's path name; never a body.
 */

import type { TraderStore } from '../auth/users.ts'
import { OffsetMismatch, validRelPath } from '../ingest/files.ts'
import { ingestUpload, type IngestDeps, type Upload } from '../ingest/pipeline.ts'
import { sha256hex } from '../hash.ts'
import { parseHeartbeat, type WatcherStatusStore } from '../watcher-status.ts'
import { BadRequest, NotFound, type Log, type Route, type RouteCtx } from './kit.ts'

function uintParam(v: string | null, name: string): number {
  if (v === null || !/^\d{1,16}$/.test(v) || !Number.isSafeInteger(Number(v))) {
    throw new BadRequest(`${name} must be a non-negative integer`)
  }
  return Number(v)
}

export function uploadRoutes(d: {
  ingest: IngestDeps; status: WatcherStatusStore; users: TraderStore; now: () => number; log: Log
}): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    switch (ctx.endpoint.id) {
      case 'watcher.files': return await watcherFile(ctx)
      case 'watcher.heartbeat': return await heartbeat(ctx)
      case 'admin.files.upload': return await adminUpload(ctx)
      default: return false
    }
  }

  async function watcherFile(ctx: RouteCtx): Promise<boolean> {
    const q = ctx.url.searchParams
    const path = validRelPath(q.get('path'))
    const mtime = uintParam(q.get('mtime'), 'mtime')
    const sha256 = q.get('sha256')
    if (sha256 === null || !/^[0-9a-f]{64}$/.test(sha256)) throw new BadRequest('sha256 must be 64 lower-case hex characters')
    const offset = q.get('offset') === null ? null : uintParam(q.get('offset'), 'offset')
    const body = await ctx.readRaw()
    return await ingest(ctx, ctx.principal!.name, { path, mtime, sha256, body, offset })
  }

  async function ingest(ctx: RouteCtx, trader: string, up: Upload): Promise<boolean> {
    try {
      ctx.send(200, await ingestUpload(d.ingest, trader, up))
    } catch (err) {
      if (!(err instanceof OffsetMismatch)) throw err
      ctx.send(409, { error: 'offset' })
    }
    return true
  }

  async function heartbeat(ctx: RouteCtx): Promise<boolean> {
    const hb = parseHeartbeat(await ctx.readJson())
    await d.status.record(ctx.principal!.name, hb, d.now())
    ctx.send(200, { ok: true })
    return true
  }

  async function adminUpload(ctx: RouteCtx): Promise<boolean> {
    const user = await d.users.find(ctx.params['name'])
    if (user === null || user.role !== 'trader') throw new NotFound('no such trader')
    const path = validRelPath(ctx.url.searchParams.get('path'))
    const body = await ctx.readRaw()
    return await ingest(ctx, user.username, { path, mtime: d.now(), sha256: sha256hex(body), body, offset: null })
  }
}
