# Final fix wave — whole-branch review findings

**Branch:** `worktree-agent-a9f0de69f1e0d5af1` (worktree
`/Users/aaditya/Documents/dev/algomaker/.claude/worktrees/agent-a9f0de69f1e0d5af1`)
**Base:** `43a7a071` (recenter-migration head)
**Status:** all 8 findings fixed, 8 commits, everything green.

| Commit | Finding |
| --- | --- |
| `3b6cf041` | **C-1** gateway live allowlist has no reduce-only exemption |
| `601a1a9c` | **I-1** the `registry` nudge is never sent |
| `3414bbe9` | **I-2** protection-reversal documentation |
| `11d5030b` | **I-3** the missing triple-product test |
| `0df66a50` | **M-3** + **M-4** supervisor deps, `runtime.meta` docstring |
| `2bd188a4` | **M-5** retired-Python docs |
| `ade075ff` | **M-6** dead `BookCreateDialog` + `variants()` client |
| `6a515f8a` | **M-1/M-2** implementation-deviations appendix |

---

## C-1 — the merge blocker

`apps/order-gateway/src/main.ts` gate 2 now reads:

```ts
if (
  !paper &&
  order.desk_op !== 'close' &&
  order.desk_op !== 'resize' &&
  !(await ports.allowsLive(order.tag))
) {
```

**The pass list is exactly what `LiveRail.#exits` can pass, verified by reading
it** (`apps/api/src/rail.ts:671`):

```ts
if (fill.op !== 'close' && fill.op !== 'resize') return false
return Math.sign(traded) === -Math.sign(held) && Math.abs(traded) <= Math.abs(held)
```

So the reviewer's mid-flight correction was right and I implemented the
corrected form:

- **Not `reducesExposure`** — it is `new Set(['close', 'roll', 'resize'])`
  (`queue.ts`), and `#exits` refuses a roll whole. This gate must never be
  looser than the rail's.
- **Not `close` alone** — `#exits` passes a shrinking resize, so a gate tighter
  than the rail re-creates C-1 for every resize: the rail admits it, desk-api
  folds the shrink, this gate refuses, the book is wrong again. A
  `desk_op: 'resize'` reaching this line on a switched-off tag is shrinking by
  construction, because the rail already refused the growing ones using the
  book this process cannot see.

The header comment cites spec §9 ("never an exit") and carries the full C-1
trace: rail passes → doc lands in `desk-gateway-orders` →
`partitionRoutedFills` counts it routed → book folded closed and legs written
back → supervisor settles DONE → gate refuses → nothing un-books a gateway
refusal → desk reads flat against a live position for up to 60s, with
`cumRealized`/`rcStack` permanently wrong. It also names this as a regression
vs master, where `LiveRail` threw before anything was folded.

**Tests** (`apps/order-gateway/test/paper-rail.test.ts`, reusing that file's
existing `desk()` harness), 4 added:

1. a live `desk_op:'close'` with `allowsLive:false` **reaches the live
   adapter**, and the allowlist is not even consulted;
2. a live shrinking `resize` likewise;
3. a live `open` with the same is **still refused** (`INVALID`, reason matches
   `/not switched on for LIVE/`), and the allowlist **is** consulted;
4. `roll`, an unknown op, and an **absent** `desk_op` are all still gated —
   the exemption is a pass list, fail-closed, and `roll` is named explicitly
   because the rail refuses it.

---

## I-1 — the `registry` nudge

`NudgeKind` has carried a `registry` member since the supervisor landed and
**nothing ever sent one**. Added the best-effort call at both sites, following
the dial-write pattern at `books.ts:/:tag`:

- `/start` → `notifySupervisor('registry', { tag, mode, desired: 'running' }, { log })`
- `/stop` → `notifySupervisor('registry', { tag, mode, desired: 'stopped' }, { log })`

Both sit **after** the durable write, not beside the request.

**Verified live end-to-end**, not just sent: `apps/supervisor/src/main.ts:nudge`
answers a `registry` nudge with `this.#registry.run()`, and
`apps/supervisor/src/http.ts:86` already accepts the kind
(`KINDS = new Set(['dials','fill','registry'])`).

**Tests** (`apps/api/test/books-registry.test.ts`), 3 added. The suite gained a
**real loopback nudge server** with `DESK_SUPERVISOR_PORT` pointed at it (saved
and restored in `after`) rather than a stubbed `fetch` — the route passes no
`fetch` override, so the point is that the call site reaches the port the
supervisor actually listens on:

1. STOP nudges, carrying `kind:'registry'`, tag, mode and `desired:'stopped'`;
2. START nudges, `desired:'running'`;
3. a start that 404s announces **nothing**.

---

## I-2 — protection reversal

**(a)** `apps/api/src/contract.ts` `BridgeLeg.origin`. The old docstring
described the retired adoption rule as current — "a `repair` leg is adopted
BOT-MANAGED … while a manual leg is adopted protected and left alone" — false
in both halves. Verified before rewriting:

- `origin` is read in exactly **one** place: `apps/supervisor/src/main.ts:674`,
  `openedByEngine: leg['origin'] === undefined`;
