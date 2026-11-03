/** The Market Watch page: three chains, their headings, the BF tooltips, the dead-feed banner, and polling that stops when hidden. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MarketWatchPage, MARKET_POLL_MS, chainHeading } from '../../src/traders/market-watch.tsx'
import { installFetch, type SentRequest } from '../http.tsx'
import type { MarketChain, MarketSide, MarketWatchView } from '../../../traders/src/analytics/r3-wire.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'hidden')
  try { window.localStorage.clear() } catch { /* none */ }
})

const GUESS = 'our reading of VolHedge, unconfirmed (Phase 0, Q3)'

function side(over: Partial<MarketSide> = {}): MarketSide {
  return {
    ltp: 100, change: 5, changePct: 5.26, oi: 1000, oiChange: -200, volume: 50, iv: 0.245, ivSource: 'quote', stale: false,
    delta: 0.5, gamma: 0.002, vega: 3.1, theta: -1.8, bf: 2.5, bf2: null, ratio: 1, ageMs: 500, ...over,
  }
}

function chain(expiry: string, over: Partial<MarketChain> = {}): MarketChain {
  return {
    expiry, lotSize: 175, step: 50,
    future: { ltp: 3412.5, change: 12.3, changePct: 0.36, ageMs: 400, stale: false }, forward: 3412.5, forwardSource: 'future',
    rows: [
      { strike: 3400, straddle: 180, ce: side({ oiChange: 300 }), pe: side() },
      { strike: 3450, straddle: 150, ce: side({ ltp: 60 }), pe: null },
    ],
    ...over,
  }
}

function view(over: Partial<MarketWatchView> = {}): MarketWatchView {
  return {
    stock: 'TCS', asOf: 1, spot: 3410, spotStale: false, feedAlive: true, fullChains: true, oiDay: '2026-10-19',
    chains: [chain('2026-10-27'), chain('2026-11-24'), chain('2026-12-29')],
    labels: { bf: `BF = …: ${GUESS}`, bf2: `BF2 = …: ${GUESS}`, ratio: `Ratio = …: ${GUESS}` },
    warnings: [], ...over,
  }
}

function mount(v: MarketWatchView): SentRequest[] {
  const sent = installFetch(() => ({ body: v }))
  render(<MarketWatchPage />)
  return sent
}

function pick(stock: string): void {
  fireEvent.change(screen.getByLabelText(/Underlying/), { target: { value: stock } })
  fireEvent.click(screen.getByRole('button', { name: 'Show' }))
}

const calls = (sent: SentRequest[]): number => sent.filter((r) => r.path === '/v1/traders/market/TCS').length

test('three chain headings with the future LTP and change', async () => {
  mount(view())
  pick('tcs')
  expect(await screen.findByText('TCS OCT FUT 3,412.50 +12.30 (0.36%)')).toBeTruthy()
  expect(screen.getByText('TCS NOV FUT 3,412.50 +12.30 (0.36%)')).toBeTruthy()
  expect(screen.getByText('TCS DEC FUT 3,412.50 +12.30 (0.36%)')).toBeTruthy()
})

test('a chain with no future is headed by its forward and where it came from', async () => {
  const none = chain('2026-10-20', { future: null, forward: 25040.2, forwardSource: 'parity' })
  mount(view({ stock: 'NIFTY', chains: [none] }))
  pick('NIFTY')
  expect(await screen.findByText('NIFTY 20 OCT · forward 25,040.20 (parity)')).toBeTruthy()
  expect(chainHeading('NIFTY', { ...none, forward: null, forwardSource: null })).toBe('NIFTY 20 OCT · forward —')
})

test('calls left, puts right, mirrored, blanks for unknowns', async () => {
  mount(view({ chains: [chain('2026-10-27')] }))
  pick('TCS')
  await screen.findByText('TCS OCT FUT 3,412.50 +12.30 (0.36%)')
  const head = screen.getAllByRole('columnheader').map((h) => h.textContent)
  expect(head.indexOf('Strike')).toBeGreaterThan(head.indexOf('OI chg'))
  expect(head.indexOf('OI chg')).toBeLessThan(head.lastIndexOf('OI chg'))
  expect(head[0]).toBe('OI chg')
  expect(head[head.length - 1]).toBe('OI chg')
  const rows = screen.getAllByRole('row')
  expect(within(rows[2]!).getAllByText('—').length).toBeGreaterThan(5)
})

