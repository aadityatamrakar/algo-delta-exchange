import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cookieValue,
  loadCookieIndex,
  mergeSetCookies,
  saveCookieIndex,
  userdataPath,
} from '../src/zerodha-native.ts'
import {
  base32Encode,
  chooseLoginPath,
  createZerodhaClient,
  credentialsFromEnv,
  decodeMigrationUri,
  resolveZerodhaCredentials,
  vendoredFallbackAllowed,
  zerodhaLogin,
  type BrokerCredentialSource,
  type ZerodhaAccount,
  type ZerodhaConstructor,
} from '../src/zerodha-login.ts'

/**
 * No real secret appears in this file. The payloads below are synthetic,
 * hand-built to the same protobuf shape a Google Authenticator export uses.
 */

/** Build an otpauth-migration URI carrying `secret` and `name`. */
function makeMigrationUri(entries: readonly { secret: Uint8Array; name: string }[]): string {
  const chunks: number[] = []
  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf8')
    const inner: number[] = [
      0x0a, e.secret.length, ...e.secret, // field 1: secret
      0x12, nameBytes.length, ...nameBytes, // field 2: name
      0x20, 0x01, // field 4: algorithm = SHA1
      0x28, 0x01, // field 5: digits = 6
      0x30, 0x02, // field 6: type = TOTP
    ]
    chunks.push(0x0a, inner.length, ...inner)
  }
  const b64 = Buffer.from(Uint8Array.from(chunks)).toString('base64')
  return `otpauth-migration://offline?data=${encodeURIComponent(b64)}`
}

test('base32Encode matches RFC 4648 test vectors', () => {
  assert.equal(base32Encode(Buffer.from('')), '')
  assert.equal(base32Encode(Buffer.from('f')), 'MY')
  assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ')
  assert.equal(base32Encode(Buffer.from('foo')), 'MZXW6')
  assert.equal(base32Encode(Buffer.from('foob')), 'MZXW6YQ')
  assert.equal(base32Encode(Buffer.from('fooba')), 'MZXW6YTB')
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
})

test('a 20-byte secret encodes to 32 base32 characters', () => {
  // The standard TOTP secret length, and what a Kite export carries.
  const secret = Uint8Array.from(Array.from({ length: 20 }, (_, i) => i + 1))
  const encoded = base32Encode(secret)
  assert.equal(encoded.length, 32)
  assert.match(encoded, /^[A-Z2-7]+$/)
})

test('decodes a single-account migration URI', () => {
  const secret = Uint8Array.from([0xa0, 0xee, 0xe4, 0x96, 0xfa, 0x77, 0x2c, 0x4b, 0x0c, 0x3c,
                                  0xe7, 0x16, 0x03, 0x68, 0xac, 0x16, 0x13, 0x32, 0x01, 0x47])
  const uri = makeMigrationUri([{ secret, name: 'example kite' }])
  const accounts = decodeMigrationUri(uri)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.name, 'example kite')
  assert.equal(accounts[0]?.secretBase32, base32Encode(secret))
  assert.equal(accounts[0]?.secretBase32.length, 32)
})

test('decodes a MULTI-account export — the caller picks, we do not assume one', () => {
  const a = Uint8Array.from(Array.from({ length: 20 }, () => 0x11))
  const b = Uint8Array.from(Array.from({ length: 20 }, () => 0x22))
  const accounts = decodeMigrationUri(
    makeMigrationUri([{ secret: a, name: 'first' }, { secret: b, name: 'second' }]),
  )
  assert.deepEqual(accounts.map((x) => x.name), ['first', 'second'])
  assert.notEqual(accounts[0]?.secretBase32, accounts[1]?.secretBase32)
})

test('a URI without a data parameter is rejected, not silently empty', () => {
  assert.throws(() => decodeMigrationUri('otpauth-migration://offline'), /no data parameter/)
  assert.throws(() => decodeMigrationUri('https://example.com'), /no data parameter/)
})

