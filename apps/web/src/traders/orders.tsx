/**
 * The Orders page: the day's ODIN orders and trades and ODIN's message log.
 * Read-only history of what the trader did elsewhere — nothing here sends,
 * changes or withdraws anything.
 */

import { useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Banner } from '@astryxdesign/core/Banner'
import { BellAlert } from './bell.tsx'
import { Selector } from '@astryxdesign/core/Selector'
import { DateInput } from '@astryxdesign/core/DateInput'
import type { ISODateString } from '@astryxdesign/core/Calendar'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import { inr } from '../format.ts'
import type { TraderOrder, TraderTrade, LogLine } from '../../../traders/src/types.ts'
import { tapi } from './api.ts'
import { usePoll } from './hooks.ts'
import { istDay, istHms } from './wire.ts'
import { TradersTable, type TradersColumn } from './table.tsx'

const ORDERS_POLL_MS = 30_000
const ALL = '__all__'

type Tab3 = 'orders' | 'trades' | 'log'

/** `by`: the row's raw value the column sorts by. */
function col<R>(key: string, header: string, render: (r: R) => string, numeric: boolean, by: (r: R) => number | string | null): TradersColumn<R & Record<string, unknown>> {
  return {
    key, header, ...(numeric ? { align: 'end' as const } : {}),
    renderCell: (r) => <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{render(r as R)}</Text>,
    sortValue: (r) => by(r as R),
  }
}

const ORDER_COLUMNS = [
  col<TraderOrder>('time', 'Time', (o) => istHms(o.time), false, (o) => o.time),
  col<TraderOrder>('stock', 'Stock', (o) => o.stock, false, (o) => o.stock),
  col<TraderOrder>('status', 'Status', (o) => o.status, false, (o) => o.status),
  col<TraderOrder>('side', 'Side', (o) => o.side, false, (o) => o.side),
  col<TraderOrder>('qty', 'Qty', (o) => inr(o.qty), true, (o) => o.qty),
  col<TraderOrder>('filled', 'Filled', (o) => (o.filledQty === null ? '—' : inr(o.filledQty)), true, (o) => o.filledQty),
  col<TraderOrder>('price', 'Price', (o) => inr(o.price, 2), true, (o) => o.price),
  col<TraderOrder>('reason', 'Reason', (o) => (o.reason === '' ? '' : o.reason), false, (o) => o.reason),
]

const TRADE_COLUMNS = [
  col<TraderTrade>('time', 'Time', (t) => istHms(t.time), false, (t) => t.time),
  col<TraderTrade>('stock', 'Stock', (t) => t.stock, false, (t) => t.stock),
  col<TraderTrade>('tradeNo', 'Trade no', (t) => t.tradeNo, false, (t) => t.tradeNo),
  col<TraderTrade>('side', 'Side', (t) => t.side, false, (t) => t.side),
  col<TraderTrade>('qty', 'Qty', (t) => inr(t.qty), true, (t) => t.qty),
  col<TraderTrade>('price', 'Price', (t) => inr(t.price, 2), true, (t) => t.price),
]

const LOG_COLUMNS = [
  col<LogLine>('time', 'Time', (l) => istHms(l.time), false, (l) => l.time),
  col<LogLine>('text', 'Message', (l) => l.text, false, (l) => l.text),
]

function Rows<R>(props: {
  data: R[] | null
  error: string | null
  columns: TradersColumn<R & Record<string, unknown>>[]
  empty: string
}): React.ReactElement {
  const { data, error } = props
  if (data === null) {
    return error === null
      ? <Text color="secondary">Loading…</Text>
      : <Banner status="error" title={`Could not load: ${error}`} />
  }
  return (
    <VStack gap={2}>
      <BellAlert text={error === null ? null : `Refresh failed: ${error}`} />
      {data.length === 0
        ? <Text color="secondary">{props.empty}</Text>
        : <TradersTable data={data as (R & Record<string, unknown>)[]} columns={props.columns} density="compact" hasHover />}
    </VStack>
  )
}

export function OrdersPage(): React.ReactElement {
  const [tab, setTab] = useState<Tab3>('orders')
  const [day, setDay] = useState(() => istDay(Date.now()))
  const [stock, setStock] = useState<string>(ALL)
  const books = usePoll(() => tapi.books(), ORDERS_POLL_MS, [])
  const filter = stock === ALL ? undefined : stock
  const q = { day, ...(filter === undefined ? {} : { stock: filter }) }

  const orders = usePoll(() => (tab === 'orders' ? tapi.orders(q) : Promise.resolve(null)), ORDERS_POLL_MS, [tab, day, stock])
  const trades = usePoll(() => (tab === 'trades' ? tapi.trades(q) : Promise.resolve(null)), ORDERS_POLL_MS, [tab, day, stock])
  const log = usePoll(() => (tab === 'log' ? tapi.log({ day }) : Promise.resolve(null)), ORDERS_POLL_MS, [tab, day])

  const options = [{ value: ALL, label: 'All stocks' }, ...(books.data ?? []).map((b) => ({ value: b.stock, label: b.stock }))]

  return (
    <VStack gap={3}>
      <HStack gap={3} align="end" wrap="wrap">
        <DateInput
          label="Day"
          value={day as ISODateString}
          onChange={(v) => { if (v !== undefined) setDay(v) }}
          width={165}
        />
        {tab === 'log' ? null : (
          <Selector label="Stock" options={options} value={stock} onChange={(v) => setStock(v === '' ? ALL : v)} width={200} />
        )}
      </HStack>
      <TabList role="tablist" aria-label="Orders" value={tab} onChange={(v) => setTab(v as Tab3)} layout="hug" hasDivider>
        <Tab role="tab" aria-selected={tab === 'orders'} value="orders" label="Orders" />
        <Tab role="tab" aria-selected={tab === 'trades'} value="trades" label="Trades" />
        <Tab role="tab" aria-selected={tab === 'log'} value="log" label="Log" />
      </TabList>
      {tab === 'orders' ? <Rows data={orders.data} error={orders.error} columns={ORDER_COLUMNS} empty="No orders for this day" /> : null}
      {tab === 'trades' ? <Rows data={trades.data} error={trades.error} columns={TRADE_COLUMNS} empty="No trades for this day" /> : null}
      {tab === 'log' ? (
        <Rows data={log.data} error={log.error} columns={LOG_COLUMNS} empty="ODIN's message log is not in its OnLineBackup files" />
      ) : null}
    </VStack>
  )
}
