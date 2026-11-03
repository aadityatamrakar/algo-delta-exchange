/**
 * The Books page: the desired/actual gap made visible, the STALLED alarm, the
 * expiry alarm, and the two lifecycle actions (start asks first in live, stop
 * never asks).
 */
import { expect, test, describe, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BooksPage } from '../src/books.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type SentRequest } from './http.tsx'
import type { BookRow } from '../src/api.ts'

const TAG = 'BHEL-2026-08-25-hold-recycle-r'

function bookRow(over: Partial<BookRow> = {}): BookRow {
  return {
    tag: TAG, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper', variant: 'hold-recycle-r',
    dials: {}, desired: 'stopped', actual: 'stopped', lastMarkAt: 0, lastDecision: '',
    createdAt: 0, updatedAt: 0,
    ...over,
  }
}

function mount(
  mode: 'paper' | 'live',
  rows: BookRow[],
  extra?: (path: string, method: string) => { body?: unknown; status?: number } | null,
): SentRequest[] {
  window.localStorage.setItem('desk.mode', mode)
  const sent = installFetch(({ path, method }) => {
    const custom = extra?.(path, method)
    if (custom !== null && custom !== undefined) return custom
    if (path === '/v1/desk/books/registry' && method === 'GET') return { body: { books: rows } }
    if (path === '/v1/desk/books' && method === 'GET') return { body: { books: [] } }
    if (path === '/v1/desk/pnl' && method === 'GET') {
      return { body: { mode, strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
    }
    if (path.endsWith('/start') && method === 'POST') return { body: { ...rows[0], desired: 'running' } }
    if (path.endsWith('/stop') && method === 'POST') return { body: { ...rows[0], desired: 'stopped' } }
    return { body: {} }
  })
  render(
    <AuthProvider>
      <ModeProvider>
        <BooksPage mode={mode} />
      </ModeProvider>
    </AuthProvider>,
  )
  return sent
}

/** Tue 2026-07-28, 10:00 IST — mid-session. */
const SESSION_TIME = new Date('2026-07-28T10:00:00+05:30').getTime()
/** Sat 2026-08-01, 11:00 IST — session hours, but the exchange is shut. */
const WEEKEND = new Date('2026-08-01T11:00:00+05:30').getTime()

/**
 * Mount with the clock pinned. Several of the states on this page are answers
 * to "is the market open?", so a test that took wall time would pass or fail by
 * the day of the week it was run on.
 *
 * `findByText`/`waitFor` poll the timer functions `vi.useFakeTimers` replaces,
 * so they never resolve unless the fake clock is advanced from outside — hence
 * the explicit `act` here and `getByText` in the assertions.
 */
async function mountAt(now: number, rows: BookRow[]): Promise<void> {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  mount('paper', rows)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('the desired/actual gap', () => {
  afterEach(() => { vi.useRealTimers() })

  test('a matched state renders as a plain badge, nothing more', async () => {
    await mountAt(SESSION_TIME, [bookRow({ desired: 'running', actual: 'running' })])
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.queryByText(/asked to/)).toBe(null)
  })

  test('"asked to run, not running" is its own visual state — never actual alone', async () => {
    mount('paper', [bookRow({ desired: 'running', actual: 'stopped' })])
    await screen.findByText(TAG)
    await screen.findByText('asked to run, not running')
    // Both values are named too, so the operator can tell which side is stale.
    expect(screen.getByText('desired running · actual stopped')).toBeTruthy()
    // Never rendered as a lone "stopped" badge, which would read as agreement.
    expect(screen.queryByText(/^stopped$/)).toBe(null)
  })

  test('"asked to stop, still running" is the mirror case', async () => {
    mount('paper', [bookRow({ desired: 'stopped', actual: 'running' })])
    await screen.findByText(TAG)
    await screen.findByText('asked to stop, still running')
  })
})

/**
 * OFF-HOURS, THE PAGE STATES THE SESSION ONCE AND THEN STOPS TALKING ABOUT IT.
 *
 * Everything on a Saturday row looks like a fault: the marks are hours old, the
 * P&L is an em dash, and a `running` book is green beside all of it. None of it
 * is wrong, and the page said none of it — so the operator was left reading a
 * screenful of dashes with no explanation. One quiet line near the heading
 * explains the lot; per-row noise would drown the alarms that still matter (the
 * expiry badge never goes quiet, and the STALLED alarm returns on Monday).
 */
describe('a closed market', () => {
  afterEach(() => { vi.useRealTimers() })

  test('says so ONCE, near the heading, in the positions page\'s own words', async () => {
    await mountAt(WEEKEND, [bookRow({ desired: 'running', actual: 'running', lastMarkAt: WEEKEND - 7000 })])
    expect(screen.getByText(/Market closed — showing last known marks/)).toBeTruthy()
  })

  test('during a session it says nothing — a line that is always there is not information', async () => {
    await mountAt(SESSION_TIME, [bookRow({ desired: 'running', actual: 'running', lastMarkAt: SESSION_TIME - 7000 })])
    expect(screen.queryByText(/Market closed/)).toBe(null)
  })

  test('a running book is neutral off-hours, not a green "everything is fine"', async () => {
    // The supervisor IS running — that is worth showing, and stopping it from
    // being shown would lose the desired/actual gap with it. What it is not, at
    // 11:00 on a Saturday, is a desk that is working.
    await mountAt(WEEKEND, [bookRow({ desired: 'running', actual: 'running' })])
    expect(screen.getByText('running · market closed')).toBeTruthy()
  })

  test('the gap is UNTOUCHED by the clock — asked to run and not running is always loud', async () => {
    // A supervisor that died on Friday is still dead on Saturday, and this is
    // the cell that says so.
    await mountAt(WEEKEND, [bookRow({ desired: 'running', actual: 'stopped' })])
    expect(screen.getByText('asked to run, not running')).toBeTruthy()
    expect(screen.getByText('desired running · actual stopped')).toBeTruthy()
  })

  test('the last-mark cell is honest about WHAT it is timing off-hours', async () => {
    // Off-session that timestamp is the Python supervisor's heartbeat — it
    // polls and writes whether or not a tick arrived — so calling it a mark
    // would have the page reporting live prices on a shut exchange.
    await mountAt(WEEKEND, [bookRow({ desired: 'running', actual: 'running', lastMarkAt: WEEKEND - 7000 })])
    expect(screen.getByText('heartbeat 7s ago')).toBeTruthy()
  })

  test('in a session it is a mark, and reads as one', async () => {
    await mountAt(SESSION_TIME, [bookRow({ desired: 'running', actual: 'running', lastMarkAt: SESSION_TIME - 7000 })])
    expect(screen.getByText('7s ago')).toBeTruthy()
    expect(screen.queryByText(/heartbeat/)).toBe(null)
  })
})

describe('the stalled alarm', () => {
  const AFTER_HOURS = new Date('2026-07-28T20:00:00+05:30').getTime() // same day, feed closed

  // `findByText`/`waitFor` poll on the SAME timer functions `vi.useFakeTimers`
  // replaces, so they never resolve unless the fake clock is advanced from
  // outside — a plain `getByText` right after `act` is what these two tests use
  // instead. A LOCAL `afterEach` restores real timers even if an assertion
  // throws mid-test, so a failure here cannot hang every test after it.
  afterEach(() => { vi.useRealTimers() })

  test('a book claiming to run but silent for 10m+ during a session is STALLED', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(SESSION_TIME)
    mount('paper', [bookRow({
      desired: 'running', actual: 'running', lastMarkAt: SESSION_TIME - 11 * 60_000,
    })])
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(/STALLED/)).toBeTruthy()
  })

  test('the same gap outside a session is not an alarm — the feed is expected to be quiet', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(AFTER_HOURS)
    mount('paper', [bookRow({
      desired: 'running', actual: 'running', lastMarkAt: AFTER_HOURS - 11 * 60_000,
    })])
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(TAG)).toBeTruthy()
    expect(screen.queryByText(/STALLED/)).toBe(null)
  })

  test('a book that has never reported says "never", not a false-current mark', async () => {
    mount('paper', [bookRow({ lastMarkAt: 0 })])
    await screen.findByText(TAG)
    expect(screen.getByText('never')).toBeTruthy()
  })
})

