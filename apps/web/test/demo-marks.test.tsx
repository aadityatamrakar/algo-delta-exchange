/**
 * PAPER BOOKS ON DELTA'S DEMO RAIL ARE MARKED WITH TESTNET PRICES — and the
 * dashboard has to say which exchange priced a book, and say it LOUDLY when a
 * leg fell back to production prices because no demo quote has arrived yet.
 *
 * The wire fields are optional (an older bridge sends none of them), so every
 * surface is tested three ways where it matters: absent → nothing rendered,
 * present and clean → a quiet label, present with a fallback → a warning that
 * names the legs. A fallback that rendered as nothing would put a production
 * price under a demo book's P&L with no word said, which is the one outcome
 * this file exists to prevent.
 */
import { expect, test, describe } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import {
  demoFeedOf, fallbackWarning, marksSourceLabel,
} from '../src/marks-source.tsx'
import { mergeRow } from '../src/stream.tsx'
import { PositionsPage } from '../src/pages.tsx'
import { PnlCards } from '../src/pnl.tsx'
import { BooksPage } from '../src/books.tsx'
import { StatusPage } from '../src/status.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch } from './http.tsx'
import type { BookRow, PnlStrategy } from '../src/api.ts'

const TAG = 'BTC-demo-condor'
const SYM_A = 'C-BTC-90000-281126'
const SYM_B = 'P-BTC-80000-281126'

describe('the pure helpers', () => {
  test('the label names the exchange, and nothing when the bridge did not say', () => {
    expect(marksSourceLabel('delta-demo')).toBe('marks: Delta demo')
    expect(marksSourceLabel('delta')).toBe('marks: Delta')
    expect(marksSourceLabel(undefined)).toBe(null)
  })

  test('the fallback warning counts and names the legs; empty or absent is silent', () => {
    expect(fallbackWarning([SYM_A, SYM_B])).toBe(
      `incomplete — 2 legs on Delta prices (no demo quote yet): ${SYM_A}, ${SYM_B}`,
    )
    expect(fallbackWarning([SYM_A])).toBe(
      `incomplete — 1 leg on Delta prices (no demo quote yet): ${SYM_A}`,
    )
    expect(fallbackWarning([])).toBe(null)
    expect(fallbackWarning(undefined)).toBe(null)
  })

  test('demoFeedOf reads a well-formed block and refuses a malformed one', () => {
    const demo = {
      url: 'wss://socket-ind.testnet.deltaex.org', connected: true, downForMs: null,
      tokens: 40, staleTokens: 0, oldestAgeMs: 900,
    }
    expect(demoFeedOf({ tokens: 900, demo })).toEqual(demo)
    expect(demoFeedOf({ tokens: 900 })).toBe(null)
    expect(demoFeedOf(undefined)).toBe(null)
    expect(demoFeedOf({ demo: { connected: 'yes' } })).toBe(null)
  })

  test('a streamed row delta carries the fallback list, and an absent one leaves it', () => {
    const base: PnlStrategy = {
      tag: TAG, label: 'demo', mode: 'paper', realised: 0, unrealised: 10, total: 10,
      openLegs: 2, legs: [], unpriced: [], complete: true,
      marksSource: 'delta-demo', marksFallback: [SYM_A],
    }
    expect(mergeRow(base, { tag: TAG, marksFallback: [] }).marksFallback).toEqual([])
    expect(mergeRow(base, { tag: TAG, total: 12 }).marksFallback).toEqual([SYM_A])
    expect(mergeRow(base, { tag: TAG, marksSource: 'delta' }).marksSource).toBe('delta')
  })
})

// ----------------------------------------------------------------- book page

function leg(tradingsymbol: string, qty: number): Record<string, unknown> {
  return {
    deskTag: `L-${tradingsymbol}`,
    instrument: { tradingsymbol, instrumentToken: 1, lotSize: 1 },
    underlying: 'BTC', expiry: '2026-11-28', strike: 90000, type: 'CE',
    side: qty < 0 ? 'Sell' : 'Buy', qty, entryPrice: 120, openedTs: 1,
  }
}

