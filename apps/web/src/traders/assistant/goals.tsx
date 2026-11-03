/**
 * What the trader asks a search for, without the model: goal chips, a market view and "Allow closing legs".
 *
 * Goals stack in the order they are picked: the FIRST is the goal the plans are ranked on; every later one is a
 * guard — "keep this no worse than now" (spec §4 `presetObjective`). The chips say which is which. Closing legs is
 * off unless the trader ticks it on this page; the model can never set it (spec R6).
 */

import type { ReactElement } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import type { AssistantStatus, ViewChoice } from '../../../../traders/src/agent/wire.ts'

/** The payoff package's `PresetId`, by way of the wire (the page names no package of the server's). */
export type PresetId = AssistantStatus['presets'][number]['id']

/**
 * The presets in a trader's words, for a server that does not list them (the status endpoint missing). Typed on
 * the payoff package's `PresetId`, so a preset added there fails this page's typecheck until it is named here.
 */
export const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  'neutralize-delta': 'Neutralize delta',
  'recentre-delta0': 'Recentre Δ0',
  'cut-margin': 'Cut margin',
  'raise-pop': 'Raise POP',
  'cut-vega': 'Cut vega',
  'cut-gamma': 'Cut gamma',
  'cap-max-loss': 'Cap max loss',
  'keep-theta': 'Keep theta',
  'collect-credit-safe': 'Collect credit, safely',
  'max-ev': 'Max EV',
}

export const DEFAULT_PRESETS: readonly { readonly id: PresetId; readonly label: string }[] =
  (Object.keys(PRESET_LABELS) as PresetId[]).map((id) => ({ id, label: PRESET_LABELS[id] }))

/** Presets that rank on expected value, which needs a view (spec §4: "ev needs a view"). */
const NEEDS_VIEW: ReadonlySet<PresetId> = new Set<PresetId>(['max-ev'])

export type ViewForm =
  | { readonly kind: 'implied' }
  | { readonly kind: 'hv20' }
  | { readonly kind: 'shift'; readonly pts: number | null }
  | { readonly kind: 'mine'; readonly pct: number | null }

export interface Goals {
  readonly presets: readonly PresetId[]
  readonly view: ViewForm
  readonly allowClose: boolean
}

export const NO_GOALS: Goals = { presets: [], view: { kind: 'implied' }, allowClose: false }

/** A chip clicked: added at the end (a guard, or the goal when first), or taken out (the next one becomes the goal). */
export function toggleGoal(presets: readonly PresetId[], id: PresetId): PresetId[] {
  return presets.includes(id) ? presets.filter((p) => p !== id) : [...presets, id]
}

/**
 * The view as the server takes it. "IV − x pts" sends a shift of −x vol points; "my vol" sends the annual vol as a
 * DECIMAL (22 % → 0.22, as `MarketView.flat.annual`). Null while the number is not filled in.
 */
export function viewChoice(v: ViewForm): ViewChoice | null {
  switch (v.kind) {
    case 'implied': return { vol: 'implied' }
    case 'hv20': return { vol: 'hv20' }
    case 'shift': return v.pts === null || !Number.isFinite(v.pts) ? null : { vol: { shiftPts: -v.pts } }
    case 'mine': return v.pct === null || !Number.isFinite(v.pct) || v.pct <= 0 ? null : { vol: { annual: v.pct / 100 } }
  }
}

/**
 * The view to send with a request: none for the default Implied (the server's own default) unless a goal needs a
 * view; else the chosen one. `false` when the chosen view is not filled in.
 */
export function viewToSend(g: Goals): ViewChoice | undefined | false {
  const v = viewChoice(g.view)
  if (v === null) return false
  if (g.view.kind === 'implied' && !g.presets.some((p) => NEEDS_VIEW.has(p))) return undefined
  return v
}

export function viewText(v: ViewForm): string {
  switch (v.kind) {
    case 'implied': return 'Implied'
    case 'hv20': return 'HV20'
    case 'shift': return v.pts === null ? 'IV − ? pts' : `IV − ${v.pts} pts`
    case 'mine': return v.pct === null ? 'My vol ? %' : `My vol ${v.pct} %`
  }
}

export function GoalChips(props: {
  readonly presets: readonly { readonly id: PresetId; readonly label: string }[]
  readonly value: readonly PresetId[]
  readonly onChange: (next: PresetId[]) => void
}): ReactElement {
  const { value } = props
  const label = (id: PresetId): string => props.presets.find((p) => p.id === id)?.label ?? PRESET_LABELS[id] ?? id
  return (
    <div className="traders-ai-goals-wrap">
      <div className="traders-ai-goals" role="group" aria-label="Goals">
        {props.presets.map((p) => {
          const at = value.indexOf(p.id)
          const role = at === 0 ? 'primary' : at > 0 ? 'keep' : 'off'
          return (
            <button key={p.id} type="button" className="traders-ai-goal" data-role={role} aria-pressed={at >= 0}
              title={role === 'primary' ? 'The goal: plans are ranked on it' : role === 'keep' ? 'Kept no worse than now' : 'Pick: the first pick is the goal, later picks are kept no worse'}
              onClick={() => props.onChange(toggleGoal(value, p.id))}>
              {role === 'primary' ? <span className="traders-ai-goal-mark">Goal</span> : role === 'keep' ? <span className="traders-ai-goal-mark">keep</span> : null}
              {p.label}
            </button>
          )
        })}
      </div>
      <div className="traders-ai-muted" aria-live="polite">
        {value.length === 0
          ? 'Pick a goal. Further picks are kept no worse than now.'
          : `Goal: ${label(value[0] as PresetId)}${value.length > 1 ? ` · keep no worse: ${value.slice(1).map(label).join(', ')}` : ''}`}
      </div>
    </div>
  )
}

export function ViewPicker(props: { readonly value: ViewForm; readonly onChange: (v: ViewForm) => void }): ReactElement {
  const v = props.value
  return (
    <div className="traders-ai-view">
      <SegmentedControl size="sm" label="View" value={v.kind} onChange={(k) => {
        props.onChange(k === 'shift' ? { kind: 'shift', pts: 2 } : k === 'mine' ? { kind: 'mine', pct: null } : { kind: k as 'implied' | 'hv20' })
      }}>
        <SegmentedControlItem value="implied" label="Implied" />
        <SegmentedControlItem value="hv20" label="HV20" />
        <SegmentedControlItem value="shift" label="IV − x pts" />
        <SegmentedControlItem value="mine" label="My vol %" />
      </SegmentedControl>
      {v.kind === 'shift' ? (
        <NumberInput label="Vol points below IV" isLabelHidden size="sm" width={72} min={0} max={50} step={0.5}
          value={v.pts} onChange={(n) => props.onChange({ kind: 'shift', pts: n })} />
      ) : v.kind === 'mine' ? (
        <NumberInput label="My annual vol %" isLabelHidden size="sm" width={72} min={1} max={300} step={0.5} placeholder="%"
          value={v.pct} onChange={(n) => props.onChange({ kind: 'mine', pct: n })} />
      ) : null}
    </div>
  )
}

export function AllowClose(props: { readonly value: boolean; readonly onChange: (v: boolean) => void }): ReactElement {
  return <CheckboxInput size="sm" label="Allow closing legs" value={props.value} onChange={props.onChange} />
}
