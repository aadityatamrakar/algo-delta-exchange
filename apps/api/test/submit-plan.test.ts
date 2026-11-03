/**
 * The pure half of `/v1/desk/submit`, exercised directly.
 *
 * `submit.test.ts` proves each gate END TO END, through the service, its fake
 * store and its fake rails — that is the safety net and it stays. This file
 * pins the same decisions at the level they are actually MADE, with no store
 * and no rail in the picture, so a wrong lot size or a mis-stated refusal is a
 * two-line failure naming the function rather than a routed-order assertion
 * three layers away.
 *
 * Everything here is a total function, so every case is a literal in and a
 * literal out. If a test in this file needs a fake, the function under test has
 * grown an I/O dependency and belongs back in the method.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { KillSwitchState } from '../src/safety.ts'
import {
  buildClaimRecord,
  chooseFillPrice,
  chooseLiveLots,
  classifyRouteOutcome,
  isGateRefusal,
  planTranches,
  screenRiskGate,
  screenSubmitGates,
  sumLots,
  trancheFill,
  type StoredSubmission,
} from '../src/submit-plan.ts'
import {
  exposureLimitsFromEnv,
  NO_EXPOSURE_LIMITS,
  type ExposureState,
} from '@algomaker/order-bus'

const HALT_OFF: KillSwitchState = { enabled: false, reason: '', setBy: '', setAt: 0 }
const HALT_ON: KillSwitchState = {
  enabled: true,
  reason: 'gap risk',
  setBy: 'ops',
  setAt: 1,
}
const NO_PIN: ReadonlySet<string> = new Set()

const ON = { enabled: true }

// ------------------------------------------------------------------- gates

test('every gate passing is the only way to get null back', () => {
  assert.equal(
    screenSubmitGates({
      tag: 'bn-breakout',
      mode: 'paper',
      modes: { paper: ON },
      halt: HALT_OFF,
      liveTags: NO_PIN,
    }),
    null,
  )
})

test('the kill switch names itself AND the reason it was set with', () => {
  const reason = screenSubmitGates({
    tag: 'bn-breakout',
    mode: 'paper',
    modes: { paper: ON },
    halt: HALT_ON,
    liveTags: NO_PIN,
  })
  assert.match(String(reason), /^kill switch: engaged \(gap risk\)/)
})

test('an EXIT is never blocked by the kill switch — a trapped position is worse', () => {
  assert.equal(
    screenSubmitGates({
      tag: 'bn-breakout',
      mode: 'paper',
      reducesExposure: true,
      modes: { paper: ON },
      halt: HALT_ON,
      liveTags: NO_PIN,
    }),
    null,
  )
})

test('the kill switch is checked BEFORE the mode switch — the halt is the headline', () => {
  // Both gates would refuse. An operator reading the order feed during a halt
  // must see the halt, not a switch detail that is downstream of it.
  const reason = screenSubmitGates({
    tag: 'bn-breakout',
    mode: 'live',
    modes: {},
    halt: HALT_ON,
    liveTags: NO_PIN,
  })
  assert.match(String(reason), /^kill switch:/)
})

test("a mode the row is not switched on for is refused, and the refusal says 'stale mode'", () => {
  const reason = screenSubmitGates({
    tag: 'bn-breakout',
    mode: 'live',
    modes: { paper: ON, live: { enabled: false } },
    halt: HALT_OFF,
    liveTags: NO_PIN,
  })
  assert.match(String(reason), /^strategy mode: 'bn-breakout' is not switched on for live/)
  assert.match(String(reason), /stale mode/)
})

test('an EXIT bypasses the mode switch too — the redundant gate restates the 2026-08-04 exemption', () => {
  // This gate is the refactor-surviving copy of `gateStrategy`, so when the
  // primary learned to release exits (the runner flattens ON switch-off, and
  // refusing that flatten stranded four books' positions on 2026-08-04), this
  // copy had to learn it in the same change — or it would quietly reintroduce
  // the trap the primary just removed.
  assert.equal(
    screenSubmitGates({
      tag: 'bn-breakout',
      mode: 'live',
      reducesExposure: true,
      modes: { live: { enabled: false } },
      halt: HALT_OFF,
      liveTags: NO_PIN,
    }),
    null,
  )
  // The exemption is claimed, never assumed: the same switched-off mode still
  // refuses an order that does not say it reduces exposure.
  const reason = screenSubmitGates({
    tag: 'bn-breakout',
    mode: 'live',
    modes: { live: { enabled: false } },
    halt: HALT_OFF,
    liveTags: NO_PIN,
  })
  assert.match(String(reason), /^strategy mode:/)
})

test('an EMPTY DESK_LIVE_TAGS is NO PIN — it must not refuse everything', () => {
  assert.equal(
    screenSubmitGates({
      tag: 'bn-breakout',
      mode: 'live',
      modes: { live: ON },
      halt: HALT_OFF,
      liveTags: NO_PIN,
    }),
    null,
  )
})

test('a NON-EMPTY pin narrows to its subset and names the excluded tag', () => {
  const base = {
    modes: { live: ON },
    halt: HALT_OFF,
    liveTags: new Set(['other-tag']),
    mode: 'live',
  } as const
  assert.match(
    String(screenSubmitGates({ ...base, tag: 'bn-breakout' })),
    /^live pin: this host is pinned by DESK_LIVE_TAGS .* excludes 'bn-breakout'/s,
  )
  assert.equal(screenSubmitGates({ ...base, tag: 'other-tag' }), null)
})

test('the pin has no opinion about PAPER — it locks down live trading only', () => {
  assert.equal(
    screenSubmitGates({
      tag: 'bn-breakout',
      mode: 'paper',
      modes: { paper: ON },
      halt: HALT_OFF,
      liveTags: new Set(['other-tag']),
    }),
    null,
  )
})

// -------------------------------------------------------------- risk limits

const EXPOSURE: ExposureState = {
  nowMs: 1_700_000_000_000,
  recentOrderTs: [],
  openLotsByUnderlying: { BANKNIFTY: 4 },
  openLotsTotal: 4,
  dayLoss: 0,
}

/** A live order big enough to trip any limit that is actually switched on. */
const bigLiveOrder = {
  mode: 'live',
  underlying: 'BANKNIFTY',
  lots: 10,
  quantity: 350,
  price: 200,
} as const

