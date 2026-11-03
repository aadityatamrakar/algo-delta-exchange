/**
 * The delta band (spec item 30): how much delta a book may carry, read off the
 * desk engine's own corridor under the `trader` preset, or a trader's override
 * in lots. Out of band by N lots is the excess past the band (Decision 7); To
 * Neutralize stays R2's sizing of the whole delta in the nearest future's lots,
 * so on one book the two lot counts may differ.
 *
 * A band is `unknown` — never a live-looking number — when the book is blocked,
 * the feed is dead in session, or a leg has no IV (an option of another expiry,
 * carried in the offset, included).
 *
 * Also here: the band events (`traders-events`, one per in↔out change) and the
 * overrides (`traders-settings`, one `kind: 'band'` document per trader, since
 * R1's index is unique on `{ kind, trader }`).
 */

import { TRADER_PRESET, corridor, resolveDials, type Dials } from '@algomaker/desk-engine'
import type { TradersDb } from '../db.ts'
import { STOCK_RE } from '../books/manual.ts'
import { contractText } from '../types.ts'
import { toNeutralize } from './analysis.ts'
import { OFFSET_INSTRUMENT, type EngineBookResult } from './engine-book.ts'
import type { BandStatus } from './r3-wire.ts'

export type { BandStatus } from './r3-wire.ts'

export const TRADER_DIALS: Dials = resolveDials(TRADER_PRESET.dials).dials

/** How every unknown band's sentence starts; what follows is the reason. */
export const BAND_UNKNOWN = 'Band unknown: '
const FEED_DEAD = `${BAND_UNKNOWN}the market data feed is dead`

const lots = (n: number): string => `${n} ${n === 1 ? 'lot' : 'lots'}`

/**
 * The band of one book. `override` is the trader's band in lots (null = the
 * engine's); `marketOpen` false reads the last prices and says so, since
 * outside the session a quiet feed is not a dead one.
 */
export function bandOf(book: EngineBookResult, stock: string, override: number | null, feedAlive: boolean, marketOpen: boolean): BandStatus {
  const source = override === null ? 'engine' : 'override'
  // unknown: no market number is given; an override is the trader's own, so it is
  const unknown = (sentence: string, lotSize: number | null): BandStatus => ({
    state: 'unknown', netDelta: null,
    bandShares: override !== null && lotSize !== null ? override * lotSize : null, bandLots: override,
    outByLots: 0, lotSize, source, toNeutralize: null, marketOpen, sentence,
  })
  if ('blocked' in book) return unknown(book.blocked, null)
  const lotSize = book.lotSize
  if (!(lotSize > 0)) return unknown(`${BAND_UNKNOWN}the ${book.expiry} chain has no lot size`, null)
  if (!feedAlive && marketOpen) return unknown(FEED_DEAD, lotSize)
  const cor = corridor(book.inputs, TRADER_DIALS)
  if (!cor.hasGreeks) {
    // the offset leg stands for the other expiries' options: name them, not it
    const names = book.inputs.legs
      .filter((l) => !l.hasGreeks)
      .flatMap((l) => l.instrument === OFFSET_INSTRUMENT ? book.offsetUnpriced
        : [contractText({ instrument: 'option', expiry: book.expiry, strike: l.strike, optType: l.optType })])
    return unknown(names.length === 1 ? `${BAND_UNKNOWN}a leg has no IV (${names[0] as string})` : `${BAND_UNKNOWN}${names.length} legs have no IV (${names.join(', ')})`, lotSize)
  }

  const bandShares = override === null ? cor.allowed : override * lotSize
  const bandLots = Math.round((bandShares / lotSize) * 10) / 10
  const excess = Math.abs(cor.netDelta) - bandShares
  const out = excess > 0
  const outByLots = out ? Math.ceil(excess / lotSize) : 0
  const nf = book.nearFuture
  const neutral = nf === null ? null : toNeutralize(cor.netDelta, stock, nf.expiry, nf.lotSize)
  const closed = marketOpen ? '' : ' (market closed)'
  const sentence = out
    ? `Out of band by ${lots(outByLots)}${neutral === null ? '' : ` — To neutralize: ${neutral.text}`}${closed}`
    : `In band (±${lots(bandLots)})${closed}`
  return { state: out ? 'out' : 'in', netDelta: cor.netDelta, bandShares, bandLots, outByLots, lotSize, source, toNeutralize: neutral, marketOpen, sentence }
}

// ---- band events ------------------------------------------------------------------

export interface BandEvent {
  readonly trader: string; readonly stock: string; readonly kind: 'band'
  readonly from: 'in' | 'out'; readonly to: 'in' | 'out'; readonly at: number
  readonly netDelta: number; readonly bandShares: number; readonly lotSize: number; readonly outByLots: number
  readonly source: 'engine' | 'override'
}

const NO_ID = { projection: { _id: 0 } } as const

/** `traders-events`: one row per in↔out change of a book's band, kept. */
export class EventStore {
  readonly #db: TradersDb

  constructor(db: TradersDb) {
    this.#db = db
  }

  async ensureIndexes(): Promise<void> {
    await this.#col().createIndex({ trader: 1, stock: 1, at: -1 })
  }

  async add(e: BandEvent): Promise<void> {
    await this.#col().insertOne({ ...e })   // a copy: the driver stamps `_id` on what it is given
  }

  /** The newest band event of every book that has one (read once, at boot: a row is written only on a change). */
  async lastBand(): Promise<BandEvent[]> {
    const out: BandEvent[] = []
    let last = ''
    for (const e of await this.#col().find({ kind: 'band' }, NO_ID).sort({ trader: 1, stock: 1, at: -1 }).toArray()) {
      const key = `${e.trader}|${e.stock}`
      if (key !== last) out.push(e)
      last = key
    }
    return out
  }

  #col() {
    return this.#db.collection<BandEvent>('traders-events')
  }
}

// ---- band overrides ---------------------------------------------------------------

interface BandDoc {
  readonly kind: 'band'; readonly trader: string
  readonly bands?: Readonly<Record<string, unknown>>; readonly updatedAt: number
}

/** `traders-settings` `{ kind: 'band', trader, bands: { <STOCK>: lots }, updatedAt }`: one document per trader. */
export class BandOverrideStore {
  readonly #db: TradersDb
  readonly #now: () => number

  constructor(db: TradersDb, now: () => number) {
    this.#db = db
    this.#now = now
  }

  /** The trader's band for `stock` in lots, or null for the engine's. */
  async get(trader: string, stock: string): Promise<number | null> {
    const doc = await this.#col().findOne({ kind: 'band', trader }, NO_ID)
    const bands = doc?.bands
    const v = bands !== undefined && Object.hasOwn(bands, stock) ? bands[stock] : undefined
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  }

  /** `lots` is validated by the caller; null clears the book's override. */
  async set(trader: string, stock: string, lots: number | null): Promise<void> {
    // the stock is a field name in the document: never a dot or a dollar in it
    if (!STOCK_RE.test(stock)) throw new Error(`not a stock: ${JSON.stringify(stock)}`)
    const key = { kind: 'band', trader }
    const field = `bands.${stock}`
    if (lots === null) await this.#col().updateOne(key, { $unset: { [field]: '' }, $set: { updatedAt: this.#now() } })
    else await this.#col().updateOne(key, { $set: { ...key, [field]: lots, updatedAt: this.#now() } }, { upsert: true })
  }

  #col() {
    return this.#db.collection<BandDoc>('traders-settings')
  }
}
