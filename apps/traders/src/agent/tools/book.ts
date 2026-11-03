/**
 * One book, read the way its pages read it: `get_book` (the BookView, the
 * Analysis window's To Neutralize and Δ0, the payoff summary, the band and
 * each live expiry's series P&L — open + booked − charges, the P&L answer;
 * the Day MTM beside it is today's view, and Open P&L is the legs against
 * their net price; three names, three definitions, none standing in for another),
 * `get_margin` (NSE SPAN + exposure, `bookMargin`) and `get_advice`
 * (relief-r's card, `BookRisk.advice`).
 *
 * Every result is built field by field: a leg is its alias and its contract,
 * never its key, client code or note; a warning is a server line or it is
 * counted, never quoted (spec R5, R11).
 */

import { z } from 'zod'
import { parseAnalysisQuery } from '../../analytics/analysis.ts'
import { bookMargin, MARGIN_CHECKED, NO_SPAN_NOTE, SHARES_NOTE, UNCHECKED_NOTE } from '../../analytics/margin.ts'
import { SHARES_NOTE as SERIES_SHARES_NOTE } from '../../analytics/series-pnl.ts'
import type { MtmBlock } from '../../analytics/wire.ts'
import { STOCK_RE } from '../../books/manual.ts'
import { istDate } from '../../routes/kit.ts'
import type { BookView, SeriesPnl } from '../../types.ts'
import { envelope, r2, r4, safeWarnings, ToolRefusal, type AgentTool, type ToolCtx } from './ctx.ts'

const DAY_MS = 86_400_000

export const stockInput = z.object({ stock: z.string().min(1).max(20).describe('NSE symbol, e.g. TCS') }).strict()
export type StockInput = z.infer<typeof stockInput>

/** Upper case and checked; a refusal the model can act on otherwise. */
export function stockOf(raw: string): string {
  const s = raw.trim().toUpperCase()
  if (!STOCK_RE.test(s)) throw new ToolRefusal(`"${raw}" is not an NSE symbol (1–20 letters, digits, & or -)`)
  return s
}

export const noBook = (stock: string): ToolRefusal => new ToolRefusal(`no open book ${stock} for this trader`)

export async function bookViewOf(ctx: ToolCtx, stock: string, nowMs: number): Promise<BookView> {
  const view = await ctx.deps.bookView(ctx.trader, stock, nowMs)
  if (view === null) throw noBook(stock)
  return view
}

