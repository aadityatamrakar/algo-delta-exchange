/**
 * App shell: navigation, routing and the theme switch.
 *
 * ROUTING is a ~20-line hash router rather than react-router. A handful of
 * static pages, no nested routes, no loaders, no code splitting — a router
 * would be more configuration than the thing it configures. `#/books` also
 * survives being served as a static file from any path, which the old
 * dashboard's history-mode routes did not.
 *
 * PAPER/LIVE IS NOT IN HERE. It is one switch in the navbar, persisted to
 * `localStorage`; see `mode.tsx`.
 *
 * THEME MODE is persisted and defaults to `system`. A dashboard someone stares
 * at all day has to respect the OS setting, and has to remember the override.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ago, explain } from './api.ts'
import { VENUE, type VenueSpec } from './venue.ts'

/**
 * `login` IS NOT A ROUTE. The gate owns `#/login` and renders the login page
 * instead of the router's content, so nothing here ever has to match it.
 *
 * It used to be in this union and in `ROUTE_IDS`, which meant `#/login` parsed
 * to a route `Desk` has no branch for: for the one render between a successful
 * sign-in and the gate restoring the previous hash, the whole content area was
 * blank. Parsing it as an unknown head instead falls through to `positions`,
 * which is a page.
 */
export type Route =
  | 'positions' | 'strategies' | 'books'
  | 'reports' | 'broker' | 'status' | 'controls' | 'build' | 'chain' | 'new-book'

/**
 * NO ROUTE CARRIES A MODE ANY MORE.
 *
 * `#/paper` and `#/live` were one of six places paper/live was re-decided; they
 * are now one `#/positions` reading the navbar switch, and `#/strategies` is
 * one table for whichever mode that switch says. What was given up — "am I
 * looking at real money?" answered by which page you are on — is paid back by
 * the persistent red rule and the LIVE badge; see `mode.tsx`.
 *
 * The trade accepted deliberately: a link can no longer carry the mode. A URL
 * that silently changed someone's mode would be worse than not being able to
 * share one.
 *
 * `login` is deliberately absent: it is reached by the auth gate, and a nav item
 * for it would offer to sign out a session that is working.
 */
export const ROUTES: readonly { id: Route; label: string; hash: string; nav?: false }[] = [
  { id: 'positions', label: 'Positions', hash: '#/positions' },
  { id: 'strategies', label: 'Strategies', hash: '#/strategies' },
  { id: 'books', label: 'Books', hash: '#/books' },
  /**
   * A ROUTE WITH NO TAB (`nav: false`).
   *
   * Build OPENS a position; Books manages the ones that exist. As a header tab
   * it sat beside Books meaning nothing until you were already on Books — so it
   * is reached from there instead, by the one button that used to open the
   * create wizard.
   *
   * IT STAYS IN THIS LIST rather than being deleted, and that is the whole
   * reason `nav` exists: `ROUTE_IDS` is derived from `ROUTES` (see below), so
   * dropping the entry would make `#/build` an unmatched head and fall it
   * through to `positions` — the tab disappears AND the page silently becomes
   * a different one, for every bookmark and every link.
   */
  { id: 'build', label: 'Build', hash: '#/build', nav: false },
  /**
   * NEW BOOK — the wizard for a strategy that places its own trades (BULL-S):
   * a book with no positions and its dials set before it starts. No tab, for
   * the reason `build` has none: Books' "Build a book" is the way in.
   */
  { id: 'new-book', label: 'New book', hash: '#/new-book', nav: false },
  /** The option chain: per strike CE | strike | PE, live. Read-only. */
  { id: 'chain', label: 'Option chain', hash: '#/chain' },
  { id: 'reports', label: 'Reports', hash: '#/reports' },
  /**
   * WAS PRECEDED BY 'Orders', which is gone (2026-08-16).
   *
   * That page listed what the DESK did; between the per-book order log and this
   * tab's day-wise history there was nothing left on it that is not shown
   * somewhere an operator is already looking. Its refusals were NOT covered by
   * either, which is why they are now a section on Status — see
   * `OrderFailuresSection` in `status.tsx`.
   *
   * `#/orders` is aliased onto STATUS, not here (see `LEGACY`): this page is
   * live-only and the old one was mode-scoped. The nav is how an operator
   * reaches the day-wise history, having chosen the live account on purpose.
   */
  { id: 'broker', label: 'Broker', hash: '#/broker' },
  /**
   * WAS 'Feed' AND 'Brokers', two tabs. Between them they answered about a
   * third of "is the desk working?" — neither said whether the runner, the
   * gateway or either Python supervisor was alive — so they are one page with a
   * systems report above them. `#/feed` and `#/brokers` still resolve here
   * (see `LEGACY`), so every bookmark and stored `returnTo` survives.
   *
   * 'Broker' ABOVE IS A DIFFERENT PAGE and is deliberately untouched: it is the
   * broker's own order book, read against ours. Only the credentials screen
   * moved.
   */
  { id: 'status', label: 'Status', hash: '#/status' },
  { id: 'controls', label: 'Controls', hash: '#/controls' },
]

