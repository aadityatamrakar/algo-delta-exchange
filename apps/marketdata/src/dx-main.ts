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
 *   md.tick.demo       the testnet feed: demo-rail books' contracts only, at
 *                      the prices Delta marks the demo account with
 *
 * Delta trades 24x7, so `session` on `md.health` is always true and the stale
 * counts always mean something.
 */

import { connectWithRetry, installCrashGuards } from '@algomaker/core'
import { WsTransportServer } from '@algomaker/bus'
import { DX_DEMO_REST_URL, DxPublicSocket, DxRest, toInstrumentRows, type DxTicker } from '@algomaker/dx'
import { DxGapFill } from './dx-gap-fill.ts'
import { DX } from '@algomaker/venue'
import { connectMongo } from '../../api/src/mongo.ts'
import { DeskStore } from '../../api/src/store.ts'
import { loadStoredInstruments } from './sync-runner.ts'
import { ensureMarksIndex, MARKS_COLLECTION, pruneOrphanMarks } from './marks-store.ts'
import { DxFeed, DX_UNDERLYING, type DxFeedHealth } from './dx-feed.ts'
import { DX_SETTLEMENTS_COLLECTION, DX_SYNC_EVERY_MS, dxSyncDue, runDxSync, type DxCollection } from './dx-sync.ts'
import type { DxNormaliser, DxPublicSocketFactory, DxRestPort } from './dx-ports.ts'
import { DEMO_TICK_TOPIC, marksVenueOf } from '../../api/src/books-registry.ts'
import type { InstrumentRow } from '@algomaker/instruments'

export const DX_REST_URL = 'https://api.india.delta.exchange'
export const DX_PUBLIC_WS_URL = 'wss://public-socket.india.delta.exchange'
/** Delta India TESTNET public socket — the prices the demo account is marked at. */
export const DX_DEMO_WS_URL = 'wss://socket-ind-pub.testnet.deltaex.org'
/** How often the demo set (demo-rail books' chains and legs) is re-read. */
export const DX_DEMO_REFRESH_MS = 30_000
/** How often the gap fill re-reads which contracts the books hold. */
export const GAP_FILL_HELD_REFRESH_MS = 10_000

/** The REST tickers the gap fill reads. `DxRest` satisfies this. */
export interface DxTickerPort {
  ticker(symbol: string): Promise<DxTicker>
  tickers(q: { contractTypes?: string[]; underlying?: string[] }): Promise<readonly DxTicker[]>
}
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
 * WHAT THE TESTNET FEED CARRIES: only what demo-marked books need.
 *
 * Every option of the chain a demo-marked registry row names (a book about to
 * enter there), plus every leg a demo-marked book holds — a held leg even when
 * it has left the master (expired and settling), keyed by the token the book
 * stored. Demo-marked is `marksVenueOf`: a paper book on the demo rail, by the
 * rail the gateway used, else its setting. Sim-rail and live books add
 * nothing: their marks are production's.
 *
 * Tokens are the DESK's (production product ids); the socket subscribes by
 * symbol, and testnet's own product ids are never used.
 */
export function demoInstruments(input: {
  readonly rows: readonly InstrumentRow[]
  readonly registry: readonly (Parameters<typeof marksVenueOf>[0] & { tag: string; symbol: string; expiry: string })[]
  readonly books: readonly {
    readonly tag: string
    readonly mode: string
    readonly legs: readonly { readonly instrument: { readonly tradingsymbol: string; readonly instrumentToken?: number | undefined } }[]
  }[]
}): { token: number; symbol: string }[] {
  const demo = input.registry.filter((r) => marksVenueOf(r) === 'demo')
  const chains = new Set(demo.filter((r) => r.expiry !== '').map((r) => `${r.symbol}|${r.expiry}`))
  const demoTags = new Set(demo.map((r) => `${r.tag}|${r.mode}`))
  const out = new Map<string, number>()
  for (const r of input.rows) {
    if ((r.instrument_type === 'CE' || r.instrument_type === 'PE') && chains.has(`${r.name}|${r.expiry}`)) {
      out.set(r.tradingsymbol, r.instrument_token)
    }
  }
  for (const b of input.books) {
    if (!demoTags.has(`${b.tag}|${b.mode}`)) continue
    for (const l of b.legs) {
      const t = l.instrument.instrumentToken
      if (t !== undefined && !out.has(l.instrument.tradingsymbol)) out.set(l.instrument.tradingsymbol, t)
    }
  }
  return [...out].map(([symbol, token]) => ({ token, symbol }))
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
  /** The testnet price socket, when this process runs one. Its own line, never folded into the prod figures. */
  demo?: { url: string; health: DxFeedHealth }
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
    ...(a.demo === undefined ? {} : { demo: { url: a.demo.url, ...a.demo.health } }),
  }
}

/** The Delta clients, injectable for a boot test; the real ones by default. */
export interface DxClients {
  readonly rest: DxRestPort
  readonly socket: DxPublicSocketFactory
  readonly normalise: DxNormaliser
  /**
   * REST tickers for the gap fill (`dx-gap-fill.ts`): production's for the
   * production feed, the testnet's for the demo feed. Absent → no gap fill on
   * that feed (the boot test's fakes).
   */
  readonly tickers?: DxTickerPort
  readonly demoTickers?: DxTickerPort
}

