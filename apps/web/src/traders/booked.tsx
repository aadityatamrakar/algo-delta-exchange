/**
 * Booked (spec 2026-10-23 G3): what every expiry series of every stock the trader traded has booked — the stocks
 * with no tab too — with its charges and net, over a range of expiry months (the current month and the two before
 * it unless chosen). A series still open adds its open MTM, so its net is the Series P&L block on its tab.
 *
 * The figures count only from the trade history's start, and the page says so in words above the table, not in the
 * folded notes: a stock booked before it is not here at all. An admin picks the trader on the page (the top bar's
 * pick is its default) and sees the desk's roll-up, by trader and month, below; a trader's session never asks for it.
 */

import { useState, type ReactElement } from 'react'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Selector } from '@astryxdesign/core/Selector'
import { Heading, Text } from '@astryxdesign/core/Text'
import { inr, money, sign } from '../format.ts'
import type { AdminBookedView, BookedRow, BookedStatus, BookedTotal, BookedView } from '../../../traders/src/analytics/booked-wire.ts'
import { tapi } from './api.ts'
import { BellAlert } from './bell.tsx'
import { Caveats } from './caveats.tsx'
import { useDocumentVisible, usePoll, useSession } from './hooks.ts'
import { TradersTable, sortByField, type TradersColumn } from './table.tsx'
import { expiryDayLabel, istDay, istHm, maturityLabel } from './wire.ts'

/** A trader's own view: the walk is cached server-side per leg version, so a poll is the open P&L's book reads only. */
export const BOOKED_POLL_MS = 60_000
/** The desk roll-up walks every trader's history when their caches lapse (five minutes): it asks no more often. */
export const ROLLUP_POLL_MS = 5 * 60_000

const STATUS_WORD: Readonly<Record<BookedStatus, string>> = { open: 'Open', closed: 'Closed', settled: 'Settled', unsettled: 'Unsettled' }

type Cells = Record<string, unknown>

/** A row of the series table, or its totals row. */
interface Line extends Cells {
  readonly id: string
  readonly kind: 'row' | 'totals'
  readonly stock: string
  readonly series: string
  readonly booked: number; readonly settled: number; readonly charges: number
  readonly net: number | null; readonly openMtm: number | null
  readonly status: string
  readonly notes: readonly string[]
}

/** '2026-10' → 'Oct 26'. */
export const monthLabel = (month: string): string => maturityLabel(`${month}-01`)

const seriesText = (r: BookedRow): string => (r.kind === 'shares' ? `Shares · ${monthLabel(r.month)}` : expiryDayLabel(r.expiry))

function lines(v: BookedView): Line[] {
  const rows: Line[] = v.rows.map((r) => ({
    id: `${r.stock}|${r.expiry}|${r.month}`, kind: 'row', stock: r.stock, series: seriesText(r),
    booked: r.booked, settled: r.settled, charges: r.charges, net: r.net, openMtm: r.openMtm,
    status: STATUS_WORD[r.status], notes: r.notes,
  }))
  const t = v.total
  return [...rows, {
    id: 'totals', kind: 'totals', stock: `Total (${t.rows} series, ${t.open} open)`, series: '',
    booked: t.booked, settled: t.settled, charges: t.charges, net: t.net, openMtm: t.openMtm, status: '', notes: [],
  }]
}

/** A signed rupee figure, toned by its sign; null is "—", never 0. */
function cash(n: number | null, bold = false): ReactElement {
  if (n === null) return <Text size="sm" color="secondary">—</Text>
  return <Text size="sm" weight={bold ? 'bold' : 'normal'} style={{ whiteSpace: 'nowrap', ...(sign(n) ?? {}) }}>{money(n)}</Text>
}

const weight = (l: { readonly kind: string }): 'bold' | 'normal' => (l.kind === 'row' || l.kind === 'month' ? 'normal' : 'bold')

/**
 * Booked, of which settled, Charges, Net, Open P&L: the same five figures on every table of the page. The open part
 * (the wire's `openMtm`) is Σ GrossMTM of the open legs at net price, which spec G5 names "Open P&L" everywhere.
 */
function figureColumns<R extends Cells & { readonly kind: string; readonly booked: number; readonly settled: number; readonly charges: number; readonly net: number | null; readonly openMtm: number | null }>(): TradersColumn<R>[] {
  return [
    { key: 'booked', header: 'Booked', align: 'end', renderCell: (r) => cash(r.booked, weight(r) === 'bold') },
    { key: 'settled', header: 'of which settled', align: 'end', renderCell: (r) => cash(r.settled) },
    { key: 'charges', header: 'Charges', align: 'end', renderCell: (r) => <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{inr(r.charges)}</Text> },
    { key: 'net', header: 'Net', align: 'end', renderCell: (r) => cash(r.net, true) },
    { key: 'openMtm', header: 'Open P&L', align: 'end', renderCell: (r) => cash(r.openMtm) },
  ]
}

