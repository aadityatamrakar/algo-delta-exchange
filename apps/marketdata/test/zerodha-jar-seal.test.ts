/**
 * F-46 — the Zerodha cookie jar at rest.
 *
 * `userdata/<user_id>.json` holds the ENCTOKEN: the credential every socket,
 * the margin sweep, the history endpoint and the canary use, and the one a
 * reader of the disk can use to read this account's whole portfolio. It was
 * plaintext JSON (audit F-46) while the password that mints it was sealed.
 *
 * What this file pins:
 *   - a sealed jar is an ENVELOPE (`{v:1, sealed:'v1.…'}`), so a reader can tell
 *     the two shapes apart without guessing, and the domains and cookie values
 *     are gone from the file entirely;
 *   - a LEGACY plaintext jar still loads — the box has one right now, and a feed
 *     that cannot read it is a feed that spends a real login at boot;
 *   - an envelope that will not open is NO SESSION and a loud line, never a
 *     throw: `zerodha-native.ts` is the feed's single point of failure;
 *   - with no `DESK_MASTER_KEY` the jar stays plaintext AND says so on every
 *     boot. A blind feed is worse than a plaintext jar, and that trade is only
 *     defensible while it is audible.
 *
 * No real secret appears here: the cookies are hand-built and the key is a
 * constant buffer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cookieValue,
  decodeJarFile,
  encodeJarFile,
  jarMasterKey,
  loadCookieIndex,
  mergeSetCookies,
  nativeZerodhaLogin,
  saveCookieIndex,
  unsealJarForLegacy,
  type CookieIndex,
} from '../src/zerodha-native.ts'

const require = createRequire(import.meta.url)

const KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)
const KITE = 'https://kite.zerodha.com/'
const CREDS = { user_id: 'AB1234', password: 'pw', authkey: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }
const quiet = (): void => {}

function tempJar(): string {
  return join(mkdtempSync(join(tmpdir(), 'zerodha-seal-')), 'AB1234.json')
}

function jarWith(token: string): CookieIndex {
  return mergeSetCookies({}, [`enctoken=${token}; Path=/; Secure`], KITE, 1_700_000_000_000)
}

const collect = (): { log: (m: string, c?: Record<string, unknown>) => void; lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    log: (m, c) => void lines.push(`${m} ${c === undefined ? '' : JSON.stringify(c)}`),
  }
}

// ------------------------------------------------------------- the envelope

test('a sealed jar file is an envelope, and the cookies are not in it', () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('SECRET-ENCTOKEN'), { key: KEY })
  const raw = readFileSync(path, 'utf8')
  assert.ok(!raw.includes('SECRET-ENCTOKEN'), 'the enctoken is still on disk in the clear')
  assert.ok(!raw.includes('kite.zerodha.com'), 'even the domain index leaks which account this is')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  assert.equal(parsed['v'], 1)
  assert.match(String(parsed['sealed']), /^v1\./)
})

test('a sealed jar round-trips back to the same index', () => {
  const path = tempJar()
  const idx = jarWith('LIVE-TOKEN')
  saveCookieIndex(path, idx, { key: KEY })
  assert.deepEqual(loadCookieIndex(path, { key: KEY }), idx)
  assert.equal(
    cookieValue(loadCookieIndex(path, { key: KEY }), 'kite.zerodha.com', '/', 'enctoken'),
    'LIVE-TOKEN',
  )
})

test('decode names the three shapes apart', () => {
  const idx = jarWith('T')
  assert.deepEqual(decodeJarFile(JSON.stringify(idx), KEY), { kind: 'plain', idx })
  assert.deepEqual(decodeJarFile(encodeJarFile(idx, KEY), KEY), { kind: 'sealed', idx })
  const bad = decodeJarFile(encodeJarFile(idx, OTHER_KEY), KEY)
  assert.equal(bad.kind, 'unreadable')
  assert.equal(decodeJarFile('not json at all', KEY).kind, 'corrupt')
  assert.equal(decodeJarFile('[]', KEY).kind, 'corrupt')
})

test('a CORRUPT jar is repaired; an unopenable SEALED one is left as evidence', () => {
  // The vendored `loadCookie()` rewrites damaged bytes with `{}` because
  // `tough-cookie-filestore` throws on a file it cannot parse — and that throw
  // is what made `desk-marketdata` unbootable on a fresh clone. A sealed jar
  // that will not open is not damaged, and clobbering it destroys the only
  // evidence of which key wrote it.
  const corrupt = tempJar()
  writeFileSync(corrupt, 'not json at all')
  assert.deepEqual(loadCookieIndex(corrupt, { key: KEY }), {})
  assert.equal(readFileSync(corrupt, 'utf8'), '{}')

  const sealed = tempJar()
  saveCookieIndex(sealed, jarWith('LIVE-TOKEN'), { key: OTHER_KEY })
  const before = readFileSync(sealed, 'utf8')
  assert.deepEqual(loadCookieIndex(sealed, { key: KEY, log: quiet }), {})
  assert.equal(readFileSync(sealed, 'utf8'), before)
})

// -------------------------------------------------------------- migration

test('a LEGACY plaintext jar still loads when a key is configured', () => {
  // The migration case: this is the file sitting on the box right now.
  const path = tempJar()
  writeFileSync(path, JSON.stringify(jarWith('LEGACY-TOKEN')))
  const { log, lines } = collect()
  const idx = loadCookieIndex(path, { key: KEY, log })
  assert.equal(cookieValue(idx, 'kite.zerodha.com', '/', 'enctoken'), 'LEGACY-TOKEN')
  assert.ok(!lines.join('\n').includes('LEGACY-TOKEN'), 'the notice must not print the enctoken')
})

test('the next save seals what a plaintext jar was read from — no manual step', () => {
  const path = tempJar()
  writeFileSync(path, JSON.stringify(jarWith('LEGACY-TOKEN')))
  const idx = loadCookieIndex(path, { key: KEY })
  saveCookieIndex(path, idx, { key: KEY })
  const raw = readFileSync(path, 'utf8')
  assert.ok(!raw.includes('LEGACY-TOKEN'))
  assert.equal((JSON.parse(raw) as Record<string, unknown>)['v'], 1)
})

// -------------------------------------------------------------- the failures

test('an envelope that will not open is an EMPTY jar and a loud line, not a throw', () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: OTHER_KEY })
  const before = readFileSync(path, 'utf8')
  const { log, lines } = collect()
  assert.deepEqual(loadCookieIndex(path, { key: KEY, log }), {}, 'a fresh login is the only answer')
  assert.match(lines.join('\n'), /DESK_MASTER_KEY/)
  assert.match(lines.join('\n'), /fresh login|logging in fresh/i)
  // The file is EVIDENCE of which failure this was; the next successful login
  // overwrites it anyway, so there is nothing to gain by clobbering it here.
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('a sealed jar with no key at all is the same answer', () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: KEY })
  const { log, lines } = collect()
  assert.deepEqual(loadCookieIndex(path, { key: null, log }), {})
  assert.match(lines.join('\n'), /DESK_MASTER_KEY/)
})

test('with NO key the jar stays plaintext and the trade is said out loud', () => {
  const { log, lines } = collect()
  assert.equal(jarMasterKey({}, log), null)
  assert.match(lines.join('\n'), /DESK_MASTER_KEY/)
  assert.match(lines.join('\n'), /plaintext/i)

  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: null })
  assert.match(readFileSync(path, 'utf8'), /LIVE-TOKEN/, 'a blind feed is worse than a plain jar')
})

test('the key is the SAME DESK_MASTER_KEY derivation the rest of the desk uses', () => {
  const { log, lines } = collect()
  const key = jarMasterKey({ DESK_MASTER_KEY: KEY.toString('hex') }, log)
  assert.deepEqual(key, KEY)
  assert.deepEqual(lines, [])
})

// ----------------------------------------------------------- the legacy path

test('a sealed jar CRASHES the vendored cookie store — which is why it is opened first', () => {
  /**
   * Not a hypothetical. `tough-cookie-filestore@0.0.1` walks the file as
   * `for (domain in json) for (path in json[domain]) …`, so `sealed: 'v1.…'`
   * is walked as a string and its index assignment throws
   * `TypeError: Cannot assign to read only property '0' of string` in strict
   * mode — at CONSTRUCTION, before any login.
   *
   * The vendored client SURVIVES that: `zerodha.js`'s `loadCookie()` (lines
   * 31-38) catches it, writes `{}` over the file and reconstructs. So the cost
   * of handing it an envelope is not a crash — it is the SESSION, silently
   * wiped, and therefore a fresh password+TOTP login. Which is the whole
   * problem: see the reuse test below.
   */
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: KEY })
  const FileCookieStore = require('tough-cookie-filestore') as new (p: string) => unknown
  assert.throws(() => new FileCookieStore(path), TypeError)

  const { log } = collect()
  unsealJarForLegacy(path, { key: KEY, log })
  assert.doesNotThrow(() => new FileCookieStore(path))
})

