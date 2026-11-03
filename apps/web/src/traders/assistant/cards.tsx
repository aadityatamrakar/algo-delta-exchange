/**
 * The assistant's cards (spec 2026-10-23 §7, §8): plans, an evaluation, a neutralize and a market context, as the
 * server sends them. Every figure here is the engines' (spec R2) — this file only lays them out: rows are metrics,
 * columns now → plan → change, and a change is marked better (✓, green) or worse (✗, red) FOR THAT METRIC
 * (metrics.ts) — the mark and a screen-reader word carry it, not the colour alone.
 *
 * Tolerant of what it is sent: a missing array is empty, a missing figure is "—", and a card that still fails to
 * render is one line of text (CardBoundary), never a blank page.
 *
 * Presentation only. A plan's one control is "Show on payoff", which loads its legs as hypothetical rows into the
 * book's Scenario tab (`openWhatIf`) and changes nothing in the book (spec R1).
 */

import { useId, useState, type ReactElement } from 'react'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import type { AssistantCard, CardMetrics, PlanCard } from '../../../../traders/src/agent/wire.ts'
import type { MarketContext } from '../../../../traders/src/analytics/context-wire.ts'
import { inr } from '../../format.ts'
import { openWhatIf } from '../what-if.ts'
import { expiryDayLabel, istHm } from '../wire.ts'
import { LevelLadder, referenceOf } from './ladder.tsx'
import { metricLines, type MetricLine } from './metrics.ts'
import { CardBoundary, arr, numOr, str } from './safe.tsx'
import { TabStrip, tabId } from './tabs.tsx'
import './assistant.css'

/** The plan flags a trader reads; `baseline` is the do-nothing column itself and says nothing more. */
export const PLAN_FLAG_TEXT: Readonly<Record<string, { readonly label: string; readonly about: string }>> = {
  'no-feasible-plan': { label: 'No feasible plan', about: 'Nothing met the goal under the floor guard and the limits.' },
  'degrades-floor': { label: 'Worse worst case', about: 'Its max loss or shock is deeper than now — only within a relaxation the trader asked for.' },
  'margin-up': { label: 'Margin up', about: 'Needs more margin than the book holds now.' },
  'indicative-price': { label: 'Indicative price', about: 'Some fill is priced at the mark: no live two-sided quote.' },
  'illiquid-excluded': { label: 'Illiquid strikes left out', about: 'Strikes without a live two-sided quote, or with a wide spread, were not considered.' },
  'view-based': { label: 'View-based', about: 'Ranked on expected value under the stated view, not on today\'s prices alone.' },
}
const SILENT_FLAGS = new Set(['baseline'])

function Flags(props: { readonly flags: readonly unknown[] }): ReactElement | null {
  const shown = props.flags.filter((f): f is string => typeof f === 'string' && !SILENT_FLAGS.has(f))
  if (shown.length === 0) return null
  return (
    <span className="traders-ai-flags">
      {shown.map((f) => {
        const t = PLAN_FLAG_TEXT[f]
        return t === undefined
          ? <Badge key={f} variant="neutral" label={f} />
          : <Tooltip key={f} content={t.about}><Badge variant={f === 'view-based' ? 'info' : 'warning'} label={t.label} /></Tooltip>
      })}
    </span>
  )
}

/** "Indicative": the market is shut or the feed is not ticking, so every price below is the last one seen. */
function Indicative(props: { readonly on: boolean }): ReactElement | null {
  if (!props.on) return null
  return <div className="traders-ai-indicative" role="note">Indicative — market closed or the feed is not ticking; prices are the last seen</div>
}

/** ✓ better / ✗ worse beside a change, and the word for a screen reader: the tone never rests on colour alone. */
export function ToneMark(props: { readonly tone: MetricLine['tone'] }): ReactElement | null {
  if (props.tone === null) return null
  const better = props.tone === 'better'
  return (
    <>
      <span className="traders-ai-tone-mark" aria-hidden="true">{better ? '✓' : '✗'}</span>
      <span className="traders-ai-sr">{better ? ' (better)' : ' (worse)'}</span>
    </>
  )
}

