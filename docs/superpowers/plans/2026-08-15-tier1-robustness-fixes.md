# Tier-1 Robustness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Tier-1 findings of the 2026-08-15 audit (F-7, F-37, F-8, F-9, F-10, F-11, F-21, F-22, F-25, F-24, F-47) — the "before the next live session" set.

**Architecture:** Four independent work packages, one per subsystem (runner / order-gateway / api / web+make), each TDD'd with the repo's existing harnesses (`node --test` for backend, vitest for web). No cross-package interface changes; no Python-contract changes.

**Tech Stack:** Node 24 type-stripped TS, node:test, vitest+jsdom, Mongo 3.7.3 driver (fakes in tests).

**Spec:** `context/14-robustness-audit-2026-08-15.md` (findings F-7…F-47) + `context/00-live-system-map.md`.

## Global Constraints

- Match surrounding comment style: comments state constraints/why, never narrate the change.
- Tests: backend tests are `node --test` files under `apps/<app>/test/*.test.ts` using injected fakes (see `apps/runner/test/runner-exit.test.ts`, `apps/order-gateway/test/queue.test.ts` for patterns). Web tests are vitest (`npm run test --workspace @algomaker/web -- <file>`).
- Run ONLY your package's tests while iterating (`node --test apps/<app>/test/<file>.test.ts`); the orchestrator runs the full `make check` at the end.
- Never weaken an existing test to make a change pass. Never touch files outside your WP's list.
- All behavior changes must keep the paper rail and simulate mode working identically except where specified.

---

### Task WP-A: Runner — re-entrancy, parallel stopAll, SIGTERM inversion (F-7, F-37, F-8)

**Files:**
- Modify: `apps/runner/src/runner.ts`
- Modify: `apps/runner/src/main.ts:550-595` (shutdown)
- Modify: `apps/runner/src/order-gateway.ts` (flattenAll re-entry guard)
- Modify: `ecosystem.desk.config.cjs:97,182-184`
- Modify: `scripts/deploy.sh:17-19` (stale comment only)
- Test: `apps/runner/test/runner-reentrancy.test.ts` (new), extend `apps/runner/test/runner-exit.test.ts`

**Interfaces:** No exported signature changes. New env var `DESK_SQUAREOFF_ON_STOP` read in `main.ts`.

**A1 — re-entrancy guards (F-7).** In `Runner` (`apps/runner/src/runner.ts`):
- Add private fields `#ticking = false`, `#syncing = false`. At the top of `tick()`: `if (this.#ticking) return; this.#ticking = true` and wrap the body in `try { … } finally { this.#ticking = false }`. Same shape for `sync()` with `#syncing`. Copy the rationale style from `MirrorHost.sync` (`apps/runner/src/mirrors.ts:119-141`), which guards the identical hazard.
- Add `stopping: boolean` to the `Supervised` interface (init `false` in `sync()`'s creation site, line ~402). At the top of `#stopOne`: `if (s.stopping) return; s.stopping = true` with `try { … } finally { s.stopping = false }` around the whole body. This is the guard that matters: `#stopOne` writes `state`/`retryExitAtMs` only on return, so without it a second tick re-enters mid-flatten and reverses the same legs again (the audit's F-7 scenario).
- In `HttpOrderGateway.flattenAll` (`apps/runner/src/order-gateway.ts`), add a `#flattening = false` guard: a second call while one is in flight returns immediately without placing anything (log `flatten already in progress, skipping re-entry`). The ledger is shared state between overlapping flattens; two concurrent passes each read the same open legs.

