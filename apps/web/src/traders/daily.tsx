/**
 * The Daily page: what each book looked like at the close, one trading day after another. The server writes a row
 * per book at 15:45 IST from the figures the other pages show (Today, P&L, the greeks, the margin) and keeps it,
 * because a past day cannot be rebuilt: its prices are gone. A day is a bold row of the books' totals; its books sit
 * under it (the Books switch). The stored rows keep their other figures; the page shows Today and P&L only.
 *
 * A figure the page could not give then is "—", never 0, and a day's total is "—" as soon as one book's is; the
 * line under the day names those books. Delta is shown as money in the day's row (Σ delta × spot): shares of
 * different underlyings do not add. An admin picks the trader here, as the sidebar does.
 */

import { useState, type ReactElement } from 'react'
import { Selector } from '@astryxdesign/core/Selector'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Switch } from '@astryxdesign/core/Switch'
import { Text } from '@astryxdesign/core/Text'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { inr, sign, signed } from '../format.ts'
import type { DailyDay, DailyView } from '../../../traders/src/analytics/daily-wire.ts'
import { tapi } from './api.ts'
import { BellAlert } from './bell.tsx'
import { Caveats } from './caveats.tsx'
import { useDocumentVisible, usePoll, useSession } from './hooks.ts'
import { TradersTable, sortByField, type TradersColumn } from './table.tsx'

/** The record changes once a day: a light poll keeps a page left open fresh through the 15:45 write. */
export const DAILY_POLL_MS = 5 * 60_000
export const DAILY_DAYS = 30
const TRADERS_POLL_MS = 60_000

type Cells = Record<string, unknown>

interface Line extends Cells {
  readonly id: string
  readonly kind: 'day' | 'book'
  readonly label: string
  /** ISO day, what the label column sorts by. */
  readonly sortDay: string
  /** Under a day's label: which books its totals are missing. */
  readonly notes: readonly string[]
  /** Today (`dayMtm`) and P&L (`seriesNet`). */
  readonly dayMtm: number | null; readonly seriesNet: number | null
  readonly delta: number | null; readonly deltaNote: string | null
  readonly gamma: number | null; readonly vega: number | null; readonly theta: number | null
  readonly margin: number | null; readonly marginSource: string | null
  readonly legs: number; readonly warnings: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** '2026-10-19' -> 'Mon 19 Oct 2026'. */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1]
  if (m === null || month === undefined) return day
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? ''
  return `${weekday} ${m[3]} ${month} ${m[1]}`
}

const missingNote = (what: string, stocks: readonly string[]): string[] => (stocks.length === 0 ? [] : [`${what} unknown for ${stocks.join(', ')}`])

function dayNotes(d: DailyDay): string[] {
  const m = d.totals.missing
  return [
    ...missingNote('Today', m.dayMtm), ...missingNote('P&L', m.series),
    ...(m.spot.length === 0 ? [] : [`delta value unknown for ${m.spot.join(', ')} (no spot)`]),
    ...(m.margin.length === 0 ? [] : [`margin missing: ${m.margin.join(', ')}`]),
  ]
}

export function lines(view: DailyView, books: boolean): Line[] {
  const out: Line[] = []
  for (const d of view.days) {
    const t = d.totals
    out.push({
      id: d.day, kind: 'day', label: dayLabel(d.day), sortDay: d.day, notes: dayNotes(d),
      dayMtm: t.dayMtm, seriesNet: t.seriesNet,
      delta: t.deltaValue, deltaNote: 'delta value', gamma: null, vega: t.vega, theta: t.theta,
      margin: t.margin, marginSource: null, legs: t.legs, warnings: t.warnings,
    })
    if (!books) continue
    for (const b of d.books) {
      out.push({
        id: `${d.day}|${b.stock}`, kind: 'book', label: b.stock, sortDay: d.day, notes: [],
        dayMtm: b.dayMtm, seriesNet: b.seriesNet,
        delta: b.delta, deltaNote: null, gamma: b.gamma, vega: b.vega, theta: b.theta,
        margin: b.margin, marginSource: b.marginSource, legs: b.legs, warnings: b.warnings,
      })
    }
  }
  return out
}

function figure(n: number | null, digits: number): ReactElement {
  if (n === null) return <Text size="sm" color="secondary">—</Text>
  return <Text size="sm" style={{ whiteSpace: 'nowrap', ...sign(n) }}>{signed(n, digits)}</Text>
}

const weight = (l: Line): 'bold' | 'normal' => (l.kind === 'day' ? 'bold' : 'normal')