test('a sealed jar holding a LIVE session is DECRYPTED for the vendored client, not wiped', () => {
  /**
   * THE SHIP-BLOCKER THIS FILE EXISTS FOR. The fallback fires on a TRANSIENT
   * native failure — an unreachable session probe, a blip on the home page —
   * and the jar it is handed usually holds a LIVE enctoken: the very token the
   * running feed sockets, the margin sweep and the canary are using. Emptying
   * it makes the vendored client spend a full password+TOTP login, and per the
   * 2026-08-04 incident that login INVALIDATES the enctoken those sockets hold.
   * A network blip becomes a feed outage, on the path that exists to prevent
   * outages.
   *
   * Decrypting is no worse at rest than what the clear-then-login left behind:
   * either way the vendored client writes a plaintext jar. It just does not
   * throw a live session away first.
   */
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: KEY })
  const { log, lines } = collect()

  assert.equal(unsealJarForLegacy(path, { key: KEY, log }), 'decrypted')

  const FileCookieStore = require('tough-cookie-filestore') as new (p: string) => unknown
  assert.doesNotThrow(() => new FileCookieStore(path), 'the vendored store must open it')
  assert.equal(
    cookieValue(loadCookieIndex(path, { key: KEY }), 'kite.zerodha.com', '/', 'enctoken'),
    'LIVE-TOKEN',
    'the session survived the hand-over, so the fallback reuses it',
  )
  assert.ok(
    !/REAL login/i.test(lines.join('\n')),
    'no login is being spent, so nothing may claim one is',
  )
  assert.ok(!lines.join('\n').includes('LIVE-TOKEN'), 'the enctoken reached a log line')
})

