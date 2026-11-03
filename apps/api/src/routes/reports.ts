/**
 * Daily rollups, the per-day order log, and the retention prune.
 *
 * API contract §4. Two behaviours here are the whole point of the module:
 *
 *  - A day whose rollup was never written is RECOMPUTED FROM FILLS and returned
 *    with `source: 'computed'`, rather than shown as a blank row. A rollup
 *    missed while a process was down is repairable, not a permanent hole
 *    (Phase B §5) — and the operator can see which rows were repaired on read.
 *
 *  - The prune never deletes a day whose rollup has not been written, and says
 *    which strategy is missing for every day it skips. `dryRun` mutates nothing.
 */

import type { ApiDeps, Route, RouteCtx } from './kit.ts'
import { isIsoDate, istDate, limitOf, modeOf } from './kit.ts'
import { PnlStore, pnlKey } from '../pnlstore.ts'
import { keepDaysOf, rollupDate, runPrune, type PnlOptions } from '../pnl-jobs.ts'
import type { DailyReport } from '../rollup.ts'
import type { DeskMode } from '../contract.ts'
import { listSeriesRows, summariseSeries, tagsFor } from '../book-series.ts'

/** Where a row came from. `computed` means no rollup existed and we rebuilt it. */
type RowSource = 'rollup' | 'computed'

