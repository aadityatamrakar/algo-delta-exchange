/**
 * The broker link — the operator's "turn XTS off" switch.
 *
 * WHY IT EXISTS. XTS issues ONE interactive session per API key. Logging in
 * from anywhere else kills the session this process trades on, and this
 * process's own re-login kills the other one back. So "use the XTS API
 * somewhere else for a while" is not something the desk can do by merely
 * switching strategies off: the gateway keeps its socket up, keeps snapshotting
 * the broker book every 30s, and re-logs in the moment a call answers with a
 * session error — which is exactly what the other login causes. The desk needs
 * a way to make this process LET GO of the key entirely, and to hold it off
 * until told otherwise.
 *
 * WHAT "RELEASED" MEANS, for the whole process:
 *
 *   - the interactive socket is closed and not rebuilt;
 *   - the session is logged out (`DELETE /user/session`) and the stored token
 *     is deleted, so a restart while released cannot reuse a bearer;
 *   - NO LOGIN HAPPENS — not the adapter's single-flight relogin, not the
 *     snapshot loop's expiry relogin, not the boot's `ensureSession`;
 *   - every loop that calls XTS (snapshot, cancel drain, broker-book sweep,
 *     the live chaser) is a no-op, and a queued LIVE order is refused with a
 *     reason that names this switch. Paper is untouched — it never spoke to
 *     XTS in the first place.
 *
 * THE DOCUMENT. `desk-safety` `_id: 'broker-link'`, beside the kill switch and
 * written by the same bridge. The operator's WISH (`desired`, `reason`,
 * `setBy`, `setAt`) is the bridge's; the ACK (`applied`, `appliedAt`,
 * `appliedError`) is this process's, written on every transition and once at
 * boot, so the dashboard can tell "asked" from "done" — and can show WHY a
 * reconnect is not happening when the login fails.
 *
 * THE ORDER OF A RELEASE IS LOAD-BEARING. The in-memory state flips FIRST, so
 * the placement gate and the relogin guard are already engaged while the
 * logout is on the wire; a logout that hangs or fails therefore still leaves
 * a gateway that will not touch XTS again. The failure is recorded rather than
 * swallowed, because a failed logout means the server-side session may still
 * be alive and the operator's other login will be the thing that kills it.
 *
 * FAIL TOWARDS "AS YOU WERE". An unreadable document does not flip the state
 * either way — the poll simply tries again — and a malformed one reads as the
 * default (connected), because that is the state the desk has always run in.
 *
 * Pure of Mongo and of XTS: everything that touches either is a port, so the
 * ordering and failure rules above are tested without a broker.
 */

import { fixedClock, isMarketOpen } from '@algomaker/core'
import type { BrokerSnapshot } from './broker-snapshot.ts'

/** The `desk-safety` document id. The bridge (`apps/api/src/store.ts`) writes the same one. */
export const BROKER_LINK_ID = 'broker-link'
/** How often the gateway asks whether the wish changed. Same cadence as the cancel drain: an operator is waiting. */
export const BROKER_LINK_POLL_MS = 2_000
/**
 * How long a FAILED reconnect waits before the next login attempt. The poll
 * keeps running at 2s; XTS rate-limits logins and a wrong secret would
 * otherwise be tried thirty times a minute from the only process that can
 * place orders.
 */
export const RECONNECT_RETRY_MS = 30_000

export type LinkState = 'connected' | 'released'

/** The operator's wish, as the bridge wrote it. */
export interface BrokerLinkDesire {
  readonly desired: LinkState
  readonly reason: string
  readonly setBy: string
  readonly setAt: number
}

/** This process's answer. */
export interface BrokerLinkAck {
  readonly applied: LinkState
  readonly appliedAt: number
  /** Empty when the transition was clean. A release with a failed logout still applies. */
  readonly appliedError: string
}

export const DEFAULT_LINK_DESIRE: BrokerLinkDesire = {
  desired: 'connected',
  reason: '',
  setBy: '',
  setAt: 0,
}

/**
 * Read the wish defensively. Only the literal `'released'` releases; anything
 * else — a missing doc, a hand-edited value, the wrong type — is the default.
 */
export function readLinkDesire(doc: unknown): BrokerLinkDesire {
  if (doc === null || typeof doc !== 'object') return DEFAULT_LINK_DESIRE
  const d = doc as Record<string, unknown>
  if (d['desired'] !== 'released') return DEFAULT_LINK_DESIRE
  return {
    desired: 'released',
    reason: typeof d['reason'] === 'string' ? d['reason'] : '',
    setBy: typeof d['setBy'] === 'string' ? d['setBy'] : '',
    setAt: typeof d['setAt'] === 'number' ? d['setAt'] : 0,
  }
}

/** Everything a transition touches. Methods, not readonly properties, so a test can swap one. */
export interface BrokerLinkPorts {
  /** `DELETE /user/session`. Best effort — see the ordering note above. */
  logout(): Promise<void>
  /** A FRESH login. The session's own `onToken` hook stores the token and rewires the socket. */
  login(): Promise<void>
  /** Tear down the interactive socket so it stops reconnecting with the token about to die. */
  closeSocket(): void
  /** Forget the stored token, so a restart while released cannot reuse it. */
  clearStoredToken(): Promise<void>
  /** Write the ack into the link document. */
  record(ack: BrokerLinkAck): Promise<void>
  now(): number
  log(msg: string, ctx?: Record<string, unknown>): void
}

export class BrokerLink {
  readonly #p: BrokerLinkPorts
  #state: LinkState
  /** The reason on the wish that released us — quoted in every refusal. */
  #reason = ''
  #acked = false
  #lastLoginAttemptAt = 0
  /** Single-flight: a wish that changes mid-transition waits for the transition. */
  #inFlight: Promise<void> | null = null
  /** True until the first reconcile of a process that booted released. */
  #booted: boolean

