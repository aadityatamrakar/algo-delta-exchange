/**
 * Per-strategy P&L cards, and the pieces every other page reuses to render a
 * figure that might not exist.
 *
 * THE ONE RULE ON THIS PAGE: `unrealised` and `total` are null when an open leg
 * could not be marked, and null renders as an em dash plus the names of the
 * legs that are missing. Never `?? 0`. A P&L of ₹0 and a P&L of "three legs
 * could not be marked" mean opposite things to whoever is deciding whether to
 * close the book, and a dashboard that shows them identically is worse than one
 * that shows nothing.
 *
 * The cards live on the Positions page rather than on a "dashboard" of their
 * own. Which book they report is the navbar switch, stated by the rule across
 * the top of the page and the badge beside it — the cards carry no mode control
 * and no mode field of their own for the reader to check.
 */

import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Grid } from '@astryxdesign/core/Grid'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Link } from '@astryxdesign/core/Link'
import { Table, pixel, proportional } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import { inr, money, sign, signed, type DeskMode, type LegQuote, type PnlLeg, type PnlStrategy } from './api.ts'
import { formatContract } from './contract.ts'
import { LiveFeedNotice, useLivePnl } from './stream.tsx'
import { ModeBadge } from './mode.tsx'

/**
 * A money figure that might be unknown.
 *
 * `tone` is only applied when there IS a number — colouring an em dash green or
 * red would suggest a direction we do not have.
 */
export function Money(props: {
  value: number | null
  size?: 'sm' | 'lg' | '2xl'
  digits?: number
  /**
   * Overrides the weight the size implies. `sm` normally means "a figure in a
   * table cell", which wants to sit quietly; on the P&L pill the small figure
   * is the ONLY number on the card and is the thing being looked for, so it
   * asks for the emphasis a `sm` figure does not get by default.
   */
  weight?: 'normal' | 'medium' | 'bold'
}): React.ReactElement {
  const size = props.size ?? 'lg'
  return (
    <Text
      size={size}
      weight={props.weight ?? (size === 'sm' ? 'normal' : 'bold')}
      style={props.value === null ? undefined : sign(props.value)}
    >
      {money(props.value, props.digits === undefined ? 0 : props.digits)}
    </Text>
  )
}

/** Names the legs holding a total back, because "partial" alone is not actionable. */
export function UnpricedNote(props: { unpriced: readonly string[] }): React.ReactElement | null {
  if (props.unpriced.length === 0) return null
  return (
    <Text size="sm" color="secondary">
      {`Cannot mark: ${props.unpriced.join(', ')} — the total is unknown, not zero.`}
    </Text>
  )
}

/**
 * One strategy, as a COMPACT PILL.
 *
 * Tinted by direction so a screen of eight reads at a glance without anyone
 * parsing a minus sign — which is the whole job of this row. The full breakdown
 * (realised, unrealised, open legs, what could not be marked) lives one click
 * away on the strategy's own page; putting it on the pill made each one a
 * paragraph and turned a scannable grid into a wall.
 *
 * A NULL TOTAL IS NEVER TINTED. `gray` plus an em dash, because green would
 * assert a profit we do not have and red would assert a loss — the colour IS
 * the claim here, and we have no direction to claim. `partial` is badged for
 * the same reason.
 *
 * The tag is allowed to shrink and ellipsise while the figure never does. In
 * the layout this replaces, a long tag ran straight through the number and drew
 * a strikethrough across it — an unreadable P&L is worse than a truncated name,
 * and the name is recoverable from the tooltip and the link target.
 *
 * IT FILLS ITS GRID TRACK, and the `.pnl-pill` class is what makes it. astryx's
 * `Link` is `display: inline-flex`, so the anchor — and the card inside it —
 * hugged its own text: every pill sat at the left edge of a track two or three
 * times its width, and a row of them read as pills separated by arbitrary
 * gutters rather than as a grid. Stretching the anchor closes the gaps without
 * touching the `Grid`, whose track sizing was never the problem.
 *
 * THE TINT IS STRENGTHENED IN comfort.css, NOT HERE. `--color-background-green`
 * is a 20% wash that all but disappears against a card, and the variant is the
 * only thing this component can ask for. The class carries the direction so the
 * stylesheet can mix a readable surface out of the SAME tokens — which is what
 * keeps both themes working; there is no hex value on either side of this.
 *
 * The `variant` STAYS even though the stylesheet overrides its background. It
 * is what a reader of this file sees, it is what the pill falls back to if
 * comfort.css is ever dropped, and it keeps the two from disagreeing about
 * which direction a card is showing.
 */
