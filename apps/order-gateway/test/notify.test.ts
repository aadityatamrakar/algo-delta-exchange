/**
 * The desk-api notify — and the one property it exists to have: it CANNOT cost
 * an order.
 *
 * This process places real money. A dashboard that missed an update is an
 * inconvenience; a gateway that stalled on a notification is an outage. So the
 * interesting tests here are all negative: a notifier that throws, one that
 * never answers, one pointed at a bridge that is down — none of them may reach
 * the journal, delay it, or stop it writing.
 *
 * `OrderJournal.record` is the hook because it is the ONE place every gateway
 * event already passes through: a PLANNED, an ACK, a broker rejection and a
 * fill all arrive there.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { OrderJournal, type JournalCollection, type OrderEvent } from '../src/journal.ts'
import { createDeskNotifier } from '../src/notify.ts'

const EVENT: OrderEvent = {
  clientOrderId: 'X-1',
  phase: 'ACK',
  ok: true,
  tag: 'ORB_SCALP_BN',
  tradingsymbol: 'BANKNIFTY26AUG52000CE',
  ts: 1_700_000_000_000,
  brokerOrderId: '99',
}

/** A collection that only has to remember what it was given. */
function fakeCollection(docs: Record<string, unknown>[]): JournalCollection {
  return {
    insertOne: async (doc) => {
      docs.push(doc)
      return {}
    },
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    createIndex: async () => ({}),
  }
}

describe('a broken notify cannot fail the order path', () => {
  test('a THROWING notify still journals the event, and record() resolves', async () => {
    const docs: Record<string, unknown>[] = []
    const errors: unknown[] = []
    const journal = new OrderJournal({
      collection: fakeCollection(docs),
      onError: (err) => errors.push(err),
      notify: () => {
        throw new Error('desk-api notify exploded')
      },
    })

    await journal.record(EVENT)

    assert.equal(docs.length, 1, 'the event is journalled regardless')
    // And it is NOT reported as a write failure. That log line sends whoever
    // reads it to look at Mongo for a row that was written perfectly.
    assert.deepEqual(errors, [])
  })

  test('a notify that never answers does not delay the journal', async () => {
    const docs: Record<string, unknown>[] = []
    const journal = new OrderJournal({
      collection: fakeCollection(docs),
      // A notifier returns void by contract, so there is nothing here for
      // `record` to await even when the work behind it never finishes.
      notify: () => {
        void new Promise(() => {})
      },
    })

    await journal.record(EVENT)
    assert.equal(docs.length, 1)
  })

  test('the event is still pushed when the JOURNAL write fails', async () => {
    // The two failures are separate and so are their consequences: losing the
    // audit row is not a reason to also lose the operator's live view.
    const pushed: OrderEvent[] = []
    const journal = new OrderJournal({
      collection: {
        ...fakeCollection([]),
        insertOne: async () => {
          throw new Error('mongo is down')
        },
      },
      onError: () => {},
      notify: (e) => pushed.push(e),
    })

    await journal.record(EVENT)
    assert.equal(pushed.length, 1)
  })

  test('the notify sees the STAMPED event, not the raw one', async () => {
    // `ts: 0` means "stamp it for me". A dashboard shown the 0 would render
    // 1970 and sort the newest row to the bottom.
    const pushed: OrderEvent[] = []
    const journal = new OrderJournal({
      collection: fakeCollection([]),
      now: () => 4242,
      notify: (e) => pushed.push(e),
    })
    await journal.record({ ...EVENT, ts: 0 })
    assert.equal(pushed[0]?.ts, 4242)
  })
})

