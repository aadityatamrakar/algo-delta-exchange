/**
 * `RuleState.bs` — the one row a BULL-S book carries, and the one door it
 * comes back through after a restart (`hydrateBullState`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BS_EMPTY, hydrateBullState, type BullSState } from '../../src/bull-s/state.ts'
import { EMPTY_RULE_STATE, TRIGGERS, type Trigger } from '../../src/types.ts'

const MID: BullSState = {
  groups: [
    { strike: 80_000, lots: 50, ceEntry: 2_079.2, peEntry: 1_989.4, openedMs: 1_000, ceOpen: true, peOpen: true, breachSinceMs: 0, filled: true, staleSinceMs: 0 },
    { strike: 80_200, lots: 100, ceEntry: 2_045, peEntry: 1_995, openedMs: 2_000, ceOpen: false, peOpen: true, breachSinceMs: 1_500, filled: false, staleSinceMs: 1_700 },
  ],
  size: 150,
  lastRef: 80_250,
  lastRefMs: 2_000,
  halted: true,
  haltReason: 'loss',
  armedAtMs: 500,
  pnlBaseline: -12.5,
  closeReqSeen: 2,
  rearmReqSeen: 1,
  cooldowns: [{ strike: 79_800, untilMs: 9_000, reason: 'oi-cap: open interest at the cap' }],
  entryRefusal: '',
}

test('BS_EMPTY spells out every zero-value, and a fresh RuleState carries it last', () => {
  assert.deepEqual(BS_EMPTY, {
    groups: [], size: 0, lastRef: 0, lastRefMs: 0, halted: false, haltReason: '',
    armedAtMs: 0, pnlBaseline: 0, closeReqSeen: 0, rearmReqSeen: 0, cooldowns: [], entryRefusal: '',
  })
  assert.equal(EMPTY_RULE_STATE.bs, BS_EMPTY)
  assert.equal(Object.keys(EMPTY_RULE_STATE).at(-1), 'bs')
})

test('a row with no bs, or junk, reads as a book that has never armed', () => {
  for (const raw of [undefined, null, 7, 'bs', [], {}]) {
    assert.deepEqual(hydrateBullState(raw), BS_EMPTY, JSON.stringify(raw))
  }
})

test('a mid-book row round-trips through JSON exactly, in BS_EMPTY key order', () => {
  const back = hydrateBullState(JSON.parse(JSON.stringify(MID)))
  assert.deepEqual(back, MID)
  assert.deepEqual(Object.keys(back), Object.keys(BS_EMPTY))
  assert.deepEqual(Object.keys(back.groups[0] ?? {}), [
    'strike', 'lots', 'ceEntry', 'peEntry', 'openedMs', 'ceOpen', 'peOpen', 'breachSinceMs', 'filled', 'staleSinceMs',
  ])
  const reversed = Object.fromEntries(Object.entries(MID).reverse())
  assert.equal(JSON.stringify(hydrateBullState(reversed)), JSON.stringify(MID), 'a stored key order never moves the row')
})

test('fields are never coerced: a wrong type takes the zero, an unknown halt reason reads as none', () => {
  const back = hydrateBullState({ ...MID, size: '150', halted: 1, haltReason: 'panic', lastRef: Number.NaN })
  assert.equal(back.size, 0)
  assert.equal(back.halted, false)
  assert.equal(back.haltReason, '')
  assert.equal(back.lastRef, 0)
  for (const r of ['target', 'loss', 'close', 'flat', 'expiry'] as const) {
    assert.equal(hydrateBullState({ haltReason: r }).haltReason, r)
  }
})

test('a group that is not a whole group is DROPPED, never zero-filled', () => {
  const g = MID.groups[0]!
  const bad = [
    { ...g, strike: 'x' },
    { ...g, lots: 0 },
    { ...g, lots: -5 },
    { ...g, ceEntry: null },
    { ...g, ceOpen: 'yes' },
    { ...g, ceOpen: false, peOpen: false }, // holds nothing
    { ...g, breachSinceMs: Number.POSITIVE_INFINITY },
    'a group',
    null,
  ]
  const back = hydrateBullState({ ...MID, groups: [...bad, g, { ...g, extra: 1 }] })
  assert.deepEqual(back.groups, [g, g], 'the whole one survives, the extra key does not')
  assert.deepEqual(hydrateBullState({ groups: { 0: g } }).groups, [])
})

test('the ten bs- triggers exist, after every older trigger; bs-stale and bs-balance appended last', () => {
  const bs = ['bs-entry', 'bs-stop', 'bs-target', 'bs-loss', 'bs-flat', 'bs-close', 'bs-rearm', 'bs-expiry', 'bs-stale', 'bs-balance']
  assert.deepEqual(TRIGGERS.filter((t) => t.startsWith('bs-')), bs)
  assert.deepEqual(TRIGGERS.slice(-bs.length), bs as Trigger[])
})

test('a group stored before `filled` existed reads as OPENED — its size already stepped, it is never undone', () => {
  const { filled: _f, ...legacy } = MID.groups[0]!
  void _f
  assert.equal(hydrateBullState({ groups: [legacy] }).groups[0]?.filled, true)
})

test('a group stored before `staleSinceMs` existed reads as not stale; a bad one reads as not stale too', () => {
  const { staleSinceMs: _s, ...legacy } = MID.groups[1]!
  void _s
  assert.equal(hydrateBullState({ groups: [legacy] }).groups[0]?.staleSinceMs, 0)
  assert.equal(hydrateBullState({ groups: [{ ...legacy, staleSinceMs: 'x' }] }).groups[0]?.staleSinceMs, 0)
})

test('cooldowns hydrate field by field; a bad one is dropped, a missing reason reads as none', () => {
  const back = hydrateBullState({
    cooldowns: [{ strike: 80_000, untilMs: 5 }, { strike: 'x', untilMs: 5 }, { strike: 80_200 }, null],
    entryRefusal: 7,
  })
  assert.deepEqual(back.cooldowns, [{ strike: 80_000, untilMs: 5, reason: '' }])
  assert.equal(back.entryRefusal, '')
})