test('with nothing configured the risk gate is INERT — shipping it changes nothing', () => {
  assert.equal(
    screenRiskGate({
      ...bigLiveOrder,
      limits: NO_EXPOSURE_LIMITS,
      exposure: { ...EXPOSURE, dayLoss: 5_000_000, openLotsTotal: 900 },
    }),
    null,
  )
})

test('a configured limit refuses the OPEN, naming the limit, the measurement and the knob', () => {
  const reason = screenRiskGate({
    ...bigLiveOrder,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_TOTAL_LOTS: '5' }),
    exposure: EXPOSURE,
  })
  assert.match(String(reason), /MAX_LOTS_TOTAL/)
  assert.match(String(reason), /4 \+ 10 > 5/, 'the measured value and the limit')
  assert.match(String(reason), /DESK_RISK_MAX_TOTAL_LOTS/, 'which knob to change')
})

test('the same order as an EXIT passes the same configured limit', () => {
  assert.equal(
    screenRiskGate({
      ...bigLiveOrder,
      reducesExposure: true,
      limits: exposureLimitsFromEnv({
        DESK_RISK_MAX_TOTAL_LOTS: '5',
        DESK_RISK_MAX_DAY_LOSS: '1',
        DESK_RISK_MAX_NOTIONAL: '1',
        DESK_RISK_MAX_ORDERS_PER_MIN: '1',
      }),
      exposure: { ...EXPOSURE, dayLoss: 900_000, recentOrderTs: [EXPOSURE.nowMs - 1] },
    }),
    null,
    'a limit that traps a position is worse than no limit',
  )
})

test('PAPER is not gated — the caps are a live-money control', () => {
  assert.equal(
    screenRiskGate({
      ...bigLiveOrder,
      mode: 'paper',
      limits: exposureLimitsFromEnv({ DESK_RISK_MAX_TOTAL_LOTS: '1' }),
      exposure: EXPOSURE,
    }),
    null,
  )
})

