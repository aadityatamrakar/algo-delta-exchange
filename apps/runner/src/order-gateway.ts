/**
 * The `orders` port for hosted strategies: an HTTP POST to `/v1/desk/submit`.
 *
 * A hosted strategy does NOT get a private path to a broker. It goes through
 * the bridge exactly as the Python desk does, so the strategy switch, the kill
 * switch, the live allowlist, the freeze split and the `desk-order-events`
 * journal all apply to it without this file knowing any of them exist. That is
 * the whole point of running strategies in-process: it changes who runs the
 * loop, not who is allowed to trade.
 *
 * SIZING IS NOT APPLIED HERE. `liveLots` overrides the strategy's own lots on
 * the bridge side, off the registry row, because that is where it can be
 * matched against the order that actually went out. Applying it here as well
 * would be a multiplier, which is the exact `xtsOrder.js` failure the override
 * exists to design out.
 *
 * THE LEDGER. A hosted strategy's positions are not in `desk-books` (that is
 * the Python desk's book). The runner therefore keeps its own ledger of what it
 * has successfully submitted, for two things it genuinely needs: `openPositions`
 * on the runtime row, and `flattenAll()` — the kill-switch/EOD flatten, which
 * cannot mean "do nothing" just because nobody else is tracking the position.
 * It is deliberately built from ACCEPTED SUBMITS ONLY, at the size that
 * ACTUALLY ROUTED: it is a record of orders we know went to a rail, not a claim
 * about broker state, and the reconciliation against real fills belongs to the
 * order gateway. Where the bridge does not know what routed
 * (`indeterminate: true`), nothing is booked and the id is retried — see
 * `#idFor` and the indeterminate branch of `submit()`.
 */

import { makeId, type Clock } from '@algomaker/core'
import type {
  InstrumentRef,
  Logger,
  OrderGateway,
  StateStore,
  SubmitRequest,
  SubmitResult,
} from '@algomaker/strategy-kit'

export interface LedgerEntry {
  readonly tradingsymbol: string
  readonly instrument: InstrumentRef
  /** Signed LOTS. Negative is short, so a round trip sums to zero. */
  readonly lots: number
  /**
   * The last price this leg was known to be worth, persisted with it.
   *
   * IT IS WHAT MAKES A LATE FLATTEN POSSIBLE. `/v1/desk/submit` resolves a fill
   * price as `marks.price() ?? referencePrice ?? limitPrice ?? refuse`, and its
   * `QuoteCache` declares the feed dead 120 seconds after the last tick. So a
   * 15:30 backstop that runs even slightly late — a slow shutdown, a retry
   * after a refused first attempt, a restart at 15:33 — finds the mark cache
   * empty, sends no price of its own, and is REFUSED. It then retries every 60
   * seconds and is refused every time, all night, while a real position sits at
   * the broker. Carrying the price on the ledger entry means the exit can state
   * one even when nothing is ticking.
   *
   * Optional because a leg booked from a submit that carried no price at all
   * has nothing honest to record, and inventing 0 would journal a fill at zero
   * — the exact "profit that was never made" the bridge refuses orders to
   * prevent.
   */
  readonly lastPrice?: number
  /**
   * The CONTRACT's expiry ('YYYY-MM-DD'), when it is known. Audit F-6a.
   *
   * It is here for one reason: an expired contract can never receive an exit.
   * On 2026-08-10 `MIRROR_A006` was holding three SENSEX legs from the 6 Aug
   * expiry — gone from the instrument master, unroutable, and invisible to
   * `flattenTag`, which rebuilds from `desk-fills` and has no mirror rows in
   * it. Nothing in the system could ever have closed them, and nothing said so.
   * Recording the expiry is what lets `dropExpired` remove a leg that is
   * provably dead rather than leaving it to be swept by hand.
   *
   * OPTIONAL, AND ABSENT MEANS "NOT KNOWN", NEVER "NOT EXPIRED".
   * `InstrumentRef` does not carry an expiry, so this is filled from the
   * instrument dump by the gateway's `expiryOf` port when it can answer, and
   * left off when it cannot. `dropExpired` therefore never touches an entry
   * without one: dropping a leg the upstream account still holds books its
   * eventual mirrored exit against an empty ledger, which OPENS a phantom
   * position the other way — strictly worse than the stuck leg.
   */
  readonly expiry?: string
}

/**
 * An entry a sweep or an operator clear removed. Same shape as the entry it
 * came from — the journal names the symbol, the SIGNED size and the expiry,
 * because "3 legs dropped" is not something an operator can check afterwards.
 */
export type DroppedEntry = LedgerEntry

/**
 * An IST calendar date, 'YYYY-MM-DD'.
 *
 * The expiry sweep compares calendar days, and the host may be on UTC: deriving
 * "today" from the host's local zone would keep a contract alive for five and a
 * half hours after it expired, or — worse, on a UTC host after 18:30 — declare
 * tomorrow's expiry already past and drop a live leg.
 */
export function istDateOf(epochMs: number): string {
  return new Date(epochMs + 5.5 * 60 * 60_000).toISOString().slice(0, 10)
}

/** `YYYY-MM-DD`, and a real date. A malformed expiry is treated as unknown. */
function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
}

/**
 * The expiry an instrument states about itself, when it states one.
 *
 * `InstrumentRef` has no `expiry` field today, so this is a STRUCTURAL read: a
 * resolver that carries one (the optionbhai instrument map, a future
 * `InstrumentRef`) is honoured, and one that does not costs nothing. It is
 * never derived from the trading symbol — parsing '25AUG' out of a symbol is
 * exactly the guessing that F-6's "symbol drift" mechanism is made of.
 */
function statedExpiry(instrument: InstrumentRef): string | undefined {
  const raw = (instrument as { readonly expiry?: unknown }).expiry
  return isIsoDate(raw) ? raw : undefined
}

/** One broker-bound order a submission became. `/v1/desk/submit`'s `orders[]`. */
interface RoutedOrder {
  readonly clientOrderId?: string
  readonly lots?: number
  readonly qty?: number
}

/**
 * The `/v1/desk/submit` response shape this adapter reads.
 *
 * Every field is optional here on purpose: this is a wire type, parsed from
 * whatever the bridge actually sent, not a copy of the bridge's own union. The
 * four branches that matter are narrowed in `submit()`:
 *
 *   `accepted: true`  + `status: 'DONE'`    — everything routed.
 *   `accepted: true`  + `status: 'FAILED'`  — PARTIAL: `routedLots` < `intendedLots`.
 *   `accepted: false` + `status: 'DONE'|'FAILED'` — nothing routed, `routedLots: 0`.
 *   `accepted: false` + `status: 'ROUTING'` + `indeterminate: true` — UNKNOWN.
 *
 * `routedLots` is the number to book. `lots` is now an alias of it (it used to
 * be the INTENDED size, which is the bug this adapter had); `intendedLots` is
 * the attempted size after the `liveLots` override, and booking it is exactly
 * what strands lots at flatten time. `orders[]` is the tranches that actually
 * reached a rail and is what an older bridge is read from.
 */
interface SubmitApiResponse {
  readonly accepted?: boolean
  readonly status?: 'ROUTING' | 'DONE' | 'FAILED'
  readonly indeterminate?: boolean
  readonly clientOrderId?: string
  readonly reason?: string
  readonly routedLots?: number
  readonly lots?: number
  readonly intendedLots?: number
  readonly requestedLots?: number
  readonly orders?: readonly RoutedOrder[]
  readonly plannedOrders?: readonly RoutedOrder[]
  readonly errors?: readonly string[]
}

/**
 * A 4xx from the bridge: the REQUEST was rejected — a malformed body, or a tag
 * that is not registered (403, exactly as `/actions` answers a typo).
 *
 * Definite, and distinguished from every other transport failure for two
 * reasons: it is thrown before a submission claim can exist, so nothing routed
 * and nothing can be replayed; and retrying it is not a retry, it is the same
 * rejection three times. Treating it as "outcome unknown" would also park the
 * intent in `#unresolved` forever, which would stop a misconfigured strategy
 * from ever placing that order again even after the misconfiguration is fixed.
 */
class BridgeRejectedRequest extends Error {}

/** Attempts per submit — all of them under the SAME `clientOrderId`. */
const SUBMIT_ATTEMPTS = 3
/** Gap between those attempts. A lost response usually resolves on the next one. */
const RETRY_DELAY_MS = 200

