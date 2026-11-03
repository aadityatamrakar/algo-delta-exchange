/**
 * The Phase 0 break, reproduced and pinned: `?symbol=` on `/v1/desk/positions`
 * stopped meaning "one book" and started meaning "every book on this symbol",
 * because a symbol can now carry several variants (tags) open at once.
 * `PositionsPage` used to destructure that array as a single `PositionsResponse`
 * (`.legs`, `.greeks`), which rendered a risk display of an EMPTY book while the
 * real book was open — silently, with no error. `/v1/desk/diff` went further:
 * it became tag-only and refused `?symbol=` outright.
 *
 * Every test here asserts the CLIENT'S OWN OUTBOUND REQUEST uses `?tag=`, and
 * that legs from a tag-scoped single-book response actually reach the screen —
 * not merely that the page fails to crash.
 */
import { expect, test, describe } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BookTabsPage, ControlsPage } from '../src/pages.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type SentRequest } from './http.tsx'
import { formatContract } from '../src/contract.ts'
import { PHONE } from '../src/shell.tsx'

const SYMBOL = 'BHEL'
const TAG_A = 'BHEL-2026-08-25-hold-recycle-r'
const TAG_B = 'BHEL-2026-08-25-scalp-v2'
const LEG_SYMBOL = 'BHEL26AUG420CE'

/** One book's per-leg shape, as `?tag=` answers it — a SINGLE object. */
function bookBody(tag: string): unknown {
  return {
    tag,
    symbol: SYMBOL,
    mode: 'paper',
    legs: [{
      deskTag: 'L1',
      instrument: { tradingsymbol: LEG_SYMBOL, lotSize: 5250 },
      underlying: SYMBOL, expiry: '2026-08-27', strike: 420, type: 'CE',
      side: 'Sell', qty: -5250, entryPrice: 12, openedTs: 1,
    }],
    spot: 240,
    asOf: Date.now(),
    complete: true,
    greeks: {
      legs: [{
        tradingsymbol: LEG_SYMBOL, qty: -5250, iv: 0.2, price: 12, delta: -0.4,
        gamma: 0.001, vega: 10, theta: -5,
        positionDelta: -2100, positionGamma: -5.25, positionVega: -52500, positionTheta: 26250,
      }],
      netDelta: -2100, netGamma: -5.25, netVega: -52500, netTheta: 26250,
      unpriced: [],
    },
  }
}

describe('positions re-keyed by tag (Phase 0)', () => {
  test('the tab list labels a book "<symbol> · <tag>", keyed on the tag', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/books') {
        return { body: { books: [{ symbol: SYMBOL, tag: TAG_A, legs: 1, netDelta: -2100, complete: true, updatedAt: 1 }] } }
      }
      if (path === '/v1/desk/positions') return { body: bookBody(TAG_A) }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/pnl') {
        return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )
    // The astryx Tab renders its label twice (one copy aria-hidden, for the
    // "hug" layout's width measurement), so this asserts presence rather than
    // a single match.
    await waitFor(() => expect(screen.getAllByText(`${SYMBOL} · ${TAG_A}`).length).toBeGreaterThan(0))
  })

  test('the positions request carries ?tag=, and the SINGLE book it answers with renders its legs', async () => {
    let sent: SentRequest[] = []
    sent = installFetch(({ path }) => {
      if (path === '/v1/desk/books') {
        return { body: { books: [{ symbol: SYMBOL, tag: TAG_A, legs: 1, netDelta: -2100, complete: true, updatedAt: 1 }] } }
      }
      if (path === '/v1/desk/positions') return { body: bookBody(TAG_A) }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/pnl') {
        return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )

    // THE PROOF THE BUG IS FIXED: the leg from the single-book response is on
    // screen. The old code fed a `{books:[...]}` array through this exact path
    // as though it were one book and rendered zero rows — no crash, no error,
    // just an empty book beside a real, open one.
    await waitFor(() => expect(screen.getByText(formatContract(LEG_SYMBOL))).toBeTruthy())
    // Net delta appears on both the tab and the Stat card once the book has
    // loaded, so at least one — not exactly one — is the honest assertion.
    await waitFor(() => expect(screen.getAllByText('-2,100').length).toBeGreaterThan(0))

    const positionsReq = sent.find((r) => r.path === '/v1/desk/positions')
    expect(positionsReq?.url).toContain(`tag=${encodeURIComponent(TAG_A)}`)
    expect(positionsReq?.url).not.toContain('symbol=')

    await waitFor(() => {
      const diffReq = sent.find((r) => r.path === '/v1/desk/diff')
      expect(diffReq?.url).toContain(`tag=${encodeURIComponent(TAG_A)}`)
      expect(diffReq?.url).not.toContain('symbol=')
    })
  })

  test('two books on one symbol render as two distinct tabs, not a duplicate-key collision', async () => {
    installFetch(({ path, url }) => {
      if (path === '/v1/desk/books') {
        return {
          body: {
            books: [
              { symbol: SYMBOL, tag: TAG_A, legs: 1, netDelta: -2100, complete: true, updatedAt: 1 },
              { symbol: SYMBOL, tag: TAG_B, legs: 2, netDelta: 500, complete: true, updatedAt: 1 },
            ],
          },
        }
      }
      if (path === '/v1/desk/positions') {
        const tag = url.searchParams.get('tag') ?? TAG_A
        return { body: bookBody(tag) }
      }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/pnl') {
        return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getAllByText(`${SYMBOL} · ${TAG_A}`).length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.getAllByText(`${SYMBOL} · ${TAG_B}`).length).toBeGreaterThan(0))
  })
})

