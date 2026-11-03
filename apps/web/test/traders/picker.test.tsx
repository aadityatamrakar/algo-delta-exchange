/** The admin's trader picker: it follows the trader list without a reload, and a pick reads that trader at once. */
import { expect, test, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { installFetch, type SentRequest } from '../http.tsx'
import { setAsTrader, tapi } from '../../src/traders/api.ts'
import type { AdminTraderRow } from '../../../traders/src/types.ts'
import { BOOK_TCS, summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null) })

const row = (username: string): AdminTraderRow => ({ username, disabled: false, lastLoginAt: null, watcher: null, token: null })

function mount(rows: AdminTraderRow[], nehasBooks: unknown = summaries('TCS')): SentRequest[] {
  const sent = installFetch(({ path, method, url, body }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'boss', role: 'admin' } }
    if (path === '/v1/traders/admin/traders' && method === 'GET') return { body: rows }
    if (path === '/v1/traders/admin/traders' && method === 'POST') { rows.push(row((body as { username: string }).username)); return { body: {} } }
    if (path === '/v1/traders/books') return url.searchParams.get('as') === 'neha' ? { body: nehasBooks } : { status: 400, body: { error: 'pick a trader' } }
    if (path === '/v1/traders/files') return { body: [] }
    if (path === '/v1/traders/watcher') return { body: null }
    if (path.startsWith('/v1/traders/books/')) return { body: BOOK_TCS }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  return sent
}

async function openPicker(): Promise<void> {
  const trigger = await waitFor(() => {
    const el = screen.queryByRole('combobox', { name: 'Trader' }) ?? screen.queryByRole('button', { name: 'Trader' })
    if (el === null) throw new Error('no picker')
    return el
  })
  act(() => { trigger.click() })
}

test('a trader added in Admin is in the picker at once, with no reload', async () => {
  const sent = mount([row('sita')])
  await screen.findByText('Pick a trader to see their books')
  await waitFor(() => expect(sent.filter((r) => r.path === '/v1/traders/admin/traders').length).toBe(1))
  await act(async () => { await tapi.addTrader('neha', 'secret-12') })
  await waitFor(() => expect(sent.filter((r) => r.path === '/v1/traders/admin/traders' && r.method === 'GET').length).toBe(2))
  await openPicker()
  expect(await screen.findByRole('option', { name: 'neha' })).toBeTruthy()
})

test('coming back to the tab re-reads the trader list (another admin added one)', async () => {
  const rows = [row('sita')]
  const sent = mount(rows)
  await screen.findByText('Pick a trader to see their books')
  await waitFor(() => expect(sent.filter((r) => r.path === '/v1/traders/admin/traders').length).toBe(1))
  rows.push(row('neha'))
  act(() => { fireEvent.focus(window) })
  await waitFor(() => expect(sent.filter((r) => r.path === '/v1/traders/admin/traders').length).toBe(2))
  await openPicker()
  expect(await screen.findByRole('option', { name: 'neha' })).toBeTruthy()
})

// The page is keyed on the pick (app.tsx), so its polls start again at once; the 15 s poll is never waited for.
test('picking a trader reads their books at once, not at the next 15 s poll', async () => {
  const sent = mount([row('neha')])
  await screen.findByText('Pick a trader to see their books')
  await openPicker()
  act(() => { screen.getByRole('option', { name: 'neha' }).click() })
  for (const path of ['/v1/traders/books', '/v1/traders/books/TCS']) {
    await waitFor(() => expect(sent.some((r) => r.path === path && r.url.includes('as=neha'))).toBe(true), { timeout: 1_000 })
  }
  expect(await screen.findByRole('tab', { name: /TCS/ })).toBeTruthy()
})

test('picking a trader with no open book reads their files and watcher at once', async () => {
  const sent = mount([row('neha')], [])
  await screen.findByText('Pick a trader to see their books')
  await openPicker()
  act(() => { screen.getByRole('option', { name: 'neha' }).click() })
  await screen.findByText('No open books')
  for (const path of ['/v1/traders/files', '/v1/traders/watcher']) {
    await waitFor(() => expect(sent.some((r) => r.path === path && r.url.includes('as=neha'))).toBe(true), { timeout: 1_000 })
  }
})
