/**
 * Risk (`GET /risk`, `GET /events`; docs/superpowers/specs/2026-10-24-traders-risk-design.md §3): the portfolio under
 * stress, the results dates ahead, the historical replay, concentration and correlated clusters. Every rupee figure is
 * a Change or a Loss from the books' value now, never a P&L (ruling R1). The numbers are the server's; this file only
 * formats them.
 */

import { useState, type ReactElement } from 'react'
import { Badge } from '@astryxdesign/core/Badge'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { inr, sign } from '../format.ts'
import type { CorrelatedCluster, EventOutcome, EventRiskRow, EventRiskView, RiskBook, RiskView } from '../../../traders/src/analytics/risk-wire.ts'
import { tapi } from './api.ts'
import { BellAlert } from './bell.tsx'
import { Caveats } from './caveats.tsx'
import { colourStep, stepFill } from './colour-scale.ts'
import { useDocumentVisible, usePoll, useSession, type Polled } from './hooks.ts'
import { TradersTable, type TradersColumn } from './table.tsx'
import { expiryDayLabel } from './wire.ts'
import { RISK_POLL_MS, dm, rs, useEventsView } from './results-badge.tsx'

export { RISK_POLL_MS, ResultsBadge, dm, resultsBadgeOf, rs, useEventsView } from './results-badge.tsx'

const DASH = '—'
const MINUS = '−'

export function useRiskView(enabled: boolean): Polled<RiskView> {
  const asTrader = useSession()?.asTrader ?? null
  return usePoll(() => tapi.risk(), RISK_POLL_MS, [asTrader], enabled)
}


// ------------------------------------------------------------------ figures

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** A signed decimal as percent: 0.0312 → "+3.1%". */
export function pctSigned(x: number | null | undefined, digits = 1): string {
  if (!isNum(x)) return DASH
  const s = (Math.abs(x) * 100).toFixed(digits)
  return x < 0 ? `${MINUS}${s}%` : x > 0 ? `+${s}%` : `${s}%`
}
const pctPlain = (x: number | null | undefined, digits = 1): string => (isNum(x) ? `${(x * 100).toFixed(digits)}%` : DASH)
const fix = (x: number | null | undefined, d: number): string => (isNum(x) ? (x < 0 ? `${MINUS}${Math.abs(x).toFixed(d)}` : x.toFixed(d)) : DASH)
const ptsSigned = (x: number | null | undefined): string => (isNum(x) ? `${x < 0 ? MINUS : x > 0 ? '+' : ''}${Math.abs(x).toFixed(1)}` : DASH)

function Fig(p: { text: string; tint?: number | null | undefined; fill?: string | undefined; title?: string | undefined; bold?: boolean; faded?: boolean }): ReactElement {
  const tone = p.tint === undefined || p.tint === null ? undefined : sign(p.tint)
  return (
    <Text size="sm" weight={p.bold === true ? 'bold' : 'normal'} color={p.text === DASH || p.faded === true ? 'secondary' : 'primary'}
      {...(p.title === undefined ? {} : { title: p.title })}
      style={{ whiteSpace: 'nowrap', ...tone, ...(p.fill === undefined ? {} : { background: p.fill, padding: '0 4px', borderRadius: 3 }) }}>
      {p.text}
    </Text>
  )
}

function Pair(p: { label: string; value: string; n?: number | null; title?: string | undefined }): ReactElement {
  return (
    <span className="traders-pair">
      <Text color="secondary" size="sm">{p.label}</Text>
      <Fig text={p.value} tint={p.n ?? null} bold title={p.title} />
    </span>
  )
}

// ------------------------------------------------------------------ headline and totals

function Totals(p: { risk: RiskView }): ReactElement {
  const t = p.risk.totals
  const lots = t.niftyLots
  return (
    <VStack gap={1}>
      {p.risk.headline === null ? <Text color="secondary">No stress figure yet.</Text> : <Text weight="bold">{p.risk.headline}</Text>}
      <HStack gap={4} wrap="wrap">
        <Pair label="β-weighted Δ" value={rs(t.betaDeltaRupees, true)} n={t.betaDeltaRupees} title="NIFTY-equivalent exposure in rupees: delta × beta" />
        <Pair label="NIFTY lots" value={isNum(lots) ? `${lots < 0 ? MINUS : lots > 0 ? '+' : ''}${Math.abs(lots).toFixed(1)}` : DASH} n={lots} />
        <Pair label="NIFTY +1% change" value={rs(t.niftyUp1, true)} n={t.niftyUp1} />
        <Pair label={`NIFTY ${MINUS}1% change`} value={rs(t.niftyDown1, true)} n={t.niftyDown1} />
      </HStack>
    </VStack>
  )
}

