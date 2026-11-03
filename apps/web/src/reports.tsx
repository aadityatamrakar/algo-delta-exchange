/**
 * Reports — ONE STRATEGY over a DATE RANGE.
 *
 * This replaces a whole-day summary of the desk. The question that page
 * answered was "how did everything do on this date", which is a question you
 * ask once a day; the question an operator deciding whether to keep running
 * something actually has is "how has this strategy been doing", and that needs
 * a range. So: pick a strategy, pick a range — the last three months to start
 * with — chart across it, and the days underneath.
 *
 * WHAT "A STRATEGY" IS (WS2). A delta-lean book is one dated tag a day, so a
 * tag is a single session, not a strategy. The picker therefore opens on a
 * SERIES — one symbol and variant across its dated tags, so NIFTY and SENSEX
 * are read SEPARATELY by default — then offers the COMBINED view (a variant,
 * every symbol summed per day, with each day split per symbol beside the sum),
 * then the tags no series claims. Membership comes from the server's series
 * rows; nothing here reads anything off a tag's text. Each day row names the
 * tags that reported it, and each one opens that tag's order log for the day.
 *
 * The mode comes from the navbar switch. Paper money is never added to live
 * money: every list and every range is read for the mode on screen.
 *
 * DAYS WITH NO ROLLUP ARE ABSENT, NOT ZERO. The range endpoint reads only what
 * was written at day end — replaying three months of fills on every page load is
 * not a thing to do — so a day the process was down is a gap, and the count of
 * those gaps is stated in words. A gap and a flat day must not draw the same
 * line.
 *
 * Nullable figures are em dashes. See the note in pnl.tsx; the same discipline
 * applies to a rollup that could not be totalled.
 */

import { useEffect, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Card } from '@astryxdesign/core/Card'
import { Text, Heading } from '@astryxdesign/core/Text'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Banner } from '@astryxdesign/core/Banner'
import { Selector } from '@astryxdesign/core/Selector'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { DateInput } from '@astryxdesign/core/DateInput'
import type { ISODateString } from '@astryxdesign/core/Calendar'
import { Table, proportional, pixel } from '@astryxdesign/core/Table'
import type { TableColumn } from '@astryxdesign/core/Table'
import {
  api, explain, inr, istDate, istDayLabel, istDaysBefore, money,
  type DeskMode, type GroupDayRow, type PruneResult, type ReportRow, type ReportSeries,
} from './api.ts'
import { usePoll } from './shell.tsx'
import { ModeBadge } from './mode.tsx'
import { Money } from './pnl.tsx'
import { DailyPnlChart } from './chart.tsx'
import { ReportOrderLog } from './report-orderlog.tsx'

/** Three months. The window an operator judges a strategy over, per the design. */
const DEFAULT_DAYS = 90

// ------------------------------------------------------------------ prune

/**
 * Retention, with the preview first — BEHIND A DISCLOSURE.
 *
 * It is a database-maintenance action on a page whose job is "how has this
 * strategy been doing", and it was sitting open at the bottom of it with a
 * four-line justification, permanently, for a button pressed a few times a
 * year. Collapsed, it is still exactly where someone would look for it and
 * costs one line when they are not.
 *
 * The dry run is not a nicety: the job refuses to delete a day whose rollup was
 * never written, and the only way to find out that a day is in that state is to
 * ask it and read the reasons back.
 */
