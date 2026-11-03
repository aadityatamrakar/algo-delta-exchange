# Ticket 07 — the remaining recenter tiers, and full-family parity (plan Task 9)

**Status: COMPLETE.** Branch `worktree-agent-a54640dab09ac5db8`, four commits:

| sha | what |
|---|---|
| `b11df3e2` | `feat(engine): every recenter-family tier is a dial phase R composes` |
| `1198eec6` | `feat(engine): all 12 preset fixtures replay green, decision for decision` |
| `d949b1c4` | `fix(engine): the balance tier's rebuild crosses the same book phase R would` |
| `a91b936f` | `fix(engine): every fresh sell in a package answers to the same candidacy row` (review round — see the fix report at the end) |

> Written inside the worktree at this relative path, as tickets 02 and 06 were,
> because the shared-checkout `.superpowers/` path is not writable from a
> worktree-isolated agent.

---

## 1. What was built

| file | note |
|---|---|
| `packages/desk-engine/src/tiers.ts` | **new**, 600 lines — the six tiers |
| `packages/desk-engine/src/shed.ts` | `phaseShed` composes them; `ShedResult` gains `stateAfter` + `creditCommit`; `shedCandidates` gains a `ScanOptions` seam |
| `packages/desk-engine/src/corridor.ts` | `Corridor.tol` (the EFFECTIVE tolerance); the scan routes through `greekReader` |
| `packages/desk-engine/src/marking.ts` | `greekReader`, `sellPrice` |
| `packages/desk-engine/src/shift.ts` | the roll-forward routes through `greekReader` (see §5 — this was a real defect) |
| `packages/desk-engine/src/types.ts` | `StrikeGreekReader`, `EngineInputs.strikeGreeksOverride` |
| `packages/desk-engine/src/index.ts` | `export * from './tiers.ts'` + the file's line in the package header |
| `packages/desk-engine/test/tiers.test.ts` | **new**, 42 tests, every number hand-derived in the comment beside it |
| `packages/desk-engine/test/parity.test.ts` | **new**, 15 tests over 1,152 recorded marks |
| `packages/desk-engine/test/parity-adapter.ts` | `adaptGreeks`; the `unwind_enabled` fix; §1/§1b/§3 rewritten |

### The six tiers

```ts
applyEodSweep(inputs, dials, state)                  -> { armed, rcEodDay }
applyAnchor(inputs, dials, state)                    -> { anchor, gkAnchor }
applyConfirm(dials, state, breached)                 -> { streak, confirmed }
applyTrendTarget(dials, netDelta, allowed, excess)   -> { budget, target, dir }
lifoUnwind(inputs, dials, state, cor, opts)          -> { actions, taken, shed }
applyRecycle(inputs, dials, state, cor, opts)        -> { actions, rcCredit, credit, commit }
balanceTier(inputs, dials, cor)                      -> { actions, reason } | null
```

plus the pieces each needs and a test wants separately: `unwindStack`,
`recycleLoss`, `recycleStrike`, `NO_UNWIND`, `NO_RECYCLE`, `RecycleCommit`.

### The transliteration map, row by row

