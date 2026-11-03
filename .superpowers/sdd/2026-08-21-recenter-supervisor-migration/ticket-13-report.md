# Ticket 13 (plan Task 17) — Fill-gated tranche placement

**Status:** complete. Branch `worktree-agent-ac7f39593bc70aeef` (off `recenter-migration`).
**Commits:** `cbc5e6d7` (gateway), `760e15a4` (api dial threading).

---

## What shipped

### `apps/order-gateway/src/gateway.ts` — the pure decisions

- **`planTranches({quantity, lotSize, trancheLots, workMode, freezeMaxLots})`** →
  `TranchePlanEntry[] | null`. `null` means NOT GATED, and that is the
  compatibility guarantee: an order with no `trancheLots` and no `workMode`
  plans, splits and places exactly as it did before.
  - `workMode: 'urgent'` → slice = the freeze limit (the fewest legal slices).
  - otherwise → the dial, refused unless a positive **integer** (0 and 1.5 both
    make `splitIntoTranches` throw, on the order path).
  - `totalLots <= slice` → not gated at all.
- **`decideTrancheStep({plan, cursor, state, agg})`** → `settle | working |
  advance | halt`. Four rules in the order they must be asked, each with the
  failure it prevents in the comment; the load-bearing one is **an order that is
  not `PLACED` decides nothing** — between the claim and `markPlaced` the slice
  in flight is absent from `trancheIds`, so advancing double-places and halting
  raises a false alarm over a live order.
- `PlannedOrder` gained `maxLotsPerOrder` (the freeze limit the split actually
  used) so the tranche sizes are derived from `resolveUnderlying`'s answer
  rather than from a second copy of its precedence rules.
- `planOrder` gained an optional `slice: {quantity, idOffset}`: the freeze split
  still runs INSIDE a tranche, and a gated order's ids are always suffixed and
  continue across slices (`.1`, `.2`, `.3`) so slice 2 can never re-issue `.1`.

### `apps/order-gateway/src/queue.ts` — the cursor state

