/**
 * A trader's own arrangement of a page's blocks: a 12-column grid with row units, each block a slot (x, y, w, h in
 * grid units) that can be moved, resized, hidden and reset. Pure: the layout arithmetic and its storage, no React.
 *
 * Placement follows the usual dashboard rule: blocks fall upward into free space and never overlap; a block put
 * somewhere takes that place and the others make room below it.
 *
 * Stored per signed-in user in this browser (versioned key). It does not follow the trader to another PC — a
 * layout kept on the server can come later. A stored layout is merged with the page's default, so a block added
 * in a later release appears and an unknown or broken entry is ignored: a bad layout never stops the page.
 */

export const COLS = 12

export interface Slot {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly hidden: boolean
  /** The height follows the content (`fitH`) until the trader resizes the block. */
  readonly fit?: boolean
}

export interface BlockSpec {
  readonly id: string
  readonly title: string
  readonly minW: number
  readonly minH: number
}

const int = (n: unknown): number | null => (typeof n === 'number' && Number.isInteger(n) ? n : null)
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** A slot kept inside the grid and no smaller than its block allows. */
export function bounded(s: Slot, spec: BlockSpec | undefined): Slot {
  const minW = Math.min(COLS, spec?.minW ?? 1), minH = spec?.minH ?? 1
  const w = clamp(s.w, minW, COLS)
  return { ...s, w, h: Math.max(minH, s.h), x: clamp(s.x, 0, COLS - w), y: Math.max(0, s.y) }
}

/** The slot with a fitting block's height worked out from its content. */
export function resolved(s: Slot, fitH: Readonly<Record<string, number>>): Slot {
  const h = s.fit === true ? fitH[s.id] : undefined
  return h === undefined ? s : { ...s, h }
}

function overlaps(a: Slot, b: Slot): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Every shown block as high as it can go without overlapping, in reading order; `first` (the block being moved or
 * resized) keeps the place it was given and the rest flow around it. Hidden blocks keep their slot untouched.
 */
export function compact(slots: readonly Slot[], fitH: Readonly<Record<string, number>> = {}, first?: string): Slot[] {
  const shown = slots.filter((s) => !s.hidden)
  const order = [...shown].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : a.y - b.y || a.x - b.x))
  const placed: Slot[] = []
  const out = new Map<string, Slot>()
  for (const s of order) {
    let at = resolved(s, fitH)
    if (s.id !== first) {
      while (at.y > 0 && !placed.some((p) => overlaps({ ...at, y: at.y - 1 }, p))) at = { ...at, y: at.y - 1 }
    }
    while (placed.some((p) => overlaps(at, p))) at = { ...at, y: at.y + 1 }
    placed.push(at)
    // the fitted height too: placing by it but drawing the stored one left a gap under a clipped legs table
    out.set(s.id, { ...s, x: at.x, y: at.y, h: at.h })
  }
  return slots.map((s) => out.get(s.id) ?? s)
}

const specOf = (specs: readonly BlockSpec[], id: string): BlockSpec | undefined => specs.find((b) => b.id === id)

/** The block put at (x, y) — a drag, or the arrow keys — and the others rearranged around it. */
export function place(
  slots: readonly Slot[], id: string, x: number, y: number, specs: readonly BlockSpec[], fitH: Readonly<Record<string, number>> = {},
): Slot[] {
  const moved = slots.map((s) => (s.id === id ? bounded({ ...s, x, y }, specOf(specs, id)) : s))
  return compact(moved, fitH, id)
}

/** The block given size (w, h) — its corner dragged, or Shift and the arrow keys. Its height stops following its content. */
export function resize(
  slots: readonly Slot[], id: string, w: number, h: number, specs: readonly BlockSpec[], fitH: Readonly<Record<string, number>> = {},
): Slot[] {
  const sized = slots.map((s) => (s.id === id ? bounded({ ...s, w, h, fit: false }, specOf(specs, id)) : s))
  return compact(sized, fitH, id)
}

/** A block shown or hidden; a block shown again goes back to its place, the others make room. */
export function setHidden(slots: readonly Slot[], id: string, hidden: boolean, fitH: Readonly<Record<string, number>> = {}): Slot[] {
  return compact(slots.map((s) => (s.id === id ? { ...s, hidden } : s)), fitH, hidden ? undefined : id)
}

/**
 * A stored layout over the page's default: known blocks take their stored slot (made valid), blocks the store does
 * not know take their default slot, unknown ids and malformed entries are dropped. Never throws.
 */
export function merge(saved: unknown, defaults: readonly Slot[], specs: readonly BlockSpec[]): Slot[] {
  const list = typeof saved === 'object' && saved !== null && Array.isArray((saved as { slots?: unknown }).slots)
    ? ((saved as { slots: unknown[] }).slots)
    : []
  const kept = new Map<string, Slot>()
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const id = typeof r['id'] === 'string' ? r['id'] : null
    const x = int(r['x']), y = int(r['y']), w = int(r['w']), h = int(r['h'])
    if (id === null || x === null || y === null || w === null || h === null || kept.has(id)) continue
    if (!defaults.some((d) => d.id === id)) continue
    kept.set(id, bounded({ id, x, y, w, h, hidden: r['hidden'] === true, ...(r['fit'] === true ? { fit: true } : {}) }, specOf(specs, id)))
  }
  return compact(defaults.map((d) => kept.get(d.id) ?? d))
}

export type WidthClass = 'narrow' | 'regular' | 'wide'
export type HeightClass = 'short' | 'tall'
export interface SizeClass { readonly width: WidthClass; readonly height: HeightClass }

/** What a block can afford at its size, in px: fewer columns or figures when narrow, a scroll when short. */
export function sizeClass(widthPx: number, heightPx: number): SizeClass {
  return {
    width: widthPx < 360 ? 'narrow' : widthPx < 720 ? 'regular' : 'wide',
    height: heightPx < 220 ? 'short' : 'tall',
  }
}

const VERSION = 1

/** One key per user and page, versioned so a later shape can start over cleanly. */
export function layoutKey(user: string, page: string): string {
  return `traders.layout.v${VERSION}.${page}.${user}`
}

export function readLayout(user: string, page: string, defaults: readonly Slot[], specs: readonly BlockSpec[]): Slot[] {
  try {
    const raw = window.localStorage.getItem(layoutKey(user, page))
    return merge(raw === null ? null : JSON.parse(raw), defaults, specs)
  } catch {
    return merge(null, defaults, specs)
  }
}

export function writeLayout(user: string, page: string, slots: readonly Slot[]): void {
  try { window.localStorage.setItem(layoutKey(user, page), JSON.stringify({ slots })) } catch { /* kept for this visit only */ }
}

export function clearLayout(user: string, page: string): void {
  try { window.localStorage.removeItem(layoutKey(user, page)) } catch { /* nothing stored to clear */ }
}
