/** The Vol page and the Portfolio's Vol columns: end-of-day IV, rank, percentile and VRP per held stock. */
import { expect, test, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { VolRow, VolView } from '../../../traders/src/analytics/context-wire.ts'
import type { PortfolioView } from '../../../traders/src/analytics/r3-wire.ts'
import { SessionContext } from '../../src/traders/hooks.ts'
import { PortfolioPage } from '../../src/traders/portfolio.tsx'
import { CUE_LEGEND, VolPage, byRank, pct1, pts1, rowNotes, volCue, volDetail } from '../../src/traders/vol.tsx'
import { installFetch } from '../http.tsx'
import { ASOF } from './fixtures.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const row = (over: Partial<VolRow>): VolRow => ({
  stock: 'TCS', asOf: '2026-10-22', iv: 0.2841, ivSource: 'nse', ivRank: 72.4, ivPercentile: 80.2, ivDays: 252,
  hv10: 0.21, hv20: 0.2341, nseHv: 0.3458, vrp: 0.05, vrpRatio: 1.2136, vrpPercentile: 66.6, vrpDays: 232,
  realizedVrp: { mean: 0.031, median: 0.028, positivePct: 71.5, days: 232 },
  nearExpiry: '2026-11-23', nearIv: 0.2841, nextExpiry: '2026-12-29', nextIv: 0.2606, skew25: 0.016, warnings: [], ...over,
})

const ROWS: VolRow[] = [
  row({ stock: 'SBIN', ivRank: null, ivPercentile: null, ivDays: 31, realizedVrp: null, warnings: ['IV rank needs 60 days of IV; 31 held'] }),
  row({ stock: 'INFY', ivRank: 10, ivPercentile: 8, vrp: -0.02, iv: 0.2, ivSource: 'bhavcopy' }),
  row({}),
]
const VIEW: VolView = { asOf: ASOF, trader: 'asha', rows: ROWS, warnings: [] }

const as = (role: 'admin' | 'trader', ui = <VolPage />) =>
  render(<SessionContext.Provider value={{ username: 'u', role, asTrader: null }}>{ui}</SessionContext.Provider>)

const bodyRows = (): HTMLElement[] => within(screen.getByRole('table', { name: 'Volatility' })).getAllByRole('row').slice(1)

test('the figures: percent, signed vol points, and the premium cue\'s thresholds', () => {
  expect([pct1(0.2841), pct1(null), pts1(0.05), pts1(-0.0315), pts1(null)]).toEqual(['28.4', '—', '+5.0', '-3.2', '—'])
  expect(volCue({ ivRank: 50, vrp: 0.001 })).toBe('rich')
  expect(volCue({ ivRank: 49.9, vrp: 0.05 })).toBe(null)
  expect(volCue({ ivRank: 80, vrp: -0.01 })).toBe(null)
  expect(volCue({ ivRank: 20, vrp: -0.001 })).toBe('cheap')
  expect(volCue({ ivRank: null, vrp: 0.05 })).toBe(null)
  expect(byRank(ROWS).map((r) => r.stock)).toEqual(['TCS', 'INFY', 'SBIN'])
  const same = 'IV rank needs 60 days of IV; 1 held'
  expect(rowNotes([row({ warnings: [same] }), row({ stock: 'INFY', warnings: [same, 'no close for 2026-10-22: HV ends 2026-10-21'] })]))
    .toEqual([`${same}: TCS, INFY`, 'no close for 2026-10-22: HV ends 2026-10-21: INFY'])
})

test('the Portfolio tooltip\'s lines carry what the four columns leave out', () => {
  expect(volDetail(row({ warnings: ['NSE ATM IV 25.0% vs bhavcopy 22.0%'] }))).toEqual([
    'IV 28.4 (NSE) · rank 72 · pctile 80 · 252 days',
    'HV10 21.0 · HV20 23.4 · NSE HV 34.6',
    'VRP +5.0 · IV/HV20 1.21 · VRP pctile 67',
    'Realized VRP +3.1 mean, +2.8 median, paid 72% of 232 days',
    '23 Nov 26 28.4 → 29 Dec 26 26.1 · 25Δ skew +1.6',
    'As of 22 Oct 26',
    'NSE ATM IV 25.0% vs bhavcopy 22.0%',
  ])
})

