/**
 * One book under stated shocks (spec 2026-10-24-traders-risk-design.md R1, R2): its matched legs fully repriced
 * through `packages/payoff` `scenario()` on the book's minute snapshot (`marketOf`, the market Analysis and Scenario
 * price on), each shock moving spot by a factor, adding vol points to every option's IV and valuing at an instant.
 *
 * Every figure is a CHANGE, never a P&L: pnl(shocked) − pnl(the snapshot's spot, vol unchanged, now), so a shock of
 * factor 1, 0 points, now is 0 and time decay to a later instant is part of the change. The portfolio stress, the
 * replay and the results-event outcomes (Lane B, analytics/event-risk.ts) all read it.
 *
 * The scenario is called once per vol shift: every spot and instant of that shift in one call (the replay's 250 days
 * are one call). Unmatched legs are left out, with the snapshot's own line for each; a leg the scenario cannot price
 * is named by its contract. Nothing NaN leaves: what cannot be valued is null.
 */

import { istDay, scenario, type PayoffLeg, type ValuationPoint } from '@algomaker/payoff'
import { contractText } from '../types.ts'
import { marketOf } from './analysis.ts'
import type { BookSnapshot } from './snapshot.ts'

export interface Shock { readonly spotFactor: number; readonly volPts: number; readonly at: ValuationPoint | null /* null = now */ }

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** The scenario's "leg <key>" read as the contract: a key is a client code and a contract, not something to show. */
function named(s: BookSnapshot, w: string): string {
  for (const l of s.legs) if (w.includes(`leg ${l.leg.key}:`)) return w.replace(`leg ${l.leg.key}:`, `${s.stock} ${contractText(l.leg)}:`)
  return w
}

/** The change of the book's matched legs under each shock, rupees, vs its value now; null entries = unpriced. */
export function shockBook(s: BookSnapshot, shocks: readonly Shock[]): { readonly changes: readonly (number | null)[]; readonly warnings: readonly string[] } {
  const none = (why: string): { changes: (number | null)[]; warnings: string[] } => ({ changes: shocks.map(() => null), warnings: [why, ...s.unmatched] })
  if (s.spot === null || !(s.spot > 0)) return none(`no spot price for ${s.stock} — not repriced`)
  if (s.legs.length === 0) return none(`${s.stock}: no leg matched in the instrument master — not repriced`)
  const spot = s.spot
  const legs: readonly PayoffLeg[] = s.legs.map((l) => l.payoff)
  const market = marketOf(s)
  const now: ValuationPoint = { date: istDay(s.asOf), ms: s.asOf }
  const warnings = new Set<string>()

  const base = scenario(legs, market, [spot], [now], {})
  const baseline = base.cells[0]?.[0]?.pnl
  for (const w of base.warnings) warnings.add(named(s, w))
  if (!num(baseline)) return none(`${s.stock}: the book cannot be valued now — ${base.warnings.join('; ') || 'no cells'}`)

  const changes: (number | null)[] = shocks.map(() => null)
  // one scenario call per vol shift, over that shift's distinct spots × instants
  const byVol = new Map<number, number[]>()
  shocks.forEach((k, i) => {
    if (!num(k.spotFactor) || k.spotFactor <= 0 || !num(k.volPts) || (k.at !== null && !num(k.at.ms))) return
    const g = byVol.get(k.volPts)
    if (g === undefined) byVol.set(k.volPts, [i])
    else g.push(i)
  })
  for (const [volPts, idx] of byVol) {
    const spots = [...new Set(idx.map((i) => spot * (shocks[i] as Shock).spotFactor))]
    const points = new Map<number, ValuationPoint>()
    for (const i of idx) {
      const at = (shocks[i] as Shock).at ?? now
      if (!points.has(at.ms)) points.set(at.ms, at)
    }
    const at = [...points.values()]
    const r = scenario(legs, market, spots, at, { volShift: volPts })
    for (const w of r.warnings) warnings.add(named(s, w))
    if (r.cells.length !== spots.length) continue
    const row = new Map(spots.map((x, k) => [x, k]))
    const col = new Map(at.map((p, k) => [p.ms, k]))
    for (const i of idx) {
      const k = shocks[i] as Shock
      const pnl = r.cells[row.get(spot * k.spotFactor) as number]?.[col.get((k.at ?? now).ms) as number]?.pnl
      changes[i] = num(pnl) ? pnl - baseline : null
    }
  }
  return { changes, warnings: [...warnings, ...s.unmatched] }
}