const SERIES_COLUMNS: TradersColumn<Line>[] = sortByField<Line>([
  { key: 'stock', header: 'Stock', renderCell: (l) => <Text size="sm" weight={weight(l)}>{l.stock}</Text> },
  { key: 'series', header: 'Series', renderCell: (l) => <Text size="sm">{l.series}</Text> },
  ...figureColumns<Line>(),
  {
    key: 'status', header: 'Status',
    renderCell: (l) => (
      <VStack gap={0}>
        <Text size="sm">{l.status}</Text>
        {l.notes.map((n) => <Text key={n} size="sm" color="secondary">{n}</Text>)}
      </VStack>
    ),
  },
], ['stock', 'series', 'booked', 'settled', 'charges', 'net', 'openMtm', 'status'])

export function BookedTable(props: { view: BookedView }): ReactElement {
  return (
    <TradersTable aria-label="Booked" data={lines(props.view)} columns={SERIES_COLUMNS} idKey="id" density="compact" keepLast={(l) => l.kind === 'totals'} />
  )
}

// --------------------------------------------------------- months and totals

type MonthLine = Cells & BookedTotal & { readonly id: string; readonly kind: 'month' | 'trader' | 'desk'; readonly label: string }

const MONTH_COLUMNS: TradersColumn<MonthLine>[] = [
  { key: 'label', header: 'Month', renderCell: (l) => <Text size="sm" weight={weight(l)} color={l.kind === 'month' ? 'secondary' : 'primary'}>{l.label}</Text> },
  ...figureColumns<MonthLine>(),
]

function ByMonth(props: { view: BookedView }): ReactElement | null {
  if (props.view.byMonth.length < 2) return null
  return (
    <VStack gap={2}>
      <Heading level={4}>By month</Heading>
      <TradersTable aria-label="Booked by month" density="compact" idKey="id" columns={MONTH_COLUMNS}
        data={props.view.byMonth.map((m) => ({ ...m, id: m.month, kind: 'month' as const, label: monthLabel(m.month) }))} />
    </VStack>
  )
}

