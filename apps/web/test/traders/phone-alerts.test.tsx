/** Phone alerts (gaps G7): the sidebar control's four states and its actions, and the stored alerts in the bell. */
import { afterEach, expect, test } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import { BLOCKED_HINT, IPHONE_HINT, PhoneAlerts, alertLine, istDayStart } from '../../src/traders/phone-alerts.tsx'
import { SW_SCOPE, SW_URL, keyBytes, type PushEnv, type RegistrationLike, type SubscriptionLike } from '../../src/traders/push-client.ts'
import { installFetch, type SentRequest } from '../http.tsx'
import { summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null); window.localStorage.clear(); window.location.hash = '' })

const KEY = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, i) => i))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/this-phone'

interface Fake { env: PushEnv; calls: string[]; current(): SubscriptionLike | null }

function fakeEnv(o: {
  sw?: boolean; push?: boolean; permission?: NotificationPermission; answer?: NotificationPermission
  subscribed?: boolean; iPhone?: boolean; standalone?: boolean
} = {}): Fake {
  const calls: string[] = []
  const sub = (key: ArrayBuffer | null): SubscriptionLike => ({
    endpoint: ENDPOINT, options: { applicationServerKey: key },
    toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => { calls.push('unsubscribe'); current = null; return true },
  })
  let current: SubscriptionLike | null = o.subscribed === true ? sub(null) : null
  let registered = o.subscribed === true
  const reg: RegistrationLike = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async (opts) => { calls.push(`subscribe:${opts.applicationServerKey.length}`); current = sub(opts.applicationServerKey.buffer); return current },
    },
  }
  let permission: NotificationPermission = o.permission ?? 'default'
  const env: PushEnv = {
    serviceWorker: o.sw === false ? null : {
      register: async (url, opts) => { calls.push(`register:${url}:${opts.scope}`); registered = true; return reg },
      getRegistration: async () => (registered ? reg : undefined),
      ready: Promise.resolve(reg),
    },
    pushManager: o.push !== false,
    notification: {
      get permission() { return permission },
      requestPermission: async () => { calls.push('ask'); permission = o.answer ?? 'granted'; return permission },
    },
    iPhone: o.iPhone ?? false, standalone: o.standalone ?? false,
  }
  return { env, calls, current: () => current }
}

function server(): SentRequest[] {
  return installFetch(({ path }) => {
    if (path === '/v1/traders/push/key') return { body: { publicKey: KEY } }
    if (path === '/v1/traders/push/subscribe') return { body: { subscribed: true, phones: 1 } }
    if (path === '/v1/traders/push/unsubscribe') return { body: { removed: true } }
    if (path === '/v1/traders/push/test') return { body: { sent: 1, phones: 1 } }
    return { status: 404, body: { error: 'no route' } }
  })
}
const group = (): HTMLElement => screen.getByRole('group', { name: 'Phone alerts' })

test('not supported: no service worker or Push API; on an iPhone outside the Home Screen, the Add to Home Screen hint', async () => {
  server()
  render(<PhoneAlerts env={fakeEnv({ push: false, iPhone: true }).env} />)
  await screen.findByText('Phone alerts: not supported in this browser')
  expect(screen.getByText(IPHONE_HINT)).toBeTruthy()
  expect(within(group()).queryAllByRole('button')).toEqual([])
})

test('the iPhone hint is not shown from the Home Screen, nor off an iPhone', async () => {
  server()
  const { unmount } = render(<PhoneAlerts env={fakeEnv({ iPhone: true, standalone: true }).env} />)
  await screen.findByText('Phone alerts: off')
  expect(screen.queryByText(IPHONE_HINT)).toBe(null)
  unmount()
  render(<PhoneAlerts env={fakeEnv({ sw: false }).env} />)
  await screen.findByText('Phone alerts: not supported in this browser')
  expect(screen.queryByText(IPHONE_HINT)).toBe(null)
})

test('blocked: notifications denied for the site, with how to allow them; nothing to press', async () => {
  server()
  render(<PhoneAlerts env={fakeEnv({ permission: 'denied' }).env} />)
  await screen.findByText('Phone alerts: blocked')
  expect(screen.getByText(BLOCKED_HINT)).toBeTruthy()
  expect(within(group()).queryAllByRole('button')).toEqual([])
})

