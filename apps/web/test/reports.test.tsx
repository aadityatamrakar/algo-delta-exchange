/**
 * The Reports page, WS2: a series view across dated tags (one symbol each),
 * the combined view across symbols, and the tags no series claims — in that
 * order, opening on the FIRST SERIES so NIFTY and SENSEX are read separately
 * by default. The combined view splits each day per symbol. Above the days, a
 * summary strip; in the table, a cumulative column, expiry days marked, and
 * each contributing tag's order log one click away.
 */
import { expect, test, describe, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ReportsPage, pickerGroups, summariseDays, symbolTotals, toDayRows } from '../src/reports.tsx'
import { ModeProvider } from '../src/mode.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type SentRequest } from './http.tsx'
import { istDayLabel, money, type GroupDayRow, type ReportSeries } from '../src/api.ts'

const SERIES: ReportSeries = {
  variants: ['delta-lean-aggressive', 'delta-lean-conservative'],
  series: [
    {
      series: 'NIFTY-delta-lean-aggressive', symbol: 'NIFTY', variant: 'delta-lean-aggressive',
      tags: ['NIFTY-delta-lean-aggressive-2026-09-29', 'NIFTY-delta-lean-aggressive-2026-09-30'],
      expiries: {
        'NIFTY-delta-lean-aggressive-2026-09-29': '2026-09-29',
        'NIFTY-delta-lean-aggressive-2026-09-30': '2026-10-06',
      },
      firstDate: '2026-09-29', lastDate: '2026-09-30',
    },
    {
      series: 'SENSEX-delta-lean-aggressive', symbol: 'SENSEX', variant: 'delta-lean-aggressive',
      tags: ['SENSEX-2026-09-17-delta-lean-aggressive'],
      expiries: { 'SENSEX-2026-09-17-delta-lean-aggressive': '2026-09-17' },
      firstDate: '2026-09-16', lastDate: '2026-09-17',
    },
  ],
}

const day = (over: Partial<GroupDayRow>): GroupDayRow => ({
  date: '2026-09-29', mode: 'paper', realised: 0, total: 0, maxProfit: 0, maxLoss: 0,
  orderCount: 0, closingPositions: 0, closingSource: 'marks', tags: [], expiryDay: false, expiryTags: [],
  ...over,
})

const VARIANT_DAYS: GroupDayRow[] = [
  day({
    date: '2026-09-29', realised: -2516, total: -2516, expiryDay: true,
    tags: ['NIFTY-delta-lean-aggressive-2026-09-29', 'SENSEX-delta-lean-aggressive-2026-09-29'],
    expiryTags: ['NIFTY-delta-lean-aggressive-2026-09-29'],
  }),
  day({ date: '2026-09-30', realised: 4016, total: 4016, tags: ['NIFTY-delta-lean-aggressive-2026-09-30'] }),
  day({ date: '2026-10-01', realised: 1700, total: null, closingSource: 'none', tags: ['NIFTY-delta-lean-aggressive-2026-10-01'] }),
]

/**
 * The same days as the COMBINED view answers them: split per symbol. SENSEX
 * reported only on the 29th, so the 30th and the 1st have no SENSEX entry.
 */
const COMBINED_DAYS: GroupDayRow[] = VARIANT_DAYS.map((d) => ({
  ...d,
  bySymbol: d.date === '2026-09-29'
    ? {
        NIFTY: { realised: -3000, total: -3000, tags: ['NIFTY-delta-lean-aggressive-2026-09-29'] },
        SENSEX: { realised: 484, total: 484, tags: ['SENSEX-delta-lean-aggressive-2026-09-29'] },
      }
    : { NIFTY: { realised: d.realised, total: d.total, tags: d.tags } },
}))

/**
 * Mount the page. `holdSeries`, when given, is awaited before the series list
 * answers — so a test can make the tags land first, as they can in real life.
 */