test('BF, BF2 and Ratio headers show the unconfirmed label in a tooltip; other headers have none', async () => {
  mount(view({ chains: [chain('2026-10-27')] }))
  pick('TCS')
  await screen.findByText('TCS OCT FUT 3,412.50 +12.30 (0.36%)')
  for (const name of ['BF', 'BF2', 'Ratio']) {
    fireEvent.mouseEnter(screen.getAllByText(name)[0]!)
    fireEvent.focus(screen.getAllByText(name)[0]!)
    await waitFor(() => {
      const mine = screen.getAllByRole('tooltip').find((t) => t.textContent?.startsWith(`${name} =`))
      expect(mine?.textContent).toContain('unconfirmed')
    })
  }
})

const FEED_DEAD = 'the market data feed is dead: every price below is the last one seen'
const CLOSED = "market closed — last session's prices"

test('a dead feed in session is said once, from the server\'s warnings', async () => {
  mount(view({ feedAlive: false, warnings: [FEED_DEAD] }))
  pick('TCS')
  expect((await screen.findAllByText(/feed is dead/)).length).toBe(1)
})

test('outside the session only "market closed" is said, never a dead feed', async () => {
  mount(view({ feedAlive: false, warnings: [CLOSED] }))
  pick('TCS')
  expect(await screen.findByText(/market closed/)).toBeTruthy()
  expect(screen.queryByText(/feed is dead/)).toBeNull()
})

test('a capped subscription says there are gaps', async () => {
  mount(view({ fullChains: false }))
  pick('TCS')
  expect(await screen.findByText(/Subscription cap reached/)).toBeTruthy()
})

test('stale figures look stale: a stale side, a stale future and a stale spot', async () => {
  const stale = chain('2026-10-27', {
    future: { ltp: null, change: null, changePct: null, ageMs: null, stale: true },
    rows: [{ strike: 3400, straddle: 180, ce: side({ stale: true, oiChange: 300 }), pe: side() }],
  })
  mount(view({ spotStale: true, chains: [stale] }))
  pick('TCS')
  expect(await screen.findByText('TCS OCT FUT — (stale)')).toBeTruthy()
  expect(screen.getByText(/spot 3,410.00 \(stale\)/)).toBeTruthy()
  expect(screen.getByText(/Grey italic figures are stale/)).toBeTruthy()
  const cells = [...document.querySelectorAll('[data-stale="true"]')]
  expect(cells.length).toBeGreaterThan(5)
  for (const c of cells) {
    expect(c.getAttribute('style')).toContain('italic')
    expect(c.getAttribute('style')).not.toContain('color-mix')
  }
})

test('a straddle built from a stale leg is stale, and stays off the straddle colour scale', async () => {
  const rows = chain('2026-10-27', {
    rows: [
      { strike: 3400, straddle: 310, ce: side({ stale: true }), pe: side() },
      { strike: 3450, straddle: 150, ce: side(), pe: side() },
      { strike: 3500, straddle: 90, ce: side(), pe: side() },
    ],
  })
  mount(view({ chains: [rows] }))
  pick('TCS')
  const stale = await screen.findByText('310.00')
  expect(stale.getAttribute('data-stale')).toBe('true')
  expect(stale.getAttribute('style')).not.toContain('color-mix')
  // Scaled over the live 150 and 90 only: 150 is the column's top step (36%), not 2 of 3 against the stale 310.
  expect(screen.getByText('150.00').getAttribute('style')).toContain('36%')
})