| `playbooks.py` | shipped |
|---|---|
| `eod = eod_min and minute >= eod_min and st.rc_eod_day != date` (`:3527-3529`) | `applyEodSweep`, `>=`, date compare against `RuleState.rcEodDay` (`''` = never) |
| `st["rc_eod_day"] = date` before any outcome is known (`:3532-3533`) | armed in `phaseShed` before its own guards; outcome-blind |
| `if eod: tol = 0.0` (`:3531`) | `phaseShed` derives `{...cor, tol: 0, allowed: 0, excess: abs(netDelta)}` |
| `if not eod and allowed < lot_size` (`:3567`) | the floor test skips on a sweep |
| `alpha = 2/(n+1)`; `anchor = spot if prev is None else …` (`:3515-3525`) | `applyAnchor`; `gkAnchor` 0 = unset, seeds to spot |
| `atm = A.nearest_strike(ctx, anchor)` (`:3636`) | `ScanOptions.atm`, fed to both candidate paths |
| `streak = prev+1 if excess>0 else 0`, before the in-band return (`:3608-3612`) | `applyConfirm`, called between the floor and `excess <= 0` |
| `if confirm > 0 and streak < confirm: hold` (`:3619-3621`) | same order |
| `st["gk_streak"] = 0` on EMIT (`:3835-3836`, `:3866-3867`) | reset only when the mark actually emitted |
| `tdir = 1 if nd < 0 else -1` (`:3653`) | `TrendTarget.dir` |
| `sk is None -> budget = excess, target = -tdir*allowed` (`:3654-3656`) | `trend_enabled` false |
| `else target = tdir*sk*allowed; budget = abs(nd - target)` (`:3657-3659`) | identical |
| `stack_side = "CE" if side == "PE" else "PE"` (`:3676`) | identical |
| `g_floor = lot_size / (tol*spot) if tol>0 and spot>0 else 0` (`:3688`) | `lifoUnwind`, off `Corridor.tol` |
| `_rc_unwind(ctx, stack, budget*share, max(0, abs(ng) - g_floor))` (`:3689-3690`) | `share` is 1.0 — see §4 |
| `sort(key=(seq, depth), reverse=True)` (`:2815-2816`) | `unwindStack`, stable two-key comparator |
| `take = int(round(remaining/per_lot)); if take <= 0: take = 1` (`:2873-2882`) | identical |
| `take = min(take, int(g_left // g_lot)); if take <= 0: break` (`:2883-2885`) | identical |
| `take >= lots -> close_ids` else ONE `close_parts` and break (`:2886-2895`) | `close` / `resize`, `break` |
| `remaining = max(0, budget - shed)` (`:3691`) | sizes the candidate scan |
| `loss = sum(max(0, -gross_mtm))`, partial prorated (`:2899-2928`) | `recycleLoss` off `LegView.mtm` |
| `credit = frac*loss; fund = bank0 + credit; st["rc_credit"] = fund` (`:3769-3773`) | deposit in `rcCredit` |
| `r_side = side if opp else stack_side` (`:3781`) | identical |
| `bound = [strike] if lots>0 else []` (opp) / `closed_ks` (`:3786`) | identical |
| `_rc_recycle_strike` pushes past the bound, `None` at the chain edge (`:2931-2954`) | `recycleStrike` |
| `want = int(fund/(px*lot_size))` (`:3792`) | `Math.trunc`, price via `sellPrice` |
| `got = shed + lots*dps*lot_size`; `on_trend = tdir*(nd + tdir*got)` (`:3793-3794`) | identical |
| `room = max(0, (allowed - on_trend) if opp else (allowed + on_trend))` (`:3797`) | identical |
| `n = min(want, int(room // per_lot))` (`:3799`) | `Math.floor` |
| `state_commit = {base: fund, value: fund - spend, …}` (`:3810-3812`) | `ShedResult.creditCommit` |
| `bal > 0 and dte > bal`; one side missing; sell `other` lots (`:3578-3596`) | `balanceTier` |

---

## 2. The two seams this needed, and why each is shaped that way

### `Corridor.tol` — the EFFECTIVE tolerance

The unwind's convexity floor is `lotSize / (tol × spot)`, and `tol` there is the
tolerance the band was actually measured at, i.e. **after** the `tol_ref_dte`
`√(dte/ref)` shrink and **after** the EOD sweep zeroes it. Recomputing it from
`dials.delta_tol_pct` would let the unwind spend convexity the band no longer
has, which is the spiral `_rc_unwind`'s own docstring measures at 7% → 46% of
marks outside the band. So `corridor()` publishes it.

### `EngineInputs.strikeGreeksOverride` — the controller's directive, implemented