  /**
   * `initial` is what the BOOT decided: `'released'` when the stored wish was
   * released and `main()` therefore skipped the login. It is not looked up
   * here because the constructor cannot read Mongo and must not guess.
   *
   * A released boot still RUNS the release on its first reconcile (`#booted`):
   * the wish may have been written while this process was down, in which case
   * a live token is still stored and a server-side session is still open —
   * neither of which the boot touched. Logging out with no token is a no-op at
   * the client, so the case where the release already happened costs nothing.
   */
  constructor(ports: BrokerLinkPorts, initial: LinkState) {
    this.#p = ports
    this.#state = initial
    this.#booted = initial === 'released'
  }

  get state(): LinkState {
    return this.#state
  }

  /** May this process talk to XTS right now? Every XTS-touching loop asks this first. */
  get connected(): boolean {
    return this.#state === 'connected'
  }

  /** The operator's reason for the release, or empty. */
  get reason(): string {
    return this.#reason
  }

  /** The reason a LIVE order is refused while released, or null when connected. */
  refusal(): string | null {
    if (this.#state === 'connected') return null
    return (
      `XTS session released by operator${this.#reason === '' ? '' : ` (${this.#reason})`}; ` +
      'the gateway is logged out and live orders cannot be placed until it is reconnected from Controls'
    )
  }

  /**
   * Make the process match the wish. Never rejects — every failure is logged
   * and recorded, because this runs from a timer on the only process that can
   * place orders.
   */
  async reconcile(desire: BrokerLinkDesire): Promise<void> {
    const existing = this.#inFlight
    if (existing !== null) await existing
    const run = this.#reconcile(desire)
    this.#inFlight = run
    try {
      await run
    } finally {
      if (this.#inFlight === run) this.#inFlight = null
    }
  }

  async #reconcile(desire: BrokerLinkDesire): Promise<void> {
    if (desire.desired === 'released') this.#reason = desire.reason
    if (this.#booted) {
      // A released boot: finish what the release would have done — see the constructor.
      this.#booted = false
      if (desire.desired === 'released') {
        await this.#release()
        return
      }
    }
    if (desire.desired === this.#state) {
      // Steady state. The one thing still owed is the boot ack: a dashboard
      // that released the link before a restart needs THIS process to confirm.
      if (!this.#acked) await this.#ack('')
      return
    }
    if (desire.desired === 'released') {
      await this.#release()
      return
    }
    await this.#reconnect()
  }

  async #release(): Promise<void> {
    // FIRST, before any IO: the gate and the relogin guard engage now.
    this.#state = 'released'
    this.#p.log('BROKER LINK RELEASED — logging out of XTS and holding off every call until reconnected', {
      reason: this.#reason,
    })
    const problems: string[] = []
    try {
      this.#p.closeSocket()
    } catch (err) {
      problems.push(`socket close failed: ${msgOf(err)}`)
    }
    try {
      await this.#p.logout()
    } catch (err) {
      problems.push(`logout failed: ${msgOf(err)}`)
    }
    try {
      await this.#p.clearStoredToken()
    } catch (err) {
      problems.push(`token not cleared: ${msgOf(err)}`)
    }
    if (problems.length > 0) this.#p.log('broker link: release completed with errors', { problems })
    await this.#ack(problems.join('; '))
  }

  async #reconnect(): Promise<void> {
    const now = this.#p.now()
    // Backoff on a failed login. The poll asks every 2s; the login does not.
    if (this.#lastLoginAttemptAt !== 0 && now - this.#lastLoginAttemptAt < RECONNECT_RETRY_MS) return
    this.#lastLoginAttemptAt = now
    this.#p.log('broker link: reconnect requested — logging in to XTS')
    try {
      await this.#p.login()
    } catch (err) {
      const why = `reconnect failed: ${msgOf(err)}`
      this.#p.log('broker link: RECONNECT FAILED — still released', { error: msgOf(err) })
      await this.#ack(why)
      return
    }
    this.#state = 'connected'
    this.#lastLoginAttemptAt = 0
    this.#reason = ''
    this.#p.log('broker link: reconnected — XTS session live again')
    await this.#ack('')
  }

  async #ack(error: string): Promise<void> {
    this.#acked = true
    try {
      await this.#p.record({ applied: this.#state, appliedAt: this.#p.now(), appliedError: error })
    } catch (err) {
      this.#p.log('broker link: could not write the ack', { error: msgOf(err) })
    }
  }
}

/**
 * What the snapshot loop writes while released, instead of calling XTS.
 *
 * A FAILED snapshot, deliberately: the broker's book is unknown, and the System
 * page must say "broker not reachable: released by operator" — with a fresh
 * `asOf`, because the PROCESS is alive and healthy. `errorClass` is `fatal`,
 * not `session`: the loop re-logs in on `session`, which is the one thing this
 * state forbids. The caller must NOT archive it as the day's record — an empty
 * book overwriting the EOD snapshot would erase what the broker actually held.
 */
export function releasedSnapshot(nowMs: number, reason: string): BrokerSnapshot {
  const why = `XTS session released by operator${reason === '' ? '' : ` (${reason})`}`
  return {
    asOf: nowMs,
    ok: false,
    error: `${why}; the gateway is logged out and not reading the broker book`,
    orders: [],
    positions: [],
    trades: [],
    funds: null,
    fundsDiagnostic: why,
    errorClass: 'fatal',
    sessionOpenAtSnapshot: isMarketOpen(fixedClock(nowMs)),
  }
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
