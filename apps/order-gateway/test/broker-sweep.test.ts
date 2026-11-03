import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrokerOrder, PlacedOrder } from '@algomaker/brokers'
import { createBrokerSweep, type BrokerSweepDeps, type SweepOrdersCollection } from '../src/broker-sweep.ts'
import { FillWatcher } from '../src/fills.ts'
import { backstopClientOrderId } from '../src/dx-backstop.ts'
import { OrderQueue } from '../src/queue.ts'
import type { OrderEvent } from '../src/journal.ts'

/**
 * The sweep is the desk's ONLY answer to "the order socket died" (F-1) and to
 * "we never heard back from a placement" (F-3), so what these assert is mostly
 * what it must NOT do: never place, never cancel, never adopt a stranger's
 * order, never call a tranche failed while the broker still shows it.
 */

const TAG = 'DESK_BHEL'
const SYMBOL = 'BHEL26AUG420CE'
const NOW = 1_700_000_000_000

const row = (over: Partial<BrokerOrder> = {}): BrokerOrder => ({
  brokerOrderId: '987',
  clientOrderId: 'ord-1.1',
  tradingsymbol: SYMBOL,
  status: 'FILLED',
  filledQty: 13125,
  avgPrice: 14.85,
  ...over,
})

const orderDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientOrderId: 'ord-1',
  tag: TAG,
  tradingsymbol: SYMBOL,
  state: 'PLACED',
  placedAt: NOW - 60_000,
  trancheIds: ['ord-1.1'],
  failedTrancheIds: [],
  ambiguousTrancheIds: [],
  brokerOrderIds: ['987'],
  expectedQty: 13125,
  ...over,
})

class FakeOrders implements SweepOrdersCollection {
  docs: Record<string, unknown>[] = []
  find(filter: Record<string, unknown>) {
    const match = this.docs.filter((d) =>
      /**
       * Equality and `$ne`, because the gateway scopes this sweep to the LIVE
       * rail with `{ mode: { $ne: 'paper' } }`. Mongo's `$ne` MATCHES A MISSING
       * FIELD and this models that: a fake that read absent as non-matching
       * would report every existing live order as out of scope and turn a
       * working filter into a passing test.
       */
      Object.entries(filter).every(([k, v]) =>
        v !== null && typeof v === 'object' && '$ne' in (v as Record<string, unknown>)
          ? d[k] !== (v as { $ne: unknown }).$ne
          : d[k] === v,
      ),
    )
    return {
      sort: () => ({ limit: (n: number) => ({ toArray: async () => match.slice(0, n) }) }),
    }
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<unknown> {
    const doc = this.docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v))
    if (doc !== undefined) Object.assign(doc, (update['$set'] as Record<string, unknown>) ?? {})
    return { matchedCount: doc === undefined ? 0 : 1 }
  }
}

interface Harness {
  run: () => Promise<void>
  orders: FakeOrders
  handled: PlacedOrder[]
  /** The second argument of every `handle` call — which rail the sweep said. */
  handleOpts: (Record<string, unknown> | undefined)[]
  /** The second argument of every `resolve` call — the pre-check's options. */
  resolveOpts: (Record<string, unknown> | undefined)[]
  reconciled: string[]
  resolved: { clientOrderId: string; trancheId: string }[]
  events: OrderEvent[]
  notified: OrderEvent[]
  logs: string[]
  book: BrokerOrder[]
  clock: { now: number }
  brokerCalls: string[]
}

