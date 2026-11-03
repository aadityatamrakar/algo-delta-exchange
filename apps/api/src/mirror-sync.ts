/**
 * MIRROR POSITION SYNC — the DETECTOR half (broker truth flows back, at last).
 *
 * WHY THIS EXISTS. The runner's mirror ledger (`runner:positions` in
 * `desk-strategy-state`) books OPTIMISTICALLY at submit time, and nothing ever
 * corrected it from what the broker actually did. On 2026-08-18 a cancelled
 * order left a phantom short — ledger −65, broker 0 — that had to be cleared by
 * hand through the clear-request path. The comparison that would have caught it
 * (`positions-compare.ts`) already runs every five minutes and already computes
 * the exact rows needed; this job turns those rows into a CORRECTION REQUEST
 * the runner can consume.
 *
 * THE SPLIT: THE BRIDGE DETECTS, THE RUNNER APPLIES. This file never writes a
 * ledger. `apps/runner/src/main.ts` caches one `PositionLedger` per `tag:mode`
 * for the life of the process and every `#save()` rewrites the whole document,
 * so a ledger edited by anyone else is silently undone by the next booked
 * order — the exact reason the clear-request (`CLEAR_REQUEST_KEY`, see
 * `applyClearRequest` in `apps/runner/src/order-gateway.ts`) is a parked
 * DOCUMENT rather than an API call. This job files the same kind of document
 * under its own key; the runner reads it on its own sync cadence, applies it
 * through the object that owns the ledger, and single-writer is preserved
 * rather than suspended for the duration of a repair.
 *
 * WHO IT MAY CORRECT, AND WHY THE FENCE IS SO NARROW. Only rows where:
 *
 *  1. EXACTLY ONE tag claims the contract, and that tag is a MIRROR tag
 *     (`DESK_MIRROR_SYNC_TAGS`, default the `MIRROR_` prefix). A mirror ledger
 *     is a pure optimistic copy of upstream fills — there is no strategy state
 *     to second-guess, so "make the ledger say what the broker says" is the
 *     correct repair BY CONSTRUCTION. For anything else the divergence may be
 *     the strategy's own truth mid-flight.
 *  2. `books === 0` — no desk book shares the contract. If a book also claims
 *     it, the broker's number is the SUM of two owners and attributing the
 *     difference to the mirror alone would repair the wrong record.
 *  3. The SAME divergence (tag, symbol, same broker number) was seen on TWO
 *     consecutive passes. A fill racing the compare scan produces a divergence
 *     that is real for one snapshot and gone the next; a correction filed off
 *     one sighting would "repair" the ledger back to a state the broker has
 *     already left.
 *  4. No PLACED gateway order is in flight for the tag+symbol — an in-flight
 *     order means the divergence may be about to resolve itself.
 *
 * Anything divergent that names a mirror tag AMONG OTHERS is an ALERT in the
 * order feed and never a correction: ambiguous attribution is a human's
 * question. So is a contract the master cannot resolve, and a broker quantity
 * that is not a whole number of lots — a correction this job is not sure of is
 * worse than the divergence it would paper over.
 *
 * LOUD BUT NOT NOISY. The request upsert is idempotent (one document per
 * instance, replaced on every pass while the divergence stands, so the runner's
 * TTL clock keeps resetting); the JOURNAL line is for humans and goes out once
 * per instance WHEN THE CORRECTION SET CHANGES, not once per pass — a 60s
 * cadence writing the same sentence all afternoon is how a warning stops being
 * read.
 */

import type { InstrumentRef } from '@algomaker/order-bus'
import type { ApiDeps } from './routes/kit.ts'
import type {
  PositionsComparer,
  PositionsCompareReport,
  SymbolCompare,
} from './positions-compare.ts'
import { COLLECTIONS } from './store.ts'
/**
 * The runner's own name for its own state collection, imported rather than
 * restated — the same rule and the same reason as `routes/runner.ts:43`: two
 * copies of `'desk-strategy-state'` in this tree is two things to change, and
 * the miss is SILENT — a request filed into a collection nothing reads.
 */
import { STATE_COLLECTION } from '../../runner/src/state-store.ts'

