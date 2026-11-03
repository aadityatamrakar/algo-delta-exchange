/**
 * `get_risk`: the trader's books under market shocks, as the Risk page reads them (`riskView`, the route's own
 * function and its 60 s cache) — each book's beta and correlation to NIFTY, β-weighted delta, the change for NIFTY
 * ±1%, the 2σ day loss and its share; the stress grid (NIFTY move × vol shift); the historical replay (VaR, ES and the
 * worst days); the correlated clusters; and the one-line headline. Every rupee figure is a CHANGE from now, not P&L.
 *
 * The result is one object of named parts, so the results-event half (Lane B's `EventRiskView`) is one more field
 * beside `risk`. The view's trader name is not copied (R5); warnings pass `safeWarnings` and rows `nseRows` (R11).
 */

import { z } from 'zod'
import type { RiskView } from '../../analytics/risk-wire.ts'
import { riskView } from '../../routes/risk.ts'
import { droppedSymbols, envelope, nseRows, r2, r4, safeWarnings, type AgentTool } from './ctx.ts'

const noInput = z.object({}).strict()

const SYM = '[A-Z0-9&-]{1,20}'
/** The risk view's own lines (analytics/portfolio-risk.ts, shock.ts): server-authored around an NSE symbol, so they reach the model as they are. */
const RISK_LINES: readonly RegExp[] = [
  new RegExp(`^${SYM}: beta needs \\d+ days of returns aligned with NIFTY; \\d+ held$`),
  new RegExp(`^${SYM}: no HV20 — the day's σ is the near ATM IV's$`),
  new RegExp(`^${SYM}: no HV20 and no near ATM IV — no 2σ loss$`),
  new RegExp(`^${SYM}: under \\d+ days of history — left out of the replay$`),
  new RegExp(`^${SYM}: no book view — no delta$`),
  new RegExp(`^${SYM}: left out of the grid cells it could not be valued in$`),
  new RegExp(`^${SYM}: cannot be repriced — left out of the replay$`),
  new RegExp(`^no spot price for ${SYM} — not repriced$`),
  new RegExp(`^β-weighted Δ and NIFTY ±1% leave out ${SYM}(, ${SYM})*$`),
  /^No NIFTY history: /,
  /^Historical replay needs \d+ days on which every held stock has a return; \d+ held$/,
]

/** The risk lines as they are; every other line (a book's own, which may quote file text) through `safeWarnings` (R11). */
export function riskWarnings(lines: readonly string[]): string[] {
  const ours = lines.filter((l) => RISK_LINES.some((re) => re.test(l)))
  return [...new Set([...ours, ...safeWarnings(lines.filter((l) => !RISK_LINES.some((re) => re.test(l))))])]
}

/** The RiskView as the model reads it: rounded, no trader name, only NSE symbols. */
export function riskResult(v: RiskView): { readonly result: Record<string, unknown>; readonly dropped: number } {
  const books = nseRows(v.books, (b) => b.stock)
  const keep = new Set(books.rows.map((b) => b.stock))
  return {
    dropped: books.dropped,
    result: {
      headline: v.headline,
      nifty: v.nifty,
      totals: {
        betaDeltaRupees: r2(v.totals.betaDeltaRupees), niftyLots: r2(v.totals.niftyLots),
        niftyUp1Change: r2(v.totals.niftyUp1), niftyDown1Change: r2(v.totals.niftyDown1),
      },
      books: books.rows.map((b) => ({
        stock: b.stock, beta: r4(b.beta), betaDays: b.betaDays, niftyCorr: r4(b.niftyCorr),
        deltaShares: r2(b.deltaShares), deltaRupees: r2(b.deltaRupees), betaDeltaRupees: r2(b.betaDeltaRupees),
        niftyUp1Change: r2(b.niftyUp1), niftyDown1Change: r2(b.niftyDown1), daySigma: r4(b.daySigma),
        twoSigmaLoss: r2(b.twoSigmaLoss), sharePct: r2(b.sharePct),
      })),
      stressGrid: {
        niftyMovePct: v.grid.moves, volShiftPts: v.grid.vols,
        change: v.grid.cells.map((row) => row.map((c) => r2(c))),
        worstBook: v.grid.worst.map((row) => row.map((s) => (s !== null && keep.has(s) ? s : null))),
        excluded: v.grid.excluded.filter((e) => keep.has(e.stock)),
      },
      replay: {
        days: v.replay.days, var95: r2(v.replay.var95), var99: r2(v.replay.var99), es99: r2(v.replay.es99),
        worstDays: v.replay.worstDays.map((d) => ({
          date: d.date, change: r2(d.change), niftyPct: r2(d.niftyPct),
          books: d.books.filter((b) => keep.has(b.stock)).map((b) => ({ stock: b.stock, change: r2(b.change), movePct: r2(b.movePct) })),
        })),
        notes: v.replay.notes,
      },
      clusters: v.clusters.filter((c) => c.stocks.every((s) => keep.has(s))).map((c) => ({
        stocks: c.stocks, meanCorr: r4(c.meanCorr), togetherLoss: r2(c.togetherLoss), standaloneLoss: r2(c.standaloneLoss),
      })),
    },
  }
}

export const getRisk: AgentTool<z.infer<typeof noInput>> = {
  name: 'get_risk',
  description: 'The trader\'s books under market shocks, every figure a change from now (not P&L): per book beta and correlation to NIFTY, β-weighted delta, the change for NIFTY +1% and −1%, the 2σ day loss and its share; the stress grid (NIFTY −10% to +10% × vol −5 to +10 points, each stock moved beta × NIFTY); the historical replay of today\'s books through the last year\'s daily moves (VaR 95/99, ES 99, the three worst days); clusters of stocks that move together; and the one worst case as a headline.',
  input: noInput,
  label: () => 'reading the risk',
  async run(ctx) {
    const nowMs = ctx.deps.now()
    const v = await riskView(ctx.deps, ctx.trader, nowMs)
    const risk = riskResult(v)
    const notes = [...v.warnings, ...v.books.flatMap((b) => b.warnings)]
    return {
      result: {
        ...envelope(ctx, { asOf: v.asOf, warnings: [...riskWarnings(notes), ...(risk.dropped === 0 ? [] : [droppedSymbols(risk.dropped)])] }),
        risk: risk.result,
      },
      summary: v.headline ?? `${v.books.length} ${v.books.length === 1 ? 'book' : 'books'}, no stress figure`,
    }
  },
}
