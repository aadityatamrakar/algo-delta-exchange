/**
 * THE DELTA BROKER PAGE — what DELTA holds on one account, not the desk's
 * record of it (operator, 4 Nov: "broker page not showing … do 1, 2 both").
 *
 * The NSE build's Broker page (`broker-view.tsx`) reads the XTS broker's own
 * rows in rupees and stays as it is. This is the DX build's: one read of
 * `GET /v1/desk/broker/delta?rail=` (`apps/api/src/dx-broker.ts`) gives
 *
 *   - MARGIN    available, blocked and the balance, in $ with ₹ beside at the
 *               fixed 85 Delta itself uses (the reply's `inrPerUsd`);
 *   - POSITIONS Delta's `/v2/positions`, the read the positions check uses;
 *   - OPEN      what rests on Delta now — the protective stops included;
 *   - FILLS     the newest 50 executions;
 *   - RECENT    the newest 50 closed or cancelled orders.
 *
 * IT FOLLOWS THE SWITCH. LIVE shows the production account, PAPER the demo
 * (testnet) one, and the heading names which — the confusion the NSE page's
 * comment in `shell.tsx` warns about (a live book under a PAPER badge) cannot
 * happen here.
 *
 * READ-ONLY, ON PURPOSE. No cancel: on this account the open orders are mostly
 * the backstops that protect short legs, and a button beside each would be one
 * mis-click from an unprotected short.
 *
 * EVERY LIST SAYS WHAT IT IS. Absent (with the reason), failed (with Delta's
 * error), stale (rows kept, with their age), or "Delta reports none" — an
 * empty table is never left to read as "nothing held" when nothing was read.
 */
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Table, proportional, pixel } from '@astryxdesign/core/Table'
import type { ColumnWidth, TableColumn } from '@astryxdesign/core/Table'
import {
  ago,
  api,
  localDayTime,
  NOWRAP,
  type AccountMargin,
  type DeskMode,
  type DxBrokerFill,
  type DxBrokerOrder,
  type DxBrokerPosition,
  type DxBrokerSection,
  type DxBrokerView,
} from './api.ts'
import { cash, signed, inr } from './format.ts'
import { usdWithInr } from './margin.tsx'
import { usePoll } from './shell.tsx'
import { DX } from './venue.ts'

/** The gateway reads every 30 s; 15 s keeps the page within one read of it. */
export const DX_BROKER_POLL_MS = 15_000

const NONE = '—'

// -------------------------------------------------------------- formatting

/** BTC, signed — `-0.08`. Always DX's digits, whatever the build's default venue. */
function btcSigned(n: number | null): string {
  return n === null ? NONE : signed(n, 0, DX)
}

function btc(n: number | null): string {
  return n === null ? NONE : inr(n, 0, DX)
}

/** Dollars, two places: `$833.60`. Null is "no price", never `$0.00`. */
function usd(n: number | null): string {
  return n === null ? NONE : cash(n, DX)
}

function when(ms: number | null): string {
  return ms === null ? NONE : localDayTime(ms)
}

function sideLabel(s: string): string {
  return s === 'buy' ? 'Buy' : s === 'sell' ? 'Sell' : s === '' ? NONE : s
}

const KIND: Readonly<Record<string, string>> = { stop: 'Stop', 'take-profit': 'Take-profit', limit: 'Limit', market: 'Market' }

export function kindLabel(o: Pick<DxBrokerOrder, 'kind' | 'reduceOnly'>): string {
  const k = KIND[o.kind] ?? (o.kind === '' ? NONE : o.kind)
  return o.reduceOnly ? `${k} · reduce-only` : k
}

/** Delta's state in the operator's words: an untriggered stop, a fill, a cancel. */
export function stateLabel(o: Pick<DxBrokerOrder, 'state' | 'qty' | 'filledQty'>): string {
  const filled = o.filledQty ?? 0
  switch (o.state) {
    case 'pending':
      return 'untriggered'
    case 'open':
      return filled > 0 ? 'part filled' : 'open'
    case 'closed':
      return o.qty !== null && o.filledQty !== null && o.filledQty >= o.qty ? 'filled' : 'closed'
    case 'cancelled':
      return filled > 0 ? 'cancelled, part filled' : 'cancelled'
    default:
      return o.state === '' ? NONE : o.state
  }
}

/** `0.08`, or `0.03 / 0.08` while part of it is still to fill. */
function orderQty(o: DxBrokerOrder): string {
  if (o.qty === null) return btc(o.filledQty)
  if (o.filledQty === null || o.filledQty === 0 || o.filledQty === o.qty) return btc(o.qty)
  return `${btc(o.filledQty)} / ${btc(o.qty)}`
}

// ----------------------------------------------------------------- columns

type Row = Record<string, unknown>

interface Col<R> {
  readonly key: string
  readonly header: string
  readonly width: ColumnWidth
  readonly numeric?: boolean
  readonly cell: (r: R) => string
  readonly title?: (r: R) => string | undefined
}

