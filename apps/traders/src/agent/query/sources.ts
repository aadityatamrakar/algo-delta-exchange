/**
 * Where each dataset's rows come from (spec §6.3): the functions the pages
 * already use, bound to the signed-in trader by `ToolCtx`. Every row is built
 * field by field from the catalogue — a client code, an exchange order id, a
 * note or a rejection reason is never copied (R5, R11).
 *
 * daily_bars, intraday_bars and levels are market data (Lane 2's history,
 * intraday bars and market context): nobody's, so no trader filter applies.
 */

import { BAND_EVENTS_MAX_DAYS, DAILY_BARS_DEFAULT, DAILY_BARS_MAX, RECORDS_MAX_DAYS, type DatasetName } from './catalogue.ts'
import type { DataQuery, Row } from './execute.ts'
import type { BandEvent } from '../../analytics/band.ts'
import { countsInPnl } from '../../analytics/portfolio.ts'
import { STOCK_RE } from '../../books/manual.ts'
import { IST_OFFSET_MS, istDate } from '../../routes/kit.ts'
import { traderPortfolio } from '../../routes/portfolio.ts'
import { NO_VOL_SNAPSHOT, volRowOf } from '../../routes/vol.ts'
import { heldStocks } from '../../market/held.ts'
import { isOpenLeg, type TraderOrder, type TraderTrade } from '../../types.ts'
import { CHAIN_AROUND_MAX, readChain } from '../tools/chain.ts'
import { daysTo } from '../tools/book.ts'
import { contextOf } from '../tools/market.ts'
import { r2, r4, safeWarnings, type ToolCtx } from '../tools/ctx.ts'

const DAY_MS = 86_400_000
const NO_ID = { projection: { _id: 0 } } as const
/** A query reads at most this many stored rows; the executor's limit and summary do the rest. */
export const SOURCE_MAX_ROWS = 5000

export interface SourceRows {
  readonly rows: readonly Row[]
  readonly warnings: readonly string[]
  readonly closed?: boolean
}

export type RowSource = (ctx: ToolCtx, q: DataQuery) => Promise<SourceRows>

const istTime = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
const sinceDay = (nowMs: number, days: number): string => istDate(nowMs - (days - 1) * DAY_MS)

/** ODIN's order status words to five plain ones: the file's own text never reaches the model. */
export function orderStatus(s: string): 'filled' | 'open' | 'cancelled' | 'rejected' | 'other' {
  const t = s.toLowerCase()
  if (t.includes('reject')) return 'rejected'
  if (t.includes('cancel')) return 'cancelled'
  if (t.includes('trad') || t.includes('fill') || t.includes('complete') || t.includes('execut')) return 'filled'
  if (t.includes('open') || t.includes('pend') || t.includes('trigger') || t.includes('modif') || t.includes('new')) return 'open'
  return 'other'
}

/** The trader's open books by NSE symbol; a symbol that is not one (file text) never becomes a book to read (R11). */
async function openStocks(ctx: ToolCtx, only: string | undefined): Promise<string[]> {
  const today = istDate(ctx.deps.now())
  const stocks = new Set((await ctx.deps.legs.open(ctx.trader)).filter((l) => isOpenLeg(l, today)).map((l) => l.stock))
  return [...stocks].filter((s) => STOCK_RE.test(s) && (only === undefined || s === only)).sort()
}

