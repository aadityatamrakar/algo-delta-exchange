import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FreezeLimits } from '@algomaker/instruments'
import type { PlacedOrder } from '@algomaker/brokers'
import {
  planOrder,
  deriveUnderlying,
  baseClientOrderId,
  decideOrderOutcome,
  isMeaningfulUpdate,
  isTerminalStatus,
  aggregateTranches,
  toFillRecord,
  type FillRecord,
  type GatewayOrderDoc,
  type ResolvedContract,
} from '../src/gateway.ts'

// Real BHEL numbers: lot 2625, freeze 52500 -> 20 lots per order.
const BHEL: ResolvedContract = {
  tradingsymbol: 'BHEL26AUG420CE',
  instrumentToken: 19664898,
  lotSize: 2625,
  tickSize: 0.05,
  exchange: 'NFO',
}
const freeze = new FreezeLimits([
  { symbol: 'BHEL', freezeQty: 52500 },
  { symbol: 'NIFTY', freezeQty: 1800 },
  // Real values, and the two the old regex could never look up.
  { symbol: 'NIFTYNXT50', freezeQty: 4200 },
  { symbol: '3MINDIA', freezeQty: 168 },
])

const doc = (over: Partial<GatewayOrderDoc> = {}): GatewayOrderDoc => ({
  tradingsymbol: 'BHEL26AUG420CE',
  transaction_type: 'SELL',
  quantity: 13125, // 5 lots
  tag: 'DESK_BHEL',
  underlying: 'BHEL',
  ...over,
})

const plan = (over: Partial<GatewayOrderDoc> = {}, contract: ResolvedContract | null = BHEL) =>
  planOrder({ doc: doc(over), contract, freeze, clientOrderId: 'ord-1' })

test('a normal order becomes one intent', () => {
  const p = plan()
  assert.equal(p.rejected, null)
  assert.equal(p.intents.length, 1)
  assert.equal(p.intents[0]?.quantity, 13125)
  assert.equal(p.intents[0]?.lots, 5)
  assert.equal(p.intents[0]?.clientOrderId, 'ord-1', 'unsplit orders keep the plain id')
  assert.equal(p.intents[0]?.mode, 'live')
})

test('an order OVER the freeze limit is split into tranches', () => {
  // 25 lots vs BHEL's 20-lot limit. Unsplit, the exchange rejects it outright.
  const p = plan({ quantity: 25 * 2625 })
  assert.deepEqual(p.tranches, [20, 5])
  assert.equal(p.intents.length, 2)
  assert.equal(p.intents.reduce((s, i) => s + i.quantity, 0), 25 * 2625, 'tranches must sum exactly')
})

test('each tranche gets a DISTINCT correlation id', () => {
  // Sharing one id would attribute tranche 2's fill to tranche 1.
  const p = plan({ quantity: 50 * 2625 })
  const ids = p.intents.map((i) => i.clientOrderId)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(ids, ['ord-1.1', 'ord-1.2', 'ord-1.3'])
})

test('an order exactly AT the limit is not split', () => {
  const p = plan({ quantity: 20 * 2625 })
  assert.deepEqual(p.tranches, [20])
  assert.equal(p.intents.length, 1)
})

test('an unresolvable contract is REJECTED, not sent blind', () => {
  const p = plan({}, null)
  assert.equal(p.intents.length, 0)
  assert.match(p.rejected ?? '', /cannot resolve/)
})

test('a quantity that is not whole lots is rejected rather than rounded', () => {
  // Rounding would size the position differently from the desk's intent.
  const p = plan({ quantity: 13000 })
  assert.equal(p.intents.length, 0)
  assert.match(p.rejected ?? '', /not a multiple of lot size 2625/)
})

test('a zero or negative quantity is rejected', () => {
  assert.match(plan({ quantity: 0 }).rejected ?? '', /bad quantity/)
  assert.match(plan({ quantity: -2625 }).rejected ?? '', /bad quantity/)
})

