/** The Admin page: the trader table, its actions, the once-only token and the manual upload. */
import { expect, test, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { installFetch, type SentRequest } from '../http.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import type { AdminTraderRow } from '../../../traders/src/types.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setAsTrader(null); window.location.hash = '' })

const HB = new Date('2026-10-19T10:27:00+05:30').getTime()
const ROWS: AdminTraderRow[] = [
  {
    username: 'ravi', disabled: false, lastLoginAt: HB,
    watcher: { lastHeartbeatAt: HB, lastUploadAt: HB, version: '1.0.0', folder: 'C:\\ODIN', fileCount: 3 },
    token: { createdAt: HB, lastUsedAt: HB },
  },
  { username: 'sita', disabled: true, lastLoginAt: null, watcher: null, token: null },
]

function mount(extra?: (r: { path: string; method: string }) => { status?: number; body?: unknown } | null): SentRequest[] {
  const sent = installFetch((req) => {
    const x = extra?.(req)
    if (x !== null && x !== undefined) return x
    if (req.path === '/v1/traders/auth/me') return { body: { username: 'root', role: 'admin' } }
    if (req.path === '/v1/traders/admin/traders' && req.method === 'GET') return { body: ROWS }
    return { body: {} }
  })
  window.location.hash = '#/admin'
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  return sent
}

// The admin's trader picker lists the same names; the table row is the one inside a <tr>.
const rowOf = (name: string): HTMLElement =>
  screen.getAllByText(name).map((e) => e.closest('tr')).find((r) => r !== null) as HTMLElement

test('admin lists traders with watcher and token state', async () => {
  mount()
  await screen.findByText('last heartbeat 10:27 · v1.0.0 · 3 files')
  expect(within(rowOf('ravi')).getByText('issued 2026-10-19, last used 10:27')).toBeTruthy()
  // sita never logged in and her watcher never reported.
  expect(within(rowOf('sita')).getByText('never')).toBeTruthy()
  expect(within(rowOf('sita')).getByText('never connected')).toBeTruthy()
  expect(within(rowOf('sita')).getByRole('button', { name: 'Enable' })).toBeTruthy()
  expect(within(rowOf('ravi')).getByRole('button', { name: 'Disable' })).toBeTruthy()
  expect(within(rowOf('sita')).queryByRole('button', { name: 'Revoke token' })).toBeNull()
})

test('admin calls never carry ?as=', async () => {
  const sent = mount()
  await screen.findByText('last heartbeat 10:27 · v1.0.0 · 3 files')
  expect(sent.filter((r) => r.path.includes('/admin/')).every((r) => !r.url.includes('as='))).toBe(true)
})

