/**
 * The broker-book sweep — the feedback loop the desk was documented to have and
 * did not (F-1).
 *
 * Until this existed the XTS order socket was the ONLY path a fill could take
 * back to the desk. Four separate docstrings promised a reconciliation sweep
 * (`main.ts`, `order-socket.ts`, `queue.ts`), `orderBook()` had no caller, and
 * `packages/order-bus/reconcile.ts` was dead code. On 2026-08-10 the socket died
 * holding a token the broker had already invalidated: not one fill reached the
 * desk for the rest of the session, every order sat PLACED, and the only
 * self-heal available was a restart.
 *
 * WHAT IT DOES, in one pass:
 *   1. reads the broker's order book and REPLAYS every row of ours through the
 *      same `FillWatcher.handle` the socket feeds;
 *   2. settles tranches whose placement outcome was never learned (F-3), by
 *      looking for their trace in that same book;
 *   3. alerts on an order still working long after it was placed (F-17).
 *
 * WHAT IT MUST NEVER DO, and the reason each rule is here rather than implied:
 *
 *   - IT PLACES, MODIFIES AND CANCELS NOTHING. It is the instrument that tells
 *     the desk what is true; an instrument that also acts changes what it is
 *     measuring, and a sweep that "helpfully" re-sent a missing order would
 *     double a live position on the one code path with no human in it.
 *   - IT NEVER ADOPTS A FOREIGN ORDER. A manual order on the same account is
 *     reported, never booked.
 *   - IT NEVER MAKES AN AMBIGUOUS TRANCHE TERMINAL WHILE THE BROKER STILL SHOWS
 *     IT. Un-booking a live position is the worse of the two errors by a long
 *     way: the desk then flattens against a leg it believes it does not hold.
 *
 * REPLAY IS IDEMPOTENT BY CONSTRUCTION, so nothing here dedups. `FillWatcher`
 * suppresses an exact repeat per (brokerOrderId, clientOrderId) via
 * `isMeaningfulUpdate`, resolves truncated correlation ids through
 * `getByBrokerOrderId`, and refuses to re-decide an order that is already
 * terminal. A second dedup layer here would only ever suppress MORE — including
 * the first update after a restart, when the watcher's memory is empty and the
 * broker's book is the only record of what happened.
 *
 * NEVER REJECTS. It is driven by a `setInterval`, and an unhandled rejection
 * kills the only process that can place orders (the G4 lesson, again).
 */

import type { BrokerAdapter, PlacedOrder } from '@algomaker/brokers'
import type { OrderStatus } from '@algomaker/order-bus'
import { isBackstopOrderId } from './dx-backstop.ts'
import type { FillWatcher } from './fills.ts'
import { packedToExchangeToken } from './gateway.ts'
import { orderMode, type OrderEvent, type OrderJournal } from './journal.ts'
import type { OrderQueue } from './queue.ts'

/**
 * How long an ambiguous tranche is given to appear in the broker's book.
 *
 * Generous on purpose. The cost of waiting is an order that reads PLACED for
 * ten minutes; the cost of being early is booking a live position as failed.
 */
export const DEFAULT_AMBIGUOUS_TTL_MS = 600_000

/**
 * How long an order may sit PLACED before somebody is told (F-17).
 *
 * Five minutes is roughly "this is not going to fill on its own". Alert only,
 * this tier: chasing or cancelling a resting order automatically is a decision
 * with money on both sides of it, and it is recorded as a later one.
 */
export const DEFAULT_WORKING_ALERT_MS = 300_000

/** Most PLACED documents examined per pass. A bound, not a business rule. */
const DEFAULT_MAX_ORDERS = 200

/** The narrow slice of `desk-gateway-orders` this needs. Same port style as queue.ts. */
export interface SweepOrdersCollection {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      limit(n: number): { toArray(): Promise<Record<string, unknown>[]> }
    }
  }
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>
}

