/**
 * THE OPTION CHAIN PAGE (operator, 3 Nov; redesigned the same day).
 *
 *   - Header strip: the index price large, its move since the page opened, the
 *     selected expiry with a live countdown to the 17:30 IST settlement and
 *     DTE, the ATM straddle, ATM IV, PCR and max pain.
 *   - Expiry pills on one row, grouped Daily / Weekly / Monthly.
 *   - Calls | strike | puts. ITM shaded (calls below the index, puts above),
 *     a spot line drawn between the two strikes the index sits between, OI
 *     bars growing outward, IV on a heat ramp, bid green / ask red / mark bold,
 *     far strikes dimmed, and a cell that changes flashes green up / red down.
 *
 * READ-ONLY. It reads `GET /v1/desk/chain/:symbol?expiry=` and
 * `GET /v1/desk/chain/:symbol/expiries`, polled — nothing here places or
 * prepares an order.
 *
 * EVERY FIELD PAST bid/ask IS OPTIONAL on the wire (only the DX feed sends
 * mark, sizes, IV, OI and greeks). Absent renders as a muted "·", never as 0:
 * a strike with no OI reported and a strike with zero OI are different facts.
 *
 * PERFORMANCE: the chain is re-read every 2 s over ~40 rows. Each row is
 * memoised on its own figures plus a handful of precomputed integers (OI bar
 * width, IV heat step), so a poll repaints only the rows whose quotes moved.
 * The countdown and the stale check tick once a second in their own small
 * components, so the table never re-renders on the clock.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { api, type ChainRowWire, type ChainSide } from './api.ts'
import { asOf, usePoll } from './shell.tsx'
import { VENUE } from './venue.ts'
import {
  atmIv, atmStraddle, atmStrike, expiryLabel, expiryPillLabel, daysToExpiry, formatCountdown,
  groupExpiries, heatStep, indexChange, isFar, itmSides, maxPain, oiWalls, putCallRatio, settlesAt,
  spotLineIndex, wallRank, type OiWalls,
} from './chain-model.ts'
import { OiChart } from './chain-oi-chart.tsx'
import './chain.css'

export { atmStrike, expiryClass } from './chain-model.ts'
export type { ExpiryClass } from './chain-model.ts'

/** How often the chain is re-read. The api's quote cache is fed by the tick stream. */
const CHAIN_POLL_MS = 2000
const EXPIRIES_POLL_MS = 60_000
/** The index price older than this raises the stale banner. */
export const SPOT_STALE_MS = 10_000

const LOCALE = VENUE.currency === 'USD' ? 'en-US' : 'en-IN'

/** The muted mark for a figure the feed did not send. */
export const MISSING = '·'

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

function fixed(v: number | null | undefined, digits: number): string {
  if (!finite(v)) return MISSING
  // A value that rounds to zero prints as 0.00, not -0.00 (a deep put's delta).
  const shown = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v
  return shown.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function upTo(v: number | null | undefined, digits: number): string {
  return finite(v) ? v.toLocaleString(LOCALE, { maximumFractionDigits: digits }) : MISSING
}

function pct(v: number | null | undefined): string {
  return finite(v) ? `${(v * 100).toFixed(1)}%` : MISSING
}

function oiText(v: number | null | undefined): string {
  if (!finite(v)) return MISSING
  return v.toLocaleString(LOCALE, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 })
}

// ---------------------------------------------------------------- columns

type ColKey = 'oi' | 'vega' | 'theta' | 'gamma' | 'delta' | 'iv' | 'bid' | 'mark' | 'ask'

interface Col {
  readonly label: string
  readonly title: string
  readonly text: (s: ChainSide) => string
  readonly value: (s: ChainSide) => number | null | undefined
}