describe('the expiry alarm', () => {
  test('a book still carrying legs past its own expiry gets a named alarm', async () => {
    const past = bookRow({ expiry: '2020-01-01' })
    mount('paper', [past], (path, method) => (
      path === '/v1/desk/books' && method === 'GET'
        ? { body: { books: [{ tag: TAG, symbol: 'BHEL', legs: 2, netDelta: -100, complete: true, updatedAt: 1 }] } }
        : null
    ))
    await screen.findByText(TAG)
    await screen.findByText('carrying legs past expiry')
  })

  test('a flat book past its expiry is not alarmed — nothing is left to carry', async () => {
    const past = bookRow({ expiry: '2020-01-01' })
    mount('paper', [past], (path, method) => (
      path === '/v1/desk/books' && method === 'GET'
        ? { body: { books: [{ tag: TAG, symbol: 'BHEL', legs: 0, netDelta: 0, complete: true, updatedAt: 1 }] } }
        : null
    ))
    await screen.findByText(TAG)
    expect(screen.queryByText('carrying legs past expiry')).toBe(null)
  })
})

/**
 * THE TWO COLUMNS THAT COME FROM SOMEWHERE ELSE.
 *
 * Net delta and P&L are not in the registry response — they are two other polls
 * (`/v1/desk/books`, `/v1/desk/pnl`), and both errors used to be destructured
 * away. A bridge that answers the registry and fails the summary leaves those
 * columns frozen at their last values with nothing on the page admitting it,
 * and the SAME summary decides how the Delete dialog words itself: "still holds
 * 3 leg(s), they will be CLOSED AT MARKET first" is read off a number that may
 * be an hour old (audit F-50).
 *
 * THE REGISTRY BANNER DOES NOT COVER THIS. It fires on a different read and
 * says a different thing — that the list itself cannot be trusted — so a page
 * whose list is current and whose figures are frozen would say nothing at all.
 */