test('an UNKNOWN underlying sends one order but says so LOUDLY', () => {
  // The live defect in xtsOrder.js:104 is the opposite: an unknown limit makes
  // `qty <= undefined` false and drops into tranches(qty, undefined). Sending it
  // as one order is still what happens — the exchange rejects it — so the
  // caller has to be TOLD, or the rejection is unexplainable.
  const p = planOrder({
    doc: doc({ underlying: 'NOTLISTED', quantity: 100 * 2625 }),
    contract: BHEL,
    freeze,
    clientOrderId: 'x',
  })
  assert.equal(p.intents.length, 1)
  assert.equal(p.intents[0]?.lots, 100)
  assert.equal(p.freezeUnknown, true, 'an unsplit 100-lot order must not go out silently')
  assert.equal(p.underlying, 'NOTLISTED')
})

test('a known underlying does NOT raise the freeze alarm', () => {
  assert.equal(plan().freezeUnknown, false)
})

test('LIMIT orders carry their price; MARKET orders carry none', () => {
  const lim = plan({ order_type: 'LIMIT', limitPrice: 12.45 })
  assert.equal(lim.intents[0]?.orderType, 'LIMIT')
  assert.equal(lim.intents[0]?.limitPrice, 12.45)

  const mkt = plan({ order_type: 'MARKET' })
  assert.equal(mkt.intents[0]?.orderType, 'MARKET')
  assert.equal(mkt.intents[0]?.limitPrice, undefined)
})

test('deriveUnderlying strips the EXPIRY, not everything after the first digit', () => {
  assert.equal(deriveUnderlying('BHEL26AUG420CE'), 'BHEL')
  assert.equal(deriveUnderlying('NIFTY26AUG25000CE'), 'NIFTY')
  assert.equal(deriveUnderlying('BHEL26AUGFUT'), 'BHEL')
  assert.equal(deriveUnderlying('NIFTY2580725000CE'), 'NIFTY', 'weekly index form')
  // The two the leading-non-digit-run rule (`/^\D+/`) got wrong. Both produced a
  // key that misses the freeze table, and a freeze miss means the order goes out
  // UNSPLIT and the exchange rejects it outright.
  assert.equal(
    deriveUnderlying('NIFTYNXT5026AUG30000CE'),
    'NIFTYNXT50',
    'the old rule stopped at the first digit and returned NIFTYNXT',
  )
  assert.equal(
    deriveUnderlying('3MINDIA26AUG28000CE'),
    '3MINDIA',
    'the old rule found no leading letter run and returned the whole symbol',
  )
})

test('a derived key that is now RIGHT finds the freeze limit and splits', () => {
  // End to end, with the real numbers from the review: 3MINDIA freeze 168,
  // lot 1 -> 168 lots per order. Under the old regex the key was the whole
  // symbol, the lookup returned null, and 500 lots went out as ONE order.
  const MINDIA: ResolvedContract = {
    tradingsymbol: '3MINDIA26AUG28000CE',
    instrumentToken: 1, lotSize: 1, tickSize: 0.05, exchange: 'NFO',
  }
  const p = planOrder({
    doc: { tradingsymbol: '3MINDIA26AUG28000CE', transaction_type: 'BUY', quantity: 500, tag: 'T' },
    contract: MINDIA, freeze, clientOrderId: 'x',
  })
  assert.equal(p.underlyingSource, 'derived')
  assert.equal(p.underlying, '3MINDIA')
  assert.equal(p.freezeUnknown, false)
  assert.deepEqual(p.tranches, [168, 168, 164])
})

