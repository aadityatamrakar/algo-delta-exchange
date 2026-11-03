/**
 * Market data host on Delta Exchange India (`DESK_VENUE=dx`).
 *
 * `main.ts` hands over to `mainDx` before it reads a single Kite setting, so
 * on this venue there is no Zerodha login, no Kite socket, no enctoken canary
 * and no Kite-backed HTTP endpoint (history, margin basket) — none of it is
 * imported from here. What is left is the NSE host's contract on the bus:
 *
 *   md.tick, md.spot   `dx-feed.ts`, every BTC option of every listed expiry
 *   md.health          every 10 s, the NSE field set (`dxHealthPayload`)
 *   instrument         `dx-sync.ts`, at boot, every 15 min, after 12:00 UTC
 *   dx-settlements     `dx-sync.ts`, Delta's published settlement prices
 *   desk-marks         the display snapshot, every 60 s, as on NSE
 *
 * Delta trades 24x7, so `session` on `md.health` is always true and the stale
 * counts always mean something.
 */

import { connectWithRetry, installCrashGuards } from '@algomaker/core'
import { WsTransportServer } from '@algomaker/bus'
import { DxPublicSocket, DxRest, toInstrumentRows } from '@algomaker/dx'
import { DX } from '@algomaker/venue'
import { connectMongo } from '../../api/src/mongo.ts'
import { DeskStore } from '../../api/src/store.ts'
import { loadStoredInstruments } from './sync-runner.ts'
import { ensureMarksIndex, MARKS_COLLECTION, pruneOrphanMarks } from './marks-store.ts'
import { DxFeed, DX_UNDERLYING, type DxFeedHealth } from './dx-feed.ts'
import { DX_SETTLEMENTS_COLLECTION, DX_SYNC_EVERY_MS, dxSyncDue, runDxSync, type DxCollection } from './dx-sync.ts'
import type { DxNormaliser, DxPublicSocketFactory, DxRestPort } from './dx-ports.ts'
import type { InstrumentRow } from '@algomaker/instruments'

export const DX_REST_URL = 'https://api.india.delta.exchange'
export const DX_PUBLIC_WS_URL = 'wss://public-socket.india.delta.exchange'
export const DEFAULT_DX_STALE_MS = 180_000

