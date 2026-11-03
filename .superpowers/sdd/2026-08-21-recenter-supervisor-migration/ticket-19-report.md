# Ticket 19 — Restart drills, the dry-run feed, and the live-flip blockers

**Status:** COMPLETE. Branch `worktree-agent-a360d32bf52855953`, off `b24ea159`.

| | |
|---|---|
| Process drills | **4/4** (`node --test apps/supervisor/test/drills/restart-drills.test.ts`, 4.3 s) |
| Supervisor workspace suite | **162/162** (`node --test 'apps/supervisor/test/**/*.test.ts'`) — was 158, +4 drills |
| Full node suite | **3,561 pass / 1 fail** (`npm run test:node`) — the one red is pre-existing (§6.1) |
| Typecheck | `tsc -p tsconfig.json` clean. `@algomaker/web` NOT RUNNABLE in this worktree (§6.2); no web file is in the diff |
| Mutation checks | 4, all caught (§2.4) |
| Dry-run feed | all six scenarios driven against a real spawned supervisor (§3.3, §3.4) |
| Skip idiom | verified both ways: skips without a mongod, FAILS under `DESK_REQUIRE_MONGO=1` |

---

## 1. What was built

| File | What it is |
|---|---|
| `apps/supervisor/test/drills/restart-drills.test.ts` | the four process drills |
| `apps/supervisor/test/drills/harness.ts` | the rig: real mongod, real bus server, stub desk-api, the spawned launcher |
| `apps/supervisor/test/drills/freeze-clock.mjs` | the `--import` preload that puts the child inside the session |
| `scripts/dryrun-feed.mjs` | the scripted market: six scenarios, deterministic, ~2 frames/s |
| `docs/GOING-LIVE-RUNBOOK-SUPERVISOR.md` | the operator's paper rehearsal + **LIVE-FLIP BLOCKERS** |

---

## 2. The drills

### 2.1 Why they are processes and not objects

Everything in `apps/supervisor/test/*.test.ts` proves a property of an OBJECT —
a stop flag checked twice, a compare-and-set that refuses a stale writer, a boot
that replays one id. Those are the right shape for a rule and the wrong shape for
the question these drills ask, which is the one an operator actually asks: **if I
kill this right now, what does the desk do when it comes back?**

That question has no answer inside one process. `kill -9` destroys exactly the
part a unit test supplies for itself: the object graph, the pending promise, the
`finally`. What survives is what reached the DATABASE; what the broker heard is
what reached the WIRE. So the rig owns both ends and every assertion is made
against those two records, never against the child's account of itself.

| Piece | Real? | Because |
|---|---|---|
| the supervisor | the deployed `bin/` launcher, spawned | the launcher is where a `main()` that is never called hides |
| mongod | real | a fake dies WITH the process it was faking a database for |
| the bus | real `WsTransportServer` | the class `apps/marketdata` binds; a fake emitter cannot prove the child dialled a socket |
| desk-api | a stub | the drills are about the SUPERVISOR's exactly-once; the stub reproduces the one behaviour that matters — **the claim is written BEFORE the answer**, so a replay is answered rather than re-routed |
| the clock | shifted | the engine's first gate is the session gate |
| the master | a synthetic dump | the same 21-strike ladder `main-lifecycle.test.ts` decides against |

### 2.2 The four, and how each is made race-free

A drill that says "kill it and see" proves whatever the scheduler felt like. Each
of these has an exact barrier.

**1. `kill -9` MID-DECISION → exactly one routed decision.**
The stub PARKS the post: records it, claims it, never answers. "The stub has seen
a post" is then a precise statement that the child has already written its `seq`
and its `inFlight`, because `#route` saves BEFORE it posts. Assertions: the state
on disk holds `inFlight = TAG:paper:1` and `seq = 1`; exactly one post reached
the wire before the kill; the restart's post is byte-identical to the first
(`deepEqual`, i.e. verbatim, spec §7); **`api.routed.size === 1`**; the flight
clears on the outcome.