export interface Location {
  readonly route: Route
  /**
   * The second URL segment. Under `positions` it is the desk BOOK'S TAG
   * (`#/positions/BHEL-2026-08-25-hold-recycle-r`) — a symbol stopped
   * identifying one book at Phase 0, so the URL no longer tries to name one by
   * symbol either. Under `strategies` it is the strategy's tag
   * (`#/strategies/BN_BREAKOUT`). Null means "no book/strategy chosen — show
   * the list and let the operator pick."
   */
  readonly tag: string | null
}

/**
 * DERIVED FROM `ROUTES`, never restated.
 *
 * This was a hand-maintained copy of the same eight strings, and adding a
 * ninth route to the union and the nav without also adding it here made the new
 * tab silently render the DEFAULT page: `find` misses, `LEGACY` misses, and the
 * fallback is `positions`. The tab highlighted correctly and showed the wrong
 * screen, which is about the most confusing way for it to fail.
 *
 * `login` stays out of both by being absent from `ROUTES` — the reason the
 * comment above `Route` gives — so deriving loses nothing.
 */
const ROUTE_IDS: readonly Route[] = ROUTES.map((r) => r.id)

/**
 * The routes that get a TAB, in order. Derived from `ROUTES` for the same
 * reason `ROUTE_IDS` is: a second hand-maintained list is a second thing to
 * forget, and the navbar and the drawer both read this one.
 *
 * A ROUTE IS NOT A TAB. Everything in `ROUTES` is reachable by its hash;
 * `nav: false` says only that the header does not offer it, because something
 * else does — the Books page's "Build a book" button, for `#/build`.
 */
export function navRoutesFor(venue: VenueSpec): readonly { id: Route; label: string; hash: string }[] {
  const hidden = venue.id === 'dx' ? DX_HIDDEN : NSE_HIDDEN
  return ROUTES.filter((r) => r.nav !== false && !hidden.has(r.id))
}

/**
 * Tabs one venue's build does not offer. The routes themselves still resolve,
 * so a bookmark lands on a page rather than nowhere.
 *
 *  - DX: nothing. `broker` was hidden here while it could only read the NSE
 *    broker's book (XTS/Kite); on the DX build it is now Delta's own book on
 *    the switch's account (`dx-broker-view.tsx`, operator 4 Nov).
 *  - NSE: `chain` is the DX build's option-chain page (BTC); the NSE desk
 *    reads its chains on Build and in the Manual Order dialog, unchanged.
 */
const DX_HIDDEN: ReadonlySet<Route> = new Set<Route>([])
const NSE_HIDDEN: ReadonlySet<Route> = new Set<Route>(['chain'])

