/**
 * The pages mapped from the old dashboard's structure onto what the desk system
 * actually has.
 *
 *   old            -> new
 *   home           -> Positions   one book, per-leg greeks, the diff
 *   strategies     -> Books       every book in the selected mode, as tabs
 *   (none)         -> Feed        market-data health
 *   manager        -> Controls    kill switch, close-all
 *
 * `orderbook -> Orders` USED TO BE ON THIS LIST and is gone (2026-08-16). The
 * submission journal was on screen three times — here, in each book's own log,
 * and as the Broker tab's day-wise history. The endpoint and the journal itself
 * are untouched; only this page went, and `OrderLogTable` (`orderlog.tsx`) is
 * unchanged and still rendered by the per-strategy log.
 *
 * WHAT THE REMOVAL COST, AND WHERE IT WENT — corrected. The first version of
 * this note claimed refusals stayed visible "via Status and the audit log", and
 * that was FALSE when it was written: the audit log records what an operator
 * did to the bridge and excludes the order path by design, the Broker page
 * shows only what REACHED the broker, and the per-strategy log is tag-scoped.
 * A live gateway refusal — freeze limit, kill switch, a risk gate — on a book
 * nobody had opened was on no screen at all. Status now carries an `Order
 * failures` section (`status.tsx`) that answers exactly that, mode-scoped as
 * this page was, and `#/orders` is aliased onto Status rather than Broker for
 * the same reason — see `shell.tsx`.
 *
 * NONE OF THEM DECIDES PAPER OR LIVE. The mode arrives as a prop from the one
 * navbar switch; Controls used to carry its own toggle and no longer does.
 *
 * The old routes with no counterpart (strategy-builder, combo-builder,
 * nymex-mcx, pricing, users) are deliberately absent — three of them threw in
 * production because their controller was excluded from the build, and none
 * describes anything this system does.
 */

