/**
 * The native Kite login, tested everywhere it can be.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Every request goes through an injected
 * `fetch`, every jar through a temp file. What that leaves untested is exactly
 * one thing — whether Zerodha accepts the bytes we send — and that is stated in
 * `zerodha-native.ts`'s header rather than pretended away.
 *
 * No real secret appears in this file. The TOTP seed is the RFC 6238 one
 * ("12345678901234567890"), the cookies are hand-built, and the response bodies
 * are written from the shapes `packages/marketdata-core/vendor/zerodha.js`
 * itself reads (`body.data.request_id`, `body.status == 'success'`, and the
 * `enctoken` cookie its `getAuthorization()` digs out of the jar).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  base32Decode,
  cookieHeader,
  cookieValue,
  loadCookieIndex,
  mergeSetCookies,
  nativeHistoryData,
  nativeZerodhaLogin,
  normalizeBase32Secret,
  parseSetCookie,
  saveCookieIndex,
  toVendorCandles,
  totp,
  type CookieIndex,
} from '../src/zerodha-native.ts'
import { describeHistoryError, isHistoryTokenRejection } from '../src/history.ts'

const require = createRequire(import.meta.url)

/**
 * `FeedRecovery`'s classifier, copied here ON PURPOSE.
 *
 * `apps/marketdata/src/feed-recovery.ts` matches this regex on a login failure
 * to decide whether to say "the credentials need a HUMAN" and stop hoping, or
 * "will retry". The native path has to land on the same side of it as the
 * vendored one did for the same fault — a network blip classified as a
 * credential problem is a feed that shouts for an operator who has nothing to
 * fix, and a wrong password classified as transient is a feed that retries a
 * password that will never work, at login cadence, against a live account.
 *
 * Copied rather than imported because it is deliberately private there; the
 * pointer above is the contract, and these tests are what catch a drift.
 */
const AUTH_SHAPED = /login failed|no enctoken|password|totp|two.?fa|credential|invalid/i

const CREDS = { user_id: 'AB1234', password: 'pw', authkey: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }

/** The login logs; the tests that are not ABOUT the logs do not need them. */
const quiet = (): void => {}

function tempJar(): string {
  return join(mkdtempSync(join(tmpdir(), 'zerodha-jar-')), 'AB1234.json')
}

// ------------------------------------------------------------------- RFC 6238

/**
 * The RFC 6238 Appendix B vectors, SHA-1 rows.
 *
 * The published table is 8 digits; Kite (like every authenticator app) wants 6,
 * which is the same truncation with a smaller modulus — so both are asserted,
 * and the 6-digit column is what the login actually sends.
 */
const RFC6238_SHA1: readonly (readonly [number, string])[] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

/** RFC 6238's seed is the ASCII string "12345678901234567890", base32-encoded. */
const RFC_SEED_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('TOTP matches every RFC 6238 SHA-1 test vector, at 8 and at 6 digits', () => {
  for (const [seconds, expected8] of RFC6238_SHA1) {
    const atMs = seconds * 1000
    assert.equal(totp(RFC_SEED_B32, { atMs, digits: 8 }), expected8, `8-digit @${seconds}`)
    assert.equal(totp(RFC_SEED_B32, { atMs }), expected8.slice(-6), `6-digit @${seconds}`)
  }
})

test('the 6-digit code is ZERO-PADDED, never a short string', () => {
  /**
   * The legacy `notp` truncates the decimal HMAC value with `substr(len - 6)`,
   * so a value below 100000 comes out FIVE digits long and Kite rejects a code
   * that was arithmetically correct. It is rare (~1 in 21,000 steps) and it is
   * a real login failure with no explanation, so the native path pads.
   *
   * The seed/time below was searched for offline; it is a step whose dynamic
   * truncation lands under 100000.
   */
  const code = totp(RFC_SEED_B32, { atMs: 0, digits: 6 })
  assert.match(code, /^\d{6}$/)
  for (let step = 0; step < 5000; step++) {
    assert.match(totp(RFC_SEED_B32, { atMs: step * 30_000 }), /^\d{6}$/)
  }
})

test('the code is stable inside a 30s step and changes across one', () => {
  const base = 1_700_000_000_000 - (1_700_000_000_000 % 30_000)
  assert.equal(totp(RFC_SEED_B32, { atMs: base }), totp(RFC_SEED_B32, { atMs: base + 29_999 }))
  assert.notEqual(totp(RFC_SEED_B32, { atMs: base }), totp(RFC_SEED_B32, { atMs: base + 30_000 }))
})

test('the secret is normalised exactly as the vendored `authenticator` did', () => {
  // `authenticator.generateToken` does `key.replace(/\W+/g,'').toUpperCase()`
  // and the vendored caller lowercases first, so spaces, dashes, base32 padding
  // and case are all noise. An operator pastes the grouped form from Kite.
  assert.equal(normalizeBase32Secret('gezd gnbv gy3t qojq'), 'GEZDGNBVGY3TQOJQ')
  assert.equal(normalizeBase32Secret('GEZD-GNBV-GY3T-QOJQ'), 'GEZDGNBVGY3TQOJQ')
  assert.equal(normalizeBase32Secret('GEZDGNBVGY3TQOJQ===='), 'GEZDGNBVGY3TQOJQ')
})