/**
 * The state key one instance's ledger lives under, inside its `TAG:mode` scope.
 *
 * EXPORTED because the bridge reads these documents to serve
 * `GET /v1/desk/runner/positions` and to check that an instance exists before
 * it parks a clear request. That route had the string typed out again (F-53):
 * two processes agreeing on a Mongo key by coincidence, where renaming it here
 * would have left the admin endpoint reading a key nothing writes and reporting
 * an empty desk rather than failing.
 */
export const POSITIONS_KEY = 'runner:positions'

/**
 * Per-strategy net position, persisted so a restart does not forget it.
 *
 * The legacy system's defining gap: positions lived in process memory, so a
 * 12:30 pm2 restart lost them and the flatten at 15:20 had nothing to flatten.
 * Everything here goes through the injected `StateStore`.
 */
export class PositionLedger {
  readonly #state: StateStore
  readonly #key: string
  #entries = new Map<string, LedgerEntry>()
  /** Whether anything has been booked since construction. See `load()`. */
  #applied = false

  constructor(state: StateStore, key = POSITIONS_KEY) {
    this.#state = state
    this.#key = key
  }

  /**
   * Load from storage. ONCE, at boot, before the strategy that owns it exists.
   *
   * `load()` replaces the whole map, so an `apply()` that lands first is
   * silently discarded — and this is the only durable record of a hosted
   * position, so what is discarded is a position that is really open. It used
   * to be called as `void ledger.load()` from inside a synchronous factory,
   * which is exactly that race: an order placed by `start()`'s job catch-up
   * could be booked and then erased by a load still in flight.
   *
   * Throwing on a late load rather than quietly returning is deliberate: the
   * call is a programming error, and the failure it causes otherwise (a
   * position that flatten cannot see) surfaces hours later as an open position
   * nobody can explain.
   */
  async load(): Promise<void> {
    if (this.#applied) {
      throw new Error(
        `PositionLedger.load() called after ${this.#entries.size} booked position(s) — ` +
          'it would discard them; load at boot, before anything can submit',
      )
    }
    const stored = await this.#state.get<LedgerEntry[]>(this.#key)
    this.#entries = new Map((stored ?? []).map((e) => [e.tradingsymbol, e]))
  }

  async #save(): Promise<void> {
    await this.#state.set(this.#key, [...this.#entries.values()])
  }

  /**
   * Fold an accepted order in. A leg that nets to zero is REMOVED rather than
   * kept at zero, so `openCount` means open positions and not "symbols ever
   * traded today".
   *
   * `price` is the best price KNOWN AT BOOK TIME — see `LedgerEntry.lastPrice`.
   * An absent one leaves whatever was already recorded in place rather than
   * erasing it: a stale price is still a usable `referencePrice` for a flatten,
   * and no price at all is a refused flatten.
   */
  async apply(
    instrument: InstrumentRef,
    side: 'BUY' | 'SELL',
    lots: number,
    price?: number,
    expiry?: string,
  ): Promise<void> {
    this.#applied = true
    const key = instrument.tradingsymbol
    const signed = side === 'BUY' ? lots : -lots
    const previous = this.#entries.get(key)
    const next = (previous?.lots ?? 0) + signed
    if (next === 0) this.#entries.delete(key)
    else {
      const lastPrice = price !== undefined && Number.isFinite(price) && price > 0
        ? price
        : previous?.lastPrice
      /**
       * Stated by the caller first (the gateway's `expiryOf` port, which reads
       * the instrument dump), then by the instrument itself, then whatever was
       * already recorded. An absent answer never ERASES a recorded expiry —
       * the same rule `lastPrice` follows, and for a sharper reason: an entry
       * that loses its expiry becomes unsweepable, so the leg goes back to
       * being permanent.
       */
      const known = (isIsoDate(expiry) ? expiry : undefined) ?? statedExpiry(instrument) ?? previous?.expiry
      this.#entries.set(key, {
        tradingsymbol: key,
        instrument,
        lots: next,
        ...(lastPrice === undefined ? {} : { lastPrice }),
        ...(known === undefined ? {} : { expiry: known }),
      })
    }
    await this.#save()
  }

  /**
   * SET one symbol's net to an ABSOLUTE size — broker truth, not a fold.
   *
   * This exists for the mirror position sync (`applySyncRequest`): the ledger
   * books optimistically at submit time and nothing ever corrected it against
   * the broker's book, so a rejected-after-accept, a partial the bridge did not
   * report, or a fill that never happened left the ledger wrong for the rest of
   * the session. The bridge now computes what the broker ACTUALLY holds and
   * files it as an absolute, and an absolute is the only safe shape for that:
   * a delta folded into a ledger that has moved since the detector read it
   * corrects the wrong number (the 2026-08-03 ITC resize desync, in miniature),
   * where an absolute is idempotent — the same correction applied twice lands
   * on the same book.
   *
   * ZERO REMOVES THE ENTRY rather than keeping it at zero, for the same reason
   * `apply()` deletes a leg that nets out: `openCount` means open positions,
   * not "symbols the broker ever mentioned".
   *
   * An existing entry's `lastPrice` and `expiry` SURVIVE a set that states no
   * new ones — the same rule as `apply()`, for the same two reasons: a stale
   * price is still a usable `referencePrice` for a late flatten, and an entry
   * that loses its expiry becomes unsweepable, so the leg goes back to being
   * permanent.
   */
  async set(instrument: InstrumentRef, lots: number, price?: number): Promise<void> {
    const key = instrument.tradingsymbol
    if (lots === 0) {
      // Nothing held and nothing asked for: no booking happened, so this does
      // not count as an `#applied` for `load()`'s late-load guard, and it must
      // not cost a Mongo write on a correction that already agrees with us.
      if (!this.#entries.delete(key)) return
      this.#applied = true
      await this.#save()
      return
    }
    this.#applied = true
    const previous = this.#entries.get(key)
    const lastPrice =
      price !== undefined && Number.isFinite(price) && price > 0 ? price : previous?.lastPrice
    const known = statedExpiry(instrument) ?? previous?.expiry
    this.#entries.set(key, {
      tradingsymbol: key,
      instrument,
      lots,
      ...(lastPrice === undefined ? {} : { lastPrice }),
      ...(known === undefined ? {} : { expiry: known }),
    })
    await this.#save()
  }

  open(): readonly LedgerEntry[] {
    return [...this.#entries.values()]
  }

  get openCount(): number {
    return this.#entries.size
  }

  /**
   * The SIGNED net for one symbol; 0 for a symbol this ledger has never held.
   *
   * Exists for the mirror adapter (F-6b/6c): it has no position state of its
   * own, so "is this order an exit?" and "would this order cross flat?" are
   * questions only the ledger can answer. Returning 0 for an unknown symbol is
   * the honest answer AND the safe one — an order into a symbol we hold nothing
   * of is an entry, which is exactly how a mirrored position starts.
   */
  netLots(tradingsymbol: string): number {
    return this.#entries.get(tradingsymbol)?.lots ?? 0
  }

  /**
   * Remove every leg whose contract expired BEFORE `todayIst`, and say which.
   *
   * THE THREE RULES, each of which is a position-safety property:
   *
   *  - STRICTLY BEFORE. A contract expiring today is still tradable today
   *    (`OptionMaster.nearestExpiry` uses the same `>=` for the same reason),
   *    and an exit on expiry day is the most valuable exit there is.
   *  - NO RECORDED EXPIRY, NO DROP. Absent means "not known", never "not
   *    expired" — see `LedgerEntry.expiry`.
   *  - IT DOES NOT TRADE. This is bookkeeping for a contract that cannot be
   *    routed any more; the position at the broker, if any, expired with it.
   *    An entry removed here is journalled by the caller precisely because
   *    nothing else will ever mention it again.
   */
  async dropExpired(todayIst: string): Promise<readonly DroppedEntry[]> {
    return this.#remove((e) => isIsoDate(e.expiry) && e.expiry < todayIst)
  }

  /**
   * Remove named symbols — the operator's audited clear (F-6d).
   *
   * It is on the LEDGER, and the RUNNER calls it, because this object is the
   * single writer of the `runner:positions` document: `main.ts` caches one
   * instance per `tag:mode` at boot and every `#save()` writes the whole map, so
   * an edit made anywhere else is silently undone by the next booked order.
   * That is the whole reason clearing a stuck mirror leg used to mean stopping
   * the runner first.
   */
  async drop(symbols: readonly string[]): Promise<readonly DroppedEntry[]> {
    const wanted = new Set(symbols)
    return this.#remove((e) => wanted.has(e.tradingsymbol))
  }

  /** Remove everything. `drop` over the current keys, so one path saves. */
  async dropAll(): Promise<readonly DroppedEntry[]> {
    return this.#remove(() => true)
  }

  async #remove(predicate: (entry: LedgerEntry) => boolean): Promise<readonly DroppedEntry[]> {
    const dropped: DroppedEntry[] = []
    for (const [key, entry] of [...this.#entries]) {
      if (!predicate(entry)) continue
      dropped.push(entry)
      this.#entries.delete(key)
    }
    if (dropped.length === 0) return dropped
    // A removal is a booking as far as `load()` is concerned: a load arriving
    // after it would restore the very legs that were just swept.
    this.#applied = true
    await this.#save()
    return dropped
  }
}

