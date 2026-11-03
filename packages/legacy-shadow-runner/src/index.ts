/**
 * LegacyShadowRunner — drives an UNMODIFIED server/slive/*.js legacy file so
 * its emitted orders can be captured and diffed against a ported class,
 * without booting LoopBack, opening a real Kite/XTS connection, or writing to
 * Mongo. See Task 7 in the Phase C plan for why this needs zero edits to any
 * legacy file: every dependency the file would normally reach for is
 * pre-seeded into Node's CommonJS require cache before the file is required.
 */

import { createRequire } from 'node:module'
import { mock } from 'node:test'
import path from 'node:path'

export interface ShadowFixtureOption {
  readonly instrument_token: number
  readonly tradingsymbol: string
  readonly strike: number
  readonly lot_size: number
}

export interface RecordedLegacyOrder {
  readonly tradingsymbol: string
  readonly side: 'BUY' | 'SELL'
  readonly lots: number
}

export interface ShadowTick {
  readonly instrument_token: number
  readonly last_price: number
  readonly ohlc?: { readonly open: number }
}

/** A Kite-shaped historical candle, as the CALLING legacy file reads it — bn-breakout.js and
 *  orb-scalp.js read only open/high/low/close; atr-band-nifty.js additionally reads `.ts`
 *  (an "HH:MM"-prefixed timestamp string) to anchor its width/lines windows. */
export interface ShadowHistoryCandle {
  readonly ts?: string
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

export interface ShadowRunnerOptions {
  /** Absolute path to the legacy file, e.g. path.join(SLIVE_DIR, 'bull-s-1.js'). */
  readonly legacyFile: string
  readonly futureToken: number
  /**
   * Fixture for `optionInstruments.download(underlying).futures` — needed by
   * `orb-fut-core.js`'s `data.futures.find(f => f.instrument_token === futureToken)`.
   * Optional/additive: bn-breakout.js, orb-scalp.js, atr-band-nifty.js, cheetah/eagle/bull/lion
   * call `optionConfig(underlying)` (the plain function) or never read `.futures` at all, so this
   * is unused — and therefore harmless — for every legacy file this runner already drives.
   */
  readonly futureInstrument?: ShadowFixtureOption
  readonly currentExpiryOptions: Record<string, ShadowFixtureOption>
  readonly nowMs: number
  /**
   * Fixture for `zapi.historyData(token, interval, from, to)`, keyed by `${token}:${interval}`
   * — `from`/`to` are ignored (every legacy caller here passes "today" for both, computed off
   * the already-mocked Date, so the test controls "today" via `nowMs` instead of via these
   * fixture keys). Needed by bn-breakout.js/atr-band-nifty.js/orb-scalp.js, which read spot
   * candles for their range/band computation — cheetah-b1-1.js/eagle-s-1.js/bull-s-1.js/
   * lion-s25-2.js never call historyData, so this is optional and additive.
   */
  readonly historyData?: Record<string, readonly ShadowHistoryCandle[]>
}

export interface ShadowRun {
  readonly orders: readonly RecordedLegacyOrder[]
  /** Deliver one Kite-shaped tick batch through the intercepted feed and let queued handlers drain. */
  tick(ticks: readonly ShadowTick[]): Promise<void>
  /** Advance the mocked clock, e.g. for setTimeout-based bootstrap delays. */
  advance(ms: number): Promise<void>
  /** Restore the real Date/setTimeout. Call at the end of every test using this harness. */
  stop(): void
}

function fakeCjsModule(cache: Record<string, unknown>, resolvedPath: string, exportsValue: unknown): void {
  cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsValue }
}

/** Resolve both extensioned and extensionless requires to the SAME absolute path, and fake both keys. */
function fakeBothSpellings(
  require_: NodeJS.Require,
  cache: Record<string, unknown>,
  withExt: string,
  withoutExt: string,
  exportsValue: unknown,
): void {
  for (const spelling of [withExt, withoutExt]) {
    try {
      fakeCjsModule(cache, require_.resolve(spelling), exportsValue)
    } catch {
      // Not every legacy file requires both spellings; a resolution failure
      // for the one it doesn't use is expected, not an error.
    }
  }
}

