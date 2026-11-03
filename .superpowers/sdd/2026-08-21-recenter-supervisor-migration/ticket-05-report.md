# Ticket 05 — Phase R shed core (`shed.ts`) — plan Task 8

**Status:** COMPLETE_WITH_COORDINATION_NOTES
**Branch:** `worktree-agent-a4e7f7b3680da05b5` (worktree, forked from `recenter-migration` @ `55519fa5`)
**Commits:**
- `e4d5e852` — `feat(engine): phase R sheds to best-fit real greeks with a liquidity-gated candidate scan`
- `7f6a8324` — `fix(engine): a phase-R hold names the strike and the size it is holding on` (self-review round)

**Files:**
- `packages/desk-engine/src/shed.ts` (new, ~445 lines)
- `packages/desk-engine/src/ladder.ts` (new, 95 lines — the fold; see §3)
- `packages/desk-engine/test/shed.test.ts` (new, 23 tests)
- `packages/desk-engine/src/corridor.ts` (−101 lines net: `floorCandidates` deleted, geometry moved out, header §5 rewritten)
- `packages/desk-engine/src/index.ts` (+2 exports, +2 package-map entries)
- `packages/desk-engine/test/corridor.test.ts` — **untouched and green** (`git diff` empty)

---

## 1. What shipped

```ts
export interface ShedCandidate { readonly strike: number; readonly dps: number }
export interface ShedResult { readonly actions: EngineAction[]; readonly reason: string; readonly sheddable: boolean }

export function shedCandidates(chain: ChainSnap, side: OptType, spot: number, scan: number,
                               dateIst: string, minuteOfDay: number): ReadonlyArray<ShedCandidate>;
export function bestFit(cands: ReadonlyArray<ShedCandidate>, excess: number,
                        lotSize: number): { strike: number; lots: number } | null;
export function phaseShed(inputs: EngineInputs, dials: Dials, state: RuleState, cor: Corridor): ShedResult;

// ladder.ts — MOVED from corridor.ts, definitions unchanged:
export function nearestStrike(chain: ChainSnap, x: number): number;
export function otmSellStrike(chain: ChainSnap, atm: number, optType: OptType, spot: number, strikesOut: number): number;
// ladder.ts — new, folded out of corridor.ts:
export function sellLotSize(legs: ReadonlyArray<LegView>, chain: ChainSnap): number;
```

The brief's three signatures are reproduced exactly; the anonymous
`{ strike; dps }` is given a name (`ShedCandidate`) and `readonly` is added on
the result fields, matching `Corridor`'s house style from ticket 04. Both are
assignment-compatible either way — the tests pass plain object literals.

## 2. Transliteration, with the citations

| Semantics | Python | TS |
|---|---|---|
| candidate walk, nearest-first, dedup | `_shed_candidates` `:2683-2712` | `shedCandidates` |
| OTM push / snap | `_otm_sell_strike` `:2666-2680`, `nearest_strike` `actions.py:176-188` | `ladder.ts` (moved verbatim) |
| `dps = abs(sd) if sd else 0.30` | `:3711`, `:4109`, `:4857`, `:2822` | **DELETED** — unsolvable strike is not a candidate |
| best FIT, ties to nearer | `:4127-4141` (`min` keeps the first) | `bestFit`, strict `<` over a nearest-first list |
| sizing: plain round, never `max(1,…)` | `:3710-3715` | `Math.round`, `lots <= 0 → skip` |
| shed side `nd > 0 → CE` | `:4102` (netΔ 0 takes PE) | same |
| convexity floor + conditional wording | `:4111-4125` | `!bandDials && allowed < floorRef` |
| `netΓ == 0.0` sentinel | `:4063-4073` | **DELETED** → `!cor.hasGreeks`, unconditional |
| inside-band / dte holds | `:4126`, `:4128-4129` | same order |
| scan-off single candidate | `:4106-4109` | `fixedCandidate` (minus the `0.30`) |
| "nothing to sell" names the strike | `:4143-4145` | `where` (fixed in `7f6a8324`) |
| flat book / `spot <= 0` | `:3905-3913` | guards at the top of `phaseShed` |
| candidacy liquidity gate | **none** | NEW, design spec §6, `'live'` only |

### The hand-computed values

The 21-strike ladder is 200…400 by 10 around spot 300, quoted at the Black-76
price at vol 0.30 with 7 days to run, so every strike solves back to that vol.
Hand-derived and verified against `b76Greeks` to 5 s.f.:

| strike | `d1` | δ = e^{-rt}·N(d1) | per lot (25) |
|---|---|---|---|
| 310 CE | −0.76842 | 0.220826 | 5.5213 |
| 320 CE | −1.53268 | 0.062601 | 1.5655 |
| 330 CE | −2.27338 | 0.011489 | 0.28727 |

