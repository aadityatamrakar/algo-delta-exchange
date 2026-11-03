/**
 * "Unknown" and "zero" are different numbers.
 *
 * This is the one rule the whole dashboard is built on: a P&L of ₹0 and a P&L
 * of "three legs could not be marked" mean opposite things to whoever is
 * deciding whether to close a book, and a screen that renders them identically
 * is worse than one that renders nothing. Every assertion here is of the form
 * "this shows an em dash, and specifically NOT a 0".
 */
import { expect, test, describe } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { money, signed } from '../src/api.ts'
import { Money } from '../src/pnl.tsx'
import { Stat } from '../src/pages.tsx'
import { BookTabsPage } from '../src/pages.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch } from './http.tsx'

interface BookShape { symbol: string; tag: string; legs: number; netDelta: number | null; complete: boolean }

function mountBooks(book: BookShape): void {
  installFetch(({ path }) => {
    if (path === '/v1/desk/books') {
      return { body: { books: [{ ...book, updatedAt: Date.now() }] } }
    }
    if (path === '/v1/desk/pnl') {
      return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
    }
    if (path === '/v1/desk/positions') {
      // Legs that exist and could NOT be priced: the greeks then sum over
      // nothing, which is the case the page has to refuse to call zero.
      const legs = book.complete ? [] : [{
        deskTag: 'L1',
        instrument: { tradingsymbol: 'BHEL26JUL240CE', lotSize: 5250 },
        underlying: book.symbol, expiry: '2026-07-31', strike: 240, type: 'CE',
        side: 'Sell', qty: -5250, entryPrice: 4.15, openedTs: 1,
      }]
      return {
        body: {
          tag: book.tag, symbol: book.symbol, mode: 'paper', legs, spot: null, asOf: Date.now(),
          complete: book.complete,
          greeks: {
            legs: [], netDelta: 0, netGamma: 0, netVega: 0, netTheta: 0,
            unpriced: legs.map((l) => l.instrument.tradingsymbol),
          },
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
        <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
      </ModeProvider>
    </AuthProvider>,
  )
}

describe('nulls', () => {
  test('the money formatter never invents a zero', () => {
    expect(money(null)).toBe('—')
    expect(money(undefined)).toBe('—')
    expect(money(0)).toBe('0')
    expect(signed(-1200)).toBe('-1,200')
  })

  test('a null figure renders as an em dash and is not tinted', () => {
    const { container } = render(<Money value={null} />)
    expect(container.textContent).toBe('—')
    // No colour: green would assert a profit we do not have and red a loss.
    expect(container.querySelector('[style*="color"]')).toBe(null)
  })

  test('a stat with no data shows an em dash, not 0', () => {
    render(<Stat label="Net delta" value="—" />)
    expect(screen.getByText('—')).toBeTruthy()
  })

  test('a book with an unknown delta shows an em dash on its tab', async () => {
    mountBooks({ symbol: 'BHEL', tag: 'BHEL-VAR1', legs: 4, netDelta: null, complete: false })
    const tab = await theTab()
    expect(within(tab).getByText('—')).toBeTruthy()
    expect(within(tab).queryByText('0')).toBe(null)
  })

  test('a fully unmarked book is never presented as flat', async () => {
    /*
     * THE DANGEROUS ONE. With every leg unpriced the greeks sum over nothing
     * and total to a perfectly honest-looking 0 — on a tab, indistinguishable
     * from a book that is genuinely flat, while it carries real unpriced risk.
     * `complete` is the field that separates them, so it is rendered whatever
     * the delta says.
     */
    mountBooks({ symbol: 'BHEL', tag: 'BHEL-VAR1', legs: 4, netDelta: 0, complete: false })
    const tab = await theTab()
    expect(within(tab).getByText('partial')).toBeTruthy()
  })

  test('greeks summed over nothing are not reported as zero', async () => {
    mountBooks({ symbol: 'BHEL', tag: 'BHEL-VAR1', legs: 4, netDelta: 0, complete: false })
    await theTab()
    // The book holds a leg and not one of them could be priced, so "Net delta
    // 0" is arithmetic over an empty set — the most reassuring thing this page
    // could say about the most dangerous state it can be in.
    // TWO LEVELS UP, not one: the label now shares an `HStack` with its
    // optional qualifier (the margin cell's age), and the CELL is the stack
    // above that. One level lands on the label row, which holds no figure at
    // all — so the old lookup would pass for the wrong reason.
    const label = await screen.findByText('Net delta')
    const cell = label.parentElement?.parentElement as HTMLElement
    expect(within(cell).getByText('—')).toBeTruthy()
    expect(within(cell).queryByText('0')).toBe(null)
  })

  test('a genuinely flat book carries no qualifier', async () => {
    mountBooks({ symbol: 'BHEL', tag: 'BHEL-VAR1', legs: 2, netDelta: 0, complete: true })
    const tab = await theTab()
    expect(within(tab).queryByText('partial')).toBe(null)
    // `Δ 0`, not a bare `0`: the tab labels the figure, so a flat book reads as
    // "delta zero" rather than as an unexplained number beside the book name.
    expect(within(tab).getByText('Δ 0')).toBeTruthy()
  })
})

/**
 * The one book tab, once it has arrived.
 *
 * Scoped rather than searched for by text: the book's name and its figures also
 * appear on the position card below, and an assertion that matched there would
 * pass while the tab itself said something else.
 */
async function theTab(): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector('.astryx-tab')
    if (el === null) throw new Error('the book tabs have not rendered')
    return el as HTMLElement
  })
}
