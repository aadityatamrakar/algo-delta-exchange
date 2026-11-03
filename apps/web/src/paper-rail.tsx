/**
 * WHERE A PAPER BOOK'S ORDERS GO (operator ruling, 3 Nov: PAPER → Delta demo).
 *
 * The SETTING: `Demo` (the default) sends the book's orders to Delta's demo
 * exchange whenever a Delta Demo (testnet) key is stored and has passed Test —
 * real matching, no real money — and to the simulator otherwise. `Sim` forces
 * this one book onto the simulator. Either way fills are booked as PAPER.
 *
 * WHAT HAPPENED is shown beside it: the rail the gateway used for the book's
 * last order and why (`dx_rail_used`/`dx_rail_note`), because with no verified
 * key a `Demo` book trades on the simulator, and that must not be a surprise.
 *
 * CONFIRMED, because the switch changes which exchange the book's NEXT order
 * reaches. A book holding legs keeps them where they were opened until flat.
 *
 * Paper rows only: a live book's orders go to Delta proper and nothing here
 * can change that.
 */
import { useState } from 'react'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { api, explain, paperRailOf, type BookRow, type PaperRail } from './api.ts'

export const RAIL_LABEL: Record<PaperRail, string> = { sim: 'Sim', demo: 'Demo' }

/** Where the last order went, in words; null before the book's first order. */
export function railUsedText(row: Pick<BookRow, 'dx_rail_used' | 'dx_rail_note'>): string | null {
  const used = row.dx_rail_used
  if (used !== 'demo' && used !== 'sim') return null
  const where = used === 'demo' ? 'Delta testnet' : 'simulator'
  const note = (row.dx_rail_note ?? '').trim()
  return note === '' ? `last order: ${where}` : `last order: ${note}`
}

/** The Books row's badge for where a PAPER book's last order went; null for live or before any order. */
export function railUsedBadge(
  row: Pick<BookRow, 'mode' | 'dx_rail_used'>,
): { readonly label: string; readonly variant: 'warning' | 'neutral' } | null {
  if (row.mode !== 'paper') return null
  if (row.dx_rail_used === 'demo') return { label: 'Demo (testnet)', variant: 'warning' }
  if (row.dx_rail_used === 'sim') return { label: 'Sim', variant: 'neutral' }
  return null
}

/** The confirmation's sentence. Exported so its promises are pinned by a test. */
export function railSwitchStatement(tag: string, to: PaperRail): string {
  const where =
    to === 'demo'
      ? "Delta's testnet (demo exchange) whenever the Delta Demo (testnet) key on the Brokers card has passed " +
        'Test, and the simulator when it has not'
      : "the desk's simulator, whatever keys are stored"
  return (
    `From ${tag}'s next order on, its paper orders go to ${where}. Orders already working stay where they are, ` +
    'and legs the book already holds stay on the rail they were opened on until it is flat.'
  )
}

export function PaperRailControl(props: {
  row: BookRow
  /** Called with the updated row after a successful switch. */
  onSwitched: (row: BookRow) => void
}): React.ReactElement | null {
  const { row } = props
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  if (row.mode !== 'paper') return null

  const current = paperRailOf(row)
  const target: PaperRail = current === 'demo' ? 'sim' : 'demo'

  const doSwitch = async (): Promise<void> => {
    setAsking(false)
    setBusy(true)
    setNote(null)
    try {
      const updated = await api.bookRegistry.setPaperRail(row.tag, target)
      setNote({ ok: true, text: `rail is now ${RAIL_LABEL[paperRailOf(updated)]} — from the book's next order` })
      props.onSwitched(updated)
    } catch (err) {
      setNote({ ok: false, text: explain(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack gap={1}>
      <HStack gap={2} align="center" wrap="wrap">
        <Text size="sm" color="secondary">Paper rail</Text>
        <Badge variant={current === 'demo' ? 'warning' : 'neutral'} label={RAIL_LABEL[current]} />
        {railUsedText(row) !== null ? <Text size="sm" color="secondary">{railUsedText(row)}</Text> : null}
        <Button
          variant="ghost"
          size="sm"
          label={`Switch to ${RAIL_LABEL[target]}`}
          isLoading={busy}
          isDisabled={busy}
          onClick={() => { setNote(null); setAsking(true) }}
        />
      </HStack>
      {note !== null ? (
        <Banner
          status={note.ok ? 'success' : 'error'}
          title={note.ok ? 'Rail switched' : 'Rail not switched'}
          description={note.text}
        />
      ) : null}
      <AlertDialog
        isOpen={asking}
        onOpenChange={() => setAsking(false)}
        title={`Switch ${row.tag} to ${RAIL_LABEL[target]}?`}
        description={railSwitchStatement(row.tag, target)}
        actionLabel={`Switch to ${RAIL_LABEL[target]}`}
        actionVariant="primary"
        onAction={() => void doSwitch()}
      />
    </VStack>
  )
}
