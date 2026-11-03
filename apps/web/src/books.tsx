/**
 * The Books page (#/books) — the positional sibling of #/strategies.
 *
 * `#/strategies` manages hosted/external strategies; this manages POSITIONAL
 * BOOKS — one row per `desk-books-registry` entry, each a Python supervisor
 * running one variant against one symbol/expiry. Lifecycle lives here
 * (start, stop, delete); the per-book leg detail lives at `#/positions/<tag>`,
 * exactly as a strategy's switch lives here and its P&L lives on its own page.
 *
 * CREATION IS ONE BUTTON TO `#/build`. This page used to open a wizard dialog
 * that registered a book from typed-in strikes; the Build page does it against
 * a live chain and registers what it actually got, so it is the same door done
 * properly rather than a second one. The wizard has since been deleted.
 * `#/build` has no header tab — this button is how it is reached.
 *
 * THE DESIRED/ACTUAL GAP IS THE MOST IMPORTANT CELL ON THIS PAGE. `desired` is
 * the operator's ask; `actual` is what the supervisor last reported of itself,
 * and they can disagree — a supervisor that is down, crashed, or still winding
 * up after a stop. "Asked to run, not running" is the state an operator must
 * never have to infer from a lone `actual` badge, so the two are rendered
 * together and the gap gets its own visual state (`StateCell`).
 *
 * STALLED is a SEPARATE alarm from the gap. A book can be `desired: running,
 * actual: running` and still be silently dead if its supervisor stopped
 * polling without ever reporting `actual: stopped` — `lastMarkAt` is the only
 * thing that catches that. It only fires DURING A SESSION (`inSession`):
 * outside market hours a stale mark is simply how a paused feed looks, and an
 * alarm that fires every night teaches an operator to ignore alarms.
 *
 * THE EXPIRY ALARM never goes silent either: a book still carrying legs past
 * its own `expiry` is holding an obligation that should already be gone, and
 * that is worth a named badge on the row rather than folding into the
 * everyday P&L or delta numbers.
 *
 * NET DELTA AND P&L READ FROM THE EXISTING AGGREGATE ENDPOINTS
 * (`api.books`, `api.pnl`) rather than one `api.positions(tag, mode)` call per
 * row. Both already compute the same greeks the registry list would otherwise
 * require N extra requests to get, and a book with no declared legs yet
 * (registered but never seeded) simply has no entry in either — rendered as
 * "not seeded" rather than a false zero.
 */

