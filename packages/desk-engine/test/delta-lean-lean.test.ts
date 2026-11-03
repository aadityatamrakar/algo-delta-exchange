/**
 * THE DAY ROLL, AND THE HALF OF IT THAT MATTERS OPERATIONALLY.
 *
 * A NEW IST date clears the stop, the open, the adjustment counters and the
 * stuck clock: the book that stopped itself at a ₹25,000 loss yesterday trades
 * again this morning with no operator action and no restart.
 *
 * The SAME date returns the state UNCHANGED, and that is the half that matters:
 * a mid-session restart must never clear a stop the book set itself, or re-open
 * a second package against a book that already holds one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_PLAYBOOK_STATE, EMPTY_RULE_STATE, type RuleState } from '@algomaker/desk-engine'
import { rollDay } from '../src/delta-lean/lean.ts'

const DATE = '2026-09-15'
const NEXT = '2026-09-16'
const NOW = 1_789_444_800_000    // 2026-09-15 09:30:00 IST
const NEXT_DAY = 1_789_530_300_000 // 2026-09-16 09:15:00 IST

/** A book that traded yesterday and stopped itself doing it. */
function spent(over: Partial<RuleState> = {}): RuleState {
  return {
    ...EMPTY_RULE_STATE,
    dlDayStarted: DATE,
    dlStopped: true,
    dlOpenedMs: NOW - 3_600_000,
    dlOpenSide: 'up',
    dlAdjustsToday: 6,
    dlLastAdjustMs: NOW - 600_000,
    dlLastAdjustRegime: 'chop',
    dlRegime: 'chop',
    dlRegimeSinceMs: NOW - 300_000,
    dlBlockedSinceMs: NOW - 240_000,
    dlRupeeSinceMs: NOW - 20_000,
    dlDayRealized: -18_400,
    ...over,
  }
}

test('a new IST date clears the stop, the open, the counters and the stuck clock', () => {
  const s = rollDay(spent(), NEXT, NEXT_DAY)
  assert.equal(s.dlDayStarted, NEXT)
  assert.equal(s.dlStopped, false)
  assert.equal(s.dlOpenedMs, 0)
  assert.equal(s.dlOpenSide, '')
  assert.equal(s.dlAdjustsToday, 0)
  assert.equal(s.dlLastAdjustMs, 0)
  assert.equal(s.dlLastAdjustRegime, '')
  assert.equal(s.dlBlockedSinceMs, 0)
  assert.equal(s.dlDayRealized, 0)
})

test('the reset clears EVERY delta-lean field — a new field without a reset is a bug', () => {
  // Enumerated, not spot-checked: a field added to `RuleState` and forgotten
  // here carries yesterday's value into today's first decision, and the two
  // most dangerous carries (`dlStopped`, `dlOpenedMs`) are silent.
  const s = rollDay(spent(), NEXT, NEXT_DAY)
  const dl = Object.keys(s).filter((k) => k.startsWith('dl'))
  assert.equal(dl.length, 12, 'twelve delta-lean fields — update this test with the type')
  for (const key of dl) {
    if (key === 'dlDayStarted') continue        // set to the new date
    if (key === 'dlRegimeSinceMs') continue     // anchored, see below
    assert.deepEqual(
      s[key as keyof RuleState],
      EMPTY_RULE_STATE[key as keyof RuleState],
      `${key} must be back at its zero-value`,
    )
  }
})

test('the regime clock is ANCHORED at the roll, not zeroed', () => {
  // A zero would read as "the regime has been this way since the epoch", and
  // the very first tick of the session would satisfy `dl_adjust_confirm_s` and
  // open on an unconfirmed reading. Anchored, the morning's first confirm
  // window is measured from this morning.
  const s = rollDay(spent(), NEXT, NEXT_DAY)
  assert.equal(s.dlRegimeSinceMs, NEXT_DAY)
  assert.equal(s.dlRegime, '', 'and the label itself is unclassified, never "quiet"')
})

test('the same date is not a reset — a mid-session restart must not clear the stop', () => {
  const before = spent()
  const after = rollDay(before, DATE, NOW + 60_000)
  assert.equal(after, before, 'the SAME OBJECT: nothing was rewritten')
})

test('the first ever roll starts the day — "" is never, and never is not today', () => {
  const s = rollDay(EMPTY_RULE_STATE, DATE, NOW)
  assert.equal(s.dlDayStarted, DATE)
  assert.equal(s.dlRegimeSinceMs, NOW)
})

test('the reset leaves the recenter book`s state alone', () => {
  // One `RuleState` serves both decide paths. A roll that touched `rcCredit` or
  // the scrap ban list would corrupt a book that is not on this engine at all.
  const mixed: RuleState = {
    ...spent(),
    rcCredit: 12_500,
    rcEodDay: DATE,
    gkAnchor: 24_100,
    gkStreak: 4,
    scrapBanned: ['24000:CE:2026-09-22'],
    targetStreak: 2,
    targetLocked: true,
    rcStack: [{ strike: 24_000, optType: 'CE', lots: 2 }],
    lastActionMs: NOW - 1_000,
  }
  const s = rollDay(mixed, NEXT, NEXT_DAY)
  assert.equal(s.rcCredit, 12_500)
  assert.equal(s.rcEodDay, DATE)
  assert.equal(s.gkAnchor, 24_100)
  assert.equal(s.gkStreak, 4)
  assert.deepEqual(s.scrapBanned, ['24000:CE:2026-09-22'])
  assert.equal(s.targetStreak, 2)
  assert.equal(s.targetLocked, true)
  assert.deepEqual(s.rcStack, [{ strike: 24_000, optType: 'CE', lots: 2 }])
  assert.equal(s.lastActionMs, NOW - 1_000)
})

