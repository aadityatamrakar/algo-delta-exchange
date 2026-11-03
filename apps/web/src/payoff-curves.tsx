/** The payoff chart and its helpers, moved out of payoff.tsx unchanged so the traders page can share them. */

import { useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { useTheme } from '@astryxdesign/core/theme'
import { VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { inr, inrCompact, money, sign } from './format.ts'
import type { PayoffPoint, PayoffView } from './api.ts'

/** A price, to the paisa like every price on this desk. */
export function price(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? inr(n, 2) : '—'
}

/**
 * `Midway 2026-08-25`, or a bare `Midway` when the date is missing. A legend
 * entry reading "Midway undefined" is worse than one that simply says less.
 */
function dated(name: string, date: string | undefined): string {
  return date === undefined || date === '' ? name : `${name} ${date}`
}

// -------------------------------------------------------------------- chart

/**
 * THE THREE CURVES, and why they are drawn the way they are.
 *
 * EXPIRY IS SOLID because it is the only one that carries no model: it is
 * intrinsic value, exactly, and it is the line a position is finally settled
 * against. T+0 and the midpoint are marks — Black-76 at the chain's own solved
 * vols — so they are dashed, and the midpoint is dashed thinner still: it is
 * the most interpolated thing on the chart (halfway to expiry, at today's vol)
 * and the eye should reach it last.
 *
 * COLOURS COME FROM `useTheme().token(...)`, never from `var(--x)` in an SVG
 * attribute: recharts writes `stroke` as a presentation attribute and a
 * browser does not resolve custom properties there. Same reasoning, same idiom
 * as `chart.tsx`. The trio is blue / orange / teal — separable under
 * red-green deficiency, and the dash patterns encode the same distinction a
 * second time for a greyscale screenshot.
 *
 * THE X AXIS IS THE FUTURE'S PRICE. Every option on this desk is marked
 * Black-76 off the traded future and the scan is built off it, so the vertical
 * "now" line is the future, not cash spot — the two differ by the carry, and a
 * line labelled `spot` on this axis would be a few rupees of quiet fiction.
 * Cash spot is drawn only when the future is not printing, and says so.
 *
 * ── AND A FOURTH, WHEN SOMEBODY IS ASKING A QUESTION ────────────────────────
 *
 * The what-if overlay adds the combined book's EXPIRY column in purple, solid
 * like the line it is meant to be compared against — the two curves are the
 * same quantity on two books, and drawing one of them dashed would read as "and
 * this one is modelled". Only expiry: three more marked curves on one plot is a
 * six-line chart nobody reads, and the decision an overlay is for ("does this
 * lift the floor") is an expiry-column decision.
 */
export function PayoffCurves(props: {
  view: PayoffView
  /** The price the scan was built around: the future, or spot as a fallback. */
  markAt: number | null
  markLabel: string
  expiryDate: string
  /** The combined book's scan, or null when nothing is proposed. */
  overlay: readonly PayoffPoint[] | null
  /** The plot's height in px (the legend sits under it); 300 unless a smaller panel asks. */
  height?: number
}): React.ReactElement {
  const { token } = useTheme()
  const atExpiry = token('--color-data-categorical-blue')
  const today = token('--color-data-categorical-orange')
  const midway = token('--color-data-categorical-teal')
  const target = token('--color-data-categorical-green')
  const proposed = token('--color-data-categorical-purple')
  const axis = token('--color-text-secondary')
  const grid = token('--color-border')
  const surface = token('--color-background-popover')
  const ink = token('--color-text-primary')

  /**
   * WHICH LINES ARE HIDDEN — the legend is the switchboard. Four curves share
   * one plot, and the question an operator brings is usually about ONE of them
   * ("where does today's mark cross zero"); clicking a legend entry takes the
   * others off rather than making the reader untangle them. NOT persisted: a
   * hidden line is a reading posture, not a setting, and a panel that reopens
   * with T+0 quietly missing would read as a bridge that stopped serving it.
   *
   * T+0 AND MIDWAY SHIP HIDDEN. The decision this chart is for — where the
   * expiry payoff sits, and what a plan does to it — is an expiry-column
   * decision; the two marked curves are one click away when the question is
   * about today's mark, and four lines by default is most of the way to the
   * six-line chart the overlay comment below refuses to draw.
   */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(['t0', 'mid']))
  const toggleLine = (key: string): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // `?? []` on the ARRAY, not `?.` on its length: a bridge one deploy behind
  // can answer without `curve` at all, and `undefined.length` throws during a
  // render that would otherwise have printed a sentence.
  const curve = props.view.curve ?? []
  if (curve.length === 0) {
    return (
      <Text color="secondary" size="sm">
        The scan came back empty — there is nothing to plot. The warnings below say why.
      </Text>
    )
  }

  /**
   * THE TARGET LINE IS DRAWN ONLY WHERE IT WOULD LAND ON THE CHART.
   *
   * A relief book's flatten target is ₹1.5L against a scan whose best point is
   * ₹18k, which is the ordinary case rather than an odd one — the target is
   * reached by TIME, as the shorts decay, not by the underlying moving 10%. A
   * reference line outside the y-domain is silently discarded by recharts, and
   * forcing the axis to reach it (`ifOverflow="extendDomain"`) would squash the
   * whole payoff into a band at the bottom of the plot to make room for an
   * empty two-thirds. So it is drawn when it is on the scan, and SAID in words
   * when it is not — the summary tile carries the figure either way.
   */
  // `?.` on a field the type says is always there, for the same reason the
  // arrays above get `?? []`: the type describes the CURRENT bridge.
  const targetPnl = props.view.summary?.targetPnl ?? null
  let lo = Infinity
  let hi = -Infinity
  for (const p of curve) {
    for (const v of [p.expiry, p.t0, p.mid]) {
      if (!Number.isFinite(v)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  const targetOnScan = targetPnl !== null && targetPnl >= lo && targetPnl <= hi

  /**
   * THE OVERLAY IS RESAMPLED ONTO THIS CHART'S OWN GRID, and that is a
   * correctness fix rather than a convenience.
   *
   * Both scans are 121 points across ±10% of the future — but they are answers
   * to two requests made a moment apart, and `whatif` re-assembles the book,
   * so its grid is centred on whatever the future was when the button was
   * pressed. A rupee of drift moves every rung by a rupee, which is more than
   * the 0.74 that separates two of them: matching by price would find nothing
   * and matching by index would draw the combined curve shifted a whole step
   * sideways, on a chart whose breakevens are read off the x axis.
   *
   * Linear interpolation is EXACT here away from a strike, because an expiry
   * payoff is piecewise-linear in the underlying by construction (it is
   * intrinsic value, no model). The residual is the same one the repair menu
   * already documents: a kink that falls between two rungs is flattered by up
   * to the rung spacing. Nothing is extrapolated — outside the overlay's own
   * range the line simply stops.
   */
  const overlay = props.overlay ?? []
  const data =
    overlay.length === 0
      ? [...curve]
      : curve.map((p) => ({ ...p, combined: sampleAt(overlay, p.price) }))

  return (
    /* A fragment, not another stack: the panel's own `VStack gap` already
       spaces the plot from the sentence under it, and one more wrapper here
       would be a box drawn around nothing. */
    <>
      <VStack height={props.height ?? 300} width="100%">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={grid} vertical={false} />
            <XAxis
              dataKey="price"
              type="number"
              domain={['dataMin', 'dataMax']}
              stroke={axis}
              tick={{ fill: axis, fontSize: 11 }}
              tickLine={false}
              // Whole rupees on the axis: 121 points across ±10% of a 445 future
              // are 0.74 apart, and the paisa belong in the tooltip.
              tickFormatter={(v: number) => inr(v, 0)}
            />
            <YAxis
              stroke={axis}
              tick={{ fill: axis, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={72}
              // Lakhs and crores — a floor is seven digits of Indian grouping and
              // reads as noise down an axis.
              tickFormatter={(v: number) => inrCompact(v)}
            />
            {/* Break-even, so a curve below it reads as a loss without arithmetic. */}
            <ReferenceLine y={0} stroke={grid} />
            {targetPnl === null || !targetOnScan ? null : (
              /* The level the engine flattens the whole book at and banks it. */
              <ReferenceLine
                y={targetPnl}
                stroke={target}
                strokeDasharray="6 4"
                label={{ value: `target ${inrCompact(targetPnl)}`, position: 'insideTopRight', fill: axis, fontSize: 11 }}
              />
            )}
            {props.markAt === null ? null : (
              <ReferenceLine
                x={props.markAt}
                stroke={axis}
                strokeDasharray="3 3"
                label={{ value: props.markLabel, position: 'insideTopLeft', fill: axis, fontSize: 11 }}
              />
            )}
            <Tooltip
              contentStyle={{ background: surface, border: `1px solid ${grid}`, borderRadius: 6, color: ink }}
              labelStyle={{ color: axis }}
              itemStyle={{ color: ink }}
              labelFormatter={(v) => `at ${price(Number(v))}`}
              formatter={(v: unknown, name: unknown) => [
                // A point that could not be marked says so. "0" is a different fact.
                typeof v === 'number' ? money(v) : 'could not be marked',
                typeof name === 'string' ? name : '',
              ]}
            />
            {/*
              THE LEGEND IS THE SWITCHBOARD — real buttons, not recharts' own
              spans: a control has to be reachable by keyboard and say its state
              (`aria-pressed`), and the library's legend items are neither.
              recharts still supplies the payload (names, colours, dash
              patterns), so the swatches cannot drift from the lines they name.
            */}
            <Legend
              content={({ payload }) => (
                <LegendToggles payload={payload} hidden={hidden} onToggle={toggleLine} />
              )}
            />
            {/* `connectNulls` off, like every line on this desk: a missing point
                is a gap, and drawing through it invents a number. */}
            <Line
              type="monotone" dataKey="expiry" name={dated('Expiry', props.expiryDate)} stroke={atExpiry}
              strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}
              hide={hidden.has('expiry')}
            />
            <Line
              type="monotone" dataKey="t0" name="T+0 (today)" stroke={today}
              strokeWidth={2} strokeDasharray="6 3" dot={false} connectNulls={false} isAnimationActive={false}
              hide={hidden.has('t0')}
            />
            <Line
              type="monotone" dataKey="mid" name={dated('Midway', props.view.midDate)} stroke={midway}
              strokeWidth={1.5} strokeDasharray="2 4" dot={false} connectNulls={false} isAnimationActive={false}
              hide={hidden.has('mid')}
            />
            {overlay.length === 0 ? null : (
              <Line
                type="monotone" dataKey="combined" name="Expiry, if placed" stroke={proposed}
                strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}
                hide={hidden.has('combined')}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </VStack>
      {targetPnl === null || targetOnScan ? null : (
        <Text size="xsm" color="secondary">
          The {money(targetPnl)} flatten target is off this chart: no price on the ±10% scan reaches
          it on any of the three dates. It is reached by decay, not by the underlying moving.
        </Text>
      )}
    </>
  )
}

/**
 * The chart's legend as TOGGLE BUTTONS — click a series to take its line off,
 * click again to bring it back. Hidden is not gone: recharts keeps the entry in
 * the payload, the swatch keeps its colour and dash (they come from the Line's
 * own props, so they cannot drift from the plot), and the name takes a
 * strike-through — a hidden line reads as "hidden by you", never "not served".
 */
function LegendToggles(props: {
  payload?: readonly {
    value?: unknown
    color?: string | undefined
    dataKey?: unknown
    payload?: { strokeDasharray?: string | number | undefined } | undefined
  }[] | undefined
  hidden: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactElement | null {
  const entries = props.payload ?? []
  if (entries.length === 0) return null
  return (
    <div className="chart-legend">
      {entries.map((e) => {
        const key = typeof e.dataKey === 'string' ? e.dataKey : String(e.value ?? '')
        const name = String(e.value ?? key)
        const off = props.hidden.has(key)
        return (
          <button
            key={key}
            type="button"
            className={off ? 'chart-legend-item chart-legend-item-off' : 'chart-legend-item'}
            /* Pressed = drawn: the button asserts the line, not the hiding. */
            aria-pressed={!off}
            title={off ? `Show the "${name}" line` : `Hide the "${name}" line`}
            onClick={() => props.onToggle(key)}
          >
            <svg width={18} height={4} aria-hidden="true">
              <line
                x1={0} y1={2} x2={18} y2={2}
                stroke={e.color ?? 'currentColor'} strokeWidth={2.5}
                {...(e.payload?.strokeDasharray === undefined
                  ? {}
                  : { strokeDasharray: e.payload.strokeDasharray })}
              />
            </svg>
            <span>{name}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The overlay curve's EXPIRY value at one price of the base curve's grid,
 * linearly between the two rungs that bracket it — see the block comment above
 * the call for why interpolation is the honest answer here and index-matching
 * is not.
 *
 * `null` outside the overlay's own range, and `null` for a point either
 * neighbour could not be marked on: this line stops where its evidence does.
 * The scan is ascending in price by construction (`buildPayoffView`).
 */
function sampleAt(curve: readonly PayoffPoint[], at: number): number | null {
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (first === undefined || last === undefined) return null
  if (!Number.isFinite(at) || at < first.price || at > last.price) return null
  for (let i = 1; i < curve.length; i += 1) {
    const a = curve[i - 1]
    const b = curve[i]
    if (a === undefined || b === undefined || at > b.price) continue
    if (!Number.isFinite(a.expiry) || !Number.isFinite(b.expiry)) return null
    const span = b.price - a.price
    // Two rungs at one price is a degenerate scan, not a division to attempt.
    if (!(span > 0)) return a.expiry
    return a.expiry + ((at - a.price) / span) * (b.expiry - a.expiry)
  }
  return null
}

