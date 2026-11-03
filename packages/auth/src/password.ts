/**
 * Password hashing for the single desk operator.
 *
 * argon2id, from node:crypto. Node 24.9 landed `crypto.argon2`/`argon2Sync`
 * (RFC 9106) in the standard library, so the spec's argon2id requirement is met
 * with ZERO dependencies — nothing native to rebuild, nothing to audit. That is
 * why `engines.node` on this package is `>=24.9` while its siblings say `>=22`.
 *
 * scrypt is kept as a second, explicitly-selectable algorithm rather than
 * deleted: it is what this code would fall back to on a runtime without argon2,
 * and having `verifyPassword` already understand a second algorithm is what
 * makes the stored format genuinely migratable instead of nominally so.
 *
 * The stored string is PHC format — `$alg$params$salt$digest` — so the
 * algorithm, its cost parameters and the salt all travel with the digest. Cost
 * can be raised later and every existing hash still verifies under the
 * parameters it was actually created with; only new hashes get the new cost.
 */

import { argon2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export type PasswordAlgorithm = 'argon2id' | 'scrypt'

export const DEFAULT_ALGORITHM: PasswordAlgorithm = 'argon2id'

/**
 * Argon2id cost. OWASP's first recommended profile: 19 MiB, 2 passes, 1 lane.
 * Measured ~30ms on the desk box — high enough to make offline guessing
 * expensive, low enough that a login does not feel broken.
 */
export interface Argon2Params {
  /** KiB of memory. */
  readonly memory: number
  readonly passes: number
  readonly parallelism: number
  readonly tagLength: number
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memory: 19456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
}

/** scrypt cost. N = 2^logN; 2^16/r=8/p=1 is the OWASP-equivalent profile. */
export interface ScryptParams {
  readonly logN: number
  readonly r: number
  readonly p: number
  readonly tagLength: number
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { logN: 16, r: 8, p: 1, tagLength: 32 }

/**
 * Argon2 version 1.3 == 0x13 == 19 decimal. Node implements only this version;
 * it is written into the string anyway so a future runtime that supports more
 * than one cannot silently verify against the wrong one.
 */
const ARGON2_VERSION = 19

/**
 * 16 bytes, the RFC 9106 recommendation. The salt exists to make two identical
 * passwords hash differently, which is what defeats precomputed tables.
 */
const SALT_BYTES = 16

export interface HashOptions {
  readonly algorithm?: PasswordAlgorithm
  readonly argon2?: Argon2Params
  readonly scrypt?: ScryptParams
}

/** Promise wrapper. The async form runs on the threadpool; argon2Sync would block the event loop for ~30ms per login on a shared server process. */
function argon2Async(
  message: Buffer,
  nonce: Buffer,
  p: Argon2Params,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message,
        nonce,
        parallelism: p.parallelism,
        tagLength: p.tagLength,
        memory: p.memory,
        passes: p.passes,
      },
      (err, derived) => {
        if (err) reject(err)
        else resolve(derived)
      },
    )
  })
}

function scryptAsync(message: Buffer, salt: Buffer, p: ScryptParams): Promise<Buffer> {
  const N = 2 ** p.logN
  return new Promise((resolve, reject) => {
    scrypt(
      message,
      salt,
      p.tagLength,
      // maxmem must be raised explicitly: node's 32 MiB default is below the
      // 128*N*r == 64 MiB this profile needs, and scrypt errors rather than
      // quietly weakening itself.
      { N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 },
      (err, derived) => {
        if (err) reject(err)
        else resolve(derived)
      },
    )
  })
}

const b64 = (b: Buffer): string => b.toString('base64url')

/**
 * base64url decode that REJECTS anything that does not round-trip.
 * `Buffer.from` is lenient — it silently drops invalid characters — so a
 * truncated or edited stored hash would otherwise decode to a shorter buffer
 * and be compared as if it were legitimate.
 */
function unb64(s: string): Buffer | null {
  if (s.length === 0) return null
  const buf = Buffer.from(s, 'base64url')
  return buf.toString('base64url') === s ? buf : null
}

