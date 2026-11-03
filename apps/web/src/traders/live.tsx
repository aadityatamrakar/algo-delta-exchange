/**
 * The book live: one EventSource per book (shared by every part of the page that asks, closed when the last one
 * leaves), its frames laid over the polled figures while they are newer, and the pill that says which it is.
 *
 * Status: `live` — a frame or ping within LIVE_SILENT_MS; `delayed` — the stream errored or went quiet (EventSource
 * reconnects by itself; the page falls back to its polls); `closed` — the market is shut (no pill: the top bar says
 * so); `off` — no stream (the tab is hidden, or the browser has no EventSource), polls as before.
 */

import { useEffect, useState } from 'react'
import type { LiveFrame } from '../../../traders/src/analytics/r3-wire.ts'
import type { AnalysisLeg } from '../../../traders/src/analytics/wire.ts'
import { TRADERS_BASE, liveUrl } from './api.ts'
import { useDocumentVisible } from './hooks.ts'

export type LiveStatus = 'live' | 'delayed' | 'closed' | 'off'
export interface Live { readonly status: LiveStatus; readonly frame: LiveFrame | null }

/** Quiet this long (no frame, no ping — the server pings every 5 s) and the stream counts as delayed. */
export const LIVE_SILENT_MS = 10_000
/** The Analysis view's full refresh while live (instead of FIGURES_POLL_MS). */
export const LIVE_FIGURES_MS = 5_000

interface Conn { es: EventSource; frame: LiveFrame | null; lastAt: number; errored: boolean; refs: number }
const conns = new Map<string, Conn>()
const listeners = new Set<() => void>()
const emit = (): void => { for (const fn of listeners) fn() }

function acquire(url: string): void {
  const had = conns.get(url)
  if (had !== undefined) { had.refs++; return }
  const es = new EventSource(url, { withCredentials: TRADERS_BASE !== '' })
  const c: Conn = { es, frame: null, lastAt: Date.now(), errored: false, refs: 1 }
  conns.set(url, c)
  es.addEventListener('frame', (e) => {
    try { c.frame = JSON.parse((e as MessageEvent<string>).data) as LiveFrame } catch { return }
    c.lastAt = Date.now(); c.errored = false; emit()
  })
  es.addEventListener('ping', () => { c.lastAt = Date.now(); c.errored = false; emit() })
  es.addEventListener('gone', () => { es.close(); c.errored = true; emit() })   // no open book any more
  es.onopen = () => { c.errored = false; emit() }
  es.onerror = () => { c.errored = true; emit() }
}

function release(url: string): void {
  const c = conns.get(url)
  if (c === undefined) return
  if (--c.refs > 0) return
  c.es.close()
  conns.delete(url)
}

export function liveStatus(c: { frame: LiveFrame | null; lastAt: number; errored: boolean } | undefined, now: number): LiveStatus {
  if (c === undefined) return 'off'
  if (c.frame?.closed === true) return 'closed'
  if (c.errored || c.frame === null || now - c.lastAt > LIVE_SILENT_MS) return 'delayed'
  return 'live'
}

/** The book's live stream while the tab is visible; every caller for one book shares one connection. */
export function useLiveBook(stock: string): Live {
  const visible = useDocumentVisible()
  const supported = typeof EventSource !== 'undefined'
  const url = liveUrl(stock)
  const [, bump] = useState(0)
  useEffect(() => {
    if (!visible || !supported) return
    acquire(url)
    const fn = (): void => bump((n) => n + 1)
    listeners.add(fn)
    const t = setInterval(fn, 2_000)   // re-read the status as time passes (a stream going quiet)
    fn()   // the connection exists only now, after the render that asked for it
    return () => { listeners.delete(fn); clearInterval(t); release(url) }
  }, [url, visible, supported])
  const c = visible && supported ? conns.get(url) : undefined
  return { status: liveStatus(c, Date.now()), frame: c?.frame ?? null }
}

/** Is the frame the one to show over figures served at `asOf`. */
export function liveWins(live: Live, asOf: number): live is Live & { frame: LiveFrame } {
  return live.status === 'live' && live.frame !== null && live.frame.asOf > asOf
}

/** The frame the figures are read off while the stream is live: one source for the strip and the P&L block. */
export function liveFrameOf(live: Live): LiveFrame | null {
  return live.status === 'live' ? live.frame : null
}

/**
 * Today (the MTM block's total, `today` its trades less their charges, `charges` those charges) from a frame, or why
 * it has none. `charges` is undefined from a server that sends none.
 */
export interface FrameToday { readonly total: number | null; readonly today: number | null; readonly charges?: number | null; readonly why: string | null }

/**
 * Today from a frame that speaks for the block: its figures, its unknown total included, or the reason it has none
 * (before the open). Null when it does not: an old server's frame (no `mtmReason`) carries the old basis.
 */
export function frameToday(f: LiveFrame | null): FrameToday | null {
  if (f === null || f.mtmReason === undefined || (f.mtmToday === null && f.mtmReason === null)) return null
  return { total: f.mtmTotal, today: f.mtmToday, why: f.mtmReason, ...(f.mtmCharges === undefined ? {} : { charges: f.mtmCharges }) }
}

/** The Analysis legs with the live LTP, bid, ask and gross MTM, while the frame is live and newer. */
export function overlayLegs(legs: readonly AnalysisLeg[], live: Live, asOf: number): readonly AnalysisLeg[] {
  if (!liveWins(live, asOf)) return legs
  const byKey = new Map(live.frame.legs.map((l) => [l.key, l] as const))
  return legs.map((l) => {
    const f = byKey.get(l.key)
    if (f === undefined) return l
    return { ...l, ltp: f.ltp ?? l.ltp, buyPrice: f.bid ?? l.buyPrice, salePrice: f.ask ?? l.salePrice, grossMtm: f.grossMtm ?? l.grossMtm }
  })
}

/** "● Live" while live, "Delayed" (amber) while the stream is down; nothing when closed or off. */
export function LivePill(props: { readonly status: LiveStatus }): React.ReactElement | null {
  if (props.status === 'live') return <span className="traders-live-pill traders-live-on" role="status">● Live</span>
  if (props.status === 'delayed') {
    return (
      <span className="traders-live-pill traders-live-delayed" role="status" title="live prices interrupted — refreshing every 15–60 s">
        Delayed
      </span>
    )
  }
  return null
}

/** Tests only: forget every connection. */
export function resetLive(): void {
  for (const c of conns.values()) c.es.close()
  conns.clear()
  listeners.clear()
}
