/** Dismissible warnings and notes (caveats.tsx): per user and exact text, until the IST day ends. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Caveats } from '../../src/traders/caveats.tsx'
import { SessionContext, type Session } from '../../src/traders/hooks.ts'
import { List } from '@astryxdesign/core/List'
import { noteItems, openNotes } from './fixtures.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); window.localStorage.clear() })

const WATCHER = 'no watcher has reported for this trader yet — positions come only from manual uploads'
const SKIPPED = (n: number): string => `${n} lines skipped in the trade file`

function view(items: readonly string[], kind: 'warning' | 'note' | 'item' = 'warning', username = 'ravi'): React.ReactElement {
  const session: Session = { username, role: 'trader', asTrader: null }
  return <SessionContext.Provider value={session}><Caveats items={items} kind={kind} /></SessionContext.Provider>
}

test('Dismiss hides a warning; "1 hidden — show" brings it back', () => {
  render(view([WATCHER, SKIPPED(2)]))
  const [first] = screen.getAllByRole('button', { name: 'Dismiss' })
  fireEvent.click(first as HTMLElement)
  expect(screen.queryByText(WATCHER)).toBe(null)
  expect(screen.getByText(SKIPPED(2))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '1 hidden — show' }))
  expect(screen.getByText(WATCHER)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /hidden — show/ })).toBe(null)
})

test('a dismissed line stays hidden on the next render of the page (stored per browser)', () => {
  const first = render(view([WATCHER], 'note'))
  openNotes()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  first.unmount()
  render(view([WATCHER], 'note'))
  expect(screen.queryByText(WATCHER)).toBe(null)
  expect(screen.getByRole('button', { name: '1 hidden — show' })).toBeTruthy()
})

test('a line whose text changes is a new line and shows at once', () => {
  const r = render(view([SKIPPED(2)]))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText(SKIPPED(2))).toBe(null)
  r.rerender(view([SKIPPED(3)]))
  expect(screen.getByText(SKIPPED(3))).toBeTruthy()
  expect(screen.queryByRole('button', { name: /hidden — show/ })).toBe(null)
})

test('a dismissal ends with the IST day: the same text shows again the next day', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T23:50:00+05:30'))
  const r = render(view([WATCHER]))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText(WATCHER)).toBe(null)
  vi.setSystemTime(new Date('2026-10-21T00:05:00+05:30'))
  r.rerender(view([WATCHER]))
  expect(screen.getByText(WATCHER)).toBeTruthy()
})

test('another user on the same browser still sees it', () => {
  const r = render(view([WATCHER], 'warning', 'ravi'))
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  r.rerender(view([WATCHER], 'warning', 'sita'))
  expect(screen.getByText(WATCHER)).toBeTruthy()
})

test('storage that throws: the page still renders and a dismissal still hides the line', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  // Its own user: the in-memory fallback keeps this page's earlier dismissals, as it should.
  render(view([WATCHER], 'warning', 'neha'))
  expect(screen.getByText(WATCHER)).toBeTruthy()
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })) })
  expect(screen.queryByText(WATCHER)).toBe(null)
})

test('notes are folded behind one "Notes (N)" toggle that opens them; a dismissed line leaves the count', () => {
  render(view([WATCHER, SKIPPED(2)], 'note'))
  const fold = screen.getByRole('button', { name: 'Notes (2)' })
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(WATCHER)).toBe(null)
  fireEvent.click(fold)
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText(WATCHER)).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0] as HTMLElement)
  expect(screen.getByRole('button', { name: 'Notes (1)' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '1 hidden — show' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Notes (1)' }))
  expect(screen.queryByText(SKIPPED(2))).toBe(null)
})

test('no notes draw nothing at all; every note dismissed leaves only the restore', () => {
  const r = render(view([], 'note'))
  expect(r.container.textContent).toBe('')
  r.unmount()
  render(view([WATCHER], 'note'))
  openNotes()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('button', { name: /^Notes/ })).toBe(null)
  expect(screen.getByRole('button', { name: '1 hidden — show' })).toBeTruthy()
})

test("an item list's fold is its one item until opened", () => {
  const session: Session = { username: 'ravi', role: 'trader', asTrader: null }
  render(
    <SessionContext.Provider value={session}>
      <List><Caveats items={[WATCHER, SKIPPED(2)]} kind="item" /></List>
    </SessionContext.Provider>,
  )
  const list = screen.getByRole('list')
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  openNotes(list)
  expect(noteItems(list)).toHaveLength(2)
})
