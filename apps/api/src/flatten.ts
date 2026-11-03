/**
 * Flattening a position BY TAG — the operator's escape hatch, on its own.
 *
 * Lifted out of `service.ts` unchanged (2026-08-16, roadmap 18a). It is one
 * self-contained order path — reconstruct a position from the fill journal, plan
 * the exits, claim the id, route, maintain the book, report — and it shared
 * nothing with the rest of the bridge except the dependencies it is handed. In
 * `service.ts` it read as a third of the file wedged between the book paths it
 * does NOT use, which is exactly the shape that makes a money path hard to read
 * in a hurry.
 *
 * `BridgeService.flattenTag` delegates here and its signature is unchanged: this
 * is a move, not a redesign. The deps are the same object the service holds, and
 * `tellBook` is the service's own private notifier passed in — one
 * implementation, still owned by `service.ts`, because `applyDecision` needs the
 * same one.
 */

import { buildPositions } from '@algomaker/pnl'
import { refoldOnConflict } from './book-write.ts'
import { type BridgeLeg, type DeskMode, type Fill } from './contract.ts'
// The pure half of this order path. Every step that is a CALCULATION lives
// there; everything below keeps the I/O, the ordering and the crash safety.
import {
  flattenDecisionSymbol,
  flattenIsFlat,
  flattenLegResult,
  flattenWindow,
  foldRoutedFillsIntoBook,
  marketableFallback,
  partitionOpenPositions,
  plannedFlattenFills,
  resolveOpenContracts,
  unresolvedFlattenLegs,
  unresolvedFlattenSkips,
  type FlattenLegResult,
} from './decision-plan.ts'
import { errorMessage, isDuplicateKey } from './errors.ts'
import { deriveUnderlying } from '../../order-gateway/src/gateway.ts'
import type { JournalEntry } from './livebook.ts'
import { PnlStore, pnlKey } from './pnlstore.ts'
import { railFor } from './rail.ts'
import { planFlatten, type CloseStyle } from './safety.ts'
// Type-only in both directions at runtime: `service.ts` imports the class below,
// and nothing here imports a VALUE back, so there is no module cycle to resolve.
import type { BridgeDeps, DecisionStatus } from './service.ts'
import { COLLECTIONS } from './store.ts'

/**
 * The result of flattening a hosted strategy's position.
 *
 * Deliberately NOT a `DecisionResponse`: there is no `book`, because a hosted
 * strategy has none — that absence is the whole reason this path exists, and
 * returning an empty `book` would read as "flat" to anything that renders one.
 *
 * `flat` is the field an operator acts on. Everything else explains it.
 */
export interface FlattenResponse {
  readonly decisionId: string
  readonly replayed: boolean
  readonly status: DecisionStatus
  readonly tag: string
  readonly mode: DeskMode
  /** Every open contract found, with what happened to it. Never elided. */
  readonly legs: readonly FlattenLegResult[]
  /** The fills journalled for P&L — ONLY the ones that reached a rail. */
  readonly fills: readonly Fill[]
  readonly routeErrors: readonly { readonly fill: Fill; readonly error: string }[]
  /** Legs sent as MARKET because no mark was available to price them. */
  readonly unpriceable: readonly string[]
  /** Open contracts with no instrument to route on. Named, never dropped. */
  readonly unresolved: readonly string[]
  /**
   * Contracts DELIBERATELY NOT FLATTENED because the reconstruction looks
   * truncated — the first fill seen for them was not an open.
   *
   * Rebuilding from buy-backs alone nets to a position that was never held, and
   * "flattening" that opens fresh exposure in the opposite direction. Leaving
   * the leg alone and naming it is strictly safer: the operator can widen
   * `sinceMs` and retry under a new `decisionId`.
   */
  readonly truncated: readonly string[]
  /**
   * Stored fills the P&L reader refused as malformed.
   *
   * Non-empty means the reconstructed position may be WRONG — a dropped open
   * understates it and leaves real risk behind. Reported rather than absorbed
   * for the same reason `positions.complete` exists, and it FORCES `flat` false:
   * the two must never disagree.
   */
  readonly malformedFills: readonly string[]
  /**
   * True when the fill window itself hit `loadFills`' cap, so the position was
   * rebuilt from a SUBSET of the decisions in it. Same consequence as a
   * malformed fill and the same effect on `flat`.
   */
  readonly fillsTruncated: boolean
  /**
   * True only when every open contract found produced a routed order AND the
   * reconstruction it was derived from was complete.
   */
  readonly flat: boolean
  /**
   * The window held NO fills at all, so the position was reconstructed from
   * nothing and `flat` is false for that reason alone.
   *
   * Absent, never `false`, so the field only ever appears when it is the thing
   * to act on: retry with a wider `sinceMs` (0 reads everything). A book that
   * has not traded today, and a book seeded rather than traded into, both land
   * here — and both are still open.
   */
  readonly emptyWindow?: boolean
  /** The fill window the position was reconstructed from. */
  readonly window: { readonly from: number; readonly to: number }
}

