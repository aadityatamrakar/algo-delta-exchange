/**
 * The gate: who gets to see the desk, and what leaves the browser.
 *
 * The three properties pinned here all fail SILENTLY and all look like
 * something else when they do — an unprotected page looks like a page, a dead
 * session looks like a quiet desk, and a compiled-in bearer looks like being
 * logged in. None of them is visible by using the app normally.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AuthGate, AuthProvider, useAuth } from '../src/auth.tsx'
import { api } from '../src/api.ts'
import { installFetch, type SentRequest } from './http.tsx'

const SESSION = { username: 'aaditya', kind: 'user', expiresAt: Date.now() + 3_600_000 }

/** Something inside the gate that can make a call, the way a poll would. */
function Inside(): React.ReactElement {
  const { session } = useAuth()
  return (
    <div>
      <span data-testid="who">{session?.username ?? '—'}</span>
      <button type="button" onClick={() => void api.killSwitch().catch(() => {})}>poll</button>
    </div>
  )
}

function mount(): void {
  render(
    <AuthProvider>
      <AuthGate><Inside /></AuthGate>
    </AuthProvider>,
  )
}

describe('the auth gate', () => {
  test('with no session, any route shows login and the hash says so', async () => {
    window.location.hash = '#/controls'
    installFetch(({ path }) =>
      path === '/v1/auth/me' ? { status: 401, body: { error: 'no session' } } : { body: {} })

    mount()

    await screen.findByLabelText('Password')
    // The address bar must not claim you are on a page you are not being shown.
    await waitFor(() => expect(window.location.hash).toBe('#/login'))
    // And nothing behind the gate was rendered at all.
    expect(screen.queryByTestId('who')).toBe(null)
  })

  test('a 401 mid-session returns to login', async () => {
    let sessionAlive = true
    installFetch(({ path }) => {
      if (path === '/v1/auth/me') return { body: SESSION }
      if (!sessionAlive) return { status: 401, body: { error: 'session expired' } }
      return { body: {} }
    })

    mount()
    await screen.findByTestId('who')

    // The session dies between polls — an expiry, a restart, a revoked token.
    sessionAlive = false
    act(() => { screen.getByText('poll').click() })

    // Not "keep rendering the last numbers we saw": a dashboard whose every
    // request is failing behind a still-rendered book reads as a quiet desk.
    await screen.findByLabelText('Password')
    expect(screen.queryByTestId('who')).toBe(null)
  })

  test('a reload keeps you signed in, because the cookie is not in this page', async () => {
    const sent = installFetch(({ path }) =>
      path === '/v1/auth/me' ? { body: SESSION } : { body: {} })

    mount()
    await screen.findByTestId('who')
    expect(screen.getByTestId('who').textContent).toBe('aaditya')

    // The login copy used to promise the opposite of this.
    expect(screen.queryByText(/reload signs you out/i)).toBe(null)
    expectNoBearer(sent)
  })

  test('a machine principal is not an operator', async () => {
    installFetch(({ path }) =>
      path === '/v1/auth/me'
        ? { body: { username: 'bearer', kind: 'machine', expiresAt: null } }
        : { body: {} })

    mount()

    // It can read the bridge, but it can never satisfy re-auth — coming up
    // "signed in" as one means every live switch fails three layers away.
    await screen.findByLabelText('Password')
  })

  test('the client sends no bearer of its own, ever', async () => {
    const sent = installFetch(({ path }) =>
      path === '/v1/auth/me' ? { body: SESSION } : { body: {} })

    mount()
    await screen.findByTestId('who')
    act(() => { screen.getByText('poll').click() })

    await waitFor(() => expect(sent.length).toBeGreaterThan(1))
    expectNoBearer(sent)
    // The cookie is the whole session, and it only travels with this.
    for (const r of sent) expect(r.url.startsWith('http')).toBe(true)
  })
})

/**
 * No `authorization` header on anything.
 *
 * A build-time `VITE_DESK_TOKEN` used to be compiled into the bundle and sent
 * as a bearer — a credential readable by any script on the page, which could
 * never sign anyone in anyway. This is the assertion that keeps it gone.
 */
function expectNoBearer(sent: readonly SentRequest[]): void {
  for (const r of sent) {
    const keys = Object.keys(r.headers).map((k) => k.toLowerCase())
    expect(keys).not.toContain('authorization')
  }
}
