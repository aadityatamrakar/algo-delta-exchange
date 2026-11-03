# Ticket 02 — Python decision-fixture generator (plan Task 4)

**Status: COMPLETE.** Commit `f4438ac6` on branch `worktree-agent-ade90e50bb60295af`.

> Written inside the worktree at this relative path because the shared-checkout
> path `/Users/aaditya/Documents/dev/algomaker/.superpowers/...` is not writable
> from a worktree-isolated agent.

---

## What was built

`scripts/gen-decision-fixtures.py` — runs the twelve Python `recenter*` playbooks
over a hard-coded deterministic grid and freezes their decisions as JSON under
`packages/desk-engine/test/fixtures/decisions/`, one file per preset.

Invocation is the brief's, verbatim (the output directory resolves from
`__file__`, so no arguments are needed):

```
cd ~/Documents/dev/algo-engine/sensibull-desk && .venv/bin/python \
  <algomaker>/scripts/gen-decision-fixtures.py
```

`--out <dir>` overrides the destination (used for the determinism re-run).

### Fixture shape

Each file is a **bare JSON array of sequences**, matching the brief's declared
interface:

```json
[ { "seed": {...}, "marks": [ {"ctx", "decision", "state_after"} x 6 ] } ]
```

A sequence is six consecutive 5-minute marks with `ctx["state"]` threaded from
each mark into the next. The playbook is handed a deep copy and mutates it
freely; the recorded `ctx` is therefore the pristine pre-call input, and the
copy's mutated `state` is what threads forward. Verified invariant across all
1,152 marks: **`marks[i].ctx.state` == `marks[i-1].state_after`, 0 violations.**

`seed` carries the grid row, the playbook key, the resolved function name and
**the playbook's full dial dict (`params`)** — so each sequence is a
self-contained replay unit and the TS side never needs its own copy of the
Python defaults. A dial changing in Python then surfaces as a real parity diff
rather than a silent disagreement.

### The market is frozen inside a sequence

Spot, chain and book are identical at all six marks; only `time` and `state`
move. This is deliberate and is the point of recording sequences at all: with
the inputs pinned, **any** difference between mark 1 and mark 6 is the rule's own
state. It is what lets these fixtures catch a port that re-arms the
once-per-session EOD sweep, drops the `rc_seen` provenance ledger, or loses the
`rc_credit` bank — bugs a single-mark fixture cannot see and a moving market
would disguise as an input difference.

---

## Three verification results

### (a) Both sides of the `shift_margin_frac` 0.60 gate — PASS

All four relief files carry sequences on both sides, and the gate is exercised
on the **same ITM book** so the comparison is meaningful rather than vacuous
(`rally-itm-margin-armed` at 85% of cap vs `rally-itm-margin-below-gate` at 30%,
both spot 330 with the 310CE four steps ITM):

| file | gate | seqs above | seqs below | armed decision | below-gate decision |
|---|---|---|---|---|---|
| `recenter-relief` | 0.60 | 5 | 11 | `adjust` — shift 4 CE 310→340 | `hold` — no convexity to centre |
| `recenter-relief-b1` | 0.60 | 5 | 11 | `adjust` — shift 4 CE 310→340 | `adjust` — sell 80 340CE |
| `recenter-relief-b2` | 0.60 | 5 | 11 | `adjust` — shift 4 CE 310→340 | `adjust` — sell 77 340CE |
| `recenter-relief-free` | 0.60 | 5 | 11 | `adjust` — shift 4 CE 310→340 | `adjust` — sell 82 340CE |

Asserted mechanically: the armed reason contains `shift`, the below-gate reason
does not, in every relief file. A third row (`rally-itm-uncapped`,
`margin_cap = 0.0`) covers the "no ceiling to be a fraction of" branch — cheap
insurance against a JS port doing `mgn / 0` or `cap || 1`.

### (b) Non-hold decisions — PASS (and the grid was raised twice to get there)

**642 of 1,152 marks are non-hold.** Per playbook (out of 96 marks / 16 sequences
each):

