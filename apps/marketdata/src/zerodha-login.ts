/**
 * Zerodha read-only login, for MARKET DATA ONLY.
 *
 * This produces the enctoken the Kite websocket needs, and nothing else. The
 * adapter is incapable of placing an order because it never touches an order
 * endpoint — the same "incapable by construction" reasoning as
 * `ZerodhaDataAdapter` (D1: order placement goes through XTS).
 *
 * TWO IMPLEMENTATIONS OF ONE FLOW, and this module picks between them.
 * `zerodha-native.ts` does the login → twofa → enctoken dance on global `fetch`
 * and `node:crypto`; `packages/marketdata-core/vendor/zerodha.js` does it on
 * `request` + `authenticator` + `tough-cookie-filestore`. Native is the
 * DEFAULT (roadmap 18b: the vendored chain is four unmaintained packages, one
 * of them carrying a CVE, sitting on the credential path of a live trading
 * account), and `DESK_LEGACY_ZERODHA_LOGIN=1` restores the vendored one for a
 * release — see `chooseLoginPath`, which explains why the fallback exists at
 * all. Both write and read the SAME `userdata/<user_id>.json`, so the switch
 * costs no login and invalidates no running session.
 *
 * AND THE SWITCH THROWS ITSELF, ONCE, WHEN THE NATIVE PATH FAILS. The one
 * thing no offline test can prove is that Zerodha accepts the native bytes, and
 * the recovery from "it does not" used to be a human noticing a blind desk,
 * reading the log, setting an env var and restarting — at 09:15, on a live
 * account. A native failure that spent NOTHING now retries immediately on the
 * vendored client and says so loudly first; a native failure that already
 * POSTed the second factor does NOT, because that retry is a second real
 * password+TOTP login (see `zerodhaLogin`, and `twofaWasSent` next door).
 * `DESK_NATIVE_ZERODHA_ONLY=1` removes the fallback for the day it retires.
 *
 * CREDENTIALS COME FROM THE PORTAL'S BROKER STORE FIRST, THE ENVIRONMENT
 * SECOND. Never from a file in the repo, never inline. The repo has leaked four
 * credential sets this way already (totp.js, finvasia.js, the Atlas strings,
 * and the three candlestrategy files). `resolveZerodhaCredentials` is the one
 * place that ordering lives; see its docstring for why the store wins.
 */

import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  jarMasterKey,
  nativeZerodhaLogin,
  twofaWasSent,
  unsealJarForLegacy,
  userdataPath,
} from './zerodha-native.ts'

const require = createRequire(import.meta.url)

export interface ZerodhaCredentials {
  readonly user_id: string
  readonly password: string
  /** Base32 TOTP secret. See `decodeMigrationUri` if you have a QR export. */
  readonly authkey: string
}

export interface ZerodhaSession {
  /** The enctoken, passed to KiteTicker as `access_token`. */
  readonly accessToken: string
  /** Historical candles. Present so callers do not re-login for them. */
  historyData(token: number, interval: string, from: string, to: string): Promise<unknown>
}

/** The account blob the vendor's `loadConfig` reads. */
export interface ZerodhaAccount {
  readonly credentials: ZerodhaCredentials
  readonly config: Record<string, unknown>
  readonly lastLogin: number | null
}

interface RawZerodha {
  loadConfig(account: { credentials: unknown; config: unknown; lastLogin: unknown }): void
  login(force?: boolean): Promise<unknown>
  getAuthorization(): string
  getConfig(): Promise<unknown>
  historyData(token: number, interval: string, from: string, to: string): Promise<unknown>
}

/** Constructor shape of the vendored class. Injectable so tests need no network. */
export type ZerodhaConstructor = new (account?: ZerodhaAccount) => RawZerodha

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): ZerodhaCredentials {
  const user_id = env['ZERODHA_USER_ID']
  const password = env['ZERODHA_PASSWORD']
  const authkey = env['ZERODHA_TOTP_SECRET']
  if (user_id === undefined || password === undefined || authkey === undefined) {
    throw new Error(
      'ZERODHA_USER_ID, ZERODHA_PASSWORD and ZERODHA_TOTP_SECRET are required for the market-data login',
    )
  }
  return { user_id, password, authkey }
}

/**
 * The vendored cookie-jar directory, created if it is not there.
 *
 * `loadConfig` does `fs.writeFileSync(__dirname + '/../userdata/<user_id>.json')`
 * with no mkdir, so a checkout whose `userdata/` was pruned (it is gitignored
 * apart from a `.gitkeep`) makes the login throw ENOENT at boot — and pm2's
 * `min_uptime: 10s` turns that into ten restarts and an `errored` process. One
 * idempotent mkdir removes a whole class of first-boot failure.
 */
