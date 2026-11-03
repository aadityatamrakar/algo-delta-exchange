/**
 * A card's figures: which rows a plan table shows, how each prints, and which way is BETTER for each — the colour
 * of a change is green when it is better for that metric, red when worse, whatever its sign. Pure, no DOM.
 *
 * Better means safer or cheaper for a staff trader running delta-hedged short premium: less margin, a higher POP and
 * EV, a shallower max loss and shock (both negative numbers: closer to zero is better), a smaller |Δ|, a Δ0 nearer
 * the future, less |Γ| and |vega| (exposure), more θ, more credit, fewer charges.
 */

import type { CardMetrics } from '../../../../traders/src/agent/wire.ts'
import { inr } from '../../format.ts'

/** The figures a table row can show: CardMetrics' numbers, not its margin provenance flags. */
export type MetricKey = Exclude<keyof CardMetrics, 'marginSource' | 'marginPartial'>
/** higher / lower: the value itself; lowerAbs: its size, whatever the sign. */
export type Better = 'higher' | 'lower' | 'lowerAbs'
export type Tone = 'better' | 'worse' | null

export interface MetricSpec {
  readonly key: MetricKey
  readonly label: string
  readonly about: string
  readonly better: Better
  readonly value: (n: number) => string
  readonly change: (n: number) => string
}

const MINUS = '−'

/** Rupees in short form: 950, 62.7 k, 2.18 L, 1.25 Cr; a true minus, no plus. */
export function rupees(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const s = a >= 1e7 ? `${(a / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(2)} L` : a >= 1e3 ? `${(a / 1e3).toFixed(1)} k` : String(Math.round(a))
  return n < 0 && s !== '0' ? `${MINUS}${s}` : s
}

/** A change: signed (+ or −), and bare when it prints as zero. */
function signedWith(fmt: (a: number) => string): (n: number) => string {
  return (n) => {
    if (!Number.isFinite(n)) return '—'
    const s = fmt(Math.abs(n))
    return /[1-9]/.test(s) ? `${n < 0 ? MINUS : '+'}${s}` : s
  }
}

const plain = (digits: number) => (n: number): string => {
  if (!Number.isFinite(n)) return '—'
  const s = inr(Math.abs(n), digits)
  return n < 0 && /[1-9]/.test(s) ? `${MINUS}${s}` : s
}

/** Γ spans orders of magnitude across books: digits by size. */
function gammaText(n: number): string {
  const a = Math.abs(n)
  return plain(a >= 100 ? 0 : a >= 1 ? 2 : 4)(n)
}

export const METRICS: readonly MetricSpec[] = [
  { key: 'margin', label: 'Margin', about: 'NSE SPAN + exposure after the plan, ₹ — less is better', better: 'lower', value: rupees, change: signedWith(rupees) },
  { key: 'pop', label: 'POP', about: 'Probability the open legs finish green, % — more is better', better: 'higher', value: (n) => `${n.toFixed(1)} %`, change: (n) => `${signedWith((a) => a.toFixed(1))(n)} pts` },
  { key: 'ev', label: 'EV', about: 'Expected P&L at the horizon under the stated view, ₹ — more is better', better: 'higher', value: rupees, change: signedWith(rupees) },
  { key: 'maxLoss', label: 'Max loss', about: 'Worst P&L on the ±10% expiry scan, realised included, ₹ — closer to zero is better', better: 'higher', value: rupees, change: signedWith(rupees) },
  { key: 'worstShock', label: 'Worst shock', about: 'Worst P&L today at ±5% / ±10%, ₹ — closer to zero is better', better: 'higher', value: rupees, change: signedWith(rupees) },
  { key: 'deltaShares', label: 'Δ shares', about: 'Net delta in shares — nearer zero is better', better: 'lowerAbs', value: plain(0), change: signedWith((a) => inr(a, 0)) },
  { key: 'deltaLots', label: 'Δ lots', about: 'Net delta in lots of the future — nearer zero is better', better: 'lowerAbs', value: plain(2), change: signedWith((a) => inr(a, 2)) },
  { key: 'delta0Gap', label: 'Δ0 gap', about: 'How far the zero-delta price sits from the future, ₹ — less is better', better: 'lower', value: plain(1), change: signedWith((a) => inr(a, 1)) },
  { key: 'gamma', label: 'Γ', about: 'Gamma, shares per ₹ — less exposure (nearer zero) is better', better: 'lowerAbs', value: gammaText, change: signedWith((a) => gammaText(a)) },
  { key: 'vega', label: 'Vega', about: 'Vega, ₹ per vol point — less exposure (nearer zero) is better', better: 'lowerAbs', value: plain(0), change: signedWith((a) => inr(a, 0)) },
  { key: 'theta', label: 'θ', about: 'Theta, ₹ per day — more is better', better: 'higher', value: plain(0), change: signedWith((a) => inr(a, 0)) },
  { key: 'credit', label: 'Credit', about: 'Cash the plan moves: premium in less premium out, ₹ — more is better', better: 'higher', value: rupees, change: signedWith(rupees) },
  { key: 'charges', label: 'Charges', about: 'Brokerage, STT and fees of acting, ₹ — less is better', better: 'lower', value: rupees, change: signedWith(rupees) },
]

