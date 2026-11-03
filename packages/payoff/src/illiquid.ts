/**
 * The vol an illiquid option leg is priced with.
 *
 * A leg is illiquid when the viewer ticks it, or when its own (strike, type)
 * row has no measured vol — missing, stale or unsolved. It then borrows: first
 * the other side at the same strike (a CE and PE at one strike share a vol by
 * put-call parity), else the nearest measured row by distance in strike.
 *
 * Only `source: 'quote'` rows count as measured. An `interp` row is already
 * somebody's estimate and borrowing from it would stack guesses.
 *
 * Never interpolates — that stays `ivFor`'s, for the desk. Pure, no throw.
 */
import type { OptionType } from '@algomaker/greeks'
import type { SolvedIv } from './ivs.ts'

export type LiquidIvSource = 'quote' | 'other-side' | 'nearest' | 'none'

export interface LiquidIv {
  readonly iv: number | null
  readonly source: LiquidIvSource
  /** The row the vol came from; null when it is the leg's own or there is none. */
  readonly from: { readonly strike: number; readonly type: OptionType } | null
}

interface Measured {
  readonly strike: number
  readonly type: OptionType
  readonly iv: number
}

function measured(r: SolvedIv): r is SolvedIv & { iv: number } {
  return r.source === 'quote' && typeof r.iv === 'number' && Number.isFinite(r.iv) && r.iv > 0
}

export function liquidIv(
  solved: readonly SolvedIv[],
  strike: number,
  type: OptionType,
  illiquid: boolean,
): LiquidIv {
  const rows: Measured[] = []
  for (const r of solved) if (measured(r)) rows.push({ strike: r.strike, type: r.type, iv: r.iv })

  const own = rows.find((r) => r.strike === strike && r.type === type)
  if (!illiquid && own) return { iv: own.iv, source: 'quote', from: null }

  const other = rows.find((r) => r.strike === strike && r.type !== type)
  if (other) {
    return { iv: other.iv, source: 'other-side', from: { strike: other.strike, type: other.type } }
  }

  let best: Measured | null = null
  for (const r of rows) {
    if (r.strike === strike && r.type === type) continue
    if (best === null) { best = r; continue }
    const dr = Math.abs(r.strike - strike)
    const db = Math.abs(best.strike - strike)
    if (
      dr < db ||
      (dr === db &&
        ((r.type === type && best.type !== type) ||
          ((r.type === type) === (best.type === type) && r.strike < best.strike)))
    ) best = r
  }
  if (best) return { iv: best.iv, source: 'nearest', from: { strike: best.strike, type: best.type } }
  return { iv: null, source: 'none', from: null }
}