function PruneCard(): React.ReactElement {
  const [result, setResult] = useState<PruneResult | null>(null)
  const [wasDryRun, setWasDryRun] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (dryRun: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.prune(dryRun)
      setResult(r)
      setWasDryRun(dryRun)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  const count = result === null ? null : result.wouldDelete ?? result.deleted ?? null

  return (
    <Card>
      <Collapsible
        defaultIsOpen={false}
        trigger={<Text weight="medium">Snapshot retention</Text>}
      >
        <VStack gap={3} padding={4}>
          <Text color="secondary" size="sm">
            {/*
              THE WINDOW IS THE SERVER'S, AND IT IS SAID BEFORE THE BUTTON.
              The client sends no `keepDays`, so until a preview comes back the
              operator has never been told what "beyond the window" means — and
              "Prune now" is destructive.
            */}
            {result === null
              ? 'Intraday snapshots are pruned beyond the retention window; daily rollups are kept forever. Preview to see the window and the days.'
              : `Keeping ${inr(result.keepDays)} days of intraday snapshots; daily rollups are kept forever.`}
            {' '}A day whose rollup was never written is never pruned.
          </Text>
          {error !== null ? <Banner status="error" title="Prune failed" description={error} /> : null}
          <HStack gap={2}>
            <Button variant="secondary" label="Preview what would go" isLoading={busy} onClick={() => void run(true)} />
            <Button
              variant="destructive"
              label="Prune now"
              isDisabled={busy || result === null || !wasDryRun}
              tooltip="Preview first — this button stays disabled until a dry run has shown you the days"
              onClick={() => void run(false)}
            />
          </HStack>
          {result !== null ? (
            <VStack gap={1}>
              <Text size="sm">
                {`${wasDryRun ? 'Would delete' : 'Deleted'} ${count === null ? '—' : inr(count)} snapshots across ${result.days.length} days.`}
              </Text>
              {result.days.map((d) => (
                <Text key={d.date} size="sm" color="secondary">
                  {`${d.date}: ${d.action} (${inr(d.snapshots)} snapshots) — ${d.reason}`}
                </Text>
              ))}
            </VStack>
          ) : null}
        </VStack>
      </Collapsible>
    </Card>
  )
}

// ----------------------------------------------------------------- picker

/** What the picker can select: a strategy (variant), a series, or one tag. */
export type ReportPick =
  | { kind: 'variant'; name: string }
  | { kind: 'series'; name: string }
  | { kind: 'tag'; name: string }

interface PickerSection {
  type: 'section'
  title: string
  options: { value: string; label: string }[]
}

/**
 * The picker's three groups, in the order the page opens on them: SERIES (one
 * symbol and variant across its dated tags, grouped by symbol then variant),
 * COMBINED (a variant, every symbol summed), then OTHER TAGS — every tag with a
 * record that no series claims (hosted strategies, books from before series
 * existed). The page opens on ONE series — the operator reads NIFTY and SENSEX
 * separately unless they ask for the sum — and on the one that reported most
 * recently (`lastDate`), not the alphabetical first: a stock series that last
 * traded a month ago must not open ahead of today's index books. A tie goes to
 * the display order; a series that has never reported never wins while another
 * has a date. The display order itself is unchanged by this.
 *
 * A tag a series already claims is not listed again: it is reached through
 * its series, and a daily roll would otherwise add four entries a day.
 *
 * Option values are opaque keys looked up in `picks` — the page never reads a
 * name back out of one.
 */
export function pickerGroups(input: {
  series: ReportSeries | null
  tags: readonly string[]
}): { sections: PickerSection[]; picks: Map<string, ReportPick>; first: string | null } {
  const picks = new Map<string, ReportPick>()
  const sections: PickerSection[] = []
  const add = (title: string, kind: ReportPick['kind'], names: readonly string[]): void => {
    if (names.length === 0) return
    const options = names.map((name) => {
      const value = `${kind}:${name}`
      picks.set(value, { kind, name })
      return { value, label: name }
    })
    sections.push({ type: 'section', title, options })
  }
  const series = input.series?.series ?? []
  // By the series row's symbol, then variant — never by the name's text.
  const ordered = [...series].sort((a, b) =>
    a.symbol.localeCompare(b.symbol) || a.variant.localeCompare(b.variant) || a.series.localeCompare(b.series))
  add('Series', 'series', ordered.map((s) => s.series))
  add('Combined (all symbols)', 'variant', [...(input.series?.variants ?? [])].sort())
  const claimed = new Set(series.flatMap((s) => s.tags))
  add('Other tags', 'tag', [...new Set(input.tags)].filter((t) => !claimed.has(t)).sort())
  // Strictly newer wins, scanning in display order — so a tie keeps the earlier.
  let newest: (typeof ordered)[number] | null = null
  for (const s of ordered) {
    if (s.lastDate === null) continue
    if (newest === null || s.lastDate > newest.lastDate!) newest = s
  }
  const first = newest !== null ? `series:${newest.series}` : sections[0]?.options[0]?.value ?? null
  return { sections, picks, first }
}

// ------------------------------------------------------------------- days

/** One row of the day table, whichever kind of selection it came from. */
export interface DayRow extends Record<string, unknown> {
  date: string
  realised: number
  total: number | null
  maxProfit: number | null
  maxLoss: number | null
  orderCount: number
  closingPositions: number
  closingSource: 'marks' | 'snapshot' | 'none'
  /** The tags that reported this day; each one's order log is a button. */
  tags: string[]
  expiryDay: boolean
  /** Realised, summed from the first day on screen to this one. */
  cumulative: number
  /** symbol -> that symbol's realised this day. Combined view only; absent symbol = did not report. */
  bySymbol: Record<string, number> | null
}

/**
 * Normalise either history shape into day rows, oldest first, with the
 * running realised total. A single tag's row names that tag and carries no
 * expiry marker — a tag view has no series row to say when its book expired.
 */
export function toDayRows(rows: readonly (ReportRow | GroupDayRow)[]): DayRow[] {
  let cumulative = 0
  return [...rows]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((r) => {
      cumulative += r.realised
      const grouped = 'tags' in r && Array.isArray(r.tags)
      return {
        date: r.date,
        realised: r.realised,
        total: r.total,
        maxProfit: r.maxProfit,
        maxLoss: r.maxLoss,
        orderCount: r.orderCount,
        closingPositions: r.closingPositions,
        closingSource: r.closingSource ?? 'marks',
        tags: grouped ? [...(r as GroupDayRow).tags] : [(r as ReportRow).tag],
        expiryDay: grouped ? (r as GroupDayRow).expiryDay : false,
        cumulative,
        bySymbol: splitOf(r),
      }
    })
}

function splitOf(r: ReportRow | GroupDayRow): Record<string, number> | null {
  const by = (r as GroupDayRow).bySymbol
  if (by === undefined || by === null) return null
  const out: Record<string, number> = {}
  for (const [symbol, d] of Object.entries(by)) out[symbol] = d.realised
  return out
}

/**
 * Each symbol's realised over the days on screen, in the order given. A day
 * with no split contributes nothing to any symbol.
 */
export function symbolTotals(
  rows: readonly DayRow[],
  symbols: readonly string[],
): { symbol: string; realised: number }[] {
  return symbols.map((symbol) => ({
    symbol,
    realised: rows.reduce((acc, r) => acc + (r.bySymbol?.[symbol] ?? 0), 0),
  }))
}

/**
 * The combined view's columns, one per symbol: the server's list, plus any
 * symbol key a day carries that the list lacks, sorted. Null when no row is
 * split — the series and tag views.
 */
function splitSymbols(declared: readonly string[] | undefined, rows: readonly DayRow[]): string[] | null {
  if (declared === undefined && rows.every((r) => r.bySymbol === null)) return null
  const all = new Set(declared ?? [])
  for (const r of rows) for (const k of Object.keys(r.bySymbol ?? {})) all.add(k)
  return [...all].sort()
}

export interface DaySummary {
  /** Realised over the days on screen. */
  realised: number
  /** Days with a record. */
  days: number
  /** Days whose realised was above zero. */
  winning: number
  best: { date: string; realised: number } | null
  worst: { date: string; realised: number } | null
}

/**
 * The summary strip, on REALISED — the one figure every day has. `total` can
 * be null on any day that could not be marked, and a best/worst that silently
 * skipped those days would not be the best or worst day.
 */
export function summariseDays(rows: readonly DayRow[]): DaySummary {
  let realised = 0
  let winning = 0
  let best: DaySummary['best'] = null
  let worst: DaySummary['worst'] = null
  for (const r of rows) {
    realised += r.realised
    if (r.realised > 0) winning++
    if (best === null || r.realised > best.realised) best = { date: r.date, realised: r.realised }
    if (worst === null || r.realised < worst.realised) worst = { date: r.date, realised: r.realised }
  }
  return { realised, days: rows.length, winning, best, worst }
}

const dayFigure = (d: { date: string; realised: number } | null): string =>
  d === null ? '—' : `${money(d.realised)} · ${istDayLabel(d.date)}`

// ------------------------------------------------------------------- page

export function ReportsPage(props: { mode: DeskMode }): React.ReactElement {
  const today = istDate()
  const [from, setFrom] = useState<string>(() => istDaysBefore(today, DEFAULT_DAYS))
  const [to, setTo] = useState<string>(today)
  const [picked, setPicked] = useState<string | null>(null)
  /** The (day, tag) whose order log is open, if any. Detail on demand, not by default. */
  const [openLog, setOpenLog] = useState<{ date: string; tag: string } | null>(null)

  /**
   * The picker offers the series and strategies first, then every tag with a
   * history or on this mode's table that no series claims.
   *
   * Rolled-up tags alone would hide a strategy added this morning, and the page
   * would look like it had lost it; the table's tags alone would hide one that
   * has been removed but still has three months of record worth reading.
   */
  const { data: seriesList, error: seriesError } = usePoll(
    () => api.reportSeries(props.mode), 120_000, [props.mode],
  )
  const { data: tags, error: tagsError } = usePoll(
    () => api.reportTags(props.mode), 120_000, [props.mode],
  )
  const { data: registry } = usePoll(() => api.strategies(props.mode), 60_000, [props.mode])
  const { sections, picks, first } = pickerGroups({
    series: seriesList,
    tags: [...(tags?.tags ?? []), ...(registry?.strategies ?? []).map((r) => r.tag)],
  })

  /**
   * NOTHING IS PICKED BY DEFAULT UNTIL THE SERIES LIST HAS ANSWERED (or
   * failed). The tags can land first, and choosing then would open on the
   * alphabetically first tag — fetching its history and showing it under the
   * strategy heading — only to jump to the strategy a moment later.
   */
  const seriesSettled = seriesList !== null || seriesError !== null
  const key = picked !== null && picks.has(picked) ? picked : seriesSettled ? first : null
  const pick = key === null ? null : picks.get(key) ?? null
  const label = pick?.name ?? null

  /**
   * The open log is dropped when the switch moves.
   *
   * The order log below is fetched for `(day, tag)` and read in the mode the
   * page is showing; leaving it open across a mode change re-labels the same
   * panel as the other rail's without anything having been re-fetched for it.
   */
  useEffect(() => { setOpenLog(null) }, [props.mode])

  const { data: history, error: historyError } = usePoll(
    async () => {
      if (pick === null) return null
      if (pick.kind === 'tag') {
        const h = await api.reportHistory(pick.name, props.mode, from, to)
        return { rows: h.rows as (ReportRow | GroupDayRow)[], totals: h.totals, missingDays: h.missingDays }
      }
      const group = pick.kind === 'series' ? { series: pick.name } : { variant: pick.name }
      const h = await api.reportGroupHistory(group, props.mode, from, to)
      return {
        rows: h.rows as (ReportRow | GroupDayRow)[], totals: h.totals, missingDays: h.missingDays,
        ...(h.symbols === undefined ? {} : { symbols: h.symbols }),
      }
    },
    60_000, [key, props.mode, from, to],
  )

  const { data: orders, error: orderError } = usePoll(
    () => (openLog === null
      ? Promise.resolve(null)
      : api.reportOrders(openLog.date, props.mode, openLog.tag)),
    60_000, [openLog?.date, openLog?.tag, props.mode],
  )

  const rows: DayRow[] = toDayRows(history?.rows ?? [])
  const totals = history?.totals ?? null
  const summary = summariseDays(rows)
  /** The combined view's symbols — null on a series or tag, which are one symbol already. */
  const symbols = pick?.kind === 'variant' && history !== null
    ? splitSymbols('symbols' in history ? history.symbols : undefined, rows)
    : null
  const perSymbol = symbols === null ? null : symbolTotals(rows, symbols)

  const toggleLog = (date: string, tag: string): void => {
    setOpenLog(openLog !== null && openLog.date === date && openLog.tag === tag ? null : { date, tag })
  }

  const columns: TableColumn<DayRow>[] = [
    /**
     * EXPIRY DAYS ARE MARKED — a contributing book's contract expired that
     * day, which is where this desk's large losses have clustered.
     */
    { key: 'date', header: 'Day', width: pixel(130),
      renderCell: (r) => (
        <HStack gap={2} align="center">
          <Text size="sm" weight="medium">{istDayLabel(r.date)}</Text>
          {r.expiryDay ? <Badge variant="warning" label="expiry" /> : null}
        </HStack>
      ) },
    /**
     * THE COMBINED VIEW, SPLIT. One realised column per symbol before the
     * summed figures, so the sum never hides which index made the money. A
     * symbol that did not report that day is a blank cell — not 0, which
     * would read as a flat day it never traded.
     */
    ...(symbols ?? []).map((symbol): TableColumn<DayRow> => ({
      key: `symbol:${symbol}`, header: symbol, align: 'end', width: pixel(110),
      renderCell: (r) => {
        const v = r.bySymbol?.[symbol]
        return v === undefined ? null : <Money value={v} size="sm" />
      },
    })),
    /**
     * The total carries HOW it was marked, not just the number.
     *
     * A rollup can still have been priced from the last good tick of the
     * afternoon rather than at the close; those are different claims about the
     * same rupee figure. `none` is why a total is blank, which otherwise reads
     * as a rendering fault. On a grouped day the worst of its tags speaks.
     */
    { key: 'total', header: 'Total', align: 'end', width: pixel(160),
      renderCell: (r) => (
        <HStack gap={2} align="center" justify="end">
          <Money value={r.total} size="sm" />
          {r.closingSource === 'snapshot' ? <Badge variant="warning" label="stale mark" /> : null}
          {r.closingSource === 'none' ? <Badge variant="neutral" label="unmarked" /> : null}
        </HStack>
      ) },
    { key: 'realised', header: 'Realised', align: 'end', width: pixel(120),
      renderCell: (r) => <Money value={r.realised} size="sm" /> },
    { key: 'cumulative', header: 'Cumulative', align: 'end', width: pixel(120),
      renderCell: (r) => <Money value={r.cumulative} size="sm" /> },
    { key: 'maxProfit', header: 'Max profit', align: 'end', width: pixel(110),
      renderCell: (r) => <Text size="sm">{money(r.maxProfit)}</Text> },
    { key: 'maxLoss', header: 'Max loss', align: 'end', width: pixel(110),
      renderCell: (r) => <Text size="sm">{money(r.maxLoss)}</Text> },
    { key: 'orderCount', header: 'Orders', align: 'end', width: pixel(80),
      renderCell: (r) => <Text size="sm">{inr(r.orderCount)}</Text> },
    { key: 'closingPositions', header: 'Left open', align: 'end', width: pixel(90),
      renderCell: (r) => <Text size="sm">{inr(r.closingPositions)}</Text> },
    /** Each tag that reported the day opens ITS order log for that day. */
    { key: 'tags', header: 'Order log', width: proportional(2),
      renderCell: (r) => (
        <VStack gap={0} align="start">
          {r.tags.map((t) => (
            <Button
              key={t}
              variant="ghost"
              size="sm"
              label={t}
              tooltip={`${r.date} — show ${t}'s order log`}
              onClick={() => toggleLog(r.date, t)}
            />
          ))}
        </VStack>
      ) },
  ]

  const viewNote =
    pick === null ? null
      : pick.kind === 'variant' ? 'Combined — every symbol summed per day, each symbol beside the sum'
        : pick.kind === 'series' ? 'Series — one symbol, every dated book'
          : 'One tag'

  return (
    <VStack gap={4}>
      <HStack gap={4} align="end" justify="between" wrap="wrap">
        <HStack gap={3} align="center">
          <Heading level={2}>Reports</Heading>
          <ModeBadge />
        </HStack>
        <HStack gap={3} align="end" wrap="wrap">
          <Selector
            label="Strategy"
            options={sections}
            value={key ?? ''}
            onChange={(v) => { setPicked(v); setOpenLog(null) }}
            placeholder="nothing recorded"
            width={280}
            hasSearch
          />
          <DateInput
            label="From"
            value={from as ISODateString}
            max={to as ISODateString}
            onChange={(v) => { if (v !== undefined) { setFrom(v); setOpenLog(null) } }}
            width={165}
          />
          <DateInput
            label="To"
            value={to as ISODateString}
            min={from as ISODateString}
            onChange={(v) => { if (v !== undefined) { setTo(v); setOpenLog(null) } }}
            width={165}
          />
        </HStack>
      </HStack>

      {seriesError !== null ? (
        <Banner
          status="error"
          title="The list of series could not be loaded"
          description={`${seriesError}. Tags are still listed individually.`}
        />
      ) : null}
      {tagsError !== null ? (
        <Banner
          status="error"
          title="The list of strategies could not be loaded"
          description={tagsError}
        />
      ) : null}
      {historyError !== null ? (
        <Banner
          status="error"
          title="That history could not be loaded"
          description={`${historyError}. This is a failed request, not an empty range.`}
        />
      ) : null}
      {tags !== null && seriesList !== null && first === null ? (
        <Banner status="info" title="No strategy has any recorded history yet" />
      ) : null}

      {/*
        THE SUMMARY STRIP. `total` over the range is null when ANY day in it
        could not be marked — a range total that silently omits an unmarked day
        is a number nobody can reconcile against the days below it. The rest is
        on realised, which every day has.
      */}
      <div data-testid="report-summary">
        <Card>
          <HStack gap={6} padding={4} align="center" wrap="wrap">
            <VStack gap={1}>
              <Text size="sm" color="secondary">Total over the range</Text>
              <Money value={totals?.total ?? null} size="2xl" />
            </VStack>
            <VStack gap={1}>
              <Text size="sm" color="secondary">Total realised</Text>
              <Money value={history === null ? null : summary.realised} />
            </VStack>
            <VStack gap={1}>
              <Text size="sm" color="secondary">Trading days</Text>
              <Text size="lg" weight="bold">{history === null ? '—' : inr(summary.days)}</Text>
            </VStack>
            <VStack gap={1}>
              <Text size="sm" color="secondary">Winning days</Text>
              <Text size="lg" weight="bold">
                {history === null ? '—' : `${inr(summary.winning)} of ${inr(summary.days)}`}
              </Text>
            </VStack>
            <VStack gap={1}>
              <Text size="sm" color="secondary">Best day</Text>
              <Text size="lg" weight="bold">{dayFigure(summary.best)}</Text>
            </VStack>
            <VStack gap={1}>
              <Text size="sm" color="secondary">Worst day</Text>
              <Text size="lg" weight="bold">{dayFigure(summary.worst)}</Text>
            </VStack>
            <VStack gap={1}>
              <Text size="sm" color="secondary">Orders</Text>
              <Text size="lg" weight="bold">{totals === null ? '—' : inr(totals.orderCount)}</Text>
            </VStack>
          </HStack>
          {/* The combined view's realised, per symbol, over the range. */}
          {perSymbol !== null && perSymbol.length > 0 ? (
            <div data-testid="report-by-symbol" style={{ padding: '0 var(--spacing-4, 16px) var(--spacing-4, 16px)' }}>
              <Text size="sm" weight="medium">
                {perSymbol.map((p) => `${p.symbol} ${money(p.realised)}`).join(' · ')}
              </Text>
            </div>
          ) : null}
        </Card>
      </div>

      <Card>
        <VStack gap={3} padding={4}>
          <HStack justify="between" align="center" wrap="wrap">
            <VStack gap={0}>
              <Heading level={3}>{`Daily P&L — ${label ?? 'no strategy'}`}</Heading>
              {viewNote !== null ? <Text size="sm" color="secondary">{viewNote}</Text> : null}
            </VStack>
            <Text size="sm" color="secondary">{`${from} to ${to} IST`}</Text>
          </HStack>
          {history === null && historyError === null ? (
            <Text color="secondary">Loading…</Text>
          ) : (
            <DailyPnlChart
              rows={rows}
              emptyNote="No day in this range has a rollup for this strategy."
            />
          )}
          {/*
            A gap in the record is not a flat day, and the chart cannot show the
            difference — a missing bar and a zero-height bar look the same. So
            the count is said in words rather than left to be inferred.
          */}
          {history !== null && history.missingDays > 0 ? (
            <Text size="sm" color="secondary">
              {`${history.missingDays} trading day${history.missingDays === 1 ? '' : 's'} in this ` +
                'range have no rollup at all — the strategy was off, or the rollup was never ' +
                'written. They are absent from the chart rather than drawn as zero.'}
            </Text>
          ) : null}
        </VStack>
      </Card>

      <Card>
        <VStack gap={3} padding={4}>
          <Heading level={3}>Days</Heading>
          {rows.length > 0 ? (
            // The table scrolls inside its card on a phone; the page never does.
            <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
              <Table data={rows} columns={columns} density="compact" hasHover />
            </div>
          ) : (
            <Text color="secondary">
              {history === null
                ? 'Nothing was recorded for this strategy in this range.'
                : `No ${props.mode} day was recorded for ${label ?? 'this strategy'} between ${from} and ${to}.`}
            </Text>
          )}
        </VStack>
      </Card>

      {/* Opened by clicking a tag on a day. Not on screen until someone asks for it. */}
      {openLog !== null ? (
        <Card>
          <VStack gap={3} padding={4}>
            <HStack justify="between" align="center" wrap="wrap">
              <Heading level={3}>{`Order log — ${openLog.date} · ${openLog.tag}`}</Heading>
              <Button variant="ghost" size="sm" label="Close" onClick={() => setOpenLog(null)} />
            </HStack>
            {orderError !== null ? (
              <Banner status="error" title="The order log could not be loaded" description={orderError} />
            ) : null}
            {orders !== null && orders.events.length === 0 ? (
              <Text color="secondary">
                {props.mode === 'paper'
                  ? 'Paper orders are not journalled — this log covers live routing and refusals only.'
                  : `No submissions from ${openLog.tag} on this day.`}
              </Text>
            ) : null}
            {orders !== null && orders.events.length > 0 ? (
              // One row per ORDER, grouped by the step that placed it — not one
              // row per journal phase. See `report-orders.ts`.
              <ReportOrderLog events={orders.events} />
            ) : null}
          </VStack>
        </Card>
      ) : null}

      <PruneCard />
    </VStack>
  )
}
