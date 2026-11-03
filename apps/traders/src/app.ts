/**
 * The ONE composition point: main, the test harness and the safety walk all go
 * through `createApp`. Every store is built here once and handed to every
 * consumer, so the gate and `adminRoutes` hold the same session and token
 * stores, and one `LegStore` and one `IngestDeps` serve ingest, the books
 * routes and the book view (see deps.ts for why that matters).
 *
 * R2 and R3 append their route factories to `routes` below.
 */

import type { Server } from 'node:http'
import type { Transport } from '@algomaker/bus'
import { QuoteCache } from '../../api/src/marks.ts'
import { SpendLedger, TurnGate } from './agent/budget.ts'
import { AI_OFF, type AiConfig } from './agent/config.ts'
import { modelFor, type ModelFactory } from './agent/model.ts'
import { AssistantStore } from './agent/store.ts'
import type { AgentDeps, AnyTool } from './agent/tools/ctx.ts'
import { agentTools } from './agent/tools/index.ts'
import { PushStore, Pusher, VapidStore, type PushSender, type VapidKeys } from './alerts/push.ts'
import { AlertRunner } from './alerts/runner.ts'
import { AlertStore } from './alerts/store.ts'
import { generateVapidKeys, webPushSender } from './alerts/web-push.ts'
import { isIndex } from './analytics/market-watch.ts'
import { buildAnalysisView } from './analytics/analysis.ts'
import { BandBoard } from './analytics/band-board.ts'
import { BandOverrideStore, EventStore } from './analytics/band.ts'
import { buildBookView } from './analytics/book-view.ts'
import { bookedReader } from './analytics/booked.ts'
import { TtlCache } from './analytics/cache.ts'
import { ChargeSettingsStore } from './analytics/charges.ts'
import { marketContextOf } from './analytics/context.ts'
import type { MarketContext } from './analytics/context-wire.ts'
import { DAILY_TICK_MS, DailyRecorder } from './analytics/daily.ts'
import { EodStore } from './analytics/eod.ts'
import { SpanStore } from './analytics/margin.ts'
import { PayoffCache } from './analytics/payoff-cache.ts'
import { RepairPool, workerRunner } from './analytics/repair-pool.ts'
import { BookRisk } from './analytics/risk.ts'
import { buildScenarioView } from './analytics/scenario-view.ts'
import { seriesReader } from './analytics/series-pnl.ts'
import { SnapshotCache } from './analytics/snapshot.ts'
import { createTradersGate } from './auth/gate.ts'
import { SessionStore } from './auth/sessions.ts'
import { WatcherTokens } from './auth/tokens.ts'
import { TraderStore } from './auth/users.ts'
import { GroupStore } from './books/groups.ts'
import { LegStore } from './books/legs.ts'
import { DEFAULT_PUSH_SUBJECT, assertOrigins, type TradersConfig } from './config.ts'
import type { TradersDb } from './db.ts'
import type { TradersDeps } from './deps.ts'
import { makeApply } from './ingest/apply.ts'
import { FileStore } from './ingest/files.ts'
import { reparseProblems, type IngestDeps } from './ingest/pipeline.ts'
import { LedgerStore } from './ingest/ledger-store.ts'
import { settlementJob } from './ingest/settle-job.ts'
import { isIndexFrom, priceFromHistory } from './ingest/settlement.ts'
import { odinBseFoTrades } from './ingest/odin/bse-fo-trades.ts'
import { odinNseEqTrades } from './ingest/odin/nse-eq-trades.ts'
import { odinNseFoTrades } from './ingest/odin/nse-fo-trades.ts'
import { odinNseOrders } from './ingest/odin/nse-orders.ts'
import { CANONICAL_PARSERS, registerParsers } from './ingest/parsers.ts'
import { writeHeld } from './market/held.ts'
import { HISTORY_REFRESH_MS, HistoryStore } from './market/history.ts'
import { IntradayBars } from './market/intraday.ts'
import { loadTradersMaster, spotTokenOf, type TradersMaster } from './market/master.ts'
import { EventsStore } from './market/events-store.ts'
import { DEFAULT_MARKET_WATCH_MAX_TOKENS, OnScreenSet } from './market/on-screen.ts'
import { attachFeed, seedSnapshot, tradersQuotes, type FeedHealth, type TradersQuotes } from './market/quotes.ts'
import { NOTHING_DECLARED, startDeclaring, type Declarer } from './market/subscriptions.ts'
import { VolStore } from './market/vol-store.ts'
import { adminRoutes } from './routes/admin.ts'
import { adviceRoutes } from './routes/advice.ts'
import { analysisRoutes } from './routes/analysis.ts'
import { assistantRoutes } from './routes/assistant.ts'
import { planSearchRoutes } from './routes/plan-search.ts'
import { authRoutes } from './routes/auth.ts'
import { bookedRoutes } from './routes/booked.ts'
import { bookViewRoutes } from './routes/book-view.ts'
import { dailyRoutes } from './routes/daily.ts'
import { dataStatusRoutes } from './routes/data-status.ts'
import { eventsReader, eventsRoutes } from './routes/events.ts'
import { LiveStreams, liveRoutes } from './routes/live.ts'
import { booksRoutes } from './routes/books.ts'
import { groupsRoutes } from './routes/groups.ts'
import { healthRoutes } from './routes/health.ts'
import type { Log, Route } from './routes/kit.ts'
import { marginRoutes } from './routes/margin.ts'
import { marketRoutes } from './routes/market.ts'
import { marketContextRoutes } from './routes/market-context.ts'
import { portfolioRoutes } from './routes/portfolio.ts'
import { pushRoutes } from './routes/push.ts'
import type { R3RouteDeps } from './routes/r3-deps.ts'
import { recordsRoutes } from './routes/records.ts'
import { repairRoutes } from './routes/repair.ts'
import { riskRoutes } from './routes/risk.ts'
import { scenarioRoutes } from './routes/scenario.ts'
import { settingsRoutes } from './routes/settings.ts'
import { uploadRoutes } from './routes/uploads.ts'
import { volRoutes } from './routes/vol.ts'
import { createTradersServer } from './server.ts'
import { WatcherStatusStore } from './watcher-status.ts'

