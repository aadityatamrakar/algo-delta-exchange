/**
 * Portfolio (spec item 26): one row per book with its greeks, Today and P&L (spec 2026-10-23), margin and
 * band, a totals row, and a Month wise view that opens each book into its
 * expiries. An admin also sees the roll-up by trader and by underlying; a
 * trader's session never asks for it.
 *
 * Delta is shares in the rows; across underlyings it is added as money (the
 * totals row's "delta value"), which is the only sum that means anything.
 */

import { useState, type ReactElement } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { BellAlert } from './bell.tsx'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { Switch } from '@astryxdesign/core/Switch'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { inr, sign, signed } from '../format.ts'
import type { AdminPortfolioView, PortfolioView, StockAcross } from '../../../traders/src/analytics/r3-wire.ts'
import type { BandState } from '../../../traders/src/types.ts'
import type { VolRow, VolView } from '../../../traders/src/analytics/context-wire.ts'
import { BAND_DOT, BAND_WORD } from './advice.tsx'
import { tapi } from './api.ts'
import { useDocumentVisible, usePoll, useSession } from './hooks.ts'
import { SERVER_UPDATE_PENDING, expiryDayLabel, istHm } from './wire.ts'
import { Caveats } from './caveats.tsx'
import { TradersTable, sortByField, type TradersColumn } from './table.tsx'
import { useVolView, volColumns, volRows } from './vol.tsx'

export const PORTFOLIO_POLL_MS = 60_000

type Cells = Record<string, unknown>

interface Line extends Cells {
  readonly id: string
  readonly kind: 'book' | 'month' | 'totals'
  readonly label: string
  readonly delta: number | null; readonly deltaNote: string | null
  readonly gamma: number | null; readonly vega: number | null; readonly theta: number | null
  /** Today (the MTM block's total) and P&L (the series net), each with why it is unknown when it is. */
  readonly mtmDay: number | null; readonly mtmDayReason: string | null; readonly pnl: number | null; readonly pnlReason: string | null
  readonly margin: number | null; readonly marginLabel: string | null; readonly marginNote: string | null
  readonly band: BandState | null; readonly bandSentence: string | null
  /** The book's end-of-day volatility row (GET /vol); null on month and totals rows, or when the view has none. */
  readonly vol: VolRow | null
}

/** The server's reasons for a book with no P&L to count (analytics/portfolio.ts), as tooltips: left out of its sums, never unknown. */
export const SHARES_PNL_TITLE = 'P&L counts F&O series only — shares are not in it'
const PNL_TITLES: Readonly<Record<string, string>> = { 'no live expiry': SHARES_PNL_TITLE, 'no series': 'P&L not available' }
/** A row's P&L reason as its tooltip. */
const pnlTitle = (reason: string | null | undefined): string | null =>
  reason === null || reason === undefined ? null : PNL_TITLES[reason] ?? reason

