/**
 * The Delta instrument master and settlement prices.
 *
 * WHEN. At boot, every 15 minutes, and on the first pass after each 12:00 UTC
 * settlement (`dxSyncDue`). Delta lists new strikes and expiries during the
 * day and settles every BTC option at 12:00 UTC, so the NSE once-a-day 08:45
 * trigger would leave a new daily expiry unresolvable for most of its life.
 *
 * WHAT IT WRITES
 *   instrument       one row per live BTC option and one spot row for
 *                    `.DEXBTUSD` (`toInstrumentRows`), upserted on `instrument_token`
 *                    (= Delta product id), the collection the Kite sync writes
 *   dx-settlements   `{_id: productId, symbol, expiry, price, publishedAt}`,
 *                    one per expired option once Delta publishes its price;
 *                    insert-only, so a re-run never rewrites a booked price
 *
 * WHAT IT DELETES. An expired row (its 12:00 UTC instant has passed and it is
 * no longer listed) only when (a) no open `desk-books` leg holds its token,
 * (b) no `desk-books-registry` row names its expiry, and (c) its settlement
 * is recorded — or Delta has still not published one a day later, which is
 * logged. Upserts are driven by the listing and deletions by what is stored,
 * the `planSync` asymmetry: a product missing from one listing is not deleted
 * on that basis, so a bad fetch degrades to stale rows, never to none.
 */

import { DX, type VenueSpec } from '@algomaker/venue'
import type { InstrumentRow } from '@algomaker/instruments'
import { DX_SPOT_SYMBOL, num, type DxProduct } from '@algomaker/dx'
import type { DxNormaliser, DxRestPort } from './dx-ports.ts'
import { DX_UNDERLYING } from './dx-feed.ts'

export const DX_SETTLEMENTS_COLLECTION = 'dx-settlements'
export const DX_SYNC_EVERY_MS = 15 * 60_000
/** How long after the instant the first post-settlement sync waits, so Delta has listed the next expiry. */
export const DX_POST_SETTLEMENT_DELAY_MS = 60_000
/** An expired row with no published settlement is kept this long, then pruned with a warning. */
export const DX_SETTLEMENT_WAIT_MS = 24 * 60 * 60_000
const OPTION_TYPES = ['call_options', 'put_options']

/** Is a sync owed? `lastSyncMs` is the last SUCCESSFUL one, 0 for never. */
export function dxSyncDue(nowMs: number, lastSyncMs: number): boolean {
  if (lastSyncMs <= 0 || nowMs - lastSyncMs >= DX_SYNC_EVERY_MS) return true
  // The most recent 12:00 UTC at or before now, plus the delay.
  const d = new Date(nowMs)
  let instant = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)
  if (instant > nowMs) instant -= 86_400_000
  const due = instant + DX_POST_SETTLEMENT_DELAY_MS
  return nowMs >= due && lastSyncMs < due
}

const isOption = (r: InstrumentRow): boolean => r.instrument_type === 'CE' || r.instrument_type === 'PE'
const isBtcOption = (r: InstrumentRow): boolean => isOption(r) && r.name === DX_UNDERLYING
const isSpotRow = (r: InstrumentRow): boolean => r.tradingsymbol === DX_SPOT_SYMBOL

export interface DxSyncPlan {
  readonly toUpsert: readonly InstrumentRow[]
  readonly toDelete: readonly number[]
  /** Expired, kept: referenced, or settlement not yet recorded. */
  readonly retainedExpired: readonly number[]
  /** Expired rows deleted although Delta never published a settlement. */
  readonly unsettledDropped: readonly number[]
}

export interface DxPlanInputs {
  /** Rows from the live listing (options and the spot). */
  readonly listed: readonly InstrumentRow[]
  readonly existing: readonly InstrumentRow[]
  readonly nowMs: number
  /** Is this stored row still needed by a book? */
  readonly referenced: (r: InstrumentRow) => boolean
  /** Product ids with a `dx-settlements` row. */
  readonly settled: ReadonlySet<number>
  readonly venue?: VenueSpec
}

