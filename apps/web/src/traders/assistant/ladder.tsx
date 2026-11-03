/**
 * The levels around the reference price as a small ladder: resistance above (red), support below (green), the
 * reference marked between, one rung a level, nearest first either side. The reference is the spot, or the near
 * future where the context says its figures are of the future (an index: NSE gives no cash OHLC) — that rung then
 * reads "Fut", and it carries the day's change. A rung's tick is longer the stronger the level (1–3); the nearest
 * support and resistance read in bold. Rungs are evenly spaced — the distance in % is printed on each, so the
 * ladder stays legible when two levels sit close together.
 *
 * Inline SVG in theme tokens (assistant.css), sized in em so it follows the page's text size.
 */

import type { ReactElement } from 'react'
import type { Level, LevelKind, MarketContext } from '../../../../traders/src/analytics/context-wire.ts'
import { inr } from '../../format.ts'
import { arr, numOr, str } from './safe.tsx'

export const LEVEL_TEXT: Readonly<Record<LevelKind, string>> = {
  'prev-high': 'Prev high', 'prev-low': 'Prev low', 'prev-close': 'Prev close', pivot: 'Pivot',
  r1: 'R1', r2: 'R2', r3: 'R3', s1: 'S1', s2: 'S2', s3: 'S3',
  'swing-high': 'Swing high', 'swing-low': 'Swing low', '52w-high': '52w high', '52w-low': '52w low',
  sma20: 'SMA20', sma50: 'SMA50', sma200: 'SMA200', round: 'Round',
  'oi-call-wall': 'Call wall (OI)', 'oi-put-wall': 'Put wall (OI)', 'max-pain': 'Max pain',
  'day-high': 'Day high', 'day-low': 'Day low', vwap: 'VWAP', 'or-high': 'OR high', 'or-low': 'OR low',
}

/** Rungs either side of the reference. */
export const LADDER_EACH_SIDE = 6
const ROW_EM = 1.45

/** The price the context's levels are measured from, and whether it is the future (`MarketContext.reference`). */
export function referenceOf(x: Pick<MarketContext, 'spot' | 'future'> & { readonly reference?: 'spot' | 'future' | undefined }): { readonly price: number | null; readonly future: boolean } {
  const spot = numOr(x.spot), fut = numOr(x.future)
  if (x.reference === 'future') return { price: fut, future: true }
  return spot !== null ? { price: spot, future: false } : { price: fut, future: fut !== null }
}

export interface Rung {
  readonly kind: 'res' | 'sup' | 'ref'
  readonly price: number
  readonly label: string
  readonly strength: number
  /** Distance from the reference for a level; the day's change for the reference itself. */
  readonly pct: number | null
  readonly nearest: boolean
  readonly basis: string
}

const kindText = (k: unknown): string => (typeof k === 'string' ? LEVEL_TEXT[k as LevelKind] ?? k : '?')

/**
 * The ladder's rungs, highest first: the nearest `each` levels above the reference, the reference, the nearest
 * below. A level that is not a priced object is skipped.
 */
export function rungsOf(
  levels: readonly Level[] | null | undefined, ref: { readonly price: number | null; readonly future: boolean; readonly changePct?: number | null },
  nearest: readonly (Level | null | undefined)[], each = LADDER_EACH_SIDE,
): Rung[] {
  const isNearest = (l: Level): boolean => nearest.some((n) => n !== null && n !== undefined && n.price === l.price && n.kind === l.kind)
  const rung = (l: Level, kind: 'res' | 'sup'): Rung => ({
    kind, price: l.price, label: kindText(l.kind), strength: numOr(l.strength) ?? 1, pct: numOr(l.distancePct), nearest: isNearest(l), basis: str(l.basis),
  })
  const sorted = arr(levels).filter((l) => typeof l === 'object' && l !== null && numOr(l.price) !== null).sort((a, b) => b.price - a.price)
  const at = ref.price
  if (at === null) return sorted.slice(0, each * 2).map((l) => rung(l, (numOr(l.distancePct) ?? 0) >= 0 ? 'res' : 'sup'))
  const above = sorted.filter((l) => l.price > at).slice(-each).map((l) => rung(l, 'res'))
  const below = sorted.filter((l) => l.price <= at).slice(0, each).map((l) => rung(l, 'sup'))
  const self: Rung = { kind: 'ref', price: at, label: ref.future ? 'Fut' : 'Spot', strength: 0, pct: numOr(ref.changePct), nearest: false, basis: '' }
  return [...above, self, ...below]
}

const signedPct = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)} %`

export function LevelLadder(props: { readonly context: MarketContext }): ReactElement {
  const x = props.context
  const ref = referenceOf(x)
  const levels = arr(x.levels)
  if (levels.length === 0) return <div className="traders-ai-muted">No levels — no price history on the server yet</div>
  const rungs = rungsOf(levels, { ...ref, changePct: x.changePct }, [x.nearestSupport, x.nearestResistance])
  const res = rungs.filter((r) => r.kind === 'res').length
  const sup = rungs.filter((r) => r.kind === 'sup').length
  const label = `Levels around ${ref.price === null ? 'the price' : `${ref.future ? 'the future ' : ''}${inr(ref.price, 2)}`}: ${res} above, ${sup} below`
  return (
    <svg className="traders-ai-ladder" role="img" aria-label={label} width="100%" height={`${rungs.length * ROW_EM + 0.4}em`}>
      <title>{label}</title>
      <line className="traders-ai-ladder-axis" x1="24%" x2="24%" y1="0.2em" y2={`${rungs.length * ROW_EM + 0.2}em`} />
      {rungs.map((r, i) => {
        const mid = `${i * ROW_EM + 0.95}em`
        const base = `${i * ROW_EM + 1.25}em`
        const tick = r.kind === 'ref' ? 20 : 4 + r.strength * 5
        return (
          <g key={`${r.kind}${r.price}${r.label}`} className={`traders-ai-rung traders-ai-rung-${r.kind}`} data-nearest={r.nearest ? 'true' : undefined}>
            {r.basis === '' ? null : <title>{`${r.label} ${inr(r.price, 2)} — ${r.basis}`}</title>}
            <text x="21%" y={base} textAnchor="end">{inr(r.price, 2)}</text>
            <line x1="24%" x2={`${24 + tick}%`} y1={mid} y2={mid} strokeWidth={r.kind === 'ref' ? 2 : 1 + r.strength * 0.6}
              {...(r.kind === 'ref' ? { strokeDasharray: '3 2' } : {})} />
            <text x="46%" y={base} fontWeight={r.nearest || r.kind === 'ref' ? 700 : 400}>{r.label}</text>
            {r.pct === null ? null : (
              <text x="100%" y={base} textAnchor="end">{r.kind === 'ref' ? `${signedPct(r.pct)} today` : signedPct(r.pct)}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
