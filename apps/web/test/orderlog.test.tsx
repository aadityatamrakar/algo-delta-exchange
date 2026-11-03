/**
 * The order log on screen: one row per order, every step a click away.
 *
 * `groupOrders`' arithmetic is pinned in `orders.test.tsx`. What these cover is
 * the part that only exists in the DOM — that the collapsing is actually wired
 * up, that nothing is lost behind it, and that `raw` can still get back to the
 * flat journal the component advertises.
 *
 * THE FIXTURE IS THE PROD SHAPE, not a tidy one: a 3-lot BHEL order that filled
 * in three steps, with every fill journalled a second time under the broker's
 * own contract spelling (`BHEL 25AUG2026 PE 410` against the Kite packing
 * `BHEL26AUG410PE`). Eleven rows for one order is what this replaces.
 */
import { expect, test, describe } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import { OrderLogTable } from '../src/orderlog.tsx'
import type { OrderEvent } from '../src/api.ts'

const ID = 'BHEL-2026-08-25-recenter-relief-r:live:2026-08-14T09:20:15#0'
const KITE = 'BHEL26AUG410PE'
const BROKER = 'BHEL 25AUG2026 PE 410'

const at = (over: Partial<OrderEvent>): OrderEvent => ({
  clientOrderId: ID, phase: 'STATUS', ok: true, tag: 'BHEL-2026-08-25-recenter-relief-r',
  tradingsymbol: KITE, ts: 1_755_000_000_000, ...over,
})

/** One order, as the journal really holds it. */
const EVENTS: OrderEvent[] = [
  at({ phase: 'PLANNED', ts: 1_755_000_000_001 }),
  at({ phase: 'SUBMITTED', ts: 1_755_000_000_002 }),
  at({ phase: 'ACK', ts: 1_755_000_000_003, brokerOrderId: '1240026709' }),
  at({ tag: '', ts: 1_755_000_000_004, tradingsymbol: BROKER,
       status: 'PARTIALLY_FILLED', filledQty: 2625, avgPrice: 3.65, side: 'SELL' }),
  at({ tag: '', ts: 1_755_000_000_005, tradingsymbol: BROKER,
       status: 'PARTIALLY_FILLED', filledQty: 5250, avgPrice: 3.65, side: 'SELL' }),
  at({ tag: '', ts: 1_755_000_000_006, tradingsymbol: BROKER,
       status: 'FILLED', filledQty: 7875, avgPrice: 3.63, side: 'SELL' }),
]

const bodyRows = (): HTMLElement[] => [...document.querySelectorAll('tbody tr')] as HTMLElement[]

describe('the collapsed order log', () => {
  test('six journal rows become ONE row, carrying the final fill', () => {
    render(<OrderLogTable events={EVENTS} />)

    expect(bodyRows()).toHaveLength(1)
    const row = bodyRows()[0] as HTMLElement
    // 7,875 — the FINAL cumulative quantity, not 2625+5250+7875.
    expect(within(row).getByText('7,875')).toBeTruthy()
    expect(within(row).getByText('3.63')).toBeTruthy()
    expect(within(row).getByText('FILLED')).toBeTruthy()
    // The Kite packing, shortened — never the broker's echo.
    expect(within(row).getByText('BHEL 410 PE')).toBeTruthy()
    expect(within(row).queryByText(BROKER)).toBe(null)
  })

  test('the row says how many steps are behind it', () => {
    // The COUNT and a chevron, not "6 steps": the word pushed this column past
    // what a half-width card had left and the design system squeezed the cell
    // to a single clipped digit. The sentence lives on the accessible name.
    render(<OrderLogTable events={EVENTS} />)
    expect(screen.getByText('6 \u203a')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Show all 6 events/ })).toBeTruthy()
  })

  test('opening a row shows EVERY event, newest first, raw spellings included', () => {
    render(<OrderLogTable events={EVENTS} />)
    act(() => { screen.getByRole('button', { name: /^Show all 6 events/ }).click() })

    const dialog = screen.getByRole('dialog')
    // Nothing is lost behind the collapse: all six phases are here.
    expect(within(dialog).getByText('PLANNED')).toBeTruthy()
    expect(within(dialog).getByText('SUBMITTED')).toBeTruthy()
    expect(within(dialog).getByText('ACK')).toBeTruthy()
    // The forensic view shows the RAW symbols — the two spellings are part of
    // what it exists to expose.
    expect(within(dialog).getAllByText(BROKER).length).toBe(3)
    // And the id, which is the one field that cannot be recovered elsewhere.
    expect(within(dialog).getByText(ID)).toBeTruthy()
  })

  test('a rejection is not hidden by the collapse', () => {
    render(
      <OrderLogTable
        events={[
          at({ phase: 'SUBMITTED', ts: 1 }),
          at({ phase: 'STATUS', tag: '', ts: 2, ok: false, status: 'REJECTED', error: 'RMS: margin' }),
        ]}
      />,
    )
    // The refusal's own sentence, on the collapsed row — it is the only thing
    // that can say why nothing traded.
    expect(screen.getByText('RMS: margin')).toBeTruthy()
  })

  test('raw mode renders every journal row instead', () => {
    render(<OrderLogTable events={EVENTS} raw />)
    expect(bodyRows()).toHaveLength(6)
  })

  test('the order id column is opt-in', () => {
    const { unmount } = render(<OrderLogTable events={EVENTS} />)
    expect(screen.queryByText(ID)).toBe(null)
    unmount()

    render(<OrderLogTable events={EVENTS} showOrderId />)
    expect(screen.getByText(ID)).toBeTruthy()
  })

  test('an empty log renders the table’s own empty state rather than throwing', () => {
    render(<OrderLogTable events={[]} />)
    // One row, spanning every column — the design system's empty state, not a
    // collapsed order.
    const rows = bodyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.querySelector('td')?.getAttribute('colspan')).not.toBe(null)
  })

  test('a routing event does not print its phase twice', () => {
    // Phase and Status both fell back to `phase`, so PLANNED appeared in two
    // columns of the same row — the duplication the `Phase` column was removed
    // from the other logs for.
    render(<OrderLogTable events={EVENTS} raw />)
    expect(screen.getAllByText('PLANNED')).toHaveLength(1)
  })
})

