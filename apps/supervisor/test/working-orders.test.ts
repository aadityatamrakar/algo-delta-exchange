/**
 * The cancel sweep's answer, from the side the host decides on.
 *
 * `unplaced` is the 2026-10-01 field: a sweep one second after routing found
 * all seven orders of a flatten still PENDING at the gateway (no broker id) and
 * answered `{requested: 0, failed: 0}` — which the host read as "nothing was
 * working" and latched. Those orders were placed five seconds later and one
 * rested until its contract expired.
 *
 * `asked` / `skip` are the other half: the host no longer latches a decision at
 * all. It sweeps every pass and files a cancel only for a broker id it has not
 * asked about recently, because a CLOSE whose tranche is cancelled is ADVANCED
 * by the gateway (`gateway.ts:decideTrancheStep` rule 3) — re-queued PENDING
 * still carrying the finished tranche's broker id, then placed again under a
 * NEW id that can rest.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { workingOrderCanceller, type OrdersCollection } from '../src/working-orders.ts'
import type { HostLog } from '../src/engine-host.ts'

const TAG = 'SENSEX-delta-lean-aggressive-2026-10-01'
const DECISION = `${TAG}:paper:5`

const quiet: HostLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function ordersOf(docs: Record<string, unknown>[]): OrdersCollection {
  return { find: () => ({ toArray: async () => docs }) }
}

function sweeper(docs: Record<string, unknown>[], cancelled: string[], fail = new Set<string>()) {
  return workingOrderCanceller(
    {
      collection: ordersOf(docs),
      cancel: async (id) => {
        if (fail.has(id)) throw new Error('desk-api is down')
        cancelled.push(id)
      },
      log: quiet,
    },
    TAG,
    'paper',
  )
}

test('an order the gateway has not placed yet is COUNTED as unplaced, not silently skipped', async () => {
  const cancelled: string[] = []
  const sweep = sweeper(
    [
      { clientOrderId: `${DECISION}#0`, state: 'PENDING' },
      { clientOrderId: `${DECISION}#1`, state: 'CLAIMED', brokerOrderIds: [] },
      { clientOrderId: `${DECISION}#4`, state: 'PLACED', brokerOrderIds: ['sim-a-1', 'sim-a-2'] },
      // Another decision's order on the same tag is not this sweep's.
      { clientOrderId: `${TAG}:paper:4#0`, state: 'PENDING' },
    ],
    cancelled,
  )
  assert.deepEqual(await sweep(DECISION), { requested: 1, failed: 0, unplaced: 2, asked: ['sim-a-2'] })
  assert.deepEqual(cancelled, ['sim-a-2'], 'only the newest tranche id of the placed order')
})

test('a close BETWEEN TRANCHES is unplaced — its broker id is the finished tranche, not a working one', async () => {
  // `advanceTranche` re-queues the order PENDING and leaves `brokerOrderIds`
  // as it was. Cancelling that id files against a TERMINAL order ("PAPER CANCEL
  // FAILED") while the next tranche is about to go out and rest.
  const cancelled: string[] = []
  const sweep = sweeper(
    [{ clientOrderId: `${DECISION}#4`, state: 'PENDING', trancheCursor: 1, brokerOrderIds: ['sim-a-1'] }],
    cancelled,
  )
  assert.deepEqual(await sweep(DECISION), { requested: 0, failed: 0, unplaced: 1, asked: [] })
  assert.deepEqual(cancelled, [])
})

test('a broker id the host has already asked about is not filed again', async () => {
  const cancelled: string[] = []
  const docs = [
    { clientOrderId: `${DECISION}#4`, state: 'PLACED', brokerOrderIds: ['sim-a-1', 'sim-a-2'] },
    { clientOrderId: `${DECISION}#6`, state: 'PLACED', brokerOrderIds: ['sim-b-1'] },
  ]
  const sweep = sweeper(docs, cancelled)
  assert.deepEqual(await sweep(DECISION, new Set(['sim-a-2'])), {
    requested: 1,
    failed: 0,
    unplaced: 0,
    asked: ['sim-b-1'],
  })
  assert.deepEqual(cancelled, ['sim-b-1'])
})

test('a failed request is counted and NOT reported as asked, so the next pass files it again', async () => {
  const cancelled: string[] = []
  const sweep = sweeper(
    [
      { clientOrderId: `${DECISION}#4`, state: 'PLACED', brokerOrderIds: ['sim-a-2'] },
      { clientOrderId: `${DECISION}#6`, state: 'PLACED', brokerOrderIds: ['sim-b-1'] },
    ],
    cancelled,
    new Set(['sim-b-1']),
  )
  assert.deepEqual(await sweep(DECISION), { requested: 1, failed: 1, unplaced: 0, asked: ['sim-a-2'] })
})
