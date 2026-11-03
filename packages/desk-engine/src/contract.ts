/**
 * THE WIRE BETWEEN THE SUPERVISOR AND desk-api (design spec §9).
 *
 * The supervisor decides; desk-api owns the ledger and the broker. Nothing
 * else may cross that line, and this file is the whole of what does — which is
 * what stops the two processes drifting into two different books.
 *
 * WHAT EACH FIELD PREVENTS:
 *
 *   `decisionId` (`${tag}:${mode}:${seq}`) is an IDEMPOTENCY KEY, not a log
 *   line. A supervisor restart, a retried POST or a socket that dies after the
 *   order went out all replay the same id, and desk-api answers the second
 *   attempt with `replayed: true` and the ORIGINAL fills rather than routing
 *   the package twice. Doubling a live short package is the failure this
 *   exists for.
 *
 *   `mode` is in the id as well as the body because paper and live are two
 *   ledgers on one tag; an id that collided across them would let a paper
 *   replay suppress a real live order.
 *
 *   The wire speaks INSTRUMENTS and QTY (shares), while the engine speaks
 *   strikes and LOTS (`EngineAction`, in `types.ts`). The translation happens
 *   once, at the boundary, because the qty-vs-lots confusion between endpoints
 *   is a standing hazard on this desk — see the live-order-path notes. Nothing
 *   downstream of here multiplies by a lot size again.
 *
 *   `leanId` on an open is the DELTA-LEAN book's stamp, carried so the leg the
 *   fill creates can be attributed to the bet that opened it. OPTIONAL, because
 *   the recenter engine has no leans and an absent key is the honest record of
 *   that: desk-api writes the field onto the stored leg only when the action
 *   carried one, so an unstamped leg has no key rather than a stored null.
 *
 *   `limitPrice`/`workMode` are OPTIONAL and typed `| undefined` on purpose:
 *   `exactOptionalPropertyTypes` is on repo-wide, so a caller with no price to
 *   pass must be able to omit the key entirely. Absent = let the gateway pick
 *   the touch (§8); `workMode` absent = passive-first.
 *
 *   `skips` and `routeErrors` are separate arrays because they are different
 *   news: a skip is the desk-api gate deciding an action must not go (a
 *   protected leg, a scrap-banned re-sell), a route error is the broker
 *   refusing one that should have. Collapsing them into one list is how a
 *   rejected order comes to read as a deliberate hold.
 *
 * `WORKING` is a terminal-looking status that is not terminal: a maker quote
 * is resting and fills will arrive later (§8). A supervisor that treats it as
 * DONE will form a second package against a book it already has working.
 */

import type { Mode, Side, Trigger } from './types.ts';

export type WorkMode = 'passive' | 'urgent';

export type WireAction =
  | { readonly op: 'open'; readonly instrument: string; readonly side: Side; readonly qty: number; readonly limitPrice?: number | undefined; readonly workMode?: WorkMode | undefined; readonly leanId?: string | undefined; readonly add?: boolean | undefined }
  | { readonly op: 'close'; readonly instrument: string; readonly limitPrice?: number | undefined; readonly workMode?: WorkMode | undefined }
  | { readonly op: 'resize'; readonly instrument: string; readonly targetQty: number; readonly limitPrice?: number | undefined; readonly workMode?: WorkMode | undefined };

/**
 * HOW THE ORDERS OF THIS PACKAGE ARE WORKED — the book's execution dials
 * (§8), carried on the request that uses them.
 *
 * These are the supervisor's `work_tranche_lots`, `chase_max_ms` and
 * `chase_cross_buffer_pct` (`dials.ts`), stated per package rather than looked
 * up again by desk-api. ONE AUTHORITY: the supervisor resolved these dials to
 * decide the order in the first place — the size it chose to show, the time it
 * is willing to work, the reach it will pay at the end — and a second process
 * re-resolving them from the same registry is how two components come to
 * disagree about a book whose dial was changed mid-session.
 *
 * EVERY FIELD OPTIONAL, and absent means "the gateway's own default", never
 * zero. `trancheLots` absent = do not gate (place the freeze split as one
 * batch, which is what every order on this desk did before §8); the two chase
 * dials absent = `order-chaser.ts`'s defaults. A zero here would mean "slice
 * into nothing" and "cross immediately", which is why they are validated as
 * positive at the door rather than coerced.
 */