function mount(holdSeries?: Promise<void>): SentRequest[] {
  window.localStorage.setItem('desk.mode', 'paper')
  const sent = installFetch(({ path, url }) => {
    if (path === '/v1/desk/reports/series') return { body: SERIES }
    if (path === '/v1/desk/reports/tags') {
      // One tag a series claims (must not be listed again), one it does not.
      return { body: { tags: ['NIFTY-delta-lean-aggressive-2026-09-29', 'ORB_FUT_NIFTY'] } }
    }
    if (path === '/v1/desk/strategies') return { body: { strategies: [] } }
    if (path === '/v1/desk/reports/history') {
      const variant = url.searchParams.get('variant')
      return {
        body: {
          ...(variant === null ? {} : { variant, symbols: ['NIFTY', 'SENSEX'] }),
          mode: 'paper', from: '2026-07-06', to: '2026-10-04',
          tags: [], rows: variant === null ? VARIANT_DAYS : COMBINED_DAYS,
          totals: { realised: 3200, total: null, orderCount: 0, days: 3 },
          missingDays: 0,
        },
      }
    }
    if (path === '/v1/desk/reports/orders') return { body: { date: url.searchParams.get('date'), events: [] } }
    return { body: {} }
  })
  if (holdSeries !== undefined) {
    const answer = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === '/v1/desk/reports/series') await holdSeries
      return answer(input as string, init)
    })
  }
  render(
    <AuthProvider>
      <ModeProvider>
        <ReportsPage mode="paper" />
      </ModeProvider>
    </AuthProvider>,
  )
  return sent
}

afterEach(() => { vi.unstubAllGlobals() })

// ------------------------------------------------------------ pure helpers

