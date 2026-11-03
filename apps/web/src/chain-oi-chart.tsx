/**
 * Open interest by strike, for the selected expiry: calls and puts as two
 * columns side by side per strike, so the call walls (resistance) and put
 * walls (support) stand out. Inline SVG, no chart library.
 *
 *   - The index price is a solid vertical line with its value; max pain is a
 *     dashed one. Both are labelled at the top of the plot.
 *   - The top two strikes per side are drawn at full strength with their OI
 *     at the tip; every other column is drawn lighter. The same strikes carry
 *     the "1" / "2" badges in the table.
 *   - Hovering (or arrow-keying to) a strike highlights it here and its row in
 *     the table; hovering a table row highlights it here. The strike is held by
 *     the page, so both sides read one value.
 *
 * Colour follows the dataviz reference palette (blue / orange, validated for
 * lightness band, chroma, CVD and contrast in both modes); text is always in
 * text tokens, never the series colour. The table below is the chart's table
 * view: every value here is also there.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChainRowWire } from './api.ts'
import { compactNumber, niceCeil, type OiWalls } from './chain-model.ts'

const HEIGHT = 196
const M = { top: 34, right: 12, bottom: 24, left: 44 }
/** Bar cap from the mark spec: never fill the slot. */
const BAR_MAX = 24
/** The surface gap between the call and put column of one strike. */
const GAP = 2

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

/** The container's width, re-read on resize. jsdom has no ResizeObserver: a fixed width there. */
function useWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const next = Math.round(e?.contentRect.width ?? 0)
      if (next > 0) setW(next)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** Column path with a 4px rounded data-end and a square baseline. */
