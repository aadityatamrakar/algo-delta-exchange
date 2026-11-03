/**
 * Delta connection settings, from the broker store with env as the fallback.
 *
 * PRECEDENCE: sealed secret, then `meta`, then env. The store (`desk-brokers`
 * kind `delta`, typed into the Brokers page — never through chat) is the
 * operator's most recent deliberate act; env is what the machine was started
 * with. Only this process reads the key; the feed holds none.
 */
import { DX_DEMO_REST_URL, DX_DEMO_WS_URL, DX_PROD_REST_URL, DX_PROD_WS_URL, assertRailHost } from '@algomaker/dx'
import { BrokerStore, requireMasterKey, type BrokerKind } from '../../api/src/brokerstore.ts'

export const DX_DEFAULT_BASE_URL = DX_PROD_REST_URL
export const DX_DEFAULT_WS_URL = DX_PROD_WS_URL
/** Delta's CDN refuses a request without one (403). */
export const DX_USER_AGENT = 'algomaker-dx-gateway/1.0'

export interface DxConfig {
  readonly baseUrl: string
  readonly wsUrl: string
  readonly apiKey: string
  readonly apiSecret: string
  readonly source: 'broker-store' | 'env' | 'mixed'
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

/** The API key a broker-store card holds: the sealed secret's, else meta's; undefined when none. */
export function storedApiKey(card: { meta: Record<string, unknown>; secret: Record<string, unknown> }): string | undefined {
  return firstString(card.secret['apiKey'], card.meta['apiKey'])
}

/**
 * THE OTHER CARD'S KEY, for the cross-rail guard: the other `desk-brokers`
 * card read directly (never via whichever rail happens to be built — a
 * simulate box builds no live rail, so a live-key-only comparison compared
 * against nothing), plus the other rail's env key. A read that fails is
 * nothing to compare against, never a reason to stop the boot.
 */
async function otherKeys(
  otherCardKey: (() => Promise<string | undefined>) | undefined,
  envKey: string | undefined,
): Promise<readonly string[]> {
  let card: string | undefined
  try {
    card = otherCardKey === undefined ? undefined : firstString(await otherCardKey())
  } catch {
    card = undefined
  }
  return [card, firstString(envKey)].filter((k): k is string => k !== undefined)
}

export async function loadDxConfig(
  read: () => Promise<{ meta: Record<string, unknown>; secret: Record<string, unknown> }>,
  env: NodeJS.ProcessEnv,
  logFn: (m: string, c?: Record<string, unknown>) => void,
  /** The `delta-demo` card's stored key — a testnet key in the live card is refused. */
  opts: { readonly otherCardKey?: () => Promise<string | undefined> } = {},
): Promise<DxConfig> {
  const { meta, secret } = await read()
  const seen = { store: false, env: false }
  const pick = (key: string, envName: string): string | undefined => {
    const fromStore = firstString(secret[key], meta[key])
    if (fromStore !== undefined) {
      seen.store = true
      return fromStore
    }
    const fromEnv = firstString(env[envName])
    if (fromEnv !== undefined) seen.env = true
    return fromEnv
  }
  const apiKey = pick('apiKey', 'DX_API_KEY')
  const apiSecret = pick('apiSecret', 'DX_API_SECRET')
  const missing = [
    apiKey === undefined ? 'apiKey/DX_API_KEY' : null,
    apiSecret === undefined ? 'apiSecret/DX_API_SECRET' : null,
  ].filter((m): m is string => m !== null)
  if (missing.length > 0) {
    throw new Error(
      `Delta is not configured: ${missing.join(', ')} — set them on the Brokers page (kind delta) or in the environment`,
    )
  }
  const cfg: DxConfig = {
    baseUrl: (pick('baseUrl', 'DX_BASE_URL') ?? DX_DEFAULT_BASE_URL).replace(/\/$/, ''),
    wsUrl: pick('wsUrl', 'DX_WS_URL') ?? DX_DEFAULT_WS_URL,
    apiKey: apiKey as string,
    apiSecret: apiSecret as string,
    source: seen.store && seen.env ? 'mixed' : seen.store ? 'broker-store' : 'env',
  }
  // Production credentials never go to the testnet.
  assertRailHost('live', cfg.baseUrl)
  assertRailHost('live', cfg.wsUrl)
  if ((await otherKeys(opts.otherCardKey, env['DX_DEMO_API_KEY'])).includes(cfg.apiKey)) {
    throw new Error('Delta live carries the same API key as the demo (testnet) card — refusing to use a demo key on the live rail')
  }
  logFn('Delta config resolved', { source: cfg.source, baseUrl: cfg.baseUrl, wsUrl: cfg.wsUrl })
  return cfg
}

/**
 * THE DEMO (TESTNET) RAIL's settings: `desk-brokers` kind `delta-demo`, then
 * `DX_DEMO_*` env. Never the production `DX_*` names — a fallback onto them is
 * exactly how a real key would reach a host it was never issued for.
 *
 * Both hosts must be testnet (`assertRailHost('demo')`, an allowlist), and a
 * key equal to production's is refused: that key would be the real account.
 */
export async function loadDxDemoConfig(
  read: () => Promise<{ meta: Record<string, unknown>; secret: Record<string, unknown> }>,
  env: NodeJS.ProcessEnv,
  logFn: (m: string, c?: Record<string, unknown>) => void,
  opts: {
    readonly liveApiKey?: string
    /**
     * The `delta` card's stored key, read straight from the broker store
     * whatever `DESK_BROKER` says — `liveApiKey` is undefined on a box that
     * never built the live rail, which is exactly when a real key typed into
     * the demo card went unnoticed.
     */
    readonly otherCardKey?: () => Promise<string | undefined>
  } = {},
): Promise<DxConfig> {
  const { meta, secret } = await read()
  const seen = { store: false, env: false }
  const pick = (key: string, envName: string): string | undefined => {
    const fromStore = firstString(secret[key], meta[key])
    if (fromStore !== undefined) {
      seen.store = true
      return fromStore
    }
    const fromEnv = firstString(env[envName])
    if (fromEnv !== undefined) seen.env = true
    return fromEnv
  }
  const apiKey = pick('apiKey', 'DX_DEMO_API_KEY')
  const apiSecret = pick('apiSecret', 'DX_DEMO_API_SECRET')
  const missing = [
    apiKey === undefined ? 'apiKey/DX_DEMO_API_KEY' : null,
    apiSecret === undefined ? 'apiSecret/DX_DEMO_API_SECRET' : null,
  ].filter((m): m is string => m !== null)
  if (missing.length > 0) {
    throw new Error(
      `Delta demo is not configured: ${missing.join(', ')} — set them on the Brokers page (Delta Demo (testnet))`,
    )
  }
  const cfg: DxConfig = {
    baseUrl: (pick('baseUrl', 'DX_DEMO_BASE_URL') ?? DX_DEMO_REST_URL).replace(/\/$/, ''),
    wsUrl: pick('wsUrl', 'DX_DEMO_WS_URL') ?? DX_DEMO_WS_URL,
    apiKey: apiKey as string,
    apiSecret: apiSecret as string,
    source: seen.store && seen.env ? 'mixed' : seen.store ? 'broker-store' : 'env',
  }
  assertRailHost('demo', cfg.baseUrl)
  assertRailHost('demo', cfg.wsUrl)
  const real = [
    ...(opts.liveApiKey === undefined ? [] : [opts.liveApiKey]),
    ...(await otherKeys(opts.otherCardKey, env['DX_API_KEY'])),
  ]
  if (real.includes(cfg.apiKey)) {
    throw new Error('Delta demo carries the same API key as production — refusing to use a real key on the demo rail')
  }
  logFn('Delta demo config resolved', { source: cfg.source, baseUrl: cfg.baseUrl, wsUrl: cfg.wsUrl })
  return cfg
}

/**
 * Read the stored Delta credentials, or nothing at all.
 *
 * A missing/unusable `DESK_MASTER_KEY` is NOT fatal here: the gateway can still
 * run on env credentials, and refusing to boot the only process that can place
 * orders over a page nobody is using would be its own outage.
 */
export async function readDeltaBrokerStore(
  db: { collection: (name: string) => unknown },
  logFn: (m: string, c?: Record<string, unknown>) => void,
  kind: Extract<BrokerKind, 'delta' | 'delta-demo'> = 'delta',
): Promise<{ meta: Record<string, unknown>; secret: Record<string, unknown> }> {
  try {
    const store = new BrokerStore(db as never, requireMasterKey())
    const row = await store.get(kind)
    const read = await store.readSecret(kind)
    if (read.kind === 'unreadable') {
      logFn(`BROKER STORE: the stored ${kind} credential will not decrypt — falling back to env`, { reason: read.reason })
      return { meta: row.meta, secret: {} }
    }
    return { meta: row.meta, secret: read.kind === 'ok' ? read.secret : {} }
  } catch (err) {
    logFn('broker store unavailable — using environment credentials', { error: String(err) })
    return { meta: {}, secret: {} }
  }
}
