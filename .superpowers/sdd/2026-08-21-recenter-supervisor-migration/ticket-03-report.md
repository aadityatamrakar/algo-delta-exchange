# Ticket 03 — Two-sided marking & greeks (`packages/desk-engine/src/marking.ts`)

**Branch:** `worktree-agent-aaf2b5196e65280e6` (off `recenter-migration`)
**Commits:** `7bf3f43a` (feature), `06854cd9` (self-review fixes)
**Status:** Complete. 28 new tests, full workspace suite green, typecheck clean.

---

## 1. What was implemented

`packages/desk-engine/src/marking.ts`, exported from `src/index.ts`. Every
signature is verbatim from the brief; `LegPosition` is a named interface for
the brief's inline leg-object type (structurally identical, and it makes
`markLeg(existingLegView, …)` re-marking work for free, since `LegView` already
carries all eight fields).

| Export | Behaviour |
|---|---|
| `RISK_FREE` | `0.065`, `pricing.py:16` exactly |
| `midOf(q)` | two-sided → mid; else `ltp`; else `null` |
| `exitPrice(q, side)` | `Sell` → `ask`, `Buy` → `bid`; `null` when absent — **no LTP fallback** |
| `markPrice(q, pricing, side)` | `parity` → `midOf` (side ignored); `live` → `exitPrice` |
| `yearFrac(dateIst, expiry, minuteOfDay)` | calendar days / 365; intraday refinement **only** on the expiry day, floored at 5 min; past expiry 0; malformed date 0 |
| `markLeg(leg, q, chain, dateIst, minuteOfDay, pricing)` | full `LegView` |
| `strikeGreeks(chain, strike, optType, dateIst, minuteOfDay)` | `{delta, gamma}` or `null` — **never 0.30** |

Design decisions worth flagging to the next ticket:

- **Value and greeks are independent.** `mtm` comes off `markPrice` (exit side
  in live), the greek set off `midOf`. A deep-ITM short quoted at intrinsic is
  perfectly valued with no solvable IV, and neither result suppresses the
  other. Pinned by a test.
- **IV is always solved off the mid, in both pricing modes.** Solving off the
  exit side would tilt every delta by half a spread and make a short book's
  greeks disagree with a long book's on the same contract. Matches spec §6's
  "IV solve + all greeks → mid".
- **Sign conventions differ between the two greek paths, deliberately**, and
  the file header states both:
  - `LegView.delta` is an **unsigned magnitude**, as `types.ts` specifies
    ("per-share, unsigned magnitude with sign applied by consumers"). Nothing
    is lost: the full signed contribution is
    `(optType === 'CE' ? +1 : -1) * (side === 'Sell' ? -1 : +1) * delta * lots * lotSize`,
    and both factors are on the `LegView`. The formula is in the header and the
    identity `putδ + callδ = e^{-rt}` is asserted in a test.
  - `strikeGreeks` returns the **raw Black-76 delta, signed by wing**
    (CE ≥ 0, PE ≤ 0), because it replaces reading a chain row — and the Python
    chain rows the Ticket-02 parity fixtures were generated from are signed
    that way (`test/fixtures/decisions/recenter-atm.json`:
    `"PE": {"delta": -0.02}`). Sizing callers take `Math.abs`, exactly as
    Python's `abs(sd)` did.
- **Unpriced ≠ zero.** `markLeg` on a never-quoted contract returns `mtm: 0`
  and copies the failed pair into `exit`; the caller distinguishes the two by
  re-running `markPrice(view.exit, pricing, view.side)` and checking for
  `null`. Spec §6 has the action pass HOLD on such a leg.
- **One Black-76 call site.** Both public greek paths route through a private
  `solveGreeks`, so a leg's greeks and a candidate strike's greeks can never be
  computed at different rates, forwards or tenors.
- **Not ported:** Python's per-symbol `session_close_min` registry — every book
  this engine manages is NSE equity/F&O, so `SESSION_CLOSE_MIN` (15:30) from
  `session.ts` is the single close.

## 2. Greeks package API — matches the brief

Verified before starting, as instructed. `packages/greeks/src/black76.ts`
exports `b76Price`, `b76Greeks(i: B76Inputs): B76Greeks` and
`b76ImpliedVol(price, Omit<B76Inputs,'vol'>, opts?): number | null` — exactly
the brief's assumption, and `OptionType` is `'CE' | 'PE'`, identical to
`OptType`. **No NEEDS_CONTEXT.** Two useful properties that the null-not-0.30
rule leans on: `b76ImpliedVol` already returns `null` for a quote at/under
discounted intrinsic *and* for one above the model price at the 500%-vol
ceiling (its `solves()` repricing residual), so `strikeGreeks` inherits both
refusals rather than reimplementing them.

## 3. TDD evidence

**RED** — `test/marking.test.ts` written first, run before `src/marking.ts`
existed:

```
SyntaxError: The requested module '@algomaker/desk-engine' does not provide an
export named 'RISK_FREE'
  ℹ tests 1  ℹ pass 0  ℹ fail 1
```

**GREEN** — after implementing `src/marking.ts` and wiring `index.ts`:

```
ℹ tests 26  ℹ pass 26  ℹ fail 0
```

**GREEN after self-review** (two tests added):

```
ℹ tests 28  ℹ pass 28  ℹ fail 0
```

### Numbers the tests pin

Every one is hand-derived, not snapshotted from the implementation:

- `midOf({bid:100, ask:102, ltp:95})` → `101`; ltp-only → `95`; empty → `null`.
- **The brief's mode-difference case.** Sell 2 lots × 25 shares, entry 10,
  book `{bid 8, ask 9}`: `parity` → mid 8.5 → `+75`; `live` → ask 9 → `+50`.
  Long side: `live` → bid 8 → `-100`.
