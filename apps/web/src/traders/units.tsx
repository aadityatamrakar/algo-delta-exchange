/**
 * Per share / per lot / whole position for the BOOK's figures — Analysis's
 * Total, Month Wise, Option Greeks and Greeks Comparison rows, Scenario's top
 * row and plain grid metrics, the payoff chart and table — and the toggle that
 * picks between them. The leg tables follow VolHedge whatever the toggle:
 * plain greeks per share, value columns the whole leg.
 */

import type { ReactElement } from 'react'
import { HStack } from '@astryxdesign/core/Layout'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { InfoTip } from './fold.tsx'
import { useUnits } from './viewer.ts'

export type Units = 'share' | 'lot' | 'position'

const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0

/** A whole-book figure in the chosen units. `lotGcd` is the book's common lot count. */
export function scaleBook(value: number, u: Units, lotSize: number | null, lotGcd: number): number {
  if (!positive(lotSize) || !positive(lotGcd) || u === 'position') return value
  return u === 'lot' ? value / lotGcd : value / (lotGcd * lotSize)
}

const UNKNOWN = { title: 'Lot size unknown' }

export function UnitsToggle(props: { readonly lotSize: number | null }): ReactElement {
  const { units, setUnits } = useUnits()
  const unknown = props.lotSize === null
  return (
    <HStack gap={1} align="center">
      <SegmentedControl size="sm" value={unknown ? 'position' : units} onChange={(v) => setUnits(v as Units)} label="Units">
        <SegmentedControlItem value="share" label="Per share" isDisabled={unknown} {...(unknown ? UNKNOWN : {})} />
        <SegmentedControlItem value="lot" label="Per lot" isDisabled={unknown} {...(unknown ? UNKNOWN : {})} />
        <SegmentedControlItem value="position" label="Whole position" />
      </SegmentedControl>
      <InfoTip label="the units">
        Book figures: per lot = this book ÷ its common lot count; per share = per lot ÷ lot size. Leg tables: greeks per share, values the whole leg
      </InfoTip>
    </HStack>
  )
}
