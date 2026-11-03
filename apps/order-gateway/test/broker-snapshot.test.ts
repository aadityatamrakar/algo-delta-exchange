import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowsOf, shapeOf, takeBrokerSnapshot } from '../src/broker-snapshot.ts'

const NOW = 1785400000000

test('rowsOf takes a bare array through unchanged', () => {
  assert.deepEqual(rowsOf([{ a: 1 }]), [{ a: 1 }])
})

test('rowsOf finds the list inside a wrapper, whatever it is named', () => {
  // XTS names it differently per endpoint and account type — orderList,
  // positionList, dealerpositions. Taking the first array-valued property
  // avoids enumerating names that would silently miss a new one.
  assert.deepEqual(rowsOf({ orderList: [{ id: 1 }] }), [{ id: 1 }])
  assert.deepEqual(rowsOf({ positionList: [{ id: 2 }] }), [{ id: 2 }])
  assert.deepEqual(rowsOf({ somethingNew: [{ id: 3 }] }), [{ id: 3 }])
})

test('rowsOf yields an empty list rather than inventing rows', () => {
  for (const bad of [null, undefined, 42, 'x', {}]) {
    assert.deepEqual(rowsOf(bad), [], `input ${String(bad)}`)
  }
})

test('a healthy snapshot carries both lists and reads ok', async () => {
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: { orderList: [{ AppOrderID: 1240043411 }] } }),
      getTradeBook: async () => ({ result: [{ AppOrderID: 1240043411, TradedQty: 750 }] }),
      getPosition: async () => ({ result: [{ TradingSymbol: 'BAJFINANCE26AUG1150CE' }] }),
    },
    NOW,
  )
  assert.equal(snap.ok, true)
  assert.equal(snap.error, '')
  assert.equal(snap.asOf, NOW)
  assert.equal(snap.orders.length, 1)
  assert.equal(snap.positions.length, 1)
  assert.equal(snap.trades.length, 1)
})

test('IT NEVER THROWS: a broker that is down yields ok:false with the reason', async () => {
  // The poll loop must survive an unreachable broker. A snapshot that threw
  // would take the loop down and freeze the dashboard on stale data with no
  // indication anything was wrong.
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => {
        throw new Error('ECONNREFUSED')
      },
      getPosition: async () => {
        throw new Error('ECONNREFUSED')
      },
    },
    NOW,
  )
  assert.equal(snap.ok, false)
  assert.match(snap.error, /orders: ECONNREFUSED/)
  assert.match(snap.error, /positions: ECONNREFUSED/)
  assert.deepEqual(snap.orders, [])
})

test('one endpoint failing does not discard the other', async () => {
  // Positions are still worth showing when the order book call fails, as long
  // as the failure is stated.
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => {
        throw new Error('token expired')
      },
      getPosition: async () => ({ result: [{ TradingSymbol: 'X' }] }),
    },
    NOW,
  )
  assert.equal(snap.ok, false)
  assert.equal(snap.positions.length, 1)
  assert.match(snap.error, /orders: token expired/)
  assert.doesNotMatch(snap.error, /positions:/)
})

test("an XTS error payload counts as a failure even when the call resolved", async () => {
  // XTS answers 200 with {error:{message}}; treating that as success would
  // report an empty order book as though the broker held nothing.
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ error: { message: 'Invalid session' } }),
      getPosition: async () => ({ result: [] }),
    },
    NOW,
  )
  assert.equal(snap.ok, false)
  assert.match(snap.error, /Invalid session/)
})

test('an adapter without the methods says so rather than reporting empty', async () => {
  const snap = await takeBrokerSnapshot({}, NOW)
  assert.equal(snap.ok, false)
  assert.match(snap.error, /no getOrderBook/)
  assert.match(snap.error, /no getTradeBook/)
  assert.match(snap.error, /no getPosition/)
})

// --------------------------------------------- telling empty from unparsed

