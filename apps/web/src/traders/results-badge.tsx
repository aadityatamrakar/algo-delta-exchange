/**
 * The book header's results badge and what it reads (risk spec §3): split from risk.tsx so a book screen loads the
 * badge, not the whole Risk page. risk.tsx re-exports these.
 */

import type { ReactElement } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { inr } from '../format.ts'
import type { EventOutcome, EventRiskView } from '../../../traders/src/analytics/risk-wire.ts'
import { tapi } from './api.ts'
import { useDocumentVisible, usePoll, useSession, type Polled } from './hooks.ts'
import { expiryDayLabel } from './wire.ts'

export const RISK_POLL_MS = 60_000
const DASH = '—'
const MINUS = '−'
/** The vol page's event amber (vol.tsx EVENT_FILL's colour), as text. */
const AMBER = { color: 'var(--color-warning, #c58a00)' }
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

export function useEventsView(enabled: boolean): Polled<EventRiskView> {
  const asTrader = useSession()?.asTrader ?? null
  return usePoll(() => tapi.events(), RISK_POLL_MS, [asTrader], enabled)
}

/** Rupees, en-IN grouping, a real minus: −₹4,12,000. Null is "—". */
export function rs(n: number | null | undefined, plus = false): string {
  if (!isNum(n)) return DASH
  const body = `₹${inr(Math.abs(n))}`
  return n < 0 ? `${MINUS}${body}` : plus && n > 0 ? `+${body}` : body
}
/** "27 Oct" from an ISO date. */
export const dm = (d: string): string => expiryDayLabel(d).slice(0, 6)

// ------------------------------------------------------------------ the book header's badge

/** "Results 27 Oct · near expiry" (or "· 25 Nov 26") when the book holds through its next results date; the tooltip gives the down and up outcomes. */
export function resultsBadgeOf(events: EventRiskView | null, stock: string): { readonly text: string; readonly tip: string } | null {
  const row = events !== null && Array.isArray(events.rows) ? events.rows.find((r) => r.stock === stock) : undefined
  const n = row?.next
  if (row === undefined || n === null || n === undefined || !n.heldThrough) return null
  const out = (label: EventOutcome['label']): string => rs(row.outcomes.find((o: EventOutcome) => o.label === label)?.change, true)
  return {
    text: `Results ${dm(n.date)} · ${n.inNear ? 'near expiry' : n.expiry === null ? 'no expiry listed' : expiryDayLabel(n.expiry)}`,
    tip: `Change if the results move the stock: down ${out('down')}, up ${out('up')}`,
  }
}

export function ResultsBadge(p: { stock: string }): ReactElement | null {
  const visible = useDocumentVisible()
  const events = useEventsView(visible)
  const b = resultsBadgeOf(events.data, p.stock)
  // Text, not astryx Badge: the book screen's graph does not otherwise load Badge, and loading it there slowed the
  // Analysis tab's timed tests past their limit when the whole suite runs at once
  return b === null ? null : <span title={b.tip}><Text size="sm" weight="bold" style={AMBER}>{b.text}</Text></span>
}