/**
 * Where a correction request is parked, under the `TAG:mode` scope — the
 * sibling of the runner's `CLEAR_REQUEST_KEY`. Defined HERE because this is
 * the writer; the runner side (the consumer, built separately) defines its own
 * matching constant, and the test asserts the literal so the two cannot drift
 * without a red build on at least one side.
 */
export const SYNC_REQUEST_KEY = 'runner:sync-request'

/** The pass cadence. One minute: fast enough that a phantom does not survive a
 * session, slow enough that the 5-minute comparer feeds it fresh data often. */
export const DEFAULT_MIRROR_SYNC_MS = 60_000

/** The default mirror set: every `MIRROR_*` tag, matched by prefix. */
export const DEFAULT_MIRROR_TAG_PREFIXES: readonly string[] = ['MIRROR_']

/**
 * The mirror set from the environment: `DESK_MIRROR_SYNC_TAGS`, a comma list
 * of PREFIXES. Empty or unset means the default — there is no way to spell
 * "match everything", deliberately: this job's licence to write is the
 * narrowness of the set it may write for.
 */
export function mirrorTagPrefixes(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env['DESK_MIRROR_SYNC_TAGS']
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIRROR_TAG_PREFIXES
  const prefixes = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return prefixes.length === 0 ? DEFAULT_MIRROR_TAG_PREFIXES : prefixes
}

/**
 * The kill switch, read PER PASS rather than at boot: an operator watching a
 * bad correction go out must be able to stop the next one with an env edit and
 * a restart of nothing. `'0'`/`'false'`/unset mean enabled; anything else set
 * means disabled — the switch is for turning OFF, so ambiguity reads as off.
 */
export function mirrorSyncDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['DESK_MIRROR_SYNC_DISABLED']
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false'
}

// ------------------------------------------------------------- the request

/**
 * One correction: the SIGNED LOTS the ledger should hold, per broker truth.
 *
 * The full `InstrumentRef` rides along so the runner can create an entry it
 * never held (broker long, ledger empty) without asking the master — which may
 * no longer answer by the time it consumes the request.
 */
export interface SyncCorrection {
  readonly tradingsymbol: string
  /** TARGET signed lots — what the ledger should say, not a delta. */
  readonly lots: number
  readonly instrument: InstrumentRef
}

/** What this job writes and the runner consumes. Shaped like `ClearRequest`:
 * `requestedAt` is what lets the consumer refuse a stale instruction. */
export interface SyncRequest {
  readonly corrections: readonly SyncCorrection[]
  readonly requestedBy: 'mirror-sync'
  readonly requestedAt: number
}

// --------------------------------------------------------------- the ports

/**
 * Everything this job may do. THE WRITE SURFACE IS THE GUARANTEE: `file`
 * upserts one request document per instance, `journal` appends order-feed
 * lines, and that is all — there is no way from here to place an order, edit a
 * book, or touch a ledger. The repair happens in the runner or not at all.
 */
export interface MirrorSyncPorts {
  now(): number
  log(msg: string, ctx?: Record<string, unknown>): void
  /** The kill switch, asked on every pass — see `mirrorSyncDisabled`. */
  disabled(): boolean
  /** The mirror set, asked on every pass so an env change needs no redeploy of
   * this object's captured state. */
  tagPrefixes(): readonly string[]
  /**
   * THE SAME COMPARER INSTANCE `main.ts` drives on its own interval — one
   * single-flight guard, one `last()` cache. A second comparer here would run
   * the three collection scans twice and could disagree with the report on the
   * operator's screen about the very divergence being repaired.
   */
  readonly comparer: Pick<PositionsComparer, 'run' | 'last'>
  /** Is a PLACED gateway order in flight for this tag+symbol? A read of
   * `desk-gateway-orders` and nothing else. */
  pendingOrder(tag: string, tradingsymbol: string): Promise<boolean>
  /** The instrument master's answer, or null — never a guess. Asked per pass
   * because the master refreshes out of band. */
  resolveSymbol(tradingsymbol: string): InstrumentRef | null
  /** Upsert the request under (`instance`, `SYNC_REQUEST_KEY`). Repeats
   * REPLACE — a stack of requests would be a stack of stale instructions. */
  file(instance: string, request: SyncRequest, nowMs: number): Promise<void>
  /** `DeskStore.journalBlocked` — the order feed. Never throws. */
  journal(events: readonly Record<string, unknown>[]): Promise<void>
  /** The dashboard push. Absent when nothing is attached. */
  notify?(mode: 'live', event: Record<string, unknown>): void
}