export interface WorkDials {
  /** The slice size, in LOTS. One tranche is live at the broker at a time. */
  readonly trancheLots?: number | undefined;
  /** How long a passive order works before it crosses, once. */
  readonly chaseMaxMs?: number | undefined;
  /** How far through the far touch that one cross reaches. A fraction, e.g. 0.005. */
  readonly chaseCrossBufferPct?: number | undefined;
}

export interface DecisionRequest {
  readonly tag: string;
  readonly mode: Mode;
  readonly decisionId: string;      // `${tag}:${mode}:${seq}`
  readonly symbol: string;
  readonly expiry: string;
  readonly trigger: Trigger;
  readonly reason: string;
  readonly actions: ReadonlyArray<WireAction>;
  /** The book's execution dials. Absent = the gateway's defaults. */
  readonly work?: WorkDials | undefined;
}

export interface WireFill {
  readonly instrument: string;
  readonly side: Side;
  readonly qty: number;
  readonly price: number;
  readonly resting?: boolean | undefined;
  /**
   * What the venue charged for this fill, in the book currency (Delta: USD,
   * GST included). Absent = none (NSE). The host banks realised NET of it.
   */
  readonly fee?: number | undefined;
}

export interface DecisionResponse {
  readonly decisionId: string;
  readonly replayed: boolean;
  readonly status: 'DONE' | 'FAILED' | 'ROUTING' | 'WORKING';
  readonly fills: ReadonlyArray<WireFill>;
  readonly skips: ReadonlyArray<{ readonly instrument: string; readonly reason: string }>;
  readonly routeErrors: ReadonlyArray<string>;
}

export const ENGINE_DECISIONS_PATH = '/v1/desk/engine/decisions';
/**
 * The OPERATOR's write into supervisor state: lots the engine may not spend
 * (§4, `protectedQty`). Named here beside the decision path because both are
 * the same seam — desk-api in front of the supervisor's own memory — even
 * though the supervisor itself reads that map from Mongo rather than over
 * HTTP, and so has no client for this one.
 */
export const ENGINE_PROTECT_PATH = '/v1/desk/engine/protect';
export const SUPERVISOR_NUDGE_PORT_DEFAULT = 8893;

/**
 * "AN ORDER IS WAITING" — the bus topic desk-api publishes after it has
 * durably written a document into the gateway's queue, and the one the gateway
 * sweeps on.
 *
 * DECLARED HERE, in the wire contract, for the reason this whole module exists:
 * it is a string two SEPARATE PROCESSES have to agree on, and until now only
 * one of them had it. `apps/order-gateway/src/queue.ts` owned the constant and
 * subscribed to it; desk-api, which cannot import an app package, published
 * nothing at all — so every order waited out the gateway's idle sweep instead.
 * A topic that lives in exactly one place cannot be half-wired like that again.
 *
 * LOSING A NUDGE COSTS LATENCY, NEVER AN ORDER. The queue collection is the
 * durable record; this only says "do not wait for the interval". Which is also
 * why it must never be published BEFORE the insert resolves: a nudge that
 * overtakes its own document makes the gateway claim nothing, reset its idle
 * timer, and sleep the full interval — strictly worse than not nudging.
 */
export const ORDER_NUDGE_TOPIC = 'order.submitted';

/** What the nudge carries: enough to trace which order woke the sweeper. */
export interface NudgePayload {
  readonly clientOrderId: string;
  readonly tag: string;
  readonly tradingsymbol: string;
}