/**
 * What `flattenTag` is asked for.
 *
 * Named rather than left inline only because the method now lives behind a
 * delegate in `service.ts` and both signatures must say the same thing.
 */
export interface FlattenParams {
  tag: string
  mode: DeskMode
  decisionId: string
  style: CloseStyle
  aggressionPct?: number
  /**
   * Start of the fill window, epoch ms. Defaults to the start of the current
   * IST trading day — or to 0, every fill, for a tag that has a desk book
   * (`flattenWindow`'s `positional`).
   *
   * READING TOO LITTLE IS DANGEROUS IN BOTH DIRECTIONS, which is why the
   * default is a whole trading day and why moving it is an explicit act:
   *
   *   - A window that misses part of the position UNDERSTATES it and leaves
   *     real risk open while reporting `flat: true`.
   *   - A window that starts AFTER the opens but BEFORE the closes sees only
   *     buy-backs, nets to a LONG that was never held, and would send a SELL
   *     — opening a naked short while trying to close nothing.
   *
   * Reading too much is safe: an earlier round trip that already closed nets
   * to zero and is dropped by `planFlatten`. So widen, never narrow.
   *
   * A whole IST day is the right default because hosted strategies are
   * intraday by contract — the runner's own square-off cron is a daily one.
   */
  sinceMs?: number
}

export class FlattenService {
  readonly #d: BridgeDeps
  /**
   * `BridgeService.#tellBook`, handed in rather than re-implemented.
   *
   * SYNCHRONOUS, RETURNS VOID, AND IT SWALLOWS EVERYTHING — see the method it
   * comes from. `applyDecision` needs the identical notifier, and two copies of
   * "tell the in-memory book, but never fail an order over it" is one copy too
   * many.
   */
  readonly #tellBook: (entry: JournalEntry) => void

  constructor(deps: BridgeDeps, tellBook: (entry: JournalEntry) => void) {
    this.#d = deps
    this.#tellBook = tellBook
  }