**2. `kill -9` MID-PACKAGE → the tranche cursor resumes.**
The stub answers `WORKING` with half the package filled, so `#progress` writes a
shrunken `remaining`. After the kill the restart is given a **short answer** —
`WORKING` with no fills at all, which is what desk-api returns when its record is
read before its fills are pushed back onto it. A supervisor that rebuilt
`remaining` from the REQUEST would read "nothing has filled" and re-offer the
whole package; one that resumes from the persisted cursor takes the smaller of
the two and does not move. The drill waits out a further 1.5 s so the 1-second
poll asks again, then asserts the cursor is unchanged.

**3. SIGTERM → zero orders.**
The feed opens only AFTER the signal is sent (`kill` is synchronous), so the
window in which anything could have been decided is not a narrow race but an
empty set. Then 24 frames go out over 600 ms — the shed the book is screaming
for — and the drill asserts: exit code 0 (the shutdown finished on its own, not
on the 15 s fuse), the stop line printed, **zero posts, zero cancels, no state
document at all** (no `seq` burnt), and the legs still exactly as the operator
left them.

**4. SIGTERM ON A STANDBY → the boot replay never happens.**
The lease is held under another owner with ten minutes on it and the book is left
holding a fully replayable package. A supervisor that won the lease would re-post
it during `#start` — drill 1 proves it does — so if a standby's interrupted boot
reached that line the stub would see it. It does not, the process exits 0 rather
than hanging on a lease wait that has no end, and the flight is still there for
whoever does win the lease.

### 2.3 The clock, and why it is a preload

The engine holds outside 09:20–15:30 IST on a trading day (`engine.ts:249`). A
drill on the wall clock would be green on the machine that wrote it and red in CI
at the wrong hour — the worst possible test. `freeze-clock.mjs` is loaded into the
child with `--import`, so **`bin/desk-supervisor.mjs` runs unmodified and does not
know it is under test**. A `DESK_CLOCK_OFFSET_MS` read by the composition root
would have been a test hook in production code, on the one process whose clock
decides whether the market is open, and the day somebody set it in `.env.local`
the desk would trade a session that is not happening.

It is an OFFSET, not a pin: `Date.now()` still advances, it simply sits on a
Friday morning. Pinning would freeze the mark clock, the lease TTL arithmetic and
every `asOf` comparison at one instant — a different process from the one that
runs in production. Timers are unaffected either way (libuv counts monotonic).

### 2.4 Mutation checks

| Mutation | Result |
|---|---|
| drop `resolveInFlightOnBoot()` from `#start` | drills 1 and 2 fail |
| `#progress` rebuilds `remaining` from the request instead of the cursor | drill 2 fails |
| remove the `SIGTERM` handler from `main()` | drills 3 and 4 fail |
| spawn the child with the wrong `DESK_API_TOKEN` | drill 1 fails |

The last one is why the stub CHECKS the bearer token rather than waving it
through: the real endpoint answers a missing one with a 401, which the host reads
as a DEPLOYMENT FAULT that will refuse every package for every book until
somebody fixes it — silently, because each individual refusal looks exactly like
a book that had nothing to do.

### 2.5 Two things the drills TAUGHT, which are now written down

**A `kill -9` costs half a minute of unsteered book.** It releases no lease, so
the replacement correctly STANDS BY until the dead holder's 30-second TTL lapses.
That is the mechanism working — two supervisors on one book do not fight, they
both work perfectly against the same broker position — and it is the reason
drills 1 and 2 advance the rig's market clock past the TTL rather than sleeping
through it: the restart happens where a restart really happens. A SIGTERM costs
nothing, because `stop()` releases the lease deliberately. This is in the runbook.

**`WsTransportServer.ready()` cannot be called late.** It waits on
`once('listening')` and caches the port only inside itself, so a caller that
constructs the server, does something slow, and only then asks, waits forever on
an event that has already fired. `apps/marketdata` never sees it because it awaits
on the next line. The harness takes the promise in its constructor and says why.
**Not fixed in `packages/bus` — out of scope, and no deployed caller hits it — but
it is a real trap for the next one.**

---

## 3. The dry-run feed

### 3.1 The shape

`scripts/dryrun-feed.mjs <scenario>` binds the SAME `WsTransportServer`
`apps/marketdata` binds, on the same port (`DESK_BUS_URL`'s, else
`DESK_BUS_PORT`), so the rest of the desk needs no configuration at all to see
it. `npx pm2 stop desk-marketdata` first — two processes cannot hold one port.