- `openedByEngine` is a **label** — `packages/desk-engine/src/marking.ts:281`
  carries it onto the `LegView` and **nothing** in `shed`, `scrap`, `shift`,
  `guards` or `tiers` reads it (grepped);
- `protectedQty` is written **only** by the operator's explicit
  `POST /v1/desk/engine/protect` (`apps/api/src/routes/engine.ts:804-809`).
  Nothing auto-protects.

The rewrite says all of that, and why protection is a per-instrument
**quantity** in supervisor state rather than a flag on the leg.

**(b)** `docs/GOING-LIVE-RUNBOOK-SUPERVISOR.md` §8 gains a lead paragraph in the
operator's language: from launch on, ANY leg added by hand to a steered book —
Manual Order dialog, repair Apply, anything — is immediately shed/scrap/
close-eligible at the next 5-minute mark until the operator presses Protect,
which is the D12 reversal of the Python default. Notes that Protect requires
the password on a live book and that it pins **lots per instrument**, so part
of a position can be pinned. Added a §6 sign-off checkbox for it.

---

## I-3 — the triple product

New file `apps/order-gateway/test/tranche-chase.test.ts`, 2 tests, driving a
`mode:'paper'` + `workMode:'passive'` + `trancheLots:3` nine-lot doc through the
**real** `createOrderPlacer` and the **real** `createOrderChaser` over **one**
shared `FakeCollection` and **one** shared `FakeFills`. Only Mongo and the
broker are faked, and the broker is `SimulatorAdapter` — its `modifyOrder`
really moves the resting trigger, so a peg that lands changes which ticks fill.
Harnesses reused: `mongo-harness.ts` (the tranche suite's) plus the real
`QuoteMap` the peg suite insists on.

Asserted:

- each re-armed slice gets its **own dwell** — `placedAt` restamped, asserted
  directly (strictly increasing, equal to the clock at placement) **and**
  behaviourally: slice 1 is deliberately never pegged so `chasedAt` stays
  unset, which makes the pass immediately after slice 2 is armed
  discriminating — un-restamped it would have pegged;
- the chaser pegs the live slice off the **appended** `brokerOrderIds`
  narrowed to live ids — by slice 3 the doc names three ids of which two are
  terminal in `desk-fills`, and the modify goes to the live one;
- terminal earlier slices drop out (second test walks all three slices and
  asserts no modify is ever addressed to a dead id);
- the package completes — `state: 'FILLED'`, `filledQty === 9 * LOT`, nothing
  re-armed past the plan.

**Mutation-checked against the source** rather than assumed:

| Mutation | Result |
| --- | --- |
| drop `placedAt` restamp from `markPlaced`'s append path (`queue.ts:314`) | test 1 fails at "slice 2 restamped placedAt to its own placement" |
| `liveBrokerIds` returns `ids` unfiltered (`order-chaser.ts:493`) | both tests fail — "one modify, for the one live slice" and "modify sent to dead id sim-1" |

Source restored and re-verified after each.

---

## Minors

**M-3** — `apps/supervisor/package.json` now declares `@algomaker/bus` and
`@algomaker/instruments` (both imported by `src/main.ts`, confirmed by grep;
versions `1.0.0` matching the packages). Added the same explanatory comment the
gateway carries about the hoisting hazard.

**M-4** — `apps/supervisor/src/main.ts:209` `BookRuntime.meta`. Verified nothing
refreshes it: written once at line 541 (`master.chainMeta(...)` during adopt),
read at 549 and 692-693, no other write. The docstring now says it is fixed for
the book's life, why that is correct (symbol+expiry are half a book's identity
and cannot change on a running book), and what to do at an expiry roll (stop and
start — a mid-flight lot-size change would re-scale every quantity the engine
has already reasoned in). Also made it `readonly` so the compiler holds the
invariant.

**M-5** — deleted `docs/UPDATING-VARIANTS.md`. Both consequences in
`docs/GOING-LIVE-RUNBOOK.md` fixed:

- `:182` pointed at it for the restart rule → replaced with the truth (presets
  ship in `@algomaker/desk-engine/presets` as prefills; dials are patchable on
  a running book and land at the next evaluation; `GET /v1/desk/variants`
  survives read-only);
