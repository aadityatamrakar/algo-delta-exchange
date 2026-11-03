/** GET /v1/traders/events: each held book's results-event risk; a trader's own, an admin's per trader or every trader's together. */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import type { DailyBar } from '../src/analytics/context-wire.ts'
import type { EventRiskRow } from '../src/analytics/risk-wire.ts'
import { SnapshotCache } from '../src/analytics/snapshot.ts'
import type { EventDate } from '../src/market/events-store.ts'
import { authRoutes } from '../src/routes/auth.ts'
import { NO_CALENDAR, eventsReader, eventsRoutes } from '../src/routes/events.ts'
import type { TraderLeg } from '../src/types.ts'
import { NOV, OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { startHarness, type Harness } from './harness.ts'

const TCS_SPOT = 2953217
const leg = (trader: string, strike: number, optType: 'CE' | 'PE', qty: number, expiry = NOV, stock = 'TCS'): TraderLeg => ({
  trader, stock, instrument: 'option', expiry, strike, optType, qty, avgPrice: 140, clientCode: 'ZZCLIENT9', source: 'odin',
  key: `ZZCLIENT9|option|${stock}|${expiry}|${strike}|${optType}`, token: null, note: '', updatedAt: 0,
})
// ravi: short a November straddle; sita: short the same straddle twice over and an October M&M call
const LEGS: TraderLeg[] = [
  leg('ravi', 3400, 'CE', -175), leg('ravi', 3400, 'PE', -175),
  leg('sita', 3400, 'CE', -350), leg('sita', 3400, 'PE', -350), leg('sita', 3100, 'CE', -700, OCT, 'M&M'),
]

const bar = (date: string, close: number, atmIv: number): DailyBar =>
  ({ date, open: close, high: close, low: close, close, volume: 0, futClose: null, futOi: null, ceOi: null, peOi: null, atmIv, maxPain: null })
const TCS_BARS = [bar('2026-07-08', 3000, 0.3), bar('2026-07-10', 3150, 0.25), bar('2026-09-08', 3200, 0.3), bar('2026-09-10', 3040, 0.26)]
const upcoming: Record<string, EventDate[]> = { TCS: [{ date: '2026-11-06', purpose: 'Financial Results' }] }
const past: Record<string, EventDate[]> = { TCS: [{ date: '2026-07-09', purpose: 'Financial Results' }, { date: '2026-09-09', purpose: 'Financial Results/Dividend' }] }
let writtenAt: string | null = '2026-10-22T15:00:00Z'
let nseErrors = 0
const NOW = Date.parse('2026-10-23T11:00:00+05:30')   // Friday, in session
const m = r3Master()
const q = fakeQuotes()
q.set(TCS_SPOT, { price: 3400, asOf: NOW })
q.set(1002, { price: 3410, asOf: NOW })
priceChain(q, m, 'TCS', NOV, 3410, 0.3, NOW)

let h: Harness | null = null
before(async () => {
  h = await startHarness('events_route', (d) => {
    const snapshots = new SnapshotCache({ master: () => m, quotes: q, now: d.now })
    const eventRisk = eventsReader({
      legs: {
        open: async (t: string) => LEGS.filter((l) => l.trader === t), allOpen: async () => LEGS, version: () => 1,
      },
      calendar: { upcoming: (s) => upcoming[s] ?? [], past: (s) => past[s] ?? [], status: () => ({ writtenAt, problems: [], nseErrors }) },
      bars: (s) => (s === 'TCS' ? TCS_BARS : []), master: () => m, quotes: q, snapshots,
    })
    return [authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }), eventsRoutes({ users: d.users, eventRisk, now: d.now })]
  })
  if (h === null) return
  await h.reset()
  h.clock.now = NOW
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
})
after(async () => { await h?.close() })

const changeOf = (r: EventRiskRow, label: string): number => r.outcomes.find((o) => o.label === label)?.change as number

test('a trader gets a row per own open book with its outcomes, and nothing of another trader\'s', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('GET', '/v1/traders/events?as=sita', { cookie: await h.login('ravi') })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual([r.body.trader, r.body.asOf, r.body.calendarAsOf, r.body.rows.map((x: EventRiskRow) => x.stock)], ['ravi', h.clock.now, '2026-10-22T15:00:00Z', ['TCS']])
  const row: EventRiskRow = r.body.rows[0]
  assert.deepEqual(row.next, { date: '2026-11-06', purpose: 'Financial Results', days: 14, expiry: NOV, inNear: true, heldThrough: true })
  assert.deepEqual(row.past.map((p) => [p.date, p.move, p.crushPts]), [['2026-07-09', 0.05, -5], ['2026-09-09', -0.05, -4]])
  assert.equal(row.provisional, true)
  assert.equal(row.outcomes.length, 5)
  assert.ok(changeOf(row, 'crush-only') > 0)
  assert.equal(r.body.warnings.length, 0)
  assert.equal(JSON.stringify(r.body).includes('sita'), false)
})

test('an admin: every held stock with each stock\'s books priced together; one trader with ?as=; the calendar\'s age said', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const boss = await h.login('boss')
  const all = await h.call('GET', '/v1/traders/events', { cookie: boss })
  assert.equal(all.status, 200, JSON.stringify(all.body))
  assert.deepEqual([all.body.trader, all.body.rows.map((x: EventRiskRow) => x.stock)], [null, ['TCS', 'M&M']], 'a dated row first')
  const sita = await h.call('GET', '/v1/traders/events?as=sita', { cookie: boss })
  const ravi = await h.call('GET', '/v1/traders/events?as=ravi', { cookie: boss })
  assert.deepEqual(sita.body.rows.map((x: EventRiskRow) => x.stock), ['TCS', 'M&M'])
  // the same legs three times over: the together figure is ravi's and sita's summed (a linear reprice of identical legs)
  for (const label of ['down', 'crush-only', 'up-big']) {
    const sum = changeOf(ravi.body.rows[0], label) + changeOf(sita.body.rows[0], label)
    assert.ok(Math.abs(changeOf(all.body.rows[0], label) - sum) < 0.05, `${label}: ${changeOf(all.body.rows[0], label)} vs ${sum}`)
  }
  const mm: EventRiskRow = all.body.rows[1]
  assert.deepEqual([mm.next, mm.outcomes], [null, []])
  assert.equal(JSON.stringify(all.body).includes('sita') || JSON.stringify(all.body).includes('ravi'), false)
  assert.equal((await h.call('GET', '/v1/traders/events?as=nobody', { cookie: boss })).status, 404)
  // the view is a minute's: a calendar that changes shows in the next minute
  writtenAt = null
  h.clock.now += 61_000
  const later = await h.call('GET', '/v1/traders/events', { cookie: boss })
  assert.deepEqual([later.body.calendarAsOf, later.body.warnings], [null, [NO_CALENDAR]])
  writtenAt = '2026-10-22T15:00:00Z'
  // a run NSE did not fully answer still writes the file, fresh-dated: its failures are said (review)
  nseErrors = 2
  h.clock.now += 61_000
  const failed = await h.call('GET', '/v1/traders/events', { cookie: boss })
  assert.ok(failed.body.warnings.some((w: string) => w.startsWith('NSE did not answer 2 requests on the run of')), JSON.stringify(failed.body.warnings))
  nseErrors = 0
})

test('a watcher token and no session are refused', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await h.call('GET', '/v1/traders/events', { bearer: await h.watcherToken('ravi') })).status, 403)
  assert.equal((await h.call('GET', '/v1/traders/events')).status, 401)
})
