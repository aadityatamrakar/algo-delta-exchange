/**
 * `get_events`: the results-event risk of each of the trader's open books (risk spec R10–R12), the same minute view
 * `GET /events` answers (`deps.eventRisk`): the next results date and the series that carries it, the implied move
 * against the stock's past reactions (ratio and verdict), the mean IV crush, and the book's change under each outcome
 * on the morning after. Every rupee figure is a change from the book's value now, never a P&L.
 *
 * The main session folds this into Lane C's `get_risk` (spec R16) at merge.
 */

import { z } from 'zod'
import { droppedSymbols, envelope, nseRows, r2, r4, type AgentTool } from './ctx.ts'

const noInput = z.object({}).strict()

/** A warning that names a leg (its key or contract text, from an uploaded file) stays on the page: counted, not passed on. */
const NAMES_A_LEG = /\bleg\b|\(client /

export const getEvents: AgentTool<z.infer<typeof noInput>> = {
  name: 'get_events',
  description: 'Results-event risk of every open book of the trader: the next results date (NSE\'s board meetings), days to it, the first expiry on or after it and whether it is in the near (ranked) IV, '
    + 'whether the book holds through it; the implied move (ATM straddle ÷ future of that expiry) against the mean and median |move| of past results days, their ratio and verdict (rich ≥ 1.25, cheap ≤ 0.8), the mean IV crush (vol points); '
    + 'and the book\'s change in rupees, valued 09:15 the trading day after, for the stock moving ±mean |move| and ±1.5× it with the crush, and the crush alone. Provisional under 3 past reactions.',
  input: noInput,
  label: () => 'reading results risk',
  async run(ctx) {
    const v = await ctx.deps.eventRisk(ctx.trader, ctx.deps.now())
    const rows = nseRows(v.rows, (r) => r.stock)
    let withheld = 0
    const safe = (ws: readonly string[]): string[] => ws.filter((w) => (NAMES_A_LEG.test(w) ? (withheld++, false) : true))
    const out = rows.rows.map((r) => ({
      stock: r.stock,
      next: r.next === null ? null : { ...r.next },
      impliedMove: r4(r.impliedMove), pastAbsMean: r4(r.pastAbsMean), pastAbsMedian: r4(r.pastAbsMedian), pastReactions: r.past.length,
      past: r.past.map((p) => ({ date: p.date, move: r4(p.move), crushPts: r2(p.crushPts) })),
      crushMeanPts: r2(r.crushMeanPts), ratio: r2(r.ratio), verdict: r.verdict, provisional: r.provisional,
      outcomes: r.outcomes.map((o) => ({ label: o.label, move: r4(o.move), volPts: r2(o.volPts), change: r2(o.change) })),
      warnings: safe(r.warnings),
    }))
    const notes = [...safe(v.warnings), ...(rows.dropped === 0 ? [] : [droppedSymbols(rows.dropped)])]
    if (withheld > 0) notes.push(`${withheld} more ${withheld === 1 ? 'note' : 'notes'} on the book pages (legs the master does not know)`)
    const due = out.filter((r) => r.next !== null).length
    return {
      result: { ...envelope(ctx, { asOf: v.asOf, warnings: notes }), calendarAsOf: v.calendarAsOf, rows: out },
      summary: `${out.length} ${out.length === 1 ? 'book' : 'books'}, ${due} with a results date`,
    }
  },
}
