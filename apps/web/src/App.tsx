/**
 * SMPv2 dashboard shell — top navigation, the global paper/live switch, session,
 * theme.
 *
 * FOUR THINGS ARE DELIBERATE:
 *
 *  - The auth gate wraps the ROUTER, not each page. A page added later cannot
 *    forget to be protected, because nothing under the gate is rendered without
 *    a session at all.
 *  - ONE mode switch lives here and nowhere else. Every page below reads it and
 *    renders only that mode; none carries a control of its own. The 3px rule
 *    directly under this bar is what replaces "which page am I on" as the
 *    answer to "am I looking at real money?" — it is a persistent frame rather
 *    than a banner precisely because a banner is something you learn to dismiss.
 *  - Within Positions, stocks are TABS rather than a list you click through.
 *    With a handful of symbols, tabs show every book at once and land you in
 *    one, instead of putting a navigation step before the thing you came to see.
 *  - BELOW 1024px THE NAV LINKS MOVE INTO A DRAWER, and the paper/live switch
 *    does NOT go with them. See `NavDrawer` below.
 *
 * `ModeProvider` sits OUTSIDE the gate so the switch is one object for the whole
 * session: a re-mount after signing back in must not reset it to paper while the
 * operator's last choice is still in `localStorage`.
 */

import { useEffect, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Heading } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { Divider } from '@astryxdesign/core/Divider'
import { MobileNav } from '@astryxdesign/core/MobileNav'
import { NAV_ROUTES, useHashRoute, modeLabel, nextMode, type Route, type ThemeMode } from './shell.tsx'
import { ModeProvider, ModeRule, ModeSwitch, useMode } from './mode.tsx'
import { PageBoundary } from './boundary.tsx'
import { BookTabsPage, ControlsPage } from './pages.tsx'
import { AuthGate, AuthProvider, useAuth } from './auth.tsx'
import { StatusPage } from './status.tsx'
import { BrokerViewPage } from './broker-view.tsx'
import { StrategiesPage, StrategyPage } from './strategies.tsx'
import { BooksPage } from './books.tsx'
import { BookBuildPage } from './book-build.tsx'
import { ReportsPage } from './reports.tsx'

/**
 * The width at and above which the whole navbar fits on one row.
 *
 * MEASURED, NOT ROUND. "SMPv2" plus seven links plus the paper/live switch plus
 * the theme cycle plus a named sign-out come to roughly 1140px, so the row
 * overflows on a 1024-wide laptop, not only on a phone. Kept as a string
 * constant because the same number is written once more, in responsive.css,
 * and the two must not drift — CSS cannot read a JS constant, so the comment
 * on each side names the other.
 */
export const WIDE_NAV = '(min-width: 1024px)'

export function App(props: {
  themeMode: ThemeMode
  onThemeMode: (m: ThemeMode) => void
}): React.ReactElement {
  return (
    <ModeProvider>
      <AuthProvider>
        <AuthGate>
          <Desk themeMode={props.themeMode} onThemeMode={props.onThemeMode} />
        </AuthGate>
      </AuthProvider>
    </ModeProvider>
  )
}

/**
 * The nav links, the theme cycle and sign-out, in a slide-out drawer.
 *
 * IT MAPS `NAV_ROUTES`, the same list the bar does, so a route added to or
 * dropped from one cannot be missing from the other — which would leave a tab
 * alive at exactly the widths nobody develops at.
 *
 * IT IS MOUNTED ONLY WHILE IT IS OPEN, and that is a deliberate choice over
 * leaving it mounted and letting CSS hide it. astryx hides the closed drawer
 * with `display: none`, which is genuinely invisible — but it would leave a
 * SECOND "Positions" button, a second "SMPv2" and a close button in the
 * document at all times, so anything reading the DOM (a test, a stale
 * accessibility tree, a text search) would find two of everything the navbar
 * has. Nothing is lost by unmounting: the slide-in transition does not play in
 * either arrangement, because the drawer goes from `display: none` to
 * `display: flex` in the same paint as the transform and browsers do not
 * transition across a display change.
 *
 * THE PAPER/LIVE SWITCH IS NOT IN HERE. It decides what every page below shows
 * and it is the thing the red rule is explaining; putting it two taps away
 * behind a Menu button would make "am I looking at real money?" a question you
 * have to open a drawer to answer. It stays in the bar at every width.
 */
function NavDrawer(props: {
  onClose: () => void
  route: Route
  go: (r: Route) => void
  themeMode: ThemeMode
  onThemeMode: (m: ThemeMode) => void
  username: string | null
  onSignOut: () => void
}): React.ReactElement {
  return (
    <MobileNav
      isOpen
      // Backdrop click and Escape both arrive here; the drawer never re-opens
      // itself, so anything but a close is a no-op.
      onOpenChange={(open) => { if (!open) props.onClose() }}
      header="SMPv2"
      side="start"
      label="Desk navigation"
    >
      <VStack gap={1}>
        {NAV_ROUTES.map((r) => (
          <Button
            key={r.id}
            className="desk-drawer-link"
            variant={props.route === r.id ? 'primary' : 'ghost'}
            label={r.label}
            // Choosing a page closes the drawer. A drawer left open over the
            // page it just navigated to is a modal covering the answer.
            onClick={() => { props.go(r.id); props.onClose() }}
          />
        ))}
        <Divider />
        <Button
          className="desk-drawer-link"
          variant="ghost"
          label={`Theme: ${modeLabel(props.themeMode)}`}
          onClick={() => props.onThemeMode(nextMode(props.themeMode))}
        />
        {/* Named, so it is obvious WHOSE session is about to place orders. */}
        <Button
          className="desk-drawer-link"
          variant="ghost"
          label={`Sign out${props.username === null ? '' : ` (${props.username})`}`}
          onClick={props.onSignOut}
        />
      </VStack>
    </MobileNav>
  )
}

