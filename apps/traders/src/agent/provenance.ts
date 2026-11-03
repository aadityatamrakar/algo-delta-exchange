/**
 * The provenance check (spec R2): the engines decide the numbers, the model
 * only translates. After a turn, every number in the answer is looked for
 * among the numbers of this turn's tool results (and the conversation's
 * plans); one that matches none, within the rounding the text shows, is
 * returned as "unverified" for the page to badge, and logged.
 *
 * Matching is lenient on purpose — sign (a loss of ₹50,000 is −50000 in a
 * result), percent and decimal (24.5% is an IV of 0.245), lakh and crore, and
 * one unit of the last digit shown — so a badge means a number that really
 * came from nowhere. Counts (an integer up to 10), dates, times, plan ids and
 * leg aliases are not checked.
 */

export interface Provenance {
  readonly checked: number
  readonly unverified: readonly string[]
}

const MULT: Readonly<Record<string, number>> = { lakh: 1e5, lakhs: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3 }
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'

/** Dates, times, ids and month-day pairs are blanked before numbers are read. */
const SKIP: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}:\d{2}(:\d{2})?\b/g,
  /\b[PL]\d{1,4}\b/g,
  new RegExp(`\\b\\d{1,2}\\s?(${MONTHS})[a-z]*\\b`, 'gi'),
  // "Oct 27", "Oct 2026" — never "OCT 3600", a strike
  new RegExp(`\\b(${MONTHS})[a-z]*\\s?(\\d{1,2}|20\\d\\d)\\b`, 'gi'),
]

const NUMBER = /([-−]?)\s?(₹|Rs\.?\s?)?(\d{1,3}(?:,\d{2,3})+|\d+)(\.\d+)?\s?(%|lakhs?|crores?|cr\b|L\b|k\b)?/gi

interface Found { readonly text: string; readonly value: number; readonly unit: number; readonly percent: boolean }

export function numbersIn(text: string): Found[] {
  let t = text
  for (const re of SKIP) t = t.replace(re, (m) => ' '.repeat(m.length))
  const out: Found[] = []
  for (const m of t.matchAll(NUMBER)) {
    const [whole, sign, , int, frac, suffix] = m
    const digits = (int ?? '').replace(/,/g, '')
    if (digits === '') continue
    const decimals = frac === undefined ? 0 : frac.length - 1
    const mult = suffix === undefined || suffix === '%' ? 1 : MULT[suffix.toLowerCase()] ?? 1
    const raw = Number(`${digits}${frac ?? ''}`)
    if (!Number.isFinite(raw)) continue
    const value = (sign === '' ? 1 : -1) * raw * mult
    out.push({ text: whole.trim(), value, unit: 10 ** -decimals * mult, percent: suffix === '%' })
  }
  return out
}

/** Every number in a value: JSON numbers, and the numbers inside its strings (a plan's "Sell 1 lot … at 42.50"). */
export function numbersOf(values: readonly unknown[]): number[] {
  const out: number[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'number') { if (Number.isFinite(v)) out.push(v); return }
    if (typeof v === 'string') { for (const f of numbersIn(v)) out.push(f.value); return }
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x)
  }
  for (const v of values) walk(v)
  return out
}

function matches(f: Found, known: readonly number[]): boolean {
  const target = Math.abs(f.value)
  const tol = (t: number): number => Math.max(f.unit, Math.abs(t) * 0.001) + 1e-9
  for (const k of known) {
    const a = Math.abs(k)
    if (Math.abs(target - a) <= tol(a)) return true
    // 24.5% shown for a decimal 0.245; 0.25 shown for a 25 that is a percent elsewhere
    if (f.percent && Math.abs(target - a * 100) <= tol(a * 100)) return true
  }
  return false
}

export function provenanceOf(text: string, sources: readonly unknown[]): Provenance {
  const known = numbersOf(sources)
  const found = numbersIn(text).filter((f) => !(Number.isInteger(f.value) && Math.abs(f.value) <= 10 && !f.percent))
  const unverified: string[] = []
  for (const f of found) {
    if (!matches(f, known) && !unverified.includes(f.text)) unverified.push(f.text)
  }
  return { checked: found.length, unverified: unverified.slice(0, 20) }
}
