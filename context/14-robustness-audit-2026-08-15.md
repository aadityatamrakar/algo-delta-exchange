# 14 — Robustness audit, 2026-08-15

Four-agent verified audit at commit `9d5e7cff` (one mapper, three auditors: api+runner,
marketdata+order-gateway, web+tests+packages). Every finding below was confirmed against source —
speculative claims were discarded, and one false positive is recorded at the end. Companion map:
[00-live-system-map.md](00-live-system-map.md).

**The one-sentence diagnosis:** the desk is built as a one-way pipeline — decisions flow to the
broker with well-designed gates, but **broker truth never flows back** (no reconciliation, no
fill-path redundancy, ambiguous failures asserted as terminal), and several safety mechanisms
report success in exactly the situations where they failed.

Severity: **C** = can lose money or hold an untracked real position · **H** = high ·
**M** = medium · **L** = low.

---

## A. The missing feedback loop — broker truth never returns

### F-1 [C] The XTS order socket is the *only* fill path; the documented reconciliation sweep does not exist
`apps/order-gateway/src/main.ts:906-915` (`ingestOrderUpdate` is the sole producer),
`packages/brokers/src/xts.ts:281` (`orderBook()` — never called),
`packages/order-bus/src/reconcile.ts:77` (`reconcile()` — dead module). Four docstrings
(`main.ts:634-636,855-857`, `order-socket.ts:11-13`, `queue.ts:78-80`) promise a sweep that
isn't there. `snapshotBroker` (`main.ts:488-537`) fetches orders/trades/positions every 30s but
only feeds display routes — nothing correlates it back to `desk-gateway-orders`/`desk-fills`.
**Scenario:** the 2026-08-10 event — the order socket dies with a dead token; no fill reaches the
desk all session; every order sits `PLACED`; the only self-heal is a restart.
**Fix:** periodic sweep reading `orderBook()` + `getTradeBook()`, mapping
`OrderUniqueIdentifier`→`clientOrderId` (fallback `AppOrderID`→`brokerOrderIds`), replaying
synthesised `PlacedOrder`s through `fills.handle()` (the dedup there already makes replay safe).

### F-2 [C] A REJECTED or PARTIAL live order stays booked at full size forever
`apps/api/src/service.ts:554` writes `desk-decisions.fills = routedFills` (decision-time mark,
**full requested qty**) the moment the PENDING doc is inserted. `pnlstore.ts:180` makes that the
sole input to P&L, the daily rollup, `LiveBook`'s held set **and `flattenTag`'s position
reconstruction**. Nothing reads the gateway's terminal `filledQty`/`avgPrice`/`REJECTED` back to
reduce a booked leg (verified: only two readers, both display-only).
**Scenario:** a margin 403 rejects a recenter leg; the book still carries it; tomorrow's
`close-all` sends a real opposite order against a leg that never existed.
**Fix:** reconciliation job joining gateway terminal state onto decisions by
`clientOrderId = orderIdFor(decisionId, i)`, rewriting fills (0 for REJECTED) and re-folding
`desk-books`; until then report live-rail `DONE` as *queued* and make `flattenTag` refuse
unconfirmed legs.

### F-3 [C] A placement timeout is classified `fatal` and asserted as REJECTED — while the order may be live at the exchange
`packages/brokers/src/xts-rest.ts:285-292` (Abort/network → error result),
`xts-protocol.ts:83-111` (falls through to `'fatal'`), `main.ts:765-779` + `gateway.ts:479-530`
(failed tranche ⇒ terminal ⇒ `REJECTED`). Python's `translate.reconcile` then un-books the open.
If the fill later arrives, `fills.ts:205` returns early on terminal states — never corrected.
**Fix:** an `'unknown'` error class for abort/network faults; hold the order non-terminal in
`ambiguousTrancheIds` and resolve from the F-1 broker sweep before ever writing REJECTED.

### F-4 [M] `applyDecision`'s post-route writes are unguarded
`service.ts:543-555` has no try/catch (unlike `submit.ts:665-697`, which documents exactly why).
A Mongo hiccup after routing 500s the caller with real orders on the wire; the book is
"DELIBERATELY NOT REBUILT" by `#resolveRouting`, so it never repairs.
**Fix:** wrap both writes, return the in-memory outcome, flag book/decision divergence.

### F-5 [M] `PositionLedger.apply` turns a Mongo write failure into a submit failure — after the order routed
`apps/runner/src/order-gateway.ts:183-207,693`. Memory is mutated, then `#save()` rejects and
propagates out of `submit()`; in `flattenAll` (`:775`) it aborts the remaining legs mid-book. A
restart then loads a ledger missing a live leg — nothing will ever flatten it.
**Fix:** catch inside `apply()`, dirty-flag + timer retry; a bookkeeping failure must never look
like a submit failure.

