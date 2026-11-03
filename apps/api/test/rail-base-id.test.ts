/**
 * THE TRANCHE SUFFIX IS THE LAST `.N`, NOT THE FIRST DOT.
 *
 * `withOrderContext` joins a journal event back to its desk order document
 * by the BASE id — the gateway suffixes split tranches `.1`, `.2`, and the
 * document is keyed by the id without that suffix. The gateway's own rule
 * (`gateway.ts baseClientOrderId`) strips only a trailing numeric `.N`;
 * `rail.ts` carried a copy that cut at the FIRST dot, which is fine for
 * `ORB-123.2` and wrong for every id that has a dot of its own: a hosted
 * strategy's `atr.v2-171#3` became `atr`, no document has that id, and the
 * join found nothing — the side, limit and quantity columns went blank for
 * exactly those orders. Two copies of one wire rule had drifted (F9).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { withOrderContext } from '../src/rail.ts'
import { COLLECTIONS, type Database } from '../src/store.ts'

/** The one query `withOrderContext` makes: `{ clientOrderId: { $in } }` on the gateway orders. */
function dbWith(docs: Record<string, unknown>[]): Database {
  return {
    collection: (name: string) => ({
      find: (filter: Record<string, unknown>) => ({
        toArray: async () => {
          assert.equal(name, COLLECTIONS.gatewayOrders)
          const want = (filter['clientOrderId'] as { $in: string[] }).$in
          return docs.filter((d) => want.includes(String(d['clientOrderId'])))
        },
      }),
    }),
  } as unknown as Database
}

test('a tranche of a dotted base id is stamped from ITS document, and a sibling order is not', async () => {
  const db = dbWith([
    { clientOrderId: 'atr.v2-171#3', transaction_type: 'SELL', limitPrice: 12.5, quantity: 75 },
    { clientOrderId: 'atr.v2-172#1', transaction_type: 'BUY' },
  ])
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'atr.v2-171#3.2', phase: 'STATUS', ts: 1 },
    { clientOrderId: 'atr.v2-172#1', phase: 'STATUS', ts: 1 },
    { clientOrderId: 'atr.v2-173#9', phase: 'STATUS', ts: 1 },
  ])
  assert.equal(out[0]?.['side'], 'SELL')
  assert.equal(out[0]?.['limitPrice'], 12.5)
  assert.equal(out[0]?.['orderQty'], 75)
  assert.equal(out[1]?.['side'], 'BUY', 'the sibling keeps its own document')
  assert.equal(out[2]?.['side'], undefined, 'no document, no side — never a neighbour\'s')
})

test('the plain split id still joins as it always did', async () => {
  const db = dbWith([{ clientOrderId: 'ORB-123', transaction_type: 'BUY' }])
  const out = await withOrderContext<Record<string, unknown>>(db, [
    { clientOrderId: 'ORB-123.2', phase: 'STATUS', ts: 1 },
    { clientOrderId: 'ORB-123', phase: 'PLANNED', ts: 1 },
  ])
  assert.deepEqual(out.map((e) => e['side']), ['BUY', 'BUY'])
})
