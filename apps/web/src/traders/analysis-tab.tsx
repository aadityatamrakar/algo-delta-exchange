/**
 * The book's one view: VolHedge v50's Analysis window over `GET /analysis` and `GET /margin`, with the book's own
 * pieces from `GET /books/<stock>` (manual legs' Add, Edit and Delete, the payoff chart, the position totals) where
 * the book is to hand. One line of controls, then the panels as blocks on a grid (dashboard.tsx): the legs table
 * with its month tabs, the Greeks, the payoff chart, To Neutralize, Margin, P&L and Gap Up Down. Explanations sit
 * behind an ⓘ; warnings go to the bell.
 *
 * When the analysis cannot be had (an older server, a failed request), the book's own legs table stands in, with
 * its actions, so the book is never empty.
 *
 * Read-only analytics. Every control here changes what is computed for this viewer — ticks, typed IVs, vol shifts,
 * a future override, the gap rows — and nothing else: none places, changes or cancels an order.
 *
 * Inputs settle for 300 ms before one request goes out; the figures refresh every 60 s while Online Update is on.
 */

import { Popover } from '@astryxdesign/core/Popover'
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Button } from '@astryxdesign/core/Button'
import { MetadataListItem } from '@astryxdesign/core/MetadataList'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Switch } from '@astryxdesign/core/Switch'
import { TabList, Tab } from '@astryxdesign/core/TabList'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { inr, money, sign } from '../format.ts'
import type { LiveFrame } from '../../../traders/src/analytics/r3-wire.ts'
import type { AnalysisView, MarginView, MtmBlock } from '../../../traders/src/analytics/wire.ts'
import type { BookView } from '../../../traders/src/types.ts'
import { tapi, type AnalysisQueryInput } from './api.ts'
import { FIGURES_POLL_MS, useFigures, useSettled } from './hooks.ts'
import { GapPanel } from './gap-panel.tsx'
import { GreekPanels } from './greek-panels.tsx'
import { LegTable } from './leg-table.tsx'
import { MarginBox } from './margin-box.tsx'
import { UnitsToggle } from './units.tsx'
import { useAnalysisInputs, useViewer, type AnalysisInputs } from './viewer.ts'
import { SERVER_UPDATE_PENDING, istHm, maturityLabel, orDash } from './wire.ts'
import { BellAlert } from './bell.tsx'
import { useBellReport } from './bell-store.tsx'
import { Caveats } from './caveats.tsx'
import { TradersTable } from './table.tsx'
import { Block, FigureList, NUM, Num } from './figures.tsx'
import { InfoTip } from './fold.tsx'
import { BookTotals, NotUnderstood, PayoffChart, PlainLegTable, useLegActions } from './book-legs.tsx'
import { Dashboard, useBlockSize, type DashBlock } from './dashboard.tsx'
import { EDIT_LAYOUT_EVENT } from './shortcuts.tsx'
import { ScenarioTab } from './scenario-tab.tsx'
import { AdviceTab } from './advice.tsx'
import type { Slot } from './layout.ts'
import { publishNeutral, useAnalysisOpen } from './neutral-store.ts'
import { LIVE_FIGURES_MS, frameToday, liveFrameOf, overlayLegs, useLiveBook } from './live.tsx'
import { MarketContextBlock } from './assistant/context-block.tsx'
import { RATES_ESTIMATE, SHARES_LINE, TODAY_ABOUT, pnlOf, seriesLines, seriesOf, sinceText, type Series } from './series-lines.ts'

const SETTLE_MS = 300
const ALL = 'all'
/** The server's limit on a call or put vol shift, in vol points. */
const VOL_SHIFT_LIMIT = 50
const NO_RELOAD = (): void => {}

/** An answer shaped like the analysis: anything else (an older server's reply) counts as no analysis. */
function isAnalysisView(x: unknown): x is AnalysisView {
  if (typeof x !== 'object' || x === null) return false
  const v = x as Partial<AnalysisView>
  return Array.isArray(v.legs) && Array.isArray(v.months) && typeof v.mtm === 'object' && v.mtm !== null && Array.isArray(v.warnings)
}

function isMarginView(x: unknown): x is MarginView {
  return typeof x === 'object' && x !== null && typeof (x as Partial<MarginView>).available === 'boolean'
}

