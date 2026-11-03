/**
 * VolHedge v50's scenario leg table: the book's legs, read-only, then the
 * viewer's hypothetical rows, editable, then a blank row that becomes a row
 * the moment anything is typed into it.
 *
 * A hypothetical row joins the scenario request once it is complete and
 * never joins the book: rows live in the per-book viewer store (`viewer.ts`)
 * and nothing here saves, places or changes anything. Quantities are typed in
 * lots (qty = lots × lot size); a share, or a book with no lot size, takes
 * shares. A row the server refuses shows the server's reason — the reason
 * and figures shown are always the answer to the row as it now stands.
 *
 * Book legs unticked on the Analysis tab are listed muted: those ticks apply
 * here too. As VolHedge prints them, whatever the units toggle: the plain
 * greek columns per share, the value columns the whole leg.
 */

import { memo, type ReactElement, type ReactNode } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Selector } from '@astryxdesign/core/Selector'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { inr, RED } from '../format.ts'
import type { HypotheticalLeg, ScenarioLegRow, ScenarioView } from '../../../traders/src/analytics/wire.ts'
import { MAX_HYPOTHETICAL, type HypoRow, type RowKind, type ScenarioInputs, type ScenarioPatch } from './viewer.ts'
import { orDash } from './wire.ts'
import { TradersTable } from './table.tsx'

const KINDS: readonly RowKind[] = ['C', 'P', 'F', 'EQ']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[A-Za-z0-9_-]{1,32}$/

export const ANALYSIS_TICKS_NOTE = 'Ticks on the Analysis tab apply here'

const isOptionKind = (k: RowKind | null): boolean => k === 'C' || k === 'P'

/** The lot size the Qty input counts in for a row of `kind`, or null for shares. */
function unitLot(kind: RowKind | null, lotSize: number | null): number | null {
  return kind !== 'EQ' && lotSize !== null && Number.isInteger(lotSize) && lotSize > 0 ? lotSize : null
}

/**
 * The quantity in shares, or what is wrong with it. Once the book's lot size
 * is known, an option or future must come to whole lots of it — a what-if leg
 * given in shares included.
 */
function qtyOf(r: HypoRow, lotSize: number | null): number | string {
  const word = r.lot === null ? 'Shares' : 'Lots'
  if (r.size === null) return `Type the ${word.toLowerCase()}`
  if (!Number.isInteger(r.size) || r.size === 0) return `${word} must be a non-zero whole number`
  if (r.lot !== null && (!Number.isInteger(r.lot) || r.lot <= 0)) return 'Lot size unknown — type the quantity in shares'
  const shares = r.lot === null ? r.size : r.size * r.lot
  const unit = unitLot(r.kind, lotSize)
  if (unit !== null && shares % unit !== 0) return `${inr(shares)} shares is not a whole number of lots of ${unit}`
  return shares
}

/** The row as the server takes it, or the first thing it still needs. `lotSize` is the book's, null while unknown. */
export function toHypothetical(r: HypoRow, lotSize: number | null): { readonly leg: HypotheticalLeg } | { readonly problem: string } {
  if (!ID.test(r.id)) return { problem: `bad row id ${r.id}` }
  const kind = r.kind
  if (kind === null) return { problem: 'Pick C, P, F or EQ' }
  if (kind !== 'EQ' && !DATE.test(r.expiry)) return { problem: 'Pick an expiry' }
  const strike = isOptionKind(kind) ? r.strike : null
  if (isOptionKind(kind) && (strike === null || !Number.isFinite(strike) || strike <= 0)) return { problem: 'Type the strike' }
  const qty = qtyOf(r, lotSize)
  if (typeof qty === 'string') return { problem: qty }
  if (r.price !== null && (!Number.isFinite(r.price) || r.price < 0)) return { problem: 'Rate must be zero or more' }
  const iv = isOptionKind(kind) ? r.volPts : null
  if (iv !== null && (!Number.isFinite(iv) || iv <= 0)) return { problem: 'Vol(%) must be above 0' }
  return {
    leg: {
      id: r.id,
      instrument: isOptionKind(kind) ? 'option' : kind === 'F' ? 'future' : 'share',
      expiry: kind === 'EQ' ? '' : r.expiry,
      strike,
      optType: kind === 'C' ? 'CE' : kind === 'P' ? 'PE' : null,
      qty,
      price: r.price,
      iv: iv === null ? null : iv / 100,
    },
  }
}