/** Pure. See the module header for the rules. */
export function planDxSync(input: DxPlanInputs): DxSyncPlan {
  const venue = input.venue ?? DX
  const live = new Set(input.listed.map((r) => r.instrument_token))
  const toDelete: number[] = []
  const retainedExpired: number[] = []
  const unsettledDropped: number[] = []
  for (const r of input.existing) {
    if (live.has(r.instrument_token) || r.expiry === '') continue
    const instant = venue.expiryInstantMs(r.expiry)
    if (!(input.nowMs >= instant)) continue
    if (input.referenced(r)) {
      retainedExpired.push(r.instrument_token)
      continue
    }
    if (isOption(r) && !input.settled.has(r.instrument_token)) {
      if (input.nowMs - instant < DX_SETTLEMENT_WAIT_MS) {
        retainedExpired.push(r.instrument_token)
        continue
      }
      unsettledDropped.push(r.instrument_token)
    }
    toDelete.push(r.instrument_token)
  }
  return { toUpsert: input.listed, toDelete, retainedExpired, unsettledDropped }
}

/**
 * THE PRODUCT'S LEVERAGE ON ITS ROW (`dx_leverage`), from Delta's
 * `default_leverage` — what the short-option margin estimate divides the index
 * by (`@algomaker/desk-engine` `bull-s/margin.ts`). It varies by moneyness
 * (observed 20 / 100 / 200), so it is per product, never one number. A product
 * that states none carries `dx_leverage: null`: unknown, never a default.
 */
export type DxInstrumentRow = InstrumentRow & { readonly dx_leverage: number | null }

export function withLeverage(rows: readonly InstrumentRow[], products: readonly DxProduct[]): DxInstrumentRow[] {
  const byId = new Map(products.map((p) => [p.id, num(p.default_leverage)]))
  return rows.map((r) => {
    const lev = byId.get(r.instrument_token) ?? null
    return { ...r, dx_leverage: lev !== null && lev > 0 ? lev : null }
  })
}

/** Token → `dx_leverage` for every stored row that states one. */
export async function loadDxLeverage(collection: {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
}): Promise<Map<number, number>> {
  const docs = await collection.find({ dx_leverage: { $gt: 0 } }).toArray()
  const out = new Map<number, number>()
  for (const d of docs) {
    const token = Number(d['instrument_token'])
    const lev = Number(d['dx_leverage'])
    if (Number.isFinite(token) && Number.isFinite(lev) && lev > 0) out.set(token, lev)
  }
  return out
}

