/**
 * THE SUPERVISOR'S MEMORY — one document per (tag, mode), one writer at a time.
 *
 * Everything the engine may not recompute from the market lives here: the
 * `RuleState` it decided against, the package still working, the lots the desk
 * protected by hand, realised P&L, and the id of a decision that was posted but
 * whose outcome was never seen. A supervisor that restarts mid-session reads
 * this and carries on; without it, a restart is a book that forgets it locked,
 * forgets what it owes, and re-decides from a blank slate.
 *
 * ── 1. THE SINGLE-WRITER DISCIPLINE ────────────────────────────────────────
 * `lease.ts` is what makes one writer TRUE. This file is what catches it when
 * it is not. The two are not redundant: a lease can lapse under a stop-the-
 * world pause while the process holding it is still running, and that process
 * — believing it steers — will happily write the state it computed thirty
 * seconds ago over the top of the new owner's. Last writer wins, and the loser
 * is the one with the current book.
 *
 * So every `save` is a COMPARE-AND-SET on `updatedAt`: the version the caller
 * READ is in the filter, and a writer whose read is stale matches no document
 * and is told `false`. It does not throw, and it does not retry itself —
 * `false` means "reload and decide again against what is really there", which
 * is the only safe response, because the state that won may have routed orders
 * this one knows nothing about.
 *
 * The first save is the same conflict wearing different clothes: there is no
 * document to filter on, so the CAS is an UPSERT and the loser collides with
 * the `key` UNIQUE INDEX. That index is load bearing — without it the upsert
 * inserts a SECOND document for the same book and the two supervisors each get
 * their own private memory of it, which is the exact failure the CAS exists to
 * stop, made permanent. `ensureIndexes()` must run before the first save.
 *
 * `updatedAt` is a version that happens to be a millisecond stamp, and it may
 * never stand still: two saves inside one millisecond would otherwise leave an
 * identical version behind and a third writer holding it would be waved
 * through against a document it never read. `nextVersion` is the only correct
 * way to stamp one (same rule as `apps/api/src/store.ts:saveBook`), and `save`
 * REFUSES a version that does not advance rather than writing an ambiguous
 * one. After a `true`, the version on disk is exactly the `next.updatedAt` the
 * caller passed — so the caller holds current state and does not have to
 * re-read to save again.
 *
 * ── 2. ABSENT-VS-ZERO, ON THE WAY BACK IN ──────────────────────────────────
 * `RuleState` has no optional fields on purpose (see `desk-engine/types.ts`):
 * Python's `st[...]` dict let "never locked" and "locked, streak 0" be the
 * same read, and that ambiguity is what the fully-spelled type retires. A
 * document, though, is whatever was written when it was written — an older
 * build's row, a hand-repair in the shell — and `doc.ruleState as RuleState`
 * would hand the engine `undefined` where it declares `number`. `rcCredit + x`
 * is then `NaN` and every comparison against it is false, silently; a missing
 * `targetLocked` is falsy, so a locked book reads as unlocked and sells again.
 *
 * `load` therefore HYDRATES field by field, and the fallback is the
 * `EMPTY_RULE_STATE` value — a decision taken here in the open, not an
 * accident of `undefined` propagating. The literal is enumerated rather than
 * spread so that a new field on `RuleState` is a type error in this file
 * instead of a field that silently reads as missing forever.
 *
 * ONE THING IS DELIBERATELY NOT VALIDATED HERE: `workingPackage.remaining`.
 * Those are `WireAction`s, and the process that EXECUTES one is the process
 * that must decide whether it is executable — so a malformed action survives
 * the round trip and surfaces at the executor (Task 14 / desk-api's decision
 * endpoint), where it is refused against the live contract rather than against
 * a second, quieter copy of it kept in this file. What hydration does promise
 * is the SHAPE around them: `remaining` is always an array, and every element
 * is an object.
 *
 * NON-FINITE NUMBERS ARE REFUSED AT THE WRITE. A `NaN` realised P&L is a
 * number BSON will happily store and every later read will happily poison; it
 * is caught here, naming the field, on the write that introduced it rather
 * than a day later in a P&L that stopped adding up. Hydration treats one that
 * somehow got past that — a hand-edit in the shell is the only way left — as
 * absent, because a `NaN` reaching the engine makes every comparison against
 * it false and can only be found by reading the rules line by line.
 */

