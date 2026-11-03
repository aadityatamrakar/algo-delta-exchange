/**
 * The Scenario sub-tab: VolHedge v50's Scenario window over `POST /scenario`
 * — the inputs strip, the leg table with hypothetical rows, the totals row,
 * the date ticks, the 14 metric tabs and the spot × date grid.
 *
 * Read-only analytics. Every control changes what is computed for this
 * viewer and nothing else: hypothetical rows ride in the request body and are
 * never stored server-side; nothing here places, changes or cancels an order.
 *
 * The request state is the per-book store `useScenarioInputs` (`viewer.ts`):
 * it outlives a sub-tab switch, and the payoff sliders (Task 17) read and set
 * `targetDate` and `volShift` through the same `patch`. Inputs settle for
 * 300 ms before one request goes out; the figures refresh every 60 s.
 */

import { memo, useCallback, useEffect, type ReactElement, type ReactNode } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import type { ISODateString } from '@astryxdesign/core/Calendar'
import { DateInput } from '@astryxdesign/core/DateInput'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Popover } from '@astryxdesign/core/Popover'
import { Text } from '@astryxdesign/core/Text'
import type { HypotheticalLeg, ScenarioRequest, ScenarioView } from '../../../traders/src/analytics/wire.ts'
import { tapi } from './api.ts'
import { useFigures, useSettled } from './hooks.ts'
import { ScenarioLegs, toHypothetical } from './hypothetical-rows.tsx'
import { PayoffSliders } from './payoff-sliders.tsx'
import { ScenarioGrid, ScenarioTotals } from './scenario-grid.tsx'
import { UnitsToggle } from './units.tsx'
import { useScenarioInputs, useViewer, type ScenarioInputs, type ScenarioPatch, type ViewerState } from './viewer.ts'
import { istDay, istHm } from './wire.ts'
import { Caveats } from './caveats.tsx'
import { useBellReport } from './bell-store.tsx'

const SETTLE_MS = 300
/** The server's limit on a vol shift, in vol points. */
const VOL_SHIFT_LIMIT = 50
/** The server's limit on Strike +/- (rows each side; 201 rows in all). */
const COUNT_LIMIT = 100
const DATE = /^\d{4}-\d{2}-\d{2}$/

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * The request body. A field is sent only once the viewer has set it: a null
 * input is left out, so the server computes its default (the live spot, today,
 * the near expiry, the ATM strike, 0.5 %, 50 rows, every day, no shift) and
 * echoes it in `resolved`. A value the viewer set is sent as set, even when it
 * equals today's default, so a pinned CMP does not drift with the market. No
 * non-finite number or malformed date is ever sent; empty lists are left out;
 * a hypothetical row goes only once complete, and — once the book's lot size
 * is known — only as whole lots of it.
 */
export function scenarioBody(inputs: ScenarioInputs, viewer: ViewerState, lotSize: number | null): ScenarioRequest {
  const body: Mutable<ScenarioRequest> = {}
  if (viewer.exclude.length > 0) body.exclude = viewer.exclude
  if (viewer.illiquid.length > 0) body.illiquid = viewer.illiquid
  const iv = Object.entries(viewer.ivOverrides).filter(([, x]) => Number.isFinite(x) && x > 0)
  if (iv.length > 0) body.ivOverrides = Object.fromEntries(iv)
  const num = (n: number | null): n is number => n !== null && Number.isFinite(n)
  const day = (d: string | null): d is string => d !== null && DATE.test(d)
  if (num(inputs.spot)) body.spot = inputs.spot
  if (num(inputs.callVolShift)) body.callVolShift = inputs.callVolShift
  if (num(inputs.putVolShift)) body.putVolShift = inputs.putVolShift
  if (num(inputs.volShift)) body.volShift = inputs.volShift
  if (day(inputs.start)) body.start = inputs.start
  if (day(inputs.end)) body.end = inputs.end
  if (num(inputs.everyNth)) body.everyNth = inputs.everyNth
  if (num(inputs.middle)) body.middle = inputs.middle
  if (num(inputs.stepPct)) body.stepPct = inputs.stepPct
  if (num(inputs.count)) body.count = inputs.count
  if (day(inputs.targetDate)) body.targetDate = inputs.targetDate
  const hyp = inputs.rows.flatMap((r) => {
    const built = toHypothetical(r, lotSize)
    return 'leg' in built ? [built.leg] : []
  })
  if (hyp.length > 0) body.hypothetical = hyp
  return body
}

