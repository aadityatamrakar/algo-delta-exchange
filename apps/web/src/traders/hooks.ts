/**
 * Polling, kept apart from the desk's `usePoll` so this page imports nothing of
 * the desk's; and the settle-then-fetch pair the Analysis and Scenario
 * sub-tabs share (one request per burst of input, stale answers dropped).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { LegView, Role } from '../../../traders/src/types.ts'

/** Who is signed in and, for an admin, whose books are on screen. Pages read it; `app.tsx` provides it. */
export interface Session { readonly username: string; readonly role: Role; readonly asTrader: string | null }
export const SessionContext = createContext<Session | null>(null)
export function useSession(): Session | null { return useContext(SessionContext) }

export interface Polled<T> {
  readonly data: T | null
  readonly error: string | null
  /** The status of the last failure (0 for a network failure), or null. */
  readonly status: number | null
  reload(): void
}

/**
 * Runs `fn` now and every `everyMs`. A change in `deps` forgets the old data —
 * a book that is no longer on screen must not stay painted under the next one —
 * and discards any answer still in flight for the old deps. A failure keeps the
 * last good data and reports the error beside it. While `enabled` is false
 * nothing runs and the last data stays on screen; turning it on runs at once.
 */
export function usePoll<T>(fn: () => Promise<T>, everyMs: number, deps: unknown[], enabled = true): Polled<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; status: number | null }>(
    { data: null, error: null, status: null },
  )
  const [nonce, setNonce] = useState(0)
  const latest = useRef(fn)
  latest.current = fn

  const depsKey = JSON.stringify(deps)
  // Only a CHANGE of what is being read forgets the data; `reload()` keeps it on screen while it refetches.
  useEffect(() => { setState({ data: null, error: null, status: null }) }, [depsKey])

  useEffect(() => {
    if (!enabled) return
    let alive = true
    let busy = false
    const run = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const data = await latest.current()
        if (alive) setState({ data, error: null, status: null })
      } catch (err) {
        if (alive) {
          const status = typeof (err as { status?: unknown }).status === 'number'
            ? (err as { status: number }).status : 0
          setState((s) => ({
            data: s.data, status,
            error: err instanceof Error ? err.message : String(err),
          }))
        }
      } finally {
        busy = false
      }
    }
    void run()
    const id = setInterval(() => void run(), everyMs)
    return () => { alive = false; clearInterval(id) }
  }, [everyMs, nonce, depsKey, enabled])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, reload }
}

/**
 * Calls `fn` when a book's open legs change after the first render (an upload
 * or a leg edit inside the minute), so a sub-tab that polls once a minute does
 * not wait it out. A fresh poll of the same legs calls nothing.
 */
export function useOnLegsChange(legs: readonly Pick<LegView, 'key' | 'qty'>[], fn: () => void): void {
  const key = legs.map((l) => `${l.key}:${l.qty}`).join('|')
  const seen = useRef(key)
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    if (key === seen.current) return
    seen.current = key
    latest.current()
  }, [key])
}

/** False while the browser tab is in the background. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const on = (): void => setVisible(!document.hidden)
    on()
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/** `value` once its content has stopped changing for `ms`. */
export function useSettled<T>(value: T, ms: number): T {
  const key = JSON.stringify(value)
  const [settled, setSettled] = useState({ key, value })
  const latest = useRef(value)
  latest.current = value
  useEffect(() => {
    if (key === settled.key) return
    const id = setTimeout(() => setSettled({ key, value: latest.current }), ms)
    return () => clearTimeout(id)
  }, [key, ms, settled.key])
  return settled.value
}

/**
 * What a tick answers while Online Update is off: a promise that never
 * settles, so the figures on screen stay as they are. A fresh one each time —
 * a shared one would hold every waiting tick's closure for the page's life.
 */
const paused = (): Promise<never> => new Promise<never>(() => {})

/** How often a sub-tab's figures refresh on their own (the P13 floor). */
export const FIGURES_POLL_MS = 60_000

/**
 * R1's `usePoll` every 60 s, plus `refetch()` — fetch now, whatever Online
 * Update says — and a refetch whenever `trigger` changes. With `online` off a
 * tick is `paused()`, which also keeps usePoll from starting another until the
 * next refetch begins a fresh cycle.
 */
export function useFigures<T>(
  load: () => Promise<T>, online: boolean, trigger: string, everyMs: number = FIGURES_POLL_MS,
): Polled<T> & { refetch(): void } {
  const live = useRef(online)
  live.current = online
  const force = useRef(false)
  const [cycle, setCycle] = useState(0)
  // Each cycle's first run fetches: the mount's (StrictMode's second mount too) and each one `refetch` starts.
  // Declared before usePoll, this runs in the commit that starts the cycle, after the old cycle's interval is
  // cleared and right before the new cycle's first run, so no tick of an older cycle can take the force.
  useEffect(() => { force.current = true }, [cycle])
  const poll = usePoll(() => {
    if (!live.current && !force.current) return paused()
    force.current = false
    return load()
  }, everyMs, [])
  const { reload } = poll
  const refetch = useCallback(() => { setCycle((c) => c + 1); reload() }, [reload])
  const seen = useRef(trigger)
  useEffect(() => {
    if (trigger === seen.current) return
    seen.current = trigger
    refetch()
  }, [trigger, refetch])
  return { ...poll, refetch }
}
