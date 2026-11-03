import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, type BrokerOrder, type BrokerPosition, type OrderIntent, type WalRecord } from '../src/index.ts'

const intent = (id: string, symbol: string, side: 'BUY' | 'SELL', qty: number): OrderIntent => ({
  clientOrderId: id,
  ts: 1,
  strategyTag: 'T',
  mode: 'live',
  destinations: ['xts'],
  instrument: { tradingsymbol: symbol, lotSize: 25, tickSize: 0.05, exchange: 'NFO' },
  side,
  orderType: 'MARKET',
  quantity: qty,
  lots: qty / 25,
})

const filled = (id: string, qty: number): WalRecord => ({
  kind: 'STATUS', ts: 2, clientOrderId: id, destination: 'xts',
  status: 'FILLED', filledQty: qty, avgFillPrice: 100,
})

const pos = (tradingsymbol: string, netQty: number): BrokerPosition => ({ tradingsymbol, netQty, avgPrice: 100 })

test('a matching position produces no divergence', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
  ]
  assert.deepEqual(reconcile(recs, [pos('NIFTY_CE', 50)], []), [])
})

test('a broker position we have no record of is reported', () => {
  // The dangerous one: something is open that we are not managing.
  const d = reconcile([], [pos('BANKNIFTY_PE', 35)], [])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'UNKNOWN_BROKER_POSITION')
})

test('a position we believe in but the broker does not have is reported', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
  ]
  const d = reconcile(recs, [], [])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'MISSING_BROKER_POSITION')
})

test('a quantity mismatch is reported with both numbers', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
  ]
  const d = reconcile(recs, [pos('NIFTY_CE', 25)], [])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'QTY_MISMATCH')
  assert.match(JSON.stringify(d[0]), /50/)
  assert.match(JSON.stringify(d[0]), /25/)
})

test('SELL fills reduce the expected net quantity', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
    { kind: 'INTENT', ts: 3, intent: intent('b', 'NIFTY_CE', 'SELL', 50) },
    filled('b', 50),
  ]
  assert.deepEqual(reconcile(recs, [], []), [], 'net zero means no position expected')
})

test('a resting broker order we did not place is an ORPHAN — the rollback case', () => {
  // Exactly the cutover-rollback hazard: the legacy stack resumes with no
  // knowledge of resting SL/target orders the new stack placed.
  const orphan: BrokerOrder = {
    brokerOrderId: 'B1', clientOrderId: null,
    tradingsymbol: 'NIFTY_CE', status: 'OPEN', filledQty: 0,
  }
  const d = reconcile([], [], [orphan])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'ORPHAN_BROKER_ORDER')
})

test('an intent journalled but never resolved is reported', () => {
  const recs: WalRecord[] = [{ kind: 'INTENT', ts: 1, intent: intent('x', 'NIFTY_CE', 'BUY', 25) }]
  const kinds = reconcile(recs, [], []).map((x) => x.kind)
  assert.ok(kinds.includes('UNRESOLVED_INTENT'))
})

test('a multi-tranche fill sequence is summed ONCE per order, not once per STATUS record', () => {
  // filledQty on a STATUS record is a cumulative snapshot (mirrors
  // OrderState.filledQty), not a delta — one record per onOrderUpdate from the
  // XTS feed. A thin options book fills in tranches:
  //   WORKING -> PARTIALLY_FILLED(10) -> PARTIALLY_FILLED(20) -> FILLED(25)
  // Summing every record gives 10+20+25=55; the correct net is 25 (the last record).
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 25) },
    { kind: 'STATUS', ts: 2, clientOrderId: 'a', destination: 'xts', status: 'WORKING', filledQty: 0, avgFillPrice: null },
    { kind: 'STATUS', ts: 3, clientOrderId: 'a', destination: 'xts', status: 'PARTIALLY_FILLED', filledQty: 10, avgFillPrice: 100 },
    { kind: 'STATUS', ts: 4, clientOrderId: 'a', destination: 'xts', status: 'PARTIALLY_FILLED', filledQty: 20, avgFillPrice: 100 },
    { kind: 'STATUS', ts: 5, clientOrderId: 'a', destination: 'xts', status: 'FILLED', filledQty: 25, avgFillPrice: 100 },
  ]
  // Broker agrees the true net position is 25 — reconcile must not disagree.
  assert.deepEqual(reconcile(recs, [pos('NIFTY_CE', 25)], []), [])
})

test('a multi-tranche fill sequence out of ts order still nets to the LAST (highest-ts) record', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 25) },
    { kind: 'STATUS', ts: 5, clientOrderId: 'a', destination: 'xts', status: 'FILLED', filledQty: 25, avgFillPrice: 100 },
    { kind: 'STATUS', ts: 3, clientOrderId: 'a', destination: 'xts', status: 'PARTIALLY_FILLED', filledQty: 10, avgFillPrice: 100 },
    { kind: 'STATUS', ts: 4, clientOrderId: 'a', destination: 'xts', status: 'PARTIALLY_FILLED', filledQty: 20, avgFillPrice: 100 },
  ]
  assert.deepEqual(reconcile(recs, [pos('NIFTY_CE', 25)], []), [])
})

test('risk-rejected intents are not treated as unresolved', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('x', 'NIFTY_CE', 'BUY', 25) },
    { kind: 'REJECTED_BY_RISK', ts: 2, intent: intent('x', 'NIFTY_CE', 'BUY', 25), code: 'KILL_SWITCH' },
  ]
  assert.deepEqual(reconcile(recs, [], []), [])
})
