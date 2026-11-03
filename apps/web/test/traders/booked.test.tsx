/** The Booked page: every series' booked P&L, the month filter, the history start, the admin's pick and roll-up. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AdminBookedView, BookedRow, BookedTotal, BookedView } from '../../../traders/src/analytics/booked-wire.ts'
import { addMonths, BOOKED_POLL_MS, BookedPage, defaultMonths, monthChoices, monthLabel, ROLLUP_POLL_MS } from '../../src/traders/booked.tsx'
import { SessionContext } from '../../src/traders/hooks.ts'
import { PAGES } from '../../src/traders/pages.tsx'
import { PAGE_KEYS, SHORTCUTS } from '../../src/traders/shortcuts.tsx'
import { installFetch } from '../http.tsx'
import { ASOF } from './fixtures.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const row = (over: Partial<BookedRow>): BookedRow => ({
  stock: 'TCS', expiry: '2026-10-27', kind: 'series', month: '2026-10', booked: 1400, settled: 0, charges: 120, openMtm: -875, net: 405,
  status: 'open', closedCycles: 1, openContracts: 1, firstDay: '2026-10-14', lastDay: '2026-10-16', since: null, notes: [], ...over,
})
const total = (over: Partial<BookedTotal> = {}): BookedTotal => ({ booked: 0, settled: 0, charges: 0, openMtm: 0, net: 0, rows: 0, open: 0, ...over })

const HISTORY = 'Figures count from 20 Sep 2026: the trade history the app holds starts there, and nothing before it is in them.'
const VIEW: BookedView = {
  trader: 'ravi', asOf: ASOF, from: '2026-08', to: '2026-10', months: ['2026-10', '2026-09', '2026-07'],
  rows: [
    row({}),
    row({ stock: 'JINDALSTEL', booked: -51344, settled: 0, charges: 938, openMtm: null, net: null, notes: ['open P&L unknown (no LTP, or the book did not answer) — net unknown'] }),
    row({ stock: 'INFY', expiry: '', kind: 'shares', booked: -250, charges: 3, openMtm: null, net: -253, status: 'closed', openContracts: 0 }),
    row({ stock: 'TCS', expiry: '2026-09-29', month: '2026-09', booked: 4900, settled: 4200, charges: 40, openMtm: null, net: 4860, status: 'settled', openContracts: 0 }),
  ],
  byMonth: [{ month: '2026-10', ...total({ booked: -50194, net: null, rows: 3, open: 2 }) }, { month: '2026-09', ...total({ booked: 4900, net: 4860, rows: 1 }) }],
  byStock: [],
  total: total({ booked: -45294, settled: 4200, charges: 1101, openMtm: null, net: null, rows: 4, open: 2 }),
  historyStart: '2026-09-20', ratesConfirmed: false, notes: [HISTORY, 'charges rates not confirmed — charges and net are estimates until an admin confirms them'],
}

const ADMIN: AdminBookedView = {
  asOf: ASOF, from: '2026-08', to: '2026-10', ratesConfirmed: true, notes: ['ravi: figures count from 20 Sep 2026'],
  traders: [
    { trader: 'ravi', historyStart: '2026-09-20', total: total({ booked: 5800, net: 5600, rows: 3 }), byMonth: [{ month: '2026-10', ...total({ booked: 900, net: 800 }) }, { month: '2026-09', ...total({ booked: 4900, net: 4800 }) }] },
    { trader: 'sita', historyStart: null, total: total(), byMonth: [] },
  ],
  byMonth: [], total: total({ booked: 5800, net: 5600, rows: 3 }),
}

const serve = (path: string): { body: unknown } | { status: number; body: unknown } =>
  path === '/v1/traders/booked' ? { body: VIEW }
    : path === '/v1/traders/admin/booked' ? { body: ADMIN }
      : path === '/v1/traders/admin/traders' ? { body: [{ username: 'ravi' }, { username: 'sita' }] } : { status: 404, body: { error: 'no' } }

const as = (role: 'admin' | 'trader', asTrader: string | null = null) =>
  render(<SessionContext.Provider value={{ username: 'u', role, asTrader }}><BookedPage /></SessionContext.Provider>)

test('a row per series with its booked, settled, charges, net, open P&L and status; a totals row; the history start in words', async () => {
  const sent = installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('JINDALSTEL')
  const table = screen.getByRole('table', { name: 'Booked' })
  const rowWith = (stock: string, series: string) => within(table).getAllByText(stock).map((e) => e.closest('tr')!).find((tr) => within(tr).queryByText(series) !== null)!
  const tcs = rowWith('TCS', '27 Oct 26')
  for (const t of ['+1,400', '120', '+405', '-875', 'Open']) expect(within(tcs).getByText(t)).toBeTruthy()
  const jsl = within(table).getByText('JINDALSTEL').closest('tr')!
  expect(within(jsl).getByText('-51,344')).toBeTruthy()
  expect(within(jsl).getAllByText('—')).toHaveLength(2)   // net and open MTM unknown, never 0
  expect(within(jsl).getByText(/open P&L unknown/)).toBeTruthy()
  expect(within(within(table).getByText('Shares · Oct 26').closest('tr')!).getByText('-253')).toBeTruthy()
  const sep = rowWith('TCS', '29 Sep 26')
  for (const t of ['+4,900', '+4,200', 'Settled']) expect(within(sep).getByText(t)).toBeTruthy()
  const totals = within(table).getByText('Total (4 series, 2 open)').closest('tr')!
  expect(within(totals).getByText('-45,294')).toBeTruthy()
  expect(screen.getByText('Figures count from 20 Sep 26: the trade history starts there; nothing before it is in them.')).toBeTruthy()
  // the default months, asked for in so many words; a trader never asks for the roll-up
  const { from, to } = defaultMonths(Date.now())
  expect(sent.find((r) => r.path === '/v1/traders/booked')?.url).toContain(`/v1/traders/booked?from=${from}&to=${to}`)
  expect(sent.some((r) => r.path.includes('/admin/'))).toBe(false)
  expect(screen.getByRole('table', { name: 'Booked by month' })).toBeTruthy()
  // spec G5's label for the open legs' GrossMTM at net price
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
    expect.arrayContaining(['Booked', 'of which settled', 'Charges', 'Net', 'Open P&L', 'Status']))
})

test('the month filter asks for the months chosen; a range never runs backwards', async () => {
  const sent = installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('JINDALSTEL')
  const { to } = defaultMonths(Date.now())
  fireEvent.click(screen.getByRole('combobox', { name: /From/ }))
  fireEvent.click(await screen.findByRole('option', { name: monthLabel('2026-07') }))
  await waitFor(() => expect(sent.some((r) => r.url.endsWith(`/v1/traders/booked?from=2026-07&to=${to}`))).toBe(true))
  // a From after the To moves the To with it
  const later = addMonths(to, 1)
  fireEvent.click(screen.getByRole('combobox', { name: /From/ }))
  fireEvent.click(await screen.findByRole('option', { name: monthLabel(later) }))
  await waitFor(() => expect(sent.some((r) => r.url.endsWith(`/v1/traders/booked?from=${later}&to=${later}`))).toBe(true))
})

test('an admin with no trader picked gets a prompt above the desk roll-up, by trader and month', async () => {
  const sent = installFetch(({ path }) => serve(path))
  as('admin')
  expect(await screen.findByText('Pick a trader to see their booked P&L')).toBeTruthy()
  const roll = await screen.findByRole('table', { name: 'Booked by trader' })
  await waitFor(() => expect(within(roll).getByText('ravi')).toBeTruthy())
  expect(within(within(roll).getByText('ravi').closest('tr')!).getByText('+5,800')).toBeTruthy()
  expect(within(roll).getByText('Oct 26')).toBeTruthy()
  expect(within(within(roll).getByText('Desk (2 traders)').closest('tr')!).getByText('+5,600')).toBeTruthy()
  expect(sent.some((r) => r.path === '/v1/traders/booked')).toBe(false)
  const { from, to } = defaultMonths(Date.now())
  expect(sent.find((r) => r.path === '/v1/traders/admin/booked')?.url).toContain(`?from=${from}&to=${to}`)
})

test('the admin picks the trader on the page; the top bar\'s pick is the default', async () => {
  const sent = installFetch(({ path }) => serve(path))
  as('admin')
  fireEvent.click(await screen.findByRole('combobox', { name: /Trader/ }))
  fireEvent.click(await screen.findByRole('option', { name: 'ravi' }))
  await screen.findByText('JINDALSTEL')
  expect(sent.find((r) => r.path === '/v1/traders/booked')?.url).toMatch(/[?&]trader=ravi(&|$)/)
  cleanup()
  const again = installFetch(({ path }) => serve(path))
  as('admin', 'sita')
  await screen.findByText('JINDALSTEL')
  expect(again.find((r) => r.path === '/v1/traders/booked')?.url).toMatch(/[?&]trader=sita(&|$)/)
})

test('a failed load says so', async () => {
  installFetch(() => ({ status: 500, body: { error: 'boom' } }))
  as('trader')
  expect(await screen.findByText('Could not load the booked P&L: boom')).toBeTruthy()
})

test('the page is hidden: no menu entry, no g key, no shortcut line; the month choices run from a year back to two months on', () => {
  expect(PAGES.some((p) => p.id === 'booked')).toBe(false)
  expect(Object.values(PAGE_KEYS)).not.toContain('booked')
  expect(SHORTCUTS.some((s) => s.what === 'Booked')).toBe(false)
  const months = monthChoices('2026-10', ['2025-03'], ['2026-12'])
  expect([months[0], months[months.length - 1], months.length]).toEqual(['2026-12', '2025-03', 14])
  expect([BOOKED_POLL_MS, ROLLUP_POLL_MS]).toEqual([60_000, 300_000])
})

test('the desk roll-up asks every five minutes; the trader\'s own view every minute', async () => {
  vi.useFakeTimers()
  const sent = installFetch(({ path }) => serve(path))
  as('admin', 'ravi')
  const count = (path: string): number => sent.filter((r) => r.path === path).length
  const asked = (): number[] => [count('/v1/traders/booked'), count('/v1/traders/admin/booked')]
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(asked()).toEqual([1, 1])
  await act(async () => { await vi.advanceTimersByTimeAsync(BOOKED_POLL_MS) })
  expect(asked()).toEqual([2, 1])
  await act(async () => { await vi.advanceTimersByTimeAsync(ROLLUP_POLL_MS - BOOKED_POLL_MS) })
  expect(asked()).toEqual([6, 2])
})
