import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeCollection } from './mongo-harness.ts'
import {
  OrderQueue,
  createSweeper,
  haltsQueuedOrder,
  isStaleOrder,
  refusesStaleOrder,
  shouldSweep,
  CLAIM_TIMEOUT_MS,
  DEFAULT_ORDER_MAX_AGE_MS,
  type QueueCollection,
} from '../src/queue.ts'

/**
 * The fake now lives in `./mongo-harness.ts`, unchanged, so the tranche-gating
 * suite races the same atomicity model this one does. It models the ONE
 * property the claim depends on:
 * `findOneAndUpdate` is a single atomic server-side operation, while `find` and
 * `updateOne` are two separate round trips with everything else in the world
 * happening in between.
 *
 * The previous fake did not. Its `findOneAndUpdate` was a synchronous
 * find-then-`Object.assign`, and both `claimNext()` calls in the exclusivity
 * test ran strictly one after the other — so rewriting `queue.ts` as a
 * non-atomic find-then-update left the suite green while two gateways would
 * place every order twice. Here the non-atomic path yields (`await tick()`)
 * exactly where a real round trip would, so a concurrent claim overtakes it.
 */
function setup(workerId = 'w1', now = () => 1_000_000): { q: OrderQueue; c: FakeCollection } {
  const c = new FakeCollection()
  return { q: new OrderQueue({ collection: c, workerId, now }), c }
}

const order = (id: string, state = 'PENDING', extra: Record<string, unknown> = {}) => ({
  clientOrderId: id,
  state,
  createdAt: 1,
  tradingsymbol: 'BHEL26AUG420CE',
  quantity: 13125,
  ...extra,
})

test('claimNext takes a PENDING order and marks it CLAIMED', async () => {
  const { q, c } = setup()
  c.docs.push(order('o1'))
  const claimed = await q.claimNext()
  assert.equal(claimed?.['clientOrderId'], 'o1')
  assert.equal(c.docs[0]?.['state'], 'CLAIMED')
  assert.equal(c.docs[0]?.['claimedBy'], 'w1')
})

test('an empty queue returns null rather than blocking', async () => {
  const { q } = setup()
  assert.equal(await q.claimNext(), null)
})

test('two gateways racing CONCURRENTLY cannot both claim one order', async () => {
  // A careless deploy running two instances must not place every order twice.
  // The two claims are issued together and resolved by the fake's atomicity —
  // sequential awaits would pass even against a find-then-update rewrite.
  const c = new FakeCollection()
  c.docs.push(order('o1'))
  const now = () => 1_000_000
  const a = new OrderQueue({ collection: c, workerId: 'A', now })
  const b = new OrderQueue({ collection: c, workerId: 'B', now })

  const [first, second] = await Promise.all([a.claimNext(), b.claimNext()])
  const winners = [first, second].filter((r) => r !== null)
  assert.equal(winners.length, 1, 'exactly one gateway may win the claim')
  assert.equal(winners[0]?.['clientOrderId'], 'o1')
  assert.equal(c.docs[0]?.['state'], 'CLAIMED')
})

test('the claim is ONE atomic operation, not a read followed by a write', async () => {
  // The property the test above depends on, asserted directly: a find-then-
  // updateOne implementation has a window between the two in which another
  // gateway claims the same document.
  const { q, c } = setup()
  c.docs.push(order('o1'))
  await q.claimNext()
  assert.deepEqual(c.ops, ['findOneAndUpdate'])
})

test('ten gateways racing for three orders claim each exactly once', async () => {
  const c = new FakeCollection()
  c.docs.push(order('o1'), order('o2'), order('o3'))
  const queues = Array.from(
    { length: 10 },
    (_, i) => new OrderQueue({ collection: c, workerId: `w${i}`, now: () => 1_000_000 }),
  )
  const claimed = (await Promise.all(queues.map((q) => q.claimNext()))).filter((d) => d !== null)
  const ids = claimed.map((d) => String(d?.['clientOrderId']))
  assert.equal(ids.length, 3, 'three orders, three winners')
  assert.equal(new Set(ids).size, 3, 'no order may be claimed twice')
})

