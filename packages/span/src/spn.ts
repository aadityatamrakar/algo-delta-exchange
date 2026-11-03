import { scanXml, SpanParseError } from './xml.ts'

export { SpanParseError }

export interface SpanContract {
  readonly kind: 'future' | 'option'
  /** 'YYYY-MM-DD', or 'YYYY-MM' when the file gives only a month */
  readonly period: string
  readonly strike: number | null
  readonly optType: 'CE' | 'PE' | null
  readonly price: number
  readonly delta: number
  /** exactly 16 */
  readonly riskArray: readonly number[]
}
export interface SpanTier { readonly tier: number; readonly startMonth: string; readonly endMonth: string }
export interface SpanSpread {
  readonly priority: number
  readonly rate: number
  /** A leg names a tier (`tLeg`: a range of months) or one contract period (`pLeg`: an expiry date, as NSE's files do). */
  readonly legs: readonly SpanSpreadLeg[]
}
export type SpanSpreadLeg =
  | { readonly tier: number; readonly period: null; readonly side: 'A' | 'B'; readonly ratio: number }
  | { readonly tier: null; readonly period: string; readonly side: 'A' | 'B'; readonly ratio: number }
export interface SpanCommodity {
  readonly symbol: string
  readonly contracts: ReadonlyMap<string, SpanContract>
  readonly tiers: readonly SpanTier[]
  readonly spreads: readonly SpanSpread[]
  readonly somRate: number
}
export interface SpanFile {
  readonly businessDate: string
  readonly settlement: boolean
  readonly created: string | null
  readonly commodities: ReadonlyMap<string, SpanCommodity>
}

/**
 * Every element name this parser reads, in ONE place (V-SP1). This is the best
 * reading of NSE's SPAN layout, written from the format description and not from
 * a file in hand: verify against a real file before trusting it, and fix the map
 * here, not the parser.
 */
export const SPAN_TAGS = {
  // header
  pointInTime: 'pointInTime', date: 'date', isSetl: 'isSetl', created: 'created',
  // futures: futPf(pfCode) > fut(pe, p, ra(a x16, d))
  futPf: 'futPf', pfCode: 'pfCode', fut: 'fut',
  // physical-delivery products: phyPf(pfCode) — trimmed by symbol only, never read; unverified like the rest
  // options: oopPf(pfCode) > series(pe) > opt(o, k, p, ra)
  oopPf: 'oopPf', phyPf: 'phyPf', series: 'series', opt: 'opt', optType: 'o', strike: 'k',
  period: 'pe', price: 'p', riskArray: 'ra', riskValue: 'a', delta: 'd',
  // commodity: ccDef(cc) > intrTiers/tier(tn, sPe, ePe), dSpread(spread, rate/val, tLeg(tn, rs, i)), somTiers/tier/rate/val
  // interSpreads/dSpread is inter-commodity: not read (the margin is per commodity), and NSE's is an empty placeholder
  // NSE's files say intraTiers, and their spreads' legs are pLeg(cc, pe, rs, i): one expiry date each
  ccDef: 'ccDef', cc: 'cc', intrTiers: 'intrTiers', intraTiers: 'intraTiers', somTiers: 'somTiers', tier: 'tier', interSpreads: 'interSpreads',
  pLeg: 'pLeg',
  tierNo: 'tn', tierStart: 'sPe', tierEnd: 'ePe',
  dSpread: 'dSpread', spreadPriority: 'spread', rate: 'rate', val: 'val',
  tLeg: 'tLeg', legSide: 'rs', legRatio: 'i',
} as const satisfies Readonly<Record<string, string>>
const T = SPAN_TAGS

export function spanKey(kind: 'future' | 'option', period: string, strike: number | null, optType: 'CE' | 'PE' | null): string {
  return `${kind}|${period}|${strike ?? ''}|${optType ?? ''}`
}

/** The full expiry first, then its month: a far contract may be listed by month only (V-SP7). */
export function findContract(
  c: SpanCommodity, kind: 'future' | 'option', expiry: string, strike: number | null, optType: 'CE' | 'PE' | null,
): SpanContract | null {
  return c.contracts.get(spanKey(kind, expiry, strike, optType))
    ?? c.contracts.get(spanKey(kind, expiry.slice(0, 7), strike, optType))
    ?? null
}

