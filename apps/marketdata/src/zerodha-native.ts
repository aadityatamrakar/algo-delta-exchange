/**
 * The Kite login, on `fetch` and `node:crypto` — no `request`, no `debug@2`.
 *
 * WHAT THIS REPLACES AND WHY. `packages/marketdata-core/vendor/zerodha.js` is a
 * 999-line CommonJS client of which this desk uses exactly three things: the
 * password→TOTP→enctoken dance, the enctoken cookie, and `historyData`. It
 * drags in `request` (deprecated since 2020), `debug@2` (CVE-2017-16137),
 * `tough-cookie-filestore@0.0.1` and `authenticator`+`notp`+`thirty-two` — four
 * unmaintained packages sitting on the credential path of a live trading
 * account, for a flow that is three HTTP calls and one HMAC. Audit F-53 /
 * roadmap 18b.
 *
 * THIS FILE IS THE FEED'S SINGLE POINT OF FAILURE — context/14 and the
 * 2026-08-04/05 outages. One Kite login serves every socket, the margin sweep,
 * the history endpoint and the enctoken canary; when the token dies the whole
 * desk is blind, and the only thing that mints a new one is this code path. So
 * it is written to be BORING and to be DROP-IN:
 *
 *   - the same request sequence, in the same order, with the same headers and
 *     form fields the vendored client sent (see each step below);
 *   - the same persisted `userdata/<user_id>.json` — literally the
 *     `tough-cookie` store index, so a jar this writes is read by the vendored
 *     client and vice versa, and `DESK_LEGACY_ZERODHA_LOGIN=1` is a fallback
 *     rather than a fresh login;
 *   - the same live-session reuse (probe `/oms/user/profile/full` first), which
 *     `routes/brokers.ts` documents in its "test" response and which stops a
 *     restart from invalidating the token running sockets are holding;
 *   - errors classified the way `FeedRecovery` already reads them: a credential
 *     fault says so in words its `AUTH_SHAPED` regex matches (and earns "the
 *     credentials need a HUMAN"), a timeout, an unreachable host, a 429 or a
 *     5xx deliberately does NOT.
 *
 * WHAT IS DELIBERATELY DIFFERENT (all four are documented at their site):
 *   1. every request has an `AbortSignal` timeout, ARMED ACROSS THE BODY READ
 *      as well as the connect — the vendored client had none, and a hung socket
 *      there wedged recovery until `loginTimeoutMs` (see `readBody`: a reply
 *      whose headers arrive and whose body never does is the half a timer
 *      cleared around `fetch` alone does not cover);
 *   2. the session probe is SKIPPED when the jar holds no enctoken, because it
 *      can only fail;
 *   3. a probe that cannot be REACHED falls through to a real login instead of
 *      rejecting the whole call (the vendored `checkSession` rejected);
 *   4. the 6-digit code is zero-padded — `notp` truncated the decimal string
 *      with `substr(len-6)`, which yields a FIVE-digit code roughly once every
 *      21,000 steps and Kite rejects it with no explanation.
 *
 * WHAT NO TEST HERE CAN PROVE: that Zerodha accepts these bytes. Every pure
 * piece below is unit-tested and the flow is tested against a scripted `fetch`,
 * but the first real proof is the next real login. `DESK_LEGACY_ZERODHA_LOGIN=1`
 * exists for exactly that morning — and `zerodha-login.ts` now takes that
 * fallback AUTOMATICALLY, once, for a failure that spent nothing, which is what
 * `twofaWasSent` below is for: past the second-factor POST the retry stops
 * being free and the caller must not take it.
 *
 * READ-ONLY BY CONSTRUCTION (spec D1), like the module that calls it: the only
 * endpoints named in this file are the login chain and a GET for historical
 * candles. There is no code path from here to an order.
 *
 * THE JAR IS SEALED ON THIS PATH, AND ONLY ON THIS PATH (audit F-46). The file
 * holds the ENCTOKEN — the credential every socket, the margin sweep, the
 * history endpoint and the canary use, and enough on its own to read this
 * account's whole portfolio — and it was plaintext JSON while the password that
 * mints it was sealed in `desk-brokers`. `saveCookieIndex` now writes an
 * envelope (`{v:1, sealed:'v1.…'}`) under `DESK_MASTER_KEY`, and
 * `loadCookieIndex` accepts either shape, so the file on a live box converts
 * itself on the next login with no manual step.
 *
 * THE VENDORED FALLBACK KEEPS ITS PLAINTEXT JAR, and the interaction is real
 * rather than theoretical: `tough-cookie-filestore@0.0.1` walks the file as
 * `for (domain in json) for (path in json[domain]) …`, so an envelope's
 * `sealed` STRING is walked by character index and its assignment throws
 * `TypeError: Cannot assign to read only property '0' of string` at
 * CONSTRUCTION. The vendored client does not DIE of that — `zerodha.js`'s
 * `loadCookie()` (lines 31-38) catches it, writes `{}` over the file and
 * reconstructs — so the real cost of handing it an envelope is the SESSION,
 * silently wiped, and therefore a full password+TOTP login. On a fallback that
 * fires on a transient blip while the jar holds a LIVE enctoken, that login is
 * the one that killed the running sockets on 2026-08-04.
 *
 * So `unsealJarForLegacy` below — which `zerodha-login.ts` calls before handing
 * over — DECRYPTS the envelope in place rather than emptying it: the legacy run
 * reuses the session, and the native path re-seals the plaintext jar it leaves
 * behind on its next save. Only an envelope that genuinely will not open is
 * cleared, and that one really does spend a login, and says so. Sealing on both
 * paths completes when the vendored client retires (roadmap 18b) and this whole
 * dance goes with it.
 */

import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MASTER_KEY_MISMATCH, open, optionalMasterKey, seal } from '@algomaker/secrets'

// ---------------------------------------------------------------- constants

/**
 * The vendored client's own constants, copied verbatim. The user-agent and
 * `x-kite-version` are part of what Kite's WAF sees; changing them is a change
 * to the login, not a tidy-up.
 */
const KITE_VERSION = '2.8.0'
const REQ_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36'
const HOME_URL = 'https://kite.zerodha.com/'
const LOGIN_URL = 'https://kite.zerodha.com/api/login'
const TWOFA_URL = 'https://kite.zerodha.com/api/twofa'
const PROFILE_URL = 'https://kite.zerodha.com/oms/user/profile/full'
const HISTORY_URL = 'https://kite.zerodha.com/oms/instruments/historical/'
const CHART_REFERER = 'https://kite.zerodha.com/static/build/chart.html?v=2.4.0'

