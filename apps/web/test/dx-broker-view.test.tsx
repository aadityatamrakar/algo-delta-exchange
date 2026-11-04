/**
 * The Delta Broker page (`dx-broker-view.tsx`): what Delta holds on the
 * account the PAPER/LIVE switch names — positions, the resting book, fills,
 * recent orders and margin — and what it says when a list is unknown.
 */
import { expect, test, afterEach, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { DxBrokerPage } from '../src/dx-broker-view.tsx'
import { installFetch } from './http.tsx'

const NOW = Date.parse('2026-11-04T18:05:00Z')

const ok = <T,>(rows: T[], ageMs = 5_000) => ({ state: 'ok', asOf: NOW - ageMs, ageMs, error: '', reason: '', rows })

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rail: 'live',
    label: 'Live',
    host: 'api.india.delta.exchange',
    staleAfterMs: 90_000,
    inrPerUsd: 85,
    positions: ok([
      { symbol: 'C-BTC-80400-061126', netQty: -0.08, avgPrice: 833.6 },
      { symbol: 'P-BTC-80400-061126', netQty: -0.08, avgPrice: 873 },
    ]),
    openOrders: ok([
      {
        id: '7001', symbol: 'C-BTC-80400-061126', side: 'buy', kind: 'stop', state: 'pending', qty: 0.08, filledQty: 0,
        limitPrice: 1100, stopPrice: 1042, avgFillPrice: null, reduceOnly: true, clientOrderId: null,
        cancellationReason: null, createdAt: NOW - 60_000, updatedAt: null,
      },
    ]),
    recentOrders: ok([
      {
        id: '6990', symbol: 'P-BTC-80400-061126', side: 'sell', kind: 'limit', state: 'closed', qty: 0.08, filledQty: 0.08,
        limitPrice: 870, stopPrice: null, avgFillPrice: 873, reduceOnly: false, clientOrderId: 'bk-1',
        cancellationReason: null, createdAt: NOW - 300_000, updatedAt: null,
      },
    ]),
    fills: ok([
      {
        id: 'f-1', orderId: '6990', symbol: 'P-BTC-80400-061126', side: 'sell', qty: 0.08, price: 873,
        commission: 0.0212, role: 'maker', fillType: 'normal', at: NOW - 299_000,
      },
    ]),
    margin: {
      id: 'delta', rail: 'live', label: 'Live', state: 'ok', asOf: NOW - 4_000, ageMs: 4_000, balance: 1289.7,
      available: 503.32, positionMargin: 0, orderMargin: 0, portfolioMargin: 786.38, used: 786.38, utilizedPct: 60.97,
      error: '', reason: '',
    },
    ...over,
  }
}

async function mount(mode: 'live' | 'paper', body: Record<string, unknown>): Promise<{ urls: string[] }> {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const urls: string[] = []
  installFetch(({ path, url }) => {
    urls.push(`${path}${url.search}`)
    return path === '/v1/desk/broker/delta' ? { body } : { body: {} }
  })
  render(<DxBrokerPage mode={mode} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  return { urls }
}

afterEach(() => {
  vi.useRealTimers()
})

test('LIVE reads the live account and shows its positions, resting stop, fills and recent orders', async () => {
  const { urls } = await mount('live', view())
  expect(urls).toContain('/v1/desk/broker/delta?rail=live')
  expect(screen.getByText(/Delta live account/)).toBeTruthy()

  const positions = within(screen.getByRole('group', { name: 'Delta positions' }))
  expect(positions.getByText('C-BTC-80400-061126')).toBeTruthy()
  expect(positions.getAllByText('-0.08').length).toBe(2)
  expect(positions.getByText('$833.60')).toBeTruthy()

  const open = within(screen.getByRole('group', { name: 'Delta open orders' }))
  expect(open.getByText('Stop · reduce-only')).toBeTruthy()
  expect(open.getByText('untriggered')).toBeTruthy()
  expect(open.getByText('$1,042.00')).toBeTruthy()

  const fills = within(screen.getByRole('group', { name: 'Delta fills' }))
  expect(fills.getByText('$873.00')).toBeTruthy()
  expect(fills.getByText('maker')).toBeTruthy()

  const recent = within(screen.getByRole('group', { name: 'Delta recent orders' }))
  expect(recent.getByText('filled')).toBeTruthy()
})

test('the margin line is in dollars with rupees at the fixed 85, and says blocked and free', async () => {
  await mount('live', view())
  const margin = within(screen.getByRole('group', { name: 'Delta margin' }))
  expect(margin.getByText(/Available/).textContent).toContain('$503.32 (₹42,782)')
  expect(margin.getByText(/Blocked/).textContent).toContain('$786.38 (₹66,842)')
  expect(margin.getByText(/Balance/).textContent).toContain('$1,289.70 (₹1,09,625)')
  expect(margin.getByText(/used/).textContent).toContain('61.0%')
})

test('PAPER reads the demo (testnet) account and says so', async () => {
  const { urls } = await mount('paper', view({ rail: 'demo', label: 'Demo', host: 'cdn-ind.testnet.deltaex.org' }))
  expect(urls).toContain('/v1/desk/broker/delta?rail=demo')
  expect(urls.some((u) => u.includes('rail=live'))).toBe(false)
  expect(screen.getByText(/Delta testnet \(demo\) account/)).toBeTruthy()
})

test('an unknown list says why — absent with its reason, failed with Delta’s error — and an empty one says "none"', async () => {
  await mount(
    'live',
    view({
      positions: { state: 'ok', asOf: NOW - 5_000, ageMs: 5_000, error: '', reason: '', rows: [] },
      openOrders: { state: 'failed', asOf: NOW - 5_000, ageMs: 5_000, error: 'Delta open orders failed: 429', reason: '', rows: [] },
      fills: { state: 'absent', asOf: null, ageMs: null, error: '', reason: 'not written: the gateway has not read this account', rows: [] },
    }),
  )
  expect(within(screen.getByRole('group', { name: 'Delta positions' })).getByText('Delta reports no open positions.')).toBeTruthy()
  expect(within(screen.getByRole('group', { name: 'Delta open orders' })).getByText(/Delta open orders failed: 429/)).toBeTruthy()
  expect(within(screen.getByRole('group', { name: 'Delta fills' })).getByText(/not written: the gateway has not read/)).toBeTruthy()
})

test('a stale list keeps its rows and says how old they are', async () => {
  await mount('live', view({ positions: { ...ok([{ symbol: 'C-BTC-80400-061126', netQty: -0.08, avgPrice: 833.6 }], 300_000), state: 'stale' } }))
  const positions = within(screen.getByRole('group', { name: 'Delta positions' }))
  expect(positions.getByText('C-BTC-80400-061126')).toBeTruthy()
  expect(positions.getByText(/stale — read 5m ago/)).toBeTruthy()
})
