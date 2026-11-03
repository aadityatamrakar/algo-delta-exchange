/**
 * Market Watch (spec item 24): an underlying's three chains, calls | strike |
 * puts, each column colour-scaled over the rows on screen.
 *
 * The page polls every 5 s while the browser tab is visible. The server keeps
 * an underlying's strikes subscribed only while someone is polling it, so a
 * hidden tab or a closed page lets the on-screen set expire (P3).
 */

import { useMemo, useState, type ReactElement } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { BellAlert } from './bell.tsx'
import { Button } from '@astryxdesign/core/Button'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { HStack, Layout, LayoutContent, LayoutFooter, VStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { inr, signed } from '../format.ts'
import type { MarketChain, MarketRow, MarketSide, MarketWatchView } from '../../../traders/src/analytics/r3-wire.ts'
import { tapi } from './api.ts'
import { STOCK_RE } from './names.ts'
import { colourStep, stepFill } from './colour-scale.ts'
import { useDocumentVisible, usePoll } from './hooks.ts'
import { COLUMN_LABELS, DEFAULT_COLUMNS, loadColumns, saveColumns, type MarketColumn } from './market-columns.ts'
import { Caveats } from './caveats.tsx'
import { TradersTable, type TradersColumn } from './table.tsx'

export const MARKET_POLL_MS = 5_000
const STOCK_KEY = 'traders.market.stock'
/** What a figure that is not a live price carries beside it. */
const STALE = '(stale)'
const STALE_STYLE = { color: 'var(--color-text-secondary)', fontStyle: 'italic' } as const
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const storage = (): Storage | null => { try { return window.localStorage } catch { return null } }

/** The columns whose heading explains a guessed definition (`labels.*`). */
const LABELLED: Partial<Record<MarketColumn, keyof MarketWatchView['labels']>> = { bf: 'bf', bf2: 'bf2', ratio: 'ratio' }

const DIGITS: Partial<Record<MarketColumn, number>> = {
  oiChange: 0, oi: 0, volume: 0, iv: 1, delta: 2, gamma: 4, vega: 2, theta: 2, changePct: 2,
}

function valueOf(side: MarketSide | null, col: MarketColumn): number | null {
  if (side === null || col === 'straddle') return null
  const v = col === 'iv' && side.iv !== null ? side.iv * 100 : side[col]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function text(n: number | null, col: MarketColumn): string {
  if (n === null) return '—'
  const digits = DIGITS[col] ?? 2
  return col === 'oiChange' || col === 'change' || col === 'changePct' ? signed(n, digits) : inr(n, digits)
}

const monthOf = (expiry: string): string => MONTHS[Number(expiry.slice(5, 7)) - 1] ?? ''

/** `TCS OCT FUT 3,412.50 +12.30 (0.36%)`, or `NIFTY 20 OCT · forward 25,040.20 (parity)` when no future is quoted. */
export function chainHeading(stock: string, c: MarketChain): string {
  const mon = monthOf(c.expiry)
  if (c.future === null) {
    const fwd = c.forward === null ? '—' : inr(c.forward, 2)
    return `${stock} ${c.expiry.slice(8, 10)} ${mon} · forward ${fwd}${c.forwardSource === null ? '' : ` (${c.forwardSource})`}`
  }
  const f = c.future
  const move = f.change === null || f.changePct === null ? '' : ` ${signed(f.change, 2)} (${inr(Math.abs(f.changePct), 2)}%)`
  return `${stock} ${mon} FUT ${f.ltp === null ? '—' : inr(f.ltp, 2)}${move}${f.stale ? ` ${STALE}` : ''}`
}

type Row = { readonly id: string; readonly row: MarketRow } & Record<string, unknown>

type Scale = Readonly<Record<string, { min: number; max: number }>>

/** The server sums both LTPs whatever their age: a straddle with a stale side is a stale figure. */
const straddleStale = (r: MarketRow): boolean => r.ce?.stale === true || r.pe?.stale === true

function scaleOf(rows: readonly MarketRow[], cols: readonly MarketColumn[]): Scale {
  const out: Record<string, { min: number; max: number }> = {}
  const add = (key: string, v: number | null): void => {
    if (v === null) return
    const s = out[key]
    if (s === undefined) out[key] = { min: v, max: v }
    else { s.min = Math.min(s.min, v); s.max = Math.max(s.max, v) }
  }
  for (const r of rows) {
    for (const col of cols) {
      if (col === 'straddle') { if (!straddleStale(r)) add('straddle', r.straddle) }
      else {
        if (r.ce?.stale !== true) add(`ce-${col}`, valueOf(r.ce, col))
        if (r.pe?.stale !== true) add(`pe-${col}`, valueOf(r.pe, col))
      }
    }
  }
  return out
}

/** A stale figure is muted and italic, never filled: it must not read like a live, scaled number. A screen reader hears "(stale)". */
function Cell(props: {
  readonly value: number | null; readonly col: MarketColumn; readonly range: { min: number; max: number } | undefined; readonly stale: boolean
}): ReactElement {
  const { value, col, range, stale } = props
  if (stale) {
    return (
      <Text size="sm" data-stale="true" style={{ display: 'block', textAlign: 'end', ...STALE_STYLE }}>
        {text(value, col)}<VisuallyHidden> {STALE}</VisuallyHidden>
      </Text>
    )
  }
  const fill = range === undefined ? undefined : stepFill(colourStep(value, range.min, range.max))
  return <Text size="sm" style={{ display: 'block', textAlign: 'end', ...(fill === undefined ? {} : { background: fill }) }}>{text(value, col)}</Text>
}

function heading(col: MarketColumn, labels: MarketWatchView['labels']): ReactElement {
  const key = LABELLED[col]
  const label = <Text size="sm" weight="bold">{COLUMN_LABELS[col]}</Text>
  return key === undefined ? label : <Tooltip content={labels[key]}>{label}</Tooltip>
}

function Chain(props: { readonly view: MarketWatchView; readonly chain: MarketChain; readonly cols: readonly MarketColumn[] }): ReactElement {
  const { view, chain, cols } = props
  const sideCols = cols.filter((c) => c !== 'straddle')
  const scale = useMemo(() => scaleOf(chain.rows, cols), [chain.rows, cols])
  const rows: Row[] = useMemo(() => chain.rows.map((row) => ({ id: String(row.strike), row })), [chain.rows])
  const side = (which: 'ce' | 'pe', list: readonly MarketColumn[]): TradersColumn<Row>[] => list.map((col) => ({
    key: `${which}-${col}`, header: heading(col, view.labels), align: 'end',
    sortValue: (r) => valueOf(r.row[which], col),
    renderCell: (r) => {
      const sd = (r as Row).row[which]
      return <Cell value={valueOf(sd, col)} col={col} range={scale[`${which}-${col}`]} stale={sd?.stale === true} />
    },
  }))
  const columns: TradersColumn<Row>[] = [
    ...side('ce', sideCols),
    { key: 'strike', header: 'Strike', align: 'center', sortValue: (r) => r.row.strike, renderCell: (r) => <Text size="sm" weight="bold">{inr((r as Row).row.strike, 2)}</Text> },
    ...(cols.includes('straddle') ? [{
      key: 'straddle', header: heading('straddle', view.labels), align: 'end' as const, sortValue: (r: Row) => r.row.straddle,
      renderCell: (r: Row) => <Cell value={r.row.straddle} col="straddle" range={scale['straddle']} stale={straddleStale(r.row)} />,
    } satisfies TradersColumn<Row>] : []),
    ...side('pe', [...sideCols].reverse()),
  ]
  return (
    <VStack gap={2}>
      <Text weight="bold" role="heading" aria-level={3}>{chainHeading(view.stock, chain)}</Text>
      {chain.rows.some(straddleStale)
        ? <Text size="sm" color="secondary">Grey italic figures are stale: not a live price.</Text> : null}
      <TradersTable aria-label={`${view.stock} ${chain.expiry}`} data={rows} columns={columns} idKey="id" density="compact" />
    </VStack>
  )
}

function ColumnsDialog(props: { readonly cols: readonly MarketColumn[]; onChange(c: MarketColumn[]): void; onClose(): void }): ReactElement {
  const { cols } = props
  const shown = [...cols, ...DEFAULT_COLUMNS.filter((c) => !cols.includes(c))]
  const toggle = (c: MarketColumn, on: boolean): void => props.onChange(on ? [...cols, c] : cols.filter((x) => x !== c))
  // Straddle is pinned beside the strike: only the others move, and it keeps its place in the list.
  const movable: MarketColumn[] = cols.filter((c) => c !== 'straddle')
  const move = (c: MarketColumn, by: -1 | 1): void => {
    const i = movable.indexOf(c)
    const j = i + by
    if (i < 0 || j < 0 || j >= movable.length) return
    const next = [...movable]
    next[i] = movable[j]!
    next[j] = c
    const at = cols.indexOf('straddle')
    if (at >= 0) next.splice(at, 0, 'straddle')
    props.onChange(next)
  }
  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title="Columns" onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={2}>
              <Text size="sm" color="secondary">
                Calls read outward to inward in this order; puts mirror them. Straddle sits beside the strike. At least one column stays on.
              </Text>
              {shown.map((c) => {
                const on = cols.includes(c)
                const i = movable.indexOf(c)
                const pinned = c === 'straddle'
                return (
                  <HStack key={c} gap={2} align="center">
                    <CheckboxInput label={COLUMN_LABELS[c]} size="sm" value={on} isDisabled={on && cols.length === 1} onChange={(v) => toggle(c, v)} />
                    {pinned ? null : <>
                      <Button size="sm" variant="ghost" label="↑" aria-label={`Move ${COLUMN_LABELS[c]} up`} isDisabled={!on || i === 0} onClick={() => move(c, -1)} />
                      <Button size="sm" variant="ghost" label="↓" aria-label={`Move ${COLUMN_LABELS[c]} down`} isDisabled={!on || i === movable.length - 1} onClick={() => move(c, 1)} />
                    </>}
                  </HStack>
                )
              })}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Defaults" onClick={() => props.onChange([...DEFAULT_COLUMNS])} />
              <Button variant="primary" label="Done" onClick={props.onClose} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

export function MarketWatchPage(): ReactElement {
  const [stock, setStock] = useState<string | null>(() => {
    try { const s = storage()?.getItem(STOCK_KEY); return typeof s === 'string' && STOCK_RE.test(s) ? s : null } catch { return null }
  })
  const [typed, setTyped] = useState(stock ?? '')
  const [cols, setCols] = useState<MarketColumn[]>(() => loadColumns(storage()))
  const [editing, setEditing] = useState(false)
  const visible = useDocumentVisible()
  const poll = usePoll(() => tapi.market(stock ?? ''), MARKET_POLL_MS, [stock], stock !== null && visible)

  const wanted = typed.trim().toUpperCase()
  const valid = STOCK_RE.test(wanted)
  const pick = (): void => {
    if (!valid) return
    setStock(wanted)
    try { storage()?.setItem(STOCK_KEY, wanted) } catch { /* remembered for this visit only */ }
  }
  const setColumns = (c: MarketColumn[]): void => { setCols(c); saveColumns(storage(), c) }

  const v = poll.data
  return (
    <VStack gap={3}>
      <HStack gap={2} align="end" wrap="wrap">
        <TextInput
          label="Underlying" value={typed} onChange={setTyped} onKeyDown={(e) => { if (e.key === 'Enter') pick() }}
          description={typed.trim() === '' || valid ? 'A stock or an index, e.g. TCS or NIFTY' : 'Letters, digits, & or -, up to 20'}
        />
        <Button variant="primary" label="Show" isDisabled={!valid} onClick={pick} />
        <Button variant="secondary" label="Columns" onClick={() => setEditing(true)} />
      </HStack>
      {stock === null ? <Text color="secondary">Pick an underlying to see its three chains.</Text> : null}
      {stock !== null && v === null
        ? (poll.error !== null
          ? <Banner status="error" title={`Could not load ${stock}: ${poll.error}`} />
          : <Text color="secondary">Loading {stock}…</Text>)
        : null}
      {v === null ? null : (
        <>
          <BellAlert text={poll.error === null ? null : `Refresh failed: ${poll.error}`} />
          <Caveats items={v.warnings} kind="warning" />
          <Caveats items={v.fullChains ? [] : ['Subscription cap reached: only strikes another screen already watches are shown, so these chains have gaps']} kind="warning" />
          <Text size="sm" color="secondary">
            {`${v.stock} spot ${v.spot === null ? '—' : inr(v.spot, 2)}${v.spotStale && v.spot !== null ? ` ${STALE}` : ''}${v.oiDay === null ? '' : ` · OI and price change against ${v.oiDay}`}`}
          </Text>
          {v.chains.map((c) => <Chain key={c.expiry} view={v} chain={c} cols={cols} />)}
          {/* The headers' tooltips need a mouse; these lines reach keyboard and touch too. */}
          {cols.flatMap((c) => {
            const key = LABELLED[c]
            return key === undefined ? [] : [<Text key={c} size="sm" color="secondary">{v.labels[key]}</Text>]
          })}
        </>
      )}
      {editing ? <ColumnsDialog cols={cols} onChange={setColumns} onClose={() => setEditing(false)} /> : null}
    </VStack>
  )
}