/** Where an operator's clear request is parked, under the `TAG:mode` scope. */
export const CLEAR_REQUEST_KEY = 'runner:clear-request'

/**
 * HOW LONG A PARKED CLEAR IS STILL AN INSTRUCTION. One hour.
 *
 * A clear is an operator's NOW-intention — "that leg is not real, drop it" said
 * while looking at the ledger — and not a standing order. It is also the one
 * control in this process that removes a position without placing an order, so
 * the cost of applying a spent one is the worst kind: a book that is really open
 * and a ledger that says it is not.
 *
 * The bridge 202-accepts a clear for any instance whose `runner:positions`
 * document exists, including a tag this process no longer hosts, so a request
 * can sit unconsumed indefinitely. An hour comfortably covers the intended path
 * (the runner applies it on its 15-second sync, or at its next boot) and expires
 * everything else.
 */
export const DEFAULT_CLEAR_REQUEST_TTL_MS = 3_600_000

/**
 * The TTL from the environment, refusing anything that is not a positive number.
 *
 * Same shape and same reasoning as `positiveEnvMs` in `apps/order-gateway` and
 * `apps/api`: every comparison against NaN is false, so `'15m'` would make
 * `age > ttl` false for every request and silently disable the control this
 * function configures.
 */
export function clearRequestTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DESK_CLEAR_REQUEST_TTL_MS']
  if (raw === undefined || raw.trim() === '') return DEFAULT_CLEAR_REQUEST_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLEAR_REQUEST_TTL_MS
}

/**
 * What the bridge writes and this process consumes.
 *
 * `symbols` is a list, or one of two selectors: `'expired'` (the sweep, on
 * demand) and `'all'` (flatten the book to nothing). `requestedBy` is the
 * operator's name — the audit trail the old stop-edit-start runbook had none of.
 *
 * `requestedAt` is REQUIRED, and it is read rather than merely recorded: it is
 * what makes the request expire (see `DEFAULT_CLEAR_REQUEST_TTL_MS`). A document
 * without one cannot be dated at all and is therefore indistinguishable from a
 * month-old one, so `applyClearRequest` refuses it — see the `undated` branch.
 */
export interface ClearRequest {
  readonly symbols: readonly string[] | 'expired' | 'all'
  readonly requestedBy?: string
  readonly requestedAt: number
}

/**
 * Apply a pending clear request to ONE instance's ledger, then delete it.
 *
 * WHY THE REQUEST IS A DOCUMENT AND NOT AN API CALL: `main.ts` caches a
 * `PositionLedger` per `tag:mode` for the life of the process and every
 * `#save()` rewrites the whole map, so a `runner:positions` document edited by
 * anyone else is undone by the next booked order. Clearing therefore has to
 * happen HERE, on this process's own sync cadence, through the object that owns
 * the document. The bridge's `/v1/desk/runner/positions/clear` writes the
 * request and nothing else; single-writer is preserved rather than suspended
 * for the duration of an admin action.
 *
 * IT IS IDEMPOTENT AND IT ALWAYS CONSUMES THE REQUEST — including when the
 * request matched nothing, and including when it is unreadable. A request left
 * behind would be re-applied on every sync, which for a `'all'` selector means
 * every leg opened after it was raised would be silently dropped too.
 *
 * AND IT ENFORCES THE TTL ITSELF, not only in the sweep that calls it. That is
 * deliberate duplication: the race this closes is a tag being RE-ADDED to the
 * catalogue while an ancient request for it is still parked, at which point the
 * instance appears in `ledgers` and reaches this function through the ordinary
 * hosted path. The check has to be where the drop is.
 */
export async function applyClearRequest(deps: {
  /** `TAG:mode`, for the journal. */
  readonly instance: string
  readonly ledger: PositionLedger
  readonly state: StateStore
  /** Today's IST date, for the `'expired'` selector. */
  readonly todayIst: string
  /** Now, epoch ms — what the request's age is measured against. */
  readonly nowMs: number
  /** Older than this and the request is refused. See `clearRequestTtlMs`. */
  readonly ttlMs: number
  readonly log: Logger
}): Promise<readonly DroppedEntry[]> {
  const raw = await deps.state.get<ClearRequest>(CLEAR_REQUEST_KEY)
  if (raw === null || typeof raw !== 'object') return []

  const selector = (raw as ClearRequest).symbols
  const requestedBy = typeof raw.requestedBy === 'string' ? raw.requestedBy : 'unknown'
  const named =
    selector === 'expired' || selector === 'all'
      ? selector
      : Array.isArray(selector) && selector.length > 0 && selector.every((s) => typeof s === 'string' && s !== '')
        ? (selector as readonly string[])
        : null

  if (named === null) {
    // Consumed, because a request nothing can read would otherwise be re-logged
    // on every sync forever — but never guessed at: the only two ways to reach
    // here are a hand-edited document and a bridge that has changed shape, and
    // acting on either would be inventing an instruction to empty a ledger.
    deps.log.error(
      `runner: UNREADABLE clear-request for ${deps.instance} — nothing was dropped, the request is discarded`,
      { requestedBy, symbols: JSON.stringify(selector).slice(0, 200) },
    )
    await deps.state.delete(CLEAR_REQUEST_KEY)
    return []
  }

  /**
   * A CLEAR IS AN OPERATOR'S NOW-INTENTION, NOT A STANDING ORDER.
   *
   * `requestedAt` was written from the first version of this feature and read by
   * nothing, so a request nobody consumed stayed armed forever — the tag retired
   * from the catalogue, the request parked, and then weeks later the tag is
   * re-added and the runner's first sync applies it against a book that has
   * nothing to do with what the operator was looking at when they clicked. With
   * `symbols: 'all'` that empties a ledger of live positions.
   *
   * REFUSED AND DELETED, not refused and left: leaving it re-logs the same
   * refusal every fifteen seconds forever, and the point is that this request is
   * finished. LOUDLY, and naming its age, because the operator's clear did not
   * happen and the only place that can now be said is the log.
   *
   * An UNDATED request lands here too. It cannot be aged, so it cannot be shown
   * to be current, and the only ways to produce one are a hand-edited document
   * or a bridge older than this field — neither of which is evidence that
   * somebody is at the keyboard right now. Re-raising it costs one click.
   */
  const requestedAt =
    typeof raw.requestedAt === 'number' && Number.isFinite(raw.requestedAt) ? raw.requestedAt : null
  const requested = named === 'expired' || named === 'all' ? named : named.join(',')
  if (requestedAt === null) {
    deps.log.error(
      `runner: UNDATED clear-request for ${deps.instance} REFUSED — it carries no requestedAt, so ` +
        'it cannot be shown to be current; nothing was dropped, raise it again',
      { requestedBy, requested, ttlMs: deps.ttlMs },
    )
    await deps.state.delete(CLEAR_REQUEST_KEY)
    return []
  }
  const ageMs = deps.nowMs - requestedAt
  if (ageMs > deps.ttlMs) {
    deps.log.error(
      `runner: STALE clear-request for ${deps.instance} REFUSED — raised ${Math.round(ageMs / 60_000)} ` +
        `minute(s) ago, past its ${Math.round(deps.ttlMs / 60_000)}-minute life; a clear is an ` +
        'operator\'s now-intention, not a standing order. Nothing was dropped, raise it again',
      { requestedBy, requested, ageMs, ttlMs: deps.ttlMs, requestedAt },
    )
    await deps.state.delete(CLEAR_REQUEST_KEY)
    return []
  }

  const dropped =
    named === 'expired'
      ? await deps.ledger.dropExpired(deps.todayIst)
      : named === 'all'
        ? await deps.ledger.dropAll()
        : await deps.ledger.drop(named)

  if (dropped.length === 0) {
    deps.log.warn(`runner: clear-request for ${deps.instance} matched nothing — nothing was dropped`, {
      requestedBy,
      requested,
    })
  } else {
    // The legs and their SIGNED sizes, not a count: this is the only record
    // that a position left the books without an order, and an operator has to
    // be able to check it against what the upstream account still holds.
    deps.log.warn(
      `runner: ${dropped.length} leg(s) cleared from ${deps.instance} by operator request — no order was placed`,
      {
        requestedBy,
        requested,
        legs: dropped.map((d) => `${d.tradingsymbol}:${d.lots}${d.expiry === undefined ? '' : `@${d.expiry}`}`).join(','),
      },
    )
  }
  await deps.state.delete(CLEAR_REQUEST_KEY)
  return dropped
}

