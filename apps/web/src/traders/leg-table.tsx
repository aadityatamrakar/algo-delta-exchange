/**
 * VolHedge v50's leg table: the include tick, then its 25 columns in its order,
 * with the illiquid tick and the typed IV in place.
 *
 * Ticks and typed IVs go to the per-book viewer store (`viewer.ts`) and only
 * change what is computed for this viewer; nothing here is saved to the book.
 * As VolHedge prints them, whatever the units toggle (which sets the book's
 * figures only): the plain greek columns per share, the value columns (`D.V`,
 * `V.V`, `G.V`, `T.V`) the whole leg — both as served.
 *
 * Every column has a width, so the table is as wide as its columns and scrolls in
 * its own box (table.tsx), and on a wide screen the tick-to-Type run stays pinned
 * while the figures scroll under it.
 */

import type { ReactElement, ReactNode } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Icon } from '@astryxdesign/core/Icon'
import { HStack } from '@astryxdesign/core/Layout'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { pixel, useTableStickyColumns } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { inr, money, sign } from '../format.ts'
import type { AnalysisLeg } from '../../../traders/src/analytics/wire.ts'
import { LEG_PNL_TITLE } from './series-lines.ts'
import type { ViewerState } from './viewer.ts'
import { orDash } from './wire.ts'
import { CELL_INPUT, PIN_FROM, TradersTable, useMedia, type TradersColumn } from './table.tsx'

export interface LegTableProps {
  readonly legs: readonly AnalysisLeg[]
  readonly state: ViewerState
  toggleExclude(key: string): void
  toggleIlliquid(key: string): void
  setIv(key: string, iv: number | null): void
  /** Controls at the end of a row (a manual leg's Edit and Delete); nothing there for a leg that has none. */
  actions?(key: string): ReactNode
}

type Row = AnalysisLeg & Record<string, unknown>

const isOption = (l: AnalysisLeg): boolean => l.type === 'C' || l.type === 'P'

/** The row's name for its ticks and input: `Oct 26 3000 C`. */
function legName(l: AnalysisLeg): string {
  return [l.maturity, l.strike === null ? null : String(l.strike), l.type === 'EQ' ? null : l.type]
    .filter((s) => s !== null).join(' ')
}

/** A typed IV in vol points, without the float noise of `iv × 100`. */
const pts = (iv: number): number => Math.round(iv * 1e6) / 1e4

