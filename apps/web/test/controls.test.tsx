/**
 * Controls: the halt, and the button that gets you flat.
 *
 * Both of the failures pinned here are of the same kind — a dangerous state
 * that renders as a calm one. "No books are open" when the list simply failed
 * to load, and "1 fills" for a close-all that skipped three legs and could not
 * route two more.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { ControlsPage } from '../src/pages.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type Reply, type SentRequest } from './http.tsx'

const KILL_OFF = { enabled: false, reason: '', setBy: '', setAt: 0 }
const LINK_CONNECTED = {
  desired: 'connected', reason: '', setBy: '', setAt: 0,
  applied: 'connected', appliedAt: 1_756_700_000_000, appliedError: '',
}

function mount(
  mode: 'paper' | 'live',
  handler: (path: string, method: string) => Reply | null,
): SentRequest[] {
  window.localStorage.setItem('desk.mode', mode)
  const sent = installFetch(({ path, method }) => {
    const custom = handler(path, method)
    if (custom !== null) return custom
    if (path === '/v1/desk/killswitch') return { body: KILL_OFF }
    if (path === '/v1/desk/broker-link') return { body: LINK_CONNECTED }
    return { body: {} }
  })
  render(
    <AuthProvider>
      <ModeProvider>
        <ControlsPage mode={mode} />
      </ModeProvider>
    </AuthProvider>,
  )
  return sent
}

const books = (...symbols: string[]): Reply => ({
  body: {
    books: symbols.map((symbol) => ({
      symbol, tag: `${symbol}-VAR1`, legs: 2, netDelta: 10, complete: true, updatedAt: 1,
    })),
  },
})

describe('controls', () => {
  test('a failed book list is never rendered as an empty desk', async () => {
    mount('paper', (path) =>
      path === '/v1/desk/books' ? { status: 503, body: { error: 'mongo is down' } } : null)

    await screen.findByText('The list of open books could not be read')
    // THE WORST FALSE NEGATIVE THIS PAGE CAN PRODUCE: in the emergency the
    // button exists for, telling the operator there is nothing to close.
    expect(screen.queryByText('No paper books are open.')).toBe(null)
  })

  test('an empty desk still says so', async () => {
    mount('paper', (path) => (path === '/v1/desk/books' ? books() : null))
    await screen.findByText('No paper books are open.')
  })

  test('the kill switch says it is global, and names both rails', async () => {
    mount('live', () => null)
    await screen.findByText('Kill switch')
    // It has no mode — `safety.ts` stores one flag — and it sits on a page
    // under a mode rule, so an operator halting "paper" would in fact halt live
    // too. Saying so is the whole fix.
    await screen.findByText(/Global — it halts both rails/)
    expect(screen.getByRole('button', { name: 'Engage kill switch — both rails' })).toBeTruthy()
  })

  test('the live execution card says what pausing does, and a pause posts the wish without a password', async () => {
    let link: Record<string, unknown> = LINK_CONNECTED
    const sent = mount('paper', (path, method) => {
      if (path === '/v1/desk/broker-link' && method === 'POST') {
        link = { ...LINK_CONNECTED, desired: 'released', reason: 'paused from dashboard', setBy: 'aaditya', setAt: 5 }
        return { body: link }
      }
      if (path === '/v1/desk/broker-link') return { body: link }
      return null
    })
    await screen.findByText('Live execution')
    await screen.findByText(/Pausing stops every live order to Delta/)
    await screen.findByText(/Orders already resting at Delta are not cancelled/)
    expect(screen.queryByText(/XTS|Zerodha/)).toBe(null)
    const pause = await screen.findByRole('button', { name: 'Pause live execution — Delta' })
    act(() => { pause.click() })

    await waitFor(() => {
      const post = sent.find((r) => r.path === '/v1/desk/broker-link' && r.method === 'POST')
      expect(post?.body).toEqual({ desired: 'released', reason: 'paused from dashboard' })
    })
    await screen.findByText(/Live execution PAUSED — every live order, exits included, is refused/)
    await screen.findByText('PAUSED')
    await screen.findByText(/Paused by/)
    await screen.findByRole('button', { name: 'Resume live execution' })
  })

  test('a running desk reads as on, with no gateway-ack line', async () => {
    mount('live', (path) => (path === '/v1/desk/broker-link' ? { body: LINK_CONNECTED } : null))
    await screen.findByText('on')
    expect(screen.queryByText(/Paused by/)).toBe(null)
    expect(screen.queryByText(/logged (in|out)|reconnect/i)).toBe(null)
  })

  test('a partly failed close-all is reported as a failure, in detail', async () => {
    mount('paper', (path, method) => {
      if (path === '/v1/desk/books') return books('BHEL')
      if (path === '/v1/desk/close-all' && method === 'POST') {
        return {
          body: {
            decisionId: 'ui-close-BHEL-1', replayed: false, status: 'FAILED',
            fills: [{ op: 'close', deskTag: 'L1', tradingsymbol: 'BHEL24JUL240CE', side: 'Buy', qty: 1, price: 3, ts: 1 }],
            skips: [{ action: { op: 'close', ts: 'L2' }, reason: 'no mark' }],
            routeErrors: [{ fill: { tradingsymbol: 'BHEL24JUL250PE', ts: 2 }, error: 'RMS: blocked' }],
            book: [{ deskTag: 'L2', instrument: { tradingsymbol: 'BHEL24JUL250PE' }, qty: -1 }],
            unpriceable: ['BHEL24JUL250PE'],
          },
        }
      }
      return null
    })

    await screen.findByRole('button', { name: 'Close all — fast (aggressive limit), paper' })
    act(() => { screen.getByRole('button', { name: 'Close all — fast (aggressive limit), paper' }).click() })

    // It used to render "Close-all BHEL (fast): 1 fills" — a success line for a
    // book that is still open, because the client type dropped every field
    // carrying the evidence.
    await screen.findByText(/did NOT fully close the book/)
    await screen.findByText(/skipped L2: no mark/)
    await screen.findByText(/BHEL24JUL250PE did not route: RMS: blocked/)
    await screen.findByText(/Still open: BHEL24JUL250PE/)
  })

  test('a clean close-all says flat', async () => {
    mount('paper', (path, method) => {
      if (path === '/v1/desk/books') return books('BHEL')
      if (path === '/v1/desk/close-all' && method === 'POST') {
        return {
          body: {
            decisionId: 'd', replayed: false, status: 'DONE',
            fills: [{ tradingsymbol: 'X', ts: 1 }], skips: [], routeErrors: [], book: [],
            unpriceable: [],
          },
        }
      }
      return null
    })

    await screen.findByRole('button', { name: 'Close all — limit, paper' })
    act(() => { screen.getByRole('button', { name: 'Close all — limit, paper' }).click() })
    await screen.findByText('Close-all BHEL (limit): flat')
  })

  test('the close-all buttons name the rail they act on', async () => {
    const sent = mount('live', (path) => (path === '/v1/desk/books' ? books('BHEL') : null))
    await screen.findByRole('button', { name: 'Close all — fast (aggressive limit), live' })
    await waitFor(() =>
      expect(sent.some((r) => r.url.includes('/v1/desk/books?mode=live'))).toBe(true))
  })
})
