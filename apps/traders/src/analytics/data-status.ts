/**
 * Data status (admin): for each trader and each of the last trading days, did the data arrive — the files, the
 * trade lines, the order rows, the rejected orders — and is the watcher up.
 *
 * WHY: a trader whose PC or watcher was down for two days has no files and so no trades on those days, and nothing
 * on the pages says so: their book simply looks quiet, and the P&L built on it is silently short. The one tell is
 * that the OTHER traders traded. That is the flag: no files for a trader on a day when another trader had trade
 * lines. (Known case: jignesh, 13 and 14 Oct 2026, while the others traded.)
 *
 * Files are counted by the day the trader's PC last wrote them (`mtime`), not by when the server received them.
 * ODIN's file names carry no year, and the receive time is the wrong day for anything uploaded late: on this
 * server every file carries a received time of 20–22 Oct, from the backfill, so by receive time every earlier day
 * would read "no files" for every trader. The PC's modified time carries the year, and a day's ODIN trade file is
 * written through that day.
 *
 * The trading days are the calendar's (`isNseTradingDay`), newest first, today's included once it is one.
 *
 * Three queries however many traders and days: the files are one range on `{ trader, mtime, path }` (db.ts: answered
 * from the index alone, no file content read), and the trade lines and the order rows are one `$group` each over
 * `{ trader: { $in }, day: { $in } }` on the `{ trader, day }` indexes. Nothing scans a collection.
 */

import type { TradersDeps } from '../deps.ts'
import { IST_OFFSET_MS, istDate } from '../routes/kit.ts'
import type { StoredFile, TraderOrder, TraderTrade, WatcherStatus } from '../types.ts'
import { WATCHER_OFFLINE_MS } from './book-view.ts'
import { previousTradingDay, sessionDay } from './calendar.ts'
import type { DataStatusDay, DataStatusTrader, DataStatusView } from './daily-wire.ts'

export type { DataStatusDay, DataStatusTrader, DataStatusView, DataStatusWatcher } from './daily-wire.ts'

export const DATA_STATUS_DEFAULT_DAYS = 20
export const DATA_STATUS_MAX_DAYS = 60

