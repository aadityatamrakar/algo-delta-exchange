/**
 * Margin utilized: the two Delta accounts (Positions panel, Status card), the
 * BULL-S books' estimates (Books rows, Dials panel), and the
 * `bs_margin_budget` dial.
 *
 * THE RULE EVERY TEST HERE GUARDS: a figure the server does not know is null,
 * and null is never painted as 0. A failed account shows its error, an absent
 * one its reason, an unestimable book a dash with what is missing.
 */
import { describe, expect, test } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import type { AccountMargin, BookMarginEstimate, BookRow } from '../src/api.ts'
import { AccountMarginPanel, MarginStatusCard, marginTone, usdWithInr } from '../src/margin.tsx'
import { BooksPage } from '../src/books.tsx'
import { DialsPanel } from '../src/dials-panel.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider, useReauth } from '../src/auth.tsx'
import { dialMeta, readDial } from '../src/dials-plan.ts'
import { installFetch, type SentRequest } from './http.tsx'

const account = (over: Partial<AccountMargin> = {}): AccountMargin => ({
  id: 'delta-demo', rail: 'demo', label: 'Demo', state: 'ok',
  asOf: 1_760_000_000_000, ageMs: 4_000,
  balance: 1000, available: 600, positionMargin: 350, orderMargin: 50, portfolioMargin: 0,
  used: 400, utilizedPct: 40, error: '', reason: '',
  ...over,
})

const NULLS = {
  asOf: null, ageMs: null, balance: null, available: null, positionMargin: null,
  orderMargin: null, portfolioMargin: null, used: null, utilizedPct: null,
} as const

const FAILED = account({
  id: 'delta', rail: 'live', label: 'Live', state: 'failed', ...NULLS,
  error: 'Delta /v2/wallet/balances: 401 invalid api key',
})
const ABSENT = account({
  id: 'delta', rail: 'live', label: 'Live', state: 'absent', ...NULLS,
  reason: 'no live Delta key configured',
})
const STALE = account({ state: 'stale', ageMs: 180_000, reason: 'last read 3m ago' })

function serveAccounts(accounts: AccountMargin[], extra?: (path: string) => unknown): SentRequest[] {
  return installFetch(({ path }) => {
    if (path === '/v1/desk/margin') return { body: { inrPerUsd: 85, staleAfterMs: 120_000, accounts } }
    const other = extra?.(path)
    return other === undefined ? { body: {} } : { body: other }
  })
}

// ------------------------------------------------------------ formatting

describe('USD with ₹ beside it', () => {
  test('at the response rate, and a dash for null — never $0.00', () => {
    expect(usdWithInr(1000, 85)).toBe('$1,000.00 (₹85,000)')
    expect(usdWithInr(12.4, 85)).toBe('$12.40 (₹1,054)')
    expect(usdWithInr(null, 85)).toBe('—')
  })

  test('a missing or bad rate falls back to the venue rate (85)', () => {
    expect(usdWithInr(10, Number.NaN)).toBe('$10.00 (₹850)')
  })
})

// ------------------------------------------------------- Positions panel

