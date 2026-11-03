# Ticket 08 — guards, scrap, margin projection and the `decide()` orchestrator (plan Task 10)

**Status: COMPLETE.** Branch `worktree-agent-ae34a81e441668114`, five commits on
top of `8e1ede40`.

> Written inside the worktree because the shared-checkout `.superpowers/` path is
> not writable from a worktree-isolated agent.

**PHASE 1 EXIT: `npm test --workspace @algomaker/desk-engine` — 362 tests, 362
pass, 0 fail.** That is the D15 readiness gate's item 1.

---

## Commits

| commit | what |
|---|---|
| `72273238` | the four lock dials get a typed off-state; `RecycleCommit` moves into the vocabulary and `EngineDecision` carries one |
| `5ceeb2b8` | `guards.ts`, `scrap.ts`, `margin-project.ts` + tests; `unprotectedLots` lifted out of `shift.ts` |
| `7e2327bb` | `engine.ts`'s `decide()`; the parity suite migrated onto it |
| `e1066d82` | 73 transliterated Python tests, 217 assertions |
| `0abb5fb6` | self-review pass (two reason strings, one lifted mapper) |

## Test summary

| suite | result |
|---|---|
| `@algomaker/desk-engine` | **362 / 362** (was 206 before this ticket) |
| — of which parity | **1,152 marks × 12 presets, 0 mismatches**, now replayed **through `decide()`** |
| — of which ported from Python | **73 tests, 217 assertions** (target was ≥ 150) |
| full `npm run test:node` | 3,365 tests, 1 fail — `apps/api/test/service.integration.test.ts` "a PARTIALLY marked book names only the missing legs", **verified pre-existing** by stashing every change on this branch and re-running it (still red) |
| `tsc -p tsconfig.json --noEmit` | clean |
| `tsc` for `apps/web` | cannot run in this worktree — `@vitejs/plugin-react` is not installed (`node_modules/@vitejs` absent). No file under `apps/web` was touched. |

---

## 1. What was built

`packages/desk-engine/src/`

