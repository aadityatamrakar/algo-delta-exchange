# Going live — the Node supervisor

The paper rehearsal for `apps/supervisor`, the process that replaces the Python
`desk-supervisor`. Two halves, and the second one is the important half:

1. **The rehearsal** — put every behaviour the engine has on the screen ON
   PURPOSE, with a scripted market, and check each one against the exact line it
   should print. §3–§5.
2. **The live-flip blockers** — four things that are open right now and that a
   live session must not start without. §7. They are stated as blockers because
   each of them is a way for a live book to be WRONG WHILE LOOKING FINE.

This is not `docs/GOING-LIVE-RUNBOOK.md`. That one is the 2026-07-30 record of
taking the PYTHON supervisor live on BAJFINANCE, and its sequencing advice is
still exactly right — **`recenter` never opens a position, it manages one that
already exists, so the book is entered by hand FIRST and the supervisor is
started only after it is confirmed.** Read it for the broker, margin and
allowlist steps; read this one for the process that now does the steering.

---

## 1. What is being rehearsed

| | |
|---|---|
| Process | `desk-supervisor` (`bin/desk-supervisor.mjs`, pm2 entry in `ecosystem.desk.config.cjs`) |
| Decides with | `@algomaker/desk-engine` — 22/22 parity boards, 1,152 recorded marks |
| Talks to the desk through | `POST /v1/desk/engine/decisions` and nothing else |
| Holds broker credentials | **none.** Whether an order can reach a real broker is decided by the gateway's mode and the per-book live switch |
| Its stop | inert. No square-off, no cancel, no `DESK_SQUAREOFF_ON_STOP` — not even off by default |
| Its memory | `desk-supervisor-state` (rule state, seq, working package, protected lots), `desk-book-marks` (one row per book per 5-minute mark) |
| Its health | `GET http://127.0.0.1:8793/health` — books steered, lease owner, feed age |

---

## 2. Before you start

**The desk, on the simulated broker.**

```sh
DESK_BROKER=simulate make up
npx pm2 logs desk-gateway --lines 20 --nostream | grep -i "BROKER MODE"   # must say simulate
```

**An instrument dump.** The feed publishes on the tokens the master resolves, so
without a dump nothing the rehearsal sends will be admitted by any book:

```sh
make sync
```

**Stop market data.** `apps/marketdata` binds `DESK_BUS_PORT` and two processes
cannot hold one port. The dry-run feed binds it instead, which is what lets the
rest of the desk see the rehearsal with no configuration at all:

```sh
npx pm2 stop desk-marketdata
```

**Rehearse INSIDE the session.** The engine's first gate is a trading day at or
after 09:20 IST and at or before 15:30 (`engine.ts:249`), and it reads the
SUPERVISOR's clock, not the feed's. Outside that window every scenario below
produces a healthy feed, a filling chain, journalled marks — and not one
decision, with the session hold in the reason string. The feed says so on
startup when you run it out of hours.

**Watch these three things while you work:**

```sh
npx pm2 logs desk-supervisor          # every decision, every hold, every alert
curl -s localhost:8793/health         # books, lease, feedAgeMs
```
…and the **Books page**, whose `desired`/`actual` cell is the single most
important thing on it: `asked to run, not running` means the supervisor did not
take the book up, and STALLED is a separate alarm meaning it took it up and has
stopped marking.

---

## 3. Create the book

On the **Books page → Create book**: symbol, expiry, variant
`recenter-relief-r` (Relief (live)), a tag, dials, and the SEED LEGS that are
the position the engine will manage. The wizard says it plainly and it is worth
repeating: **the book is created STOPPED and SWITCHED OFF.** Nothing steers it
until you press Start.

For a rehearsal, a **short strangle one strike step either side of spot** is the
right shape — it is what the scenarios below are written against:

| | |
|---|---|
| legs | short CE one step above spot, short PE one step below, same lots |
| dials | leave the preset alone except the four named below |
| `confirm_ms` | `0` while rehearsing. The default 5 s damping is correct live and only makes a scenario slower to read |
| `cooldown_s` | `0`, same reason |
| `target_pnl` | **set it to something this book can actually reach.** The preset is ₹2.5L; a four-lot rehearsal strangle collects a few hundred rupees, so leave the default in and the `lock` scenario simply never fires. Set it below about ¾ of the premium collected |
| `shift_margin_frac` | leave the preset's `0.6` for every scenario EXCEPT `rally`, and see that scenario for why |

