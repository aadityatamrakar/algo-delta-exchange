/**
 * Keeping the XTS order socket wired to the CURRENT token.
 *
 * THE BUG THIS EXISTS FOR. The socket is a socket.io connection whose auth
 * travels in the handshake QUERY STRING (`?token=…&userID=…`), fixed at the
 * moment the client is constructed. `reconnection: true` therefore reconnects
 * with whatever token it was born with, forever. So the day the token expires:
 *
 *   00:23:09  XTS order socket connected          <- token about to expire
 *   00:23:14  XTS order socket DISCONNECTED       <- server rejects it
 *   00:23:33  broker snapshot: session expired, re-logging in   <- NEW token
 *   …18 hours of silent retries with the dead token, through a whole session…
 *   18:08:51  XTS order socket connected          <- only because pm2 restarted
 *
 * That is 2026-08-10 on the live box, verbatim. Nothing was broken loudly:
 * orders still placed, and fills still arrived — but via the 30-second
 * reconciliation sweep instead of in real time, for the entire session, with
 * only one `DISCONNECTED` line from hours earlier to say so.
 *
 * THE FIX is to treat the token as the socket's identity. Every successful
 * login — boot, expiry re-login, or the adapter's own single-flight relogin —
 * announces its new token, and this supervisor rebuilds the socket around it.
 * A relogin that returns the SAME token rewires nothing, so an idle system does
 * not churn its connection.
 *
 * Deliberately transport-agnostic: it knows how to decide, not how to connect.
 * `main.ts` owns the socket.io specifics, this owns the rule, and the rule is
 * the part that was wrong.
 */

/** What the supervisor needs back from a wiring attempt, to tear it down later. */
export interface OrderSocketHandle {
  /** Disconnect and stop reconnecting. Must be safe to call twice. */
  close(): void
}

export interface OrderSocketSupervisorDeps {
  /**
   * Build a socket for this token. Returns `null` when a socket could not be
   * established — the gateway runs fine without one (fills arrive via the
   * sweep), so this is a degraded state, not a failure to propagate.
   */
  wire(token: string, userID: string): Promise<OrderSocketHandle | null>
  log(message: string, ctx?: Record<string, unknown>): void
}

export class OrderSocketSupervisor {
  readonly #d: OrderSocketSupervisorDeps
  #handle: OrderSocketHandle | null = null
  /** The token the live socket was BUILT with — not the session's current one. */
  #wiredToken = ''
  /**
   * Single-flight. `onToken` fires from the login path, which the snapshot loop
   * and the adapter's relogin can both reach at once; two overlapping syncs
   * would leave one socket orphaned and still retrying.
   */
  #inFlight: Promise<void> | null = null

  constructor(deps: OrderSocketSupervisorDeps) {
    this.#d = deps
  }

  /** The token the live socket is using. Empty when nothing is wired. */
  get wiredToken(): string {
    return this.#wiredToken
  }

  /**
   * Make the socket match this token, rebuilding it if it does not.
   *
   * Never rejects: a socket that cannot be built leaves the gateway on the
   * sweep, which is the documented degraded mode, and throwing here would take
   * down the login path that called it.
   */
  async sync(token: string, userID: string): Promise<void> {
    const existing = this.#inFlight
    if (existing !== null) await existing
    // An empty token means we are not logged in at all. Tearing the socket down
    // for that would lose a working connection over a transient read.
    if (token === '') return
    if (token === this.#wiredToken && this.#handle !== null) return

    const run = this.#rewire(token, userID)
    this.#inFlight = run
    try {
      await run
    } finally {
      this.#inFlight = null
    }
  }

  async #rewire(token: string, userID: string): Promise<void> {
    // Close FIRST. The old socket is retrying against a token the server has
    // already rejected; leaving it up leaks a connection per relogin and lets
    // a stale handshake race the fresh one.
    if (this.#handle !== null) {
      this.#d.log('XTS order socket: token rotated, rewiring')
      try {
        this.#handle.close()
      } catch (err) {
        this.#d.log('XTS order socket: closing the stale socket threw', { error: String(err) })
      }
      this.#handle = null
    }
    this.#wiredToken = ''
    try {
      const handle = await this.#d.wire(token, userID)
      if (handle === null) return
      this.#handle = handle
      this.#wiredToken = token
    } catch (err) {
      // `wire` is expected to swallow its own errors; this is the backstop that
      // keeps a bad rewire from escaping into the login path.
      this.#d.log('XTS order socket: rewire failed — fills will arrive via the sweep', {
        error: String(err),
      })
    }
  }

  /** Shutdown. */
  close(): void {
    if (this.#handle === null) return
    try {
      this.#handle.close()
    } catch {
      // Nothing useful to do while exiting.
    }
    this.#handle = null
    this.#wiredToken = ''
  }
}
