/**
 * The book's P&L and Today in words, for the strip's ⓘ and the P&L block (spec 2026-10-23). P&L is the series net:
 * every live expiry since its first trade, booked on the closed contracts + the open legs at LTP − all charges
 * (apps/traders/src/analytics/series-pnl.ts). Today is the Day MTM, the day's move after today's charges: a part of
 * P&L, not added to it. With more than one live expiry, one line per expiry; then the server's notes.
 *
 * The series ride on the book and its Analysis window as optional fields, and on the live frame (`seriesNet` and its
 * parts): an older server sends none, and then P&L is the view's, or not shown.
 */

import type { LiveFrame } from '../../../traders/src/analytics/r3-wire.ts'
import type { SeriesPnl, SeriesTotal } from '../../../traders/src/types.ts'
import { inr, money } from '../format.ts'
import { expiryDayLabel } from './wire.ts'

export const PNL_ABOUT = 'P&L = booked on the closed contracts + the open legs at LTP − all charges, every live expiry from its first trade'
export const TODAY_ABOUT = "Today = the legs carried from yesterday's close + today's trades − today's charges: the day's move, a part of P&L, not added to it. Not shown before 09:15 or on a closed day"
export const DAY_EXCLUDES = "Today bears the charges of today's fills only; the open cycle's earlier charges are in P&L's charges"
/** Said on hover wherever a leg's (LTP − net price) × qty is shown, alone or summed over a group's legs. */
export const LEG_PNL_TITLE = "this contract since it was opened, partial exits included, before charges; the book's result is P&L"
export const RATES_ESTIMATE = 'Rates not confirmed by admin — charges are estimates'
/** Said in both ⓘ when the book holds shares. */
export const SHARES_LINE = 'Today counts shares; P&L does not (shares have no expiry)'

export interface Series { readonly list: readonly SeriesPnl[]; readonly total: SeriesTotal }

/** The view's series when it carries any; null from an older server, or a book with no live expiry (shares only). */
export function seriesOf(v: { readonly series?: readonly SeriesPnl[]; readonly seriesTotal?: SeriesTotal }): Series | null {
  const list = v.series
  const total = v.seriesTotal
  return Array.isArray(list) && list.length > 0 && typeof total === 'object' && total !== null ? { list, total } : null
}

/** P&L and its parts, read at one moment. */
export interface Pnl { readonly net: number | null; readonly open: number | null; readonly booked: number; readonly charges: number }

/** P&L from the fresh live frame when it carries one, else the view's: an older server's frame has no `seriesNet`. */
export function pnlOf(s: Series, fresh: LiveFrame | null): Pnl {
  const t = s.total
  if (fresh === null || fresh.seriesNet === undefined) return { net: t.net, open: t.open, booked: t.booked, charges: t.charges }
  return { net: fresh.seriesNet, open: fresh.seriesOpen ?? null, booked: fresh.seriesBooked ?? t.booked, charges: fresh.seriesCharges ?? t.charges }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** P&L's heading: '2026-10-05' → 'since 5 Oct, after charges'; no first trade → 'after charges'. */
export function sinceText(from: string | null): string {
  const m = from === null ? null : /^\d{4}-(\d{2})-(\d{2})$/.exec(from)
  const month = m === null ? undefined : MONTHS[Number(m[1]) - 1]
  return m === null || month === undefined ? 'after charges' : `since ${Number(m[2])} ${month}, after charges`
}

/** What P&L is, its parts when given (the strip's ⓘ), each live expiry when there are several, the server's notes. */
export function seriesLines(s: Series, parts: Pnl | null = null): string[] {
  const est = s.total.ratesConfirmed ? '' : ' (est.)'
  const lines = [PNL_ABOUT]
  if (parts !== null) {
    lines.push(`P&L ${sinceText(s.total.from)} ${money(parts.net)} = booked on closed contracts ${money(parts.booked)} · open legs at LTP ${money(parts.open)} · charges ${money(-parts.charges)}${est}`)
  }
  lines.push(DAY_EXCLUDES)
  for (const x of s.list) {
    const name = expiryDayLabel(x.expiry)
    if (s.list.length > 1) {
      lines.push(`${name}: P&L ${money(x.net)} · booked ${money(x.booked)} · open legs ${money(x.open)} · charges ${inr(x.charges)}${est} · `
        + `${x.closedContracts} closed · from ${x.from === null ? '—' : expiryDayLabel(x.from)}`)
    }
    for (const n of x.notes) lines.push(`${name}: ${n}`)
  }
  lines.push(...s.total.notes)
  if (!s.total.ratesConfirmed) lines.push(RATES_ESTIMATE)
  return lines
}
