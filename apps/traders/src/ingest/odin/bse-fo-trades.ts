/**
 * ODIN's BSE derivatives trade file, `BSE Derivatives/Trades/MMDDTRD.TXT`
 * (SENSEX index options). Wider than the NSE layout, 51 fields, or 48 in
 * files without the trailing `BSE OPT` and two blanks. 1-based: 1 trade no ·
 * 2 trade time · 3 `11` · 6 `IO` (index option) · 7 symbol · 9 expiry
 * `08 OCT 2026` · 10 strike · 11 CE/PE · 15 price · 16 qty.
 * The layout is positional and some columns move by one between buy and sell
 * lines (member code in 13 on a buy, 14 on a sell), so the order no is the
 * first 19-digit field and the client code the field two before it.
 *
 * Side is OUR READING of the sample, not a documented column: the last code
 * before the `BSE OPT` field (the last field when there is none), `1` buy and
 * `2` sell. It agrees with the member-code column on every sample line (4 buy,
 * 23 sell); a line where they disagree is skipped. To be confirmed against a
 * trader's BSE Trade Book.
 *
 * 47 fields: the 48-field line without its side code (a trader's ODIN, 21 Oct 2026). The member-code column
 * is then the side; on the 735 lines of other traders' files that carry both, the two never disagreed.
 * A line that cannot be read is skipped and reported; the rest still land.
 */

import type { TraderTrade } from '../../types.ts'
import { istDate } from '../../routes/kit.ts'
import type { FileParser, ParsedFile } from '../parsers.ts'
import { odinExpiry, odinInt, odinNum, odinRows, odinSide, odinTime } from './common.ts'

const PATH = /(^|\/)bse derivatives\/trades\/\d{4}trd\.txt$/i
const ORDER_NO = /^\d{19}$/

type Row = Omit<TraderTrade, 'trader'>

function rowOf(f: readonly string[], seq: number): Row {
  if (f.length !== 47 && f.length !== 48 && f.length !== 51) throw new Error(`expected 47, 48 or 51 fields, got ${f.length}`)
  if (f[2] !== '11') throw new Error(`trade status "${f[2]}" is not 11`)
  if (f[5] !== 'IO') throw new Error(`BSE instrument "${f[5]}" not understood`)
  const stock = f[6]!.toUpperCase()
  if (stock === '') throw new Error('symbol is empty')
  const strike = odinNum(f[9]!, 'strike')
  if (strike <= 0) throw new Error('strike must be positive')
  if (f[10] !== 'CE' && f[10] !== 'PE') throw new Error(`option type "${f[10]}" must be CE or PE`)
  const qty = odinInt(f[15]!, 'qty')
  if (qty <= 0) throw new Error('qty must be positive')
  const price = odinNum(f[14]!, 'price')
  if (price < 0) throw new Error('price must not be negative')
  if (f[0] === '') throw new Error('trade no is required')
  const orderAt = f.findIndex((v) => ORDER_NO.test(v))
  if (orderAt < 0) throw new Error('no 19-digit order number')
  const clientCode = f[orderAt - 2] ?? ''
  if (clientCode === '') throw new Error('client code is empty')
  const memberOnBuyColumn = f[12] !== '' && f[13] === ''
  const memberOnSellColumn = f[12] === '' && f[13] !== ''
  let side: 'Buy' | 'Sell'
  if (f.length === 47) {
    if (memberOnBuyColumn === memberOnSellColumn) throw new Error('no side code, and no member-code column to read the side from')
    side = memberOnBuyColumn ? 'Buy' : 'Sell'
  } else {
    const marker = f.indexOf('BSE OPT')
    side = odinSide(marker >= 0 ? f[marker - 1]! : f[f.length - 1]!)
    if (side === 'Buy' ? !memberOnBuyColumn : !memberOnSellColumn) throw new Error('side code and member-code column disagree')
  }
  const time = odinTime(f[1]!)
  return {
    tradeNo: f[0]!, orderNo: f[orderAt]!, clientCode, stock, instrument: 'option',
    expiry: odinExpiry(f[8]!), strike, optType: f[10], side, qty, price, time, day: istDate(time), seq,
  }
}

export const odinBseFoTrades: FileParser = {
  id: 'odin-bse-fo-trades',
  /** Claimed by path alone: the layout is a per-line check, so a changed ODIN layout is skipped and reported by `parse` (a ParseError when no line reads), never stored silently. */
  matches(path: string): boolean {
    return PATH.test(path)
  },
  parse(text: string): ParsedFile {
    const { rows: trades, skipped } = odinRows(text, rowOf)
    return { kind: 'trades', day: trades[0]?.day ?? '', trades, skipped }
  },
}
