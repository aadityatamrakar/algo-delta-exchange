/**
 * THE RECENTER SUPERVISOR — process entry point, and the loops that make one
 * book's brain into a desk that runs.
 *
 * It replaces the Python `desk-supervisor` (design spec §3): the engine is
 * `@algomaker/desk-engine`, the wire is `POST /v1/desk/engine/decisions`, and
 * this file is the composition root that joins them to a feed, a registry and a
 * clock. Nothing here decides anything — every rule is in the engine and every
 * order goes out through desk-api — but every way the desk can be WRONG WHILE
 * LOOKING FINE lives in the wiring, so the wiring is what this header is about.
 *
 * ── BOOT IS UNCONDITIONAL ───────────────────────────────────────────────────
 * Never gated on market hours. Gating boot behind them is the 2026-07-06 bug
 * (`strategy-kit/src/base.ts:105`): a pm2 restart at 09:15:30 has to come up
 * READY, not asleep. The session gate is the ENGINE's, per decision, where an
 * operator can see it in a reason string.
 *
 * The order is load bearing:
 *
 *   1. crash guards, FIRST LINE. An unhandled rejection is fatal on Node 24, so
 *      one Mongo blip inside a `void` call would take the process down
 *      mid-session — and this process's `void`-fired intervals are everywhere.
 *   2. `connectWithRetry`, never a bare connect. A boot that EXITS on an
 *      unreachable Mongo burns pm2's restart budget in ~70 seconds and never
 *      comes back when Mongo does (audit G6).
 *   3. THE LEASE, in a retry loop that never exits. Two supervisors on one book
 *      do not fight and stall — they both work, perfectly, against the same
 *      broker position (`lease.ts`). A second process is a STANDBY: it waits,
 *      says so on `/health`, and takes over when the holder's TTL lapses.
 *      Exiting instead would mean a deploy that starts the new supervisor before
 *      the old one has finished dying leaves nothing running at all.
 *   4. Indexes — both stores, explicitly, even though each builds its own on
 *      first use. The lease's unique key is what makes step 3 exclusive.
 *   5. The registry, then the WARM START from `desk-marks`, SCOPED to the tokens
 *      the managed books actually want. Reading the whole collection would pull
 *      every token the desk has ever seen into a view whose entire memory
 *      argument is that it holds the declared set and nothing else
 *      (`chain-view.ts` §3, audit F-53).
 *   6. `snap()` each book once, because **the snap IS the declaration**: a
 *      `ChainView` learns which chains matter only when it is asked for one, and
 *      ticks that arrive before the first snap are dropped.
 *   7. Only then the bus, and only then the loops.
 *
 * ── THE STOP IS INERT, ALWAYS, WITH NO WAY TO MAKE IT OTHERWISE ─────────────
 * SIGTERM stops the loops and closes the process. It does not square off, it
 * does not cancel, it does not touch a book — and there is deliberately NO
 * `DESK_SQUAREOFF_ON_STOP` equivalent for this process, not even off by default.
 * Every restart path reaches that handler: `make restart`, a bare pm2 restart, a
 * reboot, and the one nobody is watching — `max_memory_restart`. The runner
 * learned this the expensive way (2026-08-17: an 11:40 memory bounce flattened
 * the entire hosted book at whatever the marks happened to be). A supervisor's
 * whole state is durable: the rule state, the seq, the working package and the
 * protected lots are in `desk-supervisor-state`, and a restart resumes the book.
 *
 * What the shutdown DOES do is finish what is already inside `evaluate()` and
 * then release the lease, so the standby takes over in a second rather than
 * waiting out a TTL.
 *
 * ── EVALUATION IS COALESCED, NOT PER TICK ───────────────────────────────────
 * `EngineHost.evaluate()` is serialised but not coalescing, so one call per tick
 * would queue a tick storm into a backlog of passes against stale markets
 * (ticket 14 §8). A timer at `EVALUATE_MS` runs one pass per book that has seen
 * a tick since its last one; the market is read at the moment the pass runs, so
 * a coalesced burst evaluates the LATEST book rather than each frame in turn.
 *
 * ── TWO FEEDS, AND THE SECOND ONE IS SEMANTIC ───────────────────────────────
 * `md.tick` carries TOKENS — the future and the option chain — and that set is
 * the whole of what a recenter book needs. A delta-lean book also needs the
 * INDEX ITSELF, whose token is in neither the future nor the chain, and which
 * `apps/marketdata` publishes on `md.spot` keyed by the CANONICAL underlying
 * rather than by token (it is the only process that knows the mapping, since it
 * chose the subscriptions). So this file subscribes to both, and the canonical
 * key is load bearing: options list under `NIFTY` and the index itself is
 * `"NIFTY 50"` in the dump, so a filter written against the dump's name yields a
 * ring that never fills, a detector that reads `'unknown'` on every pass, and a
 * book that silently never trades.
 *
 * One `SpotRing` per SYMBOL, not per book, created only for symbols a managed
 * book actually names, and long enough to hold a whole session (F5). It feeds
 * three things: the regime detector and the playbook frame's day statistics,
 * through `EngineHostDeps.ring`; `ChainView`'s proxy forward (§5), which is
 * what keeps an index book deciding when its near-month future is unquoted;
 * and the index level a `dl_parity_forward` book's chain is read around (§6,
 * six-playbooks spec F1). The same frames carry the index's previous close
 * (F6), kept per symbol beside the tape for the playbook frame's opening gap.
 *
 * ── WHICH FORWARD A BOOK IS PRICED OFF IS THE BOOK'S OWN DIAL ───────────────
 * `dl_parity_forward` on a delta-lean book prices its chain off the weekly's
 * own forward (`chain-view.ts` §6); every other book keeps the near-month
 * future's mid, exactly as before. `DESK_CHAIN_FORWARD=future`, read once at
 * boot (`chainForwardOverride`), puts every book back on the future — the
 * revert that needs no registry edit. The source each snap was priced off is
 * recorded on the book at the snap, handed to its engine and journalled.
 *
 * ── THE 1-SECOND POLL IS NOT OPTIONAL ───────────────────────────────────────
 * `evaluate()` no longer re-posts an in-flight decision: `pollInFlight` and the
 * fill nudge are the only things that ask desk-api again. A deployment that
 * forgot this timer would hold every working package forever — the book would
 * simply stop trading, with nothing in the log to say why.
 */

import { WsTransportClient } from '@algomaker/bus'
import { DESK_ALERTS_COLLECTION, connectWithRetry, createAlertSink, installCrashGuards, type RaiseAlert } from '@algomaker/core'
import {
  SpotRing,
  steadySpot,
  SUPERVISOR_NUDGE_PORT_DEFAULT,
  type ChainSnap,
  type Dials,
  type ForwardSource,
} from '@algomaker/desk-engine'
import { OptionMaster } from '@algomaker/instruments'
import type { NudgeKind } from '../../api/src/engine-notify.ts'
import { connectMongo } from '../../api/src/mongo.ts'
import type { Database } from '../../api/src/store.ts'
import { DEMO_TICK_TOPIC, type MarksVenue } from '../../api/src/books-registry.ts'
import { loadStoredInstruments } from '../../marketdata/src/sync-runner.ts'
import { loadDxLeverage } from '../../marketdata/src/dx-sync.ts'
import {
  ensureSubscriptionIndexes,
  publishSubscription,
  SUBSCRIPTION_COLLECTION,
} from '../../marketdata/src/subscription-store.ts'
import { MarginPoll } from './book-margin.ts'
import { ChainView, type ChainToken, type MdTick, type WarmMark } from './chain-view.ts'
import { DecisionsClient } from './decisions-client.ts'
import { marksNoteOf, overlayDemo } from './demo-marks.ts'
import {
  EngineHost,
  MarkClock,
  istDateOf,
  istMinuteOf,
  type HostLog,
  type MarkSample,
} from './engine-host.ts'
import { createNudgeServer, type NudgeServer, type SupervisorHealth } from './http.ts'
import { Lease, SUPERVISOR_LEASE_COLLECTION } from './lease.ts'
import { BOOK_MARKS_COLLECTION, MarksJournal } from './marks-journal.ts'
import { repairHoldLookupFor, repairHoldReader } from './repair-hold.ts'
import { RegistryPoll, type ManagedBook, type RegistryCollection } from './registry-poll.ts'
import {
  StateStore,
  SUPERVISOR_STATE_COLLECTION,
  type StateCollection,
} from './state-store.ts'
import { workingOrderCanceller } from './working-orders.ts'
import type { LegPosition, OptType } from '@algomaker/desk-engine'
import { NSE, venueFromEnv, type VenueSpec } from '@algomaker/venue'

// ─────────────────────────────────────────────────────────────── cadences

/** The desired-state poll. Spec §7: 5 s, with the nudge as the latency. */
const REGISTRY_MS = 5_000
/** The subscription declaration. Spec §7: refreshed ≤ 15 s. */
const SUBSCRIPTION_MS = 15_000
/** The in-flight decision poll. Spec §8. NOT optional — see the header. */
const IN_FLIGHT_MS = 1_000
/** The coalescing evaluation timer. See the header. */
const EVALUATE_MS = 250
/** How often the instrument master is rebuilt from the stored dump. */
const INSTRUMENT_MS = 15 * 60_000
/** The margin poll; desk-marketdata prices each book on a 30 s sweep. */
const MARGIN_MS = 30_000
/** The lease TTL, and the heartbeat that keeps it alive at a third of it. */
const LEASE_TTL_MS = 30_000
const HEARTBEAT_MS = 10_000
/** How long a standby waits between claims. */
const LEASE_RETRY_MS = 5_000
/** The bound on a shutdown that will not finish. */
const SHUTDOWN_FUSE_MS = 15_000

/** The subscriber name this process declares its tokens under (spec §7). */
export const SUPERVISOR_SUBSCRIPTION_SOURCE = 'desk-supervisor'

