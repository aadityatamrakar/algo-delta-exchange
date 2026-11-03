/**
 * THE SUPERVISOR'S MEMORY, AGAINST A REAL MONGODB.
 *
 * WHY THE DRIVER AND NOT A FAKE. Every property here is a database property.
 * "Two supervisors load the same book and both save; exactly one write lands"
 * is decided by the server matching a filter, and a fake that models the race
 * is a second implementation of the very thing under test — it would pass
 * whatever the store did. The upsert-collides-into-a-duplicate-key path that
 * makes a first save safe cannot be seen from inside a fake at all: it depends
 * on the UNIQUE INDEX being there.
 *
 * Skips itself when no Mongo is reachable — unless `DESK_REQUIRE_MONGO=1`, see
 * `require-mongo.ts`. Its own database: node:test runs these files in parallel
 * processes and each wipes its own collections.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from './require-mongo.ts'
import { connectMongo, type MongoHandle } from '../../api/src/mongo.ts'
import { EMPTY_PLAYBOOK_STATE, EMPTY_RULE_STATE } from '@algomaker/desk-engine'
import type { WireAction, RuleState } from '@algomaker/desk-engine'
import {
  StateStore,
  SUPERVISOR_STATE_COLLECTION,
  emptyBookState,
  hydrateRuleState,
  nextVersion,
  stateKey,
  type StateCollection,
  type SupervisorBookState,
} from '../src/state-store.ts'

const URL =
  process.env['DESK_TEST_MONGO_SUPERVISOR_STATE'] ??
  'mongodb://127.0.0.1:27017/algomaker_dx_supervisor_state_test'

const TAG = 'BHEL-2026-08-27-hold-recycle-r'
/** 2026-08-21 09:20 IST, as a version stamp. */
const T0 = Date.parse('2026-08-21T03:50:00.000Z')
/** The IST date `T0` falls on. */
const DATE = '2026-08-21'

let handle: MongoHandle | null = null
let available = false
let store: StateStore

before(async () => {
  try {
    handle = await connectMongo(URL, { serverSelectionTimeoutMS: 2500 })
    const collection = handle.db.collection(SUPERVISOR_STATE_COLLECTION)
    store = new StateStore(collection as unknown as StateCollection)
    await store.ensureIndexes()
    available = true
  } catch {
    available = false
  }
})

after(async () => {
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (available) await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).deleteMany({})
})

// --------------------------------------------------------------- pure logic

test('the key is the book AND the mode — one tag steered twice is two books', () => {
  assert.equal(stateKey(TAG, 'paper'), `${TAG}:paper`)
  assert.equal(stateKey(TAG, 'live'), `${TAG}:live`)
  assert.notEqual(stateKey(TAG, 'paper'), stateKey(TAG, 'live'))
})

test('the next version never stands still, even inside one millisecond', () => {
  const at = { ...emptyBookState(TAG, 'paper'), updatedAt: T0 }
  assert.equal(nextVersion(at, T0 + 5), T0 + 5)
  // Same millisecond, and a clock that stepped backwards: both must advance.
  assert.equal(nextVersion(at, T0), T0 + 1)
  assert.equal(nextVersion(at, T0 - 10_000), T0 + 1)
})

// ------------------------------------------------------------------ Mongo

test('a book nobody has steered yet loads as a FRESH book, never as undefined', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const s = await store.load(TAG, 'paper')

  assert.deepEqual(s, {
    key: `${TAG}:paper`,
    ruleState: EMPTY_RULE_STATE,
    workingPackage: null,
    protectedQty: {},
    cumRealized: 0,
    cumRealizedBasis: [],
    inFlight: null,
    seq: 0,
    updatedAt: 0,
  })
})

test('the first save creates the document and the version it wrote is the one it was given', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const fresh = await store.load(TAG, 'paper')
  const next: SupervisorBookState = {
    ...fresh,
    seq: 1,
    inFlight: `${TAG}:paper:1`,
    updatedAt: nextVersion(fresh, T0),
  }

  assert.equal(await store.save(fresh, next), true)

  const back = await store.load(TAG, 'paper')
  assert.deepEqual(back, next)
})