const books: RowSource = async (ctx) => {
  const nowMs = ctx.deps.now()
  const today = istDate(nowMs)
  const [v, legs] = await Promise.all([traderPortfolio(ctx.deps, ctx.trader, nowMs), ctx.deps.legs.open(ctx.trader)])
  const open = legs.filter((l) => isOpenLeg(l, today))
  const noDay = v.rows.filter((r) => r.mtmDay === null).length
  // a shares-only book has no P&L to count: only a real unknown leaves a pnl sum short
  const noPnl = v.rows.filter((r) => countsInPnl(r) && (r.pnl ?? null) === null).length
  const of = (n: number): string => `${n} of ${v.rows.length} ${v.rows.length === 1 ? 'book has' : 'books have'}`
  return {
    rows: v.rows.map((r) => {
      const mine = open.filter((l) => l.stock === r.stock)
      const near = mine.filter((l) => l.instrument !== 'share').map((l) => l.expiry).sort()[0] ?? null
      return {
        stock: r.stock, spot: r2(r.spot), lotSize: r.lotSize, delta: r2(r.delta), gamma: r4(r.gamma), vega: r2(r.vega), theta: r2(r.theta),
        deltaLots: r2(r.deltaLots), pnl: r2(r.pnl), dayMtm: r2(r.mtmDay), openPnl: r2(r.openPnl), margin: r2(r.margin), band: r.band,
        legCount: mine.length, nearExpiry: near, daysToExpiry: daysTo(near, nowMs),
      }
    }),
    // a sum skips nulls: said here, so a Day MTM sum over some of the books is never read as the whole
    warnings: [
      ...(noDay === 0 ? [] : [`${of(noDay)} no Day MTM (null): a sum of dayMtm leaves ${noDay === 1 ? 'it' : 'them'} out and is not the whole`]),
      ...(noPnl === 0 ? [] : [`${of(noPnl)} no P&L (null, an open leg has no LTP): a sum of pnl leaves ${noPnl === 1 ? 'it' : 'them'} out and is not the whole`]),
    ],
  }
}

const legs: RowSource = async (ctx, q) => {
  const nowMs = ctx.deps.now()
  const rows: Row[] = []
  const warnings: string[] = []
  let closed = false
  for (const stock of await openStocks(ctx, q.params?.stock)) {
    const view = await ctx.deps.bookView(ctx.trader, stock, nowMs)
    if (view === null) continue
    closed = view.closed
    for (const w of safeWarnings(view.warnings)) warnings.push(`${stock}: ${w}`)
    for (const l of view.legs) {
      rows.push({
        leg: ctx.aliases.alias(l.key), stock, instrument: l.instrument, expiry: l.instrument === 'share' ? '' : l.expiry,
        strike: l.strike, optType: l.optType, qty: l.qty, lots: l.lotSize !== null && l.lotSize > 0 ? r2(l.qty / l.lotSize) : null,
        avgPrice: r2(l.avgPrice), ltp: r2(l.ltp), iv: r4(l.iv), delta: r2(l.delta), gamma: r4(l.gamma), vega: r2(l.vega), theta: r2(l.theta),
        openPnl: r2(l.mtm), source: l.source, matched: l.matched,
      })
    }
  }
  return { rows, warnings, closed }
}

const trades: RowSource = async (ctx, q) => {
  const days = Math.min(q.params?.days ?? 7, RECORDS_MAX_DAYS)
  const f: Record<string, unknown> = { trader: ctx.trader, day: { $gte: sinceDay(ctx.deps.now(), days) } }
  if (q.params?.stock !== undefined) f['stock'] = q.params.stock
  const stored = await ctx.deps.db.collection<TraderTrade>('traders-trades').find(f, NO_ID).sort({ day: -1, time: -1 }).limit(SOURCE_MAX_ROWS).toArray()
  return {
    rows: stored.map((t) => ({
      day: t.day, time: istTime(t.time), stock: t.stock, instrument: t.instrument, expiry: t.expiry, strike: t.strike, optType: t.optType,
      side: t.side, qty: t.qty, price: r2(t.price), value: r2(t.qty * t.price),
    })),
    warnings: stored.length >= SOURCE_MAX_ROWS ? [`only the newest ${SOURCE_MAX_ROWS} trades were read`] : [],
  }
}