describe('the figures that come from other reads', () => {
  const failing = (path: string) => (p: string, method: string) => (
    p === path && method === 'GET' ? { status: 503, body: { error: 'bridge unreachable' } } : null
  )

  test('a failed P&L read is SAID — the column is frozen, not merely quiet', async () => {
    mount('paper', [bookRow()], failing('/v1/desk/pnl'))
    await screen.findByText(TAG)
    await screen.findByText(/Net delta and P&L may be older than they look/)
    // The server's own sentence, not a summary of it.
    expect(screen.getByText(/bridge unreachable/)).toBeTruthy()
  })

  test('a failed summary read names the Delete confirmation as reading the same number', async () => {
    mount('paper', [bookRow()], failing('/v1/desk/books'))
    await screen.findByText(TAG)
    await screen.findByText(/Delete confirmation reads the same figures/)
  })

  test('both reads answering says nothing — a banner that is always there is not information', async () => {
    mount('paper', [bookRow()])
    await screen.findByText(TAG)
    expect(screen.queryByText(/may be older than they look/)).toBe(null)
  })
})

describe('start and stop', () => {
  test('starting a book in PAPER fires immediately, no confirmation', async () => {
    const sent = mount('paper', [bookRow({ desired: 'stopped', actual: 'stopped' })])
    await screen.findByText(TAG)
    act(() => { screen.getByRole('button', { name: 'Start' }).click() })
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/start'))).toBe(true))
    const req = sent.find((r) => r.path.endsWith('/start'))
    expect(req?.body).toMatchObject({ mode: 'paper' })
  })

  test('starting a book in LIVE asks first — nothing is sent until confirmed', async () => {
    const sent = mount('live', [bookRow({ mode: 'live', desired: 'stopped', actual: 'stopped' })])
    await screen.findByText(TAG)
    act(() => { screen.getByRole('button', { name: 'Start' }).click() })

    // Nothing has gone out yet.
    expect(sent.some((r) => r.path.endsWith('/start'))).toBe(false)
    await screen.findByText(`Start ${TAG} in live?`)
    await screen.findByText(/route real orders/)

    const dialog = screen.getByRole('alertdialog')
    act(() => { within(dialog).getByRole('button', { name: 'Start in live' }).click() })
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/start'))).toBe(true))
    const req = sent.find((r) => r.path.endsWith('/start'))
    expect(req?.body).toMatchObject({ mode: 'live' })
  })

  test('stopping never asks, in either mode', async () => {
    const sent = mount('live', [bookRow({ mode: 'live', desired: 'running', actual: 'running' })])
    await screen.findByText(TAG)
    act(() => { screen.getByRole('button', { name: 'Stop' }).click() })
    await waitFor(() => expect(sent.some((r) => r.path.endsWith('/stop'))).toBe(true))
    expect(screen.queryByRole('alertdialog')).toBe(null)
  })
})

