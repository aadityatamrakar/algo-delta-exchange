/** The Groups sub-tab: tagging legs, saving, the server's refusal, and per-group totals. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { GroupsView, GroupView } from '../../../traders/src/analytics/r3-wire.ts'
import { GroupsTab } from '../../src/traders/groups.tsx'
import { LEG_PNL_TITLE } from '../../src/traders/series-lines.ts'
import { installFetch } from '../http.tsx'
import { bookView, leg } from './fixtures.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); Reflect.deleteProperty(document, 'hidden') })

const A = leg()
const B = leg({ key: 'C0001|option|TCS|2026-10-27|3400|PE', strike: 3400, optType: 'PE' })
const view = bookView({ legs: [A, B] })

const group = (name: string, keys: string[], delta: number): GroupView =>
  ({ name, keys, legCount: keys.length, totals: { delta, gamma: 0, vega: 0, theta: 0, mtm: 0 }, payoff: null })
const EMPTY: GroupsView = { stock: 'TCS', asOf: 1, groups: [], ungrouped: group('ungrouped', [A.key, B.key], -52.5) }

const tag = (leg: typeof A, name: string): void => {
  const label = `Group for TCS ${leg.optType === 'PE' ? '3400 PE' : '3500 CE'}`
  fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value: name } })
}

test('tagging two legs hedge and saving sends the group with both keys', async () => {
  const sent = installFetch(({ method }) => ({ body: method === 'GET' ? EMPTY : { ...EMPTY, groups: [group('hedge', [A.key, B.key], 5)] } }))
  render(<GroupsTab stock="TCS" view={view} />)
  await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2))
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  tag(A, 'hedge'); tag(B, 'hedge')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(sent.some((r) => r.method === 'PUT')).toBe(true))
  const put = sent.find((r) => r.method === 'PUT')!
  expect(put.path).toBe('/v1/traders/books/TCS/groups')
  expect(put.body).toEqual({ groups: [{ name: 'hedge', keys: [A.key, B.key] }] })
})

test('a refusal shows the server error in a banner and keeps the draft', async () => {
  installFetch(({ method }) => method === 'GET' ? { body: EMPTY } : { status: 400, body: { error: '"ungrouped" is reserved' } })
  render(<GroupsTab stock="TCS" view={view} />)
  await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2))
  tag(A, 'hedge')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('"ungrouped" is reserved')).toBeTruthy()
  expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('hedge')
})

test('per-group totals render, with the ungrouped remainder', async () => {
  const v: GroupsView = { ...EMPTY, groups: [group('hedge', [A.key], 125.5)], ungrouped: group('ungrouped', [B.key], -10) }
  installFetch(() => ({ body: v }))
  render(<GroupsTab stock="TCS" view={view} />)
  expect(await screen.findByLabelText('hedge totals')).toBeTruthy()
  expect(screen.getByText('+125.50')).toBeTruthy()
  expect(screen.getByLabelText('Ungrouped totals')).toBeTruthy()
  expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('hedge')
  // the group's legs summed: one name with the leg's, never a book total
  const hedge = screen.getByLabelText('hedge totals')
  expect(within(hedge).getByText('Leg P&L').getAttribute('title')).toBe(LEG_PNL_TITLE)
  expect(within(hedge).queryByText('Open P&L')).toBeNull()
})

test('after Save the tags stay on screen from the PUT answer while the re-read is still out', async () => {
  let gets = 0
  const saved: GroupsView = { ...EMPTY, groups: [group('hedge', [A.key], 5)], ungrouped: group('ungrouped', [B.key], 0) }
  installFetch(({ method }) => {
    if (method === 'PUT') return { body: saved }
    return { body: gets++ === 0 ? EMPTY : saved }
  })
  const inner = globalThis.fetch
  let hold = false
  vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { if (hold && (a[1]?.method ?? 'GET') === 'GET') await new Promise(() => {}); return inner(...a) })
  render(<GroupsTab stock="TCS" view={view} />)
  await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2))
  tag(A, 'hedge')
  hold = true
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.getByLabelText('hedge totals')).toBeTruthy())
  expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('hedge')
})

test('the groups are read again at once when the book\'s legs change, not a minute later', async () => {
  const sent = installFetch(() => ({ body: EMPTY }))
  const gets = (): number => sent.filter((r) => r.method === 'GET').length
  const { rerender } = render(<GroupsTab stock="TCS" view={view} />)
  await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2))
  expect(gets()).toBe(1)
  rerender(<GroupsTab stock="TCS" view={bookView({ legs: [A, B] })} />)
  const C = leg({ key: 'C0001|option|TCS|2026-10-27|3300|PE', strike: 3300, optType: 'PE' })
  rerender(<GroupsTab stock="TCS" view={bookView({ legs: [A, B, C] })} />)
  await waitFor(() => expect(gets()).toBe(2))
})

test('a hidden tab asks for no groups; showing it asks at once', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  const sent = installFetch(() => ({ body: EMPTY }))
  render(<GroupsTab stock="TCS" view={view} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(sent).toEqual([])
  Reflect.deleteProperty(document, 'hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sent.map((r) => r.path)).toEqual(['/v1/traders/books/TCS/groups'])
})
