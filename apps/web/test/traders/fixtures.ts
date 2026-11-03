/** Wire-shaped fixtures for the traders page tests. Typed, so a drift in the server's types fails the typecheck. */
import type { BookSummary, BookView, LegView } from '../../../traders/src/types.ts'
import { fireEvent, within } from '@testing-library/react'

export const ASOF = new Date('2026-10-19T10:27:00+05:30').getTime()

export function leg(over: Partial<LegView> = {}): LegView {
  return {
    key: 'C0001|option|TCS|2026-10-27|3500|CE', source: 'odin', clientCode: 'C0001', note: '', lotSize: 175,
    instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE',
    qty: -175, avgPrice: 88.5, ltp: 80, iv: 0.2345, delta: -52.5, gamma: -0.0123, vega: -310.25, theta: 140.5,
    mtm: 1487.5, matched: true,
    ...over,
  }
}

export const MANUAL_SHARES: LegView = leg({
  key: 'manual:abc', source: 'manual', clientCode: '', instrument: 'share', expiry: '', strike: null, optType: null,
  qty: 350, avgPrice: 3012.5, ltp: 3050, iv: null, delta: 350, gamma: 0, vega: 0, theta: 0, mtm: 13125,
  note: 'delivered at expiry',
})

export const UNMATCHED_LEG: LegView = leg({
  key: 'C0001|option|TCS|2026-10-27|3550|CE', strike: 3550, qty: 175, avgPrice: 40, ltp: null, iv: null,
  delta: 0, gamma: 0, vega: 0, theta: 0, mtm: null, matched: false,
})

export function bookView(over: Partial<BookView> = {}): BookView {
  return {
    stock: 'TCS', asOf: ASOF, closed: false, spot: 3050, futures: { '2026-10-27': 3055 }, forwards: { '2026-10-27': 3055 },
    legs: [leg(), MANUAL_SHARES, UNMATCHED_LEG],
    totals: { delta: 297.5, gamma: -0.0123, vega: -310.25, theta: 140.5, mtm: 14612.5 },
    payoff: null,
    unmatched: ['TCS 3550 CE 2026-10-27 (client C1) — no such contract'],
    mismatch: null, historyFrom: '2026-08-25', warnings: ['Watcher offline since 09:10'],
    ...over,
  }
}

export const BOOK_TCS: BookView = bookView()

export function summaries(...stocks: string[]): BookSummary[] {
  return stocks.map((stock) => ({ stock, legCount: 1, mismatch: null, lastFileAt: null, band: null }))
}

/** A payoff whose scan is empty — enough to prove the shared chart is mounted without drawing recharts in jsdom. */
export const EMPTY_PAYOFF = { curve: [] } as unknown as NonNullable<BookView['payoff']>

/** Notes and items sit behind one "Notes (N)" fold each (caveats.tsx): opens every closed one in `root`. */
export function openNotes(root: HTMLElement = document.body): void {
  for (const b of within(root).queryAllByRole('button', { name: /^Notes \(\d+\)$/ })) {
    if (b.getAttribute('aria-expanded') !== 'true') fireEvent.click(b)
  }
}

/** An item list's lines once open: its items less the fold's own. */
export function noteItems(list: HTMLElement): HTMLElement[] {
  return within(list).getAllByRole('listitem').filter((li) => within(li).queryByRole('button', { name: /^Notes \(\d+\)$/ }) === null)
}