The clean shape the controller offered, taken as offered: the chain keeps
carrying QUOTES, and the parity adapter injects a reader the engine consults
first. Three details are mine and are load-bearing:

1. **The gate is `pricing`, not the presence of the reader.** `greekReader`
   ignores an override outside `pricing: 'parity'`. A stray reader on a live
   inputs object must never steer a live book off numbers this engine did not
   measure — that is the whole defect the migration exists to retire, and
   "someone set the field" is not a licence to reintroduce it.
2. **Both-or-null**, where `_chain_greek` reads delta and gamma independently.
   That narrows in the conservative direction: a half-greek row drops the strike
   from the candidate set rather than sizing off half a measurement. No recorded
   row is half-greek, so the two agree over the whole set.
3. **`ScanOptions`, not a changed signature.** `shedCandidates` keeps its six
   positional parameters and gains one optional options object carrying `atm`
   (the gk-anchor snap) and `greeks`. `corridor.ts` and `shed.test.ts` call it
   unchanged.

**It is not optional.** Deleting the override fails **11 of the 12** preset
files (plus the aggregate coverage test) — see the mutation table.

---

## 3. Full-family parity — the run

`packages/desk-engine/test/parity.test.ts`, 15 tests. **12 files, 192 sequences,
1,152 marks, 0 mismatches.**

| file | marks | adjust | hold | exits | deferred debits |
|---|---|---|---|---|---|
| `recenter` | 96 | 48 | 48 | 30 | 0 |
| `recenter-eod` | 96 | 42 | 54 | 0 | 0 |
| `recenter-eod3` | 96 | 42 | 54 | 0 | 0 |
| `recenter-trend` | 96 | 48 | 48 | 30 | 0 |
| `recenter-reshift` | 96 | 48 | 48 | 30 | 6 |
| `recenter-crossfill` | 96 | 48 | 48 | 30 | 24 |
| `recenter-atm` | 96 | 54 | 42 | 18 | 0 |
| `recenter-otm` | 96 | 54 | 42 | 18 | 0 |
| `recenter-relief` | 96 | 42 | 54 | 6 | 0 |
| `recenter-relief-b1` | 96 | 60 | 36 | 6 | 0 |
| `recenter-relief-b2` | 96 | 30 | 66 | 6 | 0 |
| `recenter-relief-free` | 96 | 72 | 24 | 6 | 0 |
| **total** | **1,152** | **588** | **564** | **180** | **30** |

Also: **522** open legs compared in order; **50** marks whose `state_after`
differs from the state they were handed; **1,072** marks whose recorded reason
names an allowance and **546** a netΓ, both compared (§5). Every one of those
numbers is asserted as an EXACT equality in the last test, per file and in
total, so a regeneration that quietly stopped exercising an arm fails rather
than passing on a smaller claim.

`parity-shift.test.ts` is untouched and still green (576 marks, 60 shift marks,
516 silent, 24 exact).

### What "structurally equal" means, precisely

1. **Action kind** — `A._adjust` returns `"adjust"` iff handed opens, closes or
   partial closes (`actions.py:50`); the engine adjusts iff it emitted an
   `EngineAction`.
2. **The open package IN ORDER, with lots.** Python's `open_legs` is
   `[shift…, sell] + recycled`; a set comparison would let a reordered or
   double-counted package through.
3. **The exit set, with the SURVIVING lot count.** Python splits exits across
   `close_ids` and `close_parts`; the engine spells them `close` and `resize`.
   The canonical form is `resize <id> -> <targetLots>`, so a 1-lot buy-back
   cannot pass as a 5-lot one. Sorted, because Python's exit ORDER carries no
   meaning downstream (both lists are consumed by id) while its membership and
   the surviving size carry all of it.
4. **`state_after`** on `rcCredit` / `rcEodDay` / `gkAnchor` / `gkStreak`, plus
   Python's deferred `state_commit` against `creditCommit`, plus an assertion
   that `rcStack` / `scrapBanned` / `targetStreak` / `targetLocked` did NOT
   move, plus an assertion that Python never grew a state key outside the five
   the adapter knows (`rc_seen` is the one deliberate drop). That last one is
   what stops a dropped key hiding a divergence.
