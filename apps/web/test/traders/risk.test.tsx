/** The Risk page, the vol page's event cue, and the book header's results badge. */
import { expect, test, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { EventRiskRow, EventRiskView, RiskBook, RiskView } from '../../../traders/src/analytics/risk-wire.ts'
import type { VolRow } from '../../../traders/src/analytics/context-wire.ts'
import { SessionContext } from '../../src/traders/hooks.ts'
import { ResultsBadge, RiskPage, resultsBadgeOf, rs } from '../../src/traders/risk.tsx'
import { VolTable, volCue } from '../../src/traders/vol.tsx'
import { installFetch } from '../http.tsx'
import { ASOF } from './fixtures.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const book = (over: Partial<RiskBook>): RiskBook => ({
  stock: 'BHEL', beta: 1.4, betaDays: 250, niftyCorr: 0.7, deltaShares: 1000, deltaRupees: 300000, betaDeltaRupees: 420000,
  niftyUp1: 5000, niftyDown1: -6000, daySigma: 0.02, twoSigmaLoss: -80000, sharePct: 60, warnings: [], ...over,
})

const RISK: RiskView = {
  asOf: ASOF, trader: 'asha', nifty: { spot: 25000, lotSize: 75 },
  books: [
    book({ stock: 'TCS', sharePct: 40, twoSigmaLoss: -50000, betaDeltaRupees: -100000 }),
    book({}),
    book({ stock: 'SBIN', beta: null, niftyCorr: null, betaDeltaRupees: null, twoSigmaLoss: null, sharePct: null, warnings: ['beta needs 60 days'] }),
  ],
  totals: { betaDeltaRupees: 420000, niftyLots: -2.5, niftyUp1: 5000, niftyDown1: -412000 },
  grid: {
    moves: [-5, 0, 5], vols: [0, 5],
    cells: [[-412000, -500000], [0, 12000], [30000, null]],
    worst: [['BHEL', 'BHEL'], [null, null], [null, null]],
    excluded: [{ stock: 'SBIN', why: 'no beta' }],
  },
  replay: {
    days: 240, var95: -150000, var99: null, es99: null,
    worstDays: [{ date: '2026-03-02', change: -300000, niftyPct: -3.1, books: [{ stock: 'BHEL', change: -200000, movePct: -5 }, { stock: 'TCS', change: -100000, movePct: -2 }] }],
    notes: ['Vol unchanged, today\'s legs, one day'],
  },
  correlation: { stocks: ['TCS', 'BHEL', 'SBIN'], matrix: [] },
  clusters: [{ stocks: ['TCS', 'BHEL'], meanCorr: 0.72, togetherLoss: -170000, standaloneLoss: -130000 }],
  headline: 'NIFTY −5% with vol +5: −₹5,00,000, most from BHEL',
  warnings: [],
}

const row = (over: Partial<EventRiskRow>): EventRiskRow => ({
  stock: 'MARUTI',
  next: { date: '2026-10-27', purpose: 'Financial Results', days: 3, expiry: '2026-10-27', inNear: true, heldThrough: true },
  impliedMove: 0.05, past: [{ date: '2026-07-25', move: -0.031, ivBefore: 0.3, ivAfter: 0.25, crushPts: -5 }, { date: '2026-04-25', move: 0.02, ivBefore: null, ivAfter: null, crushPts: null }, { date: '2026-01-25', move: 0.04, ivBefore: null, ivAfter: null, crushPts: null }],
  pastAbsMean: 0.03, pastAbsMedian: 0.031, crushMeanPts: -5, ratio: 1.67, verdict: 'rich', provisional: false,
  outcomes: [
    { label: 'up', move: 0.03, volPts: -5, change: 25000 }, { label: 'down', move: -0.03, volPts: -5, change: -41000 },
    { label: 'up-big', move: 0.045, volPts: -5, change: 60000 }, { label: 'down-big', move: -0.045, volPts: -5, change: -90000 },
    { label: 'crush-only', move: 0, volPts: -5, change: -12000 },
  ],
  warnings: [], ...over,
})