Press **Start**. Within five seconds the log says `book started` and `actual`
turns to running.

---

## 4. The scenarios

```sh
node scripts/dryrun-feed.mjs <scenario>
```

The feed publishes ~2 frames a second over a 21-strike chain and its future, and
holds the terminal market until Ctrl-C. **Every price it emits is a function of
the frame index, not of the clock** — one seeded PRNG per scenario name, and a
`progress` counted in frames — so running a scenario twice emits the same walk
value for value, and "it did something different this time" is never the answer. `node scripts/dryrun-feed.mjs` with no argument prints the
list. It **refuses to run unless `DESK_BROKER=simulate`** — it puts prices that
are not the market on the bus the whole desk trades off.

Every reason string below is copied from a run of the scenario against a real
supervisor process; the numbers will differ with your book.

### `drift` — nothing to do, and the desk saying so

Spot wanders inside the band.

- **Log:** `debug hold … "netΔ -3 inside allowed 27 (|netΓ| 4.5 at spot 300.2)"`
- **Zero decisions.** `GET /v1/desk/books/registry/<tag>/decisions?mode=paper`
  answers with an empty `actions` list and a null `lastAction` (the mode is
  required and never defaulted).
- **`desk-book-marks` gains one row per book per 5-minute mark** — `mark`,
  `spot`, `netDelta`, `band`, `totalPnl`, `marginSource`. This is the one thing
  to check before trusting any other scenario: if the marks are not landing,
  nothing downstream of them (the lock's streak above all) can work either.
- **Books page:** `desired = actual = running`, no STALLED badge, `feedAgeMs`
  on `/health` in the low hundreds.

### `breach` — phase R sheds

Spot ramps ~5%: out of the corridor, and — with the preset's margin gate left
alone (see `rally`) — nothing phase S will take.

- **Log:** `decision routed … "trigger":"shed"` with
  `sell 1 290PE (netΔ -27 vs allowed 25, shed 2; zero-Δ point 2.12% of spot out)`
- **The action is a SALE:** `{"op":"open","instrument":"…290PE","side":"Sell","qty":25}`.
  `qty` is in CONTRACTS — lots × lot size — and this is the one place the
  multiplication happens.
- Once the sale is booked the reason goes back to `netΔ … inside allowed …`.
- **Broker tab:** the order works in tranches of `work_tranche_lots` (3 by
  default), one live at the broker at a time.

### `rally` — phase S shifts

Spot ramps ~10%, taking the one-step-OTM short call a full strike step ITM.

**Set `shift_margin_frac: 0` on the row before running this one, and put it back
to `0.6` afterwards.** The relief preset does carry `shift_enabled: true`, but the
gate in front of it (`shift.ts:marginArmed`) requires, under live pricing, a
margin figure that is BOTH fresh AND from the broker. A rehearsal book on a
simulate box has never been priced, so its `marginSource` reads `model`, the gate
stays shut, and phase S is silently skipped — the mark falls through to phase R
and you see a shed where the document says shift. `0` turns the GATE off, not the
shifting.

Putting it back matters for the same reason in reverse: the preset's
`shift_itm_steps` is `0.5`, so with the gate open the `breach` scenario's 5% move
also takes the short half a step ITM and shifts instead of shedding.

- **Log:** `decision routed … "trigger":"shift"` with
  `shift: 1 ITM short(s) re-centred on spot — sell 4 330CE`
- **Two actions, in one package:**
  `[{"op":"close","instrument":"…310CE"},{"op":"open","instrument":"…330CE","side":"Sell","qty":100}]`
- Afterwards the band re-widens and the book holds:
  `netΔ -19 inside allowed 33 (|netΓ| 5.1 at spot 330.0)`

### `decay` — the scrap tier

The wings collapse toward the tick while spot stands still.

- **Log:** `decision routed … "trigger":"scrap"` with
  `scrap-close: square off spent short(s) (<= 0.10/share) (290PE@0.10) — book it, no re-sell`
- One close per spent short, then `debug hold … "flat book"`.
- **`ruleState.scrapBanned` gains the strike** (`"290:PE:2026-08-28"`), which is
  what stops the desk selling it straight back.
- **Ordering worth seeing for yourself:** scrap runs BEFORE phase S and phase R.
  A paise short is bought back before the playbook starts a new package — never
  on top of one already in flight.

### `illiquid` — the maker quote

Every strike but the ATM goes UNQUOTED (a last print, no book) while spot
breaches. This is the TCS 2440 PE of 2026-08-17, generalised.

- **Log, at ERROR, every time:**
  `MAKER QUOTE: the chain would not take this sale, so TCS26AUG290PE is QUOTED at 0.05 (Black-76 theoretical, tick-floored) and worked passively. Nothing is crossed.`
- **The reason names each refusal:** `— no candidate has a book we would cross
  (310PE one-sided book, 300PE spread 25.0%, 290PE one-sided book); quote it, do
  not cross`
- **The action carries a price and a work mode:**
  `{"op":"open",…,"limitPrice":0.05,"workMode":"passive"}` — everything else this
  engine sends is priced by desk-api.
- **Expected side effect, not a fault:** legs on dark strikes show UNPRICED in
  the book's P&L. `midOf` substitutes the print for a greek; `exitPrice` never
  substitutes one for money (spec §6). A `totalPnl` of 0 on those marks is the
  exit-side rule working.
- **This is the alert to rehearse recognising.** A book that has to quote instead
  of cross is invisible in every other record — the package looks ordinary and so
  does the fill. This ERROR line is the only tell.

### `lock` — the target guard, and the fifteen minutes it takes

Every short decays to about a fifth of its value, floored deliberately so the
scrap tier does not buy them back and take the P&L with them.

**This scenario takes ~15 minutes of wall clock and there is no way to hurry
it.** The lock counts `target_confirm_marks` (3) CONSECUTIVE 5-minute marks, and
that streak is the desk's defence against a gap-open phantom mark (TCS
2026-06-19). Waiting it out IS the rehearsal.

