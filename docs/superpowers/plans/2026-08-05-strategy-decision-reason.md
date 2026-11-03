# Strategy Decision Reason Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the strategy's own decision reason ("allowance 188 under one lot (225); no convexity to centre") on `#/strategies/{run}`, plus the list of decisions that actually traded.

**Architecture:** Python attaches `action`/`reason` to the `/v1/desk/actions` payload it already posts every mark. The desk-api ROUTE HANDLER (not `service.ts`) writes both a always-current reason and a capped action log onto the book's `desk-books-registry` doc. A read endpoint serves that doc; the web renders a panel.

**Tech Stack:** Node 24 (TypeScript run directly, no build), MongoDB, React + `@astryxdesign` theme, `node:test`.

## Global Constraints

- **`service.ts` is not modified.** Its ordering is crash-safety-critical and documented as such; the reason is telemetry and must not enter that transaction.
- **The reason is stored VERBATIM.** No parsing into fields — the wording changes whenever a playbook does.
- **Unknown fields must keep being ignored** by `validateActionsRequest`, so the two repos deploy in either order.
- **Nothing here may fail a decision.** Every write is best-effort; a throw must not turn a routed decision into a 500.
- Reason writes must happen on REPLAYS too (`service.ts:306` returns early for a repeated `decisionId`, and the supervisor posts the same id several times per 5-min slot).

---

### Task 1: Carry `action`/`reason` through validation

**Files:**
- Modify: `apps/api/src/contract.ts:87` (`ActionsRequest`)
- Modify: `apps/api/src/validate.ts:119` (`validateActionsRequest`)
- Test: `apps/api/test/validate.test.ts`

**Interfaces:**
- Produces: `ActionsRequest.action?: string`, `ActionsRequest.reason?: string`

- [ ] **Step 1:** Add the two optional fields to `ActionsRequest`.
- [ ] **Step 2:** In `validateActionsRequest`, pass them through only when they are non-empty strings; never coerce.
- [ ] **Step 3:** Test that a request WITHOUT them is still valid (the deploy-order property).
- [ ] **Step 4:** Run `npm test -w apps/api`; commit.

### Task 2: Store — reason + capped action log on the registry doc

**Files:**
- Modify: `apps/api/src/store.ts` (near `setActual`, ~line 748)
- Test: `apps/api/test/store.test.ts`

**Interfaces:**
- Produces: `recordDecisionReason(tag, mode, action, reason, nowMs)` and `appendDecisionAction(tag, mode, entry, nowMs)`

- [ ] **Step 1:** `recordDecisionReason` — `$set { lastAction, lastReason, lastReasonAt }`. No upsert: a reason for a book with no registry row is meaningless.
- [ ] **Step 2:** `appendDecisionAction` — `$push` with `$slice: -200` onto `actionLog`.
- [ ] **Step 3:** Test the cap holds at 200 and keeps the NEWEST.
- [ ] **Step 4:** Commit.

### Task 3: Route handler wiring

**Files:**
- Modify: `apps/api/src/routes/desk.ts:121`

- [ ] **Step 1:** After validation, before `applyDecision`, write the current reason (so replays refresh it).
- [ ] **Step 2:** After `applyDecision`, append to the log when `result.fills.length > 0` and `!result.replayed`.
- [ ] **Step 3:** Wrap both in try/catch that logs and swallows — a telemetry write must never fail a decision.
- [ ] **Step 4:** Commit.

### Task 4: Read endpoint

**Files:**
- Modify: `apps/api/src/routes/desk.ts`

- [ ] **Step 1:** `GET /v1/desk/decisions?tag=&mode=` returning `{ lastReason, lastAction, lastReasonAt, actions[] }`, oldest-first.
- [ ] **Step 2:** 400 on missing tag/mode, `{}`-shaped empty result for an unknown book (not a 404 — a new book is normal).
- [ ] **Step 3:** Commit.

### Task 5: Web panel

**Files:**
- Modify: `apps/web/src/strategies.tsx`, `apps/web/src/api.ts`

- [ ] **Step 1:** Fetch the endpoint on the existing poll cadence.
- [ ] **Step 2:** Render NOW (timestamp + action + reason) and ACTIONS (oldest-first, "(nothing since)" when empty).
- [ ] **Step 3:** Empty state "no reason recorded" so a pre-feature book is distinguishable from a broken one.
- [ ] **Step 4:** `npm run typecheck`; commit.

### Task 6: Python side

**Files:**
- Modify: `sensibull_tools/live/desk/driver.py:_route` (on the server)

- [ ] **Step 1:** Add `"action": exec_dec.get("action")` and `"reason": exec_dec.get("reason")` to `payload`.
- [ ] **Step 2:** Restart `desk-supervisor-live` and verify in Mongo. NOTE: restarting the supervisor is safe (it does NOT square off); restarting `desk-runner` is NOT.
