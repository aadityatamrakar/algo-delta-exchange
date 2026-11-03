/**
 * The strategies table: the three states, and the four one-click actions that
 * used to have nothing in front of them.
 */
import { expect, test, describe, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrategiesPage, StrategyPage } from '../src/strategies.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type Reply, type SentRequest } from './http.tsx'

const row = (tag: string, modes: Record<string, { enabled: boolean }>): Record<string, unknown> => ({
  // A label DIFFERENT from the tag: the cell renders both, and identical text
  // in two nodes makes every query in here ambiguous.
  tag, kind: 'hosted', label: `${tag} desc`, modes, liveLots: 1, autostartAt: '', lastSeenAt: 0,
  disabledReason: null, updatedAt: 0,
  runtime: { state: 'stopped', startedAt: null, lastError: null, openPositions: 0 },
})

const ROWS = [
  row('ORB_SCALP_BN', { paper: { enabled: true }, live: { enabled: false } }),
  row('ATR_BAND_NIFTY', { paper: { enabled: false } }),
]

function mount(mode: 'paper' | 'live', extra?: (path: string, method: string) => Reply | null): SentRequest[] {
  // The provider IS the switch, and the page's badge reads it — in the app the
  // two are the same value by construction, so the harness sets both.
  window.localStorage.setItem('desk.mode', mode)
  const sent = installFetch(({ path, method, url }) => {
    const custom = extra?.(path, method)
    if (custom !== null && custom !== undefined) return custom
    if (path === '/v1/desk/strategies' && method === 'GET') {
      const all = url.searchParams.get('all') === '1'
      const wanted = url.searchParams.get('mode') ?? 'paper'
      return {
        body: {
          strategies: all
            ? ROWS
            : ROWS.filter((r) => (r['modes'] as Record<string, unknown>)[wanted] !== undefined),
        },
      }
    }
    if (path === '/v1/desk/strategies/available') {
      return { body: { available: [{ tag: 'NEW_THING', label: 'New thing', kind: 'hosted' }] } }
    }
    return { body: {} }
  })
  render(
    <AuthProvider>
      <ModeProvider>
        <StrategiesPage mode={mode} />
      </ModeProvider>
    </AuthProvider>,
  )
  return sent
}