describe('the Margin panel', () => {
  test('ok demo: balance, available, used and % utilized, each USD with ₹', async () => {
    serveAccounts([account(), ABSENT])
    render(<AccountMarginPanel />)
    const demo = await screen.findByRole('group', { name: 'Demo margin' })
    expect(within(demo).getByText('$1,000.00 (₹85,000)')).toBeTruthy()
    expect(within(demo).getByText('$600.00 (₹51,000)')).toBeTruthy()
    expect(within(demo).getByText('$400.00 (₹34,000)')).toBeTruthy()
    expect(within(demo).getByText('40.0%')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Margin' })).toBeTruthy()
  })

  test('failed live shows the error and no figures — no zero', async () => {
    serveAccounts([account(), FAILED])
    render(<AccountMarginPanel />)
    const live = await screen.findByRole('group', { name: 'Live margin' })
    expect(within(live).getByText(/401 invalid api key/)).toBeTruthy()
    expect(within(live).queryByText(/\$0\.00/)).toBe(null)
    expect(within(live).queryByText(/0\.0%/)).toBe(null)
    expect(within(live).getByText('failed')).toBeTruthy()
  })

  test('absent live shows the reason', async () => {
    serveAccounts([account(), ABSENT])
    render(<AccountMarginPanel />)
    const live = await screen.findByRole('group', { name: 'Live margin' })
    expect(within(live).getByText(/no live Delta key configured/)).toBeTruthy()
    expect(within(live).queryByText(/\$/)).toBe(null)
  })

  test('stale keeps the figures and says how old they are', async () => {
    serveAccounts([STALE, ABSENT])
    render(<AccountMarginPanel />)
    const demo = await screen.findByRole('group', { name: 'Demo margin' })
    expect(within(demo).getByText('$1,000.00 (₹85,000)')).toBeTruthy()
    expect(within(demo).getByText('stale')).toBeTruthy()
    expect(within(demo).getByText(/3m ago/)).toBeTruthy()
  })

  test('an older reply with no accounts list does not crash or invent figures', async () => {
    installFetch(() => ({ body: { available: true, brokerTotal: 900_000 } }))
    render(<AccountMarginPanel />)
    await screen.findByText(/no accounts in the reply/i)
    expect(screen.queryByText(/\$/)).toBe(null)
  })
})

// --------------------------------------------------------- Status card

describe('the Status Margin card', () => {
  test('tone: attention on failed or ≥ 80%, stale on stale, ok otherwise', () => {
    expect(marginTone([account(), ABSENT])).toBe('ok')
    expect(marginTone([account(), FAILED])).toBe('attention')
    expect(marginTone([account({ utilizedPct: 80 }), ABSENT])).toBe('attention')
    expect(marginTone([STALE, ABSENT])).toBe('stale')
    expect(marginTone([ABSENT, ABSENT])).toBe('unknown')
    expect(marginTone([])).toBe('unknown')
  })

  test('compact figures per account, badge attention on a failed read', async () => {
    serveAccounts([account(), FAILED])
    render(<MarginStatusCard />)
    const card = await screen.findByRole('group', { name: 'Margin status' })
    await waitFor(() => expect(within(card).getByText('attention')).toBeTruthy())
    expect(within(card).getByText(/Demo/)).toBeTruthy()
    expect(within(card).getByText(/40\.0% used/)).toBeTruthy()
    expect(within(card).getByText(/401 invalid api key/)).toBeTruthy()
  })

  test('the Status page carries the card', async () => {
    const { StatusPage } = await import('../src/status.tsx')
    serveAccounts([account(), ABSENT])
    render(<ModeProvider><StatusPage /></ModeProvider>)
    const card = await screen.findByRole('group', { name: 'Margin status' })
    await waitFor(() => expect(within(card).getByText('ok')).toBeTruthy())
  })
})

// ------------------------------------------------------------ Books rows

const TAG = 'BTC-2026-11-04-bull-s-daily'

function bookRow(dials: BookRow['dials'], over: Partial<BookRow> = {}): BookRow {
  return {
    tag: TAG, symbol: 'BTC', expiry: '2026-11-04', mode: 'paper', variant: 'bull-s-btc-daily',
    dials, desired: 'running', actual: 'running', lastMarkAt: 0, lastDecision: '',
    createdAt: 0, updatedAt: 0, ...over,
  }
}

const estimate = (over: Partial<BookMarginEstimate> = {}): BookMarginEstimate => ({
  tag: TAG, mode: 'paper', budget: 150,
  current: { usd: 12.4, shortLegs: 2, missing: [] },
  worstAtCap: { usd: 96.2, atmStrike: 77000, sizes: [1, 2, 3], unbounded: false, missing: [] },
  ...over,
})

function mountBooks(rows: BookRow[], books: BookMarginEstimate[]): SentRequest[] {
  window.localStorage.setItem('desk.mode', 'paper')
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/desk/books/registry' && method === 'GET') return { body: { books: rows } }
    if (path === '/v1/desk/books' && method === 'GET') return { body: { books: [] } }
    if (path === '/v1/desk/margin/books') return { body: { asOf: 0, index: 77_100, books } }
    if (path === '/v1/desk/pnl' && method === 'GET') {
      return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
    }
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

describe('a BULL-S book row', () => {
  test('current estimate, worst case at cap and the budget, USD', async () => {
    mountBooks([bookRow({ bs_enabled: true })], [estimate()])
    const line = await screen.findByLabelText('margin estimate')
    expect(line.textContent).toContain('est $12.40')
    expect(line.textContent).toContain('cap $96.20')
    expect(line.textContent).toContain('budget $150.00')
    // ₹ is in the title of each figure.
    expect(within(line).getByText('est $12.40').closest('[title]')?.getAttribute('title')).toContain('₹1,054')
  })

  test('not estimable: a dash, with what is missing in the title — never $0', async () => {
    mountBooks([bookRow({ bs_enabled: true })], [estimate({
      budget: 0,
      current: { usd: null, shortLegs: 2, missing: ['C-BTC-77000-061126: no leverage'] },
    })])
    const line = await screen.findByLabelText('margin estimate')
    const dash = within(line).getByText('est —')
    expect(dash.closest('[title]')?.getAttribute('title')).toContain('C-BTC-77000-061126: no leverage')
    expect(line.textContent).not.toContain('$0')
    // Budget 0 = off: not shown.
    expect(line.textContent).not.toContain('budget')
  })

  test('bs_max_open 0 reads unbounded', async () => {
    mountBooks([bookRow({ bs_enabled: true })], [estimate({
      worstAtCap: { usd: null, atmStrike: 77000, sizes: [], unbounded: true, missing: [] },
    })])
    const line = await screen.findByLabelText('margin estimate')
    expect(line.textContent).toContain('unbounded (bs_max_open 0)')
  })

  test('a book that is not BULL-S has no estimate, and none is asked for', async () => {
    const sent = mountBooks([bookRow({ bs_enabled: false })], [estimate()])
    await screen.findByText(TAG)
    expect(screen.queryByLabelText('margin estimate')).toBe(null)
    expect(sent.some((r) => r.path === '/v1/desk/margin/books')).toBe(false)
  })
})

// ------------------------------------------------------------ Dials panel

describe('bs_margin_budget', () => {
  test('meta: venue money, 0 = off, the refusal rule in its help', () => {
    const m = dialMeta('bs_margin_budget')
    expect(m.kind).toBe('rupee')
    expect(m.zeroOff).toBe(true)
    expect(m.help).toBe(
      'Margin budget in USD for the book: a new straddle whose estimated margin would take the book over it is refused. Stops and closes are never blocked. 0 = off.',
    )
    expect(readDial('bs_margin_budget', 0)).toBe('off')
  })

  function Harness(props: { row: BookRow }): React.ReactElement {
    const reauth = useReauth()
    return <DialsPanel row={props.row} reauth={reauth} onClose={() => {}} onSaved={() => {}} />
  }

  test('the panel shows the open book’s estimate, matched by tag and mode', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/margin/books') {
        return {
          body: {
            asOf: 0, index: 77_100,
            books: [
              estimate({ mode: 'live', current: { usd: 999, shortLegs: 2, missing: [] } }),
              estimate(),
            ],
          },
        }
      }
      return { body: {} }
    })
    render(<AuthProvider><Harness row={bookRow({ bs_enabled: true })} /></AuthProvider>)
    const line = await screen.findByLabelText('dials margin estimate')
    expect(line.textContent).toContain('$12.40 (₹1,054)')
    expect(line.textContent).toContain('$96.20 (₹8,177)')
    expect(line.textContent).not.toContain('999')
  })
})
