/**
 * The Reports order log as a STORY: book -> step -> order, one row per order.
 *
 * WHY (2026-10-05, the operator: "noisy and messy"). The log rendered the
 * journal as written — one row per PHASE — so a two-leg open on a paper book
 * was fourteen rows: PLANNED, SUBMITTED, ACK, STATUS WORKING, STATUS FILLED,
 * the reconcile's second STATUS FILLED and the fold's FILL, per leg, all
 * within a second, with the broker's status words as the only text. Reading
 * "what did this book do today" meant counting rows by contract.
 *
 * WHAT THIS BUILDS. Orders, collapsed by `groupOrders` (whose fill arithmetic
 * is pinned in `orders.test.tsx` and reused rather than retyped); grouped into
 * the DECISION that placed them (every engine order id is
 * `<decisionId>#<leg>`), labelled with the supervisor's trigger as a short
 * word; grouped into BOOKS; everything oldest first, so a day reads "opened,
 * added, flattened". Every original event stays on its order for the detail
 * dialog — nothing is thrown away.
 *
 * PURE, no React: the tests pin it on fixture events without a DOM.
 */

import { baseOrderId, groupOrders, type OrderEvent, type OrderGroup } from './api.ts'
import { lotsOf } from './venue.ts'

/** The five words an order can end the day as. */
export type OrderStatusWord = 'Filled' | 'Partial' | 'Rejected' | 'Cancelled' | 'Working'

export interface ReportOrder {
  /** The base client order id — the order's identity, tranches included. */
  readonly id: string
  /** When it was PLACED (its first event), not when it last moved. */
  readonly ts: number
  readonly tradingsymbol: string
  readonly side: 'Buy' | 'Sell' | ''
  /** Contract quantity that filled, summed across tranches. */
  readonly filledQty: number
  /** Contract quantity the order asked for, when the journal says. */
  readonly orderedQty: number | null
  /** Contract units per lot, read off the SUBMITTED event. Null when unknown. */
  readonly lotSize: number | null
  /** Quantity-weighted average fill price; null when nothing filled. */
  readonly avgPrice: number | null
  readonly status: OrderStatusWord
  /**
   * The FIRST failure's own sentence, when any event failed — kept even when
   * the order went on to fill (a chase that ran out of reprices, then filled
   * at the deadline), because that is still something the operator should see.
   */
  readonly problem: string | null
  /** Every journal event, newest first, for the detail dialog. */
  readonly events: readonly OrderEvent[]
}

export interface ReportStep {
  /** The decision id, or the order id when the order names no decision. */
  readonly id: string
  readonly ts: number
  /** The raw trigger (`dl-open`), when the supervisor journalled one. */
  readonly trigger: string | null
  /** A short human word: "Open", "Neutralise", "EOD flatten". */
  readonly label: string
  /** The supervisor's own sentence for the decision, when there is one. */
  readonly reason: string | null
  readonly orders: readonly ReportOrder[]
}

export interface OrderCounts {
  readonly orders: number
  readonly filled: number
  readonly partial: number
  readonly rejected: number
  readonly cancelled: number
  readonly working: number
}

export interface ReportBook {
  readonly tag: string
  readonly steps: readonly ReportStep[]
  readonly counts: OrderCounts
}

export interface ReportOrderLog {
  readonly books: readonly ReportBook[]
  readonly counts: OrderCounts
}

/**
 * Triggers as words. Unknown ones fall through as the raw trigger, which is
 * still better than nothing — older journals carry `dl-lean`, `dl-cut` and
 * `dl-theta`, and the next family will add its own.
 *
 * `dl-exit` is a PLAYBOOK's own exit (six-playbooks spec §4.8) — a stop, the
 * trail, a take profit, the time exit, a stage-2 abort or legs found with no
 * trade — and reads as plain "Exit": which of those it was is the step's
 * reason, which the log shows as the label's tooltip, not a second word in the
 * column.
 */
export const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  'dl-open': 'Open',
  'dl-add': 'Add',
  'dl-neutral': 'Neutralise',
  'dl-target': 'Target hit',
  'dl-stuck': 'Stuck exit',
  'dl-exit': 'Exit',
  'dl-stop': 'Day stop',
  'dl-roll': 'Roll',
  'dl-lean': 'Lean',
  'dl-cut': 'Cut',
  'dl-theta': 'Theta hold',
  eod: 'EOD flatten',
  expiry: 'Expiry settle',
  lock: 'Profit lock',
  margin: 'Margin cut',
  shift: 'Shift',
  shed: 'Shed',
  scrap: 'Scrap',
  recycle: 'Recycle',
  unwind: 'Unwind',
  balance: 'Balance',
}

