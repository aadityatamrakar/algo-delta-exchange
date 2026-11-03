/** Number and direction formatting, moved out of api.ts unchanged so a page that talks to another API can share it. api.ts re-exports all of it. */

/** Indian digit grouping, which is what every number on this desk is read in. */
export function inr(n: number, digits = 0): string {
  /**
   * A VALUE THAT IS NOT A NUMBER RENDERS AS "—", IT DOES NOT THROW.
   *
   * This is a monitoring surface for a live trading system, and the worst thing
   * it can do during an incident is show nothing at all. `undefined.toLocaleString`
   * throws, React unmounts the tree, and the operator gets a blank page —
   * which is exactly what happened when the API was still serving an older
   * response shape and a field the page expected was simply absent.
   *
   * The types say these are numbers. The types describe the CURRENT API; a
   * running process can be a deploy behind, and a dashboard that white-screens
   * on a rolling restart is worse than one that shows a dash next to nine
   * correct figures.
   */
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

/** Signed, so a delta's direction reads without hunting for the minus sign. */
export function signed(n: number, digits = 0): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const s = inr(Math.abs(n), digits)
  return n < 0 ? `-${s}` : n > 0 ? `+${s}` : s
}

/**
 * Lakhs and crores, the units this desk actually thinks in: `9.6L`, `1.2Cr`.
 *
 * For figures a tile shows as a HEADLINE — a margin in rupees is seven digits
 * of Indian grouping (`9,60,672`) that reads as noise at 2xl, while "9.6L" is
 * the number the operator would say out loud. Below a lakh the plain grouping
 * returns, where it is short enough to read.
 */
export function inrCompact(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e7) return `${inr(n / 1e7, n % 1e7 === 0 ? 0 : 2)}Cr`
  if (a >= 1e5) return `${inr(n / 1e5, n % 1e5 === 0 ? 0 : 1)}L`
  return inr(n)
}

/**
 * Direction as colour. These live here rather than in a page module so every
 * surface tints a number the same way and nothing has to import a page to
 * format one.
 */
export const RED = { color: 'var(--color-text-red)' }
export const GREEN = { color: 'var(--color-text-green)' }

/** Undefined at zero: a flat number has no direction to colour. */
export function sign(n: number): Record<string, string> | undefined {
  return n < 0 ? RED : n > 0 ? GREEN : undefined
}

/**
 * The one place a nullable money figure becomes text.
 *
 * It returns an em dash for null and there is no `?? 0` anywhere near it. A P&L
 * of ₹0 and a P&L of "three legs could not be marked" must never render
 * identically — that is the entire reason these fields are nullable.
 */
export function money(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined ? '—' : signed(n, digits)
}