/**
 * One symbol's index tape, in samples. 32,768 is about nine hours at one print
 * a second: a WHOLE SESSION (09:15 to 15:30 is 22,500 seconds) with room for a
 * feed that prints faster than that (six-playbooks spec F5).
 *
 * It was 4,096 — 68 minutes — which covered the regime detector's 15-minute
 * context window and nothing more. The playbook frame folds the day's open,
 * high and low off this same tape (`SpotRing.filteredRange`), and a ring that
 * had overwritten 09:15 by 10:23 would hand every later fold a day that began
 * at 10:23. Half a megabyte of samples per symbol, for the handful of symbols a
 * book names; `window()` still walks only the span it is asked about.
 */
const SPOT_RING_CAPACITY = 32_768

/**
 * How stale an index print may be and still stand in for an unquoted future.
 *
 * DELIBERATELY LOOSER than `dl_spot_stale_s` (10), and the two are not the same
 * question. That dial refuses NEW RISK off an old level while letting exits
 * through; this one decides whether the chain snaps AT ALL, and a chain that
 * does not snap is a book that cannot exit either (`engine-host.ts`
 * `#evaluateOnce` bails on a null snapshot). So the bar is set where a feed
 * hiccup still leaves the book able to defend itself, and a feed that is
 * actually DEAD cannot price a forward off a level from another market hour —
 * which is how a frozen quote routes an order (`chain-view.ts` §4).
 */
const SPOT_PROXY_MAX_AGE_MS = 120_000

/**
 * How long `md.spot` must have been demonstrably flowing before a symbol with
 * nothing on it is called a fault rather than a slow first print.
 */
const SPOT_SILENCE_MS = 60_000

/**
 * One `md.spot` frame off the bus, as `apps/marketdata` publishes it
 * (`spotPayload` in `apps/marketdata/src/main.ts`).
 *
 * `underlying` is the CANONICAL key — `NIFTY`, `SENSEX` — out of
 * `INDEX_SPOT_TOKENS` (`packages/instruments/src/master.ts:70-90`), NOT the
 * name the instrument dump gives the index row. Spot is published semantically
 * rather than as another token because only that process knows the token →
 * underlying mapping.
 *
 * `prevClose` is the PREVIOUS session's close (six-playbooks spec F6): the
 * full-mode index tick's `ohlc.close`, present only when it is a finite
 * positive number. Absent means unknown — an LTP-mode packet, or a marketdata
 * build from before the field — never a close of zero.
 */
export interface MdSpot {
  readonly underlying: string
  readonly price: number
  readonly ts: number
  readonly prevClose?: number
}

// ────────────────────────────────────────────────────────────────── ports

/** The bus, narrowed to what this process does with it: listen. */
export interface BusPort {
  subscribe<T>(pattern: string, handler: (msg: { payload: T }) => void): () => void
  ready(): Promise<void>
  close(): Promise<void>
}

/**
 * The instrument master, reduced to the five questions a book asks of it.
 *
 * INJECTED rather than imported so the lifecycle test is a literal chain rather
 * than a CSV — the same reasoning `ChainViewDeps` gives, one level up.
 */
export interface MasterPort {
  /** Every listed contract in one chain, for the view and the subscription. */
  tokensFor(symbol: string, expiry: string): ReadonlyArray<ChainToken>
  /** The traded future the chain is priced against. 0 = the master lists none. */
  futureToken(symbol: string): number
  /** The tradingsymbol for a strike and a wing — a LOOKUP, never a formula. */
  instrumentFor(symbol: string, expiry: string, strike: number, optType: OptType): string | null
  /** The contract's tick, for flooring a maker quote. */
  tickSizeFor(symbol: string, expiry: string, strike: number, optType: OptType): number | null
  /** The chain's lot size and strike step. `0` when the master has neither. */
  chainMeta(symbol: string, expiry: string): { lotSize: number; step: number }
  /** The contract's leverage (DX `dx_leverage`), or null when the master states none. */
  leverageFor(symbol: string, expiry: string, strike: number, optType: OptType): number | null
}

/** desk-api, as this process reaches it outside the decision wire. */
export interface DeskApiPort {
  /**
   * `POST /v1/desk/books/registry/:tag/actual`. Best effort.
   *
   * `actual` is REPORTED rather than assumed, because this is the only writer of
   * that field and the page reads it beside `desired`. A drop that still said
   * `running` would leave a book the operator switched off showing as steered
   * forever — the exact gap between the two fields that the page exists to make
   * visible.
   */
  reportActual(
    book: ManagedBook,
    actual: 'running' | 'stopped',
    lastMarkAt: number,
    lastDecision: string,
  ): Promise<void>
  /** `POST /v1/desk/broker/orders/:id/cancel`. Throws when the request failed. */
  cancelOrder(brokerOrderId: string): Promise<void>
}

export interface SupervisorDeps {
  readonly db: Database
  readonly bus: BusPort
  /** The decision wire. One per process; the host adds the identity. */
  readonly client: ConstructorParameters<typeof EngineHost>[0]['client']
  readonly api: DeskApiPort
  master(): MasterPort
  readonly lease: Lease
  /** Who we claim the lease as. `${host}:${pid}` in production. */
  readonly owner: string
  now(): number
  readonly log: HostLog
  /** Built by `main`; the lifecycle test hands in its own or none. */
  readonly server?: NudgeServer
  /**
   * `DESK_CHAIN_FORWARD` as `main` read it ONCE at boot (`chainForwardOverride`):
   * `'future'` prices every book's chain off the near-month future's mid,
   * whatever its dials say — except a hold-to-expiry book's, which carries
   * legs across the restart (`chainForwardFor`); absent or `null` lets each
   * book's own `dl_parity_forward` decide.
   */
  readonly chainForward?: 'future' | null
  /**
   * The venue this process steers books on, `DESK_VENUE` read ONCE by `main`.
   * ABSENT IS NSE — every upstream test builds these deps without one.
   *
   * On DX the index IS the forward: Delta's options settle on `.DEXBTUSD`, the
   * master lists no future, and `md.spot` BTC is the only underlying price
   * there is. So every managed symbol gets the §5 proxy, whatever its engine.
   */
  readonly venue?: VenueSpec
  /** Test seams. Production takes the constants above. */
  readonly leaseTtlMs?: number
  readonly leaseRetryMs?: number
}

// ─────────────────────────────────────────────── the chain's forward (F1)

/**
 * `DESK_CHAIN_FORWARD`, READ ONCE AT BOOT (six-playbooks spec F1) — the revert
 * for the parity forward that needs no registry edit.
 *
 * `'future'` (any case, any surrounding space) puts every book back on the
 * near-month future's mid. Anything else — unset, empty, a typo — is `null`:
 * each book's own `dl_parity_forward` decides, which is the shipped behaviour.
 * `main` logs which is in force, with the raw value, so a typo is visible on
 * the first line an operator reads rather than silently doing nothing.
 */
export function chainForwardOverride(
  env: Readonly<Record<string, string | undefined>>,
): 'future' | null {
  return (env['DESK_CHAIN_FORWARD'] ?? '').trim().toLowerCase() === 'future' ? 'future' : null
}

/**
 * WHICH FORWARD ONE BOOK'S CHAIN IS SNAPPED AT: `'parity'` iff the book's
 * resolved dials have `delta_lean_enabled` AND `dl_parity_forward`, and the
 * boot-time override is not `'future'` — unless the book holds to expiry.
 *
 * A recenter book never gets it, whatever its row says (spec F1): its rules
 * were built and run on the future's mid. A delta-lean row registered before
 * the dial existed resolves it off (`DEFAULT_DIALS`) and keeps the future it
 * was measured on — the hold pairs carrying legs across a deploy are not
 * repriced mid-contract (review finding 8). Read off the dials on every snap,
 * so a retune lands on the next pass like any other dial; the registry refuses
 * a `dl_parity_forward` change while the book holds legs (F9), so that retune
 * only ever lands on a flat book.
 *
 * THE OVERRIDE SKIPS A HOLD-TO-EXPIRY BOOK (`dl_hold_to_expiry`). Those books
 * carry legs across every restart, and the switch is read only AT a restart:
 * setting it, or taking it off again, would move every carried pair between
 * its weekly's parity forward and the near-month future — 300-odd points apart
 * on SENSEX, enough to read a 4-lot spread 0.7 delta-lots off and trade to
 * "neutralise" it (the review's 2 Nov case, finding 8 again). So a hold pair
 * keeps the forward its own row names until it expires; the switch moves the
 * intraday books and the playbooks, which are flat at every restart.
 */
export function chainForwardFor(dials: Dials, override: 'future' | null): 'parity' | 'future' {
  if (override === 'future' && !dials.dl_hold_to_expiry) return 'future'
  return dials.delta_lean_enabled && dials.dl_parity_forward ? 'parity' : 'future'
}

// ───────────────────────────────────────────────────────────── one book

/**
 * One steered book: its host, its resolved dials, and the two facts desk-api's
 * registry row wants back.
 *
 * `book` is REPLACED on a retune rather than mutated, and the host reads it
 * through a closure — which is what makes a dial change land on the very next
 * evaluation without a restart.
 */
