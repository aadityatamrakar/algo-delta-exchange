import type { Instrument, LogLine, OptType, TraderOrder, TraderTrade } from '../types.ts'
import { CANONICAL_PARSERS_LIST } from './canonical.ts'
import { ParseError } from './csv.ts'

export interface ParsedPosition { clientCode: string; stock: string; instrument: Instrument; expiry: string; strike: number | null; optType: OptType | null; qty: number; avgPrice: number }
export interface ParsedFile {
  readonly kind: 'positions' | 'orders' | 'trades' | 'log'
  readonly day: string                                  // 'YYYY-MM-DD' the file is about
  readonly positions?: readonly ParsedPosition[]
  readonly orders?: readonly Omit<TraderOrder, 'trader'>[]
  readonly trades?: readonly Omit<TraderTrade, 'trader'>[]
  readonly log?: readonly Omit<LogLine, 'trader'>[]
  readonly skipped?: readonly { readonly lineNo: number; readonly reason: string }[]   // lines not understood; reported, never silent (ODIN parsers skip a bad line instead of failing the file)
}
export interface FileParser {
  readonly id: string
  matches(path: string, firstLine: string): boolean
  parse(text: string, path: string): ParsedFile         // throws ParseError with a one-line reason
}
export { ParseError }

export const CANONICAL_PARSERS: readonly FileParser[] = CANONICAL_PARSERS_LIST

let registered: readonly FileParser[] = CANONICAL_PARSERS

/** Replace the registry (R1: the ODIN parsers, then the canonical three). First match wins. */
export function registerParsers(list: readonly FileParser[]): void {
  registered = [...list]
}

export function parserFor(path: string, firstLine: string): FileParser | null {
  return registered.find((p) => p.matches(path, firstLine)) ?? null
}

/** UTF-16LE with a BOM is decoded as such; anything else is UTF-8 with any BOM stripped. */
export function decodeText(body: Buffer): string {
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return body.subarray(2).toString('utf16le')
  const s = body.toString('utf8')
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function firstLineOf(text: string): string {
  const i = text.indexOf('\n')
  return (i < 0 ? text : text.slice(0, i)).replace(/\r$/, '')
}