**The tokens are REAL** — resolved out of the `instrument` collection through the
same `OptionMaster` the supervisor resolves with. That is not decoration: a
`ChainView` DROPS a tick whose token belongs to no declared chain (§3 of its
header), so a feed that invented its own numbers would publish perfectly and
change nothing, which is the most expensive kind of rehearsal there is.

**Prices are Black-76** at a scenario-driven volatility — `packages/greeks`, the
same model the desk marks with — so the greeks the engine computes off these
ticks are internally consistent and the bands it draws are the bands it would
draw. **Every emitted price is a pure function of the FRAME INDEX** (one seeded
PRNG per scenario name, and a `progress` counted in frames), so two runs of one
scenario are identical value for value — see the fix note.

**It refuses to run unless the broker mode is `simulate`**, read the way the
Makefile's `ARM_GUARD` reads it (whitespace and quotes tolerated — the Makefile's
own comment records `  DESK_BROKER = "xts"` arming the real broker under a banner
saying `simulate`). There is deliberately no `FORCE=1`.

### 3.2 Three shapes that are load bearing, and were each got wrong first

1. **`illiquid` publishes a print with NO book, not a one-sided one.**
   `ChainView` RETAINS the last two-sided pair through a tick that carries no book
   (§1 — the TCS 2440 PE case), so a bid-only tick following any two-sided one
   leaves the OLD pair in place and the liquidity gate sees a healthy, ageing
   market. The refusal would eventually arrive as `Ns stale` — the right outcome
   for the wrong reason. A print with no depth is also what `marketdata`'s own
   `tickPayload` emits for a strike nobody is quoting.
2. **Its dark wing is anchored to `spot0`, not the moving spot.** These scenarios
   ramp; a boundary measured off the live spot walks across the ladder and hands a
   strike a pair halfway through the run. Everything but the ATM goes dark, and
   the ATM keeps its book because `theoreticalPrice` walks the wing outwards and
   needs ONE mid to solve a volatility off — a chain with no mid anywhere prices
   nothing and the host DROPS the sale instead of quoting it, which is a different
   behaviour and a different log line.
3. **`lock`'s decay is FLOORED at 60% of the volatility.** Decay it all the way
   (as `decay` does) and the shorts cross `scrap_close_px` in the first minute:
   the scrap tier buys them back, the book goes flat, the P&L the lock was
   counting disappears, and the guard never sees a second mark. The floor leaves
   each short worth about a fifth of what it was sold for — well past any sane
   target and well clear of scrap.

### 3.3 Every scenario, verified against a real spawned supervisor

Not asserted from the code — each was driven end to end (the feed as one child,
`bin/desk-supervisor.mjs` as another, a short strangle one step either side of
spot, a stub desk-api applying the fills back onto `desk-books` so the book
evolves as it would on the real rail). These are the actual reason strings:

| Scenario | Trigger | Reason, verbatim |
|---|---|---|
| `drift` | — (hold) | `netΔ -3 inside allowed 27 (\|netΓ\| 4.5 at spot 300.2)`, zero decisions, marks journalled |
| `breach` | `shed` | `sell 1 290PE (netΔ -27 vs allowed 25, shed 2; zero-Δ point 2.12% of spot out)` |
| `rally` | `shift` | `shift: 1 ITM short(s) re-centred on spot — sell 4 330CE` — two actions, close + open |
| `decay` | `scrap` | `scrap-close: square off spent short(s) (<= 0.10/share) (290PE@0.10) — book it, no re-sell`, then `flat book` |
| `illiquid` | `shed` + maker quote | `MAKER QUOTE: … TCS26AUG290PE is QUOTED at 0.05 (Black-76 theoretical, tick-floored) and worked passively. Nothing is crossed.` with `— no candidate has a book we would cross (310PE one-sided book, 300PE spread 25.0%, 290PE one-sided book)` |
| `lock` | `lock` | `TARGET locked: total P&L Rs705 >= +Rs500 — flatten & bank`, after `confirming 1/3` and `2/3` — see §3.4 |