interface BookRuntime {
  book: ManagedBook
  readonly host: EngineHost
  /**
   * The chain's lot size and strike step, read ONCE when this book was adopted
   * and FIXED for the rest of its life here.
   *
   * NOTHING REFRESHES IT, and the docstring used to claim the instrument master
   * did. The master is rebuilt every 15 minutes, but a running book keeps the
   * `chainMeta` it started with: this is set at construction (`#adopt`) and no
   * other line writes it.
   *
   * That is the right shape rather than a gap to close. A book's symbol and
   * expiry are fixed for its life — they are half its identity, and the
   * registry has no way to change either on a running book — so the lot size
   * and step of that one chain cannot legitimately move underneath it either.
   * The one case where they DO move is an expiry roll, and the answer there is
   * to stop the book and start it, because a mid-flight lot-size change would
   * silently re-scale every quantity the engine has already reasoned in. The
   * supervisor runbook (§8) says so to the operator; `readonly` says so here.
   */
  readonly meta: { readonly lotSize: number; readonly step: number }
  lastMarkAt: number
  lastDecision: string
  /**
   * The host's stand-down reason while its strategy switch is OFF
   * (`EngineHostDeps.onStandDown`), `null` while it is deciding. Reported in
   * the registry row's `lastDecision` AHEAD of the last mark's reason for as
   * long as it is in force, so the book page says "switched off for paper"
   * rather than the reason of a mark that may be five minutes old — a
   * standing-down book with legs still marks, and `#onMark` would otherwise
   * overwrite the one line that explains why it is quiet.
   */
  standDown: string | null
  /** The market clock this book last evaluated against; the coalescing gate. */
  lastEvalTickMs: number
  /**
   * WALL-CLOCK ms of this book's last evaluation — the DELTA-LEAN cadence gate,
   * and read by nothing else.
   *
   * The recenter gate is `ChainView.touchedSince`, which is a statement about
   * the MARKET's clock: evaluate a book when its chain has ticked. That is the
   * right gate for a book that decides off a 5-minute grid and the wrong one for
   * a book that decides every second off a tape that ticks many times a second —
   * at `EVALUATE_MS` (250) a delta-lean book would run the detector, the lean
   * arithmetic and a full book read four times a second per book, for a
   * controller whose own dial says once a second (`dl_eval_min_ms`).
   *
   * A WALL CLOCK, deliberately, where the recenter gate refuses one: the cadence
   * being paced is this process's own CPU, not the market's information rate, so
   * it is the only thing the two can be compared on. 0 = never evaluated, which
   * lets the first pass through at once.
   */
  lastEvalMs: number
  /**
   * Which source priced this book's LAST snap (six-playbooks spec F1), or
   * `null` when it returned no chain. Recorded HERE, at the snap, because the
   * chain view is shared: its own `forwardSource` describes whichever book
   * snapped last, and read later — at the journal row, after a pass's awaits —
   * it could name another book's forward. `#snapFor` is the only writer.
   */
  forwardSource: ForwardSource | null
  /**
   * For a book marked on Delta's testnet (`#marksVenue`): the contracts its
   * LAST snap marked off production for want of a fresh demo quote
   * (`demo-marks.ts`). `null` = production-marked. Written by `#snapFor` only,
   * read by the host's `marksNote` in the same pass.
   */
  demoFallback: ReadonlyMap<string, string> | null
  /** The DEMO view's clock this book last evaluated against — `lastEvalTickMs`'s twin. */
  lastEvalDemoTickMs: number
}

/**
 * STORED `desk-books` LEGS → THE ENGINE'S `LegPosition`s, field by field.
 *
 * `openedByEngine` is `origin` read the only way it can be: `/v1/desk/submit`
 * stamps `'manual'` and the repair path stamps `'repair'`, and an engine open
 * stamps nothing (`book.ts:applyActions`). So an ABSENT origin on a book this
 * supervisor steers is a leg the desk's own automation put there. It is
 * informational — every rule that must not touch a leg reads `protectedQty`,
 * which is the operator's explicit pin — so a legacy leg reading as
 * engine-opened costs a label, never an order.
 *
 * `leanId` is carried through rather than dropped, and that is the reason this
 * mapper is a named, exported function rather than a loop inside `#readBook`.
 * It is a REQUIRED field on `LegPosition` (`types.ts`), so a field this mapper
 * failed to carry would read back as `undefined` — silently, with no type
 * error, because the stored document is a `Record<string, unknown>`. This
 * engine's own rules read no lean id — it has no lean — but a stored leg may
 * still carry one from before this rewrite, and a mapper that mangled it would
 * corrupt the round-trip rather than simply carrying an unused field. Absent
 * reads as `''` and not `undefined`, matching every other equality test that
 * relies on the distinction.
 *
 * A leg that cannot be converted at all — no lot size, no quantity, a type that
 * is not an option — is DROPPED rather than zero-filled: the engine sizes real
 * packages against what it is handed.
 */
export function legPositionsFrom(legs: readonly unknown[]): LegPosition[] {
  const out: LegPosition[] = []
  for (const raw of legs) {
    if (raw === null || typeof raw !== 'object') continue
    const leg = raw as Record<string, unknown>
    const instrument = (leg['instrument'] ?? {}) as Record<string, unknown>
    const tradingsymbol = String(instrument['tradingsymbol'] ?? '')
    const qty = Number(leg['qty'] ?? 0)
    const lotSize = Number(instrument['lotSize'] ?? 0)
    const optType = leg['type']
    if (tradingsymbol === '' || !(lotSize > 0) || qty === 0) continue
    if (optType !== 'CE' && optType !== 'PE') continue
    out.push({
      instrument: tradingsymbol,
      strike: Number(leg['strike'] ?? 0),
      optType,
      // The stored qty is SIGNED — negative is short — and `LegPosition`
      // splits that into a side and a positive lot count.
      side: qty < 0 ? 'Sell' : 'Buy',
      lots: Math.abs(qty) / lotSize,
      lotSize,
      entry: Number(leg['entryPrice'] ?? 0),
      openedByEngine: leg['origin'] === undefined,
      // Anything that is not a string is "no lean" — the same answer as an
      // explicit ''. A number or a null stored here must never be carried into
      // an equality test against a real lean id.
      leanId: typeof leg['leanId'] === 'string' ? leg['leanId'] : '',
    })
  }
  return out
}

// ────────────────────────────────────────────────────────────── the loops

export class Supervisor {
  readonly #d: SupervisorDeps
  readonly #store: StateStore
  readonly #marksJournal: MarksJournal
  /** The `desk-alerts` writer, one per process so its 10-minute dedupe spans every book. */
  readonly #alert: RaiseAlert
  readonly #margin: MarginPoll
  /**
   * Each Delta account's margin mode, off the gateway's `desk-broker-margin`
   * rows (`delta` = live, `delta-demo` = testnet), refreshed with the margin
   * poll. For the BULL-S `bs_margin_budget` estimate (`bull-s/margin.ts`).
   */
  readonly #marginModes = new Map<string, 'isolated' | 'portfolio'>()
  readonly #chain: ChainView
  /**
   * DELTA TESTNET QUOTES (`md.tick.demo`), for paper books on the demo rail —
   * the exchange their positions live on. Keyed by the desk's own tokens, never
   * snapped on its own: its quotes are laid over a demo-marked book's
   * production snap, wing by wing (`demo-marks.ts`). A prod-marked book never
   * reads it.
   */
  readonly #demoChain: ChainView
  readonly #hosts = new Map<string, BookRuntime>()
  readonly #registry: RegistryPoll
  readonly #timers: ReturnType<typeof setInterval>[] = []
  #unsubscribe: (() => void) | null = null
  #stopping = false
  #booted = false
  /** The newest tick timestamp admitted, for `/health`'s `feedAgeMs`. */
  #lastTickMs = 0
  /**
   * One index tape per SYMBOL — see the header — created only for symbols a
   * managed book names, and never dropped afterwards.
   *
   * Kept past the last book on a symbol deliberately: a book switched back on at
   * 13:00 whose ring had been discarded would spend its first quarter hour
   * refilling the context window, reading `'unknown'` and trading nothing. The
   * map is bounded by the symbols this process has ever steered.
   */
  readonly #rings = new Map<string, SpotRing>()
  /**
   * The NEWEST sample per symbol, which the ring cannot answer: it exposes
   * `window()` and `size` and no newest-sample accessor. Two callers need it —
   * `spotAsOf` (the index feed's own clock, never the chain's) and the §5 proxy
   * forward — and both need the price beside the stamp.
   */
  readonly #lastSpot = new Map<string, { price: number; ts: number }>()
  /**
   * The index's PREVIOUS SESSION CLOSE per symbol (six-playbooks spec F6), off
   * the same frames, with the IST date of the frame that carried it — see
   * `prevCloseFor`. Bounded exactly as `#lastSpot` is: only a symbol with a
   * ring is ever written.
   */
  readonly #prevClose = new Map<string, { close: number; dateIst: string }>()
  /**
   * This process's clock when the FIRST `md.spot` frame of any symbol arrived.
   * 0 = the topic has said nothing at all, which is the feed's health rather
   * than any one book's wiring. See `#auditSpotFeeds`.
   */
  #firstSpotMs = 0
  /** Symbols already reported silent. This is read every 250 ms forever. */
  readonly #spotSilenceLogged = new Set<string>()