export function ScenarioTab(props: { readonly stock: string }): ReactElement {
  // Another book is another request and another set of figures; its inputs live in the viewer store.
  return <ScenarioBody key={props.stock} stock={props.stock} />
}

/** An answer and the request it answers, so a hypothetical row is matched to the version of it that was sent. */
interface Answer { readonly view: ScenarioView; readonly sent: ScenarioRequest }

const NONE_SENT: readonly HypotheticalLeg[] = []

/** What `Reset inputs` sets: every input of the strip (and the chart's target date) back to the server's default. */
const STRIP_UNSET: Partial<ScenarioInputs> = {
  spot: null, callVolShift: null, putVolShift: null, volShift: null, start: null, end: null,
  everyNth: null, middle: null, stepPct: null, count: null, targetDate: null,
}

function ScenarioBody(props: { readonly stock: string }): ReactElement {
  const { stock } = props
  const viewer = useViewer(stock)
  const { inputs, patch } = useScenarioInputs(stock)
  // The book's lot size from the last answer, kept in the store: the body counts hypothetical lots in it,
  // from a remount's first request on.
  const lotSize = inputs.lotSize
  const settled = useSettled(scenarioBody(inputs, viewer.state, lotSize), SETTLE_MS)
  const scenario = useFigures(
    () => tapi.scenario(stock, settled).then((view): Answer => ({ view, sent: settled })), true, JSON.stringify(settled))
  const answer = scenario.data
  const v = answer?.view ?? null
  const answeredLot = v?.lotSize
  useEffect(() => { if (answeredLot !== undefined && answeredLot !== lotSize) patch({ lotSize: answeredLot }) }, [answeredLot, lotSize, patch])
  const reset = useCallback(() => patch(STRIP_UNSET), [patch])
  const closedToBell = useBellReport(v === null ? null : { closed: v.closed })

  // The strip and the leg table always render, so an input the server refuses can be changed or reset
  // even when no answer has come yet (the inputs outlive a remount).
  return (
    <VStack gap={3}>
      <InputsStrip view={v} inputs={inputs} patch={patch} />
      {/* A refused request names the field; any good figures stay on screen under it. */}
      {scenario.error === null
        ? (v === null ? <Text color="secondary">{`Loading the scenario of ${stock}…`}</Text> : null)
        : (
          <Banner status={v === null ? 'error' : 'warning'}
            title={v === null ? `Could not load the scenario of ${stock}: ${scenario.error}` : `Scenario not updated: ${scenario.error}`}
            endContent={<Button size="sm" variant="secondary" label="Reset inputs" onClick={reset} />} />
        )}
      <Caveats items={v?.warnings ?? []} kind="warning" />
      {/* One strip over the table: "as of" (and, with no bell, a closed market) at its left, the units switch at its right.
          The switch rescales the book's figures below — the chart and table, the totals, the grid's plain metrics — never the leg table. */}
      <HStack gap={3} align="center" justify="between" wrap="wrap">
        <HStack gap={3} align="center">
          {v === null ? null : <Text color="secondary" size="sm">{`as of ${istHm(v.asOf)} IST`}</Text>}
          {/* A closed market is the bell's "Market closed" pill (reported above); inline only with no bell. */}
          {v !== null && v.closed && !closedToBell ? <Text size="sm" color="secondary">Market closed — last session&apos;s prices</Text> : null}
        </HStack>
        <UnitsToggle lotSize={v?.lotSize ?? null} />
      </HStack>
      <ScenarioLegs view={v} answered={answer?.sent.hypothetical ?? NONE_SENT} lotSize={lotSize} excluded={viewer.state.exclude}
        inputs={inputs} patch={patch} />
      {v === null ? null : (
        <>
          <PayoffSliders view={v} today={istDay(v.asOf)} target={inputs.targetDate} volShift={inputs.volShift} onTarget={(d) => patch({ targetDate: d })} onVolShift={(n) => patch({ volShift: n })} />
          <ScenarioTotals view={v} units={viewer.units} />
          <ScenarioGrid view={v} units={viewer.units} metric={inputs.metric} hidden={inputs.hidden} patch={patch} />
        </>
      )}
    </VStack>
  )
}

