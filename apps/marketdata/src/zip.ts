/**
 * The smallest zip reader that can pull one CSV out of BSE's Abridged_CO.ZIP.
 *
 * No zip library is installed and none is worth adding for one 300 KB daily
 * download; `node:zlib` already has `inflateRawSync`, which is the only part
 * of the format that is not bookkeeping. This reads exactly what that archive
 * needs — a single-disk zip, entries stored (method 0) or deflated (method 8),
 * no zip64 — and throws on anything else rather than guessing.
 *
 * It walks the CENTRAL DIRECTORY, not the local headers. A writer that streams
 * (flag bit 3, "data descriptor") leaves the sizes in the local header ZEROED
 * and writes them after the data; the central directory always has the real
 * numbers, which is why the local header is consulted only for the offset of
 * its own name/extra fields.
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** EOCD is 22 bytes plus a comment of at most 65 535: the signature cannot be further back than this. */
const EOCD_SEARCH_LIMIT = 22 + 65_535

/**
 * The decompressed bytes of the first entry whose name matches `name`.
 *
 * Throws when the buffer is not a zip (no end-of-central-directory record —
 * an HTML error page or a truncated download), when no entry matches, or when
 * an entry uses a compression method other than stored/deflate.
 */
export function readZipEntry(zip: Buffer, name: RegExp): Buffer {
  const eocd = findEocd(zip)
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')
  const entries = zip.readUInt16LE(eocd + 10)
  let pos = zip.readUInt32LE(eocd + 16)

  for (let i = 0; i < entries; i++) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new Error(`zip: central directory entry ${i} is malformed at offset ${pos}`)
    }
    const method = zip.readUInt16LE(pos + 10)
    const compressedSize = zip.readUInt32LE(pos + 20)
    const nameLen = zip.readUInt16LE(pos + 28)
    const extraLen = zip.readUInt16LE(pos + 30)
    const commentLen = zip.readUInt16LE(pos + 32)
    const localOffset = zip.readUInt32LE(pos + 42)
    const entryName = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')

    if (name.test(entryName)) {
      if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIG) {
        throw new Error(`zip: local header for '${entryName}' is malformed at offset ${localOffset}`)
      }
      // The local header's own name/extra lengths, which need not equal the
      // central directory's (writers may put the extra field in only one).
      const localNameLen = zip.readUInt16LE(localOffset + 26)
      const localExtraLen = zip.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLen + localExtraLen
      const data = zip.subarray(start, start + compressedSize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data)
      throw new Error(`zip: entry '${entryName}' uses unsupported compression method ${method}`)
    }
    pos += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`zip: no entry matching ${name}`)
}

/** Offset of the EOCD signature, scanning backwards from the end, or -1. */
function findEocd(zip: Buffer): number {
  const floor = Math.max(0, zip.length - EOCD_SEARCH_LIMIT)
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}
