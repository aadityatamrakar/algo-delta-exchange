/**
 * Write-ahead journal for order intents.
 *
 * WHY: the legacy system routed orders through MongoDB. An order paid a
 * cloud-Atlas insert, a majority-commit replication wait, and oplog fan-out
 * before it reached a broker — on a stop-loss. That is the wrong place to spend
 * latency, and it made Mongo a single point of failure in the trading path.
 *
 * The insight is that durability does not require a database. An append-only
 * local file, fsync'd before submission, gives a STRONGER crash guarantee than a
 * remote write and costs microseconds. MongoDB moves off the hot path and becomes
 * an async audit/reporting sink.
 *
 * Format: newline-delimited JSON. Chosen so a partially-written tail record (a
 * crash mid-write) can be detected and discarded by line, rather than corrupting
 * the whole file the way a binary format or a JSON array would.
 *
 * Durability contract:
 *   append(record) resolves only after the bytes are fsync'd to disk.
 *   Callers MUST await it before submitting to a broker.
 */

import { open, type FileHandle } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { WalRecord } from './types.ts'

export interface WalOptions {
  /**
   * fsync on every append. Default true — this is the durability guarantee.
   * Setting false trades crash-safety for throughput and must be a deliberate,
   * documented choice (e.g. tests, where the journal is disposable).
   */
  readonly fsync?: boolean
  /**
   * How the file is opened. A TEST SEAM, and the only way this file's central
   * promise can be checked at all.
   *
   * The durability contract is "append resolves only after the bytes are
   * fsync'd", and that is INVISIBLE from the filesystem: `readFileSync` is
   * served by the page cache, so it returns the bytes whether or not they ever
   * reached the platter. A test written against the file content therefore
   * passes with `fh.sync()` deleted — which is precisely the mistake that makes
   * this journal weaker than the remote write it replaced, on the one axis it
   * was replaced for. Observing the syscall is the only honest assertion, so the
   * handle is injectable.
   */
  readonly openFile?: (path: string) => Promise<FileHandle>
}

export class Wal {
  readonly #path: string
  readonly #fsync: boolean
  readonly #open: (path: string) => Promise<FileHandle>
  #handle: FileHandle | null = null
  /** Serialises appends so concurrent callers cannot interleave partial lines. */
  #tail: Promise<void> = Promise.resolve()

  constructor(path: string, opts: WalOptions = {}) {
    this.#path = path
    this.#fsync = opts.fsync ?? true
    this.#open = opts.openFile ?? ((p: string) => open(p, 'a'))
    mkdirSync(dirname(path), { recursive: true })
  }

  get path(): string {
    return this.#path
  }

  async #ensureOpen(): Promise<FileHandle> {
    if (this.#handle === null) {
      this.#handle = await this.#open(this.#path)
    }
    return this.#handle
  }

  /**
   * Append one record durably. Resolves only once the bytes are on disk (when
   * fsync is enabled). Appends are serialised, so a single trailing partial line
   * is the worst case after a crash.
   */
  async append(record: WalRecord): Promise<void> {
    const line = JSON.stringify(record) + '\n'
    const run = this.#tail.then(async () => {
      const fh = await this.#ensureOpen()
      await fh.write(line, null, 'utf8')
      if (this.#fsync) await fh.sync()
    })
    // Keep the chain alive even if one append rejects, so later appends still run.
    this.#tail = run.catch(() => undefined)
    return run
  }

  async close(): Promise<void> {
    await this.#tail
    if (this.#handle !== null) {
      await this.#handle.close()
      this.#handle = null
    }
  }

  /**
   * Read the journal back for crash recovery.
   *
   * Discards a trailing unparseable line — that is the expected signature of a
   * crash during the final append, and it is safe to drop because the order was
   * by definition not yet submitted. A malformed line anywhere EARLIER is a real
   * corruption and is reported rather than silently skipped.
   */
  static replay(path: string): { records: WalRecord[]; truncatedTail: boolean; corrupt: number[] } {
    if (!existsSync(path)) return { records: [], truncatedTail: false, corrupt: [] }
    const raw = readFileSync(path, 'utf8')
    if (raw.length === 0) return { records: [], truncatedTail: false, corrupt: [] }

    const lines = raw.split('\n')
    // A well-formed file ends with '\n', so the final element is ''.
    const endsClean = lines[lines.length - 1] === ''
    if (endsClean) lines.pop()

    const records: WalRecord[] = []
    const corrupt: number[] = []
    let truncatedTail = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line) as WalRecord)
      } catch {
        const isLast = i === lines.length - 1
        if (isLast && !endsClean) truncatedTail = true
        else corrupt.push(i + 1)
      }
    }
    return { records, truncatedTail, corrupt }
  }
}

/**
 * Reconstruct which intents were journalled but never reached a terminal state.
 * These are the orders that must be reconciled against the broker's order book
 * on startup before new intents are accepted — the recovery step the legacy
 * system cannot perform, because its positions lived only in process memory.
 */
export function unresolvedIntents(records: readonly WalRecord[]): string[] {
  const seen = new Set<string>()
  const resolved = new Set<string>()
  for (const r of records) {
    if (r.kind === 'INTENT') seen.add(r.intent.clientOrderId)
    else if (r.kind === 'REJECTED_BY_RISK') resolved.add(r.intent.clientOrderId)
    else if (r.kind === 'STATUS') {
      if (
        r.status === 'FILLED' ||
        r.status === 'CANCELLED' ||
        r.status === 'REJECTED' ||
        r.status === 'EXPIRED'
      ) {
        resolved.add(r.clientOrderId)
      }
    }
  }
  return [...seen].filter((id) => !resolved.has(id))
}
