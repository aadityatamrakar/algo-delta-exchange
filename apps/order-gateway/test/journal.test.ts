import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OrderJournal,
  describe as describeEvent,
  orderMode,
  safeRaw,
  type JournalCollection,
  type OrderEvent,
} from '../src/journal.ts'

class FakeJournalCollection implements JournalCollection {
  docs: Record<string, unknown>[] = []
  failNext = false

  async insertOne(doc: Record<string, unknown>): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('mongo is down')
    }
    this.docs.push(doc)
  }

  find(filter: Record<string, unknown>) {
    const match = this.docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v))
    return {
      sort: (spec: Record<string, 1 | -1>) => {
        const key = Object.keys(spec)[0] ?? 'ts'
        const dir = spec[key] ?? 1
        const sorted = [...match].sort((a, b) => (Number(a[key] ?? 0) - Number(b[key] ?? 0)) * dir)
        return { limit: (n: number) => ({ toArray: async () => sorted.slice(0, n) }) }
      },
    }
  }

  async createIndex(): Promise<void> {}
}

const ev = (over: Partial<OrderEvent> = {}): OrderEvent => ({
  clientOrderId: 'ord-1',
  phase: 'SUBMITTED',
  ok: true,
  tag: 'DESK_BHEL',
  tradingsymbol: 'BHEL26AUG420CE',
  ts: 1000,
  ...over,
})

test('a successful submission is recorded with its broker id', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({ phase: 'ACK', brokerOrderId: '987654' }))
  assert.equal(c.docs.length, 1)
  assert.equal(c.docs[0]?.['phase'], 'ACK')
  assert.equal(c.docs[0]?.['ok'], true)
  assert.equal(c.docs[0]?.['brokerOrderId'], '987654')
})

test('a FAILURE keeps the message AND its classification', async () => {
  // "the OMS hiccuped and retried" and "the account is out of margin" look
  // identical in a raw log and demand completely different responses.
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({
    phase: 'FAILED', ok: false,
    error: '400 - {"code":"e-session-0005"}', errorClass: 'session', attempt: 2,
  }))
  const d = c.docs[0]!
  assert.equal(d['ok'], false)
  assert.equal(d['errorClass'], 'session')
  assert.equal(d['attempt'], 2)
  assert.match(String(d['error']), /e-session-0005/)
})

test('the journal NEVER throws — a failed write must not kill the order path', async () => {
  // Losing the record of a placement is bad; failing the placement because the
  // record could not be written is worse.
  const c = new FakeJournalCollection()
  const errors: unknown[] = []
  const j = new OrderJournal({ collection: c, onError: (e) => errors.push(e) })
  c.failNext = true
  await j.record(ev()) // must not reject
  assert.equal(errors.length, 1)
  assert.equal(c.docs.length, 0)

  await j.record(ev({ clientOrderId: 'ord-2' }))
  assert.equal(c.docs.length, 1, 'and it recovers on the next write')
})

test('history returns one order\'s full sequence, oldest first', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({ phase: 'ACCEPTED', ts: 1 }))
  await j.record(ev({ phase: 'PLANNED', ts: 2 }))
  await j.record(ev({ phase: 'SUBMITTED', ts: 3 }))
  await j.record(ev({ phase: 'ACK', ts: 4, brokerOrderId: '9' }))
  await j.record(ev({ clientOrderId: 'other', ts: 5 }))

  const h = await j.history('ord-1')
  assert.deepEqual(h.map((r) => r['phase']), ['ACCEPTED', 'PLANNED', 'SUBMITTED', 'ACK'])
})

test('failures lists only what a human should look at, newest first', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({ ts: 1 }))
  await j.record(ev({ clientOrderId: 'a', phase: 'FAILED', ok: false, error: 'margin', ts: 2 }))
  await j.record(ev({ clientOrderId: 'b', phase: 'FAILED', ok: false, error: 'freeze', ts: 3 }))

  const f = await j.failures()
  assert.equal(f.length, 2)
  assert.equal(f[0]?.['clientOrderId'], 'b', 'newest first')
})