test('the whole state round-trips — rule state, working package, protected lots', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const remaining: ReadonlyArray<WireAction> = [
    { op: 'open', instrument: 'BHEL26AUG300CE', side: 'Sell', qty: 5250, workMode: 'passive' },
    { op: 'resize', instrument: 'BHEL26AUG280PE', targetQty: 1050, limitPrice: 4.35 },
  ]
  const fresh = await store.load(TAG, 'live')
  const next: SupervisorBookState = {
    key: fresh.key,
    ruleState: {
      ...EMPTY_RULE_STATE,
      rcCredit: 12_450.5,
      rcEodDay: '2026-08-20',
      gkAnchor: 417.25,
      gkStreak: 3,
      scrapBanned: ['300:CE:2026-08-27'],
      targetStreak: 2,
      targetLocked: true,
      rcStack: [{ strike: 300, optType: 'CE', lots: 2 }],
      lastActionMs: T0 - 600_000,
    },
    workingPackage: {
      decisionId: `${TAG}:live:7`,
      remaining,
      // The envelope a boot replay re-posts VERBATIM, and the basis its fills
      // are measured against — both persisted because the crash this survives
      // may have happened before the post ever landed.
      request: {
        tag: TAG,
        mode: 'live',
        decisionId: `${TAG}:live:7`,
        symbol: 'BHEL',
        expiry: '2026-08-27',
        trigger: 'shed',
        reason: 'the band is breached by 3 lots',
        actions: remaining,
        work: { trancheLots: 3, chaseMaxMs: 30_000, chaseCrossBufferPct: 0.005 },
      },
      basis: [
        {
          instrument: 'BHEL26AUG280PE',
          strike: 280,
          optType: 'PE',
          side: 'Sell',
          op: 'resize',
          // No lean opened this leg: a recenter book's short. `''` is the value
          // "no lean" has everywhere, and it round-trips as itself.
          leanId: '',
          entry: 6.4,
          lots: 8,
          lotSize: 5250,
          intentQty: 1050,
        },
      ],
      // The invalidation clock: when the package was decided and at what
      // forward. Durable, because a resting quote outlives this process.
      formedAt: T0 - 120_000,
      formedSpot: 291.35,
    },
    protectedQty: { BHEL26AUG300CE: 3 },
    cumRealized: -1875.25,
    // What each fold was measured off — the live rail books optimistically, so
    // a true-up has to be able to find those rupees again.
    cumRealizedBasis: [
      { decisionId: `${TAG}:live:6`, basis: 'optimistic-mark', amount: -1875.25, at: T0 - 900_000 },
    ],
    inFlight: null,
    seq: 7,
    updatedAt: nextVersion(fresh, T0),
  }

  assert.equal(await store.save(fresh, next), true)
  assert.deepEqual(await store.load(TAG, 'live'), next)
})

test('a stale writer is REFUSED and the winner\'s state stands', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // Two supervisors that both believe they steer this book.
  const a = await store.load(TAG, 'paper')
  const b = await store.load(TAG, 'paper')

  const winner = { ...a, seq: 1, cumRealized: 100, updatedAt: nextVersion(a, T0) }
  const loser = { ...b, seq: 1, cumRealized: -999, updatedAt: nextVersion(b, T0) }
  assert.equal(await store.save(a, winner), true)
  assert.equal(await store.save(b, loser), false)

  const back = await store.load(TAG, 'paper')
  assert.equal(back.cumRealized, 100)
  assert.equal(back.seq, 1)
})

test('a stale writer is refused on the FIRST write too — nothing exists to compare against', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const a = await store.load(TAG, 'paper')
  const b = await store.load(TAG, 'paper')

  assert.equal(await store.save(a, { ...a, seq: 1, updatedAt: nextVersion(a, T0) }), true)
  // b still holds updatedAt 0 — "this book has no document". It must not get a
  // second one: without the unique index the upsert would insert alongside.
  assert.equal(await store.save(b, { ...b, seq: 9, updatedAt: nextVersion(b, T0) }), false)

  const docs = await handle!.db
    .collection(SUPERVISOR_STATE_COLLECTION)
    .countDocuments({ key: `${TAG}:paper` })
  assert.equal(docs, 1)
})