function lines(view: PortfolioView, monthWise: boolean, vol: VolView | null = null): Line[] {
  const out: Line[] = []
  const volOf = new Map(volRows(vol).map((v) => [v.stock, v]))
  for (const r of view.rows) {
    out.push({
      id: r.stock, kind: 'book', label: r.stock,
      delta: r.delta, deltaNote: r.deltaLots === null ? null : `${signed(r.deltaLots, 1)} lots`,
      // only the new server sends mtmDayReason: the old server's mtmDay is on the old basis, so it is not shown (G5);
      // an older one sends no pnl either: "—"
      gamma: r.gamma, vega: r.vega, theta: r.theta,
      pnl: r.pnl ?? null, pnlReason: r.pnl === undefined ? SERVER_UPDATE_PENDING : pnlTitle(r.pnlReason),
      ...(r.mtmDayReason === undefined ? { mtmDay: null, mtmDayReason: SERVER_UPDATE_PENDING } : { mtmDay: r.mtmDay, mtmDayReason: r.mtmDayReason }),
      margin: r.margin, marginLabel: r.marginLabel, marginNote: r.margin === null ? 'margin missing' : null, band: r.band, bandSentence: r.bandSentence,
      vol: volOf.get(r.stock) ?? null,
    })
    if (!monthWise) continue
    for (const m of r.months) {
      out.push({
        id: `${r.stock}|${m.expiry}`, kind: 'month', label: m.expiry === '' ? 'Shares' : expiryDayLabel(m.expiry),
        delta: m.delta, deltaNote: null, gamma: m.gamma, vega: m.vega, theta: m.theta, mtmDay: null, mtmDayReason: null,
        // the shares have no series; a live expiry's unknown is the book's
        pnl: m.pnl ?? null, pnlReason: m.expiry === '' ? SHARES_PNL_TITLE : pnlTitle(r.pnlReason),
        margin: null, marginLabel: null, marginNote: null, band: null, bandSentence: null, vol: null,
      })
    }
  }
  const t = view.totals
  out.push({
    id: 'totals', kind: 'totals', label: `Total (${t.books} ${t.books === 1 ? 'book' : 'books'}, ${t.outOfBand} out of band)`,
    delta: t.deltaValue, deltaNote: 'delta value', gamma: null, vega: t.vega, theta: t.theta,
    mtmDay: t.mtmDay ?? null, pnl: t.pnl ?? null,
    mtmDayReason: view.rows.some((r) => r.mtmDayReason === undefined) ? SERVER_UPDATE_PENDING : view.rows.find((r) => r.mtmDayReason)?.mtmDayReason ?? null,
    // the server's total leaves out books with nothing to count, and is null when none counts
    pnlReason: view.rows.some((r) => r.pnl === undefined) ? SERVER_UPDATE_PENDING : pnlTitle(t.pnlReason),
    margin: t.margin, marginLabel: null,
    marginNote: t.marginMissing.length === 0 ? null : `Margin missing: ${t.marginMissing.join(', ')}`,
    band: null, bandSentence: null, vol: null,
  })
  return out
}

/** A dash for null, and for what an older server does not send (undefined). */
function figure(n: number | null | undefined, digits: number): ReactElement {
  if (n === null || n === undefined) return <Text size="sm" color="secondary">—</Text>
  return <Text size="sm" style={{ whiteSpace: 'nowrap', ...sign(n) }}>{signed(n, digits)}</Text>
}

/** Today or P&L: a dash, with the reason on hover ("market opens 09:15"), when it is unknown. */
function dayFigure(n: number | null | undefined, why: string | null | undefined): ReactElement {
  const fig = figure(n, 0)
  return (n === null || n === undefined) && why ? <span title={why}>{fig}</span> : fig
}

/** Which SPAN file each book's margin was read from, one line per file: the cell's tooltip needs a mouse. */
function marginSources(view: PortfolioView): string[] {
  const by = new Map<string, string[]>()
  for (const r of view.rows) {
    if (r.margin === null || r.marginLabel === null) continue
    const stocks = by.get(r.marginLabel)
    if (stocks === undefined) by.set(r.marginLabel, [r.stock])
    else stocks.push(r.stock)
  }
  return [...by].map(([label, stocks]) => `Margin read from ${label}: ${stocks.join(', ')}`)
}

const weight = (l: Line): 'bold' | 'normal' => (l.kind === 'book' || l.kind === 'totals' ? 'bold' : 'normal')

