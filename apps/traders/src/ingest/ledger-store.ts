/**
 * The ledger's inputs per trader, one `traders-settings` document
 * `{kind: 'ledger', trader, balance?, historyFrom?}`: the opening balance (the
 * last canonical positions file applied) and the day of the earliest ODIN
 * trade file. `historyFrom` stays ABSENT until the first ODIN trade file:
 * `$min` against a stored null keeps the null, because BSON orders null below
 * every string.
 *
 * A trader's ODIN legs are the ledger run over the balance and every stored
 * trade, recomputed whole each time, so applying a file twice cannot count it
 * twice. Client codes are upper-cased first: a hand-typed balance file may
 * spell `c0001` where ODIN writes `C0001`, and that must stay one leg.
 *
 * Expiry settlement (ingest/settlement.ts, spec 2026-10-23 G1/G2) is folded
 * into that walk: the fills NSE's final settlement made, derived from the NSE
 * history at each run, never stored. The legs of a run and the settlement they
 * hold come from one read; the last one per trader is kept for the IST day,
 * so the book view can say what was settled, delivered or left open without
 * walking the trader's whole history again.
 */

import type { TradersDb } from '../db.ts'
import { istDate } from '../routes/kit.ts'
import { legsFromTrades, type LedgerTrade, type OpeningBalance } from './ledger.ts'
import type { ParsedPosition } from './parsers.ts'
import { settlementRun, tradeRecordOf, type IsIndex, type SettlementPrice, type SettlementRun } from './settlement.ts'

interface LedgerDoc {
  readonly kind: 'ledger'
  readonly trader: string
  readonly balance?: OpeningBalance
  readonly historyFrom?: string
}

const LEDGER_FIELDS = {
  _id: 0, clientCode: 1, stock: 1, instrument: 1, expiry: 1, strike: 1, optType: 1, side: 1, qty: 1, price: 1, time: 1, day: 1, seq: 1,
} as const

const sameCase = <T extends { readonly clientCode: string }>(x: T): T => ({ ...x, clientCode: x.clientCode.toUpperCase() })

/** What settles expired contracts: the final settlement price, index or stock, and the clock that says which expiries are past. */
export interface LedgerSettlement {
  readonly price: SettlementPrice
  readonly isIndex: IsIndex
  readonly now: () => number
}

/** One ledger run: the legs, with the settlement folded in, and that settlement. */
export interface OdinLedger { readonly legs: ParsedPosition[]; readonly settlement: SettlementRun }

export const NO_SETTLEMENT: SettlementRun = { fills: [], unsettled: [], deliveries: [] }

export class LedgerStore {
  readonly #db: TradersDb
  readonly #settle: LedgerSettlement | null
  /** Trader → the settlement of their last ledger run, and the IST day it was made on. */
  readonly #settled = new Map<string, { readonly day: string; readonly run: SettlementRun }>()
  /** Trader → the read `settlement` is making: every book of a trader asks at once (the band board), one read serves them. */
  readonly #reading = new Map<string, Promise<SettlementRun>>()
  /** Trader → ledger runs started: a `settlement` read that a run overtook does not replace the run's newer answer. */
  readonly #runs = new Map<string, number>()

  /** Without `settle`, nothing is settled: an expired contract keeps its qty (the ledger before G1). */
  constructor(db: TradersDb, settle?: LedgerSettlement) {
    this.#db = db
    this.#settle = settle ?? null
  }

  /** Replaces the trader's opening balance (positions at the CLOSE of `balance.day`). */
  async setBalance(trader: string, balance: OpeningBalance): Promise<void> {
    await this.#settings().updateOne({ kind: 'ledger', trader }, { $set: { balance } }, { upsert: true })
  }

  async odinLegs(trader: string): Promise<ParsedPosition[]> {
    return (await this.odinLedger(trader)).legs
  }

