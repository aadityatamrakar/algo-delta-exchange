/** The traders keyboard layer: it navigates, never while typing, and never with Ctrl/Cmd. */
import { expect, test, afterEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import { isTyping } from '../../src/traders/shortcuts.tsx'
import { installFetch } from '../http.tsx'
import { bookView, summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null); window.localStorage.clear(); window.location.hash = '' })

function mount(): void {
  installFetch(({ path, method }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return { body: summaries('TCS', 'VEDL', 'NIFTY') }
    const m = /^\/v1\/traders\/books\/([^/]+)$/.exec(path)
    if (m !== null && method === 'GET') return { body: bookView({ stock: decodeURIComponent(m[1] as string) }) }
    if (path === '/v1/traders/orders' || path === '/v1/traders/trades') return { body: [] }
    return { status: 404, body: { error: 'not in this test' } }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
}

const key = (k: string, init: Partial<KeyboardEventInit> = {}): void => { fireEvent.keyDown(document.body, { key: k, ...init }) }

test('g then a letter opens that page', async () => {
  mount()
  await screen.findByRole('tablist', { name: 'Books' })
  key('g'); key('o')
  await waitFor(() => expect(window.location.hash).toBe('#/orders'))
  key('g'); key('b')
  await waitFor(() => expect(window.location.hash).toBe('#/books'))
  key('g'); key('a')   // a trader has no Admin page: nothing happens
  expect(window.location.hash).toBe('#/books')
})

test('[ and ] step through the stock tabs (wrapping); Alt+n opens tab n', async () => {
  window.location.hash = '#/books/TCS'
  mount()
  await screen.findByRole('tablist', { name: 'Books' })
  key(']')
  await waitFor(() => expect(window.location.hash).toBe('#/books/VEDL'))
  key('['); key('[')
  await waitFor(() => expect(window.location.hash).toBe('#/books/NIFTY'))
  key('3', { altKey: true, code: 'Digit3' })
  expect(window.location.hash).toBe('#/books/NIFTY')
  key('¡', { altKey: true, code: 'Digit1' })   // a Mac's Alt+1 types ¡: the key position still counts
  await waitFor(() => expect(window.location.hash).toBe('#/books/TCS'))
})

test("on a book, a digit opens that sub-tab", async () => {
  window.location.hash = '#/books/TCS'
  mount()
  await screen.findByText('as of 10:27 IST')
  key('2')
  await waitFor(() => expect(window.location.hash).toBe('#/books/TCS/scenario'))
  key('1')
  await waitFor(() => expect(window.location.hash).toBe('#/books/TCS/analysis'))
})

test('keys typed in a field, or with Ctrl/Cmd, are not shortcuts', async () => {
  mount()
  await screen.findByRole('tablist', { name: 'Books' })
  const field = document.createElement('input')
  document.body.appendChild(field)
  field.focus()
  fireEvent.keyDown(field, { key: 'g' }); fireEvent.keyDown(field, { key: 'o' })
  key('g', { ctrlKey: true }); key('o', { ctrlKey: true })
  key(']', { metaKey: true })
  expect(window.location.hash).toBe('')
  field.remove()
  expect(isTyping(Object.assign(document.createElement('div'), { role: 'x' }))).toBe(false)
  const box = document.createElement('div'); box.setAttribute('role', 'combobox')
  expect(isTyping(box)).toBe(true)
  const check = document.createElement('input'); check.type = 'checkbox'
  expect(isTyping(check)).toBe(false)
})

test('\\ toggles the menu; n opens the alerts and Esc closes them; ? lists the shortcuts', async () => {
  mount()
  await screen.findByRole('navigation', { name: 'Pages' })
  key('\\')
  expect(screen.queryByRole('navigation', { name: 'Pages' })).toBe(null)
  key('\\')
  expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy()

  key('n')
  expect(await screen.findByRole('dialog', { name: 'Alerts and warnings' })).toBeTruthy()
  key('Escape')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Alerts and warnings' })).toBe(null))

  key('?')
  const list = await screen.findByRole('table', { name: 'Keyboard shortcuts' })
  expect(list.textContent).toMatch(/Previous \/ next stock tab/)
  key('g'); key('o')   // the help dialog has the keyboard
  expect(window.location.hash).toBe('')
  key('Escape')
  await waitFor(() => expect(screen.queryByRole('table', { name: 'Keyboard shortcuts' })).toBe(null))
})

test('/ focuses the page’s first field', async () => {
  window.location.hash = '#/orders'
  mount()
  await screen.findByRole('tablist', { name: 'Books' })
  await waitFor(() => expect(document.querySelector('.traders-main input, .traders-main [role="combobox"]')).not.toBe(null))
  key('/')
  expect(document.activeElement?.closest('.traders-main')).not.toBe(null)
})

test('e asks a page with an editable layout to start or finish editing it, and nothing else', async () => {
  mount()
  await screen.findByRole('tablist', { name: 'Books' })
  const heard = vi.fn()
  window.addEventListener('traders:edit-layout', heard)
  key('e')
  expect(heard).not.toHaveBeenCalled()             // no editable layout on this page
  const page = document.createElement('div'); page.setAttribute('data-layout-editable', 'true')
  document.body.appendChild(page)
  key('e')
  expect(heard).toHaveBeenCalledOnce()
  page.remove()
  window.removeEventListener('traders:edit-layout', heard)
})