test('two saves in the SAME millisecond still advance the version', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const fresh = await store.load(TAG, 'paper')
  const first: SupervisorBookState = { ...fresh, seq: 1, updatedAt: nextVersion(fresh, T0) }
  assert.equal(await store.save(fresh, first), true)

  // A frozen clock: the caller proposes the version it already wrote.
  const second: SupervisorBookState = { ...first, seq: 2, updatedAt: nextVersion(first, T0) }
  assert.equal(await store.save(first, second), true)
  assert.equal(second.updatedAt, first.updatedAt + 1)

  const back = await store.load(TAG, 'paper')
  assert.equal(back.seq, 2)
  assert.equal(back.updatedAt, first.updatedAt + 1)
  // And the version that was just superseded is dead: an ABA would let it back.
  assert.equal(await store.save(first, { ...first, seq: 99, updatedAt: nextVersion(first, T0) }), false)
})

test('a document written before a field existed loads as the EMPTY value, never undefined', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // What an older build — or a hand-repair in the shell — leaves behind.
  await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).insertOne({
    key: `${TAG}:paper`,
    ruleState: { rcCredit: 500 },
    seq: 4,
    updatedAt: T0,
  })

  const s = await store.load(TAG, 'paper')

  assert.equal(s.ruleState.rcCredit, 500)
  assert.deepEqual(s.ruleState, { ...EMPTY_RULE_STATE, rcCredit: 500 })
  // Spelled out, because `undefined` here is the absent-vs-zero bug arriving in
  // the engine as NaN and a lock that silently reads as "not locked".
  assert.equal(typeof s.ruleState.gkAnchor, 'number')
  assert.equal(typeof s.ruleState.targetLocked, 'boolean')
  assert.equal(typeof s.cumRealized, 'number')
  assert.deepEqual(s.ruleState.scrapBanned, [])
  assert.deepEqual(s.ruleState.rcStack, [])
  assert.deepEqual(s.protectedQty, {})
  assert.equal(s.workingPackage, null)
  assert.equal(s.inFlight, null)
  assert.equal(s.updatedAt, T0)

  // And it is still writable: the CAS pins the version it just read.
  assert.equal(await store.save(s, { ...s, seq: 5, updatedAt: nextVersion(s, T0) }), true)
})

test('the delta-lean half of the rule state survives a Mongo round trip', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  /**
   * Field by field, because each one is a different kind of silent failure:
   *   - a dropped `dlStopped` re-opens a book that stopped itself
   *   - a dropped `dlOpenedMs` makes an OPENED book open a second package
   *   - a dropped `dlLastAdjustRegime` lets the same regime justify two
   *     packages in a row, which is the pyramiding this engine exists to stop
   *   - a dropped `dlBlockedSinceMs` restarts the stuck clock on every restart,
   *     so the stuck exit can never fire on a book that keeps being restarted
   *   - a dropped `dlRupeeSinceMs` restarts a hold book's rupee hold on every
   *     load, so its backstop and target can never fire at all
   */
  const fresh = await store.load(TAG, 'paper')
  const written: Partial<RuleState> = {
    dlDayStarted: DATE,
    dlStopped: true,
    dlOpenedMs: T0 - 900_000,
    dlOpenSide: 'up',
    dlAdjustsToday: 3,
    dlLastAdjustMs: T0 - 300_000,
    dlLastAdjustRegime: 'chop',
    dlRegime: 'trend-up',
    dlRegimeSinceMs: T0 - 120_000,
    dlBlockedSinceMs: T0 - 60_000,
    dlRupeeSinceMs: T0 - 20_000,
    dlDayRealized: -3_200.5,
  }
  const next: SupervisorBookState = {
    ...fresh,
    ruleState: { ...fresh.ruleState, ...written },
    updatedAt: nextVersion(fresh, T0),
  }
  assert.equal(await store.save(fresh, next), true)

  const back = (await store.load(TAG, 'paper')).ruleState
  for (const [k, v] of Object.entries(written)) {
    assert.deepEqual(back[k as keyof RuleState], v, `${k} must round trip`)
  }
})

test('an unrecognised open side reads as "not opened", never as a side the book never chose', () => {
  // The controller branches on this value: a string that is not one of the four
  // would send a book down the up-lean branch with a side nobody picked.
  const s = hydrateRuleState({ dlOpenSide: 'sideways', dlOpenedMs: 1 })
  assert.equal(s.dlOpenSide, '')
})

