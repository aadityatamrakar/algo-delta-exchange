/**
 * The dashboard on Delta Exchange (DX): USD money with a ₹ second figure,
 * Delta contract names, a 24x7 session that ends at the 12:00 UTC settlement,
 * 0.001-step quantities, the option chain page, and the BULL-S Close book /
 * Re-arm buttons.
 *
 * Every venue-dependent helper takes the venue as its last argument, so these
 * tests state DX explicitly and the rest of the suite keeps running on the
 * default (NSE) build unchanged.
 */
import { describe, expect, test, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DX, NSE, lotsOf } from '../src/venue.ts'
import { cash, currencySymbol, inr, inrCompact, inrSecond, money, signed } from '../src/format.ts'
import { formatContract, parseContract } from '../src/contract.ts'
import { API_BASE, inSession, pastExpiry, type BookRow } from '../src/api.ts'
import { navRoutesFor } from '../src/shell.tsx'
import { bullsPatch, isBullS } from '../src/bulls.ts'
import { ChainPage, atmStrike, expiryClass } from '../src/chain.tsx'
import { BooksPage } from '../src/books.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type SentRequest } from './http.tsx'

describe('money on DX', () => {
  test('USD with two decimals and the sign in front of the $', () => {
    expect(money(1234.5, undefined, DX)).toBe('+$1,234.50')
    expect(money(-12, undefined, DX)).toBe('-$12.00')
    expect(money(0, undefined, DX)).toBe('$0.00')
    expect(money(null, undefined, DX)).toBe('—')
  })

  test('NSE is unchanged: Indian grouping, no symbol, whole rupees', () => {
    expect(money(123456, undefined, NSE)).toBe('+1,23,456')
    expect(inr(123456, 0, NSE)).toBe('1,23,456')
  })

  test('a 0.05 BTC quantity is never printed as 0', () => {
    expect(inr(0.05, 0, DX)).toBe('0.05')
    expect(inr(0.001, 0, DX)).toBe('0.001')
    expect(signed(-0.15, 0, DX)).toBe('-0.15')
    expect(inr(76600.1, 0, DX)).toBe('76,600.1')
  })

  test('compact headline figures in thousands and millions', () => {
    expect(inrCompact(1_250_000, DX)).toBe('$1.25M')
    expect(inrCompact(12_300, DX)).toBe('$12.3K')
    expect(inrCompact(950, DX)).toBe('$950.00')
  })

  test('a ₹ second figure at 85 on totals — none on NSE', () => {
    expect(inrSecond(1235, DX)).toBe('≈ ₹1,04,975')
    expect(inrSecond(-10, DX)).toBe('≈ -₹850')
    expect(inrSecond(1235, NSE)).toBe(null)
  })

  test('unsigned cash in the venue currency', () => {
    expect(cash(3000, DX)).toBe('$3,000.00')
    expect(cash(3000, NSE)).toBe('₹3,000')
    expect(currencySymbol(DX)).toBe('$')
    expect(currencySymbol(NSE)).toBe('₹')
  })
})

describe('Delta contracts', () => {
  test('C-BTC-76600-041126 reads as BTC 04 Nov 76600 CE', () => {
    expect(parseContract('C-BTC-76600-041126')).toEqual({
      underlying: 'BTC', strike: 76600, type: 'CE', expiry: '2026-11-04',
    })
    expect(formatContract('C-BTC-76600-041126')).toBe('BTC 04 Nov 76600 CE')
    expect(formatContract('P-BTC-70000-271126')).toBe('BTC 27 Nov 70000 PE')
  })

  test('the NSE packings still parse as before', () => {
    expect(formatContract('DLF26AUG600PE')).toBe('DLF 600 PE')
    expect(parseContract('BTCUSD')).toBe(null)
  })
})

describe('the DX session', () => {
  test('open 24x7, a Sunday included; NSE shut on a Saturday', () => {
    expect(inSession(Date.parse('2026-11-08T03:00:00Z'), DX)).toBe(true)
    expect(inSession(Date.parse('2026-11-07T06:00:00Z'), NSE)).toBe(false)
    expect(inSession(Date.parse('2026-11-03T04:00:00Z'), NSE)).toBe(true)
  })

  test('an expiry is past at 12:00:00 UTC on its own date, not at midnight', () => {
    expect(pastExpiry('2026-11-04', Date.parse('2026-11-04T11:59:59Z'), DX)).toBe(false)
    expect(pastExpiry('2026-11-04', Date.parse('2026-11-04T12:00:00Z'), DX)).toBe(true)
    // NSE: 15:30 IST = 10:00 UTC.
    expect(pastExpiry('2026-11-04', Date.parse('2026-11-04T09:59:00Z'), NSE)).toBe(false)
    expect(pastExpiry('2026-11-04', Date.parse('2026-11-04T10:00:00Z'), NSE)).toBe(true)
  })
})