export interface BrokerSweepDeps {
  /** READ-ONLY BY TYPE: the sweep is handed the one method it may call. */
  readonly adapter: Pick<BrokerAdapter, 'orderBook'>
  readonly queue: Pick<OrderQueue, 'getByBrokerOrderId' | 'resolveAmbiguous'>
  readonly fills: Pick<FillWatcher, 'handle' | 'reconcile' | 'resolve'>
  readonly journal: Pick<OrderJournal, 'record'>
  readonly orders: SweepOrdersCollection
  /**
   * WHICH DOCUMENTS THIS SWEEP OWNS, merged into its `PLACED` query.
   *
   * The truth this component reads is the BROKER'S OWN BOOK, so it can only
   * ever speak for orders the broker knows about. Since the engine's paper
   * lifecycle landed, `desk-gateway-orders` also carries simulated orders
   * (`mode: 'paper'`) — which have no row in that book at all, so every pass
   * would find them traceless and eventually declare a placed order never
   * placed. The gateway scopes this to the live rail.
   *
   * ABSENT MEANS EVERY PLACED DOCUMENT, which is what this has always done.
   */
  readonly ordersFilter?: Record<string, unknown>
  /**
   * The rail of the book being swept: `live` (Delta production, the default)
   * or `paper` (the demo rail's testnet book, whose orders are paper
   * documents). The watcher refuses a row that resolves across rails.
   */
  readonly rail?: 'live' | 'paper'
  /**
   * Optional, because `OrderJournal` already pushes every event it records to
   * desk-api. Wiring a notifier here as well double-pushes; it exists for a
   * host whose journal has none.
   */
  readonly notify?: (event: OrderEvent) => void
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface BrokerSweepOptions {
  readonly ambiguousTtlMs?: number
  readonly workingAlertMs?: number
  readonly maxOrders?: number
}

/** What one pass learned from the broker's book. */
interface BrokerBookView {
  /** Correlation ids the book showed — possibly TRUNCATED. See `hasTrace`. */
  readonly clientOrderIds: Set<string>
  /**
   * Contracts carrying a row this gateway could not attribute to any order —
   * by EXCHANGE TOKEN, which is the identity the broker and the desk agree on,
   * and by symbol as the fallback for a row XTS sends without an id (and for
   * the simulator). The symbol alone is inert on live: the book spells a
   * contract `NIFTY 22SEP2026 PE 23150` and the document `NIFTY2692223150PE`,
   * so `expireAmbiguous`'s guard never fired there — and a tranche that had
   * reached the exchange was failed, un-booking a live position (F4).
   */
  readonly unattributableTokens: Set<number>
  readonly unattributableSymbols: Set<string>
}

export interface BrokerSweep {
  /** One pass. NEVER REJECTS, never overlaps itself. */
  run(): Promise<void>
  readonly running: boolean
}

/**
 * Statuses this desk models. An unrecognised one is SKIPPED, never guessed —
 * the same rule `mapOrderStatus` states: inventing WORKING conjures an order
 * that may not exist, and inventing REJECTED discards one that does.
 */
const KNOWN_STATUSES = new Set<string>([
  'PENDING_NEW',
  'WORKING',
  'PARTIALLY_FILLED',
  'AMENDING',
  'CANCELLING',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
])

export function createBrokerSweep(
  deps: BrokerSweepDeps,
  opts: BrokerSweepOptions = {},
): BrokerSweep {
  const ambiguousTtlMs = opts.ambiguousTtlMs ?? DEFAULT_AMBIGUOUS_TTL_MS
  const workingAlertMs = opts.workingAlertMs ?? DEFAULT_WORKING_ALERT_MS
  const maxOrders = opts.maxOrders ?? DEFAULT_MAX_ORDERS
  const sweepRail: 'live' | 'paper' = deps.rail ?? 'live'
  /** Foreign broker ids already complained about. One line each, per process. */
  const reportedForeign = new Set<string>()
  let running = false

  /**
   * Step 1. Replay what the broker holds.
   *
   * Returns what the book showed, which is what step 2 needs: a tranche that
   * appears here is at the exchange, whatever our own record says about it.
   */
  const replay = async (): Promise<BrokerBookView> => {
    const clientOrderIds = new Set<string>()
    const unattributableTokens = new Set<number>()
    const unattributableSymbols = new Set<string>()
    const rows = await deps.adapter.orderBook()
    let foreign = 0

    for (const row of rows) {
      // An exchange backstop (`dx-backstop.ts`) is that loop's own order, not a
      // desk tranche and not a stranger's: replaying it would only ask the
      // watcher about it and name it foreign, every pass.
      if (isBackstopOrderId(row.clientOrderId)) continue
      try {
        if (row.clientOrderId !== null && row.clientOrderId !== '') {
          clientOrderIds.add(row.clientOrderId)
        }

        /**
         * A row with no correlation id is ours only if its AppOrderID is one we
         * stored at ACK. Anything else is a manual order on the same account:
         * counted and named in the log, never handled. Handling it would insert
         * a `desk-fills` row for a contract the desk never traded, and the
         * portal would show it as the desk's own.
         */
        if (row.clientOrderId === null || row.clientOrderId === '') {
          const doc =
            row.brokerOrderId === ''
              ? null
              : await deps.queue.getByBrokerOrderId(row.brokerOrderId)
          if (doc === null) {
            foreign++
            // Remembered by CONTRACT, because that is what step 2 has to reason
            // about: a row we cannot attribute might be one of our own
            // ambiguous tranches echoed back without its correlation id.
            const token = Number(row.exchangeToken ?? 0)
            if (token > 0) unattributableTokens.add(token)
            if (row.tradingsymbol !== '') unattributableSymbols.add(row.tradingsymbol)
            if (!reportedForeign.has(row.brokerOrderId)) {
              reportedForeign.add(row.brokerOrderId)
              deps.log(
                `foreign broker order ${row.brokerOrderId} (${row.tradingsymbol}) — not ours, NOT adopted`,
                { status: row.status, filledQty: row.filledQty },
              )
            }
            continue
          }
        }

        if (!KNOWN_STATUSES.has(row.status)) {
          deps.log('broker row carries a status this desk does not model — skipped', {
            brokerOrderId: row.brokerOrderId,
            status: row.status,
          })
          continue
        }

        const update: PlacedOrder = {
          brokerOrderId: row.brokerOrderId,
          clientOrderId: row.clientOrderId ?? '',
          status: row.status as OrderStatus,
          filledQty: row.filledQty,
          avgPrice: row.avgPrice,
          ...(row.tradingsymbol === '' ? {} : { tradingsymbol: row.tradingsymbol }),
          ...(typeof row.exchangeToken === 'number' && row.exchangeToken > 0
            ? { exchangeToken: row.exchangeToken }
            : {}),
        }
        /**
         * A CORRELATED ROW CAN STILL BE NOBODY'S: a wire id from a book purged
         * since, another desk's tag on the same account, a broker id the
         * watcher refuses as stale or on the wrong rail. `handle` would record
         * it anyway — a `desk-fills` row with `tag: ''` and a STATUS event
         * under no book, on EVERY pass, which is the untagged noise the
         * operator sees (F11). The socket path keeps recording unresolved
         * rows, because there the row may be a raced fill of an order whose
         * broker id is about to be written; this sweep replays the same book
         * every 45 s, so for it "unknown now" is "unknown", and the row is
         * counted foreign and named once instead.
         *
         * QUIET, because "named once" is the sweep's promise and the watcher
         * cannot keep it: `resolve` logs its own refusal (stale, rail or
         * contract) each time it is asked, and it is asked here per row per
         * pass BEFORE `reportedForeign` — every same-day FILLED live order
         * became a `NOT adopted` line every 45 s once it aged past the
         * session window. The line below is the one that stays.
         */
        if ((await deps.fills.resolve(update, { rail: sweepRail, quiet: true })) === null) {
          foreign++
          if (!reportedForeign.has(row.brokerOrderId)) {
            reportedForeign.add(row.brokerOrderId)
            deps.log(
              `foreign broker order ${row.brokerOrderId} (${row.tradingsymbol}) — ` +
                `correlated but unknown to this desk — NOT recorded`,
              { echo: row.clientOrderId ?? '', status: row.status, filledQty: row.filledQty },
            )
          }
          continue
        }
        // `handle` swallows its own errors by contract; the try around it is for
        // anything thrown before it is reached. LIVE, always: this sweep reads
        // the live broker's book (main.ts wires it in xts mode only), and the
        // watcher must not resolve one of its rows to a paper document by an
        // id the simulator happened to reuse.
        await deps.fills.handle(update, { rail: sweepRail })
      } catch (err) {
        // One unreadable row must not cost the rest of the book — the next row
        // may be the fill nobody has heard about.
        deps.log('broker row could not be replayed', {
          brokerOrderId: row.brokerOrderId,
          error: String(err),
        })
      }
    }
    if (foreign > 0) deps.log('broker book contains foreign orders', { count: foreign })
    return { clientOrderIds, unattributableTokens, unattributableSymbols }
  }

  /**
   * Does the broker's book show any trace of this tranche?
   *
   * PREFIX MATCHING, deliberately. The wire id is `tag|clientOrderId` capped at
   * 45 characters, so a long tag leaves the book showing only the first few
   * characters of the tranche id (`queue.ts:getByBrokerOrderId` tells the same
   * story from the other end). A prefix match can only ever find MORE traces
   * than exist — and the error it causes is leaving an order open for a human
   * to settle, while the error it prevents is declaring a live position dead.
   */
  const hasTrace = (trancheId: string, seen: BrokerBookView): boolean => {
    if (seen.clientOrderIds.has(trancheId)) return true
    for (const id of seen.clientOrderIds) {
      if (id !== '' && trancheId.startsWith(id)) return true
    }
    return false
  }

  /** Step 2. Settle ambiguous tranches that the TTL has outlived. */
  const expireAmbiguous = async (
    doc: Record<string, unknown>,
    seen: BrokerBookView,
    now: number,
  ): Promise<boolean> => {
    const ambiguous = asStrings(doc['ambiguousTrancheIds'])
    if (ambiguous.length === 0) return false
    /**
     * THE ONE WAY THIS COULD UN-BOOK A LIVE POSITION.
     *
     * A tranche that DID reach the exchange but comes back without its
     * correlation id reads as a stranger's order, and its own id then looks
     * traceless — the exact input that would make the code below call a live
     * order "never placed". When a row we could not attribute names this
     * contract, the honest answer is that the book has not settled the
     * question, so nothing is resolved. The order stays PLACED and the
     * working-order alert below sends a human to the broker book, which is the
     * correct place for an unanswerable question to end up.
     *
     * KEYED ON THE EXCHANGE TOKEN first (the document's packed
     * `instrument_token` unpacked by the same rule the order path sends with),
     * because on live the two symbol spellings never agree and a symbol-only
     * guard held nothing. The symbol arm stays as the fallback for a row that
     * carries no token, and for the simulator.
     */
    const symbol = String(doc['tradingsymbol'] ?? '')
    const docToken = packedToExchangeToken(doc['instrument_token'])
    if (
      (docToken > 0 && seen.unattributableTokens.has(docToken)) ||
      (symbol !== '' && seen.unattributableSymbols.has(symbol))
    ) {
      deps.log(
        `AMBIGUOUS HELD ${symbol} [${String(doc['clientOrderId'] ?? '')}]: the broker book shows an ` +
          `unattributable order on this contract — refusing to call the tranche never-placed`,
        { ambiguous: [...ambiguous] },
      )
      return false
    }
    const placedAt = Number(doc['placedAt'] ?? 0)
    // An absent `placedAt` is not "infinitely old" — the same rule
    // `isStaleOrder` states. A legacy document must not be aged out on a
    // timestamp it never had.
    if (placedAt <= 0 || now - placedAt <= ambiguousTtlMs) return false

    const base = String(doc['clientOrderId'] ?? '')
    if (base === '') throw new Error('PLACED document has no clientOrderId')

    let resolved = false
    for (const trancheId of ambiguous) {
      /**
       * A trace means it IS at the exchange. Its own fills will resolve it, and
       * nothing here may hurry that along: this is the branch that would
       * otherwise un-book a real position.
       */
      if (hasTrace(trancheId, seen)) continue
      await deps.queue.resolveAmbiguous(base, trancheId)
      resolved = true
      await deps.journal.record({
        clientOrderId: trancheId,
        phase: 'FAILED',
        ok: false,
        tag: String(doc['tag'] ?? ''),
        tradingsymbol: String(doc['tradingsymbol'] ?? ''),
        ts: now,
        mode: orderMode(doc),
        error: 'no broker trace after TTL — treating as never placed',
        errorClass: 'fatal',
      })
      deps.log(
        `AMBIGUOUS RESOLVED ${String(doc['tradingsymbol'] ?? '')} [${trancheId}]: ` +
          `no broker trace after ${Math.round(ambiguousTtlMs / 1000)}s — recorded as never placed`,
      )
    }
    if (resolved) {
      // The tranche is terminal now, so the desk order may be too: nothing else
      // re-decides it, because no broker update will ever arrive for a tranche
      // that never reached the broker.
      await deps.fills.reconcile(base)
    }
    return resolved
  }

  /** Step 3. Somebody is told about an order that has been resting too long. */
  const alertWorking = async (doc: Record<string, unknown>, now: number): Promise<void> => {
    if (doc['workingAlertedAt'] !== undefined) return
    const placedAt = Number(doc['placedAt'] ?? 0)
    if (placedAt <= 0 || now - placedAt <= workingAlertMs) return
    const base = String(doc['clientOrderId'] ?? '')
    if (base === '') throw new Error('PLACED document has no clientOrderId')

    const ageS = Math.round((now - placedAt) / 1000)
    const event: OrderEvent = {
      clientOrderId: base,
      phase: 'STATUS',
      ok: false,
      tag: String(doc['tag'] ?? ''),
      tradingsymbol: String(doc['tradingsymbol'] ?? ''),
      ts: now,
      mode: orderMode(doc),
      error:
        `order still WORKING after ${ageS}s — check the broker book; ` +
        `a resting exit is not an exit`,
    }
    await deps.journal.record(event)
    deps.notify?.(event)
    // Stamped LAST and only once: the alert exists to be noticed, and one line
    // per sweep for the same order is how a feed stops being read.
    await deps.orders.updateOne({ clientOrderId: base }, { $set: { workingAlertedAt: now } })
    deps.log(`WORKING ${String(doc['tradingsymbol'] ?? '')} [${base}]: ${event.error ?? ''}`)
  }

  return {
    get running(): boolean {
      return running
    },
    async run(): Promise<void> {
      // Single-flight: two passes would replay the same book into the fill
      // watcher concurrently and race each other's ambiguity resolution.
      if (running) return
      running = true
      try {
        const now = deps.now()
        const seen = await replay()

        const placed = await deps.orders
          .find({ ...(deps.ordersFilter ?? {}), state: 'PLACED' })
          .sort({ placedAt: 1 })
          .limit(maxOrders)
          .toArray()

        /**
         * TWO PASSES OVER THE SAME DOCUMENTS, not one.
         *
         * Resolving an ambiguity can make an order terminal, and the in-memory
         * document still says PLACED — so a single interleaved loop would send
         * an operator to the broker book for an order the sweep had just
         * settled. Anything resolved in the first pass is skipped by the second.
         */
        const justResolved = new Set<string>()
        for (const doc of placed) {
          try {
            if (await expireAmbiguous(doc, seen, now)) {
              justResolved.add(String(doc['clientOrderId'] ?? ''))
            }
          } catch (err) {
            // One bad document never stops a pass.
            deps.log('ambiguity resolution failed for one order', {
              clientOrderId: String(doc['clientOrderId'] ?? ''),
              error: String(err),
            })
          }
        }
        for (const doc of placed) {
          if (justResolved.has(String(doc['clientOrderId'] ?? ''))) continue
          try {
            await alertWorking(doc, now)
          } catch (err) {
            deps.log('working-order alert failed for one order', {
              clientOrderId: String(doc['clientOrderId'] ?? ''),
              error: String(err),
            })
          }
        }
      } catch (err) {
        // The broker read itself failed, or the order query did. The next tick
        // sweeps again; nothing here is stateful.
        deps.log('broker sweep FAILED — will retry on the next tick', { error: String(err) })
      } finally {
        running = false
      }
    },
  }
}

function asStrings(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}
