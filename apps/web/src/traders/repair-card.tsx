/**
 * The repair search's plans, laid out to be read at a glance: the do-nothing reference once, then per goal its
 * best plan as three figures and a small trade table, the rest folded. Presentation only — the server's
 * RepairView as it comes, and each plan's one control is "Show on payoff" (spec item 6: nothing here trades).
 */

import { useState, type ReactElement } from 'react'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import type { TableColumn } from '@astryxdesign/core/Table'
import { TradersTable } from './table.tsx'
import { Heading, Text } from '@astryxdesign/core/Text'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import { GREEN, RED, inr, money } from '../format.ts'
import type { RepairCardPlan, RepairView } from '../../../traders/src/analytics/r3-wire.ts'
import type { LegView } from '../../../traders/src/types.ts'
import { openWhatIf } from './what-if.ts'

type Goal = RepairView['goals'][number]['goal']
type Move = RepairCardPlan['moves'][number]
type WhatIfRow = RepairCardPlan['whatIf'][number]

/** The four searches (packages/payoff goals.ts), in a trader's words. */
export const GOAL_TEXT: Readonly<Record<Goal, { title: string; about: string }>> = {
  'REDUCE-LOSS': { title: 'Reduce loss', about: 'Makes the worst loss at expiry as small as it can; nothing else is traded off.' },
  'PROFITABLE-BY-EXPIRY': { title: 'Profitable by expiry', about: 'Widens the range of expiry prices where the book ends in profit.' },
  'CHEAP-TAIL-CAP': { title: 'Cheap tail cap', about: 'Gets the worst loss under a cap for the least cash spent.' },
  'MAX-CREDIT-SAFE': { title: 'Max credit, safe', about: 'Collects the most premium without making the worst loss any worse.' },
}

/** Every tag the search can put on a plan but `baseline` (the line at the top) and `no-feasible-plan` (said per goal). */
export const FLAG_TEXT: Readonly<Record<string, { label: string; about: string }>> = {
  'degrades-floor': { label: 'Worse worst case', about: 'Its worst loss at expiry is deeper than doing nothing.' },
  'bot-may-reshift': { label: 'Bot may re-strike', about: "The desk bot's own re-strike rule could shift this leg again." },
  'bot-rebalance-pending': { label: 'Bot rebalance due', about: 'The desk bot is about to rebalance this book.' },
}
const SILENT_FLAGS = new Set(['baseline', 'no-feasible-plan'])

