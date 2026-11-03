/**
 * Market data host: ONE Kite login, one socket pool, one publisher.
 *
 * The legacy system opened a websocket per strategy — measured, 147 of 156
 * files construct their own `KiteTicker`. Here every consumer subscribes to the
 * bus instead, and the number of Kite connections is driven by the token total
 * (900 per socket), not by how many processes want data.
 *
 * Boots unconditionally, never gated on market hours: a pm2 restart at 09:15:30
 * must come up ready. Ticks simply do not flow outside the session, which the
 * consumer sees as a feed that is not alive rather than as a crash.
 *
 * WHAT IT PUBLISHES
 *   md.tick  {token, price, ts, oi?, volume?}  every subscribed instrument
 *   md.spot  {underlying, price, ts,           the cash/index leg, resolved here;
 *            prevClose?}                       the previous session's close when
 *                                              the tick carries one (`spotPayload`)
 *
 * Spot is published semantically rather than as another token because only this
 * process knows the token -> underlying mapping (it chose the subscriptions).
 * Consumers should not have to re-derive it from the instrument master.
 *
 * WHAT IT SERVES
 *   GET  /v1/md/history                    completed bars, read-only, bearer auth
 *   POST /v1/md/margin-basket              what Kite would hold against a
 *                                          HYPOTHETICAL book, bearer auth
 *
 * Because this process holds the ONE Kite login. `apps/runner` deliberately has
 * no broker credentials, so without the first endpoint every candle series it
 * keeps starts cold and an ATR strategy never forms a band. The second is the
 * same argument from the other side: desk-api cannot price a proposed repair at
 * the broker without a second IJ0574 login, and a second login invalidates the
 * first — the 2026-08-04 feed outage. See `history.ts` and
 * `book-margin/hypothetical.ts`.
 *
 * WHAT IT SUBSCRIBES TO
 *   the Python desk's open books        (`store.allBooks`, via `planSubscriptions`)
 *   every external declaration          (`desk-subscriptions`, via `subscription-store.ts`)
 *
 * The second one is how the hosted strategy runner's instruments reach the
 * feed. Without it they reached it by no route at all — see the header of
 * `subscription-store.ts` for what that looked like from the outside.
 */

import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import type { Server } from 'node:http'
import { OptionMaster } from '@algomaker/instruments'
import {
  connectWithRetry,
  fixedClock,
  installCrashGuards,
  isMarketOpen,
  istParts,
  isWeekday,
} from '@algomaker/core'
import { WsTransportServer } from '@algomaker/bus'
import { connectMongo } from '../../api/src/mongo.ts'
import { DeskStore, type StoredBook } from '../../api/src/store.ts'
import type { BookRow } from '../../api/src/books-registry.ts'
import type { BridgeLeg } from '../../api/src/contract.ts'
import { BrokerStore, requireMasterKey } from '../../api/src/brokerstore.ts'
import { KiteFeedPool, type SocketHealth } from './feed-pool.ts'
import { createKiteMarginClient, type KiteMarginClient } from './book-margin/kite.ts'
import { handleMarginBasket } from './book-margin/hypothetical.ts'
import { BOOK_MARGIN_COLLECTION, refreshBookMargin } from './book-margin/refresh.ts'
import { DEFAULT_SLOTS, createDebouncer, dueSlot } from './book-margin/schedule.ts'
import { FeedRecovery } from './feed-recovery.ts'
import { bestBidAsk } from './kite-feed.ts'
import type { KiteTick } from './kite-feed.ts'