function log(msg: string, ctx?: Record<string, unknown>): void {
  console.log(`[marketdata:dx] ${new Date().toISOString()} ${msg}${ctx === undefined ? '' : ' ' + JSON.stringify(ctx)}`)
}

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`)
  return v
}

function positiveMs(name: string, dflt: number): number {
  const raw = process.env[name]
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** The options the feed carries and the spot token, from stored rows. */
export function feedInstruments(rows: readonly InstrumentRow[]): {
  options: { token: number; symbol: string }[]
  spotToken: number | null
} {
  const options = rows
    .filter((r) => (r.instrument_type === 'CE' || r.instrument_type === 'PE') && r.name === DX_UNDERLYING)
    .map((r) => ({ token: r.instrument_token, symbol: r.tradingsymbol }))
  const spot = rows.find((r) => r.expiry === '' && r.name === DX_UNDERLYING && r.instrument_type !== 'CE' && r.instrument_type !== 'PE')
  return { options, spotToken: spot?.instrument_token ?? null }
}

/**
 * `md.health` on Delta: the NSE payload's field set, so the api, the traders
 * app and the Status card read it unchanged. The Kite-only fields are present
 * and null (`freezeSyncDay`, `bseFreezeSyncDay`, `enctokenLastVerifiedAt`):
 * there is no freeze table and no enctoken on this venue.
 *
 * `instrumentsStale` is "no successful sync in two cadences" rather than "not
 * today": the master is refreshed every 15 minutes here.
 */
export function dxHealthPayload(a: {
  feed: DxFeedHealth
  nowMs: number
  lastSyncMs: number
  staleAfterMs: number
}): Record<string, unknown> {
  const { feed, nowMs } = a
  return {
    sockets: [{ socket: 0, connected: feed.connected, tokens: feed.tokens, downForMs: feed.downForMs }],
    tokens: feed.tokens,
    ts: nowMs,
    date: DX.dayKey(nowMs),
    staleTokens: feed.staleTokens,
    oldestAgeMs: feed.oldestAgeMs,
    freezeStaleMs: a.staleAfterMs,
    session: true,
    instrumentSyncDay: a.lastSyncMs > 0 ? DX.dayKey(a.lastSyncMs) : null,
    instrumentsStale: a.lastSyncMs <= 0 || nowMs - a.lastSyncMs > 2 * DX_SYNC_EVERY_MS,
    freezeSyncDay: null,
    bseFreezeSyncDay: null,
    enctokenLastVerifiedAt: null,
  }
}

/** The Delta clients, injectable for a boot test; the real ones by default. */
export interface DxClients {
  readonly rest: DxRestPort
  readonly socket: DxPublicSocketFactory
  readonly normalise: DxNormaliser
}

export function realDxClients(env: NodeJS.ProcessEnv = process.env): DxClients {
  const userAgent = env['DESK_DX_USER_AGENT'] ?? 'algomaker-dx-desk/1.0'
  return {
    rest: new DxRest({ baseUrl: env['DESK_DX_REST_URL'] ?? DX_REST_URL, userAgent }),
    socket: (url, opts) => new DxPublicSocket(url, opts),
    normalise: toInstrumentRows,
  }
}

export async function mainDx(clients: DxClients = realDxClients()): Promise<void> {
  installCrashGuards({ process, log })

  const mongoUrl = required('DESK_MONGO_URL')
  const busPort = Number(process.env['DESK_BUS_PORT'] ?? 8891)
  const wsUrl = process.env['DESK_DX_WS_URL'] ?? DX_PUBLIC_WS_URL
  const staleAfterMs = positiveMs('DESK_FREEZE_STALE_MS', DEFAULT_DX_STALE_MS)

  // Retry, never exit, and stay stoppable while waiting — see `main.ts`.
  const bailOut = (signal: string): void => {
    log(`${signal} received while still booting — exiting`)
    process.exit(0)
  }
  const bailTerm = (): void => bailOut('SIGTERM')
  const bailInt = (): void => bailOut('SIGINT')
  process.on('SIGTERM', bailTerm)
  process.on('SIGINT', bailInt)
  const mongo = await connectWithRetry(() => connectMongo(mongoUrl), {
    log,
    what: 'Mongo',
    ...(process.env['DESK_BOOT_MAX_ATTEMPTS'] === undefined
      ? {}
      : { maxAttempts: Number(process.env['DESK_BOOT_MAX_ATTEMPTS']) }),
  })
  process.off('SIGTERM', bailTerm)
  process.off('SIGINT', bailInt)

  const store = new DeskStore(mongo.db)
  const instrumentCol = mongo.db.collection('instrument') as unknown as DxCollection
  const settlementCol = mongo.db.collection(DX_SETTLEMENTS_COLLECTION) as unknown as DxCollection
  const marksCol = mongo.db.collection(MARKS_COLLECTION)

  const bus = new WsTransportServer({ port: busPort })
  await bus.ready()
  log(`bus listening on :${busPort}`)

  const feed = new DxFeed({
    url: wsUrl,
    socket: clients.socket,
    publish: (topic, payload, ts) => bus.publish(topic, payload, ts),
    staleAfterMs,
    log,
  })

  const applyRows = (rows: readonly InstrumentRow[]): void => {
    const { options, spotToken } = feedInstruments(rows)
    feed.setInstruments(options, spotToken)
    log('instrument master loaded', { options: options.length, spot: spotToken })
  }

  let lastSyncMs = 0
  let syncing = false
  const sync = async (): Promise<void> => {
    if (syncing) return
    syncing = true
    try {
      await runDxSync({
        rest: clients.rest,
        normalise: clients.normalise,
        instruments: instrumentCol,
        settlements: settlementCol,
        loadStored: () => loadStoredInstruments(instrumentCol),
        bookTokens: async () => {
          const tokens = new Set<number>()
          for (const mode of ['paper', 'live'] as const) {
            for (const b of await store.allBooks(mode)) {
              for (const l of b.legs) {
                if (l.instrument.instrumentToken !== undefined) tokens.add(l.instrument.instrumentToken)
              }
            }
          }
          return tokens
        },
        registryChains: async () => [...(await store.listBooks('paper')), ...(await store.listBooks('live'))],
        log,
      })
      lastSyncMs = Date.now()
      const stored = await loadStoredInstruments(instrumentCol)
      applyRows(stored)
      await pruneOrphanMarks({
        marks: marksCol,
        masterTokens: stored.map((r) => r.instrument_token),
        nowMs: Date.now(),
        log,
      })
    } catch (err) {
      // A failed sync degrades to the STORED master, never an empty one.
      log('dx instrument sync FAILED, continuing on the stored master', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      syncing = false
    }
  }

  // Stored rows first, so the feed is subscribing while the first sync runs.
  applyRows(await loadStoredInstruments(instrumentCol))
  feed.start()
  await sync()

  const syncTimer = setInterval(() => {
    if (dxSyncDue(Date.now(), lastSyncMs)) void sync()
  }, 30_000)
  syncTimer.unref()

  // Display snapshot — the NSE loop's rule: a book this process has none of is
  // preserved, never overwritten with null. See `main.ts`.
  void ensureMarksIndex(marksCol, log)
  const snapshotTimer = setInterval(() => {
    void (async () => {
      if (feed.lastPrice.size === 0) return
      try {
        for (const [token, e] of feed.lastPrice) {
          await marksCol.updateOne(
            { token },
            {
              $set: {
                token,
                price: e.price,
                ts: e.ts,
                ...(e.book === null ? {} : { bid: e.book.bid, ask: e.book.ask, bookTs: e.book.ts }),
              },
            },
            { upsert: true },
          )
        }
      } catch (err) {
        log('mark snapshot failed', { error: String(err) })
      }
    })()
  }, Number(process.env['DESK_SNAPSHOT_MS'] ?? 60_000))
  snapshotTimer.unref()

  const healthTimer = setInterval(() => {
    const nowMs = Date.now()
    bus.publish('md.health', dxHealthPayload({ feed: feed.health(), nowMs, lastSyncMs, staleAfterMs }), nowMs)
  }, 10_000)
  healthTimer.unref()

  log('marketdata up (dx)', { tokens: feed.tokenCount })

  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`)
    feed.close()
    void bus.close().then(() => mongo.close()).then(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