test('orders are picked up OLDEST FIRST', async () => {
  // The queue passes `{sort:{createdAt:1}}`; a fake that ignored it left FIFO
  // pickup completely untested, and a stop-loss written second must not sit
  // behind an entry written first only because Mongo returned it in that order.
  const { q, c } = setup()
  c.docs.push(order('newer', 'PENDING', { createdAt: 200 }), order('older', 'PENDING', { createdAt: 100 }))
  assert.equal((await q.claimNext())?.['clientOrderId'], 'older')
  assert.equal((await q.claimNext())?.['clientOrderId'], 'newer')
})

test('an already-CLAIMED order is not re-claimed while fresh', async () => {
  const { q, c } = setup('w1', () => 1_000_000)
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'other', claimedAt: 999_000 }))
  assert.equal(await q.claimNext(), null)
})

test('a STUCK claim is reclaimed after the timeout', async () => {
  // A gateway that dies mid-placement would otherwise leave the order claimed
  // forever, and it silently never goes out.
  const now = 2_000_000
  const { q, c } = setup('w2', () => now)
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'dead', claimedAt: now - CLAIM_TIMEOUT_MS - 1 }))
  const claimed = await q.claimNext()
  assert.equal(claimed?.['clientOrderId'], 'o1')
  assert.equal(c.docs[0]?.['claimedBy'], 'w2')
})

test('a driver-4 findOneAndUpdate, which returns the DOCUMENT, is unwrapped too', async () => {
  // The pin is 3.7.3, whose driver wraps the result in `{value}`. The unwrap
  // handles both shapes and this branch had no coverage at all — an upgrade
  // would have made `claimNext` return a document-shaped object that then
  // failed on `clientOrderId` reads deep inside `processOne`.
  const doc = order('o1')
  const driver4: QueueCollection = {
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    findOne: async () => null,
    findOneAndUpdate: async () => doc,
    updateOne: async () => undefined,
    createIndex: async () => undefined,
  }
  const q = new OrderQueue({ collection: driver4, workerId: 'w', now: () => 1 })
  assert.equal((await q.claimNext())?.['clientOrderId'], 'o1')
})

test('a driver that finds nothing returns null in both shapes', async () => {
  const make = (res: unknown): QueueCollection => ({
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
    findOne: async () => null,
    findOneAndUpdate: async () => res as never,
    updateOne: async () => undefined,
    createIndex: async () => undefined,
  })
  const q3 = new OrderQueue({ collection: make({ value: null }), workerId: 'w', now: () => 1 })
  const q4 = new OrderQueue({ collection: make(null), workerId: 'w', now: () => 1 })
  assert.equal(await q3.claimNext(), null)
  assert.equal(await q4.claimNext(), null)
})

test('PLACED records the tranche list the fill watcher needs', async () => {
  // Claimed by THIS worker: every placement write is fenced on the claim.
  const { q, c } = setup()
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'w1', claimedAt: 1_000_000 }))
  await q.markPlaced('o1', {
    brokerOrderIds: ['987', '988'],
    trancheIds: ['o1.1', 'o1.2'],
    failedTrancheIds: [],
    expectedQty: 13125,
  })
  assert.equal(c.docs[0]?.['state'], 'PLACED')
  assert.deepEqual(c.docs[0]?.['brokerOrderIds'], ['987', '988'])
  // Without these two the watcher cannot tell "every tranche is terminal" from
  // "every tranche I have heard from is terminal", which is the G1 defect.
  assert.deepEqual(c.docs[0]?.['trancheIds'], ['o1.1', 'o1.2'])
  assert.equal(c.docs[0]?.['expectedQty'], 13125)
})

test('PLACED persists the AMBIGUOUS tranches separately from the failed ones', async () => {
  // F-3. A tranche whose placement timed out may be live at the exchange. It is
  // NOT in `failedTrancheIds`, because that array is read as "terminal, zero
  // fill" and would mark the desk order REJECTED over a real position; it is
  // not in the fill path either, because no update may ever arrive. Its own
  // array is what keeps the order non-terminal until the broker book answers.
  const { q, c } = setup()
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'w1', claimedAt: 1_000_000 }))
  await q.markPlaced('o1', {
    brokerOrderIds: ['987'],
    trancheIds: ['o1.1', 'o1.2', 'o1.3'],
    failedTrancheIds: ['o1.2'],
    ambiguousTrancheIds: ['o1.3'],
    expectedQty: 13125,
  })
  assert.deepEqual(c.docs[0]?.['failedTrancheIds'], ['o1.2'])
  assert.deepEqual(c.docs[0]?.['ambiguousTrancheIds'], ['o1.3'])
})