test('shapeOf describes a payload without copying its values', () => {
  assert.equal(shapeOf([]), 'array(0)')
  assert.equal(shapeOf([1, 2]), 'array(2)')
  assert.equal(shapeOf(null), 'null')
  assert.equal(shapeOf(undefined), 'undefined')
  assert.equal(shapeOf({}), 'object{}')
  assert.equal(shapeOf('x'), 'string')
})

test('shapeOf describes the LIST IT FOUND, not the envelope around it', () => {
  // XTS wraps positions as {positionList: []}. Reporting the wrapper made a
  // genuinely empty list look unreadable and fired a false alarm on the one
  // screen whose warnings have to stay trustworthy. Measured on prod.
  assert.equal(shapeOf({ positionList: [] }), 'array(0) in positionList')
  assert.equal(shapeOf({ orderList: [1, 2] }), 'array(2) in orderList')
  // Only when NO list is present anywhere does it report the object itself.
  assert.equal(shapeOf({ message: 'ClientID cannot be empty' }), 'object{message}')
})

test('a GENUINELY empty book records the shape that proves it was read', async () => {
  // `array(0)` says the broker answered with a real, empty list.
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: [] }),
      getTradeBook: async () => ({ result: [] }),
      getPosition: async () => ({ result: [] }),
    },
    NOW,
  )
  assert.equal(snap.ok, true)
  assert.equal(snap.emptyDiagnostic?.orders, 'array(0)')
  assert.equal(snap.emptyDiagnostic?.trades, 'array(0)')
})

test('an UNREADABLE reply is distinguishable from an empty one', async () => {
  // THE DISTINCTION THAT MATTERS. Both produce orders: [], and the codebase
  // documents that mistaking one for the other is how a live order is
  // reconciled away as "nothing happened".
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: { message: 'ClientID cannot be empty' } }),
      getPosition: async () => ({ result: [] }),
    },
    NOW,
  )
  assert.deepEqual(snap.orders, [])
  assert.equal(snap.emptyDiagnostic?.orders, 'object{message}')
  assert.ok(!snap.emptyDiagnostic?.orders?.startsWith('array('))
})

test('a wrapped-but-empty list reads as read, not as unreadable', async () => {
  // The false alarm this fixes: positions came back {positionList: []}, which
  // is the broker correctly saying "no open positions".
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: [] }),
      getTradeBook: async () => ({ result: { tradeList: [] } }),
      getPosition: async () => ({ result: { positionList: [] } }),
    },
    NOW,
  )
  assert.equal(snap.ok, true)
  assert.ok(snap.emptyDiagnostic?.positions?.startsWith('array('))
})

// ------------------------------------------- why it failed, and when it failed

/** Tue 2026-07-28, 11:00 IST — inside the session. */
const IN_SESSION = new Date('2026-07-28T11:00:00+05:30').getTime()
/** Sat 2026-08-01, 11:00 IST — the market is shut, so nothing can be wrong. */
const WEEKEND = new Date('2026-08-01T11:00:00+05:30').getTime()

test('a FAILED snapshot records which family the error is and whether the market was open', async () => {
  /**
   * The doc is the only thing the dashboard ever sees — the gateway classifies
   * the error to decide whether to re-login, and until now threw that answer
   * away. A screen reading the snapshot then had no way to tell "the token died
   * over the weekend" from "orders are failing right now", so it said the
   * loudest thing for both.
   */
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ error: { message: 'Invalid Token' } }),
      getTradeBook: async () => ({ error: { message: 'Invalid Token' } }),
      getPosition: async () => ({ error: { message: 'Invalid Token' } }),
    },
    WEEKEND,
  )
  assert.equal(snap.ok, false)
  assert.equal(snap.errorClass, 'session')
  assert.equal(snap.sessionOpenAtSnapshot, false)
})