describe('0.001-step quantities', () => {
  test('qty over lot size is a whole number of contracts, not 569.999', () => {
    expect(lotsOf(0.57, 0.001)).toBe(570)
    expect(lotsOf(0.05 + 0.05 + 0.05, 0.001)).toBe(150)
    expect(lotsOf(1500, 750)).toBe(2)
    expect(lotsOf(0.0005, 0.001)).toBe(0.5)
  })
})

describe('the nav on DX', () => {
  test('has the Option chain and no NSE Broker view', () => {
    const dx = navRoutesFor(DX).map((r) => r.id)
    expect(dx).toContain('chain')
    expect(dx).not.toContain('broker')
    expect(navRoutesFor(NSE).map((r) => r.id)).toContain('broker')
  })
})

describe('the API base', () => {
  test('falls back to the page origin, which proxies /v1/*', () => {
    expect(API_BASE).toBe(window.location.origin)
  })
})

// ------------------------------------------------------------ BULL-S buttons

const TAG = 'BTC-2026-11-04-bull-s-daily'

function bookRow(dials: BookRow['dials'], over: Partial<BookRow> = {}): BookRow {
  return {
    tag: TAG, symbol: 'BTC', expiry: '2026-11-04', mode: 'paper', variant: 'bull-s-btc-daily',
    dials, desired: 'running', actual: 'running', lastMarkAt: 0, lastDecision: '',
    createdAt: 0, updatedAt: 0, ...over,
  }
}