- `OrderState` gained **`HALTED`** — "this gateway stopped part-way", which is
  not what `PARTIAL` says ("the broker finished with an order that did not fully
  fill"). The `Record<OrderState, Verdict>` guard in `apps/api/src/routes/repair.ts`
  broke the build until it was answered, exactly as its header says it should.
- `writeTranchePlan` (fenced) — the plan is PERSISTED, not re-derived: the freeze
  table refreshes on an interval and a dial can change mid-session, so a plan
  recomputed for slice 3 can disagree with the one slice 1 was cut from.
- **`advanceTranche(id, fromCursor)` — the CAS (F-10).** `findOneAndUpdate`
  conditioned on `{trancheCursor: fromCursor, state: 'PLACED'}`; returns whether
  this caller won. It clears `placementStartedAt` (or every later tranche routes
  into recovery, which places nothing, and the order stops dead after tranche 1
  with no error anywhere), the claim fields, `placeAttempts` (the dead-letter
  counter bounds ONE placement's recovery loop, not a five-slice order's life),
  and the chaser's per-slice state — `chaseAttempts`, `chasedAt`,
  `lastChasePrice`, `chaseExhaustedAt`, `pegCrossedAt` — without which an
  exhausted first slice makes every later tranche invisible to the chaser.
- `markPlaced(..., append)` — a later slice `$push`es its ids instead of `$set`ting
  them. Replacing would delete the ids of tranches that have already FILLED, and
  the aggregate would wait forever on tranches whose names it no longer knows.
- `markHalted` — unfenced like `markTerminal`, and carries `filledQty`/`avgPrice`
  because the position is real and `service.ts:#actualEntries` prices legs off
  those fields.

### `apps/order-gateway/src/fills.ts` — the advance hook

`reconcile` asks `decideTrancheStep` BEFORE the terminal decision, because to
`decideOrderOutcome` a finished first slice is indistinguishable from an order
that stopped short (allTerminal + incomplete = PARTIAL) — it would end a nine-lot
order at three lots and the other six would never be placed.

- `advance` → CAS, then `wake?.()`. **A lost race returns**, never falls through:
  the loser's aggregate reads PARTIAL, which would end an order the winner has
  just placed the next tranche of.
- `halt` → `markHalted` + a `ok: false` journal line naming the reason. Nothing
  is cancelled: a slice can be more than one broker order, and cancelling a
  sibling would be this process flattening part of a live position on its own.
- `working` → returns (see above). `settle` alone falls through, and an ungated
  order is always `settle`.
- `wake` is an optional dep: the watcher **never places anything**, it re-arms
  the document and nudges the sweeper, so tranche i+1 takes the same claim →
  gates → place path as tranche 0. Absent, the idle sweep still finds it.
- `TERMINAL_STATES` gained `HALTED`; a garbled cursor reads 0, and one unusable
  plan row discards the WHOLE plan (a shifted index names a different slice than
  the cursor was set against; an empty plan just means "not gated", which is the
  safe direction).

### `apps/order-gateway/src/main.ts` — the loop, split

`placeOne` / `recoverInterrupted` / `processOne` moved out of `main()`'s boot
closure into an exported **`createOrderPlacer(ports)`**, injected, so the suite
drives the code the gateway runs — the argument `fills.ts` makes about itself.
`git diff` of the moved body against HEAD is comments plus exactly the intended
changes (verified line by line):

- the plan comes from `planFor`, which returns the whole-order plan and, for a
  gated document, the slice at the cursor;
- the tranche plan is written **before `markPlacing`** (after it, the first slice
  could go out against a plan no reclaim could ever see);
- `markPlaced` appends for a later slice;
- the staleness gate measures a later tranche from `trancheArmedAt`, not
  `createdAt` — a nine-lot order worked three at a time can outlive the 300s
  bound between its first slice and its last, and refusing the remainder would
  leave the desk holding a third of a position with the document INVALID;
- **`refuseSlice`**: a gate refusing a slice of an order that has already traded
  HALTS it rather than calling the whole thing INVALID. Same journal line, same
  reason, honest state — an operator reading INVALID beside "queued order not
  placed" would re-submit all nine lots.

`main()` wires the ports and a late-bound `wakeSweeper` (`nudged = true; void
sweep()`), whose `running` guard makes the re-entrant call from inside a sweep a
no-op — the drain loop then claims the re-armed document on its next turn.

### The dials, end to end (controller ruling)

`packages/desk-engine/src/contract.ts` gained `WorkDials` and
`DecisionRequest.work`; `routes/engine.ts` validates it (positive, whole lots,
buffer < 1 — a zero is a behaviour, not an unset, and `5` for "0.5%" is an order
at five times the market) and repeats it onto every pricing entry;
`decision-plan.ts` carries it like `workMode` (both branches — an unpriced
MARKET action is the shape that most needs it), and `rail.ts:orderDocument`
stamps `trancheLots` / `chaseMaxMs` / `chaseCrossBufferPct`, absent when nobody
chose. **The peg chaser has read the last two off the document since ticket 12
and nothing had ever written them** — peg mode is now live end to end.

Sourced from the WIRE rather than looked up from the books registry: the
supervisor resolved those dials to decide the order, and a second process
re-resolving them is how two components come to disagree about a book whose dial
changed mid-session.

---

## Tests

| Suite | Count |
|---|---|
| `apps/order-gateway/test/tranche-gating.test.ts` (new) | 13 |
| `apps/order-gateway/test/queue.test.ts` (+5 tranche unit tests) | — |
| `apps/order-gateway/test/rail-contract.test.ts` (+2 dial pins) | — |
| `apps/api/test/engine-decisions.test.ts` (+7, real Mongo) | — |
| `apps/order-gateway` workspace | **315 pass / 0 fail** (was 295) |
| Root `npm run test:node` | **3042 pass / 1 fail (pre-existing, below)** |
| `npx tsc -p tsconfig.json` | clean |

The new suite drives the **real** loop: `createOrderPlacer` + `createSweeper` +
`OrderQueue` + `FillWatcher` + the `SimulatorAdapter`, with the fill watcher
subscribed to the broker exactly as `main()` subscribes it. Every scenario from
the brief:

- 9 lots, `trancheLots` 3 → **one** 3-lot broker order, plan `[225,225,225]` on
  the document, cursor 0, `expectedQty` still 675;
- a crossing tick → tranche 1 fills → tranche 2 appears, ids `.1`/`.2`, ids
  appended not replaced; all the way to FILLED with `maxLive === 1` asserted
  continuously by the broker double;
- reject tranche 2 → `state: 'HALTED'`, the failures feed carries the reason
  ("margin shortfall"), `filledQty` is the 3 lots that did trade, tranche 3 is
  never placed, and a further sweep does not resurrect it;
- urgent 9 lots under a 5-lot freeze → `[375, 300]`, first placement 375;
- CAS: two concurrent `reconcile`s advance once and place one tranche; a stale
  `advanceTranche(id, 0)` returns false and moves nothing.

Plus: the freeze split inside a tranche (6-lot slice under a 5-lot freeze → two
broker orders, then the next slice waits); a slice cancelled at the broker halts
too; a kill switch thrown BETWEEN tranches halts rather than invalidates; the
advance clears the chaser's per-slice state; an ungated order is placed exactly
as before; and at the queue level, a real concurrent race on `advanceTranche`,
the append semantics, and `markHalted` without a claim.

**Harness:** `queue.test.ts`'s `FakeCollection` — the one that models
`findOneAndUpdate` as genuinely atomic — moved verbatim to
`test/mongo-harness.ts` (not a `.test.ts`, so the runner glob skips it, same
trick as `chaser-harness.ts`) and gained `$push`/`$each`, `$unset` and `$in`.
**No assertion in `queue.test.ts` was changed.** That atomicity is what makes the
cursor race real rather than decorative.

---

## Deviations from the brief

1. **`urgent` is still gated**, at freeze-sized slices. The brief says "tranche
   size = freeze limit" and asserts the plan `{5,4}`; both readings satisfy that
   test, and this one keeps the ticket's stated invariant (one tranche live at a
   time) with no exemption. **It is a behaviour change for urgent orders over the
   freeze limit**, which today go out as one batch — flagged below.