* **`guards.ts`** — `unprotectedLots` (the one definition of "lots the rules may
  spend"), `totalPnl`, `shortLots`, and `guardTier`: the mark-anchored hard
  target lock and the margin-cap trim.
* **`scrap.ts`** — `scrapKey`, `scrapClose` (the exit) and `sellGate` (the
  entry), the pair that has to move together.
* **`margin-project.ts`** — the SPAN-lite port and `projectMarginCap`.
* **`engine.ts`** — `decide()`, `rollForward()` (lifted out of the parity test)
  and `shedTrigger()`.
* `dials.ts` +4 fields, `types.ts` +`RecycleCommit` +`EngineDecision.creditCommit`,
  `shift.ts` now imports the shared netting helper, `index.ts` exports the four
  new modules.

### The evaluation order, as shipped

`decide()` runs spec §5's list with the settle hoisted to the front:

0. **expiry settle** — before the session gate, the repair hold, the guards and
   the working-package hold. `driver.py:30-37`: once the contract's expiry
   passes it leaves the broker master and can never be closed again by any
   means, "including a manual close-all". Everything else on the list can wait
   five minutes; this cannot wait at all.
1. session gate (trading day, ≥ 09:20, ≤ 15:30 — inclusive at the close)
2. repair hold (after the settle, deliberately: `driver.py:696-714`)
3. guards — target lock, then the margin trim
4. working-package hold (`pendingLots > 0`)
5. scrap tier
6. phase S; `hedge_after_shift` false returns on the shift alone
7. phase R, sized off the **post-shift** corridor (`rollForward`)
8. sell gate
9. margin projection
10. the deferred bank commit, scaled to the lots that survived 8 and 9

---

## 2. Verification the ticket rests on

### (a) SPAN-lite agrees with the Python it was transliterated from, to the paise

Not hand-arithmetic — 21 Black-76 repricings summed per scenario and minimised
is not a thing a human should check by hand. Every expected number in
`margin-project.test.ts` came out of `sensibull_tools.sim.margin.portfolio_margin`
run in the Python desk's own venv, over the same books at spot 300 /
2026-08-21 / 2026-08-28 expiry:

| book | Python `total` | TS `total` |
|---|---|---|
| Sell 4 × 310 CE @ iv 0.30 | 6,638.98 | 6,638.98 |
| … + Buy 2 × 330 CE @ 0.30 | 4,992.73 | 4,992.73 |
| Sell 4 × 310 CE, iv absent | 6,576.90 | 6,576.90 |
| Buy 2 × 330 CE alone | 0 | 0 |
| Sell 10 × 290 PE @ 0.30 | 16,626.04 | 16,626.04 |
| Sell 4 × 310 CE + 4 × 290 PE | 7,995.99 | 7,995.99 |
| the 10 projection sizes, 1…10 lots of a fresh 320 CE | 8,075.20 … 21,001.16 | identical |

`worst_scenario` matches too (`+21% at 1.25× vol` naked, `+21% at 0.75×` hedged),
which is what says the grid is the right grid rather than a different grid that
happens to sum the same.

### (b) The parity suite now calls `decide` — and it is still a comparison

Migrating the composer means the 1,152 recorded marks now run through four gates
the fixture generator never recorded (it calls `fn(call_ctx, params)`, the
playbook body — `scripts/gen-decision-fixtures.py:393`). Whether that is still a
comparison was **measured over the whole recorded set** rather than assumed:

| added tier | measurement | inert? |
|---|---|---|
| target lock | 0 marks reach `total_pnl ≥ 250,000` | yes |
| margin guard | 0 marks over cap (highest is **85%** of it) | yes |
| expiry settle | 72 marks carry `dte 0`, **all between 09:20 and 09:45**; the settle fires on the last mark | yes |
| session gate | every mark 09:20–15:30 on 2026-06-02, a Tuesday | yes |
| sell gate | 0 of the 522 recorded Sell opens is banned / sub-price / sub-delta at its own preset's dials | yes |
| margin projection | 0 of the 498 marks that open a sell under a cap projects over it | yes |
| **scrap tier** | three presets ship `scrap_close_delta: 0.1` over **216 short legs** under it | **NO** |

The sixth is the one accommodation, and it is spelled at the call site rather
than hidden in the adapter: `playbookOnlyDials` sets `scrap_close_px` and
`scrap_close_delta` to their off-states for the replay. Python's REAL engine
would have scrapped those 216 legs (`engine.py:914-918`); the fixture simply
never asked it to, so there is no recorded scrap decision to compare against and
no assertion is lost. `scrap.test.ts` is where that tier is checked.

**No parity assertion was weakened.** Two were strengthened:

* `rollForward` used to be a copy living in the test file; the band checks
  (1,072 allowances, 546 netΓ) now measure the **shipped** function.
* `state_after` is now compared against the recorded state **with Python's own
  `_commit_state` applied** (`pythonCommitted`), because `decide` applies the
  deferred bank commit as step 10 while the fixture's `state_after` is
  pre-commit. The structural `creditCommit` comparison (base/value/lots/
  optType/strike, field for field) is unchanged and still runs — which is why
  `EngineDecision` gained the field: without it a replay could only check the
  resulting number, and that agrees with a wrong `base` whenever the package
  fills whole.

---

## 3. Rulings, deviations and open items

### (a) THE CRASH TIER IS NOT WIRED — the one thing to read before merging

Spec §5 names "crash protect" between the lock and the margin guard, §8 lists it
as an urgency exit, and `crash_delta` 0.60 sits in the Advanced dial row. It is
deliberately **not** wired, and `guards.ts` §5 carries the four reasons:

1. **The trigger has no producer.** Python gates the whole tier on
   `K.regime(ctx) == "crash"` (`engine.py:574`, `conditions.py:205-206`), and
   `regime` comes off the backtest's signal generator. Nothing in this
   architecture computes one — `EngineInputs` carries a market snapshot, not a
   market opinion.
2. **Without that gate it is a different rule.** Measured on the recorded
   fixtures: **72 short legs across the twelve presets carry |Δ/share| > 0.60**
   (max 0.80). A regime-free crash tier would cut every one of them — deep-ITM
   shorts that phase S exists to SHIFT — and parity would fail on the marks that
   prove it.
3. **`TRIGGERS` has no `crash`** (`types.ts:156-159`). That list is ratified and
   validated at desk-api's boundary; adding a member is a contract change.
4. **It is already dead for this family.** `no_close: True` is what gates the
   crash tier off in Python, and every one of the twelve recenter presets carries
   it (`playbooks.py:349-478`); recenter's own comment says so — "it gates the
   ENGINE's crash-protect and margin-trim tiers".

**Open item for whoever owns the supervisor:** if a regime signal is ever
produced, wiring this is a small function plus one member on `TRIGGERS`.

Reason 4 applies to the **margin guard** too, and there the spec overrules it
twice (§5 lists the guard, §8 lists "margin guard trims" as an urgency exit), so
it IS wired — the difference being that its trigger is a number this engine
actually has. That is a deliberate behaviour change against the Python it
replaces: a live recenter book will now trim shorts on a cap breach where Python
did not. It is parity-safe (0 fixture marks over cap) and it is what the spec
asks for, but an operator should be told.

### (b) The expiry settle fires at the LAST MARK, not all day

The brief wrote the condition as "`dte === 0` and past `SESSION_OPEN_MIN`". As
shipped it is `dte === 0 && minuteOfDay >= SESSION_CLOSE_MIN` — which satisfies
the brief's guard and adds Python's own sufficiency condition (`is_final_mark`,
`session.py:97-109`: today is the expiry AND this is the final mark of the grid).
`>=` rather than `==` because a tick-driven supervisor must not miss the window
by landing a second late.

Settling at 09:20 would flatten a 0-DTE book at the open and delete the one
session the corridor is entirely delta and gamma — the day `marking.yearFrac`
refines its tenor intraday specifically so the greeks stay alive. It also would
have cost the parity suite 72 real marks (Python holds on all of them), which
would have needed a carve-out instead of a comparison.

### (c) `lock_branch_lots` is ported as the ORDERING, not as the ratchet

Python's two-branch lock does two things: above the branch it flattens
gamma-first with an adaptive per-mark clip; at or below it, it arms a TRAILING
RATCHET that **holds** and exits later on `max(target, lock_trail_frac × peak)`,
`dte ≤ 1`, or the lot count growing past the branch.

The ratchet needs `lock_trail_frac` and two state fields (`ratchet_on`,
`ratchet_peak`), and the spec's Advanced row names neither dial and `RuleState`
carries neither field. Half-porting it would make the desk's ONE hard rule HOLD
on exactly the small clean books it was written for — a silent way to turn
profit-taking off. **So the lock always banks, and a positive `lock_branch_lots`
buys the gamma-first close ordering alone.** The adaptive clip
(`max(20, ceil(n/3))`, full size from 15:15) is not ported at all and does not
need to be: it is PACING, which spec §5 retires in favour of the gateway's
fill-gated tranches.

### (d) `lock_executability` is ported NARROWED

Python suppresses a target print during the first two marks of a session it has
decided GAPPED (`|open/prev close − 1| > lock_gap_pct`). Neither `lock_gap_pct`
nor the four state fields that detect a gap exist in this schema. The port keeps
the SUPPRESSION and drops the GAP TEST: with the dial on, a target print in the
session's first two marks never advances the streak (and never resets it
either). That fires on quiet mornings too — later banking rather than banking a
phantom, the same direction the rule was written in, applied more often. Off by
default; `guards.ts` §3 is the only place this is written down.

