/**
 * Δ0, the breakevens, the time value and the net Δ per book, shared: the Analysis view publishes the To Neutralize it already loaded, and the book's summary strip
 * reads it — no second request while that view is open, and the strip's Net Δ is the Greeks table's T row. A figure
 * older than `fresh` counts as none, so the strip asks for its own when the view is not on screen.
 */

import { useEffect, useState } from 'react'

export interface Neutral {
  readonly price: number | null; readonly pct: number | null
  readonly bepLow: number | null; readonly bepHigh: number | null
  readonly timeValue: number | null
  /** The Greeks table's T delta; null = none. */
  readonly delta: number | null
  readonly at: number
}

const latest = new Map<string, Neutral>()
const listeners = new Set<() => void>()

export function publishNeutral(stock: string, f: Omit<Neutral, 'at'>, at: number): void {
  const had = latest.get(stock)
  const same = had !== undefined && had.price === f.price && had.pct === f.pct && had.bepLow === f.bepLow && had.bepHigh === f.bepHigh && had.timeValue === f.timeValue && had.delta === f.delta
  if (same && at - had.at < 30_000) return
  latest.set(stock, { ...f, at })
  for (const fn of listeners) fn()
}

export function readNeutral(stock: string, now: number, fresh: number): Neutral | null {
  const n = latest.get(stock)
  return n === undefined || now - n.at > fresh ? null : n
}

/** The latest published Δ0 of `stock`, re-read whenever one is published. */
export function useNeutral(stock: string): Neutral | null {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = (): void => bump((n) => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return latest.get(stock) ?? null
}

/** For tests: forget every published figure. */
export function clearNeutral(): void {
  latest.clear()
  open.clear()
}

/** Books whose Analysis view is on screen: their strip shows what the view publishes, even paused, and never polls. */
const open = new Map<string, number>()

export function useAnalysisOpen(stock: string): void {
  useEffect(() => {
    open.set(stock, (open.get(stock) ?? 0) + 1)
    for (const fn of listeners) fn()
    return () => {
      const n = (open.get(stock) ?? 1) - 1
      if (n <= 0) open.delete(stock); else open.set(stock, n)
      for (const fn of listeners) fn()
    }
  }, [stock])
}

export function analysisOpen(stock: string): boolean {
  return (open.get(stock) ?? 0) > 0
}