## B. Position safety in the runner

### F-6 [H] Expired MIRROR legs never clear — five independent mechanisms, root-caused
1. **Two disjoint ledgers**: runner positions live in `desk-strategy-state`
   (`runner:positions`, scope `TAG:mode`), touched only by `apps/runner`; `flattenTag`
   reconstructs from `desk-decisions`+`desk-books` and **structurally cannot see a mirror leg**.
2. No backstop by design: `MirrorHost.stopAll` flattens nothing (`mirrors.ts:30-36`);
   `main.ts:415` withholds MIRROR rows from `Runner`, so `#stopOne` never runs for them.
3. Quantity is fabricated: the adapter submits `lots: 1` for every upstream EXECUTED and
   discards carried quantity (`external-signal-mirror/adapter.ts:63`) — open-in-1/exit-in-3
   leaves net −2 permanently.
4. Exits aren't marked `reducesExposure`, so the kill switch / stale-feed block refuses them and
   nothing retries (`adapter.ts:64`).
5. Symbol drift: the ledger keys on `tradingsymbol`; an expired contract leaves the instrument
   map and the exit drops as "unknown symbol".
**Fix (in order):** (a) record `expiry` on `LedgerEntry`, drop-with-journal any entry expired
before today's IST date at boot and day-roll; (b) set `reducesExposure` on mirrored orders that
reduce net; (c) refuse a mirrored order that would cross flat; (d) expose the runner ledger over
the bridge (`GET`/`DELETE /v1/desk/runner/positions`) so clearing is an audited API call, not
"stop runner → edit Mongo → start".

### F-7 [C] `Runner.tick()`/`sync()`/`stopAll()` have no re-entrancy guard — the 15:30 square-off can run twice and reverse a position past flat
`apps/runner/src/main.ts:512,515` (1s/15s intervals fire regardless), `runner.ts:444,327,757`.
`MirrorHost` guards itself (`mirrors.ts:119-141`, with a comment naming this hazard); `Runner`
does not. `#stopOne` writes state only *after* returning, so while pass A is inside `flattenAll`
pass B still sees `running` + a ledger showing the legs A is mid-closing, and submits a second
full reversing set under fresh `clientOrderId`s.
**Scenario:** 15:30:00, 4 legs, flatten takes ~1.5s; tick B at 15:30:01 sells the same 4 legs
again — the safety mechanism itself opens a short position nothing will ever close.
**Fix:** `#busy` guards on `tick()`/`sync()` (copy `MirrorHost.sync`), a per-instance
`#stopping` flag checked at the top of `#stopOne`, and per-gateway re-entry refusal in
`flattenAll`.

### F-8 [H] Nothing guards against an accidental mid-session square-off; `max_memory_restart` is an unattended path into one
The only guard is shell-level in `scripts/deploy.sh:57-64` (covers `make deploy` only).
`make restart`/`up`/`down`, bare `pm2 restart desk-runner`, and pm2's `max_memory_restart: 600M`
all SIGTERM with no check; `shutdown()` (`main.ts:561-594`) flattens unconditionally. The
runner's `#quotes` map is never pruned (`market-data.ts:95`), so a memory-limit restart at 11:40
flattens the entire hosted book, and `#rollSession` does not re-arm mid-day.
**Fix:** invert the default — the ledger is durable and `onRecover()` exists, so a market-hours
signal should stop **without** flattening; square off only past day-end or under explicit
`DESK_SQUAREOFF_ON_STOP=1` (set by `make down`). Raise/remove `max_memory_restart` for the
runner.