const EPS = 1e-9

/**
 * Better or worse for this metric, from the plan's value against now (the change when only it is known). Null when
 * nothing moved or the figures are unknown.
 */
export function changeTone(better: Better, before: number | null | undefined, after: number | null | undefined, change?: number | null): Tone {
  const has = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)
  if (better === 'lowerAbs') {
    if (!has(before) || !has(after)) return null
    const d = Math.abs(after) - Math.abs(before)
    return Math.abs(d) < EPS ? null : d < 0 ? 'better' : 'worse'
  }
  const d = has(change) ? change : has(before) && has(after) ? after - before : null
  if (d === null || Math.abs(d) < EPS) return null
  return (better === 'higher') === d > 0 ? 'better' : 'worse'
}

export interface MetricLine {
  readonly key: MetricKey
  readonly label: string
  readonly about: string
  readonly now: string
  readonly plan: string
  readonly change: string
  readonly tone: Tone
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

type Figures = Partial<CardMetrics> | null | undefined

/**
 * Where a card's margin comes from (the server's `marginSource` / `marginPartial`): "NSE SPAN + exposure" only for
 * the exchange's whole figure; the SPAN-lite estimate, or a partial SPAN the search fell back from, says so. A card
 * from before the server sent these reads as an estimate: never claim the exchange's figure without it.
 */
export function marginRow(f: Figures): { readonly label: string; readonly about: string } {
  if (f?.marginPartial === true) {
    return { label: 'Margin (partial)', about: 'Partial: NSE SPAN could not price every contract, so this is the SPAN-lite estimate, ₹ — less is better' }
  }
  if (f?.marginSource === 'span') return { label: 'Margin', about: 'NSE SPAN + exposure after the plan, ₹ — less is better' }
  return { label: 'Margin (estimate)', about: 'Estimate (SPAN-lite): no NSE SPAN figure for this book, ₹ — less is better' }
}

/**
 * The table's rows, now → plan → change, leaving out a metric unknown on both sides (EV without a view). Tolerant:
 * a side missing, or a figure that is not a number, is unknown — never a throw.
 */
export function metricLines(now: Figures, after: Figures, change: Figures): MetricLine[] {
  const out: MetricLine[] = []
  for (const m of METRICS) {
    const b = num(now?.[m.key]), a = num(after?.[m.key])
    if (b === null && a === null) continue
    const given = num(change?.[m.key])
    const d = given ?? (a !== null && b !== null ? a - b : null)
    const names = m.key === 'margin' ? marginRow(after ?? now) : m
    out.push({
      key: m.key, label: names.label, about: names.about,
      now: b === null ? '—' : m.value(b),
      plan: a === null ? '—' : m.value(a),
      change: d === null ? '—' : m.change(d),
      tone: changeTone(m.better, b, a, d),
    })
  }
  return out
}