import { EMPTY_RULE_STATE, TRIGGERS, hydratePlaybookState } from '@algomaker/desk-engine'
import type {
  DecisionRequest,
  Mode,
  OptType,
  RuleState,
  Side,
  Trigger,
  WireAction,
} from '@algomaker/desk-engine'
import { isDuplicateKey } from '../../api/src/errors.ts'

/** THE collection. This file owns the name. */
export const SUPERVISOR_STATE_COLLECTION = 'desk-supervisor-state'

/**
 * Where hydration says what it DROPPED.
 *
 * Optional, and a no-op by default, because most readers of this store have
 * nothing to say to an operator — but a dropped basis row is a fill that can
 * never be folded, and that has to be sayable rather than merely true.
 */
export type StateLog = (msg: string, ctx?: Record<string, unknown>) => void
const SILENT: StateLog = () => undefined

/**
 * ONE ROW OF THE BOOK AS A WORKING PACKAGE FOUND IT — the basis its fills are
 * measured against.
 *
 * A fill says `{instrument, side, qty, price}` and nothing else, and two of the
 * three things the host does with one need to know what the book held BEFORE
 * the package went out:
 *
 *   REALISED P&L. Banking a buy-back needs the entry the short was sold at.
 *   desk-api folds the fill into `desk-books` the moment it lands, so by the
 *   time the outcome is read the leg may already be gone from the book — and a
 *   realised number taken off a leg that is no longer there is zero, silently.
 *
 *   `rcStack`. The LIFO unwind is keyed by (strike, optType), and a
 *   tradingsymbol does not carry either. The desk's own rule is that a contract
 *   is LOOKED UP, never parsed (`routes/engine.ts`), so the identity is recorded
 *   at the moment the package is formed rather than re-derived from a string.
 *
 * Persisted because a supervisor that crashes between the post and the fill must
 * still be able to fold the outcome it comes back to. `entry`/`lots` are 0 for
 * an `open`, which has no prior position — and that is exactly what makes an
 * open realise nothing.
 */
export interface PackageBasis {
  readonly instrument: string
  readonly strike: number
  readonly optType: OptType
  /** The side of the POSITION this action moves; a fresh open's own side. */
  readonly side: Side
  readonly op: 'open' | 'close' | 'resize'
  /**
   * THE LEAN THIS LEG BELONGED TO when the package formed. `''` = none.
   *
   * `#settle` folds a realised close into `dlDayRealized` — the day's bank —
   * alone; there is no per-lean bank to credit. It has to be recorded here
   * rather than looked up at settle time for the same reason `entry` is:
   * desk-api folds each fill into `desk-books` as it lands, so the leg whose
   * stamp is wanted may be gone by the time the outcome is read.
   */
  readonly leanId: string
  /** Per-share entry of the position being moved. 0 for an open. */
  readonly entry: number
  /** Lots held before this package. 0 for an open. */
  readonly lots: number
  readonly lotSize: number
  /** What this action intends to move, in SHARES — the wire's own unit. */
  readonly intentQty: number
}

/**
 * One fold of `cumRealized`, and what it was measured off.
 *
 * `amount` is what that decision added (it can be negative), so a true-up can
 * subtract the optimistic figure and add the broker's without re-walking the
 * ledger.
 */
export interface RealizedFold {
  readonly decisionId: string
  /** `'fill'` = a real terminal fill. `'optimistic-mark'` = the live rail. */
  readonly basis: 'fill' | 'optimistic-mark'
  readonly amount: number
  readonly at: number
}

/**
 * How many folds are kept. A live book folds a handful a day, so this is weeks
 * of history in a document that must not grow without bound; the durable record
 * is `desk-engine-decisions`, which is append-only and unpruned. Oldest first
 * out, and the trim is stated rather than silent because a true-up that ran
 * against a trimmed list would find less than it expected.
 */
export const REALIZED_BASIS_KEPT = 200

