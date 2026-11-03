/**
 * Hosting for the three optionbhai signal mirrors.
 *
 * WHY THIS IS NOT THE RUNNER, and not the catalogue.
 *
 * `Runner` supervises `StrategyBase` objects: it starts them at a time, fires
 * their cron jobs, squares them off at 15:30 and rebuilds them the next day. A
 * signal mirror has none of that — no entry logic, no exit logic, no position
 * state of its own, no data needs, no schedule. Putting one in `CATALOGUE`
 * would mean inventing a lifecycle so the runner had something to drive, and
 * the portal would then render a `running`/`squared-off` state that nothing
 * actually observed. `catalogue.ts` and the strategies README both state that
 * rule; this file is what makes keeping it affordable.
 *
 * So the mirrors get their OWN host, and it is small on purpose: read the same
 * registry rows, honour the same per-mode switch, start one adapter per
 * instance, publish the same runtime snapshot. Everything that decides whether
 * an order may trade — the strategy switch, the kill switch, the live
 * allowlist, the freeze split, the journal — lives behind `/v1/desk/submit` and
 * applies to a mirrored order exactly as it does to a hosted strategy's. That
 * is the whole gain: today these three write to the order collection directly
 * from three pm2 processes and are subject to none of it.
 *
 * A ROW IS NOT AN INSTANCE, here either. A mirror added to paper AND live runs
 * TWICE — two upstream sessions, two gateways, two runtime rows, and the mode
 * carried on every order — for the same reason a strategy does: the two rails
 * must be independently switchable, and an order must state which rail it is
 * for.
 *
 * WHAT THIS HOST DELIBERATELY DOES NOT DO: square off. The upstream account
 * sends its own exits as EXECUTED orders, and the mirror places them like any
 * other signal. A day-end flatten here would close a position the upstream is
 * still managing and then mirror its exit on top of that — a second, opposite
 * position nobody asked for. `Runner`'s backstop exists because a hosted
 * strategy's own `onDayEnd` may place nothing; a mirror has no opinion about
 * exits at all, and inventing one would be worse than having none.
 */

import type { Clock } from '@algomaker/core'
import { ExternalSignalMirrorAdapter } from '@algomaker/strategies'
import type {
  ExternalSignalMirrorConfig,
  InstrumentResolver,
  SignalSource,
} from '@algomaker/strategies'
import type { Logger, OrderGateway } from '@algomaker/strategy-kit'
import {
  MIRROR_1PBUY,
  MIRROR_A006,
  MIRROR_A010,
  MIRROR_EMA2050,
} from '../../../packages/strategies/src/external-signal-mirror/configs.ts'
import { credentialsFromEnv, type MirrorSourceStatus } from './optionbhai.ts'
import {
  instanceKey,
  type HostedRow,
  type RunMode,
  type RuntimeSnapshot,
  type RuntimeState,
} from './runner.ts'

/**
 * Registry tag -> ported config. The mirror equivalent of `CATALOGUE`, kept
 * separate because the two are hosted by different things.
 *
 * The configs are imported by RELATIVE PATH for the same reason `catalogue.ts`
 * does it: `@algomaker/strategies` exports the adapter and its config TYPE, not
 * the concrete config records.
 */
export const MIRRORS: ReadonlyMap<string, ExternalSignalMirrorConfig> = new Map([
  ['MIRROR_1PBUY', MIRROR_1PBUY],
  ['MIRROR_A006', MIRROR_A006],
  ['MIRROR_A010', MIRROR_A010],
  ['MIRROR_EMA2050', MIRROR_EMA2050],
])

/** The two ports the adapter needs, plus the lifecycle this host drives. */
export interface MirrorSource extends SignalSource, InstrumentResolver {
  start(): Promise<void>
  stop(): void
  status(): MirrorSourceStatus
}

export interface MirrorHostDeps {
  readonly clock: Clock
  readonly log: Logger
  /** Where credentials come from. Injected so a test never reads the real env. */
  readonly env: NodeJS.ProcessEnv
  /** The SAME `desk-strategies` read the runner does. */
  loadRows(): Promise<readonly HostedRow[]>
  /** Builds the upstream session for one instance. `OptionbhaiClient` in production. */
  createSource(
    config: ExternalSignalMirrorConfig,
    credentials: { username: string; password: string },
    mode: RunMode,
  ): MirrorSource
  /** The order path. `HttpOrderGateway` keyed `tag:mode`, so the mode is on every submit. */
  createGateway(tag: string, mode: RunMode): OrderGateway
  /** Runtime snapshots, same collection and same publisher the runner uses. */
  publish?(snapshots: readonly RuntimeSnapshot[]): Promise<void>
  /** Net open legs from the runner's ledger, for the runtime row. */
  openPositions?(tag: string, mode: RunMode): number
  /**
   * SIGNED lots held in one symbol on one rail, from the same ledger the
   * gateway books into. Audit F-6b/6c.
   *
   * The adapter has no position state, so this is what lets it mark an order
   * that REDUCES the net as an exit — unmarked, the kill switch and the
   * stale-feed block refuse it and nothing ever retries, so the upstream
   * account goes flat while our leg stays open forever. It is also what stops
   * an order larger than the position it reverses from opening a fresh one the
   * other way.
   *
   * KEYED BY TAG AND MODE like everything else here: a mirror on both rails
   * holds two independent positions, and answering the live instance out of
   * the paper ledger would mark a live entry as an exit.
   */
  netLots?(tag: string, mode: RunMode, tradingsymbol: string): number
}