function harness(opts: {
  book?: BrokerOrder[]
  docs?: Record<string, unknown>[]
  ambiguousTtlMs?: number
  workingAlertMs?: number
  orderBook?: () => Promise<readonly BrokerOrder[]>
  /** Which documents this sweep owns — the gateway scopes it to the live rail. */
  ordersFilter?: Record<string, unknown>
  /** What the fill watcher answers when asked whose row this is. Default: ours. */
  resolvable?: boolean
  /**
   * A REAL fill watcher in place of the stub, for the tests about what the
   * two say together — the stub answers, it never logs. Built by the caller so
   * it can share `logs`.
   */
  fills?: BrokerSweepDeps['fills']
  /** A log sink to share with a caller-built `fills`. */
  logs?: string[]
  /** The swept book's rail; absent is live. */
  rail?: 'live' | 'paper'
} = {}): Harness {
  const orders = new FakeOrders()
  for (const d of opts.docs ?? []) orders.docs.push(d)
  const book = opts.book ?? []
  const handled: PlacedOrder[] = []
  const handleOpts: (Record<string, unknown> | undefined)[] = []
  const resolveOpts: (Record<string, unknown> | undefined)[] = []
  const reconciled: string[] = []
  const resolved: { clientOrderId: string; trancheId: string }[] = []
  const events: OrderEvent[] = []
  const notified: OrderEvent[] = []
  const logs: string[] = opts.logs ?? []
  const clock = { now: NOW }
  const brokerCalls: string[] = []

  const sweep = createBrokerSweep(
    {
      ...(opts.rail === undefined ? {} : { rail: opts.rail }),
      adapter: {
        orderBook: async () => {
          brokerCalls.push('orderBook')
          return opts.orderBook === undefined ? book : await opts.orderBook()
        },
        // Present so a sweep that tried to trade would actually be able to —
        // the assertion below is that it never does, not that it cannot.
        placeOrder: async () => {
          brokerCalls.push('placeOrder')
          throw new Error('the sweep must never place')
        },
        cancelOrder: async () => {
          brokerCalls.push('cancelOrder')
          return false
        },
        modifyOrder: async () => {
          brokerCalls.push('modifyOrder')
          return false
        },
      } as never,
      queue: {
        getByBrokerOrderId: async (bid: string) =>
          orders.docs.find((d) => (d['brokerOrderIds'] as string[] | undefined)?.includes(bid)) ??
          null,
        resolveAmbiguous: async (clientOrderId: string, trancheId: string) => {
          resolved.push({ clientOrderId, trancheId })
          const doc = orders.docs.find((d) => d['clientOrderId'] === clientOrderId)
          if (doc === undefined) return
          doc['ambiguousTrancheIds'] = (doc['ambiguousTrancheIds'] as string[]).filter(
            (t) => t !== trancheId,
          )
          doc['failedTrancheIds'] = [...(doc['failedTrancheIds'] as string[]), trancheId]
        },
      },
      fills: opts.fills ?? {
        handle: async (u: PlacedOrder, o?: { rail?: 'live' | 'paper' }) => {
          handled.push(u)
          handleOpts.push(o)
        },
        reconcile: async (base: string) => void reconciled.push(base),
        // Attributable by default: the watcher's own resolution is tested in
        // fills.test.ts, and what the sweep does with "no" is tested here.
        resolve: async (u: PlacedOrder, o?: Record<string, unknown>) => {
          resolveOpts.push(o)
          return opts.resolvable === false ? null : ({ base: 'ord-1', update: u } as never)
        },
      },
      journal: { record: async (e: OrderEvent) => void events.push(e) },
      orders,
      ...(opts.ordersFilter === undefined ? {} : { ordersFilter: opts.ordersFilter }),
      notify: (e: OrderEvent) => void notified.push(e),
      now: () => clock.now,
      log: (m: string) => void logs.push(m),
    },
    {
      ...(opts.ambiguousTtlMs === undefined ? {} : { ambiguousTtlMs: opts.ambiguousTtlMs }),
      ...(opts.workingAlertMs === undefined ? {} : { workingAlertMs: opts.workingAlertMs }),
    },
  )

  return {
    run: () => sweep.run(),
    orders,
    handled,
    handleOpts,
    resolveOpts,
    reconciled,
    resolved,
    events,
    notified,
    logs,
    book,
    clock,
    brokerCalls,
  }
}

// ------------------------------------------------------------ replaying truth

test('a broker row for a known tranche is replayed into the fill watcher, with its price', async () => {
  // THE F-1 SCENARIO: the order socket is dead, so this row is the only news of
  // a fill that happened twenty minutes ago.
  const h = harness({ book: [row()], docs: [orderDoc()] })
  await h.run()
  assert.equal(h.handled.length, 1)
  assert.deepEqual(h.handled[0], {
    brokerOrderId: '987',
    clientOrderId: 'ord-1.1',
    status: 'FILLED',
    filledQty: 13125,
    avgPrice: 14.85,
    tradingsymbol: SYMBOL,
  })
})

test('the sweep replays every row on the live rail', async () => {
  // The sweep reads the LIVE broker's book (main.ts wires it in xts mode
  // only), so every row it replays is a live row, and the watcher must not
  // resolve one to a paper document by a broker id the simulator happened to
  // reuse. Said explicitly on each call rather than inferred from the doc.
  const h = harness({ book: [row(), row({ brokerOrderId: '988', clientOrderId: null })], docs: [orderDoc({ brokerOrderIds: ['987', '988'] })] })
  await h.run()
  assert.equal(h.handled.length, 2)
  assert.deepEqual(h.handleOpts, [{ rail: 'live' }, { rail: 'live' }])
})

