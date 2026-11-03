/**
 * The data status panel on the Admin page: for each trader and each of the last trading days, did their data arrive —
 * a grid of "✓ n trades" (files came), "—" (no files, and nobody traded) or "⚠" (no files while another trader had
 * trade lines: their watcher or PC was down, their books for the day are short) — and the watcher line under it.
 *
 * Files are counted by the day the trader's PC wrote them, the server says so in its notes. The cell's tooltip has
 * the counts: files, trade lines, order rows, rejected orders. Read only.
 */

import type { ReactElement } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { RED } from '../format.ts'
import type { DataStatusDay, DataStatusTrader, DataStatusView } from '../../../traders/src/analytics/daily-wire.ts'
import { tapi } from './api.ts'
import { BellAlert } from './bell.tsx'
import { Caveats } from './caveats.tsx'
import { useDocumentVisible, usePoll } from './hooks.ts'
import { TradersTable, type TradersColumn } from './table.tsx'
import { istDay, istHm } from './wire.ts'

export const DATA_STATUS_POLL_MS = 60_000
export const DATA_STATUS_DAYS = 20

type Row = Record<string, unknown> & { readonly id: string; readonly t: DataStatusTrader }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
/** '2026-10-13' -> '13 Oct'. */
export const shortDay = (day: string): string => `${day.slice(8, 10)} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** What a cell says: the mark, the words, and whether it is the flag. */
export function cellOf(d: DataStatusDay): { readonly mark: '✓' | '—' | '⚠'; readonly text: string } {
  if (d.noFilesWhileOthersTraded) return { mark: '⚠', text: 'no files' }
  if (d.files === 0 && d.trades === 0) return { mark: '—', text: '' }
  return { mark: '✓', text: plural(d.trades, 'trade') }
}

const detail = (d: DataStatusDay): string =>
  `${shortDay(d.day)}: ${plural(d.files, 'file')} · ${plural(d.trades, 'trade line')} · ${plural(d.orders, 'order row')} · ${d.rejected} rejected`

function Cell(props: { d: DataStatusDay }): ReactElement {
  const { d } = props
  const c = cellOf(d)
  const main = <Text size="sm" style={{ whiteSpace: 'nowrap', ...(c.mark === '⚠' ? RED : {}) }}>{c.text === '' ? c.mark : `${c.mark} ${c.text}`}</Text>
  return (
    <VStack gap={0}>
      <Tooltip content={detail(d)}>{main}</Tooltip>
      {d.rejected === 0 ? null : <Text size="sm" style={RED}>{`${d.rejected} rejected`}</Text>}
    </VStack>
  )
}

function columns(days: readonly string[]): TradersColumn<Row>[] {
  return [
    { key: 'trader', header: 'Trader', renderCell: (r) => <Text size="sm" weight="bold">{r.t.trader}</Text>, sortValue: (r) => r.t.trader },
    ...days.map((day, i): TradersColumn<Row> => ({
      key: day, header: shortDay(day),
      renderCell: (r) => { const d = r.t.days[i]; return d === undefined ? <Text size="sm" color="secondary">—</Text> : <Cell d={d} /> },
    })),
  ]
}

/** The watcher's line for one trader: the same 180 s rule as the traders table above. */
export function watcherLine(t: DataStatusTrader): string {
  const w = t.watcher
  if (w.lastHeartbeatAt === null) return `${t.trader}: watcher never connected`
  const last = `last heartbeat ${shortDay(istDay(w.lastHeartbeatAt))} ${istHm(w.lastHeartbeatAt)}`
  return `${t.trader}: ${w.offline ? 'offline' : 'online'} · ${w.version === null ? 'version unknown' : `v${w.version}`} · ${last}`
}

export function DataStatusGrid(props: { view: DataStatusView }): ReactElement {
  const { view } = props
  return (
    <VStack gap={2}>
      <TradersTable
        aria-label="Data status" density="compact" idKey="id" columns={columns(view.days)}
        data={view.traders.map((t): Row => ({ id: t.trader, t }))}
      />
      {view.flags.map((f) => <Text key={f} size="sm" style={RED}>{`⚠ ${f}`}</Text>)}
      {view.traders.map((t) => (
        <Text key={t.trader} size="sm" color="secondary" {...(t.watcher.offline ? { style: RED } : {})}>{watcherLine(t)}</Text>
      ))}
      <Caveats items={view.notes} kind="note" />
    </VStack>
  )
}

export function AdminDataStatus(): ReactElement {
  const visible = useDocumentVisible()
  const status = usePoll(() => tapi.dataStatus(DATA_STATUS_DAYS), DATA_STATUS_POLL_MS, [], visible)
  const v = status.data
  // an older server answers something else (or 404): say so rather than draw a grid of nothing
  const ok = v !== null && Array.isArray(v.days) && Array.isArray(v.traders)
  return (
    <VStack gap={2}>
      {status.error === null ? null : v === null
        ? <BellAlert status="error" inline text={`Could not load the data status: ${status.error}`} />
        : <BellAlert text={`Refresh failed: ${status.error}`} />}
      {v === null ? (status.error === null ? <Text color="secondary">Loading the data status…</Text> : null)
        : !ok ? <Banner status="warning" title="The server did not answer a data status" />
          : v.traders.length === 0 ? <Text color="secondary">No traders yet</Text> : <DataStatusGrid view={v} />}
    </VStack>
  )
}