test('markPlaced with no ambiguous tranches still writes the field', async () => {
  // An ABSENT array and an empty one must not be different states: the sweep
  // reads this field on every PLACED document, and "missing" would otherwise
  // have to mean both "old document" and "nothing ambiguous".
  const { q, c } = setup()
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'w1', claimedAt: 1_000_000 }))
  await q.markPlaced('o1', {
    brokerOrderIds: ['987'],
    trancheIds: ['o1.1'],
    failedTrancheIds: [],
    expectedQty: 13125,
  })
  assert.deepEqual(c.docs[0]?.['ambiguousTrancheIds'], [])
})

test('resolveAmbiguous MOVES the tranche — ambiguous out, failed in', async () => {
  const { q, c } = setup()
  c.docs.push(
    order('o1', 'PLACED', {
      trancheIds: ['o1.1', 'o1.2'],
      failedTrancheIds: [],
      ambiguousTrancheIds: ['o1.1', 'o1.2'],
    }),
  )
  await q.resolveAmbiguous('o1', 'o1.2')
  assert.deepEqual(c.docs[0]?.['ambiguousTrancheIds'], ['o1.1'])
  assert.deepEqual(c.docs[0]?.['failedTrancheIds'], ['o1.2'])
})

test('resolveAmbiguous is idempotent — a repeated pass adds nothing', async () => {
  // The sweep is an interval, and a crash between the two array writes must not
  // duplicate the id. `$addToSet`, never `$push`.
  const { q, c } = setup()
  c.docs.push(
    order('o1', 'PLACED', { failedTrancheIds: ['o1.2'], ambiguousTrancheIds: ['o1.2'] }),
  )
  await q.resolveAmbiguous('o1', 'o1.2')
  await q.resolveAmbiguous('o1', 'o1.2')
  assert.deepEqual(c.docs[0]?.['ambiguousTrancheIds'], [])
  assert.deepEqual(c.docs[0]?.['failedTrancheIds'], ['o1.2'])
})

test('resolveAmbiguous is NOT fenced on the claim — the sweep never holds one', async () => {
  // Same reasoning as `markTerminal`: the broker sweep runs long after the
  // placement claim is gone, and a fenced write would silently match nothing.
  const { q, c } = setup('w1')
  c.docs.push(order('o1', 'PLACED', { claimedBy: 'someone-else', ambiguousTrancheIds: ['o1.1'] }))
  await q.resolveAmbiguous('o1', 'o1.1')
  assert.deepEqual(c.docs[0]?.['failedTrancheIds'], ['o1.1'])
})

test('terminal states are recorded, PARTIAL included', async () => {
  const { q, c } = setup()
  c.docs.push(order('o1'))
  await q.markTerminal('o1', 'FILLED', { filledQty: 13125, avgPrice: 14.85 })
  assert.equal(c.docs[0]?.['state'], 'FILLED')
  assert.equal(c.docs[0]?.['avgPrice'], 14.85)

  await q.markTerminal('o1', 'PARTIAL', { filledQty: 10500, avgPrice: 14.85 })
  assert.equal(c.docs[0]?.['state'], 'PARTIAL')
})

test('get() reads the order back by its idempotency key', async () => {
  const { q, c } = setup()
  c.docs.push(order('o1'))
  assert.equal((await q.get('o1'))?.['tradingsymbol'], 'BHEL26AUG420CE')
  assert.equal(await q.get('nope'), null)
})

/**
 * A BROKER ORDER ID IS NOT UNIQUE ACROSS DAYS. XTS's AppOrderID can be
 * reused; a yesterday's FILLED document and today's PLACED one then share it,
 * and Mongo's `findOne` on a multikey equality yields whichever it likes —
 * in practice the older one, inserted first. A fill for today's order would
 * land on yesterday's terminal document, tagged with yesterday's book (F3).
 */