import { useEffect, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import {
  Table, proportional, pixel, useTableSortable, useTableSortableState,
} from '@astryxdesign/core/Table'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import { Switch } from '@astryxdesign/core/Switch'
import type { TableColumn, TableSortState } from '@astryxdesign/core/Table'
import {
  ApiError, api, ago, closeAllFailed, explain, inSession, inr, inrCompact,
  localTime, money, signed, sign,
  NOWRAP, RED,
  type BookDiff, type BookMargin, type BookSummary, type BrokerFunds, type CloseAllResult, type DeskMode,
  type FeedStatus, type PositionsResponse,
} from './api.ts'
import {
  bookBreakevens, bookTotals, compareLadder, consolidatePositions, shortsOnlyGreeks, sinceEntryTotal,
  summaryRows, type PositionRow,
} from './positions.ts'
import { formatContract } from './contract.ts'
import { asOf, PHONE, useMedia, usePoll } from './shell.tsx'
import { useLivePnl } from './stream.tsx'
import { ModeBadge } from './mode.tsx'
import { useReauth } from './auth.tsx'
import { ManualOrderDialog } from './manual-order.tsx'
import { ProtectDialog, type ProtectTarget } from './protect.tsx'
import { OpenLegs, PnlCards } from './pnl.tsx'
import { MarksSourceNote } from './marks-source.tsx'
import { PayoffPanel } from './payoff.tsx'
import { StrategyReasonLine } from './strategies.tsx'
import { AccountMarginPanel } from './margin.tsx'

/** Join the non-null bits of an event summary, or an em dash when there are none. */
function summarise(parts: readonly (string | null)[]): string {
  const kept = parts.filter((x): x is string => x !== null)
  return kept.length === 0 ? '—' : kept.join(' ')
}

// ------------------------------------------------------------------ shared

/**
 * One figure.
 *
 * IT CARRIES NO QUALIFIER OF ITS OWN. It used to take a `note` badge, and the
 * four greeks all set it to "partial" — directly under a banner that already
 * said the totals were partial and named the legs holding them back. Five
 * statements of one fact is not emphasis; it is what makes an operator stop
 * reading the banners. The qualification belongs in the one place that can
 * actually say WHICH legs.
 */
export function Stat(props: {
  label: string
  value: string
  tone?: number
  /**
   * A qualifier UNDER the figure, for when the number needs one to be read
   * correctly — "this is the bridge's model, not the strategy's".
   *
   * Deliberately below rather than beside the label: a caption that widens the
   * tile reflows the whole row, and this one appears and disappears with a
   * fallback. It is `sm`/secondary so it reads as a footnote to the figure
   * rather than competing with it.
   */
  caption?: string
}): React.ReactElement {
  return (
    /*
      THE PADDING IS ON THE CARD AND NOWHERE ELSE, which is what took this tile
      from 111px tall to ~75px for one number.

      `<Card>` defaults to `padding={4}` and the Stack inside carried its own
      `padding={4}` on top of it, so every tile spent 32px of inset above its
      label and 32px below its figure — a third of the tile, twice over, and the
      reason seven of them filled a phone screen. Stating the card's padding and
      dropping the Stack's leaves ONE inset, at 12px. The `--container-padding-*`
      variables a `Table` bleeds against are published by whichever container
      sets padding, so moving it up a level costs nothing here or in any other
      card on this page.

      `gap={0}`: a label and the figure it names are one unit — 4px of air
      between them was separating them from each other rather than from the
      tiles either side.
    */
    <Card padding={3}>
      <VStack gap={0}>
        <Text size="sm" color="secondary">{props.label}</Text>
        <Text size="2xl" weight="bold" style={props.tone === undefined ? undefined : sign(props.tone)}>
          {props.value}
        </Text>
        {props.caption === undefined ? null : (
          <Text size="sm" color="secondary">{props.caption}</Text>
        )}
      </VStack>
    </Card>
  )
}

/**
 * A tile whose figure is a LEVEL — an underlying price with its distance from
 * spot — or two of them.
 *
 * WHY IT IS NOT `Stat`. Three things separate them, and each one is the reason
 * the other two could not be bolted on:
 *
 *   TWO FIGURES. The breakeven tile carries an upper and a lower bound, and they
 *   are tinted in OPPOSITE directions — one string with one tone cannot say that.
 *
 *   A SMALLER FIGURE. "2,512 (+2.6%)" at `Stat`'s 2xl is 165px of text in a
 *   175px tile, so it wrapped and the tile grew to 146px tall. At `lg` it is one
 *   line. A level is read as a price to compare against spot, not as a headline
 *   number, so the step down costs nothing.
 *
 *   A QUIET NOTE. What the figure is measured against, or why it is a dash. The
 *   greek tiles deliberately carry no qualifier (see `Stat`) because a banner
 *   above them already names the legs holding them back; these have no banner,
 *   and "Margin used" with no rail named would be worse than no tile.
 */
/**
 * ONE CELL of the book header's divided card — a label, a figure, and an
 * optional second line, with no `Card` of its own.
 *
 * WHY IT IS NOT `Stat`. `Stat` IS a card: it carries the border, the shadow and
 * the inset, which is exactly what eleven of them side by side spent most of a
 * screen on. Here the card is the container and the cells are divided by a
 * single vertical rule from `.stat-grid`. Everything else — the label above the
 * figure, the `sign()` tint, the secondary line — is the same.
 *
 * `size` demotes the second band (gamma, vega, theta, net TV) without moving it
 * out of the card, so the important figures are the ones the eye lands on.
 */
export function StatCell(props: {
  label: string
  /**
   * A qualifier ON THE LABEL LINE — the margin's age, the steering delta.
   *
   * Under the value it made its cell taller than every neighbour and gave the
   * card a ragged bottom edge. Beside the label it costs no height at all, and
   * it reads as what it is: something about the figure rather than a second one.
   */
  labelNote?: string | undefined
  value: string
  tone?: number | null
  /** The full sentence behind a truncated qualifier, on hover. */
  title?: string | undefined
}): React.ReactElement {
  return (
    /*
      ONE SIZE FOR EVERY CELL (operator's call 2026-08-14: "keep all cells same
      font size smaller which we have for net gamma/vega").

      The header carried two — `2xl` for the figures that lead and `lg` for the
      greeks under them — which made the two rows different heights and left the
      block looking like two tables rather than one. At one size the grid is
      exactly uniform, and WHICH figures lead is already said by their position:
      MTM, delta and Δ0 are the first three cells of the first row.
    */
    <VStack gap={0}>
      <HStack gap={2} align="center" wrap="wrap">
        <Text size="sm" color="secondary">{props.label}</Text>
        {props.labelNote === undefined ? null : (
          /* A raw span for the tooltip: astryx omits `title` from its props on
             purpose, so the attribute goes on an element of our own. */
          <span {...(props.title === undefined ? {} : { title: props.title })}>
            <Text size="xsm" color="secondary">{props.labelNote}</Text>
          </span>
        )}
      </HStack>
      <Text
        size="lg"
        weight="bold"
        style={props.tone === undefined || props.tone === null ? undefined : sign(props.tone)}
      >
        {props.value}
      </Text>
    </VStack>
  )
}

export function LevelStat(props: {
  label: string
  /**
   * One line per level. `tone` tints it green above / red below, and null
   * leaves it plain — a figure with no direction must not be coloured as if it
   * had one.
   */
  lines: readonly { key: string; text: string; tone: number | null }[]
  /** `| undefined` so a caller may COMPUTE its way to "no note" — under
      `exactOptionalPropertyTypes` an optional-only prop rejects that. */
  note?: string | undefined
  /** The full sentence behind a dash, on hover, when it is too long to print. */
  title?: string
}): React.ReactElement {
  return (
    <Card padding={3}>
      <VStack gap={0}>
        <Text size="sm" color="secondary">{props.label}</Text>
        {props.lines.map((l) => (
          <Text
            key={l.key}
            size={props.lines.length > 1 ? 'xl' : '2xl'}
            weight="bold"
            style={l.tone === null ? undefined : sign(l.tone)}
          >
            {l.text}
          </Text>
        ))}
        {/*
          A RAW `span` FOR THE TOOLTIP. astryx omits `title` from every
          component's props on purpose, so the attribute goes on an element of
          our own — the same thing the P&L pill does with its tag (see pnl.tsx).
        */}
        {props.note === undefined ? null : (
          <span {...(props.title === undefined ? {} : { title: props.title })}>
            <Text size="xsm" color="secondary">{props.note}</Text>
          </span>
        )}
      </VStack>
    </Card>
  )
}

function Row(props: { label: string; value: string; tone?: 'warn' }): React.ReactElement {
  return (
    // `wrap`: the kill switch's "Engaged by" carries a username and a full
    // timestamp, which does not share a phone's line with its own label.
    <HStack justify="between" wrap="wrap" gap={2}>
      <Text color="secondary" size="sm">{props.label}</Text>
      <Text size="sm" style={props.tone === 'warn' ? RED : undefined}>{props.value}</Text>
    </HStack>
  )
}

// --------------------------------------------------------------- positions

/**
 * The desk's book against the bridge's — at two very different volumes.
 *
 * THE ASYMMETRY IS THE POINT. This panel exists for one failure: the Python
 * desk and the bridge disagreeing about what is held, which is a position
 * nobody is managing. That state has to be unmissable. But it is also the rare
 * state — nearly every render of this page is "they agree", and agreement used
 * to be announced by a full Card, a heading and a full-width green bar. Weight
 * spent on the healthy case is weight the operator learns to skip, and an eye
 * trained to skip this region skips it on the day it is red too. So:
 *
 *   agree      one line, secondary text, no card, no heading
 *   undeclared one line, neutral — normal for a hosted strategy, not a fault
 *   disagree   the full card, unchanged: every leg, and in which direction
 *
 * The quiet line still carries the two facts worth having: HOW MANY legs
 * matched (agreement over nothing is not agreement) and HOW OLD the desk's
 * declaration is. A `declaredAt` drifting into minutes while the page polls
 * every 8s is itself a signal, and it is only visible if the age is on screen.
 */
function DeskBridgeDiff(props: {
  tag: string | null
  diff: BookDiff | null
  error: string | null
}): React.ReactElement | null {
  const { tag, diff, error } = props

  /*
    A FAILED REQUEST IS NOT AN ANSWER. It stays loud — not because the books
    disagree (we have no idea), but because the one instrument that would tell
    us is down, and that is worth interrupting for.
  */
  if (error !== null) {
    return (
      <Card padding={3}>
        <VStack gap={2}>
          <Heading level={3}>Desk vs bridge</Heading>
          <Banner
            status="error"
            title="The comparison could not be read"
            description={`${error}. This says nothing about whether the two agree — it is a failed request.`}
          />
        </VStack>
      </Card>
    )
  }

  // Not yet answered. Nothing is claimed until the first response lands; a
  // placeholder here would only be a green-shaped hole for the eye to fill in.
  if (diff === null) return null

  /*
    AN UNDECLARED BOOK IS NOT A DISAGREEMENT.

    A book that declares nothing puts every leg in `bridgeOnly`, which would
    read "out of sync" permanently. `declaredAt` is the field that separates
    "nothing has been said about this book" from "something was said and it
    differs". It is dressed as neither success nor failure, because it is
    neither.

    THIS IS NOW EVERY BOOK ON THE DESK, and the sentence used to deny it: it
    said "only the Python desk does", naming the one writer of
    `desk-declarations`. Python was RETIRED at the 2026-08-22 cutover.
    `POST /v1/desk/declare` still exists and still works, but nothing in this
    tree calls it — the TS supervisor publishes chain/token declarations
    (`supervisor/chain-view.ts`), which are a different thing entirely — and
    the newest row in `desk-declarations` on prod is dated 2026-08-21, the day
    before the cutover.

    So this branch is no longer a property of "a whole class of book"; it is
    unconditional, and the comparison behind it cannot come back until
    something declares again. Said plainly, because a panel that blames the
    book for a feed that died is how an operator ends up hunting the wrong
    thing (verified 2026-09-07 on the three relief-r paper books).
  */
  if (diff.declaredAt === null) {
    // `align="start"`: the sentence runs to two or three lines on a narrow
    // viewport, and a badge floating in the middle of a paragraph reads as if
    // it belonged to the second line.
    return (
      <HStack gap={2} align="start" wrap="wrap">
        <Badge variant="neutral" label="no book declared" />
        <Text size="sm" color="secondary">
          {`Nothing has declared a book for ${tag ?? 'this tag'}, so there is nothing to compare against. ` +
            'The declaration feed retired with the Python desk on 2026-08-22 and no process writes one now, ' +
            'so this comparison is unavailable for every book — it is not a fault in this one.'}
        </Text>
      </HStack>
    )
  }

  /*
    `inSync` IS NOT TRUSTED ON ITS OWN. It is a server-computed summary of the
    three lists beside it, and the quiet branch is the one branch that can HIDE
    a disagreement — so it demands both that the server called it in sync AND
    that it listed nothing that differs. If those two ever part company the
    loud branch wins, which is the safe way round for them to disagree.
  */
  const differing = [...diff.deskOnly, ...diff.bridgeOnly, ...diff.mismatched]
  if (diff.inSync && differing.length === 0) {
    const legs = diff.matched.length
    return (
      <HStack gap={2} align="center" wrap="wrap">
        <Badge variant="success" label="in sync" />
        {/* Not NOWRAP: this line is three dot-separated clauses and pinning it
            to one line is how a phone-width page starts scrolling sideways. */}
        <Text size="sm" color="secondary">
          {`desk vs bridge · ${legs} ${legs === 1 ? 'leg' : 'legs'} · declared ${ago(Date.now() - diff.declaredAt)}`}
        </Text>
      </HStack>
    )
  }

  return (
    <Card padding={3}>
      <VStack gap={2}>
        <Heading level={3}>Desk vs bridge</Heading>
        <VStack gap={2}>
          <Badge variant="warning" label="out of sync" />
          {diff.deskOnly.map((d) => (
            <Text key={`d${d.strike}${d.type}`} size="sm">{`desk holds ${d.strike}${d.type} (${signed(d.deskQty)}) — we do not`}</Text>
          ))}
          {diff.bridgeOnly.map((d) => (
            <Text key={`b${d.strike}${d.type}`} size="sm">{`we hold ${d.strike}${d.type} (${signed(d.bridgeQty)}) — the desk does not`}</Text>
          ))}
          {diff.mismatched.map((d) => (
            <Text key={`m${d.strike}${d.type}`} size="sm">{`${d.strike}${d.type}: desk ${signed(d.deskQty)} vs ours ${signed(d.bridgeQty)}`}</Text>
          ))}
        </VStack>
      </VStack>
    </Card>
  )
}

/**
 * THE ONE SORT KEY THE POSITIONS TABLE HAS, and the ladder it starts in.
 *
 * `descending` is the ladder as `compareLadder` documents it: calls above puts,
 * strike falling down the screen. Clicking the Contract header flips it to the
 * chain read the other way up; nothing else on this table sorts, because
 * nothing else has an order an operator asks for — the risk columns are read
 * against the row's own contract, not against each other.
 *
 * Module scope, so the initial state is one object rather than a fresh one per
 * render, and so the key cannot drift apart from the comparator it names.
 */
const LADDER_KEY = 'contract'
const LADDER: TableSortState = [{ sortKey: LADDER_KEY, direction: 'descending' }]

/**
 * One declared book, by TAG — not symbol. Since Phase 0 a symbol can carry
 * several variants at once, so `tag` is the only thing that identifies which
 * book this is; the caller (`BookTabsPage`) is what resolves "no tag chosen
 * yet" down to a real one, so this component only ever renders a specific book
 * or an explicit "no book" state.
 */
export function PositionsPage(props: { mode: DeskMode; tag: string | null }): React.ReactElement {
  const tag = props.tag
  const reauth = useReauth()
  const [ordering, setOrdering] = useState(false)
  /**
   * `updatedAt` IS READ HERE, and printed beside the heading.
   *
   * Everything below — every tile, every row, both breakevens — is this one
   * payload. `usePoll` keeps it when a read fails, deliberately ("stale-but-
   * labelled beats empty"), and until the age went on the screen the label half
   * of that promise existed only in a comment: a bridge that stopped answering
   * at 11:04 left a full page of confident figures that were half an hour old
   * and looked live.
   */
  const { data: pos, error, updatedAt: posAt } = usePoll<PositionsResponse | null>(
    () => (tag === null ? Promise.resolve(null) : api.positions(tag, props.mode)),
    5000, [tag, props.mode],
  )
  /**
   * The strategy's current reason, for the line above the tiles.
   *
   * Slower than the position poll on purpose: the reason is rewritten on the
   * desk's ~30s mark whether or not anything changed, so reading it at the
   * positions cadence would be four requests per new value.
   *
   * `actions: false` because this line reads three scalars and the endpoint
   * otherwise ships the book's whole action log — up to 200 entries — every
   * ten seconds, per open tab, for one clipped sentence. The run page asks for
   * the log because it renders it; this does not.
   *
   * THE ERROR IS READ, AND SUPPRESSES THE LINE. `usePoll` deliberately keeps
   * the last good payload when a read fails ("stale-but-labelled beats
   * empty"), which is right for the tiles below — a number with an `asOf` is
   * still evidence — and wrong for this: the sentence is written in the
   * present tense and has no timestamp of its own to age. A half-hour-old
   * "no convexity to centre" rendered as what the strategy means to do NOW is
   * worse than no line at all, so a failed read renders nothing.
   */
  const { data: decisions, error: decisionsError } = usePoll(
    () =>
      tag === null
        ? Promise.resolve(null)
        : api.bookRegistry.decisions(tag, props.mode, { actions: false }),
    10_000, [tag, props.mode],
  )
  /**
   * WHAT THE OPERATOR HAS PINNED, by instrument — the Protect column.
   *
   * `{}` is the normal answer and the common one: a book nobody has protected
   * is a book the engine manages entirely, which is the default (spec §4,
   * D12). `.catch(() => null)` because this is a DECORATION on a table of
   * positions: a bridge a deploy behind has no such endpoint, and a page that
   * refused to render its book over a missing badge would be trading one small
   * absence for a total one.
   *
   * Polled, not fetched once, so a protection applied in another tab (or by
   * the operator's own dialog, which also writes the answer straight back)
   * converges rather than sitting stale under a book that has moved.
   */
  const { data: protection, refresh: refreshProtection } = usePoll(
    () =>
      tag === null
        ? Promise.resolve(null)
        : api.engine.protection(tag, props.mode).catch(() => null),
    30_000, [tag, props.mode],
  )
  /**
   * The map the rows render from — the poll's, until the dialog's own answer
   * overtakes it. The server returns the whole merged map on a write, so the
   * badge changes the moment it lands rather than at the next poll.
   *
   * BOTH SOURCES ARE CHECKED AGAINST THE BOOK ON SCREEN, and that is not
   * belt-and-braces. This page is not remounted when the tab changes, so state
   * from the previous book survives the switch, and `usePoll` deliberately
   * keeps its last payload until the new read lands — at a 30s cadence beside a
   * 5s position poll. Without the check, a book that shares a contract with the
   * one before it (two books on one symbol and expiry is a thing this desk
   * does, by design) would show the OTHER book's claim on its own row for up to
   * half a minute. A claim about what the engine may not sell has to be about
   * the book you are looking at.
   */
  const [pinned, setPinned] = useState<
    { tag: string; mode: DeskMode; map: Readonly<Record<string, number>> } | null
  >(null)
  const isThisBook = (t: string, m: DeskMode): boolean => t === tag && m === props.mode
  const protectedQty =
    pinned !== null && isThisBook(pinned.tag, pinned.mode)
      ? pinned.map
      : protection != null && isThisBook(protection.tag, protection.mode)
        ? protection.protectedQty
        : {}
  /** The contract a Protect dialog is open for, or null. */
  const [protectFor, setProtectFor] = useState<ProtectTarget | null>(null)

  /**
   * NO `.catch(() => null)` HERE.
   *
   * It used to swallow the error, and `null` was also the only value that
   * rendered "The desk has not declared a book" — so the sentence was
   * unreachable in the case it describes (the server always answers with a
   * `BookDiff`) and wrong in the only case it appeared (the request failed).
   * A failed diff now reads as a failed diff, and an undeclared book is read
   * off `declaredAt`, which is what actually distinguishes it.
   */
  const { data: diff, error: diffError } = usePoll<BookDiff | null>(
    () => (tag === null ? Promise.resolve(null) : api.diff(tag, props.mode)),
    8000, [tag, props.mode],
  )
  /**
   * THE SAME NUMBER AS THE P&L CHIP, from the same stream. The tile used to
   * recompute (mark − entry) × qty in the browser off the positions payload,
   * so it and the chip marked at different instants and disagreed by a few
   * ticks — scaled by quantity, ₹950 on one DLF book. Two figures named MTM
   * and P&L that differ for timing reasons read as an error every time; one
   * source is the fix, not a smaller skew (operator's call, 2026-08-04).
   */
  /**
   * ACCOUNT MARGIN — not this book's, and the tile says so.
   *
   * MODE-BLIND ON PURPOSE, unlike everything else on this page: it is one
   * broker account behind the live rail, and a paper book consumes none of it.
   * Showing the same figure under PAPER is the honest reading — the margin is
   * what it is regardless of which rail you are looking at — and the label's
   * "(account)" is what stops it being read as this book's requirement.
   *
   * 30s, because the gateway refreshes its snapshot every 30s; polling faster
   * would re-read the same document and move nothing. The error is IGNORED
   * rather than banner'd: an absent funds figure is already the normal answer
   * (see `BrokerFunds`), so a failed read has nothing to add that the dash and
   * its note do not already say, and this page has three louder banners.
   */
  const { data: funds } = usePoll<BrokerFunds>(() => api.brokerFunds(), 30_000)
  /**
   * THIS BOOK'S margin, which is what the tile beside it now shows.
   *
   * 60s: desk-marketdata re-prices on the SPAN schedule and on leg changes, so
   * the document moves a handful of times a day. Polling faster re-reads the
   * same figure. Error ignored for the same reason as `funds` — an absent
   * figure is a state the tile already renders.
   */
  const { data: bookMargin, updatedAt: marginAt } = usePoll<BookMargin | null>(
    () => (tag === null ? Promise.resolve<BookMargin | null>(null) : api.bookMargin(tag)),
    60_000, [tag],
  )

  const g = pos?.greeks
  /**
   * SEE THE GREEKS THE WAY THE RULES SEE THEM (user-directed 2026-08-18).
   *
   * Under `delta_shorts_only` the strategy steers on its SHORT legs only —
   * on BHEL 2026-08-14 the book carried +408 delta while the shorts alone
   * were -1836, opposite signs — so the whole-book tiles, correct as they
   * are, answer a different question than the one the rules act on. The
   * toggle swaps the greek tiles, Δ0, net TV and the Pos delta TOTAL onto
   * the short set; the rows, the P&L block, the breakevens and the MTM tile
   * stay the WHOLE book, because money and payoff do not become shorts-only
   * when the steering is.
   *
   * UNCONDITIONAL, like every hook on this page — see the sort below.
   */
  const [shortsOnly, setShortsOnly] = useState(false)
  /*
    THE VIEW'S GREEKS: the bridge's own per-leg figures, re-summed over the
    short legs (`shortsOnlyGreeks`) — NOT the declared steering pair, which is
    a different model and is preferred only on the two tiles that can label
    it. One engine per view, the same rule `positions()` keeps server-side.
  */
  const gView = shortsOnly ? shortsOnlyGreeks(g, pos?.legs ?? []) : g
  const shortLegs = (pos?.legs ?? []).filter((l) => l.qty < 0)
  /*
    ONE ROW PER CONTRACT, NOT PER STORED LEG — see `positions.ts` for why the
    two differ and why only the display side merges them. `legCount` stays
    separate because it is the number the store, the desk and every close-by-tag
    action still work in, and the header below has to be able to say both.
  */
  const rows: PositionRow[] = consolidatePositions(pos?.legs ?? [], g, pos?.quotes, pos?.spot ?? null)
  // THE page's one P&L: open-vs-entry plus realised, shared with the table's
  // Total row so the tile and the foot cannot disagree. See `sinceEntryTotal`.
  // Where the venue charges to close (Delta: `closeFees` on the payload) the
  // figure is NET IF CLOSED NOW — the same answer the block's last row gives.
  const sinceEntry = sinceEntryTotal(rows, pos?.realised ?? null, pos?.closeFees)
  const netIfClosed = pos?.closeFees !== undefined
  // `?? []` on the ARRAY, not `?.` on the length: a bridge one deploy behind
  // can answer without `legs` at all, and `undefined.length` throws during
  // render — a blank page mid-session where a dash would do. See api.ts.
  const legCount = (pos?.legs ?? []).length
  /*
    Pluralised, and named rather than nested inline. A book holding one contract
    in two tranches — the case consolidation exists for — read "1 contracts · 2
    legs", directly above a sync line that pluralises correctly. The leg count
    stays on screen whenever it differs: the desk closes by LEG, so a contract
    count alone would hide what an exit acts on.
  */
  const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`
  const positionCount =
    rows.length === legCount
      ? plural(legCount, 'leg')
      : `${plural(rows.length, 'contract')} · ${plural(legCount, 'leg')}`

  /*
    THE TABLE IS ORDERED, NOT LEFT IN BOOK ORDER.

    `consolidatePositions` returns rows in first-seen book order, which is the
    order the desk happened to open the legs in — so a recentre that sheds a put
    and sells a further call lands them wherever the writes fell, and the same
    book reads differently after every adjustment. Sorted, the table is a chain:
    the operator finds a strike where a strike should be.

    `allowUnsortedState: false` — clicking cycles ladder ⇄ reversed ladder and
    never lands back on book order. That third state looks arbitrary on screen
    (it IS arbitrary: it is insertion order), and an operator who reaches it
    while scanning has no way to name what they are looking at.

    UNCONDITIONAL, like every other hook on this page. It sorts a book that has
    not loaded (an empty array) rather than being skipped until one has, which
    is what keeps the hook order identical across the loading, error and stale
    renders this component goes through.
  */
  const { sortedData, sortConfig } = useTableSortableState<PositionRow>({
    data: rows,
    defaultSort: LADDER,
    comparators: { [LADDER_KEY]: compareLadder },
    allowUnsortedState: false,
  })
  const sortPlugin = useTableSortable<PositionRow>(sortConfig)

  /**
   * THE ROWS PLUS THE SUMMARY BLOCK, appended AFTER the sort so it stays last.
   *
   * The table's two summable columns are the ones an operator most wants
   * summed — what the book is up or down, and the delta it is carrying — and
   * both were left to be added up by eye down a column of signed numbers. The
   * figures sit under the columns that produced them, which is what makes them
   * checkable rather than merely stated.
   *
   * THE BLOCK IS Open / Realised / Total when the bridge served a realised
   * figure, and the single old Total row when it did not — `summaryRows` in
   * positions.ts carries the whole story (the +95k that was a loss,
   * 2026-08-18) and the arithmetic, including the rule every total here obeys:
   * UNKNOWN the moment any row is unpriced, because a sum over the rows that
   * DID price is a confident number understated by an unknown amount.
   * `Entry`, `Mark` and `IV` get no total at all — averaging prices across
   * different strikes describes nothing.
   *
   * `?? null` folds "older bridge, field absent" onto "bridge could not vouch
   * for it": both degrade to the one-row block, by design.
   *
   * The delta total follows the VIEW: under shorts-only it sums the short
   * rows, which is what the recomputed tiles above it total to.
   */
  const sortedWithTotal: PositionRow[] = [
    ...sortedData,
    ...summaryRows(
      sortedData,
      pos?.realised ?? null,
      shortsOnly ? sortedData.filter((r) => r.qty < 0) : sortedData,
      { feesPaid: pos?.feesPaid, closeFees: pos?.closeFees },
    ),
  ]

  const columns: TableColumn<PositionRow>[] = [
    {
      key: 'tradingsymbol', header: 'Contract', width: proportional(2),
      /*
        SORTED BY THE LADDER, NOT BY THE SYMBOL. `ITC26AUG277.5PE` sorts
        alphabetically between `ITC26AUG2750CE` and `ITC26AUG280PE` — the
        exchange's packing puts a year and a month ahead of the one number
        being compared, and glues the type on the end. The comparator reads
        `strike` and `type` off the leg instead, which is where they are
        already carried; nothing here parses a symbol back apart.
      */
      sortable: { sortKey: LADDER_KEY },
      // `wrap`: a merged AND unmarked row is a 16-character symbol plus two
      // badges, which does not share a phone's line with them.
      renderCell: (r) => (
        r.isTotal === true ? (
          /*
            WHAT EACH SUMMARY FIGURE IS A SUM OF, said under its name.

            The rows above are the OPEN book against the desk's own entry
            prices — a tranche the desk has already closed has left the book
            (see `pnl` in positions.ts) — so their sum alone read +95k on the
            day the BHEL book was down ≈ −105 net. The block now states the
            open subtotal, the booked figure, and their sum; the labels are
            what keep three P&L figures in one column from being the F-52
            confusion all over again. `summaryRows` owns the wording and the
            fallback ("open, since entry") for a bridge that sent no realised.
          */
          <VStack gap={0}>
            <Text weight={r.summary?.strong === true ? 'bold' : 'medium'}>
              {r.summary?.label ?? 'Total'}
            </Text>
            <Text size="xsm" color="secondary">{r.summary?.note ?? 'open, since entry'}</Text>
          </VStack>
        ) : (
        <HStack gap={2} align="center" wrap="wrap">
          <Text weight="medium">{formatContract(r.tradingsymbol)}</Text>
          {r.unpriced ? <Badge variant="warning" label="no mark" /> : null}
          {/*
            A MODELLED ROW SAYS SO. Its mark and greeks are in every total, but
            they came from the book's own median vol, not from this contract's
            quote — deep-ITM legs live here whenever their LTP sits below the
            cash no-arb floor. Info, not warning: the estimate is the fix, and
            the totals now cover the whole book.
          */}
          {r.modelPriced ? <Badge variant="info" label="model mark" /> : null}
          {/*
            NO TRANCHE BADGE, user-directed 2026-08-17 ("we dont want to see 3
            legs blue chip"): the merge stays, silently — one row per contract
            and direction at the size-weighted average entry. The per-tranche
            story still exists in the Open legs card and the order log; this
            table reads as the net book.
          */}
        </HStack>
        )
      ),
    },
    { key: 'qty', header: 'Qty', align: 'end', width: pixel(110),
      renderCell: (r) => (
        r.isTotal === true
          ? <Text color="secondary">—</Text>
          : <Text style={sign(r.qty)}>{signed(r.qty)}</Text>
      ) },
    // The SIZE-WEIGHTED AVERAGE alone — the per-tranche prices came off this
    // cell (user-directed 2026-08-17, "just show single entry avg price").
    { key: 'entry', header: 'Entry', align: 'end', width: pixel(90),
      renderCell: (r) => (
        r.isTotal === true
          ? <Text color="secondary">—</Text>
          : <Text>{inr(r.entry, 2)}</Text>
      ) },
    { key: 'mark', header: 'Mark', align: 'end', width: pixel(120),
      renderCell: (r) => {
        if (r.isTotal === true) {
          return <Text color="secondary">{r.mark === null ? '—' : inr(r.mark, 2)}</Text>
        }
        // The pair the mark is valued off — a long at its bid, a short at its
        // ask — so the number is checkable against the book that produced it.
        // "last session" marks a snapshot pair (closed market, feed down).
        return (
          <VStack gap={0} style={{ alignItems: 'flex-end' }}>
            <Text>{r.mark === null ? '—' : inr(r.mark, 2)}</Text>
            {r.quote === null ? null : (
              <Text size="sm" color="secondary">
                {`${r.quote.bid.toFixed(2)} / ${r.quote.ask.toFixed(2)}${r.quote.basis === 'snapshot' ? ' · last session' : ''}`}
              </Text>
            )}
          </VStack>
        )
      } },
    /*
      INTRINSIC VALUE (operator, 2026-11-05: "we want to see it in total and
      each strike").

      THE ROW reads per share, beside Entry and Mark, so `Mark − Intrinsic` is
      the time value still in the price — the same per-strike figure the chain
      shows. Under it, when the leg is in the money, its signed share of the
      book (`qty x intrinsic`, a short owes it, so negative): those are what
      the foot of the column sums. An out-of-the-money leg carries no second
      line — there is nothing to add.

      THE TOTAL ROW is the book's intrinsic in money, whole book whatever the
      shorts-only view — like P&L, it is what the open legs would settle for
      if spot held to expiry, before the premium.

      Em dash without a spot: intrinsic is "how far in the money", and there
      is no distance without a price to measure it from.
    */
    { key: 'intrinsic', header: 'Intrinsic', align: 'end', width: pixel(110),
      renderCell: (r) => {
        if (r.isTotal === true) {
          return r.posIntrinsic === null
            ? <Text color="secondary">—</Text>
            : (
              <Text weight="bold" style={sign(r.posIntrinsic)}>
                {money(r.posIntrinsic)}
              </Text>
            )
        }
        if (r.intrinsic === null) return <Text color="secondary">—</Text>
        return (
          <VStack gap={0} style={{ alignItems: 'flex-end' }}>
            <Text>{inr(r.intrinsic, 2)}</Text>
            {r.posIntrinsic === null || r.posIntrinsic === 0 ? null : (
              <Text size="sm" color="secondary">{money(r.posIntrinsic)}</Text>
            )}
          </VStack>
        )
      } },
    /*
      WHAT THIS ROW IS UP OR DOWN — `qty x (mark − entry)`, in rupees.

      NEXT TO ITS OWN INPUTS ON PURPOSE. The three columns to its left are the
      whole calculation, so the operator can check the figure against the row
      rather than against a tile at the top of the page. Beyond it the columns
      turn into greeks, which are read a different way.

      IT IS THE OPEN POSITION'S P&L SINCE ENTRY, not the day's — see `pnl` in
      positions.ts, including why these rows sum to `bookTotals.mtm` and not
      necessarily to the MTM tile above.

      Em dash rather than 0 for an unmarked contract, the same rule as every
      other figure on this page.
    */
    { key: 'pnl', header: 'P&L', align: 'end', width: pixel(110),
      renderCell: (r) => (
        r.pnl === null
          ? <Text color="secondary">—</Text>
          : (
            /*
              BOLD ONLY ON THE ANSWER. The Open and Realised rows are the
              working, the net Total is the figure — three bold sums in one
              column would read as three competing totals.
            */
            <Text
              weight={r.isTotal === true && r.summary?.strong === true ? 'bold' : 'medium'}
              style={sign(r.pnl)}
            >
              {/* `money`: whole rupees on NSE (what `signed` printed), dollars
                  and cents on Delta — not `+29.624`. */}
              {money(r.pnl)}
            </Text>
          )
      ) },
    { key: 'iv', header: 'IV', align: 'end', width: pixel(80),
      renderCell: (r) => <Text>{r.iv === null ? '—' : `${(r.iv * 100).toFixed(1)}%`}</Text> },
    { key: 'delta', header: 'Delta', align: 'end', width: pixel(90),
      renderCell: (r) => <Text>{r.delta === null ? '—' : r.delta.toFixed(3)}</Text> },
    /*
      THE HEADER FOLLOWS THE VIEW. Under shorts-only the TOTAL at the foot of
      this column sums the short rows alone — the set the tiles above now
      total — and a column whose sum skips some of its own rows has to say so
      where the column is named. The long rows keep their figures (they are
      each row's own truth) but drop to the secondary ink, which is how the
      table says "on screen, out of the sum".
    */
    { key: 'posDelta', header: shortsOnly ? 'Pos delta (shorts)' : 'Pos delta',
      align: 'end', width: pixel(120),
      renderCell: (r) => (
        r.posDelta === null
          ? <Text color="secondary">—</Text>
          : shortsOnly && r.isTotal !== true && r.qty >= 0
            ? <Text weight="medium" color="secondary">{signed(r.posDelta)}</Text>
            : (
              <Text
                weight={r.isTotal === true && r.summary?.strong === true ? 'bold' : 'medium'}
                style={sign(r.posDelta)}
              >
                {signed(r.posDelta)}
              </Text>
            )
      ) },
    /*
      PROTECT — the lots on this contract the ENGINE MAY NOT SPEND (spec §4).

      IN THIS TABLE because this is where an operator looks at a leg and
      decides it is not the engine's to sell: the wing bought for a reason, the
      tail left on after a shift. The cell states the claim (in LOTS, which is
      what the engine counts) and the button changes it.

      THE MAP IS THE BOOK'S, NOT THE ROW'S. Protection is keyed by INSTRUMENT
      because desk-api folds several legs of one contract into one row here and
      into one leg there — so a claim keyed on a row would not survive a
      tranche being added. Two rows on the same contract (a Buy and a Sell on
      one strike) therefore SHARE a claim, and both show it.
    */
    { key: 'protect', header: 'Protected', align: 'end', width: pixel(150),
      renderCell: (r) => {
        if (r.isTotal === true) return <Text color="secondary">—</Text>
        const lots = protectedQty[r.tradingsymbol] ?? 0
        return (
          <HStack gap={1} align="center" justify="end">
            {lots > 0
              ? <Badge variant="info" label={`${lots} lot${lots === 1 ? '' : 's'}`} />
              : <Text size="sm" color="secondary">—</Text>}
            <Button
              variant="ghost" size="sm"
              label={lots > 0 ? 'Change' : 'Protect'}
              isDisabled={tag === null}
              onClick={() => {
                if (tag === null) return
                setProtectFor({
                  tag,
                  tradingsymbol: r.tradingsymbol,
                  qty: r.qty,
                  lotSize: r.lotSize,
                  protectedLots: lots,
                })
              }}
            />
          </HStack>
        )
      } },
  ]

  const partial = pos !== null && !pos.complete
  /**
   * NOT ONE LEG COULD BE PRICED, so the totals are sums over nothing.
   *
   * Rendered as em dashes rather than the 0 the arithmetic produces: a book of
   * four unpriced legs is not a flat book, and "Net delta 0" is the single most
   * reassuring thing this page can say about the single most dangerous state it
   * can be in. A PARTLY marked book keeps its number — that one is a real lower
   * bound, and the banner above says which legs are missing from it.
   */
  // ON THE VIEW'S SET: a shorts-only view of an all-long book has genuinely
  // nothing to total, and its tiles must dash rather than show a confident 0
  // over legs the view excluded.
  const nothingPriced = gView !== undefined && rows.length > 0 && gView.legs.length === 0
  // Takes the value as `number | undefined` rather than defaulting it: a `?? 0`
  // anywhere near a greek is the exact bug this guards against.
  const greek = (value: number | undefined, digits = 0): string =>
    value === undefined || nothingPriced ? '—' : signed(value, digits)
  /**
   * The two tiles that can show the STRATEGY'S OWN steering figures do so
   * under shorts-only — those are the exact numbers the rules acted on, and
   * the toggle exists to see them. The engine's shorts-only sum stands in
   * when the strategy declared none (the dial is off, or an older decider);
   * the label note says which one is on screen.
   */
  const steered = shortsOnly && pos?.steering != null ? pos.steering : null
  const shortsNote = (): { labelNote: string } | Record<string, never> =>
    shortsOnly ? { labelNote: steered !== null ? 'shorts only · steering' : 'shorts only' } : {}

  /*
    The report's row figures, computed the report's way — see `bookTotals`. All
    three inherit its null-not-zero rule, so they dash out exactly when the
    greeks above do and never show a flat figure over an unmarked book.

    TWO COMPUTATIONS ONCE THE VIEW CAN DIFFER FROM THE BOOK: `totals` is the
    whole book and feeds the MTM tile's fallback — the money figure the toggle
    must never move — while `viewTotals` follows the toggle for Δ0 and net TV,
    the two derived figures that are statements about the same set as the
    greek tiles beside them. Δ0 comes from the ENGINE's shorts-only sums, not
    the declared steering pair: dividing one model's delta by the other's
    gamma is a level neither model stands behind.
  */
  const totals = bookTotals(pos?.legs ?? [], g, pos?.spot ?? null)
  const viewTotals = shortsOnly
    ? bookTotals(shortLegs, gView, pos?.spot ?? null)
    : totals
  /**
   * WHERE THIS RUN EXPIRES FLAT — computed off strikes, entries, signed
   * quantities and the realised figure, which means it needs NO MARKS AND NO
   * GREEKS: booked money is a constant no mark can change.
   *
   * That independence is the point: the two figures above it dash out the moment
   * the feed stops, and the breakevens do not. A book whose every leg is unpriced
   * still has an upper and a lower bound, they are exactly as reliable as a fully
   * marked book's, and they are the two levels an operator watches when the marks
   * are the thing that has failed. Only `spot` is required — for the distance,
   * not for the levels.
   *
   * REALISED IS FOLDED IN, because the tile's question is where the run comes
   * back to flat: a repaired book whose open legs lose everywhere at expiry but
   * whose earlier legs banked more than that loss has real levels, and without
   * the booked term this pair dashed while the payoff panel below printed a
   * band (TCS, 2026-08-21). The label says `incl. booked` whenever the figure
   * is in; a bridge that sent none degrades to the open legs alone, unlabelled.
   */
  const be = bookBreakevens(pos?.legs ?? [], pos?.spot ?? null, pos?.realised ?? null)
  const bookedNote = (): { labelNote: string } | Record<string, never> =>
    pos?.realised != null ? { labelNote: 'incl. booked' } : {}

  return (
    <VStack gap={3}>
      {/*
        `wrap` on every toolbar on this page, and on the other pages' toolbars
        too. A row of a heading and a control is the second thing that pushes a
        phone-width document sideways after a wide table — and unlike the table
        it has no scroll container of its own to do it inside, so the only
        alternative to wrapping is overflowing.
      */}
      <HStack gap={3} align="center" wrap="wrap">
        {/*
          `pos.symbol` once it has loaded — the underlying, which is what an
          operator scans for — with the tag alongside it, because since Phase 0
          the symbol alone no longer says WHICH book. Before it loads, the tag
          from the URL/tab is the only name there is.
        */}
        <Heading level={2}>{pos !== null ? `${pos.symbol} · ${pos.tag}` : tag ?? 'No book'}</Heading>
        {/*
          Straight onto THIS book's chain — symbol and expiry both locked, no
          pickers (operator's call 2026-08-18). The expiry comes off the book's
          own legs (a declared book is single-expiry by construction; the
          driver refuses off-expiry adoption for the same reason), so an EMPTY
          book cannot say which chain it means and the button waits for a leg —
          the Build screen is where a first leg comes from.
        */}
        <Button
          variant="ghost"
          size="sm"
          label="Place order"
          isDisabled={pos === null || pos.legs.length === 0}
          onClick={() => setOrdering(true)}
        />
        {/*
          THE SPOT IS BOLD AND IN THE PRIMARY INK (operator's call 2026-08-14:
          "can be bold and dark color so it is easily visible").

          It sat in secondary grey beside the tag, which reads as a caption on
          the title — but it is a live figure that every level on the page is
          compared against: Δ0, both breakevens and every strike in the table
          are all "how far from here". Only the word `spot` stays grey; the
          number is the thing being read.
        */}
        {pos !== null ? (
          <HStack gap={2} align="center">
            <Text size="lg" color="secondary">spot</Text>
            <Text size="lg" weight="bold">{pos.spot === null ? '—' : inr(pos.spot, 2)}</Text>
          </HStack>
        ) : null}
        {/*
          HOW OLD EVERYTHING BELOW IS, in the quietest style the page has.

          It is deliberately not a banner: on a healthy desk it reads "as of
          now" every five seconds and must cost the eye nothing. It earns its
          place on the day the bridge stops answering — the error banner below
          says the READ failed, and this says how long ago the figures under it
          were last true, which is the number an operator actually acts on.
        */}
        {pos !== null && asOf(posAt) !== undefined ? (
          <Text size="sm" color="secondary">{asOf(posAt)}</Text>
        ) : null}
        {/*
          WHICH EXCHANGE PRICED THIS BOOK — Delta's testnet for a demo-rail
          paper book, production otherwise — and, beside it, the legs that
          fell back to production because no demo quote has arrived. Never
          silent: those figures are another exchange's. Nothing at all when
          an older bridge sent neither field.
        */}
        {pos !== null ? <MarksSourceNote source={pos.marksSource} fallback={pos.marksFallback} /> : null}
        {/*
          THE VIEW TOGGLE, beside the name of the book it re-reads. "Shorts
          only" is the strategy's own view under `delta_shorts_only` — see the
          state's docstring for exactly which figures follow it and which
          (money, payoff) never do. A `Switch` rather than a second tab strip:
          it is one boolean about THIS book, and the Strategies page is where
          a Switch already means "flip how this tag behaves is read".
          Rendered only once a book has loaded — a toggle over no figures
          would be a control that does nothing.
        */}
        {pos !== null ? (
          <Switch
            label="Shorts only"
            value={shortsOnly}
            onChange={(v) => setShortsOnly(v)}
          />
        ) : null}
      </HStack>

      {error !== null ? <Banner status="error" title="Cannot reach the bridge" description={error} /> : null}
      {/*
        STALENESS MEANS TWO DIFFERENT THINGS, and this banner used to say only
        one of them. `stale` is set whenever a mark came off the persisted
        snapshot rather than a live tick: outside a session that is simply how a
        shut market looks, and DURING one it is a feed outage. Labelling a
        Tuesday-morning outage "Market closed" is the single reading that tells
        the operator to do nothing about it.

        `inSession` — the shared client rule, the same one the Books and
        Strategies pages use — is what separates them. The positions response
        carries no session flag of its own and `FeedStatus` is not fetched here,
        so the clock is asked directly; it is a question about NOW, which is
        when this staleness is being looked at.
      */}
      {pos?.stale === true && !inSession(Date.now()) ? (
        <Banner
          status="info"
          title="Market closed — showing last known marks"
          description={`Prices as of ${pos.marksAsOf === null || pos.marksAsOf === undefined ? 'the last session' : new Date(pos.marksAsOf).toLocaleString()}. These are for reading the book only; no order can be priced or filled against them.`}
        />
      ) : null}
      {pos?.stale === true && inSession(Date.now()) ? (
        <Banner
          status="warning"
          title="The marks are stale — the feed has stopped mid-session"
          description={`The exchange is open, but these prices are as of ${pos.marksAsOf === null || pos.marksAsOf === undefined ? 'an earlier moment' : new Date(pos.marksAsOf).toLocaleString()} — the last snapshot rather than a live tick. Every greek and P&L below is computed from them, and no order can be priced against them.`}
        />
      ) : null}
      {partial ? (
        <Banner status="warning" title="Greeks are partial — totals cover only some legs"
          description={`Unpriced: ${(g?.unpriced ?? []).join(', ')}. The net figures EXCLUDE these, so read them as a lower bound rather than the book's risk.`} />
      ) : null}
      {(g?.fallbackPriced?.length ?? 0) > 0 ? (
        <Banner status="info" title="Some legs are model-priced"
          description={`${(g?.fallbackPriced ?? []).join(', ')}: the quote admits no IV (deep-ITM legs price off the future and quote below the cash no-arbitrage floor), so mark and greeks are computed theoretically off spot and expiry at the book's median vol. They ARE in every total — as estimates.`} />
      ) : null}

      {/*
        THE STRATEGY'S CURRENT REASON, ABOVE THE TILES IT TALKS ABOUT.

        It reads claim-then-evidence: "netΓ -3.8 — allowance 188 under one lot"
        is a statement about the Net gamma and Delta-neutral tiles directly
        below it, and about the margin tile beside them. Putting it above means
        the answer to "is it going to do anything about this?" is on screen
        WITH the numbers that raise the question, instead of one page down.

        Renders nothing at all until a reason exists, so this costs no vertical
        space on a book that has never reported one.
      */}
      <StrategyReasonLine decisions={decisionsError === null ? decisions : null} />

      {/*
        `columns={4}` WAS FOUR COLUMNS AT EVERY WIDTH — four 90px cards on a
        phone, with "Theta / day" and its figure each on their own line. The
        object form caps the count, while letting the row fall to two and then one
        as the viewport narrows. It is the design system's own responsive API;
        see Grid.tsx.

        THE CAP IS 5 AND NOT 4 because this strip is NINE tiles now. At four it
        ran 4 + 4 + 1: three empty slots and a whole extra row of page for one
        card, which is the white space this pass exists to remove. At five it is
        5 + 4, and the leftover slot is a single one — and it lands so that the
        three LEVEL tiles (Δ0, margin, breakeven) share the second row rather than
        being split across a row break. The `minWidth: 160` floor is untouched, so
        a phone still falls to two columns: five tracks would be 60px there and
        the floor wins.
      */}
      {/*
        ONE CARD, DIVIDED — not a card per figure.

        This was eleven `Card`s in a wrapping grid: eleven borders, eleven
        shadows and eleven insets for eleven numbers, most of a screen spent on
        chrome before the positions table starts. Operator's call 2026-08-14
        ("i see too many boxes ... can we compact this view"). The rules are in
        comfort.css, and they are VERTICAL ONLY — dividing both ways draws a
        lattice whose horizontal half separates rows that are already separated
        by being on different rows.
      */}
      <Card padding={0}>
        <div className="stat-grid">
        {/*
          MTM LEADS (operator's call, 2026-08-04): the first tile the eye
          lands on is "how is this book doing", then the greeks explain it.

          Chip total first, browser recompute only as the fallback — so this
          tile and the strategy's P&L chip are ONE number, not two estimates.
        */}
        <StatCell
          label="P&L"
          /*
            SINCE ENTRY, THE SAME NUMBER AS THE TABLE'S TOTAL ROW — one
            computation (`sinceEntryTotal`), not two estimates. This tile used
            to show the DAY figure off the journal while the table foot showed
            the book since entry, and the pair read as a discrepancy every
            single session (operator's call 2026-08-18: "keep one only, both
            places, not two different values"). Day-anchored P&L still exists
            where day is the question: the after-close broker reconciliation
            reads the journal, not this tile.
          */
          labelNote={netIfClosed ? 'net if closed now' : 'since entry'}
          title={
            netIfClosed
              ? 'What closing the whole book now would leave in the account: open legs at their ' +
                'closing prices against their entries, plus what closed legs booked, less every fee ' +
                'paid and the estimated fees to close the open legs — the Net if closed now row ' +
                'under the table. Null the moment any open leg is unpriced.'
              : 'Open legs marked against the prices the desk entered them at, plus what has been ' +
                'booked on closed legs — the same figure as the Total row under the table, computed ' +
                'from the same payload. Null the moment any open leg is unpriced.'
          }
          value={sinceEntry === null ? '—' : money(sinceEntry)}
          {...(sinceEntry === null ? {} : { tone: sinceEntry })}
        />
        {/*
          THE BOOK'S OWN DELTA, and it is the figure the `Pos delta` column in
          the table below sums to. That check by eye is the reason both come
          from one engine — see `positions()` in the bridge's service.ts.

          Under SHORTS-ONLY the check still holds against the short rows —
          same engine, smaller set — EXCEPT when the tile shows the strategy's
          declared steering figure, which prices off the future and cannot sum
          to a cash-spot column. That is the one case, and the label note
          ("· steering") is what marks it.
        */}
        <StatCell
          label="Net delta"
          /*
            THE STEERING FIGURE RIDES ON THE LABEL, not in a cell of its own.

            It had one, and that made the header eleven cells during market
            hours and ten outside them — so the block was 5x2 at 16:00 and
            5+5+1 at noon, with Breakeven ↓ landing under Breakeven ↑ only
            after the close. A layout that reshuffles when the market opens is
            worse than a slightly denser cell.

            On the label line it also costs no height, which is what keeps every
            row the same. Shown only when it DIFFERS from the book's own delta —
            with `delta_shorts_only` off the two coincide and repeating the
            number would say nothing.

            UNDER SHORTS-ONLY the tile IS the steering figure — the declared
            one when the strategy published it, the engine's short-leg sum
            when it did not — so the note switches to naming the source
            instead of comparing against it.
          */
          {...(shortsOnly
            ? shortsNote()
            : pos?.steering != null && g !== undefined && !nothingPriced
              && Math.round(pos.steering.delta) !== Math.round(g.netDelta)
              ? { labelNote: `steering ${greek(pos.steering.delta)}` }
              : {})}
          value={steered !== null ? signed(steered.delta) : greek(gView?.netDelta)}
          tone={
            steered !== null
              ? steered.delta
              : gView === undefined || nothingPriced ? null : gView.netDelta
          }
        />
        <StatCell
          label="Delta-neutral (Δ0)"
          {...(shortsOnly ? { labelNote: 'shorts only' } : {})}
          value={
            viewTotals.neutral === null
              ? '—'
              : `${inr(viewTotals.neutral.price, 1)} (${signed(viewTotals.neutral.pct, 1)}%)`
          }
          tone={viewTotals.neutral === null ? null : viewTotals.neutral.pct}
        />
        {/*
          MARGIN IS AN ACCOUNT FIGURE AND THE LABEL SAYS SO.

          There is no per-book margin to show and there is no honest way to
          derive one: SPAN + exposure is computed by the exchange over the whole
          account and is not additive across books, so two books hedging each
          other consume less together than either alone. Splitting one number
          across the open books would be a figure no broker statement agrees
          with, on the tile an operator sizes the next trade from. See
          `BrokerFunds` — including why a dash is the normal answer today.

          NO TONE. High utilisation is not a loss and low is not a gain; it is a
          headroom reading, and tinting it would put it in the same visual
          language as the P&L two tiles away.
        */}
        {/*
          THE AMOUNT, NEVER A PERCENTAGE. A utilisation needs a denominator,
          and the broker's is a dealer-account placeholder (₹100Cr "cash
          available"), not this desk's capital — 9.6L of real margin read as
          "0%". The desk's actual cap (₹1Cr per live variant book) lives in
          the Python config, which this page cannot see; printing the lakhs
          lets the operator do that division against the cap they set.
        */}
        <StatCell
          label="Margin (book)"
          value={
            bookMargin?.available === true && bookMargin.brokerTotal !== undefined
              ? inrCompact(bookMargin.brokerTotal)
              : '—'
          }
          labelNote={
            /*
              NO NOTE UNDER A FRESH FIGURE — the note line is what made this
              tile taller than its row. It appears only when the number needs a
              qualifier: nothing to show, or something to distrust.

              AGE IS THE QUALIFIER THAT MATTERS. A margin figure that silently
              keeps reading as current when the refresh has been failing for an
              hour is the same class of bug as the account figure this tile
              replaced — a number that looks like it answers your question and
              does not. So a stale or failed refresh SAYS SO, right here.
            */
            bookMargin === null
              ? 'reading…'
              : bookMargin.available !== true
                ? 'not priced yet'
                : bookMargin.stale === true || bookMargin.ok === false
                  /*
                    THE DOCUMENT'S AGE WINS WHENEVER IT IS THE WORSE ONE — and
                    it usually is. Two different ages could go here: when the
                    BROWSER last read the figure, and when the GATEWAY last
                    priced it. A margin repriced an hour ago is an hour stale
                    however recently this page fetched it, so a stale or failed
                    refresh keeps saying so and the read's age never gets to
                    cover for it.
                  */
                  ? ago(bookMargin.ageMs ?? 0)
                  // Fresh at the source: the only age left to state is this
                  // page's own, which is what the 60s cadence means in seconds.
                  : asOf(marginAt)
          }
          title={
            bookMargin?.available === true
              ? `SPAN ${inr(bookMargin.brokerSpan ?? 0, 0)} + exposure ${inr(bookMargin.brokerExposure ?? 0, 0)}` +
                `${bookMargin.premiumPaid ? ` + premium paid ${inr(bookMargin.premiumPaid, 0)}` : ''}` +
                `${bookMargin.calibrated === true
                    ? `\nAt broker rates (span x${(bookMargin.spanRatio ?? 1).toFixed(3)}, exposure x${(bookMargin.exposureRatio ?? 1).toFixed(3)} vs the calculator).`
                    : '\nAT CALCULATOR BASE RATES — no broker ratio available, so this may understate what the broker charges.'}` +
                '\nStandalone: what this book alone would cost. Per-book figures do ' +
                'not sum to account utilisation — SPAN scans the whole portfolio at once.' +
                `${bookMargin.ok === false && bookMargin.diagnostic ? `\nLast refresh failed: ${bookMargin.diagnostic}` : ''}`
              : (bookMargin?.reason ?? 'reading…')
          }
        />
        {/*
          THE RANGE THIS RUN SURVIVES, at expiry.

          Arithmetic on strikes, entry prices, signed quantities and the booked
          figure — see `bookBreakevens`. It needs no mark and no greek, which is
          why it is the one tile in this row that keeps its figures when the
          feed stops.

          UP IS GREEN AND DOWN IS RED, the same convention as Δ0 beside it and
          the same `sign()` ramp: the tint carries the side of spot, and the
          arrows carry it again for anyone reading in greyscale. An em dash on
          one side is not a failure — a one-sided book has one breakeven, and a
          hedged wing that ends profitable has none on that side at all.
        */}
        {/*
          BOTH SIDES IN ONE TILE.

          They were split so every tile in the row was a single line and the
          bottom edge stayed flat. That traded a taller box for two more boxes,
          and with the greeks moved out of this grid the count is what costs
          more — a range is ONE fact with two ends, and reading it as a range
          is easier when the ends are adjacent.

          Up is green and down is red, the same `sign()` ramp as Δ0 beside it,
          with the arrows carrying it again for anyone reading in greyscale. An
          em dash on one side is not a failure: a one-sided book has one
          breakeven, and a hedged wing that ends profitable has none there.
        */}
        {/*
          ONE CELL PER SIDE, so every cell in the card is label + one value and
          the rows come out the same height. Stacked, this was the tallest thing
          in the grid and every neighbour carried the difference as blank space.

          Up is green and down is red — the same `sign()` ramp as Δ0, with the
          arrows carrying it again for anyone reading in greyscale. An em dash on
          one side is not a failure: a one-sided book has one breakeven, and a
          hedged wing that ends profitable has none there.
        */}
        <StatCell
          label="Breakeven ↑"
          {...bookedNote()}
          value={
            be?.up === undefined || be?.up === null
              ? '—'
              : `${inr(be.up.price, 1)} (${signed(be.up.pct, 1)}%)`
          }
          tone={be?.up === undefined || be?.up === null ? null : be.up.pct}
        />
        {/*
          GAMMA, VEGA, THETA AND NET TV, demoted by TYPE SIZE rather than by a
          band of their own — "not that important while monitoring", but not
          dropped either: a short-premium book IS a theta engine and vega is
          what a vol spike does to it.

          IN THE SAME GRID as the figures above, which is what lets the block
          fall out as 5x2. A second grid forced the first to hold everything
          else and pushed Breakeven ↓ onto a row by itself.
        */}
          {/* Gamma is the second figure the steering pair declares, so it
              follows the same rule as the delta tile above: the strategy's
              own number under shorts-only when one was published, the
              engine's short-leg sum otherwise, named on the label either
              way. Vega and theta have no declared counterpart — the
              declaration carries only the pair the rules band on — so they
              are always the engine's. */}
          <StatCell label="Net gamma"
            {...shortsNote()}
            value={steered !== null ? signed(steered.gamma, 1) : greek(gView?.netGamma, 1)}
            tone={
              steered !== null
                ? steered.gamma
                : gView === undefined || nothingPriced ? null : gView.netGamma
            } />
          <StatCell label="Net vega"
            {...(shortsOnly ? { labelNote: 'shorts only' } : {})}
            value={greek(gView?.netVega)}
            tone={gView === undefined || nothingPriced ? null : gView.netVega} />
          <StatCell label="Theta / day"
            {...(shortsOnly ? { labelNote: 'shorts only' } : {})}
            value={greek(gView?.netTheta)}
            tone={gView === undefined || nothingPriced ? null : gView.netTheta} />
          {/* Net TV is what the book still holds of the premium it sold —
              positive means time value COLLECTED, which is why it tints
              like a gain. Under shorts-only it is the premium still held ON
              THE SHORTS, the decay the rules are actually farming. */}
          <StatCell label="Net time value"
            {...(shortsOnly ? { labelNote: 'shorts only' } : {})}
            value={viewTotals.netTv === null ? '—' : signed(viewTotals.netTv)}
            tone={viewTotals.netTv === null ? null : viewTotals.netTv} />
        {/*
          LAST IN THE GRID, so at five columns it lands in column 5 of row 2 —
          directly under Breakeven ↑, which is how a range is read.

          DONE BY ORDER RATHER THAN BY `grid-column`, deliberately. Explicit
          placement would put this cell in column 5 while the vertical-rule
          suppression is `nth-child(5n + 1)` — the rule would then be dropped
          from whichever cell happened to be sixth and drawn on the one actually
          opening the row. Ordering keeps the arithmetic and the layout agreeing
          at every breakpoint instead of only at this one.

          The cost is that the two breakevens are no longer adjacent in the DOM,
          so a screen reader meets ↓ after the greeks rather than beside ↑. The
          label carries the arrow, so each still says which side it is on.
        */}
        <StatCell
          label="Breakeven ↓"
          {...bookedNote()}
          value={
            be?.down === undefined || be?.down === null
              ? '—'
              : `${inr(be.down.price, 1)} (${signed(be.down.pct, 1)}%)`
          }
          tone={be?.down === undefined || be?.down === null ? null : be.down.pct}
        />

        </div>
      </Card>

      {/*
        THE DELTA ACCOUNTS' MARGIN — balance, available, used, % utilized, for
        demo and live. An account figure, beside the book's own tiles because
        it is what the next straddle is sized against. See `margin.tsx`.
      */}
      <AccountMarginPanel />

      {/*
        THE PAYOFF COCKPIT, directly under the tiles it explains.

        The header above states the book's position — its P&L, its greeks, where
        it breaks even. This panel states its SHAPE: what the same book is worth
        across a ±10% move, on three dates, and what the strategy is about to do
        about it. Read together, the tile says "delta -412" and the panel says
        what a 10% move costs and whether the bot would shed it.

        Rendered only for a chosen book: it is tag-scoped at the server (there is
        no all-books payoff) and the empty state above already says no book is
        selected. It polls on its OWN 60s cadence — see `PayoffPanel`; this page
        reads positions at 5s and that rate would be twelve times a chain solve
        per minute for a curve that moves with the future.
      */}
      {tag === null ? null : <PayoffPanel tag={tag} mode={props.mode} />}

      <Card padding={3}>
        <VStack gap={2}>
          <HStack justify="between" align="center" wrap="wrap">
            <Heading level={3}>Positions</Heading>
            {/*
              Both counts, but only when they differ. The table is contracts and
              the desk is legs, and "5 legs" over four rows is the confusion this
              whole change is undoing — while "4 contracts · 4 legs" on an
              unmerged book is a distinction the operator has no reason to read.
            */}
            <Text color="secondary" size="sm">
              {`${positionCount} · ${pos === null ? '—' : localTime(pos.asOf)}`}
            </Text>
          </HStack>
          <Table
            data={sortedWithTotal}
            columns={columns}
            density="compact"
            hasHover
            plugins={{ sort: sortPlugin }}
          />
        </VStack>
      </Card>

      <DeskBridgeDiff tag={tag} diff={diff} error={diffError} />

      {/* Its own `isOpen` handles the null target — the books.tsx pattern. */}
      <ManualOrderDialog
        target={
          !ordering || pos === null || pos.legs.length === 0
            ? null
            : { tag: pos.tag, symbol: pos.symbol, expiry: pos.legs[0]?.expiry ?? '' }
        }
        mode={props.mode}
        reauth={reauth}
        onClose={() => setOrdering(false)}
      />

      {/*
        Its own `isOpen` handles the null target too. `onSaved` takes the whole
        merged map the server answered with — not a local edit of the one key —
        so what the badges show is what the desk actually stored, and a
        concurrent change by the supervisor is visible immediately rather than
        at the next poll.
      */}
      <ProtectDialog
        target={protectFor}
        mode={props.mode}
        reauth={reauth}
        onClose={() => setProtectFor(null)}
        onSaved={(map) => {
          if (tag !== null) setPinned({ tag, mode: props.mode, map })
          refreshProtection()
        }}
      />
      {reauth.dialog}
    </VStack>
  )
}