2. **A slice that goes terminal SHORT of its size halts, not only a REJECTED
   one.** A cancel or a partial that stopped leaves the desk holding less than it
   decided to hold, and stacking the next slice on that difference is the same
   failure D11 names. The halt reason names the rejects when there are any.
3. **`refuseSlice`** (a gate refusing a later slice halts instead of
   invalidating) is not in the brief. It closes a hole this ticket opens: without
   it, a kill switch thrown mid-sequence marks a two-thirds-filled order INVALID.
4. **The dials ride the wire** (`DecisionRequest.work`) rather than being read
   from the books registry by desk-api — reasoning above. **A later supervisor
   ticket must send it**; the field is optional and everything degrades to the
   gateway's own defaults without it.

---

## Concerns / follow-ups

1. **An urgent order over the freeze limit is now sequential** (deviation 1). If
   the controller wants urgent unsliced, the one-line change is in
   `planTranches`; the test that pins the plan shape stays valid either way.
2. **`mirror-sync.pendingOrder` asks `state: 'PLACED'`** to mean "an order is in
   flight for this tag/symbol". A gated order dips through PENDING/CLAIMED
   between slices, so that check can answer "nothing in flight" mid-sequence and
   file a repair against a book that is still executing. Mitigating: it applies
   only to `MIRROR_*` tags (not supervisor books), and the same hole already
   exists for the PENDING window before any first placement. Widening it to every
   non-terminal state would block healing whenever the gateway is down, so it
   wants a decision rather than a reflex.
3. **Nothing cancels the sibling of a rejected tranche.** A slice that freeze-split
   into two orders can have one refused while the other works; the halt says so
   and leaves it to a human. Deliberate — see `#halt`.
4. **Peg responsiveness is still floored by `DESK_CHASE_MS` (5s)**, carried over
   from ticket 12's concern 1 and now more visible: each slice gets its own
   `chaseMaxMs` window from its own `placedAt`, so a 30s deadline is ~6 peg
   opportunities per slice.
5. **The gateway has no env default for `trancheLots`** — absent means ungated,
   full stop. Deliberate (nothing silently gates existing traffic), but it means
   gating cannot be turned on without the supervisor sending the dial.
6. **Pre-existing red test:** `apps/api/test/service.integration.test.ts:153`
   "a PARTIALLY marked book names only the missing legs" — verified pre-existing
   by stashing this work and re-running on the clean tree. Not touched here.
7. **Test-runner note:** killing `npm run test:node` early (a `| head` closing the
   pipe) leaves the shared test Mongo dirty and the NEXT run shows spurious
   `books-registry` failures. Redirect to a file instead; a clean run is
   3042/1.

---

# Fix round 1 — review response

**Commit:** `38fac3ba`. 3 Important + 4 Minor, all folded in; Minor 6 (web
`STATUS_RANK`) was reassigned to the dials-UI ticket and is not touched here.

## IMP-1 — the gate-halt forgot what had traded

`refuseSlice` wrote `markHalted(id, {reason})` with no quantity, so a kill switch
thrown between tranches left a two-thirds-filled order's legs at the seed price:
`service.ts:#actualEntries` skips a document whose `filledQty` is absent, and
`reconcile-live.ts` folds the shortfall off the same two fields. That is the
shape of the 2026-08-04 MTM error, arriving through the state introduced to
prevent it.