const NUM_CELL = { ...NOWRAP, fontVariantNumeric: 'tabular-nums' } as const

/** Built ONCE, at module load: a new column array per poll rebuilds every row. */
function columnsOf<R>(cols: readonly Col<R>[]): TableColumn<Row>[] {
  return cols.map((c) => ({
    key: c.key,
    header: c.header,
    width: c.width,
    ...(c.numeric === true ? { align: 'end' as const } : {}),
    renderCell: (raw: Row) => {
      const r = raw as unknown as R
      const body = <Text size="sm" style={c.numeric === true ? NUM_CELL : NOWRAP}>{c.cell(r)}</Text>
      const hover = c.title?.(r)
      return hover === undefined ? body : <span title={hover}>{body}</span>
    },
  }))
}

const SYMBOL_WIDTH = proportional(1, { minWidth: 170 })

const POSITION_COLUMNS = columnsOf<DxBrokerPosition>([
  { key: 'symbol', header: 'Contract', width: SYMBOL_WIDTH, cell: (p) => p.symbol },
  { key: 'side', header: 'Side', width: pixel(70), cell: (p) => (p.netQty === null ? NONE : p.netQty < 0 ? 'Short' : p.netQty > 0 ? 'Long' : 'Flat') },
  { key: 'qty', header: 'Qty (BTC)', width: pixel(100), numeric: true, cell: (p) => btcSigned(p.netQty) },
  { key: 'avg', header: 'Avg price', width: pixel(110), numeric: true, cell: (p) => usd(p.avgPrice) },
])

const OPEN_COLUMNS = columnsOf<DxBrokerOrder>([
  { key: 'symbol', header: 'Contract', width: SYMBOL_WIDTH, cell: (o) => o.symbol },
  { key: 'side', header: 'Side', width: pixel(56), cell: (o) => sideLabel(o.side) },
  { key: 'kind', header: 'Type', width: pixel(150), cell: kindLabel },
  { key: 'qty', header: 'Qty', width: pixel(90), numeric: true, cell: orderQty },
  { key: 'trigger', header: 'Trigger', width: pixel(100), numeric: true, cell: (o) => usd(o.stopPrice) },
  { key: 'limit', header: 'Limit', width: pixel(100), numeric: true, cell: (o) => usd(o.limitPrice) },
  { key: 'state', header: 'State', width: pixel(100), cell: stateLabel },
  { key: 'at', header: 'Placed', width: pixel(120), cell: (o) => when(o.createdAt) },
])

const FILL_COLUMNS = columnsOf<DxBrokerFill>([
  { key: 'at', header: 'Time', width: pixel(120), cell: (f) => when(f.at) },
  { key: 'symbol', header: 'Contract', width: SYMBOL_WIDTH, cell: (f) => f.symbol },
  { key: 'side', header: 'Side', width: pixel(56), cell: (f) => sideLabel(f.side) },
  { key: 'qty', header: 'Qty', width: pixel(80), numeric: true, cell: (f) => btc(f.qty) },
  { key: 'price', header: 'Price', width: pixel(100), numeric: true, cell: (f) => usd(f.price) },
  { key: 'fee', header: 'Fee', width: pixel(80), numeric: true, cell: (f) => usd(f.commission) },
  { key: 'role', header: 'Role', width: pixel(70), cell: (f) => f.role ?? NONE },
])

const RECENT_COLUMNS = columnsOf<DxBrokerOrder>([
  { key: 'at', header: 'Placed', width: pixel(120), cell: (o) => when(o.createdAt) },
  { key: 'symbol', header: 'Contract', width: SYMBOL_WIDTH, cell: (o) => o.symbol },
  { key: 'side', header: 'Side', width: pixel(56), cell: (o) => sideLabel(o.side) },
  { key: 'kind', header: 'Type', width: pixel(150), cell: kindLabel },
  { key: 'qty', header: 'Filled / qty', width: pixel(110), numeric: true,
    cell: (o) => (o.qty === null ? btc(o.filledQty) : `${btc(o.filledQty ?? 0)} / ${btc(o.qty)}`) },
  { key: 'avg', header: 'Avg fill', width: pixel(100), numeric: true, cell: (o) => usd(o.avgFillPrice) },
  { key: 'state', header: 'State', width: pixel(150), cell: stateLabel,
    title: (o) => (o.cancellationReason === null ? undefined : `Delta: ${o.cancellationReason}`) },
])

// ---------------------------------------------------------------- sections

/**
 * One list, with what it IS above it: the reason it is absent, Delta's error,
 * its age when stale, or "none" when Delta answered with an empty list.
 */