/** Every month the choices may need: the trader's own, the shown range, and the year up to the current month. */
export function monthChoices(current: string, ...lists: readonly (readonly string[])[]): string[] {
  const out = new Set<string>(lists.flat())
  let [y, m] = [Number(current.slice(0, 4)), Number(current.slice(5, 7))]
  for (let i = 0; i < 12; i++) {
    out.add(`${y}-${String(m).padStart(2, '0')}`)
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return [...out].sort().reverse()
}

// ------------------------------------------------------------- admin roll-up

const ROLLUP_COLUMNS: TradersColumn<MonthLine>[] = [
  { key: 'label', header: 'Trader', renderCell: (l) => <Text size="sm" weight={weight(l)} color={l.kind === 'month' ? 'secondary' : 'primary'}>{l.label}</Text> },
  ...figureColumns<MonthLine>(),
]

function rollupLines(v: AdminBookedView): MonthLine[] {
  const out: MonthLine[] = []
  for (const t of v.traders) {
    out.push({ ...t.total, id: t.trader, kind: 'trader', label: t.trader })
    for (const m of t.byMonth) out.push({ ...m, id: `${t.trader}|${m.month}`, kind: 'month', label: monthLabel(m.month) })
  }
  out.push({ ...v.total, id: 'desk', kind: 'desk', label: `Desk (${v.traders.length} ${v.traders.length === 1 ? 'trader' : 'traders'})` })
  return out
}

function AdminRollup(props: { from: string; to: string }): ReactElement {
  // the costliest read of the page (every trader's whole history, a minute each): a hidden tab asks for none of it
  const visible = useDocumentVisible()
  const roll = usePoll(() => tapi.adminBooked({ from: props.from, to: props.to }), ROLLUP_POLL_MS, [props.from, props.to], visible)
  const v = roll.data
  if (v === null) {
    return roll.error === null
      ? <Text color="secondary">Loading the desk's booked P&L…</Text>
      : <BellAlert status="error" inline text={`Could not load the desk's booked P&L: ${roll.error}`} />
  }
  return (
    <VStack gap={2}>
      <BellAlert text={roll.error === null ? null : `Refresh failed: ${roll.error}`} />
      <Heading level={4}>{`Desk, ${monthLabel(v.from)} – ${monthLabel(v.to)}`}</Heading>
      <TradersTable aria-label="Booked by trader" density="compact" idKey="id" columns={ROLLUP_COLUMNS} data={rollupLines(v)}
        keepLast={(l) => l.kind === 'desk'} isChild={(l) => l.kind === 'month'} />
      <Caveats items={v.notes} kind="note" />
    </VStack>
  )
}

/** The admin's own pick of the trader on this page: the top bar's by default. */
function TraderPick(props: { value: string | null; onChange: (name: string | null) => void }): ReactElement {
  const traders = usePoll(() => tapi.adminTraders(), BOOKED_POLL_MS, [])
  const names = traders.data?.map((r) => r.username) ?? []
  return (
    <Selector label="Trader" width={200} isLoading={traders.data === null && traders.error === null}
      options={names} value={props.value ?? ''} placeholder="Pick a trader…" onChange={(v) => props.onChange(v === '' ? null : v)} />
  )
}

// --------------------------------------------------------------------- page

/** 'YYYY-MM' moved by `n` months. */
export function addMonths(month: string, n: number): string {
  const k = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n
  return `${String(Math.floor(k / 12)).padStart(4, '0')}-${String((k % 12) + 1).padStart(2, '0')}`
}

/** The server's default, said here so both tables ask for the same months: this month (IST) and the two before. */
export function defaultMonths(nowMs: number): { readonly from: string; readonly to: string } {
  const to = istDay(nowMs).slice(0, 7)
  return { from: addMonths(to, -2), to }
}

export function BookedPage(): ReactElement {
  const session = useSession()
  const admin = session?.role === 'admin'
  const [trader, setTrader] = useState<string | null>(session?.asTrader ?? null)
  const [range, setRange] = useState(() => defaultMonths(Date.now()))
  const visible = useDocumentVisible()
  const pick = admin ? trader : null
  const needsPick = admin && pick === null
  const q = { ...range, ...(pick === null ? {} : { trader: pick }) }
  const booked = usePoll(() => (needsPick ? Promise.resolve(null) : tapi.booked(q)), BOOKED_POLL_MS, [pick, range.from, range.to], visible)
  const v = booked.data
  const { from, to } = range
  const current = istDay(v?.asOf ?? Date.now()).slice(0, 7)
  // the trader's months, the range shown, and the next two expiry months (a series traded early)
  const choices = monthChoices(current, v?.months ?? [], [from, to], [addMonths(current, 1), addMonths(current, 2)])
    .map((m) => ({ value: m, label: monthLabel(m) }))
  const choose = (which: 'from' | 'to', m: string): void => {
    if (m === '') return
    // a range never runs backwards: moving one end past the other moves both
    setRange(which === 'from' ? { from: m, to: m > to ? m : to } : { from: m < from ? m : from, to: m })
  }

  return (
    <VStack gap={3}>
      <HStack gap={3} align="end" wrap="wrap">
        {admin ? <TraderPick value={trader} onChange={setTrader} /> : null}
        <Selector label="From" width={130} options={choices} value={from} onChange={(m) => choose('from', m)} />
        <Selector label="To" width={130} options={choices} value={to} onChange={(m) => choose('to', m)} />
        {v === null ? null : <Text color="secondary" size="sm">{`${v.trader} · as of ${istHm(v.asOf)} IST`}</Text>}
      </HStack>
      {needsPick ? <Text color="secondary">Pick a trader to see their booked P&L</Text> : booked.error === null ? null : (
        v === null
          ? <BellAlert status="error" inline text={`Could not load the booked P&L: ${booked.error}`} />
          : <BellAlert text={`Refresh failed: ${booked.error}`} />
      )}
      {v === null ? (booked.error === null && !needsPick ? <Text color="secondary">Loading the booked P&L…</Text> : null) : (
        <>
          <Text size="sm" color="secondary">
            {v.historyStart === null
              ? 'No trade history yet: the figures start with the first ODIN trade file.'
              : `Figures count from ${expiryDayLabel(v.historyStart)}: the trade history starts there; nothing before it is in them.`}
          </Text>
          {v.rows.length === 0 ? <Text color="secondary">Nothing booked in these months.</Text> : null}
          <BookedTable view={v} />
          <Caveats items={v.notes} kind="note" />
          <ByMonth view={v} />
        </>
      )}
      {admin ? <AdminRollup from={from} to={to} /> : null}
    </VStack>
  )
}