/** Where the enctoken lives once the chain completes. */
const ENCTOKEN_DOMAIN = 'kite.zerodha.com'
const ENCTOKEN_PATH = '/'
const ENCTOKEN_KEY = 'enctoken'

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * A positive millisecond duration from the environment, or the default.
 *
 * Same shape (and same reasoning) as `positiveEnvMs` in `main.ts`: a typo'd
 * value falls back rather than becoming `NaN`, because every comparison against
 * NaN is false and a mistyped timeout would silently DISABLE the bound it
 * configures. Copied rather than imported — importing `main.ts` for one helper
 * would pull the whole process entry point into the login path.
 */
export function positiveEnvMs(
  name: string,
  dflt: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

// --------------------------------------------------------------- RFC 6238

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * The secret as the vendored path treated it.
 *
 * `authenticator.generateToken` did `key.replace(/\W+/g,'').toUpperCase()` and
 * the caller lowercased first, so grouping spaces, dashes and base32 padding
 * are all noise — which matters because an operator pastes the grouped form
 * Kite displays ("gezd gnbv gy3t qojq") straight into the Brokers page.
 */
export function normalizeBase32Secret(raw: string): string {
  return raw.replace(/\W+/g, '').toUpperCase()
}

/** RFC 4648 base32 decode, unpadded — the inverse of `base32Encode`. */
export function base32Decode(secret: string): Uint8Array {
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of secret) {
    const i = B32_ALPHABET.indexOf(ch)
    if (i < 0) {
      throw new Error(
        `the zerodha totp secret is not valid base32 (bad character ${JSON.stringify(ch)})`,
      )
    }
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/**
 * RFC 6238 TOTP: HMAC-SHA-1, 30-second steps, dynamic truncation, 6 digits.
 *
 * ZERO-PADDED, unlike the `notp` this replaces. `notp` truncated the decimal
 * form of the 31-bit value with `substr(len - 6)`, so a value below 100,000
 * produced a five-character code — a login Kite rejects with "invalid TOTP",
 * once every ~21,000 steps, with nothing in the logs to suggest the arithmetic
 * rather than the secret was at fault.
 *
 * Verified against RFC 6238's Appendix B vectors AND against the vendored
 * `authenticator` at the current time, in `test/zerodha-native.test.ts`.
 */
export function totp(
  secretBase32: string,
  opts: { atMs?: number; digits?: number; stepSeconds?: number } = {},
): string {
  const normalized = normalizeBase32Secret(secretBase32)
  if (normalized === '') throw new Error('the zerodha totp secret is empty')
  const key = base32Decode(normalized)
  const digits = opts.digits ?? 6
  const step = opts.stepSeconds ?? 30
  const counter = Math.floor(Math.floor((opts.atMs ?? Date.now()) / 1000) / step)

  // 8-byte big-endian counter. Written in two 32-bit halves because a bitwise
  // shift in JS is 32-bit and `counter` outlives that in the year 2255.
  const block = Buffer.alloc(8)
  block.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0)
  block.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', Buffer.from(key)).update(block).digest()
  const offset = (digest[19] as number) & 0x0f
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

// ---------------------------------------------------------------- cookie jar

/**
 * The persisted jar, which is `tough-cookie`'s own store index:
 * `{ domain: { path: { name: cookie } } }`.
 *
 * MODELLED AS RAW BLOBS ON PURPOSE. The vendored client writes whatever
 * `tough-cookie@0.12.1` serialises, and a future field it grows (or one this
 * file does not model) must survive a native login untouched — otherwise
 * flipping `DESK_LEGACY_ZERODHA_LOGIN` back and forth quietly rewrites the
 * operator's jar. Reads go through the typed accessors below.
 */
export type CookieBlob = Record<string, unknown>
export type CookieIndex = Record<string, Record<string, Record<string, CookieBlob>>>

/**
 * The order `tough-cookie` emits, so a diff of the jar file against one the
 * vendored client wrote is empty rather than merely equivalent. (Its
 * `serializableProperties` list, minus the fields a Kite cookie never carries.)
 */
const BLOB_ORDER = [
  'key',
  'value',
  'expires',
  'maxAge',
  'domain',
  'path',
  'secure',
  'httpOnly',
  'extensions',
  'hostOnly',
  'pathIsDefault',
  'creation',
  'lastAccessed',
] as const

function str(blob: CookieBlob, key: string): string {
  const v = blob[key]
  return typeof v === 'string' ? v : ''
}

/** RFC 6265 §5.1.4 default-path: everything up to the rightmost '/'. */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/'
  const cut = pathname.lastIndexOf('/')
  return cut <= 0 ? '/' : pathname.slice(0, cut)
}

/** RFC 6265 §5.1.3, minus the public-suffix check Kite's two hosts cannot need. */
function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

/**
 * Parse ONE `Set-Cookie` line into the blob the jar file holds.
 *
 * Returns null for a line that carries no name/value pair and for a `Domain`
 * the responding host has no business setting — a jar that accepted
 * `Domain=example.com` from `kite.zerodha.com` would send the enctoken to a
 * host that never issued it.
 */
export function parseSetCookie(
  line: string,
  requestUrl: string,
  nowMs: number,
): { domain: string; path: string; blob: CookieBlob } | null {
  const url = new URL(requestUrl)
  const host = url.hostname.toLowerCase()
  const parts = line.split(';')
  const pair = (parts[0] ?? '').trim()
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const key = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1).trim()
  if (key === '') return null

  let expires: string | undefined
  let maxAge: number | undefined
  let domain: string | undefined
  let path: string | undefined
  let secure = false
  let httpOnly = false
  const extensions: string[] = []

  for (const raw of parts.slice(1)) {
    const attr = raw.trim()
    if (attr === '') continue
    const at = attr.indexOf('=')
    const name = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase()
    const av = at < 0 ? '' : attr.slice(at + 1).trim()
    if (name === 'expires') {
      const ms = Date.parse(av)
      if (Number.isFinite(ms)) expires = new Date(ms).toISOString()
    } else if (name === 'max-age') {
      const n = Number(av)
      if (Number.isInteger(n)) maxAge = n
    } else if (name === 'domain') {
      const d = av.replace(/^\./, '').toLowerCase()
      if (d !== '') domain = d
    } else if (name === 'path') {
      if (av.startsWith('/')) path = av
    } else if (name === 'secure') {
      secure = true
    } else if (name === 'httponly') {
      httpOnly = true
    } else {
      // Everything else is kept VERBATIM, exactly as tough-cookie does —
      // `SameSite=None` is in every cookie in the live jar file.
      extensions.push(attr)
    }
  }

  if (domain !== undefined && !domainMatches(host, domain)) return null
  const at = new Date(nowMs).toISOString()
  const blob: CookieBlob = { key, value }
  if (expires !== undefined) blob['expires'] = expires
  if (maxAge !== undefined) blob['maxAge'] = maxAge
  blob['domain'] = domain ?? host
  blob['path'] = path ?? defaultPath(url.pathname)
  if (secure) blob['secure'] = true
  if (httpOnly) blob['httpOnly'] = true
  if (extensions.length > 0) blob['extensions'] = extensions
  blob['hostOnly'] = domain === undefined
  if (path === undefined) blob['pathIsDefault'] = true
  blob['creation'] = at
  blob['lastAccessed'] = at
  return { domain: blob['domain'] as string, path: blob['path'] as string, blob: order(blob) }
}