describe('close-all is tag-aware (server-side review carry-in)', () => {
  test('close-all sends the tag alongside the symbol, keyed off the picker\'s own choice', async () => {
    const sent = installFetch(({ path, method }) => {
      if (path === '/v1/desk/killswitch') return { body: { enabled: false, reason: '', setBy: '', setAt: 0 } }
      if (path === '/v1/desk/books') {
        return {
          body: {
            books: [
              { symbol: SYMBOL, tag: TAG_A, legs: 1, netDelta: -2100, complete: true, updatedAt: 1 },
              { symbol: SYMBOL, tag: TAG_B, legs: 2, netDelta: 500, complete: true, updatedAt: 1 },
            ],
          },
        }
      }
      if (path === '/v1/desk/close-all' && method === 'POST') {
        return {
          body: {
            decisionId: 'd', replayed: false, status: 'DONE',
            fills: [], skips: [], routeErrors: [], book: [], unpriceable: [],
          },
        }
      }
      return { body: {} }
    })
    window.localStorage.setItem('desk.mode', 'paper')
    render(
      <AuthProvider>
        <ModeProvider>
          <ControlsPage mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
    // Picker labels each book by symbol AND tag now that a symbol can name more
    // than one book.
    const secondBook = await screen.findByRole('button', { name: `${SYMBOL} · ${TAG_B} (2)` })
    secondBook.click()
    const closeBtn = await screen.findByRole('button', { name: 'Close all — fast (aggressive limit), paper' })
    closeBtn.click()

    await waitFor(() => {
      const req = sent.find((r) => r.path === '/v1/desk/close-all')
      expect(req?.body?.['symbol']).toBe(SYMBOL)
      expect(req?.body?.['tag']).toBe(TAG_B)
    })
  })

  test('a 409 ambiguous refusal renders the candidate tags, and picking one closes that book', async () => {
    let attempt = 0
    const sent = installFetch(({ path, method }) => {
      if (path === '/v1/desk/killswitch') return { body: { enabled: false, reason: '', setBy: '', setAt: 0 } }
      if (path === '/v1/desk/books') {
        return { body: { books: [{ symbol: SYMBOL, tag: TAG_A, legs: 1, netDelta: -2100, complete: true, updatedAt: 1 }] } }
      }
      if (path === '/v1/desk/close-all' && method === 'POST') {
        attempt += 1
        if (attempt === 1) {
          // THE SERVER'S 409: this symbol resolves to more than one book, and it
          // refuses rather than guessing. Nothing was closed.
          return {
            status: 409,
            body: {
              error: `symbol ${SYMBOL} matches 2 books (${TAG_A}, ${TAG_B}) — NOTHING WAS CLOSED`,
              symbol: SYMBOL, mode: 'paper', candidates: [TAG_A, TAG_B],
            },
          }
        }
        return {
          body: {
            decisionId: 'd2', replayed: false, status: 'DONE',
            fills: [], skips: [], routeErrors: [], book: [], unpriceable: [],
          },
        }
      }
      return { body: {} }
    })
    window.localStorage.setItem('desk.mode', 'paper')
    render(
      <AuthProvider>
        <ModeProvider>
          <ControlsPage mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
    const closeBtn = await screen.findByRole('button', { name: 'Close all — fast (aggressive limit), paper' })
    closeBtn.click()

    // THE REFUSAL IS ACTIONABLE, not a dead-end error string: both candidate
    // tags from the 409 body appear as something the operator can click.
    const candidateBtn = await screen.findByRole('button', { name: TAG_B })
    await screen.findByRole('button', { name: TAG_A })

    candidateBtn.click()

    await waitFor(() => expect(screen.getByText(`Close-all ${SYMBOL} (fast): flat`)).toBeTruthy())
    const closeAllReqs = sent.filter((r) => r.path === '/v1/desk/close-all')
    expect(closeAllReqs).toHaveLength(2)
    expect(closeAllReqs[1]?.body?.['tag']).toBe(TAG_B)
  })
})

describe('the tab strip is a list of positions, not of stored books', () => {
  /*
   * A delta-lean book lives one trading day: created in the morning, flattened
   * at the close, stopped the next day, erased the session after. In between
   * it is still a `desk-books` document — with ZERO legs — and the listing
   * returns every document. The operator opened Positions on 2026-10-13 to
   * eleven tabs, six of them yesterday's flat books and today's not-yet-opened
   * ones, and had to hunt the three that held anything.
   */
  const FLAT = 'NIFTY-delta-lean-aggressive-2026-10-12'

  function books(list: readonly { tag: string; symbol: string; legs: number }[]): unknown {
    return { books: list.map((b) => ({ ...b, netDelta: 0, complete: true, updatedAt: 1 })) }
  }

  function answer(bookList: unknown): SentRequest[] {
    return installFetch(({ path, url }) => {
      if (path === '/v1/desk/books') return { body: bookList }
      if (path === '/v1/desk/positions') return { body: bookBody(url.searchParams.get('tag') ?? TAG_A) }
      if (path === '/v1/desk/diff') {
        return { body: { matched: [], mismatched: [], deskOnly: [], bridgeOnly: [], inSync: true, declaredAt: null } }
      }
      if (path === '/v1/desk/pnl') {
        return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
      }
      return { body: {} }
    })
  }

  test('a stored book with no legs gets no tab', async () => {
    answer(books([
      { symbol: SYMBOL, tag: TAG_A, legs: 1 },
      { symbol: 'NIFTY', tag: FLAT, legs: 0 },
    ]))
    render(
      <AuthProvider>
        <ModeProvider>
          <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getAllByText(`${SYMBOL} · ${TAG_A}`).length).toBeGreaterThan(0))
    expect(screen.queryByText(`NIFTY · ${FLAT}`)).toBe(null)
  })

  test('on a phone, where a tab is the symbol alone, a flat book has no tab either', async () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query === PHONE,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      answer(books([
        { symbol: SYMBOL, tag: TAG_A, legs: 1 },
        { symbol: 'NIFTY', tag: FLAT, legs: 0 },
      ]))
      render(
        <AuthProvider>
          <ModeProvider>
            <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
          </ModeProvider>
        </AuthProvider>,
      )
      await waitFor(() => expect(screen.getAllByText(SYMBOL).length).toBeGreaterThan(0))
      expect(screen.queryByText('NIFTY')).toBe(null)
    } finally {
      window.matchMedia = real
    }
  })

  test('a route naming a flat book lands on the first book that holds something', async () => {
    const sent = answer(books([
      { symbol: SYMBOL, tag: TAG_A, legs: 1 },
      { symbol: 'NIFTY', tag: FLAT, legs: 0 },
    ]))
    render(
      <AuthProvider>
        <ModeProvider>
          <BookTabsPage mode="paper" tag={FLAT} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText(formatContract(LEG_SYMBOL))).toBeTruthy())
    const positionsReqs = sent.filter((r) => r.path === '/v1/desk/positions')
    expect(positionsReqs.length).toBeGreaterThan(0)
    for (const r of positionsReqs) expect(r.url).toContain(`tag=${encodeURIComponent(TAG_A)}`)
  })

  test('declared books that are all flat say so, not "nothing declared"', async () => {
    answer(books([{ symbol: 'NIFTY', tag: FLAT, legs: 0 }]))
    render(
      <AuthProvider>
        <ModeProvider>
          <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )
    await screen.findByText('No open paper positions')
    expect(screen.queryByText('No paper books')).toBe(null)
    expect(screen.queryByText(`NIFTY · ${FLAT}`)).toBe(null)
    expect(screen.getByText(/The one declared book hold/).textContent).toContain(FLAT)
  })

  test('several flat books are named, so yesterday\'s can be told from the one expected open by now', async () => {
    const FLAT_B = 'SENSEX-delta-lean-aggressive-2026-10-12'
    answer(books([{ symbol: 'NIFTY', tag: FLAT, legs: 0 }, { symbol: 'SENSEX', tag: FLAT_B, legs: 0 }]))
    render(
      <AuthProvider>
        <ModeProvider>
          <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )
    await screen.findByText('No open paper positions')
    const text = screen.getByText(/All 2 declared books hold/).textContent ?? ''
    expect(text).toContain(`${FLAT}, ${FLAT_B}`)
  })
})
