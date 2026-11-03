import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chaseDialsFromEnv,
  chaseDisabled,
  chasePrice,
  createOrderChaser,
} from '../src/order-chaser.ts'
// The fakes live beside the peg suite's — see `chaser-harness.ts` for why one
// set of ports is shared rather than copied.
import {
  BOOTED,
  DWELL,
  FakeOrders,
  FakeReads,
  NOW,
  SYMBOL,
  harness,
  orderDoc,
} from './chaser-harness.ts'

/**
 * The chaser is the one component allowed to ACT on a resting order, so what
 * these assert is mostly restraint: never a MARKET doc, never against a
 * pending cancel, never past the attempt ladder, never faster than one rung
 * per dwell, never an order older than the process, and never an attempt
 * counted that the broker did not accept.
 */

// ---------------------------------------------------------- price arithmetic

test('chasePrice: the step is max(pct, ticks) and escalates linearly with k', () => {
  const cfg = { stepPct: 0.03, minTicks: 2, tickSize: 0.05 }
  // 3% of 100 is 3, far above the 0.1 tick floor.
  assert.equal(chasePrice('SELL', 100, 1, cfg), 97)
  assert.equal(chasePrice('SELL', 100, 2, cfg), 94)
  assert.equal(chasePrice('BUY', 100, 3, cfg), 109)
  // 3% of 1.50 is 0.045 — UNDER one tick. The floor is what still crosses.
  assert.equal(chasePrice('SELL', 1.5, 1, cfg), 1.4)
  assert.equal(chasePrice('BUY', 1.5, 1, cfg), 1.6)
})

test('chasePrice: rounding is directional — sell floor, buy ceil, never to-nearest', () => {
  // 9% of 1.50 is 0.135: sell 1.365 -> 1.35 (down), buy 1.635 -> 1.65 (up).
  const cfg = { stepPct: 0.09, minTicks: 2, tickSize: 0.05 }
  assert.equal(chasePrice('SELL', 1.5, 1, cfg), 1.35)
  assert.equal(chasePrice('BUY', 1.5, 1, cfg), 1.65)
})

test('chasePrice: a sell that crosses past zero clamps to one tick', () => {
  // Two-tick step off a one-tick option: raw 0.00 would be rejected outright.
  assert.equal(chasePrice('SELL', 0.1, 1, { stepPct: 0.03, minTicks: 2, tickSize: 0.05 }), 0.05)
})

test('chasePrice: the float product is re-rounded onto the paisa grid', () => {
  // 147 * 0.05 is 7.3500000000000005 in binary floating point.
  assert.equal(chasePrice('SELL', 7.4, 1, { stepPct: 0, minTicks: 1, tickSize: 0.05 }), 7.35)
})

test('chasePrice: refuses an unusable limit or attempt rather than inventing a price', () => {
  const cfg = { stepPct: 0.03, minTicks: 2, tickSize: 0.05 }
  assert.equal(chasePrice('SELL', NaN, 1, cfg), null)
  assert.equal(chasePrice('SELL', 0, 1, cfg), null)
  assert.equal(chasePrice('SELL', 100, 0, cfg), null)
  assert.equal(chasePrice('SELL', 100, 1.5, cfg), null)
})

// ------------------------------------------------------------ what is chased

test('a young order is left alone — and so is one with no placedAt at all', async () => {
  const h = harness({
    docs: [
      orderDoc({ placedAt: NOW - 5_000 }),
      // A legacy doc without the stamp is not "infinitely old".
      orderDoc({ clientOrderId: 'ord-2', placedAt: undefined }),
    ],
  })
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined)
})

test('an order placed before this process booted is never chased, however old it is', async () => {
  // THE DEPLOY HAZARD. A pre-deploy doc cannot carry the `resting` flag —
  // nothing stamped it — so a target exit and a mispriced marketable look
  // identical, and arming the chaser would drag the whole standing book to the
  // touch seconds after a mid-session restart. Old orders keep the alert-only
  // behaviour; the sweep's WORKING alert still names them.
  const h = harness({
    docs: [
      orderDoc({ clientOrderId: 'ord-old', placedAt: BOOTED - 1 }),
      orderDoc({ clientOrderId: 'ord-new', brokerOrderIds: ['988'] }),
    ],
  })
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '988', price: 97 }])
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined, 'the pre-boot doc is untouched')
  assert.deepEqual(h.events.map((e) => e.clientOrderId), ['ord-new'])

  // And it stays untouched no matter how long the process runs.
  h.clock.now = NOW + 86_400_000
  await h.run()
  assert.ok(!h.modifies.some((m) => m.brokerOrderId === '987'))
})