test("the demo rail's sweep replays testnet's book as PAPER rows", async () => {
  const h = harness({ rail: 'paper', book: [row()], docs: [orderDoc({ mode: 'paper', dx_paper_rail: 'demo' })] })
  await h.run()
  assert.deepEqual(h.handleOpts, [{ rail: 'paper' }])
  assert.deepEqual(h.resolveOpts, [{ rail: 'paper', quiet: true }])
})

test('the sweep places, cancels and modifies NOTHING — it only reads', async () => {
  const h = harness({
    book: [row({ status: 'WORKING', filledQty: 0, avgPrice: null })],
    docs: [orderDoc({ placedAt: NOW - 10 * 60_000 })],
    workingAlertMs: 60_000,
  })
  await h.run()
  assert.deepEqual(h.brokerCalls, ['orderBook'])
})

test('every run replays the book — suppressing the repeat is the fill watcher’s job', async () => {
  // Deliberately NOT deduped here. `FillWatcher.#handle` already suppresses an
  // exact repeat (`isMeaningfulUpdate`, tested in fills.test.ts), and a second
  // dedup in the sweep would swallow the one update that changed after a
  // gateway restart cleared the watcher's memory.
  const h = harness({ book: [row()], docs: [orderDoc()] })
  await h.run()
  await h.run()
  assert.equal(h.handled.length, 2)
})

test('a FOREIGN row is never adopted, and is logged once per process', async () => {
  // A manual order on the same account. Adopting it would book a position the
  // desk never asked for; staying silent about it would hide a hand-placed
  // order sitting against the desk's own legs.
  const foreign = row({ brokerOrderId: '55', clientOrderId: null, tradingsymbol: 'INFY26AUGFUT' })
  const h = harness({ book: [foreign], docs: [orderDoc()] })
  await h.run()
  await h.run()
  assert.equal(h.handled.length, 0)
  const complaints = h.logs.filter((l) => l.includes('NOT adopted'))
  assert.equal(complaints.length, 1, 'one line per unknown order, not one per sweep')
  assert.ok(complaints[0]?.includes('55'), 'the line names the order to look up')
})

test('a correlated row for an order this desk never placed writes no fill row and no STATUS event', async () => {
  // A row CAN carry a correlation id and still be nobody's: a wire id from a
  // book purged since, another desk's tag on the same account, an id the
  // watcher refuses as stale or on the wrong rail. Handing it to `handle`
  // wrote a `desk-fills` row with `tag: ''` and a STATUS event under no book
  // on EVERY pass — the untagged rows the operator sees (F11). The socket path
  // still records unattributed rows, because there the row may be a raced
  // fill of an order about to get its broker id; the sweep replays the same
  // book every 45 s, so for it "unknown now" is "unknown".
  const h = harness({ book: [row({ clientOrderId: 'ghost-1' })], docs: [orderDoc()], resolvable: false })
  await h.run()
  assert.deepEqual(h.handled, [])
  assert.deepEqual(h.events, [])
  const complaints = h.logs.filter((l) => l.includes('correlated but unknown to this desk'))
  assert.equal(complaints.length, 1)
  assert.ok(complaints[0]?.includes('987'), 'the line names the broker order to look up')

  await h.run()
  assert.equal(h.logs.filter((l) => l.includes('correlated but unknown to this desk')).length, 1, 'once per process')
})

test('the pre-check asks the watcher QUIETLY — the sweep announces a refused id itself, once', async () => {
  // `resolve` logs its own refusals (stale, rail, contract) and the sweep
  // asks it per row on EVERY pass, before its own once-per-id guard — so the
  // watcher's line repeated every 45 s for as long as the day book listed the
  // order. The sweep's `foreign broker order … NOT recorded` line is the one
  // that stays; the watcher's is asked away.
  const h = harness({ book: [row()], docs: [orderDoc()] })
  await h.run()
  assert.deepEqual(h.resolveOpts, [{ rail: 'live', quiet: true }])
})