const PORTFOLIO_COLUMNS: TradersColumn<Line>[] = [...sortByField<Line>([
  { key: 'label', header: 'Underlying', renderCell: (l) => <Text size="sm" weight={weight(l)} color={l.kind === 'month' ? 'secondary' : 'primary'}>{l.label}</Text> },
  {
    key: 'delta', header: 'Delta', align: 'end',
    renderCell: (l) => (
      <VStack gap={0} align="end">
        {figure(l.delta, 0)}
        {l.deltaNote === null ? null : <Text size="sm" color="secondary">{l.deltaNote}</Text>}
      </VStack>
    ),
  },
  { key: 'gamma', header: 'Gamma', align: 'end', renderCell: (l) => figure(l.gamma, 4) },
  { key: 'vega', header: 'Vega', align: 'end', renderCell: (l) => figure(l.vega, 0) },
  { key: 'theta', header: 'Theta', align: 'end', renderCell: (l) => figure(l.theta, 0) },
  { key: 'mtmDay', header: 'Today', align: 'end', renderCell: (l) => dayFigure(l.mtmDay, l.mtmDayReason) },
  { key: 'pnl', header: 'P&L', align: 'end', renderCell: (l) => dayFigure(l.pnl, l.pnlReason) },
  {
    key: 'margin', header: 'Margin', align: 'end',
    renderCell: (l) => {
      const n = l.margin === null ? <Text size="sm" color="secondary">—</Text> : <Text size="sm" style={{ whiteSpace: 'nowrap' }}>{inr(l.margin)}</Text>
      return (
        <VStack gap={0} align="end">
          {l.marginLabel === null ? n : <Tooltip content={l.marginLabel}>{n}</Tooltip>}
          {l.marginNote === null ? null : <Text size="sm" color="secondary">{l.marginNote}</Text>}
        </VStack>
      )
    },
  },
  {
    key: 'band', header: 'Band',
    renderCell: (l) => l.band === null ? null : (
      <HStack gap={1} align="center">
        <StatusDot variant={BAND_DOT[l.band]} label={BAND_WORD[l.band]} />
        <Text size="sm">{l.bandSentence ?? BAND_WORD[l.band]}</Text>
      </HStack>
    ),
  },
], ['label', 'delta', 'gamma', 'vega', 'theta', 'mtmDay', 'pnl', 'margin']), ...volColumns<Line>()]

export function PortfolioTable(props: { view: PortfolioView; monthWise: boolean; vol?: VolView | null }): ReactElement {
  return (
    <VStack gap={2}>
      <TradersTable
        aria-label="Portfolio" data={lines(props.view, props.monthWise, props.vol ?? null)} columns={PORTFOLIO_COLUMNS}
        idKey="id" density="compact" keepLast={(l) => l.kind === 'totals'} isChild={(l) => l.kind === 'month'}
      />
      {marginSources(props.view).map((line) => <Text key={line} size="sm" color="secondary">{line}</Text>)}
    </VStack>
  )
}

// ------------------------------------------------------------- admin roll-up

type TraderLine = Cells & { readonly id: string } & AdminPortfolioView['traders'][number]['totals'] & { readonly trader: string }

const col = <R extends Cells>(key: string, header: string, render: (r: R) => ReactElement, align?: 'end'): TableColumn<R> =>
  ({ key, header, ...(align === undefined ? {} : { align }), renderCell: (r) => render(r as R) })

const TRADER_COLUMNS: TradersColumn<TraderLine>[] = sortByField<TraderLine>([
  col('trader', 'Trader', (r) => <Text size="sm" weight="bold">{r.trader}</Text>),
  col('books', 'Books', (r) => <Text size="sm">{`${r.books} (${r.outOfBand} out of band)`}</Text>, 'end'),
  col('deltaValue', 'Delta value', (r) => figure(r.deltaValue, 0), 'end'),
  col('vega', 'Vega', (r) => figure(r.vega, 0), 'end'),
  col('theta', 'Theta', (r) => figure(r.theta, 0), 'end'),
  col('mtmDay', 'Today', (r) => figure(r.mtmDay, 0), 'end'),
  col('pnl', 'P&L', (r) => dayFigure(r.pnl, pnlTitle(r.pnlReason)), 'end'),
  col('margin', 'Margin', (r) => (
    <VStack gap={0} align="end">
      <Text size="sm">{inr(r.margin)}</Text>
      {r.marginMissing.length === 0 ? null : <Text size="sm" color="secondary">{`Margin missing: ${r.marginMissing.join(', ')}`}</Text>}
    </VStack>
  ), 'end'),
], ['trader', 'books', 'deltaValue', 'vega', 'theta', 'mtmDay', 'pnl', 'margin'])

type StockLine = Cells & { readonly id: string; readonly marginMissing: boolean } & StockAcross

