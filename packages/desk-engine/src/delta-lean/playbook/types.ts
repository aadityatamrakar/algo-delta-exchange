/**
 * THE PLAYBOOK CONTRACT — what the frame hands a strategy, and what a strategy
 * may hand back (six-playbooks spec §4).
 *
 * A playbook book is a delta-lean book with `pb_playbook` 1-6. The frame
 * (`decide.ts` beside this file) owns everything the six share: the day roll,
 * the clock, the day's backstop and target, the session fold, the exit latch,
 * the two-stage open, the common exits and every new-risk gate. A strategy is
 * one small module that answers three questions and nothing else — should a
 * trade open, should this one close, should it add — so a rule that keeps a
 * book safe is written once, in the frame, rather than six times.
 *
 * The answers are DATA, never actions: a strategy returns a plan or a verdict
 * and the frame turns it into orders, sizes it against the margin cap, stages
 * it buys-first (D2) and paces it. A strategy therefore cannot route a naked
 * short, an unsized package or a close the frame did not order — the frame is
 * the only author of an `EngineDecision` on this path.
 */
import type { Dials } from '../../dials.ts';
import type { DeltaLeanInputs } from '../decide.ts';
import type { Regime, RegimeRead } from '../regime.ts';
import type { EngineAction, OptType, PlaybookState, RuleState, Urgency } from '../../types.ts';

/** The `'open'` arm of `EngineAction` — what a strategy proposes to BUY. */
export type OpenAction = Extract<EngineAction, { op: 'open' }>;

/**
 * A short a plan will sell at stage 2 — not an order, a promise the frame
 * keeps later: it builds the sale itself once `cover` is held.
 *
 * `cover` is the strike of the same-type protective long that covers this
 * short. Naming it is what lets the frame refuse the sale while that ONE leg
 * is missing, rather than while "some protective leg" is missing — a package
 * that filled its call wing and not its put wing must not sell the put (D1).
 * Stored on the trade as `PlaybookState.planShorts`.
 */
export type PlannedShort = {
  readonly strike: number;
  readonly optType: OptType;
  readonly cover: number;
};

/**
 * Everything a strategy may read on one pass, computed ONCE by the frame so
 * the six cannot each derive "the index", "the straddle" or "this trade's
 * P&L" a slightly different way.
 */
export interface PlaybookCtx {
  readonly inputs: DeltaLeanInputs;
  readonly dials: Dials;
  readonly st: RuleState;          // rolled, folded, regime-stamped
  readonly pb: PlaybookState;      // === st.pb, after this pass's peak/trail bookkeeping
  readonly read: RegimeRead;
  readonly regime: Regime;         // read.slow
  readonly regimeHeldMs: number;   // nowMs - st.dlRegimeSinceMs; 0 when unstamped
  readonly spot: number | null;    // ring.latest()?.spot
  readonly spotFresh: boolean;     // spot !== null && nowMs - spotAsOf <= dl_spot_stale_s*1000
  readonly fwd: number;            // inputs.chain.spot
  readonly forwardOk: boolean;     // inputs.forwardSource is 'parity' or 'index-carry'; absent = false
  readonly str: number | null;     // atmStraddleMid(chain)
  readonly imp: (minutes: number) => number | null;  // impliedWindowMove(str, MTE, minutes*60)
  readonly dayComplete: boolean;
  readonly dayRobust: boolean;     // dayComplete && pb.maxGapMs <= pb_max_gap_min * 60_000
  readonly dayImplied: number | null;   // pb.dayImplied > 0 ? pb.dayImplied : null
  readonly gapPct: number | null;  // 100 * (dayOpen - prevClose) / prevClose when both are known and the fold saw the open (dayComplete); else null
  readonly totalPnl: number;
  readonly tradePnl: number;       // pb.tradeOpenMs > 0 ? totalPnl - pb.basePnl : 0
  readonly cost: number;           // Σ (Buy ? +1 : -1) * entry * lots * lotSize over held legs
  readonly working: boolean;       // inputs.pendingLots > 0 || inputs.inFlight === true
  readonly expiryDay: boolean;     // chain.expiry === dateIst
  readonly tradingDte: number;     // tradingDaysToExpiry(dateIst, chain.expiry) — pb_min_dte's rule
  readonly nowMs: number;
  readonly minuteOfDay: number;
}

/**
 * A strategy's proposed trade, at ONE LOT A LEG — the frame sizes it.
 *
 * `protective` and `shorts` are kept apart because they are sent apart (D2):
 * every protective buy is routed first, and the shorts only once the frame
 * sees each one's `cover` held. The shorts are therefore not orders at all —
 * `PlannedShort`s the frame turns into sales at stage 2. An empty `shorts` is
 * a single-stage plan: a long option, or a pyramid add, which is always a buy.
 */
export interface OpenPlan {
  readonly side: 'up' | 'down' | 'none';
  readonly protective: readonly OpenAction[];  // Buys, lots: 1 each (the frame scales)
  readonly shorts: readonly PlannedShort[];    // stage-2 sales; [] = single stage
  readonly lots: number;                       // wanted lots per leg; the frame truncates to the cap
  readonly reason: string;
  readonly stamps?: Partial<Pick<PlaybookState, 'entryStr' | 'entryExtreme' | 'boxHi' | 'boxLo'>>;
}

/** The entry rule's answer: wait, saying why, or open this plan. */
export type EntryVerdict =
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'open'; readonly plan: OpenPlan };

/**
 * A managing pass's answer: an exit, a pyramid add, bookkeeping to persist,
 * or a note saying why it held. Every field optional, because "nothing fired"
 * is the common answer and `{}` says it.
 */
export interface PlaybookStep {
  readonly exit?: { readonly reason: string; readonly urgency: Urgency; readonly final: boolean };
  readonly add?: OpenPlan;
  readonly patch?: Partial<PlaybookState>;   // bookkeeping to persist (e.g. condSinceMs)
  readonly note?: string;                    // the hold reason when nothing fires
}

/** One strategy. `id` is the `pb_playbook` value that selects it. */
export interface Playbook {
  readonly id: number;      // pb_playbook
  readonly name: string;    // 'trend-drive' | 'wing-straddle' | 'reversal' | 'expiry-drive' | 'expiry-theta' | 'expiry-gamma'
  enter(ctx: PlaybookCtx): EntryVerdict;
  /** The playbook's OWN exits (stops and profit exits); the frame has run the hard stop. */
  exits(ctx: PlaybookCtx): PlaybookStep;
  /** Pyramid adds; return {} for none. Called only after no exit fired. */
  adds(ctx: PlaybookCtx): PlaybookStep;
}