### (e) `bestFit`'s rounding rule differs from Python's at an exact half — one measured case

The ported `test_it_never_reaches_past_the_cap` lands exactly on it: with excess
10 and a 285 PE at 0.20 a lot, `round(10 / 20)` is `round(0.5)`, which is 0 in
Python (banker's) and 1 in JS (half away from zero). Python holds; this engine
sells one lot.

Kept rather than "fixed", for the reason `shed.ts` (ticket 05) states: half-up
errs toward shedding slightly MORE, which is the safe direction past a band. The
premise stated there — "an exact .5 is not reachable off a solved greek" — holds
for every LIVE mark, and is reachable here only because the Python fixture
DECLARES round two-decimal deltas. All 1,152 parity marks agree either way. The
ported test now documents it with the concrete case instead of leaving it a
footnote.

### (f) Other deliberate non-ports

* `margin_persist_marks` (`engine.py:646-655`) — absent from the spec's dial
  schema, off in every recenter preset, and the supervisor's `confirm_ms`
  damping is the replacement for that class of same-tick reaction.
* the `atomic` arms of the sell gate and the margin projection — `atomic` is
  pairshift's flag and pairshift is out of scope (spec §5); a recenter shift is
  never marked atomic, so Python has never taken those branches for this family.
* `wing_relief_candidates` / `margin_benefit` / `per_leg_naked` from
  `sim/margin.py` (~110 LOC) — the wing search is gated on `no_buy`, which spec
  §5 hardcodes for this family, so it has no caller. The futures arm of
  `_span_core` is not ported either: `LegView` is an option by construction.
* Python's `try/except -> hold("rule-engine error")` wrapper — every input here
  is typed and every arm total, and swallowing an exception in a decider is how a
  book goes quiet for a session and nobody finds out. The supervisor (Task 14) is
  the layer with somewhere to log it.
* `cooldown_min` and the per-mark throttle — deleted by spec §5.

### (g) Contract additions beyond the brief

Both were needed and both are additive:

* `EngineDecision.creditCommit` — see §2(b). `EngineDecision` is used nowhere
  outside this package yet, so nothing else moved.
* `RecycleCommit` moved from `tiers.ts` to `types.ts` (re-exported through the
  barrel, so every existing import site is unchanged) because `types.ts` may not
  import a tier.

### (h) TDD honesty

The three tier modules and the orchestrator were written before their tests
rather than after — the composer migration drove the order, because the parity
suite is what says whether `decide` is right at all. Every module then got its
own hand-computed or Python-referenced suite, and two of those suites failed on
first run and changed the code or surfaced a divergence (the SPAN-lite float
comparison, the `bestFit` rounding case in §e). The ported-test sweep in `e1066d82`
was written strictly test-first against behaviour already shipped, which is where
§e came from.

---

## 4. The ported sweep, by file

| file | ported tests | assertions | source |
|---|---|---|---|
| `corridor.test.ts` | 6 | 21 | `test_sim_recenter.py` band gate, `_unwind.py` √dte block |
| `shed.test.ts` | 13 | 38 | `test_sim_recenter.py` sell selection, `_relief_band.py` scan |
| `tiers.test.ts` | 13 | 42 | `_eod.py`, `_eod3.py`, `_reshift.py`, `_unwind.py` |
| `shift.test.ts` | 14 | 29 | `test_sim_recenter_shift.py` geometry + margin gate |
| `guards.test.ts` | 8 | 25 | `test_sim_rules.py` lock/trim, `test_protected_legs.py` |
| `scrap.test.ts` | 8 | 18 | `test_sim_recenter_scrap.py`, `test_sim_rules.py` sell gate |
| `presets.test.ts` | 4 | 19 | the dial-RELATIONSHIP tests of `_eod`/`_eod3`/`_relief_band` |
| `marking.test.ts` | 3 | 10 | `_chain_greek` (`test_sim_recenter_shift.py:31-52`) |
| `engine.test.ts` | 4 | 15 | the invariants of `test_sim_recenter.py` |
| **total** | **73** | **217** | |

**Skipped, by class:** registry/`DEFAULTS`/`variants.BUILTIN` tests (Python
plumbing `presets.ts` replaces — the dial-relationship half IS ported), `rc_seen`
provenance (no counterpart by design, `tiers.ts` §6), cooldown tests (dial
deleted), crash-tier tests (§3a), and the non-recenter playbooks the family does
not contain.

The Python fixtures declare a `marked_book["net"]` while `corridor()` sums the
legs, so every ported net is BUILT — one short leg whose per-share δ and Γ land
the book on the recorded figure. The recorded LOT COUNTS then port unchanged: 67
lots of the 290 PE, the 100-vs-300 split between an excess shed and an EOD
sweep, the 667 a zero skew asks for, the 14 two merged shift legs become.

---

## 5. Files

| path | change |
|---|---|
| `packages/desk-engine/src/guards.ts` | new, 482 lines |
| `packages/desk-engine/src/margin-project.ts` | new, 449 lines |
| `packages/desk-engine/src/scrap.ts` | new, 251 lines |
| `packages/desk-engine/src/engine.ts` | new, 379 lines |
| `packages/desk-engine/src/{dials,types,tiers,shed,shift,index}.ts` | edited |
| `packages/desk-engine/test/{guards,margin-project,scrap,engine}.test.ts` | new |
| `packages/desk-engine/test/parity.test.ts` | composer → `decide` adapter |
| `packages/desk-engine/test/{corridor,shed,tiers,shift,marking,presets,dials,shift}.test.ts` | ported blocks appended |

---

# Fix round 1 — review response

**Commit `c6b73a19`.** All three Important items and all six minors addressed.
Suite after: **desk-engine 366 / 366** (was 362 — four regression tests added),
**parity 1,152 marks green**, typecheck clean, full `test:node` 3,368 / 3,369
with the same pre-existing `apps/api` red.

## IMP-1 — `creditCommit` documented an invariant it did not hold

**The finding stands and the reviewer's read of the code is right.** `types.ts`
said the commit was "ALREADY APPLIED to `stateAfter`"; `gated()` returned
`proposed.commit` unconditionally. On a mark whose sale the margin cap dropped,
`rcCredit` stayed at 2,500 and the decision reported a commit whose `value` (100)
implies a 2,400 spend that never happened.

**The code was right and the type was wrong**, so that is what changed. Reporting
the proposal is load-bearing: a ledger row showing nothing on such a mark could
not distinguish *the bank did not move* from *no bank rule ran*. What was missing
was the count that makes the proposal readable.

* `AppliedCredit extends RecycleCommit` adds `keptLots`, with the arithmetic on
  the type: `applied = base + (value − base) × min(1, keptLots / lots)`, so
  `keptLots: 0` is the honest spelling of "nothing was applied".
* `EngineDecision.creditCommit: AppliedCredit | null`, documented as **"the bank
  movement the playbook PROPOSED, applied to `stateAfter` only to the extent its
  lots survived — read `keptLots` before believing `value`"**.
* `gated()` stamps `keptLots` whether or not any survived; the state moves only
  when some did (unchanged behaviour).
* `engine.test.ts`'s drop-path test had **no assertion on the field at all** —
  the reviewer is right that the wrong claim would have gone unnoticed. It now
  pins `keptLots: 0` and asserts that the amount a ledger computes off the
  commit equals the bank the state carries.

**Parity got stronger, not weaker.** `pythonCommit` now counts `keptLots` off
Python's OWN surviving Sell opens (`_commit_state`'s opt_type **and** strike
match — the 2026-08-03 recycle fix), so the engine's kept count is compared
against Python's on all 30 banking marks rather than only the resulting rupees.
Additive field, 1,152 marks still green.