/** The row's quantity in the input's unit: as typed when the units agree, else converted through shares. */
function shownSize(r: HypoRow, unit: number | null): number | null {
  if (r.size === null) return null
  if (r.lot === unit) return r.size
  const shares = r.lot === null ? r.size : r.size * r.lot
  return unit === null ? shares : shares / unit
}

/**
 * The quantity re-counted in a new unit: shares stay shares; shares that make
 * whole lots become lots; anything else is cleared, so the row waits for the
 * viewer rather than sending a quantity that is not lots × lot size.
 */
function recounted(r: HypoRow, unit: number | null): Partial<HypoRow> {
  if (r.size === null || r.lot === unit) return {}
  const shares = r.lot === null ? r.size : r.size * r.lot
  if (unit === null) return { size: shares, lot: null }
  return shares % unit === 0 ? { size: shares / unit, lot: unit } : { size: null, lot: unit }
}

/** The server's figure for an empty optional input, × `scale`, or `—`. */
const placeholder = (n: number | null, scale: number): string => (n === null ? '—' : (n * scale).toFixed(2))

/** The blank row: nothing picked, no expiry — an option gets the near month when its kind is picked, a future none. */
const blankRow = (seq: number): HypoRow =>
  ({ id: `h${seq}`, kind: null, expiry: '', strike: null, size: null, lot: null, price: null, volPts: null })

type Verdict = ScenarioView['hypothetical'][number]

type Line =
  | { readonly line: 'book'; readonly key: string; readonly leg: ScenarioLegRow; readonly muted: boolean }
  | {
    readonly line: 'hyp'; readonly key: string; readonly row: HypoRow; readonly name: string; readonly blank: boolean
    readonly problem: string | null                       // what the row still needs before it is sent
    readonly leg: ScenarioLegRow | null; readonly verdict: Verdict | null   // the answer to this version of the row, or null
  }
type HypLine = Extract<Line, { line: 'hyp' }>
type TableRow = Line & Record<string, unknown>

export interface ScenarioLegsProps {
  readonly view: ScenarioView | null                     // null until the first answer
  /** The hypothetical legs of the request `view` answers: a verdict shows only for a row still sent the same. */
  readonly answered: readonly HypotheticalLeg[]
  readonly lotSize: number | null                        // the one the request body counts lots in
  readonly excluded: readonly string[]                   // the viewer's unticked legs (the Analysis tab's ticks)
  readonly inputs: ScenarioInputs
  patch(p: ScenarioPatch): void
}