test('the INSTRUMENT MASTER wins over both the order and the regex', () => {
  // A weekly NIFTYNXT50 symbol is genuinely ambiguous to any regex — an
  // underlying may end in digits and so may an expiry. Only the dump knows.
  const p = planOrder({
    doc: { tradingsymbol: 'NIFTYNXT502580725000CE', transaction_type: 'BUY', quantity: 500, tag: 'T' },
    contract: {
      tradingsymbol: 'NIFTYNXT502580725000CE', instrumentToken: 1, lotSize: 25,
      tickSize: 0.05, exchange: 'NFO', underlying: 'NIFTYNXT50',
    },
    freeze, clientOrderId: 'x',
  })
  assert.equal(p.underlying, 'NIFTYNXT50')
  assert.equal(p.underlyingSource, 'master')
  assert.equal(p.freezeUnknown, false)
  assert.equal(deriveUnderlying('NIFTYNXT502580725000CE'), 'NIFTYNXT', 'the regex alone gets this WRONG')
})

test('the order supplies the key when the master has no row for the contract', () => {
  const p = planOrder({
    doc: doc({ underlying: 'BHEL', tradingsymbol: 'WEIRD1SYM' }),
    contract: BHEL, freeze, clientOrderId: 'x',
  })
  assert.equal(p.rejected, null)
  assert.equal(p.underlying, 'BHEL')
  assert.equal(p.underlyingSource, 'order')
})

test("the mirror path's explicit null underlying falls through, it does not become 'null'", () => {
  // apps/runner sets `underlying: null` deliberately. `?? ` does not catch it —
  // null is not undefined — so it would have been used as the freeze key.
  const p = planOrder({
    doc: { ...doc(), underlying: null } as unknown as GatewayOrderDoc,
    contract: BHEL, freeze, clientOrderId: 'x',
  })
  assert.equal(p.underlying, 'BHEL')
  assert.equal(p.underlyingSource, 'derived')
})

// -------------------------------------------------------------- fill watcher

test('PARTIAL fills count as meaningful updates', () => {
  // smp_order_listener.js persists only FILLED/REJECTED, so a partially filled
  // wing on a thin chain looks like nothing happened — possibly forever.
  assert.equal(isMeaningfulUpdate(undefined, { status: 'WORKING', filledQty: 0 }), true)
  assert.equal(
    isMeaningfulUpdate({ status: 'WORKING', filledQty: 0 }, { status: 'PARTIALLY_FILLED', filledQty: 5250 }),
    true,
  )
  assert.equal(
    isMeaningfulUpdate({ status: 'PARTIALLY_FILLED', filledQty: 5250 }, { status: 'PARTIALLY_FILLED', filledQty: 7875 }),
    true,
    'more of the order filled — that is news',
  )
})

test('a duplicate update is not re-persisted', () => {
  const same = { status: 'WORKING', filledQty: 0 }
  assert.equal(isMeaningfulUpdate(same, { ...same }), false)
})

test('terminal statuses are recognised', () => {
  for (const s of ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']) {
    assert.equal(isTerminalStatus(s), true, s)
  }
  for (const s of ['WORKING', 'PARTIALLY_FILLED', 'PENDING_NEW']) {
    assert.equal(isTerminalStatus(s), false, s)
  }
})

test('the fill record keeps the BROKER average, never a computed one', () => {
  const rec = toFillRecord(
    { brokerOrderId: '987', clientOrderId: 'ord-1', status: 'FILLED', filledQty: 13125, avgPrice: 14.85 },
    'BHEL26AUG420CE',
    1000,
    { tag: 'DESK_BHEL', mode: 'live' },
  )
  assert.equal(rec.avgPrice, 14.85)
  assert.equal(rec.filledQty, 13125)
  assert.equal(rec.status, 'FILLED')
  assert.equal(rec.tradingsymbol, 'BHEL26AUG420CE', 'the CONTRACT, never the correlation id')
})

test('the fill record carries the base id, so tranches can be joined back', () => {
  const rec = toFillRecord(
    { brokerOrderId: '1', clientOrderId: 'ord-1.2', status: 'FILLED', filledQty: 450, avgPrice: 130 },
    'NIFTY26AUG25000CE',
    1,
    { tag: 'DESK_NIFTY', mode: 'live' },
  )
  assert.equal(rec.baseClientOrderId, 'ord-1')
})