const COLS: Record<ColKey, Col> = {
  oi: { label: 'OI', title: 'Open interest', text: (s) => oiText(s.oi), value: (s) => s.oi },
  vega: { label: 'Vega', title: 'Vega', text: (s) => fixed(s.vega, 2), value: (s) => s.vega },
  theta: { label: 'Theta', title: 'Theta', text: (s) => fixed(s.theta, 2), value: (s) => s.theta },
  gamma: { label: 'Gamma', title: 'Gamma', text: (s) => upTo(s.gamma, 6), value: (s) => s.gamma },
  delta: { label: 'Delta', title: 'Delta', text: (s) => fixed(s.delta, 2), value: (s) => s.delta },
  iv: { label: 'IV', title: 'Mark implied volatility', text: (s) => pct(s.iv), value: (s) => s.iv },
  bid: { label: 'Bid', title: 'Best bid', text: (s) => fixed(s.bid, 2), value: (s) => s.bid },
  mark: { label: 'Mark', title: 'Exchange mark price', text: (s) => fixed(s.mark, 2), value: (s) => s.mark },
  ask: { label: 'Ask', title: 'Best ask', text: (s) => fixed(s.ask, 2), value: (s) => s.ask },
}

export type Density = 'compact' | 'full'

/**
 * The CALL side's columns, left to right, OI outermost. The put side mirrors
 * everything except bid / mark / ask, which read the same way on both sides —
 * a trader looks for the bid left of the ask, whichever side it is on.
 */
export function callColumns(density: Density, greeks: boolean): ColKey[] {
  const g: ColKey[] = greeks ? ['vega', 'theta', 'gamma'] : []
  return density === 'compact'
    ? ['oi', ...g, 'iv', 'mark']
    : ['oi', ...g, 'delta', 'iv', 'bid', 'mark', 'ask']
}

export function putColumns(density: Density, greeks: boolean): ColKey[] {
  const call = callColumns(density, greeks)
  const isTouch = (k: ColKey): boolean => k === 'bid' || k === 'mark' || k === 'ask'
  return [...call.filter(isTouch), ...call.filter((k) => !isTouch(k)).reverse()]
}

// ------------------------------------------------------------- flash cell

/**
 * A figure that flashes when it changes: green up, red down. The flash is a
 * class toggled on the DOM node directly — no state, no extra render — and it
 * animates background colour only, so nothing moves.
 */
function Flash(props: { value: number | null | undefined; text: string; className?: string }): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null)
  const prev = useRef(props.value)
  useLayoutEffect(() => {
    const before = prev.current
    prev.current = props.value
    const el = ref.current
    if (el === null || !finite(before) || !finite(props.value) || before === props.value) return
    el.classList.remove('chain-up', 'chain-down')
    void el.offsetWidth // restarts the animation if the last one is still running
    el.classList.add(props.value > before ? 'chain-up' : 'chain-down')
  }, [props.value])
  const missing = props.text === MISSING
  const cls = ['chain-v', missing ? 'chain-missing' : '', props.className ?? ''].filter((c) => c !== '').join(' ')
  return (
    <span ref={ref} className={cls} aria-label={missing ? 'no quote' : undefined}>
      {props.text}
    </span>
  )
}

/**
 * Only the prices and OI flash. IV and the greeks move with every index tick,
 * so flashing them lit the whole table every two seconds and hid the quotes
 * that actually changed.
 */
const FLASHES: ReadonlySet<ColKey> = new Set<ColKey>(['bid', 'mark', 'ask', 'oi'])

/** A figure that does not flash. */
function Fig(props: { text: string }): React.ReactElement {
  const missing = props.text === MISSING
  return (
    <span className={missing ? 'chain-v chain-missing' : 'chain-v'} aria-label={missing ? 'no quote' : undefined}>
      {props.text}
    </span>
  )
}

// ----------------------------------------------------------------- a row

/** The hover text for one side: everything the row may have no room for. */
function sideTitle(type: 'Call' | 'Put', strike: number, s: ChainSide | null | undefined): string {
  const head = `${type} ${upTo(strike, 2)}`
  if (s === null || s === undefined) return `${head}: no quote`
  return [
    head,
    `bid ${fixed(s.bid, 2)} × ${upTo(s.bidSize, 3)}`,
    `ask ${fixed(s.ask, 2)} × ${upTo(s.askSize, 3)}`,
    `mark ${fixed(s.mark, 2)}   IV ${pct(s.iv)}`,
    `delta ${fixed(s.delta, 2)}   gamma ${upTo(s.gamma, 6)}`,
    `theta ${fixed(s.theta, 2)}   vega ${fixed(s.vega, 2)}`,
  ].join('\n')
}