test('a pre-boot doc with a spent ladder is not even alerted on — the boot gate precedes everything', async () => {
  const h = harness({ docs: [orderDoc({ placedAt: BOOTED - 1, chaseAttempts: 3 })] })
  await h.run()
  assert.deepEqual(h.events, [])
  assert.equal(h.orders.docs[0]?.['chaseExhaustedAt'], undefined)
})

test('a resting SELL limit is repriced through the touch, escalating off the ORIGINAL limit', async () => {
  const h = harness({ docs: [orderDoc()] })
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 97 }])
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], 1)
  assert.equal(h.orders.docs[0]?.['chasedAt'], NOW)
  assert.equal(h.orders.docs[0]?.['lastChasePrice'], 97)
  // A quiet STATUS line, ok:true — progress, not an incident.
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0]?.phase, 'STATUS')
  assert.equal(h.events[0]?.ok, true)
  assert.match(String(h.events[0]?.detail?.['note']), /chase 1\/3: repriced to 97/)

  // Attempt 2 prices from the ORIGINAL 100, not from 97: 100 - 2x3 = 94 — and
  // only once rung 1 has had its own full dwell to fill in.
  h.clock.now = NOW + DWELL + 1
  await h.run()
  assert.deepEqual(h.modifies[1], { brokerOrderId: '987', price: 94 })
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], 2)
  assert.equal(h.orders.docs[0]?.['chasedAt'], NOW + DWELL + 1, 'the dwell restarts from here')
})

test('each rung gets its own full dwell — a pass inside it climbs nothing', async () => {
  // The timer ticks every ~5s; the dwell is 15s. Gating on placedAt alone put a
  // rung on the wire at t+15s, t+20s and t+25s — a market order paid for in
  // three instalments, not a chase.
  const h = harness({ docs: [orderDoc()] })
  await h.run()
  assert.equal(h.modifies.length, 1)

  h.clock.now = NOW + 5_000
  await h.run()
  h.clock.now = NOW + 10_000
  await h.run()
  h.clock.now = NOW + DWELL // the boundary itself is still inside the dwell
  await h.run()
  assert.equal(h.modifies.length, 1, 'no second rung until rung 1 has had its dwell')
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], 1)
  assert.equal(h.events.length, 1)

  h.clock.now = NOW + DWELL + 1
  await h.run()
  assert.deepEqual(h.modifies[1], { brokerOrderId: '987', price: 94 })
})

test('a garbled chasedAt falls back to the placement time, never to an instant chase', async () => {
  // Every comparison against NaN is false, so a NaN dwell would read as
  // "elapsed" and fire a rung on every tick — the defect, wearing a disguise.
  const h = harness({ docs: [orderDoc({ chaseAttempts: 1, chasedAt: 'nonsense' })] })
  h.clock.now = NOW - 60_000 + 5_000 // 5s after placement: inside the dwell
  await h.run()
  assert.deepEqual(h.modifies, [])

  h.clock.now = NOW
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 94 }])
})

test('a resting BUY limit is repriced UP, with the tick floor doing the work on a cheap contract', async () => {
  // 3% of 1.50 rounds away to nothing; two ticks is what actually crosses.
  const h = harness({
    docs: [orderDoc({ transaction_type: 'BUY', limitPrice: 1.5 })],
  })
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 1.6 }])
})

test('a DELIBERATELY resting order is never chased — the operator chose that price', async () => {
  // `resting: true` is stamped by the api rail from the submit body; chasing it
  // would drag the operator's target price to the touch.
  const h = harness({ docs: [orderDoc({ resting: true })] })
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
})

test('a MARKET doc and an unpriced LIMIT are never chased — nothing honest to escalate from', async () => {
  const h = harness({
    docs: [
      orderDoc({ order_type: 'MARKET', limitPrice: undefined }),
      orderDoc({ clientOrderId: 'ord-2', limitPrice: undefined }),
      orderDoc({ clientOrderId: 'ord-3', transaction_type: 'XYZ' }),
    ],
  })
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
})

test('a tranche our own fills already call terminal (or CANCELLING) is not repriced', async () => {
  const h = harness({
    docs: [orderDoc({ brokerOrderIds: ['987', '988', '989'] })],
    fillRows: [
      { brokerOrderId: '987', status: 'FILLED' },
      { brokerOrderId: '989', status: 'CANCELLING' },
      // An out-of-order replay after the terminal row must not resurrect it.
      { brokerOrderId: '987', status: 'WORKING' },
    ],
  })
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '988', price: 97 }])
})