export function AnalysisTab(props: { readonly stock: string; readonly view?: BookView | null; reload?(): void }): ReactElement {
  // Another book is another poll and another set of figures; its inputs live in the viewer store.
  return <AnalysisBody key={props.stock} stock={props.stock} book={props.view ?? null} reload={props.reload ?? NO_RELOAD} />
}

/**
 * The default arrangement (the user's own, 20 Oct): the legs across the top (as tall as its rows), then To Neutralize,
 * Greeks, P&L (id `mtm`, so saved layouts keep it) and Gap Up Down side by side, then Margin beside a wide payoff chart.
 * `y` gives the reading order; the grid packs the blocks upward.
 */
export const ANALYSIS_LAYOUT: readonly Slot[] = [
  { id: 'legs', x: 0, y: 0, w: 12, h: 10, hidden: false, fit: true },
  { id: 'neutralize', x: 0, y: 100, w: 2, h: 7, hidden: false },
  { id: 'greeks', x: 2, y: 100, w: 4, h: 7, hidden: false },
  { id: 'mtm', x: 6, y: 100, w: 3, h: 7, hidden: false },
  { id: 'gap', x: 9, y: 100, w: 3, h: 7, hidden: false },
  { id: 'margin', x: 0, y: 200, w: 3, h: 7, hidden: false },
  { id: 'payoff', x: 3, y: 200, w: 9, h: 7, hidden: false },
  // blocks a trader can add from Edit layout: the other sub-tabs' panels, here beside the book
  { id: 'scenario', x: 0, y: 300, w: 12, h: 14, hidden: true },
  { id: 'advice', x: 0, y: 400, w: 12, h: 12, hidden: true },
  { id: 'context', x: 0, y: 500, w: 6, h: 14, hidden: true },
]

/** The payoff chart as tall as its block allows (its legend and warnings under it). */
function SizedPayoff(props: { readonly book: BookView }): ReactElement {
  const size = useBlockSize()
  return <PayoffChart view={props.book} height={Math.max(110, Math.min(480, size.heightPx - 64))} />
}

/** Grid rows are 28 px with 8 px gaps: a block of h rows is 36h − 8 px tall. */
const ROW_PX = 36
/**
 * The legs block's height, in grid rows, for this many legs: the tab strip and the header row (~70 px), ~33 px a leg,
 * and the not-understood lines under it; past ~13 legs the table scrolls inside the block.
 */
export function legsRows(legs: number, notUnderstood: number): number {
  const px = 70 + 33 * Math.min(legs, 60) + (notUnderstood > 0 ? 22 * (notUnderstood + 1) : 0) + 8
  return Math.min(80, Math.max(4, Math.ceil(px / ROW_PX)))
}

/** Grid rows for content this many px tall: the block shows every leg, the page scrolls (not the table). */
export function rowsForPx(px: number): number {
  return Math.min(80, Math.max(4, Math.ceil((px + 12) / ROW_PX)))
}

/** The measured height of what the returned ref is put on, following it as it changes (a leg added, a bigger text size). */
function useMeasuredHeight(): [(el: HTMLElement | null) => void, number | null] {
  const [px, setPx] = useState<number | null>(null)
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (el === null || typeof ResizeObserver === 'undefined') return
    const read = (): void => { const h = Math.round(el.getBoundingClientRect().height); setPx((old) => (old === h || h === 0 ? old : h)) }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [el])
  return [setEl, px]
}

