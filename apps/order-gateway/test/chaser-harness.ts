/**
 * The order chaser's fakes, shared by `order-chaser.test.ts` (the blind
 * ladder) and `order-chaser-peg.test.ts` (passive pegging).
 *
 * NOT a `.test.ts` file: the workspace runner globs `test/*.test.ts`, so this
 * is imported, never run. It was extracted verbatim from the blind-ladder
 * suite when peg mode arrived — one set of fakes means a change to the chaser's
 * ports cannot leave one of the two suites testing a shape production no
 * longer has.
 *
 * The QUOTE MAP is the real one, not a stub, sharing this harness's clock: the
 * staleness gate that decides whether a peg may move is the property most
 * worth exercising end to end, and a hand-written `touch()` stub would be the
 * one place it could silently answer "fresh" forever.
 */
import { createOrderChaser, type ChaserOrdersCollection, type ChaserReadCollection, type CloseWorker } from '../src/order-chaser.ts'
import { createQuoteMap, type QuoteMap } from '../src/quote-map.ts'
import type { OrderEvent } from '../src/journal.ts'

export const TAG = 'DESK_NIFTY'
export const SYMBOL = 'NIFTY25N2024500PE'
export const NOW = 1_700_000_000_000
/** The dwell every harness is built with — one rung may go out per this long. */
export const DWELL = 15_000
/**
 * The gateway booted an hour before `NOW`, so the default doc (placed at
 * NOW - 60s) is a POST-boot order the chaser is allowed to touch. Orders older
 * than the process itself are skipped — see the boot-skip tests.
 */
export const BOOTED = NOW - 3_600_000

export const orderDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientOrderId: 'ord-1',
  tag: TAG,
  tradingsymbol: SYMBOL,
  state: 'PLACED',
  placedAt: NOW - 60_000,
  transaction_type: 'SELL',
  order_type: 'LIMIT',
  limitPrice: 100,
  brokerOrderIds: ['987'],
  trancheIds: ['ord-1'],
  ...over,
})

/**
 * Equality, `$in` and `$ne` — the three shapes the chaser's queries use.
 *
 * `$ne` arrived with the paper rail: the gateway arms one chaser per rail and
 * scopes the live one with `{ mode: { $ne: 'paper' } }`. Mongo's `$ne` MATCHES A
 * MISSING FIELD, and this models that — a fake that treated absent as
 * non-matching would report every pre-existing live order as out of scope and
 * turn a working filter into a passing test.
 */
export function matches(filter: Record<string, unknown>, doc: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && '$in' in (v as Record<string, unknown>)) {
      return ((v as { $in: unknown[] }).$in).includes(doc[k])
    }
    if (v !== null && typeof v === 'object' && '$ne' in (v as Record<string, unknown>)) {
      return doc[k] !== (v as { $ne: unknown }).$ne
    }
    return doc[k] === v
  })
}

export class FakeOrders implements ChaserOrdersCollection {
  docs: Record<string, unknown>[] = []
  find(filter: Record<string, unknown>) {
    const match = this.docs.filter((d) => matches(filter, d))
    return {
      sort: () => ({ limit: (n: number) => ({ toArray: async () => match.slice(0, n) }) }),
    }
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<unknown> {
    const doc = this.docs.find((d) => matches(filter, d))
    if (doc !== undefined) {
      const set = update['$set'] as Record<string, unknown> | undefined
      if (set !== undefined) Object.assign(doc, set)
      const inc = update['$inc'] as Record<string, number> | undefined
      if (inc !== undefined) {
        for (const [k, v] of Object.entries(inc)) doc[k] = Number(doc[k] ?? 0) + v
      }
    }
    return { matchedCount: doc === undefined ? 0 : 1 }
  }
}

export class FakeReads implements ChaserReadCollection {
  readonly rows: Record<string, unknown>[]
  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows
  }
  find(filter: Record<string, unknown>) {
    return { toArray: async () => this.rows.filter((r) => matches(filter, r)) }
  }
}

export interface Harness {
  run: () => Promise<void>
  orders: FakeOrders
  modifies: { brokerOrderId: string; price: number }[]
  events: OrderEvent[]
  notified: OrderEvent[]
  logs: string[]
  clock: { now: number }
  /** The real quote map behind the peg. Feed it with `onTick`. */
  quotes: QuoteMap
}

export interface HarnessOptions {
  docs?: Record<string, unknown>[]
  cancels?: Record<string, unknown>[]
  fillRows?: Record<string, unknown>[]
  /** What the broker says to each modify. Default: accepted. May throw. */
  modifyResult?: (brokerOrderId: string, price: number) => boolean
  canModify?: boolean
  disabled?: () => boolean
  ordersFind?: () => never
  chaseAfterMs?: number
  stepPct?: number
  minTicks?: number
  maxAttempts?: number
  pegDwellMs?: number
  /** Omit the quote map entirely — a gateway with no feed wired. */
  noQuotes?: boolean
  /**
   * Which documents this chaser owns. The gateway arms one per RAIL since the
   * engine's paper lifecycle landed, so the filter is part of the wiring under
   * test rather than a convenience.
   */
  ordersFilter?: Record<string, unknown>
  /** The Delta close worker (`dx-close.ts`): exits are escalated, never handed back. */
  closes?: CloseWorker
}

export function harness(opts: HarnessOptions = {}): Harness {
  const orders = new FakeOrders()
  for (const d of opts.docs ?? []) orders.docs.push(d)
  if (opts.ordersFind !== undefined) {
    orders.find = opts.ordersFind as never
  }
  const modifies: { brokerOrderId: string; price: number }[] = []
  const events: OrderEvent[] = []
  const notified: OrderEvent[] = []
  const logs: string[] = []
  // Constructed AT boot, then wound forward: the chaser stamps `bootedAt` from
  // the clock it is handed, so a harness that builds it at `NOW` would declare
  // every fixture order pre-deploy and chase nothing.
  const clock = { now: BOOTED }
  const quotes = createQuoteMap({ now: () => clock.now })

  const chaser = createOrderChaser(
    {
      adapter: {
        capabilities: { orders: true, marketData: false, modify: opts.canModify ?? true },
        modifyOrder: async (brokerOrderId: string, price: number) => {
          modifies.push({ brokerOrderId, price })
          return opts.modifyResult === undefined ? true : opts.modifyResult(brokerOrderId, price)
        },
      },
      orders,
      cancels: new FakeReads(opts.cancels ?? []),
      fills: new FakeReads(opts.fillRows ?? []),
      journal: { record: async (e: OrderEvent) => void events.push(e) },
      notify: (e: OrderEvent) => void notified.push(e),
      ...(opts.disabled === undefined ? {} : { disabled: opts.disabled }),
      ...(opts.noQuotes === true ? {} : { quotes }),
      ...(opts.ordersFilter === undefined ? {} : { ordersFilter: opts.ordersFilter }),
      ...(opts.closes === undefined ? {} : { closes: opts.closes }),
      now: () => clock.now,
      log: (m: string) => void logs.push(m),
    },
    {
      chaseAfterMs: opts.chaseAfterMs ?? DWELL,
      stepPct: opts.stepPct ?? 0.03,
      minTicks: opts.minTicks ?? 2,
      maxAttempts: opts.maxAttempts ?? 3,
      ...(opts.pegDwellMs === undefined ? {} : { pegDwellMs: opts.pegDwellMs }),
    },
  )
  clock.now = NOW

  return { run: () => chaser.run(), orders, modifies, events, notified, logs, clock, quotes }
}