/**
 * RUNNING BOOKS FIRST, NEWEST FIRST. The registry comes back in Mongo's
 * natural order — insertion order — and under the daily roll that put
 * yesterday's stopped delta-lean rows above today's running ones, with the
 * list growing by four a day. The rows the operator is watching go to the top
 * and the day's new ones lead; a stopped row is one session from erasure and
 * belongs under them.
 */
describe('the order of the rows', () => {
  test('desired running first, then createdAt descending', async () => {
    const rows = [
      bookRow({ tag: 'ORDER-old-stopped', desired: 'stopped', actual: 'stopped', createdAt: 3 }),
      bookRow({ tag: 'ORDER-oldest-running', desired: 'running', actual: 'running', createdAt: 1 }),
      bookRow({ tag: 'ORDER-newest-stopped', desired: 'stopped', actual: 'stopped', createdAt: 4 }),
      // Asked to run, not running — the gap row still sorts by what was ASKED.
      bookRow({ tag: 'ORDER-new-running', desired: 'running', actual: 'stopped', createdAt: 2 }),
    ]
    mount('paper', rows)
    await screen.findByText('ORDER-new-running')
    const shown = screen.getAllByText(/^ORDER-/).map((el) => el.textContent)
    expect(shown).toEqual([
      'ORDER-new-running',
      'ORDER-oldest-running',
      'ORDER-newest-stopped',
      'ORDER-old-stopped',
    ])
  })
})

/**
 * SERIES (WS2). A delta-lean book is one dated tag a day, so the registry holds
 * yesterday's and today's NIFTY aggressive side by side under different tags.
 * The series is what says they are the same strategy: shown under the tag, and
 * the rows of one series kept together, the group with a running book first.
 */
describe('series', () => {
  test('the book cell shows the series under the tag', async () => {
    mount('paper', [bookRow({ series: 'BHEL-hold-recycle-r' })])
    await screen.findByText(TAG)
    expect(screen.getByText('BHEL-hold-recycle-r')).toBeTruthy()
  })

  test('a row from a desk that predates series still shows one, from its symbol and variant', async () => {
    mount('paper', [bookRow({ symbol: 'NIFTY', variant: 'delta-lean-aggressive' })])
    await screen.findByText(TAG)
    expect(screen.getByText('NIFTY-delta-lean-aggressive')).toBeTruthy()
  })

  test('rows are grouped by series, the group with a running book first, running first within it', async () => {
    const NA = { symbol: 'NIFTY', variant: 'delta-lean-aggressive', series: 'NIFTY-delta-lean-aggressive' }
    const SA = { symbol: 'SENSEX', variant: 'delta-lean-aggressive', series: 'SENSEX-delta-lean-aggressive' }
    const rows = [
      bookRow({ ...NA, tag: 'GRP-N-0930', desired: 'stopped', createdAt: 3 }),
      bookRow({ ...SA, tag: 'GRP-S-1001', desired: 'running', actual: 'running', createdAt: 4 }),
      bookRow({ ...NA, tag: 'GRP-N-1001', desired: 'running', actual: 'running', createdAt: 5 }),
      bookRow({ ...SA, tag: 'GRP-S-0930', desired: 'stopped', createdAt: 2 }),
    ]
    mount('paper', rows)
    await screen.findByText('GRP-N-1001')
    const shown = screen.getAllByText(/^GRP-/).map((el) => el.textContent)
    expect(shown).toEqual(['GRP-N-1001', 'GRP-N-0930', 'GRP-S-1001', 'GRP-S-0930'])
  })
})

describe('an empty registry', () => {
  test('says plainly that "Build a book" is the only way in', async () => {
    mount('paper', [])
    // The sentence has to name the button that is actually on the page: it used
    // to say "Create book", which is the wizard's name and no longer exists here.
    await screen.findByText(/No books are registered in paper yet\. "Build a book" opens a position/)
  })
})

/**
 * THE BUILD PAGE IS THE WAY IN, and this page is the only door to it.
 *
 * `#/build` lost its header tab — Books CREATES a book from a position that
 * already exists, Build OPENS the position first, and the operator reaches the
 * second from the first rather than from a tab that meant nothing until you
 * were already here. The wizard dialog that used to open from this button went
 * unreachable at that point and has since been deleted.
 */
