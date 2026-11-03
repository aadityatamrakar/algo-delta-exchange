/** The Scenario tab's payoff chart: target-date and IV-shift sliders, and the Sensibull P&L table. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { PayoffSliders } from '../src/traders/payoff-sliders.tsx'
import { ScenarioTab } from '../src/traders/scenario-tab.tsx'
import { SCENARIO_START, useScenarioInputs, useViewer } from '../src/traders/viewer.ts'
import { installFetch, type SentRequest } from './http.tsx'
import type { ScenarioView } from '../../traders/src/analytics/wire.ts'

const ASOF = new Date('2026-10-19T10:27:00+05:30').getTime()
const PATH = '/v1/traders/books/TCS/scenario'

function view(over: Partial<ScenarioView> = {}): ScenarioView {
  return {
    stock: 'TCS', asOf: ASOF, closed: false, nearExpiry: '2026-10-27', lastExpiry: '2026-11-23', expiries: ['2026-10-27', '2026-11-23'],
    lotSize: 175, lotGcd: 1,
    resolved: {
      spot: 3000, callVolShift: 0, putVolShift: 0, volShift: 0, start: '2026-10-19', end: '2026-10-27', everyNth: 1,
      middle: 3000, stepPct: 0.5, count: 2, targetDate: '2026-10-19',
    },
    totals: { pnl: 0, delta: 0, gamma: 0, vega: 0, theta: 0, volga: 0, vanna: 0 }, legs: [],
    grid: { spots: [3000], currentRow: 0, dates: ['2026-10-19'], labels: ['19 Oct'], cells: [[{ pnl: 0, delta: 0, gamma: 0, vega: 0, theta: 0, volga: 0, vanna: 0 }]] },
    baseNote: '',
    chart: {
      targetDate: '2026-10-24', expiryDate: '2026-10-27', spot: 3000,
      points: [{ price: 2900, target: -1500, expiry: -2000 }, { price: 3000, target: 500, expiry: 0 }, { price: 3100, target: 2500, expiry: 2000 }],
    },
    table: [
      { label: 'spot', price: 3000, target: 500, expiry: 0 },
      { label: '-1%', price: 2970, target: -100, expiry: -525 },
      { label: '+1%', price: 3030, target: 1100, expiry: 525 },
    ],
    hypothetical: [], warnings: [],
    ...over,
  }
}

afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  const s = renderHook(() => useScenarioInputs('TCS'))
  act(() => s.result.current.patch(SCENARIO_START))
  s.unmount()
  const v = renderHook(() => useViewer('TCS'))
  act(() => v.result.current.setUnits('position'))
  v.unmount()
})

function mount(over: Partial<ScenarioView> = {}): SentRequest[] {
  vi.useFakeTimers()
  const sent = installFetch(({ path }) => (path === PATH ? { body: view(over) } : { status: 404, body: { error: 'no such route' } }))
  render(<ScenarioTab stock="TCS" />)
  return sent
}
const settle = async (ms = 0): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const calls = (sent: readonly SentRequest[]): SentRequest[] => sent.filter((r) => r.path === PATH && r.method === 'POST')
const lastBody = (sent: readonly SentRequest[]): Record<string, unknown> => calls(sent).at(-1)?.body ?? {}
const thumb = (name: string): HTMLElement => screen.getByRole('slider', { name })
const press = (el: HTMLElement, key: string, n = 1): void => { for (let i = 0; i < n; i++) fireEvent.keyDown(el, { key }) }
function table(): HTMLTableElement {
  const t = document.querySelector<HTMLTableElement>('table[aria-label="Sensibull payoff table"]')
  if (t === null) throw new Error('no payoff table')
  return t
}

test('the date slider sends a target date after the debounce', async () => {
  const sent = mount()
  await settle()
  expect(lastBody(sent)).toEqual({})
  press(thumb('Target date'), 'ArrowRight', 5)
  await settle(299)
  expect(lastBody(sent)).toEqual({})
  await settle(1)
  expect(lastBody(sent)).toEqual({ targetDate: '2026-10-24' })
  // The label shows the date, as DD Mon.
  expect(thumb('Target date').getAttribute('aria-valuetext')).toBe('24 Oct')
})

test('the IV slider and the overall vol input are one state', async () => {
  const sent = mount()
  await settle()
  press(thumb('IV shift'), 'ArrowRight', 3)
  const vol = (): HTMLInputElement => document.getElementById([...document.querySelectorAll('label')].find((l) => l.textContent === 'Vol')!.htmlFor) as HTMLInputElement
  expect(vol().value).toBe('3')
  await settle(300)
  expect(lastBody(sent)).toEqual({ volShift: 3 })
  // And the other way: a value typed in the strip moves the thumb, and one outside ±20 clamps the thumb only.
  fireEvent.change(vol(), { target: { value: '35' } })
  await settle(300)
  expect(lastBody(sent)).toEqual({ volShift: 35 })
  expect(vol().value).toBe('35')
  expect(thumb('IV shift').getAttribute('aria-valuenow')).toBe('20')
})

test('the Sensibull table follows the server\'s rows', async () => {
  mount()
  await settle()
  const heads = [...table().querySelectorAll('thead th')].map((h) => h.textContent)
  expect(heads).toEqual(['Price', 'Label', 'P&L on 24 Oct', 'P&L at expiry 27 Oct'])
  const rows = [...table().querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))
  expect(rows).toEqual([
    ['3,000.00', 'spot', '+500', '0'],
    ['2,970.00', '-1%', '-100', '-525'],
    ['3,030.00', '+1%', '+1,100', '+525'],
  ])
})

test('the table follows the units toggle', async () => {
  mount({ lotGcd: 1 })
  await settle()
  fireEvent.click(screen.getByRole('radio', { name: 'Per lot' }))
  const second = [...table().querySelectorAll('tbody tr')][1]!
  expect(second.querySelectorAll('td')[3]!.textContent).toBe('-525')
  fireEvent.click(screen.getByRole('radio', { name: 'Per share' }))
  expect(second.querySelectorAll('td')[3]!.textContent).toBe('-3')
})

/** jsdom measures nothing: one fixed size, so the chart lays out its axes and answers a hover. */
function measured(): void {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element): void { this.cb([{ target, contentRect: { width: 900, height: 300 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve(): void {}
    disconnect(): void {}
  })
}

test('the chart follows the units toggle as its table does: the plotted values, the axis and the tooltip (final fix I3)', async () => {
  measured()
  const v = renderHook(() => useViewer('TCS'))
  const { container } = render(<PayoffSliders view={view({ lotGcd: 2 })} today="2026-10-19" onTarget={() => {}} onVolShift={() => {}} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  const top = (): number => Math.max(...[...container.querySelectorAll('[class*="yAxis"] text')].map((t) => Number((t.textContent ?? '').replaceAll(',', ''))))
  /** The tooltip at the middle point (3,000, the spot row of the table). */
  const hover = async (): Promise<string> => {
    const chart = container.querySelector('.recharts-wrapper') as HTMLElement
    fireEvent.mouseMove(chart, { clientX: 450, clientY: 150 })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    return container.querySelector('.recharts-tooltip-wrapper')?.textContent ?? ''
  }
  const spotRow = (): string[] => [...[...table().querySelectorAll('tbody tr')][0]!.querySelectorAll('td')].map((c) => c.textContent ?? '')

  expect(top()).toBeGreaterThanOrEqual(2500)
  expect(await hover()).toContain('Target 24 Oct : +500')
  expect(spotRow()[2]).toBe('+500')
  act(() => v.result.current.setUnits('lot'))                    // ÷ 2 lots
  expect(top()).toBeGreaterThanOrEqual(1250)
  expect(top()).toBeLessThan(2500)
  expect(await hover()).toContain('Target 24 Oct : +250')
  expect(spotRow()[2]).toBe('+250')
  act(() => v.result.current.setUnits('share'))                  // ÷ (2 × 175)
  expect(top()).toBeLessThan(20)
  expect(await hover()).toContain('Target 24 Oct : +1')
  expect(spotRow()[2]).toBe('+1')
  v.unmount()
})

test('a view with no chart points says so, and a bad number is never sent', () => {
  const onTarget = vi.fn()
  const onVol = vi.fn()
  render(<PayoffSliders view={view({ chart: { targetDate: '2026-10-24', expiryDate: '2026-10-27', spot: 3000, points: [] }, table: [] })}
    today="2026-10-19" onTarget={onTarget} onVolShift={onVol} />)
  expect(screen.getByText('No payoff to draw for this book.')).toBeTruthy()
  press(thumb('IV shift'), 'End')
  press(thumb('Target date'), 'Home')
  for (const c of [...onTarget.mock.calls, ...onVol.mock.calls]) expect(typeof c[0] === 'number' ? Number.isFinite(c[0]) : /^\d{4}-\d{2}-\d{2}$/.test(c[0])).toBe(true)
})
