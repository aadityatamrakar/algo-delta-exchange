/**
 * The charges editor on the Admin page: the statutory-charge RATES the analysis
 * uses to estimate a book's costs. It edits numbers stored for estimates only —
 * it does not change any broker's charges and places nothing. The seed values
 * are not confirmed rates until an admin saves them.
 */

import { useEffect, useState } from 'react'
import { VStack, HStack } from '@astryxdesign/core/Layout'
import { Text } from '@astryxdesign/core/Text'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Selector } from '@astryxdesign/core/Selector'
import type { TableColumn } from '@astryxdesign/core/Table'
import type { Brokerage, ChargeRates, SegmentRates } from '../../../traders/src/analytics/wire.ts'
import { tapi } from './api.ts'
import { istDay } from './wire.ts'
import { Caveats } from './caveats.tsx'
import { TradersTable } from './table.tsx'

const SEGMENTS = [['option', 'Option'], ['future', 'Future'], ['share', 'Share']] as const
type Segment = (typeof SEGMENTS)[number][0]

const SEGMENT_FIELDS = [
  ['sttBuyPct', 'STT buy %'], ['sttSellPct', 'STT sell %'], ['exchangePct', 'Exchange %'], ['stampBuyPct', 'Stamp buy %'],
] as const satisfies readonly (readonly [keyof SegmentRates, string])[]

const MODES = [{ value: 'order', label: 'Per order' }, { value: 'lot', label: 'Per lot' }]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The form holds text, so a blank or half-typed field is never silently a number.
interface BrokerageForm { mode: 'order' | 'lot'; amount: string }
interface Form {
  seg: Record<Segment, Record<keyof SegmentRates, string>>
  sebiPerCrore: string; gstPct: string
  def: BrokerageForm; byTrader: Record<string, BrokerageForm>
}

const brokerageForm = (b: Brokerage): BrokerageForm => ({ mode: b.mode, amount: String(b.amount) })
const segForm = (s: SegmentRates): Record<keyof SegmentRates, string> => ({
  sttBuyPct: String(s.sttBuyPct), sttSellPct: String(s.sttSellPct), exchangePct: String(s.exchangePct), stampBuyPct: String(s.stampBuyPct),
})

function toForm(c: ChargeRates): Form {
  return {
    seg: { option: segForm(c.option), future: segForm(c.future), share: segForm(c.share) },
    sebiPerCrore: String(c.sebiPerCrore), gstPct: String(c.gstPct),
    def: brokerageForm(c.brokerage.default),
    byTrader: Object.fromEntries(Object.entries(c.brokerage.byTrader).map(([k, v]) => [k, brokerageForm(v)])),
  }
}

/** One field: a number within the server's range, or the message naming the field. */
function num(text: string, label: string, max: number): { value: number } | { problem: string } {
  const t = text.trim()
  const n = t === '' ? NaN : Number(t)
  if (!Number.isFinite(n)) return { problem: `${label} must be a number` }
  if (n < 0 || n > max) return { problem: `${label} must be between 0 and ${max}` }
  return { value: n }
}

/** The wire body from the form, or the first problem found. */
export function chargesBody(f: Form, prior: ChargeRates): { charges: ChargeRates } | { problem: string } {
  const seg = {} as Record<Segment, SegmentRates>
  for (const [s, sLabel] of SEGMENTS) {
    const out = {} as { -readonly [K in keyof SegmentRates]: number }
    for (const [k, kLabel] of SEGMENT_FIELDS) {
      const r = num(f.seg[s][k], `${sLabel} ${kLabel}`, 5)
      if ('problem' in r) return r
      out[k] = r.value
    }
    seg[s] = out
  }
  const sebi = num(f.sebiPerCrore, 'SEBI ₹ per crore', 1000)
  if ('problem' in sebi) return sebi
  const gst = num(f.gstPct, 'GST %', 50)
  if ('problem' in gst) return gst
  const brokerage = (b: BrokerageForm, label: string): Brokerage | { problem: string } => {
    const a = num(b.amount, label, 10000)
    return 'problem' in a ? a : { mode: b.mode, amount: a.value }
  }
  const def = brokerage(f.def, 'Default brokerage amount')
  if ('problem' in def) return def
  const byTrader: Record<string, Brokerage> = {}
  for (const [name, b] of Object.entries(f.byTrader)) {
    const r = brokerage(b, `${name} brokerage amount`)
    if ('problem' in r) return r
    byTrader[name] = r
  }
  // confirmedBy/confirmedAt are the server's to stamp; carrying the prior ones is harmless.
  return { charges: { ...seg, sebiPerCrore: sebi.value, gstPct: gst.value, brokerage: { default: def, byTrader }, confirmedBy: prior.confirmedBy, confirmedAt: prior.confirmedAt } }
}