test('a document written by the v1 controller hydrates as a book that has not opened', () => {
  // Today's stored rows carry `dlLeanId`/`dlLeanPeak`/`dlFlipsToday` and none of
  // the new keys. An unknown key has always been ignored by this hydrator, and
  // a missing one takes its EMPTY_RULE_STATE zero — so yesterday's row reads as
  // a book with no open, no adjustments and no stuck clock, which is exactly
  // what it is under the new rules.
  const s = hydrateRuleState({
    dlLeanId: 'dl-up-1789533000000',
    dlLeanSide: 'up',
    dlLeanPeak: 21_400.75,
    dlFlipsToday: 2,
    dlDayStarted: DATE,
    dlStopped: true,
  })
  assert.equal(s.dlDayStarted, DATE)
  assert.equal(s.dlStopped, true, 'a stop the book set itself survives the engine swap')
  assert.equal(s.dlOpenedMs, 0)
  assert.equal(s.dlOpenSide, '')
  assert.equal(s.dlAdjustsToday, 0)
  assert.equal(s.dlLastAdjustRegime, '')
  assert.equal(s.dlBlockedSinceMs, 0)
  assert.equal(s.dlRupeeSinceMs, 0)
  assert.equal(s.dlDayRealized, 0)
})

test('a hold book`s rupee hold is hydrated, and a row written before it existed reads 0', () => {
  // The host reloads the row every pass: a clock the hydrator dropped would
  // restart each time, and a hold book's backstop and target never fire.
  assert.equal(hydrateRuleState({ dlDayStarted: DATE, dlRupeeSinceMs: T0 - 20_000 }).dlRupeeSinceMs, T0 - 20_000)
  assert.equal(hydrateRuleState({ dlDayStarted: DATE }).dlRupeeSinceMs, 0)
  // In EMPTY_RULE_STATE's key order, which `sameRuleState`'s string compare reads.
  assert.deepEqual(Object.keys(hydrateRuleState({})), Object.keys(EMPTY_RULE_STATE))
})

test('the playbook half hydrates through the engine`s own hydrator; a row without it reads empty', () => {
  // Six-playbooks spec §4.4: `pb` is read back field by field by
  // `hydratePlaybookState`, never cast. A row written before the playbooks
  // existed has no `pb` at all and must read as a playbook that has not traded.
  assert.deepEqual(hydrateRuleState({ dlDayStarted: DATE }).pb, EMPTY_PLAYBOOK_STATE)
  const s = hydrateRuleState({
    dlDayStarted: DATE,
    pb: {
      entries: 1,
      tradeOpenMs: T0,
      side: 'up',
      stage: 1,
      planShorts: [
        { strike: 24_200, optType: 'CE', cover: 23_950 },
        { strike: 'bad', optType: 'PE', cover: 24_050 },
      ],
      exiting: true,
      exitUrgency: 'fast',
    },
  })
  assert.equal(s.pb.entries, 1)
  assert.equal(s.pb.tradeOpenMs, T0)
  assert.equal(s.pb.side, 'up')
  assert.equal(s.pb.stage, 1)
  assert.deepEqual(
    s.pb.planShorts,
    [{ strike: 24_200, optType: 'CE', cover: 23_950 }],
    'the malformed short is dropped',
  )
  assert.equal(s.pb.exiting, true)
  assert.equal(s.pb.exitUrgency, '', 'an unknown urgency is narrowed, not cast')
})

test('a package with no invalidation clock reads as 0 — never as "now"', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // A document written before `formedAt`/`formedSpot` existed. Defaulting them
  // to the moment of the READ would hand a quote that has already rested twenty
  // minutes another full `rest_max_min`, and would re-anchor the strike-move
  // test to wherever spot happens to be at boot — forgetting the move that has
  // already happened. 0 is the honest "this clock is not running".
  await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).insertOne({
    key: `${TAG}:paper`,
    inFlight: `${TAG}:paper:2`,
    workingPackage: { decisionId: `${TAG}:paper:2`, remaining: [], basis: [] },
    updatedAt: T0,
  })

  const s = await store.load(TAG, 'paper')
  assert.equal(s.workingPackage?.formedAt, 0)
  assert.equal(s.workingPackage?.formedSpot, 0)
  // The flight itself is untouched: it is still polled to a terminal outcome,
  // and a guard can still preempt it.
  assert.equal(s.inFlight, `${TAG}:paper:2`)
})