- `yearFrac('2026-08-21','2026-08-28', m)` → `7/365` for both `m=600` and
  `m=920` (a pre-expiry tenor must not shorten as the day wears on).
- `yearFrac('2026-08-28','2026-08-28',600)` → `330/1440/365`; at 930 and 1000
  → the `5/1440/365` floor.
- **Independent Black-76 check** (this is what proves `F`, `r` and `t` are
  wired right, and it is the assertion that would fail if any of the three were
  swapped). ATM 2400, `t = 7/365`, `σ = 0.30`, `r = 0.065`:
  `σ√t = 0.0415455`, `d1 = 0.0207727`, `e^{-rt} = 0.9987542`.
  - call δ `= e^{-rt}N(d1) = 0.9987542 × 0.5082865 = 0.50765` — asserted
    `|δ − 0.5077| < 5e-4`
  - put |δ| `= e^{-rt}N(−d1) = 0.49110` — asserted `|δ − 0.4911| < 5e-4`
  - γ `= e^{-rt}φ(d1)/(Fσ√t) = 0.9987542 × 0.3988563 / 99.7092 = 0.0039952` —
    asserted `|γ − 0.0039952| < 2e-5`
  - solved IV round-trips to `0.30` within `1e-4`
- Failure paths: 2600 PE against a 2400 future quoted 149/151 is under
  discounted intrinsic (≈199.75) → `hasGreeks: false`, `iv: null`,
  `delta: 0`, `gamma: 0`, and `assert.notEqual(delta, 0.3)`; the same leg with
  entry 160 still marks `+450`. `strikeGreeks` → `null` for an absent strike, a
  wing with no book, and an unsolvable mid.

## 4. Verification run before each commit

| Check | Result |
|---|---|
| `node --test packages/desk-engine/test/marking.test.ts` | 28 pass, 0 fail |
| `npm run test:node` (whole workspace) | **2920 tests, 2694 pass, 0 fail**, 226 skipped |
| `npm run test:web` (vitest/jsdom dashboard) | 29 files, **520 pass, 0 fail** |
| `npm run typecheck` (root + `@algomaker/web`) | clean |

Baseline before the ticket was 35 desk-engine tests / 2918 workspace tests, all
green — so nothing pre-existing was disturbed.

Note: the worktree had no `node_modules`; `npm install` was run once to create
the workspace symlinks (`@algomaker/desk-engine`, `@algomaker/greeks`).
`package-lock.json` was unchanged by it — `git status` after the install showed
only the three source files.

## 5. Self-review findings (all fixed in `06854cd9`)

Reviewed my own diff after the feature commit. Three findings, one of them a
real defect in guidance:

1. **Wrong discriminator in a doc comment (real).** `markLeg`'s doc offered
   `exit.bid === null && exit.ltp === null` as the test for "never quoted". In
   live pricing that is **wrong**: an ltp-only book is equally unpriced while
   its `ltp` is set, so a downstream author following the comment would have
   valued a leg off a stale print — the exact failure the file exists to stop.
   Replaced with "re-run `markPrice(view.exit, pricing, view.side)`", plus an
   explicit do-not.
2. **Undertested documented behaviour.** The `yearFrac` doc claimed a
   not-a-real-day date returns 0, but nothing asserted it. Added two tests:
   `yearFrac` on `'2026-02-31'` / `'2026-13-45'` / `'28-08-2026'` → 0, and a leg
   under a malformed expiry stays **valued** (`mtm 50`) while reporting
   `hasGreeks: false`.
3. **Readability.** `utcDayMs` converted `Number(y)`/`Number(mo)`/`Number(d)`
   twice each across the rollover round-trip; hoisted to three consts.

Also checked and found clean: no export-name collisions across the five
`src/*.ts` files now re-exported by `index.ts`; a zero-bid/zero-ask book marks
a short's full credit correctly and refuses an IV (rather than producing one);
`markLeg` never touches `chain.strikes`, so a leg whose book arrives from a
subscription rather than the chain marks fine.

One test-file ordering quirk worth knowing: `assert.equal(g, null)` from
`node:assert/strict` is a narrowing assertion, so `assert.notEqual(g?.delta,
0.3)` must come **before** it or the line stops typechecking (`Property 'delta'
does not exist on type 'never'`). Caught by `tsc`, noted in the test.

## 6. Concerns / notes for later tickets

- **The delta-sign split is the one thing to re-read before writing the
  corridor.** `LegView.delta` is a magnitude; `strikeGreeks` is signed. Both
  conventions are justified above and stated in the file header, but a corridor
  author who assumes one convention for both will get a `netΔ` that is wrong
  only for puts — a bug that produces plausible numbers. If the corridor ticket
  would rather have signed leg deltas, that is a `types.ts` change, not a
  `marking.ts` one.
- **`chain.spot` is the forward.** `types.ts` documents it as "future mid in
  live mode; Python 'future' close in parity", and `markLeg` uses it as
  Black-76's `F` per the brief. `chain.future` (the future's own `Quote`) is
  therefore **unused** by this layer — whoever populates `ChainSnap` owns
  keeping `spot` equal to `midOf(chain.future)` in live mode. Worth an
  assertion at the ChainView seam, not here (this file is pure).
- **Nothing here reads `asOf`.** Deliberate: spec §6 puts valuation on the
  last-seen pair however old, and the spread/age gates in the *candidacy* path.
  The staleness badge the dashboard renders needs `exit` + `asOf`, both of
  which `LegView` carries.
- `yearFrac` is not memoised (Python has `@lru_cache(maxsize=100_000)`). At
  ~10 legs per tick the regex + `Date.UTC` cost is noise; if the supervisor
  ever marks whole chains per tick, that is the place to revisit.
