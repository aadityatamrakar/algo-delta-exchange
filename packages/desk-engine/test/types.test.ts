/**
 * THE SHAPE OF THE SPINE, PINNED AT THE BOUNDARY.
 *
 * Every later ticket in this migration imports its types from
 * `@algomaker/desk-engine`, so a rename here is a silent break there. This
 * suite is a COMPILE-SHAPE test first and a runtime test second: it builds one
 * `EngineInputs` and one `DecisionRequest` from literals, which is the only
 * thing that proves the declarations are constructible at all under
 * `exactOptionalPropertyTypes` — an optional field typed `T` rather than
 * `T | undefined` type-checks fine in isolation and rejects every literal a
 * caller can actually write (design spec §9).
 *
 * The two constants are asserted because they are the ones other processes
 * agree on out-of-band: `EMPTY_RULE_STATE` is what a book restarts from
 * (absent-vs-zero killed the Python port — §5), and `ENGINE_DECISIONS_PATH`
 * is the route the supervisor POSTs to and desk-api serves.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_PLAYBOOK_STATE,
  EMPTY_RULE_STATE,
  ENGINE_DECISIONS_PATH,
  SUPERVISOR_NUDGE_PORT_DEFAULT,
  TRIGGERS,
  type DecisionRequest,
  type EngineInputs,
  type Quote,
  type Trigger,
} from '@algomaker/desk-engine'

test('canonical constants', () => {
  assert.equal(EMPTY_RULE_STATE.targetStreak, 0)
  assert.equal(ENGINE_DECISIONS_PATH, '/v1/desk/engine/decisions')
})

test('EMPTY_RULE_STATE spells out every zero-value', () => {
  assert.deepEqual(EMPTY_RULE_STATE, {
    rcCredit: 0,
    rcEodDay: '',
    gkAnchor: 0,
    gkStreak: 0,
    scrapBanned: [],
    targetStreak: 0,
    targetLocked: false,
    rcStack: [],
    lastActionMs: 0,
    // The delta-lean book's half of the row (hold-and-adjust spec §3). Listed
    // one by one for the same reason as the recenter half: this literal IS the
    // field-for-field agreement between `RuleState` and `EMPTY_RULE_STATE`, and
    // a new field that reaches production without an explicit zero-value here
    // is the absent-vs-zero trap reopening.
    //
    // There is ONE P&L level now, and it is the DAY's. `dlDayRealized` is
    // written by the host's `#settle` and read by nothing in the engine — the
    // day budget and the day target are both `totalPnl(inputs)`, banked plus
    // the open book's mark, because a number counting only BANKED money would
    // ignore the open loss the backstop exists to stop.
    dlDayStarted: '',
    dlStopped: false,
    dlOpenedMs: 0,
    dlOpenSide: '',
    dlAdjustsToday: 0,
    dlLastAdjustMs: 0,
    dlLastAdjustRegime: '',
    dlRegime: '',
    dlRegimeSinceMs: 0,
    dlBlockedSinceMs: 0,
    dlRupeeSinceMs: 0,
    dlDayRealized: 0,
    // The playbook path's half (six-playbooks spec §4.4): ONE nested row, the
    // playbook frame's alone, and spelled out field by field for the same
    // reason as everything above — a playbook field that reaches production
    // without an explicit zero here is a latch or a clock read as `undefined`.
    pb: {
      dayOpen: 0,
      dayHigh: 0,
      dayLow: 0,
      statsFromMs: 0,
      statsLastMs: 0,
      maxGapMs: 0,
      dayImplied: 0,
      entries: 0,
      tradeOpenMs: 0,
      side: '',
      stage: 0,
      planShorts: [],
      planLots: 0,
      stageMs: 0,
      stageSpot: 0,
      stageReadyMs: 0,
      entrySpot: 0,
      entryStr: 0,
      entryExtreme: 0,
      boxHi: 0,
      boxLo: 0,
      basePnl: 0,
      peakPnl: 0,
      trailArmed: false,
      adds: 0,
      condSinceMs: 0,
      rupeeSinceMs: 0,
      exiting: false,
      exitReason: '',
      exitUrgency: '',
      exitMs: 0,
      doneForDay: false,
      lastExitMs: 0,
      dayLineSinceMs: 0,
    },
    // The BULL-S path's row (Delta spec §6.3): one nested object, spelled out
    // for the same reason — a book that has never armed.
    bs: {
      groups: [],
      size: 0,
      lastRef: 0,
      lastRefMs: 0,
      halted: false,
      haltReason: '',
      armedAtMs: 0,
      pnlBaseline: 0,
      closeReqSeen: 0,
      rearmReqSeen: 0,
      cooldowns: [],
      entryRefusal: '',
    },
  })
  assert.equal(SUPERVISOR_NUDGE_PORT_DEFAULT, 8893)
})

test('a fresh book`s playbook half IS EMPTY_PLAYBOOK_STATE, and it is the row`s last field', () => {
  // One spelling of "a playbook that has not traded today" — the day roll
  // writes this same value, so a fresh row and a rolled one cannot disagree.
  assert.equal(EMPTY_RULE_STATE.pb, EMPTY_PLAYBOOK_STATE)
  // LAST but one — only BULL-S's `bs`, added after it, follows — so every
  // field before it keeps its position in a stored row and in the
  // `JSON.stringify` equality `sameRuleState` is.
  assert.deepEqual(Object.keys(EMPTY_RULE_STATE).slice(-2), ['pb', 'bs'])
  // The order the hydrator writes keys in, pinned: `sameRuleState` compares
  // strings, so a reordering here is a state change on every row after a
  // deploy.
  assert.deepEqual(Object.keys(EMPTY_PLAYBOOK_STATE), [
    'dayOpen', 'dayHigh', 'dayLow', 'statsFromMs', 'statsLastMs', 'maxGapMs', 'dayImplied',
    'entries', 'tradeOpenMs', 'side', 'stage', 'planShorts', 'planLots',
    'stageMs', 'stageSpot', 'stageReadyMs',
    'entrySpot', 'entryStr', 'entryExtreme', 'boxHi', 'boxLo',
    'basePnl', 'peakPnl', 'trailArmed', 'adds', 'condSinceMs', 'rupeeSinceMs',
    'exiting', 'exitReason', 'exitUrgency', 'exitMs', 'doneForDay', 'lastExitMs',
    'dayLineSinceMs',
  ])
})

test('the trigger list is the hold-and-adjust set, and the old controller`s five are gone', () => {
  // desk-api validates an incoming trigger against this VALUE
  // (`apps/api/src/routes/engine.ts`), so a trigger the engine can emit and the
  // list does not name is a 400 on the wire — and one the list names and no
  // rule emits is a name an operator will look for in a journal and never find.
  for (const t of ['dl-open', 'dl-neutral', 'dl-add', 'dl-target', 'dl-stuck', 'dl-stop', 'dl-exit']) {
    assert.ok(TRIGGERS.includes(t as Trigger), `${t} must be a trigger`)
  }
  for (const gone of ['dl-lean', 'dl-cut', 'dl-flip', 'dl-theta', 'dl-roll']) {
    assert.ok(!(TRIGGERS as readonly string[]).includes(gone), `${gone} is deleted`)
  }
  // The recenter engine's eleven are untouched — widening or narrowing the
  // delta-lean half must move nothing on the other decide path.
  // (BULL-S's eight are pinned in test/bull-s/state.test.ts.)
  assert.deepEqual(
    TRIGGERS.filter((t) => !t.startsWith('dl-') && !t.startsWith('bs-')),
    ['shift', 'shed', 'scrap', 'lock', 'margin', 'expiry', 'eod', 'recycle', 'unwind', 'balance', 'none'],
  )
})

test('dl-exit, the playbook`s own exit, is a trigger and sits right after dl-stuck', () => {
  // desk-api refuses a trigger this list does not name, so a playbook exit
  // routed before this line existed would be a 400 on the wire — on the one
  // decision that takes risk off. Appended after the six, so nothing before it
  // moves.
  assert.deepEqual(
    TRIGGERS.filter((t) => t.startsWith('dl-')),
    ['dl-stop', 'dl-open', 'dl-add', 'dl-neutral', 'dl-target', 'dl-stuck', 'dl-exit'],
  )
})

test('an EngineInputs is constructible from a literal', () => {
  const q: Quote = { bid: 12.1, ask: 12.4, ltp: 12.2, asOf: 1_700_000_000_000 }
  const inputs: EngineInputs = {
    tag: 'TCS_RELIEF',
    mode: 'paper',
    nowMs: 1_700_000_000_000,
    dateIst: '2026-08-24',
    minuteOfDay: 600,
    dte: 4,
    chain: {
      symbol: 'TCS',
      expiry: '2026-08-25',
      step: 20,
      lotSize: 175,
      future: { bid: 2334, ask: 2336, ltp: 2335, asOf: 1_700_000_000_000 },
      spot: 2335,
      strikes: [{ strike: 2340, ce: q, pe: null }],
      asOf: 1_700_000_000_000,
    },
    legs: [
      {
        instrument: 'TCS26AUG2340CE',
        strike: 2340,
        optType: 'CE',
        side: 'Sell',
        lots: 2,
        lotSize: 175,
        entry: 30.5,
        openedByEngine: true,
        // Unstamped — no delta-lean lean opened this fixture leg (Task 9A).
        leanId: '',
        iv: 0.28,
        delta: 0.42,
        gamma: 0.0031,
        // Inert on every recenter path — nothing here reads either greek. Carried
        // because `LegView` requires them (`types.ts`): theta per calendar day,
        // vega per vol point, both per-share.
        theta: 0,
        vega: 0,
        hasGreeks: true,
        mtm: -1200,
        exit: q,
      },
    ],
    protectedQty: { TCS26AUG2340CE: 1 },
    cumRealized: 0,
    margin: {
      value: 4_290_000,
      source: 'broker',
      asOf: 1_700_000_000_000,
      fresh: true,
    },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
  }
  assert.equal(inputs.legs[0]?.hasGreeks, true)
  assert.equal(inputs.chain.strikes[0]?.pe, null)
})

/**
 * The optional wire fields are the `exactOptionalPropertyTypes` tripwire: a
 * caller that has no limit price must be able to omit the key entirely, and a
 * caller that computed one must be able to pass it. Both spellings compile
 * only if the field is declared `?: T | undefined`.
 */
test('a DecisionRequest carries actions with and without a limit price', () => {
  const req: DecisionRequest = {
    tag: 'TCS_RELIEF',
    mode: 'live',
    decisionId: 'TCS_RELIEF:live:7',
    symbol: 'TCS',
    expiry: '2026-08-25',
    trigger: 'shift',
    reason: 'margin 62% of cap; 2440CE 0.5 steps ITM',
    actions: [
      { op: 'close', instrument: 'TCS26AUG2440CE' },
      {
        op: 'open',
        instrument: 'TCS26AUG2380CE',
        side: 'Sell',
        qty: 350,
        limitPrice: 18.4,
        workMode: 'passive',
      },
    ],
  }
  assert.equal(req.decisionId, 'TCS_RELIEF:live:7')
  assert.equal(req.actions.length, 2)
  assert.equal(req.actions[1]?.op, 'open')
})