interface HostedMirror {
  readonly tag: string
  readonly mode: RunMode
  readonly config: ExternalSignalMirrorConfig
  source: MirrorSource | null
  adapter: ExternalSignalMirrorAdapter | null
  state: RuntimeState
  startedAt: number | null
  lastError: string | null
}

export class MirrorHost {
  readonly #d: MirrorHostDeps
  readonly #hosted = new Map<string, HostedMirror>()
  /** Tags seen with the wrong `kind`, so the warning is said once, not per sync. */
  readonly #kindWarned = new Set<string>()
  #syncing = false

  constructor(deps: MirrorHostDeps) {
    this.#d = deps
  }

  /**
   * Reconcile the running mirrors with the registry. Safe to call on a timer.
   *
   * RE-ENTRANCY IS GUARDED because starting an instance performs a network
   * login: a slow optionbhai would let the next interval tick overlap this one,
   * and both passes would see the same instance as missing and start it twice —
   * two sockets, every mirrored order placed twice.
   */
  async sync(): Promise<void> {
    if (this.#syncing) return
    this.#syncing = true
    try {
      await this.#sync()
    } finally {
      this.#syncing = false
    }
  }

  async #sync(): Promise<void> {
    let rows: readonly HostedRow[]
    try {
      rows = await this.#d.loadRows()
    } catch (err) {
      // Keep what is running. A registry read failure is not a reason to stop
      // mirroring — the upstream account is still trading.
      this.#d.log.error('mirrors: could not read the strategy registry, keeping the current set', {
        error: message(err),
      })
      return
    }

    const wanted = new Map<string, { tag: string; mode: RunMode; config: ExternalSignalMirrorConfig }>()
    for (const row of rows) {
      const config = MIRRORS.get(row.tag)
      if (config === undefined) continue
      /**
       * `hosted` is what `registry-seed.ts` writes for these three rows, and it
       * is what "this process runs it" means everywhere else. A MIRROR tag
       * flipped to `external` says a Python process owns it now; hosting it
       * anyway would mirror every upstream order twice, once from each system.
       */
      if (row.kind !== 'hosted') {
        if (!this.#kindWarned.has(row.tag)) {
          this.#kindWarned.add(row.tag)
          this.#d.log.warn(
            `mirrors: ${row.tag} is registered as '${row.kind}', so this process is NOT hosting it`,
          )
        }
        continue
      }
      for (const mode of ['paper', 'live'] as const) {
        // Not added and added-but-off are both "do not run it", and `=== true`
        // is what keeps a truthy hand-edited value from starting a mirror
        // nobody armed.
        if (row.modes[mode]?.enabled !== true) continue
        wanted.set(instanceKey(row.tag, mode), { tag: row.tag, mode, config })
      }
    }

    for (const [key, m] of [...this.#hosted]) {
      if (wanted.has(key)) continue
      this.#stopOne(m, 'switched off in the registry')
      this.#hosted.delete(key)
    }

    for (const [key, want] of wanted) {
      if (this.#hosted.has(key)) continue
      const hosted: HostedMirror = {
        tag: want.tag,
        mode: want.mode,
        config: want.config,
        source: null,
        adapter: null,
        state: 'waiting',
        startedAt: null,
        lastError: null,
      }
      this.#hosted.set(key, hosted)
      await this.#startOne(hosted)
    }

    await this.#publish()
  }

  /**
   * Every hosted mirror, in the same vocabulary the strategies page already
   * renders. `waiting` is "connecting", `running` is "socket open", `failed`
   * carries the reason — a missing credential or a login that keeps failing.
   */
  snapshots(): readonly RuntimeSnapshot[] {
    const now = this.#d.clock.now()
    return [...this.#hosted.values()].map((m) => {
      const live = this.#liveState(m)
      return {
        tag: m.tag,
        mode: m.mode,
        state: live.state,
        startedAt: m.startedAt,
        lastError: live.lastError,
        openPositions: this.#d.openPositions?.(m.tag, m.mode) ?? 0,
        updatedAt: now,
      }
    })
  }

  /**
   * Shutdown: unsubscribe and drop the sockets. NOTHING IS FLATTENED — see the
   * file header. A mirrored position belongs to the upstream account's book,
   * and this process closing has no bearing on it.
   */
  async stopAll(reason: string): Promise<void> {
    for (const m of this.#hosted.values()) this.#stopOne(m, reason)
    await this.#publish()
  }

  // ------------------------------------------------------------- internals

  async #startOne(m: HostedMirror): Promise<void> {
    let credentials
    try {
      credentials = credentialsFromEnv(m.config.credentialsRef, this.#d.env)
    } catch (err) {
      /**
       * NO CREDENTIALS, NO MIRROR. Said once — the record is created once and
       * kept in `failed`, so a 15-second sync loop cannot turn this into a log
       * line every 15 seconds — and it names both variables, because "check the
       * credentials" is not an actionable message at 09:14.
       *
       * It is deliberately not retried in-process: environment variables do not
       * appear while a process is running, so a retry would only re-log. Set
       * them and restart.
       */
      m.state = 'failed'
      m.lastError = message(err)
      this.#d.log.error(`mirrors: ${m.tag} (${m.mode}) NOT started — ${m.lastError}`)
      return
    }

    try {
      const source = this.#d.createSource(m.config, credentials, m.mode)
      const gateway = this.#d.createGateway(m.tag, m.mode)
      // The ledger view is bound to THIS instance's tag and rail before the
      // adapter ever sees it — the adapter asks about a symbol, never about a
      // book, so it cannot accidentally be pointed at the other rail's.
      const netLots = this.#d.netLots
      const adapter = new ExternalSignalMirrorAdapter(
        m.config,
        source,
        gateway,
        source,
        this.#d.log,
        netLots === undefined
          ? {}
          : { positions: { netLots: (symbol) => netLots(m.tag, m.mode, symbol) } },
      )
      m.source = source
      m.adapter = adapter
      /**
       * SUBSCRIBE BEFORE CONNECTING. `adapter.start()` registers the handler on
       * the source; `source.start()` is what opens the socket. The other order
       * has a window — however small — in which an EXECUTED order arrives and
       * is delivered to nobody, and a missed entry is a position the upstream
       * holds and we do not.
       */
      adapter.start()
      await source.start()
      m.startedAt = this.#d.clock.now()
      m.state = 'waiting'
      m.lastError = null
      this.#d.log.info(`mirrors: hosting ${m.tag}`, {
        mode: m.mode,
        destinationTag: m.config.destinationTag,
        credentialsRef: m.config.credentialsRef,
      })
    } catch (err) {
      // `OptionbhaiClient.start()` does not reject — it retries internally — so
      // reaching here means the construction itself failed. Park it rather than
      // letting one mirror take the sync loop down.
      m.state = 'failed'
      m.lastError = message(err)
      this.#d.log.error(`mirrors: ${m.tag} (${m.mode}) failed to start`, { error: m.lastError })
    }
  }

  #stopOne(m: HostedMirror, reason: string): void {
    // The ADAPTER first: unsubscribing before the socket goes away means no
    // frame that is already in flight can still be mirrored after the operator
    // switched the row off.
    m.adapter?.stop()
    m.source?.stop()
    m.adapter = null
    m.source = null
    m.state = 'stopped'
    m.startedAt = null
    this.#d.log.info(`mirrors: ${m.tag} stopped (${reason})`, { mode: m.mode })
  }

  /**
   * The upstream session's own health, READ AT THE MOMENT IT IS ASKED FOR.
   *
   * Derived rather than stored because the socket comes and goes between syncs:
   * a state cached at the last sync would show `waiting` for a mirror that
   * connected a second later, and — much worse — `running` for one whose socket
   * dropped at 09:20 and has been retrying ever since. Nothing else in the
   * system knows the upstream signals have stopped arriving, so this row is the
   * only place an operator can see it.
   *
   * The stored `state` still answers for an instance with no session at all:
   * `failed` for a missing credential, `stopped` once it is switched off.
   */
  #liveState(m: HostedMirror): { state: RuntimeState; lastError: string | null } {
    const source = m.source
    if (source === null) return { state: m.state, lastError: m.lastError }
    const status = source.status()
    if (status.connected) return { state: 'running', lastError: null }
    return { state: status.lastError !== null ? 'failed' : 'waiting', lastError: status.lastError }
  }

  async #publish(): Promise<void> {
    if (this.#d.publish === undefined) return
    try {
      await this.#d.publish(this.snapshots())
    } catch (err) {
      this.#d.log.warn('mirrors: runtime snapshot publish failed', { error: message(err) })
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
