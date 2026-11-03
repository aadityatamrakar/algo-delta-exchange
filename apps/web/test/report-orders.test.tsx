/**
 * The Reports day order log: one row per ORDER, grouped by the step that
 * placed it, one table per book, oldest first.
 *
 * THE FIXTURES ARE THE PROD SHAPE (desk-order-events, 2026-10-05): a paper
 * engine order journals PLANNED, SUBMITTED, ACK, STATUS WORKING, STATUS FILLED,
 * the reconcile's second STATUS FILLED and the fold's FILL — seven rows for
 * one leg, all inside a second. `groupOrders`' fill arithmetic is pinned in
 * `orders.test.tsx`; these pin the reading on top of it.
 */
import { expect, test, describe } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { OrderEvent } from '../src/api.ts'
import {
  buildOrderLog, countsLine, decisionOf, istClock, lotsText, TRIGGER_LABELS,
} from '../src/report-orders.ts'
import { ReportOrderLog } from '../src/report-orderlog.tsx'

const NIFTY = 'NIFTY-delta-lean-conservative-2026-10-05'
const SENSEX = 'SENSEX-delta-lean-conservative-2026-10-05'
/** 09:33:03 IST on 2026-10-05. */
const T0 = Date.parse('2026-10-05T09:33:03+05:30')

const ev = (over: Partial<OrderEvent>): OrderEvent => ({
  clientOrderId: `${NIFTY}:paper:1#0`, phase: 'STATUS', ok: true, tag: NIFTY,
  tradingsymbol: 'NIFTY26O0622650CE', ts: T0, ...over,
})

/** One leg's whole life, as the journal holds it, filling in two steps. */
function filledLeg(o: {
  id: string; tag?: string; sym: string; side: 'BUY' | 'SELL'; ts: number
  qty?: number; price: number; trigger?: string; reason?: string
}): OrderEvent[] {
  const qty = o.qty ?? 130
  const base = {
    clientOrderId: o.id, tag: o.tag ?? NIFTY, tradingsymbol: o.sym, orderQty: qty,
    side: o.side,
    ...(o.trigger === undefined ? {} : { trigger: o.trigger }),
    ...(o.reason === undefined ? {} : { reason: o.reason }),
  }
  return [
    ev({ ...base, phase: 'PLANNED', ts: o.ts, detail: { tranches: [2], mode: 'paper' } }),
    ev({ ...base, phase: 'SUBMITTED', ts: o.ts + 2, detail: { lots: qty / 65, quantity: qty, mode: 'paper' } }),
    ev({ ...base, phase: 'ACK', ts: o.ts + 3, status: 'WORKING', brokerOrderId: 'sim-1' }),
    ev({ ...base, ts: o.ts + 4, status: 'WORKING', filledQty: 0, avgPrice: null }),
    ev({ ...base, ts: o.ts + 300, status: 'PARTIALLY_FILLED', filledQty: qty / 2, avgPrice: o.price }),
    ev({ ...base, ts: o.ts + 360, status: 'FILLED', filledQty: qty, avgPrice: o.price }),
    ev({ ...base, ts: o.ts + 365, status: 'FILLED', filledQty: qty, avgPrice: o.price, detail: { expectedQty: qty } }),
    ev({ ...base, phase: 'FILL', ts: o.ts + 1900, status: 'FILLED', filledQty: qty, avgPrice: o.price,
         detail: { source: 'paper-fold', mode: 'paper', op: 'open' } }),
  ]
}

const OPEN_REASON = 'trend-up: opening up, 2 leg(s) at 2 lot(s) a leg, hedge included'

/**
 * A PLAYBOOK day (six-playbooks spec §4.8): the protective buy (stage 1) and
 * the short (stage 2) are both `dl-open`; the stop that ends the trade is
 * `dl-exit`, and closes shorts first (D2) — so the buy-back goes before the
 * sale of the long.
 */
