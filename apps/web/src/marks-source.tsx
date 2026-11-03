/**
 * WHICH EXCHANGE PRICED A BOOK — and the loud case, when it fell back.
 *
 * Paper books on Delta's demo rail are marked with TESTNET prices, because that
 * is the exchange their positions live on. Until the testnet socket has quoted
 * a leg, the bridge marks that leg at PRODUCTION prices and lists it in
 * `marksFallback`. Those figures are a different exchange's, so a book showing
 * them is incomplete — and that must be said on screen, never absorbed into a
 * number that looks like the rest.
 *
 * Every field here is OPTIONAL on the wire. Absent renders nothing: an older
 * bridge has not said which exchange it used, and a guessed label would be a
 * claim the server never made.
 */

import { HStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import type { DemoFeedHealth, MarksSource } from './api.ts'

/** "marks: Delta demo" / "marks: Delta" — null when the bridge did not say. */
export function marksSourceLabel(source: MarksSource | undefined): string | null {
  if (source === undefined) return null
  return source === 'delta-demo' ? 'marks: Delta demo' : 'marks: Delta'
}

/** The sentence a fallback is stated in. Null when nothing fell back. */
export function fallbackWarning(fallback: readonly string[] | undefined): string | null {
  if (fallback === undefined || fallback.length === 0) return null
  const n = fallback.length
  return `incomplete — ${n} leg${n === 1 ? '' : 's'} on Delta prices (no demo quote yet): ${fallback.join(', ')}`
}

/**
 * The book page's label, with the warning BESIDE it when legs fell back.
 * Renders nothing at all when the bridge sent neither field.
 */
export function MarksSourceNote(props: {
  source: MarksSource | undefined
  fallback: readonly string[] | undefined
}): React.ReactElement | null {
  const label = marksSourceLabel(props.source)
  const warning = fallbackWarning(props.fallback)
  if (label === null && warning === null) return null
  return (
    <HStack gap={2} align="center" wrap="wrap">
      {label === null ? null : <Text size="sm" color="secondary">{label}</Text>}
      {warning === null ? null : (
        <>
          <Badge variant="warning" label="production prices" />
          <Text size="sm" weight="medium">{warning}</Text>
        </>
      )}
    </HStack>
  )
}

/**
 * The compact form, for a P&L row: one badge, the legs named on hover.
 * Nothing when the row did not fall back.
 */
export function MarksFallbackBadge(props: { fallback: readonly string[] | undefined }): React.ReactElement | null {
  const warning = fallbackWarning(props.fallback)
  if (warning === null) return null
  return (
    <span title={warning} style={{ display: 'inline-flex' }}>
      <Badge variant="warning" label="incomplete" />
    </span>
  )
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The testnet socket's block off a market-data card's `extra`, or null.
 *
 * VALIDATED, not cast: `extra` is an untyped bag, and a half-shaped block
 * rendered as "connected" on the strength of a missing field is the false
 * all-clear a status page cannot afford. Malformed reads as absent.
 */
export function demoFeedOf(extra: Record<string, unknown> | undefined): DemoFeedHealth | null {
  const d = extra?.['demo']
  if (d === null || typeof d !== 'object') return null
  const o = d as Record<string, unknown>
  if (typeof o['connected'] !== 'boolean') return null
  if (!isNum(o['tokens']) || !isNum(o['staleTokens']) || !isNum(o['oldestAgeMs'])) return null
  const down = o['downForMs']
  if (down !== null && !isNum(down)) return null
  return {
    url: typeof o['url'] === 'string' ? o['url'] : '',
    connected: o['connected'],
    downForMs: down,
    tokens: o['tokens'],
    staleTokens: o['staleTokens'],
    oldestAgeMs: o['oldestAgeMs'],
  }
}

/** "42s" / "3m 5s" — a duration, not an "ago". */
function span(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** One line under the market-data card: the testnet price socket's state. */
export function DemoFeedLine(props: { demo: DemoFeedHealth }): React.ReactElement {
  const d = props.demo
  const counts = `${d.tokens} tokens · ${d.staleTokens} stale${d.staleTokens > 0 ? ` (oldest ${Math.round(d.oldestAgeMs / 1000)}s)` : ''}`
  return (
    <HStack gap={2} align="center" wrap="wrap">
      <Text size="sm" weight="medium">Delta testnet prices</Text>
      <Badge variant={d.connected ? 'success' : 'warning'} label={d.connected ? 'connected' : 'down'} />
      {d.connected ? null : (
        <Text size="sm" weight="medium">
          {d.downForMs === null ? 'duration not reported' : `down for ${span(d.downForMs)}`}
        </Text>
      )}
      <Text size="sm" color="secondary">{counts}</Text>
    </HStack>
  )
}
