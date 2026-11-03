/**
 * BOOK SERIES — the durable name a dated book's history is grouped under.
 *
 * A delta-lean book lives one trading day: `NIFTY-delta-lean-aggressive-
 * 2026-10-01` is created that morning, stopped the next, erased the session
 * after. The tag has to stay dated (it is the order-bus key, `cumRealized`
 * runs per tag, `expiry` is part of the book's identity), but a Reports page
 * keyed by tag then shows twenty one-day strategies a month instead of one.
 *
 * The SERIES is the label that fixes that: `NIFTY-delta-lean-aggressive` by
 * default (`deriveSeries`), carried on the registry row and ALSO written here,
 * once per `{tag, mode}`, at create time. This collection is the part that
 * must outlive the book — `eraseBook` deletes the registry row two sessions
 * later, and `purgeTagHistory` deletes the trading history — so neither of
 * them touches it. The daily reports keyed by the tag stay where they are;
 * this row is what says which series a tag belonged to after the registry has
 * forgotten it.
 *
 * TWO GROUPINGS fall out of the same rows:
 *   - series  (`symbol-variant`)  — one line a day for one index and preset;
 *   - variant (the preset alone)  — NIFTY and SENSEX summed per day.
 *
 * NOTHING HERE PARSES A TAG. Tags on this desk come in two shapes (the current
 * `NIFTY-delta-lean-aggressive-2026-10-01` and the legacy
 * `NIFTY-2026-09-22-delta-lean-aggressive`), and membership comes from the
 * `symbol`/`variant`/`series` fields the book was registered with, or from the
 * audit log's record of that registration (`migrate.ts`), never from the text.
 */

import type { DeskMode } from './contract.ts'
import { isDuplicateKey } from './errors.ts'
import { COLLECTIONS, type Database } from './store.ts'

export { deriveSeries } from './books-registry.ts'

/** One book's series membership. Immutable once written. */
export interface SeriesRow {
  readonly tag: string
  readonly mode: DeskMode
  readonly series: string
  readonly symbol: string
  readonly variant: string
  /** The book's contract expiry — what marks an expiry DAY on the Reports page. */
  readonly expiry: string
  readonly createdAt: number
}

/** One series as the Reports picker lists it. */
export interface SeriesSummary {
  readonly series: string
  readonly symbol: string
  readonly variant: string
  /** Every tag filed under this series on this rail, oldest registration first. */
  readonly tags: readonly string[]
  /** tag -> that book's expiry. */
  readonly expiries: Readonly<Record<string, string>>
  /** First and last day any of its tags reported, or null when none has yet. */
  readonly firstDate: string | null
  readonly lastDate: string | null
}

/** Which rows a report is aggregated over: exactly one of the two groupings. */
export type SeriesSelector = { readonly series: string } | { readonly variant: string }

/**
 * Read a stored document defensively. A row that is missing any field is not
 * a membership anyone can rely on, so it is dropped rather than half-used.
 */
export function seriesRowFromDoc(doc: Record<string, unknown> | null): SeriesRow | null {
  if (doc === null) return null
  const str = (k: string): string | null => {
    const v = doc[k]
    return typeof v === 'string' && v !== '' ? v : null
  }
  const tag = str('tag')
  const series = str('series')
  const symbol = str('symbol')
  const variant = str('variant')
  const expiry = str('expiry')
  const mode = doc['mode']
  if (tag === null || series === null || symbol === null || variant === null || expiry === null) return null
  if (mode !== 'paper' && mode !== 'live') return null
  const createdAt = typeof doc['createdAt'] === 'number' && Number.isFinite(doc['createdAt']) ? doc['createdAt'] : 0
  return { tag, mode, series, symbol, variant, expiry, createdAt }
}

/**
 * Write a tag's series membership — INSERT ONLY.
 *
 * `$setOnInsert`, never `$set`: the first statement of which series a tag
 * belongs to is the one its reports were filed under, and a later write (a
 * re-registration of the same tag, a backfill run twice) must not re-file
 * them. Returns which of the two happened so the backfill can count.
 */
export async function recordSeries(db: Database, row: SeriesRow): Promise<'recorded' | 'exists'> {
  try {
    const res = await db.collection(COLLECTIONS.bookSeries).updateOne(
      { tag: row.tag, mode: row.mode },
      {
        $setOnInsert: {
          tag: row.tag,
          mode: row.mode,
          series: row.series,
          symbol: row.symbol,
          variant: row.variant,
          expiry: row.expiry,
          createdAt: row.createdAt,
        },
      },
      { upsert: true },
    )
    return (res.matchedCount ?? 0) > 0 ? 'exists' : 'recorded'
  } catch (err) {
    // Two concurrent upserts on one {tag, mode}: the unique index refuses the
    // second, which is exactly "it already exists".
    if (isDuplicateKey(err)) return 'exists'
    throw err
  }
}

/** Every series row on one rail, oldest registration first. */
export async function listSeriesRows(db: Database, mode: DeskMode): Promise<SeriesRow[]> {
  const docs = await db
    .collection(COLLECTIONS.bookSeries)
    .find({ mode })
    .sort({ createdAt: 1, tag: 1 })
    .toArray()
  return docs.map((d) => seriesRowFromDoc(d)).filter((r): r is SeriesRow => r !== null)
}

/** The rows one selector covers on one rail — a series, or a whole variant across symbols. */
export async function tagsFor(db: Database, sel: SeriesSelector, mode: DeskMode): Promise<SeriesRow[]> {
  const filter = 'series' in sel ? { mode, series: sel.series } : { mode, variant: sel.variant }
  const docs = await db.collection(COLLECTIONS.bookSeries).find(filter).sort({ createdAt: 1, tag: 1 }).toArray()
  return docs.map((d) => seriesRowFromDoc(d)).filter((r): r is SeriesRow => r !== null)
}

/**
 * The picker's view of the rows: one entry per series, plus the distinct
 * variants. Pure — the report spans are read by the caller.
 *
 * A series whose tags have not reported yet is still listed (a book created
 * this morning), with null dates rather than invented ones.
 */
export function summariseSeries(
  rows: readonly SeriesRow[],
  spans: ReadonlyMap<string, { readonly first: string; readonly last: string }>,
): { series: SeriesSummary[]; variants: string[] } {
  const groups = new Map<string, SeriesRow[]>()
  for (const r of rows) {
    const g = groups.get(r.series)
    if (g === undefined) groups.set(r.series, [r])
    else g.push(r)
  }
  const series: SeriesSummary[] = []
  for (const [name, members] of groups) {
    const ordered = [...members].sort((a, b) => a.createdAt - b.createdAt || a.tag.localeCompare(b.tag))
    let firstDate: string | null = null
    let lastDate: string | null = null
    const expiries: Record<string, string> = {}
    for (const m of ordered) {
      expiries[m.tag] = m.expiry
      const span = spans.get(m.tag)
      if (span === undefined) continue
      if (firstDate === null || span.first < firstDate) firstDate = span.first
      if (lastDate === null || span.last > lastDate) lastDate = span.last
    }
    const head = ordered[0]!
    series.push({
      series: name,
      // A series is one symbol and one variant by construction; the first
      // registration speaks for it.
      symbol: head.symbol,
      variant: head.variant,
      tags: ordered.map((m) => m.tag),
      expiries,
      firstDate,
      lastDate,
    })
  }
  series.sort((a, b) => a.series.localeCompare(b.series))
  const variants = [...new Set(rows.map((r) => r.variant))].sort()
  return { series, variants }
}
