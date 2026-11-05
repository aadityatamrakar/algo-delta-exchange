/**
 * THE NEW-BOOK WIZARD on screen: preset → expiry → dials → review & create,
 * with nothing traded. What the create posts is the contract; the rest is
 * that a settled expiry is not offered and a changed dial says so.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BookWizardPage } from '../src/book-wizard.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { expiryLabel } from '../src/chain-model.ts'
import { installFetch, type SentRequest } from './http.tsx'
import type { DeskMode } from '../src/api.ts'

/** A date `offset` days from today, YYYY-MM-DD in UTC — yesterday's has settled, tomorrow's has not. */
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

function mount(mode: DeskMode, taken: string[] = []): SentRequest[] {
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: [day(-1), day(1), day(2), day(9)] } }
    if (path === '/v1/desk/books/registry' && method === 'GET') {
      return { body: { books: taken.map((tag) => ({ tag })) } }
    }
    if (path === '/v1/desk/books/registry' && method === 'POST') return { body: { tag: 'created' } }
    return { body: {} }
  })
  render(
    <AuthProvider>
      <ModeProvider>
        <BookWizardPage mode={mode} />
      </ModeProvider>
    </AuthProvider>,
  )
  return sent
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the new-book wizard', () => {
  test('preset, expiry, a changed dial, then a create that posts the preset plus the change', async () => {
    const sent = mount('paper')

    // 1 · the preset: every BULL-S one is offered, the daily picked.
    fireEvent.click(await screen.findByRole('button', { name: 'BULL-S — BTC daily ($200 grid)' }))
    expect(screen.getByRole('button', { name: 'BULL-S — BTC weekly ($500 grid)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // 2 · the expiry: the settled one is not offered; the nearest live one is picked.
    const tag = `BTC-${day(1)}-bull-s-btc-daily`
    await screen.findByText(tag)
    expect(screen.queryByRole('button', { name: new RegExp(expiryLabel(day(-1))) })).toBe(null)
    expect(screen.getByRole('button', { name: new RegExp(expiryLabel(day(2))) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // 3 · the dials: titled, described, starting at the preset.
    expect(screen.getByText(/Loss limit for the whole book/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Book loss cap'), { target: { value: '100' } })
    await screen.findByText(/changed from the preset’s 250/)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // 4 · the review names the change and what will (not) happen.
    expect(screen.getByText(/250 → 100/)).toBeTruthy()
    expect(screen.getByText(/created STOPPED/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create book' }))

    await screen.findByText(new RegExp(`Created ${tag}`))
    const post = sent.find((r) => r.path === '/v1/desk/books/registry' && r.method === 'POST')
    expect(post?.body).toMatchObject({ tag, symbol: 'BTC', expiry: day(1), mode: 'paper', variant: 'bull-s-btc-daily' })
    const dials = post?.body?.['dials'] as Record<string, unknown>
    expect(dials).toMatchObject({ bs_enabled: true, bs_loss_cap: 100, bs_lots_start: 50, bs_lots_cap: 150 })
    // Nothing from the structure builder's two boxes.
    expect(dials['target_pnl']).toBeUndefined()
    expect(dials['margin_cap']).toBeUndefined()
  })

  test('a LION-S book: picked in step 1, created with per-leg stops and a flat size', async () => {
    const sent = mount('paper')
    fireEvent.click(await screen.findByRole('button', { name: 'LION-S — BTC daily ($200 grid, per-leg stop)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    const tag = `BTC-${day(1)}-lion-s-btc-daily`
    await screen.findByText(tag)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByLabelText('Per-leg stop and re-entry (LION-S)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create book' }))
    await screen.findByText(new RegExp(`Created ${tag}`))
    const post = sent.find((r) => r.path === '/v1/desk/books/registry' && r.method === 'POST')
    expect(post?.body).toMatchObject({ tag, variant: 'lion-s-btc-daily' })
    expect(post?.body?.['dials']).toMatchObject({ bs_enabled: true, bs_per_leg: true, bs_lots_start: 50, bs_lots_step: 0, bs_lots_cap: 50 })
  })

  test('a live book cannot be created without a margin budget', async () => {
    const sent = mount('live')
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText(`BTC-${day(1)}-bull-s-btc-daily`)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getAllByText(/needs a margin budget above 0/).length).toBeGreaterThan(0)
    const create = screen.getByRole('button', { name: 'Create book' })
    expect(create.hasAttribute('disabled') || create.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(create)
    await waitFor(() => expect(sent.some((r) => r.method === 'POST')).toBe(false))
  })

  test('a tag another book holds is named on the expiry step', async () => {
    mount('paper', [`BTC-${day(1)}-bull-s-btc-daily`])
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText(/already exists in paper/)
  })
})
