import { findContract, spanKey } from './spn.ts'
import type { SpanCommodity, SpanContract, SpanFile, SpanSpreadLeg } from './spn.ts'

/**
 * NSE SPAN margin for a book against one parsed SPAN file. A best reading of the
 * method, not a copy of NSE's engine; four assumptions carry it and the golden
 * suite (Task 8, real files against known margins) is the proof of each:
 *  - V-SP2  within a commodity the loss of scenario s is Σ qty × riskArray[s]; the
 *           commodity's scanning risk is its worst scenario, floored at 0. Scanning risk
 *           is the SUM over commodities of each one's max (no cross-commodity offset,
 *           conservative); worstScenario (1-based) labels the largest commodity's.
 *  - V-SP3  the inter-month spread charge walks the spreads in ascending priority,
 *           matching opposite net deltas of an A-leg tier and a B-leg tier.
 *  - V-SP4  net option value (long − short, at file prices) is REPORTED and never
 *           netted against the margin.
 *  - V-SP6  the short-option minimum is Σ |qty| × somRate over short options, and
 *           initial = max(scanning risk + spread charge, short-option minimum);
 *           exposure on opposite futures in different months is 1/3 on the far leg.
 * Pure: no clock, no IO.
 */
export interface SpanPosition {
  readonly symbol: string
  readonly kind: 'future' | 'option'
  /** YYYY-MM-DD */
  readonly expiry: string
  readonly strike: number | null
  readonly optType: 'CE' | 'PE' | null
  /** signed units */
  readonly qty: number
}
export interface SpanResult {
  readonly scanningRisk: number
  /** 1-16; 0 when nothing is priced */
  readonly worstScenario: number
  readonly interMonthSpread: number
  readonly shortOptionMinimum: number
  /** long option value − short option value, at file prices; reported, not netted (V-SP4) */
  readonly netOptionValue: number
  /** max(scanningRisk + interMonthSpread, shortOptionMinimum) */
  readonly initial: number
  readonly exposure: number
  /** initial + exposure */
  readonly total: number
  /** spanKey(...) of positions not found in the file; 'exposure base for …' / 'exposure rate for <SYM>' for exposure gaps */
  readonly missing: readonly string[]
}

interface Placed { readonly pos: SpanPosition; readonly contract: SpanContract; qty: number }

const month = (period: string): string => period.slice(0, 7)

function scan(placed: readonly Placed[]): { risk: number; worst: number } {
  const loss = new Array<number>(16).fill(0)
  for (const { contract, qty } of placed) contract.riskArray.forEach((v, s) => { loss[s] = (loss[s] ?? 0) + qty * v })
  let worst = 0
  loss.forEach((l, s) => { if (l > (loss[worst] ?? 0)) worst = s })
  return { risk: Math.max(0, loss[worst] ?? 0), worst: placed.length > 0 ? worst + 1 : 0 }
}

/** A tier leg's delta is its months' (`t:`); a period leg's is that one expiry date's (`p:`), as NSE's files spread them. */
const legKey = (l: SpanSpreadLeg): string => (l.period !== null ? `p:${l.period}` : `t:${l.tier}`)

function spreadCharge(c: SpanCommodity, placed: readonly Placed[]): number {
  const delta = new Map<string, number>()
  for (const t of c.tiers) {
    let d = 0
    for (const p of placed) {
      const m = month(p.contract.period)
      if (m >= t.startMonth && m <= t.endMonth) d += p.qty * p.contract.delta
    }
    delta.set(`t:${t.tier}`, d)
  }
  for (const sp of c.spreads) {
    for (const l of sp.legs) {
      if (l.period === null || delta.has(legKey(l))) continue
      let d = 0
      for (const p of placed) if (p.contract.period === l.period) d += p.qty * p.contract.delta
      delta.set(legKey(l), d)
    }
  }
  let charge = 0
  for (const sp of [...c.spreads].sort((a, b) => a.priority - b.priority)) {
    const a = sp.legs.find((l) => l.side === 'A')
    const b = sp.legs.find((l) => l.side === 'B')
    if (!a || !b || a.ratio <= 0 || b.ratio <= 0) continue
    const da = delta.get(legKey(a)) ?? 0
    const db = delta.get(legKey(b)) ?? 0
    if (da === 0 || db === 0 || Math.sign(da) === Math.sign(db)) continue
    const n = Math.min(Math.abs(da) / a.ratio, Math.abs(db) / b.ratio)
    charge += n * sp.rate
    delta.set(legKey(a), da - Math.sign(da) * n * a.ratio)
    delta.set(legKey(b), db - Math.sign(db) * n * b.ratio)
  }
  return charge
}

