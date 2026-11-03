# Ticket 09 (Task 11) — `POST /v1/desk/engine/decisions`

**Status:** COMPLETE. Commit `390c2d59` on `worktree-agent-a107f48cc4b2c40eb`
(branched from `recenter-migration` at `df634222`).

---

## What was built

### `apps/api/src/routes/engine.ts` (new, 664 lines)

The endpoint. **It is a translator, not a second order path.** The wire's
instrument-and-share-quantity actions are turned into the desk actions
`applyDecision` already knows, and then `BridgeService.applyDecision` does
everything that matters: strategy gate, kill switch, risk caps, the
`desk-decisions` claim (record-before-route), the rails, `partitionRoutedFills`,
the compare-and-set book fold with `refoldOnConflict`, and the replay/
`#resolveRouting` machinery. Nothing in this file re-implements any of it.

Exports:

| Symbol | What |
|---|---|
| `engineRoutes(deps: ApiDeps): Route` | the route factory, mounted in `main.ts` |
| `ENGINE_DECISIONS_COLLECTION` | `'desk-engine-decisions'` — this module is its owner |
| `EngineDecisionRecord` | the stored row's shape |
| `validateDecisionRequest` | the wire validator |
| `translate` | wire actions → desk actions + pricing + skips |

**Translation rules, and what each prevents:**

1. **Contract looked up, never parsed.** Reuses `contractOf` (now exported from
   `submit.ts`) — the master's own listed strikes are walked until `resolve`
   hands back the identical symbol. A regex over the exchange packing is a guess
   an underlying ending in digits defeats.
2. **A symbol whose expiry is not this book's is REFUSED, not re-resolved.** The
   master lists `415CE` on August *and* September; taking the strike off a
   September symbol and re-resolving against an August book silently opens a
   different contract, and nothing downstream would notice. Test fixture carries
   a second expiry specifically to prove this.
3. **Leg tags come from the book.** A close/resize on a carried book finds
   `CE415#0`; only an open, which has no leg yet, is tagged with the
   tradingsymbol (stable, unique per book, and the string the next decision names
   it by).
4. **A close on a contract the book holds twice closes BOTH legs** — the wire
   addresses contracts, and closing one of two while answering "closed" is the
   worst outcome available. A **resize** across two legs is refused by name
   instead (a target quantity does not say which leg to move).
5. **An open on a held contract is emitted under the existing tag** purely so
   `applyActions` refuses it as "already open" — tagging it afresh would put a
   second leg on the contract, which the instrument-addressed wire could then
   never name again.

**Machine principals only** (like `POST /v1/desk/stream/notify`): a stolen
browser session must not be able to post a decision package. 403 otherwise.

**`decisionId` must carry its own mode** (`${tag}:${mode}:${seq}`). The contract
says the mode is in the id because paper and live are two ledgers on one tag; an
id that collided across them would let a paper replay suppress a live order. The
validator enforces the prefix — cheap, and the failure it prevents is a live one.

**Status is passed straight through** (`DONE` / `FAILED` / `ROUTING`). `WORKING`
is *not* invented here: it means "a maker quote is resting, fills arrive later",
and nothing on the gateway path can say so until Task 17/18 land. Inventing it
would tell the supervisor to wait for fills nothing is going to send.

### `apps/api/src/engine-notify.ts` (new)

`notifySupervisor(kind, payload, deps): Promise<void>` — POST to
`http://127.0.0.1:${DESK_SUPERVISOR_PORT ?? SUPERVISOR_NUDGE_PORT_DEFAULT}/nudge`,
1 s timeout on an **unref'd** abort timer, complaints rate-limited to one a
minute, **never throws or rejects**. Modelled on
`apps/order-gateway/src/notify.ts`. The nudge carries no instructions — `kind`
says which of the supervisor's reads is stale and the payload names a book; the
supervisor re-reads truth from Mongo.

Wired at the **dials PATCH** (`routes/books.ts`, after `patchBookDials`,
before the audit record). Awaited rather than fired-and-forgotten: the timeout
bounds it, a supervisor that is not running refuses the loopback connection
instantly, and an ordered log line is worth the microseconds.

### `desk-engine-decisions` (new collection)

Keeps the request **as the supervisor phrased it** — instrument, trigger, its own
words, work mode, chosen price — which the translation discards and
`desk-decisions` (the P&L ledger, which holds translated desk actions) cannot
reconstruct. Unique index on `decisionId`, created fire-and-forget at route
construction. Written with `$setOnInsert` + `$inc: {posts: 1}`, so the FIRST
post's outcome is what is stored and a replay only bumps a retry count.
Best-effort and last: the orders are already placed by that line.

### Changes to shared code (all additive, all reused rather than forked)