const orders: RowSource = async (ctx, q) => {
  const days = Math.min(q.params?.days ?? 7, RECORDS_MAX_DAYS)
  const f: Record<string, unknown> = { trader: ctx.trader, day: { $gte: sinceDay(ctx.deps.now(), days) } }
  if (q.params?.stock !== undefined) f['stock'] = q.params.stock
  const stored = await ctx.deps.db.collection<TraderOrder>('traders-orders').find(f, NO_ID).sort({ day: -1, time: -1 }).limit(SOURCE_MAX_ROWS).toArray()
  return {
    rows: stored.map((o) => ({
      day: o.day, time: istTime(o.time), stock: o.stock, instrument: o.instrument, expiry: o.expiry, strike: o.strike, optType: o.optType,
      side: o.side, qty: o.qty, price: r2(o.price), status: orderStatus(o.status), filledQty: o.filledQty,
    })),
    warnings: stored.length >= SOURCE_MAX_ROWS ? [`only the newest ${SOURCE_MAX_ROWS} orders were read`] : [],
  }
}

const portfolioMonths: RowSource = async (ctx, q) => {
  const v = await traderPortfolio(ctx.deps, ctx.trader, ctx.deps.now())
  return {
    rows: v.rows
      .filter((r) => q.params?.stock === undefined || r.stock === q.params.stock)
      .flatMap((r) => r.months.map((m) => ({
        stock: r.stock, expiry: m.expiry, delta: r2(m.delta), gamma: r4(m.gamma), vega: r2(m.vega), theta: r2(m.theta), pnl: r2(m.pnl), openPnl: r2(m.mtm),
      }))),
    warnings: [],
  }
}

const chain: RowSource = async (ctx, q) => {
  const c = await readChain(ctx, q.params?.stock as string, q.params?.expiry ?? null, CHAIN_AROUND_MAX)
  return {
    rows: c.rows,
    warnings: [`${c.stock} ${c.expiry}: forward ${c.forward ?? 'unknown'} (${c.forwardSource ?? 'no source'}), lot ${c.lotSize ?? 'unknown'}, ${c.quoted} quotes held`],
    closed: c.closed,
  }
}

const bandEvents: RowSource = async (ctx, q) => {
  const days = Math.min(q.params?.days ?? 30, BAND_EVENTS_MAX_DAYS)
  const f: Record<string, unknown> = { trader: ctx.trader, kind: 'band', at: { $gte: ctx.deps.now() - days * DAY_MS } }
  if (q.params?.stock !== undefined) f['stock'] = q.params.stock
  const stored = await ctx.deps.db.collection<BandEvent>('traders-events').find(f, NO_ID).sort({ at: -1 }).limit(SOURCE_MAX_ROWS).toArray()
  return {
    rows: stored.map((e) => ({
      at: istTime(e.at), stock: e.stock, from: e.from, to: e.to, netDelta: r2(e.netDelta), bandShares: r2(e.bandShares),
      lotSize: e.lotSize, outByLots: r2(e.outByLots), source: e.source,
    })),
    warnings: [],
  }
}

const dailyBars: RowSource = async (ctx, q) => {
  const stock = q.params?.stock as string
  const bars = ctx.deps.history.bars(stock, Math.min(q.params?.days ?? DAILY_BARS_DEFAULT, DAILY_BARS_MAX))
  const fut = bars.filter((b) => b.src === 'fut').length
  const warnings: string[] = []
  if (bars.length === 0) warnings.push(`no daily history for ${stock} yet (no end-of-day summary lists it)`)
  else if (fut === bars.length) warnings.push(`NSE's end-of-day files carry no OHLC for ${stock}: these are its near future's bars`)
  else if (fut > 0) warnings.push(`${fut} of these days had no cash row for ${stock}: their bars are the near future's`)
  return {
    rows: bars.map((b) => ({
      date: b.date, open: r2(b.open), high: r2(b.high), low: r2(b.low), close: r2(b.close), volume: b.volume,
      futClose: r2(b.futClose), futOi: b.futOi, ceOi: b.ceOi, peOi: b.peOi, atmIv: r4(b.atmIv), maxPain: r2(b.maxPain), src: b.src,
    })),
    warnings,
  }
}

