/**
 * THE PLAYBOOK'S HALF OF THE STATE ROW, READ BACK FROM WHATEVER WROTE IT.
 *
 * `RuleState.pb` lives in a Mongo document that every supervisor build since
 * the playbooks shipped has written — and every build before them wrote
 * without it. `hydratePlaybookState` is the one door that document comes back
 * through, so it is pinned for the three ways a restart can go wrong:
 *
 *   1. A ROW WITH NO `pb` (written before playbooks existed) must read as a
 *      book that has not traded today: `EMPTY_PLAYBOOK_STATE`, every field
 *      present, never `undefined`.
 *   2. A ROW WRITTEN MID-TRADE must read back as THAT trade, field for field —
 *      a dropped `exiting` stops re-sending an exit that has not finished, a
 *      dropped `stage` sells the shorts of a package twice or never, and a
 *      dropped `tradeOpenMs` reads the trade's own legs as legs nobody opened
 *      (review focus 3).
 *   3. A HAND-EDITED OR CORRUPT ROW must degrade to zero-values, never to a
 *      value the engine branches on wrongly: an unrecognised side is not a
 *      side, and a stage-2 short with no strike is not a short.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_PLAYBOOK_STATE,
  hydratePlaybookState,
  type PlaybookState,
} from '@algomaker/desk-engine'

const NOW = Date.UTC(2026, 9, 16, 4, 30) // 2026-10-16 10:00 IST

/** A trade half-way through stage 2, with an exit latched: every field away
 * from its zero, so a hydrator that forgets one cannot pass. */
const MID_TRADE: PlaybookState = {
  dayOpen: 24_010.5,
  dayHigh: 24_088,
  dayLow: 23_990.25,
  statsFromMs: NOW - 45 * 60_000,
  statsLastMs: NOW - 1_000,
  maxGapMs: 4_000,
  dayImplied: 141.75,
  entries: 1,
  tradeOpenMs: NOW - 20 * 60_000,
  side: 'up',
  stage: 1,
  planShorts: [
    { strike: 24_200, optType: 'CE', cover: 24_400 },
    { strike: 23_800, optType: 'PE', cover: 23_600 },
  ],
  planLots: 2,
  stageMs: NOW - 30_000,
  stageSpot: 24_051.2,
  stageReadyMs: NOW - 15_000,
  entrySpot: 24_040,
  entryStr: 236.4,
  entryExtreme: 24_102,
  boxHi: 24_060,
  boxLo: 23_995,
  basePnl: -1_250.5,
  peakPnl: 3_180,
  trailArmed: true,
  adds: 1,
  condSinceMs: NOW - 12_000,
  rupeeSinceMs: NOW - 2_000,
  exiting: true,
  exitReason: 'trend-drive: debit stop — Rs-5,210 through 50% of the Rs10,420 debit',
  exitUrgency: 'urgent',
  exitMs: NOW - 5_000,
  doneForDay: true,
  lastExitMs: NOW - 3_600_000,
  dayLineSinceMs: NOW - 2_500,
}

test('a row with no pb at all reads as EMPTY_PLAYBOOK_STATE, every field present', () => {
  assert.deepEqual(hydratePlaybookState(undefined), EMPTY_PLAYBOOK_STATE)
  for (const raw of [null, 0, 'pb', true, [], [MID_TRADE]]) {
    assert.deepEqual(hydratePlaybookState(raw), EMPTY_PLAYBOOK_STATE, JSON.stringify(raw))
  }
  assert.deepEqual(hydratePlaybookState({}), EMPTY_PLAYBOOK_STATE)
})

test('a mid-trade state round-trips through JSON and the hydrator, field for field', () => {
  const back = hydratePlaybookState(JSON.parse(JSON.stringify(MID_TRADE)))
  assert.deepEqual(back, MID_TRADE)
  // `sameRuleState` is `JSON.stringify` equality, so the key ORDER is part of
  // the contract: a hydrated row must stringify exactly as the state it was
  // written from, or every pass after a restart reads as a state change.
  assert.equal(JSON.stringify(back), JSON.stringify(MID_TRADE))
})

test('the keys come back in EMPTY_PLAYBOOK_STATE order, whatever order the row stored', () => {
  const reversed = Object.fromEntries(Object.entries(MID_TRADE).reverse())
  const back = hydratePlaybookState(reversed)
  assert.deepEqual(Object.keys(back), Object.keys(EMPTY_PLAYBOOK_STATE))
  assert.equal(JSON.stringify(back), JSON.stringify(MID_TRADE))
})

test('a row the first playbook build wrote, before the day lines held, loads: no dayLineSinceMs reads as 0, every other field as written', () => {
  const older: Record<string, unknown> = JSON.parse(JSON.stringify(MID_TRADE))
  delete older['dayLineSinceMs']
  const back = hydratePlaybookState(older)
  const want: PlaybookState = { ...MID_TRADE, dayLineSinceMs: 0 }
  assert.deepEqual(back, want)
  assert.equal(JSON.stringify(back), JSON.stringify(want), 'key for key, in EMPTY order')
})

test('an unknown key is ignored, not carried', () => {
  const back = hydratePlaybookState({ ...MID_TRADE, legacyLean: 'dl-up-1', entries: 1 })
  assert.equal('legacyLean' in back, false)
  assert.deepEqual(back, MID_TRADE)
})

