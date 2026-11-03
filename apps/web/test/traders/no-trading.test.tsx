/** Nothing anywhere in the traders page offers to place, change or cancel an order. */
import { expect, test, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AdminPortfolioView, GroupsView, MarketSide, MarketWatchView, PortfolioView } from '../../../traders/src/analytics/r3-wire.ts'
import { TradersApp } from '../../src/traders/app.tsx'
import { installFetch } from '../http.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import { ASOF, BOOK_TCS, leg, summaries } from './fixtures.ts'

afterEach(() => {
  setAsTrader(null); window.location.hash = ''
  try { window.localStorage.clear() } catch { /* none */ }
})

const FORBIDDEN = /place|apply|square ?off|kill|flatten|submit order|cancel order|modify order|exit position|buy now|sell now|send order|execute/i

// Release 3's screens, wire-shaped: Market Watch, Portfolio and its roll-up, and a book's groups.
const SIDE: MarketSide = {
  ltp: 60, change: 2, changePct: 3.4, oi: 1000, oiChange: 50, volume: 20, iv: 0.24, ivSource: 'quote', stale: false,
  delta: 0.5, gamma: 0.002, vega: 3, theta: -1.5, bf: 1, bf2: 0.5, ratio: 1, ageMs: 100,
}
const GUESS = 'our reading of VolHedge, unconfirmed (Phase 0, Q3)'
const MARKET: MarketWatchView = {
  stock: 'TCS', asOf: ASOF, spot: 3050, spotStale: false, feedAlive: true, fullChains: true, oiDay: '2026-10-16',
  chains: [{
    expiry: '2026-10-27', lotSize: 175, step: 50, forward: 3055, forwardSource: 'future',
    future: { ltp: 3055, change: 5, changePct: 0.16, ageMs: 100, stale: false },
    rows: [{ strike: 3050, straddle: 120, ce: SIDE, pe: SIDE }, { strike: 3100, straddle: 110, ce: SIDE, pe: { ...SIDE, stale: true } }],
  }],
  labels: { bf: `BF = …: ${GUESS}`, bf2: `BF2 = …: ${GUESS}`, ratio: `Ratio = …: ${GUESS}` }, warnings: [],
}
const TOTALS: PortfolioView['totals'] = { books: 1, outOfBand: 1, deltaValue: 900000, vega: -300, theta: 140, mtmDay: 1200, openPnl: 14612, margin: 250000, marginMissing: [] }
const PORTFOLIO: PortfolioView = {
  trader: 'ravi', asOf: ASOF, warnings: [], totals: TOTALS,
  rows: [{
    stock: 'TCS', spot: 3050, lotSize: 175, delta: 297.5, deltaLots: 1.7, gamma: -0.0123, vega: -310, theta: 140,
    mtmDay: 1200, mtmDayReason: null, openPnl: 14612, margin: 250000, marginLabel: 'NSE SPAN end of day 19 Oct', band: 'out',
    bandSentence: 'Out of band by 1 lot', months: [
      { expiry: '2026-10-27', delta: -52.5, gamma: -0.0123, vega: -310, theta: 140, mtm: 1487.5 },
      { expiry: '', delta: 350, gamma: 0, vega: 0, theta: 0, mtm: 13125 },
    ],
  }],
}
const ADMIN_PORTFOLIO: AdminPortfolioView = {
  asOf: ASOF, warnings: [], traders: [{ trader: 'ravi', totals: TOTALS }],
  stocks: [{ stock: 'TCS', traders: 1, delta: 297.5, deltaLots: 1.7, gamma: -0.0123, vega: -310, theta: 140, mtmDay: 1200, openPnl: 14612, margin: 250000 }],
}
const GROUP_TOTALS = { delta: -52.5, gamma: -0.0123, vega: -310, theta: 140, mtm: 1487.5 }
const GROUPS: GroupsView = {
  stock: 'TCS', asOf: ASOF,
  groups: [{ name: 'hedge', keys: [leg().key], legCount: 1, totals: GROUP_TOTALS, payoff: null }],
  ungrouped: { name: 'ungrouped', keys: [], legCount: 0, totals: { ...GROUP_TOTALS, delta: 0 }, payoff: null },
}

