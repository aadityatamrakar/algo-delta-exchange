/**
 * VolHedge v50's bottom tabs — Total | Month Wise | Option Greeks | Greeks
 * Comparison — every greek in the chosen units, each with the server's note
 * on what its rows mean behind the ⓘ (T and N are our reading of VolHedge, Phase 0 Q3).
 */

import { useState, type ReactElement } from 'react'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { sign } from '../format.ts'
import type { AnalysisView, GreekTotals } from '../../../traders/src/analytics/wire.ts'
import { scaleBook, type Units } from './units.tsx'
import { figure } from './wire.ts'
import { TradersTable } from './table.tsx'
import { NUM, useInfo } from './figures.tsx'

const TABS = [
  { id: 'total', label: 'Total' },
  { id: 'month', label: 'Month Wise' },
  { id: 'option', label: 'Option Greeks' },
  { id: 'comparison', label: 'Comparison' },
] as const
type TabId = (typeof TABS)[number]['id']

/** VolHedge's columns, each with the most decimals it is worth printing. */
const GREEKS: readonly (readonly [keyof GreekTotals, string, number])[] = [
  ['delta', 'Delta', 2], ['gamma', 'Gamma', 4], ['vega', 'Vega', 2], ['theta', 'Theta', 2], ['volga', 'Volga', 2], ['vanna', 'Vanna', 2],
]

interface PanelRow { readonly id: string; readonly label: string; readonly g: GreekTotals }
type Row = PanelRow & Record<string, unknown>

function rowsOf(tab: TabId, v: AnalysisView): readonly PanelRow[] {
  switch (tab) {
    case 'total': return [{ id: 'T', label: 'T', g: v.totals.T }, { id: 'N', label: 'N', g: v.totals.N }]
    case 'month': return v.monthWise.map((m) => ({ id: m.expiry === '' ? 'EQ' : m.expiry, label: m.label, g: m.totals }))
    case 'option': return [{ id: 'T', label: 'T', g: v.optionGreeks }]
    case 'comparison': return [
      { id: 'T', label: 'T', g: v.comparison.T },
      { id: 'N', label: 'N', g: v.comparison.N },
      { id: 'diff', label: 'T − N', g: v.comparison.diff },
    ]
  }
}

export function GreekPanels(props: { readonly view: AnalysisView; readonly units: Units }): ReactElement {
  const { view: v, units } = props
  const [tab, setTab] = useState<TabId>('total')
  const label = TABS.find((t) => t.id === tab)?.label ?? ''
  const scale = (n: number): number => scaleBook(n, units, v.lotSize, v.lotGcd)
  const info = useInfo('these rows', [tab === 'comparison' ? v.comparison.note : v.totals.note])

  const columns: TableColumn<Row>[] = [
    { key: 'row', header: '', renderCell: (r) => <Text size="sm" weight="bold">{(r as PanelRow).label}</Text> },
    ...GREEKS.map(([k, header, digits]): TableColumn<Row> => ({
      key: k, header, align: 'end',
      renderCell: (r) => {
        const n = scale((r as PanelRow).g[k])
        return <Text size="sm" style={{ ...NUM, ...sign(n) }}>{figure(n, digits)}</Text>
      },
    })),
  ]

  return (
    <VStack gap={2}>
      <HStack gap={1} align="center">
        <TabList role="tablist" aria-label="Greeks" value={tab} onChange={(t) => setTab(t as TabId)} layout="hug">
          {TABS.map((t) => <Tab key={t.id} role="tab" aria-selected={t.id === tab} value={t.id} label={t.label} />)}
        </TabList>
        {info.button}
      </HStack>
      {info.text}
      <TradersTable aria-label={label} data={rowsOf(tab, v) as unknown as Row[]} columns={columns} idKey="id" density="compact" />
    </VStack>
  )
}
