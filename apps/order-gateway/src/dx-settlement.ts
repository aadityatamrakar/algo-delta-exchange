/**
 * DELTA SETTLEMENT, BOOKED AT DELTA'S PRICE (spec §5.4, §5.4a; Review Focus 4).
 *
 * At 12:00 UTC every BTC option of that expiry is cash-settled by Delta against
 * the 30-minute TWAP of `.DEXBTUSD`. Marketdata (T5) writes each settled
 * product's price to `dx-settlements` `{_id: productId, symbol, expiry, price,
 * publishedAt}`. This job books each still-open leg of an expired contract at
 * exactly that price — paper and live alike — and nothing else:
 *
 *   - NOTHING BEFORE THE INSTANT. A leg is settled only once `now` is at or
 *     after its expiry instant (12:00:00 UTC on the expiry date).
 *   - NEVER AN INVENTED PRICE. No row (or a row with no finite price) means the
 *     leg waits; the job runs every minute, so it retries until the row exists.
 *     Still missing 30 minutes after the instant → an ALERT, once per contract,
 *     and still no close.
 *   - NOTHING STILL OUT. A contract with a non-terminal gateway order on it
 *     waits until that order is terminal, so a late fill cannot close the leg
 *     a second time.
 *   - NET PER CONTRACT. Legs on one contract are netted, the way a close fill
 *     acts on them; legs that net to zero are left where they are.
 *   - THE SETTLEMENT FEE. Delta charges the taker rate on contracts open at
 *     settlement, none when the option expires worthless. The cap is applied
 *     too until Delta confirms otherwise (§5.4a). The index for the notional
 *     term is the one the price implies: a CE settles at index − strike, a PE
 *     at strike − index.
 *
 * Booking goes through `mongoSettlementBooker`: one `desk-decisions` record per
 * book, rail and contract (`settle-<tag>-<mode>-<symbol>`, unique — a retry
 * reuses it), then a compare-and-set fold into `desk-books` with the decision
 * id as the receipt — the same two steps and the same order `settle-expired.ts`
 * uses for NSE paper legs.
 */
import { optionFee } from '@algomaker/dx'
import { DX, type VenueSpec } from '@algomaker/venue'
import { refoldOnConflict } from '../../api/src/book-write.ts'
import type { BridgeLeg, DeskMode, Fill } from '../../api/src/contract.ts'
import { foldRoutedFillsIntoBook } from '../../api/src/decision-plan.ts'
import { notifySupervisor } from '../../api/src/engine-notify.ts'
import { isDuplicateKey } from '../../api/src/errors.ts'
import { settleDecisionId } from '../../api/src/settle-expired.ts'
import { COLLECTIONS, DeskStore } from '../../api/src/store.ts'
import { TERMINAL_STATES } from './queue.ts'

export const DX_SETTLEMENTS_COLLECTION = 'dx-settlements'
/** How long after the instant a missing price becomes an alert. */
export const DX_SETTLEMENT_ALERT_MS = 30 * 60_000
/** How often the job looks. Cheap: one read of the books, one of the prices. */
export const DX_SETTLEMENT_POLL_MS = 60_000

/** One `dx-settlements` row, as marketdata writes it. */
export interface DxSettlementRow {
  readonly _id: number
  readonly symbol: string
  readonly expiry: string
  readonly price: number
  readonly publishedAt: number
}

export interface OpenLeg {
  readonly deskTag: string
  readonly instrument: { readonly tradingsymbol: string; readonly instrumentToken?: number }
  readonly expiry: string
  readonly strike: number
  readonly type: 'CE' | 'PE'
  /** Signed BTC: negative is short. */
  readonly qty: number
}

export interface OpenBook {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
  readonly legs: readonly OpenLeg[]
}

