/**
 * WHEN the daily instrument sync fires.
 *
 * It used to be `setInterval(..., 60_000)` testing
 * `nowIst.getUTCMinutes() === 45`, which relies on a timer landing inside one
 * specific 60-second box roughly 525 times a day. Timers drift — event-loop
 * pressure, a slow Mongo round trip, a cold process — and a drift of a second
 * per tick eventually steps straight over the box. The whole day's sync is then
 * SKIPPED, and nothing anywhere is an error: the master is simply stale, so a
 * newly listed weekly expiry cannot be resolved and every strategy on it
 * declines to trade for reasons nobody can see.
 *
 * The replacement asks "have I done today's yet", which a late tick still
 * answers correctly and a repeated tick answers only once.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { istMinutes, laterFreezeDay, refreshFreezeDay, syncDue, SYNC_IST_MINUTE } from '../src/main.ts'

/** 2026-07-24 is a Friday. IST = UTC + 05:30, no DST, so this is exact. */
const ist = (h: number, m: number): number => Date.UTC(2026, 6, 24, h - 5, m - 30)

test('istMinutes converts to IST minute-of-day', () => {
  assert.equal(istMinutes(ist(8, 45)), SYNC_IST_MINUTE)
  assert.equal(istMinutes(ist(9, 15)), 555)
  assert.equal(istMinutes(ist(0, 0)), 0)
})

test('the sync is owed from 08:45 IST and not before', () => {
  assert.equal(syncDue(ist(8, 44), ''), false)
  assert.equal(syncDue(ist(8, 45), ''), true)
})

test('a LATE tick still fires it — this is the drift the old check dropped', () => {
  /**
   * The whole point. `getUTCMinutes() === 45` is false at 08:46, so a timer
   * that arrived one minute late skipped the sync until the next calendar day.
   * A `>=` against a day already recorded fires on the first tick after the
   * deadline, whenever that is.
   */
  assert.equal(syncDue(ist(8, 46), ''), true)
  assert.equal(syncDue(ist(9, 30), ''), true)
  assert.equal(syncDue(ist(14, 0), ''), true)
})

test('once today is done it does not fire again, however many ticks arrive', () => {
  const today = '2026-07-24'
  for (const [h, m] of [
    [8, 45],
    [8, 46],
    [9, 15],
    [15, 30],
    [23, 59],
  ] as const) {
    assert.equal(syncDue(ist(h, m), today), false, `${h}:${m} must not re-sync`)
  }
})

test('the next IST day owes a fresh one', () => {
  // Saturday 08:45 IST, with Friday recorded.
  assert.equal(syncDue(Date.UTC(2026, 6, 25, 3, 15), '2026-07-24'), true)
})

test('the day key is the IST calendar day, not the UTC one', () => {
  /**
   * 19:00 UTC on the 24th is 00:30 IST on the 25th — already tomorrow for an
   * Indian exchange, and past midnight UTC-4.5h. It is NOT due (08:45 has not
   * come round), but the day it will be keyed against is the 25th:
   *
   *   - recorded '2026-07-25' -> not owed even after 08:45, and
   *   - recorded '2026-07-24' -> owed at 08:45 IST on the 25th.
   *
   * A UTC-keyed day would still call that instant the 24th and skip a sync.
   */
  assert.equal(syncDue(Date.UTC(2026, 6, 24, 19, 0), '2026-07-24'), false, 'before 08:45 IST')
  assert.equal(syncDue(Date.UTC(2026, 6, 25, 3, 16), '2026-07-24'), true, "the new IST day's sync")
  assert.equal(syncDue(Date.UTC(2026, 6, 25, 3, 16), '2026-07-25'), false, 'already done')
})

// -------------------------------------------------------- the freeze table

