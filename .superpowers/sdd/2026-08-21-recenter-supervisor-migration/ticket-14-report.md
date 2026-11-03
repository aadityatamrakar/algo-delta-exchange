# Ticket 14 — EngineHost: damped tick evaluation, crash-safe idempotent routing, fill folding

**Status:** COMPLETE. Branch `agent-ab566a8e5c5770159` (worktree), 6 commits off `0970bdc6`.

| | |
|---|---|
| Supervisor workspace suite | **99/99 pass** (`node --test apps/supervisor/test/*.test.ts`, Mongo up) |
| desk-engine suite | **368/369**, the one failure pre-existing (§8); **parity 22/22, 1,152 marks** |
| Full node suite | **3492 pass / 2 fail**, both pre-existing and proven independent of this ticket (§8) |
| Typecheck | `tsc -p tsconfig.json` clean **and** `@algomaker/web` clean |
| Mutation checks | 4 mutations, all caught (§7) |

---

## 1. What was built

| File | What it is |
|---|---|
| `apps/supervisor/src/decisions-client.ts` (new) | The one wire out. `submit()` → outcome \| `'INDETERMINATE'`, throws `RefusedError` only. |
| `apps/supervisor/src/engine-host.ts` (new) | `EngineHost` — one per (tag, mode). Also exports `MarkClock`, `istDateOf`, `istMinuteOf`, `dteOf`, `workDialsOf`, `pendingLotsOf`, `HostLog`. |
| `apps/supervisor/src/repair-hold.ts` (new) | `repairHoldReader` over desk-api's OWN `repairHoldLookup`, plus `NO_REPAIR_HOLD`. |
| `apps/supervisor/src/state-store.ts` (modified) | `workingPackage` gains `request` and `basis` (§4). |
| `apps/supervisor/test/{decisions-client,engine-host,repair-hold}.test.ts` (new) | 10 + 27 + 4 tests, no Mongo, no network, no wall clock. |
| `apps/supervisor/test/state-store.test.ts` (modified) | Round-trip test extended over the two new fields. |

### The host's surface

```ts
new EngineHost({ tag, mode, dials(), snap(), readBook(), margin(),
                 instrumentFor(strike, optType), repairHold(),
                 store, client, now(), log })
evaluate(); pollInFlight(); onFillNudge(); resolveInFlightOnBoot(); drain()
get inFlight: string | null      // the 1 s poll loop's gate
get armedIntent: ArmedIntent|null // diagnostics; nothing branches on it
```

**Two deps beyond the brief's sketch, both unavoidable.** `instrumentFor` — the
engine decides in strikes and the wire addresses contracts, and the desk's rule
is that a contract is looked up, never parsed; without it the host cannot build
an `open` at all. `repairHold` — `EngineInputs.repairHold` has to come from
somewhere, and carry item 7 says it must be desk-api's own source (§5).

