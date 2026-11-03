/**
 * Range Calculator (spec item 25): the 1σ, 2σ and 3σ bands around a price for
 * each of the next days. All arithmetic is `rangeRows`, in the page; the only
 * call to the server is the optional CMP prefill from an underlying's Market
 * Watch (its spot, else the first chain's forward). A prefill that is not a
 * live spot says so until CMP is typed over.
 */

import { useMemo, useRef, useState, type ReactElement } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import type { TableColumn } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { inr } from '../format.ts'
import { tapi } from './api.ts'
import { STOCK_RE } from './names.ts'
import { rangeRows, type RangeBand, type RangeRow } from './range.ts'
import { expiryDayLabel, istDay } from './wire.ts'
import { Caveats } from './caveats.tsx'
import { TradersTable } from './table.tsx'

/** The trading day is India's: before 05:30 IST the UTC date is still yesterday's. */
const today = (): string => istDay(Date.now())

/** A typed number, or NaN when empty or not one (rangeRows then names the field). */
const num = (s: string): number => (s.trim() === '' ? Number.NaN : Number(s))

type Row = RangeRow & { readonly id: string } & Record<string, unknown>

function sigma(k: 's1' | 's2' | 's3', label: string): TableColumn<Row>[] {
  const part = (key: string, header: string, pick: (b: RangeBand) => number, digits: number): TableColumn<Row> => ({
    key: `${k}-${key}`, header: `${label} ${header}`, align: 'end',
    renderCell: (r) => <Text size="sm">{inr(pick((r as Row)[k] as RangeBand), digits)}</Text>,
  })
  return [part('lower', 'lower', (b) => b.lower, 0), part('upper', 'upper', (b) => b.upper, 0), part('points', 'points', (b) => b.points, 0)]
}

const COLUMNS: TableColumn<Row>[] = [
  { key: 'day', header: 'Day', align: 'end', renderCell: (r) => <Text size="sm">{(r as Row).day}</Text> },
  { key: 'date', header: 'Date', renderCell: (r) => <Text size="sm">{(r as Row).date}</Text> },
  { key: 'changePct', header: 'Change %', align: 'end', renderCell: (r) => <Text size="sm">{(r as Row).changePct.toFixed(2)}</Text> },
  ...sigma('s1', '1σ (68%)'), ...sigma('s2', '2σ (95%)'), ...sigma('s3', '3σ (99%)'),
]

export function RangePage(): ReactElement {
  const [underlying, setUnderlying] = useState('')
  const [cmp, setCmp] = useState('')
  const [startDate, setStartDate] = useState(today)
  const [vol, setVol] = useState('')
  const [iterations, setIterations] = useState('30')
  const [step, setStep] = useState('1')
  const [loading, setLoading] = useState(false)
  const [prefillError, setPrefillError] = useState<string | null>(null)
  /** What the prefilled CMP is when it is not a live spot; cleared when CMP is typed over. */
  const [prefillNote, setPrefillNote] = useState<string | null>(null)

  const wanted = underlying.trim().toUpperCase()
  const validStock = STOCK_RE.test(wanted)
  // Each Fill CMP and each edit of CMP supersedes the request in flight; its answer is dropped.
  const request = useRef(0)
  const supersede = (): void => { request.current++; setLoading(false) }
  const editCmp = (s: string): void => { supersede(); setCmp(s); setPrefillNote(null) }
  const editUnderlying = (s: string): void => { supersede(); setUnderlying(s) }
  const prefill = (): void => {
    if (!validStock) return
    const mine = ++request.current
    setLoading(true)
    setPrefillError(null)
    tapi.market(wanted).then((v) => {
      if (request.current !== mine) return
      const chain = v.spot === null ? v.chains.find((c) => c.forward !== null) : undefined
      const price = v.spot ?? chain?.forward ?? null
      if (price === null) setPrefillError(`No price for ${wanted} yet`)
      else {
        setCmp(String(price))
        setPrefillNote(
          chain !== undefined
            ? `No spot for ${v.stock}: CMP is the ${expiryDayLabel(chain.expiry)} forward${chain.forwardSource === null ? '' : ` (${chain.forwardSource})`}, not a quoted price`
            : v.spotStale ? `${v.stock} spot is stale: CMP is the last price seen, not a live one` : null,
        )
      }
      setLoading(false)
    }, (e: unknown) => {
      if (request.current !== mine) return
      setPrefillError(`Could not load ${wanted}: ${e instanceof Error ? e.message : String(e)}`)
      setLoading(false)
    })
  }

  const result = useMemo(
    () => rangeRows({ cmp: num(cmp), startDate, vol: num(vol), iterations: num(iterations), step: num(step) }),
    [cmp, startDate, vol, iterations, step],
  )
  const data: Row[] | null = Array.isArray(result) ? result.map((r) => ({ ...r, id: String(r.day) })) : null
  const touched = cmp.trim() !== '' || vol.trim() !== ''

  return (
    <VStack gap={3}>
      <HStack gap={2} align="end" wrap="wrap">
        <TextInput
          label="Underlying" value={underlying} onChange={editUnderlying} onKeyDown={(e) => { if (e.key === 'Enter') prefill() }}
          description={underlying.trim() === '' || validStock ? 'Optional: fills CMP from its Market Watch' : 'Letters, digits, & or -, up to 20'}
        />
        <Button variant="secondary" label="Fill CMP" isDisabled={!validStock || loading} onClick={prefill} />
      </HStack>
      <HStack gap={2} align="end" wrap="wrap">
        <TextInput label="CMP" value={cmp} onChange={editCmp} />
        <TextInput label="Start date" value={startDate} onChange={setStartDate} description="YYYY-MM-DD" />
        <TextInput label="Volatility %" value={vol} onChange={setVol} description="Annualised, e.g. 27.7" />
        <TextInput label="Iterations" value={iterations} onChange={setIterations} description="1 to 365" />
        <TextInput label="Step (days)" value={step} onChange={setStep} />
      </HStack>
      {prefillError === null ? null : <Banner status="warning" title={prefillError} />}
      <Caveats items={prefillNote === null ? [] : [prefillNote]} kind="warning" />
      {data !== null ? (
        <TradersTable aria-label="Range" data={data} columns={COLUMNS} idKey="id" density="compact" />
      ) : (
        <Text color="secondary">{touched && !Array.isArray(result) ? result.error : 'Enter CMP and volatility to see the ranges.'}</Text>
      )}
    </VStack>
  )
}