describe('the notifier itself', () => {
  const logs: { msg: string; ctx?: Record<string, unknown> }[] = []
  const log = (msg: string, ctx?: Record<string, unknown>): void => {
    logs.push(ctx === undefined ? { msg } : { msg, ctx })
  }

  test('it POSTs the event to desk-api as a MACHINE caller, marked live', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const notify = createDeskNotifier({
      url: 'http://127.0.0.1:8890/',
      token: 'tok',
      log,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response('{}', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })

    notify(EVENT)
    await new Promise((r) => setTimeout(r, 10))

    assert.equal(calls.length, 1)
    // The trailing slash on the base URL must not produce a double slash — the
    // API matches the path exactly and would answer 404 for the rest of time.
    assert.equal(calls[0]?.url, 'http://127.0.0.1:8890/v1/desk/stream/notify')
    const headers = calls[0]?.init.headers as Record<string, string>
    assert.equal(headers['authorization'], 'Bearer tok')
    const body = JSON.parse(String(calls[0]?.init.body)) as { mode: string; event: OrderEvent }
    // An event that names no rail is LIVE — every row this journal wrote before
    // the field existed, and the same fail-closed direction every other reader
    // of it takes.
    assert.equal(body.mode, 'live')
    assert.equal(body.event.clientOrderId, 'X-1')
  })

  /**
   * WHICH TAB THE FRAME LANDS ON, now that both rails come through here (D14).
   *
   * This was a per-process constant `'live'`, which turned a paper rehearsal's
   * every PLANNED/ACK/STATUS into a nudge in front of an operator watching real
   * money. The mode is a property of the ORDER, so it is read off the event —
   * from `mode` where a caller built the event itself (`order-chaser.ts`,
   * `broker-sweep.ts` both notify directly), and from `detail.mode` where the
   * journal folded it in before handing this its stamped copy.
   */
  test('the frame carries the RAIL the order is on, from either place it is stated', async () => {
    const sent: string[] = []
    const notify = createDeskNotifier({
      url: 'http://127.0.0.1:8890',
      token: 'tok',
      log,
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push((JSON.parse(String(init.body)) as { mode: string }).mode)
        return new Response('{}', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
    })

    notify({ ...EVENT, mode: 'paper' })
    notify({ ...EVENT, detail: { mode: 'paper', note: 'the journal folded it in' } })
    notify({ ...EVENT, mode: 'live' })
    // FAIL-CLOSED: anything that is not exactly 'paper' is live. A live nudge
    // shown on the paper tab is a live fill an operator does not see.
    notify({ ...EVENT, detail: { mode: 'PAPER' } })
    await new Promise((r) => setTimeout(r, 10))

    assert.deepEqual(sent, ['paper', 'paper', 'live', 'live'])
  })

  test('a rejected fetch is swallowed — no throw, no unhandled rejection', async () => {
    const notify = createDeskNotifier({
      url: 'http://127.0.0.1:8890',
      token: 'tok',
      log,
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof globalThis.fetch,
    })
    assert.doesNotThrow(() => notify(EVENT))
    await new Promise((r) => setTimeout(r, 10))
  })

  test('a non-2xx answer is swallowed too', async () => {
    const notify = createDeskNotifier({
      url: 'http://127.0.0.1:8890',
      token: 'tok',
      log,
      fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch,
    })
    assert.doesNotThrow(() => notify(EVENT))
    await new Promise((r) => setTimeout(r, 10))
  })

  test('a fetch that throws SYNCHRONOUSLY is swallowed', () => {
    const notify = createDeskNotifier({
      url: 'http://127.0.0.1:8890',
      token: 'tok',
      log,
      fetch: (() => {
        throw new Error('no fetch on this runtime')
      }) as unknown as typeof globalThis.fetch,
    })
    assert.doesNotThrow(() => notify(EVENT))
  })

  test('a bridge that is down is logged ONCE a minute, not once an event', async () => {
    // One failure per journal write, and a log line each, would bury the broker
    // errors that actually matter under noise about a dashboard.
    const seen: string[] = []
    let clock = 0
    const notify = createDeskNotifier({
      url: 'http://127.0.0.1:8890',
      token: 'tok',
      log: (msg) => seen.push(msg),
      now: () => clock,
      fetch: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof globalThis.fetch,
    })

    for (let i = 0; i < 5; i++) notify(EVENT)
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(seen.length, 1)

    clock = 61_000
    notify(EVENT)
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(seen.length, 2)
  })

  test('no token means a NO-OP that says so once, not a request per event', async () => {
    const calls: unknown[] = []
    const said: string[] = []
    const notify = createDeskNotifier({
      url: 'http://127.0.0.1:8890',
      token: '',
      log: (msg) => said.push(msg),
      fetch: (async () => {
        calls.push(1)
        return new Response('{}')
      }) as unknown as typeof globalThis.fetch,
    })
    notify(EVENT)
    notify(EVENT)
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(calls, [])
    assert.equal(said.length, 1)
    assert.match(said[0] ?? '', /DISABLED/)
  })
})