The book every phase test sheds: one short PE, 4 × 25 shares, δ 0.9, Γ 0.1 →
netΔ +90, netΓ −10, `allowed` 10 × 0.02 × 300 = 60, **excess 30**. Against the
three candidates: 5 lots of 310 (miss 2.394), 19 of 320 (miss 0.256), **104 of
330 (miss 0.123)** — the furthest wins, which is the entire point of the
outward scan.

`bestFit`'s own unit case is the brief's, and it turned out to be a better test
than it looks: with dps {0.30, 0.18, 0.12}, excess 750, lot 25, the 0.30 strike
lands 100 lots × 7.5 = 750 **exactly** and the 0.12 strike 250 × 3.0 = 750
**exactly** — a genuine tie, which the nearest-first + strict-`<` rule breaks
toward the nearer strike. A second case (excess 790 → 263 lots of 0.12, miss
1.0) proves the furthest strike can win outright.

## 3. The fold, and the cycle it would have created

`corridor.ts`'s `floorCandidates` is deleted; `corridor` now calls
`shedCandidates` directly. That is not cosmetic: `floorRef` is *defined* as
"the finest lot among the strikes phase R would actually sell", so two walks
that drifted apart would make the convexity floor stop meaning what phase R
thinks it means, silently. **Proved by mutation**: doubling `dps` inside
`shedCandidates` fails 2 corridor tests.

The naive fold is a cycle — `corridor` needs `shedCandidates`, `shed` needs
`otmSellStrike`. ESM tolerates it (hoisted declarations, no top-level calls)
and a reader should not have to know that. So the shared strike geometry moved
down into a new **`ladder.ts`**, and the graph is now `ladder ← shed ←
corridor`, acyclic. This is the "moved to a shared spot within the package"
option the controller offered; `shedCandidates` itself stayed in `shed.ts`
exactly as the brief specifies.

`sellLotSize` was folded out for the same reason and is a second duplication
removed rather than added: `floorRef` is a delta-per-LOT and the sizing that
compares against it is a lot count, so the corridor and phase R reading
different lots is a silent failure by construction.

The loud-failure property is preserved: one definition of each name, all
re-exported through `index.ts`'s `export *`, so a phase that redeclares
`otmSellStrike` or `sellLotSize` is a duplicate-export TS error.

**No cycle I could not break cleanly, so no NEEDS_CONTEXT was raised.**

## 4. Decisions the brief left open

1. **`sheddable` has one sharp meaning, and it is not "did anything happen".**
   It is `false` iff phase R passed every hold gate and still could not put its
   sale on a book it would cross — the gate refused every candidate, or no
   candidate priced at all. Every hold decided by the *book's own numbers*
   (flat, no spot, unmarked greeks, inside the band, under the floor, near
   expiry, **or a sub-one-lot excess**) stays `true`. The sub-one-lot case is
   the discriminating one and is tested: routing a maker quote there would mean
   rounding up to one lot, which is exactly the `max(1, …)` the desk deleted.
2. **`actions` carries the intended sell even when `sheddable: false`.** Task
   15 says the host "routes the intended sell" passively at theoretical, so it
   needs a strike and a size; suppressing the action would produce the silent
   hold spec §6 forbids. The hazard is the mirror image — a caller that ignores
   the flag crosses a book the gate refused — and it is called out in the file
   header. `actions` is empty only when no strike priced at all, where there is
   nothing to quote either.
3. **`!hasGreeks` holds unconditionally**, where Python's `ng == 0.0` sentinel
   only fired under the band dials (`:4063-4073`). A hole in the marks poisons
   `netDelta` and `allowed` alike. Python held on every path anyway (with the
   floor supplying the hold when the dials were off), so this is a reason-string
   difference, not a decision difference — *except* for a genuinely flat-gamma
   book with every leg marked and `min_band_lots`/`no_band_floor` set, which
   Python held and this sheds. That is the deliberate deletion, not a bug.
4. **Spread is measured against the MID** (`(ask − bid) / mid`). The spec says
   only "spread ≤ `sell_max_spread_pct`". Mid is the conventional denominator
   and is the one that does not move with which side you are on. Flagged in §7.
5. **The gate dials have no silent off-switch.** `sell_max_spread_pct` and
   `quote_max_age_ms` are *not* in `dials.ts` §5's list of numeric off-states,
   so a non-positive value is read as "a gate nothing can pass" rather than
   "gate off". The failure directions are asymmetric: gate-off crosses any book
   at all, silently; gate-impossible routes to a maker quote and names the dial.
6. **A quote stamped in the future passes the age gate** (negative age). That is
   a clock problem, not a stale book; feed death is `md.health`'s to catch.