test('a jar that will NOT open is cleared, loudly — that one really does cost a login', () => {
  // The rotated-key / copied-from-another-box case. There is no session to
  // preserve here, and leaving the envelope in place would leave the vendored
  // client to wipe it anyway, without saying why.
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: OTHER_KEY })
  const { log, lines } = collect()
  assert.equal(unsealJarForLegacy(path, { key: KEY, log }), 'cleared')
  assert.equal(readFileSync(path, 'utf8'), '{}')
  // The extra login must be EXPLAINED, not left as an unexplained one in the
  // audit trail — 2026-08-04 was one login too many killing a live enctoken.
  assert.match(lines.join('\n'), /REAL login/i)
})

test('with no key at all a sealed jar is cleared, not decrypted', () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: KEY })
  const { log, lines } = collect()
  assert.equal(unsealJarForLegacy(path, { key: null, log }), 'cleared')
  assert.equal(readFileSync(path, 'utf8'), '{}')
  assert.match(lines.join('\n'), /REAL login/i)
})

test('clearing is a no-op on a jar the vendored client can already read', () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('LEGACY-TOKEN'), { key: null })
  const { log, lines } = collect()
  assert.equal(unsealJarForLegacy(path, { key: KEY, log }), 'untouched')
  assert.match(readFileSync(path, 'utf8'), /LEGACY-TOKEN/, 'a readable jar must not be thrown away')
  assert.deepEqual(lines, [])
})