test('getByBrokerOrderId prefers the non-terminal document when two share an id', async () => {
  const { q, c } = setup()
  c.docs.push(order('old', 'FILLED', { brokerOrderIds: ['987'], createdAt: 1 }))
  c.docs.push(order('new', 'PLACED', { brokerOrderIds: ['987'], createdAt: 2 }))
  assert.equal((await q.getByBrokerOrderId('987'))?.['clientOrderId'], 'new')
})

test('getByBrokerOrderId returns the newest when every match is terminal', async () => {
  const { q, c } = setup()
  c.docs.push(order('old', 'FILLED', { brokerOrderIds: ['987'], createdAt: 1 }))
  c.docs.push(order('newer', 'REJECTED', { brokerOrderIds: ['987'], createdAt: 2 }))
  assert.equal((await q.getByBrokerOrderId('987'))?.['clientOrderId'], 'newer')
  assert.equal(await q.getByBrokerOrderId(''), null)
  assert.equal(await q.getByBrokerOrderId('none'), null)
})

test('an unplannable order is marked INVALID with its reason, not retried forever', async () => {
  const { q, c } = setup()
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'w1', claimedAt: 1_000_000 }))
  await q.markInvalid('o1', 'cannot resolve BHEL26AUG999CE')
  assert.equal(c.docs[0]?.['state'], 'INVALID')
  assert.match(String(c.docs[0]?.['reason']), /cannot resolve/)
  assert.equal(await q.claimNext(), null, 'INVALID must not be picked up again')
})

// ------------------------------------------- placement marker and heartbeat

test('markPlacing records that a placement BEGAN, and counts the attempt', async () => {
  // The marker is what routes a reclaim into recovery instead of a re-place:
  // its presence means "tranches may already be at the broker".
  const { q, c } = setup('w1', () => 1_000_000)
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'w1', claimedAt: 1_000_000 }))
  await q.markPlacing('o1')
  assert.equal(c.docs[0]?.['placementStartedAt'], 1_000_000)
  assert.equal(c.docs[0]?.['placeAttempts'], 1)
  await q.markPlacing('o1')
  assert.equal(c.docs[0]?.['placeAttempts'], 2, 'so the dead-letter after N attempts is bounded')
})

test('heartbeat keeps a slow multi-tranche placement from being reclaimed under it', async () => {
  // Scenario (b) of the duplicate-placement finding: three attempts x 15s x
  // several tranches outlives one claim window, and a second gateway re-places
  // everything. The heartbeat extends the claim while the placement is live.
  let now = 1_000_000
  const c = new FakeCollection()
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'w1', claimedAt: now }))
  const mine = new OrderQueue({ collection: c, workerId: 'w1', now: () => now })
  const other = new OrderQueue({ collection: c, workerId: 'w2', now: () => now })

  now += CLAIM_TIMEOUT_MS - 1
  assert.equal(await mine.heartbeat('o1'), true, 'still the owner')
  now += CLAIM_TIMEOUT_MS - 1
  assert.equal(await other.claimNext(), null, 'the refreshed claim is still live')
  assert.equal(c.docs[0]?.['claimedBy'], 'w1')

  // A gateway that actually DIED still loses the claim: the heartbeat stops.
  now += 2
  assert.notEqual(await other.claimNext(), null)
})

// ------------------------------------------------------- the ownership fence

