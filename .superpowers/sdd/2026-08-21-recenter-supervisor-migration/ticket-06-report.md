# Ticket 06 — Phase S, the ITM shift (plan Task 7)

**Status: COMPLETE.** Commit `3d872f3e` on branch `worktree-agent-a6f7d1604a33462cf`.

> Written inside the worktree at this relative path, as ticket 02's report was,
> because the shared-checkout `.superpowers/` path is not writable from a
> worktree-isolated agent.

---

## What was built

| file | note |
|---|---|
| `packages/desk-engine/src/shift.ts` | new, 282 lines — `phaseShift`, `shiftSpendableLots`, `ShiftResult` |
| `packages/desk-engine/src/index.ts` | `export * from './shift.ts'` + the file's line in the package header |
| `packages/desk-engine/test/shift.test.ts` | new, 29 tests |
| `packages/desk-engine/test/parity-adapter.ts` | new — Python ctx/params → `EngineInputs`/`Dials`/`RuleState` |
| `packages/desk-engine/test/parity-shift.test.ts` | new, 7 tests over 576 recorded marks |

`corridor.ts`'s `otmSellStrike` and `nearestStrike` are IMPORTED, never
redefined, as the brief requires; `marking.ts`'s `strikeGreeks` supplies the
roll-forward.

```ts
export function phaseShift(inputs: EngineInputs, dials: Dials, state: RuleState): ShiftResult
export interface ShiftResult {
  readonly actions: ReadonlyArray<EngineAction>
  readonly rolledDelta: number   // ADD to corridor().netDelta — not a total
  readonly rolledGamma: number
  readonly fired: boolean
}
```

### The transliteration map, row by row

| `playbooks.py` | shipped |
|---|---|
| `spot <= 0 → hold` (`:3912`) | guard at top, returns `NOTHING` — the *hold* itself is the orchestrator's, as `corridor.ts`'s header already assigns it |
| `not shorts → hold` (`:3905`) | same |
| `_mfrac > 0` guards the gate (`:3950-3952`) | `shift_margin_frac` 0 = the GATE is off, not the shifting |
| `_cap > 0 and _mgn/_cap >= _mfrac` (`:3958`) | `dials.margin_cap` / `inputs.margin.value`, `>=` |
| — (no counterpart) | **`pricing: 'live'` also requires `margin.fresh && source === 'broker'`** (spec §6) |
| `dte > int(min_sell_dte)` (`:3960`) | `Math.trunc`, strict `>` |
| `K.unprotected(shorts)` (`:3968`) | `shiftSpendableLots` per instrument |
| `depth = (spot-k) CE / (k-spot) PE; depth < need → skip` (`:3978-3980`) | signed, identical |
| `land <= 0 → nk = atm`, else `_otm_sell_strike` (`:3981-3984`) | identical — the ATM branch is **not** pushed OTM |
| `nk == k → continue` (`:3985`) | identical |
| `lots <= 0 → continue` (`:3987-3989`) | identical |
| roll `cd`/`cg`, fall back to the leg's own (`:3994-4009`) | `strikeGreeks(...)`, else a zero adjustment |
| `shift_slot` merge (`:4011-4018`) | `Map<"strike:wing", index>`, lots summed, first-note order |
| `hedge_after_shift false → return` (`:4025-4027`) | `fired: true`; the caller short-circuits |

### The one branch with no Python counterpart

The margin gate has THREE off-states and they mean different things. Two are
Python's and both survive verbatim. The third is new:

> The Python desk armed this gate off whatever margin number was to hand,
> including the SPAN-lite model estimate, and on **BHEL-2026-08-25 SPAN-lite
> said 20.8L where the broker said 42.9L** — a factor of 2.06 on the one
> quantity the gate is a fraction OF. A model or stale figure reading 90% of cap
> could be any true load whatsoever, and it may not arm a rule whose action is a
> fresh short SALE.

So in `pricing: 'live'` the gate additionally demands `margin.fresh` from
`source: 'broker'`. It is skipped in `pricing: 'parity'`, because Python's ctx
carried one `margin` float with no provenance at all — requiring a broker stamp
there would make every recorded shift mark unreproducible. The adapter also
stamps `{source: 'broker', fresh: true}`, so the two are belt and braces and the
rule holds for ANY parity input, not just the fixtures'.