test('a request that does not name THIS decision is not a request to replay', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // Each of these is a document a replay would post: the wrong id (another
  // book's package), the wrong rail (paper state replaying a live decision) and
  // a trigger no engine wrote. All three route ORDERS if the id was never
  // claimed, so hydration refuses them and the host abandons the flight rather
  // than inventing an envelope.
  const base = {
    tag: TAG,
    mode: 'live',
    decisionId: `${TAG}:live:9`,
    symbol: 'BHEL',
    expiry: '2026-08-27',
    trigger: 'shed',
    reason: 'the band is breached',
    actions: [{ op: 'close', instrument: 'BHEL26AUG300CE' }],
  }
  for (const request of [
    { ...base, decisionId: `${TAG}:live:8` },
    { ...base, mode: 'PAPER' },
    { ...base, trigger: 'vibes' },
    { ...base, symbol: '' },
    'not an object',
  ]) {
    await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).deleteMany({})
    await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).insertOne({
      key: `${TAG}:live`,
      inFlight: `${TAG}:live:9`,
      workingPackage: { decisionId: `${TAG}:live:9`, remaining: [], request, basis: [] },
      updatedAt: T0,
    })
    const s = await store.load(TAG, 'live')
    assert.equal(s.workingPackage?.request, null, `accepted ${JSON.stringify(request)}`)
  }
})

test('a basis row missing a number is DROPPED and SAID, never defaulted to zero', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // Each missing field is a specific wrong number rather than an absence: an
  // absent `entry` banks the whole buy-back price as profit, an absent
  // `lotSize` makes every fill worth zero lots, and an absent `strike` shrinks
  // the wrong `rcStack` entry. The row goes, and the host then says it cannot
  // attribute the fill — which is a line an operator can act on.
  const good = {
    instrument: 'BHEL26AUG300CE',
    strike: 300,
    optType: 'CE',
    side: 'Sell',
    op: 'open',
    // 0 is a legal VALUE here — that is exactly what an open carries — so the
    // test has to be on the type, never on the number.
    entry: 0,
    lots: 0,
    lotSize: 5250,
    intentQty: 5250,
    // '' is the legal value for "no lean opened this leg", and unlike every
    // other field here it is also what an ABSENT one means — see below.
    leanId: '',
  }
  /** The same row as a pre-stamping build wrote it: no `leanId` key at all. */
  const { leanId: _unstamped, ...beforeStamping } = good
  const lines: { msg: string; ctx?: Record<string, unknown> }[] = []
  const loud = new StateStore(
    handle!.db.collection(SUPERVISOR_STATE_COLLECTION) as unknown as StateCollection,
    (msg, ctx) => lines.push({ msg, ...(ctx === undefined ? {} : { ctx }) }),
  )

  await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).insertOne({
    key: `${TAG}:paper`,
    workingPackage: {
      decisionId: `${TAG}:paper:3`,
      remaining: [],
      request: null,
      basis: [
        good,
        beforeStamping,
        { ...good, entry: undefined },
        { ...good, lotSize: 0 },
        { ...good, strike: 'three hundred' },
        { ...good, intentQty: null },
        'not a row',
      ],
    },
    updatedAt: T0,
  })

  const s = await loud.load(TAG, 'paper')

  // TWO rows survive: the complete one, and the one written before the lean
  // stamp existed. `leanId` is the single field this hydrator defaults, because
  // it is the only one whose absence has a CORRECT reading — '' is "no lean",
  // which is exactly what a leg nothing stamped is. Dropping that row instead
  // would lose the DAY's fold as well, to say nothing about a lean's.
  assert.deepEqual(s.workingPackage?.basis, [good, good])
  assert.equal(lines.length, 5, 'every dropped row is named')
  assert.ok(lines.every((l) => /DROPPED/.test(l.msg)))
  assert.deepEqual(
    lines.map((l) => String(l.ctx?.['why'])),
    [
      'entry is missing or not a number',
      'lotSize is missing or not a number',
      'strike is missing or not a number',
      'intentQty is missing or not a number',
      'not an object',
    ],
  )
})

test('a save may not write one book\'s state under another book\'s key', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const paper = await store.load(TAG, 'paper')
  const live = await store.load(TAG, 'live')

  await assert.rejects(
    () => store.save(paper, { ...live, updatedAt: nextVersion(live, T0) }),
    /key/,
  )
})

// ------------------------------------------------------ genuine races
//
// The conflict tests above drive the two writers in an order this file chose.
// That proves the FILTER is right; it cannot prove the write is atomic, and it
// would not notice a refactor that put a `findOne` pre-check in front of the
// `findOneAndUpdate` — under author-controlled ordering a read-then-write gap
// looks exactly like a compare-and-set. These fire both saves at once and
// assert the only shape that may ever come back: exactly one winner, and a
// document that is entirely that winner's. Which one wins is the database's
// business, and the assertions never name it.