/** The Mongo surface the sync needs; `Collection` satisfies it. */
export interface DxCollection {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>
  deleteMany(filter: Record<string, unknown>): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

export interface DxSyncDeps {
  readonly rest: DxRestPort
  readonly normalise: DxNormaliser
  readonly instruments: DxCollection
  readonly settlements: DxCollection
  /** Stored rows, as `loadStoredInstruments` reads them. */
  readonly loadStored: () => Promise<InstrumentRow[]>
  /** Tokens held by an open `desk-books` leg. */
  readonly bookTokens: () => Promise<ReadonlySet<number>>
  /** `{symbol, expiry}` of every `desk-books-registry` row. */
  readonly registryChains: () => Promise<readonly { symbol: string; expiry: string }[]>
  readonly nowMs?: () => number
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface DxSyncResult {
  readonly plan: DxSyncPlan
  readonly options: number
  readonly spot: InstrumentRow | null
  readonly settlementsWritten: number
}

/**
 * One sync pass. Throws when the listing is unusable (fetch failed, or no BTC
 * option at all — a truncated answer, not a quiet market), leaving the stored
 * master exactly as it was.
 */
export async function runDxSync(d: DxSyncDeps): Promise<DxSyncResult> {
  const log = d.log ?? ((): void => {})
  const nowMs = (d.nowMs ?? Date.now)()

  const products = await d.rest.products({ contractTypes: OPTION_TYPES, states: ['live'], underlying: [DX_UNDERLYING] })
  const rows = withLeverage(d.normalise(products), products)
  const options = rows.filter(isBtcOption)
  if (options.length === 0) {
    throw new Error(`Delta listed ${products.length} products and no BTC option — refusing to apply`)
  }
  const spot = rows.find(isSpotRow) ?? null
  const listed = spot === null ? options : [...options, spot]

  const settlementsWritten = await recordSettlements(d, nowMs)

  const existing = await d.loadStored()
  const held = await d.bookTokens()
  const chains = new Set((await d.registryChains()).map((c) => `${c.symbol}|${c.expiry}`))
  const expiredIds = existing.filter((r) => r.expiry !== '' && nowMs >= DX.expiryInstantMs(r.expiry)).map((r) => r.instrument_token)
  const settledDocs = await d.settlements.find({ _id: { $in: expiredIds } }).toArray()
  const plan = planDxSync({
    listed,
    existing,
    nowMs,
    referenced: (r) => held.has(r.instrument_token) || chains.has(`${r.name}|${r.expiry}`),
    settled: new Set(settledDocs.map((s) => Number(s['_id']))),
  })

  await d.instruments.createIndex({ instrument_token: 1 }, { unique: true })
  await d.instruments.createIndex({ tradingsymbol: 1 })
  for (const row of plan.toUpsert) {
    await d.instruments.updateOne(
      { instrument_token: row.instrument_token },
      { $set: row as unknown as Record<string, unknown> },
      { upsert: true },
    )
  }
  if (plan.toDelete.length > 0) await d.instruments.deleteMany({ instrument_token: { $in: plan.toDelete } })
  if (plan.unsettledDropped.length > 0) {
    log('WARNING: expired Delta options pruned with NO published settlement price', {
      tokens: plan.unsettledDropped,
    })
  }
  log('dx instrument sync complete', {
    options: options.length,
    spot: spot?.instrument_token ?? null,
    deletes: plan.toDelete.length,
    retainedExpired: plan.retainedExpired.length,
    settlementsWritten,
  })
  return { plan, options: options.length, spot, settlementsWritten }
}

/**
 * Write the published settlement of every stored, expired, unrecorded option.
 *
 * One `products` call per pending expiry, filtered to that settlement date,
 * rather than the whole expired history (10,000+ BTC rows). A product whose
 * `settlement_price` is still null is skipped and retried next pass. Insert
 * only (`$setOnInsert`, keyed on the product id), so a second pass — or a
 * second process — never rewrites a price already booked against.
 */
export async function recordSettlements(d: DxSyncDeps, nowMs: number): Promise<number> {
  const expired = (await d.loadStored()).filter(
    (r) => isBtcOption(r) && r.expiry !== '' && nowMs >= DX.expiryInstantMs(r.expiry),
  )
  if (expired.length === 0) return 0
  const settledDocs = await d.settlements.find({ _id: { $in: expired.map((r) => r.instrument_token) } }).toArray()
  const settled = new Set(settledDocs.map((s) => Number(s['_id'])))
  const pending = expired.filter((r) => !settled.has(r.instrument_token))
  if (pending.length === 0) return 0
  const wanted = new Map(pending.map((r) => [r.instrument_token, r]))
  let written = 0
  for (const expiry of [...new Set(pending.map((r) => r.expiry))].sort()) {
    let products: readonly DxProduct[]
    try {
      products = await d.rest.products({
        contractTypes: OPTION_TYPES,
        states: ['expired', 'settled'],
        underlying: [DX_UNDERLYING],
        expiryDate: expiry,
      })
    } catch (err) {
      d.log?.('dx settlement fetch FAILED, will retry next sync', {
        expiry,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    for (const p of products) {
      const row = wanted.get(p.id)
      if (row === undefined || row.expiry !== expiry) continue
      const price = num(p.settlement_price)
      if (price === null || price < 0) continue
      await d.settlements.updateOne(
        { _id: p.id },
        { $setOnInsert: { _id: p.id, symbol: p.symbol, expiry, price, publishedAt: nowMs } },
        { upsert: true },
      )
      wanted.delete(p.id)
      written++
    }
  }
  return written
}