**Three methods beyond the brief.** `pollInFlight()` is what Task 15's 1 s loop
drives (the brief's `onFillNudge()` is now a fire-and-forget wrapper of it);
`drain()` is the queue barrier tests and shutdown need.

---

## 2. Damping, as spec §7 / D4 states it

| Rule | Where | Test |
|---|---|---|
| `confirm_ms`, same trigger AND same action shape | `#damped` | flare-and-vanish routes nothing; 4,999 ms is not 5,000 |
| **Phase S is damped too** (D4 says so in as many words) | same path — `shift` is neither a guard nor phase R | "the SHIFT is damped like everything else" |
| Obvious-breach escape: excess ≥ 1 lot-equivalent | `#obviousBreach` | a shed routes at once; a scrap close does not |
| `cooldown_s` after any routed decision | `ruleState.lastActionMs`, stamped by the host | cooldown suppresses, then the re-proved intent routes |
| Two consecutive fresh **broker** margin reads before the shift's gate | `#margin` | 5-step test incl. "a repeated read keeps it armed" |
| Guard triggers (`lock`, `margin`, `expiry`, `eod`) bypass everything and preempt an armed intent | `GUARD_TRIGGERS` | zero-damping lock; lock ignores a 600 s cooldown |
| **A pass that routes nothing still banks the mark** (`decision.markState`) | `#persistRuleState` on every non-routing path | the lock DISARMS through a damped pass; the anchor EMA advances on a cooldown-damped mark; the scrap ban does not stick |

Two decisions worth naming:

- **The lot-equivalent is measured off the strike the package actually sells**
  (`strikeGreeks(chain, sale.strike, …) × lotSize`). That is the same `dps` the
  engine sized the package with (`lots = round(excess / (dps × lotSize))`), so
  the escape and the size agree by construction. A strike whose greeks do not
  solve gives no answer, and no answer means the ordinary wait.
- **The second margin read is enforced by lowering `fresh`**, not by a second
  copy of the gate. `shift.ts:marginArmed` refuses a non-fresh figure and
  `guards.ts:marginGuard` reads `margin.value` at face value — so the shift is
  gated and the margin TRIM is untouched. The count persists once armed and
  resets when a read comes back stale or modelled (fixed in review, §6).
- **The cooldown outranks the escape hatch.** "This book just acted" is a
  stronger statement than "this breach is obvious".

---

## 3. Exactly-once routing

`seq++` → `inFlight` → the whole package **saved (CAS) before the post**. Proven
two ways: a spy that reads the DOCUMENT at post time, and a crash test that
throws inside `submit` and then resolves from a fresh host over the same
document. Moving the post above the save fails **10 of the 27 tests**.

| Outcome | Host |
|---|---|
| 4xx `RefusedError` | roll the decision's rule-state delta back to the pre-decision `RuleState`, clear the flight, log at error, **no retry**. `seq` stays burnt; `lastActionMs` stays stamped so `cooldown_s` paces the next attempt (otherwise a still-true intent re-posts a fresh id every tick). |
| `'INDETERMINATE'` | keep `inFlight`, replay the same id at 1 s. |
| `DONE` | fold (§4), clear. |
| `FAILED` | **terminal here too** — `service.ts:#replay` answers a failed id FAILED forever. Whatever routed is still folded (a partial route is real exposure); the next intent mints a new id. |
| `WORKING` / `ROUTING` | keep `inFlight`, recompute the remainder, fold NOTHING until terminal. |

`WORKING` was verified against the endpoint's real behaviour before building on
it: `paper-fold.ts:settle` flips the record to `DONE` once every
`workingOrderIds` entry is accounted for, and `claimOrder` `$push`es each fill
onto `desk-decisions.fills`, so a replay of a settled package returns
`{replayed: true, status: 'DONE', fills: […at fill price]}`. **No contradiction
with the brief.**

Folding happens ONLY at a terminal status, precisely because the record
accumulates fills and every replay reports the whole list — folding a partial
would count it again on the next poll.

---

## 4. `rcStack`, realised P&L, and why the state grew two fields

`RuleState.rcStack` is read by `tiers.ts:unwindStack` and written by nobody —
the engine cannot write it, because a decision is not a fill. The host now:

- pushes each **filled** engine-opened Sell onto the stack, newest LAST,
  **merged by (strike, wing)** — a second entry for one position would give the
  same leg two sequences and order the stack against itself;
- shrinks the entry on a buy-back and pops it at zero.

Realised P&L folds **at the price desk-api reports for the fill** against the
leg's own entry (`Sell: entry − price`, `Buy: price − entry`, × filled shares);
an `open` realises nothing. Never the decision's limit, never this process's
mark.

**The guarantee differs by rail, and the earlier wording here was wrong.** On
PAPER the reported price IS the fill — `paper-fold.ts` reads the gateway's
terminal record and pushes the real `avgPrice`. On LIVE it is a
**decision-time mark**: `applyDecision` books optimistically at route time
(`service.ts:829-837`) and `reconcile-live.ts` restates `desk-books` from the
broker's record but **never restates `cumRealized`**. A live fold is real money
measured off a mark the broker may have disagreed with by a tick. That is the
standing ruling (live keeps the optimistic fold), so it is **stamped rather
than fixed**: every fold writes `cumRealizedBasis: {decisionId, basis: 'fill' |
'optimistic-mark', amount, at}` (bounded at `REALIZED_BASIS_KEPT` = 200; the
durable record is the append-only `desk-engine-decisions`). The true-up itself
is a named carry — §8, item 7.

Both need something a `WireFill` does not carry — the entry, and the
strike/wing behind a tradingsymbol — and by the time an outcome is read the leg
may already be gone from `desk-books` (desk-api folds on the fill). So
`workingPackage` gained:

- `request: DecisionRequest | null` — the package as posted, so a boot replay is
  verbatim. Load-bearing because the crash may predate the post: desk-api
  ignores the body of a CLAIMED id, but if the claim never happened the replay
  IS the first post. `null` = an older document; the host says so and clears.
- `basis: PackageBasis[]` — `{instrument, strike, optType, side, op, entry,
  lots, lotSize, intentQty}` per action, as the book stood when the package
  formed. Every field is **required**: a row missing a number is dropped and
  logged, because each absence is a specific wrong number (an absent `entry`
  banks the whole buy-back price as profit, an absent `lotSize` makes every fill
  worth zero lots) rather than an absence.
- `cumRealizedBasis: RealizedFold[]` — the per-rail provenance above.

Hydration is strict on identity (a request naming another decisionId or rail is
dropped whole; a basis row missing identity is dropped, never zero-filled) and
loose on the actions inside, which is the file's existing rule.

---

## 5. The repair hold (carry item 7)

Source located: `apps/api/src/repair-apply.ts:repairHoldLookup(db, now)` — the
same function `/v1/desk/positions` reads, built on `holdsBook` / `holdingOnTag`
(a RUNNING run holds to its TTL; a finished one holds for the adoption grace
past its last write; a run that placed nothing holds nothing; the strongest hold
on a tag wins). `repair-hold.ts` imports it rather than re-querying —
`repairHoldLookupFor` exists so the compiler proves the two shapes agree.

Fail direction: a read that **threw** HOLDS (standing a book down costs a mark;
trading through a repair re-decides a book whose legs it has not caught up
with). The only thing that fails toward false is a deployment with the feature
unwired (`NO_REPAIR_HOLD`). Log lines are rate-limited to one a minute — this is
called on every tick of every book.

---

## 6. Defects found and fixed in self-review

1. **The two-read margin gate armed for exactly one evaluation.** With a poller
   refreshing every 60 s and evaluation every tick, the shift was armed on one
   tick per minute and disarmed on the rest. Now counts distinct fresh broker
   figures and stays armed until one is stale or modelled.
2. **`work_tranche_lots: 0.5` reached the wire as `trancheLots: 0`** — the
   positivity test ran before the truncation. Zero is refused at the door and
   takes the WHOLE package with it.
3. **A package naming one contract twice** is now dropped locally with the
   contract named, instead of costing a `seq`, a round trip and a 400.
4. `#progress` could grow the remainder back (a short fill list would undo a
   longer one). It is monotonic now.

---

## 7. Mutation checks (evidence the tests bite)

| Mutation | Tests that failed |
|---|---|
| post before save | 10 |
| drop the `rcStack` push | 3 |
| always return the raw margin (no second read) | 1 |
| remove the `confirm_ms` wait; treat FAILED as still working | 4 |

---

## 8. Concerns / carries for the controller

1. **A guard cannot preempt a WORKING package yet — by design, and logged at
   ERROR.** Spec §8 wants "cancel first, then act"; the cancel path is Task 15's
   (maker-quote invalidation + `POST /v1/desk/broker/orders/:id/cancel`). Until
   it lands, a `lock`/`margin`/`expiry` decision arriving while a package is in
   flight is logged as `A GUARD WANTS THIS BOOK WHILE A PACKAGE IS WORKING — it
   is not routed` and nothing is posted: a second package against orders still
   out would double-close legs the first is already closing. **This is the one
   place the ticket is deliberately short of the spec, and Task 15 must close
   it.**
2. **Two pre-existing red tests on the integration branch**, both verified
   independent of this ticket (reverting `state-store.ts` to `0970bdc6` leaves
   both red):
   - `packages/desk-engine/test/dials.test.ts` — `DIAL_SECTIONS` does not
     contain `lock_exclude_mark0`, `lock_executability`, `target_snap_multiple`,
     `lock_branch_lots`, added to `Dials` by ticket 08. **Operationally this
     means four risk dials the operator cannot see or tune in the panel** —
     worth assigning to the UI ticket.
   - `apps/api/test/service.integration.test.ts` — "a PARTIALLY marked book
     names only the missing legs" (the known-red 26JUL fixture class).
3. **Guard exits are stamped `workMode: 'urgent'`** on the wire (spec §8);
   playbook actions carry no work mode, which desk-api reads as passive-first.
   New behaviour on the engine path — deliberate, and pinned by a test.
4. **NAMED CARRY — the broker-truth true-up of `cumRealized` (drills / launch
   ticket).** On the live rail the supervisor's realised P&L is folded off
   desk-api's optimistic decision-time marks and nothing ever restates it;
   `reconcile-live.ts` repairs `desk-books` and the decision journal, not this
   number. So a live book's `cumRealized` — which feeds `totalPnl` and therefore
   **the target lock** — drifts from broker truth by the difference between each
   fill's assumed and actual price. `cumRealizedBasis` now names every such fold
   by decisionId with its amount, so the true-up is a bounded job: for each
   `'optimistic-mark'` entry, read the broker's terminal fills for that
   decisionId (`desk-fills` / `desk-engine-decisions`), recompute the realised
   amount against the same basis rows, and apply the delta. **This must be done
   before, or as part of, the first live drill** — the alternative is a lock that
   banks on a number the broker never agreed with. Assign to the drills/launch
   ticket explicitly; nothing in ticket 14 does it.
5. **Task 15 wiring checklist** (nothing here reads Mongo or the bus):
   `readBook()` → `desk-books` via `COLLECTIONS.books`, mapped to `LegPosition`
   (`openedByEngine` from the leg's `origin`); `instrumentFor` → the instrument
   master; `margin()` → the per-book margin poller with an honest `asOf` that
   ADVANCES per read (the two-read gate is measured on it); `repairHold()` →
   `repairHoldReader({lookup: repairHoldLookupFor(db, now), …})`;
   `pollInFlight()` on a 1 s timer while `host.inFlight !== null` — **this is now
   the ONLY poller: `evaluate()` no longer re-posts an in-flight decision, so a
   host whose poll loop is not wired would hold a package forever**;
   `resolveInFlightOnBoot()` before the first `evaluate()`; and
   `marks-journal.ts` should share `MarkClock` rather than re-deriving the grid.
   `new StateStore(collection, log)` — pass the logger, or dropped basis rows are
   silent.
6. **`dteOf` is not clamped** — a book holding a contract past its expiry
   reports a negative dte and the settle does not re-fire the next day. That is
   the honest answer (the master has dropped the contract), but it means such
   legs need an operator, not a supervisor.
7. `evaluate()` is serialised but **not coalescing** — a tick storm queues.
   Task 15 must drive it from a coalesced timer rather than once per tick (the
   header says so).


---

# Fix round 1 — review: Needs fixes (2 Important + 6 minors)

All 8 addressed. `d59191ec` (code) + this appendix.

| | |
|---|---|
| Supervisor workspace suite | **96/96** |
| desk-engine suite | 368/369 (pre-existing `DIAL_SECTIONS`), **parity 22/22 / 1,152 marks** |
| Full node suite | **3489 pass / 2 fail** (both pre-existing) |
| Typecheck | root + `@algomaker/web`, clean |

## IMP-1 — a damped or dropped pass discarded the mark's bookkeeping

**Confirmed, and worse than "the streak survives a dip":** `guards.ts:425` fires
the disarm ONLY on a mark (`markCtx.isNewMark && targetStreak > 0`), and the host
had already consumed that mark from `MarkClock` before deciding not to route. So
the disarm was not deferred, it was **destroyed** — the streak could only ever go
up, across non-consecutive marks, which is the TCS 2026-06-19 defence turned off.
The gamma anchor and the EOD stamp (`shed.ts` §1: "the two tiers that move on
every mark, holds included") went the same way on any damped phase-R pass.

**Fixed in the reviewer's shape, with one correction.** `EngineDecision` gains an
additive `markState: RuleState`. The reviewer's definition — "`guarded`, the
guard-tier bookkeeping" — would have been a **regression** for the anchor: the
anchor EMA, the EOD stamp and the breach streak are computed in phase R, not the
guard tier, and today they persist on holds through `stateAfter`. So `markState`
is defined as **the state this mark moved without the PACKAGE's own deltas**:

- `hold(...)` → `markState === stateAfter`, by construction (a hold emits no
  actions, so it has no acting delta to hold back);
- guard decision / scrap / shift → `guarded` (a scrap ban is earned by a
  buy-back that happened);
- phase R → `ShedResult.markState` = its `counted` — anchor + EOD stamp + breach
  streak, **without** the recycle deposit and **without** the emit-reset of the
  streak;
- `gated()` carries it through both gates untouched: the sell gate and the margin
  cap can shrink a package, and neither changes what the mark counted.

The host persists `markState` on **every** path that routes nothing (damped,
locally dropped, CAS-lost, working-package, hold) and `stateAfter` only when the
package goes out. A **refusal now rolls back TO THE MARK** rather than to before
it — strictly better than the first pass, and it preserves the property the
review asked for.

**Parity: untouched and verified.** The field is additive and the suite compares
`stateAfter`, whose semantics did not move: 22/22, 1,152 marks, plus 6 shift
families byte-identical.

Tests (all mutation-checked): the lock **disarms** through a damped scrap pass
while `scrapBanned` does **not** stick; the anchor EMA advances on a
cooldown-damped mark. Writing nothing on a damped pass fails both; writing
`stateAfter` instead fails the first.

## IMP-2 — the fill-price claim was true on paper and false on live

**Confirmed.** `applyDecision` books live decisions optimistically at route time
and `reconcile-live.ts` restates `desk-books`, never `cumRealized`. The header
and report §4 claimed "never the mark" unconditionally, which is exactly the kind
of statement the exit-side work exists to stop.

(a) **Honesty:** header §4 and report §4 now state the guarantee per rail —
paper is the gateway's real `avgPrice` via `paper-fold.ts`; live is a
decision-time mark, real money measured off a number the broker may have
disagreed with.

(b) **Provenance:** every fold stamps
`cumRealizedBasis: {decisionId, basis: 'fill' | 'optimistic-mark', amount, at}`
in supervisor state — only folds that moved money, bounded at
`REALIZED_BASIS_KEPT` (200) on both read and write, with `desk-engine-decisions`
named as the durable record. Tested on both rails.

(c) **The true-up is a named carry** to the drills/launch ticket — report §8
item 4, spelled out as a bounded job (per `'optimistic-mark'` entry, re-measure
against the broker's terminal fills for that decisionId and apply the delta),
with the reason it matters before a live drill: `cumRealized` feeds `totalPnl`
and therefore the target lock.

## Minors

3. `workingPackage.request === null` now documents what the code does — the
   flight is ABANDONED with an error naming the manual remedy (the legs are in
   `desk-books`, the outcome in `desk-engine-decisions`, reconcile by hand or
   flatten before trusting realised P&L). The phantom "falls back to a
   reconstructed envelope" sentence is deleted.
4. `hydrateBasis` requires every field and **drops** a row that is missing one,
   with a log line naming which (`StateStore` takes an optional `StateLog`).
   `entry: 0` / `lots: 0` stay legal values — an `open` row carries exactly
   those — so the test is on the TYPE. Both hydrators are now tested: five
   malformed requests are refused, five malformed basis rows are dropped and
   named.
5. Concurrency-1 pinned for real: two passes that would BOTH legitimately route,
   with a state re-read across an `await` inside the critical section to catch a
   pass whose state moved under it. Two ids, in order, no overlap; removing the
   queue fails it.
6. `evaluate()` no longer re-posts an in-flight decision — `pollInFlight` (1 s)
   and the fill nudge are the single poller. It still EVALUATES under a working
   package, because the mark has to count and a guard has to be seen.
7. The header discloses the in-memory armed intent: a restart or a local drop
   restarts the confirm clock, deliberately (`confirm_ms` means "held while I was
   watching"), at a cost of one confirm window per restart per book.
8. `refusalGuidance(status)` — a 401/403 or 404/405 is named as a DEPLOYMENT
   FAULT that will refuse every book until it is fixed, a 429 as paced by
   `cooldown_s`, anything else as this package on its merits.

## Two follow-ups this round surfaced (not fixed here)

- **`gated()`'s degrade-to-hold keeps the recycle DEPOSIT.** When the sell gate
  or the margin cap drops a whole package, the resulting hold carries
  `shed.stateAfter`, which includes the deposit written on emit. That is
  pre-existing engine behaviour (unchanged by this ticket, and `markState`
  deliberately mirrors `stateAfter` on holds so nothing moved), but it looks like
  a bank movement for closes that did not happen. Worth a look from the engine
  owner.
- The pre-existing `DIAL_SECTIONS` red still stands (§8 item 2) — four lock
  dials the operator cannot see.


---

# Fix round 2 — one NEW defect, introduced by the round-1 fix

`82604d3a`. Reviewer's repro confirmed exactly as written.

| | |
|---|---|
| Supervisor workspace suite | **99/99** |
| desk-engine suite | 368/369 (pre-existing `DIAL_SECTIONS`), **parity 22/22 / 1,152 marks** |
| Full node suite | **3492 pass / 2 fail** (both pre-existing) |
| Typecheck | root + `@algomaker/web`, clean |

## The defect, and why round 1 caused it

Round 1 changed `#refused`'s rollback target from "the state as it was read" to
`decision.markState`, which is right for `scrapBanned` and wrong for the one
field the guard tier latches. `engine.ts`'s guard branch reported
`markState: guarded`, and for a lock FLATTEN `guarded` already contains
`targetLocked: true` (`guards.ts:392` snap, `:450` confirmed streak). So the
rollback was a **no-op for that field**:

- a REFUSED lock flatten (or one dropped locally, or one that lost the CAS) left
  `targetLocked` set;
- `guards.ts:313`'s terminal check never un-sets it — a banked run does not
  redeploy — so the book answers `hold: target banked — staying flat` **forever**;
- the legs are still open and every guard, including the margin trim, is
  silenced. Risk management off, quietly, on a book that is in profit and cannot
  bank.

Strictly worse than the pre-round-1 behaviour, which rolled back to the state as
read and therefore cleared it.

## The fix — the treatment `scrapBanned` already had

`GuardOutcome` now reports its own `markState`, so the knowledge of "which of my
fields is earned only by EXECUTING" stays in the file that writes it:

| site | `stateAfter` | `markState` |
|---|---|---|
| snap multiple (`:392`) | `{…state, targetLocked: true}` | `state` — the snap neither counts nor confirms; it banks |
| confirmed streak (`:450`) | `{…state, targetStreak, targetLocked: true}` | `{…state, targetStreak}` |
| every hold in the tier | unchanged | identical to `stateAfter` |
| margin trim | unchanged | the lock's — the trim is a package, not a latch |

**The streak rides on both**, deliberately: the mark really did print over
target, and a lock forced to count from zero after a refusal would take another
`target_confirm_marks` marks to re-fire on a book it has already proved.

The expiry settle (`engine.ts` step 0) runs before any tier and carries `state`;
nothing else in the guard branch sets a flag.

## The second acting-only flag the audit found: the EOD sweep stamp

`applyEodSweep` consumes the session the moment it ARMS
(`rcEodDay !== dateIst` is the whole arming test), so a stamp that survived a
sweep desk-api refused would mean the once-a-session flatten **never fires again
that day** — the book carries its delta into the close, which is precisely what
`eod_flat_min` exists to prevent. Phase R's `markState` now hands the stamp back
(`shed.ts:marked`). `stateAfter` is untouched, so hold semantics — where the
engine deliberately keeps the stamp — are exactly as ratified.

## Parity

**22/22, 1,152 marks, green.** Both changes are `markState`-only and the suite
compares `stateAfter`.

## Also folded in

- `refusalGuidance` four-case unit test: 401/403 and 404/405 both read as
  DEPLOYMENT FAULT (and name the variable to check), 429 as paced by
  `cooldown_s`, everything else as the semantic case — including an unforeseen
  status, which must not read as nothing.
- The provenance list logs at WARN when its 200-entry cap **actually evicts**,
  naming the oldest id it dropped. That eviction is the moment a broker-truth
  true-up's job stops being complete: only `desk-engine-decisions` still knows
  the fold happened. Tested.

## Mutation checks this round

| Mutation | Result |
|---|---|
| the confirmed-streak site latches on `markState` | the new lock test fails |
| the snap site latches on `markState` | the new lock test fails |
| (round-1 checks re-run) | still bite |