- `:205` `/v1/desk/actions` → the **claim** still holds but the endpoint did
  not. Verified `liveLots` appears nowhere in `service.ts`, `routes/engine.ts`
  or `book.ts` — the override lives in `submit-plan.ts`, on the
  `/v1/desk/submit` path only. Rewritten to name
  `POST /v1/desk/engine/decisions` and to record the bypass as deliberate, with
  the reason from `repair-apply.ts:#request` (engine sizes derive from the
  book's own legs; an override would resize half a shift).

**M-6** — grepped first, as instructed. `BookCreateDialog` and `legError` were
referenced only inside `book-create.tsx` and its own test; `api.variants()` had
exactly one caller, line 367 of the same file. **Truly import-free**, so
deleted: `apps/web/src/book-create.tsx`, `apps/web/test/book-create.test.tsx`,
the `variants()` client, and `VariantRow` (orphaned — it existed only to type
that one response). A note where the client was records that
`GET /v1/desk/variants` **stays**, because `routes/payoff.ts` and the dials
PATCH still read the stored rows server-side. Four prose references updated
rather than left dangling (`books.tsx` ×2, `books.test.tsx`, `copy.test.tsx`),
and `SeedLeg.rate`'s docstring repointed at the rule that actually enforces it
(`validate.ts:validateSeedRequest`, "rate must be a positive entry price").

**M-1/M-2** — new "Implementation deviations" appendix in
`docs/GOING-LIVE-RUNBOOK-SUPERVISOR.md`. Both verified against the spec text:

- spec §9 line 432 gives `book: StoredBook // post-fold echo`; the shipped
  `DecisionResponse` (`packages/desk-engine/src/contract.ts:101`) has no such
  field. Recorded with the reason: the supervisor re-reads `desk-books` every
  evaluation, so an echo would be a second statement of the position that could
  disagree with the stored one.
- spec §11 line 492 has `desk-engine-decisions` "rendered on the book page". It
  is not — the only accesses are `createIndex` and an `upsert`
  (`routes/engine.ts:697, 1142`), and `desk-book-marks` is written by
  `marks-journal.ts` and read by nothing but a drills harness. The page's feed
  is `actionLog` off the registry row.

The appendix adds the operationally load-bearing half: **the two records do not
hold the same set.** `actionLog` is appended only under
`if (!result.replayed && result.fills.length > 0)`, while the journal is
upserted for every decision handled — so "why did it not act" cannot be
answered from the page. Included a `mongosh algomaker` query (matching
`DEPLOYMENT.md`'s convention) that does answer it, including `posts`, the retry
counter.

---

## Verification

| Check | Result |
| --- | --- |
| `npx tsc -p tsconfig.json` | **exit 0** |
| web typecheck (`src` + `test`) | **clean** — see caveat |
| `npm run test:node` | **3587 pass / 0 fail** (baseline 3578 + 9 new) |
| `apps/order-gateway` | 356 / 0 |
| `apps/api` | 1400 / 0 (Mongo present; no skips) |
| `apps/supervisor` | 162 / 0 |
| `npm run test:web` | **528 pass / 0 fail**, 29 files |
| `vite build` | bundle produced, 2726 modules |

Test-count arithmetic fully reconciles: node **+9** (4 C-1, 3 registry-nudge, 2
triple-product); web **−14**, exactly the deliberately deleted
`book-create.test.tsx` (`git show ade075ff~1:… | grep -c` = 14). No test lost
accidentally.

---

## Concerns / notes for the caller

1. **The web typecheck and `npm run build --workspace @algomaker/web` cannot run
   as-is in this worktree, and this is pre-existing and environmental.** There
   is no `node_modules` in the worktree; everything resolves by walking up to
   the main checkout's, and that one is missing `@vitejs/plugin-react`. The
   result is one error, `vite.config.ts(2,19): Cannot find module
   '@vitejs/plugin-react'`. **Confirmed pre-existing** by `git stash` → same
   single error → `git stash pop`. Since `apps/web/tsconfig.json` includes
   `src/**` and `test/**` in the *same* project as `vite.config.ts`, that one
   error being the *only* one means all app sources typecheck clean. To close
   the bundler half I did a throwaway `npm install --no-save --no-package-lock`
   and ran `vite build` directly — it produced the bundle — then **removed the
   installed `node_modules` and `apps/web/dist`**. `package.json` and
   `package-lock.json` are untouched; `git status` is clean.

2. **`docs/GOING-LIVE-RUNBOOK-SUPERVISOR.md` §8 still claims a "pre-existing red
   test"** — `service.integration.test.ts`, "a PARTIALLY marked book names only
   the missing legs". **It is green here** (api suite 1400/0, zero skips, Mongo
   reachable). Out of the stated scope so I did not touch it, but it is stale
   and worth a line in the next pass.

3. **Two references to the deleted `UPDATING-VARIANTS.md` survive**, both in
   `context/00-live-system-map.md` (lines 175, 263). That file is an explicitly
   dated snapshot — "Compiled 2026-08-15 … at commit `9d5e7cff`" — of the
   *Python* system, and both references cite the doc as being stale. I left them
   deliberately: editing a dated audit record to reflect a later deletion
   falsifies the record. Flagging in case you disagree.

4. **C-1's shape is now coupled to `LiveRail.#exits` by convention, not by
   construction.** The two op lists live in different processes and there is no
   shared constant — deliberately, and the header comment says so (a shared
   helper would let one move without the other), but it does mean a future
   change to `#exits`'s pass list must be mirrored here by hand. The tests on
   both sides pin the current pairing.

5. **The `registry` nudge fires on start/stop but not on create or retire.**
   `NudgeKind`'s docstring says `registry` covers "created, retired, started or
   stopped". The reviewer scoped I-1 to `:299` and `:697`, which is what I did.
   Create and delete still wait for the convergence pass — lower stakes (a
   created book is `desired: 'stopped'`; a delete already refuses while
   running), but the docstring currently over-promises.
