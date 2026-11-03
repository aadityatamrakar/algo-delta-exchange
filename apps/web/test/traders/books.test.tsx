/** The Books page: tabs, the book tab, add leg, and the admin's trader pick. */
import { expect, test, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { installFetch, type SentRequest } from '../http.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import type { BookView } from '../../../traders/src/types.ts'
import { BOOK_TCS, EMPTY_PAYOFF, MANUAL_SHARES, bookView, openNotes, summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null); window.localStorage.clear() })

const TRADER = { username: 'ravi', role: 'trader' }

/** Opens the bell at the top right and returns its panel. */
async function openBell(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /^Alerts/ }))
  return await screen.findByRole('dialog', { name: 'Alerts and warnings' })
}

function mountTrader(
  stocks: string[],
  book: (stock: string) => unknown = () => BOOK_TCS,
  extra?: (r: { path: string; method: string; body: Record<string, unknown> | null }) => { status?: number; body?: unknown } | null,
): SentRequest[] {
  const sent = installFetch((req) => {
    const x = extra?.(req)
    if (x !== null && x !== undefined) return x
    if (req.path === '/v1/traders/auth/me') return { body: TRADER }
    if (req.path === '/v1/traders/books') return { body: summaries(...stocks) }
    if (req.path.startsWith('/v1/traders/books/') && req.method === 'GET') {
      return { body: book(decodeURIComponent(req.path.slice('/v1/traders/books/'.length))) }
    }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  return sent
}

test('one tab per open book; clicking a tab loads that book', async () => {
  const sent = mountTrader(['JINDALSTEL', 'NIFTY', 'TCS'])
  for (const s of ['JINDALSTEL', 'NIFTY', 'TCS']) await screen.findByRole('tab', { name: new RegExp(s) })
  fireEvent.click(screen.getByRole('tab', { name: /NIFTY/ }))
  await waitFor(() => expect(sent.some((r) => r.path === '/v1/traders/books/NIFTY')).toBe(true))
})

test('a symbol with & is encoded in the request', async () => {
  const sent = mountTrader(['M&M'], () => bookView({ stock: 'M&M' }))
  await screen.findByRole('tab', { name: /M&M/ })
  await waitFor(() => expect(sent.some((r) => r.url.includes('/v1/traders/books/M%26M'))).toBe(true))
})

test('the book tab shows manual and not-understood legs, the history line and the warnings', async () => {
  mountTrader(['TCS'])
  // The history line is behind the ⓘ by the book's name; the not-understood list sits under the legs.
  fireEvent.click(await screen.findByRole('button', { name: "About this book's history" }))
  expect(screen.getByText('Trade history starts 2026-08-25; positions opened before it, and shares delivered at expiry, must be added by hand.')).toBeTruthy()
  expect(screen.getByText('manual')).toBeTruthy()
  expect(screen.getByText('not understood: TCS 3550 CE 2026-10-27 (client C1) — no such contract')).toBeTruthy()
  expect(screen.getByText('as of 10:27 IST')).toBeTruthy()
  // The book's warnings are in the bell, not on the page.
  expect(screen.queryByText('Watcher offline since 09:10')).toBe(null)
  expect(within(await openBell()).getByText('Watcher offline since 09:10')).toBeTruthy()
  expect(screen.getAllByText('CE · not understood').length).toBe(1)
  // Edit/Delete only on the manual row.
  expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBe(1)
  expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBe(1)
})

test('no history yet, a closed market, and the empty payoff mounts the shared chart', async () => {
  mountTrader(['TCS'], () => bookView({ historyFrom: null, closed: true, warnings: [], payoff: EMPTY_PAYOFF }))
  fireEvent.click(await screen.findByRole('button', { name: "About this book's history" }))
  expect(screen.getByText('No ODIN trade files yet')).toBeTruthy()
  await waitFor(() => expect(screen.getByText('Market closed')).toBeTruthy())   // the bell's pill
  expect(screen.queryByText("Market closed — last session's prices")).toBe(null)
  expect(await screen.findByText(/The scan came back empty/)).toBeTruthy()   // the chart is a block of its own, no fold
})

test('an empty account shows the empty state', async () => {
  mountTrader([])
  await screen.findByText('No open books')
})

test('the empty state says what the watcher and the files are doing', async () => {
  const now = Date.now()
  const file = (path: string, over: Record<string, unknown>) =>
    ({ trader: 'ravi', path, sha256: '0', size: 1, mtime: 0, receivedAt: now, parser: 'odin-nse-fo-trades', parseError: null, ...over })
  const sent = mountTrader([], undefined, ({ path }) => {
    if (path === '/v1/traders/watcher') return { body: { lastHeartbeatAt: now - 600_000, lastUploadAt: null, version: '1.2', folder: 'C:\\ODIN', fileCount: 9 } }
    if (path === '/v1/traders/files') {
      return { body: [
        file('Nse Derivatives/Trades/1020TRD.TXT', { parseError: 'no line could be read; line 1: expected 25 or 28 fields, got 26' }),
        file('Nse Derivatives/Trades/1019TRD.TXT', {}),
        file('Nse Derivatives/Trades/1016TRD.TXT', { skipped: [{ lineNo: 4, reason: 'bad side' }, { lineNo: 9, reason: 'x' }] }),
      ] }
    }
    return null
  })
  await screen.findByText('No open books')
  await screen.findByText(/^Watcher offline — last heartbeat \d\d:\d\d · v1\.2 · 9 files$/)
  // The file problems are warnings: in the bell.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Alerts: 2' })).toBeTruthy())
  const bell = await openBell()
  expect(within(bell).getByText('Nse Derivatives/Trades/1020TRD.TXT did not parse: no line could be read; line 1: expected 25 or 28 fields, got 26')).toBeTruthy()
  expect(within(bell).getByText('2 lines of Nse Derivatives/Trades/1016TRD.TXT were skipped: line 4: bad side')).toBeTruthy()
  expect(screen.queryByText(/1019TRD/)).toBe(null)   // a clean file is not a problem
  expect(sent.some((r) => r.path === '/v1/traders/files')).toBe(true)
})

test('the empty state for a trader whose watcher never reported', async () => {
  mountTrader([], undefined, ({ path }) => (path === '/v1/traders/watcher' ? { body: null } : path === '/v1/traders/files' ? { body: [] } : null))
  await screen.findByText('Watcher never connected — positions come only from manual uploads')
})

test('the payoff engine\'s own warnings show under the chart', async () => {
  const payoff = { curve: [], warnings: ['no legs: nothing to price', 'unusable rate NaN: priced at 0.065'] } as unknown as NonNullable<BookView['payoff']>
  mountTrader(['TCS'], () => bookView({ payoff }))
  await screen.findByText(/The scan came back empty/)
  const list = screen.getByRole('list', { name: 'Payoff warnings' })
  openNotes(list)
  expect(within(list).getByText('no legs: nothing to price')).toBeTruthy()
  expect(within(list).getByText('unusable rate NaN: priced at 0.065')).toBeTruthy()
})

test('add leg posts the form and reloads the book', async () => {
  const sent = mountTrader(['TCS'], () => BOOK_TCS, ({ path, method }) =>
    path === '/v1/traders/books/TCS/legs' && method === 'POST' ? { body: MANUAL_SHARES } : null)
  await screen.findByText('as of 10:27 IST')
  fireEvent.click(screen.getByRole('button', { name: 'Add leg' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Quantity (shares)'), { target: { value: '1000' } })
  fireEvent.change(within(dialog).getByLabelText('Average price'), { target: { value: '3000' } })
  const before = sent.filter((r) => r.path === '/v1/traders/books/TCS' && r.method === 'GET').length
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save leg' }))
  await waitFor(() => expect(sent.filter((r) => r.path === '/v1/traders/books/TCS' && r.method === 'GET').length).toBeGreaterThan(before))
  const post = sent.find((r) => r.method === 'POST' && r.path === '/v1/traders/books/TCS/legs')
  expect(post?.body).toEqual({ instrument: 'share', expiry: '', strike: null, optType: null, qty: 1000, avgPrice: 3000, note: '' })
})

test('the lot count shows under the quantity, and a bad quantity is refused before any request', async () => {
  const sent = mountTrader(['TCS'])
  await screen.findByText('as of 10:27 IST')
  fireEvent.click(screen.getByRole('button', { name: 'Add leg' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Quantity (shares)'), { target: { value: '-350' } })
  expect(within(dialog).getByText(/-2 lots/)).toBeTruthy()
  fireEvent.change(within(dialog).getByLabelText('Quantity (shares)'), { target: { value: '0' } })
  fireEvent.change(within(dialog).getByLabelText('Average price'), { target: { value: '10' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save leg' }))
  await within(dialog).findByText(/non-zero whole number/)
  expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/legs'))).toBe(false)
})

test('deleting a manual leg asks first, then sends DELETE on the encoded key', async () => {
  const sent = mountTrader(['TCS'], () => BOOK_TCS, ({ path, method }) =>
    method === 'DELETE' ? { body: {} } : path === '' ? null : null)
  await screen.findByText('as of 10:27 IST')
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  const dialog = await screen.findByRole('dialog')
  expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete leg' }))
  await waitFor(() => expect(sent.some((r) => r.method === 'DELETE' && r.path === '/v1/traders/legs/manual%3Aabc')).toBe(true))
})

test("an admin with no trader picked sees a prompt, not an error", async () => {
  installFetch(({ path }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'boss', role: 'admin' } }
    if (path === '/v1/traders/books') return { status: 400, body: { error: 'pick a trader' } }
    if (path === '/v1/traders/admin/traders') return { body: [{ username: 'sita', disabled: false, lastLoginAt: null, watcher: null, token: null }] }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  await screen.findByText('Pick a trader to see their books')
  expect(screen.queryByText(/Could not load/)).toBe(null)
})

test("an admin's pick is sent as ?as=, and not on /admin/ calls", async () => {
  const sent = installFetch(({ path, url }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'boss', role: 'admin' } }
    if (path === '/v1/traders/books') return url.searchParams.get('as') === 'sita' ? { body: summaries('TCS') } : { status: 400, body: { error: 'pick a trader' } }
    if (path === '/v1/traders/admin/traders') return { body: [{ username: 'sita', disabled: false, lastLoginAt: null, watcher: null, token: null }] }
    if (path.startsWith('/v1/traders/books/')) return { body: BOOK_TCS }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  await screen.findByText('Pick a trader to see their books')
  const trigger = await waitFor(() => {
    const el = screen.queryByRole('combobox', { name: 'Trader' }) ?? screen.queryByRole('button', { name: 'Trader' })
    if (el === null) throw new Error('no picker')
    return el
  })
  act(() => { trigger.click() })
  act(() => { screen.getByRole('option', { name: 'sita' }).click() })
  await screen.findByRole('tab', { name: /TCS/ })
  expect(sent.some((r) => r.path === '/v1/traders/books' && r.url.includes('as=sita'))).toBe(true)
  await waitFor(() => expect(sent.some((r) => r.path === '/v1/traders/books/TCS' && r.url.includes('as=sita'))).toBe(true))
  expect(sent.filter((r) => r.path.includes('/admin/')).every((r) => !r.url.includes('as='))).toBe(true)
  expect(sent.filter((r) => r.path.includes('/auth/')).every((r) => !r.url.includes('as='))).toBe(true)
})

test('editing a manual leg patches quantity, price and note on the encoded key', async () => {
  const sent = mountTrader(['TCS'], () => BOOK_TCS, ({ method }) => (method === 'PATCH' ? { body: MANUAL_SHARES } : null))
  await screen.findByText('as of 10:27 IST')
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Quantity (shares)'), { target: { value: '700' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent.some((r) => r.method === 'PATCH')).toBe(true))
  const patch = sent.find((r) => r.method === 'PATCH')
  expect(patch?.path).toBe('/v1/traders/legs/manual%3Aabc')
  expect(patch?.body).toEqual({ qty: 700, avgPrice: 3012.5, note: 'delivered at expiry' })
})