/**
 * One book at a time, chosen by a tab.
 *
 * The previous shape — a separate "books" list page you clicked through — put a
 * navigation step between the operator and the only thing they came to see. With
 * a handful of books, tabs show every one at once and land you in one.
 *
 * TABS ARE KEYED BY TAG, NOT SYMBOL (since Phase 0). A symbol can now carry
 * several variants open at once — several tags on one underlying — so a symbol
 * alone no longer identifies which book a tab means, and the tab label says
 * both: `<symbol> · <tag>`.
 *
 * The selected tag lives in the URL (`#/positions/<tag>`), so a reload keeps
 * your place and a position can be linked to. The MODE does not: it is the
 * navbar switch, and a link that silently changed someone's mode would be worse
 * than one that cannot carry it.
 */
export function BookTabsPage(props: {
  mode: DeskMode
  tag: string | null
  onSelect: (tag: string) => void
}): React.ReactElement {
  const { data, error } = usePoll(() => api.books(props.mode), 5000, [props.mode])
  /**
   * BY TAG, WHICH BEGINS WITH THE SYMBOL — so the P&L chips and the book tabs
   * list the same books in the same order.
   *
   * They came off two endpoints with two natural orders and read as two
   * different sets: the chips said BHEL, DLF, TCS while the tabs above the very
   * same books said TCS, DLF, BHEL. On a strip you scan across, an order that
   * shifts is an order you have to re-read every time.
   *
   * Sorted on the CLIENT rather than trusted from either server, because the two
   * would then have to agree forever across two endpoints and two code paths.
   */
  const declared: BookSummary[] = [...(data?.books ?? [])].sort((a, b) => a.tag.localeCompare(b.tag))
  /**
   * A TAB IS A POSITION, NOT A STORED BOOK.
   *
   * The listing is every `desk-books` document on the rail, and a dated book
   * is a document for two sessions longer than it is a position: created in
   * the morning, flattened at the close, stopped the next day, erased the
   * session after (`book-series.ts`). Today's books also exist, empty, from
   * registration until their first fill. The operator opened this page on
   * 2026-10-13 to eleven tabs of which three held anything, and had to scan
   * the strip for them. `legs` is the stored leg count — a closed leg is
   * folded out of the document, so zero means flat, not "unpriced".
   *
   * A flat book is still a book: it keeps its row on the Books page, which
   * is where its lifecycle lives. It just has nothing to show HERE.
   */
  const books: BookSummary[] = declared.filter((b) => b.legs > 0)
  /**
   * A TAG THAT IS NOT ON THIS RAIL IS NOT SELECTED. The tag rides the route,
   * and the route survives the PAPER/LIVE toggle — so a live book stayed
   * "selected" on the paper page, rendering a ghost section of dashes whose
   * desk-vs-bridge diff then compared the desk's LIVE declaration against
   * paper holdings and cried "out of sync" over four legs we hold fine, on
   * the other rail. Until the list has LOADED the route's tag stands — a
   * membership test against a list that is merely still in flight would blank
   * the page on every boot.
   */
  const active = data === undefined
    ? props.tag
    : props.tag !== null && books.some((b) => b.tag === props.tag)
      ? props.tag
      : books[0]?.tag ?? null
  /**
   * PHONE TABS SAY `TCS`, NOT `TCS · TCS-2026-08-25-recenter-relief-r`.
   *
   * The strip scrolls (see `.desk-book-tabs`), and a scrolled-away tab is a
   * book the operator does not know is open — at full labels ONE tab fills a
   * phone. Symbol-only puts every book on screen at once. Two books on the
   * same symbol would collide, so only then does the tag come back, on the
   * phone too: ambiguity is worse than scrolling.
   */
  const phone = useMedia(PHONE)
  const dupSymbol = new Set(
    books.filter((b) => books.some((o) => o.tag !== b.tag && o.symbol === b.symbol)).map((b) => b.symbol),
  )

  return (
    <VStack gap={3}>
      {error !== null ? <Banner status="error" title="Cannot reach the bridge" description={error} /> : null}

      {/*
        The P&L cards live HERE rather than on a dashboard of their own. The
        mode they report is the navbar switch, and the rule at the top of the
        page is what says which — the cards carry no mode field of their own for
        the reader to check.
      */}
      <PnlCards mode={props.mode} />

      {/*
        "NOTHING IS OPEN" IS ONLY SAID WHEN THE LIST ARRIVED SAYING SO.

        It used to be `books.length === 0`, which is also true of a list that
        never loaded — so a bridge that could not be reached rendered the same
        reassuring card as a genuinely flat desk, with the error banner above it
        asserting the opposite.
      */}
      {data === null && error !== null ? null : data === null ? (
        <Text color="secondary">Loading books…</Text>
      ) : books.length === 0 && declared.length > 0 ? (
        /*
          EVERY DECLARED BOOK IS FLAT. Not the card below: that one says no
          book has been declared, which would be a lie told right after the
          filter above hid the books that were. Said per book so the operator
          can tell "yesterday's five, erased tomorrow" from "the one I expected
          to be open by now".
        */
        <Card padding={3}>
          <VStack gap={2}>
            <Heading level={3}>No open {props.mode} positions</Heading>
            <Text color="secondary">
              {declared.length === 1 ? 'The one declared book' : `All ${declared.length} declared books`}
              {' '}hold no legs: {declared.map((b) => b.tag).join(', ')}.
              {' '}A book that opens a position shows up here on the next poll; the books themselves
              are on the Books page.
            </Text>
          </VStack>
        </Card>
      ) : books.length === 0 ? (
        <Card padding={3}>
          <VStack gap={2}>
            <Heading level={3}>No {props.mode} books</Heading>
            {/*
              IT NO LONGER CLAIMS "NOTHING IS OPEN". A book here is one the
              desk DECLARED — the only thing that carries per-book greeks. A
              hosted strategy never declares one, so this card sat under a
              screenful of P&L telling the operator they were flat when they
              were not. What is actually open is in "Open legs" above.
            */}
            <Text color="secondary">
              No book has been declared on this rail. This lists declared books, which is what
              per-book greeks are computed over — any position a hosted strategy is holding is
              on its own strategy page, beside the P&amp;L that explains it.
            </Text>
          </VStack>
        </Card>
      ) : (
        /*
          THE STRIP IS WRAPPED SO IT CAN SCROLL, and that wrapper is the fix for
          the phone rendering the whole desk in the left half of the screen.

          A tab labelled `DLF · DLF-2026-08-25-hold-recycle-r` is ~385px of
          non-shrinking, non-wrapping text; two of them overflowed a 390px
          viewport, and a mobile browser answers a document wider than the
          viewport by zooming the PAGE out until it fits. `.desk-book-tabs` in
          responsive.css carries the full account of why — including why the
          overflow cannot go on the `TabList` itself without clipping the
          selected tab's underline.
        */
        <VStack gap={0} className="desk-book-tabs">
        <TabList
          value={active ?? ''}
          onChange={(v) => props.onSelect(v)}
          layout="hug"
          hasDivider
        >
          {books.map((b) => (
            <Tab
              key={b.tag}
              value={b.tag}
              label={phone && !dupSymbol.has(b.symbol) ? b.symbol : `${b.symbol} · ${b.tag}`}
              /*
                `complete` IS RENDERED, ALWAYS.

                A book whose every leg is unpriced can total to a perfectly
                honest-looking 0 — indistinguishable, on a tab, from a book that
                is genuinely flat, while it carries real unpriced risk. The
                delta alone cannot carry that distinction, so the badge does:
                without it the most dangerous state on this page is also the
                calmest-looking one.
              */
              endContent={
                <HStack gap={2} align="center">
                  {b.complete ? null : <Badge variant="warning" label="partial" />}
                  {/*
                    The Δ names the quantity. Without it this badge reads as
                    money — the operator asked why "the MTM in the tab"
                    disagreed with the P&L chip, and the honest answer was
                    that it was never P&L at all.
                  */}
                  {/*
                    DISTANCE FROM Δ0, NOT RAW DELTA (operator's call 2026-08-14).

                    A net delta is not comparable across books: +176 means one
                    thing on BHEL at 426 and something quite different on TCS at
                    2355, and this strip exists precisely to be scanned across
                    all three at once. The percentage is the same question in a
                    unit that travels — and it sidesteps the book-vs-steering
                    delta split, which is a distinction that belongs on the tile
                    where there is room to label it, not on a tab.

                    Falls back to the raw delta on a server a deploy behind, so
                    the strip degrades to what it showed yesterday rather than
                    to dashes.
                  */}
                  <Text
                    color="secondary"
                    style={
                      b.neutralPct !== undefined
                        ? sign(b.neutralPct)
                        : b.netDelta === null ? undefined : sign(b.netDelta)
                    }
                  >
                    {b.neutralPct !== undefined
                      ? `Δ0 ${signed(b.neutralPct, 1)}%`
                      : b.netDelta === null ? '—' : `Δ ${signed(b.netDelta)}`}
                  </Text>
                </HStack>
              }
            />
          ))}
        </TabList>
        </VStack>
      )}

      {/*
        `key` ON THE TAG, so switching tabs REMOUNTS rather than re-rendering.

        Every poll on that page keeps its last successful payload across a
        deps change (`usePoll` clears data on neither error nor tag), so
        without this the new tab paints the PREVIOUS book's positions, greeks,
        diff and strategy reason under the new book's name until each request
        comes back — up to a full poll interval, and indefinitely for any read
        that is failing. A book's numbers shown under another book's tab are
        not stale data, they are wrong data.
      */}
      {active === null ? null : <PositionsPage key={active} mode={props.mode} tag={active} />}

      {/*
        The legs the P&L netted, which the books above CANNOT show: `desk-books`
        holds only what the Python desk declared, so a hosted strategy's real
        exposure appeared nowhere on this page. Renders nothing when flat.

        LAST, not first (operator's call, 2026-08-04): the selected book's own
        table shows the same legs with marks, so this consolidated list is the
        cross-check, not the headline.
      */}
      <OpenLegs mode={props.mode} />
    </VStack>
  )
}

