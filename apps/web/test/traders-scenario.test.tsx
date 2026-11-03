/** The Scenario sub-tab: VolHedge v50's Scenario window over POST /scenario. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { BookTab } from '../src/traders/book.tsx'
import { METRICS } from '../src/traders/scenario-grid.tsx'
import { ScenarioTab, scenarioBody } from '../src/traders/scenario-tab.tsx'
import { SCENARIO_START, useScenarioInputs, useViewer, type HypoRow } from '../src/traders/viewer.ts'
import { openWhatIf } from '../src/traders/what-if.ts'
import { installFetch, type SentRequest } from './http.tsx'
import { bookView } from './traders/fixtures.ts'
import type { HypotheticalLeg, ScenarioCell, ScenarioLegRow, ScenarioView } from '../../traders/src/analytics/wire.ts'

const ASOF = new Date('2026-10-19T10:27:00+05:30').getTime()

const METRIC_LABELS = ['Profit & Loss', 'P & L Value', 'Delta', 'Delta Value', 'Gamma', 'Gamma Value', 'Vega', 'Vega Value',
  'Theta', 'Theta Value', 'Volga', 'Volga Value', 'Vanna', 'Vanna Value']
const LEG_HEADERS = ['Expiry', 'C/P/F', 'Underlying', 'Strike', 'Qty', 'Rate', 'Vol(%)', 'LTP', 'Delta', 'Del Val', 'Gamma', 'Gam Val',
  'Vega', 'Vg Val', 'Theta', 'Th Val']
const VALUE_NOTE = 'Value = whole position (greek × units); the plain metric follows the units toggle — our reading of VolHedge (Phase 0 Q3)'
const BASE_NOTE = "Grid: P&L since yesterday's close (carried legs) and since the fill (today's trades), as VolHedge. Chart and table: P&L against net price, as Sensibull."

const LABELS = ['19 Oct', '20 Oct', '21 Oct', '22 Oct', '23 Oct', '26 Oct', '27 Oct', 'Expiry']
const DATES = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-27']
const SPOTS = [2970, 2985, 3000, 3015, 3030]

/** Whole-position cells; (0,0) carries VolHedge's delta of −525. */
const CELLS: ScenarioCell[][] = SPOTS.map((_, r) => LABELS.map((_, c) => ({
  pnl: (2 - r) * 1000 - c * 10, delta: -525 + r * 10 + c, gamma: -0.4293, vega: -3105 + c, theta: 6040 - c, volga: 192.64, vanna: 9.91,
})))
const TOTALS: ScenarioCell = { pnl: 16188, delta: -420, gamma: -40.4293, vega: -3105, theta: 6040, volga: 192.64, vanna: 9.91 }

const BOOK_CALL: ScenarioLegRow = {
  id: 'C0001|option|TCS|2026-10-27|3000|CE', hypothetical: false, expiry: '2026-10-27', type: 'C', underlying: 3010, strike: 3000,
  qty: -175, rate: 50, vol: 0.2534, ltp: 60, delta: 0.55, deltaValue: -96.25, gamma: 0.0021, gammaValue: -0.3675,
  vega: 3.1, vegaValue: -542.5, theta: -1.8, thetaValue: 315,
}
const BOOK_FUT: ScenarioLegRow = {
  id: 'C0001|future|TCS|2026-10-27||', hypothetical: false, expiry: '2026-10-27', type: 'F', underlying: 3010, strike: null,
  qty: 175, rate: 3000, vol: null, ltp: 3010, delta: 1, deltaValue: 175, gamma: 0, gammaValue: 0, vega: 0, vegaValue: 0, theta: 0, thetaValue: 0,
}

function view(over: Partial<ScenarioView> = {}): ScenarioView {
  return {
    stock: 'TCS', asOf: ASOF, closed: false, nearExpiry: '2026-10-27', lastExpiry: '2026-11-23', expiries: ['2026-10-27', '2026-11-23'],
    lotSize: 175, lotGcd: 1,
    resolved: {
      spot: 3000, callVolShift: 0, putVolShift: 0, volShift: 0, start: '2026-10-19', end: '2026-10-27', everyNth: 1,
      middle: 3000, stepPct: 0.5, count: 2, targetDate: '2026-10-19',
    },
    totals: TOTALS, legs: [BOOK_CALL, BOOK_FUT],
    grid: { spots: SPOTS, currentRow: 2, dates: DATES, labels: LABELS, cells: CELLS },
    baseNote: BASE_NOTE,
    chart: { targetDate: '2026-10-19', expiryDate: '2026-10-27', spot: 3000, points: [] },
    table: [], hypothetical: [], warnings: [],
    ...over,
  }
}

/** The stores are module state shared by every test: put TCS back as a fresh page would find it. */
function resetStores(stock: string): void {
  const v = renderHook(() => useViewer(stock))
  act(() => {
    const s = v.result.current.state
    for (const k of s.exclude) v.result.current.toggleExclude(k)
    for (const k of s.illiquid) v.result.current.toggleIlliquid(k)
    for (const k of Object.keys(s.ivOverrides)) v.result.current.setIv(k, null)
    v.result.current.setUnits('position')
  })
  v.unmount()
  const s = renderHook(() => useScenarioInputs(stock))
  act(() => s.result.current.patch(SCENARIO_START))
  s.unmount()
}

