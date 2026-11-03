/**
 * The two P&L charts: intraday (one day, by the minute) on the per-strategy
 * page, and daily (one strategy, across a date range) on the reports page.
 *
 * COLOURS COME FROM `useTheme().token(...)`, not from CSS custom properties in
 * SVG attributes: recharts writes `stroke`/`fill` as presentation attributes,
 * and a `var(--x)` in an attribute is not resolved by the browser. `token()`
 * returns the concrete value for the ACTIVE mode, so the chart re-colours with
 * the light/dark switch instead of staying legible in only one of them.
 *
 * The two series are blue (total) and orange (realised) — a pair checked for
 * lightness, chroma and colour-vision separation against both the light and the
 * dark card surface, rather than picked by eye.
 *
 * A NULL POINT IS A GAP, NOT A ZERO. `connectNulls` stays off: when the marks
 * were missing the line stops, because drawing straight through the hole would
 * invent a number the desk never computed.
 */

import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useTheme } from '@astryxdesign/core/theme'
import { VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { istDayLabel, istTime, money, smoothSeries, type PnlPoint, type ReportRow } from './api.ts'

export function IntradayPnlChart(props: {
  points: readonly PnlPoint[]
  /** Shown instead of the plot when there is nothing to draw. */
  emptyNote: string
}): React.ReactElement {
  const { token } = useTheme()
  const total = token('--color-data-categorical-blue')
  const realised = token('--color-data-orange-4')
  const axis = token('--color-text-secondary')
  const grid = token('--color-border')
  const surface = token('--color-background-popover')
  const ink = token('--color-text-primary')

  if (props.points.length === 0) {
    return <Text color="secondary" size="sm">{props.emptyNote}</Text>
  }

  /*
    SMOOTHED TO ONE POINT A MINUTE — see `smoothSeries`.

    Snapshots land every ~15s, so a session is ~1,500 points in a few hundred
    pixels: a band of vertical hair that hides the very shape it is drawn to
    show. Averaging within the minute keeps every level the book actually held
    while letting the trend, the drawdown and the turn be seen.

    The latest point is passed through un-averaged, so the right-hand end of the
    line always equals the MTM figure on the tiles beside it.
  */
  const data = smoothSeries(props.points).map((p) => ({
    ts: p.ts, total: p.total, realised: p.realised,
  }))

  return (
    <VStack gap={2} height={280} width="100%">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={grid} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => istTime(v)}
            stroke={axis}
            tick={{ fill: axis, fontSize: 11 }}
            tickLine={false}
          />
          <YAxis
            stroke={axis}
            tick={{ fill: axis, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={(v: number) => money(v)}
          />
          {/* Break-even, so a line below it reads as a loss without arithmetic. */}
          <ReferenceLine y={0} stroke={grid} />
          <Tooltip
            contentStyle={{ background: surface, border: `1px solid ${grid}`, borderRadius: 6, color: ink }}
            labelStyle={{ color: axis }}
            itemStyle={{ color: ink }}
            labelFormatter={(v) => `${istTime(Number(v))} IST`}
            // A missing point says so in words. "0" would be a different fact.
            formatter={(v: unknown, name: unknown) => [
              typeof v === 'number' ? money(v) : 'could not be marked',
              typeof name === 'string' ? name : '',
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: axis }} />
          <Line
            type="monotone" dataKey="total" name="Total" stroke={total}
            strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}
          />
          <Line
            type="monotone" dataKey="realised" name="Realised" stroke={realised}
            strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </VStack>
  )
}

/**
 * ONE STRATEGY'S DAILY P&L across a date range — the reports page's chart.
 *
 * A BAR PER DAY, NOT A CUMULATIVE LINE. An equity curve has to stop at the
 * first day that could not be marked, because everything after it is built on
 * a number we do not have; bars carry no such dependency, so one unmarked day
 * costs one bar rather than the rest of the quarter.
 *
 * POLARITY IS ENCODED TWICE: the bar sits above or below the zero reference
 * line, AND it is tinted green or red. Position is what makes it readable for a
 * red-green-deficient reader and in a greyscale screenshot; the tint is the
 * reinforcement, never the only signal. Green/red rather than a cooler pair
 * because profit-green and loss-red are already what every figure on this
 * dashboard means, and one chart disagreeing would be worse than the hazard.
 *
 * There is no legend: a single series is named by the card it sits in, and a
 * legend box for it would be a label pointing at the only thing on screen.
 *
 * A DAY WITH NO ROLLUP IS NOT IN `rows` AT ALL, and a day whose total is null
 * draws no bar. Neither is zero-filled — the caller states how many days are
 * missing in words, because a flat day and a day we have no record of look
 * identical once they are both a gap.
 */
export function DailyPnlChart(props: {
  /** A day and its total — one tag's rollup or a series' summed day alike. */
  rows: readonly Pick<ReportRow, 'date' | 'total'>[]
  emptyNote: string
}): React.ReactElement {
  const { token } = useTheme()
  const up = token('--color-data-categorical-green')
  const down = token('--color-data-categorical-red')
  const axis = token('--color-text-secondary')
  const grid = token('--color-border')
  const surface = token('--color-background-popover')
  const ink = token('--color-text-primary')

  if (props.rows.length === 0) {
    return <Text color="secondary" size="sm">{props.emptyNote}</Text>
  }

  const data = props.rows.map((r) => ({ date: r.date, total: r.total }))

  return (
    <VStack gap={2} height={280} width="100%">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={grid} vertical={false} />
          <XAxis
            dataKey="date"
            stroke={axis}
            tick={{ fill: axis, fontSize: 11 }}
            tickLine={false}
            // A quarter is ~65 trading days; without a gap the labels overlap
            // into an unreadable smear rather than being dropped.
            minTickGap={28}
            tickFormatter={(v: string) => istDayLabel(v)}
          />
          <YAxis
            stroke={axis}
            tick={{ fill: axis, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={(v: number) => money(v)}
          />
          {/* The baseline the sign is read from — the redundant encoding. */}
          <ReferenceLine y={0} stroke={axis} />
          <Tooltip
            cursor={{ fill: grid }}
            contentStyle={{ background: surface, border: `1px solid ${grid}`, borderRadius: 6, color: ink }}
            labelStyle={{ color: axis }}
            itemStyle={{ color: ink }}
            labelFormatter={(v) => `${istDayLabel(String(v))} IST`}
            formatter={(v: unknown) => [
              typeof v === 'number' ? money(v) : 'could not be marked',
              'Day total',
            ]}
          />
          <Bar dataKey="total" name="Day total" isAnimationActive={false} radius={[2, 2, 0, 0]}>
            {data.map((d) => (
              <Cell key={d.date} fill={d.total !== null && d.total < 0 ? down : up} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </VStack>
  )
}
