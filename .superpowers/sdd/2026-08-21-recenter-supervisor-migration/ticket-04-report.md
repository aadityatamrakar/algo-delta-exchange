# Ticket 04 — Corridor math (`corridor.ts`) — plan Task 6

**Status:** COMPLETE_WITH_COORDINATION_NOTES
**Branch:** `worktree-agent-adeb00d1cd018f545` (worktree, forked from `recenter-migration` @ `a0d260e1`)
**Commit:** `603ac72e` — `feat(engine): the corridor — band, floor, √dte shrink, and an honest hasGreeks flag`
**Files:** `packages/desk-engine/src/corridor.ts` (new, 337 lines), `packages/desk-engine/test/corridor.test.ts` (new, 27 tests), `packages/desk-engine/src/index.ts` (+2: export + the package-map entry)

---

## 1. What shipped

```ts
export interface Corridor {
  readonly allowed: number; readonly netDelta: number; readonly netGamma: number;
  readonly hasGreeks: boolean; readonly floorRef: number; readonly excess: number;
}
export function corridor(inputs: EngineInputs, dials: Dials): Corridor;
export function steeringPopulation(legs: ReadonlyArray<LegView>, shortsOnly: boolean): ReadonlyArray<LegView>;
// added beyond the brief — see §4:
export function nearestStrike(chain: ChainSnap, x: number): number;
export function otmSellStrike(chain: ChainSnap, atm: number, optType: OptType, spot: number, strikesOut: number): number;
```

The brief's interface is reproduced exactly, with `readonly` added on the `Corridor` fields
to match the house style of `types.ts` (assignment-compatible either way).

`apps/api` is not imported anywhere in this ticket — the mandatory `Side`-vs-`ExitSide`
rule was never in reach. The corridor touches `marking.ts`, `dials.ts` and `types.ts` only.

## 2. Transliteration, with the citations that matter

| Semantics | Python | TS |
|---|---|---|
| population by `gamma_shorts_only` | `_net_gamma_for` `playbooks.py:2957-2980` | `steeringPopulation(legs, dials.gamma_shorts_only)` |
| population by `delta_shorts_only` | `_net_delta_for` `:2983-3013` | `steeringPopulation(legs, dials.delta_shorts_only)` |
| protected qty counted | `conditions.py:51-85` (`is_protected`: counted in measurement, exempt from spending) | `inputs.protectedQty` never read |
| band | `allowed = abs(ng) * tol * spot` `:4060` | `measured` |
| √dte shrink | `:3535-3549`, guard `ref > 0 and 0 < dte < ref` | same, `Math.trunc(tol_ref_dte)` |
| `min_band_lots` clamp | `:4058-4061` | `mbl > 0 ? max(measured, mbl*lotSize) : measured` |
| `no_band_floor` | `:4059`, `:4119` — does **not** touch `allowed` | not applied here; caller's floor test |
| `netΓ == 0.0` sentinel | `:4063-4073` | **deleted**, replaced by `hasGreeks` |
| shed-candidate scan | `_shed_candidates` `:2683-2712`, `_otm_sell_strike` `:2666-2680`, `nearest_strike` `actions.py:176-188` | `floorCandidates` (private) on exported `otmSellStrike`/`nearestStrike` |
| `floorRef` | `:4111-4116` | `min(dps)*lotSize` when `scan > 0 && cands`, else `lotSize` |
| shed side | `side = "CE" if nd > 0 else "PE"` `:4102` | same (netΔ 0 → PE, as Python) |
| `excess` | `abs(nd) - allowed` `:4118` | same |
| lot size | first SHORT leg with one, else 1.0 `:3929` | first SHORT leg with `lotSize > 0`, else **`chain.lotSize`** |

### The sign rule (the load-bearing one)

Python's marked legs carried `raw_greek × sign × shares` already folded in
(`optimizer/legs.py:75-102`), so its nets were plain sums. `LegView.delta`/`gamma` are
UNSIGNED per-share magnitudes, so this file re-applies both factors — and they are **not
the same factor**:

```
delta contribution = wingSign(optType) × positionSign(side) × |δ| × lots × lotSize
gamma contribution =                     positionSign(side) ×  γ  × lots × lotSize
```

Gamma has no wing (a call and a put at the same strike carry the same positive
convexity), which is why a short CE and a short PE cancel in delta and *add* in gamma.
Three tests pin exactly this, because both mistakes are silent: fold the wing into gamma
and a strangle reads as flat convexity; drop the position sign from delta and a hedged
book reads as naked.