test('a worker that lost its claim cannot overwrite the reclaimer’s outcome', async () => {
  // A worker that stalls past CLAIM_TIMEOUT_MS loses the order to a reclaimer
  // but keeps running. Filtering on clientOrderId alone let its LATER write land
  // on top of the recovery outcome — last writer wins, and the last writer is
  // the zombie. Every claim-holder write is fenced on `claimedBy`.
  let now = 1_000_000
  const c = new FakeCollection()
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'zombie', claimedAt: now }))
  const zombie = new OrderQueue({ collection: c, workerId: 'zombie', now: () => now })
  const reclaimer = new OrderQueue({ collection: c, workerId: 'reclaimer', now: () => now })

  now += CLAIM_TIMEOUT_MS + 1
  assert.notEqual(await reclaimer.claimNext(), null, 'the stalled claim is reclaimable')
  await reclaimer.markPlaced('o1', {
    brokerOrderIds: ['2100000012345'],
    trancheIds: ['o1.1'],
    failedTrancheIds: [],
    expectedQty: 13125,
  })

  // The zombie wakes up and writes its own conclusions. All of them are no-ops.
  await zombie.markPlacing('o1')
  await zombie.markPlaced('o1', {
    brokerOrderIds: [],
    trancheIds: ['o1.1', 'o1.2'],
    failedTrancheIds: ['o1.1', 'o1.2'],
    expectedQty: 26250,
  })
  await zombie.markInvalid('o1', 'the zombie decided this order failed')

  assert.equal(c.docs[0]?.['state'], 'PLACED', 'the reclaimer’s outcome stands')
  assert.deepEqual(c.docs[0]?.['brokerOrderIds'], ['2100000012345'])
  assert.deepEqual(c.docs[0]?.['trancheIds'], ['o1.1'])
  assert.equal(c.docs[0]?.['reason'], undefined)
  assert.equal(c.docs[0]?.['placeAttempts'], undefined, 'not even the attempt counter moved')
})

test('a false heartbeat stops the placement loop', async () => {
  // The rule `placeOne` follows: heartbeat between tranches, and the moment it
  // reports the claim gone, STOP — the reclaimer's recovery owns the outcome
  // from there, so every further tranche is a position nothing accounts for.
  let now = 1_000_000
  const c = new FakeCollection()
  c.docs.push(order('o1', 'CLAIMED', { claimedBy: 'w1', claimedAt: now, placementStartedAt: now }))
  const mine = new OrderQueue({ collection: c, workerId: 'w1', now: () => now })
  const other = new OrderQueue({ collection: c, workerId: 'w2', now: () => now })

  const sent: string[] = []
  for (const tranche of ['o1.1', 'o1.2', 'o1.3']) {
    sent.push(tranche)
    // Tranche 1 takes longer than the whole claim window, and a reclaimer picks
    // the order up underneath this loop.
    if (sent.length === 1) {
      now += CLAIM_TIMEOUT_MS + 1
      await other.claimNext()
    }
    if (!(await mine.heartbeat('o1'))) break
  }

  assert.deepEqual(sent, ['o1.1'], 'the loop stopped at the tranche it was on')
  assert.equal(c.docs[0]?.['claimedBy'], 'w2')
  assert.equal(c.docs[0]?.['state'], 'CLAIMED', 'and this worker wrote no outcome')
})

// ------------------------------------------------------ admission decisions

test('a fresh order is not stale', () => {
  assert.equal(isStaleOrder(1_000_000, 1_000_000 + 60_000, 180_000), false)
})

test('an order past the age bound is refused rather than placed at a price nobody chose', () => {
  assert.equal(isStaleOrder(1_000_000, 1_000_000 + 180_001, 180_000), true)
  assert.equal(isStaleOrder(1_000_000, 1_000_000 + 180_000, 180_000), false, 'the bound itself passes')
})

test('an order with no createdAt is NEVER stale', () => {
  // Legacy and hand-written documents carry no timestamp. Treating a missing
  // one as "infinitely old" would mass-refuse the whole backlog on deploy.
  assert.equal(isStaleOrder(0, 9_999_999_999, 180_000), false)
  // How `processOne` reads it off a document that has no such field at all.
  const legacy: Record<string, unknown> = { clientOrderId: 'o1' }
  assert.equal(isStaleOrder(Number(legacy['createdAt'] ?? 0), 9_999_999_999, 180_000), false)
})