| playbook | non-hold | acting seqs | opens | closes | close_parts | state_commit |
|---|---|---|---|---|---|---|
| `recenter` | 48 | 8 | 42 | 24 | 6 | 0 |
| `recenter-eod` | 42 | 7 | 42 | 0 | 0 | 0 |
| `recenter-eod3` | 42 | 7 | 42 | 0 | 0 | 0 |
| `recenter-trend` | 48 | 8 | 48 | 30 | 0 | 0 |
| `recenter-reshift` | 48 | 8 | 48 | 24 | 6 | 6 |
| `recenter-crossfill` | 48 | 8 | 66 | 24 | 6 | 24 |
| `recenter-atm` | 54 | 9 | 54 | 18 | 0 | 0 |
| `recenter-otm` | 54 | 9 | 54 | 18 | 0 | 0 |
| `recenter-relief` | 42 | 7 | 42 | 6 | 0 | 0 |
| `recenter-relief-b1` | 72 | 12 | 72 | 6 | 0 | 0 |
| `recenter-relief-b2` | 72 | 12 | 72 | 6 | 0 | 0 |
| `recenter-relief-free` | 72 | 12 | 72 | 6 | 0 | 0 |

No file is all-hold, and **no two playbooks share an identical decision stream** —
every preset is distinguishable from every other, which is the property that
makes a per-preset parity test meaningful.

The brief anticipated needing to raise the grid. Two raises were needed, both
recorded in the script as named grid rows with the branch they exist to reach:

1. **`big-book-*` rows (10 lots).** At the brief's 4 lots the book's `|netΓ|` sits
   only ~1.8 above the gamma floor `lot_size / (tol x spot)`, so `_rc_unwind`
   could never afford a lot and `close_ids` was empty everywhere — the entire
   unwind half of `recenter` was untested. At 10 lots the unwind fires.
2. **`small-excess-partial-unwind` (netΔ +280, 3 shares past the band).**
   `recenter-reshift`'s recycle emitted **nothing** in the first grid, for a
   documented geometric reason: `recenter` sheds to the *near edge* of the band,
   and the closed-side recycle arm's room is `allowed + on_trend`, which is
   therefore ~0 by construction. Only a mark that *overshoots inside* the band
   leaves that arm any room. This row does it — one lot of the stack sheds ten
   times the excess, so `_rc_unwind` forces a **partial** lot (also the only
   `close_parts` coverage in the set) and lands well inside the band.

### (c) Determinism — PASS

Generated twice, the second run into a scratch directory:
`diff -r --brief` over all 12 files → **no differences, byte-identical.**

No clock, network, lake or RNG is read: every input is a literal or a pure
function of one, `ctx["date"]` stays the test builder's hard-coded
`2026-06-02`, and the six mark times are literals.

### Additional coverage probes (all pass)

- **EOD sweep fires exactly once per session**: `recenter-eod` / `-eod3` sweep at
  `15:15` and only there; `state.rc_eod_day` goes `[None, None, '2026-06-02',
  '2026-06-02', '2026-06-02', '2026-06-02']` across the six marks. Marks 4–6
  correctly revert to the ordinary band rule.
- **Recycle bank accumulates across marks**: `recenter-reshift`'s `rc_credit`
  runs 500 → 3,000 over one sequence, `recenter-crossfill`'s 1,000 → 6,000.
  6 and 24 `state_commit` payloads respectively.
- **Recycle side differs per arm as designed**: reshift re-sells the *closed*
  side (`PE 285`), crossfill the *opposite* side (`CE 315` alongside the residual
  `CE 310`).
- **Balance tier** (`one-sided-pe-book`) rebuilds the missing side.
- 10 of 192 sequences have a `state_after` that changes across marks (the rest
  are stateless-by-design presets or rows the state never touches).

---

## Files changed

| file | note |
|---|---|
| `scripts/gen-decision-fixtures.py` | new, 365 lines |
| `packages/desk-engine/test/fixtures/decisions/*.json` | new, 12 files (16 sequences x 6 marks each) |

Paths do not collide with `packages/desk-engine/src/` (the parallel ticket's
side); only `test/fixtures/decisions/` was created here.

The Python repo was **not modified** — the script imports it and writes only
under `--out`.

---

## Adaptations to the brief (each minimal, each load-bearing)

1. **`P.PLAYBOOKS` does not exist; the registry is `P.REGISTRY`.** Same content —
   12 keys start with `recenter`, six mapping to `recenter` and six to
   `recenter_shift`. The script asserts the count is 12 and fails loudly
   otherwise.
