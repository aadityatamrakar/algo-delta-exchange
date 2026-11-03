/**
 * Plan search without the model: goals, a view and "Allow closing legs" → `POST /books/:stock/plan-search` → the
 * plans card. Deterministic and keyless, so it is the whole drawer when the assistant is off (spec R4).
 *
 * A server that does not have the route yet (404) says so here; nothing else on the page is affected.
 */

import { useState, type ReactElement } from 'react'
import { Button } from '@astryxdesign/core/Button'
import type { AssistantCard } from '../../../../traders/src/agent/wire.ts'
import { tapi, TradersApiError } from '../api.ts'
import { CardView } from './cards.tsx'
import { AllowClose, GoalChips, ViewPicker, viewToSend, type Goals, type PresetId } from './goals.tsx'

type Run = { readonly state: 'idle' } | { readonly state: 'running' } | { readonly state: 'done'; readonly card: AssistantCard } | { readonly state: 'failed'; readonly message: string }

export function failureText(err: unknown, what: string): string {
  if (err instanceof TradersApiError && err.status === 404) return `${what} is not on this server yet — it arrives with the next restart of the traders server`
  return `${what} failed: ${err instanceof Error ? err.message : String(err)}`
}

export function PlanSearch(props: {
  readonly stock: string | null
  readonly stocks: readonly string[]
  readonly presets: readonly { readonly id: PresetId; readonly label: string }[]
  readonly goals: Goals
  readonly onGoals: (g: Goals) => void
}): ReactElement {
  const { goals } = props
  const [picked, setPicked] = useState<string | null>(null)
  const stock = props.stock ?? (picked !== null && props.stocks.includes(picked) ? picked : null)
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const view = viewToSend(goals)
  const ready = stock !== null && goals.presets.length > 0 && view !== false && run.state !== 'running'

  const search = (): void => {
    if (stock === null || view === false || goals.presets.length === 0) return
    setRun({ state: 'running' })
    tapi.planSearch(stock, { presets: goals.presets, ...(view === undefined ? {} : { view }), ...(goals.allowClose ? { allowClose: true } : {}) }).then(
      (r) => setRun(r !== null && typeof r === 'object' && typeof r.card === 'object' && r.card !== null
        ? { state: 'done', card: r.card }
        : { state: 'failed', message: 'Plan search answered without a card' }),
      (err: unknown) => setRun({ state: 'failed', message: failureText(err, 'Plan search') }),
    )
  }

  return (
    <div className="traders-ai-form" role="form" aria-label="Plan search">
      {props.stock !== null ? null : (
        <label className="traders-ai-field">
          <span className="traders-ai-k">Book</span>
          <select className="traders-ai-select" value={stock ?? ''} onChange={(e) => setPicked(e.target.value === '' ? null : e.target.value)}>
            <option value="">Pick a book…</option>
            {props.stocks.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
      <GoalChips presets={props.presets} value={goals.presets} onChange={(presets) => props.onGoals({ ...goals, presets })} />
      <ViewPicker value={goals.view} onChange={(v) => props.onGoals({ ...goals, view: v })} />
      <div className="traders-ai-row">
        <AllowClose value={goals.allowClose} onChange={(allowClose) => props.onGoals({ ...goals, allowClose })} />
        <span className="traders-ai-grow" />
        <Button size="sm" variant="primary" label={run.state === 'running' ? 'Searching…' : 'Search'} isDisabled={!ready}
          tooltip="Searches adjustments that meet the goal without making the worst case worse; nothing is traded" onClick={search} />
      </div>
      {run.state === 'failed' ? <div className="traders-ai-error" role="alert">{run.message}</div> : null}
      {run.state === 'done' ? <CardView card={run.card} /> : null}
    </div>
  )
}