**The finding that mattered most is not a calibration.** `recenter-relief-r`
carries `shift_enabled: true`, so `rally` looks like it should simply work — but
`shift.ts:marginArmed` additionally requires, under live pricing, a margin figure
that is BOTH `fresh` AND `source: 'broker'`. A rehearsal book on a simulate box
has never been priced by desk-marketdata's 30-second sweep, so its `marginSource`
reads `model`, **phase S is skipped without saying so**, and the mark falls
through to phase R. The operator sees a shed where the checklist says shift and
has no way to tell which of five things went wrong. The scenario now carries a
NOTE — printed in `--help` AND on startup — saying to set `shift_margin_frac: 0`
first and put it back to `0.6` afterwards, because the preset's
`shift_itm_steps` is `0.5` and with the gate open the `breach` scenario's 5% move
also shifts instead of shedding. The runbook's dial table says the same.

Two calibrations came out of that pass and are in the committed script:

- **`rally` had to be +10%, not +6%.** Phase S measures how deep the short strike
  is ITM in strike STEPS, and `shift_itm_steps: 1` on a 10-point ladder wants spot
  a full 10 points through the short call. A 6% move on a 300-rupee underlying
  does not deliver it and the scenario silently showed a shed instead.
- **`breach` was reduced to +5%**, so that it is out of the corridor and
  deliberately NOT far enough to be a shift. The two scenarios now show two
  different phases rather than the same one twice.

One emergent detail worth keeping: in `illiquid` the ATM strike's own refusal is
`spread 25.0%`, not a one-sided book — as spot ramps away, the ATM option gets
cheap and the tick-sized spread becomes a quarter of the mid. That is exactly how
`sell_max_spread_pct` fires on a real chain.

### 3.4 The `lock` verification, and the honest cost

Driven the same way, `target_pnl` set to Rs500 on a book that had collected
Rs800. **It took fifteen minutes of wall clock — 04:56:20 to 05:11:21 — and that
is the finding, not the overhead.** The whole run reads out of
`desk-book-marks`, because every mark carries its own reason:

```
mark  9 | pnl  435 | netΔ -3 inside allowed 27 (|netΓ| 4.5 at spot 300.2)
mark 10 | pnl  705 | target within reach (Rs705 >= +Rs500) — confirming 1/3
mark 11 | pnl  705 | target within reach (Rs705 >= +Rs500) — confirming 2/3
mark 12 | pnl  705 | TARGET locked: total P&L Rs705 >= +Rs500 — flatten & bank
```

**ONE decision, one post** — the whole book in a single package, each close
stamped with the guard tier's own work mode:

```json
[{"op":"close","instrument":"TCS26AUG310CE","workMode":"urgent"},
 {"op":"close","instrument":"TCS26AUG290PE","workMode":"urgent"}]
```

Afterwards: `ruleState` reads `targetStreak: 3, targetLocked: true`, `desk-books`
has **no legs left**, and every later tick holds with
`trigger: "lock"`, `target banked — staying flat`.

Four things this pass settled that no amount of reading would have:

- **Mark 9 did not start the streak**, and that is the whole mechanism. Its P&L
  was already positive (Rs435) and simply not past the target, so the streak
  stayed at zero. A mark that does not qualify RESETS it — three consecutive
  qualifying marks, not three marks with a good one somewhere in them.
- **The marks journal is the operator's view of the streak.** `confirming 1/3`
  and `2/3` are journalled per mark, so an operator watching `desk-book-marks`
  sees the guard arming without tailing a log. The runbook says to read it there.
- **The guard fires exactly once and then holds forever.** One post, one
  decision, both legs in it, `workMode: 'urgent'` on each — and afterwards every
  tick holds with `target banked — staying flat`. `targetLocked` is terminal by
  design; a banked run does not redeploy.
- **The 15 minutes is irreducible.** `target_confirm_marks` is 3 and the grid is
  5 minutes; there is no dial that makes a rehearsal of the lock faster without
  rehearsing something other than the lock. The scenario's FIRST shape decayed
  over half the run, so the P&L only crossed the target around the third mark and
  the third QUALIFYING mark would have landed at twenty minutes — past the window
  anyone would sit through. Hence the decay now finishing in the first quarter:
  the decay is not what the scenario is about, the streak is.

---

## 4. The runbook