function ensureUserdataDir(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  mkdirSync(resolvePath(here, '../../../packages/marketdata-core/userdata'), { recursive: true })
}

/**
 * Build the vendored client with its account blob PASSED TO THE CONSTRUCTOR.
 *
 * This argument is the difference between booting and not. `zerodha.js`'s
 * constructor branches on it:
 *
 *     if (typeof account == 'object') this.loadConfig(account);
 *     else this.cookie_jar = request.jar(new FileCookieStore(__dirname + '/../userdata/common.json'));
 *
 * The else-branch SYNCHRONOUSLY reads `userdata/common.json` — a gitignored
 * file that does not exist on a fresh server — and `tough-cookie-filestore`
 * throws when it is missing. Constructing with no argument therefore made
 * `desk-marketdata` unbootable on any machine that had not been hand-seeded:
 * the throw happens before `loadConfig` can create the per-user jar, pm2
 * restarts it ten times inside `min_uptime` and then marks it `errored` and
 * stops. Passing the account takes the object branch, which writes the
 * per-user jar itself if it is absent.
 */
export function createZerodhaClient(
  creds: ZerodhaCredentials,
  ctor?: ZerodhaConstructor,
): RawZerodha {
  let Zerodha = ctor
  if (Zerodha === undefined) {
    ensureUserdataDir()
    Zerodha = require('../../../packages/marketdata-core/vendor/zerodha.js') as ZerodhaConstructor
  }
  // The account is the ARGUMENT, not a follow-up `loadConfig` call. The
  // constructor performs `loadConfig` itself on this branch; calling it again
  // would only redo the cookie load.
  return new Zerodha({ credentials: creds, config: {}, lastLogin: null })
}

/** Which implementation of the login flow a call will use. */
export type ZerodhaLoginPath = 'native' | 'legacy'

/**
 * Native by default; the vendored client only when asked for.
 *
 * ROADMAP 18b. `zerodha-native.ts` performs the same three requests on global
 * `fetch` and `node:crypto`, which retires `request`, `debug@2`,
 * `tough-cookie-filestore@0.0.1` and `authenticator` from the credential path
 * of a live trading account. The vendored client stays for ONE RELEASE behind
 * `DESK_LEGACY_ZERODHA_LOGIN=1`, because the one thing no test can prove
 * offline is that Zerodha accepts the native path's bytes — and the morning it
 * does not, the fix has to be an env var and a restart rather than a deploy.
 *
 * An injected `ctor` is a request for the vendored client BY NAME (the existing
 * tests, and anything stubbing the class), so it wins over the environment.
 */
export function chooseLoginPath(opts: {
  ctor?: ZerodhaConstructor | undefined
  env?: NodeJS.ProcessEnv | undefined
}): ZerodhaLoginPath {
  if (opts.ctor !== undefined) return 'legacy'
  // `DESK_LEGACY_ZERODHA_LOGIN` is read FIRST, so it also wins over
  // `DESK_NATIVE_ZERODHA_ONLY` when both are set: the two are contradictory
  // instructions, and the emergency lever is the one an operator reaches for at
  // 08:50 with the feed down. `DESK_NATIVE_ZERODHA_ONLY` is a pre-retirement
  // rehearsal, which is not an emergency.
  const flag = (opts.env ?? process.env)['DESK_LEGACY_ZERODHA_LOGIN'] ?? ''
  return /^(1|true|yes)$/i.test(flag.trim()) ? 'legacy' : 'native'
}

/**
 * May a FAILED native attempt retry once on the vendored client?
 *
 * Yes by default, and this is the point of the pair of switches. The native
 * path is unproven against the real Zerodha (see `chooseLoginPath`), and until
 * now the recovery from "it does not work" was a HUMAN noticing a blind desk,
 * reading the log, setting an env var and restarting — at 09:15, on a live
 * account. The vendored client is still in the tree, shares the same cookie
 * jar, and does the same three requests, so the automatic retry costs nothing
 * a manual one would not have cost, and it costs it immediately.
 *
 * `DESK_NATIVE_ZERODHA_ONLY=1` removes it. That is the switch for the day the
 * vendored client and its four unmaintained packages are retired: run without
 * the net first, then cut it.
 */
