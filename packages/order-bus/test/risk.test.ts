import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anyExposureLimitSet,
  checkExposureLimits,
  exposureLimitsFromEnv,
  NO_EXPOSURE_LIMITS,
  OrderRateWindow,
  ReservationLedger,
  type ExposureLimits,
  type ExposureState,
  type RiskSnapshot,
} from '../src/index.ts'

function snap(over: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    nowMs: 1_700_000_000_000,
    recentOrderTs: [],
    openLotsByUnderlying: {},
    openLotsTotal: 0,
    dayLoss: 0,
    isReducingExposure: false,
    underlying: 'BANKNIFTY',
    price: 100,
    ...over,
  }
}

const exposure = (over: Partial<ExposureLimits> = {}): ExposureLimits => ({
  ...NO_EXPOSURE_LIMITS,
  ...over,
})

/** One lot of a 35-lot contract, at market. */
const ORDER = { lots: 1, quantity: 35 }

// --- the loss stop ----------------------------------------------------------

test('daily loss stop blocks entries but allows exits', () => {
  const l = exposure({ maxDailyLoss: 50_000 })
  assert.equal(checkExposureLimits(ORDER, l, snap({ dayLoss: 50_000 })).allowed, false)
  assert.equal(
    checkExposureLimits(ORDER, l, snap({ dayLoss: 99_999, isReducingExposure: true })).allowed,
    true,
  )
})

// --- capacity ---------------------------------------------------------------

test('rate limit counts only the trailing 60 seconds', () => {
  const now = 1_700_000_000_000
  const l = exposure({ maxOrdersPerMinute: 3 })
  // 3 orders, all older than 60s -> should NOT count
  const old = [now - 61_000, now - 70_000, now - 120_000]
  assert.equal(checkExposureLimits(ORDER, l, snap({ nowMs: now, recentOrderTs: old })).allowed, true)
  // 3 orders inside the window -> at the limit
  const fresh = [now - 1_000, now - 2_000, now - 3_000]
  const v = checkExposureLimits(ORDER, l, snap({ nowMs: now, recentOrderTs: fresh }))
  assert.equal(v.allowed === false && v.rejection.code, 'RATE_LIMIT')
})

test('per-underlying lot cap counts the incoming order', () => {
  const l = exposure({ maxOpenLotsPerUnderlying: 5 })
  // 4 open + 1 incoming = 5, at the cap -> allowed
  assert.equal(
    checkExposureLimits(ORDER, l, snap({ openLotsByUnderlying: { BANKNIFTY: 4 } })).allowed,
    true,
  )
  // 5 open + 1 incoming = 6 -> over
  const v = checkExposureLimits(ORDER, l, snap({ openLotsByUnderlying: { BANKNIFTY: 5 } }))
  assert.equal(v.allowed === false && v.rejection.code, 'MAX_LOTS_UNDERLYING')
})

test('lot caps do NOT block exposure-reducing orders', () => {
  const l = exposure({ maxOpenLotsPerUnderlying: 1, maxOpenLotsTotal: 1 })
  const v = checkExposureLimits(
    { lots: 10, quantity: 350 },
    l,
    snap({ openLotsByUnderlying: { BANKNIFTY: 99 }, openLotsTotal: 99, isReducingExposure: true }),
  )
  assert.equal(v.allowed, true, 'you must always be able to close out')
})

test('total lot cap is independent of the per-underlying cap', () => {
  const l = exposure({ maxOpenLotsPerUnderlying: 100, maxOpenLotsTotal: 10 })
  const v = checkExposureLimits({ lots: 2, quantity: 70 }, l, snap({ openLotsTotal: 9 }))
  assert.equal(v.allowed === false && v.rejection.code, 'MAX_LOTS_TOTAL')
})

test('notional cap uses limitPrice when present, else the snapshot price', () => {
  const l = exposure({ maxNotionalPerOrder: 1000 })
  // limitPrice 100 * qty 35 = 3500 > 1000
  let v = checkExposureLimits({ ...ORDER, limitPrice: 100 }, l, snap({ price: 1 }))
  assert.equal(v.allowed === false && v.rejection.code, 'MAX_NOTIONAL')
  // falls back to snapshot price for MARKET
  v = checkExposureLimits(ORDER, l, snap({ price: 100 }))
  assert.equal(v.allowed === false && v.rejection.code, 'MAX_NOTIONAL')
})

test('an unpriced MARKET order is not blocked on missing price data', () => {
  const l = exposure({ maxNotionalPerOrder: 1 })
  const v = checkExposureLimits(ORDER, l, snap({ price: null }))
  assert.equal(v.allowed, true, 'lot caps already bound exposure; do not fail on absent data')
})

