/**
 * The book's summary strip, at the top of every sub-tab: the figures a trader acts on, in one line — P&L (the series
 * net: booked on the closed contracts + the open legs at LTP − all charges, since the first trade), Today (the MTM
 * block's total: carried legs from yesterday's close plus today's trades, less the charges on today's fills — a part
 * of P&L), net delta (in shares), margin, Δ0 and the breakevens. Two P&L names, the same in the P&L block (spec
 * 2026-10-23), and both taken from the fresh live frame when it carries them, so the two never disagree on one
 * screen. Otherwise P&L comes with the book (an older server sends none: then it is not shown) and Today from the
 * trader's portfolio (one answer for every book, polled like the Portfolio page); until it lands, or for a book it does
 * not list, delta comes from the book itself. Today is the block's total or "—", with the reason in its tooltip when
 * there is one ("market opens 09:15" before the open, "market closed today"): never the legs' Σ(LTP − net) × qty.
 * P&L's parts, Today's and the margin's source line sit behind their ⓘ.
 */

import { Text } from '@astryxdesign/core/Text'
import { inr, money, sign, signed } from '../format.ts'
import type { BookView } from '../../../traders/src/types.ts'
import { tapi } from './api.ts'
import { InfoTip } from './fold.tsx'
import { useDocumentVisible, usePoll, useSession } from './hooks.ts'
import { analysisOpen, readNeutral, useNeutral } from './neutral-store.ts'
import { frameToday, liveFrameOf, useLiveBook } from './live.tsx'
import { RATES_ESTIMATE, SHARES_LINE, TODAY_ABOUT, pnlOf, seriesLines, seriesOf } from './series-lines.ts'
import { SERVER_UPDATE_PENDING } from './wire.ts'

/** As the Portfolio page: a minute, and nothing while the tab is hidden. */
const STRIP_POLL_MS = 60_000
/** A Δ0 the Analysis view published within this long serves the strip. */
const NEUTRAL_FRESH_MS = 90_000
/** The analysis as the book stands: no ticks, overrides or shifts — only its Δ0 is read here. */
const PLAIN_QUERY = { expiry: null, exclude: [], illiquid: [], ivOverrides: {}, callVol: 0, putVol: 0, future: null } as const

/** A label and its value side by side: the strip is one slim line on the book's title line. */
/** Rupees in lakh, short: 12,21,189 → "12.2L"; under a lakh two decimals, 85,650 → "0.86L". */
export function lakhs(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const l = n / 1e5
  return `${Math.abs(l) < 1 ? l.toFixed(2) : inr(l, 1)}L`
}

function Figure(props: { label: string; value: string; n?: number | null; info?: React.ReactNode; title?: string | undefined }): React.ReactElement {
  const style = props.n === undefined || props.n === null ? undefined : sign(props.n)
  return (
    <span className="traders-pair">
      <Text color="secondary" size="sm">{props.label}</Text>
      {props.info ?? null}
      <Text size="sm" weight="bold" {...(style === undefined ? {} : { style })} {...(props.title === undefined ? {} : { title: props.title })}>{props.value}</Text>
    </span>
  )
}

