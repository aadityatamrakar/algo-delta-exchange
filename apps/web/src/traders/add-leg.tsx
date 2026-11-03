/**
 * Add a leg by hand, edit one, delete one. Manual legs cover what ODIN's trade
 * files cannot: positions opened before the history starts and shares delivered
 * at expiry. They are records for the analysis — nothing here sends an order.
 */

import { useEffect, useState } from 'react'
import { VStack, HStack, Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Text } from '@astryxdesign/core/Text'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Selector } from '@astryxdesign/core/Selector'
import { TextInput } from '@astryxdesign/core/TextInput'
import { inr } from '../format.ts'
import type { Instrument, LegView, OptType } from '../../../traders/src/types.ts'
import type { ContractsView } from '../../../traders/src/analytics/r3-wire.ts'
import { tapi } from './api.ts'
import { EMPTY_LEG_FORM, legBody, legName, lotsOf, type LegForm } from './wire.ts'

const INSTRUMENTS: { value: Instrument; label: string }[] = [
  { value: 'share', label: 'share' },
  { value: 'future', label: 'future' },
  { value: 'option', label: 'option' },
]
const OPT_TYPES: OptType[] = ['CE', 'PE']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** '2026-10-27' as '27 Oct 2026 (Tue)', the way a trader reads an expiry. */
function expiryLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${d} ${MONTHS[m - 1]} ${y} (${day})`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** "= 4 lots" under the quantity, so a share count is never typed blind. */
function lotNote(qty: string, lotSize: number | null): string {
  if (lotSize === null) return 'shares, signed — negative is short (lot size not known for this book)'
  const n = Number(qty)
  const lots = qty.trim() === '' || !Number.isFinite(n) ? null : lotsOf(n, lotSize)
  const head = `1 lot = ${inr(lotSize)} shares · signed shares, negative is short`
  return lots === null ? head : `${head} · ${inr(lots, Number.isInteger(lots) ? 0 : 2)} lots`
}

export function AddLegDialog(props: {
  stock: string
  lotSize: number | null
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const [form, setForm] = useState<LegForm>(EMPTY_LEG_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<LegForm>): void => setForm((f) => ({ ...f, ...patch }))
  // The stock's listed contracts fill Expiry and Strike; a stock the master does not list keeps the typed fields.
  const [contracts, setContracts] = useState<ContractsView | null>(null)
  useEffect(() => {
    let alive = true
    tapi.contracts(props.stock).then((c) => { if (alive) setContracts(c) }, () => { if (alive) setContracts(null) })
    return () => { alive = false }
  }, [props.stock])
  const expiries = (contracts?.expiries ?? []).filter((e) => form.instrument !== 'future' || e.future)
  const chosen = expiries.find((e) => e.expiry === form.expiry) ?? null
  // the nearest listed expiry until one is picked; a pick that the instrument does not list falls back to it
  useEffect(() => {
    const first = expiries[0]
    if (form.instrument !== 'share' && first !== undefined && chosen === null) set({ expiry: first.expiry, strike: '' })
  }, [contracts, form.instrument, form.expiry])
  const lotSize = chosen?.lotSize ?? props.lotSize

  const save = async (): Promise<void> => {
    const made = legBody(form)
    if ('problem' in made) { setError(made.problem); return }
    setBusy(true)
    setError(null)
    try {
      await tapi.addLeg(props.stock, made.body)
      props.onSaved()
      props.onClose()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title={`Add leg · ${props.stock}`} onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text color="secondary" size="sm">
                A record of a position you already hold, for this analysis. Nothing is sent to any exchange or broker.
              </Text>
              {error !== null ? <Banner status="error" title={error} /> : null}
              <Selector
                label="Instrument"
                options={INSTRUMENTS}
                value={form.instrument}
                onChange={(v) => set({ instrument: v as Instrument })}
              />
              {form.instrument === 'share' ? null : expiries.length > 0 ? (
                <Selector
                  label="Expiry"
                  options={expiries.map((e) => ({ value: e.expiry, label: expiryLabel(e.expiry) }))}
                  value={form.expiry}
                  onChange={(v) => set({ expiry: v, strike: '' })}
                />
              ) : (
                <TextInput label="Expiry (YYYY-MM-DD)" value={form.expiry} onChange={(v) => set({ expiry: v })} />
              )}
              {form.instrument === 'option' ? (
                <HStack gap={3} align="start">
                  {chosen !== null && chosen.strikes.length > 0 ? (
                    <Selector
                      label="Strike"
                      options={chosen.strikes.map((k) => ({ value: String(k), label: inr(k, Number.isInteger(k) ? 0 : 2) }))}
                      {...(form.strike === '' ? {} : { value: form.strike })}
                      placeholder="Pick a strike"
                      hasSearch
                      searchPlaceholder="Type a strike"
                      onChange={(v) => set({ strike: v })}
                    />
                  ) : (
                    <TextInput label="Strike" value={form.strike} onChange={(v) => set({ strike: v })} />
                  )}
                  <Selector
                    label="CE / PE"
                    options={OPT_TYPES}
                    value={form.optType}
                    onChange={(v) => set({ optType: v as OptType })}
                  />
                </HStack>
              ) : null}
              <TextInput
                label="Quantity (shares)"
                value={form.qty}
                onChange={(v) => set({ qty: v })}
                description={lotNote(form.qty, lotSize)}
              />
              <TextInput label="Average price" value={form.avgPrice} onChange={(v) => set({ avgPrice: v })} />
              <TextInput label="Note" value={form.note} onChange={(v) => set({ note: v })} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={props.onClose} />
              <Button variant="primary" label="Save leg" isDisabled={busy} onClick={() => void save()} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

/** Quantity, average price and note of a manual leg; the contract itself is not editable. */
export function EditLegDialog(props: {
  stock: string
  leg: LegView
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const { leg } = props
  const [qty, setQty] = useState(String(leg.qty))
  const [avg, setAvg] = useState(String(leg.avgPrice))
  const [note, setNote] = useState(leg.note)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const q = Number(qty)
    const a = Number(avg)
    if (qty.trim() === '' || !Number.isInteger(q) || q === 0) { setError('Quantity must be a non-zero whole number of shares.'); return }
    if (avg.trim() === '' || !Number.isFinite(a) || a < 0) { setError('Average price must be a number, zero or more.'); return }
    setBusy(true)
    setError(null)
    try {
      await tapi.patchLeg(leg.key, { qty: q, avgPrice: a, note })
      props.onSaved()
      props.onClose()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={`Edit leg · ${legName(props.stock, leg)}`} onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {error !== null ? <Banner status="error" title={error} /> : null}
              <TextInput
                label="Quantity (shares)" value={qty} onChange={setQty}
                description={lotNote(qty, leg.lotSize)}
              />
              <TextInput label="Average price" value={avg} onChange={setAvg} />
              <TextInput label="Note" value={note} onChange={setNote} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={props.onClose} />
              <Button variant="primary" label="Save" isDisabled={busy} onClick={() => void save()} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

/** Asks before removing a manual leg. */
export function DeleteLegDialog(props: {
  stock: string
  leg: LegView
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await tapi.deleteLeg(props.leg.key)
      props.onSaved()
      props.onClose()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="form" width={440}>
      <Layout
        header={<DialogHeader title="Delete leg" onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {error !== null ? <Banner status="error" title={error} /> : null}
              <Text>{`Remove ${legName(props.stock, props.leg)} from this book? It only deletes your record.`}</Text>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button variant="secondary" label="Cancel" onClick={props.onClose} />
              <Button variant="destructive" label="Delete leg" isDisabled={busy} onClick={() => void remove()} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
