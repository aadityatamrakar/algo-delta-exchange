/**
 * ONE LINE A MINUTE, WITH THE COUNT OF WHAT IT STANDS FOR.
 *
 * The supervisor logs from inside loops that never stop: a delta-lean book
 * evaluates every 2 s, the registry polls every 5 s, the nudge server answers
 * whatever desk-api sends. A condition that PERSISTS — a spent order budget, a
 * strategy row that cannot be read, a book that cannot be started, a caller with
 * the wrong token — is therefore not one alarm but the same alarm every pass,
 * and the 09-21 session showed what that looks like: "the order budget is spent"
 * hundreds of times for one book, burying the one line in between that mattered.
 *
 * `repair-hold.ts`'s `sayOnce` is the same idea for one caller and simply drops
 * the repeats. This one also COUNTS them, because a line that says
 * `suppressed: 30` tells the operator the condition held for the whole minute,
 * where a lone line a minute apart could be read as thirty separate incidents or
 * as one that keeps clearing and returning.
 *
 * Pure bookkeeping over a clock the CALLER supplies: no `Date.now()`, no timers,
 * so the host's fake clock drives it in tests and the throttle lives exactly as
 * long as the object that owns it.
 */
export class Throttle {
  readonly #everyMs: number
  /** Epoch ms the quiet window ends at; 0 = never emitted, emit at once. */
  #quietUntil = 0
  /** Calls swallowed since the last emission. */
  #suppressed = 0

  constructor(everyMs = 60_000) {
    this.#everyMs = everyMs
  }

  /**
   * May the caller emit its line NOW?
   *
   * `null` = no, inside the quiet window — and the call was counted. A number
   * = yes, and it is how many calls were swallowed since the last emission
   * (0 on the very first), for the caller to put in its context as
   * `suppressed`. The window re-opens from THIS instant, so a condition that
   * persists is reported once per `everyMs` rather than once per pass.
   */
  claim(nowMs: number): number | null {
    if (nowMs < this.#quietUntil) {
      this.#suppressed += 1
      return null
    }
    const suppressed = this.#suppressed
    this.#suppressed = 0
    this.#quietUntil = nowMs + this.#everyMs
    return suppressed
  }

  /**
   * The condition cleared: forget the window AND the count, so its next
   * occurrence is reported at once rather than folded into a window that
   * belonged to the previous incident.
   */
  reset(): void {
    this.#quietUntil = 0
    this.#suppressed = 0
  }
}