/** Hash a plaintext password into a self-describing PHC string. */
export async function hashPassword(plain: string, opts: HashOptions = {}): Promise<string> {
  const algorithm = opts.algorithm ?? DEFAULT_ALGORITHM
  const salt = randomBytes(SALT_BYTES)
  const message = Buffer.from(plain, 'utf8')

  if (algorithm === 'argon2id') {
    const p = opts.argon2 ?? DEFAULT_ARGON2_PARAMS
    const digest = await argon2Async(message, salt, p)
    return `$argon2id$v=${ARGON2_VERSION}$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(digest)}`
  }
  const p = opts.scrypt ?? DEFAULT_SCRYPT_PARAMS
  const digest = await scryptAsync(message, salt, p)
  return `$scrypt$ln=${p.logN},r=${p.r},p=${p.p}$${b64(salt)}$${b64(digest)}`
}

interface Parsed {
  readonly algorithm: PasswordAlgorithm
  readonly salt: Buffer
  readonly digest: Buffer
  readonly argon2?: Argon2Params
  readonly scrypt?: ScryptParams
}

/** Parse `k=v,k=v` into an all-integers map, or null if any value is not an integer. */
function parseParams(s: string): Map<string, number> | null {
  const out = new Map<string, number>()
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) return null
    const key = pair.slice(0, eq)
    const raw = pair.slice(eq + 1)
    // Number() would accept '1e9', ' 1' and ''. Only plain integers are valid.
    if (!/^\d+$/.test(raw)) return null
    out.set(key, Number(raw))
  }
  return out
}

/** Returns null for anything malformed. Callers turn that into "verify failed", never an exception. */
function parseStored(stored: string): Parsed | null {
  if (typeof stored !== 'string') return null
  const parts = stored.split('$')
  // A PHC string starts with '$', so parts[0] is always the empty string.
  if (parts[0] !== '') return null

  if (parts[1] === 'argon2id') {
    if (parts.length !== 6) return null
    const [, , version, paramStr, saltStr, digestStr] = parts
    if (version !== `v=${ARGON2_VERSION}`) return null
    if (paramStr === undefined || saltStr === undefined || digestStr === undefined) return null
    const p = parseParams(paramStr)
    if (p === null) return null
    const memory = p.get('m')
    const passes = p.get('t')
    const parallelism = p.get('p')
    if (memory === undefined || passes === undefined || parallelism === undefined) return null
    const salt = unb64(saltStr)
    const digest = unb64(digestStr)
    if (salt === null || digest === null || digest.length === 0) return null
    return {
      algorithm: 'argon2id',
      salt,
      digest,
      argon2: { memory, passes, parallelism, tagLength: digest.length },
    }
  }

  if (parts[1] === 'scrypt') {
    if (parts.length !== 5) return null
    const [, , paramStr, saltStr, digestStr] = parts
    if (paramStr === undefined || saltStr === undefined || digestStr === undefined) return null
    const p = parseParams(paramStr)
    if (p === null) return null
    const logN = p.get('ln')
    const r = p.get('r')
    const pp = p.get('p')
    if (logN === undefined || r === undefined || pp === undefined) return null
    // A hostile stored record could otherwise ask for 2^64 bytes of memory.
    if (logN < 1 || logN > 20 || r < 1 || r > 32 || pp < 1 || pp > 16) return null
    const salt = unb64(saltStr)
    const digest = unb64(digestStr)
    if (salt === null || digest === null || digest.length === 0) return null
    return { algorithm: 'scrypt', salt, digest, scrypt: { logN, r, p: pp, tagLength: digest.length } }
  }

  return null
}

/**
 * Verify a plaintext password against a stored PHC string.
 *
 * Never throws for bad input: a corrupted or truncated `passwordHash` column is
 * a failed login, not a 500. Anything that cannot be parsed, and any error from
 * the KDF itself, resolves `false`.
 *
 * The digest comparison is `timingSafeEqual`. The length check in front of it
 * is not a timing leak worth caring about — digest length is a property of the
 * stored format, not of the secret.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored)
  if (parsed === null) return false
  const message = Buffer.from(plain, 'utf8')
  try {
    const candidate =
      parsed.algorithm === 'argon2id'
        ? await argon2Async(message, parsed.salt, parsed.argon2 ?? DEFAULT_ARGON2_PARAMS)
        : await scryptAsync(message, parsed.salt, parsed.scrypt ?? DEFAULT_SCRYPT_PARAMS)
    if (candidate.length !== parsed.digest.length) return false
    return timingSafeEqual(candidate, parsed.digest)
  } catch {
    return false
  }
}

/**
 * The algorithm a stored hash was created with, or null if it is unreadable.
 * Lets an operator screen see "these credentials are on the old KDF" without
 * exposing the digest itself.
 */
export function storedAlgorithm(stored: string): PasswordAlgorithm | null {
  return parseStored(stored)?.algorithm ?? null
}
