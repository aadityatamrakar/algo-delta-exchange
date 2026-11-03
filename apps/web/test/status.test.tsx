/**
 * The Status page — three sections that used to be two tabs and a blind spot.
 *
 * What is worth testing here is not the layout but the three properties the
 * merge could silently break:
 *
 *   1. All three sections are actually on the page. Feed and Brokers were two
 *      separate screens with their own tests; folding them in must not quietly
 *      drop one, and a missing section on a status page reads as "nothing to
 *      report" rather than as an absence.
 *   2. The page states the SERVER's verdict and does no arithmetic of its own.
 *      A stale component has to show amber and the age the server measured.
 *   3. The Brokers section still WRITES. It is the only section here with a
 *      button that does something, and "Test connection" performing a real
 *      login is the whole reason that screen exists.
 *
 * Plus the routing: the nav offers Status and no longer offers Feed or Brokers,
 * and the two old hashes still land somewhere real.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { StatusPage } from '../src/status.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { ROUTES, useHashRoute } from '../src/shell.tsx'
import { installFetch, type SentRequest } from './http.tsx'

const NOW = 1_760_000_000_000

const component = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'desk-runner',
  name: 'Strategy runner',
  state: 'ok',
  detail: '12 running, 3 waiting · 4 open positions',
  lastSeenMs: NOW - 900,
  ageMs: 900,
  expectedEveryMs: 1_000,
  ...over,
})

const SYSTEM = {
  generatedAt: NOW,
  components: [
    component({ id: 'desk-api', name: 'Bridge API', detail: 'up 1h 2m · bus connected', ageMs: 0, expectedEveryMs: null }),
    component({
      id: 'desk-marketdata',
      name: 'Market data',
      detail: '2 of 2 sockets connected · 900 tokens · instruments synced 2026-10-09',
      ageMs: 3_000,
      expectedEveryMs: 10_000,
    }),
    component(),
  ],
}

const FEED = {
  feedAlive: true, marksHeld: 61, subscribedTokens: 72, coverage: 0.847,
  msSinceLastTick: 1200, bookCount: 2, booksIncomplete: 0, ready: true,
}

const DELTA_ROW = {
  kind: 'delta',
  label: 'Delta live',
  meta: { baseUrl: 'https://api.india.delta.exchange' },
  configured: true,
  state: 'ok',
  lastVerifiedAt: 1_700_000_000_000,
  lastError: null,
}

/** Two operator actions and one the DESK took, which is the pair that matters. */
const AUDIT = {
  entries: [
    {
      at: NOW - 30_000,
      principal: 'aaditya',
      principalKind: 'user',
      source: '/v1/desk/killswitch',
      action: 'ENGAGED the kill switch',
      detail: { enabled: true, reason: 'feed is wrong' },
    },
    {
      at: NOW - 900_000,
      principal: 'day-guard',
      principalKind: 'system',
      source: 'day-guard',
      action: 'STOPPED a rail on its daily stop-loss',
      tag: 'BN_BREAKOUT',
      mode: 'paper',
      detail: { trigger: 'stop', pnlAtTrigger: -3100 },
    },
  ],
}

/**
 * REFUSALS, stamped against the REAL clock.
 *
 * The failures section is bounded to the IST calendar day, so a fixture pinned
 * to `NOW` (October 2025) would be filtered out on every run after the day it
 * was written and the section would test nothing. Offsets from `Date.now()`
 * keep "today" true whenever the suite happens to run; IST has no daylight
 * saving, so exactly 24h back is always the previous IST day.
 */
const TODAY = Date.now()
const YESTERDAY = TODAY - 24 * 60 * 60_000

const FAILURES = {
  events: [
    {
      clientOrderId: 'D-7', phase: 'REFUSED', ok: false,
      tag: 'BHEL-2026-08-25-recenter-r-2',
      tradingsymbol: 'BHEL26AUG410PE',
      ts: TODAY - 120_000,
      error: 'freeze limit: 1,800 exceeds the exchange cap of 900 per order',
    },
    {
      clientOrderId: 'D-8', phase: 'STATUS', ok: false,
      tag: 'ORB_SCALP_BN',
      tradingsymbol: 'BANKNIFTY26AUG52000CE',
      ts: TODAY - 300_000,
      status: 'REJECTED',
      error: 'RMS: margin shortfall',
    },
  ],
}

