/**
 * Broker credentials — stored sealed, never returned.
 *
 * THE ONE INVARIANT: no response from this module contains a secret field, at
 * any status, ever. Not on the error paths, not in an echoed `meta`, not in a
 * broker's own error message. `BrokerStore` enforces it on both sides of the
 * database and `test/brokers.test.ts` asserts it over the full JSON of every
 * response this file can produce.
 *
 * `test` performs a REAL authenticated call (spec §5; for Delta a SIGNED wallet
 * read, spec §5.4). That is the whole point of it: "are my credentials right?"
 * is otherwise answerable only by restarting a process and reading its logs. A failed login is `200 {ok:false}`, not a 5xx — the request
 * succeeded and its body says exactly what the broker replied; a 5xx would tell
 * the dashboard that OUR service is broken when it is the credentials that are.
 */

import { DX_DEMO_REST_URL, DX_PROD_REST_URL, DxRest, assertRailHost, isDemoHost, isProdHost } from '@algomaker/dx'
import { zerodhaLogin } from '../../../marketdata/src/zerodha-login.ts'
import { BrokerStore, isBrokerKind, requireMasterKey, type BrokerKind } from '../brokerstore.ts'
import { auditLog } from '../audit.ts'
import { isObject, suffixOf, type ApiDeps, type Route, type RouteCtx } from './kit.ts'

const PREFIX = '/v1/desk/brokers'

export interface BrokerRouteOptions {
  /** The credential test's transport. Tests route it to a local stub. */
  readonly fetch?: typeof fetch
}

export function brokerRoutes(deps: ApiDeps, opts: BrokerRouteOptions = {}): Route {
  // Spec §7: fails at BOOT, not on the first request. `main.ts` calls this
  // factory before it listens, so a bad key stops the process instead of
  // producing an inexplicable broker error mid-session.
  const store = new BrokerStore(deps.db, requireMasterKey())
  void store.ensureIndexes().catch((err: unknown) => {
    deps.log('broker index creation failed', { error: err instanceof Error ? err.message : String(err) })
  })
  /**
   * WHO CHANGED THE CREDENTIALS (roadmap 17), and the module's one invariant
   * applied to the audit log as well as to the responses: NO SECRET VALUE GOES
   * IN, EVER. Every `detail` below is key names and booleans — never a value,
   * never the body, never `meta`. `audit.ts` redacts on the way in as a second
   * line, but the first line is here: nothing sensitive is handed over at all.
   */
  const audit = auditLog(deps)

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, send } = ctx

    if (path === PREFIX && method === 'GET') {
      send(200, { brokers: await store.list() })
      return true
    }

    const rest = suffixOf(path, `${PREFIX}/`)
    if (rest === null) return false
    const [kindRaw, action, ...extra] = rest.split('/')
    if (extra.length > 0) return false
    if (!isBrokerKind(kindRaw)) {
      send(404, { error: `unknown broker "${String(kindRaw)}" — known brokers are delta, delta-demo and zerodha` })
      return true
    }
    const kind: BrokerKind = kindRaw

    if (action === undefined && method === 'PUT') {
      const body = await ctx.readJson()
      if (!isObject(body)) {
        send(400, { error: 'body must be an object' })
        return true
      }
      const label = body['label']
      const meta = body['meta']
      const secret = body['secret']
      if (label !== undefined && typeof label !== 'string') {
        send(400, { error: 'label must be a string' })
        return true
      }
      if (meta !== undefined && !isObject(meta)) {
        send(400, { error: 'meta must be an object' })
        return true
      }
      if (secret !== undefined && !isObject(secret)) {
        send(400, { error: 'secret must be an object' })
        return true
      }
      /**
       * ONE CARD, ONE EXCHANGE (3 Nov). The demo key was saved into the `delta`
       * card with the testnet URL, and that save overwrote the real key. So a
       * Delta card's save is refused, whole, unless the host it will hold —
       * this body's `meta`, else what is stored — is its own exchange's:
       * production for `delta`, testnet for `delta-demo`. Nothing is written.
       */
      if (kind === 'delta' || kind === 'delta-demo') {
        const effective = meta !== undefined ? meta : (await store.get(kind)).meta
        const refused = deltaHostRefusal(kind, effective, isObject(secret) ? secret : {})
        if (refused !== null) {
          ctx.log('broker credentials REFUSED — wrong exchange for the card', { kind })
          send(400, { error: refused })
          return true
        }
      }
      await store.save(
        kind,
        {
          ...(label === undefined ? {} : { label }),
          ...(meta === undefined ? {} : { meta }),
          ...(secret === undefined ? {} : { secret }),
        },
        deps.now(),
      )
      // Never echoes what was stored. The response says which broker was
      // written and nothing else, so there is no path by which a PUT can hand a
      // credential back to a page that might log it.
      const secretChanged = isObject(secret) && Object.keys(secret).length > 0
      ctx.log('broker credentials saved', { kind, secretChanged })
      await audit.record({
        principal: ctx.principal,
        source: `${PREFIX}/:kind`,
        action: 'saved broker credentials',
        // WHICH FIELDS MOVED, never what they moved to. `secretChanged` is the
        // one that matters — a session that stops working at 09:16 is usually
        // one whose secret was rewritten at 09:15, and that is now answerable.
        detail: {
          kind,
          labelChanged: label !== undefined,
          metaChanged: meta !== undefined,
          secretChanged,
        },
      })
      send(200, { ok: true, kind })
      return true
    }

    if (action === 'test' && method === 'POST') {
      const read = await store.readSecret(kind)
      if (read.kind === 'absent') {
        send(200, { ok: false, error: `no ${kind} credentials configured` })
        return true
      }
      if (read.kind === 'unreadable') {
        // Not a login failure and not a 5xx: the row exists, we simply cannot
        // open it. Re-entering credentials IS the fix here, which is why the
        // reason is stated rather than reported as a broker rejection.
        send(200, { ok: false, error: read.reason })
        return true
      }

      const row = await store.get(kind)
      const result =
        kind === 'delta'
          ? await testDelta(read.secret, row.meta, 'live', opts.fetch)
          : kind === 'delta-demo'
            ? await testDelta(read.secret, row.meta, 'demo', opts.fetch)
            : await testZerodha(read.secret, row.meta)

      // Recording the verdict is OUR job; failing to record it is our bug and a
      // 5xx. Failing to log in is the broker's answer and a 200.
      await store.recordTest(kind, result.ok ? { ok: true } : { ok: false, error: result.error }, deps.now())
      ctx.log('broker credential test', { kind, ok: result.ok })
      await audit.record({
        principal: ctx.principal,
        source: `${PREFIX}/:kind/test`,
        action: 'tested broker credentials',
        // A REAL authenticated call happens on this path (spec §5), so it
        // belongs in the record even though it changes nothing. The error is
        // the ALREADY-REDACTED text (`redact` below), never the raw reply.
        detail: { kind, ok: result.ok, ...(result.ok ? {} : { error: result.error }) },
      })
      if (result.ok) {
        send(200, { ok: true, verifiedAt: deps.now(), ...(result.note === undefined ? {} : { note: result.note }) })
      } else {
        send(200, { ok: false, error: result.error })
      }
      return true
    }

    return false
  }
}

