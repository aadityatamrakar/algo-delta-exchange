/**
 * Price one book and publish the answer.
 *
 * THE SEAM IS MONGO, exactly as it is for the XTS snapshot: the process holding
 * the session publishes, desk-api only reads. This refresher lives in
 * desk-marketdata for one reason — the Kite enctoken exists ONLY in
 * `feed-pool.ts` process memory, persisted nowhere. desk-api opening its own
 * Kite session would mean a second login, and a second IJ0574 login invalidates
 * the first: that is the 2026-08-04 feed outage, reproduced deliberately.
 *
 * A FAILED REFRESH NEVER OVERWRITES A GOOD FIGURE. It records `ok:false` and a
 * diagnostic and leaves the numbers and `asOf` alone, so the tile AGES rather
 * than blanking or freezing. A margin tile that silently keeps showing a stale
 * number as if it were current is the exact class of bug this whole feature
 * exists to correct — it must not be reintroduced by the error path.
 */
import type { BridgeLeg } from '../../../api/src/contract.ts'
import { basketOrders } from './basket.ts'
import type { KiteMarginClient } from './kite.ts'

export const BOOK_MARGIN_COLLECTION = 'desk-book-margin'

export interface MarginDoc {
  readonly _id: string
  readonly asOf: number
  readonly ok: boolean
  readonly source: 'kite'
  readonly span: number
  readonly exposure: number
  readonly premium: number
  readonly premiumPaid: number
  readonly total: number
  readonly legs: readonly { tradingsymbol: string; span: number; exposure: number; total: number }[]
  readonly diagnostic: string
}

/** The subset of a Mongo collection this needs, so tests need no Mongo. */
export interface MarginStore {
  updateOne(
    filter: { _id: string },
    update: Record<string, unknown>,
    options: { upsert: boolean },
  ): Promise<unknown>
}

export interface RefreshDeps {
  readonly store: MarginStore
  readonly client: KiteMarginClient
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

/**
 * Price `legs` and publish under `tag`. Never throws — a margin refresh failing
 * must not take down the feed process it runs inside.
 */
export async function refreshBookMargin(
  deps: RefreshDeps,
  tag: string,
  legs: readonly BridgeLeg[],
): Promise<boolean> {
  const orders = basketOrders(legs)
  if (orders.length === 0) {
    // Not an error and not a failure to record: a flat book has no margin, and
    // saying so is more useful than leaving yesterday's figure standing.
    await deps.store.updateOne(
      { _id: tag },
      {
        $set: {
          asOf: deps.now(),
          ok: true,
          source: 'kite',
          span: 0,
          exposure: 0,
          premium: 0,
          premiumPaid: 0,
          total: 0,
          legs: [],
          diagnostic: '',
        },
      },
      { upsert: true },
    )
    return true
  }
  try {
    const quote = await deps.client.basketMargin(orders)
    await deps.store.updateOne(
      { _id: tag },
      {
        $set: {
          asOf: deps.now(),
          ok: true,
          source: 'kite',
          span: quote.span,
          exposure: quote.exposure,
          premium: quote.premium,
          premiumPaid: quote.premiumPaid,
          total: quote.total,
          legs: quote.legs,
          diagnostic: '',
        },
      },
      { upsert: true },
    )
    return true
  } catch (err) {
    const diagnostic = err instanceof Error ? err.message : String(err)
    deps.log('book margin refresh failed', { tag, error: diagnostic })
    // ONLY the failure fields. No `asOf`, no figures — see the file header.
    // `$setOnInsert` so a book that has never priced successfully still gets a
    // row explaining why, instead of the endpoint reporting "no document yet".
    await deps.store.updateOne(
      { _id: tag },
      {
        $set: { ok: false, diagnostic },
        $setOnInsert: {
          asOf: 0,
          source: 'kite',
          span: 0,
          exposure: 0,
          premium: 0,
          premiumPaid: 0,
          total: 0,
          legs: [],
        },
      },
      { upsert: true },
    )
    return false
  }
}
