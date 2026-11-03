/**
 * The Reports page's day order log: one row per ORDER, grouped by the step
 * that placed it, one table per book. See `report-orders.ts` for the why and
 * the building; this file is only how it reads.
 *
 * A day reads top to bottom as what the book did:
 *
 *   09:33:03  Open         NIFTY 22650 CE  Buy   2  74.60  Filled
 *                          NIFTY 22800 CE  Sell  2  25.60  Filled
 *   09:55:48  Add          NIFTY 22700 CE  Sell  2  58.90  Filled
 *   14:50:02  EOD flatten  ...
 *
 * The time and the step are printed on a step's FIRST row only, so the legs of
 * one package read as one block. The supervisor's sentence for the step is its
 * tooltip. The lifecycle — every journal event — is one click away on each
 * row, through the same per-event table the strategy page's dialog uses.
 */

import { useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Switch } from '@astryxdesign/core/Switch'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Table, proportional, pixel } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import { inr, spansDays, NOWRAP, RED, type OrderEvent } from './api.ts'
import { formatContract } from './contract.ts'
import { eventColumns } from './orderlog.tsx'
import {
  buildOrderLog, countsLine, istClock, lotsText,
  type OrderStatusWord, type ReportOrder, type ReportStep,
} from './report-orders.ts'

const STATUS_VARIANT: Readonly<Record<OrderStatusWord, 'success' | 'warning' | 'error' | 'neutral' | 'info'>> = {
  Filled: 'success',
  Partial: 'warning',
  Rejected: 'error',
  Cancelled: 'neutral',
  Working: 'info',
}

/** One table row: an order, and whether it opens its step. */
type Row = ReportOrder & { readonly step: ReportStep; readonly first: boolean } & Record<string, unknown>
type EventRow = OrderEvent & Record<string, unknown>

function rowsOf(steps: readonly ReportStep[]): Row[] {
  return steps.flatMap((step) =>
    step.orders.map((o, i) => ({ ...o, step, first: i === 0 }) as Row),
  )
}

export function ReportOrderLog(props: { events: readonly OrderEvent[] }): React.ReactElement {
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [open, setOpen] = useState<ReportOrder | null>(null)
  const log = buildOrderLog(props.events, { problemsOnly })
  const whole = problemsOnly ? buildOrderLog(props.events) : log

  const columns: TableColumn<Row>[] = [
    { key: 'ts', header: 'Time', width: pixel(90),
      renderCell: (r) => (r.first
        ? <Text size="sm" color="secondary" style={NOWRAP}>{istClock(r.step.ts)}</Text>
        : null) },
    { key: 'step', header: 'Step', width: pixel(130),
      renderCell: (r) => {
        if (!r.first) return null
        const label = <Text size="sm" weight="medium" style={NOWRAP}>{r.step.label}</Text>
        return r.step.reason === null ? label : <Tooltip content={r.step.reason}>{label}</Tooltip>
      } },
    { key: 'tradingsymbol', header: 'Contract', width: pixel(150),
      renderCell: (r) => (
        <Text size="sm" style={NOWRAP}>{r.tradingsymbol === '' ? '—' : formatContract(r.tradingsymbol)}</Text>
      ) },
    { key: 'side', header: 'Side', width: pixel(60),
      renderCell: (r) => (r.side === ''
        ? <Text size="sm" color="secondary">—</Text>
        : <Text size="sm">{r.side}</Text>) },
    { key: 'lots', header: 'Lots', align: 'end', width: pixel(80),
      renderCell: (r) => <Text size="sm" style={NOWRAP}>{lotsText(r)}</Text> },
    { key: 'avgPrice', header: 'Avg price', align: 'end', width: pixel(90),
      renderCell: (r) => <Text size="sm">{r.avgPrice === null ? '—' : inr(r.avgPrice, 2)}</Text> },
    { key: 'status', header: 'Status', width: proportional(1),
      renderCell: (r) => (
        <HStack gap={2} align="center" wrap="wrap">
          <Badge variant={STATUS_VARIANT[r.status]} label={r.status} />
          {/* The why, in red only when nothing traded; an order that outlived
              its problem keeps the sentence in the secondary ink. */}
          {r.problem === null ? null : r.status === 'Rejected'
            ? <Text size="sm" style={RED}>{r.problem}</Text>
            : <Text size="sm" color="secondary">{r.problem}</Text>}
        </HStack>
      ) },
    { key: 'events', header: '', align: 'end', width: pixel(52),
      renderCell: (r) => (
        <Button
          variant="ghost"
          size="sm"
          label={`Show all ${r.events.length} events for ${r.id}`}
          tooltip={`${r.events.length} journal events — open every step of this order`}
          onClick={() => setOpen(r)}
        >
          <Text size="sm" color="secondary" style={NOWRAP}>{`${r.events.length} ›`}</Text>
        </Button>
      ) },
  ]

  return (
    <VStack gap={3}>
      <HStack justify="between" align="center" wrap="wrap" gap={2}>
        <div data-testid="order-log-day-summary">
          <Text size="sm" color="secondary">
            {whole.books.length > 1
              ? `${whole.books.length} books · ${countsLine(whole.counts)}`
              : countsLine(whole.counts)}
          </Text>
        </div>
        <Switch label="Problems only" value={problemsOnly} onChange={(v) => setProblemsOnly(v)} />
      </HStack>

      {log.books.length === 0 ? (
        <Text color="secondary">
          {problemsOnly ? 'Every order on this day filled cleanly.' : 'No orders on this day.'}
        </Text>
      ) : null}

      {log.books.map((b) => (
        <VStack key={b.tag} gap={2}>
          {whole.books.length > 1 ? (
            <HStack gap={3} align="center" wrap="wrap">
              <Heading level={4}>{b.tag === '' ? 'Untagged' : b.tag}</Heading>
              <Text size="sm" color="secondary">{countsLine(b.counts)}</Text>
            </HStack>
          ) : null}
          <Text size="sm" color="secondary">
            {b.steps.map((s) => s.label).join(' → ')}
          </Text>
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
            <Table data={rowsOf(b.steps)} columns={columns} density="compact" hasHover />
          </div>
        </VStack>
      ))}

      {open !== null ? (
        <Dialog isOpen onOpenChange={() => setOpen(null)} purpose="form" width={820}>
          <DialogHeader
            title={`${formatContract(open.tradingsymbol)} — every step`}
            onOpenChange={() => setOpen(null)}
          />
          <VStack gap={2} padding={3}>
            {/* The order id is what gets pasted into a ticket; it lives here, not on the row. */}
            <Text size="sm" color="secondary" style={NOWRAP}>{open.id}</Text>
            {open.problem !== null ? <Text size="sm" style={RED}>{open.problem}</Text> : null}
            <Table
              data={open.events as EventRow[]}
              columns={eventColumns(spansDays(open.events.map((e) => e.ts)), false)}
              density="compact"
              hasHover
            />
          </VStack>
        </Dialog>
      ) : null}
    </VStack>
  )
}