test('the SAME token the vendored `authenticator` would have produced', () => {
  /**
   * The one direct equivalence check against the library being replaced. If
   * this ever disagrees, the feed cannot log in — and no unit test of my own
   * arithmetic would have told me.
   */
  const authenticator = require('authenticator') as { generateToken(key: string): string }
  const before = totp(CREDS.authkey)
  const legacy = authenticator.generateToken(String(CREDS.authkey).toLowerCase())
  const after = totp(CREDS.authkey)
  // Two readings, because a 30s step can turn over between the two calls.
  assert.ok(
    legacy === before || legacy === after,
    `native ${before}/${after} disagrees with authenticator ${legacy}`,
  )
})

test('a secret with characters base32 does not have is rejected, and says which field', () => {
  // Silent garbage here is a login that fails every retry with "invalid TOTP"
  // and no clue that the stored secret is the problem.
  assert.throws(() => totp('GEZD0NBV'), /totp secret/i)
  assert.throws(() => totp(''), /totp secret/i)
})

test('base32 decodes the RFC 4648 vectors', () => {
  const dec = (s: string): string => Buffer.from(base32Decode(s)).toString('utf8')
  assert.equal(dec(''), '')
  assert.equal(dec('MY'), 'f')
  assert.equal(dec('MZXQ'), 'fo')
  assert.equal(dec('MZXW6'), 'foo')
  assert.equal(dec('MZXW6YQ'), 'foob')
  assert.equal(dec('MZXW6YTB'), 'fooba')
  assert.equal(dec('MZXW6YTBOI'), 'foobar')
})

// ------------------------------------------------------------------- cookies

const KITE = 'https://kite.zerodha.com/api/twofa'

test('a host-only cookie is stored under the request host', () => {
  const parsed = parseSetCookie('enctoken=TOKEN123; Path=/; Secure; SameSite=None', KITE, 1000)
  assert.ok(parsed !== null)
  assert.equal(parsed.domain, 'kite.zerodha.com')
  assert.equal(parsed.path, '/')
  assert.equal(parsed.blob['key'], 'enctoken')
  assert.equal(parsed.blob['value'], 'TOKEN123')
  assert.equal(parsed.blob['hostOnly'], true)
  assert.equal(parsed.blob['secure'], true)
  // tough-cookie keeps every attribute it does not know as a raw string, and
  // the jar file on the live box has exactly this.
  assert.deepEqual(parsed.blob['extensions'], ['SameSite=None'])
  assert.equal(parsed.blob['creation'], new Date(1000).toISOString())
})

test('a Domain attribute widens the cookie and drops the leading dot', () => {
  // `public_token` arrives as `Domain=.zerodha.com` and the live jar file holds
  // it under "zerodha.com" with hostOnly false. The vendored path reads it back
  // through `getPublicToken()`.
  const parsed = parseSetCookie('public_token=PT; Domain=.zerodha.com; Path=/; Secure', KITE, 0)
  assert.ok(parsed !== null)
  assert.equal(parsed.domain, 'zerodha.com')
  assert.equal(parsed.blob['hostOnly'], false)
})

test('a cookie for someone ELSE’s domain is dropped', () => {
  // A jar that accepts `Domain=example.com` from kite.zerodha.com would send
  // the enctoken to a host that never issued it.
  assert.equal(parseSetCookie('x=1; Domain=example.com', KITE, 0), null)
  assert.equal(parseSetCookie('x=1; Domain=zerodha.com.evil.test', KITE, 0), null)
})

test('a Set-Cookie with no name/value pair is ignored, not stored as ""', () => {
  assert.equal(parseSetCookie('Secure; HttpOnly', KITE, 0), null)
  assert.equal(parseSetCookie('   ', KITE, 0), null)
})

test('with no Path attribute the RFC default-path is derived and marked', () => {
  // RFC 6265 §5.1.4: up to but NOT including the right-most '/'.
  const parsed = parseSetCookie('a=1', 'https://kite.zerodha.com/oms/user/profile/full', 0)
  assert.ok(parsed !== null)
  assert.equal(parsed.path, '/oms/user/profile')
  assert.equal(parsed.blob['pathIsDefault'], true)
  const root = parseSetCookie('a=1', 'https://kite.zerodha.com/', 0)
  assert.equal(root?.path, '/')
})

