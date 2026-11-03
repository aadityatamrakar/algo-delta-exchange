# The desk-book entry engine — design

**Date:** 2026-07-30 (substantially revised the same evening — see below)
**Phase:** 2, following `2026-07-30-recenter-r-live-bajfinance-design.md`
**Repo:** `algomaker` (with one gating change in `algo-engine/sensibull-desk`)

## REVISION — most of the original design is deleted

The first draft was built on a wrong assumption: that entry meant working
**passive** limit orders, resting inside the spread and repriced toward it over
time. Everything expensive in that draft followed from it — a 15-second chase
loop, `entry_step_sec`/`entry_max_steps`, and the decision to put the engine in
algomaker at all, which existed only because the 5-minute mark grid was too slow
to drive such a loop.

The operator's actual intent is a **marketable limit**: priced *through* the
touch so it fills at once, with the limit as a worst-case bound rather than a
resting price. That deletes the chase loop, the two dials, and the latency
argument along with them.

It also means the mechanism already exists and is shipped: `904a900e` prices
unpriced actions as marketable limits at the point the fill is built
(`marketable.ts`), because the broker API rejects MARKET orders outright. Entry
needs the same function, not a new subsystem.

**What survives** from the original: the `entry` sub-document, the flow, the
`converge()` gate, the partial-fill policy, and the open items. **What is
struck:** the chase loop, `entry_step_sec`, `entry_max_steps`, the tick-driven
worker, and the "entry must live in algomaker because it needs a fast clock"
reasoning. Sections below are marked where they changed.

Because the latency argument is gone, **where the engine lives is now an open
question again** rather than a settled one. A one-shot "price marketable, send,
reconcile" step is well within what the Python driver could do at a mark, which
would keep the book's whole lifecycle in one repo. That is a decision to take
before implementing, not one this spec should be read as having made.

## Goal

Let a book be **built from flat** rather than declared as already held: the desk
places the initial structure itself with limit orders, works them, confirms the
full book exists, and only then hands it to delta management.

Phase 1 seeds a book as an existing position and manages it. That is the whole
gap this phase closes.

## What already exists

LIMIT is a first-class citizen the length of the rail, so none of it needs
building:

- `submit.ts:1199-1206` validates `orderType` / `limitPrice`.
- `applyDecision` already accepts a **per-leg pricing map** —
  `service.ts:283`, `ReadonlyMap<string, {orderType: 'MARKET'|'LIMIT'; limitPrice?: number}>`.
- `rail.ts:93` defaults an unpriced fill to MARKET.
- `packages/order-bus/src/risk.ts:43` refuses a LIMIT with no price;
  `packages/brokers/src/xts.ts:220` places it; the simulator fills it when the
  market trades through (`order-gateway/src/main.ts:421`).

## What does not exist

1. ~~**Anything that *works* an order.**~~ **STRUCK.** This mattered only for a
   passive-limit chase. A marketable limit is sent once and either fills or
   does not; there is nothing to work. `gateway.ts:401`'s `working` set tracks
   freeze-limit tranches, which is all the order-lifetime tracking entry needs.
2. **A target structure.** A book records what it holds. There is no
   representation of a structure that is *intended* and not yet built.
3. **A gate on management.** `converge()` starts a worker for any row that is
   `desired: 'running'`. Nothing knows a book might be half-built.

So the remaining work is (2) and (3) — a record and a gate. Not an engine.

## Decisions

| | |
|---|---|
| Entry engine location | **REOPENED** — the latency argument that forced algomaker is gone |
| Leg sequencing | all four simultaneously |
| Incomplete book | alert and freeze — no management |
| Order pricing | marketable limit, `marketable.ts`, same as every other desk order |
| Price ceiling | the seed file's per-leg `rate` |

### ~~Why the entry engine cannot live where management lives~~ — STRUCK

The original argument was that working a limit order needs second-scale
reaction, which the 5-minute mark grid cannot provide, so entry had to live in
algomaker off `md.tick`. **With a marketable limit there is no loop to drive**,
so the argument no longer holds and the cost it justified — splitting a book's
lifecycle across two repos, against the "Python owns logic" split — is no longer
worth paying by default.

Both placements are now viable and should be chosen on their merits:

- **In Python**, as a one-shot at the driver's first mark: keeps the whole
  lifecycle in one repo and one mental model.
- **In algomaker**, next to the journal it reconciles against: fills are
  visible without a bridge round-trip.

## Pricing

Entry uses **the same marketable-limit function as every other desk order**
(`apps/api/src/marketable.ts`, shipped in `904a900e`): priced through the mark
by `max(bufferPct x mark, minTicks x tick)`, sell below and buy above, rounded
directionally. Nothing entry-specific to build, and — importantly — entry and
management then behave identically, so a fill in the journal cannot be
mispriced by one and not the other.

