/**
 * Delta connection settings, from the broker store with env as the fallback.
 *
 * PRECEDENCE: sealed secret, then `meta`, then env. The store (`desk-brokers`
 * kind `delta`, typed into the Brokers page — never through chat) is the
 * operator's most recent deliberate act; env is what the machine was started
 * with. Only this process reads the key; the feed holds none.
 */
import { BrokerStore, requireMasterKey } from '../../api/src/brokerstore.ts'

export const DX_DEFAULT_BASE_URL = 'https://api.india.delta.exchange'
export const DX_DEFAULT_WS_URL = 'wss://socket.india.delta.exchange'
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

export async function loadDxConfig(
  read: () => Promise<{ meta: Record<string, unknown>; secret: Record<string, unknown> }>,
  env: NodeJS.ProcessEnv,
  logFn: (m: string, c?: Record<string, unknown>) => void,
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
  logFn('Delta config resolved', { source: cfg.source, baseUrl: cfg.baseUrl, wsUrl: cfg.wsUrl })
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
): Promise<{ meta: Record<string, unknown>; secret: Record<string, unknown> }> {
  try {
    const store = new BrokerStore(db as never, requireMasterKey())
    const row = await store.get('delta')
    const read = await store.readSecret('delta')
    if (read.kind === 'unreadable') {
      logFn('BROKER STORE: the stored Delta credential will not decrypt — falling back to env', { reason: read.reason })
      return { meta: row.meta, secret: {} }
    }
    return { meta: row.meta, secret: read.kind === 'ok' ? read.secret : {} }
  } catch (err) {
    logFn('broker store unavailable — using environment credentials', { error: String(err) })
    return { meta: {}, secret: {} }
  }
}