export function reportRoutes(deps: ApiDeps, opts: PnlOptions = {}): Route {
  const store = new PnlStore(deps.db)

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, url, send, log } = ctx

    if (path === '/v1/desk/reports' && method === 'GET') {
      const date = url.searchParams.get('date') ?? istDate(deps.now())
      if (!isIsoDate(date)) {
        send(400, { error: `date must be an IST calendar day as YYYY-MM-DD, got '${date}'` })
        return true
      }
      const stored = await store.reportsFor(date)
      const have = new Set(stored.map((r) => pnlKey(r.tag, r.mode)))
      const rows: (DailyReport & { source: RowSource })[] = stored.map((r) => ({
        ...r,
        source: 'rollup',
      }))
      // Recompute only what is missing. A stored rollup is never overwritten by
      // a read: the number written at the close is the record, and silently
      // re-marking it on every page load would make a report that changes.
      for (const r of await rollupDate(deps, store, opts, date, deps.now())) {
        if (have.has(pnlKey(r.tag, r.mode))) continue
        rows.push({ ...r, source: 'computed' })
      }
      rows.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))

      /**
       * TOTALS ARE PER MODE. Paper money is never added to live money.
       *
       * Summing across both produced a headline figure in which a simulated
       * +₹300 cancelled a real −₹500 into "−₹200" — a number that is true of
       * nothing. `/v1/desk/pnl` is already per-mode, so an unscoped total here
       * also made the two pages disagree for reasons an operator cannot see.
       *
       * `totals` keeps its shape and reports the mode asked for (default paper,
       * as everywhere else); `totalsByMode` carries both so the page can show
       * them side by side without ever adding them.
       */
      interface ModeTotals {
        realised: number
        total: number | null
        orderCount: number
        /** How many strategy-rows this mode's figures are made of. */
        strategies: number
      }
      /**
       * `total` STARTS UNKNOWN, and a mode with no rows keeps it that way.
       *
       * It was seeded at 0, so a day on which the live rail did not trade — or
       * on which the rollup job never ran — reported a confident `₹0` for live.
       * That is the same "0 is not a number we computed" failure `numberOrNull`,
       * `PnlRow.total` and `DailyReport.total` all exist to avoid, arriving one
       * layer higher up. `strategies` is what lets the page tell "flat" from
       * "no data" without having to re-derive it from `rows`.
       *
       * `realised` stays a number: it is a sum, and the sum of no rows is
       * genuinely 0. `strategies: 0` beside it says how much that is worth.
       */
      const blank = (): ModeTotals => ({ realised: 0, total: null, orderCount: 0, strategies: 0 })
      const byMode: Record<'paper' | 'live', ModeTotals> = { paper: blank(), live: blank() }
      for (const r of rows) {
        const t = byMode[r.mode]
        t.realised += r.realised
        t.orderCount += r.orderCount
        // One strategy the day could not price makes that mode's total unknown,
        // not the sum of the ones that happened to price. The first priced row
        // is what turns the mode's total from "no data" into a number.
        if (r.total === null) t.total = null
        else if (t.strategies === 0) t.total = r.total
        else if (t.total !== null) t.total += r.total
        t.strategies++
      }
      send(200, { date, rows, totals: byMode[modeOf(url)], totalsByMode: byMode })
      return true
    }

    if (path === '/v1/desk/reports/orders' && method === 'GET') {
      const date = url.searchParams.get('date') ?? istDate(deps.now())
      if (!isIsoDate(date)) {
        send(400, { error: `date must be an IST calendar day as YYYY-MM-DD, got '${date}'` })
        return true
      }
      /**
       * `from` — THE LOG SINCE A DAY, for a book that outlives the session.
       *
       * OPTIONAL, so every existing caller keeps the single-day journal it asks
       * for today: a hosted strategy is intraday by contract and a day IS its
       * history. A POSITIONAL book is held for weeks, and the dashboard passes
       * the day its registry row was created so the log can start where the
       * book did rather than at this morning's open.
       */
      const from = url.searchParams.get('from')
      if (from !== null && !isIsoDate(from)) {
        send(400, { error: `from must be an IST calendar day as YYYY-MM-DD, got '${from}'` })
        return true
      }
      if (from !== null && from > date) {
        send(400, { error: `from (${from}) is after date (${date})` })
        return true
      }
      const tag = url.searchParams.get('tag')
      const events = await store.orderEvents({
        date,
        ...(from === null ? {} : { from }),
        ...(tag === null || tag === '' ? {} : { tag }),
        // Scoped to the mode the navbar switch says, like every other page.
        // Unscoped, this fed paper refusals to a LIVE log and — worse — showed
        // a PAPER log nothing at all, because the paper rail's fills are in a
        // different collection entirely.
        mode: modeOf(url),
        failuresOnly: url.searchParams.get('failures') === '1',
        limit: limitOf(url, 500),
      })
      // `from` is echoed only when one was asked for: a caller that sent none
      // is being answered about ONE day, and a `from` in the body it did not
      // ask for is a window it would have to check rather than read.
      send(200, { date, ...(from === null ? {} : { from }), events })
      return true
    }

    /**
     * ONE strategy's history over a RANGE — the reports page's main view.
     *
     * The whole-day summary it replaces answered "how did the desk do on this
     * date". This answers "how has this strategy been doing", which is the
     * question an operator deciding whether to keep running something actually
     * has. The default range is three months, set by the client.
     *
     * Days with no stored rollup are ABSENT rather than zero-filled, and
     * `missingDays` says how many fell in the window without one. A gap where a
     * process was down and a genuine flat day must not draw the same line.
     */
    if (path === '/v1/desk/reports/history' && method === 'GET') {
      /**
       * EXACTLY ONE SELECTOR: a `tag` (one book, unchanged), a `series` (one
       * symbol-variant across its dated tags), or a `variant` (the strategy,
       * every symbol summed). Two is refused rather than resolved by a
       * precedence nobody can see from the URL. A blank value counts as absent.
       */
      const param = (k: string): string | null => {
        const v = url.searchParams.get(k)
        return v === null || v === '' ? null : v
      }
      const tag = param('tag')
      const seriesName = param('series')
      const variant = param('variant')
      const given = [tag, seriesName, variant].filter((v) => v !== null).length
      if (given !== 1) {
        send(400, {
          error:
            given === 0
              ? 'one of tag, series or variant is required — this endpoint reports one strategy'
              : 'give exactly one of tag, series or variant — not two',
        })
        return true
      }
      const to = url.searchParams.get('to') ?? istDate(deps.now())
      const from = url.searchParams.get('from') ?? istDate(deps.now() - 90 * 24 * 60 * 60 * 1000)
      if (!isIsoDate(from) || !isIsoDate(to)) {
        send(400, { error: `from and to must be IST calendar days as YYYY-MM-DD` })
        return true
      }
      if (from > to) {
        send(400, { error: `from (${from}) is after to (${to})` })
        return true
      }

      if (tag === null) {
        // A grouping spans books, so guessing the rail would silently answer
        // about the wrong money. The `tag` form keeps `modeOf` for the
        // callers it has always had.
        const mode = explicitMode(url)
        if (mode === null) {
          send(400, MODE_PARAM_REQUIRED)
          return true
        }
        const selector = seriesName !== null ? { series: seriesName } : { variant: variant! }
        const members = await tagsFor(deps.db, selector, mode)
        const tags = members.map((m) => m.tag)
        const expiries: Record<string, string> = {}
        for (const m of members) expiries[m.tag] = m.expiry
        /**
         * THE VARIANT VIEW SPLITS PER SYMBOL: summing NIFTY and SENSEX is the
         * point of the view, but an operator must still see which one made the
         * money. The symbol is the series row's, never the tag's text. A series
         * is one symbol by construction, so its view carries no split.
         */
        let symbols: Record<string, string> | undefined
        if (variant !== null) {
          symbols = {}
          for (const m of members) symbols[m.tag] = m.symbol
        }
        const days = await store.reportHistoryForTags({
          tags,
          mode,
          from,
          to,
          expiries,
          ...(symbols === undefined ? {} : { symbols }),
        })
        send(200, {
          ...selector,
          mode,
          from,
          to,
          // Every tag in the grouping, reported in range or not.
          tags,
          // Every symbol in the grouping, sorted — the variant view's columns.
          ...(symbols === undefined ? {} : { symbols: [...new Set(Object.values(symbols))].sort() }),
          rows: days,
          totals: rangeTotals(days),
          missingDays: countIstWeekdays(from, to) - days.length,
        })
        return true
      }

      const mode = modeOf(url)
      const rows = await store.reportHistory({ tag, mode, from, to })

      send(200, {
        tag,
        mode,
        from,
        to,
        rows,
        totals: rangeTotals(rows),
        // Trading days in the window with no rollup written. Not an error —
        // a strategy that was off has no rows — but the page must be able to
        // distinguish "flat" from "we have no record".
        missingDays: countIstWeekdays(from, to) - rows.length,
      })
      return true
    }

    /**
     * Tags that have been rolled up, for the report picker — on the rail named
     * by `?mode=`, or on either when none is given (the shape every caller had
     * before the filter existed). A mode that is neither is refused, not read
     * as paper.
     */
    if (path === '/v1/desk/reports/tags' && method === 'GET') {
      const raw = url.searchParams.get('mode')
      const mode = explicitMode(url)
      if (raw !== null && mode === null) {
        send(400, MODE_PARAM_REQUIRED)
        return true
      }
      send(200, { tags: await store.reportedTags(mode ?? undefined) })
      return true
    }

    /**
     * The series and the variants on one rail — the Reports picker's first two
     * groups. See `book-series.ts`. Mode is required: the same series name on
     * the two rails is two different sets of money.
     */
    if (path === '/v1/desk/reports/series' && method === 'GET') {
      const mode = explicitMode(url)
      if (mode === null) {
        send(400, MODE_PARAM_REQUIRED)
        return true
      }
      const rows = await listSeriesRows(deps.db, mode)
      send(200, summariseSeries(rows, await store.reportSpans(mode)))
      return true
    }

    if (path === '/v1/desk/reports/dates' && method === 'GET') {
      send(200, { dates: await store.activityDates(limitOf(url, 90, 400)) })
      return true
    }

    if (path === '/v1/desk/reports/prune' && method === 'POST') {
      const body = ((await ctx.readJson()) ?? {}) as Record<string, unknown>
      /**
       * DEFAULTS TO A PREVIEW. `dryRun` has to be said explicitly to be false:
       * deleting a month of intraday detail because a caller omitted a field is
       * not a failure mode worth having, and the portal's flow is preview-then-
       * execute anyway (Phase B §6).
       */
      const dryRun = body['dryRun'] !== false
      const rawKeep = Number(body['keepDays'] ?? keepDaysOf(opts))
      if (!Number.isFinite(rawKeep) || rawKeep < 1) {
        send(400, { error: 'keepDays must be a positive number of days' })
        return true
      }
      const keepDays = Math.floor(rawKeep)
      const result = await runPrune(store, { nowMs: deps.now(), keepDays, dryRun })
      const skipped = result.days.filter((d) => d.action === 'skip')
      log(dryRun ? 'snapshot prune previewed' : 'snapshot prune executed', {
        keepDays,
        deleted: result.deleted,
        skipped: skipped.map((d) => `${d.date}: ${d.reason}`),
      })
      send(200, {
        // Different key by design: a caller must not be able to read a preview's
        // number as "deleted" because it forgot which mode it asked for.
        ...(dryRun ? { wouldDelete: result.deleted } : { deleted: result.deleted }),
        dryRun,
        keepDays,
        days: result.days,
      })
      return true
    }

    return false
  }
}

