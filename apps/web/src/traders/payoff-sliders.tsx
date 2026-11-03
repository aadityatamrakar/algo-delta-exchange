/**
 * Sensibull's payoff chart for the Scenario tab: the book's P&L against the
 * underlying on a target date and at expiry, a slider for each of the two
 * inputs that move it (the target date, the overall IV shift), and the P&L
 * table under it. Read-only analytics; nothing here is stored or sent as an
 * order.
 *
 * The IV slider is the Scenario tab's `Vol` input seen another way: both patch
 * `volShift`, so there is one state. The tab passes what the viewer has set
 * (`target`, `volShift`) and the thumbs show it at once; before the viewer has
 * set one they show the server's `resolved` value. The tab debounces the
 * request (300 ms), not the thumbs.
 *
 * The chart copies the desk chart's idioms (theme tokens for colour, no
 * animation, a gap where a point is missing) and imports none of it: that one
 * draws three fixed dates and stays as it is. The chart's values — so its axis
 * and tooltip — and the table's are in the chosen units, through one scaler.
 */

import { useMemo, type ReactElement } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Slider } from '@astryxdesign/core/Slider'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { useTheme } from '@astryxdesign/core/theme'
import { inr, inrCompact, money, sign } from '../format.ts'
import type { ScenarioView } from '../../../traders/src/analytics/wire.ts'
import { scaleBook } from './units.tsx'
import { useUnits } from './viewer.ts'
import { TradersTable } from './table.tsx'

/** The IV slider's reach, in vol points either side of the book's own vols. */
const IV_LIMIT = 20
const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const dayMs = (d: string): number => {
  const m = DATE.exec(d)
  return m === null ? NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}
const daysBetween = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS)
const addDays = (d: string, n: number): string => new Date(dayMs(d) + n * DAY_MS).toISOString().slice(0, 10)

/** `2026-10-24` → `24 Oct`; anything else is shown as it came. */
function dm(d: string): string {
  const m = DATE.exec(d)
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1]
  return m === null || month === undefined ? d : `${Number(m[3])} ${month}`
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi)
const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback)

interface Props {
  readonly view: ScenarioView
  /** The IST day of the answer: the date slider starts here. */
  readonly today: string
  /** What the viewer has set, if anything; the thumbs show it ahead of the server's resolved value. */
  readonly target?: string | null
  readonly volShift?: number | null
  readonly onTarget: (date: string) => void
  readonly onVolShift: (pts: number) => void
}

type Row = ScenarioView['table'][number]
type RowOf = Row & Record<string, unknown>

export function PayoffSliders(props: Props): ReactElement {
  const { view: v, today, target, volShift, onTarget, onVolShift } = props
  const { units } = useUnits()
  const { token } = useTheme()
  const targetColour = token('--color-data-categorical-orange')
  const expiryColour = token('--color-data-categorical-blue')
  const axis = token('--color-text-secondary')
  const grid = token('--color-border')
  const surface = token('--color-background-popover')
  const ink = token('--color-text-primary')

  const maxDay = Math.max(0, finite(daysBetween(today, v.lastExpiry), 0))
  const dayOf = (d: string): number => clamp(finite(daysBetween(today, d), 0), 0, maxDay)
  const day = dayOf(target ?? v.resolved.targetDate)
  const vol = volShift ?? v.resolved.volShift

  const { chart, lotSize, lotGcd } = v
  const scale = (n: number): number => scaleBook(n, units, lotSize, lotGcd)
  const points = useMemo(() => chart.points.filter((p) => Number.isFinite(p.price)).map((p) => ({
    price: p.price, target: scaleBook(p.target, units, lotSize, lotGcd), expiry: scaleBook(p.expiry, units, lotSize, lotGcd),
  })), [chart.points, units, lotSize, lotGcd])
  const targetName = `Target ${dm(chart.targetDate)}`
  const expiryName = `Expiry ${dm(chart.expiryDate)}`

  const num = (n: number): string => (Number.isFinite(n) ? money(scale(n)) : '—')
  const columns: TableColumn<RowOf>[] = [
    { key: 'price', header: 'Price', align: 'end', renderCell: (r) => <Text size="sm">{inr(r.price, 2)}</Text> },
    { key: 'label', header: 'Label', renderCell: (r) => <Text size="sm">{r.label}</Text> },
    ...(['target', 'expiry'] as const).map((k): TableColumn<RowOf> => ({
      key: k, align: 'end',
      header: k === 'target' ? `P&L on ${dm(chart.targetDate)}` : `P&L at expiry ${dm(chart.expiryDate)}`,
      renderCell: (r) => <Text size="sm" style={sign(r[k])}>{num(r[k])}</Text>,
    })),
  ]
  const rows = v.table.map((r, i): RowOf => ({ ...r, id: `${i}:${r.label}` }))

  return (
    <VStack gap={3}>
      <HStack gap={4} wrap="wrap" align="end">
        <Slider label="Target date" min={0} max={Math.max(1, maxDay)} step={1} width={280} isDisabled={maxDay === 0}
          value={day} formatValue={(n: number) => dm(addDays(today, n))}
          onChange={(n: number) => onTarget(addDays(today, n))} />
        <Slider label="IV shift" min={-IV_LIMIT} max={IV_LIMIT} step={1} width={280}
          value={clamp(finite(vol, 0), -IV_LIMIT, IV_LIMIT)} formatValue={(n: number) => `${n > 0 ? '+' : ''}${n} vol`}
          onChange={(n: number) => onVolShift(n)} />
      </HStack>
      {points.length === 0 ? <Text color="secondary" size="sm">No payoff to draw for this book.</Text> : (
        <VStack height={300} width="100%">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid stroke={grid} vertical={false} />
              <XAxis dataKey="price" type="number" domain={['dataMin', 'dataMax']} stroke={axis} tick={{ fill: axis, fontSize: 11 }}
                tickLine={false} tickFormatter={(x: number) => inr(x, 0)} />
              <YAxis stroke={axis} tick={{ fill: axis, fontSize: 11 }} tickLine={false} axisLine={false} width={72}
                tickFormatter={(y: number) => inrCompact(y)} />
              <ReferenceLine y={0} stroke={grid} />
              {Number.isFinite(chart.spot) ? (
                <ReferenceLine x={chart.spot} stroke={axis} strokeDasharray="3 3"
                  label={{ value: `spot ${inr(chart.spot, 2)}`, position: 'insideTopLeft', fill: axis, fontSize: 11 }} />
              ) : null}
              <Tooltip contentStyle={{ background: surface, border: `1px solid ${grid}`, borderRadius: 6, color: ink }}
                labelStyle={{ color: axis }} itemStyle={{ color: ink }}
                labelFormatter={(x) => `at ${inr(Number(x), 2)}`}
                formatter={(y: unknown, name: unknown) => [typeof y === 'number' ? money(y) : '—', typeof name === 'string' ? name : '']} />
              <Legend />
              <Line type="monotone" dataKey="target" name={targetName} stroke={targetColour} strokeWidth={2} strokeDasharray="6 3"
                dot={false} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="expiry" name={expiryName} stroke={expiryColour} strokeWidth={2}
                dot={false} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </VStack>
      )}
      {rows.length === 0 ? null : (
        <TradersTable aria-label="Sensibull payoff table" data={rows} columns={columns} idKey="id" density="compact" />
      )}
    </VStack>
  )
}