test('credentials come from the environment and every field is required', () => {
  assert.throws(() => credentialsFromEnv({}), /ZERODHA_USER_ID/)
  assert.throws(
    () => credentialsFromEnv({ ZERODHA_USER_ID: 'X', ZERODHA_PASSWORD: 'Y' }),
    /ZERODHA_TOTP_SECRET/,
  )
  const creds = credentialsFromEnv({
    ZERODHA_USER_ID: 'X', ZERODHA_PASSWORD: 'Y', ZERODHA_TOTP_SECRET: 'Z',
  })
  assert.equal(creds.user_id, 'X')
})

// ------------------------------------------------- the constructor argument

const CREDS = { user_id: 'AB1234', password: 'pw', authkey: 'ZZZZ' }

/**
 * A stand-in for the vendored `zerodha.js`, reproducing the ONE behaviour that
 * matters here: its constructor branches on whether it was given an account,
 * and the no-argument branch synchronously opens
 * `packages/marketdata-core/userdata/common.json` — a gitignored file that does
 * not exist on a fresh server.
 *
 *     if (typeof account == 'object') this.loadConfig(account);
 *     else this.cookie_jar = request.jar(new FileCookieStore(.../common.json));
 */
class FakeZerodha {
  static lastAccount: ZerodhaAccount | undefined
  loggedIn = false

  constructor(account?: ZerodhaAccount) {
    FakeZerodha.lastAccount = account
    if (typeof account !== 'object' || account === null) {
      throw new Error("ENOENT: no such file or directory, open '.../userdata/common.json'")
    }
  }

  loadConfig(): void {}
  async login(): Promise<unknown> {
    this.loggedIn = true
    return {}
  }
  getAuthorization(): string {
    return 'enctoken abc'
  }
  async getConfig(): Promise<unknown> {
    return {}
  }
  async historyData(): Promise<unknown> {
    return []
  }
}

test('the vendor client is constructed WITH its account — a fresh clone has no common.json', () => {
  /**
   * `new Zerodha()` with no argument took the else-branch and threw at boot on
   * any machine that had not been hand-seeded with `userdata/common.json`.
   * Under pm2's `min_uptime: 10s` that is ten restarts and then an `errored`
   * process that stays down: `desk-marketdata` was unbootable on a fresh
   * server, which means no feed, no ticks, and nothing anywhere trading.
   */
  const api = createZerodhaClient(CREDS, FakeZerodha)
  assert.ok(api !== null)
  const account: ZerodhaAccount | undefined = FakeZerodha.lastAccount
  assert.ok(account !== undefined, 'the constructor must be given an account, not called bare')
  assert.deepEqual(account.credentials, CREDS)
})

test('a login goes all the way through to the enctoken', async () => {
  const session = await zerodhaLogin(CREDS, { ctor: FakeZerodha })
  assert.equal(session.accessToken, 'enctoken abc')
})

// ------------------------------------------------- native vs vendored switch

test('the NATIVE path is the default', () => {
  assert.equal(chooseLoginPath({}), 'native')
  assert.equal(chooseLoginPath({ env: {} }), 'native')
  assert.equal(chooseLoginPath({ env: { DESK_LEGACY_ZERODHA_LOGIN: '' } }), 'native')
  assert.equal(chooseLoginPath({ env: { DESK_LEGACY_ZERODHA_LOGIN: '0' } }), 'native')
  assert.equal(chooseLoginPath({ env: { DESK_LEGACY_ZERODHA_LOGIN: 'no' } }), 'native')
})

test('DESK_LEGACY_ZERODHA_LOGIN=1 puts the VENDORED client back on the path', () => {
  /**
   * The one-release escape hatch. The native flow cannot be proved offline —
   * only Zerodha can say whether it accepts the bytes — so an operator whose
   * feed will not log in at 08:50 needs a way back that is an env var and a
   * restart, not a deploy.
   */
  assert.equal(chooseLoginPath({ env: { DESK_LEGACY_ZERODHA_LOGIN: '1' } }), 'legacy')
  assert.equal(chooseLoginPath({ env: { DESK_LEGACY_ZERODHA_LOGIN: 'true' } }), 'legacy')
  assert.equal(chooseLoginPath({ env: { DESK_LEGACY_ZERODHA_LOGIN: 'YES' } }), 'legacy')
})