5. **The measurement** — §5 below.

Reason STRINGS are not compared; their formatting deliberately differs.

Three supporting tests guard the comparison itself: every sequence's first mark
is handed `EMPTY_RULE_STATE` (so the six marks are a real state machine, not six
independent ones); no decision names a leg the book does not hold (so a
phantom id cannot render as `-> -1` on both sides of a diff that then agrees);
and the fixture set is the size this suite claims.

---

## 4. Two defects found and fixed, both silent

### (a) `unwind_enabled` was reading the wrong dial — adapter

`adaptDials` set it from "any of `unwind_share` / `unwind_entry_book` /
`unwind_added_first` is present". Python's gate is
`bool(p.get("unwind_added_first"))` and nothing else (`:3554`). **`recenter-eod`
and `recenter-eod3` ship all three keys with `unwind_added_first: False`**, so
the old reading turned the unwind ON for the two presets whose defining property
is that it is off. Harmless while only phase S was replayed; a wrong answer on
84 marks the moment phase R runs.

### (b) `phaseShift`'s roll-forward re-solved its landing greeks — engine

`phaseShift` still called `strikeGreeks` directly. On
`recenter-atm/rally-itm-margin-armed` the engine measured post-shift **netΓ
−10.7, allowance 70** against Python's **−11.7 and 77** — the −8.5% gamma
divergence ticket 06 §2 measured, landing on the number phase R then sizes its
package against. **No recorded decision changed** (both are under the 100 lot),
which is exactly how a number nobody measured stays wrong. Found by the
measurement check in §5, not by the package comparison.

### (c) A third, found in self-review — the balance tier bypassed the sell gate

`balanceTier`'s rebuild is a fresh SELL and was going out without the candidacy
row every other fresh sell answers to (spec §6). Fixed in `d949b1c4`: the order
still stands (gate failure is a maker quote, never a silent hold) and
`sheddable` says which. `pricing: 'live'` only, so no recorded decision moves.

---

## 5. Making the suite bite — 31 mutations

An all-green parity run on the first attempt is a claim that has to be earned,
so every mutation below was applied to the real source, both suites run, and the
file restored byte-identically (`git diff` verified empty after each).

**How to read the counts.** They are FAILING TESTS, not files. `parity.test.ts`
declares **15** tests — one per preset file plus three aggregate ones (the
coverage table, the fresh-state check, the exit-branch check) — so a row reading
"12" is eleven preset files plus an aggregate, not twelve files. The
override-deletion row is the one where that distinction matters and it is
spelled out under the table. `tiers.test.ts` declares 42.

| mutation | failing parity tests (of 15) | `tiers.test.ts` (of 42) |
|---|---|---|
| shed: parity greeks ignored, Black-76 re-solved | **12** — see below | 3 |
| shed: sizing rounds UP instead of round-half | **9** | 3 |
| shed: convexity floor never holds | **10** | 2 |
| shed: balance never consulted | **7** | 1 |
| compose: phase S dropped entirely | **7** | — |
| unwind: gamma floor deleted | **5** | 2 |
| shed: sale sized off the raw excess, not the residual | **5** | 3 |
| shed: `remaining` ignores the unwind's shed | **5** | 3 |
| unwind: forced one lot deleted (the VEDL case) | **4** | 1 |
| eod: re-arms on every eligible mark | **3** | 2 |
| eod: sweep does not zero the band | **3** | 1 |
| eod: `>` instead of `>=` | **3** | 4 |
| recycle: band clip removed | **3** | 3 |
| recycle: arms swapped | **3** | 6 |
| recycle: debit folded into the state | **3** | 2 |
| recycle: bank ignored | **3** | 1 |
| recycle: loss not prorated on a partial | **3** | 2 |
| compose: phase R sized off the PRE-shift corridor | **3** | — |
| trend: skew ignored | **2** | 2 |
| recycle: re-sells at the strike just closed | **2** | 2 |
| compose: `hedge_after_shift` ignored | **2** | — |
| unwind: stack ordered SHALLOWEST first | 0 | **1** |
| recycle: a WINNING buy-back funds a sale | 0 | **1** |
| recycle: `landed` measured off the target | 0 | **2** |
| balance: `>=` instead of `>` | 0 | **1** |
| anchor: EMA not written back to state | 0 | **2** |
| unwind: entry book never eligible | 0 | 0 (equivalent) |
| balance: fires with both sides on the book | 0 | 0 (equivalent) |
| corridor: `tol_ref_dte` applies AT the reference dte | 0 | 0 (equivalent) |