test('the session flag is judged AT THE SNAPSHOT, never at read time', async () => {
  // A snapshot taken at 11:00 on a Tuesday stays a mid-session failure however
  // long it sits in Mongo — read back at midnight it must not soften into
  // "market closed", because the orders it could not see were live orders.
  const snap = await takeBrokerSnapshot(
    { getOrderBook: async () => ({ error: { message: 'Invalid Token' } }) },
    IN_SESSION,
  )
  assert.equal(snap.sessionOpenAtSnapshot, true)
})

test('a genuine rejection is stamped fatal, not softened', async () => {
  const snap = await takeBrokerSnapshot(
    { getOrderBook: async () => ({ error: { message: 'ClientID cannot be empty.' } }) },
    WEEKEND,
  )
  assert.equal(snap.errorClass, 'fatal')
})

test('a HEALTHY snapshot carries neither field — there is nothing to explain', async () => {
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: [] }),
      getTradeBook: async () => ({ result: [] }),
      getPosition: async () => ({ result: [] }),
    },
    WEEKEND,
  )
  assert.equal(snap.ok, true)
  assert.equal(snap.errorClass, undefined)
  assert.equal(snap.sessionOpenAtSnapshot, undefined)
})

test('no diagnostic is attached when both lists have rows', async () => {
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: [{ AppOrderID: 1 }] }),
      getTradeBook: async () => ({ result: [{ AppOrderID: 1 }] }),
      getPosition: async () => ({ result: [{ TradingSymbol: 'X' }] }),
    },
    NOW,
  )
  assert.equal(snap.emptyDiagnostic, undefined)
})

test('funds ride the snapshot verbatim and never gate ok', async () => {
  // The balance subtree's schema varies by XTS build, so it is stored as sent
  // for desk-api to dig by key name — never parsed or reshaped here.
  const balance = {
    BalanceList: [{ limitObject: { RMSSubLimits: { marginUtilized: '4,86,350.00', netMarginAvailable: '2,83,900.00' } } }],
  }
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: [] }),
      getTradeBook: async () => ({ result: [] }),
      getPosition: async () => ({ result: [] }),
      getBalance: async () => ({ result: balance }),
    },
    NOW,
  )
  assert.equal(snap.ok, true)
  assert.deepEqual(snap.funds, balance)
  assert.equal(snap.fundsDiagnostic, '')
})

test('a failed balance is a diagnosis, not a failed snapshot', async () => {
  // Margin is advisory; reconciliation is not. A dealer account with no
  // balance endpoint must not redden the one page that exists to be believed.
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: [] }),
      getTradeBook: async () => ({ result: [] }),
      getPosition: async () => ({ result: [] }),
      getBalance: async () => ({ error: { message: 'Data Not Available' } }),
    },
    NOW,
  )
  assert.equal(snap.ok, true)
  assert.equal(snap.error, '')
  assert.equal(snap.funds, null)
  assert.equal(snap.fundsDiagnostic, 'empty (Data Not Available)')
})

test('a balance call that throws leaves the books intact', async () => {
  const snap = await takeBrokerSnapshot(
    {
      getOrderBook: async () => ({ result: [{ AppOrderID: 1 }] }),
      getTradeBook: async () => ({ result: [] }),
      getPosition: async () => ({ result: [] }),
      getBalance: async () => {
        throw new Error('ECONNREFUSED')
      },
    },
    NOW,
  )
  assert.equal(snap.ok, true)
  assert.equal(snap.orders.length, 1)
  assert.equal(snap.funds, null)
  assert.equal(snap.fundsDiagnostic, 'ECONNREFUSED')
})

test('an adapter without getBalance reports it in the diagnostic, never in error', async () => {
  const snap = await takeBrokerSnapshot({}, NOW)
  assert.equal(snap.funds, null)
  assert.match(snap.fundsDiagnostic, /no getBalance/)
  assert.doesNotMatch(snap.error, /getBalance/)
})
