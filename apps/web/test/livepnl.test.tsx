/**
 * The P&L push, as an operator sees it: snapshot, then deltas, on ONE socket.
 *
 * THE TEST THIS FILE EXISTS FOR is `a leg that LOSES its mark shows an em dash`.
 * In a delta an omitted field means UNCHANGED and an explicit `null` means the
 * feed can no longer price that leg, and those are opposite claims. Collapse
 * them and a leg whose quote died keeps displaying its last known price as
 * though it were live — a calm, confident, wrong number beside real risk, which
 * is the single most dangerous thing this UI can render. Both directions are
 * asserted here: a field going null, and a field simply not being sent.
 *
 * The other two are structural. ONE SOCKET PER TAB: every hook used to open its
 * own, and the server refuses past 50 clients with a 503, so a few tabs would
 * have started degrading real users. And the TAG UNION: a page showing one
 * strategy must not pull the whole desk, but a shared socket must still widen to
 * everything the moment a consumer that renders everything mounts alongside it.
 */
import { expect, test, describe, vi, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { BookTabsPage } from '../src/pages.tsx'
import { StrategyPage } from '../src/strategies.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { installFetch } from './http.tsx'
import { formatContract } from '../src/contract.ts'

// ------------------------------------------------------- the socket double

interface Sent {
  type?: string
  mode?: string
  tags?: string[]
}

class FakeSocket {
  static readonly open: FakeSocket[] = []
  static closed = 0
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readonly url: string
  readonly sent: Sent[] = []
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeSocket.open.push(this)
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Sent)
  }

  close(): void {
    if (this.readyState !== FakeSocket.CLOSED) FakeSocket.closed++
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  connect(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'subscribed', mode: this.sent.at(-1)?.mode ?? 'paper' }) })
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  drop(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
}

function installSocket(): void {
  FakeSocket.open.length = 0
  FakeSocket.closed = 0
  vi.stubGlobal('WebSocket', FakeSocket)
}

const latest = (): FakeSocket => FakeSocket.open.at(-1) as FakeSocket

afterEach(() => {
  FakeSocket.open.length = 0
  FakeSocket.closed = 0
})

// ------------------------------------------------------------- the fixture

const CE = 'BHEL26AUG420CE'
const PE = 'BHEL26AUG400PE'

/** One leg, complete — the shape `pnlRowFor` puts on the wire. */
function leg(tradingsymbol: string, mark: number | null, unrealised: number | null, mtm: number | null): Record<string, unknown> {
  return {
    tradingsymbol,
    qty: -100,
    avgCost: 15,
    mark,
    unrealised,
    realised: 0,
    buyQty: 0,
    buyValue: 0,
    sellQty: 100,
    sellValue: 1500,
    mtm,
  }
}

const ROW = {
  tag: 'DESK_BHEL',
  label: 'BHEL short strangle',
  mode: 'paper',
  realised: 0,
  unrealised: 300,
  total: 300,
  openLegs: 2,
  legs: [leg(CE, 12, 300, 300), leg(PE, 9, 200, 200)],
  unpriced: [],
  complete: true,
}

const PNL_BODY = {
  mode: 'paper',
  strategies: [ROW],
  totals: { realised: 0, unrealised: 500, total: 500, complete: true },
}

function installPnlFetch(): void {
  installFetch(({ path }) => {
    if (path === '/v1/desk/pnl') return { body: PNL_BODY }
    if (path === '/v1/desk/strategies') return { body: { strategies: [] } }
    if (path === '/v1/desk/reports/orders') return { body: { date: '2026-07-28', events: [] } }
    if (path === '/v1/desk/books') return { body: { books: [] } }
    return { body: {} }
  })
}

function mountStrategy(mode: 'paper' | 'live' = 'paper'): void {
  window.localStorage.setItem('desk.mode', mode)
  installPnlFetch()
  render(
    <AuthProvider>
      <ModeProvider>
        <StrategyPage tag="DESK_BHEL" mode={mode} />
      </ModeProvider>
    </AuthProvider>,
  )
}