**Read the streak out of `desk-book-marks`, not out of the log.** Every mark
carries its own reason, so the whole run is four rows — this is a real one,
`target_pnl` set to Rs500 on a book that had collected Rs800:

```
mark  9 | pnl  435 | netΔ -3 inside allowed 27 (|netΓ| 4.5 at spot 300.2)
mark 10 | pnl  705 | target within reach (Rs705 >= +Rs500) — confirming 1/3
mark 11 | pnl  705 | target within reach (Rs705 >= +Rs500) — confirming 2/3
mark 12 | pnl  705 | TARGET locked: total P&L Rs705 >= +Rs500 — flatten & bank
```

- **Mark 9 is the shape to notice**: the P&L was already positive and the streak
  did not start, because it was not yet past the target. The streak counts marks
  that QUALIFY, consecutively — one that does not resets it to zero.
- **Mark 12 routes `"trigger":"lock"`, ONCE**, and the whole book is in that one
  package — a close per leg, every one stamped `urgent`:

  ```json
  [{"op":"close","instrument":"…310CE","workMode":"urgent"},
   {"op":"close","instrument":"…290PE","workMode":"urgent"}]
  ```

  `urgent` is the guard tier's own work mode (spec §8): a playbook sale is worked
  passively, an exit the guard wants is not.
- **Every leg is closed, including one you opened by hand.** The lock takes the
  operator's leg too; that is deliberate (`guards.ts` §1) and it is the single
  most surprising thing this engine does.
- **Then it stays flat and says so:** `hold … "trigger":"lock"` with `target
  banked — staying flat`, on every tick for the rest of the session.
  `ruleState.targetLocked` is TERMINAL — a banked run does not redeploy — so to
  steer that tag again the row's state has to be cleared.

---

## 5. The restart drills

The four process-level drills are automated and they run against a real mongod:

```sh
node --test apps/supervisor/test/drills/restart-drills.test.ts
```

| Drill | What it proves |
|---|---|
| `kill -9` mid-decision | the package was on disk before it was posted; the restart replays the SAME id verbatim and the desk routes it exactly once |
| `kill -9` mid-package | the tranche cursor survives, and a short answer from desk-api cannot wind it back up and re-offer the package whole |
| SIGTERM | the feed opens AFTER the signal and nothing is posted, nothing is cancelled, no seq is burnt, the legs are untouched |
| SIGTERM on a standby | a boot interrupted while waiting for the lease never replays the package the book was holding |

**Do the SIGTERM one by hand as well, once, on the rehearsal book**, because it
is the one every restart path reaches — `make restart`, a deploy, a reboot, and
`max_memory_restart` at 11:40 with nobody watching:

```sh
npx pm2 restart desk-supervisor
```