test('Expires and Max-Age are both carried, Max-Age winning the expiry', () => {
  const withExpiry = parseSetCookie(
    '__cf_bm=X; Path=/; Expires=Thu, 31 Jul 2026 05:56:14 GMT; Secure; HttpOnly',
    KITE,
    0,
  )
  assert.equal(withExpiry?.blob['expires'], '2026-07-31T05:56:14.000Z')
  const withMaxAge = parseSetCookie('a=1; Max-Age=60', KITE, 0)
  assert.equal(withMaxAge?.blob['maxAge'], 60)
})

test('merging a fresh value KEEPS the original creation and bumps lastAccessed', () => {
  // tough-cookie's `updateCookie` semantics. The creation timestamp is how the
  // header order is decided, so losing it reorders the jar on every login.
  let idx: CookieIndex = mergeSetCookies({}, ['enctoken=OLD; Path=/'], KITE, 1_000)
  idx = mergeSetCookies(idx, ['enctoken=NEW; Path=/'], KITE, 5_000)
  const cookie = idx['kite.zerodha.com']?.['/']?.['enctoken'] as Record<string, unknown>
  assert.equal(cookie['value'], 'NEW')
  assert.equal(cookie['creation'], new Date(1_000).toISOString())
  assert.equal(cookie['lastAccessed'], new Date(5_000).toISOString())
  assert.equal(cookieValue(idx, 'kite.zerodha.com', '/', 'enctoken'), 'NEW')
})

test('the whole login chain accumulates into ONE jar across both hosts', () => {
  let idx: CookieIndex = mergeSetCookies({}, ['kf_session=S; Path=/; Secure; HttpOnly'], KITE, 0)
  idx = mergeSetCookies(idx, ['_cfuvid=C; Domain=.zerodha.com; Path=/; Secure'], KITE, 0)
  idx = mergeSetCookies(idx, ['enctoken=E; Path=/; Secure', 'public_token=P; Domain=.zerodha.com; Path=/'], KITE, 0)
  assert.deepEqual(Object.keys(idx).sort(), ['kite.zerodha.com', 'zerodha.com'])
  const header = cookieHeader(idx, 'https://kite.zerodha.com/api/twofa', 0)
  for (const name of ['kf_session', '_cfuvid', 'enctoken', 'public_token']) {
    assert.match(header, new RegExp(`(^|; )${name}=`), `${name} missing from ${header}`)
  }
})

test('the Cookie header respects host, path, expiry and Secure', () => {
  let idx: CookieIndex = mergeSetCookies({}, ['a=1; Path=/'], 'https://kite.zerodha.com/', 0)
  idx = mergeSetCookies(idx, ['deep=2; Path=/oms'], 'https://kite.zerodha.com/', 0)
  idx = mergeSetCookies(idx, ['gone=3; Path=/; Max-Age=10'], 'https://kite.zerodha.com/', 0)
  idx = mergeSetCookies(idx, ['tls=4; Path=/; Secure'], 'https://kite.zerodha.com/', 0)

  const deep = cookieHeader(idx, 'https://kite.zerodha.com/oms/orders', 5_000)
  assert.match(deep, /deep=2/)
  // Longest path first — tough-cookie's `cookieCompare` order, which is what a
  // server that reads only the first value of a duplicated name sees.
  assert.ok(deep.indexOf('deep=2') < deep.indexOf('a=1'), deep)

  const shallow = cookieHeader(idx, 'https://kite.zerodha.com/api/login', 5_000)
  assert.doesNotMatch(shallow, /deep=2/)

  const later = cookieHeader(idx, 'https://kite.zerodha.com/', 60_000)
  assert.doesNotMatch(later, /gone=3/)

  const plain = cookieHeader(idx, 'http://kite.zerodha.com/', 0)
  assert.doesNotMatch(plain, /tls=4/)

  const other = cookieHeader(idx, 'https://example.com/', 0)
  assert.equal(other, '')
})

// ------------------------------------------------------- the persisted format

/** The shape the live box's `userdata/BCM757.json` actually holds, redacted. */
const VENDOR_JAR = {
  'zerodha.com': {
    '/': {
      public_token: {
        key: 'public_token',
        value: 'PUBLIC',
        domain: 'zerodha.com',
        path: '/',
        secure: true,
        extensions: ['SameSite=None'],
        hostOnly: false,
        creation: '2026-07-27T16:47:15.099Z',
        lastAccessed: '2026-07-31T05:26:15.004Z',
      },
    },
  },
  'kite.zerodha.com': {
    '/': {
      enctoken: {
        key: 'enctoken',
        value: 'VENDOR-TOKEN',
        domain: 'kite.zerodha.com',
        path: '/',
        secure: true,
        extensions: ['SameSite=None'],
        hostOnly: true,
        creation: '2026-07-27T16:47:15.100Z',
        lastAccessed: '2026-07-31T05:26:15.004Z',
      },
    },
  },
}