describe('the build entry point', () => {
  test('"Build a book" navigates to the build page', async () => {
    window.location.hash = '#/books'
    mount('paper', [])
    await screen.findByText(/No books are registered in paper yet/)

    act(() => { screen.getByRole('button', { name: 'Build a book' }).click() })
    expect(window.location.hash).toBe('#/build')
  })

  test('the create wizard no longer opens from this page', async () => {
    mount('paper', [])
    await screen.findByText(/No books are registered in paper yet/)
    expect(screen.queryByRole('button', { name: 'Create book' })).toBeNull()
    expect(screen.queryByText('Create a book — Symbol')).toBeNull()
  })
})

/**
 * THE PANEL SEEDS ITS DRAFT ON MOUNT, so React reusing one instance across two
 * books is not a cosmetic bug: the heading followed the selection while the
 * values did not, and the next Save would have written the FIRST book's dials
 * onto the second. Closing and reopening hid it, because that unmounted the
 * panel. `key={tag}` is the fix, and this is what would catch losing it.
 */
describe('the dials panel', () => {
  const TCS = 'TCS-2026-08-25-recenter-relief-r'

  function twoBooks(): BookRow[] {
    return [
      bookRow({ variant: 'recenter-relief-r', dials: { target_pnl: 11111 } }),
      bookRow({
        tag: TCS, symbol: 'TCS', variant: 'recenter-relief-r',
        dials: { target_pnl: 22222 },
      }),
    ]
  }

  const targetPnl = (): HTMLInputElement =>
    screen.getByLabelText('target_pnl') as HTMLInputElement

  test('switching books without closing swaps the VALUES, not just the heading', async () => {
    mount('paper', twoBooks())
    await screen.findByText(TAG)

    // BHEL's dials
    act(() => { screen.getAllByRole('button', { name: 'Dials' })[0]?.click() })
    await screen.findByText(`Dials \u00b7 ${TAG}`)
    expect(targetPnl().value).toBe('11111')

    // ...straight to TCS's, with no Close in between
    act(() => { screen.getByRole('button', { name: 'Dials' }).click() })
    await screen.findByText(`Dials \u00b7 ${TCS}`)
    expect(targetPnl().value).toBe('22222')
  }, 30_000) // the BULL-S dials made the panel heavier to render

  /**
   * THE PANEL SHOWS THE WHOLE SCHEMA, and it no longer needs a catalogue to do
   * it: `packages/desk-engine` states every dial, so a knob the row never set
   * is on screen at its PRESET value and can be retuned. The row's own value
   * still wins where it has one.
   */
  test('a dial the row never set is shown from the engine schema, at the preset value', async () => {
    mount('paper', twoBooks())
    await screen.findByText(TAG)
    act(() => { screen.getAllByRole('button', { name: 'Dials' })[0]?.click() })
    await screen.findByText(`Dials \u00b7 ${TAG}`)

    // The dial the operator has never seen before — relief's own 0.60...
    expect((screen.getByLabelText('shift_margin_frac') as HTMLInputElement).value).toBe('0.6')
    // ...and the row's own value winning over the preset's for target_pnl.
    expect(targetPnl().value).toBe('11111')
  })

  /**
   * NOT A CATALOGUE READ ANY MORE. The page used to poll `/v1/desk/variants`
   * for this panel's defaults; the schema is compiled in now, and the poll is
   * gone with the publication it read (spec §5).
   */
  test('the page no longer reads the variant catalogue at all', async () => {
    const sent = mount('paper', twoBooks())
    await screen.findByText(TAG)
    act(() => { screen.getAllByRole('button', { name: 'Dials' })[0]?.click() })
    await screen.findByText(`Dials \u00b7 ${TAG}`)
    expect(sent.some((r) => r.path === '/v1/desk/variants')).toBe(false)
  })
})

/**
 * RETUNING A LIVE BOOK COSTS THE PASSWORD.
 *
 * The dials the supervisor pushes into a running live worker decide how big the
 * orders are and where the structure sits, and this box rewrote them on one
 * click from any signed-in session (audit F-29). The server now re-authenticates
 * a live patch; this pins the dashboard's half — that the prompt appears BEFORE
 * anything is sent, that the password goes with the patch, and that paper is
 * left exactly as it was.
 *
 * THE PROMPT IS FOUND BY ROLE, never by its heading: the re-auth dialog is
 * always MOUNTED (`useReauth` returns one element the page renders once), so
 * its title is in the DOM whether or not it is open. Only an OPEN dialog
 * exposes `role="dialog"`.
 */
