/**
 * Volatility per held stock, end of day (`GET /vol`, docs/superpowers/specs/2026-10-23-traders-vol-addendum.md): the
 * Vol page, and the Vol columns the Portfolio borrows. Every figure is the server's; this file formats them and marks
 * where premium looks rich (IV high in its year and above realized) or cheap (low and below).
 */

import type { ReactElement } from 'react'
import { VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { sign, signed } from '../format.ts'
import type { VolRow, VolView } from '../../../traders/src/analytics/context-wire.ts'
import { tapi } from './api.ts'
import { BellAlert } from './bell.tsx'
import { Caveats } from './caveats.tsx'
import { stepFill } from './colour-scale.ts'
import { useDocumentVisible, usePoll, useSession, type Polled } from './hooks.ts'
import { TradersTable, type TradersColumn } from './table.tsx'
import { expiryDayLabel } from './wire.ts'

/** End-of-day figures change once an evening. */
export const VOL_POLL_MS = 5 * 60_000
export const RICH_IVR = 50
export const CHEAP_IVR = 20

export function useVolView(enabled: boolean): Polled<VolView> {
  const asTrader = useSession()?.asTrader ?? null
  return usePoll(() => tapi.vol(), VOL_POLL_MS, [asTrader], enabled)
}

/** The view's rows; none for an answer that is not a view (a server not yet restarted onto the route). */
export function volRows(v: VolView | null): readonly VolRow[] {
  return v !== null && Array.isArray((v as { rows?: unknown }).rows) ? v.rows : []
}

const DASH = '—'
/** Decimal → percent, one place: 0.2841 → "28.4". */
export const pct1 = (x: number | null): string => (x === null ? DASH : (x * 100).toFixed(1))
/** Decimal → signed vol points, one place: 0.052 → "+5.2". */
export const pts1 = (x: number | null): string => (x === null ? DASH : signed(x * 100, 1))
export const whole = (x: number | null): string => (x === null ? DASH : x.toFixed(0))
const ratio = (x: number | null): string => (x === null ? DASH : x.toFixed(2))
const day = (d: string | null): string => (d === null ? DASH : expiryDayLabel(d))
const SOURCE = { nse: 'NSE', bhavcopy: 'bhavcopy' } as const

export type VolCue = 'rich' | 'cheap' | 'event' | null

/** Rich: IV rank ≥ 50 and IV above HV20. Cheap: IV rank ≤ 20 and IV below HV20. Event: the near expiry carries a results date, so the rank is not comparable and replaces both. */
export function volCue(r: Pick<VolRow, 'ivRank' | 'vrp'> & { readonly results?: VolRow['results'] }): VolCue {
  if (r.results?.inNear === true) return 'event'
  if (r.ivRank === null || r.vrp === null) return null
  if (r.ivRank >= RICH_IVR && r.vrp > 0) return 'rich'
  if (r.ivRank <= CHEAP_IVR && r.vrp < 0) return 'cheap'
  return null
}

const EVENT_FILL = 'color-mix(in srgb, var(--color-warning, #c58a00) 28%, transparent)'
const CUE_FILL: Record<'rich' | 'cheap' | 'event', string | undefined> = { rich: stepFill(2), cheap: stepFill(-2), event: EVENT_FILL }
/** The event cue's tooltip. */
export const eventTip = (r: Pick<VolRow, 'results'>): string | undefined =>
  r.results?.inNear === true ? `IV includes results on ${expiryDayLabel(r.results.date).slice(0, 6)}: rank not comparable` : undefined
export const CUE_LEGEND = `Rich: IV rank ≥ ${RICH_IVR} and IV above HV20. Cheap: IV rank ≤ ${CHEAP_IVR} and IV below HV20. Event: results before the near expiry. IV and HV in %, VRP in vol points, end of day.`

/** Everything in a row as short lines: the Portfolio's tooltip. */
export function volDetail(r: VolRow): string[] {
  const rv = r.realizedVrp
  return [
    `IV ${pct1(r.iv)}${r.ivSource === null ? '' : ` (${SOURCE[r.ivSource]})`} · rank ${whole(r.ivRank)} · pctile ${whole(r.ivPercentile)} · ${r.ivDays} days`,
    `HV10 ${pct1(r.hv10)} · HV20 ${pct1(r.hv20)} · NSE HV ${pct1(r.nseHv)}`,
    `VRP ${pts1(r.vrp)} · IV/HV20 ${ratio(r.vrpRatio)} · VRP pctile ${whole(r.vrpPercentile)}`,
    rv === null ? 'Realized VRP: —' : `Realized VRP ${pts1(rv.mean)} mean, ${pts1(rv.median)} median, paid ${whole(rv.positivePct)}% of ${rv.days} days`,
    `${day(r.nearExpiry)} ${pct1(r.nearIv)} → ${day(r.nextExpiry)} ${pct1(r.nextIv)} · 25Δ skew ${pts1(r.skew25)}`,
    `As of ${day(r.asOf)}`,
    ...r.warnings,
  ]
}

function Fig(p: { text: string; tint?: number | null; fill?: string | undefined; title?: string | undefined }): ReactElement {
  const tone = p.tint === undefined || p.tint === null ? undefined : sign(p.tint)
  return (
    <Text size="sm" color={p.text === DASH ? 'secondary' : 'primary'} {...(p.title === undefined ? {} : { title: p.title })} style={{ whiteSpace: 'nowrap', ...tone, ...(p.fill === undefined ? {} : { background: p.fill, padding: '0 4px', borderRadius: 3 }) }}>
      {p.text}
    </Text>
  )
}

const cueFill = (r: VolRow): string | undefined => { const c = volCue(r); return c === null ? undefined : CUE_FILL[c] }

/** The Portfolio's four Vol columns (IV, IVR, IVP, VRP); the IV cell's tooltip carries the rest. Blank on a row with no `vol`. */
export function volColumns<R extends Record<string, unknown> & { readonly vol: VolRow | null }>(): TradersColumn<R>[] {
  const cell = (render: (v: VolRow) => ReactElement) => (r: R): ReactElement | null => (r.vol === null ? null : render(r.vol))
  return [
    {
      key: 'iv', header: 'IV', align: 'end', sortValue: (r) => r.vol?.iv ?? null,
      renderCell: cell((v) => (
        <Tooltip content={<VStack gap={0}>{volDetail(v).map((line) => <Text key={line} size="sm">{line}</Text>)}</VStack>}>
          <Fig text={pct1(v.iv)} />
        </Tooltip>
      )),
    },
    { key: 'ivRank', header: 'IVR', align: 'end', sortValue: (r) => r.vol?.ivRank ?? null, renderCell: cell((v) => <Fig text={whole(v.ivRank)} fill={cueFill(v)} />) },
    { key: 'ivPercentile', header: 'IVP', align: 'end', sortValue: (r) => r.vol?.ivPercentile ?? null, renderCell: cell((v) => <Fig text={whole(v.ivPercentile)} />) },
    { key: 'vrp', header: 'VRP', align: 'end', sortValue: (r) => r.vol?.vrp ?? null, renderCell: cell((v) => <Fig text={pts1(v.vrp)} tint={v.vrp} />) },
  ]
}

// ------------------------------------------------------------------ the page

type Line = Record<string, unknown> & VolRow & { readonly id: string; readonly rvMean: number | null; readonly rvPaid: number | null }

const num = (k: keyof Line) => (l: Line): number | null => { const v = l[k]; return typeof v === 'number' ? v : null }

const PAGE_COLUMNS: TradersColumn<Line>[] = [
  {
    key: 'stock', header: 'Stock', sortValue: (l) => l.stock,
    renderCell: (l) => <Text size="sm" weight="bold">{l.stock}</Text>,
  },
  { key: 'cue', header: 'Premium', sortValue: (l) => volCue(l), renderCell: (l) => { const c = volCue(l); return c === null ? null : <Fig text={c} fill={CUE_FILL[c]} title={c === 'event' ? eventTip(l) : undefined} /> } },
  {
    key: 'iv', header: 'IV', align: 'end', sortValue: num('iv'),
    renderCell: (l) => (
      <VStack gap={0} align="end">
        <Fig text={pct1(l.iv)} />
        {l.ivSource === null ? null : <Text size="sm" color="secondary">{SOURCE[l.ivSource]}</Text>}
      </VStack>
    ),
  },
  { key: 'ivRank', header: 'IVR', align: 'end', sortValue: num('ivRank'), renderCell: (l) => <Fig text={whole(l.ivRank)} fill={cueFill(l)} /> },
  { key: 'ivPercentile', header: 'IVP', align: 'end', sortValue: num('ivPercentile'), renderCell: (l) => <Fig text={whole(l.ivPercentile)} /> },
  { key: 'hv20', header: 'HV20', align: 'end', sortValue: num('hv20'), renderCell: (l) => <Fig text={pct1(l.hv20)} /> },
  { key: 'nseHv', header: 'NSE HV', align: 'end', sortValue: num('nseHv'), renderCell: (l) => <Fig text={pct1(l.nseHv)} /> },
  { key: 'vrp', header: 'VRP', align: 'end', sortValue: num('vrp'), renderCell: (l) => <Fig text={pts1(l.vrp)} tint={l.vrp} /> },
  { key: 'vrpRatio', header: 'IV/HV', align: 'end', sortValue: num('vrpRatio'), renderCell: (l) => <Fig text={ratio(l.vrpRatio)} /> },
  { key: 'vrpPercentile', header: 'VRP pctile', align: 'end', sortValue: num('vrpPercentile'), renderCell: (l) => <Fig text={whole(l.vrpPercentile)} /> },
  { key: 'rvMean', header: 'Realized VRP', align: 'end', sortValue: num('rvMean'), renderCell: (l) => <Fig text={pts1(l.rvMean)} tint={l.rvMean} /> },
  { key: 'rvPaid', header: 'Paid %', align: 'end', sortValue: num('rvPaid'), renderCell: (l) => <Fig text={whole(l.rvPaid)} /> },
  {
    key: 'nearIv', header: 'Near → next', align: 'end', sortValue: num('nearIv'),
    renderCell: (l) => (
      <VStack gap={0} align="end">
        <Fig text={`${pct1(l.nearIv)} → ${pct1(l.nextIv)}`} />
        {l.nearExpiry === null ? null : <Text size="sm" color="secondary">{`${day(l.nearExpiry)} / ${day(l.nextExpiry)}`}</Text>}
      </VStack>
    ),
  },
  { key: 'skew25', header: '25Δ skew', align: 'end', sortValue: num('skew25'), renderCell: (l) => <Fig text={pts1(l.skew25)} /> },
  { key: 'ivDays', header: 'Days', align: 'end', sortValue: num('ivDays'), renderCell: (l) => <Fig text={String(l.ivDays)} /> },
]

/** Each row warning once, with the stocks it applies to: `<warning>: TCS, INFY`. */
export function rowNotes(rows: readonly VolRow[]): string[] {
  const by = new Map<string, string[]>()
  for (const r of rows) for (const w of r.warnings) by.set(w, [...(by.get(w) ?? []), r.stock])
  return [...by].map(([w, stocks]) => `${w}: ${stocks.join(', ')}`)
}

/** Highest IV rank first; no rank last, by stock. */
export function byRank(rows: readonly VolRow[]): VolRow[] {
  return [...rows].sort((a, b) => (b.ivRank ?? -1) - (a.ivRank ?? -1) || a.stock.localeCompare(b.stock))
}

export function VolTable(props: { rows: readonly VolRow[] }): ReactElement {
  const data: Line[] = byRank(props.rows).map((r) => ({ ...r, id: r.stock, rvMean: r.realizedVrp?.mean ?? null, rvPaid: r.realizedVrp?.positivePct ?? null }))
  return <TradersTable aria-label="Volatility" data={data} columns={PAGE_COLUMNS} idKey="id" density="compact" />
}

export function VolPage(): ReactElement {
  const visible = useDocumentVisible()
  const vol = useVolView(visible)
  const v = vol.data
  const rows = volRows(v)
  const asOf = rows.reduce<string | null>((m, r) => (r.asOf !== null && (m === null || r.asOf > m) ? r.asOf : m), null)
  return (
    <VStack gap={3}>
      {v === null ? null : (
        <Text color="secondary" size="sm">{`${v.trader ?? 'All held stocks'} · end of day${asOf === null ? '' : `, ${day(asOf)}`}`}</Text>
      )}
      {vol.error === null ? null : (
        v === null
          ? <BellAlert status="error" inline text={`Could not load volatility: ${vol.error}`} />
          : <BellAlert text={`Refresh failed: ${vol.error}`} />
      )}
      {v === null ? (vol.error === null ? <Text color="secondary">Loading volatility…</Text> : null) : (
        <>
          <Caveats items={Array.isArray(v.warnings) ? v.warnings : []} kind="warning" />
          {rows.length === 0 ? <Text color="secondary">No open books.</Text> : <VolTable rows={rows} />}
          <Text size="sm" color="secondary">{CUE_LEGEND}</Text>
          <Caveats items={rowNotes(byRank(rows))} kind="note" />
        </>
      )}
    </VStack>
  )
}