export function vendoredFallbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env['DESK_NATIVE_ZERODHA_ONLY'] ?? ''
  return !/^(1|true|yes)$/i.test(flag.trim())
}

export interface ZerodhaLoginOptions {
  /** Forces the vendored client. Present for the existing tests and the fallback. */
  readonly ctor?: ZerodhaConstructor
  /**
   * The vendored class the AUTOMATIC fallback builds, when the native path was
   * chosen and then failed. Separate from `ctor` because `ctor` means "use the
   * vendored client by name" and would skip the native attempt entirely;
   * production leaves this undefined and `createZerodhaClient` requires the
   * real one.
   */
  readonly fallbackCtor?: ZerodhaConstructor
  readonly env?: NodeJS.ProcessEnv
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
  /** Native path seams, injected by tests. */
  readonly fetchImpl?: typeof fetch
  /**
   * THE NATIVE PATH'S JAR, AND ONLY THE NATIVE PATH'S.
   *
   * The vendored client has never heard of it: `zerodha.js` hardcodes
   * `__dirname + '/../userdata/' + user_id + '.json'` in `loadConfig` and
   * `loadCookie` alike, which is what `userdataPath` returns. So anything the
   * LEGACY path does to a jar must target that file — pointing it here meant the
   * right file was hit by luck in production (where this is undefined) and the
   * wrong one in every caller that sets it.
   */
  readonly jarPath?: string
  readonly now?: () => number
}

/**
 * The vendored client's login, the same three steps on `request`.
 *
 * IT STILL READS AND WRITES A PLAINTEXT JAR (F-46). The native path seals
 * `userdata/<user_id>.json`, and `tough-cookie-filestore@0.0.1` cannot read an
 * envelope — it throws inside its constructor, which `zerodha.js`'s
 * `loadCookie()` catches by writing `{}` over the file and reconstructing. So
 * handing the vendored client a sealed jar does not break it; it silently
 * destroys the SESSION in it, and this path is reached on TRANSIENT native
 * failures where that session is usually live. `unsealJarForLegacy` therefore
 * DECRYPTS the envelope in place, and only clears one that will not open — see
 * its docstring, and `zerodha-native.ts`'s header, for the 2026-08-04 reason
 * that distinction is a ship-blocker rather than a nicety.
 *
 * THE FILE IT TARGETS IS THE VENDORED CLIENT'S OWN, not `opts.jarPath`: the
 * vendored client hardcodes `userdata/<user_id>.json` and has no idea the native
 * seam exists. The next native save re-seals whatever plaintext is left behind.
 * All of it retires with the vendored client (roadmap 18b).
 */
async function vendoredLogin(
  creds: ZerodhaCredentials,
  ctor: ZerodhaConstructor | undefined,
  opts: {
    key: Buffer | null
    log: (m: string, c?: Record<string, unknown>) => void
  },
): Promise<ZerodhaSession> {
  unsealJarForLegacy(userdataPath(creds.user_id), { key: opts.key, log: opts.log })
  const api = createZerodhaClient(creds, ctor)
  const result = await api.login()
  if (result === false) throw new Error(`Zerodha login failed for ${creds.user_id}`)
  const accessToken = api.getAuthorization()
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Zerodha login returned no enctoken')
  }
  return {
    accessToken,
    historyData: (token, interval, from, to) => api.historyData(token, interval, from, to),
  }
}