function AnalysisBody(props: { readonly stock: string; readonly book: BookView | null; reload(): void }): ReactElement {
  const { stock, book } = props
  const viewer = useViewer(stock)
  const { inputs, patch } = useAnalysisInputs(stock)
  const online = inputs.online
  const hasBell = useBellReport(null)
  const actions = useLegActions(stock, book, props.reload)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    const toggle = (): void => setEditing((e) => !e)
    window.addEventListener(EDIT_LAYOUT_EVENT, toggle)
    return () => window.removeEventListener(EDIT_LAYOUT_EVENT, toggle)
  }, [])

  const query: AnalysisQueryInput = {
    expiry: inputs.expiry, exclude: viewer.state.exclude, illiquid: viewer.state.illiquid, ivOverrides: viewer.state.ivOverrides,
    callVol: inputs.callVol, putVol: inputs.putVol, future: inputs.future,
    gap: inputs.gap, gapUseLtp: inputs.gapUseLtp, gapUseVol: inputs.gapUseVol, volBasis: inputs.volBasis,
  }
  const settled = useSettled(query, SETTLE_MS)
  // live: prices and MTM tick in from the stream; the full analysis (greeks, Δ0, the panels) refreshes every 5 s
  const live = useLiveBook(stock)
  const analysis = useFigures(() => tapi.analysis(stock, settled), online, JSON.stringify(settled),
    live.status === 'live' ? LIVE_FIGURES_MS : FIGURES_POLL_MS)
  const margin = useFigures(() => tapi.margin(stock, settled.exclude), online, JSON.stringify(settled.exclude))
  const refetchAnalysis = analysis.refetch
  const refetchMargin = margin.refetch
  const calculate = useCallback(() => { refetchAnalysis(); refetchMargin() }, [refetchAnalysis, refetchMargin])
  const setLive = (on: boolean): void => {
    patch({ online: on })
    if (on) calculate()
  }

  const v = isAnalysisView(analysis.data) ? analysis.data : null
  const failed = v === null && (analysis.error !== null || analysis.data !== null)
  const m = isMarginView(margin.data) ? margin.data : null
  // The strip on the book's title line shows this Δ0 too, without asking again.
  useAnalysisOpen(stock)
  const [legsRef, legsPx] = useMeasuredHeight()
  const n = v?.toNeutralize ?? null
  const n0 = n !== null && typeof n.price === 'number' ? n.price : null
  const n1 = n !== null && typeof n.pct === 'number' ? n.pct : null
  const b0 = v?.breakevens.low ?? null
  const b1 = v?.breakevens.high ?? null
  const tv = v !== null && Number.isFinite(v.bookTimeValue) ? v.bookTimeValue : null
  const d0 = v !== null && Number.isFinite(v.totals.T.delta) ? v.totals.T.delta : null
  useEffect(() => {
    if (v !== null) publishNeutral(stock, { price: n0, pct: n1, bepLow: b0, bepHigh: b1, timeValue: tv, delta: d0 }, Date.now())
  }, [stock, v, n0, n1, b0, b1, tv, d0])

  if (v === null) {
    if (!failed) return <Text color="secondary">{`Loading the analysis of ${stock}…`}</Text>
    if (book === null) {
      return <BellAlert status="error" inline text={`Could not load the analysis of ${stock}: ${analysis.error ?? 'not an analysis'}`} />
    }
    return <BookOnly stock={stock} book={book} margin={m} marginError={margin.error} actions={actions} closedInline={book.closed && !hasBell} />
  }

  const month = inputs.expiry ?? ALL
  const blocks: DashBlock[] = [
    {
      id: 'legs', title: 'Legs', minW: 6, minH: 4,
      render: () => (
        <div ref={legsRef}><VStack gap={1}>
          <HStack gap={2} align="center" justify="between" wrap="wrap">
            <HStack gap={3} align="center">
              <TabList role="tablist" aria-label="Months" value={month} onChange={(e) => patch({ expiry: e === ALL ? null : e })} layout="hug" size="sm">
                <Tab role="tab" aria-selected={month === ALL} value={ALL} label="All" />
                {v.months.map((mo) => <Tab key={mo.expiry} role="tab" aria-selected={month === mo.expiry} value={mo.expiry} label={mo.label} />)}
              </TabList>
              <Text size="sm" color="secondary">{`as of ${istHm(v.asOf)} IST`}</Text>
              {v.closed && !hasBell ? <Text size="sm" color="secondary">Market closed — last session&apos;s prices</Text> : null}
            </HStack>
            <HStack gap={2} align="center">
              <UnitsToggle lotSize={v.lotSize} />
              {actions.add}
            </HStack>
          </HStack>
          <LegTable legs={overlayLegs(v.legs, live, v.asOf)} state={viewer.state} toggleExclude={viewer.toggleExclude} toggleIlliquid={viewer.toggleIlliquid}
            setIv={viewer.setIv} {...(book === null ? {} : { actions: actions.actionsFor })} />
          <NotUnderstood lines={v.unmatched} />
        </VStack></div>
      ),
    },
    {
      id: 'greeks', title: 'Greeks', minW: 4, minH: 4,
      render: () => (
        <VStack gap={1}>
          {/* no BookTotals line here: it repeated the T row from the slower book poll, so the two disagreed */}
          <GreekPanels view={v} units={viewer.units} />
        </VStack>
      ),
    },
    ...(book === null ? [] : [{ id: 'payoff', title: 'Payoff chart', minW: 3, minH: 4, render: () => <SizedPayoff book={book} /> }]),
    { id: 'neutralize', title: 'To Neutralize', minW: 2, minH: 4, render: () => <NeutralizeBlock view={v} /> },
    { id: 'margin', title: 'Margin', minW: 2, minH: 4, render: () => <MarginBox margin={m} error={margin.error} /> },
    // the P&L block reads the live frame the strip reads: one snapshot on the screen
    {
      id: 'mtm', title: 'P&L', minW: 3, minH: 4,
      render: () => <PnlBlock mtm={v.mtm} series={seriesOf(v)} fresh={liveFrameOf(live)} shares={v.monthWise.some((mo) => mo.expiry === '')} />,
    },
    { id: 'gap', title: 'Gap Up Down', minW: 3, minH: 4, render: () => <GapPanel panel={v.gapPanel} state={inputs} onChange={patch} onCalculate={calculate} /> },
    { id: 'scenario', title: 'Scenario', minW: 6, minH: 8, render: () => <ScenarioTab stock={stock} /> },
    ...(book === null ? [] : [{ id: 'advice', title: 'Advice', minW: 4, minH: 6, render: () => <AdviceTab stock={stock} view={book} /> }]),
    { id: 'context', title: 'Market context', minW: 4, minH: 8, render: () => <MarketContextBlock stock={stock} /> },
  ]

  return (
    <VStack gap={1} data-layout-editable="true">
      <ControlRow view={v} inputs={inputs} patch={patch} online={online} setOnline={setLive} calculate={calculate}
        editing={editing} setEditing={setEditing} />
      <BellAlert text={analysis.error === null ? null : `Refresh failed: ${analysis.error}`} />
      <Caveats items={v.warnings} kind="warning" />
      <Dashboard label={`${stock} analysis`} page="book" blocks={blocks} defaults={ANALYSIS_LAYOUT}
        fitH={{ legs: legsPx === null ? legsRows(v.legs.length, v.unmatched.length) : rowsForPx(legsPx) }} editing={editing} onDone={() => setEditing(false)} />
      {actions.dialogs}
    </VStack>
  )
}

