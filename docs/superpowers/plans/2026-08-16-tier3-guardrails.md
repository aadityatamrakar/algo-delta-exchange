# Tier-3 Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier 3 of `context/14-robustness-audit-2026-08-15.md`: operator-facing guardrails (F-29/30/33/34), scheduled ops that were manual (F-12/13), shared crash resilience (F-41/42), the mirror-leg self-heal (F-6), the risk module decision (F-28), CI (F-48), plus the two hardenings earned in Tier 2 (fold nonce; `recoverInterrupted`→ambiguous).

**Architecture:** Five parallel work packages with strict file ownership. Where two WPs share a file (`apps/api/src/main.ts`, api test files), each keeps its edits localized to its named regions — the Tier-2 pattern.

**Spec:** `context/14-robustness-audit-2026-08-15.md` (F-numbers above) + the Tier-2 verifier's residual note (fold crash window) + WP-E's residual note (recoverInterrupted).

## Global Constraints
Same as Tiers 1-2 (comment style, TDD RED-first, targeted runs, never weaken a test, money-path prime directives: reductions only, paper untouched by reconcilers, journal everything, idempotent, `.catch`+single-flight on intervals, `positiveEnvMs` for every new duration knob).

---

### WP-I: API guardrails + dials/seed attribution (F-29, F-30, F-33, F-34)

**Files:** `apps/api/src/routes/books.ts`, `apps/api/src/routes/desk.ts` (dials/seed/close-all-aggression regions only), `apps/api/src/books-registry.ts`, `apps/api/src/seed.ts`, `apps/api/src/validate.ts`, `apps/web/src/books.tsx` (dials re-auth), `apps/web/src/api.ts` (patchDials password param only) + tests (`books-registry.test.ts` additions, `book-build/books` web tests, new cases in existing route suites).

