/**
 * WHERE A PAPER BOOK'S ORDERS GO: the simulator, or Delta's testnet.
 *
 * `Sim` is the gateway's own simulator, filling at the touch of the real
 * book. `Demo` sends the same orders to Delta's demo exchange, signed with the
 * Delta Demo (testnet) credentials from the Brokers card — real matching, no
 * real money. Either way the fills are booked as PAPER.
 *
 * CONFIRMED, because the switch changes which exchange the book's NEXT order
 * reaches. The server refuses it (409) while the book holds legs or has a
 * decision working — a close sent to the other rail would book a position
 * that rail never held — and that refusal is shown as the server wrote it.
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

/** The confirmation's sentence. Exported so its promises are pinned by a test. */
export function railSwitchStatement(tag: string, to: PaperRail): string {
  const where =
    to === 'demo'
      ? "Delta's testnet (demo exchange), signed with the Delta Demo (testnet) credentials on the Brokers card"
      : "the desk's simulator, which fills at the touch of the real book"
  return (
    `From ${tag}'s next order on, its paper orders go to ${where}. Orders already working stay where ` +
    'they are. The switch is refused while the book holds legs or has a decision working — flatten it first.'
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