const EXIT_REASON = 'hard stop: trade -Rs6,090 at or below -Rs6,000'
const PLAYBOOK_DAY: OrderEvent[] = [
  ...filledLeg({ id: `${NIFTY}:paper:1#0`, sym: 'NIFTY26O0622650CE', side: 'BUY', ts: T0, price: 74.6,
                 trigger: 'dl-open', reason: 'stage 1: protective buys' }),
  ...filledLeg({ id: `${NIFTY}:paper:2#0`, sym: 'NIFTY26O0622800CE', side: 'SELL', ts: T0 + 20_000, price: 25.6,
                 trigger: 'dl-open', reason: 'stage 2: shorts' }),
  ...filledLeg({ id: `${NIFTY}:paper:3#0`, sym: 'NIFTY26O0622800CE', side: 'BUY', ts: T0 + 3600_000, price: 51.9,
                 trigger: 'dl-exit', reason: EXIT_REASON }),
  ...filledLeg({ id: `${NIFTY}:paper:3#1`, sym: 'NIFTY26O0622650CE', side: 'SELL', ts: T0 + 3600_000 + 15, price: 40.2,
                 trigger: 'dl-exit', reason: EXIT_REASON }),
]

/** NIFTY: a two-leg open, then the EOD flatten of one leg. */
const NIFTY_DAY: OrderEvent[] = [
  ...filledLeg({ id: `${NIFTY}:paper:1#0`, sym: 'NIFTY26O0622650CE', side: 'BUY', ts: T0, price: 74.6,
                 trigger: 'dl-open', reason: OPEN_REASON }),
  ...filledLeg({ id: `${NIFTY}:paper:1#1`, sym: 'NIFTY26O0622800CE', side: 'SELL', ts: T0 + 15, price: 25.6,
                 trigger: 'dl-open', reason: OPEN_REASON }),
  ...filledLeg({ id: `${NIFTY}:paper:4#0`, sym: 'NIFTY26O0622800CE', side: 'BUY', ts: T0 + 5 * 3600_000,
                 price: 11.1, trigger: 'eod' }),
]