export async function runLegacyShadow(opts: ShadowRunnerOptions): Promise<ShadowRun> {
  const require_ = createRequire(opts.legacyFile)
  const cache = require_.cache as unknown as Record<string, unknown>
  const orders: RecordedLegacyOrder[] = []
  let ticksHandler: ((ticks: readonly ShadowTick[]) => void) | null = null

  // ---- ../server.js: app.models.account / app.models.PaperTrade / app.get ----
  const fakeAccount = { lastLogin: '', config: {}, save: async () => {} }
  const fakeApp = {
    models: {
      account: {
        findById: async (_id: string) => fakeAccount,
        loadAccounts: async (_tag: string, _firstRun: boolean) =>
          ({ accounts: [], account_quantities: {}, running_accounts: [] }),
        placeAllAccount: async (
          _tag: string, _qtys: unknown, _running: unknown,
          inst: ShadowFixtureOption, side: 'BUY' | 'SELL', lots: number,
        ) => {
          orders.push({ tradingsymbol: inst.tradingsymbol, side, lots })
        },
      },
      PaperTrade: {
        trackOrder: (inst: ShadowFixtureOption, side: 'BUY' | 'SELL', _tag: string, lots = 1) => {
          orders.push({ tradingsymbol: inst.tradingsymbol, side, lots })
        },
        trackOrder_v2: async (inst: ShadowFixtureOption, side: 'BUY' | 'SELL', _tag: string, lots = 1) => {
          orders.push({ tradingsymbol: inst.tradingsymbol, side, lots })
        },
      },
    },
    get: (key: string) => (key === 'masterId' ? 'fake-master-id' : undefined),
  }
  fakeCjsModule(cache, require_.resolve('../server.js'), fakeApp)

  // ---- ../lib/zerodha.js: read-only login stub, never touches a real broker ----
  class FakeZerodha {
    loadConfig(_account: unknown): void {}
    async login(): Promise<boolean> { return true }
    async getConfig(): Promise<Record<string, never>> { return {} }
    getAuthorization(): string { return 'fake-token' }
    async historyData(
      token: number, interval: string, _from?: string, _to?: string,
    ): Promise<readonly ShadowHistoryCandle[]> {
      return opts.historyData?.[`${token}:${interval}`] ?? []
    }
  }
  fakeCjsModule(cache, require_.resolve('../lib/zerodha.js'), FakeZerodha)

  // ---- ../lib/KiteTicker(.js): the interception point. The legacy file's own
  //      `liveFeed.on('ticks', checkTicks)` call hands us the handler — this
  //      is how tick() below drives the file's real tick pipeline. ----
  class FakeKiteTicker {
    modeFull = 'full'
    connect(): void {}
    subscribe(): void {}
    setMode(): void {}
    on(event: string, handler: (...args: never[]) => void): void {
      if (event === 'ticks') ticksHandler = handler as (ticks: readonly ShadowTick[]) => void
      if (event === 'connect') handler() // no real socket to wait for
    }
  }
  fakeBothSpellings(require_, cache, '../lib/KiteTicker.js', '../lib/KiteTicker', FakeKiteTicker)

  // ---- ../tools/optionInstruments(.js): resolve synchronously from the fixture ----
  const fakeOptionConfig = Object.assign(
    async (_underlying?: string) => ({
      currentFuture: { token: opts.futureToken },
      weeklyInstruments: opts.currentExpiryOptions,
      nextWeekInstruments: opts.currentExpiryOptions,
    }),
    {
      download: async (_underlying: string) =>
        ({
          currentFuture: { token: opts.futureToken },
          // orb-fut-core.js: `futInstrument = data.futures.find(f => f.instrument_token === futureToken)`
          // — without this, `.futures` is undefined and that `.find()` throws inside
          // runStrategy()'s try/catch, silently swallowing the error and leaving
          // ticksHandler never captured (the exact I6 vacuous-green shape).
          futures: opts.futureInstrument === undefined ? [] : [opts.futureInstrument],
          weeklyInstruments: opts.currentExpiryOptions,
        }),
    },
  )
  fakeBothSpellings(require_, cache, '../tools/optionInstruments.js', '../tools/optionInstruments', fakeOptionConfig)

  // ---- ../lib/otmSelector(.js): D7, ATM is intentional — always 0 ----
  fakeBothSpellings(require_, cache, '../lib/otmSelector.js', '../lib/otmSelector', () => 0)

  // ---- ../lib/notify.js: I6 — this is a REAL Telegram client with a live bot token and a
  // real channel id hardcoded in the file. Unfaked, every notify() call in a driven legacy
  // file posts an actual message to a live production channel — confirmed the hard way
  // (bn-breakout.js's ENTRY/EXIT notify() calls landed in the real SMP_Alerts channel before
  // this fake existed). Every legacy file this runner drives calls notify() at least once
  // (ENTRY/EXIT/day-blocked), so this is not optional for any of them.
  fakeCjsModule(cache, require_.resolve('../lib/notify.js'), async (_message?: string, _configIdx?: number) => undefined)

  // ---- freeze the clock (moment() reads Date; bootstrap delays use setTimeout) ----
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: opts.nowMs })

  // Node's require cache is keyed by absolute path and is shared across the
  // whole process. Without this, a SECOND runLegacyShadow() call against the
  // same legacy file (e.g. a second golden-day test in the same file) would
  // hit the cache and skip re-executing it entirely — leaving this call's own
  // `ticksHandler` closure variable never assigned, so every tick() below
  // would silently no-op against a module-level state (ticksCache,
  // currentSize, optionOrders, ...) left over from the PREVIOUS call. Delete
  // the legacy file's own cache entry so each call gets a fresh module
  // execution and its own closures, while every *dependency* fake above stays
  // cached and reused.
  delete cache[require_.resolve(opts.legacyFile)]
  // orb-fut-bn.js / orb-fut-nifty.js / orb-fut-snx.js are thin wrappers around a SHARED engine
  // module, `orb-fut-core.js`, which itself does the top-level `require('../lib/KiteTicker.js')`
  // / `require('../tools/optionInstruments.js')` / etc — exactly ONCE, the first time ANY of the
  // 3 wrappers loads it. Only deleting `opts.legacyFile`'s own cache entry (above) is not enough:
  // orb-fut-core.js keeps its OWN closure-bound reference to whatever those fakes were AT ITS
  // OWN LOAD TIME, so a second golden-day test in the same process (e.g. ORB_FUT_NIFTY run after
  // ORB_FUT_BN) would silently drive the FIRST run's stale FakeKiteTicker/zerodha/optionConfig —
  // registering its `ticksHandler` into the first (already-stopped) run's closure instead of this
  // one's, and reading the first run's future/option fixtures. Deleting this shared module's own
  // cache entry too (when present — most legacy files have no such shared engine) forces it to
  // re-run its top-level requires against THIS call's freshly-faked dependencies.
  try {
    delete cache[require_.resolve(path.join(path.dirname(opts.legacyFile), 'orb-fut-core.js'))]
  } catch {
    // Not every legacy file this runner drives has a shared engine module.
  }
  require_(opts.legacyFile) // runs runStrategy() unawaited, exactly like production boot

  // Let the awaited zerodha_init()/ticker() chain inside runStrategy() reach
  // the point where liveFeed.on('ticks', ...) registers ticksHandler, before
  // the caller can deliver a tick.
  await new Promise((resolve) => setImmediate(resolve))

  return {
    orders,
    async tick(ticks) {
      // I6: a silent `?.()` no-op here, combined with a 0-vs-0 diff on the ported side, is
      // the exact vacuous-green scenario the review warned about — a test that never
      // actually drove the legacy file would still pass. If capture ever fails (a future
      // legacy file that connects differently, or a a regression in the fakes above), this
      // must fail LOUDLY rather than silently produce zero legacy orders.
      if (ticksHandler === null) {
        throw new Error(
          `LegacyShadowRunner: ticksHandler was never captured for ${opts.legacyFile} — ` +
            `the file's 'ticks' event listener never registered (see the FakeKiteTicker.on() ` +
            `interception point above). Any orders "captured" without this would be vacuous.`,
        )
      }
      ticksHandler(ticks)
      await new Promise((resolve) => setImmediate(resolve)) // let async.queue workers drain
    },
    async advance(ms) {
      // node:test's mock.timers.tick(ms) only fires timers that were ALREADY
      // scheduled before the call — a setTimeout registered from INSIDE a
      // callback that same tick (e.g. lion-s25-2.js:75-81's chained 5s-then-5s
      // bootstrap) is not picked up within that single call, even though its
      // due time falls well inside the requested window. Ticking in 1ms
      // steps instead means each newly-scheduled timer is re-checked on the
      // very next step, so a chain of any depth is carried through correctly.
      for (let i = 0; i < ms; i++) mock.timers.tick(1)
      await new Promise((resolve) => setImmediate(resolve))
    },
    stop() {
      mock.timers.reset()
    },
  }
}