/** Where the bridge's mirror-sync detector parks a correction, per `TAG:mode` scope. */
export const SYNC_REQUEST_KEY = 'runner:sync-request'

/**
 * HOW LONG A PARKED CORRECTION IS STILL THE TRUTH. Five minutes.
 *
 * Deliberately MUCH shorter than the operator clear's hour, because the two
 * requests are different kinds of statement. A clear is a human's one-shot
 * intention, raised once and worth honouring until the runner's next sync or
 * even its next boot. A sync request is MACHINE-REFRESHED EVIDENCE: the
 * detector re-files it every ~60 seconds for as long as the divergence stands,
 * so a request that has sat unconsumed for five minutes means the detector
 * STOPPED VOUCHING FOR IT — the divergence closed on its own (a late fill
 * landed, the broker book moved) and applying the old absolute now would
 * re-introduce the very error it was computed to remove.
 */
export const DEFAULT_SYNC_REQUEST_TTL_MS = 300_000

/**
 * The TTL from the environment, refusing anything that is not a positive
 * number. Same shape and same reasoning as `clearRequestTtlMs`: every
 * comparison against NaN is false, so `'5m'` would make `age > ttl` false for
 * every request and silently disable the staleness control entirely.
 */
export function syncRequestTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DESK_SYNC_REQUEST_TTL_MS']
  if (raw === undefined || raw.trim() === '') return DEFAULT_SYNC_REQUEST_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_REQUEST_TTL_MS
}

/**
 * What the bridge's divergence detector writes and this process consumes.
 *
 * Each correction is an ABSOLUTE: "the broker holds `lots` of `tradingsymbol`",
 * signed, with 0 meaning the broker holds nothing. The `instrument` rides along
 * because the ledger may have NO entry for the symbol (a fill the runner never
 * booked) and an entry cannot be created from a bare symbol — the flatten needs
 * the lot size, the exchange and the token to reverse it later.
 *
 * `requestedAt` is REQUIRED and read, exactly as on `ClearRequest`: it is what
 * makes the request expire (see `DEFAULT_SYNC_REQUEST_TTL_MS`), and a document
 * without one cannot be shown to be current at all.
 */
export interface SyncRequest {
  readonly corrections: readonly {
    readonly tradingsymbol: string
    /** Signed LOTS the broker actually holds. 0 means the leg is not real. */
    readonly lots: number
    readonly instrument: InstrumentRef
  }[]
  readonly requestedBy?: string
  readonly requestedAt: number
}

/** One correction that changed the ledger: the symbol and both sides of it. */
export interface AppliedCorrection {
  readonly tradingsymbol: string
  readonly from: number
  readonly to: number
}

/** Structurally a `SyncRequest` correction, checked field by field off the wire. */
function readableCorrection(c: unknown): c is SyncRequest['corrections'][number] {
  if (c === null || typeof c !== 'object') return false
  const r = c as { tradingsymbol?: unknown; lots?: unknown; instrument?: unknown }
  return (
    typeof r.tradingsymbol === 'string' &&
    r.tradingsymbol !== '' &&
    typeof r.lots === 'number' &&
    Number.isFinite(r.lots) &&
    r.instrument !== null &&
    typeof r.instrument === 'object' &&
    // The ledger keys entries by the INSTRUMENT's symbol, so a correction whose
    // instrument names a different one would silently correct the wrong leg.
    (r.instrument as { tradingsymbol?: unknown }).tradingsymbol === r.tradingsymbol
  )
}

/**
 * Apply a pending mirror-sync request to ONE instance's ledger, then delete it.
 *
 * The mirror of `applyClearRequest`, point by point, and for the same
 * structural reason: `main.ts` caches one `PositionLedger` per `tag:mode` and
 * every `#save()` rewrites the whole document, so broker truth CANNOT be
 * written into `runner:positions` by the bridge that computed it — it would be
 * undone by the next booked order. The bridge files a REQUEST instead and this
 * process, the single writer, consumes it on its own sync cadence.
 *
 * IT ALWAYS CONSUMES THE REQUEST — applied, unreadable, undated or stale — and
 * IT NEVER THROWS. The caller is a poll loop, and a request left behind would
 * be re-applied on every sync; a correction is cheap for the detector to
 * re-file (it does so every ~60s while the divergence stands) and catastrophic
 * to apply twice against a book that has since moved LEGITIMATELY.
 *
 * EVERY APPLIED CORRECTION IS LOGGED AT ERROR VISIBILITY, even though it is
 * the fix and not the fault: each one is proof the optimistic book was WRONG —
 * an order that filled differently than it was booked — and that is a fact an
 * operator has to see, not housekeeping.
 */
