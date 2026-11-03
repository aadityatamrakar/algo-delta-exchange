/** The Analysis sub-tab: VolHedge v50's layout over GET /analysis and /margin. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { AnalysisTab } from '../src/traders/analysis-tab.tsx'
import { BookTab } from '../src/traders/book.tsx'
import { ANALYSIS_START, useAnalysisInputs, useViewer } from '../src/traders/viewer.ts'
import { LEG_PNL_TITLE, PNL_ABOUT, SHARES_LINE, TODAY_ABOUT, DAY_EXCLUDES } from '../src/traders/series-lines.ts'
import { resetLive } from '../src/traders/live.tsx'
import { maturityLabel } from '../src/traders/wire.ts'
import { installFetch, type SentRequest } from './http.tsx'
import { MANUAL_SHARES, bookView, openNotes } from './traders/fixtures.ts'
import type { AnalysisLeg, AnalysisView, GreekTotals, MarginView, MtmBlock } from '../../traders/src/analytics/wire.ts'
import type { BookView, SeriesPnl, SeriesTotal } from '../../traders/src/types.ts'

const ASOF = new Date('2026-10-19T10:27:00+05:30').getTime()

const HEADERS = ['Illiq.', 'Maturity', 'MDate', 'Strike', 'Type', 'Units', 'Lots', 'LTP', 'Net Price', 'Buy Price', 'Sell Price',
  'Leg P&L', 'Synfut', 'TimeValue', 'Vol (%)', 'Mkt Vol (%)', 'Delta', 'D.V', 'Vega', 'V.V', 'Gamma', 'G.V', 'Theta', 'T.V']

function leg(over: Partial<AnalysisLeg> = {}): AnalysisLeg {
  return {
    key: 'C0001|option|TCS|2026-10-27|3000|CE', source: 'odin', included: true, illiquid: false, illiquidAuto: false,
    maturity: 'Oct 26', maturityDate: '2026-10-27', strike: 3000, type: 'C',
    units: -175, lots: -1, ltp: 60, netPrice: 50, buyPrice: 59.5, salePrice: 60.5, grossMtm: -1750, syntheticFuture: 3010, timeValue: 8750,
    ivUsed: 0.25, marketIv: 0.25, delta: 0.55, deltaValue: -96.25, vega: 3.1, vegaValue: -542.5, remarks: '',
    gamma: 0.0021, gammaValue: -0.3675, theta: -1.8, thetaValue: 315, vanna: 0.01, vannaValue: -1.75, volga: 0.02, volgaValue: -3.5,
    ivSource: 'quote', ivFrom: null,
    ...over,
  }
}

const L1 = leg({ ivUsed: 0.27 })   // a +2 call vol shift on top of the 25 % market IV
const L2 = leg({
  key: 'C0001|option|TCS|2026-11-23|3100|PE', maturity: 'Nov 26', maturityDate: '2026-11-23', strike: 3100, type: 'P',
  units: 350, lots: 2, ltp: null, buyPrice: null, salePrice: null, grossMtm: null, ivUsed: 0.27, marketIv: null, ivSource: 'other-side',
  illiquid: true, illiquidAuto: true, remarks: 'illiquid (no fresh quote) · IV from other side 3100 CE',
})
const L3 = leg({
  key: 'C0001|future|TCS|2026-10-27||', strike: null, type: 'F', units: 175, lots: 1, ltp: 3010, netPrice: 3000, buyPrice: 3009.5,
  salePrice: 3010.5, grossMtm: 1750, syntheticFuture: null, timeValue: null, ivUsed: null, marketIv: null, ivSource: 'none',
  delta: 1, deltaValue: 175, vega: 0, vegaValue: 0, gamma: 0, gammaValue: 0, theta: 0, thetaValue: 0, vanna: 0, vannaValue: 0, volga: 0, volgaValue: 0,
})

const T: GreekTotals = { delta: -525, gamma: -0.4293, vega: -3105, theta: 6040, volga: 192.64, vanna: 9.91 }
const N: GreekTotals = { delta: -523, gamma: -0.4906, vega: -3375, theta: 7766, volga: 184.39, vanna: 11.54 }
const G0: GreekTotals = { delta: 0, gamma: 0, vega: 0, theta: 0, volga: 0, vanna: 0 }

const MTM_NOTES = [
  "Previous = the carried legs' move today, yesterday's close to LTP (NSE end-of-day CLOSE, not settlement — Phase 0 Q3), not their P&L since entry; Today = today's trades, fill to LTP",
  "Day MTM = Previous + Today - the charges on today's fills; the charges on the open cycle before today are not in it (the series P&L has them)",
  'Projected = Day MTM - square-off cost',
]
// Today (current.total) bears the 34.74 of today's fills; the 81.41 of the open cycle is in no day figure
const MTM: MtmBlock = {
  gross: { previous: 1575, today: 875, total: 2450 },
  expense: { previous: null, today: 34.73945525, total: 34.73945525 },
  current: { previous: 1575, today: 840.26054475, total: 2415.26054475 },
  squareOff: 170.1481155, projected: 2245.11242925, payInOut: 7875, cfBalance: 16625,
  openCycleCharges: 81.4140225, dayReason: null,
  partial: [], ratesConfirmed: true, notes: MTM_NOTES,
}

function view(over: Partial<AnalysisView> = {}): AnalysisView {
  return {
    stock: 'TCS', asOf: ASOF, closed: false, spot: 3000, future: 3010, futureOverridden: false,
    nearExpiry: '2026-10-27', daysToExpiry: 8, nearFuture: '2026-10-27', lotSize: 175, lotGcd: 1,
    months: [{ expiry: '2026-10-27', label: '27OCT' }, { expiry: '2026-11-23', label: '23NOV' }],
    params: {
      expiry: null, exclude: [], illiquid: [], ivOverrides: {}, callVol: 0, putVol: 0, future: null,
      gap: [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }], gapUseLtp: true, gapUseVol: true, volBasis: 'future',
    },
    legs: [L1, L2, L3],
    totals: { T, N, note: 'T = at IV used · N = at market IV — our reading of VolHedge (Phase 0 Q3)' },
    monthWise: [{ label: '27OCT', expiry: '2026-10-27', totals: T }, { label: '23NOV', expiry: '2026-11-23', totals: G0 }, { label: 'EQ', expiry: '', totals: G0 }],
    optionGreeks: T,
    comparison: { T, N, diff: { delta: -2, gamma: 0.0613, vega: 270, theta: -1726, volga: 8.25, vanna: -1.63 }, note: "diff = T - N — our reading of VolHedge's Greeks Comparison (Phase 0 Q3)" },
    toNeutralize: { units: 1234, price: 2955.4, pct: -1.14, lots: 7, side: 'Buy', contract: 'TCS OCT FUT', text: 'Buy 7 lots TCS OCT FUT' },
    bookTimeValue: 156031.25,
    breakevens: { low: 2880.4, high: 3099.7, expiry: '2026-10-27', text: 'BEP = 2880.4 - 3099.7' },
    gapPanel: {
      on: '2026-10-21', basis: 'future', useLtp: true, useVol: true,
      rows: [{ movePct: 10, volPts: -10, price: 3300, pnl: -118009, change: -119759 }, { movePct: -10, volPts: -10, price: 2700, pnl: -85168, change: -86918 }],
      note: "At the next open, 09:15 IST 21 Oct — our reading of VolHedge's Gap Up/Down (Phase 0 Q3)",
    },
    mtm: MTM, unmatched: [], warnings: [],
    ...over,
  }
}

const MARGIN: MarginView = {
  available: true, initial: 100000, exposure: 25000, total: 125000,
  peak: { total: 131000, label: 'NSE SPAN 11:01' },
  parts: { scanningRisk: 98000, worstScenario: 7, interMonthSpread: 2000, shortOptionMinimum: 0, netOptionValue: 0 },
  span: { file: 'nsccl.20261019.i2.spn', label: 'NSE SPAN 13:31', businessDate: '2026-10-19', savedAt: ASOF },
  exposureFile: { file: 'ael_16102026.csv', label: 'NSE exposure 16 Oct', businessDate: '2026-10-16', savedAt: null },
  stale: false, missing: [],
  notes: [
    "Not yet checked against a broker's margin figure (Phase 0 Q6)", 'Shares are cash segment: not in SPAN',
    "Peak = highest of 19 Oct's NSE SPAN files (our reading of VolHedge's peak-margin line)",
  ],
}

const NO_SPAN = 'No NSE SPAN file yet — margin appears once the span job has saved one'

/** The viewer store is module state shared by every test: put TCS back as a fresh page would find it. */
function resetViewer(stock: string): void {
  const v = renderHook(() => useViewer(stock))
  act(() => {
    const s = v.result.current.state
    for (const k of s.exclude) v.result.current.toggleExclude(k)
    for (const k of s.illiquid) v.result.current.toggleIlliquid(k)
    for (const k of Object.keys(s.ivOverrides)) v.result.current.setIv(k, null)
    v.result.current.setUnits('position')
  })
  v.unmount()
  const a = renderHook(() => useAnalysisInputs(stock))
  act(() => a.result.current.patch(ANALYSIS_START))
  a.unmount()
}