  /**
   * Flatten a HOSTED strategy's position, by tag.
   *
   * WHY THIS EXISTS (2026-07-27 audit, finding C4). `closeAll` reads
   * `desk-books`, and `/v1/desk/submit` never writes one — hosted strategies own
   * their positions internally and submit single orders, they do not declare a
   * book. So the escape hatch that makes "off means off" safe did not reach
   * them: an operator disabling `ORB_SCALP_BN` at 12:00 holding 5 lots blocked
   * the strategy's own exit, the runner dropped the tag from its supervised set
   * so its square-off cron never fired again, and `close-all` had nothing to
   * close. The position was trapped until someone logged into the broker by
   * hand. That is precisely the trap `safety.ts` exists to prevent.
   *
   * WHERE THE POSITION COMES FROM: the fills `/v1/desk/submit` journals to
   * `desk-decisions`, read through `PnlStore.loadFills` and netted by
   * `@algomaker/pnl`'s `buildPositions` — the same two pieces Phase B's P&L
   * already runs on. A third reconstruction of "what do we hold" would be a
   * third thing to keep in sync, and the one that drifts is the one that leaves
   * a position open.
   *
   * EXEMPT FROM BOTH SWITCHES, exactly as `closeAll` is. Flattening runs as the
   * OPERATOR, not as the strategy. Neither the strategy switch nor the halt is
   * consulted, because a control that traps a position is worse than what it
   * protects against. The live-rail allowlist is NOT bypassed — it is enforced
   * inside `LiveRail.route` and a tag missing from it surfaces here as a named
   * per-leg `error`, not as a silent no-op.
   *
   * NO BOOK IS WRITTEN. A hosted strategy never had one — its position lives
   * only in the fills reconstruction above, and there is nothing to write: a
   * flatten leaves the position at zero, and the closing fills journalled
   * below are what say so.
   */
  async flattenTag(params: FlattenParams): Promise<FlattenResponse> {
    const now = this.#d.clock.now()
    const window = flattenWindow(now, params.sinceMs, await this.#positional(params))
    const { from, to } = window

    /**
     * Replay check FIRST, before anything is read or routed.
     *
     * The SAME `decisionId` idempotency as `applyDecision`, enforced by the same
     * unique index on `desk-decisions.decisionId`. One id covers every leg, so a
     * retried flatten — the operator hammering the button, or two pm2 processes
     * racing — cannot double-sell.
     */
    const decisions = this.#d.store.collection<Record<string, unknown>>(COLLECTIONS.decisions)
    const existing = await decisions.findOne({ decisionId: params.decisionId })
    if (existing !== null) return replayFlatten(existing, params, window)

    /**
     * Reconstruct the position. `DeskStore` satisfies `PnlStore`'s `Database`
     * port structurally, so this is the same read Phase B's snapshot loop makes.
     */
    const load = await new PnlStore(this.#d.store).loadFills({
      from,
      to,
      tag: params.tag,
      mode: params.mode,
    })
    const fills = load.byKey.get(pnlKey(params.tag, params.mode)) ?? []
    const positions = buildPositions(fills)

    // TRUNCATION GUARD, then resolution — both pure, both in `decision-plan.ts`.
    // A contract whose first fill in the window is not an OPEN is named and left
    // alone rather than "flattened" into a naked short; a contract the master
    // does not know is named rather than routed against a fabricated ref.
    const master = this.#d.master.current()
    const { open, truncated } = partitionOpenPositions(positions, fills)
    const { resolvable, unresolved, instruments } = resolveOpenContracts(open, (s) =>
      master.resolveSymbol(s),
    )

    const plan = planFlatten({
      positions: resolvable,
      style: params.style,
      ...(params.aggressionPct === undefined ? {} : { aggressionPct: params.aggressionPct }),
      marks: (symbol) => {
        const inst = instruments.get(symbol)
        return inst === undefined ? null : this.#d.marks.price(inst)
      },
    })

    /**
     * PRICED BEFORE THE CLAIM, so the record, the response and the wire all
     * describe the same order.
     *
     * `planFlatten` emits MARKET for `fast` and for any leg that lost its mark,
     * and **the broker's API rejects market orders**. This path does not go
     * through `priceFillsForRoute` — it builds its fills here and routes them
     * directly a few lines below — so the conversion that fixed the supervisor
     * and close-all paths could never reach it, and the dashboard's Flatten
     * button on `fast` (the EMERGENCY style) was the last path still sending a
     * MARKET order to a rail that refuses it, while reporting its legs routed.
     *
     * `marketableFallback` is the single rule, shared with both branches of
     * `priceFillsForRoute`: MARKET becomes a crossing limit when there is a
     * config and a usable mark, and is otherwise left exactly as planned.
     */
    const plannedFills = plannedFlattenFills(plan.legs, params.decisionId, now).map((f) =>
      marketableFallback(f, this.#d.marketable),
    )
    const skips = unresolvedFlattenSkips(unresolved)

    /**
     * Claim the id BEFORE routing, with `fills: []`.
     *
     * Record-first is the same trade `applyDecision` documents: a crash between
     * the claim and the route loses orders LOUDLY (the record sits in `ROUTING`
     * saying so) rather than duplicating them silently.
     *
     * The claim carries NO fills, and that is deliberate and different from
     * `applyDecision`. `desk-decisions` is doing double duty here — it is both
     * the idempotency lock and the P&L journal that this very method reads to
     * reconstruct a position. Journalling a close that never routed would net
     * the position to flat in the eyes of the NEXT flatten, hiding the leg that
     * is still open. So the intent is parked in `plannedFills` (which nothing
     * reads) and only the legs that actually reached a rail are promoted into
     * `fills` below.
     *
     * NO FREEZE SPLIT HERE, unlike `submit.ts`. One order per contract goes to
     * the rail, and `apps/order-gateway` splits it under NSE's volume freeze
     * when it claims the order — the same as every order `applyDecision` routes.
     * Splitting again here would produce two sets of tranche ids for one exit.
     */
    try {
      await decisions.insertOne({
        decisionId: params.decisionId,
        symbol: flattenDecisionSymbol(plan.legs),
        expiry: '',
        mode: params.mode,
        tag: params.tag,
        fills: [],
        skips,
        createdAt: now,
        status: 'ROUTING',
        source: 'flatten',
        plannedFills,
      })
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
      // Another process won the race. Treat it exactly like a replay rather than
      // routing a second set of exits.
      const winner = await decisions.findOne({ decisionId: params.decisionId })
      if (winner !== null) return replayFlatten(winner, params, window)
      throw err
    }

    const rail = railFor(params.mode, this.#d.rails)
    const routeErrors: { fill: Fill; error: string }[] = []
    const routedFills: Fill[] = []
    const legs: FlattenLegResult[] = []
    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i] as (typeof plan.legs)[number]
      const fill = plannedFills[i] as Fill
      const instrument = instruments.get(leg.tradingsymbol)
      let error = ''
      if (instrument === undefined) {
        // Unreachable — `resolvable` was filtered on exactly this — but a leg
        // that vanished here must still be NAMED rather than dropped.
        error = `cannot resolve ${leg.tradingsymbol} to route`
      } else {
        try {
          await rail.route(fill, {
            tag: params.tag,
            underlying: deriveUnderlying(leg.tradingsymbol),
            instrument,
            nowMs: now,
            clientOrderId: fill.deskTag,
          })
          routedFills.push(fill)
        } catch (err) {
          error = errorMessage(err)
        }
      }
      if (error !== '') routeErrors.push({ fill, error })
      // The FILL, not the plan: what is reported must be the order that went out.
      legs.push(flattenLegResult(leg, fill, error))
    }

    /**
     * MAINTAIN THE BOOK, if this tag has one.
     *
     * This method's own header says "NO BOOK IS WRITTEN. A hosted strategy
     * never had one" — true for a hosted strategy, and false for an EXTERNAL
     * book built through the Build screen, which does have one and is flattened
     * through this same button. BAJFINANCE on 2026-07-31 flattened cleanly
     * (all four legs netted to zero in the trade log) while `desk-books` still
     * recorded all four opens: the Positions page drew a position that no
     * longer existed, delta and P&L were computed off it, and the book could
     * not be deleted because the delete guard reads the same record.
     *
     * `submit` grew the same maintenance in 8e32f006, but this path does NOT go
     * through `submit` — it routes on `rail.route` directly, a few lines above
     * — so the fix there could never reach it. Verified on prod: the flatten
     * ran 23 seconds AFTER the process carrying that fix started, and the book
     * was still stale.
     *
     * Only what actually ROUTED is folded in, and only legs the book already
     * holds are touched — the same rule as `submit`'s, for the same reasons.
     * Fail-soft: the orders are already placed by this line.
     */
    if (routedFills.length > 0) {
      try {
        const doc = await this.#d.store.bookDoc(params.tag, params.mode)
        if (doc !== null) {
          const folded = foldRoutedFillsIntoBook(doc.legs as readonly BridgeLeg[], routedFills, now)
          if (folded.touched) {
            const key = {
              tag: params.tag,
              mode: params.mode,
              symbol: doc.symbol,
              expiry: doc.expiry,
            }
            // Compare-and-set, same as `applyDecision`'s: the window between
            // the read above and this write is the whole flatten, which is the
            // longest one in the file. On a conflict the exits are re-folded
            // onto whatever landed meanwhile — an exit that vanishes because
            // another writer won is the failure this repo never accepts.
            const saved = await this.#d.store.saveBook(key, folded.legs, now, doc.updatedAt)
            if (saved === 'conflict') {
              await refoldOnConflict({
                store: this.#d.store,
                key,
                routedFills,
                nextBook: folded.legs,
                priorBook: doc.legs as readonly BridgeLeg[],
                // REDUCES AND ADDS ONLY — a flatten never creates a leg.
                mayCreate: false,
                nowMs: now,
                log: (m) => console.error(m),
              })
            }
          }
        }
      } catch (err) {
        // NOT silent. `BridgeDeps` carries no logger, and swallowing this the
        // way line 368 swallows a duplicate id would leave a stale book with no
        // signal anywhere — which is the exact class of failure this block was
        // added to end. The orders have already routed, so it cannot throw.
        console.error(
          `[bridge] book maintenance FAILED after flattening ${params.tag} — ` +
            `the book may still describe a position that is now closed: ${errorMessage(err)}`,
        )
      }
    }

    // Everything that could not be closed, whatever the reason.
    legs.push(...unresolvedFlattenLegs(unresolved, open))

    // `flat` and `malformedFills` MUST AGREE — see `flattenIsFlat`.
    const flat = flattenIsFlat({
      legs,
      truncated,
      malformedFills: load.malformed,
      fillsTruncated: load.truncated,
      fillCount: fills.length,
    })
    // The window read NOTHING, so it described nothing. Reported separately
    // from `flat` because the two say different things to the caller: `flat`
    // false means "do not go home", `emptyWindow` says the fix is a wider
    // `sinceMs` rather than a retry of the same request.
    const emptyWindow = legs.length === 0 && fills.length === 0

    const status: DecisionStatus =
      routeErrors.length === 0 && unresolved.length === 0 ? 'DONE' : 'FAILED'
    await decisions.updateOne(
      { decisionId: params.decisionId },
      {
        $set: {
          status,
          // Promoted only now: these are the exits that actually went out, which
          // is what P&L must see and what the next flatten must net against.
          fills: routedFills,
          routeErrors,
          flatten: {
            legs,
            unpriceable: plan.unpriceable,
            unresolved,
            truncated,
            malformedFills: load.malformed,
            fillsTruncated: load.truncated,
            flat,
            emptyWindow,
            window,
          },
          completedAt: this.#d.clock.now(),
        },
      },
    )
    // A flatten's exits are fills like any other, and the book has to see them
    // or it keeps a position that was just closed in its held set — re-marking
    // and pushing a leg nobody holds until the next reconcile.
    this.#tellBook({ tag: params.tag, mode: params.mode, createdAt: now, fills: routedFills })

    return {
      decisionId: params.decisionId,
      replayed: false,
      status,
      tag: params.tag,
      mode: params.mode,
      legs,
      fills: routedFills,
      routeErrors,
      unpriceable: plan.unpriceable,
      unresolved,
      truncated,
      malformedFills: load.malformed,
      fillsTruncated: load.truncated,
      /**
       * The one field an operator acts on. False whenever ANY leg failed to
       * route, could not be resolved, was held back as truncated, or was
       * rebuilt from fills we could not fully read — a flatten that partially
       * succeeded and says nothing is the exact failure this endpoint exists to
       * remove.
       */
      flat,
      ...(emptyWindow ? { emptyWindow: true } : {}),
      window,
    }
  }

