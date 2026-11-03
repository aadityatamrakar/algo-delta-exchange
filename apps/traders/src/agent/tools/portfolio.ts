/**
 * `get_portfolio`: every open book of the trader, as the Portfolio page reads
 * them (`traderPortfolio`, the route's own function) — delta in shares and
 * lots, gamma, vega, theta, P&L (the series net; null when unknown, and then
 * `pnlNotShown` says why), Day MTM (null before the open, on a closed day or
 * with a close unknown, and then `dayMtmNotShown` says why) and Open P&L, NSE
 * margin and the band — and the totals. The view's trader name is not copied (R5).
 */

import { z } from 'zod'
import { bookMargin } from '../../analytics/margin.ts'
import { PNL_NO_LIVE_EXPIRY, PNL_NO_SERIES, countsInPnl } from '../../analytics/portfolio.ts'
import { traderPortfolio } from '../../routes/portfolio.ts'
import { droppedSymbols, envelope, nseRows, r2, r4, type AgentTool } from './ctx.ts'

const noInput = z.object({}).strict()

/** Why a P&L is null, as the model reads it: a book with no live series holds shares, it is not an unknown. */
const pnlWhy = (reason: string | null | undefined): string =>
  (reason === PNL_NO_SERIES || reason === PNL_NO_LIVE_EXPIRY ? 'P&L counts F&O series only, shares are not in it' : reason ?? 'not known')

export const getPortfolio: AgentTool<z.infer<typeof noInput>> = {
  name: 'get_portfolio',
  description: 'Every open book of the trader: delta (shares, lots), gamma, vega, theta, P&L (the series net: booked + open legs at LTP − charges, since the first trade), Day MTM (today\'s move after the charges on today\'s fills; null before 09:15 and on a closed day) and Open P&L (open legs against net price, before charges), NSE margin, delta band; and the totals across books.',
  input: noInput,
  label: () => 'reading the portfolio',
  async run(ctx) {
    const nowMs = ctx.deps.now()
    const v = await traderPortfolio(ctx.deps, ctx.trader, nowMs)
    const t = v.totals
    // R11: a book whose symbol is not an NSE symbol carries file text: left out of the rows (its numbers stay in the totals), and counted
    const books = nseRows(v.rows, (r) => r.stock)
    // each book's margin provenance, off the same minute snapshot the Portfolio read
    const partial = new Map<string, boolean>()
    for (const r of books.rows) {
      const m = r.margin === null ? null : await bookMargin(ctx.deps, ctx.trader, r.stock, nowMs)
      partial.set(r.stock, m !== null && (m.missing.length > 0 || m.exposureFile === null))
    }
    const missing = nseRows(t.marginMissing, (s) => s)
    const dropped = books.dropped
    return {
      result: {
        ...envelope(ctx, { asOf: v.asOf, warnings: dropped === 0 ? [] : [droppedSymbols(dropped)] }),
        books: books.rows.map((r) => ({
          stock: r.stock, spot: r2(r.spot), lotSize: r.lotSize,
          deltaShares: r2(r.delta), deltaLots: r2(r.deltaLots), gamma: r4(r.gamma), vega: r2(r.vega), theta: r2(r.theta),
          pnl: r2(r.pnl), pnlNotShown: (r.pnl ?? null) === null ? pnlWhy(r.pnlReason) : null,
          dayMtm: r2(r.mtmDay), dayMtmNotShown: r.mtmDay === null ? r.mtmDayReason ?? 'not known' : null, openPnl: r2(r.openPnl), margin: r2(r.margin),
          marginSource: r.margin === null ? null : 'span', marginPartial: partial.get(r.stock) ?? false, band: r.band, bandSentence: r.bandSentence,
        })),
        totals: {
          books: t.books, outOfBand: t.outOfBand, deltaValueRupees: r2(t.deltaValue), vega: r2(t.vega), theta: r2(t.theta),
          pnl: r2(t.pnl), pnlNotShown: (t.pnl ?? null) === null ? pnlWhy(t.pnlReason) : null, booksWithoutPnl: v.rows.filter((r) => countsInPnl(r) && (r.pnl ?? null) === null).length,
          dayMtm: r2(t.mtmDay), booksWithoutDayMtm: v.rows.filter((r) => r.mtmDay === null).length, openPnl: r2(t.openPnl), margin: r2(t.margin), marginMissingFor: missing.rows,
        },
      },
      summary: `${books.rows.length} ${books.rows.length === 1 ? 'book' : 'books'}, ${t.outOfBand} out of band`,
    }
  },
}