function StrategyPnlCard(props: { row: PnlStrategy }): React.ReactElement {
  const r = props.row
  /**
   * A DESK BOOK's pill shows the BOOK figure — `sinceEntry`, the same number
   * as its book page's tile and table foot (one P&L per stock book,
   * everywhere; operator's call 2026-08-18). A hosted tag has no book and
   * shows its journal total, which for it is the truth. `undefined` is the
   * discriminator: the server only stamps the field on book tags.
   */
  const shown = r.sinceEntry !== undefined ? r.sinceEntry : r.total
  const anchor = r.sinceEntry !== undefined ? 'since entry' : 'today'
  const tint = shown === null ? 'gray' : shown < 0 ? 'red' : 'green'
  // No mode in the link. The strategy page reads the same switch this page
  // does, so following a pill cannot land on the other book.
  return (
    <Link
      href={`#/strategies/${encodeURIComponent(r.tag)}`}
      className={`pnl-pill pnl-pill-${tint}`}
      style={{ textDecoration: 'none' }}
    >
      {/* padding 2, not 3: a pill is one line of text, and 12px of air above
          and below a 20px line made a row of eight into a screenful.

          NOT TIGHTENED FURTHER by the 2026-08-04 compaction pass, and this is
          the one card on the page that was left alone: the pill is a LINK you
          tap, and at 8px it is 36px tall — already under the 44px touch floor
          responsive.css puts on every button. Buying 4px of page here would be
          paid for in mis-taps on a phone. */}
      <Card variant={tint} padding={2}>
        <HStack gap={2} align="center" justify="between">
          <span
            title={`${r.tag} — ${r.label} (P&L ${anchor})`}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
          >
            <Text weight="medium">{r.tag}</Text>
          </span>
          <HStack gap={2} align="center" style={{ flexShrink: 0 }}>
            {r.complete ? null : <Badge variant="warning" label="partial" />}
            <Money value={shown} size="sm" weight="bold" />
            <Text color="secondary">›</Text>
          </HStack>
        </HStack>
      </Card>
    </Link>
  )
}

/**
 * Did this strategy DO anything today?
 *
 * Only strategies with actual activity get a pill: a registry that keeps growing
 * would otherwise fill the page with rows reading ₹0 for strategies that are
 * merely switched on, and a screen of nothing-happened hides the two that did.
 *
 * The test is a POSITIVE signal from the data, never the switch — "armed" and
 * "traded" are different questions and the switch answers the wrong one. Open
 * legs mean it is holding something; a non-zero realised means it closed
 * something today; an unmarked leg means it holds something we could not price,
 * which is emphatically activity even though every figure on it is null.
 *
 * KNOWN GAP: a strategy that traded and closed EXACTLY flat has no positive
 * signal here and is filtered out. The P&L endpoint carries no fill count, and
 * the order journal only covers live routing, so there is nothing better to test
 * without a new endpoint. The count line below states the rule for that reason —
 * an operator who is missing a row can see why.
 */
function tradedToday(r: PnlStrategy): boolean {
  return r.openLegs > 0 || r.realised !== 0 || r.unpriced.length > 0
}