test('a malformed planShorts entry is DROPPED, not zero-filled', () => {
  // A stage-2 short read as `strike: 0` would route a sale of a strike that is
  // not listed; one read as `optType: ''` would sell nobody knows what; one
  // read as `cover: 0` would wait on a protective leg that cannot exist.
  const back = hydratePlaybookState({
    planShorts: [
      { strike: 24_200, optType: 'CE', cover: 24_400 },
      { strike: '24300', optType: 'CE', cover: 24_500 },
      { strike: 24_300, cover: 24_500 },
      { optType: 'PE', cover: 23_600 },
      { strike: 23_800, optType: 'XX', cover: 23_600 },
      { strike: null, optType: 'PE', cover: 23_600 },
      { strike: 24_200, optType: 'CE' },
      { strike: 24_200, optType: 'CE', cover: '24400' },
      { strike: 24_200, optType: 'CE', cover: null },
      { strike: 24_200, optType: 'CE', cover: Number.POSITIVE_INFINITY },
      null,
      7,
      'CE',
      [24_000, 'PE', 23_800],
      { strike: 23_800, optType: 'PE', cover: 23_600, lots: 9, side: 'Buy' },
    ],
  })
  assert.deepEqual(back.planShorts, [
    { strike: 24_200, optType: 'CE', cover: 24_400 },
    // The good entry keeps its three fields and NOTHING else — an extra key in
    // the plan would ride into every later state and every journal row.
    { strike: 23_800, optType: 'PE', cover: 23_600 },
  ])
})

test('a planShorts that is not a list reads as no plan', () => {
  assert.deepEqual(
    hydratePlaybookState({ planShorts: { strike: 24_200, optType: 'CE', cover: 24_400 } }).planShorts,
    [],
  )
  assert.deepEqual(hydratePlaybookState({ planShorts: 'CE' }).planShorts, [])
})

test('a row written before the v2 shape reads its retired planAdd as nothing', () => {
  // `planAdd` is gone (a pyramid add is a single-stage buy now). A row that
  // still carries it must neither keep the key nor let it change anything.
  const back = hydratePlaybookState({ ...MID_TRADE, planAdd: true })
  assert.equal('planAdd' in back, false)
  assert.deepEqual(back, MID_TRADE)
})

test('a wrong-typed field falls back to its zero, and is never coerced', () => {
  // `'1'` for a count and `1` for a flag are what a hand-edited document looks
  // like; coercing either turns a typo into a latch nobody set.
  const back = hydratePlaybookState({
    ...MID_TRADE,
    entries: '1',
    dayOpen: null,
    exiting: 1,
    trailArmed: 'true',
    doneForDay: 0,
    exitReason: 42,
    stage: true,
    lastExitMs: { $date: NOW },
    stageReadyMs: '5',
    exitMs: true,
    maxGapMs: [4_000],
  })
  assert.equal(back.entries, 0)
  assert.equal(back.dayOpen, 0)
  assert.equal(back.exiting, false)
  assert.equal(back.trailArmed, false)
  assert.equal(back.doneForDay, false)
  assert.equal(back.exitReason, '')
  assert.equal(back.stage, 0)
  assert.equal(back.lastExitMs, 0)
  assert.equal(back.stageReadyMs, 0)
  assert.equal(back.exitMs, 0)
  assert.equal(back.maxGapMs, 0)
  // and the fields that WERE well-formed are untouched by their neighbours
  assert.equal(back.dayHigh, MID_TRADE.dayHigh)
  assert.equal(back.tradeOpenMs, MID_TRADE.tradeOpenMs)
})

test('a non-finite number reads as its zero — a NaN clock never fires and never clears', () => {
  const back = hydratePlaybookState({
    ...MID_TRADE,
    condSinceMs: Number.NaN,
    rupeeSinceMs: Number.NaN,
    peakPnl: Number.POSITIVE_INFINITY,
    basePnl: Number.NEGATIVE_INFINITY,
    dayLineSinceMs: Number.NaN,
  })
  assert.equal(back.condSinceMs, 0)
  assert.equal(back.rupeeSinceMs, 0)
  assert.equal(back.dayLineSinceMs, 0)
  assert.equal(back.peakPnl, 0)
  assert.equal(back.basePnl, 0)
})

test('side "sideways" reads as "" — not a side the book never chose', () => {
  assert.equal(hydratePlaybookState({ side: 'sideways' }).side, '')
  assert.equal(hydratePlaybookState({ side: 'UP' }).side, '')
  assert.equal(hydratePlaybookState({ side: 1 }).side, '')
  for (const side of ['up', 'down', 'none', ''] as const) {
    assert.equal(hydratePlaybookState({ side }).side, side)
  }
})

test('exitUrgency "fast" reads as "" — the frame then re-sends at its own default', () => {
  assert.equal(hydratePlaybookState({ exitUrgency: 'fast' }).exitUrgency, '')
  assert.equal(hydratePlaybookState({ exitUrgency: 'URGENT' }).exitUrgency, '')
  for (const u of ['passive', 'urgent', 'ladder', ''] as const) {
    assert.equal(hydratePlaybookState({ exitUrgency: u }).exitUrgency, u)
  }
})