import { useEffect, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { Link } from '@astryxdesign/core/Link'
import { Table, proportional, pixel } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import {
  api, ago, explain, inSession, pastExpiry, seriesOf, signed, sign, RED,
  type BookMarginEstimate, type BookRow, type BookSummary, type DeskMode, type PnlStrategy,
} from './api.ts'
import { VENUE } from './venue.ts'
import { railUsedBadge } from './paper-rail.tsx'
import { liveStartStatement } from './live-copy.ts'
import { PHONE, goTo, usePoll, useMedia } from './shell.tsx'
import { ModeBadge } from './mode.tsx'
import { Money } from './pnl.tsx'
import { MarksFallbackBadge } from './marks-source.tsx'
import { useReauth, withReauth } from './auth.tsx'
import { bullsPatch, bullsStatement, isBullS, type BullSAction } from './bulls.ts'
import { ManualOrderDialog } from './manual-order.tsx'
import { DialsPanel } from './dials-panel.tsx'
import { BookMarginLine, estimateFor, useBookMarginEstimates } from './margin.tsx'

/** A book that has not reported a mark for longer than this, during a
 *  session, is STALLED — see the module comment. */
const STALL_MS = 10 * 60_000

/**
 * A book claiming to run but silent for too long, during a session.
 *
 * `inSession` lives in `api.ts` beside the other IST helpers because the
 * Strategies page needs the same answer — outside a session a stale mark here
 * and a table of `waiting` strategies there are both simply "the market is
 * shut", and two copies of that rule would eventually disagree.
 */
function isStalled(row: BookRow, nowMs: number): boolean {
  return row.actual === 'running' && inSession(nowMs) &&
    (row.lastMarkAt === 0 || nowMs - row.lastMarkAt > STALL_MS)
}

/**
 * Still holding legs after its own expiry INSTANT (15:30 IST on NSE, 12:00 UTC
 * on DX). `legs` comes from `api.books`.
 */
function isPastExpiry(row: BookRow, legs: number | undefined): boolean {
  return (legs ?? 0) > 0 && pastExpiry(row.expiry)
}

/**
 * CLOSE BOOK and RE-ARM, on a BULL-S book only. Each opens the page's one
 * confirmation; nothing is sent from here. See `bulls.ts`.
 */
function BullSButtons(props: {
  row: BookRow
  busy: boolean
  onAsk: (action: BullSAction) => void
}): React.ReactElement | null {
  if (!isBullS(props.row)) return null
  return (
    <>
      <Button
        variant="ghost" size="sm" label="Close book"
        isDisabled={props.busy} onClick={() => props.onAsk('close')}
      />
      <Button
        variant="ghost" size="sm" label="Re-arm"
        isDisabled={props.busy} onClick={() => props.onAsk('rearm')}
      />
    </>
  )
}

// ------------------------------------------------------------------ cells

/**
 * THE GAP, RENDERED AS ITS OWN STATE — never `actual` alone.
 *
 * When `desired === actual` there is nothing to explain: a plain badge says
 * the (agreed) state. When they diverge, the mismatch itself is the headline,
 * with both values named underneath so the operator can tell which side is
 * the stale one.
 */
export function StateCell(props: { row: BookRow }): React.ReactElement {
  const { desired, actual } = props.row
  if (desired === actual) {
    /**
     * A RUNNING SUPERVISOR ON A SATURDAY IS NOT A WORKING DESK.
     *
     * The supervisor really is up — worth showing, and hiding it would lose the
     * desired/actual gap with it — but a green badge beside a column of dashed
     * P&L and hours-old marks reads as "everything is fine here", which is a
     * claim about a desk that cannot trade for another two days. Neutral, with
     * the reason attached.
     *
     * THE GAP BELOW IS UNTOUCHED BY THE CLOCK. A supervisor that died on Friday
     * is still dead on Saturday, and that cell must stay as loud as ever.
     */
    if (actual === 'running' && !inSession(Date.now())) {
      return <Badge variant="neutral" label="running · market closed" />
    }
    return <Badge variant={actual === 'running' ? 'success' : 'neutral'} label={actual} />
  }
  const label = desired === 'running' ? 'asked to run, not running' : 'asked to stop, still running'
  return (
    <VStack gap={1}>
      <Badge variant="warning" label={label} />
      <Text size="sm" color="secondary">{`desired ${desired} · actual ${actual}`}</Text>
    </VStack>
  )
}

function BookCell(props: {
  row: BookRow
  legs: number | undefined
  /** A BULL-S book's margin estimate (`margin.tsx`); undefined renders nothing. */
  margin?: BookMarginEstimate | undefined
}): React.ReactElement {
  const alarm = isPastExpiry(props.row, props.legs)
  return (
    <VStack gap={0} style={{ minWidth: 0 }}>
      <Link href={`#/positions/${encodeURIComponent(props.row.tag)}`}>{props.row.tag}</Link>
      {/* The durable name the dated tag reports under (WS2). */}
      <Text size="sm" weight="medium">{seriesOf(props.row)}</Text>
      <Text size="sm" color="secondary">
        {`${props.row.symbol} · ${props.row.expiry} · ${props.row.variant}`}
      </Text>
      {/* NEVER SILENCED: a book still carrying legs past its own expiry. */}
      {alarm ? <Badge variant="error" label="carrying legs past expiry" /> : null}
      {/* WHICH RAIL this paper book's last order went to — Delta's testnet or the
          simulator — so a Demo book with no verified key is not a surprise. Set in Dials. */}
      {(() => {
        const b = VENUE.id === 'dx' ? railUsedBadge(props.row) : null
        return b === null ? null : <Badge variant={b.variant} label={b.label} />
      })()}
      {/* BULL-S only: estimated margin now, the worst case at its cap, and
          bs_margin_budget when set. "—" with what is missing, never $0. */}
      {isBullS(props.row) ? <BookMarginLine estimate={props.margin} /> : null}
    </VStack>
  )
}

function LastMarkCell(props: { row: BookRow }): React.ReactElement {
  const now = Date.now()
  if (props.row.lastMarkAt === 0) return <Text size="sm" color="secondary">never</Text>
  const stalled = isStalled(props.row, now)
  /**
   * OFF-SESSION THIS TIMESTAMP IS NOT A MARK.
   *
   * The Python supervisor keeps polling after the close and keeps writing this
   * field whether or not a tick arrived, so at 21:00 it reads "7s ago" under a
   * column headed "Last mark" — the page reporting live prices on a shut
   * exchange. It is a heartbeat out of hours, and calling it one costs nothing:
   * during a session the word disappears and the number means what the header
   * says it means.
   */
  const heartbeat = !inSession(now)
  return (
    <VStack gap={0}>
      <Text size="sm" style={stalled ? RED : undefined}>
        {heartbeat ? `heartbeat ${ago(now - props.row.lastMarkAt)}` : ago(now - props.row.lastMarkAt)}
      </Text>
      {/* A STALE DELTA MUST NOT LOOK CURRENT — this is what says so, on the row. */}
      {stalled ? <Text size="sm" weight="bold" style={RED}>STALLED — no mark in 10m+</Text> : null}
    </VStack>
  )
}

function NetDeltaCell(props: { summary: BookSummary | undefined }): React.ReactElement {
  if (props.summary === undefined) return <Text size="sm" color="secondary">not seeded</Text>
  const nd = props.summary.netDelta
  return (
    <Text weight="medium" style={nd === null ? undefined : sign(nd)}>
      {nd === null ? '—' : signed(nd)}
    </Text>
  )
}

// ------------------------------------------------------------------- table

interface BookTableRow extends Record<string, unknown> {
  row: BookRow
  summary: BookSummary | undefined
  pnl: PnlStrategy | undefined
  margin: BookMarginEstimate | undefined
}

function BookCard(props: {
  data: BookTableRow
  busy: boolean
  onStart: () => void
  onStop: () => void
  onDelete: () => void
  onOrder: () => void
  onBullS: (action: BullSAction) => void
}): React.ReactElement {
  const { row, summary, pnl, margin } = props.data
  return (
    <Card>
      <VStack gap={2} padding={3}>
        <HStack gap={2} align="start" justify="between">
          <BookCell row={row} legs={summary?.legs} margin={margin} />
          <HStack gap={1} wrap="wrap">
            {/* Same action as the table's Order button — see there. */}
            <Button variant="ghost" size="sm" label="Order" onClick={props.onOrder} />
            <BullSButtons row={row} busy={props.busy} onAsk={props.onBullS} />
            {row.desired === 'running'
              ? <Button variant="ghost" size="sm" label="Stop" isDisabled={props.busy} onClick={props.onStop} />
              : <Button variant="ghost" size="sm" label="Start" isDisabled={props.busy} onClick={props.onStart} />}
            {/* Stopped only, for the same reason as the table's — see there. */}
            {row.desired === 'running'
              ? null
              : <Button variant="ghost" size="sm" label="Delete" isDisabled={props.busy} onClick={props.onDelete} />}
          </HStack>
        </HStack>
        <StateCell row={row} />
        <HStack gap={4} wrap="wrap">
          <VStack gap={0}>
            <Text size="sm" color="secondary">Net delta</Text>
            <NetDeltaCell summary={summary} />
          </VStack>
          <VStack gap={0}>
            <Text size="sm" color="secondary">P&L</Text>
            <HStack gap={1} align="center">
              <Money value={pnl?.total ?? null} size="sm" />
              <MarksFallbackBadge fallback={pnl?.marksFallback} />
            </HStack>
          </VStack>
        </HStack>
        <LastMarkCell row={row} />
        <Text size="sm" color="secondary">
          {row.lastDecision === '' ? 'No decision recorded yet.' : row.lastDecision}
        </Text>
      </VStack>
    </Card>
  )
}

/**
 * The order the table shows the registry in: books ASKED to run first, then
 * newest first.
 *
 * The registry arrives in Mongo's natural order, which is insertion order,
 * and under the daily roll (§6 of the delta-lean runbook) that put yesterday's
 * stopped rows above today's running ones, four more every trading day. The
 * rows the operator is watching belong at the top, and among them the day's
 * new books lead; a stopped row is one the roll could not erase (see its ATTENTION block) and sits under
 * them. `desired`, not `actual`: a book asked to run that is not running is
 * the alarm this page exists to show, and it must not sink below the stopped
 * ones for being in the state it should not be in. The tag breaks a tie so
 * two rows born in the same millisecond never swap between polls.
 *
 * THEN GROUPED BY SERIES (WS2). Under the daily roll one strategy is a run of
 * dated tags — today's running NIFTY aggressive and yesterday's stopped one —
 * and they belong together. Each series sits where its best row would have
 * sorted (so a series with a running book leads), and inside it the same
 * order holds: running first, then newest.
 */
export function orderBooks(rows: readonly BookRow[]): BookRow[] {
  const rank = (row: BookRow): number => (row.desired === 'running' ? 0 : 1)
  const sorted = [...rows].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt || a.tag.localeCompare(b.tag),
  )
  const groups = new Map<string, BookRow[]>()
  for (const row of sorted) {
    const key = seriesOf(row)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [row])
    else group.push(row)
  }
  return [...groups.values()].flat()
}