/** Memoised on what it reads: an edit in the inputs strip does not re-render the leg table. */
export const ScenarioLegs = memo(function ScenarioLegs(props: ScenarioLegsProps): ReactElement {
  const { view: v, inputs, patch, lotSize } = props
  const nearExpiry = v?.nearExpiry ?? ''
  const expiries = v?.expiries ?? []
  const legs = v?.legs ?? []
  const served = new Map(legs.filter((l) => l.hypothetical).map((l) => [l.id, l]))
  const verdicts = new Map((v?.hypothetical ?? []).map((h) => [h.id, h]))
  const sentAs = new Map(props.answered.map((h) => [h.id, JSON.stringify(h)]))
  const excluded = new Set(props.excluded)
  const full = inputs.rows.length >= MAX_HYPOTHETICAL

  const lines: Line[] = [
    ...legs.filter((l) => !l.hypothetical).map((leg): Line => ({ line: 'book', key: `b:${leg.id}`, leg, muted: excluded.has(leg.id) })),
    ...inputs.rows.map((row, i): Line => {
      const built = toHypothetical(row, lotSize)
      // Same id AND same sent fields: an edited row, or a later what-if reusing `w1`, is never shown an older answer.
      const current = 'leg' in built && sentAs.get(row.id) === JSON.stringify(built.leg)
      return {
        line: 'hyp', key: `h:${row.id}`, row, name: `hypothetical ${i + 1}`, blank: false,
        problem: 'problem' in built ? built.problem : null,
        leg: current ? served.get(row.id) ?? null : null, verdict: current ? verdicts.get(row.id) ?? null : null,
      }
    }),
    // Keyed by the id it will take, so the input being typed in stays mounted as the blank row becomes a row.
    ...(full ? [] : [((): Line => {
      const row = blankRow(inputs.seq)
      return { line: 'hyp', key: `h:${row.id}`, row, name: 'new row', blank: true, problem: null, leg: null, verdict: null }
    })()]),
  ]

  /** Change row `id`; the blank row's id appends it as a new row with the change. */
  const edit = (id: string, change: (r: HypoRow) => Partial<HypoRow>): void => patch((now) => {
    if (now.rows.some((r) => r.id === id)) return { rows: now.rows.map((r) => (r.id === id ? { ...r, ...change(r) } : r)) }
    if (id !== `h${now.seq}` || now.rows.length >= MAX_HYPOTHETICAL) return {}
    const row = blankRow(now.seq)
    return { rows: [...now.rows, { ...row, ...change(row) }], seq: now.seq + 1 }
  })
  const remove = (id: string): void => patch((now) => ({ rows: now.rows.filter((r) => r.id !== id) }))

  /**
   * Picking C/P/F clears what the new kind has no use for, and re-counts the
   * quantity in the new kind's unit. An option with no expiry gets the near
   * month; a future gets none (an index's weekly expiries have no future), and
   * an option's month does not carry over to it.
   */
  const kindChange = (k: RowKind) => (r: HypoRow): Partial<HypoRow> => ({
    kind: k,
    ...(k === 'EQ' || (k === 'F' && isOptionKind(r.kind)) ? { expiry: '' } : isOptionKind(k) && r.expiry === '' ? { expiry: nearExpiry } : {}),
    ...(isOptionKind(k) ? {} : { strike: null, volPts: null }),
    ...recounted(r, unitLot(k, lotSize)),
  })

  const text = (s: string, look: { readonly style?: Record<string, string>; readonly muted?: boolean } = {}): ReactElement => (
    <Text size="sm" color={look.muted === true ? 'secondary' : 'primary'} {...(look.style === undefined ? {} : { style: look.style })}>{s}</Text>
  )
  const dash = text('—')

  /** A column: a book row's text (muted when unticked), or a hypothetical row's cell. */
  const col = (key: string, header: string, book: (l: ScenarioLegRow) => string, hyp: (l: HypLine) => ReactNode, numeric = true): TableColumn<TableRow> => ({
    key, header, ...(numeric ? { align: 'end' as const } : {}),
    renderCell: (r) => {
      const l = r as Line
      return l.line === 'book' ? text(book(l.leg), { muted: l.muted }) : hyp(l)
    },
  })
  /** A computed column: the server's figure for the row, `—` until it has one for the row as it stands. */
  const fromServer = (key: string, header: string, f: (l: ScenarioLegRow) => string): TableColumn<TableRow> =>
    col(key, header, f, (l) => (l.leg === null ? dash : text(f(l.leg))))
  const greek = (key: string, header: string, digits: number, f: (l: ScenarioLegRow) => number): TableColumn<TableRow> =>
    fromServer(key, header, (l) => inr(f(l), digits))

  /** The Underlying cell of a hypothetical row: what it still needs, the server's refusal, or the forward. */
  const status = (l: HypLine): ReactNode => {
    if (l.blank) return dash
    if (l.problem !== null) return <Text size="sm" color="secondary">{l.problem}</Text>
    if (l.verdict !== null && !l.verdict.accepted) return text(l.verdict.reason ?? 'refused by the server', { style: RED })
    return l.leg === null ? text('…') : text(inr(l.leg.underlying, 2))
  }

  const columns: TableColumn<TableRow>[] = [
    col('expiry', 'Expiry', (l) => (l.expiry === '' ? '—' : l.expiry), (l) => {
      const { row } = l
      const options = row.expiry === '' || expiries.includes(row.expiry) ? [...expiries] : [row.expiry, ...expiries]
      return (
        <HStack gap={1} align="center">
          {row.kind === 'EQ' ? dash : (
            <Selector label={`Expiry, ${l.name}`} isLabelHidden size="sm" width={132} options={options} value={row.expiry}
              placeholder="Expiry" onChange={(e) => edit(row.id, () => ({ expiry: e }))} />
          )}
          {l.blank ? null : (
            <Button size="sm" variant="ghost" label={`Remove ${l.name}`} onClick={() => remove(row.id)}>×</Button>
          )}
        </HStack>
      )
    }, false),
    col('type', 'C/P/F', (l) => l.type, (l) => (
      <Selector label={`C/P/F, ${l.name}`} isLabelHidden size="sm" width={72} options={[...KINDS]} value={l.row.kind ?? ''}
        placeholder="—" onChange={(k) => edit(l.row.id, kindChange(k as RowKind))} />
    ), false),
    col('underlying', 'Underlying', (l) => inr(l.underlying, 2), status),
    col('strike', 'Strike', (l) => (l.strike === null ? '—' : inr(l.strike, Number.isInteger(l.strike) ? 0 : 2)), (l) => (
      l.row.kind === 'F' || l.row.kind === 'EQ' ? dash : (
        <NumberInput label={`Strike, ${l.name}`} isLabelHidden size="sm" width={96} min={0.01} step={0.05} hasClear
          value={l.row.strike} onChange={(n) => edit(l.row.id, () => ({ strike: n }))} />
      )
    )),
    col('qty', 'Qty', (l) => inr(l.qty), (l) => {
      const unit = unitLot(l.row.kind, lotSize)
      const qty = qtyOf(l.row, lotSize)
      return (
        <HStack gap={1} align="center" justify="end">
          {/* Keyed by its unit: lots and shares are different quantities, so a unit change starts a fresh input. */}
          <NumberInput key={unit ?? 'shares'} label={`${unit === null ? 'Shares' : 'Lots'}, ${l.name}`} isLabelHidden size="sm" width={88}
            isIntegerOnly hasClear placeholder={unit === null ? 'shares' : 'lots'} value={shownSize(l.row, unit)}
            onChange={(n) => edit(l.row.id, () => ({ size: n, lot: unit }))} />
          {unit !== null && typeof qty === 'number' ? <Text size="sm" color="secondary">{`= ${inr(qty)}`}</Text> : null}
        </HStack>
      )
    }),
    col('rate', 'Rate', (l) => inr(l.rate, 2), (l) => (
      // Optional: empty means the server's price (LTP, or the model price at the row's IV), shown as the placeholder.
      <NumberInput label={`Rate, ${l.name}`} isLabelHidden size="sm" width={96} min={0} step={0.05} hasClear
        placeholder={placeholder(l.verdict?.entry ?? null, 1)}
        value={l.row.price} onChange={(n) => edit(l.row.id, () => ({ price: n }))} />
    )),
    col('vol', 'Vol(%)', (l) => (l.vol === null ? '—' : (l.vol * 100).toFixed(2)), (l) => (
      l.row.kind === 'F' || l.row.kind === 'EQ' ? dash : (
        // Optional, in vol points: empty means the market IV, shown as the placeholder.
        <NumberInput label={`Vol(%), ${l.name}`} isLabelHidden size="sm" width={88} min={0.01} max={500} hasClear
          placeholder={placeholder(l.verdict?.iv ?? null, 100)}
          value={l.row.volPts} onChange={(n) => edit(l.row.id, () => ({ volPts: n }))} />
      )
    )),
    fromServer('ltp', 'LTP', (l) => orDash(l.ltp, 2)),
    greek('delta', 'Delta', 2, (l) => l.delta),
    greek('dv', 'Del Val', 0, (l) => l.deltaValue),
    greek('gamma', 'Gamma', 4, (l) => l.gamma),
    greek('gv', 'Gam Val', 4, (l) => l.gammaValue),
    greek('vega', 'Vega', 2, (l) => l.vega),
    greek('vv', 'Vg Val', 0, (l) => l.vegaValue),
    greek('theta', 'Theta', 2, (l) => l.theta),
    greek('thv', 'Th Val', 0, (l) => l.thetaValue),
  ]

  const fromShown = inputs.from !== null && inputs.rows.some((r) => r.id.startsWith('w'))
  return (
    <VStack gap={1}>
      {fromShown ? <Text weight="bold">{`From: ${inputs.from ?? ''}`}</Text> : null}
      <TradersTable aria-label="Scenario legs" data={lines as unknown as TableRow[]} columns={columns} idKey="key" density="compact" />
      {excluded.size === 0 ? null : <Text size="sm" color="secondary">{ANALYSIS_TICKS_NOTE}</Text>}
      <Text size="sm" color="secondary">
        {full
          ? `At most ${MAX_HYPOTHETICAL} hypothetical rows — remove one to add another`
          : 'Hypothetical rows join this scenario only — never the book; nothing is saved'}
      </Text>
    </VStack>
  )
}, (a, b) => a.view === b.view && a.answered === b.answered && a.lotSize === b.lotSize && a.excluded === b.excluded
  && a.patch === b.patch
  && a.inputs.rows === b.inputs.rows && a.inputs.seq === b.inputs.seq && a.inputs.from === b.inputs.from)