export interface MirrorSync {
  /** One pass. Single-flight, and it NEVER rejects — it lives on a timer. */
  run(): Promise<void>
}

// ----------------------------------------------------------------- the job

/** A sighting: one divergence as one pass saw it, keyed `tag|symbol`. */
type Sightings = Map<string, number>

/**
 * The detector. A CLASS because four things must survive between passes: the
 * single-flight flag, the previous pass's sightings (the stability guard), the
 * correction set last journalled per instance (the noise guard), and the alert
 * set last journalled (same).
 */
class MirrorSyncJob implements MirrorSync {
  readonly #d: MirrorSyncPorts
  #running = false
  /**
   * The divergences the PREVIOUS pass saw, `tag|symbol` -> broker units. A
   * correction is filed only when the current pass sees the SAME key with the
   * SAME broker number — a fill racing the compare scan changes the number, so
   * it can never be confirmed and can never trigger a repair.
   */
  #sightings: Sightings = new Map()
  /**
   * The `asOf` of the report last acted on. `comparer.run()` returns null when
   * a pass is already in flight and we fall back to `last()` — which can hand
   * back the very report the previous pass already read. Two reads of ONE scan
   * are one sighting, not two; without this stamp the fallback path would
   * satisfy the stability guard with itself.
   */
  #lastActedAsOf = -1
  /** Correction signature last JOURNALLED per instance — the upsert repeats,
   * the sentence does not. Cleared when the instance stops needing repair, so
   * a recurrence is news again. */
  readonly #journalledFor = new Map<string, string>()
  /** Alert signatures journalled on the previous pass, for the same reason. */
  #alerted = new Set<string>()

  constructor(ports: MirrorSyncPorts) {
    this.#d = ports
  }