const EVENTS: EventRiskView = {
  asOf: ASOF, trader: 'asha', calendarAsOf: '2026-10-24T15:00:00Z', warnings: [],
  rows: [
    row({ stock: 'ADANIPORTS', next: { date: '2026-10-28', purpose: 'Results', days: 4, expiry: '2026-11-24', inNear: false, heldThrough: false }, impliedMove: null, past: [], pastAbsMean: null, pastAbsMedian: null, crushMeanPts: null, ratio: null, verdict: 'unknown', provisional: true, outcomes: [] }),
    row({}),
    row({ stock: 'PAYTM', next: { date: '2026-10-26', purpose: 'Results', days: 2, expiry: '2026-11-24', inNear: false, heldThrough: true }, verdict: 'fair', ratio: 1, provisional: true }),
    row({ stock: 'NOPE', next: null }),
  ],
}

const page = () => render(<SessionContext.Provider value={{ username: 'u', role: 'trader', asTrader: null }}><RiskPage /></SessionContext.Provider>)
const serve = () => installFetch(({ path }) => (path === '/v1/traders/risk' ? { body: RISK } : path === '/v1/traders/events' ? { body: EVENTS } : { status: 404, body: { error: 'no' } }))

test('rupees: en-IN grouping, a real minus, a dash for null', () => {
  expect([rs(-412000), rs(1234567), rs(5000, true), rs(null), rs(0)]).toEqual(['−₹4,12,000', '₹12,34,567', '+₹5,000', '—', '₹0'])
})

test('the page: headline, totals, grid tones and outlined centre, excluded books, replay nulls', async () => {
  serve()
  const { container } = page()
  await screen.findByText(RISK.headline as string)
  expect(screen.getAllByText('+₹4,20,000').length).toBeGreaterThan(0)
  expect(screen.getByText('−2.5')).toBeTruthy()
  expect(screen.getByText('−₹4,12,000', { selector: '[title]' }).getAttribute('title')).toBe('Worst book: BHEL')
  const cell = (i: number, j: number) => container.querySelector(`[data-cell="${i}:${j}"]`) as HTMLElement
  expect(cell(0, 0).dataset['tone']).toBe('loss')
  expect(cell(2, 0).dataset['tone']).toBe('gain')
  expect(cell(2, 1).dataset['tone']).toBe('none')
  expect(cell(1, 0).dataset['centre']).toBe('true')
  expect(container.querySelectorAll('[data-centre]').length).toBe(1)
  expect(cell(0, 0).innerHTML).toContain('--color-error')
  expect(screen.getByText('Left out: SBIN (no beta)')).toBeTruthy()
  const replay = screen.getByText('VaR 95').parentElement as HTMLElement
  expect(within(replay).getByText('−₹1,50,000')).toBeTruthy()
  expect(within(screen.getByText('VaR 99').parentElement as HTMLElement).getByText('—').getAttribute('title')).toMatch(/60 days/)
  expect(screen.getByText('02 Mar 26')).toBeTruthy()
  // the replay's niftyPct and movePct are percent on the wire (review): −3.1, not −310
  expect(screen.getByText('−3.10%')).toBeTruthy()
  expect(screen.getByText(/^BHEL .*₹2,00,000/).getAttribute('title')).toBe('BHEL −5.00% · TCS −2.00%')
})