export function BooksPage(props: { mode: DeskMode }): React.ReactElement {
  const phone = useMedia(PHONE)
  const { data: registry, error, refresh } = usePoll(
    () => api.bookRegistry.list(props.mode), 5000, [props.mode],
  )
  /*
    BOTH ERRORS ARE READ, and both are surfaced together below.

    These two polls are where Net delta, P&L and the book's leg count come
    from — the leg count being what the Delete dialog turns into "still holds 3
    leg(s), they will be CLOSED AT MARKET first". Destructuring `data` alone
    (which is what this did) leaves every one of those figures frozen at its
    last value with nothing on the page admitting the read failed: the exact
    "stale-looking-live" state `usePoll` keeps the last payload FOR, minus the
    label that makes it honest (audit F-50).

    NOT MOVED ONTO `useLivePnl`, which was the other option. It would give the
    P&L column the live overlay and the degraded notice for free — and would
    leave the summary poll, which owns Net delta, the leg count and the delete
    wording, exactly as undeclared as it is today. The banner covers both reads;
    a socket on this page would cover half of one.
  */
  const { data: summaryData, error: summaryError } = usePoll(
    () => api.books(props.mode), 5000, [props.mode],
  )
  const { data: pnlData, error: pnlError } = usePoll(() => api.pnl(props.mode), 8000, [props.mode])
  /*
    BULL-S MARGIN ESTIMATES, read only while a BULL-S book is on the page —
    every other book has none, and a desk without one should not pay a read
    for it. The row line renders nothing until an estimate arrives.
  */
  const { data: marginData } = useBookMarginEstimates((registry ?? []).some(isBullS))
  /*
    NO VARIANT-CATALOGUE POLL ANY MORE. This page used to read
    `GET /v1/desk/variants` for one reason: the dials box needed the variant's
    DEFAULTS to show a dial the row had not set, and only the Python
    supervisor's publication knew them. `packages/desk-engine` states the whole
    schema now and the panel resolves against it, so the page no longer depends
    on a publication that is being retired (spec §5) — and the panel no longer
    degrades to "only the dials already set on this book" when it is missing.
  */
  /** Which book's dials are open, by tag. One at a time. */
  const [dialsFor, setDialsFor] = useState<string | null>(null)
  /**
   * The row a MANUAL ORDER dialog is open for. The row carries symbol and
   * expiry, so the dialog goes straight to the chain — no pickers.
   */
  const [orderFor, setOrderFor] = useState<BookRow | null>(null)
  // The password prompt, for the one control on this page the server
  // re-authenticates: retuning a LIVE book's dials. Its `dialog` is rendered
  // once at the bottom, exactly as the Strategies page does it.
  const reauth = useReauth()

  const summaries = new Map((summaryData?.books ?? []).map((b) => [b.tag, b]))
  const pnls = new Map((pnlData?.strategies ?? []).map((s) => [s.tag, s]))
  /**
   * The summary's message first: it is the read that decides more of the page —
   * Net delta, the expiry alarm's leg count and the Delete dialog's wording —
   * so when both are failing (one bridge, one outage) it is the one worth
   * printing. The banner names the OTHER consequence separately.
   */
  const figuresError = summaryError ?? pnlError

  /**
   * The one-line outcome of the last action, and WHICH KIND it was.
   *
   * It used to be a bare string rendered unconditionally as `status="error"`
   * under "That did not run" — so a successful delete reported itself in a red
   * failure banner saying the opposite of what had happened. Every writer now
   * states the kind, because the banner cannot infer it from a sentence.
   */
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busyTag, setBusyTag] = useState<string | null>(null)
  /** The row awaiting confirmation to start in LIVE — see `liveStartStatement`. */
  const [pending, setPending] = useState<BookRow | null>(null)
  /** The row awaiting confirmation to DELETE. Irreversible, so it is asked. */
  const [deleting, setDeleting] = useState<{ row: BookRow; purge: boolean } | null>(null)
  /** A BULL-S Close book / Re-arm awaiting confirmation. */
  const [bullsAsk, setBullsAsk] = useState<{ row: BookRow; action: BullSAction } | null>(null)

  /**
   * Send a BULL-S request: the counter +1 through the dials PATCH. A LIVE book
   * asks for the password first, exactly as a live dials retune does — the
   * server gates the same endpoint the same way.
   */
  const doBullS = async (row: BookRow, action: BullSAction): Promise<void> => {
    setNote(null)
    setBusyTag(row.tag)
    await withReauth({
      statement: bullsStatement(row.tag, action),
      promptFirst: row.mode === 'live',
      run: (password) =>
        api.bookRegistry.patchDials(row.tag, row.mode, bullsPatch(row, action), password),
      reauth,
      onDone: () => {
        setNote({
          kind: 'ok',
          text: action === 'close'
            ? `${row.tag}: close requested — the book closes its legs and halts at its next decision.`
            : `${row.tag}: re-arm requested — the halt clears at its next decision.`,
        })
        refresh()
      },
      onError: (message) => setNote({ kind: 'error', text: message }),
    })
    setBusyTag(null)
  }
  /**
   * How many legs THAT book holds, from the summary already on the page.
   *
   * It decides both halves of the dialog: whether the delete may place closing
   * orders first, and whether the confirmation says so. Reading it from the
   * summary rather than fetching means the wording can never disagree with the
   * number the operator is looking at on the same row.
   */
  const deletingLegs = deleting === null ? 0 : (summaries.get(deleting.row.tag)?.legs ?? 0)

  // Messages do not survive the switch — they describe rows that may no
  // longer be the ones on screen, on the other rail.
  useEffect(() => {
    setNote(null)
    setPending(null)
    // A manual-order dialog left open across the switch would place on the
    // OTHER rail under the same title.
    setOrderFor(null)
  }, [props.mode])

  const doStart = async (row: BookRow): Promise<void> => {
    setNote(null)
    setBusyTag(row.tag)
    try {
      await api.bookRegistry.start(row.tag, props.mode)
      refresh()
    } catch (err) {
      setNote({ kind: 'error', text: explain(err) })
    } finally {
      setBusyTag(null)
    }
  }

  const doStop = async (row: BookRow): Promise<void> => {
    setNote(null)
    setBusyTag(row.tag)
    try {
      await api.bookRegistry.stop(row.tag, props.mode)
      refresh()
    } catch (err) {
      setNote({ kind: 'error', text: explain(err) })
    } finally {
      setBusyTag(null)
    }
  }

  /**
   * ERASE the book — registry row, position record and switch together.
   *
   * IRREVERSIBLE, and the only irreversible control on this page, so unlike
   * Start and Stop it is confirmed first. The server refuses (409) while the
   * book still holds legs or is still asked to run, and those refusals are the
   * real safety — this dialog exists because "I meant the other row" is a
   * mistake nothing server-side can catch.
   */
  const doDelete = async (row: BookRow, holds: number, purge: boolean): Promise<void> => {
    setNote(null)
    setBusyTag(row.tag)
    setDeleting(null)
    try {
      // `flatten` only when this book actually holds something. The summary is
      // already on the page, so no extra round trip is needed to know — and the
      // flag is never sent for an empty book, so a delete cannot place an order
      // nobody could have expected.
      await api.bookRegistry.remove(row.tag, props.mode, holds > 0, purge)
      setNote({
        kind: 'ok',
        text: `${row.tag} was deleted from ${props.mode}. The tag is free to be built again.` +
          (purge ? " Today's trades and P&L for it were cleared too." : ''),
      })
      refresh()
    } catch (err) {
      // The server's refusal names the contracts still held and points at
      // close-all. Showing it verbatim is more useful than a summary.
      setNote({ kind: 'error', text: explain(err) })
    } finally {
      setBusyTag(null)
    }
  }

  /**
   * Starting in LIVE is confirmed first — no password, because the server's
   * `/start` accepts none; a client-only password prompt the server never
   * checks is the "scary dialog that does nothing" `strategies.tsx` warns
   * against. Paper asks nothing, exactly like flipping a strategy's paper
   * switch.
   */
  const start = (row: BookRow): void => {
    if (props.mode === 'live') setPending(row)
    else void doStart(row)
  }

  const rows: BookTableRow[] = orderBooks(registry ?? []).map((row) => ({
    row, summary: summaries.get(row.tag), pnl: pnls.get(row.tag),
    margin: estimateFor(marginData, row.tag, row.mode),
  }))

  const columns: TableColumn<BookTableRow>[] = [
    {
      key: 'book', header: 'Book', width: proportional(2),
      renderCell: ({ row, summary, margin }) => <BookCell row={row} legs={summary?.legs} margin={margin} />,
    },
    {
      key: 'state', header: 'State', width: pixel(200),
      renderCell: ({ row }) => <StateCell row={row} />,
    },
    {
      key: 'netDelta', header: 'Net delta', align: 'end', width: pixel(110),
      renderCell: ({ summary }) => <NetDeltaCell summary={summary} />,
    },
    {
      key: 'pnl', header: 'P&L', align: 'end', width: pixel(110),
      // The incomplete badge sits under the figure: a demo-rail row with legs
      // still on production prices is another exchange's number.
      renderCell: ({ pnl }) => (
        <VStack gap={0} align="end">
          <Money value={pnl?.total ?? null} size="sm" />
          <MarksFallbackBadge fallback={pnl?.marksFallback} />
        </VStack>
      ),
    },
    {
      key: 'lastMark', header: 'Last mark', width: pixel(160),
      renderCell: ({ row }) => <LastMarkCell row={row} />,
    },
    {
      key: 'lastDecision', header: 'Last decision', width: proportional(2),
      renderCell: ({ row }) => (
        <Text size="sm" color="secondary">
          {row.lastDecision === '' ? '—' : row.lastDecision}
        </Text>
      ),
    },
    {
      key: 'actions', header: '', width: pixel(440),
      renderCell: ({ row }) => (
        <HStack gap={1} justify="end">
          {/*
            MANUAL ORDER — offered on a running book too (that is the case it
            exists for: a missed exit on a live book has to be re-placeable
            without stopping the supervisor). The row already knows its symbol
            and expiry, so the dialog opens straight onto the chain.
          */}
          <Button
            variant="ghost" size="sm" label="Order"
            onClick={() => setOrderFor(row)}
          />
          <BullSButtons
            row={row} busy={busyTag === row.tag}
            onAsk={(action) => setBullsAsk({ row, action })}
          />
          {/*
            Offered on a RUNNING book too, unlike Delete: retuning a live book
            is the case this control exists for, and the supervisor applies it
            at the next mark without a restart.
          */}
          <Button
            variant="ghost" size="sm"
            label={dialsFor === row.tag ? 'Hide dials' : 'Dials'}
            onClick={() => setDialsFor(dialsFor === row.tag ? null : row.tag)}
          />
          {row.desired === 'running'
            ? (
              <Button
                variant="ghost" size="sm" label="Stop"
                isDisabled={busyTag === row.tag}
                onClick={() => void doStop(row)}
              />
            )
            : (
              <Button
                variant="ghost" size="sm" label="Start"
                isDisabled={busyTag === row.tag}
                onClick={() => start(row)}
              />
            )}
          {/*
            Offered only on a STOPPED book. The server refuses a delete while
            `desired: 'running'` anyway, so a Delete sitting beside Stop would
            be a button whose only outcome is an error — and putting the
            irreversible control next to the one you press most is how the
            wrong row gets deleted.
          */}
          {row.desired === 'running' ? null : (
            <Button
              variant="ghost" size="sm" label="Delete"
              isDisabled={busyTag === row.tag}
              onClick={() => setDeleting({ row, purge: false })}
            />
          )}
          {/*
            PURGE is a separate button rather than a checkbox because
            `AlertDialog` takes only strings — there is nowhere inside it to put
            one. Separate is arguably better anyway: it wipes today's realised
            P&L for the tag, which is a different decision from removing the
            book, and it gets its own sentence in its own confirmation.
          */}
          {row.desired === 'running' ? null : (
            <Button
              variant="ghost" size="sm" label="Delete + clear history"
              isDisabled={busyTag === row.tag}
              onClick={() => setDeleting({ row, purge: true })}
            />
          )}
        </HStack>
      ),
    },
  ]

  return (
    <VStack gap={4}>
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <HStack gap={3} align="center" wrap="wrap">
          <Heading level={2}>Books</Heading>
          <ModeBadge />
        </HStack>
        {/*
          THE ONLY DOOR TO `#/build`, which no longer has a header tab.

          It used to open a create wizard — a dialog that registered a book and
          seeded its legs from typed-in strikes. The Build page does the same
          job against a live chain, opening the position first and registering
          what it actually got, so the wizard was not a second way in: it was
          the old one, and it has been deleted.
        */}
        <Button variant="secondary" label="Build a book" onClick={() => goTo('build')} />
      </HStack>

      {/*
        THE SESSION, STATED ONCE.

        Off-hours nearly every cell on this page looks like a fault — marks
        hours old, P&L an em dash (BY DESIGN: nothing can be marked, and a
        number there would be invented), supervisors idling. None of it is
        wrong, and until this line the page said nothing at all, leaving the
        operator to work out from the date why their book had gone blank.

        ONE LINE, NOT A BANNER AND NOT PER ROW. A red-or-amber box every weekend
        is how banners stop being read, and repeating "market closed" down the
        rows would bury the two alarms that never go quiet: a book carrying legs
        past its expiry, and the desired/actual gap. Same words as the positions
        page's own stale-marks banner, because it is the same fact.
      */}
      {inSession(Date.now()) ? null : (
        <Text size="sm" color="secondary">
          Market closed — showing last known marks. P&amp;L and delta stay blank until the next
          session rather than being computed from prices nobody is quoting.
        </Text>
      )}

      {error !== null ? (
        <Banner
          status="error"
          title="The book list could not be loaded"
          description={`${error}. This list cannot be trusted to reflect what is actually running.`}
        />
      ) : null}
      {/*
        THE FROZEN COLUMNS, NAMED.

        Its own banner rather than a sentence inside the registry one above:
        they are two different reads failing for two different reasons, and the
        registry banner's claim ("this list cannot be trusted to reflect what is
        actually running") is about the ROWS. A page whose list is current and
        whose figures are an hour old needs to be told exactly that, and both
        failing at once is worth two lines rather than one that under-states
        half of it.

        `warning`, not `error`: the numbers on screen were true when they
        arrived and the lifecycle controls beside them still work. What is not
        true is that they are current.
      */}
      {figuresError !== null ? (
        <Banner
          status="warning"
          title="Net delta and P&amp;L may be older than they look"
          description={
            `${figuresError}. Those columns are the last figures that arrived — nothing on this ` +
            'page recomputes them, so they will sit unchanged for as long as the read keeps ' +
            'failing.' +
            (summaryError !== null
              ? ' The Delete confirmation reads the same figures for its leg count, so a delete ' +
                'offering to flatten "N leg(s)" may be describing a book that has since moved — ' +
                'open the position page before confirming one.'
              : '')
          }
        />
      ) : null}
      {note !== null ? (
        <Banner
          status={note.kind === 'ok' ? 'success' : 'error'}
          title={note.kind === 'ok' ? 'Done' : 'That did not run'}
          description={note.text}
        />
      ) : null}

      {registry === null && error === null ? <Text color="secondary">Loading…</Text> : null}
      {registry !== null && rows.length === 0 ? (
        <Text color="secondary">
          {`No books are registered in ${props.mode} yet. "Build a book" opens a position and ` +
            'puts one here, stopped.'}
        </Text>
      ) : null}

      {rows.length > 0 && phone ? (
        <VStack gap={2}>
          {rows.map((r) => (
            <BookCard
              key={r.row.tag}
              data={r}
              busy={busyTag === r.row.tag}
              onStart={() => start(r.row)}
              onStop={() => void doStop(r.row)}
              onDelete={() => setDeleting({ row: r.row, purge: false })}
              onOrder={() => setOrderFor(r.row)}
              onBullS={(action) => setBullsAsk({ row: r.row, action })}
            />
          ))}
        </VStack>
      ) : null}
      {rows.length > 0 && !phone
        ? <Table data={rows} columns={columns} density="compact" hasHover />
        : null}

      {/*
        BELOW THE LIST, NOT INSIDE THE ROW. A form of forty fields in a table
        cell would reflow every other row, and the panel names the book it is
        editing in its own heading so there is no ambiguity about which one is
        open.

        Keyed to the LIVE registry row, so a book deleted or renamed under it
        closes the panel rather than editing a row that no longer exists.
      */}
      {(() => {
        const open = dialsFor === null
          ? undefined
          : (registry ?? []).find((r) => r.tag === dialsFor)
        return open === undefined ? null : (
          /*
            `key` IS THE FIX, not decoration. The panel seeds its draft from
            `useState`, which runs on MOUNT only — so switching straight from one
            book's dials to another's kept the first book's values on screen under
            the second book's heading, and the operator would have saved TCS's
            dials onto BHEL. Closing and reopening worked because that unmounted
            it. Keying by tag makes a different book a different component, so
            the draft (and any banner) resets with it.
          */
          <DialsPanel
            key={open.tag}
            row={open}
            reauth={reauth}
            onClose={() => setDialsFor(null)}
            onSaved={refresh}
          />
        )
      })()}

      {/* Its own `isOpen` handles the null target, exactly like FlattenDialog. */}
      <ManualOrderDialog
        target={orderFor === null
          ? null
          : { tag: orderFor.tag, symbol: orderFor.symbol, expiry: orderFor.expiry }}
        mode={props.mode}
        reauth={reauth}
        onClose={() => setOrderFor(null)}
        onDone={refresh}
      />

      <AlertDialog
        isOpen={pending !== null}
        onOpenChange={() => setPending(null)}
        title={pending === null ? '' : `Start ${pending.tag} in live?`}
        description={pending === null ? '' : liveStartStatement(pending.tag)}
        actionLabel="Start in live"
        actionVariant="destructive"
        isActionLoading={busyTag !== null && pending !== null && busyTag === pending.tag}
        onAction={() => {
          const row = pending
          setPending(null)
          if (row !== null) void doStart(row)
        }}
      />

      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={() => setDeleting(null)}
        title={deleting === null ? '' : `Delete ${deleting.row.tag}?`}
        description={
          deleting === null
            ? ''
            : (deletingLegs > 0
                ? `${deleting.row.tag} still holds ${deletingLegs} leg(s). They will be CLOSED FIRST ` +
                  `(fast: an aggressive limit), and the book erased only if that leaves it flat. ` 
                : '') +
              `This erases the book from ${props.mode} for good — its registry row, its recorded ` +
              `position and its switch on the Strategies page. It cannot be undone, and the tag ` +
              `becomes free to build again. ` +
              (deleting.purge
                ? `Today's trades and realised P&L for this tag are ALSO CLEARED, so a rebuild ` +
                  `starts from zero. That cannot be undone either.`
                : `Today's trades and realised P&L are KEPT: they are what happened, and ` +
                  `deleting a book does not unmake it.`)
        }
        actionLabel={
          (deletingLegs > 0 ? 'Flatten and delete' : 'Delete the book') +
          (deleting?.purge === true ? ', and clear its history' : '')
        }
        actionVariant="destructive"
        isActionLoading={busyTag !== null && deleting !== null && busyTag === deleting.row.tag}
        onAction={() => {
          const d = deleting
          if (d !== null) void doDelete(d.row, deletingLegs, d.purge)
        }}
      />

      <AlertDialog
        isOpen={bullsAsk !== null}
        onOpenChange={() => setBullsAsk(null)}
        title={bullsAsk === null
          ? ''
          : `${bullsAsk.action === 'close' ? 'Close' : 'Re-arm'} ${bullsAsk.row.tag}?`}
        description={bullsAsk === null ? '' : bullsStatement(bullsAsk.row.tag, bullsAsk.action)}
        actionLabel={bullsAsk?.action === 'rearm' ? 'Re-arm the book' : 'Close the book'}
        actionVariant={bullsAsk?.action === 'rearm' ? 'primary' : 'destructive'}
        onAction={() => {
          const ask = bullsAsk
          setBullsAsk(null)
          if (ask !== null) void doBullS(ask.row, ask.action)
        }}
      />

      {reauth.dialog}
    </VStack>
  )
}
