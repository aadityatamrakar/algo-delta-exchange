/** The book's front: the summary strip and the legs; explanations behind ⓘ, breakdowns in folds. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import { resetLive } from '../../src/traders/live.tsx'
import { LEG_PNL_TITLE, PNL_ABOUT, SHARES_LINE, TODAY_ABOUT } from '../../src/traders/series-lines.ts'
import { installFetch } from '../http.tsx'
import type { BookView, SeriesPnl } from '../../../traders/src/types.ts'
import { ASOF, EMPTY_PAYOFF, bookView, summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null); window.localStorage.clear(); window.location.hash = ''; resetLive(); vi.unstubAllGlobals() })

// Today −4,200 (the block's total) and the legs at net price +12,500: two figures, only the first is on the strip
const ROW = {
  stock: 'TCS', spot: 3050, lotSize: 175, delta: -350, deltaLots: -2, gamma: 0, vega: 0, theta: 0,
  mtmDay: -4200, mtmDayReason: null, openPnl: 12500, margin: 185000, marginLabel: 'NSE SPAN end of day 19 Oct',
  band: null, bandSentence: null, months: [],
}

function mount(rows: unknown[] = [ROW], view: Partial<BookView> = {}): void {
  installFetch(({ path, method }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return { body: summaries('TCS') }
    if (path === '/v1/traders/books/TCS' && method === 'GET') return { body: bookView({ payoff: EMPTY_PAYOFF, ...view }) }
    if (path === '/v1/traders/portfolio') {
      return { body: { trader: 'ravi', asOf: 0, rows, warnings: [],
        totals: { books: 1, outOfBand: 0, deltaValue: 0, vega: 0, theta: 0, mtmDay: null, openPnl: 0, margin: 0, marginMissing: [] } } }
    }
    return { status: 404, body: { error: 'not in this test' } }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
}

test('the strip: Today, net delta in shares and margin from the portfolio; the margin source behind its ⓘ', async () => {
  window.location.hash = '#/books/TCS'
  mount()
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(within(strip).getByText('Margin')).toBeTruthy())
  await waitFor(() => expect(strip.textContent).toMatch(/Today.*-4,200|Today.*−4,200/))
  expect(within(strip).getByText('1.9L').getAttribute('title')).toBe('₹1,85,000')   // margin in lakh, the rupees on hover
  // one day figure, not two: the legs at net price (+12,500) are not on the strip, and "MTM today" is gone
  expect(strip.textContent).not.toMatch(/12,500|MTM today/)
  expect(within(strip).queryByText('P&L')).toBe(null)   // an older server sends no series: not shown
  fireEvent.click(within(strip).getByRole('button', { name: 'About Today' }))
  // the book holds shares: Today counts them, P&L does not
  expect([...within(strip).getByRole('note', { name: 'Today' }).children].map((c) => c.textContent)).toEqual([TODAY_ABOUT, SHARES_LINE])
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(strip.textContent).toMatch(/Net Δ.*-350/)   // shares, not lots
  expect(strip.textContent).not.toMatch(/lots/)
  expect(screen.queryByText('NSE SPAN end of day 19 Oct')).toBe(null)
  fireEvent.click(within(strip).getByRole('button', { name: 'About the margin' }))
  expect(within(strip).getByRole('note', { name: 'the margin' }).textContent).toBe('NSE SPAN end of day 19 Oct')
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByText('NSE SPAN end of day 19 Oct')).toBe(null))
})

test('a book the portfolio does not list still shows delta from the book itself; Today is unknown, never the legs at net price', async () => {
  window.location.hash = '#/books/TCS'
  mount([])
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(within(strip).getAllByText('—').length).toBe(5))   // Today, Margin, Δ0, BEP, time value
  expect(within(strip).getByText('Today')).toBeTruthy()
  expect(strip.textContent).not.toMatch(/14,61[23]/)   // the book's Σ(LTP − net) × qty is the open P&L, not the day's move
  expect(strip.textContent).toMatch(/Net Δ.*\+298/)
})

test('Today is the MTM block\'s total: unknown when the block\'s is, even though the legs at net price are a number', async () => {
  window.location.hash = '#/books/TCS'
  mount([{ ...ROW, mtmDay: null }])
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(strip.textContent).toMatch(/Margin.*1\.9L/))
  const pair = [...strip.querySelectorAll('.traders-pair')].find((x) => x.firstElementChild?.textContent === 'Today')!
  expect(pair.lastElementChild?.textContent).toBe('—')
  expect(strip.textContent).not.toMatch(/12,500/)   // the legs at net price never stand in for it
  cleanup()
  mount([{ ...ROW, mtmDay: 3100 }])
  const again = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(again.textContent).toMatch(/Today.*\+3,100/))
})

test('before the open Today is "—" with "market opens 09:15" on hover', async () => {
  window.location.hash = '#/books/TCS'
  mount([{ ...ROW, mtmDay: null, mtmDayReason: 'market opens 09:15' }])
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(strip.textContent).toMatch(/Margin.*1\.9L/))
  const pair = [...strip.querySelectorAll('.traders-pair')].find((x) => x.firstElementChild?.textContent === 'Today')!
  expect([pair.lastElementChild?.textContent, pair.lastElementChild?.getAttribute('title')]).toEqual(['—', 'market opens 09:15'])
})

/** Today's value cell on the strip. */
const dayCell = (strip: HTMLElement): Element => [...strip.querySelectorAll('.traders-pair')].find((x) => x.firstElementChild?.textContent === 'Today')!.lastElementChild!

