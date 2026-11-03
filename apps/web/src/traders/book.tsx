/**
 * One underlying's book: its title line (name, history ⓘ, band, the summary figures), the warnings (to the bell),
 * and the sub-tabs. The first, Analysis, is the book itself — legs, payoff and VolHedge's figures in one view
 * (analysis-tab.tsx). Later releases append to `BOOK_SUBTABS` and `BOOK_HEADER_CHIPS` rather than edit this component.
 */

import { useEffect, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import type { BookView } from '../../../traders/src/types.ts'
import { tapi } from './api.ts'
import { usePoll } from './hooks.ts'
import { AdviceTab, BandChip } from './advice.tsx'
import { AnalysisTab } from './analysis-tab.tsx'
import { GroupsTab } from './groups.tsx'
import { useTradersRoute } from './route.ts'
import { ScenarioTab } from './scenario-tab.tsx'
import { Caveats } from './caveats.tsx'
import { BellAlert } from './bell.tsx'
import { BellSource, useBellReport } from './bell-store.tsx'
import { BookStrip } from './book-strip.tsx'
import { LivePill, useLiveBook } from './live.tsx'
import { InfoTip } from './fold.tsx'
import { ResultsBadge } from './results-badge.tsx'

const BOOK_POLL_MS = 15_000

export interface BookSubTab {
  readonly id: string
  readonly label: string
  render(p: { stock: string; view: BookView; reload(): void }): React.ReactElement
}

/** The book's sub-tabs, in order. An id is also the hash's third segment. */
export const BOOK_SUBTABS: readonly BookSubTab[] = [
  { id: 'analysis', label: 'Analysis', render: ({ stock, view, reload }) => <AnalysisTab stock={stock} view={view} reload={reload} /> },
  { id: 'scenario', label: 'Scenario', render: ({ stock }) => <ScenarioTab stock={stock} /> },
  { id: 'groups', label: 'Groups', render: ({ stock, view }) => <GroupsTab stock={stock} view={view} /> },
  { id: 'advice', label: 'Advice', render: ({ stock, view }) => <AdviceTab stock={stock} view={view} /> },
]

/** Old hash segments that now land elsewhere: Legs & payoff became part of Analysis. */
const ALIASES: Readonly<Record<string, string>> = { legs: 'analysis' }

const subTabOf = (id: string | null): string | null => {
  const named = id === null ? null : ALIASES[id] ?? id
  return named !== null && BOOK_SUBTABS.some((s) => s.id === named) ? named : null
}

/** Small chips beside the book's name (R3's band chip lands here). */
export const BOOK_HEADER_CHIPS: readonly ((p: { stock: string; view: BookView }) => React.ReactElement | null)[] = [
  (p) => <BandChip stock={p.stock} view={p.view} />,
  (p) => <ResultsBadge stock={p.stock} />,
]

export function BookTab(props: { stock: string }): React.ReactElement {
  const { stock } = props
  const book = usePoll(() => tapi.book(stock), BOOK_POLL_MS, [stock])
  // `#/books/TCS/scenario` names the sub-tab (openWhatIf's seam); a click writes it back, so the hash
  // always changes when another sub-tab is asked for. A bare `#/books/TCS` (the first visit, or Back to
  // it) is the first sub-tab. `named` is undefined while the hash is not about this book at all.
  const [route, go] = useTradersRoute()
  const first = BOOK_SUBTABS[0]?.id ?? ''
  const named = route.page === 'books' && route.stock === stock ? subTabOf(route.sub) : undefined
  const [subId, setSubId] = useState<string>(() => named ?? first)
  useEffect(() => { if (named !== undefined) setSubId(named ?? first) }, [named, first])
  const pick = (id: string): void => {
    setSubId(id)
    go(`/books/${encodeURIComponent(stock)}/${id}`)
  }
  const view = book.data
  useBellReport(view === null ? null : { closed: view.closed })
  const live = useLiveBook(stock)

  if (view === null) {
    return book.error === null
      ? <Text color="secondary">{`Loading ${stock}…`}</Text>
      : <BellAlert status="error" inline text={`Could not load ${stock}: ${book.error}`} />
  }
  const sub = BOOK_SUBTABS.find((s) => s.id === subId) ?? BOOK_SUBTABS[0]

  return (
    <VStack gap={1}>
      {/* One slim line: the name, its history ⓘ, the band, then the figures a trader acts on. */}
      <HStack gap={3} align="center" wrap="wrap" className="traders-title-line">
        <Heading level={3}>{view.stock}</Heading>
        <InfoTip label="this book's history">
          {view.historyFrom === null
            ? 'No ODIN trade files yet'
            : `Trade history starts ${view.historyFrom}; positions opened before it, and shares delivered at expiry, must be added by hand.`}
        </InfoTip>
        <LivePill status={live.status} />
        {BOOK_HEADER_CHIPS.map((chip, i) => {
          const el = chip({ stock, view })
          return el === null ? null : <span key={i}>{el}</span>
        })}
        <BookStrip stock={stock} view={view} />
      </HStack>
      <BellAlert text={book.error === null ? null : `Refresh failed: ${book.error}`} />
      <Caveats items={view.warnings} kind="warning" />
      <TabList value={sub?.id ?? ''} onChange={pick} layout="hug" size="sm" hasDivider>
        {BOOK_SUBTABS.map((s) => <Tab key={s.id} value={s.id} label={s.label} />)}
      </TabList>
      {sub === undefined ? null : <BellSource label={sub.label}>{sub.render({ stock, view, reload: book.reload })}</BellSource>}
    </VStack>
  )
}