**A2 — failing test first.** New `apps/runner/test/runner-reentrancy.test.ts`, using the same fixture style as `runner-exit.test.ts` (synthetic clock, fake `loadRows`, fake `positions` backstop):
```ts
test('concurrent day-end ticks flatten exactly once', async () => {
  // clock at day end; positions.flattenAll resolves only when released,
  // and counts calls per tag:mode.
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const runner = new Runner({
    clock, log, factory,
    loadRows: async () => [row('T1', 'paper')],
    positions: {
      openCount: () => (calls > 0 ? 0 : 1),
      flattenAll: async () => { calls++; await gate },
    },
  })
  await runner.sync()
  const t1 = runner.tick()   // enters #stopOne, blocks on gate
  const t2 = runner.tick()   // must be a no-op (guard), not a second flatten
  release()
  await Promise.all([t1, t2])
  assert.equal(calls, 1)
})
```
Also: `test('stopAll on a slow instance still attempts the others', …)` — three instances, the first's `flattenAll` hangs 50ms; assert all three were attempted (i.e. `Promise.allSettled`, not serial abandonment), using per-tag call recording.

**A3 — parallel stopAll (F-37).** Replace the serial loop in `stopAll` (`runner.ts:575-578`) with:
```ts
async stopAll(reason: string): Promise<void> {
  // allSettled, not a serial for-await: instances share no mutable state (the
  // file's own invariant), and a 15s shutdown fuse must not mean the tags at
  // the back of the map are never even attempted.
  await Promise.allSettled(
    [...this.#supervised.values()].map((s) => this.#stopOne(s, reason)),
  )
  await this.#publish()
}
```
(`#stopOne` already contains its own errors per instance; `allSettled` is belt-and-braces so one rejection cannot abandon the rest.)

**A4 — SIGTERM inversion (F-8).** In `main.ts` `shutdown()`:
- Compute `const squareOff = process.env['DESK_SQUAREOFF_ON_STOP'] === '1'`.
- When `squareOff` is true: keep the existing behavior verbatim (stopAll → stranded log → exit).
- When false (the new default): do NOT call `runner.stopAll`. Instead: log every instance whose ledger is non-empty (`runner.snapshots().filter(s => s.openPositions > 0)`) as `runner: <tag> (<mode>) holds N position(s) — NOT squared off (deploy-safe stop); state is durable and resumes on restart`, still call `mirrorHost.stopAll` (it only unsubscribes), then `mongo.close()` and `process.exit(0)`. Rationale to state in the comment: the ledger and strategy state are durable and `onRecover()` exists, so a mid-session restart resumes; the EOD flatten lives in the tick path at 15:30 where it belongs; pm2's `max_memory_restart` and every `pm2 restart` reach this handler, so flatten-by-default turned an unattended memory bounce into a book-flattening event.
- Before the 15s hard-exit timer fires, it must log the same non-empty-ledger list (move the stranded-tag computation into a small function called from both places) so a truncated shutdown still names what is open.
- Update the big comment block above `shutdown` to describe the new default.

**A5 — ecosystem + deploy.sh.** In `ecosystem.desk.config.cjs`: give `desk-runner`'s `app(...)` extra `{ kill_timeout: 20_000, max_memory_restart: '1500M' }` and add one comment line: the default 600M was an unattended path into a mid-session stop, and the runner's quote cache legitimately grows all session. In `scripts/deploy.sh:17-19` correct the stale consequence text: a mid-session bounce no longer squares off by default (`DESK_SQUAREOFF_ON_STOP=1` restores that); it stops without flattening and resumes on restart.

**A6 — extend `runner-exit.test.ts`** with one test: `stopAll` still flattens (the EOD/registry-switch-off path is unchanged); and a `main.ts`-level test is NOT required (signal wiring stays untested this pass — the logic moved behind `squareOff` is trivial and `stopAll` itself is proven).

**Steps:** write A2 tests → run, confirm FAIL → implement A1+A3 → tests pass → implement A4+A5 (no test) → run the whole `node --test apps/runner/test/` suite → done. Do not commit (the orchestrator commits).

---

### Task WP-B: Order-gateway — kill switch, age gate, idempotent reclaim (F-9, F-10, F-11)

**Files:**
- Modify: `apps/order-gateway/src/queue.ts`
- Modify: `apps/order-gateway/src/main.ts:668-791` (`processOne`)
- Test: `apps/order-gateway/test/queue.test.ts` (extend), `apps/order-gateway/test/process-guards.test.ts` (new)