/** The book without its analysis: the book's own legs table and actions, the payoff chart, the totals, margin. */
function BookOnly(props: {
  readonly stock: string; readonly book: BookView; readonly margin: MarginView | null; readonly marginError: string | null
  readonly actions: ReturnType<typeof useLegActions>; readonly closedInline: boolean
}): ReactElement {
  const { book, actions } = props
  const blocks: DashBlock[] = [
    {
      id: 'legs', title: 'Legs', minW: 6, minH: 4,
      render: () => (
        <VStack gap={1}>
          <HStack gap={2} align="center" justify="between" wrap="wrap">
            <Text size="sm" color="secondary">The analysis is not available — the book&apos;s own legs</Text>
            {actions.add}
          </HStack>
          <PlainLegTable view={book} actionsFor={actions.actionsFor} />
          <NotUnderstood lines={book.unmatched} />
        </VStack>
      ),
    },
    { id: 'greeks', title: 'Greeks', minW: 4, minH: 2, render: () => <Block name="Greeks"><BookTotals view={book} /></Block> },
    { id: 'payoff', title: 'Payoff chart', minW: 3, minH: 4, render: () => <PayoffChart view={book} /> },
    { id: 'margin', title: 'Margin', minW: 2, minH: 4, render: () => <MarginBox margin={props.margin} error={props.marginError} /> },
  ]
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center">
        <Text color="secondary" size="sm">{`as of ${istHm(book.asOf)} IST`}</Text>
        {props.closedInline ? <Text size="sm" color="secondary">Market closed — last session&apos;s prices</Text> : null}
      </HStack>
      <Dashboard label={`${props.stock} book`} page="book" blocks={blocks} defaults={ANALYSIS_LAYOUT}
        fitH={{ legs: legsRows(book.legs.length, book.unmatched.length) }} />
      {actions.dialogs}
    </VStack>
  )
}