function mount(over: {
  system?: unknown
  audit?: unknown
  failures?: unknown
  failuresStatus?: number
} = {}): SentRequest[] {
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/desk/system') return { body: over.system ?? SYSTEM }
    if (path === '/v1/desk/feed') return { body: FEED }
    if (path.startsWith('/v1/desk/audit')) return { body: over.audit ?? AUDIT }
    if (path === '/v1/desk/orders') {
      return over.failuresStatus === undefined
        ? { body: over.failures ?? FAILURES }
        : { status: over.failuresStatus, body: { error: 'the journal is unreadable' } }
    }
    if (path === '/v1/desk/brokers' && method === 'GET') return { body: { brokers: [DELTA_ROW] } }
    if (path === '/v1/desk/brokers/delta/test') return { body: { ok: true, verifiedAt: NOW } }
    return { body: {} }
  })
  render(<ModeProvider><StatusPage /></ModeProvider>)
  return sent
}

describe('the status page', () => {
  test('renders all three sections — systems, feed and brokers', async () => {
    mount()
    // Systems: the section that did not exist before.
    await screen.findByText('Systems')
    expect(screen.getByText('Strategy runner')).toBeTruthy()
    expect(screen.getByText('Bridge API')).toBeTruthy()
    // Feed: moved, not rewritten. Headed "Feed" rather than "Market data", so
    // it is not confused with the systems card of that name directly above —
    // one is the process, the other is what the process publishes.
    expect(await screen.findByText('Feed')).toBeTruthy()
    expect(await screen.findByText('Readiness')).toBeTruthy()
    expect(screen.getByText('Market data')).toBeTruthy()
    // Brokers: same.
    expect(await screen.findByText('Brokers')).toBeTruthy()
    expect(await screen.findByText('Delta live')).toBeTruthy()
  })

  test('it asks each section its own endpoint', async () => {
    const sent = mount()
    await screen.findByText('Delta live')
    const gets = new Set(sent.filter((r) => r.method === 'GET').map((r) => r.path))
    expect(gets.has('/v1/desk/system')).toBe(true)
    expect(gets.has('/v1/desk/feed')).toBe(true)
    expect(gets.has('/v1/desk/brokers')).toBe(true)
    expect(gets.has('/v1/desk/orders')).toBe(true)
  })

  test('a component names the pm2 process it is about', async () => {
    // What is on screen and what an operator would type into `pm2 restart` have
    // to be the same string, or the page is a riddle.
    mount()
    expect(await screen.findByText('desk-marketdata')).toBeTruthy()
    expect(screen.getByText('desk-runner')).toBeTruthy()
  })

  test('the cadence is printed beside the age, so the age can be read', async () => {
    mount()
    await screen.findByText('Systems')
    // "3s ago" means nothing on its own: fine for a 10s publisher, three missed
    // polls for a 1s one.
    expect(screen.getByText(/last seen 3s ago · expected every 10s/)).toBeTruthy()
  })
})

describe('a component that has stopped writing', () => {
  test('shows amber and the age the SERVER measured', async () => {
    mount({
      system: {
        generatedAt: NOW,
        components: [
          component({
            id: 'desk-runner',
            state: 'stale',
            detail: '1 running · 0 open positions',
            ageMs: 240_000,
            lastSeenMs: NOW - 240_000,
          }),
        ],
      },
    })
    await screen.findByText('Systems')
    // Amber, not red: outside a session several of these are quiet for honest
    // reasons, and this page must not claim a fault it cannot see.
    expect(screen.getByText('stale')).toBeTruthy()
    // The age is the server's `ageMs`, rendered — not recomputed here from
    // `lastSeenMs` and the browser's clock, which would disagree on any laptop
    // whose clock has drifted.
    expect(screen.getByText(/last seen 4m ago/)).toBeTruthy()
    // And it is named once at the top, so a long grid does not have to be scanned.
    expect(screen.getByText(/1 of 1 components have not written recently/)).toBeTruthy()
  })

  /**
   * `attention` IS NOT `stale`, AND THE WORD IS THE WHOLE POINT.
   *
   * On 2026-08-15 the positions comparison reported `17 DIVERGENT` under a green
   * `ok` pill, because every state on this page was a statement about AGE and
   * the report was thirty seconds old. Calling it `stale` would have swapped one
   * false claim for another — the job had not stopped writing, it was writing
   * exactly on time and telling the operator something. So the badge carries its
   * own word, and the headline says "need attention" rather than "have not
   * written recently".
   */
  test('a CURRENT component reporting a problem says "attention", never "stale"', async () => {
    mount({
      system: {
        generatedAt: NOW,
        components: [
          component({
            id: 'positions-truth',
            name: 'Positions truth',
            state: 'attention',
            detail: '17 DIVERGENT (BHEL26AUG375PE, BHEL26AUG400PE) · 17 desk contracts compared to the broker',
            ageMs: 30_000,
            lastSeenMs: NOW - 30_000,
            expectedEveryMs: 300_000,
          }),
        ],
      },
    })
    await screen.findByText('Systems')
    expect(screen.getByText('attention')).toBeTruthy()
    expect(screen.queryByText('stale')).toBe(null)
    // The headline is the state's own claim, not the staleness one.
    expect(screen.getByText(/1 of 1 components need attention/)).toBeTruthy()
    expect(screen.queryByText(/have not written recently/)).toBe(null)
    // And the age is reported unchanged: the report IS current, which is the
    // fact that makes its content worth acting on.
    expect(screen.getByText(/last seen 30s ago/)).toBeTruthy()
  })

  test('unknown is grey and is NOT counted as a fault', async () => {
    /**
     * A gateway in simulate mode writes no snapshot at all, and a rail with no
     * books has no supervisor report to make. Both are healthy desks. Painting
     * them amber — or counting them in the headline — is how amber stops
     * meaning anything.
     */
    mount({
      system: {
        generatedAt: NOW,
        components: [
          component({ id: 'desk-gateway', name: 'Order gateway', state: 'unknown', lastSeenMs: null, ageMs: null, detail: 'no broker snapshot — simulate mode writes none' }),
        ],
      },
    })
    await screen.findByText('Systems')
    expect(screen.getByText('unknown')).toBeTruthy()
    expect(screen.queryByText(/have not written recently/)).toBe(null)
    // "never seen", not "0s ago": nothing has been seen, which is the whole
    // distinction the unknown state carries.
    expect(screen.getByText(/never seen/)).toBeTruthy()
  })
})