  /**
   * NEVER REJECTS. This sits on an unref'd interval, and an unhandled
   * rejection inside a timer is fatal on Node >= 15 — losing the bridge to a
   * housekeeping job would be the worst possible trade, the same bargain every
   * other loop in this tree makes.
   */
  async run(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      await this.#pass()
    } catch (err) {
      this.#d.log('mirror sync pass failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.#running = false
    }
  }

  async #pass(): Promise<void> {
    // The kill switch, EVERY pass. Nothing else is touched: the in-memory
    // sightings simply age in place, and re-enabling starts confirming afresh.
    if (this.#d.disabled()) return
    const now = this.#d.now()

    /**
     * The freshest report the comparer will give. `run()` is single-flight and
     * answers null when the 5-minute interval's own pass is mid-read — the
     * fallback is whatever it produced last, which is a real (dated) answer.
     * A comparer that THROWS is a comparer that could not read its sources;
     * `last()` may still hold something usable.
     */
    let report: PositionsCompareReport | null = null
    try {
      report = await this.#d.comparer.run(now)
    } catch (err) {
      this.#d.log('mirror sync: compare pass failed — falling back to the last report', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (report === null) report = await this.#d.comparer.last()
    if (report === null) return

    /**
     * ONLY A VERDICT IS EVIDENCE. `comparable: false` means every broker
     * number is null and `divergent` is empty by construction — but the rule
     * is stated rather than relied on: a report with no verdict neither
     * confirms nor refutes a sighting, so the map is left exactly as it was.
     */
    if (report.comparable !== true || report.mode !== 'live') return

    // ONE SCAN IS ONE SIGHTING — see `#lastActedAsOf`.
    if (report.asOf === this.#lastActedAsOf) return
    this.#lastActedAsOf = report.asOf

    const prefixes = this.#d.tagPrefixes()
    const isMirror = (tag: string): boolean => prefixes.some((p) => tag.startsWith(p))
    const rows = new Map<string, SymbolCompare>(report.symbols.map((s) => [s.symbol, s]))

    const seen: Sightings = new Map()
    /** Corrections confirmed and buildable this pass, grouped per mirror tag. */
    const ready = new Map<string, { correction: SyncCorrection; row: SymbolCompare }[]>()
    const alerts: { signature: string; event: Record<string, unknown> }[] = []

    for (const symbol of report.divergent) {
      // ONE BAD ROW NEVER STOPS THE PASS: the next symbol's phantom is not
      // hostage to this one's unreadable master entry or Mongo hiccup.
      try {
        const row = rows.get(symbol)
        if (row === undefined || row.broker === null) continue

        const mirrorClaims = row.claimedBy.filter(isMirror)
        // Not the mirror set's contract — some other record's divergence, and
        // the positions-compare report already tells the operator about it.
        if (mirrorClaims.length === 0) continue

        /**
         * A MIRROR TAG AMONG MULTIPLE CLAIMANTS. The broker's number is a sum
         * over every claimant, and deciding how much of the difference belongs
         * to the mirror is attribution — a human's question. ALERTED, never
         * corrected.
         */
        if (row.claimedBy.length > 1) {
          alerts.push(
            alertOf(row, now, 'ambiguous', `claimed by ${row.claimedBy.join(' + ')} at once — ` +
              'the broker number is a sum over all of them, so no correction can be attributed ' +
              'to the mirror alone. Look at it by hand.'),
          )
          continue
        }
        // Exactly one claimant from here on, and it is a mirror tag.
        const tag = mirrorClaims[0] as string

        // A desk book also carries quantity on this contract (a claimant list
        // of one with books != 0 should not exist, but the fence is cheap and
        // the cost of being wrong through it is a wrong repair).
        if (row.books !== 0) continue

        /**
         * THE STABILITY GUARD. Record this sighting for the NEXT pass, and act
         * only if the PREVIOUS pass saw the identical one — same tag, same
         * symbol, same broker number. A moved number restarts the count.
         */
        const key = `${tag}|${symbol}`
        seen.set(key, row.broker)
        if (this.#sightings.get(key) !== row.broker) continue

        /**
         * THE PENDING-ORDER GUARD, checked LAST and per pass: a PLACED gateway
         * order for this tag+symbol means the divergence may be about to
         * resolve itself, and a correction filed under it would race the fill
         * it is about to book. The sighting above still stands, so the pass
         * after the order settles needs no new confirmation wait.
         */
        if (await this.#d.pendingOrder(tag, symbol)) {
          this.#d.log('mirror sync: divergence confirmed but an order is in flight — holding', {
            tag,
            symbol,
          })
          continue
        }

        /**
         * BUILD THE CORRECTION, or say exactly why one cannot be built. The
         * target is SIGNED LOTS = broker units / lot size, and both failure
         * modes here are the master's, not the broker's: a contract the master
         * has forgotten (expired, or mid-refresh) cannot be sized, and a
         * broker quantity that is not a whole number of lots means the lot
         * size on file is wrong for the contract actually held. Filing either
         * would hand the runner a number this job is not sure of.
         */
        const ref = this.#d.resolveSymbol(symbol)
        if (ref === null || !(ref.lotSize > 0)) {
          alerts.push(
            alertOf(row, now, 'master-miss', `the instrument master cannot resolve ${symbol}, ` +
              'so the broker quantity cannot be converted to lots. No correction filed — ' +
              'clear it by hand if the contract has expired.', tag),
          )
          continue
        }
        const lots = row.broker / ref.lotSize
        if (!Number.isInteger(lots)) {
          alerts.push(
            alertOf(row, now, 'fractional-lots', `broker holds ${row.broker} units of ${symbol} ` +
              `but the lot size on file is ${ref.lotSize} — not a whole number of lots, so the ` +
              'lot size is wrong or the position is not what it looks like. No correction filed.', tag),
          )
          continue
        }

        const list = ready.get(tag) ?? []
        list.push({ correction: { tradingsymbol: symbol, lots, instrument: ref }, row })
        ready.set(tag, list)
      } catch (err) {
        this.#d.log('mirror sync: one divergent row failed — the rest of the pass continues', {
          symbol,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // The stability map is REPLACED, never merged: a divergence the comparer
    // no longer reports is a divergence that resolved, and keeping its
    // sighting would let it confirm a future, unrelated one.
    this.#sightings = seen

    // ---- file the requests, one document per instance, replaced not stacked
    const events: Record<string, unknown>[] = []
    for (const [tag, entries] of ready) {
      try {
        entries.sort((a, b) =>
          a.correction.tradingsymbol < b.correction.tradingsymbol ? -1 : 1,
        )
        const corrections = entries.map((e) => e.correction)
        const instance = `${tag}:live`
        /**
         * UPSERTED ON EVERY PASS while the divergence stands — deliberately,
         * not wastefully: `requestedAt` is what the runner's TTL judges, and a
         * request that stopped being refreshed while its divergence persisted
         * would expire into silence. Repeats REPLACE on (tag, key).
         */
        await this.#d.file(instance, { corrections, requestedBy: 'mirror-sync', requestedAt: now }, now)

        // The journal line, ONCE PER DISTINCT CORRECTION SET — the humans'
        // record, not the runner's instruction.
        const signature = corrections.map((c) => `${c.tradingsymbol}:${c.lots}`).join(',')
        if (this.#journalledFor.get(instance) !== signature) {
          this.#journalledFor.set(instance, signature)
          events.push(correctionEvent(instance, tag, entries, now))
        }
      } catch (err) {
        this.#d.log('mirror sync: filing the correction FAILED — will retry next pass', {
          tag,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // An instance that no longer needs repair forgets its journalled set, so
    // the SAME phantom coming back next week is news again.
    for (const instance of [...this.#journalledFor.keys()]) {
      if (!ready.has(instance.slice(0, instance.lastIndexOf(':')))) {
        this.#journalledFor.delete(instance)
      }
    }

    // ---- alerts: journal only what the previous pass did not already say
    const alertedNow = new Set<string>()
    for (const a of alerts) {
      alertedNow.add(a.signature)
      if (!this.#alerted.has(a.signature)) events.push(a.event)
    }
    this.#alerted = alertedNow

    if (events.length === 0) return
    await this.#d.journal(events)
    if (this.#d.notify === undefined) return
    for (const event of events) {
      try {
        this.#d.notify('live', event)
      } catch {
        /* a dashboard that missed a push is an inconvenience */
      }
    }
  }
}

// ---------------------------------------------------------------- the events

/**
 * The correction, as a row of the order feed — shaped like the submit refusal
 * path's events (`submit.ts:#journal`) and `positions-compare.ts:summaryEvent`,
 * so the existing feed renders it with no changes. `ok: false` because a filed
 * correction means the optimistic booking was WRONG, which is the fact the
 * operator needs, however routine the repair.
 */
function correctionEvent(
  instance: string,
  tag: string,
  entries: readonly { correction: SyncCorrection; row: SymbolCompare }[],
  now: number,
): Record<string, unknown> {
  const phrases = entries.map(
    (e) => `${e.correction.tradingsymbol} ledger ${e.row.ledger} → ${e.row.broker} (broker truth)`,
  )
  const only = entries.length === 1 ? entries[0] : undefined
  return {
    clientOrderId: `mirror-sync-${instance}-${now}`,
    phase: 'STATUS',
    ok: false,
    tag,
    // The contract when there is one; the job's name when the sentence spans
    // several — the same choice `summaryEvent` makes for the same reason.
    tradingsymbol: only === undefined ? 'mirror-sync' : only.correction.tradingsymbol,
    ts: now,
    status: 'SYNC',
    error: `mirror sync: ${phrases.join('; ')} — correction filed for ${tag}`,
    detail: {
      mode: 'live',
      op: 'mirror-sync',
      instance,
      corrections: entries.map((e) => ({
        tradingsymbol: e.correction.tradingsymbol,
        lots: e.correction.lots,
      })),
      requestedAt: now,
    },
  }
}

/** An alert: a divergence this job SAW and deliberately did not touch. */
function alertOf(
  row: SymbolCompare,
  now: number,
  reason: 'ambiguous' | 'master-miss' | 'fractional-lots',
  message: string,
  tag = 'mirror-sync',
): { signature: string; event: Record<string, unknown> } {
  return {
    // The signature carries the broker number so a CHANGED ambiguity —
    // different quantity, same claimants — reads as a new fact.
    signature: `${reason}|${tag}|${row.symbol}|${row.broker}`,
    event: {
      clientOrderId: `mirror-sync-alert-${row.symbol}-${now}`,
      phase: 'STATUS',
      ok: false,
      tag,
      tradingsymbol: row.symbol,
      ts: now,
      status: 'ALERT',
      error: `mirror sync ALERT (${reason}): ${row.symbol} — ${message}`,
      detail: {
        mode: 'live',
        op: 'mirror-sync-alert',
        reason,
        claimedBy: [...row.claimedBy],
        broker: row.broker,
        books: row.books,
        ledger: row.ledger,
      },
    },
  }
}

export function createMirrorSync(ports: MirrorSyncPorts): MirrorSync {
  return new MirrorSyncJob(ports)
}

// ---------------------------------------------------------------- the wiring

/** The real collections behind `MirrorSyncPorts`. */
export function mirrorSyncPorts(deps: ApiDeps, comparer: PositionsComparer): MirrorSyncPorts {
  return {
    now: () => deps.now(),
    log: deps.log,
    // Read per pass, never captured — the whole point of the kill switch.
    disabled: () => mirrorSyncDisabled(process.env),
    tagPrefixes: () => mirrorTagPrefixes(process.env),
    comparer,
    /**
     * The broker sweep's own field names (`tag`, `tradingsymbol`, state
     * `'PLACED'`), verified against what the gateway writes. `findOne` because
     * the question is existence, not the order.
     *
     * LIVE DOCUMENTS ONLY. This job compares the desk's LIVE ledger against the
     * BROKER's positions, and it defers a repair while a live order for the
     * contract is still working. Since the engine's paper lifecycle landed
     * (`rail.ts`, D14) this collection also holds simulated orders, and a
     * resting PAPER order on the same tag and contract would defer a real
     * divergence indefinitely — the ledger stays wrong for as long as the
     * rehearsal runs. `$ne` matches a missing field, so this narrows to live
     * without excluding a single document that already qualified.
     *
     * (It also settles the ticket-13 review note asking for this filter to be
     * pinned in a comment: the fence is now stated in the query, not inferred
     * from which callers happen to thread a tranche dial.)
     */
    pendingOrder: async (tag, tradingsymbol) => {
      const doc = await deps.db
        .collection(COLLECTIONS.gatewayOrders)
        .findOne({ tag, tradingsymbol, state: 'PLACED', mode: { $ne: 'paper' } })
      return doc !== null && doc !== undefined
    },
    /**
     * `deps.master.current()` on EVERY call, never hoisted — the master is
     * refreshed out of band, and for an expiry-day roll a captured one is the
     * difference between a resolved contract and a phantom. A master that
     * throws answers "I do not know", which this job alerts on honestly.
     */
    resolveSymbol: (tradingsymbol) => {
      try {
        return deps.master.current().resolveSymbol(tradingsymbol)
      } catch {
        return null
      }
    },
    file: async (instance, request, nowMs) => {
      await deps.db.collection(STATE_COLLECTION).updateOne(
        { tag: instance, key: SYNC_REQUEST_KEY },
        { $set: { tag: instance, key: SYNC_REQUEST_KEY, value: request, updatedAt: nowMs } },
        { upsert: true },
      )
    },
    journal: async (events) => {
      await deps.store.journalBlocked(events)
    },
    ...(deps.stream === undefined
      ? {}
      : { notify: (mode: 'live', event: Record<string, unknown>): void => deps.stream?.publish(mode, event) }),
  }
}

export interface MirrorSyncOptions {
  readonly intervalMs?: number
}

/**
 * Start the loop. `.catch` on every tick and `unref()` on the timer, for the
 * reason every other interval in this tree carries both — and `run()` itself
 * never rejects, so the `.catch` is the second belt on the same trousers.
 */
export function startMirrorSync(
  deps: ApiDeps,
  comparer: PositionsComparer,
  opts: MirrorSyncOptions = {},
): { sync: MirrorSync; stop: () => void } {
  const sync = createMirrorSync(mirrorSyncPorts(deps, comparer))
  const intervalMs = opts.intervalMs ?? DEFAULT_MIRROR_SYNC_MS
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void sync.run().catch((err: unknown) => {
      deps.log('mirror sync tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, intervalMs)
  timer.unref()
  return {
    sync,
    stop: (): void => {
      stopped = true
      clearInterval(timer)
    },
  }
}