function column(x: number, y: number, w: number, base: number): string {
  const h = base - y
  if (h <= 0 || w <= 0) return ''
  const r = Math.min(4, w / 2, h)
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`
}

export function OiChart(props: {
  rows: readonly ChainRowWire[]
  spot: number | null
  maxPain: number | null
  walls: OiWalls
  hot: number | null
  onHot: (strike: number | null) => void
  locale: string
}): React.ReactElement {
  const { rows, spot, walls, hot } = props
  const [box, width] = useWidth(960)
  const plotW = Math.max(120, width - M.left - M.right)
  const plotH = HEIGHT - M.top - M.bottom
  const base = M.top + plotH
  const n = rows.length
  const slot = n > 0 ? plotW / n : plotW
  const barW = Math.max(1, Math.min(BAR_MAX, (slot - GAP) / 2 - 2))

  let max = 0
  for (const r of rows) {
    for (const v of [r.CE?.oi, r.PE?.oi]) if (finite(v) && v > max) max = v
  }
  const top = niceCeil(max)
  const y = (v: number): number => base - (v / top) * plotH
  const cx = (i: number): number => M.left + slot * (i + 0.5)

  /** The index price's x: between the two strikes it sits between, in proportion. */
  let spotX: number | null = null
  if (finite(spot) && n > 0) {
    const ks = rows.map((r) => r.strike)
    const first = ks[0] as number
    const last = ks[n - 1] as number
    if (n === 1 || spot <= first) spotX = spot === first || n === 1 ? cx(0) : M.left
    else if (spot >= last) spotX = spot === last ? cx(n - 1) : M.left + plotW
    else {
      let i = 0
      while (i < n - 1 && (ks[i + 1] as number) < spot) i++
      const lo = ks[i] as number
      const hi = ks[i + 1] as number
      spotX = cx(i) + ((spot - lo) / (hi - lo)) * slot
    }
  }
  const painI = props.maxPain === null ? -1 : rows.findIndex((r) => r.strike === props.maxPain)
  const painX = painI >= 0 ? cx(painI) : null
  const roomRight = (x: number): boolean => x < M.left + plotW - 110
  // Each label reads away from the other line, unless that runs off the plot.
  const spotRight = spotX === null ? true
    : painX === null ? roomRight(spotX)
    : (spotX >= painX ? roomRight(spotX) : !(spotX - M.left > 110))
  const painRight = painX === null ? true
    : spotX === null ? roomRight(painX)
    : (painX > spotX ? roomRight(painX) : !(painX - M.left > 110))

  /** A tip label needs its column pair to be at least ~30px wide. */
  const tips = slot >= 30
  // Label every k-th strike so labels sit at least ~64px apart.
  const every = Math.max(1, Math.ceil(64 / slot))
  const fmt = (v: number): string => v.toLocaleString(props.locale, { maximumFractionDigits: 2 })
  const ticks = [0, top / 2, top]

  const hotI = hot === null ? -1 : rows.findIndex((r) => r.strike === hot)
  const hotRow = hotI >= 0 ? rows[hotI] : undefined
  const hotCe = hotRow?.CE?.oi
  const hotPe = hotRow?.PE?.oi

  const onKey = (e: React.KeyboardEvent): void => {
    if (n === 0) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return
    e.preventDefault()
    if (e.key === 'Escape') { props.onHot(null); return }
    // The first key press lands on the strike nearest the index; later ones step.
    const atSpot = finite(spot) ? rows.findIndex((r) => r.strike >= spot) : 0
    const next = hotI < 0
      ? (atSpot < 0 ? n - 1 : atSpot)
      : Math.min(n - 1, Math.max(0, hotI + (e.key === 'ArrowRight' ? 1 : -1)))
    props.onHot(rows[next]?.strike ?? null)
  }

  return (
    <div className="chain-chart-box" ref={box}>
      <svg
        className="chain-chart"
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label="Open interest by strike, calls and puts. Use the left and right arrow keys to step through strikes."
        tabIndex={0}
        onKeyDown={onKey}
        onPointerLeave={() => props.onHot(null)}
        onBlur={() => props.onHot(null)}
      >
        {/* Recessive grid: hairline, solid, one step off the surface. */}
        {ticks.map((t) => (
          <g key={t}>
            <line className="chain-chart-grid" x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} />
            <text className="chain-chart-tick" x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
              {compactNumber(t)}
            </text>
          </g>
        ))}

        {hotI >= 0 ? (
          <rect className="chain-chart-hot" x={M.left + slot * hotI} y={M.top - 4} width={slot} height={plotH + 4} rx={4} />
        ) : null}

        {rows.map((r, i) => {
          const ce = r.CE?.oi
          const pe = r.PE?.oi
          const ceRank = walls.ce.indexOf(r.strike)
          const peRank = walls.pe.indexOf(r.strike)
          const x0 = cx(i) - GAP / 2 - barW
          const x1 = cx(i) + GAP / 2
          return (
            <g key={r.strike} data-strike={r.strike}>
              {finite(ce) && ce > 0 ? (
                <path
                  className={`chain-bar chain-bar-ce${ceRank >= 0 ? ' chain-bar-wall' : ''}`}
                  d={column(x0, y(ce), barW, base)}
                  data-strike={r.strike}
                />
              ) : null}
              {finite(pe) && pe > 0 ? (
                <path
                  className={`chain-bar chain-bar-pe${peRank >= 0 ? ' chain-bar-wall' : ''}`}
                  d={column(x1, y(pe), barW, base)}
                  data-strike={r.strike}
                />
              ) : null}
              {/* Selective direct labels: the walls only, value at the tip, and only
                  where a column is wide enough to carry one (else the tooltip does). */}
              {tips && ceRank >= 0 && finite(ce) ? (
                <text className="chain-chart-tip" x={x0 + barW / 2} y={y(ce) - 4} textAnchor="middle">{compactNumber(ce)}</text>
              ) : null}
              {tips && peRank >= 0 && finite(pe) ? (
                <text className="chain-chart-tip" x={x1 + barW / 2} y={y(pe) - 4} textAnchor="middle">{compactNumber(pe)}</text>
              ) : null}
              {i % every === 0 ? (
                <text
                  className={`chain-chart-x${ceRank >= 0 || peRank >= 0 ? ' chain-chart-x-wall' : ''}`}
                  x={cx(i)}
                  y={base + 15}
                  textAnchor="middle"
                >
                  {fmt(r.strike)}
                </text>
              ) : null}
            </g>
          )
        })}

        <line className="chain-chart-axis" x1={M.left} x2={M.left + plotW} y1={base} y2={base} />

        {/*
          Two labels at the top, on two lines and on opposite sides of their
          lines — the index on the first, max pain on the second, each placed
          away from the other line — so they never overprint when close.
        */}
        {painI >= 0 ? (
          <g className="chain-chart-pain">
            <line x1={cx(painI)} x2={cx(painI)} y1={M.top - 14} y2={base} />
            <text
              x={cx(painI) + (painRight ? 5 : -5)}
              y={M.top - 6}
              textAnchor={painRight ? 'start' : 'end'}
            >
              {`Max pain ${fmt(props.maxPain as number)}`}
            </text>
          </g>
        ) : null}

        {spotX !== null && finite(spot) ? (
          <g className="chain-chart-spot" data-testid="chart-spot">
            <line x1={spotX} x2={spotX} y1={M.top - 30} y2={base} />
            <text x={spotX + (spotRight ? 5 : -5)} y={M.top - 20} textAnchor={spotRight ? 'start' : 'end'}>
              {fmt(spot)}
            </text>
          </g>
        ) : null}

        {/* Hit targets: the whole strike slot, bigger than either column. */}
        {rows.map((r, i) => (
          <rect
            key={r.strike}
            className="chain-chart-hit"
            x={M.left + slot * i}
            y={M.top - 4}
            width={slot}
            height={plotH + 4}
            data-testid={`chart-slot-${r.strike}`}
            onPointerEnter={() => props.onHot(r.strike)}
          />
        ))}
      </svg>

      {hotRow !== undefined ? (
        <div
          className="chain-chart-tooltip"
          role="status"
          style={{
            left: Math.min(Math.max(cx(hotI), 80), width - 80),
            top: 2,
          }}
        >
          <span className="chain-chart-tooltip-k">{fmt(hotRow.strike)}</span>
          <span className="chain-chart-tooltip-row">
            <span className="chain-key chain-key-ce" aria-hidden="true" />
            <strong>{finite(hotCe) ? fmt(hotCe) : '·'}</strong>
            <span>call OI{walls.ce.indexOf(hotRow.strike) >= 0 ? `, wall ${walls.ce.indexOf(hotRow.strike) + 1}` : ''}</span>
          </span>
          <span className="chain-chart-tooltip-row">
            <span className="chain-key chain-key-pe" aria-hidden="true" />
            <strong>{finite(hotPe) ? fmt(hotPe) : '·'}</strong>
            <span>put OI{walls.pe.indexOf(hotRow.strike) >= 0 ? `, wall ${walls.pe.indexOf(hotRow.strike) + 1}` : ''}</span>
          </span>
        </div>
      ) : null}
    </div>
  )
}
