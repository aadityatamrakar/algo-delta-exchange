/**
 * Apply one parsed file to a trader's records. Every write is keyed, so
 * applying the same file again (a re-sent file, an append re-parsed whole, or
 * the pipeline re-running a parse that died half-way) changes nothing: trades
 * and log lines are insert-if-new, an order is replaced only by a row as new or
 * newer, and ODIN legs are recomputed from the ledger, never incremented.
 * Ingest is serialised per trader (pipeline.ts), so read-then-write is safe.
 */

import type { LegStore } from '../books/legs.ts'
import type { TradersDb } from '../db.ts'
import { matchLeg, type TradersMaster } from '../market/master.ts'
import { istClock, istDate } from '../routes/kit.ts'
import type { LogLine, TraderOrder, TraderTrade } from '../types.ts'
import type { LedgerStore } from './ledger-store.ts'
import { ParseError, type ParsedFile } from './parsers.ts'
import type { ApplyParsed } from './pipeline.ts'

/** The parsers whose files are the trade history; a canonical upload never moves `historyFrom`. */
const ODIN_TRADES = /^odin-.+-trades$/

const POSITIONS_NEED_A_DAY =
  'a positions file needs its date in the name, e.g. positions-2026-10-16.csv — the balance is the positions at the close of that day'
/** NSE and BSE derivatives close at 15:40 IST (since 3 Aug 2026; `CLOSE_MINUTES` in analytics/calendar.ts). */
const CLOSE_IST = '15:40'
const NOT_CLOSED = 'has not closed yet'
const positionsNotClosed = (day: string) => `a positions file is the positions at the close of its date — ${day} ${NOT_CLOSED}`

/** A refusal that is the clock's, not the file's: the same file sent again after the close is applied. */
export function refusedUntilClose(parseError: string | null): boolean {
  return parseError !== null && parseError.startsWith('a positions file is the positions at the close') && parseError.endsWith(NOT_CLOSED)
}

export function makeApply(d: {
  db: TradersDb; legs: LegStore; ledger: LedgerStore; master: () => TradersMaster; now: () => number
}): ApplyParsed {
  return async (trader, parsed, file) => {
    switch (parsed.kind) {
      case 'positions': {
        // Trades on or before the balance's day are not counted again, so a guessed day (the upload's), or a
        // day that has not closed, would silently drop every trade of that day. Refused before anything is written.
        if (parsed.day === '') throw new ParseError(POSITIONS_NEED_A_DAY)
        const now = d.now()
        const today = istDate(now)
        if (parsed.day > today || (parsed.day === today && istClock(now) < CLOSE_IST)) throw new ParseError(positionsNotClosed(parsed.day))
        await d.ledger.setBalance(trader, { day: parsed.day, positions: parsed.positions ?? [] })
        break
      }
      case 'trades':
        await insertTrades(d.db, trader, parsed.trades ?? [])
        if (ODIN_TRADES.test(file.parser ?? '') && parsed.day !== '') await d.ledger.noteHistory(trader, parsed.day)
        break
      case 'orders':
        await upsertOrders(d.db, trader, parsed.orders ?? [])
        return
      case 'log':
        await insertLog(d.db, trader, parsed.log ?? [])
        return
    }
    const master = d.master()
    await d.legs.replaceOdin(trader, await d.ledger.odinLegs(trader), (c) => matchLeg(master, c))
  }
}

const daysOf = (rows: readonly { readonly day: string }[]): string[] => [...new Set(rows.map((r) => r.day))]

async function insertTrades(db: TradersDb, trader: string, trades: NonNullable<ParsedFile['trades']>): Promise<void> {
  if (trades.length === 0) return
  const col = db.collection<TraderTrade>('traders-trades')
  const id = (t: Pick<TraderTrade, 'day' | 'tradeNo' | 'orderNo'>) => JSON.stringify([t.day, t.tradeNo, t.orderNo])
  const have = new Set((await col.find({ trader, day: { $in: daysOf(trades) } }, { projection: { _id: 0, day: 1, tradeNo: 1, orderNo: 1 } }).toArray()).map(id))
  for (const t of trades) {
    if (have.has(id(t))) continue   // a line already stored keeps its first copy
    have.add(id(t))
    await col.updateOne({ trader, day: t.day, tradeNo: t.tradeNo, orderNo: t.orderNo }, { $setOnInsert: { ...t, trader } }, { upsert: true })
  }
}

async function upsertOrders(db: TradersDb, trader: string, orders: NonNullable<ParsedFile['orders']>): Promise<void> {
  if (orders.length === 0) return
  const col = db.collection<TraderOrder>('traders-orders')
  const id = (o: Pick<TraderOrder, 'day' | 'orderNo'>) => JSON.stringify([o.day, o.orderNo])
  const stored = new Map((await col.find({ trader, day: { $in: daysOf(orders) } }, { projection: { _id: 0 } }).toArray()).map((o) => [id(o), o]))
  for (const o of orders) {
    const old = stored.get(id(o))
    // Two files can hold one order (ODIN's two order-file name styles): the older row never wins.
    if (old !== undefined && (o.updateTime < old.updateTime || sameFields(old, o))) continue
    const row: TraderOrder = { ...o, trader }
    await col.updateOne({ trader, day: o.day, orderNo: o.orderNo }, { $set: row }, { upsert: true })
    stored.set(id(o), row)
  }
}

async function insertLog(db: TradersDb, trader: string, lines: NonNullable<ParsedFile['log']>): Promise<void> {
  const col = db.collection<LogLine>('traders-log')
  for (const l of lines) {
    await col.updateOne({ trader, day: l.day, seq: l.seq }, { $setOnInsert: { ...l, trader } }, { upsert: true })
  }
}

/** Every field of `row` already has its value in `stored` (the fields are all scalars). */
function sameFields(stored: object, row: object): boolean {
  return Object.entries(row).every(([k, v]) => (stored as Record<string, unknown>)[k] === v)
}