describe('BULL-S close / re-arm', () => {
  test('the patch is the counter +1, and only that dial', () => {
    expect(bullsPatch(bookRow({ bs_enabled: true, bs_close_req: 2 }), 'close')).toEqual({ bs_close_req: 3 })
    expect(bullsPatch(bookRow({ bs_enabled: true }), 'rearm')).toEqual({ bs_rearm_req: 1 })
    expect(isBullS(bookRow({ bs_enabled: true }))).toBe(true)
    expect(isBullS(bookRow({ bs_enabled: false }))).toBe(false)
    expect(isBullS(bookRow({}))).toBe(false)
  })

  function mount(rows: BookRow[]): SentRequest[] {
    window.localStorage.setItem('desk.mode', 'paper')
    const sent = installFetch(({ path, method }) => {
      if (path === '/v1/desk/books/registry' && method === 'GET') return { body: { books: rows } }
      if (path === '/v1/desk/books' && method === 'GET') return { body: { books: [] } }
      if (path === '/v1/desk/pnl' && method === 'GET') {
        return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
      }
      if (method === 'PATCH') return { body: rows[0] }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <BooksPage mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
    return sent
  }

  test('Close book asks first, then PATCHes bs_close_req +1', async () => {
    const sent = mount([bookRow({ bs_enabled: true, bs_close_req: 2, bs_rearm_req: 5 })])
    const btn = await screen.findByRole('button', { name: 'Close book' })
    act(() => { btn.click() })
    expect(sent.filter((r) => r.method === 'PATCH')).toEqual([])
    const dialog = screen.getByRole('alertdialog')
    act(() => { within(dialog).getByRole('button', { name: 'Close the book' }).click() })
    await waitFor(() => {
      const patch = sent.find((r) => r.method === 'PATCH')
      expect(patch?.path).toBe(`/v1/desk/books/registry/${TAG}`)
      expect(patch?.body).toEqual({ mode: 'paper', dials: { bs_close_req: 3 } })
    })
  })

  test('Re-arm PATCHes bs_rearm_req +1', async () => {
    const sent = mount([bookRow({ bs_enabled: true, bs_close_req: 2, bs_rearm_req: 5 })])
    const btn = await screen.findByRole('button', { name: 'Re-arm' })
    act(() => { btn.click() })
    const dialog = screen.getByRole('alertdialog')
    act(() => { within(dialog).getByRole('button', { name: 'Re-arm the book' }).click() })
    await waitFor(() => {
      const patch = sent.find((r) => r.method === 'PATCH')
      expect(patch?.body).toEqual({ mode: 'paper', dials: { bs_rearm_req: 6 } })
    })
  })

  test('a book without bs_enabled has neither button', async () => {
    mount([bookRow({ bs_enabled: false })])
    await screen.findByText(TAG)
    expect(screen.queryByRole('button', { name: 'Close book' })).toBe(null)
    expect(screen.queryByRole('button', { name: 'Re-arm' })).toBe(null)
  })
})

// --------------------------------------------------------------- chain page

describe('expiry classes', () => {
  test('daily, weekly (Friday), monthly (last Friday)', () => {
    expect(expiryClass('2026-11-04')).toBe('daily')
    expect(expiryClass('2026-11-06')).toBe('weekly')
    expect(expiryClass('2026-11-27')).toBe('monthly')
  })

  test('the 3 Nov BTC listing: every expiry files under one class', () => {
    const listed = ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-13',
      '2026-11-20', '2026-11-27', '2026-12-25', '2027-01-29']
    expect(listed.map(expiryClass)).toEqual(['daily', 'daily', 'daily', 'weekly', 'weekly',
      'weekly', 'monthly', 'monthly', 'monthly'])
  })

  test('ATM is the strike nearest the index price', () => {
    expect(atmStrike([76000, 76200, 76400], 76290)).toBe(76200)
    expect(atmStrike([76000, 76200], null)).toBe(null)
  })
})

describe('the option chain page', () => {
  afterEach(() => { vi.useRealTimers() })

  test('renders both sides with dashes where a field is absent, and marks ATM', async () => {
    const sent = installFetch(({ path, url }) => {
      if (path === '/v1/desk/chain/BTC/expiries') {
        return { body: { expiries: ['2026-11-04', '2026-11-06', '2026-11-27'] } }
      }
      if (path === '/v1/desk/chain/BTC') {
        return {
          body: {
            underlying: 'BTC', expiry: url.searchParams.get('expiry'), spot: 76290, future: null, lotSize: 0.001,
            rows: [
              {
                strike: 76200,
                CE: { price: 900, ageMs: 100, bid: 890, ask: 910.5, mark: 900.2, iv: 0.412, delta: 0.55, oi: 1200, gamma: 0.0001, theta: -50, vega: 20 },
                PE: { price: 800, ageMs: 100, bid: 790, ask: 810 },
              },
              { strike: 76400, CE: null, PE: null },
            ],
          },
        }
      }
      return { body: {} }
    })
    render(<ChainPage />)
    await screen.findByText('76,200')
    // The first expiry is asked for by default.
    expect(sent.some((r) => r.path === '/v1/desk/chain/BTC' && r.url.includes('expiry=2026-11-04'))).toBe(true)
    // Present fields render; IV as a percentage.
    expect(screen.getByText('910.5')).toBeTruthy()
    expect(screen.getByText('41.2%')).toBeTruthy()
    // The index price is on the page.
    expect(screen.getByText(/76,290/)).toBeTruthy()
    // The ATM row is marked.
    const atm = screen.getByText('76,200').closest('tr')
    expect(atm?.getAttribute('data-atm')).toBe('true')
    // The PE side carries no mark/IV/delta/OI: dashes, not zeros.
    expect(screen.getAllByText('—').length).toBeGreaterThan(4)
    // Expiry tabs, grouped.
    expect(screen.getByText(/Daily/)).toBeTruthy()
    expect(screen.getByText(/Weekly/)).toBeTruthy()
    expect(screen.getByText(/Monthly/)).toBeTruthy()
  })

  test('choosing another expiry reads that expiry', async () => {
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-04', '2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') return { body: { spot: 76290, future: null, rows: [] } }
      return { body: {} }
    })
    render(<ChainPage />)
    // astryx renders a Tab as a <button> inside a <nav>, not role="tab".
    const tab = await screen.findByRole('button', { name: /06 Nov/ })
    fireEvent.click(tab)
    await waitFor(() => {
      expect(sent.some((r) => r.path === '/v1/desk/chain/BTC' && r.url.includes('expiry=2026-11-06'))).toBe(true)
    })
  })
})
