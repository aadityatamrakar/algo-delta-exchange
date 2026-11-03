# Ticket 16 — the paper rail runs the real order lifecycle (plan Task 18)

**Status:** COMPLETE
**Branch:** `worktree-agent-a8e49f87a963e9327` (worktree `.claude/worktrees/agent-a8e49f87a963e9327`)
**Commit:** `3a20cb60` — *feat(desk): a paper order lives the live order's life — placed, worked, filled by ticks, folded on the fill event*
**Base:** `2f3d0ebd` (ticket 13 merge)

---

## 1. What was built

An engine **paper** decision now lives the live order's life end to end:

```
POST /v1/desk/engine/decisions  (mode: paper)
  → PaperRail writes a doc into `desk-gateway-orders`, `mode: 'paper'`, PENDING
  → response is `WORKING`, fills [], `desk-books` UNTOUCHED
  → gateway claims it, runs every gate but the live allowlist,
    places it on the SIMULATOR (per-document adapter choice)
  → a `md.tick` frame crosses the resting limit through the SAME fan-out
    that feeds the QuoteMap → simulator fills
  → FillWatcher writes a `desk-fills` row stamped `mode: 'paper'`,
    the desk order goes FILLED
  → desk-api's new `paper-fold.ts` pass books the fill onto `desk-decisions`,
    folds the leg into `desk-books` at the BROKER's price, publishes the
    dashboard FILL frame, and fires `notifySupervisor('fill', …)`
  → the decision settles from `WORKING` to `DONE`
```

The four ticket checkboxes:

| Checklist item | Where it is proved |
|---|---|
| Engine paper decision returns WORKING, not DONE-with-fills | `engine-paper-lifecycle.test.ts` test 1; `engine-decisions.test.ts` (a) |
| A crossing tick produces a `desk-fills` row with paper mode; the book folds on the event; the nudge fires | `engine-paper-lifecycle.test.ts` test 2 (asserted against a real loopback nudge server) |
| Peg + tranche behaviour on paper is byte-identical logic to live | Same placer, same `planFor`/`planTranches`, same cursor, same `FillWatcher`; only `adapterFor(doc)` and the allowlist differ — `paper-rail.test.ts` |
| `/v1/desk/submit` (manual box, runner) unchanged | `submit.test.ts`, `flatten.test.ts`, `close-leg.test.ts`, `repair-apply.test.ts` all green untouched; `routedCollection` returns `desk-paper-trade` for anything without `via:'engine'` |

## 2. Files

**New**
- `apps/api/src/paper-fold.ts` — the fold pass (`createPaperFillFolder` / `startPaperFillFolder`).
- `apps/api/test/engine-paper-lifecycle.test.ts` — the two-app integration suite (real Mongo, real server, real gateway placer/simulator/watcher).
- `apps/order-gateway/test/paper-rail.test.ts` — Mongo-free: the mode predicate, the tick fan-out, the adapter split, the allowlist skip, the mode stamp on fills.

**Modified — api**
- `rail.ts` — `RouteVia`, `RouteContext.via`, `routedCollection()`, `PaperRail.route`'s engine branch.
- `contract.ts` — `ActionsRequest.via`.
- `service.ts` — `DecisionStatus` gains `WORKING`; `worksAsync` branch in `applyDecision` (no book write, `fills: []`, `workingOrderIds`); `via` stamped at claim time; `#resolveRouting` probes `routedCollection` and resolves an engine paper package to `WORKING`; `fills()` excludes paper rows.
- `routes/engine.ts` — passes `via: 'engine'`; headers rewritten.
- `reconcile-live.ts` — scan excludes `mode: 'paper'`; prime directive 2 rewritten; `TERMINAL_STATES` and `restoreView` exported.
- `mirror-sync.ts` — `pendingOrder` fence scoped to live.
- `main.ts` — `startPaperFillFolder` wired (`DESK_PAPER_FOLD_MS`, default 2 s) + shutdown.

**Modified — gateway**
- `main.ts` — `isPaperOrder` (exported, fail-closed), `tickFanout` (exported), `PlacerPorts.adapterFor`, allowlist skipped for paper, `sweepArmed && !paper`, `paperAdapter` built unconditionally, one chaser per rail, fills watched on both adapters, broker sweep scoped live.
- `order-chaser.ts`, `broker-sweep.ts` — optional `ordersFilter` merged into the `PLACED` query.
- `fills.ts` / `gateway.ts` — `OrderShape.mode`, `FillRecord.mode: 'live'|'paper'`, `toFillRecord` widened; the mode is read off the order document, never from the process's broker mode.