  /**
   * Is this tag a POSITIONAL BOOK — does `desk-books` hold a document for it?
   * Only consulted when the caller left `sinceMs` unset (see `flattenWindow`).
   *
   * An unreadable answer counts as YES: the wide window is the safe direction
   * (`FlattenParams.sinceMs` — a round trip that closed nets to zero), and
   * guessing "hosted" is exactly the narrow read that sold TCS 2400PE.
   */
  async #positional(params: FlattenParams): Promise<boolean> {
    if (params.sinceMs !== undefined) return false
    try {
      return (await this.#d.store.bookDoc(params.tag, params.mode)) !== null
    } catch (err) {
      console.error(
        `[bridge] could not read ${params.tag}'s book before flattening — reading every fill: ` +
          errorMessage(err),
      )
      return true
    }
  }
}

/**
 * Rebuild a flatten result from the decision that already ran, routing nothing.
 *
 * A replay must answer with what the ORIGINAL flatten did — including the legs
 * it failed on. Re-deriving them from the current position would answer a
 * different question ("what is open now?") and would report a leg as closed
 * simply because a later flatten closed it.
 *
 * The `flatten` block is written by `flattenTag`. Its absence means this
 * decisionId was consumed by `applyDecision` instead — a caller collision, which
 * is a client bug we cannot invent per-leg detail for. It is reported as
 * `flat: false` with no legs rather than as a successful flatten: claiming a
 * position is closed on the strength of a record that never mentions one is the
 * single worst answer this method can give.
 */
