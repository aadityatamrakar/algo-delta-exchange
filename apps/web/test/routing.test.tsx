/**
 * The hash router, and the one thing it must never do: leave a stale mode in
 * the address bar.
 */
import { expect, test, describe } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { NAV_ROUTES, canonicalHash, useHashRoute } from '../src/shell.tsx'

describe('legacy hashes', () => {
  test('a bookmarked #/live is REWRITTEN, not merely redirected', async () => {
    window.location.hash = '#/live'
    const { result } = renderHook(() => useHashRoute())

    // It lands on the right page…
    expect(result.current[0].route).toBe('positions')
    // …and the address bar stops saying "live" while the badge says PAPER.
    // Two claims about which book you are on, one of them wrong, in the place
    // every screenshot captures.
    await waitFor(() => expect(window.location.hash).toBe('#/positions'))
  })

  test('a legacy hash keeps the book it named', () => {
    expect(canonicalHash('#/paper/BHEL')).toBe('#/positions/BHEL')
    expect(canonicalHash('#/live')).toBe('#/positions')
    expect(canonicalHash('#/strategies-live')).toBe('#/strategies')
  })

  test('a current hash is left alone', () => {
    expect(canonicalHash('#/positions/BHEL')).toBe(null)
    expect(canonicalHash('#/controls')).toBe(null)
    expect(canonicalHash('')).toBe(null)
  })

  test('a bookmarked #/orders lands on Status, which is MODE-AWARE', () => {
    // The Orders page duplicated the books' own order log and the Broker tab's
    // day-wise history, so it is gone. An unmatched head falls through to
    // `positions`, which would drop a bookmarked operator on the book screen
    // with no explanation — the alias is what makes the removal survivable.
    //
    // STATUS, NOT BROKER, and the reason is the mode. `#/orders` was a
    // MODE-SCOPED page, and Broker is live-only: a paper operator following an
    // old bookmark landed on the live broker's book with a PAPER badge in the
    // navbar above it. The question the bookmark actually asks — "what failed?"
    // — is answered by Status's Order failures section, in the rail the switch
    // is showing. Broker is still one click away in the nav, where an operator
    // choosing it has chosen the live account deliberately.
    expect(canonicalHash('#/orders')).toBe('#/status')

    window.location.hash = '#/orders'
    const { result } = renderHook(() => useHashRoute())
    expect(result.current[0].route).toBe('status')
  })
})

/**
 * BUILD IS A ROUTE WITHOUT A TAB.
 *
 * It is reached from the Books page rather than from the header, but the route
 * itself is untouched — and because `ROUTE_IDS` is derived from `ROUTES`,
 * dropping the entry outright (rather than flagging it out of the nav) would
 * have made `#/build` fall through to `positions`: the tab disappears AND the
 * page silently becomes another one.
 */
describe('routes that are not tabs', () => {
  test('#/build still resolves to the build page', () => {
    window.location.hash = '#/build'
    const { result } = renderHook(() => useHashRoute())
    expect(result.current[0].route).toBe('build')
    // …and it is not treated as legacy, so the address bar is left alone.
    expect(canonicalHash('#/build')).toBe(null)
  })

  test('the header offers neither Build nor Orders', () => {
    const labels = NAV_ROUTES.map((r) => r.label)
    expect(labels).not.toContain('Build')
    expect(labels).not.toContain('Orders')
    // The pages either side of where they sat are untouched.
    expect(labels).toContain('Books')
    expect(labels).toContain('Broker')
  })

  test('#/login is not a route, so the desk is never blank behind the gate', () => {
    window.location.hash = '#/login'
    const { result } = renderHook(() => useHashRoute())
    // The gate owns that hash and renders the login page over the router. For
    // the render between signing in and the gate restoring the previous hash,
    // the router has to name a page that exists — it used to name `login`,
    // which `Desk` has no branch for, and the content area was empty.
    expect(result.current[0].route).toBe('positions')
  })

  test('the book and the strategy live in the URL, so a reload keeps your place', () => {
    // `#/positions/<tag>` — a book's TAG, not its symbol, since Phase 0 made a
    // symbol alone insufficient to name one book.
    window.location.hash = '#/positions/BHEL-2026-08-25-hold-recycle-r'
    const positions = renderHook(() => useHashRoute())
    expect(positions.result.current[0].tag).toBe('BHEL-2026-08-25-hold-recycle-r')

    window.location.hash = '#/strategies/ORB_SCALP_BN'
    const strategies = renderHook(() => useHashRoute())
    expect(strategies.result.current[0].tag).toBe('ORB_SCALP_BN')
    // And no route carries a mode: a link must not be able to move the switch.
    expect(JSON.stringify(strategies.result.current[0])).not.toContain('live')
  })
})