/** Everything one book's supervisor may not recompute from the market. */
export interface SupervisorBookState {
  /** `${tag}:${mode}` — see `stateKey`. */
  readonly key: string
  readonly ruleState: RuleState
  /** The package still owed to the broker, or null when nothing is working. */
  readonly workingPackage: {
    readonly decisionId: string
    readonly remaining: ReadonlyArray<WireAction>
    /**
     * THE REQUEST AS POSTED, so a boot replay is verbatim (spec §7: "on boot an
     * `inFlight` decisionId is re-POSTed verbatim").
     *
     * The replay is only harmless because desk-api answers a claimed id with the
     * ORIGINAL outcome — but the crash this survives may have happened BEFORE
     * the post ever landed, in which case the replay is the first post and its
     * body is what routes. Reconstructing that body from the market at boot
     * would route a package this supervisor never decided on.
     *
     * `null` for a document written before this field existed, or one whose
     * request no longer names this decision. There is NO fallback: the host
     * cannot rebuild a request it did not make, so it ABANDONS the flight with
     * an error naming the id and the manual remedy (`engine-host.ts:#resolve`).
     * A reconstructed envelope would post a package this supervisor never
     * decided on, under an id that may not be claimed.
     */
    readonly request: DecisionRequest | null
    /** The book rows this package moves, as they stood when it formed. */
    readonly basis: ReadonlyArray<PackageBasis>
    /**
     * WHEN AND WHERE THIS PACKAGE WAS DECIDED — the maker quote's invalidation
     * clock (spec §8: "cancel + re-evaluate … after `rest_max_min`, or when the
     * underlying moves ≥ 1 strike step").
     *
     * Both are DURABLE rather than held in the host's memory, and that is the
     * whole reason they are here. A resting quote survives a supervisor restart —
     * it is at the gateway, not in this process — so a clock that restarted with
     * the process would leave a quote from 10:05 resting until 10:25 after a
     * 10:15 bounce, and would re-anchor the strike-move test to whatever spot
     * was when the new process booted, forgetting the move that had already
     * happened. The armed intent is deliberately in memory (`engine-host.ts`
     * header) because `confirm_ms` is a claim about what this process WATCHED;
     * `rest_max_min` is a claim about an order that exists whether anyone is
     * watching or not.
     *
     * `0` on a document written before these fields existed, which reads as
     * "no invalidation clock" — the package is still polled to a terminal
     * outcome exactly as before, and a guard can still preempt it.
     */
    readonly formedAt: number
    /** `ChainSnap.spot` — the forward — when the package formed. `0` = unknown. */
    readonly formedSpot: number
  } | null
  /** instrument -> lots the desk pinned by hand; the engine may not touch them. */
  readonly protectedQty: Readonly<Record<string, number>>
  readonly cumRealized: number
  /**
   * WHAT EACH FOLD WAS MEASURED OFF — newest last, bounded (see
   * `REALIZED_BASIS_KEPT`).
   *
   * `cumRealized` is a single number and the two rails do not earn it the same
   * way. On PAPER the fills desk-api reports are the gateway's own terminal
   * fills, so `basis: 'fill'` is literally true. On LIVE the decision books
   * OPTIMISTICALLY at route time (`service.ts` returns the routed plan's marks)
   * and `reconcile-live.ts` later restates `desk-books` from the broker's
   * record — but nothing restates THIS number. So a live fold is
   * `'optimistic-mark'`: real money, measured off a mark that the broker may
   * have disagreed with by a tick.
   *
   * Stamped rather than inferred so the invariant sweep and a later true-up can
   * FIND the folds that need re-measuring, per decisionId, instead of
   * re-deriving which rail each rupee came from.
   */
  readonly cumRealizedBasis: ReadonlyArray<RealizedFold>
  /** A decision that was posted and whose outcome has not been seen. */
  readonly inFlight: string | null
  /** Decision sequence; `${tag}:${mode}:${seq}` is the idempotency key. */
  readonly seq: number
  /** CAS version. 0 = no document yet. Stamp it with `nextVersion`. */
  readonly updatedAt: number
}

