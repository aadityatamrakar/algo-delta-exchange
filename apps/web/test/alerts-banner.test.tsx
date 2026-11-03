/**
 * The desk-alerts banner: unacked CRITICAL and WARN alerts on every page, each
 * with an Ack that posts to the bridge and removes it. Info alerts are not a
 * banner's business.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AlertsBanner } from '../src/alerts-banner.tsx'
import { installFetch } from './http.tsx'

const NOW = 1_793_700_000_000

const ALERTS = [
  { id: 'a1', at: NOW - 1000, severity: 'critical', source: 'dx-gateway/backstop', mode: 'live', key: 'k1', message: 'LIVE backstop NOT placed for C-BTC-77000-131126' },
  { id: 'a2', at: NOW - 2000, severity: 'warn', source: 'dx-watchdog', mode: 'paper', key: 'k2', message: 'DEMO cancelled 2 working entry orders' },
  { id: 'a3', at: NOW - 3000, severity: 'info', source: 'x', mode: 'live', key: 'k3', message: 'just so you know' },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

test('critical and warn alerts are shown with their source and rail; info is not', async () => {
  installFetch(({ path }) => (path === '/v1/desk/alerts' ? { body: { alerts: ALERTS } } : { body: {} }))
  render(<AlertsBanner />)
  await waitFor(() => expect(screen.getByText(/backstop NOT placed/)).toBeTruthy())
  expect(screen.getByText(/cancelled 2 working entry orders/)).toBeTruthy()
  expect(screen.queryByText(/just so you know/)).toBeNull()
  expect(screen.getAllByRole('button', { name: /Ack/ })).toHaveLength(2)
  expect(screen.getByText(/dx-gateway\/backstop · LIVE/)).toBeTruthy()
})

test('Ack posts for THAT alert and removes it', async () => {
  let alerts = ALERTS.slice(0, 2)
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/desk/alerts' && method === 'GET') return { body: { alerts } }
    if (path === '/v1/desk/alerts/a1/ack' && method === 'POST') {
      alerts = alerts.filter((a) => a.id !== 'a1')
      return { body: { ok: true } }
    }
    return { status: 404, body: { error: 'no' } }
  })
  render(<AlertsBanner />)
  await waitFor(() => expect(screen.getAllByRole('button', { name: /Ack/ })).toHaveLength(2))
  await act(async () => { screen.getAllByRole('button', { name: /Ack/ })[0]!.click() })
  await waitFor(() => expect(screen.queryByText(/backstop NOT placed/)).toBeNull())
  expect(sent.some((r) => r.method === 'POST' && r.path === '/v1/desk/alerts/a1/ack')).toBe(true)
  expect(screen.getByText(/cancelled 2 working entry orders/)).toBeTruthy()
})

test('nothing unacked, or a bridge that answers without the field: no banner at all', async () => {
  installFetch(() => ({ body: {} }))
  const { container } = render(<AlertsBanner />)
  await new Promise((r) => setTimeout(r, 20))
  expect(container.textContent).toBe('')
})