test('an injected constructor still means the vendored path', () => {
  // Anything handing in a `ctor` is asking for the vendored client by name.
  assert.equal(chooseLoginPath({ ctor: FakeZerodha, env: {} }), 'legacy')
})

test('which path ran is LOGGED, both ways', async () => {
  /**
   * A silent switch is a switch nobody can audit after a bad morning: "was the
   * feed on the new login when it failed?" has to be answerable from
   * `pm2 logs dx-marketdata` alone.
   */
  const legacy: string[] = []
  await zerodhaLogin(CREDS, { ctor: FakeZerodha, log: (m) => legacy.push(m) })
  assert.ok(legacy.some((l) => /legacy vendored/i.test(l)), legacy.join(' | '))

  const native: string[] = []
  await zerodhaLogin(CREDS, {
    env: {},
    log: (m) => native.push(m),
    jarPath: join(mkdtempSync(join(tmpdir(), 'zerodha-switch-')), 'AB1234.json'),
    fetchImpl: nativeScript(),
  })
  assert.ok(native.some((l) => /native/i.test(l)), native.join(' | '))
})

/** The three scripted replies of a successful native login. */
function nativeScript(): typeof fetch {
  const replies: { body: string; cookie?: string }[] = [
    { body: '<html>kite</html>', cookie: 'kf_session=S; Path=/; Secure' },
    { body: JSON.stringify({ status: 'success', data: { request_id: 'REQ-1' } }) },
    { body: JSON.stringify({ status: 'success' }), cookie: 'enctoken=NATIVE-TOKEN; Path=/; Secure' },
  ]
  let i = 0
  return (async () => {
    const reply = replies[i++]
    if (reply === undefined) throw new Error('unscripted request')
    const headers = new Headers()
    if (reply.cookie !== undefined) headers.append('set-cookie', reply.cookie)
    return new Response(reply.body, { status: 200, headers })
  }) as unknown as typeof fetch
}

test('the native path is what a plain zerodhaLogin() actually runs', async () => {
  const session = await zerodhaLogin(CREDS, {
    env: {},
    log: () => {},
    jarPath: join(mkdtempSync(join(tmpdir(), 'zerodha-switch-')), 'AB1234.json'),
    fetchImpl: nativeScript(),
  })
  assert.equal(session.accessToken, 'NATIVE-TOKEN')
})

test('the legacy env var routes a plain call to the vendored client', async () => {
  const session = await zerodhaLogin(CREDS, {
    env: { DESK_LEGACY_ZERODHA_LOGIN: '1' },
    log: () => {},
    ctor: FakeZerodha,
  })
  assert.equal(session.accessToken, 'enctoken abc')
})

// ------------------------------------------- the automatic vendored fallback

function tempJar(): string {
  return join(mkdtempSync(join(tmpdir(), 'zerodha-fallback-')), 'AB1234.json')
}

/**
 * A vendored stand-in that RECORDS, onto a shared timeline, the moment it is
 * asked to log in — so a test can assert not just THAT the fallback ran but
 * that the loud line was written BEFORE it did. A fallback nobody could see in
 * `pm2 logs dx-marketdata` until after the fact is a fallback that turns
 * "which login path failed this morning?" back into a guess.
 */
function countingVendor(timeline: string[]): { ctor: ZerodhaConstructor; state: { logins: number } } {
  const state = { logins: 0 }
  class Counting extends FakeZerodha {
    override async login(): Promise<unknown> {
      state.logins++
      timeline.push('vendor:login')
      return super.login()
    }
  }
  return { ctor: Counting as unknown as ZerodhaConstructor, state }
}

/** A native fetch that dies on the very first hop — before any credential is sent. */
const deadNetwork = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch

