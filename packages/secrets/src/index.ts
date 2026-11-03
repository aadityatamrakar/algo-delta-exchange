/**
 * Authenticated encryption for credentials held at rest in Mongo.
 *
 * WHY sealed values instead of a database-level or disk-level encryption: the
 * threat this defends against is a leaked database — a dump, a snapshot, a
 * misconfigured Atlas rule. The master key never enters Mongo, so possession of
 * the data alone is not possession of the broker account.
 *
 * AES-256-GCM, not CBC or CTR: the auth tag is the point. A `desk-brokers` row
 * that has been altered — by an attacker or by a botched migration — must FAIL
 * to open, loudly, rather than decrypt into a plausible-looking wrong password
 * that the order gateway then presents to the broker.
 *
 * THE CRYPTO IS PURE OVER A KEY THE CALLER SUPPLIES, and it stays that way: no
 * function here reads `process.env`. What this package DOES own is the vocabulary
 * around the key — `isSealed` (the `v1.` discriminator), `optionalMasterKey` and
 * `MASTER_KEY_MISMATCH` — because three apps had each grown their own copy of
 * both, and a duplicated discriminator goes stale in the worst possible way
 * (an unrecognised sealed value handed to a broker as a bearer token) while three
 * near-identical log sentences are one sentence nobody can grep. An `env` is
 * always an ARGUMENT here, never a default: a helper that silently reads process
 * state turns every injected-env test into a test of the shell it ran in.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** AES-256 takes a 256-bit key. Not negotiable, hence the hard refusal below. */
const KEY_BYTES = 32
/**
 * 96 bits. The NIST-recommended GCM nonce size — the only length that skips the
 * internal GHASH derivation, and what every interoperable implementation uses.
 */
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Prefix on every sealed string. Two jobs: it makes a sealed field recognisable
 * at a glance in a Mongo shell, and it is fed to GCM as additional authenticated
 * data — so a future v2 blob cannot be replayed as a v1 one by rewriting the
 * prefix. Changing the scheme means a new prefix, and old records still say which
 * scheme sealed them.
 */
const V1 = 'v1'
const V1_AAD = Buffer.from(V1, 'utf8')

/** Thrown when a key is the wrong size or an env value will not decode to one. */
export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretKeyError'
  }
}

/**
 * Thrown when a sealed value cannot be opened.
 *
 * `reason` separates "this string was never a sealed value / has been truncated"
 * from "the ciphertext did not authenticate". Both are unreadable and neither is
 * absent — which is the distinction §7 of the spec needs: "no XTS configured" and
 * "XTS configured but unreadable" are different operator problems.
 */
export type SecretOpenFailure = 'malformed' | 'auth'

export class SecretOpenError extends Error {
  readonly reason: SecretOpenFailure
  constructor(message: string, reason: SecretOpenFailure) {
    super(message)
    this.name = 'SecretOpenError'
    this.reason = reason
  }
}

function assertKey(key: Buffer | Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) {
    // Deliberately not padded or hashed into shape. Silently stretching a short
    // key would let a weak or half-copied DESK_MASTER_KEY protect a live trading
    // account while looking like it worked.
    throw new SecretKeyError(
      `master key must be exactly ${KEY_BYTES} bytes, got ${key.byteLength}`,
    )
  }
  return Buffer.isBuffer(key) ? key : Buffer.from(key.buffer, key.byteOffset, key.byteLength)
}

/**
 * Seal `plaintext` under `key`. Output is `v1.<base64(iv || tag || ciphertext)>`.
 *
 * The IV is random per call, so sealing the same credential twice yields two
 * different strings — an observer of the database cannot tell that two brokers
 * share a password, and an update is not distinguishable from a no-op write.
 */
export function seal(plaintext: string, key: Buffer | Uint8Array): string {
  const k = assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  cipher.setAAD(V1_AAD)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  // IV and tag travel WITH the ciphertext: a sealed value is one self-contained
  // string, so nothing downstream has to remember to carry two more columns.
  return `${V1}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
}

/**
 * Does this value CLAIM to be sealed?
 *
 * The `v1.` magic lives here and nowhere else. It had started to spread — the
 * order gateway spelled the prefix itself to tell a sealed session token from a
 * legacy plaintext one — and a discriminator duplicated into another app is a
 * discriminator that goes stale the day the scheme grows a `v2`, in the worst
 * possible way: an unrecognised sealed value is not "unreadable", it is a
 * ciphertext handed to a broker as a bearer token.
 *
 * SHAPE ONLY. `open` is what decides whether the bytes are any good; this
 * answers "was this INTENDED to be sealed?", which is the question that decides
 * whether a failure to open is a hard failure or a plaintext migration.
 */
export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${V1}.`)
}

/**
 * Open a value produced by `seal`. Throws `SecretOpenError` — never returns a
 * partial or garbage plaintext — if the string is not a v1 sealed value, has been
 * tampered with, or was sealed under a different key.
 */
