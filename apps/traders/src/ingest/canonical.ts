import type { Instrument, OptType } from '../types.ts'
import { isIsoDate, istDate } from '../routes/kit.ts'
import { ParseError, splitCsvLine } from './csv.ts'
import type { FileParser, ParsedFile, ParsedPosition } from './parsers.ts'

export const CANONICAL_HEADERS = {
  positions: 'client_code,stock,instrument,expiry,strike,type,qty,avg_price',
  orders: 'order_no,exch_order_no,client_code,stock,instrument,expiry,strike,type,side,qty,price,status,reason,time',
  trades: 'trade_no,order_no,client_code,stock,instrument,expiry,strike,type,side,qty,price,time',
} as const

interface Contract { stock: string; instrument: Instrument; expiry: string; strike: number | null; optType: OptType | null }
interface Row { line: number; cells: string[] }

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

function fail(line: number, reason: string): never {
  throw new ParseError(`line ${line}: ${reason}`)
}

/** Data rows with their 1-based line numbers (header is line 1); blank lines skipped, a last line without a newline is read. */
function rowsOf(text: string, columns: number): Row[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n')
  const rows: Row[] = []
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '')
    if (raw.trim() === '') continue
    const cells = splitCsvLine(raw).map((c) => c.trim())
    if (cells.length !== columns) fail(i + 1, `expected ${columns} columns, got ${cells.length}`)
    rows.push({ line: i + 1, cells })
  }
  return rows
}

function num(line: number, name: string, v: string): number {
  const n = v === '' ? NaN : Number(v)
  if (!Number.isFinite(n)) fail(line, `${name} "${v}" is not a number`)
  return n
}

function whole(line: number, name: string, v: string): number {
  const n = /^[+-]?\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isSafeInteger(n)) fail(line, `${name} "${v}" is not a whole number`)
  return n
}

function positiveQty(line: number, v: string): number {
  const n = whole(line, 'qty', v)
  if (n <= 0) fail(line, 'qty must be positive')
  return n
}

function price(line: number, v: string): number {
  const n = num(line, 'price', v)
  if (n < 0) fail(line, 'price must not be negative')
  return n
}

function required(line: number, name: string, v: string): string {
  if (v === '') fail(line, `${name} is empty`)
  return v
}

function contract(line: number, stockRaw: string, instr: string, expiry: string, strikeRaw: string, typeRaw: string): Contract {
  const stock = stockRaw.toUpperCase()
  if (!/^[A-Z0-9&-]{1,20}$/.test(stock)) fail(line, `stock "${stockRaw}" is not a valid symbol`)
  if (instr !== 'option' && instr !== 'future' && instr !== 'share') fail(line, `instrument "${instr}" must be option, future or share`)
  if (instr === 'share') {
    if (expiry !== '' || strikeRaw !== '' || typeRaw !== '') fail(line, 'a share has no expiry, strike or type')
    return { stock, instrument: instr, expiry: '', strike: null, optType: null }
  }
  if (!isIsoDate(expiry)) fail(line, `expiry "${expiry}" must be a date like 2026-10-27`)
  if (instr === 'future') {
    if (strikeRaw !== '' || typeRaw !== '') fail(line, 'a future has no strike or type')
    return { stock, instrument: instr, expiry, strike: null, optType: null }
  }
  const strike = num(line, 'strike', strikeRaw)
  if (strike <= 0) fail(line, 'strike must be positive')
  const t = typeRaw.toUpperCase()
  if (t !== 'CE' && t !== 'PE') fail(line, 'an option needs type CE or PE')
  return { stock, instrument: instr, expiry, strike, optType: t }
}

function side(line: number, v: string): 'Buy' | 'Sell' {
  const s = v.toLowerCase()
  if (s === 'buy') return 'Buy'
  if (s === 'sell') return 'Sell'
  fail(line, `side "${v}" must be Buy or Sell`)
}

function timeMs(line: number, v: string): number {
  if (!ISO_TIME.test(v)) fail(line, `time "${v}" needs an ISO 8601 offset`)
  const ms = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (!Number.isFinite(ms)) fail(line, `time "${v}" is not a valid date`)
  return ms
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function fileDay(path: string, rowDays: readonly string[]): string {
  const m = /\d{4}-\d{2}-\d{2}/.exec(baseName(path))
  if (m && isIsoDate(m[0])) return m[0]
  return rowDays.reduce((a, b) => (b > a ? b : a), '')
}

function parsePositions(text: string, path: string): ParsedFile {
  const positions: ParsedPosition[] = []
  for (const { line, cells: c } of rowsOf(text, 8)) {
    const k = contract(line, c[1]!, c[2]!, c[3]!, c[4]!, c[5]!)
    positions.push({
      clientCode: required(line, 'client_code', c[0]!), stock: k.stock, instrument: k.instrument,
      expiry: k.expiry, strike: k.strike, optType: k.optType,
      qty: whole(line, 'qty', c[6]!), avgPrice: num(line, 'avg_price', c[7]!),
    })
  }
  return { kind: 'positions', day: fileDay(path, []), positions }
}

function parseOrders(text: string, path: string): ParsedFile {
  const orders: NonNullable<ParsedFile['orders']>[number][] = []
  for (const { line, cells: c } of rowsOf(text, 14)) {
    const k = contract(line, c[3]!, c[4]!, c[5]!, c[6]!, c[7]!)
    const time = timeMs(line, c[13]!)
    orders.push({
      orderNo: required(line, 'order_no', c[0]!), exchOrderNo: c[1]!, clientCode: required(line, 'client_code', c[2]!),
      stock: k.stock, instrument: k.instrument, expiry: k.expiry, strike: k.strike, optType: k.optType,
      side: side(line, c[8]!), qty: positiveQty(line, c[9]!), price: price(line, c[10]!),
      status: c[11]!, reason: c[12]!, time, day: istDate(time), filledQty: null, updateTime: time,
    })
  }
  return { kind: 'orders', day: fileDay(path, orders.map((o) => o.day)), orders }
}

function parseTrades(text: string, path: string): ParsedFile {
  const trades: NonNullable<ParsedFile['trades']>[number][] = []
  for (const { line, cells: c } of rowsOf(text, 12)) {
    const k = contract(line, c[3]!, c[4]!, c[5]!, c[6]!, c[7]!)
    const time = timeMs(line, c[11]!)
    trades.push({
      tradeNo: required(line, 'trade_no', c[0]!), orderNo: c[1]!, clientCode: required(line, 'client_code', c[2]!),
      stock: k.stock, instrument: k.instrument, expiry: k.expiry, strike: k.strike, optType: k.optType,
      side: side(line, c[8]!), qty: positiveQty(line, c[9]!), price: price(line, c[10]!),
      time, day: istDate(time), seq: line,
    })
  }
  return { kind: 'trades', day: fileDay(path, trades.map((t) => t.day)), trades }
}

function canonical(id: string, header: string, parse: (text: string, path: string) => ParsedFile): FileParser {
  return { id, matches: (_path, firstLine) => firstLine === header, parse }
}

export const canonicalPositions: FileParser = canonical('canonical-positions', CANONICAL_HEADERS.positions, parsePositions)
export const canonicalOrders: FileParser = canonical('canonical-orders', CANONICAL_HEADERS.orders, parseOrders)
export const canonicalTrades: FileParser = canonical('canonical-trades', CANONICAL_HEADERS.trades, parseTrades)

export const CANONICAL_PARSERS_LIST: readonly FileParser[] = [canonicalPositions, canonicalOrders, canonicalTrades]
