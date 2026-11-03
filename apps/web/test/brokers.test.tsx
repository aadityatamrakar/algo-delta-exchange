/**
 * The credential form: what it shows, and what it writes.
 *
 * Two properties, both of which fail quietly. A form that RENDERS a secret puts
 * it in every screenshot of this page; a form that writes an empty secret
 * destroys a working credential while reporting success, and the next thing
 * anyone learns about it is that the gateway will not log in.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { BrokersSection } from '../src/brokers.tsx'
import { installFetch, type SentRequest } from './http.tsx'

const XTS_ROW = {
  kind: 'xts',
  label: 'XTS live',
  meta: { baseUrl: 'https://xts.example', uniqueKey: 'UK-1', clientId: 'DEALER01', prefix: 'enms' },
  configured: true,
  state: 'ok',
  lastVerifiedAt: 1_700_000_000_000,
  lastError: null,
}

function mountBrokers(): SentRequest[] {
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/desk/brokers' && method === 'GET') return { body: { brokers: [XTS_ROW] } }
    return { body: { ok: true, kind: 'xts' } }
  })
  render(<BrokersSection />)
  return sent
}

const puts = (sent: readonly SentRequest[]): SentRequest[] =>
  sent.filter((r) => r.method === 'PUT')

/** The XTS card is the first of the two; Zerodha has an Edit button too. */
async function openEditor(): Promise<void> {
  await screen.findByText('XTS live')
  const edit = screen.getAllByRole('button', { name: 'Edit credentials' })[0]
  expect(edit).toBeTruthy()
  act(() => { edit?.click() })
  await screen.findByLabelText('App key')
}

describe('the broker form', () => {
  test('the credential fields open blank, whatever the server said', async () => {
    // A row that (wrongly) carried a secret back must still not put it on
    // screen. Nothing here reads from the response into a credential input.
    installFetch(({ path }) =>
      path === '/v1/desk/brokers'
        ? { body: { brokers: [{ ...XTS_ROW, secret: { appKey: 'LEAKED-KEY' } }] } }
        : { body: {} })
    render(<BrokersSection />)
    await openEditor()

    expect((screen.getByLabelText('App key') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Secret key') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('LEAKED-KEY')
  })

  test('saving with the credential fields blank does not send a secret', async () => {
    const sent = mountBrokers()
    await openEditor()

    // The button says which of the two saves this is, before it is pressed.
    const save = screen.getByRole('button', { name: 'Save (credential unchanged)' })
    act(() => { save.click() })

    await waitFor(() => expect(puts(sent).length).toBe(1))
    const body = puts(sent)[0]?.body ?? {}
    // Not `secret: {}` — ABSENT. An empty object is a value, and the server
    // would have every right to seal it over the working credential.
    expect('secret' in body).toBe(false)
    expect(body['meta']).toMatchObject({ baseUrl: 'https://xts.example' })
  })

  test('a save preserves meta keys the form has no input for', async () => {
    const sent = mountBrokers()
    await openEditor()
    act(() => { screen.getByRole('button', { name: 'Save (credential unchanged)' }).click() })

    await waitFor(() => expect(puts(sent).length).toBe(1))
    // `prefix` is read by the gateway and has no field here. A save REPLACES
    // meta server-side, so dropping it would silently change how the process
    // logs in — from a dialog the operator opened to fix a label.
    expect((puts(sent)[0]?.body?.['meta'] as Record<string, unknown>)['prefix']).toBe('enms')
  })

  test('half a credential cannot be saved', async () => {
    const sent = mountBrokers()
    await openEditor()

    act(() => {
      const el = screen.getByLabelText('App key') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(el, 'only-half')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The credential is sealed as ONE blob: writing half of it destroys the
    // other half, so the form refuses rather than doing it.
    await screen.findByText('Fill in every credential field, or none')
    expect((screen.getByRole('button', { name: 'Save credential' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect(puts(sent).length).toBe(0)
  })

  test('the dealer client code is on the card and in the form', async () => {
    mountBrokers()
    // On the card, because it is an account identifier and not a credential —
    // an operator has to be able to see what the gateway will stamp orders with.
    await screen.findByText('Client code (dealer accounts)')
    expect(screen.getByText('DEALER01')).toBeTruthy()

    await openEditor()
    expect((screen.getByLabelText('Client code (dealer accounts)') as HTMLInputElement).value)
      .toBe('DEALER01')
  })
})