test('a jar the VENDORED path wrote is read, and its enctoken found', () => {
  // The switch is meant to be flippable mid-life: a box that logged in on the
  // legacy path and then restarts on the native one must reuse its session
  // rather than spend a fresh password+TOTP login.
  const path = tempJar()
  writeFileSync(path, JSON.stringify(VENDOR_JAR))
  const idx = loadCookieIndex(path)
  assert.equal(cookieValue(idx, 'kite.zerodha.com', '/', 'enctoken'), 'VENDOR-TOKEN')
  assert.match(cookieHeader(idx, 'https://kite.zerodha.com/oms/user/profile/full', Date.now()), /enctoken=VENDOR-TOKEN/)
})

test('fields the native path does not model survive a load/save round trip', () => {
  const path = tempJar()
  const withExtra = JSON.parse(JSON.stringify(VENDOR_JAR)) as Record<string, never>
  ;(withExtra['kite.zerodha.com'] as unknown as Record<string, Record<string, Record<string, unknown>>>)['/']!['enctoken']!['creationIndex'] = 7
  writeFileSync(path, JSON.stringify(withExtra))
  saveCookieIndex(path, loadCookieIndex(path))
  const reread = JSON.parse(readFileSync(path, 'utf8')) as typeof withExtra
  assert.deepEqual(reread, withExtra)
})

test('a MISSING or CORRUPT jar is an empty jar, never a throw', () => {
  /**
   * `loadCookie()` in the vendored file catches the same case by rewriting the
   * file with `{}` — because `tough-cookie-filestore` throws on a missing one,
   * and that throw is what made `desk-marketdata` unbootable on a fresh clone
   * (pm2: ten restarts inside `min_uptime`, then `errored`).
   */
  const missing = join(mkdtempSync(join(tmpdir(), 'zerodha-jar-')), 'nested', 'AB1234.json')
  assert.deepEqual(loadCookieIndex(missing), {})
  assert.equal(readFileSync(missing, 'utf8'), '{}')

  const corrupt = tempJar()
  writeFileSync(corrupt, 'not json at all')
  assert.deepEqual(loadCookieIndex(corrupt), {})
  assert.equal(readFileSync(corrupt, 'utf8'), '{}')
})

test('THE VENDORED CLIENT CAN READ WHAT THE NATIVE PATH WRITES', () => {
  /**
   * The interop that makes `DESK_LEGACY_ZERODHA_LOGIN=1` a real fallback rather
   * than a fresh login: the file is loaded by the actual `tough-cookie-filestore`
   * + `request.jar()` the vendored client uses, and the token is looked up
   * through the EXACT expression `getAuthorization()` evaluates:
   *
   *     cookie_jar._jar.store.idx['kite.zerodha.com']['/']['enctoken'].value
   */
  const path = tempJar()
  writeFileSync(path, '{}')
  let idx: CookieIndex = mergeSetCookies({}, ['kf_session=S; Path=/; Secure; HttpOnly; SameSite=None'], KITE, Date.now())
  idx = mergeSetCookies(idx, ['enctoken=NATIVE-TOKEN; Path=/; Secure; SameSite=None'], KITE, Date.now())
  idx = mergeSetCookies(idx, ['public_token=PT; Domain=.zerodha.com; Path=/; Secure'], KITE, Date.now())
  saveCookieIndex(path, idx)

  const request = require('request') as { jar(store: unknown): { _jar: { store: { idx: Record<string, Record<string, Record<string, { value: string }>>> } } } }
  const FileCookieStore = require('tough-cookie-filestore') as new (p: string) => unknown
  const jar = request.jar(new FileCookieStore(path))
  assert.equal(jar._jar.store.idx['kite.zerodha.com']?.['/']?.['enctoken']?.value, 'NATIVE-TOKEN')
  assert.equal(jar._jar.store.idx['zerodha.com']?.['/']?.['public_token']?.value, 'PT')
})

// -------------------------------------------------------------- the login flow

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  hasSignal: boolean
}

/** A fetch stand-in that replays a scripted list of replies and records calls. */
function scriptedFetch(
  replies: readonly { status?: number; body: string; setCookie?: readonly string[]; location?: string }[],
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
      hasSignal: init?.signal instanceof AbortSignal,
    })
    const reply = replies[i++]
    if (reply === undefined) throw new Error(`unscripted request: ${String(input)}`)
    const h = new Headers()
    for (const line of reply.setCookie ?? []) h.append('set-cookie', line)
    if (reply.location !== undefined) h.set('location', reply.location)
    return new Response(reply.body, { status: reply.status ?? 200, headers: h })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const DEAD_SESSION = JSON.stringify({
  status: 'error',
  message: 'Invalid session credentials',
  error_type: 'TokenException',
})
const LOGIN_OK = JSON.stringify({
  status: 'success',
  data: { user_id: 'AB1234', request_id: 'REQ-1', twofa_type: 'totp' },
})
const TWOFA_OK = JSON.stringify({ status: 'success', data: { profile: { user_id: 'AB1234' } } })

