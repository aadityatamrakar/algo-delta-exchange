/**
 * Seed an ALREADY-OPEN position into a book.
 *
 * Distinct from `applyDecision`, and deliberately so: these legs are already
 * held at the broker. Routing orders for them would double the position. So
 * seeding writes the book directly, at the entry prices actually paid, and
 * emits nothing to any rail.
 *
 * Entry prices come from the operator's own record, not from the live feed —
 * marking an existing position at today's price would erase its P&L and make
 * every subsequent realised number wrong.
 */

import type { OptionMaster } from '@algomaker/instruments'
import type { OptionType } from '@algomaker/greeks'
import type { BridgeLeg, DeskMode, DeskSide } from './contract.ts'
import { signedQty } from './contract.ts'
import type { DeskStore } from './store.ts'

export interface SeedLeg {
  readonly strike: number
  readonly type: OptionType
  /** SIGNED contract quantity: negative is short, matching the desk sheet. */
  readonly qty: number
  /** Entry price actually paid, per unit. */
  readonly rate: number
  /** Optional desk tag; generated stably from strike+type when absent. */
  readonly ts?: string
}

export interface SeedRequest {
  /** The book's identity. Books are keyed by tag; see store.ts. */
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly legs: readonly SeedLeg[]
}

export interface SeedResult {
  readonly booked: readonly BridgeLeg[]
  readonly unresolved: readonly { strike: number; type: string; reason: string }[]
}

export function buildSeedBook(
  req: SeedRequest,
  master: OptionMaster,
  nowMs: number,
): SeedResult {
  const booked: BridgeLeg[] = []
  const unresolved: { strike: number; type: string; reason: string }[] = []

  for (const leg of req.legs) {
    if (leg.qty === 0) {
      unresolved.push({ strike: leg.strike, type: leg.type, reason: 'qty is zero' })
      continue
    }
    const instrument = master.resolve(req.symbol, req.expiry, leg.strike, leg.type)
    if (instrument === null) {
      unresolved.push({
        strike: leg.strike,
        type: leg.type,
        reason: `${req.symbol} ${req.expiry} ${leg.strike}${leg.type} is not a listed contract`,
      })
      continue
    }
    // The sheet's quantity must be a whole number of lots, or it cannot have
    // been traded. Catching it here beats discovering it at the first roll.
    if (Math.abs(leg.qty) % instrument.lotSize !== 0) {
      unresolved.push({
        strike: leg.strike,
        type: leg.type,
        reason: `qty ${leg.qty} is not a multiple of lot size ${instrument.lotSize}`,
      })
      continue
    }
    const side: DeskSide = leg.qty < 0 ? 'Sell' : 'Buy'
    booked.push({
      deskTag: leg.ts ?? `${leg.type}${leg.strike}#seed`,
      instrument,
      underlying: req.symbol,
      expiry: req.expiry,
      strike: leg.strike,
      type: leg.type,
      side,
      qty: signedQty(side, leg.qty),
      entryPrice: leg.rate,
      openedTs: nowMs,
    })
  }

  return { booked, unresolved }
}

/**
 * Seed and persist. Refuses to overwrite a non-empty book unless `replace` is
 * set — re-running a seed script against a live book would silently discard
 * every fill since.
 */
export async function seedBook(
  req: SeedRequest,
  deps: { store: DeskStore; master: OptionMaster; nowMs: number; replace?: boolean },
): Promise<SeedResult> {
  const existing = await deps.store.loadBook(req.tag, req.mode)
  if (existing.length > 0 && deps.replace !== true) {
    throw new Error(
      `${req.symbol} (${req.mode}) already holds ${existing.length} legs; pass replace to overwrite`,
    )
  }
  const result = buildSeedBook(req, deps.master, deps.nowMs)
  // NO VERSION PIN, deliberately — this is the one write that is allowed to be
  // unconditional. A seed either creates the document (there is no prior
  // version to compare against) or is an explicit `replace` of it, which is a
  // human saying "the legs I am handing you ARE the book". The compare-and-set
  // in `store.saveBook` guards the order path's read-modify-write windows
  // (`book-write.ts`); a declaration has no such window, and pinning one here
  // would only make a seed fail for a reason the operator cannot act on.
  await deps.store.saveBook(
    { tag: req.tag, mode: req.mode, symbol: req.symbol, expiry: req.expiry },
    result.booked,
    deps.nowMs,
  )
  return result
}

/**
 * The BHEL opening position used to live here as a hardcoded `BHEL_SEED`
 * constant, then as an NSE seed file (not carried into the Delta desk). Any
 * seed file is applied with:
 *
 *   node apps/api/src/cli.ts seed --file <seed.json>
 *
 * `BHEL_SEED` was the phase-0 migration's rollback path; it stopped being one
 * once the desk-books registry (`books-registry.ts`) could create the same
 * book, which is why it was retired only after that registry existed.
 */