export function LegTable(props: LegTableProps): ReactElement {
  const { legs, state } = props
  // the hooks before the empty-book return below
  const pinned = useTableStickyColumns<Row>(useMedia(PIN_FROM) ? { startKeys: ['type'] } : {})
  const excluded = new Set(state.exclude)
  const shown = legs.filter((l) => !excluded.has(l.key)).length
  const all: boolean | 'indeterminate' = shown === legs.length ? true : shown === 0 ? false : 'indeterminate'
  const setAll = (): void => {
    const include = all !== true
    for (const l of legs) if (excluded.has(l.key) === include) props.toggleExclude(l.key)
  }

  const text = (l: AnalysisLeg, s: string, n?: number | null): ReactElement => {
    const on = !excluded.has(l.key)
    return (
      <Text size="sm" color={on ? 'primary' : 'secondary'} style={on && n !== undefined && n !== null ? sign(n) : undefined}>
        {s}
      </Text>
    )
  }
  // `by`: the leg's raw value the column sorts by (its header then sorts the table); none, not sortable
  const SORT_ICON_PX = 20
  const col = (key: string, header: ReactNode, px: number, render: (l: AnalysisLeg) => ReactNode, numeric = true,
    by?: (l: AnalysisLeg) => number | string | null): TradersColumn<Row> => ({
    // a sortable header also carries the sort arrow: its width on top, so the label is never squeezed
    key, header, width: pixel(by === undefined ? px : px + SORT_ICON_PX), ...(numeric ? { align: 'end' as const } : {}), renderCell: (r) => render(r as AnalysisLeg),
    ...(by === undefined ? {} : { sortValue: (r: Row) => by(r as AnalysisLeg) }),
  })
  const greek = (key: string, header: string, px: number, digits: number, v: (l: AnalysisLeg) => number): TradersColumn<Row> =>
    col(key, header, px, (l) => text(l, inr(v(l), digits)), true, v)

  const columns: TradersColumn<Row>[] = [
    {
      key: 'include',
      width: pixel(40),
      header: <CheckboxInput label="Include every leg" isLabelHidden size="sm" value={all} onChange={setAll} />,
      renderCell: (r) => {
        const l = r as AnalysisLeg
        return (
          <CheckboxInput label={`Include ${legName(l)}`} isLabelHidden size="sm" value={!excluded.has(l.key)}
            onChange={() => props.toggleExclude(l.key)} />
        )
      },
    },
    col('illiquid', 'Illiq.', 52, (l) => {
      if (!isOption(l)) return null
      const ticked = state.illiquid.includes(l.key)
      // The server marks a leg with no fresh quote illiquid on its own; a viewer's tick cannot undo that.
      return (
        <CheckboxInput label={`Illiquid ${legName(l)}`} isLabelHidden size="sm" value={ticked || l.illiquidAuto}
          isDisabled={l.illiquidAuto && !ticked} disabledMessage="No fresh quote — illiquid until one arrives"
          onChange={() => props.toggleIlliquid(l.key)} />
      )
    }, false),
    col('maturity', 'Maturity', 80, (l) => text(l, l.maturity), false, (l) => l.maturityDate),
    col('mdate', 'MDate', 100, (l) => text(l, l.maturityDate === '' ? '—' : l.maturityDate), false, (l) => l.maturityDate),
    col('strike', 'Strike', 88, (l) => text(l, l.strike === null ? '—' : inr(l.strike, Number.isInteger(l.strike) ? 0 : 2)), true, (l) => l.strike),
    col('type', 'Type', 56, (l) => text(l, l.type), false, (l) => l.type),
    col('units', 'Units', 88, (l) => text(l, inr(l.units), l.units), true, (l) => l.units),
    col('lots', 'Lots', 72, (l) => text(l, orDash(l.lots, 2), l.lots), true, (l) => l.lots),
    col('ltp', 'LTP', 84, (l) => text(l, orDash(l.ltp, 2)), true, (l) => l.ltp),
    col('net', 'Net Price', 96, (l) => text(l, inr(l.netPrice, 2)), true, (l) => l.netPrice),
    col('buy', 'Buy Price', 96, (l) => text(l, orDash(l.buyPrice, 2)), true, (l) => l.buyPrice),
    col('sale', 'Sell Price', 96, (l) => text(l, orDash(l.salePrice, 2)), true, (l) => l.salePrice),
    col('gross', <span title={LEG_PNL_TITLE}>Leg P&amp;L</span>, 108, (l) => text(l, money(l.grossMtm), l.grossMtm), true, (l) => l.grossMtm),
    col('synfut', 'Synfut', 96, (l) => text(l, orDash(l.syntheticFuture, 2)), true, (l) => l.syntheticFuture),
    col('tv', 'TimeValue', 112, (l) => text(l, orDash(l.timeValue, 2)), true, (l) => l.timeValue),
    col('vol', 'Vol (%)', 124, (l) => {
      if (!isOption(l)) return text(l, '—')
      const typed = state.ivOverrides[l.key]
      // Empty until the viewer types one. The placeholder is the market IV, the base a Call/Put shift is
      // added to, so typing it back does not add the shift twice. Clearing it sends no override.
      return (
        <NumberInput label={`Vol (%) ${legName(l)}`} {...CELL_INPUT} hasClear min={0.01} max={500}
          value={typed === undefined ? null : pts(typed)}
          placeholder={l.marketIv === null ? '—' : (l.marketIv * 100).toFixed(2)}
          onChange={(v) => props.setIv(l.key, v === null ? null : v / 100)} />
      )
    }, true, (l) => l.ivUsed),
    col('mktvol', 'Mkt Vol (%)', 120, (l) => {
      const v = text(l, l.marketIv === null ? '—' : (l.marketIv * 100).toFixed(2))
      if (l.remarks === '') return v
      // The leg's remark (IV typed, illiquid, IV from the other side) on hover: it no longer has a column of its own.
      return (
        <HStack gap={1} align="center" justify="end">
          <span role="img" aria-label={l.remarks} title={l.remarks}><Icon icon="info" size="sm" color="inherit" /></span>
          {v}
        </HStack>
      )
    }, true, (l) => l.marketIv),
    greek('delta', 'Delta', 80, 2, (l) => l.delta),
    greek('dv', 'D.V', 100, 0, (l) => l.deltaValue),
    greek('vega', 'Vega', 80, 2, (l) => l.vega),
    greek('vv', 'V.V', 100, 0, (l) => l.vegaValue),
    greek('gamma', 'Gamma', 84, 4, (l) => l.gamma),
    greek('gv', 'G.V', 96, 4, (l) => l.gammaValue),
    greek('theta', 'Theta', 80, 2, (l) => l.theta),
    greek('thv', 'T.V', 96, 0, (l) => l.thetaValue),
    ...(props.actions === undefined ? [] : [{
      key: 'actions', header: '', width: pixel(150),
      renderCell: (r: Row) => props.actions?.((r as AnalysisLeg).key) ?? <span />,
    }]),
  ]

  if (legs.length === 0) return <Text color="secondary">No legs in this view.</Text>
  return (
    <TradersTable aria-label="Legs" data={legs as unknown as Row[]} columns={columns} idKey="key" density="compact" hasHover
      plugins={{ pinned }} />
  )
}
