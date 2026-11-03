/**
 * IS desk-api's REPAIR APPLY SPEAKING FOR THIS BOOK RIGHT NOW?
 *
 * `decide()` stands the whole action pass down while a repair is working
 * (`engine.ts` step 2, ported from `driver.py:696-714`): mid-repair the book is
 * neither the pre-repair position nor the post-repair one, and a decision taken
 * against it is a decision about a position that does not exist. The engine
 * takes that as a boolean input; this file is where the boolean comes from.
 *
 * ── IT READS desk-api's OWN LOOKUP, NOT A SECOND COPY OF THE RULE ───────────
 * "Held" is a surprisingly rich predicate — a RUNNING run holds to its TTL, a
 * FINISHED one holds for the adoption grace past its last write, a run that
 * placed nothing holds nothing, and the strongest hold on a tag wins
 * (`repair-apply.ts:holdsBook` / `holdingOnTag`). Every one of those clauses was
 * added because of something that went wrong, and a supervisor with its own
 * query would agree with all of it on the day it was written and drift the first
 * time one changes — silently, because the failure is "the supervisor traded
 * through a repair" and nothing throws.
 *
 * So the hold comes from `repairHoldLookup`, the function `/v1/desk/positions`
 * already reads it through. The cross-app import is the house pattern
 * (`state-store.ts` reaches for `../../api/src/errors.ts`, and desk-api's engine
 * route reaches back for the state store).
 *
 * ── WHICH WAY IT FAILS ──────────────────────────────────────────────────────
 * TOWARD THE HOLD. A read that THREW has not said "nothing is running" — it has
 * said nothing at all — and the two possible mistakes are not symmetrical:
 * standing a book down for a few seconds costs a mark, while trading through a
 * repair means the engine re-decides a book whose legs it has not caught up
 * with, on top of orders the repair is placing.
 *
 * The one thing that fails toward FALSE is a deployment with no repair feature
 * wired at all (`NO_REPAIR_HOLD`): a supervisor that stood every book down
 * forever because nothing had told it about repairs would be a supervisor that
 * never trades. An absent collection is not an error — `findOne` answers `null`
 * — so this distinction is between "not wired" and "wired and broken", which is
 * exactly the distinction the two entry points below make.
 */

import { repairHoldLookup } from '../../api/src/repair-apply.ts'
import type { Database } from '../../api/src/store.ts'
import type { HostLog } from './engine-host.ts'

/**
 * The hold on one tag, or `null`. Structurally what `repairHoldLookup` returns
 * — narrowed to the one field a log line needs, so a change to `RepairHold`'s
 * other fields is not a change to this seam.
 */
export type RepairHoldLookup = (tag: string) => Promise<{ readonly untilMs: number } | null>

/** desk-api's own hold lookup, bound to a database. One implementation, shared. */
export function repairHoldLookupFor(db: Database, now: () => number): RepairHoldLookup {
  return repairHoldLookup(db, now)
}

/** A deployment with no repair feature: nothing ever holds. See the header. */
export const NO_REPAIR_HOLD = async (): Promise<boolean> => false

/**
 * The per-book reader the host takes as `repairHold()`.
 *
 * Logged at WARN when a hold is in force — it is the reason an operator will
 * see no decisions for a minute — and at ERROR when the read itself failed,
 * because that is the state where the book is standing down for a reason nobody
 * can see. Both are rate-limited to once per hold window: this is called on
 * every tick of every book.
 */
export function repairHoldReader(deps: {
  readonly lookup: RepairHoldLookup
  readonly tag: string
  readonly log: HostLog
  now(): number
}): () => Promise<boolean> {
  let quietUntil = 0
  const sayOnce = (level: 'warn' | 'error', msg: string, ctx: Record<string, unknown>): void => {
    const at = deps.now()
    if (at < quietUntil) return
    quietUntil = at + 60_000
    deps.log[level](msg, ctx)
  }

  return async (): Promise<boolean> => {
    try {
      const hold = await deps.lookup(deps.tag)
      if (hold === null) return false
      sayOnce('warn', 'repair-Apply is working this tag — the engine is standing down', {
        tag: deps.tag,
        untilMs: hold.untilMs,
      })
      return true
    } catch (err) {
      sayOnce('error', 'the repair hold could not be read — HOLDING, which is the safe direction', {
        tag: deps.tag,
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }
}