// Unmount first: a tab still on screen would answer the reset with a request.
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); resetLive(); resetViewer('TCS') })

// `findBy*` polls on the timers `useFakeTimers` replaces, so these advance the
// fake clock and read with `getBy*` (as strategies.test.tsx does).
function mount(over: { view?: Partial<AnalysisView>; margin?: Partial<MarginView> } = {}): SentRequest[] {
  vi.useFakeTimers()
  const sent = installFetch(({ path }) => {
    if (path === '/v1/traders/books/TCS/analysis') return { body: view(over.view) }
    if (path === '/v1/traders/books/TCS/margin') return { body: { ...MARGIN, ...over.margin } }
    return { status: 404, body: { error: 'no such route' } }
  })
  render(<AnalysisTab stock="TCS" />)
  return sent
}

async function settle(ms = 0): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const analysisCalls = (sent: readonly SentRequest[]): SentRequest[] => sent.filter((r) => r.path.endsWith('/analysis'))
const marginCalls = (sent: readonly SentRequest[]): SentRequest[] => sent.filter((r) => r.path.endsWith('/margin'))
const lastQuery = (calls: readonly SentRequest[]): URLSearchParams => new URL(calls.at(-1)!.url).searchParams

function rowsOf(name: string): HTMLElement[] {
  return within(screen.getByRole('table', { name })).getAllByRole('row').slice(1)
}

/** The text of `header`'s cell in body row `i` of the table named `name`. */
function cell(name: string, i: number, header: string): string {
  const table = screen.getByRole('table', { name })
  const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
  const row = rowsOf(name)[i]!
  return within(row).getAllByRole('cell')[headers.indexOf(header)]!.textContent ?? ''
}

/** The value printed beside a label in a MetadataList (`dt` → `dd`). */
function valueBeside(scope: HTMLElement, label: string): string {
  return within(scope).getByText(label).closest('dt')?.nextElementSibling?.textContent ?? ''
}

/** The vols, future, Online Update and Calculate sit in the Adjust panel: open it (once) before reaching for one. */
function openAdjust(): void {
  if (screen.queryByRole('spinbutton', { name: 'Call Vol %' }) === null) fireEvent.click(screen.getByRole('button', { name: 'Adjust' }))
}
function ctl(role: 'spinbutton' | 'button' | 'switch', name: string): HTMLElement {
  openAdjust()
  return screen.getByRole(role, { name })
}

test('the header maturity reads as VolHedge prints it, the same as the server', () => {
  expect([maturityLabel('2026-10-27'), maturityLabel('2026-11-23'), maturityLabel('2027-01-28'), maturityLabel('')])
    .toEqual(['Oct 26', 'Nov 26', 'Jan 27', 'EQ'])
})

test("renders the leg table headers in VolHedge v50's order", async () => {
  mount()
  await settle()
  const table = screen.getByRole('table', { name: 'Legs' })
  const headers = within(table).getAllByRole('columnheader')
  expect(headers.slice(1).map((h) => h.textContent)).toEqual(HEADERS)
  expect(within(headers[0]!).getByRole('checkbox', { name: 'Include every leg' })).toBeTruthy()
  expect(rowsOf('Legs').length).toBe(3)
  // VolHedge's columns from the served row; a null prints a dash, never 0.
  expect([cell('Legs', 0, 'Maturity'), cell('Legs', 0, 'MDate'), cell('Legs', 0, 'Strike'), cell('Legs', 0, 'Type'), cell('Legs', 0, 'Units'),
    cell('Legs', 0, 'LTP'), cell('Legs', 0, 'Leg P&L'), cell('Legs', 0, 'TimeValue'), cell('Legs', 0, 'Mkt Vol (%)'), cell('Legs', 0, 'D.V')])
    .toEqual(['Oct 26', '2026-10-27', '3,000', 'C', '-175', '60.00', '-1,750', '8,750.00', '25.00', '-96'])
  expect([cell('Legs', 1, 'LTP'), cell('Legs', 1, 'Buy Price'), cell('Legs', 1, 'Leg P&L'), cell('Legs', 1, 'Mkt Vol (%)')]).toEqual(['—', '—', '—', '—'])
  // one name per leg: its own P&L since it was opened, before charges, never a book total
  expect(within(table).getByText('Leg P&L').getAttribute('title')).toBe(LEG_PNL_TITLE)
  expect(screen.getByRole('img', { name: 'illiquid (no fresh quote) · IV from other side 3100 CE' })).toBeTruthy()
  expect([cell('Legs', 2, 'Strike'), cell('Legs', 2, 'Synfut'), cell('Legs', 2, 'TimeValue')]).toEqual(['—', '—', '—'])
  // Plain greeks per share, value columns the whole leg, as served (units ruling).
  expect([cell('Legs', 0, 'Delta'), cell('Legs', 0, 'Gamma'), cell('Legs', 0, 'G.V')]).toEqual(['0.55', '0.0021', '-0.3675'])
  // The Vol (%) input is empty until the viewer types one; its placeholder is the market IV — the base
  // the shift is added to — so typing it back does not add the Call/Put shift twice.
  const vol = within(rowsOf('Legs')[0]!).getByRole('spinbutton') as HTMLInputElement
  expect([vol.value, vol.placeholder]).toEqual(['', '25.00'])
  expect((within(rowsOf('Legs')[1]!).getByRole('spinbutton') as HTMLInputElement).placeholder).toBe('—')
})