  /** The trader's legs, `legsFromTrades(balance, [...trades, ...fills])`, and the settlement that made the fills. */
  async odinLedger(trader: string): Promise<OdinLedger> {
    this.#runs.set(trader, (this.#runs.get(trader) ?? 0) + 1)
    const [balance, trades, from] = await Promise.all([this.balance(trader), this.#trades(trader), this.historyFrom(trader)])
    const settlement = this.#run(trader, balance, trades, from, true)
    return { legs: legsFromTrades(balance, [...trades, ...settlement.fills]), settlement }
  }

  /**
   * The settlement of the trader's last ledger run today: every apply and every recompute makes one. Before any
   * today (a new day, a fresh process), it is worked out here once, one read however many ask.
   */
  async settlement(trader: string): Promise<SettlementRun> {
    if (this.#settle === null) return NO_SETTLEMENT
    const kept = this.#settled.get(trader)
    if (kept !== undefined && kept.day === istDate(this.#settle.now())) return kept.run
    let reading = this.#reading.get(trader)
    if (reading === undefined) {
      const runs = this.#runs.get(trader) ?? 0
      reading = Promise.all([this.balance(trader), this.#trades(trader), this.historyFrom(trader)])
        .then(([balance, trades, from]) => this.#run(trader, balance, trades, from, (this.#runs.get(trader) ?? 0) === runs))
        .finally(() => { this.#reading.delete(trader) })
      this.#reading.set(trader, reading)
    }
    return await reading
  }

  /**
   * The settlement over these inputs; `keep` = it is the newest answer for the trader, kept for the day. The record
   * guard reads every trade the trader has: a day with no F&O trade on an exchange may be its trade file that never
   * arrived.
   */
  #run(trader: string, balance: OpeningBalance | null, trades: readonly LedgerTrade[], historyFrom: string | null, keep: boolean): SettlementRun {
    const s = this.#settle
    if (s === null) return NO_SETTLEMENT
    const day = istDate(s.now())
    const run = settlementRun(balance, trades, day, s.price, s.isIndex, tradeRecordOf(trades, historyFrom))
    if (keep) this.#settled.set(trader, { day, run })
    return run
  }

  /** In the unique index's order, so trades the ledger finds level (same day, time and line) keep one order on every run. */
  async #trades(trader: string): Promise<LedgerTrade[]> {
    const trades = await this.#db.collection<LedgerTrade>('traders-trades')
      .find({ trader }, { projection: LEDGER_FIELDS })
      .sort({ day: 1, tradeNo: 1, orderNo: 1 })
      .toArray()
    return trades.map(sameCase)
  }

  /** Every trader whose legs the ledger makes: one with a stored trade or an opening balance. */
  async traders(): Promise<string[]> {
    const [traded, balanced] = await Promise.all([
      this.#db.collection('traders-trades').distinct('trader'),
      this.#settings().distinct('trader', { kind: 'ledger', balance: { $exists: true } }),
    ])
    return [...new Set([...traded, ...balanced])].filter((t): t is string => typeof t === 'string').sort()
  }

  /** The opening balance the ledger starts from, client codes upper-cased as `odinLegs` reads it; null when none. */
  async balance(trader: string): Promise<OpeningBalance | null> {
    const doc = await this.#settings().findOne({ kind: 'ledger', trader })
    return doc?.balance === undefined ? null : { day: doc.balance.day, positions: doc.balance.positions.map(sameCase) }
  }

  /** An ODIN trade file for `day` was applied: history starts no later than it. */
  async noteHistory(trader: string, day: string): Promise<void> {
    await this.#settings().updateOne({ kind: 'ledger', trader }, { $min: { historyFrom: day } }, { upsert: true })
  }

  /** The earliest ODIN trade file's day, null before any. */
  async historyFrom(trader: string): Promise<string | null> {
    return (await this.#settings().findOne({ kind: 'ledger', trader }))?.historyFrom ?? null
  }

  #settings() {
    return this.#db.collection<LedgerDoc>('traders-settings')
  }
}