test('the day loss stop fires on the measured loss', () => {
  const reason = screenRiskGate({
    ...bigLiveOrder,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '50000' }),
    exposure: { ...EXPOSURE, dayLoss: 61_250 },
  })
  assert.match(String(reason), /DAILY_LOSS.*61250.*50000/)
})

test('an UNMEASURABLE desk refuses new exposure only while a limit is configured', () => {
  // A configured stop that cannot see the number it stops on is not a stop.
  const refused = screenRiskGate({
    ...bigLiveOrder,
    limits: exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '50000' }),
    exposure: null,
  })
  assert.match(String(refused), /could not be measured/)
  // ...and with nothing configured there is nothing to measure against.
  assert.equal(
    screenRiskGate({ ...bigLiveOrder, limits: NO_EXPOSURE_LIMITS, exposure: null }),
    null,
  )
  // ...and an exit is never held up by a measurement problem either.
  assert.equal(
    screenRiskGate({
      ...bigLiveOrder,
      reducesExposure: true,
      limits: exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '50000' }),
      exposure: null,
    }),
    null,
  )
})

// ------------------------------------------------------------------ sizing

test('PAPER never picks up liveLots — the strategy sizes itself', () => {
  assert.deepEqual(
    chooseLiveLots({ tag: 't', mode: 'paper', requestedLots: 3, liveLots: 10 }),
    { ok: true, lots: 3, overridden: false },
  )
})

test('liveLots REPLACES the requested size on a live entry — it does not multiply', () => {
  assert.deepEqual(chooseLiveLots({ tag: 't', mode: 'live', requestedLots: 3, liveLots: 10 }), {
    ok: true,
    lots: 10,
    overridden: true,
  })
})

test('an override to the SAME number is not reported as an override', () => {
  assert.deepEqual(chooseLiveLots({ tag: 't', mode: 'live', requestedLots: 10, liveLots: 10 }), {
    ok: true,
    lots: 10,
    overridden: false,
  })
})

test('an EXIT keeps the size it asked for — closing 5 must not become closing 10', () => {
  assert.deepEqual(
    chooseLiveLots({
      tag: 't',
      mode: 'live',
      requestedLots: 5,
      liveLots: 10,
      reducesExposure: true,
    }),
    { ok: true, lots: 5, overridden: false },
  )
})

test("a positional book's leg keeps its own size — exactLots is the §7.4 exemption", () => {
  assert.deepEqual(
    chooseLiveLots({ tag: 't', mode: 'live', requestedLots: 2, liveLots: 10, exactLots: true }),
    { ok: true, lots: 2, overridden: false },
  )
})

test('an UNSET liveLots refuses a live entry rather than sizing it at 0', () => {
  const plan = chooseLiveLots({ tag: 'bn-breakout', mode: 'live', requestedLots: 3, liveLots: 0 })
  assert.equal(plan.ok, false)
  assert.match(plan.ok ? '' : plan.reason, /^live sizing: liveLots is 0 .* 'bn-breakout'/)
})

test('an EXEMPT order is never refused for an unset liveLots — the gate goes with the override', () => {
  // The `liveLots > 0` check exists to force a deliberate size. A book's size
  // comes from its seed, so applying the check there would block the Build
  // screen on a dial that has no say in the answer.
  assert.deepEqual(
    chooseLiveLots({ tag: 't', mode: 'live', requestedLots: 2, liveLots: 0, exactLots: true }),
    { ok: true, lots: 2, overridden: false },
  )
  assert.deepEqual(
    chooseLiveLots({
      tag: 't',
      mode: 'live',
      requestedLots: 2,
      liveLots: 0,
      reducesExposure: true,
    }),
    { ok: true, lots: 2, overridden: false },
  )
})

// ------------------------------------------------------------------- price

test('the live mark wins over both prices the caller sent', () => {
  assert.equal(chooseFillPrice(101.5, 100, 99), 101.5)
})