function replayFlatten(
  doc: Record<string, unknown>,
  params: { tag: string; mode: DeskMode; decisionId: string },
  window: { readonly from: number; readonly to: number },
): FlattenResponse {
  const flatten = (
    typeof doc['flatten'] === 'object' && doc['flatten'] !== null ? doc['flatten'] : {}
  ) as Partial<{
    legs: FlattenLegResult[]
    unpriceable: string[]
    unresolved: string[]
    truncated: string[]
    malformedFills: string[]
    fillsTruncated: boolean
    flat: boolean
    emptyWindow: boolean
    window: { from: number; to: number }
  }>
  const array = <T,>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    decisionId: params.decisionId,
    replayed: true,
    status: (doc['status'] as DecisionStatus | undefined) ?? 'DONE',
    tag: params.tag,
    mode: params.mode,
    legs: array<FlattenLegResult>(flatten.legs),
    fills: array<Fill>(doc['fills']),
    routeErrors: array<{ fill: Fill; error: string }>(doc['routeErrors']),
    unpriceable: array<string>(flatten.unpriceable),
    unresolved: array<string>(flatten.unresolved),
    truncated: array<string>(flatten.truncated),
    malformedFills: array<string>(flatten.malformedFills),
    fillsTruncated: flatten.fillsTruncated === true,
    flat: flatten.flat === true,
    // The original run's reading of its own window, not a fresh one: a replay
    // answers what the flatten DID, and "widen the window" is the same advice
    // now as it was then.
    ...(flatten.emptyWindow === true ? { emptyWindow: true } : {}),
    window: flatten.window ?? window,
  }
}