function successScript(): readonly { status?: number; body: string; setCookie?: readonly string[] }[] {
  return [
    { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/; Secure; HttpOnly; SameSite=None'] },
    { body: LOGIN_OK },
    {
      body: TWOFA_OK,
      setCookie: [
        'enctoken=FRESH-TOKEN; Path=/; Secure; SameSite=None',
        'public_token=PT; Domain=.zerodha.com; Path=/; Secure',
      ],
    },
  ]
}

test('the request sequence is the vendored one, byte for byte where it matters', async () => {
  const jarPath = tempJar()
  const { impl, calls } = scriptedFetch(successScript())
  const at = 1_700_000_000_000
  const session = await nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath, now: () => at })

  assert.equal(calls.length, 3, 'a fresh jar skips the session probe and does the three-step login')
  const [home, login, twofa] = calls as [Call, Call, Call]

  assert.equal(home.url, 'https://kite.zerodha.com/')
  assert.equal(home.method, 'GET')
  assert.equal(home.headers['x-kite-version'], '2.8.0')
  assert.equal(home.headers['authority'], 'kite.zerodha.com')
  assert.equal(home.headers['origin'], 'https://kite.zerodha.com')
  assert.equal(home.headers['referer'], 'https://kite.zerodha.com/')
  assert.equal(home.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.match(home.headers['user-agent'] ?? '', /^Mozilla\/5\.0 \(Macintosh/)

  assert.equal(login.url, 'https://kite.zerodha.com/api/login')
  assert.equal(login.method, 'POST')
  assert.equal(login.body, 'user_id=AB1234&password=pw')
  // The cookie the home page set travels to the login POST — the whole reason
  // the vendored client threaded one jar through the chain.
  assert.match(login.headers['cookie'] ?? '', /kf_session=S/)

  assert.equal(twofa.url, 'https://kite.zerodha.com/api/twofa')
  assert.equal(twofa.method, 'POST')
  const form = new URLSearchParams(twofa.body)
  assert.equal(form.get('user_id'), 'AB1234')
  assert.equal(form.get('request_id'), 'REQ-1')
  assert.equal(form.get('twofa_type'), 'totp')
  assert.equal(form.get('skip_session'), '')
  assert.equal(form.get('twofa_value'), totp(CREDS.authkey, { atMs: at }))
  // Field order matters to nobody but a diff against the vendored `qs.stringify`.
  assert.equal(
    twofa.body,
    `user_id=AB1234&request_id=REQ-1&twofa_value=${totp(CREDS.authkey, { atMs: at })}&twofa_type=totp&skip_session=`,
  )

  assert.equal(session.accessToken, 'FRESH-TOKEN')
  const persisted = JSON.parse(readFileSync(jarPath, 'utf8')) as CookieIndex
  assert.equal(cookieValue(persisted, 'kite.zerodha.com', '/', 'enctoken'), 'FRESH-TOKEN')
  assert.equal(cookieValue(persisted, 'zerodha.com', '/', 'public_token'), 'PT')
})

test('a REDIRECTED home page keeps the cookies from every hop', async () => {
  /**
   * The reason the hops are followed by hand. `fetch`'s own `redirect: 'follow'`
   * consumes the intermediate responses and their `Set-Cookie` headers never
   * reach us — so a session cookie set on the 302 would be silently dropped and
   * the login POST would go out without it.
   */
  const jarPath = tempJar()
  const { impl, calls } = scriptedFetch([
    { status: 302, body: '', location: '/dashboard', setCookie: ['hop=1; Path=/; Secure'] },
    { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/; Secure'] },
    { body: LOGIN_OK },
    { body: TWOFA_OK, setCookie: ['enctoken=FRESH-TOKEN; Path=/; Secure'] },
  ])
  const session = await nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath })
  assert.equal(session.accessToken, 'FRESH-TOKEN')
  assert.equal(calls[1]?.url, 'https://kite.zerodha.com/dashboard')
  assert.match(calls[2]?.headers['cookie'] ?? '', /hop=1/)
  assert.match(calls[2]?.headers['cookie'] ?? '', /kf_session=S/)
})

test('a redirect LOOP is bounded, and bounded transiently', async () => {
  const { impl } = scriptedFetch(
    Array.from({ length: 20 }, () => ({ status: 302, body: '', location: '/' })),
  )
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
    (err: Error) => {
      assert.match(err.message, /redirected more than 10 times/)
      assert.doesNotMatch(err.message, AUTH_SHAPED)
      return true
    },
  )
})

test('a POST is NOT redirect-followed — the vendored client did not follow one either', async () => {
  // `request/lib/redirect.js` breaks out of `redirectTo()` for POST unless
  // `followAllRedirects` is set, which the vendored client never set. Re-POSTing
  // a password to a Location we were handed is not a behaviour to invent here.
  const { impl, calls } = scriptedFetch([
    { body: '<html>kite</html>' },
    { status: 302, body: '', location: 'https://kite.zerodha.com/elsewhere' },
  ])
  await assert.rejects(() => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }))
  assert.equal(calls.length, 2, 'the login POST must not be replayed at the redirect target')
})