/** Scripted replies up to and including the second-factor POST. */
function nativeScriptUpTo(twofa: { status: number; body: string; cookie?: string }): typeof fetch {
  const replies: { status: number; body: string; cookie?: string }[] = [
    { status: 200, body: '<html>kite</html>', cookie: 'kf_session=S; Path=/; Secure' },
    { status: 200, body: JSON.stringify({ status: 'success', data: { request_id: 'REQ-1' } }) },
    twofa,
  ]
  let i = 0
  return (async () => {
    const reply = replies[i++]
    if (reply === undefined) throw new Error('unscripted request')
    const headers = new Headers()
    if (reply.cookie !== undefined) headers.append('set-cookie', reply.cookie)
    return new Response(reply.body, { status: reply.status, headers })
  }) as unknown as typeof fetch
}

test('a native failure BEFORE any credential is spent falls back to the vendored client, ONCE and loudly', async () => {
  /**
   * The native path is the default and nothing has ever proved Zerodha accepts
   * its bytes (see `chooseLoginPath`). Until this, "it does not" meant a blind
   * desk until a human noticed, read the log, set `DESK_LEGACY_ZERODHA_LOGIN=1`
   * and restarted — at 09:15, on a live account. The vendored client is sitting
   * right there and shares the same jar, so the first attempt costs nothing
   * extra: take it automatically, and SAY SO.
   */
  const timeline: string[] = []
  const { ctor, state } = countingVendor(timeline)
  const session = await zerodhaLogin(CREDS, {
    env: {},
    log: (m) => timeline.push(`log:${m}`),
    jarPath: tempJar(),
    fetchImpl: deadNetwork,
    fallbackCtor: ctor,
  })

  assert.equal(session.accessToken, 'enctoken abc', 'the vendored client produced the session')
  assert.equal(state.logins, 1, 'exactly one vendored attempt — a fallback, not a loop')

  const loud = timeline.findIndex((l) =>
    /^log:native zerodha login FAILED — falling back to the vendored client for this attempt: /.test(l),
  )
  assert.ok(loud >= 0, timeline.join(' | '))
  assert.match(timeline[loud] as string, /fetch failed/, 'the reason travels with the line')
  assert.ok(loud < timeline.indexOf('vendor:login'), 'the line is written BEFORE the retry')
})

test('a native failure AFTER the second-factor POST does NOT auto-retry', async () => {
  /**
   * THE TOTP WINDOW IS ALREADY SPENT and a session may already exist on
   * Zerodha's side. A second password+TOTP login on a live account is not free
   * — it is the same pacing argument `FeedRecovery` makes when it refuses to
   * re-login on every blip, and the 2026-08-04 outage was one login too many
   * killing a token the sockets were holding. A transient-looking 502 on the
   * twofa call is the tempting one, and it is exactly the one to leave alone:
   * the request reached Kite.
   */
  const timeline: string[] = []
  const { ctor, state } = countingVendor(timeline)
  await assert.rejects(
    () =>
      zerodhaLogin(CREDS, {
        env: {},
        log: (m) => timeline.push(`log:${m}`),
        jarPath: tempJar(),
        fetchImpl: nativeScriptUpTo({ status: 502, body: 'bad gateway' }),
        fallbackCtor: ctor,
      }),
    /second-factor/,
  )
  assert.equal(state.logins, 0, 'no second real login on a live account')
  assert.ok(
    timeline.some((l) => /^log:/.test(l) && /not retrying|no automatic retry/i.test(l)),
    timeline.join(' | '),
  )
})

test('a native login that reaches twofa and gets no enctoken is surfaced, not retried', async () => {
  // The other post-twofa shape: Kite said `success`, the enctoken cookie is
  // missing. The second factor was still consumed.
  const timeline: string[] = []
  const { ctor, state } = countingVendor(timeline)
  await assert.rejects(
    () =>
      zerodhaLogin(CREDS, {
        env: {},
        log: (m) => timeline.push(`log:${m}`),
        jarPath: tempJar(),
        fetchImpl: nativeScriptUpTo({ status: 200, body: JSON.stringify({ status: 'success' }) }),
        fallbackCtor: ctor,
      }),
    /no enctoken/,
  )
  assert.equal(state.logins, 0)
})