function mountBook(over: Record<string, unknown>): void {
  installFetch(({ path }) => {
    if (path === '/v1/desk/positions') {
      return {
        body: {
          tag: TAG, symbol: 'BTC', mode: 'paper', spot: 85000, asOf: Date.now(), complete: true,
          legs: [leg(SYM_A, -1), leg(SYM_B, -1)],
          greeks: { legs: [], netDelta: 0, netGamma: 0, netVega: 0, netTheta: 0, unpriced: [] },
          ...over,
        },
      }
    }
    if (path === '/v1/desk/diff') {
      return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
    }
    return { body: {} }
  })
  render(
    <AuthProvider>
      <ModeProvider>
        <PositionsPage mode="paper" tag={TAG} />
      </ModeProvider>
    </AuthProvider>,
  )
}

describe('the book page names its price source', () => {
  test('a demo-marked book says so, quietly, when every leg has a demo quote', async () => {
    mountBook({ marksSource: 'delta-demo', marksFallback: [] })
    await screen.findByText('marks: Delta demo')
    expect(screen.queryByText(/incomplete/)).toBe(null)
  })

  test('a production-marked book says "marks: Delta"', async () => {
    mountBook({ marksSource: 'delta' })
    await screen.findByText('marks: Delta')
  })

  test('a FALLBACK is never silent — it is counted and the legs are named', async () => {
    mountBook({ marksSource: 'delta-demo', marksFallback: [SYM_B] })
    await screen.findByText('marks: Delta demo')
    expect(
      screen.getByText(`incomplete — 1 leg on Delta prices (no demo quote yet): ${SYM_B}`),
    ).toBeTruthy()
  })

  test('an older bridge that sends neither field renders no label at all', async () => {
    mountBook({})
    await screen.findByText(`BTC · ${TAG}`)
    expect(screen.queryByText(/^marks: /)).toBe(null)
  })
})

// --------------------------------------------------------- p&l rows per book

function pnlRow(over: Partial<PnlStrategy> = {}): PnlStrategy {
  return {
    tag: TAG, label: 'demo', mode: 'paper', realised: 0, unrealised: 50, total: 50,
    openLegs: 2, legs: [], unpriced: [], complete: true, ...over,
  }
}

describe('the P&L pills', () => {
  test('a row with a fallback wears an incomplete badge that names the legs on hover', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/pnl') {
        return {
          body: {
            mode: 'paper',
            strategies: [
              pnlRow({ marksSource: 'delta-demo', marksFallback: [SYM_A, SYM_B] }),
              pnlRow({ tag: 'CLEAN', marksSource: 'delta-demo', marksFallback: [] }),
            ],
            totals: { realised: 0, unrealised: 100, total: 100, complete: true },
          },
        }
      }
      return { body: {} }
    })
    render(<ModeProvider><PnlCards mode="paper" /></ModeProvider>)
    await screen.findByText('CLEAN')
    const badges = screen.getAllByText('incomplete')
    expect(badges).toHaveLength(1)
    const titled = badges[0]?.closest('[title]')
    expect(titled?.getAttribute('title')).toBe(
      `incomplete — 2 legs on Delta prices (no demo quote yet): ${SYM_A}, ${SYM_B}`,
    )
  })
})