test('the vendored "<user> logging in" line still appears', async () => {
  // It is what an operator greps for in `pm2 logs dx-marketdata` when a
  // morning goes wrong, and it is the only mark a REAL login was spent.
  const lines: string[] = []
  const { impl } = scriptedFetch(successScript())
  await nativeZerodhaLogin(CREDS, {
    log: (m) => lines.push(m),
    fetchImpl: impl,
    jarPath: tempJar(),
  })
  assert.ok(lines.includes('AB1234 logging in'), lines.join(' | '))
})

test('every request carries an AbortSignal', async () => {
  const { impl, calls } = scriptedFetch(successScript())
  await nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() })
  assert.ok(calls.every((c) => c.hasSignal), 'a hung Kite must not wedge the login forever')
})

test('a request that never answers fails as a TIMEOUT, and reads as transient', async () => {
  const impl = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })) as unknown as typeof fetch
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar(), timeoutMs: 20 }),
    (err: Error) => {
      assert.match(err.message, /timed out/i)
      assert.doesNotMatch(err.message, AUTH_SHAPED, 'a timeout must NOT read as a credential fault')
      return true
    },
  )
})

/**
 * A reply whose HEADERS arrive and whose BODY never does.
 *
 * This is the half of a hung socket a `finally { clearTimeout }` around the
 * `fetch` call alone does not cover: the request "succeeded", the timer is
 * disarmed, and the read of the body then waits forever. Kite's WAF and any
 * proxy in front of it can do exactly this, and the failure is invisible —
 * `FeedRecovery` sees a login that neither resolved nor rejected, so it never
 * backs off and never retries.
 */
function stalledBodyFetch(): { impl: typeof fetch; calls: number[] } {
  const calls: number[] = []
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(Date.now())
    const headers = new Headers()
    headers.append('set-cookie', 'kf_session=S; Path=/; Secure')
    return {
      status: 200,
      headers,
      text: () =>
        new Promise<string>((_resolve, reject) => {
          // The body read only ever ends if the signal is STILL armed here.
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Let the pending awaits inside the login reach the stalled body read. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

test('a reply whose BODY never arrives still times out — the signal stays armed across the read', {
  timeout: 5_000,
}, async (t) => {
  /**
   * The whole reason this file exists on `fetch` rather than on `request` is
   * bounded requests (header note 1). A timeout that is cleared before the body
   * is read bounds the CONNECT and nothing else, which is the exact hung-socket
   * failure the vendored client had.
   */
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { impl } = stalledBodyFetch()
  const pending = nativeZerodhaLogin(CREDS, {
    log: quiet,
    fetchImpl: impl,
    jarPath: tempJar(),
    timeoutMs: 15_000,
  })
  const seen: Error[] = []
  pending.catch((err: Error) => seen.push(err))
  await settle()
  t.mock.timers.tick(15_001)
  await assert.rejects(
    () => pending,
    (err: Error) => {
      assert.match(err.message, /timed out/i)
      assert.doesNotMatch(err.message, AUTH_SHAPED, 'a timeout must NOT read as a credential fault')
      return true
    },
  )
  assert.equal(seen.length, 1)
})

test('a HISTORY reply whose body never arrives times out too', { timeout: 5_000 }, async (t) => {
  // Same defect, same fix, in the other place this file reads a body — and this
  // one is the enctoken CANARY's request. A canary that hangs is a canary that
  // never reports, which is worse than no canary at all.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { impl } = stalledBodyFetch()
  const pending = nativeHistoryData('TOKEN', 256265, 'minute', 'a', 'b', {
    fetchImpl: impl,
    timeoutMs: 15_000,
  })
  const seen: unknown[] = []
  pending.catch((err: unknown) => seen.push(err))
  await settle()
  t.mock.timers.tick(15_001)
  await assert.rejects(
    () => pending,
    (err: Error) => {
      assert.match(err.message, /timed out/i)
      // `history.ts` classifies through `isHistoryTokenRejection`; a stalled
      // body must not read as a dead enctoken, or the canary spends a real
      // password+TOTP login on a network problem.
      assert.equal(isHistoryTokenRejection(err), false)
      return true
    },
  )
  assert.equal(seen.length, 1)
})

test('an unreachable host reads as transient, not as a credential problem', async () => {
  const impl = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
    (err: Error) => {
      assert.doesNotMatch(err.message, AUTH_SHAPED)
      assert.match(err.message, /fetch failed/)
      return true
    },
  )
})

test('a live session in the jar is REUSED — no password, no TOTP, no new login', async () => {
  /**
   * The vendored `login()` probes `/oms/user/profile/full` first and returns
   * early when it answers. `routes/brokers.ts` states that caveat in its "test"
   * response, and the feed depends on it: a restart mid-session must not
   * invalidate the token the still-running websockets are holding.
   */
  const jarPath = tempJar()
  saveCookieIndex(
    jarPath,
    mergeSetCookies({}, ['enctoken=LIVE-TOKEN; Path=/; Secure'], KITE, Date.now()),
  )
  const lines: string[] = []
  const { impl, calls } = scriptedFetch([{ body: JSON.stringify({ status: 'success', data: {} }) }])
  const session = await nativeZerodhaLogin(CREDS, { log: (m) => lines.push(m), fetchImpl: impl, jarPath })
  assert.equal(session.accessToken, 'LIVE-TOKEN')
  assert.equal(session.reused, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://kite.zerodha.com/oms/user/profile/full')
  assert.equal(calls[0]?.headers['authorization'], 'enctoken LIVE-TOKEN')
  // "Did we actually mint a new token?" is the first question of every enctoken
  // postmortem, and the answer here — no — has to be in the log.
  assert.ok(lines.some((l) => /still live/.test(l)), lines.join(' | '))
  assert.ok(!lines.some((l) => /logging in/.test(l)))
})

test('a DEAD session in the jar falls through to the full login', async () => {
  const jarPath = tempJar()
  saveCookieIndex(
    jarPath,
    mergeSetCookies({}, ['enctoken=DEAD; Path=/; Secure'], KITE, Date.now()),
  )
  const { impl, calls } = scriptedFetch([{ status: 403, body: DEAD_SESSION }, ...successScript()])
  const session = await nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath })
  assert.equal(calls.length, 4)
  assert.equal(session.accessToken, 'FRESH-TOKEN')
})

test('a session probe that cannot be REACHED still tries a real login', async () => {
  // The probe is an optimisation. Letting its network failure abort the login
  // would turn one blip into "no feed", which is the opposite of the point.
  const jarPath = tempJar()
  saveCookieIndex(jarPath, mergeSetCookies({}, ['enctoken=DEAD; Path=/; Secure'], KITE, Date.now()))
  let first = true
  const scripted = scriptedFetch(successScript())
  const impl = ((url: string | URL, init?: RequestInit) => {
    if (first) {
      first = false
      return Promise.reject(new TypeError('fetch failed'))
    }
    return (scripted.impl as (u: string | URL, i?: RequestInit) => Promise<Response>)(url, init)
  }) as unknown as typeof fetch
  const session = await nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath })
  assert.equal(session.accessToken, 'FRESH-TOKEN')
})