/**
 * The cells of the row naming `symbol`, as text.
 *
 * LOOKED UP BY THE RENDERED NAME, not the raw tradingsymbol. The tables show
 * `formatContract(...)` — `BHEL26AUG420CE` renders as `BHEL 420 CE` — and this
 * helper searched for the packing, so every row lookup in this file failed the
 * moment that formatting shipped. Deriving the display name through the same
 * function the cell uses keeps the two from drifting again.
 */
function cellsFor(symbol: string): string[] {
  const row = (screen.getByText(formatContract(symbol)).closest('tr') as HTMLElement)
  return [...row.querySelectorAll('td')].map((c) => c.textContent ?? '')
}

// ------------------------------------------------------- one socket per tab

describe('one socket per tab', () => {
  test('several streamed consumers on one page share EXACTLY ONE socket', async () => {
    /**
     * The Positions page (`BookTabsPage`) mounts `PnlCards` and `OpenLegs`, and the strategy page
     * mounts a streamed order log beside streamed P&L. Before the shared
     * connection each of those opened its own — four or five per tab, each with
     * its own subscribe, heartbeat and reconnect backoff, against a server that
     * refuses past 50 clients with a 503.
     */
    installSocket()
    window.localStorage.setItem('desk.mode', 'live')
    installFetch(({ path }) => {
      if (path === '/v1/desk/pnl') return { body: { ...PNL_BODY, mode: 'live' } }
      if (path === '/v1/desk/books') return { body: { books: [] } }
      return { body: {} }
    })
    const view = render(
      <AuthProvider>
        <ModeProvider>
          {/* Two P&L consumers (cards + open legs) and the page's own polls. */}
          <BookTabsPage mode="live" tag={null} onSelect={() => {}} />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(FakeSocket.open.length).toBeGreaterThan(0))
    await act(async () => {
      latest().connect()
    })

    expect(FakeSocket.open.length).toBe(1)

    // …and the last consumer leaving takes it down, rather than leaving a
    // socket open against the server's client cap for a page nobody is on.
    await act(async () => {
      view.unmount()
    })
    expect(FakeSocket.closed).toBe(1)
  })

  test('a one-tag consumer asks for one tag; a whole-desk consumer widens the union', async () => {
    installSocket()
    window.localStorage.setItem('desk.mode', 'paper')
    installPnlFetch()

    const strategy = render(
      <AuthProvider>
        <ModeProvider>
          <StrategyPage tag="DESK_BHEL" mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))
    await act(async () => {
      latest().connect()
    })
    // The strategy page renders ONE strategy, so it asks for one tag — not the
    // whole desk, which is what the REST call still fetches.
    await waitFor(() => expect(latest().sent.at(-1)?.tags).toEqual(['DESK_BHEL']))

    // A consumer that renders every strategy mounts alongside it on the SAME
    // socket. The union has to widen to everything, or the cards would render
    // stale figures for every tag but one.
    const positions = render(
      <ModeProvider>
        <BookTabsPage mode="paper" tag={null} onSelect={() => {}} />
      </ModeProvider>,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(FakeSocket.open.length).toBe(1)
    // `tags` ABSENT is how "every tag" is said on the wire.
    expect(latest().sent.at(-1)).toEqual({ type: 'subscribe', mode: 'paper' })

    // …and it narrows back when the whole-desk consumer goes.
    await act(async () => {
      positions.unmount()
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(latest().sent.at(-1)?.tags).toEqual(['DESK_BHEL'])
    strategy.unmount()
  })
})

// ------------------------------------------------- snapshot, then deltas

describe('snapshot then delta', () => {
  test('the snapshot puts the server-computed row on screen', async () => {
    installSocket()
    mountStrategy()
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))
    await act(async () => {
      latest().connect()
      latest().push({ type: 'pnl-snapshot', mode: 'paper', rows: [ROW] })
    })

    await waitFor(() => expect(cellsFor(CE)).toContain('12.00'))
  })

  test('a delta MOVES the LTP without a re-fetch, and leaves everything else alone', async () => {
    installSocket()
    mountStrategy()
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))
    await act(async () => {
      latest().connect()
      latest().push({ type: 'pnl-snapshot', mode: 'paper', rows: [ROW] })
    })
    await waitFor(() => expect(cellsFor(CE)).toContain('12.00'))

    await act(async () => {
      latest().push({
        type: 'pnl-delta',
        mode: 'paper',
        rows: [],
        // ONLY the CE moved. The PE is not mentioned at all.
        deltas: [{ tag: 'DESK_BHEL', unrealised: 500, total: 500, legs: [{ tradingsymbol: CE, mark: 10, unrealised: 500, mtm: 500 }] }],
      })
    })

    await waitFor(() => expect(cellsFor(CE)).toContain('10.00'))
    /*
      THE OTHER HALF OF THE RULE: an omitted field is UNCHANGED, not unknown.
      The PE was in no delta, so it must still show the price the snapshot gave
      it — a leg blanked to an em-dash because nobody mentioned it would report
      a dead feed that is perfectly alive.
    */
    expect(cellsFor(PE)).toContain('9.00')
    // And a field the tick cannot move is carried through, not resent and not
    // lost: the sell average is derived from `sellValue`/`sellQty`, which no
    // delta ever mentions, and it is still on the row.
    expect(cellsFor(CE)).toContain('15.00')
  })

  test('a leg that LOSES its mark shows an em dash, NEVER its last price', async () => {
    /**
     * THE DANGEROUS CASE. An explicit `null` in a delta means the feed can no
     * longer price this leg. If it were read as "absent" — i.e. unchanged — the
     * row would keep showing ₹12.00 against a position whose value is genuinely
     * unknown, and nothing on screen would say otherwise.
     */
    installSocket()
    mountStrategy()
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))
    await act(async () => {
      latest().connect()
      latest().push({ type: 'pnl-snapshot', mode: 'paper', rows: [ROW] })
    })
    await waitFor(() => expect(cellsFor(CE)).toContain('12.00'))

    await act(async () => {
      latest().push({
        type: 'pnl-delta',
        mode: 'paper',
        rows: [],
        deltas: [{
          tag: 'DESK_BHEL',
          unrealised: null,
          total: null,
          complete: false,
          unpriced: [CE],
          legs: [{ tradingsymbol: CE, mark: null, unrealised: null, mtm: null }],
        }],
      })
    })

    await waitFor(() => expect(cellsFor(CE)).not.toContain('12.00'))
    const cells = cellsFor(CE)
    expect(cells).toContain('—')
    // Never a confident zero in place of an unknown.
    expect(cells).not.toContain('0.00')
    // The row says WHICH leg is holding the total back, not merely "partial".
    expect(await screen.findByText(`Cannot mark: ${CE} — the total is unknown, not zero.`)).toBeTruthy()
    // The PE never lost its mark and must not have been blanked with it.
    expect(cellsFor(PE)).toContain('9.00')
  })

  test('a dead socket drops the merged numbers rather than leaving them looking live', async () => {
    installSocket()
    mountStrategy()
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))
    await act(async () => {
      latest().connect()
      latest().push({ type: 'pnl-snapshot', mode: 'paper', rows: [ROW] })
      latest().push({
        type: 'pnl-delta',
        mode: 'paper',
        rows: [],
        deltas: [{ tag: 'DESK_BHEL', legs: [{ tradingsymbol: CE, mark: 10 }] }],
      })
    })
    await waitFor(() => expect(cellsFor(CE)).toContain('10.00'))

    await act(async () => {
      latest().drop()
    })

    // Back to what REST says, which is the last thing anything vouched for…
    await waitFor(() => expect(cellsFor(CE)).toContain('12.00'))
    // …and the page says it is on polling rather than implying a live feed.
    expect(await screen.findByText('Live feed down — updating every 10s')).toBeTruthy()
  })

  test('a delta for the OTHER rail is ignored even if the server sends one', async () => {
    installSocket()
    mountStrategy('paper')
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))
    await act(async () => {
      latest().connect()
      latest().push({ type: 'pnl-snapshot', mode: 'paper', rows: [ROW] })
    })
    await waitFor(() => expect(cellsFor(CE)).toContain('12.00'))

    await act(async () => {
      latest().push({
        type: 'pnl-delta',
        mode: 'live',
        rows: [],
        deltas: [{ tag: 'DESK_BHEL', legs: [{ tradingsymbol: CE, mark: 999 }] }],
      })
    })

    // Real money under a PAPER badge is the most expensive thing this dashboard
    // could do. The server filters per socket; this is the second check.
    expect(cellsFor(CE)).toContain('12.00')
  })

  test('a delta for a tag the page has no base for is dropped, not half-applied', async () => {
    installSocket()
    mountStrategy()
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))
    await act(async () => {
      latest().connect()
      latest().push({ type: 'pnl-snapshot', mode: 'paper', rows: [ROW] })
      // A tag that first traded after this socket's snapshot. It has no qty and
      // no entry price here, so a row built from it would be a position nothing
      // traded. REST brings the whole row within a poll.
      latest().push({
        type: 'pnl-delta',
        mode: 'paper',
        rows: [],
        deltas: [{ tag: 'BRAND_NEW', unrealised: 900, total: 900 }],
      })
    })

    await waitFor(() => expect(cellsFor(CE)).toContain('12.00'))
    expect(screen.queryByText('BRAND_NEW')).toBeNull()
  })
})

