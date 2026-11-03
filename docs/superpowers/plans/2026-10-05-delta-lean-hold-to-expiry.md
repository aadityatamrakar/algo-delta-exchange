# Delta-lean hold-to-expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weekly delta-lean books (aggressive and conservative) that open the first day after expiry and hold to expiry or to target, created and retired by the roll.

**Architecture:** One new dial `dl_hold_to_expiry` gates three engine behaviours (clock exits only on expiry day, open once, exits latch for the book's life); the roll creates the pair per front expiry and retires by expiry. Two branches: engine+presets+supervisor, and roll+scripts+runbook; they meet only on the dial name and the two preset keys.

**Tech Stack:** Node 24 `node --test`, TypeScript, ESM `.mjs` scripts.

**Spec:** `docs/superpowers/specs/2026-10-05-delta-lean-hold-to-expiry-design.md`

## Global Constraints
- Paper only; never parse a tag; membership by `dl_hold_to_expiry`.
- Worktrees: own `npm ci`; api Mongo suites one file at a time with a unique `DESK_TEST_MONGO`; never `npm test`/`make check` in a worktree; no desk contact.
- Contract between the branches: dial `dl_hold_to_expiry` (boolean, default false, in the delta-lean dial schema), preset keys `delta-lean-hold-aggressive` / `delta-lean-hold-conservative`, `DeltaLeanInputs.expiry: string` (ISO date).

## Review Focus
1. A hold book that wakes after 15:00 on a NON-expiry day still carrying: no exit (intraday would ladder). Engine test.
2. A hold book on expiry day: full ladder at 14:50/14:55/15:00, and `dlStopped` afterwards survives the next `rollDay`. Engine test.
3. Roll on an expiry morning: no hold book created for a contract dying today; the previous hold book (expiry = today) is NOT retired until tomorrow. Roll test.
4. Roll excludes hold rows from the creation-day retire; an intraday row with the dial absent is still retired. Roll test.
5. Registration payload pins the dial so an API that resolves unknown dials away is caught (registration test).

### Task A: engine, presets, supervisor (branch `hold-engine`)
Files: `packages/desk-engine/src/dials.ts` (or wherever `dl_*` are declared and defaulted), `types.ts` (RuleState untouched; `DeltaLeanInputs.expiry`), `delta-lean/lean.ts` (`rollDay(state, dateIst, nowMs, hold)`), `delta-lean/decide.ts` (clock gate, open-once, book-life exits + reasons), `presets.ts` (two presets), `apps/supervisor/src/engine-host.ts` (pass `expiry` into inputs), tests under `packages/desk-engine/test/` and `apps/supervisor/test/`. Done when the Review Focus 1–2 tests exist and every existing engine/supervisor test is green unchanged.

### Task B: roll, scripts, runbook (branch `hold-roll`)
Files: `scripts/delta-lean-books.mjs` (`planHoldBooks(expiries, today)` → the pair per symbol with `series`, exported `HOLD_PRESET_KEYS`, `isHold(row)` by dial), `scripts/delta-lean-roll.mjs` (create loop for hold pairs after the daily four; exclude hold rows from the day retire; a hold-retire loop by expiry reusing the fourth loop's vocabulary; `BookPlan.series` typedef), `apps/api/test/delta-lean-roll.test.ts`, `apps/api/test/delta-lean-registration.test.ts`, `docs/runbooks/delta-lean-paper.md` (§7 hold books). Done when Review Focus 3–5 tests exist and the recorded-call order test pins creates → stops → erases including hold rows.

## Orchestrator
- [ ] Dispatch A and B in parallel; review each; merge B then A (A touches shared engine files); `make check`; push; hand over (no restart needed for the roll; the engine change needs the supervisor restart).
