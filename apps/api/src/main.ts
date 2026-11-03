/**
 * Desk bridge entry point.
 *
 * Boots unconditionally, exactly like the working legacy strategies do — no
 * time-window gate on startup. Gating boot behind market hours is the
 * 2026-07-06 bug (`packages/strategy-kit/src/base.ts:105`) and must not be
 * reintroduced: a pm2 restart at 09:15:30 has to come up ready, not asleep.
 *
 * Every secret comes from the environment. Nothing is read from a file in the
 * repo, and nothing is defaulted — a missing token fails loudly at boot rather
 * than starting an unauthenticated bridge that can move money.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { connectWithRetry, installCrashGuards } from '@algomaker/core'
import { connectMongo } from './mongo.ts'
import { requireMasterKey } from './brokerstore.ts'
import { DeskStore } from './store.ts'
import { BridgeService, type MasterProvider, type RiskGatePort } from './service.ts'
import { LiveRail, PaperRail } from './rail.ts'
import { WsTransportClient } from '@algomaker/bus'
import { QuoteCache } from './marks.ts'
import { RailIndex } from './demo-marks.ts'
import { DEMO_TICK_TOPIC } from './books-registry.ts'
import { createBridgeServer } from './server.ts'
import { DeskStream } from './stream.ts'
import { LiveBook } from './livebook.ts'
import { PnlStore } from './pnlstore.ts'
import { backfillSeriesFromAudit } from './migrate.ts'
import { deriveUnderlying } from '../../order-gateway/src/gateway.ts'
import {
  anyExposureLimitSet,
  exposureLimitsFromEnv,
  OrderRateWindow,
  ReservationLedger,
  type ExposureState,
} from '@algomaker/order-bus'
import type { DeskMode } from './contract.ts'
import { streamRoutes } from './routes/stream.ts'
import { loadStoredInstruments } from '../../marketdata/src/sync-runner.ts'
import { MasterRefresher, collectionFingerprint } from './master-refresh.ts'
import type { ApiDeps } from './routes/kit.ts'
import { API_VENUE } from './venue.ts'
import { createAuthGate } from './authsvc.ts'
import { healthRoutes } from './routes/health.ts'
import { systemRoutes } from './routes/system.ts'
import { authRoutes } from './routes/auth.ts'
import { brokerRoutes } from './routes/brokers.ts'
import { deskRoutes } from './routes/desk.ts'
import { engineRoutes } from './routes/engine.ts'
import { pnlRoutes } from './routes/pnl.ts'
import { payoffRoutes } from './routes/payoff.ts'
import { repairRoutes } from './routes/repair.ts'
import { reportRoutes } from './routes/reports.ts'
import { submitRoutes } from './routes/submit.ts'
import { booksRoutes } from './routes/books.ts'
import { runnerRoutes } from './routes/runner.ts'
import { positionsRoutes } from './routes/positions.ts'
import { pnlFor, startPnlJobs } from './pnl-jobs.ts'
import { startDayGuard } from './day-guard.ts'
import { startLiveReconciler } from './reconcile-live.ts'
import { startPaperFillFolder } from './paper-fold.ts'
import { startPositionsCompare } from './positions-compare.ts'
import { startMirrorSync } from './mirror-sync.ts'
import { seedHostedStrategies } from './registry-seed.ts'
import { marketableFromEnv } from './marketable.ts'
import { liveAllowlistFromStrategies } from './strategies.ts'

function required(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name]
  if (v === undefined || v.trim() === '') {
    throw new Error(`${name} is required`)
  }
  return v
}

/**
 * Every secret this process cannot run without, asserted BEFORE any IO.
 *
 * `DESK_MASTER_KEY` belongs here and did not use to. It was only reached through
 * `createAuthGate` -> `requireMasterKey`, which `main()` calls after connecting
 * to Mongo, loading the instrument master, subscribing to the bus, loading the
 * mark snapshot and seeding the registry. `authsvc.ts` claims the key "fails at
 * BOOT"; on the bridge's real boot path it failed several seconds and a dozen
 * side effects in, and a deployment with a typo'd key spent that whole time
 * looking like it was starting normally.
 *
 * Asserting all three together also means one restart tells the operator about
 * every missing variable, instead of one per attempt.
 */
export function requireBootEnv(env: NodeJS.ProcessEnv = process.env): {
  mongoUrl: string
  token: string
} {
  const mongoUrl = required('DESK_MONGO_URL', env)
  const token = required('DESK_API_TOKEN', env)
  // Throws `SecretKeyError` naming the exact problem (absent vs malformed) and
  // how to generate one. Its return value is not kept: `BrokerStore` reads the
  // key for itself, and holding a second copy of it here would be one more
  // place a credential can be logged from.
  requireMasterKey(env)
  return { mongoUrl, token }
}