2. **The grid rows are dicts, not 4-tuples.** The brief's eight rows are present
   verbatim in `(spot, net_delta, dte, lots)`; the extra fields are the ones the
   brief itself tells you to choose (`margin_frac`, `margin_cap`) plus those the
   builders do not parameterise. Eight further rows are appended, each carrying a
   `note` naming the branch it exists to reach.
3. **Three fields patched onto the builders' output.** `_ctx` / `_chain_rows` /
   `_leg` do not supply them and a branch is dead without each one:
   - **gamma** (chain column + per-leg + `net.gamma`). `_ctx` hard-codes net gamma
     to `0.0` and `_chain_rows` emits price/delta only. Every recenter variant
     steers by `allowed = |netΓ| x tol x spot`, so at gamma 0 the convexity floor
     trips on *every* input and all twelve presets answer "no convexity to
     centre" to every mark — a fixture set that verifies nothing. Gamma is
     computed as real Black-Scholes gamma, `Γ = φ((K−S)/W)/W` with
     `W = S·σ·√T` and `σ = 0.18` a literal. Using the true relation (rather than
     an invented bell) is what makes the fixtures exercise `tol_ref_dte`
     honestly — that dial exists because gamma grows like `1/√T` into expiry, and
     here it actually does.
   - **`gross_mtm`** per leg. It is the *only* basis `_rc_recycle_loss` reads
     (never entry/ltp), so without it reshift/crossfill can never fund a recycle.
     Driven by a row's `ltp_mult`; `ltp_mult = 1.0` rows keep the builder's flat
     mark and cover "the recycle must fund nothing".
   - **`ctx["playbook"]`**, which the live engine stamps. Without it
     `recenter_shift` falls back to a landing-distance guess and `recenter-relief`
     labels itself `recenter-otm`, diffing every reason string.
4. **`_sold_book`'s legs are rescaled to the grid's lot count** (it is fixed at
   10). Per-share delta is recovered from the builder's own leg and re-applied,
   preserving its sign convention.
5. **`CHAIN_N = 6` instead of `_chain_rows`' default 10.** The chain is ~three
   quarters of every recorded ctx and the ctx is recorded 1,152 times, so this
   sets the size of the whole set. Verified empirically: regenerating at `n=10`
   and at `n=6` produces **identical decisions on all 1,152 marks**, because no
   recenter rule reaches further than ±4 strikes (sells at ATM±2, recycle pushes
   at most two past that, deepest shift lands at ATM+2). 6 leaves one strike of
   headroom on each side.
6. **A second mark window.** `eod-window-big-book` runs `15:05…15:30` instead of
   `09:20…09:45`. The brief's grid comment lists "eod minute" as something to
   cover, but `eod_flat_min` is 15:15 and the specified window never reaches it —
   at 09:20–09:45 the EOD branch is unreachable and `recenter-eod` / `-eod3`
   would be untested on the one dial that distinguishes them. Every other
   sequence uses the specified `09:20…09:45`.

---

## Concerns

1. **Working-tree size: 8.1 MB** across the 12 files (~21.5 KB each gzipped, so
   roughly 260 KB in the git packfile). Driven by recording a full `ctx` per mark
   x 6 marks x 16 sequences x 12 presets. The repo's existing parity fixtures are
   164 KB total, so this is two orders of magnitude larger and a reviewer may
   reasonably push back. I chose coverage over size and cut what could be cut for
   free (the `CHAIN_N` reduction above, which costs nothing). If it needs to come
   down, dropping `rally-itm-uncapped`, `big-book-flat-mark` and
   `big-book-down-unwind` gets to ~6.5 MB while still meeting the "≥8 sequences"
   floor — each costs a named branch, listed in the script.
2. **The grid is a coverage grid, not a physical one.** `net.delta` is an
   independent input (as `_ctx` designs it) and does not equal the sum of leg
   deltas; some rows carry more net delta than the book has shares. That is
   inherited from the brief's grid and is harmless for parity — the TS port
   replays the recorded ctx and must agree with Python on it — but it means these
   fixtures should not be read as realistic book states.