test('the units toggle sets the book rows only: the leg table stays per share and whole leg (units ruling)', async () => {
  mount({ view: { lotGcd: 3 } })
  await settle()
  const legCells = (): string[] => ['Delta', 'D.V', 'Vega', 'V.V', 'Gamma', 'G.V', 'Theta', 'T.V'].map((h) => cell('Legs', 0, h))
  const served = legCells()
  expect(served).toEqual(['0.55', '-96', '3.10', '-543', '0.0021', '-0.3675', '-1.80', '315'])
  const total = (): string => cell('Total', 0, 'Delta')
  expect(total()).toBe('-525')
  fireEvent.click(screen.getByRole('radio', { name: 'Per lot' }))
  expect([legCells(), total()]).toEqual([served, '-175'])
  fireEvent.click(screen.getByRole('radio', { name: 'Per share' }))
  expect([legCells(), total()]).toEqual([served, '-1'])
  fireEvent.click(screen.getByRole('radio', { name: 'Whole position' }))
})

test('unticking a leg sends exclude', async () => {
  const sent = mount()
  await settle()
  const before = analysisCalls(sent).length
  fireEvent.click(within(rowsOf('Legs')[0]!).getAllByRole('checkbox')[0]!)
  await settle(299)
  expect(analysisCalls(sent).length).toBe(before)
  await settle(1)
  expect(analysisCalls(sent).length).toBe(before + 1)
  expect(lastQuery(analysisCalls(sent)).getAll('exclude')).toEqual([L1.key])
  // Margin is fetched with the same exclusions.
  expect(lastQuery(marginCalls(sent)).getAll('exclude')).toEqual([L1.key])
  // The row stays listed, unticked.
  expect((within(rowsOf('Legs')[0]!).getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false)
})

test('the select-all tick unticks every listed leg, and ticks them back', async () => {
  const sent = mount()
  await settle()
  const all = screen.getByRole('checkbox', { name: 'Include every leg' })
  fireEvent.click(all)
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).getAll('exclude')).toEqual([L1.key, L2.key, L3.key])
  fireEvent.click(all)
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).getAll('exclude')).toEqual([])
})

test('the Illiq. tick sends illiquid; a leg marked illiquid by the server shows ticked and cannot be unticked', async () => {
  const sent = mount()
  await settle()
  fireEvent.click(within(rowsOf('Legs')[0]!).getAllByRole('checkbox')[1]!)
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).getAll('illiquid')).toEqual([L1.key])
  const auto = within(rowsOf('Legs')[1]!).getAllByRole('checkbox')[1] as HTMLInputElement
  expect(auto.checked).toBe(true)
  expect(auto.disabled || auto.getAttribute('aria-disabled') === 'true').toBe(true)
})

test('typing a vol sends it as a decimal', async () => {
  const sent = mount()
  await settle()
  const before = analysisCalls(sent).length
  const vol = within(rowsOf('Legs')[0]!).getByRole('spinbutton')
  fireEvent.change(vol, { target: { value: '2' } })
  fireEvent.change(vol, { target: { value: '24' } })
  fireEvent.change(vol, { target: { value: '24.5' } })
  await settle(300)
  // One debounced request for the whole burst, not one per keystroke.
  expect(analysisCalls(sent).length).toBe(before + 1)
  expect(lastQuery(analysisCalls(sent)).getAll('iv')).toEqual([`${L1.key}@0.245`])
})

test('the 23NOV month tab sends expiry', async () => {
  const sent = mount()
  await settle()
  fireEvent.click(screen.getByRole('tab', { name: '23NOV' }))
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).get('expiry')).toBe('2026-11-23')
  fireEvent.click(screen.getByRole('tab', { name: 'All' }))
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).has('expiry')).toBe(false)
})

test("To Neutralize prints Δ0 and its signed distance from spot, then the server's hedge sentence", async () => {
  mount()
  await settle()
  expect(screen.getByText('2955.40')).toBeTruthy()
  expect(screen.getByText('(-1.14 %)')).toBeTruthy()
  expect(screen.queryByText('1234.00')).toBe(null)
  expect(screen.getByText('Buy 7 lots TCS OCT FUT')).toBeTruthy()
  const box = screen.getByRole('group', { name: 'To Neutralize' })
  expect(within(box).queryByText('CF Balance')).toBe(null)   // cash, not P&L
  expect(screen.queryByText('+16,625.00')).toBe(null)
  expect(valueBeside(box, 'TimeValue')).toBe('1,56,031.25')
})

test('the header strip: expiry, days, the future, overrides, Stop and Start Future Update', async () => {
  const sent = mount()
  await settle()
  const strip = screen.getByRole('group', { name: 'Expiry/Days/Rate1' })
  expect(within(strip).getByText('Oct 26')).toBeTruthy()
  expect(within(strip).getByText('8')).toBeTruthy()
  expect(within(strip).getByText('3,010.00')).toBeTruthy()
  fireEvent.change(ctl('spinbutton', 'Call Vol %'), { target: { value: '2' } })
  fireEvent.change(ctl('spinbutton', 'Put Vol %'), { target: { value: '-1' } })
  await settle(300)
  expect([lastQuery(analysisCalls(sent)).get('callVol'), lastQuery(analysisCalls(sent)).get('putVol')]).toEqual(['2', '-1'])
  fireEvent.click(ctl('button', 'Stop'))
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).get('future')).toBe('3010')
  expect((ctl('spinbutton', 'Future') as HTMLInputElement).value).toBe('3010')
  fireEvent.click(ctl('button', 'Start Future Update'))
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).has('future')).toBe(false)
  fireEvent.change(ctl('spinbutton', 'Future'), { target: { value: '3040' } })
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).get('future')).toBe('3040')
})