Watch for `SIGTERM received — stopping WITHOUT touching a book. Positions, rule
state and any working package are durable and resume on restart.` Then check the
Broker tab: **no orders.** The runner learned this the expensive way on
2026-08-17, when an 11:40 memory bounce flattened the entire hosted book.

**One thing the drills surfaced that an operator should know:** a `kill -9`
releases no lease, so the replacement supervisor STANDS BY for up to the lease
TTL (30 s) before it takes the books. That is the mechanism working — two
supervisors on one book do not fight, they both work perfectly against the same
broker position — but it means a hard kill costs half a minute of unsteered book,
where a SIGTERM costs none (the stop releases the lease deliberately, so the
standby takes over in about a second).

---

## 6. Sign-off

Everything below should be true before anyone talks about a live flip.

- [ ] All six scenarios produce the line this document says they produce.
- [ ] `desk-book-marks` has one row per book per 5-minute mark for the whole
      rehearsal, with no gaps.
- [ ] `desired` and `actual` agree on the Books page for the entire session, and
      the STALLED badge never appears.
- [ ] `npx pm2 restart desk-supervisor` mid-session places NOTHING, and the book
      resumes with its rule state intact (check `desk-supervisor-state`).
- [ ] A dial changed from the Dials panel lands on the next evaluation, without
      a restart.
- [ ] `node --test apps/supervisor/test/drills/restart-drills.test.ts` — 4/4.
- [ ] Everyone who will touch the desk has read §8's first bullet: **a leg added
      by hand is UNPROTECTED and the engine will trade it** (the D12 reversal of
      the Python default).
- [ ] **Every blocker in §7 is closed.**

---

## 7. LIVE-FLIP BLOCKERS

**None of these is a rehearsal finding. Each one is a known, disclosed gap that
is safe on paper and is not safe live.** They are listed as blockers, verbatim,
because each has already been written down once in a ticket report and the
purpose of this section is that nobody has to find those reports to know the
session cannot start.

### BLOCKER 1 — the live rail has no working package to preempt

`apps/api/src/service.ts:837` reads

```
const worksAsync = req.via === 'engine' && req.mode === 'paper'
```

so a LIVE engine decision settles `DONE` at route time, **while its orders are
still resting at the gateway.** The supervisor's `inFlight` clears immediately,
and everything that hangs off holding a flight goes with it:

- `#watchWhileWorking` never runs for a live package, so **a guard cannot cancel
  it.** Spec §8's "cancel first, then act" is exercised on paper and on anything
  desk-api reports `WORKING`/`ROUTING`, and on nothing else.
- The maker quote's invalidation — `rest_max_min`, or a full strike step of
  underlying movement — never fires on live. A live maker quote rests until the
  gateway's chaser crosses it or gives up and alerts.

The alert already says which rail it is on rather than promising a re-decide it
cannot make (`engine-host.ts:#quoteAt`), so this is disclosed rather than silent
— but disclosure is not the fix. **The fix is making a live engine decision
async at desk-api**, at which point both behaviours arrive for free; ticket 16
did the paper half.

*Cited: ticket 15 report §8 item 2 and fix-round IMP-2; `engine-host.ts`
`#watchWhileWorking` and `#quoteAt` headers; `service.ts:837`.*

### BLOCKER 2 — `cumRealized` is not trued up against broker truth

On the live rail desk-api books a decision OPTIMISTICALLY, at route-time marks,
and **nothing ever restates it.** `reconcile-live.ts` repairs `desk-books` and
the decision journal; it does not touch this number. So a live book's
`cumRealized` drifts from broker truth by the difference between each fill's
assumed and actual price.

That number is not decorative. It feeds `totalPnl`, and `totalPnl` is what the
**target lock** fires on — the guard that flattens the whole book, including the
operator's own legs. Running live without the true-up means banking a run on a
P&L the broker never agreed with.

The work is bounded and the hooks are already in place: every fold writes
`cumRealizedBasis: {decisionId, basis: 'fill' | 'optimistic-mark', amount, at}`,
so the job is — for each `'optimistic-mark'` entry, read the broker's terminal
fills for that decisionId (`desk-fills` / `desk-engine-decisions`), recompute the
realised amount against the same basis rows, and apply the delta. Note the bound:
`REALIZED_BASIS_KEPT` is 200 folds, and the host WARNS when it starts evicting —
past that point only `desk-engine-decisions` still knows.