/**
 * WHAT ELSE THE DAILY SYNC OWES (audit F-12).
 *
 * `syncFreezeLimits` was called by `make sync` and by nothing that runs. The
 * NSE freeze table therefore aged from whenever someone last typed the command:
 * a stale row UNDER-splits after a revision and the exchange rejects the tranche
 * — the exact `xtsOrder.js:104` failure the splitter was written to design out
 * — and a missing row sends a 100-lot order unsplit. Neither is visible
 * anywhere, which is why the day it last succeeded is now published on
 * `md.health`.
 *
 * The refresh is FAIL-SOFT by contract (`sync-runner.ts`): a failed fetch keeps
 * the PREVIOUS table, because an empty table means every limit is unknown and an
 * unknown limit means orders go out unsplit. So the day marker must not move
 * either — recording today for a sync that did not happen is exactly the lie
 * the field exists to prevent.
 */

test('a freeze sync that succeeded records TODAY', async () => {
  const logs: string[] = []
  const day = await refreshFreezeDay({
    run: async () => 215,
    nowMs: ist(8, 45),
    previous: '2026-07-23',
    log: (m) => void logs.push(m),
  })
  assert.equal(day, '2026-07-24')
})

test('a freeze sync that failed keeps the PREVIOUS day, and says so', async () => {
  const logs: string[] = []
  const day = await refreshFreezeDay({
    // `syncFreezeLimits` answers null when it kept the old table.
    run: async () => null,
    nowMs: ist(8, 45),
    previous: '2026-07-23',
    log: (m) => void logs.push(m),
  })
  assert.equal(day, '2026-07-23', 'the table is yesterday’s, so the marker must be too')
  assert.ok(
    logs.some((l) => /freeze/i.test(l)),
    'a table nobody refreshed must not be silent',
  )
})

test('a freeze sync that THREW does not take the instrument sync down with it', async () => {
  // It is fail-soft by contract today. This pins that the daily sync does not
  // depend on that contract holding: order splitting is a money path, and a
  // future change there must not be able to skip the instrument master.
  const day = await refreshFreezeDay({
    run: async () => {
      throw new Error('nsearchives unreachable')
    },
    nowMs: ist(8, 45),
    previous: '',
    log: () => {},
  })
  assert.equal(day, '', 'never synced stays never synced')
})

test('refreshFreezeDay names the source it is reporting on', async () => {
  // Two tables ride this helper now — NSE's qtyfreeze.csv and BSE's contract
  // master — and they fail independently. A warning that just says "the
  // freeze table" sends the operator to the wrong site.
  const logs: string[] = []
  const day = await refreshFreezeDay({
    run: async () => null,
    nowMs: ist(8, 45),
    previous: '',
    label: 'BSE freeze table',
    log: (m) => void logs.push(m),
  })
  assert.equal(day, '')
  assert.ok(logs.some((l) => /BSE freeze table was NOT refreshed/.test(l)), logs.join('\n'))
})

// ------------------------------------------------- the first-boot BSE sync

/**
 * The first-boot BSE sync (a table with no BSE row yet) is FIRE-AND-FORGET:
 * `defaultFetchBseZip` has a 30 s timeout and bseindia.com walls this box, so
 * awaiting it made every `pm2 restart dx-marketdata` — a pre-open bounce
 * included — pause up to half a minute before serving marks. Un-awaited, its
 * result lands whenever it lands, possibly AFTER the 08:45 daily refresh has
 * already written today's marker — so the merge must never move the marker
 * backwards, and a failed boot fetch (which answers the '' it was given) must
 * not erase a day the daily refresh recorded meanwhile.
 */

test('a background refresh that landed a day records it', () => {
  assert.equal(laterFreezeDay('', '2026-07-24'), '2026-07-24')
})

test('a background refresh that failed after the daily one succeeded does not erase the day', () => {
  // The boot fetch was handed previous '' and answers '' on failure; by then
  // the 08:45 trigger has recorded today.
  assert.equal(laterFreezeDay('2026-07-24', ''), '2026-07-24')
})

test('the marker never moves backwards, and the same day is a no-op', () => {
  assert.equal(laterFreezeDay('2026-07-24', '2026-07-23'), '2026-07-24')
  assert.equal(laterFreezeDay('2026-07-24', '2026-07-24'), '2026-07-24')
  assert.equal(laterFreezeDay('2026-07-23', '2026-07-24'), '2026-07-24')
})
