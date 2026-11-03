/**
 * The order log, as ONE ROW PER ORDER, with the full lifecycle a click away.
 *
 * THE PROBLEM THIS SOLVES. The journal is written per PHASE and per TRANCHE, so
 * a single 3-lot BHEL order occupied eleven rows on screen: PLANNED, SUBMITTED,
 * PENDING_NEW, then a progressive PARTIALLY_FILLED for each step of the fill —
 * each repeated under a SECOND contract spelling, because the broker echoes its
 * own symbol (`BHEL 25AUG2026 PE 410`) while the routing events carry the Kite
 * packing (`BHEL26AUG410PE`). Twenty-two rows of one order, and answering "what
 * traded, at what price" meant reading them all and doing arithmetic.
 *
 * The collapsing itself is `groupOrders` in `api.ts` — pure, and tested there,
 * because the arithmetic is what makes the single row trustworthy (`filledQty`
 * is CUMULATIVE per tranche, so summing every event double-counts every
 * partial).
 *
 * NOTHING IS THROWN AWAY. Every original event is still on the row, and the
 * trailing button opens them in time order. A caller can also drop back to the
 * flat journal outright (`raw`) — "every submission attempt and its outcome" is
 * exactly what is wanted on the days something went wrong at the broker.
 *
 * ONE COMPONENT, TWO SURFACES ORIGINALLY. The desk-wide Orders page and the
 * per-book log rendered two near-identical column sets that had already drifted
 * (one had a `Phase` column the other had deleted), so they were merged onto
 * this. The Orders page has since been REMOVED (2026-08-16) — it was the same
 * journal a third time, over the per-book log and the Broker tab's day-wise
 * history.
 *
 * WHAT RENDERS THIS NOW: the per-strategy log in `strategies.tsx`, and it
 * passes NEITHER `raw` NOR `showOrderId` — it takes the collapsed one-row-per-
 * order view with no id column, which is the whole point of the collapsing.
 * Both options survive the Orders page's removal on purpose: `raw` is the
 * forensic view and the detail dialog below already renders it, and the id is
 * what gets pasted into a support ticket. They are currently reachable only
 * through that dialog, which is where an operator asks for them.
 */

import { useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Table, proportional, pixel } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import {
  groupOrders, inr, localDayTime, localTime, spansDays, NOWRAP, RED,
  type OrderEvent, type OrderGroup,
} from './api.ts'
import { formatContract } from './contract.ts'

type Row = OrderGroup & Record<string, unknown>
type EventRow = OrderEvent & Record<string, unknown>

/**
 * The quantity a routing event was FOR — never what filled.
 *
 * A SUBMITTED row journals its own tranche's `detail.quantity`; a PLANNED row
 * journals only lots-per-tranche, and the broker's first PENDING_NEW echoes
 * qty 0 — for those two the desk order's stamped `orderQty` (see `OrderEvent`)
 * is the figure. Null when neither survives, which stays an em dash: a figure
 * is never invented for a row that genuinely has none.
 */
function plannedQty(e: OrderEvent): number | null {
  const q = e.detail?.['quantity']
  if (typeof q === 'number' && Number.isFinite(q) && q > 0) return q
  return typeof e.orderQty === 'number' && e.orderQty > 0 ? e.orderQty : null
}

/**
 * THE SENTENCE ON AN EVENT THAT DID NOT FAIL — and why it was invisible.
 *
 * `error` is the journal's ONE free-text field, so an announcement that is not
 * a fault has nowhere else to live: `submit.ts` files its "manual leg added to
 * book X — the supervisor adopts it on its next tick" as a `STATUS`/`ok: true`
 * row with the whole sentence in there. Every render site below then branched
 * on `!ok` before it ever looked at the text, so the one line that says a
 * by-hand leg was ADOPTED — the receipt the Manual Order dialog tells operators
 * to watch for — rendered as a bare `BOOKED` badge and nothing else.
 *
 * So an OK event's text is shown BESIDE its status badge, in the secondary ink:
 * it is news, not a fault, and the red belongs to failures alone.
 */
/**
 * ONLY the statuses whose sentence is NEWS an operator must act on or verify.
 * The routine ones — every reconcile stamping "booked X, broker says X" on
 * every healthy fill — turned the whole log into prose (operator's call
 * 2026-08-18: "we don't want to see if everything is working right"). Those
 * sentences still live in the row's detail dialog; the table shows them only
 * when something was created, lost, or handed back to a human.
 */
const NOTEWORTHY = new Set(['BOOKED', 'NOT BOOKED'])

