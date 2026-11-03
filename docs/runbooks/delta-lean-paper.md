# Delta-lean — the four paper books

The last step of the delta-lean plan, and the deliverable the whole plan exists
to produce: **NIFTY and SENSEX, each with the aggressive and the conservative
preset, four registry rows, all of them `mode: paper`.** Decision D10 ends the
delivery here. Going live is a separate decision, taken after at least two weeks
of these four running side by side (spec §11).

> Since 2026-10-17 the daily family has two more presets, the **zero** books
> (the conservative book on a year's tuned dials, and its 0-DTE trend-down
> sibling): six rows a day, seven on an expiry morning. "The four" below means
> that family. See §9.

The engine those four books run is the hold-and-adjust one of
`docs/superpowers/specs/2026-09-22-delta-lean-hold-adjust-design.md`: it opens
one hedged package a day, neutralises by adding, and closes nothing before the
14:50 window except on the day target (₹10,000), the day backstop (₹30,000
aggressive, ₹15,000 conservative — R1 of the 2026-10-04 review, applied
2026-10-05; it was ₹2,00,000 on both) or the stuck rule.

| | |
|---|---|
| The script | `scripts/delta-lean-books.mjs` — `--dry-run` (the default), `--json`, `--apply`, `--help` |
| The daily book roll | `scripts/delta-lean-roll.mjs`, from cron at 08:50 IST — §7 |
| What it creates | four rows in `desk-books-registry` **per trading day** (§6), plus the companion `desk-strategies` row each one needs |
| Who steers them | `desk-supervisor`, one `EngineHost` per book, on the delta-lean decide path |
| The dial that selects that path | `delta_lean_enabled` — nothing else branches on anything else |
| Its stops | the engine's four exits (`dl_day_target`, `dl_stuck_loss`, `dl_day_max_loss` and the 14:50/14:55/15:00 flatten) and the desk's day guard, armed at registration at 1.5 x the same resolved `dl_day_max_loss` (`guardStopFor`) |
| Tested by | `apps/api/test/delta-lean-registration.test.ts`, `apps/api/test/delta-lean-roll.test.ts` |

There is no CLI path for a registry row. Creation is HTTP, three calls per book:
`POST /v1/desk/books/registry` (which always lands `desired: 'stopped'`), then
`POST /v1/desk/books/registry/:tag/start`, then
`PATCH /v1/desk/strategies/:tag {modes:{paper:{enabled:true}}}` to flip the
paper switch on. A fresh paper create lands the row ON (desk-api turns a NEW
paper strategy row on at create), so on a new row the PATCH is belt and braces;
it is what covers a row that already existed OFF — a running book that is
switched off has every order refused — so it is sent after every start
regardless. The script is the only place those twelve calls
are written down — and the roll (§7) performs them every morning, because a
delta-lean book lives **one trading day** (§6).

---

## 1. Before you register anything

### 1.1 `make sync` — FIRST, and not optionally

```sh
make sync
```

This refreshes two tables that every order these books place is sized against:

- **The instrument dump** (`instrument`), which is where the lot size, the
  strike step and the **expiry** come from. The script reads
  `OptionMaster.nearestExpiry` and nothing else. It never reads
  `INDEX_UNDERLYINGS` in `packages/instruments/src/index.ts`, whose NIFTY lot
  size (75) and weekly expiry weekday (Thursday) are **both stale** — the
  current truth is 65 and Tuesday, and that table's own comment says so. A book
  registered against the stale weekday would hold the wrong contract; one sized
  against the stale lot would mis-size every order in the book.
- **The NSE freeze table** (`desk-freeze-limits`), which decides how an order
  too large for one ticket is split into tranches.

Confirm the dry run below prints `lot 65, strike step 50` for NIFTY and
`lot 20, strike step 100` for SENSEX. Those numbers come out of the dump you
just synced; if they are anything else, the sync did not take.

> **SENSEX and BANKEX freeze rows come from BSE's abridged contract master**,
> fetched by `make sync` and by desk-marketdata's 08:45 IST refresh (and once
> at startup when the table has no BSE row). See §5.5. Before a live run,
> confirm the row is there:
> `db['desk-freeze-limits'].find({source:'bse-contract-master'})` must show
> SENSEX. Paper does not need it — but a paper order that goes out with an
> `unsplit` badge is telling you it is missing.

### 1.2 Both symbols must be on the spot feed