**Deliberately NOT implemented here:** the spec's "two consecutive fresh broker
reads" (§7). That is damping over a SEQUENCE of reads; `phaseShift` sees exactly
one `MarginInput`, and the counter belongs with `confirm_ms` / `cooldown_s` in
the supervisor, which is the only layer holding the previous read. **Flagged for
the supervisor ticket** — it is a real gate the engine cannot enforce.

### `protectedQty` netting

Python's `K.unprotected` is a per-leg BOOLEAN. `EngineInputs.protectedQty` is a
QUANTITY per instrument, which can express a leg the operator part-owns, so
`shiftSpendableLots(leg, protectedQty) = held − min(⌈claimed⌉, held)`:

- fully covered → the leg is skipped (the brief's test (e));
- over-claimed → clamped, never netted negative;
- partly covered → the spendable lots shift, and the leg **resizes** down to the
  protected tail rather than closing. `WireAction` already carries `resize`, so
  this needs nothing downstream.

Exempt at SELECTION and never at the close, because a shift is atomic: dropping
only the close half leaves the fresh sell standing alone and the book bigger
than it was.

**For the orchestrator ticket to lift:** the helper is named
`shiftSpendableLots`, not `unprotectedLots`, precisely so Task 10's shared
export can land beside it without an `export *` collision. Its doc comment says
so.

---

## Verification

### Unit — `shift.test.ts`, 29 tests, all green

The ladder is 250…350 by 10 with spot **305**, which puts the ATM snap at 300
(`nearestStrike`'s first-wins tie-break) and makes a short 300 CE sit *exactly*
`shift_itm_steps` 0.5 × step 10 = 5 points inside spot. Every depth test is
therefore also a boundary test: Python's gate is `depth < need → skip`, so a leg
at exactly the threshold MUST shift and a port that wrote `<=` fails here.

The brief's six required cases, plus the ones that would otherwise pass silently:

| brief | test |
|---|---|
| (a) 0.5 steps ITM at 65% of cap | one close + one open at 2-steps-OTM, lots preserved |
| (b) margin 50% | no shift |
| (c) `source: 'model'` at 90% | no shift — **the BHEL case, cited in the test** |
| (d) `margin_cap` 0 | never shifts, even at 5,000% of a ₹1cr cap |
| (e) `protectedQty` covering the leg | skipped |
| (f) two ITM legs | merged single open, two closes |

Beyond the brief: the landing strike is keyed to spot not to depth; `land <= 0`
lands on the ATM snap *without* the OTM push; an OTM leg's negative depth is
never touched; a short PE measures depth on the other side; one point short of
the threshold holds; `nk == k` is a no-op not a churn order; a long leg is never
a candidate; `>=` not `>` at the gate boundary; a stale BROKER figure is refused
as well as a model one; parity pricing takes the figure as-is;
`shift_margin_frac` 0 shifts at any margin; over-claimed and fractional
protection; two wings do not merge; `shift_enabled` false; the dte boundary
(2 shifts, 1 and 0 hold); spot 0; a flat book; the roll-forward's arithmetic,
its zero-adjustment fallback on an unpriceable target, and its summation over
legs; and statelessness (identical output from `EMPTY_RULE_STATE` and a fully
loaded one).

### Parity — `parity-shift.test.ts`, 6 presets, 576 recorded marks

`recenter-{atm,otm,relief,relief-b1,relief-b2,relief-free}` — every preset the
registry maps onto `recenter_shift`. `recenter-reshift` is NOT one (its name
contains the word; its `fn` is `recenter`), and the suite asserts `seed.fn` per
sequence so a mis-listed file fails by name.

| | count |
|---|---|
| marks replayed | **576** |
| shift-phase marks (Python's phase 1 acted) | **60** |
| sequences containing a shift | **10** |
| marks asserting phase S is SILENT | **516** |
| marks getting the stronger whole-decision check (`hedge_after_shift: false`) | **24** |

The 10 acting sequences are the margin-armed row in each of the four relief
presets, plus the armed / below-gate / uncapped rows in each of recenter-atm and
recenter-otm — whose `DEFAULTS` carry no `shift_margin_frac`, so their gate never
closes. That is exactly ticket 02's coverage table.

**Why the expectation is parsed out of Python's reason.** `recenter_shift` merges
phase 1 and phase 2 into ONE decision, and recenter-atm/otm carry no
`hedge_after_shift`, so their recorded `open_legs` may hold a phase-2 sell beside
the shift. Comparing a phase-S-only result against the whole decision would fail
for a reason that is not a defect. Python writes one
`shift {lots} {ot} {from}->{to}` note per shifted leg and prefixes those notes to
*every* exit of the function (`:4165`), and nothing after `:4029` ever appends to
`close_ids` — so the notes are a complete, ordered phase-1 record. The suite
asserts:

1. TS opens == the notes, merged, **in merge order** (a set comparison would let
   a reordered merge through);
2. those merged opens are CONTAINED in the recorded `open_legs` — this ties the
   prose back to the decision so step 1 is not merely parsing English;
3. TS closes == `close_ids`, exactly, as sets, and every exit is a `close` (a
   `resize` here would mean the netting fired on a book with no protected qty);
4. `state_after == ctx.state`, raw dicts AND adapted `RuleState` — the parity
   claim available to a stateless phase, and the assertion that fails if a
   regenerated fixture ever produces a shift mark that writes state;
5. `hedge_after_shift: false` → exact equality with the whole `open_legs`.

Reason strings are not compared. Every assertion carries a message printing the
recorded decision and the engine's actions side by side.

The **negative** half is my addition and is what makes the suite honest: on all
516 non-shift marks in the same six files, `phaseShift` must be silent. Without
it a port that shifted on every mark passes the positive half.

### The suite bites — six mutations run against the implementation

| mutation | parity result | unit result |
|---|---|---|
| margin gate always armed | **5 of 7 fail** | fails |
| `land <= 0` routed through `otmSellStrike` | **2 of 7 fail** | fails |
| depth gate removed | **7 of 7 fail** | fails |
| `cap > 0` guard inverted (uncapped shifts) | **5 of 7 fail** | fails |
| dte gate removed | 7 pass | **fails** |
| `shift_enabled` ignored | 7 pass | **fails** |
| protected netting bypassed | n/a | **3 fail** |
| merge disabled | n/a | **1 fails** |

The two mutations parity does not catch are genuine fixture coverage gaps and
both are covered by the unit suite: no recorded sequence has an ITM book at
`dte <= min_sell_dte` (the `expiry-day-dte0` and `near-expiry-dte3` rows are
OTM), and all six files are `recenter_shift`, so `shift_enabled` is never false
there. `shift.ts` was restored byte-identically after each mutation (`diff`
verified) before the commit.

### Suites and typecheck

- `node --test 'packages/desk-engine/test/*.test.ts'` → **126 pass, 0 fail**.
- `npx tsc -p tsconfig.json` → clean.
- `npm run test:node` (whole repo) → **3,078 pass, 1 fail**. The failure is
  `apps/api/test/service.integration.test.ts` › *"a PARTIALLY marked book names
  only the missing legs"*, a Mongo integration test. **Pre-existing on the
  branch**: verified by stashing all five files and re-running, which reproduces
  it (39/40). Nothing in this ticket touches `apps/api`.

---

## Concerns

### 1. BLOCKER for the phase-R parity ticket: the DECLARED net

`K.net_delta` / `K.net_gamma` read `marked_book["net"][...]` — a **declared
figure on the ctx, not a sum over the legs** (`conditions.py:159-171`) — and
`_net_delta_for` / `_net_gamma_for` only walk the legs when
`delta_shorts_only` / `gamma_shorts_only` are set, which no recorded preset sets.

`corridor()` sums the legs, deliberately, because a declared total that
contradicts its own legs is precisely the absent-vs-declared ambiguity spec §5
retires. It has nowhere to put a number that disagrees with the book it is
measuring.

Measured over the whole fixture set: **the two disagree on 1,080 of 1,152
marks.** `_ctx` takes `net.delta` from the grid row as an independent input, so
`up-delta-past-band` declares +900 over a book whose legs sum to 0 — ticket 02's
own concern 2 ("a coverage grid, not a physical one"), now with a number on it.
GAMMA agrees on all 1,152, because the generator patched it FROM the legs.

Phase S is unaffected: it never reads a net for a DECISION, only to roll one
forward, and the rolled figures are not compared in this ticket. **Phase R cannot
be parity-tested against these fixtures until the generator emits a
physically-consistent `net.delta`** (the leg sum). The alternative — an
`EngineInputs.declaredNet` field the corridor prefers — would port the exact
defect the migration exists to kill, and I did not build it. Written up in
`test/parity-adapter.ts` §1b, at the point where it will bite.

### 2. Chain strike greeks are approximate under parity, by ~1–9%

`ChainSnap` carries QUOTES and `strikeGreeks` re-derives greeks through a
Black-76 IV solve; there is no way to hand it a greek. The fixture rows carry the
generator's own `Γ = φ((K−S)/W)/W` kernel beside a price. Measured on the 330 CE
of `rally-itm-margin-armed` (spot 330, dte 20): delta **0.5066 here vs the row's
0.5000** (+1.3%), gamma **0.026254 vs 0.028692** (−8.5%).

Harmless for phase S (the rolled greeks are not compared, and every shift-family
preset either returns before phase R or holds on the convexity floor). A phase-R
parity suite must confront it — a tolerance, or an adapter that synthesises a
quote whose implied vol reproduces the recorded greek. Also in
`parity-adapter.ts` §1.

### 3. Two inherited Python edges kept on purpose

- `otmSellStrike` is bounded at 8 steps and its result is **not guaranteed
  strictly OTM** at the edge of a chain (`corridor.ts:216-218`). `recenter_shift`
  does not re-check, so neither does phase S — re-checking would diverge from
  every recorded decision.
- `shift_itm_steps` is **not clamped at 0**. A negative dial gives a negative
  threshold and shifts OTM legs too, exactly as Python does. Range is the dial
  resolver's job; coercing here would hide an operator's typo behind arithmetic
  that silently kept working — the same call `corridor.ts` makes for
  `delta_tol_pct`.

### 4. A narrowing in the roll-forward fallback

`_chain_greek` reads delta and gamma from the chain row INDEPENDENTLY, so a row
carrying a delta but no gamma rolls the delta and falls back on the gamma.
`strikeGreeks` is both-or-null by design (`marking.ts` §2 — an unpriceable strike
is not a candidate, the `dps = 0.30` stand-in is deleted), so here a target that
does not solve falls back on BOTH. Every fixture row carries both greeks, so the
two agree over the recorded set; a live chain with a half-quoted row would
diverge, in the conservative direction.

### 5. `no_buy` / `no_close` have no dial counterpart

They are `RuleEngine` gates, not playbook dials, and the generator records the
playbook's RAW decision before any of them run. The adapter drops them and
invents nothing; noted in `parity-adapter.ts` §3 so a later ticket does not read
their absence as an omission.

### 6. The parity tally depends on declaration order

`parity-shift.test.ts` accumulates counters across six per-file tests and asserts
the totals in a seventh. All seven are synchronous top-level `test()` calls, so
`node:test` cannot interleave them — and the assertion is on exact numbers
(576/10/60/516/24), so a short tally fails loudly rather than passing silently.
Worth knowing if anyone makes those tests async.

---

## Adaptations to the brief

1. **`shiftSpendableLots`, not `unprotectedLots`.** The brief says to implement
   the netting locally and note it for the orchestrator ticket to lift. A local
   `unprotectedLots` would collide with Task 10's export the moment `index.ts`
   re-exports both, so it carries a distinct name and a comment saying what
   should replace it.
2. **Partial protection resizes.** The brief's test (e) only requires full
   coverage to skip, but "min(protectedQty, held) exempt" implies a partial, and
   `close` cannot express one. `resize` is already in `WireAction`, so the
   partial case is expressed rather than rounded away.
3. **The parity expectation is read out of Python's notes, not its
   `open_legs`.** Forced by recenter-atm/otm merging phase 2 into the same
   decision; the containment check ties it back. Described above.
4. **The negative half (516 silent marks) was added.** The brief scopes the run
   to the shift-phase sequences; asserting silence everywhere else in the same
   files costs nothing and is what catches the "shifts on everything" port. It is
   a separate, named claim inside each per-file test.
5. **`shift_enabled` maps from `seed.fn`.** Python has no such dial — the
   registry decides by function. `seed.fn === 'recenter_shift'` is the honest
   encoding, and it is what the `P.REGISTRY` note in ticket 02's report
   describes.
6. **`margin_cap` is read from the CTX, not from `seed.params`.** It rides on the
   ctx in Python and is a dial here, so `adaptDials` takes both. Reading it from
   `params` would find nothing, default to ₹10cr, and silently arm every gate.
