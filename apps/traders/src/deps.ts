/**
 * The one bag every route factory may take a `Pick<>` of. `createApp` builds it
 * once, so every consumer holds the same store objects: `LegStore.version()` is a
 * per-instance counter and the ingest chains are keyed by the `IngestDeps`
 * object, so a second instance of either would silently break the payoff cache
 * or the per-trader serialisation.
 */

import type { BookedReader } from './analytics/booked.ts'
import type { ChargeSettingsStore } from './analytics/charges.ts'
import type { MarketContext } from './analytics/context-wire.ts'
import type { EodStore } from './analytics/eod.ts'
import type { SpanStore } from './analytics/margin.ts'
import type { PayoffCache } from './analytics/payoff-cache.ts'
import type { EventRiskView } from './analytics/risk-wire.ts'
import type { SeriesReader } from './analytics/series-pnl.ts'
import type { SnapshotCache } from './analytics/snapshot.ts'
import type { AnalysisParams, AnalysisView, ScenarioRequest, ScenarioView } from './analytics/wire.ts'
import type { SessionStore } from './auth/sessions.ts'
import type { WatcherTokens } from './auth/tokens.ts'
import type { TraderStore } from './auth/users.ts'
import type { LegStore } from './books/legs.ts'
import type { TradersConfig } from './config.ts'
import type { TradersDb } from './db.ts'
import type { FileStore } from './ingest/files.ts'
import type { LedgerStore } from './ingest/ledger-store.ts'
import type { IngestDeps } from './ingest/pipeline.ts'
import type { HistoryStore } from './market/history.ts'
import type { IntradayBars } from './market/intraday.ts'
import type { TradersMaster } from './market/master.ts'
import type { EventsStore } from './market/events-store.ts'
import type { FeedHealth, TradersQuotes } from './market/quotes.ts'
import type { Declarer } from './market/subscriptions.ts'
import type { VolStore } from './market/vol-store.ts'
import type { Log } from './routes/kit.ts'
import type { BookView } from './types.ts'
import type { WatcherStatusStore } from './watcher-status.ts'

export interface TradersDeps {
  readonly db: TradersDb
  readonly users: TraderStore
  readonly sessions: SessionStore
  readonly tokens: WatcherTokens
  readonly status: WatcherStatusStore
  readonly files: FileStore
  readonly legs: LegStore
  readonly ledger: LedgerStore
  readonly ingest: IngestDeps
  /** Never an empty master: it is loaded before the server listens, and a failed refresh keeps the old one. */
  readonly master: () => TradersMaster
  readonly quotes: TradersQuotes
  readonly subscriptions: Declarer
  readonly payoffCache: PayoffCache
  /** One market snapshot per (trader, stock, leg version) a minute: Analysis, Scenario and Margin read it. */
  readonly snapshots: SnapshotCache
  /** Yesterday's close and OI from NSE's end-of-day files (config.nseDir), re-read every minute: the MTM block and R3's Market Watch read it. */
  readonly eod: EodStore
  /** NSE SPAN + exposure files from config.nseDir, re-read every minute. Always present: with no file yet, Margin answers the no-file view. */
  readonly span: SpanStore
  /** The held stocks' evening chain snapshots and NSE CMVOLT (config.nseDir/vol), re-read every minute with the end-of-day files. */
  readonly vol: VolStore
  /** NSE's results board meetings (config.nseDir/events.json, the vol job's events step), re-read every minute with the vol files. */
  readonly calendar: EventsStore
  /** The results-event view of a trader's books (null = an admin's, every trader's), a minute per trader (routes/events.ts). */
  readonly eventRisk: (trader: string | null, nowMs: number) => Promise<EventRiskView>
  /** The admin's charges rates table (traders-settings, kind 'charges'). */
  readonly charges: ChargeSettingsStore
  /** Each book's series inputs (its live expiries' trades, balance, history, rates), a minute per leg version. Absent = no series on the views. */
  readonly series?: SeriesReader
  /** The Booked page's walk of a trader's whole history (`bookedReader`), five minutes per trader and leg version: the Booked page and the assistant's track record read it. */
  readonly booked: BookedReader
  readonly bookView: (trader: string, stock: string, nowMs: number, opts?: { keys?: ReadonlySet<string> }) => Promise<BookView | null>
  /** One book's Analysis window (buildAnalysisView over this bag); null = no open book. R3's minute cache wraps it (its N2.8). */
  readonly analysisOf: (trader: string, stock: string, p: AnalysisParams, nowMs: number) => Promise<AnalysisView | null>
  /** One book's Scenario window (buildScenarioView over this bag); null = no open book, `{ error }` = a range the book refuses. R3's minute cache wraps it (its N2.8). */
  readonly scenarioOf: (trader: string, stock: string, req: ScenarioRequest, nowMs: number) => Promise<ScenarioView | { readonly error: string } | null>
  /** The daily history summaries (`<nseDir>/history`, span_job's history step), re-read every minute. Market data. */
  readonly history: HistoryStore
  /** Today's 5- and 15-minute bars of every F&O underlying's spot and near future, sampled from the quote cache each second. */
  readonly intraday: IntradayBars
  /** One underlying's market context (analytics/context.ts over this bag, a 2 s cache); null = the master does not list it. */
  readonly marketContext: (stock: string, nowMs: number) => Promise<MarketContext | null>
  readonly feed: FeedHealth
  /** null when there is no bus to ask. */
  readonly busConnected: () => boolean | null
  readonly config: TradersConfig
  readonly log: Log
  now(): number
}