function noteOf(e: OrderEvent): string {
  if (!e.ok) return ''
  if (!NOTEWORTHY.has(String(e.status ?? ''))) return ''
  return typeof e.error === 'string' && e.error.trim() !== '' ? e.error : ''
}

/**
 * The same sentence for a COLLAPSED row, from whichever event carries it.
 *
 * `OrderGroup.error` is deliberately "the first FAILURE's own sentence"
 * (`groupOrders`), so it is empty on a healthy order — the note has to come off
 * the events. Newest first, so the most recent announcement wins the row.
 */
function groupNote(g: OrderGroup): string {
  for (const e of g.events) {
    const note = noteOf(e)
    if (note !== '') return note
  }
  return ''
}

/**
 * A CAVEAT is shown as ONE WORD on the row, and as its sentence in the dialog.
 *
 * `warning` is the gateway's "this order went out, but…" — today only the
 * freeze-unknown case: no freeze row for the underlying, so the whole size
 * left as one order (spec D5). It is not a failure and must not be red; and
 * it is not a note in the `noteOf` sense either, because the sentence is a
 * paragraph and it holds for EVERY order the book places on that underlying.
 * Printing it per row is what made the SENSEX book page unreadable. So the
 * row gets an `unsplit` badge beside the status, and the sentence waits in
 * the "every step" dialog for whoever wants it.
 */
const hasWarning = (w?: string): w is string => typeof w === 'string' && w.trim() !== ''
const WARNING_BADGE = 'unsplit'

/**
 * The per-EVENT columns — the flat journal, and what the detail dialog shows.
 *
 * Exported so both the dialog and the `raw` ("every event") mode render the
 * identical table rather than two that can drift.
 */
export function eventColumns(dated: boolean, withId: boolean): TableColumn<EventRow>[] {
  return [
    { key: 'ts', header: 'Time', width: pixel(dated ? 150 : 100),
      renderCell: (e) => (
        <Text size="sm" color="secondary" style={NOWRAP}>
          {dated ? localDayTime(e.ts) : localTime(e.ts)}
        </Text>
      ) },
    { key: 'phase', header: 'Phase', width: pixel(110),
      renderCell: (e) => <Text size="sm" color="secondary">{e.phase}</Text> },
    // Shown RAW here, deliberately: this is the forensic view, and the two
    // spellings of one contract are part of what it exists to expose.
    { key: 'tradingsymbol', header: 'Contract', width: pixel(190),
      renderCell: (e) => (
        <Text size="sm" style={NOWRAP}>{e.tradingsymbol === '' ? '—' : e.tradingsymbol}</Text>
      ) },
    { key: 'side', header: 'Side', width: pixel(70),
      renderCell: (e) => (
        e.side === undefined || e.side === ''
          ? <Text size="sm" color="secondary">—</Text>
          : <Badge variant={e.side === 'BUY' ? 'neutral' : 'warning'} label={e.side} />
      ) },
    /*
      WHAT FILLED — OR, ON A ROW WHERE NOTHING HAS, WHAT WAS ASKED.

      The journal writes per phase, and only a fill carries a quantity: every
      PLANNED and SUBMITTED row read `—` and the broker's first PENDING_NEW
      echo read `0`, so the forensic dialog opened on a 2,625-unit order and
      showed an order for nothing (2026-08-18). The intent figure steps in
      exactly when the fill figure is absent or still zero — the Phase cell on
      the same row is what names it PLANNED/SUBMITTED rather than filled, the
      same division of labour the Status column already leans on. A row with
      neither figure keeps its dash; nothing here invents a number.
    */
    { key: 'filledQty', header: 'Qty', align: 'end', width: pixel(80),
      renderCell: (e) => {
        if (typeof e.filledQty === 'number' && e.filledQty > 0) {
          return <Text size="sm" color="secondary">{inr(e.filledQty)}</Text>
        }
        const asked = plannedQty(e)
        if (asked !== null) return <Text size="sm" color="secondary">{inr(asked)}</Text>
        return (
          <Text size="sm" color="secondary">
            {e.filledQty === undefined || e.filledQty === null ? '—' : inr(e.filledQty)}
          </Text>
        )
      } },
    /*
      THE FILL'S OWN PRICE IN THE PRIMARY INK; the order's LIMIT — intent, not
      a trade — in the secondary, on rows that have no fill to price. Muted
      rather than badged for the same reason the Qty cell is: the Phase cell
      already says what the row is, and this column's job is only to stop the
      asked price being invisible while the order works (or after it is
      refused, where "at what price" is half the question).
    */
    { key: 'avgPrice', header: 'Price', align: 'end', width: pixel(80),
      renderCell: (e) => (
        e.avgPrice !== undefined && e.avgPrice !== null
          ? <Text size="sm">{e.avgPrice}</Text>
          : typeof e.limitPrice === 'number'
            ? <Text size="sm" color="secondary">{e.limitPrice}</Text>
            : <Text size="sm" color="secondary">—</Text>
      ) },
    /*
      THE BROKER'S STATUS, AND ONLY WHEN IT ADDS SOMETHING.

      `e.status ?? e.phase` printed the phase a second time on every routing
      event — PLANNED in the Phase column and PLANNED again here — which is the
      duplication the `Phase` column was deleted from the other logs for. A
      routing event has no broker status yet, and saying so with an em-dash is
      the honest version. A REFUSAL always speaks, because its sentence is the
      only thing on the row that can say why nothing traded.
    */
    { key: 'status', header: 'Status', width: proportional(1),
      renderCell: (e) => {
        if (!e.ok) return <Text size="sm" style={RED}>{e.error ?? e.status ?? 'failed'}</Text>
        const note = noteOf(e)
        // A status that only repeats the Phase column says nothing; an em dash
        // is what stands in for it, and a note replaces the dash outright
        // rather than sitting beside one.
        const bare = e.status === undefined || e.status === '' || e.status === e.phase
        if (hasWarning(e.warning)) {
          return (
            <HStack gap={1} align="center" wrap="wrap">
              {bare ? null : <Badge variant="success" label={e.status} />}
              <Badge variant="warning" label={WARNING_BADGE} />
              {note === '' ? null : <Text size="sm" color="secondary">{note}</Text>}
            </HStack>
          )
        }
        if (note === '') {
          return bare
            ? <Text size="sm" color="secondary">—</Text>
            : <Badge variant="success" label={e.status} />
        }
        return (
          <HStack gap={1} align="center" wrap="wrap">
            {bare ? null : <Badge variant="success" label={e.status} />}
            <Text size="sm" color="secondary">{note}</Text>
          </HStack>
        )
      } },
    ...(withId
      ? [{
          key: 'clientOrderId', header: 'Order id', width: pixel(220),
          renderCell: (e: EventRow) => (
            <Text size="sm" color="secondary" style={NOWRAP}>{e.clientOrderId}</Text>
          ),
        }]
      : []),
  ]
}

