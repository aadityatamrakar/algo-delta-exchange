/**
 * The file store. `traders-files` holds the latest copy of each (trader, path)
 * with its content gzipped and base64-encoded; `traders-file-versions` keeps
 * every new content for seven days. ODIN appends to the day's trade file all
 * session, so the watcher may send only the new bytes with an `offset`.
 */

import { gunzipSync, gzipSync } from 'node:zlib'
import type { TradersDb } from '../db.ts'
import { sha256hex } from '../hash.ts'
import { BadRequest, PayloadTooLarge, RAW_BODY_MAX } from '../routes/kit.ts'
import type { StoredFile } from '../types.ts'
import { decodeText } from './parsers.ts'
import type { Upload } from './pipeline.ts'

export const FILE_VERSION_MS = 7 * 24 * 60 * 60 * 1000

export class OffsetMismatch extends Error {
  readonly storedSize: number
  constructor(storedSize: number) {
    super(`offset does not match the stored size ${storedSize}`)
    this.storedSize = storedSize
  }
}

/** A relative path with forward slashes: no traversal, no drive, no control characters. Spaces are fine. */
export function validRelPath(p: unknown): string {
  if (typeof p !== 'string' || p.length < 1 || p.length > 260) throw new BadRequest('path must be 1 to 260 characters')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(p)) throw new BadRequest('path has a control character or a backslash')
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new BadRequest('path must be relative')
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new BadRequest('path has an empty, "." or ".." segment')
  }
  return p
}

export interface PutResult { readonly file: StoredFile; readonly changed: boolean; readonly text: string }

type FileDoc = StoredFile & { content: string }

export class FileStore {
  readonly #db: TradersDb
  readonly #now: () => number

  constructor(db: TradersDb, now: () => number) {
    this.#db = db
    this.#now = now
  }

  async put(trader: string, up: Upload): Promise<PutResult> {
    const files = this.#db.collection<FileDoc>('traders-files')
    const stored = await files.findOne({ trader, path: up.path })
    const storedSize = stored?.size ?? 0
    const offset = up.offset ?? 0
    if (up.offset !== null && offset !== storedSize) throw new OffsetMismatch(storedSize)
    const prior = stored === null ? Buffer.alloc(0) : gunzipSync(Buffer.from(stored.content, 'base64'))
    if (up.offset === null && up.body.length > RAW_BODY_MAX) throw new PayloadTooLarge('file too large')
    const whole = up.offset === null ? up.body : Buffer.concat([prior, up.body])
    if (whole.length > RAW_BODY_MAX) throw new PayloadTooLarge('file too large')
    if (sha256hex(whole) !== up.sha256) {
      // an append onto a copy that is not the watcher's: it should resend the whole file
      if (up.offset !== null) throw new OffsetMismatch(storedSize)
      throw new BadRequest('sha256 does not match the file')
    }
    if (stored !== null && stored.sha256 === up.sha256) {
      return { file: strip(stored), changed: false, text: decodeText(whole) }
    }
    const now = this.#now()
    const content = gzipSync(whole).toString('base64')
    const file: StoredFile = {
      trader, path: up.path, sha256: up.sha256, size: whole.length, mtime: up.mtime,
      receivedAt: now, parser: null, parseError: null,
    }
    await files.updateOne(
      { trader, path: up.path },
      { $set: { ...file, content }, $unset: { skipped: '' } },
      { upsert: true },
    )
    await this.#db.collection('traders-file-versions').insertOne({
      trader, path: up.path, sha256: up.sha256, size: whole.length, mtime: up.mtime, receivedAt: now, content,
    })
    await this.#db.collection('traders-file-versions').deleteMany({ receivedAt: { $lt: now - FILE_VERSION_MS } })
    return { file, changed: true, text: decodeText(whole) }
  }

  async setParse(
    trader: string, path: string, parser: string | null, parseError: string | null,
    skipped?: StoredFile['skipped'],
  ): Promise<void> {
    const set: Record<string, unknown> = { parser, parseError }
    const update: Record<string, unknown> = skipped !== undefined && skipped.length > 0
      ? { $set: { ...set, skipped } }
      : { $set: set, $unset: { skipped: '' } }
    await this.#db.collection('traders-files').updateOne({ trader, path }, update)
  }

  /** The trader's files, newest first; `limit` bounds the read (a caller wanting to know about truncation asks for one more). */
  async list(trader: string, limit = 500): Promise<StoredFile[]> {
    return await this.#db.collection<StoredFile>('traders-files')
      .find({ trader }, { projection: { content: 0, _id: 0 } })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .toArray()
  }

  /**
   * The trader's files whose last parse failed or skipped lines, newest first, at most `limit`, no
   * content; `total` counts them all (a second query only when the limit is reached).
   */
  async problems(trader: string, limit: number): Promise<{ readonly files: StoredFile[]; readonly total: number }> {
    const col = this.#db.collection<StoredFile>('traders-files')
    const filter = { trader, $or: [{ parseError: { $ne: null } }, { 'skipped.0': { $exists: true } }] }
    const files = await col.find(filter, { projection: { content: 0, _id: 0 } }).sort({ receivedAt: -1 }).limit(limit).toArray()
    return { files, total: files.length < limit ? files.length : await col.countDocuments(filter) }
  }

  /** Every trader's files whose last parse failed or skipped lines, no content. */
  async unread(): Promise<StoredFile[]> {
    return await this.#db.collection<StoredFile>('traders-files')
      .find({ $or: [{ parseError: { $ne: null } }, { 'skipped.0': { $exists: true } }] }, { projection: { content: 0, _id: 0 } })
      .toArray()
  }

  /** A stored file and its text, or null when there is none. */
  async read(trader: string, path: string): Promise<{ readonly file: StoredFile; readonly text: string } | null> {
    const d = await this.#db.collection<FileDoc>('traders-files').findOne({ trader, path })
    return d === null ? null : { file: strip(d), text: decodeText(gunzipSync(Buffer.from(d.content, 'base64'))) }
  }

  /** When the trader's newest file arrived: one document read, no content. */
  async lastReceivedAt(trader: string): Promise<number | null> {
    const d = await this.#db.collection<StoredFile>('traders-files')
      .find({ trader }, { projection: { receivedAt: 1, _id: 0 } }).sort({ receivedAt: -1 }).limit(1).toArray()
    return d[0]?.receivedAt ?? null
  }
}

function strip(d: FileDoc): StoredFile {
  const { content: _content, ...rest } = d as FileDoc & { _id?: unknown }
  delete (rest as { _id?: unknown })._id
  return rest
}
