/** The Orders page: day and stock filters, the three tabs. */
import { expect, test, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TradersApp } from '../../src/traders/app.tsx'
import { installFetch, type SentRequest } from '../http.tsx'
import { setAsTrader } from '../../src/traders/api.ts'
import { istDay } from '../../src/traders/wire.ts'
import type { TraderOrder, TraderTrade } from '../../../traders/src/types.ts'
import { summaries } from './fixtures.ts'

afterEach(() => { setAsTrader(null); window.location.hash = '' })

const today = istDay(Date.now())
const T = new Date('2026-10-19T10:15:30+05:30').getTime()

const ORDER: TraderOrder = {
  trader: 'ravi', orderNo: '1', exchOrderNo: 'E1', clientCode: 'C0001', stock: 'TCS', instrument: 'option',
  expiry: '2026-10-27', strike: 3500, optType: 'CE', side: 'Sell', qty: 175, price: 88.5,
  status: 'Cancelled (5)', reason: 'Price out of range', time: T, day: today, filledQty: 0, updateTime: T,
}
const TRADE: TraderTrade = {
  trader: 'ravi', tradeNo: 'T9001', orderNo: '1', clientCode: 'C0001', stock: 'TCS', instrument: 'option',
  expiry: '2026-10-27', strike: 3500, optType: 'CE', side: 'Buy', qty: 175, price: 90.25, time: T, day: today, seq: 1,
}

function mount(log: unknown[] = []): SentRequest[] {
  const sent = installFetch(({ path }) => {
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role: 'trader' } }
    if (path === '/v1/traders/books') return { body: summaries('NIFTY', 'TCS') }
    if (path === '/v1/traders/orders') return { body: [ORDER] }
    if (path === '/v1/traders/trades') return { body: [TRADE] }
    if (path === '/v1/traders/log') return { body: log }
    return { body: {} }
  })
  window.location.hash = '#/orders'
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  return sent
}

test('orders default to today and filter by stock', async () => {
  const sent = mount()
  await screen.findByText('Cancelled (5)')
  expect(sent.find((r) => r.path === '/v1/traders/orders')?.url).toContain(`/v1/traders/orders?day=${today}`)
  expect(screen.getByText('Sell')).toBeTruthy()
  expect(screen.getByText('10:15:30')).toBeTruthy()
  expect(screen.getByText('Price out of range')).toBeTruthy()
  expect(screen.getByText('88.50')).toBeTruthy()
  const stock = await screen.findByRole('combobox', { name: /Stock/ })
  fireEvent.click(stock)
  fireEvent.click(await screen.findByRole('option', { name: 'TCS' }))
  await waitFor(() => expect(sent.some((r) => r.url.endsWith(`/v1/traders/orders?day=${today}&stock=TCS`))).toBe(true))
})

test('trades and log tabs', async () => {
  mount()
  await screen.findByText('Cancelled (5)')
  fireEvent.click(screen.getByRole('tab', { name: 'Trades' }))
  await screen.findByText('T9001')
  expect(screen.getByText('Buy')).toBeTruthy()
  expect(screen.getByText('90.25')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Log' }))
  await screen.findByText("ODIN's message log is not in its OnLineBackup files")
})

test('a log with lines lists them', async () => {
  mount([{ trader: 'ravi', day: today, seq: 1, time: T, text: 'Order accepted' }])
  await screen.findByText('Cancelled (5)')
  fireEvent.click(screen.getByRole('tab', { name: 'Log' }))
  const row = await screen.findByText('Order accepted')
  expect(within(row.closest('tr') as HTMLElement).getByText('10:15:30')).toBeTruthy()
})