test('a missing jar is untouched, and so is one that is not JSON', () => {
  const missing = tempJar()
  assert.equal(unsealJarForLegacy(missing, { key: KEY }), 'untouched')
  const corrupt = tempJar()
  writeFileSync(corrupt, 'not json at all')
  // The vendored `loadCookie()` repairs this shape itself (lines 31-38); this
  // function's job is the envelope, and nothing else.
  assert.equal(unsealJarForLegacy(corrupt, { key: KEY }), 'untouched')
  assert.equal(readFileSync(corrupt, 'utf8'), 'not json at all')
})

// --------------------------------------------------------------- end to end

type Reply = { status?: number; body: string; setCookie?: readonly string[] }

function scriptedFetch(replies: readonly Reply[]): typeof fetch {
  let i = 0
  return (async (input: string | URL) => {
    const reply = replies[i++]
    if (reply === undefined) throw new Error(`unscripted request: ${String(input)}`)
    const h = new Headers()
    for (const line of reply.setCookie ?? []) h.append('set-cookie', line)
    return new Response(reply.body, { status: reply.status ?? 200, headers: h })
  }) as unknown as typeof fetch
}

const LOGIN_OK = JSON.stringify({ status: 'success', data: { request_id: 'REQ-1' } })
const TWOFA_OK = JSON.stringify({ status: 'success', data: {} })

test('a real login writes a SEALED jar when the key is in the environment', async () => {
  const path = tempJar()
  const lines: string[] = []
  const session = await nativeZerodhaLogin(CREDS, {
    log: (m, c) => void lines.push(`${m} ${c === undefined ? '' : JSON.stringify(c)}`),
    fetchImpl: scriptedFetch([
      { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/; Secure'] },
      { body: LOGIN_OK },
      { body: TWOFA_OK, setCookie: ['enctoken=FRESH-TOKEN; Path=/; Secure'] },
    ]),
    jarPath: path,
    env: { DESK_MASTER_KEY: KEY.toString('hex') },
  })
  assert.equal(session.accessToken, 'FRESH-TOKEN')
  const raw = readFileSync(path, 'utf8')
  assert.ok(!raw.includes('FRESH-TOKEN'), 'the login wrote the enctoken to disk in the clear')
  assert.equal((JSON.parse(raw) as Record<string, unknown>)['v'], 1)
  assert.ok(!lines.join('\n').includes('FRESH-TOKEN'), 'the enctoken reached a log line')
})

test('a sealed jar with a LIVE session is reused — no login is spent', async () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: KEY })
  const lines: string[] = []
  const session = await nativeZerodhaLogin(CREDS, {
    log: (m) => void lines.push(m),
    fetchImpl: scriptedFetch([{ body: JSON.stringify({ status: 'success', data: {} }) }]),
    jarPath: path,
    env: { DESK_MASTER_KEY: KEY.toString('hex') },
  })
  assert.equal(session.accessToken, 'LIVE-TOKEN')
  assert.equal(session.reused, true)
  assert.ok(lines.some((l) => /still live/.test(l)), lines.join(' | '))
})

test('an unopenable jar costs a fresh login rather than the feed', async () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: OTHER_KEY })
  const session = await nativeZerodhaLogin(CREDS, {
    log: quiet,
    fetchImpl: scriptedFetch([
      { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/; Secure'] },
      { body: LOGIN_OK },
      { body: TWOFA_OK, setCookie: ['enctoken=FRESH-TOKEN; Path=/; Secure'] },
    ]),
    jarPath: path,
    env: { DESK_MASTER_KEY: KEY.toString('hex') },
  })
  assert.equal(session.accessToken, 'FRESH-TOKEN')
})

