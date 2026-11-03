/**
 * Per-strategy P&L: the live figures and the intraday snapshot series.
 *
 * API contract §3 fixes both shapes and the frontend is built against them, so
 * the field names here are not free to change. The one rule worth restating at
 * the wire: `unrealised` and `total` are `null`, never `0`, when any open leg
 * could not be marked, with the offending contracts named in `unpriced` and
 * `complete: false`. A P&L of ₹0 and a P&L of "three legs could not be marked"
 * rendering identically is the defect already fixed once in the positions
 * endpoint (Phase B §8).
 *
 * The arithmetic is not here. It is `rollup.ts` (pure) over `@algomaker/pnl`,
 * reached through `pnl-jobs.ts` — the same call the 15-second snapshot makes, so
 * a card and its own chart cannot disagree.
 */

import type { ApiDeps, Route, RouteCtx } from './kit.ts'
import { istDate, istDayRange, limitOf, modeOf } from './kit.ts'
import { PnlStore } from '../pnlstore.ts'
import { pnlFor, type PnlOptions } from '../pnl-jobs.ts'

export function pnlRoutes(deps: ApiDeps, opts: PnlOptions = {}): Route {
  const store = new PnlStore(deps.db)

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, url, send } = ctx

    if (path === '/v1/desk/pnl' && method === 'GET') {
      /**
       * Served from the in-memory `LiveBook` when one is loaded, and from a
       * 30-day scan of `desk-decisions` when it is not.
       *
       * The endpoint's SHAPE and its answer are identical either way — both go
       * through `pnlFromFills` — because this endpoint is the fallback the whole
       * push design rests on, not something the socket replaces.
       */
      const mode = modeOf(url)
      const summary = await pnlFor(deps, store, opts, mode, deps.now())
      send(200, await withSinceEntry(deps, summary, mode))
      return true
    }

    if (path === '/v1/desk/pnl/series' && method === 'GET') {
      const tag = url.searchParams.get('tag')
      if (tag === null || tag === '') {
        // No "all strategies" series: two books interleaved on one time axis is
        // not a chart of anything, and silently picking one would label another
        // strategy's curve with the wrong name.
        send(400, { error: 'tag is required' })
        return true
      }
      const mode = modeOf(url)
      const today = istDayRange(istDate(deps.now()))
      const from = epochParam(url, 'from') ?? today.from
      const to = epochParam(url, 'to') ?? today.to
      if (to <= from) {
        send(400, { error: 'to must be after from' })
        return true
      }
      const points = await store.series({ tag, mode, from, to, limit: limitOf(url, 5000, 50_000) })
      send(200, {
        tag,
        mode,
        // Only the four fields the chart plots. `tag` and `mode` are already on
        // the envelope, and repeating them on 1,500 points is pure payload.
        points: points.map((p) => ({
          ts: p.ts,
          realised: p.realised,
          unrealised: p.unrealised,
          total: p.total,
        })),
      })
      return true
    }

    return false
  }
}

/**
 * An epoch-ms query param. Null when absent OR unparseable — a `from=yesterday`
 * that silently became 0 would return every snapshot ever taken.
 */
/**
 * ONE P&L PER STOCK BOOK, EVERYWHERE (operator's call 2026-08-18).
 *
 * The rollup above is a pure journal fold, and for a desk book the journal is
 * not the book: entries get restated by reconciliation and relief migrations,
 * seeds enter without fills, and the rollup's window clips. The book page
 * already shows the BOOK-STATE figure — open legs marked against their stored
 * entries plus realised-to-date — so the chips must say the same number, or
 * every session starts with "why are these different".
 *
 * Enriched HERE, not in the rollup: `pnlFor` also feeds the 15-second
 * snapshot series, whose points must stay the journal's own story.
 *
 * FAIL-SOFT PER ROW. The chips are the first thing on the page; a book whose
 * positions read failed keeps its journal figure rather than costing the
 * whole feed.
 */
async function withSinceEntry<
  T extends { strategies: readonly { tag: string }[] },
>(deps: ApiDeps, summary: T, mode: 'paper' | 'live'): Promise<T> {
  const strategies = await Promise.all(
    summary.strategies.map(async (s) => {
      try {
        const doc = await deps.db.collection('desk-books').findOne({ tag: s.tag, mode })
        if (doc === null) return s
        const pos = await deps.service.positions(s.tag, mode, { realised: true })
        const marks = new Map(pos.greeks.legs.map((l) => [l.tradingsymbol, l.price]))
        let open = 0
        let sinceEntry: number | null = 0
        for (const leg of pos.legs) {
          if (leg.qty === 0) continue
          const mark = marks.get(leg.instrument.tradingsymbol)
          if (mark === undefined) {
            // One unpriced open leg makes the figure unknown, never a
            // confident number understated by an unknown amount — the same
            // rule the rollup's own `total` states.
            sinceEntry = null
            break
          }
          open += (mark - leg.entryPrice) * leg.qty
        }
        if (sinceEntry !== null) {
          const realised = pos.realised ?? null
          sinceEntry = realised === null ? open : open + realised
        }
        return { ...s, sinceEntry }
      } catch {
        return s
      }
    }),
  )
  return { ...summary, strategies }
}

function epochParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}
