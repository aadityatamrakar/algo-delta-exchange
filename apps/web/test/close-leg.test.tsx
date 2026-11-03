/**
 * Closing ONE STRIKE from the Net positions table.
 *
 * The operator's case: a short whose delta has decayed to ~0.10 does no work in
 * the structure any more, but it still costs margin and carries the tail. The
 * only exit before this was `close-all`, which is all-or-nothing.
 *
 * WHAT THESE PIN, in order of how much they would cost to get wrong:
 *
 *  1. THE CLICK ALONE PLACES NOTHING. Every route to an order goes through the
 *     confirmation, because the button sits on a row in a dense table and the
 *     row above it is a different strike.
 *  2. The confirmation names the ORDER — side, size, contract, rail — not just
 *     the contract, since "Close TCS 2660 CE" reads identically whether it buys
 *     back 1,125 or sells 5,000.
 *  3. A refusal is shown VERBATIM. The server's 409s name what to do next
 *     ("start the book first"), and paraphrasing loses exactly that part.
 *  4. The button is absent where it could only ever fail: the Total row, a flat
 *     contract, and a tag with no registered book.
 */
import { expect, test, describe } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import { StrategyPage } from '../src/strategies.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { installFetch, type SentRequest } from './http.tsx'

const TAG = 'TCS-2026-08-25-recenter-relief-r'
const DEAD = 'TCS26AUG2660CE'
const DEAD_SHOWN = 'TCS 2660 CE'
const LIVE_CE = 'TCS26AUG2460CE'

/** The dead strike, a working leg, and one already flat. */
const LEGS = [
  { tradingsymbol: DEAD, qty: 1125, avgCost: 7.7, mark: 1.1, unrealised: -7425,
    realised: 0, buyQty: 1125, buyValue: 8663, sellQty: 0, sellValue: 0, mtm: -7425 },
  { tradingsymbol: LIVE_CE, qty: -1125, avgCost: 59.15, mark: 10.75, unrealised: 54450,
    realised: 0, buyQty: 0, buyValue: 0, sellQty: 1125, sellValue: 66544, mtm: 54450 },
  { tradingsymbol: 'TCS26AUG2380CE', qty: 0, avgCost: 0, mark: 35.6, unrealised: 0,
    realised: 900, buyQty: 1125, buyValue: 33188, sellQty: 1125, sellValue: 34088, mtm: 900 },
]

const BOOK = {
  tag: TAG, mode: 'paper', symbol: 'TCS', expiry: '2026-08-25',
  variant: 'recenter-relief-r', dials: {}, seedLegs: [],
  desired: 'running', actual: 'running',
  createdAt: 1_754_000_000_000, updatedAt: 1_755_000_000_000,
  lastMarkAt: 0, lastDecision: '',
}

interface Options {
  /** null renders the page with NO registry row for this tag. */
  book?: unknown
  /** Non-null makes the close endpoint answer with this body (200 unless a
   *  `status` is given), instead of a clean single-fill success. */
  closeFails?: { status?: number; body: unknown }
}

function mount(opts: Options = {}): SentRequest[] {
  window.localStorage.setItem('desk.mode', 'paper')
  const book = 'book' in opts ? opts.book : BOOK
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/desk/strategies') {
      return { body: { strategies: [{ tag: TAG, kind: 'external', label: 'TCS relief',
        modes: { paper: { enabled: true } }, liveLots: 0, autostartAt: '',
        lastSeenAt: 0, disabledReason: '', updatedAt: 0 }] } }
    }
    if (path === '/v1/desk/pnl') {
      return {
        body: {
          mode: 'paper',
          strategies: [{
            tag: TAG, label: 'TCS relief', mode: 'paper',
            realised: 900, unrealised: 47025, total: 47925,
            openLegs: 2, legs: LEGS, unpriced: [], complete: true,
          }],
          totals: { realised: 900, unrealised: 47025, total: 47925, complete: true },
        },
      }
    }
    if (path === '/v1/desk/books/registry' && method !== 'POST') {
      return { body: { books: book === null ? [] : [book] } }
    }
    if (path.endsWith('/close-leg')) {
      return opts.closeFails !== undefined
        ? opts.closeFails
        : { body: { fills: [{}], skips: [], closed: ['open-1'], unpriceable: [] } }
    }
    if (path === '/v1/desk/reports/orders') return { body: { date: '2026-08-14', events: [] } }
    if (path === '/v1/desk/pnl/series') return { body: { points: [] } }
    return { body: {} }
  })
  render(
    <AuthProvider>
      <ModeProvider>
        <StrategyPage tag={TAG} mode="paper" />
      </ModeProvider>
    </AuthProvider>,
  )
  return sent
}