// ------------------------------------------------------------------ stress grid

type GridLine = Record<string, unknown> & { readonly id: string; readonly i: number }

const moveLabel = (m: number): string => (m < 0 ? `${MINUS}${Math.abs(m)}%` : m > 0 ? `+${m}%` : '0%')
const volLabel = (v: number): string => (v < 0 ? `${MINUS}${Math.abs(v)}` : v > 0 ? `+${v}` : '0')

export function StressGrid(p: { risk: RiskView }): ReactElement {
  const { moves, vols, cells, worst, excluded } = p.risk.grid
  const biggest = Math.max(0, ...cells.flatMap((row) => row.map((c) => (isNum(c) ? Math.abs(c) : 0))))
  const columns: TradersColumn<GridLine>[] = [
    { key: 'move', header: 'NIFTY', renderCell: (l) => <Fig text={moveLabel(moves[l.i] ?? 0)} bold /> },
    ...vols.map((v, j): TradersColumn<GridLine> => ({
      key: `v${j}`, header: `Vol ${volLabel(v)}`, align: 'end',
      renderCell: (l) => {
        const c = cells[l.i]?.[j] ?? null
        const w = worst[l.i]?.[j] ?? null
        const centre = moves[l.i] === 0 && v === 0
        const tone = !isNum(c) ? 'none' : c < 0 ? 'loss' : c > 0 ? 'gain' : 'flat'
        return (
          <span data-cell={`${l.i}:${j}`} data-tone={tone} {...(centre ? { 'data-centre': 'true' } : {})}
            style={centre ? { outline: '2px solid currentColor', outlineOffset: 1, borderRadius: 3, display: 'inline-block' } : undefined}>
            <Fig text={rs(c)} tint={c} fill={stepFill(colourStep(c, -biggest, biggest))}
              title={isNum(c) && c < 0 && w !== null ? `Worst book: ${w}` : isNum(c) ? undefined : 'No book could be valued'} />
          </span>
        )
      },
    })),
  ]
  const data: GridLine[] = moves.map((_, i) => ({ id: `m${i}`, i }))
  return (
    <VStack gap={1}>
      <Heading level={4}>Stress</Heading>
      <Text size="sm" color="secondary">Change if NIFTY moves and every option&apos;s IV shifts by the vol points; each stock moves beta × NIFTY.</Text>
      <TradersTable aria-label="Stress grid" data={data} columns={columns} idKey="id" density="compact" />
      {excluded.length === 0 ? null : <Text size="sm" color="secondary">{`Left out: ${excluded.map((e) => `${e.stock} (${e.why})`).join('; ')}`}</Text>}
    </VStack>
  )
}

// ------------------------------------------------------------------ results

type EvLine = Record<string, unknown> & {
  readonly id: string
  readonly kind: 'row' | 'past'
  readonly row: EventRiskRow
  readonly past?: EventRiskRow['past'][number]
}

const OUTCOME_LABEL: Record<EventOutcome['label'], string> = { up: 'Up', down: 'Down', 'up-big': 'Up big', 'down-big': 'Down big', 'crush-only': 'Crush only' }
const OUTCOMES: readonly EventOutcome['label'][] = ['up', 'down', 'up-big', 'down-big', 'crush-only']
const VERDICT_FILL: Record<string, string | undefined> = { rich: stepFill(-2), cheap: stepFill(2) }

const outcomeOf = (r: EventRiskRow, label: EventOutcome['label']): EventOutcome | undefined => r.outcomes.find((o) => o.label === label)

