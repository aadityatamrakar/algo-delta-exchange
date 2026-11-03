/**
 * A book's band and relief-r's advice: the band chip beside the book's name,
 * the band dot on its tab, and the Advice sub-tab — the card, the trader's own
 * band, and the repair search.
 *
 * It only suggests (spec item 6). The card and each repair plan offer "Show on
 * payoff" — `openWhatIf`, the Scenario sub-tab with the legs as hypothetical
 * rows — and nothing else: no control here places, changes or cancels an
 * order. The one write is the band override, a number the band is read against.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { List } from '@astryxdesign/core/List'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { GREEN, RED } from '../format.ts'
import type { AdviceCard, BandStatus, RepairView } from '../../../traders/src/analytics/r3-wire.ts'
import type { BandState, BookSummary, BookView } from '../../../traders/src/types.ts'
import { TradersApiError, tapi } from './api.ts'
import { FIGURES_POLL_MS, useDocumentVisible, useOnLegsChange, usePoll, type Polled } from './hooks.ts'
import { openWhatIf } from './what-if.ts'
import { istHm } from './wire.ts'
import { BellAlert } from './bell.tsx'
import { Caveats } from './caveats.tsx'
import { RepairPlans } from './repair-card.tsx'

/** A band state's dot and its words: the chip, the book tab's dot and the Portfolio's band column all read these. */
export const BAND_DOT: Readonly<Record<BandState, 'success' | 'error' | 'neutral'>> = { in: 'success', out: 'error', unknown: 'neutral' }
export const BAND_WORD: Readonly<Record<BandState, string>> = { in: 'In band', out: 'Out of band', unknown: 'Band unknown' }

const ADVICE_WHAT_IF = 'relief-r suggestion'
const LOTS_PROBLEM = 'Enter the band in lots, or leave the field empty to clear it'
const REPAIR_BUSY = 'Two repair searches are already running; try again in a few seconds'

const lotsText = (n: number): string => `${n} ${n === 1 ? 'lot' : 'lots'}`

/** Who re-reads a book's card when its band is written here: the chip and the sub-tab, so neither waits out the minute. */
const bandReaders = new Set<(stock: string) => void>()

/**
 * The book's card, every 60 s while the tab is visible: the server reads each
 * book once a minute and every viewer shares it. Read again at once when the
 * book's legs change (an upload inside the minute) or its band is written.
 */
function useAdvice(stock: string, view: BookView): Polled<AdviceCard> {
  const visible = useDocumentVisible()
  const advice = usePoll(() => tapi.advice(stock), FIGURES_POLL_MS, [stock], visible)
  const { reload } = advice
  useOnLegsChange(view.legs, reload)
  useEffect(() => {
    const on = (s: string): void => { if (s === stock) reload() }
    bandReaders.add(on)
    return () => { bandReaders.delete(on) }
  }, [stock, reload])
  return advice
}

function BandLine(p: { state: BandState; sentence: string }): ReactElement {
  const tone = p.state === 'in' ? { style: GREEN } : p.state === 'out' ? { style: RED } : { color: 'secondary' as const }
  return (
    <HStack gap={1} align="center">
      <StatusDot variant={BAND_DOT[p.state]} label={BAND_WORD[p.state]} />
      <Text size="sm" {...tone}>{p.sentence}</Text>
    </HStack>
  )
}

/**
 * The band sentence beside the book's name: green in band, red out of band,
 * plain words when unknown. A reading that could not be refreshed is no longer
 * a live one, so it loses its colour and says so.
 */
export function BandChip(p: { stock: string; view: BookView }): ReactElement | null {
  const advice = useAdvice(p.stock, p.view)
  const card = advice.data
  // An answer with no band in it shows nothing rather than take the book's header down with it.
  const band = card?.band ?? null
  if (card === null || band === null) {
    return advice.error === null ? null : <BandLine state="unknown" sentence={`Band unknown: ${advice.error}`} />
  }
  if (advice.error !== null) {
    return <BandLine state="unknown" sentence={`${band.sentence} — as of ${istHm(card.computedAt)} IST, refresh failed`} />
  }
  return <BandLine state={band.state} sentence={band.sentence} />
}

/** A book tab's band dot, from the books list; none before the band board has read the book. */
export function bandBadge(s: BookSummary): ReactElement | null {
  // `??`: the page is live on build, so a server not yet restarted onto R3 sends summaries with no band.
  const state = s.band ?? null
  return state === null ? null : <StatusDot variant={BAND_DOT[state]} label={BAND_WORD[state]} />
}

/**
 * relief-r's card: the headline, the other lines, relief-r's reason (muted),
 * Show on payoff, and the notes, the history line first. A card with no advice
 * (hold, market closed, unavailable) has nothing to show and no button.
 */
export function AdviceCardView(p: { card: AdviceCard }): ReactElement {
  const { card } = p
  // An advice card's headline is its first line; below it go the rest.
  const rest = card.lines[0] === card.headline ? card.lines.slice(1) : card.lines
  const unavailable = card.status === 'unavailable'
  return (
    <Card>
      <VStack gap={3} padding={3}>
        <Text size="sm" color="secondary">
          {unavailable ? `relief-r · checked at ${istHm(card.computedAt)} IST` : `relief-r · as of ${istHm(card.asOf)} IST`}
        </Text>
        <Heading level={4} {...(unavailable ? { color: 'secondary' as const } : {})}>{card.headline}</Heading>
        {rest.length === 0 ? null : (
          <VStack gap={1}>{rest.map((l, i) => <Text key={`${i}:${l}`}>{l}</Text>)}</VStack>
        )}
        {/* An advice with no line of its own is headed by the reason itself. */}
        {card.reason === '' || card.reason === card.headline ? null : <Text size="sm" color="secondary">{card.reason}</Text>}
        {card.status !== 'advice' || card.whatIf.length === 0 ? null : (
          <HStack>
            <Button variant="secondary" label="Show on payoff" onClick={() => openWhatIf(card.stock, card.whatIf, ADVICE_WHAT_IF)} />
          </HStack>
        )}
        <List aria-label="Notes" density="compact" header={<Text size="sm" weight="bold">Notes</Text>}>
          <Caveats items={card.notes} kind="item" />
        </List>
      </VStack>
    </Card>
  )
}

