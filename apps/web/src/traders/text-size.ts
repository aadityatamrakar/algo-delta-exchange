/**
 * The traders page's text size: one setting that scales the page from its root font size (astryx sizes text, and most
 * spacing, in rem). Medium is the default, a step up from the browser's 16 px; it is remembered per browser. The desk
 * page is a separate page and keeps its own size.
 */

import { useCallback, useEffect, useState } from 'react'

export type TextSize = 'sm' | 'md' | 'lg' | 'xl'

export const TEXT_SIZES: readonly { readonly id: TextSize; readonly label: string; readonly pct: number }[] = [
  { id: 'sm', label: 'Small', pct: 100 },
  { id: 'md', label: 'Medium', pct: 112.5 },
  { id: 'lg', label: 'Large', pct: 125 },
  { id: 'xl', label: 'Larger', pct: 137.5 },
]

const KEY = 'traders.textSize'
const DEFAULT: TextSize = 'md'

function stored(): TextSize {
  try {
    const v = window.localStorage.getItem(KEY)
    return TEXT_SIZES.some((s) => s.id === v) ? (v as TextSize) : DEFAULT
  } catch {
    return DEFAULT
  }
}

export const textSizeLabel = (s: TextSize): string => TEXT_SIZES.find((x) => x.id === s)?.label ?? 'Medium'

/** One step smaller (-1) or larger (+1), stopping at the ends. */
export function stepTextSize(s: TextSize, by: -1 | 1): TextSize {
  const i = TEXT_SIZES.findIndex((x) => x.id === s)
  return TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, i + by))]!.id
}

/** The stored size, applied to the page's root; the setter stores and applies a new one. */
export function useTextSize(): [TextSize, (s: TextSize) => void] {
  const [size, setSize] = useState<TextSize>(stored)
  useEffect(() => {
    document.documentElement.style.fontSize = `${TEXT_SIZES.find((x) => x.id === size)?.pct ?? 112.5}%`
  }, [size])
  const set = useCallback((s: TextSize) => {
    try { window.localStorage.setItem(KEY, s) } catch { /* the size still applies while the page stays open */ }
    setSize(s)
  }, [])
  return [size, set]
}
