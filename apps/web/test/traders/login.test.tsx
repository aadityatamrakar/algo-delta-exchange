/** The traders login and the session gate. */
import { expect, test, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { installFetch } from '../http.tsx'
import { setAsTrader, tapi } from '../../src/traders/api.ts'
import { BOOK_TCS, summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null) })

test('login shows the separate-login note and enters on success', async () => {
  let signedIn = false
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/traders/auth/me') return signedIn ? { body: { username: 'ravi', role: 'trader' } } : { status: 401, body: { error: 'not signed in' } }
    if (path === '/v1/traders/auth/login' && method === 'POST') { signedIn = true; return { body: { username: 'ravi', role: 'trader' } } }
    if (path === '/v1/traders/books') return { body: [] }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  await screen.findByText('Delta Desk login — separate from the main desk login')
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: ' Ravi ' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByText('No open books')
  const login = sent.find((r) => r.path === '/v1/traders/auth/login')
  expect(login?.body).toEqual({ username: 'ravi', password: 'hunter22' })
  expect(login?.url).not.toMatch(/as=/)
  expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy()
})

test('a wrong password says so and stays on the login', async () => {
  installFetch(({ path }) => {
    if (path === '/v1/traders/auth/me') return { status: 401, body: { error: 'not signed in' } }
    if (path === '/v1/traders/auth/login') return { status: 401, body: { error: 'wrong username or password' } }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  await screen.findByText('Delta Desk login — separate from the main desk login')
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ravi' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope-nope' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByText('wrong username or password')
  expect(screen.getByText('Delta Desk login — separate from the main desk login')).toBeTruthy()
})

test('a 401 mid-session returns to login', async () => {
  let expired = false
  installFetch(({ path }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return expired ? { status: 401, body: { error: 'session expired' } } : { body: summaries('TCS') }
    if (path === '/v1/traders/books/TCS') return { body: BOOK_TCS }
    return { body: {} }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  await screen.findByRole('tab', { name: /TCS/ })
  expired = true
  // Any call answering 401 drops the session; the 15 s poll is one such call, made directly here.
  await tapi.books().catch(() => undefined)
  await screen.findByText('Delta Desk login — separate from the main desk login')
})

test('a trader sees no admin trader picker, and the page never offers to trade', async () => {
  installFetch(({ path }) => path === '/v1/traders/auth/me' ? { body: { username: 'ravi', role: 'trader' } } : { body: summaries() })
  const { container } = render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  await screen.findByText('No open books')
  expect(screen.queryByText('Trader')).toBe(null)
  expect(container.textContent ?? '').not.toMatch(/\b(buy|sell|place order|square off|execute)\b/i)
})