describe('the dials panel asks before it retunes a live book', () => {
  async function openDials(rows: BookRow[], mode: 'paper' | 'live'): Promise<SentRequest[]> {
    const sent = mount(mode, rows)
    await screen.findByText(rows[0]!.tag)
    act(() => { screen.getAllByRole('button', { name: 'Dials' })[0]?.click() })
    await screen.findByText(`Dials \u00b7 ${rows[0]!.tag}`)
    return sent
  }

  /**
   * SAVE IS DEAD UNTIL SOMETHING CHANGES — the patch is a diff now, so a test
   * that pressed Save on an untouched panel would be pressing a disabled
   * button and proving nothing about the gate.
   */
  function retune(value: string): void {
    fireEvent.change(screen.getByLabelText('target_pnl'), { target: { value } })
    act(() => { screen.getByRole('button', { name: /Save 1 change/ }).click() })
  }

  const patches = (sent: SentRequest[]): SentRequest[] =>
    sent.filter((r) => r.method === 'PATCH' && r.path.startsWith('/v1/desk/books/registry/'))

  /** Types the password into the OPEN prompt and confirms it. */
  async function confirmWith(password: string): Promise<void> {
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: password } })
    act(() => { within(dialog).getByRole('button', { name: 'Confirm' }).click() })
  }

  test('a LIVE save prompts first, and sends nothing until it is confirmed', async () => {
    const sent = await openDials([bookRow({ mode: 'live', dials: { target_pnl: 1 } })], 'live')
    retune('2')

    const dialog = await screen.findByRole('dialog')
    // The statement names the rail and what the dials DO — not "are you sure?".
    expect(within(dialog).getByText(/LIVE rail/)).toBeTruthy()
    expect(patches(sent)).toHaveLength(0)

    await confirmWith('hunter2')
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body).toMatchObject({ mode: 'live', password: 'hunter2' })
  }, 30_000) // the BULL-S dials made the panel heavier to render

  test('cancelling the prompt sends nothing at all', async () => {
    const sent = await openDials([bookRow({ mode: 'live', dials: { target_pnl: 1 } })], 'live')
    retune('2')
    const dialog = await screen.findByRole('dialog')
    act(() => { within(dialog).getByRole('button', { name: 'Cancel' }).click() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null))
    expect(patches(sent)).toHaveLength(0)
  })

  test('a PAPER save is unchanged — no prompt, and no password on the wire', async () => {
    const sent = await openDials([bookRow({ dials: { target_pnl: 1 } })], 'paper')
    retune('2')
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(screen.queryByRole('dialog')).toBe(null)
    expect(patches(sent)[0]?.body?.['password']).toBe(undefined)
  })

  /**
   * THE SERVER IS THE AUTHORITY. The panel prompts on the same condition the
   * route checks, but a 403 from anywhere else — a paper row the server reads
   * as live, a session that expired mid-edit — must re-open the prompt carrying
   * the server's own message rather than showing a dead error.
   */
  test('a 403 the panel did not expect re-opens the prompt with the server\'s message', async () => {
    let asked = 0
    const sent = mount('paper', [bookRow({ dials: { target_pnl: 1 } })], (path, method) => {
      if (method === 'PATCH' && path.startsWith('/v1/desk/books/registry/')) {
        asked += 1
        return asked === 1
          ? { status: 403, body: { error: 'password required', reauthRequired: true } }
          : null
      }
      return null
    })
    await screen.findByText(TAG)
    act(() => { screen.getAllByRole('button', { name: 'Dials' })[0]?.click() })
    await screen.findByText(`Dials \u00b7 ${TAG}`)
    retune('2')

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('password required')).toBeTruthy()
    await confirmWith('hunter2')

    await waitFor(() => expect(asked).toBe(2))
    expect(sent.filter((r) => r.method === 'PATCH').at(-1)?.body).toMatchObject({ password: 'hunter2' })
  }, 30_000) // the BULL-S dials made the panel heavier to render
})