**Interfaces (produced):**
- `OrderQueue.markPlacing(clientOrderId): Promise<void>` — `$set { placementStartedAt: now }`, `$inc { placeAttempts: 1 }`.
- `OrderQueue.heartbeat(clientOrderId): Promise<void>` — `$set { claimedAt: now }`.
- `CLAIM_TIMEOUT_MS` raised `60_000 → 180_000` with the comment updated: it must exceed worst-case placement (3 attempts × 15s timeout × several tranches), and the placement loop now heartbeats the claim per tranche.

**B1 — env + gates in `processOne` (F-9).** After the existing Gate 2 `allowsLive` block (main.ts:730-743), add Gate 3 and Gate 4. Wire the safety collection at boot next to `allowsLive`: `const safety = mongo.db.collection('desk-safety')`.
```ts
// Gate 3: the kill switch, read HERE as well as in the bridge. The bridge
// checks at write time, so an order already queued when the halt engages —
// or orphaned by a gateway outage — used to be placed anyway on the next
// sweep. Same governing rule as apps/api/src/safety.ts: a halt stops NEW
// EXPOSURE and never blocks an exit, and the only exposure signal this
// process has is the doc's desk_op.
if (order.desk_op === 'open') {
  let halted = false
  let haltReason = ''
  try {
    const ks = await safety.findOne({ _id: 'killswitch' } as never)
    halted = (ks as { enabled?: boolean } | null)?.enabled === true
    haltReason = String((ks as { reason?: string } | null)?.reason ?? '')
  } catch {
    // Fails closed for exposure-adding orders, like every other gate here.
    halted = true
    haltReason = 'kill-switch state unreadable'
  }
  if (halted) {
    const reason = `kill switch engaged${haltReason === '' ? '' : ` (${haltReason})`}; queued order not placed`
    await journal.record({ clientOrderId, phase: 'FAILED', ok: false, tag: order.tag,
      tradingsymbol: order.tradingsymbol, ts: Date.now(), error: reason, errorClass: 'fatal' })
    await queue.markInvalid(clientOrderId, reason)
    log(`HALTED ${order.tradingsymbol} [${clientOrderId}]: ${reason}`)
    return
  }
}
// Gate 4: a stale queued order is refused, not placed at any price. Its
// marketable limit was priced off a mark that is now maxAge old; the writer's
// own retry/replay machinery re-plans with fresh pricing, whereas placing it
// executes a price nobody chose. Applies to exits too, deliberately — a
// refused exit is re-planned and retried loudly, a stale-priced exit rests.
const createdAt = Number(doc['createdAt'] ?? 0)
const maxAgeMs = Number(process.env['DESK_ORDER_MAX_AGE_MS'] ?? 180_000)
if (createdAt > 0 && Date.now() - createdAt > maxAgeMs) {
  const reason = `order is ${Math.round((Date.now() - createdAt) / 1000)}s old (limit ${Math.round(maxAgeMs / 1000)}s) — refused as stale, re-submit for fresh pricing`
  await journal.record({ clientOrderId, phase: 'FAILED', ok: false, tag: order.tag,
    tradingsymbol: order.tradingsymbol, ts: Date.now(), error: reason, errorClass: 'fatal' })
  await queue.markInvalid(clientOrderId, reason)
  log(`STALE ${order.tradingsymbol} [${clientOrderId}]: ${reason}`)
  return
}
```
`GatewayOrderDoc` (in `gateway.ts`) may need `desk_op?: string` added to its type — `rail.ts:102` already writes it (`desk_op: fill.op`). Simulate mode: both gates apply there too (fine — the simulator honors INVALID identically).