describe('the strategies table', () => {
  test('it lists rows that are ADDED and OFF, in the mode the switch says', async () => {
    const sent = mount('live')
    // Membership, not permission: filtering on the switch would take a strategy
    // out of the table the moment it was paused, and the only way back would be
    // to delete and re-add the row.
    await screen.findByText('ORB_SCALP_BN')
    expect(screen.queryByText('ATR_BAND_NIFTY')).toBe(null)
    expect(sent.some((r) => r.url.includes('/v1/desk/strategies?mode=live'))).toBe(true)
  })

  test('the page offers no mode control of its own', async () => {
    mount('live')
    await screen.findByText('ORB_SCALP_BN')
    // The badge states the mode; the only control is the navbar switch. A
    // second one is the ambiguity, not the safeguard.
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'PAPER' })).toBe(null)
    expect(screen.queryByRole('button', { name: 'LIVE' })).toBe(null)
  })

  test('the add modal asks the catalogue about THIS mode', async () => {
    const sent = mount('live')
    await screen.findByText('ORB_SCALP_BN')
    act(() => { screen.getByRole('button', { name: 'Add strategy' }).click() })

    // Availability is per mode on the server: asking without one filters
    // against PAPER membership, which silently omits every strategy already
    // running on paper — exactly the ones you promote to live.
    await waitFor(() =>
      expect(sent.some((r) => r.path === '/v1/desk/strategies/available' && r.url.includes('mode=live')))
        .toBe(true))
  })

  test('a mass switch-off is confirmed before anything is sent', async () => {
    const sent = mount('live')
    await screen.findByText('ORB_SCALP_BN')

    act(() => { screen.getByRole('button', { name: 'Turn all off in live' }).click() })

    // Nothing has gone out yet. Off is not the harmless direction here: it
    // blocks exits as well as entries, so a mass-off strands open positions
    // rather than closing them.
    expect(sent.some((r) => r.path === '/v1/desk/strategies/bulk')).toBe(false)
    await screen.findByText(/blocks its EXITS as well as its entries/i)

    // Confirmed from inside the dialog, whose action button names the same act
    // as the one that opened it.
    const dialog = screen.getByRole('alertdialog')
    act(() => { within(dialog).getByRole('button', { name: 'Turn all off in live' }).click() })
    await waitFor(() =>
      expect(sent.some((r) => r.path === '/v1/desk/strategies/bulk')).toBe(true))
    const bulk = sent.find((r) => r.path === '/v1/desk/strategies/bulk')
    expect(bulk?.body).toMatchObject({ mode: 'live', on: false })
  })

  test('the bulk buttons say which rail they act on', async () => {
    mount('paper')
    await screen.findByText('ORB_SCALP_BN')
    // The mode used to be stated only by a badge at the other end of the row.
    expect(screen.getByRole('button', { name: 'Turn all on in paper' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Turn all off in paper' })).toBeTruthy()
  })

  test('Remove asks first, and says what it does and does not touch', async () => {
    const sent = mount('paper')
    await screen.findByText('ORB_SCALP_BN')

    act(() => { screen.getAllByRole('button', { name: 'Remove' })[0]?.click() })
    // A DELETE with no undo, on one of a dozen identical-looking rows.
    expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
    await screen.findByText('Remove ORB_SCALP_BN from the paper table?')
    await screen.findByText(/Its other mode, its live lots and its autostart are untouched/)

    act(() => { screen.getByRole('button', { name: 'Remove from paper' }).click() })
    await waitFor(() => expect(sent.some((r) => r.method === 'DELETE')).toBe(true))
    // And it SAYS it worked. A row vanishing from a table is not confirmation.
    await screen.findByText(/was removed from the paper table/)
  })

  test('the flatten dialog never carries the previous strategy\'s outcome', async () => {
    mount('paper', (path, method) =>
      path === '/v1/desk/close-all' && method === 'POST'
        ? { body: { tag: 'ORB_SCALP_BN', mode: 'paper', legs: [{ tradingsymbol: 'X', routed: true }], fills: [], unpriceable: [], unresolved: [], truncated: [], malformedFills: [], flat: true } }
        : null)
    await screen.findByText('ORB_SCALP_BN')

    act(() => { screen.getAllByRole('button', { name: 'Flatten' })[0]?.click() })
    await screen.findByText('Flatten ORB_SCALP_BN')
    act(() => { screen.getByRole('button', { name: 'Flatten — fast' }).click() })
    await screen.findByText('Flattened 1 contract.')

    // Close it, then open ANOTHER strategy's dialog. The success banner must
    // not follow: it would report an outcome for a strategy nothing has been
    // sent for, in green, above two buttons that send orders.
    act(() => { screen.getByRole('button', { name: 'Cancel' }).click() })
    act(() => { screen.getAllByRole('button', { name: 'Flatten' })[1]?.click() })
    await waitFor(() => expect(screen.queryByText('Flattened 1 contract.')).toBe(null))
  })
})

/**
 * WHAT THE RUNTIME COLUMN IS ALLOWED TO CLAIM, and what the page says when the
 * market is shut.
 *
 * `running` is the word an operator reads before deciding a strategy needs no
 * attention. Nothing removed a dead runner's last documents, so the badge said
 * `running` about a process that had not existed for weeks; and with the runner
 * starting paper strategies on a Saturday, a green badge all weekend was
 * literally true and completely misleading.
 */
describe('the runtime column, and the market clock', () => {
  const SESSION_TIME = new Date('2026-07-28T10:00:00+05:30').getTime() // Tuesday, mid-session IST
  const SATURDAY = new Date('2026-07-25T10:00:00+05:30').getTime() // same clock time, shut

  // Same reasoning as books.test.tsx: `findByText` polls on the timers
  // `useFakeTimers` replaces, so these advance the fake clock once and use
  // `getByText`. The LOCAL `afterEach` restores real timers even on a throw.
  afterEach(() => { vi.useRealTimers() })

  function mountAt(atMs: number, runtime?: Record<string, unknown>): void {
    vi.useFakeTimers()
    vi.setSystemTime(atMs)
    window.localStorage.setItem('desk.mode', 'paper')
    const one = { ...row('ORB_SCALP_BN', { paper: { enabled: true } }), ...(runtime === undefined ? {} : { runtime }) }
    installFetch(({ path }) => {
      if (path === '/v1/desk/strategies') return { body: { strategies: [one] } }
      if (path === '/v1/desk/strategies/available') return { body: { available: [] } }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <StrategiesPage mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
  }

  const RUNNING = { state: 'running', startedAt: 1, lastError: null, openPositions: 0 }

  test('a runtime document nothing has rewritten is not rendered as a live "running"', async () => {
    mountAt(SESSION_TIME, { ...RUNNING, stale: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // The state itself is still shown — it is the last thing that was true, and
    // hiding it would lose the open-position count with it — but it is annotated
    // rather than presented as a healthy desk.
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.getByText('stale')).toBeTruthy()
  })

  test('a runtime document the runner is still writing carries no annotation', async () => {
    mountAt(SESSION_TIME, { ...RUNNING, stale: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.queryByText('stale')).toBe(null)
  })

  test('outside the session the page says the market is closed', async () => {
    mountAt(SATURDAY, { state: 'waiting', startedAt: null, lastError: null, openPositions: 0, stale: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    // A table of `waiting` rows on a Saturday is not a desk that failed to
    // start, and the page should not leave the reader to work that out from the
    // date. Same wording as the positions page's stale-marks banner.
    expect(screen.getByText('Market closed')).toBeTruthy()
  })

  test('during the session it says nothing — a note that is always there is not information', async () => {
    mountAt(SESSION_TIME, { state: 'waiting', startedAt: null, lastError: null, openPositions: 0, stale: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('ORB_SCALP_BN')).toBeTruthy()
    expect(screen.queryByText('Market closed')).toBe(null)
  })
})

/**
 * THE 2026-07-28 DEFECT, at the page level.
 *
 * The positions table used to fan out over `/v1/desk/books` and filter each
 * book's legs by `deskTag`. `desk-books` is written ONLY by the Python desk's
 * `declare` — a hosted strategy journals fills and holds its position
 * internally — so the fan-out came back empty and this card rendered "No open
 * legs under this tag" beside a P&L card that had just counted six of them,
 * with a banner accusing the desk and the bridge of disagreeing.
 *
 * These tests mount the page against a P&L response that HAS legs and a books
 * endpoint that is empty, which is exactly the shape production serves.
 */
describe('one strategy: its open legs', () => {
  const LEGS = [
    { tradingsymbol: 'BANKNIFTY26AUG52000CE', qty: -30, avgCost: 210.5, mark: 180, unrealised: 915,
      realised: 0, buyQty: 0, buyValue: 0, sellQty: 30, sellValue: 6315, mtm: 915 },
    // Unmarked: real, open, and unpriceable. It must still be listed.
    { tradingsymbol: 'BANKNIFTY26AUG51000PE', qty: -30, avgCost: 190, mark: null, unrealised: null,
      realised: 0, buyQty: 0, buyValue: 0, sellQty: 30, sellValue: 5700, mtm: null },
  ]

  function mountOne(pnlLegs: unknown[]): SentRequest[] {
    window.localStorage.setItem('desk.mode', 'paper')
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/strategies') return { body: { strategies: ROWS } }
      if (path === '/v1/desk/pnl') {
        return {
          body: {
            mode: 'paper',
            strategies: [{
              tag: 'ORB_SCALP_BN', label: 'ORB_SCALP_BN desc', mode: 'paper',
              realised: 1393, unrealised: 915, total: 2308,
              openLegs: pnlLegs.length, legs: pnlLegs, unpriced: [], complete: true,
            }],
            totals: { realised: 1393, unrealised: 915, total: 2308, complete: true },
          },
        }
      }
      // Production's shape for a hosted desk: NO declared books at all.
      if (path === '/v1/desk/books') return { body: { books: [] } }
      if (path === '/v1/desk/reports/orders') return { body: { date: '2026-07-28', events: [] } }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <StrategyPage tag="ORB_SCALP_BN" mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
    return sent
  }

  test('legs render from the P&L row even though no book was ever declared', async () => {
    mountOne(LEGS)
    await screen.findByText('BANKNIFTY 52000 CE')
    // The accusation is GONE: this state is normal for a hosted strategy, and
    // a banner that fires all session teaches an operator to ignore banners.
    expect(screen.queryByText(/the desk and the bridge disagree/)).toBe(null)
    expect(screen.queryByText('No open legs under this tag.')).toBe(null)
  })

  test('an unmarked leg is listed with an em-dash, never a confident zero', async () => {
    mountOne(LEGS)
    await screen.findByText('BANKNIFTY 51000 PE')
    // A book that renders smaller than it is reads as less exposure than it
    // has — the calmest-looking dangerous state on the page.
    expect(screen.getByText('no mark')).toBeTruthy()
  })

  test('a tag that never traded says so plainly, with no accusation attached', async () => {
    mountOne([])
    await screen.findByText('This tag has not traded today.')
    expect(screen.queryByText(/disagree/)).toBe(null)
  })

  test('a closed round trip is listed at qty 0 with what it booked', async () => {
    // Hiding it left the table reading "nothing here" for a scalper that had
    // traded all morning, with a realised figure on the card above that had
    // nothing visible behind it.
    mountOne([
      { tradingsymbol: 'BANKNIFTY26AUG52000CE', qty: 0, avgCost: 0, mark: null, unrealised: null,
        realised: 1393, buyQty: 30, buyValue: 3447, sellQty: 30, sellValue: 4840, mtm: 1393 },
    ])
    const cell = await screen.findByText('BANKNIFTY 52000 CE')
    // NO "closed" chip — `Net qty` says it with a 0. But the `no mark` warning
    // must NOT appear either: this leg is closed, not unpriceable, and those
    // two states both render an em-dash under LTP while meaning opposite
    // things (over, versus carrying live risk we cannot value).
    expect(screen.queryByText('closed')).toBe(null)
    expect(screen.queryByText('no mark')).toBe(null)
    // Scoped to the ROW: the realised card above carries the same figure, and
    // an unscoped query passes on the card while the column stays empty.
    const row = cell.closest('tr')
    expect(row).not.toBe(null)
    expect(within(row as HTMLElement).getByText('+1,393')).toBeTruthy()
  })

  test('the positions table costs no request of its own', async () => {
    const sent = mountOne(LEGS)
    await screen.findByText('BANKNIFTY 52000 CE')
    // The legs ride on the P&L row already on screen. The old fan-out was one
    // request per book on a 6s poll, and it is what this replaces.
    expect(sent.some((r) => r.path === '/v1/desk/positions')).toBe(false)
    expect(sent.some((r) => r.path === '/v1/desk/books')).toBe(false)
  })

  test('the order log asks for the rail the switch names', async () => {
    const sent = mountOne(LEGS)
    await screen.findByText('BANKNIFTY 52000 CE')
    await waitFor(() => {
      expect(sent.some((r) => r.path === '/v1/desk/reports/orders' && r.url.includes('mode=paper')))
        .toBe(true)
    })
  })
})

describe('the position book totals', () => {
  function mountLegs(pnlLegs: unknown[]): void {
    window.localStorage.setItem('desk.mode', 'paper')
    installFetch(({ path }) => {
      if (path === '/v1/desk/strategies') return { body: { strategies: ROWS } }
      if (path === '/v1/desk/pnl') {
        return {
          body: {
            mode: 'paper',
            strategies: [{
              tag: 'ORB_SCALP_BN', label: 'ORB_SCALP_BN desc', mode: 'paper',
              realised: 0, unrealised: 0, total: 0,
              openLegs: 0, legs: pnlLegs, unpriced: [], complete: true,
            }],
            totals: { realised: 0, unrealised: 0, total: 0, complete: true },
          },
        }
      }
      if (path === '/v1/desk/reports/orders') return { body: { date: '2026-07-28', events: [] } }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <StrategyPage tag="ORB_SCALP_BN" mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
  }

  const leg = (over: Record<string, unknown>): Record<string, unknown> => ({
    tradingsymbol: 'A', qty: 0, avgCost: 0, mark: null, unrealised: null, realised: 0,
    buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0, mtm: 0, ...over,
  })

  test('the total row sums MTM under its own column', async () => {
    mountLegs([
      leg({ tradingsymbol: 'AAA', mtm: 1000, buyQty: 30, buyValue: 3000, sellQty: 30, sellValue: 4000 }),
      leg({ tradingsymbol: 'BBB', mtm: -400, buyQty: 10, buyValue: 1000, sellQty: 10, sellValue: 600 }),
    ])
    const total = (await screen.findByText('Total')).closest('tr') as HTMLElement
    expect(within(total).getByText('+600')).toBeTruthy()
  })

  test('the total row refuses to average averages', async () => {
    /*
      A mean of two contracts' average prices is not the average price of
      anything, and the size-weighted alternative is a blended price across two
      different strikes that nobody trades at. MTM is the only figure on this
      row that survives being added up.
    */
    mountLegs([
      leg({ tradingsymbol: 'AAA', mtm: 1000, buyQty: 30, buyValue: 3000, sellQty: 30, sellValue: 4000 }),
      leg({ tradingsymbol: 'BBB', mtm: -400, buyQty: 10, buyValue: 1000, sellQty: 10, sellValue: 600 }),
    ])
    const total = (await screen.findByText('Total')).closest('tr') as HTMLElement
    // Contract, LTP, Net qty, MTM, Buy avg, Sell avg — with MTM known, the
    // em-dashes are LTP, Net qty and the two averages.
    expect(within(total).getAllByText('—')).toHaveLength(4)
    // The blended figures this row must NOT invent: 4,000/40 and 4,600/40.
    expect(within(total).queryByText('100.00')).toBe(null)
    expect(within(total).queryByText('115.00')).toBe(null)
  })

  test('one unmarked open leg makes the TOTAL unknown, not understated', async () => {
    /*
      Summing only the legs that priced yields a confident number that is short
      by an unknown amount — the same rule the P&L card obeys. A total that
      admits it cannot be computed is safer than one quietly missing a leg.
    */
    mountLegs([
      leg({ tradingsymbol: 'AAA', mtm: 1000 }),
      leg({ tradingsymbol: 'BBB', qty: -30, mark: null, mtm: null }),
    ])
    const total = (await screen.findByText('Total')).closest('tr') as HTMLElement
    expect(within(total).queryByText('+1,000')).toBe(null)
    // LTP, Net qty and both averages are em-dashes on the total row by
    // construction; MTM joining them is the assertion — five, not the four of
    // a known total.
    expect(within(total).getAllByText('—')).toHaveLength(5)
  })

  /**
   * THE PRICE A SIDE WAS TRADED AT, which is the number compared against LTP
   * to judge a fill. The API returns cash and size, never the average, so the
   * division happens in the browser — and `0 / 0` is `NaN`.
   */
  test('buy and sell averages are computed from the qty and the value', async () => {
    mountLegs([
      leg({ tradingsymbol: 'AAA', qty: 0, buyQty: 30, buyValue: 3000, sellQty: 30, sellValue: 4000 }),
    ])
    const row = (await screen.findByText('AAA')).closest('tr') as HTMLElement
    expect(within(row).getByText('100.00')).toBeTruthy()
    expect(within(row).getByText('133.33')).toBeTruthy()
    // The amounts are gone: an amount is qty x avg and recoverable at a
    // glance, whereas an average cannot be recovered from an amount.
    expect(within(row).queryByText('3,000.00')).toBe(null)
    expect(within(row).queryByText('4,000.00')).toBe(null)
  })

  test('a contract traded on ONE side shows an em-dash, never NaN and never 0', async () => {
    /*
      Every open leg of a short strangle looks like this: sold, never bought.
      `buyValue / buyQty` is `0 / 0`, and an un-guarded division renders the
      literal text "NaN" in the middle of a price column. A zero would be worse
      still — it reads as a contract bought for nothing.
    */
    mountLegs([
      leg({ tradingsymbol: 'AAA', qty: -30, sellQty: 30, sellValue: 6315, mtm: 915 }),
    ])
    const row = (await screen.findByText('AAA')).closest('tr') as HTMLElement
    expect(within(row).getByText('210.50')).toBeTruthy()
    expect(within(row).queryAllByText(/NaN/)).toHaveLength(0)
    // LTP is an em-dash here too (mark is null), so the buy average makes two.
    // A zero would be worse than the dash: it reads as bought for nothing.
    expect(within(row).getAllByText('—')).toHaveLength(2)
    expect(within(row).queryByText('0.00')).toBe(null)
    // The Buy qty column is gone, so the size this leg did NOT trade is no
    // longer stated here at all — only the unknown PRICE is, as a dash.
    expect(within(row).getByText('210.50')).toBeTruthy()
  })
})

/**
 * The order log's clock.
 *
 * `Time` is `pixel(100)`, and the browser default `toLocaleTimeString()`
 * renders "10:07:50 AM" on an en-US machine — which does not fit, wrapped to
 * two lines, and left every fill row double-height.
 */
describe('the order log timestamp', () => {
  test('it reads in 24-hour time, with no AM/PM to parse', async () => {
    // Built from LOCAL parts rather than a fixed epoch: the assertion is about
    // the FORMAT, and a hard-coded epoch would render a different hour on a
    // machine in another timezone and fail for a reason that is not the bug.
    const at = new Date(2026, 6, 28, 14, 7, 50).getTime()
    window.localStorage.setItem('desk.mode', 'paper')
    installFetch(({ path }) => {
      if (path === '/v1/desk/strategies') return { body: { strategies: ROWS } }
      if (path === '/v1/desk/reports/orders') {
        return {
          body: {
            date: '2026-07-28',
            events: [{
              clientOrderId: 'c1', phase: 'FILL', ok: true, tag: 'ORB_SCALP_BN',
              tradingsymbol: 'BANKNIFTY26AUG52000CE', ts: at, status: 'COMPLETE',
              filledQty: 30, avgPrice: 161.35, side: 'SELL',
            }],
          },
        }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <StrategyPage tag="ORB_SCALP_BN" mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )

    await screen.findByText('14:07:50')
    // 14, not 2 — the hour is the half of this that a 12-hour clock gets wrong
    // silently, so the suffix is asserted gone as well.
    expect(screen.queryAllByText(/\bPM\b/)).toHaveLength(0)
    expect(screen.queryByText('2:07:50 PM')).toBe(null)
  })
})

/**
 * A POSITIONAL BOOK'S ORDER LOG — the whole book, not the current session.
 *
 * `BHEL-2026-08-25-recenter-r-2` is a `desk-books-registry` row: it is held
 * until its monthly expiry, so the trade that OPENED it is weeks behind the
 * session on screen. The log was fetched for today alone, which meant the one
 * row an operator reconciling a roll comes looking for could never be in it —
 * and every remaining row was stamped with a bare clock, so three weeks of
 * entries all read as this morning.
 *
 * Both halves are asserted in both directions: a hosted intraday strategy must
 * keep asking for exactly one day, and must keep its bare clock.
 */
describe('a positional book, whose log outlives the session', () => {
  const TAG = 'BHEL-2026-08-25-recenter-r-2'
  /** 11:30 IST on 10 Jul 2026 — `istDate` files it under that IST day whatever
   *  zone the browser running this is in. */
  const CREATED = Date.parse('2026-07-10T06:00:00Z')
  /** Built from LOCAL parts, like the clock test above: the rendered stamp is
   *  in the reader's zone, and a fixed epoch would name another day elsewhere. */
  const at = (day: number, hour: number, min: number): number =>
    new Date(2026, 6, day, hour, min, 0).getTime()

  const bookRow = {
    tag: TAG, symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper', variant: 'recenter-r-2',
    dials: {}, desired: 'running', actual: 'running', lastMarkAt: 0, lastDecision: '',
    createdAt: CREATED, updatedAt: CREATED,
  }

  const event = (over: Record<string, unknown>): Record<string, unknown> => ({
    clientOrderId: 'c1', phase: 'FILL', ok: true, tag: TAG, status: 'COMPLETE',
    tradingsymbol: 'BHEL26AUG320CE', filledQty: 3000, avgPrice: 8.4, side: 'SELL', ...over,
  })

  function mountBook(opts: { books: unknown[]; events: unknown[] }): SentRequest[] {
    window.localStorage.setItem('desk.mode', 'paper')
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/strategies') {
        return { body: { strategies: [row(TAG, { paper: { enabled: true } })] } }
      }
      if (path === '/v1/desk/books/registry') return { body: { books: opts.books } }
      if (path === '/v1/desk/reports/orders') {
        return { body: { date: '2026-07-29', events: opts.events } }
      }
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

  test('the log is asked for from the day the book was registered', async () => {
    const sent = mountBook({ books: [bookRow], events: [] })
    await waitFor(() => {
      expect(sent.some((r) => r.path === '/v1/desk/reports/orders' && r.url.includes('from=2026-07-10')))
        .toBe(true)
    })
    // The registry is what says this tag is a book at all — nothing else on
    // this page can tell one from an intraday strategy.
    expect(sent.some((r) => r.path === '/v1/desk/books/registry')).toBe(true)
  })

  test('a log running over days carries the DAY beside every time', async () => {
    mountBook({
      books: [bookRow],
      events: [
        event({ clientOrderId: 'roll', ts: at(29, 14, 7) }),
        event({ clientOrderId: 'open', ts: at(10, 10, 42), side: 'SELL' }),
      ],
    })
    // "10:42:00" alone is a lie about a fill three weeks old.
    await screen.findByText('10 Jul 10:42:00')
    expect(screen.getByText('29 Jul 14:07:00')).toBeTruthy()
    expect(screen.queryByText('10:42:00')).toBe(null)
  })

  test('the panel says the window it is showing, and so does an empty one', async () => {
    mountBook({ books: [bookRow], events: [] })
    // It used to read `<today> IST` under every log, which is a claim about the
    // window and was simply wrong for a book.
    await screen.findByText(/^2026-07-10 → \d{4}-\d{2}-\d{2} IST$/)
    await screen.findByText('No orders from this tag since it was opened on 2026-07-10.')
  })

  test('a tag with no book row keeps the single day it always had', async () => {
    // The registry answers, and this tag is not in it: nothing widens.
    const sent = mountBook({ books: [], events: [event({ ts: at(29, 14, 7) })] })
    await screen.findByText('14:07:00')
    await waitFor(() => {
      expect(sent.some((r) => r.path === '/v1/desk/books/registry')).toBe(true)
    })
    expect(sent.some((r) => r.url.includes('from='))).toBe(false)
    expect(screen.queryByText(/→/)).toBe(null)
  })
})

/**
 * THE DAY GUARD: a per-strategy daily target and stop-loss, set from here and
 * enforced in the bridge.
 *
 * What this page owes it is three things: the lines are editable, a live row
 * cannot have them changed without the password (because clearing a stop-loss
 * on a live strategy is the removal of the control that stops it), and a rail
 * the guard has already stopped SAYS SO — otherwise it is indistinguishable
 * from one an operator paused, and the two want opposite responses.
 */
describe('the day guard', () => {
  const guarded = (over: Record<string, unknown>): Record<string, unknown> => ({
    ...row('GUARDED', { paper: { enabled: true }, live: { enabled: false } }),
    ...over,
  })

  function mountRows(mode: 'paper' | 'live', rows: Record<string, unknown>[]): SentRequest[] {
    window.localStorage.setItem('desk.mode', mode)
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/strategies') return { body: { strategies: rows } }
      if (path === '/v1/desk/strategies/available') return { body: { available: [] } }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <StrategiesPage mode={mode} />
        </ModeProvider>
      </AuthProvider>,
    )
    return sent
  }

  const patches = (sent: SentRequest[]): SentRequest[] =>
    sent.filter((r) => r.method === 'PATCH' && r.path.startsWith('/v1/desk/strategies/'))

  async function openSettings(): Promise<void> {
    await screen.findByText('GUARDED')
    act(() => { screen.getAllByRole('button', { name: 'Settings' })[0]?.click() })
    await screen.findByText('GUARDED settings')
  }

  test('the armed lines are shown compactly, and an unarmed row says so', async () => {
    mountRows('paper', [
      guarded({ dailyLimits: { target: 10_000, stop: 3_000 } }),
      row('PLAIN', { paper: { enabled: true } }),
    ])
    // Both lines in one chip, direction carried by the arrows: up is the profit
    // that stops it, down is the loss that stops it.
    await screen.findByText('▲10k ▼3k')
    expect(screen.getAllByText('off').length).toBeGreaterThan(0)
  })

  test('a guard that FIRED today says which line, what the number was, and when', async () => {
    mountRows('paper', [
      guarded({
        modes: { paper: { enabled: false } },
        dailyLimits: { target: 10_000, stop: 3_000 },
        dayGuard: {
          fired: true,
          trigger: 'stop',
          pnlAtTrigger: -3_150,
          firedAt: new Date(2026, 7, 14, 11, 4, 31).getTime(),
          incomplete: false,
        },
      }),
    ])
    // The whole sentence, because the switch beside it being off is the thing
    // it explains. "Off" alone reads as an operator's own pause.
    await screen.findByText('guard: stop hit -₹3,150 at 11:04 — stopped for the day')
  })

  test('a guard that fired on REALISED alone admits the number understates it', async () => {
    mountRows('paper', [
      guarded({
        modes: { paper: { enabled: false } },
        dailyLimits: { stop: 3_000 },
        dayGuard: {
          fired: true, trigger: 'stop', pnlAtTrigger: -3_400,
          firedAt: new Date(2026, 7, 14, 11, 4, 31).getTime(), incomplete: true,
        },
      }),
    ])
    await screen.findByText(/realised only/)
  })

  test('the editor saves both lines, and only when they changed', async () => {
    const sent = mountRows('paper', [guarded({ dailyLimits: { target: 10_000, stop: 3_000 } })])
    await openSettings()

    // Save with nothing touched: the limits are NOT restated. On a live row
    // that would raise the password prompt for a change nobody made.
    act(() => { screen.getByRole('button', { name: 'Save' }).click() })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body).not.toHaveProperty('dailyLimits')

    await openSettings()
    fireEvent.change(screen.getByLabelText('Daily stop-loss (₹)'), { target: { value: '5000' } })
    act(() => { screen.getByRole('button', { name: 'Save' }).click() })
    await waitFor(() => expect(patches(sent)).toHaveLength(2))
    expect(patches(sent)[1]?.body).toMatchObject({ dailyLimits: { target: 10_000, stop: 5_000 } })
  })

  test('clearing both lines disarms the guard rather than storing a zero', async () => {
    // There is no daily target of zero — a book crosses zero on its first tick,
    // so a stored 0 is a guard that fires immediately and looks armed sensibly.
    const sent = mountRows('paper', [guarded({ dailyLimits: { target: 10_000 } })])
    await openSettings()
    fireEvent.change(screen.getByLabelText('Daily target (₹)'), { target: { value: '0' } })
    act(() => { screen.getByRole('button', { name: 'Save' }).click() })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body?.['dailyLimits']).toBe(null)
  })

  test('changing the guard on a LIVE row asks for the password FIRST', async () => {
    const sent = mountRows('live', [
      guarded({
        modes: { paper: { enabled: true }, live: { enabled: true } },
        dailyLimits: { stop: 3_000 },
      }),
    ])
    await openSettings()
    fireEvent.change(screen.getByLabelText('Daily stop-loss (₹)'), { target: { value: '50000' } })
    act(() => { screen.getByRole('button', { name: 'Save' }).click() })

    // Nothing has gone out. The prompt states what is being changed — not that
    // orders are about to start routing, which is not what is happening.
    expect(patches(sent)).toHaveLength(0)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/target and stop-loss that switch it off/)).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'hunter2' } })
    act(() => { within(dialog).getByRole('button', { name: 'Confirm' }).click() })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body).toMatchObject({
      dailyLimits: { stop: 50_000 },
      password: 'hunter2',
    })
  })

  test('a lot edit on a live row does NOT raise the guard prompt', async () => {
    // Prompting more widely than the server checks is what teaches an operator
    // to click through the dialog that matters.
    const sent = mountRows('live', [
      guarded({
        modes: { paper: { enabled: true }, live: { enabled: true } },
        dailyLimits: { stop: 3_000 },
      }),
    ])
    await openSettings()
    fireEvent.change(screen.getByLabelText('Live lots'), { target: { value: '4' } })
    act(() => { screen.getByRole('button', { name: 'Save' }).click() })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body).not.toHaveProperty('password')
  })
})

/**
 * THE ROW'S OWN SWITCH — the control an operator touches most, and the one that
 * had the least in front of it.
 *
 * Only live-ON was confirmed, by the password prompt. Live-OFF, paper-on and
 * paper-off were single unconfirmed clicks on a 44px target in a table of a
 * dozen identical-looking rows — and OFF IS NOT THE HARMLESS DIRECTION here: it
 * blocks the strategy's EXITS as well as its entries, so it strands whatever is
 * open rather than closing it. The bulk switch got a confirmation in both
 * directions for exactly that reason (`bulkStatement`); the per-row switch does
 * the same thing to one row, and now says the same sentence (audit F-51).
 *
 * The in-flight guard is the other half: a patch takes a round trip, the switch
 * stayed live throughout it, and a double click sent two.
 */
describe('the per-row switch', () => {
  const patches = (sent: SentRequest[]): SentRequest[] =>
    sent.filter((r) => r.method === 'PATCH' && r.path.startsWith('/v1/desk/strategies/'))

  const switchFor = (tag: string, mode: string): HTMLInputElement =>
    screen.getByRole('switch', { name: `Let ${tag} trade in ${mode}` }) as HTMLInputElement

  test('turning a row OFF asks first, in the bulk switch\'s own words', async () => {
    const sent = mount('paper')
    await screen.findByText('ORB_SCALP_BN')

    act(() => { fireEvent.click(switchFor('ORB_SCALP_BN', 'paper')) })
    // Nothing has gone out yet.
    expect(patches(sent)).toHaveLength(0)
    await screen.findByText('Turn ORB_SCALP_BN off in paper?')
    // THE SAME SENTENCE THE BULK SWITCH USES. One rule, stated once: two copies
    // of this warning would eventually disagree about what off does.
    await screen.findByText(/blocks its EXITS as well as its entries/i)

    const dialog = screen.getByRole('alertdialog')
    act(() => { within(dialog).getByRole('button', { name: 'Turn ORB_SCALP_BN off' }).click() })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body).toMatchObject({ modes: { paper: { enabled: false } } })
  })

  test('cancelling the confirmation leaves the strategy trading', async () => {
    const sent = mount('paper')
    await screen.findByText('ORB_SCALP_BN')
    act(() => { fireEvent.click(switchFor('ORB_SCALP_BN', 'paper')) })
    await screen.findByText('Turn ORB_SCALP_BN off in paper?')

    const dialog = screen.getByRole('alertdialog')
    act(() => { within(dialog).getByRole('button', { name: 'Cancel' }).click() })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBe(null))
    expect(patches(sent)).toHaveLength(0)
    // The switch reflects the SERVER's state, which nothing changed.
    expect(switchFor('ORB_SCALP_BN', 'paper').checked).toBe(true)
  })

  test('a LIVE row is confirmed off too — the rail is in the sentence', async () => {
    const sent = mount('live', (path, method) => (
      path === '/v1/desk/strategies' && method === 'GET'
        ? { body: { strategies: [row('ORB_SCALP_BN', { live: { enabled: true } })] } }
        : null
    ))
    await screen.findByText('ORB_SCALP_BN')
    act(() => { fireEvent.click(switchFor('ORB_SCALP_BN', 'live')) })
    expect(patches(sent)).toHaveLength(0)
    await screen.findByText('Turn ORB_SCALP_BN off in live?')
    await screen.findByText(/blocks its EXITS as well as its entries/i)
  })

  test('turning a PAPER row on is unchanged — the safe direction stays one click', async () => {
    const sent = mount('paper')
    await screen.findByText('ATR_BAND_NIFTY')
    act(() => { fireEvent.click(switchFor('ATR_BAND_NIFTY', 'paper')) })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(patches(sent)[0]?.body).toMatchObject({ modes: { paper: { enabled: true } } })
    expect(screen.queryByRole('alertdialog')).toBe(null)
  })

  test('a second click while the patch is in flight cannot send a second patch', async () => {
    /*
      A PATCH THAT NEVER ANSWERS, which is what a slow bridge looks like from
      the browser: `json()` awaits the body, so a promise here holds the request
      open for exactly as long as the test wants it held.
    */
    let release!: () => void
    const gate = new Promise<Record<string, unknown>>((r) => { release = () => r({}) })
    const sent = mount('paper', (path, method) => (
      method === 'PATCH' && path.startsWith('/v1/desk/strategies/') ? { body: gate } : null
    ))
    await screen.findByText('ATR_BAND_NIFTY')

    act(() => { fireEvent.click(switchFor('ATR_BAND_NIFTY', 'paper')) })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    expect(switchFor('ATR_BAND_NIFTY', 'paper').disabled).toBe(true)

    // The impatient second click, on a control that has not visibly moved yet.
    act(() => { fireEvent.click(switchFor('ATR_BAND_NIFTY', 'paper')) })
    expect(patches(sent)).toHaveLength(1)

    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(switchFor('ATR_BAND_NIFTY', 'paper').disabled).toBe(false))
  })

  test('one row settling does NOT re-enable another row still in flight', async () => {
    /*
      THE GUARD IS PER ROW, and the table has a dozen of them.

      A single "the tag being patched" holds only ONE tag: the second row's
      click overwrote it, so the first row's switch went live again while its
      own PATCH was still open — and the first answer to come back cleared the
      guard for every row, including the one still waiting. Both halves of the
      F-51 race were back, on any operator quick enough to touch two rows.
    */
    const gates = new Map<string, () => void>()
    const gateFor = (tag: string): Promise<Record<string, unknown>> =>
      new Promise((r) => { gates.set(tag, () => r({})) })
    const bothOff = [
      row('ONE_TAG', { paper: { enabled: false } }),
      row('TWO_TAG', { paper: { enabled: false } }),
    ]
    const sent = mount('paper', (path, method) => {
      if (path === '/v1/desk/strategies' && method === 'GET') return { body: { strategies: bothOff } }
      if (method === 'PATCH' && path.startsWith('/v1/desk/strategies/')) {
        return { body: gateFor(path.slice(path.lastIndexOf('/') + 1)) }
      }
      return null
    })
    await screen.findByText('ONE_TAG')

    act(() => { fireEvent.click(switchFor('ONE_TAG', 'paper')) })
    await waitFor(() => expect(patches(sent)).toHaveLength(1))
    act(() => { fireEvent.click(switchFor('TWO_TAG', 'paper')) })
    await waitFor(() => expect(patches(sent)).toHaveLength(2))

    // Two writes are open at once, and NEITHER control may be clicked again.
    expect(switchFor('ONE_TAG', 'paper').disabled).toBe(true)
    expect(switchFor('TWO_TAG', 'paper').disabled).toBe(true)

    // The first answers. Its own switch comes back — the other one has not
    // been answered yet, so it stays held.
    await act(async () => { gates.get('ONE_TAG')?.(); await Promise.resolve() })
    await waitFor(() => expect(switchFor('ONE_TAG', 'paper').disabled).toBe(false))
    expect(switchFor('TWO_TAG', 'paper').disabled).toBe(true)
    // ...and a click on it while it is held still sends nothing.
    act(() => { fireEvent.click(switchFor('TWO_TAG', 'paper')) })
    expect(patches(sent)).toHaveLength(2)

    await act(async () => { gates.get('TWO_TAG')?.(); await Promise.resolve() })
    await waitFor(() => expect(switchFor('TWO_TAG', 'paper').disabled).toBe(false))
  })
})
