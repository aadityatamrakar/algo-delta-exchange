import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, DWELL, harness, orderDoc, type Harness } from './chaser-harness.ts'
import { createAlertSink, type Alert } from '../src/alert-sink.ts'
import type { CloseBook } from '../src/dx-close.ts'
import type { CloseWorker } from '../src/order-chaser.ts'

/**
 * A DELTA CLOSE IS NEVER HANDED BACK. After the normal chase (the blind
 * ladder's rungs, or the peg's one cross) the chaser keeps repricing — each
 * step 5 % further beyond the touch, capped at 3x the touch and the band —
 * until the order fills or the position is gone, with a critical alert the
 * first time and every 10 min while it stays unfilled.
 */

const STEP_MS = 3_000

function worker(o: { book?: CloseBook | null; alerts?: Alert[]; sinkNow?: () => number; inserts?: Record<string, unknown>[] } = {}): CloseWorker & { reads: number } {
  const w = {
    reads: 0,
    async book(): Promise<CloseBook | null> {
      w.reads++
      return o.book === undefined ? { bid: 95, ask: 100, lower: null, upper: null, source: 'rest' as const } : o.book
    },
    alerts:
      o.inserts !== undefined && o.sinkNow !== undefined
        ? createAlertSink({ collection: { insertOne: async (d) => void o.inserts?.push(d) }, now: o.sinkNow, log: () => {} })
        : { raise: (a: Alert) => void o.alerts?.push(a) },
    stepPct: 0.05,
    maxMult: 3,
    stepMs: STEP_MS,
  }
  return w
}

/** A buy-back whose blind ladder is spent and whose last rung has had its dwell. */
const spentClose = (over: Record<string, unknown> = {}) =>
  orderDoc({
    transaction_type: 'BUY',
    desk_op: 'close',
    mode: 'live',
    tickSize: 0.1,
    limitPrice: 102,
    chaseAttempts: 3,
    chasedAt: NOW - DWELL - 1,
    lastChasePrice: 111.2,
    ...over,
  })

const doc = (h: Harness) => h.orders.docs[0] as Record<string, unknown>

test('a spent blind ladder on a CLOSE escalates instead of exhausting: +5% beyond the ask, one loud line, a critical alert', async () => {
  const alerts: Alert[] = []
  const h = harness({ docs: [spentClose()], closes: worker({ alerts }) })
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 105 }])
  assert.equal(doc(h)['chaseExhaustedAt'], undefined, 'never handed back')
  assert.equal(doc(h)['closeEscalatedAt'], NOW)
  assert.equal(doc(h)['closeSteps'], 1)
  assert.equal(doc(h)['lastChasePrice'], 105)
  const loud = h.events.filter((e) => e.ok === false)
  assert.equal(loud.length, 1)
  assert.match(String(loud[0]?.error), /close still unfilled after the normal chase — escalating beyond the touch until filled/)
  assert.equal(h.notified.length, 1)
  assert.equal(alerts.length, 1)
  assert.deepEqual(
    { severity: alerts[0]?.severity, mode: alerts[0]?.mode, key: alerts[0]?.key },
    { severity: 'critical', mode: 'live', key: 'close-unfilled:ord-1' },
  )
})

test('it keeps stepping every few seconds — not inside the step dwell — further beyond the touch each time', async () => {
  const h = harness({ docs: [spentClose()], closes: worker() })
  await h.run()
  h.clock.now += STEP_MS - 1
  await h.run()
  assert.equal(h.modifies.length, 1, 'inside the step dwell nothing moves')
  h.clock.now += 2
  await h.run()
  h.clock.now += STEP_MS + 1
  await h.run()
  assert.deepEqual(h.modifies.map((m) => m.price), [105, 110, 115])
  assert.equal(h.events.filter((e) => e.ok === false).length, 1, 'the loud line is said once')
})

test('the critical alert repeats every 10 min while unfilled — not every pass', async () => {
  const inserts: Record<string, unknown>[] = []
  let h: Harness | null = null
  const w = worker({ inserts, sinkNow: () => h?.clock.now ?? NOW })
  h = harness({ docs: [spentClose()], closes: w })
  await h.run()
  for (let i = 0; i < 100; i++) {
    h.clock.now += 5_000
    await h.run()
  }
  await new Promise((r) => setImmediate(r))
  // 500 s of passes: one row.
  assert.equal(inserts.length, 1)
  for (let i = 0; i < 25; i++) {
    h.clock.now += 5_000
    await h.run()
  }
  await new Promise((r) => setImmediate(r))
  assert.equal(inserts.length, 2)
  assert.equal(inserts[0]?.['severity'], 'critical')
  assert.equal(inserts[0]?.['source'], 'gateway')
})