7. **`state` is accepted and unread** (`void state`). Task 9 composes the tiers
   that read it into this same function.

## 5. Tests — 23 new, all hand-derived, all mutation-checked

`packages/desk-engine/test/shed.test.ts`

| Block | Tests | Pinned |
|---|---|---|
| `bestFit` | 4 | the brief's tie → nearer strike, 100 lots; excess 790 → furthest, 263 lots; sub-one-lot → `null` (both single- and all-candidate); refuses `excess ≤ 0`, `lotSize 0`, `dps 0`, empty |
| `shedCandidates` | 4 | `[310,320,330]` with dps 0.220826/0.062601/0.011489; PE ladder `[290,280,270]`; unsolvable strike excluded and never `0.30`; coarse-grid dedup → `[320]`; scan 0 → `[]` |
| the sale | 5 | 104 × 330CE; PE book → 227 × 270PE; scan off → 19 × 320CE; sub-one-lot holds and names the strike and the 0.1 |
| the gate | 5 | wide 330 → 19 × 320CE in live, **unchanged 104 × 330CE in parity**; stale 330 → same; all wide → `sheddable:false` **with** the 104-lot action; nothing prices → `false` with **no** action; `quote_max_age_ms: 0` → false, dial named exactly once |
| the holds | 5 | the TCS/VEDL floor (netΓ −2.0, allowance 92 vs a 225 lot) and both band-dial escapes; inside band; `dte ≤ min_sell_dte`; unmarked book; flat book + spot 0 |
| the fold | 1 | `corridor.floorRef === min(dps) × lot` over exactly this candidate set |

**Mutation-checked** (each mutation applied to `shed.ts`, suite run, reverted):

| Mutation | Tests failed |
|---|---|
| `max(1, round(…))` instead of plain round | 3 |
| tie-break `<=` (to the further strike) | 1 |
| gate applied in parity too | 1 |
| floor test ignores the band dials | 1 |
| gated sale suppressed instead of quoted | 2 |
| sizing off the liquid set only when all are gated | 2 |
| `dps × 2` inside `shedCandidates` | 2 **corridor** tests (proves the fold) |

## 6. Verification

```
npx tsc -p tsconfig.json                          → clean (exit 0)
node --test packages/desk-engine/test/*.test.ts   → 113 tests, 113 pass, 0 fail
npm run test:node                                 → 3066 tests, 3065 pass, 1 fail
npm run test:web / typecheck --workspace web      → BLOCKED, environment (see below)
```

Two failures, both proved pre-existing by `git stash -u` on this worktree:

1. `apps/api/test/service.integration.test.ts:153` — "a PARTIALLY marked book
   names only the missing legs". Fails identically on the untouched base.
   (Ticket 04's report called this unrelated because `apps/api` did not import
   `@algomaker/desk-engine`; ticket 09 has since added imports, so the stash
   proof is what carries the claim now, not the absence of an import.)
2. `apps/web` typecheck / `test:web` — `vite.config.ts(2,19): Cannot find module
   '@vitejs/plugin-react'`. The web workspace's dev dependencies are not
   installed in this worktree; fails identically stashed. Nothing in this ticket
   touches `apps/web`.

## 7. Concerns for review

1. **Best-fit is systematically biased to the OUTERMOST scanned strike.** A
   finer lot almost always produces a smaller residual, so with `shed_scan_
   strikes: 3` the engine will nearly always sell the 3rd strike out — the
   thinnest of the three. This is faithful to Python (`:4127-4141`) and the cap
   of 3 is the stated safety, but the migration's new liquidity gate is now the
   thing standing between that bias and a bad fill, which makes
   `sell_max_spread_pct` load-bearing in a way it was not designed to be.
   Worth an operator eye before the first live phase-R session.
2. **`otmSellStrike` can return a NON-OTM strike at the edge of the chain**
   (documented in `ladder.ts`, inherited from `:2666-2680`), and neither
   `shedCandidates` nor `phaseShed` re-checks. On a chain with nothing above
   spot, the "shed" could sell an ITM call — synthetic stock, not a hedge. I did
   **not** add the guard: it would change `corridor.floorRef` in the same edge
   case and it is a second un-directed gate on top of the liquidity one. Flagged
   as a follow-up rather than fixed.
3. **The spread denominator** (§4.4) is my reading, not the spec's words.
4. **The inside-band reason cannot state the effective `tol`.** `corridor`
   applies the √dte shrink internally and does not return the shrunk value, so
   the reason says `(|netΓ| X at spot Y)` where Python said
   `(|netΓ| X × tol% × spot Y)`. Printing `dials.delta_tol_pct` instead would be
   an actively wrong number whenever `tol_ref_dte` is on. **Cheapest fix: add a
   `tol` field to `Corridor`** — a corridor-owner call, not mine.