// --------------------------------------------------------------- cancel wins

test('a pending cancel for any of the doc’s broker ids suppresses the chase entirely', async () => {
  const h = harness({
    docs: [orderDoc({ brokerOrderIds: ['987', '988'] })],
    cancels: [{ _id: '988', status: 'pending' }],
  })
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
  assert.ok(h.logs.some((l) => l.includes('cancel wins')))
})

test('a finished cancel does not — only status pending speaks for the human', async () => {
  const h = harness({
    docs: [orderDoc()],
    cancels: [{ _id: '987', status: 'done' }],
  })
  await h.run()
  assert.equal(h.modifies.length, 1)
})

// ------------------------------------------------------------ attempt ladder

test('the attempt counter advances ONLY on a modify the broker accepted', async () => {
  let answer: 'false' | 'throw' | 'true' = 'false'
  const h = harness({
    docs: [orderDoc()],
    modifyResult: () => {
      if (answer === 'throw') throw new Error('request timed out after 15000ms')
      return answer === 'true'
    },
  })

  // Refused: retried next tick at the SAME rung, nothing journalled.
  await h.run()
  assert.equal(h.modifies.length, 1)
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined)
  assert.deepEqual(h.events, [])

  // Threw: same — a transport fault is not an attempt the exchange saw.
  answer = 'throw'
  await h.run()
  assert.equal(h.modifies.length, 2)
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined)
  assert.ok(h.logs.some((l) => l.includes('chase modify threw')))

  // Accepted: the counter moves, and it is STILL rung 1's price.
  answer = 'true'
  await h.run()
  assert.equal(h.modifies[2]?.price, 97)
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], 1)
})

test('exhaustion journals ONE loud event naming symbol, attempts and the accepted reprice — and never re-fires', async () => {
  const h = harness({ docs: [orderDoc()], maxAttempts: 2 })
  await h.run() // attempt 1 -> 97
  h.clock.now = NOW + DWELL + 1
  await h.run() // attempt 2 -> 94
  assert.equal(h.modifies.length, 2)

  // The last rung gets its dwell too: the order is only declared stuck after
  // the final price has had the same chance to fill as every other one.
  const exhaustedAt = NOW + 2 * (DWELL + 1)
  h.clock.now = exhaustedAt
  await h.run() // ladder spent: hand it to a human
  assert.equal(h.modifies.length, 2, 'no further modify after the ladder is spent')
  const loud = h.events.filter((e) => e.ok === false)
  assert.equal(loud.length, 1)
  assert.equal(loud[0]?.phase, 'STATUS')
  assert.match(String(loud[0]?.error), /still resting after 2 reprices/)
  assert.ok(String(loud[0]?.error).includes(SYMBOL))
  // The wording is precise about WHAT 94 is: the last price the broker took,
  // doc-wide. A tranche refused on every pass still rests at the original 100.
  assert.match(String(loud[0]?.error), /last accepted reprice 94/)
  assert.match(String(loud[0]?.error), /cancel it from the Broker page/)
  assert.equal(h.notified.length, 1)
  assert.equal(h.orders.docs[0]?.['chaseExhaustedAt'], exhaustedAt)

  h.clock.now = exhaustedAt + 60_000
  await h.run()
  assert.equal(h.events.filter((e) => e.ok === false).length, 1, 'stamped once, silent after')
})

test('a doc whose every tranche is already terminal exhausts SILENTLY — liveness is asked first', async () => {
  // The ladder is spent, but our own fills say nothing is resting there. The
  // loud alert would send a human to the Broker page to cancel an order that
  // no longer exists; the fill watcher settles the doc on its own.
  const h = harness({
    docs: [orderDoc({ chaseAttempts: 3 })],
    fillRows: [{ brokerOrderId: '987', status: 'FILLED' }],
  })
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
  assert.deepEqual(h.notified, [])
  assert.equal(h.orders.docs[0]?.['chaseExhaustedAt'], undefined, 'no stamp, nothing to hand over')
})

test('a terminal fill row from an older placement under a recycled broker id does not retire the tranche', async () => {
  // XTS reuses AppOrderIDs across sessions. A FILLED row two days old under
  // this doc's id belongs to whatever traded under the id back then, not to
  // the order resting now — reading it as "done" would leave a live resting
  // order unchased and un-alerted (F6). Rows without a `ts`, as every other
  // fixture here, are still taken at their word.
  const h = harness({
    docs: [orderDoc()],
    fillRows: [{ brokerOrderId: '987', status: 'FILLED', ts: NOW - 2 * 86_400_000 }],
  })
  await h.run()
  assert.equal(h.modifies.length, 1, 'the tranche is still live: a reprice goes out')
})