/**
 * Why a Delta card may not hold these hosts, or null. A blank `baseUrl` is
 * allowed (production's Test reports it missing; demo defaults to testnet).
 */
function deltaHostRefusal(
  kind: 'delta' | 'delta-demo',
  meta: Record<string, unknown>,
  secret: Record<string, unknown>,
): string | null {
  const urls = [str(meta['baseUrl'], secret['baseUrl']), str(meta['wsUrl'], secret['wsUrl'])].filter((u) => u !== '')
  for (const url of urls) {
    try {
      assertRailHost(kind === 'delta' ? 'live' : 'demo', url)
    } catch {
      return kind === 'delta'
        ? `Not saved: the Delta Exchange India card only takes ${DX_PROD_REST_URL}. '${url}' is not the ` +
            'production host' +
            (isDemoHost(url) ? ' — it is the testnet; a demo key belongs on the Delta Demo (testnet) card.' : '.')
        : `Not saved: the Delta Demo (testnet) card only takes a testnet host (${DX_DEMO_REST_URL}). ` +
            `'${url}' is not the testnet` +
            (isProdHost(url) ? ' — it is production; the real key belongs on the Delta Exchange India card.' : '.')
    }
  }
  return null
}

type TestResult = { ok: true; note?: string } | { ok: false; error: string }

function str(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v
    if (typeof v === 'number') return String(v)
  }
  return ''
}

/**
 * A SIGNED wallet read on Delta Exchange India, over `@algomaker/dx`'s `DxRest`
 * — the same client the order gateway trades through. Read-only: it can place
 * nothing, and unlike a session login it invalidates nothing.
 *
 * `baseUrl` comes from `meta` first and from the sealed blob second. For the
 * real account it is REQUIRED rather than defaulted to the India host, so a
 * misfiled row (or a test) never reaches Delta by accident; the Brokers form
 * fills it in. For `delta-demo` it defaults to the testnet — the one host
 * those credentials may go to.
 *
 * THE HOST IS CHECKED AGAINST THE RAIL before anything is signed: demo
 * credentials only to testnet, production credentials never to testnet.
 */
