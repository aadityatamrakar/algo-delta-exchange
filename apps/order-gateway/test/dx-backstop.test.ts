/**
 * EXCHANGE-RESIDENT BACKSTOPS: one reduce-only BUY stop-limit resting on Delta
 * per short option leg the desk holds, at the book's straddle stop line, so a
 * dead desk does not leave a naked short straddle with no stop.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DxApiError, dxClientOrderId, type DxOrder, type DxOrderRequest, type DxPosition } from '@algomaker/dx'
import {
  DX_BACKSTOP_PREFIX,
  backstopClientOrderId,
  backstopEnabled,
  backstopLimitPct,
  bookRailOf,
  createDxBackstop,
  deskBooksFrom,
  desiredStops,
  isBackstopOrderId,
  planBackstops,
  type DeskBookView,
} from '../src/dx-backstop.ts'

const CE = 'C-BTC-77000-131126'
const PE = 'P-BTC-77000-131126'

function book(over: Partial<DeskBookView> = {}): DeskBookView {
  return {
    tag: 'BTC-2026-11-13-bull-s-weekly-2',
    mode: 'live',
    rail: 'live',
    stopMult: 1.25,
    stopBasis: 1,
    groups: [{ strike: 77000, ceEntry: 2060, peEntry: 1730, ceOpen: true, peOpen: true }],
    legs: [
      { symbol: CE, strike: 77000, optType: 'CE', contracts: 20, entryPrice: 2060 },
      { symbol: PE, strike: 77000, optType: 'PE', contracts: 20, entryPrice: 1730 },
    ],
    ...over,
  }
}

const pos = (symbol: string, size: number, id = symbol === CE ? 11 : 12): DxPosition => ({ product_id: id, product_symbol: symbol, size, entry_price: '1' })

function stopOrder(over: Partial<DxOrder> & { client_order_id: string | null }): DxOrder {
  return {
    id: 900,
    product_id: 11,
    product_symbol: CE,
    size: 20,
    unfilled_size: 20,
    side: 'buy',
    order_type: 'limit_order',
    state: 'pending',
    reduce_only: true,
    stop_order_type: 'stop_loss_order',
    stop_price: '4737.5',
    limit_price: '7106.3',
    ...over,
  }
}

// ------------------------------------------------------------------- ids

test('backstop ids: deterministic, ≤ 32 chars of [A-Za-z0-9_-], one per (rail, book, contract)', () => {
  const a = backstopClientOrderId('live', 'BTC-2026-11-13-bull-s-weekly-2', CE)
  assert.equal(a, backstopClientOrderId('live', 'BTC-2026-11-13-bull-s-weekly-2', CE))
  assert.ok(a.startsWith(DX_BACKSTOP_PREFIX))
  assert.match(a, /^[A-Za-z0-9_-]{1,32}$/)
  assert.notEqual(a, backstopClientOrderId('live', 'BTC-2026-11-13-bull-s-weekly-2', PE))
  assert.notEqual(a, backstopClientOrderId('demo', 'BTC-2026-11-13-bull-s-weekly-2', CE))
  assert.ok(isBackstopOrderId(a))
})

test('a desk order id can never read as a backstop', () => {
  for (const desk of ['BTC-2026-11-13-bull-s-weekly-2|e:1793705342899:0#1', 'abc123', 'h1234']) {
    assert.equal(isBackstopOrderId(dxClientOrderId(desk)), false, desk)
  }
  assert.equal(isBackstopOrderId(null), false)
  assert.equal(isBackstopOrderId(''), false)
})

test('env: DX_BACKSTOP on unless 0; DX_BACKSTOP_LIMIT_PCT defaults 0.5 and refuses a typo', () => {
  assert.equal(backstopEnabled({}), true)
  assert.equal(backstopEnabled({ DX_BACKSTOP: '1' }), true)
  assert.equal(backstopEnabled({ DX_BACKSTOP: '0' }), false)
  assert.equal(backstopLimitPct({}), 0.5)
  assert.equal(backstopLimitPct({ DX_BACKSTOP_LIMIT_PCT: '0.3' }), 0.3)
  assert.throws(() => backstopLimitPct({ DX_BACKSTOP_LIMIT_PCT: 'abc' }), /DX_BACKSTOP_LIMIT_PCT/)
  assert.throws(() => backstopLimitPct({ DX_BACKSTOP_LIMIT_PCT: '-1' }), /DX_BACKSTOP_LIMIT_PCT/)
})

// ------------------------------------------------------------ desk view

test('bookRailOf: live is live; paper goes where its legs were opened, else its setting (default demo)', () => {
  assert.equal(bookRailOf({ mode: 'live' }), 'live')
  assert.equal(bookRailOf({ mode: 'paper', dx_paper_rail: 'demo' }), 'demo')
  assert.equal(bookRailOf({ mode: 'paper', dx_paper_rail: 'sim' }), 'sim')
  assert.equal(bookRailOf({ mode: 'paper', dx_paper_rail: 'sim', dx_rail_used: 'demo' }), 'demo')
  assert.equal(bookRailOf({ mode: 'paper' }), 'demo')
  assert.equal(bookRailOf({ mode: 'bogus' }), 'sim')
})

test('deskBooksFrom joins registry dials, supervisor groups and held short legs', () => {
  const views = deskBooksFrom(
    [{ tag: 'T', mode: 'paper', dx_paper_rail: 'demo', dials: { bs_stop_mult: 1.25, bs_stop_basis: 1 } }],
    [{ key: 'T:paper', ruleState: { bs: { groups: [{ strike: 77000, lots: 20, ceEntry: 2060, peEntry: 1730, ceOpen: true, peOpen: true }] } } }],
    [{
      tag: 'T',
      mode: 'paper',
      legs: [
        { instrument: { tradingsymbol: CE, lotSize: 0.001 }, strike: 77000, type: 'CE', side: 'Sell', qty: -0.02, entryPrice: 2060 },
        { instrument: { tradingsymbol: PE, lotSize: 0.001 }, strike: 77000, type: 'PE', side: 'Sell', qty: -0.02, entryPrice: 1730 },
        // A long leg is not something a buy stop protects.
        { instrument: { tradingsymbol: 'C-BTC-80000-131126', lotSize: 0.001 }, strike: 80000, type: 'CE', side: 'Buy', qty: 0.01, entryPrice: 5 },
      ],
    }],
  )
  assert.equal(views.length, 1)
  const v = views[0]!
  assert.equal(v.rail, 'demo')
  assert.equal(v.stopMult, 1.25)
  assert.deepEqual(v.legs.map((l) => [l.symbol, l.contracts]), [[CE, 20], [PE, 20]])
  assert.equal(v.groups.length, 1)
})

// ----------------------------------------------------------- stop line

test('each leg rests at the group stop line S = (ce + pe) × stop_mult, rounded UP to the tick', () => {
  const { legs, problems } = desiredStops([book()], 'live')
  assert.deepEqual(problems, [])
  // (2060 + 1730) × 1.25 = 4737.5
  assert.deepEqual(legs.map((l) => [l.symbol, l.contracts, l.stopPrice]), [[CE, 20, 4737.5], [PE, 20, 4737.5]])
})

test('basis 0 truncates like the desk does; a line between ticks rounds up, never fires early', () => {
  const t = desiredStops([book({ stopBasis: 0 })], 'live').legs
  assert.equal(t[0]?.stopPrice, 4737)
  const odd = desiredStops([book({ stopMult: 1.3333, groups: [{ strike: 77000, ceEntry: 100.03, peEntry: 0, ceOpen: true, peOpen: false }] })], 'live').legs
  // 100.03 × 1.3333 = 133.37 → 133.4
  assert.equal(odd[0]?.stopPrice, 133.4)
})

test('a leg no group accounts for uses the held legs at its strike (the desk adopts them that way)', () => {
  const { legs } = desiredStops([book({ groups: [] })], 'live')
  assert.equal(legs[0]?.stopPrice, 4737.5)
  const lone = desiredStops([book({ groups: [], legs: [{ symbol: CE, strike: 77000, optType: 'CE', contracts: 5, entryPrice: 100 }] })], 'live').legs
  // No partner: 2 × its own entry × mult = 250.
  assert.equal(lone[0]?.stopPrice, 250)
})

test('only the asked rail; a book with no stop multiple is a problem, never a guess', () => {
  assert.equal(desiredStops([book()], 'demo').legs.length, 0)
  const r = desiredStops([book({ stopMult: null })], 'live')
  assert.equal(r.legs.length, 0)
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0]?.message ?? '', /stop multiple/)
})

// ----------------------------------------------------------------- plan

const plan = (over: Partial<Parameters<typeof planBackstops>[0]> = {}) =>
  planBackstops({
    rail: 'live',
    desired: desiredStops([book()], 'live').legs,
    positions: [pos(CE, -20), pos(PE, -20)],
    open: [],
    limitPct: 0.5,
    ...over,
  })

test('missing backstops are placed: reduce-only stop-limit, limit = stop × 1.5 on the tick, sized to the leg', () => {
  const p = plan()
  assert.equal(p.place.length, 2)
  const ce = p.place.find((o) => o.symbol === CE)!
  assert.equal(ce.productId, 11)
  assert.equal(ce.size, 20)
  assert.equal(ce.stopPrice, '4737.5')
  assert.equal(ce.limitPrice, '7106.3') // 7106.25 up to the tick
  assert.equal(ce.clientOrderId, backstopClientOrderId('live', book().tag, CE))
  assert.deepEqual(p.cancel, [])
  assert.deepEqual(p.edit, [])
})

test('a backstop that matches is left alone; one whose size or stop moved is edited', () => {
  const id = backstopClientOrderId('live', book().tag, CE)
  const same = plan({ open: [stopOrder({ client_order_id: id })], positions: [pos(CE, -20)] })
  assert.equal(same.place.length, 0)
  assert.equal(same.edit.length, 0)
  const resized = plan({ open: [stopOrder({ client_order_id: id, size: 10, unfilled_size: 10 })], positions: [pos(CE, -20)] })
  assert.equal(resized.edit.length, 1)
  assert.equal(resized.edit[0]?.want.size, 20)
  const moved = plan({ open: [stopOrder({ client_order_id: id, stop_price: '4000.0' })], positions: [pos(CE, -20)] })
  assert.equal(moved.edit.length, 1)
})

test('an orphan backstop (contract no longer held by the book) is cancelled; desk and foreign orders are not', () => {
  const orphan = stopOrder({ id: 1, client_order_id: backstopClientOrderId('live', 'GONE-BOOK', CE) })
  const desk = stopOrder({ id: 2, client_order_id: 'h-desk-exit', stop_order_type: null, stop_price: null, state: 'open' })
  const manual = stopOrder({ id: 3, client_order_id: null })
  const p = plan({ open: [orphan, desk, manual] })
  assert.deepEqual(p.cancel.map((o) => o.id), [1])
})

test('never more than Delta holds: no short on Delta, no stop; a smaller short caps the size', () => {
  const none = plan({ positions: [] })
  assert.equal(none.place.length, 0)
  const capped = plan({ positions: [pos(CE, -7), pos(PE, -20)] })
  assert.equal(capped.place.find((o) => o.symbol === CE)?.size, 7)
  const long = plan({ positions: [pos(CE, 5)] })
  assert.equal(long.place.length, 0)
})

test('two books on one contract: each its own stop, together never above Delta\'s short', () => {
  const b2 = book({ tag: 'OTHER', groups: [{ strike: 77000, ceEntry: 1000, peEntry: 1000, ceOpen: true, peOpen: true }] })
  const p = plan({ desired: desiredStops([book(), b2], 'live').legs, positions: [pos(CE, -30), pos(PE, -40)] })
  const ce = p.place.filter((o) => o.symbol === CE)
  assert.equal(ce.reduce((s, o) => s + o.size, 0), 30)
  assert.equal(new Set(ce.map((o) => o.clientOrderId)).size, ce.length)
})

test('a triggered backstop (open, working) is kept, not edited', () => {
  const id = backstopClientOrderId('live', book().tag, CE)
  const p = plan({ open: [stopOrder({ client_order_id: id, state: 'open', size: 5 })], positions: [pos(CE, -20)] })
  assert.equal(p.edit.length, 0)
  assert.equal(p.place.length, 0)
  assert.equal(p.cancel.length, 0)
})

test('a Delta short no desk book accounts for is reported unprotected', () => {
  const p = plan({ desired: [], positions: [pos(CE, -3)] })
  assert.deepEqual(p.unprotected, [{ symbol: CE, contracts: 3 }])
})

// ------------------------------------------------------------------- run

function fakeRest(state: { positions: DxPosition[]; open: DxOrder[] }) {
  const placed: DxOrderRequest[] = []
  const edits: unknown[] = []
  const cancels: number[] = []
  let failPlace: Error | null = null
  let failEdit: Error | null = null
  return {
    placed,
    edits,
    cancels,
    failPlaceWith(e: Error | null) { failPlace = e },
    failEditWith(e: Error | null) { failEdit = e },
    rest: {
      positions: async () => state.positions,
      openOrders: async () => state.open,
      placeOrder: async (o: DxOrderRequest) => {
        if (failPlace !== null) throw failPlace
        placed.push(o)
        return stopOrder({ client_order_id: o.client_order_id ?? '' })
      },
      editOrder: async (o: unknown) => {
        if (failEdit !== null) throw failEdit
        edits.push(o)
        return stopOrder({ client_order_id: 'x' })
      },
      cancelOrder: async (id: number) => {
        cancels.push(id)
        return stopOrder({ client_order_id: 'x', state: 'cancelled' })
      },
    },
  }
}

test('run: places the missing backstops with the exact wire shape', async () => {
  const f = fakeRest({ positions: [pos(CE, -20), pos(PE, -20)], open: [] })
  const alerts: unknown[] = []
  const bs = createDxBackstop({ rail: 'live', rest: f.rest, readDesk: async () => [book()], alert: (a) => alerts.push(a), log: () => {}, now: () => 0, limitPct: 0.5 })
  const r = await bs.run()
  assert.equal(r?.placed, 2)
  const ce = f.placed.find((o) => o.product_id === 11)!
  assert.deepEqual(ce, {
    product_id: 11,
    size: 20,
    side: 'buy',
    order_type: 'limit_order',
    limit_price: '7106.3',
    stop_order_type: 'stop_loss_order',
    stop_price: '4737.5',
    stop_trigger_method: 'mark_price',
    reduce_only: true,
    time_in_force: 'gtc',
    client_order_id: backstopClientOrderId('live', book().tag, CE),
  })
  assert.deepEqual(alerts, [])
})

test('run: a backstop Delta refuses is a CRITICAL alert naming the contract', async () => {
  const f = fakeRest({ positions: [pos(CE, -20)], open: [] })
  f.failPlaceWith(new DxApiError({ status: 400, code: 'insufficient_margin', message: 'no margin' }))
  const alerts: { severity: string; key: string; message: string }[] = []
  const bs = createDxBackstop({ rail: 'live', rest: f.rest, readDesk: async () => [book()], alert: (a) => alerts.push(a), log: () => {}, now: () => 0, limitPct: 0.5 })
  await bs.run()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]?.severity, 'critical')
  assert.match(alerts[0]?.message ?? '', new RegExp(CE))
  assert.match(alerts[0]?.message ?? '', /no margin/)
})

test('run: an unreadable desk view or Delta book changes NOTHING (no orphan sweep on missing data)', async () => {
  const id = backstopClientOrderId('live', book().tag, CE)
  const f = fakeRest({ positions: [pos(CE, -20)], open: [stopOrder({ client_order_id: id })] })
  const bs = createDxBackstop({ rail: 'live', rest: f.rest, readDesk: async () => { throw new Error('mongo down') }, alert: () => {}, log: () => {}, now: () => 0, limitPct: 0.5 })
  assert.equal(await bs.run(), null)
  assert.deepEqual(f.cancels, [])
  assert.deepEqual(f.placed, [])
})

test('run: an edit Delta refuses falls back to cancel + place', async () => {
  const id = backstopClientOrderId('live', book().tag, CE)
  const f = fakeRest({ positions: [pos(CE, -20)], open: [stopOrder({ id: 77, client_order_id: id, size: 3, unfilled_size: 3 })] })
  f.failEditWith(new DxApiError({ status: 400, code: 'open_order_not_found', message: 'gone' }))
  const bs = createDxBackstop({ rail: 'live', rest: f.rest, readDesk: async () => [book()], alert: () => {}, log: () => {}, now: () => 0, limitPct: 0.5 })
  await bs.run()
  assert.deepEqual(f.cancels, [77])
  assert.equal(f.placed.filter((o) => o.client_order_id === id).length, 1)
})

test('run: a Delta short no book holds is alerted only once it has outlived the grace period', async () => {
  let now = 0
  const f = fakeRest({ positions: [pos(CE, -3)], open: [] })
  const alerts: { severity: string; key: string }[] = []
  const bs = createDxBackstop({ rail: 'live', rest: f.rest, readDesk: async () => [], alert: (a) => alerts.push(a), log: () => {}, now: () => now, limitPct: 0.5, unprotectedGraceMs: 60_000 })
  await bs.run()
  assert.equal(alerts.length, 0)
  now = 61_000
  await bs.run()
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0]?.severity, 'critical')
})

test('onOrderUpdate: a backstop fill is claimed and alerted; a desk update is not the backstop\'s', () => {
  const alerts: { severity: string; message: string }[] = []
  const bs = createDxBackstop({ rail: 'demo', rest: fakeRest({ positions: [], open: [] }).rest, readDesk: async () => [], alert: (a) => alerts.push(a), log: () => {}, now: () => 0, limitPct: 0.5 })
  const id = backstopClientOrderId('demo', 'T', CE)
  assert.equal(bs.onOrderUpdate({ brokerOrderId: '1', clientOrderId: id, status: 'FILLED', filledQty: 0.02, avgPrice: 5000, tradingsymbol: CE }), true)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0]?.message ?? '', /backstop FIRED/i)
  // A pending (untriggered) echo is claimed but says nothing.
  assert.equal(bs.onOrderUpdate({ brokerOrderId: '1', clientOrderId: id, status: 'WORKING', filledQty: 0, avgPrice: null }), true)
  assert.equal(alerts.length, 1)
  assert.equal(bs.onOrderUpdate({ brokerOrderId: '2', clientOrderId: 'h-desk', status: 'FILLED', filledQty: 1, avgPrice: 1 }), false)
})