**Modified — tests** (behaviour change, not fixture churn)
- `engine-decisions.test.ts` — paper assertions moved from "DONE + book folded" to "WORKING + order queued"; a `seedLeg()` helper replaces "seed by posting a decision", because a decision no longer folds its own book. `routedOrders()` reads `desk-gateway-orders`.
- `reconcile-live.test.ts` — new test: a paper gateway order is not scanned, not journalled and **not marked**.
- `order-chaser.test.ts`, `broker-sweep.test.ts`, `chaser-harness.ts` — rail-scoping tests; the fakes learned `$ne` (modelling Mongo's "matches a missing field", which is what keeps the existing live book in scope).
- `rail-contract.test.ts` — `routedCollection` pinned from the gateway's side.
- `tranche-gating.test.ts` — `adapter:` → `adapterFor: () => broker`.

## 3. Design decisions worth reviewing

**(a) Only PAPER changes lifecycle, not live.** `worksAsync = via === 'engine' && mode === 'paper'`. A live engine decision still books optimistically at route time with `reconcile-live.ts` restating it — a whole file of prime directives is built on that order of events, and rewiring it is a separate change with a separate blast radius. The spec's §8 fill-flow paragraph describes live folding on the fill event too; that is **not** in this ticket and is called out as a follow-up below.

**(b) `via` is set in code, never read off the wire.** `validateDecisionRequest` does not accept it. A caller able to name its own lifecycle could ask for a paper package nothing ever accounts for.

**(c) The fold pass is a poller, not a change stream.** Production Mongo is a standalone. 2 s by default (`DESK_PAPER_FOLD_MS`) rather than the reconciler's 60 s, because the supervisor holds a decision `inFlight` until its fills are accounted for.

**(d) Completion is two explicit lists, not arithmetic.** `workingOrderIds` (what reached the rail) vs `foldedOrders` (what this pass settled). Counting planned fills minus route errors leaves a partially-refused package `WORKING` forever.

**(e) Only an `open` may create a leg in the fold.** The deferred fold opens a window the synchronous path did not have: an operator can empty the book between the decision and its fill, and a close arriving at an empty book with `mayCreate` on would OPEN a leg the other way. Dropped and journalled loudly instead. Test: *"a CLOSE whose leg vanished while it worked never opens one the other way"*.

**(f) Fail-closed everywhere the mode is read.** `isPaperOrder(doc)` is `doc.mode === 'paper'` and nothing else; `FillWatcher` stamps `order?.mode ?? 'live'`; every new query uses `$ne: 'paper'` (which matches a missing field) so no existing live document falls out of scope. A live order mistaken for paper is a missing position, visible immediately. A paper order mistaken for live places real money — and even that is caught by the gateway's own allowlist gate.

**(g) Idempotency.** Record push is `updateOne({…, foldedOrders: {$ne: id}}, {$push: fills, $addToSet: foldedOrders})` — atomic and conditional. The book fold rides `appliedCorrections` (the nonce is written in the same `updateOne` as the legs), so a crash between the fold and the mark re-runs cleanly. `#tellBook` is called only when *this* pass made the fill real, so a retry cannot double-count the in-memory cache.

## 4. Tests

| Suite | Result |
|---|---|
| `apps/order-gateway/test/**` | **335 / 335 pass** |
| `apps/api/test/**` | **1361 / 1362 pass** — 1 known-red baseline (below) |
| `packages/*/test/**` | **882 / 882 pass** |
| `apps/runner`, `apps/marketdata` | **491 / 491 pass** |
| `npm run test:node` (whole tree) | **3174 / 3175 pass** |
| `npx tsc -p tsconfig.json --noEmit` | clean |

**Known-red baseline, NOT mine:** `apps/api/test/service.integration.test.ts:153` — *"a PARTIALLY marked book names only the missing legs"*. Recorded in `progress.md` line 51 as pre-existing from master (a 26JUL time-bomb fixture). Verified independently here: `git stash -u` → the same test fails on the untouched tree → `git stash pop`.

**Web typecheck** could not run in this worktree (`@vitejs/plugin-react` is not installed in an isolated worktree — `progress.md` line 55 already records that web typecheck runs at integration). No web files were touched.

TDD order: the failing integration test was written first (`engine-paper-lifecycle.test.ts`), then the api rail/service, then the fold pass, then the gateway. Two implementation bugs were found by it rather than by inspection — the fold could not CREATE a book row for a brand-new tag, and the gateway's staleness gate refused every order because the suite's two halves ran on different clocks.

## 5. Deviations and open items

**D-1 — Live still books at route time.** §8 says "Live: gateway FillWatcher → `desk-fills` → desk-api folds the book → nudges the supervisor". That is not what live does today (it books at route time and `reconcile-live` restates), and this ticket did not change it — the plan's Task 18 file list and its own checklist scope to paper. Worth a ruling before the live cutover: either the spec sentence is describing the target state of a later ticket, or a Task-18-shaped change is owed on the live rail too. **Nothing in this ticket makes that harder** — `worksAsync` is one predicate.

**D-2 — a paper order's gateway journal rows render on the LIVE Orders tab. CORRECTED SCOPING (review IMP-3): the DURABLE side is affected, not only the socket push.** My original text said "the durable record in `desk-order-events` is correct". It is written correctly but read wrongly, and that is the same thing from the operator's seat:

- `service.orderEvents` scopes by `detail.mode` — `{'detail.mode': {$ne: 'paper'}}` for LIVE and `{'detail.mode': 'paper'}` for PAPER (`service.ts:1885`).
- The gateway stamps no `detail.mode` on anything it journals (PLANNED, SUBMITTED, ACK, STATUS, and every refusal), because until this ticket it only ever saw live orders — the docstring said so in as many words.
- So a paper order's routing steps are **durable rows that fall on the LIVE side of that filter and are absent from the PAPER side**, on the REST-served table as well as on the socket push (`createDeskNotifier` separately hard-codes `mode: 'live'`).

**Blast radius:** display only, and bounded. No money-path record is affected — `desk-fills` carries the true mode, `desk-decisions` and `desk-books` are keyed by it, and the fold pass's own FILL/STATUS rows *do* stamp `detail.mode: 'paper'` and scope correctly. What an operator sees during a rehearsal is a live Orders tab carrying the rehearsal's routing steps, and a paper tab missing them.

**Fix, and why it is not here:** add `mode` to the gateway's `OrderEvent`, stamp it at ~12 `journal.record` sites, have `createDeskNotifier` read it, and relax the stream route's `mode === 'live'` refusal — a contract change across both apps. **Deferred to ticket 18 (removal) per the controller's ruling.** The false premise it rested on has been corrected in `service.orderEvents`' docstring so the next reader is not misled.

**D-3 — the paper Trades tab does not show engine paper fills.** `/v1/desk/trades?mode=paper` reads `desk-paper-trade`, which an engine paper order no longer writes to. Its fills are in `desk-fills` with `mode: 'paper'` (and in `desk-decisions`, which the P&L and positions read, so **P&L and the book are correct**). Merging the two row shapes into one view is a UI contract change; deferred and flagged.

**D-4 — a partially-refused engine paper package answers `FAILED` while its routed orders keep working.** Deliberate parity with the live path, which does exactly the same. Documented in `service.ts` at the branch. A supervisor reading FAILED rolls back its state delta while paper orders it no longer tracks may still fill — on paper only, and visible in `desk-decisions.workingOrderIds`.

**D-5 — a duplicate FILL journal row is possible on the crash-window retry.** If the pass dies between the book fold and the `deskFolded` mark, the next pass re-publishes the FILL frame (the fold itself is idempotent; only the journal line and the socket frame repeat). The event's `detail.recorded` says `'on an earlier pass'`. Cheap to tighten if a reviewer wants it.

**Also settled in passing:** the ticket-13 review's request to pin `mirror-sync`'s `pendingOrder` fence in a comment (`progress.md` line 103) — the fence is now stated in the query itself (`mode: { $ne: 'paper' }`) rather than inferred from which callers thread a tranche dial.

## 6. Operational notes for the cutover

- New env dial: `DESK_PAPER_FOLD_MS` (default 2000). Worth adding to `.env.local.example` in ticket 20.
- The gateway now builds a `SimulatorAdapter` on every boot, including in xts mode. It costs a Map and a tick handler and connects to nothing.
- In xts mode the gateway arms **two** chasers (`live` / `paper`), so the boot log gains one line. In simulate mode it arms one (`simulate`) and behaves exactly as before.
- `desk-gateway-orders` gains `mode: 'paper'` documents and a `deskFolded` / `deskFoldedAt` mark (deliberately distinct from the live reconciler's `deskReconciled`, so the two passes can never mark for each other).


---

# Fix round 1 — review verdict *Needs fixes* (1 Critical, 3 Important, 2 minors)

**Commit:** `534a0e6d` — *fix(desk): a package settles on the orders that traded NOTHING too, and a paper order survives what a restart does to it*

| # | Verdict | Status |
|---|---|---|
| C-1 | package strands at `WORKING` forever | **Fixed**, mutation-proven |
| IMP-1 | resting paper orders are zombies across a restart | **Fixed** (`paper-sweep.ts`) |
| IMP-2 | duplicate-open weaker on paper than live | **Fixed** (door guard) |
| IMP-3 | report's D-2 scoping understated the blast radius | **Report corrected**; code comment corrected; fix stays deferred to ticket 18 per ruling |
| M-1 | `#resolveRouting` read `req.via` not the stored marker | **Fixed** |
| M-3 | dashboard cancel of a paper order | **Done** (~50 lines, and it closed a false-success I had introduced) |
| M-2 / M-4 | — | Deferred per the review |

## C-1 — the receipt that was only written when something traded

**The defect.** `foldedOrders` is the list `settle` counts, but only the `qty > 0`
path wrote to it. The zero-trade branch (REJECTED / INVALID / zero-fill HALTED)
published, settled and marked `deskFolded` — taking the document out of every
future pass — without ever recording itself. A sibling that filled later then
asked "is every id accounted for?", read a list that had never heard of the
zero-trade order, and answered no. Both documents marked, no pass able to
revisit either: the decision stayed `WORKING` for the rest of the session, with
the supervisor holding it `inFlight` and forming no further package for that
book.

**Why it is not a corner.** The failing ordering is the one production produces
— a rejection is terminal the instant the order is placed, while a fill waits
for a tick, so the zero-trade order folds FIRST. And the trigger is ordinary:
the simulator REJECTS a MARKET order on a token it has seen no tick for, and the
engine routes MARKET whenever an action carries no `limitPrice`. The first
package of a paper session is a live candidate.

**The fix.** A single `claimOrder(deps, decisionId, clientOrderId, fill?)` writes
the receipt on **every** path — the `planned === undefined` branch, the
zero-trade branch, and the fill branch (where the fill rides along in the same
conditional update, so a fill can never be recorded without its receipt or a
receipt without its fill). `foldedOrders` now answers exactly one question:
*has this pass finished with order X?* — which an order that traded nothing
answers just as fully as one that filled.

**And a second stranding closed while in there:** `settle` took the decision
document its caller had read *before* claiming. A sibling claimed by another
pass (a second desk-api, a retry) landed after that read too, so both orders
could each believe the other was outstanding. `settle` now re-reads the record —
one extra `findOne`, on the settle path only.

**Evidence.** New test, both orderings, asserting the decision reaches `DONE`,
that `foldedOrders` names **both** ids while `fills` names only the one that
traded, and that the book gains only the leg that really traded. Proven against
the bug by reverting the claim: both orderings fail (`WORKING` ≠ `DONE`, and the
receipt list short by one), then pass with it restored.

## IMP-1 — `apps/order-gateway/src/paper-sweep.ts`

**The hole.** A live resting order survives this process dying — it is at the
exchange, and three independent things go and find it again (the order socket
replay, the broker sweep, the boot reconcile). A paper one lives in the
`SimulatorAdapter`'s in-memory map, which a restart empties: no tick can fill
it, the broker sweep is deliberately scoped away from it, the chaser's
`modifyOrder` against a `sim-N` the new simulator never issued answers false
forever, and the fold pass scans TERMINAL states only. The document sat `PLACED`
and its decision stayed `WORKING` — a rehearsal a `pm2 restart` could silently
end.

**The verdict is a fact, not a timeout.** An order `placedAt` before this
process booted **cannot** be in this process's simulator, because the
simulator's book is created empty at construction. That is what makes it safe,
and it is why this cannot race a fill: an order this process placed is never
eligible, whatever its age. The grace period (`DESK_PAPER_ORPHAN_MS`, default
120 s) only delays the verdict past boot's concurrent work; it is not part of
it. A belt-and-braces check against the simulator's own `orderBook()` means a
future simulator that recovered its book would stop being condemned without
anyone having to remember this file exists.

Marked `REJECTED` with `filledQty: 0` and a loud `ok: false` journal line, so
`paper-fold.ts` settles the package on its next pass and an operator can see why
the rehearsal stopped. Six tests: the restart case, an order this process placed
(never condemned, +1 day), the grace period, an order the simulator still holds,
a live document, and an unreadable simulator book (condemns nothing — unreadable
is not "empty").

## IMP-2 — the duplicate-open guard, at the door

Everywhere else the BOOK refuses a duplicate open (`applyActions`: "tag is
already open"), and it can because the decision that opened the leg folded at
route time. An engine paper decision folds when its fill lands, so while the
order works the book says nothing — and a second decision on the same contract
would route a second order and land two legs on one instrument, which the wire
(addressing contracts) could never name again.

An `open` naming a contract that already has a **non-terminal** paper order for
the tag is refused: 400, nothing written, no `decisionId` claimed, whole package
— the same shape as the duplicate-instrument rule beside it. Paper only: on live
`applyActions` already refuses in its own words, and two places deciding what
"already open" means is how they come to disagree. `NON_TERMINAL_STATES` is
derived from the same `IS_TERMINAL` map as `TERMINAL_STATES`, so a new state
cannot land in neither list. The query fails **open** (logged), because refusing
a rehearsal over a Mongo blip is the wrong direction on this rail.

**The bug this nearly shipped with, caught by the existing replay suite within a
minute:** a replay posts the identical package under the identical id, and a
guard that counted the package's *own* working orders would 400 every supervisor
restart and every retried POST — telling the supervisor its decision failed
while its orders were live. Orders belonging to this `decisionId` are excluded,
split with the shared `splitOrderId` rather than a prefix test. Now pinned by
its own test as well as by the replay suite.

Four tests: refused while working; allowed once the order is terminal (and then
refused by the BOOK, in its own words — one refusal, from whichever authority
actually knows); a replay is answered not refused; a CLOSE is never touched by
the guard (refusing exits is how a book gets trapped, and this must not become a
second way to do it).

## M-1 — `#resolveRouting` reads the stored marker

`via` is stamped at claim time, so the record says what the crashed process
actually did; `req.via` says only what the caller resolving it claims now. The
two can differ — a replay from anything but the engine endpoint, an operator
retrying by hand — and reading the request as absent would probe
`desk-paper-trade` for orders sitting in the gateway queue and report every one
of them LOST, which is the one answer that talks a caller into routing them a
second time. `worksAsync` there now reads the stored `via` and the stored `mode`.

## M-3 — the paper cancel path (done, not deferred)

`POST /v1/desk/broker/orders/:id/cancel` writes one row keyed by the broker
order id. Paper orders now have broker ids (`sim-3`), and that row had two
possible fates — **both wrong, and one of them a false success I had
introduced**: on an xts box the live drain found no `sim-3` in the broker's book,
answered "already gone" and marked the row DONE while the order carried on
working; on a simulate box nothing drained it at all.

Both drains now share one predicate (`isPaperBrokerOrder`) for whose row it is —
the live one to skip it, the paper one to claim it. Two copies would eventually
disagree, and the way they would disagree is that both handle one row. The
simulator's `cancelOrder` emits CANCELLED, which the fill watcher aggregates as
terminal-with-nothing-filled, so the desk order goes REJECTED and the fold pass
settles its package — no second path, and nothing in the drain decides an
outcome by itself. Two tests: cancel makes the desk order terminal with zero
filled and a paper-stamped CANCELLED row; cancelling what the simulator no
longer holds answers false rather than a lie.

## Tests after the fix round

| Suite | Result |
|---|---|
| `apps/order-gateway/test/**` | **343 / 343 pass** (+8) |
| `apps/api/test/**` | **1367 / 1368 pass** (+6) — 1 known-red baseline |
| `npm run test:node` (whole tree) | **3188 / 3189 pass** |
| `npx tsc -p tsconfig.json --noEmit` | clean |

Known-red baseline unchanged and still not mine: `service.integration.test.ts:153`
(`progress.md` line 51, verified by stashing in the first round).

## New operational surface from this round

- `DESK_PAPER_ORPHAN_MS` (default 120000) — how long after boot the paper orphan
  sweep starts condemning stranded `PLACED` paper orders.
- `DESK_PAPER_SWEEP_MS` (default 30000) — its cadence.
- The gateway's boot log gains a `paper cancel` / `PAPER ORPHAN` line when either
  fires. Both are armed unconditionally, including in simulate mode: the restart
  hole is a property of the simulator's memory, not of which broker the live rail
  talks to.

## Residual, unchanged from round 1

D-1 (live still books at route time — needs a ruling before cutover), D-2 (now
correctly scoped above; deferred to ticket 18), D-3 (paper Trades tab), D-4
(partial-refusal answers FAILED — live parity), D-5 (duplicate FILL journal row
in one crash window).