/** Futures exposure: opposite-sign lots in different months pair off, far leg at 1/3, near leg at 0. */
function futuresExposure(futs: readonly Placed[], elm: number): number {
  const byMonth = [...futs].sort((a, b) => a.contract.period.localeCompare(b.contract.period))
  const longs = byMonth.filter((f) => f.qty > 0).map((f) => ({ f, left: f.qty }))
  const shorts = byMonth.filter((f) => f.qty < 0).map((f) => ({ f, left: -f.qty }))
  let sum = 0
  for (const l of longs) {
    for (const s of shorts) {
      if (l.left <= 0) break
      const m = Math.min(l.left, s.left)
      if (m <= 0 || month(l.f.contract.period) === month(s.f.contract.period)) continue
      const far = l.f.contract.period > s.f.contract.period ? l.f : s.f
      sum += m * far.contract.price * elm / 3
      l.left -= m
      s.left -= m
    }
  }
  for (const x of [...longs, ...shorts]) sum += x.left * x.f.contract.price * elm
  return sum
}

export function spanMargin(positions: readonly SpanPosition[], file: SpanFile, elm: ReadonlyMap<string, number>): SpanResult {
  const missing: string[] = []
  const name = (k: string): void => { if (!missing.includes(k)) missing.push(k) }

  // net duplicate lines of one contract, then place each against the file
  const lines = new Map<string, SpanPosition>()
  for (const p of positions) {
    if (!Number.isFinite(p.qty)) { name(`bad quantity: ${spanKey(p.kind, p.expiry, p.strike, p.optType)}`); continue }
    if (p.qty === 0) continue
    const k = `${p.symbol}|${spanKey(p.kind, p.expiry, p.strike, p.optType)}`
    const prev = lines.get(k)
    lines.set(k, prev ? { ...prev, qty: prev.qty + p.qty } : p)
  }
  const bySymbol = new Map<string, Placed[]>()
  for (const p of lines.values()) {
    if (p.qty === 0) continue
    const c = file.commodities.get(p.symbol)
    const contract = c ? findContract(c, p.kind, p.expiry, p.strike, p.optType) : null
    if (!contract) { name(spanKey(p.kind, p.expiry, p.strike, p.optType)); continue }
    const list = bySymbol.get(p.symbol) ?? []
    list.push({ pos: p, contract, qty: p.qty })
    bySymbol.set(p.symbol, list)
  }

  let scanningRisk = 0
  let worstScenario = 0
  let worstRisk = 0
  let interMonthSpread = 0
  let shortOptionMinimum = 0
  let netOptionValue = 0
  let exposure = 0
  for (const [symbol, placed] of bySymbol) {
    const c = file.commodities.get(symbol)!
    const s = scan(placed)
    // commodities are summed; the reported scenario is the one of the commodity with the largest risk
    if (worstScenario === 0 || s.risk > worstRisk) { worstScenario = s.worst; worstRisk = s.risk }
    scanningRisk += s.risk
    interMonthSpread += spreadCharge(c, placed)

    const given = elm.get(symbol)
    const rate = given !== undefined && Number.isFinite(given) && given >= 0 ? given : undefined
    let rateNeeded = false
    const futs: Placed[] = []
    let optionExposure = 0
    for (const p of placed) {
      const { kind } = p.pos
      if (kind === 'option') {
        netOptionValue += p.qty * p.contract.price
        if (p.qty < 0) {
          shortOptionMinimum += -p.qty * c.somRate
          rateNeeded = true
          const base = findContract(c, 'future', p.pos.expiry, null, null)
          if (base) optionExposure += -p.qty * base.price * (rate ?? 0)
          else name(`exposure base for ${spanKey(kind, p.pos.expiry, p.pos.strike, p.pos.optType)}`)
        }
      } else { futs.push(p); rateNeeded = true }
    }
    if (rateNeeded && rate === undefined) name(`exposure rate for ${symbol}`)
    exposure += optionExposure + futuresExposure(futs, rate ?? 0)
  }
  const initial = Math.max(scanningRisk + interMonthSpread, shortOptionMinimum)
  return {
    scanningRisk, worstScenario, interMonthSpread, shortOptionMinimum, netOptionValue,
    initial, exposure, total: initial + exposure, missing,
  }
}
