/**
 * The credential form: what it shows, and what it writes.
 *
 * Two properties, both of which fail quietly. A form that RENDERS a secret puts
 * it in every screenshot of this page; a form that writes an empty secret
 * destroys a working credential while reporting success, and the next thing
 * anyone learns about it is that the gateway will not log in.
 *
 * The DX desk has TWO Delta cards: Delta Exchange India (live) and, below it,
 * Delta Demo (testnet), where paper books on the Demo rail trade. XTS is gone
 * from the api (it 404s the kind) and Zerodha is not this desk's, so neither
 * gets a card even when the list carries a row for it.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { BrokersSection, DELTA_DEMO_BASE_URL } from '../src/brokers.tsx'
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
    if (path === '/v1/desk/brokers/delta-demo/test') return { body: { ok: true, verifiedAt: 1_700_000_100_000, note: 'testnet wallet ok' } }
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

/** One card, by the broker it is for (the group's name is the kind's label, not the stored one). */
const card = (name: 'Delta Exchange India' | 'Delta Demo (testnet)'): ReturnType<typeof within> =>
  within(screen.getByRole('group', { name }))

async function openEditor(
  heading = 'Delta live',
  name: 'Delta Exchange India' | 'Delta Demo (testnet)' = 'Delta Exchange India',
): Promise<void> {
  await screen.findByText(heading)
  act(() => { card(name).getByRole('button', { name: 'Edit credentials' }).click() })
  await screen.findByLabelText('API key')
}

describe('the broker cards', () => {
  test('two Delta cards, live then demo — no XTS, no Zerodha, even when the list has a zerodha row', async () => {
    mountBrokers()
    await screen.findByText('Delta live')
    expect(screen.getAllByRole('button', { name: 'Edit credentials' })).toHaveLength(2)
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['Delta Exchange India', 'Delta Demo (testnet)'])
    expect(screen.queryByText(/XTS/)).toBe(null)
    expect(screen.queryByText(/Zerodha/)).toBe(null)
    // The base URL is on the card: it is where the gateway signs its requests to.
    expect(screen.getByText('https://api.india.delta.exchange')).toBeTruthy()
  })

  test('Test connection posts to the delta kind and shows the verdict', async () => {
    const sent = mountBrokers()
    await screen.findByText('Delta live')
    act(() => { card('Delta Exchange India').getByRole('button', { name: 'Test connection' }).click() })
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/v1/desk/brokers/delta/test')).toBe(true))
    expect(sent.some((r) => r.path === '/v1/desk/brokers/delta-demo/test')).toBe(false)
    expect(await screen.findByText('Login succeeded')).toBeTruthy()
    expect(sent.some((r) => r.path.includes('/xts') || r.path.includes('/zerodha'))).toBe(false)
  })
})

describe('the Delta Demo (testnet) card', () => {
  const DEMO_ROW = {
    kind: 'delta-demo', label: 'Delta Demo (testnet)', meta: { baseUrl: DELTA_DEMO_BASE_URL },
    configured: true, state: 'ok', lastVerifiedAt: null, lastError: null,
  }

  test('an unconfigured demo card is drawn anyway, and its form defaults to the testnet host', async () => {
    const sent = mountBrokers([DELTA_ROW])
    await openEditor('Delta Demo (testnet)', 'Delta Demo (testnet)')
    expect(DELTA_DEMO_BASE_URL).toBe('https://cdn-ind.testnet.deltaex.org')
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe(DELTA_DEMO_BASE_URL)
    type('API key', 'demo-k')
    type('API secret', 'demo-s')
    act(() => { screen.getByRole('button', { name: 'Save credential' }).click() })
    await waitFor(() => expect(puts(sent).length).toBe(1))
    // The demo kind, never the live one: testnet keys must not land on the production row.
    expect(puts(sent)[0]?.path).toBe('/v1/desk/brokers/delta-demo')
    expect(puts(sent)[0]?.body).toEqual({
      label: 'Delta Demo (testnet)',
      meta: { baseUrl: DELTA_DEMO_BASE_URL },
      secret: { apiKey: 'demo-k', apiSecret: 'demo-s' },
    })
  })

  test('the demo card shows its stored testnet URL, and Test posts to the demo kind only', async () => {
    const sent = mountBrokers([DELTA_ROW, DEMO_ROW])
    await screen.findByText('Delta live')
    expect(card('Delta Demo (testnet)').getByText(DELTA_DEMO_BASE_URL)).toBeTruthy()
    act(() => { card('Delta Demo (testnet)').getByRole('button', { name: 'Test connection' }).click() })
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/v1/desk/brokers/delta-demo/test')).toBe(true))
    expect(sent.some((r) => r.path === '/v1/desk/brokers/delta/test')).toBe(false)
    expect(await card('Delta Demo (testnet)').findByText('Login succeeded')).toBeTruthy()
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