**B2 — idempotent reclaim (F-10).** At the top of `processOne`, before planning:
```ts
// A reclaimed order whose previous attempt already began placing must NEVER
// be re-placed wholesale: tranche 1 may be live at the broker, and the
// truncated correlation id cannot dedup it (queue.ts documents why). The
// placementStartedAt marker is written before the first tranche goes out, so
// its presence on a claim means "a placement was interrupted" — resolve from
// the journal instead of placing again.
if (doc['placementStartedAt'] !== undefined) {
  await recoverInterrupted(doc, clientOrderId)
  return
}
```
`recoverInterrupted` (new function beside `processOne`): re-derive the plan exactly as `processOne` does (same `planOrder` call — tranche ids are deterministic). For each planned tranche id, query the journal collection (`mongo.db.collection(ORDER_EVENTS_COLLECTION)`) for that id's events. Tranches with an `ACK` event contribute their `brokerOrderId` to `brokerOrderIds`; every other tranche goes into `failedTrancheIds` and gets one loud journal line: `phase: 'FAILED', ok: false, error: 'placement interrupted before this tranche ACKed — outcome unknown, check the broker orderbook before re-submitting', errorClass: 'fatal'`. Then `markPlaced` with those arrays + `expectedQty` from the plan, and `fills.reconcile(clientOrderId)`. If `placeAttempts >= 3`, skip recovery and `markInvalid(clientOrderId, 'dead-lettered after 3 interrupted attempts — check the broker orderbook')`. This path places NOTHING — under-reporting an ambiguous tranche is recoverable (the fill socket/boot sweep can still land its fill later; `fills.ts` dedup makes that safe), double-placing is not.

**B3 — heartbeat + marker in the placement loop (F-10/F-11).** In `processOne`, immediately before the `for (const intent of plan.intents)` loop: `await queue.markPlacing(clientOrderId)`. Inside the loop, after each tranche's try/catch: `await queue.heartbeat(clientOrderId)` (extends the claim so a slow multi-tranche placement cannot be reclaimed mid-flight — scenario B of F-10). Wrap everything in `processOne` AFTER the claim (from `planOrder` on) in try/catch: on a throw before `markPlacing` ran → `await queue.markInvalid(clientOrderId, 'processing threw: <msg>')` then rethrow is NOT needed (sweeper logs) — just log; on a throw after `markPlacing` (e.g. `markPlaced` itself failed) → log CRITICAL and leave the doc CLAIMED: the marker now routes the next reclaim into `recoverInterrupted` instead of a re-place, which converts the old unbounded duplicate loop into a bounded recovery. State the conversion in the comment.