/** Rupees in short form: 950, 62.7 k, 2.18 L, 1.25 Cr. The magnitude only; `signedShort` adds the sign. */
export function short(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e7) return `${(a / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `${(a / 1e5).toFixed(2)} L`
  if (a >= 1e3) return `${(a / 1e3).toFixed(1)} k`
  return String(Math.round(a))
}

export function signedShort(v: number): string {
  return `${v < 0 ? '−' : v > 0 && Number.isFinite(v) ? '+' : ''}${short(v)}`
}

const price = (at: number): string => inr(at, 0)

/** A zeroed score is a search that never ran (goals.ts `baselinesOnly`): no reference to quote. */
function computed(p: RepairCardPlan): boolean {
  const s = p.score
  return !(s.maxLoss === 0 && s.maxLossAt === 0 && s.marginBefore === 0 && s.marginAfter === 0)
}

/** The do-nothing plan every goal ends with; the first one that was computed. */
export function baselineOf(view: RepairView): RepairCardPlan | null {
  for (const g of view.goals) for (const p of g.plans) if (p.moves.length === 0 && computed(p)) return p
  return null
}

export function baselineText(base: RepairCardPlan | null): string {
  if (base === null) return 'Now (do nothing): not computed'
  const s = base.score
  return s.maxLoss < 0
    ? `Now (do nothing): worst loss ₹${short(s.maxLoss)} at ${price(s.maxLossAt)}`
    : `Now (do nothing): no loss at expiry on the scan — worst case ₹${signedShort(s.maxLoss)} at ${price(s.maxLossAt)}`
}

export type TradeRow = { readonly side: 'Buy' | 'Sell'; readonly qty: number; readonly contract: string; readonly price: number | null; readonly mark: 'close' | 'shift' | null }

const contractOf = (strike: number | null, type: string | null): string => (strike === null || type === null ? 'FUT' : `${strike} ${type}`)
const sideOf = (qty: number): 'Buy' | 'Sell' => (qty < 0 ? 'Sell' : 'Buy')

/**
 * A plan's trades, one row per contract bought or sold, in the order they would be placed: an add or hedge is one
 * row, a close one (marked), a shift two (both marked). Prices come off the plan's own Show-on-payoff rows, which
 * the server writes in the same order and leaves out where the chain has no price.
 */
export function tradeRows(plan: RepairCardPlan, legs: readonly LegView[]): TradeRow[] {
  let at = 0
  const take = (match: (r: WhatIfRow) => boolean): WhatIfRow | null => {
    const r = plan.whatIf[at]
    if (r === undefined || !match(r)) return null
    at += 1
    return r
  }
  const out: TradeRow[] = []
  const exitOf = (m: Extract<Move, { legId: string }>, mark: 'close' | 'shift'): LegView | null => {
    const leg = legs.find((l) => l.key === m.legId) ?? null
    if (leg === null) {
      const r = take(() => true)
      if (r !== null) out.push({ side: sideOf(r.qty), qty: r.qty, contract: contractOf(r.strike, r.optType), price: r.price, mark })
      return null
    }
    const r = take((w) => w.strike === leg.strike && w.optType === leg.optType && w.qty === -leg.qty)
    out.push({ side: sideOf(-leg.qty), qty: -leg.qty, contract: contractOf(leg.strike, leg.optType), price: r?.price ?? null, mark })
    return leg
  }
  for (const m of plan.moves) {
    if (m.op === 'add' || m.op === 'hedge') {
      const r = take((w) => w.strike === m.strike && w.optType === m.type && w.qty === m.qty)
      out.push({ side: sideOf(m.qty), qty: m.qty, contract: contractOf(m.strike, m.type), price: r?.price ?? null, mark: null })
    } else if (m.op === 'close') {
      exitOf(m, 'close')
    } else if (m.op === 'future') {
      // The repair menu proposes no futures (REPAIR_OPS); a plan from the objective search can.
      const r = take((w) => w.strike === null && w.qty === m.qty)
      out.push({ side: sideOf(m.qty), qty: m.qty, contract: contractOf(null, null), price: r?.price ?? null, mark: null })
    } else {
      const leg = exitOf(m, 'shift')
      if (leg === null) {
        const r = take(() => true)
        if (r !== null) out.push({ side: sideOf(r.qty), qty: r.qty, contract: contractOf(r.strike, r.optType), price: r.price, mark: 'shift' })
      } else {
        const r = take((w) => w.strike === m.toStrike && w.optType === leg.optType && w.qty === leg.qty)
        out.push({ side: sideOf(leg.qty), qty: leg.qty, contract: contractOf(m.toStrike, leg.optType), price: r?.price ?? null, mark: 'shift' })
      }
    }
  }
  return out
}

/** Lots when the size is whole lots, else shares. */
export function lotsText(qty: number, lotSize: number | null): string {
  const n = Math.abs(qty)
  return lotSize !== null && lotSize > 0 && Number.isInteger(n / lotSize) ? String(n / lotSize) : `${n} sh`
}

/** Goals whose plans repeat an earlier goal's, mapped to that goal. */
export function sameAs(goals: RepairView['goals']): ReadonlyMap<Goal, Goal> {
  const first = new Map<string, Goal>()
  const out = new Map<Goal, Goal>()
  for (const g of goals) {
    const plans = g.plans.filter((p) => p.moves.length > 0)
    if (plans.length === 0) continue
    const key = JSON.stringify(plans.map((p) => p.moves))
    const earlier = first.get(key)
    if (earlier === undefined) first.set(key, g.goal)
    else out.set(g.goal, earlier)
  }
  return out
}

function Figure(p: { label: string; value: string; sub?: string; tip: string; style?: Record<string, string> }): ReactElement {
  return (
    <Tooltip content={p.tip}>
      <VStack gap={0}>
        <Text size="sm" color="secondary">{p.label}</Text>
        <Text size="sm" weight="bold" {...(p.style === undefined ? {} : { style: p.style })}>{p.value}</Text>
        {p.sub === undefined ? null : <Text size="sm" color="secondary">{p.sub}</Text>}
      </VStack>
    </Tooltip>
  )
}

function PlanView(p: { stock: string; goal: Goal; plan: RepairCardPlan; number: number; base: RepairCardPlan | null; legs: readonly LegView[] }): ReactElement {
  const { plan, base } = p
  const s = plan.score
  const title = GOAL_TEXT[p.goal].title
  const lotSize = p.legs.find((l) => l.lotSize !== null)?.lotSize ?? null
  const rows = tradeRows(plan, p.legs)
  const columns: TableColumn<TradeRow>[] = [
    {
      key: 'action', header: 'Action',
      renderCell: (r) => (
        <HStack gap={1} align="center">
          <Text size="sm" weight="bold" style={r.side === 'Buy' ? GREEN : RED}>{r.side}</Text>
          {r.mark === null ? null : <Badge variant="neutral" label={r.mark} />}
        </HStack>
      ),
    },
    { key: 'lots', header: 'Lots', renderCell: (r) => <Text size="sm">{lotsText(r.qty, lotSize)}</Text> },
    { key: 'contract', header: 'Contract', renderCell: (r) => <Text size="sm">{r.contract}</Text> },
    { key: 'price', header: 'Price', renderCell: (r) => <Text size="sm">{r.price === null ? '—' : inr(r.price, 2)}</Text> },
  ]
  const credit = s.credit >= 0
  const flags = plan.flags.filter((f) => !SILENT_FLAGS.has(f))
  return (
    <VStack gap={2}>
      <HStack gap={4} align="start" justify="between" wrap="wrap">
        <HStack gap={4} align="start" wrap="wrap">
          <Figure label={credit ? 'Credit' : 'Debit'} value={`₹${short(s.credit)}`} style={credit ? GREEN : RED}
            tip={`${credit ? 'Cash in' : 'Cash out'}: ₹${inr(Math.abs(s.credit))}`} />
          <Figure label="Worst loss" value={`${signedShort(s.maxLoss)} at ${price(s.maxLossAt)}`}
            {...(base === null ? {} : { sub: `was ${signedShort(base.score.maxLoss)}` })}
            tip={`Worst P&L at expiry: ₹${money(s.maxLoss)} at ${inr(s.maxLossAt, 2)}${base === null ? '' : `; now ₹${money(base.score.maxLoss)}`}`} />
          <Figure label="Margin (est.)" value={signedShort(s.marginDelta)}
            tip={`Margin change, estimate: ₹${money(s.marginDelta)} (positive needs more margin)`} />
          {flags.map((f) => {
            const t = FLAG_TEXT[f]
            return t === undefined
              ? <Badge key={f} variant="neutral" label={f} />
              : <Tooltip key={f} content={t.about}><Badge variant="warning" label={t.label} /></Tooltip>
          })}
        </HStack>
        {plan.whatIf.length === 0 ? null : (
          <Button size="sm" variant="secondary" label="Show on payoff" aria-label={`Show on payoff — ${title} plan ${p.number}`}
            onClick={() => openWhatIf(p.stock, plan.whatIf, `Repair: ${title} ${p.number}`)} />
        )}
      </HStack>
      {rows.length === 0 ? null : <TradersTable aria-label="Trades" data={rows} columns={columns} density="compact" />}
    </VStack>
  )
}

function GoalSection(p: { stock: string; goal: Goal; plans: readonly RepairCardPlan[]; same: Goal | undefined; base: RepairCardPlan | null; legs: readonly LegView[] }): ReactElement {
  const [open, setOpen] = useState(false)
  const text = GOAL_TEXT[p.goal]
  const plans = p.plans.filter((x) => x.moves.length > 0)
  const shown = open ? plans : plans.slice(0, 1)
  const folded = plans.length - 1
  return (
    <VStack gap={2}>
      <VStack gap={0}>
        <Heading level={5}>{text.title}</Heading>
        <Text size="sm" color="secondary">{text.about}</Text>
      </VStack>
      {p.same !== undefined ? <Text size="sm">{`Same plans as ${GOAL_TEXT[p.same].title}`}</Text>
        : plans.length === 0 ? <Text size="sm" color="secondary">No plan meets this goal</Text>
          : shown.map((plan, i) => <PlanView key={i} stock={p.stock} goal={p.goal} plan={plan} number={i + 1} base={p.base} legs={p.legs} />)}
      {p.same !== undefined || folded <= 0 ? null : (
        <HStack>
          <Button size="sm" variant="ghost" label={open ? 'Fewer plans' : `${folded} more ${folded === 1 ? 'plan' : 'plans'}`}
            onClick={() => setOpen((o) => !o)} />
        </HStack>
      )}
    </VStack>
  )
}

/** The plans of a search that ran: the reference line, then each goal. */
export function RepairPlans(p: { stock: string; view: RepairView; legs: readonly LegView[] }): ReactElement {
  const base = baselineOf(p.view)
  const same = sameAs(p.view.goals)
  return (
    <VStack gap={4}>
      <Text size="sm" weight="bold">{baselineText(base)}</Text>
      {p.view.goals.map((g) => (
        <GoalSection key={g.goal} stock={p.stock} goal={g.goal} plans={g.plans} same={same.get(g.goal)} base={base} legs={p.legs} />
      ))}
    </VStack>
  )
}
