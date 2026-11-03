/**
 * The api's instrument master, kept in step with the `instrument` collection.
 *
 * WHY A CHANGE CHECK, not only the 15-minute reload. The sync owns the
 * collection and writes it ONE ROW AT A TIME (an upsert per contract). A
 * reader that loads while a sync is running gets the rows written so far and
 * nothing else. On 3 Nov 2026 the dx api booted 0.3s before marketdata's
 * first sync into a fresh db finished, loaded 200 of 533 options, and served
 * that until the next reload: the chain page showed 5 of 10 BTC expiries and
 * blank PE quotes for the 03 Nov strikes 77,600-78,400 while every one of
 * those tokens was being quoted. Nothing was wrong with the feed; the master
 * did not list the contracts, so the chain had no token to read.
 *
 * THE FINGERPRINT is the row count and the newest `_id`. An insert raises
 * both, a delete lowers the count, and reading them is two index lookups, so
 * it can run every few seconds where reloading a ~90k-row NSE dump cannot.
 * It is read BEFORE the rows: if a sync is mid-way, the rows loaded are at
 * least what the fingerprint saw, so the next check differs and reloads.
 * An in-place `$set` (a revised lot size) moves neither; the full reload
 * still covers that.
 */

import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'

/** A stored row, with Delta's OI cap when the dx sync wrote one (`loadStoredInstruments`). */
export type MasterRow = InstrumentRow & {
  readonly dx_max_oi_usd?: number | null
  readonly dx_oi_reduce_only?: boolean
}

/** Delta's OI cap for one contract, off its master row. */
export interface OiCapRef {
  readonly capUsd: number | null
  readonly reduceOnly: boolean
  /** BTC per contract, for the OI value. */
  readonly lotSize: number
}

export interface MasterSource {
  /** Every stored instrument row — `loadStoredInstruments`. */
  readonly load: () => Promise<MasterRow[]>
  /** Cheap: changes whenever rows are inserted or deleted. */
  readonly fingerprint: () => Promise<string>
}

/** The fingerprint `MasterSource` wants, off a Mongo collection. */
export async function collectionFingerprint(col: {
  countDocuments(filter: Record<string, never>): Promise<number>
  find(
    filter: Record<string, never>,
    options: { projection: { _id: 1 }; sort: { _id: -1 }; limit: 1 },
  ): { toArray(): Promise<{ _id?: unknown }[]> }
}): Promise<string> {
  const count = await col.countDocuments({})
  const newest = await col.find({}, { projection: { _id: 1 }, sort: { _id: -1 }, limit: 1 }).toArray()
  return `${count}|${String(newest[0]?._id ?? '')}`
}

export class MasterRefresher {
  #master: OptionMaster = new OptionMaster([])
  #caps = new Map<number, OiCapRef>()
  #seen: string | null = null
  #busy: Promise<void> | null = null
  private readonly source: MasterSource
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void

  constructor(source: MasterSource, log: (msg: string, ctx?: Record<string, unknown>) => void = () => {}) {
    this.source = source
    this.log = log
  }

  current(): OptionMaster {
    return this.#master
  }

  /** Delta's OI cap for a token, or null (no cap on record, or not a Delta option). */
  oiCap(token: number): OiCapRef | null {
    return this.#caps.get(token) ?? null
  }

  /** Reload unconditionally. Concurrent calls share one load. */
  async reload(reason: 'boot' | 'scheduled' | 'changed' = 'scheduled'): Promise<void> {
    if (this.#busy !== null) return this.#busy
    this.#busy = (async () => {
      const fp = await this.source.fingerprint()
      const rows = await this.source.load()
      this.#master = new OptionMaster(rows)
      this.#caps = new Map(
        rows
          .filter((r) => r.dx_max_oi_usd !== undefined || r.dx_oi_reduce_only !== undefined)
          .map((r) => [r.instrument_token, { capUsd: r.dx_max_oi_usd ?? null, reduceOnly: r.dx_oi_reduce_only === true, lotSize: r.lot_size }]),
      )
      this.#seen = fp
      this.log(reason === 'boot' ? 'instrument master loaded' : 'instrument master refreshed', {
        contracts: this.#master.optionCount,
        reason,
      })
    })()
    try {
      await this.#busy
    } finally {
      this.#busy = null
    }
  }

  /** Reload only if rows were inserted or deleted since the last load. True when it reloaded. */
  async reloadIfChanged(): Promise<boolean> {
    if (this.#busy !== null) {
      await this.#busy
      return false
    }
    const fp = await this.source.fingerprint()
    if (fp === this.#seen) return false
    await this.reload('changed')
    return true
  }
}