3. **Uncovered branches** I did not reach and would not reach without inventing
   inputs well outside the brief's grid: `gk-anchor`'s `confirm_marks` /
   `anchor_ema_marks` and `shed_scan_strikes` (no recenter preset sets them, so
   they are inert here by construction); `_rc_stack`'s LIFO ordering of
   *rule-added* legs (the fixtures never execute a decision, so every leg stays
   sequence 0 / entry-book — a port that mis-orders a multi-generation stack
   would not be caught); the engine-level gates (`_scrap_sell_gate`,
   `_project_margin_cap`, `state_commit` application) which live in `RuleEngine`,
   not in the playbook, and are out of scope for this ticket.
4. **Two float knife-edges were designed around, not left in.** The
   `small-excess-partial-unwind` row's recycle room is 26.96 against a 20-share
   lot; an earlier candidate sat at 19.96 vs 20 and would have flipped branch on
   any rounding difference between Python and JS. Worth knowing if the grid is
   ever retuned: `room = 30 − excess` on that row, and it must stay in `[20, 40)`.

---
---

# Follow-up — physical consistency of `marked_book.net.delta`

**Status: COMPLETE.** Commit `c113d288` on the same branch.

## The defect

`_ctx` takes `net_delta` as a free parameter and writes it straight into
`marked_book.net.delta`, while `_sold_book`'s two legs carry fixed per-share
deltas of ∓0.30 that always sum to **zero**. The original generator passed the
grid's target through as the aggregate and left the legs alone, so the declared
net and the leg sum disagreed on 1,080 of 1,152 marks (the 72 that agreed are
`flat-inside-band`, whose target is 0). Gamma was already consistent because it
was computed per leg and summed.

That matters because the two are read from different places: Python's
`K.net_delta` reads the aggregate, but `_rc_unwind` sizes off per-leg `K.dps`,
and nothing stops a port summing the legs — so the fixture verified a different
thing depending on which side the port happened to read.

## The fix — legs are the source of truth

I chose **"adjust the leg construction to sum to the intended net"**, not
"recompute the net from the legs". Recomputing would have pinned every strangle
row to net delta 0 by construction (the two legs are symmetric), erasing the
inside-band / past-band / which-side distinctions the whole grid exists to draw.

Each leg's per-share delta is now its builder base (0.30) plus a uniform
per-share **skew** in the delta-increasing direction, solved in closed form so
the leg sum lands exactly on the row's target:

```
net(k) = Σ signᵢ x (baseᵢ + signᵢ x k) x sharesᵢ  =  natural + k x Σ sharesᵢ
  =>  k = (net_delta − natural) / Σ sharesᵢ            (sign² = 1)
```

`sign` is −1 for a short CE, +1 for a short PE. Leg deltas are rounded **first**,
then summed into `net.delta`, so the aggregate is the sum of the numbers actually
in the file rather than of their un-rounded ancestors. Two guards: every
resulting per-share delta must land in `[0.02, 0.98]` (the clamp `_chain_rows`
itself uses), and the realized sum must match the target to 1e-6 — both raise
`SystemExit` naming the offending row instead of emitting a bad fixture.

Leg deltas are deliberately **not** pinned to the chain's delta at the same
strike. On the live desk a held leg's greeks come from the marked book and the
chain's from the chain snapshot, and the rules read them from those two separate
places (`K.dps` vs `_chain_delta`); forcing them equal would hide a port that
confuses the two.

### Grid net-delta targets had to change

The brief's grid asked for ±900 and +2500 on books of 800 shares. `|netΔ|` is
bounded by the shares in the book, so those are not merely unrealistic — a leg
would have to price at 1.1 delta per share — they are **unbuildable**, and the
new guard refuses them. Each target was lowered to the nearest value preserving
its row's scenario. Two rows also changed **sign**, because the brief's number
pointed the wrong way physically:

| row | was | now | why |
|---|---|---|---|
| `up-delta-past-band` | +900 | **+200** | 800 shares; allowance ~111, so +200 is still 1.8x past the band |
| `down-delta-past-band` | −900 | **−200** | mirror |
| `near-expiry-dte3` | +900 | **+200** | 800 shares |
| `rally-itm-margin-armed` | +2500 | **−200** | **sign flipped**: a 10% rally drives the short 310CE deep ITM, leaving the book net *short* delta |
| `rally-itm-margin-below-gate` | +2500 | **−200** | same |
| `rally-itm-uncapped` | +2500 | **−200** | same |
| `one-lot-book` | +900 | **+50** | 200-share book |
| `expiry-day-dte0` | +900 | **+200** | 800 shares |
| `big-book-*` (x3), `eod-window-big-book` | ±900 | **±550** | 2,000 shares; the most this skew can carry |
| `one-sided-pe-book` | −900 | **+80** | **sign flipped**: a lone short PUT is *long* delta — no negative net exists for this book at any size |
| `flat-inside-band`, `tiny-delta-in-band`, `small-excess-partial-unwind` | — | unchanged | already attainable |

