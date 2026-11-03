/**
 * When to re-price a book.
 *
 * PURE over an injected clock, so the whole cadence is testable without waiting
 * for a wall-clock minute to pass.
 *
 * SLOTS, NOT A POLL. Margin is re-priced when NSE publishes a new SPAN risk
 * parameter file, not on a fixed interval — operator direction. The known cost
 * is recorded in the spec (§6.2): the risk array is indexed by scenarios
 * relative to CURRENT spot, so the same file yields a different scan loss as
 * the underlying moves, and slot-only refresh under-samples that drift. The
 * times are config precisely so extra slots can be added without a deploy.
 *
 * A MISSED SLOT IS SKIPPED, NOT QUEUED. A process that starts at 15:00 must not
 * immediately fire the 09:10, 11:05, 12:35 and 14:05 refreshes — that is four
 * identical calls producing one answer, and it would make every restart look
 * like a burst of activity in the logs.
 */

/**
 * IST wall-clock slots, `HH:MM`, offset a few minutes past each publication so
 * the file is actually up when we ask.
 *
 * PROVISIONAL — these track NSE's rotation and want confirming against the real
 * publication times before anyone treats a slot boundary as meaningful.
 */
export const DEFAULT_SLOTS: readonly string[] = [
  '09:10',
  '11:05',
  '12:35',
  '14:05',
  '15:35',
  '15:45',
]

const IST_OFFSET_MIN = 5 * 60 + 30

/** Minutes since IST midnight for an epoch-ms instant. */
export function istMinuteOfDay(nowMs: number): number {
  return Math.floor(((nowMs / 60_000) + IST_OFFSET_MIN) % 1440)
}

/** The IST calendar day, so a slot fires once per day rather than once ever. */
export function istDayKey(nowMs: number): number {
  return Math.floor((nowMs / 60_000 + IST_OFFSET_MIN) / 1440)
}

function parseSlot(slot: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(slot.trim())
  if (m === null) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

export interface SlotState {
  /** `day*10000 + slotMinute` of the last slot actually fired. */
  lastFired: number
}

/**
 * Has a slot come due since the last tick?
 *
 * Returns the slot's minute-of-day when one is due, else null. Only the LATEST
 * due slot fires — see the missed-slot note in the file header.
 */
export function dueSlot(
  nowMs: number,
  slots: readonly string[],
  state: SlotState,
  /** How long after a slot it may still fire, so a paused process still catches up. */
  graceMin = 20,
): number | null {
  const day = istDayKey(nowMs)
  const now = istMinuteOfDay(nowMs)
  let best: number | null = null
  for (const raw of slots) {
    const slot = parseSlot(raw)
    if (slot === null) continue
    if (slot > now) continue
    if (now - slot > graceMin) continue
    if (best === null || slot > best) best = slot
  }
  if (best === null) return null
  const stamp = day * 10_000 + best
  if (stamp <= state.lastFired) return null
  state.lastFired = stamp
  return best
}

/**
 * Collapses a burst of fills into one refresh.
 *
 * Four legs filling in two seconds must produce ONE basket call, after the last
 * one lands — pricing a half-built book is not just wasteful, it briefly
 * publishes a margin for a position that never existed.
 */
export function createDebouncer(delayMs: number, run: (tag: string) => void): {
  bump(tag: string): void
  cancel(): void
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    bump(tag) {
      const existing = timers.get(tag)
      if (existing !== undefined) clearTimeout(existing)
      timers.set(
        tag,
        setTimeout(() => {
          timers.delete(tag)
          run(tag)
        }, delayMs),
      )
    },
    cancel() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}