## IMP-2 — the guard walked before it measured

**Reproduced.** `marginGuard` is triggered by `inputs.margin.value` (a BROKER
figure) and steered by SPAN-lite (a MODEL), and it entered the trim walk on the
broker read alone — removing at least one whole leg before its first projection.
At the BHEL-2026-08-25 ratio (model 17,971 = 18% of a 100,000 cap, broker
250,000) it closed a 10-lot leg and printed a projection that was true *before*
the cut.

Fix: `if (project() <= target) return null;` ahead of the walk. It can only ever
trim **less**, and the pre-trade projection is still blocking fresh sells
meanwhile. Three regression tests: the BHEL-shaped decline, a genuine breach that
still walks and still stops when the projection clears, and the reason's
provenance stamps.

**Parity claim verified, not asserted:** the suite is green after the change, and
it is green because no fixture mark reaches the guard at all (0 of 1,152 marks
are over cap — the highest is 85% of it), so the pre-check has nothing to change
there.

**§3(a) amendment — the unit mismatch, now stated in `guards.ts` §4b and here.**
`margin_cap` is a **BROKER ceiling with a MODEL-sized remedy**, and spec §6
records how far apart the two get: SPAN-lite said 20.8L where the broker said
42.9L on BHEL-2026-08-25, a factor of **2.06**. Two consequences an operator
setting the dial needs:

1. Broker over-cap, model inside → **trims nothing** (that is the new pre-check).
2. Model over, broker under → the guard does not fire at all, and the pre-trade
   projection is the only margin control the book has. That is the designed
   division (spec §5's "0 = uncapped disables shift + margin guard projection"),
   not an oversight.

Python carries the same shape with no pre-check (`engine.py:656`) and it never
mattered there, because `no_close: True` makes the tier dead for the whole
recenter family. Spec §5 and §8 make it live here, so the shape had to be fixed
rather than inherited — which is the same reasoning as the original §3(a) note
that making this guard live is a deliberate behaviour change against Python.

## IMP-3 — `unprotectedLots` was not single-definition

**Correct on both counts.** `tiers.ts` kept a private `spendableLots`
(byte-equivalent) whose comment still pointed at `shift.ts`'s
`shiftSpendableLots`, deleted by this ticket; and `guards.ts` §1's "every
selection site" list named three of four.

* `unwindStack` now returns `guards.ts`'s `SteerableLeg` rows (assignable to
  `ReadonlyArray<LegView>`, so no caller moved) and `lifoUnwind` reads
  `leg.steerableLots` instead of recomputing it. The private copy is gone.
* `guards.ts` §1 names all four — phase S's ITM scan, the LIFO unwind's victim
  stack, the scrap tier's victim list, the margin trim — and says the list is
  exhaustive on purpose.