/** The close button on the row naming `shown`, or null when there is none. */
function closeButtonFor(shown: string): HTMLElement | null {
  const row = screen.getByText(shown).closest('tr') as HTMLElement
  return within(row).queryByRole('button', { name: /^Close / })
}

const closeCalls = (sent: readonly SentRequest[]): SentRequest[] =>
  sent.filter((r) => r.path.endsWith('/close-leg'))

// ------------------------------------------------------------ the guard rail

describe('closing one strike', () => {
  test('CLICKING THE BUTTON PLACES NOTHING — the confirmation is the gate', async () => {
    const sent = mount()
    await screen.findByText(DEAD_SHOWN)

    act(() => { (closeButtonFor(DEAD_SHOWN) as HTMLElement).click() })

    // The dialog is up and NOT ONE request has gone out. This is the assertion
    // the whole feature rests on: the button sits on a dense table row whose
    // neighbours are different strikes.
    await screen.findByRole('alertdialog')
    expect(closeCalls(sent)).toHaveLength(0)
  })

  test('the confirmation names the ORDER, not just the contract', async () => {
    mount()
    await screen.findByText(DEAD_SHOWN)
    act(() => { (closeButtonFor(DEAD_SHOWN) as HTMLElement).click() })

    const dialog = await screen.findByRole('alertdialog')
    // Long TCS 2660 CE 1,125 -> the close SELLS. Side and size both stated:
    // "Close TCS 2660 CE" reads the same whichever way and whatever the size.
    expect(within(dialog).getByText(/Sells 1,125/)).toBeTruthy()
    // Named in the title, the sentence and the action button — all three, which
    // is why this counts rather than expecting one.
    expect(within(dialog).getAllByText(/TCS 2660 CE/).length).toBeGreaterThan(0)
    // The rail is stated too: paper and live look identical otherwise.
    expect(within(dialog).getByText(/in paper\?$/)).toBeTruthy()
  })

  test('dismissing the confirmation places nothing', async () => {
    const sent = mount()
    await screen.findByText(DEAD_SHOWN)
    act(() => { (closeButtonFor(DEAD_SHOWN) as HTMLElement).click() })
    const dialog = await screen.findByRole('alertdialog')

    act(() => { (within(dialog).getByRole('button', { name: /cancel/i })).click() })

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBe(null))
    expect(closeCalls(sent)).toHaveLength(0)
  })

  // --------------------------------------------------------- the happy path

  test('confirming posts the ONE contract, and reports what routed', async () => {
    const sent = mount()
    await screen.findByText(DEAD_SHOWN)
    act(() => { (closeButtonFor(DEAD_SHOWN) as HTMLElement).click() })
    const dialog = await screen.findByRole('alertdialog')
    act(() => { (within(dialog).getByRole('button', { name: /^Close TCS 2660 CE$/ })).click() })

    await waitFor(() => expect(closeCalls(sent)).toHaveLength(1))
    const call = closeCalls(sent)[0] as SentRequest & { body?: Record<string, unknown> }
    expect(call.method).toBe('POST')
    expect(call.path).toContain(encodeURIComponent(TAG))
    expect(call.body?.['tradingsymbol']).toBe(DEAD)
    expect(call.body?.['mode']).toBe('paper')
    // Stated, never defaulted server-side — the client must send both.
    expect(call.body?.['style']).toBe('fast')
    expect(String(call.body?.['decisionId'] ?? '')).not.toBe('')

    await screen.findByText(/Closed TCS 2660 CE/)
  })

  test('a REFUSAL is shown verbatim — the server says what to do next', async () => {
    // The realistic 409: the supervisor is not running, so nothing would
    // absorb the close and the strategy would manage a leg that is gone.
    const message =
      `'${TAG}' is not running in paper (the supervisor last reported 'stopped'): ` +
      `NOTHING WAS CLOSED. Start the book first.`
    mount({ closeFails: { status: 409, body: { error: message } } })
    await screen.findByText(DEAD_SHOWN)
    act(() => { (closeButtonFor(DEAD_SHOWN) as HTMLElement).click() })
    const dialog = await screen.findByRole('alertdialog')
    act(() => { (within(dialog).getByRole('button', { name: /^Close TCS 2660 CE$/ })).click() })

    // Verbatim, and as a banner rather than a toast: this sentence has to
    // survive long enough to be read and acted on.
    await screen.findByText(new RegExp('NOTHING WAS CLOSED'))
    await screen.findByText('The strike was not closed')
  })

  // ------------------------------------------- where the button must not be

  test('there is no button on the TOTAL row', async () => {
    mount()
    await screen.findByText(DEAD_SHOWN)
    expect(closeButtonFor('Total')).toBe(null)
  })

  test('there is no button on a contract that is already flat', async () => {
    mount()
    await screen.findByText(DEAD_SHOWN)
    // qty 0 — nothing to close, so a live-looking button could only ever 409.
    expect(closeButtonFor('TCS 2380 CE')).toBe(null)
  })

  test('a tag with NO registered book shows no close column at all', async () => {
    // A hosted intraday strategy has no registry row and no desk-books
    // document, so this endpoint has nothing to act on — `close-all` by tag is
    // what that position uses. A permanently dead control is noise on a table
    // that is read under pressure.
    mount({ book: null })
    await screen.findByText(DEAD_SHOWN)
    expect(closeButtonFor(DEAD_SHOWN)).toBe(null)
  })
})