export function BookStrip(props: { stock: string; view: BookView }): React.ReactElement {
  const { stock, view } = props
  const visible = useDocumentVisible()
  const asTrader = useSession()?.asTrader ?? null
  const portfolio = usePoll(() => tapi.portfolio(), STRIP_POLL_MS, [asTrader], visible)
  const rows = portfolio.data?.rows
  const row = Array.isArray(rows) ? rows.find((r) => r.stock === stock) ?? null : null
  const loading = portfolio.data === null && portfolio.error === null

  // Δ0: from the Analysis view when it has published one lately, else this strip's own minute poll of the analysis.
  const shared = useNeutral(stock)
  // the Analysis view on screen is the source even when its updates are paused (its overrides are what is shown)
  const sharedFresh = shared !== null && (analysisOpen(stock) || readNeutral(stock, Date.now(), NEUTRAL_FRESH_MS) !== null)
  const own = usePoll(() => tapi.analysis(stock, PLAIN_QUERY), STRIP_POLL_MS, [stock, asTrader], visible && !sharedFresh)
  const ownA = own.data as { toNeutralize?: { price?: unknown; pct?: unknown } | null; breakevens?: { low?: unknown; high?: unknown }; bookTimeValue?: unknown } | null
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const price = sharedFresh ? shared.price : num(ownA?.toNeutralize?.price)
  const pct = sharedFresh ? shared.pct : num(ownA?.toNeutralize?.pct)
  const bepLow = sharedFresh ? shared.bepLow : num(ownA?.breakevens?.low)
  const bepHigh = sharedFresh ? shared.bepHigh : num(ownA?.breakevens?.high)
  const timeValue = sharedFresh ? shared.timeValue : num(ownA?.bookTimeValue)

  const t = view.totals
  // Net Δ is the Greeks table's T row while the Analysis view is on screen, so the two never disagree
  const netDelta = sharedFresh && shared.delta !== null ? shared.delta : row?.delta ?? t.delta
  // the live stream's figures win while it is live: the P&L block reads the same frame
  const fresh = liveFrameOf(useLiveBook(stock))
  // A day figure is trusted only from a server that sends the reason keys (`mtmReason` on a frame, `mtmDayReason` on a
  // row; null once the day has begun): the old server's mtmDay, mtmToday and mtmTotal carry the open cycle's charges and
  // no pre-open null under the new names. Until it is restarted the strip says "—", "server update pending".
  const speaks = frameToday(fresh)
  const newRow = row !== null && row.mtmDayReason !== undefined ? row : null
  const today = speaks !== null ? speaks.total : newRow?.mtmDay ?? null
  const todayWhy = speaks !== null ? speaks.why : newRow !== null ? newRow.mtmDayReason : row !== null ? SERVER_UPDATE_PENDING : null
  const series = seriesOf(view)
  const pnl = series === null ? null : pnlOf(series, fresh)
  const shares = view.legs.some((l) => l.instrument === 'share') ? [SHARES_LINE] : []
  const lines = (ls: readonly string[]): React.ReactNode => ls.map((l, i) => <span key={`${i}:${l}`} style={{ display: 'block' }}>{l}</span>)
  return (
    <span role="group" aria-label="Book summary" className="traders-strip-inline">
      {series === null || pnl === null ? null : (
        <Figure
          label="P&L" value={money(pnl.net)} n={pnl.net}
          title={series.total.ratesConfirmed ? undefined : RATES_ESTIMATE}
          info={<InfoTip label="P&L">{lines([...seriesLines(series, pnl), ...shares])}</InfoTip>}
        />
      )}
      <Figure
        label="Today" value={today === null ? (row === null && loading ? '…' : '—') : money(today)} n={today}
        title={today === null && todayWhy !== null ? todayWhy : undefined}
        info={<InfoTip label="Today">{lines([TODAY_ABOUT, ...shares])}</InfoTip>}
      />
      <Figure label="Net Δ" value={signed(Math.round(netDelta))} n={netDelta}
        info={<InfoTip label="Net Δ">the book&apos;s net delta in shares: ₹ it gains or loses per ₹1 move in the stock, near spot</InfoTip>} />
      <Figure
        label="Δ0"
        value={price === null ? '—' : `${inr(price, 1)}${pct === null ? '' : ` (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)} %)`}`}
        info={<InfoTip label="Δ0">the price where the book&apos;s delta is zero (spot − Δ/Γ, the desk&apos;s Δ0)</InfoTip>}
      />
      <Figure
        label="BEP"
        value={bepLow === null && bepHigh === null ? '—' : `${bepLow === null ? '—' : inr(bepLow, 1)} – ${bepHigh === null ? '—' : inr(bepHigh, 1)}`}
      />
      <Figure label="Time value" value={timeValue === null ? '—' : inr(Math.round(timeValue))} />
      <Figure
        label="Margin"
        value={row === null ? (loading ? '…' : '—') : lakhs(row.margin)}
        title={row === null ? undefined : `₹${inr(row.margin)}`}
        info={row?.marginLabel === null || row?.marginLabel === undefined ? undefined : <InfoTip label="the margin">{row.marginLabel}</InfoTip>}
      />
    </span>
  )
}