/** Order ids the dashboard mints for by-hand actions (`api.ts`, `strategies.tsx`). */
const MANUAL_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['ui-flatten-', 'Flatten (manual)'],
  ['ui-close-', 'Close (manual)'],
  ['opclose:', 'Close (manual)'],
  ['daily-guard-', 'Day guard'],
]

/**
 * `<decisionId>#<leg>` -> `<decisionId>`, split at the LAST `#` — the rule
 * every writer follows (`reconcile-live.ts splitOrderId`). An id with no leg
 * index is its own decision.
 */
export function decisionOf(clientOrderId: string): string {
  const base = baseOrderId(clientOrderId)
  const hash = base.lastIndexOf('#')
  return hash <= 0 ? base : base.slice(0, hash)
}

function stepLabel(id: string, trigger: string | null, events: readonly OrderEvent[]): string {
  if (trigger !== null) return TRIGGER_LABELS[trigger] ?? trigger
  for (const [prefix, label] of MANUAL_PREFIXES) if (id.startsWith(prefix)) return label
  // A paper fill carries its own op; the last word before a bare "Order".
  for (const e of events) {
    const op = e.detail?.['op']
    if (op === 'open') return 'Open'
    if (op === 'close') return 'Close'
  }
  return 'Order'
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/** What the order asked for: the desk order's own quantity, else the reconcile's. */
function orderedQtyOf(events: readonly OrderEvent[]): number | null {
  for (const e of events) {
    const q = num(e.orderQty)
    if (q !== null) return q
  }
  let best: number | null = null
  for (const e of events) {
    const q = num(e.detail?.['expectedQty'])
    if (q !== null && (best === null || q > best)) best = q
  }
  return best
}

/** Units per lot from a SUBMITTED event's `{lots, quantity}`. */
function lotSizeOf(events: readonly OrderEvent[]): number | null {
  for (const e of events) {
    const lots = num(e.detail?.['lots'])
    const qty = num(e.detail?.['quantity'])
    if (lots !== null && qty !== null && Number.isInteger(qty / lots)) return qty / lots
  }
  return null
}

const upper = (s: string | undefined): string => (s ?? '').toUpperCase()
const TERMINAL_REFUSAL = new Set(['FAILED', 'INVALID'])

/**
 * The one word the row says.
 *
 * Read off the WHOLE life, not the last event: the journal stamps a burst
 * within one millisecond, so "latest" is a coin flip (see `STATUS_RANK`).
 *   - something filled and it was everything asked for (or the broker said
 *     FILLED/COMPLETE and nothing says otherwise)       -> Filled
 *   - something filled, less than asked                 -> Partial
 *   - nothing filled, and it was refused or rejected    -> Rejected
 *   - nothing filled, and it was cancelled or halted    -> Cancelled
 *   - anything else                                     -> Working
 * A failure that the order then outlived (a chase that ran out, then the
 * deadline cross filled it) does NOT make a filled order red; it is kept as
 * `problem` instead.
 */
function statusOf(g: OrderGroup, orderedQty: number | null): OrderStatusWord {
  const states = g.events.map((e) => upper(e.status))
  const refused = g.events.some((e) => TERMINAL_REFUSAL.has(upper(e.phase))) || states.includes('REJECTED')
  const cancelled = states.some((s) => s === 'CANCELLED' || s === 'CANCELED' || s === 'HALTED')
  const complete = states.includes('FILLED') || states.includes('COMPLETE')
  if (g.filledQty > 0) {
    if (orderedQty !== null) return g.filledQty >= orderedQty ? 'Filled' : 'Partial'
    return complete && !refused && !cancelled ? 'Filled' : 'Partial'
  }
  if (refused) return 'Rejected'
  if (cancelled) return 'Cancelled'
  return 'Working'
}

function toOrder(g: OrderGroup): ReportOrder {
  const orderedQty = orderedQtyOf(g.events)
  // Events are newest first; the first failure in TIME is the cause, the
  // later ones are usually its consequences ("finished REJECTED…").
  const failures = g.events.filter((e) => !e.ok)
  const first = failures[failures.length - 1]
  const problem = first === undefined
    ? null
    : (typeof first.error === 'string' && first.error.trim() !== '' ? first.error : first.status ?? first.phase)
  const side = upper(g.side)
  return {
    id: g.id,
    ts: Math.min(...g.events.map((e) => e.ts)),
    tradingsymbol: g.tradingsymbol,
    side: side === 'BUY' ? 'Buy' : side === 'SELL' ? 'Sell' : '',
    filledQty: g.filledQty,
    orderedQty,
    lotSize: lotSizeOf(g.events),
    avgPrice: g.avgPrice,
    status: statusOf(g, orderedQty),
    problem,
    events: g.events,
  }
}

export function countOrders(orders: readonly ReportOrder[]): OrderCounts {
  const n = (w: OrderStatusWord): number => orders.filter((o) => o.status === w).length
  return {
    orders: orders.length,
    filled: n('Filled'),
    partial: n('Partial'),
    rejected: n('Rejected'),
    cancelled: n('Cancelled'),
    working: n('Working'),
  }
}

/** True for an order worth a look: anything but a clean fill. */
export function hasProblem(o: ReportOrder): boolean {
  return o.status !== 'Filled' || o.problem !== null
}

/**
 * Build the log. `problemsOnly` keeps only orders that did not fill cleanly
 * (and the steps and books that still hold one) — the counts stay the WHOLE
 * day's, so "1 rejected of 9" still reads against the nine.
 */
export function buildOrderLog(
  events: readonly OrderEvent[],
  opts: { problemsOnly?: boolean } = {},
): ReportOrderLog {
  const orders = groupOrders(events).map((g) => ({ g, o: toOrder(g) }))

  // book -> decision -> orders
  const books = new Map<string, Map<string, { g: OrderGroup; o: ReportOrder }[]>>()
  for (const item of orders) {
    const tag = item.g.tag
    const step = decisionOf(item.g.id)
    let byStep = books.get(tag)
    if (byStep === undefined) books.set(tag, (byStep = new Map()))
    const bucket = byStep.get(step)
    if (bucket === undefined) byStep.set(step, [item])
    else bucket.push(item)
  }

  const out: ReportBook[] = []
  const all: ReportOrder[] = []
  for (const [tag, byStep] of books) {
    const steps: ReportStep[] = []
    const bookOrders: ReportOrder[] = []
    for (const [id, items] of byStep) {
      const sorted = items.map((i) => i.o).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
      bookOrders.push(...sorted)
      const evs = items.flatMap((i) => i.g.events)
      const trigger = evs.find((e) => typeof e.trigger === 'string' && e.trigger !== '')?.trigger ?? null
      const reason = evs.find((e) => typeof e.reason === 'string' && e.reason !== '')?.reason ?? null
      const shown = opts.problemsOnly === true ? sorted.filter(hasProblem) : sorted
      if (shown.length === 0) continue
      steps.push({
        id,
        ts: sorted[0]?.ts ?? 0,
        trigger,
        label: stepLabel(id, trigger, evs),
        reason,
        orders: shown,
      })
    }
    all.push(...bookOrders)
    steps.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
    const counts = countOrders(bookOrders)
    if (steps.length === 0 && opts.problemsOnly === true) continue
    out.push({ tag, steps, counts })
  }
  out.sort((a, b) => (a.steps[0]?.ts ?? 0) - (b.steps[0]?.ts ?? 0) || a.tag.localeCompare(b.tag))
  return { books: out, counts: countOrders(all) }
}

/**
 * "9 orders · 8 filled · 1 rejected" — zero counts are left out, so a clean
 * day is one short phrase and a messy one names exactly what went wrong.
 */
export function countsLine(c: OrderCounts): string {
  const parts = [`${c.orders} order${c.orders === 1 ? '' : 's'}`]
  if (c.filled > 0) parts.push(`${c.filled} filled`)
  if (c.partial > 0) parts.push(`${c.partial} partial`)
  if (c.rejected > 0) parts.push(`${c.rejected} rejected`)
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`)
  if (c.working > 0) parts.push(`${c.working} working`)
  return parts.join(' · ')
}

/** Lots when the lot size is known, else the contract quantity with its unit. */
export function lotsText(o: ReportOrder): string {
  const shown = o.filledQty > 0 ? o.filledQty : o.orderedQty
  if (shown === null) return '—'
  const fmt = (q: number): string => {
    if (o.lotSize === null) return `${q}`
    const lots = lotsOf(q, o.lotSize)
    return Number.isInteger(lots) ? `${lots}` : lots.toFixed(1)
  }
  const unit = o.lotSize === null ? ' qty' : ''
  if (o.status === 'Partial' && o.orderedQty !== null && o.filledQty > 0) {
    return `${fmt(o.filledQty)} of ${fmt(o.orderedQty)}${unit}`
  }
  return `${fmt(shown)}${unit}`
}

const IST_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

/** `HH:MM:SS` in IST, whatever zone the browser sits in. */
export function istClock(ms: number): string {
  return IST_CLOCK.format(new Date(ms))
}