test('add, disable and reset send the right calls', async () => {
  const sent = mount()
  await screen.findByText('last heartbeat 10:27 · v1.0.0 · 3 files')

  fireEvent.click(screen.getByRole('button', { name: 'Add trader' }))
  let dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: ' Mohan ' } })
  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'longenough1' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create trader' }))
  await waitFor(() => expect(sent.find((r) => r.method === 'POST' && r.path === '/v1/traders/admin/traders')?.body)
    .toEqual({ username: 'mohan', password: 'longenough1' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  fireEvent.click(within(rowOf('ravi')).getByRole('button', { name: 'Disable' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable trader' }))
  await waitFor(() => expect(sent.find((r) => r.method === 'PATCH' && r.path === '/v1/traders/admin/traders/ravi')?.body)
    .toEqual({ disabled: true }))

  fireEvent.click(within(rowOf('sita')).getByRole('button', { name: 'Reset password' }))
  dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: 'another-pass' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Set password' }))
  await waitFor(() => expect(sent.find((r) => r.method === 'PATCH' && r.path === '/v1/traders/admin/traders/sita')?.body)
    .toEqual({ password: 'another-pass' }))
})

test('an issued token is shown once', async () => {
  const sent = mount(({ path, method }) =>
    path === '/v1/traders/admin/traders/ravi/token' && method === 'POST' ? { body: { token: 'tok_123abc' } } : null)
  await screen.findByText(/last heartbeat 10:27 · v1.0.0 · 3 files/)
  fireEvent.click(within(rowOf('ravi')).getByRole('button', { name: 'Issue token' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue new token' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('tok_123abc')).toBeTruthy()
  expect(within(dialog).getByText('Copy it now — it is not shown again')).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'Copy token' })).toBeTruthy()
  expect(sent.some((r) => r.method === 'POST' && r.path === '/v1/traders/admin/traders/ravi/token')).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(screen.queryByText('tok_123abc')).toBeNull())
  expect(document.body.textContent).not.toContain('tok_123abc')
})

test('revoke token calls DELETE', async () => {
  const sent = mount()
  await screen.findByText('last heartbeat 10:27 · v1.0.0 · 3 files')
  fireEvent.click(within(rowOf('ravi')).getByRole('button', { name: 'Revoke token' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/watcher stops syncing until a new token/)).toBeTruthy()
  expect(sent.some((r) => r.method === 'DELETE')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke token' }))
  await waitFor(() => expect(sent.some((r) => r.method === 'DELETE' && r.path === '/v1/traders/admin/traders/ravi/token')).toBe(true))
})

test('cancelling a revoke, a re-issue or a disable sends nothing', async () => {
  const sent = mount()
  await screen.findByText(/last heartbeat 10:27/)
  for (const name of ['Revoke token', 'Issue token', 'Disable']) {
    fireEvent.click(within(rowOf('ravi')).getByRole('button', { name }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep as is' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  }
  expect(sent.filter((r) => r.method !== 'GET')).toEqual([])
})

test('two rapid clicks on Issue send exactly one POST', async () => {
  const sent = mount(({ path, method }) =>
    path === '/v1/traders/admin/traders/sita/token' && method === 'POST' ? { body: { token: 'tok_once' } } : null)
  await screen.findByText(/last heartbeat 10:27/)
  const btn = within(rowOf('sita')).getByRole('button', { name: 'Issue token' })
  fireEvent.click(btn)
  fireEvent.click(btn)
  await screen.findByText('tok_once')
  expect(sent.filter((r) => r.method === 'POST' && r.path.endsWith('/sita/token')).length).toBe(1)
})

test('a heartbeat 179 s old is online, 181 s old is offline (fixed clock)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(HB + 179_000)
  const first = mount()
  void first
  await screen.findByText('online')
  cleanup()
  vi.setSystemTime(HB + 181_000)
  mount()
  await screen.findByText('offline')
})

test('copy on plain HTTP (no clipboard) says what to do and keeps the token', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
  mount(({ path, method }) =>
    path === '/v1/traders/admin/traders/sita/token' && method === 'POST' ? { body: { token: 'tok_plain' } } : null)
  await screen.findByText(/last heartbeat 10:27/)
  fireEvent.click(within(rowOf('sita')).getByRole('button', { name: 'Issue token' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Copy token' }))
  await within(dialog).findByText("Copy didn't work here — the token is selected, press Ctrl+C")
  expect(within(dialog).getByText('tok_plain')).toBeTruthy()
})

test('manual upload PUTs the raw file and shows the parse result', async () => {
  const sent = mount(({ path, method }) =>
    path === '/v1/traders/admin/traders/ravi/files' && method === 'PUT'
      ? { body: { stored: true, parser: 'odin-nse-fo-trades', parseError: null } } : null)
  await screen.findByText('last heartbeat 10:27 · v1.0.0 · 3 files')
  fireEvent.click(within(rowOf('ravi')).getByRole('button', { name: 'Upload file' }))
  const dialog = await screen.findByRole('dialog')
  const input = dialog.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['a|b'], '1019TRD.TXT')] } })
  await waitFor(() => expect((within(dialog).getByLabelText('Path') as HTMLInputElement).value).toBe('1019TRD.TXT'))
  fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: 'Nse Derivatives/Trades/1019TRD.TXT' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }))
  await within(dialog).findByText(/odin-nse-fo-trades/)
  const put = sent.find((r) => r.method === 'PUT')
  expect(put?.url).toContain('/v1/traders/admin/traders/ravi/files?path=Nse%20Derivatives%2FTrades%2F1019TRD.TXT')
  expect(put?.headers['content-type']).toBe('application/octet-stream')
})

test('a parse error is shown', async () => {
  mount(({ path, method }) =>
    path === '/v1/traders/admin/traders/ravi/files' && method === 'PUT'
      ? { body: { stored: true, parser: 'odin-nse-fo-trades', parseError: 'line 2: bad price' } } : null)
  await screen.findByText('last heartbeat 10:27 · v1.0.0 · 3 files')
  fireEvent.click(within(rowOf('ravi')).getByRole('button', { name: 'Upload file' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['x'], 'a.TXT')] } })
  await waitFor(() => expect((within(dialog).getByLabelText('Path') as HTMLInputElement).value).toBe('a.TXT'))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }))
  await within(dialog).findByText(/line 2: bad price/)
})
