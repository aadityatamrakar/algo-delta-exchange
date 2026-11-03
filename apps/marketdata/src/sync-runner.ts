/**
 * The IO half of the instrument sync: fetch the dump, apply the plan.
 *
 * All the decisions live in `planSync` (pure, tested). This file only performs
 * the effects, which is why it is thin and has no branching worth testing.
 *
 * The dump endpoint is unauthenticated — `exchangeToken.js:11` already relies on
 * that, and it is the same URL. No credentials are needed to refresh contracts,
 * which matters: instrument sync must keep working when a broker login is
 * broken, or a bad login morning becomes a day with no tradable symbols.
 */

import {
  FreezeLimits,
  parseBseContractCsv,
  parseFreezeCsv,
  parseInstrumentCsv,
  type InstrumentRow,
} from '@algomaker/instruments'
import { planSync, type SyncPlan, type SyncUniverse } from './instrument-sync.ts'
import { readZipEntry } from './zip.ts'

const DUMP_URL = 'https://api.kite.trade/instruments'
/**
 * NSE's volume-freeze table. Any single order above this quantity is REJECTED
 * by the exchange, so it drives order splitting (see packages/instruments
 * `freeze.ts`). Covers 215 underlyings — 210 of them stocks.
 *
 * NSE circular 29/2024 announced this file's withdrawal in favour of the MII
 * contract file; it still serves as of 2026-07-27. The loader below fails soft
 * for that reason: losing the file must leave the PREVIOUS limits in place, not
 * remove every limit.
 */
const FREEZE_URL = 'https://nsearchives.nseindia.com/content/fo/qtyfreeze.csv'
/**
 * BSE's abridged contract master, a zip whose `BSE_EQD_CONTRACT_abr_DDMMYYYY.csv`
 * carries `MaxTradQty` — the single-order cap — for every BFO contract. It
 * is the only freeze source for SENSEX/BANKEX: qtyfreeze.csv above lists no
 * BSE underlying at all. The bare host 302s to `www`, hence the full host.
 */
const BSE_FREEZE_URL = 'https://www.bseindia.com/downloads1/Abridged_CO.ZIP'
const BSE_FREEZE_ENTRY = /^BSE_EQD_CONTRACT_abr_\d{8}\.csv$/i
/**
 * Provenance stamp on rows this sync writes. NSE rows are `{symbol, freezeQty}`
 * with NO source field, so "absent or stamped with this" is the whole rule for
 * which rows the BSE sync may touch.
 */
export const BSE_FREEZE_SOURCE = 'bse-contract-master'

