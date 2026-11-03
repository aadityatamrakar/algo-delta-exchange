/**
 * Hosted strategy runner — process entry point.
 *
 * Boots unconditionally. Gating boot behind market hours is the 2026-07-06 bug
 * (`packages/strategy-kit/src/base.ts:105`): a pm2 restart at 09:15:30 has to
 * come up ready, not asleep. Only the per-strategy START is time-gated, by the
 * row's own `autostartAt`.
 *
 * WHAT THIS PROCESS IS: one loop, one Kite-feed subscription (over the bus, so
 * it does not hold a second Kite login), and N strategies. The legacy system ran
 * ~150 processes each with its own websocket and its own LoopBack boot. Here the
 * strategies are objects.
 *
 * WHAT IT IS NOT: an order router. It has no broker credentials and no write
 * access to any order collection. Every order is an HTTP POST to
 * `/v1/desk/submit`, so the strategy switch, the kill switch, the live
 * allowlist and the freeze split apply to hosted strategies exactly as they do
 * to the Python desk. If this process is compromised or buggy, it still cannot
 * place an order the bridge would refuse.
 */

import { connectWithRetry, installCrashGuards, systemClock } from '@algomaker/core'
import { WsTransportClient } from '@algomaker/bus'
import { OptionMaster } from '@algomaker/instruments'
import type { InstrumentRow } from '@algomaker/instruments'
import type { Logger, Quote, StrategyContext } from '@algomaker/strategy-kit'
import { connectMongo } from '../../api/src/mongo.ts'
import { strategyFromDoc } from '../../api/src/strategies.ts'
import { loadStoredInstruments } from '../../marketdata/src/sync-runner.ts'
import {
  ensureSubscriptionIndexes,
  publishSubscription,
  RUNNER_SUBSCRIPTION_SOURCE,
  SUBSCRIPTION_COLLECTION,
} from '../../marketdata/src/subscription-store.ts'
import { CATALOGUE } from './catalogue.ts'
import { heldLegTokens } from './held-tokens.ts'
import { HttpHistoryFetcher } from './history.ts'
import { RunnerMarketData, type DeclaredSeries } from './market-data.ts'
import {
  clearRequestTtlMs,
  HttpOrderGateway,
  istDateOf,
  PositionLedger,
  sweepClearRequests,
  syncRequestTtlMs,
  type DroppedEntry,
} from './order-gateway.ts'
import {
  instanceKey,
  Runner,
  type HostedInstance,
  type HostedRow,
  type StrategyFactory,
} from './runner.ts'
import { MongoStateStore, STATE_COLLECTION } from './state-store.ts'
import { ensureRuntimeIndexes, runtimePublisher, RUNTIME_COLLECTION } from './runtime.ts'

/** Cadence of the lifecycle loop. Cron resolution is one second, so this is it. */
const TICK_MS = 1_000
/** How often the registry is re-read, so a portal toggle takes effect. */
const SYNC_MS = 15_000
/** How often instrument master + chain windows are refreshed. */
const REFRESH_MS = 15 * 60_000

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`)
  return v
}

function makeLogger(): Logger {
  const emit =
    (level: string) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`
      console.log(`[runner] ${new Date().toISOString()} ${level} ${line}`)
    }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}