test('a huge raw payload is truncated rather than filling the disk', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({ raw: 'x'.repeat(50_000) }))
  const raw = String(c.docs[0]?.['raw']);
  assert.ok(raw.length < 5000, `expected truncation, got ${raw.length}`)
  assert.match(raw, /more]$/)
})

test('a ts of 0 is stamped with the current time', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c, now: () => 555 })
  await j.record(ev({ ts: 0 }))
  assert.equal(c.docs[0]?.['ts'], 555)
})

test('safeRaw survives a circular payload instead of throwing in the error path', async () => {
  const circular: Record<string, unknown> = { a: 1 }
  circular['self'] = circular
  const out = safeRaw(circular)
  assert.equal(typeof out, 'string')
  assert.equal(safeRaw('already a string'), 'already a string')
  assert.equal(safeRaw({ ok: true }), '{"ok":true}')
})

test('describe renders both outcomes in one line', () => {
  assert.match(
    describeEvent(ev({ phase: 'ACK', brokerOrderId: '987', status: 'FILLED', filledQty: 13125, avgPrice: 14.85 })),
    /ACK BHEL26AUG420CE \[ord-1\] broker=987 status=FILLED filled=13125 @14.85/,
  )
  assert.match(
    describeEvent(ev({ phase: 'FAILED', ok: false, error: 'RMS: margin', errorClass: 'fatal' })),
    /FAILED \(fatal\): RMS: margin/,
  )
})

test('partial fills are journalled as their own STATUS events', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({ phase: 'STATUS', status: 'PARTIALLY_FILLED', filledQty: 5250, ts: 1 }))
  await j.record(ev({ phase: 'STATUS', status: 'FILLED', filledQty: 13125, ts: 2 }))
  const h = await j.history('ord-1')
  assert.deepEqual(h.map((r) => r['filledQty']), [5250, 13125])
})

// ----------------------------------------------------------- which rail (D9)

/**
 * The Orders page is scoped by mode and its filter is "paper iff the row says
 * so" (`service.ts:orderEvents`, `PnlStore.orderEvents`). Every row this
 * journal wrote for an engine PAPER order used to say nothing, which those
 * filters read as LIVE — so a rehearsal's routing rendered on the live tab and
 * was missing from the paper one.
 */
test('a stated mode is folded into detail.mode, which is where the readers look', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({ mode: 'paper' }))
  const d = c.docs[0]!
  assert.deepEqual(d['detail'], { mode: 'paper' })
  // NOT at the top level: a row spelled `mode` there would scope as LIVE while
  // looking stamped, which is the failure this exists to end.
  assert.equal(d['mode'], undefined)
})

test('the mode joins an existing detail rather than replacing it', async () => {
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev({ phase: 'PLANNED', mode: 'live', detail: { tranches: [3, 3], orders: 2 } }))
  assert.deepEqual(c.docs[0]?.['detail'], { tranches: [3, 3], orders: 2, mode: 'live' })
})

test('no mode stated writes no detail.mode — absent stays absent, and reads as live', async () => {
  // Every row written before the stamp existed is unstamped and live, and the
  // readers' `$ne 'paper'` already answers for them. Defaulting here would
  // invent a claim the caller never made.
  const c = new FakeJournalCollection()
  const j = new OrderJournal({ collection: c })
  await j.record(ev())
  assert.equal(c.docs[0]?.['detail'], undefined)
  await j.record(ev({ detail: { note: 'no rail named' } }))
  assert.deepEqual(c.docs[1]?.['detail'], { note: 'no rail named' })
})

test('orderMode reads the document and FAILS CLOSED to live', async () => {
  assert.equal(orderMode({ mode: 'paper' }), 'paper')
  assert.equal(orderMode({}), 'live', 'every live order ever written has no mode')
  for (const bad of ['PAPER', 'Paper', 1, true, null, {}] as unknown[]) {
    assert.equal(orderMode({ mode: bad }), 'live', `mode=${String(bad)} is not paper`)
  }
})