// --- the wired subset: `checkExposureLimits` --------------------------------
//
// These are the limits the API gates its LIVE rails on (F-28), with limits
// that are DISABLED unless the operator configured them.

test('an unconfigured limit set allows an order no sane desk would place', () => {
  const now = 1_700_000_000_000
  const v = checkExposureLimits(
    { lots: 10_000, quantity: 350_000, limitPrice: 5_000 },
    NO_EXPOSURE_LIMITS,
    snap({
      nowMs: now,
      dayLoss: 9_000_000,
      openLotsTotal: 50_000,
      openLotsByUnderlying: { BANKNIFTY: 50_000 },
      recentOrderTs: Array.from({ length: 500 }, () => now - 1_000),
    }),
  )
  assert.equal(v.allowed, true, 'shipping the gate must change nothing until it is configured')
  assert.equal(anyExposureLimitSet(NO_EXPOSURE_LIMITS), false)
})

test('a configured limit refuses an OPEN and passes the matching CLOSE', () => {
  const l = exposure({ maxOpenLotsTotal: 5 })
  const order = { lots: 3, quantity: 105 }
  const open = checkExposureLimits(order, l, snap({ openLotsTotal: 4 }))
  assert.equal(open.allowed === false && open.rejection.code, 'MAX_LOTS_TOTAL')
  assert.match(
    open.allowed === false ? open.rejection.detail : '',
    /4 \+ 3 > 5/,
    'the refusal must carry the measured value AND the limit',
  )
  const close = checkExposureLimits(order, l, snap({ openLotsTotal: 4, isReducingExposure: true }))
  assert.equal(close.allowed, true, 'you must always be able to close out')
})

test('NO limit blocks an exit — not the loss stop, the rate limit or the notional cap', () => {
  const now = 1_700_000_000_000
  const l = exposure({
    maxDailyLoss: 1,
    maxOrdersPerMinute: 1,
    maxNotionalPerOrder: 1,
    maxOpenLotsTotal: 1,
    maxOpenLotsPerUnderlying: 1,
  })
  const v = checkExposureLimits(
    { lots: 50, quantity: 1_750, limitPrice: 900 },
    l,
    snap({
      nowMs: now,
      dayLoss: 500_000,
      recentOrderTs: [now - 1, now - 2, now - 3],
      openLotsTotal: 99,
      openLotsByUnderlying: { BANKNIFTY: 99 },
      isReducingExposure: true,
    }),
  )
  assert.equal(v.allowed, true, 'a control that traps an open position is worse than no control')
})

test('the day loss stop reports the measured loss and the limit', () => {
  const v = checkExposureLimits({ lots: 1, quantity: 35 }, exposure({ maxDailyLoss: 50_000 }), snap({ dayLoss: 61_250 }))
  assert.equal(v.allowed === false && v.rejection.code, 'DAILY_LOSS')
  assert.match(v.allowed === false ? v.rejection.detail : '', /61250.*50000/)
})

// --- limits from the environment --------------------------------------------

test('an empty environment disables every limit', () => {
  const l = exposureLimitsFromEnv({})
  assert.deepEqual(l, NO_EXPOSURE_LIMITS)
  assert.equal(anyExposureLimitSet(l), false)
})

test('each variable configures exactly one limit and leaves the rest disabled', () => {
  const l = exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '75000' })
  assert.equal(l.maxDailyLoss, 75_000)
  assert.equal(l.maxOpenLotsTotal, Number.POSITIVE_INFINITY)
  assert.equal(anyExposureLimitSet(l), true)

  const all = exposureLimitsFromEnv({
    DESK_RISK_MAX_DAY_LOSS: '75000',
    DESK_RISK_MAX_TOTAL_LOTS: '60',
    DESK_RISK_MAX_UNDERLYING_LOTS: '20',
    DESK_RISK_MAX_NOTIONAL: '5000000',
    DESK_RISK_MAX_ORDERS_PER_MIN: '30',
  })
  assert.deepEqual(all, {
    maxDailyLoss: 75_000,
    maxOpenLotsTotal: 60,
    maxOpenLotsPerUnderlying: 20,
    maxNotionalPerOrder: 5_000_000,
    maxOrdersPerMinute: 30,
  })
})

test('a value that cannot be used THROWS rather than silently disabling the limit', () => {
  for (const bad of ['nonsense', '-1', '0', 'NaN', 'Infinity']) {
    assert.throws(
      () => exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: bad }),
      /DESK_RISK_MAX_DAY_LOSS/,
      `'${bad}' must fail loudly: an operator who set a limit must never get no limit`,
    )
  }
  // An EMPTY value is how a shell unsets one, and it reads as disabled — the
  // same rule `required()` and `positiveEnvMs` already hold to.
  assert.equal(exposureLimitsFromEnv({ DESK_RISK_MAX_DAY_LOSS: '  ' }).maxDailyLoss, Infinity)
})