// -------------------------------------------------------------------- feed

/**
 * Market-data health, AS A SECTION rather than a page.
 *
 * It had its own nav tab and its own screen. Feed health, broker credentials
 * and "is every process actually running?" are three halves of one question an
 * operator asks in one breath — "is the desk working?" — and answering it used
 * to mean visiting two tabs and knowing that neither of them says anything
 * about the runner or the supervisors. They are one Status page now; this is
 * the middle third of it, unchanged in what it measures and says.
 *
 * `level={3}`, because it is no longer the title of the screen it is on.
 */
export function FeedSection(): React.ReactElement {
  const { data, error, updatedAt } = usePoll<FeedStatus>(() => api.feed(), 3000)
  /**
   * A SHUT MARKET IS NOT A BROKEN FEED — but a quiet feed alone cannot tell the
   * difference, and this page used to shout "Feed is down" in red every weekend
   * for a system in which nothing was wrong. Two days a week of false alarm is
   * how the red state stops being read on the third.
   *
   * `sessionOpen` comes from the bridge (`routes/health.ts`), which asks
   * `@algomaker/core`'s one session rule — not from this browser's clock, so
   * the wording and the numbers describe the same moment. ABSENT MEANS LOUD: an
   * older bridge sends no such field, and an unexplained silence is still worth
   * shouting about.
   *
   * Nothing measured changes. `feedAlive` is still the feed's own answer and
   * `ready` is still the deployment smoke test; only the words move.
   */
  const closed = data?.sessionOpen === false
  const down = data !== null && !data.feedAlive && !closed
  const quiet = data !== null && !data.feedAlive && closed

  return (
    <VStack gap={3}>
      {/*
        "Feed", not "Market data" — the name the nav tab carried for this exact
        screen, and now also the name that keeps it distinct from the SYSTEMS
        card above it. That card is about the desk-marketdata PROCESS ("is it
        still publishing?"); this section is about the FEED it publishes ("can
        the desk price what it holds?"). Two cards both headed "Market data",
        answering different questions, is a page nobody can read.
      */}
      <HStack gap={2} align="center" wrap="wrap">
        <Heading level={3}>Feed</Heading>
        {/*
          THE AGE OF THIS ANSWER, beside the heading it belongs to.

          "Last tick" below times the EXCHANGE; this times the READ. They are
          different failures and the page could not tell them apart: when the
          bridge stops answering, `usePoll` keeps the last payload — by design —
          so "Last tick 2s ago" stayed frozen at 2s and the section went on
          describing a healthy feed with nothing moving. The banner above says
          the read failed; this says how long it has been failing.
        */}
        {asOf(updatedAt) === undefined ? null : (
          <Text size="sm" color="secondary">{asOf(updatedAt)}</Text>
        )}
      </HStack>
      {error !== null ? <Banner status="error" title="Cannot reach the bridge" description={error} /> : null}
      {down ? (
        <Banner status="error" title="Feed is down"
          description="No tick has arrived recently. Every mark is untrustworthy and no new position can be priced." />
      ) : null}
      {quiet ? (
        <Banner status="info" title="Market closed — no ticks since the last session"
          description="Nothing is wrong: the exchange is shut, so there is nothing to tick. Marks below are the last ones that were true, and no new position can be priced against them." />
      ) : null}

      {/* Capped at four, collapsing to two and one. See the greeks strip above. */}
      <Grid columns={{ minWidth: 160, max: 4 }} gap={3}>
        <Stat label="Status" value={data === null ? '—' : data.feedAlive ? 'live' : closed ? 'closed' : 'DOWN'} />
        <Stat label="Usable marks" value={data === null ? '—' : `${data.marksHeld} / ${data.subscribedTokens}`} />
        <Stat label="Chain coverage" value={data === null ? '—' : `${(data.coverage * 100).toFixed(0)}%`} />
        <Stat label="Last tick" value={data === null ? '—' : ago(data.msSinceLastTick)} />
      </Grid>

      <Card padding={3}>
        <VStack gap={2}>
          <HStack justify="between" align="center" wrap="wrap">
            <Heading level={3}>Readiness</Heading>
            {/*
              WHICH RAIL THE BOOK COUNTS ARE. The endpoint answers for paper
              only, and this page is reachable under the red LIVE rule —
              counting "the books the desk holds" with no qualifier there states
              the wrong rail in the loudest possible frame.
            */}
            <ModeBadge mode={data?.mode ?? 'paper'} />
          </HStack>
          {/*
            "not yet" describes a WAIT — the 60-90s warm-up after a restart —
            and off-hours nothing is being waited for. `ready` itself is
            untouched (it is what the deployment smoke test polls); this is the
            same value, said in words that are true on a Saturday. The warn tone
            goes with it: an amber row every weekend is an amber row nobody
            reads on Monday.
          */}
          <Row
            label="Ready for decisions"
            value={data?.ready === true ? 'yes' : closed ? 'not trading — market closed' : 'not yet'}
            {...(data?.ready === true || closed ? {} : { tone: 'warn' as const })}
          />
          {/*
            COUNTS, NOT NAMES — the endpoint is unauthenticated and no longer
            says which symbols the desk is in. `/v1/desk/books` is where the
            names live, behind auth, on Positions.
          */}
          <Row label="Books held" value={data === null ? '—' : inr(data.bookCount)} />
          <Row
            label="With an unmarked leg"
            value={data === null ? '—' : inr(data.booksIncomplete)}
            {...(data !== null && data.booksIncomplete > 0 ? { tone: 'warn' as const } : {})}
          />
          {/* Measured against the legs held, not chain coverage: far strikes
              trade rarely, so coverage plateaus near 90% on a healthy feed. */}
          <Text color="secondary" size="sm">
            Ready means the feed is live and every leg the desk holds has a mark — holding
            nothing counts as ready. After a restart it takes 60–90s for every held leg to tick.
          </Text>
        </VStack>
      </Card>
    </VStack>
  )
}


