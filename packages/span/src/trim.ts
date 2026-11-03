import { scanXml } from './xml.ts'
import { SPAN_TAGS } from './spn.ts'

const T = SPAN_TAGS

/** Block element -> the child element that names its symbol. */
const BLOCKS: Readonly<Record<string, string>> = {
  [T.ccDef]: T.cc, [T.futPf]: T.pfCode, [T.oopPf]: T.pfCode, [T.phyPf]: T.pfCode,
}

/**
 * Cuts a real SPAN file down to a few symbols for a test fixture: drops every
 * commodity / futures / options / physical block whose symbol is not in `symbols`
 * and keeps all else byte for byte. A block that names no symbol is kept.
 */
export function trimSpanXml(xml: string, symbols: ReadonlySet<string>): string {
  const cuts: [number, number][] = []
  let block: { name: string; start: number; symbol: string | null } | null = null
  let depth = 0                                   // open elements since the block's own open, itself included
  scanXml(xml, {
    open(name, at) {
      if (block) depth++
      else if (BLOCKS[name]) { block = { name, start: at, symbol: null }; depth = 1 }
    },
    close(name, text, end) {
      if (!block) return
      if (depth === 2 && block.symbol === null && name === BLOCKS[block.name]) block.symbol = text   // direct child only
      if (--depth > 0) return
      if (block.symbol !== null && !symbols.has(block.symbol)) cuts.push([block.start, end])
      block = null
    },
  })
  let out = '', from = 0
  for (const [a, b] of cuts) { out += xml.slice(from, a); from = b }
  return out + xml.slice(from)
}
