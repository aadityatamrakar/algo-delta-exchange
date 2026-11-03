/**
 * The book's own pieces, from `GET /books/<stock>` (BookView): the manual-leg actions (Add, Edit, Delete and their
 * dialogs), the payoff chart with the engine's warnings, the book's position totals, the not-understood lines, and
 * the plain legs table. The Analysis view uses them beside its own figures, and falls back to the plain table when
 * the analysis cannot be had.
 */

import { useState, type ReactElement, type ReactNode } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Button } from '@astryxdesign/core/Button'
import { List } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'
import { pixel } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import { PayoffCurves } from '../payoff-curves.tsx'
import { inr, money, sign, signed } from '../format.ts'
import type { BookView, LegView } from '../../../traders/src/types.ts'
import { AddLegDialog, DeleteLegDialog, EditLegDialog } from './add-leg.tsx'
import { Caveats } from './caveats.tsx'
import { LEG_PNL_TITLE } from './series-lines.ts'
import { TradersTable } from './table.tsx'
import { bookLotSize, lotsOf, notUnderstood, typeText } from './wire.ts'

export interface LegActions {
  /** The Add leg button; none without the book. */
  readonly add: ReactElement | null
  /** Edit and Delete for a manual leg (by its key); nothing for a leg from the trade files. */
  actionsFor(key: string): ReactElement | null
  /** The open dialog, if any. */
  readonly dialogs: ReactElement
}

export function useLegActions(stock: string, view: BookView | null, reload: () => void): LegActions {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<LegView | null>(null)
  const [deleting, setDeleting] = useState<LegView | null>(null)
  const actionsFor = (key: string): ReactElement | null => {
    const l = view?.legs.find((x) => x.key === key)
    if (l === undefined || l.source !== 'manual') return null
    return (
      <HStack gap={1}>
        <Button size="sm" variant="secondary" label="Edit" onClick={() => setEditing(l)} />
        <Button size="sm" variant="secondary" label="Delete" onClick={() => setDeleting(l)} />
      </HStack>
    )
  }
  return {
    add: view === null ? null : <Button size="sm" variant="primary" label="Add leg" onClick={() => setAdding(true)} />,
    actionsFor,
    dialogs: (
      <>
        {adding && view !== null ? <AddLegDialog stock={stock} lotSize={bookLotSize(view.legs)} onClose={() => setAdding(false)} onSaved={reload} /> : null}
        {editing === null ? null : <EditLegDialog stock={stock} leg={editing} onClose={() => setEditing(null)} onSaved={reload} />}
        {deleting === null ? null : <DeleteLegDialog stock={stock} leg={deleting} onClose={() => setDeleting(null)} onSaved={reload} />}
      </>
    ),
  }
}

/** The payoff curves at expiry and today, marked at spot, with the engine's own warnings under them. */
export function PayoffChart(props: { readonly view: BookView; readonly height?: number }): ReactElement {
  const { view } = props
  if (view.payoff === null) return <Text size="sm" color="secondary">No payoff for this book yet.</Text>
  const firstExpiry = view.legs.map((l) => l.expiry).filter((e) => e !== '').sort()[0] ?? ''
  const firstForward = Object.values(view.forwards).find((f): f is number => typeof f === 'number') ?? null
  const warnings = view.payoff.warnings ?? []
  return (
    <VStack gap={2}>
      <PayoffCurves view={view.payoff} markAt={view.spot ?? firstForward} markLabel="spot" expiryDate={firstExpiry} overlay={null}
        {...(props.height === undefined ? {} : { height: props.height })} />
      {/* The engine's own qualifications; the chart's empty state points here ("the warnings below"). */}
      {warnings.length === 0 ? null : (
        <List density="compact" header={<Text size="sm" weight="bold">Payoff warnings</Text>}>
          <Caveats items={warnings} kind="item" />
        </List>
      )}
    </VStack>
  )
}

