# Ticket 18 — the removal (D9's complete cutover), plus the accumulated fix list

**Branch:** `worktree-agent-aeac6745c5bb48743` (from `recenter-migration` @ `b24ea159`)
**Status:** COMPLETE. `make check` green on the merged result — typecheck both projects,
3,570 node tests, 542 web tests, 0 failures. Web build clean.

---

## 1. The grep-audit, done before anything was deleted

`grep -rn "desk/actions\|desk/variants\|deskTag" apps packages bin docs context scripts`, then
narrowed per symbol. What it found, and what happened to each:

### `deskTag` — NOT part of the removal surface

The plan's phrasing ("the `CE530#3` deskTag parsing … and its validation") reads as though the
deskTag machinery goes. The audit says otherwise and this is the single most important finding
of it:

- `apps/api/src/routes/engine.ts` — the NEW endpoint — builds `DeskAction[]` and calls
  `BridgeService.applyDecision(req: ActionsRequest)`. `ActionsRequest`, `DeskAction`,
  `BridgeLeg.deskTag`, `Fill.deskTag`, `applyActions`, `safety.ts:addsExposure`,
  `decision-plan.ts`, `store.ts`, `submit.ts` and ~40 tests all read them.
- `deskTag` also appears as a leg id in `apps/web` (positions, controls, strategy-reason) and on
  every stored `desk-books` leg.

So the deletion stopped at the **HTTP edge**. What was Python-shaped was the *wire parsing*
(`validateActionsRequest` / `validateAction`), not the book's own vocabulary. The header comment
in `contract.ts` that documented the `CE530#3` trap was rewritten rather than deleted: the file is
no longer a wire contract, but the tag-is-not-a-symbol separation it argues for is still
load-bearing (a book can hold two legs on one contract, and keyed by tradingsymbol it could name
neither).

### `POST /v1/desk/actions` — no live consumer

Handler `routes/desk.ts:242`. Consumers found: only tests (`server.test.ts` ×24,
`decision-reason.test.ts`, plus comment references in `submit.test.ts`,
`service.integration.test.ts`, `marketable.test.ts`). No runner, supervisor, marketdata or
package call site. **Deleted**, with `validateActionsRequest` and `validateAction`.

### `POST /v1/desk/variants` — no live consumer; the GET has one

- POST: only `books-registry.test.ts`. **Deleted**, with `validateVariantsReplace` and
  `DeskStore.putVariants`, which had no other caller.