function period(s: string, what: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})?$/.exec(s)
  if (!m) throw new SpanParseError(`${what}: unreadable period '${s}'`)
  return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`
}
function month(s: string, what: string): string { return period(s, what).slice(0, 7) }
function num(s: string, what: string): number {
  const n = Number(s)
  if (s === '' || !Number.isFinite(n)) throw new SpanParseError(`${what}: '${s}' is not a number`)
  return n
}

interface Builder {
  contracts: Map<string, SpanContract>
  tiers: SpanTier[]
  spreads: SpanSpread[]
  somRate: number
}
interface ContractDraft { period: string; strike: number | null; optType: 'CE' | 'PE' | null; price: number | null; delta: number | null; ra: number[] }

export function parseSpanFile(xml: string, only?: ReadonlySet<string>): SpanFile {
  const stack: string[] = []
  const parent = (n = 1): string => stack[stack.length - 1 - n] ?? ''   // called on close, the element itself is still on the stack
  const builders = new Map<string, Builder>()
  let businessDate = ''
  let settlement = false
  let created: string | null = null

  let pf = ''                    // current futPf / oopPf symbol
  let seriesPeriod = ''
  let draft: ContractDraft | null = null
  let tierDraft: { tn: number; s: string; e: string } | null = null
  let inSom = false
  let inInter = false
  let spreadDraft: { priority: number; rate: number; legs: SpanSpreadLeg[] } | null = null
  let legDraft: { tier: number | null; period: string | null; side: 'A' | 'B'; ratio: number } | null = null
  let cc = ''

  const builder = (sym: string): Builder | null => {
    if (only && !only.has(sym)) return null
    let b = builders.get(sym)
    if (!b) builders.set(sym, b = { contracts: new Map(), tiers: [], spreads: [], somRate: 0 })
    return b
  }

  scanXml(xml, {
    open(name) {
      stack.push(name)
      if (name === T.futPf || name === T.oopPf) pf = ''
      else if (name === T.fut || name === T.opt) {
        draft = { period: name === T.fut ? '' : seriesPeriod, strike: null, optType: null, price: null, delta: null, ra: [] }
      } else if (name === T.series) seriesPeriod = ''
      else if (name === T.ccDef) { cc = ''; inSom = false }
      else if (name === T.somTiers) inSom = true
      else if (name === T.interSpreads) inInter = true
      else if (name === T.tier) tierDraft = { tn: 0, s: '', e: '' }
      else if (name === T.dSpread) spreadDraft = inInter ? null : { priority: 0, rate: 0, legs: [] }
      else if (name === T.tLeg) legDraft = inInter ? null : { tier: 0, period: null, side: 'A', ratio: 1 }
      else if (name === T.pLeg) legDraft = inInter ? null : { tier: null, period: null, side: 'A', ratio: 1 }
    },
    close(name, text) {
      const p = parent()
      if (name === T.date && p === T.pointInTime) businessDate = period(text, 'pointInTime/date')
      else if (name === T.isSetl && p === T.pointInTime) settlement = text === '1' || text.toLowerCase() === 'true'
      else if (name === T.created) created = text || null
      else if (name === T.pfCode && (p === T.futPf || p === T.oopPf)) pf = text
      else if (name === T.cc && p === T.ccDef) cc = text
      else if (draft && (p === T.fut || p === T.opt)) {
        if (name === T.period) draft.period = period(text, `${pf} contract`)
        else if (name === T.price) draft.price = num(text, `${pf} price`)
        else if (name === T.optType) draft.optType = text === 'C' ? 'CE' : text === 'P' ? 'PE' : null
        else if (name === T.strike) draft.strike = num(text, `${pf} strike`)
        else if (name === T.delta) draft.delta = num(text, `${pf} delta`)
      } else if (draft && p === T.riskArray) {
        if (name === T.riskValue) draft.ra.push(num(text, `${pf} risk value`))
        else if (name === T.delta) draft.delta = num(text, `${pf} delta`)
      } else if (name === T.period && p === T.series) seriesPeriod = period(text, `${pf} series`)
      else if ((name === T.fut || name === T.opt) && draft) {
        const d: ContractDraft = draft
        draft = null
        const kind = name === T.fut ? 'future' : 'option'
        if (kind === 'option' && (d.optType === null || d.strike === null)) throw new SpanParseError(`${pf} option ${d.period}: missing strike or type`)
        const who = `${pf} ${kind} ${d.period}${d.strike === null ? '' : ' ' + d.strike}`
        if (d.ra.length !== 16) throw new SpanParseError(`${who}: risk array has ${d.ra.length} values, need 16`)
        if (d.price === null) throw new SpanParseError(`${who}: no price (<${T.price}>)`)
        if (d.delta === null) throw new SpanParseError(`${who}: no delta (<${T.delta}>)`)
        const b = builder(pf)
        if (b) {
          b.contracts.set(spanKey(kind, d.period, d.strike, d.optType), {
            kind, period: d.period, strike: d.strike, optType: d.optType, price: d.price, delta: d.delta, riskArray: d.ra,
          })
        }
      } else if (name === T.tierNo && tierDraft) tierDraft.tn = num(text, `${cc} tier number`)
      else if (name === T.tierStart && tierDraft) tierDraft.s = text
      else if (name === T.tierEnd && tierDraft) tierDraft.e = text
      else if (name === T.tier && tierDraft) {
        const t = tierDraft
        tierDraft = null
        // NSE's intraTiers opens with a tier 0 that has no months: it covers nothing
        if (!inSom && (p === T.intrTiers || p === T.intraTiers) && !(t.s === '' && t.e === '')) {
          builder(cc)?.tiers.push({ tier: t.tn, startMonth: month(t.s, `${cc} tier ${t.tn}`), endMonth: month(t.e, `${cc} tier ${t.tn}`) })
        }
      } else if (name === T.val && p === T.rate && (inSom || spreadDraft)) {
        const rate = num(text, `${cc} rate`)
        if (inSom) { const b = builder(cc); if (b) b.somRate = rate } else if (spreadDraft) spreadDraft.rate = rate
      } else if (name === T.spreadPriority && p === T.dSpread) { if (spreadDraft) spreadDraft.priority = num(text, `${cc} spread priority`) }
      else if (legDraft && (p === T.tLeg || p === T.pLeg)) {
        if (name === T.tierNo && p === T.tLeg) legDraft.tier = num(text, `${cc} spread leg tier`)
        else if (name === T.period && p === T.pLeg) legDraft.period = period(text, `${cc} spread leg period`)
        else if (name === T.legSide) legDraft.side = text === 'B' ? 'B' : 'A'
        else if (name === T.legRatio) legDraft.ratio = num(text, `${cc} spread leg ratio`)
      } else if ((name === T.tLeg || name === T.pLeg) && legDraft) {
        const l = legDraft
        legDraft = null
        if (l.period !== null) spreadDraft?.legs.push({ tier: null, period: l.period, side: l.side, ratio: l.ratio })
        else if (l.tier !== null && name === T.tLeg) spreadDraft?.legs.push({ tier: l.tier, period: null, side: l.side, ratio: l.ratio })
        else throw new SpanParseError(`${cc} spread leg: no ${name === T.pLeg ? 'period' : 'tier'}`)
      }
      else if (name === T.dSpread && spreadDraft) {
        builder(cc)?.spreads.push({ priority: spreadDraft.priority, rate: spreadDraft.rate, legs: spreadDraft.legs })
        spreadDraft = null
      } else if (name === T.somTiers) inSom = false
      else if (name === T.interSpreads) inInter = false
      stack.pop()
    },
  })

  if (businessDate === '') throw new SpanParseError(`no business date found (${T.pointInTime}/${T.date})`)
  const commodities = new Map<string, SpanCommodity>()
  for (const [symbol, b] of builders) {
    commodities.set(symbol, { symbol, contracts: b.contracts, tiers: b.tiers, spreads: b.spreads, somRate: b.somRate })
  }
  return { businessDate, settlement, created, commodities }
}