/** A small label beside its value or control, on the control row. */
function Pair(props: { readonly label: string; readonly children: ReactNode; readonly info?: ReactNode }): ReactElement {
  return (
    <span className="traders-pair">
      <Text size="sm" color="secondary">{props.label}</Text>
      {props.info ?? null}
      {props.children}
    </span>
  )
}

/** What differs from the market, on the line itself: the vol shifts, a frozen future, updates switched off. */
function ActiveChanges(props: { readonly inputs: AnalysisInputs; readonly online: boolean }): ReactElement | null {
  const { inputs } = props
  const pct = (n: number): string => `${n > 0 ? '+' : ''}${n} %`
  const parts = [
    inputs.callVol === 0 ? null : `Call ${pct(inputs.callVol)}`,
    inputs.putVol === 0 ? null : `Put ${pct(inputs.putVol)}`,
    inputs.future === null ? null : `Future frozen ${inputs.future.toFixed(2)}`,
    props.online ? null : 'Updates off',
  ].filter((s): s is string => s !== null)
  if (parts.length === 0) return null
  return <span className="traders-active-changes" role="status" aria-label="Changed from the market">{parts.join(' · ')}</span>
}

/**
 * VolHedge's top strip as ONE line: the header figures (label: value) and the controls. `Cal ON` and `No of Day` are
 * not built: what they do is unknown (Phase 0 Q3).
 */
function ControlRow(props: {
  readonly view: AnalysisView; readonly inputs: AnalysisInputs; patch(p: Partial<AnalysisInputs>): void
  readonly online: boolean; setOnline(on: boolean): void; calculate(): void
  readonly editing: boolean; setEditing(on: boolean): void
}): ReactElement {
  const { view: v, inputs, patch } = props
  return (
    <HStack gap={1.5} align="center" wrap="wrap" className="traders-controls" role="group" aria-label="Analysis controls">
      <span className="traders-pair" role="group" aria-label="Expiry/Days/Rate1" title="Expiry/Days/Rate1">
        <Text size="sm" color="secondary">Exp/Days/Rate</Text>
        <Text size="sm" weight="bold">{v.nearExpiry === null ? '—' : maturityLabel(v.nearExpiry)}</Text>
        <Text size="sm" weight="bold" style={NUM}>{v.daysToExpiry === null ? '—' : String(v.daysToExpiry)}</Text>
        <Text size="sm" weight="bold" style={NUM}>{orDash(v.future, 2)}</Text>
      </span>
      <Pair label="Equity"><Text size="sm" weight="bold" style={NUM}>{orDash(v.spot, 2)}</Text></Pair>
      <Pair label="Lot Size"><Text size="sm" weight="bold" style={NUM}>{v.lotSize === null ? '—' : String(v.lotSize)}</Text></Pair>
      <Pair label="Price basis" info={<InfoTip label="Price basis">LTP is the only price basis for now</InfoTip>}>
        <Text size="sm" weight="bold">LTP</Text>
      </Pair>
      <ActiveChanges inputs={inputs} online={props.online} />
      <span className="traders-controls-end">
        <Popover label="Adjust the analysis" placement="below" alignment="end" content={
          <VStack gap={2} className="traders-adjust">
            <HStack gap={2} align="center">
              <Pair label="Call Vol %">
                <NumberInput label="Call Vol %" isLabelHidden size="sm" width={64} min={-VOL_SHIFT_LIMIT} max={VOL_SHIFT_LIMIT}
                  value={inputs.callVol} onChange={(n) => patch({ callVol: n })} />
              </Pair>
              <Pair label="Put Vol %">
                <NumberInput label="Put Vol %" isLabelHidden size="sm" width={64} min={-VOL_SHIFT_LIMIT} max={VOL_SHIFT_LIMIT}
                  value={inputs.putVol} onChange={(n) => patch({ putVol: n })} />
              </Pair>
            </HStack>
            <HStack gap={2} align="center">
              <Pair label="Future">
                <NumberInput label="Future" isLabelHidden size="sm" width={92} min={0.01} hasClear
                  value={inputs.future} placeholder={v.future === null ? '—' : v.future.toFixed(2)} onChange={(n) => patch({ future: n })} />
              </Pair>
              {/* Stop holds the future on screen as the override; Start lets the live future through again. */}
              <Button size="sm" variant="secondary" label="Stop" isDisabled={inputs.future !== null || v.future === null}
                onClick={() => patch({ future: v.future })} />
              <Button size="sm" variant="secondary" label="Start Future Update" isDisabled={inputs.future === null}
                onClick={() => patch({ future: null })} />
            </HStack>
            <HStack gap={2} align="center">
              <Switch label="Online Update" value={props.online} onChange={props.setOnline} />
              <Button size="sm" variant="secondary" label="Calculate" tooltip="Alt+C" onClick={() => props.calculate()} />
              <Button size="sm" variant="ghost" label="Reset" isDisabled={inputs.callVol === 0 && inputs.putVol === 0 && inputs.future === null}
                onClick={() => patch({ callVol: 0, putVol: 0, future: null })} />
            </HStack>
          </VStack>
        }>
          <Button size="sm" variant="secondary" label="Adjust" tooltip="Vols, future, updates, Calculate" />
        </Popover>
        <Button size="sm" variant="ghost" label="Edit layout" tooltip="Move, resize, show or hide the blocks (e)"
          aria-pressed={props.editing} onClick={() => props.setEditing(!props.editing)} />
      </span>
    </HStack>
  )
}

