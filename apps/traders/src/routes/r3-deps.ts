/**
 * Release 3's route deps: TradersDeps plus what createApp builds for Market
 * Watch, groups, repair, the band and advice, and Portfolio. Types only; each
 * Release 3 task adds its own field, one line each.
 */

import type { GroupStore } from '../books/groups.ts'
import type { RepairPool } from '../analytics/repair-pool.ts'
import type { BandOverrideStore } from '../analytics/band.ts'
import type { BandBoard } from '../analytics/band-board.ts'
import type { BookRisk } from '../analytics/risk.ts'
import type { TradersDeps } from '../deps.ts'
import type { OnScreenSet } from '../market/on-screen.ts'

export type R3RouteDeps = TradersDeps & {
  readonly groups: GroupStore
  readonly repair: RepairPool
  readonly bands: BandOverrideStore
  readonly risk: BookRisk
  readonly board: BandBoard
  readonly onScreen: OnScreenSet
}