describe('the brokers section still writes', () => {
  test('Test connection fires its POST', async () => {
    const sent = mount()
    await screen.findByText('Delta live')
    const button = screen.getAllByRole('button', { name: 'Test connection' })[0]
    expect(button).toBeTruthy()
    act(() => { button?.click() })
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/v1/desk/brokers/delta/test')).toBe(true))
    // And the verdict comes back onto the page, as it did on its own screen.
    expect(await screen.findByText('Login succeeded')).toBeTruthy()
  })
})

describe('recent operator actions', () => {
  test('the section lists who did what, and which book', async () => {
    mount()
    await screen.findByText('Recent operator actions')
    expect(screen.getByText('ENGAGED the kill switch')).toBeTruthy()
    expect(screen.getByText('aaditya')).toBeTruthy()
    // The tag is what turns "somebody stopped something" into an answer.
    // The cell carries the rail beside the tag ("BN_BREAKOUT · paper"), which
    // is one text node — the book and the rail are one answer, not two.
    expect(screen.getByText(/BN_BREAKOUT · paper/)).toBeTruthy()
  })

  test("the DAY GUARD's own stop is on the same list, named as the desk", async () => {
    // A rail that is off tomorrow morning was switched off by SOMEBODY, and the
    // whole point of the list is that "the desk did it" and "a person did it"
    // are distinguishable at a glance.
    mount()
    await screen.findByText('Recent operator actions')
    expect(screen.getByText('day-guard')).toBeTruthy()
    expect(screen.getByText(/STOPPED a rail on its daily stop-loss/)).toBeTruthy()
  })

  test('it asks the audit endpoint with a bounded limit', async () => {
    const sent = mount()
    await screen.findByText('Recent operator actions')
    // `path` is the pathname alone; the query string is on `url`.
    const asked = sent.find((r) => r.path.startsWith('/v1/desk/audit'))
    expect(asked).toBeTruthy()
    expect(asked?.url).toMatch(/limit=\d+/)
  })

  test('an empty log says so rather than rendering an empty box', async () => {
    // A desk that has recorded nothing yet and one whose audit read failed must
    // not look identical — and neither must look like "nothing has happened".
    mount({ audit: { entries: [] } })
    await screen.findByText('Recent operator actions')
    expect(screen.getByText(/no operator actions recorded/i)).toBeTruthy()
  })
})

/**
 * ORDER FAILURES — the safety net the Orders page's removal took with it.
 *
 * The removal's own notes claimed refusals stayed visible "via Status and the
 * audit log". Neither was true: the audit log records what an OPERATOR did to
 * the bridge and deliberately excludes the order path, the Broker page shows
 * only what REACHED the broker, and the per-strategy log is tag-scoped — so a
 * gateway refusal on a book nobody had opened was on no screen at all. That is
 * a live freeze-limit, kill-switch or risk-limit rejection, invisible.
 *
 * IT IS MODE-SCOPED, like the page it replaces. A paper refusal under LIVE is
 * the exact bug the deleted page was fixed for on 2026-07-28, and Status is the
 * only remaining page that reads the navbar switch and can honour it.
 */
