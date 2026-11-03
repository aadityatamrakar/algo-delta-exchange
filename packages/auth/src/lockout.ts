/**
 * Login rate limiting with lockout.
 *
 * Pure: every function takes the current state and returns a NEW state, and the
 * clock is always a `now` argument. The state is a plain JSON-shaped object the
 * caller persists — its fields are exactly the `failedAttempts` / `lockedUntil`
 * columns of `desk-users` in spec §3, so a Mongo document IS a LoginState.
 *
 * This is the main compensation for the password-only decision (A2): a single
 * leaked password is full control of a live trading account, so online guessing
 * has to be made slow. It is deliberately state-per-user rather than
 * per-IP — there is one operator, and an attacker choosing a fresh IP per
 * attempt is free.
 */

export interface LoginState {
  /** Consecutive failures since the last success or the last expired lockout. */
  readonly failedAttempts: number
  /** Epoch ms of the most recent failure, or null. Shown to the operator. */
  readonly lastFailureAt: number | null
  /** Epoch ms at which an active lockout lifts, or null when not locked. */
  readonly lockedUntil: number | null
}

export interface LockoutPolicy {
  /** Failures that trigger a lockout. The Nth failure locks. */
  readonly maxFailures: number
  /** Cooling period, in ms. */
  readonly lockoutMs: number
}

/**
 * 5 attempts, then 15 minutes. Five is above any plausible typo count and far
 * below what an online guessing run needs; fifteen minutes drops a sustained
 * attack to ~20 guesses an hour while costing a fat-fingered operator one
 * coffee break.
 */
export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  maxFailures: 5,
  lockoutMs: 15 * 60 * 1000,
}

export function newLoginState(): LoginState {
  return { failedAttempts: 0, lastFailureAt: null, lockedUntil: null }
}

/**
 * Locked for as long as `now` is strictly before `lockedUntil`. At the boundary
 * the lockout has lifted, matching `isExpired` in session.ts: an "until" is
 * always exclusive in this package.
 */
export function isLockedOut(state: LoginState, now: number): boolean {
  return state.lockedUntil !== null && now < state.lockedUntil
}

/**
 * Record a failed login.
 *
 * While a lockout is active the attempt is counted but the window is NOT
 * extended. Extending it would let anyone on the internet keep the real
 * operator locked out forever just by hammering the endpoint — the lockout
 * would become the denial of service instead of the defence against one.
 *
 * Once a lockout has expired the counter restarts, so the account is not
 * permanently one failure away from re-locking.
 */
export function recordFailure(
  state: LoginState,
  now: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): LoginState {
  if (isLockedOut(state, now)) {
    return {
      failedAttempts: state.failedAttempts + 1,
      lastFailureAt: now,
      lockedUntil: state.lockedUntil,
    }
  }
  const priorLockExpired = state.lockedUntil !== null
  const failedAttempts = (priorLockExpired ? 0 : state.failedAttempts) + 1
  return {
    failedAttempts,
    lastFailureAt: now,
    lockedUntil: failedAttempts >= policy.maxFailures ? now + policy.lockoutMs : null,
  }
}

/**
 * Record a successful login: the counter and any lockout are cleared.
 *
 * Takes the old state only for symmetry with the other two — a success wipes
 * everything, because the person who knows the password is by definition not
 * the one being rate-limited.
 */
export function recordSuccess(_state: LoginState): LoginState {
  return newLoginState()
}

/** Milliseconds until an active lockout lifts, 0 when not locked. For the "try again in..." message. */
export function lockoutRemainingMs(state: LoginState, now: number): number {
  if (!isLockedOut(state, now)) return 0
  return (state.lockedUntil ?? 0) - now
}
