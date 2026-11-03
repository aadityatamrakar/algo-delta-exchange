/**
 * Feed readiness — counted, and attributed to a rail.
 *
 * The endpoint is UNAUTHENTICATED. It used to list every book by symbol with
 * its leg count, which is what the desk is positioned in, to anyone who could
 * reach the port; it now answers in counts. And it answers for the paper rail
 * whichever way the navbar switch is set, so the page has to say so — this page
 * is reachable under the red LIVE rule.
 */
import { expect, test, describe } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { FeedSection } from '../src/pages.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { installFetch } from './http.tsx'

const FEED = {
  feedAlive: true, marksHeld: 61, subscribedTokens: 72, coverage: 0.847,
  msSinceLastTick: 1200, bookCount: 2, booksIncomplete: 1, ready: false,
}

function mount(over: Record<string, unknown> = {}, mode: 'paper' | 'live' = 'live'): void {
  window.localStorage.setItem('desk.mode', mode)
  installFetch(({ path }) => (path === '/v1/desk/feed' ? { body: { ...FEED, ...over } } : { body: {} }))
  render(<ModeProvider><FeedSection /></ModeProvider>)
}

const readiness = async (): Promise<HTMLElement> => {
  const heading = await screen.findByText('Readiness')
  return heading.closest('.astryx-card') as HTMLElement ?? heading.parentElement as HTMLElement
}

describe('the feed page', () => {
  test('books are counted, never named', async () => {
    mount()
    const card = await readiness()
    expect(within(card).getByText('Books held')).toBeTruthy()
    expect(within(card).getByText('With an unmarked leg')).toBeTruthy()
    // No symbol anywhere: the wire no longer carries one, and nothing here
    // should be reaching for a shape that has been deliberately removed.
    expect(card.textContent).not.toContain('BHEL')
  })

  test('the counts are labelled with the rail they were taken from', async () => {
    mount({}, 'live')
    const card = await readiness()
    // The switch says LIVE; these numbers are paper. Saying so is the fix.
    expect(within(card).getByText('PAPER')).toBeTruthy()
  })

  test('holding nothing reads as ready, not as waiting', async () => {
    mount({ bookCount: 0, booksIncomplete: 0, ready: true })
    const card = await readiness()
    expect(within(card).getByText('yes')).toBeTruthy()
    // The copy must not still tell the operator to wait for a book: on a first
    // paper day that is a healthy system described as broken.
    expect(card.textContent).toContain('holding nothing counts as ready')
  })

  test('nothing is invented while the first response is in flight', async () => {
    installFetch(() => ({ status: 503, body: { error: 'down' } }))
    render(<ModeProvider><FeedSection /></ModeProvider>)
    const card = await readiness()
    // Em dashes, not zeros: "0 books held" is a claim, and we have none.
    expect(within(card).getAllByText('—').length).toBeGreaterThan(0)
  })
})

/**
 * A SHUT MARKET IS NOT A BROKEN FEED.
 *
 * No tick arrives on a Saturday, so `feedAlive` is false and this page said
 * "Feed is down" in red, with Status DOWN, every weekend. Nothing was wrong.
 * A screen that cries wolf for two days a week is a screen nobody reads on the
 * third, so the SAME numbers are presented differently once the bridge says the
 * market was shut when it answered.
 *
 * The measured values are untouched: `feedAlive` still reports the feed and
 * `ready` is still the deployment smoke test. Only the wording moves.
 */
describe('a closed market', () => {
  test('reads as closed, not as down', async () => {
    mount({ feedAlive: false, sessionOpen: false, msSinceLastTick: 68 * 3600_000 })
    await screen.findByText(/Market closed/)
    expect(screen.queryByText('Feed is down')).toBe(null)
    expect(screen.getByText('closed')).toBeTruthy()
    expect(screen.queryByText('DOWN')).toBe(null)
  })

  test('"not trading" replaces "not yet" — nothing is being waited for', async () => {
    mount({ feedAlive: false, sessionOpen: false, ready: false })
    const card = await readiness()
    expect(within(card).getByText(/not trading/)).toBeTruthy()
    expect(within(card).queryByText('not yet')).toBe(null)
  })

  test('a dead feed DURING a session is still red', async () => {
    // The case the red state exists for: ticks have stopped while the exchange
    // is open, so every mark is untrustworthy and no order can be priced.
    mount({ feedAlive: false, sessionOpen: true })
    await screen.findByText('Feed is down')
    expect(screen.getByText('DOWN')).toBeTruthy()
    expect(screen.queryByText(/Market closed/)).toBe(null)
  })

  test('an OLDER bridge sends no sessionOpen, and the page stays loud', async () => {
    // Fail-loud default: a silence we cannot explain is still worth shouting
    // about, and this page must not go quiet on a field that is merely missing.
    mount({ feedAlive: false })
    await screen.findByText('Feed is down')
    expect(screen.getByText('DOWN')).toBeTruthy()
  })

  test('a LIVE feed off-hours says nothing about the session', async () => {
    // 15:31 on a weekday: the last tick is seconds old and the feed is alive.
    // There is no problem to explain, and a banner explaining one would be
    // noise on a healthy page.
    mount({ feedAlive: true, sessionOpen: false })
    await screen.findByText('Readiness')
    expect(screen.queryByText(/Market closed/)).toBe(null)
    expect(screen.getByText('live')).toBeTruthy()
  })
})

describe('the loading state', () => {
  test('claims neither "down" nor "closed" before the first reply lands', async () => {
    // Both are statements about the feed, and there is no feed status yet.
    installFetch(() => ({ status: 503, body: { error: 'down' } }))
    render(<ModeProvider><FeedSection /></ModeProvider>)
    await readiness()
    expect(screen.queryByText('Feed is down')).toBe(null)
    expect(screen.queryByText(/Market closed/)).toBe(null)
  })
})

/**
 * HOW OLD THIS SECTION'S ANSWER IS — the read, not the exchange.
 *
 * "Last tick" times the market; a bridge that stops answering freezes it, and
 * `usePoll` keeps the last payload on purpose, so a dead bridge left the whole
 * section describing a healthy feed with every number stuck at the value it had
 * when the reads stopped. The age of the READ is the one figure that moves in
 * that state (audit F-49/F-52 tile ages).
 */
describe('the age of the reading', () => {
  test('the Feed heading says when its figures last arrived', async () => {
    mount()
    await screen.findByText('Readiness')
    expect(screen.getByText(/^as of /)).toBeTruthy()
  })

  test('before the first answer there is no age at all, rather than "as of never"', async () => {
    installFetch(() => ({ status: 503, body: { error: 'down' } }))
    render(<ModeProvider><FeedSection /></ModeProvider>)
    await screen.findByText('Readiness')
    expect(screen.queryByText(/^as of /)).toBe(null)
  })
})