`docs/GOING-LIVE-RUNBOOK-SUPERVISOR.md`. It is deliberately NOT a replacement for
`docs/GOING-LIVE-RUNBOOK.md` — that one is the 2026-07-30 record of taking the
PYTHON supervisor live on BAJFINANCE and its sequencing advice still governs
(**`recenter` never opens a position; the book is entered by hand FIRST and the
supervisor started only after it is confirmed**). This one covers the process
that now does the steering.

§2–§6 are the rehearsal: the desk on simulate, marketdata stopped, a dump synced,
the book created from the preset (the wizard says it: created STOPPED and
SWITCHED OFF), then each scenario with the exact log line, the exact dashboard
cell and the exact collection to look in. It names four things an operator would
otherwise discover the hard way:

- **Rehearse inside the session.** The session gate reads the SUPERVISOR's clock,
  not the feed's, so out of hours everything looks healthy and nothing decides.
  The feed prints this itself when run out of hours.
- **Set `target_pnl` to something the rehearsal book can reach.** The preset is
  ₹2.5L; a four-lot strangle collects a few hundred rupees, so leave it and the
  `lock` scenario simply never fires.
- **Set `shift_margin_frac: 0` for `rally`, and put it back afterwards.** The
  margin gate is what silently turns that scenario into a shed (§3.3), and the
  preset's `shift_itm_steps: 0.5` is what would turn `breach` into a shift if you
  forgot to put it back.
- **The lock takes ~15 minutes and waiting it out IS the rehearsal.** Three
  consecutive 5-minute marks is the desk's defence against a gap-open phantom
  mark (TCS 2026-06-19).

§5 is the drills, including the one to do by hand once (`npx pm2 restart
desk-supervisor` mid-session → **no orders**), and §6 is a sign-off checklist
whose last item is "every blocker in §7 is closed".

---

## 5. LIVE-FLIP BLOCKERS (runbook §7)

All four are stated as blockers, with citations, because each is a way for a live
book to be **wrong while looking fine**. Summarised here; the runbook has the
full telling.

**1. The live rail has no working package to preempt.** `service.ts:837` —
`worksAsync = via === 'engine' && mode === 'paper'` — so a LIVE engine decision
settles `DONE` at route time while its orders rest at the gateway. The flight
clears immediately, and with it both things that hang off holding one: a guard
cannot cancel a live package (spec §8's "cancel first, then act" is exercised on
paper only), and the maker quote's `rest_max_min` / strike-step invalidation never
fires on live. The alert is already rail-aware rather than promising a re-decide
it cannot make, but **disclosure is not the fix — making a live engine decision
async at desk-api is**, and both behaviours then arrive for free.
*Cited: ticket 15 §8 item 2 and fix-round IMP-2; `engine-host.ts`
`#watchWhileWorking` / `#quoteAt`.*

**2. `cumRealized` is not trued up against broker truth.** Live folds are booked
optimistically at route-time marks and nothing restates them —
`reconcile-live.ts` repairs `desk-books` and the decision journal, not this
number. It feeds `totalPnl`, and `totalPnl` is what the **target lock** fires on:
the guard that flattens the whole book including the operator's own legs. The job
is bounded because every fold writes `cumRealizedBasis: {decisionId, basis,
amount, at}` — for each `'optimistic-mark'` entry, read the broker's terminal
fills, recompute against the same basis rows, apply the delta. Note the bound:
`REALIZED_BASIS_KEPT` is 200 and the host WARNS when it starts evicting.
*Cited: ticket 14 §8 item 4 ("This must be done before, or as part of, the first
live drill"); ticket 15 §8 item 6.*

**3. `DESK_CHASE_MS=1000` is not set.** The chaser runs on
`setInterval(positiveEnvMs('DESK_CHASE_MS', 5_000))`
(`order-gateway/src/main.ts:1944`), so the pass interval is the real floor on peg
cadence — a 30-second `chase_max_ms` deadline gets ~6 peg opportunities, not the
~30 the 1-second dwell implies. Everything the supervisor sends passively is
worked by that chaser, the maker quote included. 1,000 is safe for the blind
ladder (independently gated by its own 15 s dwell) and costs one bounded Mongo
find per second. **Set it, or decide in writing that 5 s is intended.**
*Cited: ticket 12 concern 1; ticket 13 concern 4; `order-chaser.ts:145`.*

**4. `.env.local` holds leaked plaintext passwords.** Rotate first, then the
template can be tracked with a `.gitignore` exception; the other order publishes
them. `.gitignore`'s own comment is the argument: *"The repo has leaked 4
credential sets this way already"*, and `server/datasources.json` and `totp.js`
are still tracked with real secrets in history. The one blocker on the list that
is not about the supervisor — it is here because a live session is the moment the
box holding those files starts holding real money.
*Cited: ticket 15 §8 item 3 and its `.env.local.example` note.*

---

## 6. Concerns / carries

1. **PRE-EXISTING RED, re-verified today and untouched.**
   `apps/api/test/service.integration.test.ts` — "a PARTIALLY marked book names
   only the missing legs" — is **still failing** (39/40 in that file, and the one
   red in the full 3,562-test run). A parallel ticket has not landed a fix as of
   this branch's base. `apps/api` is not in this ticket's diff.