async function testDelta(
  secret: Record<string, unknown>,
  meta: Record<string, string | number | boolean>,
  rail: 'live' | 'demo',
  fetchImpl: typeof fetch | undefined,
): Promise<TestResult> {
  const stored = str(meta['baseUrl'], secret['baseUrl'])
  const baseUrl = stored === '' && rail === 'demo' ? DX_DEMO_REST_URL : stored
  const apiKey = str(secret['apiKey'])
  const apiSecret = str(secret['apiSecret'])
  if (baseUrl === '') {
    return { ok: false, error: 'meta.baseUrl is required to reach Delta (https://api.india.delta.exchange)' }
  }
  if (apiKey === '' || apiSecret === '') return { ok: false, error: 'secret.apiKey and secret.apiSecret are required' }
  try {
    assertRailHost(rail, baseUrl)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const where = rail === 'demo' ? ' (testnet)' : ''
  const rest = new DxRest({
    baseUrl,
    apiKey,
    apiSecret,
    userAgent: 'algomaker-dx-api/1.0',
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    // An operator is watching this one; a venue that has not answered in 10
    // seconds is the answer.
    timeoutMs: 10_000,
  })
  try {
    const balances = await rest.walletBalances()
    const seen = balances
      .map((b) => {
        const r = b as unknown as Record<string, unknown>
        return `${str(r['asset_symbol'])} ${str(r['balance'])}`.trim()
      })
      .filter((x) => x !== '')
    return {
      ok: true,
      note:
        seen.length === 0
          ? `signed wallet read ok${where} (no balances reported)`
          : `signed wallet read ok${where} — ${seen.join(', ')}`,
    }
  } catch (err) {
    return { ok: false, error: redact(err instanceof Error ? err.message : String(err), secret) }
  }
}

/**
 * A real Zerodha login: user id, password and TOTP straight through to the
 * enctoken, with NO browser step — `apps/marketdata/src/zerodha-login.ts` is the
 * same path the market-data feed authenticates with every morning.
 *
 * ONE HONEST CAVEAT, stated in the response rather than hidden. The underlying
 * `login()` reuses a LIVE session from the shared cookie jar when there is one,
 * and only performs the password+TOTP dance when there is not. That is the
 * behaviour we want — a test must not invalidate the session the feed is
 * holding — but it means a success sometimes proves "this account has a working
 * session" rather than "this password is correct". Saying so in `note` is
 * better than reporting a login we did not observe.
 *
 * It is read-only by construction (spec D1): the module never touches an order
 * endpoint, so testing these credentials cannot place anything.
 */
async function testZerodha(
  secret: Record<string, unknown>,
  meta: Record<string, string | number | boolean>,
): Promise<TestResult> {
  const user_id = str(secret['userId'], secret['user_id'], meta['userId'])
  const password = str(secret['password'])
  const authkey = str(secret['totpSecret'], secret['authkey'], secret['totp_secret'])
  if (user_id === '' || password === '' || authkey === '') {
    return {
      ok: false,
      error: 'secret.password and secret.totpSecret are required, with the user id in meta.userId or secret.userId',
    }
  }
  try {
    await zerodhaLogin({ user_id, password, authkey })
    return {
      ok: true,
      note:
        `Kite session verified for ${user_id}. A live session is reused when one exists, ` +
        'so this confirms the account is reachable; the password and TOTP are re-proved only ' +
        'when the session has lapsed.',
    }
  } catch (err) {
    return { ok: false, error: redact(err instanceof Error ? err.message : String(err), secret) }
  }
}

/**
 * Strip any stored credential value out of a broker's error text before it
 * becomes a response.
 *
 * Brokers do echo what you sent them — some return the request body in their
 * error descriptions, and the legacy Zerodha module puts the payload in its
 * message. Forwarding that verbatim would break the module's one invariant
 * through the one field nobody thinks of as ours.
 */
/**
 * Strip every stored credential value out of a broker's own error text.
 *
 * WALKS THE WHOLE BLOB. The previous version did `Object.values(secret)` and
 * skipped anything that was not a string of 4+ characters — but the blob is
 * free-form JSON with no shape check, so a nested `{legacy:{password:"..."}}`
 * or a numeric PIN passed straight through. That mattered because brokers echo
 * the request payload in some error descriptions, and the unredacted text goes
 * to TWO places: the response body, and `lastError`, which `GET /v1/desk/brokers`
 * then returns on every poll, forever.
 *
 * Numbers are stringified before matching — a 6-digit PIN is exactly the kind
 * of short value the old length guard waved through.
 */
function redact(text: string, secret: Record<string, unknown>): string {
  let out = text
  const seen = new Set<unknown>()
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return
    if (typeof value === 'object') {
      // Cycles are possible in a hand-repaired document; a redactor that hangs
      // is a redactor that never runs.
      if (seen.has(value)) return
      seen.add(value)
      for (const v of Object.values(value as Record<string, unknown>)) walk(v)
      return
    }
    const s = String(value)
    // 3 rather than 4: a short PIN is still a secret. Below that the risk is
    // mangling unrelated text, which is worse than useless output.
    if (s.length < 3) return
    out = out.split(s).join('***')
  }
  walk(secret)
  return out
}