describe('the Books table', () => {
  test('the P&L cell carries the incomplete badge when the row fell back', async () => {
    const row: BookRow = {
      tag: TAG, symbol: 'BTC', expiry: '2026-11-28', mode: 'paper', variant: 'condor',
      dials: {}, desired: 'stopped', actual: 'stopped', lastMarkAt: 0, lastDecision: '',
      createdAt: 0, updatedAt: 0,
    }
    window.localStorage.setItem('desk.mode', 'paper')
    installFetch(({ path, method }) => {
      if (path === '/v1/desk/books/registry' && method === 'GET') return { body: { books: [row] } }
      if (path === '/v1/desk/books' && method === 'GET') return { body: { books: [] } }
      if (path === '/v1/desk/pnl' && method === 'GET') {
        return {
          body: {
            mode: 'paper',
            strategies: [pnlRow({ marksSource: 'delta-demo', marksFallback: [SYM_A] })],
            totals: { realised: 0, unrealised: 50, total: 50, complete: true },
          },
        }
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
    await screen.findByText(TAG)
    await waitFor(() => expect(screen.getAllByText('incomplete').length).toBeGreaterThan(0))
    const titled = screen.getAllByText('incomplete')[0]?.closest('[title]')
    expect(titled?.getAttribute('title')).toContain(SYM_A)
  })
})

// --------------------------------------------------------------- status page

const NOW = 1_760_000_000_000

function mountStatus(demo: Record<string, unknown> | undefined): void {
  installFetch(({ path }) => {
    if (path === '/v1/desk/system') {
      return {
        body: {
          generatedAt: NOW,
          components: [{
            id: 'dx-marketdata', name: 'Market data', state: 'ok',
            detail: 'Delta public feed · 1 of 1 sockets connected · 900 tokens',
            lastSeenMs: NOW - 3_000, ageMs: 3_000, expectedEveryMs: 10_000,
            extra: { socketsConnected: 1, socketsTotal: 1, tokens: 900, ...(demo === undefined ? {} : { demo }) },
          }],
        },
      }
    }
    if (path === '/v1/desk/feed') {
      return {
        body: {
          feedAlive: true, marksHeld: 61, subscribedTokens: 72, coverage: 0.85,
          msSinceLastTick: 1200, bookCount: 2, booksIncomplete: 0, ready: true,
        },
      }
    }
    if (path === '/v1/desk/brokers') return { body: { brokers: [] } }
    if (path === '/v1/desk/orders') return { body: { events: [] } }
    if (path.startsWith('/v1/desk/audit')) return { body: { entries: [] } }
    return { body: {} }
  })
  render(<ModeProvider><StatusPage /></ModeProvider>)
}

describe('the status page reports the testnet price socket', () => {
  test('connected: the state, the token count and the stale count', async () => {
    mountStatus({
      url: 'wss://socket-ind.testnet.deltaex.org', connected: true, downForMs: null,
      tokens: 40, staleTokens: 2, oldestAgeMs: 95_000,
    })
    await screen.findByText('Delta testnet prices')
    expect(screen.getByText('connected')).toBeTruthy()
    expect(screen.getByText('40 tokens · 2 stale (oldest 95s)')).toBeTruthy()
    expect(screen.queryByText(/testnet price socket is down/)).toBe(null)
  })

  test('down: a warning badge, how long, and a banner above the grid', async () => {
    mountStatus({
      url: 'wss://socket-ind.testnet.deltaex.org', connected: false, downForMs: 42_000,
      tokens: 40, staleTokens: 40, oldestAgeMs: 42_000,
    })
    await screen.findByText('Delta testnet prices')
    expect(screen.getByText('down for 42s')).toBeTruthy()
    expect(screen.getByText('Delta testnet price socket is down')).toBeTruthy()
  })

  test('down with no measured duration still says down', async () => {
    mountStatus({
      url: 'wss://x', connected: false, downForMs: null, tokens: 0, staleTokens: 0, oldestAgeMs: 0,
    })
    await screen.findByText('Delta testnet prices')
    expect(screen.getByText('down')).toBeTruthy()
  })

  test('an older bridge that sends no demo block shows no testnet line', async () => {
    mountStatus(undefined)
    await screen.findByText('Market data')
    expect(screen.queryByText('Delta testnet prices')).toBe(null)
  })
})