**The override-deletion row, precisely.** 12 failing tests = **11 of the 12
preset files**, plus the aggregate coverage test. `recenter` itself survives:
its one shed strike's re-solved delta happens to round to the same lot count on
every mark of that file. So "deleting the override fails everything" is too
strong — it fails eleven twelfths of the family, and the twelfth is luck rather
than agreement.

**25 of the 31 are caught by the parity run**, 5 more only by the unit suite,
and 3 are **equivalent mutants** — they cannot change behaviour, and I checked
each rather than counting it as a gap:

- *entry book never eligible*: shifting every non-stack leg from sequence 0 to
  −1 is uniform, so the ordering is unchanged, and `unwindStack` has no
  entry-book FILTER to bypass (`unwind_entry_book` is `True` in every shipped
  preset — `tiers.ts` §6).
- *balance fires with both sides*: `missing.length > 1` lets a 0-length list
  through, and `missing[0]` is then `undefined`, which the next line refuses.
- *`tol_ref_dte` at the reference dte*: `√(ref/ref) = 1`.

### The measurement check, and why it exists

Four of the five real gaps are documented fixture-coverage limits (below). The
fifth was not: **"phase R sized off the PRE-shift corridor" originally survived
the whole 1,152-mark run.** On every recorded shift mark phase R holds on the
convexity floor both before and after the roll — measured, allowance 28
pre-shift and 77 post, against a 100 lot — so the composer could have been
wrong in an unobservable way.

Python writes both figures into its reason (`netΓ {ng:+.1f}`,
`allowance {allowed:,.0f}`), so the numbers ARE recorded even though the
decision they produced is the same either way. Reading them back — the same
technique `parity-shift.test.ts` uses for the shift notes, and reading NUMBERS
rather than prose — turns "the packages agree" into "the measurements agree",
covers 1,072 + 546 marks, kills that mutant (3 files), and is what caught defect
(b) above.

### The four genuine fixture-coverage gaps

Each is a property of the recorded grid, not of the port, and each is covered by
`tiers.test.ts` instead. Worth a generator row if the fixtures are ever extended:

1. **Stack ORDER.** `_sold_book` builds one leg per side, so newest-first and
   deepest-first are the same walk on every recorded book.
2. **A PROFITABLE buy-back.** No row marks a short above entry, so
   `max(0, −mtm)` is never the branch that bites. (`big-book-flat-mark` marks it
   at exactly 0.)
3. **`dte` exactly at `balance_min_dte`.** `one-sided-pe-book` runs at dte 20.
4. **The gk-anchor.** No preset sets `anchor_ema_marks` or `confirm_marks` —
   ticket 02's own concern 3.

A fifth, narrower one: no recorded mark has BOTH a residual sale and a recycle
(the unwind covers the whole budget on every recycling mark), so the sale's
contribution to the recycle's landing point is unobservable in the fixtures.
Covered by a dedicated unit test after the mutation surfaced it.

---

## 6. Verification

- `node --test 'packages/desk-engine/test/*.test.ts'` → **203 pass, 0 fail**
  (149 before this ticket, +39 `tiers.test.ts`, +15 `parity.test.ts`).