export const MASTER_REFRESH_MS = 15 * 60_000
/** The span job saves the end-of-day files once an evening; a minute's stat of two files finds them soon enough. */
export const EOD_REFRESH_MS = 60_000
/** The SPAN files arrive through the session; the store looks for a new one every minute. */
export const SPAN_REFRESH_MS = 60_000
/** One market context per underlying is built at most every 2 s and shared (the page polls it, the assistant asks it). */
export const CONTEXT_TTL_MS = 2_000

/**
 * What a caller (a test) may hand in instead of what createApp builds: the
 * bag's stores and seams, and the repair pool. Not the bag's db, log or clock
 * (AppDeps' own), nor the Market Watch set, band store, risk or board, which
 * createApp always builds itself.
 */
export type AppOverride = Partial<Omit<TradersDeps, 'db' | 'log' | 'now'> & Pick<R3RouteDeps, 'repair'>>

/** The assistant (spec §6). Absent = off, and the app is exactly as without it (R4). */
export interface AssistantSetup {
  readonly config: AiConfig
  /** Tests hand in a mock model; the default builds the configured provider. */
  readonly modelFor?: ModelFactory
  /** Tests hand in their own tools; the default is agentTools(). */
  readonly tools?: readonly AnyTool[]
  readonly wallClockMs?: number
  readonly pingMs?: number
}