const iso = (d: string): ISODateString | undefined => (DATE.test(d) ? (d as ISODateString) : undefined)

/** A DateInput's `value`, `min` and `max`, each only when known (the props take no undefined). */
function dates(value: ISODateString | undefined, min: ISODateString | undefined, max: ISODateString | undefined): {
  value?: ISODateString; min?: ISODateString; max?: ISODateString
} {
  return { ...(value === undefined ? {} : { value }), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
}

interface StripProps { readonly view: ScenarioView | null; readonly inputs: ScenarioInputs; patch(p: ScenarioPatch): void }

/** The inputs the strip shows; a hypothetical-row edit changes none of them and does not re-render it. */
const STRIP_FIELDS = ['spot', 'callVolShift', 'putVolShift', 'volShift', 'start', 'end', 'everyNth', 'middle', 'stepPct', 'count'] as const

/** '2026-10-27' as '27 Oct': the strip's date pickers, short. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (d: ISODateString): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1] ?? ''}`

/** A small label beside its control, on the strip (the Analysis line's idiom). */
function Pair(props: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <span className="traders-pair">
      <Text size="sm" color="secondary">{props.label}</Text>
      {props.children}
    </span>
  )
}

/** The Adjust panel's inputs the viewer has set (the rest follow the server), on the line itself. */
function AdjustChip(props: { readonly inputs: ScenarioInputs }): ReactElement | null {
  const i = props.inputs
  const parts = [
    i.stepPct === null ? null : `Interval ${i.stepPct} %`,
    i.count === null ? null : `Strike ±${i.count}`,
    i.middle === null ? null : `M.Strike ${i.middle}`,
    i.everyNth === null ? null : `Every ${i.everyNth} ${i.everyNth === 1 ? 'day' : 'days'}`,
  ].filter((s): s is string => s !== null)
  if (parts.length === 0) return null
  return <span className="traders-active-changes" role="status" aria-label="Changed from the defaults">{parts.join(' · ')}</span>
}

/**
 * VolHedge's strip as one line, inline labels: CMP, Call Vol, Put Vol, Vol with + and − · Start, Exp; the grid's
 * shape (Interval %, Strike +/-, M.Strike, and ours, Every Nth day) in the Adjust panel, a chip on the line saying
 * which of them are set. Each shows what the viewer set, else the server's `resolved` value (blank before the first
 * answer); emptying one, or Reset for all, hands it back to the server's default. Start runs to Exp at most, Exp
 * from Start.
 */
