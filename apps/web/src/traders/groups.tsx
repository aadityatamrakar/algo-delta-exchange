/**
 * Groups (spec item 27): name some of a book's open legs ("hedge", "Oct
 * straddle") and read each group's own totals and payoff. A group only labels
 * legs; an empty name leaves a leg in the book's "ungrouped" remainder.
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { BellAlert } from './bell.tsx'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { PayoffCurves } from '../payoff-curves.tsx'
import { money, sign, signed } from '../format.ts'
import type { GroupsView, GroupView, LegGroup } from '../../../traders/src/analytics/r3-wire.ts'
import type { BookView, LegView } from '../../../traders/src/types.ts'
import { tapi } from './api.ts'
import { useDocumentVisible, useOnLegsChange, usePoll } from './hooks.ts'
import { LEG_PNL_TITLE } from './series-lines.ts'
import { legName, maturityLabel } from './wire.ts'
import { TradersTable, type TradersColumn } from './table.tsx'

const GROUPS_POLL_MS = 60_000
const UNGROUPED = 'ungrouped'

/** leg key → group name, from what the server holds. */
function assignment(v: GroupsView): Record<string, string> {
  const out: Record<string, string> = {}
  for (const g of v.groups) for (const k of g.keys) out[k] = g.name
  return out
}

/** The groups a draft names, in first-seen order; untagged and "ungrouped" legs belong to none. */
export function groupsOf(legs: readonly Pick<LegView, 'key'>[], draft: Readonly<Record<string, string>>): LegGroup[] {
  const byName = new Map<string, string[]>()
  for (const l of legs) {
    const name = (draft[l.key] ?? '').trim()
    if (name === '' || name.toLowerCase() === UNGROUPED) continue
    const keys = byName.get(name)
    if (keys === undefined) byName.set(name, [l.key])
    else keys.push(l.key)
  }
  return [...byName].map(([name, keys]) => ({ name, keys }))
}

type Row = LegView & Record<string, unknown>

function GroupCard(props: { group: GroupView; view: BookView; title: string }): ReactElement {
  const { group, view } = props
  const t = group.totals
  const firstExpiry = view.legs.filter((l) => group.keys.includes(l.key)).map((l) => l.expiry).filter((e) => e !== '').sort()[0] ?? ''
  const firstForward = Object.values(view.forwards).find((f): f is number => typeof f === 'number') ?? null
  const cell = (label: string, text: string, n: number, title?: string): ReactElement => (
    <VStack gap={0} key={label}>
      <Text color="secondary" size="sm" {...(title === undefined ? {} : { title })}>{label}</Text>
      <Text weight="bold" {...(sign(n) === undefined ? {} : { style: sign(n) })}>{text}</Text>
    </VStack>
  )
  return (
    <Card>
      <VStack gap={2} padding={3}>
        <HStack gap={3} align="center" wrap="wrap">
          <Heading level={4}>{props.title}</Heading>
          <Text color="secondary" size="sm">{`${group.legCount} ${group.legCount === 1 ? 'leg' : 'legs'}`}</Text>
        </HStack>
        <HStack gap={5} wrap="wrap" aria-label={`${props.title} totals`}>
          {cell('Δ', signed(t.delta, 2), t.delta)}
          {cell('Γ', signed(t.gamma, 4), t.gamma)}
          {cell('Vega', signed(t.vega, 2), t.vega)}
          {cell('Θ', signed(t.theta, 2), t.theta)}
          {cell('Leg P&L', money(t.mtm), t.mtm, LEG_PNL_TITLE)}
        </HStack>
        {group.payoff === null ? null : (
          <PayoffCurves view={group.payoff} markAt={view.spot ?? firstForward} markLabel="spot" expiryDate={firstExpiry} overlay={null} />
        )}
      </VStack>
    </Card>
  )
}

export function GroupsTab(props: { stock: string; view: BookView }): ReactElement {
  const { stock, view } = props
  const visible = useDocumentVisible()
  const groups = usePoll(() => tapi.groups(stock), GROUPS_POLL_MS, [stock], visible)
  // A group's totals are its legs': a new upload inside the minute is read at once.
  useOnLegsChange(view.legs, groups.reload)
  // What the last save answered: shown until the next poll brings a newer read.
  const [saved, setSaved] = useState<GroupsView | null>(null)
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setSaved(null) }, [groups.data, stock])
  const v = saved ?? groups.data

  if (v === null) {
    return groups.error === null
      ? <Text color="secondary">{`Loading ${stock} groups…`}</Text>
      : <Banner status="error" title={`Could not load the groups: ${groups.error}`} />
  }
  const current = draft ?? assignment(v)
  const dirty = draft !== null

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      setSaved(await tapi.putGroups(stock, groupsOf(view.legs, current)))
      setDraft(null)
      groups.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // the Group column is a text input: sorting by what is being typed would move the row under the cursor
  const columns: TradersColumn<Row>[] = [
    { key: 'leg', header: 'Leg', sortValue: (r) => legName(stock, r as LegView), renderCell: (r) => <Text size="sm">{legName(stock, r as LegView)}</Text> },
    { key: 'expiry', header: 'Expiry', sortValue: (r) => (r as LegView).expiry, renderCell: (r) => <Text size="sm">{maturityLabel((r as LegView).expiry)}</Text> },
    { key: 'qty', header: 'Qty', align: 'end', sortValue: (r) => (r as LegView).qty, renderCell: (r) => <Text size="sm">{signed((r as LegView).qty)}</Text> },
    {
      key: 'group', header: 'Group',
      renderCell: (r) => {
        const key = (r as LegView).key
        return (
          <TextInput
            label={`Group for ${legName(stock, r as LegView)}`} isLabelHidden size="sm" width={180} placeholder={UNGROUPED} value={current[key] ?? ''}
            onChange={(s) => setDraft({ ...current, [key]: s })}
          />
        )
      },
    },
  ]

  return (
    <VStack gap={3}>
      <BellAlert text={groups.error === null ? null : `Refresh failed: ${groups.error}`} />
      {error === null ? null : <Banner status="error" title={error} />}
      {view.legs.length === 0 ? <Text color="secondary">No open legs to group.</Text> : (
        <TradersTable aria-label="Legs by group" data={view.legs as unknown as Row[]} columns={columns} idKey="key" density="compact" />
      )}
      <HStack gap={2} align="center">
        <Button variant="primary" label="Save" isDisabled={!dirty || saving} onClick={() => void save()} />
        {dirty ? <Button variant="secondary" label="Discard" isDisabled={saving} onClick={() => setDraft(null)} /> : null}
      </HStack>
      {v.groups.map((g) => <GroupCard key={g.name} group={g} view={view} title={g.name} />)}
      {v.ungrouped.legCount === 0 ? null : <GroupCard group={v.ungrouped} view={view} title="Ungrouped" />}
    </VStack>
  )
}