test('a repeated sweep pass over a stale, refused row logs the refusal ONCE — with the real watcher', async () => {
  // The sweep and the watcher together, since the noise was in their sum: a
  // yesterday's FILLED document holding a recycled id, listed on today's day
  // book. Pass one names it; pass two, three, … say nothing.
  const logs: string[] = []
  const stale = orderDoc({ state: 'FILLED', placedAt: NOW - 18 * 3_600_000, createdAt: NOW - 18 * 3_600_000 })
  const queueDocs = [stale]
  const queue = new OrderQueue({
    collection: {
      find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => queueDocs }) }) }),
      findOne: async () => null,
      findOneAndUpdate: async () => null,
      updateOne: async () => {},
      createIndex: async () => {},
    } as never,
    workerId: 'w',
    now: () => NOW,
  })
  const watcher = new FillWatcher({
    fills: {
      insertOne: async () => {},
      find: () => ({ toArray: async () => [] }),
      createIndex: async () => {},
    } as never,
    queue,
    journal: { record: async () => {} },
    now: () => NOW,
    log: (m: string) => void logs.push(m),
  })
  const h = harness({ book: [row({ clientOrderId: null })], docs: [stale], fills: watcher, logs })
  await h.run()
  await h.run()
  await h.run()
  const refusals = logs.filter((l) => l.includes('NOT adopted') || l.includes('NOT recorded'))
  assert.equal(refusals.length, 1, `one line for three passes, not three:\n${logs.join('\n')}`)
  assert.ok(refusals[0]?.includes('987'), 'and it names the broker order to look up')
})

test('a row with no correlation id but a KNOWN broker id is ours, and is replayed', async () => {
  // XTS truncates `OrderUniqueIdentifier`, and some rows come back without one
  // at all. The AppOrderID stored at ACK survives both.
  const h = harness({
    book: [row({ clientOrderId: null })],
    docs: [orderDoc()],
  })
  await h.run()
  assert.equal(h.handled.length, 1)
  assert.equal(h.handled[0]?.clientOrderId, '')
})

test('a broker status this desk does not model is skipped, not guessed', async () => {
  const h = harness({
    book: [row({ status: 'SomethingNew' as never })],
    docs: [orderDoc()],
  })
  await h.run()
  assert.equal(h.handled.length, 0)
})

// -------------------------------------------------------- ambiguous tranches

const AMBIGUOUS = orderDoc({
  trancheIds: ['ord-1.1', 'ord-1.2'],
  brokerOrderIds: ['987'],
  ambiguousTrancheIds: ['ord-1.2'],
  placedAt: NOW - 15 * 60_000,
})

test('an ambiguous tranche the broker still shows is LEFT ALONE, however old', async () => {
  // It is live at the exchange. Calling it failed would un-book a real
  // position, which is the entire defect F-3 describes.
  const h = harness({
    book: [row({ brokerOrderId: '9002', clientOrderId: 'ord-1.2', status: 'WORKING', filledQty: 0, avgPrice: null })],
    docs: [{ ...AMBIGUOUS }],
    ambiguousTtlMs: 600_000,
  })
  await h.run()
  assert.deepEqual(h.resolved, [])
})

test('a TRUNCATED correlation id still counts as a broker trace', async () => {
  // The wire id is `tag|clientOrderId` capped at 45 chars, so a long tag leaves
  // the book showing only a prefix. A prefix match is the conservative read:
  // the failure it risks is leaving an order open for a human to settle, and
  // the failure it prevents is un-booking a live position.
  const h = harness({
    book: [row({ brokerOrderId: '9002', clientOrderId: 'ord-1.', status: 'WORKING', filledQty: 0, avgPrice: null })],
    docs: [{ ...AMBIGUOUS }],
    ambiguousTtlMs: 600_000,
  })
  await h.run()
  assert.deepEqual(h.resolved, [])
})

test('an ambiguous tranche with NO trace is failed after the TTL, and reconciled', async () => {
  const h = harness({ book: [], docs: [{ ...AMBIGUOUS }], ambiguousTtlMs: 600_000 })
  await h.run()
  assert.deepEqual(h.resolved, [{ clientOrderId: 'ord-1', trancheId: 'ord-1.2' }])
  assert.deepEqual(h.reconciled, ['ord-1'])
  const failure = h.events.find((e) => e.phase === 'FAILED')
  assert.equal(failure?.errorClass, 'fatal')
  assert.match(String(failure?.error), /no broker trace after TTL/)
  assert.equal(failure?.clientOrderId, 'ord-1.2')
})

