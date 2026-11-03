import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EodStore } from '../src/analytics/eod.ts'

const FIXTURES = fileURLToPath(new URL('../../../packages/span/test/fixtures/eod', import.meta.url))
const FO = 'BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv'
const CM = 'BhavCopy_NSE_CM_0_0_0_20261016_F_0000.csv'
const MON_10_IST = Date.UTC(2026, 9, 19, 4, 30)
const WED_10_IST = Date.UTC(2026, 9, 21, 4, 30)

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

/** A fresh NSE folder holding Task 5's end-of-day fixtures for Fri 16 Oct. */
function nseDir(o: { fo?: string; cm?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'traders-eod-'))
  roots.push(root)
  mkdirSync(join(root, '2026-10-16'))
  copyFileSync(join(FIXTURES, o.fo ?? 'fo-udiff.csv'), join(root, '2026-10-16', FO))
  copyFileSync(join(FIXTURES, o.cm ?? 'cm-udiff.csv'), join(root, '2026-10-16', CM))
  return root
}

const CE = { stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3000, optType: 'CE' } as const
const FUT = { stock: 'TCS', instrument: 'future', expiry: '2026-10-27', strike: null, optType: null } as const
const SHARE = { stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null } as const

test('yesterday\'s files: status, close and OI', async () => {
  const s = new EodStore({ dir: nseDir(), now: () => MON_10_IST })
  await s.refresh()
  assert.deepEqual(s.status(), { day: '2026-10-16', fo: FO, cm: CM, missing: [] })
  assert.equal(s.close(CE), 44); assert.equal(s.oi(CE), 525000)
  assert.equal(s.close(FUT), 3005); assert.equal(s.oi(FUT), 1750000)
  assert.equal(s.close(SHARE), 2990); assert.equal(s.oi(SHARE), null)
  assert.equal(s.close({ ...CE, strike: 3200 }), null)
  assert.equal(s.close({ ...FUT, expiry: '2026-11-23' }), 3025)
  assert.equal(s.close({ ...FUT, expiry: '2026-12-29' }), null)
  assert.equal(s.close({ ...SHARE, stock: 'WIPRO' }), null)
})

test('the legacy generation reads the same', async () => {
  const s = new EodStore({ dir: nseDir({ fo: 'fo-legacy.csv', cm: 'cm-legacy.csv' }), now: () => MON_10_IST })
  await s.refresh()
  assert.deepEqual([s.close(CE), s.oi(CE), s.close(FUT), s.close(SHARE)], [44, 525000, 3005, 2990])
})

test('on a day the market is closed, yesterday is the trading day before the last session (final fix M2)', async () => {
  const at = (iso: string): number => Date.parse(`${iso}+05:30`)
  const day = (now: number): string => new EodStore({ dir: nseDir(), now: () => now }).status().day
  assert.equal(day(at('2026-10-24T12:00:00')), '2026-10-22')      // a Saturday shows Friday's session: Thursday's close
  assert.equal(day(at('2026-10-25T12:00:00')), '2026-10-22')
  assert.equal(day(at('2026-10-20T12:00:00')), '2026-10-16')      // a holiday Tuesday shows Monday's: Friday's close
  const clock = { now: at('2026-10-24T12:00:00') }
  const s = new EodStore({ dir: nseDir(), now: () => clock.now })
  clock.now = at('2026-10-26T10:00:00')                              // Monday: the clock's day again
  await s.refresh()
  assert.equal(s.status().day, '2026-10-23')
})

test('nothing is read before the first refresh', () => {
  const s = new EodStore({ dir: nseDir(), now: () => MON_10_IST })
  assert.deepEqual(s.status(), { day: '2026-10-16', fo: null, cm: null, missing: [FO, CM] })
  assert.equal(s.close(CE), null)
})

test('the day follows the clock: Wednesday reads Monday (20 Oct is a holiday), and no folder means both files missing', async () => {
  const clock = { now: MON_10_IST }
  const s = new EodStore({ dir: nseDir(), now: () => clock.now })
  await s.refresh()
  assert.equal(s.close(CE), 44)
  clock.now = WED_10_IST
  await s.refresh()
  assert.deepEqual(s.status(), {
    day: '2026-10-19', fo: null, cm: null,
    missing: ['BhavCopy_NSE_FO_0_0_0_20261019_F_0000.csv', 'BhavCopy_NSE_CM_0_0_0_20261019_F_0000.csv'],
  })
  for (const c of [CE, FUT, SHARE]) assert.equal(s.close(c), null)
  assert.equal(s.oi(CE), null)
})

test('a truncated F&O file is missing, named with its parse error; the cash file still reads', async () => {
  const dir = nseDir()
  const full = readFileSync(join(FIXTURES, 'fo-udiff.csv'), 'utf8').split('\n')
  writeFileSync(join(dir, '2026-10-16', FO), `${full[0]}\n${full[1]!.slice(0, 60)}`)
  const s = new EodStore({ dir, now: () => MON_10_IST })
  await s.refresh()
  const st = s.status()
  assert.deepEqual([st.fo, st.cm], [null, CM])
  assert.equal(st.missing.length, 1)
  assert.match(st.missing[0]!, new RegExp(`^${FO.replace(/\./g, '\\.')}: no row could be read`))
  assert.equal(s.close(CE), null)
  assert.equal(s.close(SHARE), 2990)
})

test('a file that appears later, or changes, is read on the next refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traders-eod-'))
  roots.push(dir)
  const s = new EodStore({ dir, now: () => MON_10_IST })
  await s.refresh()
  assert.deepEqual(s.status().missing, [FO, CM])
  mkdirSync(join(dir, '2026-10-16'))
  copyFileSync(join(FIXTURES, 'cm-udiff.csv'), join(dir, '2026-10-16', CM))
  await s.refresh()
  assert.deepEqual([s.status().cm, s.status().missing, s.close(SHARE)], [CM, [FO], 2990])
  const path = join(dir, '2026-10-16', CM)
  writeFileSync(path, readFileSync(path, 'utf8').replace(',2990,', ',2999,'))
  utimesSync(path, new Date(MON_10_IST), new Date(MON_10_IST + 60_000))
  await s.refresh()
  assert.equal(s.close(SHARE), 2999)
})

test('refresh never throws: a folder that is a file, or a file that is a folder, is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'traders-eod-'))
  roots.push(root)
  writeFileSync(join(root, 'not-a-dir'), 'x')
  const a = new EodStore({ dir: join(root, 'not-a-dir'), now: () => MON_10_IST })
  await a.refresh()
  assert.deepEqual(a.status().missing, [FO, CM])
  mkdirSync(join(root, '2026-10-16', FO), { recursive: true })
  const b = new EodStore({ dir: root, now: () => MON_10_IST })
  await b.refresh()
  assert.deepEqual(b.status().missing, [`${FO}: not a file`, CM])
})

test('concurrent refreshes share one read', async () => {
  const s = new EodStore({ dir: nseDir(), now: () => MON_10_IST })
  const [p, q] = [s.refresh(), s.refresh()]
  assert.equal(p, q)
  await p
  assert.equal(s.close(CE), 44)
})
