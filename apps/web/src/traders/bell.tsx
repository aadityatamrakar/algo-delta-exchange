/**
 * The bell at the top right: every page's warning lists and live-state alerts in one place, so no page carries a
 * banner above its content.
 *
 * Pages do not wire it up. `Caveats kind="warning"` (caveats.tsx) and `BellAlert` report to the nearest bell
 * (bell-store.tsx) and draw nothing themselves; with no bell above them (a page rendered on its own) they draw
 * inline, as before. `BellSource` names where a report comes from, and the panel groups by that name.
 *
 * Warnings keep their per-day dismissal (caveats.tsx): a dismissed line is not counted. Alerts — a failed refresh, a
 * page that could not load — are not dismissible: they go when the state does. A dead price feed turns the bell red
 * and shows a "Feed dead" pill beside it, as a failed refresh shows "Refresh failed"; a closed market shows a quiet
 * "Market closed".
 */

import { useEffect, useRef } from 'react'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { useBellEntries, useBellReport, type BellEntry } from './bell-store.tsx'
import { DismissButton, ShowHidden, useDismissed, useShownFilter } from './caveats.tsx'

/** A server line about the price feed being dead in session: the bell goes red for it. */
const FEED_DEAD = /feed is dead|is not ticking/i
export const isFeedDead = (line: string): boolean => FEED_DEAD.test(line)

/**
 * A page's live-state line (`Refresh failed: …`, `Could not load …`): to the bell when there is one, else the inline
 * banner it always was. `inline` keeps the banner on the page as well — for a page that has nothing else to show.
 */
export function BellAlert(props: { text: string | null; status?: 'warning' | 'error'; inline?: boolean }): React.ReactElement | null {
  const collected = useBellReport(props.text === null ? null : { alerts: [props.text] })
  if (props.text === null || (collected && props.inline !== true)) return null
  return <Banner status={props.status ?? 'warning'} title={props.text} />
}

interface Group { readonly source: string; readonly items: readonly string[]; readonly alerts: readonly string[] }

function groupsOf(entries: Iterable<BellEntry>): Group[] {
  const by = new Map<string, { items: string[]; alerts: string[] }>()
  for (const e of entries) {
    const g = by.get(e.source) ?? { items: [], alerts: [] }
    for (const t of e.items) if (!g.items.includes(t)) g.items.push(t)
    for (const t of e.alerts) if (!g.alerts.includes(t)) g.alerts.push(t)
    by.set(e.source, g)
  }
  return [...by].filter(([, g]) => g.items.length + g.alerts.length > 0).map(([source, g]) => ({ source, ...g }))
}

function BellGroup(props: { group: Group }): React.ReactElement {
  const { group } = props
  const d = useDismissed(group.items)
  const name = group.source === '' ? 'This page' : group.source
  return (
    <VStack gap={1} role="group" aria-label={name}>
      <Text size="sm" weight="bold">{name}</Text>
      {group.alerts.map((t) => <Text key={`a:${t}`} size="sm" className="traders-bell-alert">{t}</Text>)}
      {d.shown.map((t) => (
        <HStack key={`w:${t}`} gap={1} align="center" justify="between">
          <Text size="sm" {...(isFeedDead(t) ? { className: 'traders-bell-alert' } : {})}>{t}</Text>
          <DismissButton onClick={() => d.dismiss(t)} />
        </HStack>
      ))}
      <ShowHidden hidden={d.hidden} onClick={d.restore} />
    </VStack>
  )
}

const BellIcon = (): React.ReactElement => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
)

/** The bell, its count, its pill and its panel. `open` is the shell's, so Esc and the shortcut layer can close it. */
export function Bell(props: { open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement {
  const { open, onOpenChange } = props
  const entries = useBellEntries()
  const shownOf = useShownFilter()
  const groups = groupsOf(entries.values())
  const alerts = groups.flatMap((g) => g.alerts)
  const shown = groups.flatMap((g) => shownOf(g.items))
  const count = alerts.length + shown.length
  const feedDead = groups.some((g) => g.items.some(isFeedDead))
  const red = alerts.length > 0 || shown.some(isFeedDead)
  const closed = [...entries.values()].some((e) => e.closed)
  const pill = feedDead ? <Badge variant="error" label="Feed dead" />
    : alerts.length > 0 ? <Badge variant="error" label="Refresh failed" />
    : closed ? <Badge variant="neutral" label="Market closed" />
    : null

  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, onOpenChange])

  return (
    <div ref={root} className="traders-bell" data-state={red ? 'alert' : count > 0 ? 'some' : 'none'}>
      {pill}
      <span className="traders-bell-button">
        <Button
          variant="ghost"
          isIconOnly
          icon={<BellIcon />}
          label={count === 0 ? 'Alerts' : `Alerts: ${count}`}
          tooltip="Alerts and warnings"
          aria-expanded={open}
          aria-controls="traders-bell-panel"
          onClick={() => onOpenChange(!open)}
        />
        {count === 0 ? null : <span className="traders-bell-count" aria-hidden="true">{count}</span>}
      </span>
      {open ? (
        <div id="traders-bell-panel" role="dialog" aria-label="Alerts and warnings" className="traders-bell-panel">
          <VStack gap={3}>
            {groups.length === 0
              ? <Text size="sm" color="secondary">Nothing to report</Text>
              : groups.map((g) => <BellGroup key={g.source} group={g} />)}
          </VStack>
        </div>
      ) : null}
    </div>
  )
}
