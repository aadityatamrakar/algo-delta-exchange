/** The results-ahead alert (risk spec R14): the rule's window, text and dedupe key, and the runner reading it only when due. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EventOutcome, EventRiskRow, EventRiskView } from '../src/analytics/risk-wire.ts'
import { AlertRunner } from '../src/alerts/runner.ts'
import { resultsAhead, resultsWindow, type AlertDraft } from '../src/alerts/rules.ts'
import type { TradersDb } from '../src/db.ts'
import type { EventDate } from '../src/market/events-store.ts'
import type { TraderLeg } from '../src/types.ts'

const ist = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:30`)
const outcome = (label: EventOutcome['label'], move: number, change: number | null): EventOutcome => ({ label, move, volPts: -4.5, change })
const row = (stock: string, date: string, o: { heldThrough?: boolean; purpose?: string; outcomes?: EventOutcome[] } = {}): EventRiskRow => ({
  stock, next: { date, purpose: o.purpose ?? 'Financial Results', days: 3, expiry: '2026-11-24', inNear: true, heldThrough: o.heldThrough ?? true },
  impliedMove: 0.07, past: [], pastAbsMean: 0.05, pastAbsMedian: 0.05, crushMeanPts: -4.5, ratio: 1.4, verdict: 'rich', provisional: false,
  outcomes: o.outcomes ?? [outcome('down-big', -0.075, -300000), outcome('down', -0.05, -123456.7), outcome('crush-only', 0, 50000), outcome('up', 0.05, 8000), outcome('up-big', 0.075, -200000)],
  warnings: [],
})

test('the window: from 09:15 IST on the trading day before the results, through the day itself', () => {
  const TUE = '2026-10-27'
  assert.equal(resultsWindow(ist('2026-10-26', '09:14'), TUE), false)
  assert.equal(resultsWindow(ist('2026-10-26', '09:15'), TUE), true)
  assert.equal(resultsWindow(ist(TUE, '00:05'), TUE), true)
  assert.equal(resultsWindow(ist(TUE, '23:55'), TUE), true)
  assert.equal(resultsWindow(ist('2026-10-28', '09:30'), TUE), false)
  assert.equal(resultsWindow(ist('2026-10-23', '15:00'), TUE), false, 'two trading days before')
  // results on Monday: from Friday 09:15, across the weekend
  assert.equal(resultsWindow(ist('2026-10-23', '09:10'), '2026-10-26'), false)
  assert.equal(resultsWindow(ist('2026-10-23', '09:15'), '2026-10-26'), true)
  assert.equal(resultsWindow(ist('2026-10-24', '12:00'), '2026-10-26'), true)
  // results on Wednesday 21 Oct: Tuesday is Dussehra, so from Monday 09:15
  assert.equal(resultsWindow(ist('2026-10-19', '09:15'), '2026-10-21'), true)
})

test('one alert per trader, stock and date for a book that holds through; the date, the series and the down and up changes in rupees', () => {
  const now = ist('2026-10-26', '09:20')
  const ds = resultsAhead({
    nowMs: now,
    rows: [
      { trader: 'ravi', row: row('MARUTI', '2026-10-27') },
      { trader: 'sita', row: row('MARUTI', '2026-10-27') },
      { trader: 'ravi', row: row('TCS', '2026-10-27', { heldThrough: false }) },
      { trader: 'ravi', row: row('INFY', '2026-10-27', { purpose: 'Fund Raising' }) },
      { trader: 'ravi', row: row('PAYTM', '2026-10-29') },
    ],
  })
  assert.deepEqual(ds.map((d) => d.dedupeKey), ['results|ravi|MARUTI|2026-10-27', 'results|sita|MARUTI|2026-10-27'])
  const d = ds[0] as AlertDraft
  assert.deepEqual([d.trader, d.kind, d.stock, d.title, d.url, d.at], ['ravi', 'results-ahead', 'MARUTI', 'MARUTI results 27 Oct', '/traders/#/books/MARUTI', now])
  assert.equal(d.body, 'Results 27 Oct; the 24 Nov expiry (near) carries it. Down 5.0%: -₹1,23,457; up 5.0%: +₹8,000 (vol -4.5 pts, the morning after).')
  for (const x of ds) assert.equal(/ravi|sita/.test(x.title + x.body), false, 'a trader\'s own alert names no one')
  const unknown = resultsAhead({ nowMs: now, rows: [{ trader: 'ravi', row: row('MARUTI', '2026-10-27', { outcomes: [] }) }] })
  assert.match(unknown[0]!.body, /not known/)
})

// ---- the runner ---------------------------------------------------------------------------

function runner(o: { upcoming: Map<string, EventDate[]>; legs: Pick<TraderLeg, 'trader' | 'stock' | 'instrument' | 'expiry' | 'qty'>[]; rows: Record<string, EventRiskRow[]> }) {
  const keys = new Set<string>()
  const reads = { legs: 0, views: [] as string[] }
  const pushed: string[] = []
  const r = new AlertRunner({
    store: { add: async (d) => (keys.has(d.dedupeKey) ? false : (keys.add(d.dedupeKey), true)), sent: async () => {}, lastAt: async () => null },
    pusher: { send: async (to, m) => { pushed.push(`${to.join(',')}: ${m.title}`); return 1 } },
    users: { list: async (role) => (role === 'trader' ? [{ username: 'ravi', disabled: false }, { username: 'sita', disabled: true }] : []) as never },
    status: { all: async () => new Map() },
    legs: { allOpen: async () => { reads.legs++; return o.legs as TraderLeg[] } },
    db: { collection: () => ({ find: () => ({ toArray: async () => [] }) }) } as unknown as TradersDb,
    spotOf: () => null, isIndex: () => false, now: () => 0, log: () => {},
    results: {
      calendar: { upcomingAll: () => o.upcoming },
      view: async (trader, nowMs): Promise<EventRiskView> => {
        reads.views.push(trader)
        return { asOf: nowMs, trader, calendarAsOf: null, rows: o.rows[trader] ?? [], warnings: [] }
      },
    },
  })
  return { r, reads, pushed }
}

test('the runner reads no leg while no held stock is due, then each enabled holder\'s view once, and dedupes across passes', async () => {
  const upcoming = new Map<string, EventDate[]>([['MARUTI', [{ date: '2026-10-27', purpose: 'Financial Results' }]], ['TCS', [{ date: '2026-11-12', purpose: 'Financial Results' }]]])
  const legs = [
    { trader: 'ravi', stock: 'MARUTI', instrument: 'option' as const, expiry: '2026-11-24', qty: -50 },
    { trader: 'ravi', stock: 'TCS', instrument: 'option' as const, expiry: '2026-11-24', qty: -175 },
    { trader: 'sita', stock: 'MARUTI', instrument: 'option' as const, expiry: '2026-11-24', qty: -50 },   // disabled
  ]
  const { r, reads, pushed } = runner({ upcoming, legs, rows: { ravi: [row('MARUTI', '2026-10-27'), row('TCS', '2026-11-12')], sita: [row('MARUTI', '2026-10-27')] } })
  assert.equal(await r.tick(ist('2026-10-26', '09:10')), 0)
  assert.deepEqual([reads.legs, reads.views], [0, []], 'nothing due before 09:15: no leg read')
  assert.equal(await r.tick(ist('2026-10-26', '09:15')), 1)
  assert.deepEqual([reads.legs, reads.views], [1, ['ravi']])
  assert.deepEqual(pushed, ['ravi: MARUTI results 27 Oct'])
  assert.equal(await r.tick(ist('2026-10-27', '10:00')), 0, 'the same date again: deduped')
  assert.equal(await r.tick(ist('2026-10-28', '10:00')), 0)
  assert.equal(reads.legs, 2, 'not read once the date has passed')
})
