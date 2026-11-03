/** Sortable traders tables (table.tsx): a header click sorts ascending, descending, then back; blanks last; totals stay last. */
import { expect, test, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { TableSortState } from '@astryxdesign/core/Table'
import type { AnalysisLeg } from '../../../traders/src/analytics/wire.ts'
import { LegTable } from '../../src/traders/leg-table.tsx'
import { TradersTable, sortRows, type TradersColumn } from '../../src/traders/table.tsx'

afterEach(() => { cleanup() })

type Row = { id: string; kind: 'row' | 'child' | 'total'; name: string; v: number | null }
const ROWS: Row[] = [
  { id: 'a', kind: 'row', name: 'b10', v: 3 },
  { id: 'a1', kind: 'child', name: 'a1', v: 100 },
  { id: 'b', kind: 'row', name: 'b9', v: null },
  { id: 'c', kind: 'row', name: 'a2', v: 1 },
  { id: 't', kind: 'total', name: 'Total', v: 4 },
]
const COLS: TradersColumn<Row>[] = [
  { key: 'name', header: 'Name', sortValue: (r) => r.name, renderCell: (r) => r.name },
  { key: 'v', header: 'V', sortValue: (r) => r.v, renderCell: (r) => (r.v === null ? '—' : String(r.v)) },
  { key: 'plain', header: 'Plain', renderCell: () => '' },
]
const isTotal = (r: Row): boolean => r.kind === 'total'
const isChild = (r: Row): boolean => r.kind === 'child'
const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.id)
const by = (sortKey: string, direction: 'ascending' | 'descending'): TableSortState => [{ sortKey, direction }]

test('sortRows: either way by a column, blanks last both ways, the totals row last, a child row with its parent', () => {
  expect(ids(sortRows(ROWS, COLS, by('v', 'ascending'), isTotal, isChild))).toEqual(['c', 'a', 'a1', 'b', 't'])
  expect(ids(sortRows(ROWS, COLS, by('v', 'descending'), isTotal, isChild))).toEqual(['a', 'a1', 'c', 'b', 't'])
  expect(ids(sortRows(ROWS, COLS, [], isTotal, isChild))).toEqual(ids(ROWS))
  // a column with no sortValue leaves the served order
  expect(ids(sortRows(ROWS, COLS, by('plain', 'ascending'), isTotal, isChild))).toEqual(ids(ROWS))
})

test('sortRows: text sorts the way it reads, numbers inside it by value (b9 before b10)', () => {
  expect(ids(sortRows(ROWS, COLS, by('name', 'ascending'), isTotal, isChild))).toEqual(['c', 'b', 'a', 'a1', 't'])
})

const firstCells = (): string[] => screen.getAllByRole('row').slice(1).map((tr) => within(tr).getAllByRole('cell')[0]!.textContent ?? '')

test('a header click sorts ascending, then descending, then back to the served order, with aria-sort on the header cell', () => {
  render(<TradersTable aria-label="T" data={ROWS} columns={COLS} idKey="id" keepLast={isTotal} isChild={isChild} />)
  const headers = screen.getAllByRole('columnheader')
  const v = headers[1]!
  expect(within(headers[2]!).queryByRole('button')).toBe(null)          // not sortable: no sort button
  const button = within(v).getByRole('button')
  fireEvent.click(button)
  expect(v.getAttribute('aria-sort')).toBe('ascending')
  expect(firstCells()).toEqual(['a2', 'b10', 'a1', 'b9', 'Total'])
  fireEvent.click(within(v).getByRole('button'))
  expect(v.getAttribute('aria-sort')).toBe('descending')
  expect(firstCells()).toEqual(['b10', 'a1', 'a2', 'b9', 'Total'])
  fireEvent.click(within(v).getByRole('button'))
  expect(['none', null]).toContain(v.getAttribute('aria-sort'))
  expect(firstCells()).toEqual(['b10', 'a1', 'b9', 'a2', 'Total'])
})

function leg(strike: number, units: number): AnalysisLeg {
  return {
    key: `C0001|option|TCS|2026-10-27|${strike}|CE`, source: 'odin', included: true, illiquid: false, illiquidAuto: false,
    maturity: 'Oct 26', maturityDate: '2026-10-27', strike, type: 'C',
    units, lots: units / 175, ltp: 60, netPrice: 50, buyPrice: null, salePrice: null, grossMtm: -1750, syntheticFuture: 3010, timeValue: 8750,
    ivUsed: 0.25, marketIv: 0.25, delta: 0.55, deltaValue: -96.25, vega: 3.1, vegaValue: -542.5, remarks: '',
    gamma: 0.0021, gammaValue: -0.3675, theta: -1.8, thetaValue: 315, vanna: 0.01, vannaValue: -1.75, volga: 0.02, volgaValue: -3.5,
    ivSource: 'quote', ivFrom: null,
  }
}

test("the legs table sorts by a column's raw numbers, not its formatted text", () => {
  const legs = [leg(3100, -175), leg(900, 350), leg(3000, -525)]
  render(<LegTable legs={legs} state={{ exclude: [], illiquid: [], ivOverrides: {} }} toggleExclude={() => {}} toggleIlliquid={() => {}} setIv={() => {}} />)
  const table = screen.getByRole('table', { name: 'Legs' })
  const headers = within(table).getAllByRole('columnheader')
  const at = headers.findIndex((h) => h.textContent?.includes('Strike'))
  const strikes = (): string[] => within(table).getAllByRole('row').slice(1).map((tr) => within(tr).getAllByRole('cell')[at]!.textContent ?? '')
  fireEvent.click(within(headers[at]!).getByRole('button'))
  expect(strikes()).toEqual(['900', '3,000', '3,100'])   // as text "3,000" < "900"; by value 900 first
  fireEvent.click(within(headers[at]!).getByRole('button'))
  expect(strikes()).toEqual(['3,100', '3,000', '900'])
  const unitsAt = headers.findIndex((h) => h.textContent?.includes('Units'))
  fireEvent.click(within(within(table).getAllByRole('columnheader')[unitsAt]!).getByRole('button'))
  expect(within(table).getAllByRole('row').slice(1).map((tr) => within(tr).getAllByRole('cell')[unitsAt]!.textContent)).toEqual(['-525', '-175', '350'])
})