const STOCK_COLUMNS: TradersColumn<StockLine>[] = sortByField<StockLine>([
  col('stock', 'Underlying', (r) => <Text size="sm" weight="bold">{r.stock}</Text>),
  col('traders', 'Traders', (r) => <Text size="sm">{r.traders}</Text>, 'end'),
  col('delta', 'Delta', (r) => (
    <VStack gap={0} align="end">
      {figure(r.delta, 0)}
      {r.deltaLots === null ? null : <Text size="sm" color="secondary">{`${signed(r.deltaLots, 1)} lots`}</Text>}
    </VStack>
  ), 'end'),
  col('gamma', 'Gamma', (r) => figure(r.gamma, 4), 'end'),
  col('vega', 'Vega', (r) => figure(r.vega, 0), 'end'),
  col('theta', 'Theta', (r) => figure(r.theta, 0), 'end'),
  col('mtmDay', 'Today', (r) => figure(r.mtmDay, 0), 'end'),
  col('pnl', 'P&L', (r) => dayFigure(r.pnl, pnlTitle(r.pnlReason)), 'end'),
  col('margin', 'Margin', (r) => (
    <VStack gap={0} align="end">
      <Text size="sm">{inr(r.margin)}</Text>
      {r.marginMissing ? <Text size="sm" color="secondary">margin missing for some traders</Text> : null}
    </VStack>
  ), 'end'),
], ['stock', 'traders', 'delta', 'gamma', 'vega', 'theta', 'mtmDay', 'pnl', 'margin'])

function AdminRollup(): ReactElement {
  // The costliest R3 read: a hidden tab asks for none of it.
  const visible = useDocumentVisible()
  const roll = usePoll(() => tapi.adminPortfolio(), PORTFOLIO_POLL_MS, [], visible)
  const v = roll.data
  if (v === null) {
    return roll.error === null
      ? <Text color="secondary">Loading the roll-up…</Text>
      : <Banner status="error" title={`Could not load the roll-up: ${roll.error}`} />
  }
  return (
    <VStack gap={3}>
      <BellAlert text={roll.error === null ? null : `Refresh failed: ${roll.error}`} />
      <Caveats items={v.warnings} kind="warning" />
      <Heading level={4}>By trader</Heading>
      <TradersTable
        aria-label="By trader" density="compact" idKey="id" columns={TRADER_COLUMNS}
        data={v.traders.map((t) => ({ ...t.totals, trader: t.trader, id: t.trader }))}
      />
      <Heading level={4}>By underlying (all traders)</Heading>
      <TradersTable
        aria-label="By underlying" density="compact" idKey="id" columns={STOCK_COLUMNS}
        data={v.stocks.map((s) => ({ ...s, id: s.stock, marginMissing: v.traders.some((t) => t.totals.marginMissing.includes(s.stock)) }))}
      />
    </VStack>
  )
}

// --------------------------------------------------------------------- page

export function PortfolioPage(): ReactElement {
  const session = useSession()
  const asTrader = session?.asTrader ?? null
  const [monthWise, setMonthWise] = useState(false)
  const visible = useDocumentVisible()
  const book = usePoll(() => tapi.portfolio(), PORTFOLIO_POLL_MS, [asTrader], visible)
  const vol = useVolView(visible)   // a failure leaves the Vol columns blank; the Vol page says why
  const v = book.data
  // An admin who has not named a trader gets a prompt, not the server's refusal.
  const needsPick = v === null && book.status === 400 && session?.role === 'admin' && asTrader === null

  return (
    <VStack gap={3}>
      <HStack gap={3} align="center" wrap="wrap">
        {v === null ? null : <Text color="secondary" size="sm">{`${v.trader} · as of ${istHm(v.asOf)} IST`}</Text>}
        <Switch label="Month wise" value={monthWise} onChange={setMonthWise} />
      </HStack>
      {needsPick ? <Text color="secondary">Pick a trader to see their portfolio</Text> : book.error === null ? null : (
        v === null
          ? <BellAlert status="error" inline text={`Could not load the portfolio: ${book.error}`} />
          : <BellAlert text={`Refresh failed: ${book.error}`} />
      )}
      {v === null ? (book.error === null && !needsPick ? <Text color="secondary">Loading the portfolio…</Text> : null) : (
        <>
          <Caveats items={v.warnings} kind="warning" />
          {v.rows.length === 0 ? <Text color="secondary">No open books.</Text> : null}
          <PortfolioTable view={v} monthWise={monthWise} vol={vol.data} />
        </>
      )}
      {session?.role === 'admin' ? <AdminRollup /> : null}
    </VStack>
  )
}