* Two `tiers.test.ts` assertions that deep-equalled a whole `UnwindTake.leg` now
  compare identity + size, and a new test pins that the stack is netted by the
  shared helper and carries the count.

## Minors

| # | done |
|---|---|
| 4 | `lock_exclude_mark0`'s **per-session vs Python's per-run** scope is now the third declared narrowing in `guards.ts` §3. Behaviour kept: Python's `_run_marks` fires once for a whole backtest run and would fire once on boot for a supervisor that never restarts, while the failure the dial defends against — legs marked at the prior session's prices before they have traded — is a property of a SESSION OPEN, the same shape as the TCS 2026-06-19 gap-open defence. The run-scoped literal would need a counter `RuleState` does not carry. |
| 5 | Every reason carrying a SPAN-lite figure stamps it `(model)`, and the broker figure `(broker)`: the trim now reads `margin Rs20,000 (broker) > cap Rs18,000; projects Rs6,639 (model), under the Rs17,100 target` — and that projection is the POST-trim one, which is what the sentence claims. Asserted in a test. |
| 6 | `parity.test.ts` — the state reconstruction **REPRODUCES** `_commit_state` rather than pinning it (on its own it would agree with a port that made the same mistake); what pins the port is the field-for-field comparison below it, now including `keptLots`. |
| 7 | `scrap.ts` notes that counting resizes in `kept` is deliberately safer than Python's `close_ids`-only branch, whose own comment calls itself "only accidentally safe for a partial close" — there a package whose only exit is a partial unwind degrades to a HOLD and keeps the delta it was shedding. |
| 9 | The unreachable empty-package branch is gone from `engine.ts` (with a one-line note on why it cannot happen), and the strike-rounding `n0` is replaced by an `inr` used only for rupees — a 2437.5 strike printed as 2438 in the shift reason, the same defect already fixed in the trim reason. |

## Note on process

One self-inflicted incident worth recording: a batch `python3` patch script
reused the wrong `Path` variable and wrote `guards.ts`'s contents over
`engine.ts`. Caught immediately by `tsc` (duplicate-export errors), restored from
git, and the re-application was done through a checked script that asserts on the
result. No commit was made from the broken state.
