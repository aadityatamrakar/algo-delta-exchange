/**
 * What fills cost (spec item 14a): brokerage, STT, exchange transaction
 * charges, SEBI fees, stamp duty and GST, from one rates table the admin edits
 * (`GET|PUT /v1/traders/admin/settings`).
 *
 * SEED_RATES are placeholders FOR THE OPERATOR TO CONFIRM: none of them is
 * asserted to be today's statutory rate. They ship with `confirmedBy: null`,
 * and the page says the expenses are estimates until the admin saves a table.
 *
 * Turnover is qty × price, on the premium for an option. STT is charged on the
 * side's own rate, stamp duty on buys only, GST on brokerage + exchange + SEBI.
 * Brokerage is per order (distinct `orderNo`) or per lot (an F&O fill's
 * qty / lot size; a share fill, or one whose lot size is unknown, pays once per
 * order).
 */

import type { TradersDb } from '../db.ts'
import { isObject, type Log } from '../routes/kit.ts'
import type { Instrument } from '../types.ts'
import type { Brokerage, ChargeRates, SegmentRates } from './wire.ts'

export interface Fill {
  readonly instrument: Instrument; readonly side: 'Buy' | 'Sell'; readonly qty: number /* shares, > 0 */
  readonly price: number; readonly orderNo: string; readonly lotSize: number | null
}

export interface ChargeBreakdown {
  readonly brokerage: number; readonly stt: number; readonly exchange: number; readonly sebi: number
  readonly stamp: number; readonly gst: number; readonly total: number
}

/** For the operator to confirm (Phase 0 Q5) — not today's statutory rates. */
export const SEED_RATES: ChargeRates = {
  option: { sttBuyPct: 0, sttSellPct: 0.1, exchangePct: 0.03503, stampBuyPct: 0.003 },
  future: { sttBuyPct: 0, sttSellPct: 0.02, exchangePct: 0.00173, stampBuyPct: 0.002 },
  share: { sttBuyPct: 0.1, sttSellPct: 0.1, exchangePct: 0.00297, stampBuyPct: 0.015 },
  sebiPerCrore: 10,
  gstPct: 18,
  brokerage: { default: { mode: 'order', amount: 20 }, byTrader: {} },
  confirmedBy: null,
  confirmedAt: null,
}

/** The trader's own brokerage, else the default. Only an own key counts: a username can be `constructor`. */
export function brokerageFor(rates: ChargeRates, trader: string): Brokerage {
  const own = rates.brokerage.byTrader
  return Object.hasOwn(own, trader) ? (own[trader] as Brokerage) : rates.brokerage.default
}

const segmentOf = (rates: ChargeRates, i: Instrument): SegmentRates => (i === 'option' ? rates.option : i === 'future' ? rates.future : rates.share)

export function chargesFor(fills: readonly Fill[], rates: ChargeRates, trader: string): ChargeBreakdown {
  const b = brokerageFor(rates, trader)
  let stt = 0
  let exchange = 0
  let sebi = 0
  let stamp = 0
  let perLot = 0
  const flatOrders = new Set<string>()
  for (const f of fills) {
    const r = segmentOf(rates, f.instrument)
    const turnover = f.qty * f.price
    stt += (turnover * (f.side === 'Buy' ? r.sttBuyPct : r.sttSellPct)) / 100
    exchange += (turnover * r.exchangePct) / 100
    sebi += (turnover * rates.sebiPerCrore) / 1e7
    if (f.side === 'Buy') stamp += (turnover * r.stampBuyPct) / 100
    if (b.mode === 'lot' && f.instrument !== 'share' && f.lotSize !== null && f.lotSize > 0) perLot += (b.amount * f.qty) / f.lotSize
    else flatOrders.add(f.orderNo)
  }
  const brokerage = perLot + b.amount * flatOrders.size
  const gst = ((brokerage + exchange + sebi) * rates.gstPct) / 100
  return { brokerage, stt, exchange, sebi, stamp, gst, total: brokerage + stt + exchange + sebi + stamp + gst }
}

// ---- the table as the admin sends it ----------------------------------------

const PCT_MAX = 5
const SEBI_MAX = 1000
const GST_MAX = 50
const AMOUNT_MAX = 10_000
const BY_TRADER_MAX = 100
const USERNAME = /^[a-z0-9._-]{2,32}$/
const SEGMENT_FIELDS = ['sttBuyPct', 'sttSellPct', 'exchangePct', 'stampBuyPct'] as const

class BadRates extends Error {}