/** One close to book. */
export interface SettlementBooking {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly tradingsymbol: string
  readonly productId: number
  /** The leg the close is booked against (the first leg on the contract). */
  readonly deskTag: string
  /** The CLOSING side, in the desk's spelling: a short is closed by a Buy. */
  readonly side: 'Buy' | 'Sell'
  /** Positive BTC. */
  readonly qty: number
  /** Delta's settlement price, USD per BTC. */
  readonly price: number
  /** Total settlement fee + GST, USD. 0 when worthless. */
  readonly fee: number
  /**
   * The expiry instant − 1 ms: the last moment of the settled day, so
   * `DX.dayKey(ts) === expiry` (the instant itself belongs to the next day).
   */
  readonly ts: number
  readonly expiry: string
  readonly strike: number
  readonly type: 'CE' | 'PE'
  readonly publishedAt: number
}

/** An expired contract with no price yet. */
export interface SettlementWait {
  readonly tag: string
  readonly mode: DeskMode
  readonly tradingsymbol: string
  readonly expiry: string
  /** How long past the instant. */
  readonly overdueMs: number
}

const STEP = DX.qtyStep
const clean = (x: number): number => Number(x.toFixed(8))

function usablePrice(r: DxSettlementRow | undefined): number | null {
  if (r === undefined) return null
  const p = r.price
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 ? p : null
}

/**
 * WHAT WOULD SETTLE NOW, as data. No clock, no Mongo.
 */
export function planDxSettlement(
  books: readonly OpenBook[],
  rows: readonly DxSettlementRow[],
  nowMs: number,
  venue: VenueSpec = DX,
): { readonly book: readonly SettlementBooking[]; readonly waiting: readonly SettlementWait[] } {
  const byId = new Map<number, DxSettlementRow>()
  const bySymbol = new Map<string, DxSettlementRow>()
  for (const r of rows) {
    byId.set(Number(r._id), r)
    if (typeof r.symbol === 'string' && r.symbol !== '') bySymbol.set(r.symbol, r)
  }
  const out: SettlementBooking[] = []
  const waiting: SettlementWait[] = []
  for (const b of books) {
    const byContract = new Map<string, OpenLeg[]>()
    for (const l of b.legs) {
      const sym = l.instrument?.tradingsymbol ?? ''
      if (sym === '') continue
      const list = byContract.get(sym)
      if (list === undefined) byContract.set(sym, [l])
      else list.push(l)
    }
    for (const [tradingsymbol, legs] of byContract) {
      const first = legs[0] as OpenLeg
      let instant: number
      try {
        instant = venue.expiryInstantMs(first.expiry)
      } catch {
        continue // an unreadable expiry is not this job's to guess at
      }
      if (nowMs < instant) continue
      const net = clean(legs.reduce((s, l) => s + (Number.isFinite(l.qty) ? l.qty : Number.NaN), 0))
      if (!Number.isFinite(net) || net === 0) continue
      const token = first.instrument.instrumentToken
      const r = (token !== undefined && token > 0 ? byId.get(token) : undefined) ?? bySymbol.get(tradingsymbol)
      const price = usablePrice(r)
      if (price === null || r === undefined) {
        waiting.push({ tag: b.tag, mode: b.mode, tradingsymbol, expiry: first.expiry, overdueMs: nowMs - instant })
        continue
      }
      const qty = Math.abs(net)
      const contracts = Math.round(qty / STEP)
      const index = first.type === 'CE' ? first.strike + price : Math.max(0, first.strike - price)
      const fee = price > 0 ? optionFee({ contracts, index, premium: price }).total : 0
      out.push({
        tag: b.tag,
        mode: b.mode,
        symbol: b.symbol,
        tradingsymbol,
        productId: Number(r._id),
        deskTag: first.deskTag,
        side: net > 0 ? 'Sell' : 'Buy',
        qty,
        price,
        fee,
        // ONE MILLISECOND BEFORE the instant: the DX day D is [D-1 12:00Z,
        // D 12:00Z), so a close stamped AT 12:00:00.000 would land in the next
        // day's report and day guard. This keeps the expiry's P&L on its day.
        ts: instant - 1,
        expiry: first.expiry,
        strike: first.strike,
        type: first.type,
        publishedAt: Number(r.publishedAt) || 0,
      })
    }
  }
  return { book: out, waiting }
}