/**
 * The trader's own band in lots; an empty field hands it back to relief-r. The
 * server's answer is shown until the re-read card arrives.
 */
function BandOverride(p: { stock: string; band: BandStatus }): ReactElement {
  const { stock, band } = p
  const [saved, setSaved] = useState<{ over: BandStatus; status: BandStatus } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shown = saved !== null && saved.over === band ? saved.status : band
  const own = shown.source === 'override' && shown.bandLots !== null ? shown.bandLots : null
  const text = draft ?? (own === null ? '' : String(own))

  const save = async (): Promise<void> => {
    const t = text.trim()
    const lots = t === '' ? null : Number(t)
    if (lots !== null && !Number.isFinite(lots)) {
      setError(LOTS_PROBLEM)
      return
    }
    setSaving(true)
    setError(null)
    try {
      setSaved({ over: band, status: await tapi.putBand(stock, lots) })
      setDraft(null)
      for (const read of bandReaders) read(stock)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const about = own !== null
    ? `Your band: ±${lotsText(own)}. Leave the field empty to hand it back to relief-r.`
    : shown.bandLots === null
      ? "relief-r's band cannot be read now. Enter lots to use your own."
      : `relief-r's band: ±${lotsText(shown.bandLots)}. Enter lots to use your own.`

  return (
    <VStack gap={2}>
      <HStack gap={2} align="end" wrap="wrap">
        <TextInput label="Band override (lots)" size="sm" width={160} value={text} onChange={(s) => setDraft(s)} onEnter={() => void save()} />
        <Button size="sm" variant="secondary" label="Set band" isDisabled={saving} onClick={() => void save()} />
      </HStack>
      <Text size="sm" color="secondary">{about}</Text>
      {error === null ? null : <Banner status="error" title={error} />}
    </VStack>
  )
}

/**
 * "Find repairs": the repair search on the book's near expiry, its plans by
 * goal, each with Show on payoff. The search is asked for, never polled; a
 * busy pool is said in words with Retry. Plans are for the legs they were
 * searched on: a change of legs clears them and drops a search still out.
 */
export function RepairList(p: { stock: string; view: BookView }): ReactElement {
  const { stock } = p
  const [view, setView] = useState<RepairView | null>(null)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  useOnLegsChange(p.view.legs, () => {
    request.current++
    setView(null)
    setSearching(false)
    setBusy(false)
    setError(null)
  })

  const find = async (): Promise<void> => {
    const mine = ++request.current
    setSearching(true)
    setBusy(false)
    setError(null)
    try {
      const found = await tapi.repair(stock)
      if (mine === request.current) setView(found)
    } catch (err) {
      if (mine !== request.current) return
      if (err instanceof TradersApiError && err.status === 429) setBusy(true)
      else setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mine === request.current) setSearching(false)
    }
  }

  return (
    <VStack gap={3}>
      <HStack gap={2} align="center">
        <Heading level={4}>Repairs</Heading>
        <Button size="sm" variant="secondary" label="Find repairs" isDisabled={searching} onClick={() => void find()} />
        {searching ? <Text size="sm" color="secondary">Searching…</Text> : null}
      </HStack>
      {busy ? (
        <Banner status="warning" title={REPAIR_BUSY} endContent={<Button size="sm" variant="secondary" label="Retry" onClick={() => void find()} />} />
      ) : null}
      {error === null ? null : <Banner status="error" title={`The repair search failed: ${error}`} />}
      {view === null ? null : view.error !== null ? <Banner status="info" title={view.error} /> : (
        <VStack gap={3}>
          <Text size="sm" color="secondary">{`Plans for the ${view.expiry ?? ''} expiry · searched at ${istHm(view.computedAt)} IST`}</Text>
          <Caveats items={view.warnings} kind="warning" />
          {view.offset === null ? null : <Text size="sm" color="secondary">{view.offset.note}</Text>}
          <RepairPlans stock={stock} view={view} legs={p.view.legs} />
        </VStack>
      )}
    </VStack>
  )
}

/** The Advice sub-tab: relief-r's card, the band override, and the repairs. */
export function AdviceTab(p: { stock: string; view: BookView }): ReactElement {
  const advice = useAdvice(p.stock, p.view)
  const card = advice.data
  return (
    <VStack gap={4}>
      {card === null ? (
        advice.error === null
          ? <Text color="secondary">{`Loading ${p.stock} advice…`}</Text>
          : <BellAlert status="error" inline text={`Could not load the advice: ${advice.error}`} />
      ) : (
        <>
          <BellAlert text={advice.error === null ? null : `Refresh failed: ${advice.error}`} />
          <AdviceCardView card={card} />
          <BandOverride stock={p.stock} band={card.band} />
        </>
      )}
      <RepairList stock={p.stock} view={p.view} />
    </VStack>
  )
}