describe('the picker', () => {
  test('series first, then the combined strategies, then the tags no series claims', () => {
    const { sections, first, picks } = pickerGroups({
      series: SERIES,
      tags: ['NIFTY-delta-lean-aggressive-2026-09-29', 'ORB_FUT_NIFTY', 'ORB_FUT_NIFTY'],
    })
    expect(sections.map((s) => s.title)).toEqual(['Series', 'Combined (all symbols)', 'Other tags'])
    expect(sections[0]!.options.map((o) => o.label)).toEqual([
      'NIFTY-delta-lean-aggressive', 'SENSEX-delta-lean-aggressive',
    ])
    expect(sections[1]!.options.map((o) => o.label)).toEqual(['delta-lean-aggressive', 'delta-lean-conservative'])
    // A tag a series already claims is reached through its series, not twice.
    expect(sections[2]!.options.map((o) => o.label)).toEqual(['ORB_FUT_NIFTY'])
    // It OPENS on the first series — one symbol, never the sum.
    expect(picks.get(first!)).toEqual({ kind: 'series', name: 'NIFTY-delta-lean-aggressive' })
  })

  test('series are grouped by symbol, then variant', () => {
    const s = (series: string, symbol: string, variant: string): ReportSeries['series'][number] => ({
      series, symbol, variant, tags: [], expiries: {}, firstDate: null, lastDate: null,
    })
    const { sections } = pickerGroups({
      series: {
        variants: ['b-var', 'a-var'],
        series: [
          s('SENSEX-a-var', 'SENSEX', 'a-var'),
          s('NIFTY-b-var', 'NIFTY', 'b-var'),
          s('NIFTY-a-var', 'NIFTY', 'a-var'),
          // A series whose name does not lead with its symbol still files by its symbol.
          s('zz-custom', 'NIFTY', 'c-var'),
        ],
      },
      tags: [],
    })
    expect(sections[0]!.options.map((o) => o.label)).toEqual([
      'NIFTY-a-var', 'NIFTY-b-var', 'zz-custom', 'SENSEX-a-var',
    ])
  })

  describe('it opens on the series that reported most recently', () => {
    const s = (series: string, symbol: string, variant: string, lastDate: string | null): ReportSeries['series'][number] => ({
      series, symbol, variant, tags: [], expiries: {}, firstDate: lastDate, lastDate,
    })
    const openOn = (list: ReportSeries['series']): unknown => {
      const { picks, first } = pickerGroups({ series: { variants: ['v'], series: list }, tags: [] })
      return picks.get(first!)
    }

    test('three series with different last days: the newest wins, display order kept', () => {
      const list = [
        s('KALYANKJIL-recenter-relief-r', 'KALYANKJIL', 'recenter-relief-r', '2026-09-12'),
        s('NIFTY-delta-lean-aggressive', 'NIFTY', 'delta-lean-aggressive', '2026-10-03'),
        s('SENSEX-delta-lean-aggressive', 'SENSEX', 'delta-lean-aggressive', '2026-10-01'),
      ]
      expect(openOn(list)).toEqual({ kind: 'series', name: 'NIFTY-delta-lean-aggressive' })
      const { sections } = pickerGroups({ series: { variants: [], series: list }, tags: [] })
      expect(sections[0]!.options.map((o) => o.label)).toEqual([
        'KALYANKJIL-recenter-relief-r', 'NIFTY-delta-lean-aggressive', 'SENSEX-delta-lean-aggressive',
      ])
    })

    test('a tie on the last day goes to the one first in symbol-then-variant order', () => {
      expect(openOn([
        s('SENSEX-delta-lean-aggressive', 'SENSEX', 'delta-lean-aggressive', '2026-10-03'),
        s('NIFTY-delta-lean-conservative', 'NIFTY', 'delta-lean-conservative', '2026-10-03'),
        s('NIFTY-delta-lean-aggressive', 'NIFTY', 'delta-lean-aggressive', '2026-10-03'),
      ])).toEqual({ kind: 'series', name: 'NIFTY-delta-lean-aggressive' })
    })

    test('a series that has never reported never wins while another has a date', () => {
      expect(openOn([
        s('AAA-fresh', 'AAA', 'fresh', null),
        s('NIFTY-delta-lean-aggressive', 'NIFTY', 'delta-lean-aggressive', '2026-09-01'),
      ])).toEqual({ kind: 'series', name: 'NIFTY-delta-lean-aggressive' })
      // None has reported: the first in display order.
      expect(openOn([s('BBB-x', 'BBB', 'x', null), s('AAA-x', 'AAA', 'x', null)]))
        .toEqual({ kind: 'series', name: 'AAA-x' })
    })
  })

  test('with no series yet it falls back to the tags', () => {
    const { sections, first, picks } = pickerGroups({ series: null, tags: ['B', 'A'] })
    expect(sections.map((s) => s.title)).toEqual(['Other tags'])
    expect(picks.get(first!)).toEqual({ kind: 'tag', name: 'A' })
  })
})

describe('the days', () => {
  test('a cumulative realised column runs oldest first', () => {
    const rows = toDayRows(VARIANT_DAYS)
    expect(rows.map((r) => r.cumulative)).toEqual([-2516, -2516 + 4016, -2516 + 4016 + 1700])
  })

  test('per-symbol realised totals over the range, symbols in the order given', () => {
    expect(symbolTotals(toDayRows(COMBINED_DAYS), ['NIFTY', 'SENSEX'])).toEqual([
      { symbol: 'NIFTY', realised: -3000 + 4016 + 1700 },
      { symbol: 'SENSEX', realised: 484 },
    ])
    // A day with no split (series and tag views) contributes nothing.
    expect(symbolTotals(toDayRows(VARIANT_DAYS), ['NIFTY'])).toEqual([{ symbol: 'NIFTY', realised: 0 }])
  })

  test('the summary: total realised, trading days, winning days, best and worst day', () => {
    const s = summariseDays(toDayRows(VARIANT_DAYS))
    expect(s.realised).toBe(3200)
    expect(s.days).toBe(3)
    expect(s.winning).toBe(2)
    expect(s.best).toEqual({ date: '2026-09-30', realised: 4016 })
    expect(s.worst).toEqual({ date: '2026-09-29', realised: -2516 })
    expect(summariseDays([])).toEqual({ realised: 0, days: 0, winning: 0, best: null, worst: null })
  })
})