export interface AppDeps {
  readonly db: TradersDb
  /** The bus the live feed arrives on; null = no feed (the quotes then come only from the stored snapshot). */
  readonly bus: Transport | null
  readonly config: TradersConfig
  readonly now: () => number
  readonly log: Log
  /** A fixed master (tests): nothing is loaded or refreshed. */
  readonly master?: TradersMaster
  /** Injected quotes (tests): no QuoteCache is built, seeded or fed. */
  readonly quotes?: TradersQuotes
  /** false = build the Declarer but never publish. */
  readonly declare?: boolean
  readonly override?: AppOverride
  /** Test seams for the master loader and its refresh period. */
  readonly loadMaster?: (db: TradersDb, nowMs: number) => Promise<TradersMaster>
  readonly masterRefreshMs?: number
  /** Test seam for the end-of-day folder's re-read period. */
  readonly eodRefreshMs?: number
  /** Test seam for the SPAN folder's re-read period. */
  readonly spanRefreshMs?: number
  /** Test seam for the history folder's re-read period. */
  readonly historyRefreshMs?: number
  /** false = the intraday bars are built but never sampled on a timer (tests call `deps.intraday.sample()`). */
  readonly intradaySampler?: boolean
  /** Test seam: how the end-of-day and SPAN refresh timers are set (default an unref'd setInterval); returns what clears one. */
  readonly every?: (run: () => Promise<void>, ms: number) => () => void
  /** false = the band board is built and loaded but its minute loop never starts (tests tick it by hand). */
  readonly bandBoard?: boolean
  /** false = the daily recorder is built but its minute timer never starts (tests call `app.daily.tick()` by hand). */
  readonly daily?: boolean
  readonly assistant?: AssistantSetup
  /** Phone alerts (gaps G7): tests hand in a fake sender (never a real push) and may fix the VAPID key maker. */
  readonly push?: { readonly send?: PushSender; readonly generate?: () => VapidKeys }
  /** false = the alert runner is built and hooked but its minute loop never starts (tests tick it by hand). */
  readonly alertRunner?: boolean
}

export interface App {
  readonly server: Server
  readonly deps: TradersDeps
  readonly routes: readonly Route[]
  start(): Promise<void>
  stop(): Promise<void>
  /** The band board, for a test that ticks it by hand. */
  readonly board: BandBoard
  /** The daily recorder, for a test that ticks it by hand. */
  readonly daily: DailyRecorder
  /** The alert runner, for a test that ticks it by hand. */
  readonly alerts: AlertRunner
}

function interval(run: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => { void run() }, ms)
  timer.unref()
  return () => clearInterval(timer)
}

/** A Declarer that exists from the start but only publishes once `start()` hands it the real one. */
function lazyDeclarer(): Declarer & { attach(real: Declarer): void } {
  const sources = new Map<string, (nowMs: number) => readonly number[]>()
  let real: Declarer | null = null
  return {
    addTokenSource(name, fn) { sources.set(name, fn); real?.addTokenSource(name, fn) },
    refreshNow: async () => (real === null ? [] : await real.refreshNow()),
    last: () => real?.last() ?? NOTHING_DECLARED,
    stop() { real?.stop() },
    attach(r) { real = r; for (const [n, fn] of sources) r.addTokenSource(n, fn) },
  }
}

