/**
 * `get_track_record` (spec 2026-11-01 P4): the trader's own record — each option series' entry, short strikes'
 * distance, wings, adjustment days, move from entry, held to expiry or not, and P&L — and the summary buckets the
 * desk-record playbook compares a book against (analytics/track-record.ts).
 *
 * WHY here and not query_data: the record joins three things the model must never join itself — the trades, the
 * history's closes and the Booked ledger's net (R2: numbers come from tools). The P&L is the Booked page's own row
 * (`deps.booked`, the reader the page uses), so the chat and the page show one figure for a series.
 *
 * Every series of the trader is worked out once per trader, leg version, history version and day (the Booked
 * reader's rule, five minutes at most) and the window and stock are cut from it, so asking for TCS after the whole
 * desk costs nothing. Only stock, instrument, expiry, strike, type, side, qty and day are read from a trade: never a
 * client code, order or trade number (R5/R11), and a series whose symbol is not an NSE symbol is dropped and counted.
 */

import { z } from 'zod'
import { BOOKED_TTL_MS } from '../../analytics/booked.ts'
import { TtlCache } from '../../analytics/cache.ts'
import {
  TRACK_MAX_ROWS, TRACK_MONTHS_DEFAULT, TRACK_MONTHS_MAX, trackRecord, trackSeries, windowStart,
  type TrackFill, type TrackSeries,
} from '../../analytics/track-record.ts'
import { isIndexFrom } from '../../ingest/settlement.ts'
import { MAX_HISTORY_DAYS } from '../../market/history.ts'
import { istDate } from '../../routes/kit.ts'
import { stockOf } from './book.ts'
import { droppedSymbols, envelope, nseRows, type AgentDeps, type AgentTool, type ToolCtx } from './ctx.ts'

const trackInput = z.object({
  stock: z.string().min(1).max(20).optional().describe('NSE symbol, e.g. TCS; omit for every stock'),
  months: z.number().int().min(1).max(TRACK_MONTHS_MAX).optional().describe(`Months of expiries back from today, 1–${TRACK_MONTHS_MAX} (default ${TRACK_MONTHS_DEFAULT})`),
}).strict()
type TrackInput = z.infer<typeof trackInput>

/** What a trade is read for: the record's fields only. */
const TRACK_FIELDS = { _id: 0, stock: 1, instrument: 1, expiry: 1, strike: 1, optType: 1, side: 1, qty: 1, day: 1 } as const

/** One cache per app (its deps object), so two apps in one process never share a trader's record. */
const caches = new WeakMap<AgentDeps, TtlCache<readonly TrackSeries[]>>()

/** Every option series of the trader expiring in the longest window, or live. */
function seriesOf(ctx: ToolCtx, nowMs: number): Promise<readonly TrackSeries[]> {
  const d = ctx.deps
  let cache = caches.get(d)
  if (cache === undefined) { cache = new TtlCache(BOOKED_TTL_MS, { maxEntries: 200 }); caches.set(d, cache) }
  const today = istDate(nowMs)
  return cache.get(`${ctx.trader}|${d.legs.version(ctx.trader)}|${d.history.version()}|${today}`, nowMs, async () => {
    const floor = windowStart(today, TRACK_MONTHS_MAX)
    const [fills, ledger] = await Promise.all([
      d.db.collection<TrackFill>('traders-trades')
        .find({ trader: ctx.trader, instrument: { $in: ['option', 'future'] }, expiry: { $gte: floor } }, { projection: TRACK_FIELDS })
        .toArray(),
      d.booked(ctx.trader, nowMs),
    ])
    return trackSeries({
      fills, today, ledger, isIndex: isIndexFrom(d.master),
      close: (stock, day) => d.history.close(stock, day),
      bars: (stock) => d.history.bars(stock, MAX_HISTORY_DAYS),
    })
  })
}

export const getTrackRecord: AgentTool<TrackInput> = {
  name: 'get_track_record',
  description: 'The trader\'s own track record, from their trades: each option series (stock, expiry) with its entry day and days to expiry then, '
    + 'the short call\'s and put\'s distance out of the money from the previous close (%), wings bought on entry, days with adjustments after entry, contracts traded, '
    + 'the largest move up (maxUpPct ≥ 0) and down (maxDownPct ≤ 0) from entry to expiry, or to the last trade when closed before it (%), held to expiry or closed before, the last trade\'s days to expiry, '
    + 'and P&L — the Booked page\'s net for that stock and expiry, after charges (a live series has none; open: true). '
    + `Plus a summary of the expired series: wins, win rate, median win and loss, the worst tenth's loss against all wins, buckets by move from entry, by adjustment days and held vs closed before, and the typical entry — stock and index series apart. `
    + `Newest ${TRACK_MAX_ROWS} rows; the summary covers the whole window. No live price is read. Optional stock; months 1–${TRACK_MONTHS_MAX} (default ${TRACK_MONTHS_DEFAULT}).`,
  input: trackInput,
  label: (i) => (i.stock === undefined ? 'reading your track record' : `reading your track record on ${i.stock.trim().toUpperCase()}`),
  async run(ctx, input) {
    const stock = input.stock === undefined ? null : stockOf(input.stock)
    const months = input.months ?? TRACK_MONTHS_DEFAULT
    const nowMs = ctx.deps.now()
    const today = istDate(nowMs)
    const [all, ledger] = await Promise.all([seriesOf(ctx, nowMs), ctx.deps.booked(ctx.trader, nowMs)])
    const from = windowStart(today, months)
    // R11: a symbol is file text until it passes STOCK_RE — such a series of the window is left out of the rows and the
    // summary, and counted (asked for one stock, the dropped ones are not it and go unsaid)
    const clean = nseRows(all.filter((s) => s.open || s.expiry >= from), (s) => s.stock)
    const rec = trackRecord(clean.rows, { from, stock, ledger })
    const dropped = stock === null ? clean.dropped : 0
    const notes = [...rec.notes, ...(dropped === 0 ? [] : [droppedSymbols(dropped)])]
    const expired = (rec.summary.stock?.n ?? 0) + (rec.summary.index?.n ?? 0)
    const wins = (rec.summary.stock?.wins ?? 0) + (rec.summary.index?.wins ?? 0)
    return {
      result: {
        ...envelope(ctx, { warnings: notes }),
        stock, months, from: rec.from,
        units: { money: 'rupees', pct: 'percent', winRate: 'percent of the series with a P&L', days: 'calendar days' },
        summary: rec.summary,
        series: rec.series,
        rows: { shown: rec.series.length, total: rec.total, truncated: rec.truncated },
        ...(rec.truncated ? { rowsNote: `the newest ${rec.series.length} of ${rec.total} series are listed; the summary covers all of them` } : {}),
      },
      summary: `${expired} expired series, ${wins} won${rec.open === 0 ? '' : `; ${rec.open} open`}`,
    }
  },
}
