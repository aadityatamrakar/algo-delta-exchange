# Ticket 15 — Supervisor main: boot, lease, loops, marks journal, maker-quote

**Status:** COMPLETE. Branch `worktree-agent-a122f91927fe25267`, 6 commits off `9d1f499a`.

| | |
|---|---|
| Supervisor workspace suite | **149/149** (`node --test apps/supervisor/test/*.test.ts`, Mongo up) |
| desk-engine suite | **374/374**, parity **22/22 / 1,152 marks** |
| Full node suite | **3,548 pass / 1 fail** — the one red is pre-existing (§8) |
| Dashboard suite | **542/542** (30 files) |
| Typecheck | `tsc -p tsconfig.json` clean **and** `@algomaker/web` clean |
| Mutation checks | 13 mutations, all caught (§7) |
| Local boot | real Mongo + real bus + stub desk-api: one full evaluate → one posted decision (§6) |

---

## 1. What was built

| File | What it is |
|---|---|
| `apps/supervisor/src/main.ts` (new) | `Supervisor` — the loop machine — plus `main()`, the composition root. |
| `apps/supervisor/src/http.ts` (new) | `:8793`, loopback: `POST /nudge`, `GET /health`. |
| `apps/supervisor/src/registry-poll.ts` (new) | `desired` → books steered; `resolveDials` per row; the `actual` heartbeat. |
| `apps/supervisor/src/marks-journal.ts` (new) | `desk-book-marks` — one row per book per 5-minute mark. Owns the constant. |
| `apps/supervisor/src/working-orders.ts` (new) | decisionId → broker order ids → `POST …/cancel`. |
| `apps/supervisor/src/book-margin.ts` (new) | `MarginPoll` over `desk-book-margin`, through desk-api's OWN arithmetic. |
| `apps/supervisor/src/engine-host.ts` (modified) | shared `MarkClock` + `onMark`; the maker quote; guard preemption and invalidation. |
| `apps/supervisor/src/state-store.ts` (modified) | `workingPackage` gains `formedAt` / `formedSpot`. |
| `packages/desk-engine/src/{types,engine,marking}.ts` (modified) | `EngineDecision.makerQuote`; `theoreticalPrice()`. |
| `bin/desk-supervisor.mjs` (new), `ecosystem.desk.config.cjs` (modified) | the pm2 entry. |
| 4 new test files + 2 extended | 149 supervisor tests (was 96 at ticket 14's merge). |

### The shape

```
main()  →  crash guards → connectWithRetry → OptionMaster → nudge server LISTENS
        →  new Supervisor({db, bus, client, api, master, lease, now, log, server})
        →  supervisor.boot()

Supervisor.boot()  lease (waits forever) → indexes ×3 → registry.run() → warmStart
                   (scoped) → publishSubscriptions → bus.subscribe → arm()

loops (all .unref()ed)   evaluate 250 ms (coalesced) · inFlight poll 1 s ·
                         registry 5 s · subscriptions 15 s · margin 30 s ·
                         lease heartbeat 10 s
```

---

## 2. The five hard requirements, and where each is proved

| Requirement | Where | Test |
|---|---|---|
| **The 1 s inFlight poll is wired** | `#arm()`'s `IN_FLIGHT_MS` timer → `pollFlights()` | "THE 1-SECOND POLL IS REALLY ARMED" — the one test that spends real time. Driving `pollFlights()` by hand proves the method; only a wall clock proves the TIMER, and a deployment that forgot it holds every working package for the session. |
| **Boot order** | `boot()`, in the header's order, unconditional | boot test; "THE WARM START IS SCOPED"; the replay test |
| **SIGTERM is inert** | `stop()` — no square-off, no cancel, no env opt-in | "SIGTERM IS INERT — the client receives NOTHING after the signal (D6)": every trigger is driven after the signal and the fake client's count does not move |
| **The loops** | `#arm()`, `RegistryPoll`, `#publishSubscriptions` | dial-retune, switch-off, subscription and heartbeat tests |
| **Nudge server :8793** | `http.ts` | 7 tests against a real loopback socket |
| **Marks journal** | `onMark` → `MarksJournal` | "THE MARK IS JOURNALLED, once per window" + 5 journal tests |
| **Maker quote + preemption** | `engine-host.ts` `#quoteAt` / `#preempt` / `#invalidated` | 10 host tests |
| **Margin input** | `book-margin.ts` | smoke run; `marginSource` on every journalled mark |

**Ticket 14's §8 checklist is closed item by item**: `readBook()` maps `desk-books`
to `LegPosition`; `instrumentFor` and `tickSizeFor` are master lookups;
`margin()` is a poller whose `asOf` advances per READ (§4); `repairHold()` is
`repairHoldReader({lookup: repairHoldLookupFor(db, now)})`; `pollInFlight()` runs
at 1 s while `inFlight !== null`; `resolveInFlightOnBoot()` runs inside `#start`,
before the first evaluation; `marks-journal.ts` shares the clock (§3); and
`new StateStore(collection, log)` is constructed WITH the logger, so a dropped
basis row is not silent.

---

## 3. The mark clock: one grid, and why sharing it is not enough

`MarkClock.next()` **advances**. Two clocks is not two readings of one thing — it
is two consumers, and whichever asks first takes the mark. A journal with its own
clock would file rows against a grid that disagrees with the target lock's streak
at every boundary, and the streak is the desk's defence against a gap-open
phantom mark (TCS 2026-06-19).

So the seam is two-sided:

- `EngineHostDeps.marks?: MarkClock` — the clock is INJECTED, so `main` can hand
  the same instance to anything else that needs the grid;
- `EngineHostDeps.onMark?(sample)` — the host CONSUMES the mark and hands out
  what it saw. The journal never calls `next()`, because calling it would take
  the mark the host is deciding on.

`MarkSample` and `BookMark` are declared separately and joined at the call site in
`main.ts`, so the compiler proves they agree without `engine-host.ts` importing a
collection name — the `repairHoldLookupFor` pattern.

The row carries **`dateIst`, which the spec's field list does not name**, and it
is load bearing: `markIndexToday` repeats daily, so the uniqueness this collection
needs (one row per book per mark) cannot be expressed without a date. It is a
unique index on `(tag, mode, dateIst, mark)`, so a restart mid-mark costs nothing
and says nothing.

---

## 4. Closing ticket 14's disclosed gap: a guard CAN now preempt

Spec §8 wants "cancel first, then act". The two halves land on **different
passes**, deliberately:

```
this pass    a guard (or an invalidation) cancels every order still working
             under the flight, and routes NOTHING
1 s later    pollInFlight reads the terminal outcome and folds whatever filled
             before the cancel landed
next tick    the book decides against the position that really exists
```

Sequencing is what makes it safe: the replacement package is sized off a book that
has already absorbed the cancelled package's partial fills, so a guard cannot
close more than the book holds. Cancel-and-route in one pass could.

Three details worth naming:

- **One cancel per flight.** The cancel request is upserted per order id
  downstream (`routes/desk.ts`), so asking again changes nothing at the broker —
  but it would put an HTTP round trip and an ERROR line on every tick for as long
  as the orders take to drain, which is how a real alarm becomes noise. A cancel
  that THREW is not marked done: a guard is still waiting behind it.
- **Only the newest broker order id per non-terminal desk order.** A desk order
  accumulates one id per tranche as the fill gate releases them and only the
  newest can still be working; cancelling the whole array files cancels against
  tranches that have already filled, each of which reads `CANCEL FAILED` on the
  Broker page.
- **Cancelling an EXIT may still let its later tranches go out.** A short
  terminal tranche halts an OPEN but ADVANCES a close
  (`gateway.ts:decideTrancheStep` rule 3 — abandoning half an exit is the worse
  error). That is safe here because the decision stays non-terminal until every
  tranche is, so this host routes nothing meanwhile.

**Invalidation** (`rest_max_min`, one full strike step of underlying movement) is
measured off `formedAt`/`formedSpot`, which are **persisted with the package**.
The orders rest at the gateway and outlive this process, so a clock held in
memory would give a twenty-minute-old quote another ten minutes after a restart
and would re-anchor the strike test to the boot spot, forgetting a move that had
already happened. An older document reports `0` and is never invalidated — the
honest reading of "this clock is not running"; the flight is still polled and can
still be preempted.

### The maker quote

`decide()` now reports `makerQuote` (phase R's `sheddable`, carried out), and the
host prices the sale at `theoreticalPrice()` — Black-76 at the chain's own
forward, at a volatility solved off the strike's OWN mid when it has one and off
the nearest same-wing neighbour when it does not — floored onto the contract's
tick, `workMode: 'passive'`, **alerted at ERROR every time**. A book that has to
quote instead of cross is invisible in every other record: the package looks
ordinary and so does the fill.

Floored rather than rounded to nearest: only a SELL reaches this path, so the
error falls on the side of the quote being taken rather than resting a tick above
theoretical all session.

---

## 5. Decisions worth naming

**`openedByEngine` is `origin === undefined`, and it is a label.** `/v1/desk/submit`
stamps `'manual'`, the repair path stamps `'repair'`, and an engine open stamps
nothing (`book.ts:applyActions`) — so an absent origin on a book this supervisor
steers is a leg the desk's own automation put there. It is informational: every
rule that must not touch a leg reads `protectedQty`, the operator's explicit pin.
A legacy leg reading as engine-opened costs a label, never an order.

**The coalescing gate reads the MARKET's clock.** `ChainView.touchedSince` answers
off the ticks' own timestamps — deliberately, so a fixture can replay a session
that is over — so the pass stamps the newest tick admitted, not `now()`. Stamping
a wall clock against a feed clock works on a busy feed and starves a quiet one.

**Boot is unconditional and the lease wait has no end.** A standby's `boot()` does
not resolve, so `main` has the health server LISTENING before it awaits — a
standby that answered nothing on `/health` would be indistinguishable from a
process that failed to start. `#heartbeat` stops steering the moment it learns it
lost the lease and stays up as a standby rather than exiting into a pm2 restart
loop.

**Dials come only from the row.** `resolveDials(row.dials)`, never the preset: a
preset is a prefill and the row is what the engine reads (`presets.ts`). Unknown
keys are ERRORed once per distinct set per book — silent is F-29, every five
seconds is noise nobody reads.

---

## 6. The local boot (brief step 3)

Real Mongo, a real `WsTransportServer`, a stub desk-api, a synthetic instrument
dump, and one frame of ticks. Two runs: the first on the real clock (a Saturday),
which held with `2026-08-22 is not an NSE trading day` — the session gate working
— and the second with the clock frozen at a Friday 10:00 IST:

```
info  instrument master loaded {"contracts":42}
info  nudge server listening {"port":18793}
info  lease acquired — this process is steering {"owner":"host:54949"}
error SMOKE-…:paper: 1 dial(s) on this book are NOT read by the engine … {"unknown":["nonsense_dial"]}
info  book started · warm start: last-known books seeded {"tokens":43,"rows":1}
info  bus connected
info  breach past a full lot-equivalent — routing without the confirm wait
info  decision routed {"decisionId":"SMOKE-…:paper:1","trigger":"shed",
      "reason":"sell 54 330CE (netΔ +89 vs allowed 3, shed 86; …)"}
>>>   POSTED: actions [{op:'open', instrument:'SMOKE26AUG330CE', side:'Sell', qty:1350}],
      work {trancheLots:3, chaseMaxMs:30000, chaseCrossBufferPct:0.005}
info  decision done · HEALTH {"books":[…],"lease":"host:54949","feedAgeMs":0}
MARKS JOURNAL  {"mark":9,"spot":300,"netDelta":89.0088,"netGamma":-0.4438,
                "band":2.663,"totalPnl":-324,"marginSource":"model"}
warn  SIGTERM received — stopping WITHOUT touching a book …
```

`rows: 1` of `tokens: 43` is the warm-start scope proving itself: the foreign
`token: 42` row in `desk-marks` was never read. `qty: 1350` is 54 × 25 — the one
place lots become contracts.

---

## 7. Mutation checks (evidence the tests bite)

| Mutation | Result |
|---|---|
| drop the cancel-once guard | 1 test fails |
| journal on every tick instead of every mark | 2 fail |
| `>` instead of `>=` on the strike-step invalidation | 1 fails |
| round the maker quote UP instead of down | 1 fails |
| warm start reads the whole `desk-marks` collection | 1 fails |
| dials captured at construction instead of read per pass | 1 fails |
| publish an EMPTY subscription list | 1 fails |
| skip `resolveInFlightOnBoot()` | 1 fails |
| never wire the 1-second poll timer | 1 fails |
| drop the snap in `#start` | 6 fail |
| `stop()` does not set the stop flag | the suite HANGS (a standby's wait never ends) |
| no registry re-entrancy guard | 1 fails |
| a failed start stays registered | 1 fails |

---

## 8. Concerns / carries for the controller

1. **PRE-EXISTING RED, unchanged and independent.**
   `apps/api/test/service.integration.test.ts` — "a PARTIALLY marked book names
   only the missing legs" (the known 26JUL fixture class, ticket 14 §8 item 2).
   `apps/api/src` is untouched by this ticket's diff and that test imports nothing
   from `@algomaker/desk-engine`.

2. **ON THE LIVE RAIL THERE IS NO WORKING PACKAGE TO PREEMPT — and this is the
   one place §8 is still short.** `service.ts:837` sets `worksAsync = via ===
   'engine' && mode === 'paper'`, so a LIVE engine decision settles `DONE` at
   route time even while its orders rest at the gateway. The supervisor's
   `inFlight` clears immediately, so the guard preemption and the maker-quote
   invalidation built here are exercised on the PAPER rail and on any package
   desk-api reports `WORKING`/`ROUTING` — not on a live resting order, which is
   the chaser's own exhaustion alert to handle. **Whoever takes live async
   (ticket 16 did paper) inherits the invalidation for free; until then a live
   maker quote rests until the chaser crosses or alerts.** Worth an explicit
   decision before the first live drill.

3. **`.env.local.example` is NOT in this commit.** `.gitignore` has `.env.*`, so
   the file the brief names is untracked despite its own header saying "`.env.local.example`
   is committed" — a pre-existing repo inconsistency. `DESK_SUPERVISOR_PORT=8793`
   was appended to the operator's local copy at `/Users/aaditya/Documents/dev/algomaker/.env.local.example`
   with the same wording as the ecosystem comment; the ecosystem entry sets the
   variable explicitly, so a deployment that never reads the template still gets
   the right port. **If the template is meant to be tracked, that needs a
   `.gitignore` exception and a rotation pass — it currently holds the leaked
   optionbhai passwords in plaintext.**

4. **The lease key is process-wide (`'desk-supervisor'`).** One supervisor steers
   every book it is given, which is the deployment we have. `lease.ts` already
   scopes to `${tag}:${mode}` the day books spread across machines; the day that
   happens, this constant is the one edit.

5. **`#quoteAt`'s "no price at all" branch is unreachable today, by construction.**
   `shed.ts` only sizes a sale for a strike whose greeks solved, and the greek
   solve and `theoreticalPrice` use the same mid — so a package with a sale in it
   always has a volatility to price against. The branch (drop the sale, log at
   ERROR, never cross) is kept as insurance against the two diverging, and is
   therefore untested.

6. **Ticket 14's carry 4 is still open and still pre-live.** The broker-truth
   true-up of `cumRealized` on the live rail: nothing here does it, and
   `cumRealized` feeds `totalPnl` and therefore the target lock. It remains a
   drills/launch-ticket job.

7. **The instrument master is rebuilt every 15 minutes and the ChainView is not
   told.** `tokensFor`/`futureToken` are asked through `master()` on every snap, so
   a rebuilt dump reaches the view at the next evaluation — but a book whose
   `chainMeta` (lot size, strike step) changed keeps the meta it was started with
   until it is stopped and started. Lot sizes do change at expiry roll. Cheap
   follow-up: refresh `runtime.meta` on the instrument timer.

8. **`evaluateDue` and `pollFlights` are public.** They are the loop bodies and the
   timers do nothing but call them, so a test that drives them is testing the loop
   rather than a wall clock. Nothing else calls them.

---

# Fix round 1 — review: Needs fixes (3 Important + 5 minors)

All 8 addressed. `8947e0fa` (code) + this appendix.

| | |
|---|---|
| Supervisor workspace suite | **158/158** (was 149) |
| desk-engine suite | 374/374, parity **22/22 / 1,152 marks** |
| Full node suite | **3,556 pass / 1 fail** (the same pre-existing red) |
| Typecheck | root + `@algomaker/web`, clean |
| Mutation checks | 9 this round, all caught (§F4) |

## IMP-1 — the stop flag gated the loops, not the wire

**Confirmed, both windows, and the second one is worse than the review says.**

*(a) A pass already inside `evaluate()`.* Clearing a timer stops passes that have
not STARTED. One that has is past that gate — between its book read and its
route, holding a fully-formed package — and `drain()` was letting it finish:
burn a `seq`, save, post. An order placed after the signal, by a process that is
going away, with nobody watching.

*(b) A signal during boot.* `main` installs the handlers before it awaits
`boot()`, and it must: a standby's lease wait has no end, so a shutdown has to be
able to interrupt a boot. But `boot()` checked `#stopping` exactly once, after
the lease. Everything after it is an await — the three index builds, the registry
pass (which calls `#start`, which **REPLAYS an in-flight decision, a POST**), the
warm start, the subscription publish, the bus subscribe, `#arm()`,
`#booted = true`. A SIGTERM at the registry read produced a process that was
shutting down and steering.

**Fixed in the reviewer's shape.** `EngineHost.stop()` sets a flag; `Supervisor.
stop()` calls it for every host **before** the drain; it is checked twice:

| Check | What it stops | Why it is not the other one |
|---|---|---|
| top of `#evaluateOnce` | a pass QUEUED behind another when the signal landed | it must not read the book, read the repair hold, or **bank the mark** — a write during a shutdown for a mark nobody will act on |
| immediately before `#route` | a pass that formed a package while reading | everything between the two is an await; this is the line before the `seq` is burnt |

**What deliberately survives it: a package that is already PERSISTED.** Once
`#route` has written `inFlight`, the id is burnt and this process owns posting
it — that is the exactly-once property, and abandoning it there leaves the next
boot a decision to replay for no reason at all. `drain()` still waits for that.

`boot()` re-checks after **every** await through a `halted()` helper that also
says so in the log, and `#start` checks on entry and again across the margin read
(dropping the half-built book) because that is the last await before the replay.

**Tests, replacing the "drive everything after the signal" shape with the real
property:**

- `STOP MID-PASS: a package formed before the signal is NOT routed` (host) — the
  pass is parked inside its book read, the signal lands, the barrier releases:
  zero posts, `seq` still 0.
- `a stopped host does not even START a queued pass` — asserts the state
  collection is *empty*, which is what separates the first check from the second.
- `a PERSISTED package still completes its post — that is exactly-once`.
- `SIGTERM MID-PASS: a decision formed before the signal never reaches the wire`
  (lifecycle) — the same property through the whole process.
- `SIGTERM DURING BOOT: nothing is armed and no boot replay is posted`.
- `SIGTERM INSIDE #start: the book is dropped and its flight is not replayed` —
  the sibling at the last await boundary.

The original D6 test is **kept** rather than replaced: "nothing NEW starts after
the signal" and "nothing already started completes a route" are two properties,
and the first one is still worth pinning.

## IMP-2 — the alert promised what the live rail cannot do

**Confirmed.** `#watchWhileWorking` runs only while an `inFlight` decision is
held, and desk-api makes a package async on the PAPER rail only
(`service.ts:837`: `worksAsync = via === 'engine' && mode === 'paper'`). A LIVE
engine decision settles `DONE` at route time, so the flight clears while the
order is still resting at the gateway and **nothing in this process comes back
for it**. The line said "if it does not fill it is invalidated and re-decided" on
both rails — on the one line an operator has to go on.

The alert is now rail-aware: on live it says this supervisor will not come back,
names what will (the gateway's chaser — crosses at `chase_max_ms`, or rests and
alerts), and says there is no `rest_max_min` re-decide on that rail. The
`#quoteAt` and `#watchWhileWorking` headers both carry the limitation, including
the note that both behaviours arrive on live for free the day desk-api makes it
async. Pinned by `THE MAKER-QUOTE ALERT DOES NOT PROMISE WHAT THE LIVE RAIL
CANNOT DO`, which needed a live-rail harness (`makeLive`) — the first thing in
this suite that is rail-specific, because everything else under test is not.

The report's §8 item 2 disclosure stands unchanged.

## IMP-3 — a partially-failed cancel latched as "done"

**Confirmed.** `workingOrderCanceller` throws only when NOTHING got through, so
one refusal out of two returned an ordinary count — and `#preempt`, which sets
`#cancelled` before the call and clears it only on a throw, read that as "asked
and done". `working-orders.ts`'s own "the next pass asks again" was untrue for
exactly the case it was written for, and the cost is a guard waiting behind a
still-working order for the rest of the session.

The sweep now reports `{requested, failed}`:

| Outcome | Host |
|---|---|
| `failed > 0` | latch RELEASED, ERROR naming both counts — the next pass asks again for what is left (the request is keyed by order id, so re-asking for the ones that went through changes nothing) |
| `requested === 0, failed === 0` | nothing was working any more: latched, at DEBUG. An ERROR claiming a package was cancelled when none was is the alarm that teaches an operator to ignore the real ones |
| a clean sweep | latched, logged at the caller's level |
| the call throws (nothing got through) | latch released, ERROR — unchanged |

Tested as `A PARTIALLY cancelled package is NOT latched as done` (partial → asks
again → clean → latched) and `a sweep that finds NOTHING working is latched,
quietly`.

## Minors

1. **The per-book `MarkClock` now says why it is per book.** The old comment
   invited exactly the wrong change: `next()` is a CONSUME, so a process-wide
   clock shared across books would have the first book evaluated in each window
   swallow the mark for all of them — every other book counting zero marks, its
   target-lock streak never advancing, and its journal empty. The sharing the
   field exists for is between a book and its own journal row.
2. **`lastEvalTickMs` is stamped from `ChainView.lastTickMs`**, not this
   process's feed-wide maximum. `#lastTickMs` counts every tick off the bus
   *including ones the view dropped for an undeclared chain*, so a busy unrelated
   instrument could push the stamp past the newest ADMITTED tick and hold a
   book's evaluation until something newer than that arrived. The view now
   exposes the same number `touchedSince` compares against, so the two cannot
   disagree.
3. **The "cancelling the working package" line is suppressed when nothing was
   cancelled** — see IMP-3's table.
5. **`NUDGE_PATH` is imported from `engine-notify.ts`** and re-exported, instead
   of a second literal. Two copies agree today and drift silently, because a
   nudge that 404s is swallowed by design and presents as "dial changes are
   sometimes slow".
8. **The maker-quote action is built by a branch**, not two conditional spreads
   whose interaction had to be read twice.

## Note on the `.env.local.example` edit (raised by the reviewer)

Acknowledged. `DESK_SUPERVISOR_PORT=8793` was appended to
`/Users/aaditya/Documents/dev/algomaker/.env.local.example` — the SHARED
checkout, outside this worktree — because that file is gitignored (`.env.*`) and
exists nowhere else. It is an append of a documented variable to an untracked
template; nothing else in the shared tree was touched, and the ecosystem entry
sets the variable explicitly so no deployment depends on the template. **The file
stays untracked pending the credential-rotation carry** (§8 item 3): it currently
holds the leaked optionbhai passwords in plaintext, so tracking it needs a
rotation first, not a `.gitignore` exception.

## F4 — mutation checks this round

| Mutation | Result |
|---|---|
| no check before `#route` | 1 test fails |
| no check at the top of a pass | 1 fails (the state collection is written) |
| hosts are not stopped before the drain | 1 fails |
| `#start` does not re-check before the replay | 1 fails |
| all three boot guards removed together | 1 fails |
| a partial sweep latches as done | 1 fails |
| the quiet sweep still shouts | 1 fails |
| the alert promises a re-decide on live too | 1 fails |
| (round-0 checks re-run) | still bite |

The `#start` entry check and the post-registry `halted()` are individually
redundant — each backstops the other on this path — and are covered collectively
by the combined mutation. That redundancy is deliberate: each guards a different
await, and the cost of one of them being removed by a later edit should be a
failing test, not a reachable POST.
