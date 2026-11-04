/**
 * MARGIN UTILIZED — the two Delta accounts and the BULL-S books' estimates.
 *
 * Two reads, four surfaces:
 *
 *   `GET /v1/desk/margin` (no tag) — the demo and live accounts' wallet: the
 *   Positions page's Margin panel and the Status page's Margin card.
 *
 *   `GET /v1/desk/margin/books` — each BULL-S book's estimated margin now and
 *   at its cap: a line on its Books row and in its Dials panel.
 *
 * EVERY FIGURE HERE IS USD, whatever the build's venue: these are Delta
 * accounts. The ₹ beside it is at the response's own rate (85).
 *
 * NULL IS NEVER 0. A failed read or an absent account carries null figures,
 * and the panel prints the server's error or reason in their place; a book
 * that cannot be estimated prints "—" with what is missing on hover. A $0.00
 * here would read as "no margin in use", which is the one thing nobody knows.
 *
 * THE STATES ARE THE SERVER'S. `stale` is not re-derived from `ageMs` and the
 * browser clock — the same rule the Status page keeps for every component.
 */
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Card } from '@astryxdesign/core/Card'
import { Badge } from '@astryxdesign/core/Badge'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { useState } from 'react'
import {
  ago,
  api,
  type AccountMargin,
  type AccountMarginResponse,
  type BookMarginEstimate,
  type BookMarginEstimatesResponse,
  type DeskMode,
} from './api.ts'
import { cash } from './format.ts'
import { usePoll } from './shell.tsx'
import { DX } from './venue.ts'

/** The wallet moves with fills; 15s is inside the usePoll range the desk uses. */
export const ACCOUNT_MARGIN_POLL_MS = 15_000
/** The estimate moves with the index and the book's legs. */
export const BOOK_MARGIN_POLL_MS = 15_000

/** At or above this share of the balance in use, the Status card asks for attention. */
export const UTILIZED_ATTENTION_PCT = 80

// ------------------------------------------------------------- formatting

const rateOf = (rate: number | null | undefined): number =>
  typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : DX.inrPerUnit

/** Whole rupees at `rate`: `₹85,000`. */
export function inrAt(usd: number, rate: number | null | undefined): string {
  const r = Math.round(usd * rateOf(rate))
  return `${r < 0 ? '-' : ''}₹${Math.abs(r).toLocaleString('en-IN')}`
}

/** `$1,000.00 (₹85,000)`, or `—` for a figure nobody knows. Never `$0.00` for null. */
export function usdWithInr(usd: number | null | undefined, rate: number | null | undefined): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
  return `${cash(usd, DX)} (${inrAt(usd, rate)})`
}