export async function main(): Promise<void> {
  const log = makeLogger()
  /**
   * FIRST LINE OF MAIN, and shared with the gateway rather than copied (audit
   * F-41). The gateway learned both of these the hard way — G4: an unhandled
   * rejection is fatal on Node 24, so one Mongo blip inside a `void` call took
   * the process down mid-session; G6: a boot that EXITS on an unreachable Mongo
   * burns pm2's restart budget in ~70 seconds and never comes back when Mongo
   * does. This process has exactly the same shape: `void`-fired intervals
   * everywhere, and a boot that used to await a bare `connectMongo`.
   *
   * Worth stating for THIS process specifically: it holds the only durable
   * record of a hosted position, and the 15:30 square-off lives in its tick
   * path. A runner that dies of a rejected promise at 11:40 is a book with
   * nothing managing it.
   */
  installCrashGuards({ process, log: (msg, ctx) => log.error(msg, ctx) })
  const mongoUrl = required('DESK_MONGO_URL')
  const token = required('DESK_API_TOKEN')
  const apiUrl = process.env['DESK_API_URL'] ?? 'http://127.0.0.1:8890'
  const busUrl = process.env['DESK_BUS_URL'] ?? 'ws://127.0.0.1:8891'
  const marketDataUrl = process.env['DESK_MD_URL'] ?? 'http://127.0.0.1:8892'

  const mongo = await connectWithRetry(() => connectMongo(mongoUrl), {
    log: (msg, ctx) => log.warn(msg, ctx),
    what: 'mongo',
  })
  const stateCollection = mongo.db.collection(STATE_COLLECTION)
  await MongoStateStore.ensureIndexes(stateCollection)
  await ensureRuntimeIndexes(mongo.db.collection(RUNTIME_COLLECTION))
  const subscriptionCollection = mongo.db.collection(SUBSCRIPTION_COLLECTION)
  await ensureSubscriptionIndexes(subscriptionCollection)

  /**
   * The instrument dump, kept as ROWS as well as an `OptionMaster`.
   *
   * `OptionMaster` answers by (underlying, expiry, strike) and hands back an
   * `InstrumentRef`, which carries no expiry — so a leg booked from one cannot
   * be dated, and an undated leg can never be swept when its contract dies
   * (audit F-6a). The rows do carry it, so one flat `tradingsymbol -> expiry`
   * index is built beside the master and refreshed with it.
   */
  let instrumentRows = await loadStoredInstruments(mongo.db.collection('instrument'))
  let master = new OptionMaster(instrumentRows)
  let expiryBySymbol = expiryIndex(instrumentRows)
  log.info('instrument master loaded', {
    contracts: master.optionCount,
    dated: expiryBySymbol.size,
  })

  const md = new RunnerMarketData({
    master: () => master,
    clock: systemClock,
    log,
    staleAfterMs: Number(process.env['DESK_FEED_STALE_AFTER_MS'] ?? 15_000),
    /**
     * WITHOUT THIS EVERY SERIES STARTS COLD. `seed()` is a no-op when no
     * fetcher is injected, so `ATR_BAND_NIFTY` — which needs `atrPeriod`
     * COMPLETED hourly bars — had them at 09:15 plus fifteen hours, i.e. never,
     * and spent every session logging "not enough hourly candles, retrying in
     * 30s". The runner deliberately holds no broker credentials, so the bars
     * come over HTTP from `apps/marketdata`, which holds the one Kite login.
     */
    history: new HttpHistoryFetcher({ baseUrl: marketDataUrl, token, log }),
  })

  /**
   * Declare EVERY catalogue strategy's data needs, seed what became live, and
   * publish the resulting token set for `apps/marketdata` to subscribe.
   *
   * THE PUBLISH IS THE FIX FOR THE RUNNER GETTING NO DATA AT ALL.
   * `md.subscriptionSet()` existed and its only caller in the repo was its own
   * test; `apps/marketdata` built its plan purely from the Python desk's open
   * books, so NIFTY/BANKNIFTY/SENSEX were never subscribed. Nothing looked
   * broken — BHEL kept ticking, so the feed health endpoint stayed green — but
   * `isTrustworthy()` was false all session, `canEnter()` blocked every entry,
   * and no option token could ever be declared because a chain window cannot be
   * centred without spot.
   *
   * EVERY catalogue entry, not just the running ones. Two reasons: a chain
   * window needs spot to have ARRIVED before it can be centred, so an
   * instrument declared only at 09:16 when its strategy starts has no chain
   * until the following pass; and history seeding wants to happen before the
   * strategy's first job, not during it. Declaring is idempotent per tag and
   * `handleTick` still routes only to RUNNING instances, so the cost is
   * subscriptions we would want a few minutes later anyway.
   */
  const declareAll = async (): Promise<void> => {
    const newSeries: DeclaredSeries[] = []
    for (const [tag, entry] of CATALOGUE) {
      newSeries.push(...md.declare(tag, entry.dataNeeds).newSeries)
    }
    /**
     * THE CATALOGUE'S NEEDS, UNION WHAT IS ACTUALLY HELD.
     *
     * `subscriptionSet()` is a chain window centred on spot. A leg outside it
     * was never subscribed, never ticked and could not be marked — a mirror
     * following upstream to any strike, or a leg carried while spot moved
     * away. On 2026-09-07 MIRROR_A010's NIFTY 24050 CE/PE and BULL_SNX_1's
     * SENSEX 76700 CE/PE all read `no mark` while every leg inside the window
     * marked one minute old.
     *
     * THAT IS NOT A DISPLAY NIT. An unmarked OPEN leg puts the contract into
     * `unpriced`, which makes the tag's whole total unknown rather than a
     * number — the desk cannot say what a book is worth because it is not
     * listening to part of it.
     */
    const held = heldLegTokens([...ledgers.values()].flatMap((l) => l.open()), instrumentRows)
    if (held.unresolved.length > 0) {
      // NEVER SILENT. A held leg with no resolvable token cannot be subscribed
      // by anyone, so it stays unmarkable until a human looks at it.
      log.warn('runner: held legs have NO instrument token, so they cannot be marked', {
        symbols: held.unresolved.join(','),
      })
    }
    const tokens = [...new Set([...md.subscriptionSet().map((s) => s.token), ...held.tokens])]
    try {
      await publishSubscription(
        subscriptionCollection,
        RUNNER_SUBSCRIPTION_SOURCE,
        tokens,
        Date.now(),
      )
    } catch (err) {
      // Loud: a failure here means the feed will not be subscribed to anything
      // this process needs, which presents as a strategy that never enters
      // rather than as an error.
      log.error('runner: could NOT publish its subscriptions — the feed will not carry its tokens', {
        error: err instanceof Error ? err.message : String(err),
        tokens: tokens.length,
      })
    }
    // AFTER the publish, not before. `seed()` is paced to Kite's ~3 req/s
    // history throttle, so a boot batch (~150 series) takes ~50s; the feed
    // must not wait that long to learn which tokens to carry.
    await md.seed(newSeries)
  }

  /**
   * Ledgers live OUTSIDE the strategy instances, keyed by TAG AND MODE, because
   * the runner rebuilds a strategy on every new session while the position it
   * may still be carrying is the thing that must not be rebuilt.
   *
   * THE MODE IS PART OF THE KEY, and it is not an optimisation. A row switched
   * on for both rails runs two strategies against the same instrument; one
   * ledger between them would net a paper long against a live short into
   * nothing, so `openCount` would read flat and the EOD backstop would place no
   * exit at all while a real position sat at the broker. Even when they do not
   * net, the flatten would reverse legs on whichever rail it was asked for —
   * fictional exits on one side, unclosed risk on the other. Same reason the
   * gateways below are keyed the same way.
   */
  const ledgers = new Map<string, PositionLedger>()
  /**
   * ONE state store per instance, shared by the ledger, the gateway's held ids
   * and the clear-request reader.
   *
   * `MongoStateStore` is stateless — it is a scope plus a collection — so
   * sharing one is free, and it keeps the scope string from being written out
   * three times and getting it wrong once.
   */
  const states = new Map<string, MongoStateStore>()
  const stateFor = (tag: string, mode: 'paper' | 'live'): MongoStateStore => {
    const key = instanceKey(tag, mode)
    let s = states.get(key)
    if (s === undefined) {
      // The state scope is the SAME `tag:mode` key: `MongoStateStore` namespaces
      // by whatever string it is given, and giving it the bare tag would put the
      // two instances' `runner:positions` documents — and every key a strategy
      // persists for `onRecover()` — on top of each other.
      s = new MongoStateStore(stateCollection, key)
      states.set(key, s)
    }
    return s
  }
  const ledgerFor = (tag: string, mode: 'paper' | 'live'): PositionLedger => {
    const key = instanceKey(tag, mode)
    let l = ledgers.get(key)
    if (l === undefined) {
      l = new PositionLedger(stateFor(tag, mode))
      ledgers.set(key, l)
    }
    return l
  }

  /**
   * Load every ledger BEFORE anything can trade, and await it.
   *
   * `load()` replaces the ledger wholesale, so a `void ledger.load()` fired
   * from inside the (synchronous) factory races the first `apply()`: a
   * catch-up order booked while the read is in flight is erased by it, and the
   * ledger is the ONLY durable record of a hosted position — the thing the EOD
   * flatten and the kill switch both read. Doing it here, once, before the
   * runner exists, removes the race rather than narrowing it; `PositionLedger`
   * now throws if anyone reintroduces a late load.
   */
  // BOTH modes for every tag, whether or not the row is currently switched on
  // for them: a position left open by a mode that has since been switched off
  // is exactly the one nothing else will ever close, and the ledger has to be
  // loaded before `sync()` can stop that instance and flatten it.
  for (const tag of CATALOGUE.keys()) {
    for (const mode of ['paper', 'live'] as const) await ledgerFor(tag, mode).load()
  }
  log.info('position ledgers loaded', {
    instances: ledgers.size,
    open: [...ledgers].filter(([, l]) => l.openCount > 0).map(([k]) => k).join(',') || 'none',
  })

  /**
   * SWEEP EVERY LEDGER OF CONTRACTS THAT HAVE EXPIRED (audit F-6a).
   *
   * On 2026-08-10 `MIRROR_A006` was found holding three SENSEX legs from the
   * 6 Aug expiry. No exit could ever arrive for them: the contracts were gone
   * from the instrument master, so the symbols were unroutable; `MirrorHost`
   * squares nothing off by design; the MIRROR rows are withheld from `Runner`
   * below, so the EOD backstop never saw them; and `flattenTag` rebuilds
   * positions from `desk-fills`, which has no mirror rows at all. They were
   * permanent, and the only way out was stopping the process and editing Mongo.
   *
   * It runs at BOOT (after every ledger is loaded, before anything can trade)
   * and at the DAY ROLL, and it is deliberately conservative: only an entry
   * with a RECORDED expiry strictly before today's IST date is dropped. An
   * entry with no expiry is left alone forever, because dropping a leg the
   * upstream account still holds books its eventual exit against an empty
   * ledger and opens a phantom position the other way.
   *
   * EVERY DROP IS LOUD. This is the only record that a position left the books
   * without an order.
   */
  const sweepExpired = async (todayIst: string, when: string): Promise<void> => {
    for (const [instance, ledger] of ledgers) {
      let dropped: readonly DroppedEntry[]
      try {
        dropped = await ledger.dropExpired(todayIst)
      } catch (err) {
        log.error(`runner: expiry sweep FAILED for ${instance} — stale legs may remain`, {
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      for (const d of dropped) {
        log.error(
          `runner: expired leg swept from ${instance}: ${d.tradingsymbol} lots ${d.lots} — ` +
            'no exit can ever arrive for an expired contract',
          { instance, symbol: d.tradingsymbol, lots: d.lots, expiry: d.expiry, when, todayIst },
        )
      }
    }
  }

  /**
   * Apply any operator clear-request, through the ledger this process owns.
   *
   * THE RUNNER DOES THE WRITE, and that is the whole design. `ledgerFor` caches
   * one `PositionLedger` per instance for the life of the process and every
   * `#save()` rewrites the entire document, so a `runner:positions` edited from
   * anywhere else is silently undone by the next booked order — which is why
   * clearing a stuck leg used to mean "stop desk-runner, edit Mongo, start", in
   * that order, costing a restart of every hosted strategy. The bridge's
   * `POST /v1/desk/runner/positions/clear` now writes a REQUEST document
   * instead; this pass consumes it on the sync cadence. Single writer, no
   * restart, and the operator's name is in the journal.
   *
   * IT IS DRIVEN BY THE COLLECTION, NOT BY `ledgers`. The map holds the
   * CATALOGUE, and the bridge accepts a clear for any instance whose
   * `runner:positions` document exists — including a tag that has since been
   * retired from the catalogue. Iterating the map meant such a request was never
   * consumed: it stayed armed until the tag was re-added, and then fired, at
   * `symbols: 'all'`, against whatever the book held that day. `sweepClearRequests`
   * scans for parked requests instead, routes the hosted ones through the cached
   * ledger and edits a retired instance's document directly (safe precisely
   * because nothing is holding it), and expires anything older than the TTL.
   *
   * THE SAME SWEEP CONSUMES THE BRIDGE'S MIRROR-SYNC REQUESTS — the broker-truth
   * corrections the divergence detector files under `runner:sync-request` —
   * because they need exactly what the clear needed: the write has to happen in
   * this process, through the cached ledger, or it is undone by the next booked
   * order. Per instance the CLEAR is consumed first, so an operator's explicit
   * drop is never overridden by an auto-correction in the same tick (the
   * detector re-files within the minute if a real divergence still stands).
   */
  const clearTtlMs = clearRequestTtlMs()
  const syncTtlMs = syncRequestTtlMs()
  const processClearRequests = async (todayIst: string): Promise<void> => {
    await sweepClearRequests({
      collection: stateCollection,
      ledgers,
      /**
       * `MongoStateStore` is stateless, so the cache is only there to keep the
       * scope string from being written out twice; a retired instance passing
       * through it is free.
       *
       * THE SCOPE IS THE DOCUMENT'S OWN STRING when it does not round-trip
       * through `splitInstance` — a hand-written scope with no `:mode` suffix
       * would otherwise be looked up under a truncated one, where the request is
       * not, and would never be consumed or expired.
       */
      stateFor: (instance) => {
        const [tag, mode] = splitInstance(instance)
        return instanceKey(tag, mode) === instance
          ? stateFor(tag, mode)
          : new MongoStateStore(stateCollection, instance)
      },
      todayIst,
      nowMs: Date.now(),
      ttlMs: clearTtlMs,
      syncTtlMs,
      log,
    })
  }

  await sweepExpired(istDateOf(Date.now()), 'boot')

  /**
   * The underlying every order from this tag is keyed on, or null.
   *
   * A catalogue strategy trades ONE underlying and states it, so the freeze
   * table is keyed exactly rather than derived. (null, which tells
   * `HttpOrderGateway` to let the bridge derive it per symbol, was the signal
   * mirrors' answer; none are hosted now.)
   *
   * Any other tag is a hard error: it has no implementation here, so an order
   * under it would be one nothing in this process ever built.
   */
  const underlyingFor = (tag: string): string | null => {
    const entry = CATALOGUE.get(tag)
    if (entry !== undefined) return entry.underlying
    throw new Error(`${tag}: no hosted implementation, cannot place orders`)
  }

  /**
   * Order gateways, keyed by tag AND MODE.
   *
   * The mode is fixed into a gateway at construction and goes out on every
   * submit, so a live -> paper switch in the portal must not reuse the live
   * one. Keying on both is what makes `Runner`'s square-off backstop able to
   * ask for a specific rail: it flattens a position on the rail that position
   * was opened on, because reversing a live position through the paper rail
   * would book a fictional exit and leave the real one at the broker.
   */
  const gateways = new Map<string, HttpOrderGateway>()
  const gatewayFor = (tag: string, mode: 'paper' | 'live'): HttpOrderGateway => {
    const key = instanceKey(tag, mode)
    let g = gateways.get(key)
    if (g === undefined) {
      g = new HttpOrderGateway({
        baseUrl: apiUrl,
        token,
        tag,
        mode,
        underlying: underlyingFor(tag),
        clock: systemClock,
        log,
        ledger: ledgerFor(tag, mode),
        /**
         * The SAME `tag:mode` scope as the ledger and the strategy's state.
         * The unresolved-id map is per instance for the same reason everything
         * else here is: an id held for the live rail must never be replayed on
         * behalf of the paper one.
         */
        state: stateFor(tag, mode),
        /**
         * The contract's expiry, off the instrument dump, recorded on the
         * ledger entry so a dead contract can be swept (audit F-6a).
         * `InstrumentRef` carries no expiry; null means the dump has not got
         * this symbol, and an undated entry is never swept.
         */
        expiryOf: (instrument) => expiryBySymbol.get(instrument.tradingsymbol) ?? null,
        /**
         * The runner's own last-seen price, for the ledger and for a late
         * flatten. `RunnerMarketData` keeps the last quote per token
         * indefinitely rather than expiring it, which is precisely what makes
         * it usable at 15:33 when the bridge's 120-second mark cache is empty.
         */
        markOf: (instrument) =>
          instrument.instrumentToken === undefined
            ? null
            : (md.quote(instrument.instrumentToken)?.lastPrice ?? null),
      })
      gateways.set(key, g)
    }
    return g
  }

  /**
   * Load every gateway's held `clientOrderId`s BEFORE anything can trade, for
   * exactly the reason the ledgers are loaded above.
   *
   * A held id belongs to a submission whose outcome is UNKNOWN — the claim may
   * be live at the broker. Until this read completes, `#idFor` mints a fresh id
   * for that intent, which is new to the bridge's unique index and therefore
   * ROUTES: the strategy ends up holding twice what it asked for while its
   * ledger shows one. The window is worst immediately after a crash, which is
   * exactly when this process is starting.
   */
  for (const tag of CATALOGUE.keys()) {
    for (const mode of ['paper', 'live'] as const) await gatewayFor(tag, mode).load()
  }
  const held = [...gateways].filter(([, g]) => g.unresolvedCount > 0).map(([k]) => k)
  log.info('order gateways loaded', {
    instances: gateways.size,
    unresolved: held.join(',') || 'none',
  })

  /**
   * Build a strategy for ONE INSTANCE — one registry row on one rail.
   *
   * The REGISTRY row decides which modes exist, not the strategy's own
   * `rail.mode`: the config records where a strategy is eventually meant to
   * run, the row records what the operator has actually authorised today, and
   * the operator wins. When both are authorised this is called twice for the
   * same tag, and the two calls must share NOTHING mutable.
   */
  const factory: StrategyFactory = {
    create(inst: HostedInstance) {
      const entry = CATALOGUE.get(inst.tag)
      if (entry === undefined) return null

      /**
       * The state scope is `tag:mode`, NOT the bare tag.
       *
       * `MongoStateStore` namespaces every key by the string it is given, and
       * `onRecover()` rebuilds an open position out of it. Two instances
       * sharing a scope would have the live one recover the paper one's
       * position — it would then manage, and eventually flatten, a position
       * that does not exist on its rail, placing a real order against nothing.
       * `state-store.ts` documents the same rule for two strategies of one
       * class; a strategy and itself on another rail is the same hazard.
       */
      const state = stateFor(inst.tag, inst.mode)
      const gateway = gatewayFor(inst.tag, inst.mode)

      const ctx: StrategyContext = {
        // The REGISTRY tag, not the config's legacy tag — every gate on the
        // bridge keys on this one. It is deliberately NOT the instance key: the
        // bridge gates on `tag` + the `mode` the order states, so a tag with a
        // mode glued onto it would match no registry row at all.
        tag: inst.tag,
        clock: systemClock,
        md,
        orders: gateway,
        // No fill stream on the submit path yet: fills are correlated by
        // apps/order-gateway against `clientOrderId` and written to
        // `desk-fills`. Handing strategies a stream that never emits is
        // honest — `onFill` is optional and none of the 14 ported classes
        // depends on it — where synthesising fills from submissions would be a
        // lie the strategy could not tell apart from a real one.
        fills: { onFill: () => () => {} },
        state,
        log,
        mode: inst.mode === 'live' ? 'live' : 'sim',
        destinations: inst.mode === 'live' ? ['xts'] : ['sim'],
        feed: md,
      }

      // Declare data needs before the strategy runs, so its first pull finds a
      // warm series rather than an empty one. Declared under the TAG, not the
      // instance key: the two instances want the same tokens, `declare` is
      // idempotent per tag, and `md.routesFor` fans a tick out to both through
      // `Runner.handleTick`.
      const declared = md.declare(inst.tag, entry.dataNeeds)
      void md.seed(declared.newSeries)
      // The ledger is NOT loaded here. It is loaded once at boot, awaited —
      // see the comment on the preload above.

      log.info(`runner: built ${inst.tag}`, {
        configTag: entry.configTag,
        underlying: entry.underlying,
        mode: inst.mode,
        tokens: declared.tokens.length,
      })
      return entry.build(ctx)
    },
  }

  /**
   * The registry, read through `strategyFromDoc` — the BRIDGE's own reader.
   *
   * `runner.ts` stays decoupled from `apps/api` on purpose, but this file is
   * the composition root and already reaches across for `mongo.ts`. The
   * forward-mapping of the legacy `enabled` + `mode` pair onto `modes` is a
   * safety-critical rule (an unreadable row must land off in both), and two
   * copies of it would eventually disagree — at which point the runner would
   * start a strategy the bridge then refuses every order from, or worse, would
   * not start one the bridge is happily authorising.
   */
  const loadRegistryRows = async (): Promise<HostedRow[]> => {
    const docs = await mongo.db.collection('desk-strategies').find({}).toArray()
    const rows: HostedRow[] = []
    for (const d of docs) {
      const r = strategyFromDoc(d)
      if (r === null) continue
      rows.push({
        tag: r.tag,
        kind: r.kind,
        modes: r.modes,
        liveLots: r.liveLots,
        autostartAt: r.autostartAt,
      })
    }
    return rows
  }

  const runner = new Runner({
    clock: systemClock,
    log,
    factory,
    loadRows: loadRegistryRows,
    positions: {
      // Per INSTANCE. `ledgerFor` is keyed `tag:mode`, so the live instance's
      // count can never be answered out of the paper instance's ledger.
      openCount: (tag, mode) => ledgerFor(tag, mode).openCount,
      // The square-off backstop. `mode` is the runner's statement of which rail
      // the position it is closing was opened on, and it is honoured verbatim:
      // deriving it from the registry row here would flatten a live position
      // through the paper rail the moment an operator toggled the switch.
      flattenAll: async (tag, mode, reason) => {
        await gatewayFor(tag, mode).flattenAll(reason)
      },
    },
    publish: runtimePublisher(mongo.db.collection(RUNTIME_COLLECTION), 'runner'),
  })

  // --- market data over the bus -------------------------------------------
  // The runner does NOT open its own Kite socket. 147 of 156 legacy files did,
  // which is how ~50,000 token-subscriptions across ~150 sockets happened.
  const bus = new WsTransportClient({ url: busUrl })
  bus.subscribe<{ token: number; price: number; ts: number }>('md.tick', (m) => {
    const quote: Quote = {
      token: m.payload.token,
      lastPrice: m.payload.price,
      ts: m.payload.ts,
    }
    md.onTick(quote)
    // Only the strategies that DECLARED this token. A strategy's onTick is its
    // entry check as well as its exit check, so an unrelated instrument's tick
    // would run its entry evaluation on the wrong clock.
    for (const tag of md.routesFor(quote.token)) runner.handleTick(tag, quote)
  })
  void bus.ready().then(
    () => log.info('bus connected', { url: busUrl }),
    (err: unknown) => log.warn('bus not reachable yet, will retry', { url: busUrl, error: String(err) }),
  )

  /**
   * BEFORE the first sync, so the feed is already carrying the runner's tokens
   * by the time a strategy starts. A strategy that starts with nothing
   * subscribed sees `isTrustworthy() === false` and refuses every entry.
   */
  await declareAll()

  await runner.sync()

  const tick = setInterval(() => {
    void runner.tick().catch((err: unknown) => log.error('runner: tick failed', { error: String(err) }))
  }, TICK_MS)
  /**
   * The IST day the ledgers were last swept for. `Runner` keeps its own session
   * day for the strategy lifecycle; this one is the ledgers' own.
   */
  let sweptDay = istDateOf(Date.now())

  const sync = setInterval(() => {
    void runner.sync().catch((err: unknown) => log.error('runner: sync failed', { error: String(err) }))
    /**
     * Bookkeeping, on the sync cadence: the expiry sweep at the day roll and
     * any operator clear-request. Both go through the ledgers this process owns
     * — nothing else may write them — and both are guarded so a Mongo blip
     * cannot take the lifecycle loop down with them.
     */
    void (async () => {
      const today = istDateOf(Date.now())
      if (today !== sweptDay) {
        sweptDay = today
        await sweepExpired(today, 'day roll')
      }
      await processClearRequests(today)
    })().catch((err: unknown) => log.error('runner: ledger maintenance failed', { error: String(err) }))
    /**
     * Re-declare and re-publish on the SYNC cadence, not only every 15 minutes.
     *
     * A chain window is empty until spot has arrived (`#chainWindow` refuses to
     * centre on a price it does not have), and spot cannot arrive until the
     * subscription is published — so the first pass declares the index tokens
     * and the second, fifteen seconds later, fills in the options. On the old
     * 15-minute refresh that was a quarter of an hour of an option strategy
     * with no option data, every morning.
     */
    void declareAll().catch((err: unknown) =>
      log.error('runner: declare/publish failed', { error: String(err) }),
    )
  }, SYNC_MS)
  const refresh = setInterval(() => {
    void (async () => {
      try {
        instrumentRows = await loadStoredInstruments(mongo.db.collection('instrument'))
        master = new OptionMaster(instrumentRows)
        expiryBySymbol = expiryIndex(instrumentRows)
        // Re-declare against the REBUILT master, so a contract that only exists
        // after the daily sync is picked up.
        await declareAll()
      } catch (err) {
        log.error('runner: reference refresh failed', { error: String(err) })
      }
    })()
  }, REFRESH_MS)

  log.info('runner up', { api: apiUrl, catalogue: CATALOGUE.size })

  /**
   * A SIGNAL STOPS THE PROCESS; IT DOES NOT CLOSE THE BOOK — unless
   * `DESK_SQUAREOFF_ON_STOP=1` says so.
   *
   * This used to square off unconditionally, which read as the safe default and
   * was the opposite. Every restart path reaches this handler: `make restart`,
   * a bare `pm2 restart dx-runner`, a reboot, and — the one nobody is
   * watching — pm2's `max_memory_restart`. The runner's quote cache grows all
   * session, so an 11:40 memory bounce silently flattened the entire hosted
   * book at whatever the marks happened to be, mid-session, with no operator
   * involved. `scripts/deploy.sh`'s market-hours refusal only ever covered
   * `make deploy`.
   *
   * Stopping WITHOUT flattening is safe here in a way it is not for the legacy
   * engines: the position ledger and the strategies' state are both durable,
   * `StrategyBase.start()` runs `onRecover()` before job catch-up (and the
   * order-placing jobs are `replayable: false`, so nothing re-enters), and the
   * EOD flatten lives in the tick path at 15:30 where it belongs. A restart
   * resumes the book; it does not lose it.
   *
   * Either way the last thing this process does is NAME WHAT IS OPEN — the
   * flattening path because `stopAll` parks a strategy in `failed` when the
   * ledger still shows a position afterwards, this one because an operator who
   * bounced the runner mid-session needs to know the book is still out there.
   * A shutdown that says nothing about an open position is the lie the backstop
   * exists to remove, printed one layer higher.
   */
  const squareOffOnStop = process.env['DESK_SQUAREOFF_ON_STOP'] === '1'

  /** Every instance whose ledger is not empty, for the last log line. */
  const stillHolding = (): readonly { tag: string; mode: string; openPositions: number }[] =>
    runner.snapshots().filter((s) => s.openPositions > 0)

  const shutdown = (signal: string): void => {
    log.warn(
      squareOffOnStop
        ? `${signal} received, squaring off and stopping (DESK_SQUAREOFF_ON_STOP=1)`
        : `${signal} received, stopping WITHOUT squaring off — positions are durable and resume on restart`,
    )
    clearInterval(tick)
    clearInterval(sync)
    clearInterval(refresh)

    /**
     * BOTH PATHS QUIESCE FIRST — the intervals are cleared above, but clearing
     * an interval does not recall the pass already inside it. The 15:30
     * backstop is several HTTP round trips long, and this handler ends in
     * `mongo.close()` and `process.exit(0)`: exiting on top of an in-flight
     * flatten leaves the position open for the night, whatever the last line
     * of the log claimed. Nothing can start a new exit behind `quiesce()`
     * because the intervals are already gone, and the 15-second fuse below is
     * still the bound on all of it.
     */
    const closed = squareOffOnStop
      ? runner
          .quiesce()
          // AFTER the quiesce, not instead of it. `stopAll` would join an
          // in-flight exit by itself now, but letting it finish first keeps
          // `stopAll`'s own contract — a genuine last-chance attempt at every
          // instance, backoff ignored — rather than piggybacking on a flatten
          // started for another reason. A tag that is already flat by then
          // places nothing here.
          .then(() => runner.stopAll(`${signal} shutdown`))
          .then(() => {
            // Every instance has SETTLED at this point: `#stopOne` shares its
            // promise, so the await above covers exits started by the tick
            // path too, and `#stop` writes its terminal state (`failed`,
            // `squared-off` or `stopped`) before returning. An instance still
            // reading `running` here is therefore not one mid-flatten — it is
            // one whose stop threw outside `#stop`'s own handling — which is
            // why the ledger count is part of the test rather than the state
            // alone. "All squared off" is claimed only when NOTHING is open.
            const stranded = runner
              .snapshots()
              .filter((s) => s.state === 'failed' || s.openPositions > 0)
            for (const s of stranded) {
              // The MODE is named: "BN_BREAKOUT is still open" is useless when
              // the tag runs on both rails and only one of them is stranded.
              log.error(
                `runner: ${s.tag} (${s.mode}) is STILL OPEN at shutdown — needs manual square-off`,
                { mode: s.mode, openPositions: s.openPositions, error: s.lastError },
              )
            }
            if (stranded.length === 0) log.info('all strategies squared off')
          })
          .catch((err: unknown) => log.error('runner: shutdown failed', { error: String(err) }))
      : runner
          .quiesce()
          .catch((err: unknown) => log.error('runner: quiesce failed', { error: String(err) }))
          .then(() => {
            // Only now is this list the truth: an exit the 15:30 backstop had
            // already started may well have emptied the ledger, and reporting
            // a book as held when it was in fact closed a moment later is the
            // same defect pointed the other way.
            for (const s of stillHolding()) {
              log.warn(
                `runner: ${s.tag} (${s.mode}) holds ${s.openPositions} position(s) — NOT squared off ` +
                  '(deploy-safe stop); state is durable and resumes on restart',
                { mode: s.mode, openPositions: s.openPositions },
              )
            }
          })

    void closed.then(() => mongo.close()).then(() => process.exit(0))

    // Do not let a hung connection hold the process open through a restart —
    // but do not die silently either: a truncated shutdown must still name
    // every book that is open, which is exactly the log the fuse used to eat.
    setTimeout(() => {
      for (const s of stillHolding()) {
        log.error(`runner: ${s.tag} (${s.mode}) holds ${s.openPositions} position(s) at a FORCED exit`, {
          mode: s.mode,
          openPositions: s.openPositions,
        })
      }
      process.exit(1)
    }, 15_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

/**
 * `tradingsymbol -> expiry`, from the instrument dump.
 *
 * Rows with a blank expiry (cash, indices) are skipped rather than stored as
 * '': the ledger treats an absent expiry as "not known" and never sweeps on it,
 * and an empty string would compare as before every date.
 */
function expiryIndex(rows: readonly InstrumentRow[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.tradingsymbol === '' || r.expiry === '') continue
    out.set(r.tradingsymbol, r.expiry)
  }
  return out
}

/** `TAG:mode` back into its two halves. The tag itself never contains a colon. */
function splitInstance(instance: string): [string, 'paper' | 'live'] {
  const at = instance.lastIndexOf(':')
  const mode = instance.slice(at + 1)
  return [instance.slice(0, at), mode === 'live' ? 'live' : 'paper']
}