export async function applySyncRequest(deps: {
  /** `TAG:mode`, for the journal. */
  readonly instance: string
  readonly ledger: PositionLedger
  readonly state: StateStore
  /** Now, epoch ms — what the request's age is measured against. */
  readonly nowMs: number
  /** Older than this and the request is refused. See `syncRequestTtlMs`. */
  readonly ttlMs: number
  readonly log: Logger
}): Promise<readonly AppliedCorrection[]> {
  try {
    const raw = await deps.state.get<SyncRequest>(SYNC_REQUEST_KEY)
    if (raw === null || typeof raw !== 'object') return []

    const requestedBy = typeof raw.requestedBy === 'string' ? raw.requestedBy : 'mirror-sync'
    const list = raw.corrections
    const corrections =
      Array.isArray(list) && list.length > 0 && list.every(readableCorrection)
        ? (list as SyncRequest['corrections'])
        : null

    if (corrections === null) {
      // Consumed but NEVER guessed at — one malformed correction poisons the
      // whole request, because applying the readable half of a snapshot that
      // was computed as a whole leaves the book in a state the detector never
      // observed. The detector re-files a clean one within the minute.
      deps.log.error(
        `runner: UNREADABLE sync-request for ${deps.instance} — nothing was applied, the request is discarded`,
        { requestedBy, corrections: JSON.stringify(list ?? null).slice(0, 200) },
      )
      await deps.state.delete(SYNC_REQUEST_KEY)
      return []
    }

    /**
     * A CORRECTION IS ONLY TRUE AT THE MOMENT IT WAS COMPUTED. An undated one
     * cannot be aged, and a stale one is one the detector has stopped
     * re-filing — meaning the divergence it described no longer stands, and
     * applying its absolute now would MANUFACTURE a divergence. Refused AND
     * deleted, loudly, naming the age: same discipline as the clear.
     */
    const requestedAt =
      typeof raw.requestedAt === 'number' && Number.isFinite(raw.requestedAt) ? raw.requestedAt : null
    const summary = corrections.map((c) => `${c.tradingsymbol}:${c.lots}`).join(',')
    if (requestedAt === null) {
      deps.log.error(
        `runner: UNDATED sync-request for ${deps.instance} REFUSED — it carries no requestedAt, so ` +
          'it cannot be shown to be current; nothing was applied',
        { requestedBy, corrections: summary, ttlMs: deps.ttlMs },
      )
      await deps.state.delete(SYNC_REQUEST_KEY)
      return []
    }
    const ageMs = deps.nowMs - requestedAt
    if (ageMs > deps.ttlMs) {
      deps.log.error(
        `runner: STALE sync-request for ${deps.instance} REFUSED — computed ${Math.round(ageMs / 1_000)} ` +
          `second(s) ago, past its ${Math.round(deps.ttlMs / 1_000)}-second life; the detector re-files ` +
          'every minute while a divergence stands, so an old absolute is one it stopped vouching for. ' +
          'Nothing was applied',
        { requestedBy, corrections: summary, ageMs, ttlMs: deps.ttlMs, requestedAt },
      )
      await deps.state.delete(SYNC_REQUEST_KEY)
      return []
    }

    const changed: AppliedCorrection[] = []
    for (const c of corrections) {
      const from = deps.ledger.netLots(c.tradingsymbol)
      if (from === c.lots) {
        // Already in agreement — the fill that caused the divergence was
        // booked between the detector's read and now. Rewriting an identical
        // entry would be a pointless Mongo write and a misleading journal line.
        continue
      }
      await deps.ledger.set(c.instrument, c.lots)
      deps.log.error(
        `runner: mirror sync applied ${c.tradingsymbol} for ${deps.instance} — ` +
          `ledger ${from} → ${c.lots} lot(s) (broker truth), requestedBy ${requestedBy}`,
        { instance: deps.instance, symbol: c.tradingsymbol, from, to: c.lots, requestedBy, requestedAt },
      )
      changed.push({ tradingsymbol: c.tradingsymbol, from, to: c.lots })
    }
    if (changed.length === 0) {
      deps.log.warn(
        `runner: sync-request for ${deps.instance} matched nothing — the ledger already agrees with the broker`,
        { requestedBy, corrections: summary },
      )
    }
    await deps.state.delete(SYNC_REQUEST_KEY)
    return changed
  } catch (err) {
    // Never thrown to the poll loop: one instance's Mongo blip must not stop
    // the sweep, and the request (if it survived) is retried on the next sync,
    // where the TTL eventually retires it.
    deps.log.error(`runner: sync-request handling failed for ${deps.instance}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/**
 * The narrow read that finds a parked clear ANYWHERE, not only where we host.
 *
 * One `find` over the state collection, filtered to the clear-request key. It is
 * not an indexed lookup — the collection's unique index is `(tag, key)` and this
 * query has no tag — but the collection holds a handful of documents per hosted
 * instance and this runs on the 15-second sync, so the scan is a rounding error
 * next to the alternative: a per-instance `findOne` that by construction can
 * only ever see the instances we already know about, which is the bug.
 */
export interface ClearRequestIndex {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
}

/**
 * Consume EVERY parked clear request AND mirror-sync request, hosted or not.
 *
 * WHY THIS IS NOT A LOOP OVER `ledgers`. The bridge 202-accepts a clear for any
 * instance whose `runner:positions` document exists; that document outlives the
 * catalogue entry that created it, so a clear can be raised for a tag this
 * process does not host. The old sweep iterated the in-memory ledgers map only
 * (CATALOGUE ∪ MIRRORS), so such a request was never consumed — it sat armed
 * until the tag was re-added, and then fired.
 *
 * TWO PATHS, and the difference between them is the single-writer rule:
 *
 *  - HOSTED — a `PositionLedger` for this instance is cached for the life of the
 *    process and every `#save()` rewrites the whole document, so the clear MUST
 *    go through that object. Anything else is undone by the next booked order.
 *  - RETIRED — nothing holds the document at all. There is no cache to keep in
 *    step and nothing that can overwrite the edit, so the document may be
 *    written directly. It is done through a TRANSIENT `PositionLedger`, loaded
 *    and dropped inside this call and never put in the map, so the retired case
 *    journals through exactly the same code as the hosted one rather than
 *    growing a second, subtly different way to remove a leg.
 *
 * ONE FAILURE DOES NOT STOP THE REST: an instance whose state cannot be read is
 * logged and skipped, and its request stays parked for the next sync (where the
 * TTL will eventually retire it).
 *
 * SYNC REQUESTS RIDE THE SAME SWEEP, on the same cadence, through the same
 * ledger object — the single-writer argument above applies to them verbatim.
 */
export async function sweepClearRequests(deps: {
  readonly collection: ClearRequestIndex
  /** The ledgers this process OWNS, keyed `TAG:mode`. */
  readonly ledgers: ReadonlyMap<string, PositionLedger>
  /** The state store for an instance scope. Stateless, so caching it is free. */
  readonly stateFor: (instance: string) => StateStore
  readonly todayIst: string
  readonly nowMs: number
  readonly ttlMs: number
  /** The sync request's OWN, much shorter, life. See `syncRequestTtlMs`. */
  readonly syncTtlMs: number
  readonly log: Logger
}): Promise<void> {
  const docs = await deps.collection
    .find({ key: { $in: [CLEAR_REQUEST_KEY, SYNC_REQUEST_KEY] } })
    .toArray()
  // Grouped per instance, so an instance carrying BOTH kinds of request loads
  // its transient ledger once and consumes them in a defined order.
  const parked = new Map<string, { clear: boolean; sync: boolean }>()
  for (const doc of docs) {
    const instance = doc['tag']
    if (typeof instance !== 'string' || instance === '') continue
    const entry = parked.get(instance) ?? { clear: false, sync: false }
    if (doc['key'] === CLEAR_REQUEST_KEY) entry.clear = true
    if (doc['key'] === SYNC_REQUEST_KEY) entry.sync = true
    parked.set(instance, entry)
  }
  for (const [instance, has] of parked) {
    try {
      const hosted = deps.ledgers.get(instance)
      const state = deps.stateFor(instance)
      let ledger = hosted
      if (ledger === undefined) {
        // Transient, and deliberately not registered anywhere: see above.
        ledger = new PositionLedger(state)
        await ledger.load()
      }
      let dropped: readonly DroppedEntry[] = []
      if (has.clear) {
        dropped = await applyClearRequest({
          instance,
          ledger,
          state,
          todayIst: deps.todayIst,
          nowMs: deps.nowMs,
          ttlMs: deps.ttlMs,
          log: deps.log,
        })
      }
      /**
       * CLEAR FIRST, ALWAYS. An operator's explicit clear must not be
       * overridden by an auto-correction in the same tick: the common case is
       * both describing the SAME phantom leg (the operator drops it, the
       * detector's correction says the broker holds 0 of it), and consuming
       * the clear first makes the operator's action the one on the record —
       * the sync then finds the book already in agreement and applies
       * nothing — instead of the clear arriving second, matching nothing, and
       * journalling as if the operator's click did nothing. And where the two
       * genuinely disagree, the detector re-files within the minute against
       * the post-clear book, so broker truth still wins the NEXT tick, with a
       * journal line that says so.
       */
      let corrected: readonly AppliedCorrection[] = []
      if (has.sync) {
        corrected = await applySyncRequest({
          instance,
          ledger,
          state,
          nowMs: deps.nowMs,
          ttlMs: deps.syncTtlMs,
          log: deps.log,
        })
      }
      if (hosted === undefined && (dropped.length > 0 || corrected.length > 0)) {
        // Said once more, at the instance level: this book has no strategy
        // behind it in this process, so the drop is the last thing that will
        // ever be said about those legs.
        deps.log.warn(
          `runner: edited ${dropped.length + corrected.length} leg(s) on ${instance}, which this process ` +
            'does NOT host — the document was edited directly because nothing is holding it',
          { instance },
        )
      }
    } catch (err) {
      deps.log.error(`runner: clear-request handling failed for ${instance}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Lots that actually routed, or null when the bridge did not say.
 *
 * Null and 0 are deliberately different answers: null means "this response
 * carries no `orders[]`" (an older bridge), while 0 would mean "every tranche
 * failed" — which cannot happen on an accepted submit, because the bridge
 * answers `accepted: false` when nothing routed. A malformed 0 is therefore
 * treated as no answer rather than as a flat position, so the caller falls back
 * to the intended size instead of forgetting a position it just opened.
 */
function routedLotsOf(res: SubmitApiResponse): number | null {
  const explicit = positive(res.routedLots)
  if (explicit !== null) return explicit
  // An older bridge has no `routedLots`. `orders[]` has always been the tranches
  // that actually routed, so summing it gives the same answer; `lots` is only
  // reached for a bridge older still, where it was the INTENDED size.
  const orders = res.orders
  if (orders !== undefined && orders.length > 0) {
    let total = 0
    for (const o of orders) {
      if (typeof o.lots !== 'number' || !Number.isFinite(o.lots)) return null
      total += o.lots
    }
    if (total > 0) return total
  }
  return positive(res.lots)
}

function positive(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Identity of an ORDER INTENT, for reusing an unresolved `clientOrderId`.
 *
 * Two submits that agree on all of these are the same order as far as the
 * bridge's idempotency key is concerned — see `#idFor`.
 *
 * `lots` IS PART OF IT AND HAS TO BE. A `clientOrderId` the bridge already has
 * a claim for replays that claim verbatim, so reusing an id held for "BUY 2"
 * against a later "BUY 5" would answer the 5-lot order with the 2-lot outcome —
 * the ledger would book 2, the broker would hold 2, and the strategy would
 * believe it opened 5. The cost of keeping it in the key is that a strategy
 * which changes its size STRANDS the old entry, which is why
 * `UnresolvedIntents` sweeps by age rather than assuming every entry is
 * eventually resolved by its own retry.
 */
function intentKey(req: SubmitRequest): string {
  return [
    req.instrument.tradingsymbol,
    req.side,
    req.lots,
    req.reducesExposure === true ? 'exit' : 'entry',
  ].join('|')
}

/** One held id: the intent it belongs to and when it was parked. */
interface UnresolvedRecord {
  readonly intent: string
  readonly clientOrderId: string
  readonly at: number
}

/**
 * How long a held id stays honoured.
 *
 * One trading session. The id is held so the strategy's own retry REPLAYS a
 * claim whose outcome we do not know instead of routing a second copy of it —
 * a question that is only live while that claim might still be resolving. Past
 * that, holding it stops the strategy from ever placing that exact order again,
 * and replaying a claim from a previous session would answer today's decision
 * with yesterday's outcome. Sweeping is therefore not housekeeping; it is the
 * other half of the safety property.
 */
export const UNRESOLVED_TTL_MS = 6 * 60 * 60_000

/**
 * Intent -> the `clientOrderId` of a submit whose OUTCOME IS UNKNOWN, PERSISTED.
 *
 * This used to be a bare `Map` on the gateway, i.e. process memory — which is
 * the legacy system's defining gap wearing a different hat, and it sat directly
 * beside `PositionLedger`, which is persisted for exactly that reason. Two
 * traced consequences:
 *
 *   - A restart lost the held id. The claim the bridge has under it is still
 *     `ROUTING` and may be LIVE; the strategy's next attempt then minted a fresh
 *     id, which is new to the bridge's unique index, so it ROUTED — and the
 *     strategy ended up with twice the position it asked for while its ledger
 *     showed one. The window for this is exactly the window in which a restart
 *     is most likely: right after the transport failure that wedged the id.
 *   - Nothing ever swept it. `intentKey` includes `lots`, so a strategy that
 *     re-sized left the old entry behind with no retry that could ever resolve
 *     it, and the map only grew.
 *
 * Both are fixed by the same thing: write it through the `StateStore` and give
 * every entry an age.
 */
export class UnresolvedIntents {
  readonly #state: StateStore
  readonly #clock: Clock
  readonly #key: string
  readonly #ttlMs: number
  #records = new Map<string, UnresolvedRecord>()
  #loaded = false

  constructor(
    state: StateStore,
    clock: Clock,
    opts: { ttlMs?: number; key?: string } = {},
  ) {
    this.#state = state
    this.#clock = clock
    this.#key = opts.key ?? 'runner:unresolved'
    this.#ttlMs = opts.ttlMs ?? UNRESOLVED_TTL_MS
  }

  /**
   * Read the held ids back. ONCE, at boot, before anything can submit — the
   * same discipline and the same reason as `PositionLedger.load()`: this
   * replaces the whole map, so a load still in flight when the first id is
   * parked would erase it, and an erased id is a duplicate order.
   */
  async load(): Promise<void> {
    const stored = await this.#state.get<UnresolvedRecord[]>(this.#key)
    this.#records = new Map(
      (stored ?? [])
        .filter((r) => typeof r?.intent === 'string' && typeof r?.clientOrderId === 'string')
        .map((r) => [r.intent, { ...r, at: Number(r.at) || 0 }]),
    )
    this.#loaded = true
    await this.#sweep()
  }

  /** The held id for this intent, or null. Expired entries are not returned. */
  get(intent: string): string | null {
    const rec = this.#records.get(intent)
    if (rec === undefined) return null
    if (this.#clock.now() - rec.at > this.#ttlMs) return null
    return rec.clientOrderId
  }

  async remember(intent: string, clientOrderId: string): Promise<void> {
    /**
     * `at` is when the id was FIRST parked, not when it was last re-parked.
     *
     * A strategy that retries the same unresolved order every 30 seconds
     * re-enters this method every 30 seconds, and re-stamping the clock each
     * time would push the deadline out forever — the TTL would never expire for
     * exactly the intent it exists to release.
     */
    const existing = this.#records.get(intent)
    const at = existing?.clientOrderId === clientOrderId ? existing.at : this.#clock.now()
    this.#records.set(intent, { intent, clientOrderId, at })
    // Sweep BEFORE the save, so the one write covers both. `intentKey` includes
    // `lots`, so a strategy that changes its size leaves an entry no retry will
    // ever resolve; without this the map grows for the life of the process and
    // the document with it.
    await this.#sweep()
    await this.#save()
  }

  async resolve(intent: string): Promise<void> {
    if (!this.#records.delete(intent)) {
      // Nothing was held: the overwhelmingly common path (every clean submit
      // takes it). Writing the same document back on every accepted order would
      // put a Mongo round trip on the order path for no reason.
      return
    }
    await this.#save()
  }

  get size(): number {
    return this.#records.size
  }

  /** Whether `load()` has run. `main.ts` asserts this before it lets a strategy start. */
  get isLoaded(): boolean {
    return this.#loaded
  }

  async #sweep(): Promise<void> {
    const now = this.#clock.now()
    let dropped = 0
    for (const [intent, rec] of [...this.#records]) {
      if (now - rec.at > this.#ttlMs) {
        this.#records.delete(intent)
        dropped++
      }
    }
    // Only write when something changed. A boot with nothing held is the
    // overwhelmingly common case and must not cost a Mongo write per gateway.
    if (dropped > 0) await this.#save()
  }

  async #save(): Promise<void> {
    await this.#state.set(this.#key, [...this.#records.values()])
  }
}

export interface HttpOrderGatewayDeps {
  /** The bridge, e.g. `http://127.0.0.1:8890`. */
  readonly baseUrl: string
  /** `DESK_API_TOKEN`. The runner authenticates as a machine principal. */
  readonly token: string
  /** The REGISTRY tag, which is what every gate on the bridge keys on. */
  readonly tag: string
  readonly mode: 'paper' | 'live'
  /**
   * Underlying, sent so the freeze table is keyed exactly rather than guessed.
   *
   * NULL means "this caller does not have one", and the field is then OMITTED
   * from the body so the bridge derives it from the trading symbol with its own
   * `deriveUnderlying` (`apps/api/src/submit.ts`). That is the signal mirrors'
   * case: a mirror places whatever the upstream account traded, which is not
   * one underlying, so any fixed value would be wrong for every other symbol —
   * and a wrong underlying keys the freeze split against the wrong table.
   * Omitting is not a loss of precision, it is declining to state something we
   * do not know in favour of the one derivation that at least sees the symbol.
   */
  readonly underlying: string | null
  readonly clock: Clock
  readonly log: Logger
  readonly ledger: PositionLedger
  /**
   * Durable store for the held `clientOrderId`s. REQUIRED, not optional.
   *
   * Making it optional would leave "runs entirely in process memory" as a
   * configuration a caller can pick by accident, which is exactly how it came
   * to be that in the first place.
   */
  readonly state: StateStore
  /**
   * The best price known for an instrument RIGHT NOW, or null.
   *
   * Injected from the runner's own `RunnerMarketData` (`md.quote`), which keeps
   * the last quote it ever saw rather than expiring it. That is what makes a
   * 15:33 flatten able to state a price when the bridge's own 120-second quote
   * cache has already gone cold. Optional: a gateway with no market data falls
   * back to the price stored on the ledger entry.
   */
  markOf?: (instrument: InstrumentRef) => number | null
  /**
   * The CONTRACT EXPIRY for an instrument, or null when it is not known.
   *
   * Injected from `main.ts` off the instrument dump, because `InstrumentRef`
   * carries no expiry and the ledger cannot sweep a dead contract it cannot
   * date (audit F-6a). Optional: a gateway with no index simply books entries
   * without an expiry, and `dropExpired` then never touches them — which is the
   * conservative direction, not a silent failure.
   */
  expiryOf?: (instrument: InstrumentRef) => string | null
  /** Injected so the adapter is testable with no socket. */
  fetch?: typeof globalThis.fetch
  /** Gap between same-id retries. Tests set 0; production takes the default. */
  readonly retryDelayMs?: number
  /** How long a held id stays honoured. See `UNRESOLVED_TTL_MS`. */
  readonly unresolvedTtlMs?: number
}

export class HttpOrderGateway implements OrderGateway {
  readonly #d: HttpOrderGatewayDeps
  /**
   * Intent -> the `clientOrderId` of a submit whose OUTCOME IS UNKNOWN.
   *
   * See `#idFor`. Entries are removed the moment an answer is definite, so this
   * is empty in every normal session — and it is PERSISTED, because a restart
   * that forgot one is a restart that double-places. See `UnresolvedIntents`.
   */
  readonly #unresolved: UnresolvedIntents
  /** In-flight `load()`, so concurrent submits share one read. See `load()`. */
  #loading: Promise<void> | null = null
  /**
   * A `flattenAll` is on the wire. The ledger is SHARED STATE between
   * overlapping flattens: a leg is only removed once its reversing order has
   * been accepted, so a second pass starting while the first is still
   * submitting reads the same open legs and reverses every one of them again.
   */
  #flattening = false

  constructor(deps: HttpOrderGatewayDeps) {
    this.#d = deps
    this.#unresolved = new UnresolvedIntents(deps.state, deps.clock, {
      ...(deps.unresolvedTtlMs === undefined ? {} : { ttlMs: deps.unresolvedTtlMs }),
    })
  }

  /**
   * Read the held ids back. `main.ts` calls this at boot, awaited, in the same
   * loop that loads the ledgers — and `submit()` calls it too, so a caller that
   * forgets cannot end up minting a fresh id for an intent the previous process
   * had already put on the wire.
   *
   * Idempotent and single-flight: the read is shared, because two concurrent
   * submits both triggering a load would have the second one replace the map
   * the first had already written a held id into.
   */
  async load(): Promise<void> {
    if (this.#unresolved.isLoaded) return
    this.#loading ??= this.#unresolved.load()
    await this.#loading
  }

  /** Held ids, for the boot log and for tests. */
  get unresolvedCount(): number {
    return this.#unresolved.size
  }

  /**
   * The idempotency key for this attempt.
   *
   * `clientOrderId` is the bridge's idempotency key: resubmitting the SAME id
   * replays the stored answer instead of routing. So the rule is not "a fresh
   * id per attempt" — that is the duplicate-order bug the bridge's header now
   * spells out. A retry of a request whose ANSWER WAS LOST (socket reset, 500,
   * timeout, or a claim left `ROUTING` by a process that died) must go out
   * under the id already on the wire, or both ids are new to the unique index,
   * both route, and the strategy ends up with twice the position it asked for
   * while its ledger shows one.
   *
   * A fresh id is still exactly right for a GENUINE second attempt after a
   * definite refusal, which is why `#unresolved` is cleared as soon as an
   * answer is definite in either direction.
   *
   * The consequence worth stating: while an intent is unresolved, an identical
   * order cannot be routed again — it replays the unknown claim instead. That
   * is deliberate. We do not know whether the first one is live, and opening a
   * second position on a maybe is the one outcome worse than missing a trade.
   */
  #idFor(req: SubmitRequest): string {
    return this.#unresolved.get(intentKey(req)) ?? makeId(this.#d.tag, this.#d.clock.now())
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    // Before `#idFor`, always. A held id that has not been read back yet is
    // indistinguishable from no held id, and the consequence of getting that
    // wrong is a second live order rather than a missing one.
    await this.load()
    const clientOrderId = this.#idFor(req)
    const body = {
      tag: this.#d.tag,
      mode: this.#d.mode,
      clientOrderId,
      // Omitted, not sent as null: `underlying` is optional on the wire and the
      // bridge derives it when absent. Sending an explicit null would fail its
      // "must be a string when present" validation.
      ...(this.#d.underlying === null ? {} : { underlying: this.#d.underlying }),
      instrument: {
        tradingsymbol: req.instrument.tradingsymbol,
        lotSize: req.instrument.lotSize,
        tickSize: req.instrument.tickSize,
        exchange: req.instrument.exchange,
        ...(req.instrument.instrumentToken === undefined
          ? {}
          : { instrumentToken: req.instrument.instrumentToken }),
      },
      // The bridge speaks the desk's vocabulary ('Buy'/'Sell'); strategies speak
      // the broker's ('BUY'/'SELL'). Translated at the boundary, once.
      side: req.side === 'BUY' ? 'Buy' : 'Sell',
      lots: req.lots,
      ...(req.orderType === undefined ? {} : { orderType: req.orderType }),
      ...(req.limitPrice === undefined ? {} : { limitPrice: req.limitPrice }),
      ...(req.triggerPrice === undefined ? {} : { triggerPrice: req.triggerPrice }),
      // The strategy's own decision price. It is what the fill is JOURNALLED at
      // when the bridge's mark cache is colder than the strategy's own quote —
      // without it a submit is refused rather than booked at 0, which would
      // report a profit that was never made.
      ...(req.referencePrice === undefined ? {} : { referencePrice: req.referencePrice }),
      ...(req.reducesExposure === undefined ? {} : { reducesExposure: req.reducesExposure }),
      ...(req.meta === undefined ? {} : { meta: req.meta }),
    }

    /**
     * Retry the SAME id, in-place, before giving up.
     *
     * A transport failure is not evidence that nothing routed — the claim is
     * written before the tranches go out, so a request whose response was lost
     * may well be live. Re-POSTing the same id cannot double-route (it replays)
     * and is the only way to find out. Only when every attempt fails is the
     * outcome genuinely unknown.
     */
    let res: SubmitApiResponse | null = null
    let lastError = ''
    let rejected = false
    for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
      try {
        res = await this.#post(body)
        break
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        rejected = err instanceof BridgeRejectedRequest
        this.#d.log.warn(`${this.#d.tag}: submit attempt ${attempt}/${SUBMIT_ATTEMPTS} failed`, {
          symbol: req.instrument.tradingsymbol,
          clientOrderId,
          error: lastError,
        })
        if (rejected) break
        if (attempt < SUBMIT_ATTEMPTS) await this.#pause()
      }
    }

    if (rejected) {
      // Definite: nothing was attempted, so this is an ordinary refusal and the
      // id is released for a genuine next attempt.
      await this.#unresolved.resolve(intentKey(req))
      const reason = `submit rejected: ${lastError}`
      this.#d.log.error(`${this.#d.tag}: ${reason}`, { symbol: req.instrument.tradingsymbol })
      return { accepted: false, clientOrderId: null, reason }
    }

    if (res === null) {
      /**
       * UNKNOWN, not refused. `accepted: false` is still the right answer to
       * give the strategy — anatomy row 14, the "opportunity used" flag flips
       * only on acceptance — but the id is REMEMBERED, so the strategy's next
       * attempt at the same order replays this claim instead of routing a
       * second one, and nothing is booked, because booking a position that may
       * not exist would have a later flatten open a fresh one the other way.
       */
      await this.#unresolved.remember(intentKey(req), clientOrderId)
      const reason = `submit failed: ${lastError}`
      this.#d.log.error(`${this.#d.tag}: ${reason} — OUTCOME UNKNOWN, may be live`, {
        symbol: req.instrument.tradingsymbol,
        clientOrderId,
      })
      return { accepted: false, clientOrderId, reason }
    }

    if (res.indeterminate === true) {
      /**
       * The bridge has a claim under this id and does not know its outcome
       * either (`status: 'ROUTING'`, the process that owned it never reported
       * back). It deliberately sends no `routedLots`, because there is no
       * honest value: some subset of `plannedOrders` may be live.
       *
       * So: book NOTHING and keep the id. Under-booking is recoverable — the
       * next replay resolves the record and books the truth — where guessing
       * "probably fine" and booking the planned size puts a phantom leg in the
       * ledger that the EOD flatten would SELL, opening a real short nobody
       * asked for out of a position that never existed.
       */
      await this.#unresolved.remember(intentKey(req), clientOrderId)
      const reason = res.reason ?? 'submission is still routing; outcome unknown'
      this.#d.log.error(`${this.#d.tag}: INDETERMINATE submit — booking nothing, will replay`, {
        symbol: req.instrument.tradingsymbol,
        clientOrderId,
        intendedLots: res.intendedLots ?? req.lots,
        plannedOrders: res.plannedOrders?.length ?? 0,
        reason,
      })
      return { accepted: false, clientOrderId, reason }
    }

    // Definite from here on, in either direction: the intent is resolved, so a
    // genuine next attempt gets a fresh id rather than replaying this answer.
    await this.#unresolved.resolve(intentKey(req))

    if (res.accepted !== true) {
      return {
        accepted: false,
        clientOrderId: null,
        reason: res.reason ?? 'refused with no reason given',
      }
    }
    /**
     * BOOK WHAT ROUTED, not what was intended.
     *
     * `intendedLots` is the size the bridge decided on after the `liveLots`
     * override — but it splits that into freeze tranches and routes them one at
     * a time, and a tranche that throws leaves the submission `accepted: true`
     * with `status: 'FAILED'`: real exposure exists, just not all of it.
     *
     * 30 lots split `[24, 6]` with the 6 rejected is a 24-lot position. Booking
     * 30 makes the EOD flatten SELL 30 against 24 and leave the strategy 6 lots
     * short of an instrument nobody asked to be short of, opened by the safety
     * mechanism itself, with no logic anywhere that would ever close it. So the
     * ledger books `routedLots`, which is that number stated explicitly.
     *
     * The fallbacks exist only for a bridge that predates the field, and they
     * degrade to summing the routed tranches before they fall back to a size
     * that might be an intention.
     */
    const routedLots = routedLotsOf(res) ?? req.lots
    const partial = res.status === 'FAILED' || (res.errors !== undefined && res.errors.length > 0)
    if (partial) {
      this.#d.log.error(`${this.#d.tag}: PARTIAL route — booking the lots that reached a rail`, {
        symbol: req.instrument.tradingsymbol,
        requested: req.lots,
        intended: res.intendedLots ?? req.lots,
        routed: routedLots,
        errors: (res.errors ?? []).join('; '),
      })
    }
    await this.#d.ledger.apply(
      req.instrument,
      req.side,
      routedLots,
      this.#priceFor(req),
      this.#d.expiryOf?.(req.instrument) ?? undefined,
    )
    return { accepted: true, clientOrderId: res.clientOrderId ?? clientOrderId }
  }

  /**
   * The best price known for this order, most authoritative first.
   *
   * The strategy's own decision price beats a quote because it is the number the
   * strategy actually acted on; the limit it asked for beats a quote for the
   * same reason. A live mark comes last but is never nothing — most catalogue
   * strategies send no price at all today, so without it every ledger entry
   * would carry no price and the whole late-flatten fix would be inert.
   */
  #priceFor(req: SubmitRequest): number | undefined {
    return req.referencePrice ?? req.limitPrice ?? this.#d.markOf?.(req.instrument) ?? undefined
  }

  /** The gap between same-id retries. Injectable so tests do not sleep. */
  async #pause(): Promise<void> {
    const ms = this.#d.retryDelayMs ?? RETRY_DELAY_MS
    if (ms <= 0) return
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Not supported: `/v1/desk/submit` has no cancel, because the gateway places
   * MARKET and marketable orders that are terminal by the time a strategy could
   * change its mind. Returning false rather than throwing keeps a strategy that
   * optimistically calls it from failing its whole handler — and it is logged,
   * so a strategy that genuinely depends on cancels shows up rather than
   * silently believing its order was pulled.
   */
  async cancel(clientOrderId: string): Promise<boolean> {
    this.#d.log.warn(`${this.#d.tag}: cancel is not supported on the submit path`, {
      clientOrderId,
    })
    return false
  }

  /**
   * Flatten everything this strategy holds, from the runner's own ledger.
   *
   * Every reversing order is `reducesExposure: true`, which is what carries it
   * past the kill switch and past the stale-feed block. Both exemptions exist
   * for the same reason: a control that traps an open position is worse than
   * whatever it was protecting against.
   *
   * Failures are collected and logged rather than thrown, so one unflattenable
   * leg does not abandon the rest.
   *
   * IT SENDS A PRICE, AND THAT IS THE POINT OF THE `lastPrice` FIELD.
   * `apps/api/src/submit.ts` resolves a fill price as
   * `marks.price() ?? referencePrice ?? limitPrice ?? refuse`, and its
   * `QuoteCache` treats the feed as dead 120 seconds after the last tick — so
   * from about 15:32 the first of those three is gone. A flatten that sent
   * none of them was REFUSED, `Runner` re-armed it on the 60-second exit retry,
   * and it was refused again on every attempt through the night while the
   * position sat at the broker. `reducesExposure: true` carries an exit past
   * the kill switch and past the stale-feed block, but nothing carries it past
   * "we have no price to journal this at"; only a price does.
   */
  async flattenAll(reason: string): Promise<void> {
    // A second caller while one pass is in flight is refused outright, never
    // queued: by the time it ran, the pass ahead of it will have reversed the
    // legs it is holding, so the only thing a queued pass could add is a
    // second reversal of the same position.
    if (this.#flattening) {
      this.#d.log.warn(`${this.#d.tag}: flatten already in progress, skipping re-entry`, { reason })
      return
    }
    this.#flattening = true
    try {
      await this.#flattenAll(reason)
    } finally {
      this.#flattening = false
    }
  }

  async #flattenAll(reason: string): Promise<void> {
    const open = this.#d.ledger.open()
    if (open.length === 0) return
    this.#d.log.warn(`${this.#d.tag}: flattening ${open.length} position(s)`, { reason })
    const refused: { readonly symbol: string; readonly lots: number; readonly why: string }[] = []
    for (const entry of open) {
      // The live mark first (it is the freshest thing we have), the price the
      // ledger stored second. The ledger's is what survives a restart and what
      // is left once the feed has stopped, which is exactly when a flatten is
      // most likely to be running.
      const referencePrice = this.#d.markOf?.(entry.instrument) ?? entry.lastPrice
      if (referencePrice === undefined) {
        // Named rather than hidden: the flatten below will very likely be
        // refused with "no price", and the operator needs to know that the
        // cause is a leg booked without one, not the bridge misbehaving.
        this.#d.log.error(
          `${this.#d.tag}: flattening ${entry.tradingsymbol} with NO reference price — ` +
            'the bridge will refuse this if its mark cache is cold',
          { reason },
        )
      }
      const res = await this.submit({
        instrument: entry.instrument,
        side: entry.lots > 0 ? 'SELL' : 'BUY',
        lots: Math.abs(entry.lots),
        reducesExposure: true,
        ...(referencePrice === undefined ? {} : { referencePrice }),
        meta: { flatten: reason },
      })
      if (!res.accepted) {
        refused.push({
          symbol: entry.tradingsymbol,
          lots: entry.lots,
          why: res.reason ?? 'unknown',
        })
      }
    }
    /**
     * ONE line per attempt, not one per leg. A refused flatten is retried on
     * the runner's exit backoff, so during an outage this method runs again
     * and again — and on 2026-08-04 a 12-leg book at a 15-second cadence put
     * ~48 identical error lines a minute into the log, which buried the one
     * fact that mattered (every leg, same reason, still open). The legs and
     * lots are all still here, and the reasons are deduplicated because a
     * bridge refusing a whole book refuses it for one reason.
     */
    if (refused.length > 0) {
      this.#d.log.error(
        `${this.#d.tag}: flatten REJECTED for ${refused.length}/${open.length} leg(s) — positions still open`,
        {
          legs: refused.map((r) => `${r.symbol}:${r.lots}`).join(','),
          reasons: [...new Set(refused.map((r) => r.why))].join('; '),
        },
      )
    }
  }

  async #post(body: unknown): Promise<SubmitApiResponse> {
    const doFetch = this.#d.fetch ?? globalThis.fetch
    const res = await doFetch(`${this.#d.baseUrl}/v1/desk/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#d.token}`,
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      const msg = `HTTP ${res.status}: ${text.slice(0, 200)}`
      // A refusal is a 200 with `accepted: false`, so a 4xx here means the
      // REQUEST was wrong (an unregistered tag, a malformed body) — definite,
      // and pointless to retry. Anything else may be a lost answer.
      throw res.status >= 400 && res.status < 500 ? new BridgeRejectedRequest(msg) : new Error(msg)
    }
    return JSON.parse(text) as SubmitApiResponse
  }
}