function order(blob: CookieBlob): CookieBlob {
  const out: CookieBlob = {}
  for (const field of BLOB_ORDER) if (field in blob) out[field] = blob[field]
  for (const [k, v] of Object.entries(blob)) if (!(k in out)) out[k] = v
  return out
}

/**
 * Fold a response's `Set-Cookie` lines into the jar.
 *
 * Returns a NEW index (the caller threads it through the chain), and preserves
 * the original `creation` of a cookie it replaces — `tough-cookie`'s
 * `updateCookie` semantics, and the timestamp the header order is decided by.
 */
export function mergeSetCookies(
  idx: CookieIndex,
  lines: readonly string[],
  requestUrl: string,
  nowMs: number,
): CookieIndex {
  const next: CookieIndex = { ...idx }
  for (const line of lines) {
    const parsed = parseSetCookie(line, requestUrl, nowMs)
    if (parsed === null) continue
    const domain = { ...(next[parsed.domain] ?? {}) }
    const path = { ...(domain[parsed.path] ?? {}) }
    const previous = path[parsed.blob['key'] as string]
    const blob =
      previous === undefined
        ? parsed.blob
        : order({ ...parsed.blob, creation: previous['creation'] ?? parsed.blob['creation'] })
    path[blob['key'] as string] = blob
    domain[parsed.path] = path
    next[parsed.domain] = domain
  }
  return next
}

function expiryMs(blob: CookieBlob): number {
  const maxAge = blob['maxAge']
  if (typeof maxAge === 'number') {
    const created = Date.parse(str(blob, 'creation'))
    return (Number.isFinite(created) ? created : 0) + maxAge * 1000
  }
  const expires = blob['expires']
  if (typeof expires === 'string') {
    const ms = Date.parse(expires)
    return Number.isFinite(ms) ? ms : Infinity
  }
  return Infinity
}

/** The `Cookie` header for one request, in `tough-cookie`'s ordering. */
export function cookieHeader(idx: CookieIndex, requestUrl: string, nowMs: number): string {
  const url = new URL(requestUrl)
  const host = url.hostname.toLowerCase()
  const secureTransport = url.protocol === 'https:'
  const matched: CookieBlob[] = []
  for (const [domain, paths] of Object.entries(idx)) {
    for (const [path, cookies] of Object.entries(paths)) {
      for (const blob of Object.values(cookies)) {
        const hostOnly = blob['hostOnly'] === true
        if (hostOnly ? host !== domain : !domainMatches(host, domain)) continue
        if (!pathMatches(url.pathname, path)) continue
        if (blob['secure'] === true && !secureTransport) continue
        if (expiryMs(blob) <= nowMs) continue
        matched.push(blob)
      }
    }
  }
  // Longest path first, then oldest first — `cookieCompare`. A server that
  // reads only the first value of a repeated name sees what tough-cookie's
  // ordering makes it see.
  matched.sort((a, b) => {
    const byPath = str(b, 'path').length - str(a, 'path').length
    if (byPath !== 0) return byPath
    return (Date.parse(str(a, 'creation')) || 0) - (Date.parse(str(b, 'creation')) || 0)
  })
  return matched.map((c) => `${str(c, 'key')}=${str(c, 'value')}`).join('; ')
}

/** One cookie's value, or `''` — the native form of `getAuthorization()`. */
export function cookieValue(idx: CookieIndex, domain: string, path: string, key: string): string {
  const blob = idx[domain]?.[path]?.[key]
  return blob === undefined ? '' : str(blob, 'value')
}

/**
 * The vendored jar path: `packages/marketdata-core/userdata/<user_id>.json`.
 *
 * SAME FILE, deliberately. Both paths must see the same session, or flipping
 * `DESK_LEGACY_ZERODHA_LOGIN` costs a real password+TOTP login and invalidates
 * the token the running sockets hold.
 */
export function userdataPath(userId: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolvePath(here, '../../../packages/marketdata-core/userdata', `${userId}.json`)
}

// -------------------------------------------------------------- jar at rest

type JarLog = (msg: string, ctx?: Record<string, unknown>) => void

export interface JarSealOptions {
  /** `null` (or omitted) means plaintext — see `jarMasterKey`. */
  readonly key?: Buffer | null
  readonly log?: JarLog
}

/**
 * The sealed jar file: a small JSON envelope rather than a bare ciphertext.
 *
 * A READER MUST BE ABLE TO TELL THE SHAPES APART WITHOUT GUESSING. The plaintext
 * jar is `{domain: {path: {name: blob}}}` and a bare `v1.…` string is not JSON
 * at all, so an envelope with an explicit `v` is what lets `decodeJarFile` say
 * "sealed but unopenable" instead of "corrupt" — the difference between
 * "your key is wrong" and "your file is damaged", which are different problems
 * with different fixes.
 */
export interface SealedJarFile {
  readonly v: 1
  readonly sealed: string
}

/**
 * `corrupt` and `unreadable` are DISTINCT, and the distinction decides whether
 * the file is rewritten. Bytes that are not a jar at all (truncated write, a
 * half-flushed file, something hand-edited) are repaired with `{}` — the
 * vendored `loadCookie()` does the same, and `tough-cookie-filestore` THROWS on
 * a file it cannot parse. A sealed envelope that will not open is not damaged:
 * it is the only evidence of whether a key was rotated or the jar was copied
 * from another box, so it is left exactly as it is.
 */
