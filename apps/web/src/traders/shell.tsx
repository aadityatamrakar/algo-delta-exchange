/**
 * The traders page's frame: a left sidebar (the pages, the admin's trader picker, theme, sign-out) that is either
 * open or fully hidden behind the ☰ at the top left; a top bar with the trader's stocks as tabs and the bell at the
 * top right; and the page.
 *
 * The sidebar's state is remembered per browser. On a phone it opens over the page and closes on any navigation.
 * The Assistant drawer (assistant/drawer.tsx) sits on the right of every page, opened from the top bar or `i`; it
 * is mounted the first time it opens and kept (its conversation survives a close), and its open state is remembered
 * per browser like the sidebar's.
 * The books list behind the stock tabs is polled here once and shared (books-list.ts), so the Books page reads the
 * same answer instead of asking again.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import type { BookSummary } from '../../../traders/src/types.ts'
import { modeLabel, nextMode, type ThemeMode } from '../theme-mode.ts'
import { tapi } from './api.ts'
import { Bell } from './bell.tsx'
import { BellSource } from './bell-store.tsx'
import { AlertFeed, PhoneAlerts } from './phone-alerts.tsx'
import { AssistantDrawer } from './assistant/drawer.tsx'
import { BOOK_SUBTABS } from './book.tsx'
import { BOOK_TAB_BADGES } from './books.tsx'
import { BOOKS_POLL_MS, BooksContext } from './books-list.ts'
import { usePoll, type Polled, type Session } from './hooks.ts'
import type { TradersPage } from './pages.tsx'
import { parseRoute, type TradersRoute } from './route.ts'
import { PAGE_KEYS, ShortcutHelp, focusPageSearch, useShortcuts } from './shortcuts.tsx'
import { TEXT_SIZES, stepTextSize, textSizeLabel, useTextSize } from './text-size.ts'

const SIDEBAR_KEY = 'traders.sidebar'
const ASSISTANT_STATE_KEY = 'traders.assistant'
const PHONE_QUERY = '(max-width: 719px)'

function isPhone(): boolean {
  try { return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches } catch { return false }
}

/** Open or hidden; a phone starts hidden. A refused storage just forgets the choice. */
export function useSidebar(): { open: boolean; phone: boolean; setOpen: (open: boolean) => void } {
  const [phone] = useState(isPhone)
  const [open, set] = useState<boolean>(() => {
    if (phone) return false
    try { return window.localStorage.getItem(SIDEBAR_KEY) !== 'hidden' } catch { return true }
  })
  const setOpen = useCallback((o: boolean) => {
    set(o)
    if (!phone) { try { window.localStorage.setItem(SIDEBAR_KEY, o ? 'open' : 'hidden') } catch { /* forgotten */ } }
  }, [phone])
  return { open, phone, setOpen }
}

/** The Assistant drawer open or closed; closed by default, and a phone starts closed. A refused storage forgets. */
export function useAssistantOpen(phone: boolean): [boolean, (open: boolean) => void] {
  const [open, set] = useState<boolean>(() => {
    if (phone) return false
    try { return window.localStorage.getItem(ASSISTANT_STATE_KEY) === 'open' } catch { return false }
  })
  const setOpen = useCallback((o: boolean) => {
    set(o)
    try { window.localStorage.setItem(ASSISTANT_STATE_KEY, o ? 'open' : 'closed') } catch { /* forgotten */ }
  }, [])
  return [open, setOpen]
}

const AssistantIcon = (): React.ReactElement => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" />
  </svg>
)

function StockTabs(props: { books: Polled<readonly BookSummary[]>; route: TradersRoute; go: (to: string) => void }): React.ReactElement {
  // Every page shows the tabs, so an answer that is not a list (an admin with no trader picked) is no tabs, not a crash.
  const list = Array.isArray(props.books.data) ? props.books.data : []
  if (list.length === 0) return <div className="traders-stocktabs" />
  const stocks = list.map((b) => b.stock)
  const { route } = props
  const active = route.page !== 'books' ? '' : route.stock !== null && stocks.includes(route.stock) ? route.stock : (stocks[0] as string)
  return (
    <div className="traders-stocktabs">
      <TabList role="tablist" aria-label="Books" value={active} onChange={(v) => props.go(`/books/${encodeURIComponent(v)}`)} layout="hug">
        {list.map((b) => (
          <Tab
            key={b.stock}
            role="tab"
            aria-selected={b.stock === active}
            value={b.stock}
            label={b.stock}
            endContent={BOOK_TAB_BADGES.length === 0 ? undefined : <>{BOOK_TAB_BADGES.map((badge, i) => <span key={i}>{badge(b)}</span>)}</>}
          />
        ))}
      </TabList>
    </div>
  )
}