const at = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`)

function objectAt(v: unknown, path: string): Record<string, unknown> {
  if (!isObject(v)) throw new BadRates(`${path} must be an object`)
  return v
}

function numberAt(o: Record<string, unknown>, key: string, path: string, max: number): number {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new BadRates(`${at(path, key)} must be 0–${max}`)
  return v
}

function segmentAt(o: Record<string, unknown>, key: string): SegmentRates {
  const s = objectAt(o[key], key)
  const [sttBuyPct, sttSellPct, exchangePct, stampBuyPct] = SEGMENT_FIELDS.map((f) => numberAt(s, f, key, PCT_MAX)) as [number, number, number, number]
  return { sttBuyPct, sttSellPct, exchangePct, stampBuyPct }
}

function brokerageAt(v: unknown, path: string): Brokerage {
  const b = objectAt(v, path)
  const mode = b['mode']
  if (mode !== 'order' && mode !== 'lot') throw new BadRates(`${path}.mode must be 'order' or 'lot'`)
  return { mode, amount: numberAt(b, 'amount', path, AMOUNT_MAX) }
}

function readRates(raw: unknown): ChargeRates {
  const o = objectAt(raw, 'charges')
  const b = objectAt(o['brokerage'], 'brokerage')
  const own = objectAt(b['byTrader'], 'brokerage.byTrader')
  const names = Object.keys(own)
  if (names.length > BY_TRADER_MAX) throw new BadRates(`brokerage.byTrader has more than ${BY_TRADER_MAX} entries`)
  for (const n of names) if (!USERNAME.test(n)) throw new BadRates(`brokerage.byTrader: "${n}" is not a username (2-32 of a-z, 0-9, . _ -)`)
  return {
    option: segmentAt(o, 'option'), future: segmentAt(o, 'future'), share: segmentAt(o, 'share'),
    sebiPerCrore: numberAt(o, 'sebiPerCrore', '', SEBI_MAX),
    gstPct: numberAt(o, 'gstPct', '', GST_MAX),
    brokerage: {
      default: brokerageAt(b['default'], 'brokerage.default'),
      // fromEntries defines own properties, so a `__proto__` username stays a plain entry
      byTrader: Object.fromEntries(names.map((n) => [n, brokerageAt(own[n], `brokerage.byTrader.${n}`)])),
    },
    confirmedBy: null,
    confirmedAt: null,
  }
}

/**
 * A rates table from untrusted JSON, or the first problem naming its field
 * path (`option.sttSellPct`). The sender's `confirmedBy` / `confirmedAt` are
 * ignored (null): only a save stamps them. Unknown keys are dropped.
 */
export function parseRates(raw: unknown): ChargeRates | { readonly error: string } {
  try {
    return readRates(raw)
  } catch (err) {
    if (err instanceof BadRates) return { error: err.message }
    throw err
  }
}

// ---- the stored table ---------------------------------------------------------

interface ChargesDoc {
  readonly kind: 'charges'; readonly trader: null
  readonly value: unknown; readonly updatedAt: number; readonly updatedBy: string
}

const KEY = { kind: 'charges', trader: null } as const
const NO_ID = { projection: { _id: 0 } } as const

/**
 * The desk's one rates table: `traders-settings` `{ kind: 'charges', trader:
 * null }` (R1's unique `{ kind, trader }` index keeps it single). Nothing
 * stored, or a stored table that no longer parses, reads as SEED_RATES.
 */
export class ChargeSettingsStore {
  readonly #db: TradersDb
  readonly #now: () => number
  readonly #log: Log

  constructor(db: TradersDb, now: () => number, log: Log = () => {}) {
    this.#db = db
    this.#now = now
    this.#log = log
  }

  async get(): Promise<ChargeRates> {
    const doc = await this.#col().findOne(KEY, NO_ID)
    if (doc === null) return SEED_RATES
    const r = parseRates(doc.value)
    if ('error' in r) {
      this.#log('stored charge rates do not parse; the seed rates are used', { error: r.error })
      return SEED_RATES
    }
    const by = typeof doc.updatedBy === 'string' ? doc.updatedBy : null
    return { ...r, confirmedBy: by, confirmedAt: by !== null && typeof doc.updatedAt === 'number' ? doc.updatedAt : null }
  }

  /** `rates` is parsed by the caller; the save confirms them as `by`, now. */
  async put(rates: ChargeRates, by: string): Promise<ChargeRates> {
    const now = this.#now()
    const stamped: ChargeRates = { ...rates, confirmedBy: by, confirmedAt: now }
    await this.#col().updateOne(KEY, { $set: { ...KEY, value: stamped, updatedAt: now, updatedBy: by } }, { upsert: true })
    this.#log('charge rates saved', { by })
    return stamped
  }

  #col() {
    return this.#db.collection<ChargesDoc>('traders-settings')
  }
}