*Cited: ticket 14 report §8 item 4 (NAMED CARRY, "This must be done before, or as
part of, the first live drill"); ticket 15 report §8 item 6;
`state-store.ts` `RealizedFold` / `cumRealizedBasis`.*

### BLOCKER 3 — `DESK_CHASE_MS=1000` is not set

The order chaser runs on `setInterval(positiveEnvMs('DESK_CHASE_MS', 5_000))`
(`apps/order-gateway/src/main.ts:1944`), so **the pass interval is the real floor
on how fast a peg can follow the touch** — at most every 5 seconds. A 30-second
`chase_max_ms` deadline therefore gets about SIX peg opportunities, not the ~30
the 1-second dwell implies, and each freeze-split slice gets its own window from
its own `placedAt`.

Everything the supervisor sends passively — every playbook sale, and every maker
quote from §4's `illiquid` — is worked by that chaser. Lowering it to 1,000 is
safe for the blind ladder (independently gated by its own 15-second dwell) and
costs one bounded Mongo find per second. It was left at 5,000 deliberately,
because changing a shared timer was out of scope for the ticket that found it.

**Set `DESK_CHASE_MS=1000` in `.env.local` and `make restart` before the first
passive live session** — or decide, in writing, that 5 seconds is the intended
cadence.

*Cited: ticket 12 report concern 1; ticket 13 report concern 4;
`order-chaser.ts:145` (`NOTE: the pass interval … is the real floor`).*

### BLOCKER 4 — `.env.local` holds leaked plaintext passwords

`.env.local` (and the untracked `.env.local.example` beside it) currently carry
the optionbhai credentials in plaintext. `.gitignore`'s own comment records why
this is a blocker and not a chore: **"The repo has leaked 4 credential sets this
way already (`totp.js`, `finvasia.js`, the Atlas strings, `candlestrategy*.js`)"**
— and `server/datasources.json` and `totp.js` are still tracked with real secrets
in history.

Rotate the credentials, then the template can be tracked with a `.gitignore`
exception. Doing it in the other order publishes them.

This is the one blocker on the list that is not about the supervisor at all. It
is here because a live session is the moment the box holding those files starts
holding real money too.

*Cited: ticket 15 report §8 item 3 and the "Note on the `.env.local.example`
edit"; `.gitignore`'s credential block.*

---

## 8. Known-good, and known-open

**Proved and not on the blocker list:**

- exactly-once decision routing across a `kill -9`, at the process level (§5);
- the tranche cursor across a restart (§5);
- an inert stop, at the process level and in the unit suite (§5);
- the lease: two supervisors never steer one book, and a standby takes over on
  its own when the holder stops heartbeating;
- the engine itself: 22/22 parity boards, 1,152 recorded marks.

**Open, and NOT blockers — worth knowing before a live session:**

- **A LEG YOU ADD BY HAND TO A STEERED BOOK IS NOT PROTECTED, AND THE ENGINE
  WILL TRADE IT.** This is a deliberate reversal (D12) of the Python desk's
  default, and it is the single behavioural difference most likely to surprise
  an operator who worked the old desk. On the Python desk a hand-added leg was
  adopted PROTECTED — the engine left it alone until you said otherwise. From
  launch on the default is the opposite: whether it arrives from the Manual
  Order dialog, the repair Apply button or any other hand action, a new leg on
  a book the supervisor is steering is immediately eligible for `shed`, `scrap`
  and any close the phase logic decides on, at the very next 5-minute
  evaluation. The leg's `origin` stamp (`manual` / `repair`) does NOT protect
  it — it is an informational label and no rule reads it. **The ONLY thing that
  exempts a leg is the operator pressing Protect** — the Protect control on the
  book's page, `POST /v1/desk/engine/protect`, which requires the password on a
  live book. That writes `protectedQty`: a quantity in LOTS per instrument,
  held in `desk-supervisor-state`, so you can pin part of a position and leave
  the rest steerable. Nothing writes `protectedQty` implicitly, ever. So: if
  you hand a steered book a leg you intend to keep, press Protect in the same
  breath, or stop the book first. Protect it BEFORE the next 5-minute mark, not
  after — the engine does not ask twice.
- **PHASE S CANNOT FIRE ON A PAPER BOOK ON A SIMULATE BOX, at all.** The shift
  gate wants a margin figure that is both fresh and from the BROKER
  (`shift.ts:marginArmed`), the supervisor always prices `'live'`, and a paper
  book on simulate never gets one — so every shift the preset would take is
  skipped for the whole session, silently. On a real live book the 30-second
  margin sweep supplies the figure and the gate opens, so this is a rehearsal
  limitation rather than a defect. It is why §4's `rally` asks for
  `shift_margin_frac: 0` — and it means phase S is the one phase a rehearsal
  cannot prove without changing a dial.
- **The instrument master is rebuilt every 15 minutes; a running book keeps the
  `chainMeta` it started with.** Lot sizes change at an expiry roll, so a book
  running across one should be stopped and started.
- **The lease key is process-wide** (`'desk-supervisor'`). One supervisor steers
  every book it is given, which is the deployment we have; spreading books across
  machines is a one-line change to that constant.
- **There is no `make logs-supervisor`.** Use `npx pm2 logs desk-supervisor`.
- **A pre-existing red test:** `apps/api/test/service.integration.test.ts`
  — "a PARTIALLY marked book names only the missing legs" (the known 26JUL
  fixture class). Unrelated to the supervisor; do not let it mask a real one.

---

## Appendix — implementation deviations from the design spec

Two places where the shipped system does not match
`docs/superpowers/specs/2026-08-21-recenter-supervisor-migration-design.md`.
Both are deliberate and neither is a gap to close; they are recorded here so
that a reader holding the spec does not go looking for code that was never
written, and so that anyone who later wants the spec's version knows what they
would be adding rather than fixing.

**1. `DecisionResponse` carries no `book` echo.** Spec §9 gives the decision
response a `book: StoredBook` field, "post-fold echo". The implementation's
`DecisionResponse` (`packages/desk-engine/src/contract.ts`) stops at
`decisionId`, `replayed`, `status`, `fills`, `skips`, `routeErrors`. Nothing
wanted the echo: the supervisor re-reads `desk-books` at the top of every
evaluation (`#readBook`), so the position it acts on is always the stored one.
Shipping the echo as well would put a second statement of the book on the wire
that could disagree with the first, and the failure that produces — a
supervisor steering off a stale echo while Mongo says otherwise — is worse than
the round trip it saves. If a caller ever does need the post-fold book without
a re-read, adding the field is additive and breaks nothing.

**2. The decision journals are WRITE-ONLY, and the Books page reads something
else.** Spec §11 has `desk-engine-decisions` "rendered on the book page". It is
not, and neither is `desk-book-marks`. Both are written and never read back by
any route:

- `desk-engine-decisions` — written by the decision route
  (`apps/api/src/routes/engine.ts`, upsert keyed on the unique `decisionId`).
  It is the DURABLE record, append-only and unpruned, and it is what
  `desk-supervisor-state` defers to once its own 200-entry realized-basis list
  has trimmed (`state-store.ts:REALIZED_BASIS_KEPT`). Read it by hand in
  `mongosh` during an incident; that is its whole job.
- `desk-book-marks` — one row per book per 5-minute mark, written by
  `apps/supervisor/src/marks-journal.ts`. Its consumer is the sign-off check in
  §6 above ("no gaps"), performed by hand.

What the book page actually renders comes from `GET
/v1/desk/books/registry/:tag/decisions`, which serves `lastReason`,
`lastAction`, `lastReasonAt` and `actions` off the REGISTRY row's `actionLog` —
pushed by the same decision route, capped in the write at the newest 200
(`store.ts:appendDecisionAction`). One document read per poll instead of a
second collection queried per book, and the cap means the page cannot be made
slow by a pathological book.

The practical consequence, and the reason this deviation is worth knowing at
3pm on a live day: **the two records do not hold the same set.** `actionLog`
is appended only for a decision that was not a replay AND produced at least
one fill (`routes/engine.ts`: `if (!result.replayed && result.fills.length >
0)`) — deliberately, so a retry cannot show the operator two adjustments where
the book made one. `desk-engine-decisions` is upserted for EVERY decision the
route handled, fills or none. So when the question is "why did it not act",
the book page cannot answer it and the journal can:

```
mongosh algomaker --quiet --eval 'db["desk-engine-decisions"]
  .find({ tag: "<TAG>", mode: "live" }).sort({ receivedAt: -1 }).limit(20)
  .forEach(d => print(d.receivedAt, d.trigger, d.response.status, d.posts, d.reason))'
```

`posts` is the retry counter (`$inc` on every re-post of the same
`decisionId`), which is the other question this collection answers and the
page cannot: how many times did the supervisor have to ask?
