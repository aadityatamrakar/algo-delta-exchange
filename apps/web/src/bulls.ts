/**
 * The two BULL-S operator requests: CLOSE BOOK and RE-ARM.
 *
 * Both are COUNTERS, not flags. The dashboard PATCHes `bs_close_req` /
 * `bs_rearm_req` to the row's current value +1; the engine acts once when the
 * dial exceeds the value it last saw (`state.*ReqSeen`). A flag would need a
 * second write to clear, and a double click on a flag is indistinguishable
 * from one — a counter makes every press its own request and every repeat
 * idempotent at the engine.
 *
 * The patch carries ONLY that dial: the registry PATCH is a merge, and
 * re-sending the rest would pin every dial onto the row.
 */
import type { BookRow, DialValue } from './api.ts'

export type BullSAction = 'close' | 'rearm'

const DIAL: Record<BullSAction, 'bs_close_req' | 'bs_rearm_req'> = {
  close: 'bs_close_req',
  rearm: 'bs_rearm_req',
}

/** A BULL-S book: its dials have `bs_enabled` true. */
export function isBullS(row: Pick<BookRow, 'dials'>): boolean {
  return row.dials['bs_enabled'] === true
}

/** `{bs_close_req: n + 1}` / `{bs_rearm_req: n + 1}`, from the row's current value (absent = 0). */
export function bullsPatch(row: Pick<BookRow, 'dials'>, action: BullSAction): Record<string, DialValue> {
  const key = DIAL[action]
  const cur = row.dials[key]
  const n = typeof cur === 'number' && Number.isFinite(cur) ? cur : 0
  return { [key]: n + 1 }
}

/** The confirmation each request asks before it is sent. */
export function bullsStatement(tag: string, action: BullSAction): string {
  return action === 'close'
    ? `Close every leg of ${tag} and halt it. It opens nothing more until it is re-armed.`
    : `Re-arm ${tag}: clear its halt, so it may enter again at the next level.`
}