// Unmount first: a tab still on screen would answer the reset with a request.
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetStores('TCS') })

const SCENARIO_PATH = '/v1/traders/books/TCS/scenario'

// `findBy*` polls on the timers `useFakeTimers` replaces, so these advance the
// fake clock and read with `getBy*` (as traders-analysis.test.tsx does).
function mount(over: Partial<ScenarioView> = {}): SentRequest[] {
  vi.useFakeTimers()
  const sent = installFetch(({ path }) => (path === SCENARIO_PATH ? { body: view(over) } : { status: 404, body: { error: 'no such route' } }))
  render(<ScenarioTab stock="TCS" />)
  return sent
}

async function settle(ms = 0): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const scenarioCalls = (sent: readonly SentRequest[]): SentRequest[] => sent.filter((r) => r.path === SCENARIO_PATH && r.method === 'POST')
const lastBody = (sent: readonly SentRequest[]): Record<string, unknown> => scenarioCalls(sent).at(-1)?.body ?? {}

// This tab is a large DOM (three tables of inputs), where every document-wide `getByRole`/`getByLabelText`
// walks a thousand nodes and costs tens of milliseconds. These helpers go straight to the element instead.

function table(name: string): HTMLTableElement {
  const t = document.querySelector<HTMLTableElement>(`table[aria-label="${name}"]`)
  if (t === null) throw new Error(`no table "${name}"`)
  return t
}
const rowsOf = (name: string): HTMLElement[] => [...table(name).querySelectorAll<HTMLElement>('tbody tr')]
const headersOf = (name: string): string[] => [...table(name).querySelectorAll('thead th')].map((h) => h.textContent ?? '')
function cellEl(name: string, i: number, header: string): HTMLElement {
  const td = rowsOf(name)[i]?.querySelectorAll<HTMLElement>('td')[headersOf(name).indexOf(header)]
  if (td === undefined) throw new Error(`no cell ${header} in row ${i} of "${name}"`)
  return td
}
/** The text of `header`'s cell in body row `i` of the table named `name`. */
const cell = (name: string, i: number, header: string): string => cellEl(name, i, header).textContent ?? ''

/** The control a `<label for>` with exactly this text names (what `getByLabelText` finds, without the walk). */
function labelled(name: string): HTMLElement {
  const find = (): HTMLElement | null => {
    const label = [...document.querySelectorAll('label')].find((l) => l.textContent === name)
    return label === undefined || label.htmlFor === '' ? null : document.getElementById(label.htmlFor)
  }
  // Interval %, Strike +/-, M.Strike and Every Nth day sit in the strip's Adjust panel: open it when one is asked for
  let el = find()
  if (el === null && screen.queryByRole('button', { name: 'Adjust' }) !== null) {
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    el = find()
  }
  if (el === null) throw new Error(`nothing labelled "${name}"`)
  return el
}
function spin(name: string): HTMLInputElement {
  const el = labelled(name)
  if (!(el instanceof HTMLInputElement) || el.type !== 'number') throw new Error(`"${name}" is not a number input`)
  return el
}
const group = (name: string): HTMLElement => {
  const g = document.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"], [role="tablist"][aria-label="${name}"]`)
  if (g === null) throw new Error(`no group "${name}"`)
  return g
}
const metricTab = (name: string): HTMLElement => within(group('Metric')).getByRole('tab', { name })
const dateTick = (name: string): HTMLElement => within(group('Dates shown')).getByRole('checkbox', { name })

/** Choose `option` in the astryx Selector labelled `name`. */
function pick(name: string, option: string): void {
  const trigger = labelled(name)
  if (trigger.getAttribute('role') !== 'combobox') throw new Error(`"${name}" is not a combobox`)
  act(() => { trigger.click() })
  act(() => { screen.getByRole('option', { name: option }).click() })
}

test("fourteen metric tabs in VolHedge's order", async () => {
  mount()
  await settle()
  // By accessible name, in order (a Tab's text also holds a hidden copy of its label).
  const list = group('Metric')
  expect(within(list).getAllByRole('tab')).toEqual(METRIC_LABELS.map((name) => within(list).getByRole('tab', { name })))
  expect(METRICS.map((m) => m.label)).toEqual(METRIC_LABELS)
  expect(METRICS.map((m) => `${m.key}${m.value ? ' value' : ''}`)).toEqual([
    'pnl', 'pnl value', 'delta', 'delta value', 'gamma', 'gamma value', 'vega', 'vega value',
    'theta', 'theta value', 'volga', 'volga value', 'vanna', 'vanna value',
  ])
  // The top row prints `totals`, not a grid cell.
  expect(['Profit/Loss', 'Delta', 'Gamma', 'Vega', 'Theta', 'Volga', 'Vanna'].map((h) => cell('Scenario totals', 0, h)))
    .toEqual(['16,188', '-420', '-40.4293', '-3,105', '6,040', '192.64', '9.91'])
  // Losses red, profits green, through format.ts sign().
  expect(within(cellEl('Scenario totals', 0, 'Profit/Loss')).getByText('16,188').style.color).toBe('var(--color-text-green)')
  expect(within(cellEl('Scenario totals', 0, 'Delta')).getByText('-420').style.color).toBe('var(--color-text-red)')
  expect(screen.getByText(BASE_NOTE)).toBeTruthy()
})