/** Now → plan → change, one metric a row; the change marked by whether it is better for that metric. */
export function MetricTable(props: {
  readonly now: Partial<CardMetrics> | null | undefined; readonly after: Partial<CardMetrics> | null | undefined
  readonly change: Partial<CardMetrics> | null | undefined; readonly label: string
}): ReactElement {
  const rows: MetricLine[] = metricLines(props.now, props.after, props.change)
  return (
    <table className="traders-ai-metrics" aria-label={props.label}>
      <thead>
        <tr><th scope="col">Metric</th><th scope="col">Now</th><th scope="col">Plan</th><th scope="col">Change</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} data-metric={r.key}>
            <th scope="row" title={r.about}>{r.label}</th>
            <td>{r.now}</td>
            <td>{r.plan}</td>
            <td data-tone={r.tone ?? 'flat'} {...(r.tone === null ? {} : { title: r.tone === 'better' ? 'Better for this metric' : 'Worse for this metric' })}>
              {r.change}<ToneMark tone={r.tone} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** One plan: its trades, the figures against now, its flags and binding limits, and Show on payoff. */
function PlanBody(props: { readonly stock: string; readonly plan: PlanCard; readonly baseline: CardMetrics | null | undefined; readonly panel?: string; readonly tab?: string }): ReactElement {
  const { plan } = props
  const id = str(plan.planId) || 'plan'
  const lines = arr(plan.lines).filter((l): l is string => typeof l === 'string')
  const binding = arr(plan.binding).filter((l): l is string => typeof l === 'string')
  const whatIf = arr(plan.whatIf)
  return (
    <div className="traders-ai-plan" {...(props.panel === undefined || props.tab === undefined ? { role: 'group', 'aria-label': `Plan ${id}` }
      : { role: 'tabpanel', id: props.panel, 'aria-labelledby': props.tab })}>
      {lines.length === 0 ? null : <ul className="traders-ai-lines">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      <MetricTable now={props.baseline} after={plan.after} change={plan.change} label={`${id}: now, plan and change`} />
      <Flags flags={arr(plan.flags)} />
      {binding.length === 0 ? null : <div className="traders-ai-muted">{`Binding: ${binding.join(' · ')}`}</div>}
      {whatIf.length === 0 || props.stock === '' ? null : (
        <div className="traders-ai-actions">
          <Button size="sm" variant="secondary" label="Show on payoff" aria-label={`Show on payoff — ${id}`}
            tooltip="Loads these legs as hypothetical rows in the book's Scenario tab; the book is not changed"
            onClick={() => openWhatIf(props.stock, whatIf, `AI: ${id}`)} />
        </div>
      )}
    </div>
  )
}

/** A card's plans: P1 P2 … as small tabs, one plan's body at a time (a drawer has no room for them side by side). */
function PlanPicker(props: { readonly stock: string; readonly plans: readonly PlanCard[]; readonly baseline: CardMetrics | null | undefined; readonly empty: string }): ReactElement {
  const base = useId()
  const plans = props.plans.filter((p) => typeof p === 'object' && p !== null)
  const [at, setAt] = useState(0)
  if (plans.length === 0) return <div className="traders-ai-muted">{props.empty}</div>
  const index = Math.min(at, plans.length - 1)
  const plan = plans[index] as PlanCard
  const ids = plans.map((p, i) => str(p.planId) || `P${i + 1}`)
  if (plans.length === 1) return <PlanBody stock={props.stock} plan={plan} baseline={props.baseline} />
  const panel = `${base}-plan`
  return (
    <>
      <TabStrip label="Plans" base={base} tabs={ids.map((id, i) => ({ id: String(i), label: id }))} value={String(index)}
        onChange={(v) => setAt(Number(v))} className="traders-ai-plan-tabs" tabClassName="traders-ai-plan-tab" sharedPanel={panel} />
      <PlanBody key={index} stock={props.stock} plan={plan} baseline={props.baseline} panel={panel} tab={tabId(base, String(index))} />
    </>
  )
}

function Head(props: { readonly title: string; readonly stock: string }): ReactElement {
  return (
    <div className="traders-ai-card-head">
      <span className="traders-ai-card-title">{props.title}</span>
      {props.stock === '' ? null : <span className="traders-ai-chip">{props.stock}</span>}
    </div>
  )
}

type CardOf<K extends AssistantCard['kind']> = Extract<AssistantCard, { kind: K }>

function PlansCardView(props: { readonly card: CardOf<'plans'> }): ReactElement {
  const c = props.card
  const stock = str(c.stock)
  const title = str(c.title) || 'Plans'
  const rejected = arr(c.rejected).filter((r) => typeof r === 'object' && r !== null && (numOr(r.count) ?? 0) > 0)
  return (
    <section className="traders-ai-card" aria-label={title} data-kind="plans">
      <Head title={title} stock={stock} />
      <Indicative on={c.indicative === true} />
      {str(c.objective) === '' ? null : <div className="traders-ai-muted">{str(c.objective)}</div>}
      {str(c.view) === '' ? null : <div className="traders-ai-muted">{`View: ${str(c.view)}`}</div>}
      <PlanPicker stock={stock} plans={arr(c.plans)} baseline={c.baseline} empty="No plan meets the goal without making the worst case worse than now" />
      {rejected.length === 0 ? null : (
        <div className="traders-ai-muted">{`Left out: ${rejected.map((r) => `${r.count} ${str(r.reason)}`).join(' · ')}`}</div>
      )}
    </section>
  )
}

function EvaluationCardView(props: { readonly card: CardOf<'evaluation'> }): ReactElement {
  const c = props.card
  const stock = str(c.stock)
  const title = str(c.title) || 'Evaluation'
  return (
    <section className="traders-ai-card" aria-label={title} data-kind="evaluation">
      <Head title={title} stock={stock} />
      <Indicative on={c.indicative === true} />
      <div className="traders-ai-muted">Your adjustment, evaluated as stated — not a searched plan</div>
      {typeof c.plan === 'object' && c.plan !== null
        ? <PlanBody stock={stock} plan={c.plan} baseline={c.baseline} />
        : <div className="traders-ai-muted">No figures came with this evaluation</div>}
    </section>
  )
}

const signed = (n: number | null, digits: number, unit = ''): string =>
  (n === null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${inr(Math.abs(n), digits)}${unit}`)

function NeutralizeCardView(props: { readonly card: CardOf<'neutralize'> }): ReactElement {
  const c = props.card
  const stock = str(c.stock)
  const f = typeof c.futures === 'object' && c.futures !== null ? c.futures : null
  const lots = numOr(f?.lots)
  const delta0 = numOr(c.delta0), spot = numOr(c.spot)
  const gap = delta0 !== null && spot !== null && spot > 0 ? ((delta0 - spot) / spot) * 100 : null
  const side = f?.side === 'BUY' || f?.side === 'SELL' ? f.side : null
  return (
    <section className="traders-ai-card" aria-label={`Neutralize delta — ${stock}`} data-kind="neutralize">
      <Head title="Neutralize delta" stock={stock} />
      <Indicative on={c.indicative === true} />
      <div className="traders-ai-figs">
        <span><span className="traders-ai-k">Δ now</span> {signed(numOr(c.deltaShares), 0, ' sh')}</span>
        <span><span className="traders-ai-k">lots</span> {signed(numOr(c.deltaLots), 2)}</span>
        <span><span className="traders-ai-k">Δ0</span> {delta0 === null ? '—' : inr(delta0, 2)}</span>
        <span><span className="traders-ai-k">spot</span> {spot === null ? '—' : inr(spot, 2)}</span>
        {gap === null ? null : <span><span className="traders-ai-k">Δ0 vs spot</span> {`${gap >= 0 ? '+' : '−'}${Math.abs(gap).toFixed(2)} %`}</span>}
      </div>
      <div className="traders-ai-route" role="group" aria-label="Futures route">
        <span className="traders-ai-k">Futures route</span>
        {f === null || lots === null || side === null || lots === 0
          ? <span>{f === null ? 'none — no future to hedge with' : lots === 0 ? 'already flat' : '—'}</span>
          : (
            <span className="traders-ai-route-line">
              <span data-side={side}>{side}</span>
              {` ${lots} ${lots === 1 ? 'lot' : 'lots'} ${expiryDayLabel(str(f.expiry))} FUT @ ${numOr(f.price) === null ? 'market' : inr(f.price as number, 2)}`}
              <span className="traders-ai-muted"> — exact, adds no Γ or vega</span>
            </span>
          )}
      </div>
      <div className="traders-ai-k">Option routes</div>
      <PlanPicker stock={stock} plans={arr(c.plans)} baseline={c.baseline} empty="No option plan flattens delta without making the worst case worse" />
    </section>
  )
}

const pct = (d: unknown, digits = 1): string => { const n = numOr(d); return n === null ? '—' : `${(n * 100).toFixed(digits)} %` }
const pctSigned = (d: unknown, digits = 1): string => { const n = numOr(d); return n === null ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(digits)} %` }
const px = (d: unknown): string => { const n = numOr(d); return n === null ? '—' : inr(n, 2) }
const whole = (d: unknown): string => { const n = numOr(d); return n === null ? '—' : inr(n, 0) }
const TREND_TEXT: Readonly<Record<string, string>> = { up: 'Up', down: 'Down', range: 'Range', unknown: 'Unknown' }

/** The day's change in %, beside whichever price the context's figures are of. */
function DayChange(props: { readonly pct: number | null }): ReactElement | null {
  const n = props.pct
  if (n === null) return null
  return <span data-tone={n > 0 ? 'better' : n < 0 ? 'worse' : 'flat'}>{` ${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)} %`}</span>
}

/** The market around a stock: price, trend, vol, expected move, OI, and the ladder of levels around the reference. */
export function ContextView(props: { readonly context: MarketContext }): ReactElement {
  const x = props.context
  const trend: Partial<MarketContext['trend']> = typeof x.trend === 'object' && x.trend !== null ? x.trend : {}
  const vol: Partial<MarketContext['vol']> = typeof x.vol === 'object' && x.vol !== null ? x.vol : {}
  const em: Partial<MarketContext['expectedMove']> = typeof x.expectedMove === 'object' && x.expectedMove !== null ? x.expectedMove : {}
  const oi = typeof x.oi === 'object' && x.oi !== null ? x.oi : null
  const indicative = x.closed === true || x.stale === true || x.feedAlive === false
  const ref = referenceOf(x)
  const change = numOr(x.changePct)
  const ivMinusHv = numOr(vol.ivMinusHv20)
  const ivRank = numOr(vol.ivRank), ivPctl = numOr(vol.ivPercentile)
  const ivDays = numOr(vol.ivDays) ?? 0
  const one = numOr(em.oneSigma), two = numOr(em.twoSigma), days = numOr(em.days)
  const warnings = arr(x.warnings).filter((w): w is string => typeof w === 'string')
  const asOf = numOr(x.asOf)
  return (
    <div className="traders-ai-context">
      <Indicative on={indicative} />
      <div className="traders-ai-figs" role="group" aria-label="Price">
        <span data-reference={ref.future ? undefined : 'true'}><span className="traders-ai-k">Spot</span> {px(x.spot)}{ref.future ? null : <DayChange pct={change} />}</span>
        <span data-reference={ref.future ? 'true' : undefined}><span className="traders-ai-k">Fut</span> {px(x.future)}{ref.future ? <DayChange pct={change} /> : null}</span>
        {asOf === null ? null : <span><span className="traders-ai-k">as of</span> {`${istHm(asOf)} IST`}</span>}
      </div>
      {ref.future ? <div className="traders-ai-muted">Levels and the day&apos;s change are of the near future (no cash prices for it)</div> : null}
      <div className="traders-ai-figs" role="group" aria-label="Trend">
        <span><span className="traders-ai-k">Trend</span> <strong data-trend={str(trend.label)}>{TREND_TEXT[str(trend.label)] ?? '—'}</strong></span>
        <span><span className="traders-ai-k">5d</span> {pctSigned(trend.ret5d)}</span>
        <span><span className="traders-ai-k">20d</span> {pctSigned(trend.ret20d)}</span>
        <span><span className="traders-ai-k">SMA20</span> {px(trend.sma20)}</span>
        <span><span className="traders-ai-k">SMA50</span> {px(trend.sma50)}</span>
        <span><span className="traders-ai-k">SMA200</span> {px(trend.sma200)}</span>
      </div>
      <div className="traders-ai-figs" role="group" aria-label="Volatility">
        <span><span className="traders-ai-k">IV</span> {pct(vol.atmIv)}</span>
        <span><span className="traders-ai-k">HV20</span> {pct(vol.hv20)}</span>
        <span><span className="traders-ai-k">IV − HV20</span> {ivMinusHv === null ? '—' : `${ivMinusHv >= 0 ? '+' : '−'}${Math.abs(ivMinusHv * 100).toFixed(1)} pts`}</span>
        <span title={`${ivDays} days of IV history`}>
          <span className="traders-ai-k">IV rank</span> {ivRank === null ? `— (${ivDays} d)` : `${Math.round(ivRank)}${ivPctl === null ? '' : ` · pctl ${Math.round(ivPctl)}`}`}
        </span>
        <span><span className="traders-ai-k">ATR14</span> {px(vol.atr14)}</span>
      </div>
      <div className="traders-ai-figs" role="group" aria-label="Expected move">
        <span>
          <span className="traders-ai-k">Expected move</span>
          {one === null ? ' —' : ` ±${inr(one, 0)} (1σ) · ±${two === null ? '—' : inr(two, 0)} (2σ)`}
          {str(em.expiry) === '' ? null : <span className="traders-ai-muted">{` to ${expiryDayLabel(str(em.expiry))}${days === null ? '' : `, ${days} d`}`}</span>}
        </span>
      </div>
      {oi === null ? null : (
        <div className="traders-ai-figs" role="group" aria-label="Open interest">
          <span><span className="traders-ai-k">PCR</span> {numOr(oi.pcr) === null ? '—' : (oi.pcr as number).toFixed(2)}</span>
          <span><span className="traders-ai-k">Max pain</span> {whole(oi.maxPain)}</span>
          <span><span className="traders-ai-k">Call wall</span> {whole(oi.callWall)}</span>
          <span><span className="traders-ai-k">Put wall</span> {whole(oi.putWall)}</span>
          {str(oi.expiry) === '' ? null : <span className="traders-ai-muted">{`OI of ${expiryDayLabel(str(oi.expiry))}, EOD ${str(oi.day)}`}</span>}
        </div>
      )}
      <LevelLadder context={x} />
      {str(trend.basis) === '' ? null : <div className="traders-ai-muted">{str(trend.basis)}</div>}
      {warnings.length === 0 ? null : <ul className="traders-ai-warnings">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
    </div>
  )
}

function ContextCardView(props: { readonly card: CardOf<'context'> }): ReactElement {
  const c = props.card
  const stock = str(c.stock)
  return (
    <section className="traders-ai-card" aria-label={`Market context — ${stock}`} data-kind="context">
      <Head title="Market context" stock={stock} />
      {typeof c.context === 'object' && c.context !== null
        ? <ContextView context={c.context} />
        : <div className="traders-ai-muted">No market context came with this card</div>}
    </section>
  )
}

function CardBody(props: { readonly card: AssistantCard }): ReactElement | null {
  const c = props.card
  if (typeof c !== 'object' || c === null) return null
  switch (c.kind) {
    case 'plans': return <PlansCardView card={c} />
    case 'evaluation': return <EvaluationCardView card={c} />
    case 'neutralize': return <NeutralizeCardView card={c} />
    case 'context': return <ContextCardView card={c} />
    default: return null
  }
}

/** Any card the server sends; a kind this page does not know yet is skipped, and one that fails is a line of text. */
export function CardView(props: { readonly card: AssistantCard }): ReactElement {
  return <CardBoundary><CardBody card={props.card} /></CardBoundary>
}