export type JarDecode =
  | { readonly kind: 'plain'; readonly idx: CookieIndex }
  | { readonly kind: 'sealed'; readonly idx: CookieIndex }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'unreadable'; readonly reason: string }

function isSealedEnvelope(v: unknown): v is SealedJarFile {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)['v'] === 1 &&
    typeof (v as Record<string, unknown>)['sealed'] === 'string'
  )
}

/** The bytes to write for this jar: an envelope with a key, the index without. */
export function encodeJarFile(idx: CookieIndex, key: Buffer | null): string {
  if (key === null) return JSON.stringify(idx)
  const envelope: SealedJarFile = { v: 1, sealed: seal(JSON.stringify(idx), key) }
  return JSON.stringify(envelope)
}

/**
 * Read either shape.
 *
 * A plaintext index is accepted even when a key is configured, because that is
 * the F-46 MIGRATION: the file on the box right now is plaintext, and a feed
 * that refuses to read it spends a real password+TOTP login at boot for nothing.
 * The next `saveCookieIndex` seals it.
 */
export function decodeJarFile(text: string, key: Buffer | null): JarDecode {
  let parsed: unknown
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text)
  } catch (err) {
    return { kind: 'corrupt', reason: `the jar file is not JSON: ${String(err)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: 'the jar file is not an object' }
  }
  if (!isSealedEnvelope(parsed)) return { kind: 'plain', idx: parsed as CookieIndex }
  if (key === null) {
    return {
      kind: 'unreadable',
      reason: 'the cookie jar is sealed and DESK_MASTER_KEY is not set',
    }
  }
  try {
    const inner: unknown = JSON.parse(open(parsed.sealed, key))
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
      return { kind: 'unreadable', reason: 'the sealed jar did not contain a cookie index' }
    }
    return { kind: 'sealed', idx: inner as CookieIndex }
  } catch (err) {
    return {
      kind: 'unreadable',
      // One sentence for the whole desk (`@algomaker/secrets`): the broker store
      // and the XTS session token report the same failure about the same key.
      reason: `the cookie jar ${MASTER_KEY_MISMATCH} (${err instanceof Error ? err.name : 'error'})`,
    }
  }
}

/**
 * Load the jar, tolerating everything.
 *
 * A missing or unparseable file becomes an empty jar AND is rewritten as `{}`,
 * which is what `loadCookie()` does in the vendored file — because
 * `tough-cookie-filestore` throws on a missing one, and that throw is what made
 * `desk-marketdata` unbootable on a fresh clone (pm2 restarts it ten times
 * inside `min_uptime`, then marks it `errored` and stops).
 *
 * A SEALED JAR THAT WILL NOT OPEN is different, and is NOT rewritten: the file
 * is the only evidence of whether a key was rotated or a jar was copied from
 * another box, the next successful login overwrites it anyway, and there is
 * nothing to create because the file already exists. It reads as an empty jar —
 * i.e. one fresh login — and says why, loudly. A feed that throws here is a feed
 * that never logs in at all.
 */
export interface JarLoad {
  readonly idx: CookieIndex
  /**
   * The file on disk is an envelope this process COULD NOT OPEN, and is being
   * kept as evidence. The caller must not save over it unless it has something
   * strictly better to put there — i.e. a login that actually succeeded. See
   * `nativeZerodhaLogin`'s `finally`, which is where this promise was being
   * broken.
   */
  readonly unreadable: boolean
}

export function loadCookieJar(path: string, opts: JarSealOptions = {}): JarLoad {
  const key = opts.key ?? null
  const repair = (): JarLoad => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '{}')
    } catch {
      // A jar we cannot write is a login that cannot be reused, not a login
      // that cannot happen. Say nothing here; `saveCookieIndex` logs.
    }
    return { idx: {}, unreadable: false }
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return repair()
  }
  const decoded = decodeJarFile(text, key)
  if (decoded.kind === 'corrupt') return repair()
  if (decoded.kind === 'unreadable') {
    opts.log?.(
      `STORED ZERODHA COOKIE JAR UNREADABLE — ${decoded.reason}. Treating it as empty and ` +
        'logging in fresh; nothing is broken, but a key was rotated or this jar came from ' +
        'another box.',
      { path },
    )
    return { idx: {}, unreadable: true }
  }
  return { idx: decoded.idx, unreadable: false }
}

/** The index alone, for the callers that have no file to preserve. */
export function loadCookieIndex(path: string, opts: JarSealOptions = {}): CookieIndex {
  return loadCookieJar(path, opts).idx
}

export function saveCookieIndex(path: string, idx: CookieIndex, opts: JarSealOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, encodeJarFile(idx, opts.key ?? null))
}

/**
 * `DESK_MASTER_KEY` for the jar, or null — and null is LOUD, every boot.
 *
 * DELIBERATELY NOT FATAL, and this is one of the two places on the desk where a
 * missing key degrades a security property rather than stopping the process.
 * This login is the feed's single point of failure (see the header): a desk
 * trading blind because a key was not set is strictly worse than a desk with a
 * plaintext cookie jar. So the jar falls back to plaintext — exactly what it is
 * today — and says so on every single boot. `optionalMasterKey` owns that
 * trade-off and its wording, shared with the XTS session token next door.
 *
 * `env` IS REQUIRED AND HAS NO `process.env` DEFAULT, which is not a style
 * preference: the default made the seal key a property of the SHELL. A developer
 * or CI job with `DESK_MASTER_KEY` exported got a sealed jar out of tests that
 * pass their own `env` and assert on plaintext cookie bytes (two in
 * `zerodha-native.test.ts` went red for nobody's fault), and, worse, `env` is the
 * seam this whole flow is tested through — a seam that quietly reads process
 * state is not a seam. Production passes `process.env` explicitly, from
 * `zerodha-login.ts`.
 */
export function jarMasterKey(env: NodeJS.ProcessEnv, log?: JarLog): Buffer | null {
  return optionalMasterKey(env, log ?? ((): void => {}), 'the Zerodha cookie jar (which holds the ENCTOKEN)')
}

/** What `unsealJarForLegacy` did to the file the vendored client is about to read. */
export type JarUnsealOutcome = 'untouched' | 'decrypted' | 'cleared'

/**
 * Make the jar readable by the VENDORED client — by DECRYPTING it, not emptying it.
 *
 * Called by `zerodha-login.ts` before it hands over to the legacy path, because
 * `tough-cookie-filestore@0.0.1` walks the file as
 * `for (domain in json) for (path in json[domain]) …` and an envelope's `sealed`
 * STRING is walked by character index, whose assignment throws
 * `TypeError: Cannot assign to read only property '0' of string` inside its
 * constructor. The vendored client SURVIVES that — `zerodha.js`'s `loadCookie()`
 * (lines 31-38) catches the throw, writes `{}` over the file and reconstructs —
 * so what an envelope actually costs is not a crash. It is the SESSION.
 *
 * WHICH IS THE WHOLE POINT, and why this decrypts. The fallback fires on a
 * TRANSIENT native failure — an unreachable session probe, a blip on the home
 * page — and the jar it is handed is usually holding a LIVE enctoken: the token
 * every running socket, the margin sweep and the canary are using. Emptying it
 * makes the vendored client spend a full password+TOTP login, and per the
 * 2026-08-04 incident that login INVALIDATES the token those sockets hold. A
 * blip would become a feed outage, on the path that exists to prevent outages.
 * Writing the plaintext index is no worse at rest than what clearing led to
 * anyway (the vendored client writes a plaintext jar either way); it just does
 * not throw a live session away first, and the native path re-seals on its next
 * save.
 *
 * `cleared` is reserved for the envelope that genuinely WILL NOT OPEN — a
 * rotated key, a jar copied from another box, no key at all. There is no session
 * to preserve there, that attempt really does spend a login, and the log says so.
 */
export function unsealJarForLegacy(
  path: string,
  opts: { key?: Buffer | null; log?: JarLog } = {},
): JarUnsealOutcome {
  const log = opts.log
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return 'untouched'
  }
  const decoded = decodeJarFile(text, opts.key ?? null)
  // `plain` is already readable, and `corrupt` is the shape the vendored
  // `loadCookie()` repairs itself. Neither is this function's business.
  if (decoded.kind === 'plain' || decoded.kind === 'corrupt') return 'untouched'

  if (decoded.kind === 'sealed') {
    try {
      writeFileSync(path, JSON.stringify(decoded.idx))
    } catch (err) {
      // Left sealed: the vendored client's own catch repairs the file to `{}`
      // and logs in fresh. Worse than reuse, but not a failure to log in.
      log?.('zerodha login: the sealed cookie jar could not be opened for the vendored client', {
        path,
        error: err instanceof Error ? err.message : String(err),
      })
      return 'untouched'
    }
    log?.(
      'zerodha login: the cookie jar is SEALED and the vendored client cannot read it — DECRYPTED ' +
        'it in place, so this fallback REUSES the stored session instead of spending a fresh ' +
        'password+TOTP login on a live account (F-46; the native path re-seals it on its next save)',
      { path },
    )
    return 'decrypted'
  }

  // `unreadable`: there is no session in there to hand over.
  try {
    writeFileSync(path, '{}')
  } catch (err) {
    log?.('zerodha login: the sealed cookie jar could not be cleared for the vendored client', {
      path,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'untouched'
  }
  log?.(
    `zerodha login: the cookie jar is sealed and ${decoded.reason} — cleared it, so this fallback ` +
      'attempt spends a REAL login rather than reusing the session (F-46; the native path ' +
      're-seals the jar on its next save)',
    { path },
  )
  return 'cleared'
}

// -------------------------------------------------------------------- errors

/**
 * A failure a HUMAN has to fix, worded so `FeedRecovery`'s `AUTH_SHAPED` regex
 * matches it: wrong password, dead TOTP secret, a two-factor refusal. Recovery
 * then logs "the Zerodha credentials need a HUMAN" instead of promising a retry
 * that cannot work. The prefix is byte-identical to the one `zerodha-login.ts`
 * has always thrown, so any operator grep still finds it.
 */
function permanent(userId: string, stage: string, detail: string): Error {
  return new Error(`Zerodha login failed for ${userId} at ${stage}: ${detail}`)
}

/**
 * "The second factor was already POSTed" — stamped on the failure itself.
 *
 * WHAT THIS COSTS IF IT IS WRONG, and why it is a property on the error rather
 * than a guess at the call site. Past this point the TOTP for the current 30s
 * step has been handed to Kite and a session may already exist on their side,
 * so a caller that "just tries the other implementation" spends a SECOND
 * password+TOTP login on a live account — and one login too many is precisely
 * what killed the enctoken the running sockets were holding on 2026-08-04.
 * `zerodha-login.ts`'s automatic fallback reads this to decide whether its
 * retry is free (nothing sent yet) or not free at all.
 *
 * `Symbol.for` rather than a field name: it survives a duplicated module
 * instance, and nothing serialising the error can trip over it.
 */
const TWOFA_SENT = Symbol.for('desk.zerodha.twofa-sent')

function markTwofaSent(err: unknown): void {
  if (typeof err === 'object' && err !== null) {
    Object.defineProperty(err, TWOFA_SENT, { value: true, enumerable: false })
  }
}

/**
 * Did this failure happen at or after the second-factor POST — i.e. is a retry
 * of the whole login a REAL login rather than a free one?
 *
 * A failure with no mark answers false, which is the safe default only because
 * the mark is applied by the one function that can know. Anything that is not
 * an error from `nativeZerodhaLogin` never got near a TOTP.
 */
export function twofaWasSent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[TWOFA_SENT] === true
}

/**
 * A failure that RETRYING fixes: a timeout, an unreachable host, a 429, a 5xx.
 *
 * DELIBERATELY WORDED TO MISS `AUTH_SHAPED` — no "login failed", no
 * "credential", no "invalid", and NO URL. A Zerodha blip that shouts for an
 * operator is a false alarm at 09:15; the pacing is `FeedRecovery`'s backoff,
 * not a human.
 *
 * The URL is the trap and it is why the stage names below read the way they
 * do: `https://kite.zerodha.com/api/twofa` in an error message matches
 * `AUTH_SHAPED`'s `two.?fa` arm, so a plain network blip on the second factor
 * would have been reported as "the credentials need a HUMAN". The host is
 * carried instead; the stage says which call it was.
 */
function transient(stage: string, detail: string): Error {
  return new Error(`zerodha login: ${stage} ${detail}`)
}

/** Host only — see `transient` for why the path must not travel. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'kite.zerodha.com'
  }
}

/** Kite's own words for a failure, when it gave any. */
function kiteMessage(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const message = typeof body['message'] === 'string' ? body['message'] : ''
    const kind = typeof body['error_type'] === 'string' ? body['error_type'] : ''
    const said = [kind, message].filter((s) => s !== '').join(': ')
    if (said !== '') return said
  } catch {
    if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) {
      // The WEB host answers a dead session with the login PAGE, often on a
      // 200. Letting the JSON parse escape would report "Unexpected token '<'".
      return `Kite answered an HTML page rather than JSON (HTTP ${status}) — the login page`
    }
  }
  return `HTTP ${status}`
}