test('Delta Value shows the position; Delta follows Per lot', async () => {
  mount({ lotGcd: 3 })
  await settle()
  fireEvent.click(metricTab('Delta Value'))
  expect(cell('Scenario grid', 0, '19 Oct')).toBe('-525')
  fireEvent.click(screen.getByRole('radio', { name: 'Per lot' }))
  // A Value metric is the whole position whatever the units.
  expect(cell('Scenario grid', 0, '19 Oct')).toBe('-525')
  fireEvent.click(metricTab('Delta'))
  expect(cell('Scenario grid', 0, '19 Oct')).toBe('-175')
  expect(screen.getByText(VALUE_NOTE)).toBeTruthy()
  // P&L: the plain metric per lot, the Value metric whole; profits green, losses red.
  fireEvent.click(metricTab('Profit & Loss'))
  expect(cell('Scenario grid', 0, '19 Oct')).toBe('667')
  fireEvent.click(metricTab('P & L Value'))
  expect([cell('Scenario grid', 0, '19 Oct'), cell('Scenario grid', 4, '19 Oct')]).toEqual(['2,000', '-2,000'])
  expect(within(cellEl('Scenario grid', 0, '19 Oct')).getByText('2,000').style.color).toBe('var(--color-text-green)')
  expect(within(cellEl('Scenario grid', 4, '19 Oct')).getByText('-2,000').style.color).toBe('var(--color-text-red)')
})

test('the expiry date and Expiry are both columns; hiding one sends no request', async () => {
  const sent = mount()
  await settle()
  expect(headersOf('Scenario grid')).toEqual(['SpotValue', 'Percent(%)', ...LABELS])
  expect(headersOf('Scenario grid')).toContain('27 Oct')
  expect(headersOf('Scenario grid')).toContain('Expiry')
  const before = scenarioCalls(sent).length
  fireEvent.click(dateTick('21 Oct'))
  expect(headersOf('Scenario grid')).toEqual(['SpotValue', 'Percent(%)', ...LABELS.filter((l) => l !== '21 Oct')])
  // The cells keep their own dates: the column after 20 Oct is now 22 Oct's.
  expect(cell('Scenario grid', 0, '22 Oct')).toBe('1,970')
  await settle(1000)
  expect(scenarioCalls(sent).length).toBe(before)
  fireEvent.click(dateTick('21 Oct'))
  expect(headersOf('Scenario grid')).toEqual(['SpotValue', 'Percent(%)', ...LABELS])
  await settle(1000)
  expect(scenarioCalls(sent).length).toBe(before)
})

test('the current spot row is marked', async () => {
  // jsdom lays nothing out: give the marked row a place, the grid's box a height, and watch where the box scrolls.
  const scrolled: number[] = []
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('aria-current') === 'true' ? 400 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200)
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation((n: number) => { scrolled.push(n) })
  const sent = mount()
  await settle()
  const rows = rowsOf('Scenario grid')
  expect(rows.map((r) => r.getAttribute('aria-current'))).toEqual([null, null, 'true', null, null])
  // Scrolled into view inside the grid's own box (centred: 400 − (200 − 20) / 2), never by moving the page.
  const box = table('Scenario grid').parentElement!
  expect(box.style.maxHeight).toBe('60vh')
  expect(scrolled).toEqual([310])
  // The 60 s refresh of the same rows leaves the viewer's scroll alone.
  await settle(60_000)
  expect(scenarioCalls(sent)).toHaveLength(2)
  expect(scrolled).toEqual([310])
  vi.restoreAllMocks()
  expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['2,970.00', '2,985.00', '3,000.00', '3,015.00', '3,030.00'])
  // Percent(%) is measured from M.Strike.
  expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual(['-1.00', '-0.50', '0.00', '0.50', '1.00'])
  cleanup()

  // A spot between two steps is its own row (the server inserts it); its percent is still from M.Strike.
  const spots = [2970, 2985, 3000, 3005, 3015, 3030]
  mount({ grid: { spots, currentRow: 3, dates: DATES, labels: LABELS, cells: [CELLS[0]!, CELLS[1]!, CELLS[2]!, CELLS[2]!, CELLS[3]!, CELLS[4]!] } })
  await settle()
  const marked = rowsOf('Scenario grid').filter((r) => r.getAttribute('aria-current') === 'true')
  expect(marked).toHaveLength(1)
  expect(within(marked[0]!).getAllByRole('cell').slice(0, 2).map((c) => c.textContent)).toEqual(['3,005.00', '0.17'])
})

