/**
 * dx-watchdog — the process that watches the desk from OUTSIDE it.
 *
 * Every 10 s (`DX_WATCHDOG_MS`): read desk health (`health.ts`), read each
 * configured Delta account straight from Delta with this process's own REST
 * client, decide (`watchdog.ts`), and forward new `desk-alerts` (`forward.ts`).
 *
 * ITS OWN CLIENTS, from the same broker-store keys the gateway uses
 * (`desk-brokers` kinds `delta` and `delta-demo`, the gateway's loaders, so
 * the same host allowlists apply: a production key only ever goes to
 * production, a testnet key only to testnet, and a demo key equal to the live
 * one is refused). Built lazily and retried every minute while unconfigured.
 *
 *   live rail   DX_WATCHDOG_LIVE=1 / 0; default on exactly when the gateway's
 *               live rail is (DESK_DX_LIVE=1 and DESK_BROKER=delta)
 *   demo rail   DX_WATCHDOG_DEMO=0 turns it off; default on
 *
 * It writes only `desk-alerts` (its alerts, and `forwardedAt` stamps) and its
 * own heartbeat row `desk-watchdog-heartbeat`. It places no order; the only
 * Delta writes it can make are cancel-all (non-stop) and close_all.
 */
import { installCrashGuards, connectWithRetry } from '@algomaker/core'
import { DxRest } from '@algomaker/dx'
import { connectMongo } from '../../api/src/mongo.ts'
import { DX_USER_AGENT, loadDxConfig, loadDxDemoConfig, readDeltaBrokerStore } from '../../order-gateway/src/dx-config.ts'
import { readDeskHealth } from './health.ts'
import { createAlertForwarder, createWatchdogAlertSink, DESK_ALERTS_COLLECTION, telegramConfigFromEnv, type AlertsCollection } from './forward.ts'
import { createWatchdog, watchdogConfigFromEnv, type WatchdogRest } from './watchdog.ts'

export const DX_WATCHDOG_MS = 10_000
export const WATCHDOG_HEARTBEAT_COLLECTION = 'desk-watchdog-heartbeat'
const RAIL_RETRY_MS = 60_000

function log(msg: string, ctx?: Record<string, unknown>): void {
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`
  console.log(`[watchdog] ${line}`)
}

type Env = Readonly<Record<string, string | undefined>>

export function liveRailWatched(env: Env): boolean {
  const v = env['DX_WATCHDOG_LIVE']
  if (v === '1') return true
  if (v === '0') return false
  return env['DESK_DX_LIVE'] === '1' && env['DESK_BROKER'] === 'delta'
}

/** A lazily built client: null while not configured, re-tried at most every minute. */
function lazyRest(build: () => Promise<WatchdogRest>, what: string): () => Promise<WatchdogRest | null> {
  let rest: WatchdogRest | null = null
  let failedAt = 0
  let said = ''
  return async () => {
    if (rest !== null) return rest
    if (failedAt !== 0 && Date.now() - failedAt < RAIL_RETRY_MS) return null
    try {
      rest = await build()
      log(`${what} client ready`)
      return rest
    } catch (err) {
      failedAt = Date.now()
      const why = err instanceof Error ? err.message : String(err)
      if (why !== said) log(`${what} not watched: ${why}`)
      said = why
      return null
    }
  }
}

export async function main(): Promise<void> {
  installCrashGuards({ process, log })
  const env = process.env
  const mongoUrl = env['DESK_MONGO_URL']
  if (mongoUrl === undefined || mongoUrl.trim() === '') throw new Error('DESK_MONGO_URL is required')
  const config = watchdogConfigFromEnv(env)
  const mongo = await connectWithRetry(() => connectMongo(mongoUrl), { log, what: 'Mongo' })
  const db = mongo.db as unknown as { collection(name: string): unknown }
  const alerts = db.collection(DESK_ALERTS_COLLECTION) as AlertsCollection

  let liveKey: string | undefined
  const rails: { rail: 'live' | 'demo'; rest: () => Promise<WatchdogRest | null> }[] = []
  if (liveRailWatched(env)) {
    rails.push({
      rail: 'live',
      rest: lazyRest(async () => {
        const cfg = await loadDxConfig(() => readDeltaBrokerStore(db, log, 'delta'), env, log)
        liveKey = cfg.apiKey
        return new DxRest({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, userAgent: `${DX_USER_AGENT} watchdog` })
      }, 'LIVE'),
    })
  } else {
    log('LIVE account not watched (DX_WATCHDOG_LIVE, or the live rail is off)')
  }
  if (env['DX_WATCHDOG_DEMO'] !== '0') {
    rails.push({
      rail: 'demo',
      rest: lazyRest(async () => {
        const cfg = await loadDxDemoConfig(() => readDeltaBrokerStore(db, log, 'delta-demo'), env, log, liveKey === undefined ? {} : { liveApiKey: liveKey })
        return new DxRest({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, userAgent: `${DX_USER_AGENT} watchdog` })
      }, 'DEMO'),
    })
  }

  const wd = createWatchdog({
    readHealth: () =>
      readDeskHealth({
        db,
        fetch,
        apiUrl: env['DESK_API_URL'] ?? 'http://127.0.0.1:8890',
        token: env['DESK_API_TOKEN'] ?? '',
        now: () => Date.now(),
        ...(env['DX_WATCHDOG_GATEWAY_STALE_S'] === undefined ? {} : { gatewayStaleMs: Number(env['DX_WATCHDOG_GATEWAY_STALE_S']) * 1000 }),
      }),
    rails,
    alert: createWatchdogAlertSink({ collection: alerts, now: () => Date.now(), log }),
    log,
    now: () => Date.now(),
    config,
  })
  const telegram = telegramConfigFromEnv(env)
  const forwarder = createAlertForwarder({ collection: alerts, telegram, fetch, log, now: () => Date.now() })
  log('started', {
    everyMs: DX_WATCHDOG_MS,
    rails: rails.map((r) => r.rail),
    alertAfterS: config.alertAfterMs / 1000,
    cancelAfterS: config.cancelAfterMs / 1000,
    flattenAfterS: config.flattenAfterMs / 1000,
    flattenDemo: config.flattenDemo,
    checkBackstops: config.checkBackstops,
    telegram: telegram !== null,
  })

  const beat = db.collection(WATCHDOG_HEARTBEAT_COLLECTION) as { updateOne(f: object, u: object, o: object): Promise<unknown> }
  let running = false
  const pass = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const r = await wd.tick()
      await forwarder.run()
      await beat
        .updateOne(
          { _id: 'watchdog' },
          { $set: { at: Date.now(), pid: process.pid, unhealthy: r.unhealthy.map((h) => h.component), downForMs: r.downForMs, rails: r.rails } },
          { upsert: true },
        )
        .catch((err: unknown) => log('heartbeat write failed', { error: String(err) }))
    } finally {
      running = false
    }
  }
  void pass()
  setInterval(() => void pass(), DX_WATCHDOG_MS)
  const stop = (): void => {
    log('stopping')
    void mongo.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