test('capped at 3x the touch: once there, nothing more is sent (no modify per pass at the same price)', async () => {
  const h = harness({ docs: [spentClose({ closeEscalatedAt: NOW - 60_000, closeSteps: 50, lastChasePrice: 300, chasedAt: NOW - STEP_MS - 1 })], closes: worker() })
  await h.run()
  assert.deepEqual(h.modifies, [])
  // The band caps it lower when Delta states one.
  const b = harness({
    docs: [spentClose({ closeEscalatedAt: NOW - 60_000, closeSteps: 50, chasedAt: NOW - STEP_MS - 1 })],
    closes: worker({ book: { bid: 95, ask: 100, lower: 0.1, upper: 180, source: 'rest' } }),
  })
  await b.run()
  assert.deepEqual(b.modifies.map((m) => m.price), [180])
})

test('stops the moment the order is done — filled, or cancelled by Delta when the position is gone', async () => {
  for (const status of ['FILLED', 'CANCELLED']) {
    const h = harness({
      docs: [spentClose({ closeEscalatedAt: NOW - 60_000, closeSteps: 4, chasedAt: NOW - STEP_MS - 1 })],
      fillRows: [{ brokerOrderId: '987', status, ts: NOW - 1_000 }],
      closes: worker(),
    })
    await h.run()
    assert.deepEqual(h.modifies, [], status)
  }
})

test('a refused modify does not advance the step; the next pass retries it', async () => {
  let accept = false
  const h = harness({ docs: [spentClose()], closes: worker(), modifyResult: () => accept })
  await h.run()
  assert.equal(doc(h)['closeSteps'], 0)
  accept = true
  h.clock.now += STEP_MS + 1
  await h.run()
  assert.deepEqual(h.modifies.map((m) => m.price), [105, 105])
  assert.equal(doc(h)['closeSteps'], 1)
})

test('with no book at all it still steps — blind, off the last accepted price — never MARKET, never idle', async () => {
  const h = harness({ docs: [spentClose()], closes: worker({ book: null }) })
  await h.run()
  // 111.2 x 1.05 = 116.76 → 116.8
  assert.deepEqual(h.modifies.map((m) => m.price), [116.8])
})

test('a SELL close steps under the bid', async () => {
  const h = harness({ docs: [spentClose({ transaction_type: 'SELL', limitPrice: 93, lastChasePrice: 85 })], closes: worker() })
  await h.run()
  assert.deepEqual(h.modifies.map((m) => m.price), [90.2])
})

test('an OPEN with the worker wired still exhausts as before; a close with no worker too', async () => {
  const open = harness({ docs: [spentClose({ desk_op: 'open' })], closes: worker() })
  await open.run()
  assert.equal(doc(open)['chaseExhaustedAt'], NOW)
  assert.deepEqual(open.modifies, [])
  const bare = harness({ docs: [spentClose()] })
  await bare.run()
  assert.equal(doc(bare)['chaseExhaustedAt'], NOW)
})

test('a PASSIVE close: after its one cross has had its dwell, it escalates instead of exhausting', async () => {
  const h = harness({
    docs: [spentClose({ workMode: 'passive', chaseAttempts: 1, pegCrossedAt: NOW - DWELL - 1, chasedAt: NOW - DWELL - 1, instrument_token: 7 })],
    closes: worker(),
  })
  await h.run()
  assert.equal(doc(h)['chaseExhaustedAt'], undefined)
  assert.deepEqual(h.modifies.map((m) => m.price), [105])
})

test('a PASSIVE close past its deadline with a stale WS touch escalates off the REST book instead of pausing', async () => {
  const w = worker()
  const h = harness({
    docs: [spentClose({ workMode: 'passive', chaseAttempts: 0, chasedAt: undefined, lastChasePrice: undefined, placedAt: NOW - 60_000, chaseMaxMs: 30_000, instrument_token: 7 })],
    closes: w,
  })
  await h.run()
  assert.ok(w.reads >= 1)
  assert.deepEqual(h.modifies.map((m) => m.price), [105])
  assert.equal(doc(h)['closeEscalatedAt'], NOW)
})

test('a cancel pending on the order still wins over the escalation', async () => {
  const h = harness({
    docs: [spentClose({ closeEscalatedAt: NOW - 60_000, closeSteps: 2, chasedAt: NOW - STEP_MS - 1 })],
    cancels: [{ _id: '987', status: 'pending' }],
    closes: worker(),
  })
  await h.run()
  assert.deepEqual(h.modifies, [])
})