test('Interval % and Strike +/- go in the body', async () => {
  const sent = mount()
  await settle()
  // Nothing set yet: every field is omitted and the server's defaults, echoed in `resolved`, fill the inputs.
  expect(lastBody(sent)).toEqual({})
  expect([spin('CMP').value, spin('Interval').value, spin('Strike +/-').value, spin('M.Strike').value, spin('Every Nth day').value])
    .toEqual(['3000', '0.5', '2', '3000', '1'])
  fireEvent.change(spin('Interval'), { target: { value: '0.25' } })
  fireEvent.change(spin('Strike +/-'), { target: { value: '20' } })
  await settle(300)
  expect(lastBody(sent)).toEqual({ stepPct: 0.25, count: 20 })
  fireEvent.change(spin('CMP'), { target: { value: '3050' } })
  fireEvent.change(spin('M.Strike'), { target: { value: '3100' } })
  fireEvent.change(spin('Every Nth day'), { target: { value: '2' } })
  fireEvent.change(spin('Call Vol'), { target: { value: '2' } })
  fireEvent.change(spin('Put Vol'), { target: { value: '-1' } })
  await settle(300)
  expect(lastBody(sent)).toEqual({ stepPct: 0.25, count: 20, spot: 3050, middle: 3100, everyNth: 2, callVolShift: 2, putVolShift: -1 })
})

test('a hypothetical row is sent in lots × lot size and its refusal shown', async () => {
  const REASON = 'TCS 2026-10-27 3050 CE is not listed'
  vi.useFakeTimers()
  const sent = installFetch(({ path, body }) => {
    if (path !== SCENARIO_PATH) return { status: 404, body: { error: 'no such route' } }
    const hyp = (body?.['hypothetical'] ?? []) as HypotheticalLeg[]
    return { body: view({ hypothetical: hyp.map((h) => ({ id: h.id, accepted: false, reason: REASON, entry: null, iv: null })) }) }
  })
  render(<ScenarioTab stock="TCS" />)
  await settle()
  const n = scenarioCalls(sent).length
  pick('C/P/F, new row', 'P')
  // The blank row became hypothetical 1; until it is complete it says what it needs and is not sent.
  await settle(300)
  expect(scenarioCalls(sent).length).toBe(n)
  expect(cell('Scenario legs', 2, 'Underlying')).toBe('Type the strike')
  fireEvent.change(spin('Strike, hypothetical 1'), { target: { value: '3100' } })
  fireEvent.change(spin('Lots, hypothetical 1'), { target: { value: '-1' } })
  await settle(300)
  expect(scenarioCalls(sent).length).toBe(n + 1)
  expect(lastBody(sent)['hypothetical']).toEqual([
    { id: 'h1', instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: null, iv: null },
  ])
  expect(screen.getByText(REASON)).toBeTruthy()
  // A new blank row waits under it.
  expect(spin('Strike, new row').value).toBe('')
  // Rate and Vol(%) are optional; a typed vol goes as a decimal.
  fireEvent.change(spin('Rate, hypothetical 1'), { target: { value: '118.5' } })
  fireEvent.change(spin('Vol(%), hypothetical 1'), { target: { value: '24.5' } })
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toEqual([
    { id: 'h1', instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: 118.5, iv: 0.245 },
  ])
  // Removing the row sends the scenario without it.
  fireEvent.click(within(table('Scenario legs')).getByRole('button', { name: 'Remove hypothetical 1' }))
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toBeUndefined()
})

test('with no lot size a hypothetical row asks for shares', async () => {
  const sent = mount({ lotSize: null })
  await settle()
  pick('C/P/F, new row', 'C')
  fireEvent.change(spin('Strike, hypothetical 1'), { target: { value: '3200' } })
  fireEvent.change(spin('Shares, hypothetical 1'), { target: { value: '-350' } })
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toEqual([
    { id: 'h1', instrument: 'option', expiry: '2026-10-27', strike: 3200, optType: 'CE', qty: -350, price: null, iv: null },
  ])
})

test('the + button raises the overall vol by 1', async () => {
  const sent = mount()
  await settle()
  expect(spin('Vol').value).toBe('0')
  fireEvent.click(within(group('Scenario inputs')).getByRole('button', { name: '+' }))
  await settle(300)
  expect(lastBody(sent)).toEqual({ volShift: 1 })
  expect(spin('Vol').value).toBe('1')
  fireEvent.click(within(group('Scenario inputs')).getByRole('button', { name: '−' }))
  fireEvent.click(within(group('Scenario inputs')).getByRole('button', { name: '−' }))
  await settle(300)
  expect(lastBody(sent)).toEqual({ volShift: -1 })
})