test("an earlier slice's FILLED row, older than the re-stamped placedAt but of THIS placement, still retires its broker id", async () => {
  // `markPlaced` re-stamps `placedAt = now()` on EVERY appended slice, and
  // gated slices are minutes apart by design. Anchoring the recycled-id skew on
  // `placedAt` therefore threw away the first slice's own FILLED row once the
  // second slice landed more than a minute later — and the chaser sent a
  // modify against a completed order on every rung (`modify REFUSED by
  // broker`). `createdAt` is written once, before any slice, so it is the
  // anchor that names the whole placement; `placedAt` stays the fallback for
  // a document without one.
  const h = harness({
    docs: [
      orderDoc({
        createdAt: NOW - 600_000,
        placedAt: NOW - 60_000,
        brokerOrderIds: ['987', '988'],
        trancheIds: ['ord-1.1', 'ord-1.2'],
      }),
    ],
    fillRows: [{ brokerOrderId: '987', status: 'FILLED', ts: NOW - 300_000 }],
  })
  await h.run()
  assert.deepEqual(
    h.modifies.map((m) => m.brokerOrderId),
    ['988'],
    'the filled first slice is left alone; only the resting second slice is repriced',
  )
})

test('with no createdAt at all, placedAt is still the skew anchor — a legacy document keeps the F6 guard', async () => {
  const h = harness({
    docs: [orderDoc({ createdAt: undefined })],
    fillRows: [{ brokerOrderId: '987', status: 'FILLED', ts: NOW - 2 * 86_400_000 }],
  })
  await h.run()
  assert.equal(h.modifies.length, 1, 'the two-day-old row is not this placement’s')
})

test('a spent ladder on a doc that IS still live does alert — the liveness gate is not a mute button', async () => {
  const h = harness({
    docs: [orderDoc({ chaseAttempts: 3 })],
    fillRows: [{ brokerOrderId: '987', status: 'WORKING' }],
  })
  await h.run()
  assert.equal(h.events.filter((e) => e.ok === false).length, 1)
})

// ---------------------------------------------------------------- the gates

test('the disabled flag stops a pass cold — checked per pass, not only at wiring', async () => {
  let off = true
  const h = harness({ docs: [orderDoc()], disabled: () => off })
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])

  off = false
  await h.run()
  assert.equal(h.modifies.length, 1)
})

test('an adapter without atomic modify gets no chaser at all', async () => {
  const h = harness({ docs: [orderDoc()], canModify: false })
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
})

test('chaseDisabled fails toward OFF for any set value that is not an explicit 0/false', () => {
  assert.equal(chaseDisabled({}), false)
  assert.equal(chaseDisabled({ DESK_CHASE_DISABLED: '' }), false)
  assert.equal(chaseDisabled({ DESK_CHASE_DISABLED: '0' }), false)
  assert.equal(chaseDisabled({ DESK_CHASE_DISABLED: 'false' }), false)
  assert.equal(chaseDisabled({ DESK_CHASE_DISABLED: '1' }), true)
  assert.equal(chaseDisabled({ DESK_CHASE_DISABLED: 'yes' }), true)
})

test('the env dials refuse NaN and out-of-range values rather than propagating them', () => {
  assert.deepEqual(chaseDialsFromEnv({}), {
    chaseAfterMs: 15_000,
    stepPct: 0.03,
    minTicks: 2,
    maxAttempts: 3,
    pegDwellMs: 1_000,
  })
  assert.deepEqual(
    chaseDialsFromEnv({
      DESK_CHASE_AFTER_MS: '15s', // NaN
      DESK_CHASE_STEP_PCT: '-0.5', // would walk AWAY from the touch
      DESK_CHASE_MIN_TICKS: '4',
      DESK_CHASE_MAX_ATTEMPTS: '2.9', // floored to a whole ladder rung
      // Zero would send a modify per pass for as long as the touch jitters.
      DESK_PEG_DWELL_MS: '0',
    }),
    { chaseAfterMs: 15_000, stepPct: 0.03, minTicks: 4, maxAttempts: 2, pegDwellMs: 1_000 },
  )
  assert.equal(chaseDialsFromEnv({ DESK_PEG_DWELL_MS: '250' }).pegDwellMs, 250)
})

// -------------------------------------------------------------- robustness