const InputsStrip = memo(function InputsStrip(props: StripProps): ReactElement {
  const { view: v, inputs, patch } = props
  const r = v?.resolved
  const vol = inputs.volShift ?? r?.volShift ?? null
  const base = vol ?? 0
  const start = iso(inputs.start ?? r?.start ?? '')
  const end = iso(inputs.end ?? r?.end ?? '')
  const today = v === null ? undefined : iso(istDay(v.asOf))
  const nudge = (by: number): void => patch({ volShift: Math.max(-VOL_SHIFT_LIMIT, Math.min(VOL_SHIFT_LIMIT, base + by)) })
  const anySet = STRIP_FIELDS.some((k) => inputs[k] !== null)
  return (
    <HStack gap={1.5} align="center" wrap="wrap" className="traders-controls" role="group" aria-label="Scenario inputs">
      <Pair label="CMP">
        <NumberInput label="CMP" isLabelHidden size="sm" width={84} min={0.01} step={0.05}
          value={inputs.spot ?? r?.spot ?? null} onChange={(n) => patch({ spot: n })} />
      </Pair>
      <Pair label="Call Vol">
        <NumberInput label="Call Vol" isLabelHidden size="sm" width={64} min={-VOL_SHIFT_LIMIT} max={VOL_SHIFT_LIMIT}
          value={inputs.callVolShift ?? r?.callVolShift ?? null} onChange={(n) => patch({ callVolShift: n })} />
      </Pair>
      <Pair label="Put Vol">
        <NumberInput label="Put Vol" isLabelHidden size="sm" width={64} min={-VOL_SHIFT_LIMIT} max={VOL_SHIFT_LIMIT}
          value={inputs.putVolShift ?? r?.putVolShift ?? null} onChange={(n) => patch({ putVolShift: n })} />
      </Pair>
      <Pair label="Vol">
        <NumberInput label="Vol" isLabelHidden size="sm" width={64} min={-VOL_SHIFT_LIMIT} max={VOL_SHIFT_LIMIT}
          value={vol} onChange={(n) => patch({ volShift: n })} />
        <span className="traders-nudge">
          <Button size="sm" variant="ghost" label="+" isDisabled={base >= VOL_SHIFT_LIMIT} onClick={() => nudge(1)} />
          <Button size="sm" variant="ghost" label="−" isDisabled={base <= -VOL_SHIFT_LIMIT} onClick={() => nudge(-1)} />
        </span>
      </Pair>
      <span className="traders-sep" aria-hidden="true" />
      <Pair label="Start">
        <DateInput label="Start" isLabelHidden size="sm" width={96} format={shortDate} {...dates(start, today, end)} onChange={(d) => patch({ start: d ?? null })} />
      </Pair>
      <Pair label="Exp">
        <DateInput label="Exp" isLabelHidden size="sm" width={96} format={shortDate} {...dates(end, start, undefined)} onChange={(d) => patch({ end: d ?? null })} />
      </Pair>
      <AdjustChip inputs={inputs} />
      <span className="traders-controls-end">
        <Popover label="The grid's strikes and days" placement="below" alignment="end" content={
          <VStack gap={2} className="traders-adjust">
            <HStack gap={2} align="center">
              <Pair label="Interval %">
                <NumberInput label="Interval" isLabelHidden units="%" size="sm" width={72} min={0.01} step={0.05}
                  value={inputs.stepPct ?? r?.stepPct ?? null} onChange={(n) => patch({ stepPct: n })} />
              </Pair>
              <Pair label="Strike ±">
                <NumberInput label="Strike +/-" isLabelHidden size="sm" width={64} min={0} max={COUNT_LIMIT} isIntegerOnly
                  value={inputs.count ?? r?.count ?? null} onChange={(n) => patch({ count: n })} />
              </Pair>
            </HStack>
            <HStack gap={2} align="center">
              <Pair label="M.Strike">
                <NumberInput label="M.Strike" isLabelHidden size="sm" width={84} min={0.01} step={0.05}
                  value={inputs.middle ?? r?.middle ?? null} onChange={(n) => patch({ middle: n })} />
              </Pair>
              <Pair label="Every N days">
                <NumberInput label="Every Nth day" isLabelHidden size="sm" width={64} min={1} isIntegerOnly
                  value={inputs.everyNth ?? r?.everyNth ?? null} onChange={(n) => patch({ everyNth: n })} />
              </Pair>
            </HStack>
          </VStack>
        }>
          <Button size="sm" variant="secondary" label="Adjust" tooltip="Interval %, Strike ±, M.Strike, Every N days" />
        </Popover>
        <Button size="sm" variant="ghost" label="Reset" tooltip="Every input back to the default" isDisabled={!anySet}
          onClick={() => patch(STRIP_UNSET)} />
      </span>
    </HStack>
  )
}, (a: StripProps, b: StripProps) => a.view === b.view && a.patch === b.patch && STRIP_FIELDS.every((k) => a.inputs[k] === b.inputs[k]))