interface SideView {
  readonly side: ChainSide | null | undefined
  readonly itm: boolean
  /** 0..100: this side's OI as a share of the largest OI on the chain. */
  readonly oiPct: number
  /** 0..10 on the chain's IV range, null without an IV. */
  readonly heat: number | null
  /** 1 or 2 when this strike is the side's highest or second-highest OI. */
  readonly rank: 1 | 2 | null
}

function SideCells(props: {
  type: 'Call' | 'Put'
  strike: number
  view: SideView
  cols: readonly ColKey[]
}): React.ReactElement {
  const { side, itm, oiPct, heat, rank } = props.view
  const title = sideTitle(props.type, props.strike, side)
  const sideCls = props.type === 'Call' ? 'chain-ce' : 'chain-pe'
  const quoted = side !== null && side !== undefined
  return (
    <>
      {props.cols.map((key) => {
        const col = COLS[key]
        const value = quoted ? col.value(side) : null
        const text = quoted ? col.text(side) : MISSING
        const isHeat = key === 'iv' && heat !== null
        return (
          <td
            key={key}
            className={`chain-td ${sideCls} chain-c-${key}${itm ? ' chain-itm' : ''}${rank === null ? '' : ` chain-wall chain-wall-${rank}`}`}
            style={isHeat ? ({ '--heat': heat } as React.CSSProperties) : undefined}
            title={title}
            data-itm={itm ? 'true' : 'false'}
            data-heat={isHeat ? heat : undefined}
          >
            {key === 'oi' ? (
              // The bar has its own track BESIDE the number, so it can never
              // cover a digit: calls' track sits outside the figure and grows
              // left, puts' mirrors it and grows right.
              <span className="chain-oi">
                {/* Always rendered, empty when not a wall, so a new wall never shifts the column. */}
                <span
                  className="chain-oi-rank"
                  title={rank === null ? undefined : `${rank === 1 ? 'Highest' : 'Second-highest'} ${props.type.toLowerCase()} OI`}
                >
                  {rank === null ? '' : String(rank)}
                </span>
                <span className="chain-oi-track" aria-hidden="true">
                  {finite(value) && oiPct > 0 ? (
                    <span className="chain-oi-bar" style={{ inlineSize: `${oiPct}%` }} />
                  ) : null}
                </span>
                <Flash value={value} text={text} />
              </span>
            ) : FLASHES.has(key) ? <Flash value={value} text={text} /> : <Fig text={text} />}
          </td>
        )
      })}
    </>
  )
}

const SIDE_FIELDS: readonly (keyof ChainSide)[] = [
  'bid', 'ask', 'mark', 'iv', 'delta', 'gamma', 'theta', 'vega', 'oi', 'bidSize', 'askSize', 'price',
]

function sameSide(a: ChainSide | null | undefined, b: ChainSide | null | undefined): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  return SIDE_FIELDS.every((f) => a[f] === b[f])
}

function sameView(a: SideView, b: SideView): boolean {
  return a.itm === b.itm && a.oiPct === b.oiPct && a.heat === b.heat && a.rank === b.rank && sameSide(a.side, b.side)
}

interface RowProps {
  readonly strike: number
  readonly ce: SideView
  readonly pe: SideView
  readonly atm: boolean
  readonly far: boolean
  readonly ceCols: readonly ColKey[]
  readonly peCols: readonly ColKey[]
  /** Highlighted from the OI chart (or from hovering this row). */
  readonly hot: boolean
  readonly onHot: (strike: number | null) => void
}

const ChainRow = memo(
  function ChainRow(props: RowProps): React.ReactElement {
    return (
      <tr
        className={`chain-row${props.atm ? ' chain-atm' : ''}${props.far ? ' chain-far' : ''}${props.hot ? ' chain-hot' : ''}`}
        data-atm={props.atm ? 'true' : 'false'}
        data-far={props.far ? 'true' : 'false'}
        data-hot={props.hot ? 'true' : 'false'}
        onMouseEnter={() => props.onHot(props.strike)}
        onMouseLeave={() => props.onHot(null)}
      >
        <SideCells type="Call" strike={props.strike} view={props.ce} cols={props.ceCols} />
        <th scope="row" className="chain-strike">{upTo(props.strike, 2)}</th>
        <SideCells type="Put" strike={props.strike} view={props.pe} cols={props.peCols} />
      </tr>
    )
  },
  (a, b) =>
    a.strike === b.strike && a.atm === b.atm && a.far === b.far && a.hot === b.hot && a.onHot === b.onHot
    && a.ceCols === b.ceCols && a.peCols === b.peCols
    && sameView(a.ce, b.ce) && sameView(a.pe, b.pe),
)

