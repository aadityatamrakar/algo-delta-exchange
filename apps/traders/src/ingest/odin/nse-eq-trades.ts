/**
 * ODIN's NSE equities trade file, `Nse Equities/Trades/MMDDTRD.TXT`: one line
 * per trade, appended during the session, a different layout from
 * derivatives. Pinned against the operator's sample: 26 fields, or 23 in files
 * without the trailing `NSE Eq` and two blanks (four traders' ODIN, 21 Oct 2026). 1-based:
 * 1 trade no · 2 `11` · 3 symbol · 4 series (`EQ`, `BE`, ...) · 5 company name
 * (ignored) · 9 member code (ignored) · 11 side 1/2 · 12 qty · 13 price ·
 * 15 client code · 20 trade time · 22 exchange order no · 24 `NSE Eq`.
 * Each line is a cash-equity trade, so it becomes an `instrument: 'share'` leg.
 * A line that cannot be read is skipped and reported; the rest still land.
 */

import type { TraderTrade } from '../../types.ts'
import { istDate } from '../../routes/kit.ts'
import type { FileParser, ParsedFile } from '../parsers.ts'
import { odinInt, odinNum, odinRows, odinSide, odinTime } from './common.ts'

const PATH = /(^|\/)nse equities\/trades\/\d{4}trd\.txt$/i
type Row = Omit<TraderTrade, 'trader'>

function rowOf(f: readonly string[], seq: number): Row {
  if (f.length !== 23 && f.length !== 26) throw new Error(`expected 23 or 26 fields, got ${f.length}`)
  if (f[1] !== '11') throw new Error(`trade status "${f[1]}" is not 11`)   // the only code in the sample; any other is not understood, so skipped
  const stock = f[2]!.toUpperCase()
  if (stock === '') throw new Error('symbol is empty')
  if (f[3] === '') throw new Error('series is empty')
  const side = odinSide(f[10]!)
  const qty = odinInt(f[11]!, 'qty')
  if (qty <= 0) throw new Error('qty must be positive')
  const price = odinNum(f[12]!, 'price')
  if (price < 0) throw new Error('price must not be negative')
  if (f[0] === '' || f[21] === '') throw new Error('trade no and exchange order no are required')
  const time = odinTime(f[19]!)
  return {
    tradeNo: f[0]!, orderNo: f[21]!, clientCode: f[14]!, stock, instrument: 'share', expiry: '', strike: null, optType: null,
    side, qty, price, time, day: istDate(time), seq,
  }
}

export const odinNseEqTrades: FileParser = {
  id: 'odin-nse-eq-trades',
  /** Claimed by path alone: the layout is a per-line check, so a changed ODIN layout is skipped and reported by `parse` (a ParseError when no line reads), never stored silently. */
  matches(path: string): boolean {
    return PATH.test(path)
  },
  parse(text: string): ParsedFile {
    const { rows: trades, skipped } = odinRows(text, rowOf)
    return { kind: 'trades', day: trades[0]?.day ?? '', trades, skipped }
  },
}
