/**
 * VolHedge v50's scenario grid: the top totals row, the date-tick row, the 14
 * metric tabs and the spot × date grid, the current-spot row marked.
 *
 * Cells arrive as whole-position figures. A plain metric follows the units
 * toggle (`scaleBook`); a Value metric is the whole position whatever the
 * units. Unticking a date hides its column here and sends nothing.
 */

import { memo, useEffect, useMemo, useRef, type ReactElement } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import type { TableColumn, TablePlugin } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { inr, sign } from '../format.ts'
import type { ScenarioCell, ScenarioView } from '../../../traders/src/analytics/wire.ts'
import { scaleBook, type Units } from './units.tsx'
import type { ScenarioPatch } from './viewer.ts'
import { figure } from './wire.ts'
import { TradersTable } from './table.tsx'

/** VolHedge's metric tabs, in its order. */
export const METRICS: readonly { readonly label: string; readonly key: keyof ScenarioCell; readonly value: boolean }[] = [
  { label: 'Profit & Loss', key: 'pnl', value: false }, { label: 'P & L Value', key: 'pnl', value: true },
  { label: 'Delta', key: 'delta', value: false }, { label: 'Delta Value', key: 'delta', value: true },
  { label: 'Gamma', key: 'gamma', value: false }, { label: 'Gamma Value', key: 'gamma', value: true },
  { label: 'Vega', key: 'vega', value: false }, { label: 'Vega Value', key: 'vega', value: true },
  { label: 'Theta', key: 'theta', value: false }, { label: 'Theta Value', key: 'theta', value: true },
  { label: 'Volga', key: 'volga', value: false }, { label: 'Volga Value', key: 'volga', value: true },
  { label: 'Vanna', key: 'vanna', value: false }, { label: 'Vanna Value', key: 'vanna', value: true },
]

export const VALUE_NOTE = 'Value = whole position (greek × units); the plain metric follows the units toggle — our reading of VolHedge (Phase 0 Q3)'

/** The most decimals each figure is worth printing, as the Analysis greek tabs print them. */
const DIGITS: Readonly<Record<keyof ScenarioCell, number>> = { pnl: 0, delta: 2, gamma: 4, vega: 2, theta: 2, volga: 2, vanna: 2 }

/** The current-spot row: tinted, and the row `aria-current` names. */
const CURRENT_ROW = { background: 'var(--color-accent-muted)' }
/** The grid scrolls inside its own box, so bringing the current row into view never moves the page. */
const GRID_BOX = { maxHeight: '60vh', overflowY: 'auto' } as const

const figureText = (n: number, key: keyof ScenarioCell): ReactElement =>
  <Text size="sm" style={sign(n)}>{figure(n, DIGITS[key])}</Text>

type TotalsRow = { readonly id: string; readonly cell: ScenarioCell } & Record<string, unknown>

const TOTALS: readonly (readonly [string, keyof ScenarioCell])[] = [
  ['Profit/Loss', 'pnl'], ['Delta', 'delta'], ['Gamma', 'gamma'], ['Vega', 'vega'], ['Theta', 'theta'], ['Volga', 'volga'], ['Vanna', 'vanna'],
]

/**
 * VolHedge's top row: P&L and the greeks at CMP on the grid's first date, in the chosen units like the plain metrics.
 * Memoised, like the grid: an input or row edit does not change it until the next answer arrives.
 */
export const ScenarioTotals = memo(function ScenarioTotals(props: { readonly view: ScenarioView; readonly units: Units }): ReactElement {
  const { view: v, units } = props
  const columns: TableColumn<TotalsRow>[] = TOTALS.map(([header, key]) => ({
    key, header, align: 'end',
    renderCell: (r) => figureText(scaleBook((r as TotalsRow).cell[key], units, v.lotSize, v.lotGcd), key),
  }))
  return <TradersTable aria-label="Scenario totals" data={[{ id: 'totals', cell: v.totals }]} columns={columns} idKey="id" density="compact" />
})

/** A spot's distance from M.Strike in percent, rid of float noise before it is rounded for print. */
function percentFrom(spot: number, middle: number): string {
  if (!Number.isFinite(spot) || !Number.isFinite(middle) || middle <= 0) return '—'
  const pct = Math.round((spot / middle - 1) * 100 * 1e9) / 1e9
  return pct.toFixed(2)
}