test('two supervisors saving AT ONCE off one read — exactly one lands, whole', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const prev = await store.load(TAG, 'paper')
  const a: SupervisorBookState = {
    ...prev, seq: 1, cumRealized: 100, inFlight: 'a', updatedAt: nextVersion(prev, T0),
  }
  const b: SupervisorBookState = {
    ...prev, seq: 1, cumRealized: -999, inFlight: 'b', updatedAt: nextVersion(prev, T0),
  }

  const won = await Promise.all([store.save(prev, a), store.save(prev, b)])

  assert.equal(won.filter(Boolean).length, 1, `exactly one writer may land, got ${String(won)}`)
  // Not "one of the two values" field by field — the WHOLE document is one
  // writer's. A torn write would pass a looser assertion.
  assert.deepEqual(await store.load(TAG, 'paper'), won[0] === true ? a : b)
  assert.equal(await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).countDocuments({}), 1)
})

test('the same race against an EXISTING document — the CAS, not the unique key', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // The first race is decided by the unique index (no document to match). This
  // one is decided by the version in the filter, which is the other half.
  const fresh = await store.load(TAG, 'paper')
  assert.equal(await store.save(fresh, { ...fresh, seq: 1, updatedAt: nextVersion(fresh, T0) }), true)

  const prev = await store.load(TAG, 'paper')
  const a: SupervisorBookState = {
    ...prev, seq: 2, cumRealized: 100, inFlight: 'a', updatedAt: nextVersion(prev, T0 + 1000),
  }
  const b: SupervisorBookState = {
    ...prev, seq: 2, cumRealized: -999, inFlight: 'b', updatedAt: nextVersion(prev, T0 + 1000),
  }

  const won = await Promise.all([store.save(prev, a), store.save(prev, b)])

  assert.equal(won.filter(Boolean).length, 1, `exactly one writer may land, got ${String(won)}`)
  assert.deepEqual(await store.load(TAG, 'paper'), won[0] === true ? a : b)
})

test('the unique index builds ITSELF — a store nobody prepared still refuses', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  // No `ensureIndexes()` below: a boot path that forgets it must not be the
  // difference between one memory of this book and two.
  await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).dropIndex('key_1')
  const collection = handle!.db.collection(SUPERVISOR_STATE_COLLECTION)
  const cold = new StateStore(collection as unknown as StateCollection)

  const prev = await cold.load(TAG, 'paper')
  const a: SupervisorBookState = { ...prev, seq: 1, inFlight: 'a', updatedAt: nextVersion(prev, T0) }
  const b: SupervisorBookState = { ...prev, seq: 1, inFlight: 'b', updatedAt: nextVersion(prev, T0) }

  const won = await Promise.all([cold.save(prev, a), cold.save(prev, b)])

  assert.equal(won.filter(Boolean).length, 1, `exactly one writer may land, got ${String(won)}`)
  assert.equal(await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).countDocuments({}), 1)
})

test('a NaN is caught on the write that made it, and named', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const fresh = await store.load(TAG, 'paper')
  // A fold off a leg with no price: BSON stores this happily and every later
  // read is poisoned by it.
  await assert.rejects(
    () => store.save(fresh, { ...fresh, cumRealized: 0 / 0, updatedAt: nextVersion(fresh, T0) }),
    /cumRealized/,
  )
  await assert.rejects(
    () =>
      store.save(fresh, {
        ...fresh,
        ruleState: { ...EMPTY_RULE_STATE, gkAnchor: Number.POSITIVE_INFINITY },
        updatedAt: nextVersion(fresh, T0),
      }),
    /gkAnchor/,
  )
  // Nothing landed.
  assert.equal(await handle!.db.collection(SUPERVISOR_STATE_COLLECTION).countDocuments({}), 0)
})

test('a version that does not advance is refused before it can reach the database', async (t) => {
  if (!available) return skipUnlessMongo(t, URL)

  const fresh = await store.load(TAG, 'paper')
  const at = { ...fresh, seq: 1, updatedAt: nextVersion(fresh, T0) }
  assert.equal(await store.save(fresh, at), true)

  await assert.rejects(() => store.save(at, { ...at, seq: 2 }), /version/)
})