export function PnlCards(props: { mode: DeskMode }): React.ReactElement {
  /**
   * STREAMED, and this is the page it matters most on.
   *
   * This is where every strategy's P&L is read at a glance, and until now it was
   * a plain 10s poll — so the figure an operator watches during a move sat still
   * for ten seconds at a time while the server was already re-marking on every
   * tick. `useLivePnl` merges the pushed rows over the same REST response this
   * used to render alone; the poll is still there and still authoritative.
   *
   * NO TAG FILTER: the grid renders every strategy, so it asks for every tag.
   */
  const { data, error, degraded } = useLivePnl(props.mode)

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
  const all = [...(data?.strategies ?? [])].sort((a, b) => a.tag.localeCompare(b.tag))
  const active = all.filter(tradedToday)
  const hidden = all.length - active.length

  return (
    <VStack gap={2}>
      <HStack justify="between" align="center">
        <HStack gap={2} align="center">
          {/* Not "today": a book pill shows its book since entry, a hosted
              pill its day — each pill's hover title names its anchor. */}
          <Heading level={3}>P&L</Heading>
          {/* The badge on a mode-scoped total — the third of the colour's places. */}
          <ModeBadge mode={props.mode} />
        </HStack>
        {data !== null && !data.totals.complete
          ? <Badge variant="warning" label="totals are partial" />
          : null}
      </HStack>

      {/*
        The figures below MOVE while the socket is up, so when it goes they must
        stop looking like they still do. Same notice, same wording as the Orders
        page — the operator's question is "how old is this number, at worst?".
      */}
      {degraded ? <LiveFeedNotice /> : null}

      {/* A failed fetch says so. An empty grid would read as "no strategies". */}
      {error !== null ? (
        <Banner
          status="error"
          title="P&L could not be loaded"
          description={`${error}. The figures below, if any, are the last ones that arrived.`}
        />
      ) : null}

      {data === null && error === null ? (
        <Text color="secondary" size="sm">Loading P&L…</Text>
      ) : null}

      {data !== null ? (
        <>
          {/**
            * NO DESK-WIDE TOTAL ROW HERE — removed at the operator's request.
            *
            * The pills are the page. A summary above them restated the same
            * numbers in a second place, and the one thing it added that the
            * pills cannot show — that the total is a LOWER BOUND when a leg
            * could not be marked — is still surfaced, by the `partial` badge on
            * the affected pill and the `totals are partial` badge in the header.
            * So nothing that qualifies a number was lost with it.
            */}
          {active.length === 0 ? (
            <Text color="secondary" size="sm">
              {`No ${props.mode} strategy has traded today.`}
            </Text>
          ) : (
            /*
              A PILL IS A TAG AND A FIGURE ON ONE LINE, and at 90px it is
              neither: `columns={4}` held four columns at every width, so on a
              phone the tag ellipsised to three characters and the P&L wrapped
              under it. 220px is the width at which a realistic tag and a rupee
              figure still sit side by side, so the row falls to two pills and
              then one rather than shrinking past legibility.

              THE CAP IS 6 AND NOT 4 because a track is `1fr` at the top end:
              capped at four, a 1400px desk gave each pill a 341px track and
              the pill — once it was made to fill it, see `.pnl-pill` — spent
              ~200px of that on the gap between the tag and the number it is
              being read against. Six tracks land at ~223px, which is the width
              the 220 floor already says a pill wants. Nothing shrinks past it:
              the floor still wins on any screen where six would be narrower.
            */
            <Grid columns={{ minWidth: 220, max: 6 }} gap={3}>
              {active.map((s) => <StrategyPnlCard key={s.tag} row={s} />)}
            </Grid>
          )}
          {/*
            A page that silently hides rows is worse than one showing too many:
            the operator cannot tell an idle strategy from a missing one. So the
            filter states itself, including what "traded" means here.

            NO "N OF M" AND NO MODE ON THE HIDDEN ROWS. The P&L endpoint returns
            a row for every tag in the registry — live-only ones, ones added to
            no mode at all — so `all.length` was never a count of this mode's
            strategies, and calling them "{mode} strategies" attributed rows to a
            table they are not on. The number of hidden rows is the only part of
            that sentence the data supports.
          */}
          {hidden > 0 ? (
            <Text color="secondary" size="sm">
              {`${hidden} other ${hidden === 1 ? 'strategy is' : 'strategies are'} not shown: ` +
                'no open position and no realised P&L today.'}
            </Text>
          ) : null}
        </>
      ) : null}
    </VStack>
  )
}