test('openWhatIf loads hypothetical rows', async () => {
  // Real timers: jsdom fires hashchange on its own clock, which fake timers do not drive.
  const sent = installFetch(({ path }) => {
    if (path === '/v1/traders/books/TCS') return { body: bookView() }
    if (path === SCENARIO_PATH) return { body: view() }
    return { status: 404, body: { error: 'no such route' } }
  })
  render(<BookTab stock="TCS" />)
  await screen.findByRole('button', { name: 'Scenario' })
  act(() => {
    openWhatIf('TCS', [{ instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: 120 }], 'Repair plan 2')
  })
  expect(window.location.hash).toBe('#/books/TCS/scenario')
  await screen.findByText('From: Repair plan 2')
  expect(screen.getByRole('button', { name: 'Scenario' }).getAttribute('aria-current')).toBe('page')
  await waitFor(() => expect(scenarioCalls(sent).length).toBeGreaterThan(0))
  expect(lastBody(sent)['hypothetical']).toEqual([
    { id: 'w1', instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: 120, iv: null },
  ])
  // An editable row like any other: −175 shares of a 175 lot is −1 lot.
  expect(spin('Lots, hypothetical 1').value).toBe('-1')
  expect(spin('Rate, hypothetical 1').value).toBe('120')
})

// ---------------------------------------------------------------- extras

test('the leg table: VolHedge headers, book rows read-only, a blank row last', async () => {
  mount()
  await settle()
  expect(headersOf('Scenario legs')).toEqual(LEG_HEADERS)
  expect(rowsOf('Scenario legs')).toHaveLength(3)
  expect(LEG_HEADERS.slice(0, 8).map((h) => cell('Scenario legs', 0, h)))
    .toEqual(['2026-10-27', 'C', '3,010.00', '3,000', '-175', '50.00', '25.34', '60.00'])
  expect(['Strike', 'Vol(%)'].map((h) => cell('Scenario legs', 1, h))).toEqual(['—', '—'])
  // Plain greeks per share, value columns the whole leg, as served (units ruling).
  expect(['Delta', 'Del Val', 'Gamma', 'Gam Val'].map((h) => cell('Scenario legs', 0, h))).toEqual(['0.55', '-96', '0.0021', '-0.3675'])
  expect(within(rowsOf('Scenario legs')[0]!).queryAllByRole('spinbutton')).toHaveLength(0)
  expect(within(rowsOf('Scenario legs')[2]!).getAllByRole('spinbutton').length).toBeGreaterThan(0)
})

test("the body carries the viewer's exclude, illiquid and IV overrides", async () => {
  const v = renderHook(() => useViewer('TCS'))
  act(() => {
    v.result.current.toggleExclude(BOOK_FUT.id)
    v.result.current.toggleIlliquid(BOOK_CALL.id)
    v.result.current.setIv(BOOK_CALL.id, 0.3)
  })
  v.unmount()
  const sent = mount()
  await settle()
  expect(lastBody(sent)).toEqual({ exclude: [BOOK_FUT.id], illiquid: [BOOK_CALL.id], ivOverrides: { [BOOK_CALL.id]: 0.3 } })
})

test('scenarioBody never sends a non-finite number or a half-typed row', () => {
  const body = scenarioBody({
    ...SCENARIO_START,
    spot: Number.NaN, callVolShift: Number.POSITIVE_INFINITY, stepPct: Number.NaN, count: 20, start: '19-10-2026', end: '2026-10-23',
    rows: [
      { id: 'h1', kind: 'P', expiry: '2026-10-27', strike: 3100, size: 0, lot: 175, price: null, volPts: null },
      { id: 'h2', kind: null, expiry: '2026-10-27', strike: 3100, size: 1, lot: 175, price: null, volPts: null },
      { id: 'h3', kind: 'C', expiry: '2026-10-27', strike: Number.NaN, size: 1, lot: 175, price: null, volPts: null },
      { id: 'h4', kind: 'F', expiry: '2026-10-27', strike: null, size: 2, lot: 175, price: Number.NaN, volPts: null },
      { id: 'h5', kind: 'EQ', expiry: '', strike: null, size: 50, lot: null, price: 3010, volPts: null },
    ],
  }, { exclude: [], illiquid: [], ivOverrides: { k: Number.NaN, j: -0.2 } }, null)
  expect(body).toEqual({
    count: 20, end: '2026-10-23',
    hypothetical: [{ id: 'h5', instrument: 'share', expiry: '', strike: null, optType: null, qty: 50, price: 3010, iv: null }],
  })
})