/**
 * WHAT THE ROUTING ROWS SAY NOW (2026-08-18). Only a fill journals a quantity
 * and a price, so PLANNED and SUBMITTED read `— / —` and the broker's first
 * PENDING_NEW echo read `0 / —` — the dialog opened on a real order and showed
 * an order for nothing. The intent figures come from the tranche's own
 * `detail.quantity` or the desk order's stamped `orderQty`/`limitPrice`
 * (`withOrderContext` in the bridge), and they step in exactly when the fill
 * figure is absent or still zero. A row with neither keeps its dash — nothing
 * here invents a number.
 */
describe('intent figures on routing rows', () => {
  const cells = (row: HTMLElement): (string | null)[] =>
    [...row.querySelectorAll('td')].map((td) => td.textContent)

  test('a SUBMITTED row shows its own tranche quantity and the order limit', () => {
    render(
      <OrderLogTable
        raw
        events={[at({
          phase: 'SUBMITTED', ts: 1,
          detail: { lots: 3, quantity: 7875, orderType: 'LIMIT' },
          limitPrice: 3.66,
        })]}
      />,
    )
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText('7,875')).toBeTruthy()
    expect(within(row).getByText('3.66')).toBeTruthy()
  })

  test('a PLANNED row and a qty-0 PENDING_NEW echo fall back to the desk order', () => {
    render(
      <OrderLogTable
        raw
        events={[
          at({ phase: 'PLANNED', ts: 1, orderQty: 7875, limitPrice: 3.66 }),
          at({ phase: 'STATUS', ts: 2, status: 'PENDING_NEW', filledQty: 0,
               orderQty: 7875, limitPrice: 3.66 }),
        ]}
      />,
    )
    for (const row of bodyRows()) {
      expect(within(row as HTMLElement).getByText('7,875')).toBeTruthy()
      expect(within(row as HTMLElement).getByText('3.66')).toBeTruthy()
    }
  })

  test('a fill keeps ITS figures — intent never overwrites what traded', () => {
    render(
      <OrderLogTable
        raw
        events={[at({
          phase: 'STATUS', ts: 1, status: 'FILLED', filledQty: 7875, avgPrice: 3.63,
          orderQty: 7875, limitPrice: 3.66,
        })]}
      />,
    )
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText('3.63')).toBeTruthy()
    expect(within(row).queryByText('3.66')).toBe(null)
  })

  test('a row with no figure anywhere keeps its dash — nothing is invented', () => {
    render(<OrderLogTable raw events={[at({ phase: 'PLANNED', ts: 1 })]} />)
    const row = bodyRows()[0] as HTMLElement
    // Qty and Price both — the columns land as cells four and five.
    expect(cells(row).filter((c) => c === '—').length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * THE ANNOUNCEMENT THAT COULD NOT BE READ (audit F5).
 *
 * `error` is the journal's one free-text field, so a line that is NOT a fault
 * has nowhere else to put its sentence: `submit.ts` files "manual leg added to
 * book X — the supervisor adopts it on its next tick" as a `STATUS`/`ok: true`
 * row with the whole thing in there. Every render site branched on `!ok` before
 * it ever looked at the text, so the receipt the Manual Order dialog tells the
 * operator to watch for rendered as a bare BOOKED badge and nothing else.
 */
describe('an OK event that carries a sentence', () => {
  const BOOKED = 'manual leg added to book BHEL-r: BHEL26AUG410PE qty -7875 @ 3.63 — the supervisor adopts it on its next tick'

  const booked = (over: Partial<OrderEvent> = {}): OrderEvent =>
    at({ phase: 'STATUS', ts: 1_755_000_000_007, status: 'BOOKED', error: BOOKED, ...over })

  test('the collapsed row prints it beside the status badge', () => {
    render(<OrderLogTable events={[...EVENTS, booked()]} />)
    expect(screen.getByText(BOOKED)).toBeTruthy()
    // Still a success: the sentence is news, and the red belongs to failures.
    expect(screen.getByText('FILLED')).toBeTruthy()
  })

  test('the flat journal prints it on the event’s own row', () => {
    render(<OrderLogTable raw events={[booked()]} />)
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText(BOOKED)).toBeTruthy()
    expect(within(row).getByText('BOOKED')).toBeTruthy()
  })

  test('and the “every step” dialog leads with it', () => {
    render(<OrderLogTable events={[...EVENTS, booked()]} />)
    act(() => { screen.getByRole('button', { name: /^Show all 7 events/ }).click() })
    const dialog = screen.getByRole('dialog')
    // Twice: once at the head of the dialog, once on the event's own row.
    expect(within(dialog).getAllByText(BOOKED).length).toBe(2)
  })

  test('A FAILURE IS UNCHANGED — its sentence is the row, in red', () => {
    render(
      <OrderLogTable
        events={[
          at({ phase: 'SUBMITTED', ts: 1 }),
          at({ phase: 'STATUS', ts: 2, ok: false, status: 'REJECTED', error: 'RMS: margin' }),
        ]}
      />,
    )
    expect(screen.getByText('RMS: margin')).toBeTruthy()
    // The status badge is NOT drawn beside a failure — the sentence replaces it.
    expect(screen.queryByText('REJECTED')).toBe(null)
  })

  test('an ordinary event with no sentence is exactly as it was', () => {
    render(<OrderLogTable raw events={[at({ phase: 'PLANNED', ts: 1 })]} />)
    const row = bodyRows()[0] as HTMLElement
    // Phase PLANNED once, and an em dash where the status would be.
    expect(within(row).getAllByText('PLANNED')).toHaveLength(1)
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(1)
  })
})

/**
 * A CAVEAT ON AN ORDER THAT SUCCEEDED (spec D5) — `OrderEvent.warning`.
 *
 * The gateway's "no freeze limit for SENSEX — sending N lots as ONE order"
 * used to be journaled as a second, `ok: false` PLANNED row. `groupOrders`
 * paints a group by its first `!ok` event, so every SENSEX order on the book
 * page read REJECTED in red, under a paragraph, though each one filled. The
 * operator's complaint was the paragraphs as much as the colour: the row
 * shows ONE WORD, `unsplit`, and the sentence lives in the dialog.
 */
describe('an OK event that carries a warning', () => {
  const W =
    "no freeze limit for underlying 'SENSEX' (source: master, exchange: BFO) — sending 9 lots as ONE order; " +
    'the exchange rejects anything over the volume freeze.'

  const warned = (): OrderEvent => at({ phase: 'PLANNED', ts: 1_755_000_000_000, warning: W })

  test('the collapsed row shows an "unsplit" badge beside FILLED and does NOT print the sentence or go red', () => {
    render(<OrderLogTable events={[...EVENTS, warned()]} />)
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText('FILLED')).toBeTruthy()
    expect(within(row).getByText('unsplit')).toBeTruthy()
    // One word on the row; the paragraph is for the dialog.
    expect(within(row).queryByText(W)).toBe(null)
    expect(screen.queryByText(W)).toBe(null)
    // And nothing about it is a failure.
    expect(screen.queryByText('REJECTED')).toBe(null)
  })

  test('the "every step" dialog leads with the warning sentence in secondary ink', () => {
    render(<OrderLogTable events={[...EVENTS, warned()]} />)
    act(() => { screen.getByRole('button', { name: /^Show all 7 events/ }).click() })
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getAllByText(W).length).toBeGreaterThanOrEqual(1)
  })

  test('the flat journal marks the event itself unsplit', () => {
    render(<OrderLogTable raw events={[warned()]} />)
    const row = bodyRows()[0] as HTMLElement
    expect(within(row).getByText('unsplit')).toBeTruthy()
    expect(within(row).queryByText(W)).toBe(null)
  })
})
