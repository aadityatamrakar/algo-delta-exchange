/** The admin charges editor: seed flag, number-only saves, the server's 400 text, the confirmed stamp. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AdminCharges } from '../src/traders/admin-charges.tsx'
import { installFetch, type SentRequest } from './http.tsx'
import type { ChargeRates, SegmentRates } from '../../traders/src/analytics/wire.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const seg = (sttSellPct: number): SegmentRates => ({ sttBuyPct: 0, sttSellPct, exchangePct: 0.0503, stampBuyPct: 0.003 })
const SEED: ChargeRates = {
  option: seg(0.1), future: seg(0.02), share: seg(0.1), sebiPerCrore: 10, gstPct: 18,
  brokerage: { default: { mode: 'order', amount: 20 }, byTrader: { ravi: { mode: 'lot', amount: 5 } } },
  confirmedBy: null, confirmedAt: null,
}
const TRADERS = [{ username: 'ravi' }, { username: 'sita' }]

function mount(put?: (body: Record<string, unknown> | null) => { status?: number; body?: unknown }): SentRequest[] {
  const sent = installFetch((req) => {
    if (req.path === '/v1/traders/admin/settings' && req.method === 'GET') return { body: { charges: SEED } }
    if (req.path === '/v1/traders/admin/settings' && req.method === 'PUT') return put?.(req.body) ?? { body: { charges: SEED } }
    if (req.path === '/v1/traders/admin/traders') return { body: TRADERS }
    return { body: {} }
  })
  render(<AdminCharges />)
  return sent
}
const puts = (sent: SentRequest[]): SentRequest[] => sent.filter((r) => r.method === 'PUT')
const save = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Save charges' })) }

test('the seed banner shows while confirmedBy is null', async () => {
  mount()
  expect(await screen.findByText('Seed values — not confirmed. Check each against the current rates before saving.')).toBeTruthy()
  expect((screen.getByLabelText('Option STT sell %') as HTMLInputElement).value).toBe('0.1')
})

test('changing Option STT sell % saves a number', async () => {
  const sent = mount()
  const input = await screen.findByLabelText('Option STT sell %')
  fireEvent.change(input, { target: { value: '0.0625' } })
  save()
  await waitFor(() => expect(puts(sent)).toHaveLength(1))
  const charges = puts(sent)[0]!.body!.charges as ChargeRates
  expect(charges.option.sttSellPct).toBe(0.0625)
  expect(charges.gstPct).toBe(18)
  expect(charges.brokerage.byTrader).toEqual({ ravi: { mode: 'lot', amount: 5 } })
})

test('a blank or non-numeric field blocks Save and names the field', async () => {
  const sent = mount()
  fireEvent.change(await screen.findByLabelText('GST %'), { target: { value: '' } })
  save()
  expect(await screen.findByText('GST % must be a number')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('GST %'), { target: { value: '18' } })
  fireEvent.change(screen.getByLabelText('Future Exchange %'), { target: { value: 'abc' } })
  save()
  expect(await screen.findByText('Future Exchange % must be a number')).toBeTruthy()
  expect(puts(sent)).toHaveLength(0)
})

test('a value outside the server range blocks Save with a friendly message', async () => {
  const sent = mount()
  fireEvent.change(await screen.findByLabelText('GST %'), { target: { value: '60' } })
  save()
  expect(await screen.findByText('GST % must be between 0 and 50')).toBeTruthy()
  expect(puts(sent)).toHaveLength(0)
})

test("a 400 shows the server's error text as is", async () => {
  mount(() => ({ status: 400, body: { error: 'gstPct must be 0–50' } }))
  await screen.findByLabelText('GST %')
  save()
  expect(await screen.findByText('gstPct must be 0–50')).toBeTruthy()
})

test('after a save the banner becomes Confirmed by <name> on <date> in IST', async () => {
  const at = new Date('2026-10-19T23:30:00+05:30').getTime()
  mount(() => ({ body: { charges: { ...SEED, confirmedBy: 'admin', confirmedAt: at } } }))
  await screen.findByLabelText('GST %')
  save()
  expect(await screen.findByText('Confirmed by admin on 19 Oct 2026')).toBeTruthy()
  expect(screen.queryByText(/Seed values/)).toBeNull()
})

test('per-trader brokerage rows: add from the trader list, remove', async () => {
  const sent = mount()
  await screen.findByLabelText('GST %')
  const ravi = screen.getByText('ravi').closest('tr') as HTMLElement
  fireEvent.click(within(ravi).getByRole('button', { name: 'Remove' }))
  save()
  await waitFor(() => expect(puts(sent)).toHaveLength(1))
  expect((puts(sent)[0]!.body!.charges as ChargeRates).brokerage.byTrader).toEqual({})
  // sita can now be added; ravi is back on the default.
  fireEvent.click(screen.getByRole('button', { name: 'Add override for sita' }))
  expect(screen.getByLabelText('sita brokerage amount')).toBeTruthy()
})

test('the page says it changes estimates only', async () => {
  mount()
  expect(await screen.findByText(/estimate/i)).toBeTruthy()
})

function pick(name: string, option: string): void {
  act(() => { screen.getByRole('combobox', { name }).click() })
  act(() => { screen.getByRole('option', { name: option }).click() })
}

test('the brokerage mode pickers send the chosen mode', async () => {
  const sent = mount()
  await screen.findByLabelText('GST %')
  pick('Default brokerage mode', 'Per lot')
  fireEvent.change(screen.getByLabelText('Default brokerage amount'), { target: { value: '12.5' } })
  pick('ravi brokerage mode', 'Per order')
  save()
  await waitFor(() => expect(puts(sent)).toHaveLength(1))
  const b = (puts(sent)[0]!.body!.charges as ChargeRates).brokerage
  expect(b.default).toEqual({ mode: 'lot', amount: 12.5 })
  expect(b.byTrader.ravi?.mode).toBe('order')
})

test('adding a trader seeds it from the default; Remove brings its Add button back', async () => {
  const sent = mount((body) => ({ body: { charges: body!.charges } }))
  await screen.findByLabelText('GST %')
  fireEvent.click(screen.getByRole('button', { name: 'Add override for sita' }))
  expect(screen.queryByRole('button', { name: 'Add override for sita' })).toBeNull()
  save()
  await waitFor(() => expect(puts(sent)).toHaveLength(1))
  expect((puts(sent)[0]!.body!.charges as ChargeRates).brokerage.byTrader.sita).toEqual({ mode: 'order', amount: 20 })
  fireEvent.click(within(screen.getByText('sita').closest('tr') as HTMLElement).getByRole('button', { name: 'Remove' }))
  expect(screen.getByRole('button', { name: 'Add override for sita' })).toBeTruthy()
})

test('a Save reply without charges is an error banner and the form keeps what was typed', async () => {
  mount(() => ({ body: {} }))
  const gst = await screen.findByLabelText('GST %')
  fireEvent.change(gst, { target: { value: '12' } })
  save()
  expect(await screen.findByText('Could not save the charges: unexpected reply')).toBeTruthy()
  expect((screen.getByLabelText('GST %') as HTMLInputElement).value).toBe('12')
})