export interface DxSettlementPorts {
  /** Every book holding at least one non-zero leg. */
  readonly listBooks: () => Promise<readonly OpenBook[]>
  readonly settlements: () => Promise<readonly DxSettlementRow[]>
  /** Non-terminal gateway orders on this contract for this book and rail. */
  readonly workingOn: (tag: string, mode: DeskMode, tradingsymbol: string) => Promise<number>
  /** Idempotent: a second call for the same booking books nothing. */
  readonly book: (b: SettlementBooking) => Promise<'booked' | 'already'>
  readonly alert: (w: SettlementWait) => Promise<void>
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
}

export interface DxSettlementJob {
  /** One pass. NEVER REJECTS, never overlaps itself. */
  run(): Promise<{ readonly booked: number; readonly waiting: number; readonly alerted: number }>
}

export function createDxSettlementJob(
  ports: DxSettlementPorts,
  opts: { readonly alertAfterMs?: number } = {},
): DxSettlementJob {
  const alertAfterMs = opts.alertAfterMs ?? DX_SETTLEMENT_ALERT_MS
  /** `tag|mode|symbol` already alerted — once per contract per process. */
  const alerted = new Set<string>()
  let running = false
  const idle = { booked: 0, waiting: 0, alerted: 0 }
  return {
    async run() {
      if (running) return idle
      running = true
      let booked = 0
      let newAlerts = 0
      let waitingN = 0
      try {
        const books = await ports.listBooks()
        if (books.length === 0) return idle
        const plan = planDxSettlement(books, await ports.settlements(), ports.now())
        waitingN = plan.waiting.length
        for (const w of plan.waiting) {
          if (w.overdueMs < alertAfterMs) continue
          const key = `${w.tag}|${w.mode}|${w.tradingsymbol}`
          if (alerted.has(key)) continue
          alerted.add(key)
          newAlerts++
          ports.log('DX SETTLEMENT PRICE MISSING — the leg is NOT settled and will not be until Delta publishes it', {
            ...w,
          })
          try {
            await ports.alert(w)
          } catch (err) {
            ports.log('dx settlement alert failed', { error: String(err) })
          }
        }
        for (const b of plan.book) {
          try {
            const out = await ports.workingOn(b.tag, b.mode, b.tradingsymbol)
            if (out > 0) {
              ports.log('dx settlement waits: an order is still out on the contract', {
                tag: b.tag, mode: b.mode, tradingsymbol: b.tradingsymbol, working: out,
              })
              continue
            }
            const r = await ports.book(b)
            if (r === 'booked') {
              booked++
              ports.log('DX LEG SETTLED at Delta\'s price', {
                tag: b.tag, mode: b.mode, tradingsymbol: b.tradingsymbol, side: b.side, qty: b.qty, price: b.price, fee: b.fee,
              })
            }
          } catch (err) {
            // One bad leg never stops the pass; it is retried next tick.
            ports.log('dx settlement booking failed — retried next pass', {
              tag: b.tag, tradingsymbol: b.tradingsymbol, error: String(err),
            })
          }
        }
      } catch (err) {
        ports.log('dx settlement pass failed', { error: String(err) })
      } finally {
        running = false
      }
      return { booked, waiting: waitingN, alerted: newAlerts }
    },
  }
}

// ------------------------------------------------------------ Mongo wiring

interface Db {
  collection(name: string): {
    find(filter: Record<string, unknown>): { toArray(): Promise<unknown[]> }
    findOne(filter: Record<string, unknown>): Promise<unknown>
    insertOne(doc: Record<string, unknown>): Promise<unknown>
    countDocuments(filter: Record<string, unknown>): Promise<number>
  }
}

/** Every `desk-books` row holding a non-zero leg, read as `OpenBook`. */
export async function listOpenBooks(db: Db): Promise<OpenBook[]> {
  const docs = (await db
    .collection(COLLECTIONS.books)
    .find({ legs: { $elemMatch: { qty: { $ne: 0 } } } })
    .toArray()) as Record<string, unknown>[]
  return docs.map((d) => ({
    tag: String(d['tag'] ?? ''),
    mode: d['mode'] === 'live' ? 'live' : 'paper',
    symbol: String(d['symbol'] ?? ''),
    expiry: String(d['expiry'] ?? ''),
    legs: (Array.isArray(d['legs']) ? d['legs'] : []) as OpenLeg[],
  }))
}