const DELTA0_NOTE = 'The shares that make the book delta-neutral now (the book\'s net delta, sign flipped). Δ0 — the stock price where the book\'s delta is zero as it stands: spot − Δ/Γ, a gamma-constant estimate, accurate near spot (the desk\'s Δ0), with its distance from spot. The last line is that hedge in the nearest future\'s lots.'

/** VolHedge's left box: To Neutralize, time value and the breakeven range. */
function NeutralizeBlock(props: { readonly view: AnalysisView }): ReactElement {
  const { view: v } = props
  const n = v.toNeutralize
  return (
    <Block name="To Neutralize" info={{ about: 'To Neutralize', lines: [DELTA0_NOTE] }}>
      {/* the shares that make the book delta-neutral, then the stock price where it is neutral as it stands (Δ0) */}
      <HStack gap={1.5} align="center" wrap="wrap">
        <Text weight="bold" style={NUM}>{n === null ? '—' : `${n.units > 0 ? '+' : ''}${inr(n.units)}`}</Text>
        {n === null ? null : <Text size="sm" color="secondary">{n.units > 0 ? 'shares to buy' : n.units < 0 ? 'shares to sell' : 'shares'}</Text>}
      </HStack>
      <HStack gap={1.5} align="center" wrap="wrap">
        <Text size="sm" color="secondary">Δ0</Text>
        <Text size="sm" weight="bold" style={NUM}>{n === null || typeof n.price !== 'number' ? '—' : n.price.toFixed(2)}</Text>
        {n === null ? null : typeof n.pct !== 'number'
          ? <Text size="sm" color="secondary">(— %)</Text>
          : <Text size="sm" color="secondary" style={NUM}>{`(${n.pct >= 0 ? '+' : ''}${n.pct.toFixed(2)} %)`}</Text>}
      </HStack>
      <Text size="sm">{n === null ? '—' : n.text}</Text>
      <FigureList>
        <MetadataListItem label="TimeValue"><Num>{inr(v.bookTimeValue, 2)}</Num></MetadataListItem>
      </FigureList>
      <Text size="sm" style={NUM}>{v.breakevens.text}</Text>
    </Block>
  )
}

interface PnlRow { readonly id: string; readonly label: string; readonly n: number | null; readonly total: boolean }
type PnlTableRow = PnlRow & Record<string, unknown>

const negated = (n: number | null): number | null => (n === null ? null : -n)
const TODAY_ROWS: ReadonlySet<string> = new Set(['today', 'carried', 'trades', 'todayCharges'])
/** The server's notes on the MTM block's old rows: this block says it in its own rows and ⓘ, the day's reason under Today. */
const OLD_ROW_NOTES = ['Previous = ', 'Day MTM = ', 'Projected = ', 'Pay In Out = ', 'CF balance = ', 'Day MTM is not shown']