/**
 * A 200 WITH NO FILLS IS NOT A CLOSE.
 *
 * The realistic case is after hours: `MarksCache.feedAlive()` goes false once
 * ticks stop, `marks.price()` answers null, and `applyActions` SKIPS the close
 * rather than pricing an exit off a dead feed. That is the right call and no
 * order is written — but the operator must not be told their leg is closed at
 * the exact moment nothing has happened.
 */
test('a close that routed NOTHING says so, and does not claim success', async () => {
  mount({
    closeFails: {
      body: {
        fills: [],
        skips: [{ reason: 'close: no mark for TCS26AUG2660CE' }],
        closed: ['open-1'],
        unpriceable: [],
      },
    },
  })
  await screen.findByText(DEAD_SHOWN)
  act(() => { (closeButtonFor(DEAD_SHOWN) as HTMLElement).click() })
  const dialog = await screen.findByRole('alertdialog')
  act(() => { (within(dialog).getByRole('button', { name: /^Close TCS 2660 CE$/ })).click() })

  await screen.findByText(/Nothing was closed/)
  // The skip's own sentence, not a paraphrase of it.
  await screen.findByText(/no mark for TCS26AUG2660CE/)
  // And emphatically NOT the success wording.
  expect(screen.queryByText(/^Closed TCS 2660 CE —/)).toBe(null)
})

// ------------------------------------------------------------------ sorting

/**
 * THE TOTAL IS A SUMMARY, NOT A ROW OF THE BOOK.
 *
 * It lives inside the table so its figures sit under the columns that produced
 * them, which is worth keeping — but it must never be sorted with the legs. By
 * MTM it would file itself somewhere in the middle of the position, where it
 * reads as another contract and the columns no longer sum to anything visible.
 */
describe('sorting the net positions', () => {
  /** The contract cell of every body row, top to bottom. */
  const contractsInOrder = (): string[] =>
    [...document.querySelectorAll('tbody tr')].map(
      (r) => r.querySelector('td')?.textContent?.trim() ?? '',
    )

  test('it opens in the option ladder — strike falling down the screen', async () => {
    mount()
    await screen.findByText(DEAD_SHOWN)
    const legs = contractsInOrder().filter((c) => c !== 'Total')
    // The fixture is all calls: 2660, 2460, 2380. Descending is the ladder.
    expect(legs).toEqual(['TCS 2660 CE', 'TCS 2460 CE', 'TCS 2380 CE'])
  })

  test('the TOTAL stays last, whatever the sort', async () => {
    mount()
    await screen.findByText(DEAD_SHOWN)

    const before = contractsInOrder()
    expect(before[before.length - 1]).toBe('Total')

    // Re-sort by clicking the Contract header, which flips the ladder.
    const header = screen.getByRole('columnheader', { name: /Contract/ })
    const control = within(header).queryByRole('button') ?? header
    act(() => { (control as HTMLElement).click() })

    const after = contractsInOrder()
    expect(after[after.length - 1]).toBe('Total')
    // And it really did reorder, rather than the click doing nothing.
    expect(after.slice(0, -1)).not.toEqual(before.slice(0, -1))
  })
})

