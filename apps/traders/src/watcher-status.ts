/**
 * What each trader's watcher last told us (`traders-settings`, kind 'watcher').
 * One document per trader, replaced on every heartbeat. "Offline" is not stored:
 * the admin page derives it from `lastHeartbeatAt` (180 s).
 */

import type { TradersDb } from './db.ts'
import { normaliseUsername } from './auth/users.ts'
import { BadRequest, isObject } from './routes/kit.ts'
import type { WatcherStatus } from './types.ts'

type Heartbeat = Omit<WatcherStatus, 'lastHeartbeatAt'>

export function parseHeartbeat(body: unknown): Heartbeat {
  if (!isObject(body)) throw new BadRequest('heartbeat must be a JSON object')
  const { version, folder, lastUploadAt, fileCount } = body
  if (typeof version !== 'string' || version.length > 32) throw new BadRequest('version must be a string of at most 32 characters')
  if (typeof folder !== 'string' || folder.length > 260) throw new BadRequest('folder must be a string of at most 260 characters')
  if (lastUploadAt !== null && lastUploadAt !== undefined && (typeof lastUploadAt !== 'number' || !Number.isFinite(lastUploadAt))) {
    throw new BadRequest('lastUploadAt must be a number or null')
  }
  if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) {
    throw new BadRequest('fileCount must be a non-negative integer')
  }
  return { version, folder, lastUploadAt: lastUploadAt ?? null, fileCount }
}

export class WatcherStatusStore {
  readonly #db: TradersDb

  constructor(db: TradersDb) {
    this.#db = db
  }

  #col() {
    return this.#db.collection<Record<string, unknown>>('traders-settings')
  }

  async record(trader: string, hb: Heartbeat, nowMs: number): Promise<void> {
    const name = normaliseUsername(trader)
    await this.#col().updateOne(
      { kind: 'watcher', trader: name },
      { $set: {
        kind: 'watcher', trader: name, lastHeartbeatAt: nowMs, lastUploadAt: hb.lastUploadAt,
        version: hb.version, folder: hb.folder, fileCount: hb.fileCount,
      } },
      { upsert: true },
    )
  }

  async get(trader: string): Promise<WatcherStatus | null> {
    const d = await this.#col().findOne({ kind: 'watcher', trader: normaliseUsername(trader) })
    return d === null ? null : toStatus(d)
  }

  async all(): Promise<ReadonlyMap<string, WatcherStatus>> {
    const docs = await this.#col().find({ kind: 'watcher' }).toArray()
    const out = new Map<string, WatcherStatus>()
    for (const d of docs) if (typeof d['trader'] === 'string') out.set(d['trader'], toStatus(d))
    return out
  }
}

function toStatus(d: Record<string, unknown>): WatcherStatus {
  return {
    lastHeartbeatAt: typeof d['lastHeartbeatAt'] === 'number' ? d['lastHeartbeatAt'] : 0,
    lastUploadAt: typeof d['lastUploadAt'] === 'number' ? d['lastUploadAt'] : null,
    version: typeof d['version'] === 'string' ? d['version'] : '',
    folder: typeof d['folder'] === 'string' ? d['folder'] : '',
    fileCount: typeof d['fileCount'] === 'number' ? d['fileCount'] : 0,
  }
}
