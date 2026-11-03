/** The traders pages' tables: their own scroll box, widths, pinned columns, and controls bounded to their cells. */
import { expect, test, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pixel } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import type { AnalysisLeg } from '../../../traders/src/analytics/wire.ts'
import type { GroupsView } from '../../../traders/src/analytics/r3-wire.ts'
import { GroupsTab } from '../../src/traders/groups.tsx'
import { LegTable } from '../../src/traders/leg-table.tsx'
import { PIN_FROM, TradersTable } from '../../src/traders/table.tsx'
import { installFetch } from '../http.tsx'
import { bookView, leg as bookLeg } from './fixtures.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function leg(over: Partial<AnalysisLeg> = {}): AnalysisLeg {
  return {
    key: 'C0001|option|TCS|2026-10-27|3000|CE', source: 'odin', included: true, illiquid: false, illiquidAuto: false,
    maturity: 'Oct 26', maturityDate: '2026-10-27', strike: 3000, type: 'C',
    units: -175, lots: -1, ltp: 60, netPrice: 50, buyPrice: 59.5, salePrice: 60.5, grossMtm: -1750, syntheticFuture: 3010, timeValue: 8750,
    ivUsed: 0.25, marketIv: 0.25, delta: 0.55, deltaValue: -96.25, vega: 3.1, vegaValue: -542.5, remarks: 'illiquid (no fresh quote) · IV from other side 3100 CE',
    gamma: 0.0021, gammaValue: -0.3675, theta: -1.8, thetaValue: 315, vanna: 0.01, vannaValue: -1.75, volga: 0.02, volgaValue: -3.5,
    ivSource: 'quote', ivFrom: null,
    ...over,
  }
}

const STATE = { exclude: [], illiquid: [], ivOverrides: {} }

/** A screen at least `PIN_FROM` wide, or not. */
function screenIsWide(wide: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({
    matches: wide && q === PIN_FROM, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }) as MediaQueryList)
}

function legTable(setIv: (key: string, iv: number | null) => void = () => {}): HTMLElement {
  const { container } = render(
    <LegTable legs={[leg()]} state={STATE} toggleExclude={() => {}} toggleIlliquid={() => {}} setIv={setIv} />,
  )
  return container
}

type R = { id: string; a: string; b: string }
const DATA: R[] = [{ id: '1', a: 'x', b: 'y' }]

test('a table with no column widths is laid out by its content; one with every width keeps the fixed layout', () => {
  const free: TableColumn<R>[] = [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }]
  const sized: TableColumn<R>[] = [{ key: 'a', header: 'A', width: pixel(80) }, { key: 'b', header: 'B', width: pixel(90) }]
  const one = render(<TradersTable aria-label="free" data={DATA} columns={free} idKey="id" />)
  expect(one.container.firstElementChild!.className).toBe('traders-table traders-table-auto')
  cleanup()
  const two = render(<TradersTable aria-label="sized" data={DATA} columns={sized} idKey="id" />)
  expect(two.container.firstElementChild!.className).toBe('traders-table')
  expect(two.container.querySelector('table')!.style.minWidth).toBe('170px')
})

test('the legs table is wider than any screen, so it scrolls in its own box instead of cramming 26 columns', () => {
  const box = legTable()
  expect(box.firstElementChild!.className).toBe('traders-table')
  expect(box.querySelector('.astryx-table-scroll-wrapper')).not.toBeNull()
  expect(Number.parseInt(box.querySelector('table')!.style.minWidth, 10)).toBeGreaterThan(2000)
  // every column has its own width: none is squeezed to an equal share
  for (const th of box.querySelectorAll('th')) expect(th.style.width).toMatch(/^\d+px$/)
})

test('on a wide screen the tick-to-Type run is pinned while the figures scroll; a phone pins nothing', () => {
  screenIsWide(true)
  let box = legTable()
  const at = (key: string): string => (box.querySelector(`th[data-column-key="${key}"]`) as HTMLElement).style.insetInlineStart
  expect(at('include')).toBe('0px')
  expect(at('type')).toBe('420px')          // include 40 + Illiq. 52 + Maturity 80 + MDate 100 + Strike 88, the sortable three + 20 each
  expect(at('units')).toBe('')
  cleanup()
  screenIsWide(false)
  box = legTable()
  expect(at('type')).toBe('')
})

test('the Vol (%) input sits in its cell: compact, as wide as the cell, and it still sets the IV', () => {
  const setIv = vi.fn()
  const box = legTable(setIv)
  const vol = within(box).getByRole('spinbutton') as HTMLInputElement
  expect(vol.closest('.traders-table td')).not.toBeNull()
  expect(vol.closest('.astryx-number-input')!.getAttribute('data-size')).toBe('sm')
  expect((vol.closest('.astryx-field') as HTMLElement).style.getPropertyValue('--x-width')).toBe('100%')
  fireEvent.change(vol, { target: { value: '30' } })
  expect(setIv).toHaveBeenLastCalledWith('C0001|option|TCS|2026-10-27|3000|CE', 0.3)
})

test("a leg's remark is a hover note on its Mkt Vol cell, with no Remarks column", () => {
  const box = legTable()
  expect(within(box).queryByRole('columnheader', { name: 'Remarks' })).toBe(null)
  const note = within(box).getByRole('img', { name: 'illiquid (no fresh quote) · IV from other side 3100 CE' })
  expect(note.getAttribute('title')).toBe('illiquid (no fresh quote) · IV from other side 3100 CE')
})

test("a control in another table's cell is compact too: the Groups name input", async () => {
  const A = bookLeg()
  const empty: GroupsView = {
    stock: 'TCS', asOf: 1, groups: [],
    ungrouped: { name: 'ungrouped', keys: [A.key], legCount: 1, totals: { delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0 }, payoff: null },
  }
  installFetch(() => ({ body: empty }))
  render(<GroupsTab stock="TCS" view={bookView({ legs: [A] })} />)
  await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(1))
  const input = screen.getByRole('textbox')
  expect(input.closest('.traders-table td')).not.toBeNull()
  expect(input.closest('.astryx-text-input')!.getAttribute('data-size')).toBe('sm')
})

test('every traders table goes through the shared one: no page renders astryx Table directly', () => {
  // vitest runs from apps/web (the workspace script) or from the repo root
  const dir = [join(process.cwd(), 'src/traders/'), join(process.cwd(), 'apps/web/src/traders/')].find((d) => existsSync(d))!
  const direct = readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') && f !== 'table.tsx')
    .filter((f) => /import \{[^}]*\bTable\b[^}]*\} from '@astryxdesign\/core\/Table'/.test(readFileSync(dir + f, 'utf8')))
  expect(direct).toEqual([])
})