/**
 * Every open leg on this rail, by strategy.
 *
 * WHY IT IS HERE (2026-07-28). The Positions page listed only DECLARED books —
 * `desk-books`, which only the Python desk's `declare` ever writes. A hosted
 * strategy journals fills and holds its position internally, so a desk running
 * a dozen hosted tags with real exposure rendered "No paper books / Nothing is
 * open" directly beneath a row of P&L pills reporting those very positions.
 * "Nothing is open" is the single most dangerous sentence this page can get
 * wrong, so the legs the P&L already netted are shown here.
 *
 * Same source as the pills above it — `openLegs` was the surviving count of
 * exactly this list — so the two cannot disagree.
 */
export function OpenLegs(props: { mode: DeskMode }): React.ReactElement | null {
  /**
   * LIVE ONLY, at the operator's call.
   *
   * On the live rail a consolidated "what is the desk actually holding right
   * now" is the question this page exists to answer, across every strategy at
   * once. In paper it is noise: a dozen simulated tags produce a wall of legs
   * nobody acts on, and each strategy's own page already lists its positions
   * next to the P&L that explains them. The hook runs before this returns so
   * the rules-of-hooks order is stable across a mode switch.
   *
   * STREAMED, so Mark and Unrealised move with the feed rather than every 10s.
   * NO SECOND `LiveFeedNotice` HERE: `PnlCards` sits directly above this card on
   * the same page and shares the same socket, so a dead feed is already stated
   * once. Saying it twice on one screen is how a warning stops being read.
   */
  const { data, error } = useLivePnl(props.mode)
  if (props.mode !== 'live') return null

  /**
   * OPEN legs only. `legs` also carries the day's CLOSED round trips (qty 0)
   * so a strategy page can show what it booked, but this card answers "what is
   * the desk holding right now" — padding it with positions that were shut
   * hours ago would overstate live exposure, which is the one direction this
   * page must never be wrong in. The per-strategy page shows both.
   */
  const held = (data?.strategies ?? [])
    .map((s) => ({ ...s, legs: s.legs.filter((l) => l.qty !== 0) }))
    .filter((s) => s.legs.length > 0)
  // Silent when there is nothing to say: the books section below already owns
  // the empty state, and a second "nothing here" card says it twice.
  if (data === null || error !== null || held.length === 0) return null

  const rows: (PnlLeg & Record<string, unknown>)[] = held.flatMap((s) =>
    s.legs.map((l) => ({ ...l, tag: s.tag, quote: s.quotes?.[l.tradingsymbol] ?? null })),
  )

  /**
   * THE ROWS PLUS A TOTAL, and the total is a row of the table.
   *
   * "17 legs across 3 strategies" answered how MANY without answering how much,
   * so the one figure the panel exists for — what all of this is worth right
   * now — had to be added up by eye down a column of seventeen signed numbers.
   *
   * UNKNOWN THE MOMENT ANY LEG IS UNMARKED, the same rule every other total on
   * this dashboard obeys: summing the legs that DID price produces a confident
   * figure understated by an unknown amount, which is worse than admitting the
   * total is not known.
   */
  const anyUnmarked = rows.some((l) => l.unrealised === null)
  const withTotal = rows.length === 0
    ? rows
    : [...rows, {
        tag: 'Total',
        tradingsymbol: '',
        qty: 0,
        avgCost: 0,
        mark: null,
        unrealised: anyUnmarked ? null : rows.reduce((n, l) => n + (l.unrealised ?? 0), 0),
        realised: 0,
        buyQty: 0,
        buyValue: 0,
        sellQty: 0,
        sellValue: 0,
        mtm: null,
        isTotal: true,
      } as PnlLeg & Record<string, unknown>]

  const columns: TableColumn<PnlLeg & Record<string, unknown>>[] = [
    { key: 'tag', header: 'Strategy', width: proportional(1),
      renderCell: (l) => (
        l['isTotal'] === true
          ? <Text weight="bold">Total</Text>
          : (
            <Link href={`#/strategies/${encodeURIComponent(String(l['tag']))}`}>
              {String(l['tag'])}
            </Link>
          )
      ) },
    { key: 'tradingsymbol', header: 'Contract', width: proportional(2),
      renderCell: (l) => (
        l['isTotal'] === true ? <Text color="secondary">—</Text> : (
          <HStack gap={2} align="center">
            <Text weight="medium">{formatContract(l.tradingsymbol)}</Text>
            {l.mark === null ? <Badge variant="warning" label="no mark" /> : null}
          </HStack>
        )
      ) },
    { key: 'qty', header: 'Qty', align: 'end', width: pixel(90),
      renderCell: (l) => (
        l['isTotal'] === true
          ? <Text color="secondary">—</Text>
          : <Text style={sign(l.qty)}>{signed(l.qty)}</Text>
      ) },
    { key: 'avgCost', header: 'Entry', align: 'end', width: pixel(90),
      renderCell: (l) => (
        l['isTotal'] === true ? <Text color="secondary">—</Text> : <Text>{inr(l.avgCost, 2)}</Text>
      ) },
    { key: 'mark', header: 'Mark', align: 'end', width: pixel(120),
      renderCell: (l) => {
        if (l['isTotal'] === true) {
          return <Text color="secondary">{l.mark === null ? '—' : inr(l.mark, 2)}</Text>
        }
        // The pair the mark is valued off — a long at its bid, a short at its
        // ask — so the number above it is never a mystery. "last session"
        // marks a snapshot pair; a missing pair is exactly a "no mark" leg.
        const q = l['quote'] as LegQuote | null | undefined
        return (
          <VStack gap={0} style={{ alignItems: 'flex-end' }}>
            <Text>{l.mark === null ? '—' : inr(l.mark, 2)}</Text>
            {q === null || q === undefined ? null : (
              <Text size="sm" color="secondary">
                {`${q.bid.toFixed(2)} / ${q.ask.toFixed(2)}${q.basis === 'snapshot' ? ' · last session' : ''}`}
              </Text>
            )}
          </VStack>
        )
      } },
    // Em dash, never ₹0 — the rule at the top of this file, per leg.
    { key: 'unrealised', header: 'Unrealised', align: 'end', width: pixel(110),
      renderCell: (l) => (
        l.unrealised === null
          ? <Text color="secondary">—</Text>
          : (
            <Text
              {...(l['isTotal'] === true ? { weight: 'bold' as const } : {})}
              style={sign(l.unrealised)}
            >
              {signed(l.unrealised)}
            </Text>
          )
      ) },
  ]

  return (
    // Padding on the card only, at 12px — see `Stat` in pages.tsx for why the
    // nested `padding={4}` this replaces was costing 32px of inset per side.
    <Card padding={3}>
      <VStack gap={2}>
        <HStack justify="between" align="center">
          <Heading level={3}>Open legs</Heading>
          <Text size="sm" color="secondary">
            {`${rows.length} across ${held.length} ${held.length === 1 ? 'strategy' : 'strategies'}`}
          </Text>
        </HStack>
        <Table data={withTotal} columns={columns} density="compact" hasHover />
      </VStack>
    </Card>
  )
}
