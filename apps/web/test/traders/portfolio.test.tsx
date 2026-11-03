/** The Portfolio page: books and totals, the band sentence, Month wise, and who may ask for the roll-up. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AdminPortfolioView, PortfolioRow, PortfolioView } from '../../../traders/src/analytics/r3-wire.ts'
import { SessionContext } from '../../src/traders/hooks.ts'
import { PORTFOLIO_POLL_MS, PortfolioPage, SHARES_PNL_TITLE } from '../../src/traders/portfolio.tsx'
import { installFetch } from '../http.tsx'
import { ASOF } from './fixtures.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); Reflect.deleteProperty(document, 'hidden') })

const SPAN_LABEL = 'NSE SPAN end of day 19 Oct'

const row = (over: Partial<PortfolioRow>): PortfolioRow => ({
  stock: 'TCS', spot: 3050, lotSize: 175, delta: 350, deltaLots: 2, gamma: -0.0123, vega: -310, theta: 140,
  mtmDay: 1200, mtmDayReason: null, openPnl: 14612, pnl: -18023, pnlReason: null, margin: 250000, marginLabel: SPAN_LABEL, band: 'in',
  bandSentence: 'Delta 2 lots, inside the band of 5', months: [
    { expiry: '2026-10-27', delta: 175, gamma: -0.01, vega: -300, theta: 130, mtm: 9000, pnl: -16000 },
    { expiry: '2026-11-24', delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0, pnl: -2023 },
    { expiry: '', delta: 175, gamma: 0, vega: 0, theta: 0, mtm: 5612, pnl: null },
  ], ...over,
})

const VIEW: PortfolioView = {
  trader: 'asha', asOf: ASOF, warnings: [],
  rows: [
    row({}),
    row({ stock: 'NIFTY', spot: 25000, lotSize: 75, delta: -9400, deltaLots: -125.3, margin: null, marginLabel: null,
      band: 'out', bandSentence: 'Delta -125 lots, outside the band of 20', months: [] }),
  ],
  totals: { books: 2, outOfBand: 1, deltaValue: -2350000, vega: -900, theta: 400, mtmDay: 2000, openPnl: 30000, pnl: -36046, margin: 250000, marginMissing: ['NIFTY'] },
}

const ADMIN: AdminPortfolioView = {
  asOf: ASOF, warnings: [],
  traders: [{ trader: 'asha', totals: VIEW.totals }],
  stocks: [{ stock: 'NIFTY', traders: 1, delta: -9400, deltaLots: -125, gamma: 0, vega: -1, theta: 1, mtmDay: 0, openPnl: 0, pnl: null, margin: 0 },
    { stock: 'TCS', traders: 2, delta: 700, deltaLots: 4, gamma: 0, vega: -620, theta: 280, mtmDay: 2400, openPnl: 29000, pnl: -31000, margin: 500000 }],
}

const serve = (path: string): { body: unknown } | { status: number; body: unknown } =>
  path === '/v1/traders/portfolio' ? { body: VIEW }
    : path === '/v1/traders/admin/portfolio' ? { body: ADMIN } : { status: 404, body: { error: 'no' } }

const as = (role: 'admin' | 'trader', ui = <PortfolioPage />) =>
  render(<SessionContext.Provider value={{ username: 'u', role, asTrader: null }}>{ui}</SessionContext.Provider>)

test('a row per book, a totals row with the delta value and the missing margin, and the band sentence', async () => {
  installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('NIFTY')
  expect(screen.getByText('TCS')).toBeTruthy()
  const totals = screen.getByText(/^Total \(2 books/).closest('tr')!
  expect(within(totals).getByText('-23,50,000')).toBeTruthy()
  expect(within(totals).getByText('Margin missing: NIFTY')).toBeTruthy()
  const nifty = screen.getByText('NIFTY').closest('tr')!
  expect(within(nifty).getByText('Delta -125 lots, outside the band of 20')).toBeTruthy()
  expect(within(nifty).getByLabelText('Out of band')).toBeTruthy()
  expect(within(screen.getByText('TCS').closest('tr')!).getByText('2,50,000')).toBeTruthy()
})

test('Month wise opens each book into its expiries and its shares', async () => {
  installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('NIFTY')
  expect(screen.queryByText('Shares')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  expect(screen.getByText('27 Oct 26')).toBeTruthy()
  expect(screen.getByText('Shares')).toBeTruthy()
})

test('Month wise names each expiry by its date: two October NIFTY weeklies are two rows told apart', async () => {
  const weekly = (expiry: string, pnl: number) => ({ expiry, delta: -4700, gamma: 0, vega: 0, theta: 0, mtm: 0, pnl })
  const nifty = row({ stock: 'NIFTY', lotSize: 75, months: [weekly('2026-10-20', 100), weekly('2026-10-27', 200)] })
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: { ...VIEW, rows: [nifty] } } : serve(path)))
  as('trader')
  await screen.findByText('NIFTY')
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  expect(within(screen.getByText('20 Oct 26').closest('tr')!).getByText('+100')).toBeTruthy()
  expect(within(screen.getByText('27 Oct 26').closest('tr')!).getByText('+200')).toBeTruthy()
})

test('Month wise: each month row\'s P&L is its expiry\'s, a closed-out expiry included; the shares have none; no note needed', async () => {
  installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('NIFTY')
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  const pnl = (label: string): string => within(screen.getByText(label).closest('tr')!).getAllByRole('cell')[6]!.textContent ?? ''
  expect(['27 Oct 26', '24 Nov 26', 'Shares'].map(pnl)).toEqual(['-16,000', '-2,023', '—'])
  expect(screen.queryByText(/month row has/)).toBeNull()
})

test('two columns, Today and P&L, each its own figure: a book with no Today shows a dash, never its P&L or its legs\' sum', async () => {
  const noDay = row({ mtmDay: null, mtmDayReason: 'market opens 09:15', openPnl: 14612 })
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: { ...VIEW, rows: [noDay], totals: { ...VIEW.totals, mtmDay: null } } } : serve(path)))
  as('trader')
  await screen.findByText('TCS')
  const books = screen.getByRole('table', { name: 'Portfolio' })
  expect([...books.querySelectorAll('th')].map((h) => h.textContent).filter((t) => /MTM|P&L|Today/.test(t ?? ''))).toEqual(['Today', 'P&L'])
  const tcs = within(screen.getByText('TCS').closest('tr')!).getAllByRole('cell')
  expect([tcs[5]!.textContent, tcs[6]!.textContent]).toEqual(['—', '-18,023'])
  expect(tcs[5]!.querySelector('[title]')!.getAttribute('title')).toBe('market opens 09:15')   // why, on hover
  const total = within(screen.getByText(/^Total \(/).closest('tr')!).getAllByRole('cell')
  expect(total[6]!.textContent).toBe('-36,046')
  expect(screen.queryByText(/MTM today|MTM total|Current MTM|14,612/)).toBeNull()
  expect(document.body.textContent).not.toMatch(/Day MTM|Open P&L/)
})

test('a shares-only book is "—" saying P&L counts F&O series only, and the total stays known; a no-LTP book\'s total is unknown', async () => {
  const shares = row({ stock: 'INFY', pnl: null, pnlReason: 'no live expiry', months: [{ expiry: '', delta: 500, gamma: 0, vega: 0, theta: 0, mtm: 2500, pnl: null }] })
  const note = 'P&L counts F&O series only — shares not included'
  installFetch(({ path }) => (path === '/v1/traders/portfolio'
    ? { body: { ...VIEW, rows: [shares, row({})], warnings: [note], totals: { ...VIEW.totals, pnl: -18023 } } } : serve(path)))
  as('trader')
  await screen.findByText('INFY')
  const cellOf = (label: string): Element => within(screen.getByText(label).closest('tr')!).getAllByRole('cell')[6]!
  expect([cellOf('INFY').textContent, cellOf('INFY').querySelector('[title]')!.getAttribute('title')]).toEqual(['—', SHARES_PNL_TITLE])
  expect(cellOf('TCS').textContent).toBe('-18,023')
  expect(within(screen.getByText(/^Total \(/).closest('tr')!).getAllByRole('cell')[6]!.textContent).toBe('-18,023')
  expect(screen.getAllByText(note)).toHaveLength(1)   // once, with the warnings, not per row
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  const sharesMonths = screen.getAllByText('Shares').map((e) => within(e.closest('tr')!).getAllByRole('cell')[6]!)
  for (const c of sharesMonths) expect([c.textContent, c.querySelector('[title]')!.getAttribute('title')]).toEqual(['—', SHARES_PNL_TITLE])
  cleanup()
  // an open leg with no LTP is a real unknown: the server's total is null, and the total says why
  installFetch(({ path }) => (path === '/v1/traders/portfolio'
    ? { body: { ...VIEW, rows: [shares, row({ pnl: null, pnlReason: 'an open leg has no LTP' })], totals: { ...VIEW.totals, pnl: null, pnlReason: 'an open leg has no LTP' } } } : serve(path)))
  as('trader')
  await screen.findByText('INFY')
  const total = within(screen.getByText(/^Total \(/).closest('tr')!).getAllByRole('cell')[6]!
  expect([total.textContent, total.querySelector('[title]')!.getAttribute('title')]).toEqual(['—', 'an open leg has no LTP'])
})

test('a P&L sum with nothing to count is "—" saying shares are not in it, never 0: the totals and both roll-ups', async () => {
  const shares = row({ stock: 'INFY', pnl: null, pnlReason: 'no live expiry', months: [] })
  const totals = { ...VIEW.totals, pnl: null, pnlReason: 'no live expiry' }
  const roll: AdminPortfolioView = {
    ...ADMIN, traders: [{ trader: 'lalit', totals }],
    stocks: [{ ...ADMIN.stocks[0]!, stock: 'INFY', pnl: null, pnlReason: 'no live expiry' }],
  }
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: { ...VIEW, rows: [shares], totals } }
    : path === '/v1/traders/admin/portfolio' ? { body: roll } : serve(path)))
  as('admin')
  await screen.findByRole('table', { name: 'By underlying' })
  const pnlCell = (tr: Element, i: number): [string | null, string | null | undefined] => {
    const c = within(tr as HTMLElement).getAllByRole('cell')[i]!
    return [c.textContent, c.querySelector('[title]')?.getAttribute('title')]
  }
  await waitFor(() => expect(within(screen.getByRole('table', { name: 'By trader' })).getByText('lalit')).toBeTruthy())
  expect(pnlCell(screen.getByText(/^Total \(/).closest('tr')!, 6)).toEqual(['—', SHARES_PNL_TITLE])
  expect(pnlCell(within(screen.getByRole('table', { name: 'By trader' })).getByText('lalit').closest('tr')!, 6)).toEqual(['—', SHARES_PNL_TITLE])
  expect(pnlCell(within(screen.getByRole('table', { name: 'By underlying' })).getByText('INFY').closest('tr')!, 7)).toEqual(['—', SHARES_PNL_TITLE])
})

test('a month row with no P&L on a live expiry says the book\'s reason; a book with no series says P&L is not available', async () => {
  const noLtp = row({ pnl: null, pnlReason: 'an open leg has no LTP', months: [
    { expiry: '2026-10-27', delta: 175, gamma: -0.01, vega: -300, theta: 130, mtm: 9000, pnl: null },
    { expiry: '', delta: 175, gamma: 0, vega: 0, theta: 0, mtm: 5612, pnl: null },
  ] })
  const noSeries = row({ stock: 'NIFTY', pnl: null, pnlReason: 'no series', months: [] })
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: { ...VIEW, rows: [noSeries, noLtp], totals: { ...VIEW.totals, pnl: null, pnlReason: 'an open leg has no LTP' } } } : serve(path)))
  as('trader')
  await screen.findByText('TCS')
  const titled = (tr: Element): [string | null, string | null | undefined] => {
    const c = within(tr as HTMLElement).getAllByRole('cell')[6]!
    return [c.textContent, c.querySelector('[title]')?.getAttribute('title')]
  }
  expect(titled(screen.getByText('NIFTY').closest('tr')!)).toEqual(['—', 'P&L not available'])
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  expect(titled(screen.getByText('27 Oct 26').closest('tr')!)).toEqual(['—', 'an open leg has no LTP'])
  expect(titled(screen.getByText('Shares').closest('tr')!)).toEqual(['—', SHARES_PNL_TITLE])
})

test('P&L unknown is a dash with why on hover; a row without pnl (the server before its restart) is a dash too', async () => {
  const unknown = row({ pnl: null, pnlReason: 'an open leg has no LTP' })
  const { pnl: _p, pnlReason: _r, ...older } = row({ stock: 'NIFTY' })
  const { pnl: _t, ...totals } = VIEW.totals
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: { ...VIEW, rows: [older, unknown], totals } } : serve(path)))
  as('trader')
  await screen.findByText('TCS')
  const cellOf = (stock: string): Element => within(screen.getByText(stock).closest('tr')!).getAllByRole('cell')[6]!
  expect([cellOf('TCS').textContent, cellOf('TCS').querySelector('[title]')!.getAttribute('title')]).toEqual(['—', 'an open leg has no LTP'])
  expect([cellOf('NIFTY').textContent, cellOf('NIFTY').querySelector('[title]')!.getAttribute('title')]).toEqual(['—', 'server update pending'])
  expect(within(screen.getByText(/^Total \(/).closest('tr')!).getAllByRole('cell')[6]!.textContent).toBe('—')
})

test('the old server\'s row (mtmDay on the old basis, no mtmDayReason, no openPnl): dashes, "server update pending", not NaN and not that mtmDay', async () => {
  // as 1d07ad40 sends it: mtmToday/mtmTotal/mtmDay, no reason key; its totals have no mtmDay or openPnl either
  const { mtmDayReason: _r, openPnl: _o, pnl: _n, pnlReason: _w, ...rest } = row({})
  const old = { ...rest, mtmToday: 1200, mtmTotal: 14612, mtmDay: -8536 } as unknown as PortfolioRow
  const { mtmDay: _d, openPnl: _p, pnl: _t, ...totals } = VIEW.totals
  installFetch(({ path }) => (path === '/v1/traders/portfolio' ? { body: { ...VIEW, rows: [old], totals: { ...totals, mtmToday: 1200, mtmTotal: 14612 } } } : serve(path)))
  as('trader')
  await screen.findByText('TCS')
  const tcs = within(screen.getByText('TCS').closest('tr')!).getAllByRole('cell')
  expect([tcs[5]!.textContent, tcs[6]!.textContent]).toEqual(['—', '—'])
  expect(tcs[5]!.querySelector('[title]')!.getAttribute('title')).toBe('server update pending')
  const total = within(screen.getByText(/^Total \(/).closest('tr')!).getAllByRole('cell')
  expect([total[5]!.textContent, total[6]!.textContent]).toEqual(['—', '—'])
  expect(screen.queryByText(/8,536|NaN/)).toBeNull()
})

test('the SPAN file a margin was read from is on screen as text, with no hover needed', async () => {
  installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('NIFTY')
  const shown = screen.queryAllByText(`Margin read from ${SPAN_LABEL}: TCS`).filter((e) => e.closest('[role="tooltip"]') === null)
  expect(shown).toHaveLength(1)
})

test('a hidden tab asks for neither the portfolio nor the roll-up; showing it asks at once', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  const sent = installFetch(({ path }) => serve(path))
  as('admin')
  await act(async () => { await vi.advanceTimersByTimeAsync(2 * PORTFOLIO_POLL_MS) })
  expect(sent.map((r) => r.path)).toEqual([])
  Reflect.deleteProperty(document, 'hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sent.map((r) => r.path).sort()).toEqual(['/v1/traders/admin/portfolio', '/v1/traders/portfolio', '/v1/traders/vol'])
})

test('a trader session never asks for the admin roll-up', async () => {
  const sent = installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('NIFTY')
  expect(sent.some((r) => r.path.includes('/admin/'))).toBe(false)
  expect(screen.queryByText('By trader')).toBeNull()
})

test('an admin sees both roll-up tables', async () => {
  installFetch(({ path }) => serve(path))
  as('admin')
  await screen.findByText('By trader')
  expect(screen.getByText('By underlying (all traders)')).toBeTruthy()
  expect(await screen.findByRole('table', { name: 'By underlying' })).toBeTruthy()
  await waitFor(() => expect(within(screen.getByRole('table', { name: 'By trader' })).getByText('asha')).toBeTruthy())
  // Today and P&L in the roll-ups too; P&L unknown for a stock when any trader's is
  for (const name of ['By trader', 'By underlying']) {
    expect([...screen.getByRole('table', { name }).querySelectorAll('th')].map((h) => h.textContent).filter((t) => /MTM|P&L|Today/.test(t ?? ''))).toEqual(['Today', 'P&L'])
  }
  const roll = screen.getByRole('table', { name: 'By underlying' })
  expect(within(within(roll).getByText('TCS').closest('tr')!).getByText('-31,000')).toBeTruthy()
  expect(within(within(roll).getByText('NIFTY').closest('tr')!).getAllByRole('cell')[7]!.textContent).toBe('—')
  expect(within(screen.getByRole('table', { name: 'By trader' })).getByText('-36,046')).toBeTruthy()
})

test('a failed load says so', async () => {
  installFetch(() => ({ status: 500, body: { error: 'boom' } }))
  as('trader')
  expect(await screen.findByText('Could not load the portfolio: boom')).toBeTruthy()
})

test('an admin who has not picked a trader gets a prompt above the roll-up, not an error', async () => {
  installFetch(({ path }) => path === '/v1/traders/portfolio' ? { status: 400, body: { error: 'pick a trader: ?as=<username>' } } : serve(path))
  as('admin')
  expect(await screen.findByText('Pick a trader to see their portfolio')).toBeTruthy()
  expect(await screen.findByText('By trader')).toBeTruthy()
  expect(screen.queryByText(/Could not load the portfolio/)).toBeNull()
})

test('a book with no margin says so in words, and so does the by-underlying row', async () => {
  installFetch(({ path }) => serve(path))
  as('admin')
  const books = await screen.findByRole('table', { name: 'Portfolio' })
  await waitFor(() => expect(within(books).getByText('NIFTY')).toBeTruthy())
  expect(within(within(books).getByText('NIFTY').closest('tr')!).getByText('margin missing')).toBeTruthy()
  const roll = await screen.findByRole('table', { name: 'By underlying' })
  await waitFor(() => expect(within(roll).getByText('margin missing for some traders')).toBeTruthy())
})

test('a month row shows a dash under Today (a book\'s figure) and its expiry\'s P&L', async () => {
  installFetch(({ path }) => serve(path))
  as('trader')
  await screen.findByText('NIFTY')
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  const cells = within(screen.getByText('27 Oct 26').closest('tr')!).getAllByRole('cell')
  expect([cells[5]!.textContent, cells[6]!.textContent]).toEqual(['—', '-16,000'])
})