test('the reset moves STATE only — a leg that survived the night is not adopted', () => {
  // A book is flat by 15:00 (D4). If one somehow is not, `dlOpenedMs: 0` means
  // the new day opens its own package; the surviving leg is closed by the
  // EOD/latched-stop path, never pyramided on.
  const s = rollDay(spent({ dlStopped: false }), NEXT, NEXT_DAY)
  assert.equal(s.dlOpenedMs, 0)
})

// ── hold to expiry (spec 2026-10-05) ────────────────────────────────────────

test('a HOLD book keeps its open, its side and its stop across the date', () => {
  // Open once for the book's life, and an exit is terminal for the week: the
  // package laid on Monday is the package carried to expiry, and a target
  // banked on Tuesday is not re-opened on Wednesday.
  const s = rollDay(spent(), NEXT, NEXT_DAY, true)
  assert.equal(s.dlDayStarted, NEXT)
  assert.equal(s.dlStopped, true, 'the latch survives the roll')
  assert.equal(s.dlOpenedMs, NOW - 3_600_000, 'opened once, never re-opened')
  assert.equal(s.dlOpenSide, 'up', 'the posture is still read relative to the open')
})

test('a HOLD book still rolls the DAY: counters, cooldown, regime, stuck clock, day bank', () => {
  const s = rollDay(spent(), NEXT, NEXT_DAY, true)
  assert.equal(s.dlAdjustsToday, 0)
  assert.equal(s.dlLastAdjustMs, 0)
  assert.equal(s.dlLastAdjustRegime, '')
  assert.equal(s.dlBlockedSinceMs, 0)
  assert.equal(s.dlRupeeSinceMs, 0, 'the rupee hold too: a stretch never spans two sessions')
  assert.equal(s.dlDayRealized, 0)
  assert.equal(s.dlRegime, '')
  assert.equal(s.dlRegimeSinceMs, NEXT_DAY, 'anchored at the roll, as for an intraday book')
})

test('an INTRADAY book rolls exactly as before when the flag is passed false', () => {
  assert.deepEqual(rollDay(spent(), NEXT, NEXT_DAY, false), rollDay(spent(), NEXT, NEXT_DAY))
  const s = rollDay(spent(), NEXT, NEXT_DAY, false)
  assert.equal(s.dlStopped, false)
  assert.equal(s.dlOpenedMs, 0)
  assert.equal(s.dlOpenSide, '')
})

test('a HOLD book on the same date is not a reset either', () => {
  const before = spent()
  assert.equal(rollDay(before, DATE, NOW + 60_000, true), before)
})

// ── the playbook half (six-playbooks spec §4.3 step 0, §4.4) ────────────────

/** A playbook book that traded yesterday: session stats folded, one trade
 * taken and exiting, the day marked done. Every field away from its zero. */
function playedYesterday(): RuleState {
  return {
    ...spent(),
    pb: {
      ...EMPTY_PLAYBOOK_STATE,
      dayOpen: 24_010,
      dayHigh: 24_120,
      dayLow: 23_960,
      statsFromMs: NOW - 900_000,
      statsLastMs: NOW,
      dayImplied: 140,
      entries: 1,
      tradeOpenMs: NOW - 600_000,
      side: 'up',
      stage: 1,
      planShorts: [{ strike: 24_200, optType: 'CE', cover: 23_950 }],
      planLots: 2,
      maxGapMs: 3_000,
      stageReadyMs: NOW - 30_000,
      rupeeSinceMs: NOW - 2_000,
      exitMs: NOW - 120_000,
      exiting: true,
      exitReason: 'trend-drive: hard stop',
      exitUrgency: 'urgent',
      doneForDay: true,
      lastExitMs: NOW - 60_000,
    },
  }
}

test('a new IST date resets the playbook half to EMPTY_PLAYBOOK_STATE', () => {
  // Every field of `pb` is the DAY's: the open, high and low, the frozen day
  // move, today's entries and the trade's latches. Yesterday's `doneForDay`
  // carried into this morning would keep the book out all day, and yesterday's
  // `dayOpen` would judge today's moves from last night's level.
  const s = rollDay(playedYesterday(), NEXT, NEXT_DAY)
  assert.deepEqual(s.pb, EMPTY_PLAYBOOK_STATE)
})

test('the same date keeps the playbook half — the same object, mid-trade', () => {
  // A restart mid-trade must find the trade where it left it.
  const before = playedYesterday()
  const after = rollDay(before, DATE, NOW + 60_000)
  assert.equal(after, before)
  assert.equal(after.pb, before.pb)
})

test('a HOLD book`s roll resets the playbook half too — it is the day`s state on any book', () => {
  // `hold` keeps the delta-lean open, side and stop; it has no say over `pb`,
  // which no hold book reads and which is a single session's state wherever it
  // is.
  const s = rollDay(playedYesterday(), NEXT, NEXT_DAY, true)
  assert.deepEqual(s.pb, EMPTY_PLAYBOOK_STATE)
  assert.equal(s.dlStopped, true, 'and the hold book still keeps its own latch')
})