export const NAV_ROUTES: readonly { id: Route; label: string; hash: string }[] = navRoutesFor(VENUE)

/**
 * Hashes from the split-page era, mapped forward.
 *
 * Bookmarks, the auth gate's stored `returnTo` and anything pasted into a chat
 * still point at `#/paper`. They land on the right PAGE; they no longer set the
 * mode, which is the whole point — a URL must not be able to move the switch.
 */
const LEGACY: Readonly<Record<string, Route>> = {
  paper: 'positions',
  live: 'positions',
  'strategies-live': 'strategies',
  'strategies-all': 'strategies',
  /**
   * The two tabs that became Status.
   *
   * ALIASES, NOT DELETIONS. `#/feed` in particular is in runbooks, in the auth
   * gate's stored `returnTo` and in whatever anyone has bookmarked — and an
   * unmatched head falls through to `positions`, so dropping them would land
   * someone on the book screen with no explanation. Note `brokers` (plural, the
   * credentials tab) is mapped and `broker` (singular, the broker's order book)
   * is NOT: it is still a page of its own.
   */
  feed: 'status',
  brokers: 'status',
  /**
   * THE ORDERS PAGE, ONTO STATUS — NOT ONTO BROKER.
   *
   * `#/orders` was a tab for a year; it is in runbooks, in the auth gate's
   * stored `returnTo` and in whatever anyone has pasted into a chat. It has to
   * land somewhere real, because an unmatched head falls through to
   * `positions`.
   *
   * IT LANDS ON STATUS BECAUSE THE OLD PAGE WAS MODE-SCOPED AND BROKER IS NOT.
   * Broker reads the LIVE account and nothing else — it has no paper rail to
   * show — so a paper operator following an old bookmark arrived at the live
   * broker's book with a PAPER badge in the bar above it, which is the one
   * confusion this dashboard's single switch exists to prevent. Status is
   * mode-aware, and its `Order failures` section is the question the bookmark
   * is usually asking: what did not go through.
   *
   * "The history lives on Broker" is still true and still one click away in the
   * nav — where an operator choosing it has chosen the live account on purpose,
   * rather than being sent there by a URL.
   */
  orders: 'status',
}

/**
 * `#/positions` -> the book tabs; `#/positions/<tag>` -> that one book.
 * `#/strategies` -> the table for the current mode; `#/strategies/BN_BREAKOUT`
 * -> that strategy.
 *
 * The segments live in the URL rather than component state so a drilled-in book
 * or strategy survives a reload and can be linked to — the thing you want when
 * sending someone "look at this position".
 */
function parseHash(hash: string): Location {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const head = parts[0] ?? 'positions'
  const route: Route = ROUTE_IDS.find((r) => r === head) ?? LEGACY[head] ?? 'positions'
  const raw = parts[1]
  const second = raw === undefined ? null : decodeURIComponent(raw)
  return {
    route,
    // A legacy `#/paper/BHEL` still names its second segment; `#/strategies-live/TAG`
    // never existed, so only positions and (non-legacy) strategies read it —
    // and only one of those two is ever the current route.
    tag: (route === 'positions' || (route === 'strategies' && LEGACY[head] === undefined))
      ? second
      : null,
  }
}

/**
 * The canonical hash for a legacy one, or null when it is already canonical.
 *
 * A stale `#/live` that is merely REDIRECTED still leaves the word "live" in
 * the address bar while the badge says PAPER — two claims about which book you
 * are on, one of them wrong, in the one place a screenshot always captures.
 * Rewriting it is the difference between a route that survived the migration
 * and a lie about the mode.
 */
export function canonicalHash(hash: string): string | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const head = parts[0] ?? ''
  const mapped = LEGACY[head]
  if (mapped === undefined) return null
  const target = ROUTES.find((x) => x.id === mapped)?.hash ?? `#/${mapped}`
  // `#/paper/BHEL` still names its book, so the segment is carried across.
  const second = mapped === 'positions' ? parts[1] : undefined
  return second === undefined ? target : `${target}/${second}`
}