`apps/marketdata` publishes an index spot only for the symbols in
`DESK_UNIVERSE` (its own env, not the supervisor's). The regime detector is
driven by that spot tape: with no tape the ring stays empty, every window reads
`unknown`, and a delta-lean book holds on every pass **looking exactly like a
book in a quiet market**.

```sh
grep -E '^\s*DESK_UNIVERSE' .env.local     # must contain NIFTY and SENSEX
```

The supervisor audits this and says so out loud — see §3.4.

### 1.3 Turn the tick tape on

The controller cannot be replayed or re-tuned against a 60-second display
snapshot, and `desk-marks` is exactly that. `desk-ticks` is the real tape, and
it is **off** unless asked for:

```sh
# .env.local
DESK_RECORD_TICKS=1
```

then `make restart`. Exactly `1` — `0`, `true` and `yes` are all "off" on
purpose, so a half-set variable cannot silently start writing. Confirm:

```sh
npx pm2 logs desk-marketdata --lines 200 --nostream | grep "tick tape"
# tick tape RECORDING — DESK_RECORD_TICKS=1 { collection: 'desk-ticks' }
```

Nothing in the trading path reads `desk-ticks`. It exists so that in two weeks
there is something to tune against, which is the only way the paper run pays for
itself.

### 1.4 The desk up, on the simulated broker

```sh
DESK_BROKER=simulate make up
npx pm2 logs desk-gateway --lines 20 --nostream | grep -i "BROKER MODE"
make status
```

Paper books route through the paper rail regardless of the gateway's mode, so
this is hygiene rather than a gate. The gate is that every row these books get
is `mode: paper`, which is §2's whole subject.

---

## 1b. The desk must be running THIS code first

The four books were created on 2026-09-15 and are sitting `desired: stopped`.
They were deliberately not started, because the desk processes at the time were
running the pre-delta-lean build. That matters more than it sounds:

- The old `resolveDials` does not know `delta_lean_enabled` or any `dl_*` key.
  It routes an unknown key to `unknown` rather than coercing it, so the book
  would have resolved to `DEFAULT_DIALS` and run on the **recenter** engine — a
  short-premium corridor manager pointed at an index chain it was never meant
  for.
- The old `desk-api` does not arm the day guard on registration, which is why
  `dailyLimits` is currently absent on all four companion strategy rows.

So the order is: deploy, restart, re-register, then start.

```bash
# 1. the desk processes must carry the delta-lean build
pm2 restart desk-api desk-supervisor desk-marketdata desk-gateway
```

**Do not blanket-restart the namespace.** `desk-runner` squares off on SIGTERM
(`apps/runner/src/main.ts`), so restarting it flattens the hosted book at
whatever the marks happen to be — the 2026-08-17 incident. `desk-supervisor`'s
stop is deliberately inert and is safe to restart during market hours; the
runner is not. Restart the four above, never `pm2 restart desk`.

**Restart onto a new build only while the four books are FLAT** — after 15:00
and before 09:15. This is a delta-lean rule and it is stronger than "the
supervisor's stop is inert". The engine's whole no-second-package guarantee is
`dlOpenedMs`, which lives in the book's stored `ruleState`. A plain restart on
the same build re-reads it and is safe; a build that changes how that state is
read (the v2 cut-over itself: a v1 row carries no `dl*` fields and hydrates as
**not opened**) hands the new process a row it reads as not opened while the
book is holding the morning's package. Step 6 then opens a SECOND hedged
package on top of the first — double the size, double the margin, and two
hedges the engine will never take off before the close. Flat books have no
package to double, so the window between the flatten and the next morning's
warm-up is the only safe one. If a mid-session restart is forced on you, stop
every delta-lean book that holds legs first:

```
mongosh algomaker --quiet --eval 'db["desk-books"].find({tag:/delta-lean/,"legs.0":{$exists:true}},{tag:1,_id:0}).toArray()'
```

and restart only once that list is empty.

```bash
# 2. re-run the create. Already-registered books converge on 200, and the
#    converge path is what arms the day guard from the resolved dl_day_max_loss.
node scripts/delta-lean-books.mjs --apply
```

Confirm the guard is actually armed before you walk away — an unarmed guard
looks exactly like an armed one on the Books page:

```bash
mongosh algomaker --quiet --eval '
  db["desk-strategies"].find({tag:/delta-lean/},{tag:1,dailyLimits:1,modes:1,_id:0}).toArray()'
```

Expect `dailyLimits.stop` of **100000** on each aggressive book and **15000**
on each conservative one. Absent means desk-api is still the old build, whatever
pm2 says about uptime.

And expect **`modes.paper.enabled: true`** on every row you want trading. A
fresh paper registration is born ON (desk-api turns a NEW paper strategy row on
at create; a row that already existed keeps whatever you set), but a row the
day guard tripped, or one you switched off from the Strategies page, stays OFF
across a re-register — and a book whose switch is off does not trade: the
supervisor sees the switch and idles the book ("switched off for paper — not
deciding" in its `lastDecision`), and any package it does form is refused.
Flip it from the Strategies page, or with a PATCH on the tag.

## 2. Register the four books

### 2.1 Dry run — the default, and it creates nothing

```sh
node scripts/delta-lean-books.mjs --dry-run
```

It prints one block per book. Read four things in each:

1. **`mode paper`.** All four. The footer restates it as a count:
   `4 books planned. paper: 4. live: 0.`
2. **The expiry**, read off the dump: the nearest weekly **on or after today,
   today inclusive** — NIFTY's Tuesday, SENSEX's Thursday. On a Tuesday the
   NIFTY books carry that very day's contract; expiry day is traded (D6) and a
   one-day book has no tomorrow to protect. The tag ends in today's date, not
   the expiry (§6).
3. **The contract line** — exchange, lot, strike step. §1.1.
4. **The risk dials.** Both: `margin_cap 2500000`, `dl_day_target 10000`.
   Aggressive: `dl_open_lots 4`, `dl_max_adjusts_day 6`, `dl_stuck_loss 25000`,
   `dl_day_max_loss 30000`. Conservative: `2`, `0`, `15000`, `15000`. These are
   spec §4's two columns, with `dl_day_max_loss` moved by the review's R1
   (2026-10-05; §4 had 200000 on both) and conservative's
   `dl_max_adjusts_day` moved from 4 to 0 on 30 Oct 2026 (§9.5). If they are
   not these numbers, the presets moved.

`--json` prints the exact request bodies instead, every `DEFAULT_DIALS` key
(146 today) resolved in each, for diffing or piping.

**The dials are resolved, not referenced.** A preset is a one-time prefill
copied into the book's own dials; nothing re-reads `PRESETS` for a running book.
The aggressive preset states only its base, because `DEFAULT_DIALS` already *is*
spec §9's aggressive column — so the script folds the preset onto the defaults
once, here, and the row carries every number. A row that carried only the base
would move the day the engine default moved, silently, on a running book.

### 2.2 Apply

```sh
node scripts/delta-lean-books.mjs --apply
```

Needs `DESK_API_TOKEN` (it is in `.env.local` on a configured box) and a
reachable `desk-api`. Per book it prints a `created` line, a `started` line and
a `switched on` line. It stops at the first failure rather than pressing on —
the script is re-runnable, an identical re-register converges on HTTP 200
instead of refusing, and the switch PATCH is idempotent, so the fix for a
half-finished run is to run it again.

**Call 3 is the paper switch**, `PATCH /v1/desk/strategies/:tag
{modes:{paper:{enabled:true}}}`. Registration has added the tag to
`desk-strategies` with the switch **off** (the API may come to land it on for a
fresh delta-lean paper row; the script does not depend on which — the PATCH is
idempotent and goes out after every start regardless), and a book that is
`desired: running` but switched off is the worst of both: the supervisor decides all day and every order is refused
INVALID — hundreds of red rows on the book page, which is exactly what happened
on 09-16..09-18. A PATCH that does not answer 200 aborts the run: 400 "not added"
means the create did not land its strategy row.

Verify from the other side:

```sh
curl -s -H "authorization: Bearer $DESK_API_TOKEN" \
  'http://127.0.0.1:8790/v1/desk/books/registry?mode=paper' | head -c 2000
```

Four rows, `desired: "running"`, and — the one that matters —
**`"mode":"paper"` on every one**. Then the switches, beside the guard,
because a running book whose switch is off idles all day and fills nothing:

```sh
mongosh algomaker --quiet --eval '
  db["desk-strategies"].find({tag:/delta-lean/},{tag:1,modes:1,dailyLimits:1,_id:0}).toArray()'
```

Every row `modes.paper.enabled: true` and `dailyLimits.stop` armed. A fresh
create lands ON, and the scripts PATCH the switch on after every start they
issue; an existing row that was switched OFF by hand stays OFF across a
re-register the scripts did not start. Then check nothing reached the other
registry:

```sh
curl -s -H "authorization: Bearer $DESK_API_TOKEN" \
  'http://127.0.0.1:8790/v1/desk/books/registry?mode=live'
# books: []
```

### 2.3 Why the script cannot create a live book

Stated here so it can be re-checked rather than trusted:

- `mode` is a module constant, not a parameter — not an argument, not an
  environment variable, not a field a caller may pass.
- An **unrecognised flag is a hard error**, so `--mode live` exits 1 rather than
  being ignored on its way to a run that does something else.
- `assertAllPaper` throws — it is not a warning printed above four books being
  created — and it runs inside `planBooks`, again before anything is printed,
  and **again on each payload in the line before its POST**.
- The start call sends the literal `{"mode":"paper"}`, and a create whose
  response echoes any other mode aborts the run. The switch PATCH is the
  frozen constant `{modes:{paper:{enabled:true}}}` — a live switch would need
  the operator's password, which the machine token does not have.
- `apps/api/test/delta-lean-registration.test.ts` pins all of it, including that
  the refusal names which book is wrong.

---

## 3. Day one — what to watch

Each trading day has its own four books (D1, §6): the 08:50 roll creates,
starts and switches them on, and at 09:15 a book begins warm-up. No operator
action, no restart. Trading starts at **09:30**, after every detector window
has a full reading (D9).

### 3.1 The first decision

```sh
TAG=NIFTY-delta-lean-aggressive-2026-09-22     # today's tag — see §6
curl -s -H "authorization: Bearer $DESK_API_TOKEN" \
  "http://127.0.0.1:8790/v1/desk/books/registry/$TAG/decisions?mode=paper"
```

`lastReason` is the current state, rewritten every mark — it answers "why is it
doing nothing right now". `actions` is the history of decisions that actually
traded. An empty `actions` means the book has never traded, which before 09:30
is correct.

What you want to see by mid-morning is a first `dl-open` action, then at most
a handful of `dl-add`/`dl-neutral` ones, and a `lastReason` that reads like a
regime rather than a refusal.

### 3.2 The regime in the journal

`lastReason` carries `decideDeltaLean`'s own words (`packages/desk-engine/src/
delta-lean/decide.ts`), rupees as `RsN,NNN` and the day clock as `HH:MM`. The
figures below are the aggressive preset's (`dl_adjust_confirm_s 60`,
`dl_adjust_cooldown_s 600`, `dl_max_adjusts_day 6`, `dl_stuck_loss 25000`,
`dl_stuck_confirm_s 300`, `margin_cap 2500000`):

| Reads like | Situation |
|---|---|
| `chop: nothing to express — waiting for a trend or a quiet range` | not yet opened; the detector has no trend and no quiet range to open on |
| `trend-up for 45s — inside the 60s confirm window` | not yet opened; the regime hasn't held long enough to justify the open |
| `trend-up: opening up, 2 leg(s) at 4 lot(s) a leg, hedge included` | the day's ONE open (trigger `dl-open`) — a quiet open reads `opening none, 4 leg(s)…` |
| `trend-up/lean: the book is at 1.40 delta-lots against a wanted 1.40 — nothing to add` | opened; the wanted posture is already met, nothing to do |
| `trend-up/lean: 1.00 delta-lots against a wanted 1.40 — trend-up already justified the last package` | an adjustment is wanted but the SAME regime already paid for one — the churn guard, not a block |
| `trend-up/lean: 1.00 delta-lots against a wanted 1.40 — trend-up for 45s, inside the 60s confirm window` | an adjustment is wanted; the regime hasn't re-confirmed for `dl_adjust_confirm_s` yet |
| `trend-up/lean: 1.00 delta-lots against a wanted 1.40 — 320s left of the 600s cooldown` | an adjustment is wanted; `dl_adjust_cooldown_s` since the last package hasn't elapsed |
| `trend-up/lean: 1.00 delta-lots against a wanted 1.40 [order budget]` | an adjustment is wanted and cleared every gate; the pacer is holding it back one tick, not refusing it |
| `trend-up/lean: 1.00 delta-lots against a wanted 1.40 — pyramiding by adding 1 lot(s)` | an adjustment fired (trigger `dl-add`): the open's own trend resumed, so the book leans further its own way |
| `trend-down/counter: 1.40 delta-lots against a wanted 0.00 — neutralising by adding 2 lot(s)` | an adjustment fired (trigger `dl-neutral`): the tape flipped against the open, so the book buys the regime's option back to zero — never reverses |
| `quiet/flat: 0.60 delta-lots against a wanted 0.00 — neutralising by adding 1 lot(s)` | an adjustment fired (trigger `dl-neutral`): sideways, so the book sells the same-side ATM option to flatten |
| `trend-up/lean: 1.00 delta-lots against a wanted 1.40 — all 6 adjustments are spent — but Rs-4,000 is inside the Rs-25,000 stuck floor, so the clock is not running` | blocked (cap or `dl_max_adjusts_day`) but not losing enough yet — the stuck clock is not armed |
| `trend-up/lean: 1.00 delta-lots against a wanted 1.40 — all 6 adjustments are spent at Rs-28,000 — 120s left of the 300s stuck window` | blocked AND losing past `dl_stuck_loss` — the stuck clock is armed and counting down `dl_stuck_confirm_s` |
| `the detector has no reading — holding what the book holds` | the windows have no answer; the book holds what it has and nothing is blocked |

**`the detector has no reading` all session is the one to escalate.** It is
what a book with no spot tape looks like, and it is indistinguishable from a
genuinely unreadable tape until you check §3.4.

**A wedged working package or a repair hold resets the stuck clock every
tick.** `lastReason` reading `working package: N lots still being worked` or
`repair-Apply is working this tag — standing down until it finishes` is a
WAIT, not a BLOCK (§6.4 of the design spec), so `dl-stuck` cannot fire while
either persists — even if the book is deep in loss and an adjustment has been
wanted for an hour. This is not the day going unwatched: the EOD flatten
windows, the day target and the day-loss backstop are all evaluated ABOVE the
adjustment gates on every tick and keep running regardless.

### 3.3 The 15:00 flatten

The day clock is `dl_flatten_passive_min 890` (14:50), `dl_flatten_urgent_min
895` (14:55), `dl_flat_by_min 900` (15:00). After 15:00 the book is idle; F&O
trades until 15:40, so there is a 40-minute buffer and the book is out before
the 15:15 CAS starts in the cash segment.

At 15:05, for each of the four tags:

```sh
curl -s -H "authorization: Bearer $DESK_API_TOKEN" \
  "http://127.0.0.1:8790/v1/desk/positions?tag=$TAG&mode=paper"
```

**Zero open legs is the pass.** The `lastReason` should read `stopped for the
day — flat already`: the flatten latched `dlStopped` when the book went flat,
and from that tick on step 1 (the latched stop) outranks step 2 (the clock),
so the row is journalled under `dl-stop` and not under `eod`. A book still holding at 15:05 is the single
most important day-one finding: it means the flatten did not complete, and the
residual should have gone to the blind ladder. Capture `actions` and the
supervisor log for that window before anything resets it.

### 3.4 Did any book say its symbol publishes no spot

```sh
npx pm2 logs desk-supervisor --lines 2000 --nostream | grep -i "NO index spot"
```

The supervisor audits this a minute into the session. For a **delta-lean** book
it logs at **ERROR**:

> NO index spot has EVER been published for SENSEX while the md.spot feed is
> carrying other symbols. Its delta-lean books have no tape: the regime reads
> "unknown" on every pass and they will NOT trade, silently. Add the symbol to
> DESK_UNIVERSE on desk-marketdata, or stop these books.

Nothing is stood down and nothing is refused — the book behaves however its
engine decides to behave with no tape, which is: holds, quietly, all day. This
line is the difference between "the market was dull" and "this book was never
connected". Check it on day one even if the books look busy, because it is
per-symbol and SENSEX can be dark while NIFTY is fine.

### 3.5 The rest of the day-one sweep

- **Both day stops armed.** Registration arms the desk's day guard off the
  resolved `dl_day_max_loss` at 1.5 x (rounded up to ₹1,000): **45,000 on the
  aggressive rows and 23,000 on the conservative ones**, off the 30,000 /
  15,000 backstop R1 set on 2026-10-05 (before that, 300,000 on every row off
  a 200,000 default). Check the book rows show `dl_day_max_loss` at 30,000 /
  15,000 and `dl_stuck_loss` at 25,000 / 15,000, aggressive/conservative, and
  the strategy rows' day guard at 45,000 / 23,000 — the day guard and
  `dl_stuck_loss` both reading unset or zero means the dials were posted
  unresolved. A row registered before the R1 merge keeps the stop it was armed
  with until it is re-registered or its `dl_day_max_loss` is patched; the
  daily four are created fresh each morning, so the first roll after the merge
  arms them all by the new rule. **`dl_stuck_loss` is not a stop.** `dl-stuck`
  needs an adjustment to be WANTED and blocked (by the SPAN cap or by
  `dl_max_adjusts_day`) as well as the loss — see §6.4 of the design. A book
  the tape has already neutralised wants nothing, so nothing is blocked, no
  clock arms, and the book simply bleeds to `dl_day_max_loss` or to the 15:00
  flatten, whichever comes first. So the worst case to plan for is the
  backstop: **₹30,000 / ₹15,000 per book and ₹90,000 across the four** on the
  engine's line, ₹1,36,000 at the desk guard behind it. On the conservative
  book the backstop and the stuck floor are the same 15,000, so the urgent
  backstop fires there before the stuck clock can run out.
- **The tape is growing.** `desk-ticks` should have rows for both index spots
  and the near-month futures. An empty collection at 10:00 means §1.3 did not
  take, and the two weeks of tape this run is for will not exist.
- **Order pacing.** At most 2 orders/second and 40 orders/minute per book. A
  `[order budget]` suffix on `lastReason` is the pacer working, not a fault.
- **The conservative books should trade less than the aggressive ones.** If the
  four books look identical, the presets did not land. Since 30 Oct 2026 a
  conservative book places its open and nothing after it until it exits
  (§9.5): a `dl-add` or `dl-neutral` on one is a row still on the old dials.

---

## 4. Stopping a book

```sh
curl -s -X POST -H "authorization: Bearer $DESK_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"mode":"paper"}' \
  "http://127.0.0.1:8790/v1/desk/books/registry/$TAG/stop"
```

`mode` is **required in the body**; without it the call is a 400, not a stop.
The row goes to `desired: 'stopped'` and the supervisor is nudged immediately
rather than finding out at its next convergence pass.

**A stop does not flatten.** It takes the book off the desk; whatever it holds,
it keeps. `SIGTERM` is inert on this supervisor by design (a 2026-08-17 incident
where a memory-limit restart flattened the hosted book), and there is no opt-out
— the delta-lean book flattens on its own clock and on boot, never on a signal.
So if you are stopping a book that is holding, flatten it from the dashboard
first, then stop it.

Starting it again is the same call with `/start`.

---

## 5. Known limitations — read these before you read the results

Each of these was found during the implementation. They do not block the paper
run; they change how its results should be read, and two of them must be closed
before anything goes live.

### 5.1 Paper fills pay the touch — since 2026-10-16

**Since the 2026-10-16 deploy** (spec `2026-10-16-six-playbooks-design.md` F2),
`packages/brokers/src/simulator.ts` fills a resting LIMIT **on the touch**: a buy
at the ask once `ask ≤ limit`, a sell at the bid once `bid ≥ limit`. The old
trade-through rule still applies when the tick carries no quote. Stop orders are
unchanged.

**Before that deploy** the simulator filled only on a print strictly through the
limit, at that print's price, and a crossed limit with no print through it could
rest for ever — how the 1 Oct hedge was stranded. **The paper record therefore
breaks at the deploy**: days before it paid no spread, days after it pay the
touch. Compare like with like. `DESK_SIM_SLIPPAGE` still applies only to stop
orders.

**Paper results read slightly optimistic against live.** A book that adds on a
move already underway and cuts on a drawdown pays the spread on both ends of
every unit, several times a session — so the optimism compounds with trade
count, and the aggressive books will flatter themselves more than the
conservative ones. Do not compare a paper P&L to a live one without an explicit
haircut, and do not treat a thin paper edge as an edge.

### 5.2 A paper book and a live book do not reconcile leg for leg

Two fields mean different things on the two rails:

| Field | Live | Paper |
|---|---|---|
| `openedTs` | the decision instant | the **fold-pass** instant |
| `entryPrice` | the decision-time mark | the simulator's **actual fill** |

So the same decisions produce legs that differ in both time and price between
rails, by construction. Timing analysis across the two is meaningless at leg
granularity; compare decisions (the `actions` log) instead, which is the same on
both.

### 5.3 The NSE holiday table is hardcoded for 2026 and FAILS OPEN in 2027

`packages/desk-engine/src/session.ts` carries `MARKET_HOLIDAYS_2026`, and
`isTradingDay` returns `true` for any weekday of a year the table does not
cover. Its own test asserts that fail-open behaviour, so this is not a bug to be
found — it is a known expiry date on the file.

**It must be replaced before January 2027 or these books will trade on
holidays**, which for an always-flat intraday book means opening a position on a
day nothing will fill it back out on. Put it on the calendar now; the paper run
spans 2026 and will not surface it.

### 5.4 The two day stops can cross at slightly different moments

There are two, deliberately — the engine's own day stop (`decideDeltaLean`,
against `dl_day_max_loss`) and the desk's day guard (`apps/api/src/day-guard.ts`,
armed at registration at 1.5 x the same dial, rounded up to ₹1,000 —
`guardStopFor`). They are defence in depth, not
duplicates. The guard sits further out ON PURPOSE (2026-10-04 review, H2): its
exit for a delta-lean tag is `flattenTag`, which does not see orders already out
and rebuilds from fills the paper fold may not have landed, so firing beside the
engine's own `dl-stop` flatten could close a leg twice and flip the book. They
also **read different mark sources**, so near one another they can cross the same
threshold seconds apart. Seeing one fire without the other in the same instant
is expected, not a fault.

The guard also **degrades to realised-only when a leg is unpriced**: an
incomplete P&L row is still judged, on the realised half alone, and the log says
so — `(judged on REALISED only; a leg was unpriced)`. That makes it fire **late
rather than early**, which is the right direction for a backstop and the wrong
direction to rely on as the primary stop. The primary stop is the engine's.

Since R1 (2026-10-05) the engine's backstop sits at 30,000 / 15,000, close
enough to a bad day's real loss that it is a live exit on one (1 Oct's
aggressive book crossed −30,000 at 12:50). The desk guard, at 45,000 / 23,000,
is still the disaster case: it should only fire when the engine is not exiting
at all.

### 5.5 SENSEX freeze limit comes from BSE's contract master

NSE's `qtyfreeze.csv` carries no BSE underlying, so SENSEX's freeze row has
its own source: BSE's abridged contract master,
`https://www.bseindia.com/downloads1/Abridged_CO.ZIP`, entry
`BSE_EQD_CONTRACT_abr_DDMMYYYY.csv`, column `MaxTradQty` (contracts). The
parser (`packages/instruments/src/freeze.ts`, `parseBseContractCsv`) keeps
index rows only — `FinInstrmNm` in `IO`/`IF`; stock rows would collide with
NSE's under the same symbol key — and stores **one number per symbol, the
MIN across its futures and options rows**, because `desk-freeze-limits` is
keyed by symbol alone and the gateway resolves both kinds of contract to
`SENSEX`. As of 2026-09-21 that is SENSEX 500 contracts = **25 lots per
order** on lot 20 (futures 500, options 1000); BANKEX 600 / lot 30 = 20;
FOCIT 900 / lot 45 = 20 (futures 900, options 1350). Rows are stamped `source: 'bse-contract-master'`
and `syncedAt`; the sync never overwrites a row without that stamp.

`make sync` runs it, desk-marketdata runs it at 08:45 IST daily and once at
startup when the table has no BSE row, and the freshness stamp is
`md.health.bseFreezeSyncDay` (null until this process has refreshed it). It
fails soft: a blocked or reshuffled download logs `BSE freeze sync FAILED`
and leaves the previous rows in place.

When the limit IS unknown — the sync has not landed yet, or a new underlying
— the order still goes out **whole**, and the gateway journals ONE
`ok: true` PLANNED row with a `warning`. On the book page that is an
`unsplit` badge beside the status (the full sentence is in the "every step"
dialog), and the gateway logs the sentence once per book per process. It is
not a failure and it is not red. On paper that is harmless — nothing reaches
an exchange. **On live, a SENSEX order above BSE's freeze quantity is
rejected outright**, so an `unsplit` badge on a live book means: check
`md.health.bseFreezeSyncDay`, the marketdata log, and run `make sync`.

---


## 6. A book lives one trading day

A delta-lean book is born in the morning and is done at 15:00. The tag names
the **day** and the preset — `NIFTY-delta-lean-aggressive-2026-09-22` — so
each morning's four are **new rows**, and a book's page is one clean day of
orders, reasons and corrections rather than a week of them piling up on one
tag (D1). `symbol` and `expiry` are fields on the row; the tag carries
neither, and nothing anywhere parses a tag.

The expiry is the nearest weekly **on or after today, today inclusive** —
`OptionMaster.nearestExpiry(symbol, today)`. Expiry day is traded like any
other (D6), and a book that lives one session has no tomorrow to protect, so a
contract expiring today is exactly what a book born today holds: on a Tuesday
the NIFTY books carry that Tuesday's expiry and the SENSEX books carry
Thursday's, under tags that all end in Tuesday's date.

And it is gone the next morning. A book that is done and flat leaves the Books
page in the first 08:50 roll after its session — stopped and erased in that
one run (§7.1, operator ruling 2026-10-05: "which is done and closed, why
still on tab"). Its fills, decisions and daily report stay on the Reports
page; only the registry row and its `desk-books` document go.

By hand, that is:

```sh
node scripts/delta-lean-books.mjs --dry-run     # today's four tags, today's expiries
node scripts/delta-lean-books.mjs --apply       # create, start, switch on
```

— which is exactly what the roll (§7) does first every morning, before it
retires the old books. The script never re-points an existing tag at a
different book: a create that disagrees with the row on file is a 409,
deliberately, because silently re-pointing a book that may hold a position is
worse than refusing. Running it by hand and letting the 08:50 run fire too is
safe — they converge rather than collide, but only one of them reports what
happened, so prefer the roll.

---

## 7. The daily book roll — `scripts/delta-lean-roll.mjs`

§6 is a daily chore, and a daily chore is a daily chance to forget. The
failure it guards against is silent: a book that outlives its day keeps
deciding under an old tag, its page keeps growing, and a `lastReason` that
reads exactly like a quiet market. Nothing alarms.

So the roll runs from cron every weekday morning at **08:50 IST**, and this
section is what it does, how to install it, and how to read its log.

```sh
node scripts/delta-lean-roll.mjs             # dry run — THE DEFAULT, changes nothing
node scripts/delta-lean-roll.mjs --json      # the same plan as JSON
node scripts/delta-lean-roll.mjs --apply     # create+start+switch on, THEN stop, THEN erase
node scripts/delta-lean-roll.mjs --help
```

### 7.1 What it does, per symbol

1. Reads the **paper** registry rows out of `desk-books-registry`.
2. Plans **today's four** by tag: `planBooks(expiriesFrom(master, today), today)`
   — the same payloads, presets and every `DEFAULT_DIALS` key (146 today)
   resolved, as a hand-registration would produce — less any series switched
   off in `SERIES_OFF` (§8.4, §9.4), as for the hold pairs and the playbooks. A row that exists and runs is *on target*; one that exists
   but is stopped is started only when something needs retiring (otherwise it
   is your decision, left alone).
3. Decides which rows are **ours**: `variant` is one of the two delta-lean
   presets **and** the dials carry `delta_lean_enabled: true` — never a tag
   substring, so a recenter book whose tag happens to read `delta-lean` is
   invisible to it, and the four legacy weekly-tag rows
   (`NIFTY-2026-09-22-…`, `SENSEX-2026-09-17-…`) are retired by this rule on
   the first run without their tags ever being read. Of those, the rows whose
   dials carry `dl_hold_to_expiry: true` are the **hold-to-expiry** books
   (§7.7) and are set aside: they are never retired by the day rule of
   steps 6–7 (their own retire is by expiry, §7.7).
4. **Creates, starts and switches on today's four BEFORE anything else** —
   and right after them, still before any stop, any new hold-to-expiry pair
   (§7.7), by the same three calls, provided the engine on disk knows
   `dl_hold_to_expiry` (otherwise no pair, and an `ATTENTION` line). The
   third call per book is `PATCH /v1/desk/strategies/:tag
   {modes:{paper:{enabled:true}}}` — a fresh paper create lands the switch ON,
   so on a new row this is belt and braces; it is what covers a row that
   already existed OFF, and a running book that is switched off decides all
   day and has every order refused INVALID. It is sent after every start
   regardless of what the create landed (it is idempotent). Beyond the books
   it starts this run, the roll PATCHes one kind only: a book of today
   (one of the four, a hold pair, a playbook book) registered **this
   morning** that is running with its switch OFF, carries no day-guard stamp
   and has **never marked** — what a switch-on that failed leaves behind (a
   switched-off flat book idles before its mark, so it never marks) — gets
   the same three calls again, so the re-run that failure's message advises
   finishes it. A book the day guard switched off is never PATCHed, so a day
   guard that tripped a book is never undone by a hand re-run; and a running
   book of today whose switch is off for any other reason (it has marked, or
   it was registered on an earlier morning) is named in `ATTENTION` and left
   off for you. To take a book off for the day, stop it (§4) rather than
   switch it off: a book you switched off before its first mark would be
   switched back on by a same-day re-run, while a stop is respected (the box
   below says when, and only when, it is not). A create,
   start or switch-on that fails for one of the four or a hold pair takes the
   whole run down before a single stop goes out. The playbook books (§8) go
   last and are **fenced**: one that fails stops only the playbook family
   (the playbook books after it are not sent, and that morning's playbook
   retire is skipped) and is an `ATTENTION` line, exit 1 — while every other
   stop, erase and settle still goes out.
5. **Flat is judged from the legs in `desk-books`** under that `{tag, mode}`. A
   book that holds anything — or whose legs cannot be read — is never stopped
   and never erased. See §7.4. **The one exception is a book whose every open
   leg is on a contract that expired before today**: no flatten can ever fill
   it, so the roll first *settles* it — `POST
   /v1/desk/books/registry/:tag/settle-expired?mode=paper` (§7.5) — and only a
   book the server then reports flat (`remaining: 0`) goes on to the stop and
   erase below, by the same day rule. A settle the server refuses leaves the
   book exactly as it was, in `ATTENTION`. One leg on a **live** contract and
   the whole book is a holder again: alarmed, untouched.
6. **Stops the old books still running and flat**: `POST
   /v1/desk/books/registry/:tag/stop` — every one of them before any DELETE,
   because a DELETE on a running row is a 409.
7. **Erases the flat books created before today** — yesterday's and anything
   older: `DELETE /v1/desk/books/registry/:tag?mode=paper` — never
   `flatten=1`, never `purge=1`. The "day" is the IST date of the row's
   `createdAt`, and the cutoff is **today**: a book born Monday is stopped
   and erased in Tuesday's run, Friday's in Monday's, and a book from before
   a holiday in the first run after it. There is no stopped-for-a-session
   stage any more (operator, 2026-10-05: "which is done and closed, why
   still on tab").

   A stop with no erase after it is now the exception, and each one is
   explained: a delta-lean row born **today** that is not one of today's four
   (a hand-registered extra) is only stopped; a row whose `createdAt` cannot
   be read is stopped and never erased (it is named in `ATTENTION` — set
   `createdAt` by hand or delete it from the Books page); and a retire on a
   symbol whose books today would not all be running is **withheld**
   altogether, also in `ATTENTION`.

   **What an erase keeps:** fills, order events, daily reports, engine
   decisions and the decisions journal — the Reports page and its picker
   still find the tag. **What it loses:** the registry row's own
   `lastReason`/`lastAction` snapshot (the per-decision reasons survive in the
   journal) and the `desk-books` document.

   The server keeps its own guard on the DELETE: it rebuilds the position
   from the **fills** and refuses with a 409 when they say the tag still
   holds something, whatever `desk-books` says. That shows in the run's
   `ATTENTION` block as `DELETE refused`; the row stays stopped and
   registered, the other erases still go out, and the run exits 1. Check the
   tag with `GET /v1/desk/positions?tag=<tag>&mode=paper`, flatten or reconcile
   by hand, and delete it from the Books page once it reads clean.
8. **Then every OTHER paper book past its expiry** — the fourth loop, after all
   of the delta-lean work above. Any paper registry row that is *not*
   delta-lean (a monthly stock book, say) whose `expiry` is **before today**
   is retired by the same rule: settle its expired legs, stop it if running,
   erase it if flat. A leg on a live contract alarms and the book is left
   alone; a book whose legs cannot be read is left alone. The row's `expiry`
   is the clock here, because a monthly book is done when its contract is: a
   contract that expired on any earlier session, yesterday included, is
   retired the next morning; one expiring **today** is still trading and is
   left alone — the September stock books (expiry 09-29) are the first rows
   it takes. A row
   whose variant and dial disagree is an anomaly and is never in this loop.
9. **Non-trading days are a no-op**, exit 0, before it even opens Mongo:
   weekends and the NSE holidays in `packages/desk-engine/src/session.ts`
   (2026 only — §5.3). The cron line is weekdays-only but a holiday weekday
   still fires it; nothing is created for a session that will not happen, and
   nothing is retired either.

It is paper-only on the same terms as its sibling (§2.3), with `mode` imported
from that script rather than restated: an unrecognised flag is a hard error, a
live row in the registry read is a throw, every start and stop sends the
literal `{"mode":"paper"}`, and every DELETE the literal `?mode=paper`.

It is safe to run at any moment and safe to run twice. A create that describes
the row on file converges on 200 without touching dials you have patched, a
start on a running book is a no-op, the switch PATCH is idempotent, and a
second run a second after the first issues **no calls at all**.

> **It will not re-start a book you stopped by hand** unless it needs that book
> running in order to retire an old one — the one case where leaving it stopped
> would mean no book at all for that symbol today. "Needs" means a retire that
> is actually going to happen: an old book that is still holding, or whose legs
> cannot be read, is left running whatever today's books do, so it is no reason
> to reverse your stop. With nothing to retire, a stopped book on today's tag is
> your decision and the roll leaves it alone (and leaves its switch alone) and
> says so.
>
> **A hold pair (§7.7) or a playbook book (§8) you stopped by hand is never
> re-started at all** — not by the 08:50 run, not by a re-run an hour after
> you stopped it. The one stopped book of those families the roll starts is
> one that was registered this morning and that **no start has ever
> reached**: a run that died between its create and its start, read off the
> row itself (§7.7). A book you stopped was started first, and its row says
> so.

> **A guard-tripped daily book simply ends with its day.** If the desk's day
> guard fires on a book at 13:00, that book is switched off until 15:00 like
> before — and tomorrow's book is a new row with a freshly armed guard and its
> switch on. Nothing needs re-arming by hand any more.

> **One cosmetic supervisor line after a stop + erase.** When a running row is
> stopped and erased in the same run, the supervisor's next convergence pass
> still reports `actual: stopped` for it and gets a 404 from the registry.
> Expected; it says so once and moves on.

### 7.2 The cron line — install it yourself

The box's clock is **UTC** and the market is **IST (UTC+5:30)**, so 08:50 IST is
`08:50 − 05:30 =` **03:20 UTC**, the same calendar day and the same weekday
(subtracting 5½ hours from 08:50 never crosses midnight, so `1-5` in UTC is
Monday–Friday in IST). Verified on this box rather than assumed:

```sh
$ TZ=Asia/Kolkata date -d '2026-09-16 03:20 UTC'
Wed Sep 16 08:50:00 IST 2026
$ date -u -d 'TZ="Asia/Kolkata" 2026-09-16 08:50'
Wed Sep 16 03:20:00 UTC 2026
```

(Note that `TZ=Asia/Kolkata date -u -d '... 08:50'` does **not** work: `-u`
overrides `TZ` for parsing as well as for printing, and silently reads the input
as UTC.)

08:50 IST is chosen because it is **after the previous day's 15:00 flatten**
(D4, §3.3), **after desk-marketdata's 08:45 instrument sync is due** and
**before the 09:15 warm-up**, so today's books are on the desk before their
first mark and nothing can be in flight while the roll reads what yesterday's
book holds. The sync matters because the roll reads the whole instrument master
to plan today's expiries: the sync is a per-row diff, never a drop-and-reload,
but a read in the same minute can overlap a half-applied diff, and a symbol
with no expiry on or after today makes the run exit 1 having created and
retired nothing — safe, but a missed morning. Five minutes later the diff is
done. The book being stopped at 08:50 traded its last session
yesterday and flattened at 15:00 — it has been flat for about **17 hours**, with
a whole overnight between its last fill and the stop. "Retire only if flat" is
the rule that protects the position; this slot is what makes that rule nearly
always a formality rather than a coin toss.

Add this to `crontab -e`, below the two entries already there:

```cron
# delta-lean daily book roll: create+start+switch on today's four and any new hold-to-expiry
# pair, then stop and erase yesterday's flat daily books and anything older, and retire hold
# books past their expiry (03:20 UTC = 08:50 IST, after yesterday's 15:00 flatten and after
# desk-marketdata's 08:45 instrument sync, before the 09:15 warm-up)
20 3 * * 1-5 /usr/bin/node /opt/algomaker-delta/scripts/delta-lean-roll.mjs --apply >> /opt/algomaker-delta/logs/delta-lean-roll.log 2>&1
```

No `cd` is needed: the script loads `.env.local` by absolute path, so
`DESK_API_TOKEN`, `DESK_API_URL` and `DESK_MONGO_URL` are found wherever cron
starts it.

### 7.3 Did it run, and what did it decide

```sh
tail -60 /opt/algomaker-delta/logs/delta-lean-roll.log
```

A holiday ends in one line: `… is not a trading day (weekend or NSE holiday) —
nothing to do.` A morning where everything is already in place ends in
`NOTHING TO DO. Today's books are on the desk and nothing is left to retire; no
calls were made.` An ordinary morning prints a `created`/`started`/`switched on`
line per new book, then a `stopped` line and an `erased` line for each of
yesterday's books (four of each on a normal day), then:

```
N registered, N started, N switched on, N stopped, N erased. All paper.
```

**The script exits 1 whenever it found something it did not expect**, and prints
an `ATTENTION` block saying what — a book it would not touch, a row it could not
classify, an erase the server refused, or a playbook loop it could not finish
(§8.1). Cron itself is silent, so the log is the alarm:

```sh
grep -n "ATTENTION" /opt/algomaker-delta/logs/delta-lean-roll.log | tail
```

Then confirm from the registry rather than from the log:

```sh
mongosh algomaker --quiet --eval '
  db["desk-books-registry"].find({variant:/^delta-lean-/},
    {tag:1,expiry:1,desired:1,mode:1,createdAt:1,_id:0}).toArray()
    .map(r => ({...r, day: new Date(r.createdAt + 19800000).toISOString().slice(0,10)}))'
```

After an ordinary morning the answer is **exactly today's four**, every one
`desired: "running"` with `day` **today**, plus the hold-to-expiry pairs
(`variant: "delta-lean-hold-…"`, §7.7) — up to two per symbol, whose `day` is
the morning each was created and whose `expiry` is today or later — and
nothing else. A running daily row (`variant` without `hold`) from an earlier
day, or a hold row whose `expiry` is before today, means the roll did not
run — check the crontab and the log's timestamps. A `desired: "stopped"` row the morning after is **not the norm any
more**: it is a book the roll could not finish, and the same run's `ATTENTION`
block says why — a `DELETE refused` (the server's fills guard, §7.1 step 7),
a settle refused (§7.5), an unreadable `createdAt`, or a retire withheld
because today's books on that symbol were not all running. (The one quiet
exception is a delta-lean row registered by hand **today** under some other
tag: stopped, not erased, until tomorrow's run.) And the switches:

```sh
mongosh algomaker --quiet --eval '
  db["desk-strategies"].find({tag:/delta-lean/},{tag:1,modes:1,dailyLimits:1,_id:0}).toArray()'
```

Every running book's row should show `modes.paper.enabled: true` and
`dailyLimits.stop` of 100000 (aggressive) or 15000 (conservative).

### 7.4 "…HOLDS n open leg(s) — NOT STOPPED"

This is the line to act on. It means a book from an earlier day was still
holding a position at 08:50, so the roll **did not stop it** and left it running
(and will not erase it either).

That is deliberate, and it is the one rule in this script worth knowing by
heart: **a stop does not flatten** (§4), and a stopped book is no longer steered
— so it will not flatten itself at 14:50 either. Stopping a book that holds
something abandons a position with nothing watching it. Leaving it running costs
a day; stopping it costs the position.

**This line should never appear.** A retired book's day ended at least one
session ago, so it flattened at 15:00 and has been flat overnight. Seeing it
means that flatten did not complete. It needs you.

What to do:

1. **Treat it as a failed 15:00 flatten first.** That is a §3.3 finding in its
   own right and the more important half of this message. Capture the book's
   `actions` and the supervisor log for the 14:50–15:00 window of **its day**
   *before* anything resets it — that is where the residual should have gone to
   the blind ladder and did not.
2. **Deal with the legs by hand.** Close them from the dashboard if there is
   still anything to close them against. You only see this line for a book
   with at least one leg on a LIVE contract — legs that are all on expired
   contracts are settled by the roll itself (§7.5); a book with both kinds
   needs the live ones closed, after which the next run settles the rest.
3. **Then let the roll finish the job.** Once the book reads flat, the next
   morning's run stops and erases it in one go, with no further action.
   Or stop it by hand (§4) — but only once it is flat.
4. **Never "fix" it by stopping the book first.** The line exists precisely
   because that is the tempting thing to do, and it converts a visible problem
   into an invisible one.

Three neighbouring lines mean something slightly different:

- **"…CANNOT TELL whether it is flat"** — the book's `desk-books` document is
  missing its leg array or carries a leg with no usable `qty`. Unknown is never
  read as flat, so it is neither stopped nor erased. Look at the document by
  hand.
- **"…is ALREADY STOPPED, and still HOLDS n open leg(s)"** — a stranded
  position: nothing is steering that book, so nothing will flatten it. The roll
  will not start it again to do so, and will not erase it. Flatten it from the
  dashboard yourself.
- **"…DELETE refused (HTTP 409)"** — the server's fills guard disagreed with
  `desk-books` about the tag being flat. The row is stopped and still
  registered; see §7.1 step 7.
- **"…settle-expired refused (HTTP 409)"** — the book holds only legs on
  expired contracts, but the server would not settle them: no close on file
  for the expiry date (supply `{"close": …}`), the fills ledger disagrees with
  `desk-books` on the contract, or an order is still out on it (§7.5). Nothing
  was settled; the book is left exactly as it was.
- **"…settle-expired refused (HTTP 404)"** (or any other status) — usually a
  desk-api not yet restarted onto the build that has the route. Per book, not
  an abort: the other books were still retired. Restart desk-api (operator)
  and the next run settles it.

### 7.5 Settling a leg whose contract has expired

A paper book that misses its flatten keeps an expired leg forever: no
simulator fills an order on a contract that no longer trades, the engine keeps
emitting "past the flat-by — closing all 1 leg(s)", and the roll will not
retire a holder. `settle-expired` records what the exchange already did:

```sh
curl -sS -X POST -H "authorization: Bearer $DESK_API_TOKEN" \
  "http://127.0.0.1:8790/v1/desk/books/registry/<tag>/settle-expired?mode=paper"

# when it answers 409 "no close …": state the underlying's close yourself
curl -sS -X POST -H "authorization: Bearer $DESK_API_TOKEN" \
  -H 'content-type: application/json' -d '{"close": 71909.7}' \
  "http://127.0.0.1:8790/v1/desk/books/registry/<tag>/settle-expired?mode=paper"
```

- **Only legs whose contract expired before today** (IST). A contract expiring
  today still trades; a leg on a live contract is never touched and still
  blocks the erase.
- **Price = intrinsic value** against the underlying's close **on the expiry
  date**: CE `max(0, close − strike)`, PE `max(0, strike − close)`, rounded to
  the contract's tick. Every close must carry its own timestamp **at or after
  15:29 IST on the expiry date** — a 13:00 tick before marketdata died is not a
  close. Where it comes from (`closeSource` in the response):
  - `operator` — the body's `{"close": …}`, used as given and recorded as
    yours in the decision and the audit entry. One close per call: a book with
    legs on two expiry dates is a 400.
  - `payoff-spot` — the cash spot on a payoff-cockpit snapshot of that
    underlying, if anyone had the cockpit open after 15:29 that day.
  - `desk-marks` — the spot token's last price, only while that row is still
    stamped in the window. It is one row per token and is re-stamped on every
    marketdata restart, so for a past expiry it rarely answers.
  - `future-mid` — **stocks only**: the book's own last mark of the day, whose
    `spot` is the FUTURE's mid. On expiry day that has nearly converged, so it
    is accepted and labelled an approximation. **Never for an index**: on
    2026-10-01 the SENSEX book-mark read 72,487.75 against an index close of
    ~71,909.7.
- **No close → 409** naming the leg and the `{"close": …}` body that would
  settle it. **Nothing is written.** A settlement price is never guessed.
- **The fills ledger must agree** with `desk-books` about each contract being
  settled (the flatten and the DELETE guard size from the fills). A mismatch on
  that contract, or a fill read that is unreadable or capped, is a 409 — fix
  the record first. A mismatch on a *different* contract does not block the
  settle; the erase will still refuse on it afterwards.
- **No order may still be out** on the contract. Each non-terminal gateway
  order gets a cancel filed through the broker-cancel queue and the call
  answers 409 (`cancelRequested`) until they are terminal — otherwise a late
  fill could close the leg a second time. Retry once the gateway has done it.
- **Booked on the expiry date**: one `desk-decisions` document per contract
  (`source: 'settle'`, `desk_op: 'settle'`, status DONE, a closing fill at the
  intrinsic price) with `createdAt` and the fill's `ts` at **15:30 IST on the
  expiry date** (`writtenAt` is when it was recorded). The book's own
  `desk-daily-reports` row for the expiry date is then rewritten, so that day
  shows the close and `closingPositions: 0`, and the settlement day does not
  count it again. Realised P&L and the DELETE guard see it; the leg is folded
  out of `desk-books`; an audit entry records price and source.
- **The 30-day lookback.** That rewrite reads the fills of the
  `DESK_PNL_LOOKBACK_DAYS` (default 30) days before the expiry date. A leg
  opened earlier than that shows, in that report, as a close with no open —
  its realised figure for the day is wrong. Live P&L has the same window
  counted back from today. Settle within a month of the open, or read that
  day's figure with this in mind.
- **Offsetting legs** on one contract (+x and −y): the NET is settled and the
  response says so (`note`); the legs that net to zero stay in `desk-books`.
- **Idempotent**: a second call settles nothing and answers `settled: []`.
- **Paper only**: a live row is a 400 — settlement there is the broker's.

The roll calls it by itself (§7.1 steps 5 and 8, the hold books' retire in §7.7
and the playbook books' in §8.1). Call it by hand when a book
must be cleared before the next run, then stop and erase it as usual (§4, no
`purge`).

### 7.6 Orphan strategy rows — `--prune-orphans`

An erase takes the book's switch row (`desk-strategies`, `kind: external`)
with it, but erases before that change did not, and a book purged by hand can
still leave one. They show up in the Strategies page's `?all=1` picker as
strategies that could be added.

**Until 2026-10-30 desk-api's boot made them too, switched ON.** A migration
from the per-tag gate's introduction registered every tag in the last 50
decisions of each symbol's books that had no switch row — which by then meant
the books the roll had just erased. Every restart brought them back (24 on 30
Oct, all of them the boot's: each logged `registered an already-trading tag
as SWITCHED ON`). That seed is gone from `apps/api/src/main.ts`; a removed row
now stays removed across a restart. The rows it already made are cleared once
with the prune below, **after desk-api is running the build without the
seed** — a restart of an older build in between would put them back. After
that restart the log line must not appear again:

```sh
grep 'registered an already-trading tag' logs/desk-api-out.log   # nothing stamped after the restart
```

```sh
node scripts/delta-lean-roll.mjs --prune-orphans          # dry run: the list
node scripts/delta-lean-roll.mjs --prune-orphans --apply  # remove them
```

An orphan is an **external** row with **no registry row on either rail** — the
tag text is never read. A hosted row (runner strategy, mirror) is never
touched, and a row with a live membership is listed under SKIPPED and left
alone. `--apply` removes each one's paper switch (`DELETE
/v1/desk/strategies/:tag/modes/paper`) and then the emptied row (`DELETE
/v1/desk/strategies/:tag`, which the server allows only for an external row
added to nothing with no book on either rail). Not gated on a trading day.

### 7.7 The hold-to-expiry books

A weekly sibling of the four (spec
`docs/superpowers/specs/2026-10-05-delta-lean-hold-to-expiry-design.md`): per
symbol, the aggressive and the conservative column with **one** dial more,
`dl_hold_to_expiry: true`, held from the first trading day of a weekly
contract to that contract's expiry — or out earlier on the book target,
backstop or stuck rule. Variants `delta-lean-hold-aggressive` /
`delta-lean-hold-conservative`; the tag names the **contract**, not the day —
`NIFTY-delta-lean-hold-aggressive-2026-10-13` — and the series is
`NIFTY-delta-lean-hold-aggressive`, so the Reports page groups the weeks. The
dials are the intraday column's resolved dials plus that one dial (the
registration suite pins it). So the backstop is the intraday column's number,
read against the book's whole life: ₹30,000 aggressive, ₹15,000 conservative
since R1 (2026-10-05), with the desk guard armed at 45,000 / 23,000. A hold
pair registered **before** the R1 merge is not re-created each morning, so it
keeps the 200,000 its row was resolved with (and the 300,000 guard) until its
contract expires — patch it if it should run under R1:
`PATCH /v1/desk/books/registry/<tag>` with
`{"mode":"paper","dials":{"dl_day_max_loss":30000}}` (15000 for the
conservative one), which re-arms the guard with it. Membership is the dial, cross-checked against the
variant: a row where the two disagree is named in `ATTENTION` and left alone
by every loop.

**The backstop and the target wait 60 seconds** (`dl_rupee_hold_s`, since
2026-10-30). A hold book fires either only on a reading that has stood
`dl_rupee_hold_s` (60) without a break; a pass back inside both lines resets
the clock (`dlRupeeSinceMs` on the state row), and so does the day roll.
Why: the carried legs' first marks at 09:15 mix two sessions. Legs that have
already printed show today's prices, at wide opening spreads. Legs that have
not show the last session's book. On 19 Oct that read **−₹16,289**
against NIFTY hold-conservative's −₹15,000 floor at 09:15:00.7 and stopped the
book until expiry. The close it sent banked **+₹7,797**, seven of the nine
legs filling within three seconds. On 22 Oct the successor read **+₹14,853**
past the ₹10,000 target at 09:15:02.3 and banked. The desk's own mark a second
later was +₹8,645, and the fills made +₹9,123. The same blend fired the
09:15 exits of 9 Oct (NIFTY hold-conservative, target at +₹12,057, banked
+₹1,076) and 14 Oct (SENSEX hold-aggressive, backstop at −₹30,427, banked
−₹901). Every opening swing on file was gone by the desk's next 15-second P&L
mark, at most 18 seconds after 09:15. Once a line fires it latches exactly as
before. A **flat** hold book acts at once. The intraday books and the
playbooks never read the dial: they are flat overnight, so their first mark
is never stale, and they still fire on it.

- **What it costs.** A real breach of the floor on a hold book is acted on
  up to a minute late. Plan the worst case as the floor plus a minute's move.
  The desk guard behind it (1.5 x) is unchanged.
- **The rows on file need no patch.** The four hold rows registered before
  the dial resolve it to 60 off the engine default, and new rows carry 60.
  To put a book back on the first mark, patch it as above with
  `{"mode":"paper","dials":{"dl_rupee_hold_s":0}}`. Nothing changes until
  desk-supervisor is restarted onto this build (the operator's step).
- **Seeing it.** A book whose reading is through a line but not yet held
  shows its ordinary reason. Its state row shows a non-zero
  `dlRupeeSinceMs`. When the line fires, the reason says `held 60s`, e.g.
  `book backstop: Rs-16,289 through the Rs-15,000 floor, held 60s — …`.

**What is created, when.** Every morning the roll asks the master for each
symbol's front contract (the same `expiriesFrom` answer the four use). If that
contract does **not** expire today and its pair is not on the desk, the pair
is created, started and switched on — the same three calls as the four, right
after them, and before any stop. On a symbol's **expiry morning** no pair is
created for the dying contract; the next contract's pair comes the morning
after. A pair already running is left alone (no calls). A pair on the current
contract that is **stopped**:

- registered **this morning**, flat, and **never started** — a run that died
  between its create and its start — is started and switched on by the next
  run (the create converges on 200). "Never started" is read off the row
  itself: nothing has written to it since its create, so its `updatedAt`
  still equals its `createdAt` (every start, stop, supervisor report and
  dials edit moves it), the supervisor reports it `actual: stopped` and it
  has no `lastMarkAt`;
- otherwise it is your decision — including a pair you stopped by hand five
  minutes after the 08:50 run started it: the roll does not start it, lists
  it as `left stopped`, and names it in `ATTENTION` (exit 1) every morning
  until it runs or is erased — a week-long book off the desk is never silent;
- stopped and **not flat** (or unreadable) — on its tag, or carrying to its
  expiry — is an **alarm**: a position nothing steers, possibly for days.
  Flatten it from the dashboard, or start it from the Books page.

A missed morning is not lost — the next run creates the pair with fewer days
left.

**The engine gate.** The roll creates no hold pair unless the engine **in this
checkout** knows `dl_hold_to_expiry` (the dial resolves without being
refused). If it does not, the run prints `hold pairs not created: this engine
build does not know dl_hold_to_expiry — restart desk-supervisor onto the build
that does …` in `ATTENTION` and exits 1; today's four still roll and hold rows
already on file still retire by expiry.

**What retires, when.** Never by its creation day: the daily retire (§7.1
steps 6–7) never sees a hold row. A hold book is retired the morning **after
its contract expires** (`expiry` before today), by the fourth loop's rule
(§7.1 step 8), in its own pass between the daily books' and the fourth loop's:
flat → stopped if running, then erased; every open leg on the dead contract →
settled (§7.5), then erased; a leg on a live contract, or a book whose legs
cannot be read → `ATTENTION`, untouched. On its own expiry day the pair is
`carrying` — it flattens on the engine's 14:50/14:55/15:00 ladder that day
only, and the roll leaves it alone until tomorrow.

**The first week is short.**

| morning | front contracts | the roll's hold half |
|---|---|---|
| Tue 10-06 | NIFTY 10-06 (today), SENSEX 10-08 | **SENSEX 10-08 pair created**; no NIFTY pair (its contract dies today) |
| Wed 10-07 | NIFTY 10-13, SENSEX 10-08 | **NIFTY 10-13 pair created**; SENSEX pair on target |
| Thu 10-08 | NIFTY 10-13, SENSEX 10-08 (today) | nothing created; SENSEX 10-08 pair carrying to its close |
| Fri 10-09 | NIFTY 10-13, SENSEX 10-15 | SENSEX 10-08 pair **retired**; SENSEX 10-15 pair created |
| Tue 10-13 | NIFTY 10-13 (today), SENSEX 10-15 | nothing created; NIFTY 10-13 pair carrying |
| Wed 10-14 | NIFTY 10-19, SENSEX 10-15 | NIFTY 10-13 pair retired; **NIFTY 10-19 pair created** (Tue 10-20 is Dussehra, `session.ts`, so that week's NIFTY contract expires Monday the 19th) |
| Mon 10-19 | NIFTY 10-19 (today), SENSEX 10-22 | nothing created for NIFTY; NIFTY 10-19 pair carrying |
| Tue 10-20 | — | Dussehra: no run |
| Wed 10-21 | NIFTY 10-27, SENSEX 10-22 | NIFTY 10-19 pair retired; the next NIFTY pair created |

From then on: two hold books per symbol on the desk at all times, except
between an expiry's close and the next morning's run. (The dates are read off
the dump each morning, never computed; the table is what the 2026 calendar
gives.)

**What it needs to go live.** The two halves ship separately:

- **The roll needs no restart.** It is a cron script read fresh from disk
  each morning; the first 08:50 run after the merge — on a checkout whose
  engine knows `dl_hold_to_expiry`, see the gate above — creates the pairs.
- **But desk-supervisor must already be on the engine build before 09:15 of
  the first morning a hold pair exists** (operator restart). The gate checks
  the engine *on disk*, not the process that is running: a supervisor still
  on the old build resolves the dial away and steers a hold book as an
  **intraday** book — it opens after warm-up, flattens at 15:00, and re-opens
  the next day under the hold tag. Restart while the books are flat (the same
  rule as any supervisor restart).
- **A hold pair that traded a session under the old supervisor must be
  erased before that restart.** It opened (and flattened) on its first day;
  the new engine never re-opens a hold book (open-once), so it would sit flat
  and latched for the rest of its contract. Stop and delete it from the Books
  page while it is flat (§4, no `purge`), then re-run the roll: the pair is
  created fresh under the same tag.

Read the plan's `HOLD-TO-EXPIRY BOOKS` block in the dry run, and the
`hold-to-expiry: …` line under the totals (dry run and `--apply` alike), which
names the pairs created and retired that morning.

### 7.8 Conservative opened and held: the roll and the carried pair (30 Oct 2026)

On 30 Oct 2026 the conservative column's `dl_max_adjusts_day` went from 4 to 0,
intraday and hold alike (why, and the comparison it sets up: §9.5). The roll
needs nothing for it:

- **Membership is unchanged.** It reads the variant, `delta_lean_enabled` and
  `dl_hold_to_expiry`, and none of them moved, so every row on file is
  recognised, carried and retired as before. Nothing is erased early, and the
  change raises no `ATTENTION` line.
- **New rows carry the 0.** That covers the daily `NIFTY-delta-lean-conservative`
  from Mon 2 Nov (`SENSEX-delta-lean-conservative` is in `SERIES_OFF`). It also
  covers the next hold-conservative pairs: NIFTY's from Wed 4 Nov, SENSEX's
  from Fri 6 Nov.
- **Rows already registered keep 4.** A running target gets no call, and a
  create that converges never rewrites a row's dials. Two pairs were carried
  into the change: `NIFTY-delta-lean-hold-conservative-2026-11-03` and
  `SENSEX-delta-lean-hold-conservative-2026-11-05`. Monday's roll counts both
  on target and leaves them on 4 until they are patched:

  ```
  PATCH /v1/desk/books/registry/NIFTY-delta-lean-hold-conservative-2026-11-03
  PATCH /v1/desk/books/registry/SENSEX-delta-lean-hold-conservative-2026-11-05
  {"mode":"paper","dials":{"dl_max_adjusts_day":0}}
  ```

  The route allows this on a book that holds legs, because it is not an
  engine switch. Paper asks for no password, the day guard is untouched and
  the supervisor is nudged. No restart is needed.
- **Revert.** Put `dl_max_adjusts_day: 4` back in `DELTA_LEAN_CONSERVATIVE`
  (`packages/desk-engine/src/presets.ts`); the next 08:50 roll registers on it.
  `dl_stuck_loss: 15_000`, the other line of the pair, did not change: it has
  sat on the backstop since R1 and stays there. Patch any row already on 0
  back to 4 with the same request.

## 8. The playbook books

Spec `docs/superpowers/specs/2026-10-16-six-playbooks-design.md` (v2), review
`docs/reports/2026-10-16-desk-review.md`. **Paper only.** Six presets, each a
delta-lean-family book (`delta_lean_enabled: true`) whose `pb_playbook` dial
(1–6) routes it to `decidePlaybook`:

| Preset (variant) | `pb_playbook` | Contract | What it trades |
|---|---:|---|---|
| `pb-trend-drive` | 1 | ≥ 1 trading day (never 0-DTE) | the confirmed opening trend as a debit spread, 09:30–10:15 (§5.1) |
| `pb-wing-straddle` | 2 | ≥ 5 trading days | a 1-lot short ATM straddle with far wings, 09:30–12:30, 25% combined stop (§5.2) |
| `pb-reversal` | 3 | ≥ 1 trading day | the reversal of a failed morning move, debit spread, 10:00–13:30 (§5.3) |
| `pb-expiry-drive` | 4 | today's expiry | the expiry-morning trend, debit spread, out by 12:00 (§5.4) |
| `pb-expiry-theta` | 5 | today's expiry | a calm-afternoon iron fly, 13:00–14:15 (§5.5) |
| `pb-expiry-gamma` | 6 | today's expiry | a long OTM option on an afternoon breakout, ≤ ₹6,000 premium (§5.6) |

### 8.1 Tags, the roll, the first sessions

- Tag `<SYMBOL>-<preset>-<date>` (`NIFTY-pb-trend-drive-2026-10-19`), series
  `<SYMBOL>-<preset>` — one row per day, like the four. The roll (§7) creates
  them as **their own family**: the three intraday presets for both symbols every
  trading day; the three expiry presets only for the symbol whose nearest expiry
  is today, and only from `PLAYBOOK_EXPIRY_FROM` (`scripts/delta-lean-books.mjs`,
  `2026-10-21`). A finished row is retired the morning after: flat → erased;
  every open leg on a contract that has expired — the 0-DTE wing nobody would
  buy at ₹0.05, which expired with the contract — → settled at intrinsic
  (§7.5), then erased, a refused settle leaving it in `ATTENTION`; a leg on a
  live contract → ALARM, untouched.
- **Gate:** no playbook row is planned unless the engine on disk knows
  `pb_playbook` — otherwise ATTENTION and exit 1, while the four and the hold
  pairs still roll.
- **Fence:** the playbook books are created after the four and the hold pairs,
  and a playbook create, start or switch-on that fails costs only this family.
  The log's `ATTENTION` block reads `PLAYBOOK FAMILY NOT FINISHED — <the call
  and its answer>`: the playbook books after that one were not sent, and the
  playbook retire was skipped (yesterday's playbook rows are left exactly as
  they were — still running if they were). The four, the hold pairs and the
  fourth loop rolled as usual. Fix the cause and re-run the roll; the creates
  converge and the skipped retire goes out. `PLAYBOOK RETIRE NOT FINISHED —
  …` is the same fence around a playbook stop or erase that failed: the rest
  of that retire waits for the next run, and the fourth loop still ran.
- **The old-build fail-safe:** every playbook preset carries `dl_open_lots: 0`.
  A supervisor that does not know `pb_playbook` drops it and runs the
  hold-and-adjust engine, which then can never open — the book sits flat.

### 8.2 Restart order for this build

While the intraday books are flat (after 15:00, or before 09:15), restart
**desk-marketdata** (it now publishes the previous close on `md.spot`),
**desk-api and desk-supervisor together** (desk-api writes rule state on Protect
and must know `pb`), and **desk-gateway** (touch fills). Never desk-runner. The
hold pairs carrying legs keep the future-mid forward — their rows predate
`dl_parity_forward` — so the restart does not reprice them.

### 8.3 First-week checks

```js
// 1. Every playbook row: the selector, the parity switch, the paper switch.
db["desk-books-registry"].find({variant:/^pb-/},{tag:1,expiry:1,"dials.pb_playbook":1,"dials.dl_parity_forward":1,"dials.dl_open_lots":1,_id:0})
db["desk-strategies"].find({tag:/-pb-/},{tag:1,modes:1,dailyLimits:1,_id:0})

// 2. The forward is the chain's own: source parity, within 0.2% of the index.
db["desk-book-marks"].find({tag:/-pb-|delta-lean/},{tag:1,ts:1,spot:1,forwardSource:1,_id:0}).sort({ts:-1}).limit(20)

// 3. Every stage-1 open is followed by its stage 2 or an abort within 300 s.
db["desk-engine-decisions"].find({tag:/-pb-/, trigger:{$in:["dl-open","dl-exit"]}},{tag:1,trigger:1,reason:1,ts:1,_id:0}).sort({ts:1})

// 4. Coverage: no option type ever short more lots than it is long.
db["desk-books"].find({tag:/-pb-/},{tag:1,legs:1,_id:0})

// 5. The Wing Straddle finds a fly: five-minute marks that waited on the board,
//    per book and day. A SENSEX row that waits here all morning is a wing
//    failing the spread bar (pb_wing_spread_abs, ₹2) — widen that, not the
//    sale's dl_max_spread_abs.
db["desk-book-marks"].aggregate([{$match:{tag:/-pb-wing-straddle-/, reason:/no fly on this board/}},{$group:{_id:{tag:"$tag",day:"$dateIst"},marks:{$sum:1}}},{$sort:{"_id.day":1}}])
```

A stage-1 package names its legs in the reason ("stage 1 — buying …"), stage 2
names the sales; an abort is a `dl-exit` whose reason starts `stage-2 abort`.

### 8.4 Switches

- **`DESK_CHAIN_FORWARD=future`** in the supervisor's environment (read at boot)
  puts every book back on the future-mid forward **except the hold-to-expiry
  pairs**: they carry legs across the restart that sets or clears the switch,
  and moving them between the weekly's parity and the near-month future (300-odd
  points apart on SENSEX) would re-read every delta and trade on it. A hold pair
  keeps the forward its own row names until it expires. The playbooks then take
  **no new risk** (their gate needs a parity or index-carry forward); their exits
  still run.
- **To switch one preset off:** stop its rows on the Books page, and remove the
  key from `PLAYBOOK_PRESET_KEYS` in `scripts/delta-lean-books.mjs` before the
  next 08:50 roll. From that run the preset is no longer created, and the rows
  it left are still retired the morning after their day like any playbook row
  (flat → erased; holding → ALARM): the roll knows a playbook row by its dials
  (`delta_lean_enabled: true`, `pb_playbook` ≥ 1), not by that list.
- **To switch one preset off on one symbol:** add its series
  (`<SYMBOL>-<preset>`, e.g. `SENSEX-pb-reversal`) to `SERIES_OFF` in the same
  file. From the next 08:50 roll the series is planned and not created; the
  log's summary carries a `switched off (SERIES_OFF): …` line (not
  `ATTENTION` — the run still exits 0). Its rows on file retire the morning
  after their day like any playbook row, because the roll never reads that list
  to decide what a row is. A playbook row of today is never touched, so
  today's row of the series runs to its close unless you stop it (§4). Delete
  the line to turn the series back on.
- **30 Oct 2026 — switched off.** The review of the paper record since 19 Oct
  (the last fill-model change) found these losing, and they went into
  `SERIES_OFF`: Trend Drive on both symbols (NIFTY −4,914, SENSEX −9,448, no
  winning day in nine), Wing Straddle on both (−5,457, −3,584), SENSEX
  Reversal (−6,712), and the three expiry presets on both symbols (every
  recorded day a loss). NIFTY Reversal (+3,562) is the one playbook still
  created. Two daily books went off in the same change (§9.4).
- **To start the expiry presets earlier or later:** move `PLAYBOOK_EXPIRY_FROM`.
- **A retune that switches engines** (`delta_lean_enabled` or `pb_playbook`), or
  the forward a book is priced on (`dl_parity_forward`), on a book that holds
  legs — or that has a decision still working, such as a stage-1 wing resting
  before its fill — is refused with 409. Flatten first, or wait for the
  package to finish.

## 9. The zero books

Spec `docs/superpowers/specs/2026-10-17-delta-lean-zero-design.md`. **Paper
only.** Two more presets in the daily family, beside aggressive and
conservative, on NIFTY and SENSEX:

| Preset (variant) | When it is on the desk | What it trades |
|---|---|---|
| `delta-lean-zero` | every trading day | the conservative book on trial #2615's dials: opens only 09:29–09:31; a confirmed trend opens the debit spread, a confirmed quiet the condor, and at 09:31 nothing confirmed opens the condor anyway (never on `unknown`); shorts \|Δ\| ≤ 0.24, wings ≤ 0.03; no adjustments, no target, backstop ₹20,000, flatten 14:30 / 14:35 / 14:40 |
| `delta-lean-zero-0dte` | only on the morning its symbol's contract expires (NIFTY Tuesday, SENSEX Thursday) | the same dials, opening only on a confirmed trend-down: the put debit spread. No condor, no call spread |

So the roll creates **six daily books** on an ordinary morning and **seven** on
a symbol's expiry morning. "The four" elsewhere in this runbook and in the two
scripts is this family. The 0-DTE book is planned by its dial
(`dl_expiry_day_only`), not by its name, and the engine refuses to open it on
any other day as well.

### 9.1 What to expect

- The two day guards arm at **₹30,000** (1.5 × the ₹20,000 backstop).
- Orders: 2 (a spread) or 4 (the condor) at the open, one per leg at 14:30.
  There are no adjustments, so nothing in between.
- The zero book's journal at 09:31 on a chop morning reads `chop at 09:31, the
  open window's last minute — the quiet package anyway: opening none, 4
  leg(s) …`. After 09:31 a book that did not open reads `… is past the 09:31
  open window — no package today`.
- The 0-DTE book on a non-expiry day (a hand-registered row) reads `… is not
  this book's expiry day (…)` all day and places nothing.
- On a build that does not know the open dials (the roll ran before the
  restart), a zero row latches `dl-target` on its first pass, at ₹0, and places
  nothing (spec D9). That is the fail-safe, not a fault. Restart onto the build,
  and the next morning's row trades.

### 9.2 Restart order for this build

The same as §8.2: while the intraday books are flat, restart **desk-api** and
**desk-supervisor** together, never desk-runner. The dashboard change is live
on build (Caddy serves `apps/web/dist`).

### 9.3 First-week checks

```js
// 1. The rows and their switches — not just the rows (a purged book comes back switched off).
db["desk-books-registry"].find({variant:/^delta-lean-zero/},{tag:1,expiry:1,"dials.dl_open_by_min":1,"dials.dl_expiry_day_only":1,"dials.dl_day_target":1,_id:0})
db["desk-strategies"].find({tag:/delta-lean-zero/},{tag:1,modes:1,dailyLimits:1,_id:0})

// 2. What each book opened on, and when: a fallback names itself in the reason.
db["desk-engine-decisions"].find({tag:/delta-lean-zero/, trigger:"dl-open"},{tag:1,reason:1,ts:1,_id:0}).sort({ts:-1})

// 3. A SENSEX condor that never forms: the 0.03 wing failing the liquidity row rule.
db["desk-engine-decisions"].find({tag:/SENSEX-delta-lean-zero-20/, reason:/bands are not on this chain/},{tag:1,reason:1,ts:1,_id:0})
```

After a week, compare entry fills with the replay's model (the opening mid ±
max(₹0.10, 0.25%)). The replay's edge is smaller than its slippage band (spec
§2), so the fill quality is what the paper run is measuring.

### 9.4 Switches

- **To stop creating one of them:** remove its key from `PRESET_KEYS` in
  `scripts/delta-lean-books.mjs` before the next 08:50 roll. Rows it already
  made are retired the morning after, like any daily row.
- **To stop creating one of them on one symbol:** add its series
  (`SENSEX-delta-lean-zero`) to `SERIES_OFF` in the same file — the per-symbol
  switch of §8.4, for any daily preset. Keep at least one daily book on each
  symbol: a symbol with none has its retire withheld, and its old rows ALARM
  every morning. A hand re-run of the roll on the day of the change stops
  today's row of a switched-off daily series if it is flat (it is no longer one
  of today's books) and alarms if it holds; the 08:50 run has no such row.
- **30 Oct 2026 — switched off:** `SENSEX-delta-lean-conservative` (−9,153
  since 19 Oct, −18,622 since 22 Sep) and `SENSEX-delta-lean-zero` (−6,060 in
  seven days). SENSEX keeps aggressive and the 0-DTE zero book; NIFTY keeps all
  four.
- **To let the zero book adjust, or give it a target:** do NOT edit
  `dl_day_target` on the preset without reading spec D9. The ₹0 target is what
  keeps a row inert on an old build.

### 9.5 The conservative books, opened and held (30 Oct 2026)

**What was switched off.** The conservative column runs with
`dl_max_adjusts_day: 0` since 30 Oct 2026. That covers the daily
`NIFTY-delta-lean-conservative` and both `delta-lean-hold-conservative` series.
`SENSEX-delta-lean-conservative` is not created (`SERIES_OFF`, §9.4). The open
is unchanged: 2 lots, the same regimes, a 120s confirm. Every later adjustment
the posture wants is refused, and the journal reads `… — all 0 adjustments are
spent — but Rs-N is inside the Rs-15,000 stuck floor …`. The book leaves only on
the ₹10,000 target, the ₹15,000 backstop or the clock. On a hold book the
target and backstop count the book's life and wait 60s, and the clock is the
expiry-day ladder.

**Why.** The 30 Oct review found that the neutralising adjustments lost money
on balance in all four daily books: the opening legs alone beat the managed
book. The add-flag fix merged the same day (`fdf80398`) lets through the
same-strike adds `book.ts` used to refuse (352 since 25 Sep), so adjusting
books will adjust more from now on.

**The comparison.** Conservative held against aggressive adjusting. Aggressive
and hold-aggressive are unchanged at 6 adjustments a day. Zero and 0-DTE are
unchanged too: they already had 0 and state both dials themselves. The two
columns also differ in lots, confirm, cooldown and backstop, so compare them
per lot or against each book's own open, not on raw rupees.

**The stuck exit cannot fire on these books.** With no adjustment allowed,
every wanted one is blocked and the §6.4 clock runs on a losing tick. The stuck
floor sits on the backstop (15,000 each, since R1), so the backstop takes the
book first. On an intraday book it fires on the same tick; on a hold book its
60s hold is shorter than the 300s stuck window. A `dl-stuck` row on a
conservative book is a fault to report.

**The two pairs carried into the change** stay on 4 until patched: §7.8.

**Revert.** Put `dl_max_adjusts_day: 4` back in `DELTA_LEAN_CONSERVATIVE`
(`packages/desk-engine/src/presets.ts`). The next 08:50 roll registers on it,
and no restart is needed. Leave `dl_stuck_loss: 15_000` where it is: it did not
move on 30 Oct.

