/**
 * The desk-vs-bridge panel is DELIBERATELY ASYMMETRIC, and that asymmetry is
 * the thing these tests exist to hold.
 *
 * Agreement between the Python desk and the bridge is the state this page is in
 * nearly every second of every session, and it used to be announced with a
 * card, a heading and a full-width green bar. Weight spent there is weight an
 * operator learns to skip — and an eye trained to skip this region skips it on
 * the day it is not green. So the healthy state is one quiet line, while a
 * disagreement — a position nobody is managing — keeps the full panel naming
 * every leg and the direction it differs in.
 *
 * A refactor that "tidies" the two branches into one uniform rendering passes
 * every other test in this suite. These are what fails.
 */
import { expect, test, describe, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PositionsPage } from '../src/pages.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch } from './http.tsx'

const TAG = 'NIFTY-2026-08-27-atr-band'

/**
 * A fixed clock for `declaredAt`. The 'declared 12s ago' assertion below used
 * to compute `Date.now() - 12_000` at fixture time while the page computed
 * `Date.now() - declaredAt` at render time; on a slow run the gap grew past
 * 12.5s and `ago()` rounded it to "13s ago". Faking ONLY `Date` pins both
 * reads to NOW while leaving setTimeout/setInterval real, which `waitFor` and
 * the page's own poll depend on — `vi.useFakeTimers()` without `toFake` would
 * freeze those too and the render would never settle.
 */
const NOW = 1_755_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

/** A book with two legs, so the panel has something real to agree about. */
function bookBody(): unknown {
  return {
    tag: TAG, symbol: 'NIFTY', mode: 'paper', spot: 24300, asOf: NOW, complete: true,
    legs: [{
      deskTag: 'L1',
      instrument: { tradingsymbol: 'NIFTY26AUG24200PE', lotSize: 65 },
      underlying: 'NIFTY', expiry: '2026-08-27', strike: 24200, type: 'PE',
      side: 'Sell', qty: -650, entryPrice: 88, openedTs: 1,
    }],
    greeks: {
      legs: [], netDelta: 0, netGamma: 0, netVega: 0, netTheta: 0, unpriced: [],
    },
  }
}

/** Renders the page with `/v1/desk/diff` answering exactly `diff`. */
function renderWithDiff(diff: unknown): void {
  installFetch(({ path }) => {
    if (path === '/v1/desk/positions') return { body: bookBody() }
    if (path === '/v1/desk/diff') return { body: diff }
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

describe('desk vs bridge — quiet when healthy', () => {
  test('an in-sync book renders one compact line: badge, leg count, and the age of the declaration', async () => {
    renderWithDiff({
      matched: [
        { strike: 24200, type: 'PE', deskQty: -650, bridgeQty: -650 },
        { strike: 24450, type: 'CE', deskQty: -650, bridgeQty: -650 },
      ],
      mismatched: [], deskOnly: [], bridgeOnly: [],
      inSync: true,
      declaredAt: NOW - 12_000,
    })

    await waitFor(() => expect(screen.getByText('in sync')).toBeTruthy())

    // The count and the age are the two facts a green bar could not carry. The
    // age matters on its own: `declaredAt` drifting into minutes while the page
    // polls every 8s is a signal, and only a rendered age can show it.
    const line = screen.getByText(/desk vs bridge/)
    expect(line.textContent).toContain('2 legs')
    expect(line.textContent).toContain('declared 12s ago')

    // NO HEADING, therefore no card: the heading exists only in the loud forms.
    // This is the assertion that fails if the healthy state grows back into a
    // full-width panel.
    expect(screen.queryByText('Desk vs bridge')).toBe(null)
  })
})

describe('desk vs bridge — loud when broken', () => {
  test('a leg the desk holds and we do not keeps the full panel, naming the leg and the direction', async () => {
    renderWithDiff({
      matched: [{ strike: 24200, type: 'PE', deskQty: -650, bridgeQty: -650 }],
      mismatched: [],
      deskOnly: [{ strike: 24450, type: 'CE', deskQty: -650, bridgeQty: 0 }],
      bridgeOnly: [],
      inSync: false,
      declaredAt: NOW - 3_000,
    })

    await waitFor(() => expect(screen.getByText('out of sync')).toBeTruthy())
    // The panel — heading and all — is what makes this impossible to skip.
    expect(screen.getByText('Desk vs bridge')).toBeTruthy()
    // WHICH leg and WHICH WAY. "out of sync" alone is not actionable.
    expect(screen.getByText(/desk holds 24450CE \(-650\) — we do not/)).toBeTruthy()
  })

  test('a leg we hold and the desk does not, and a quantity mismatch, are each spelled out', async () => {
    renderWithDiff({
      matched: [],
      mismatched: [{ strike: 24200, type: 'PE', deskQty: -650, bridgeQty: -1300 }],
      deskOnly: [],
      bridgeOnly: [{ strike: 24000, type: 'PE', deskQty: 0, bridgeQty: -325 }],
      inSync: false,
      declaredAt: NOW,
    })

    await waitFor(() => expect(screen.getByText('out of sync')).toBeTruthy())
    expect(screen.getByText(/we hold 24000PE \(-325\) — the desk does not/)).toBeTruthy()
    expect(screen.getByText(/24200PE: desk -650 vs ours -1,300/)).toBeTruthy()
  })

  test('`inSync: true` alongside a listed difference is read as BROKEN, not as agreement', async () => {
    // The server computes `inSync` from the same three lists it sends. If the
    // summary and the lists ever part company, the branch that hides a
    // disagreement must not be the one that wins.
    renderWithDiff({
      matched: [],
      mismatched: [{ strike: 24200, type: 'PE', deskQty: -650, bridgeQty: -1300 }],
      deskOnly: [], bridgeOnly: [],
      inSync: true,
      declaredAt: NOW,
    })

    await waitFor(() => expect(screen.getByText('out of sync')).toBeTruthy())
    expect(screen.getByText('Desk vs bridge')).toBeTruthy()
    expect(screen.queryByText('in sync')).toBe(null)
  })
})

describe('desk vs bridge — an undeclared book is neither', () => {
  test('a book nothing has declared says so, as neither success nor failure', async () => {
    renderWithDiff({
      matched: [], mismatched: [], deskOnly: [], bridgeOnly: [],
      inSync: true,
      declaredAt: null,
    })

    await waitFor(() => expect(screen.getByText('no book declared')).toBeTruthy())
    /*
      Legible: it still says WHY there is nothing to compare — and it now names
      the real reason. The old copy said "only the Python desk does", which
      stopped being true when Python was retired at the 2026-08-22 cutover:
      nothing writes `desk-declarations` any more (newest prod row 2026-08-21),
      so this is every book's state, not one class of book's.
    */
    expect(screen.getByText(/declaration feed retired with the Python desk/)).toBeTruthy()
    expect(screen.getByText(/not a fault in this one/)).toBeTruthy()
    // Not dressed up as agreement, and not raised as an alarm.
    expect(screen.queryByText('in sync')).toBe(null)
    expect(screen.queryByText('out of sync')).toBe(null)
    expect(screen.queryByText('Desk vs bridge')).toBe(null)
  })
})
