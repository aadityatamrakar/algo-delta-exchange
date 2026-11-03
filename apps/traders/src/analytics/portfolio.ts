/**
 * Portfolio (spec item 26): a row per open book of one trader — its delta in
 * shares and in the nearest listed future's lots, its greeks, its P&L (the
 * series net), Day MTM ("Today") and Open P&L, its NSE SPAN margin and its
 * band — with totals and the month-wise split; and the admin's roll-up, per
 * trader and per underlying across traders. Pure: the route gathers each
 * book's inputs; the series ride on its BookView (the cached series reader).
 *
 * Delta is never added across underlyings in shares (a TCS share is not a
 * NIFTY unit): the totals carry its money value, Σ delta × spot. A figure that
 * is not the one its column names, or leaves something out, says so in
 * `warnings`; so does each book's own BookView warning (a dead feed, a stale
 * price), once, with the books that carry it.
 */

import type { BookView } from '../types.ts'
import type { BandStatus } from './band.ts'
import type { AdminPortfolioView, MonthRow, PortfolioRow, PortfolioTotals, PortfolioView, StockAcross } from './r3-wire.ts'
import type { MarginView, MtmBlock } from './wire.ts'

export type { AdminPortfolioView, MonthRow, PortfolioRow, PortfolioTotals, PortfolioView, StockAcross } from './r3-wire.ts'

/** One book's inputs: `lotSize` is the nearest listed future's lot (null = none listed). */
export interface PortfolioInput {
  readonly view: BookView; readonly lotSize: number | null
  readonly mtm: MtmBlock | null; readonly margin: MarginView | null; readonly band: BandStatus | null
}

export const RATES_NOT_CONFIRMED = 'charges rates not confirmed — Today and P&L after charges are estimates until an admin confirms them'

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const lotsOf = (delta: number, lotSize: number | null): number | null => (lotSize !== null && lotSize > 0 ? delta / lotSize : null)
/** null as soon as one is null: a total of the known ones would read as the whole. */
const addKnown = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b)

/** Why a book's P&L is null. The first two have nothing to count; only a missing LTP is a real unknown. */
export const PNL_NO_SERIES = 'no series'
export const PNL_NO_LIVE_EXPIRY = 'no live expiry'
export const PNL_NO_LTP = 'an open leg has no LTP'
/** Said once when a book holds shares: they have no expiry, so no series. */
export const SHARES_NOT_IN_PNL = 'P&L counts F&O series only — shares not included'

/** A book with nothing to count (shares only, or no series from the server) is left out of every P&L sum, never made unknown. */
export const countsInPnl = (r: Pick<PortfolioRow, 'pnlReason'>): boolean => r.pnlReason !== PNL_NO_SERIES && r.pnlReason !== PNL_NO_LIVE_EXPIRY

/** The rows' P&L: the counted ones summed, null as soon as one is unknown; null too when none counts (0 would read as flat). */
function pnlSum(rows: readonly PortfolioRow[]): { readonly pnl: number | null; readonly pnlReason: string | null } {
  const counted = rows.filter(countsInPnl)
  if (counted.length === 0) return { pnl: null, pnlReason: rows.length === 0 ? null : PNL_NO_LIVE_EXPIRY }
  const pnl = counted.reduce<number | null>((sum, r) => addKnown(sum, r.pnl ?? null), 0)
  return { pnl, pnlReason: pnl === null ? PNL_NO_LTP : null }
}

/**
 * By leg expiry, ascending; the shares ('' expiry) last. A leg with no MTM adds none. Each month's P&L is its series'
 * net; a live series the book holds no leg of (its contracts all closed) is a month of its own, so the months add up.
 */
function monthsOf(view: BookView): MonthRow[] {
  const by = new Map<string, { expiry: string; delta: number; gamma: number; vega: number; theta: number; mtm: number }>()
  const monthOf = (expiry: string) => {
    let m = by.get(expiry)
    if (m === undefined) {
      m = { expiry, delta: 0, gamma: 0, vega: 0, theta: 0, mtm: 0 }
      by.set(expiry, m)
    }
    return m
  }
  for (const l of view.legs) {
    const m = monthOf(l.expiry)
    m.delta += l.delta; m.gamma += l.gamma; m.vega += l.vega; m.theta += l.theta; m.mtm += l.mtm ?? 0
  }
  const series = new Map((view.series ?? []).map((x) => [x.expiry, x.net] as const))
  for (const expiry of series.keys()) monthOf(expiry)
  return [...by.values()]
    .map((m) => ({ ...m, pnl: series.get(m.expiry) ?? null }))
    .sort((a, b) => Number(a.expiry === '') - Number(b.expiry === '') || byText(a.expiry, b.expiry))
}

/** P&L: the book's series net, or null with why (no series from the reader, no live expiry, an open leg with no LTP). */
function pnlOf(view: BookView): { readonly pnl: number | null; readonly pnlReason: string | null } {
  if (view.seriesTotal === undefined) return { pnl: null, pnlReason: PNL_NO_SERIES }
  if ((view.series?.length ?? 0) === 0) return { pnl: null, pnlReason: PNL_NO_LIVE_EXPIRY }
  const net = view.seriesTotal.net
  return net === null ? { pnl: null, pnlReason: PNL_NO_LTP } : { pnl: net, pnlReason: null }
}