// --- rate window ------------------------------------------------------------

test('OrderRateWindow prunes entries older than 60s', () => {
  const w = new OrderRateWindow()
  const t0 = 1_700_000_000_000
  w.record(t0)
  w.record(t0 + 1000)
  assert.equal(w.size, 2)

  // At t0+60_500 the cutoff is t0+500: the first entry has aged out, the
  // second (t0+1000) is still inside the window.
  w.prune(t0 + 60_500)
  assert.equal(w.size, 1, 'only the entry still inside the window survives')

  // Once both are older than 60s, the window empties.
  w.prune(t0 + 61_001)
  assert.equal(w.size, 0)
})

// --- a measurement that could not see the whole book -------------------------

test('a PARTIALLY measured desk refuses new exposure and names what it could not see', () => {
  const l = exposure({ maxOpenLotsTotal: 500 })
  const order = { lots: 1, quantity: 35 }
  const partial = snap({
    openLotsTotal: 2,
    openLotsByUnderlying: { BANKNIFTY: 2 },
    unmeasuredSymbols: ['SENSEX25JUL80000CE', 'SENSEX25JUL81000PE'],
  })

  const open = checkExposureLimits(order, l, partial)
  assert.equal(
    open.allowed === false && open.rejection.code,
    'UNMEASURED_EXPOSURE',
    'an under-count of what is open is not a measurement the caps may be judged on',
  )
  const detail = open.allowed === false ? open.rejection.detail : ''
  assert.match(detail, /could not be fully measured/)
  assert.match(detail, /SENSEX25JUL80000CE/, 'the refusal names the symbols, so it is actionable')
  assert.match(detail, /SENSEX25JUL81000PE/)
  assert.match(detail, /instrument master/)

  const exit = checkExposureLimits(order, l, { ...partial, isReducingExposure: true })
  assert.equal(exit.allowed, true, 'the same asymmetry as every other limit here')
})

test('an EMPTY unmeasured list is a complete measurement and changes nothing', () => {
  const l = exposure({ maxOpenLotsTotal: 5 })
  const v = checkExposureLimits({ lots: 1, quantity: 35 }, l, snap({ unmeasuredSymbols: [] }))
  assert.equal(v.allowed, true)
})

// --- the in-flight reservation ledger ----------------------------------------

test('a reservation counts against the caps until it expires', () => {
  const t0 = 1_700_000_000_000
  const ledger = new ReservationLedger(6_000)
  const base: ExposureState = {
    nowMs: t0,
    recentOrderTs: [],
    openLotsByUnderlying: { BANKNIFTY: 4 },
    openLotsTotal: 4,
    dayLoss: 0,
  }
  assert.deepEqual(ledger.applyTo(base, t0), base, 'nothing reserved, nothing added')

  ledger.reserve(10, 'BANKNIFTY', t0)
  ledger.reserve(3, 'NIFTY', t0 + 100)
  const held = ledger.applyTo(base, t0 + 200)
  assert.equal(held.openLotsTotal, 17, '4 measured + 13 in flight')
  assert.deepEqual(held.openLotsByUnderlying, { BANKNIFTY: 14, NIFTY: 3 })
  assert.equal(base.openLotsTotal, 4, 'the measurement itself is never mutated')

  // Past the TTL the fills are in the book the measurement reads, so counting
  // them twice would refuse orders the desk has room for.
  const after = ledger.applyTo(base, t0 + 6_101)
  assert.deepEqual(after.openLotsTotal, 4)
  assert.deepEqual(after.openLotsByUnderlying, { BANKNIFTY: 4 })
  assert.equal(ledger.size, 0, 'expired rows are dropped, not merely ignored')
})

test('reservations survive a measurement the cache is still serving', () => {
  const t0 = 1_700_000_000_000
  const ledger = new ReservationLedger(6_000)
  const cached: ExposureState = {
    nowMs: t0,
    recentOrderTs: [],
    openLotsByUnderlying: {},
    openLotsTotal: 40,
    dayLoss: 0,
  }
  // Three decisions inside one 2s TTL window, each admitting 10 lots against a
  // cap of 50: without the ledger all three see 40 and all three pass.
  const cap = 50
  let admitted = 0
  for (let i = 0; i < 3; i++) {
    const seen = ledger.applyTo(cached, t0 + i)
    if (seen.openLotsTotal + 10 > cap) continue
    admitted += 10
    ledger.reserve(10, 'BANKNIFTY', t0 + i)
  }
  assert.equal(admitted, 10, '40 + 10 = 50 fits exactly once, not three times')
})