**No conflict with any brief test value** (the "Before You Begin" check): every pinned
number — allowed 6000, excess −5100 / +3000, tol×0.5, max(measured, 50), floorRef =
lotSize — is composition-independent, and the books I built to hit them are signed-sum
consistent. Nothing needed clarifying, so I did not raise NEEDS_CONTEXT.

## 3. Decisions I made that the brief left open

1. **`hasGreeks` reads the UNION of both populations.** The brief says "any leg in the
   population"; there are two populations (the dials are independent). A hole in the
   delta sum and a hole in the gamma sum both poison the corridor, so
   `hasGreeks = every(deltaPop) && every(gammaPop)`. Tested three ways, including the
   discriminating case: an unmarked LONG leg with both `*_shorts_only` dials on leaves
   `hasGreeks: true`, and flipping either dial off flips it to `false`.
2. **An empty population is `hasGreeks: true`.** Nothing was missed; there is simply
   nothing there. A flat book measures 0/0/0 and the flat-book hold stays with the caller
   (`playbooks.py:3905-3906`), which is where Python puts it. Safe because `excess` is
   then 0 and phase R fires on `excess > 0`.
3. **`spot <= 0` is NOT guarded here.** At spot 0 the band is 0 and the whole netΔ reads
   as excess — a flatten nobody asked for. Python holds at `:3912-3913`, in the phase, and
   the brief's `Corridor` has no field to report it, so the guard stays with the caller.
   Documented in the header so it cannot be forgotten in Task 7/8/10.
4. **`lotSize` falls back to `chain.lotSize`, not Python's `1.0`.** Python's fallback is
   unreachable (recenter has already held on an empty shorts list); a lot of 1 here would
   make `floorRef` a single share and turn every convexity hold into a shed. Cannot
   diverge on any fixture where a short leg carries a lot size. Tested both ways.
5. **`delta_tol_pct` is not clamped at 0.** A negative dial gives a negative band and
   reads every book as breached — Python behaves identically, and range-checking is the
   dial resolver's job. Coercing it here would hide an operator's typo behind arithmetic
   that silently kept working. Documented inline, not tested (nonsense input).
6. **Python's `0.30` fallback in the scan-off branch (`:4109`) is deleted.** It never
   reached `floor_ref` (scan-off falls back to the whole lot regardless), so this is a
   deletion with no behavioural surface. Asserted negatively in the
   "scan finds nothing" test alongside the whole-lot fallback.

## 4. COORDINATION NOTE for the controller — tickets 05 (Task 7) and 06 (Task 8)

`floorRef` cannot be computed without the shed-candidate scan, but the scan is assigned
to Task 8 (`shedCandidates`) and `otmSellStrike` is named in Task 7's transliteration
table. Task 6 lands first, so I resolved it as:

- **`nearestStrike` and `otmSellStrike` are EXPORTED from `corridor.ts`.** They are pure
  strike-ladder geometry with no dial semantics, and the 8-step bounded push with its
  edge-of-chain behaviour is not a thing to write twice. **Tasks 7 and 8 must IMPORT
  them, not redefine them** — a redefinition is a duplicate-export TS error through
  `index.ts`'s `export *`, i.e. a loud failure rather than a silent divergence.
- **The candidate walk itself is PRIVATE** (`floorCandidates`, returns magnitudes only).
  I deliberately did not pre-empt Task 8's `shedCandidates` contract, which keeps the
  strikes and gains a liquidity gate in `phaseShed`. Task 8 should build it on the same
  exported `otmSellStrike` and may fold `floorCandidates` into itself; the dedup +
  `dps > 0` filter is ~8 lines duplicated until it does.

Also worth carrying into Task 7: `recenter_shift` anchors the scan on
`nearest_strike(spot)` (`:3931`), while `recenter`'s own shed anchors on the gk-anchor
EMA (`:3636`). `otmSellStrike` therefore takes `atm` as a parameter and `spot` separately
— an anchored strike can never be sold ITM. The corridor passes `nearestStrike(spot)`.

