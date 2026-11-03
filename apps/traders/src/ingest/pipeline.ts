/**
 * Store a file, find the parser that claims it, parse the WHOLE stored text
 * (also after an offset append: the ODIN parsers hold back an unterminated last
 * line and every row is de-duplicated on insert, so only new lines land), hand
 * the result on, and record the outcome on the file row. Serialised per trader.
 */

import type { Log } from '../routes/kit.ts'
import type { StoredFile } from '../types.ts'
import { refusedUntilClose } from './apply.ts'
import type { FileStore } from './files.ts'
import { firstLineOf, ParseError, parserFor, type ParsedFile } from './parsers.ts'

export interface Upload {
  readonly path: string
  readonly mtime: number
  readonly sha256: string
  readonly body: Buffer
  readonly offset: number | null
}
/** `file.parser` is the id of the parser that produced `parsed` (the stored row's is only set after apply). */
export type ApplyParsed = (trader: string, parsed: ParsedFile, file: StoredFile) => Promise<void>
export interface IngestDeps { readonly files: FileStore; readonly apply: ApplyParsed; readonly log: Log }
export interface IngestResult { readonly stored: true; readonly parser: string | null; readonly parseError: string | null }

const SKIPPED_KEPT = 20
const tails = new WeakMap<IngestDeps, Map<string, Promise<unknown>>>()

export async function ingestUpload(d: IngestDeps, trader: string, up: Upload): Promise<IngestResult> {
  return await serialised(d, trader, () => ingestOne(d, trader, up))
}

/**
 * `fn` after every earlier upload or reparse of the trader's has finished. Exported for the settlement recompute
 * (ingest/settle-job.ts), which rewrites the same legs an apply does and so must never interleave with one.
 */
export async function serialised<T>(d: IngestDeps, trader: string, fn: () => Promise<T>): Promise<T> {
  let chains = tails.get(d)
  if (chains === undefined) { chains = new Map(); tails.set(d, chains) }
  const prev = chains.get(trader) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  chains.set(trader, tail)
  try {
    return await run
  } finally {
    if (chains.get(trader) === tail) chains.delete(trader)
  }
}

/**
 * Every stored file whose last parse failed or skipped lines, parsed again from its stored text: a parser that
 * learned a new ODIN layout then reads the files and lines it refused, which the watcher never sends again (it
 * sends a file only when it changes). Run once at start. Re-applying is safe, every row is de-duplicated on
 * insert. Never throws: a file that fails again keeps its (new) error and skips, an internal failure is logged
 * and the next start tries again. `left` is how many files still fail or skip lines afterwards.
 */
export async function reparseProblems(d: IngestDeps): Promise<{ readonly tried: number; readonly left: number }> {
  let unread: StoredFile[]
  try { unread = await d.files.unread() } catch (err) {
    d.log('reading the files with problems failed', { error: String(err) })
    return { tried: 0, left: 0 }
  }
  for (const f of unread) {
    try {
      await serialised(d, f.trader, async () => {
        const got = await d.files.read(f.trader, f.path)
        if (got === null || (got.file.parseError === null && (got.file.skipped?.length ?? 0) === 0)) return   // gone, or an upload read it meanwhile
        await parseAndApply(d, f.trader, got.file, got.text, parserFor(got.file.path, firstLineOf(got.text)), false)
      })
    } catch {
      // logged by parseAndApply
    }
  }
  let left = unread.length
  try { left = (await d.files.unread()).length } catch { /* the count is only for the log line */ }
  return { tried: unread.length, left }
}

async function ingestOne(d: IngestDeps, trader: string, up: Upload): Promise<IngestResult> {
  const { file, changed, text } = await d.files.put(trader, up)
  const parser = parserFor(file.path, firstLineOf(text))
  // An identical resend finishes a parse that never finished: an internal failure, a file no parser
  // claimed until one was registered, or a positions file refused only because its day had not closed.
  // Re-applying is safe, every row is de-duplicated on insert.
  const unfinished = (file.parseError ?? '').startsWith('internal:') || (file.parser === null && parser !== null)
    || refusedUntilClose(file.parseError)
  if (!changed && !unfinished) return { stored: true, parser: file.parser, parseError: file.parseError }
  return await parseAndApply(d, trader, file, text, parser, true)
}

/** Parse the whole text, hand the rows on, record the outcome on the file row; `logRefusal` logs a ParseError. */
async function parseAndApply(
  d: IngestDeps, trader: string, file: StoredFile, text: string, parser: ReturnType<typeof parserFor>, logRefusal: boolean,
): Promise<IngestResult> {
  if (parser === null) {
    await d.files.setParse(trader, file.path, null, null)
    return { stored: true, parser: null, parseError: null }
  }
  try {
    const parsed = parser.parse(text, file.path)
    await d.apply(trader, parsed, { ...file, parser: parser.id })
    await d.files.setParse(trader, file.path, parser.id, null, parsed.skipped?.slice(0, SKIPPED_KEPT))
    return { stored: true, parser: parser.id, parseError: null }
  } catch (err) {
    if (err instanceof ParseError) {
      if (logRefusal) d.log('file did not parse', { trader, path: file.path, parser: parser.id, error: err.message })
      await d.files.setParse(trader, file.path, parser.id, err.message)
      return { stored: true, parser: parser.id, parseError: err.message }
    }
    const message = `internal: ${err instanceof Error ? err.message : String(err)}`
    d.log('INTERNAL ERROR ingesting a file', {
      trader, path: file.path, parser: parser.id, error: message, stack: err instanceof Error ? err.stack : undefined,
    })
    await d.files.setParse(trader, file.path, parser.id, message)
    throw err // the server answers 500, so the watcher retries
  }
}
