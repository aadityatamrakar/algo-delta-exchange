/**
 * R3's "Show on payoff": open a book's Scenario sub-tab with a set of legs as
 * its hypothetical rows.
 *
 * The legs go to the per-book viewer store (`viewer.ts`) and from there only
 * into the scenario request; nothing is saved and nothing is traded. A what-if
 * replaces the tab's hypothetical rows, which the viewer can then edit like
 * rows typed by hand.
 */

import type { HypotheticalLeg } from '../../../traders/src/analytics/wire.ts'
import { navigate } from './route.ts'
import { MAX_HYPOTHETICAL, patchScenario, type HypoRow, type RowKind } from './viewer.ts'
import { ivPoints } from './wire.ts'

/** A leg to show: a `HypotheticalLeg` without its id (given here), its IV optional (null = the market's). */
export type WhatIfLeg = Omit<HypotheticalLeg, 'id' | 'iv'> & { readonly iv?: number | null }

function kindOf(l: WhatIfLeg): RowKind | null {
  if (l.instrument === 'share') return 'EQ'
  if (l.instrument === 'future') return 'F'
  return l.optType === 'CE' ? 'C' : l.optType === 'PE' ? 'P' : null
}

/** The legs as rows `w1`, `w2`, …, quantities kept in shares as given. At most the server's 20. */
export function whatIfRows(legs: readonly WhatIfLeg[]): HypoRow[] {
  return legs.slice(0, MAX_HYPOTHETICAL).map((l, i) => ({
    id: `w${i + 1}`,
    kind: kindOf(l),
    expiry: l.instrument === 'share' ? '' : l.expiry,
    strike: l.instrument === 'option' ? l.strike : null,
    size: l.qty,
    lot: null,
    price: l.price,
    volPts: l.iv === undefined || l.iv === null ? null : ivPoints(l.iv),
  }))
}

/** Store `legs` as `stock`'s hypothetical rows under `From: <label>` and open its Scenario sub-tab. */
export function openWhatIf(stock: string, legs: readonly WhatIfLeg[], label: string): void {
  const from = legs.length > MAX_HYPOTHETICAL ? `${label} — the first ${MAX_HYPOTHETICAL} of ${legs.length} legs` : label
  patchScenario(stock, { rows: whatIfRows(legs), from })
  navigate(`/books/${encodeURIComponent(stock)}/scenario`)
}