/** The book's position greeks, from the book itself. Its result is P&L, on the strip and the P&L block. */
export function BookTotals(props: { readonly view: BookView }): ReactElement {
  const t = props.view.totals
  const cell = (label: string, text: string, n: number): ReactElement => (
    <HStack gap={1} key={label} align="center">
      <Text color="secondary" size="sm">{label}</Text>
      <Text size="sm" weight="bold" {...(sign(n) === undefined ? {} : { style: sign(n) })}>{text}</Text>
    </HStack>
  )
  return (
    <HStack gap={4} wrap="wrap" aria-label="Book totals">
      {cell('Δ', signed(t.delta, 2), t.delta)}
      {cell('Γ', signed(t.gamma, 4), t.gamma)}
      {cell('Vega', signed(t.vega, 2), t.vega)}
      {cell('Θ', signed(t.theta, 2), t.theta)}
    </HStack>
  )
}

/** The rows that could not be read as a contract, left out of every figure. */
export function NotUnderstood(props: { readonly lines: readonly string[] }): ReactElement | null {
  if (props.lines.length === 0) return null
  return (
    <VStack gap={0}>
      <Text size="sm" weight="bold">Not understood — left out of every figure</Text>
      {props.lines.map((u, i) => <Text key={`${i}:${u}`} size="sm" color="secondary">{notUnderstood(u)}</Text>)}
    </VStack>
  )
}

type Row = LegView & Record<string, unknown>

/** The book's legs as the book serves them: the table shown when the analysis cannot be had. */
export function PlainLegTable(props: { readonly view: BookView; actionsFor(key: string): ReactNode }): ReactElement {
  const { view } = props
  const dim = (l: LegView, text: string): ReactElement => <Text size="sm" color={l.matched ? 'primary' : 'secondary'}>{text}</Text>
  const greek = (l: LegView, n: number, digits: number): ReactElement => (
    <Text size="sm" color={l.matched ? 'primary' : 'secondary'} style={l.matched ? sign(n) : undefined}>{l.matched ? signed(n, digits) : '—'}</Text>
  )
  const col = (key: string, header: ReactNode, render: (l: LegView) => ReactElement, numeric = true): TableColumn<Row> => ({
    key, header, ...(numeric ? { align: 'end' as const } : {}), renderCell: (r) => render(r as LegView),
  })
  const columns: TableColumn<Row>[] = [
    col('source', 'Source', (l) => dim(l, l.source === 'odin' ? 'ODIN' : 'manual'), false),
    col('type', 'Type', (l) => dim(l, l.matched ? typeText(l) : `${typeText(l)} · not understood`), false),
    col('expiry', 'Expiry', (l) => dim(l, l.expiry === '' ? '—' : l.expiry), false),
    col('strike', 'Strike', (l) => dim(l, l.strike === null ? '—' : inr(l.strike, 2))),
    col('qty', 'Qty', (l) => dim(l, signed(l.qty))),
    col('lots', 'Lots', (l) => {
      const lots = lotsOf(l.qty, l.lotSize)
      return dim(l, lots === null ? '—' : signed(lots, Number.isInteger(lots) ? 0 : 2))
    }),
    col('avg', 'Avg', (l) => dim(l, inr(l.avgPrice, 2))),
    col('ltp', 'LTP', (l) => dim(l, l.ltp === null ? '—' : inr(l.ltp, 2))),
    col('iv', 'IV %', (l) => dim(l, l.iv === null ? '—' : (l.iv * 100).toFixed(1))),
    col('delta', 'Δ', (l) => greek(l, l.delta, 2)),
    col('gamma', 'Γ', (l) => greek(l, l.gamma, 4)),
    col('vega', 'Vega', (l) => greek(l, l.vega, 2)),
    col('theta', 'Θ', (l) => greek(l, l.theta, 2)),
    col('mtm', <span title={LEG_PNL_TITLE}>Leg P&amp;L</span>, (l) => (
      <Text size="sm" color={l.matched ? 'primary' : 'secondary'} style={l.matched && l.mtm !== null ? sign(l.mtm) : undefined}>
        {l.matched ? money(l.mtm) : '—'}
      </Text>
    )),
    { key: 'actions', header: '', width: pixel(150), renderCell: (r) => props.actionsFor((r as LegView).key) ?? <span /> },
  ]
  if (view.legs.length === 0) return <Text color="secondary">No legs in this book.</Text>
  return <TradersTable data={view.legs as unknown as Row[]} columns={columns} density="compact" hasHover />
}