/**
 * Minimal Mongo surface. Same narrow-port reasoning as `apps/api/src/store.ts`
 * — and `findOneAndUpdate` is why this is its own port rather than that file's
 * `Collection`, which does not declare it.
 */
export interface StateCollection {
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

/**
 * One tag steered in paper and in live is TWO books.
 *
 * They share a name and nothing else — different legs, different realised
 * P&L, different locks — and a key that was the tag alone would have the paper
 * run's state steering the live position.
 */
export function stateKey(tag: string, mode: Mode): string {
  return `${tag}:${mode}`
}

/** A book no supervisor has ever written. `updatedAt` 0 = "no document". */
export function emptyBookState(tag: string, mode: Mode): SupervisorBookState {
  return {
    key: stateKey(tag, mode),
    ruleState: EMPTY_RULE_STATE,
    workingPackage: null,
    protectedQty: {},
    cumRealized: 0,
    cumRealizedBasis: [],
    inFlight: null,
    seq: 0,
    updatedAt: 0,
  }
}

/**
 * The next CAS version: the clock, but never allowed to stand still.
 *
 * A saved version must STRICTLY exceed the one it replaces, or two writes in
 * one millisecond leave a version a third writer can still match. A clock that
 * steps backwards (NTP) has the same hazard pointing the other way.
 */
export function nextVersion(prev: SupervisorBookState, nowMs: number): number {
  return Math.max(nowMs, prev.updatedAt + 1)
}

// ------------------------------------------------------------- hydration

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export function hydrateRuleState(raw: unknown): RuleState {
  const d = obj(raw) ?? {}
  return {
    rcCredit: num(d['rcCredit'], EMPTY_RULE_STATE.rcCredit),
    rcEodDay: str(d['rcEodDay'], EMPTY_RULE_STATE.rcEodDay),
    gkAnchor: num(d['gkAnchor'], EMPTY_RULE_STATE.gkAnchor),
    gkStreak: num(d['gkStreak'], EMPTY_RULE_STATE.gkStreak),
    scrapBanned: arr(d['scrapBanned']).filter((s): s is string => typeof s === 'string'),
    targetStreak: num(d['targetStreak'], EMPTY_RULE_STATE.targetStreak),
    targetLocked: bool(d['targetLocked'], EMPTY_RULE_STATE.targetLocked),
    rcStack: arr(d['rcStack']).flatMap((e) => {
      const s = obj(e)
      // A stack entry that is not a full entry is DROPPED, not zero-filled: the
      // LIFO unwind reading `strike: 0` would try to buy back a strike that
      // does not exist.
      if (s === null) return []
      const strike = s['strike']
      const optType = s['optType']
      const lots = s['lots']
      if (typeof strike !== 'number' || typeof lots !== 'number') return []
      if (optType !== 'CE' && optType !== 'PE') return []
      return [{ strike, optType, lots }]
    }),
    lastActionMs: num(d['lastActionMs'], EMPTY_RULE_STATE.lastActionMs),
    // ── delta lean (hold-and-adjust spec §3) ──
    //
    // Hydrated field by field like everything above, and for the same reason: a
    // stored document is whatever was written by whatever version wrote it. A
    // row written by the v1 controller carries `dlLeanId`, `dlLeanPeak` and the
    // flip counters and NONE of the twelve below — every one of those is an
    // unknown key, which this hydrator has always ignored, and every field here
    // falls back to its `EMPTY_RULE_STATE` zero. So yesterday's row reads back
    // as a book that has not opened, which is what it is under these rules.
    // `dlStopped` and `dlDayStarted` are the two that carry over by name, and
    // that is the half that matters: a mid-session restart must never clear a
    // stop the book set itself.
    dlDayStarted: str(d['dlDayStarted'], EMPTY_RULE_STATE.dlDayStarted),
    dlStopped: bool(d['dlStopped'], EMPTY_RULE_STATE.dlStopped),
    dlOpenedMs: num(d['dlOpenedMs'], EMPTY_RULE_STATE.dlOpenedMs),
    dlOpenSide: openSide(d['dlOpenSide']),
    dlAdjustsToday: num(d['dlAdjustsToday'], EMPTY_RULE_STATE.dlAdjustsToday),
    dlLastAdjustMs: num(d['dlLastAdjustMs'], EMPTY_RULE_STATE.dlLastAdjustMs),
    dlLastAdjustRegime: str(d['dlLastAdjustRegime'], EMPTY_RULE_STATE.dlLastAdjustRegime),
    dlRegime: str(d['dlRegime'], EMPTY_RULE_STATE.dlRegime),
    dlRegimeSinceMs: num(d['dlRegimeSinceMs'], EMPTY_RULE_STATE.dlRegimeSinceMs),
    dlBlockedSinceMs: num(d['dlBlockedSinceMs'], EMPTY_RULE_STATE.dlBlockedSinceMs),
    // Dropped here, a hold book's rupee hold would restart on every load and
    // its backstop and target could never fire. A row written before it
    // existed reads 0: no line held.
    dlRupeeSinceMs: num(d['dlRupeeSinceMs'], EMPTY_RULE_STATE.dlRupeeSinceMs),
    dlDayRealized: num(d['dlDayRealized'], EMPTY_RULE_STATE.dlDayRealized),
    // ── the playbook frame's row (six-playbooks spec §4.4) ──
    //
    // One nested object, hydrated field by field by the ENGINE's own hydrator
    // rather than restated here: the engine owns `PlaybookState`, and a second
    // copy of its thirty-three fields in this file would be one more place to
    // forget the thirty-fourth. A row written before the playbooks existed has
    // no `pb` and reads as `EMPTY_PLAYBOOK_STATE`, a playbook that has not
    // traded today.
    pb: hydratePlaybookState(d['pb']),
  }
}

/**
 * A stored OPEN SIDE, or `''`.
 *
 * Narrowed rather than cast: the controller branches on this value, and a
 * string that is not one of the four would send a book down the up-side branch
 * with a side it never chose. Anything unrecognised reads as "not opened",
 * which is the state that opens the day's package.
 */
function openSide(v: unknown): RuleState['dlOpenSide'] {
  return v === 'up' || v === 'down' || v === 'none' ? v : ''
}

/**
 * The posted request, or `null` when the document does not carry a usable one.
 *
 * The SCALARS are checked because they are the identity the replay is made
 * under — a `decisionId` that is not this package's, or a mode that is not this
 * book's rail, would post the wrong thing at the wrong ledger. The ACTIONS are
 * not: they are `WireAction`s, and the process that executes one is the process
 * that validates it (see the header's note on `remaining`) — desk-api refuses a
 * malformed action against the live contract, which is a better door than a
 * second, quieter copy of it kept here.
 */
function hydrateRequest(raw: unknown, decisionId: string): DecisionRequest | null {
  const d = obj(raw)
  if (d === null) return null
  if (d['decisionId'] !== decisionId) return null
  const mode = d['mode']
  if (mode !== 'paper' && mode !== 'live') return null
  const trigger = d['trigger']
  if (!TRIGGERS.includes(trigger as Trigger)) return null
  const tag = d['tag']
  const symbol = d['symbol']
  const expiry = d['expiry']
  if (typeof tag !== 'string' || tag === '') return null
  if (typeof symbol !== 'string' || symbol === '') return null
  if (typeof expiry !== 'string' || expiry === '') return null
  const work = obj(d['work'])
  const workOf = (key: string): number | undefined => {
    const v = work?.[key]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
  }
  const trancheLots = workOf('trancheLots')
  const chaseMaxMs = workOf('chaseMaxMs')
  const chaseCrossBufferPct = workOf('chaseCrossBufferPct')
  const dials = {
    ...(trancheLots === undefined ? {} : { trancheLots }),
    ...(chaseMaxMs === undefined ? {} : { chaseMaxMs }),
    ...(chaseCrossBufferPct === undefined ? {} : { chaseCrossBufferPct }),
  }
  return {
    tag,
    mode,
    decisionId,
    symbol,
    expiry,
    trigger: trigger as Trigger,
    reason: str(d['reason'], ''),
    actions: arr(d['actions']).filter((a) => obj(a) !== null) as WireAction[],
    ...(Object.keys(dials).length === 0 ? {} : { work: dials }),
  }
}

/**
 * The basis rows, field by field — EVERY field required, NOTHING defaulted.
 *
 * A row is what a fill is folded against, so each missing field is a specific
 * wrong number rather than an absence: a `strike: 0` shrinks the wrong `rcStack`
 * entry, a `lotSize: 0` makes every fill worth zero lots, and an `entry: 0`
 * banks the whole buy-back price as profit. Dropping the row instead means the
 * host cannot attribute the fill and SAYS SO ("a fill this package cannot
 * attribute"), which is a line an operator can act on.
 *
 * `entry: 0` and `lots: 0` are legal VALUES — that is exactly what an `open`
 * row carries — so the test is on the type, never on the number.
 *
 * The drop is logged because it is silent by nature: it is only ever caused by a
 * document written by an older build or edited by hand, and the symptom is a
 * fold that quietly banks nothing.
 */
function hydrateBasis(raw: unknown, log: StateLog, key: string): PackageBasis[] {
  const out: PackageBasis[] = []
  for (const row of arr(raw)) {
    const drop = (why: string): void => {
      log('supervisor state: a working-package basis row was DROPPED — a fill on it cannot be folded', {
        key,
        why,
        row,
      })
    }
    const b = obj(row)
    if (b === null) {
      drop('not an object')
      continue
    }
    const instrument = b['instrument']
    const leanId = b['leanId']
    const strike = b['strike']
    const optType = b['optType']
    const side = b['side']
    const op = b['op']
    const entry = b['entry']
    const lots = b['lots']
    const lotSize = b['lotSize']
    const intentQty = b['intentQty']
    const bad =
      typeof instrument !== 'string' || instrument === ''
        ? 'instrument'
        : typeof strike !== 'number' || !Number.isFinite(strike)
          ? 'strike'
          : optType !== 'CE' && optType !== 'PE'
            ? 'optType'
            : side !== 'Buy' && side !== 'Sell'
              ? 'side'
              : op !== 'open' && op !== 'close' && op !== 'resize'
                ? 'op'
                : typeof entry !== 'number' || !Number.isFinite(entry)
                  ? 'entry'
                  : typeof lots !== 'number' || !Number.isFinite(lots)
                    ? 'lots'
                    : typeof lotSize !== 'number' || !Number.isFinite(lotSize) || lotSize <= 0
                      ? 'lotSize'
                      : typeof intentQty !== 'number' || !Number.isFinite(intentQty)
                        ? 'intentQty'
                        : ''
    if (bad !== '') {
      drop(`${bad} is missing or not a number`)
      continue
    }
    out.push({
      instrument: instrument as string,
      /**
       * THE ONE FIELD THIS HYDRATOR DEFAULTS, and it is not an exception to the
       * rule above — it is the rule applied.
       *
       * Every other field has a WRONG number standing in for absence, so a
       * default would corrupt a fold. `leanId` has a correct one: `''` means
       * "no lean", which is what an unstamped leg genuinely is (`LegView.leanId`,
       * and `legPositionsFrom` in `main.ts` answers the same way). A package
       * written by a build from before stamping existed therefore folds into the
       * DAY's bank exactly as it always did and adds nothing to any lean's —
       * conservative, and true. Dropping the row instead would lose the day's
       * fold as well, to say nothing about a lean.
       */
      leanId: typeof leanId === 'string' ? leanId : '',
      strike: strike as number,
      optType: optType as OptType,
      side: side as Side,
      op: op as PackageBasis['op'],
      entry: entry as number,
      lots: lots as number,
      lotSize: lotSize as number,
      intentQty: intentQty as number,
    })
  }
  return out
}

/** The provenance list, row by row. A row that is not one is dropped. */
function hydrateRealizedBasis(raw: unknown): RealizedFold[] {
  const out: RealizedFold[] = []
  for (const row of arr(raw)) {
    const r = obj(row)
    if (r === null) continue
    const decisionId = r['decisionId']
    const basis = r['basis']
    const amount = r['amount']
    const at = r['at']
    if (typeof decisionId !== 'string' || decisionId === '') continue
    if (basis !== 'fill' && basis !== 'optimistic-mark') continue
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    out.push({ decisionId, basis, amount, at })
  }
  return out.slice(-REALIZED_BASIS_KEPT)
}

function hydrateWorkingPackage(
  raw: unknown,
  log: StateLog,
  key: string,
): SupervisorBookState['workingPackage'] {
  const wp = obj(raw)
  if (wp === null) return null
  const decisionId = str(wp['decisionId'], '')
  // A package with no decision id names nothing: it cannot be resumed, polled
  // or reconciled, so it is no package at all.
  if (decisionId === '') return null
  return {
    decisionId,
    // Stored as written, read back structurally. The shape is the engine's own
    // `WireAction` and the process that EXECUTES it is the one that validates
    // it (Task 14) — a parse here would be a second, quieter contract.
    remaining: arr(wp['remaining']).filter((a) => obj(a) !== null) as WireAction[],
    request: hydrateRequest(wp['request'], decisionId),
    basis: hydrateBasis(wp['basis'], log, key),
    // 0 rather than "now" for an older document: a fabricated `formedAt` would
    // start a `rest_max_min` clock at the moment of the READ, so a quote that
    // has already rested twenty minutes would be given another ten. Absent means
    // "this clock is not running", which is what it truthfully is.
    formedAt: num(wp['formedAt'], 0),
    formedSpot: num(wp['formedSpot'], 0),
  }
}

function hydrate(key: string, doc: Record<string, unknown>, log: StateLog): SupervisorBookState {
  const rawProtected = obj(doc['protectedQty']) ?? {}
  const protectedQty: Record<string, number> = {}
  for (const [instrument, lots] of Object.entries(rawProtected)) {
    if (typeof lots === 'number' && Number.isFinite(lots)) protectedQty[instrument] = lots
  }
  return {
    key,
    ruleState: hydrateRuleState(doc['ruleState']),
    workingPackage: hydrateWorkingPackage(doc['workingPackage'], log, key),
    protectedQty,
    cumRealized: num(doc['cumRealized'], 0),
    cumRealizedBasis: hydrateRealizedBasis(doc['cumRealizedBasis']),
    // An empty id names no decision, so it is the same as none — anything that
    // polled for it would be polling for a document that cannot exist.
    inFlight: str(doc['inFlight'], '') === '' ? null : str(doc['inFlight'], ''),
    seq: num(doc['seq'], 0),
    updatedAt: num(doc['updatedAt'], 0),
  }
}

/**
 * The first path to a number BSON stores but nothing downstream survives, or
 * null when there is none. Depth-first so the message names the field.
 */
function nonFinitePath(value: unknown, path: string): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const hit = nonFinitePath(v, `${path}[${String(i)}]`)
      if (hit !== null) return hit
    }
    return null
  }
  const d = obj(value)
  if (d === null) return null
  for (const [k, v] of Object.entries(d)) {
    const hit = nonFinitePath(v, `${path}.${k}`)
    if (hit !== null) return hit
  }
  return null
}