function resultsColumns(open: ReadonlySet<string>, toggle: (stock: string) => void): TradersColumn<EvLine>[] {
  const rowOnly = (render: (r: EventRiskRow, n: NonNullable<EventRiskRow['next']>) => ReactElement) => (l: EvLine): ReactElement | null =>
    l.kind === 'row' && l.row.next !== null ? render(l.row, l.row.next) : null
  const faded = (l: EvLine): boolean => l.row.provisional
  return [
    {
      key: 'stock', header: 'Stock', sortValue: (l) => (l.kind === 'row' ? l.row.stock : null),
      renderCell: (l) => l.kind === 'past' ? null : (
        <button type="button" aria-expanded={open.has(l.row.stock)} aria-label={`${l.row.stock} past reactions`}
          onClick={() => toggle(l.row.stock)} style={{ all: 'unset', cursor: 'pointer' }}
          title={l.row.warnings.length > 0 ? l.row.warnings.join('\n') : undefined}>
          <Text size="sm" weight="bold" color={faded(l) ? 'secondary' : 'primary'}>{`${open.has(l.row.stock) ? '▾' : '▸'} ${l.row.stock}`}</Text>
        </button>
      ),
    },
    {
      key: 'date', header: 'Date', sortValue: (l) => (l.kind === 'row' ? l.row.next?.days ?? null : null),
      renderCell: (l) => l.kind === 'past'
        ? <Fig text={l.past === undefined ? DASH : expiryDayLabel(l.past.date)} faded />
        : l.row.next === null ? null : <Fig text={`${dm(l.row.next.date)} · ${l.row.next.days}d`} faded={faded(l)} title={l.row.next.purpose} />,
    },
    {
      key: 'expiry', header: 'Expiry',
      renderCell: rowOnly((r, n) => (
        <HStack gap={1} align="center">
          <Fig text={n.expiry === null ? DASH : dm(n.expiry)} faded={r.provisional} />
          {n.inNear ? <Badge variant="warning" label="near" /> : null}
        </HStack>
      )),
    },
    {
      key: 'implied', header: 'Implied move', align: 'end', sortValue: (l) => (l.kind === 'row' ? l.row.impliedMove : null),
      renderCell: rowOnly((r) => <Fig text={pctPlain(r.impliedMove)} faded={r.provisional} title={r.impliedMove === null ? 'No live straddle for that expiry' : undefined} />),
    },
    {
      key: 'past', header: 'Past |move| (n)', align: 'end', sortValue: (l) => (l.kind === 'row' ? l.row.pastAbsMean : null),
      renderCell: (l) => l.kind === 'past'
        ? <Fig text={l.past === undefined ? DASH : pctSigned(l.past.move)} tint={l.past?.move ?? null} />
        : <Fig text={l.row.pastAbsMean === null ? DASH : `${pctPlain(l.row.pastAbsMean)} (${l.row.past.length})`} faded={faded(l)}
            title={l.row.pastAbsMean === null ? 'No past results reactions in the history' : `Median ${pctPlain(l.row.pastAbsMedian)}`} />,
    },
    {
      key: 'ratio', header: 'Ratio', align: 'end', sortValue: (l) => (l.kind === 'row' ? l.row.ratio : null),
      renderCell: rowOnly((r) => (
        <HStack gap={1} align="center" justify="end">
          <Fig text={fix(r.ratio, 2)} faded={r.provisional} title={r.ratio === null ? 'Needs the implied move and past reactions' : undefined} />
          {r.verdict === 'unknown' ? null : <Fig text={r.verdict} fill={r.provisional ? undefined : VERDICT_FILL[r.verdict]} faded={r.provisional} />}
          {r.provisional ? <Text size="sm" color="secondary">provisional</Text> : null}
        </HStack>
      )),
    },
    {
      key: 'crush', header: 'Mean crush (pts)', align: 'end', sortValue: (l) => (l.kind === 'row' ? l.row.crushMeanPts : null),
      renderCell: (l) => l.kind === 'past'
        ? <Fig text={ptsSigned(l.past?.crushPts)} tint={l.past?.crushPts ?? null} />
        : <Fig text={ptsSigned(l.row.crushMeanPts)} tint={l.row.crushMeanPts} faded={faded(l)} />,
    },
    ...OUTCOMES.map((label): TradersColumn<EvLine> => ({
      key: label, header: OUTCOME_LABEL[label], align: 'end',
      renderCell: rowOnly((r) => {
        const o = outcomeOf(r, label)
        return <Fig text={o === undefined ? DASH : rs(o.change, true)} tint={o?.change ?? null} faded={r.provisional}
          title={o !== undefined ? `Spot ${pctSigned(o.move)}, vol ${ptsSigned(o.volPts)} pts` : r.next?.heldThrough === true ? 'Not priced' : 'The book does not hold through the date'} />
      }),
    })),
  ]
}