test('the Gap Up Down rows are editable', async () => {
  const sent = mount()
  await settle()
  const panel = screen.getByRole('group', { name: 'Gap Up Down' })
  expect(within(panel).getByText('-1,18,009')).toBeTruthy()
  expect(within(panel).getByText('-85,168')).toBeTruthy()
  expect(within(panel).getByText('vs value now -1,19,759')).toBeTruthy()
  expect(within(panel).getByText("At the next open, 09:15 IST 21 Oct — our reading of VolHedge's Gap Up/Down (Phase 0 Q3)")).toBeTruthy()
  fireEvent.change(within(panel).getByRole('spinbutton', { name: 'Scenario-1 price %' }), { target: { value: '5' } })
  fireEvent.change(within(panel).getByRole('spinbutton', { name: 'Scenario-1 vol pts' }), { target: { value: '0' } })
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).getAll('gap')).toEqual(['5,0', '-10,-10'])
  fireEvent.click(within(panel).getByRole('checkbox', { name: 'Ltp' }))
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).get('gapLtp')).toBe('0')
  fireEvent.click(within(panel).getByRole('checkbox', { name: 'Vol' }))
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).get('gapVol')).toBe('0')
  const eq = within(panel).getByRole('checkbox', { name: 'Cal Vol Using EQ' }) as HTMLInputElement
  const syn = within(panel).getByRole('checkbox', { name: 'Cal Vol Using syn future' }) as HTMLInputElement
  fireEvent.click(eq)
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).get('basis')).toBe('cash')
  fireEvent.click(syn)
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).get('basis')).toBe('synthetic')
  expect([eq.checked, syn.checked]).toEqual([false, true])
  fireEvent.click(syn)
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).has('basis')).toBe(false)
  // Calculate (Alt+C) refetches at once, from the button or the keys.
  const n = analysisCalls(sent).length
  fireEvent.click(within(panel).getByRole('button', { name: 'Calculate (Alt+C)' }))
  await settle()
  expect(analysisCalls(sent).length).toBe(n + 1)
  fireEvent.keyDown(window, { key: 'c', code: 'KeyC', altKey: true })
  await settle()
  expect(analysisCalls(sent).length).toBe(n + 2)
})

