/** The Range Calculator page: VolHedge's 7229 / 27.7 first row, the CMP prefill, and a field error. */
import { expect, test, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RangePage } from '../../src/traders/range-page.tsx'
import { installFetch } from '../http.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const type = (label: string, value: string): void => { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }

test('CMP 7229 and vol 27.7 show 7,124 and 7,334 in the first row', () => {
  render(<RangePage />)
  type('CMP', '7229')
  type('Volatility %', '27.7')
  const row = screen.getAllByRole('row')[1]!
  expect(within(row).getByText('7,124')).toBeTruthy()
  expect(within(row).getByText('7,334')).toBeTruthy()
  expect(within(row).getByText('1.45')).toBeTruthy()
  expect(screen.getAllByRole('row')).toHaveLength(31)
})

test('a bad field is named instead of a table', () => {
  render(<RangePage />)
  type('CMP', '7229')
  type('Volatility %', '-1')
  expect(screen.getByText(/vol must be/)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})

test('Fill CMP takes the spot, else the first chain forward, and says when it took the forward', async () => {
  const body = {
    stock: 'TCS', spot: null, spotStale: true,
    chains: [{ expiry: '2026-10-27', forward: null, forwardSource: null }, { expiry: '2026-11-24', forward: 3412.5, forwardSource: 'parity' }],
  }
  const sent = installFetch(() => ({ body }))
  render(<RangePage />)
  type('Underlying', 'tcs')
  fireEvent.click(screen.getByRole('button', { name: 'Fill CMP' }))
  await waitFor(() => expect((screen.getByLabelText('CMP') as HTMLInputElement).value).toBe('3412.5'))
  expect(sent.map((r) => r.path)).toEqual(['/v1/traders/market/TCS'])
  expect(screen.getByText('No spot for TCS: CMP is the 24 Nov 26 forward (parity), not a quoted price')).toBeTruthy()
})

test('Fill CMP from a stale spot says it is stale, until CMP is typed over', async () => {
  installFetch(() => ({ body: { stock: 'TCS', spot: 3410, spotStale: true, chains: [] } }))
  render(<RangePage />)
  type('Underlying', 'TCS')
  fireEvent.click(screen.getByRole('button', { name: 'Fill CMP' }))
  await waitFor(() => expect((screen.getByLabelText('CMP') as HTMLInputElement).value).toBe('3410'))
  expect(screen.getByText('TCS spot is stale: CMP is the last price seen, not a live one')).toBeTruthy()
  type('CMP', '3400')
  expect(screen.queryByText(/spot is stale/)).toBeNull()
})

test('a live spot fills CMP with no note', async () => {
  installFetch(() => ({ body: { stock: 'TCS', spot: 3410, spotStale: false, chains: [] } }))
  render(<RangePage />)
  type('Underlying', 'TCS')
  fireEvent.click(screen.getByRole('button', { name: 'Fill CMP' }))
  await waitFor(() => expect((screen.getByLabelText('CMP') as HTMLInputElement).value).toBe('3410'))
  expect(screen.queryByText(/stale|forward/)).toBeNull()
})

test('the start date defaults to the IST day, not the UTC one', () => {
  // 20:00 UTC on the 19th is 01:30 IST on the 20th.
  vi.useFakeTimers({ now: new Date('2026-10-19T20:00:00Z'), toFake: ['Date'] })
  render(<RangePage />)
  expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe('2026-10-20')
})

test('a late Fill CMP answer does not overwrite what was typed since', async () => {
  const sent = installFetch(() => ({ body: { stock: 'TCS', spot: 3410, chains: [] } }))
  const inner = globalThis.fetch
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { await gate; return inner(...a) })
  render(<RangePage />)
  type('Underlying', 'TCS')
  fireEvent.click(screen.getByRole('button', { name: 'Fill CMP' }))
  type('CMP', '99')
  release()
  await waitFor(() => expect(sent.length).toBe(1))
  await new Promise((r) => setTimeout(r, 50))
  expect((screen.getByLabelText('CMP') as HTMLInputElement).value).toBe('99')
})
