/**
 * `traders-legs`: every leg of every trader. An ODIN leg (`source: 'odin'`) is
 * the ledger's output for one contract and client code, rewritten whole after
 * every trades or positions file; it is never edited by hand. A manual leg is
 * the trader's own, and no file ever touches it.
 *
 * `version(trader)` counts this process's leg writes for a trader, so a cache
 * keyed on it (the book's payoff) rebuilds on the next read after any change.
 */

import { randomUUID } from 'node:crypto'
import type { TradersDb } from '../db.ts'
import type { ParsedPosition } from '../ingest/parsers.ts'
import type { LegContract } from '../market/master.ts'
import { Conflict, NotFound, istDate } from '../routes/kit.ts'
import { isOpenLeg, legKey } from '../types.ts'
import type { ManualLegInput, TraderLeg } from '../types.ts'

const NO_ID = { projection: { _id: 0 } } as const

export class LegStore {
  readonly #db: TradersDb
  readonly #now: () => number
  readonly #versions = new Map<string, number>()

  constructor(db: TradersDb, now: () => number) {
    this.#db = db
    this.#now = now
  }

  /**
   * Make the trader's ODIN legs equal `legs`: upsert each by its key, and set
   * an ODIN leg that is no longer in `legs` to qty 0. A leg whose qty, price
   * and token are unchanged is not written, so re-applying a file is no write.
   */
  async replaceOdin(trader: string, legs: readonly ParsedPosition[], match: (c: LegContract) => number | null): Promise<void> {
    const col = this.#legs()
    const stored = new Map((await col.find({ trader, source: 'odin' }, NO_ID).toArray()).map((l) => [l.key, l]))
    const now = this.#now()
    const seen = new Set<string>()
    let wrote = false
    for (const p of legs) {
      const key = legKey(p)
      seen.add(key)
      const leg: TraderLeg = {
        trader, stock: p.stock, instrument: p.instrument, expiry: p.expiry, strike: p.strike, optType: p.optType,
        qty: p.qty, avgPrice: p.avgPrice, clientCode: p.clientCode, source: 'odin', key, token: match(p), note: '', updatedAt: now,
      }
      const old = stored.get(key)
      if (old !== undefined && old.qty === leg.qty && old.avgPrice === leg.avgPrice && old.token === leg.token) continue
      await col.updateOne({ trader, key }, { $set: leg }, { upsert: true })
      wrote = true
    }
    for (const old of stored.values()) {
      if (seen.has(old.key) || (old.qty === 0 && old.avgPrice === 0)) continue
      await col.updateOne({ trader, key: old.key, source: 'odin' }, { $set: { qty: 0, avgPrice: 0, updatedAt: now } })
      wrote = true
    }
    if (wrote) this.#bump(trader)
  }

  /** Legs with qty !== 0, by stock then key. Expiry is not considered: callers apply `isOpenLeg`. */
  async open(trader: string, stock?: string): Promise<TraderLeg[]> {
    const f: Record<string, unknown> = { trader, qty: { $ne: 0 } }
    if (stock !== undefined) f['stock'] = stock
    return await this.#legs().find(f, NO_ID).sort({ stock: 1, key: 1 }).toArray()
  }

  /** Every trader's legs with qty !== 0, by trader, stock, key. */
  async allOpen(): Promise<TraderLeg[]> {
    return await this.#legs().find({ qty: { $ne: 0 } }, NO_ID).sort({ trader: 1, stock: 1, key: 1 }).toArray()
  }

  /** Each (trader, stock) with a leg open today, by trader then stock. */
  async openBooks(): Promise<{ trader: string; stock: string }[]> {
    const today = istDate(this.#now())
    const out: { trader: string; stock: string }[] = []
    for (const l of await this.allOpen()) {
      const last = out[out.length - 1]
      if (isOpenLeg(l, today) && (last?.trader !== l.trader || last.stock !== l.stock)) out.push({ trader: l.trader, stock: l.stock })
    }
    return out
  }

  /** The input is validated by the caller (books/manual.ts); `token` is its master match. */
  async addManual(trader: string, input: ManualLegInput, token: number | null): Promise<TraderLeg> {
    const leg: TraderLeg = {
      trader, stock: input.stock, instrument: input.instrument, expiry: input.expiry, strike: input.strike, optType: input.optType,
      qty: input.qty, avgPrice: input.avgPrice, clientCode: '', source: 'manual', key: `manual:${randomUUID()}`, token,
      note: input.note, updatedAt: this.#now(),
    }
    await this.#legs().insertOne({ ...leg })   // the driver adds an _id to the object it is handed
    this.#bump(trader)
    return leg
  }

  async patchManual(trader: string, key: string, patch: { qty?: number; avgPrice?: number; note?: string }): Promise<TraderLeg> {
    const leg = await this.#manual(trader, key, 'an ODIN leg cannot be edited; it follows the ODIN files')
    const set: { qty?: number; avgPrice?: number; note?: string; updatedAt: number } = { updatedAt: this.#now() }
    if (patch.qty !== undefined) set.qty = patch.qty
    if (patch.avgPrice !== undefined) set.avgPrice = patch.avgPrice
    if (patch.note !== undefined) set.note = patch.note
    await this.#legs().updateOne({ trader, key, source: 'manual' }, { $set: set })
    this.#bump(trader)
    return { ...leg, ...set }
  }

  async deleteManual(trader: string, key: string): Promise<void> {
    await this.#manual(trader, key, 'an ODIN leg cannot be deleted; it follows the ODIN files')
    await this.#legs().deleteOne({ trader, key, source: 'manual' })
    this.#bump(trader)
  }

  version(trader: string): number {
    return this.#versions.get(trader) ?? 0
  }

  async #manual(trader: string, key: string, odinRefusal: string): Promise<TraderLeg> {
    const leg = await this.#legs().findOne({ trader, key }, NO_ID)
    if (leg === null) throw new NotFound('no such leg')
    if (leg.source !== 'manual') throw new Conflict(odinRefusal)
    return leg
  }

  #bump(trader: string): void {
    this.#versions.set(trader, this.version(trader) + 1)
  }

  #legs() {
    return this.#db.collection<TraderLeg>('traders-legs')
  }
}
