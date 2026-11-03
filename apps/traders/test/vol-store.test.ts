/** VolStore: reads data/nse/vol/<date>.json (the golden file is the one scripts/test_nse_vol_job.py pins the job to). */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atmIvOf } from '../src/market/history.ts'
import { VolStore } from '../src/market/vol-store.ts'

const GOLDEN = fileURLToPath(new URL('./fixtures/vol/2026-10-22.json', import.meta.url))
const NOW = Date.UTC(2026, 9, 22, 15, 0)

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const older = (nearIvs: [number, number]) => JSON.stringify({
  v: 1, date: '2026-10-21', writtenAt: 1, cmvolt: { file: 'CMVOLT_21102026.CSV', symbols: { TCS: [0.018, 0.34], ZZZ: [0.01, 0.2] } }, errors: [],
  stocks: { TCS: { spot: 2528.92, sources: ['nse'], errors: [], next: null,
    near: { expiry: '2026-10-27', rolled: false, future: 2530, strikes: [[2525, null, null, ...nearIvs]] } } },
})

function nseDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'traders-vol-'))
  roots.push(root)
  mkdirSync(join(root, 'vol'))
  copyFileSync(GOLDEN, join(root, 'vol', '2026-10-22.json'))
  writeFileSync(join(root, 'vol', '2026-10-21.json'), older([0.20, 0.22]))
  writeFileSync(join(root, 'vol', 'notes.txt'), 'not a day')
  return root
}

test('every day file is read, a stock\'s days come oldest first, and the newest day carries the term and skew', async () => {
  const s = new VolStore({ dir: nseDir(), now: () => NOW })
  await s.refresh()
  const tcs = s.days('TCS')
  assert.deepEqual(tcs.map((d) => [d.date, d.nearExpiry, d.nearIvSource]), [['2026-10-21', '2026-10-27', 'nse'], ['2026-10-22', '2026-11-23', 'nse']])
  assert.ok(Math.abs((tcs[0]?.nearIv as number) - 0.21) < 1e-12)
  assert.equal(tcs[0]?.nseHv, 0.34, 'an older day keeps its own stocks\' CMVOLT, read without a map of every symbol')
  assert.deepEqual(s.days('ZZZ'), [], 'a stock only in an older day\'s CMVOLT is not held')
  const d = tcs[1]!
  assert.deepEqual([d.rolled, d.atmStrike, d.future, d.spot, d.nseHv, d.nextExpiry], [true, 2500, 2521, 2506.46, 0.3458, '2026-12-29'])
  assert.ok(Math.abs((d.nearIv as number) - 0.25) < 1e-12)   // NSE's 23.1% and 26.9% at 2500
  // the next month is the bhavcopy's alone (the job asks NSE about the near expiry only): 118 / 88 at 2500 off 2536.5
  assert.equal(d.nextIv, atmIvOf('2026-10-22', { expiry: '2026-12-29', close: 2536.5 }, { expiry: '2026-12-29', atm: { strike: 2500, ce: 118, pe: 88 } }))
  assert.equal(d.skew25, null)                                // the nearest traded put is 15Δ: too far from 25
  assert.deepEqual(s.status(), { files: 2, latest: '2026-10-22', problems: [] })
})

test('a stock only in the newest CMVOLT file gets a day with NSE\'s HV and nothing else', async () => {
  const s = new VolStore({ dir: nseDir(), now: () => NOW })
  await s.refresh()
  assert.deepEqual(s.days('M&M').map((d) => [d.date, d.nseHv, d.nearIv, d.nearExpiry]), [['2026-10-22', 0.2866, null, null]])
  assert.deepEqual(s.days('NOPE'), [])
})

test('a file that does not read is a problem; the others still read', async () => {
  const root = nseDir()
  writeFileSync(join(root, 'vol', '2026-10-20.json'), '{')
  writeFileSync(join(root, 'vol', '2026-10-19.json'), JSON.stringify({ v: 2, date: '2026-10-19', stocks: {} }))
  const s = new VolStore({ dir: root, now: () => NOW })
  await s.refresh()
  assert.equal(s.days('TCS').length, 2)
  const p = s.status().problems
  assert.equal(p.length, 2, p.join(' | '))
  assert.ok(p.some((x) => x.startsWith('vol/2026-10-20.json: ')), p.join(' | '))
  assert.ok(p.includes('vol/2026-10-19.json: not a version 1 vol file for 2026-10-19'), p.join(' | '))
})

test('a changed file is read again; a removed one is dropped', async () => {
  const root = nseDir()
  const s = new VolStore({ dir: root, now: () => NOW })
  await s.refresh()
  const f = join(root, 'vol', '2026-10-21.json')
  writeFileSync(f, older([0.30, 0.32]))
  utimesSync(f, new Date(NOW), new Date(NOW + 5_000))
  await s.refresh()
  assert.ok(Math.abs((s.days('TCS')[0]?.nearIv as number) - 0.31) < 1e-12)
  rmSync(f)
  await s.refresh()
  assert.deepEqual(s.days('TCS').map((d) => d.date), ['2026-10-22'])
})

test('only the newest `keep` days are held; no folder is no days and no throw', async () => {
  const s = new VolStore({ dir: nseDir(), now: () => NOW, keep: 1 })
  await s.refresh()
  assert.deepEqual(s.days('TCS').map((d) => d.date), ['2026-10-22'])
  const none = new VolStore({ dir: join(tmpdir(), 'traders-vol-none-here'), now: () => NOW })
  await none.refresh()
  assert.deepEqual([none.days('TCS'), none.status()], [[], { files: 0, latest: null, problems: [] }])
})