// ------------------------------------------------------------- on screen

describe('the page', () => {
  test('opens on the first series — one symbol, in the mode on screen', async () => {
    // Tags answer FIRST, whatever the mock's natural timing would be.
    let release: () => void = () => {}
    const sent = mount(new Promise<void>((r) => { release = r }))
    await waitFor(() => expect(sent.some((r) => r.path === '/v1/desk/reports/tags')).toBe(true))
    release()
    await waitFor(() => expect(sent.some((r) => r.path === '/v1/desk/reports/history')).toBe(true))
    const history = sent.find((r) => r.path === '/v1/desk/reports/history')!
    const url = new URL(history.url)
    expect(url.searchParams.get('series')).toBe('NIFTY-delta-lean-aggressive')
    expect(url.searchParams.get('mode')).toBe('paper')
    expect(url.searchParams.get('tag')).toBe(null)
    expect(url.searchParams.get('variant')).toBe(null)
  })

  test('a tag list that lands before the series list does not open on a tag', async () => {
    // Real load order is not guaranteed: the tags can answer first. Until the
    // series list has answered (or failed) there is no telling whether a
    // strategy exists, so nothing may be picked — otherwise the page fetches
    // the alphabetically first tag and shows it under the strategy heading.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const sent = mount(gate)
    await waitFor(() => expect(sent.some((r) => r.path === '/v1/desk/reports/tags')).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(sent.some((r) => r.path === '/v1/desk/reports/history')).toBe(false)
    release()
    await waitFor(() => expect(sent.some((r) => r.path === '/v1/desk/reports/history')).toBe(true))
    const histories = sent.filter((r) => r.path === '/v1/desk/reports/history')
    expect(new URL(histories[0]!.url).searchParams.get('series')).toBe('NIFTY-delta-lean-aggressive')
    expect(histories.every((r) => new URL(r.url).searchParams.get('tag') === null)).toBe(true)
  })

  test('a series list that FAILS still lets the tags open', async () => {
    window.localStorage.setItem('desk.mode', 'paper')
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/reports/series') return { status: 500, body: { error: 'boom' } }
      if (path === '/v1/desk/reports/tags') return { body: { tags: ['ORB_FUT_NIFTY'] } }
      if (path === '/v1/desk/strategies') return { body: { strategies: [] } }
      if (path === '/v1/desk/reports/history') {
        return { body: { tag: 'ORB_FUT_NIFTY', mode: 'paper', from: '', to: '', rows: [], totals: { realised: 0, total: null, orderCount: 0, days: 0 }, missingDays: 0 } }
      }
      return { body: {} }
    })
    render(
      <AuthProvider>
        <ModeProvider>
          <ReportsPage mode="paper" />
        </ModeProvider>
      </AuthProvider>,
    )
    await waitFor(() => expect(sent.some((r) => r.path === '/v1/desk/reports/history')).toBe(true))
    const h = sent.find((r) => r.path === '/v1/desk/reports/history')!
    expect(new URL(h.url).searchParams.get('tag')).toBe('ORB_FUT_NIFTY')
  })

  test('the summary strip states the selection', async () => {
    mount()
    const strip = await screen.findByTestId('report-summary')
    await waitFor(() => expect(within(strip).getByText(money(3200))).toBeTruthy())
    expect(within(strip).getByText('2 of 3')).toBeTruthy()
    expect(within(strip).getByText(`${money(4016)} · ${istDayLabel('2026-09-30')}`)).toBeTruthy()
    expect(within(strip).getByText(`${money(-2516)} · ${istDayLabel('2026-09-29')}`)).toBeTruthy()
  })

  test('expiry days are marked and every contributing tag opens its own order log', async () => {
    const sent = mount()
    await screen.findByText('SENSEX-delta-lean-aggressive-2026-09-29')
    expect(screen.getAllByText('expiry').length).toBe(1)
    fireEvent.click(screen.getByText('SENSEX-delta-lean-aggressive-2026-09-29'))
    await screen.findByText('Order log — 2026-09-29 · SENSEX-delta-lean-aggressive-2026-09-29')
    await waitFor(() =>
      expect(sent.some((r) => r.path === '/v1/desk/reports/orders' &&
        new URL(r.url).searchParams.get('date') === '2026-09-29')).toBe(true),
    )
  })

  test('the cumulative column is on screen', async () => {
    mount()
    await screen.findByText('Cumulative')
    expect(screen.getByText(money(-2516 + 4016))).toBeTruthy()
  })

  test('the series view has no per-symbol columns and no per-symbol summary line', async () => {
    mount()
    await screen.findByText('Cumulative')
    expect(screen.queryByRole('columnheader', { name: 'NIFTY' })).toBe(null)
    expect(screen.queryByRole('columnheader', { name: 'SENSEX' })).toBe(null)
    expect(screen.queryByTestId('report-by-symbol')).toBe(null)
  })

  test('the combined view splits each day per symbol and totals each symbol', async () => {
    const sent = mount()
    await screen.findByText('Cumulative')
    await pickStrategy('delta-lean-aggressive')
    await waitFor(() =>
      expect(sent.some((r) => r.path === '/v1/desk/reports/history' &&
        new URL(r.url).searchParams.get('variant') === 'delta-lean-aggressive')).toBe(true),
    )
    await screen.findByRole('columnheader', { name: 'NIFTY' })
    expect(screen.getByRole('columnheader', { name: 'SENSEX' })).toBeTruthy()
    // Per-symbol columns come BEFORE the combined figures.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers.indexOf('NIFTY')).toBeLessThan(headers.indexOf('SENSEX'))
    expect(headers.indexOf('SENSEX')).toBeLessThan(headers.indexOf('Total'))
    expect(headers.indexOf('SENSEX')).toBeLessThan(headers.indexOf('Realised'))

    const rowOf = (date: string): HTMLElement =>
      screen.getAllByRole('row').find((r) => within(r).queryByText(istDayLabel(date)) !== null)!
    const cellsOf = (date: string): string[] =>
      within(rowOf(date)).getAllByRole('cell').map((c) => c.textContent ?? '')
    const col = (name: string): number => headers.indexOf(name)
    expect(cellsOf('2026-09-29')[col('NIFTY')]).toBe(money(-3000))
    expect(cellsOf('2026-09-29')[col('SENSEX')]).toBe(money(484))
    expect(cellsOf('2026-09-29')[col('Realised')]).toBe(money(-2516))
    expect(cellsOf('2026-09-30')[col('NIFTY')]).toBe(money(4016))
    // SENSEX did not report on the 30th: BLANK, not zero and not a dash.
    expect(cellsOf('2026-09-30')[col('SENSEX')]).toBe('')

    const line = within(screen.getByTestId('report-summary')).getByTestId('report-by-symbol')
    expect(line.textContent).toBe(`NIFTY ${money(2716)} · SENSEX ${money(484)}`)
  })
})

/** Opens the page's Strategy picker and chooses one option. */
async function pickStrategy(option: string): Promise<void> {
  const el = await waitFor(() => {
    const found =
      screen.queryByRole('combobox', { name: 'Strategy' }) ??
      screen.queryByRole('button', { name: 'Strategy' })
    if (found === null) throw new Error('no Strategy picker')
    return found
  })
  act(() => { el.click() })
  const choice = await screen.findByRole('option', { name: option })
  act(() => { choice.click() })
}