function Desk(props: {
  themeMode: ThemeMode
  onThemeMode: (m: ThemeMode) => void
}): React.ReactElement {
  const [loc, go, selectTag] = useHashRoute()
  const { session, signOut } = useAuth()
  const mode = useMode()
  const [navOpen, setNavOpen] = useState(false)

  /**
   * THE DRAWER CLOSES ITSELF WHEN THE VIEWPORT GROWS PAST THE MENU BUTTON.
   *
   * The Menu button is hidden by a media query at 1024px, and so is the drawer's
   * own close button along with the rest of the compact bar. Open the drawer at
   * phone width — a rotation, or a desktop window dragged wider — and without
   * this the operator is left with a modal `<dialog>` covering the desk and no
   * visible way out of it but a reload. A layout query is the only thing that
   * can notice, so it is the only thing in this file that listens to one.
   */
  useEffect(() => {
    if (!navOpen) return
    const mq = window.matchMedia(WIDE_NAV)
    const close = (): void => { if (mq.matches) setNavOpen(false) }
    close()
    mq.addEventListener('change', close)
    return () => mq.removeEventListener('change', close)
  }, [navOpen])

  return (
    <VStack gap={0}>
      <VStack gap={0}>
        {/*
          `wrap` IS THE SAFETY NET, NOT THE PLAN. Between 1024px and the ~1140px
          the full row needs, the bar wraps onto two lines rather than pushing
          sign-out off the edge — the drawer takes over below that. A bar that
          can wrap cannot overflow at any width in between, which is the
          property worth having; which of the two it does at 1100px is not.
        */}
        <HStack gap={4} align="center" justify="between" padding={4} wrap="wrap" className="desk-topbar">
          {/* The two halves are named so responsive.css can tighten their gaps
              on a phone without reaching through `.desk-topbar > *`, which
              would also catch anything added to the bar later. */}
          <HStack gap={4} align="center" className="desk-topbar-left">
            <Heading level={3}>SMPv2</Heading>
            <HStack gap={1} align="center" wrap="wrap" className="desk-nav-wide">
              {/* NAV_ROUTES, not ROUTES: `#/build` is a page without a tab. */}
              {NAV_ROUTES.map((r) => (
                <Button
                  key={r.id}
                  variant={loc.route === r.id ? 'primary' : 'ghost'}
                  label={r.label}
                  onClick={() => go(r.id)}
                />
              ))}
            </HStack>
          </HStack>
          <HStack gap={3} align="center" className="desk-topbar-right">
            {/* At every width, in the bar. See NavDrawer for why. */}
            <ModeSwitch />
            <HStack gap={3} align="center" className="desk-nav-wide">
              <Button
                variant="ghost"
                label={`Theme: ${modeLabel(props.themeMode)}`}
                onClick={() => props.onThemeMode(nextMode(props.themeMode))}
              />
              {/* Named, so it is obvious WHOSE session is about to place orders. */}
              <Button
                variant="ghost"
                label={`Sign out${session === null ? '' : ` (${session.username})`}`}
                onClick={signOut}
              />
            </HStack>
            <Button
              className="desk-nav-compact"
              variant="secondary"
              label="Menu"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            />
          </HStack>
        </HStack>
        {/* Full width, 3px, always there. The second of the colour's three places. */}
        <ModeRule />
      </VStack>

      {navOpen ? (
        <NavDrawer
          onClose={() => setNavOpen(false)}
          route={loc.route}
          go={go}
          themeMode={props.themeMode}
          onThemeMode={props.onThemeMode}
          username={session?.username ?? null}
          onSignOut={signOut}
        />
      ) : null}

      {/*
        One page crashing must not blank the desk. See boundary.tsx.

        `padding={4}` / `gap={3}`, down from 5 / 4 (2026-08-04). 20px of inset
        and 16px between every panel is a monitor's spacing; on the screen an
        operator actually reads — one book, seven tiles, two tables — it pushed
        the second table below the fold on a laptop and off the phone entirely.
        The phone gets a tighter step again, in responsive.css.
      */}
      <VStack gap={3} padding={4} className="desk-page">
        <PageBoundary resetKey={`${loc.route}:${loc.tag ?? ''}:${mode}`}>
        {loc.route === 'positions' ? (
          <BookTabsPage mode={mode} tag={loc.tag} onSelect={selectTag} />
        ) : null}
        {loc.route === 'strategies' && loc.tag === null ? <StrategiesPage mode={mode} /> : null}
        {loc.route === 'strategies' && loc.tag !== null
          ? <StrategyPage tag={loc.tag} mode={mode} />
          : null}
        {loc.route === 'books' ? <BooksPage mode={mode} /> : null}
        {loc.route === 'build' ? <BookBuildPage mode={mode} /> : null}
        {loc.route === 'reports' ? <ReportsPage mode={mode} /> : null}
        {/* There is no `orders` branch: the page is gone and `#/orders` is
            aliased onto Status in shell.tsx — the refusals it was opened for
            are a section there, and unlike Broker it honours the switch. */}
        {loc.route === 'broker' ? <BrokerViewPage /> : null}
        {/* Feed + Brokers + order failures + every process, on one page.
            `#/feed`, `#/brokers` and `#/orders` are aliased onto it in
            `shell.tsx`. */}
        {loc.route === 'status' ? <StatusPage /> : null}
        {loc.route === 'controls' ? <ControlsPage mode={mode} /> : null}
        </PageBoundary>
      </VStack>
    </VStack>
  )
}