test('a cold cache falls back to the strategy s own decision price, then to the limit', () => {
  assert.equal(chooseFillPrice(null, 100, 99), 100)
  assert.equal(chooseFillPrice(null, undefined, 99), 99)
})

test('no price ANYWHERE is null, never 0 — a fill at 0 reports profit never made', () => {
  assert.equal(chooseFillPrice(null, undefined, undefined), null)
  assert.equal(chooseFillPrice(undefined, undefined, undefined), null)
})

// ---------------------------------------------------------------- tranches

test('a size under the freeze cap is ONE tranche, and it is still suffixed', () => {
  // The tranche id and the idempotency key must never collide.
  assert.deepEqual(planTranches({ clientOrderId: 'x', lots: 3, freezeMaxLots: 10, lotSize: 15 }), [
    { clientOrderId: 'x#0', lots: 3, qty: 45 },
  ])
})

test('a size OVER the cap splits, and the qty of each tranche is lots x lotSize', () => {
  const orders = planTranches({ clientOrderId: 'x', lots: 25, freezeMaxLots: 10, lotSize: 15 })
  assert.deepEqual(
    orders.map((o) => [o.clientOrderId, o.lots, o.qty]),
    [
      ['x#0', 10, 150],
      ['x#1', 10, 150],
      ['x#2', 5, 75],
    ],
  )
  assert.equal(sumLots(orders), 25)
})

test('an UNKNOWN freeze cap sends one order rather than inventing a split', () => {
  assert.deepEqual(
    planTranches({ clientOrderId: 'x', lots: 40, freezeMaxLots: null, lotSize: 15 }),
    [{ clientOrderId: 'x#0', lots: 40, qty: 600 }],
  )
})

// ------------------------------------------------------------------ claims

const CLAIM = {
  clientOrderId: 'coid-1',
  tag: 'bn-breakout',
  mode: 'paper',
  tradingsymbol: 'BANKNIFTY24SEP50000CE',
  side: 'Buy',
  requestedLots: 3,
  lots: 3,
  createdAt: 1_700_000_000_000,
  freezeMaxLots: 10,
  plannedOrders: [{ clientOrderId: 'coid-1#0', lots: 3, qty: 45 }],
  underlying: 'BANKNIFTY',
  price: 120.5,
  op: 'open',
} as const

test('the CLAIM says nothing has routed — accepted false, orders empty, status ROUTING', () => {
  // A claim that predicted success is what made a crash between the insert and
  // the routing loop replay as a complete order.
  const rec = buildClaimRecord(CLAIM)
  assert.equal(rec.accepted, false)
  assert.deepEqual(rec.orders, [])
  assert.equal(rec.status, 'ROUTING')
  assert.equal(rec.reason, '')
  assert.deepEqual(rec.routeErrors, [])
})

test('the claim carries the PLAN and the price separately, so a reconcile can finish the job', () => {
  const rec = buildClaimRecord(CLAIM)
  assert.deepEqual(rec.plannedOrders, CLAIM.plannedOrders)
  assert.equal(rec.price, 120.5)
  assert.equal(rec.op, 'open')
  assert.equal(rec.underlying, 'BANKNIFTY')
  assert.equal(rec.createdAt, CLAIM.createdAt)
})

test('an absent orderType/limitPrice stays ABSENT rather than becoming undefined', () => {
  const rec = buildClaimRecord(CLAIM)
  assert.equal('orderType' in rec, false)
  assert.equal('limitPrice' in rec, false)
  const limit = buildClaimRecord({ ...CLAIM, orderType: 'LIMIT', limitPrice: 121 })
  assert.equal(limit.orderType, 'LIMIT')
  assert.equal(limit.limitPrice, 121)
})

test('the intended lots and the REQUESTED lots are both kept, so an override stays auditable', () => {
  const rec = buildClaimRecord({ ...CLAIM, requestedLots: 3, lots: 10 })
  assert.equal(rec.requestedLots, 3)
  assert.equal(rec.lots, 10)
})

