/**
 * ODIN's NSE derivatives trade file, `Nse Derivatives/Trades/MMDDTRD.TXT`:
 * one line per trade, appended during the session. Pinned against the
 * operator's sample: 25 fields, or 28 in files that add `NSE OPT`/`NSE FUT`
 * and two blanks, or 26 in files that add one number after `NIL` (a trader's
 * ODIN, 21 Oct 2026; not read). 1-based: 1 trade no · 2 `11` · 3 instrument · 4 symbol ·
 * 5 expiry · 6 strike (blank for futures) · 7 CE/PE (blank for futures) ·
 * 8 trading symbol (ignored: contracts are matched from 3–7) · 12 user id ·
 * 14 side 1/2 · 15 qty in shares · 16 price · 18 client code · 20 `OPEN` ·
 * 22 trade time · 23 order time · 24 exchange order no · 25 `NIL`.
 * A line that cannot be read is skipped and reported; the rest still land.
 */

import type { Instrument, OptType, TraderTrade } from '../../types.ts'
import { istDate } from '../../routes/kit.ts'
import type { FileParser, ParsedFile } from '../parsers.ts'
import { odinExpiry, odinInt, odinNum, odinRows, odinSide, odinTime } from './common.ts'

const PATH = /(^|\/)nse derivatives\/trades\/\d{4}trd\.txt$/i
const INSTRUMENTS: ReadonlyMap<string, Instrument> = new Map([['OPTSTK', 'option'], ['OPTIDX', 'option'], ['FUTSTK', 'future'], ['FUTIDX', 'future']])
type Row = Omit<TraderTrade, 'trader'>

function rowOf(f: readonly string[], seq: number): Row {
  if (f.length !== 25 && f.length !== 26 && f.length !== 28) throw new Error(`expected 25, 26 or 28 fields, got ${f.length}`)
  if (f[1] !== '11') throw new Error(`trade status "${f[1]}" is not 11`)   // the only code in the sample; any other is not understood, so skipped
  const instrument = INSTRUMENTS.get(f[2]!)
  if (!instrument) throw new Error(`instrument "${f[2]}" is not OPTSTK, OPTIDX, FUTSTK or FUTIDX`)
  const stock = f[3]!.toUpperCase()
  if (stock === '') throw new Error('symbol is empty')
  let strike: number | null = null
  let optType: OptType | null = null
  if (instrument === 'option') {
    strike = odinNum(f[5]!, 'strike')
    if (strike <= 0) throw new Error('strike must be positive')
    if (f[6] !== 'CE' && f[6] !== 'PE') throw new Error(`option type "${f[6]}" must be CE or PE`)
    optType = f[6]
  }
  const qty = odinInt(f[14]!, 'qty')
  if (qty <= 0) throw new Error('qty must be positive')
  const price = odinNum(f[15]!, 'price')
  if (price < 0) throw new Error('price must not be negative')
  if (f[0] === '' || f[23] === '') throw new Error('trade no and exchange order no are required')
  const time = odinTime(f[21]!)
  return {
    tradeNo: f[0]!, orderNo: f[23]!, clientCode: f[17]!, stock, instrument, expiry: odinExpiry(f[4]!), strike, optType,
    side: odinSide(f[13]!), qty, price, time, day: istDate(time), seq,
  }
}

export const odinNseFoTrades: FileParser = {
  id: 'odin-nse-fo-trades',
  /** Claimed by path alone: the layout is a per-line check, so a changed ODIN layout is skipped and reported by `parse` (a ParseError when no line reads), never stored silently. */
  matches(path: string): boolean {
    return PATH.test(path)
  },
  parse(text: string): ParsedFile {
    const { rows: trades, skipped } = odinRows(text, rowOf)
    return { kind: 'trades', day: trades[0]?.day ?? '', trades, skipped }
  },
}