type GridRow = { readonly id: string; readonly i: number; readonly spot: number } & Record<string, unknown>

export interface ScenarioGridProps {
  readonly view: ScenarioView
  readonly units: Units
  readonly metric: string                 // a METRICS label
  readonly hidden: readonly string[]      // labels of the unticked dates
  patch(p: ScenarioPatch): void
}

/** Memoised: it re-renders for a new answer, the units, the metric or a date tick — not for an input being typed. */
export const ScenarioGrid = memo(function ScenarioGrid(props: ScenarioGridProps): ReactElement {
  const { view: v, units, hidden, patch } = props
  const { spots, currentRow, labels, cells } = v.grid
  const metric = METRICS.find((m) => m.label === props.metric) ?? METRICS[0]!
  const scale = (n: number): number => (metric.value ? n : scaleBook(n, units, v.lotSize, v.lotGcd))

  const box = useRef<HTMLDivElement | null>(null)
  const current = useRef<HTMLTableRowElement | null>(null)
  const plugin = useMemo((): TablePlugin<GridRow> => ({
    transformScrollWrapper: (p) => ({ ...p, htmlProps: { ...p.htmlProps, ref: box, style: { ...p.htmlProps.style, ...GRID_BOX } } }),
    transformBodyRow: (p, _row, i) => (i === currentRow
      ? { ...p, ref: current, htmlProps: { ...p.htmlProps, 'aria-current': 'true', style: { ...p.htmlProps.style, ...CURRENT_ROW } } }
      : p),
  }), [currentRow])
  // Centre the current row in the box when the rows change, not on every refresh of the same rows.
  const axis = `${currentRow}|${spots.length}|${spots[0] ?? ''}`
  useEffect(() => {
    const b = box.current
    const r = current.current
    if (b === null || r === null) return
    b.scrollTop = Math.max(0, r.offsetTop - (b.clientHeight - r.offsetHeight) / 2)
  }, [axis])

  const toggle = (label: string): void => patch((now) => ({
    hidden: now.hidden.includes(label) ? now.hidden.filter((h) => h !== label) : [...now.hidden, label],
  }))

  const columns: TableColumn<GridRow>[] = [
    { key: 'spot', header: 'SpotValue', align: 'end', renderCell: (r) => <Text size="sm" weight="bold">{inr((r as GridRow).spot, 2)}</Text> },
    { key: 'pct', header: 'Percent(%)', align: 'end', renderCell: (r) => <Text size="sm">{percentFrom((r as GridRow).spot, v.resolved.middle)}</Text> },
    ...labels.flatMap((label, c): TableColumn<GridRow>[] => (hidden.includes(label) ? [] : [{
      key: `d${c}`, header: label, align: 'end',
      renderCell: (r) => {
        const cell = cells[(r as GridRow).i]?.[c]
        return cell === undefined ? <Text size="sm">—</Text> : figureText(scale(cell[metric.key]), metric.key)
      },
    }])),
  ]
  const rows: GridRow[] = spots.map((spot, i) => ({ id: String(i), i, spot }))

  return (
    <VStack gap={2}>
      <HStack gap={3} wrap="wrap" role="group" aria-label="Dates shown">
        {labels.map((label) => (
          <CheckboxInput key={label} label={label} size="sm" value={!hidden.includes(label)} onChange={() => toggle(label)} />
        ))}
      </HStack>
      {/* fourteen metrics are wider than the page: the strip scrolls on its own, the page never sideways */}
      <div className="traders-tab-scroll">
      <TabList role="tablist" aria-label="Metric" value={metric.label} onChange={(m) => patch({ metric: m })} layout="hug" hasDivider>
        {METRICS.map((m) => <Tab key={m.label} role="tab" aria-selected={m.label === metric.label} value={m.label} label={m.label} />)}
      </TabList>
      </div>
      <TradersTable aria-label="Scenario grid" data={rows} columns={columns} idKey="id" density="compact" plugins={{ current: plugin }} />
      <Text size="sm" color="secondary">{VALUE_NOTE}</Text>
      <Text size="sm" color="secondary">{v.baseNote}</Text>
    </VStack>
  )
})