/** Non-terminal gateway orders for this book, rail and contract. */
export async function countWorking(db: Db, tag: string, mode: DeskMode, tradingsymbol: string): Promise<number> {
  return await db.collection('desk-gateway-orders').countDocuments({
    tag,
    tradingsymbol,
    mode: mode === 'live' ? 'live' : { $ne: 'live' },
    state: { $nin: [...TERMINAL_STATES] },
  })
}

/**
 * The booking port: the decision record first, the book second — a crash
 * between them leaves the money right and only the derived book behind, and a
 * re-run folds it once.
 */
export function mongoSettlementBooker(deps: {
  readonly db: Db
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** Tells the supervisor the book moved. Defaults to the engine nudge; a test passes its own. */
  readonly notify?: (tag: string, mode: DeskMode) => Promise<void>
}): (b: SettlementBooking) => Promise<'booked' | 'already'> {
  const store = new DeskStore(deps.db as never)
  const notify =
    deps.notify ??
    (async (tag: string, mode: DeskMode): Promise<void> => {
      await notifySupervisor('fill', { tag, mode, source: 'settle' }, { log: deps.log })
    })
  return async (b) => {
    const nowMs = deps.now()
    const decisionId = settleDecisionId(b.tag, b.mode, b.tradingsymbol)
    const fill: Fill & { readonly fee: number } = {
      op: 'close',
      deskTag: b.deskTag,
      tradingsymbol: b.tradingsymbol,
      side: b.side,
      qty: b.qty,
      price: b.price,
      ts: b.ts,
      fee: b.fee,
    }
    let fresh = true
    let booked: Fill = fill
    try {
      await deps.db.collection(COLLECTIONS.decisions).insertOne({
        decisionId,
        symbol: b.symbol,
        expiry: b.expiry,
        mode: b.mode,
        tag: b.tag,
        fills: [fill],
        skips: [],
        createdAt: b.ts,
        writtenAt: nowMs,
        completedAt: nowMs,
        status: 'DONE',
        source: 'settle',
        desk_op: 'settle',
        settlement: {
          rule: 'delta',
          price: b.price,
          fee: b.fee,
          productId: b.productId,
          publishedAt: b.publishedAt,
          strike: b.strike,
          type: b.type,
        },
      })
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
      fresh = false
      const existing = (await deps.db.collection(COLLECTIONS.decisions).findOne({ decisionId })) as
        | Record<string, unknown>
        | null
      const prior = Array.isArray(existing?.['fills']) ? (existing['fills'] as Fill[])[0] : undefined
      if (existing === null || existing['source'] !== 'settle' || prior === undefined) {
        throw new Error(`decision id ${decisionId} is already taken by something that is not a settlement`)
      }
      booked = prior
    }

    const doc = await store.bookDoc(b.tag, b.mode)
    if (doc !== null && !(doc.appliedCorrections ?? []).includes(decisionId)) {
      const folded = foldRoutedFillsIntoBook(doc.legs as readonly BridgeLeg[], [booked], nowMs)
      if (folded.touched) {
        const key = { tag: b.tag, mode: b.mode, symbol: doc.symbol, expiry: doc.expiry }
        const saved = await store.saveBook(key, folded.legs, nowMs, doc.updatedAt, decisionId)
        if (saved === 'conflict') {
          await refoldOnConflict({
            store,
            key,
            routedFills: [booked],
            nextBook: folded.legs,
            priorBook: doc.legs,
            mayCreate: false,
            nowMs,
            nonce: decisionId,
            log: (m) => deps.log(m),
          })
        }
        // The book moved under a supervisor that may still be steering it.
        await notify(b.tag, b.mode)
        return 'booked'
      }
    }
    return fresh ? 'booked' : 'already'
  }
}
