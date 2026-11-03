/**
 * In-process recovery for a dead Kite feed: fresh login, rebuilt sockets.
 *
 * WHY THIS EXISTS — the 2026-08-04 incident. At 13:36 IST the enctoken was
 * invalidated mid-session (a web-session token dies the moment the same user
 * logs into Kite anywhere else). The vendored ticker then re-dialled with that
 * dead token every ~30s for 14 minutes — a retry that could never succeed,
 * because only a NEW login mints a working token. Recovery until now was the
 * vendored `process.exit(1)` after ~50 failed retries (~45 minutes of dead
 * feed) followed by a pm2 reboot, whose boot-time login is what actually fixed
 * things on 2026-07-29 and 2026-08-01. On 2026-08-04 the operator restarted by
 * hand at minute 14 instead. This class is that reboot, minus the reboot:
 * re-login, hand the fresh token to the pool, let the registry resubscribe.
 *
 * PACING MATTERS: `login()` is a real password+TOTP login, and hammering it
 * during a Zerodha outage risks rate limits on a live trading account. So the
 * first attempt is immediate (the common case — token invalidated, login
 * works, feed is back in under a second) and consecutive attempts back off
 * with doubling delays up to a cap.
 *
 * The backoff resets only on EVIDENCE THAT THE SPECIFIC FAULT IS OVER, and the
 * two faults have different evidence — see `RecoveryKind`. A dead feed is
 * cleared by every socket connecting; a rejected enctoken only by a REST call
 * that succeeds. Sharing one counter between them would let the 10s health
 * sweep, which sees a perfectly connected pool all through a token outage,
 * reopen the gate on every tick.
 */

/**
 * What a `trigger` ACTUALLY DID. The caller cannot infer it from the promise
 * resolving, and two of the three outcomes leave the enctoken unchanged.
 *
 * This exists because a caller that retries a rejected REST call needs to know
 * whether it is retrying with a NEW token or re-sending the dead one. Treating
 * "the promise resolved" as "the token rotated" makes the retry a guaranteed
 * second rejection, and makes any error it then reports name a re-login that
 * never happened.
 */
export type RecoveryOutcome =
  /** A fresh login completed and `apply` ran: the token is NEW. */
  | 'rotated'
  /** The backoff window for this fault is still shut: nothing ran, token UNCHANGED. */
  | 'gated'
  /** A login was attempted and failed or timed out: token UNCHANGED. */
  | 'failed'

/**
 * WHICH FAULT is asking for recovery — and therefore what counts as proof it
 * is over.
 *
 * A dead SOCKET is proven fixed by every socket being connected again. A
 * rejected ENCTOKEN is not: the 2026-08-05 outage was a fully connected pool
 * holding a token every REST call rejected, which is the whole reason the REST
 * path needed its own trigger. So the two fault kinds pace themselves
 * SEPARATELY over the one shared login — otherwise the 10s health sweep, which
 * sees connected sockets throughout a token outage, would reopen the gate on
 * every pass and the margin sweep would spend a real password+TOTP login every
 * 30 seconds against a live trading account.
 */
export type RecoveryKind = 'feed' | 'token'