const intradayBars: RowSource = async (ctx, q) => {
  const stock = q.params?.stock as string
  const nowMs = ctx.deps.now()
  const today = istDate(nowMs)
  // the context's reference by default: an index's daily bars are its future's, so its intraday ones are too
  const of = q.params?.of ?? (ctx.deps.history.latest(stock)?.src === 'fut' ? 'future' : 'spot')
  const cov = ctx.deps.intraday.coverage()
  const bars = cov.day === today ? ctx.deps.intraday.bars(stock, q.params?.interval ?? '15m', of) : []
  const warnings: string[] = []
  if (bars.length === 0) warnings.push(`no ticks of ${stock}'s ${of} sampled today`)
  else if (cov.since !== null && cov.since > Date.parse(`${today}T09:15:00+05:30`)) {
    warnings.push(`today's bars are built in memory from ${istTime(cov.since).slice(11, 16)} IST, when the app began sampling; earlier ones are lost`)
  }
  return {
    rows: bars.map((b) => ({ t: istTime(b.t), o: r2(b.o), h: r2(b.h), l: r2(b.l), c: r2(b.c), v: b.v })),
    warnings: [`bars of the ${of}`, ...warnings],
  }
}

const levels: RowSource = async (ctx, q) => {
  const c = await contextOf(ctx, q.params?.stock as string)
  return {
    rows: c.levels.map((l) => ({ price: r2(l.price), kind: l.kind, strength: l.strength, distancePct: r2(l.distancePct), basis: l.basis })),
    warnings: [`distances are from the ${c.reference ?? 'spot'}`, ...c.warnings],
    closed: c.closed,
  }
}

/** The /vol page's rows for the trader's held stocks: the same function, the same history and chain snapshots. */
const vol: RowSource = async (ctx) => {
  const today = istDate(ctx.deps.now())
  const d = {
    vol: ctx.deps.vol, bars: (s: string, n: number) => ctx.deps.history.bars(s, n), adjustments: (s: string, n: number) => ctx.deps.history.adjustments(s, n),
    calendar: ctx.deps.calendar, expiries: (s: string) => ctx.deps.master().options.expiries(s),
  }
  const rows = heldStocks(await ctx.deps.legs.open(ctx.trader), today).filter((s) => STOCK_RE.test(s)).map((s) => volRowOf(d, s, today))
  const warnings = rows.flatMap((r) => r.warnings.map((w) => `${r.stock}: ${w}`))
  if (ctx.deps.vol.status().latest === null) warnings.unshift(NO_VOL_SNAPSHOT)
  return {
    rows: rows.map((r) => ({
      stock: r.stock, asOf: r.asOf, iv: r4(r.iv), ivSource: r.ivSource, ivRank: r2(r.ivRank), ivPercentile: r2(r.ivPercentile), ivDays: r.ivDays,
      hv10: r4(r.hv10), hv20: r4(r.hv20), nseHv: r4(r.nseHv), vrp: r4(r.vrp), vrpRatio: r4(r.vrpRatio), vrpPercentile: r2(r.vrpPercentile), vrpDays: r.vrpDays,
      realizedVrpMean: r4(r.realizedVrp?.mean ?? null), realizedVrpPositivePct: r2(r.realizedVrp?.positivePct ?? null), realizedVrpDays: r.realizedVrp?.days ?? 0,
      nearExpiry: r.nearExpiry, nearIv: r4(r.nearIv), nextExpiry: r.nextExpiry, nextIv: r4(r.nextIv), skew25: r4(r.skew25),
      resultsDate: r.results?.date ?? null, resultsExpiry: r.results?.expiry ?? null, resultsInNear: r.results?.inNear ?? false,
    })),
    warnings,
  }
}

const SOURCES: Partial<Record<DatasetName, RowSource>> = {
  books, legs, trades, orders, portfolio_months: portfolioMonths, chain, band_events: bandEvents,
  daily_bars: dailyBars, intraday_bars: intradayBars, levels, vol,
}

/** The source of a dataset in this app, or null when it is not available here (yet). */
export function sourceOf(_ctx: ToolCtx, name: DatasetName): RowSource | null {
  return SOURCES[name] ?? null
}