describe('building the log', () => {
  test('a multi-fill order collapses to ONE row with its final fill', () => {
    const log = buildOrderLog(filledLeg({ id: `${NIFTY}:paper:1#0`, sym: 'NIFTY26O0622650CE',
      side: 'BUY', ts: T0, price: 74.6, trigger: 'dl-open' }))
    expect(log.books).toHaveLength(1)
    const steps = log.books[0]!.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]!.orders).toHaveLength(1)
    const o = steps[0]!.orders[0]!
    expect(o.status).toBe('Filled')
    // 130, the FINAL cumulative quantity — not 65 + 130 + 130 + 130.
    expect(o.filledQty).toBe(130)
    expect(o.avgPrice).toBe(74.6)
    expect(o.side).toBe('Buy')
    expect(lotsText(o)).toBe('2')
    expect(o.problem).toBe(null)
    // Placed at its FIRST event, and every event kept for the dialog.
    expect(o.ts).toBe(T0)
    expect(o.events).toHaveLength(8)
  })

  test('the legs of one decision are one step, labelled with the trigger as a word', () => {
    const book = buildOrderLog(NIFTY_DAY).books[0]!
    expect(book.steps.map((s) => s.label)).toEqual(['Open', 'EOD flatten'])
    expect(book.steps[0]!.orders.map((o) => o.tradingsymbol)).toEqual(['NIFTY26O0622650CE', 'NIFTY26O0622800CE'])
    expect(book.steps[0]!.reason).toBe(OPEN_REASON)
    expect(book.counts).toMatchObject({ orders: 3, filled: 3, rejected: 0 })
  })

  test('a playbook exit (dl-exit) reads "Exit", with the engine\'s reason kept on the step', () => {
    expect(TRIGGER_LABELS['dl-exit']).toBe('Exit')
    const book = buildOrderLog(PLAYBOOK_DAY).books[0]!
    // Both stages of the entry are "Open"; the stop that ends the trade is "Exit".
    expect(book.steps.map((s) => s.label)).toEqual(['Open', 'Open', 'Exit'])
    const exit = book.steps[2]!
    expect(exit.trigger).toBe('dl-exit')
    // One decision, two orders: the buy-back of the short, then the long sold.
    expect(exit.orders.map((o) => o.side)).toEqual(['Buy', 'Sell'])
    // Which exit it was is the reason, not a second word in the column.
    expect(exit.reason).toBe(EXIT_REASON)
    expect(book.counts).toMatchObject({ orders: 4, filled: 4, rejected: 0 })
  })

  test('a rejected order is one row, Rejected, with the refusal as its reason', () => {
    const id = `${NIFTY}:paper:2#0`
    const log = buildOrderLog([
      ev({ clientOrderId: id, phase: 'PLANNED', ts: T0, orderQty: 130, side: 'SELL' }),
      ev({ clientOrderId: id, phase: 'SUBMITTED', ts: T0 + 1, detail: { lots: 2, quantity: 130 } }),
      ev({ clientOrderId: id, phase: 'FAILED', ok: false, ts: T0 + 2, status: 'REJECTED', filledQty: 0,
           avgPrice: null, error: 'RMS: margin exceeds limit' }),
    ])
    const o = log.books[0]!.steps[0]!.orders[0]!
    expect(o.status).toBe('Rejected')
    expect(o.problem).toBe('RMS: margin exceeds limit')
    expect(o.avgPrice).toBe(null)
    // What was ASKED, since nothing filled.
    expect(lotsText(o)).toBe('2')
    expect(log.counts).toMatchObject({ orders: 1, rejected: 1, filled: 0 })
  })

  test('a partial fill says how much of what was asked', () => {
    const id = `${NIFTY}:paper:3#0`
    const o = buildOrderLog([
      ev({ clientOrderId: id, phase: 'SUBMITTED', ts: T0, orderQty: 260, detail: { lots: 4, quantity: 260 } }),
      ev({ clientOrderId: id, ts: T0 + 5, status: 'PARTIALLY_FILLED', filledQty: 65, avgPrice: 40 }),
      ev({ clientOrderId: id, ts: T0 + 9, status: 'CANCELLED', filledQty: 65, avgPrice: 40 }),
    ]).books[0]!.steps[0]!.orders[0]!
    expect(o.status).toBe('Partial')
    expect(lotsText(o)).toBe('1 of 4')
  })

  test('a failure the order outlived stays visible but does not turn a fill red', () => {
    const id = `${NIFTY}:paper:15#0`
    const o = buildOrderLog([
      ev({ clientOrderId: id, phase: 'PLANNED', ts: T0, orderQty: 260 }),
      ev({ clientOrderId: id, ts: T0 + 10, ok: false, error: 'still resting after 1 reprices' }),
      ev({ clientOrderId: id, ts: T0 + 600, status: 'FILLED', filledQty: 260, avgPrice: 17.775 }),
    ]).books[0]!.steps[0]!.orders[0]!
    expect(o.status).toBe('Filled')
    expect(o.problem).toBe('still resting after 1 reprices')
  })

  test('two books interleaved in time come out grouped, each oldest first', () => {
    const sensex = [
      ...filledLeg({ id: `${SENSEX}:paper:1#0`, tag: SENSEX, sym: 'SENSEX26O0172900CE', side: 'BUY',
                     ts: T0 + 60_000, qty: 40, price: 326.5, trigger: 'dl-open' }),
      ...filledLeg({ id: `${SENSEX}:paper:2#0`, tag: SENSEX, sym: 'SENSEX26O0173100CE', side: 'SELL',
                     ts: T0 + 2 * 3600_000, qty: 40, price: 256.65, trigger: 'dl-neutral' }),
    ]
    // Shuffled newest-first across both books, the way the endpoint returns them.
    const mixed = [...NIFTY_DAY, ...sensex].sort((a, b) => b.ts - a.ts)
    const log = buildOrderLog(mixed)
    expect(log.books.map((b) => b.tag)).toEqual([NIFTY, SENSEX])
    expect(log.books[0]!.steps.map((s) => s.label)).toEqual(['Open', 'EOD flatten'])
    expect(log.books[1]!.steps.map((s) => s.label)).toEqual(['Open', 'Neutralise'])
    expect(countsLine(log.counts)).toBe('5 orders · 5 filled')
  })

  test('problems only keeps the orders that did not fill cleanly, and the whole-day counts', () => {
    const bad = `${NIFTY}:paper:2#0`
    const log = buildOrderLog([
      ...NIFTY_DAY,
      ev({ clientOrderId: bad, phase: 'INVALID', ok: false, ts: T0 + 3600_000, trigger: 'dl-add',
           error: 'switched off in paper' }),
    ], { problemsOnly: true })
    const steps = log.books[0]!.steps
    expect(steps.map((s) => s.label)).toEqual(['Add'])
    expect(steps[0]!.orders.map((o) => o.status)).toEqual(['Rejected'])
    expect(countsLine(log.books[0]!.counts)).toBe('4 orders · 3 filled · 1 rejected')
  })

  test('steps no supervisor journalled are still named', () => {
    const log = buildOrderLog([
      ev({ clientOrderId: `opclose:${NIFTY}:paper:NIFTY26O0622650CE:1791190000000#0`, ts: T0,
           status: 'FILLED', filledQty: 65, avgPrice: 10 }),
      ev({ clientOrderId: `${NIFTY}:paper:9#0`, ts: T0 + 1, trigger: 'dl-brand-new',
           status: 'FILLED', filledQty: 65, avgPrice: 10 }),
    ])
    expect(log.books[0]!.steps.map((s) => s.label)).toEqual(['Close (manual)', 'dl-brand-new'])
  })

  test('decision ids split at the LAST #, after the tranche suffix', () => {
    expect(decisionOf('BK:paper:3#1.2')).toBe('BK:paper:3')
    expect(decisionOf('caller#id#4')).toBe('caller#id')
    expect(decisionOf('bare-id')).toBe('bare-id')
  })

  test('times are IST wall clock, HH:MM:SS', () => {
    expect(istClock(T0)).toBe('09:33:03')
  })
})