export interface ShellProps {
  readonly session: Session
  readonly pages: readonly TradersPage[]
  readonly page: TradersPage | undefined
  readonly route: TradersRoute
  readonly go: (to: string) => void
  readonly picker: ReactNode
  readonly themeMode: ThemeMode
  readonly onThemeMode: (m: ThemeMode) => void
  readonly onLogout: () => void
  readonly sidebar: { open: boolean; phone: boolean; setOpen: (open: boolean) => void }
  readonly bellOpen: boolean
  readonly onBellOpen: (open: boolean) => void
  readonly children: ReactNode
}

export function TradersShell(props: ShellProps): React.ReactElement {
  const { session, pages, page, route, go, sidebar, bellOpen, onBellOpen } = props
  const books = usePoll<readonly BookSummary[]>(() => tapi.books(), BOOKS_POLL_MS, [session.asTrader])
  const { phone, open, setOpen } = sidebar
  const [help, setHelp] = useState(false)
  const [assistant, setAssistant] = useAssistantOpen(phone)
  // Mounted on first open, then kept: closing hides it and its conversation stays.
  const [assistantMounted, setAssistantMounted] = useState(assistant)
  useEffect(() => { if (assistant) setAssistantMounted(true) }, [assistant])

  // A phone's sidebar covers the page: any navigation closes it. So does the drawer, which covers it too ("Show on
  // payoff" navigates to the Scenario tab, which the trader then needs to see).
  const where = `${route.page}/${route.stock ?? ''}/${route.sub ?? ''}`
  useEffect(() => { if (phone) setOpen(false) }, [where, phone, setOpen])
  useEffect(() => { if (phone) setAssistant(false) }, [where, phone, setAssistant])

  // Closing the drawer gives the keyboard back to its button, unless focus is already somewhere else on the page.
  const assistantButton = useRef<HTMLSpanElement>(null)
  const wasOpen = useRef(assistant)
  useEffect(() => {
    const closed = wasOpen.current && !assistant
    wasOpen.current = assistant
    if (!closed) return
    const at = document.activeElement
    const drawer = document.getElementById('traders-assistant')
    if (at === null || at === document.body || (drawer !== null && drawer.contains(at))) {
      assistantButton.current?.querySelector<HTMLElement>('button')?.focus()
    }
  }, [assistant])

  const stocks = Array.isArray(books.data) ? books.data.map((b) => b.stock) : []
  // Read at the key press, not at the last render: two quick presses must not both act on the same tab.
  const activeNow = (): string | null => {
    const r = parseRoute(window.location.hash)
    return r.page !== 'books' ? null : r.stock !== null && stocks.includes(r.stock) ? r.stock : (stocks[0] ?? null)
  }
  const openStock = (s: string | undefined): void => { if (s !== undefined) go(`/books/${encodeURIComponent(s)}`) }
  useShortcuts({
    page: (id) => { if (pages.some((p) => p.id === id)) go(`/${id}`) },
    stockTab: (step) => {
      if (stocks.length === 0) return
      const active = activeNow()
      const at = active === null ? -1 : stocks.indexOf(active)
      openStock(stocks[at === -1 ? (step === 1 ? 0 : stocks.length - 1) : (at + step + stocks.length) % stocks.length])
    },
    stockTabAt: (n) => openStock(stocks[n - 1]),
    subTab: (n) => {
      const active = activeNow()
      const sub = BOOK_SUBTABS[n - 1]
      if (active !== null && sub !== undefined) go(`/books/${encodeURIComponent(active)}/${sub.id}`)
    },
    search: () => { focusPageSearch() },
    sidebar: () => setOpen(!open),
    bell: () => onBellOpen(!bellOpen),
    assistant: () => setAssistant(!assistant),
    escape: () => {
      if (help) { setHelp(false); return true }
      if (bellOpen) { onBellOpen(false); return true }
      if (assistant) { setAssistant(false); return true }
      if (open && phone) { setOpen(false); return true }
      return false
    },
    help: () => setHelp(true),
  })

  return (
    <BooksContext.Provider value={books}>
      <div className="traders-shell" data-sidebar={open ? 'open' : 'hidden'} data-phone={phone ? 'true' : 'false'}>
        <header className="traders-topbar">
          <Button
            variant="ghost"
            isIconOnly
            icon={<Icon icon="menu" size="sm" color="inherit" />}
            label={open ? 'Hide menu' : 'Show menu'}
            tooltip={open ? 'Hide menu' : 'Show menu'}
            aria-expanded={open}
            aria-controls="traders-sidebar"
            onClick={() => setOpen(!open)}
          />
          <StockTabs books={books} route={route} go={go} />
          <span ref={assistantButton} className="traders-assistant-button">
            <Button
              variant="ghost"
              isIconOnly
              icon={<AssistantIcon />}
              label="Assistant"
              tooltip="Assistant — chat and plan search (i)"
              aria-expanded={assistant}
              aria-controls="traders-assistant"
              onClick={() => setAssistant(!assistant)}
            />
          </span>
          <Bell open={bellOpen} onOpenChange={onBellOpen} />
          {/* the stored phone alerts (expiring ITM, rejections, watchers, band breaches) in the bell, beside the pages' own */}
          <BellSource label="Alerts"><AlertFeed /></BellSource>
        </header>
        <div className="traders-body">
          {open ? (
            <aside id="traders-sidebar" className="traders-sidebar" aria-label="Menu">
              <Heading level={2}>Delta Desk</Heading>
              <nav aria-label="Pages" className="traders-nav">
                {pages.map((p) => {
                  const key = Object.entries(PAGE_KEYS).find(([, id]) => id === p.id)?.[0]
                  return (
                    <Button
                      key={p.id}
                      variant={p.id === page?.id ? 'secondary' : 'ghost'}
                      label={p.label}
                      {...(key === undefined ? {} : { tooltip: `g ${key}` })}
                      aria-current={p.id === page?.id ? 'page' : undefined}
                      onClick={() => go(`/${p.id}`)}
                    />
                  )
                })}
              </nav>
              <div className="traders-sidebar-foot">
                {props.picker}
                <Text size="sm" color="secondary">{session.username}</Text>
                {/* The desk's control: one button cycling Auto -> Light -> Dark. */}
                <Button variant="ghost" label={`Theme: ${modeLabel(props.themeMode)}`} onClick={() => props.onThemeMode(nextMode(props.themeMode))} />
                <TextSizeControl />
                <PhoneAlerts />
                <Button variant="ghost" label="Keyboard shortcuts" tooltip="?" onClick={() => setHelp(true)} />
                <Button variant="secondary" label="Logout" onClick={props.onLogout} />
              </div>
            </aside>
          ) : null}
          {open && phone ? <div className="traders-scrim" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
          <main className="traders-main">{props.children}</main>
          {assistantMounted ? (
            // Keyed on the admin's pick: another trader's books start a fresh conversation.
            <AssistantDrawer key={session.asTrader ?? ''} open={assistant} onClose={() => setAssistant(false)}
              stock={route.page !== 'books' ? null : route.stock !== null && stocks.includes(route.stock) ? route.stock : (stocks[0] ?? null)}
              stocks={stocks} />
          ) : null}
        </div>
      </div>
      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
    </BooksContext.Provider>
  )
}

/** A− / A+ around the current text size; the ends are disabled. */
function TextSizeControl(): React.ReactElement {
  const [size, setSize] = useTextSize()
  return (
    <div className="traders-text-size" role="group" aria-label="Text size">
      <Button variant="ghost" size="sm" label="A−" aria-label="Smaller text" isDisabled={size === TEXT_SIZES[0]!.id} onClick={() => setSize(stepTextSize(size, -1))} />
      <Text size="sm" color="secondary">{`Text: ${textSizeLabel(size)}`}</Text>
      <Button variant="ghost" size="sm" label="A+" aria-label="Larger text" isDisabled={size === TEXT_SIZES[TEXT_SIZES.length - 1]!.id} onClick={() => setSize(stepTextSize(size, 1))} />
    </div>
  )
}