test('DESK_LEGACY_ZERODHA_LOGIN=1 never attempts the native path at all', async () => {
  const timeline: string[] = []
  const { ctor, state } = countingVendor(timeline)
  let nativeCalls = 0
  const spy = (async () => {
    nativeCalls++
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  const session = await zerodhaLogin(CREDS, {
    env: { DESK_LEGACY_ZERODHA_LOGIN: '1' },
    log: (m) => timeline.push(`log:${m}`),
    jarPath: tempJar(),
    fetchImpl: spy,
    ctor,
  })
  assert.equal(session.accessToken, 'enctoken abc')
  assert.equal(nativeCalls, 0, 'the escape hatch means vendored ONLY — no native attempt first')
  assert.equal(state.logins, 1)
})

test('DESK_NATIVE_ZERODHA_ONLY=1 removes the fallback — the native failure stands', async () => {
  /**
   * The switch for the day the vendored client (and its four unmaintained
   * packages) is retired: prove the desk runs with no fallback before deleting
   * the fallback.
   */
  const timeline: string[] = []
  const { ctor, state } = countingVendor(timeline)
  await assert.rejects(
    () =>
      zerodhaLogin(CREDS, {
        env: { DESK_NATIVE_ZERODHA_ONLY: '1' },
        log: (m) => timeline.push(`log:${m}`),
        jarPath: tempJar(),
        fetchImpl: deadNetwork,
        fallbackCtor: ctor,
      }),
    /fetch failed/,
  )
  assert.equal(state.logins, 0)
  assert.ok(!timeline.some((l) => /falling back/.test(l)), timeline.join(' | '))
})

test('the fallback is allowed by default and only DESK_NATIVE_ZERODHA_ONLY removes it', () => {
  assert.equal(vendoredFallbackAllowed({}), true)
  assert.equal(vendoredFallbackAllowed({ DESK_NATIVE_ZERODHA_ONLY: '' }), true)
  assert.equal(vendoredFallbackAllowed({ DESK_NATIVE_ZERODHA_ONLY: '0' }), true)
  assert.equal(vendoredFallbackAllowed({ DESK_NATIVE_ZERODHA_ONLY: '1' }), false)
  assert.equal(vendoredFallbackAllowed({ DESK_NATIVE_ZERODHA_ONLY: 'true' }), false)
  assert.equal(vendoredFallbackAllowed({ DESK_NATIVE_ZERODHA_ONLY: 'YES' }), false)
})

test('the legacy escape hatch still wins when both switches are set', () => {
  // Contradictory instructions; the emergency lever is the one that decides,
  // because it is the one an operator sets at 08:50 with the feed down.
  assert.equal(
    chooseLoginPath({ env: { DESK_LEGACY_ZERODHA_LOGIN: '1', DESK_NATIVE_ZERODHA_ONLY: '1' } }),
    'legacy',
  )
})

// -------------------------------- the fallback and the jar the vendor reads

/**
 * THE FALLBACK MUST NOT COST THE FEED ITS TOKEN.
 *
 * These two pin the seam between `zerodha-login.ts` and the jar on disk, and
 * both of them are about the same morning: the native path hits a blip, the
 * automatic fallback fires, and the jar in its hand is holding a LIVE enctoken —
 * the one every running socket, the margin sweep and the canary are using. If
 * the hand-over empties that jar, the vendored client spends a full
 * password+TOTP login, and per the 2026-08-04 incident that login invalidates
 * the token the sockets hold. The blip becomes an outage, on the safety path.
 */
const JAR_KEY = Buffer.alloc(32, 7)

function sealedJarAt(userId: string, enctoken: string): string {
  const path = userdataPath(userId)
  saveCookieIndex(
    path,
    mergeSetCookies({}, [`enctoken=${enctoken}; Path=/; Secure`], 'https://kite.zerodha.com/', 1),
    { key: JAR_KEY },
  )
  return path
}

/**
 * A vendored stand-in that reads the file the REAL vendored client reads.
 *
 * `zerodha.js` hardcodes `__dirname + '/../userdata/' + user_id + '.json'` — it
 * has never heard of `opts.jarPath`, which is a native-path seam. So this
 * records what is in THAT file at login time: an empty read is the fresh login
 * the fallback was never supposed to spend.
 */
function jarReadingVendor(
  userId: string,
  seen: { enctoken: string; reads: number },
): ZerodhaConstructor {
  class JarReader extends FakeZerodha {
    override async login(): Promise<unknown> {
      seen.reads++
      const idx = JSON.parse(readFileSync(userdataPath(userId), 'utf8')) as Record<
        string,
        Record<string, Record<string, { value?: string }>>
      >
      seen.enctoken = idx['kite.zerodha.com']?.['/']?.['enctoken']?.value ?? ''
      return super.login()
    }
  }
  return JarReader as unknown as ZerodhaConstructor
}

test('a transient native failure hands the vendored client the LIVE session, not an empty jar', async () => {
  const userId = 'ZZSEAL1'
  const path = sealedJarAt(userId, 'LIVE-TOKEN')
  const seen = { enctoken: '', reads: 0 }
  try {
    const session = await zerodhaLogin(
      { user_id: userId, password: 'pw', authkey: 'ZZZZ' },
      {
        env: { DESK_MASTER_KEY: JAR_KEY.toString('hex') },
        log: () => {},
        jarPath: tempJar(),
        fetchImpl: deadNetwork,
        fallbackCtor: jarReadingVendor(userId, seen),
      },
    )
    assert.equal(session.accessToken, 'enctoken abc')
    assert.equal(seen.reads, 1, 'exactly one vendored attempt')
    assert.equal(
      seen.enctoken,
      'LIVE-TOKEN',
      'the fallback emptied a jar holding a live enctoken — the vendored client now spends a ' +
        'real password+TOTP login, which is what killed the running sockets on 2026-08-04',
    )
  } finally {
    rmSync(path, { force: true })
  }
})

test('the fallback opens the file the VENDORED client reads — never opts.jarPath', async () => {
  /**
   * `opts.jarPath` is a NATIVE seam. Pointing the unseal at it meant that in
   * production (where it is undefined) the right file was hit by luck, and in
   * any test or future caller that sets it, the fallback unsealed a file the
   * vendored client never opens while leaving the one it does open sealed.
   */
  const userId = 'ZZSEAL2'
  const real = sealedJarAt(userId, 'LIVE-TOKEN')
  const decoy = tempJar()
  saveCookieIndex(
    decoy,
    mergeSetCookies({}, ['enctoken=DECOY; Path=/; Secure'], 'https://kite.zerodha.com/', 1),
    { key: JAR_KEY },
  )
  const seen = { enctoken: '', reads: 0 }
  try {
    await zerodhaLogin(
      { user_id: userId, password: 'pw', authkey: 'ZZZZ' },
      {
        env: { DESK_MASTER_KEY: JAR_KEY.toString('hex') },
        log: () => {},
        jarPath: decoy,
        fetchImpl: deadNetwork,
        fallbackCtor: jarReadingVendor(userId, seen),
      },
    )
    // The file the vendored client reads is the one that was opened for it.
    assert.equal(seen.enctoken, 'LIVE-TOKEN')
    // And the native seam's jar is still SEALED — the unseal never touched it.
    const raw = JSON.parse(readFileSync(decoy, 'utf8')) as Record<string, unknown>
    assert.equal(raw['v'], 1, 'the native jar was unsealed on disk by the legacy hand-over')
    assert.equal(
      cookieValue(loadCookieIndex(decoy, { key: JAR_KEY }), 'kite.zerodha.com', '/', 'enctoken'),
      'DECOY',
    )
  } finally {
    rmSync(real, { force: true })
  }
})

// -------------------------------------------------- Phase A §6: credentials

function brokerStore(
  read: Awaited<ReturnType<BrokerCredentialSource['readSecret']>>,
  meta: Record<string, string | number | boolean> = {},
): BrokerCredentialSource {
  return { readSecret: async () => read, get: async () => ({ meta }) }
}

test('the PORTAL credentials win over the environment', async () => {
  /**
   * Phase A §6. Until now this process read `ZERODHA_*` and nothing else, so an
   * operator who rotated the password on the Brokers page, watched "test" go
   * green, and restarted the feed got a feed still logging in with whatever was
   * baked into `.env.local` at deploy time. The portal was a display that
   * changed nothing.
   */
  const resolved = await resolveZerodhaCredentials({
    brokers: brokerStore(
      { kind: 'ok', secret: { password: 'portal-pw', totpSecret: 'PORTALKEY' } },
      { userId: 'PORTAL1' },
    ),
    env: { ZERODHA_USER_ID: 'ENV1', ZERODHA_PASSWORD: 'env-pw', ZERODHA_TOTP_SECRET: 'ENVKEY' },
  })
  assert.equal(resolved.source, 'broker-store')
  assert.deepEqual(resolved.credentials, {
    user_id: 'PORTAL1',
    password: 'portal-pw',
    authkey: 'PORTALKEY',
  })
})

test('the field names match what the Brokers page VERIFIED', async () => {
  // `apps/api/src/routes/brokers.ts` reads userId/user_id, password, and
  // totpSecret/authkey/totp_secret. Reading a different set here would mean the
  // credentials the portal tested are not the credentials the feed uses.
  const resolved = await resolveZerodhaCredentials({
    brokers: brokerStore({
      kind: 'ok',
      secret: { user_id: 'ALT1', password: 'p', authkey: 'K' },
    }),
    env: {},
  })
  assert.equal(resolved.credentials.user_id, 'ALT1')
  assert.equal(resolved.credentials.authkey, 'K')
})

test('no portal row falls back to the environment, and says why', async () => {
  const lines: string[] = []
  const resolved = await resolveZerodhaCredentials({
    brokers: brokerStore({ kind: 'absent' }),
    env: { ZERODHA_USER_ID: 'ENV1', ZERODHA_PASSWORD: 'env-pw', ZERODHA_TOTP_SECRET: 'ENVKEY' },
    log: (m, ctx) => lines.push(`${m} ${JSON.stringify(ctx ?? {})}`),
  })
  assert.equal(resolved.source, 'env')
  assert.ok(lines.some((l) => l.includes('no zerodha credentials are configured in the portal')))
})

test('an UNREADABLE row is reported as a key problem, not as "none configured"', async () => {
  // The two are fixed by completely different actions — re-entering credentials
  // vs. restoring the master key — and collapsing them sends the operator after
  // the wrong one.
  const lines: string[] = []
  const resolved = await resolveZerodhaCredentials({
    brokers: brokerStore({ kind: 'unreadable', reason: 'will not decrypt with the current key' }),
    env: { ZERODHA_USER_ID: 'ENV1', ZERODHA_PASSWORD: 'env-pw', ZERODHA_TOTP_SECRET: 'ENVKEY' },
    log: (m, ctx) => lines.push(`${m} ${JSON.stringify(ctx ?? {})}`),
  })
  assert.equal(resolved.source, 'env')
  assert.ok(lines.some((l) => l.includes('will not decrypt')))
})

test('a broker store that THROWS does not stop the feed booting', async () => {
  // Mongo being unreachable must not take market data down over a credential
  // read that has a perfectly good fallback.
  const resolved = await resolveZerodhaCredentials({
    brokers: {
      readSecret: async () => {
        throw new Error('mongo unreachable')
      },
      get: async () => ({ meta: {} }),
    },
    env: { ZERODHA_USER_ID: 'ENV1', ZERODHA_PASSWORD: 'env-pw', ZERODHA_TOTP_SECRET: 'ENVKEY' },
  })
  assert.equal(resolved.source, 'env')
})

test('neither source usable is one error naming BOTH', async () => {
  await assert.rejects(
    () => resolveZerodhaCredentials({ brokers: brokerStore({ kind: 'absent' }), env: {} }),
    /no zerodha credentials are configured in the portal.*ZERODHA_USER_ID/s,
  )
})

test('a partial portal row falls back rather than logging in with half a credential', async () => {
  const resolved = await resolveZerodhaCredentials({
    brokers: brokerStore({ kind: 'ok', secret: { password: 'p' } }),
    env: { ZERODHA_USER_ID: 'ENV1', ZERODHA_PASSWORD: 'env-pw', ZERODHA_TOTP_SECRET: 'ENVKEY' },
  })
  assert.equal(resolved.source, 'env')
})