test('a Mongo read that throws does not reject the pass', async () => {
  const h = harness({
    ordersFind: () => {
      throw new Error('topology was destroyed')
    },
  })
  await h.run()
  assert.ok(h.logs.some((l) => l.includes('FAILED')))
})

test('one bad document does not stop the pass', async () => {
  // The first doc's modify throws (that rung is retried later); the second
  // doc must still be chased on the same pass.
  let first = true
  const h = harness({
    docs: [orderDoc(), orderDoc({ clientOrderId: 'ord-2', brokerOrderIds: ['988'] })],
    modifyResult: (id) => {
      if (id === '987' && first) {
        first = false
        throw new Error('boom')
      }
      return true
    },
  })
  await h.run()
  assert.ok(h.modifies.some((m) => m.brokerOrderId === '988'))
  assert.equal(h.orders.docs[1]?.['chaseAttempts'], 1)
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined)
})

test('overlapping runs are single-flighted', async () => {
  let release = (): void => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const blocked = createBlockedHarness(gate)
  const first = blocked.run()
  const second = blocked.run()
  release()
  await Promise.all([first, second])
  assert.equal(blocked.modifies.length, 1, 'the second run returned without a pass of its own')
})

function createBlockedHarness(gate: Promise<void>): { run: () => Promise<void>; modifies: number[] } {
  const orders = new FakeOrders()
  orders.docs.push(orderDoc())
  const modifies: number[] = []
  // Same boot-then-wind-forward shape as `harness`: built at BOOTED so the
  // fixture doc counts as post-deploy, read at NOW once the pass runs.
  const clock = { now: BOOTED }
  const chaser = createOrderChaser(
    {
      adapter: {
        capabilities: { orders: true, marketData: false, modify: true },
        modifyOrder: async () => {
          modifies.push(1)
          await gate
          return true
        },
      },
      orders,
      cancels: new FakeReads([]),
      fills: new FakeReads([]),
      journal: { record: async () => {} },
      now: () => clock.now,
      log: () => {},
    },
    { chaseAfterMs: DWELL, stepPct: 0.03, minTicks: 2, maxAttempts: 3 },
  )
  clock.now = NOW
  return { run: () => chaser.run(), modifies }
}


// ------------------------------------------------------------- rail scoping

/**
 * ONE CHASER PER RAIL (D14, plan Task 18).
 *
 * `desk-gateway-orders` carries paper documents as well as live ones since the
 * engine's paper lifecycle landed, and a chase is a `modifyOrder` against a
 * BROKER ORDER ID. A paper order's id (`sim-3`) means nothing to XTS and a live
 * order's means nothing to the simulator, so the gateway arms one chaser per
 * rail and scopes each by `ordersFilter`.
 *
 * The consequence of getting this wrong is not a failed modify: an id that
 * happens to exist at the real broker is somebody else's live order.
 */
test('a LIVE-scoped chaser never touches a paper document', async () => {
  const h = harness({
    ordersFilter: { mode: { $ne: 'paper' } },
    docs: [orderDoc({ clientOrderId: 'paper-1', mode: 'paper', brokerOrderIds: ['sim-1'] })],
  })
  await h.run()
  assert.deepEqual(h.modifies, [], 'a simulated order is not the live adapter\u2019s to reprice')
})

test('a LIVE-scoped chaser still works a document with NO mode at all', async () => {
  // Every live order this desk has written carries no mode. `$ne` matches a
  // missing field in Mongo, and a filter that excluded them would silently
  // switch the chaser off for the entire existing book.
  const h = harness({ ordersFilter: { mode: { $ne: 'paper' } }, docs: [orderDoc()] })
  await h.run()
  assert.equal(h.modifies.length, 1)
})

test('a PAPER-scoped chaser works paper documents and nothing else', async () => {
  const h = harness({
    ordersFilter: { mode: 'paper' },
    docs: [
      orderDoc({ clientOrderId: 'live-1' }),
      orderDoc({ clientOrderId: 'paper-1', mode: 'paper', brokerOrderIds: ['sim-1'] }),
    ],
  })
  await h.run()
  assert.deepEqual(
    h.modifies.map((m) => m.brokerOrderId),
    ['sim-1'],
  )
})

test('with NO filter every PLACED document is chased — simulate mode, unchanged', async () => {
  // The one-adapter deployment arms a single chaser with no scope, which is
  // exactly what this component has always done.
  const h = harness({ docs: [orderDoc({ mode: 'paper', brokerOrderIds: ['sim-1'] })] })
  await h.run()
  assert.equal(h.modifies.length, 1)
})