export async function zerodhaLogin(
  creds: ZerodhaCredentials,
  opts: ZerodhaLoginOptions = {},
): Promise<ZerodhaSession> {
  const log =
    opts.log ??
    ((msg: string, ctx?: Record<string, unknown>): void => {
      // `console.log`, like the vendored client's own `<user> logging in` line:
      // this function is called before (and independently of) the process
      // logger main.ts builds, and a boot line nobody can see is a boot line
      // that cannot be audited after a bad morning.
      console.log(msg, ctx ?? '')
    })
  const path = chooseLoginPath(opts)
  /**
   * THE PROCESS ENVIRONMENT IS RESOLVED HERE AND NOWHERE DEEPER.
   *
   * `jarMasterKey` and `nativeZerodhaLogin` take an `env` argument with no
   * `process.env` default on purpose (F-46 review): a default made the jar's
   * seal key a property of the SHELL, so an exported `DESK_MASTER_KEY` reached
   * into tests that pass their own env. This is the production boundary — the
   * one place that says "no env was given, so the process's is meant" — and
   * everything below is handed it explicitly.
   */
  const env = opts.env ?? process.env

  if (path === 'native') {
    log('zerodha login: NATIVE fetch path (set DESK_LEGACY_ZERODHA_LOGIN=1 for the vendored one)')
    // `userdata/` is created here too: the native jar lives in the same
    // directory as the vendored one, on purpose, so the two paths share a
    // session and flipping the switch costs no login.
    ensureUserdataDir()
    try {
      return await nativeZerodhaLogin(creds, {
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
        ...(opts.jarPath === undefined ? {} : { jarPath: opts.jarPath }),
        ...(opts.now === undefined ? {} : { now: opts.now }),
        env,
        log,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)

      if (!vendoredFallbackAllowed(env)) {
        // DESK_NATIVE_ZERODHA_ONLY: the net was removed on purpose.
        log('zerodha login: the native path failed and DESK_NATIVE_ZERODHA_ONLY forbids the fallback', {
          reason,
        })
        throw err
      }

      if (twofaWasSent(err)) {
        /**
         * NOT FREE, so not automatic. The TOTP has already been handed to Kite
         * and a session may exist on their side; running the whole flow again
         * on the vendored client is a SECOND password+TOTP login on a live
         * account. That is the pacing `FeedRecovery` argues for every time it
         * declines to re-login on a blip — and 2026-08-04 was one login too
         * many invalidating the enctoken the running sockets were holding.
         * Classify it, say why nothing else is being tried, and surface the
         * original error UNCHANGED so `FeedRecovery` reads the same words it
         * has always read.
         */
        log(
          'native zerodha login failed AFTER the second factor was already sent — NOT retrying on the ' +
            'vendored client (the TOTP is spent and a session may exist; a second live login is not free)',
          { reason, userId: creds.user_id },
        )
        throw err
      }

      /**
       * LOGGED BEFORE THE RETRY, not after it. If the vendored attempt also
       * hangs or dies, this line is the only record that the native path was
       * tried first and what it said — and "which login was the feed on when it
       * failed?" is the first question of every bad morning.
       */
      log(
        `native zerodha login FAILED — falling back to the vendored client for this attempt: ${reason}`,
        { userId: creds.user_id },
      )
      // The same jar, so the fallback re-uses whatever cookies the native hops
      // did collect — INCLUDING a live enctoken, which is the usual case on a
      // transient failure and the reason `vendoredLogin` opens the seal instead
      // of emptying the file. It costs nothing the manual switch would not have
      // cost.
      return await vendoredLogin(creds, opts.fallbackCtor, {
        key: jarMasterKey(env, log),
        log,
      })
    }
  }

  log('zerodha login: LEGACY vendored path (DESK_LEGACY_ZERODHA_LOGIN)')
  return await vendoredLogin(creds, opts.ctor, { key: jarMasterKey(env, log), log })
}

// -------------------------------------------------------- credential source

/**
 * The read-only slice of `apps/api/src/BrokerStore` this needs.
 *
 * A structural port rather than an import of the class: it keeps this module
 * testable without Mongo and without `DESK_MASTER_KEY`, and it states exactly
 * how much of the store market data is allowed to touch — two reads, no writes.
 */
export interface BrokerCredentialSource {
  readSecret(
    kind: 'zerodha',
  ): Promise<
    | { readonly kind: 'absent' }
    | { readonly kind: 'ok'; readonly secret: Record<string, unknown> }
    | { readonly kind: 'unreadable'; readonly reason: string }
  >
  get(kind: 'zerodha'): Promise<{ readonly meta: Record<string, string | number | boolean> }>
}

export interface ResolvedCredentials {
  readonly credentials: ZerodhaCredentials
  readonly source: 'broker-store' | 'env'
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v
    if (typeof v === 'number') return String(v)
  }
  return ''
}

/**
 * Zerodha credentials, THE BROKER STORE FIRST and the environment second.
 *
 * Phase A §6: the Brokers page writes sealed credentials into `desk-brokers`,
 * and until now this process read only `ZERODHA_*` from the environment — so
 * an operator who rotated the password in the portal, watched the "test" button
 * go green, and restarted the feed, got a feed still logging in with whatever
 * was baked into `.env.local` at deploy time. The portal was a display that
 * changed nothing.
 *
 * The env stays as the FALLBACK rather than being removed, because the store
 * needs `DESK_MASTER_KEY` and a Mongo round trip, and a market-data process
 * that cannot boot without both is a market-data process that cannot boot
 * during a Mongo incident. Every fallback logs the reason it fell back, so
 * "the portal credentials are not being used" is never silent.
 *
 * The field names mirror `apps/api/src/routes/brokers.ts`'s `testZerodha`, so
 * the credentials the portal VERIFIED are byte-for-byte the ones used here.
 */
