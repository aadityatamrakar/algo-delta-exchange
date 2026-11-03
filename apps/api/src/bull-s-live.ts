/**
 * A BULL-S BOOK DOES NOT TRADE LIVE WITHOUT A MARGIN BUDGET (lane A, 3 Nov).
 *
 * `bs_margin_budget` is what stops the pyramid selling straddles past what the
 * account can carry (`bull-s/margin.ts`). Its default is 0 — off — and no
 * preset sets it, which is right for paper and wrong for real money: a live
 * book armed at 0 sells to the venue's own margin call. So every door that
 * ARMS a live book asks this first and refuses with a 400 that says what to
 * set:
 *
 *   - `PATCH /v1/desk/strategies/:tag` turning `modes.live` on
 *   - the bulk switch turning live on (that row is skipped, named)
 *   - `POST /v1/desk/books/registry/:tag/start` for a live book
 *   - a dials PATCH on a live book that would leave it BULL-S at 0
 *
 * The dials are RESOLVED, never read raw: a stored row carries only what was
 * set, so an absent `bs_margin_budget` is the default 0, and an absent
 * `bs_enabled` is off. Paper is never asked.
 */
import { resolveDials } from '@algomaker/desk-engine'
import type { DialValue } from './books-registry.ts'

/** The refusal for these dials on a LIVE book, or null when they may trade live. */
export function liveBudgetRefusal(tag: string, dials: Readonly<Record<string, DialValue>>): string | null {
  const { dials: d } = resolveDials(dials as Record<string, number | boolean>)
  if (!d.bs_enabled) return null
  if (d.bs_margin_budget > 0) return null
  return (
    `'${tag}' is a BULL-S book with no margin budget (bs_margin_budget is ${String(d.bs_margin_budget)}): ` +
    'a live BULL-S book must have one — set bs_margin_budget (USD) above 0 on its live book first'
  )
}

/** The refusal for arming `tag` live, read off its live registry book; null = no live BULL-S book in the way. */
export async function liveArmRefusal(
  store: { getBook(tag: string, mode: 'live'): Promise<{ readonly dials: Readonly<Record<string, DialValue>> } | null> },
  tag: string,
): Promise<string | null> {
  const book = await store.getBook(tag, 'live')
  if (book === null) return null
  return liveBudgetRefusal(tag, book.dials)
}