function rowOf(b: PortfolioInput, warnings: string[]): PortfolioRow {
  const { view, mtm, margin, band } = b
  const stock = view.stock
  const t = view.totals
  if (view.spot === null) warnings.push(`${stock}: no spot price — left out of the delta value`)
  // Day MTM ("Today") is the block's total or nothing: the legs' Open P&L never stands in for it under that name (G5)
  const day = mtm?.current.total ?? null
  const dayReason = mtm?.dayReason ?? null
  // a market-state reason is the same for every book: said once, by portfolioOf
  if (day === null && dayReason === null) warnings.push(`${stock}: Today is not shown — ${mtm === null ? 'no MTM block' : "yesterday's close is unknown"}`)
  const partial = mtm?.partial.length ?? 0
  if (partial > 0) warnings.push(`${stock}: Today leaves out ${partial} ${partial === 1 ? 'contract' : 'contracts'} it cannot price`)
  return {
    stock, spot: view.spot, lotSize: b.lotSize,
    delta: t.delta, deltaLots: lotsOf(t.delta, b.lotSize), gamma: t.gamma, vega: t.vega, theta: t.theta,
    mtmDay: day, mtmDayReason: day === null ? dayReason : null, openPnl: t.mtm, ...pnlOf(view),
    margin: margin !== null && margin.available ? margin.total : null, marginLabel: margin?.span?.label ?? null,
    band: band?.state ?? null, bandSentence: band?.sentence ?? null, months: monthsOf(view),
  }
}

function totalsOf(rows: readonly PortfolioRow[]): PortfolioTotals {
  let deltaValue = 0; let vega = 0; let theta = 0; let openPnl = 0; let margin = 0
  let mtmDay: number | null = 0
  const marginMissing: string[] = []
  for (const r of rows) {
    if (r.spot !== null) deltaValue += r.delta * r.spot
    vega += r.vega; theta += r.theta; openPnl += r.openPnl
    mtmDay = addKnown(mtmDay, r.mtmDay)
    if (r.margin === null) marginMissing.push(r.stock)
    else margin += r.margin
  }
  const outOfBand = rows.filter((r) => r.band === 'out').length
  return { books: rows.length, outOfBand, deltaValue, vega, theta, mtmDay, openPnl, ...pnlSum(rows), margin, marginMissing }
}

/** Each text once, prefixed with what carries it, in first-seen order. */
function grouped(items: readonly { readonly by: string; readonly texts: readonly string[] }[]): string[] {
  const said = new Map<string, string[]>()
  for (const { by, texts } of items) {
    for (const w of texts) {
      const who = said.get(w)
      if (who === undefined) said.set(w, [by])
      else if (!who.includes(by)) who.push(by)
    }
  }
  return [...said].map(([w, who]) => `${who.join(', ')}: ${w}`)
}

export function portfolioOf(trader: string, books: readonly PortfolioInput[], nowMs: number): PortfolioView {
  const sorted = [...books].sort((a, b) => byText(a.view.stock, b.view.stock))
  const warnings: string[] = []
  const rows = sorted.map((b) => rowOf(b, warnings))
  for (const reason of new Set(rows.flatMap((r) => (r.mtmDayReason === null ? [] : [r.mtmDayReason])))) warnings.push(`Today is not shown — ${reason}`)
  if (sorted.some((b) => b.mtm !== null && !b.mtm.ratesConfirmed)) warnings.push(RATES_NOT_CONFIRMED)
  if (sorted.some((b) => b.view.legs.some((l) => l.instrument === 'share'))) warnings.push(SHARES_NOT_IN_PNL)
  warnings.push(...grouped(sorted.map((b) => ({ by: b.view.stock, texts: b.view.warnings }))))
  return { trader, asOf: nowMs, rows, totals: totalsOf(rows), warnings }
}

export function adminPortfolioOf(views: readonly PortfolioView[], nowMs: number): AdminPortfolioView {
  const sorted = [...views].sort((a, b) => byText(a.trader, b.trader))
  const by = new Map<string, {
    stock: string; traders: number; delta: number; gamma: number; vega: number; theta: number
    mtmDay: number | null; openPnl: number; rows: PortfolioRow[]; margin: number; lotSize: number | null; missing: string[]
  }>()
  for (const v of sorted) {
    for (const r of v.rows) {
      let s = by.get(r.stock)
      if (s === undefined) {
        s = { stock: r.stock, traders: 0, delta: 0, gamma: 0, vega: 0, theta: 0, mtmDay: 0, openPnl: 0, rows: [], margin: 0, lotSize: null, missing: [] }
        by.set(r.stock, s)
      }
      s.traders += 1
      s.delta += r.delta; s.gamma += r.gamma; s.vega += r.vega; s.theta += r.theta
      s.mtmDay = addKnown(s.mtmDay, r.mtmDay)
      s.openPnl += r.openPnl
      s.rows.push(r)
      if (r.margin === null) s.missing.push(v.trader)
      else s.margin += r.margin
      s.lotSize ??= r.lotSize
    }
  }
  const across = [...by.values()].sort((a, b) => byText(a.stock, b.stock))
  const stocks: StockAcross[] = across.map((s) => ({
    stock: s.stock, traders: s.traders, delta: s.delta, deltaLots: lotsOf(s.delta, s.lotSize),
    gamma: s.gamma, vega: s.vega, theta: s.theta, mtmDay: s.mtmDay, openPnl: s.openPnl, ...pnlSum(s.rows), margin: s.margin,
  }))
  const warnings = [
    ...sorted.flatMap((v) => v.warnings.map((w) => `${v.trader}: ${w}`)),
    ...across.filter((s) => s.missing.length > 0).map((s) => `${s.stock}: margin leaves out ${s.missing.join(', ')} (not available)`),
  ]
  return { asOf: nowMs, traders: sorted.map((v) => ({ trader: v.trader, totals: v.totals })), stocks, warnings }
}