| File | Change | Why |
|---|---|---|
| `service.ts` | `applyDecision` gains a 4th param `reducesExposure = false`, threaded into `gateStrategy(..., { reducesExposure })` | the gate already publishes this exemption; the endpoint claims it truthfully from the book (`addsExposure`), never from a request body |
| `service.ts` | `pricing` param value widened with `workMode?` | so a work mode can travel the existing per-leg pricing channel |
| `contract.ts` | `Fill.workMode?: 'passive' \| 'urgent'` | absent is not a default — every fill this desk has routed has none |
| `decision-plan.ts` | `priceFillsForRoute` stamps `workMode` on **both** branches | a passive order with no price would otherwise reach the gateway looking ordinary and be chased across the spread |
| `rail.ts` | `orderDocument` writes `workMode` when present | Task 16's peg chaser reads it off this document |
| `submit.ts` | `contractOf` exported | one spelling of "what does `BHEL26AUG415CE` mean" |
| `desk-engine/types.ts` | `TRIGGERS` as a value; `Trigger = typeof TRIGGERS[number]` | the HTTP validator must *check* the list, and restating it would be a silent-drift copy |
| `apps/api/package.json` | `"@algomaker/desk-engine": "*"` | the wire types |

---

## Tests — `apps/api/test/engine-decisions.test.ts`, 23 tests, all passing

Real server + real Mongo (`require-mongo.ts` pattern, modelled on
`server.test.ts`). The five the brief specified, plus twelve more the
implementation turned up. The last five need no Mongo and run anywhere.

The brief's five:

- **(a)** valid paper open → 200 `DONE`, one fill with full instrument identity
  (`instrument`/`side`/`qty`/`price`, no leg tag anywhere), book folded to one
  leg at signed `-2625` with the right strike and type.
- **(b)** same `decisionId` re-posted → `replayed: true`, identical fills,
  **exactly one** order document in `desk-paper-trade`.
- **(c)** switched-off LIVE tag → open SKIPPED by `gateStrategy`; close passes
  the gate (see the finding below).
- **(d)** malformed action → 400, and `desk-decisions`, `desk-engine-decisions`,
  `desk-paper-trade` and the book are all untouched.
- **(e)** `workMode`/`limitPrice` on the **routed order document**:
  `order_type: 'LIMIT'`, `limitPrice: 12.45`, `workMode: 'passive'`.

Added:

- a `decisionId` that does not carry its mode → 400, nothing written
- non-machine principal → 403
- an unpriced action → `MARKET`, and `workMode` **absent**, not `undefined`
- unlistable instrument → skip naming it, nothing routed
- a September contract on an August book → skip naming both expiries
- a close finds a carried book's own `CE415#0` for the named contract
- resize is absolute contract quantity (3 lots → 1 lot fills 2 lots)
- switched-off PAPER tag: open skipped, **exit routes** (the exemption end to end)
- a MIXED package is not an exit — one open refuses the whole package
- an unregistered tag → 403, loudly, not a 200 that reads as a pause
- a duplicate open → refused "already open", one leg at its original size
- both journals written; a replay adds no second engine row, only `posts: 3`
- five `notifySupervisor` cases: URL/body/bearer shape, no-token → no header,
  supervisor down → resolves and logs once, rate limit at 60 s, and a
  supervisor that hangs is abandoned by the timeout

**Verification run:**

```
node --test apps/api/test/engine-decisions.test.ts   → 23/23 pass
node --test 'apps/api/test/*.test.ts'                → 1342/1343 pass
DESK_REQUIRE_MONGO=1 npm run test:node               → 2912/2913 pass
npx tsc -p tsconfig.json --noEmit                    → clean
node --test 'packages/desk-engine/test/*.test.ts'    → 35/35 pass
```

---

## Findings and concerns

### 1. A switched-off LIVE tag cannot exit — and that is standing desk behaviour

The brief expected "exposure-increasing action refused, close passes". Only the
first half is reachable, and the reason is worth recording.