function pct(n: number | null): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)}%` : '—'
}

/** The accounts list, or null when the reply is not this shape (an older api). */
function accountsOf(data: AccountMarginResponse | null): readonly AccountMargin[] | null {
  if (data === null) return null
  return Array.isArray(data.accounts) ? data.accounts : null
}

// ------------------------------------------------------------------ tone

export type MarginTone = 'ok' | 'stale' | 'attention' | 'unknown'

/** One account's state as a badge, in the Status page's palette. */
const ACCOUNT_PAINT: Record<AccountMargin['state'], { variant: 'success' | 'warning' | 'error' | 'neutral'; label: string }> = {
  ok: { variant: 'success', label: 'ok' },
  stale: { variant: 'warning', label: 'stale' },
  failed: { variant: 'error', label: 'failed' },
  absent: { variant: 'neutral', label: 'absent' },
}

const TONE_PAINT: Record<MarginTone, { variant: 'success' | 'warning' | 'neutral'; label: string }> = {
  ok: { variant: 'success', label: 'ok' },
  stale: { variant: 'warning', label: 'stale' },
  attention: { variant: 'warning', label: 'attention' },
  // Grey, like the Status page's `unknown`, but its own words: nothing is
  // known about the accounts, which is not a process that has gone quiet.
  unknown: { variant: 'neutral', label: 'no figures' },
}

const high = (a: AccountMargin): boolean =>
  (a.state === 'ok' || a.state === 'stale') &&
  typeof a.utilizedPct === 'number' && a.utilizedPct >= UTILIZED_ATTENTION_PCT

/**
 * The card's one verdict: ATTENTION when a read failed or an account is at
 * 80%+ used; STALE when the freshest figures are old; OK when one is current;
 * UNKNOWN when nothing is known (no account, or both absent — absent is a
 * condition, not a fault).
 */
export function marginTone(accounts: readonly AccountMargin[]): MarginTone {
  if (accounts.some((a) => a.state === 'failed' || high(a))) return 'attention'
  if (accounts.some((a) => a.state === 'stale')) return 'stale'
  if (accounts.some((a) => a.state === 'ok')) return 'ok'
  return 'unknown'
}

/** What stands in for the figures of an account that has none. */
function whyNoFigures(a: AccountMargin): string {
  if (a.state === 'failed') return `read failed: ${a.error === '' ? 'no error text' : a.error}`
  return a.reason === '' ? 'not configured' : a.reason
}

const hasFigures = (a: AccountMargin): boolean => a.state === 'ok' || a.state === 'stale'

// ------------------------------------------------------ Positions panel

function Figure(props: { label: string; value: string }): React.ReactElement {
  return (
    <VStack gap={0}>
      <Text size="sm" color="secondary">{props.label}</Text>
      <Text weight="bold">{props.value}</Text>
    </VStack>
  )
}

function AccountBlock(props: { account: AccountMargin; rate: number }): React.ReactElement {
  const a = props.account
  const paint = ACCOUNT_PAINT[a.state] ?? ACCOUNT_PAINT.absent
  return (
    <VStack gap={1} role="group" aria-label={`${a.label} margin`}>
      <HStack gap={2} align="center" wrap="wrap">
        <Text weight="bold">{a.label}</Text>
        <Badge variant={paint.variant} label={paint.label} />
        {a.state === 'stale' ? (
          <Text size="sm" color="secondary">
            {`figures from ${ago(a.ageMs)}${a.reason === '' ? '' : ` · ${a.reason}`}`}
          </Text>
        ) : null}
      </HStack>
      {hasFigures(a) ? (
        <HStack gap={4} wrap="wrap">
          <Figure label="Balance" value={usdWithInr(a.balance, props.rate)} />
          <Figure label="Available" value={usdWithInr(a.available, props.rate)} />
          <Figure label="Used" value={usdWithInr(a.used, props.rate)} />
          <Figure label="Utilized" value={pct(a.utilizedPct)} />
        </HStack>
      ) : (
        <Text size="sm" color="secondary">{whyNoFigures(a)}</Text>
      )}
    </VStack>
  )
}

/**
 * THE MARGIN PANEL on the Positions page: both Delta accounts, demo first.
 *
 * An ACCOUNT figure on a book's page, and the heading says whose: the
 * per-book estimate is on the Books row and in the Dials panel.
 */
export function AccountMarginPanel(): React.ReactElement {
  const { data, error } = usePoll<AccountMarginResponse>(() => api.accountMargin(), ACCOUNT_MARGIN_POLL_MS)
  const accounts = accountsOf(data)
  const rate = rateOf(data?.inrPerUsd)
  const [open, setOpen] = useStoredOpen(MARGIN_OPEN_KEY)
  const tone = TONE_PAINT[marginTone(accounts ?? [])]
  return (
    <Card padding={3}>
      <Collapsible
        isOpen={open}
        onOpenChange={setOpen}
        trigger={
          <HStack gap={3} align="center" wrap="wrap">
            <Heading level={3}>Margin</Heading>
            <Badge variant={tone.variant} label={tone.label} />
            {/* SHUT, IT STILL SAYS THE NUMBERS THAT MATTER: used and free per account. */}
            {(accounts ?? []).map((a) => (
              <Text key={a.id} size="sm" color="secondary">{teaserOf(a)}</Text>
            ))}
          </HStack>
        }
      >
        <VStack gap={2}>
          <Text size="sm" color="secondary">{`Delta accounts · USD, ₹ at ${rate}`}</Text>
          {error !== null ? (
            <Text size="sm" color="secondary">{`Cannot read account margin: ${error}`}</Text>
          ) : null}
          {data === null && error === null ? <Text size="sm" color="secondary">reading…</Text> : null}
          {data !== null && accounts === null ? (
            <Text size="sm" color="secondary">No accounts in the reply — the api may be a deploy behind.</Text>
          ) : null}
          {(accounts ?? []).map((a) => <AccountBlock key={a.id} account={a} rate={rate} />)}
        </VStack>
      </Collapsible>
    </Card>
  )
}

/** Where the panel's open/shut choice is remembered, per browser. */
export const MARGIN_OPEN_KEY = 'dx.marginPanel.open'

/** The one-line account summary the SHUT panel shows: `Live 7.9% used · $574.24 free`. */
export function teaserOf(a: AccountMargin): string {
  if (!hasFigures(a)) return `${a.label} · ${ACCOUNT_PAINT[a.state]?.label ?? a.state}`
  const free = typeof a.available === 'number' && Number.isFinite(a.available) ? cash(a.available, DX) : '—'
  return `${a.label} ${pct(a.utilizedPct)} used · ${free} free${a.state === 'stale' ? ' (stale)' : ''}`
}

/** Shut by default; the operator's last choice wins. Storage can be blocked — then it lasts the visit. */
function useStoredOpen(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const setOpen = (next: boolean): void => {
    setOpenState(next)
    try {
      window.localStorage.setItem(key, next ? '1' : '0')
    } catch {
      // A private window: the choice lasts the visit.
    }
  }
  return [open, setOpen]
}

// ------------------------------------------------------------ Status card

/** One compact line per account. */
function statusLine(a: AccountMargin, rate: number): string {
  if (!hasFigures(a)) return `${a.label} · ${whyNoFigures(a)}`
  const age = a.state === 'stale' ? ` · stale, ${ago(a.ageMs)}` : ''
  return `${a.label} · ${pct(a.utilizedPct)} used · ${usdWithInr(a.used, rate)} of ${usdWithInr(a.balance, rate)}` +
    ` · ${usdWithInr(a.available, rate)} free${age}`
}

/** The Status page's Margin card, shaped like its component cards. */
export function MarginStatusCard(): React.ReactElement {
  const { data, error } = usePoll<AccountMarginResponse>(() => api.accountMargin(), ACCOUNT_MARGIN_POLL_MS)
  const accounts = accountsOf(data) ?? []
  const rate = rateOf(data?.inrPerUsd)
  const paint = TONE_PAINT[marginTone(accounts)]
  return (
    <Card padding={3} role="group" aria-label="Margin status">
      <VStack gap={1}>
        <HStack justify="between" align="center" wrap="wrap" gap={2}>
          <Text weight="bold">Margin</Text>
          <Badge variant={paint.variant} label={paint.label} />
        </HStack>
        <Text size="sm" color="secondary">Delta accounts, USD</Text>
        {accounts.map((a) => <Text key={a.id} size="sm">{statusLine(a, rate)}</Text>)}
        {error !== null ? <Text size="sm" color="secondary">{`Cannot read account margin: ${error}`}</Text> : null}
        {data === null && error === null ? <Text size="sm" color="secondary">reading…</Text> : null}
        {data !== null && accountsOf(data) === null ? (
          <Text size="sm" color="secondary">No accounts in the reply.</Text>
        ) : null}
      </VStack>
    </Card>
  )
}

// ----------------------------------------------------- BULL-S estimates

/** The estimate for one book on one rail, or undefined. */
export function estimateFor(
  data: BookMarginEstimatesResponse | null,
  tag: string,
  mode: DeskMode,
): BookMarginEstimate | undefined {
  if (data === null || !Array.isArray(data.books)) return undefined
  return data.books.find((b) => b.tag === tag && b.mode === mode)
}

const missingText = (missing: readonly string[]): string =>
  missing.length === 0 ? 'not estimable' : `not estimable: ${missing.join('; ')}`

function usdTitle(usd: number, rate: number): string {
  return `${cash(usd, DX)} ≈ ${inrAt(usd, rate)} at ₹${rate}/$`
}

/** A piece of text with a hover title. astryx omits `title`, so a span carries it. */
function Titled(props: { text: string; title: string }): React.ReactElement {
  return (
    <span title={props.title}>
      <Text size="sm" color="secondary">{props.text}</Text>
    </span>
  )
}

function capPart(e: BookMarginEstimate, rate: number): { text: string; title: string } {
  const w = e.worstAtCap
  if (w.unbounded) {
    return { text: 'cap unbounded (bs_max_open 0)', title: 'No bs_max_open, so no worst case: every level may add a straddle.' }
  }
  if (w.usd === null) return { text: 'cap —', title: missingText(w.missing) }
  const at = w.atmStrike === null ? '' : ` at ATM ${w.atmStrike}`
  const sizes = w.sizes.length === 0 ? '' : `, sizes ${w.sizes.join(' · ')}`
  return { text: `cap ${cash(w.usd, DX)}`, title: `Worst case at cap${at}${sizes}: ${usdTitle(w.usd, rate)}` }
}

/**
 * THE BOOKS-ROW LINE: `est $12.40 · cap $96.20 / budget $150.00`, ₹ on hover.
 * Budget only when set (0 = off). Nothing at all while there is no estimate.
 */
export function BookMarginLine(props: { estimate: BookMarginEstimate | undefined; rate?: number }): React.ReactElement | null {
  const e = props.estimate
  if (e === undefined) return null
  const rate = rateOf(props.rate)
  const cur = e.current.usd === null
    ? { text: 'est —', title: missingText(e.current.missing) }
    : {
        text: `est ${cash(e.current.usd, DX)}`,
        title: `Estimated margin now, ${e.current.shortLegs} short leg(s): ${usdTitle(e.current.usd, rate)}`,
      }
  const cap = capPart(e, rate)
  return (
    <HStack gap={1} align="center" wrap="wrap" aria-label="margin estimate">
      <Titled text={cur.text} title={cur.title} />
      <Text size="sm" color="secondary">·</Text>
      <Titled text={cap.text} title={cap.title} />
      {e.budget > 0 ? (
        <Titled text={`/ budget ${cash(e.budget, DX)}`} title={`bs_margin_budget: ${usdTitle(e.budget, rate)}`} />
      ) : null}
    </HStack>
  )
}

/** The estimates read, for a page that shows BULL-S books. Idle when `enabled` is false. */
export function useBookMarginEstimates(enabled: boolean): {
  data: BookMarginEstimatesResponse | null
  error: string | null
} {
  const { data, error } = usePoll<BookMarginEstimatesResponse | null>(
    () => (enabled ? api.bookMarginEstimates() : Promise.resolve(null)),
    BOOK_MARGIN_POLL_MS,
    [enabled],
  )
  return { data: enabled ? data : null, error: enabled ? error : null }
}

/**
 * THE DIALS-PANEL LINE: the open book's estimate now and at its cap, in full,
 * so `bs_margin_budget` is set against the numbers it is compared with.
 */
export function DialsMarginEstimate(props: { tag: string; mode: DeskMode }): React.ReactElement {
  const { data, error } = useBookMarginEstimates(true)
  const e = estimateFor(data, props.tag, props.mode)
  let body: string
  if (e === undefined) {
    body = error !== null
      ? `Margin estimate unavailable: ${error}`
      : data === null ? 'Margin estimate: reading…' : 'Margin estimate: none for this book yet.'
  } else {
    const rate = DX.inrPerUnit
    const now = e.current.usd === null ? `— (${missingText(e.current.missing)})` : usdWithInr(e.current.usd, rate)
    const w = e.worstAtCap
    const cap = w.unbounded
      ? 'unbounded (bs_max_open 0)'
      : w.usd === null
        ? `— (${missingText(w.missing)})`
        : `${usdWithInr(w.usd, rate)}${w.atmStrike === null ? '' : ` at ATM ${w.atmStrike}`}` +
          `${w.sizes.length === 0 ? '' : `, sizes ${w.sizes.join(' · ')}`}`
    const budget = e.budget > 0 ? ` · budget ${usdWithInr(e.budget, rate)}` : ' · budget off'
    body = `Margin estimate: now ${now} · worst at cap ${cap}${budget}`
  }
  return (
    <VStack gap={0} aria-label="dials margin estimate">
      <Text size="sm" color="secondary">{body}</Text>
    </VStack>
  )
}
