/** GET /v1/traders/vol: one row per held stock, the trader's own; an admin names one with ?as= or sees every held stock. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import type { DailyBar } from '../src/analytics/context-wire.ts'
import type { VolDay } from '../src/analytics/vol-metrics.ts'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { authRoutes } from '../src/routes/auth.ts'
import { volRoutes } from '../src/routes/vol.ts'
import type { TraderLeg } from '../src/types.ts'
import { startHarness, type Harness } from './harness.ts'

const leg = (trader: string, stock: string, expiry = '2026-10-27'): TraderLeg =>
  ({ trader, stock, qty: 175, instrument: 'option', expiry, key: `${trader}|${stock}` }) as TraderLeg
const LEGS: TraderLeg[] = [leg('ravi', 'TCS'), leg('ravi', 'INFY', '2026-10-01'), leg('sita', 'JINDALSTEL'), leg('sita', 'TCS')]

/** 30 bars of TCS: IV 30%, closes alternating ±1%. */
function bars(stock: string): DailyBar[] {
  if (stock !== 'TCS') return []
  const out: DailyBar[] = []
  let c = 100
  for (let i = 0; i < 30; i++) {
    if (i > 0) c *= Math.exp(i % 2 === 1 ? 0.01 : -0.01)
    const date = new Date(Date.UTC(2026, 8, 7) + i * 86_400_000).toISOString().slice(0, 10)
    out.push({ date, open: 0, high: 0, low: 0, close: c, volume: 0, futClose: null, futOi: null, ceOi: null, peOi: null, atmIv: 0.3, maxPain: null })
  }
  return out
}
const DAY: VolDay = {
  date: '2026-10-07', nearExpiry: '2026-10-27', nextExpiry: '2026-11-23', rolled: false, atmStrike: 2500, nearIv: 0.32,
  nearIvSource: 'nse', nextIv: 0.3, skew25: 0.04, spot: 101, future: 101.2, nseHv: 0.29, notes: [],
}
let latest: string | null = '2026-10-07'

let h: Harness | null = null
before(async () => {
  h = await startHarness('vol_route', (d) => [authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }), volRoutes({
    users: d.users, now: d.now,
    legs: { open: async (t: string) => LEGS.filter((l) => l.trader === t), allOpen: async () => LEGS },
    vol: { days: (s: string) => (s === 'TCS' ? [DAY] : []), status: () => ({ files: latest === null ? 0 : 1, latest, problems: [] }) },
    bars: (s: string, n: number) => bars(s).slice(-n),
    adjustments: (s: string) => (s === 'TCS' ? [{ date: '2026-09-21', ratio: 0.5, kind: 'corporate' as const }, { date: '2026-09-28', ratio: 1.01, kind: 'roll' as const }] : []),
  })])
  if (h === null) return
  await h.reset()
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
})
after(async () => { await h?.close() })

test('a trader gets a row per own open book, as of the newest day, and nothing of another trader\'s', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('GET', '/v1/traders/vol?as=sita', { cookie: await h.login('ravi') })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.trader, r.body.asOf, r.body.rows.map((x: { stock: string }) => x.stock)], ['ravi', h.clock.now, ['TCS']])
  const row = r.body.rows[0]
  assert.deepEqual([row.asOf, row.iv, row.ivSource, row.nearExpiry, row.nextIv, row.skew25, row.nseHv], ['2026-10-07', 0.32, 'nse', '2026-10-27', 0.3, 0.04, 0.29])
  assert.equal(row.ivRank, null)
  assert.ok(row.warnings.includes('IV rank needs 60 days of IV; 31 held'), row.warnings.join(' | '))
  assert.deepEqual(row.warnings.filter((w: string) => w.includes('scaled')), ['closes before 2026-09-21 scaled ×0.5000 for a corporate action'])
  assert.ok(Math.abs(row.vrp - (0.32 - row.hv20)) < 1e-12)
  assert.equal(JSON.stringify(r.body).includes('sita'), false)
})

test('an admin sees every held stock without ?as=, and one trader\'s with it', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const boss = await h.login('boss')
  const all = await h.call('GET', '/v1/traders/vol', { cookie: boss })
  assert.equal(all.status, 200, JSON.stringify(all.body))
  assert.deepEqual([all.body.trader, all.body.rows.map((x: { stock: string }) => x.stock)], [null, ['JINDALSTEL', 'TCS']])
  const jindal = all.body.rows[0]
  assert.deepEqual([jindal.asOf, jindal.iv, jindal.warnings], [null, null, ['no end-of-day history or chain snapshot']])
  const sita = await h.call('GET', '/v1/traders/vol?as=sita', { cookie: boss })
  assert.deepEqual([sita.body.trader, sita.body.rows.map((x: { stock: string }) => x.stock)], ['sita', ['JINDALSTEL', 'TCS']])
  assert.equal((await h.call('GET', '/v1/traders/vol?as=nobody', { cookie: boss })).status, 404)
})

test('with no vol snapshot yet the view says the IV is the history\'s alone', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  latest = null
  try {
    const r = await h.call('GET', '/v1/traders/vol', { cookie: await h.login('ravi') })
    assert.deepEqual(r.body.warnings, ['No NSE chain snapshot yet (scripts/nse_vol_job.py): IV is the bhavcopy history\'s, no term or skew.'])
  } finally { latest = '2026-10-07' }
})

test('a watcher token and no session are refused', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await h.call('GET', '/v1/traders/vol', { bearer: await h.watcherToken('ravi') })).status, 403)
  assert.equal((await h.call('GET', '/v1/traders/vol')).status, 401)
})