/** Calendar days from today (IST) to an expiry; 0 on the day. */
export function daysTo(expiry: string | null, nowMs: number): number | null {
  if (expiry === null || expiry === '') return null
  return Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${istDate(nowMs)}T00:00:00Z`)) / DAY_MS))
}

const SERIES_NOTE = 'series P&L = open legs at LTP (net price, partial closes in it) + P&L booked on the expiry\'s contracts already closed − charges; '
  + 'dayMtm is today\'s move only (carried legs from yesterday\'s close, today\'s trades, less the charges on today\'s fills), not the position\'s P&L; '
  + 'openPnl is the open legs against their net price, before charges'

/** One series as the model reads it: numbers, dates, and the legs with no LTP by alias. */
function seriesOf(ctx: ToolCtx, s: SeriesPnl) {
  return {
    expiry: s.expiry, open: r2(s.open), booked: r2(s.booked), gross: r2(s.gross), charges: r2(s.charges), net: r2(s.net),
    closedContracts: s.closedContracts, openLegs: s.openLegs, firstTrade: s.from, bookedSince: s.since,
    noLtpLegs: s.noLtp.map((k) => ctx.aliases.alias(k)),
  }
}

/** The MTM block as the model reads it: one figure, Day MTM, with why it is null when it is. */
function dayMtmOf(m: MtmBlock) {
  const value = r2(m.current.total)
  return {
    value, carriedLegs: r2(m.current.previous), tradedToday: r2(m.current.today), leavesOut: m.partial.length,
    unknownBecause: value !== null ? null : m.dayReason ?? "yesterday's close is unknown",
    openCycleChargesExcluded: r2(m.openCycleCharges), ratesConfirmed: m.ratesConfirmed,
  }
}

export const getBook: AgentTool<StockInput> = {
  name: 'get_book',
  description: 'One open book: legs (aliased L1…) with price, IV, greeks and Open P&L; totals; delta in shares and lots; Δ0 and its gap from spot; '
    + 'To Neutralize (future lots); breakevens, POP, max loss on the ±10% expiry scan, worst ±5/±10% shock today; Day MTM (today\'s move; null before 09:15 and on a closed day, with the reason); '
    + 'series P&L per live expiry (open legs + booked on closed contracts − charges); the delta band; days to expiry.',
  input: stockInput,
  label: (i) => `reading ${i.stock.toUpperCase()}`,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const nowMs = ctx.deps.now()
    const view = await bookViewOf(ctx, stock, nowMs)
    const params = parseAnalysisQuery(new URLSearchParams())
    if ('error' in params) throw new Error(params.error)
    const [analysis, band] = await Promise.all([ctx.deps.analysisOf(ctx.trader, stock, params, nowMs), ctx.deps.risk.band(ctx.trader, stock, nowMs)])
    const lotSize = analysis?.lotSize ?? null
    const lots = (shares: number): number | null => (lotSize !== null && lotSize > 0 ? r2(shares / lotSize) : null)
    const p = view.payoff?.summary ?? null
    const tn = analysis?.toNeutralize ?? null
    const nearExpiry = analysis?.nearExpiry ?? null
    const legs = view.legs.map((l) => ({
      leg: ctx.aliases.alias(l.key),
      instrument: l.instrument, expiry: l.instrument === 'share' ? '' : l.expiry, strike: l.strike, optType: l.optType,
      qty: l.qty, lots: l.lotSize !== null && l.lotSize > 0 ? r2(l.qty / l.lotSize) : null, avgPrice: r2(l.avgPrice),
      ltp: r2(l.ltp), iv: r4(l.iv), delta: r2(l.delta), gamma: r4(l.gamma), vega: r2(l.vega), theta: r2(l.theta), openPnl: r2(l.mtm),
      source: l.source, matched: l.matched,
    }))
    const result = {
      ...envelope(ctx, { asOf: view.asOf, closed: view.closed, warnings: safeWarnings(view.warnings) }),
      stock, spot: r2(view.spot), future: r2(analysis?.future ?? null), lotSize,
      nearExpiry, daysToExpiry: analysis?.daysToExpiry ?? daysTo(nearExpiry, nowMs),
      totals: {
        deltaShares: r2(view.totals.delta), deltaLots: lots(view.totals.delta), gamma: r4(view.totals.gamma),
        vega: r2(view.totals.vega), theta: r2(view.totals.theta), openPnl: r2(view.totals.mtm),
      },
      delta0: tn === null ? null : { price: r2(tn.price), gapPctFromSpot: r2(tn.pct), gapRupees: tn.price === null || view.spot === null ? null : r2(tn.price - view.spot) },
      toNeutralize: tn === null ? null : { side: tn.side, lots: Math.abs(tn.lots), contract: tn.contract, shares: tn.units, text: tn.text },
      payoff: p === null ? null : {
        basis: 'open legs only: booked P&L is in series, not in these figures',
        popPct: r2(p.pop * 100), maxLossOnScan: r2(p.maxLoss), maxLossAt: r2(p.maxLossAt), maxProfitOnScan: r2(p.maxProfit),
        worstShock: r2(p.worstShock), worstShockAt: r2(p.worstShockAt), netCredit: r2(p.netCredit),
        // no `booked` here: the view prices its open legs on realised 0, and the series carry what was booked
        breakevens: { down: r2(p.breakevens.down), up: r2(p.breakevens.up) },
        note: 'max loss is the worst point of the ±10% expiry scan, not a bound: short premium can lose more beyond it; '
          + 'plans from search_adjustments add the expiry series\' booked P&L to max loss, the shock and EV',
      },
      // Day MTM: null (with its reason) before 09:15, on a closed day, or with yesterday's close unknown; the charges in it are today's fills' only
      dayMtm: analysis === null ? null : dayMtmOf(analysis.mtm),
      // an older bag sends no series: null, and the model says so rather than reading the day's MTM as the P&L
      series: view.series === undefined ? null : view.series.map((s) => seriesOf(ctx, s)),
      seriesTotal: view.seriesTotal === undefined ? null : {
        open: r2(view.seriesTotal.open), booked: r2(view.seriesTotal.booked), gross: r2(view.seriesTotal.gross),
        charges: r2(view.seriesTotal.charges), net: r2(view.seriesTotal.net), closedContracts: view.seriesTotal.closedContracts,
        firstTrade: view.seriesTotal.from, chargesEstimated: !view.seriesTotal.ratesConfirmed,
        sharesLeftOut: view.seriesTotal.notes.includes(SERIES_SHARES_NOTE), note: SERIES_NOTE,
      },
      band: band === null ? null : {
        state: band.state, netDeltaShares: r2(band.netDelta), bandLots: band.bandLots, outByLots: band.outByLots, source: band.source, sentence: band.sentence,
      },
      legs,
      unmatchedLegs: view.unmatched.length,
    }
    const dl = result.totals.deltaLots
    return { result, summary: `${stock}: ${legs.length} legs, delta ${dl === null ? `${result.totals.deltaShares} sh` : `${dl} lots`}` }
  },
}

const SAFE_MARGIN_NOTES = new Set([UNCHECKED_NOTE, SHARES_NOTE, NO_SPAN_NOTE])

export const getMargin: AgentTool<StockInput> = {
  name: 'get_margin',
  description: "The book's NSE SPAN + exposure margin from the exchange's own files, the day's peak so far, and its parts. "
    + '`checked: false` means it is not yet reconciled with a broker figure: say so when margin matters.',
  input: stockInput,
  label: (i) => `margin ${i.stock.toUpperCase()}`,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const nowMs = ctx.deps.now()
    const m = await bookMargin(ctx.deps, ctx.trader, stock, nowMs)
    if (m === null) throw noBook(stock)
    const notes = m.notes.filter((n) => SAFE_MARGIN_NOTES.has(n))
    const unnamed = m.notes.length - notes.length
    return {
      result: {
        ...envelope(ctx, { stale: m.stale, warnings: m.stale ? ['the SPAN file is from an earlier business day'] : [] }),
        stock, available: m.available, checked: MARGIN_CHECKED,
        // the exchange's own file, whole or not: partial when it could not price every contract or there is no exposure rate
        marginSource: m.available ? 'span' : null, marginPartial: m.available && (m.missing.length > 0 || m.exposureFile === null),
        total: r2(m.total), initial: r2(m.initial), exposure: r2(m.exposure), peakToday: r2(m.peak?.total ?? null),
        parts: m.parts === null ? null : Object.fromEntries(Object.entries(m.parts).map(([k, v]) => [k, r2(v)])),
        spanBusinessDate: m.span?.businessDate ?? null,
        contractsNotPriced: m.missing.length,
        notes: unnamed > 0 ? [...notes, `${unnamed} more ${unnamed === 1 ? 'note' : 'notes'} on the Margin tab`] : notes,
      },
      summary: m.total === null ? `${stock}: no margin figure` : `${stock}: margin ₹${Math.round(m.total).toLocaleString('en-IN')}`,
    }
  },
}

export const getAdvice: AgentTool<StockInput> = {
  name: 'get_advice',
  description: "The desk engine's (relief-r) advice card for the book from a clean rule state, and the delta band it reads. Suggestions only.",
  input: stockInput,
  label: (i) => `advice ${i.stock.toUpperCase()}`,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const nowMs = ctx.deps.now()
    const card = await ctx.deps.risk.advice(ctx.trader, stock, nowMs)
    if (card === null) throw noBook(stock)
    return {
      result: {
        ...envelope(ctx, { asOf: card.asOf }),
        stock, status: card.status, headline: card.headline, lines: card.lines, reason: card.reason, trigger: card.trigger,
        notes: card.notes,
        band: { state: card.band.state, netDeltaShares: r2(card.band.netDelta), bandLots: card.band.bandLots, outByLots: card.band.outByLots, sentence: card.band.sentence },
      },
      summary: `${stock}: ${card.headline}`,
    }
  },
}