test('off → on: the permission first, the worker at /traders/sw.js, a subscription to the server\'s key, the server told', async () => {
  const sent = server()
  const f = fakeEnv()
  render(<PhoneAlerts env={f.env} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Turn on phone alerts' }))
  await screen.findByText('Phone alerts: on')
  expect(f.calls).toEqual(['ask', `register:${SW_URL}:${SW_SCOPE}`, 'subscribe:65'])
  expect([SW_URL, SW_SCOPE]).toEqual(['/traders/sw.js', '/traders/'])
  const posted = sent.filter((r) => r.method === 'POST')
  expect(posted.map((r) => [r.path, r.body])).toEqual([['/v1/traders/push/subscribe', { endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }]])
  expect(screen.getByRole('button', { name: 'Send test' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy()
})

test('a refused permission prompt is blocked, a dismissed one stays off; nothing is subscribed', async () => {
  for (const [answer, word] of [['denied', 'blocked'], ['default', 'off']] as const) {
    const sent = server()
    const f = fakeEnv({ answer })
    const { unmount } = render(<PhoneAlerts env={f.env} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on phone alerts' }))
    await screen.findByText(`Phone alerts: ${word}`)
    expect(f.calls).toEqual(['ask'])
    expect(sent.filter((r) => r.method === 'POST')).toEqual([])
    unmount()
  }
})

test('on: the server\'s copy is refreshed on load; Send test reports the phones; Turn off unsubscribes here and there', async () => {
  const sent = server()
  const f = fakeEnv({ permission: 'granted', subscribed: true })
  render(<PhoneAlerts env={f.env} />)
  await screen.findByText('Phone alerts: on')
  await waitFor(() => expect(sent.map((r) => r.path)).toContain('/v1/traders/push/subscribe'))
  fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
  await screen.findByText('Test sent to 1 phone')
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
  await screen.findByText('Phone alerts: off')
  expect(f.calls).toContain('unsubscribe')
  expect(f.current()).toBe(null)
  expect(sent.filter((r) => r.path === '/v1/traders/push/unsubscribe').map((r) => r.body)).toEqual([{ endpoint: ENDPOINT }])
})

test('on, but subscribed to an older server key (its settings were reset): resubscribed to the current one on load', async () => {
  const sent = server()
  const f = fakeEnv({ permission: 'granted' })
  await f.env.serviceWorker?.register(SW_URL, { scope: SW_SCOPE })
  const old = keyBytes(`BBBB${KEY.slice(4)}`)
  await (await f.env.serviceWorker!.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: old })
  f.calls.length = 0
  render(<PhoneAlerts env={f.env} />)
  await screen.findByText('Phone alerts: on')
  await waitFor(() => expect(sent.filter((r) => r.path === '/v1/traders/push/subscribe').length).toBe(1))
  expect(f.calls).toEqual(['unsubscribe', 'subscribe:65'])
  expect(Array.from(new Uint8Array(f.current()?.options?.applicationServerKey as ArrayBuffer))).toEqual(Array.from(keyBytes(KEY)))
})

test('the bell lists the day\'s stored alerts, beside the pages\' own, and the control sits in the sidebar', async () => {
  const at = Date.parse('2026-10-27T14:31:00+05:30')
  const sent = installFetch(({ path }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return { body: summaries('TCS') }
    if (path === '/v1/traders/alerts') {
      return { body: [
        { kind: 'expiring-itm', stock: 'TCS', title: 'TCS expiring in the money', body: '3300 CE +175 expire today.', url: '/traders/#/books/TCS', at, sentAt: at, admin: false },
        { kind: 'band-breach', stock: 'TCS', title: 'TCS out of band', body: 'Out of band by 1 lot.', url: '/traders/#/books/TCS', at: at - 60_000, sentAt: null, admin: false },
      ] }
    }
    if (path === '/v1/traders/orders' || path === '/v1/traders/trades') return { body: [] }
    return { body: {} }
  })
  window.location.hash = '#/orders'
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Alerts: 2' })).toBeTruthy())
  const q = sent.find((r) => r.path === '/v1/traders/alerts')
  expect(Number(new URL(q?.url ?? '').searchParams.get('since'))).toBe(istDayStart(Date.now()))
  fireEvent.click(screen.getByRole('button', { name: /^Alerts/ }))
  const panel = await screen.findByRole('dialog', { name: 'Alerts and warnings' })
  const alerts = within(panel).getByRole('group', { name: 'Alerts' })
  expect(within(alerts).getByText('14:31 TCS expiring in the money: 3300 CE +175 expire today.')).toBeTruthy()
  expect(within(alerts).getByText('14:30 TCS out of band: Out of band by 1 lot.')).toBeTruthy()
  expect(within(screen.getByRole('complementary', { name: 'Menu' })).getByRole('group', { name: 'Phone alerts' })).toBeTruthy()
})

test('helpers: a key\'s bytes, an alert\'s line, the IST day\'s start', () => {
  expect(keyBytes(KEY).length).toBe(65)
  expect(keyBytes(KEY)[0]).toBe(4)
  expect(alertLine({ at: Date.parse('2026-10-19T09:41:00+05:30'), title: 'Watcher offline', body: 'No heartbeat.' })).toBe('09:41 Watcher offline: No heartbeat.')
  expect(istDayStart(Date.parse('2026-10-19T00:10:00+05:30'))).toBe(Date.parse('2026-10-19T00:00:00+05:30'))
  expect(istDayStart(Date.parse('2026-10-18T23:59:00+05:30'))).toBe(Date.parse('2026-10-18T00:00:00+05:30'))
})