// ------------------------------------------------------------------ on screen

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll('tbody tr')] as HTMLElement[]

describe('the log on screen', () => {
  test('one row per order, the step named once, no journal phases', () => {
    render(<ReportOrderLog events={NIFTY_DAY} />)
    // 24 journal events, 3 orders.
    expect(bodyRows()).toHaveLength(3)
    expect(screen.getByText('3 orders · 3 filled')).toBeTruthy()
    expect(screen.getByText('Open → EOD flatten')).toBeTruthy()
    const [first, second] = bodyRows() as [HTMLElement, HTMLElement]
    expect(within(first).getByText('09:33:03')).toBeTruthy()
    expect(within(first).getByText('Open')).toBeTruthy()
    expect(within(first).getByText('NIFTY 22650 CE')).toBeTruthy()
    expect(within(first).getByText('Buy')).toBeTruthy()
    expect(within(first).getByText('74.60')).toBeTruthy()
    expect(within(first).getByText('Filled')).toBeTruthy()
    // The second leg of the same package does not repeat the step.
    expect(within(second).queryByText('Open')).toBe(null)
    expect(within(second).getByText('Sell')).toBeTruthy()
    // The raw journal vocabulary is not on the default view.
    for (const word of ['PLANNED', 'SUBMITTED', 'ACK', 'WORKING']) expect(screen.queryByText(word)).toBe(null)
    expect(screen.queryByText(new RegExp(`${NIFTY}:paper`))).toBe(null)
  })

  test('a playbook day reads Open → Exit, the stop on the first row of its own step', () => {
    render(<ReportOrderLog events={PLAYBOOK_DAY} />)
    expect(bodyRows()).toHaveLength(4)
    expect(screen.getByText('4 orders · 4 filled')).toBeTruthy()
    // The summary line has one word per step: the two stages of the entry are
    // two decisions, so two "Open", and the stop is a plain "Exit", never the
    // raw `dl-exit`.
    expect(screen.getByText('Open → Open → Exit')).toBeTruthy()
    expect(screen.queryByText('dl-exit')).toBe(null)
    const rows = bodyRows()
    expect(within(rows[2]!).getByText('Exit')).toBeTruthy()
    expect(within(rows[2]!).getByText('Buy')).toBeTruthy()
    // The second leg of the same package does not repeat the step.
    expect(within(rows[3]!).queryByText('Exit')).toBe(null)
    expect(within(rows[3]!).getByText('Sell')).toBeTruthy()
  })

  test('problems only hides the clean fills', () => {
    render(<ReportOrderLog events={[
      ...NIFTY_DAY,
      ev({ clientOrderId: `${NIFTY}:paper:2#0`, phase: 'INVALID', ok: false, ts: T0 + 3600_000,
           trigger: 'dl-add', error: 'switched off in paper' }),
    ]} />)
    expect(bodyRows()).toHaveLength(4)
    fireEvent.click(screen.getByRole('switch', { name: 'Problems only' }))
    expect(bodyRows()).toHaveLength(1)
    expect(screen.getByText('switched off in paper')).toBeTruthy()
    // The day line still counts the whole day.
    expect(screen.getByText('4 orders · 3 filled · 1 rejected')).toBeTruthy()
  })

  test('the lifecycle is one click away', () => {
    render(<ReportOrderLog events={NIFTY_DAY} />)
    fireEvent.click(screen.getByRole('button', { name: `Show all 8 events for ${NIFTY}:paper:1#0` }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(`${NIFTY}:paper:1#0`)).toBeTruthy()
    expect(within(dialog).getByText('PLANNED')).toBeTruthy()
    expect(within(dialog).getByText('SUBMITTED')).toBeTruthy()
  })
})
