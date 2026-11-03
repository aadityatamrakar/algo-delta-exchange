/**
 * A paper book's rail — Sim or Demo — shown, confirmed, and switched.
 *
 * What a render proves: the operator sees which exchange the book's orders
 * reach, nothing is sent until the confirm, the POST names the paper rail and
 * the TARGET rail, and a 409 (the book holds legs) is shown as the server said.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { PaperRailControl, railSwitchStatement } from '../src/paper-rail.tsx'
import type { BookRow } from '../src/api.ts'
import { installFetch, type SentRequest } from './http.tsx'

const TAG = 'BTC-bull-s-2026-11-04'

function bookRow(over: Partial<BookRow> = {}): BookRow {
  return {
    tag: TAG, symbol: 'BTC', expiry: '2026-11-04', mode: 'paper', variant: 'bull-s',
    dials: {}, desired: 'running', actual: 'running', lastMarkAt: 0, lastDecision: '',
    createdAt: 0, updatedAt: 0, dx_paper_rail: 'sim',
    ...over,
  }
}

const posts = (sent: readonly SentRequest[]): SentRequest[] => sent.filter((r) => r.method === 'POST')
const RAIL_PATH = `/v1/desk/books/registry/${encodeURIComponent(TAG)}/paper-rail`

describe('the paper rail control', () => {
  test('shows Sim, asks before switching, then POSTs { mode: paper, rail: demo }', async () => {
    const switched: BookRow[] = []
    const sent = installFetch(({ path, body }) =>
      path === RAIL_PATH ? { body: bookRow({ dx_paper_rail: body?.['rail'] as 'demo' }) } : { body: {} })
    render(<PaperRailControl row={bookRow()} onSwitched={(r) => switched.push(r)} />)

    expect(screen.getByText('Sim')).toBeTruthy()
    act(() => { screen.getByRole('button', { name: 'Switch to Demo' }).click() })
    // The confirm is up and NOTHING has been sent yet.
    expect(await screen.findByText(railSwitchStatement(TAG, 'demo'))).toBeTruthy()
    expect(posts(sent)).toHaveLength(0)

    const buttons = screen.getAllByRole('button', { name: 'Switch to Demo' })
    act(() => { buttons[buttons.length - 1]?.click() })
    await waitFor(() => expect(posts(sent)).toHaveLength(1))
    expect(posts(sent)[0]?.path).toBe(RAIL_PATH)
    expect(posts(sent)[0]?.body).toEqual({ mode: 'paper', rail: 'demo' })
    await waitFor(() => expect(switched).toHaveLength(1))
    expect(switched[0]?.dx_paper_rail).toBe('demo')
    expect(await screen.findByText(/rail is now Demo/)).toBeTruthy()
  })

  test('the confirmation says next order, testnet credentials, and the held-legs refusal', () => {
    const s = railSwitchStatement(TAG, 'demo')
    expect(s).toMatch(/next order/)
    expect(s).toMatch(/testnet/)
    expect(s).toMatch(/Delta Demo \(testnet\) credentials/)
    expect(s).toMatch(/refused while the book holds legs/)
    expect(railSwitchStatement(TAG, 'sim')).toMatch(/simulator/)
  })

  test('a book on Demo offers the way back to Sim', () => {
    installFetch(() => ({ body: {} }))
    render(<PaperRailControl row={bookRow({ dx_paper_rail: 'demo' })} onSwitched={() => {}} />)
    expect(screen.getByText('Demo')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Switch to Sim' })).toBeTruthy()
  })

  test('a row without the field reads as Sim (a desk that predates the rail)', () => {
    installFetch(() => ({ body: {} }))
    const { dx_paper_rail: _omit, ...old } = bookRow()
    render(<PaperRailControl row={old} onSwitched={() => {}} />)
    expect(screen.getByText('Sim')).toBeTruthy()
  })

  test("the server's 409 is shown as it wrote it, and nothing is reported switched", async () => {
    const refusal = `'${TAG}' holds 2 open leg(s) in paper — flatten the book before switching its rail`
    const switched: BookRow[] = []
    installFetch(({ path }) => (path === RAIL_PATH ? { status: 409, body: { error: refusal } } : { body: {} }))
    render(<PaperRailControl row={bookRow()} onSwitched={(r) => switched.push(r)} />)
    act(() => { screen.getByRole('button', { name: 'Switch to Demo' }).click() })
    await screen.findByText(railSwitchStatement(TAG, 'demo'))
    const buttons = screen.getAllByRole('button', { name: 'Switch to Demo' })
    act(() => { buttons[buttons.length - 1]?.click() })
    expect(await screen.findByText('Rail not switched')).toBeTruthy()
    expect(screen.getByText(new RegExp('holds 2 open leg'))).toBeTruthy()
    expect(switched).toHaveLength(0)
  })

  test('a live row draws nothing — its orders go to Delta proper', () => {
    installFetch(() => ({ body: {} }))
    const { container } = render(<PaperRailControl row={bookRow({ mode: 'live' })} onSwitched={() => {}} />)
    expect(container.textContent).toBe('')
  })
})