export async function resolveZerodhaCredentials(opts: {
  brokers?: BrokerCredentialSource | null
  env?: NodeJS.ProcessEnv
  log?: (msg: string, ctx?: Record<string, unknown>) => void
}): Promise<ResolvedCredentials> {
  const log = opts.log ?? ((): void => {})
  const env = opts.env ?? process.env
  let storeProblem = 'no broker store available (DESK_MASTER_KEY not set?)'

  if (opts.brokers != null) {
    try {
      const read = await opts.brokers.readSecret('zerodha')
      if (read.kind === 'ok') {
        const meta = (await opts.brokers.get('zerodha')).meta
        const user_id = firstString(read.secret['userId'], read.secret['user_id'], meta['userId'])
        const password = firstString(read.secret['password'])
        const authkey = firstString(
          read.secret['totpSecret'],
          read.secret['authkey'],
          read.secret['totp_secret'],
        )
        if (user_id !== '' && password !== '' && authkey !== '') {
          log('zerodha credentials read from the broker store', { userId: user_id })
          return { credentials: { user_id, password, authkey }, source: 'broker-store' }
        }
        storeProblem =
          'the stored zerodha credential is missing userId, password or totpSecret'
      } else if (read.kind === 'unreadable') {
        // NOT collapsed into "absent". A row that will not decrypt is a key
        // problem, and silently trading on the env instead would hide the one
        // fact the operator needs: the credentials they entered are unreachable.
        storeProblem = `the stored zerodha credential will not open: ${read.reason}`
      } else {
        storeProblem = 'no zerodha credentials are configured in the portal'
      }
    } catch (err) {
      storeProblem = `broker store read failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  try {
    const credentials = credentialsFromEnv(env)
    log('zerodha credentials read from the environment', { reason: storeProblem })
    return { credentials, source: 'env' }
  } catch (err) {
    throw new Error(
      `no usable Zerodha credentials: ${storeProblem}; and ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Extract the base32 TOTP secret from a Google Authenticator export URI
 * (`otpauth-migration://offline?data=...`).
 *
 * The payload is protobuf. Rather than pull in a schema, this walks the two
 * fields it needs — the wire format is stable and the alternative is asking a
 * human to re-export a QR code they no longer have.
 *
 * Returns every account in the export, so the caller picks by name rather than
 * assuming the export has exactly one.
 */
export function decodeMigrationUri(uri: string): { name: string; secretBase32: string }[] {
  const marker = 'data='
  const at = uri.indexOf(marker)
  if (at < 0) throw new Error('not an otpauth-migration URI: no data parameter')
  const b64 = decodeURIComponent(uri.slice(at + marker.length))
  const buf = Buffer.from(b64, 'base64')

  const out: { name: string; secretBase32: string }[] = []
  let i = 0
  while (i < buf.length) {
    const tag = buf[i] as number
    i++
    // Field 1, wire type 2 (length-delimited) == one OtpParameters message.
    if (tag !== 0x0a) break
    const [len, next] = readVarint(buf, i)
    i = next
    const msg = buf.subarray(i, i + len)
    i += len
    out.push(parseOtpParameters(msg))
  }
  return out
}

function parseOtpParameters(msg: Buffer): { name: string; secretBase32: string } {
  let i = 0
  // Uint8Array, not Buffer: `subarray` returns a Buffer parameterised over
  // ArrayBufferLike, which does not assign to Buffer<ArrayBuffer>. Buffer
  // extends Uint8Array, so widening here costs nothing.
  let secret: Uint8Array = new Uint8Array(0)
  let name = ''
  while (i < msg.length) {
    const tag = msg[i] as number
    i++
    const field = tag >> 3
    const wire = tag & 0x07
    if (wire === 2) {
      const [len, next] = readVarint(msg, i)
      i = next
      const value = msg.subarray(i, i + len)
      i += len
      if (field === 1) secret = value
      else if (field === 2) name = value.toString('utf8')
    } else if (wire === 0) {
      const [, next] = readVarint(msg, i)
      i = next
    } else {
      break // a wire type this format does not use; stop rather than guess
    }
  }
  return { name, secretBase32: base32Encode(secret) }
}

function readVarint(buf: Buffer, start: number): [number, number] {
  let result = 0
  let shift = 0
  let i = start
  for (;;) {
    const b = buf[i] as number
    i++
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return [result, i]
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, unpadded — the form `authenticator` expects. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