## Verification — original three, plus the new fourth

### (4) NEW: declared aggregate == leg sum — PASS

Over all **1,152 marks in all 12 files**:

- `net.delta` vs `Σ(leg deltas)`: **0 mismatches**, worst \|diff\| **0**
- `net.gamma` vs `Σ(leg gammas)`: **0 mismatches**, worst \|diff\| **0**
- legs whose per-share delta falls outside a legal short-option range
  (CE ∈ [−0.98, −0.02], PE ∈ [0.02, 0.98]): **0**

### (a) Both sides of the 0.60 gate — PASS

5 sequences above the gate, 11 below, in each of the four relief files; on the
matched ITM pair the armed side shifts (`shift 4 CE 310->340`) and the
below-gate side does not, asserted mechanically.

### (b) ≥1 non-hold relief sequence — PASS

**588 of 1,152 marks non-hold** (was 642; the smaller, physical deltas produce
fewer breaches). No file is all-hold and no two playbooks share a decision
stream. Relief family: `recenter-relief` 42/96, `-b1` 60/96, `-b2` 30/96,
`-free` 72/96.

### (c) Determinism — PASS

Generated twice, second run into a scratch directory; `diff -r --brief` over all
12 files → **no differences**.

### Shift-phase decisions — UNCHANGED, as required

**60 shift-phase marks in the old fixtures; 60 byte-identical in the new; 0
changed; 0 new-only.** This is not luck: `recenter_shift`'s phase 1 selects legs
by ITM depth against `spot`, `strikes_out`/`shift_land_steps`, the margin gate
and `min_sell_dte` — it never reads net delta. And on the rally rows phase 2 is
silenced by the convexity floor (`allowance 77 < one lot 100`), which is a gamma
comparison, also delta-independent. So `parity-shift.test.ts` on the other
branch should keep passing against the regenerated fixtures without change.

### Coverage probes — all still pass

EOD sweep still fires exactly once (`15:15`, `rc_eod_day` stamped from mark 3
onward); reshift recycles on 6 marks and crossfill on 24; credit bank still
accumulates across a sequence (reshift 500 → 3,000).

## One coverage shift worth knowing about

Whole-leg unwind closes (`close_ids`) and partial closes (`close_parts`) swapped
places on the `recenter` family, and this is a *consequence* of physical
consistency rather than a regression:

For `nd > 0` the rule sells CE and unwinds the **PE** stack — but on a
consistent book the positive net delta *comes from* those short puts, so the PE
leg necessarily holds at least `nd` of delta, and `excess = nd − allowed` is
therefore always **less** than one whole leg. `_rc_unwind`'s `take >= lots`
branch can never fire on a one-leg-per-side book. With the old inconsistent
deltas the aggregate was unrelated to the legs, so it fired by accident.

Both branches are still covered across the set:

- `close_ids`: the shift family (`-atm`, `-otm`, all four relief arms) on the
  rally rows, and `recenter-trend` on all five unwind rows — its `trend_skew`
  budget is `nd + 0.5 x allowed`, wide enough to take a whole leg.
- `close_parts`: `recenter`, `-reshift`, `-crossfill` on all five unwind rows.

Reaching `close_ids` from a plain `recenter` unwind would need a book with two or
more legs on the stack side, which `_sold_book` does not build.

## Concerns (delta to the original list)

1. Size is unchanged at 8.1 MB — the earlier note stands.
2. The grid's net-delta values no longer match the brief's. That is not
   discretionary: the brief's values are unbuildable on a physically consistent
   book, and the generator now proves it by refusing them. Every change is
   recorded in the row's own `note` alongside the original number.
3. Concern 2 from the original report ("the grid is a coverage grid, not a
   physical one" / "some rows carry more net delta than the book has shares") is
   now **resolved** — that was this defect.