test('a stale CLOSE is still placed — refusing an exit is worse than a stale price', () => {
  // The bridge books the desk's position at WRITE time and NOTHING un-books a
  // gateway refusal, so a refused close leaves the desk reading flat while the
  // real position is live. A stale-priced exit that rests unfilled is visible
  // and chaseable; a silent refusal is neither.
  const created = 1_000_000
  const wayLate = created + 10 * 60_000
  for (const op of ['close', 'roll', 'resize']) {
    assert.equal(refusesStaleOrder(op, created, wayLate, 180_000), false, `op=${op}`)
  }
  // What the gate is actually for: an entry nobody is exposed to yet.
  assert.equal(refusesStaleOrder('open', created, wayLate, 180_000), true)
  // Unknown/absent op is treated as exposure-adding, like every other gate here.
  assert.equal(refusesStaleOrder(undefined, created, wayLate, 180_000), true)
  assert.equal(refusesStaleOrder('', created, wayLate, 180_000), true)
  // And a FRESH open still goes out.
  assert.equal(refusesStaleOrder('open', created, created + 60_000, 180_000), false)
})

test('a reclaimed order is not deterministically dead-lettered: default age bound exceeds the claim timeout', () => {
  // These two were EQUAL (180s each). An order claimed at T and orphaned by a
  // dying gateway is only reclaimable at T + CLAIM_TIMEOUT_MS, so it arrived at
  // the age gate already past a bound of the same size — ALWAYS, for every
  // orphaned order. The rescue path could only ever bin what it rescued.
  assert.ok(
    DEFAULT_ORDER_MAX_AGE_MS > CLAIM_TIMEOUT_MS,
    `the age bound (${DEFAULT_ORDER_MAX_AGE_MS}ms) must exceed the claim timeout (${CLAIM_TIMEOUT_MS}ms)`,
  )
  // The property that buys: a freshly written order reclaimed once can still be
  // placed, because the reclaim lands inside the remaining window.
  const createdAt = 1_000_000
  const reclaimedAt = createdAt + CLAIM_TIMEOUT_MS + 1
  assert.equal(refusesStaleOrder('open', createdAt, reclaimedAt, DEFAULT_ORDER_MAX_AGE_MS), false)
})

test('a halt refuses a queued OPEN, and fails closed when the switch cannot be read', () => {
  assert.equal(haltsQueuedOrder('open', 'on'), true)
  assert.equal(haltsQueuedOrder('open', 'unreadable'), true)
  assert.equal(haltsQueuedOrder('open', 'off'), false)
})

test('a halt NEVER blocks an exit, and an unreadable switch cannot trap one', () => {
  // Same governing rule as apps/api/src/safety.ts: a halt stops NEW EXPOSURE.
  // Failing closed on an exit would trap a position behind its own safety
  // control, which is worse than whatever the halt was protecting against.
  for (const op of ['close', 'roll', 'resize']) {
    assert.equal(haltsQueuedOrder(op, 'on'), false, `op=${op}`)
    assert.equal(haltsQueuedOrder(op, 'unreadable'), false, `op=${op}`)
  }
})

test('an UNKNOWN or absent desk_op is halted, not waved through', () => {
  // The pass list is the known exposure-reducing ops, not "anything that is not
  // open". Refusing only `open` failed OPEN: a renamed, misspelt or missing
  // desk_op opened a fresh position straight through an engaged kill switch.
  for (const op of [undefined, '', 'OPEN', 'entry', 'open_leg', 'anything']) {
    assert.equal(haltsQueuedOrder(op, 'on'), true, `op=${String(op)}`)
    assert.equal(haltsQueuedOrder(op, 'unreadable'), true, `op=${String(op)}`)
    assert.equal(haltsQueuedOrder(op, 'off'), false, `op=${String(op)} with no halt`)
  }
})

// ------------------------------------------------------- tranche gating