Fixed by giving both halt paths ONE reader: **`FillWatcher.filledSoFar(base)`**
runs the same `#fillsFor` + `aggregateTranches` pair `#halt` uses, never throws
(it is called on the placement path, where a rejection turns a refusal into an
INVALID document), and answers `{0, null}` when it cannot read — and the caller
then OMITS the fields rather than stamping a false zero over a real fill.

Pinned in the gate-halt test: `filledQty === 3 × LOT`, `avgPrice === 101`.

## IMP-2 — the reconciler could not see a HALTED order

`reconcile-live.ts` scanned `['FILLED','PARTIAL','REJECTED','INVALID']`, so the
60-second broker-truth fold-back never looked at a halted document: a halted
nine-lot open of which three lots traded left the book carrying nine, forever.
It also read `state === 'PARTIAL'` to decide whether `filledQty` was real, so
even a scanned HALTED doc would have been treated as a rejection and un-booked
the whole leg.

Both halves fixed, and the list is now
**`IS_TERMINAL: Readonly<Record<OrderState, boolean>>`** off the gateway's own
union (type-only import, erased at build) — the `routes/repair.ts:VERDICT_OF`
philosophy, so the next state added over there breaks THIS build rather than
falling silently out of the scan. `PARTLY_FILLED_STATES` names the two states
whose `filledQty` is to be believed.

New test: a HALTED doc with `filledQty: 300` against a booked 500 → `scanned: 1`,
`corrected: 1`, the fill restated to 300 @ 101.5, the leg folded from -500 to
-300. **Verified it fails without the fix** (reverted both halves: "a HALTED
document is in the scan at all" fails, 35/1).

## IMP-3 — a gated EXIT was abandoned mid-flight

`decideTrancheStep` halted any slice that came back short, including a CLOSE.
Every other gate on this path carries the open/exit asymmetry — `refusesStaleOrder`,
`haltsQueuedOrder`, and the placer's own stale-gate comment — for the reason that
nothing un-books a refusal, so a stopped exit leaves the desk reading flat
against a live position with nothing retrying it.

`deskOp` (already on `OrderShape`) is now threaded into the decision, and an
exit-shaped op **advances** through a shortfall: continuing cannot over-close,
because the plan sums to the order's own quantity. `resize` counts as reducing
exactly as `reducesExposure` says, with the same stated residual — imported from
`queue.ts` rather than restated, so the two cannot disagree about `roll`.

Carrying on is not the same fact as filling, so `TrancheStep.advance` gained
`shortfall` and `#advance` makes a short advance LOUD (`ok: false`, into the
failures feed, naming the shortfall and why it continued). Three tests: an OPEN
that goes short halts; an EXIT that goes short advances and is journalled loudly;
a REJECTED tranche of an exit also carries on. **Verified they fail without the
fix** (13/3).

Per the reviewer's ruling this also settles concern (1): with the exit exemption
in place, urgent-over-freeze staying sequential is accepted and left as is.

## Minors

- **(4)** `markHalted` now takes the window its caller decided in
  (`{state, trancheCursor}`) and returns whether it landed — the same discipline
  `advanceTranche` uses. The watcher passes `{'PLACED', cursor}`, the placer
  `{'CLAIMED', cursor}` (its own conservative window: the document is claimed by
  that worker while the gate fires). A conclusion reached several awaits ago no
  longer lands on a document that has moved underneath it.
- **(5)** `FillWatcher.#halt` journals the alert BEFORE writing the state, the
  ordering `refuse()` states: a crash in between leaves a halt that is explained
  but not yet terminal, and the next pass halts again — idempotent. Marking first
  would leave an order stopped dead with nothing saying why.
- **(7)** New regression pin: with a 6-lot tranche under a 5-lot freeze, ONE
  sub-order held working while its sibling fills → the cursor does **not**
  advance and nothing new is placed. (The test harness's broker double gained a
  `holdAt` knob, because the simulator fills every resting order a crossing tick
  reaches.)
- **(8)** `planFor` resolves the contract and the freeze table ONCE and hands
  both to the two plans, instead of asking the master twice inside one placement.

## Verification

| | |
|---|---|
| `apps/order-gateway` | **318 pass / 0 fail** (was 315) |
| `apps/api` reconcile + repair + engine suites | **129 pass / 0 fail** |
| Root `npm run test:node` | **3046 pass / 1 fail** — the same pre-existing
`service.integration.test.ts:153`, verified on the clean tree earlier |
| `npx tsc -p tsconfig.json` | clean |

Each Important fix was verified by reverting it and watching the new test go
red, not by assertion alone.