`gateStrategy` **does** exempt the close (it is not in `skips`). It is then
stopped by **`LiveRail`'s own allowlist**, which re-checks `modes.live.enabled`
at the moment of writing to the live collection and has *no* reduce-only
exemption by design ("a check inside the only object that can write live orders
is not one refactor away from being bypassed"). So the exit lands in
`routeErrors`, never in `skips`, and the leg **stays on the book** because an
attempt is not a position.

This is not new and not mine to change in this ticket — `closeAll` and
`/v1/desk/submit` hit it identically, and loosening `LiveRail` would let a
reduce-only *claim* write to the live collection for an unlisted tag. The test
pins the true behaviour with the operational trap spelled out: **switching a live
tag off does not let the supervisor flatten it** — use the Controls close-all
(which runs as the operator) or switch the tag back on. Worth an explicit
decision before the first live engine session; the desk's own flatten-paths note
already carries the same trap from a different door.

### 2. Deviations from the brief, and why

- **`notifySupervisor` takes a third `deps` argument.** The brief's signature is
  `(kind, payload) => Promise<void>`. It needs a `log` (a route module must not
  `console.log`) and a `fetch` seam so the never-throws promise is testable
  without a live socket. Defaulting `log` to the console would bury a failure in
  a process whose log is the operator's window.
- **The 400 body is `{ error }`, not `{ status: 'REFUSED', … }`.** A refusal at
  the door is not a decision outcome and must not wear the shape of one:
  `'REFUSED'` is not in `DecisionResponse['status']`, and a client that read
  `body.status` off a 400 would be reading a word its types do not know. Every
  other route in this app answers `{ error }`. The test asserts the 400 and that
  nothing was written.
- **`TRIGGERS` added to `packages/desk-engine/src/types.ts`** (ticket 01's file).
  Two lines, type-identical (`Trigger` is now derived from the tuple), all 35
  desk-engine tests still pass. The alternative was restating the eleven trigger
  names inside the validator, which is exactly the silent-drift copy the house
  rules forbid.

### 3. Scope additions I made deliberately

- **`recordDecisionReason` + `appendDecisionAction`** are called, mirroring
  `/v1/desk/actions`. Without them the Books page's per-book decision panel
  (`lastReason`, `lastAction`, `actionLog`) would be **blank for every
  engine-driven book** — an existing operator surface silently lost. `trigger`
  stands in for the old wire's `action` word.
- **Machine-principal-only.** Not in the brief. It is a real property (a stolen
  cookie cannot post a live package) and the supervisor is the only client. If a
  dashboard feature ever needs to post a decision, `/v1/desk/submit` is the door
  for that.

### 4. Environment / merge notes

- **`npm install` is required after merge.** `apps/api` now depends on
  `@algomaker/desk-engine`, which has no `node_modules/@algomaker` symlink in the
  main repo yet. I created a worktree-local one to run tests
  (`node_modules/@algomaker/desk-engine` → `packages/desk-engine`; gitignored). A
  root `npm install` creates it properly.
- **One pre-existing test failure**, verified against the baseline by stashing:
  `service.integration.test.ts` → "a PARTIALLY marked book names only the missing
  legs" fails at `df634222` too, before any of my changes. Not caused by this
  ticket; flagged for whoever owns it.
- **`npm run typecheck`'s web half cannot run in this worktree** —
  `apps/web/node_modules` (`@vitejs/plugin-react`) is not reachable from a
  worktree. The root project (`tsc -p tsconfig.json`), which covers every file I
  touched, is clean. No `apps/web` file was modified.

### 5. Left for later tickets, as designed

- `WORKING` status (Tasks 17/18 — fill-gated tranches and the paper lifecycle).
- `trancheLots` on the order document (Task 17 explicitly owns adding it to
  `rail.ts:orderDocument` and threading it from this endpoint's request context).
- The `'fill'` and `'registry'` nudge kinds exist in `NudgeKind` but have no call
  site yet — Tasks 14/18 wire them.
- `workMode: 'passive'` deliberately does **not** set `Fill.resting`. They are
  different statements (resting = "leave my price alone"; passive = "keep my
  price at the touch") and Task 16's peg chaser is what reads the distinction.

---
---

# Fix round 1 — review findings

Commit `ada4c59a` on the same branch. All five findings addressed; each behavioural
fix was verified by reverting it and watching the new test fail.

## IMPORTANT-1 — duplicate-instrument package collapse — FIXED

**Confirmed exactly as reported, and worse than the summary suggests.** I probed
it before fixing, with the guard disabled:

```
[close X, open X]  → 200 DONE, fills: [Buy 2625, Sell 2625], skips: []
[open X, close X]  → 200 DONE, fills: [Buy 2625], skips: ["already open"]
```

The first line is the dangerous one: **zero skips**. `applyActions` mutates its
book as it walks the list, so the open no longer saw the leg the close had just
removed — the duplicate-tag refusal never fired, and the contract was re-derived
from the strike and type of a leg deleted a step earlier. A package reading as
"flatten and re-enter" became an un-refused open. And because per-leg pricing is
keyed by desk tag, both fills shared **one** pricing entry (the open's), so the
closing BUY would have gone out at the limit the OPEN chose.

**Fix:** one rule in `validateDecisionRequest` — any package naming an
instrument more than once is refused at the door. 400, nothing written, no
`decisionId` claimed. Per-action skipping was rejected deliberately: the package
is the unit the supervisor reasons in, and half an ambiguous package is not
safer than none of it. The engine forms one move per contract by construction,
so this can only fire on a client bug and should fire loudly.

**Tests:** both orderings, table-driven, each asserting 400 + the four
emptiness checks (order count unchanged, `desk-decisions` unchanged,
`desk-engine-decisions` unchanged, book byte-identical). Verified failing with
the guard removed.

## IMPORTANT-2 — `strategies.ts` docstring now false — FIXED

The paragraph claiming "the DECISION path does not pass the option" was true
until this ticket and is not any more. Replaced with a per-caller list naming
all three paths: `/v1/desk/submit` (trusted body field), the engine endpoint
(**derived from the book, never trusted, and ANDed again inside
`applyDecision`**), and the Python `/v1/desk/actions` path (passes nothing,
defaults false, behaviour unchanged).

Added a closing paragraph recording what the exemption does **not** buy on the
live rail — `LiveRail` re-checks the same switch with no exemption of its own,
so a switched-off live tag's exit surfaces as a route error, not a skip. That
was the ticket's main finding and it belongs beside the gate, not only in a
report.

## IMPORTANT-3 — reduce-only TOCTOU — FIXED

Real window: the endpoint derives the claim from its own book read (needed to
map instruments to leg tags), and `applyDecision` reads the book again
afterwards. A leg appearing between them turns a `resize` from an exit into new
exposure.

**Fix**, inside `applyDecision`, against the book it will itself act on:

```ts
const reducesExposureEffective =
  reducesExposure && !req.actions.some((a) => addsExposure(a, book))
```

`false && anything` is false, so `/v1/desk/actions` — which passes no claim — is
untouched in behaviour and cost.

**Test** calls `applyDecision` directly (the race cannot be opened over HTTP),
passing a deliberately stale `reducesExposure: true` for a `resize` that triples
the leg against a switched-off tag: it must be skipped, and the book must be
unchanged at `-LOT`. The same test then proves the exemption **still works** for
an honest claim, so the fix downgrades a lie rather than disabling the feature.
Verified failing with the `&&` removed.

## MINOR-4 — absent `workMode` inverted the contract — FIXED

The wire says "absent = passive-first"; dropping it meant an unlabelled fill
reached the gateway looking like every other order and would be chased across
the spread — the opposite of what the supervisor asked for by saying nothing.

**Fix:** `translate` now stamps `workMode: a.workMode ?? 'passive'`. The default
lives **at the wire boundary only** — `Fill.workMode` stays genuinely absent for
`/v1/desk/submit`, `closeAll` and the Python path, none of which has a
passive-first contract. Pricing is unaffected: with no `limitPrice` this is
still a MARKET entry and `marketableFallback` prices it exactly as before, so the
order is still priced to fill, merely now labelled with how it was meant to be
worked.

**The earlier report note that defended dropping it was wrong and is retracted.**
It conflated two different statements: "`Fill.workMode` must not be defaulted for
paths that never had one" (still true, still enforced) with "the engine wire has
no default" (false — the contract states one).

**Tests:** the old "carries no workMode" test is replaced by one asserting
`workMode: 'passive'` with `order_type: 'MARKET'`, plus a new test that an
explicit `'urgent'` survives — the default must never overwrite a choice.

## MINOR-5 — the nudge's credential — FIXED (in the module, not the call site)

Chose the third option and here is why. Passing `DESK_API_TOKEN` at the
`books.ts` call site fixes today's only caller; `notifySupervisor` gains callers
in Tasks 14 and 18 (`'fill'`, `'registry'`), and a credential each one must
remember to pass is one that a future call site forgets — after which the
supervisor either accepts unauthenticated nudges from anything on the box, or
starts silently refusing one kind of nudge.

So the notifier **defaults** `token` to `process.env['DESK_API_TOKEN']` (read
per call, since `.env.local` is parsed during boot). Every call site is
authenticated by construction; the option survives for tests. The call site
carries a comment saying the absence of an argument is deliberate. An empty
token still sends no header — the honest state for a deployment that never set
the variable, and unauthenticated is degraded rather than dangerous here since
the nudge carries no instructions and the port is loopback.

**Tests:** one asserting the env token is presented when the caller passes
nothing (env saved/restored), one asserting an explicit empty token sends no
header.

## Verification

```
node --test apps/api/test/engine-decisions.test.ts   → 28/28 pass  (was 23)
node --test 'apps/api/test/*.test.ts'                → 1347/1348 pass
DESK_REQUIRE_MONGO=1 npm run test:node               → 2919/2920 pass
npx tsc -p tsconfig.json --noEmit                    → clean
```

The single failure is the same pre-existing one recorded above
(`service.integration.test.ts` → "a PARTIALLY marked book names only the missing
legs"), which fails identically at `df634222` before any change in this ticket.

Revert-checks performed (each fix proven load-bearing, then restored):
disabling the duplicate-instrument guard fails both new tests; removing the
`&&` in `reducesExposureEffective` fails the stale-claim test.
