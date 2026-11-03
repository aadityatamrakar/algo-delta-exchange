// Live quotes for the traders app: the desk's own QuoteCache, fed read-only from
// the bus (`md.tick`, `md.health`) - no new feed, nothing published back. The
// cache is the desk's (`apps/api/src/marks.ts`, no runtime imports), so a price
// here is exactly the price the desk shows. There is no previous close: the bus
// does not carry one.
import type { Transport } from '@algomaker/bus'
import type { QuoteCache } from '../../../api/src/marks.ts'
import type { TradersDb } from '../db.ts'

export interface TraderQuote {
  readonly price: number
  readonly bid: number | null
  readonly ask: number | null
  readonly oi: number | null
  readonly volume: number | null
  /** Epoch ms of the tick (or of the stored snapshot) this came from. */
  readonly asOf: number
  readonly ageMs: number
  /** The cache's own verdict: older than its stale threshold (60 s). The price is still shown. */
  readonly stale?: boolean
}

export interface TradersQuotes {
  quote(token: number): TraderQuote | null
  feedAlive(): boolean
}

/** What a screen says in session when `feedAlive()` is false. */
export const FEED_NOT_TICKING = 'the price feed is not ticking: every price below is the last one seen, not a live one'

/** Display reads: past the dead-feed gate and down to the snapshot. Screens say when a quote is not live. */
export function tradersQuotes(cache: QuoteCache): TradersQuotes {
  return {
    quote(token) {
      const q = cache.displayQuote(token)
      if (q === null) return null
      return { price: q.price, bid: q.bid, ask: q.ask, oi: q.oi, volume: q.volume, asOf: q.asOf, ageMs: q.ageMs, stale: q.stale }
    },
    feedAlive: () => cache.feedAlive(),
  }
}

export interface FeedHealth {
  payload: Record<string, unknown> | null
  receivedAt: number | null
}

interface TickPayload {
  token: number
  price: number
  ts: number
  oi?: number
  volume?: number
  bid?: number
  ask?: number
  depth?: { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] }
}

/** md.tick -> the cache, md.health -> `health` (stamped on arrival). Returns the unsubscribe. */
export function attachFeed(bus: Transport, marks: QuoteCache, health: FeedHealth, now: () => number): () => void {
  const offTick = bus.subscribe<TickPayload>('md.tick', (m) => {
    const p = m.payload
    marks.update(p.token, p.price, p.ts, { oi: p.oi, volume: p.volume, bid: p.bid, ask: p.ask, depth: p.depth })
  })
  const offHealth = bus.subscribe<Record<string, unknown>>('md.health', (m) => {
    health.payload = m.payload
    health.receivedAt = now()
  })
  return () => {
    offTick()
    offHealth()
  }
}

/** desk-marks rows -> the cache's display snapshot, as apps/api/src/main.ts does. Returns the row count. */
export async function seedSnapshot(db: TradersDb, marks: QuoteCache): Promise<number> {
  const rows = await db.desk('desk-marks').find({}).toArray()
  marks.loadSnapshot(
    rows.map((r) => ({
      token: Number(r['token']),
      price: Number(r['price']),
      ts: Number(r['ts']),
      bid: typeof r['bid'] === 'number' ? r['bid'] : null,
      ask: typeof r['ask'] === 'number' ? r['ask'] : null,
      bookTs: typeof r['bookTs'] === 'number' ? r['bookTs'] : null,
    })),
  )
  return rows.length
}