test('advanceTranche moves the cursor and RE-ARMS the document for the sweeper', async () => {
  const { q, c } = setup('w1', () => 1_000_000)
  c.docs.push(
    order('o1', 'PLACED', {
      trancheCursor: 0,
      tranchePlan: [{ qty: 225 }, { qty: 225 }],
      claimedBy: 'w1',
      claimedAt: 900_000,
      placementStartedAt: 900_000,
      placeAttempts: 1,
      chaseAttempts: 3,
      chaseExhaustedAt: 950_000,
    }),
  )
  assert.equal(await q.advanceTranche('o1', 0), true)

  const d = c.docs[0] as Record<string, unknown>
  assert.equal(d['trancheCursor'], 1)
  assert.equal(d['state'], 'PENDING')
  assert.equal(d['trancheArmedAt'], 1_000_000)
  // The interrupted-placement marker MUST go: with it set, the next claim
  // routes into recovery, which places nothing — the order would stop dead
  // after tranche 1 with no error anywhere.
  assert.equal('placementStartedAt' in d, false)
  assert.equal('claimedBy' in d, false)
  // The dead-letter counter bounds ONE placement's recovery loop, not a
  // five-slice order's life.
  assert.equal(d['placeAttempts'], 0)
  // And the chaser's per-slice state, or an exhausted slice would make every
  // later tranche invisible to the chaser.
  assert.equal('chaseAttempts' in d, false)
  assert.equal('chaseExhaustedAt' in d, false)

  // The point of re-arming: the ordinary claim path picks it up.
  assert.equal((await q.claimNext())?.['clientOrderId'], 'o1')
})

test('two watchers racing CONCURRENTLY advance one cursor exactly once (F-10)', async () => {
  // The advance is decided by the fill watcher, which runs from a broker socket
  // callback, a boot reconcile and the end of every placement — three sources
  // that can see ONE terminal tranche at the same moment. A read-then-write
  // would let both re-arm the document and the sweeper place tranche 2 twice.
  const c = new FakeCollection()
  c.docs.push(order('o1', 'PLACED', { trancheCursor: 0, tranchePlan: [{ qty: 1 }, { qty: 1 }] }))
  const a = new OrderQueue({ collection: c, workerId: 'A', now: () => 1_000_000 })
  const b = new OrderQueue({ collection: c, workerId: 'B', now: () => 1_000_000 })

  const results = await Promise.all([a.advanceTranche('o1', 0), b.advanceTranche('o1', 0)])
  assert.deepEqual(results.filter((r) => r).length, 1, 'exactly one advance may win')
  assert.equal(c.docs[0]?.['trancheCursor'], 1)
})

test('a STALE cursor advances nothing, and neither does a document mid-placement', async () => {
  const { q, c } = setup()
  c.docs.push(order('o1', 'PLACED', { trancheCursor: 2, tranchePlan: [{ qty: 1 }] }))
  assert.equal(await q.advanceTranche('o1', 0), false, 'the cursor has moved on')
  assert.equal(c.docs[0]?.['trancheCursor'], 2)

  // CLAIMED means a placement is in flight: re-arming underneath it would hand
  // the same slice to a second claim.
  c.docs.push(order('o2', 'CLAIMED', { trancheCursor: 0, claimedBy: 'w1' }))
  assert.equal(await q.advanceTranche('o2', 0), false)
  assert.equal(c.docs[1]?.['state'], 'CLAIMED')
})

test('a later tranche APPENDS its ids — the filled ones are not rewritten', async () => {
  // Replacing would delete the ids of tranches that have already FILLED, and
  // the aggregate would then wait forever on tranches whose names it no longer
  // knows: the desk order stuck PLACED while the broker held it done.
  const { q, c } = setup()
  c.docs.push(
    order('o1', 'CLAIMED', {
      claimedBy: 'w1',
      claimedAt: 1_000_000,
      brokerOrderIds: ['987'],
      trancheIds: ['o1.1'],
      failedTrancheIds: [],
      ambiguousTrancheIds: [],
    }),
  )
  await q.markPlaced('o1', {
    brokerOrderIds: ['988'],
    trancheIds: ['o1.2'],
    failedTrancheIds: [],
    expectedQty: 13125,
    append: true,
  })
  assert.deepEqual(c.docs[0]?.['trancheIds'], ['o1.1', 'o1.2'])
  assert.deepEqual(c.docs[0]?.['brokerOrderIds'], ['987', '988'])
  assert.equal(c.docs[0]?.['state'], 'PLACED')
  // The denominator stays the WHOLE order, and the placement clock restarts —
  // the peg deadline is per slice.
  assert.equal(c.docs[0]?.['expectedQty'], 13125)
  assert.equal(c.docs[0]?.['placedAt'], 1_000_000)
})