export function ResultsTable(p: { events: EventRiskView }): ReactElement {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (stock: string): void => setOpen((s) => { const n = new Set(s); if (n.has(stock)) n.delete(stock); else n.add(stock); return n })
  const rows = p.events.rows.filter((r) => r.next !== null).sort((a, b) => (a.next?.days ?? 0) - (b.next?.days ?? 0) || a.stock.localeCompare(b.stock))
  const data: EvLine[] = rows.flatMap((row) => [
    { id: row.stock, kind: 'row' as const, row },
    ...(open.has(row.stock) ? [...row.past].reverse().map((past) => ({ id: `${row.stock}:${past.date}`, kind: 'past' as const, row, past })) : []),
  ])
  return (
    <VStack gap={1}>
      <Heading level={4}>Results</Heading>
      {rows.length === 0 ? <Text color="secondary">No results dates ahead.</Text> : (
        <TradersTable aria-label="Results" data={data} columns={resultsColumns(open, toggle)} idKey="id" density="compact" isChild={(l) => l.kind === 'past'} />
      )}
      <Text size="sm" color="secondary">Straddle covers the whole time to expiry, not only the event.</Text>
    </VStack>
  )
}

// ------------------------------------------------------------------ replay

type DayLine = Record<string, unknown> & { readonly id: string; readonly day: RiskView['replay']['worstDays'][number] }

export function ReplaySection(p: { risk: RiskView }): ReactElement {
  const r = p.risk.replay
  const why = `Needs 60 days of history for every held stock (${r.days} aligned)`
  const none = (n: number | null): string | undefined => (n === null ? why : undefined)
  const columns: TradersColumn<DayLine>[] = [
    { key: 'date', header: 'Date', renderCell: (l) => <Fig text={expiryDayLabel(l.day.date)} bold /> },
    { key: 'change', header: 'Change', align: 'end', renderCell: (l) => <Fig text={rs(l.day.change, true)} tint={l.day.change} /> },
    { key: 'nifty', header: 'NIFTY', align: 'end', renderCell: (l) => <Fig text={pctSigned(l.day.niftyPct === null ? null : l.day.niftyPct / 100, 2)} /> },
    {
      key: 'books', header: 'By book',
      renderCell: (l) => <Fig text={l.day.books.map((b) => `${b.stock} ${rs(b.change, true)}`).join(' · ')} title={l.day.books.map((b) => `${b.stock} ${pctSigned(b.movePct / 100, 2)}`).join(' · ')} />,
    },
  ]
  return (
    <VStack gap={1}>
      <Heading level={4}>Historical replay</Heading>
      <HStack gap={4} wrap="wrap">
        <Pair label="VaR 95" value={rs(r.var95)} n={r.var95} title={none(r.var95)} />
        <Pair label="VaR 99" value={rs(r.var99)} n={r.var99} title={none(r.var99)} />
        <Pair label="ES 99" value={rs(r.es99)} n={r.es99} title={none(r.es99)} />
        <Pair label="Days" value={String(r.days)} />
      </HStack>
      {r.worstDays.length === 0 ? null : (
        <TradersTable aria-label="Worst days" data={r.worstDays.map((day) => ({ id: day.date, day })) as DayLine[]} columns={columns} idKey="id" density="compact" />
      )}
    </VStack>
  )
}

// ------------------------------------------------------------------ concentration and clusters

type BookLine = Record<string, unknown> & RiskBook & { readonly id: string }