// ---------------------------------------------------------------- controls

/**
 * What releasing the halt makes possible, in the operator's terms.
 *
 * IT NAMES BOTH RAILS. The kill switch has no mode — `safety.ts` stores one
 * flag and the gate consults it for paper and live alike — and this page sits
 * under a mode switch, so a statement that said only "including live ones" left
 * the reader to infer which book they had just re-armed.
 */
const RELEASE_STATEMENT =
  'Releasing the kill switch lets every enabled strategy open NEW exposure again — ' +
  'on BOTH rails, paper and live, whichever this page is showing. Positions that are ' +
  'already open are unaffected either way: the halt never blocked an exit.'

/**
 * What resuming live execution makes possible, in the operator's terms.
 * Resuming is the password-gated direction: it makes live orders placeable again.
 */
const RESUME_STATEMENT =
  'Resuming live execution lets the desk send live orders to Delta again for every ' +
  'strategy switched on for LIVE.'

/**
 * The result of a close-all, said in full.
 *
 * `fills.length` ALONE IS A SUCCESS LINE FOR A BOOK THAT IS STILL OPEN. A
 * close-all can skip legs before they reach a rail, fail to route the ones that
 * did, and answer 200 for all of it — the server reports each separately and
 * this is where that has to be read. `book` is the legs still standing
 * afterwards, which is the only field that answers "is it closed?".
 */
