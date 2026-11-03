/**
 * ODIN's NSE order files, `Nse Derivatives/Orders/` and `Nse Equities/Orders/`:
 * one line per order, rewritten as the order moves. Two name styles occur,
 * `NSE_DDMMYYYYOrd.txt` and `MMDDORD.TXT`, with the same columns. Orders feed
 * the Orders page only; they never change positions (those come from trades).
 *
 * Derivatives, 35 fields, pinned against 5,189 sample rows. 1-based:
 * 1 exchange order no (`0` before the exchange accepts) · 2 status code ·
 * 3 instrument · 4 symbol · 5 expiry · 6 strike · 7 CE/PE · 8 trading symbol
 * (ignored) · 14 side 1/2 · 17 pending qty · 18 order qty (reads 0 on some
 * fully traded rows) · 21 filled qty · 22 price · 23 client code (blank before
 * acceptance) · 32 last update time · 34 order entry time.
 *
 * Equities, 34 fields. UNCONFIRMED: only three sample rows. 1 exchange order
 * no · 2 status · 3 symbol · 4 series · 11 side · 15 order qty · 18 filled
 * qty · 19 price · 26 client code · 30 last update time · 33 order entry time.
 *
 * `reason` is always '': no column in the sample carries one (field 25 of the
 * derivatives layout is always blank).
 * A line that cannot be read is skipped and reported; the rest still land.
 */

import type { Instrument, OptType, TraderOrder } from '../../types.ts'
import { istDate } from '../../routes/kit.ts'
import { sha256hex } from '../../hash.ts'
import type { FileParser, ParsedFile } from '../parsers.ts'
import { odinExpiry, odinInt, odinNum, odinRows, odinSide, odinTime } from './common.ts'

const PATH = /(^|\/)nse (derivatives|equities)\/orders\/[^/]+\.txt$/i
const FO_FIELDS = 35
const EQ_FIELDS = 34
const INSTRUMENTS: ReadonlyMap<string, Instrument> = new Map([['OPTSTK', 'option'], ['OPTIDX', 'option'], ['FUTSTK', 'future'], ['FUTIDX', 'future']])

/** Our reading of ODIN's status codes; the runbook asks the trader to confirm 1 and 6. */
export const ODIN_ORDER_STATUS: Readonly<Record<string, string>> = { '1': 'Open', '3': 'Partly traded', '4': 'Traded', '5': 'Cancelled', '6': 'Rejected' }

type Row = Omit<TraderOrder, 'trader'>

function statusOf(code: string): string {
  if (code === '') throw new Error('status code is empty')
  return Object.hasOwn(ODIN_ORDER_STATUS, code) ? `${ODIN_ORDER_STATUS[code]} (${code})` : `code ${code}`
}

function qtyOf(v: string, what: string): number {
  const n = odinInt(v, what)
  if (n < 0) throw new Error(`${what} must not be negative`)
  return n
}

/** One line in its folder's layout: derivatives 35 fields, equities 34. */
function rowOf(f: readonly string[], eq: boolean): Row {
  const fields = eq ? EQ_FIELDS : FO_FIELDS
  if (f.length !== fields) throw new Error(`expected ${fields} fields, got ${f.length}`)
  let instrument: Instrument = 'share'
  let stock: string
  let expiry = ''
  let strike: number | null = null
  let optType: OptType | null = null
  let sideAt: number, orderQty: number, pending = 0, filled: number, price: number, clientAt: number, updateAt: number, entryAt: number
  if (eq) {
    stock = f[2]!.toUpperCase()
    if (f[3] === '') throw new Error('series is empty')
    ;[sideAt, clientAt, updateAt, entryAt] = [10, 25, 29, 32]
    orderQty = qtyOf(f[14]!, 'order qty'); filled = qtyOf(f[17]!, 'filled qty'); price = odinNum(f[18]!, 'price')
  } else {
    const inst = INSTRUMENTS.get(f[2]!)
    if (!inst) throw new Error(`instrument "${f[2]}" is not OPTSTK, OPTIDX, FUTSTK or FUTIDX`)
    instrument = inst
    stock = f[3]!.toUpperCase()
    expiry = odinExpiry(f[4]!)
    if (instrument === 'option') {
      strike = odinNum(f[5]!, 'strike')
      if (strike <= 0) throw new Error('strike must be positive')
      if (f[6] !== 'CE' && f[6] !== 'PE') throw new Error(`option type "${f[6]}" must be CE or PE`)
      optType = f[6]
    }
    ;[sideAt, clientAt, updateAt, entryAt] = [13, 22, 31, 33]
    pending = qtyOf(f[16]!, 'pending qty'); orderQty = qtyOf(f[17]!, 'order qty'); filled = qtyOf(f[20]!, 'filled qty'); price = odinNum(f[21]!, 'price')
  }
  if (stock === '') throw new Error('symbol is empty')
  if (price < 0) throw new Error('price must not be negative')
  const qty = Math.max(orderQty, pending + filled)
  if (qty <= 0) throw new Error('qty must be positive')
  const side = odinSide(f[sideAt]!)
  const exchOrderNo = f[0]!
  if (exchOrderNo === '') throw new Error('exchange order no is required')
  const time = odinTime(f[entryAt]!)
  // an order the exchange never accepted (an after-hours entry) has no last update: it was last touched when entered
  const updateTime = f[updateAt]!.trim() === '' ? time : odinTime(f[updateAt]!)
  // Not yet accepted by the exchange: key it by what was asked for, so every rewrite of the line is the same order.
  const orderNo = exchOrderNo !== '0' ? exchOrderNo
    : `local:${sha256hex([...f.slice(2, 8), f[sideAt], String(orderQty), String(price), f[entryAt]].join('|')).slice(0, 16)}`
  return {
    orderNo, exchOrderNo, clientCode: f[clientAt]!, stock, instrument, expiry, strike, optType, side, qty, price,
    status: statusOf(f[1]!), reason: '', time, day: istDate(time), filledQty: filled, updateTime,
  }
}

export const odinNseOrders: FileParser = {
  id: 'odin-nse-orders',
  /** Claimed by path alone: the layout is a per-line check, so a changed ODIN layout is skipped and reported by `parse` (a ParseError when no line reads), never stored silently. */
  matches(path: string): boolean {
    return PATH.test(path)
  },
  parse(text: string, path: string): ParsedFile {
    const eq = PATH.exec(path)?.[2]!.toLowerCase() === 'equities'
    const { rows: orders, skipped } = odinRows(text, (f) => rowOf(f, eq))
    return { kind: 'orders', day: orders[0]?.day ?? '', orders, skipped }
  },
}
