/**
 * THE PAPER ORPHAN SWEEP — the one thing a restart takes from a paper order
 * that it does not take from a live one (D14, review IMP-1).
 *
 * THE HOLE. A live resting order survives this process dying: it is at the
 * exchange, and three independent things go and find it again — the order
 * socket replays its updates, the broker sweep reads it out of the broker's own
 * book, and the boot reconcile re-decides every PLACED document. A PAPER
 * resting order has none of that. It lives in the SimulatorAdapter's in-memory
 * map, which a restart empties; the broker sweep is deliberately scoped away
 * from it (there is no broker book to find it in); the chaser's `modifyOrder`
 * against a `sim-N` the new simulator never issued answers false forever; and
 * the boot reconcile decides from `desk-fills`, which has no row for an order
 * that never traded.
 *
 * So the document sits `PLACED` for the rest of the session, `paper-fold.ts`
 * never sees it (it scans TERMINAL states only), and the decision that owns it
 * stays `WORKING` — with the supervisor holding it `inFlight` and forming no
 * further package for that book. A paper rehearsal that a `pm2 restart` can
 * silently end is not a rehearsal.
 *
 * THE RULE IS A FACT, NOT A TIMEOUT. An order `placedAt` BEFORE this process
 * booted cannot be in this process's simulator — there is no mechanism by which
 * it could be, because the simulator's book is created empty at construction.
 * That is what makes it safe to condemn, and it is why this cannot race a fill:
 * an order this process placed is never eligible, whatever its age.
 *
 * The grace period is not part of the verdict; it only delays it. Boot does
 * several things concurrently (the reconcile of PLACED documents, the socket
 * wiring, the first bus frames), and declaring an order dead in the middle of
 * that would be right for the wrong reason.
 *
 * IT PLACES NOTHING AND CANCELS NOTHING. It marks a document REJECTED with zero
 * filled — which is the truth, because nothing traded — and writes a LOUD
 * journal line, so `paper-fold.ts` settles the package on its next pass and an
 * operator can see why the rehearsal stopped.
 */

import type { BrokerAdapter } from '@algomaker/brokers'
import { orderMode, type OrderJournal } from './journal.ts'
import type { OrderQueue } from './queue.ts'

/**
 * How long after boot the sweep starts condemning. Not a staleness bound on the
 * ORDER — see the header; it is a bound on this process's own startup.
 */
export const DEFAULT_PAPER_ORPHAN_MS = 120_000
/** Bounded per pass so one tick's work stays one tick's work. */
const DEFAULT_MAX_ORDERS = 200

/** The narrow slice of `desk-gateway-orders` this needs. Same port style as broker-sweep.ts. */
export interface PaperSweepOrders {
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): {
      limit(n: number): { toArray(): Promise<Record<string, unknown>[]> }
    }
  }
}