export function open(sealed: string, key: Buffer | Uint8Array): string {
  const k = assertKey(key)
  if (!isSealed(sealed)) {
    throw new SecretOpenError('not a v1 sealed value', 'malformed')
  }
  const raw = decodeBase64(sealed.slice(V1.length + 1))
  if (raw === null || raw.byteLength < IV_BYTES + TAG_BYTES) {
    throw new SecretOpenError('sealed value is truncated or not base64', 'malformed')
  }
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = raw.subarray(IV_BYTES + TAG_BYTES)

  const decipher = createDecipheriv('aes-256-gcm', k, iv)
  decipher.setAAD(V1_AAD)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // `final()` is where GCM verifies the tag. A wrong key and a flipped byte are
    // indistinguishable here, and should be: both mean "do not trust this row".
    throw new SecretOpenError('sealed value failed authentication', 'auth')
  }
}

/**
 * Turn the raw `DESK_MASTER_KEY` env string into a validated 32-byte key.
 *
 * Accepts 64 hex characters or base64/base64url that decodes to 32 bytes, because
 * both are what `openssl rand` hands you and both survive a .env file. A 64-char
 * hex string is ALSO valid base64 (decoding to 48 bytes), so hex is tested first —
 * otherwise the obvious `openssl rand -hex 32` output would be rejected.
 */
export function keyFromEnvValue(value: string): Buffer {
  const v = typeof value === 'string' ? value.trim() : ''
  if (v === '') throw new SecretKeyError('master key is empty')

  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex')

  const decoded = decodeBase64(v)
  if (decoded === null) {
    throw new SecretKeyError('master key must be 64 hex chars or base64 of 32 bytes')
  }
  if (decoded.byteLength !== KEY_BYTES) {
    throw new SecretKeyError(
      `master key must decode to ${KEY_BYTES} bytes, got ${decoded.byteLength}`,
    )
  }
  return decoded
}

// ------------------------------------------------- what the desk says about keys
//
// THE SAME KEY GUARDS THREE THINGS — the broker credentials in `desk-brokers`,
// the XTS session token in `desk-broker-session`, and the Zerodha cookie jar on
// disk — and until now each site worded its own two sentences about it: "no key,
// so this stays plaintext" and "this will not open". Three near-identical
// wordings is one wording nobody can grep. An operator reading `pm2 logs` at
// 09:15 needs ONE sentence, said the same way, whichever subsystem said it.

/** The env var every sealed value on this desk is keyed from. */
export const MASTER_KEY_ENV = 'DESK_MASTER_KEY'

/**
 * The core of every "this will not open" message on the desk.
 *
 * `brokerstore.describeOpenFailure`, `session-store.readSessionTokenField` and
 * `zerodha-native.decodeJarFile` each prefix their own subject and suffix their
 * own detail, but this sentence is the greppable middle they share.
 */
export const MASTER_KEY_MISMATCH = 'will not decrypt with the current DESK_MASTER_KEY'

export type MasterKeyLog = (msg: string, ctx?: Record<string, unknown>) => void

/**
 * The master key, or `null` WITH A LOUD LINE — for the two places on the desk
 * where a missing key must degrade a security property rather than stop a
 * process.
 *
 * DELIBERATELY NOT FATAL, and deliberately not the default. The API fails at
 * boot without a key (see `requireMasterKey`), because credentials it cannot
 * open are credentials it cannot use. But the market-data login is the feed's
 * single point of failure and the order gateway is the only process that can
 * place orders: a desk trading blind, or unable to place an order, because a key
 * was not set is strictly worse than a plaintext cookie jar or session token. So
 * those two fall back to plaintext — exactly what they do today — and say so on
 * every boot, because an unaudited trade-off stops being a trade-off and becomes
 * a defect nobody remembers making.
 *
 * `subject` is the noun this call is about ("the XTS session token"). It is the
 * ONLY part of the line that varies.
 */
export function optionalMasterKey(
  env: NodeJS.ProcessEnv,
  log: MasterKeyLog,
  subject: string,
): Buffer | null {
  const raw = env[MASTER_KEY_ENV]
  let error: string
  if (raw === undefined || raw.trim() === '') {
    error = `${MASTER_KEY_ENV} is not set`
  } else {
    try {
      return keyFromEnvValue(raw)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
  log(
    `${MASTER_KEY_ENV} is missing or malformed — ${subject} will be stored in PLAINTEXT ` +
      `(set it in .env.local; generate one with: openssl rand -hex 32)`,
    { error },
  )
  return null
}

/**
 * Strict base64/base64url decode; null if the input is not valid base64.
 *
 * Node's decoder silently DISCARDS characters outside the alphabet, so
 * `Buffer.from(junk, 'base64')` happily returns a short buffer instead of an
 * error. Validating the charset first is what turns a mangled env var or a
 * truncated Mongo field into a refusal rather than a wrong-length key.
 */
function decodeBase64(s: string): Buffer | null {
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(s)) return null
  const buf = Buffer.from(s, 'base64')
  // Round-trip guards the tail: base64 length % 4 === 1 is impossible, and
  // trailing bits that no byte boundary can hold would otherwise decode quietly.
  const canonical = buf.toString('base64')
  const normalised = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), '=')
  return canonical === padded ? buf : null
}
