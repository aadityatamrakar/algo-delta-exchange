/**
 * The credential form: what it shows, and what it writes.
 *
 * Two properties, both of which fail quietly. A form that RENDERS a secret puts
 * it in every screenshot of this page; a form that writes an empty secret
 * destroys a working credential while reporting success, and the next thing
 * anyone learns about it is that the gateway will not log in.
 *
 * The DX desk has ONE broker, Delta Exchange India. XTS is gone from the api
 * (it 404s the kind) and Zerodha is not this desk's, so neither gets a card
 * even when the list carries a row for it.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { BrokersSection } from '../src/brokers.tsx'
import { installFetch, type SentRequest } from './http.tsx'

const DELTA_ROW = {
  kind: 'delta',
  label: 'Delta live',
  meta: { baseUrl: 'https://api.india.delta.exchange', note: 'kept' },
  configured: true,
  state: 'ok',
  lastVerifiedAt: 1_700_000_000_000,
  lastError: null,
}

const ZERODHA_ROW = {
  kind: 'zerodha', label: 'Zerodha (market data)', meta: {}, configured: false,
  state: 'absent', lastVerifiedAt: null, lastError: null,
}

function mountBrokers(rows: unknown[] = [DELTA_ROW, ZERODHA_ROW]): SentRequest[] {
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/desk/brokers' && method === 'GET') return { body: { brokers: rows } }
    if (path === '/v1/desk/brokers/delta/test') return { body: { ok: true, verifiedAt: 1_700_000_100_000, note: 'signed wallet read ok' } }
    return { body: { ok: true, kind: 'delta' } }
  })
  render(<BrokersSection />)
  return sent
}

const puts = (sent: readonly SentRequest[]): SentRequest[] =>
  sent.filter((r) => r.method === 'PUT')

function type(label: string, value: string): void {
  act(() => {
    const el = screen.getByLabelText(label) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openEditor(heading = 'Delta live'): Promise<void> {
  await screen.findByText(heading)
  act(() => { screen.getByRole('button', { name: 'Edit credentials' }).click() })
  await screen.findByLabelText('API key')
}

describe('the broker cards', () => {
  test('one Delta card — no XTS, no Zerodha, even when the list has a zerodha row', async () => {
    mountBrokers()
    await screen.findByText('Delta live')
    expect(screen.getAllByRole('button', { name: 'Edit credentials' })).toHaveLength(1)
    expect(screen.queryByText(/XTS/)).toBe(null)
    expect(screen.queryByText(/Zerodha/)).toBe(null)
    // The base URL is on the card: it is where the gateway signs its requests to.
    expect(screen.getByText('https://api.india.delta.exchange')).toBeTruthy()
  })

  test('Test connection posts to the delta kind and shows the verdict', async () => {
    const sent = mountBrokers()
    await screen.findByText('Delta live')
    act(() => { screen.getByRole('button', { name: 'Test connection' }).click() })
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/v1/desk/brokers/delta/test')).toBe(true))
    expect(await screen.findByText('Login succeeded')).toBeTruthy()
    expect(sent.some((r) => r.path.includes('/xts') || r.path.includes('/zerodha'))).toBe(false)
  })
})

describe('the broker form', () => {
  test('the credential fields open blank, whatever the server said', async () => {
    mountBrokers([{ ...DELTA_ROW, secret: { apiKey: 'LEAKED-KEY' } }])
    await openEditor()
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('API secret') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('LEAKED-KEY')
  })

  test('saving with the credential fields blank does not send a secret, and keeps meta', async () => {
    const sent = mountBrokers()
    await openEditor()
    act(() => { screen.getByRole('button', { name: 'Save (credential unchanged)' }).click() })
    await waitFor(() => expect(puts(sent).length).toBe(1))
    expect(puts(sent)[0]?.path).toBe('/v1/desk/brokers/delta')
    const body = puts(sent)[0]?.body ?? {}
    expect('secret' in body).toBe(false)
    // A save REPLACES meta server-side: a key the form has no input for survives.
    expect(body['meta']).toEqual({ baseUrl: 'https://api.india.delta.exchange', note: 'kept' })
  })

  test('a first save fills the base URL with the India host, and sends both secret fields', async () => {
    const sent = mountBrokers([])
    await openEditor('Delta Exchange India')
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('https://api.india.delta.exchange')
    type('API key', 'k-1')
    type('API secret', 's-1')
    act(() => { screen.getByRole('button', { name: 'Save credential' }).click() })
    await waitFor(() => expect(puts(sent).length).toBe(1))
    expect(puts(sent)[0]?.body).toEqual({
      label: 'Delta Exchange India',
      meta: { baseUrl: 'https://api.india.delta.exchange' },
      secret: { apiKey: 'k-1', apiSecret: 's-1' },
    })
  })

  test('half a credential cannot be saved', async () => {
    const sent = mountBrokers()
    await openEditor()
    type('API key', 'only-half')
    await screen.findByText('Fill in every credential field, or none')
    expect((screen.getByRole('button', { name: 'Save credential' }) as HTMLButtonElement).disabled).toBe(true)
    expect(puts(sent).length).toBe(0)
  })
})