2. **THIS WORKTREE HAS NO `node_modules`, AND THAT IS LOAD BEARING FOR ANY
   REVIEWER RE-RUNNING THESE NUMBERS.** Bare `@algomaker/*` specifiers resolve up
   the directory tree to the SHARED checkout's `packages/` —
   `import.meta.resolve('@algomaker/bus')` answers
   `/Users/aaditya/Documents/dev/algomaker/packages/bus/src/index.ts`, not this
   worktree's. Relative imports (`bin/desk-supervisor.mjs` → `../apps/supervisor/
   src/main.ts`, and everything the drills reach) DO stay inside the worktree, so
   what was exercised is this branch's supervisor against the shared checkout's
   packages — and `diff -rq packages …` says the two trees are byte-identical
   today (only gitignored broker cookie jars differ), so nothing here is wrong.
   **It would be wrong the moment a worktree changed a package**, and it is not
   specific to this ticket: it is a property of the whole worktree workflow.

   The same gap is why `npm run typecheck`'s SECOND half cannot run here:
   `apps/web` keeps its own `node_modules` (it has `@vitejs/plugin-react`), the
   worktree has none, and `vite.config.ts` fails to resolve it. `tsc -p
   tsconfig.json` — the half that covers everything in this diff — is clean, and
   `git diff --stat b24ea159..HEAD -- apps/web` is empty.

3. **The drills add ~4.3 s and four spawned processes to the workspace suite.**
   They are picked up by the root glob (`apps/*/test/**/*.test.ts`) and skip
   themselves without a mongod, failing instead under `DESK_REQUIRE_MONGO=1`. They
   allocate their own nudge port per spawn rather than defaulting to 8793, so they
   do not collide with a supervisor a developer has running — but they DO spawn
   real processes, and a CI box with no `SIGKILL` permission would hang rather
   than fail. Nothing here has seen that.

4. **`WsTransportServer.ready()`'s late-call trap is documented, not fixed** (§2.5).

5. **The dry-run feed reads `.env.local` through `process.loadEnvFile`.** An env
   var already set wins (Node's own `--env-file` rule), so
   `DESK_BROKER=simulate node …` still means what it says — but a box with no
   `.env.local` at all reads as `simulate`, which is the right default for a
   fresh checkout and the wrong one for a box that arms its broker some other way.
   The safety gate is a name check, not a probe of the gateway.

6. **The lock scenario needs `target_pnl` set for the book being rehearsed.** The
   feed cannot know what premium the operator collected, so this is an
   instruction in the runbook rather than something the script can do. A book left
   on the preset's ₹2.5L will run `lock` for twenty minutes and show nothing.

7. **There is no `make logs-supervisor`.** `make logs` tails everything and
   `npx pm2 logs desk-supervisor` tails one; the runbook says so. A one-line
   Makefile addition if anyone wants it — deliberately not made here.

8. **PHASE S IS UNREACHABLE ON ANY BOOK WITHOUT A BROKER MARGIN FIGURE, and that
   is a paper/simulate fact rather than a defect.** `marginArmed` requires
   `margin.fresh && margin.source === 'broker'` under live pricing, and the
   supervisor always prices `'live'`. On a real live book the 30-second margin
   sweep supplies one, so the gate opens; on a paper book on a simulate box it
   never does, so **every shift the preset would take is silently skipped for the
   whole session**. The rehearsal works around it with `shift_margin_frac: 0`, and
   the runbook says so — but it is worth a decision whether a PAPER book should
   read the gate differently, because as it stands the paper rail can never
   exercise phase S at all, which makes it the one phase a rehearsal cannot
   honestly prove without changing a dial.

9. **The runbook's `illiquid` P&L note is a real behaviour, not a workaround.**
   Legs on dark strikes read UNPRICED, because `exitPrice` never substitutes a
   print for money (spec §6) while `midOf` does substitute one for a greek. A
   `totalPnl` of 0 on those marks is the exit-side rule working, and an operator
   who has not seen it before will read it as a broken feed.

---

# Fix round 1 — review: Approved, 1 Important + 1 minor

Both addressed. `cdd95242` (the feed) + `9123c246` (the bus note) + this appendix.

| | |
|---|---|
| Process drills | **4/4** |
| Supervisor workspace suite | **162/162** |
| `packages/bus` suite | **15/15** |
| Typecheck | `tsc -p tsconfig.json` clean |
| Replay check | 3 scenarios, two runs each, **identical value for value** (§F2) |

## IMP-1 — the price PATH was wall-clock-derived, and the header said it was not

**Confirmed, and the header was the worse half of it.** `progress` was
`(Date.now() - startedAt) / (seconds * 1000)`, and `progress` is the only input
`walk()` has besides the PRNG — so it did not merely time the walk, it WAS the
walk's independent variable. Scheduler jitter, a GC pause or a loaded machine
moved `spotMult` and `volMult` directly, which means two runs of one seeded
scenario emitted different prices. Meanwhile the DETERMINISM header said "the
clock is used only for the TIMESTAMPS and never for the path", which is exactly
the claim an operator would lean on when a rehearsal did something different the
second time: they would go looking for a change in the desk.

**Fixed as the reviewer specified — `progress` is now the FRAME INDEX:**

```js
const totalFrames = Math.max(1, Math.round((seconds * 1000) / frameMs))
const progress = Math.min(1, frames / totalFrames)
```

`totalFrames` is derived from `frameMs` rather than from `rate` so it stays
honest when the two differ: `rate` is what was asked for, `frameMs` is what
`setInterval` will actually do with it. `--seconds` is therefore a wall-clock
REQUEST, honoured by choosing how many frames to spread the walk over, and the
clock now reaches the `ts` field and the status line and nothing else.

The header no longer asserts determinism, it enumerates the two things that make
it true — the seeded sequence and the frame-counted progress — and says what a
wall-clock `progress` would have cost.

## F2 — the replay check, and evidence it bites

A throwaway harness spawns the feed, attaches a `WsTransportClient` before frame
0 (the first frame is one `frameMs` after the bind, so a retry loop wins the
race — and if it ever did not, the two runs would differ in LENGTH, which the
check reports rather than hides), captures 400 ticks, strips `ts`, and diffs two
runs.

| Scenario | Result |
|---|---|
| `breach` | 400 / 400 ticks, **identical** |
| `illiquid` | 400 / 400 ticks, **identical** (including the dark-book branch, which emits no `bid`/`ask` at all) |
| `drift` | 400 / 400 ticks, **identical** |

Mutation: restoring the wall-clock `progress` makes run A and run B **differ at
tick 3** (`price 89.85` vs `89.86`) — so the check is measuring the thing that
was wrong, not agreeing with itself.

## MIN-1 — the `ready()` trap is written down where the trap is

`WsTransportServer.ready()` now carries it in its own JSDoc: it waits on
`once('listening')` and caches the port only inside itself, so a caller that
constructs the server, does something slow, and only then asks waits FOREVER on
an event that already fired — no timeout, nothing logged, presenting as a process
that started and then did nothing. The note says to await it immediately after
construction, records that `apps/marketdata` is safe because it awaits on the
next line, and points at the one caller that cannot
(`apps/supervisor/test/drills/harness.ts`, which captures the promise in its
constructor). It was previously written down only in that harness, three
directories away from anyone who would hit it.

`packages/bus` is otherwise untouched: 15/15.