function log(msg: string, ctx?: Record<string, unknown>): void {
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`
  console.log(`[bridge] ${new Date().toISOString()} ${line}`)
}

/**
 * A positive millisecond duration from the environment, or the default.
 *
 * A typo'd value falls back rather than becoming `NaN`: every comparison
 * against NaN is false, so a mistyped threshold would silently disable the
 * control it configures instead of failing loudly.
 */
/** One row of a P&L summary, as `measureOpenLots` reads it. */
interface MeasurableRow {
  readonly legs: readonly { readonly tradingsymbol: string; readonly qty: number }[]
}

/**
 * WHAT THE DESK HAS OPEN, IN LOTS — and what it could not count.
 *
 * Pulled out of `measureDesk` below as a pure function so the one case that
 * matters can be tested without a server: a leg the instrument master cannot
 * resolve. This USED TO `continue`, which silently under-counted the book — an
 * expired-but-still-held contract (the MIRROR/SENSEX shape) simply weighed
 * nothing, and every lot cap was then judged against a position smaller than
 * the real one. A gate that fails open is worse than no gate, because the
 * operator believes it is there.
 *
 * So the unresolvable symbols come back NAMED, and `checkExposureLimits`
 * refuses new exposure while the list is non-empty — exactly as it refuses on a
 * measurement that failed outright. Exits are never affected.
 *
 * `qty === 0` is a closed round trip the P&L row keeps for its realised figure.
 * It is not a position, so it is neither counted nor reported as unmeasured.
 */
export function measureOpenLots(
  rows: readonly MeasurableRow[],
  lotSizeOf: (tradingsymbol: string) => number,
): {
  openLotsTotal: number
  openLotsByUnderlying: Record<string, number>
  unmeasuredSymbols: string[]
} {
  const openLotsByUnderlying: Record<string, number> = {}
  const unmeasured = new Set<string>()
  let openLotsTotal = 0
  for (const row of rows) {
    for (const leg of row.legs) {
      if (leg.qty === 0) continue
      const lotSize = lotSizeOf(leg.tradingsymbol)
      if (!(lotSize > 0)) {
        unmeasured.add(leg.tradingsymbol)
        continue
      }
      const lots = Math.abs(leg.qty) / lotSize
      openLotsTotal += lots
      const underlying = deriveUnderlying(leg.tradingsymbol)
      openLotsByUnderlying[underlying] = (openLotsByUnderlying[underlying] ?? 0) + lots
    }
  }
  return { openLotsTotal, openLotsByUnderlying, unmeasuredSymbols: [...unmeasured] }
}

function positiveEnvMs(name: string, dflt: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export async function main(): Promise<void> {
  /**
   * Installed FIRST — before the env is even read (audit F-41).
   *
   * The bridge had no guard at all: an unhandled rejection anywhere in it is
   * fatal on Node >=15, so a Mongo blip inside any `void`-ed interval killed
   * the only process that serves the dashboard and the routes. The gateway has
   * carried this since its own G4 incident; the bridge inherited none of it
   * until now. See `@algomaker/core`'s `resilience.ts` for both war stories.
   */
  installCrashGuards({ process, log })

  // FIRST, before a socket is opened or a document is read.
  const { mongoUrl, token } = requireBootEnv()
  const port = Number(process.env['DESK_PORT'] ?? 8890)

  /**
   * The live allowlist now comes from the `modes.live` switch on the Strategies
   * page, which is already the password-gated action — see
   * `liveAllowlistFromStrategies`. `DESK_LIVE_TAGS` survives only as an
   * optional BOX-LEVEL LOCK that can narrow that set, never widen it.
   *
   * NOTE THE INVERTED DEFAULT: empty used to mean "nothing may trade live", and
   * now means "no extra restriction beyond the dashboard switch". The refusal
   * itself did not move — it is still checked inside `LiveRail`, the only
   * object that can write to the live collection.
   */
  const livePin = new Set(
    (process.env['DESK_LIVE_TAGS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  if (livePin.size > 0) {
    log('live rail PINNED to a subset by DESK_LIVE_TAGS', { tags: [...livePin] })
  } else {
    log('live rail governed by the Strategies page switch (no DESK_LIVE_TAGS pin)')
  }

  // A retrying boot must still be STOPPABLE, or `pm2 stop` on a bridge waiting
  // for Mongo hangs until pm2's kill timeout. Removed the moment the wait is
  // over, so the real shutdown handler registered later is the only one.
  const bailOut = (signal: string): void => {
    log(`${signal} received while still booting — exiting`)
    process.exit(0)
  }
  const bailTerm = (): void => bailOut('SIGTERM')
  const bailInt = (): void => bailOut('SIGINT')
  process.on('SIGTERM', bailTerm)
  process.on('SIGINT', bailInt)
  /**
   * RETRY, NEVER EXIT (audit F-41, and the gateway's G6 before it).
   *
   * `await connectMongo` exited on failure, and `connectMongo`'s
   * `serverSelectionTimeoutMS` is 5s — so with pm2's `min_uptime: 10_000` every
   * attempt counted as unstable and ten of them spent the entire restart budget
   * in about seventy seconds. A Mongo that came up at 09:16 then brought
   * nothing back with it, and the desk was down for the session over a
   * twenty-second outage. A process that retries stays alive past `min_uptime`,
   * so the budget is never spent.
   *
   * `DESK_BOOT_MAX_ATTEMPTS` bounds it for tests and for a one-shot boot; unset
   * (the deployed case) means infinite, which is the point.
   */
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
  await store.ensureIndexes()

  /**
   * BOOK SERIES BACKFILL (WS2). Idempotent — a boot after the first writes
   * nothing — and NEVER FATAL: a failure costs the Reports page its grouping
   * until the next boot, which is no reason for the bridge not to start.
   */
  try {
    const backfill = await backfillSeriesFromAudit(mongo.db)
    log('book series backfill', {
      recorded: backfill.recorded.length,
      already: backfill.already,
      unlabelled: backfill.unresolved.length,
    })
  } catch (err) {
    log('book series backfill FAILED — reports stay grouped by tag until the next boot', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Instrument master, refreshed from Mongo. The sync job owns writing it; this
  // process only reads, so a sync failure degrades to a stale master rather
  // than an empty one. A load that lands mid-sync holds only the rows written
  // so far, so a cheap change check reloads as soon as the sync adds rows
  // (`master-refresh.ts`), and the full reload covers in-place edits.
  const instrumentCol = mongo.db.collection('instrument')
  const masterSource = new MasterRefresher(
    {
      load: () => loadStoredInstruments(instrumentCol),
      fingerprint: () => collectionFingerprint(instrumentCol),
    },
    log,
  )
  await masterSource.reload('boot')
  const masterProvider: MasterProvider = {
    current: () => masterSource.current(),
    oiCap: (token) => masterSource.oiCap(token),
  }

  const refreshMs = Number(process.env['DESK_MASTER_REFRESH_MS'] ?? 15 * 60_000)
  const checkMs = Number(process.env['DESK_MASTER_CHECK_MS'] ?? 10_000)
  const masterFailed = (err: unknown): void =>
    log('instrument master refresh failed', { error: err instanceof Error ? err.message : String(err) })
  const refresh = setInterval(() => {
    masterSource.reload('scheduled').catch(masterFailed)
  }, refreshMs)
  refresh.unref()
  const masterCheck = setInterval(() => {
    masterSource.reloadIfChanged().catch(masterFailed)
  }, checkMs)
  masterCheck.unref()

  // Defaults sized from the LIVE BHEL chain (2026-07-27): individual stock
  // option contracts tick roughly every 30s, so a per-token age limit anywhere
  // near that makes every mark vanish. Liveness is feed-wide instead.
  const marks = new QuoteCache({
    feedDeadAfterMs: Number(process.env['DESK_FEED_DEAD_AFTER_MS'] ?? 120_000),
    staleAfterMs: Number(process.env['DESK_MARK_STALE_AFTER_MS'] ?? 60_000),
  })

  // Marks come from the marketdata process over the bus. WITHOUT THIS the cache
  // is never fed: every price reads absent, every action skips with "no mark",
  // and the bridge books nothing. It is not optional plumbing.
  // Shared with the HTTP layer so /v1/desk/feed can report coverage.
  const feedState = { subscribedTokens: 0 }
  const busUrl = process.env['DESK_BUS_URL'] ?? 'ws://127.0.0.1:8891'
  const bus = new WsTransportClient({ url: busUrl })
  /**
   * The in-memory positions book, declared here because two things that are
   * constructed BEFORE it need to reach it: this tick subscription, and
   * `BridgeService`'s journal hook. It cannot be built earlier — it takes the
   * `ApiDeps` bag, which takes the service.
   */
  let liveBook: LiveBook | null = null
  /**
   * DELTA TESTNET QUOTES (`md.tick.demo`) — demo-rail paper books are filled
   * there, so they are marked there (`demo-marks.ts`). Their own cache: a demo
   * price can never reach a production book, an order price or `desk-marks`.
   * `rails` says which books are demo-marked, refreshed from the registry.
   */
  const onDx = API_VENUE.id === 'dx'
  const demoMarks = onDx
    ? new QuoteCache({
        feedDeadAfterMs: Number(process.env['DESK_FEED_DEAD_AFTER_MS'] ?? 120_000),
        staleAfterMs: Number(process.env['DESK_MARK_STALE_AFTER_MS'] ?? 60_000),
      })
    : null
  const rails = new RailIndex()
  type TickPayload = {
    token: number
    price: number
    ts: number
    oi?: number
    volume?: number
    bid?: number
    ask?: number
    depth?: { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] }
    // Delta's option fields (T5). NSE ticks carry none of them.
    mark?: number
    bidSize?: number
    askSize?: number
    iv?: number
    delta?: number
    gamma?: number
    theta?: number
    vega?: number
  }
  const onTick = (cache: QuoteCache, p: TickPayload): void => {
    cache.update(p.token, p.price, p.ts, {
      oi: p.oi,
      volume: p.volume,
      bid: p.bid,
      ask: p.ask,
      depth: p.depth,
      option: {
        mark: p.mark,
        bidSize: p.bidSize,
        askSize: p.askSize,
        iv: p.iv,
        delta: p.delta,
        gamma: p.gamma,
        theta: p.theta,
        vega: p.vega,
      },
    })
    /**
     * Re-mark and push, but ONLY for an instrument the desk actually holds —
     * `onTick` tests that first and returns, which is the bound the whole
     * unthrottled cadence rests on (see `livebook.ts`).
     *
     * Wrapped, because this callback also feeds `QuoteCache`. A throw here
     * would take the bus subscription down and with it every mark on the desk,
     * which would stop the bridge booking anything at all — a dashboard
     * feature is not allowed to cost that.
     */
    try {
      liveBook?.onTick(p.token)
    } catch (err) {
      log('live book tick failed — marks are unaffected', { error: String(err) })
    }
  }
  bus.subscribe<TickPayload>('md.tick', (m) => onTick(marks, m.payload))
  if (demoMarks !== null) {
    bus.subscribe<TickPayload>(DEMO_TICK_TOPIC, (m) => onTick(demoMarks, m.payload))
    const refreshRails = async (): Promise<void> => {
      try {
        rails.set([...(await store.listBooks('paper')), ...(await store.listBooks('live'))])
      } catch (err) {
        log('rail index refresh failed — keeping the last one', { error: String(err) })
      }
    }
    await refreshRails()
    log('demo-rail marks wired', { demoBooks: rails.demoCount })
    const railTimer = setInterval(() => void refreshRails(), Number(process.env['DESK_RAIL_INDEX_MS'] ?? 15_000))
    railTimer.unref()
  }
  bus.subscribe<{ underlying: string; price: number; ts: number }>('md.spot', (m) => {
    marks.updateSpot(m.payload.underlying, m.payload.price)
  })
  /**
   * How many tokens marketdata subscribed. Without it, readiness can only say
   * "some marks arrived", which reads as ready while 66 of 72 strikes are still
   * unmarked — and an action on any of those is skipped as "no mark".
   *
   * THE WHOLE FRAME IS RETAINED as well, not merely the one field this line
   * used to keep. `desk-marketdata` writes nothing the bridge reads, so this
   * broadcast is the ONLY evidence this process has that it is alive — and the
   * frame already carries the socket states and the instrument-sync day that
   * say what kind of alive. Throwing all of that away and keeping a count meant
   * `/v1/desk/system` had no way to report on the one process it cannot see in
   * the database. Stamped with OUR clock on arrival: a marketdata process with
   * a skewed clock must not be able to report itself fresh.
   */
  const feedHealth: { payload: Record<string, unknown> | null; receivedAt: number | null } = {
    payload: null,
    receivedAt: null,
  }
  bus.subscribe<{ tokens: number }>('md.health', (m) => {
    feedState.subscribedTokens = m.payload.tokens
    feedHealth.payload = m.payload as unknown as Record<string, unknown>
    feedHealth.receivedAt = Date.now()
  })
  // Deliberately NOT awaited: the client reconnects on its own, and blocking
  // startup on the feed would stop the API serving positions during an outage —
  // exactly when someone needs to look at them.
  void bus.ready().then(
    () => log('bus connected', { url: busUrl }),
    (err: unknown) => log('bus not reachable yet, will retry', { url: busUrl, error: String(err) }),
  )

  /**
   * Seed last-known marks so the dashboard shows a book out of hours. Display
   * only — `price()` still refuses them, so nothing can be FILLED at a stale
   * price.
   */
  const loadMarkSnapshot = async (): Promise<void> => {
    try {
      const rows = await mongo.db.collection('desk-marks').find({}).toArray()
      marks.loadSnapshot(
        rows.map((r) => ({
          token: Number(r['token']),
          price: Number(r['price']),
          ts: Number(r['ts']),
          bid: typeof r['bid'] === 'number' ? r['bid'] : null,
          ask: typeof r['ask'] === 'number' ? r['ask'] : null,
          bookTs: typeof r['bookTs'] === 'number' ? r['bookTs'] : null,
        })),
      )
      log('mark snapshot loaded (display only)', { tokens: rows.length })
    } catch (err) {
      log('mark snapshot load failed', { error: String(err) })
    }
  }
  await loadMarkSnapshot()
  const snapTimer = setInterval(() => void loadMarkSnapshot(), 5 * 60_000)
  snapTimer.unref()

  /**
   * NO STRATEGY ROW IS MADE OUT OF THE DECISION JOURNAL.
   *
   * A boot seed stood here until 2026-10-30: every tag in the last 50
   * decisions of each symbol's books that had no `desk-strategies` row was
   * registered external and SWITCHED ON. It was the per-tag gate's migration,
   * so that tags trading before the gate existed (the Python desk's) were not
   * silently 403'd by it. That desk is gone, and every client now trades under
   * a row made on purpose: a book registration (`routes/books.ts`), the
   * Strategies page, or `seedHostedStrategies` further down.
   *
   * So the only tags it still found were rows REMOVED on purpose — the roll's
   * erase of yesterday's books, and `--prune-orphans`. Each restart put them
   * back, switched on with no book behind them: 24 on 2026-10-30, all of them
   * this seed's. A removed row stays removed now. A client trading under a
   * tag with no row is refused (`UnknownStrategy`), loudly, which is the gate
   * doing its job. `test/boot-registry.test.ts` holds this file to it.
   */

  /**
   * The read-only push socket (`GET /v1/desk/stream`).
   *
   * Built BEFORE the rails, because the paper rail pushes its own fills and a
   * rail constructed without the stream would journal them and tell nobody. The
   * REST endpoints are untouched and remain the fallback: this socket makes an
   * update fast, it is not what makes it true.
   */
  const stream = new DeskStream({
    log,
    now: () => Date.now(),
    ...(process.env['DESK_STREAM_HEARTBEAT_MS'] === undefined
      ? {}
      : { heartbeatMs: Number(process.env['DESK_STREAM_HEARTBEAT_MS']) }),
    ...(process.env['DESK_STREAM_PNL_MS'] === undefined
      ? {}
      : { pnlMs: Number(process.env['DESK_STREAM_PNL_MS']) }),
    /**
     * The base a subscriber's deltas are read against, from the SAME
     * `LiveBook.summary` that serves `GET /v1/desk/pnl`. Two producers of the
     * rows on screen would be two things to keep in step with `rollup.ts`'s
     * arithmetic, and the copy that drifts is the one showing a total the P&L
     * page disagrees with.
     *
     * `null` UNTIL THE BOOK HAS LOADED. An unloaded book summarises to an empty
     * desk, and "this desk holds nothing" is the confident-wrong answer the
     * whole `ready` flag exists to avoid. Reads `liveBook` through the closure
     * because the book does not exist yet — the same trick `journal` uses
     * below.
     */
    snapshot: async (mode) => {
      const book = liveBook
      if (book === null || !book.ready) return null
      return (await book.summary(mode, Date.now())).strategies
    },
  })

  /**
   * THE DESK-WIDE RISK LIMITS (audit F-28), and where their inputs come from.
   *
   * `packages/order-bus/src/risk.ts` has carried a daily loss stop, an order
   * rate limit, lot caps and a notional cap — green-tested and imported by
   * NOTHING — while the live path had none of them. This is the wiring, and it
   * is deliberately OPT-IN: `exposureLimitsFromEnv` disables every limit whose
   * `DESK_RISK_*` variable is unset, so a desk that configures nothing gets no
   * gate object at all and behaves exactly as it did before this commit. A
   * variable that is SET but unusable throws here, at boot, rather than quietly
   * leaving the operator with the protection they thought they had asked for.
   *
   * THE MEASUREMENT. `pnlFor` is the same seam `/v1/desk/pnl` and the 15s
   * snapshot read: the in-memory book when it is loaded, Mongo when it is not.
   * So the day loss is TODAY'S P&L for the LIVE rail across every strategy —
   * mark-to-market when every leg is priced (`totals.total`), REALISED ONLY
   * when it is not, because `total` is deliberately null the moment one leg is
   * unmarked or the fill read truncated, and marking half a book would be a
   * confident wrong number. Open lots come from the same summary's legs,
   * converted through the instrument master's lot size.
   *
   * ITS STALENESS, STATED: fills reach the in-memory book at journal time
   * (`LiveBook.onJournal`) and marks move with the feed, so the figure is as
   * fresh as the last tick — except for fills journalled by ANOTHER process,
   * which arrive on the book's 60s reconcile. Plus the cache below.
   *
   * THE CACHE exists because this runs on the order path: a burst of tranches
   * would otherwise each pay for a registry read and a full re-mark. Two
   * seconds bounds that without letting the stop lag a moving book.
   */
  const riskLimits = exposureLimitsFromEnv(process.env)
  const riskWindow = new OrderRateWindow()
  const riskPnlStore = new PnlStore(mongo.db)
  const riskTtlMs = positiveEnvMs('DESK_RISK_EXPOSURE_TTL_MS', 2_000)
  /**
   * THE LOTS THIS PROCESS HAS ALREADY ADMITTED but the measurement above cannot
   * see yet — what stops N decisions inside one TTL window from spending the
   * same headroom N times over (40 open + 10 <= 50, passed three times, ends at
   * 70). See `ReservationLedger`.
   *
   * BELT AND BRACES, and worth saying exactly what it is braces over: fills
   * reach the in-memory book at journal time through `LiveBook.onJournal`,
   * which is SYNCHRONOUS and in this process, so the next measurement does
   * include them. The gap is the CACHE — the two seconds in which there is no
   * next measurement — plus any cross-decision race inside it.
   *
   * 3x the cache's TTL: a reservation has to outlive the stale measurement that
   * cannot see it, and it has to expire on its own so an order that never
   * routed cannot hold capacity for the rest of the session.
   */
  const riskReservations = new ReservationLedger(riskTtlMs * 3)
  let riskMeasured: {
    at: number
    mode: DeskMode
    value: {
      dayLoss: number
      openLotsTotal: number
      openLotsByUnderlying: Record<string, number>
      unmeasuredSymbols: string[]
    }
  } | null = null

  const measureDesk = async (mode: DeskMode): Promise<ExposureState | null> => {
    const now = Date.now()
    const fresh =
      riskMeasured !== null && riskMeasured.mode === mode && now - riskMeasured.at < riskTtlMs
    if (!fresh) {
      try {
        // `routeDeps` and `liveBook` are read through this closure because they
        // do not exist yet — the same trick `journal` uses below. Nothing calls
        // this until an order arrives, long after both are built.
        const summary = await pnlFor(routeDeps, riskPnlStore, {}, mode, now)
        const master = masterProvider.current()
        const counted = measureOpenLots(
          summary.strategies,
          (s) => master.resolveSymbol(s)?.lotSize ?? 0,
        )
        // A held leg that could not be sized makes the whole count an
        // UNDER-count, and the gate refuses new exposure on it. Logged because
        // the fix is an instrument-master one and nobody will look for it
        // otherwise — the refusal names the symbols too.
        if (counted.unmeasuredSymbols.length > 0) {
          log('risk limits: the open position could NOT be fully counted — new exposure refused', {
            mode,
            symbols: counted.unmeasuredSymbols,
          })
        }
        if (!summary.totals.complete && Number.isFinite(riskLimits.maxDailyLoss)) {
          log('risk limits: the day P&L is INCOMPLETE — the loss stop is measuring realised only', {
            mode,
            realised: summary.totals.realised,
            truncated: summary.truncated,
          })
        }
        riskMeasured = {
          at: now,
          mode,
          // Positive number = loss. Mark-to-market when the book is fully
          // priced; realised alone when it is not (see `complete` above).
          value: {
            dayLoss: -(summary.totals.total ?? summary.totals.realised),
            ...counted,
          },
        }
      } catch (err) {
        // NOT a stale answer: a measurement this gate cannot take is reported
        // as unknown, and `screenRiskGate` refuses NEW exposure on it while a
        // limit is configured. Exits are never affected.
        riskMeasured = null
        log('risk limits: the desk could not be measured — new live exposure will be refused', {
          mode,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    }
    const m = riskMeasured
    if (m === null) return null
    // The reservations are folded in on EVERY read, never into the cached
    // value: a cache that grew by its own reservations each time it was read
    // would refuse the whole desk within a few orders.
    const at = Date.now()
    return riskReservations.applyTo(
      { ...m.value, nowMs: at, recentOrderTs: riskWindow.snapshot() },
      at,
    )
  }

  const riskGate: RiskGatePort | undefined = anyExposureLimitSet(riskLimits)
    ? {
        limits: riskLimits,
        exposure: measureDesk,
        record: (nowMs: number) => riskWindow.record(nowMs),
        reserve: (lots: number, underlying: string, nowMs: number) =>
          riskReservations.reserve(lots, underlying, nowMs),
      }
    : undefined
  if (riskGate === undefined) {
    log('risk limits: none configured — the gate is inert (set DESK_RISK_MAX_* to arm it)')
  } else {
    log('risk limits ARMED on the live rail', {
      maxDailyLoss: riskLimits.maxDailyLoss,
      maxOpenLotsTotal: riskLimits.maxOpenLotsTotal,
      maxOpenLotsPerUnderlying: riskLimits.maxOpenLotsPerUnderlying,
      maxNotionalPerOrder: riskLimits.maxNotionalPerOrder,
      maxOrdersPerMinute: riskLimits.maxOrdersPerMinute,
    })
  }

  const service = new BridgeService({
    // The risk limits, on the live rail only and only when configured — the
    // same gate `/v1/desk/submit` gets through `ApiDeps.risk`. Omitted entirely
    // rather than passed as undefined (`exactOptionalPropertyTypes`).
    ...(riskGate === undefined ? {} : { risk: riskGate }),
    store,
    rails: {
      // The bus is the third argument on both rails so a durable gateway-order
      // insert can nudge the gateway awake. Without it the gateway only learns
      // of the order on its idle sweep (DESK_SWEEP_MS, 5s) — tolerable for a
      // recenter book, far too slow for a seconds-cadence one.
      paper: new PaperRail(mongo.db, (mode, event) => stream.publish(mode, event), bus),
      live: new LiveRail(
        mongo.db,
        liveAllowlistFromStrategies(mongo.db.collection('desk-strategies'), livePin),
        'desk-gateway',
        bus,
      ),
    },
    master: masterProvider,
    marks,
    displayMarks: (token) => marks.displayMark(token),
    displayExitQuotes: (token, exit) => marks.displayExitQuote(token, exit),
    displaySpot: (underlying, token) => marks.displaySpot(underlying, token),
    ...(demoMarks === null
      ? {}
      : {
          demoDisplayExitQuotes: (token, exit) => demoMarks.displayExitQuote(token, exit),
          marksVenue: (tag, mode) => rails.venueOf(tag, mode),
        }),
    // Fills reach the in-memory book the moment they are journalled, so a
    // position appears on screen without waiting for the 60s reconcile. Reads
    // `liveBook` through the closure because the book does not exist yet.
    journal: (entry) => liveBook?.onJournal(entry),
    /**
     * Supervisor actions carry no price, and the broker API REJECTS market
     * orders — so without this every delta-management order is refused and the
     * book goes unmanaged. Priced through the mark so it fills at once, with
     * the limit as the worst-case guarantee.
     *
     * Both rails deliberately, so a paper session is a faithful rehearsal of
     * the live one rather than exercising a different order type.
     */
    marketable: marketableFromEnv(),
    /**
     * A mark this old prices no NEW exposure (audit F-16). Ten minutes: far
     * past any real cadence (the slowest measured stock-option strike ticks
     * every ~30s), so it never blocks a live chain, and far short of the
     * "priced at 09:20, ordered at 14:00" resting-limit failure it exists to
     * stop. EXITS ARE NEVER GATED BY IT — see `tooStaleToOpen` in book.ts.
     */
    maxOpenMarkAgeMs: positiveEnvMs('DESK_MAX_OPEN_MARK_AGE_MS', 600_000),
    clock: { now: () => Date.now() },
  })

  // Seed the hosted intraday strategies (Phase C §2). Idempotent, and it never
  // overwrites an operator's switch — a redeploy that silently re-enables
  // something someone turned off would be worse than not seeding at all.
  const hosted = await seedHostedStrategies(store, Date.now(), log)
  if (hosted.added > 0) log('hosted strategies registered', { added: hosted.added })
  if (hosted.cleared > 0) {
    log('cleared the legacy filler disabledReason from seeded rows', { cleared: hosted.cleared })
  }

  // Dev dashboard origins by default; override in production with the real one.
  const allowedOrigins = (process.env['DESK_CORS_ORIGINS'] ??
    'http://localhost:5184,http://127.0.0.1:5184')
    .split(',').map((s) => s.trim()).filter((s) => s !== '')
  log('CORS origins allowed', { origins: allowedOrigins })

  /**
   * One dependency bag, built once, handed to every route module.
   *
   * Adding a feature is adding a file to `routes/` and a line below — it is
   * never an edit to `server.ts`, which is what keeps "who is allowed in"
   * readable in one place.
   */
  const apiDeps: ApiDeps = {
    db: mongo.db,
    store,
    service,
    // Reaches `/v1/desk/submit`'s own SubmitService — one desk, one set of
    // caps, whichever rail an order arrives on. Absent when unconfigured.
    ...(riskGate === undefined ? {} : { risk: riskGate }),
    master: masterProvider,
    marks,
    ...(demoMarks === null
      ? {}
      : { demoMarks, marksVenue: (tag: string, mode: string) => rails.venueOf(tag, mode) }),
    feedState,
    feedHealth,
    busConnected: () => bus.connected,
    stream,
    // `DESK_VENUE`, read once (`venue.ts`). Every day-keyed site reads it here.
    venue: API_VENUE,
    log,
    now: () => Date.now(),
  }

  /**
   * The in-memory book (design doc §Phase 2).
   *
   * Built from `apiDeps` and then FOLDED BACK IN as `routeDeps`, so the routes
   * and the P&L jobs can reach it while the book itself holds a bag that does
   * not contain it. `/v1/desk/pnl` used to rescan 30 days of `desk-decisions` on
   * every poll and the 15s snapshot did it twice more; once this is loaded, both
   * are served from memory and the only database read left on that path is the
   * strategy registry.
   *
   * NOT AWAITED. A bridge that could not open its port until Mongo answered
   * would be down during exactly the outage someone opened the dashboard to look
   * at — the same reasoning as the bus connect above. Until the load lands,
   * `ready` is false and every reader takes the REST path it always took.
   */
  liveBook = new LiveBook({
    deps: apiDeps,
    store: new PnlStore(mongo.db),
    stream,
    log,
    now: () => Date.now(),
    ...(process.env['DESK_BOOK_RECONCILE_MS'] === undefined
      ? {}
      : { reconcileMs: Number(process.env['DESK_BOOK_RECONCILE_MS']) }),
  })
  const book = liveBook
  void book.start().catch((err: unknown) =>
    log('live book failed to start — P&L stays on the REST path', {
      error: err instanceof Error ? err.message : String(err),
    }),
  )
  const routeDeps: ApiDeps = { ...apiDeps, book }

  const gate = createAuthGate({ ...routeDeps, token })
  const stopPnlJobs = startPnlJobs(routeDeps)

  /**
   * THE DAY GUARD — per-strategy daily target and stop-loss (`day-guard.ts`).
   *
   * Started unconditionally: it costs nothing on a desk where no row has
   * limits set (the pass returns before it reads any P&L), and making it
   * conditional would mean arming a strategy's stop-loss from the dashboard and
   * having it do nothing until someone restarted the bridge.
   *
   * It rides `routeDeps`, so it reads P&L through the same in-memory book the
   * cards do — the number that stops a strategy is the number on screen.
   */
  const stopDayGuard = startDayGuard(routeDeps, {
    intervalMs: positiveEnvMs('DESK_DAY_GUARD_MS', 10_000),
  })

  /**
   * BROKER TRUTH, JOINED BACK ONTO THE DESK (audit F-2).
   *
   * The bridge books a fill at rail-write time, at the full requested size —
   * that is all it knows at that line. This is the pass that goes back and
   * makes the record say what the broker actually did: a REJECTED order is
   * un-booked, a PARTIAL is restated, and the phantom leg is folded off
   * `desk-books`. Without it, a margin-403 on a recenter leg leaves a leg no
   * order backs, and tomorrow's `close-all` sends a real order against it.
   *
   * Started unconditionally and unrefed: it reads only `desk-gateway-orders`,
   * which is empty on a paper-only or legacy-executor deployment, so there is
   * no mode to get wrong. See `reconcile-live.ts` for the prime directives.
   */
  const stopReconcile = startLiveReconciler(
    {
      store,
      master: () => masterProvider.current(),
      notify: (mode, event) => stream.publish(mode, event),
      now: () => Date.now(),
      log,
    },
    {
      ...(process.env['DESK_RECONCILE_MS'] === undefined
        ? {}
        : { intervalMs: Number(process.env['DESK_RECONCILE_MS']) }),
      ...(process.env['DESK_RECONCILE_LOOKBACK_MS'] === undefined
        ? {}
        : { lookbackMs: Number(process.env['DESK_RECONCILE_LOOKBACK_MS']) }),
      ...(process.env['DESK_RECONCILE_BATCH'] === undefined
        ? {}
        : { batchSize: Number(process.env['DESK_RECONCILE_BATCH']) }),
    },
  )

  /**
   * THE PAPER FILL, BOOKED WHEN IT HAPPENS (D14) — `paper-fold.ts`.
   *
   * The reconciler above joins LIVE order outcomes back onto a book that was
   * already written optimistically. This pass is the other shape entirely: an
   * engine PAPER decision writes NO book at all, because its orders are worked
   * through the gateway exactly as live ones are and nothing has traded at the
   * moment of the request. This is what folds each fill in when a tick actually
   * crosses the order, settles the decision, and nudges the supervisor.
   *
   * FAST, deliberately: the supervisor holds a decision `inFlight` until its
   * fills are accounted for, so this interval is the floor on how long a paper
   * book waits between deciding and knowing.
   *
   * Started unconditionally and unrefed: on a desk running no engine paper book
   * it is one indexed query against a collection with no `mode: 'paper'` rows
   * in it, and there is no mode to get wrong — the scope is in the query.
   */
  const stopPaperFold = startPaperFillFolder(
    {
      store,
      master: () => masterProvider.current(),
      notify: (mode, event) => stream.publish(mode, event),
      // The SAME hook `BridgeService` is given, so a fill folded here reaches
      // the in-memory book exactly as one folded at route time does.
      journal: (entry) => liveBook?.onJournal(entry),
      now: () => Date.now(),
      log,
    },
    { intervalMs: positiveEnvMs('DESK_PAPER_FOLD_MS', 2_000) },
  )

  /**
   * ONE POSITION TRUTH (audit roadmap 16) — `positions-compare.ts`.
   *
   * The reconciler above joins ORDER outcomes back onto the desk. This asks the
   * other question, which nothing asked before it: are the POSITIONS the desk
   * believes it holds the positions the broker is actually holding? Three
   * records, three processes, never once compared — and a fill that was never
   * journalled, a hand-edited leg or a manual trade on the same account
   * produces no gateway order for the reconciler to see.
   *
   * IT REPORTS AND NOTHING ELSE. There is no repair path behind it — the port
   * interface in that file is the guarantee — and its honesty rules are worth
   * repeating here: a `desk-books` leg matching a broker position is the
   * EXPECTED state, a broker row the desk cannot attribute is a fact rather
   * than a fault, and an unreadable broker view produces no verdict at all.
   *
   * Started unconditionally: on a desk with no live book and no xts gateway it
   * reads three empty sources and publishes a report saying so.
   */
  const positionsCompare = startPositionsCompare(routeDeps, {
    intervalMs: positiveEnvMs('DESK_POSITIONS_COMPARE_MS', 300_000),
  })
  /**
   * THE DEMO RAIL'S COMPARISON (DX only): paper books on `dx_paper_rail: 'demo'`
   * against Delta's testnet account. Reported on Status as "Positions truth —
   * demo"; it never journals and never feeds mirror sync.
   */
  const positionsCompareDemo = API_VENUE.id === 'dx'
    ? startPositionsCompare(routeDeps, {
        intervalMs: positiveEnvMs('DESK_POSITIONS_COMPARE_MS', 300_000),
        rail: 'demo',
      })
    : null

  /**
   * MIRROR POSITION SYNC — the detector half (`mirror-sync.ts`).
   *
   * The comparison above found the 2026-08-18 phantom (a cancelled order left
   * the mirror ledger at −65 while the broker held 0) and could only report
   * it; the repair was a hand-run clear. This job turns exactly that shape —
   * a divergence claimed by ONE mirror tag, no desk book on the contract,
   * confirmed on two consecutive passes, no order in flight — into a
   * correction REQUEST parked in `desk-strategy-state`, which the RUNNER
   * consumes on its own cadence through the `PositionLedger` it owns. The
   * bridge detects, the runner applies: the same single-writer split as the
   * clear-request, and this process still never writes a ledger.
   *
   * IT RIDES THE SAME COMPARER INSTANCE as the interval and the route above —
   * one single-flight guard, one `last()` cache, and the divergence it repairs
   * is the one on the operator's screen. Kill switch:
   * DESK_MIRROR_SYNC_DISABLED, read on every pass.
   */
  const mirrorSync = startMirrorSync(routeDeps, positionsCompare.comparer, {
    intervalMs: positiveEnvMs('DESK_MIRROR_SYNC_MS', 60_000),
  })

  const server = createBridgeServer({
    gate,
    log,
    allowedOrigins,
    // The upgrade goes through `gate.authenticate` like everything else — the
    // browser attaches the session cookie to a handshake exactly as it does to
    // a fetch. See `server.ts:upgrade`.
    stream,
    // Unauthenticated. Health, feed readiness, and login itself.
    publicRoutes: [healthRoutes(routeDeps), authRoutes(routeDeps)],
    routes: [
      deskRoutes({ ...routeDeps, gate }),
      brokerRoutes(routeDeps),
      // AUTHENTICATED, unlike `/health` and `/v1/desk/feed`: this one names
      // every process, its cadence and its broker session state, which is a map
      // of the desk for anyone who can reach the port.
      systemRoutes(routeDeps),
      pnlRoutes(routeDeps),
      // READ-ONLY, and structurally so: the cockpit prices, ranks and explains;
      // it never routes an order. Its one outbound call is `verify-margin`,
      // which asks desk-marketdata to price a plan against Kite's basket
      // CALCULATOR — an endpoint that quotes orders and cannot place them, in
      // the only process holding a Kite session. See `routes/payoff.ts`.
      payoffRoutes(routeDeps),
      // THE REPAIR APPLY BUTTON, kept out of `payoff.ts` so that file's
      // structural claim — no rail in it to reach — stays true of it. Preview,
      // place and watch: preflight resolves a candidate's moves into the orders
      // they WOULD be and prices each by walking the book; apply re-resolves
      // them server-side and sequences them through the desk's own
      // `SubmitService`. See `routes/repair.ts`.
      //
      // The gate rides along for the reason `deskRoutes` and `booksRoutes`
      // carry it: a LIVE apply re-authenticates, exactly like arming a live
      // strategy does, through that same one definition of "prove a person is
      // at the keyboard".
      repairRoutes({ ...routeDeps, gate }),
      reportRoutes(routeDeps),
      submitRoutes(routeDeps),
      // THE RECENTER SUPERVISOR'S ONE WAY IN. Instruments and share quantities
      // rather than the Python desk's leg tags, and the decision endpoint is
      // MACHINE PRINCIPALS ONLY — but the same `applyDecision` underneath, so
      // there is exactly one gate stack, one idempotency claim and one book
      // fold on this desk.
      //
      // The gate rides along for the OTHER endpoint in that module: the
      // operator's Protect control writes into supervisor state, and on the
      // live rail that re-authenticates exactly like a dials retune. See
      // `routes/engine.ts`.
      engineRoutes({ ...routeDeps, gate }),
      // The gate rides along for the same reason deskRoutes carries it: the
      // dials PATCH on a LIVE book re-auths, exactly like the live switch.
      booksRoutes({ ...routeDeps, gate }),
      runnerRoutes({ ...routeDeps, gate }),
      // The comparer rides along so the endpoint serves the SAME instance the
      // interval drives: one single-flight guard, one last result.
      positionsRoutes({ ...routeDeps, compare: positionsCompare.comparer }),
      streamRoutes({ stream }),
    ],
  })
  server.listen(port, () => log(`listening on :${port}`))

  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`)
    stopPnlJobs()
    stopDayGuard()
    stopReconcile()
    stopPaperFold()
    positionsCompare.stop()
    positionsCompareDemo?.stop()
    mirrorSync.stop()
    // Called directly rather than through `start`'s return value: a SIGTERM
    // arriving before the boot read lands must still stop the reconcile that
    // read is about to schedule.
    book.stop()
    // Sockets first: `server.close()` waits for open connections, and an
    // upgraded websocket never ends on its own — a restart would sit there
    // until the kill timeout on every deploy.
    void stream.close()
    server.close(() => {
      void mongo.close().then(() => process.exit(0))
    })
    // Do not let a hung connection hold the process open through a restart.
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// Only run when executed directly, so tests can import without booting a server.
// Compared as resolved paths: matching on basename alone would also fire when
// some OTHER main.ts is the entry point and this module is merely imported.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error('[bridge] fatal', err)
    process.exit(1)
  })
}