export async function createApp(d: AppDeps): Promise<App> {
  assertOrigins(d.config.origins)
  const o = d.override ?? {}
  const { db, now, log } = d

  registerParsers([odinNseFoTrades, odinNseEqTrades, odinNseOrders, odinBseFoTrades, ...CANONICAL_PARSERS])

  // The master. It is never empty: `current` is set before start() resolves.
  let current: TradersMaster | null = d.master ?? null
  const ownMaster = o.master === undefined
  const master = o.master ?? ((): TradersMaster => {
    if (current === null) throw new Error('the instrument master is not loaded yet')
    return current
  })

  const users = o.users ?? new TraderStore(db)
  const sessions = o.sessions ?? new SessionStore(db)
  const tokens = o.tokens ?? new WatcherTokens(db)
  const status = o.status ?? new WatcherStatusStore(db)
  const files = o.files ?? new FileStore(db, now)
  const legs = o.legs ?? new LegStore(db, now)
  const payoffCache = o.payoffCache ?? new PayoffCache(now)
  const feed: FeedHealth = o.feed ?? { payload: null, receivedAt: null }

  let cache: QuoteCache | null = null
  let quotes: TradersQuotes
  if (o.quotes !== undefined) quotes = o.quotes
  else if (d.quotes !== undefined) quotes = d.quotes
  else {
    cache = new QuoteCache({ feedDeadAfterMs: 120_000, staleAfterMs: 60_000, now })
    quotes = tradersQuotes(cache)
  }

  const snapshots = o.snapshots ?? new SnapshotCache({ master, quotes, now })
  const config = o.config ?? d.config
  const ownEod = o.eod === undefined
  const eod = o.eod ?? new EodStore({ dir: config.nseDir, now })
  // always built: the folder may not exist yet at boot (before the first download); each pass looks again
  const ownSpan = o.span === undefined
  const span = o.span ?? new SpanStore({ dir: config.nseDir, now })
  // the held stocks' evening chain snapshots and NSE's CMVOLT file (scripts/nse_vol_job.py), re-read with the end-of-day files
  const ownVol = o.vol === undefined
  const vol = o.vol ?? new VolStore({ dir: config.nseDir, now })
  // NSE's results board meetings (the vol job's events step, risk spec R9), re-read with the vol files
  const ownCalendar = o.calendar === undefined
  const calendar = o.calendar ?? new EventsStore({ dir: config.nseDir })
  const charges = o.charges ?? new ChargeSettingsStore(db, now, log)
  // the daily history (span_job's summaries) and today's sampled bars: market data for the levels and the assistant
  const ownHistory = o.history === undefined
  const history = o.history ?? new HistoryStore({ dir: config.nseDir, log })
  // expiry settlement (spec 2026-10-23 G1/G2): the ledger settles expired contracts at the history's closes
  const ledger = o.ledger ?? new LedgerStore(db, { price: priceFromHistory(history), isIndex: isIndexFrom(master), now })
  // an applied orders file runs that trader's rejected-order alerts at once (bound to the alert runner below)
  let ordersLanded = (_trader: string): void => {}
  const applyParsed = makeApply({ db, legs, ledger, master, now })
  const ingest: IngestDeps = o.ingest ?? {
    files, log,
    apply: async (trader, parsed, file) => {
      await applyParsed(trader, parsed, file)
      if (parsed.kind === 'orders') ordersLanded(trader)
    },
  }
  const ownIntraday = o.intraday === undefined
  const intraday = o.intraday ?? new IntradayBars({ master, quotes, now, log })
  const contexts = new TtlCache<MarketContext | null>(CONTEXT_TTL_MS)
  const marketContext = o.marketContext ?? ((stock: string, nowMs: number): Promise<MarketContext | null> =>
    contexts.get(stock, nowMs, () => marketContextOf({ master, quotes, history, intraday, eod, vol, calendar }, stock, nowMs)))
  // each held book's results-event risk, a minute per trader: the page, the assistant and the results-ahead alert read it
  const eventRisk = o.eventRisk ?? eventsReader({ legs, calendar, bars: (s, n) => history.bars(s, n), master, quotes, snapshots })

  const groups = new GroupStore(db, now)
  // Repair searches and the assistant's plan searches share two worker threads, started by the first search and ended by stop(). A test may hand in its own pool.
  const repairWorkers = workerRunner()
  const repair = o.repair ?? new RepairPool({ run: repairWorkers.run, runSearch: repairWorkers.runSearch, now })
  const bands = new BandOverrideStore(db, now)
  const events = new EventStore(db)

  const lazy = lazyDeclarer()
  const subscriptions: Declarer = o.subscriptions ?? lazy

  // Market Watch's on-screen chains: each underlying for a minute after its last poll, within the cap (P3),
  // and within what TRADERS_MAX_TOKENS leaves beside the books' full windows (Ruling R3-18)
  const onScreen = new OnScreenSet({
    maxTokens: config.marketWatchMaxTokens ?? DEFAULT_MARKET_WATCH_MAX_TOKENS,
    feedRoom: () => config.maxTokens - subscriptions.last().bookDemand,
  })
  subscriptions.addTokenSource('market-watch', (nowMs) => onScreen.tokens(nowMs))

  const busConnected = o.busConnected ?? ((): boolean | null => {
    const c = (d.bus as { connected?: unknown } | null)?.connected
    return typeof c === 'boolean' ? c : null
  })

  // A book whose ATM window the last declaration narrowed to fit TRADERS_MAX_TOKENS says so.
  const feedCap = (stock: string): number | null => (subscriptions.last().trimmed.has(stock) ? config.maxTokens : null)
  // one reader for the book and its Analysis window, so both see the same minute's trades
  const series = seriesReader({ db, ledger, charges })
  // the Booked page's walk of each trader's whole history, kept per trader and leg version (five minutes at most)
  const booked = bookedReader({ db, legs, ledger, charges, master })
  const bookView = o.bookView ?? ((trader, stock, nowMs, opts) =>
    buildBookView({ legs, ledger, files, status, master, quotes, payoffCache, feedCap, series }, trader, stock, nowMs, opts))
  // reads the whole bag (the snapshot and the MTM block's inputs), so it is bound to it once it exists
  const analysisOf = o.analysisOf ?? ((trader, stock, p, nowMs) => buildAnalysisView(deps, trader, stock, p, nowMs))
  const scenarioOf = o.scenarioOf ?? ((trader, stock, req, nowMs) => buildScenarioView(deps, trader, stock, req, nowMs))

  const deps: TradersDeps = {
    db, users, sessions, tokens, status, files, legs, ledger, ingest, master, quotes, subscriptions,
    payoffCache, snapshots, eod, span, vol, calendar, eventRisk, charges, series, booked, bookView, analysisOf, scenarioOf, history, intraday, marketContext,
    feed, busConnected, config, log, now,
  }

  // phone alerts (gaps G7): the server's VAPID keys, the phones, the stored alerts and the runner that raises them
  const pushSubs = new PushStore(db, now)
  const vapid = new VapidStore(db, now, d.push?.generate ?? generateVapidKeys)
  const pusher = new Pusher({ subs: pushSubs, users, vapid, subject: config.pushSubject ?? DEFAULT_PUSH_SUBJECT, send: d.push?.send ?? webPushSender, now, log })
  const alertStore = new AlertStore(db)
  const alerts = new AlertRunner({
    store: alertStore, pusher, users, status, legs, db, isIndex, now, log,
    results: { calendar, view: (trader, nowMs) => eventRisk(trader, nowMs) },
    spotOf: (stock) => {
      const token = spotTokenOf(master(), stock)
      return token === null ? null : (quotes.quote(token)?.price ?? null)
    },
  })
  ordersLanded = (trader) => alerts.ordersLanded(trader)

  // one band reading per book a minute, shared by the books list, the band route and the board's events
  const risk = new BookRisk({ bookView, legs, master, quotes, bands })
  // the 15:45 IST record of every book, from the functions the pages call (analytics/daily.ts)
  const daily = new DailyRecorder(deps)
  // an event to "out" is a phone alert as soon as the board writes it
  const board = new BandBoard({ risk, events: alerts.watchBand(events), legs, now, log })

  const gate = createTradersGate({ users, sessions, tokens, now })
  const streams = new LiveStreams()

  // the assistant: its store is always there (conversations stay readable when it is switched off), its model only when on
  const assistantStore = new AssistantStore(db, now)
  const assistantStreams = new LiveStreams()
  const agent: AgentDeps = { ...deps, groups, repair, bands, risk, board, onScreen }
  const ai = d.assistant

  const routes: Route[] = [
    healthRoutes(deps),
    authRoutes({ users, sessions, sessionTtlMs: deps.config.sessionTtlMs, now, log }),
    adminRoutes({ users, sessions, tokens, status, now, log, phones: pushSubs }),
    uploadRoutes({ ingest, status, users, now, log }),
    booksRoutes({ users, legs, files, master, now, log, board }),
    bookViewRoutes({ users, bookView, now }),
    liveRoutes({ deps, users, gate, streams, now }),
    recordsRoutes({ users, db, status, files, now }),
    settingsRoutes({ charges }),
    marginRoutes(deps),
    analysisRoutes(deps),
    scenarioRoutes(deps),
    groupsRoutes({ users, bookView, groups, now }),
    repairRoutes({ users, legs, bookView, master, quotes, repair, now, log }),
    adviceRoutes({ users, legs, bands, risk, now }),
    marketRoutes({ master, quotes, subscriptions, onScreen, now, eod }),
    marketContextRoutes(deps),
    portfolioRoutes({ ...deps, risk }),
    planSearchRoutes({ users, agent, store: assistantStore, now, log }),
    assistantRoutes({
      users, agent, store: assistantStore, config: ai?.config ?? AI_OFF, modelFor: ai?.modelFor ?? ((c) => modelFor(c)),
      tools: ai?.tools ?? agentTools(agent), gate: new TurnGate(), ledger: new SpendLedger(), streams: assistantStreams, now, log,
      ...(ai?.pingMs === undefined ? {} : { pingMs: ai.pingMs }), ...(ai?.wallClockMs === undefined ? {} : { wallClockMs: ai.wallClockMs }),
    }),
    volRoutes({
      users, legs, vol, bars: (s, n) => history.bars(s, n), adjustments: (s, n) => history.adjustments(s, n),
      calendar, expiries: (s) => master().options.expiries(s), now,
    }),
    riskRoutes(deps),
    eventsRoutes({ users, eventRisk, now }),
    dailyRoutes({ users, daily: daily.store, now }),
    dataStatusRoutes(deps),
    bookedRoutes({ users, legs, booked, bookView, now }),
    pushRoutes({ users, subs: pushSubs, vapid, pusher, alerts: alertStore, now }),
  ]

  const server = createTradersServer({
    gate,
    routes,
    allowedOrigins: deps.config.origins,
    log,
  })

  const stoppers: (() => void)[] = []
  let stopped = false

  return {
    server, deps, routes, board, daily, alerts,
    async start() {
      await db.ensureIndexes()
      await groups.ensureIndexes()
      await events.ensureIndexes()
      await assistantStore.ensureIndexes()
      await alertStore.ensureIndexes()
      await pushSubs.ensureIndexes()
      if (ownMaster && d.master === undefined) {
        const load = d.loadMaster ?? loadTradersMaster
        const first = await load(db, now())
        if (first.options.optionCount + first.cash.size === 0) {
          throw new Error('the instrument collection is empty: refusing to start with no master (is the desk database right?)')
        }
        current = first
        const timer = setInterval(() => {
          void load(db, now()).then(
            (m) => { if (m.options.optionCount + m.cash.size > 0) current = m },
            (err: unknown) => log('master refresh failed, keeping the old one', { error: String(err) }),
          )
        }, d.masterRefreshMs ?? MASTER_REFRESH_MS)
        timer.unref()
        stoppers.push(() => clearInterval(timer))
      }
      // The NSE folders: nothing here waits for them (a full-size SPAN file takes seconds to parse). The first
      // passes run once the server listens; until the end-of-day read lands every close is unknown (named as missing).
      const every = d.every ?? interval
      const firsts: (() => Promise<void>)[] = []
      if (ownEod || ownVol || ownCalendar) {
        // none throws: a missing or bad file is in eod.status().missing, vol.status().problems, calendar.status().problems
        const read = async (): Promise<void> => {
          await Promise.all([ownEod ? eod.refresh() : null, ownVol ? vol.refresh() : null, ownCalendar ? calendar.refresh() : null])
        }
        firsts.push(read)
        stoppers.push(every(read, d.eodRefreshMs ?? EOD_REFRESH_MS))
      }
      if (ownSpan) {
        // never throws: a failed parse keeps the last good file; the stocks are the open books' (a failed read keeps the last pass)
        const pass = async (): Promise<void> => {
          try {
            const open = await legs.allOpen()
            // held.json for scripts/nse_vol_job.py, symbols only (market/held.ts); a failed write keeps the last file
            void writeHeld(config.nseDir, open, now()).catch((err: unknown) => log('held stocks not written', { error: String(err) }))
            await span.refresh(new Set(open.map((l) => l.stock)))
          } catch (err) { log('span refresh failed', { error: String(err) }) }
        }
        firsts.push(pass)
        stoppers.push(every(pass, d.spanRefreshMs ?? SPAN_REFRESH_MS))
      }
      if (ownHistory) {
        // G1's backfill as a recompute: every trader's legs are settled again once the history is read at boot, and
        // whenever it picks up (or changes) a day; through the ingest chains, so never racing an apply
        const settle = settlementJob({ ledger, legs, master, ingest, log, now })
        let settledAt = -1   // the history version the legs were last settled against; -1 = not since boot
        const read = async (): Promise<void> => {
          await history.refresh()   // never throws: a bad file is skipped and named in history.status()
          // no day read (an unreadable or empty folder): a run now would re-open every settled contract, so none runs
          if (history.closeDays().days === 0) return
          if (history.version() === settledAt) return
          settledAt = history.version()
          await settle()   // never throws
        }
        firsts.push(read)
        stoppers.push(every(read, d.historyRefreshMs ?? HISTORY_REFRESH_MS))
      }
      if (o.ingest === undefined) {
        // files and lines refused before a parser learned their ODIN layout, read again from what is stored (the watcher never resends them)
        firsts.push(async () => {
          const r = await reparseProblems(ingest)
          if (r.tried > 0) log('files with problems parsed again', r)
        })
      }
      if (firsts.length > 0) {
        const first = (): void => { for (const f of firsts) void f() }
        if (server.listening) first()
        else {
          server.once('listening', first)
          stoppers.push(() => { server.off('listening', first) })
        }
      }
      if (cache !== null) {
        await seedSnapshot(db, cache)
        if (d.bus !== null) stoppers.push(attachFeed(d.bus, cache, feed, now))
      }
      if (ownIntraday && d.intradaySampler !== false) {
        // once a second, unref'd: today's bars start when the app does (a restart loses the morning, said in the context)
        intraday.start()
        stoppers.push(() => intraday.stop())
      }
      if (d.declare !== false && o.subscriptions === undefined) {
        lazy.attach(startDeclaring({
          db, legs: () => legs.allOpen(), master, priceOf: (t) => quotes.quote(t)?.price ?? null, now, log,
          maxTokens: config.maxTokens,
        }))
        stoppers.push(() => lazy.stop())
      }
      await board.load()
      if (d.bandBoard !== false) {
        board.start()
        stoppers.push(() => board.stop())
      }
      // never throws; the first pass is a minute after start, so the feed, the end-of-day files and the SPAN file have been read
      if (d.daily !== false) stoppers.push(every(async () => { await daily.tick() }, DAILY_TICK_MS))
      if (d.alertRunner !== false) {
        alerts.start()
        stoppers.push(() => alerts.stop())
      }
    },
    async stop() {
      streams.closeAll()   // an open live stream would hold server.close() until its client left
      assistantStreams.closeAll()   // and so would an answer being written
      if (stopped) return
      stopped = true
      for (const s of stoppers) s()
      repair.close()   // a search waiting for a slot is answered busy now, not after its 20 s
      await repairWorkers.close()
    },
  }
}
