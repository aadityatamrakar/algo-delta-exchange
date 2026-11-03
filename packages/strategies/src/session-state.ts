/**
 * The restart-recovery substrate the four hosted strategy classes share.
 *
 * WHY THIS EXISTS: before it, `grep ctx.state packages/strategies/src` returned
 * nothing. No strategy persisted anything and none overrode `onDayEnd` or
 * `onRecover`, which made two live failures structural rather than accidental:
 *
 *  1. Every square-off path was a no-op while the portal reported success. The
 *     15:30 backstop, the operator switch-off, session rollover and SIGTERM all
 *     funnel into `StrategyBase.endDay()` -> `onDayEnd()`, and the base's
 *     `onDayEnd` is an empty method. Driving the real BN_BREAKOUT config to
 *     15:30 produced state `squared-off` and ZERO orders. The only thing that
 *     ever exited was each strategy's own `squareOff` cron job — which does not
 *     run at all if the process restarted after its cron time.
 *  2. A mid-session restart abandoned the position AND could open a second one.
 *     `StrategyBase.start()` runs `onDayStart()` BEFORE `onRecover()`, and every
 *     `onDayStart` here resets the position field to null and clears the
 *     once-per-day flags. Restart at 12:30 holding an option: nothing could ever
 *     exit it. Restart at 11:00 with a 13:30 deadline: the band-forming job is
 *     `replayable: true` so it replays, `tradedSides` is clear again, and a
 *     SECOND position opens on top of the live one.
 *
 * ONE KEY, ONE WRITE. Each class persists a single snapshot object rather than a
 * key per field. `StateStore.set` is the only atomic unit available, so two keys
 * means a crash can land between them — and the two orderings fail differently:
 * position-then-flags loses "already traded this side" (re-entry after the
 * position closes), flags-then-position loses the POSITION (nothing can ever
 * exit it). A single snapshot has neither hazard.
 *
 * SESSION STAMPING. Every record carries the IST day it was written on and
 * `loadSessionState` refuses one from any other day. These are all intraday
 * strategies that flatten at square-off, so a record stamped with an older day
 * is evidence that yesterday's flatten did not complete — not a position today's
 * instance may adopt. Adopting it would have the strategy submit an exit for
 * something whose option contract may no longer be listed, sized off yesterday's
 * lots, and would resurrect yesterday's `tradedSides` into a fresh session. The
 * record is dropped and logged at WARN so the stale book is visible to an
 * operator instead of being silently re-traded. (The normal rollover path never
 * reaches this: `Runner.#rollSession` stops the old instance first, which runs
 * `onDayEnd` and clears the key.)
 *
 * Keys are namespaced by TAG by the store itself (`MongoStateStore` filters
 * every read and write on `{ tag, key }`), so a plain key here is already
 * per-strategy — ORB_SCALP_BN and ORB_SCALP_NIFTY cannot see each other's book.
 * The `strategy:` prefix keeps them clear of the runner's own `runner:positions`
 * ledger, which shares the same per-tag key space.
 */

import type { StrategyContext } from '@algomaker/strategy-kit'

/** The one key each strategy class stores its whole recoverable snapshot under. */
export const SESSION_STATE_KEY = 'strategy:session'

/** IST calendar day, `YYYY-MM-DD` — the same unit `Runner` keys a session by. */
export function istSessionDay(nowMs: number): string {
  return new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10)
}

interface Stamped<T> {
  readonly sessionDay: string
  readonly value: T
}

/**
 * Snapshot `value` durably.
 *
 * `structuredClone` is not decoration. `MemoryStateStore` keeps the reference it
 * is handed, so without a clone a later in-memory mutation of the same object
 * would retroactively rewrite "what was persisted" — a restart test would then
 * pass against state the process never actually wrote, which is precisely the
 * class of false-green that let this whole defect ship. Cloning makes the test
 * store behave like the serialising Mongo one.
 */
export async function saveSessionState<T>(
  ctx: StrategyContext,
  value: T,
  key: string = SESSION_STATE_KEY,
): Promise<void> {
  const record: Stamped<T> = { sessionDay: istSessionDay(ctx.clock.now()), value: structuredClone(value) }
  await ctx.state.set(key, record)
}

/** Read back a snapshot written during THIS IST session, or null. */
export async function loadSessionState<T>(
  ctx: StrategyContext,
  key: string = SESSION_STATE_KEY,
): Promise<T | null> {
  const record = await ctx.state.get<Stamped<T>>(key)
  if (record === null || typeof record !== 'object' || !('value' in record)) return null

  const today = istSessionDay(ctx.clock.now())
  if (record.sessionDay !== today) {
    ctx.log.warn(`${ctx.tag}: discarding strategy state from a previous session`, {
      storedSessionDay: record.sessionDay,
      today,
      why: 'an intraday strategy squares off daily, so a record from another day means yesterday\'s flatten did not complete — check the broker book',
    })
    await ctx.state.delete(key)
    return null
  }
  // Cloned on the way out for the mirror-image reason it is cloned on the way
  // in: the caller mutates what it gets back (`#day.tradedSides[side] = true`),
  // and that must not reach into the store behind `saveSessionState`'s back.
  return structuredClone(record.value)
}

/** Drop the snapshot. Called only once a flatten has been ACCEPTED. */
export async function clearSessionState(
  ctx: StrategyContext,
  key: string = SESSION_STATE_KEY,
): Promise<void> {
  await ctx.state.delete(key)
}