export const DATA_STATUS_NOTES: readonly string[] = [
  "Files are counted by the day the trader's PC wrote them (their modified time): ODIN's file names carry no year, and a file uploaded late still belongs to the day it was written.",
  'A trader with no files on a day when another trader had trade lines is flagged: their watcher or PC was down, and their books for that day are short.',
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
/** '2026-10-13' -> '13 Oct'. */
const dayText = (day: string): string => `${day.slice(8, 10)} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`
/** Days named in a flag sentence before it says "and n more". */
const FLAG_DAYS_SHOWN = 6

/** The last `n` trading days up to today, newest first. */
export function lastTradingDays(nowMs: number, n: number): string[] {
  const out: string[] = []
  for (let day = sessionDay(istDate(nowMs)); day !== '' && out.length < n; day = previousTradingDay(day)) out.push(day)
  return out
}

/** What the reader counted for one trader. `days[i]` is `days[i]` of the view. */
export interface TraderCounts {
  readonly trader: string; readonly disabled: boolean
  readonly status: WatcherStatus | null
  readonly days: readonly { readonly files: number; readonly trades: number; readonly orders: number; readonly rejected: number }[]
}

/** The grid, the flags and the watcher lines from the counts. Pure. */
export function dataStatusOf(days: readonly string[], counts: readonly TraderCounts[], nowMs: number): DataStatusView {
  const sorted = [...counts].sort((a, b) => (a.trader < b.trader ? -1 : a.trader > b.trader ? 1 : 0))
  const traders = sorted.map((c): DataStatusTrader => ({
    trader: c.trader, disabled: c.disabled,
    watcher: c.status === null
      ? { lastHeartbeatAt: null, lastUploadAt: null, version: null, offline: true }
      : { lastHeartbeatAt: c.status.lastHeartbeatAt, lastUploadAt: c.status.lastUploadAt, version: c.status.version, offline: nowMs - c.status.lastHeartbeatAt > WATCHER_OFFLINE_MS },
    days: days.map((day, i): DataStatusDay => {
      const n = c.days[i] ?? { files: 0, trades: 0, orders: 0, rejected: 0 }
      const others = sorted.some((o) => o.trader !== c.trader && (o.days[i]?.trades ?? 0) > 0)
      // a disabled trader is locked out and expected to send nothing
      return { day, ...n, noFilesWhileOthersTraded: !c.disabled && n.files === 0 && others }
    }),
  }))
  const flags = traders.flatMap((t) => {
    const flagged = t.days.filter((d) => d.noFilesWhileOthersTraded).map((d) => dayText(d.day))
    if (flagged.length === 0) return []
    const shown = flagged.slice(0, FLAG_DAYS_SHOWN).join(', ')
    const more = flagged.length > FLAG_DAYS_SHOWN ? ` and ${flagged.length - FLAG_DAYS_SHOWN} more` : ''
    return [`${t.trader}: no files on ${shown}${more} while others traded`]
  })
  return { asOf: nowMs, days, traders, flags, notes: DATA_STATUS_NOTES }
}

/** The start of an IST day as epoch ms. */
const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS

/** The traders' files written since `oldest` began: a range on `{ trader, mtime, path }`, covered by it (no content read). */
export const filesFilter = (traders: readonly string[], oldest: string): Record<string, unknown> =>
  ({ trader: { $in: traders }, mtime: { $gte: dayStartMs(oldest) } })
export const FILES_PROJECTION = { _id: 0, trader: 1, mtime: 1, path: 1 } as const

const BY_TRADER_DAY = { trader: '$trader', day: '$day' } as const
const inRange = (traders: readonly string[], days: readonly string[]): Record<string, unknown> =>
  ({ $match: { trader: { $in: traders }, day: { $in: days } } })

/** Trade lines per (trader, day): an index range on `{ trader, day }`, covered by it. */
export const tradesPipeline = (traders: readonly string[], days: readonly string[]): Record<string, unknown>[] => [
  inRange(traders, days), { $group: { _id: BY_TRADER_DAY, n: { $sum: 1 } } },
]

/** Order rows and rejected ones (a status containing "Rejected") per (trader, day): an index range on `{ trader, day, orderNo }`. */
export const ordersPipeline = (traders: readonly string[], days: readonly string[]): Record<string, unknown>[] => [
  inRange(traders, days),
  { $group: {
    _id: BY_TRADER_DAY, n: { $sum: 1 },
    rejected: { $sum: { $cond: [{ $regexMatch: { input: '$status', regex: 'Rejected', options: 'i' } }, 1, 0] } },
  } },
]

const keyOf = (trader: unknown, day: unknown): string => `${String(trader)}|${String(day)}`
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/** The three queries. Reads only. */
export async function readDataStatus(
  d: Pick<TradersDeps, 'db' | 'users' | 'status'>, nDays: number, nowMs: number,
): Promise<DataStatusView> {
  const days = lastTradingDays(nowMs, nDays)
  const [users, statuses] = await Promise.all([d.users.list('trader'), d.status.all()])
  const names = users.map((u) => u.username)
  const oldest = days[days.length - 1]
  const files = new Map<string, number>()
  const trades = new Map<string, number>()
  const orders = new Map<string, { n: number; rejected: number }>()
  if (oldest !== undefined && names.length > 0) {
    const rows = await d.db.collection<StoredFile>('traders-files').find(filesFilter(names, oldest), { projection: FILES_PROJECTION }).toArray()
    for (const f of rows) {
      const k = keyOf(f.trader, istDate(f.mtime))
      files.set(k, (files.get(k) ?? 0) + 1)
    }
    for (const r of await d.db.collection<TraderTrade>('traders-trades').aggregate(tradesPipeline(names, days)).toArray()) {
      const id = r['_id'] as Record<string, unknown>
      trades.set(keyOf(id['trader'], id['day']), num(r['n']))
    }
    for (const r of await d.db.collection<TraderOrder>('traders-orders').aggregate(ordersPipeline(names, days)).toArray()) {
      const id = r['_id'] as Record<string, unknown>
      orders.set(keyOf(id['trader'], id['day']), { n: num(r['n']), rejected: num(r['rejected']) })
    }
  }
  const counts: TraderCounts[] = users.map((u) => ({
    trader: u.username, disabled: u.disabled, status: statuses.get(u.username) ?? null,
    days: days.map((day) => {
      const k = keyOf(u.username, day)
      return { files: files.get(k) ?? 0, trades: trades.get(k) ?? 0, orders: orders.get(k)?.n ?? 0, rejected: orders.get(k)?.rejected ?? 0 }
    }),
  }))
  return dataStatusOf(days, counts, nowMs)
}