/**
 * THE FREEZE. Shipped to production and reported within minutes as "positions
 * was updating but now stuck", with the socket demonstrably still delivering
 * deltas — 48 of them in 12 seconds, verified against the live server.
 *
 * A delta carries only what moved, so `applyDelta` needs a base row and ignores
 * one it has none for. The only thing that ever created a base was the
 * `pnl-snapshot`, sent ONCE on subscribe. The REST backstop then CLEARED the
 * overlay on every poll — which did not merely discard drift, it destroyed the
 * base every later delta needed. So the page updated from the snapshot until
 * the first poll landed and was pure 15s REST from then on, for the life of the
 * tab.
 *
 * The backstop now RE-SEEDS from the response instead of clearing it: REST stays
 * authoritative for every field, and the deltas after it still have something to
 * land on.
 */
describe('the REST backstop and the delta base', () => {
  test('a delta STILL lands after a REST poll has re-based the overlay', async () => {
    /*
      THE PRODUCTION FREEZE, reproduced. Reported minutes after deploy as
      "positions was updating but now stuck", with the socket demonstrably still
      delivering — 48 deltas in 12s, measured against the live server.

      A delta carries only what moved, so it needs a base row to fold into and is
      IGNORED when there is none. The REST backstop used to CLEAR the overlay on
      every poll, which did not merely discard drift — it destroyed that base. The
      page updated until the first poll landed and was pure 15s REST for the rest
      of the tab's life.

      The fetch double must hand back a FRESH body per call, as `res.json()` does.
      `installPnlFetch` returns one frozen object, so `polled.data` never changes
      identity, the re-base effect fires once, and this defect is unreachable —
      the first version of this test passed against the bug for exactly that
      reason.
    */
    vi.useFakeTimers()
    try {
      installSocket()
      window.localStorage.setItem('desk.mode', 'paper')
      installFetch(({ path }) => {
        if (path === '/v1/desk/pnl') return { body: structuredClone(PNL_BODY) }
        if (path === '/v1/desk/strategies') return { body: { strategies: [] } }
        if (path === '/v1/desk/reports/orders') return { body: { date: '2026-07-28', events: [] } }
        if (path === '/v1/desk/books') return { body: { books: [] } }
        return { body: {} }
      })
      render(
        <AuthProvider>
          <ModeProvider>
            <StrategyPage tag="DESK_BHEL" mode="paper" />
          </ModeProvider>
        </AuthProvider>,
      )
      await vi.advanceTimersByTimeAsync(0)
      await act(async () => {
        latest().connect()
      })
      // Let the poll that connecting re-triggers land and re-base the overlay.
      // This is the moment that used to destroy the base.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(cellsFor(CE)).toContain('12.00')

      await act(async () => {
        latest().push({
          type: 'pnl-delta',
          mode: 'paper',
          rows: [],
          deltas: [{ tag: 'DESK_BHEL', unrealised: 700, total: 700, legs: [{ tradingsymbol: CE, mark: 7, unrealised: 700, mtm: 700 }] }],
        })
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(cellsFor(CE)).toContain('7.00')
    } finally {
      vi.useRealTimers()
    }
  })
})