const COLUMNS_BOOK: TradersColumn<BookLine>[] = [
  { key: 'stock', header: 'Book', renderCell: (l) => <Fig text={l.stock} bold title={l.warnings.length > 0 ? l.warnings.join('\n') : undefined} /> },
  { key: 'beta', header: 'β', align: 'end', renderCell: (l) => <Fig text={fix(l.beta, 2)} title={l.beta === null ? `Needs 60 days of returns (${l.betaDays})` : `${l.betaDays} days`} /> },
  { key: 'rho', header: 'ρ', align: 'end', renderCell: (l) => <Fig text={fix(l.niftyCorr, 2)} /> },
  { key: 'bd', header: 'β-Δ ₹', align: 'end', renderCell: (l) => <Fig text={rs(l.betaDeltaRupees, true)} tint={l.betaDeltaRupees} /> },
  { key: 'loss', header: '2σ loss', align: 'end', renderCell: (l) => <Fig text={rs(l.twoSigmaLoss)} tint={l.twoSigmaLoss} title={l.twoSigmaLoss === null ? 'No day σ, or unpriced' : `Day σ ${pctPlain(l.daySigma, 2)}`} /> },
  {
    key: 'share', header: 'Share', align: 'end',
    renderCell: (l) => (
      <HStack gap={1} align="center" justify="end">
        <span aria-hidden style={{ display: 'inline-block', width: 80, height: 8, background: 'rgba(128,128,128,.2)', borderRadius: 4 }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, l.sharePct ?? 0))}%`, background: 'var(--color-error)', borderRadius: 4 }} />
        </span>
        <Fig text={isNum(l.sharePct) ? `${l.sharePct.toFixed(0)}%` : DASH} title={l.sharePct === null ? 'Some book has no 2σ loss' : undefined} />
      </HStack>
    ),
  },
]

/** Largest share first; no share last, by stock. */
export function byShare(books: readonly RiskBook[]): RiskBook[] {
  return [...books].sort((a, b) => (b.sharePct ?? -1) - (a.sharePct ?? -1) || a.stock.localeCompare(b.stock))
}

export function ConcentrationSection(p: { risk: RiskView }): ReactElement {
  return (
    <VStack gap={1}>
      <Heading level={4}>Concentration</Heading>
      {p.risk.books.length === 0 ? <Text color="secondary">No open books.</Text> : (
        <TradersTable aria-label="Concentration" data={byShare(p.risk.books).map((b) => ({ ...b, id: b.stock })) as BookLine[]} columns={COLUMNS_BOOK} idKey="id" density="compact" />
      )}
    </VStack>
  )
}

type ClusterLine = Record<string, unknown> & CorrelatedCluster & { readonly id: string }

const COLUMNS_CLUSTER: TradersColumn<ClusterLine>[] = [
  { key: 'members', header: 'Members', renderCell: (l) => <Fig text={l.stocks.join(', ')} bold /> },
  { key: 'rho', header: 'Mean ρ', align: 'end', renderCell: (l) => <Fig text={fix(l.meanCorr, 2)} /> },
  { key: 'together', header: 'Loss together', align: 'end', renderCell: (l) => <Fig text={rs(l.togetherLoss)} tint={l.togetherLoss} /> },
  { key: 'alone', header: 'Loss standalone', align: 'end', renderCell: (l) => <Fig text={rs(l.standaloneLoss)} tint={l.standaloneLoss} /> },
]

export function ClustersSection(p: { risk: RiskView }): ReactElement {
  return (
    <VStack gap={1}>
      <Heading level={4}>Correlated clusters</Heading>
      {p.risk.clusters.length === 0 ? <Text color="secondary">No held stocks move together.</Text> : (
        <TradersTable aria-label="Clusters" data={p.risk.clusters.map((c) => ({ ...c, id: c.stocks.join('+') })) as ClusterLine[]} columns={COLUMNS_CLUSTER} idKey="id" density="compact" />
      )}
    </VStack>
  )
}

// ------------------------------------------------------------------ the page

/** The replay's fixed sentences and each row warning once; the views' own warnings go to the bell. */
export function riskNotes(risk: RiskView | null, events: EventRiskView | null): string[] {
  const out: string[] = []
  const add = (xs: readonly string[]): void => { for (const x of xs) if (!out.includes(x)) out.push(x) }
  if (risk !== null) {
    add(risk.replay.notes)
    for (const b of risk.books) add(b.warnings.map((w) => `${b.stock}: ${w}`))
  }
  if (events !== null) for (const r of events.rows) add(r.warnings.map((w) => `${r.stock}: ${w}`))
  return out
}

export function RiskPage(): ReactElement {
  const visible = useDocumentVisible()
  const risk = useRiskView(visible)
  const events = useEventsView(visible)
  // A server not yet restarted onto the routes answers something that is not a view: show what is there.
  const r = risk.data !== null && Array.isArray((risk.data as { books?: unknown }).books) ? risk.data : null
  const e = events.data !== null && Array.isArray((events.data as { rows?: unknown }).rows) ? events.data : null
  const errors: [string, string | null, unknown][] = [['risk', risk.error, r], ['events', events.error, e]]
  return (
    <VStack gap={3}>
      {errors.map(([name, err, data]) => err === null ? null : (
        data === null
          ? <BellAlert key={name} status="error" inline text={`Could not load ${name}: ${err}`} />
          : <BellAlert key={name} text={`${name} refresh failed: ${err}`} />
      ))}
      {r === null && e === null && risk.error === null && events.error === null ? <Text color="secondary">Loading risk…</Text> : null}
      {r === null ? null : (
        <>
          <Text color="secondary" size="sm">{r.trader ?? 'All traders'}</Text>
          <Totals risk={r} />
          <StressGrid risk={r} />
        </>
      )}
      {e === null ? null : <ResultsTable events={e} />}
      {r === null ? null : (
        <>
          <ReplaySection risk={r} />
          <ConcentrationSection risk={r} />
          <ClustersSection risk={r} />
        </>
      )}
      <Caveats items={[...(r?.warnings ?? []), ...(e?.warnings ?? [])]} kind="warning" />
      <Caveats items={riskNotes(r, e)} kind="note" />
    </VStack>
  )
}