  constructor(deps: SupervisorDeps) {
    this.#d = deps
    this.#store = new StateStore(
      deps.db.collection(SUPERVISOR_STATE_COLLECTION) as unknown as StateCollection,
      (msg, ctx) => deps.log.warn(msg, ctx),
    )
    this.#marksJournal = new MarksJournal(deps.db.collection(BOOK_MARKS_COLLECTION) as never, deps.log)
    this.#alert = createAlertSink(deps.db.collection(DESK_ALERTS_COLLECTION) as never, {
      now: deps.now,
      log: (message) => deps.log.warn(message),
    })
    this.#margin = new MarginPoll({ db: deps.db, now: deps.now, log: deps.log })
    this.#chain = new ChainView({
      // Asked through `master()` on every call, so a rebuilt dump reaches the
      // view without the view being rebuilt with it.
      tokensFor: (symbol, expiry) => this.#d.master().tokensFor(symbol, expiry),
      futureToken: (symbol) => this.#d.master().futureToken(symbol),
      // The proxy forward (`chain-view.ts` §5), off the same index tape the
      // regime detector reads — and the level a parity snap (§6) is read
      // around and carried from. `null` for a symbol no delta-lean book names,
      // and for one whose last print is too old to stand in for a forward —
      // absent is not zero, and a chain with neither a quoted future nor a
      // fresh index level does not snap at all rather than snapping off a
      // number nobody published.
      spotFor: (symbol) => this.#spotProxy(symbol),
      /**
       * A FLAT 1, and it is the honest answer rather than a placeholder.
       *
       * Carry takes a cash level to a near-month forward, and the only source
       * of it in this desk is the basis of a QUOTED future — which is exactly
       * what is missing in the one case this function is ever called for. There
       * is no rate curve, no dividend stream and no stored basis in this
       * process, so 1 means "the forward is the cash level": it understates a
       * positive-carry forward by the basis, a few points on a 24,000 index,
       * and it invents nothing. A book priced this way is not left to be
       * inferred — `ChainView.forwardSource` says `'proxy'`, and the mark
       * journal records it. The parity read's own fallback (§6) does not use
       * this: it carries the index over the contract's tenor at the desk rate.
       */
      carryFor: () => 1,
    })
    // No index and no carry: this view never prices a forward — the forward a
    // demo-marked book decides on stays production's.
    this.#demoChain = new ChainView({
      tokensFor: (symbol, expiry) => this.#d.master().tokensFor(symbol, expiry),
      futureToken: (symbol) => this.#d.master().futureToken(symbol),
    })
    this.#registry = new RegistryPoll({
      collection: deps.db.collection('desk-books-registry') as unknown as RegistryCollection,
      // The strategy switch, read beside the registry every pass and handed to
      // each host as `switchedOn` (spec E3): a switched-off book takes no new
      // risk and idles when flat instead of posting into desk-api's refusal.
      strategies: deps.db.collection('desk-strategies') as unknown as RegistryCollection,
      now: deps.now,
      log: deps.log,
      running: () => new Set(this.#hosts.keys()),
      start: async (book) => await this.#start(book),
      stop: async (key) => await this.#stop(key),
      retune: (book) => this.#retune(book),
      report: async (book) => await this.#report(book),
    })
  }

  /** The nudge/health server, so `main` can listen before it awaits `boot()`. */
  get server(): NudgeServer | undefined {
    return this.#d.server
  }

  /** Every book being steered, for `/health`. */
  get books(): string[] {
    return [...this.#hosts.keys()].sort()
  }

  /**
   * One symbol's index tape, or `undefined` for a symbol no managed book names.
   *
   * `undefined` rather than an empty ring, deliberately: the desk's feed carries
   * the whole universe, and a ring per symbol on it would be memory this
   * process has no use for. The distinction is also the tell for the canonical
   * key — `ringFor('NIFTY 50')` is `undefined` while `ringFor('NIFTY')` fills.
   */
  ringFor(symbol: string): SpotRing | undefined {
    return this.#rings.get(symbol)
  }

  /**
   * THE INDEX'S PREVIOUS SESSION CLOSE, as `md.spot` last carried it — or
   * `null`, which is UNKNOWN, never a zero (six-playbooks spec F6). Each host's
   * `prevClose` dep reads this, for the playbook frame's opening gap.
   *
   * ANSWERED ONLY ON THE IST DATE OF THE FRAME THAT CARRIED IT. A close is a
   * fact about one session, and this process runs across midnight: the close a
   * frame carried on the 15th is the 14th's, and on the 16th — until the first
   * frame of the session says otherwise — the honest answer is "unknown", not
   * a close two sessions old. Every frame of a session carries the same close,
   * so this costs nothing once the index has printed.
   */
  prevCloseFor(symbol: string): number | null {
    const held = this.#prevClose.get(symbol)
    if (held === undefined) return null
    return held.dateIst === istDateOf(this.#d.now()) ? held.close : null
  }

  /**
   * ONE `md.spot` FRAME — the index, by name, off the bus.
   *
   * PUBLIC because it is the whole body of the subscription, the same reason
   * `evaluateDue` is: a test that drives this directly is testing the handler
   * rather than a socket. Everything it refuses, it refuses silently, because
   * the shared feed carries symbols this process has no book for and that is
   * the normal case, not an error:
   *
   *   • a symbol no managed book named — no ring exists and none is created;
   *   • a price that is not a price. A zero spot is not a cheap index: the
   *     displacement against it is the whole level, which classifies as the
   *     trend of a lifetime. `SpotRing` drops non-finites at its own door too;
   *     this drops zero and negative, which it cannot know are impossible;
   *   • a sample OUT OF TIME ORDER. `SpotRing.window` walks back from the
   *     newest sample and stops at the first one before the cutoff, so a late
   *     arrival does not merely arrive late — it truncates every window behind
   *     it, silently, and the detector reads a span it never saw.
   *
   * A frame is taken WHOLE or not at all, and its previous close (F6) rides
   * with it: kept when it is a finite positive number, and a frame that carries
   * none says nothing about it — the close this session already saw stands.
   */
  onSpot(spot: MdSpot): void {
    if (this.#stopping) return
    const price = Number(spot.price)
    const ts = Number(spot.ts)
    if (!Number.isFinite(price) || price <= 0) return
    if (!Number.isFinite(ts)) return
    // Stamped BEFORE the symbol filter, and that order is the point: the proof
    // that `md.spot` is flowing at all comes from whatever the feed carries,
    // including symbols no book here manages. `#auditSpotFeeds` reads it.
    if (this.#firstSpotMs === 0) this.#firstSpotMs = this.#d.now()
    const symbol = spot.underlying
    const ring = this.#rings.get(symbol)
    if (ring === undefined) return
    const last = this.#lastSpot.get(symbol)
    if (last !== undefined && ts < last.ts) return
    ring.push({ ms: ts, spot: price })
    this.#lastSpot.set(symbol, { price, ts })
    const prevClose = Number(spot.prevClose)
    if (Number.isFinite(prevClose) && prevClose > 0) {
      this.#prevClose.set(symbol, { close: prevClose, dateIst: istDateOf(ts) })
    }
  }

  health(): SupervisorHealth {
    return {
      books: this.books,
      lease: this.#d.lease.owner,
      feedAgeMs: this.#lastTickMs === 0 ? null : Math.max(0, this.#d.now() - this.#lastTickMs),
    }
  }

  /**
   * Boot, in the order the header describes. Returns when the loops are armed.
   *
   * The LEASE WAIT IS INSIDE THIS CALL and it never gives up, so a standby's
   * `boot()` does not resolve until it is steering. `main` therefore has its
   * health server listening BEFORE this is awaited — a standby that answered
   * nothing on `/health` would be indistinguishable from a process that failed
   * to start.
   */
  async boot(): Promise<void> {
    const { log } = this.#d
    /**
     * EVERY STEP IS RE-CHECKED, not just the lease.
     *
     * `main` installs the signal handlers before it awaits this, and it has to:
     * a standby's lease wait has no end, so a shutdown must be able to interrupt
     * a boot. Each line below is an `await`, so a single check at the top would
     * leave a SIGTERM landing at, say, the registry read with a boot that goes on
     * to re-post an in-flight decision, subscribe the bus, arm every timer and
     * declare itself up — a process that is shutting down and steering.
     */
    const halted = (): boolean => {
      if (!this.#stopping) return false
      log.warn('the boot was interrupted by a shutdown — nothing was armed')
      return true
    }

    await this.#acquireLease()
    if (halted()) return

    await this.#store.ensureIndexes()
    await this.#d.lease.ensureIndexes()
    await this.#marksJournal.ensureIndexes()
    if (halted()) return

    // The registry FIRST, because the warm start and the first snap are both
    // scoped to what it says we steer.
    await this.#registry.run()
    if (halted()) return
    await this.#warmStart()
    if (halted()) return
    /**
     * THE SNAP IS THE DECLARATION (`chain-view.ts` §3), and `#start` is where it
     * happens — for a book taken up at boot and for one switched on at 13:00
     * alike. Stated here because the ORDER is what matters: every book has been
     * declared by the time `registry.run()` above returned, so the bus
     * subscription below cannot land a tick on a chain the view would drop.
     * A second snap loop here would be dead code that reads like the guarantee.
     */
    await this.#publishSubscriptions()
    if (halted()) return

    this.#subscribeFeeds()
    void this.#d.bus.ready().then(
      () => log.info('bus connected'),
      (err: unknown) => log.warn('bus not reachable yet, will retry', { error: String(err) }),
    )

    this.#arm()
    this.#booted = true
    log.info('supervisor up', { books: this.books.length, owner: this.#d.lease.owner })
  }

  /**
   * A nudge from desk-api. Fire-and-forget: the caller has a 1 s timeout and
   * these re-reads are Mongo round trips.
   *
   * `dials` and `registry` are the same act — both are answered by re-reading
   * the registry, which is the only thing that decides what a book's dials are.
   * `fill` polls every book holding a package: the nudge names a tag, but the
   * truth is re-read from Mongo either way and a poll of an idle book is free.
   */
  nudge(kind: NudgeKind): void {
    if (this.#stopping || !this.#booted) return
    if (kind === 'fill') {
      for (const runtime of this.#hosts.values()) {
        if (runtime.host.inFlight !== null) runtime.host.onFillNudge()
      }
      return
    }
    void this.#registry.run().catch((err: unknown) => {
      this.#d.log.error('a nudged registry pass failed', { error: String(err) })
    })
  }

  /**
   * SIGTERM, and the whole of what it does (see the header).
   *
   * Timers are cleared FIRST so nothing new can start, then whatever is already
   * inside `evaluate()` is drained. Draining rather than abandoning is
   * deliberate: a pass that has already saved its package to Mongo has burnt a
   * `seq` and holds an `inFlight` id, so cutting it off mid-post would leave a
   * decision to be replayed on the next boot for no reason at all. Nothing NEW
   * is decided — the timers are gone — so this cannot place an order the desk
   * did not already commit to.
   */
  async stop(signal: string): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    this.#d.log.warn(
      `${signal} received — stopping WITHOUT touching a book. Positions, rule state and any ` +
        'working package are durable and resume on restart.',
      { books: this.books },
    )
    for (const timer of this.#timers.splice(0)) clearInterval(timer)
    this.#unsubscribe?.()
    this.#unsubscribe = null
    /**
     * BEFORE THE DRAIN, and that order is the whole point. Clearing the timers
     * stops passes that have not STARTED; a pass already inside `evaluate()` is
     * past that gate and, left alone, would finish deciding and post a package
     * after the signal. `EngineHost.stop()` closes that window — nothing new is
     * formed — while a package that is already PERSISTED still completes its
     * post, which is the exactly-once property (`engine-host.ts:stop`).
     */
    for (const runtime of this.#hosts.values()) runtime.host.stop()

    await Promise.all(
      [...this.#hosts.values()].map(async (r) =>
        await r.host.drain().catch((err: unknown) => {
          this.#d.log.error('a book did not drain cleanly', { error: String(err) })
        }),
      ),
    )
    // Released rather than left to lapse, so the standby takes over in a second
    // instead of waiting out the TTL.
    await this.#d.lease.release().catch((err: unknown) => {
      this.#d.log.warn('the lease could not be released — it will lapse on its TTL', {
        error: String(err),
      })
    })
    await this.#d.bus.close().catch(() => undefined)
    await this.#d.server?.close().catch(() => undefined)
  }

  // ──────────────────────────────────────────────────────────── internals

  /**
   * Wait for the lease, forever if that is what it takes.
   *
   * A `false` is not an error: another supervisor holds it, this one is a
   * standby, and it says so on `/health` until the holder's TTL lapses. Exiting
   * would burn pm2's restart budget for a state that is CORRECT.
   */
  async #acquireLease(): Promise<void> {
    const ttl = this.#d.leaseTtlMs ?? LEASE_TTL_MS
    const retry = this.#d.leaseRetryMs ?? LEASE_RETRY_MS
    let said = false
    for (;;) {
      if (this.#stopping) return
      if (await this.#d.lease.acquire(this.#d.owner, ttl)) {
        this.#d.log.info('lease acquired — this process is steering', { owner: this.#d.owner })
        return
      }
      if (!said) {
        said = true
        this.#d.log.warn(
          'another supervisor holds the lease — STANDING BY. This process steers nothing and ' +
            'takes over if that one stops heartbeating.',
          { owner: this.#d.owner },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, retry).unref())
    }
  }

  /**
   * BOTH FEEDS, in one place, because both are torn down by one `#unsubscribe`.
   *
   * Two subscriptions rather than one because they carry different things: the
   * tick feed is keyed by TOKEN and the spot feed by canonical UNDERLYING (see
   * the header). A single handler could not tell them apart, and a process that
   * subscribed only the first would leave every delta-lean book with an empty
   * tape.
   */
  #subscribeFeeds(): void {
    const offTick = this.#d.bus.subscribe<MdTick>('md.tick', (msg) => {
      if (this.#stopping) return
      const tick = msg.payload
      this.#chain.onTick(tick)
      if (Number.isFinite(tick.ts) && tick.ts > this.#lastTickMs) this.#lastTickMs = tick.ts
    })
    const offSpot = this.#d.bus.subscribe<MdSpot>('md.spot', (msg) => {
      this.onSpot(msg.payload)
    })
    // Delta's testnet, on its own topic and into its own view: no `md.tick`
    // consumer can read a demo price, and only a demo-marked book reads this.
    const offDemo = this.#d.bus.subscribe<MdTick>(DEMO_TICK_TOPIC, (msg) => {
      if (this.#stopping) return
      this.#demoChain.onTick(msg.payload)
    })
    this.#unsubscribe = (): void => {
      offTick()
      offSpot()
      offDemo()
    }
  }

  /**
   * This symbol's tape, made if this is the first book to name it.
   *
   * Called from `#start` and nowhere else — a ring exists because a BOOK asked
   * for one, never because a frame arrived. Every book gets one, including a
   * recenter book: the ring is per symbol and free to share, a retune can turn
   * `delta_lean_enabled` on under a running book without rebuilding its host,
   * and `ChainView`'s proxy forward reads the same tape for either engine.
   */
  #ensureRing(symbol: string): SpotRing {
    let ring = this.#rings.get(symbol)
    if (ring === undefined) {
      ring = new SpotRing(SPOT_RING_CAPACITY)
      this.#rings.set(symbol, ring)
    }
    return ring
  }

  /** The §5 proxy's cash level, or `null` when there is none worth using. */
  #spotProxy(symbol: string): number | null {
    // ONLY for a symbol some delta-lean book names.
    //
    // A recenter book whose future has no quote at all has always gone silent,
    // and silent is a state its operator has run live for months. Answering
    // here would quietly change that: it would decide off spot x 1, and a flat
    // carry on a single stock is wrong by the whole basis — every delta in the
    // book shifts with it. The proxy was built for an index book that would
    // otherwise stop reacting for seconds at a time; it is not an improvement
    // to hand to a book that never asked for it.
    //
    // Per SYMBOL rather than per book because `ChainView` is per chain and
    // shared. A symbol carrying both kinds of book resolves toward the proxy,
    // which is the direction that keeps the delta-lean book deciding.
    if (!this.#proxySymbols.has(symbol)) return null
    const last = this.#lastSpot.get(symbol)
    if (last === undefined) return null
    if (this.#d.now() - last.ts > SPOT_PROXY_MAX_AGE_MS) return null
    // STEADIED, NOT THE NEWEST PRINT (integration review finding 4). This one
    // level is what the chain's own forward is banded against and carried off
    // (§6), not only the proxy: read raw, a single index print 0.6% off threw
    // a clean parity read out for index x carry six strikes away, and the
    // host's one-step invalidation then cancelled every working package on the
    // symbol. The median of the newest three prints within 30 s — the frame's
    // own `steadySpot` (spec M11) — cannot be moved by one print; with fewer
    // than three on the tape it is the newest, exactly as before.
    const ring = this.#rings.get(symbol)
    return (ring === undefined ? null : steadySpot(ring)) ?? last.price
  }

  /**
   * Every symbol the §5 proxy may answer for: on NSE, those a currently-managed
   * delta-lean book is running on; on a venue with no future (DX), every
   * managed symbol — there the index is the only forward that exists.
   */
  get #proxySymbols(): ReadonlySet<string> {
    const everyBook = (this.#d.venue ?? NSE).id !== 'nse'
    const out = new Set<string>()
    for (const runtime of this.#hosts.values()) {
      if (everyBook || runtime.book.dials.delta_lean_enabled) out.add(runtime.book.symbol)
    }
    return out
  }

  /**
   * A BOOK WHOSE SYMBOL NEVER APPEARS ON `md.spot` — said out loud, once.
   *
   * `DESK_UNIVERSE` is `apps/marketdata`'s env, not this process's, so the only
   * honest way to know whether a symbol is published is to watch the feed:
   * frames for OTHER symbols prove the topic is flowing, and a managed symbol
   * with an empty ring a minute into that is a book nothing will ever steer.
   * Untreated it is invisible — the ring stays empty, the detector answers
   * `'unknown'`, and a delta-lean book holds every pass looking exactly like a
   * book in a quiet market.
   *
   * Nothing is stood down and nothing is refused: this reports, and the book
   * behaves however its own engine decides to behave with no tape. ERROR when a
   * delta-lean book names the symbol, because that book is not quiet, it is
   * stopped; WARN otherwise, where the only loss is the proxy forward.
   */
  #auditSpotFeeds(): void {
    if (this.#firstSpotMs === 0) return
    if (this.#d.now() - this.#firstSpotMs < SPOT_SILENCE_MS) return
    for (const symbol of new Set([...this.#hosts.values()].map((r) => r.book.symbol))) {
      if ((this.#rings.get(symbol)?.size ?? 0) > 0) continue
      if (this.#spotSilenceLogged.has(symbol)) continue
      this.#spotSilenceLogged.add(symbol)
      const books = [...this.#hosts.values()].filter((r) => r.book.symbol === symbol)
      const leaning = books.filter((r) => r.book.dials.delta_lean_enabled).map((r) => r.book.key)
      const ctx = { symbol, books: books.map((r) => r.book.key), leaning }
      if (leaning.length > 0) {
        this.#d.log.error(
          `NO index spot has EVER been published for ${symbol} while the md.spot feed is ` +
            'carrying other symbols. Its delta-lean books have no tape: the regime reads ' +
            '"unknown" on every pass and they will NOT trade, silently. Add the symbol to ' +
            'DESK_UNIVERSE on desk-marketdata, or stop these books.',
          ctx,
        )
        continue
      }
      this.#d.log.warn(
        `no index spot has been published for ${symbol} while the md.spot feed is carrying ` +
          'other symbols. These books decide normally off their future; what they lose is the ' +
          'proxy forward, so a chain whose future stops quoting will not snap.',
        ctx,
      )
    }
  }

  /** Every token every managed book wants, as the master lists them. */
  #tokens(): number[] {
    const master = this.#d.master()
    const out = new Set<number>()
    for (const runtime of this.#hosts.values()) {
      const { symbol, expiry } = runtime.book
      const future = master.futureToken(symbol)
      if (Number.isFinite(future) && future > 0) out.add(future)
      for (const row of master.tokensFor(symbol, expiry)) {
        if (Number.isFinite(row.token) && row.token > 0) out.add(row.token)
      }
    }
    return [...out]
  }

  /**
   * Seed the last-known books from `desk-marks` — SCOPED to the tokens the
   * managed books actually want.
   *
   * The scope is the whole point. `ChainView`'s memory argument is that it holds
   * the declared set and nothing else (§3, audit F-53), and handing it the whole
   * collection would put every token the desk has ever subscribed into its seed
   * map at boot. Filtering in the QUERY rather than after the read means the
   * rows never cross the wire either.
   */
  async #warmStart(): Promise<void> {
    const tokens = this.#tokens()
    if (tokens.length === 0) return
    try {
      const rows = (await this.#d.db
        .collection('desk-marks')
        .find({ token: { $in: tokens } } as never)
        .toArray()) as unknown as Record<string, unknown>[]
      const marks: WarmMark[] = rows.map((r) => ({
        token: Number(r['token']),
        price: Number(r['price']),
        ts: Number(r['ts']),
        bid: typeof r['bid'] === 'number' ? r['bid'] : null,
        ask: typeof r['ask'] === 'number' ? r['ask'] : null,
        bookTs: typeof r['bookTs'] === 'number' ? r['bookTs'] : null,
      }))
      this.#chain.warmStart(marks)
      this.#d.log.info('warm start: last-known books seeded', {
        tokens: tokens.length,
        rows: marks.length,
      })
    } catch (err) {
      // A cold start is a slower start, not a wrong one: the first ticks fill
      // the view in. Loud because it explains a book that decides nothing for
      // its first minute.
      this.#d.log.error('the warm start failed — books decide nothing until the feed fills in', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Declare this process's COMPLETE token set for desk-marketdata (spec §7). */
  async #publishSubscriptions(): Promise<void> {
    const tokens = this.#tokens()
    try {
      await publishSubscription(
        this.#d.db.collection(SUBSCRIPTION_COLLECTION) as never,
        SUPERVISOR_SUBSCRIPTION_SOURCE,
        tokens,
        this.#d.now(),
      )
    } catch (err) {
      // Loud: without this the feed carries none of this process's tokens, and
      // that presents as books that never decide rather than as an error.
      this.#d.log.error('could NOT publish subscriptions — the feed will not carry these tokens', {
        tokens: tokens.length,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Build one book's host. Called by the registry poll, and at boot. */
  async #start(book: ManagedBook): Promise<void> {
    const { log } = this.#d
    // A shutdown that lands mid-boot must not take up a book: `#start` REPLAYS
    // an in-flight decision, which is a POST, and a stop may place nothing.
    if (this.#stopping) return
    const master = this.#d.master()
    const meta = master.chainMeta(book.symbol, book.expiry)
    if (!(meta.lotSize > 0) || !(meta.step > 0)) {
      throw new Error(
        `${book.key}: the instrument master lists no chain for ${book.symbol} ${book.expiry} ` +
          '(no lot size or strike step) — this book cannot be steered',
      )
    }

    const runtime: BookRuntime = {
      book,
      meta,
      lastMarkAt: 0,
      lastDecision: '',
      standDown: null,
      lastEvalTickMs: 0,
      lastEvalMs: 0,
      forwardSource: null,
      demoFallback: null,
      lastEvalDemoTickMs: 0,
      host: new EngineHost({
        tag: book.tag,
        mode: book.mode,
        // The process venue, once; absent leaves the host its own default.
        ...(this.#d.venue === undefined ? {} : { venue: this.#d.venue }),
        dials: (): Dials => runtime.book.dials,
        // Priced the way THIS book's dials ask (`chainForwardFor`), and the
        // source recorded on the book at the snap — see `#snapFor`.
        snap: () => this.#snapFor(runtime),
        forwardSource: () => runtime.forwardSource ?? undefined,
        // The index's previous close (spec F6), off `md.spot`, for the
        // playbook frame's opening gap. `null` = unknown, never zero.
        prevClose: () => this.prevCloseFor(runtime.book.symbol),
        readBook: async () => await this.#readBook(runtime.book),
        margin: () => this.#margin.for(book.tag),
        instrumentFor: (strike, optType) =>
          this.#d.master().instrumentFor(runtime.book.symbol, runtime.book.expiry, strike, optType),
        tickSizeFor: (strike, optType) =>
          this.#d.master().tickSizeFor(runtime.book.symbol, runtime.book.expiry, strike, optType),
        leverageFor: (strike, optType) =>
          this.#d.master().leverageFor(runtime.book.symbol, runtime.book.expiry, strike, optType),
        // A paper book trades the testnet account (the demo rail); live, the live one.
        marginModeFor: () => this.#marginModes.get(runtime.book.mode === 'live' ? 'delta' : 'delta-demo') ?? null,
        repairHold: repairHoldReader({
          lookup: repairHoldLookupFor(this.#d.db, this.#d.now),
          tag: book.tag,
          log,
          now: this.#d.now,
        }),
        store: this.#store,
        client: this.#d.client,
        now: this.#d.now,
        log,
        // THE INDEX TAPE, one per symbol and shared by every book on it, so two
        // books on NIFTY classify off one tape rather than two. Handed to every
        // host, not only to a delta-lean one: `#decide` reads it only when the
        // dial says so, and a host built without one could never be retuned
        // INTO delta-lean without a restart (`EngineHostDeps.ring`).
        ring: this.#ensureRing(book.symbol),
        // The INDEX feed's own clock, never the chain's — an option print says
        // nothing about when the index was last seen. 0 until the first frame,
        // which reads as infinitely stale: `dl_spot_stale_s` then refuses new
        // risk while still letting cuts through.
        spotAsOf: () => this.#lastSpot.get(runtime.book.symbol)?.ts ?? 0,
        // ONE CLOCK per book, shared with the journal by construction: the host
        // consumes the mark and hands it out, and nothing else calls `next()`.
        marks: new MarkClock(this.#d.venue),
        onMark: (sample) => this.#onMark(runtime, sample),
        // A BULL-S book's line is every pass's reason (the host only calls this
        // for one), so a refused entry reaches the page within one report.
        alert: (a) => this.#alert(a),
        onDecision: (reason) => {
          runtime.lastDecision = reason
        },
        // The switch as the poll last resolved it. `#retune` replaces
        // `runtime.book` on every pass, so a PATCH on the strategy row lands
        // within 5 s — there is no nudge for one, the poll is the guarantee.
        switchedOn: () => runtime.book.enabled,
        onStandDown: (reason) => {
          runtime.standDown = reason
        },
        // Named in the reason for a book marked on Delta's testnet, and only
        // for one — `null` keeps a production book's reason the engine's alone.
        marksNote: (contracts) =>
          runtime.demoFallback === null ? null : marksNoteOf(runtime.demoFallback, contracts),
        cancelWorking: workingOrderCanceller(
          {
            collection: this.#d.db.collection('desk-gateway-orders') as never,
            cancel: (id) => this.#d.api.cancelOrder(id),
            log,
          },
          book.tag,
          book.mode,
        ),
      }),
    }
    this.#hosts.set(book.key, runtime)
    try {
      // The margin BEFORE the first evaluation, so a book does not spend its
      // first minute reporting a modelled figure it could have read.
      await this.#margin.refresh([book.tag])
      // Re-checked across the await for the same reason as `boot()`'s steps: the
      // replay below is the one POST this path can make.
      if (this.#stopping) {
        this.#hosts.delete(book.key)
        return
      }
      // And the flight this book may have been left holding, BEFORE anything
      // decides against a position an unresolved package may still be moving.
      await runtime.host.resolveInFlightOnBoot()
      // The snap is the declaration: without it this book's ticks are dropped.
      this.#snapFor(runtime)
    } catch (err) {
      /**
       * A HALF-BUILT BOOK IS NOT A RUNNING ONE. The host is registered before
       * these awaits so nothing else can build a second one for the same key,
       * but if the boot replay cannot reach desk-api the book has not been taken
       * up — and leaving it in the map would have the registry poll report
       * `actual: 'running'` for a book whose in-flight decision was never
       * resolved, and never try again. Dropped here, the next pass rebuilds it.
       */
      this.#hosts.delete(book.key)
      this.#margin.drop(book.tag)
      throw err
    }
  }

  /** Let a book go. Steers nothing further; touches no position. */
  async #stop(key: string): Promise<void> {
    const runtime = this.#hosts.get(key)
    if (runtime === undefined) return
    this.#hosts.delete(key)
    this.#margin.drop(runtime.book.tag)
    // Whatever is already inside `evaluate()` finishes — it has already saved
    // its package, and abandoning it there would leave an id to replay.
    await runtime.host.drain()
    await this.#d.api
      .reportActual(runtime.book, 'stopped', runtime.lastMarkAt, this.#lastDecisionOf(runtime))
      .catch(() => undefined)
  }

  /** What the page shows as the last decision: the stand-down while one is in force. */
  #lastDecisionOf(runtime: BookRuntime): string {
    return runtime.standDown ?? runtime.lastDecision
  }

  /** A dial change, landing on the very next evaluation. */
  #retune(book: ManagedBook): void {
    const runtime = this.#hosts.get(book.key)
    if (runtime === undefined) return
    runtime.book = book
  }

  async #report(book: ManagedBook): Promise<void> {
    const runtime = this.#hosts.get(book.key)
    if (runtime === undefined) return
    await this.#d.api.reportActual(book, 'running', runtime.lastMarkAt, this.#lastDecisionOf(runtime))
  }

  /** This book's legs, out of `desk-books` — see `legPositionsFrom`. */
  async #readBook(book: ManagedBook): Promise<ReadonlyArray<LegPosition>> {
    const doc = (await this.#d.db
      .collection('desk-books')
      .findOne({ tag: book.tag, mode: book.mode } as never)) as Record<string, unknown> | null
    const legs = Array.isArray(doc?.['legs']) ? (doc['legs'] as Record<string, unknown>[]) : []
    return legPositionsFrom(legs)
  }

  /** The mark, to the journal and to the registry row the page reads. */
  #onMark(runtime: BookRuntime, sample: MarkSample): void {
    runtime.lastMarkAt = sample.ts
    runtime.lastDecision = sample.reason
    void this.#marksJournal.record(sample)
  }

  /**
   * THIS BOOK'S CHAIN, priced the way its own dials ask — and the declaration
   * (`chain-view.ts` §3) every snap also is.
   *
   * The forward is `chainForwardFor`'s: the weekly's own parity read for a
   * `dl_parity_forward` delta-lean book (§6), the future's mid for every other
   * book, and the future's mid for all of them under `DESK_CHAIN_FORWARD=
   * future`. The clock the parity read ages wings against is this process's,
   * at the moment of the snap.
   *
   * The source is recorded ON THE BOOK, here: the view is shared by every
   * book, and its own `forwardSource` describes whichever snapped last.
   */
  #snapFor(runtime: BookRuntime): ChainSnap | null {
    const nowMs = this.#d.now()
    const snap = this.#chain.snap(
      runtime.book.symbol,
      runtime.book.expiry,
      runtime.meta.lotSize,
      runtime.meta.step,
      {
        forward: chainForwardFor(runtime.book.dials, this.#d.chainForward ?? null),
        nowMs,
        dateIst: istDateOf(nowMs),
        minuteOfDay: istMinuteOf(nowMs),
      },
    )
    runtime.forwardSource = snap === null ? null : this.#chain.forwardSource
    if (this.#marksVenue(runtime.book) !== 'demo') {
      runtime.demoFallback = null
      return snap
    }
    // The demo view is declared even when there is no snap, so the testnet's
    // ticks for this chain are kept from the book's very first pass.
    const demo = this.#demoChain.quotes(runtime.book.symbol, runtime.book.expiry)
    if (snap === null) return null
    const rows = this.#d.master().tokensFor(runtime.book.symbol, runtime.book.expiry)
    const marked = overlayDemo(snap, rows, demo, nowMs)
    runtime.demoFallback = marked.fallback
    return marked.snap
  }

  /**
   * WHOSE PRICES MARK THIS BOOK: the registry row's (`ManagedBook.marks`,
   * re-read every poll) — on a venue that HAS a testnet rail. NSE has none, so
   * every NSE book is production-marked whatever its row says.
   */
  #marksVenue(book: ManagedBook): MarksVenue {
    if ((this.#d.venue ?? NSE).id === 'nse') return 'prod'
    return book.marks
  }

  /**
   * One evaluation per book that has seen a tick since its last one.
   *
   * PUBLIC because it is the loop's whole body: the timer does nothing but call
   * it, so a test that drives this directly is testing the loop rather than a
   * wall clock. Same for `pollFlights`.
   *
   * The coalescing gate is `ChainView.touchedSince`, which answers off the
   * TICKS' own timestamps rather than a wall clock — so a quiet market costs
   * nothing and a replayed session behaves the same way in a fixture as it does
   * live. Errors are per book: one book's bad pass must not stop the others.
   */
  async #refreshMarginModes(): Promise<void> {
    try {
      const rows = (await this.#d.db
        .collection('desk-broker-margin')
        .find({ _id: { $in: ['delta', 'delta-demo'] } } as never)
        .toArray()) as unknown as { _id: string; marginMode?: unknown }[]
      for (const r of rows) {
        if (r.marginMode === 'portfolio' || r.marginMode === 'isolated') this.#marginModes.set(r._id, r.marginMode)
        else this.#marginModes.delete(r._id)
      }
    } catch (err) {
      this.#d.log.warn('margin mode read failed (priced as isolated)', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async evaluateDue(): Promise<void> {
    // Here rather than on a timer of its own: this is the loop that WOULD be
    // steering a book with no tape, so it is the place the absence shows.
    this.#auditSpotFeeds()
    for (const runtime of [...this.#hosts.values()]) {
      if (this.#stopping) return
      if (!this.#due(runtime)) continue
      try {
        await runtime.host.evaluate()
      } catch (err) {
        this.#d.log.error('a book’s evaluation failed', {
          key: runtime.book.key,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * IS THIS BOOK DUE? — and the two books on this desk answer differently.
   *
   * A RECENTER book keeps the tick-coalescing rule it has always had, to the
   * line: it evaluates when its chain has ticked since its last pass, and the
   * stamp it records is the VIEW's own last tick rather than a wall clock (which
   * would compare two clocks and starve a quiet feed) and rather than this
   * process's feed-wide maximum (`#lastTickMs` counts ticks the view DROPPED for
   * undeclared chains, so a busy unrelated instrument would push the stamp past
   * the newest admitted tick and hold this book until something newer arrived).
   *
   * A DELTA-LEAN book is paced by `dl_eval_min_ms` instead. Its controller is
   * specified to run once a second (spec §6) and the timer here fires every
   * 250 ms, so without this gate every delta-lean book would run the regime
   * detector, mark its whole chain and re-read `desk-books` four times a second.
   * The tick gate cannot do that job — a tape that ticks ten times a second
   * passes it every time — and the cadence gate cannot do the tick gate's, which
   * is why they are two rules rather than one.
   *
   * Both stamps are written by the pass that is ADMITTED, so a book held by
   * either gate is asked again on the very next timer.
   */
  #due(runtime: BookRuntime): boolean {
    const dials = runtime.book.dials
    if (dials.delta_lean_enabled) {
      const nowMs = this.#d.now()
      if (nowMs - runtime.lastEvalMs < dials.dl_eval_min_ms) return false
      runtime.lastEvalMs = nowMs
      return true
    }
    // A demo-marked book is also woken by its own exchange's ticks.
    const demo = this.#marksVenue(runtime.book) === 'demo'
    const prodNew = this.#chain.touchedSince(runtime.lastEvalTickMs)
    const demoNew = demo && this.#demoChain.touchedSince(runtime.lastEvalDemoTickMs)
    if (!prodNew && !demoNew) return false
    runtime.lastEvalTickMs = this.#chain.lastTickMs
    runtime.lastEvalDemoTickMs = this.#demoChain.lastTickMs
    return true
  }

  /** The 1-second poll. Only books actually holding a decision are asked. */
  async pollFlights(): Promise<void> {
    for (const runtime of [...this.#hosts.values()]) {
      if (this.#stopping) return
      if (runtime.host.inFlight === null) continue
      try {
        await runtime.host.pollInFlight()
      } catch (err) {
        this.#d.log.error('an in-flight poll failed — the id is kept and asked again', {
          key: runtime.book.key,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Every timer, `.unref()`ed.
   *
   * Unref'ed so a supervisor with nothing to do cannot be the reason the process
   * refuses to exit: pm2 stops it by signal, and a held timer turns a stop into
   * a kill. The bus socket and the health server are the same.
   */
  #arm(): void {
    const every = (ms: number, what: string, fn: () => Promise<void>): void => {
      const timer = setInterval(() => {
        if (this.#stopping) return
        void fn().catch((err: unknown) => {
          this.#d.log.error(`${what} failed`, {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }, ms)
      timer.unref()
      this.#timers.push(timer)
    }

    every(EVALUATE_MS, 'the evaluation pass', async () => await this.evaluateDue())
    every(IN_FLIGHT_MS, 'the in-flight poll', async () => await this.pollFlights())
    every(REGISTRY_MS, 'the registry poll', async () => await this.#registry.run())
    every(SUBSCRIPTION_MS, 'the subscription refresh', async () => await this.#publishSubscriptions())
    every(MARGIN_MS, 'the margin poll', async () => {
      await this.#margin.refresh([...new Set([...this.#hosts.values()].map((r) => r.book.tag))])
      await this.#refreshMarginModes()
    })
    every(HEARTBEAT_MS, 'the lease heartbeat', async () => await this.#heartbeat())
  }

  /**
   * Keep the lease, and LEARN IT IF WE LOST IT.
   *
   * A process paused past the TTL wakes up believing it steers. `heartbeat()` is
   * fenced on the owner id, so once somebody else has taken over it answers
   * false — and the only safe response is to stop steering at once. Re-claiming
   * silently would put two supervisors on one book, which is the failure this
   * whole mechanism exists to prevent (`lease.ts`).
   */
  async #heartbeat(): Promise<void> {
    if (await this.#d.lease.heartbeat()) return
    this.#d.log.error(
      'THE LEASE IS GONE — another supervisor has taken these books. This process stops steering ' +
        'immediately and stays up as a standby; it places nothing.',
      { books: this.books },
    )
    for (const timer of this.#timers.splice(0)) clearInterval(timer)
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const key of [...this.#hosts.keys()]) await this.#stop(key)
    // Not an exit: pm2 would restart it into the same standby state, and a
    // process that is up and honestly reporting "no lease, no books" on
    // `/health` is more use than a restart loop.
    void this.#acquireLease().then(
      async () => {
        if (!this.#stopping) await this.#reboot()
      },
      () => undefined,
    )
  }

  /** Take the books back after a lease was lost and then re-won. */
  async #reboot(): Promise<void> {
    await this.#registry.run()
    await this.#warmStart()
    await this.#publishSubscriptions()
    this.#subscribeFeeds()
    this.#arm()
    this.#d.log.warn('the lease was re-acquired — steering again', { books: this.books })
  }
}

// ──────────────────────────────────────────────────────────── the process

function required(name: string): string {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`)
  return v
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/**
 * The process logger, gated by `DESK_LOG_LEVEL` (default `info`).
 *
 * WHY A GATE AT ALL: `debug` fires once per book per evaluation tick — about
 * ten lines a second across a live desk, nearly all of them "held, nothing to
 * do". Nothing filtered them, so ordinary operation wrote hundreds of
 * megabytes onto the same volume the journals and the Mongo dbpath live on;
 * the box was at 88% when this was found. `info` keeps every decision, warning
 * and error, and drops only the per-tick noise.
 *
 * An UNRECOGNISED value falls back to `info` rather than throwing or silencing:
 * a typo in a deploy env must not take the desk's logs away at the moment
 * someone needs them, and must not stop the supervisor from booting either.
 */
function makeLogger(): HostLog {
  const want = (process.env['DESK_LOG_LEVEL'] ?? 'info').trim().toLowerCase()
  const asked = LOG_LEVELS.indexOf(want as (typeof LOG_LEVELS)[number])
  const floor = asked === -1 ? LOG_LEVELS.indexOf('info') : asked
  const emit =
    (level: string, rank: number) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      if (rank < floor) return
      const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`
      console.log(`[supervisor] ${new Date().toISOString()} ${level} ${line}`)
    }
  return {
    debug: emit('debug', 0),
    info: emit('info', 1),
    warn: emit('warn', 2),
    error: emit('error', 3),
  }
}

/**
 * `OptionMaster`, as `MasterPort`. The one place the dump's shape is read.
 *
 * On DX the `instrument` collection holds Delta's BTC options in the same row
 * shape (marketdata's dx sync: `name` BTC, CE/PE, `lot_size` 0.001, the tick
 * the exchange states), so every question but one is answered the same way.
 * THE FUTURE IS NEVER ONE OF THEM there: Delta settles its options on the
 * index, and a BTC future the sync happened to list would be a forward that
 * is not the settlement's. `0` sends the chain to the index proxy.
 */
export function masterPort(
  master: () => OptionMaster,
  venue: VenueSpec = NSE,
  /** Token → `dx_leverage`, read beside the master (`loadDxLeverage`). */
  leverage: () => ReadonlyMap<number, number> = () => new Map(),
): MasterPort {
  return {
    leverageFor: (symbol, expiry, strike, optType): number | null => {
      const token = master().resolve(symbol, expiry, strike, optType)?.instrumentToken
      return token === undefined ? null : (leverage().get(token) ?? null)
    },
    tokensFor: (symbol, expiry): ChainToken[] => {
      const m = master()
      const rows: ChainToken[] = []
      for (const strike of m.strikes(symbol, expiry)) {
        for (const optType of ['CE', 'PE'] as const) {
          const ref = m.resolve(symbol, expiry, strike, optType)
          if (ref?.instrumentToken === undefined) continue
          rows.push({ token: ref.instrumentToken, strike, optType, instrument: ref.tradingsymbol })
        }
      }
      return rows
    },
    // The chain's own expiry is NOT used: `future(underlying)` is the
    // nearest-expiry future, which is the forward the desk marks against
    // (`marks.ts`), and an option chain three months out is still priced off it.
    futureToken: (symbol): number =>
      venue.id === 'nse' ? (master().future(symbol)?.instrumentToken ?? 0) : 0,
    instrumentFor: (symbol, expiry, strike, optType): string | null =>
      master().resolve(symbol, expiry, strike, optType)?.tradingsymbol ?? null,
    tickSizeFor: (symbol, expiry, strike, optType): number | null =>
      master().resolve(symbol, expiry, strike, optType)?.tickSize ?? null,
    chainMeta: (symbol, expiry): { lotSize: number; step: number } => {
      const meta = master().chain(symbol, expiry)
      return { lotSize: meta?.lotSize ?? 0, step: meta?.strikeStep ?? 0 }
    },
  }
}

/** desk-api over HTTP, as `DeskApiPort`. */
function deskApi(baseUrl: string, token: string, log: HostLog): DeskApiPort {
  const url = baseUrl.replace(/\/+$/, '')
  const post = async (path: string, body: unknown): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    timer.unref?.()
    try {
      return await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    /**
     * BEST EFFORT. `actual` is what the dashboard renders beside `desired`, and
     * a heartbeat that could fail a poll pass would let one slow HTTP call stop
     * every book from being evaluated. It is re-sent every five seconds anyway.
     */
    reportActual: async (book, actual, lastMarkAt, lastDecision): Promise<void> => {
      try {
        const res = await post(
          `/v1/desk/books/registry/${encodeURIComponent(book.tag)}/actual`,
          { mode: book.mode, actual, lastMarkAt, lastDecision },
        )
        if (!res.ok) {
          log.warn('the actual-state report was refused — the page will show this book stopped', {
            key: book.key,
            status: res.status,
          })
        }
      } catch (err) {
        log.warn('the actual-state report could not be sent', {
          key: book.key,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    /**
     * THROWS on failure, unlike the report above: the caller counts a cancel it
     * could not file as NOT cancelled and asks again, because a guard is waiting
     * behind it. 202 is the success — the request has been accepted, not
     * performed (`routes/desk.ts`).
     */
    cancelOrder: async (brokerOrderId): Promise<void> => {
      const res = await post(
        `/v1/desk/broker/orders/${encodeURIComponent(brokerOrderId)}/cancel`,
        {},
      )
      if (!res.ok) throw new Error(`cancel refused: HTTP ${String(res.status)}`)
    },
  }
}

export async function main(): Promise<void> {
  const log = makeLogger()
  /**
   * FIRST LINE OF MAIN, and shared with the gateway and the runner rather than
   * copied (audit F-41). Two failures learned the hard way: an unhandled
   * rejection is fatal on Node 24, so one Mongo blip inside a `void` call takes
   * the process down mid-session (G4); and a boot that EXITS on an unreachable
   * Mongo burns pm2's restart budget in ~70 seconds and never comes back when
   * Mongo does (G6). This process is `void`-fired intervals from top to bottom.
   */
  installCrashGuards({ process, log: (msg, ctx) => log.error(msg, ctx) })

  const mongoUrl = required('DESK_MONGO_URL')
  const token = required('DESK_API_TOKEN')
  const apiUrl = process.env['DESK_API_URL'] ?? 'http://127.0.0.1:8890'
  const busUrl = process.env['DESK_BUS_URL'] ?? 'ws://127.0.0.1:8891'
  const portRaw = Number(process.env['DESK_SUPERVISOR_PORT'] ?? '')
  const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : SUPERVISOR_NUDGE_PORT_DEFAULT
  // ONCE, here, and never again: a revert that changed under a running process
  // would reprice books mid-pass. Said out loud, with the raw value, so a typo
  // that left the books on their own dials is the first thing an operator sees.
  // The venue, ONCE: a bad DESK_VENUE throws here, before anything is steered.
  const venue = venueFromEnv(process.env)
  log.info('venue', { DESK_VENUE: process.env['DESK_VENUE'] ?? null, venue: venue.id })
  const chainForward = chainForwardOverride(process.env)
  log.info('chain forward', {
    DESK_CHAIN_FORWARD: process.env['DESK_CHAIN_FORWARD'] ?? null,
    pricing:
      chainForward === 'future'
        ? 'every book off the near-month future mid (dl_parity_forward overridden)'
        : 'per book: dl_parity_forward delta-lean books off their own parity forward',
  })

  const mongo = await connectWithRetry(() => connectMongo(mongoUrl), {
    log: (msg, ctx) => log.warn(msg, ctx),
    what: 'mongo',
  })

  let master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
  /** Delta's per-product leverage, for the BULL-S margin budget. Empty off DX. */
  let leverage = await loadDxLeverage(mongo.db.collection('instrument') as never)
  log.info('instrument master loaded', { contracts: master.optionCount, withLeverage: leverage.size })
  const refresh = setInterval(() => {
    void (async () => {
      try {
        master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
        leverage = await loadDxLeverage(mongo.db.collection('instrument') as never)
      } catch (err) {
        log.error('the instrument master could not be refreshed', { error: String(err) })
      }
    })()
  }, INSTRUMENT_MS)
  refresh.unref()

  await ensureSubscriptionIndexes(mongo.db.collection(SUBSCRIPTION_COLLECTION) as never)

  const bus = new WsTransportClient({ url: busUrl })
  const lease = new Lease({
    collection: mongo.db.collection(SUPERVISOR_LEASE_COLLECTION) as never,
    // ONE KEY, process-wide: this supervisor steers every book it is given, so
    // the exclusion it needs is over the ROLE, not over a tag. `lease.ts` scopes
    // to `${tag}:${mode}` the day books are spread across machines.
    key: 'desk-supervisor',
    now: () => Date.now(),
  })

  const supervisor = new Supervisor({
    db: mongo.db,
    bus,
    client: new DecisionsClient(apiUrl, token, { log: (msg, ctx) => log.warn(msg, ctx) }),
    api: deskApi(apiUrl, token, log),
    master: () => masterPort(() => master, venue, () => leverage),
    venue,
    lease,
    // The host name and pid, so a `/health` or a lease document names the
    // process an operator has to go and look at.
    owner: `${process.env['HOSTNAME'] ?? 'host'}:${String(process.pid)}`,
    now: () => Date.now(),
    log,
    chainForward,
    server: createNudgeServer({
      port,
      token,
      onNudge: (kind) => supervisor.nudge(kind),
      health: () => supervisor.health(),
      log,
    }),
  })

  /**
   * THE SERVER LISTENS BEFORE THE BOOT IS AWAITED, deliberately: `boot()` waits
   * for the lease and a standby's wait has no end, so a health endpoint that
   * only came up afterwards would make a correctly-waiting standby look like a
   * process that failed to start.
   */
  await supervisor.server?.listen()
  log.info('nudge server listening', { port })

  const shutdown = (signal: string): void => {
    void supervisor
      .stop(signal)
      .catch((err: unknown) => log.error('shutdown failed', { error: String(err) }))
      .then(() => mongo.close())
      .then(() => process.exit(0))
    // Never let a hung connection hold the process open through a restart.
    setTimeout(() => {
      log.error('shutdown did not finish in time — exiting anyway; nothing was traded')
      process.exit(1)
    }, SHUTDOWN_FUSE_MS).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  await supervisor.boot()
}
