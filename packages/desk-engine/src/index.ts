/**
 * `@algomaker/desk-engine` — the recenter supervisor's decision engine.
 *
 * This package is the SPINE of the migration that retires the Python desk
 * supervisor (design spec `docs/superpowers/specs/2026-08-21-recenter-
 * supervisor-migration-design.md`). Every other process in the migration —
 * `apps/supervisor`, desk-api's decision endpoint, the order gateway's
 * chaser, the dashboard's dials panel — imports its vocabulary from HERE, so
 * that a rename or a changed default is one edit and a type error, never four
 * processes quietly disagreeing about what a book is.
 *
 *   `types.ts`    What the engine decides ON: two-sided quotes, chain and leg
 *                 views, and the fully-spelled `RuleState` that replaced
 *                 Python's absent-vs-zero dict (§5, §6).
 *   `contract.ts` What crosses the wire to desk-api: an idempotent
 *                 `DecisionRequest` in instruments and share quantities, and
 *                 the response that distinguishes a gated skip from a broker
 *                 rejection (§9).
 *   `session.ts`  WHEN it may decide at all: the NSE trading calendar ported
 *                 from the Python desk, and the 5-minute mark grid every
 *                 mark-counted dial is calibrated against (§5, §7).
 *   `dials.ts`    HOW it decides: one schema, every field required, every
 *                 off-state a value the type system can see, and a resolver
 *                 that names what it refuses instead of swallowing it (§5).
 *   `presets.ts`  The twelve historical Python variants as prefills — plus
 *                 the relief-r live/board split, because the live book and
 *                 the committed board are not the same book (§5) — and the
 *                 delta-lean and playbook books' prefills.
 *   `forward.ts`  The weekly's OWN forward, read off its chain by put-call
 *                 parity, and the index-carry fallback (six-playbooks F1).
 *   `marking.ts`  What every number it decides on is WORTH: marks off the exit
 *                 side of the book (never a last print), and greeks that are
 *                 real or absent — never the `dps = 0.30` stand-in (§6).
 *   `ladder.ts`   WHERE on the chain it may act: the snap-to-a-real-strike
 *                 walk, the bounded OTM push, and the one lot every band and
 *                 package is counted in.
 *   `corridor.ts` The TRIGGER arithmetic: the gamma-scaled delta band, its
 *                 near-expiry shrink, the convexity floor that held VEDL
 *                 Dec-25 silent for 879 marks, and an honest `hasGreeks` in
 *                 place of the `netΓ == 0.0` sentinel (§5).
 *   `shed.ts`     Phase R: honest candidates (no `dps = 0.30`), best-fit
 *                 sizing on a plain round, and the liquidity gate that routes
 *                 an uncrossable book to a maker quote instead of a silent
 *                 hold (§6, §8).
 *   `shift.ts`    PHASE S: the margin-gated ITM shift — a short price has run
 *                 past, moved back to a strike keyed to SPOT, armed only on a
 *                 broker margin figure we are entitled to believe (§6).
 *   `tiers.ts`    The six behaviours phase R composes AROUND that sale, each a
 *                 dial with a typed off-state: the once-a-session EOD sweep,
 *                 the lagged gk-anchor and its confirmation, the trend-skewed
 *                 shed target, the LIFO unwind bounded by delta AND gamma, the
 *                 recycle credit bank, and the balance tier that rebuilds a
 *                 book which has lost a side (§5).
 *   `guards.ts`   What OUTRANKS the playbook: the mark-anchored target lock and
 *                 the margin trim — plus `unprotectedLots`, the one definition
 *                 of "lots the rules may spend" every selection site nets
 *                 through (§4, §5).
 *   `scrap.ts`    The spent short bought back, the strike banned for its
 *                 expiry, and the entry gate that refuses to sell it again.
 *   `margin-project.ts`
 *                 SPAN-lite, ported for PROJECTION ONLY and labelled: it may
 *                 refuse or shrink a trade, never authorise one (§6).
 *   `engine.ts`   `decide()` — the single public entry, and spec §5's
 *                 evaluation order in the order the order is load-bearing.
 *
 * PURE, and staying that way: no clock, no feed, no Mongo, no `process.env`.
 * The session clock is an argument, the market is a snapshot, and that is what
 * makes a Python-generated fixture replayable against it.
 */
export * from './types.ts';
export * from './contract.ts';
export * from './session.ts';
export * from './dials.ts';
export * from './presets.ts';
export * from './marking.ts';
export * from './ladder.ts';
export * from './corridor.ts';
export * from './tiers.ts';
export * from './shed.ts';
export * from './guards.ts';
export * from './margin-project.ts';
export * from './scrap.ts';
export * from './shift.ts';
export * from './engine.ts';
export * from './forward.ts';

/**
 * THE SECOND DECIDE PATH.
 *
 * `delta-lean/` is a whole engine beside the recenter one, not a tier of it: it
 * opens ONE hedged package a day on a weekly index option, holds it, and when
 * the tape disagrees it neutralises BY ADDING rather than by closing. Nothing
 * takes a leg off before the close except four exits — the flatten windows, the
 * day backstop, the day target and the stuck rule. A book reaches it through
 * one dial, `delta_lean_enabled`, which defaults off, so every existing book
 * decides exactly as it did before this directory existed.
 */
export * from './delta-lean/regime.ts';
export * from './delta-lean/lean.ts';
export * from './delta-lean/express.ts';
export * from './delta-lean/decide.ts';

/**
 * THE PLAYBOOK FRAME (six-playbooks spec §4), inside the second path.
 *
 * A playbook book is a delta-lean book whose `pb_playbook` names one of six
 * strategies; the host hands it to `decidePlaybook` instead of
 * `decideDeltaLean`. `pb_playbook` defaults to 0, so no existing book reaches
 * it. Exported: the strategy contract, the `RuleState.pb` hydrator the state
 * store reads rows back through, the trading-day count `pb_min_dte` is judged
 * in, and the frame's entry point.
 */
export * from './delta-lean/playbook/types.ts';
export * from './delta-lean/playbook/state.ts';
export * from './delta-lean/playbook/calendar.ts';
export * from './delta-lean/playbook/decide.ts';
// The frame's steadied index (median of the newest three prints), for the
// supervisor's index level: one bad print must not move a parity band either.
export { steadySpot } from './delta-lean/playbook/kit.ts';

/**
 * THE BULL-S PATH (Delta spec §6), the fourth.
 *
 * A straddle sold each time the reference crosses a grid level, pyramided,
 * each bought back on its own combined stop; book target, loss cap and two
 * operator commands as counters. A book reaches it through `bs_enabled`,
 * which defaults off. Exported: the decide entry and its inputs, the
 * `RuleState.bs` row and its hydrator, and the grid arithmetic.
 */
export { decideBullS, type BullSInputs } from './bull-s/decide.ts';
export { BS_EMPTY, hydrateBullState, type BullSGroup, type BullSHaltReason, type BullSState } from './bull-s/state.ts';
export { bsCrossedLevel, bsNearestLevel } from './bull-s/grid.ts';
export {
  bsFirstSize,
  bsNextSize,
  bullSPyramid,
  bullSWorstAtCap,
  leverageAt,
  quoteMark,
  shortOptionMargin,
  type StrikeLeverage,
} from './bull-s/margin.ts';