test('a stale figure says "(stale)" to a screen reader, not by its look alone', async () => {
  const stale = chain('2026-10-27', { rows: [{ strike: 3400, straddle: 180, ce: side({ stale: true }), pe: side() }] })
  mount(view({ chains: [stale] }))
  pick('TCS')
  await screen.findByText('TCS OCT FUT 3,412.50 +12.30 (0.36%)')
  const cells = [...document.querySelectorAll('[data-stale="true"]')]
  expect(cells.length).toBeGreaterThan(5)
  for (const c of cells) expect(within(c as HTMLElement).getByText('(stale)')).toBeTruthy()
  // A live cell carries no such word.
  expect(screen.getAllByText('(stale)')).toHaveLength(cells.length)
})

test('the BF, BF2 and Ratio labels are on screen as text, with no hover needed', async () => {
  const v = view({ chains: [chain('2026-10-27')] })
  mount(v)
  pick('TCS')
  await screen.findByText('TCS OCT FUT 3,412.50 +12.30 (0.36%)')
  // The headers' tooltips hold the same words in a hidden layer; what counts is the text outside one.
  const shown = (label: string): Element[] => screen.queryAllByText(label).filter((e) => e.closest('[role="tooltip"]') === null)
  for (const label of [v.labels.bf, v.labels.bf2, v.labels.ratio]) expect(shown(label)).toHaveLength(1)
  // A labelled column taken off the screen takes its line with it.
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'BF2' }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(shown(v.labels.bf2)).toHaveLength(0)
  expect(shown(v.labels.bf)).toHaveLength(1)
})

test('the column dialog hides a column and the choice is remembered', async () => {
  mount(view({ chains: [chain('2026-10-27')] }))
  pick('TCS')
  await screen.findByText('TCS OCT FUT 3,412.50 +12.30 (0.36%)')
  expect(screen.getAllByText('Gamma').length).toBe(2)
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Gamma' }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryAllByText('Gamma').length).toBe(0)
  expect(window.localStorage.getItem('traders.market.columns')).not.toContain('gamma')
})

test('polls every 5 s while visible; a hidden page makes no call; unmount stops it', async () => {
  vi.useFakeTimers()
  const sent = mount(view())
  pick('TCS')
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(calls(sent)).toBe(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(MARKET_POLL_MS) })
  expect(calls(sent)).toBe(2)

  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  const before = calls(sent)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(calls(sent)).toBe(before)

  Reflect.deleteProperty(document, 'hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls(sent)).toBe(before + 1)

  cleanup()
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(calls(sent)).toBe(before + 1)
})

test('a page opened hidden makes no call at all', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  const sent = mount(view())
  pick('TCS')
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(calls(sent)).toBe(0)
})

test('an invalid underlying cannot be shown', () => {
  const sent = mount(view())
  fireEvent.change(screen.getByLabelText(/Underlying/), { target: { value: 'bad name!' } })
  expect((screen.getByRole('button', { name: 'Show' }) as HTMLButtonElement).disabled).toBe(true)
  expect(sent.length).toBe(0)
})

test('the column dialog pins the straddle and keeps at least one column on', async () => {
  mount(view({ chains: [chain('2026-10-27')] }))
  pick('TCS')
  await screen.findByText('TCS OCT FUT 3,412.50 +12.30 (0.36%)')
  fireEvent.click(screen.getByRole('button', { name: 'Columns' }))
  await screen.findByRole('checkbox', { name: 'Gamma' })
  expect(screen.queryByRole('button', { name: 'Move Straddle up' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Move BF2 down' }))
  expect(JSON.parse(window.localStorage.getItem('traders.market.columns')!)).toEqual(
    ['oiChange', 'oi', 'bf', 'ratio', 'straddle', 'bf2', 'volume', 'delta', 'gamma', 'vega', 'theta', 'change', 'changePct', 'iv', 'ltp'],
  )
  for (const c of ['OI chg', 'OI', 'BF', 'BF2', 'Straddle', 'Ratio', 'Volume', 'Delta', 'Gamma', 'Vega', 'Theta', 'Chg', 'Chg %', 'IV %']) {
    fireEvent.click(screen.getByRole('checkbox', { name: c }))
  }
  expect((screen.getByRole('checkbox', { name: 'LTP' }) as HTMLInputElement).disabled).toBe(true)
})