function CloseAllReport(props: { symbol: string; style: string; result: CloseAllResult }): React.ReactElement {
  const r = props.result
  const bad = closeAllFailed(r)
  return (
    <Banner
      status={bad ? 'error' : 'success'}
      title={
        bad
          ? `Close-all ${props.symbol} (${props.style}) did NOT fully close the book`
          : `Close-all ${props.symbol} (${props.style}): flat`
      }
      description={
        <VStack gap={1}>
          <Text size="sm">
            {`${inr(r.fills.length)} filled · ${inr(r.skips.length)} skipped · ` +
              `${inr(r.routeErrors.length)} failed to route · ${inr(r.book.length)} still open`}
          </Text>
          {/* A replay routed NOTHING. Read as a fresh success it is the worst
              possible misreading: it means the earlier attempt is the one that
              did or did not work. */}
          {r.replayed ? (
            <Text size="sm">
              This decision had already run — nothing new was sent. The figures above are
              the ORIGINAL attempt&apos;s.
            </Text>
          ) : null}
          {r.skips.map((s) => (
            <Text key={`s${s.action.ts}`} size="sm">{`skipped ${s.action.ts}: ${s.reason}`}</Text>
          ))}
          {r.routeErrors.map((e) => (
            <Text key={`e${e.fill.tradingsymbol}${e.fill.ts}`} size="sm">
              {`${e.fill.tradingsymbol} did not route: ${e.error}`}
            </Text>
          ))}
          {r.unpriceable.length > 0 ? (
            <Text size="sm">{`No mark to price them, sent at the fast (aggressive limit) price: ${r.unpriceable.join(', ')}`}</Text>
          ) : null}
          {r.book.length > 0 ? (
            <Text size="sm">
              {`Still open: ${r.book.map((l) => `${l.instrument.tradingsymbol} (${signed(l.qty)})`).join(', ')}`}
            </Text>
          ) : null}
        </VStack>
      }
    />
  )
}

