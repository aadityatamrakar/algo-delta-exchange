/** scripts/dx-books.mjs — the dry run needs no api, no Mongo, no network. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

interface Plan { tag: string; symbol: string; mode: string; variant: string; dials: Record<string, unknown> }
const { expiriesFor, planBooks } = (await import(new URL('../../../scripts/dx-books.mjs', import.meta.url).href)) as {
  expiriesFor(nowMs: number): Record<string, string>
  planBooks(e: Record<string, string>): Plan[]
}

const SCRIPT = fileURLToPath(new URL('../../../scripts/dx-books.mjs', import.meta.url))
const NOW = Date.parse('2026-11-03T06:00:00Z') // Tuesday, before the 12:00 UTC settlement

test('expiries: nearest daily, Friday weekly, last-Friday monthly', () => {
  assert.deepEqual(expiriesFor(NOW), { daily: '2026-11-03', weekly: '2026-11-06', monthly: '2026-11-27' })
  assert.equal(expiriesFor(Date.parse('2026-11-03T13:00:00Z')).daily, '2026-11-04')
  assert.equal(expiriesFor(Date.parse('2026-11-28T01:00:00Z')).monthly, '2026-12-25')
})

test('six paper bodies with the right tags and dials', () => {
  const books = planBooks(expiriesFor(NOW))
  assert.deepEqual(books.map((b) => b.tag), [
    'BTC-2026-11-03-bull-s-daily', 'BTC-2026-11-03-bull-s-daily-2',
    'BTC-2026-11-06-bull-s-weekly', 'BTC-2026-11-06-bull-s-weekly-2',
    'BTC-2026-11-27-bull-s-monthly', 'BTC-2026-11-27-bull-s-monthly-2',
  ])
  assert.ok(books.every((b) => b.mode === 'paper' && b.symbol === 'BTC'))
  const [d, d2, w, , m, m2] = books
  assert.equal(d!.dials['bs_strike_jump'], 1)
  assert.equal(d2!.dials['bs_strike_jump'], 2)
  assert.deepEqual(
    [d!.dials['bs_strike_step'], d!.dials['bs_lots_start'], d!.dials['bs_lots_cap'], d!.dials['bs_loss_cap']],
    [200, 50, 150, 250],
  )
  assert.deepEqual([w!.dials['bs_strike_step'], w!.dials['bs_lots_start'], w!.dials['bs_loss_cap']], [500, 10, 500])
  assert.equal(m!.dials['bs_strike_step'], 1000)
  assert.equal(m2!.variant, 'bull-s-btc-monthly-2')
  assert.ok(books.every((b) => b.dials['bs_enabled'] === true && b.dials['bs_stop_mult'] === 1.25 && b.dials['bs_lots_cap'] !== 0))
})

test('the CLI dry run prints six bodies and touches no network', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--now', '2026-11-03T06:00:00Z'], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', DESK_PORT: '1' },
  })
  assert.match(out, /DRY RUN: 6 PAPER books/)
  assert.equal((out.match(/"tag": "BTC-/g) ?? []).length, 6)
  assert.match(out, /No network was used/)
})