- `npx tsc -p tsconfig.json` → clean.
- `npm run test:node` (whole repo) → **3,174 pass, 1 fail**. The failure is
  `apps/api/test/service.integration.test.ts` › *"a PARTIALLY marked book names
  only the missing legs"*. **Pre-existing**: verified by stashing this ticket's
  whole working tree and re-running against the parent commit, which reproduces
  it (39/40). Ticket 06's report documents the same failure. Nothing here
  touches `apps/api`.

---

## 7. Adaptations to the brief

1. **`applyAnchor` is two functions, not one.** The brief folds "EMA … +
   confirm streak" into `applyAnchor`. They run at DIFFERENT points of the mark
   — the EMA before every guard, the streak after the band is known and before
   the in-band return — so fusing them would force the caller to know the excess
   before it has measured the band. Shipped as `applyAnchor` + `applyConfirm`,
   documented as one dial pair.
2. **The tiers take more than `(inputs, dials, state, cor)`.** `lifoUnwind`
   needs the stack side, the budget and the lot; `applyRecycle` needs the
   package the mark has formed so far. Those are the values Python's inline
   block reads from its own locals, and passing them is what makes each tier
   testable without reconstructing a whole mark. The four-argument prefix is
   kept and the extras ride in one named options object.
3. **`ShedResult` gains two fields.** `stateAfter` (three of the four state
   numerics move on marks that do NOTHING, so a hold has to carry it) and
   `creditCommit` (Python's deferred `state_commit`, which must not be folded
   into the state — see §4 of `tiers.ts`).