/**
 * THE DESTRUCTIVE ACTIONS FOLLOW THE NAVBAR SWITCH — except the halt, which has
 * no mode at all.
 *
 * This page used to own a mode toggle of its own, on the argument that a
 * flatten should be stated rather than inherited. That argument does not
 * survive one switch: two controls that both claim to say which book you are
 * acting on is the ambiguity, not the safeguard — the operator would be reading
 * one and clicking the other.
 *
 * What makes it safe instead is that the switch is unmissable: a 3px red rule
 * across the page and the LIVE badge beside the buttons that DO follow it.
 * Which is also why the kill switch card carries no badge: it is global, and a
 * mode badge beside a global control is a claim that it is scoped.
 */
export function ControlsPage(props: { mode: DeskMode }): React.ReactElement {
  const mode = props.mode
  const { data: ks, error, refresh } = usePoll(() => api.killSwitch(), 4000)
  const [busy, setBusy] = useState(false)
  /** The halt is global, so its message is NOT cleared when the mode changes. */
  const [haltNote, setHaltNote] = useState<string | null>(null)
  const reauth = useReauth()
  /**
   * LIVE EXECUTION — the broker-link document, global like the halt. The api
   * enforces it itself (every live order refused while `released`), so there
   * is no gateway ack to wait on.
   */
  const { data: link, error: linkError, refresh: refreshLink } = usePoll(() => api.brokerLink(), 4000)
  const [linkNote, setLinkNote] = useState<string | null>(null)

  /**
   * PAUSING asks for nothing; RESUMING asks for the password. Same shape as
   * `toggle` below, and the same 403-retry: the server is the authority on
   * which direction needs re-auth.
   */
  const toggleLink = async (): Promise<void> => {
    if (link === null) return
    const resuming = link.desired === 'released'
    let password: string | null = null
    if (resuming) {
      password = await reauth.ask(RESUME_STATEMENT)
      if (password === null) return
    }
    setBusy(true)
    try {
      for (;;) {
        try {
          const desired = resuming ? 'connected' : 'released'
          const reason = resuming ? '' : 'paused from dashboard'
          if (password === null) await api.setBrokerLink(desired, reason)
          else await api.setBrokerLink(desired, reason, password)
          setLinkNote(
            resuming
              ? 'Live execution resumed — live orders can reach Delta again.'
              : 'Live execution PAUSED — every live order, exits included, is refused until you resume. ' +
                'Paper trading carries on.',
          )
          refreshLink()
          return
        } catch (err) {
          if (err instanceof ApiError && err.reauthRequired) {
            const again = await reauth.ask(RESUME_STATEMENT, err.message)
            if (again === null) return
            password = again
            continue
          }
          throw err
        }
      }
    } catch (err) {
      setLinkNote(explain(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * RELEASING asks for the password; ENGAGING does not.
   *
   * Putting a prompt in front of the emergency brake would be a delay on the one
   * action that is never the dangerous one. The server enforces the same
   * asymmetry — the 403 retry below exists because the server, not this page,
   * is the authority on it.
   */
  const toggle = async (): Promise<void> => {
    if (ks === null) return
    const releasing = ks.enabled
    let password: string | null = null
    if (releasing) {
      password = await reauth.ask(RELEASE_STATEMENT)
      if (password === null) return
    }
    setBusy(true)
    try {
      for (;;) {
        try {
          const reason = releasing ? '' : 'engaged from dashboard'
          if (password === null) await api.setKillSwitch(!releasing, reason)
          else await api.setKillSwitch(!releasing, reason, password)
          setHaltNote(
            releasing
              ? 'Kill switch released — new exposure is allowed again on both rails.'
              : 'Kill switch ENGAGED — new exposure blocked on both rails. Exits still work.',
          )
          refresh()
          return
        } catch (err) {
          if (err instanceof ApiError && err.reauthRequired) {
            const again = await reauth.ask(RELEASE_STATEMENT, err.message)
            if (again === null) return
            password = again
            continue
          }
          throw err
        }
      }
    } catch (err) {
      setHaltNote(explain(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * THE BOOK IS CHOSEN HERE, not taken from the URL.
   *
   * It used to come from the route's second segment — but the router only ever
   * populates that on the positions route, so on `#/controls` it was always
   * null and BOTH close-all buttons were permanently disabled. The emergency
   * flatten was unreachable from the UI for as long as the page has existed,
   * while looking like a working control.
   *
   * KEYED BY TAG, NOT SYMBOL (since Phase 0). A symbol can now carry several
   * open books at once, so picking "the book named BHEL" is no longer a
   * question with one answer — the picker below has to offer a tag, and
   * `close-all` has to be sent one.
   */
  const { data: books, error: booksError } = usePoll(() => api.books(mode), 5000, [mode])
  const [tag, setTag] = useState<string | null>(null)
  /**
   * The last close-all, WITH THE MODE IT RAN IN.
   *
   * The request captures the mode at click time; moving the switch while it is
   * in flight must not file the answer under the other book. Anything that
   * comes back for a mode we are no longer showing is dropped rather than
   * rendered under the wrong table.
   */
  const [closed, setClosed] = useState<
    { mode: DeskMode; symbol: string; style: string; result: CloseAllResult } | null
  >(null)
  /**
   * A failed close-all. `candidates` is present ONLY for the 409 the server
   * sends when the symbol it was told matched zero or several books — the
   * tags it could have meant (empty for the zero case). Every other failure
   * carries no `candidates`, so the picker below renders only for the one
   * case it can actually resolve.
   */
  const [closeError, setCloseError] = useState<
    { mode: DeskMode; message: string; candidates?: string[]; style: 'fast' | 'limit' } | null
  >(null)
  const bookList = books?.books ?? []
  const chosen = bookList.find((b) => b.tag === tag) ?? bookList[0] ?? null

  /**
   * Moving the switch clears the chosen book and the last close-all.
   *
   * BHEL selected in paper must not stay selected when the page turns live and
   * every button on it becomes a real order. Falling back to "the first book in
   * this mode" is a selection the operator can see; a carried-over one is not.
   */
  useEffect(() => {
    setTag(null)
    setClosed(null)
    setCloseError(null)
  }, [mode])

  /**
   * `bookTag` overrides the picker's own choice — it is how the 409's
   * candidate list retries with an exact tag rather than making the operator
   * re-select from the (now proven ambiguous) picker.
   */
  const closeAll = async (style: 'fast' | 'limit', bookTag?: string): Promise<void> => {
    const symbolToClose = bookTag !== undefined
      ? (bookList.find((b) => b.tag === bookTag)?.symbol ?? chosen?.symbol ?? null)
      : chosen?.symbol ?? null
    const tagToClose = bookTag ?? chosen?.tag ?? null
    if (symbolToClose === null) return
    const ran = mode
    setBusy(true)
    setClosed(null)
    setCloseError(null)
    try {
      const result = await api.closeAll(symbolToClose, tagToClose, ran, style)
      setClosed({ mode: ran, symbol: symbolToClose, style, result })
    } catch (err) {
      if (err instanceof ApiError && err.candidates !== undefined) {
        setCloseError({ mode: ran, message: err.message, candidates: err.candidates, style })
      } else {
        setCloseError({ mode: ran, message: explain(err), style })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>Controls</Heading>
      {error !== null ? <Banner status="error" title="Cannot reach the bridge" description={error} /> : null}
      {haltNote !== null ? <Banner status="info" title={haltNote} /> : null}

      <Card padding={3}>
        <VStack gap={2}>
          <HStack justify="between" align="center" wrap="wrap">
            <Heading level={3}>Kill switch</Heading>
            <Badge variant={ks?.enabled === true ? 'error' : 'success'} label={ks?.enabled === true ? 'ENGAGED' : 'off'} />
          </HStack>
          {/*
            NO MODE BADGE, AND THE TEXT SAYS WHY.

            The halt is one global flag; nothing in `safety.ts` knows about
            paper or live. Sitting under this page's mode rule, it read as
            scoped to whichever book the switch was showing — so an operator
            halting "paper" would in fact have halted live too, and one
            releasing it while looking at paper would have re-armed live.
          */}
          <Text color="secondary" size="sm">
            <b>Global — it halts both rails.</b> Engaging blocks new exposure for every strategy
            in paper AND live at once, whichever mode this page is showing. Exits, rolls and
            shrinks always remain allowed: a control that traps an open position is worse than
            what it protects against.
          </Text>
          {ks?.enabled === true ? (
            <VStack gap={1}>
              {ks.reason !== '' ? <Row label="Reason" value={ks.reason} /> : null}
              <Row
                label="Engaged by"
                value={`${ks.setBy === '' ? 'unknown' : ks.setBy}${ks.setAt === 0 ? '' : ` at ${new Date(ks.setAt).toLocaleString()}`}`}
              />
            </VStack>
          ) : null}
          <HStack gap={2} wrap="wrap">
            <Button
              variant={ks?.enabled === true ? 'secondary' : 'destructive'}
              label={ks?.enabled === true ? 'Release kill switch' : 'Engage kill switch — both rails'}
              isDisabled={busy || ks === null}
              onClick={() => void toggle()}
            />
          </HStack>
        </VStack>
      </Card>

      <Card padding={3}>
        <VStack gap={2}>
          <HStack justify="between" align="center" wrap="wrap">
            <Heading level={3}>Live execution</Heading>
            <Badge
              variant={link === null ? 'neutral' : link.desired === 'released' ? 'error' : 'success'}
              label={link === null ? '…' : link.desired === 'released' ? 'PAUSED' : 'on'}
            />
          </HStack>
          {/*
            GLOBAL, LIKE THE HALT, and it says what it actually does: the api
            refuses every live order while paused, so nothing new reaches the
            Delta gateway. It does not cancel orders already resting at Delta.
          */}
          <Text color="secondary" size="sm">
            <b>Pausing stops every live order to Delta</b> — exits included — until you resume.
            Orders already resting at Delta are not cancelled. Paper trading is unaffected.
          </Text>
          {linkError !== null ? <Text size="sm" style={RED}>{linkError}</Text> : null}
          {linkNote !== null ? <Banner status="info" title={linkNote} /> : null}
          {link !== null && link.desired === 'released' ? (
            <VStack gap={1}>
              <Row
                label="Paused by"
                value={`${link.setBy === '' ? 'unknown' : link.setBy}${link.setAt === 0 ? '' : ` at ${new Date(link.setAt).toLocaleString()}`}${link.reason === '' ? '' : ` — ${link.reason}`}`}
              />
            </VStack>
          ) : null}
          <HStack gap={2} wrap="wrap">
            <Button
              variant={link?.desired === 'released' ? 'secondary' : 'destructive'}
              label={link?.desired === 'released' ? 'Resume live execution' : 'Pause live execution — Delta'}
              isDisabled={busy || link === null}
              onClick={() => void toggleLink()}
            />
          </HStack>
        </VStack>
      </Card>

      <Card padding={3}>
        <VStack gap={2}>
          <HStack justify="between" align="center" wrap="wrap">
            <Heading level={3}>Close a book</Heading>
            {/* This one IS mode-scoped, and this is the badge that says so. */}
            <ModeBadge />
          </HStack>
          <Text color="secondary" size="sm">
            Flattens every leg in one decision, so a retry cannot double-sell. Works while the kill
            switch is engaged. Delta takes limit orders only. <b>Fast</b> is an aggressive limit
            well through the price — near-certain fill, loosely controlled price.
            <b> Limit</b> prices just through the mark so it still crosses; a leg with no mark falls
            back to the fast price rather than being left open.
          </Text>
          {/*
            A FAILED LIST IS NOT AN EMPTY DESK.

            "No paper books are open" beside two disabled buttons is the worst
            false negative this page can produce: in the emergency it is for, it
            says there is nothing to close. The three states are now distinct.
          */}
          {booksError !== null ? (
            <Banner
              status="error"
              title="The list of open books could not be read"
              description={`${booksError}. ${books === null
                ? 'Nothing can be offered to close — this is a failed request, NOT an empty desk. Retry, or close from the broker terminal.'
                : 'The books below are the last ones that arrived and may be out of date.'}`}
            />
          ) : null}
          {books === null && booksError === null ? (
            <Text color="secondary" size="sm">Loading books…</Text>
          ) : null}
          {books !== null && bookList.length === 0 ? (
            <Text color="secondary" size="sm">No {mode} books are open.</Text>
          ) : null}
          {bookList.length > 0 ? (
            // Keyed and chosen by TAG: two books can share a symbol now, and a
            // symbol-keyed list here is a duplicate React key on that book.
            <HStack gap={1} align="center" wrap="wrap">
              {bookList.map((b) => (
                <Button
                  key={b.tag}
                  variant={b.tag === chosen?.tag ? 'primary' : 'ghost'}
                  label={`${b.symbol} · ${b.tag} (${b.legs})`}
                  onClick={() => setTag(b.tag)}
                />
              ))}
            </HStack>
          ) : null}
          <HStack gap={2} wrap="wrap">
            <Button variant="destructive" label={`Close all — fast (aggressive limit), ${mode}`} isDisabled={busy || chosen === null} onClick={() => void closeAll('fast')} />
            <Button variant="secondary" label={`Close all — limit, ${mode}`} isDisabled={busy || chosen === null} onClick={() => void closeAll('limit')} />
          </HStack>
          {closeError !== null && closeError.mode === mode ? (
            <Banner
              status="error"
              title="The close-all did not run"
              description={
                <VStack gap={2}>
                  <Text size="sm">
                    {`${closeError.message}. Nothing can be assumed about the book from a request that failed — read it above.`}
                  </Text>
                  {/*
                    THE 409 THIS ANSWERS: a symbol that maps to zero or several
                    books. `candidates` names the tags it could have meant —
                    empty means zero matched, non-empty is the ambiguous case —
                    and each is a button that retries the SAME close-all with
                    an exact tag, so the refusal is something the operator can
                    act on rather than a dead end.
                  */}
                  {closeError.candidates !== undefined && closeError.candidates.length > 0 ? (
                    <VStack gap={1}>
                      <Text size="sm" color="secondary">
                        This symbol matches more than one book. Pick the one to close:
                      </Text>
                      <HStack gap={1} wrap="wrap">
                        {closeError.candidates.map((c) => (
                          <Button
                            key={c}
                            variant="secondary"
                            label={c}
                            isDisabled={busy}
                            onClick={() => { setTag(c); void closeAll(closeError.style, c) }}
                          />
                        ))}
                      </HStack>
                    </VStack>
                  ) : null}
                  {closeError.candidates !== undefined && closeError.candidates.length === 0 ? (
                    <Text size="sm" color="secondary">
                      No book on this rail matches that symbol — there is nothing here to close.
                    </Text>
                  ) : null}
                </VStack>
              }
            />
          ) : null}
          {closed !== null && closed.mode === mode ? (
            <CloseAllReport symbol={closed.symbol} style={closed.style} result={closed.result} />
          ) : null}
        </VStack>
      </Card>

      {/**
        * Flattening ONE strategy lives on the Strategies page, on that strategy's
        * own row — it is a per-strategy action and that is where you are when you
        * decide to take one off. Controls keeps the global things: the halt, and
        * closing a whole book.
        *
        * Nothing becomes unreachable by moving it: a switched-OFF strategy still
        * appears in its mode's table, and the API refuses (409) to remove a row
        * that still holds a position — so anything carrying risk always has a
        * Flatten button sitting next to it. The line that said so on screen is
        * gone: it restated a tooltip on the page it pointed at.
        */}

      {reauth.dialog}
    </VStack>
  )
}