// ----------------------------------------------------------------- store

export class StateStore {
  readonly #collection: StateCollection
  readonly #log: StateLog
  /** The in-flight-or-finished index build; see `#indexed`. */
  #indexes: Promise<void> | null = null

  constructor(collection: StateCollection, log: StateLog = SILENT) {
    this.#collection = collection
    this.#log = log
  }

  /**
   * The unique index the compare-and-set is built on. See the header: without
   * it a losing first save inserts a second document for the same book instead
   * of being refused, and each supervisor then keeps its own memory of it.
   *
   * Idempotent, and cheap to call — the build happens ONCE per instance and
   * every later call awaits the same promise.
   */
  async ensureIndexes(): Promise<void> {
    await this.#indexed()
  }

  /**
   * The index, guaranteed, before any write — WITHOUT depending on a boot path
   * remembering to ask for it.
   *
   * `save` cannot be correct without the unique key, and "the caller calls
   * `ensureIndexes()` first" is exactly the kind of precondition that survives
   * review and dies in a refactor: the failure is silent (two documents, two
   * private memories of one book) and only shows up under a race. So the guard
   * is self-invoking and the promise is cached — one `createIndex` per
   * instance, an already-resolved await on every save after it.
   *
   * A FAILED build clears the cache and rethrows: the next save retries rather
   * than inheriting a rejection forever, and until it succeeds no write goes
   * out unguarded.
   */
  async #indexed(): Promise<void> {
    this.#indexes ??= this.#collection
      .createIndex({ key: 1 }, { unique: true })
      .then(() => undefined)
      .catch((err: unknown) => {
        this.#indexes = null
        throw err
      })
    await this.#indexes
  }

  /** This book's state, or a fresh one. Never `undefined`, in any field. */
  async load(tag: string, mode: Mode): Promise<SupervisorBookState> {
    const key = stateKey(tag, mode)
    const doc = await this.#collection.findOne({ key })
    return doc === null ? emptyBookState(tag, mode) : hydrate(key, doc, this.#log)
  }

  /**
   * Write `next` if and only if the document is still the `prev` we read.
   *
   * `false` = SOMEBODY ELSE WROTE. Reload and decide again — never retry this
   * same `next`, because the state that won may have routed orders this caller
   * does not know about, and re-applying a decision taken against a book that
   * no longer exists is how one position becomes two.
   *
   * Throws only on programming errors (wrong book, a version that does not
   * advance, a number that is not one) and on real database failures.
   */
  async save(prev: SupervisorBookState, next: SupervisorBookState): Promise<boolean> {
    if (next.key !== prev.key) {
      throw new Error(
        `supervisor state save crosses books: read key ${prev.key}, writing ${next.key}`,
      )
    }
    if (next.updatedAt <= prev.updatedAt) {
      throw new Error(
        `supervisor state version must advance: ${String(prev.updatedAt)} -> ` +
          `${String(next.updatedAt)} (stamp it with nextVersion())`,
      )
    }
    const bad = nonFinitePath(next, 'state')
    if (bad !== null) {
      throw new Error(`supervisor state carries a non-finite number at ${bad} (${next.key})`)
    }
    await this.#indexed()

    try {
      await this.#collection.findOneAndUpdate(
        { key: prev.key, updatedAt: prev.updatedAt },
        {
          $set: {
            key: next.key,
            // Spread, not enumerated: a field added to `RuleState` must be
            // PERSISTED without anyone remembering to come here. Reading it
            // back is where completeness is enforced — see `hydrateRuleState`.
            ruleState: { ...next.ruleState },
            workingPackage:
              next.workingPackage === null
                ? null
                : {
                    decisionId: next.workingPackage.decisionId,
                    remaining: [...next.workingPackage.remaining],
                    // Spread for the same reason `ruleState` is: a field added
                    // to the request contract must be PERSISTED without anyone
                    // remembering to come here, and `hydrateRequest` is where
                    // what comes back is decided.
                    request:
                      next.workingPackage.request === null
                        ? null
                        : { ...next.workingPackage.request },
                    basis: next.workingPackage.basis.map((b) => ({ ...b })),
                    // The invalidation clock. Written explicitly rather than
                    // through a spread of the package, because the two nested
                    // objects above have to be copied field-wise anyway and a
                    // half-spread would be the worst of both.
                    formedAt: next.workingPackage.formedAt,
                    formedSpot: next.workingPackage.formedSpot,
                  },
            protectedQty: { ...next.protectedQty },
            cumRealized: next.cumRealized,
            // Trimmed on the WRITE as well as the read: a document is what the
            // last writer put in it, and the bound has to hold there too.
            cumRealizedBasis: next.cumRealizedBasis.slice(-REALIZED_BASIS_KEPT).map((r) => ({ ...r })),
            inFlight: next.inFlight,
            seq: next.seq,
            updatedAt: next.updatedAt,
          },
        },
        // Upsert, so the FIRST save has a path at all: there is no document to
        // match on. A loser's insert collides with the unique key — which is
        // the same conflict as a stale filter, and reads back the same way.
        { upsert: true },
      )
      return true
    } catch (err) {
      if (isDuplicateKey(err)) return false
      throw err
    }
  }
}
