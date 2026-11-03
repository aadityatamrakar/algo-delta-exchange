/**
 * The push socket on the page, and the thing it must never do: go quiet while
 * looking alive.
 *
 * A polling UI fails loudly — the request errors, a banner appears. A websocket
 * fails SILENTLY: it dies, no error fires, and the screen keeps showing the last
 * numbers it received. So the tests that matter here are about the FALLBACK —
 * that a closed socket puts the page back on 10-second polling and says so on
 * screen, and that the notice clears when the socket returns.
 *
 * The socket is stood in for rather than mocked away, so the hook's own
 * behaviour — subscribing by mode, re-fetching on a push, reconnecting — is
 * under test.
 */
import { expect, test, describe, vi, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { StrategyPage } from '../src/strategies.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { LiveFeedNotice, streamUrl, useStreamedPoll } from '../src/stream.tsx'
import { OrderLogTable } from '../src/orderlog.tsx'
import { api, type DeskMode } from '../src/api.ts'
import { installFetch, type SentRequest } from './http.tsx'
import { formatContract } from '../src/contract.ts'

// ------------------------------------------------------- the socket double

interface Sent {
  type?: string
  mode?: string
}

class FakeSocket {
  static readonly open: FakeSocket[] = []
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
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  // -- test drivers -------------------------------------------------------

  /** Connect and let the server acknowledge the subscription. */
  connect(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
    const subscribe = this.sent.at(-1)
    this.onmessage?.({
      data: JSON.stringify({ type: 'subscribed', mode: subscribe?.mode ?? 'paper' }),
    })
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** The socket dying underneath the page, with no action from it. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }
}

function installSocket(): typeof FakeSocket {
  FakeSocket.open.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
  return FakeSocket
}

const latest = (): FakeSocket => FakeSocket.open.at(-1) as FakeSocket

const EVENT = {
  clientOrderId: 'X-1',
  phase: 'FILL',
  ok: true,
  tag: 'ORB_SCALP_BN',
  tradingsymbol: 'BANKNIFTY26AUG52000CE',
  ts: 1_700_000_000_000,
  side: 'BUY',
  filledQty: 15,
  avgPrice: 131.5,
  status: 'COMPLETE',
  error: null,
  detail: null,
}

/**
 * A TAGLESS ORDER FEED — what the Orders page was, for the purposes of this file.
 *
 * The Orders page itself has been removed (it duplicated the books' own log and
 * the Broker tab's day-wise history). What it was doing HERE was standing in for
 * a `useStreamedPoll` consumer that renders order events and no P&L, which is
 * the only shape that subscribes with an empty tag list — the assertion two
 * describes below is entirely about that. The machinery is still in production
 * on the per-strategy log (see the last describe), so it keeps a harness rather
 * than losing the coverage with the page.
 */
function OrderFeed(props: { mode: DeskMode }): React.ReactElement {
  const { data, degraded } = useStreamedPoll(
    () => api.orders(props.mode, false), props.mode, [props.mode],
  )
  return (
    <>
      {degraded ? <LiveFeedNotice /> : null}
      <OrderLogTable events={data?.events ?? []} showOrderId />
    </>
  )
}

function mountOrders(mode: 'paper' | 'live' = 'paper'): SentRequest[] {
  window.localStorage.setItem('desk.mode', mode)
  const sent = installFetch(({ path }) =>
    path === '/v1/desk/orders' ? { body: { events: [EVENT] } } : { body: {} },
  )
  render(
    <ModeProvider>
      <OrderFeed mode={mode} />
    </ModeProvider>,
  )
  return sent
}

const orderCalls = (sent: readonly SentRequest[]): SentRequest[] =>
  sent.filter((r) => r.path === '/v1/desk/orders')

afterEach(() => {
  FakeSocket.open.length = 0
})

// -------------------------------------------------------------------- tests

describe('the fallback indicator', () => {
  test('a page whose socket has not connected is on polling, and SAYS SO', async () => {
    installSocket()
    mountOrders()

    // Before the handshake completes there is no live feed, and the page must
    // not imply there is one.
    expect(await screen.findByText('Live feed down — updating every 10s')).toBeTruthy()
    // …and it is still showing data: stale-but-labelled beats empty.
    expect(await screen.findByText('BANKNIFTY 52000 CE')).toBeTruthy()
  })

  test('the notice CLEARS when the socket comes up', async () => {
    installSocket()
    mountOrders()
    await screen.findByText('Live feed down — updating every 10s')

    await act(async () => {
      latest().connect()
    })

    await waitFor(() =>
      expect(screen.queryByText('Live feed down — updating every 10s')).toBeNull(),
    )
  })

  test('a socket that DIES puts the page back on polling and back into the notice', async () => {
    // The central failure this design exists to prevent: the socket goes, the
    // browser reports nothing, and the screen keeps showing numbers that look
    // live. Here it drops with no error at all — and the page still notices.
    installSocket()
    const sent = mountOrders()
    await act(async () => {
      latest().connect()
    })
    await waitFor(() =>
      expect(screen.queryByText('Live feed down — updating every 10s')).toBeNull(),
    )
    const before = orderCalls(sent).length

    await act(async () => {
      latest().drop()
    })

    expect(await screen.findByText('Live feed down — updating every 10s')).toBeTruthy()
    // And it is actually FETCHING again, not merely complaining: the fallback
    // is the polling, the banner is only how it is announced.
    await waitFor(() => expect(orderCalls(sent).length).toBeGreaterThan(before))
  })

  test('it reconnects in the background after a drop', async () => {
    vi.useFakeTimers()
    try {
      installSocket()
      mountOrders()
      await act(async () => {
        latest().connect()
      })
      const first = FakeSocket.open.length

      await act(async () => {
        latest().drop()
        // The backoff starts at 1s.
        vi.advanceTimersByTime(1200)
      })

      expect(FakeSocket.open.length).toBe(first + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what the socket carries', () => {
  test('it subscribes to the mode the page is showing, and to nothing else', async () => {
    installSocket()
    mountOrders('live')
    await waitFor(() => expect(FakeSocket.open.length).toBe(1))

    await act(async () => {
      latest().connect()
    })

    /*
      `tags: []` IS NOT `tags` ABSENT, and the difference is the point.

      A surface that renders order events and no P&L contributes NOTHING to
      the socket's tag union — and an explicitly empty list is how
      that is said. Absent would mean "every tag", which is what the old
      protocol always did and is exactly the waste the snapshot/delta work
      removed: a page with no P&L column pulling every strategy's marks.
    */
    expect(latest().sent).toEqual([{ type: 'subscribe', mode: 'live', tags: [] }])
    expect(latest().url).toBe(streamUrl())
  })

  test('a pushed event triggers a re-fetch — the socket says WHEN, REST says WHAT', async () => {
    installSocket()
    const sent = mountOrders()
    await act(async () => {
      latest().connect()
    })
    await waitFor(() => expect(orderCalls(sent).length).toBeGreaterThan(0))
    const before = orderCalls(sent).length

    await act(async () => {
      latest().push({ type: 'order', mode: 'paper', event: EVENT })
    })

    await waitFor(() => expect(orderCalls(sent).length).toBe(before + 1))
  })

  test("a frame for the OTHER rail is ignored even if the server sends one", async () => {
    installSocket()
    const sent = mountOrders('paper')
    await act(async () => {
      latest().connect()
    })
    await waitFor(() => expect(orderCalls(sent).length).toBeGreaterThan(0))
    const before = orderCalls(sent).length

    await act(async () => {
      latest().push({ type: 'order', mode: 'live', event: EVENT })
      // A heartbeat is not an event either: it proves the socket is alive, it
      // does not mean anything traded.
      latest().push({ type: 'heartbeat', ts: 1 })
      latest().push('not a frame at all')
    })

    expect(orderCalls(sent).length).toBe(before)
    // And none of it dropped the connection.
    expect(screen.queryByText('Live feed down — updating every 10s')).toBeNull()
  })

  test('a pushed P&L frame is NOT a nudge — it must not trigger a re-fetch', async () => {
    /**
     * P&L is MERGED, not re-fetched. Turning each flush into a REST request
     * would put the desk back where it started — the server coalesces at 250ms
     * precisely so the browser does not have to ask again.
     *
     * It must also not disconnect anything: a frame arriving four times a
     * second is exactly the shape of a bug that shows up as a page flapping
     * between live and degraded.
     */
    installSocket()
    const sent = mountOrders('paper')
    await act(async () => {
      latest().connect()
    })
    await waitFor(() => expect(orderCalls(sent).length).toBeGreaterThan(0))
    const before = orderCalls(sent).length

    await act(async () => {
      for (let i = 0; i < 50; i++) {
        latest().push({
          type: 'pnl-delta',
          mode: 'paper',
          rows: [],
          deltas: [{ tag: 'DESK_BHEL', unrealised: 300, total: 300 }],
        })
      }
    })

    expect(orderCalls(sent).length).toBe(before)
    expect(screen.queryByText('Live feed down — updating every 10s')).toBeNull()
  })

  test('an unmarked event renders as an em dash, never as 0', async () => {
    // The rule survives the wire: `stream.ts` pushes null for a PLANNED event
    // that has no fill, and a 0 in the price column is a claim about a fill that
    // did not happen — which is why the whole field is nullable.
    installSocket()
    window.localStorage.setItem('desk.mode', 'paper')
    installFetch(({ path }) =>
      path === '/v1/desk/orders'
        ? {
            body: {
              events: [
                { ...EVENT, phase: 'PLANNED', side: null, filledQty: null, avgPrice: null },
              ],
            },
          }
        : { body: {} },
    )
    render(
      <ModeProvider>
        <OrderFeed mode="paper" />
      </ModeProvider>,
    )

    /*
      ANCHORED ON THE CONTRACT, NOT ON THE PHASE.

      This used to find the row by its "PLANNED" badge, which lived in a `Phase`
      column that has since been deleted — it read FILL on every row of a paper
      session, and its one informative case folded into `Status`. The assertion
      this test exists to make is about the PRICE and QTY cells, so it anchors on
      something that identifies the row rather than on a neighbouring badge.
    */
    const row = (await screen.findByText(formatContract(EVENT.tradingsymbol))).closest('tr') as HTMLElement
    const cells = [...row.querySelectorAll('td')].map((c) => c.textContent)
    expect(cells).toContain('—')
    expect(cells).not.toContain('0')
  })
})

/**
 * THE SECOND SURFACE ON THE SOCKET.
 *
 * The per-strategy order log polled at 8s while the Orders page was already
 * being pushed to — so the same fill appeared on one screen instantly and on
 * the other up to eight seconds later. These pin that it is genuinely wired,
 * because an order log that quietly kept polling would look identical until
 * someone timed it.
 */
describe('the strategy page order log', () => {
  const ORDER = { ...EVENT, tag: 'ORB_SCALP_BN' }

  function mountStrategy(): SentRequest[] {
    window.localStorage.setItem('desk.mode', 'paper')
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/reports/orders') {
        return { body: { date: '2026-07-28', events: [ORDER] } }
      }
      if (path === '/v1/desk/pnl') {
        return { body: { mode: 'paper', strategies: [], totals: { realised: 0, unrealised: 0, total: 0, complete: true } } }
      }
      if (path === '/v1/desk/strategies') return { body: { strategies: [] } }
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

  const orderCallsFor = (sent: readonly SentRequest[]): SentRequest[] =>
    sent.filter((r) => r.path === '/v1/desk/reports/orders')

  test('a pushed fill re-fetches the log instead of waiting for the next poll', async () => {
    installSocket()
    const sent = mountStrategy()
    await act(async () => {
      latest().connect()
    })
    await waitFor(() => expect(orderCallsFor(sent).length).toBeGreaterThan(0))
    const before = orderCallsFor(sent).length

    await act(async () => {
      latest().push({ type: 'order', mode: 'paper', event: ORDER })
    })

    await waitFor(() => expect(orderCallsFor(sent).length).toBe(before + 1))
  })

  test('a dead socket says so here too, rather than looking live', async () => {
    installSocket()
    mountStrategy()
    await act(async () => {
      latest().connect()
    })
    await waitFor(() =>
      expect(screen.queryByText('Live feed down — updating every 10s')).toBeNull(),
    )

    await act(async () => {
      latest().drop()
    })

    expect(await screen.findByText('Live feed down — updating every 10s')).toBeTruthy()
  })
})