test('ONLY a DONE + unaccepted + nothing-routed record is a retryable gate refusal', () => {
  const base: StoredSubmission = buildClaimRecord(CLAIM)
  assert.equal(isGateRefusal({ ...base, status: 'DONE', accepted: false }), true)
  // Attempted. Something may be on the wire — it must keep replaying.
  assert.equal(isGateRefusal({ ...base, status: 'FAILED', accepted: false }), false)
  // Outstanding claim, truth unknown.
  assert.equal(isGateRefusal({ ...base, status: 'ROUTING', accepted: false }), false)
  assert.equal(isGateRefusal({ ...base, status: 'DONE', accepted: true }), false)
  // DONE + unaccepted but it DID route: refuse rather than authorise a second placement.
  assert.equal(
    isGateRefusal({
      ...base,
      status: 'DONE',
      accepted: false,
      orders: [{ clientOrderId: 'coid-1#0', lots: 3, qty: 45 }],
    }),
    false,
  )
})

// ------------------------------------------------------------------- fills

test("a tranche's fill is deskTagged by the TRANCHE id, not by the submission id", () => {
  const fill = trancheFill(
    { clientOrderId: 'coid-1#1', lots: 2, qty: 30 },
    {
      op: 'close',
      tradingsymbol: 'BANKNIFTY24SEP50000CE',
      side: 'Sell',
      price: 118,
      ts: 1_700_000_000_000,
    },
  )
  assert.deepEqual(fill, {
    op: 'close',
    deskTag: 'coid-1#1',
    tradingsymbol: 'BANKNIFTY24SEP50000CE',
    side: 'Sell',
    qty: 30,
    price: 118,
    ts: 1_700_000_000_000,
  })
})

test("a fill can name the DESK LEG it closes, and that wins over the tranche id", () => {
  // The repair path's one use: a close's fill has to carry the id of the leg it
  // takes off, because that is the equality the Python driver's `absorb_bridge_
  // closes` books realized P&L on. Absent, nothing changes for anyone else.
  const fill = trancheFill(
    { clientOrderId: 'repair:dec-1:0#0', lots: 2, qty: 30 },
    {
      op: 'close',
      tradingsymbol: 'TCS26AUG2440PE',
      side: 'Buy',
      price: 12.4,
      ts: 1_700_000_000_000,
      deskTag: 'py:2440PE:1755',
    },
  )
  assert.equal(fill.deskTag, 'py:2440PE:1755')
})

test("a fill's order type is carried only when there is one", () => {
  const fill = trancheFill(
    { clientOrderId: 'c#0', lots: 1, qty: 15 },
    {
      op: 'open',
      tradingsymbol: 'X',
      side: 'Buy',
      price: 10,
      ts: 1,
      orderType: 'LIMIT',
      limitPrice: 10.5,
    },
  )
  assert.equal(fill.orderType, 'LIMIT')
  assert.equal(fill.limitPrice, 10.5)
})

// ----------------------------------------------------------------- outcome

const A = { clientOrderId: 'c#0', lots: 2, qty: 30 }
const B = { clientOrderId: 'c#1', lots: 1, qty: 15 }

test('a clean route is accepted and DONE with no reason to give', () => {
  assert.deepEqual(classifyRouteOutcome([A, B], []), {
    accepted: true,
    status: 'DONE',
    reason: '',
  })
})

test('a PARTIAL route stays ACCEPTED — real exposure exists — but is FAILED', () => {
  // The caller must book the routed side of a partial; `status` is what tells
  // it the rest did not go.
  assert.deepEqual(classifyRouteOutcome([A], ['c#1: rejected']), {
    accepted: true,
    status: 'FAILED',
    reason: '',
  })
})

test('NOTHING routed is unaccepted, and names every failure so the opportunity is not burnt', () => {
  assert.deepEqual(classifyRouteOutcome([], ['c#0: rejected', 'c#1: timeout']), {
    accepted: false,
    status: 'FAILED',
    reason: 'routing: c#0: rejected; c#1: timeout',
  })
})

test('routed lots are summed from the tranches, never from the intended size', () => {
  assert.equal(sumLots([A, B]), 3)
  assert.equal(sumLots([]), 0)
})