// The deploy window: the web is live on a build, the server on the operator's restart. The server of 1d07ad40 sends
// mtmDay, mtmToday and mtmTotal on the OLD basis (the open cycle's charges in them, no pre-open null) with no reason
// key and no openPnl; the new names would label them wrongly, so the strip shows "—" until the new server is there.
test('an old server\'s row has mtmDay but no mtmDayReason: Today is "—", "server update pending", never that old-basis figure', async () => {
  window.location.hash = '#/books/TCS'
  const old: Record<string, unknown> = { ...ROW, mtmToday: 12500, mtmTotal: -4200, mtmDay: -8536 }   // as the live server sends it
  delete old['mtmDayReason']; delete old['openPnl']
  mount([old])
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(strip.textContent).toMatch(/Margin.*1\.9L/))
  expect([dayCell(strip).textContent, dayCell(strip).getAttribute('title')]).toEqual(['—', 'server update pending'])
  expect(strip.textContent).not.toMatch(/8,536|4,200|12,500/)
})

/** EventSource as the page uses it, enough to push frames at the strip. */
class FakeSource {
  static made: FakeSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly #on = new Map<string, ((e: MessageEvent<string>) => void)[]>()
  constructor(readonly url: string) { FakeSource.made.push(this) }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void): void { this.#on.set(name, [...(this.#on.get(name) ?? []), fn]) }
  close(): void {}
  emit(name: string, data: unknown): void { for (const fn of this.#on.get(name) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent<string>) }
}
const frame = (over: Record<string, unknown>): Record<string, unknown> => ({
  stock: 'TCS', asOf: ASOF + 5_000, closed: false, feedAlive: true, spot: 3050, future: 3055, legs: [], mtmToday: -500, mtmTotal: 1200, ...over,
})

async function withStream(rows: unknown[], emitted: Record<string, unknown>, view: Partial<BookView> = {}): Promise<HTMLElement> {
  FakeSource.made = []
  vi.stubGlobal('EventSource', FakeSource)
  window.location.hash = '#/books/TCS'
  mount(rows, view)
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(FakeSource.made.length).toBeGreaterThan(0))
  act(() => { for (const s of FakeSource.made) s.emit('frame', emitted) })
  return strip
}

test('a live frame wins only from the new server (it has mtmReason); the old server\'s frame is not Today', async () => {
  const fresh = await withStream([ROW], frame({ mtmReason: null }))
  await waitFor(() => expect(fresh.textContent).toMatch(/Today.*\+1,200/))   // the frame's total, not the row's -4,200
  cleanup(); resetLive()
  // the old server's frame (no mtmReason) over its old row: both on the old basis, neither shown
  const old: Record<string, unknown> = { ...ROW, mtmToday: 12500, mtmTotal: -4200, mtmDay: -8536 }
  delete old['mtmDayReason']
  const stale = await withStream([old], frame({}))
  await waitFor(() => expect(stale.textContent).toMatch(/Margin.*1\.9L/))
  expect([dayCell(stale).textContent, dayCell(stale).getAttribute('title')]).toEqual(['—', 'server update pending'])
  expect(stale.textContent).not.toMatch(/1,200|8,536/)
  cleanup(); resetLive()
  // the new server's frame before the open: no figures, and why
  const pre = await withStream([ROW], frame({ mtmToday: null, mtmTotal: null, mtmReason: 'market opens 09:15' }))
  await waitFor(() => expect(dayCell(pre).getAttribute('title')).toBe('market opens 09:15'))
  expect(dayCell(pre).textContent).toBe('—')
})

test("the book is one view: its legs, the payoff chart and the book's totals are blocks on it, nothing folded", async () => {
  window.location.hash = '#/books/TCS'
  mount()
  await screen.findByText('as of 10:27 IST')
  // No /analysis in this test: the book's own legs stand in, with the payoff chart and the totals beside them.
  const page = screen.getByRole('region', { name: 'TCS book' })
  expect(within(page).getByText(/the book's own legs/)).toBeTruthy()
  expect(within(page).getByText(/The scan came back empty/)).toBeTruthy()
  const totals = within(page).getByLabelText('Book totals')
  // the book's totals are its greeks: its result is P&L, on the strip; a leg's own figure is "Leg P&L", said so on hover
  expect(within(totals).queryByText(/MTM|P&L/)).toBe(null)
  expect(within(page).getByText('Leg P&L').getAttribute('title')).toBe(LEG_PNL_TITLE)
  expect(screen.queryByRole('button', { name: /^Payoff chart/ })).toBe(null)
  expect(screen.getByRole('button', { name: 'Analysis' }).getAttribute('aria-current')).toBe('page')
})

test('the strip shows Δ0 — price and signed distance from spot — and the breakevens, Δ0 explained behind an ⓘ', async () => {
  installFetch(({ path, method }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return { body: summaries('TCS') }
    if (path === '/v1/traders/books/TCS' && method === 'GET') return { body: bookView({ payoff: EMPTY_PAYOFF }) }
    // only To Neutralize is read by the strip; the view itself falls back to the book's legs for this partial answer
    if (path === '/v1/traders/books/TCS/analysis') return { body: { toNeutralize: { price: 3034.12, pct: -0.74 }, breakevens: { low: 2997.4, high: null }, bookTimeValue: 155843.75 } }
    return { status: 404, body: { error: 'not in this test' } }
  })
  window.location.hash = '#/books/TCS'
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  const strip = await screen.findByRole('group', { name: 'Book summary' })
  await waitFor(() => expect(within(strip).getByText('3,034.1 (−0.74 %)')).toBeTruthy())
  expect(within(strip).getByText('2,997.4 – —')).toBeTruthy()   // BEP, the high side unknown
  expect(within(strip).getByText('1,55,844')).toBeTruthy()      // time value, whole rupees
  expect([...strip.querySelectorAll('.traders-pair')].map((x) => x.firstElementChild?.textContent))
    .toEqual(['Today', 'Net Δ', 'Δ0', 'BEP', 'Time value', 'Margin'])
  fireEvent.click(within(strip).getByRole('button', { name: 'About Δ0' }))
  expect(within(strip).getByText(/the price where the book's delta is zero/)).toBeTruthy()
})

const SERIES: SeriesPnl[] = [
  { expiry: '2026-10-27', open: 70156, booked: -51344, gross: 18812, charges: 2100.4, net: 16711.6, closedContracts: 6, openLegs: 5, from: '2026-10-08', since: null, noLtp: [], notes: [] },
  { expiry: '2026-11-24', open: 0, booked: 3500, gross: 3500, charges: 40, net: 3460, closedContracts: 1, openLegs: 0, from: '2026-10-19', since: '2026-10-13', noLtp: [],
    notes: ['booked since 13 Oct 2026 — the trade history starts there'] },
]
const SERIES_TOTAL = {
  open: 70156, booked: -47844, gross: 22312, charges: 2140.4, net: 20171.6, closedContracts: 7, from: '2026-10-08', ratesConfirmed: false,
  notes: ['shares are left out of P&L: they have no expiry'],
}

test('the strip shows P&L first, then Today; P&L\'s parts and every live series behind its ⓘ, estimates said', async () => {
  window.location.hash = '#/books/TCS'
  mount([ROW], { series: SERIES, seriesTotal: SERIES_TOTAL })
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(within(strip).getByText('P&L')).toBeTruthy())
  expect([...strip.querySelectorAll('.traders-pair')].map((x) => x.firstElementChild?.textContent).slice(0, 3)).toEqual(['P&L', 'Today', 'Net Δ'])
  const value = within(strip).getByText('+20,172')
  expect(value.getAttribute('title')).toBe('Rates not confirmed by admin — charges are estimates')
  fireEvent.click(within(strip).getByRole('button', { name: 'About P&L' }))
  const lines = [...within(strip).getByRole('note', { name: 'P&L' }).children].map((c) => c.textContent)
  expect(lines).toEqual([
    PNL_ABOUT,
    'P&L since 8 Oct, after charges +20,172 = booked on closed contracts -47,844 · open legs at LTP +70,156 · charges -2,140 (est.)',
    "Today bears the charges of today's fills only; the open cycle's earlier charges are in P&L's charges",
    '27 Oct 26: P&L +16,712 · booked -51,344 · open legs +70,156 · charges 2,100 (est.) · 6 closed · from 08 Oct 26',
    '24 Nov 26: P&L +3,460 · booked +3,500 · open legs 0 · charges 40 (est.) · 1 closed · from 19 Oct 26',
    '24 Nov 26: booked since 13 Oct 2026 — the trade history starts there',
    'shares are left out of P&L: they have no expiry',
    'Rates not confirmed by admin — charges are estimates',
    SHARES_LINE,
  ])
})

test('a fresh frame\'s P&L wins over the book\'s; a frame without it (the old server) leaves the book\'s', async () => {
  const pnl = { mtmReason: null, seriesNet: -18023, seriesOpen: -173488, seriesBooked: 159125, seriesCharges: 3660 }
  const strip = await withStream([ROW], frame(pnl), { series: SERIES, seriesTotal: SERIES_TOTAL })
  await waitFor(() => expect(within(strip).getByText('-18,023')).toBeTruthy())
  fireEvent.click(within(strip).getByRole('button', { name: 'About P&L' }))
  expect(within(strip).getByText('P&L since 8 Oct, after charges -18,023 = booked on closed contracts +1,59,125 · open legs at LTP -1,73,488 · charges -3,660 (est.)')).toBeTruthy()
  act(() => { for (const x of FakeSource.made) x.emit('frame', frame({ asOf: ASOF + 6_000, mtmReason: null })) })
  await waitFor(() => expect(within(strip).getByText('+20,172')).toBeTruthy())
})

test('a series whose open legs lack an LTP shows its net as unknown, never 0', async () => {
  window.location.hash = '#/books/TCS'
  mount([ROW], { series: [{ ...SERIES[0]!, open: null, gross: null, net: null }], seriesTotal: { ...SERIES_TOTAL, open: null, gross: null, net: null, ratesConfirmed: true, notes: [] } })
  const strip = await screen.findByLabelText('Book summary')
  await waitFor(() => expect(within(strip).getByText('P&L')).toBeTruthy())
  const pair = [...strip.querySelectorAll('.traders-pair')].find((x) => x.firstElementChild?.textContent === 'P&L')!
  expect(pair.lastElementChild?.textContent).toBe('—')
  expect(pair.lastElementChild?.getAttribute('title')).toBe(null)
})