export interface FeedRecoveryOptions {
  /** Perform a FRESH Zerodha login; resolves to the new enctoken. */
  readonly login: () => Promise<string>
  /** Hand the fresh token to the pool: rebuild dead sockets (KiteFeedPool.reconnect). */
  readonly apply: (accessToken: string) => void
  readonly log?: (msg: string, ctx?: Record<string, unknown>) => void
  /** Delay before the SECOND consecutive attempt. Doubles up to maxDelayMs. */
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  /**
   * A login slower than this counts as failed and releases the in-flight
   * gate. Without the bound, one hung login wedges recovery forever — the old
   * vendored `process.exit(1)` used to paper over exactly that class of stuck
   * state, and it is gone now.
   */
  readonly loginTimeoutMs?: number
  /** Injected for tests. */
  readonly now?: () => number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`zerodha login timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * A login failure that no amount of retrying fixes: wrong password, dead TOTP
 * secret, a credential the store cannot produce. Matched on the message
 * because the vendored login flow throws plain Errors.
 */
const AUTH_SHAPED = /login failed|no enctoken|password|totp|two.?fa|credential|invalid/i

/**
 * How long a token trigger keeps `noteTokenAccepted` from reopening the gate.
 *
 * THE CONFLICTING-SIGNAL REGIME. Two independent things exercise the enctoken
 * over REST and they can DISAGREE: the canary probes one instrument every 120s
 * and reports an accept whenever it answers, while the margin sweep prices
 * books every ~30s and reports a token rejection whenever it is refused. A
 * token entitled to history but not to margins, a partial Zerodha outage, or
 * simply a wording the classifier reads wrong puts the process in exactly that
 * state — probe says alive, sweep says dead — and there, an accept that wiped
 * the backoff clean every two minutes meant the very next rejection found an
 * open gate. A real password+TOTP login at SWEEP CADENCE, indefinitely, on a
 * live trading account, with the rate limit that follows taking genuine feed
 * recovery down with it.
 *
 * So while a token trigger is FRESH, an accept is not evidence: the two
 * witnesses contradict each other and the safe reading is the pessimistic one.
 * The backoff keeps doubling, so the regime costs at most ONE login per backoff
 * step rather than one per sweep — a STRUCTURAL bound, which is the point. It
 * does not depend on the classifier being right about every wording Zerodha
 * ever invents.
 *
 * TEN MINUTES = `maxDelayMs`, deliberately: the window is exactly as long as
 * the longest backoff step, so an accept can never land between two paced
 * attempts and reset the ladder underneath them. It is a WINDOW, not a latch —
 * ten quiet minutes with no further rejection means the disagreement is over
 * and the next accept resets the backoff normally.
 */
const TOKEN_CONFLICT_WINDOW_MS = 600_000

export class FeedRecovery {
  readonly #opts: FeedRecoveryOptions
  readonly #log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly #baseDelayMs: number
  readonly #maxDelayMs: number
  readonly #loginTimeoutMs: number
  readonly #now: () => number
  /**
   * Consecutive attempts per fault kind, since that fault was last proven
   * clear. PER KIND, not shared: a healthy socket says nothing about a rejected
   * token, so `noteHealthy` must not be able to reset the token's pacing.
   */
  readonly #attempts: Record<RecoveryKind, number> = { feed: 0, token: 0 }
  readonly #notBeforeMs: Record<RecoveryKind, number> = { feed: 0, token: 0 }
  /**
   * When a TOKEN trigger last arrived — gated or not.
   *
   * Gated ones count: the caller was rejected by Kite either way, and it is the
   * REJECTION that contradicts the canary's accept, not whether we chose to
   * spend a login on it. See `TOKEN_CONFLICT_WINDOW_MS`.
   */
  #lastTokenTriggerMs = Number.NEGATIVE_INFINITY
  /** The login currently running, so a concurrent trigger JOINS it. */
  #inFlight: Promise<RecoveryOutcome> | null = null

  constructor(opts: FeedRecoveryOptions) {
    this.#opts = opts
    this.#log = opts.log ?? ((): void => {})
    this.#baseDelayMs = opts.baseDelayMs ?? 60_000
    this.#maxDelayMs = opts.maxDelayMs ?? 600_000
    this.#loginTimeoutMs = opts.loginTimeoutMs ?? 60_000
    this.#now = opts.now ?? Date.now
  }

  /**
   * Attempt a recovery, unless this fault's backoff says not yet.
   *
   * Safe to call from every health sweep, every 'noreconnect' and every
   * rejected REST call: the gate makes repeated triggers free, so callers do
   * not need to coordinate. The OUTCOME is what a caller must read before
   * acting on the token — see `RecoveryOutcome`.
   */
  async trigger(reason: string, kind: RecoveryKind = 'feed'): Promise<RecoveryOutcome> {
    /**
     * JOIN a login already in flight rather than answering 'gated'.
     *
     * Both are "no login of your own", but only one of them is about to
     * produce a fresh token, and a caller that gives up here throws away a
     * rotation it was 200ms from having. This is the case that made the margin
     * client re-send a dead enctoken and then report a re-login that never
     * happened.
     */
    // Recorded BEFORE any of the gates, and for every token trigger including
    // the ones that join or are gated: this is "the sweep says the session is
    // dead", which is the fact that contradicts an accept.
    if (kind === 'token') this.#lastTokenTriggerMs = this.#now()
    const running = this.#inFlight
    if (running !== null) return await running
    if (this.#now() < this.#notBeforeMs[kind]) return 'gated'
    const attempt = this.#attempt(reason, kind)
    this.#inFlight = attempt
    try {
      return await attempt
    } finally {
      this.#inFlight = null
    }
  }

  async #attempt(reason: string, kind: RecoveryKind): Promise<RecoveryOutcome> {
    const attempts = this.#attempts[kind] + 1
    this.#attempts[kind] = attempts
    // Pace the NEXT attempt before this one runs: a login that hangs must not
    // let the sweep pile a concurrent login on top of it after the gate opens.
    const delay = Math.min(this.#baseDelayMs * 2 ** Math.min(attempts - 1, 5), this.#maxDelayMs)
    this.#notBeforeMs[kind] = this.#now() + delay
    try {
      this.#log('feed recovery: fresh zerodha login', { reason, kind, attempt: attempts })
      const accessToken = await withTimeout(this.#opts.login(), this.#loginTimeoutMs)
      this.#opts.apply(accessToken)
      this.#log('feed recovery: login OK — token rotated, dead sockets rebuilt', { kind, attempt: attempts })
      return 'rotated'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (AUTH_SHAPED.test(message)) {
        // Distinct and LOUD: retrying cannot fix a credential problem. A human
        // has to update the Zerodha entry on the Brokers page (or the
        // ZERODHA_* environment) before the feed can come back.
        this.#log('feed recovery FAILED at LOGIN — the Zerodha credentials need a HUMAN', {
          error: message,
          nextRetryInMs: delay,
        })
      } else {
        this.#log('feed recovery failed — will retry', { error: message, nextRetryInMs: delay })
      }
      return 'failed'
    }
  }

  /**
   * Every socket is connected: reset the FEED backoff so the next outage gets
   * an immediate first attempt instead of inheriting this one's delay.
   *
   * Deliberately says nothing about the token. A connected socket survives its
   * enctoken being invalidated — that asymmetry is documented on
   * `KiteFeedPool.reconnect` and is what the 2026-08-05 outage was made of —
   * so treating "sockets up" as "session healthy" here would erase the pacing
   * on the one path that can actually tell.
   */
  noteHealthy(): void {
    this.#clear('feed', 'feed recovered — every socket connected again')
  }

  /**
   * A REST call SUCCEEDED on the token currently held: the session is proven
   * live, so the token backoff resets.
   *
   * Only a successful call counts. A login merely completing does not — on
   * 2026-08-04 a competing IJ0574 login killed each fresh token within
   * seconds, and treating the login itself as proof would let that spin
   * forever at full speed.
   *
   * AND NOT WHILE THE OTHER WITNESS IS STILL SAYING THE OPPOSITE. A call that
   * answered is evidence, not proof: the canary probes ONE instrument, and a
   * session that serves it while every margin call is refused is a real state
   * the desk has been in. Resetting on the accept while rejections keep
   * arriving turns the 120s probe into a login clock — see
   * `TOKEN_CONFLICT_WINDOW_MS`, which is where the pacing actually lives.
   */
  noteTokenAccepted(): void {
    const sinceTrigger = this.#now() - this.#lastTokenTriggerMs
    if (this.#attempts.token > 0 && sinceTrigger < TOKEN_CONFLICT_WINDOW_MS) {
      this.#log('enctoken accepted, but the sweep is STILL being rejected — backoff kept', {
        attempts: this.#attempts.token,
        msSinceRejection: sinceTrigger,
      })
      return
    }
    this.#clear('token', 'enctoken accepted again — the REST session is live')
  }

  #clear(kind: RecoveryKind, message: string): void {
    if (this.#attempts[kind] === 0) return
    this.#log(message, { attempts: this.#attempts[kind] })
    this.#attempts[kind] = 0
    this.#notBeforeMs[kind] = 0
  }
}