- GET: **kept.** Three readers — `routes/payoff.ts:747` (a book's dial defaults),
  `routes/books.ts` (the dials PATCH's unknown-key check), `routes/system.ts:721` (a count) — plus
  `apps/web/src/api.ts:variants()`.

### The one consumer the plan did not anticipate — and why it did not need a question

`apps/web/src/book-create.tsx` polls `GET /v1/desk/variants` every 30s. It is **already
unreachable**: `App.tsx` imports only `BookBuildPage`, and `books.tsx:509` says the Build screen
superseded the create wizard. Since the removal scope is POST-only and the plan's rule is "the
spec keeps all GETs", this needed no ruling — the component keeps working, it just gets an empty
list, on a screen no route reaches. Its docstring and `api.ts`'s now say so. **I did not delete
it**: it is out of this ticket's stated scope and its own header already nominates it for
deletion once nobody has missed it.

Degradation was checked, not assumed: `validateDialsAgainstCatalogue` falls back to the engine's
`DEFAULT_DIALS` plus the row's current dials when the catalogue has no entry, so the live-dials
feature keeps working against an empty catalogue.

---

## 2. The fix list

### 2.1 LiveRail exit exemption (the LOAD-BEARING ruling) — `c94e096c`

Spec §9: switch-off blocks exposure increase, never an exit. `gateStrategy` had held that since
the 2026-08-04 stranded-position incident; `LiveRail.route` re-read the same switch on the way to
the wire with no exemption, so a switched-off live book's close passed the first gate and was
refused by the second. "Off" meant "cannot get out".

`LiveRail.#exits` derives the answer from the stored legs. Nothing was added to `RouteContext` —
a rail that took a caller's word for "this is an exit" would be a live-order gate any caller
could open by saying so.

- **The book it reads is the right one.** `applyDecision` reads `desk-books`, applies in memory,
  routes, and only then writes back — so at `route()` the stored legs are still the position this
  order trades against. Verified by reading the ordering in `service.ts`.
- **The test is direction and size, not the op**: an order reduces iff it trades opposite the leg
  it names and does not exceed it. Close, shrinking resize, growing resize and open all fall out
  of that one comparison, so it cannot disagree with `applyActions` about what an op means.
- **Fail closed on every ambiguity**: no book, no leg, two legs sharing the tag, a tag naming
  another contract, an unreadable qty, a read that threw.

Tests: `apps/api/test/live-rail-exit.test.ts`, 8 cases, Mongo-free — both directions (open still
refused, close routes, a resize that GROWS still refused) plus every fail-closed branch.

This also un-traps the **operator's close-all** on a switched-off live tag, which the docs claimed
was exempt from both gates and in fact was not.

`engine-decisions.test.ts`'s "a switched-off LIVE tag: the open is SKIPPED, the exit is a ROUTE
ERROR" pinned the defect and called it "the operational trap"; it is rewritten to "and the exit
GOES" and now asserts the book comes back flat.

### 2.2 OrderEvent mode stamping — `8d77516b`, and the push half `f4d4063f`

`OrderEvent` gains `mode`, folded into `detail.mode` by `OrderJournal.record` — the shape the
readers query, stated once, so no site can write a row that scopes live while looking stamped.
All ~20 `journal.record` sites supply it from the order document they already hold
(`main.ts` placement + recovery + refusals, `fills.ts` ×4, `order-chaser.ts` ×4,
`broker-sweep.ts` ×2, `paper-sweep.ts`). `isPaperOrder` now delegates to the new `orderMode`, so
the predicate that chooses a BROKER and the one that stamps the log cannot drift apart.

> **Corrected in the fix round.** As first written this claimed one implementation while
> `fills.ts:554` and `:601` still hand-rolled `doc['mode'] === 'paper' ? … : …`, and `notify.ts`
> added a third. All three now call `orderMode`; the claim is true as of `b4096042`.

Absent stays absent and still reads as live, so nothing ever written needs backfilling.

**The push half — an extension I made deliberately.** The brief said "end-to-end", and fixing only
the durable side leaves the same defect one layer up: `createDeskNotifier` sent a per-process
constant `mode: 'live'`, so a rehearsal's every step was a WS nudge in front of an operator
watching real money. `/v1/desk/stream/notify` refused `'paper'` for exactly that reason — a
premise D14 ended — and while it refused them the gateway sent them as live anyway, which is the
failure the refusal existed to prevent, arriving through the other door. The endpoint now accepts
either rail (still stated, still validated against its literal set — no mode is still a 400), and
the notifier reads the rail off the event from both places it is stated, fail-closed to live.

**Verification of the Orders-page filter** (`18dfd786`): a new `pnl-routes.test.ts` case puts a
rehearsal's three gateway rows and one live ACK on the same tag on the same day and asserts both
directions of the split. That case did not exist — every prior mode-split test used a row written
inside desk-api, which is precisely where the gap was not.

### 2.3 Paper Trades tab reads engine paper fills — `8f763bca`

`service.paperTrades` unions `desk-fills` `mode: 'paper'` with `desk-paper-trade`, sorted across
both and capped once. `mode: 'paper'` EXACTLY, mirroring `fills()` — an unstamped row is a live
broker fill from before the field existed and `$ne: 'live'` would sweep real trades onto the paper
tab.

Two judgements worth flagging:
- **The shapes are not merged.** A `desk-fills` row is already what `?mode=live` serves, so both
  shapes are part of this endpoint's contract; inventing `order_timestamp`/`price` keys for a row
  that has `ts`/`avgPrice` would be a rewrite that reads as provenance. `paperTradeTs` is the one
  comparator that knows both stamps.
- **A `?symbol=`-only query is answered from the rail alone.** `desk-fills` carries the contract
  and the tag and never the underlying, so there is no honest way to answer "this symbol" from it,
  and returning the lot regardless would put another book's trades under a symbol that never
  traded them. A `?tag=` query — what every per-book read uses — has no such problem.

### 2.4 `refuseSlice` journals `status: 'HALTED'` — `8d77516b`

The page renders `status` and falls back to the phase, so a halted-after-partial order read
REJECTED — the one word meaning "nothing traded" about an order that had just put three lots on.
`FillWatcher.#halt` (the other way an order halts) always stamped it; the same incident rendered
two different ways depending on which site got there first. Asserted in
`tranche-gating.test.ts`'s existing gate-between-tranches case.

### 2.5 book-build stops writing `dials.lot_size` — `9782a8e5`

It was never an engine dial; only the retired Python supervisor read it. It produced a permanent
F-29 warning on every book the Build screen created, and a banner that is always on is one nobody
reads. **Lot-size resolution verified intact**: `useChainMaster` reads it from the instrument
master for the exact symbol/expiry pair, Resolve re-reads it before anything can be placed, and
the per-leg order sizing divides by it — none of which touches the registry row. Asserted in
`book-build.test.tsx`.

### 2.6 Mirror-sync `pendingOrder` live-only clause — VERIFIED, no change needed

`mirror-sync.ts:545-560` already carries a pinning comment naming the invariant: "LIVE DOCUMENTS
ONLY … a resting PAPER order on the same tag and contract would defer a real divergence
indefinitely — the ledger stays wrong for as long as the rehearsal runs. `$ne` matches a missing
field, so this narrows to live without excluding a single document that already qualified."

---

## 3. The removal — `b6930722`

Gone: `POST /v1/desk/actions` + `validateActionsRequest`/`validateAction`;
`POST /v1/desk/variants` + `validateVariantsReplace` + `DeskStore.putVariants`;
`docs/PYTHON-DESK.md`; `contract.ts`'s Python-wire header.

Kept, each for a stated reason (see §1): every GET including `/v1/desk/variants` and its stored
rows, all historical Mongo data, `desk-decisions` history reading, `desk_tag` provenance on order
documents, and the whole `ActionsRequest`/`DeskAction`/`applyDecision` stack.

**Test migration.** `server.test.ts`'s 24 uses were a "put legs on the tag" fixture; they are
re-pointed at `/v1/desk/seed`, which exists to record an already-held position and routes nothing
— a better fixture besides, since what those tests assert is what the READ serves. Its
wire-validation cases went with the wire they tested, after confirming
`engine-decisions.test.ts` already covers the same properties (400 on a malformed action,
machine-principal auth, explicit mode, a decisionId that must carry its mode) on the endpoint that
exists. Auth and malformed-JSON moved to `/v1/desk/declare`. A new case pins the **404**: a client
still calling the dead path must be told, not answered with a 200 it would read as "applied".

`decision-reason.test.ts` tested only the removed validator. Rewritten against
`validateDecisionRequest`.

> **Corrected in the fix round.** This originally said "the contract genuinely changed: `reason`
> was OPTIONAL … and is now REQUIRED". That is wrong as a description of what this ticket did.
> `validateDecisionRequest` has required `reason` (possibly empty) since ticket 11 — nothing moved
> here. What changed is only which endpoint the test points at: the OPTIONAL/REQUIRED difference
> is between the removed wire and the surviving one, both of which already existed at base. The
> test file's own header said "THE CONTRACT CHANGED WITH THE D9 CUTOVER", which reads the same
> way, and is corrected with it: the file moved, the contract did not.

---

## 4. Operational plumbing — `d5eb616c`

`bin/desk-reset.mjs` learns `desk-supervisor-state`, `desk-engine-decisions`,
`desk-supervisor-lease`, `desk-book-marks`. These are what the Python supervisor kept in
`data/desk/*` on the box — file state a reset never touched. They are in Mongo now, so a "clean"
deployment that left them would boot the supervisor onto the last run's protected lots, its
in-flight decision ids, and a lease held by a dead process. **Verified against a scratch
database**: all four listed in the dry run, all four dropped by `--yes`.

`context/00-live-system-map.md` gains **§7.0**, a dated correction table in the document's own
corrections style — not a rewrite. The body stays as compiled at `9d5e7cff`; the table names which
sections the cutover retired (the two supervisor pm2 rows, Path A steps 1-2, the whole "Python
boundary — 9 endpoints" section, the collection count, open question 6) and records the LiveRail
exit fix against the gate list it belongs to.

---

## 5. The known-red era is over — `57430bf5`

`service.integration.test.ts`'s "a PARTIALLY marked book names only the missing legs" was **not**
the stale 26JUL fixture date. `positions()` grew a MODEL PASS: when some leg's IV solves, that IV
is a defensible reference and a quoteless leg is priced theoretically off it, included in the
totals and named in `greeks.fallbackPriced`. The method says so in its own words — "True only when
EVERY leg priced — market or model … a model-priced leg is included, so it does not break
completeness, it qualifies it." The test predated that.

The property it guarded is intact and is the test directly above it: with NOTHING marked, nothing
solves, no reference exists, and the book reports incomplete with every leg named — the dangerous
case, a net delta that silently omits legs and reads as flat. Rewritten to assert the model pass;
a model-priced leg is in the total and labelled an estimate, which is a different thing.

`apps/api` is green end to end.

---

## 6. Verification

| Run | Result |
|---|---|
| `npm run typecheck` (root + web) | clean |
| `npm test` — node suite | **3,570 / 3,570**, 0 failures |
| `npm test` — web (vitest) | **542 / 542**, 30 files |
| `apps/api` alone | **1,393 / 1,393** |
| Full run repeated | identical, 3,570 / 0 |
| `apps/web` vite build | clean, `dist/` gitignored, tree clean |

**No load-flakiness observed.** The api Mongo suite was run three times under the full parallel
run and once alone; the same numbers each time. Baseline before any change was 3,557 pass / 1 fail
(the known-red test).

Worktree note: `apps/web/node_modules` does not exist in a fresh worktree (npm hoists the web deps
into the main checkout's `apps/web/node_modules`, which is not an ancestor of the worktree path),
so the web typecheck and vitest fail with `Cannot find module '@vitejs/plugin-react'` until it is
symlinked. Not a repo defect; worth knowing before reading a red worktree run as a real failure.

---

## 7. Concerns and things left standing

1. **`apps/web/src/book-create.tsx` is dead code with a live GET client.** Unreachable from any
   route, tested by its own suite, and now correctly documented as reading a catalogue that no
   longer grows. Deleting it (plus `test/book-create.test.tsx`) is a clean follow-up its own header
   invites; out of this ticket's scope.
2. **`main.ts:1542`'s second `refuseOrder` binding is unused** (`noUnusedLocals` is off). Pre-existing,
   untouched, one line.
3. ~~**A `roll` on a switched-off live tag would half-execute**~~ — **CLOSED in the fix round.**
   The rail now requires `op` to be `close` or `resize`, so a roll is refused whole. See §9,
   IMP-1. `2a216ca3` documented the shape; `b4096042` fixed it.
4. **`context/12-dashboard-data-and-push.md:421` still links `../docs/PYTHON-DESK.md`**, now deleted.
   The brief scoped the doc work to appending a note to `context/00`, which §7.0 does and which
   already declares doc 12 superseded. Left alone rather than editing a doc outside the brief.
5. **The `desk-variants` catalogue is now frozen.** Books registered under a published variant keep
   resolving their dial defaults from the stored rows; a NEW variant key would have no catalogue
   entry, and `validateDialsAgainstCatalogue` would fall back to the engine schema plus the row's
   own dials and say "the supervisor has not published one". That message names a supervisor that
   no longer exists — cosmetic, and I left the wording alone rather than widen the diff.
6. **The stream/notify contract widened.** `mode: 'paper'` is now accepted from a machine
   principal. The threat the old refusal named — an out-of-process caller putting a live fill in
   front of a paper tab — is unchanged, because `'live'` was always accepted; what is new is a
   paper frame on the paper tab, which is where a paper frame belongs. Machine-only auth is
   untouched.

---

## 8. Commits

| SHA | |
|---|---|
| `c94e096c` | fix(api): a switched-off live tag can get out — the rail derives the exit from the book it is trading against |
| `8d77516b` | fix(gateway): the order journal says which rail a row is on, and a halted slice says HALTED |
| `8f763bca` | fix(api): the paper Trades tab reads both paper writers, so a rehearsal's fills are visible |
| `57430bf5` | test(api): the known-red partial-marks test asserts the model pass, ending the known-red era |
| `9782a8e5` | fix(web): the Build screen stops writing lot_size, so the F-29 banner means something again |
| `b6930722` | chore(desk): the Python-facing bridge surface is gone — actions, variants, pseudo-symbols, and their docs |
| `d5eb616c` | chore(desk): the reset knows the supervisor's own state, and the system map carries a dated correction |
| `f4d4063f` | fix(gateway,api): the WS nudge lands on the rail the ORDER is on, not the one the process assumed |
| `18dfd786` | test(api): the Orders-page filter is proven to separate the rails on a GATEWAY row |
| `2a216ca3` | docs(rail): name the roll interaction the exit exemption leaves open, and why it has no producer |
| `b4096042` | fix(api,gateway): the exit exemption checks the OP, and its fake store answers the filter it was asked |
| *(this doc)* | docs(sdd): ticket 18 fix report |

---

# 9. Fix round — review approved with 2 hardening items + 5 minors

Both Important items were right, and the second one is the more uncomfortable of the two: it
found that my own test file could not have caught the bug it was written to prevent.

## IMP-1 — the exemption was package-blind

**The finding.** `LiveRail.#exits` judged an order on direction and size against the leg it names.
That is package-blind by construction — the method sees one fill and cannot know what else is in
the decision — and two shapes satisfy it without being exits:

- **A roll.** `applyActions` emits two fills for one roll and stamps *both* `op: 'roll'`: the
  buy-back of the old leg, which really does reduce, and the sale of the replacement, which
  carries the **old leg's tag**. Judged on the numbers, that second fill "reduces" too.
- **An open wearing a close's clothes.** `[close X, open ts='X' opposite side, qty <= held]`. This
  method reads the book *before* the decision, so the leg the second action names is still there;
  the fill trades the closing side at a permitted size. Every number says exit. It is an open.

**Why I had dismissed the first one and missed the second.** I reasoned "gate 1 refuses both, and
no `RollAction` producer remains", wrote that down beside the check (`2a216ca3`), and moved on.
That is the wrong standard for this specific object. This rail is the **second of two independent
gates**, and the entire argument for its existence — stated in `rail.ts`'s own header — is the
case where the first one does not hold. A second gate that is only correct while the first is
correct is not a second gate. My note documented the hole instead of closing it.

**The fix**, the reviewer's one-token tightening:

```ts
if (fill.op !== 'close' && fill.op !== 'resize') return false
```

Strictly tightening — it can only refuse *more* than the size test alone — and it closes both
shapes at once, because `close` and `resize` are the only ops that can reduce a position. An exit
is a close or a shrinking resize and stays permitted; the ordinary paths are untouched. A roll is
now refused **whole**, which is the right answer for a rail that cannot see the package: half a
roll leaves a switched-off book short a hedge, which is worse than leaving it untouched.

**Tested at the rail, not through gate 1** — which is the point of the finding. Reaching these
shapes through `applyDecision` would test `applyActions`' duplicate-tag refusal and call the
result a rail property. Two new cases construct the fills directly:

- `a ROLL is refused whole — both halves, not just the replacement`
- `an OPEN wearing a close's clothes is refused on its OP, not its numbers` — and it pairs the
  disguised open with the **identical numbers under `op: 'close'` routing successfully**, so the
  test proves the op is what refused it rather than some incidental mismatch.

The two stale doc paragraphs that described the old reasoning (`THE TEST IS DIRECTION AND SIZE,
not the op`, and the roll note from `2a216ca3`) are rewritten rather than left to contradict the
code.

## IMP-2 — the fake store ignored the filter it was asked

**The finding.** `live-rail-exit.test.ts`'s `findOne` took no arguments and returned the same
document however it was called. Neither the tag predicate nor `mode: 'live'` was asserted
anywhere. So a rail that authorised a **live** order off the **paper** book's legs — or off some
other tag's book — would have passed all eight cases, including the ones whose whole purpose was
to prove the rail fails closed.

This is the sharpest thing in the review. The suite was written to pin a live-money gate and could
not distinguish the gate from an open door, because the fake asserted the *answer* and never the
*question*.

**Why it matters concretely, not just as hygiene.** Paper and live are two ledgers on one tag, and
the paper one is far easier to arrange: a rehearsal opens whatever legs it likes there with no
password, no live switch, and no real money. If this read had been keyed on the tag alone, a paper
leg would have been a permission slip for a **real** order on a book the operator had deliberately
switched off — the exact failure the exemption is bounded to avoid, reached from the other side.

**The fix.** The fake is keyed by `{tag, mode}` and returns null for a filter that does not match,
exactly as Mongo would; it records every query in `asked`; the happy path asserts
`[{ tag: TAG, mode: 'live' }]`. Two new cases cover what was previously unprovable:

- `a PAPER book holding the leg does NOT authorise the live order` — and asserts the rail asked
  for the **live** book.
- `ANOTHER tag's live book does not authorise this tag's order`.

The `tag switched ON` case additionally asserts `asked` is **empty**: an enabled tag pays no read
at all, which was previously only claimed in a comment.

## The five minors

| # | | |
|---|---|---|
| 3 | Doubled `/**` at the variants section of `store.ts` | fixed |
| 4 | `pnlstore.ts:576` said the gateway's events "carry no such field and are live by construction" — true until this ticket stamped them | rewritten, including why `$ne 'paper'` still covers every pre-stamp row |
| 5 | `system.ts:713` and `system.test.ts:622` named the deleted `store.putVariants` | rewritten; both now say the count is **frozen** (the writer is gone) and note that a frozen count makes the null age *more* honest, not less |
| 6 | The report's "ONE implementation" claim was false — `fills.ts:554`/`:601` hand-rolled the mode read, and `notify.ts` had added a third | **fixed the code rather than the claim**: all three delegate to `orderMode`, so the claim is now true. `grep` for `=== 'paper' ?` in `apps/order-gateway/src` returns only `orderMode`'s own body |
| 7 | The report's §3 "`reason` is now REQUIRED" read as though this ticket moved a contract | corrected in §3, **and in the test file's own header**, which said "THE CONTRACT CHANGED WITH THE D9 CUTOVER" and read the same way. Verified against base: `git show b24ea159:apps/api/src/routes/engine.ts` already has `reason is required (it may be empty)` at line 368. The file moved; the contract did not |

Minor 6 was worth doing as code rather than prose. "The rule has one implementation" is the
property that makes the adapter choice and the journal stamp unable to disagree about whether an
order is a rehearsal — weakening the sentence to match three copies would have kept the sentence
honest and left the property broken.

## Verification, fix round

| Run | Result |
|---|---|
| `apps/api` suite | **1,397 / 1,397**, 0 failures |
| `apps/order-gateway` suite | **350 / 350**, 0 failures |
| `live-rail-exit.test.ts` alone | **12 / 12** (was 8) |
| `npm run typecheck` (root + web) | clean |
| `npm test` — node | **3,574 / 3,574**, 0 failures |
| `npm test` — web | **542 / 542**, 30 files |

No new concerns. Concern 3 in §7 (the half-executing roll) is **closed** by IMP-1 and struck
there; the rest stand as written.