/** Does this status deserve a retry rather than an operator? */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

// ---------------------------------------------------------------- the flow

export interface NativeZerodhaCredentials {
  readonly user_id: string
  readonly password: string
  readonly authkey: string
}

/** Structurally the `ZerodhaSession` of `zerodha-login.ts`, without the cycle. */
export interface NativeZerodhaSession {
  readonly accessToken: string
  historyData(token: number, interval: string, from: string, to: string): Promise<unknown>
  /** True when the jar's session was still live and no new login was spent. */
  readonly reused: boolean
}

export interface NativeLoginOptions {
  readonly fetchImpl?: typeof fetch
  /** Defaults to the vendored `userdata/<user_id>.json`. */
  readonly jarPath?: string
  /** Bounds ONE request. `DESK_ZERODHA_HTTP_MS`, default 15s. */
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
  readonly env?: NodeJS.ProcessEnv
}

interface Reply {
  readonly status: number
  readonly text: string
  readonly setCookie: readonly string[]
}

/**
 * One request, with its timeout and its cookies — the only place this file
 * touches the network.
 *
 * `redirect: 'manual'` and hand-followed hops: with `follow`, undici consumes
 * the intermediate responses and THEIR `Set-Cookie` HEADERS ARE GONE, which for
 * a login chain means silently dropping a session cookie a redirect set.
 *
 * GET FOLLOWS, POST DOES NOT — and that is the vendored behaviour, not a
 * simplification: `request/lib/redirect.js` `redirectTo()` follows any 3xx
 * carrying a `Location` for GET, and explicitly breaks out for
 * POST/PUT/PATCH/DELETE unless `followAllRedirects` is set, which the vendored
 * client never set. Same limit it used, ten.
 */