test('results: soonest first, near badge, verdict, provisional greyed, past reactions on click', async () => {
  serve()
  page()
  const table = await screen.findByRole('table', { name: 'Results' })
  const rows = () => within(table).getAllByRole('row').slice(1)
  expect(rows().map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['▸ PAYTM', '▸ MARUTI', '▸ ADANIPORTS'])
  const maruti = rows()[1] as HTMLElement
  expect(within(maruti).getByText('near')).toBeTruthy()
  expect(within(maruti).getByText('rich')).toBeTruthy()
  expect(within(maruti).getByText('1.67')).toBeTruthy()
  expect(within(maruti).getByText('3.0% (3)')).toBeTruthy()
  expect(within(maruti).getByText('−₹41,000')).toBeTruthy()
  expect(within(maruti).queryByText('provisional')).toBe(null)
  const paytm = rows()[0] as HTMLElement
  expect(within(paytm).getByText('provisional')).toBeTruthy()
  expect(within(paytm).getByText('fair').getAttribute('style')).not.toMatch(/--color/)
  expect(within(paytm).queryByText('near')).toBe(null)
  const ada = rows()[2] as HTMLElement
  expect(within(ada).getAllByText('—').length).toBeGreaterThan(4)
  fireEvent.click(within(maruti).getByRole('button', { name: 'MARUTI past reactions' }))
  expect(rows().length).toBe(6)
  expect(within(table).getByText('25 Jul 26')).toBeTruthy()
  expect(within(table).getByText('−3.1%')).toBeTruthy()
  expect(screen.getByText('Straddle covers the whole time to expiry, not only the event.')).toBeTruthy()
})

test('concentration is sorted by share; clusters show together vs standalone; no P&L or MTM wording anywhere', async () => {
  serve()
  const { container } = page()
  const conc = await screen.findByRole('table', { name: 'Concentration' })
  expect(within(conc).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['BHEL', 'TCS', 'SBIN'])
  const cl = screen.getByRole('table', { name: 'Clusters' })
  expect(within(cl).getByText('TCS, BHEL')).toBeTruthy()
  expect(within(cl).getByText('−₹1,70,000')).toBeTruthy()
  expect(within(cl).getByText('−₹1,30,000')).toBeTruthy()
  expect(container.textContent).not.toMatch(/P&L|P & L|MTM/i)
})

test('the vol cue: event replaces rich and cheap, with the tooltip', () => {
  const results = { date: '2026-10-27', expiry: '2026-10-27', inNear: true }
  expect(volCue({ ivRank: 80, vrp: 0.05, results })).toBe('event')
  expect(volCue({ ivRank: 5, vrp: -0.05, results })).toBe('event')
  expect(volCue({ ivRank: 80, vrp: 0.05, results: { ...results, inNear: false } })).toBe('rich')
  expect(volCue({ ivRank: 80, vrp: 0.05, results: null })).toBe('rich')
  const r = { stock: 'MARUTI', asOf: '2026-10-22', iv: 0.3, ivSource: 'nse', ivRank: 80, ivPercentile: 90, ivDays: 252, hv10: 0.2, hv20: 0.2, nseHv: 0.2, vrp: 0.05, vrpRatio: 1.2, vrpPercentile: 60, vrpDays: 200, realizedVrp: null, nearExpiry: '2026-10-27', nearIv: 0.3, nextExpiry: '2026-11-24', nextIv: 0.28, skew25: 0.01, warnings: [], results } as VolRow
  render(<VolTable rows={[r]} />)
  const cue = screen.getByText('event')
  expect(cue.getAttribute('title')).toBe('IV includes results on 27 Oct: rank not comparable')
  expect(screen.queryByText('rich')).toBe(null)
})

test('the book header badge: near expiry or the expiry, tooltip with down and up; nothing when not held through', () => {
  expect(resultsBadgeOf(EVENTS, 'MARUTI')).toEqual({ text: 'Results 27 Oct · near expiry', tip: 'Change if the results move the stock: down −₹41,000, up +₹25,000' })
  expect(resultsBadgeOf(EVENTS, 'PAYTM')?.text).toBe('Results 26 Oct · 24 Nov 26')
  expect(resultsBadgeOf(EVENTS, 'ADANIPORTS')).toBe(null)
  expect(resultsBadgeOf(EVENTS, 'TCS')).toBe(null)
  expect(resultsBadgeOf(null, 'TCS')).toBe(null)
})

test('the badge fetches the events view and shows on the book', async () => {
  serve()
  render(<ResultsBadge stock="MARUTI" />)
  expect(await screen.findByText('Results 27 Oct · near expiry')).toBeTruthy()
})