export function OrderLogTable(props: {
  events: readonly OrderEvent[]
  /** Show every journal row instead of one per order. */
  raw?: boolean
  /** The flat journal shows the id; the per-book log has no room and no need. */
  showOrderId?: boolean
}): React.ReactElement {
  const [open, setOpen] = useState<OrderGroup | null>(null)
  const withId = props.showOrderId === true

  /**
   * THE DAY GOES IN FRONT OF THE TIME exactly when there is more than one day
   * on screen. Asked of the rows actually rendered, not of a configured window:
   * a log opened this morning has nothing to disambiguate, and a bare clock on
   * Friday's row read as this morning's.
   */
  const dated = spansDays(props.events.map((e) => e.ts))

  if (props.raw === true) {
    return (
      <Table
        data={props.events as EventRow[]}
        columns={eventColumns(dated, withId)}
        density="compact"
        hasHover
      />
    )
  }

  const groups = groupOrders(props.events) as Row[]

  const columns: TableColumn<Row>[] = [
    { key: 'ts', header: 'Time', width: pixel(dated ? 150 : 100),
      renderCell: (g) => (
        <Text size="sm" color="secondary" style={NOWRAP}>
          {dated ? localDayTime(g.ts) : localTime(g.ts)}
        </Text>
      ) },
    { key: 'tradingsymbol', header: 'Contract', width: pixel(withId ? 190 : 160),
      renderCell: (g) => (
        <Text weight="medium" style={NOWRAP}>
          {g.tradingsymbol === '' ? '—' : formatContract(g.tradingsymbol)}
        </Text>
      ) },
    { key: 'side', header: 'Side', width: pixel(70),
      renderCell: (g) => (
        g.side === ''
          ? <Text size="sm" color="secondary">—</Text>
          : <Badge variant={g.side === 'BUY' ? 'neutral' : 'warning'} label={g.side} />
      ) },
    // The FINAL quantity, summed across tranches — not the last partial's.
    { key: 'filledQty', header: 'Qty', align: 'end', width: pixel(75),
      renderCell: (g) => (
        <Text size="sm" color="secondary">{g.filledQty === 0 ? '—' : inr(g.filledQty)}</Text>
      ) },
    // Quantity-WEIGHTED across tranches. 1800@100 + 450@130 is 106, not 130.
    { key: 'avgPrice', header: 'Price', align: 'end', width: pixel(75),
      renderCell: (g) => <Text weight="medium">{g.avgPrice === null ? '—' : g.avgPrice}</Text> },
    { key: 'status', header: 'Status', width: proportional(1),
      renderCell: (g) => {
        if (!g.ok) return <Text size="sm" style={RED}>{g.error ?? g.status}</Text>
        const note = groupNote(g)
        if (hasWarning(g.warning)) {
          return (
            <HStack gap={1} align="center" wrap="wrap">
              <Badge variant="success" label={g.status} />
              <Badge variant="warning" label={WARNING_BADGE} />
              {note === '' ? null : <Text size="sm" color="secondary">{note}</Text>}
            </HStack>
          )
        }
        if (note === '') return <Badge variant="success" label={g.status} />
        return (
          <HStack gap={1} align="center" wrap="wrap">
            <Badge variant="success" label={g.status} />
            <Text size="sm" color="secondary">{note}</Text>
          </HStack>
        )
      } },
    ...(withId
      ? [{
          key: 'id', header: 'Order id', width: pixel(220),
          renderCell: (g: Row) => (
            <Text size="sm" color="secondary" style={NOWRAP}>{g.id}</Text>
          ),
        }]
      : []),
    /*
      THE WAY BACK TO THE DETAIL, labelled with what is behind it.

      A bare chevron would say there is more without saying how much; the count
      is the thing that tells an operator whether this order had a clean life or
      eleven steps and a rejection. It is a real button rather than a click
      handler on the row so it is reachable by keyboard and announced as an
      action — the table component has no row-click affordance to make
      accessible anyway.
    */
    /*
      THE COUNT ALONE, NOT "N steps".

      In a half-width card the word pushed this column past what was left and
      the design system squeezed it to about twenty pixels — so the cell read
      "1", "6", "9": the leading digit of a clipped label, which looks like a
      column of meaningless numbers rather than a control. The chevron is what
      says it opens, and it costs four pixels where the word cost forty. The
      full sentence is still the button's accessible name and its tooltip.
    */
    { key: 'events', header: '', align: 'end', width: pixel(52),
      renderCell: (g) => (
        <Button
          variant="ghost"
          size="sm"
          label={`Show all ${g.events.length} events for ${g.id}`}
          tooltip={`${g.events.length} events — open the full order log`}
          onClick={() => setOpen(g)}
        >
          <Text size="sm" color="secondary" style={NOWRAP}>{`${g.events.length} \u203a`}</Text>
        </Button>
      ) },
  ]

  return (
    <>
      <Table data={groups} columns={columns} density="compact" hasHover />
      {open !== null ? (
        <Dialog isOpen onOpenChange={() => setOpen(null)} purpose="form" width={820}>
          <DialogHeader
            title={`${formatContract(open.tradingsymbol)} — every step`}
            onOpenChange={() => setOpen(null)}
          />
          <VStack gap={2} padding={3}>
            {/*
              THE ORDER ID IS THE FIRST THING IN THE DIALOG. It is what gets
              pasted into a broker terminal or a support ticket, and it is the
              only field here that cannot be recovered from anything else on
              screen.
            */}
            <HStack justify="between" align="center" wrap="wrap" gap={2}>
              <Text size="sm" color="secondary" style={NOWRAP}>{open.id}</Text>
              <Text size="sm" color="secondary">
                {open.filledQty === 0
                  ? 'nothing filled'
                  : `${inr(open.filledQty)} filled` +
                    (open.avgPrice === null ? '' : ` @ ${open.avgPrice}`)}
              </Text>
            </HStack>
            {/*
              The failure's sentence in red — or, on an order that did not
              fail, whatever it ANNOUNCED. The BOOKED line is the receipt an
              operator opens this dialog to find, and it used to be reachable
              only by reading the row it is filed under, in a column that
              refused to print it.
            */}
            {!open.ok && open.error !== undefined ? (
              <Text size="sm" style={RED}>{open.error}</Text>
            ) : groupNote(open) !== '' ? (
              <Text size="sm" color="secondary">{groupNote(open)}</Text>
            ) : null}
            {/*
              The caveat's full sentence, which the row reduced to one word.
              This dialog is where an operator asks "why does it say unsplit",
              and the answer names the underlying, the lots, and the sync.
            */}
            {open.ok && hasWarning(open.warning) ? (
              <Text size="sm" color="secondary">{open.warning}</Text>
            ) : null}
            <Table
              data={open.events as EventRow[]}
              columns={eventColumns(dated, false)}
              density="compact"
              hasHover
            />
          </VStack>
        </Dialog>
      ) : null}
    </>
  )
}
