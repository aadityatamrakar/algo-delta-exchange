/**
 * A paper book's rail — Sim or Demo — shown, confirmed, and switched.
 *
 * What a render proves: the operator sees the book's setting (Demo by
 * default) AND where its last order actually went, nothing is sent until the
 * confirm, the POST names the paper rail and the TARGET rail, and a refusal is
 * shown as the server said.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { PaperRailControl, railSwitchStatement, railUsedBadge, railUsedText } from '../src/paper-rail.tsx'
import type { BookRow } from '../src/api.ts'
import { installFetch, type SentRequest } from './http.tsx'

const TAG = 'BTC-bull-s-2026-11-04'

function bookRow(over: Partial<BookRow> = {}): BookRow {
  return {
    tag: TAG, symbol: 'BTC', expiry: '2026-11-04', mode: 'paper', variant: 'bull-s',
    dials: {}, desired: 'running', actual: 'running', lastMarkAt: 0, lastDecision: '',
    createdAt: 0, updatedAt: 0, dx_paper_rail: 'demo', dx_rail_used: null, dx_rail_note: '',
    ...over,
  }
}

const posts = (sent: readonly SentRequest[]): SentRequest[] => sent.filter((r) => r.method === 'POST')
const RAIL_PATH = `/v1/desk/books/registry/${encodeURIComponent(TAG)}/paper-rail`

describe('the paper rail control', () => {
  test('shows Demo (the default), asks before switching, then POSTs { mode: paper, rail: sim }', async () => {
    const switched: BookRow[] = []
    const sent = installFetch(({ path, body }) =>
      path === RAIL_PATH ? { body: bookRow({ dx_paper_rail: body?.['rail'] as 'sim' }) } : { body: {} })
    render(<PaperRailControl row={bookRow()} onSwitched={(r) => switched.push(r)} />)

    expect(screen.getByText('Demo')).toBeTruthy()
    act(() => { screen.getByRole('button', { name: 'Switch to Sim' }).click() })
    // The confirm is up and NOTHING has been sent yet.
    expect(await screen.findByText(railSwitchStatement(TAG, 'sim'))).toBeTruthy()
    expect(posts(sent)).toHaveLength(0)

    const buttons = screen.getAllByRole('button', { name: 'Switch to Sim' })
    act(() => { buttons[buttons.length - 1]?.click() })
    await waitFor(() => expect(posts(sent)).toHaveLength(1))
    expect(posts(sent)[0]?.path).toBe(RAIL_PATH)
    expect(posts(sent)[0]?.body).toEqual({ mode: 'paper', rail: 'sim' })
    await waitFor(() => expect(switched).toHaveLength(1))
    expect(switched[0]?.dx_paper_rail).toBe('sim')
    expect(await screen.findByText(/rail is now Sim/)).toBeTruthy()
  })

  test('the rail the last order ACTUALLY used is shown — a Demo book with no verified key says simulator', () => {
    installFetch(() => ({ body: {} }))
    render(<PaperRailControl
      row={bookRow({ dx_rail_used: 'sim', dx_rail_note: 'simulator — no Delta Demo key stored' })}
      onSwitched={() => {}} />)
    expect(screen.getByText('Demo')).toBeTruthy()
    expect(screen.getByText('last order: simulator — no Delta Demo key stored')).toBeTruthy()
    expect(railUsedText(bookRow())).toBeNull()
    expect(railUsedText(bookRow({ dx_rail_used: 'demo' }))).toBe('last order: Delta testnet')
  })

  test('the confirmation says next order, the verified-key rule, and that held legs stay put', () => {
    const s = railSwitchStatement(TAG, 'demo')
    expect(s).toMatch(/next order/)
    expect(s).toMatch(/testnet/)
    expect(s).toMatch(/passed Test/)
    expect(s).toMatch(/simulator when it has not/)
    expect(s).toMatch(/stay on the rail they were opened on until it is flat/)
    expect(railSwitchStatement(TAG, 'sim')).toMatch(/simulator/)
  })

  test('a book forced to Sim offers the way back to Demo', () => {
    installFetch(() => ({ body: {} }))
    render(<PaperRailControl row={bookRow({ dx_paper_rail: 'sim' })} onSwitched={() => {}} />)
    expect(screen.getByText('Sim')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Switch to Demo' })).toBeTruthy()
  })

  test('a row without the field reads as Demo, the default', () => {
    installFetch(() => ({ body: {} }))
    const { dx_paper_rail: _omit, ...old } = bookRow()
    render(<PaperRailControl row={old} onSwitched={() => {}} />)
    expect(screen.getByText('Demo')).toBeTruthy()
  })

  test("a server refusal is shown as it wrote it, and nothing is reported switched", async () => {
    const refusal = `'${TAG}' holds 2 open leg(s) in paper — refused`
    const switched: BookRow[] = []
    installFetch(({ path }) => (path === RAIL_PATH ? { status: 409, body: { error: refusal } } : { body: {} }))
    render(<PaperRailControl row={bookRow()} onSwitched={(r) => switched.push(r)} />)
    act(() => { screen.getByRole('button', { name: 'Switch to Sim' }).click() })
    await screen.findByText(railSwitchStatement(TAG, 'sim'))
    const buttons = screen.getAllByRole('button', { name: 'Switch to Sim' })
    act(() => { buttons[buttons.length - 1]?.click() })
    expect(await screen.findByText('Rail not switched')).toBeTruthy()
    expect(screen.getByText(new RegExp('holds 2 open leg'))).toBeTruthy()
    expect(switched).toHaveLength(0)
  })

  test("the Books row badge names the rail the last order used — paper only", () => {
    expect(railUsedBadge(bookRow({ dx_rail_used: 'demo' }))).toEqual({ label: 'Demo (testnet)', variant: 'warning' })
    expect(railUsedBadge(bookRow({ dx_rail_used: 'sim' }))).toEqual({ label: 'Sim', variant: 'neutral' })
    expect(railUsedBadge(bookRow())).toBeNull()
    expect(railUsedBadge(bookRow({ mode: 'live', dx_rail_used: 'demo' }))).toBeNull()
  })

  test('a live row draws nothing — its orders go to Delta proper', () => {
    installFetch(() => ({ body: {} }))
    const { container } = render(<PaperRailControl row={bookRow({ mode: 'live' })} onSwitched={() => {}} />)
    expect(container.textContent).toBe('')
  })
})