- **F-29 dials:** `PATCH .../dials` on `mode==='live'` requires re-auth exactly like the strategy live switch (`gate.reauth` → `403 reauthRequired:true`; find the pattern at `routes/desk.ts:926,1114`). Validate keys against the union of the variant catalogue's `defaults` for the book's variant (load via the registry row's variant → `desk-variants`) — unknown key → 400 naming it; reject keys containing `.` or `$`; values must be finite numbers or booleans matching the current/default value's type. Persist `dialsSetBy` (principal name) + `dialsSetAt` on the row; log values, not just key names. Web: `patchDials` goes through the existing `withReauth` machinery (copy `strategies.tsx:112-169`'s flow) so the password dialog appears for live books; paper books unchanged.
- **F-30 seed:** `POST /v1/desk/seed` with `mode:'live'` OR `replace:true` requires `gate.reauth` (machine principals therefore can never do it — `authsvc` refuses machine reauth, state that); `replace:true` additionally refuses (409) while the fills-derived position for the tag is non-zero (reuse the delete guard's `openNow`-style reconstruction in `routes/books.ts:280-288` — and take its malformed/truncated flags seriously per F-32, which this partially covers: return 409 when they're set).
- **F-33:** `DELETE …/registry/:tag?flatten=1` derives `decisionId = \`delete-flatten-${tag}-${mode}-${istDate(now)}\`` (deterministic per day) instead of `now()`; comment cites the retried-click double-flatten.
- **F-34:** `aggressionPct` validated finite and in `[0, 0.25]` at all three call sites (`routes/desk.ts` two, `routes/books.ts` one) — 400 with the range in the message.

### WP-J: Ops wiring — freeze sync, enctoken canary, shared resilience (F-12, F-13, F-41-part)

**Files:** `apps/marketdata/src/{main.ts,sync-runner.ts,book-margin/kite.ts,feed-recovery.ts(if needed)}`, `packages/core/src/resilience.ts` (new — moved from gateway), `apps/order-gateway/src/resilience.ts` (becomes a re-export), `apps/api/src/main.ts` (install guards + connectWithRetry — top-of-main region ONLY), `apps/api/src/livebook.ts` (the missing `.catch` on the reconcile interval at ~269) + tests.

- **F-12:** marketdata's daily `sync()` also runs `syncFreezeLimits` (fail-soft, keeps previous table on error — it already does); `md.health` gains `freezeSyncDay`; Status card (`routes/system.ts`) is WP-I/none's file — do NOT touch it; the health payload addition is enough.
- **F-13:** a periodic REST canary on the health timer cadence but paced to every `DESK_ENCTOKEN_CANARY_MS` (default 120_000, positiveEnvMs): one cheap authenticated Kite REST call using the existing session (pick the cheapest call the vendored client exposes — read `zerodha-login.ts`/the session object; a 1-instrument `historyData` for today is acceptable), routed through `recovery.trigger(...,'token')` on a token rejection and `recovery.noteTokenAccepted()` on success; publish `enctokenLastVerifiedAt` on `md.health`. Skip the canary entirely outside 08:30–16:00 IST (a weekend 401 must not thrash logins). Widen `isTokenRejection` (`book-margin/kite.ts:~138`) to also match `status 403 && /token/i.test(body)`.
- **F-41:** move `installCrashGuards`/`connectWithRetry` to `packages/core/src/resilience.ts` verbatim (keep the G4/G6 war stories); gateway's file re-exports them (its imports unchanged); install both in `apps/api/src/main.ts` (guards first line of main; connectMongo → connectWithRetry). Do NOT touch `apps/runner` (WP-K owns it). Add the `.catch` to `LiveBook`'s reconcile interval.

### WP-K: Mirror self-heal + runner resilience (F-6, F-41-runner)

**Files:** `apps/runner/src/{main.ts,mirrors.ts,order-gateway.ts}`, `packages/strategies/src/external-signal-mirror/adapter.ts`, `apps/api/src/routes/runner.ts` (new) + its registration (ONE line where routes are registered — find it; keep the edit minimal), `apps/api/src/store.ts` is NOT yours (WP-L owns it) — read `desk-strategy-state` via a narrow collection port in the new route file + tests.

- **F-6a expiry sweeper:** `LedgerEntry` gains optional `expiry` (ISO date, recorded at `apply()` from `instrument.expiry` when present); `PositionLedger.dropExpired(todayIst): DroppedEntry[]` removes entries whose expiry is strictly before today, returns them; the runner calls it for every ledger at boot (after load) and on the day roll, logging each drop loudly (`expired leg swept from <tag:mode>: SYMBOL lots N — no exit can ever arrive for an expired contract`). Entries without expiry are never dropped.
- **F-6b exits are exits:** the mirror adapter marks a mirrored order `reducesExposure: true` when its side reduces the ledger's current net for that symbol (thread the ledger's net via the gateway/adapter seam — read how the adapter submits today); and **F-6c:** refuse (log + skip) a mirrored order that would take the symbol PAST flat (quantity fabrication guard).
- **F-6d audited clear:** new `GET /v1/desk/runner/positions` (operator or machine) listing every `runner:positions` doc (tag, mode, entries); `POST /v1/desk/runner/positions/clear` (OPERATOR-only + `gate.reauth`) writes a clear-request document (`desk-strategy-state`, `{tag: '<TAG>:<mode>', key: 'runner:clear-request', value: {symbols: [...]|'expired'|'all', requestedBy, requestedAt}}`); the RUNNER processes requests on its sync cadence — it owns the ledger cache, so it applies the clear through the ledger (new `PositionLedger.drop(symbols)` → `#save`), journals what it dropped, and deletes the request doc. The API never edits the ledger doc directly — single-writer preserved; state the stop-edit-start runbook this retires in the route's docstring.
- **F-41-runner:** `apps/runner/src/main.ts` installs `installCrashGuards` (import from `@algomaker/core`) and boots Mongo through `connectWithRetry` (coordinate: WP-J creates `packages/core/src/resilience.ts`; import from `@algomaker/core` — if the export isn't there yet when you start, create your import against that path anyway and note it; the orchestrator gates the combined tree).

### WP-L: Tier-2 hardenings + index self-containment (fold nonce, recoverInterrupted→ambiguous, F-42)

**Files:** `apps/api/src/{book-write.ts,reconcile-live.ts,store.ts}`, `apps/order-gateway/src/main.ts` (`recoverInterrupted`/`partitionInterruptedTranches` region only), `apps/order-gateway/src/queue.ts` (only if the partition helper lives there) + tests.

- **Fold nonce (verifier residual):** the book document gains `appliedCorrections: string[]` (capped at 200, oldest dropped). A reconciler compensating fold carries `nonce = <gateway clientOrderId>`; the fold is applied and the nonce appended **in the same `saveBook` CAS write** (extend the CAS path to carry the extra field — one document, one updateOne, no cross-collection window). Before folding, a nonce already present ⇒ the fold already landed (crash after fold, before `foldDone`) — skip straight to `markFoldDone`. `refoldOnConflict` threads the nonce. Tests: crash-window replay (fold landed, foldDone missing) does NOT double-fold; the cap drops oldest.
- **recoverInterrupted→ambiguous (WP-E residual):** tranches with a SUBMITTED journal entry but no ACK/FAILED now go to `ambiguousTrancheIds` (resolved by the Tier-2 sweep: broker trace or TTL) instead of `failedTrancheIds`; tranches with NO journal entry at all remain failed (never submitted — provably not placed). Update `partitionInterruptedTranches` + its tests; the order stays non-terminal while ambiguity is open (that is the point — the sweep answers it).
- **F-42:** `DeskStore.ensureIndexes` also creates `{clientOrderId: 1}` unique on `desk-gateway-orders` and on `desk-paper-trade` (idempotent; the gateway's own creation remains). Comment: the API's duplicate-order protection must not depend on a different process having booted first.

### WP-M: Risk limits wired + CI (F-28, F-48)

**Files:** `packages/order-bus/src/risk.ts` (read; adapt only if its shape demands), `apps/api/src/submit-plan.ts` + `apps/api/src/decision-plan.ts` (gate insertion points — read where the kill switch gates sit), `apps/api/src/main.ts` (env → config, localized), `.github/workflows/check.yml` (new), `scripts/deploy.sh` (typecheck gate), the five Mongo-gated api test files' skip sites + a new shared `apps/api/test/require-mongo.ts` helper + tests.

- **F-28 — WIRE it, opt-in:** `checkRisk` (daily loss stop, order rate limit, per-underlying/total lot caps, notional cap) becomes a gate on BOTH live routing paths (actions + submit), positioned beside the kill-switch gate, with the same governing rule: it blocks only exposure-ADDING orders, never exits (verify risk.ts:82 already encodes this; if not, wrap it so). Limits come from env (`DESK_RISK_MAX_DAY_LOSS`, `DESK_RISK_MAX_TOTAL_LOTS`, `DESK_RISK_MAX_UNDERLYING_LOTS`, `DESK_RISK_MAX_NOTIONAL`, `DESK_RISK_MAX_ORDERS_PER_MIN`) — **every limit unset = that limit disabled**, so shipping this changes nothing until the operator sets values; refusals journal with the limit and the measured value. The daily-loss input needs realized P&L — read what `pnlstore`/`LiveBook` can answer cheaply and wire the least-surprising source; if none is cheaply available per-order, gate on the 15s snapshot's last value and say so. Delete nothing from risk.ts; its tests now guard a LIVE path.
- **F-48 CI:** `.github/workflows/check.yml`: on push/PR — checkout, Node 24, mongo service container (mongo:8), `npm ci`, `make check` with `DESK_REQUIRE_MONGO=1` and the Mongo URL env the tests read. New `apps/api/test/require-mongo.ts` helper: `skipUnlessMongo(t)` → when `DESK_REQUIRE_MONGO=1`, a connection failure THROWS ('Mongo required but unreachable') instead of skipping; the five suites (`auth-routes`, `books-registry`, `brokers`, `server`, `service.integration`) call it in place of their inline `t.skip` lines (edit ONLY those lines — WP-I is appending tests elsewhere in one of these files). `scripts/deploy.sh`: run `npm run typecheck` after the pull, before the restart (fast, full-tree; comment: tests live in CI, the typecheck is the last local gate).

---

### WP-N (added mid-tier, operator request): the day guard — per-strategy daily target/stop

Per-tag `dailyLimits: {target?, stop?}` on the strategy row, edited from the Strategies page
(re-auth when the row is live-enabled). A 10s desk-api loop reads today's per-tag P&L off the
same seam `/v1/desk/pnl` uses; on `>= target` or `<= -stop` it fires ONCE per tag+mode+IST-day
(create-only record in `desk-daily-guard` = the idempotency), switches that rail off with a
`disabledByGuard` stamp, and flattens: non-mirror hosted tags via the runner's own switched-off
flatten (the tested path — never double-flattened), MIRROR tags (and tags with no runtime row)
via `flattenTag` with the deterministic `daily-guard-<tag>-<mode>-<istDate>` decisionId.
Incomplete P&L rows degrade to realised-only, loudly. Paper rails auto-re-arm next morning;
LIVE rails never auto-re-arm (it would bypass the password gate) — the UI badge says why the
switch is off. Python desk books are out of scope: they already carry `target_pnl` as a dial.

## Execution
All five in parallel (file ownership above; shared files: api `main.ts` regions J/M-localized, api test files I/M-different-lines). Orchestrator: full gate → high review → fixes → Fable verify → commit/push/deploy. Python-side deferred decisions (shift_margin_frac, sim-artifact untracking, lockfile) stay flagged for the operator — not in this tier.