**B4 — tests.** Extend `queue.test.ts` (it has a fake `QueueCollection`): `markPlacing` sets `placementStartedAt` and increments `placeAttempts`; `heartbeat` refreshes `claimedAt` so a subsequent `claimNext` at `now < claimedAt + CLAIM_TIMEOUT_MS` does NOT reclaim it. New `process-guards.test.ts`: build `processOne` indirectly is hard (it's a closure in `main`) — so instead test the exported pure/behavioral seams: move the age-check decision into a small exported pure function in `queue.ts`:
```ts
/** Refuse a queued order older than maxAgeMs — its price is stale. */
export function isStaleOrder(createdAt: number, nowMs: number, maxAgeMs: number): boolean {
  return createdAt > 0 && nowMs - createdAt > maxAgeMs
}
```
and use it in `processOne`. Tests: fresh order not stale; 181s-old order stale at 180s limit; `createdAt: 0`/absent never stale (legacy docs must not be mass-refused). For the kill-switch gate and recovery path, add integration-style tests ONLY if `apps/order-gateway/test` already has a harness that runs `processOne` (check `gateway.test.ts` / `rail-contract.test.ts`); if not, cover `recoverInterrupted`'s journal-partition logic by extracting it as an exported function taking `(plannedTrancheIds, ackEventsByTrancheId)` and unit-testing: 3 tranches, ACK on #1 only → brokerOrderIds=[id1], failed=[#2,#3].

**Steps:** write B4's queue tests → FAIL → implement queue methods + `isStaleOrder` → PASS → implement B1/B2/B3 in main.ts → extract + test the recovery partition → run `node --test apps/order-gateway/test/` → done. Do not commit.

---

### Task WP-C: API — flat must mean flat (F-21, F-22, F-25)

**Files:**
- Modify: `apps/api/src/decision-plan.ts` (`flattenIsFlat`, `priceFillsForRoute`)
- Modify: `apps/api/src/service.ts` (`flattenTag` — thread the new field; `closeAll` — refuse a missing book)
- Modify: `apps/api/src/routes/desk.ts:700-733` (`handleCloseAll` tag validation)
- Test: `apps/api/test/decision-plan.test.ts`, `apps/api/test/flatten.test.ts`, `apps/api/test/close-leg.test.ts` (only if signatures ripple), `apps/api/test/marketable.test.ts` (no change), new cases in `apps/api/test/flatten.test.ts`

**C1 — F-21: empty reconstruction is not flat.** Change `flattenIsFlat` (decision-plan.ts:475-487):
```ts
export function flattenIsFlat(input: {
  readonly legs: readonly FlattenLegResult[]
  readonly truncated: readonly string[]
  readonly malformedFills: readonly string[]
  readonly fillsTruncated: boolean
  /** Fills read in the window. 0 with 0 legs means the WINDOW was empty, not the position. */
  readonly fillCount: number
}): boolean {
  // An empty reconstruction proves nothing about the position: a multi-day
  // book (window defaults to today) and a seeded book (journals no fills)
  // both come back empty. `legs.every` over [] is vacuously true, and the
  // operator reading `flat: true` goes home carrying the book — the
  // NIFTY-2026-08-03 incident. Zero legs is flat ONLY when the window
  // actually contained fills that net to zero.
  if (input.legs.length === 0 && input.fillCount === 0) return false
  return (
    input.legs.every((l) => l.routed) &&
    input.truncated.length === 0 &&
    input.malformedFills.length === 0 &&
    !input.fillsTruncated
  )
}
```
In `service.ts flattenTag`, pass `fillCount` (the loaded fill array's length before partitioning) and, when the empty-window branch is what made `flat` false, add to the response `emptyWindow: true` and set the first element of a `notes`/existing message field (find the response shape in `flattenTag` — it returns `FlattenTagResult`; add optional `emptyWindow?: boolean` to it and to its consumers' type if the dashboard types it in `apps/web/src/api.ts` — update that type too, no rendering change required) so the caller learns to retry with `sinceMs: 0`. Grep for `flattenIsFlat(` call sites and update all.

**C2 — F-22: a named tag must name a real book.** In `handleCloseAll` (routes/desk.ts:701-733), replace the `bookTag = rawTag` branch:
```ts
let bookTag: string
const tags = await service.bookTagsForSymbol(symbol, body['mode'])
if (typeof rawTag === 'string' && rawTag !== '') {
  // The dashboard always sends the tag, so this branch is the hot path — and
  // it used to skip the no-such-book refusal entirely: a mistyped tag loaded
  // an empty book, closed nothing, answered 200 DONE, and upserted a phantom
  // row under the typo. The guard below is the same 409 the tagless path
  // already earned.
  if (!tags.includes(rawTag)) {
    log('CLOSE-ALL REFUSED', { symbol, mode: body['mode'], tag: rawTag, reason: 'unknown tag' })
    send(409, {
      error:
        `no ${body['mode']} book '${rawTag}' on ${symbol}: NOTHING WAS CLOSED. ` +
        `Check the tag${tags.length > 0 ? ` — this symbol's books are: ${tags.join(', ')}` : ''}.`,
      symbol, mode: body['mode'], candidates: tags,
    })
    return true
  }
  bookTag = rawTag
} else { …existing zero/many refusals unchanged, using the `tags` already loaded… }
```
Belt-and-braces in `service.closeAll` (service.ts:830): after `bookDoc`, `if (doc === null) throw new Error(\`close-all: no ${params.mode} book stored under tag '${params.tag}' — nothing to close\`)` — with a comment that `saveBook` upserts, so proceeding would mint a phantom row with a blank expiry (the corruption `service.ts:823-829` documents). Check what the route does with a thrown service error (grep the route wrapper for the 500 path) — if it 500s, that is acceptable for this internal-guard layer since the route-level 409 is the real UX.

**C3 — F-25: MARKET exits become marketable limits.** In `priceFillsForRoute` (decision-plan.ts:85-106), change the `pricing`-present branch so a MARKET entry falls through to the marketable pricer instead of passing through:
```ts
return fills.map((f) => {
  const p = pricing.get(f.deskTag)
  if (p === undefined || p.orderType === 'MARKET') {
    // 'fast' close-all and degraded-to-MARKET legs used to pass through as
    // MARKET — which the broker REJECTS (marketable.ts:8), so the emergency
    // path was the one path guaranteed not to fill. When marketable pricing
    // is configured, 'fast' means the widest crossing limit we can compute;
    // an unusable mark still returns null and the fill goes out unchanged.
    if (marketable === undefined) return f
    const limitPrice = marketableLimit(f.side, f.price, marketable)
    return limitPrice === null ? f : { ...f, orderType: 'LIMIT' as const, limitPrice }
  }
  return {
    ...f,
    orderType: p.orderType,
    ...(p.limitPrice === undefined ? {} : { limitPrice: p.limitPrice }),
  }
})
```
Note this changes paper-rail bookkeeping only cosmetically (paper books at `f.price` regardless) and does not touch the no-pricing branch.

**C4 — tests first.** In `apps/api/test/decision-plan.test.ts` add:
```ts
test('flattenIsFlat: empty reconstruction over an empty window is NOT flat', () => {
  assert.equal(flattenIsFlat({ legs: [], truncated: [], malformedFills: [], fillsTruncated: false, fillCount: 0 }), false)
})
test('flattenIsFlat: zero legs with fills that netted to zero IS flat', () => {
  assert.equal(flattenIsFlat({ legs: [], truncated: [], malformedFills: [], fillsTruncated: false, fillCount: 4 }), true)
})
test('priceFillsForRoute: a MARKET pricing entry is re-priced as a marketable limit', () => {
  const fills = [{ op: 'close', deskTag: 't1', tradingsymbol: 'X', side: 'Buy', qty: 75, price: 100, ts: 1 }] as const
  const pricing = new Map([['t1', { orderType: 'MARKET' as const }]])
  const out = priceFillsForRoute(fills as never, pricing, { bufferPct: 0.02, minTicks: 2, tick: 0.05 })
  assert.equal(out[0]?.orderType, 'LIMIT')
  assert.ok((out[0]?.limitPrice ?? 0) > 100)  // Buy crosses UP through the mark
})
test('priceFillsForRoute: MARKET entry with no marketable config passes through', () => { … expect unchanged … })
```
(Adjust the `MarketableConfig` field names to whatever `marketable.ts` exports — read it first.) In `flatten.test.ts` add a case: a flatten over a window with zero fills answers `flat: false` and `emptyWindow: true`; and existing tests that constructed `flattenIsFlat` inputs get `fillCount` added (use a value consistent with each test's fixture). In the route tests (`server.test.ts` covers routes when Mongo is up — do NOT rely on it): the 409-unknown-tag guard gets its test only if a Mongo-free harness exists for `handleCloseAll`; otherwise it is covered by the service-level throw test in `flatten.test.ts`-style fixtures if those run without Mongo (check the file's imports first; `flatten.test.ts` is 1508 lines of Mongo-free fixture tests — follow its pattern).

**Steps:** read `marketable.ts` + `flattenTag` in `service.ts` fully first → write C4 tests → FAIL → implement C1/C3 (pure) → PASS → implement C2 + response threading → run `node --test apps/api/test/decision-plan.test.ts apps/api/test/flatten.test.ts apps/api/test/marketable.test.ts apps/api/test/close-leg.test.ts apps/api/test/submit-plan.test.ts` → done. Do not commit.

---

### Task WP-D: Web fetch timeout + honest `make up` (F-47, F-24)

**Files:**
- Modify: `apps/web/src/api.ts:398-415` (`request`)
- Modify: `Makefile:1-14,48-57` (header + `up` target)
- Test: `apps/web/test/http.tsx`-adjacent — add to an existing suitable web test file or create `apps/web/test/timeout.test.tsx`

**D1 — timeout.** In `request()`:
```ts
/**
 * Hard deadline on every request. A hung connection (wedged bridge, dropped
 * NAT mapping) never rejects on its own, so without this the catch below
 * never runs, `usePoll` never sets its error, and the dashboard renders
 * last-good numbers forever while claiming to refresh — the exact failure
 * the stale-notice machinery exists to surface.
 */
const res = await fetch(`${BASE}${path}`, {
  method,
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  …existing options unchanged…
})
```
with `export const REQUEST_TIMEOUT_MS = 8_000` near the top (exported so the test can assert against it). Convert the abort into a readable error: wrap the `fetch` call in try/catch; on `err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')` throw `new ApiError(0, \`no response after ${REQUEST_TIMEOUT_MS / 1000}s — the desk API is not answering\`, false)` (check `ApiError`'s constructor arity at its definition in this file and match it); rethrow anything else.

**D2 — web test.** Vitest, jsdom (follow `apps/web/test/` conventions, `setup.tsx` import if the others use it): stub `globalThis.fetch` with `vi.fn()` capturing its second argument; call any simple GET via the exported client (or export `request` indirectly — if nothing suitable is exported, test through `api.orderEvents`-style smallest call); assert `fetch` was called with `options.signal instanceof AbortSignal`. Second test: make the fetch stub reject with `new DOMException('The operation timed out', 'TimeoutError')`; assert the thrown error is an `ApiError` whose message names the timeout (and NOT a raw DOMException).

**D3 — Makefile.** Fix the header lines 6 and 12-14: `make up` starts with whatever broker `.env.local` resolves (`DESK_BROKER`, default simulate) — the old "safe by construction / only make live changes that" claim is false since `ecosystem.desk.config.cjs:149` let `.env.local` win (by design — a live box must stay armed across restarts). Rewrite `up`:
```make
up: mongo-up ## Start everything (broker mode from .env.local; default simulate)
	@mkdir -p logs
	@mode=$$(grep -E '^DESK_BROKER=' .env.local 2>/dev/null | tail -1 | cut -d= -f2-); \
	mode=$${mode:-simulate}; \
	if [ "$$mode" != "simulate" ] && [ "$(FORCE)" != "1" ]; then \
	  echo ""; \
	  echo "  .env.local sets DESK_BROKER=$$mode — this start ARMS THE REAL BROKER."; \
	  printf "  Type '$$mode' to continue (or FORCE=1 to skip this check): " && read ans && [ "$$ans" = "$$mode" ]; \
	fi
	# --update-env is REQUIRED: pm2 keeps the previous process definition and
	# will not re-read the ecosystem's env on a restart without it, so an edited
	# .env.local (or a changed broker mode) is silently ignored.
	$(PM2) startOrRestart $(ECO) --update-env
	@mode=$$(grep -E '^DESK_BROKER=' .env.local 2>/dev/null | tail -1 | cut -d= -f2-); \
	echo ""; \
	echo "  desk up (broker: $${mode:-simulate}). Feed needs ~90s to warm up."; \
	echo "  make status   check readiness"; \
	echo "  make logs     follow"
```
(Beware: recipe comments with `#` inside shell lines are fine; keep tabs. `FORCE=1` bypass exists because `scripts/deploy.sh` may invoke restart paths non-interactively — check whether deploy.sh calls `make up` or pm2 directly; if it calls pm2 directly, note that in the commit message and leave it.) `restart` keeps its behavior but its help text gains `(broker mode from .env.local)`.

**Steps:** write D2 tests → FAIL → implement D1 → PASS (`npm run test --workspace @algomaker/web -- timeout`) → D3 (verify with `make -n up` that the recipe parses) → run `npm run typecheck --workspace @algomaker/web` → done. Do not commit.

---

## Self-review notes
- Spec coverage: F-7→A1/A2, F-37→A3, F-8→A4/A5, F-9→B1, F-10→B2/B3, F-11→B3, F-21→C1, F-22→C2, F-25→C3, F-47→D1/D2, F-24→D3. All Tier-1 items covered.
- Type consistency: `flattenIsFlat` gains `fillCount` — every call site (service.ts + tests) must be updated in WP-C; no other WP touches it. `GatewayOrderDoc.desk_op` addition is WP-B-local.
- The orchestrator (not the WP agents) runs `make check`, reviews diffs, commits, pushes, deploys.