function SpotLine(props: { span: number; underlying: string; spot: number }): React.ReactElement {
  return (
    <tr className="chain-spot" data-testid="spot-line">
      <td colSpan={props.span}>
        <span className="chain-spot-rule" aria-hidden="true" />
        <span className="chain-spot-pill">{`${props.underlying} ${fixed(props.spot, 2)}`}</span>
      </td>
    </tr>
  )
}

// --------------------------------------------------------------- the table

const noHot = (): void => {}

export function ChainTable(props: {
  rows: readonly ChainRowWire[]
  spot: number | null
  underlying: string
  expiry: string
  density: Density
  greeks: boolean
  /** Fixed per expiry for the dimming, so the table never re-renders on the clock. */
  msToSettle: number
  /** The top two OI strikes per side. Absent: computed here. */
  walls?: OiWalls
  /** The strike highlighted from the OI chart, and the setter both share. */
  hot?: number | null
  onHot?: (strike: number | null) => void
}): React.ReactElement {
  const { rows, spot } = props
  const ceCols = useMemo(() => callColumns(props.density, props.greeks), [props.density, props.greeks])
  const peCols = useMemo(() => putColumns(props.density, props.greeks), [props.density, props.greeks])

  const strikes = rows.map((r) => r.strike)
  const atm = atmStrike(strikes, spot)
  const iv = atmIv(rows.find((r) => r.strike === atm))
  const lineAt = spotLineIndex(strikes, spot)

  let oiMax = 0
  let ivLo = Infinity
  let ivHi = -Infinity
  for (const r of rows) {
    for (const s of [r.CE, r.PE]) {
      const oi = s?.oi
      const v = s?.iv
      if (finite(oi) && oi > oiMax) oiMax = oi
      if (finite(v)) { ivLo = Math.min(ivLo, v); ivHi = Math.max(ivHi, v) }
    }
  }
  const walls = props.walls ?? oiWalls(rows, spot)
  const onHot = props.onHot ?? noHot
  const view = (s: ChainSide | null | undefined, itm: boolean, rank: 1 | 2 | null): SideView => {
    const oi = s?.oi
    return {
      side: s,
      itm,
      oiPct: oiMax > 0 && finite(oi) ? Math.round((oi / oiMax) * 100) : 0,
      heat: heatStep(s?.iv, ivLo, ivHi),
      rank,
    }
  }

  const span = ceCols.length + 1 + peCols.length
  const line = spot === null ? null : <SpotLine key="spot" span={span} underlying={props.underlying} spot={spot} />
  const body: React.ReactNode[] = []
  rows.forEach((r, i) => {
    if (lineAt === i) body.push(line)
    const itm = itmSides(r.strike, spot)
    body.push(
      <ChainRow
        key={r.strike}
        strike={r.strike}
        ce={view(r.CE, itm.ce, wallRank(walls.ce, r.strike))}
        pe={view(r.PE, itm.pe, wallRank(walls.pe, r.strike))}
        atm={r.strike === atm}
        far={isFar(r.strike, spot, iv, props.msToSettle)}
        ceCols={ceCols}
        peCols={peCols}
        hot={props.hot === r.strike}
        onHot={onHot}
      />,
    )
  })
  if (lineAt === rows.length) body.push(line)

  // Bring the spot line to the middle of the scroller once per expiry.
  const scroller = useRef<HTMLDivElement>(null)
  const centred = useRef<string | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (el === null || centred.current === props.expiry || lineAt === null) return
    const spotRow = el.querySelector<HTMLElement>('.chain-spot')
    if (spotRow === null) return
    centred.current = props.expiry
    el.scrollTop = Math.max(0, spotRow.offsetTop - el.clientHeight / 2)
  }, [props.expiry, lineAt])

  return (
    <div className="chain-scroll" ref={scroller} tabIndex={0} role="region" aria-label={`${props.underlying} option chain`}>
      <table className="chain-table" data-density={props.density}>
        <thead>
          <tr className="chain-head-group">
            <th colSpan={ceCols.length} className="chain-group chain-group-ce" scope="colgroup">Calls</th>
            <th rowSpan={2} className="chain-strike-head" scope="col">Strike</th>
            <th colSpan={peCols.length} className="chain-group chain-group-pe" scope="colgroup">Puts</th>
          </tr>
          <tr className="chain-head-cols">
            {ceCols.map((k) => (
              <th key={`ce-${k}`} scope="col" title={COLS[k].title} className={`chain-th chain-ce chain-c-${k}`}>{COLS[k].label}</th>
            ))}
            {peCols.map((k) => (
              <th key={`pe-${k}`} scope="col" title={COLS[k].title} className={`chain-th chain-pe chain-c-${k}`}>{COLS[k].label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------- header

/** A clock that ticks once a second, for the few components that need one. */
function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs)
    return () => clearInterval(id)
  }, [stepMs])
  return now
}

function Countdown(props: { expiry: string }): React.ReactElement {
  const now = useNow()
  const left = settlesAt(props.expiry) - now
  return (
    <span className={`chain-countdown${left < 3600_000 ? ' chain-countdown-near' : ''}`} role="timer">
      {formatCountdown(left)}
    </span>
  )
}

function Stat(props: { label: string; value: string; hint: string }): React.ReactElement {
  return (
    <div className="chain-stat" title={props.hint}>
      <dt>{props.label}</dt>
      <dd className={props.value === MISSING ? 'chain-missing' : undefined}>{props.value}</dd>
    </div>
  )
}

function Header(props: {
  underlying: string
  spot: number | null
  openSpot: number | null
  expiry: string | null
  rows: readonly ChainRowWire[]
  asOfText: string | undefined
  walls: OiWalls
  pain: number | null
}): React.ReactElement {
  const { spot, openSpot, rows, pain } = props
  const move = indexChange(spot, openSpot, LOCALE)
  const atmRow = rows.find((r) => r.strike === atmStrike(rows.map((x) => x.strike), spot))
  const pcr = putCallRatio(rows)
  const wall = (ks: readonly number[]): string => (ks.length === 0 ? MISSING : ks.map((k) => upTo(k, 2)).join(' · '))
  return (
    <section className="chain-header" aria-label={`${props.underlying} summary`}>
      <div className="chain-price-block">
        <span className="chain-price-label">{`${props.underlying} index`}</span>
        <span className="chain-price-line">
          <Flash value={spot} text={fixed(spot, 2)} className="chain-price" />
          <span className={`chain-change chain-change-${move?.dir ?? 'flat'}`} title="Change since this page opened">
            {move === null ? MISSING : move.text}
          </span>
        </span>
        <span className="chain-asof">{props.asOfText ?? 'waiting for the first read'}</span>
      </div>

      {props.expiry !== null ? (
        <div className="chain-expiry-block">
          <span className="chain-expiry-name">{`${expiryLabel(props.expiry)} expiry`}</span>
          <Countdown expiry={props.expiry} />
          <span className="chain-expiry-sub">
            {`to settlement at 17:30 IST, ${daysToExpiry(props.expiry, Date.now())} DTE`}
          </span>
        </div>
      ) : null}

      <dl className="chain-stats">
        <Stat label="ATM straddle" value={fixed(atmStraddle(atmRow), 2)} hint="Call mark plus put mark at the ATM strike" />
        <Stat label="ATM IV" value={pct(atmIv(atmRow))} hint="Mean of the ATM call and put mark IV" />
        <Stat label="PCR" value={pcr === null ? MISSING : pcr.toFixed(2)} hint="Put open interest over call open interest, this expiry" />
        <Stat label="Max pain" value={pain === null ? MISSING : upTo(pain, 2)} hint="The settlement strike that pays option holders least" />
        <Stat label="Call OI wall" value={wall(props.walls.ce)} hint="Highest and second-highest call OI: resistance" />
        <Stat label="Put OI wall" value={wall(props.walls.pe)} hint="Highest and second-highest put OI: support" />
      </dl>
    </section>
  )
}

// ----------------------------------------------------------- the pickers

export function ExpiryPills(props: {
  expiries: readonly string[]
  selected: string | null
  onPick: (e: string) => void
  now: number
}): React.ReactElement {
  return (
    <nav className="chain-pills" aria-label="Expiries">
      {groupExpiries(props.expiries).map((g) => (
        <div key={g.cls} className={`chain-pill-group chain-pill-${g.cls}`} role="group" aria-label={`${g.label} expiries`} data-group={g.cls}>
          <span className="chain-pill-label">{g.label}</span>
          {g.expiries.map((e) => (
            <button
              key={e}
              type="button"
              className="chain-pill"
              aria-pressed={e === props.selected}
              onClick={() => props.onPick(e)}
            >
              {expiryPillLabel(e, props.now)}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}

function useStored<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const got = window.localStorage.getItem(key)
      return got !== null && (allowed as readonly string[]).includes(got) ? (got as T) : initial
    } catch {
      return initial
    }
  })
  const set = (next: T): void => {
    setV(next)
    try { window.localStorage.setItem(key, next) } catch { /* private window: the choice lasts the visit */ }
  }
  return [v, set]
}

// ------------------------------------------------------------ the states

function FeedBanner(props: { spotAsOf: number | null | undefined; feedAlive: boolean | undefined }): React.ReactElement | null {
  const now = useNow()
  if (props.feedAlive === false) {
    return (
      <Banner
        status="warning"
        title="The price feed is down"
        description="These are the last quotes received, not the market."
      />
    )
  }
  if (!finite(props.spotAsOf)) return null
  const age = Math.max(0, now - props.spotAsOf)
  if (age <= SPOT_STALE_MS) return null
  return (
    <Banner
      status="warning"
      title="Feed stale"
      description={`The index price is ${Math.round(age / 1000)} s old. The quotes below may not be the market.`}
    />
  )
}

function Skeleton(): React.ReactElement {
  return (
    <div className="chain-skeleton" aria-busy="true" aria-label="Loading the option chain">
      <div className="chain-skel-header">
        <span className="chain-skel chain-skel-price" />
        <span className="chain-skel chain-skel-block" />
        <span className="chain-skel chain-skel-block" />
      </div>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="chain-skel-row">
          <span className="chain-skel" />
          <span className="chain-skel chain-skel-strike" />
          <span className="chain-skel" />
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ page

export function ChainPage(props: { underlying?: string }): React.ReactElement {
  const underlying = props.underlying ?? 'BTC'
  const expiries = usePoll(() => api.chainExpiries(underlying), EXPIRIES_POLL_MS, [underlying])
  const [picked, setPicked] = useState<string | null>(null)
  const [density, setDensity] = useStored<Density>('desk.chain.density', 'full', ['compact', 'full'])
  const [greeks, setGreeks] = useStored<'on' | 'off'>('desk.chain.greeks', 'off', ['on', 'off'])
  const [chart, setChart] = useStored<'shown' | 'hidden'>('desk.chain.chart', 'shown', ['shown', 'hidden'])
  /** The strike highlighted in both the OI chart and the table. */
  const [hot, setHot] = useState<number | null>(null)

  const list = expiries.data ?? []
  // The first listed expiry until the operator picks one, and again if the
  // picked one is delisted (it settled) — never a chain for an expiry that is gone.
  const expiry = picked !== null && list.includes(picked) ? picked : (list[0] ?? null)
  useEffect(() => {
    if (picked !== null && expiries.data !== null && !expiries.data.includes(picked)) setPicked(null)
  }, [picked, expiries.data])

  const chain = usePoll(
    () => (expiry === null ? Promise.resolve(null) : api.chain(underlying, expiry)),
    CHAIN_POLL_MS,
    [underlying, expiry],
  )
  // Only a chain for the expiry on screen: after a pick, the previous expiry's
  // rows are never shown under the new expiry's name.
  const data = chain.data !== null && (chain.data.expiry === undefined || chain.data.expiry === expiry)
    ? chain.data
    : null
  const rows = data?.rows ?? []
  const spot = data?.spot ?? null
  const walls = oiWalls(rows, spot)
  const pain = maxPain(rows)

  // The first index price seen on this page, for "change since opened".
  const openSpot = useRef<{ underlying: string; spot: number } | null>(null)
  if (finite(spot) && (openSpot.current === null || openSpot.current.underlying !== underlying)) {
    openSpot.current = { underlying, spot }
  }

  // Fixed per expiry, so the dimming never re-renders the table on the clock.
  const msToSettle = useMemo(() => (expiry === null ? 0 : settlesAt(expiry) - Date.now()), [expiry])
  const pillNow = useMemo(() => Date.now(), [expiries.data])

  const loading = (expiries.data === null && expiries.error === null)
    || (expiry !== null && data === null && chain.error === null)

  return (
    <div className="chain-page">
      <div className="chain-topline">
        <h2 className="chain-page-title">{`${underlying} option chain`}</h2>
        <div className="chain-controls">
          <div className="chain-seg" role="group" aria-label="Columns">
            {(['compact', 'full'] as const).map((d) => (
              <button
                key={d}
                type="button"
                className="chain-seg-btn"
                aria-pressed={density === d}
                onClick={() => setDensity(d)}
              >
                {d === 'compact' ? 'Compact' : 'Full'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="chain-seg-btn chain-greeks-toggle"
            aria-pressed={greeks === 'on'}
            onClick={() => setGreeks(greeks === 'on' ? 'off' : 'on')}
          >
            Greeks
          </button>
        </div>
      </div>

      {expiries.error !== null ? (
        <Banner status="error" title="The expiry list could not be loaded" description={expiries.error} />
      ) : null}

      {expiries.data !== null && list.length === 0 ? (
        <div className="chain-empty-state">
          <p className="chain-empty-title">{`No expiries are listed for ${underlying}.`}</p>
          <p className="chain-empty-sub">The list is re-read every minute; new listings appear here on their own.</p>
        </div>
      ) : null}

      {list.length > 0 ? <ExpiryPills expiries={list} selected={expiry} onPick={setPicked} now={pillNow} /> : null}

      {chain.error !== null ? (
        <Banner
          status="error"
          title="The chain could not be loaded"
          description={`${chain.error}. The figures below are the last that arrived.`}
        />
      ) : null}
      {data !== null ? <FeedBanner spotAsOf={data.spotAsOf} feedAlive={data.feedAlive} /> : null}

      {loading && data === null ? <Skeleton /> : null}

      {data !== null ? (
        <Header
          underlying={underlying}
          spot={spot}
          openSpot={openSpot.current?.spot ?? null}
          expiry={expiry}
          rows={rows}
          asOfText={asOf(chain.updatedAt)}
          walls={walls}
          pain={pain}
        />
      ) : null}

      {expiry !== null && data !== null && rows.length === 0 ? (
        <div className="chain-empty-state">
          <p className="chain-empty-title">{`No strikes are listed for ${underlying} ${expiryLabel(expiry)}.`}</p>
          <p className="chain-empty-sub">Pick another expiry above. A new listing fills in as its first quotes arrive.</p>
        </div>
      ) : null}

      {expiry !== null && rows.length > 0 ? (
        <section className="chain-chart-panel" aria-label="Open interest by strike">
          <div className="chain-chart-head">
            <h3 className="chain-chart-title">Open interest by strike</h3>
            {chart === 'shown' ? (
              <ul className="chain-legend" aria-label="Legend">
                <li><span className="chain-swatch chain-swatch-ce" aria-hidden="true" />Calls</li>
                <li><span className="chain-swatch chain-swatch-pe" aria-hidden="true" />Puts</li>
                <li><span className="chain-legend-line" aria-hidden="true" />Index</li>
                <li><span className="chain-legend-line chain-legend-dash" aria-hidden="true" />Max pain</li>
              </ul>
            ) : null}
            <button
              type="button"
              className="chain-seg-btn chain-chart-toggle"
              aria-expanded={chart === 'shown'}
              onClick={() => setChart(chart === 'shown' ? 'hidden' : 'shown')}
            >
              {chart === 'shown' ? 'Hide chart' : 'Show chart'}
            </button>
          </div>
          {chart === 'shown' ? (
            <OiChart rows={rows} spot={spot} maxPain={pain} walls={walls} hot={hot} onHot={setHot} locale={LOCALE} />
          ) : null}
        </section>
      ) : null}

      {expiry !== null && rows.length > 0 ? (
        <ChainTable
          rows={rows}
          spot={spot}
          underlying={underlying}
          expiry={expiry}
          density={density}
          greeks={greeks === 'on'}
          msToSettle={msToSettle}
          walls={walls}
          hot={hot}
          onHot={setHot}
        />
      ) : null}
    </div>
  )
}