function boot(role: 'admin' | 'trader', hash: string): void {
  installFetch(({ path }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'u', role } }
    if (path === '/v1/traders/books') return { body: summaries('TCS') }
    if (path === '/v1/traders/market/TCS') return { body: MARKET }
    if (path === '/v1/traders/portfolio') return { body: PORTFOLIO }
    if (path === '/v1/traders/admin/portfolio') return { body: ADMIN_PORTFOLIO }
    if (path === '/v1/traders/books/TCS/groups') return { body: GROUPS }
    if (path.startsWith('/v1/traders/books/')) return { body: BOOK_TCS }
    if (path === '/v1/traders/admin/traders') {
      return { body: [{ username: 'ravi', disabled: false, lastLoginAt: null, watcher: null, token: { createdAt: 0, lastUsedAt: null } }] }
    }
    return { body: [] }
  })
  window.location.hash = hash
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
}

/** Every control's accessible text, plus any text node that reads as a call to trade. */
function offers(): string[] {
  const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], input[type="submit"]')]
    .map((e) => `${e.textContent ?? ''} ${e.getAttribute('aria-label') ?? ''}`.trim())
  return controls.filter((n) => FORBIDDEN.test(n))
}

test('the orders screen offers nothing to trade', async () => {
  boot('trader', '#/orders')
  await screen.findByRole('tab', { name: 'Trades' })
  expect(offers()).toEqual([])
})

test('the admin screen, with each of its dialogs open, offers nothing to trade', async () => {
  boot('admin', '#/admin')
  await screen.findByText('ravi', { selector: 'td *' })
  expect(offers()).toEqual([])
  for (const name of ['Add trader', 'Reset password', 'Upload file']) {
    fireEvent.click(screen.getAllByRole('button', { name })[0] as HTMLElement)
    await screen.findByRole('dialog')
    expect(offers()).toEqual([])
    fireEvent.click(screen.getAllByRole('button', { name: /Cancel|Close/ })[0] as HTMLElement)
  }
})

test('a book with its add-leg, edit and delete dialogs open offers nothing to trade', async () => {
  boot('trader', '#/books/TCS')
  await screen.findByText('as of 10:27 IST')
  expect(offers()).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Add leg' }))
  let dialog = await screen.findByRole('dialog')
  expect(offers()).toEqual([])
  expect(dialog.textContent).not.toMatch(FORBIDDEN)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  dialog = await screen.findByRole('dialog')
  expect(offers()).toEqual([])
  expect(dialog.textContent).not.toMatch(FORBIDDEN)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  dialog = await screen.findByRole('dialog')
  expect(offers()).toEqual([])
  expect(dialog.textContent).not.toMatch(FORBIDDEN)
})

test('Market Watch, with its Columns dialog open, offers nothing to trade', async () => {
  boot('trader', '#/market')
  fireEvent.change(await screen.findByLabelText(/Underlying/), { target: { value: 'TCS' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show' }))
  await screen.findByText('TCS OCT FUT 3,055.00 +5.00 (0.16%)')
  expect(offers()).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
  const dialog = await screen.findByRole('dialog')
  expect(offers()).toEqual([])
  expect(dialog.textContent).not.toMatch(FORBIDDEN)
})

test('the Range page, filled from Market Watch, offers nothing to trade', async () => {
  boot('trader', '#/range')
  fireEvent.change(await screen.findByLabelText('Underlying'), { target: { value: 'TCS' } })
  fireEvent.click(screen.getByRole('button', { name: 'Fill CMP' }))
  await waitFor(() => expect((screen.getByLabelText('CMP') as HTMLInputElement).value).toBe('3050'))
  fireEvent.change(screen.getByLabelText('Volatility %'), { target: { value: '27.7' } })
  await screen.findByRole('table', { name: 'Range' })
  expect(offers()).toEqual([])
})

test('the Portfolio, Month wise, offers nothing to trade to a trader', async () => {
  boot('trader', '#/portfolio')
  await screen.findByText('Out of band by 1 lot')
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  await screen.findByText('27 Oct 26')
  expect(offers()).toEqual([])
})

test('the Portfolio with its roll-up offers nothing to trade to an admin', async () => {
  boot('admin', '#/portfolio')
  await screen.findByRole('table', { name: 'By underlying' })
  await screen.findByText('ravi', { selector: 'td *' })
  fireEvent.click(screen.getByRole('switch', { name: 'Month wise' }))
  await screen.findByText('27 Oct 26')
  expect(offers()).toEqual([])
})

test('a book\'s Groups sub-tab offers nothing to trade', async () => {
  boot('trader', '#/books/TCS/groups')
  await screen.findByLabelText('hedge totals')
  fireEvent.change(screen.getAllByRole('textbox', { name: /^Group for/ })[0] as HTMLElement, { target: { value: 'straddle' } })
  await screen.findByRole('button', { name: 'Discard' })
  expect(offers()).toEqual([])
})

test('the detector catches an offer (the test is not vacuous)', () => {
  render(<button type="button">Place order</button>)
  expect(offers()).toEqual(['Place order'])
})