test('markHalted records the stop AND what actually filled, without holding the claim', async () => {
  // Not fenced, like markTerminal: the fill watcher writes it and never holds
  // the claim. The quantity matters because `service.ts:#actualEntries` prices
  // legs off these fields — a halt that recorded only its reason would mark a
  // leg that traded at the seed price.
  const { q, c } = setup('w1')
  c.docs.push(order('o1', 'PLACED', { claimedBy: 'someone-else' }))
  await q.markHalted('o1', { filledQty: 225, avgPrice: 101, reason: 'tranche 2 was REJECTED' })

  assert.equal(c.docs[0]?.['state'], 'HALTED')
  assert.equal(c.docs[0]?.['filledQty'], 225)
  assert.equal(c.docs[0]?.['avgPrice'], 101)
  assert.match(String(c.docs[0]?.['reason']), /REJECTED/)
  assert.equal(await q.claimNext(), null, 'HALTED must not be picked up again')
})

test('pendingCount reports the backlog', async () => {
  const { q, c } = setup()
  c.docs.push(order('o1'), order('o2'), order('o3', 'PLACED'))
  assert.equal(await q.pendingCount(), 2)
})

// -------------------------------------------------------------- sweep pacing

test('a nudge sweeps immediately', () => {
  assert.equal(shouldSweep({ nudged: true, msSinceLastSweep: 0, idleIntervalMs: 5000 }), true)
})

test('a DROPPED nudge costs latency, never an order', () => {
  // The whole reason the collection is the durable record: if the bus message
  // is lost while the gateway is reconnecting, the idle sweep still finds it.
  assert.equal(shouldSweep({ nudged: false, msSinceLastSweep: 4999, idleIntervalMs: 5000 }), false)
  assert.equal(shouldSweep({ nudged: false, msSinceLastSweep: 5000, idleIntervalMs: 5000 }), true)
})

// -------------------------------------------------------------- the sweeper

test('a sweep drains the whole queue, oldest first', async () => {
  const { q, c } = setup()
  c.docs.push(order('a', 'PENDING', { createdAt: 2 }), order('b', 'PENDING', { createdAt: 1 }))
  const seen: string[] = []
  const s = createSweeper({
    claimNext: () => q.claimNext(),
    handle: async (d) => void seen.push(String(d['clientOrderId'])),
    log: () => {},
    now: () => 5,
  })
  await s.sweep()
  assert.deepEqual(seen, ['b', 'a'])
  assert.equal(s.lastSweepMs, 5)
})

test('a sweep NEVER rejects when the CLAIM fails', async () => {
  // G4: both call sites are `void sweep()`, so a rejection here is an unhandled
  // rejection and Node 24 exits — a Mongo blip killed the only process that can
  // place orders. `try/finally` with no catch releases the lock and re-throws.
  const logs: string[] = []
  const s = createSweeper({
    claimNext: async () => {
      throw new Error('connection 4 to mongo closed')
    },
    handle: async () => {},
    log: (m) => logs.push(m),
    now: () => 1,
  })
  await s.sweep() // must not throw
  assert.equal(logs.some((l) => l.includes('sweep FAILED')), true)
  assert.equal(s.running, false, 'and the lock is released, so the next tick can sweep')
})

test('one order that throws does not abandon the rest of the queue', async () => {
  // The rest may be stop-losses.
  const { q, c } = setup()
  c.docs.push(order('bad'), order('good'))
  const seen: string[] = []
  const s = createSweeper({
    claimNext: () => q.claimNext(),
    handle: async (d) => {
      if (d['clientOrderId'] === 'bad') throw new Error('unresolvable')
      seen.push(String(d['clientOrderId']))
    },
    log: () => {},
    now: () => 1,
  })
  await s.sweep()
  assert.deepEqual(seen, ['good'])
})

test('overlapping sweeps do not run concurrently', async () => {
  // Two sweeps racing claim the same documents and double the broker load.
  const { q, c } = setup()
  c.docs.push(order('a'))
  let inFlight = 0
  let maxInFlight = 0
  const s = createSweeper({
    claimNext: () => q.claimNext(),
    handle: async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setImmediate(r))
      inFlight--
    },
    log: () => {},
    now: () => 1,
  })
  await Promise.all([s.sweep(), s.sweep()])
  assert.equal(maxInFlight, 1)
})