/** `?mode=` read strictly: 'paper' or 'live', or null — never a default. */
function explicitMode(url: URL): DeskMode | null {
  const raw = url.searchParams.get('mode')
  return raw === 'paper' || raw === 'live' ? raw : null
}

const MODE_PARAM_REQUIRED = { error: "mode must be stated explicitly as '?mode=paper' or '?mode=live'" }

/**
 * Summed across the range. `total` goes null if ANY day could not be marked —
 * the same discipline as everywhere else: a range total that silently omits an
 * unmarked day is a number nobody can reconcile.
 */
function rangeTotals(
  rows: readonly { realised: number; total: number | null; orderCount: number }[],
): { realised: number; total: number | null; orderCount: number; days: number } {
  let realised = 0
  let orderCount = 0
  let total: number | null = 0
  for (const r of rows) {
    realised += r.realised
    orderCount += r.orderCount
    if (r.total === null) total = null
    else if (total !== null) total += r.total
  }
  return { realised, total, orderCount, days: rows.length }
}

/**
 * Weekdays between two IST dates, inclusive. An approximation of "trading days"
 * that ignores exchange holidays deliberately: a holiday calendar goes stale and
 * then suppresses a real trading day, which is a worse failure than counting a
 * handful of holidays as missing. The number is only ever used to say "N days in
 * this window have no rollup", never to compute money.
 */
function countIstWeekdays(from: string, to: string): number {
  const DAY = 24 * 60 * 60 * 1000
  let n = 0
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) n++
  }
  return n
}
