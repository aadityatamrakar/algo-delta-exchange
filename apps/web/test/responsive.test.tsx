/**
 * The parts of the mobile pass a DOM can actually answer.
 *
 * WHAT IS NOT HERE, AND WHY. jsdom does not do layout and does not evaluate
 * media queries: `matchMedia` is a stub in test/setup.tsx that answers `false`
 * to everything, and nothing in this environment has a width. So a test that
 * claimed "the navbar collapses below 1024px" or "the P&L cards fall to one
 * column on a phone" would be asserting the assertion, not the behaviour —
 * those are verified in a browser.
 *
 * What IS testable is the structure the CSS acts on, and it is worth pinning
 * because it is a contract split across two files: responsive.css hides
 * `.desk-nav-wide` and shows `.desk-nav-compact`, and nothing but a test
 * notices when one side of that pair is renamed. Likewise the drawer's own
 * behaviour — that it holds no links until it is opened, that choosing one
 * closes it, and that the paper/live switch is NOT in it — is plain DOM.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, test, describe } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { App, WIDE_NAV } from '../src/App.tsx'
import { PHONE } from '../src/shell.tsx'
import { OrderLogTable } from '../src/orderlog.tsx'
import { PnlCards } from '../src/pnl.tsx'
import { StrategiesPage, StrategyPage } from '../src/strategies.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch } from './http.tsx'

/** The stylesheets, read once, so a class contract can be checked end to end. */
const css = (file: string): string =>
  readFileSync(resolve(process.cwd(), 'src', file), 'utf8')

/**
 * Answer `true` to the phone query and `false` to every other one.
 *
 * THIS IS NOT A TEST OF A MEDIA QUERY — jsdom has no width and cannot evaluate
 * one. It is a test of what the COMPONENT does with the answer, which is a
 * different thing and is the part that lives in this repo: below the phone
 * breakpoint the strategies table is replaced by cards, and that swap is
 * ordinary React that a DOM can read. The breakpoint number itself is pinned
 * against the stylesheet separately, below.
 */
let restoreMatchMedia: (() => void) | null = null

function pretendPhone(): void {
  const real = window.matchMedia
  restoreMatchMedia = () => { window.matchMedia = real }
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
}

afterEach(() => {
  restoreMatchMedia?.()
  restoreMatchMedia = null
})

/** A signed-in desk with nothing on it — the shell is what these tests read. */
function deskFetch(): void {
  installFetch(({ path }) => {
    if (path === '/v1/auth/me') {
      return { body: { username: 'aaditya', kind: 'user', expiresAt: Date.now() + 3_600_000 } }
    }
    if (path === '/v1/desk/books') return { body: { books: [] } }
    if (path === '/v1/desk/pnl') return { body: { strategies: [], totals: { complete: true } } }
    return { body: {} }
  })
}

/** Renders the whole shell and waits for the auth gate to let it through. */
async function desk(): Promise<void> {
  deskFetch()
  render(<App themeMode="light" onThemeMode={() => {}} />)
  await waitFor(() => expect(screen.getByText('SMPv2')).toBeTruthy())
}

const openDrawer = (): void => {
  act(() => { screen.getByRole('button', { name: 'Menu' }).click() })
}