test('a fill record carries the tag of the order that produced it', () => {
  const record = toFillRecord(
    {
      clientOrderId: 'dec-1#0',
      brokerOrderId: 'B1',
      status: 'FILLED',
      filledQty: 2625,
      avgPrice: 15.4,
    } as PlacedOrder,
    'BHEL26AUG420CE',
    1_700_000_000_000,
    { tag: 'BHEL-2026-08-25-hold-recycle-r', mode: 'live' },
  )
  assert.equal(record.tag, 'BHEL-2026-08-25-hold-recycle-r')
  assert.equal(record.mode, 'live')
})

test('baseClientOrderId strips only the tranche suffix', () => {
  assert.equal(baseClientOrderId('ord-1.2'), 'ord-1')
  assert.equal(baseClientOrderId('ord-1'), 'ord-1')
  // The submit API's own split uses '#', which is part of the desk order's id
  // and must survive: 'sub-9#0' IS the order, not a tranche of 'sub-9'.
  assert.equal(baseClientOrderId('sub-9#0'), 'sub-9#0')
  assert.equal(baseClientOrderId('sub-9#0.1'), 'sub-9#0')
})

// ------------------------------------------------------- tranche aggregation

const fill = (over: Partial<FillRecord> & { clientOrderId: string }): FillRecord => ({
  baseClientOrderId: baseClientOrderId(over.clientOrderId),
  brokerOrderId: '1',
  tradingsymbol: 'NIFTY26AUG25000CE',
  status: 'FILLED',
  filledQty: 0,
  avgPrice: null,
  ts: 1,
  tag: 'DESK_NIFTY',
  mode: 'live',
  ...over,
})

test('completion aggregates ACROSS tranches, not per order', () => {
  // One desk order became 3 broker orders; the first filling does not mean the
  // position is on.
  const fills = [
    fill({ clientOrderId: 'o.1', filledQty: 52500, avgPrice: 10 }),
    fill({ clientOrderId: 'o.2', filledQty: 52500, avgPrice: 10 }),
  ]
  const partial = aggregateTranches(fills, 131250, { ids: ['o.1', 'o.2', 'o.3'] })
  assert.equal(partial.filledQty, 105000)
  assert.equal(partial.complete, false, '2 of 3 tranches filled is NOT complete')
  assert.equal(partial.allTerminal, false)
  assert.deepEqual(partial.working, ['o.3'], 'the third has not reported at all')

  const done = aggregateTranches(
    [...fills, fill({ clientOrderId: 'o.3', filledQty: 26250, avgPrice: 10 })],
    131250,
    { ids: ['o.1', 'o.2', 'o.3'] },
  )
  assert.equal(done.complete, true)
  assert.equal(done.allTerminal, true)
})

test('the average across tranches is QUANTITY-WEIGHTED', () => {
  // 30 lots of NIFTY (lot 75, freeze 24 lots) -> 1800 @ 100 and 450 @ 130.
  // The true average is 106. Taking the last tranche's 130 is Rs.54,000 out on
  // this one order, which is exactly what marking terminal per update did.
  const agg = aggregateTranches(
    [
      fill({ clientOrderId: 'X.1', filledQty: 1800, avgPrice: 100 }),
      fill({ clientOrderId: 'X.2', filledQty: 450, avgPrice: 130 }),
    ],
    2250,
    { ids: ['X.1', 'X.2'] },
  )
  assert.equal(agg.filledQty, 2250)
  assert.equal(agg.avgPrice, 106)
  assert.equal(agg.complete, true)
})