/**
 * The canonical hash for a route — the one place a route's URL is written.
 *
 * Falls back to the id, so a route that is not in the nav (`build`) still gets
 * its hash rather than silently resolving to nothing.
 */
export function hashFor(r: Route): string {
  return ROUTES.find((x) => x.id === r)?.hash ?? `#/${r}`
}

/**
 * Go to a route, FROM ANYWHERE.
 *
 * The navbar has `go` from `useHashRoute`; a PAGE that has to send the operator
 * to another page — the Books page's "Build a book" — is nowhere near that hook
 * and would otherwise assign `window.location.hash` itself, which is the second
 * place the hash gets written and the first place it gets written wrong. Both
 * go through here; `go` is this function with the hook's identity.
 */
export function goTo(r: Route): void {
  window.location.hash = hashFor(r)
}

export function useHashRoute(): [Location, (r: Route) => void, (tag: string) => void] {
  const [loc, setLoc] = useState<Location>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setLoc(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  /**
   * Rewrite a legacy hash in place, on arrival and after any navigation to one.
   *
   * `replaceState` rather than assigning `location.hash`: it fires no
   * `hashchange` and adds no history entry, so the Back button still goes where
   * the operator came from instead of bouncing off the rewrite.
   */
  useEffect(() => {
    const canonical = canonicalHash(window.location.hash)
    if (canonical !== null) window.history.replaceState(null, '', canonical)
  }, [loc])

  const go = useCallback((r: Route) => { goTo(r) }, [])
  /** Select a book tab, by tag. Kept in the URL so it survives a reload and can be linked. */
  const selectTag = useCallback((tag: string) => {
    window.location.hash = `#/positions/${encodeURIComponent(tag)}`
  }, [])
  return [loc, go, selectTag]
}

// ------------------------------------------------------------------- theme

// In its own leaf so the traders page can share it without this file's imports.
export { modeLabel, nextMode, useThemeMode, type ThemeMode } from './theme-mode.ts'

// ---------------------------------------------------------- the viewport

/**
 * The width at and below which a page renders its PHONE layout.
 *
 * THE SAME 719px responsive.css calls `phone`, and for the same reason: CSS
 * cannot read a TypeScript constant, so the number lives twice and each side
 * names the other. A test pins them together (test/responsive.test.tsx), which
 * is the only thing that notices when one moves.
 *
 * WHY ANY LAYOUT DECISION IS TAKEN IN JS AT ALL, when the rest of the mobile
 * pass is pure CSS: the two places that use this replace a TABLE with CARDS and
 * re-size a table's columns. Doing that in CSS would mean rendering BOTH
 * arrangements and hiding one — and the strategies table's row carries a Switch
 * that arms live trading. Two of those in the document, one of them invisible,
 * is a duplicate the DOM cannot tell apart and a test cannot query
 * unambiguously; astryx's own column widths are inline styles on the `<th>`,
 * which no unlayered rule can override without `!important`. So: one layout in
 * the document at a time, chosen by the same media query the stylesheet uses.
 */
export const PHONE = '(max-width: 719px)'

/**
 * Whether a media query matches RIGHT NOW, kept in sync as the window changes.
 *
 * The initial value is read during the first render rather than in an effect,
 * so a phone never paints the desktop layout for one frame and then swaps.
 * `change` is listened to because a rotation, a split-screen or a dragged
 * desktop window all cross the breakpoint without a reload — the same reason
 * App.tsx watches `WIDE_NAV` to close its drawer.
 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const sync = (): void => setMatches(mq.matches)
    // Re-read on mount: the query can have changed between the first render
    // and this effect, and the state initialiser only ever runs once.
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [query])
  return matches
}

// ------------------------------------------------------- one-shot fetches

/**
 * Read something ONCE per dependency change, and apply the answer only if it is
 * still the current one.
 *
 * Every screen that reads a list on mount had its own copy of this, and the
 * copy is never the request — it is the three lines of bookkeeping around it
 * that decide whether the answer may still touch state. Get those wrong and a
 * slow reply for a symbol nobody is looking at any more overwrites the one they
 * are, or a `setState` lands on an unmounted tree. Neither shows up in the
 * happy path, which is exactly why it is worth having in one place.
 *
 * A NULL `fn` SKIPS the run, for the callers that cannot ask yet — a pair with
 * no expiry chosen, a tag nobody has picked. The alternative, an early `return`
 * inside the effect, hides the guard where the deps list cannot see it.
 *
 * THE ANSWER GOES TO CALLBACKS rather than coming back as state, because the
 * callers here do not merely store it: they correct a second field from it, and
 * doing that from a follow-up effect would let the render in between fire a
 * request for the very pair the correction is about to replace.
 */
export function useAsync<T>(
  fn: (() => Promise<T>) | null,
  onValue: (value: T) => void,
  onFailure: (err: unknown) => void,
  deps: readonly unknown[] = [],
): void {
  useEffect(() => {
    if (fn === null) return
    let live = true
    void fn()
      .then((value) => {
        if (live) onValue(value)
      })
      .catch((err: unknown) => {
        if (live) onFailure(err)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

// -------------------------------------------------------------- polling

export interface Poll<T> {
  /** The last payload that arrived, or null before the first one. */
  data: T | null
  error: string | null
  /**
   * When `data` was last CONFIRMED by a successful read, in wall-clock ms —
   * null until the first one lands. A failed read never moves it: the whole
   * point is that the age printed beside a stale figure keeps counting up.
   */
  updatedAt: number | null
  refresh: () => void
}

/**
 * Poll `fn` on an interval, with the result, the last error and when the result
 * last arrived.
 *
 * The error is kept SEPARATE from the data rather than replacing it: when the
 * bridge blips, a dashboard that blanks every number is less useful than one
 * showing the last known values with a warning. Stale-but-labelled beats empty —
 * and `updatedAt` is the "labelled" half made available to the tiles (`asOf`).
 *
 * A TICK OVER AN UNANSWERED READ IS SKIPPED, NOT STACKED.
 *
 * The interval used to fire whether or not the previous request had answered,
 * so a bridge hanging for a minute left a 3s page (the feed) holding twenty
 * open sockets — one more every cadence, from every polling component on the
 * screen, arriving exactly when the thing being polled is already struggling.
 * The flag pauses the cadence for as long as one read is outstanding and the
 * next tick resumes it; a deps change never waits on the read it abandoned.
 *
 * RESPONSES ARE STILL APPLIED IN ORDER, WHICH IS NOT THE ORDER THEY ARRIVE IN.
 *
 * The skip does not make the ordering guard redundant: an abandoned read
 * releases the flag when it finally answers, so the tick after that fires over
 * the request the CURRENT deps are already waiting on and two are live again.
 * Unguarded, the slower FIRST request lands last and overwrites the newer
 * payload with an older one: the numbers jump backwards for a cadence,
 * silently, on a page whose entire claim is that a figure is at most N seconds
 * old (audit F-49). Each request carries a monotonic id and only an id ABOVE
 * the last applied one may touch state — for the failure branch too, or a
 * superseded request's error raises a banner over a figure that was fetched
 * successfully after it.
 *
 * A FAILURE TAKES THE SLOT ONLY WHEN THERE IS A FIGURE TO DEFEND. `applied` is
 * what a later answer is measured against, and a failure that claimed the
 * newest id on an EMPTY page threw away the read still in flight behind it: the
 * page then said "bridge unreachable" over nothing, having been handed a
 * perfectly good payload it discarded. With data on screen the failure keeps
 * consuming the id — that is the F-49 protection above, and there the answer it
 * excludes is one that would roll the number backwards.
 *
 * The counters are refs, not state: they must survive a re-render without
 * causing one, and they must NOT reset when the deps change — a request issued
 * for the previous deps is stale in exactly the same way (the `alive` flag
 * catches that one, and the ids agree with it).
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: readonly unknown[] = [],
): Poll<T> {
  /**
   * ONE STATE OBJECT, replaced on EVERY settled read — success or failure.
   *
   * Separate `data`/`error` states meant a repeated failure set the same error
   * string and React bailed out of the render: the "as of Xs ago" beside the
   * figure then froze at the last value it happened to be painted with, which
   * is a stale age on a stale number — the one reading worse than no age at all.
   * A fresh object per attempt re-paints it. `data`'s IDENTITY is preserved
   * across a failure, so the effects downstream that key off it (see
   * `useLivePnl`) still do not re-run for a read that changed nothing.
   */
  const [state, setState] = useState<{ data: T | null; error: string | null; updatedAt: number | null }>(
    { data: null, error: null, updatedAt: null },
  )
  const [nonce, setNonce] = useState(0)
  /** Ids issued so far, and the highest one whose answer has been applied. */
  const issued = useRef(0)
  const applied = useRef(0)
  /** Whether a read is outstanding — the tick that would stack on it is skipped. */
  const inFlight = useRef(false)
  /**
   * Whether the page has a figure on it, read from a ref because the failure
   * branch runs inside a closure that was built for an older render's state.
   * Once a payload lands it is never taken away (a failure keeps the last one),
   * so this only ever turns on.
   */
  const hasData = useRef(false)

  useEffect(() => {
    let alive = true
    // A read issued for the PREVIOUS deps is not a reason to hold this page's
    // first one back: it is describing a book, mode or tag nobody is looking at
    // any more, and waiting for it would leave the new page blank until the old
    // bridge call gave up.
    inFlight.current = false
    const run = async (): Promise<void> => {
      if (inFlight.current) return
      inFlight.current = true
      issued.current += 1
      const id = issued.current
      try {
        const v = await fn()
        // `id <= applied.current` is a response the page has already moved past.
        if (!alive || id <= applied.current) return
        applied.current = id
        hasData.current = true
        setState({ data: v, error: null, updatedAt: Date.now() })
      } catch (err) {
        if (!alive || id <= applied.current) return
        // Consuming the id shuts out every read issued before this one. That is
        // right while a figure is on screen and wrong on an empty page, where
        // the read still in flight is the only thing that can fill it.
        if (hasData.current) applied.current = id
        const message = explain(err)
        // The last good payload and its age SURVIVE. Only the error is new.
        setState((s) => ({ data: s.data, error: message, updatedAt: s.updatedAt }))
      } finally {
        // Whichever read settles releases the cadence — including an abandoned
        // one, whose answer is thrown away above but whose socket is now closed.
        inFlight.current = false
      }
    }
    void run()
    const t = setInterval(() => void run(), intervalMs)
    return () => {
      alive = false
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps])

  return { ...state, refresh: () => setNonce((n) => n + 1) }
}

/**
 * "as of 7s ago" — a poll's `updatedAt` in the words a tile prints beside its
 * figure, or `undefined` when nothing has been confirmed yet.
 *
 * UNDEFINED RATHER THAN "as of never". Before the first response the figure is
 * a dash, and an age under a dash is a qualifier on nothing. `ago` is the
 * dashboard's one duration wording (`api.ts`), so this reads the same as every
 * other age on the screen.
 *
 * IT IS THE AGE OF THE READ, not of what the read described. A margin document
 * refreshed by the gateway an hour ago is an hour stale however recently the
 * browser fetched it, and the tiles that know that difference say the LOUDER
 * one — see the margin tile in pages.tsx.
 */
export function asOf(updatedAt: number | null): string | undefined {
  return updatedAt === null ? undefined : `as of ${ago(Date.now() - updatedAt)}`
}