5. **`sheddable: false` with empty `actions`** (no strike priced at all) is
   inert for Task 15 — there is nothing to quote and no IV to quote at. It is
   loud in the reason and in the flag, which is the best this layer can do, but
   Task 15 should not assume `actions` is non-empty on a `false`.
6. **The spec's step-8 sell gate is NOT here** — `min_sell_delta`, `min_sell_px`,
   the scrap re-sell ban, and the margin-cap projection all strip or downsize
   this phase's Sell open. That is the composer's (Task 11), and phase R's
   output is a *proposal*, not a routable order.

## 8. Handoff

- **Task 7 (phase S):** **no change needed** — `import { nearestStrike,
  otmSellStrike } from './corridor.ts'` still compiles (see §9); the package
  root works too. `sellLotSize(legs, chain)` is available from both if the
  shift needs a lot.
- **Task 9 (tiers):** `phaseShed` already takes `state`; the tiers compose into
  it. The gk-anchor arm sheds off an EMA anchor (`:3636`) rather than
  `nearestStrike(spot)`, and `shedCandidates`' brief-pinned signature has no
  `atm` parameter — that arm needs one added (`otmSellStrike` already takes
  `atm` and `spot` separately, so nothing else has to change).
- **Task 11 (composer):** phase R owns only its own holds. The session gate,
  expiry settle, repair hold, guard tiers, working-package hold, scrap tier,
  sell gate and margin projection are all yours, and `cor` must be the
  POST-shift corridor when phase S fired.
- **Task 15 (supervisor):** route on `sheddable === false && actions.length > 0`
  → maker quote at Black-76 theoretical, passive, alert. `sheddable === false &&
  actions.length === 0` means the chain priced nothing; there is nothing to
  quote, and the reason says so.

---

## 9. Post-review fix — `corridor.ts` re-exports the ladder geometry

**Commit:** `fe8465d3` — `fix(engine): corridor keeps answering for the strike
geometry it no longer defines`

**The defect.** Moving `nearestStrike`/`otmSellStrike` into `ladder.ts` (§3) was
invisible to anything importing from the package root, which is all this
ticket's tree does — so nothing here caught it. But the standing directive to
the phase tickets was to import them **from `./corridor.ts` by name**, and the
parallel phase-S ticket did exactly that (`shift.ts:103`). Its branch is
complete and pending merge; the reviewer confirmed TS2305 empirically once both
branches share a tree. My branch compiled clean and would still have broken the
merge.

**The fix**, one line in `corridor.ts` beside its imports:

```ts
// The phase implementations were directed to import the strike geometry from
// THIS module, so it keeps answering to that name after the move to
// `ladder.ts` — same single definitions, re-exported, no cycle (`ladder.ts`
// imports nothing from here).
export { nearestStrike, otmSellStrike, sellLotSize } from './ladder.ts';
```

Zero behaviour change, and both invariants survive:

- **No second definition.** It is a re-export, so `ladder.ts` still holds the
  only copy of each name and the duplicate-export failure that guards against
  two ladders drifting apart is intact.
- **No cycle.** `ladder.ts` imports nothing from `corridor.ts`; the graph is
  still `ladder ← shed ← corridor`.
- **No ambiguity through `index.ts`.** It star-exports both `./ladder.ts` and
  `./corridor.ts`, and the two paths now carry the same three names — but they
  resolve to the *same* declarations, so this is not an ambiguous star export.
  Verified by `tsc` and by loading the index at runtime (all seven exports
  resolve to functions).

**Proved rather than assumed.** I reproduced the phase-S contract in a throwaway
`src/probe-shift.ts` importing all three names from `./corridor.ts` and using
them; `tsc -p tsconfig.json` exits 0 (TS2305 would have fired). Probe deleted.

**Verification after the fix**

```
npx tsc -p tsconfig.json                          → clean (exit 0)
node --test packages/desk-engine/test/*.test.ts   → 113 tests, 113 pass, 0 fail
node --test 'apps/api/test/**/*.test.ts'          → 1348 tests, 1347 pass, 1 fail (the known one)
npm run test:node                                 → 3066 tests, 3065 pass, 1 fail   [x2]
```

**One thing the coordinator should know, unrelated to this ticket.** Two
intermediate full-suite runs on this machine reported **21** and then **47**
failures, all of them `apps/api` Mongo-backed integration tests, with **no code
change between runs**. Re-running gave 1 failure twice, `apps/api` alone gives 1
failure, and the untouched base `55519fa5` gives 1 failure. The bad runs
happened while several heavy suites were running back to back, so `apps/api`'s
integration suite is **load-flaky in this environment** — it is not a signal
about this branch, but it will make any full-suite gate unreliable under
parallel CI and is worth a ticket of its own.