test('margin box states', async () => {
  mount({ margin: { available: false, initial: null, exposure: null, total: null, peak: null, parts: null, span: null, exposureFile: null, notes: [NO_SPAN] } })
  await settle()
  let box = screen.getByRole('group', { name: 'Margin' })
  openNotes(box)
  expect(within(box).getByText(NO_SPAN)).toBeTruthy()
  expect(valueBeside(box, 'Initial')).toBe('—')
  cleanup()

  mount({ margin: { stale: true } })
  await settle()
  box = screen.getByRole('group', { name: 'Margin' })
  expect(within(box).getByText('NSE SPAN 13:31').closest('[data-color]')?.getAttribute('data-color')).toBe('yellow')
  cleanup()

  mount()
  await settle()
  box = screen.getByRole('group', { name: 'Margin' })
  openNotes(box)
  expect(valueBeside(box, 'Total (lakh)')).toBe('1.25')
  // The files' names sit behind the section's ⓘ; a fresh SPAN file is not marked.
  fireEvent.click(within(box).getByRole('button', { name: 'About the margin files' }))
  expect(within(box).getByText('NSE SPAN 13:31').closest('[data-color="yellow"]')).toBe(null)
  expect(within(box).getByText('NSE exposure 16 Oct')).toBeTruthy()
  expect([valueBeside(box, 'Initial'), valueBeside(box, 'Exposure')]).toEqual(['1,00,000', '25,000'])
  // The peak's figure in view, its own line behind its ⓘ.
  expect(within(box).getByText('1,31,000')).toBeTruthy()
  const peakInfo = within(box).getByRole('button', { name: 'About Peak' })
  expect(peakInfo.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(peakInfo)
  expect(peakInfo.getAttribute('aria-expanded')).toBe('true')
  expect(within(box).getAllByText('NSE SPAN 11:01').length).toBeGreaterThan(0)
  expect(within(box).getByText('—', { selector: '[title="cash-segment margin is not computed"]' })).toBeTruthy()
  expect(within(box).getByText('Shares are cash segment: not in SPAN')).toBeTruthy()
  // Unchecked until the Q6 golden books pass (final fix I2): the server's note, with the others.
  expect(within(box).getByText("Not yet checked against a broker's margin figure (Phase 0 Q6)")).toBeTruthy()
})

test('a margin with a contract missing says partial in the headline, not only in the notes (final fix M3)', async () => {
  mount({ margin: { missing: ['option|2026-10-27|3100|CE'], notes: ['not in the SPAN file: option|2026-10-27|3100|CE — the figure is partial'] } })
  await settle()
  const box = screen.getByRole('group', { name: 'Margin' })
  expect(valueBeside(box, 'Total (lakh)')).toBe('1.25 (partial)')
  cleanup()
  mount()
  await settle()
  expect(valueBeside(screen.getByRole('group', { name: 'Margin' }), 'Total (lakh)')).toBe('1.25')
})

/** The P&L block's rows: [label, value]. */
const pnlRows = (): string[][] => rowsOf('P&L').map((r) => within(r).getAllByRole('cell').map((c) => c.textContent ?? ''))
const TODAY_LABELS = ['Today', "Legs carried from yesterday's close", "Today's trades", "Today's charges"]

test('the P&L block: Today in bold with its parts under it, summing to it; an unknown figure is "—"', async () => {
  mount()
  await settle()
  // carried + today's trades − today's charges: 1,575 + 875 − 35 = 2,415; the open cycle's 81 is in no day figure
  expect(pnlRows()).toEqual([['Today', '+2,415'], ["Legs carried from yesterday's close", '+1,575'], ["Today's trades", '+875'], ["Today's charges", '-35']])
  expect(screen.queryByText('Rates not confirmed by admin — charges are estimates')).toBe(null)
  expect(screen.queryByText("Market closed — last session's prices")).toBe(null)
  cleanup()

  const missing = 'NSE end-of-day file BhavCopy_NSE_FO_0_0_0_20261016_F_0000.csv for 16 Oct is missing — carried legs\' figure unknown'
  mount({ view: {
    closed: true,
    mtm: {
      ...MTM, gross: { previous: null, today: 875, total: null }, current: { previous: null, today: 840.26054475, total: null }, projected: null,
      ratesConfirmed: false, partial: ['C0001|option|TCS|2026-10-27|3100|PE'], notes: [missing, ...MTM_NOTES],
    },
  } })
  await settle()
  expect(pnlRows()).toEqual([['Today', '—'], ["Legs carried from yesterday's close", '—'], ["Today's trades", '+875'], ["Today's charges (est.)", '-35']])
  openNotes()
  expect(screen.getByText(missing)).toBeTruthy()
  // the server's notes on the old rows (Previous, Day MTM, Projected) are said by this block's own rows
  for (const n of MTM_NOTES) expect(screen.queryByText(n)).toBe(null)
  expect(screen.getByText('Left out of Today (no close or no LTP): C0001|option|TCS|2026-10-27|3100|PE')).toBeTruthy()
  expect(screen.getByText('Rates not confirmed by admin — charges are estimates')).toBeTruthy()
  expect(screen.getByText("Market closed — last session's prices")).toBeTruthy()
  expect(screen.getByText('BEP = 2880.4 - 3099.7')).toBeTruthy()
})

test('before the open Today and its parts are "—" with the reason on hover, and the block says so; nothing else changes', async () => {
  const none = { previous: null, today: null, total: null }
  const reason = 'market opens 09:15'
  mount({ view: {
    mtm: { ...MTM, gross: none, expense: none, current: none, projected: null, dayReason: reason, notes: [`Day MTM is not shown — ${reason}`, ...MTM_NOTES] },
  } })
  await settle()
  expect(pnlRows()).toEqual(TODAY_LABELS.map((l) => [l, '—']))
  for (const r of rowsOf('P&L')) expect(within(r).getAllByRole('cell')[1]!.querySelector('[title]')!.getAttribute('title')).toBe(reason)
  expect(screen.getByText(`Today is not shown — ${reason}`)).toBeTruthy()
  openNotes()
  expect(screen.queryByText(`Day MTM is not shown — ${reason}`)).toBe(null)
})

test('the old server\'s block (no dayReason key, the cycle\'s charges in Expense Previous) shows no day figure: "—", "server update pending"', async () => {
  const { dayReason: _d, openCycleCharges: _c, ...rest } = MTM
  const old = {
    ...rest, expense: { previous: 81.4140225, today: 34.73945525, total: 116.15347775 },
    current: { previous: 1493.5859775, today: 840.26054475, total: 2333.84652225 }, projected: 2163.69840675,
  } as unknown as MtmBlock   // as 1d07ad40 sends it
  mount({ view: { mtm: old } })
  await settle()
  expect(pnlRows()).toEqual(TODAY_LABELS.map((l) => [l, '—']))
  const total = within(rowsOf('P&L')[0]!).getAllByRole('cell')[1]!
  expect(total.querySelector('[title]')!.getAttribute('title')).toBe('server update pending')
  expect(screen.queryByText(/2,334|1,494|2,164/)).toBeNull()
})

const SERIES_TOTAL: SeriesTotal = {
  open: 70156, booked: -51344, gross: 18812, charges: 2100, net: 16712, closedContracts: 6, from: '2026-10-08', ratesConfirmed: true, notes: [],
}
const SERIES: SeriesPnl[] = [{ expiry: '2026-10-27', open: 70156, booked: -51344, gross: 18812, charges: 2100, net: 16712, closedContracts: 6, openLegs: 5, from: '2026-10-08', since: null, noLtp: [], notes: [] }]

test('the P&L block: P&L since the first trade in bold, booked, the open legs and the charges under it; then Today', async () => {
  mount({ view: { series: SERIES, seriesTotal: SERIES_TOTAL } })
  await settle()
  expect(pnlRows()).toEqual([
    ['P&L (since 8 Oct, after charges)', '+16,712'], ['Booked on closed contracts', '-51,344'], ['Open legs at LTP', '+70,156'], ['Charges', '-2,100'],
    ['Today', '+2,415'], ["Legs carried from yesterday's close", '+1,575'], ["Today's trades", '+875'], ["Today's charges", '-35'],
  ])
  // the two totals, their parts indented under them
  const indent = pnlRows().map((r, i) => (within(rowsOf('P&L')[i]!).getByText(r[0]!) as HTMLElement).style.paddingLeft)
  expect(indent).toEqual(['', '12px', '12px', '12px', '', '12px', '12px', '12px'])
  const block = screen.getByRole('group', { name: 'P&L' })
  fireEvent.click(within(block).getByRole('button', { name: 'About P&L' }))
  for (const l of [PNL_ABOUT, DAY_EXCLUDES, TODAY_ABOUT]) expect(within(block).getByText(l)).toBeTruthy()
  // one live expiry: its parts are the rows, not repeated in the ⓘ
  expect(within(block).queryByText(/^27 Oct 26:/)).toBe(null)
  cleanup()
  // two live expiries: each behind the ⓘ
  const nov: SeriesPnl = { ...SERIES[0]!, expiry: '2026-11-24', open: 0, booked: 3500, gross: 3500, charges: 40, net: 3460, closedContracts: 1, openLegs: 0, from: '2026-10-19' }
  mount({ view: { series: [...SERIES, nov], seriesTotal: { ...SERIES_TOTAL, booked: -47844, charges: 2140, net: 20172, closedContracts: 7, ratesConfirmed: false } } })
  await settle()
  expect(pnlRows()[3]).toEqual(['Charges (est.)', '-2,140'])
  const two = screen.getByRole('group', { name: 'P&L' })
  fireEvent.click(within(two).getByRole('button', { name: 'About P&L' }))
  expect(within(two).getByText('27 Oct 26: P&L +16,712 · booked -51,344 · open legs +70,156 · charges 2,100 (est.) · 6 closed · from 08 Oct 26')).toBeTruthy()
  expect(within(two).getByText('24 Nov 26: P&L +3,460 · booked +3,500 · open legs 0 · charges 40 (est.) · 1 closed · from 19 Oct 26')).toBeTruthy()
  cleanup()
  // an older server sends no series: Today alone
  mount()
  await settle()
  expect(pnlRows().map((r) => r[0])).toEqual(TODAY_LABELS)
})

test('none of the removed figures is on the book: no Pay In Out, CF Balance, square-off, projection, Open P&L, Day MTM or Series P&L', async () => {
  // a book holding shares, its series saying so
  const total = { ...SERIES_TOTAL, notes: ['shares are left out of P&L: they have no expiry'] }
  mountBook({ series: SERIES, seriesTotal: total, legs: [...bookView().legs, MANUAL_SHARES] }, { series: SERIES, seriesTotal: total })
  await settle()
  expect(screen.getByRole('table', { name: 'P&L' })).toBeTruthy()
  openNotes()
  // every ⓘ of P&L and Today opened, on the strip and on the block: each says shares are in Today, not in P&L
  const said: string[] = []
  const strip = screen.getByRole('group', { name: 'Book summary' })
  for (const about of ['P&L', 'Today']) {
    fireEvent.click(within(strip).getByRole('button', { name: `About ${about}` }))
    said.push(within(strip).getByRole('note', { name: about }).textContent ?? '')
    fireEvent.keyDown(document.body, { key: 'Escape' })
  }
  const block = screen.getByRole('group', { name: 'P&L' })
  fireEvent.click(within(block).getByRole('button', { name: 'About P&L' }))
  said.push(block.textContent ?? '')
  for (const x of said) expect(x).toContain(SHARES_LINE)
  const text = [document.body.textContent ?? '', ...said, ...[...document.querySelectorAll('[title], [aria-label]')].flatMap((e) => [e.getAttribute('title') ?? '', e.getAttribute('aria-label') ?? ''])].join(' | ')
  for (const gone of ['Pay In Out', 'CF Balance', 'CF balance', 'Sq. off Exp.', 'Proj. MTM', 'Open P&L', 'Day MTM', 'Series P&L', 'series P&L', 'Series booked', 'Gross MTM', 'GrossMTM']) {
    expect(text.includes(gone), gone).toBe(false)
  }
})

/** EventSource as the page uses it: enough to push a frame at the book. */
class FakeSource {
  static made: FakeSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly #on = new Map<string, ((e: MessageEvent<string>) => void)[]>()
  constructor(readonly url: string) { FakeSource.made.push(this) }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void): void { this.#on.set(name, [...(this.#on.get(name) ?? []), fn]) }
  close(): void {}
  emit(name: string, data: unknown): void { for (const fn of this.#on.get(name) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent<string>) }
}

/** The strip's P&L and Today, and the block's, as printed. */
function bothPnl(): { strip: [string, string]; block: [string, string] } {
  const strip = screen.getByRole('group', { name: 'Book summary' })
  const fig = (label: string): string => [...strip.querySelectorAll('.traders-pair')].find((x) => x.firstElementChild?.textContent === label)?.lastElementChild?.textContent ?? ''
  const row = (label: string): string => pnlRows().find((r) => r[0] === label || r[0]!.startsWith(`${label} (`))?.[1] ?? ''
  return { strip: [fig('P&L'), fig('Today')], block: [row('P&L'), row('Today')] }
}

test('the strip and the P&L block read one fresh frame: the same P&L and Today, whatever their own views read', async () => {
  FakeSource.made = []
  vi.stubGlobal('EventSource', FakeSource)
  // the book (the strip's) and the analysis (the block's) read the series at different moments: 16,712 and 15,900
  mountBook({ series: SERIES, seriesTotal: SERIES_TOTAL }, { series: SERIES, seriesTotal: { ...SERIES_TOTAL, open: 69344, net: 15900 } })
  await settle()
  expect(bothPnl()).toEqual({ strip: ['+16,712', '—'], block: ['+15,900', '+2,415'] })
  // a frame cut before either view: while the stream is live it is the one source, whatever their asOf
  const frame = {
    stock: 'TCS', asOf: ASOF - 60_000, closed: false, feedAlive: true, spot: 3000, future: 3010, legs: [], mtmReason: null,
    mtmToday: 35148, mtmTotal: -12026, mtmCharges: 120, seriesNet: -18023, seriesOpen: -173488, seriesBooked: 159125, seriesCharges: 3660,
  }
  act(() => { for (const x of FakeSource.made) x.emit('frame', frame) })
  await settle()
  expect(bothPnl()).toEqual({ strip: ['-18,023', '-12,026'], block: ['-18,023', '-12,026'] })
  // every part is the frame's: carried = Today − (trades − charges), trades = (trades − charges) + charges
  expect(pnlRows()).toEqual([
    ['P&L (since 8 Oct, after charges)', '-18,023'], ['Booked on closed contracts', '+1,59,125'], ['Open legs at LTP', '-1,73,488'], ['Charges', '-3,660'],
    ['Today', '-12,026'], ["Legs carried from yesterday's close", '-47,174'], ["Today's trades", '+35,268'], ["Today's charges", '-120'],
  ])
  // the old server's frame has no P&L fields and no charges: each reads its own view's P&L, Today's charges this view's
  const { seriesNet: _n, seriesOpen: _o, seriesBooked: _b, seriesCharges: _c, mtmCharges: _m, ...old } = frame
  act(() => { for (const x of FakeSource.made) x.emit('frame', { ...old, asOf: ASOF + 6_000 }) })
  await settle()
  expect(bothPnl()).toEqual({ strip: ['+16,712', '-12,026'], block: ['+15,900', '-12,026'] })
  expect(pnlRows().slice(5)).toEqual([["Legs carried from yesterday's close", '-47,174'], ["Today's trades", '+35,183'], ["Today's charges", '-35']])
})

test('Per lot rescales the Total row', async () => {
  mount({ view: { lotGcd: 3 } })
  await settle()
  expect(rowsOf('Total').map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['T', 'N'])
  expect(cell('Total', 0, 'Delta')).toBe('-525')
  fireEvent.click(screen.getByRole('radio', { name: 'Per lot' }))
  expect(cell('Total', 0, 'Delta')).toBe('-175')
  expect(cell('Total', 1, 'Vega')).toBe('-1,125')
  // greeks only: Pay In Out (cash, not P&L) is not a column
  expect(within(screen.getByRole('table', { name: 'Total' })).getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Pay In Out')
  expect(screen.getByText('T = at IV used · N = at market IV — our reading of VolHedge (Phase 0 Q3)')).toBeTruthy()
})

test('the Month Wise, Option Greeks and Greeks Comparison tabs', async () => {
  mount()
  await settle()
  fireEvent.click(screen.getByRole('tab', { name: 'Month Wise' }))
  expect(rowsOf('Month Wise').map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['27OCT', '23NOV', 'EQ'])
  fireEvent.click(screen.getByRole('tab', { name: 'Option Greeks' }))
  expect(cell('Option Greeks', 0, 'Gamma')).toBe('-0.4293')
  fireEvent.click(screen.getByRole('tab', { name: 'Comparison' }))
  expect(rowsOf('Comparison').map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['T', 'N', 'T − N'])
  expect(cell('Comparison', 2, 'Theta')).toBe('-1,726')
  expect(screen.getByText("diff = T - N — our reading of VolHedge's Greeks Comparison (Phase 0 Q3)")).toBeTruthy()
})

test('Online Update off pauses the 60 s poll; Calculate refetches now', async () => {
  const sent = mount()
  await settle()
  expect([analysisCalls(sent).length, marginCalls(sent).length]).toEqual([1, 1])
  await settle(60_000)
  expect([analysisCalls(sent).length, marginCalls(sent).length]).toEqual([2, 2])
  fireEvent.click(ctl('switch', 'Online Update'))
  await settle(180_000)
  expect([analysisCalls(sent).length, marginCalls(sent).length]).toEqual([2, 2])
  fireEvent.click(ctl('button', 'Calculate'))
  await settle()
  expect([analysisCalls(sent).length, marginCalls(sent).length]).toEqual([3, 3])
  await settle(120_000)
  expect(analysisCalls(sent).length).toBe(3)
  fireEvent.click(ctl('switch', 'Online Update'))
  await settle()
  expect(analysisCalls(sent).length).toBe(4)
  await settle(60_000)
  expect(analysisCalls(sent).length).toBe(5)
})

test('warnings show in a banner, and a failed refresh keeps the last figures', async () => {
  let fail = false
  vi.useFakeTimers()
  installFetch(({ path }) => {
    if (fail) return { status: 500, body: { error: 'snapshot unavailable' } }
    if (path.endsWith('/analysis')) return { body: view({ warnings: ['no IV for Nov 26 3100 P — marks flat'] }) }
    return { body: MARGIN }
  })
  render(<AnalysisTab stock="TCS" />)
  await settle()
  expect(screen.getByText('no IV for Nov 26 3100 P — marks flat')).toBeTruthy()
  fail = true
  fireEvent.click(ctl('button', 'Calculate'))
  await settle()
  expect(screen.getByText('Refresh failed: snapshot unavailable')).toBeTruthy()
  expect(screen.getByText('2955.40')).toBeTruthy()
})

test('the Analysis tab offers nothing to trade', async () => {
  // R1's rule (test/traders/no-trading.test.tsx), over every control this tab adds.
  const FORBIDDEN = /place|apply|square ?off|kill|flatten|submit order|cancel order|modify order|exit position|buy now|sell now|send order|execute/i
  mount()
  await settle()
  const controls = [...document.querySelectorAll('button, a, input, [role="button"], [role="tab"], [role="switch"], [role="option"]')]
    .map((e) => `${e.textContent ?? ''} ${e.getAttribute('aria-label') ?? ''} ${document.getElementById(e.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''}`.trim())
  expect(controls.length).toBeGreaterThan(20)
  expect(controls.filter((n) => FORBIDDEN.test(n))).toEqual([])
})

// ------------------------------------------------------------ fix round 1

const CLOSED = "Market closed — last session's prices"

/** The series the book (the strip's) and the analysis (the block's) carry; the same unless told apart. */
type SeriesOver = Pick<Partial<BookView>, 'series' | 'seriesTotal'>

/** `book` may carry legs of its own; then the analysis is given apart. */
function mountBook(book: SeriesOver & Pick<Partial<BookView>, 'legs'> = {}, analysis: SeriesOver = book): SentRequest[] {
  vi.useFakeTimers()
  const sent = installFetch(({ path }) => {
    if (path === '/v1/traders/books/TCS') return { body: bookView({ closed: true, ...book }) }
    if (path === '/v1/traders/books/TCS/analysis') return { body: view({ closed: true, ...analysis }) }
    if (path === '/v1/traders/books/TCS/margin') return { body: MARGIN }
    return { status: 404, body: { error: 'no such route' } }
  })
  render(<BookTab stock="TCS" />)
  return sent
}

const subTab = (name: string): HTMLElement => screen.getByRole('button', { name })

test('each sub-tab prints its own snapshot\'s closed line and time, once', async () => {
  mountBook()
  await settle()
  expect(screen.getAllByText(CLOSED)).toHaveLength(1)
  expect(screen.getAllByText(/^as of \d\d:\d\d IST$/)).toHaveLength(1)
  fireEvent.click(subTab('Analysis'))
  await settle()
  expect(screen.getByRole('table', { name: 'Legs' })).toBeTruthy()
  expect(screen.getAllByText(CLOSED)).toHaveLength(1)
  expect(screen.getAllByText(/^as of \d\d:\d\d IST$/)).toHaveLength(1)
})

test('a frozen future, and the rest of the tab\'s inputs, hold across a sub-tab switch until Start', async () => {
  const sent = mountBook()
  await settle()
  fireEvent.click(subTab('Analysis'))
  await settle()
  fireEvent.change(ctl('spinbutton', 'Call Vol %'), { target: { value: '2' } })
  fireEvent.click(ctl('button', 'Stop'))
  fireEvent.click(screen.getByRole('tab', { name: '23NOV' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Scenario-1 price %' }), { target: { value: '5' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Cal Vol Using EQ' }))
  fireEvent.click(ctl('switch', 'Online Update'))
  await settle(300)

  fireEvent.click(subTab('Scenario'))
  await settle()
  expect(screen.queryByRole('table', { name: 'Legs' })).toBe(null)
  const before = analysisCalls(sent).length
  fireEvent.click(subTab('Analysis'))
  await settle()
  // Back on the tab, the first request carries what was set — Online Update off or not.
  expect(analysisCalls(sent).length).toBe(before + 1)
  const q = lastQuery(analysisCalls(sent))
  expect([q.get('future'), q.get('callVol'), q.get('expiry'), q.getAll('gap'), q.get('basis')])
    .toEqual(['3010', '2', '2026-11-23', ['5,-10', '-10,-10'], 'cash'])
  expect((ctl('spinbutton', 'Future') as HTMLInputElement).value).toBe('3010')
  expect(screen.getByRole('tab', { name: '23NOV' }).getAttribute('aria-selected')).toBe('true')
  expect((ctl('switch', 'Online Update') as HTMLInputElement).checked).toBe(false)
  await settle(120_000)
  expect(analysisCalls(sent).length).toBe(before + 1)

  fireEvent.click(ctl('button', 'Start Future Update'))
  await settle(300)
  expect(lastQuery(analysisCalls(sent)).has('future')).toBe(false)
}, 30_000)   // two sub-tab switches and a 120 s fake-clock wait: past 5 s when the whole suite runs at once

interface Pending { readonly url: URL; answer(body: unknown): void }

/** A fetch that answers only when the test says, in the order the test says. */
function slowFetch(): Pending[] {
  const pending: Pending[] = []
  vi.stubGlobal('fetch', vi.fn((input: string) => new Promise((done) => {
    pending.push({
      url: new URL(String(input)),
      answer: (body) => done({ ok: true, status: 200, statusText: '200', json: async () => body } as unknown as Response),
    })
  })))
  return pending
}

const neutral = (units: number): Partial<AnalysisView> =>
  ({ toNeutralize: { units, price: units, pct: 0.5, lots: 1, side: 'Buy', contract: 'TCS OCT FUT', text: `Buy 1 lot TCS OCT FUT (${units})` } })

test('an older slow answer arriving after a newer one never overwrites it', async () => {
  vi.useFakeTimers()
  const pending = slowFetch()
  render(<AnalysisTab stock="TCS" />)
  await settle()
  const answer = async (p: Pending | undefined, body: unknown): Promise<void> => {
    p!.answer(body)
    await settle()
  }
  const analysisAt = (i: number): Pending | undefined => pending.filter((p) => p.url.pathname.endsWith('/analysis'))[i]
  await answer(analysisAt(0), view(neutral(1111)))
  await answer(pending.find((p) => p.url.pathname.endsWith('/margin')), MARGIN)
  expect(screen.getByText('1111.00')).toBeTruthy()

  fireEvent.change(ctl('spinbutton', 'Call Vol %'), { target: { value: '2' } })
  await settle(300)
  fireEvent.change(ctl('spinbutton', 'Put Vol %'), { target: { value: '1' } })
  await settle(300)
  expect(analysisAt(1)?.url.searchParams.get('putVol')).toBe(null)
  expect(analysisAt(2)?.url.searchParams.get('putVol')).toBe('1')

  await answer(analysisAt(2), view(neutral(3333)))
  expect(screen.getByText('3333.00')).toBeTruthy()
  await answer(analysisAt(1), view(neutral(2222)))
  expect(screen.getByText('3333.00')).toBeTruthy()
  expect(screen.queryByText('2222.00')).toBe(null)
})

test('a re-render with no input change sends no request', async () => {
  vi.useFakeTimers()
  const sent = installFetch(({ path }) => (path.endsWith('/analysis') ? { body: view() } : { body: MARGIN }))
  const r = render(<AnalysisTab stock="TCS" />)
  await settle()
  const n = sent.length
  fireEvent.click(screen.getByRole('radio', { name: 'Per lot' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Whole position' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Month Wise' }))
  fireEvent.click(screen.getByRole('tab', { name: 'All' }))
  r.rerender(<AnalysisTab stock="TCS" />)
  await settle(1000)
  expect(sent.length).toBe(n)
})

test('a StrictMode mount with Online Update off still loads (the page runs under StrictMode in dev)', async () => {
  const a = renderHook(() => useAnalysisInputs('TCS'))
  act(() => a.result.current.patch({ online: false }))
  a.unmount()
  vi.useFakeTimers()
  installFetch(({ path }) => (path.endsWith('/analysis') ? { body: view() } : { body: MARGIN }))
  render(<StrictMode><AnalysisTab stock="TCS" /></StrictMode>)
  await settle()
  expect(screen.getByText('Buy 7 lots TCS OCT FUT')).toBeTruthy()
  const box = screen.getByRole('group', { name: 'Margin' })
  fireEvent.click(within(box).getByRole('button', { name: 'About the margin files' }))
  expect(within(box).getByText('NSE SPAN 13:31')).toBeTruthy()
})

// ------------------------------------------------------- the minimal layout

test('no boxed panels: the sections are plain groups, and no Card is drawn anywhere on the tab', async () => {
  mount()
  await settle()
  for (const name of ['To Neutralize', 'Margin', 'P&L', 'Gap Up Down']) expect(screen.getByRole('group', { name })).toBeTruthy()
  expect(document.querySelector('.astryx-card')).toBe(null)
  // The refresh controls sit with the header's controls, not in a section.
  const box = screen.getByRole('group', { name: 'To Neutralize' })
  expect(within(box).queryByRole('switch', { name: 'Online Update' })).toBe(null)
  expect(within(box).queryByRole('button', { name: 'Calculate' })).toBe(null)
  expect(ctl('switch', 'Online Update')).toBeTruthy()
})

test('figures print in tabular digits', async () => {
  mount()
  await settle()
  // the carried legs' move, in the P&L block
  for (const n of screen.getAllByText('+1,575')) expect((n as HTMLElement).style.fontVariantNumeric).toBe('tabular-nums')
  expect((screen.getByText('-1,18,009') as HTMLElement).style.fontVariantNumeric).toBe('tabular-nums')
  const strip = screen.getByRole('group', { name: 'Expiry/Days/Rate1' })
  expect((within(strip).getByText('3,010.00') as HTMLElement).style.fontVariantNumeric).toBe('tabular-nums')
})

test('an explanation sits behind its ⓘ, in the same words: closed at first, opened under the figure on a click', async () => {
  mount()
  await settle()
  const gapNote = "At the next open, 09:15 IST 21 Oct — our reading of VolHedge's Gap Up/Down (Phase 0 Q3)"
  const panel = screen.getByRole('group', { name: 'Gap Up Down' })
  const about = within(panel).getByRole('button', { name: 'About Gap Up Down' })
  const before = within(panel).queryAllByText(gapNote).length            // the hover text only
  expect(about.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(about)
  expect(about.getAttribute('aria-expanded')).toBe('true')
  expect(within(panel).getAllByText(gapNote)).toHaveLength(before + 1)
  fireEvent.click(about)
  expect(within(panel).queryAllByText(gapNote)).toHaveLength(before)

  fireEvent.click(screen.getByRole('button', { name: 'About these rows' }))
  expect(screen.getAllByText('T = at IV used · N = at market IV — our reading of VolHedge (Phase 0 Q3)').length).toBeGreaterThan(1)
  fireEvent.click(screen.getByRole('button', { name: 'About Price basis' }))
  expect(screen.getAllByText('LTP is the only price basis for now').length).toBeGreaterThan(0)
})

test('the book is one view: every control and figure of the old Legs & payoff and Analysis tabs, once', async () => {
  mountBook()
  await settle()
  expect(screen.getByRole('region', { name: 'TCS analysis' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Legs & payoff' })).toBe(null)
  openAdjust()
  for (const name of ['Calculate', 'Stop', 'Start Future Update', 'Add leg', 'Edit layout']) expect(screen.getAllByRole('button', { name })).toHaveLength(1)
  for (const name of ['Call Vol %', 'Put Vol %', 'Future']) expect(screen.getAllByRole('spinbutton', { name })).toHaveLength(1)
  expect(screen.getAllByRole('switch', { name: 'Online Update' })).toHaveLength(1)
  for (const name of ['Legs', 'P&L']) expect(screen.getAllByRole('table', { name })).toHaveLength(1)
  // the greeks show once, in the Greeks table: no second Book totals line from the slower book poll under it
  expect(screen.queryByLabelText('Book totals')).toBe(null)
  for (const name of ['To Neutralize', 'Margin', 'P&L', 'Gap Up Down', 'Expiry/Days/Rate1']) {
    expect(screen.getAllByRole('group', { name })).toHaveLength(1)
  }
  expect(screen.getAllByRole('tablist', { name: 'Months' })).toHaveLength(1)
  expect(screen.getAllByRole('radiogroup', { name: 'Units' })).toHaveLength(1)
  expect(screen.getAllByText(/^as of \d\d:\d\d IST$/)).toHaveLength(1)
})

test("Legs & payoff's old hash opens the one view", async () => {
  window.location.hash = '#/books/TCS/legs'
  mountBook()
  await settle()
  expect(subTab('Analysis').getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('table', { name: 'Legs' })).toBeTruthy()
  window.location.hash = ''
})

test('Edit layout shows the toolbar and the blocks a trader can add, and the view still offers nothing to trade', async () => {
  const FORBIDDEN = /place|apply|square ?off|kill|flatten|submit order|cancel order|modify order|exit position|buy now|sell now|send order|execute/i
  mountBook()
  await settle()
  expect(screen.queryByRole('toolbar', { name: 'Layout' })).toBe(null)
  act(() => { window.dispatchEvent(new CustomEvent('traders:edit-layout')) })   // the `e` key
  const bar = screen.getByRole('toolbar', { name: 'Layout' })
  for (const name of ['Legs', 'Greeks', 'Payoff chart', 'To Neutralize', 'Margin', 'P&L', 'Gap Up Down', 'Scenario', 'Advice']) {
    expect(within(bar).getByRole('checkbox', { name })).toBeTruthy()
  }
  expect((within(bar).getByRole('checkbox', { name: 'Scenario' }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(within(bar).getByRole('checkbox', { name: 'Scenario' }))
  fireEvent.click(within(bar).getByRole('checkbox', { name: 'Advice' }))
  await settle()
  expect(document.querySelector('[data-block="scenario"]')).not.toBe(null)
  const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], input[type="submit"]')]
  expect(controls.map((n) => (n.getAttribute('aria-label') ?? n.textContent ?? '').trim()).filter((t) => FORBIDDEN.test(t))).toEqual([])
  fireEvent.click(within(bar).getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('toolbar', { name: 'Layout' })).toBe(null)
  expect(document.querySelector('[data-block="scenario"]')).not.toBe(null)   // kept as arranged
})

test('the figure lists are compact: the margin and To Neutralize rows carry the compact class', async () => {
  mount()
  await settle()
  for (const name of ['Margin', 'To Neutralize']) {
    expect(screen.getByRole('group', { name }).querySelector('.traders-figures > dl')).not.toBe(null)
  }
})