describe('order failures', () => {
  test('a refusal nobody would otherwise see is on the page', async () => {
    mount()
    await screen.findByText('Order failures')
    // The broker's own sentence — the only thing on the row that says why
    // nothing traded. `getAllByText`: the reason is wrapped in a `title` span
    // carrying the untruncated text, so the cell matches at two depths.
    expect(screen.getAllByText(/freeze limit/).length).toBeGreaterThan(0)
    // Whose book it was, and which contract: without the tag the operator does
    // not know which strategy is silently not trading.
    expect(screen.getByText('BHEL-2026-08-25-recenter-r-2')).toBeTruthy()
    expect(screen.getByText('BHEL26AUG410PE')).toBeTruthy()
    expect(screen.getAllByText(/RMS: margin shortfall/).length).toBeGreaterThan(0)
    expect(screen.getByText('ORB_SCALP_BN')).toBeTruthy()
  })

  test('it asks for FAILURES ONLY, in the mode the navbar is showing', async () => {
    const sent = mount()
    await screen.findByText('Order failures')
    const asked = sent.find((r) => r.path === '/v1/desk/orders')
    expect(asked?.url).toContain('failures=1')
    // Paper is the default a browser that has never set the switch lands on.
    expect(asked?.url).toContain('mode=paper')
  })

  test('the LIVE switch asks the live rail', async () => {
    // Unscoped, this section would show a paper rejection to an operator
    // watching live — which is the defect the deleted page was fixed for.
    window.localStorage.setItem('desk.mode', 'live')
    const sent = mount()
    await screen.findByText('Order failures')
    expect(sent.find((r) => r.path === '/v1/desk/orders')?.url).toContain('mode=live')
  })

  test("YESTERDAY's refusal is not today's problem", async () => {
    // The journal is not date-bounded server-side, so a book that failed on
    // Friday would still be shouting on Monday morning and the section would
    // stop being read.
    mount({
      failures: {
        events: [
          {
            clientOrderId: 'D-1', phase: 'REFUSED', ok: false, tag: 'OLD_TAG',
            tradingsymbol: 'BHEL26AUG410PE', ts: YESTERDAY,
            error: 'yesterday: kill switch engaged',
          },
        ],
      },
    })
    await screen.findByText('Order failures')
    expect(screen.queryByText(/yesterday: kill switch engaged/)).toBe(null)
    expect(screen.getByText(/no order failures today/i)).toBeTruthy()
  })

  test('a clean day says so, rather than rendering an empty box', async () => {
    mount({ failures: { events: [] } })
    await screen.findByText('Order failures')
    expect(screen.getByText(/no order failures today/i)).toBeTruthy()
  })

  test('an unreadable journal does not blank the rest of the page', async () => {
    // Every other section on Status survives its own endpoint failing, and this
    // one carries the extra duty of never letting "the read failed" pass as
    // "nothing failed".
    mount({ failuresStatus: 500 })
    await screen.findByText('Order failures')
    expect(await screen.findByText(/could not read the order journal/i)).toBeTruthy()
    // Silence is NOT a clean day.
    expect(screen.queryByText(/no order failures today/i)).toBe(null)
    // And the sections either side still render.
    expect(await screen.findByText('Systems')).toBeTruthy()
    expect(await screen.findByText('Delta live')).toBeTruthy()
  })
})

describe('the navigation', () => {
  test('offers Status, and no longer offers Feed or Brokers', () => {
    const labels = ROUTES.map((r) => r.label)
    expect(labels).toContain('Status')
    expect(labels).not.toContain('Feed')
    expect(labels).not.toContain('Brokers')
    // 'Broker' (singular — the broker's own order book) is a DIFFERENT page and
    // was not part of the merge.
    expect(labels).toContain('Broker')
  })

  test('the old hashes still land on Status rather than 404ing to Positions', () => {
    // An unmatched head falls through to `positions`, so dropping these would
    // silently land a bookmarked operator on the book screen with no
    // explanation. They are aliases, not deletions.
    for (const hash of ['#/feed', '#/brokers']) {
      window.location.hash = hash
      const { result } = renderHook(() => useHashRoute())
      expect(result.current[0].route).toBe('status')
    }
  })

  test('#/broker is untouched by the merge', () => {
    window.location.hash = '#/broker'
    const { result } = renderHook(() => useHashRoute())
    expect(result.current[0].route).toBe('broker')
  })

  test('an old hash is rewritten in the address bar', async () => {
    // The same rule every legacy hash follows: a URL that still says "feed"
    // beside a page titled Status is two claims, one of them stale.
    window.location.hash = '#/brokers'
    renderHook(() => useHashRoute())
    await waitFor(() => expect(window.location.hash).toBe('#/status'))
  })
})