/** `19 Oct 2026` of an epoch-ms instant, in IST. */
function dayText(ms: number): string {
  const [y, m, d] = istDay(ms).split('-')
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface SegRow extends Record<string, unknown> { id: Segment; label: string }
interface OverrideRow extends Record<string, unknown> { name: string }

export function AdminCharges(): React.ReactElement {
  const [saved, setSaved] = useState<ChargeRates | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [traders, setTraders] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    tapi.chargeSettings().then(
      (r) => {
        if (!live) return
        if (r.charges?.brokerage === undefined) { setError('Could not load the charges: unexpected reply'); return }
        setSaved(r.charges); setForm(toForm(r.charges))
      },
      (err: unknown) => { if (live) setError(`Could not load the charges: ${message(err)}`) },
    )
    tapi.adminTraders().then((rows) => { if (live) setTraders(rows.map((r) => r.username)) }, () => {})
    return () => { live = false }
  }, [])

  if (form === null || saved === null) {
    return error !== null ? <Banner status="error" title={error} /> : <Text color="secondary">Loading charges…</Text>
  }

  const patch = (fn: (f: Form) => Form): void => { setForm(fn(form)) }
  const setSeg = (s: Segment, k: keyof SegmentRates, v: string): void =>
    patch((f) => ({ ...f, seg: { ...f.seg, [s]: { ...f.seg[s], [k]: v } } }))
  const setOverride = (name: string, b: BrokerageForm): void => patch((f) => ({ ...f, byTrader: { ...f.byTrader, [name]: b } }))
  const removeOverride = (name: string): void => patch((f) => {
    const { [name]: _gone, ...rest } = f.byTrader
    return { ...f, byTrader: rest }
  })

  const save = async (): Promise<void> => {
    const body = chargesBody(form, saved)
    if ('problem' in body) { setError(body.problem); return }
    setBusy(true); setError(null)
    try {
      const r = await tapi.putChargeSettings(body.charges)
      if (r.charges?.brokerage === undefined) { setError('Could not save the charges: unexpected reply'); return }
      setSaved(r.charges); setForm(toForm(r.charges))
    } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }

  const segColumns: TableColumn<SegRow>[] = [
    { key: 'segment', header: 'Segment', renderCell: (r) => <Text size="sm" weight="bold">{r.label}</Text> },
    ...SEGMENT_FIELDS.map(([k, label]): TableColumn<SegRow> => ({
      key: k, header: label,
      renderCell: (r) => <TextInput label={`${r.label} ${label}`} isLabelHidden size="sm" width={104} value={form.seg[r.id][k]} onChange={(v) => setSeg(r.id, k, v)} />,
    })),
  ]
  const segRows: SegRow[] = SEGMENTS.map(([id, label]) => ({ id, label }))

  const brokerageFields = (label: string, b: BrokerageForm, set: (b: BrokerageForm) => void): React.ReactElement => (
    <HStack gap={2} align="end" wrap="wrap">
      <Selector label={`${label} brokerage mode`} isLabelHidden size="sm" width={128} options={MODES} value={b.mode}
        onChange={(v) => set({ ...b, mode: v === 'lot' ? 'lot' : 'order' })} />
      <TextInput label={`${label} brokerage amount`} isLabelHidden size="sm" width={104} value={b.amount} onChange={(v) => set({ ...b, amount: v })} />
    </HStack>
  )
  const overrideRows: OverrideRow[] = Object.keys(form.byTrader).sort().map((name) => ({ name }))
  const overrideColumns: TableColumn<OverrideRow>[] = [
    { key: 'name', header: 'Trader', renderCell: (r) => <Text size="sm" weight="bold">{r.name}</Text> },
    { key: 'brokerage', header: 'Brokerage', renderCell: (r) => brokerageFields(r.name, form.byTrader[r.name]!, (b) => setOverride(r.name, b)) },
    { key: 'remove', header: '', renderCell: (r) => <Button size="sm" variant="secondary" label="Remove" onClick={() => removeOverride(r.name)} /> },
  ]
  const addable = traders.filter((t) => form.byTrader[t] === undefined)

  return (
    <VStack gap={3}>
      <Text color="secondary" size="sm">
        These rates only feed the charge estimates on the analysis pages. They do not change what any broker charges and nothing here places an order.
      </Text>
      {saved.confirmedBy === null
        ? <Caveats items={['Seed values — not confirmed. Check each against the current rates before saving.']} kind="warning" />
        : <Banner status="success" title={`Confirmed by ${saved.confirmedBy} on ${saved.confirmedAt === null ? '—' : dayText(saved.confirmedAt)}`} />}
      {error !== null ? <Banner status="error" title={error} /> : null}
      <TradersTable data={segRows} columns={segColumns} density="compact" />
      <HStack gap={3} wrap="wrap">
        <TextInput label="SEBI ₹ per crore" value={form.sebiPerCrore} onChange={(v) => patch((f) => ({ ...f, sebiPerCrore: v }))} />
        <TextInput label="GST %" value={form.gstPct} onChange={(v) => patch((f) => ({ ...f, gstPct: v }))} />
      </HStack>
      <VStack gap={1}>
        <Text weight="bold">Default brokerage</Text>
        {brokerageFields('Default', form.def, (b) => patch((f) => ({ ...f, def: b })))}
      </VStack>
      <VStack gap={1}>
        <Text weight="bold">Per-trader brokerage</Text>
        {overrideRows.length === 0
          ? <Text color="secondary" size="sm">No overrides — every trader uses the default.</Text>
          : <TradersTable data={overrideRows} columns={overrideColumns} density="compact" />}
        <HStack gap={1} wrap="wrap">
          {addable.map((t) => (
            <Button key={t} size="sm" variant="secondary" label={`Add override for ${t}`}
              onClick={() => setOverride(t, { ...form.def })} />
          ))}
        </HStack>
      </VStack>
      <HStack gap={2}>
        <Button variant="primary" label="Save charges" isDisabled={busy} onClick={() => void save()} />
      </HStack>
    </VStack>
  )
}