/**
 * The P&L block (spec 2026-10-23 R4): two bold totals, each with its parts under it, summing to it. P&L is the series
 * net since its first trade, after every charge; Today is the MTM block's total, the day's move after today's charges,
 * a part of P&L. Both come from the live frame when it carries them, as the strip's do, else from this view; Today's
 * parts too, from the frame's charges, or this view's from a server that sends none. Before the open or
 * on a closed day Today and its parts are "—" with the server's reason; the old server's (no `dayReason`) are on the
 * old basis: "—", "server update pending". An older server sends no series: then no P&L rows. An unknown value is "—".
 */
function PnlBlock(props: { readonly mtm: MtmBlock; readonly series: Series | null; readonly fresh: LiveFrame | null; readonly shares: boolean }): ReactElement {
  const { mtm: m, series: s } = props
  const f = frameToday(props.fresh)
  const charges = f === null ? null : f.charges ?? m.expense.total
  // carried + today's trades − today's charges = Today
  const day = m.dayReason === undefined
    ? { total: null, carried: null, trades: null, charges: null, why: SERVER_UPDATE_PENDING }
    : f !== null
      ? {
          total: f.total, why: f.why,
          carried: f.total === null || f.today === null ? null : f.total - f.today,
          trades: f.today === null || charges === null ? null : f.today + charges,
          charges: f.today === null ? null : charges,
        }
      : { total: m.current.total, carried: m.gross.previous, trades: m.gross.today, charges: m.expense.total, why: m.dayReason }
  const p = s === null ? null : pnlOf(s, props.fresh)
  const row = (id: string, label: string, n: number | null, total = false): PnlRow => ({ id, label, n, total })
  const rows: PnlRow[] = [
    ...(s === null || p === null ? [] : [
      row('pnl', `P&L (${sinceText(s.total.from)})`, p.net, true),
      row('booked', 'Booked on closed contracts', p.booked),
      row('open', 'Open legs at LTP', p.open),
      row('charges', `Charges${s.total.ratesConfirmed ? '' : ' (est.)'}`, -p.charges),
    ]),
    row('today', 'Today', day.total, true),
    row('carried', "Legs carried from yesterday's close", day.carried),
    row('trades', "Today's trades", day.trades),
    row('todayCharges', `Today's charges${m.ratesConfirmed ? '' : ' (est.)'}`, negated(day.charges)),
  ]
  const columns: TableColumn<PnlTableRow>[] = [
    {
      key: 'label', header: '',
      renderCell: (r) => {
        const x = r as PnlRow
        return x.total ? <Text size="sm" weight="bold">{x.label}</Text> : <Text size="sm" color="secondary" style={{ paddingLeft: '12px' }}>{x.label}</Text>
      },
    },
    {
      key: 'value', header: '₹', align: 'end',
      renderCell: (r) => {
        const x = r as PnlRow
        const num = <Text size="sm" {...(x.total ? { weight: 'bold' as const } : {})} style={{ ...NUM, ...(x.n === null ? {} : sign(x.n)) }}>{money(x.n)}</Text>
        // a dash the day has not begun for says so on hover
        return x.n === null && day.why !== null && TODAY_ROWS.has(x.id) ? <span title={day.why}>{num}</span> : num
      },
    },
  ]
  return (
    <Block name="P&L" info={{ about: 'P&L', lines: [...(s === null ? [] : seriesLines(s)), TODAY_ABOUT, ...(props.shares ? [SHARES_LINE] : [])] }}>
      <Caveats items={m.ratesConfirmed ? [] : [RATES_ESTIMATE]} kind="warning" />
      <TradersTable aria-label="P&L" data={rows as PnlTableRow[]} columns={columns} idKey="id" density="compact" />
      {day.total === null && day.why !== null ? <Text size="sm" color="secondary">{`Today is not shown — ${day.why}`}</Text> : null}
      {m.partial.length === 0 ? null : (
        <Text size="sm" color="secondary">{`Left out of Today (no close or no LTP): ${m.partial.join(', ')}`}</Text>
      )}
      <Caveats items={m.notes.filter((n) => !OLD_ROW_NOTES.some((o) => n.startsWith(o)))} kind="note" />
    </Block>
  )
}
