/** The Daily page: a day's totals with its books under it, a dash for what was unknown, and the admin's trader picker. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DailyDay, DailyRow, DailyView } from '../../../traders/src/analytics/daily-wire.ts'
import { setAsTrader } from '../../src/traders/api.ts'
import { DAILY_POLL_MS, DailyPage, dayLabel } from '../../src/traders/daily.tsx'
import { SessionContext } from '../../src/traders/hooks.ts'
import { PAGES } from '../../src/traders/pages.tsx'
import { installFetch } from '../http.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); setAsTrader(null); Reflect.deleteProperty(document, 'hidden') })

const row = (over: Partial<DailyRow>): DailyRow => ({
  trader: 'asha', stock: 'TCS', day: '2026-10-19', at: 1, dayMtm: 1200, openPnl: -1750, seriesNet: 25000, seriesBooked: -51000, spot: 3400,
  delta: 350, gamma: -0.0123, theta: 140, vega: -310, margin: 250000, marginSource: 'NSE SPAN end of day 19 Oct', legs: 3, warnings: 0, ...over,
})

const day = (d: string, books: DailyRow[], over: Partial<DailyDay['totals']> = {}): DailyDay => ({
  day: d, at: 1, books,
  totals: {
    books: books.length, legs: books.reduce((s, b) => s + b.legs, 0), warnings: books.reduce((s, b) => s + b.warnings, 0),
    dayMtm: books.reduce((s, b) => s + (b.dayMtm ?? 0), 0), openPnl: -1750, seriesNet: 25000, seriesBooked: -51000,
    deltaValue: 1190000, vega: -310, theta: 140, margin: 250000,
    missing: { dayMtm: [], openPnl: [], series: [], spot: [], margin: [] }, ...over,
  },
})

const VIEW: DailyView = {
  trader: 'asha', asOf: 5, recordedFrom: '2026-10-16',
  days: [
    day('2026-10-19', [row({ stock: 'NIFTY', dayMtm: null, openPnl: null, seriesNet: null, margin: null, marginSource: null, warnings: 2, delta: -200 }), row({})], {
      dayMtm: null, openPnl: null, seriesNet: null, margin: null, deltaValue: null,
      missing: { dayMtm: ['NIFTY'], openPnl: ['NIFTY'], series: ['NIFTY'], spot: ['NIFTY'], margin: ['NIFTY'] },
    }),
    day('2026-10-16', [row({ day: '2026-10-16', dayMtm: -300 })], { dayMtm: -300 }),
  ],
  notes: ['Written once a trading day at 15:45 IST from the same figures the pages show, and kept; a row is never rewritten.'],
}

const serve = (path: string, search: URLSearchParams): { body: unknown } | { status: number; body: unknown } => {
  if (path === '/v1/traders/daily') return { body: VIEW }
  if (path === '/v1/traders/admin/traders') return { body: [{ username: 'asha' }, { username: 'bela' }] }
  void search
  return { status: 404, body: { error: 'no' } }
}

const as = (role: 'admin' | 'trader', asTrader: string | null = null) =>
  render(<SessionContext.Provider value={{ username: 'u', role, asTrader }}><DailyPage /></SessionContext.Provider>)

test('Daily is in the nav for everyone, after Vol', () => {
  const ids = PAGES.map((p) => p.id)
  expect(ids).toContain('daily')
  expect(PAGES.find((p) => p.id === 'daily')).toMatchObject({ label: 'Daily' })
  expect(PAGES.find((p) => p.id === 'daily')?.adminOnly).toBeUndefined()
  expect(ids.indexOf('daily')).toBeGreaterThan(ids.indexOf('vol'))
})

test('a day is a row of totals with its books under it, newest day first', async () => {
  installFetch(({ path, url }) => serve(path, url.searchParams))
  as('trader')
  const monday = await screen.findByText('Mon 19 Oct 2026')
  expect(screen.getByText('Fri 16 Oct 2026')).toBeTruthy()
  const table = screen.getByRole('table', { name: 'Daily record' })
  const rows = within(table).getAllByRole('row').map((r) => r.textContent ?? '')
  // header, then Monday, its two books, then Friday and its book
  expect(rows[1]).toContain('Mon 19 Oct 2026')
  expect(rows[2]).toContain('NIFTY')
  expect(rows[3]).toContain('TCS')
  expect(rows[4]).toContain('Fri 16 Oct 2026')
  expect(rows[5]).toContain('TCS')
  const tcs = rows[3] ?? ''
  for (const text of ['+1,200', '+25,000', '2,50,000']) expect(tcs).toContain(text)
  // Today and P&L only: the stored Open P&L (-1,750) and series booked (-51,000) are not shown
  for (const text of ['-1,750', '-51,000']) expect(tcs).not.toContain(text)
  const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
  expect(headers.slice(0, 4)).toEqual(['Day / book', 'Today', 'P&L', 'Delta'])
  for (const gone of ['Day MTM', 'Open P&L', 'Series net', 'Series booked']) expect(headers).not.toContain(gone)
  const friday = screen.getByText('Fri 16 Oct 2026').closest('tr') as HTMLElement
  expect(within(friday).getByText('+11,90,000')).toBeTruthy()   // the day's delta is money
  expect(within(friday).getByText('delta value')).toBeTruthy()
  expect(within(friday).getByText('2,50,000')).toBeTruthy()
  expect(monday.closest('tr')).toBeTruthy()
})

test('what was unknown is a dash, a day total with an unknown book is a dash, and the day names the book', async () => {
  installFetch(({ path, url }) => serve(path, url.searchParams))
  as('trader')
  const monday = (await screen.findByText('Mon 19 Oct 2026')).closest('tr') as HTMLElement
  expect(within(monday).getByText('Today unknown for NIFTY')).toBeTruthy()
  expect(within(monday).getByText('P&L unknown for NIFTY')).toBeTruthy()
  expect(within(monday).queryByText(/Open P&L|Day MTM|Series/)).toBeNull()
  expect(within(monday).getByText('margin missing: NIFTY')).toBeTruthy()
  expect(within(monday).getByText('delta value unknown for NIFTY (no spot)')).toBeTruthy()
  const cells = within(monday).getAllByRole('cell').map((c) => c.textContent)
  expect(cells[1]).toBe('—')              // Today
  expect(cells[2]).toBe('—')              // P&L
  expect(cells[3]).toBe('—delta value')   // the day's delta value, unknown
  expect(cells[7]).toBe('—')              // and its margin: not ₹0, and not the known book's alone
  const nifty = screen.getByText('NIFTY').closest('tr') as HTMLElement
  expect(within(nifty).getAllByText('—').length).toBeGreaterThanOrEqual(3)
  expect(within(nifty).getByText('⚠ 2')).toBeTruthy()
})

test('the Books switch hides the books and leaves the days', async () => {
  installFetch(({ path, url }) => serve(path, url.searchParams))
  as('trader')
  await screen.findByText('NIFTY')
  fireEvent.click(screen.getByRole('switch', { name: 'Books' }))
  expect(screen.queryByText('NIFTY')).toBeNull()
  expect(screen.queryByText('TCS')).toBeNull()
  expect(screen.getByText('Mon 19 Oct 2026')).toBeTruthy()
})

test('it says since when the record runs, and carries the server\'s notes', async () => {
  installFetch(({ path, url }) => serve(path, url.searchParams))
  as('trader')
  expect(await screen.findByText('asha · recorded since Fri 16 Oct 2026')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Notes \(1\)/ }))
  expect(screen.getByText(/a row is never rewritten/)).toBeTruthy()
})

test('nothing recorded yet is said, not an empty table', async () => {
  installFetch(({ path }) => (path === '/v1/traders/daily' ? { body: { ...VIEW, recordedFrom: null, days: [] } } : { body: [] }))
  as('trader')
  expect(await screen.findByText('asha · nothing recorded yet')).toBeTruthy()
  expect(screen.getByText(/Nothing recorded in the last 30 days/)).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'Daily record' })).toBeNull()
})

test('a trader asks for its own thirty days and names no trader', async () => {
  const sent = installFetch(({ path, url }) => serve(path, url.searchParams))
  as('trader')
  await screen.findByText('Mon 19 Oct 2026')
  const daily = sent.filter((r) => r.path === '/v1/traders/daily')
  expect(daily.map((r) => r.url.split('?')[1])).toEqual(['days=30'])
  expect(sent.some((r) => r.path.includes('/admin/'))).toBe(false)
})

test('an admin gets a prompt and a picker; picking a trader asks for that trader', async () => {
  const sent = installFetch(({ path, url }) => serve(path, url.searchParams))
  as('admin')
  expect(await screen.findByText('Pick a trader to see their daily record')).toBeTruthy()
  expect(sent.some((r) => r.path === '/v1/traders/daily')).toBe(false)
  const trigger = await waitFor(() => {
    const el = screen.queryByRole('combobox', { name: 'Trader' }) ?? screen.queryByRole('button', { name: 'Trader' })
    if (el === null) throw new Error('no picker')
    return el
  })
  act(() => { trigger.click() })
  act(() => { screen.getByRole('option', { name: 'bela' }).click() })
  await screen.findByText('Mon 19 Oct 2026')
  expect(sent.filter((r) => r.path === '/v1/traders/daily').map((r) => new URL(r.url).searchParams.get('trader'))).toEqual(['bela'])
})

test('an admin who already picked a trader in the sidebar starts on that trader', async () => {
  const sent = installFetch(({ path, url }) => serve(path, url.searchParams))
  as('admin', 'asha')
  await screen.findByText('Mon 19 Oct 2026')
  expect(sent.filter((r) => r.path === '/v1/traders/daily').map((r) => new URL(r.url).searchParams.get('trader'))).toEqual(['asha'])
})

test('a failed load says so; a failed refresh keeps the days', async () => {
  installFetch(() => ({ status: 500, body: { error: 'boom' } }))
  as('trader')
  expect(await screen.findByText('Could not load the daily record: boom')).toBeTruthy()
})

test('a hidden tab asks for nothing; showing it asks at once; a day left open is re-read every five minutes', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  const sent = installFetch(({ path, url }) => serve(path, url.searchParams))
  as('trader')
  await act(async () => { await vi.advanceTimersByTimeAsync(2 * DAILY_POLL_MS) })
  expect(sent.map((r) => r.path)).toEqual([])
  Reflect.deleteProperty(document, 'hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sent.map((r) => r.path)).toEqual(['/v1/traders/daily'])
  await act(async () => { await vi.advanceTimersByTimeAsync(DAILY_POLL_MS) })
  expect(sent.filter((r) => r.path === '/v1/traders/daily')).toHaveLength(2)
})

test('dayLabel names the weekday and passes anything else through', () => {
  expect(dayLabel('2026-10-19')).toBe('Mon 19 Oct 2026')
  expect(dayLabel('2026-12-25')).toBe('Fri 25 Dec 2026')
  expect(dayLabel('soon')).toBe('soon')
})