describe('the compact navigation', () => {
  test('there is no drawer in the document until it is opened', async () => {
    await desk()

    // One "Positions" in the document: the wide navbar's. A drawer left mounted
    // and merely hidden by CSS would be invisible in a browser and very much
    // present to anything reading the DOM — a second copy of every nav link.
    expect(screen.queryByRole('dialog', { name: 'Desk navigation' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Positions' })).toHaveLength(1)

    openDrawer()

    const drawer = screen.getByRole('dialog', { name: 'Desk navigation' })
    // 'Status' is where 'Feed' and 'Brokers' went — one page, plus a report on
    // every process, which neither of them ever carried.
    for (const label of ['Positions', 'Strategies', 'Books', 'Reports', 'Broker', 'Status', 'Controls']) {
      expect(within(drawer).getByRole('button', { name: label })).toBeTruthy()
    }
  })

  test('the drawer carries the same list as the bar — no Build, no Orders', async () => {
    await desk()

    // The drawer maps the SAME list as the wide bar. It was a second `ROUTES`
    // map, so a route dropped from one and not the other left the tab alive on
    // exactly the widths nobody develops at.
    expect(screen.queryByRole('button', { name: 'Build' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Orders' })).toBeNull()

    openDrawer()

    const drawer = screen.getByRole('dialog', { name: 'Desk navigation' })
    // Build is reached from the Books page; Orders is gone, aliased onto Status.
    expect(within(drawer).queryByRole('button', { name: 'Build' })).toBeNull()
    expect(within(drawer).queryByRole('button', { name: 'Orders' })).toBeNull()
  })

  test('choosing a page navigates and closes the drawer behind it', async () => {
    await desk()
    openDrawer()

    const drawer = screen.getByRole('dialog', { name: 'Desk navigation' })
    act(() => { within(drawer).getByRole('button', { name: 'Controls' }).click() })

    expect(window.location.hash).toBe('#/controls')
    // A drawer left open over the page it just navigated to is a modal covering
    // the answer.
    expect(screen.queryByRole('dialog', { name: 'Desk navigation' })).toBeNull()
  })

  test('the paper/live switch stays in the bar and is never inside the drawer', async () => {
    await desk()

    // Reachable before anything is opened…
    expect(screen.getByRole('button', { name: 'LIVE' })).toBeTruthy()

    openDrawer()
    const drawer = screen.getByRole('dialog', { name: 'Desk navigation' })
    // …and not duplicated into the drawer, where deciding which book you are
    // looking at would cost a tap on a Menu button first.
    expect(within(drawer).queryByRole('button', { name: 'LIVE' })).toBeNull()
    expect(within(drawer).queryByRole('button', { name: 'PAPER' })).toBeNull()
  })

  test('the two halves of the bar carry the classes responsive.css switches on', async () => {
    await desk()

    // This is the contract between App.tsx and responsive.css. Renaming either
    // side alone leaves a navbar that renders both halves at every width — on a
    // phone, eight controls in a row that cannot fit — and nothing else fails.
    const menu = screen.getByRole('button', { name: 'Menu' })
    expect(menu.className).toContain('desk-nav-compact')
    expect(document.querySelectorAll('.desk-nav-wide').length).toBeGreaterThan(0)
  })
})

// --------------------------------------------------- the strategies table

const STRATEGY = {
  tag: 'ORB_SCALP_BN', kind: 'hosted', label: 'ORB scalp on Bank Nifty',
  modes: { paper: { enabled: true } }, liveLots: 1, autostartAt: '', lastSeenAt: 0,
  disabledReason: null, updatedAt: 0,
  runtime: { state: 'running', startedAt: null, lastError: null, openPositions: 2 },
}

/** The strategies page at phone width, with one row on it. */
async function phoneStrategies(): Promise<void> {
  pretendPhone()
  window.localStorage.setItem('desk.mode', 'paper')
  installFetch(({ path }) => (
    path === '/v1/desk/strategies' ? { body: { strategies: [STRATEGY] } } : { body: {} }
  ))
  render(
    <AuthProvider>
      <ModeProvider>
        <StrategiesPage mode="paper" />
      </ModeProvider>
    </AuthProvider>,
  )
  await screen.findByText('ORB_SCALP_BN')
}

describe('the strategies page on a phone', () => {
  test('the table is replaced by cards — not rendered alongside them', async () => {
    await phoneStrategies()

    // Seven columns of which one is 240px of buttons do not fit in 390px. The
    // table is GONE rather than hidden, and that is the point: a row carries a
    // Switch that arms live trading, and a second invisible copy of it is a
    // duplicate nothing reading the DOM can tell from the real one.
    expect(document.querySelector('table')).toBeNull()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'Let ORB_SCALP_BN trade in paper' })).toBeTruthy()

    // The card still says everything the row's other columns said.
    expect(screen.getByText('ORB scalp on Bank Nifty')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.getByText(/Autostart at boot/)).toBeTruthy()
  })

  test('Settings, Flatten and Remove are menu items behind one control', async () => {
    await phoneStrategies()

    // As three loose ghost buttons these were three indistinguishable targets
    // under a thumb with the DELETE on the end. None of them is a button any
    // more…
    for (const label of ['Settings', 'Flatten', 'Remove']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }

    // …they are rows of one menu, which is named after the strategy it acts on
    // so fifteen cards do not announce fifteen identical "⋯" buttons.
    const trigger = screen.getByRole('button', { name: 'Actions for ORB_SCALP_BN' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    act(() => { trigger.click() })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    const menu = screen.getByRole('menu', { name: 'Actions for ORB_SCALP_BN' })
    for (const label of ['Settings', 'Flatten', 'Remove']) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeTruthy()
    }
  })

  test('Remove from the menu raises the same confirmation the desk does', async () => {
    await phoneStrategies()
    const trigger = screen.getByRole('button', { name: 'Actions for ORB_SCALP_BN' })
    act(() => { trigger.click() })

    const menu = screen.getByRole('menu', { name: 'Actions for ORB_SCALP_BN' })
    act(() => { within(menu).getByRole('menuitem', { name: 'Remove' }).click() })

    // The card must not be a shortcut PAST a confirmation: it is a DELETE with
    // no undo, and the phone is where a mis-tap is likeliest.
    await screen.findByText('Remove ORB_SCALP_BN from the paper table?')
  })
})

// ------------------------------------------------ the strategy page header

describe('the strategy page header', () => {
  test('carries the classes that stop "Settings" breaking into "Se/tti/ngs"', async () => {
    installFetch(({ path }) => (
      path === '/v1/desk/strategies' ? { body: { strategies: [STRATEGY] } } : { body: {} }
    ))
    render(
      <AuthProvider>
        <ModeProvider>
          <StrategyPage tag="ORB_SCALP_BN" mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
    await screen.findByText('ORB scalp on Bank Nifty')

    // A contract split across two files, exactly like `.desk-nav-wide`: the
    // markup names these and responsive.css is the only thing that reads them.
    // Rename one side alone and the header silently goes back to one nowrap row
    // wider than the phone, with the squeeze landing on the button's label.
    const sheet = css('responsive.css')
    for (const cls of ['desk-strategy-headline', 'desk-strategy-label', 'desk-strategy-settings']) {
      expect(document.querySelectorAll(`.${cls}`).length).toBeGreaterThan(0)
      expect(sheet).toContain(`.${cls}`)
    }
    // The description is the element allowed to take its own line, so it has to
    // be the one carrying the class — not, say, the runtime badge beside it.
    expect(document.querySelector('.desk-strategy-label')?.textContent)
      .toBe('ORB scalp on Bank Nifty')
  })
})

// ------------------------------------------------------------- P&L pills

describe('a P&L pill', () => {
  test('carries the direction class comfort.css tints, and null is never green', async () => {
    installFetch(({ path }) => {
      if (path !== '/v1/desk/pnl') return { body: {} }
      const leg = {
        tradingsymbol: 'SENSEX26JUL77200CE', qty: -20, avgCost: 100, mark: null,
        unrealised: null, realised: 0, buyQty: 0, buyValue: 0, sellQty: 20,
        sellValue: 2000, mtm: null,
      }
      return {
        body: {
          mode: 'paper',
          strategies: [
            { tag: 'UP', label: 'up', mode: 'paper', realised: 500, unrealised: 0,
              total: 500, openLegs: 0, legs: [], unpriced: [], complete: true },
            { tag: 'DOWN', label: 'down', mode: 'paper', realised: -500, unrealised: 0,
              total: -500, openLegs: 0, legs: [], unpriced: [], complete: true },
            { tag: 'UNKNOWN', label: 'unknown', mode: 'paper', realised: 0, unrealised: null,
              total: null, openLegs: 1, legs: [leg], unpriced: [leg.tradingsymbol],
              complete: false },
          ],
          totals: { realised: 0, unrealised: null, total: null, complete: false },
        },
      }
    })
    render(<ModeProvider><PnlCards mode="paper" /></ModeProvider>)
    await screen.findByText('UP')

    // The class is how the pill asks comfort.css for a readable tint: the
    // design system's own `--color-background-green` is a 20% wash that all but
    // disappears against a card, and a variant is the only thing the component
    // can ask a Card for.
    const sheet = css('comfort.css')
    for (const tint of ['green', 'red', 'gray']) {
      expect(sheet).toContain(`.pnl-pill-${tint}`)
    }
    // Stretching the anchor is what closes the gaps between pills — astryx's
    // Link is inline-flex, so each pill hugged its text at the left of a track
    // three times its width.
    expect(sheet).toContain('.pnl-pill {')

    const pill = (tag: string): Element => {
      const el = screen.getByText(tag).closest('a')
      if (el === null) throw new Error(`no pill for ${tag}`)
      return el
    }
    expect(pill('UP').className).toContain('pnl-pill-green')
    expect(pill('DOWN').className).toContain('pnl-pill-red')
    // A TOTAL WE DO NOT HAVE IS NEVER TINTED. Green would assert a profit and
    // red a loss; the colour IS the claim on these cards, and the figure beside
    // it is an em dash for the same reason.
    expect(pill('UNKNOWN').className).toContain('pnl-pill-gray')
    expect(pill('UNKNOWN').textContent).toContain('—')
    expect(pill('UNKNOWN').textContent).not.toContain('0')
  })
})

describe('the breakpoint itself', () => {
  test('the phone breakpoint is one number, written in two files', () => {
    // Same reasoning as the navbar's below: shell.tsx swaps the strategies
    // table for cards at this width and responsive.css re-pads the page at it,
    // and CSS cannot read a TypeScript constant. If they drift there is a band
    // of widths showing phone cards with desk padding, or the reverse.
    const px = Number(PHONE.match(/(\d+)px/)?.[1])
    expect(px).toBeGreaterThan(0)
    expect(css('responsive.css')).toContain(`@media (max-width: ${px}px)`)
  })

  test('App.tsx and responsive.css name the same width', () => {
    // The number lives twice — once in the media query that hides the Menu
    // button and once in the query App.tsx watches to close the drawer when the
    // window is widened — because CSS cannot read a TypeScript constant. Move
    // one and the drawer becomes unclosable at exactly the widths between them.
    // Resolved off the runner's cwd, which vitest sets to this workspace. NOT
    // `import.meta.url`: under jsdom that is an `http://localhost` URL and
    // `readFileSync` rejects it.
    const sheet = css('responsive.css')
    const px = Number(WIDE_NAV.match(/(\d+)px/)?.[1])
    expect(px).toBeGreaterThan(0)
    expect(sheet).toContain(`@media (min-width: ${px}px)`)
    expect(sheet).toContain(`@media (max-width: ${px - 1}px)`)
  })
})

describe('a wide table', () => {
  test('scrolls inside its own container rather than moving the page', () => {
    // WAS MOUNTED THROUGH THE ORDERS PAGE, which has been removed. The table is
    // the thing this test is about and it is unchanged: `OrderLogTable` is still
    // rendered by the per-strategy log, at every width.
    const { container } = render(<OrderLogTable events={[]} showOrderId />)

    // The order log's columns add up to ~960px, so at any phone width it has to
    // scroll. `overflow-x: auto` on this wrapper is what makes that a swipe over
    // the table instead of the whole document sliding sideways; the wrapper's
    // presence is the part a DOM can check.
    const wrapper = container.querySelector('.astryx-table-scroll-wrapper')
    expect(wrapper).not.toBeNull()
  })
})