export interface PaperSweepDeps {
  /**
   * READ-ONLY BY TYPE: the sweep is handed the one method it may call, and it
   * is the SIMULATOR's book — the only authority on which paper orders are
   * still resting in this process.
   */
  readonly adapter: Pick<BrokerAdapter, 'orderBook'>
  readonly queue: Pick<OrderQueue, 'markTerminal'>
  readonly journal: Pick<OrderJournal, 'record'>
  readonly orders: PaperSweepOrders
  /**
   * WHICH DOCUMENTS THE SIMULATOR HOLDS. Default: everything not routed to
   * Delta (`mode` other than exactly `'live'`). A simulate box, where the one
   * simulator serves both rails, passes `{}`.
   */
  readonly ordersFilter?: Record<string, unknown>
  /** When THIS process came up. The whole verdict turns on it. */
  readonly bootedAt: number
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface PaperSweepOptions {
  readonly orphanAfterMs?: number
  readonly maxOrders?: number
}

export interface PaperSweep {
  /** One pass. NEVER REJECTS, never overlaps itself. */
  run(): Promise<{ readonly scanned: number; readonly orphaned: number }>
  readonly running: boolean
}

const IDLE = { scanned: 0, orphaned: 0 }

export function createPaperSweep(
  deps: PaperSweepDeps,
  opts: PaperSweepOptions = {},
): PaperSweep {
  const orphanAfterMs = positive(opts.orphanAfterMs, DEFAULT_PAPER_ORPHAN_MS)
  const maxOrders = positive(opts.maxOrders, DEFAULT_MAX_ORDERS)
  let running = false

  return {
    get running(): boolean {
      return running
    },

    async run(): Promise<{ scanned: number; orphaned: number }> {
      if (running) return IDLE
      running = true
      try {
        // The grace period, and nothing else about the clock matters here.
        if (deps.now() - deps.bootedAt < orphanAfterMs) return IDLE

        const placed = await deps.orders
          .find({ ...(deps.ordersFilter ?? { mode: { $ne: 'live' } }), state: 'PLACED' })
          .sort({ placedAt: 1 })
          .limit(maxOrders)
          .toArray()
        if (placed.length === 0) return IDLE

        /**
         * WHAT THE SIMULATOR IS ACTUALLY HOLDING. Belt and braces on top of the
         * `placedAt < bootedAt` rule: today the two can never disagree, and if
         * a future simulator ever persisted its book across a restart this
         * would stop condemning the orders it recovered — rather than needing
         * somebody to remember that this file exists.
         */
        let resting: Set<string>
        try {
          resting = new Set((await deps.adapter.orderBook()).map((o) => o.brokerOrderId))
        } catch (err) {
          // Unreadable is not "empty". Condemning on a failed read would end a
          // rehearsal because one call threw.
          deps.log('paper sweep: the simulator book could not be read — nothing condemned', {
            error: err instanceof Error ? err.message : String(err),
          })
          return { scanned: placed.length, orphaned: 0 }
        }

        let orphaned = 0
        for (const doc of placed) {
          const clientOrderId = String(doc['clientOrderId'] ?? '')
          if (clientOrderId === '') continue
          // Placed by THIS process: the simulator owns it, whatever its age.
          const placedAt = Number(doc['placedAt'] ?? 0)
          if (!(placedAt > 0) || placedAt >= deps.bootedAt) continue
          const brokerIds = asStrings(doc['brokerOrderIds'])
          if (brokerIds.some((id) => resting.has(id))) continue

          const reason =
            `paper order orphaned by a gateway restart — it was resting in a simulator that no ` +
            `longer exists, so no tick can ever fill it and nothing else can settle it. Marked ` +
            `REJECTED with nothing traded so the decision that owns it stops WORKING; re-decide ` +
            `it if the book still wants the position.`
          try {
            // THE JOURNAL FIRST, as every refusal on this desk is written: a
            // crash in between leaves an orphan that is explained but not yet
            // terminal, and the next pass reaches the same conclusion.
            await deps.journal.record({
              clientOrderId,
              phase: 'FAILED',
              ok: false,
              tag: String(doc['tag'] ?? ''),
              tradingsymbol: String(doc['tradingsymbol'] ?? ''),
              ts: deps.now(),
              mode: orderMode(doc),
              status: 'REJECTED',
              filledQty: 0,
              avgPrice: null,
              error: reason,
              errorClass: 'fatal',
              detail: { source: 'paper-sweep', mode: 'paper', placedAt, bootedAt: deps.bootedAt },
            })
            await deps.queue.markTerminal(clientOrderId, 'REJECTED', {
              filledQty: 0,
              avgPrice: null,
              reason,
            })
            orphaned++
            deps.log(`PAPER ORPHAN ${String(doc['tradingsymbol'] ?? '')} [${clientOrderId}]: ${reason}`)
          } catch (err) {
            // One document never stops the pass, and an unmarked one is simply
            // retried on the next tick.
            deps.log('paper sweep: one orphan could not be marked', {
              clientOrderId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        return { scanned: placed.length, orphaned }
      } catch (err) {
        deps.log('paper sweep FAILED — will retry on the next tick', {
          error: err instanceof Error ? err.message : String(err),
        })
        return IDLE
      } finally {
        running = false
      }
    },
  }
}

function asStrings(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}