test("an UNATTRIBUTABLE row spelled the broker's way on the same exchange token holds the ambiguity open", async () => {
  // On live the book row and the document never spell the contract the same
  // way (XTS `NIFTY 22SEP2026 PE 23150`, master `NIFTY2692223150PE`), so a
  // guard keyed on the symbol string is inert on the one rail it protects —
  // the tranche below would be failed and a live position un-booked (F4).
  // The exchange token is what both sides agree on.
  const h = harness({
    book: [row({
      brokerOrderId: '4242', clientOrderId: null, status: 'WORKING', filledQty: 0, avgPrice: null,
      tradingsymbol: 'NIFTY 22SEP2026 PE 23150', exchangeToken: 61623,
    })],
    docs: [{ ...AMBIGUOUS, tradingsymbol: 'NIFTY2692223150PE', instrument_token: 61623 * 256 + 2 }],
    ambiguousTtlMs: 600_000,
  })
  await h.run()
  assert.deepEqual(h.resolved, [])
  assert.ok(h.logs.some((l) => l.includes('AMBIGUOUS HELD')))
})

test('an UNATTRIBUTABLE row on ANOTHER exchange token does not hold an ambiguity open', async () => {
  // The token is the verdict when both sides carry one — a stranger's order on
  // a different contract must not keep this order open forever.
  const h = harness({
    book: [row({
      brokerOrderId: '4242', clientOrderId: null, status: 'WORKING', filledQty: 0, avgPrice: null,
      tradingsymbol: 'NIFTY 22SEP2026 PE 23100', exchangeToken: 61646,
    })],
    docs: [{ ...AMBIGUOUS, tradingsymbol: 'NIFTY2692223150PE', instrument_token: 61623 * 256 + 2 }],
    ambiguousTtlMs: 600_000,
  })
  await h.run()
  assert.deepEqual(h.resolved, [{ clientOrderId: 'ord-1', trancheId: 'ord-1.2' }])
})

test('an UNATTRIBUTABLE row on the same contract holds the ambiguity open', async () => {
  // The one way this could un-book a live position: the tranche DID reach the
  // exchange but comes back with no correlation id, so it reads as a stranger's
  // order and its own tranche looks traceless. When a row we cannot attribute
  // names the very contract in question, the honest answer is "unresolved" —
  // the order stays PLACED and the working-order alert sends a human to look.
  const h = harness({
    book: [row({ brokerOrderId: '4242', clientOrderId: null, status: 'WORKING', filledQty: 0, avgPrice: null })],
    docs: [{ ...AMBIGUOUS }],
    ambiguousTtlMs: 600_000,
    workingAlertMs: 300_000,
  })
  await h.run()
  assert.deepEqual(h.resolved, [])
  assert.ok(h.logs.some((l) => l.includes('unattributable')))
  // ...and it is NOT quietly dropped: the operator is told the order is resting.
  assert.equal(h.events.filter((e) => e.phase === 'STATUS' && e.ok === false).length, 1)
})

test('...but NOT before the TTL — an in-flight ambiguity is simply unresolved', async () => {
  const h = harness({
    book: [],
    docs: [{ ...AMBIGUOUS, placedAt: NOW - 60_000 }],
    ambiguousTtlMs: 600_000,
  })
  await h.run()
  assert.deepEqual(h.resolved, [])
  assert.deepEqual(h.reconciled, [])
})

test('an order with nothing ambiguous is never reconciled by the sweep', async () => {
  const h = harness({ book: [], docs: [orderDoc()], ambiguousTtlMs: 600_000 })
  await h.run()
  assert.deepEqual(h.reconciled, [])
})

// -------------------------------------------------------- working-order alert

test('an order still PLACED past the alert window is alerted, ONCE', async () => {
  // F-17: an unfilled marketable limit rests all session. A resting exit is not
  // an exit, and nobody is told.
  const h = harness({
    book: [],
    docs: [orderDoc({ placedAt: NOW - 6 * 60_000 })],
    workingAlertMs: 300_000,
  })
  await h.run()
  const alert = h.events.filter((e) => e.phase === 'STATUS' && e.ok === false)
  assert.equal(alert.length, 1)
  assert.match(String(alert[0]?.error), /still WORKING/)
  assert.equal(alert[0]?.tag, TAG)
  assert.equal(h.notified.length, 1)
  assert.equal(h.orders.docs[0]?.['workingAlertedAt'], NOW)

  h.clock.now = NOW + 60_000
  await h.run()
  assert.equal(h.events.filter((e) => e.phase === 'STATUS' && e.ok === false).length, 1)
})