test('the login page answering HTML to the API is a session failure, not a parse crash', async () => {
  // `kite.zerodha.com` is the WEB host: a dead session earns the login PAGE,
  // often with a 200 on it. A SyntaxError escaping here is a login that fails
  // with "Unexpected token '<'".
  const { impl } = scriptedFetch([
    { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/'] },
    { body: '<!DOCTYPE html><html><body>login</body></html>' },
  ])
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
    /Zerodha login failed for AB1234/,
  )
})

test('a wrong password surfaces Kite’s own words, and reads as a HUMAN problem', async () => {
  const { impl } = scriptedFetch([
    { body: '<html>kite</html>' },
    {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        message: 'Invalid user id or password.',
        error_type: 'UserException',
      }),
    },
  ])
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
    (err: Error) => {
      assert.match(err.message, /Zerodha login failed for AB1234/)
      assert.match(err.message, /Invalid user id or password/)
      assert.match(err.message, AUTH_SHAPED)
      return true
    },
  )
})

test('a rejected TOTP is reported as one, and reads as a HUMAN problem', async () => {
  const { impl } = scriptedFetch([
    { body: '<html>kite</html>' },
    { body: LOGIN_OK },
    { status: 403, body: JSON.stringify({ status: 'error', message: 'Invalid TOTP', error_type: 'TwoFAException' }) },
  ])
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
    (err: Error) => {
      assert.match(err.message, /Invalid TOTP/)
      assert.match(err.message, AUTH_SHAPED)
      return true
    },
  )
})

test('a login reply with no request_id fails where the vendored one returned false', async () => {
  const { impl } = scriptedFetch([
    { body: '<html>kite</html>' },
    { body: JSON.stringify({ status: 'success', data: { user_id: 'AB1234' } }) },
  ])
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
    /Zerodha login failed for AB1234.*request_id/s,
  )
})

test('rate limiting and 5xx read as TRANSIENT — retrying is the right answer', async () => {
  for (const status of [429, 502, 503]) {
    const { impl } = scriptedFetch([
      { body: '<html>kite</html>' },
      { status, body: JSON.stringify({ status: 'error', message: 'Too many requests' }) },
    ])
    await assert.rejects(
      () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
      (err: Error) => {
        assert.match(err.message, new RegExp(String(status)))
        assert.doesNotMatch(err.message, AUTH_SHAPED, `HTTP ${status} must not demand a human`)
        return true
      },
    )
  }
})