export { acceptTick } from './kite-feed.ts'
import {
  resolveZerodhaCredentials,
  zerodhaLogin,
  type BrokerCredentialSource,
  type ZerodhaSession,
} from './zerodha-login.ts'
import {
  BSE_FREEZE_SOURCE,
  loadStoredInstruments,
  runSync,
  syncBseFreezeLimits,
  syncFreezeLimits,
  istDateString,
} from './sync-runner.ts'
import { planSubscriptions } from './subscription-source.ts'
import {
  createHistoryServer,
  describeHistoryError,
  isHistoryTokenRejection,
  type HistorySource,
} from './history.ts'
import {
  ensureSubscriptionIndexes,
  readSubscriptions,
  SUBSCRIPTION_COLLECTION,
} from './subscription-store.ts'
import { ensureMarksIndex, MARKS_COLLECTION, pruneOrphanMarks } from './marks-store.ts'
import {
  createTickRecorder,
  ensureTickIndexes,
  tickRecordingEnabled,
  type MdTick,
} from './tick-recorder.ts'

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`)
  return v
}

/** IST minute-of-day at which the daily instrument sync is due. Before 09:15. */
export const SYNC_IST_MINUTE = 8 * 60 + 45

/** IST minute-of-day, from epoch ms. IST is UTC+05:30 with no DST. */
export function istMinutes(nowMs: number): number {
  const shifted = new Date(nowMs + 330 * 60_000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/**
 * Is today's instrument sync still owed?
 *
 * A "HAVE I DONE TODAY'S YET" QUESTION, not a "is it 08:45 right now" one, and
 * that is the whole fix. The old check was
 * `setInterval(..., 60_000)` testing `getUTCMinutes() === 45`, which relies on
 * a timer landing inside a specific 60-second box roughly 525 times a day. A
 * timer that drifts by a second per tick — event-loop pressure, a slow Mongo
 * round trip, the process being cold — eventually steps straight over the box,
 * and the whole day's sync is SKIPPED. The visible result is not an error: it
 * is a stale instrument master, so a newly-listed weekly expiry simply cannot
 * be resolved and every strategy on it declines to trade, with nothing anywhere
 * saying why.
 *
 * Because the condition is `>=` rather than `===`, a late tick still fires it;
 * because it is keyed on the IST DAY already synced, it fires exactly once.
 */
export function syncDue(nowMs: number, lastSyncedDay: string): boolean {
  return istMinutes(nowMs) >= SYNC_IST_MINUTE && istDateString(new Date(nowMs)) !== lastSyncedDay
}

/**
 * The NSE freeze table, refreshed on the SAME schedule as the instrument master
 * (audit F-12).
 *
 * `syncFreezeLimits` existed and was called by `make sync` and by no running
 * process, so the table aged from whenever a human last typed the command. A
 * stale row UNDER-splits after an NSE revision and the exchange rejects the
 * tranche — the exact `xtsOrder.js:104` failure the splitter was written to
 * design out — and a missing row sends a 100-lot order unsplit. Both are
 * invisible until an order is refused, which is why the day it last succeeded
 * is published on `md.health`.
 *
 * RETURNS THE DAY TO RECORD, and that is the whole reason this is a function
 * rather than three inline lines. The refresh is FAIL-SOFT by contract: a
 * failed fetch keeps the PREVIOUS table, because an empty table means every
 * limit is unknown and an unknown limit means orders go out unsplit. The marker
 * has to fail soft the same way — stamping today for a sync that did not happen
 * is precisely the lie the field exists to prevent.
 *
 * The try/catch is belt-and-braces over that contract: order splitting is a
 * money path, and a future change inside `syncFreezeLimits` must not be able to
 * take the daily INSTRUMENT sync down with it.
 */
export async function refreshFreezeDay(args: {
  readonly run: () => Promise<number | null>
  readonly nowMs: number
  /** The day currently recorded. Returned unchanged when the refresh did not land. */
  readonly previous: string
  /**
   * Which table this run is refreshing, for the log lines. Two ride this
   * helper — NSE's qtyfreeze.csv and BSE's contract master — and they fail
   * independently; a warning that only says "the freeze table" sends the
   * operator to the wrong site.
   */
  readonly label?: string
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}): Promise<string> {
  const log = args.log ?? ((): void => {})
  const label = args.label ?? 'NSE freeze table'
  let symbols: number | null
  try {
    symbols = await args.run()
  } catch (err) {
    symbols = null
    log(`${label} sync THREW — it is supposed to fail soft; keeping the previous table`, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (symbols === null) {
    log(`WARNING: the ${label} was NOT refreshed — orders split on the PREVIOUS table`, {
      lastFreezeSyncDay: args.previous === '' ? 'never' : args.previous,
    })
    return args.previous
  }
  return istDateString(new Date(args.nowMs))
}

/**
 * Merge a freeze-day marker that landed in the BACKGROUND into the current one.
 *
 * The first-boot BSE sync in `main` is fire-and-forget (see the branch there),
 * so its `refreshFreezeDay` result arrives whenever bseindia.com lets it — and
 * that can be after the 08:45 daily refresh has already recorded today. A
 * plain assignment would then either be a no-op (both say today) or a LIE: a
 * boot fetch that failed answers the `''` it was handed as `previous`, and
 * writing that over a day the daily refresh recorded would tell `md.health`
 * SENSEX's row was never refreshed when it was. The marker is an IST date
 * string, so string order IS date order, and "the later of the two" is exactly
 * the rule: a landed day moves it forward, a failure (or an older day) leaves
 * it alone.
 */
export function laterFreezeDay(current: string, landed: string): string {
  return landed > current ? landed : current
}

// ------------------------------------------------------------ enctoken canary

/** How often the canary spends one REST call. `DESK_ENCTOKEN_CANARY_MS`. */
export const DEFAULT_CANARY_MS = 120_000
/** 08:30 IST — before the open, after the morning login has had time to land. */
export const CANARY_FROM_MIN = 8 * 60 + 30
/** 16:00 IST — half an hour past the close, so a square-off still has a live token. */
export const CANARY_TO_MIN = 16 * 60

/**
 * May the canary fire at this instant?
 *
 * A WEEKDAY 08:30-16:00 IST, and nothing else. The canary is the only REST call
 * in this process that nobody asked for, and a rejection routes into a real
 * password+TOTP login against a live trading account — so the window is what
 * keeps "prove the session is alive" from becoming a login loop. Zerodha
 * expires the web session overnight and over a weekend as a matter of course:
 * unwindowed, this would earn a 401 every two minutes from Friday evening to
 * Monday morning and trigger recovery on each one, to mint a token nothing
 * needs until Monday.
 *
 * Outside it the token's health is simply not interesting — no strategy is
 * reading history, no margin sweep is pricing, and the 08:45 sync will produce
 * a fresh session before anything is.
 */
export function canaryWindowOpen(nowMs: number): boolean {
  const { day, minuteOfDay } = istParts(nowMs)
  return isWeekday(day) && minuteOfDay >= CANARY_FROM_MIN && minuteOfDay < CANARY_TO_MIN
}

export interface EnctokenCanary {
  /**
   * Call on every health sweep. The window, the pacing and the in-flight gate
   * are all internal, and it NEVER rejects — the caller has nothing to catch.
   */
  tick(): Promise<void>
  /** Epoch ms of the last REST call Kite ACCEPTED, or null. Published on `md.health`. */
  readonly lastVerifiedAt: number | null
}

/**
 * A periodic proof that the enctoken still works for REST (audit F-13).
 *
 * THE GAP IT CLOSES. Both REST consumers of the token route a rejection into
 * `FeedRecovery`, and both are DEMAND-DRIVEN: the margin sweep prices a handful
 * of SPAN slots a day and only for live books, history only when the runner
 * asks for a series. An established websocket SURVIVES its enctoken being
 * invalidated — documented on `KiteFeedPool.reconnect`, and the substance of
 * the 2026-08-05 outage — so a Kite-web login elsewhere can kill the token
 * while ticks keep flowing, `md.health` stays green, and nothing notices for
 * hours. A desk holding nothing exercises the token nowhere at all.
 *
 * THE CHEAPEST AUTHENTICATED CALL THE SESSION EXPOSES. `ZerodhaSession` offers
 * exactly two things: the token itself and `historyData`. So the canary is one
 * instrument, `day` interval, today to today — the smallest possible authorised
 * read, and one that cannot place, cancel or modify anything.
 *
 * IT NEVER LOOPS. One call per `everyMs`, single-flighted, and a rejection
 * triggers recovery exactly ONCE — `FeedRecovery`'s per-kind backoff is then
 * the only thing that decides whether a login is spent. The canary does not
 * retry the call itself: retrying would either re-send the token that was just
 * rejected (recovery gated or failed) or duplicate what the next tick does
 * anyway.
 */
export function createEnctokenCanary(deps: {
  /** The current session. Null until the boot login lands — then simply skip. */
  readonly source: () => HistorySource | null
  /** The instrument to probe. Null when the master cannot name one yet. */
  readonly token: () => number | null
  /** Kite rejected the token: route it into `FeedRecovery.trigger(.., 'token')`. */
  readonly onRejected: () => Promise<unknown>
  /** The call answered: the REST session is proven live (`noteTokenAccepted`). */
  readonly onAccepted: () => void
  readonly everyMs: number
  readonly now: () => number
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}): EnctokenCanary {
  const log = deps.log ?? ((): void => {})
  let lastAttemptMs = Number.NEGATIVE_INFINITY
  let lastVerifiedAt: number | null = null
  let inFlight = false

  return {
    get lastVerifiedAt(): number | null {
      return lastVerifiedAt
    },
    async tick(): Promise<void> {
      if (inFlight) return
      const now = deps.now()
      if (!canaryWindowOpen(now)) return
      if (now - lastAttemptMs < deps.everyMs) return
      const source = deps.source()
      const token = deps.token()
      if (source === null || token === null) return

      // Paced from the ATTEMPT, not from the success: a rejected token must not
      // be re-probed every 10s just because it keeps failing.
      lastAttemptMs = now
      inFlight = true
      /**
       * The OUTER catch is why `tick()` can be called with a bare `void` from a
       * timer: nothing in here — not the call, not `onRejected`, not a logger —
       * can produce the unhandled rejection that Node treats as fatal.
       */
      try {
        const today = istDateString(new Date(now))
        let failure: unknown = null
        try {
          await source.historyData(token, 'day', today, today)
        } catch (err) {
          failure = err ?? new Error('the vendored client rejected with nothing at all')
        }
        if (failure === null) {
          lastVerifiedAt = deps.now()
          deps.onAccepted()
        } else if (isHistoryTokenRejection(failure)) {
          log('enctoken canary: kite REJECTED the token while the feed is streaming — recovering', {
            token,
            error: describeHistoryError(failure),
          })
          // ONCE. `FeedRecovery` paces itself per fault kind; a canary that
          // retried on top of that would be a second, unpaced login source.
          await deps.onRejected()
        } else {
          // Not an auth problem: a 500 or a socket hang-up is Zerodha having a
          // bad minute, and burning a login on it would hammer a live account
          // for nothing. Stated, not acted on.
          log('enctoken canary call failed (not a token rejection)', {
            error: describeHistoryError(failure),
          })
        }
      } catch (err) {
        log('enctoken canary threw — the health sweep is not the place to find out', {
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        inFlight = false
      }
    },
  }
}

/**
 * Stored books -> the input shape `planSubscriptions` wants.
 *
 * Extracted so this mapping is testable without booting the feed host: it is
 * pure, no I/O. A FLAT book (freshly created, no legs yet) has no `legs[0]`
 * to infer an expiry from, so the book-level `expiry` is passed through
 * explicitly — without it a flat book subscribes no chain and can never open
 * its first leg. See `subscription-source.ts` for why `expiry` is
 * `book.expiry ?? book.legs[0]?.expiry` there too: this caller has to supply
 * the same value it derives from, or that fallback never gets exercised.
 */
export function subscriptionBooks(books: readonly StoredBook[]) {
  return books.map((b) => ({
    symbol: b.symbol,
    // Book-level expiry, so a FLAT book still subscribes its chain. Without
    // it the expiry is only ever inferred from legs[0], and a book with no
    // legs subscribes nothing — so it can never open its first leg.
    expiry: b.expiry ?? b.legs[0]?.expiry,
    legs: b.legs.map((l) => ({ instrument: l.instrument, expiry: l.expiry })),
  }))
}

/**
 * Registered books -> the same input shape, for a book that holds NOTHING yet.
 *
 * `subscriptionBooks` above maps `COLLECTIONS.books`, and a StoredBook only
 * exists once legs have actually filled. The Build screen registers the book
 * first — a `BookRow` in `COLLECTIONS.booksRegistry`, carrying symbol and
 * expiry — and writes the StoredBook LAST, from the fills it saw. Between
 * those two points there is no StoredBook, so the subscription plan saw an
 * empty book list, the chain was never subscribed, and every strike on the
 * Build screen read "no quote yet": you could not open the position that would
 * create the book that would subscribe the chain.
 *
 * A registry row is exactly the demand signal that was missing. It already
 * names the one chain the operator is about to trade, and it disappears with
 * the row, so the tokens release themselves when the book is deregistered.
 *
 * `legs: []` deliberately: what the book HOLDS still comes from the StoredBook,
 * and the two are unioned by `planSubscriptions` on a token Set, so a book that
 * exists in both collections costs one subscription, not two.
 */
export function registrySubscriptionBooks(rows: readonly BookRow[]) {
  return rows
    // An empty expiry cannot name a chain; passing it through would ask the
    // master for the strikes of the empty string once per refresh.
    .filter((r) => r.expiry !== '')
    .map((r) => ({ symbol: r.symbol, expiry: r.expiry, legs: [] }))
}

/**
 * How many consecutive sweeps a socket must look frozen before it is reported.
 * At the 10s health cadence that is 20 seconds of silence on a majority of a
 * socket's tokens — long past any natural cadence, short enough to act on.
 */
export const STALE_SWEEPS_BEFORE_ALARM = 2

/**
 * The FREEZE window: how long a token may go without a print before it counts
 * against the frozen-socket verdict, and against the numbers on `md.health`.
 *
 * A SEPARATE NUMBER FROM `KiteFeed`'s 15s watchdog default, and the difference
 * is the whole point. 15s answers "is this quote fresh enough to act on", and
 * this desk's own documentation (apps/api/src/marks.ts) records what it
 * measured: a stock option chain's WINGS genuinely print only every 30-60
 * seconds. On the 15s window, therefore, more than half a quiet chain's tokens
 * are stale in perfectly normal conditions — which is the alarm's own trigger
 * condition. Left on the default the ERROR below fires all session on healthy
 * sockets, `staleTokens` on the Status card reads in the hundreds every quiet
 * morning, and with `DESK_STALE_RECONNECT=1` a healthy socket would be rebuilt
 * every sweep forever.
 *
 * 180s is 3-6x that documented natural gap — no liquidity pattern reaches it on
 * a majority of a socket at once — and still far short of a freeze that lasts
 * the session. Override with `DESK_FREEZE_STALE_MS`.
 */
export const DEFAULT_FREEZE_STALE_MS = 180_000

/**
 * A positive millisecond duration from the environment, or the default.
 *
 * A typo'd value falls back rather than becoming `NaN`: every comparison
 * against NaN is false, so a mistyped threshold would silently DISABLE the
 * control it configures instead of failing loudly. Zero and negatives fall back
 * for the same reason from the other side — a zero freeze window marks every
 * token stale on every sweep. (Same shape as `positiveEnvMs` in apps/api.)
 */
export function positiveEnvMs(name: string, dflt: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/**
 * Which sockets are CONNECTED BUT FROZEN (audit F-14)?
 *
 * The pure half of the health sweep, so the verdict is testable without a Kite
 * login. It mutates `streaks` — the caller's per-socket counter, which is the
 * only state a sweep carries between ticks — and returns the sockets that have
 * qualified `STALE_SWEEPS_BEFORE_ALARM` times running.
 *
 * FOUR CONDITIONS, each of them load-bearing:
 *
 *  - `session`: outside 09:15-15:30 IST every token is legitimately stale, and
 *    an alarm that fires all night is noise — which is how a real freeze goes
 *    unseen. The numbers are still PUBLISHED out of hours, just not alarmed on.
 *  - `connected`: a dead socket is loud and already has its own repair path
 *    (the dead-feed sweep into `FeedRecovery`). This detects the quiet failure.
 *  - more than HALF the socket's tokens stale: a stock chain's wings genuinely
 *    print only every 30-60 seconds (measured on BHEL, documented in
 *    apps/api/src/marks.ts), so a minority going quiet is the market, not the
 *    wire. A majority is not something liquidity does — PROVIDED "stale" is
 *    measured on the freeze window: on `KiteFeed`'s 15s default a majority of a
 *    quiet chain is stale in the ordinary course of a session, so this
 *    condition would hold all day on a healthy socket. `DEFAULT_FREEZE_STALE_MS`
 *    is what makes the majority test mean something.
 *  - two sweeps in a row: one sweep landing in a lull is a hiccup. And a socket
 *    that was just REPAIRED starts those two sweeps over — see
 *    `sweepFrozenSockets`.
 */
export function frozenSockets(
  perSocket: readonly SocketHealth[],
  session: boolean,
  streaks: Map<number, number>,
): readonly SocketHealth[] {
  const frozen: SocketHealth[] = []
  for (const s of perSocket) {
    const suspect = session && s.connected && s.tokens > 0 && s.staleTokens * 2 > s.tokens
    if (!suspect) {
      streaks.set(s.socket, 0)
      continue
    }
    const streak = (streaks.get(s.socket) ?? 0) + 1
    streaks.set(s.socket, streak)
    if (streak >= STALE_SWEEPS_BEFORE_ALARM) frozen.push(s)
  }
  return frozen
}

/**
 * One sweep of the frozen-socket check: state it, and (optionally) repair it.
 *
 * Extracted whole rather than left inline so the REPAIR'S EFFECT ON THE STREAK
 * is testable, which is the part that bites. `repairSocket` rebuilds the socket
 * and the registry replays every subscription on the new one — the exchange
 * cannot possibly have started printing again by the next 10s sweep, so the
 * socket still looks frozen, and a streak carried across the repair would repair
 * it again immediately and then every sweep after that. Resetting the streak
 * buys the rebuild a full `STALE_SWEEPS_BEFORE_ALARM` re-observation: if it is
 * genuinely frozen it is repaired again 20s later, and if the repair worked
 * nothing further happens.
 *
 * `repair` is null when `DESK_STALE_RECONNECT` is off. Nothing was rebuilt then,
 * so nothing needs re-observing and the alarm keeps stating the fault on every
 * sweep — which is the whole point of the default-off mode.
 */
export function sweepFrozenSockets(args: {
  readonly perSocket: readonly SocketHealth[]
  readonly session: boolean
  readonly streaks: Map<number, number>
  readonly repair: ((socket: number) => void) | null
  readonly onAlarm: (socket: SocketHealth) => void
}): void {
  for (const s of frozenSockets(args.perSocket, args.session, args.streaks)) {
    args.onAlarm(s)
    if (args.repair === null) continue
    args.repair(s.socket)
    args.streaks.set(s.socket, 0)
  }
}

function log(msg: string, ctx?: Record<string, unknown>): void {
  console.log(`[marketdata] ${new Date().toISOString()} ${msg}${ctx === undefined ? '' : ' ' + JSON.stringify(ctx)}`)
}

/**
 * The `md.tick` payload.
 *
 * Extracted from the onTick closure so it is testable without booting the
 * host. `oi` and `volume` ride along because the feed already subscribes in
 * 'full' mode (`kite-feed.ts:138`) — they arrived in every packet and were
 * dropped here, which is why the chain endpoint had no open interest to
 * serve. Omitted entirely (not `undefined`) when the packet lacks them, so a
 * consumer spreading this object never manufactures a false zero.
 */
export function tickPayload(t: KiteTick, ts: number): Record<string, unknown> {
  // Best bid/ask ride to the QuoteCache so the desk can mark at the MID: on
  // an illiquid strike the LTP is a memory (TCS 2440PE, 2026-08-17 — last
  // print 14:20 under a book moving every second) while the depth is the
  // market. A never-traded strike has NO ltp at all (`last_price: 0` on the
  // subscribe-time snapshot), so `price` substitutes the mid there — every
  // consumer types `price` as a number it can use, and 0 is not one.
  const book = bestBidAsk(t)
  const level = (l: { price: number; quantity?: number } | undefined) =>
    l !== undefined && typeof l.price === 'number' && Number.isFinite(l.price) && l.price > 0
      ? { price: l.price, qty: typeof l.quantity === 'number' && l.quantity >= 0 ? l.quantity : 0 }
      : null
  const side = (ls: { price: number; quantity?: number }[] | undefined) =>
    (ls ?? []).slice(0, 5).map(level).filter((x): x is { price: number; qty: number } => x !== null)
  const buy = side(t.depth?.buy)
  const sell = side(t.depth?.sell)
  return {
    token: t.instrument_token,
    price: t.last_price > 0 ? t.last_price : book !== null ? (book.bid + book.ask) / 2 : t.last_price,
    ts,
    ...(Number.isFinite(t.oi) ? { oi: t.oi } : {}),
    ...(Number.isFinite(t.volume) ? { volume: t.volume } : {}),
    ...(book !== null ? { bid: book.bid, ask: book.ask } : {}),
    ...(buy.length > 0 || sell.length > 0 ? { depth: { buy, sell } } : {}),
  }
}

/**
 * The `md.spot` payload: the index level under its CANONICAL name, and the
 * PREVIOUS SESSION'S CLOSE beside it (six-playbooks spec F6).
 *
 * `prevClose` is the full-mode index tick's `ohlc.close`, which the exchange
 * fills with the previous session's close; the playbooks measure the opening
 * gap against it. It is published only when it is a finite positive number
 * and OMITTED otherwise — never `undefined`, never 0: an LTP-mode packet has no
 * ohlc at all, and a 0 close read downstream would be a gap of the whole index.
 * The consumer reads absent as unknown. Extracted from the onTick closure,
 * like `tickPayload`, so the rule is testable without booting the host.
 */
export function spotPayload(underlying: string, t: KiteTick, ts: number): Record<string, unknown> {
  const close = t.ohlc?.close
  return {
    underlying,
    price: t.last_price,
    ts,
    ...(typeof close === 'number' && Number.isFinite(close) && close > 0 ? { prevClose: close } : {}),
  }
}

export async function main(): Promise<void> {
  /**
   * INSTALLED FIRST, before the env is read (audit F-41/F-53).
   *
   * The bridge, the gateway and the runner all carry these; this process did
   * not, and it is the one whose failure is hardest to see. It holds the ONLY
   * Kite login: if it dies, ticks stop, and every consumer's own health check
   * reports a feed that is "not alive" rather than a process that is gone — so
   * an unhandled rejection here (a Mongo blip inside any of the `void`-ed
   * timers below) took the whole desk's data down and left the evidence in
   * somebody else's log. See `@algomaker/core`'s `resilience.ts` for the two
   * incidents that wrote these.
   */
  installCrashGuards({ process, log })

  const mongoUrl = required('DESK_MONGO_URL')
  const busPort = Number(process.env['DESK_BUS_PORT'] ?? 8891)
  const rollWindow = Number(process.env['DESK_ROLL_WINDOW'] ?? 3)
  const universe = (process.env['DESK_UNIVERSE'] ?? 'NIFTY,BANKNIFTY,SENSEX,BHEL')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  /**
   * RETRY, NEVER EXIT (audit F-41, the gateway's G6 before it).
   *
   * `await connectMongo` exited on failure and `serverSelectionTimeoutMS` is
   * 5s, so under pm2's `min_uptime: 10_000` every attempt counted as unstable
   * and ten of them spent the entire restart budget in about seventy seconds.
   * Mongo arriving at 09:16 then brought the feed back with it — which is to
   * say, it did not, for the rest of the session.
   *
   * A retrying boot must still be STOPPABLE, or `pm2 stop` on a process waiting
   * for Mongo hangs until pm2's kill timeout. The handlers are removed the
   * moment the wait is over, so the real shutdown handler registered at the end
   * of `main` is the only one left.
   */
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
  const instrumentCol = mongo.db.collection('instrument')
  const subscriptionCol = mongo.db.collection(SUBSCRIPTION_COLLECTION)
  await ensureSubscriptionIndexes(subscriptionCol)
  /**
   * THE TICK TAPE, off unless `DESK_RECORD_TICKS=1` — see `tick-recorder.ts`.
   *
   * Read once, here, so the decision is made before anything downstream can
   * depend on it, and so the disabled case does no Mongo work at all: no index
   * is built, no collection is named, and no `md.tick` subscriber is added
   * below. The flag exists because this is a RESEARCH capture, not a desk
   * function — nothing in the trading path reads `desk-ticks`.
   */
  const recordTicks = tickRecordingEnabled(process.env)
  if (recordTicks) await ensureTickIndexes(mongo.db, log)

  // --- instrument sync, at boot and daily pre-open -------------------------
  const referencedTokens = async (): Promise<ReadonlySet<number>> => {
    const tokens = new Set<number>()
    for (const mode of ['paper', 'live'] as const) {
      for (const b of await store.allBooks(mode)) {
        for (const l of b.legs) {
          if (l.instrument.instrumentToken !== undefined) tokens.add(l.instrument.instrumentToken)
        }
      }
    }
    return tokens
  }

  /**
   * The IST day whose instrument sync has completed. Empty means "none yet".
   *
   * Also the health signal: it is published on `md.health` so a stale master is
   * VISIBLE. A sync that silently did not happen used to look identical to one
   * that did.
   */
  let lastSyncedDay = ''

  /**
   * The IST day the NSE freeze table was last REFRESHED (audit F-12).
   *
   * Separate from `lastSyncedDay` because the two fail independently: the
   * instrument dump comes from `api.kite.trade` and the freeze table from
   * `nsearchives.nseindia.com`, and the freeze fetch is fail-soft by contract.
   * Collapsing them would let a healthy instrument sync claim a freeze table
   * that was never fetched.
   */
  let freezeSyncDay = ''
  /**
   * The IST day the BSE index rows (SENSEX, BANKEX, FOCIT) were last refreshed
   * from BSE's contract master. Its own marker for the same reason
   * `freezeSyncDay` is separate from `lastSyncedDay`: bseindia.com and
   * nsearchives.nseindia.com fail independently, and a healthy NSE refresh
   * must not be able to claim SENSEX's row is current.
   */
  let bseFreezeSyncDay = ''
  /** The freeze table's home. Read by the gateway's splitter and by `routes/submit.ts`. */
  const freezeCol = mongo.db.collection('desk-freeze-limits')

  const sync = async (): Promise<void> => {
    try {
      const plan = await runSync({
        collection: instrumentCol,
        universe: { names: universe },
        referencedTokens,
        log,
      })
      const stored = await loadStoredInstruments(instrumentCol)
      master = new OptionMaster(stored)
      // Only on SUCCESS. A failed sync must leave the day still owed, so the
      // next minute retries it rather than waiting until tomorrow on a master
      // it never refreshed.
      lastSyncedDay = istDateString(new Date())
      log('instrument master rebuilt', {
        contracts: master.optionCount,
        spots: master.spotUnderlyings().length,
        deleted: plan.counts.deletes,
      })
      // The sync just decided which contracts are gone; their marks go with
      // them, once unpriced for a week. Never throws — see `marks-store.ts`.
      await pruneOrphanMarks({
        marks: mongo.db.collection(MARKS_COLLECTION),
        masterTokens: stored.map((r) => r.instrument_token),
        nowMs: Date.now(),
        log,
      })
    } catch (err) {
      // A failed sync degrades to a STALE master, never an empty one — the
      // previous contracts remain loaded and tradable.
      log('instrument sync FAILED, continuing on the existing master', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    /**
     * The freeze table rides the SAME daily trigger (audit F-12) — and is done
     * AFTER the instrument master, outside its try/catch, deliberately on both
     * counts. Outside, because the two sources are independent (`api.kite.trade`
     * and `nsearchives.nseindia.com`) and neither failure may cost the other.
     * After, because this fetch has no timeout of its own: an NSE host that
     * accepts the connection and never answers would otherwise hold the
     * instrument sync — the one thing that must happen before 09:15 — behind it.
     *
     * `refreshFreezeDay` never throws, so `sync`'s contract is unchanged.
     */
    freezeSyncDay = await refreshFreezeDay({
      run: () => syncFreezeLimits({ collection: freezeCol, log }),
      nowMs: Date.now(),
      previous: freezeSyncDay,
      log,
    })

    /**
     * BSE's index rows, as a SEPARATE step with its own day marker. NSE's
     * qtyfreeze.csv carries no BSE underlying, so this is the only source of
     * SENSEX's limit (spec D5); it comes last because its fetch has a 30 s
     * timeout of its own and bseindia.com sits behind a bot wall the NSE
     * archive does not, so it is the fetch most likely to fail — and its
     * failure must cost neither the instrument master nor the NSE table.
     */
    bseFreezeSyncDay = await refreshFreezeDay({
      run: () => syncBseFreezeLimits({ collection: freezeCol, log }),
      nowMs: Date.now(),
      previous: bseFreezeSyncDay,
      label: 'BSE freeze table',
      log,
    })
  }

  let master = new OptionMaster(await loadStoredInstruments(instrumentCol))
  if (master.optionCount === 0) {
    log('instrument master is empty, syncing before start')
    await sync()
  } else if ((await freezeCol.countDocuments({ source: BSE_FREEZE_SOURCE })) === 0) {
    /**
     * Same idea as the empty-master branch, for the BSE rows alone: a table
     * that has never seen a BSE row gets one NOW rather than at 08:45 IST
     * tomorrow, so SENSEX has a freeze limit from the first deploy. Only the
     * BSE step runs — the master and the NSE table are loaded and current
     * enough to be left to the daily trigger. Fail-soft as always: a blocked
     * download logs and the process starts regardless.
     *
     * NOT AWAITED, unlike the empty-master branch. The first cut awaited it
     * for a deterministic D7 log order, and the price was every restart:
     * while bseindia.com walls this server the count stays 0 and EVERY
     * `pm2 restart dx-marketdata` paid the fetch's 30 s timeout
     * (`defaultFetchBseZip`) before loading the master or serving a single
     * mark — a pre-open bounce included. The freeze row is not on the mark
     * path, and the gateway reads the table from Mongo when it splits, so
     * nothing here waits on it: the fetch runs in the background, the same
     * three log lines appear ('no BSE freeze rows stored', then either 'BSE
     * freeze limits synced' or the 'NOT refreshed' warning), and 'instrument
     * master loaded' now precedes them. The daily 08:45 path in `sync` is
     * unchanged and still awaited, behind the instrument master.
     *
     * The marker is merged with `laterFreezeDay` rather than assigned: this
     * can land AFTER the 08:45 trigger has recorded today, and a failed boot
     * fetch answers the '' it was handed, which must not erase that day.
     * `refreshFreezeDay` never rejects (it catches the run and logs), so the
     * `void` cannot drop an error on the floor.
     *
     * IT CAN OVERLAP THE 08:45 STEP, and that is left alone on purpose. A boot
     * inside the last ~30 s before the daily trigger (a pre-open bounce at
     * 08:44:40) has this fetch still in flight when `sync` runs its own
     * `syncBseFreezeLimits`; both write the same rows with per-row upserts
     * keyed on the unique `symbol` index, so the table ends the same
     * whichever lands last, and the marker merge above accepts either order.
     * The only visible trace is a second 'BSE freeze limits synced' line —
     * or, if the two upserts race the very first insert of a symbol, a
     * duplicate-key failure in one of them logged as 'NOT refreshed' while
     * the other has just refreshed it. Serialising the two (holding this
     * promise and awaiting it in `sync`) would remove that line at the cost
     * of a lock around a 30 s timeout on a path that is not the mark path;
     * not worth it for a window this narrow.
     */
    log('no BSE freeze rows stored, syncing in the background')
    void refreshFreezeDay({
      run: () => syncBseFreezeLimits({ collection: freezeCol, log }),
      nowMs: Date.now(),
      previous: bseFreezeSyncDay,
      label: 'BSE freeze table',
      log,
    }).then((day) => {
      bseFreezeSyncDay = laterFreezeDay(bseFreezeSyncDay, day)
    })
  }
  log('instrument master loaded', {
    contracts: master.optionCount,
    spots: master.spotUnderlyings().join(','),
  })

  /**
   * A process that BOOTS after 08:45 has not missed anything: it just loaded
   * the master from storage, and the previous run (or the empty-master branch
   * above) did the sync. Marking today as done stops a restart at 11:00 from
   * pulling the 60 MB dump again on every bounce.
   */
  if (istMinutes(Date.now()) >= SYNC_IST_MINUTE) lastSyncedDay = istDateString(new Date())

  // 08:45 IST daily, before the 09:15 open. See `syncDue` for why this is a
  // "have I done today's yet" test and not a clock-face match.
  const syncTimer = setInterval(() => {
    if (syncDue(Date.now(), lastSyncedDay)) void sync()
  }, 60_000)
  syncTimer.unref()

  // --- bus -----------------------------------------------------------------
  const bus = new WsTransportServer({ port: busPort })
  await bus.ready()
  log(`bus listening on :${busPort}`)

  // --- feed ----------------------------------------------------------------
  /**
   * The portal's broker store first, `ZERODHA_*` second (Phase A §6).
   *
   * `BrokerStore` needs `DESK_MASTER_KEY`; without one there is nothing to open
   * the sealed credential with, and that must not stop the feed booting — so it
   * degrades to the environment and says so. `resolveZerodhaCredentials` owns
   * the ordering and logs which source won.
   */
  let brokers: BrokerCredentialSource | null = null
  try {
    brokers = new BrokerStore(mongo.db, requireMasterKey())
  } catch (err) {
    log('broker store unavailable, will use ZERODHA_* from the environment', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const resolved = await resolveZerodhaCredentials({ brokers, log })
  // `let`, not `const`: feed recovery re-logs-in mid-session and the history
  // endpoint reads whatever session is current through its closure.
  let session = await zerodhaLogin(resolved.credentials)
  log('zerodha login OK (market data only)', { credentials: resolved.source })

  /**
   * Historical bars, served to the strategy runner over HTTP.
   *
   * This process holds the ONLY Kite login, and the runner deliberately holds
   * no broker credentials — so without an endpoint here, every candle series in
   * the runner starts cold and an ATR strategy never forms its band. Read-only:
   * the handler can reach exactly one vendor method and it is a GET.
   */
  const historyPort = Number(process.env['DESK_MD_PORT'] ?? 8892)
  const historyToken = process.env['DESK_API_TOKEN'] ?? ''
  let historyServer: Server | null = null
  /**
   * The Kite basket client, which the endpoint below borrows.
   *
   * DECLARED HERE AND BUILT LATER because it needs `pool` and `recovery`, and
   * both need the login this runs after. A `let` read through a closure is what
   * lets the HTTP server exist before them: the closure is only ever called from
   * a request handler, which cannot run before `main` returns to the event loop
   * — the same argument `onAuthFailure` below already makes for `recovery`.
   *
   * Null is not zero. `handleMarginBasket` answers 503 while this is unset, so a
   * verify asked during boot is told to try again rather than told the plan is
   * free to hold.
   */
  let marginClient: KiteMarginClient | null = null
  if (historyToken === '') {
    // NOT fatal. Serving the feed is this process's job and it can do it
    // without the endpoints; refusing to boot would take the whole desk's
    // market data down over a missing variable. But it is an ERROR line,
    // because the consequences are concrete and otherwise invisible: hosted
    // strategies start with cold candle series and ATR-based ones will not
    // trade, and the cockpit's margin verify has nowhere to ask.
    log(
      'DESK_API_TOKEN is not set — NOT serving /v1/md/history or /v1/md/margin-basket; hosted ' +
        'strategies will start COLD and no repair plan can be priced at the broker',
    )
  } else {
    historyServer = createHistoryServer({
      port: historyPort,
      token: historyToken,
      source: () => session,
      /**
       * THE OTHER REST CONSUMER OF THE ENCTOKEN — wired for the same reason as
       * the margin client below, and not covered by it: the margin sweep runs
       * only for LIVE books on a SPAN slot or a leg change, so a desk holding
       * nothing exercises the token nowhere, and a hosted strategy restarting
       * into a dead token would seed no candles and trade nothing all day.
       *
       * `recovery` is declared below and only ever called from a request
       * handler, which cannot run before this function returns to the event
       * loop.
       */
      onAuthFailure: async () =>
        (await recovery.trigger('history: kite rejected the enctoken', 'token')) === 'rotated',
      onTokenAccepted: () => recovery.noteTokenAccepted(),
      /**
       * The SIBLING route: what the broker would hold against a book that does
       * not exist yet, for the cockpit's repair menu (`routes/payoff.ts`).
       *
       * The instrument master is read through the closure, not captured: the
       * 08:45 sync REPLACES the whole `OptionMaster`, and a captured one would
       * keep resolving against yesterday's dump — which for a newly listed
       * strike is a "not listed" refusal of a contract that exists.
       */
      marginBasket: (body) =>
        handleMarginBasket(
          {
            resolve: (u, e, k, t) => master.resolve(u, e, k, t),
            client: () => marginClient,
            log,
          },
          body,
        ),
      log,
    })
    log(`history + basket-margin endpoints listening on :${historyPort}`)
  }

  const spotOf = new Map<number, string>()
  const lastSpot = new Map<string, number>()
  /**
   * Last price per token, persisted periodically so the dashboard renders a
   * book out of hours. DISPLAY ONLY — the order path never reads it. Declared
   * here because the tick handler below captures it.
   */
  const lastPrice = new Map<
    number,
    { price: number; ts: number; book: { bid: number; ask: number; ts: number } | null }
  >()

  /**
   * The window every socket's watchdog measures against — see
   * `DEFAULT_FREEZE_STALE_MS`. It is BOTH the alarm's per-token staleness test
   * and the `staleTokens`/`oldestAgeMs` published on `md.health`, deliberately:
   * the operator's Status card and the ERROR line must be describing the same
   * fact, or one of them is teaching them to distrust the other.
   */
  const freezeStaleMs = positiveEnvMs('DESK_FREEZE_STALE_MS', DEFAULT_FREEZE_STALE_MS)

  const pool = new KiteFeedPool({
    accessToken: session.accessToken,
    staleAfterMs: freezeStaleMs,
    log,
    onTick: (t) => {
      const underlying = spotOf.get(t.instrument_token)
      const ts = Date.now()
      if (underlying !== undefined) {
        lastSpot.set(underlying, t.last_price)
        bus.publish('md.spot', spotPayload(underlying, t, ts), ts)
      }
      bus.publish('md.tick', tickPayload(t, ts), ts)
      // The last TWO-SIDED frame rides along, surviving LTP-only ticks — the
      // same rule the api's QuoteCache applies, so a restart or the closed
      // market seeds the display with a book, not a print.
      const book = bestBidAsk(t)
      const prev = lastPrice.get(t.instrument_token)
      lastPrice.set(t.instrument_token, {
        price: t.last_price,
        ts,
        book: book !== null ? { bid: book.bid, ask: book.ask, ts } : (prev?.book ?? null),
      })
    },
    // The socket exhausted its retries. Do not wait for the sweep below — this
    // feed cannot come back without a fresh login, so start one now.
    onDown: (socket) => void recovery.trigger(`socket ${socket} gave up reconnecting`),
  })

  /**
   * SELF-HEALING, not pm2-healing — the 2026-08-04 incident.
   *
   * The enctoken is a WEB-SESSION token: the same user logging into Kite
   * anywhere else invalidates it mid-session, and from that moment the vendored
   * retry loop re-dials with a token Zerodha rejects every time. That is why
   * the 13:36 IST outage retried for 14 minutes without recovering, while the
   * manual pm2 restart came back in 30ms — the restart's boot LOGIN was the
   * fix, not the restart. `FeedRecovery` performs exactly that login in
   * process: credentials re-resolved from the portal store (so a mid-day
   * rotation is honoured), a fresh enctoken, and the dead sockets rebuilt with
   * the registry resubscribing everything.
   *
   * Triggered two ways: a socket's 'noreconnect' (above), and the sweep in the
   * health timer catching any socket down longer than `feedDeadMs` — the
   * normal path, since retries exhaust only after ~45 minutes.
   */
  const feedDeadMs = Number(process.env['DESK_FEED_DEAD_MS'] ?? 60_000)
  /**
   * The fresh session, held until `apply` COMMITS it.
   *
   * Two things read this one credential — the history endpoint through
   * `session`, the margin client through `pool.accessToken` — and `apply` is
   * the single place both are written. Assigning `session` inside `login`
   * instead would split them the moment a login outran `loginTimeoutMs`:
   * `withTimeout` rejects so `apply` never runs, but the slow login still
   * completes and publishes its token to one holder only. History would then
   * serve happily while every basket call 403'd for the rest of the session,
   * with a working enctoken live in the same process.
   */
  let pendingSession: ZerodhaSession | null = null
  const recovery = new FeedRecovery({
    login: async () => {
      // Re-resolve every time: the operator may have rotated the credentials
      // on the Brokers page mid-session, and recovery must honour that
      // without a reboot.
      const creds = await resolveZerodhaCredentials({ brokers, log })
      pendingSession = await zerodhaLogin(creds.credentials)
      return pendingSession.accessToken
    },
    apply: (accessToken) => {
      const fresh = pendingSession
      if (fresh !== null && fresh.accessToken === accessToken) {
        session = fresh
        pendingSession = null
      }
      pool.reconnect(accessToken)
    },
    log,
    baseDelayMs: feedDeadMs,
  })

  // --- subscription refresh ------------------------------------------------
  /** External publishers currently holding tokens, so a stale one can be released. */
  const externalSources = new Set<string>()
  /**
   * What the tick tape is allowed to record: the desk's OWN planned tokens.
   *
   * Rebuilt from `plan.tokens` on every refresh, so a book that rolls to the
   * next weekly stops taping the old chain within one cycle. Deliberately NOT
   * the whole socket set — an external publisher's instruments are somebody
   * else's research problem, and taping them is pure cost here. Empty, and
   * never written to, when the tape is off.
   */
  const recordedTokens = new Set<number>()
  const refresh = async (): Promise<void> => {
    try {
      const books = [...(await store.allBooks('paper')), ...(await store.allBooks('live'))]
      // REGISTERED books too, not only opened ones — see
      // `registrySubscriptionBooks`. A book being built holds nothing yet, so
      // it contributes no StoredBook, and without this its chain is unpriced
      // for exactly as long as it takes to open the first leg.
      const registered = [...(await store.listBooks('paper')), ...(await store.listBooks('live'))]
      const plan = planSubscriptions({
        books: [...subscriptionBooks(books), ...registrySubscriptionBooks(registered)],
        resolver: {
          spotToken: (u) => master.spotToken(u),
          strikes: (u, e) => master.strikes(u, e),
          resolve: (u, e, k, t) => master.resolve(u, e, k, t),
          futureToken: (u) => master.future(u)?.instrumentToken ?? null,
        },
        rollWindow,
        spotPrices: lastSpot,
        // Default ON: the desk picks its own strikes, and one it cannot see a
        // mark for is one it cannot open. Set DESK_FULL_CHAIN=0 to fall back to
        // a window if socket pressure ever demands it.
        fullChain: process.env['DESK_FULL_CHAIN'] !== '0',
      })

      spotOf.clear()
      for (const [token, underlying] of plan.spotTokens) spotOf.set(token, underlying)

      if (plan.missingSpot.length > 0) {
        // Loud, every cycle: without spot these books report NO delta at all.
        log('WARNING: open books with no spot instrument — their greeks cannot be computed', {
          underlyings: plan.missingSpot,
        })
      }

      // Idempotent: an unchanged token set produces no socket traffic.
      pool.declare('desk-books', plan.tokens)

      if (recordTicks) {
        recordedTokens.clear()
        for (const token of plan.tokens) recordedTokens.add(token)
      }
    } catch (err) {
      log('subscription refresh failed', { error: err instanceof Error ? err.message : String(err) })
    }

    /**
     * DEMAND DECLARED BY OTHER PROCESSES — separate try block on purpose.
     *
     * The desk's books and the hosted runner's strategies are independent
     * sources of demand, and a Mongo hiccup reading one must not cost the
     * other its subscriptions. Before this existed the runner's tokens reached
     * the feed by no route at all: `RunnerMarketData.subscriptionSet()` was
     * called only by its own test, so NIFTY/BANKNIFTY/SENSEX were never
     * subscribed, `isTrustworthy()` was false all session, and every hosted
     * entry was blocked — while `/v1/desk/feed` reported healthy off BHEL's
     * ticks.
     */
    try {
      const declared = await readSubscriptions(subscriptionCol, { nowMs: Date.now() })
      for (const s of declared.live) {
        // A DISTINCT subscriber id per source. `KiteFeedPool` unions across
        // subscribers and refcounts, so a token both the desk and the runner
        // want is still one subscription — but declaring both under one name
        // would make each write erase the other's tokens.
        pool.declare(`sub:${s.source}`, s.tokens)
        externalSources.add(s.source)
      }
      for (const s of declared.stale) {
        if (!externalSources.has(s.source)) continue
        // A publisher that stopped refreshing. Its tokens are released so a
        // decommissioned process does not hold sockets open forever; it is
        // logged because "the runner's instruments went quiet" must never be a
        // silent event.
        log('subscription declaration went STALE — releasing its tokens', {
          source: s.source,
          tokens: s.tokens.length,
          ageMs: Date.now() - s.updatedAt,
        })
        pool.remove(`sub:${s.source}`)
        externalSources.delete(s.source)
      }
    } catch (err) {
      log('external subscription read failed — keeping the current declarations', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await refresh()
  const refreshTimer = setInterval(() => void refresh(), Number(process.env['DESK_REFRESH_MS'] ?? 30_000))
  refreshTimer.unref()

  // --- per-book margin -----------------------------------------------------
  /**
   * Price each open book against Zerodha's basket-margin endpoint.
   *
   * IT LIVES HERE BECAUSE THE ENCTOKEN DOES. `feed-pool` holds the only Kite
   * session this desk has and persists it nowhere, so desk-api cannot make this
   * call without logging in a second time — and a second IJ0574 login
   * invalidates the first, which is the 2026-08-04 feed outage. This process
   * borrows the token it already has and publishes the answer to Mongo;
   * `/v1/desk/margin` only reads that.
   *
   * TWO TRIGGERS, ONE FUNCTION: a SPAN-publication slot, and any change to a
   * book's leg set (debounced, so four fills in two seconds are one call). The
   * leg-set hash is what makes the second trigger cheap — no fill event is
   * needed, a changed book simply looks different on the next sweep.
   */
  marginClient = createKiteMarginClient({
    enctoken: () => pool.accessToken,
    /**
     * ONE OF THE TWO THINGS THAT EXERCISE THE ENCTOKEN OVER REST (the history
     * endpoint above is the other), so one of the only two that can notice it
     * has died while the feed is fine.
     *
     * On 2026-08-05 the tile went stale for a whole session: a second IJ0574
     * login invalidated the token, every basket call 403'd, and the sweep below
     * never fired because the FEED never died — an established socket survives
     * its token being invalidated. Routing the rejection into the same recovery
     * closes that.
     *
     * `'token'`, NOT the default `'feed'`: this fault paces itself on its own
     * counter. The health sweep sees a fully connected pool right through a
     * token outage, and if `noteHealthy` could reset this backoff the sweep
     * would reopen the gate every 10s and each 30s margin sweep would spend a
     * real password+TOTP login on a live account — indefinitely, whenever the
     * fresh token is killed as fast as it is minted.
     *
     * The outcome is READ, not assumed: only `'rotated'` means the retry gets
     * a different token than the one just rejected.
     */
    onAuthFailure: async () =>
      (await recovery.trigger('basket margin: kite rejected the enctoken', 'token')) === 'rotated',
    /** A basket call that answers is the only proof the session is live again. */
    onTokenAccepted: () => recovery.noteTokenAccepted(),
  })
  const marginStore = mongo.db.collection(BOOK_MARGIN_COLLECTION)
  const marginSlots = (process.env['DESK_MARGIN_SLOTS'] ?? DEFAULT_SLOTS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const marginSlotState = { lastFired: 0 }
  /** tag -> hash of the leg set last priced, so an unchanged book is not re-priced. */
  const marginSeen = new Map<string, string>()
  const legsHash = (legs: readonly { instrument: { tradingsymbol: string }; qty: number }[]): string =>
    legs
      .map((l) => `${l.instrument.tradingsymbol}:${String(l.qty)}`)
      .sort()
      .join('|')

  const marginDeps = { store: marginStore, client: marginClient, now: () => Date.now(), log }
  /**
   * Books being priced RIGHT NOW, so the same book is never in flight twice.
   *
   * `basketMargin` bounds each ATTEMPT at 15s, not the whole call: a rejected
   * token adds a login (up to `loginTimeoutMs`) and a second attempt, so one
   * call can outlive both the 30s sweep interval and the 5s leg-change
   * debounce. Two calls in flight for one book race to write
   * `desk-book-margin` and the SLOWER one lands last — an older `asOf` and an
   * older total overwriting a newer one, which is the stale-figure-shown-as-
   * current failure `refresh.ts` exists to prevent.
   */
  const marginInFlight = new Set<string>()
  const priceBook = async (book: { tag: string; legs: readonly BridgeLeg[] }): Promise<void> => {
    if (marginInFlight.has(book.tag)) {
      // Drop the memo too: this refresh did NOT happen, and leaving the hash
      // recorded would make the next sweep conclude the book is already priced
      // at this leg set and skip it until the next SPAN slot.
      marginSeen.delete(book.tag)
      log('book margin still in flight — skipping this refresh', { tag: book.tag })
      return
    }
    marginInFlight.add(book.tag)
    try {
      await refreshBookMargin(marginDeps, book.tag, book.legs)
    } finally {
      marginInFlight.delete(book.tag)
    }
  }
  const marginPending = new Map<string, { tag: string; legs: readonly BridgeLeg[] }>()
  const marginDebouncer = createDebouncer(5_000, (tag) => {
    const pending = marginPending.get(tag)
    if (pending === undefined) return
    marginPending.delete(tag)
    void priceBook(pending)
  })

  const marginSweep = async (): Promise<void> => {
    try {
      // Only LIVE books. A paper book posts no margin at a broker, and pricing
      // it would put a real capital figure next to a position that is not real.
      const books = await store.allBooks('live')
      const slotDue = dueSlot(Date.now(), marginSlots, marginSlotState) !== null
      for (const book of books) {
        const hash = legsHash(book.legs)
        const changed = marginSeen.get(book.tag) !== hash
        if (!changed && !slotDue) continue
        marginSeen.set(book.tag, hash)
        if (changed) {
          // Debounced: mid-basket the leg set changes several times in seconds,
          // and each intermediate state is a book that never really existed.
          marginPending.set(book.tag, { tag: book.tag, legs: book.legs })
          marginDebouncer.bump(book.tag)
        } else {
          await priceBook(book)
        }
      }
    } catch (err) {
      log('book margin sweep failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  await marginSweep()
  const marginTimer = setInterval(() => void marginSweep(), Number(process.env['DESK_MARGIN_SWEEP_MS'] ?? 30_000))
  marginTimer.unref()

  // --- mark snapshot -------------------------------------------------------
  /**
   * Persist the last price seen per token.
   *
   * So the dashboard is useful outside market hours. The snapshot is DISPLAY
   * ONLY — the order path never reads it (see apps/api/src/marks.ts). Showing
   * last night's close clearly labelled is useful; FILLING at it is the frozen
   * price failure this system exists to prevent.
   */
  // Every upsert below is `{ token }` — without this index each one scans the
  // collection. Not awaited and never throws: see `marks-store.ts`.
  void ensureMarksIndex(mongo.db.collection(MARKS_COLLECTION), log)
  const snapshotTimer = setInterval(() => {
    void (async () => {
      if (lastPrice.size === 0) return
      try {
        const col = mongo.db.collection(MARKS_COLLECTION)
        for (const [token, e] of lastPrice) {
          /**
           * THE BOOK IS PRESERVED WHEN THIS PROCESS HAS NONE, which is the
           * same rule `QuoteCache.update` already applies in memory ("a book
           * that stopped is old, not gone" — `apps/api/src/marks.ts`). Writing
           * `null` here instead DESTROYED the close quotes on every restart
           * outside market hours: `lastPrice` rehydrates a price but no depth,
           * so within 60s this loop overwrote every persisted bid/ask with
           * null — and the closed-session display path prices exit-side off a
           * TWO-SIDED book, so the whole dashboard went to `no mark` until the
           * next session. Seen on prod 2026-09-14 (a holiday, so "the next
           * session" was 32 hours away): a marketdata restart at 01:00 IST
           * took 297 tokens' books to null and every open leg with them.
           *
           * `bookTs` is what keeps this honest — the frame carries its own
           * age, so a stale book is visibly stale rather than silently fresh.
           */
          await col.updateOne(
            { token },
            {
              $set: {
                token,
                price: e.price,
                ts: e.ts,
                ...(e.book === undefined || e.book === null
                  ? {}
                  : { bid: e.book.bid, ask: e.book.ask, bookTs: e.book.ts }),
              },
            },
            { upsert: true },
          )
        }
        log('mark snapshot persisted', { tokens: lastPrice.size })
      } catch (err) {
        log('mark snapshot failed', { error: String(err) })
      }
    })()
  }, Number(process.env['DESK_SNAPSHOT_MS'] ?? 60_000))
  snapshotTimer.unref()

  // --- tick tape -----------------------------------------------------------
  /**
   * The snapshot above is a PHOTOGRAPH; this is the TAPE.
   *
   * Same source, opposite purpose: `desk-marks` keeps one row per token so the
   * dashboard can render out of hours, while `desk-ticks` keeps every frame so a
   * delta controller can be replayed and tuned against a session that really
   * happened. Neither is on the order path.
   *
   * It subscribes to `md.tick` rather than reaching into the pool's `onTick`
   * closure, so it sees exactly the payload every other consumer sees —
   * including `price` already substituted with the mid on a never-traded strike.
   * `WsTransportServer.publish` dispatches to same-process subscribers, so this
   * costs one local handler, not a socket round trip.
   *
   * When `DESK_RECORD_TICKS` is unset `createTickRecorder` returns null, no
   * subscriber is registered at all, and the tick path is exactly what it was.
   */
  const tickRecorder = createTickRecorder({
    db: mongo.db,
    tokens: () => recordedTokens,
    now: () => Date.now(),
    log,
    env: process.env,
  })
  if (tickRecorder !== null) {
    bus.subscribe<MdTick>('md.tick', (msg) => tickRecorder.onTick(msg.payload))
    log('tick tape RECORDING — DESK_RECORD_TICKS=1', { collection: 'desk-ticks' })
  }

  // --- health --------------------------------------------------------------
  /**
   * Per-socket "looked frozen" counters, carried between sweeps. See
   * `frozenSockets` for the four conditions.
   */
  const staleStreaks = new Map<number, number>()
  /**
   * DEFAULT OFF, and deliberately so.
   *
   * Rebuilding a socket that is merely quiet drops live ticks for every token
   * on it and spends a reconnect; getting that wrong mid-session is worse than
   * the freeze it was guessing at. So the sweep's job here is to be LOUD — the
   * ERROR line names the socket and the repair — and the automatic rebuild
   * waits behind this flag until the alarm has been watched in production and
   * shown to fire only on real freezes.
   */
  const staleReconnect = process.env['DESK_STALE_RECONNECT'] === '1'

  /**
   * The enctoken canary (audit F-13). Rides the 10s health timer and paces
   * itself to `DESK_ENCTOKEN_CANARY_MS`; see `createEnctokenCanary` for why it
   * cannot become a login loop.
   */
  const canary = createEnctokenCanary({
    // `session` is reassigned by `apply` on every recovery, so this closure —
    // not a captured value — is what keeps the canary probing the CURRENT
    // token rather than the dead one it was built with. Built HERE, in main's
    // scope: the health timer below declares a `session` BOOLEAN of its own,
    // and a closure written inside it would read that instead.
    source: () => session,
    /**
     * A SPOT INDEX, not a book leg: it exists every day, needs no expiry roll,
     * and its `day` series is one row. The universe is walked in order so the
     * probe survives one underlying dropping out of the master.
     */
    token: () => {
      for (const u of universe) {
        const t = master.spotToken(u)
        if (t !== null) return t
      }
      return null
    },
    onRejected: () => recovery.trigger('enctoken canary: kite rejected the enctoken', 'token'),
    onAccepted: () => recovery.noteTokenAccepted(),
    everyMs: positiveEnvMs('DESK_ENCTOKEN_CANARY_MS', DEFAULT_CANARY_MS),
    now: () => Date.now(),
    log,
  })

  const healthTimer = setInterval(() => {
    const status = pool.status()
    const today = istDateString(new Date())

    // The dead-feed sweep. `trigger` gates itself (in-flight + backoff), so
    // calling it on every sweep while a socket stays down is free — and a
    // socket that stays down through a recovery attempt simply triggers the
    // next one when the backoff allows.
    const dead = status.find((s) => s.downForMs !== null && s.downForMs >= feedDeadMs)
    if (dead !== undefined) {
      void recovery.trigger(`socket ${dead.socket} disconnected for ${Math.round(dead.downForMs ?? 0)}ms`)
    } else if (status.length > 0 && status.every((s) => s.connected)) {
      recovery.noteHealthy()
    }

    /**
     * TICK health, not merely socket health (audit F-14).
     *
     * `StalenessWatchdog` has been recording every tick since this process was
     * written and nothing ever read it, so the one failure it exists to catch —
     * sockets connected, ticks stopped, every strategy deciding on frozen
     * prices — was invisible in `md.health`. It is published in every session
     * state; `session` says whether the numbers mean anything, because outside
     * market hours "everything is stale" is simply true and alarming on it
     * would train everyone to ignore the field.
     */
    const session = isMarketOpen(fixedClock(Date.now()))

    /**
     * ONE CHEAP REST CALL, on the canary's own cadence (audit F-13). Free to
     * call every sweep: the window, the pacing and the in-flight gate all live
     * inside it, and it never rejects — the `.catch` is belt-and-braces so that
     * remains true if `tick` ever grows a path that can.
     */
    void canary.tick().catch((err: unknown) => {
      log('enctoken canary threw', { error: err instanceof Error ? err.message : String(err) })
    })

    const tickHealth = pool.health()
    sweepFrozenSockets({
      perSocket: tickHealth.perSocket,
      session,
      streaks: staleStreaks,
      // See `staleReconnect` above: off by default, and it stays a rebuild of
      // the ONE frozen socket rather than a pool-wide bounce. A repair also
      // restarts that socket's streak — see `sweepFrozenSockets`.
      repair: staleReconnect ? (socket) => pool.repairSocket(socket) : null,
      onAlarm: (s) =>
        log(
          'ERROR: socket connected but ticks FROZEN — the exchange never took this subscription; ' +
            'resubscribe repair needed',
          {
            socket: s.socket,
            staleTokens: s.staleTokens,
            tokens: s.tokens,
            oldestAgeMs: s.oldestAgeMs,
            freezeStaleMs,
            autoRepair: staleReconnect,
          },
        ),
    })

    bus.publish(
      'md.health',
      {
        sockets: status,
        tokens: pool.tokenCount,
        ts: Date.now(),
        date: today,
        /**
         * Tokens silent for longer than the FREEZE window, not than a
         * tradability one. On the 15s default this counted a quiet stock chain's
         * wings — which print every 30-60s by nature — and put a large,
         * meaningless number on the Status card every ordinary session.
         */
        staleTokens: tickHealth.staleTokens,
        oldestAgeMs: tickHealth.oldestAgeMs,
        /** The window those two are measured against, so a reader can calibrate. */
        freezeStaleMs,
        /** Is the market open right now? Read `staleTokens` only when true. */
        session,
        /**
         * The day the instrument master was last rebuilt, and whether that is
         * today. A stale master is not an error anywhere — contracts simply
         * fail to resolve and strategies quietly decline to trade — so it has
         * to be STATED, or it is indistinguishable from a healthy feed.
         */
        instrumentSyncDay: lastSyncedDay === '' ? null : lastSyncedDay,
        instrumentsStale: lastSyncedDay !== today,
        /**
         * The day THIS PROCESS last refreshed the NSE freeze table (audit
         * F-12). Null after a mid-day restart even though the stored table may
         * be current — the table carries no timestamp of its own, and claiming
         * a sync this process did not perform is the failure the field exists
         * to expose. The 08:45 sync fills it in.
         */
        freezeSyncDay: freezeSyncDay === '' ? null : freezeSyncDay,
        /**
         * The same stamp for the BSE index rows (SENSEX/BANKEX), which come
         * from a different site and fail on their own. Null until this
         * process has refreshed them once.
         */
        bseFreezeSyncDay: bseFreezeSyncDay === '' ? null : bseFreezeSyncDay,
        /**
         * When a REST call last succeeded on the enctoken currently held
         * (audit F-13). Null until the canary's first probe. THE ONE FIELD
         * THAT DISTINGUISHES a live session from a live socket: everything
         * else here is satisfied by a socket that is streaming happily on a
         * token every REST call rejects, which is exactly the 2026-08-05
         * outage.
         */
        enctokenLastVerifiedAt: canary.lastVerifiedAt,
      },
      Date.now(),
    )
    if (lastSyncedDay !== today && istMinutes(Date.now()) >= SYNC_IST_MINUTE + 20) {
      log('WARNING: the instrument master has NOT been synced today — newly listed contracts will not resolve', {
        lastSyncedDay: lastSyncedDay === '' ? 'never' : lastSyncedDay,
      })
    }
  }, 10_000)
  healthTimer.unref()

  log('marketdata up', { tokens: pool.tokenCount, sockets: pool.socketCount })

  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`)
    pool.disconnect()
    // Before `mongo.close()` below, so the tape's timer cannot fire an insert
    // into a client that is on its way out. Null when the tape is off.
    tickRecorder?.stop()
    historyServer?.close()
    void bus.close().then(() => mongo.close()).then(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error('[marketdata] fatal', err)
    process.exit(1)
  })
}
