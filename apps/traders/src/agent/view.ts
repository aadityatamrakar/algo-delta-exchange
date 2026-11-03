/**
 * The trader's market view (spec §6.4 `ViewChoice`) into the search's
 * `MarketView`, and the words a card says it in. Shared by the chat body, the
 * tools and the plan-search route, so one view reads the same everywhere.
 *
 * `annual` is a decimal (0.22 = 22%); `shiftPts` is in vol points on every
 * leg's own IV; 'hv20' is resolved here from the market context's HV20 into a
 * flat vol, and the card says so. Drift arrives in percent a year.
 */

import { z } from 'zod'
import type { MarketView } from '@algomaker/payoff'
import { isIsoDate } from '../routes/kit.ts'
import type { AgentDeps } from './tools/ctx.ts'
import type { ViewChoice } from './wire.ts'

export const viewChoiceSchema = z.object({
  vol: z.union([
    z.literal('implied'), z.literal('hv20'),
    z.object({ shiftPts: z.number().min(-50).max(50) }).strict(),
    z.object({ annual: z.number().gt(0).max(3).describe('decimal, 0.22 = 22%') }).strict(),
  ]),
  driftPct: z.number().min(-100).max(100).optional().describe('percent a year'),
  horizon: z.string().refine(isIsoDate, 'a date, YYYY-MM-DD').optional(),
}).strict()

/** The parsed schema as the wire type (optional fields left out, not undefined). */
export function viewChoiceOf(v: z.infer<typeof viewChoiceSchema> | undefined): ViewChoice | null {
  if (v === undefined) return null
  return { vol: v.vol, ...(v.driftPct === undefined ? {} : { driftPct: v.driftPct }), ...(v.horizon === undefined ? {} : { horizon: v.horizon }) }
}

const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`

export type ResolvedView = { readonly view: MarketView | null; readonly label: string | null } | { readonly error: string }

export async function resolveView(d: Pick<AgentDeps, 'marketContext'>, stock: string, v: ViewChoice | null, nowMs: number): Promise<ResolvedView> {
  if (v === null) return { view: null, label: null }
  let vol: MarketView['vol']
  let label: string
  if (v.vol === 'implied') { vol = { kind: 'implied' }; label = 'implied vol (each leg at its own IV)' }
  else if (v.vol === 'hv20') {
    const c = await d.marketContext(stock, nowMs)
    const hv = c?.vol.hv20 ?? null
    if (hv === null || !(hv > 0)) return { error: `no HV20 for ${stock}: the daily history is too short or missing` }
    vol = { kind: 'flat', annual: hv }
    label = `realised vol HV20 ${pct(hv)} (from the market context)`
  } else if ('shiftPts' in v.vol) {
    vol = { kind: 'shift', points: v.vol.shiftPts }
    label = `implied vol ${v.vol.shiftPts >= 0 ? '+' : ''}${v.vol.shiftPts} pts`
  } else {
    vol = { kind: 'flat', annual: v.vol.annual }
    label = `${pct(v.vol.annual)} annual vol`
  }
  const view: MarketView = {
    vol,
    ...(v.driftPct === undefined ? {} : { driftAnnual: v.driftPct / 100 }),
    ...(v.horizon === undefined ? {} : { horizon: v.horizon }),
  }
  const extra = [v.driftPct === undefined ? null : `drift ${v.driftPct}%/yr`, v.horizon === undefined ? null : `horizon ${v.horizon}`].filter((x) => x !== null)
  return { view, label: extra.length === 0 ? label : `${label}, ${extra.join(', ')}` }
}
