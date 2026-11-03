/** held.json: the stocks of every open book, symbols only, written atomically for scripts/nse_vol_job.py. */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HELD_FILE, heldStocks, writeHeld } from '../src/market/held.ts'
import type { TraderLeg } from '../src/types.ts'

const NOW = Date.UTC(2026, 9, 22, 9, 0)   // 14:30 IST, Thu 22 Oct
const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

type L = Pick<TraderLeg, 'trader' | 'stock' | 'qty' | 'instrument' | 'expiry' | 'key'>
const leg = (o: Partial<L>): L => ({ trader: 'ravi', stock: 'TCS', qty: 175, instrument: 'option', expiry: '2026-10-27', key: 'RAVI01|TCS|x', ...o })

const LEGS: L[] = [
  leg({}),
  leg({ trader: 'sita', stock: 'M&M', instrument: 'share', expiry: '', key: 'SITA02|M&M|s' }),
  leg({ trader: 'sita', stock: 'TCS', qty: -175 }),
  leg({ stock: 'INFY', expiry: '2026-10-20' }),   // expired: not held
  leg({ stock: 'SBIN', qty: 0 }),
]

test('the held stocks are every trader\'s open books, once each, sorted', () => {
  assert.deepEqual(heldStocks(LEGS, '2026-10-22'), ['M&M', 'TCS'])
})

test('the file carries the stocks and the time only — no trader, no client code — and leaves no temp file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traders-held-'))
  roots.push(dir)
  assert.equal(await writeHeld(dir, LEGS, NOW), true)
  const text = readFileSync(join(dir, HELD_FILE), 'utf8')
  assert.deepEqual(JSON.parse(text), { asOf: '2026-10-22T09:00:00.000Z', stocks: ['M&M', 'TCS'] })
  for (const s of ['ravi', 'sita', 'RAVI01', 'SITA02']) assert.equal(text.includes(s), false, s)
  assert.deepEqual(readdirSync(dir), [HELD_FILE])
  assert.equal(await writeHeld(dir, [], NOW + 60_000), true)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, HELD_FILE), 'utf8')).stocks, [])
})

test('no NSE folder: nothing is written and the folder is not made', async () => {
  const dir = join(tmpdir(), 'traders-held-no-such-folder')
  assert.equal(await writeHeld(dir, LEGS, NOW), false)
  assert.equal(existsSync(dir), false)
})

test('a failed write throws and keeps the last file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'traders-held-'))
  roots.push(dir)
  await writeHeld(dir, LEGS, NOW)
  mkdirSync(join(dir, `${HELD_FILE}.${process.pid}.tmp`))   // the temp name is taken by a folder: the write fails
  await assert.rejects(writeHeld(dir, [], NOW))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, HELD_FILE), 'utf8')).stocks, ['M&M', 'TCS'])
})