4. **The composition lives in the test, not in `src`.** `recenter_shift` merges
   both phases and sizes phase 2 off the post-shift greeks; the engine splits
   that deliberately (ticket 05's `cor` parameter). `compose` and `rollForward`
   in `parity.test.ts` are that composer, written there because Task 10 does not
   exist yet, and flagged in the file header as the shape to lift.
5. **`unwind_share` / `unwind_entry_book` have no dial.** Every shipped preset
   carries `1.0` / `True`, so `dials.ts`'s single `unwind_enabled` is the whole
   toggle and the arms they select are the only arms that ever ran. Documented
   in `tiers.ts` §6 and `parity-adapter.ts` §3.
6. **`sellPrice` is new.** The recycle sizes `⌊fund / (px × lotSize)⌋` off the
   premium a fresh sale would COLLECT, which is the bid in live pricing (spec
   §6) and Python's single mid-or-LTP float in parity. Four lines, and it is the
   exact class of defect the migration exists to kill.

---

## 8. Concerns

1. **One combination Python never had: an EOD sweep on a book that also carries
   a band dial.** `min_band_lots` is a floor UNDER the tolerance and the sweep
   sets the tolerance to 0, so the two contradict each other. I made the sweep
   win — it is the more specific instruction, it fires once a day, and a clamp
   that survived it would leave the book carrying `mbl` lots of delta overnight,
   which is the one thing `eod_flat_min` exists to prevent. No preset combines
   them today, so this is a decision waiting for an operator rather than a
   reproduction of one. Named in `phaseShed`'s header.
2. **`RuleState.rcStack` is READ and never WRITTEN.** `unwindStack` orders the
   victim pool off it, and nothing in this ticket appends to it — a replay
   executes nothing, and on a live book the entry belongs to whoever applies the
   fill and learns the real size. **Task 10 or the supervisor ticket owns
   maintaining it**, and until it does, every leg reads as entry book and the
   stack degrades to deepest-ITM-first. That is exactly what the fixtures
   exercise (every recorded leg is sequence 0), so parity cannot catch a
   supervisor that forgets.
3. **`tiers.ts` imports the geometry from `ladder.ts`, not from `corridor.ts`.**
   The standing contract says corridor; corridor imports `shed.ts`, `shed.ts`
   imports this file, and reaching back up would close that ring at runtime.
   `shed.ts` already imports from `ladder.ts` for the same reason and the
   `Corridor` type is imported type-only, so there is still exactly one
   definition of each name. Named in the file header.
4. **`corridor().floorRef` stays anchored on SPOT** even when the gk-anchor moves
   the strike phase R sells. Python's `recenter` — the only arm with an anchor —
   never computes a `floor_ref` at all (it compares the whole lot), so the
   combination is unreachable in Python and undecided by it. Anchoring the floor
   on the ladder rather than on a lagged pointer is the reading I took; it is a
   one-line change in `corridor.ts` if an operator wants the other.
5. **The unwind skips an unmarked leg where Python fell back to `0.30`.** The
   file-wide rule, and Python already skipped on a missing GAMMA for the same
   stated reason. No fixture leg is unmarked, so this is untested against the
   record and is a deliberate narrowing.
6. **Float agreement is exact on this grid but is not guaranteed.** `corridor()`
   sums per-share magnitudes × shares where Python reads a declared aggregate,
   and the two agree to the bit on all 1,152 marks — but `lots = round(x)` and
   `take = round(x)` sit on rounding boundaries, and JS rounds half away from
   zero where Python rounds half to even. Ticket 02's report names the two knife
   edges the grid was designed around; a future grid row could land on one.

---
---

# Fix round — coordinator review, 2 Important + 3 Minors

**Status: COMPLETE.** All five items addressed; both Important ones were real,
and IMP-1 was a live-money hole rather than a documentation gap.

## IMP-1 — the recycle's fresh sale bypassed the candidacy gate

**Confirmed, and worse than "an uncovered strike".** `verdicts` / `gated` /
`sheddable` were computed off the SHED candidates only, so `applyRecycle`'s open
— which lands somewhere the candidate scan never walked — could cross a
one-sided, wide or stale book in `pricing: 'live'` while the result reported
`sheddable: true`. Two aggravating details:

- The **crossfill arm lands strictly FURTHER OTM than the strike that was
  gated**, which is the thinner book, not the better one. The case where the
  gate matters most is exactly the case it was blind to.
- On the commonest recycling mark there is **no shed sale at all** (the buy-back
  covers the whole budget, `pick === null`), so the recycle is the only fresh
  sell in the package and nothing was carrying a gate for it.

And the second half: a one-sided book made `sellPrice` null and `applyRecycle`
returned `nothing` — a **silent drop**, where spec §6/§8 mandate the maker-quote
route.

**Fixed in two places, along the spec's own valuation-vs-candidacy line:**

1. `tiers.ts` — SIZING is a valuation. The bid stays the honest basis (it is
   what a fresh sale would actually collect), but when that side has never been
   seen it falls back to the VALUATION price so the package still FORMS:
   `sellPrice(quote, pricing) ?? midOf(quote)`. Nothing is dropped for want of a
   bid.
2. `shed.ts` — CANDIDACY is a gate, and the recycle's chosen strike now runs
   through the SAME `sellable` row as the shed's, in `pricing: 'live'` only. The
   order still stands (gate failure is a maker quote, never a silent hold) and
   `sheddable` is what says the market would not take it.

Both faults are named together in the reason, through one shared `uncrossable`
helper — the shed's gate and the recycle's are two different sales on two
different strikes, and an operator who read one and acted on it would leave the
other crossing a book we refused. A recycle-only failure deliberately does NOT
say "no candidate has a book we would cross", which would send them to fix the
wrong strike.

`pricing: 'parity'` is untouched: all 12 fixture files stay green.

**Tests** (`tiers.test.ts`, on a live Black-76-priced chain with named wings
quoted one-sided):

- *THE RECYCLE ANSWERS TO THE SAME CANDIDACY ROW AS THE SHED, on its own
  strike* — a control run where every book is crossable (2 opens,
  `sheddable: true`), then the same book with the recycle's 280 PE one-sided:
  **the identical package** (not dropped, same lots), `sheddable: false`, the
  reason naming `the recycle's 280PE one-sided book`, and an assertion that it
  does NOT blame the shed candidates.
- *a gated recycle on a mark with NO residual sale still surfaces rather than
  vanishing* — the `pick === null` path, where the recycle is the only sell.

**Mutation-checked**: reverting the gate → 2 tier tests fail; reverting the
`?? midOf` fallback → 2 tier tests fail. Parity is unaffected by both, which is
the point.

## IMP-2 — the EOD × band-floor ruling was documented but unpinned

**Confirmed** — no test combined `eod_flat_min` with `min_band_lots`, so the
ruling in `shed.ts`'s header was prose with nothing holding it.

Added *THE SWEEP OUTRANKS A BAND-FLOOR CLAMP — the one combination Python never
shipped*, on the review's own hand-check: netΔ +525 against a measured band of
277.2, a 5-lot clamp raising it to 500, so an ordinary mark carries an excess of
25 and sells **1** lot of the 320 CE, while the swept mark takes allowed to 0
and sells **18** — the whole book. It also asserts the sweep still consumes the
session. **Mutation-checked**: making the clamp survive the sweep → 2 tier tests
and 3 parity tests fail.

## MINOR-3 — the mutation table's label

Corrected. The column counted **failing tests**, not files, and
`parity.test.ts` declares 15 (12 per-file + 3 aggregate). The header now says
so, and the override-deletion row is spelled out: **11 of 12 preset files** plus
the coverage test. `recenter` itself survives that mutation — its one shed
strike's re-solved delta happens to round to the same lot count on every mark —
so the honest claim is eleven twelfths, and the twelfth is luck rather than
agreement. The §2 sentence that read "12 of 12" is corrected too.

## MINOR-4 — `balanceTier` is unreachable under either band dial

Added to its doc comment, with the same standing as the sweep ruling: with
`min_band_lots` or `no_band_floor` set there IS no convexity-floor branch, so
the tier cannot be consulted however a book is shaped — the band dials keep the
delta phase managing at every mark instead, which is a different answer to the
same problem rather than no answer. Python has the same shape and never shipped
a preset combining them, so this is undecided rather than wrong, and the note
says where the decision would go.

## MINOR-6 — the `close_parts` assertion is now per-file

Was a global `parts > 0`, which would keep passing if a regeneration moved the
whole family onto one branch. Now an exact per-file `[close_ids, close_parts]`
table — the split `ticket-02-report.md`'s follow-up records as having SWAPPED
when the fixtures were regenerated for physical consistency:

| branch | files | exits |
|---|---|---|
| `close_ids` (whole legs) | `-trend` (30), `-atm`/`-otm` (18 each), the four relief arms (6 each) | **90** |
| `close_parts` (partials) | `recenter`, `-reshift`, `-crossfill` (30 each) | **90** |

Totals asserted, and they sum to the 180 exits the coverage test independently
counts.

## MINOR-5 — the redundant `unwind_enabled` guard

**Dropped.** `lifoUnwind` already owns the toggle on its first line, and one
dial read in two places is one that eventually disagrees with itself. The
comment at the call site says so. `NO_UNWIND` stays exported for callers that
want the zero value.

## Verification, this round

- `node --test 'packages/desk-engine/test/*.test.ts'` → **206 pass, 0 fail**
  (was 203; +3 tests).
- Parity unchanged: 12 files, 192 sequences, **1,152 marks, 0 mismatches**.
- `npx tsc -p tsconfig.json` → clean.
- `npm run test:node` → **3,177 pass, 1 fail** — the same pre-existing
  `apps/api` service.integration failure, verified against the parent commit in
  the first round.
- The 31-mutation battery was re-run against the changed source; every count in
  §5's table is from that re-run, and `git diff` over `src/` was verified empty
  after each mutation. Three rows moved (the unit suite now catches more), none
  in the parity column except the ones IMP-2 added.