/**
 * The body, read UNDER THE SAME SIGNAL THAT BOUNDED THE REQUEST.
 *
 * A `finally { clearTimeout(timer) }` wrapped around the `fetch` call alone
 * bounds the CONNECT and the HEADERS and nothing else: a server that answers
 * `200` and then stops sending the body leaves the read waiting with the timer
 * already disarmed, and this login — the feed's single point of failure, and
 * the enctoken canary's only path — hangs forever. Neither resolved nor
 * rejected is the worst of the three for `FeedRecovery`: it never classifies,
 * never backs off, never retries. That is the exact hung-socket failure this
 * file's header claims to have fixed, so the fix has to cover the body too.
 *
 * The race is belt AND braces. undici does reject an in-flight `text()` when
 * the request's signal aborts, but that is undici's promise to keep, not this
 * function's: `fetchImpl` is an injection point (tests, and any future
 * transport), and the bound must hold whatever is behind it.
 */
async function readBody(res: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  let onAbort: () => void = () => {}
  try {
    return await Promise.race([
      res.text(),
      // `race` subscribes to BOTH, so a later rejection from the loser is
      // handled and cannot surface as an unhandled rejection.
      new Promise<never>((_resolve, reject) => {
        onAbort = (): void => reject(new DOMException('aborted', 'AbortError'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const MAX_REDIRECTS = 10
async function send(
  doFetch: typeof fetch,
  stage: string,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  jar: CookieIndex,
  timeoutMs: number,
  now: () => number,
): Promise<{ reply: Reply; jar: CookieIndex; url: string }> {
  let current = url
  let cookies = jar
  const method = init.method
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { ...init.headers }
    const cookie = cookieHeader(cookies, current, now())
    if (cookie !== '') headers['cookie'] = cookie
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    let text: string
    try {
      res = await doFetch(current, {
        method,
        headers,
        ...(method === 'GET' || init.body === undefined ? {} : { body: init.body }),
        redirect: 'manual',
        signal: controller.signal,
      })
      // INSIDE the try, and inside the timer's reach: a stalled body is a hung
      // login, and `clearTimeout` below must not run before this returns.
      text = await readBody(res, controller.signal)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (controller.signal.aborted) {
        throw transient(stage, `timed out after ${timeoutMs}ms contacting ${hostOf(current)}`)
      }
      throw transient(stage, `could not reach ${hostOf(current)}: ${message}`)
    } finally {
      clearTimeout(timer)
    }
    cookies = mergeSetCookies(cookies, res.headers.getSetCookie(), current, now())
    const location = res.headers.get('location')
    if (method === 'GET' && res.status >= 300 && res.status < 400 && location !== null) {
      current = new URL(location, current).toString()
      continue
    }
    return {
      reply: { status: res.status, text, setCookie: res.headers.getSetCookie() },
      jar: cookies,
      url: current,
    }
  }
  throw transient(stage, `redirected more than ${MAX_REDIRECTS} times from ${hostOf(url)}`)
}

/**
 * The header block the vendored client sent on all three login steps, in its
 * order. `authority` is a leftover of its HTTP/2 copy-paste and is sent as an
 * ordinary header by `request` too — kept because what Kite's WAF sees is part
 * of the login.
 */
function loginHeaders(): Record<string, string> {
  return {
    authority: 'kite.zerodha.com',
    referer: HOME_URL,
    'content-type': 'application/x-www-form-urlencoded',
    'x-kite-version': KITE_VERSION,
    'user-agent': REQ_UA,
    origin: HOME_URL.replace(/\/$/, ''),
  }
}

/**
 * Is the jar's session still alive? — the vendored `checkSession`, same URL,
 * same headers, same verdict (`body.status == 'error'` means dead).
 *
 * A probe that cannot be REACHED answers "not alive" rather than throwing: the
 * probe is an optimisation, and letting one blip abort the login would turn a
 * transient network failure into a feed that never comes up. The vendored
 * version rejected here.
 */
async function sessionAlive(
  doFetch: typeof fetch,
  enctoken: string,
  jar: CookieIndex,
  timeoutMs: number,
  now: () => number,
): Promise<{ alive: boolean; jar: CookieIndex }> {
  try {
    const { reply, jar: next } = await send(
      doFetch,
      'the session probe',
      PROFILE_URL,
      {
        method: 'GET',
        headers: {
          connection: 'keep-alive',
          authorization: `enctoken ${enctoken}`,
          accept: 'application/json',
        },
      },
      jar,
      timeoutMs,
      now,
    )
    if (reply.status !== 200) return { alive: false, jar: next }
    try {
      const body = JSON.parse(reply.text) as Record<string, unknown>
      return { alive: body['status'] !== 'error', jar: next }
    } catch {
      // Not JSON — the login page, or a proxy's error document. Either way the
      // session is not usable.
      return { alive: false, jar: next }
    }
  } catch {
    return { alive: false, jar }
  }
}

/**
 * Password → TOTP → enctoken, exactly as `zerodha.js` did it.
 *
 * The three steps and why each one is there:
 *   1. `GET https://kite.zerodha.com/` — collects `kf_session` and the
 *      Cloudflare cookies the next two calls are expected to carry;
 *   2. `POST /api/login` with `user_id` + `password` — answers with
 *      `data.request_id`, the handle the second factor is bound to;
 *   3. `POST /api/twofa` with that `request_id` and the TOTP — answers
 *      `status: 'success'` and sets the `enctoken` cookie, which IS the
 *      credential the websocket and every REST call use.
 */
export async function nativeZerodhaLogin(
  creds: NativeZerodhaCredentials,
  opts: NativeLoginOptions = {},
): Promise<NativeZerodhaSession> {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((msg: string, ctx?: Record<string, unknown>): void => {
    console.log(msg, ctx ?? '')
  })
  const timeoutMs =
    opts.timeoutMs ?? positiveEnvMs('DESK_ZERODHA_HTTP_MS', DEFAULT_TIMEOUT_MS, opts.env)
  const jarPath = opts.jarPath ?? userdataPath(creds.user_id)
  /**
   * F-46. Derived per login rather than per process: `FeedRecovery` re-logs-in
   * mid-session, and a key added to the environment (or a `pm2 restart` after
   * one was) must take effect on the next login rather than on the next deploy.
   * `null` means plaintext, loudly — see `jarMasterKey`.
   *
   * `opts.env ?? {}` and NOT `?? process.env`: the seal key is a property of the
   * environment this call was HANDED, never of the shell the process happens to
   * be running in. Production reaches here through `zerodha-login.ts`, which
   * resolves `process.env` once and passes it down explicitly.
   */
  const jarSeal: JarSealOptions = { key: jarMasterKey(opts.env ?? {}, log), log }
  const loaded = loadCookieJar(jarPath, jarSeal)
  let jar = loaded.idx

  const session = (accessToken: string, reused: boolean): NativeZerodhaSession => ({
    accessToken,
    reused,
    historyData: (token, interval, from, to) =>
      nativeHistoryData(accessToken, token, interval, from, to, {
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
        ...(opts.now === undefined ? {} : { now: opts.now }),
        timeoutMs,
      }),
  })

  // --- 0. reuse a live session ---------------------------------------------
  const held = cookieValue(jar, ENCTOKEN_DOMAIN, ENCTOKEN_PATH, ENCTOKEN_KEY)
  if (held !== '') {
    const probe = await sessionAlive(doFetch, held, jar, timeoutMs, now)
    jar = probe.jar
    if (probe.alive) {
      /**
       * SAID OUT LOUD, because "did we actually mint a new token?" is the first
       * question of every enctoken postmortem (2026-08-04, 2026-08-05) and the
       * answer here is no. `FeedRecovery` treats a completed login as no proof
       * of a live session for exactly this reason — the token it hands back is
       * the one that was already in the jar.
       */
      log('zerodha login: the stored session is still live — no new login spent', {
        userId: creds.user_id,
      })
      saveCookieIndex(jarPath, jar, jarSeal)
      return session(held, true)
    }
  }

  // The vendored client's own line, kept verbatim: it is what an operator
  // greps for in `pm2 logs dx-marketdata` when a morning goes wrong.
  log(`${creds.user_id} logging in`)

  /** Has the TOTP left this process? See `twofaWasSent`. */
  let twofaSent = false
  /** Did this attempt actually produce a new enctoken? See the `finally`. */
  let mintedToken = false

  try {
    // --- 1. the home page --------------------------------------------------
    const home = await send(
      doFetch,
      'the kite home page',
      HOME_URL,
      { method: 'GET', headers: loginHeaders() },
      jar,
      timeoutMs,
      now,
    )
    jar = home.jar
    if (isRetryableStatus(home.reply.status)) {
      throw transient('the kite home page', `answered HTTP ${home.reply.status}`)
    }

    // --- 2. user id + password --------------------------------------------
    const form = new URLSearchParams({ user_id: creds.user_id, password: creds.password }).toString()
    const login = await send(
      doFetch,
      'the login request',
      LOGIN_URL,
      { method: 'POST', headers: { ...loginHeaders(), accept: 'application/json' }, body: form },
      jar,
      timeoutMs,
      now,
    )
    jar = login.jar
    if (isRetryableStatus(login.reply.status)) {
      throw transient('the login request', `answered HTTP ${login.reply.status} (Kite side)`)
    }
    const requestId = readRequestId(login.reply)
    if (requestId === '') {
      throw permanent(
        creds.user_id,
        'the login request',
        `no request_id in the reply — ${kiteMessage(login.reply.status, login.reply.text)}`,
      )
    }

    // --- 3. the second factor ---------------------------------------------
    // `qs.stringify` field order, so a packet capture diffs clean against the
    // vendored client's.
    const twofaBody = new URLSearchParams([
      ['user_id', creds.user_id],
      ['request_id', requestId],
      ['twofa_value', totp(creds.authkey, { atMs: now() })],
      ['twofa_type', 'totp'],
      ['skip_session', ''],
    ]).toString()
    /**
     * SET BEFORE THE AWAIT, not after it. A twofa POST that times out or comes
     * back 5xx still REACHED Kite — the code is spent and a session may exist —
     * so the mark has to be on every failure from here on, including the ones
     * that look transient. See `twofaWasSent`.
     */
    twofaSent = true
    const twofa = await send(
      doFetch,
      'the second-factor request',
      TWOFA_URL,
      { method: 'POST', headers: { ...loginHeaders(), accept: 'application/json' }, body: twofaBody },
      jar,
      timeoutMs,
      now,
    )
    jar = twofa.jar
    if (isRetryableStatus(twofa.reply.status)) {
      throw transient('the second-factor request', `answered HTTP ${twofa.reply.status} (Kite side)`)
    }
    if (!isSuccess(twofa.reply)) {
      throw permanent(
        creds.user_id,
        'the second-factor request',
        kiteMessage(twofa.reply.status, twofa.reply.text),
      )
    }

    const accessToken = cookieValue(jar, ENCTOKEN_DOMAIN, ENCTOKEN_PATH, ENCTOKEN_KEY)
    if (accessToken === '') {
      // The same words `zerodha-login.ts` has always thrown here, because
      // `FeedRecovery` matches on them.
      throw new Error('Zerodha login returned no enctoken')
    }
    mintedToken = true
    log('zerodha login OK — fresh enctoken', { userId: creds.user_id })
    return session(accessToken, false)
  } catch (err) {
    // The stamp travels with the failure so the caller's fallback can tell a
    // free retry from a second real login. Nothing else about the error changes
    // — `FeedRecovery` classifies on the message and must keep seeing it.
    if (twofaSent) markTwofaSent(err)
    throw err
  } finally {
    /**
     * PERSIST WHATEVER WAS COLLECTED, success or not. The cookies from the
     * hops that did work are what the next attempt starts from; discarding
     * them on a failure makes every retry begin with a cold jar, which is
     * more work for Kite at exactly the moment it is already unhappy.
     *
     * WITH ONE EXCEPTION: an envelope this process could not OPEN. `loadCookieJar`
     * leaves that file exactly as it is on the promise that it is the only
     * evidence of whether a key was rotated or the jar came from another box —
     * and the promise it makes is "the next SUCCESSFUL login overwrites it
     * anyway", not "the next attempt does". Saving here on a FAILED login
     * destroyed the evidence before the operator who was sent to look at it by
     * the loud line above ever arrived, and traded it for a jar of half-collected
     * cookies from an attempt that did not work.
     */
    if (loaded.unreadable && !mintedToken) {
      log(
        'zerodha login: this attempt failed, so the unreadable sealed cookie jar has been ' +
          'PRESERVED as it was — it is the only evidence of which key wrote it. The next ' +
          'successful login overwrites it.',
        { path: jarPath },
      )
    } else {
      try {
        saveCookieIndex(jarPath, jar, jarSeal)
      } catch (err) {
        log('zerodha login: the cookie jar could not be written', {
          path: jarPath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}

/** `body.data.request_id` — the one field step 2 exists to produce. */
function readRequestId(reply: Reply): string {
  try {
    const body = JSON.parse(reply.text) as { data?: { request_id?: unknown } }
    const id = body.data?.request_id
    return typeof id === 'string' && id !== '' ? id : ''
  } catch {
    return ''
  }
}

/** `body.status == 'success'` — the vendored test for a completed twofa. */
function isSuccess(reply: Reply): boolean {
  try {
    const body = JSON.parse(reply.text) as Record<string, unknown>
    return body['status'] === 'success'
  } catch {
    return false
  }
}

// ------------------------------------------------------------------- history

/**
 * The vendored row mapping, unchanged: a 7-column row carries open interest, a
 * 6-column one does not — and the short row must not grow an `oi: undefined`,
 * because `history.ts`'s `toCandles` reads these objects straight through.
 */
export function toVendorCandles(body: unknown): unknown[] {
  const candles = (body as { data?: { candles?: unknown } } | null)?.data?.candles
  if (!Array.isArray(candles)) return []
  return (candles as unknown[][]).map((c) =>
    c.length === 7
      ? { ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], vol: c[5], oi: c[6] }
      : { ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], vol: c[5] },
  )
}

/**
 * Historical candles — the vendored `historyData`, including its REJECTION
 * SHAPE.
 *
 * It rejected with the parsed BODY rather than an Error, and `history.ts` is
 * built around that: `describeHistoryError` digs `message`/`error_type` out of
 * the object and `isHistoryTokenRejection` classifies the result, which is what
 * the enctoken canary and the endpoint's one retry both hang off. Rejecting
 * with a tidy Error here would have made every token rejection read as
 * "[object Object]" — the exact bug that file's header documents.
 */
export async function nativeHistoryData(
  enctoken: string,
  instrument: number | string,
  type: string,
  from: string,
  to: string,
  opts: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    now?: () => number
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const timeoutMs =
    opts.timeoutMs ?? positiveEnvMs('DESK_ZERODHA_HTTP_MS', DEFAULT_TIMEOUT_MS, opts.env)
  const url = new URL(`${HISTORY_URL}${String(instrument)}/${type}`)
  // `user_id: 'XVXVXV'` is the vendored client's literal, and Kite ignores it —
  // the enctoken identifies the account. Kept so the request is the same one.
  url.searchParams.set('user_id', 'XVXVXV')
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)
  url.searchParams.set('oi', '1')
  url.searchParams.set('ciqrandom', String(now()))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let text: string
  try {
    const res = await doFetch(url.toString(), {
      method: 'GET',
      headers: {
        'user-agent': REQ_UA,
        authorization: `enctoken ${enctoken}`,
        referer: CHART_REFERER,
        accept: 'application/json',
      },
      signal: controller.signal,
    })
    // The body is read under the signal, for the reason `readBody` documents.
    // This request is the ENCTOKEN CANARY's; a canary that hangs never reports.
    text = await readBody(res, controller.signal)
  } catch (err) {
    if (controller.signal.aborted) {
      /**
       * Worded so `isHistoryTokenRejection` says NO. A timeout that classified
       * as a dead enctoken would have the canary spend a real password+TOTP
       * login on a network problem — the pacing `FeedRecovery` exists to
       * protect. No "token", no "session", no HTML.
       */
      throw new Error(`the historical-candle request timed out after ${timeoutMs}ms`)
    }
    // A transport failure was `reject(error)` in the vendored client too.
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON reply is what the vendored client's `json: true` left as a
    // raw string, which then failed its `body.data` test and was rejected
    // as-is. An HTML login page reaching `isHistoryTokenRejection` intact is
    // the point.
    throw text
  }
  const data = (body as { data?: unknown } | null)?.data
  if (data === undefined || data === null) throw body
  return toVendorCandles(body)
}