### F-37 [H] `stopAll` is serial but the hard-exit is fixed at 15s — later legs are silently never attempted
`runner.ts:575-578` (strictly serial over up to 28 instances), `main.ts:591`
(`process.exit(1)` at 15s — pm2's 20s is not the limiter). When the fuse fires, the stranded-tag
log never runs: the process dies with no record of which instances were skipped.
**Fix:** `Promise.allSettled` over instances (they share no mutable state — the file's own
invariant), and log every non-empty ledger before the hard exit.

## C. Duplicate orders & halt authority

### F-9 [H] The kill switch cannot stop an order already in the queue — and the queue has no TTL
Halt is enforced only in desk-api (`decision-plan.ts:47-62`, `submit-plan.ts:179-181`); the
gateway's only gate is the allowlist (`order-gateway/main.ts:733-743`). PENDING orders written
before the halt — or orphaned by a gateway outage — are placed whenever the sweep next runs, at
any price, any age.
**Fix:** read the kill switch in `processOne` as Gate 3 (honouring `addsExposure` so exits
pass), and refuse orders older than a staleness bound (e.g. 120s) as `INVALID`.

### F-10 [C] A stale claim is reclaimed and every tranche re-placed — no idempotency guard
`queue.ts:80` (`CLAIM_TIMEOUT_MS = 60_000`), `main.ts:669-791` (`processOne` re-plans from
scratch; `markPlaced` only after *all* tranches are on the wire). The comment claiming the
broker-side correlation id catches this is wrong — the 45-char truncated id is not unique.
**Scenarios:** (a) crash after tranche 1 of 3 → reclaim re-places all three; (b) a slow
placement (3 attempts × 15s × tranches ≈ 48s+) outlives its own claim and a second instance
re-places.
**Fix:** refuse placement if the doc already carries `brokerOrderIds`; route reclaims to a
recovery path that reads the broker orderbook by correlation id; heartbeat `claimedAt` during
placement; make the timeout exceed worst-case placement.

### F-11 [H] Any throw inside `processOne` leaves the order CLAIMED forever — a 60s duplicate-placement loop
`queue.ts:284-290` (sweeper logs and moves on; doc never transitioned), `main.ts:675-690`
(`planOrder`/`markPlaced` unwrapped — `splitIntoTranches` throws on bad lots; a Mongo blip
during `markPlaced` throws *after* orders are at the broker).
**Fix:** try/finally that always transitions out of CLAIMED (to PLACED with obtained ids, or a
new `NEEDS_REVIEW`); attempt counter that dead-letters after N reclaims.

## D. Feed, marks, freeze

### F-12 [H] The NSE freeze table is never refreshed by any running process
`syncFreezeLimits` (`apps/marketdata/src/sync-runner.ts:128-156`) is called **only** by
`make sync` (`Makefile:142-148`); the daemon's daily `sync()` refreshes `instrument` only. A
stale row under-splits after an NSE revision (exchange rejects the tranche — the exact
`xtsOrder.js:104` failure the module was written to design out); a missing row sends a 100-lot
order unsplit.
**Fix:** call it from marketdata's 08:45 sync (it already fails soft); publish `freezeSyncDay`
on `md.health`.

### F-13 [H] The REST-alive-vs-socket-alive token gap is narrowed but open — no periodic canary
Both REST consumers route rejections into `FeedRecovery` (`kind:'token'`) but both are
demand-driven: the margin sweep prices ~6 slots/day and history only when the runner asks. A
Kite-web login can kill the enctoken while sockets stream; nothing notices for hours; `md.health`
shows green. Also `isTokenRejection` misses a 403 whose body lacks the exact `TokenException`
wording (`book-margin/kite.ts:138-140`).
**Fix:** 60-120s REST canary in the health timer routed through `recovery.trigger(..,'token')`;
publish `enctokenLastVerifiedAt`; widen the rejection match to `403 + /token/i`.

### F-14 [H] No stale-tick detection — `StalenessWatchdog` is built, fed, and never read
`kite-feed.ts:102,187,294-297`; **`KiteFeed.health()` has no caller.** The health timer publishes
socket connect-state only; recovery triggers on socket death only. The watchdog's own docstring
names the failure: a socket that stays open while ticks stop, every strategy deciding on frozen
prices. A partially-failed resubscribe replay leaves tokens in the registry but not on the wire.
**Fix:** call `feed.health()` per socket in the 10s timer; publish `staleTokens`/`oldestAgeMs`;
force `reconnect()` (resubscribe repair) on a large stale fraction with a connected socket.

### F-15 [H] `feedAlive()` is satisfied by the spot feed alone; `price()` discards the per-token `stale` flag
`apps/api/src/marks.ts:134,140` (spot bumps liveness identically), `:147-156`. A failed
option-chain resubscription after expiry roll leaves every strike marking at yesterday's price
with `complete: true` — frozen quotes pricing real paper fills and every P&L on screen.
**Fix:** track option-tick liveness separately; return null past a hard per-token ceiling.

### F-16 [H] Marketable limits are priced off marks that may be hours stale
`marks.ts:152-156` (age dropped), `submit.ts:541,567-572`, `marketable.ts:81-104` (no age
input). A 470CE last printed at 09:20 gets a "marketable" limit at 14:00 that rests forever —
the hedge silently doesn't exist, precisely what the module exists to prevent.
**Fix:** thread `ageMs` into pricing; refuse or widen materially past `staleAfterMs`
(note the 60s default is only 2 missed ticks on the 30s stock-option cadence).

### F-17 [H] Nothing ages out an order left WORKING at the broker
`fills.ts:213-220` logs "order still working" and returns; the only cancel path is manual. An
unfilled marketable limit rests all session and can fill into the close against a book squared
elsewhere.
**Fix:** sweep on `placedAt`: chase via `modifyOrder` (`packages/execution/chase.ts` exists,
unused) or cancel + journal PARTIAL; at minimum alert.

### F-18 [M] Pre-open ticks are still unfiltered at the source
`main.ts:349-358` publishes every packet with `ts: Date.now()` (arrival time); the exchange
timestamp is computed then discarded (`kite-feed.ts:326-331`); no session gate exists anywhere
downstream. The 2026-08-10 poisoned-opening-range root cause is unfixed; arrival-time-only also
makes replayed packets indistinguishable from live.
**Fix:** drop packets whose *exchange* timestamp is outside 09:15–15:30 IST, or publish `exchTs`
and gate `CandleStore` on it.

### F-19 [M] The snapshot loop relogins outside the adapter's single-flight, and neither it nor the cancel drain is concurrency-guarded
`main.ts:507` calls raw `session.relogin()` bypassing `XtsAdapter.#reloginOnce` (whose docstring
explains XTS invalidates the previous token per login); `main.ts:539,592` are unguarded
intervals — overlapping passes thrash tokens under load and can double-issue cancels.
**Fix:** route relogin through the adapter (or hoist single-flight into the session); `running`
flags on both loops.

### F-20 [M] A login that outruns its 60s timeout can strand the history endpoint on a dead enctoken
`main.ts:394-411` + `feed-recovery.ts:82-97`: timed-out login A still writes `pendingSession`;
`apply(B)` mismatches and leaves `session` on the dead token while the pool holds the live one —
breaking the "single place both are written" invariant the code claims.
**Fix:** return `{token, session}` together from `login()`; discard a pendingSession whose
attempt already timed out.

## E. "Flat" must mean flat

### F-21 [C] `flattenIsFlat` is vacuously true on an empty reconstruction
`decision-plan.ts:475-487`: `legs.every(...)` over `[]` is true. Reachable two ways: the tag
path defaults the window to *today* (a book that hasn't traded today reconstructs to nothing)
and seeded books journal no fills at all. Every refusal message in the codebase tells the
operator to run exactly this call; a 200 `{flat:true}` sends them home carrying the book
(the NIFTY-2026-08-03 incident, fixed only for the delete-flatten caller).
**Fix:** zero legs + zero fills in window ⇒ `flat:false, reason:'emptyWindow'`; default the tag
path to `sinceMs: 0`; cross-check `bookDoc(tag, mode)` and name book-only legs.

### F-22 [C] Naming `tag` on close-all bypasses the "no such book" 409 — a typo answers 200 DONE and upserts a phantom book row
`routes/desk.ts:701-733` (guards only in the `else` branch; the dashboard always sends the tag,
so the guard is dead in practice), `service.ts:830-851` (`null` book ⇒ zero actions ⇒ DONE),
`:543-547` (`saveBook` upserts the mistyped tag with the blank-expiry corruption
`service.ts:823-829` documents).
**Fix:** when `tag` is supplied require an existing book with matching symbol, 409 otherwise;
never `saveBook` a book that was never loaded.

### F-23 [C] `flattenTag` has no stale-ROUTING reconciler — a crashed flatten wedges the id and the workaround double-sells
`service.ts:1017` (`replayFlatten` is a pure re-read — no staleness window, no rail probe,
unlike both siblings), `:1190` (unguarded promotion — the identical write is wrapped in
`submit.ts:665-697` for a documented reason). A stuck `{ROUTING, fills:[]}` record makes the
retry-with-a-new-id reconstruct the position as fully open and route the entire exit twice.
**Fix:** give it the same `ROUTING_STALE_MS` reconcile (planned ids are already
`orderIdFor(decisionId, i)`); wrap the promotion.

### F-24 [H] `make up` claims a SIMULATED broker while starting the real one on the live box
`Makefile:5,12-16,60,69` assert simulate-by-construction; `ecosystem.desk.config.cjs:149`
(`DESK_BROKER: secrets.DESK_BROKER ?? 'simulate'`) makes `.env.local` win — the live box "stays
armed across every restart" by design. On prod, `make up` arms XTS while printing "SIMULATED".
**Fix:** have `up:` read the resolved value and refuse (or route to the `live` confirmation)
when not simulate; correct the header and echo.

### F-25 [H] `close-all --style fast` sends MARKET — which the broker rejects — then reports DONE and empties the book
`safety.ts:274-279` returns `MARKET`; `decision-plan.ts:97-99` passes MARKET through untouched;
`marketable.ts:8` states the broker refuses it. The *emergency* path is the one that bypasses
the marketable-limit machinery; every leg is refused, the API reports DONE with a full fill
list, `saveBook` empties the book, and the open position becomes invisible. `priceExit` also
returns MARKET (`degraded:true`) whenever a limit leg has no usable mark.
**Fix:** when a pricing entry says MARKET and `marketable` is configured, fall through to
`marketableLimit`; "fast" should mean widest crossing limit.

### F-26 [H] `applyRoutedFill` folds a netted exit into the first matching leg and can flip its side
`book.ts:78,105-111`. Books legally hold the same contract on several legs
(`recenter-relief` — `service.ts:870-874`) while `planFlatten` nets to one order per contract.
SELL 500 + SELL 500, flatten BUY 1000 → first leg becomes BUY 500, second still SELL 500: two
phantom legs, `closeLeg` would route two more real orders.
**Fix:** consume fills across matching legs in order, removing at zero; never flip a side.

### F-27 [H] `desk-books` is a whole-document read-modify-write with no version guard
`store.ts:288-304` (`$set:{legs}`), read at `service.ts:342`, written at `:543` with gates and
N routes in between; no CAS, no transaction, no in-process serialisation. Operator "Close leg"
racing the supervisor's 5-minute POST reproduces the 2026-08-03 ITC desync shape.
**Fix:** carry `updatedAt` as a version, make `saveBook` compare-and-set returning `'conflict'`
(the pattern already exists in `patchStrategy`, `store.ts:630-651`).

## F. Guardrails, attribution, validation

### F-28 [H] A complete risk module — daily loss stop, rate limit, lot/notional caps — is green-tested and wired to nothing
`packages/order-bus/src/risk.ts` (`checkRisk`), 265 lines of passing tests, zero importers
(same for `wal.ts`, `reconcile.ts`). The live path has **no cumulative daily loss stop and no
notional cap** — exposure is bounded per-order by `liveLots` and the freeze split only, while a
green `risk.test.ts` implies otherwise.
**Fix (decision):** wire `checkRisk` into `submit-plan.ts`, or delete it so its tests stop
implying protection that isn't there.

### F-29 [H] Dials: a running live book's risk parameters, rewritten with no re-auth, no principal, no key validation, no bounds
`apps/web/src/books.tsx:248-350` → `routes/books.ts:603-625`, `books-registry.ts:128-143`.
No `gate.reauth` (the strategy live-switch and kill switch both have it); log records key names
only — no values, no who; `validateDials` accepts any finite-number/boolean key (a typo like
`targetPnl` 200s and is silently ignored by the supervisor; a dotted key is stored nested and
dropped on read).
**Fix:** re-auth when `mode==='live'`; validate keys against the variant `defaults` (400 on
unknown); bounds on risk-sizing dials; persist `setBy`/`setAt` and log values.

### F-30 [H] `POST /v1/desk/seed` can overwrite a live book's legs — no re-auth, no open-position guard
`routes/desk.ts:243-264`, `seed.ts:100-117`: accepts `mode:'live'` + `replace:true` from any
credential that reaches the API, including the shared machine bearer. This is the erasure the
DELETE route refuses on principle.
**Fix:** `gate.reauth` for live and for `replace:true`; refuse replace while the fills-derived
position is non-zero.

### F-31 [H] The "refuses while a position is open" guard on mode-removal is hard-wired to 0 for every non-hosted row
`routes/desk.ts:856-859` (`kind === 'hosted' ? … : 0`) — registry books are all `external`, so
the 409 can never fire despite the handler's header promising it. Removing the row then makes
the desk's own exits refuse too (reduce-only exemption sits *after* the added-check).
**Fix:** reconstruct the position the way the delete guard does and apply the same 409.

### F-32 [H] The irreversible book delete accepts a fill read it knows may be incomplete
`routes/books.ts:280-288` discards `load.malformed`/`load.truncated` — the exact flags
`flattenIsFlat` treats as blocking, with the incident that motivated them quoted in its
docstring, guarding a strictly harder-to-reverse action.
**Fix:** return the flags from `openNow`, 409 with the same wording.

### F-33 [H] `DELETE …/registry/:tag?flatten=1` mints its own timestamped decisionId — a retried click flattens twice
`routes/books.ts:305-323` (`delete-flatten-${tag}-${now()}`), while every other flatten caller
must supply an id precisely to make retries safe. A proxy timeout + second click routes a second
full exit set.
**Fix:** deterministic id (`delete-flatten-${tag}-${mode}-${istDate}`) or require the caller's.

### F-34 [M] `aggressionPct` reaches exit pricing unvalidated on all three flatten call sites
`routes/desk.ts:652-655,740-742`, `routes/books.ts:458-460` → `safety.ts:283-291` computes
`mark × (1 + aggression)` with no finiteness check or ceiling — `validate.ts`'s own stated
doctrine, unapplied on the money-moving path. `aggressionPct: 5` (meant 5%) buys back a ₹40
short at a ₹240 limit.
**Fix:** finite, `[0, 0.25]`, at all three sites.

### F-35 [M] The kill switch permits `roll` — which opens a new short at an arbitrary strike
`safety.ts:57-65` (deliberate, to avoid stranding a tested short) — but `applyActions` sells
`action.to_strike` verbatim at same quantity; replacing a 0.05-delta short with ATM under a halt
is a large exposure increase.
**Fix:** permit only rolls that move *away* from spot; state the rule in `addsExposure`.

### F-36 [M] Declarations are keyed by tag alone — a paper run overwrites the live book's declaration
`validate.ts:259-333` (no `mode`), `store.ts:247` (unique on `{tag:1}`). Everything else in the
phase-0 model is `{tag, mode}`; the normal rehearse-then-arm workflow makes the collision real,
and the D2 reconciliation page then diffs live legs against the paper declaration.
**Fix:** required `mode`, `{tag, mode}` unique, migrate the index.

## G. Availability & operations

### F-38 [M] `priceExit` can emit `limitPrice: 0` and reports it as not degraded
`safety.ts:283-293,110`: closing SELL with mark 0.05 clamps to 0 (`marketable.ts:99` handles the
identical case correctly); `planCloseAll` also ignores `leg.instrument.tickSize`.
**Fix:** clamp to ≥1 tick; thread the instrument's tick through `CloseAllInputs`.

### F-39 [M] `#actualEntries` restates cost basis from *all* orders ever placed on that symbol+side
`service.ts:1279-1299` — no window, no netting against closes; contradicts `applyRoutedFill`'s
partial-close rule and skews the "actual MTM" it was built (2026-08-04) to make trustworthy.
**Fix:** net closes against opens chronologically (as `@algomaker/pnl` does) or key by open.

### F-40 [M] The forever-retained daily rollup silently discards `malformed`/`truncated`
`pnl-jobs.ts:438-468`: the live path nulls the total on incomplete reads; the rollup writes a
confident number over the same flags, and the snapshots that could expose it prune at 30 days.
**Fix:** thread both flags into `DailyReportInput`; `total = null` + `incomplete` field.

### F-41 [M] Crash guards and Mongo-retry exist in the gateway and are installed nowhere else
`apps/order-gateway/src/resilience.ts` documents both incidents by name; `apps/api/main.ts:114`
and `apps/runner/main.ts:82` await bare `connectMongo`. Mongo 20s late at 09:14 burns
`max_restarts` in ~70s and the desk is down for the session. `LiveBook`'s reconcile interval
also lacks a `.catch()` (`livebook.ts:269-271`).
**Fix:** move `resilience.ts` to a shared package; install in api + runner; add the catch.

### F-42 [M] The unique index `rail.ts` calls its duplicate-order protection is created by a different process
`store.ts:220-259` creates every unique index *except* `desk-gateway-orders.clientOrderId` —
that lives only in the gateway (`queue.ts:100`). A restored DB, or api-up-before-gateway, writes
live orders unprotected. `desk-paper-trade` has no uniqueness at all.
**Fix:** create both in `DeskStore.ensureIndexes` (idempotent).

### F-43 [M] Book lifecycle writes return `200 null` when they matched nothing
`store.ts:760-816` (`setDesired`/`setActual`/`patchBookDials` ignore `matchedCount`) — logs
"book started" while nothing happened.
**Fix:** return `'missing'` on 0 matches; answer 404/409.

### F-44 [M] The nightly prune's time gate is a floor, not a window — a mid-morning restart runs a delete sweep
`pnl-jobs.ts:591,629,638-649`: `prunedFor` starts empty and `minutes >= 90` is true nearly all
day, so the first tick after any boot prunes; `repairRollups` also runs seven ~30-day scans 5s
after every boot. The documented "safe mid-session move" (`pm2 restart desk-api`) triggers both
against standalone Mongo while books are marking.
**Fix:** window the gate, persist `prunedFor`, skip repair days already covered.

### F-45 [M] The stream's 50-client cap is TOCTOU and half-open sockets are never reaped
`stream.ts:494-516`: cap checked before the async `handleUpgrade` registers; no ping/pong, so
half-open connections hold slots (and keep `LiveBook` computing for nobody) until the cap 503s
real dashboards.
**Fix:** reserve the slot before upgrade; heartbeat `ping()` with an `isAlive` flag.

### F-46 [M] The XTS session token and the Zerodha cookie jar are stored in plaintext
`order-gateway/main.ts:436-441` (order-placing bearer in `desk-broker-session`, unencrypted,
while the credentials that mint it are sealed); `zerodha-login.ts:81-84,111` (enctoken cookie
jar as plaintext JSON on disk).
**Fix:** seal both with `DESK_MASTER_KEY`; TTL the session doc.

## H. Dashboard & delivery

### F-47 [H] No fetch timeout anywhere in the dashboard — a hung bridge shows stale numbers with no error
`apps/web/src/api.ts:398-430` (no AbortSignal anywhere in `apps/web/src`); `usePoll` errors only
on rejection, which a hung connection never produces. The socket watchdog then raises a notice
that *falsely reassures*: "figures below are still being refreshed over the API".
**Fix:** `AbortSignal.timeout(8000)` in `request()` — one line into the existing error path.

### F-48 [H] No CI; the deploy path runs neither test suite nor the backend typecheck; 165 tests skip silently without Mongo
No `.github/`, no hooks, no lint. `scripts/deploy.sh:103-106`: the web build's `tsc -b` is "the
only typecheck between a pulled commit and a running process" — the root `tsc` (all four backend
apps + packages) never runs on deploy, and no tests do. `npm run test:node` exits 0 with **165
skipped** when Mongo is unreachable — the skipped set is auth routes, books registry, brokers,
server, service integration (including `bulk ON in LIVE needs the password`). `make test` does
not depend on `mongo-up`.
**Fix:** `DESK_REQUIRE_MONGO=1` turns skips into failures (set in CI/deploy); gate deploy on
`make check`; add a GitHub Actions workflow with a Mongo service container.

### F-49 [M] `usePoll` has no response-ordering guard — an older payload can overwrite a newer one
`shell.tsx:323-343`: intervals overlap, each resolution `setData`s unconditionally. Live at 3s
(feed) and 5s (positions, books).
**Fix:** monotonic request id, apply only the highest.

### F-50 [M] The Books page discards three poll errors — including P&L — with no staleness surface
`books.tsx:357-366` destructure `data` only; the page is the one P&L surface not on
`useLivePnl`, so it has no degraded indicator. Frozen Net-delta/P&L columns with no banner; the
stale summary also feeds the Delete dialog's flatten wording.
**Fix:** surface the errors or move onto `useLivePnl`.

### F-51 [M] The per-row strategy switch turns OFF on one unconfirmed click — and off "blocks exits too"
`strategies.tsx:959-961,1087-1088`: only live-ON is confirmed. The bulk switch got a
confirmation in *both* directions for a stated reason (`:85-94`) that applies identically
per-row. No `isDisabled` while in flight (double-click = double patch).
**Fix:** per-row confirm reusing `bulkStatement`'s wording; disable while busy.

### F-52 [M] MTM tile and the positions Total are different quantities, labelled only in a source comment
`pages.tsx:451,556-577,663`: tile = day's realised+open off the journal; column = open book
mark-vs-entry. Legitimately different (`positions.ts:189-194`) — but on screen both just say
P&L/MTM. Same operator-confusion class as the 2026-08-04 tile-vs-chip fix.
**Fix:** subtitle one of them ("open, since entry" / "day").

### F-53 [L] Small verified items (batch)
- `routes/kit.ts:104-108`: unguarded `decodeURIComponent` → 500 on a malformed escape.
- `pnlstore.ts:181`: numeric `createdAt` filter makes Date-typed decisions invisible to P&L
  (BSON type bracketing).
- Broker cancel (`desk.ts:427-447`): accepts any id, records no principal, can reset a terminal
  cancel to pending.
- `gateway.ts:144-149`: a LIMIT doc with no `limitPrice` goes out as Limit-at-0 —
  refuse in `planOrder`.
- Replay paths trust the request's `tag`/`mode` over the stored record's
  (`service.ts:645,665,1734-1768`) — a cross-mode replay can erase paper fills.
- `LiveBook.#malformed` isn't keyed by mode (`livebook.ts:189,366`) — a corrupt paper fill nulls
  the live total on the stream path only.
- `RunnerMarketData.#quotes`/`#routes` never pruned; `md.release(tag)` has no caller.
- Feed-pool sockets are never retired once emptied; `md.health`'s richest fields
  (per-socket down state, `instrumentsStale`) are consumed by nobody.
- `apps/web/test/entry-plan.test.ts` is typechecked by nothing (`test/**/*.ts` missing from
  include).
- Dead config: `.eslintrc` (extends uninstalled `loopback`), `.eslintignore`, `.yo-rc.json` —
  while `shell.tsx` carries `eslint-disable` comments for a linter that never runs, on the exact
  rule that would have caught F-49.
- The Total sentinel row is smuggled via double cast (`pages.tsx:577`) — add
  `isTotal?: boolean` to `PositionRow`.
- Books page dash for a partially-priced book has no `partial` badge (`books.tsx:499`).
- Stale safety comments: `runner.ts:777` cites a method that no longer exists;
  `deploy.sh:17-19` understates the SIGTERM consequence (see F-8).
- `mongodb@3.7.3` pin's comment cites a removed constraint; dep undeclared in
  `apps/api/package.json`. Vendored Zerodha login runs on `request`/`debug@2` (CVE) — port to
  native fetch.

### A false positive, recorded so it doesn't recur
An automated pass claimed the live-enable password gate "does not exist". **Wrong** — it is
complete end-to-end: `strategies.tsx:112-169` (`withReauth`), `auth.tsx:240-374`,
`routes/desk.ts:560,926,1114` (`403 + reauthRequired`). Do not "add" a gate that already exists.

---

## The roadmap — ranked by risk retired per unit of effort

**Tier 1 — before the next live session (S effort each)**
1. Runner re-entrancy guards + `Promise.allSettled` stopAll + stranded-leg logging (F-7, F-37).
2. Invert the SIGTERM square-off default; raise `max_memory_restart` (F-8).
3. `flat` must mean flat: F-21 + F-22 + F-25 (three small edits on the one field operators act on).
4. Kill switch + order-age gate in the gateway (F-9).
5. `AbortSignal.timeout` in the web client (F-47); fix the `make up` broker-mode claim (F-24).
6. Idempotency guard + claim heartbeat + try/finally in `processOne` (F-10, F-11).

**Tier 2 — the feedback loop (M effort, highest structural payoff)**
7. Broker-truth reconciler: orderbook/tradebook sweep → `fills.handle()`, terminal state joined
   back onto decisions + books, divergence alerts (F-1, F-2, F-3 — and it makes F-26/F-39
   observable). This is the missing half of the system.
8. `'unknown'` outcome class for ambiguous placement failures (F-3).
9. Compare-and-set on `desk-books` (F-27); fill-fold across legs (F-26).
10. Mark staleness into pricing + per-token liveness + wire the watchdog (F-14, F-15, F-16);
    working-order timeout/chase (F-17).

**Tier 3 — guardrails & hygiene (S–M)**
11. Re-auth + attribution + validation on dials and seed; deterministic delete-flatten id
    (F-29, F-30, F-33, F-34).
12. Freeze sync scheduled; REST canary; shared `resilience.ts`; indexes in `ensureIndexes`
    (F-12, F-13, F-41, F-42).
13. Mirror-leg expiry sweeper + runner-positions admin endpoint (F-6).
14. CI (`make check` + Mongo container), `DESK_REQUIRE_MONGO=1`, deploy gate (F-48).
15. Decide `risk.ts`: wire the daily loss stop or delete it (F-28).

**Tier 4 — structural (L)**
16. One position truth: union endpoint over `desk-books` + runner ledger, nightly
    broker↔books↔ledger comparison job with alerts.
17. Operator audit log: one append-only collection (principal, action, tag, mode, before/after)
    for every mutation — today only the kill switch records who.
18. Extract a `flatten/` module from `service.ts` (1769 lines) so the exit path's reconcile is
    testable in isolation; port the vendored Zerodha login off `request`/`debug@2`; delete
    `events`/`indicators` (+ `execution` after F-17 decides whether to use its chase); drop dead
    deps and pre-cutover lint config.

### Post-implementation review residuals (2026-08-15, accepted knowingly)

A high-effort review of the Tier-1 diff confirmed two residual classes that are NOT fixed by
Tier 1 and are closed by Tier 2's broker-truth reconciler (F-1/F-2):

- **Booked-but-refused:** the bridge books fills at rail-write time, so an order the gateway
  later refuses (kill-switch Gate 3, stale-age Gate 4, or any broker rejection) leaves the book
  carrying legs no order backs. This predates Tier 1; the new gates make refusals more common
  for *opens*, which is the safe direction, and exits are exempt from the age gate for exactly
  this reason.
- **Grow-vs-shrink resize under a halt:** the gateway cannot see the book, so a queued
  exposure-growing `resize` passes Gate 3 (trapping a shrink — an exit — would be worse). The
  bridge's write-time gate covers resizes decided after the halt engages.

Also deferred from that review (cleanups, verified but low): the 5×-copied refusal block in
gateway `main.ts`, the wasted kill-switch read on exit-op orders, and bounding the runner's
quote cache instead of raising `max_memory_restart`.

**Test debt (from the coverage map):** the 5 highest-risk missing tests, in order — runner
SIGTERM wiring driven end-to-end; Dials save → PATCH body (+ re-auth once added); `usePoll`
hung/out-of-order semantics; margin-tile stale branch; live-enable re-auth flow in the web suite
(zero web tests mention `password` today).