const COLUMNS: TradersColumn<Line>[] = [...sortByField<Line>([
  {
    key: 'label', header: 'Day / book',
    renderCell: (l) => (
      <VStack gap={0}>
        <Text size="sm" weight={weight(l)} color={l.kind === 'book' ? 'secondary' : 'primary'}>{l.label}</Text>
        {l.notes.map((n) => <Text key={n} size="sm" color="secondary">{n}</Text>)}
      </VStack>
    ),
  },
  { key: 'dayMtm', header: 'Today', align: 'end', renderCell: (l) => figure(l.dayMtm, 0) },
  { key: 'seriesNet', header: 'P&L', align: 'end', renderCell: (l) => figure(l.seriesNet, 0) },
  {
    key: 'delta', header: 'Delta', align: 'end',
    renderCell: (l) => (
      <VStack gap={0} align="end">
        {figure(l.delta, 0)}
        {l.deltaNote === null ? null : <Text size="sm" color="secondary">{l.deltaNote}</Text>}
      </VStack>
    ),
  },
  { key: 'gamma', header: 'Gamma', align: 'end', renderCell: (l) => figure(l.gamma, 4) },
  { key: 'vega', header: 'Vega', align: 'end', renderCell: (l) => figure(l.vega, 0) },
  { key: 'theta', header: 'Theta', align: 'end', renderCell: (l) => figure(l.theta, 0) },
  {
    key: 'margin', header: 'Margin', align: 'end',
    renderCell: (l) => {
      const n = l.margin === null
        ? <Text size="sm" color="secondary">—</Text>
        : <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{inr(l.margin)}</Text>
      return l.marginSource === null ? n : <Tooltip content={l.marginSource}>{n}</Tooltip>
    },
  },
  { key: 'legs', header: 'Legs', align: 'end', renderCell: (l) => <Text size="sm">{l.legs}</Text> },
  {
    key: 'warnings', header: 'Caveats', align: 'end',
    renderCell: (l) => (l.warnings === 0 ? null : <Text size="sm" color="secondary">{`⚠ ${l.warnings}`}</Text>),
  },
], ['dayMtm', 'seriesNet', 'delta', 'gamma', 'vega', 'theta', 'margin', 'legs', 'warnings']).map((c) =>
  (c.key === 'label' ? { ...c, sortValue: (l: Line) => l.sortDay } : c))]

export function DailyTable(props: { view: DailyView; books: boolean }): ReactElement {
  return (
    <TradersTable
      aria-label="Daily record" data={lines(props.view, props.books)} columns={COLUMNS}
      idKey="id" density="compact" isChild={(l) => l.kind === 'book'}
    />
  )
}

export function DailyPage(): ReactElement {
  const session = useSession()
  const admin = session?.role === 'admin'
  const [books, setBooks] = useState(true)
  const [pick, setPick] = useState<string | null>(session?.asTrader ?? null)
  const visible = useDocumentVisible()
  const traders = usePoll(() => tapi.adminTraders(), TRADERS_POLL_MS, [], admin && visible)
  const trader = admin ? pick : null
  // An admin who has not named a trader gets a prompt, not the server's refusal.
  const needsPick = admin && trader === null
  const record = usePoll(
    () => tapi.daily({ days: DAILY_DAYS, ...(trader === null ? {} : { trader }) }), DAILY_POLL_MS, [trader], visible && !needsPick,
  )
  const v = record.data
  const names = traders.data?.map((r) => r.username) ?? (traders.error === null ? null : [])

  return (
    <VStack gap={3}>
      <HStack gap={3} align="center" wrap="wrap">
        {!admin ? null : (
          <Selector
            label="Trader" isLoading={names === null} options={names ?? []} value={pick ?? ''} placeholder="Pick a trader…"
            onChange={(name) => setPick(name === '' ? null : name)}
          />
        )}
        {v === null ? null : (
          <Text color="secondary" size="sm">
            {v.recordedFrom === null ? `${v.trader} · nothing recorded yet` : `${v.trader} · recorded since ${dayLabel(v.recordedFrom)}`}
          </Text>
        )}
        <Switch label="Books" value={books} onChange={setBooks} />
      </HStack>
      {needsPick ? <Text color="secondary">Pick a trader to see their daily record</Text> : record.error === null ? null : (
        v === null
          ? <BellAlert status="error" inline text={`Could not load the daily record: ${record.error}`} />
          : <BellAlert text={`Refresh failed: ${record.error}`} />
      )}
      {v === null ? (record.error === null && !needsPick ? <Text color="secondary">Loading the daily record…</Text> : null) : (
        <>
          <Caveats items={v.notes} kind="note" />
          {v.days.length === 0
            ? <Text color="secondary">Nothing recorded in the last {DAILY_DAYS} days. A row is written for each book at 15:45 IST on a trading day.</Text>
            : <DailyTable view={v} books={books} />}
        </>
      )}
    </VStack>
  )
}
