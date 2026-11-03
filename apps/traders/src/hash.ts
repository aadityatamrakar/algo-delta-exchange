import { createHash } from 'node:crypto'

/** Lower-case hex SHA-256 of a string (UTF-8) or a buffer. */
export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