// -------------------------------------------------------------- the evidence

test('a FAILED login does not save over the jar it could not read', async () => {
  /**
   * `loadCookieIndex` promises an unopenable envelope is left alone because it
   * is the ONLY evidence of whether a key was rotated or the jar was copied
   * from another box — and then the login's `finally` saved over it regardless,
   * on failure as well as success. The operator arriving at the wrong-key
   * message found a file that no longer showed anything.
   *
   * The promise `loadCookieIndex` actually makes is "the next SUCCESSFUL login
   * overwrites it anyway", which is the branch below.
   */
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: OTHER_KEY })
  const before = readFileSync(path, 'utf8')
  const { log, lines } = collect()

  await assert.rejects(() =>
    nativeZerodhaLogin(CREDS, {
      log,
      // No scripted replies at all: the very first hop fails, transiently.
      fetchImpl: scriptedFetch([]),
      jarPath: path,
      env: { DESK_MASTER_KEY: KEY.toString('hex') },
    }),
  )

  assert.equal(readFileSync(path, 'utf8'), before, 'the evidence was overwritten by the finally')
  assert.match(lines.join('\n'), /preserv/i, 'and nothing said the file was being kept')
})

test('a SUCCESSFUL login overwrites the unreadable jar — as loadCookieIndex promises', async () => {
  const path = tempJar()
  saveCookieIndex(path, jarWith('LIVE-TOKEN'), { key: OTHER_KEY })
  const before = readFileSync(path, 'utf8')
  const session = await nativeZerodhaLogin(CREDS, {
    log: quiet,
    fetchImpl: scriptedFetch([
      { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/; Secure'] },
      { body: LOGIN_OK },
      { body: TWOFA_OK, setCookie: ['enctoken=FRESH-TOKEN; Path=/; Secure'] },
    ]),
    jarPath: path,
    env: { DESK_MASTER_KEY: KEY.toString('hex') },
  })
  assert.equal(session.accessToken, 'FRESH-TOKEN')
  const raw = readFileSync(path, 'utf8')
  assert.notEqual(raw, before, 'a working login must not leave a jar nobody can read')
  assert.equal(
    cookieValue(loadCookieIndex(path, { key: KEY }), 'kite.zerodha.com', '/', 'enctoken'),
    'FRESH-TOKEN',
  )
})

// ------------------------------------------------------- the test-env leak

test('DESK_MASTER_KEY in the SHELL does not reach a login handed its own env', async () => {
  /**
   * The key defaulted to `process.env`, so a developer (or a CI job) with
   * `DESK_MASTER_KEY` exported got a sealed jar out of tests that pass no env
   * and assert on plaintext cookie bytes — two of them in
   * `zerodha-native.test.ts` went red for nobody's fault. Worse than the red:
   * an injected `env` is the seam this file's whole flow is tested through, and
   * a seam that quietly reads process state is not a seam.
   */
  const before = process.env['DESK_MASTER_KEY']
  process.env['DESK_MASTER_KEY'] = KEY.toString('hex')
  try {
    const path = tempJar()
    const session = await nativeZerodhaLogin(CREDS, {
      log: quiet,
      fetchImpl: scriptedFetch([
        { body: '<html>kite</html>', setCookie: ['kf_session=S; Path=/; Secure'] },
        { body: LOGIN_OK },
        { body: TWOFA_OK, setCookie: ['enctoken=FRESH-TOKEN; Path=/; Secure'] },
      ]),
      jarPath: path,
    })
    assert.equal(session.accessToken, 'FRESH-TOKEN')
    assert.match(
      readFileSync(path, 'utf8'),
      /FRESH-TOKEN/,
      'the seal key must come from opts.env only — production passes process.env explicitly',
    )
  } finally {
    if (before === undefined) delete process.env['DESK_MASTER_KEY']
    else process.env['DESK_MASTER_KEY'] = before
  }
})