test('a young PLACED order is not alerted', async () => {
  const h = harness({
    book: [],
    docs: [orderDoc({ placedAt: NOW - 60_000 })],
    workingAlertMs: 300_000,
  })
  await h.run()
  assert.deepEqual(h.events, [])
})

test('an order whose ambiguity was just resolved is not ALSO alerted as working', async () => {
  // It may have become terminal a millisecond ago; the in-memory document still
  // says PLACED. Alerting on it would send an operator to the broker book for
  // an order the sweep itself has just settled.
  const h = harness({
    book: [],
    docs: [{ ...AMBIGUOUS }],
    ambiguousTtlMs: 600_000,
    workingAlertMs: 300_000,
  })
  await h.run()
  assert.equal(h.events.filter((e) => e.phase === 'STATUS').length, 0)
})

// -------------------------------------------------------------- robustness

test('a broker book that throws does not reject the sweep', async () => {
  const h = harness({
    docs: [orderDoc()],
    orderBook: async () => {
      throw new Error('request timed out after 15000ms')
    },
  })
  await h.run()
  assert.ok(h.logs.some((l) => l.includes('FAILED')))
})

test('one bad document does not stop the pass', async () => {
  const h = harness({
    book: [],
    docs: [
      // No clientOrderId at all: `resolveAmbiguous` cannot name it.
      { state: 'PLACED', placedAt: NOW - 15 * 60_000, ambiguousTrancheIds: ['x.1'] },
      orderDoc({ placedAt: NOW - 15 * 60_000 }),
    ],
    ambiguousTtlMs: 600_000,
    workingAlertMs: 300_000,
  })
  await h.run()
  assert.equal(
    h.events.filter((e) => e.phase === 'STATUS' && e.ok === false).length,
    1,
    'the second document is still alerted',
  )
})

test('overlapping runs are single-flighted', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const h = harness({
    docs: [],
    orderBook: async () => {
      await gate
      return []
    },
  })
  const first = h.run()
  const second = h.run()
  release()
  await Promise.all([first, second])
  assert.equal(h.brokerCalls.filter((c) => c === 'orderBook').length, 1)
})

// ------------------------------------------------------------- rail scoping

/**
 * THE SWEEP READS THE BROKER'S OWN BOOK, so it can only speak for orders the
 * broker knows about (D14, plan Task 18).
 *
 * `desk-gateway-orders` carries simulated orders since the engine's paper
 * lifecycle landed, and they have no row in that book at all. Left in scope,
 * every pass would find a paper order traceless — and past the ambiguous TTL
 * would declare a placed order never placed, or alert on it as a resting order
 * nobody is watching. So the gateway scopes this to the live rail.
 */
test('a PAPER document is out of scope — no alert, no verdict, nothing', async () => {
  const h = harness({
    ordersFilter: { mode: { $ne: 'paper' } },
    // Traceless in the broker's book and long past the working alert.
    book: [],
    docs: [orderDoc({ clientOrderId: 'paper-1', mode: 'paper', placedAt: NOW - 3_600_000 })],
    workingAlertMs: 1_000,
  })
  await h.run()
  assert.deepEqual(h.events, [], 'a simulated order is not this pass\u2019s to alert on')
  assert.deepEqual(h.reconciled, [])
})

test('a LIVE document with NO mode is still swept — `$ne` matches a missing field', async () => {
  const h = harness({
    ordersFilter: { mode: { $ne: 'paper' } },
    book: [],
    docs: [orderDoc({ placedAt: NOW - 3_600_000 })],
    workingAlertMs: 1_000,
  })
  await h.run()
  assert.equal(h.events.length > 0, true, 'the existing live book keeps its alerts')
})

test("an exchange BACKSTOP row is the backstop loop's: not replayed, not resolved, not called foreign", async () => {
  // `dx-backstop.ts` rests a reduce-only stop per short leg. It is no desk
  // order: replaying it would ask the watcher about it every pass and log it
  // as a foreign order, noise on exactly the orders that must be left alone.
  const stop = row({ brokerOrderId: '77', clientOrderId: backstopClientOrderId('live', TAG, SYMBOL), status: 'WORKING', filledQty: 0 })
  const h = harness({ book: [stop], docs: [orderDoc()], resolvable: true })
  await h.run()
  assert.deepEqual(h.handled, [])
  assert.equal(h.logs.filter((l) => l.includes('77')).length, 0)
})