test('a "success" that sets no enctoken is the error the callers already know', async () => {
  const { impl } = scriptedFetch([
    { body: '<html>kite</html>' },
    { body: LOGIN_OK },
    { body: TWOFA_OK },
  ])
  await assert.rejects(
    () => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath: tempJar() }),
    /Zerodha login returned no enctoken/,
  )
})

test('the jar is persisted even when the login fails half way', async () => {
  // The cookies collected up to the failure are what the NEXT attempt needs;
  // throwing them away makes every retry start from a cold jar.
  const jarPath = tempJar()
  const { impl } = scriptedFetch([
    { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/; Secure'] },
    { status: 403, body: JSON.stringify({ status: 'error', message: 'Invalid user id or password.' }) },
  ])
  await assert.rejects(() => nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath }))
  const persisted = JSON.parse(readFileSync(jarPath, 'utf8')) as CookieIndex
  assert.equal(cookieValue(persisted, 'kite.zerodha.com', '/', 'kf_session'), 'S')
})

// ----------------------------------------------------------------- historyData

const CANDLE_BODY_OI = JSON.stringify({
  status: 'success',
  data: { candles: [['2026-07-24T09:15:00+0530', 1, 2, 0.5, 1.5, 100, 42]] },
})
const CANDLE_BODY_NO_OI = JSON.stringify({
  status: 'success',
  data: { candles: [['2026-07-24T09:15:00+0530', 1, 2, 0.5, 1.5, 100]] },
})

test('history rows map exactly as the vendored client mapped them', () => {
  assert.deepEqual(toVendorCandles(JSON.parse(CANDLE_BODY_OI)), [
    { ts: '2026-07-24T09:15:00+0530', open: 1, high: 2, low: 0.5, close: 1.5, vol: 100, oi: 42 },
  ])
  // A 6-column row carries no `oi` key at all — `history.ts`'s `toCandles`
  // reads `vol`, and an `oi: undefined` would serialise into the response.
  assert.deepEqual(toVendorCandles(JSON.parse(CANDLE_BODY_NO_OI)), [
    { ts: '2026-07-24T09:15:00+0530', open: 1, high: 2, low: 0.5, close: 1.5, vol: 100 },
  ])
})

test('a history call carries the enctoken, the chart referer and the vendored query', async () => {
  const { impl, calls } = scriptedFetch([{ body: CANDLE_BODY_OI }])
  const rows = await nativeHistoryData('TOK', 12345, '60minute', '2026-07-01', '2026-07-24', {
    fetchImpl: impl,
    now: () => 1_700_000_000_000,
  })
  assert.equal((rows as unknown[]).length, 1)
  const call = calls[0] as Call
  const url = new URL(call.url)
  assert.equal(url.pathname, '/oms/instruments/historical/12345/60minute')
  assert.equal(url.searchParams.get('user_id'), 'XVXVXV')
  assert.equal(url.searchParams.get('from'), '2026-07-01')
  assert.equal(url.searchParams.get('to'), '2026-07-24')
  assert.equal(url.searchParams.get('oi'), '1')
  assert.equal(url.searchParams.get('ciqrandom'), '1700000000000')
  assert.equal(call.headers['authorization'], 'enctoken TOK')
  assert.equal(call.headers['referer'], 'https://kite.zerodha.com/static/build/chart.html?v=2.4.0')
})

test('a rejected history call still classifies as a token rejection', async () => {
  /**
   * `history.ts` reads the REJECTION VALUE, not an Error: the vendored client
   * did `reject(body)` and `describeHistoryError` was written around that. The
   * enctoken canary and the history endpoint's re-login both hang off it, so
   * the native path rejects with the same thing.
   */
  const { impl } = scriptedFetch([
    { status: 403, body: JSON.stringify({ message: 'Invalid session', error_type: 'TokenException' }) },
  ])
  await assert.rejects(
    () => nativeHistoryData('TOK', 1, 'minute', 'a', 'b', { fetchImpl: impl }),
    (err: unknown) => {
      assert.match(describeHistoryError(err), /TokenException: Invalid session/)
      assert.ok(isHistoryTokenRejection(err), 'the canary must still see this as a dead token')
      return true
    },
  )
})

test('the login PAGE answered to a history call is still a token rejection', async () => {
  const { impl } = scriptedFetch([{ body: '<!DOCTYPE html><html>login</html>' }])
  await assert.rejects(
    () => nativeHistoryData('TOK', 1, 'minute', 'a', 'b', { fetchImpl: impl }),
    (err: unknown) => {
      assert.ok(isHistoryTokenRejection(err))
      return true
    },
  )
})

test('a history session exposes the token it was built with', async () => {
  const jarPath = tempJar()
  const { impl } = scriptedFetch([...successScript(), { body: CANDLE_BODY_OI }])
  const session = await nativeZerodhaLogin(CREDS, { log: quiet, fetchImpl: impl, jarPath })
  const rows = (await session.historyData(1, 'minute', 'a', 'b')) as unknown[]
  assert.equal(rows.length, 1)
})