test('the Vol page lists the held stocks by IV rank, highest first, with the cue, the source and the months', async () => {
  installFetch(({ path }) => (path === '/v1/traders/vol' ? { body: VIEW } : { status: 404, body: { error: 'no' } }))
  as('trader')
  await screen.findByRole('table', { name: 'Volatility' })
  const rows = bodyRows()
  expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['TCS', 'INFY', 'SBIN'])
  const tcs = rows[0] as HTMLElement
  for (const t of ['rich', '28.4', 'NSE', '72', '80', '23.4', '+5.0', '1.21', '+3.1', '72', '28.4 → 26.1', '23 Nov 26 / 29 Dec 26', '+1.6', '252']) {
    expect(within(tcs).getAllByText(t).length, t).toBeGreaterThan(0)
  }
  expect(within(rows[1] as HTMLElement).getByText('cheap')).toBeTruthy()
  expect(within(rows[1] as HTMLElement).getByText('bhavcopy')).toBeTruthy()
  expect(within(rows[2] as HTMLElement).queryByText('rich')).toBe(null)
  expect(screen.getByText('asha · end of day, 22 Oct 26')).toBeTruthy()
  expect(screen.getByText(CUE_LEGEND)).toBeTruthy()
  // a row's warnings are the page's notes, once each with their stocks, not a hover per cell
  fireEvent.click(screen.getByRole('button', { name: 'Notes (1)' }))
  expect(screen.getByText('IV rank needs 60 days of IV; 31 held: SBIN')).toBeTruthy()
})

test('an admin with no trader picked sees every held stock; the view\'s warnings show; a failed load says so', async () => {
  const warn = 'No NSE chain snapshot yet (scripts/nse_vol_job.py): IV is the bhavcopy history\'s, no term or skew.'
  installFetch(() => ({ body: { ...VIEW, trader: null, warnings: [warn] } }))
  as('admin')
  await screen.findByText('All held stocks · end of day, 22 Oct 26')
  expect(screen.getByText(warn)).toBeTruthy()
  cleanup()
  installFetch(() => ({ status: 500, body: { error: 'boom' } }))
  as('trader')
  await screen.findByText(/Could not load volatility: boom/)
})

// ------------------------------------------------------------------ the Portfolio's columns

const PORTFOLIO: PortfolioView = {
  trader: 'asha', asOf: ASOF, warnings: [],
  rows: ['NIFTY', 'TCS'].map((stock) => ({
    stock, spot: 3050, lotSize: 175, delta: 350, deltaLots: 2, gamma: -0.0123, vega: -310, theta: 140, mtmDay: 1200, mtmDayReason: null, openPnl: 14612,
    margin: 250000, marginLabel: 'NSE SPAN end of day 19 Oct', band: 'in' as const, bandSentence: 'In band', months: [],
  })),
  totals: { books: 2, outOfBand: 0, deltaValue: 0, vega: -620, theta: 280, mtmDay: 2400, openPnl: 29224, margin: 500000, marginMissing: [] },
}

test('the Portfolio shows IV, IVR, IVP and VRP per book; a book with no vol row is blank', async () => {
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: PORTFOLIO } : path === '/v1/traders/vol' ? { body: VIEW } : { status: 404, body: { error: 'no' } }))
  as('trader', <PortfolioPage />)
  const table = await screen.findByRole('table', { name: 'Portfolio' })
  for (const h of ['IV', 'IVR', 'IVP', 'VRP']) expect(within(table).getByRole('columnheader', { name: h })).toBeTruthy()
  await waitFor(() => expect(within(screen.getByText('TCS').closest('tr') as HTMLElement).getByText('+5.0')).toBeTruthy())
  const tcs = screen.getByText('TCS').closest('tr') as HTMLElement
  for (const t of ['28.4', '72', '80']) expect(within(tcs).getByText(t)).toBeTruthy()
  const nifty = screen.getByText('NIFTY').closest('tr') as HTMLElement
  expect(within(nifty).queryByText('28.4')).toBe(null)
})

test('the Portfolio stays quiet when the vol view fails: blank columns, no error of its own', async () => {
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: PORTFOLIO } : { status: 404, body: { error: 'no such route' } }))
  as('trader', <PortfolioPage />)
  await screen.findByRole('table', { name: 'Portfolio' })
  expect(screen.queryByText(/volatility/i)).toBe(null)
  expect(screen.queryByText(/no such route/)).toBe(null)
})