test('inputs and hypothetical rows hold across a sub-tab switch', async () => {
  vi.useFakeTimers()
  const sent = installFetch(({ path }) => {
    if (path === '/v1/traders/books/TCS') return { body: bookView() }
    if (path === SCENARIO_PATH) return { body: view() }
    return { status: 404, body: { error: 'no such route' } }
  })
  render(<BookTab stock="TCS" />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Scenario' }))
  await settle()
  fireEvent.change(spin('Interval'), { target: { value: '0.25' } })
  pick('C/P/F, new row', 'F')
  pick('Expiry, hypothetical 1', '2026-10-27')
  fireEvent.change(spin('Lots, hypothetical 1'), { target: { value: '2' } })
  fireEvent.click(metricTab('Vega'))
  fireEvent.click(dateTick('Expiry'))
  await settle(300)
  fireEvent.click(screen.getByRole('button', { name: 'Analysis' }))
  await settle()
  expect(document.querySelector('table[aria-label="Scenario grid"]')).toBe(null)
  const before = scenarioCalls(sent).length
  fireEvent.click(screen.getByRole('button', { name: 'Scenario' }))
  await settle()
  expect(scenarioCalls(sent).length).toBe(before + 1)
  expect(lastBody(sent)).toEqual({
    stepPct: 0.25,
    hypothetical: [{ id: 'h1', instrument: 'future', expiry: '2026-10-27', strike: null, optType: null, qty: 350, price: null, iv: null }],
  })
  expect(spin('Interval').value).toBe('0.25')
  expect(spin('Lots, hypothetical 1').value).toBe('2')
  expect(metricTab('Vega').getAttribute('aria-selected')).toBe('true')
  expect(headersOf('Scenario grid')).not.toContain('Expiry')
})

test('the hash names the sub-tab; without one the book opens on its first', async () => {
  vi.useFakeTimers()
  installFetch(({ path }) => {
    if (path === '/v1/traders/books/TCS') return { body: bookView() }
    if (path === SCENARIO_PATH) return { body: view() }
    return { status: 404, body: { error: 'no such route' } }
  })
  window.location.hash = '#/books/TCS/scenario'
  render(<BookTab stock="TCS" />)
  await settle()
  expect(screen.getByRole('button', { name: 'Scenario' }).getAttribute('aria-current')).toBe('page')
  expect(table('Scenario grid')).toBeTruthy()
  cleanup()

  // Legs & payoff became part of Analysis: its old hash lands there too.
  for (const hash of ['#/books/TCS', '#/books/TCS/legs', '#/books/TCS/nonsense', '#/books/INFY/scenario']) {
    window.location.hash = hash
    render(<BookTab stock="TCS" />)
    await settle()
    expect(screen.getByRole('button', { name: 'Analysis' }).getAttribute('aria-current')).toBe('page')
    cleanup()
  }
})

test('warnings, the closed line and a refused request', async () => {
  let fail = false
  vi.useFakeTimers()
  installFetch(({ path }) => {
    if (path !== SCENARIO_PATH) return { status: 404, body: { error: 'no such route' } }
    if (fail) return { status: 400, body: { error: 'count must be a whole number from 0 to 100' } }
    return { body: view({ closed: true, warnings: ['no IV for Nov 26 3100 P — marks flat'] }) }
  })
  render(<ScenarioTab stock="TCS" />)
  await settle()
  expect(screen.getByText('no IV for Nov 26 3100 P — marks flat')).toBeTruthy()
  expect(screen.getByText("Market closed — last session's prices")).toBeTruthy()
  fail = true
  fireEvent.change(spin('Strike +/-'), { target: { value: '100' } })
  await settle(300)
  expect(screen.getByText('Scenario not updated: count must be a whole number from 0 to 100')).toBeTruthy()
  // The last good grid stays on screen.
  expect(table('Scenario grid')).toBeTruthy()
})

test('the Scenario tab offers nothing to trade', async () => {
  // R1's rule (test/traders/no-trading.test.tsx), over every control this tab adds.
  const FORBIDDEN = /place|apply|square ?off|kill|flatten|submit order|cancel order|modify order|exit position|buy now|sell now|send order|execute/i
  mount({ hypothetical: [] })
  await settle()
  pick('C/P/F, new row', 'P')
  const controls = [...document.querySelectorAll('button, a, input, [role="button"], [role="tab"], [role="switch"], [role="option"], [role="combobox"]')]
    .map((e) => `${e.textContent ?? ''} ${e.getAttribute('aria-label') ?? ''} ${document.getElementById(e.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''}`.trim())
  expect(controls.length).toBeGreaterThan(30)
  expect(controls.filter((n) => FORBIDDEN.test(n))).toEqual([])
})

// ------------------------------------------------------------ fix round 1

test('a refused first answer keeps the strip and the rows, and Reset inputs recovers (fix 1)', async () => {
  const s = renderHook(() => useScenarioInputs('TCS'))
  act(() => s.result.current.patch({
    start: '2026-10-23', end: '2026-10-21', stepPct: 0.25,
    rows: [{ id: 'h1', kind: 'P', expiry: '2026-10-27', strike: 3100, size: -1, lot: 175, price: null, volPts: null }], seq: 2,
  }))
  s.unmount()
  vi.useFakeTimers()
  const sent = installFetch(({ path, body }) => {
    if (path !== SCENARIO_PATH) return { status: 404, body: { error: 'no such route' } }
    const start = body?.['start'] as string | undefined
    const end = body?.['end'] as string | undefined
    if (start !== undefined && end !== undefined && end < start) return { status: 400, body: { error: `end ${end} is before start ${start}` } }
    return { body: view() }
  })
  render(<ScenarioTab stock="TCS" />)
  await settle()
  expect(screen.getByText('Could not load the scenario of TCS: end 2026-10-21 is before start 2026-10-23')).toBeTruthy()
  // The strip and the leg table still render: what the viewer pinned, blanks for what the server never resolved.
  expect(spin('Interval').value).toBe('0.25')
  expect(spin('CMP').value).toBe('')
  expect(labelled('Start')).toBeTruthy()
  expect(spin('Strike, hypothetical 1').value).toBe('3100')
  fireEvent.click(screen.getByRole('button', { name: 'Reset inputs' }))
  await settle(300)
  // The strip's pins are gone; the hypothetical rows stay.
  expect(lastBody(sent)).toEqual({
    hypothetical: [{ id: 'h1', instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -175, price: null, iv: null }],
  })
  expect(table('Scenario grid')).toBeTruthy()
  expect(screen.queryByText(/Could not load the scenario/)).toBe(null)
  expect(spin('Interval').value).toBe('0.5')
})

test('a verdict and its figures belong to the row version they answered (fix 2)', async () => {
  vi.useFakeTimers()
  installFetch(({ path, body }) => {
    if (path !== SCENARIO_PATH) return { status: 404, body: { error: 'no such route' } }
    const hyp = (body?.['hypothetical'] ?? []) as HypotheticalLeg[]
    const ok = hyp.filter((h) => h.strike !== 3100)
    return { body: view({
      hypothetical: hyp.map((h) => (h.strike === 3100
        ? { id: h.id, accepted: false, reason: `TCS ${h.expiry} ${h.strike} PE is not listed`, entry: null, iv: null }
        : { id: h.id, accepted: true, reason: null, entry: 99, iv: 0.26 })),
      legs: [BOOK_CALL, BOOK_FUT, ...ok.map((h): ScenarioLegRow => ({ ...BOOK_CALL, id: h.id, hypothetical: true, type: 'P', strike: h.strike, qty: h.qty, underlying: 3011, ltp: 99 }))],
    }) }
  })
  render(<ScenarioTab stock="TCS" />)
  await settle()
  const plan = (strike: number) => [{ instrument: 'option' as const, expiry: '2026-10-27', strike, optType: 'PE' as const, qty: -175, price: null }]
  act(() => openWhatIf('TCS', plan(3100), 'Plan A'))
  await settle(300)
  expect(screen.getByText('TCS 2026-10-27 3100 PE is not listed')).toBeTruthy()
  // Edited: the old refusal goes at once, before any answer.
  fireEvent.change(spin('Strike, hypothetical 1'), { target: { value: '3150' } })
  expect(screen.queryByText('TCS 2026-10-27 3100 PE is not listed')).toBe(null)
  expect(cell('Scenario legs', 2, 'Underlying')).toBe('…')
  await settle(300)
  expect([cell('Scenario legs', 2, 'Underlying'), cell('Scenario legs', 2, 'LTP')]).toEqual(['3,011.00', '99.00'])
  // A second what-if reuses w1: nothing of the first one's answer shows for it.
  act(() => openWhatIf('TCS', plan(3300), 'Plan B'))
  expect(screen.getByText('From: Plan B')).toBeTruthy()
  expect([cell('Scenario legs', 2, 'Underlying'), cell('Scenario legs', 2, 'LTP')]).toEqual(['…', '—'])
  act(() => openWhatIf('TCS', plan(3100), 'Plan C'))
  await settle(300)
  expect(screen.getByText('TCS 2026-10-27 3100 PE is not listed')).toBeTruthy()
  act(() => openWhatIf('TCS', plan(3150).map((l) => ({ ...l, qty: -350 })), 'Plan D'))
  expect(screen.queryByText(/is not listed/)).toBe(null)
})

test("changing a row's kind re-checks its quantity against the new unit (fix 3)", async () => {
  const sent = mount()
  await settle()
  pick('C/P/F, new row', 'EQ')
  fireEvent.change(spin('Shares, hypothetical 1'), { target: { value: '350' } })
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toEqual([{ id: 'h1', instrument: 'share', expiry: '', strike: null, optType: null, qty: 350, price: null, iv: null }])
  // 350 shares are 2 lots of 175: kept, now counted in lots.
  pick('C/P/F, hypothetical 1', 'C')
  expect(spin('Lots, hypothetical 1').value).toBe('2')
  fireEvent.change(spin('Strike, hypothetical 1'), { target: { value: '3200' } })
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toEqual([{ id: 'h1', instrument: 'option', expiry: '2026-10-27', strike: 3200, optType: 'CE', qty: 350, price: null, iv: null }])
  // Back to shares and 100 of them: no whole number of lots, so the size is cleared and nothing is sent for the row.
  pick('C/P/F, hypothetical 1', 'EQ')
  expect(spin('Shares, hypothetical 1').value).toBe('350')
  fireEvent.change(spin('Shares, hypothetical 1'), { target: { value: '100' } })
  pick('C/P/F, hypothetical 1', 'P')
  fireEvent.change(spin('Strike, hypothetical 1'), { target: { value: '3100' } })
  expect(spin('Lots, hypothetical 1').value).toBe('')
  expect(cell('Scenario legs', 2, 'Underlying')).toBe('Type the lots')
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toBeUndefined()
})

test('a quantity that is not whole lots is never sent once the lot size is known (fix 3)', () => {
  const row = (size: number): HypoRow => ({ id: 'w1', kind: 'P', expiry: '2026-10-27', strike: 3100, size, lot: null, price: null, volPts: null })
  const none = { exclude: [], illiquid: [], ivOverrides: {} }
  expect(scenarioBody({ ...SCENARIO_START, rows: [row(-100)] }, none, 175)).toEqual({})
  expect(scenarioBody({ ...SCENARIO_START, rows: [row(-350)] }, none, 175)['hypothetical']).toEqual([
    { id: 'w1', instrument: 'option', expiry: '2026-10-27', strike: 3100, optType: 'PE', qty: -350, price: null, iv: null },
  ])
  // A share is counted in shares whatever the lot size; with no lot size known, shares go as given.
  expect(scenarioBody({ ...SCENARIO_START, rows: [{ ...row(-100), kind: 'EQ', expiry: '', strike: null }] }, none, 175)['hypothetical']).toHaveLength(1)
  expect(scenarioBody({ ...SCENARIO_START, rows: [row(-100)] }, none, null)['hypothetical']).toHaveLength(1)
})

test('after a remount the first request counts lots in the lot size last seen: a non-whole-lot what-if leg is never sent then dropped', async () => {
  mount()
  await settle()
  cleanup()
  // what R3's "Show on payoff" leaves while the tab is away: a leg in shares, not a whole number of lots of 175
  const s = renderHook(() => useScenarioInputs('TCS'))
  act(() => s.result.current.patch({ rows: [{ id: 'w1', kind: 'P', expiry: '2026-10-27', strike: 3100, size: -100, lot: null, price: null, volPts: null }] }))
  s.unmount()
  const sent = mount()
  await settle()
  expect(scenarioCalls(sent).map((c) => c.body?.['hypothetical'])).toEqual([undefined])
  expect(cell('Scenario legs', 2, 'Underlying')).toBe('-100 shares is not a whole number of lots of 175')
})

test('a future row gets no default expiry (fix 4)', async () => {
  const sent = mount()
  await settle()
  pick('C/P/F, new row', 'F')
  fireEvent.change(spin('Lots, hypothetical 1'), { target: { value: '1' } })
  expect(cell('Scenario legs', 2, 'Underlying')).toBe('Pick an expiry')
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toBeUndefined()
  pick('Expiry, hypothetical 1', '2026-11-23')
  await settle(300)
  expect(lastBody(sent)['hypothetical']).toEqual([{ id: 'h1', instrument: 'future', expiry: '2026-11-23', strike: null, optType: null, qty: 175, price: null, iv: null }])
  // An option's month does not carry over to a future either.
  pick('C/P/F, hypothetical 1', 'C')
  pick('C/P/F, hypothetical 1', 'F')
  expect(cell('Scenario legs', 2, 'Underlying')).toBe('Pick an expiry')
})

test('Back to a bare book hash returns to the first sub-tab (fix 5)', async () => {
  installFetch(({ path }) => {
    if (path === '/v1/traders/books/TCS') return { body: bookView() }
    if (path === SCENARIO_PATH) return { body: view() }
    return { status: 404, body: { error: 'no such route' } }
  })
  window.location.hash = '#/books/TCS/scenario'
  render(<BookTab stock="TCS" />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Scenario' }).getAttribute('aria-current')).toBe('page'))
  window.location.hash = '#/books/TCS'
  await waitFor(() => expect(screen.getByRole('button', { name: 'Analysis' }).getAttribute('aria-current')).toBe('page'))
})

test('the units toggle sits above the leg table and the totals, and rescales the totals only (fix 6, units ruling)', async () => {
  mount({ lotGcd: 3 })
  await settle()
  const perLot = screen.getAllByRole('radio', { name: 'Per lot' })
  expect(perLot).toHaveLength(1)
  expect(perLot[0]!.compareDocumentPosition(table('Scenario legs')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect([cell('Scenario totals', 0, 'Delta'), cell('Scenario legs', 0, 'Delta'), cell('Scenario legs', 0, 'Del Val')]).toEqual(['-420', '0.55', '-96'])
  fireEvent.click(perLot[0]!)
  // Totals per lot = ÷ the common lot count; a leg's plain delta stays per share, its value the whole leg.
  expect([cell('Scenario totals', 0, 'Delta'), cell('Scenario legs', 0, 'Delta'), cell('Scenario legs', 0, 'Del Val')]).toEqual(['-140', '0.55', '-96'])
})

test('book legs excluded on the Analysis tab are muted here, with one note (fix 7)', async () => {
  const NOTE = 'Ticks on the Analysis tab apply here'
  mount()
  await settle()
  expect(screen.queryByText(NOTE)).toBe(null)
  cleanup()
  const v = renderHook(() => useViewer('TCS'))
  act(() => v.result.current.toggleExclude(BOOK_FUT.id))
  v.unmount()
  mount()
  await settle()
  const colours = (i: number): Set<string | null> =>
    new Set([...rowsOf('Scenario legs')[i]!.querySelectorAll('[data-color]')].map((e) => e.getAttribute('data-color')))
  expect(colours(1)).toEqual(new Set(['secondary']))
  expect(colours(0).has('secondary')).toBe(false)
  expect(screen.getAllByText(NOTE)).toHaveLength(1)
})