**The seed file's `rate` per leg remains the ceiling.** It is the operator's
statement of what the structure is worth — 28/26/7/7 on the BAJFINANCE book — so
a marketable price worse than the rate is refused rather than sent. That is the
whole of the price policy: cross to fill, but never past what the operator said
it was worth.

`entry_step_sec` and `entry_max_steps` are **struck**; there is no chase to
pace.

## The entry record

The registry row gains an `entry` sub-document. The row's own
`desired`/`actual` semantics are **unchanged** — `desired` stays the operator's
intent and `actual` stays the supervisor's report, and neither is written by
the entry engine.

```
entry: {
  state: 'pending' | 'working' | 'complete' | 'failed',
  targetLegs: [ { strike, type, qty, ceiling } ],
  filled:     [ { strike, type, qty, avgPrice } ],
  reason: <string | null>     // set when state is 'failed'
}
```

`steps` is struck along with the chase. `bound` is renamed `ceiling`: it is a
refuse-above/below price, not a target the engine walks toward.

A book seeded the phase-1 way is created `entry.state: 'complete'` so nothing
about the existing BHEL or BAJFINANCE books changes.

## Flow

1. Operator creates the book with `targetLegs` — necessarily `desired: 'stopped'`,
   which the registry forces at creation — then starts it with
   `POST .../:tag/start`, moving it to `desired: 'running'`.
2. The entry engine sees `desired: 'running'` and `entry.state !== 'complete'`,
   moves to `working`, and submits **all four legs at once** as MARKETABLE
   LIMITs — priced by `marketable.ts`, refused rather than sent if the price
   would be worse than the leg's `ceiling`.
3. All legs filled → `entry.state: 'complete'`.
4. Anything unfilled once the orders are terminal → `entry.state: 'failed'` with
   a reason, and **alert**. There is no retry loop: a marketable limit that did
   not fill is telling you the book cannot be built at the operator's prices,
   and that is a decision for a human, not a retry.
5. `converge()` builds a worker only for a row that is `desired: 'running'`
   **and** `entry.state === 'complete'`. Any other entry state is a refusal,
   recorded in `Supervisor.refusals` and reported as `actual: 'stopped'`.

Step 5 is the one change in `sensibull_tools`: a condition in
`live/desk/supervisor.py`'s `converge`, alongside the existing
legacy-double-management guard. It is needed wherever the engine itself ends up
living.

## Failure handling

- **Partial fill → freeze.** Whatever filled is kept, nothing further is placed,
  management does not start, and the operator is alerted. Recenter on a
  half-built book would be managing the delta of a structure nobody chose.
- **Idempotency.** Every entry order carries the existing `clientOrderId` key,
  so a restart mid-entry cannot double-place. On restart the engine reads the
  journal and rebuilds `filled` from it.
- ~~**Cancel-replace races.**~~ **STRUCK** — nothing is cancelled or replaced.
  This whole class of race disappears with the chase, which is the single
  biggest correctness win of the revision: cancel-replace against a live
  exchange is where double-fills come from.
- **Session bounds.** Entry never starts outside 09:15–15:30 IST, and unfilled
  orders left at 15:30 fail closed with an alert rather than resting overnight.

## Testing

- Unit: a leg whose marketable price would be worse than its `ceiling` is
  REFUSED, not sent — on both sides (a sell below its ceiling, a buy above).
- Unit: an unfilled leg leaves `failed` with a reason and places nothing
  further. No retry.
- Unit: `converge` refuses a `working`/`failed`/`pending` row and records the
  refusal; accepts `complete`.
- Pricing itself is already covered by `apps/api/test/marketable.test.ts` and
  needs no entry-specific duplicate — which is the point of reusing it.
- Integration against the simulator, which fills limits when the market trades
  through: a full fill reaches `complete`; a leg priced through the market
  leaves `failed` and the supervisor never builds a worker.
- **Paper rehearsal is the real test.** The entry engine runs identically in
  paper, so the whole flow can be exercised on a live feed with no money at
  risk before it is ever pointed at `mode: 'live'`.

## Open items

1. **The naked-short carve-out — needs the operator's decision before
   implementation.** "All four simultaneously" plus "alert and freeze" means a
   partial fill can leave a short with no wing against it, deliberately
   unmanaged, until a human intervenes. That is a materially worse risk position
   than the half-condor the freeze policy was written for.

   Proposed narrow exception: *a partial fill that leaves any short leg
   unprotected marries its wing at MARKET before freezing.* Everything else
   still freezes untouched. Recorded rather than assumed — as written today the
   spec freezes regardless, and that is what will be built absent a decision.

2. Alert transport. There is no alerting channel in the desk today; "alert"
   above currently means a loud log line plus the book's state on the dashboard.
   Whether that is enough for a live book is worth deciding before this phase
   goes to `mode: 'live'`.

3. Whether `entry.targetLegs` should be authored in the create-book wizard
   (phases 5-6, merged) or stay a seed file. The wizard is the better home; it
   is scoped out here only to keep this phase to the engine itself.