/** Minimal Mongo surface, mirroring apps/api's port for the same reasons. */
export interface SyncCollection {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>
  deleteMany(filter: Record<string, unknown>): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

export interface SyncDeps {
  readonly collection: SyncCollection
  readonly universe: SyncUniverse
  /** Tokens in any open book. Never deleted, however expired. */
  readonly referencedTokens: () => Promise<ReadonlySet<number>>
  readonly fetchDump?: () => Promise<string>
  readonly now?: () => Date
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

/** 'YYYY-MM-DD' in IST, which is the timezone every expiry in the dump is in. */
export function istDateString(d: Date): string {
  const shifted = new Date(d.getTime() + 330 * 60_000)
  return shifted.toISOString().slice(0, 10)
}

async function defaultFetch(): Promise<string> {
  const res = await fetch(DUMP_URL)
  if (!res.ok) throw new Error(`instrument dump fetch failed: ${res.status} ${res.statusText}`)
  return await res.text()
}

export async function runSync(deps: SyncDeps): Promise<SyncPlan> {
  const log = deps.log ?? ((): void => {})
  const fetchDump = deps.fetchDump ?? defaultFetch
  const now = (deps.now ?? ((): Date => new Date()))()

  const text = await fetchDump()
  const dump = parseInstrumentCsv(text)
  // A dump this small is a truncated download, not a quiet market. Applying it
  // would delete most of the collection on the next expiry pass.
  if (dump.length < 1000) {
    throw new Error(`instrument dump has only ${dump.length} rows — refusing to apply a truncated download`)
  }

  const existingDocs = await deps.collection
    .find({})
    .toArray()
  const existing = existingDocs.map((d) => ({
    instrument_token: Number(d['instrument_token']),
    expiry: String(d['expiry'] ?? ''),
  }))

  const plan = planSync({
    dump,
    existing,
    universe: deps.universe,
    today: istDateString(now),
    referencedTokens: await deps.referencedTokens(),
  })

  await deps.collection.createIndex({ instrument_token: 1 }, { unique: true })
  await deps.collection.createIndex({ tradingsymbol: 1 })

  for (const row of plan.toUpsert) {
    await deps.collection.updateOne(
      { instrument_token: row.instrument_token },
      { $set: row as unknown as Record<string, unknown> },
      { upsert: true },
    )
  }
  if (plan.toDelete.length > 0) {
    await deps.collection.deleteMany({ instrument_token: { $in: plan.toDelete } })
  }

  log('instrument sync complete', {
    dumpRows: plan.counts.dumpRows,
    upserts: plan.counts.upserts,
    deletes: plan.counts.deletes,
    retainedExpired: plan.counts.retained,
  })
  return plan
}

/**
 * Refresh the freeze table. Fail-soft by contract.
 *
 * Returns the number of symbols written, or null when the fetch failed — in
 * which case the stored table is left EXACTLY as it was. The alternative,
 * writing an empty table, would make every symbol's limit unknown, and an
 * unknown limit means orders go out unsplit and get rejected at the exchange.
 *
 * Each write also `$unset`s the three fields only `syncBseFreezeLimits`
 * stamps (`source`, `lotSize`, `syncedAt`). That sync skips any row without
 * its stamp, which is what lets an NSE row win over a BSE one — but only if
 * a row NSE has WRITTEN never carries the stamp. qtyfreeze.csv lists no BSE
 * underlying today; if it ever listed SENSEX, a plain `$set` onto the
 * BSE-stamped document would leave `source` in place and the next BSE run
 * would put its own number back. Clearing the stamp here makes an NSE write
 * look exactly like an NSE insert, so the rule holds both ways.
 */
export async function syncFreezeLimits(deps: {
  collection: SyncCollection
  fetchFreeze?: () => Promise<string>
  log?: (msg: string, ctx?: Record<string, unknown>) => void
}): Promise<number | null> {
  const log = deps.log ?? ((): void => {})
  try {
    const text = await (deps.fetchFreeze ?? defaultFetchFreeze)()
    const rows = parseFreezeCsv(text)
    if (rows.length < 50) {
      throw new Error(`freeze table has only ${rows.length} rows — refusing a truncated download`)
    }
    await deps.collection.createIndex({ symbol: 1 }, { unique: true })
    for (const r of rows) {
      await deps.collection.updateOne(
        { symbol: r.symbol },
        { $set: { symbol: r.symbol, freezeQty: r.freezeQty }, $unset: { source: '', lotSize: '', syncedAt: '' } },
        { upsert: true },
      )
    }
    log('freeze limits synced', { symbols: rows.length })
    return rows.length
  } catch (err) {
    log('freeze sync FAILED — keeping the previous table', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function defaultFetchFreeze(): Promise<string> {
  const res = await fetch(FREEZE_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', accept: '*/*' },
  })
  if (!res.ok) throw new Error(`freeze fetch failed: ${res.status} ${res.statusText}`)
  return await res.text()
}

/**
 * Refresh the BSE index freeze rows. The same fail-soft contract as
 * `syncFreezeLimits`: the count of symbols written, or null when anything
 * went wrong — in which case the stored rows are left EXACTLY as they were.
 *
 * Why a separate function rather than a second URL in `syncFreezeLimits`: the
 * two sources fail independently (BSE's site is behind a bot wall that NSE's
 * archive is not), the NSE sync's "at least 50 rows" guard is meaningless for
 * a file with three index symbols, and a BSE outage must not cost the desk
 * its 215 NSE limits.
 *
 * Both write the same `desk-freeze-limits` collection, keyed by symbol.
 * `loadFreezeLimits` reads only `symbol`/`freezeQty`, so it needs no change;
 * the extra `lotSize`, `source` and `syncedAt` fields are provenance for an
 * operator (`db['desk-freeze-limits'].find({source:'bse-contract-master'})`).
 *
 * Guards before the first write, each of which throws into the fail-soft
 * branch: fewer than two index symbols is a truncated or reshuffled file
 * (BSE lists SENSEX, BANKEX and FOCIT today); a `freezeQty` the lot does not
 * divide means the column or its unit is not what we think; and a symbol
 * already in the table WITHOUT this sync's `source` stamp is skipped, never
 * overwritten, so an NSE row or a hand-inserted one always wins. That holds
 * because `syncFreezeLimits` clears the stamp on every row it writes: a
 * document NSE has touched never looks like one of ours.
 */
export async function syncBseFreezeLimits(deps: {
  collection: SyncCollection
  fetchBseZip?: () => Promise<Buffer>
  now?: () => Date
  log?: (msg: string, ctx?: Record<string, unknown>) => void
}): Promise<number | null> {
  const log = deps.log ?? ((): void => {})
  try {
    const zip = await (deps.fetchBseZip ?? defaultFetchBseZip)()
    const text = readZipEntry(zip, BSE_FREEZE_ENTRY).toString('utf8')
    const rows = parseBseContractCsv(text)
    if (rows.length < 2) {
      throw new Error(`BSE contract master lists only ${rows.length} index symbol(s) — refusing a truncated download`)
    }
    for (const r of rows) {
      if (r.freezeQty % r.lotSize !== 0) {
        throw new Error(`BSE contract master: ${r.symbol} MaxTradQty ${r.freezeQty} is not a multiple of its lot ${r.lotSize} — refusing the file`)
      }
    }

    await deps.collection.createIndex({ symbol: 1 }, { unique: true })
    const existing = await deps.collection.find({ symbol: { $in: rows.map((r) => r.symbol) } }).toArray()
    const foreign = new Set(
      existing.filter((d) => d['source'] !== BSE_FREEZE_SOURCE).map((d) => String(d['symbol'] ?? '')),
    )

    const syncedAt = (deps.now ?? ((): Date => new Date()))().getTime()
    const written: string[] = []
    const skipped: string[] = []
    for (const r of rows) {
      if (foreign.has(r.symbol)) {
        skipped.push(r.symbol)
        log(`BSE freeze sync: ${r.symbol} already has a row not from this source — leaving it alone`, {
          symbol: r.symbol,
          freezeQty: r.freezeQty,
        })
        continue
      }
      await deps.collection.updateOne(
        { symbol: r.symbol },
        { $set: { symbol: r.symbol, freezeQty: r.freezeQty, lotSize: r.lotSize, source: BSE_FREEZE_SOURCE, syncedAt } },
        { upsert: true },
      )
      written.push(r.symbol)
    }
    log('BSE freeze limits synced', { symbols: written.length, written, skipped })
    return written.length
  } catch (err) {
    log('BSE freeze sync FAILED — keeping the previous rows', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function defaultFetchBseZip(): Promise<Buffer> {
  const res = await fetch(BSE_FREEZE_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', accept: '*/*' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`BSE contract master fetch failed: ${res.status} ${res.statusText}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function loadFreezeLimits(collection: SyncCollection): Promise<FreezeLimits> {
  const docs = await collection.find({}).toArray()
  return new FreezeLimits(
    docs
      .map((d) => ({ symbol: String(d['symbol'] ?? ''), freezeQty: Number(d['freezeQty'] ?? 0) }))
      .filter((r) => r.symbol !== '' && r.freezeQty > 0),
  )
}

/** Load the stored dump back out, for building an `OptionMaster`. */
export async function loadStoredInstruments(collection: SyncCollection): Promise<InstrumentRow[]> {
  const docs = await collection.find({}).toArray()
  return docs.map((d) => ({
    instrument_token: Number(d['instrument_token']),
    tradingsymbol: String(d['tradingsymbol'] ?? ''),
    name: String(d['name'] ?? ''),
    expiry: String(d['expiry'] ?? ''),
    strike: Number(d['strike'] ?? 0),
    tick_size: Number(d['tick_size'] ?? 0),
    lot_size: Number(d['lot_size'] ?? 0),
    instrument_type: String(d['instrument_type'] ?? ''),
    segment: String(d['segment'] ?? ''),
    exchange: String(d['exchange'] ?? ''),
  }))
}