export function realDxClients(env: NodeJS.ProcessEnv = process.env): DxClients {
  const userAgent = env['DESK_DX_USER_AGENT'] ?? 'algomaker-dx-desk/1.0'
  const rest = new DxRest({ baseUrl: env['DESK_DX_REST_URL'] ?? DX_REST_URL, userAgent })
  return {
    rest,
    socket: (url, opts) => new DxPublicSocket(url, opts),
    normalise: toInstrumentRows,
    tickers: rest,
    demoTickers: new DxRest({ baseUrl: env['DESK_DX_DEMO_REST_URL'] ?? DX_DEMO_REST_URL, userAgent }),
  }
}

/**
 * Every contract a book holds (non-zero qty), paper and live — what the gap
 * fill keeps fresh. Each feed fills only the ones it carries.
 */
export function heldSymbols(
  books: readonly { readonly legs: readonly { readonly qty: number; readonly instrument: { readonly tradingsymbol: string } }[] }[],
): string[] {
  const out = new Set<string>()
  for (const b of books) for (const l of b.legs) if (l.qty !== 0 && l.instrument.tradingsymbol !== '') out.add(l.instrument.tradingsymbol)
  return [...out].sort()
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

  /**
   * THE TESTNET FEED (demo-rail books). Same parsing, its own socket, its own
   * topic (`md.tick.demo`), no index, and NOT in the `desk-marks` snapshot —
   * that collection is production's display marks. `DESK_DX_DEMO_WS_URL=off`
   * runs without it.
   */
  const demoUrl = process.env['DESK_DX_DEMO_WS_URL'] ?? DX_DEMO_WS_URL
  const demoFeed =
    demoUrl === 'off'
      ? null
      : new DxFeed({
          url: demoUrl,
          socket: clients.socket,
          publish: (topic, payload, ts) => bus.publish(topic, payload, ts),
          staleAfterMs,
          log: (msg, ctx) => log(`demo: ${msg}`, ctx),
          tickTopic: DEMO_TICK_TOPIC,
          spot: false,
        })
  let masterRows: readonly InstrumentRow[] = []
  let demoCount = -1
  const refreshDemo = async (): Promise<void> => {
    if (demoFeed === null) return
    try {
      const want = demoInstruments({
        rows: masterRows,
        registry: [...(await store.listBooks('paper')), ...(await store.listBooks('live'))],
        books: [...(await store.allBooks('paper')), ...(await store.allBooks('live'))],
      })
      demoFeed.setInstruments(want, null)
      if (want.length !== demoCount) log('demo feed contracts', { contracts: want.length })
      demoCount = want.length
    } catch (err) {
      log('demo feed refresh failed, keeping the last set', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const applyRows = (rows: readonly InstrumentRow[]): void => {
    const { options, spotToken } = feedInstruments(rows)
    feed.setInstruments(options, spotToken)
    masterRows = rows
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
  await refreshDemo()
  demoFeed?.start()
  await sync()
  await refreshDemo()
  const demoTimer = setInterval(() => void refreshDemo(), DX_DEMO_REFRESH_MS)
  demoTimer.unref()

  // GAP FILL: a held leg the socket has gone quiet on is read from REST, so a
  // pause in Delta's push stream does not leave a straddle on a stale quote
  // (the stale-exit clock). Both feeds; `DESK_DX_GAP_FILL=off` disables it.
  const gapFills: DxGapFill[] = []
  if (process.env['DESK_DX_GAP_FILL'] !== 'off') {
    let held: readonly string[] = []
    const refreshHeld = async (): Promise<void> => {
      try {
        held = heldSymbols([...(await store.allBooks('paper')), ...(await store.allBooks('live'))])
      } catch (err) {
        log('gap fill: held legs read failed, keeping the last set', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    await refreshHeld()
    const heldTimer = setInterval(() => void refreshHeld(), GAP_FILL_HELD_REFRESH_MS)
    heldTimer.unref()
    const bulk = (rest: DxTickerPort) => () => rest.tickers({ contractTypes: ['call_options', 'put_options'], underlying: [DX_UNDERLYING] })
    const pairs: [string, DxFeed | null, DxTickerPort | undefined][] = [
      ['prod', feed, clients.tickers],
      ['demo', demoFeed, clients.demoTickers],
    ]
    for (const [label, f, rest] of pairs) {
      if (f === null || rest === undefined) continue
      const gf = new DxGapFill({ feed: f, held: () => held, ticker: (s) => rest.ticker(s), tickers: bulk(rest), label, log })
      gf.start()
      gapFills.push(gf)
    }
    log('gap fill on', { feeds: gapFills.length, held: held.length })
  }

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
    bus.publish(
      'md.health',
      dxHealthPayload({
        feed: feed.health(),
        nowMs,
        lastSyncMs,
        staleAfterMs,
        ...(demoFeed === null ? {} : { demo: { url: demoUrl, health: demoFeed.health() } }),
      }),
      nowMs,
    )
  }, 10_000)
  healthTimer.unref()

  log('marketdata up (dx)', { tokens: feed.tokenCount })

  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`)
    for (const g of gapFills) g.stop()
    feed.close()
    demoFeed?.close()
    void bus.close().then(() => mongo.close()).then(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
