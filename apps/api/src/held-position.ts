/**
 * What a tag HOLDS, rebuilt from the fills — the independent answer.
 *
 * ONE IMPLEMENTATION, because two guards depend on it and they guard the two
 * irreversible acts in the system: `POST /v1/desk/seed` with `replace: true`
 * (which OVERWRITES the book) and `DELETE .../registry/:tag` (which ERASES it).
 * Both ask the same question — "is anything actually open?" — and both must ask
 * something other than `desk-books`, since that is the very record about to be
 * replaced. Asking a record to defend itself is not a guard.
 *
 * It lived twice: `routes/desk.ts:positionFromFills` and a closure called
 * `openNow` inside `routes/books.ts`, byte-for-byte the same query with two
 * different names (audit F-53). Copies of a safety check drift, and the drift is
 * silent — the copy that stops carrying `unreadable`/`capped` still returns a
 * position, just a more confident one than it is entitled to.
 *
 * THE WINDOW IS EVERY FILL THAT EXISTS — `from: 0`, `to: MAX_SAFE_INTEGER` — and
 * that is deliberate. `flattenTag` bounds its read to a trading day because
 * hosted strategies are intraday by contract; a positional book is carried
 * across sessions, so ANY bound is a chance to miss the open and erase the
 * record of a live position. Reading too much is safe (a closed round trip nets
 * to zero); reading too little UNDERSTATES the position. For a one-off guard on
 * an irreversible action there is no reason to accept that risk to save a query.
 *
 * THE TWO FLAGS COME OUT WITH IT, and callers must treat them as blocking (F-32).
 * A corrupt stored fill drops a real leg entirely and the reconstruction comes
 * back EMPTY, so "no rows" means "nothing is open" only when both flags are
 * clear. `flattenIsFlat` already reads them that way; the guards on the harder-
 * to-reverse actions had been discarding them.
 */

import { buildPositions } from '@algomaker/pnl'
import type { DeskMode } from './contract.ts'
import { PnlStore, pnlKey } from './pnlstore.ts'
import type { DeskStore } from './store.ts'

export interface HeldFromFills {
  /** Contracts with a non-zero net quantity. A flat leg is not a position. */
  readonly held: { tradingsymbol: string; qty: number }[]
  /** Fills the P&L reader REFUSED, by contract. Non-empty ⇒ the answer is suspect. */
  readonly unreadable: readonly string[]
  /** The read hit its cap ⇒ the answer may be UNDERSTATED. */
  readonly capped: boolean
}

export async function heldFromFills(
  store: DeskStore,
  tag: string,
  mode: DeskMode,
): Promise<HeldFromFills> {
  const load = await new PnlStore(store).loadFills({
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
    tag,
    mode,
  })
  return {
    held: buildPositions(load.byKey.get(pnlKey(tag, mode)) ?? []).filter((p) => p.qty !== 0),
    unreadable: load.malformed,
    capped: load.truncated,
  }
}
