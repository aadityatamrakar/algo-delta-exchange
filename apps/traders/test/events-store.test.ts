/** EventsStore: reads <nseDir>/events.json (risk spec R9, v1), re-reads on change, never throws. */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVENTS_FILE, EventsStore } from '../src/market/events-store.ts'

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'traders-events-'))
  roots.push(root)
  return root
}

const FIXTURE = {
  v: 1, writtenAt: '2026-10-24T15:00:00Z',
  upcoming: {
    MARUTI: [{ date: '2026-10-27', purpose: 'Financial Results' }],
    PAYTM: [{ date: '2026-11-02', purpose: 'Financial Results/Other business matters' }, { date: '2026-10-26', purpose: 'Financial Results' }, { date: '2026-10-26', purpose: 'Board Meeting Intimation' }],
    'M&M': [{ date: 'Nov 7', purpose: 'Financial Results' }, { date: '2026-11-07', purpose: 'Financial Results' }],
    'bad symbol': [{ date: '2026-10-30', purpose: 'Financial Results' }],
  },
  past: {
    TCS: { fetched: '2026-10-24T15:00:00Z', meetings: [{ date: '2026-07-09', purpose: 'Financial Results/Dividend' }, { date: '2026-01-12', purpose: 'Financial Results' }] },
  },
  errors: ['nse: 403 on corporate-board-meetings for X'],
}

test('a v1 file: each stock\'s meetings sorted, one per day, bad entries dropped and counted', async () => {
  const root = dir()
  writeFileSync(join(root, EVENTS_FILE), JSON.stringify(FIXTURE))
  const s = new EventsStore({ dir: root })
  assert.equal(s.writtenAt, null)
  await s.refresh()
  assert.equal(s.writtenAt, '2026-10-24T15:00:00Z')
  assert.deepEqual(s.upcoming('MARUTI'), [{ date: '2026-10-27', purpose: 'Financial Results' }])
  assert.deepEqual(s.upcoming('PAYTM').map((e) => [e.date, e.purpose]), [['2026-10-26', 'Financial Results'], ['2026-11-02', 'Financial Results/Other business matters']])
  assert.deepEqual(s.upcoming('M&M').map((e) => e.date), ['2026-11-07'])
  assert.deepEqual(s.past('TCS').map((e) => e.date), ['2026-01-12', '2026-07-09'])
  assert.deepEqual([s.upcoming('TCS'), s.past('MARUTI'), s.upcoming('bad symbol')], [[], [], []])
  assert.deepEqual([...s.upcomingAll().keys()].sort(), ['M&M', 'MARUTI', 'PAYTM'])
  // the job's own error text is never passed on; the store's count of what it dropped is
  assert.deepEqual(s.status(), { writtenAt: '2026-10-24T15:00:00Z', problems: ['events.json: 2 unreadable entries left out'], nseErrors: 1 })
})

test('a broken file is named and the last good read kept; a missing one is no calendar and no problem', async () => {
  const root = dir()
  const path = join(root, EVENTS_FILE)
  const s = new EventsStore({ dir: root })
  await s.refresh()
  assert.deepEqual([s.writtenAt, s.status().problems], [null, []])

  writeFileSync(path, '{"v": 1, "writtenAt": ')
  await s.refresh()
  assert.deepEqual(s.status(), { writtenAt: null, problems: ['events.json: not JSON'], nseErrors: 0 })
  assert.deepEqual(s.upcoming('MARUTI'), [])

  writeFileSync(path, JSON.stringify(FIXTURE))
  utimesSync(path, new Date(2026, 9, 24, 21), new Date(2026, 9, 24, 21))
  await s.refresh()
  assert.equal(s.upcoming('MARUTI').length, 1)

  writeFileSync(path, JSON.stringify({ ...FIXTURE, v: 2 }))
  utimesSync(path, new Date(2026, 9, 25, 21), new Date(2026, 9, 25, 21))
  await s.refresh()
  assert.deepEqual(s.status().problems, ['events.json: not a version 1 events file (the last good read is kept)'])
  assert.equal(s.upcoming('MARUTI').length, 1)
  assert.equal(s.writtenAt, '2026-10-24T15:00:00Z')

  rmSync(path)
  await s.refresh()
  assert.deepEqual([s.writtenAt, s.status().problems, s.upcoming('MARUTI')], [null, [], []])
})

test('an unchanged file is not parsed again; concurrent refreshes share one pass', async () => {
  const root = dir()
  const path = join(root, EVENTS_FILE)
  writeFileSync(path, JSON.stringify(FIXTURE))
  const s = new EventsStore({ dir: root })
  await Promise.all([s.refresh(), s.refresh()])
  const first = s.upcoming('MARUTI')
  await s.refresh()
  assert.equal(s.upcoming('MARUTI'), first, 'the same array: not read again')
  writeFileSync(path, JSON.stringify({ ...FIXTURE, upcoming: { MARUTI: [{ date: '2026-10-28', purpose: 'Financial Results' }] } }))
  utimesSync(path, new Date(2026, 9, 26, 21), new Date(2026, 9, 26, 21))
  await s.refresh()
  assert.deepEqual(s.upcoming('MARUTI').map((e) => e.date), ['2026-10-28'])
})

test('a held stock\'s meeting on the run\'s own day (NSE\'s calendar starts the next day) counts as coming', async () => {
  const root = dir()
  writeFileSync(join(root, EVENTS_FILE), JSON.stringify({
    v: 1, writtenAt: '2026-10-26T02:50:38Z', errors: [],
    upcoming: { MARUTI: [{ date: '2026-10-27', purpose: 'Financial Results' }] },
    past: {
      PAYTM: { fetched: '2026-10-26T02:50:38Z', meetings: [{ date: '2026-07-20', purpose: 'Financial Results' }, { date: '2026-10-26', purpose: 'Financial Results' }] },
      MARUTI: { fetched: '2026-10-26T02:50:38Z', meetings: [{ date: '2026-07-31', purpose: 'Financial Results' }, { date: '2026-10-27', purpose: 'Board Meeting Intimation' }] },
    },
  }))
  const s = new EventsStore({ dir: root })
  await s.refresh()
  assert.deepEqual(s.upcoming('PAYTM'), [{ date: '2026-10-26', purpose: 'Financial Results' }])
  assert.deepEqual(s.upcoming('MARUTI'), [{ date: '2026-10-27', purpose: 'Financial Results' }], 'the calendar\'s entry for a day wins')
  assert.deepEqual([...s.upcomingAll().keys()].sort(), ['MARUTI', 'PAYTM'])
  assert.equal(s.past('PAYTM').length, 2)
})