function Section<T>(props: {
  readonly title: string
  readonly label: string
  readonly section: DxBrokerSection<T> | undefined
  readonly columns: TableColumn<Row>[]
  readonly empty: string
  readonly caption?: string
}): React.ReactElement {
  const s = props.section
  const rows = Array.isArray(s?.rows) ? s.rows : []
  return (
    <Card role="group" aria-label={props.label}>
      <VStack gap={1}>
        <HStack gap={1} align="center">
          <Heading level={3}>{props.title}</Heading>
          {s?.state === 'ok' || s?.state === 'stale' ? <Badge label={String(rows.length)} /> : null}
        </HStack>
        {props.caption === undefined ? null : <Text size="xsm" color="secondary">{props.caption}</Text>}
        {s === undefined ? (
          <Text size="sm" color="secondary">Not in the reply — the api may be a deploy behind.</Text>
        ) : s.state === 'absent' ? (
          <Banner status="info" title="Not read" description={s.reason} />
        ) : s.state === 'failed' ? (
          <Banner status="error" title="Delta's reply did not come back — this list is unknown" description={s.error} />
        ) : (
          <>
            {s.state === 'stale' ? (
              <Text size="sm" color="secondary">{`stale — read ${ago(s.ageMs)}; treat as history, not as current`}</Text>
            ) : null}
            {rows.length === 0 ? (
              <Text size="sm" color="secondary">{props.empty}</Text>
            ) : (
              <Table data={rows as unknown as Row[]} columns={props.columns} density="compact" hasHover />
            )}
          </>
        )}
      </VStack>
    </Card>
  )
}

function pct(n: number | null): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)}%` : NONE
}

/** Available, blocked, balance — $ with ₹ at Delta's fixed rate. */
function MarginLine(props: { readonly margin: AccountMargin | undefined; readonly rate: number }): React.ReactElement {
  const m = props.margin
  const figures = m !== undefined && (m.state === 'ok' || m.state === 'stale')
  return (
    <Card padding={3} role="group" aria-label="Delta margin">
      <HStack gap={4} align="center" wrap="wrap">
        <Heading level={3}>Margin</Heading>
        {m === undefined ? (
          <Text size="sm" color="secondary">Not in the reply — the api may be a deploy behind.</Text>
        ) : !figures ? (
          <Text size="sm" color="secondary">{m.state === 'failed' ? `Delta's wallet read failed: ${m.error}` : m.reason}</Text>
        ) : (
          <>
            <Text size="sm" weight="bold">{`Available ${usdWithInr(m.available, props.rate)}`}</Text>
            <Text size="sm" weight="bold">{`Blocked ${usdWithInr(m.used, props.rate)}`}</Text>
            <Text size="sm" color="secondary">{`Balance ${usdWithInr(m.balance, props.rate)}`}</Text>
            <Text size="sm" color="secondary">{`${pct(m.utilizedPct)} used`}</Text>
            {m.state === 'stale' ? <Badge variant="warning" label={`stale, ${ago(m.ageMs)}`} /> : null}
          </>
        )}
      </HStack>
    </Card>
  )
}

// -------------------------------------------------------------------- page

export function DxBrokerPage(props: { readonly mode: DeskMode }): React.ReactElement {
  const rail = props.mode === 'live' ? 'live' : 'demo'
  const { data, error } = usePoll<DxBrokerView>(() => api.dxBroker(rail), DX_BROKER_POLL_MS, [rail])
  const account = rail === 'live' ? 'Delta live account' : 'Delta testnet (demo) account'

  return (
    <VStack gap={2}>
      <HStack gap={1} align="center" wrap="wrap">
        <Heading level={2}>Broker</Heading>
        <Badge variant={rail === 'live' ? 'error' : 'neutral'} label={rail === 'live' ? 'LIVE' : 'DEMO'} />
      </HStack>
      <Text size="sm" color="secondary">
        {`${account}${data?.host ? ` · ${data.host}` : ''}`}
      </Text>
      <Text size="sm" color="secondary">
        What Delta holds, not the desk's record of it — where they disagree, Delta is right. Read-only.
      </Text>

      {error !== null ? <Banner status="error" title="Could not load the broker view" description={error} /> : null}
      {data === null && error === null ? <Text size="sm" color="secondary">Reading Delta's book…</Text> : null}

      {data === null ? null : (
        <>
          <MarginLine margin={data.margin} rate={typeof data.inrPerUsd === 'number' ? data.inrPerUsd : DX.inrPerUnit} />
          <div className="broker-grid">
            <div className="broker-grid-positions">
              <Section
                title="Positions"
                label="Delta positions"
                section={data.positions}
                columns={POSITION_COLUMNS}
                empty="Delta reports no open positions."
              />
            </div>
            <div className="broker-grid-side">
              <Section
                title="Open orders"
                label="Delta open orders"
                section={data.openOrders}
                columns={OPEN_COLUMNS}
                empty="Delta reports no open orders."
                caption="Resting now — the protective stops included."
              />
              <Section
                title="Fills"
                label="Delta fills"
                section={data.fills}
                columns={FILL_COLUMNS}
                empty="Delta reports no fills."
                caption="The newest 50 executions."
              />
            </div>
          </div>
          <Section
            title="Recent orders"
            label="Delta recent orders"
            section={data.recentOrders}
            columns={RECENT_COLUMNS}
            empty="Delta reports no closed or cancelled orders."
            caption="The newest 50 closed or cancelled."
          />
        </>
      )}
    </VStack>
  )
}