test('a tranche that never reached the broker is terminal with no fill', () => {
  // Placement threw for X.2, so no order update will EVER arrive for it. Without
  // this the desk order waits on it for the rest of the session.
  const agg = aggregateTranches(
    [fill({ clientOrderId: 'X.1', filledQty: 1800, avgPrice: 100 })],
    2250,
    { ids: ['X.1', 'X.2'], failed: ['X.2'] },
  )
  assert.equal(agg.allTerminal, true)
  assert.equal(agg.complete, false)
  assert.deepEqual(agg.working, [])
})

test('repeated status messages for one tranche are not double-counted', () => {
  const fills = [
    fill({ clientOrderId: 'o.1', status: 'PARTIALLY_FILLED', filledQty: 2625, avgPrice: 10 }),
    fill({ clientOrderId: 'o.1', status: 'FILLED', filledQty: 13125, avgPrice: 10 }),
  ]
  const agg = aggregateTranches(fills, 13125, { ids: ['o.1'] })
  assert.equal(agg.filledQty, 13125, 'the LATEST per order, not the sum of messages')
  assert.equal(agg.complete, true)
})

test('a rejected tranche is surfaced with its reason', () => {
  const agg = aggregateTranches(
    [fill({ clientOrderId: 'o.1', status: 'REJECTED', rejectReason: 'RMS: margin' })],
    13125,
    { ids: ['o.1'] },
  )
  assert.deepEqual(agg.rejected, ['RMS: margin'])
  assert.equal(agg.complete, false)
  assert.equal(agg.allTerminal, true)
})

// ------------------------------------------------------------ the decision

const agg = (fills: FillRecord[], expected: number, ids: string[], failed: string[] = []) =>
  aggregateTranches(fills, expected, { ids, failed })

test('an order with a tranche still WORKING is not terminal at all', () => {
  // The G1 defect in one assertion: X.1 FILLED does not resolve X.
  const outcome = decideOrderOutcome(
    agg([fill({ clientOrderId: 'X.1', filledQty: 1800, avgPrice: 100 })], 2250, ['X.1', 'X.2']),
    2250,
  )
  assert.equal(outcome, null, '450 qty is still working at the broker')
})

test('a fully filled split order is FILLED at the weighted average', () => {
  const outcome = decideOrderOutcome(
    agg(
      [
        fill({ clientOrderId: 'X.1', filledQty: 1800, avgPrice: 100 }),
        fill({ clientOrderId: 'X.2', filledQty: 450, avgPrice: 130 }),
      ],
      2250,
      ['X.1', 'X.2'],
    ),
    2250,
  )
  assert.equal(outcome?.state, 'FILLED')
  assert.equal(outcome?.avgPrice, 106)
  assert.equal(outcome?.filledQty, 2250)
})

test('one filled and one rejected tranche is PARTIAL, never REJECTED', () => {
  // Reporting REJECTED tells the desk it holds nothing when 24 lots are live;
  // flattening against that difference opens a fresh position the other way.
  const outcome = decideOrderOutcome(
    agg(
      [
        fill({ clientOrderId: 'X.1', filledQty: 1800, avgPrice: 100 }),
        fill({ clientOrderId: 'X.2', status: 'REJECTED', rejectReason: 'RMS: margin' }),
      ],
      2250,
      ['X.1', 'X.2'],
    ),
    2250,
  )
  assert.equal(outcome?.state, 'PARTIAL')
  assert.equal(outcome?.filledQty, 1800)
  assert.equal(outcome?.avgPrice, 100, 'the average of what actually filled')
  assert.match(outcome?.reason ?? '', /RMS: margin/)
})

test('every tranche rejected is REJECTED', () => {
  const outcome = decideOrderOutcome(
    agg(
      [
        fill({ clientOrderId: 'X.1', status: 'REJECTED', rejectReason: 'RMS: margin' }),
        fill({ clientOrderId: 'X.2', status: 'REJECTED', rejectReason: 'RMS: margin' }),
      ],
      2250,
      ['X.1', 'X.2'],
    ),
    2250,
  )
  assert.equal(outcome?.state, 'REJECTED')
  assert.equal(outcome?.filledQty, 0)
})
