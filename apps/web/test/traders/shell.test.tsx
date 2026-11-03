/** The traders shell: the sidebar, the stock tabs in the top bar, and the bell. */
import { expect, test, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import { installFetch, type Reply } from '../http.tsx'
import { bookView, summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null); window.localStorage.clear(); window.location.hash = '' })

function mount(book: () => Reply = () => ({ body: bookView() }), stocks = ['TCS', 'VEDL']): void {
  installFetch(({ path, method }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return { body: summaries(...stocks) }
    if (path.startsWith('/v1/traders/books/') && method === 'GET') return book()
    if (path === '/v1/traders/orders' || path === '/v1/traders/trades') return { body: [] }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
}

const bellButton = (): HTMLElement => screen.getByRole('button', { name: /^Alerts/ })
async function openBell(): Promise<HTMLElement> {
  fireEvent.click(bellButton())
  return await screen.findByRole('dialog', { name: 'Alerts and warnings' })
}

test('the sidebar holds the pages and sign-out; ☰ hides it fully and the choice is remembered', async () => {
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Pages' })
  for (const name of ['Books', 'Orders', 'Market Watch', 'Range', 'Portfolio']) expect(within(nav).getByRole('button', { name })).toBeTruthy()
  expect(within(nav).queryByRole('button', { name: 'Admin' })).toBe(null)   // a trader has no Admin
  expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Hide menu' }))
  expect(screen.queryByRole('navigation', { name: 'Pages' })).toBe(null)
  expect(screen.queryByRole('button', { name: 'Logout' })).toBe(null)
  expect(window.localStorage.getItem('traders.sidebar')).toBe('hidden')

  // A new visit opens it hidden; ☰ brings it back.
  document.body.innerHTML = ''
  mount()
  const show = await screen.findByRole('button', { name: 'Show menu' })
  expect(screen.queryByRole('navigation', { name: 'Pages' })).toBe(null)
  fireEvent.click(show)
  expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy()
  expect(window.localStorage.getItem('traders.sidebar')).toBe('open')
})

test('a sidebar link goes to its page and is marked current', async () => {
  mount()
  const nav = await screen.findByRole('navigation', { name: 'Pages' })
  fireEvent.click(within(nav).getByRole('button', { name: 'Orders' }))
  await waitFor(() => expect(window.location.hash).toBe('#/orders'))
  await waitFor(() => expect(within(nav).getByRole('button', { name: 'Orders' }).getAttribute('aria-current')).toBe('page'))
})

test('the stocks are tabs in the top bar on every page; a tab opens that book', async () => {
  window.location.hash = '#/orders'
  mount()
  const tabs = await screen.findByRole('tablist', { name: 'Books' })
  expect(tabs.closest('header')).not.toBe(null)
  fireEvent.click(within(tabs).getByRole('tab', { name: /VEDL/ }))
  await waitFor(() => expect(window.location.hash).toBe('#/books/VEDL'))
})

test('warnings go to the bell, not the page: counted, listed by where they came from, dismissible and restorable', async () => {
  mount(() => ({ body: bookView({ warnings: ['Watcher offline since 09:10', 'Margin is partial'] }) }))
  await screen.findByText('as of 10:27 IST')
  expect(screen.queryByText('Margin is partial')).toBe(null)
  await waitFor(() => expect(bellButton().getAttribute('aria-label') ?? bellButton().textContent).toMatch(/Alerts: 2/))

  const panel = await openBell()
  const group = within(panel).getByRole('group', { name: 'Books · TCS' })
  expect(within(group).getByText('Margin is partial')).toBeTruthy()
  fireEvent.click(within(group).getAllByRole('button', { name: 'Dismiss' })[1] as HTMLElement)
  expect(within(panel).queryByText('Margin is partial')).toBe(null)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Alerts: 1' })).toBeTruthy())

  fireEvent.click(within(panel).getByRole('button', { name: '1 hidden — show' }))
  expect(within(panel).getByText('Margin is partial')).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Alerts: 2' })).toBeTruthy())
})

test('a dead feed turns the bell red with a "Feed dead" pill', async () => {
  mount(() => ({ body: bookView({ warnings: ['the price feed is not ticking: every price below is the last one seen, not a live one'] }) }))
  await screen.findByText('as of 10:27 IST')
  await waitFor(() => expect(screen.getByText('Feed dead')).toBeTruthy())
  expect(bellButton().closest('.traders-bell')?.getAttribute('data-state')).toBe('alert')
})

test('a book that cannot load says so on the page and turns the bell red with "Refresh failed"', async () => {
  mount(() => ({ status: 500, body: { error: 'boom' } }))
  await screen.findByText(/Could not load TCS/)
  await waitFor(() => expect(screen.getByText('Refresh failed')).toBeTruthy())
  expect(bellButton().closest('.traders-bell')?.getAttribute('data-state')).toBe('alert')
  const panel = await openBell()
  expect(within(panel).getByText(/Could not load TCS/)).toBeTruthy()
})

test('a closed market is a quiet "Market closed" pill; Esc-free close by clicking away', async () => {
  mount(() => ({ body: bookView({ closed: true, warnings: [] }) }))
  await screen.findByText('as of 10:27 IST')
  await waitFor(() => expect(screen.getByText('Market closed')).toBeTruthy())
  expect(bellButton().closest('.traders-bell')?.getAttribute('data-state')).toBe('none')
  await openBell()
  expect(screen.getByText('Nothing to report')).toBeTruthy()
  fireEvent.mouseDown(document.body)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Alerts and warnings' })).toBe(null))
})