One transliteration asymmetry the migration unifies (flagging it so nobody "fixes" it
back): `recenter_shift` — the function this ticket ports — does **not** apply the
`tol_ref_dte` √dte shrink; only `recenter` does (`:3547`). The brief directs the corridor
to apply it, so the unified engine shrinks on every path. `DEFAULT_DIALS` has
`tol_ref_dte: 0` (off), so the relief-r live set is unaffected; `DEFAULTS["recenter"]`
carries `tol_ref_dte: 20`, so any preset that inherits it now shrinks in a place Python's
shift path did not. **Parity fixtures from the shift family will show this if a board ever
set both `tol_ref_dte` and the shift dials.**

## 5. Tests — 27, all hand-derived

`packages/desk-engine/test/corridor.test.ts`

| Block | Tests | Pinned numbers |
|---|---|---|
| `steeringPopulation` | 1 | whole book vs shorts |
| sign rule | 3 | long CE cancels short CE (netΔ 0); short CE cancels short PE (netΔ 0, netΓ −2000); a long wing halves the band (netΓ −1000 → −500, allowed 6000 → 3000) |
| the band | 4 | `abs(netΓ) 1000 × 0.02 × 300 = 6000`; netΔ +900 → excess −5100; netΔ +9000 → excess +3000; symmetric on a short-CE book |
| √dte | 3 | dte 5 / ref 20 → tol ×0.5 → allowed 3000, excess 6000; dte 20 and 45 → 6000 (never widens); dte 0 and ref 0 → off |
| band floor | 3 | measured 0.15, `min_band_lots 2` × lot 25 → allowed 50; measured 150 > 50 wins; `no_band_floor` leaves all six numbers identical |
| `hasGreeks` | 3 | unmarked short poisons it; unmarked LONG does not under shorts-only, does under either dial off; **netΓ exactly 0.0 with every leg marked → `true`** (the sentinel replacement) |
| `floorRef` | 5 | **the TCS/VEDL hold**: netΓ −2.0, netΔ +483, lot 225, spot 2300 → allowed **92**, floorRef **225**, excess **391**, `allowed < floorRef`; `min_band_lots 2` lifts allowed to 450 over the floor; scan 3 → finest lot = CE 330 = 0.2874 (hand: `d1 = −2.2732`, `δ = e^{-rt}N(d1) = 0.011496`, ×25) and strictly below the CE 310 lot; PE ladder on a negative netΔ → PE 270 = 0.1318; a scan that finds nothing → whole lot, never `0.30 × lot` |
| deliberate non-behaviour | 2 | protectedQty leaves the corridor byte-identical; a flat book is 0/0/0 with `hasGreeks: true` |
| strike ladder | 3 | `nearestStrike` snaps to real strikes / rounds on the step / clamps at the chain edge; `otmSellStrike` pushes off an on-spot snap; stops at the edge rather than looping |

Two greek assertions are relative (`< 1e-4`) rather than absolute: chain greeks come back
through an IV **solve** off the mid, and on a 0.011-delta strike the solver's residual is
~1.5e-5 relative — larger than any absolute epsilon worth writing. The hand-derived
values are asserted separately at ±5e-4.

## 6. Verification

```
npx tsc -p tsconfig.json                          → clean (exit 0)
node --test packages/desk-engine/test/*.test.ts   → 90 tests, 90 pass, 0 fail
npm run test:node                                 → 2947 tests, 2946 pass, 1 fail
npm run test:web                                  → 29 files, 520 tests, all pass
```

The one node failure is **pre-existing and unrelated**:
`apps/api/test/service.integration.test.ts:153` — "a PARTIALLY marked book names only the
missing legs". Verified by `git stash -u` → same single failure on the untouched base
(`apps/api` contains no reference to `@algomaker/desk-engine` at all).

## 7. Concerns for review

1. **The `tol_ref_dte` unification** (§4). Real behavioural delta against Python's shift
   path, directed by the brief, invisible on the default dials. Worth a controller ruling.
2. **`hasGreeks` on the union of two populations** — my reading of a brief sentence that
   says "the population" (singular) where two exist. If the intended reading is the gamma
   population alone (it is the gamma sentinel being replaced), the change is one `&&`.
3. **`floorCandidates` will be duplicated by Task 8** until someone folds it in (§4).
4. **Futures legs have no representation.** Python's net delta includes future legs
   (`delta = sign × shares`, gamma 0, `book.py:223`); `LegView` has no instrument
   discriminator, so the engine's book is options-only by construction. Noted in the
   header. If a desk book ever holds a future under a recenter tag, its delta is
   currently invisible to the corridor.
